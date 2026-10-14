#!/usr/bin/env python3
"""Q26 workstream B-gradient data acquisition: aToken event logs, the reconstruction gate, the
extended universe and anchors for its new addresses (Aave V3 Ethereum, USDC and USDT).

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG_B2.md` sections G.1-G.2 (registered at
membrane-board commit 5e45406). It reads chain data and compares balance changes. It computes no
outcome: no gradient labels, no exit counts, no withdrawal rates.

Phases, each resumable from the work directory:
  preflight   pin the asof block (the 'finalized' block at start, by number), find each aToken's
              deployment block (eth_getCode bisection), check topic0 = keccak256(signature), read
              index / supply references at the two asof blocks
  logs        eth_getLogs for every log of each aToken, deployment -> asof, ranges <= 50,000 blocks,
              split in half on error down to 1,000 blocks, <= 2 req/s; one checkpoint per sub-range
  timestamps  block timestamps of every block with a log (carried by the node in each log), checked
              per block and against eth_getBlockByNumber for a seeded sample; missing ones fetched
  decode      Mint / Burn / BalanceTransfer / Transfer decode, counts, unknown topic0
  gate        validation gate against the frozen daily anchors of P_r (depositor-balances); the verdict
              uses deviation D2 (tolerance base max(anchor_d, anchor_d+1, intraday peak)), the registered
              G.2 rule is reported beside it
  universe    extended universe (event-reconstructed balance >= $1,000,000 at any time); only after
              the gate passed
  anchors     daily 00:00Z balanceOf for every new address (B.1 method)
  gate_new    the gate on the new anchors
  write       output files, gate-report.json, run-log.json, PROVENANCE.md

Holdout mode (deviation D1): select (mechanical holdout list at the same asof), logs, timestamps,
decode, universe, anchors, rstate (daily reserve state), gate_new, write.

Usage:
  python3 g_acquire_events.py --work-dir DIR [--out-dir DIR] [--phases all|p1,p2,...]
  python3 g_acquire_events.py --mode holdout --work-dir DIR2 --main-work-dir DIR [--phases ...]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import http.client
import io
import json
import os
import random
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import b_acquire as B  # noqa: E402  (RPC client, multicall, keccak, checkpoint store)

# ---------------------------------------------------------------------------------------------
# Fixed by the preregistration (G.1, G.2)
# ---------------------------------------------------------------------------------------------

PREREG = {
    "repo": "membrane-board",
    "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B2.md",
    "sections": "G.1-G.2",
    "commit": "5e45406",
    "sha256": "821343da743bd91138d055321418961f8b2342b00cbd492f3a71b9b31c7ad020",
}

LOGS_RPC_URL = "https://rpc.mevblocker.io"   # eth_getLogs (G.1 source A)
STATE_RPC_URL = B.RPC_URL                    # https://eth.drpc.org: eth_getCode, eth_call, blocks
USER_AGENT = B.USER_AGENT

RESERVES = B.RESERVES
RESERVE_ORDER = B.RESERVE_ORDER
POOL = B.POOL

RANGE_MAX = 50_000          # blocks per eth_getLogs range
RANGE_MIN = 1_000           # a range of <= this many blocks that errors stops the run
LOGS_INTERVAL_S = 0.5       # <= 2 requests per second
RETRY_WAIT_S = 30           # on a rate-limit error
MAX_RETRIES = 5
LOGS_HTTP_TIMEOUT_S = 120
CAP_SUSPECT = 10_000        # a response with >= this many logs may be capped: treated as a range error

THRESHOLD_RAW = 1_000_000 * 10**6       # $1,000,000 in 6-decimal units
GATE_ABS_RAW = 10 * 10**6               # $10
GATE_REL_DEN = 1000                     # 0.1% of the larger anchor
GATE_SHARE = 0.99

TS_SAMPLE_PER_RESERVE = 500
TS_SAMPLE_SEED = 20261013
DEPLOY_SEARCH_LO = 16_000_000           # both aTokens had no code here (checked)

B1_DIR = "depositor-balances"
B1_ASOF_BLOCK = 26_180_400
B1_FILES_SHA256 = {
    "blocks.csv": "c59020cf9c734416936e75de7182ab4aa116625b0bd7727048fe25cd883e313e",
    "daily-balances-usdc.csv.gz": "145bc8abb5ec611f112e29316feff80a0f0975bcbb54a4af6926d581119b0f9d",
    "daily-balances-usdt.csv.gz": "23520c27f7570baa4f470dc199ce7c97b9681351fc7a3d85ca86631d0e5498ad",
    "panel-population.csv": "0728ea8d92b7c058ec081608e6c9c4db66ee2e2b932d29bb4d8dc7d358e96cad",
    "reserve-state.csv": "430532cd3cef4e6f6413b77279940a21fe9cfa7d8e381f49913e8bf56f3a4478",
}
OUT_FILE_MAX_BYTES = 49 * 10**6

RAY = 10**27
HALF_RAY = RAY // 2
SECONDS_PER_YEAR = 365 * 24 * 3600

# ---------------------------------------------------------------------------------------------
# Event signatures (keccak256, not NIST SHA3-256)
# ---------------------------------------------------------------------------------------------

BALANCE_SIGS = {
    "Mint": "Mint(address,address,uint256,uint256,uint256)",
    "Burn": "Burn(address,address,uint256,uint256,uint256)",
    "BalanceTransfer": "BalanceTransfer(address,address,uint256,uint256)",
    "Transfer": "Transfer(address,address,uint256)",
}
OTHER_SIGS = {
    "Approval": "Approval(address,address,uint256)",
    "Initialized": "Initialized(address,address,address,address,uint8,string,string,bytes)",
    "Upgraded": "Upgraded(address)",
    "AdminChanged": "AdminChanged(address,address)",
}
# (topics incl. topic0, data words) for the four decoded types
LAYOUT = {"Mint": (3, 3), "Burn": (3, 3), "BalanceTransfer": (3, 2), "Transfer": (3, 1)}
# Canonical ERC-20 topic0 values, used as a self-check of the hash implementation
KNOWN_TOPIC0 = {
    "Transfer(address,address,uint256)": "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    "Approval(address,address,uint256)": "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
}


def topic0(signature: str) -> str:
    return "0x" + B.keccak256(signature.encode()).hex()


TOPIC_OF = {name: topic0(sig) for name, sig in {**BALANCE_SIGS, **OTHER_SIGS}.items()}
TYPE_OF_TOPIC = {t: name for name, t in TOPIC_OF.items()}


def check_signatures() -> dict:
    out = {"topic0": {BALANCE_SIGS.get(n) or OTHER_SIGS[n]: t for n, t in TOPIC_OF.items()}, "known_match": {}}
    for sig, want in KNOWN_TOPIC0.items():
        out["known_match"][sig] = topic0(sig) == want
    nist = "0x" + hashlib.sha3_256(b"Transfer(address,address,uint256)").hexdigest()
    out["nist_sha3_differs"] = nist != KNOWN_TOPIC0["Transfer(address,address,uint256)"]
    out["ok"] = all(out["known_match"].values()) and out["nist_sha3_differs"]
    return out


# ---------------------------------------------------------------------------------------------
# Ray math (Aave WadRayMath, round half up) and the G.2 balance-change formulas
# ---------------------------------------------------------------------------------------------


def ray_mul(a: int, b: int) -> int:
    return (a * b + HALF_RAY) // RAY


def ray_div(a: int, b: int) -> int:
    return (a * RAY + b // 2) // b


def signed_ray_div(x: int, b: int) -> int:
    return ray_div(x, b) if x >= 0 else -ray_div(-x, b)


def to_units(raw: int, decimals: int) -> int:
    """Raw token amount -> 6-decimal units (1e-6 token), rounded half away from zero. All analysis
    (gate, universe) runs in these units so 18-decimal balances fit in int64; outputs keep raw."""
    if decimals == 6:
        return raw
    if decimals < 6:
        return raw * 10 ** (6 - decimals)
    div = 10 ** (decimals - 6)
    q = (abs(raw) + div // 2) // div
    return q if raw >= 0 else -q


def from_units(units: int, decimals: int) -> int:
    return units * 10 ** (decimals - 6) if decimals >= 6 else units // 10 ** (6 - decimals)


class DecodeError(Exception):
    pass


def topic_address(t: str) -> str:
    if not (isinstance(t, str) and t.startswith("0x") and len(t) == 66):
        raise DecodeError(f"bad topic {t!r}")
    if int(t[2:26], 16) != 0:
        raise DecodeError("address topic has high bits set")
    return "0x" + t[26:].lower()


def decode_log(topics: list[str], data: str) -> dict | None:
    """Decode one aToken log. Returns None for a topic0 outside the four decoded types.

    Fields: type, party1, party2, value, balanceIncrease, index, deltas = [(address, delta_raw,
    scaled_delta)] per G.2. party1/party2: Mint onBehalfOf/caller; Burn from/target;
    BalanceTransfer from/to; Transfer from/to."""
    if not topics:
        raise DecodeError("no topics")
    typ = TYPE_OF_TOPIC.get(topics[0].lower())
    if typ not in LAYOUT:
        return None
    nt, nw = LAYOUT[typ]
    if len(topics) != nt:
        raise DecodeError(f"{typ}: {len(topics)} topics")
    if not (isinstance(data, str) and data.startswith("0x")):
        raise DecodeError("bad data")
    d = data[2:]
    if len(d) != 64 * nw:
        raise DecodeError(f"{typ}: data length {len(d)}")
    words = [int(d[64 * i:64 * i + 64], 16) for i in range(nw)]
    t1, t2 = topic_address(topics[1]), topic_address(topics[2])
    ev = {"type": typ, "value": words[0], "balanceIncrease": None, "index": None, "deltas": []}
    if typ == "Mint":
        caller, on_behalf = t1, t2
        v, bi, idx = words
        ev.update(party1=on_behalf, party2=caller, balanceIncrease=bi, index=idx)
        if idx == 0:
            raise DecodeError("Mint index 0")
        ev["deltas"] = [(on_behalf, v - bi, signed_ray_div(v - bi, idx))]
    elif typ == "Burn":
        frm, target = t1, t2
        v, bi, idx = words
        ev.update(party1=frm, party2=target, balanceIncrease=bi, index=idx)
        if idx == 0:
            raise DecodeError("Burn index 0")
        ev["deltas"] = [(frm, -(v + bi), -ray_div(v + bi, idx))]
    elif typ == "BalanceTransfer":
        frm, to = t1, t2
        v, idx = words
        ev.update(party1=frm, party2=to, index=idx)
        amt = ray_mul(v, idx)  # value . index / 1e27, rounded as the token does
        ev["deltas"] = [(frm, -amt, -v), (to, amt, v)]
    else:  # Transfer: informational, no G.2 delta (the paired event carries it)
        ev.update(party1=t1, party2=t2)
    return ev


# ---------------------------------------------------------------------------------------------
# eth_getLogs with range splitting
# ---------------------------------------------------------------------------------------------


class RangeError(Exception):
    """The range errored (any non-rate-limit error): split it."""


_LOG_RATE_WORDS = ("rate limit", "rate-limit", "ratelimit", "too many requests", "throttl", "quota",
                   "request limit", "requests limit")


def is_rate_limit(status: int | None, err: dict | None) -> bool:
    if status == 429:
        return True
    if err is None:
        return False
    if err.get("code") == 429:
        return True
    msg = (str(err.get("message", "")) + " " + str(err.get("data", ""))).lower()
    return any(w in msg for w in _LOG_RATE_WORDS)


def http_post(url: str, payload: bytes, timeout: float = LOGS_HTTP_TIMEOUT_S) -> tuple[int, bytes]:
    """POST; returns (status, body). Raises OSError-family on transport failure."""
    req = urllib.request.Request(url, data=payload, headers={
        "content-type": "application/json", "accept": "application/json", "user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return e.code, body


def validate_logs(result, address: str, lo: int, hi: int) -> list[dict]:
    if not isinstance(result, list):
        raise RangeError(f"result is {type(result).__name__}")
    if len(result) >= CAP_SUSPECT:
        raise RangeError(f"{len(result)} logs: possibly capped")
    addr = address.lower()
    seen = set()
    out = []
    for lg in result:
        try:
            if str(lg["address"]).lower() != addr:
                raise RangeError(f"log of {lg['address']}")
            b = int(lg["blockNumber"], 16)
            if not lo <= b <= hi:
                raise RangeError(f"block {b} outside [{lo},{hi}]")
            if lg.get("removed"):
                raise RangeError("removed log")
            li = int(lg["logIndex"], 16)
            ti = int(lg["transactionIndex"], 16)
            th = str(lg["transactionHash"]).lower()
            bh = str(lg.get("blockHash") or "").lower()
            topics = [str(t).lower() for t in lg["topics"]]
            data = str(lg["data"]).lower()
            ts = int(lg["blockTimestamp"], 16) if lg.get("blockTimestamp") else None
        except (KeyError, TypeError, ValueError) as e:
            raise RangeError(f"malformed log: {e}")
        if not (1 <= len(topics) <= 4) or len(th) != 66 or not data.startswith("0x"):
            raise RangeError("malformed log fields")
        if (b, li) in seen:
            raise RangeError(f"duplicate log {b}/{li}")
        seen.add((b, li))
        out.append({"block": b, "ts": ts, "block_hash": bh, "tx": th, "tx_index": ti, "log_index": li,
                    "topics": topics, "data": data})
    out.sort(key=lambda x: (x["block"], x["log_index"]))
    return out


class LogsClient:
    """eth_getLogs on one endpoint: pacing, rate-limit retries; every other error is a RangeError."""

    def __init__(self, url: str = LOGS_RPC_URL, post=None, interval: float = LOGS_INTERVAL_S,
                 retry_wait: float = RETRY_WAIT_S, max_retries: int = MAX_RETRIES, sleep=time.sleep, log_event=None):
        self.url = url
        self.post = post or (lambda payload: http_post(url, payload))
        self.pacer = B.Pacer(interval)
        self.retry_wait = retry_wait
        self.max_retries = max_retries
        self.sleep = sleep
        self.log_event = log_event or (lambda ev: None)
        self.counts = {"requests": 0, "ok": 0, "range_errors": 0, "rate_limit_retries": 0, "splits": 0,
                       "failures": 0, "logs": 0, "bytes": 0, "seconds_in_requests": 0.0, "range_error_kinds": {}}
        self._id = 0

    def get_logs(self, address: str, lo: int, hi: int) -> list[dict]:
        self._id += 1
        payload = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": "eth_getLogs",
                              "params": [{"address": address, "fromBlock": hex(lo), "toBlock": hex(hi)}]}).encode()
        retries = 0
        while True:
            self.pacer.wait()
            self.counts["requests"] += 1
            t0 = time.monotonic()
            err = None
            status = None
            try:
                try:
                    status, body = self.post(payload)
                finally:
                    self.counts["seconds_in_requests"] += time.monotonic() - t0
                self.counts["bytes"] += len(body)
                if status == 200:
                    try:
                        obj = json.loads(body)
                    except ValueError:
                        raise RangeError(f"non-JSON body ({len(body)} bytes)")
                    if not isinstance(obj, dict):
                        raise RangeError("non-object body")
                    err = obj.get("error")
                    if err is not None and not isinstance(err, dict):
                        err = {"message": str(err)}
                    if err is None:
                        if "result" not in obj:
                            raise RangeError("no result")
                        logs = validate_logs(obj["result"], address, lo, hi)
                        self.counts["ok"] += 1
                        self.counts["logs"] += len(logs)
                        return logs
                if is_rate_limit(status, err):
                    retries += 1
                    if retries > self.max_retries:
                        self.counts["failures"] += 1
                        self.log_event({"type": "failure", "kind": "rate_limit", "range": [lo, hi],
                                        "retries": retries - 1, "status": status, "error": err})
                        raise B.TerminalError(f"rate limit after {self.max_retries} retries at [{lo},{hi}]")
                    self.counts["rate_limit_retries"] += 1
                    self.log_event({"type": "retry", "kind": "rate_limit", "range": [lo, hi], "attempt": retries,
                                    "status": status, "error": err, "wait_s": self.retry_wait})
                    self.pacer.pause(self.retry_wait)
                    self.sleep(self.retry_wait)
                    continue
                if err is not None:
                    raise RangeError(f"rpc error {json.dumps(err)[:300]}")
                raise RangeError(f"HTTP {status}")
            except RangeError as e:
                self.counts["range_errors"] += 1
                kind = range_error_kind(str(e))
                self.counts["range_error_kinds"][kind] = self.counts["range_error_kinds"].get(kind, 0) + 1
                raise
            except (OSError, http.client.HTTPException) as e:  # transport (URLError, timeouts, resets)
                self.counts["range_errors"] += 1
                self.counts["range_error_kinds"]["transport"] = self.counts["range_error_kinds"].get("transport", 0) + 1
                raise RangeError(f"transport: {type(e).__name__}: {e}")


def range_error_kind(msg: str) -> str:
    m = msg.lower()
    if "response size" in m or "10k logs" in m or "possibly capped" in m:
        return "response_size"
    if "unavailable" in m:
        return "service_unavailable"
    if "http" in m:
        return "http"
    if "timeout" in m or "timed out" in m:
        return "timeout"
    return "other"


def split_range(lo: int, hi: int) -> tuple[tuple[int, int], tuple[int, int]] | None:
    """Halves of [lo, hi]; the first half is at least RANGE_MIN blocks. None at the minimum."""
    n = hi - lo + 1
    if n <= RANGE_MIN:
        return None
    h = max(RANGE_MIN, n // 2)
    return (lo, lo + h - 1), (lo + h, hi)


def top_ranges(start: int, end: int, size: int = RANGE_MAX) -> list[tuple[int, int]]:
    return [(s, min(s + size - 1, end)) for s in range(start, end + 1, size)]


def uncovered(lo: int, hi: int, done: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Sub-intervals of [lo, hi] not covered by the (sorted, disjoint) done intervals."""
    gaps, cur = [], lo
    for a, b in done:
        if b < cur or a > hi:
            continue
        if a > cur:
            gaps.append((cur, a - 1))
        cur = max(cur, b + 1)
        if cur > hi:
            break
    if cur <= hi:
        gaps.append((cur, hi))
    return gaps


class LogStore:
    """Checkpoint of fetched sub-ranges: one gz CSV per range plus a JSONL index."""

    COLS = ["block", "ts", "block_hash", "tx", "tx_index", "log_index", "topic0", "topic1", "topic2", "topic3", "data"]

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.index = B.JsonlStore(self.root / "index.jsonl")

    def done(self, reserve: str) -> list[tuple[int, int]]:
        out = sorted((r["k"][1], r["k"][2]) for r in self.index.values() if r["k"][0] == reserve)
        for (a1, b1), (a2, b2) in zip(out, out[1:]):
            if a2 <= b1:
                raise B.TerminalError(f"overlapping checkpoint ranges {reserve} [{a1},{b1}] [{a2},{b2}]")
        return out

    def path(self, reserve: str, lo: int, hi: int) -> Path:
        return self.root / reserve / f"{lo:09d}_{hi:09d}.csv.gz"

    def save(self, reserve: str, lo: int, hi: int, logs: list[dict]) -> None:
        p = self.path(reserve, lo, hi)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        with gzip.open(tmp, "wt", newline="", compresslevel=6) as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(self.COLS)
            for lg in logs:
                t = lg["topics"] + [""] * (4 - len(lg["topics"]))
                w.writerow([lg["block"], "" if lg["ts"] is None else lg["ts"], lg["block_hash"], lg["tx"],
                            lg["tx_index"], lg["log_index"], *t, lg["data"]])
        os.replace(tmp, p)
        self.index.put((reserve, lo, hi), {"n": len(logs), "sha256": B.sha256_file(p)})

    def load(self, reserve: str, lo: int, hi: int) -> list[dict]:
        p = self.path(reserve, lo, hi)
        out = []
        with gzip.open(p, "rt", newline="") as f:
            r = csv.reader(f)
            head = next(r)
            if head != self.COLS:
                raise B.TerminalError(f"bad checkpoint header {p}")
            for row in r:
                out.append({"block": int(row[0]), "ts": int(row[1]) if row[1] else None, "block_hash": row[2],
                            "tx": row[3], "tx_index": int(row[4]), "log_index": int(row[5]),
                            "topics": [t for t in row[6:10] if t], "data": row[10]})
        rec = self.index.get((reserve, lo, hi))
        if rec is None or rec["n"] != len(out):
            raise B.TerminalError(f"checkpoint count mismatch {p}")
        return out

    def iter_reserve(self, reserve: str):
        for lo, hi in self.done(reserve):
            yield from self.load(reserve, lo, hi)


def fetch_logs(store: LogStore, client: LogsClient, reserve: str, address: str, start: int, end: int,
               on_progress=None) -> dict:
    """Fill every gap of [start, end] in the store. A range that errors is split in half until it
    succeeds or reaches RANGE_MIN blocks; an error at RANGE_MIN stops the run (TerminalError)."""
    stats = {"ranges_ok": 0, "splits": 0}
    for top in top_ranges(start, end):
        for gap in uncovered(top[0], top[1], store.done(reserve)):
            stack = [gap]
            while stack:
                lo, hi = stack.pop()
                try:
                    logs = client.get_logs(address, lo, hi)
                except RangeError as e:
                    halves = split_range(lo, hi)
                    if halves is None:
                        client.counts["failures"] += 1
                        client.log_event({"type": "failure", "kind": "range_at_minimum", "reserve": reserve,
                                          "range": [lo, hi], "error": str(e)[:400]})
                        raise B.TerminalError(f"range [{lo},{hi}] errored at the minimum size: {e}")
                    client.counts["splits"] += 1
                    stats["splits"] += 1
                    client.log_event({"type": "split", "reserve": reserve, "range": [lo, hi],
                                      "into": [list(halves[0]), list(halves[1])], "kind": range_error_kind(str(e)),
                                      "error": str(e)[:200]})
                    stack.append(halves[1])
                    stack.append(halves[0])
                    continue
                store.save(reserve, lo, hi, logs)
                stats["ranges_ok"] += 1
                if on_progress:
                    on_progress(reserve, hi)
    done = store.done(reserve)
    if uncovered(start, end, done):
        raise B.TerminalError(f"{reserve}: coverage incomplete")
    return stats


# ---------------------------------------------------------------------------------------------
# Gate math (G.2)
# ---------------------------------------------------------------------------------------------


def gate_tolerance_pass(a0, a1, diff):
    """Vectorised: |diff| <= max($10, 0.1% of max(a0, a1)), exact in integers."""
    import numpy as np
    ad = np.abs(np.asarray(diff, dtype=np.int64))
    mx = np.maximum(np.asarray(a0, dtype=np.int64), np.asarray(a1, dtype=np.int64))
    return (ad <= GATE_ABS_RAW) | (ad <= mx // GATE_REL_DEN)


def gate_tolerance(a0, a1):
    import numpy as np
    mx = np.maximum(np.asarray(a0, dtype=np.int64), np.asarray(a1, dtype=np.int64))
    return np.maximum(GATE_ABS_RAW, mx // GATE_REL_DEN)


def pair_index(snap_blocks, ev_blocks):
    """Daily pair p for each event: snap_blocks[p] < block <= snap_blocks[p + 1]; -1 / len-1 outside."""
    import numpy as np
    return np.searchsorted(np.asarray(snap_blocks), np.asarray(ev_blocks), side="left") - 1


def gate_pairs(A, valid, snap_blocks, ev_addr, ev_block, ev_delta, ev_scaled=None, income=None):
    """Every (address, p) with an anchor on both ends of daily pair p.

    A: (n_addr, n_snap) int64 anchors (6-decimal units) at snapshot blocks snap_blocks (increasing);
    valid: bool mask. ev_*: one row per balance change in chain order (address row index, block,
    delta, scaled delta). income: optional normalized income per snapshot (float, ray / 1e27) for
    the interest diagnostic.

    Returns 1-D arrays per pair, with both rules: the registered G.2 tolerance (`tol`, `pass`, base
    max(a0, a1)) and deviation D2 (`tol_d2`, `pass_d2`, base max(a0, a1, intraday peak)). The
    intraday peak is the maximum of the G.2 path a0 + cumulative event changes over the pair."""
    import numpy as np
    n_addr, n_snap = A.shape
    n_pair = n_snap - 1
    S = np.zeros((n_addr, n_pair), dtype=np.int64)
    N = np.zeros((n_addr, n_pair), dtype=np.int64)
    SS = np.zeros((n_addr, n_pair), dtype=np.float64)
    PK = np.full((n_addr, n_pair), np.iinfo(np.int64).min, dtype=np.int64)
    ev_addr = np.asarray(ev_addr, dtype=np.int64)
    ev_delta = np.asarray(ev_delta, dtype=np.int64)
    p = pair_index(snap_blocks, ev_block)
    m = (p >= 0) & (p < n_pair)
    np.add.at(S, (ev_addr[m], p[m]), ev_delta[m])
    np.add.at(N, (ev_addr[m], p[m]), 1)
    if ev_scaled is not None:
        np.add.at(SS, (ev_addr[m], p[m]), np.asarray(ev_scaled, dtype=np.float64)[m])
    if m.any():
        key = ev_addr[m] * n_pair + p[m]
        d_m = ev_delta[m]
        order = np.argsort(key, kind="stable")  # stable: chain order kept inside each (address, pair)
        k_s, d_s = key[order], d_m[order]
        starts = np.r_[0, np.nonzero(np.diff(k_s))[0] + 1]
        lens = np.diff(np.r_[starts, len(k_s)])
        cs = np.cumsum(d_s)  # int64 wrap-around cancels in the difference below
        run = cs - np.repeat(cs[starts] - d_s[starts], lens)
        ka, kp = k_s // n_pair, k_s % n_pair
        path = A[ka, kp] + run
        PK[ka[starts], kp[starts]] = np.maximum.reduceat(path, starts)
    both = valid[:, :-1] & valid[:, 1:]
    ai, pi = np.nonzero(both)
    a0 = A[ai, pi]
    a1 = A[ai, pi + 1]
    ev = S[ai, pi]
    diff = (a1 - a0) - ev
    peak = np.maximum(np.maximum(a0, a1), PK[ai, pi])
    tol_d2 = np.maximum(GATE_ABS_RAW, peak // GATE_REL_DEN)
    out = {"addr": ai, "p": pi, "a0": a0, "a1": a1, "ev": ev, "n_ev": N[ai, pi], "diff": diff,
           "tol": gate_tolerance(a0, a1), "pass": gate_tolerance_pass(a0, a1, diff),
           "peak": peak, "tol_d2": tol_d2, "pass_d2": np.abs(diff) <= tol_d2}
    if income is not None:
        inc = np.asarray(income, dtype=np.float64)
        pred = (a0.astype(np.float64) / inc[pi] + SS[ai, pi]) * inc[pi + 1]
        out["res_interest"] = a1.astype(np.float64) - pred
    return out


def gate_summary(g: dict, key: str = "pass") -> dict:
    import numpy as np
    ok = g[key]
    n = int(len(ok))
    has = g["n_ev"] > 0
    ne = int(has.sum())
    s_all = float(ok.mean()) if n else None
    s_ev = float(ok[has].mean()) if ne else None
    return {"n_pairs": n, "n_pass": int(ok.sum()), "share_pass": s_all,
            "n_pairs_with_event": ne, "n_pass_with_event": int(ok[has].sum()), "share_pass_with_event": s_ev,
            "passes": bool(n and ne and s_all >= GATE_SHARE and s_ev >= GATE_SHARE)}


def normalized_income(liquidity_index: int, liquidity_rate: int, last_update: int, ts: int) -> int:
    """Aave ReserveLogic.getNormalizedIncome at timestamp ts (linear interest since last update)."""
    if ts <= last_update:
        return liquidity_index
    linear = RAY + liquidity_rate * (ts - last_update) // SECONDS_PER_YEAR
    return ray_mul(linear, liquidity_index)


def short_addr(a: str) -> str:
    return a[:6] + "…" + a[-4:]


# ---------------------------------------------------------------------------------------------
# Context, git, run state
# ---------------------------------------------------------------------------------------------


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def datasets_dir() -> Path:
    env = os.environ.get("MEMBRANE_DATASETS_DIR")
    return Path(env) if env else repo_root().parent / "membrane-datasets"


def git_info() -> dict:
    root = repo_root()
    me = Path(__file__).resolve()
    try:
        rel = str(me.relative_to(root))
        g = lambda *a: subprocess.check_output(["git", "-C", str(root), *a], text=True).strip()  # noqa: E731
        return {"sha": g("rev-parse", "HEAD"), "branch": g("rev-parse", "--abbrev-ref", "HEAD"), "path": rel,
                "dirty": bool(g("status", "--porcelain", "--", rel)),
                "file_last_commit": g("log", "-1", "--format=%H", "--", rel), "file_sha256": B.sha256_file(me),
                "helper": "scripts/research/history-forecasts/b_acquire.py",
                "helper_last_commit": g("log", "-1", "--format=%H", "--", "scripts/research/history-forecasts/b_acquire.py")}
    except Exception as e:  # pragma: no cover
        return {"error": str(e)}


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main_reserves() -> dict[str, dict]:
    return {r: {"asset": RESERVES[r]["asset"], "atoken": RESERVES[r]["atoken"], "decimals": 6, "symbol": r}
            for r in RESERVE_ORDER}


class Ctx:
    def __init__(self, work: Path, out: Path, ddir: Path, mode: str = "main", reserves: dict | None = None):
        self.mode = mode
        self.reserves = reserves if reserves is not None else main_reserves()
        self.order = tuple(self.reserves)
        self.work = Path(work)
        self.out = Path(out)
        self.ddir = Path(ddir)
        self.work.mkdir(parents=True, exist_ok=True)
        self.state_path = self.work / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.events_path = self.work / "events.jsonl"
        self.lock = threading.Lock()
        self.rpc = B.Rpc(STATE_RPC_URL, self.events_path)   # drpc, <= 4 req/s, B.1 retry policy
        self.logs_client = LogsClient(log_event=self.log_event)
        self.store = LogStore(self.work / "logs")
        self.anchor_store = B.JsonlStore(self.work / "anchors.jsonl")
        self.ts_store = B.JsonlStore(self.work / "ts_fetched.jsonl")
        self.workers = B.WORKERS
        self._decoded = {}

    def set_reserves(self, reserves: dict) -> None:
        self.reserves = reserves
        self.order = tuple(reserves)

    def dec(self, r: str) -> int:
        return int(self.reserves[r]["decimals"])

    def log_event(self, ev: dict) -> None:
        ev = {"utc": utcnow(), "src": "logs", **ev}
        print("EVENT " + json.dumps(ev, default=str)[:600], flush=True)
        with self.lock:
            with open(self.events_path, "a") as f:
                f.write(json.dumps(ev, default=str) + "\n")

    def save_state(self) -> None:
        tmp = self.work / "state.json.tmp"
        tmp.write_text(json.dumps(self.state, indent=1, sort_keys=True, default=str))
        os.replace(tmp, self.state_path)


# ---------------------------------------------------------------------------------------------
# Phase: preflight
# ---------------------------------------------------------------------------------------------


def eth_get_code_len(ctx: Ctx, address: str, block: int) -> int:
    code = ctx.rpc.call("eth_getCode", [address, hex(block)], "preflight", tag=f"code {address} {block}")
    if not isinstance(code, str) or not code.startswith("0x"):
        raise B.TerminalError("bad eth_getCode result")
    return (len(code) - 2) // 2


def find_deploy_block(has_code, lo: int, hi: int) -> int:
    """Smallest block b in (lo, hi] with has_code(b); requires not has_code(lo) and has_code(hi)."""
    if has_code(lo) or not has_code(hi):
        raise B.TerminalError(f"deploy search bracket invalid [{lo},{hi}]")
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if has_code(mid):
            hi = mid
        else:
            lo = mid
    return hi


def logs_rpc_block(tag: str) -> dict:
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": [tag, False]}).encode()
    status, body = http_post(LOGS_RPC_URL, payload, timeout=60)
    obj = json.loads(body)
    if status != 200 or "result" not in obj or not isinstance(obj["result"], dict):
        raise B.TerminalError(f"cannot read block {tag} from the logs endpoint: {status} {body[:200]!r}")
    return obj["result"]


def sel(sig: str) -> bytes:
    return B.selector(sig)


def ref_reads(ctx: Ctx, block: int) -> dict:
    calls, labels = [], []
    for r in ctx.order:
        a, at = ctx.reserves[r]["asset"], ctx.reserves[r]["atoken"]
        calls.append((POOL, sel("getReserveNormalizedIncome(address)") + B.enc_address(a)))
        labels.append((r, "normalizedIncome"))
        calls.append((at, sel("scaledTotalSupply()")))
        labels.append((r, "scaledTotalSupply"))
        calls.append((at, sel("totalSupply()")))
        labels.append((r, "totalSupply"))
    res = ctx.rpc.multicall(calls, block, "preflight", tag=f"refs {block}")
    out = {}
    for (r, lab), (ok, ret) in zip(labels, res):
        if not ok or len(ret) != 32:
            raise B.TerminalError(f"reference read failed {r} {lab} at {block}")
        out.setdefault(r, {})[lab] = str(int.from_bytes(ret, "big"))
    return out


def phase_preflight(ctx: Ctx) -> None:
    if ctx.mode != "main":
        raise B.TerminalError("preflight is the main-mode phase; holdout mode starts with select")
    st = ctx.state
    if "asof" not in st:
        fin = logs_rpc_block("finalized")
        lat = logs_rpc_block("latest")
        st["asof"] = {"block": int(fin["number"], 16), "ts": int(fin["timestamp"], 16), "hash": fin["hash"],
                      "pinned_utc": utcnow(), "latest_at_pin": int(lat["number"], 16),
                      "rule": "eth_getBlockByNumber('finalized') on the logs endpoint at start, pinned by number"}
        ctx.save_state()
    asof = st["asof"]["block"]
    if "signatures" not in st:
        sig = check_signatures()
        st["signatures"] = sig
        ctx.save_state()
        if not sig["ok"]:
            raise B.TerminalError("keccak self-check failed")
    if "asof_crosscheck" not in st:
        b = ctx.rpc.block_obj(asof, "preflight")
        st["asof_crosscheck"] = {"state_rpc_hash": b["hash"], "match": b["hash"] == st["asof"]["hash"],
                                 "state_rpc_ts": int(b["timestamp"], 16)}
        ctx.save_state()
        if not st["asof_crosscheck"]["match"]:
            raise B.TerminalError("asof hash differs between endpoints")
    dep = st.setdefault("deploy", {})
    for r in ctx.order:
        if r in dep:
            continue
        at = ctx.reserves[r]["atoken"]
        cache: dict[int, bool] = {}

        def has_code(b, at=at, cache=cache):
            if b not in cache:
                cache[b] = eth_get_code_len(ctx, at, b) > 0
            return cache[b]

        blk = find_deploy_block(has_code, DEPLOY_SEARCH_LO, asof)
        bo = ctx.rpc.block_obj(blk, "preflight")
        dep[r] = {"block": blk, "ts": int(bo["timestamp"], 16), "utc": B.iso_utc(int(bo["timestamp"], 16)),
                  "rule": "smallest block whose post-state has code at the aToken address (eth_getCode bisection)",
                  "probes": len(cache)}
        ctx.save_state()
    refs = st.setdefault("refs", {})
    for lab, blk in (("b1_asof", B1_ASOF_BLOCK), ("asof", asof)):
        if lab not in refs:
            refs[lab] = {"block": blk, "reads": ref_reads(ctx, blk)}
            ctx.save_state()
    print("PREFLIGHT " + json.dumps({k: st[k] for k in ("asof", "deploy", "asof_crosscheck")}), flush=True)


# ---------------------------------------------------------------------------------------------
# Phase: logs
# ---------------------------------------------------------------------------------------------


def phase_logs(ctx: Ctx) -> None:
    asof = ctx.state["asof"]["block"]
    t0 = time.monotonic()
    last = [0.0]

    def prog(reserve, hi):
        now = time.monotonic()
        if now - last[0] > 30:
            last[0] = now
            c = ctx.logs_client.counts
            dep = ctx.state["deploy"][reserve]["block"]
            print(f"PROGRESS logs {reserve} at {hi} ({(hi - dep) / max(1, asof - dep):.1%}) elapsed={now - t0:.0f}s "
                  f"req={c['requests']} logs={c['logs']} splits={c['splits']} rl_retries={c['rate_limit_retries']} "
                  f"MB={c['bytes'] / 1e6:.0f}", flush=True)

    stats = ctx.state.setdefault("logs_stats", {})
    for r in ctx.order:
        dep = ctx.state["deploy"][r]["block"]
        s = fetch_logs(ctx.store, ctx.logs_client, r, ctx.reserves[r]["atoken"], dep, asof, on_progress=prog)
        done = ctx.store.done(r)
        stats[r] = {"ranges": len(done), "logs": sum(ctx.store.index.get((r, a, b))["n"] for a, b in done),
                    "last_session": s}
        ctx.save_state()
        print(f"LOGS {r}: " + json.dumps(stats[r]), flush=True)


# ---------------------------------------------------------------------------------------------
# Phase: timestamps
# ---------------------------------------------------------------------------------------------


def block_table(ctx: Ctx) -> dict[int, tuple[int | None, str]]:
    """block -> (ts, block_hash) over both reserves; checks consistency within a block."""
    if getattr(ctx, "_block_table", None) is not None:
        return ctx._block_table
    out: dict[int, tuple[int | None, str]] = {}
    bad = 0
    for r in ctx.order:
        for lg in ctx.store.iter_reserve(r):
            cur = (lg["ts"], lg["block_hash"])
            prev = out.get(lg["block"])
            if prev is None:
                out[lg["block"]] = cur
            elif prev != cur:
                bad += 1
    if bad:
        raise B.TerminalError(f"{bad} logs disagree with another log of the same block on ts/hash")
    ctx._block_table = out
    return out


def phase_timestamps(ctx: Ctx) -> None:
    if ctx.state.get("timestamps", {}).get("done"):
        return
    tab = block_table(ctx)
    missing = sorted(b for b, (ts, _) in tab.items() if ts is None)
    for b in missing:
        if not ctx.ts_store.has(b):
            o = ctx.rpc.block_obj(b, "timestamps")
            ctx.ts_store.put(b, {"ts": int(o["timestamp"], 16), "hash": o["hash"]})
    tab = dict(tab)
    for b in missing:
        rec = ctx.ts_store.get(b)
        tab[b] = (rec["ts"], tab[b][1] or rec["hash"])
    blocks = sorted(tab)
    nonmono = sum(1 for x, y in zip(blocks, blocks[1:]) if not tab[x][0] < tab[y][0])
    # seeded sample per reserve, checked against eth_getBlockByNumber on the state endpoint
    rng = random.Random(TS_SAMPLE_SEED)
    sample = []
    for r in ctx.order:
        rb = sorted({lg["block"] for lg in ctx.store.iter_reserve(r)})
        sample += rng.sample(rb, min(TS_SAMPLE_PER_RESERVE, len(rb)))
    sample = sorted(set(sample))
    chk = {}
    for b in sample:
        if not ctx.ts_store.has(b):
            o = ctx.rpc.block_obj(b, "timestamps")
            ctx.ts_store.put(b, {"ts": int(o["timestamp"], 16), "hash": o["hash"]})
        rec = ctx.ts_store.get(b)
        chk[b] = (rec["ts"] == tab[b][0], rec["hash"].lower() == tab[b][1].lower())
    res = {"done": True, "n_blocks": len(tab), "n_missing_in_logs_fetched": len(missing),
           "n_non_increasing_pairs": nonmono, "sample_seed": TS_SAMPLE_SEED, "sample_n": len(sample),
           "sample_ts_match": sum(1 for a, _ in chk.values() if a), "sample_hash_match": sum(1 for _, h in chk.values() if h),
           "source": "blockTimestamp/blockHash of each log from the logs endpoint; seeded sample checked by "
                     "eth_getBlockByNumber on the state endpoint"}
    ctx.state["timestamps"] = res
    ctx.save_state()
    print("TIMESTAMPS " + json.dumps(res), flush=True)
    if nonmono or res["sample_ts_match"] != len(sample) or res["sample_hash_match"] != len(sample):
        raise B.TerminalError("timestamp checks failed")


def ts_lookup(ctx: Ctx) -> dict[int, int]:
    tab = block_table(ctx)
    out = {}
    for b, (ts, _) in tab.items():
        if ts is None:
            rec = ctx.ts_store.get(b)
            if rec is None:
                raise B.TerminalError(f"no timestamp for block {b}")
            ts = rec["ts"]
        out[b] = ts
    return out


# ---------------------------------------------------------------------------------------------
# Phase: decode
# ---------------------------------------------------------------------------------------------


class Decoded:
    """Balance-change rows of one reserve (numpy) plus per-type counts."""

    def __init__(self):
        self.addr_ids: dict[str, int] = {}
        self.addrs: list[str] = []
        self.counts: dict[str, int] = {}
        self.unknown: dict[str, int] = {}
        self.other_known: dict[str, int] = {}
        self.decode_errors: list = []
        self.n_logs = 0
        self.upgraded_blocks: list[int] = []

    def aid(self, a: str) -> int:
        i = self.addr_ids.get(a)
        if i is None:
            i = len(self.addrs)
            self.addr_ids[a] = i
            self.addrs.append(a)
        return i


def decode_reserve(ctx: Ctx, r: str) -> Decoded:
    import numpy as np
    if r in ctx._decoded:
        return ctx._decoded[r]
    d = Decoded()
    dec = ctx.dec(r)
    addr, blk, li, sub, delta, scaled, idx = [], [], [], [], [], [], []
    for lg in ctx.store.iter_reserve(r):
        d.n_logs += 1
        t0 = lg["topics"][0] if lg["topics"] else ""
        try:
            ev = decode_log(lg["topics"], lg["data"])
        except DecodeError as e:
            d.decode_errors.append({"block": lg["block"], "log_index": lg["log_index"], "error": str(e)})
            continue
        if ev is None:
            name = TYPE_OF_TOPIC.get(t0)
            if name:
                d.other_known[name] = d.other_known.get(name, 0) + 1
                if name == "Upgraded":
                    d.upgraded_blocks.append(lg["block"])
            else:
                d.unknown[t0] = d.unknown.get(t0, 0) + 1
            continue
        d.counts[ev["type"]] = d.counts.get(ev["type"], 0) + 1
        for k, (a, dr, sd) in enumerate(ev["deltas"]):
            addr.append(d.aid(a))
            blk.append(lg["block"])
            li.append(lg["log_index"])
            sub.append(k)
            delta.append(to_units(dr, dec))
            scaled.append(to_units(sd, dec))
            idx.append(ev["index"])
    d.addr = np.asarray(addr, dtype=np.int64)
    d.block = np.asarray(blk, dtype=np.int64)
    d.log_index = np.asarray(li, dtype=np.int64)
    d.sub = np.asarray(sub, dtype=np.int64)
    d.delta = np.asarray(delta, dtype=np.int64)
    d.scaled = np.asarray(scaled, dtype=np.int64)
    d.index = np.asarray(idx, dtype=object)
    d.index_f = np.asarray([float(x) / RAY for x in idx], dtype=np.float64)
    order = np.lexsort((d.sub, d.log_index, d.block))
    if not (order == np.arange(len(order))).all():
        for name in ("addr", "block", "log_index", "sub", "delta", "scaled", "index", "index_f"):
            setattr(d, name, getattr(d, name)[order])
    ctx._decoded[r] = d
    return d


def phase_decode(ctx: Ctx) -> None:
    out = {}
    for r in ctx.order:
        d = decode_reserve(ctx, r)
        out[r] = {"n_logs": d.n_logs, "by_type": d.counts, "other_known": d.other_known,
                  "unknown_topic0": d.unknown, "decode_errors": len(d.decode_errors),
                  "decode_error_examples": d.decode_errors[:10], "n_balance_rows": int(len(d.delta)),
                  "n_addresses_with_balance_rows": len(d.addrs), "upgraded_blocks": d.upgraded_blocks}
    ctx.state["decode"] = out
    ctx.save_state()
    print("DECODE " + json.dumps(out), flush=True)


# ---------------------------------------------------------------------------------------------
# Anchors (B.1 frozen and new) and the gate
# ---------------------------------------------------------------------------------------------


def check_b1_inputs(ctx: Ctx) -> dict:
    out = {}
    for name, want in B1_FILES_SHA256.items():
        got = B.sha256_file(ctx.ddir / B1_DIR / name)
        if got != want:
            raise B.TerminalError(f"{B1_DIR}/{name} sha256 {got} != {want}")
        out[f"{B1_DIR}/{name}"] = got
    return out


def b1_blocks(ctx: Ctx):
    """[(label, block, block_ts)] for the daily snapshots in order, and the asof row."""
    rows = list(csv.DictReader(open(ctx.ddir / B1_DIR / "blocks.csv")))
    daily = [(x["snapshot"], int(x["block"]), int(x["block_ts"])) for x in rows if x["kind"] == "daily"]
    asof = [(x["snapshot"], int(x["block"]), int(x["block_ts"])) for x in rows if x["kind"] == "asof"][0]
    return daily, asof


def load_anchor_matrix(path_or_rows, labels: list[str], decimals: int = 6):
    """Long anchors (snapshot, address, balance_raw, status) -> (addresses, A, valid) over `labels`;
    A in 6-decimal units."""
    import numpy as np
    import pandas as pd
    if isinstance(path_or_rows, (str, Path)):
        df = pd.read_csv(path_or_rows, dtype={"snapshot": str, "address": str, "balance_raw": str, "status": str},
                         keep_default_na=False)
    else:
        df = pd.DataFrame(path_or_rows, columns=["snapshot", "address", "balance_raw", "status"]).astype(str)
        df["status"] = df["status"].replace({"None": ""})
    lab_ix = {s: i for i, s in enumerate(labels)}
    df = df[df["snapshot"].isin(lab_ix)]
    addrs = sorted(df["address"].unique().tolist())
    a_ix = {a: i for i, a in enumerate(addrs)}
    A = np.zeros((len(addrs), len(labels)), dtype=np.int64)
    valid = np.zeros((len(addrs), len(labels)), dtype=bool)
    ok = (df["status"] == "") & (df["balance_raw"] != "")
    sub = df[ok]
    ri = sub["address"].map(a_ix).to_numpy().astype(np.int64)
    ci = sub["snapshot"].map(lab_ix).to_numpy().astype(np.int64)
    if decimals == 6:
        A[ri, ci] = sub["balance_raw"].astype("int64").to_numpy()
    else:
        A[ri, ci] = np.asarray([to_units(int(x), decimals) for x in sub["balance_raw"]], dtype=np.int64)
    valid[ri, ci] = True
    return addrs, A, valid


def events_for(d: Decoded, addrs: list[str]):
    """Balance rows of decoded reserve d restricted to `addrs`, re-indexed to positions in addrs."""
    import numpy as np
    m_map = np.full(len(d.addrs), -1, dtype=np.int64)
    pos = {a: i for i, a in enumerate(addrs)}
    for a, i in d.addr_ids.items():
        j = pos.get(a)
        if j is not None:
            m_map[i] = j
    new = m_map[d.addr] if len(d.addr) else np.zeros(0, dtype=np.int64)
    keep = new >= 0
    return new[keep], d.block[keep], d.delta[keep], d.scaled[keep].astype(np.float64), keep


D2_RULE = ("D2 (membrane-board 567955a): |anchor change - summed G.2 event change| <= max($10, 0.1% of "
           "max(anchor_d, anchor_d+1, intraday peak)); intraday peak = max of the G.2 path anchor_d + cumulative event "
           f"changes over the pair; pass iff share >= {GATE_SHARE} on all pairs AND on pairs holding >= 1 event")
REGISTERED_RULE = ("G.2 as registered: |anchor change - summed G.2 event change| <= max($10, 0.1% of the larger anchor); "
                   f"pass iff share >= {GATE_SHARE} on all pairs AND on pairs holding >= 1 event")


def _usd(x) -> float:
    return round(float(x) / 1e6, 2)


def _pair_row(G: dict, i: int, labels: list[str], tol_key: str) -> dict:
    p = int(G["p"][i])
    out = {"reserve": G["reserve"][i], "address": short_addr(G["address"][i]), "day": f"{labels[p]}→{labels[p + 1]}",
           "anchor0_usd": _usd(G["a0"][i]), "anchor1_usd": _usd(G["a1"][i]), "event_sum_usd": _usd(G["ev"][i]),
           "diff_usd": _usd(G["diff"][i]), "tol_usd": _usd(G[tol_key][i]), "intraday_peak_usd": _usd(G["peak"][i]),
           "n_events": int(G["n_ev"][i])}
    if "res_interest" in G:
        out["interest_adjusted_diff_usd"] = _usd(G["res_interest"][i])
    return out


def rule_section(G: dict, per_reserve: dict, labels: list[str], pass_key: str, tol_key: str, rule: str) -> dict:
    """Summary, per reserve and year, worst residuals and failure causes of one tolerance rule."""
    import numpy as np
    ok = G[pass_key]
    tol = G[tol_key]
    has = G["n_ev"] > 0
    pooled = gate_summary(G, pass_key)
    ratio = np.abs(G["diff"]).astype(np.float64) / tol.astype(np.float64)
    order = np.argsort(-ratio, kind="stable")
    worst = [dict(_pair_row(G, int(i), labels, tol_key), ratio=round(float(ratio[i]), 3), passes=bool(ok[i]))
             for i in order[:20]]
    seen, distinct = set(), []
    for i in order:
        k = (G["reserve"][i], G["address"][i])
        if k in seen:
            continue
        seen.add(k)
        distinct.append(dict(_pair_row(G, int(i), labels, tol_key), ratio=round(float(ratio[i]), 3), passes=bool(ok[i])))
        if len(distinct) == 20:
            break
    fail = ~ok
    causes = {"n_fail": int(fail.sum())}
    if "res_interest" in G:
        res_ok = np.abs(G["res_interest"]) <= tol
        causes.update({
            "interest_explained": int((fail & res_ok).sum()),
            "no_balance_event_unexplained": int((fail & ~res_ok & ~has).sum()),
            "with_events_unexplained": int((fail & ~res_ok & has).sum()),
            "rule": ("interest_explained: |a1 - (a0/I0 + sum(scaled deltas)) * I1| <= the rule's tolerance, I = normalized "
                     "income at the snapshot block from reserve state (diagnostic; the gate ignores interest per G.2)")})
    if fail.any():
        floor = tol == GATE_ABS_RAW
        causes["fail_both_anchors_zero"] = int((fail & (G["a0"] == 0) & (G["a1"] == 0)).sum())
        causes["fail_tol_at_10usd_floor"] = int((fail & floor).sum())
        pk = G["peak"][fail].astype(np.float64)
        causes["fail_intraday_peak_usd_quantiles"] = {str(q): _usd(np.quantile(pk, q)) for q in (0.1, 0.5, 0.9)}
        causes["fail_abs_diff_over_intraday_peak_quantiles"] = {
            str(q): float(np.quantile(np.abs(G["diff"][fail]) / np.maximum(pk, 1.0), q)) for q in (0.1, 0.5, 0.9, 1.0)}
        causes["fail_abs_diff_usd_quantiles"] = {str(q): _usd(np.quantile(np.abs(G["diff"][fail]), q))
                                                 for q in (0.5, 0.9, 0.99, 1.0)}
        fa, days = {}, {}
        for i in np.nonzero(fail)[0]:
            k = f"{G['reserve'][i]} {short_addr(G['address'][i])}"
            fa[k] = fa.get(k, 0) + 1
            dk = f"{G['reserve'][i]} {labels[int(G['p'][i])]}"
            days[dk] = days.get(dk, 0) + 1
        causes["fail_n_distinct_addresses"] = len(fa)
        causes["fail_by_address_top10"] = sorted(fa.items(), key=lambda x: -x[1])[:10]
        causes["fail_by_day_top"] = sorted(days.items(), key=lambda x: -x[1])[:20]
    by_year = {}
    yrs = np.asarray([labels[int(p)][:4] for p in G["p"]]) if len(G["p"]) else np.zeros(0, dtype=str)
    for y in sorted(set(yrs.tolist())):
        mm = yrs == y
        me = mm & has
        by_year[y] = {"n_pairs": int(mm.sum()), "share_pass": float(ok[mm].mean()), "n_pairs_with_event": int(me.sum()),
                      "share_pass_with_event": float(ok[me].mean()) if me.any() else None}
    return {"rule": rule, "pooled": pooled, "per_reserve": per_reserve, "passes": pooled["passes"],
            "by_year": by_year, "worst20_by_diff_over_tol": worst, "worst20_distinct_addresses": distinct,
            "failure_causes": causes}


def run_gate(ctx: Ctx, which: str, anchors: dict[str, tuple], labels: list[str], blocks: list[int],
             incomes: dict[str, list[float]]) -> dict:
    """anchors[r] = (addrs, A, valid) over daily labels (6-decimal units); the gate on every
    consecutive daily pair. The verdict is deviation D2; the registered rule is reported beside it."""
    import numpy as np
    per_reg, per_d2, allrows = {}, {}, []
    for r in ctx.order:
        addrs, A, valid = anchors[r]
        d = decode_reserve(ctx, r)
        ea, eb, ed, es, _ = events_for(d, addrs)
        g = gate_pairs(A, valid, blocks, ea, eb, ed, ev_scaled=es, income=incomes[r])
        per_reg[r] = gate_summary(g, "pass")
        per_d2[r] = gate_summary(g, "pass_d2")
        g["reserve"] = np.full(len(g["pass"]), r, dtype=object)
        g["address"] = np.asarray(addrs, dtype=object)[g["addr"]] if len(g["addr"]) else np.zeros(0, dtype=object)
        allrows.append(g)
    keys = ["reserve", "address", "p", "a0", "a1", "ev", "n_ev", "diff", "tol", "pass", "peak", "tol_d2", "pass_d2",
            "res_interest"]
    G = {k: np.concatenate([g[k] for g in allrows]) for k in keys}
    reg = rule_section(G, per_reg, labels, "pass", "tol", REGISTERED_RULE)
    reg["status"] = "passed" if reg["passes"] else "failed"
    d2 = rule_section(G, per_d2, labels, "pass_d2", "tol_d2", D2_RULE)
    has = G["n_ev"] > 0
    alt = np.abs(G["res_interest"]) <= G["tol"]
    exact = np.abs(G["diff"]) <= 1000  # within 0.001 USD
    return {"which": which, "verdict_rule": "D2", "passes": d2["passes"], "pooled": d2["pooled"],
            "per_reserve": d2["per_reserve"],
            "event_definition": "a Mint (onBehalfOf), Burn (from) or BalanceTransfer (from or to) log naming the address, "
                                "in block (B_d, B_d+1]",
            "units": "6-decimal units of the token (1e-6 token), counted as USD",
            "d2": d2, "registered_rule": reg,
            "share_within_0.001usd": float(exact.mean()) if len(exact) else None,
            "diagnostics_not_gate": {
                "note": "diagnostic only",
                "interest_adjusted_residual": {
                    "share_pass": float(alt.mean()) if len(alt) else None,
                    "share_pass_with_event": float(alt[has].mean()) if has.any() else None,
                    "rule": "|a1 - (a0/I0 + sum(scaled deltas)) * I1| <= max($10, 0.1% of max(a0, a1))"}}}


def b1_reserve_rows(ctx: Ctx) -> list[dict]:
    return list(csv.DictReader(open(ctx.ddir / B1_DIR / "reserve-state.csv")))


def income_from_rows(rows, order) -> dict[str, dict[str, float]]:
    """Normalized income (ray / 1e27) per reserve and snapshot from reserve-state rows."""
    out: dict[str, dict[str, float]] = {r: {} for r in order}
    for x in rows:
        if x.get("reserve") in out and x.get("liquidityIndex") not in ("", None) and x.get("liquidityRate_ray") not in ("", None) \
                and x.get("lastUpdateTimestamp") not in ("", None):
            inc = normalized_income(int(x["liquidityIndex"]), int(x["liquidityRate_ray"]), int(x["lastUpdateTimestamp"]),
                                    int(x["block_ts"]))
            if inc:
                out[x["reserve"]][x["snapshot"]] = inc / RAY
    return out


def anchored_income(ctx: Ctx, labels: list[str]) -> dict[str, list[float]]:
    rows = b1_reserve_rows(ctx) if ctx.mode == "main" else rstate_rows(ctx)
    inc = income_from_rows(rows, ctx.order)
    return {r: [inc[r].get(s) or float("nan") for s in labels] for r in ctx.order}


def b1_daily_path(ctx: Ctx, r: str) -> Path:
    return ctx.ddir / B1_DIR / f"daily-balances-{r.lower()}.csv.gz"


def phase_gate(ctx: Ctx) -> dict:
    ctx.state["b1_inputs"] = check_b1_inputs(ctx)
    daily, asof = b1_blocks(ctx)
    labels = [s for s, _, _ in daily]
    blocks = [b for _, b, _ in daily]
    anchors = {r: load_anchor_matrix(b1_daily_path(ctx, r), labels) for r in ctx.order}
    rep = run_gate(ctx, "P_r (depositor-balances daily anchors)", anchors, labels, blocks, anchored_income(ctx, labels))
    rep["asof_pair_info"] = asof_pair_info(ctx, daily, asof, {r: (b1_daily_path(ctx, r), 6) for r in ctx.order})
    rep["reconstruction_checks"] = reconstruction_checks(ctx, b1_asof_anchors(ctx))
    ctx.state["gate"] = rep
    ctx.save_state()
    print("GATE " + json.dumps({"verdict": "D2", "d2": rep["pooled"], "registered": rep["registered_rule"]["pooled"],
                                "passes": rep["passes"]}), flush=True)
    return rep


def asof_pair_info(ctx: Ctx, daily, asof, sources: dict) -> dict:
    """The multi-day pair (last daily snapshot -> B.1 asof block), reported, not in the gate."""
    labels = [daily[-1][0], "asof"]
    blocks = [daily[-1][1], asof[1]]
    out = {}
    for r in ctx.order:
        src, dec = sources[r]
        addrs, A, valid = load_anchor_matrix(src, labels, dec)
        d = decode_reserve(ctx, r)
        ea, eb, ed, es, _ = events_for(d, addrs)
        g = gate_pairs(A, valid, blocks, ea, eb, ed)
        out[r] = {"registered": gate_summary(g, "pass"), "d2": gate_summary(g, "pass_d2")}
    out["note"] = f"pair {labels[0]} -> asof (block {asof[1]}); spans several days, not part of the gate"
    return out


def recon_scaled_at(d: Decoded, block: int):
    """Event-reconstructed scaled balance (6-decimal units) per address id after all events with block <= `block`."""
    import numpy as np
    m = d.block <= block
    out = np.zeros(len(d.addrs), dtype=np.int64)
    np.add.at(out, d.addr[m], d.scaled[m])
    return out


def b1_asof_anchors(ctx: Ctx) -> dict[str, dict[str, int]]:
    out = {}
    for r in ctx.order:
        addrs, A, valid = load_anchor_matrix(b1_daily_path(ctx, r), ["asof"])
        out[r] = {a: int(A[i, 0]) for i, a in enumerate(addrs) if valid[i, 0]}
    return out


def reconstruction_checks(ctx: Ctx, asof_anchors: dict[str, dict[str, int]]) -> dict:
    """Data checks of the full reconstruction (from zero at deployment), in 6-decimal units: the sum
    of scaled balances vs scaledTotalSupply at both asof blocks, and per-address balance vs the anchors
    at the B.1 asof block (asof_anchors[r] = {address: units})."""
    import numpy as np
    out = {}
    refs = ctx.state["refs"]
    for r in ctx.order:
        d = decode_reserve(ctx, r)
        dec = ctx.dec(r)
        o = {"units": "1e-6 token"}
        for lab in ("b1_asof", "asof"):
            blk = refs[lab]["block"]
            sc = recon_scaled_at(d, blk)
            sts = to_units(int(refs[lab]["reads"][r]["scaledTotalSupply"]), dec)
            tot = int(sc.sum())
            o[lab] = {"block": blk, "recon_sum_scaled_units": str(tot), "scaledTotalSupply_units": str(sts),
                      "diff_units": str(tot - sts), "rel_diff": (tot - sts) / sts if sts else None,
                      "n_negative_below_minus_1usd": int((sc < -10**6).sum())}
        inc = int(refs["b1_asof"]["reads"][r]["normalizedIncome"])
        sc = recon_scaled_at(d, refs["b1_asof"]["block"])
        dd, aa = [], []
        for a, v in asof_anchors.get(r, {}).items():
            j = d.addr_ids.get(a)
            rb = ray_mul(int(sc[j]), inc) if j is not None else 0
            dd.append(rb - v)
            aa.append(v)
        dd = np.asarray(dd, dtype=np.int64)
        aa = np.asarray(aa, dtype=np.int64)
        o["per_address_vs_asof_anchor"] = {
            "block": refs["b1_asof"]["block"], "n": int(len(dd)), "n_within_10_units": int((np.abs(dd) <= 10).sum()),
            "n_within_gate_tol": int(gate_tolerance_pass(aa, aa, dd).sum()) if len(dd) else 0,
            "max_abs_diff_usd": float(np.abs(dd).max()) / 1e6 if len(dd) else None}
        out[r] = o
    return out


# ---------------------------------------------------------------------------------------------
# Phase: universe
# ---------------------------------------------------------------------------------------------


def balance_maxima(d: Decoded, asof_block: int, asof_income: int):
    """Per address id: max event-reconstructed balance (6-decimal units, exact integer ray math) over
    every moment, with its block.

    Scaled balance s changes only at events; between events the balance s * I(t) grows with the
    index, so the maximum over an interval is at its end. Candidates: s before and after each
    event times the index of that event, and the final s times the income at the asof block."""
    import numpy as np
    n = len(d.addrs)
    if len(d.addr) == 0:
        return np.zeros(n, dtype=object), np.zeros(n, dtype=np.int64), np.zeros(n, dtype=np.int64)
    m = d.block <= asof_block
    pos_m = np.nonzero(m)[0]
    addr, sc, idxf, blk = d.addr[m], d.scaled[m], d.index_f[m], d.block[m]
    order = np.argsort(addr, kind="stable")  # rows already in (block, log, sub) order
    a_s, s_s, i_s, b_s = addr[order], sc[order], idxf[order], blk[order]
    starts = np.r_[0, np.nonzero(np.diff(a_s))[0] + 1]
    cs = np.cumsum(s_s)  # int64 wrap-around cancels in the difference below
    seg_base = np.repeat(cs[starts] - s_s[starts], np.diff(np.r_[starts, len(a_s)]))
    after = cs - seg_base
    before = after - s_s
    s_max = np.maximum(before, after)
    cand = s_max.astype(np.float64) * i_s  # float picks the row; the value is then recomputed exactly
    best_blk = np.zeros(n, dtype=np.int64)
    seg_id = np.repeat(np.arange(len(starts)), np.diff(np.r_[starts, len(a_s)]))
    ord2 = np.lexsort((-cand, seg_id))
    first = np.r_[0, np.nonzero(np.diff(seg_id[ord2]))[0] + 1]
    rows = ord2[first]
    best = np.zeros(n, dtype=object)
    for rr in rows:
        a = int(a_s[rr])
        best[a] = ray_mul(int(s_max[rr]), int(d.index[pos_m[order[rr]]]))
        best_blk[a] = b_s[rr]
    final = np.zeros(n, dtype=np.int64)
    np.add.at(final, addr, sc)
    for a in range(n):
        fb = ray_mul(int(final[a]), asof_income)
        if fb > best[a]:
            best[a] = fb
            best_blk[a] = asof_block
    return best, best_blk, final


def first_event(d: Decoded):
    import numpy as np
    n = len(d.addrs)
    fb = np.full(n, np.iinfo(np.int64).max, dtype=np.int64)
    np.minimum.at(fb, d.addr, d.block)
    cnt = np.zeros(n, dtype=np.int64)
    np.add.at(cnt, d.addr, 1)
    return fb, cnt


def b1_population(ctx: Ctx) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {r: {} for r in ctx.order}
    if ctx.mode != "main":
        return out  # holdout reserves have no P_r: every universe address is new
    for x in csv.DictReader(open(ctx.ddir / B1_DIR / "panel-population.csv")):
        out[x["reserve"]][x["address"]] = x["rule"]
    return out


def phase_universe(ctx: Ctx) -> None:
    import numpy as np
    if ctx.mode == "main":
        gate = ctx.state.get("gate")
        if not gate or not gate.get("passes"):
            raise B.TerminalError("universe needs a passed gate")
    asof = ctx.state["asof"]["block"]
    tsl = ts_lookup(ctx)
    pop = b1_population(ctx)
    uni = {}
    for r in ctx.order:
        d = decode_reserve(ctx, r)
        dec = ctx.dec(r)
        inc = int(ctx.state["refs"]["asof"]["reads"][r]["normalizedIncome"])
        best, best_blk, final = balance_maxima(d, asof, inc)
        fb, cnt = first_event(d)
        rows = []
        reach = np.asarray([int(b) >= THRESHOLD_RAW for b in best], dtype=bool)
        members = set(int(i) for i in reach.nonzero()[0])
        for a in pop[r]:
            if a in d.addr_ids:
                members.add(d.addr_ids[a])
        pr_missing = [a for a in pop[r] if a not in d.addr_ids]
        for i in sorted(members, key=lambda i: d.addrs[i]):
            a = d.addrs[i]
            fbi = int(fb[i])
            rows.append({"address": a, "in_P_r": int(a in pop[r]), "P_r_rule": pop[r].get(a, ""),
                         "reaches_1M_by_events": int(bool(reach[i])), "new": int(bool(reach[i]) and a not in pop[r]),
                         "max_event_balance_raw": from_units(int(best[i]), dec), "max_at_block": int(best_blk[i]),
                         "recon_balance_asof_raw": from_units(ray_mul(int(final[i]), inc), dec),
                         "first_event_block": fbi, "first_event_utc": B.iso_utc(tsl[fbi]),
                         "n_balance_events": int(cnt[i])})
        for a in pr_missing:
            rows.append({"address": a, "in_P_r": 1, "P_r_rule": pop[r][a], "reaches_1M_by_events": 0, "new": 0,
                         "max_event_balance_raw": 0, "max_at_block": "", "recon_balance_asof_raw": 0,
                         "first_event_block": "", "first_event_utc": "", "n_balance_events": 0})
        rows.sort(key=lambda x: x["address"])
        uni[r] = {"rows": rows, "n_rule": int(reach.sum()), "n_new": sum(x["new"] for x in rows),
                  "n_P_r": len(pop[r]), "n_P_r_reaching": sum(1 for x in rows if x["in_P_r"] and x["reaches_1M_by_events"]),
                  "n_P_r_not_reaching": sum(1 for x in rows if x["in_P_r"] and not x["reaches_1M_by_events"]),
                  "n_P_r_without_events": len(pr_missing), "n_file": len(rows),
                  "n_addresses_with_events": len(d.addrs)}
        print(f"UNIVERSE {r}: " + json.dumps({k: v for k, v in uni[r].items() if k != "rows"}), flush=True)
    ctx.state["universe"] = uni
    ctx.save_state()


# ---------------------------------------------------------------------------------------------
# Phase: anchors (new addresses)
# ---------------------------------------------------------------------------------------------


def new_anchor_plan(ctx: Ctx):
    """Per reserve: snapshots [(label, block)] and per snapshot the sorted new addresses that are due."""
    daily, b1asof = b1_blocks(ctx)
    asof = ctx.state["asof"]
    plan = {}
    for r in ctx.order:
        rows = [x for x in ctx.state["universe"][r]["rows"] if x["new"]]
        first_day = {x["address"]: x["first_event_utc"][:10] for x in rows}
        start = {a: max(fd, daily[0][0]) for a, fd in first_day.items()}
        snaps = []
        for s, b, _ in daily:
            due = sorted(a for a, st in start.items() if st <= s)
            if due:
                snaps.append((s, b, due))
        allnew = sorted(first_day)
        if allnew:
            snaps.append(("asof", b1asof[1], allnew))
            snaps.append(("asof_events", asof["block"], allnew))
        plan[r] = {"snaps": snaps, "start": start}
    return plan


def phase_anchors(ctx: Ctx) -> None:
    plan = new_anchor_plan(ctx)
    tasks = []
    for r in ctx.order:
        for s, b, due in plan[r]["snaps"]:
            for ci, ch in enumerate(B.chunk(due)):
                rec = ctx.anchor_store.get((s, r, ci))
                if rec is None or rec["first"] != ch[0] or rec["n"] != len(ch) or rec["block"] != b:
                    tasks.append((s, b, r, ci, ch))
    print(f"anchors: {len(tasks)} multicall requests to do", flush=True)

    def do(task):
        s, b, r, ci, addrs = task
        if ctx.rpc.stop.is_set():
            raise B.TerminalError("stopped")
        at = ctx.reserves[r]["atoken"]
        res = ctx.rpc.multicall([(at, B.call_data("balanceOf", a)) for a in addrs], b, "anchors",
                                tag=f"anchors {s} {r} {ci}")
        ctx.anchor_store.put((s, r, ci), {"block": b, "first": addrs[0], "n": len(addrs),
                                          "v": [B.balance_entry(ok, ret) for ok, ret in res]})

    B.run_pool(ctx, "anchors", tasks, do)


def new_anchor_rows(ctx: Ctx, r: str, plan) -> list[list]:
    """Long rows (snapshot, address, balance_raw, status), sorted by address then snapshot order."""
    by_addr: dict[str, list] = {}
    order = {}
    for k, (s, b, due) in enumerate(plan[r]["snaps"]):
        order[s] = k
        for ci, ch in enumerate(B.chunk(due)):
            rec = ctx.anchor_store.get((s, r, ci))
            if rec is None:
                raise B.TerminalError(f"anchor chunk missing {s} {r} {ci}")
            if rec["first"] != ch[0] or rec["n"] != len(ch) or rec["block"] != b:
                raise B.TerminalError(f"anchor chunk layout changed {s} {r} {ci}")
            for a, v in zip(ch, rec["v"]):
                by_addr.setdefault(a, []).append([s, a, v, ""] if isinstance(v, int) else [s, a, "", v])
    out = []
    for a in sorted(by_addr):
        out += sorted(by_addr[a], key=lambda x: order[x[0]])
    return out


def phase_gate_new(ctx: Ctx) -> dict:
    daily, b1asof = b1_blocks(ctx)
    labels = [s for s, _, _ in daily]
    blocks = [b for _, b, _ in daily]
    plan = new_anchor_plan(ctx)
    rows_by = {r: new_anchor_rows(ctx, r, plan) for r in ctx.order}
    anchors = {r: load_anchor_matrix(rows_by[r], labels, ctx.dec(r)) for r in ctx.order}
    which = ("new addresses (depositor-events daily-balances-ext anchors)" if ctx.mode == "main"
             else "holdout universe (daily-balances anchors)")
    rep = run_gate(ctx, which, anchors, labels, blocks, anchored_income(ctx, labels))
    rep["asof_pair_info"] = asof_pair_info(ctx, daily, b1asof, {r: (rows_by[r], ctx.dec(r)) for r in ctx.order})
    if ctx.mode != "main":
        asof_anch = {r: {x[1]: to_units(x[2], ctx.dec(r)) for x in rows_by[r] if x[0] == "asof" and isinstance(x[2], int)}
                     for r in ctx.order}
        rep["reconstruction_checks"] = reconstruction_checks(ctx, asof_anch)
    desc = {}
    for r in ctx.order:
        rows = rows_by[r]
        big = {x[1] for x in rows if isinstance(x[2], int) and to_units(x[2], ctx.dec(r)) >= THRESHOLD_RAW
               and x[0] not in ("asof", "asof_events")}
        desc[r] = {"n_new": len(plan[r]["start"]), "n_with_daily_anchor_ge_1M": len(big),
                   "n_rows": len(rows), "n_non_ok": sum(1 for x in rows if x[3])}
    rep["new_anchor_summary"] = desc
    ctx.state["gate_new"] = rep
    ctx.save_state()
    print("GATE_NEW " + json.dumps({"d2": rep["pooled"], "registered": rep["registered_rule"]["pooled"],
                                    "passes": rep["passes"], "summary": desc}), flush=True)
    return rep


def coverage(ctx: Ctx) -> dict:
    """Share of aToken totalSupply held by the universe: anchored balances at the B.1 asof block
    (P_r from depositor-balances, new addresses from the new anchors), anchored new-address balances
    at this asof, and event-reconstructed balances at this asof."""
    plan = new_anchor_plan(ctx)
    refs = ctx.state["refs"]
    pr_all = b1_asof_anchors(ctx) if ctx.mode == "main" else {r: {} for r in ctx.order}
    out = {}
    for r in ctx.order:
        dec = ctx.dec(r)
        rows_new = new_anchor_rows(ctx, r, plan)
        pr = {a: from_units(v, dec) for a, v in pr_all[r].items()}
        new_b1 = {x[1]: x[2] for x in rows_new if x[0] == "asof" and isinstance(x[2], int)}
        new_ev = {x[1]: x[2] for x in rows_new if x[0] == "asof_events" and isinstance(x[2], int)}
        urows = ctx.state["universe"][r]["rows"]
        rule = {x["address"] for x in urows if x["reaches_1M_by_events"]}
        ts_b1 = int(refs["b1_asof"]["reads"][r]["totalSupply"])
        ts_ev = int(refs["asof"]["reads"][r]["totalSupply"])
        s_pr, s_new = sum(pr.values()), sum(new_b1.values())
        s_rule = sum(pr.get(a, 0) for a in rule) + sum(v for a, v in new_b1.items() if a in rule)
        recon_univ = sum(x["recon_balance_asof_raw"] for x in urows)
        recon_rule = sum(x["recon_balance_asof_raw"] for x in urows if x["reaches_1M_by_events"])
        out[r] = {"b1_asof": {"block": refs["b1_asof"]["block"], "totalSupply_raw": str(ts_b1),
                              "P_r_share": s_pr / ts_b1, "new_share": s_new / ts_b1,
                              "universe_share(P_r+new)": (s_pr + s_new) / ts_b1, "rule_members_share": s_rule / ts_b1},
                  "asof": {"block": refs["asof"]["block"], "totalSupply_raw": str(ts_ev),
                           "new_anchored_share": sum(new_ev.values()) / ts_ev,
                           "universe_share_reconstructed": recon_univ / ts_ev,
                           "rule_members_share_reconstructed": recon_rule / ts_ev}}
    return out


# ---------------------------------------------------------------------------------------------
# Holdout reserves (deviation D1): mechanical selection and daily reserve state
# ---------------------------------------------------------------------------------------------

PEG_BAND = (0.98, 1.02)
HOLDOUT_MIN_SUPPLY_USD = 50_000_000
HOLDOUT_MIN_LISTED_DAYS = 365
PEG_RULE = ("USD-pegged = the Aave oracle price (PoolAddressesProvider.getPriceOracle().getAssetPrice(asset) / "
            "BASE_CURRENCY_UNIT, USD) lies within [0.98, 1.02] at the asof block AND at every monthly 00:00Z snapshot "
            "(1st of the month, depositor-balances blocks.csv) in the 365 days before the asof; a price read that fails "
            "in a month when the reserve was listed fails the rule. Fixed before the reserve list was read.")
SELECT_RULE = ("holdout = Pool.getReservesList() member at the asof block, not USDC/USDT, USD-pegged (above), aToken "
               "totalSupply x oracle price >= $50,000,000 at the asof block, and listed >= 365 days before the asof "
               "(listing = the aToken deployment block, eth_getCode bisection)")


def decode_address_array(ret: bytes) -> list[str]:
    """ABI address[] return value."""
    off = B._word(ret, 0)
    n = B._word(ret, off)
    return [B.word_to_address(B._word(ret, off + 32 * (i + 1))) for i in range(n)]


def decode_symbol(ok: bool, ret: bytes) -> str:
    """ERC-20 symbol(): ABI string, or bytes32 for old tokens."""
    if not ok or not ret:
        return ""
    if len(ret) == 32:
        return ret.rstrip(b"\x00").decode("utf-8", "replace")
    try:
        off = B._word(ret, 0)
        ln = B._word(ret, off)
        return ret[off + 32:off + 32 + ln].decode("utf-8", "replace")
    except B.DecodeError:
        return ""


def peg_ok(prices: list) -> bool:
    """prices: USD floats, None for a failed read in a listed month."""
    return bool(prices) and all(p is not None and PEG_BAND[0] <= p <= PEG_BAND[1] for p in prices)


def safe_name(sym: str) -> str:
    import re
    return re.sub(r"[^A-Za-z0-9_-]", "_", sym) or "UNKNOWN"


def select_holdouts(cands: list[dict], asof_ts: int, exclude: set[str]) -> list[dict]:
    """Annotate candidate rows (pure). Each row needs asset, price_asof_usd, monthly_prices (listed months),
    supply_usd, listing_ts."""
    for c in cands:
        reasons = []
        if c["asset"] in exclude:
            reasons.append("USDC/USDT")
        c["pegged"] = peg_ok([c["price_asof_usd"]] + c["monthly_prices"])
        if not c["pegged"]:
            reasons.append("not USD-pegged")
        c["supply_ok"] = c["supply_usd"] is not None and c["supply_usd"] >= HOLDOUT_MIN_SUPPLY_USD
        if not c["supply_ok"]:
            reasons.append("supply < $50M")
        c["listed_days"] = (asof_ts - c["listing_ts"]) / 86400 if c.get("listing_ts") else None
        c["listed_ok"] = c["listed_days"] is not None and c["listed_days"] >= HOLDOUT_MIN_LISTED_DAYS
        if not c["listed_ok"]:
            reasons.append("listed < 365 days")
        c["selected"] = not reasons
        c["reason"] = "; ".join(reasons) if reasons else "selected"
    return cands


def b1_monthly_blocks(ctx: Ctx) -> list[tuple[str, int, int]]:
    rows = list(csv.DictReader(open(ctx.ddir / B1_DIR / "blocks.csv")))
    return [(x["snapshot"], int(x["block"]), int(x["T"])) for x in rows if x["kind"] == "daily" and x["monthly"] == "1"]


def phase_select(ctx: Ctx, main_state: dict) -> None:
    st = ctx.state
    if st.get("holdouts", {}).get("done"):
        ctx.set_reserves(st["holdouts"]["reserves"])
        return
    rpc = ctx.rpc
    st.setdefault("asof", main_state["asof"])
    st.setdefault("asof_crosscheck", main_state.get("asof_crosscheck"))
    st.setdefault("signatures", check_signatures())
    st["b1_inputs"] = check_b1_inputs(ctx)
    asof, asof_ts = st["asof"]["block"], st["asof"]["ts"]
    sel_st = st.setdefault("select", {})
    ec = lambda to, data, blk, tag: rpc.eth_call(to, data, blk, "select", tag=tag)  # noqa: E731
    if "assets" not in sel_st:
        sel_st["assets"] = decode_address_array(ec(POOL, sel("getReservesList()"), asof, "reservesList"))
        sel_st["provider"] = B.word_to_address(B.decode_uint(ec(POOL, sel("ADDRESSES_PROVIDER()"), asof, "provider")))
        ctx.save_state()
    assets, provider = sel_st["assets"], sel_st["provider"]

    def oracle_at(blk):
        return B.word_to_address(B.decode_uint(ec(provider, sel("getPriceOracle()"), blk, f"oracle {blk}")))

    if "info" not in sel_st:
        oracle = oracle_at(asof)
        base = B.decode_uint(ec(oracle, sel("BASE_CURRENCY_UNIT()"), asof, "base unit"))
        calls = []
        for a in assets:
            calls += [(POOL, B.call_data("getReserveData", a)), (a, sel("symbol()")), (a, sel("decimals()")),
                      (oracle, sel("getAssetPrice(address)") + B.enc_address(a))]
        res = []
        for ch in B.chunk(calls):
            res += rpc.multicall(ch, asof, "select", tag="reserve info")
        info = {}
        for i, a in enumerate(assets):
            rd = B.decode_reserve_data(*res[4 * i])
            ok_d, ret_d = res[4 * i + 2]
            ok_p, ret_p = res[4 * i + 3]
            info[a] = {"symbol": decode_symbol(*res[4 * i + 1]),
                       "decimals": B.decode_uint(ret_d) if ok_d and len(ret_d) == 32 else None,
                       "aToken": rd.get("aTokenAddress"), "rd_status": rd["status"],
                       "price_asof_raw": B.decode_uint(ret_p) if ok_p and len(ret_p) == 32 else None}
        ts_calls = [(info[a]["aToken"], sel("totalSupply()")) for a in assets]
        ts_res = rpc.multicall(ts_calls, asof, "select", tag="aToken supply")
        for a, (ok, ret) in zip(assets, ts_res):
            info[a]["totalSupply_raw"] = B.decode_uint(ret) if ok and len(ret) == 32 else None
        sel_st.update({"info": info, "oracle_asof": oracle, "base_unit": base})
        ctx.save_state()
    info, base = sel_st["info"], sel_st["base_unit"]
    listing = sel_st.setdefault("listing", {})
    for a in assets:
        if a in listing or not info[a]["aToken"] or info[a]["aToken"] == B.ZERO_ADDRESS:
            continue
        at = info[a]["aToken"]
        cache: dict[int, bool] = {}

        def has_code(b, at=at, cache=cache):
            if b not in cache:
                cache[b] = eth_get_code_len(ctx, at, b) > 0
            return cache[b]

        blk = find_deploy_block(has_code, DEPLOY_SEARCH_LO, asof)
        bo = rpc.block_obj(blk, "select")
        listing[a] = {"block": blk, "ts": int(bo["timestamp"], 16)}
        ctx.save_state()
    monthly = [(s, b, T) for s, b, T in b1_monthly_blocks(ctx) if asof_ts - 365 * 86400 < T <= asof_ts]
    mp = sel_st.setdefault("monthly_prices", {})
    for s, b, _ in monthly:
        if s in mp:
            continue
        orc = oracle_at(b)
        res = rpc.multicall([(orc, sel("getAssetPrice(address)") + B.enc_address(a)) for a in assets], b, "select",
                            tag=f"prices {s}")
        mp[s] = {"block": b, "oracle": orc,
                 "prices": {a: (B.decode_uint(ret) if ok and len(ret) == 32 else None) for a, (ok, ret) in zip(assets, res)}}
        ctx.save_state()
    cands = []
    for a in assets:
        x = info[a]
        lst = listing.get(a)
        p0 = x["price_asof_raw"] / base if x["price_asof_raw"] is not None else None
        mprices = []
        for s, b, _ in monthly:
            if lst and b >= lst["block"]:
                v = mp[s]["prices"].get(a)
                mprices.append(v / base if v is not None else None)
        supply_usd = (x["totalSupply_raw"] / 10 ** x["decimals"] * p0
                      if x["totalSupply_raw"] is not None and x["decimals"] is not None and p0 is not None else None)
        cands.append({"asset": a, "symbol": x["symbol"], "decimals": x["decimals"], "aToken": x["aToken"],
                      "price_asof_usd": p0, "monthly_prices": mprices,
                      "monthly_min": min([v for v in mprices if v is not None], default=None),
                      "monthly_max": max([v for v in mprices if v is not None], default=None),
                      "n_monthly_listed": len(mprices), "n_monthly_failed": sum(1 for v in mprices if v is None),
                      "totalSupply_raw": x["totalSupply_raw"], "supply_usd": supply_usd,
                      "listing_block": lst["block"] if lst else None, "listing_ts": lst["ts"] if lst else None,
                      "listing_utc": B.iso_utc(lst["ts"]) if lst else ""})
    exclude = {norm_address_safe(RESERVES[r]["asset"]) for r in RESERVE_ORDER}
    select_holdouts(cands, asof_ts, exclude)
    chosen = [c for c in cands if c["selected"]]
    if any((c["decimals"] or 0) < 1 for c in chosen):
        raise B.TerminalError("holdout with unknown decimals")
    reserves = {}
    for c in sorted(chosen, key=lambda c: -c["supply_usd"]):
        name = safe_name(c["symbol"])
        while name in reserves:
            name += "_"
        reserves[name] = {"asset": c["asset"], "atoken": c["aToken"], "decimals": c["decimals"], "symbol": c["symbol"]}
    st["deploy"] = {n: {"block": listing[v["asset"]]["block"], "ts": listing[v["asset"]]["ts"],
                        "utc": B.iso_utc(listing[v["asset"]]["ts"]),
                        "rule": "smallest block whose post-state has code at the aToken address (eth_getCode bisection)"}
                    for n, v in reserves.items()}
    st["holdouts"] = {"peg_rule": PEG_RULE, "select_rule": SELECT_RULE, "provider": provider,
                      "oracle_asof": sel_st["oracle_asof"], "base_unit": base,
                      "monthly_snapshots": [s for s, _, _ in monthly], "candidates": cands,
                      "reserves": reserves, "done": True}
    ctx.set_reserves(reserves)
    st["refs"] = {lab: {"block": blk, "reads": ref_reads(ctx, blk) if reserves else {}}
                  for lab, blk in (("b1_asof", B1_ASOF_BLOCK), ("asof", asof))}
    ctx.save_state()
    print("HOLDOUTS " + json.dumps({"selected": reserves, "n_candidates": len(cands)}), flush=True)


def norm_address_safe(a: str) -> str:
    return B.norm_address(a)


RSTATE_KEYS = ("rd", "aTotalSupply", "cash")


def rstate_snapshots(ctx: Ctx) -> list[tuple[str, int, int]]:
    daily, b1asof = b1_blocks(ctx)
    a = ctx.state["asof"]
    return list(daily) + [("asof", b1asof[1], b1asof[2]), ("asof_events", a["block"], a["ts"])]


def phase_rstate(ctx: Ctx) -> None:
    """Daily reserve state of the holdout reserves at the depositor-balances snapshot blocks plus both
    asof blocks (B.1 method: getReserveData, aToken totalSupply, cash, variableDebt totalSupply,
    curve by both strategy ABIs)."""
    store = B.JsonlStore(ctx.work / "rstate.jsonl")
    todo = [x for x in rstate_snapshots(ctx) if not store.has(x[0])]
    print(f"rstate: {len(todo)} snapshots to do", flush=True)

    def do(task):
        s, blk, ts = task
        if ctx.rpc.stop.is_set():
            raise B.TerminalError("stopped")
        lead = []
        for r in ctx.order:
            a, at = ctx.reserves[r]["asset"], ctx.reserves[r]["atoken"]
            lead += [(POOL, B.call_data("getReserveData", a)), (at, B.call_data("totalSupply")),
                     (a, B.call_data("balanceOf", at))]
        res = ctx.rpc.multicall(lead, blk, "rstate", tag=f"rstate {s} lead")
        dep_labels, dep_calls = [], []
        for k, r in enumerate(ctx.order):
            rd = B.decode_reserve_data(*res[3 * k])
            if rd.get("status") != "ok" or not rd.get("listed"):
                continue
            vdt, strat = rd["variableDebtTokenAddress"], rd["interestRateStrategyAddress"]
            if vdt != B.ZERO_ADDRESS:
                dep_labels.append(["vd", r, vdt])
                dep_calls.append((vdt, B.call_data("totalSupply")))
            if strat != B.ZERO_ADDRESS:
                for nm in B.V1_CURVE:
                    dep_labels.append(["v1", r, strat, nm])
                    dep_calls.append((strat, B.call_data(nm)))
                dep_labels.append(["v2", r, strat])
                dep_calls.append((strat, B.call_data("getInterestRateData", ctx.reserves[r]["asset"])))
        res2 = ctx.rpc.multicall(dep_calls, blk, "rstate", tag=f"rstate {s} dep") if dep_calls else []
        store.put(s, {"block": blk, "ts": ts, "order": list(ctx.order),
                      "lead": [[1 if ok else 0, ret.hex()] for ok, ret in res],
                      "dep_labels": dep_labels, "dep": [[1 if ok else 0, ret.hex()] for ok, ret in res2]})

    B.run_pool(ctx, "rstate", todo, do)
    ctx._rstate_rows = None


def _u(ok_hex) -> tuple[int | None, str]:
    ok, h = ok_hex
    ret = bytes.fromhex(h)
    if not ok:
        return None, "fail"
    if not ret:
        return None, "empty"
    if len(ret) != 32:
        return None, f"badlen:{len(ret)}"
    return int.from_bytes(ret, "big"), "ok"


def rstate_rows(ctx: Ctx) -> list[dict]:
    """reserve-state rows (depositor-balances columns) from the rstate checkpoint."""
    if getattr(ctx, "_rstate_rows", None):
        return ctx._rstate_rows
    store = B.JsonlStore(ctx.work / "rstate.jsonl")
    rows = []
    for s, blk, ts in rstate_snapshots(ctx):
        rec = store.get(s)
        if rec is None:
            raise B.TerminalError(f"rstate missing {s}")
        if rec["order"] != list(ctx.order) or rec["block"] != blk:
            raise B.TerminalError(f"rstate layout changed {s}")
        dep = {tuple(lab): v for lab, v in zip(rec["dep_labels"], rec["dep"])}
        for k, r in enumerate(ctx.order):
            row = {"snapshot": s, "reserve": r, "block": blk, "block_ts": ts}
            ok, h = rec["lead"][3 * k]
            rd = B.decode_reserve_data(bool(ok), bytes.fromhex(h))
            row["rd_status"], row["rd_words"] = rd["status"], rd["words"]
            for j, col in ((1, "totalSupply"), (2, "cash")):
                row[col], row[col + "_status"] = _u(rec["lead"][3 * k + j])
            listed = rd.get("status") == "ok" and rd.get("listed")
            row["listed"] = int(bool(listed)) if rd.get("status") == "ok" else None
            for f in ("liquidityIndex", "variableBorrowIndex", "lastUpdateTimestamp"):
                row[f] = rd.get(f)
            row["liquidityRate_ray"] = rd.get("currentLiquidityRate")
            row["variableBorrowRate_ray"] = rd.get("currentVariableBorrowRate")
            row["configuration"] = rd.get("configuration")
            row["RF_bps"] = B.reserve_factor_bps(rd["configuration"]) if rd.get("status") == "ok" else None
            row["aToken_rd"] = rd.get("aTokenAddress")
            row["aToken_matches"] = (int(rd.get("aTokenAddress") == B.norm_address(ctx.reserves[r]["atoken"]))
                                     if rd.get("status") == "ok" else None)
            row["variableDebtToken"] = rd.get("variableDebtTokenAddress")
            row["strategy"] = rd.get("interestRateStrategyAddress")
            vd = dep.get(("vd", r, row["variableDebtToken"]))
            if vd is not None:
                row["variableDebt"], row["variableDebt_status"] = _u(vd)
            else:
                row["variableDebt"] = None
                row["variableDebt_status"] = ("rd_" + rd["status"]) if rd.get("status") != "ok" else (
                    "not_listed" if not listed else "not_called")
            strat = row["strategy"]
            v1 = [dep.get(("v1", r, strat, nm)) for nm in B.V1_CURVE] if strat else [None] * 4
            v2 = dep.get(("v2", r, strat)) if strat else None
            cur = B.decode_curve([(bool(x[0]), x[1]) for x in v1] if all(v1) else None,
                                 (bool(v2[0]), v2[1]) if v2 else None)
            if v2 is not None:
                row["curve_abi"] = cur["abi"]
            elif rd.get("status") != "ok":
                row["curve_abi"] = "rd_" + rd["status"]
            else:
                row["curve_abi"] = "not_listed" if not listed else "not_called"
            main = cur["main"]
            for i, nm in enumerate(("optimal", "base", "slope1", "slope2")):
                row[nm] = main[i] if main else None
            for tag in ("v1", "v2"):
                vals = cur[tag]
                for i, nm in enumerate(("optimal", "base", "slope1", "slope2")):
                    row[f"{tag}_{nm}"] = vals[i] if vals else None
            row["v1_success"] = "".join(str(int(bool(x[0]))) for x in v1) if all(v1) else ""
            row["v2_success"] = (1 if v2[0] else 0) if v2 else None
            rows.append(row)
    ctx._rstate_rows = rows
    return rows


# ---------------------------------------------------------------------------------------------
# Phase: write
# ---------------------------------------------------------------------------------------------


def write_csv_gz(path: Path, header: list[str], rows) -> None:
    B.write_csv(path, header, rows, gz=True)


def period_key(ts: int, level: str) -> str:
    d = dt.datetime.fromtimestamp(ts, dt.timezone.utc)
    if level == "year":
        return f"{d.year}"
    if level == "half":
        return f"{d.year}h{1 + (d.month - 1) // 6}"
    if level == "quarter":
        return f"{d.year}q{1 + (d.month - 1) // 3}"
    return f"{d.year}-{d.month:02d}"


class _GzCsv:
    def __init__(self, path: Path, header: list[str]):
        self.path = path
        self.tmp = path.with_suffix(path.suffix + ".tmp")
        self.raw = open(self.tmp, "wb")
        self.gz = gzip.GzipFile(filename="", mode="wb", fileobj=self.raw, compresslevel=9, mtime=0)
        self.text = io.TextIOWrapper(self.gz, encoding="utf-8", newline="")
        self.w = csv.writer(self.text, lineterminator="\n")
        self.w.writerow(header)

    def close(self) -> None:
        self.text.flush()
        self.text.detach()
        self.gz.close()
        self.raw.close()
        os.replace(self.tmp, self.path)


def write_partitioned(out: Path, stem: str, header: list[str], rows_factory, ts_of) -> list[str]:
    """Stream rows (in time order) to {stem}-{period}.csv.gz by year; if any file is above
    OUT_FILE_MAX_BYTES, everything is rewritten with finer periods (half-year, quarter, month).
    Returns the file names."""
    for level in ("year", "half", "quarter", "month"):
        names, cur, key = [], None, None
        for row in rows_factory():
            k = period_key(ts_of(row), level)
            if k != key:
                if key is not None and k < key:
                    raise B.TerminalError(f"{stem}: rows out of time order")
                if cur is not None:
                    cur.close()
                key = k
                cur = _GzCsv(out / f"{stem}-{k}.csv.gz", header)
                names.append(cur.path.name)
            cur.w.writerow(row)
        if cur is not None:
            cur.close()
        if all((out / n).stat().st_size <= OUT_FILE_MAX_BYTES for n in names):
            for q in out.glob(f"{stem}-*.csv.gz"):
                if q.name not in names:
                    q.unlink()
            return names
        for n in names:
            (out / n).unlink()
    raise B.TerminalError(f"{stem}: a month exceeds the file size limit")


EVENT_COLS = ["reserve", "block", "ts", "tx_hash", "tx_index", "log_index", "type", "party1", "party2",
              "value_raw", "balanceIncrease_raw", "index_ray", "delta1_raw", "delta2_raw"]
RAW_COLS = ["address", "block", "tx_hash", "tx_index", "log_index", "topic0", "topic1", "topic2", "topic3", "data"]


def write_reserve_logs(ctx: Ctx, out: Path, r: str, tsl: dict) -> list[str]:
    """raw-logs-<r>-<period>.csv.gz and events-<r>-<period>.csv.gz of one reserve into `out`."""
    at = ctx.reserves[r]["atoken"].lower()
    stem = r.lower()

    def raw_rows():
        for lg in ctx.store.iter_reserve(r):
            t = lg["topics"] + [""] * (4 - len(lg["topics"]))
            yield [at, lg["block"], lg["tx"], lg["tx_index"], lg["log_index"], *t, lg["data"]]

    def ev_rows():
        for lg in ctx.store.iter_reserve(r):
            try:
                ev = decode_log(lg["topics"], lg["data"])
            except DecodeError:
                continue
            if ev is None:
                continue
            dl = ev["deltas"]
            d1 = dl[0][1] if len(dl) >= 1 else ""
            d2 = dl[1][1] if len(dl) >= 2 else ""
            yield [r, lg["block"], tsl[lg["block"]], lg["tx"], lg["tx_index"], lg["log_index"], ev["type"],
                   ev["party1"], ev["party2"], ev["value"],
                   "" if ev["balanceIncrease"] is None else ev["balanceIncrease"],
                   "" if ev["index"] is None else ev["index"], d1, d2]

    names = write_partitioned(out, f"raw-logs-{stem}", RAW_COLS, raw_rows, lambda row: tsl[row[1]])
    names += write_partitioned(out, f"events-{stem}", EVENT_COLS, ev_rows, lambda row: row[2])
    return names


def write_blocks(ctx: Ctx, out: Path, blocks: set | None, tsl: dict) -> list[str]:
    tab = block_table(ctx)

    def blk_rows():
        for b in sorted(tab):
            if blocks is None or b in blocks:
                yield [b, tsl[b], tab[b][1]]

    return write_partitioned(out, "block-timestamps", ["block", "ts", "block_hash"], blk_rows, lambda row: row[1])


UNIVERSE_COLS = ["reserve", "address", "in_P_r", "P_r_rule", "reaches_1M_by_events", "new", "max_event_balance_raw",
                 "max_at_block", "recon_balance_asof_raw", "first_event_block", "first_event_utc", "n_balance_events"]


def _finish(out: Path, files: list[str], prov_fn) -> dict:
    keep = set(files) | {"PROVENANCE.md"}
    for p in out.rglob("*"):
        if p.is_file():
            rel = str(p.relative_to(out))
            if rel not in keep and (p.parent == out or p.parent.parent == out):
                p.unlink()
    info = {n: {"bytes": (out / n).stat().st_size, "sha256": B.sha256_file(out / n)} for n in sorted(files)}
    (out / "PROVENANCE.md").write_text(prov_fn(info))
    return info


def phase_write(ctx: Ctx, run_meta_fn) -> dict:
    if ctx.mode != "main":
        return phase_write_holdout(ctx, run_meta_fn)
    out = ctx.out
    out.mkdir(parents=True, exist_ok=True)
    tsl = ts_lookup(ctx)
    files = []
    for r in ctx.order:
        files += write_reserve_logs(ctx, out, r, tsl)
    files += write_blocks(ctx, out, None, tsl)
    if "universe" in ctx.state:
        rows = [[r] + [x[c] for c in UNIVERSE_COLS[1:]] for r in ctx.order for x in ctx.state["universe"][r]["rows"]]
        B.write_csv(out / "extended-universe.csv", UNIVERSE_COLS, rows, gz=False)
        files.append("extended-universe.csv")
    if "gate_new" in ctx.state:
        plan = new_anchor_plan(ctx)
        for r in ctx.order:
            name = f"daily-balances-ext-{r.lower()}.csv.gz"
            write_csv_gz(out / name, ["snapshot", "address", "balance_raw", "status"], new_anchor_rows(ctx, r, plan))
            files.append(name)
    rep = {"prereg": PREREG, "deviation_d2": D2_RULE, "gate_P_r": ctx.state.get("gate"),
           "gate_new_addresses": ctx.state.get("gate_new"), "coverage": ctx.state.get("coverage"),
           "decode": ctx.state.get("decode"),
           "universe": {r: {k: v for k, v in u.items() if k != "rows"} for r, u in ctx.state.get("universe", {}).items()}}
    (out / "gate-report.json").write_text(json.dumps(rep, indent=1, default=str) + "\n")
    files.append("gate-report.json")
    run_meta = run_meta_fn()
    (out / "run-log.json").write_text(json.dumps(run_meta, indent=1, default=str) + "\n")
    files.append("run-log.json")
    return _finish(out, files, lambda info: provenance_md(ctx, run_meta, info))


CANDIDATE_COLS = ["asset", "symbol", "decimals", "aToken", "price_asof_usd", "monthly_min", "monthly_max",
                  "n_monthly_listed", "n_monthly_failed", "pegged", "totalSupply_raw", "supply_usd", "supply_ok",
                  "listing_block", "listing_utc", "listed_days", "listed_ok", "selected", "reason"]


def phase_write_holdout(ctx: Ctx, run_meta_fn) -> dict:
    out = ctx.out
    out.mkdir(parents=True, exist_ok=True)
    ho = ctx.state["holdouts"]
    files = []
    cands = sorted(ho["candidates"], key=lambda c: (not c["selected"], -(c["supply_usd"] or 0)))
    B.write_csv(out / "holdout-candidates.csv", CANDIDATE_COLS,
                [[("" if c.get(k) is None else c.get(k)) for k in CANDIDATE_COLS] for c in cands], gz=False)
    files.append("holdout-candidates.csv")
    if ctx.order and "timestamps" in ctx.state:
        tsl = ts_lookup(ctx)
        plan = new_anchor_plan(ctx) if "gate_new" in ctx.state else None
        rs = rstate_rows(ctx) if "gate_new" in ctx.state else []
        for r in ctx.order:
            sub = out / r
            sub.mkdir(parents=True, exist_ok=True)
            names = write_reserve_logs(ctx, sub, r, tsl)
            blocks = {lg["block"] for lg in ctx.store.iter_reserve(r)}
            names += write_blocks(ctx, sub, blocks, tsl)
            if "universe" in ctx.state:
                rows = [[r] + [x[c] for c in UNIVERSE_COLS[1:]] for x in ctx.state["universe"][r]["rows"]]
                B.write_csv(sub / "extended-universe.csv", UNIVERSE_COLS, rows, gz=False)
                names.append("extended-universe.csv")
            if plan is not None:
                name = f"daily-balances-{r.lower()}.csv.gz"
                write_csv_gz(sub / name, ["snapshot", "address", "balance_raw", "status"], new_anchor_rows(ctx, r, plan))
                names.append(name)
                B.write_csv(sub / "reserve-state.csv", B.RESERVE_STATE_COLS,
                            ([B.fmt(row.get(c)) for c in B.RESERVE_STATE_COLS] for row in rs if row["reserve"] == r),
                            gz=False)
                names.append("reserve-state.csv")
            files += [f"{r}/{n}" for n in names]
    rep = {"prereg": PREREG, "deviation_d1": "holdout reserves", "deviation_d2": D2_RULE,
           "selection": {k: v for k, v in ho.items() if k != "candidates"},
           "gate": ctx.state.get("gate_new"), "coverage": ctx.state.get("coverage"), "decode": ctx.state.get("decode"),
           "universe": {r: {k: v for k, v in u.items() if k != "rows"} for r, u in ctx.state.get("universe", {}).items()}}
    (out / "gate-report.json").write_text(json.dumps(rep, indent=1, default=str) + "\n")
    files.append("gate-report.json")
    run_meta = run_meta_fn()
    (out / "run-log.json").write_text(json.dumps(run_meta, indent=1, default=str) + "\n")
    files.append("run-log.json")
    return _finish(out, files, lambda info: provenance_holdout_md(ctx, run_meta, info))


def _f5(v) -> str:
    return "n/a" if v is None else f"{v:.6f}"


def _session_lines(st: dict) -> list[str]:
    return [f"  {', '.join(x['phases'])}: HEAD `{x['code'].get('sha')}`; builder `{x['code'].get('file_last_commit')}` "
            f"(sha256 `{x['code'].get('file_sha256')}`){' DIRTY' if x['code'].get('dirty') else ''}; status `{x['status']}`."
            for x in st.get("sessions", []) if x.get("status")]


def _gate_lines(label: str, g: dict) -> list[str]:
    if not g:
        return []
    d, r = g["d2"]["pooled"], g["registered_rule"]["pooled"]
    return [f"{label}: verdict (D2) {'PASS' if g['passes'] else 'FAIL'} — {_f5(d['share_pass'])} of {d['n_pairs']} pairs, "
            f"{_f5(d['share_pass_with_event'])} of {d['n_pairs_with_event']} pairs holding an event. Registered G.2 "
            f"tolerance: {'pass' if g['registered_rule']['passes'] else 'failed'} — {_f5(r['share_pass'])} / "
            f"{_f5(r['share_pass_with_event'])}."]


SOURCE_LINES = [
    f"- **Sources:** logs by `eth_getLogs` on `{LOGS_RPC_URL}` (free, no key), ranges ≤ {RANGE_MAX:,} blocks split in",
    f"  half on any non-rate-limit error down to {RANGE_MIN:,} blocks, ≤ 2 requests/s, rate limit: wait {RETRY_WAIT_S} s,",
    f"  ≤ {MAX_RETRIES} retries, then stop. Block timestamps and hashes: the `blockTimestamp` / `blockHash` the logs",
    f"  endpoint returns with every log, a seeded sample ({TS_SAMPLE_PER_RESERVE} blocks per token) checked by",
    f"  `eth_getBlockByNumber` on `{STATE_RPC_URL}`. Deployment blocks (eth_getCode bisection), reference reads, reserve",
    f"  state and the anchors: archive `eth_call` on `{STATE_RPC_URL}`, Multicall3 `{B.MULTICALL3}` (B.1 method).",
]
FORMAT_LINES = [
    "  - `raw-logs-<reserve>-<period>.csv.gz`: every log as returned (address, block, tx hash, tx index, log index,",
    "    topic0..3, data), sorted by block then log index.",
    "  - `events-<reserve>-<period>.csv.gz`: the four decoded types. `party1`/`party2` = Mint onBehalfOf/caller,",
    "    Burn from/target, BalanceTransfer from/to, Transfer from/to. `delta1_raw` = G.2 balance change of party1",
    "    (Mint value − balanceIncrease; Burn −(value + balanceIncrease); BalanceTransfer −rayMul(value, index)),",
    "    `delta2_raw` = change of party2 (BalanceTransfer +rayMul(value, index)); empty = no G.2 change (Transfer",
    "    rows duplicate the paired event and carry none). BalanceTransfer `value_raw` is the scaled amount.",
    "  - `block-timestamps-<period>.csv.gz`: block, ts, block hash for every block with a log.",
    "  - `extended-universe.csv`: every address whose event-reconstructed balance reaches ≥ $1,000,000 at any",
    "    moment (`reaches_1M_by_events`), plus every `P_r` member; `new` = reaches and not in `P_r`. Method: scaled",
    "    balance s = Σ rayDiv(G.2 change, event index) (BalanceTransfer moves its scaled `value` exactly); balance =",
    "    s × index, evaluated before and after every event (the event's own index) and at asof (normalized income), the",
    "    maximum over each interval being at its end because the index only grows; computed in 1e-6-token units with",
    "    float64 for the maximum. `recon_balance_asof_raw` = s × normalized income at this asof.",
]


def provenance_md(ctx: Ctx, meta: dict, files: dict) -> str:
    st = ctx.state
    a, dep = st["asof"], st["deploy"]
    dec, uni = st.get("decode", {}), st.get("universe", {})
    gate, gnew, cov = st.get("gate", {}), st.get("gate_new", {}), st.get("coverage", {})
    built = bool(uni) and bool(gnew)
    lines = [
        "# depositor-events — provenance",
        "",
        "Every log of the Aave V3 Ethereum Core aUSDC and aUSDT tokens from deployment to a pinned asof block, decoded",
        "per G.2, with the reconstruction validation gate" + (", the extended universe and daily anchors for its new addresses."
                                                           if built else " (the extended universe was not built)."),
        f"Built as preregistered in `{PREREG['repo']}` `{PREREG['path']}` §{PREREG['sections']} (commit `{PREREG['commit']}`,",
        f"sha256 `{PREREG['sha256'][:8]}…{PREREG['sha256'][-4:]}`) with deviation D2 (membrane-board `567955a`): the gate tolerance",
        "base is max(anchor_d, anchor_d+1, intraday peak balance). The registered rule failed (intraday interest on",
        "same-day round trips) and is reported beside the verdict. The builder computes no outcome (no gradient labels,",
        "exit counts or withdrawal rates); the gate compares balance changes only.",
        "",
        *SOURCE_LINES,
        f"  aUSDC `{RESERVES['USDC']['atoken']}` (deployed block {dep['USDC']['block']}, {dep['USDC']['utc']});",
        f"  aUSDT `{RESERVES['USDT']['atoken']}` (deployed block {dep['USDT']['block']}, {dep['USDT']['utc']}).",
        f"- **Asof:** block {a['block']} ({B.iso_utc(a['ts'])}, hash `{a['hash']}`), the `finalized` block at start.",
        f"  Anchor inputs: membrane-datasets `{B1_DIR}/` (`2ca6d16`), sha256 checked; its asof block is {B1_ASOF_BLOCK}.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{meta['code'].get('branch')}`, `{meta['code'].get('path')}`",
        "  (helpers imported from `b_acquire.py`). By session:",
        *_session_lines(st),
        f"- **Fetch window (UTC):** {meta['fetch_window_utc'][0]} → {meta['fetch_window_utc'][1]}.",
        ("- **Status:** CANONICAL, FROZEN (inputs to Q26 B-gradient; do not refetch or edit)." if gate.get("passes") else
         "- **Status:** FROZEN raw acquisition; the gate FAILED, so no extended universe or new anchors were built."),
        "- **Units:** raw integers in 6-decimal underlying units (÷ 1e6 = USD); `index_ray` ÷ 1e27.",
        "- **Formats:**",
        *FORMAT_LINES,
        "  - `daily-balances-ext-{usdc,usdt}.csv.gz`: B.1 long format for the new addresses, every B.1 daily snapshot",
        "    from the address's first event day (UTC) on, then `asof` (block 26180400) and `asof_events` (this asof).",
        "  - `gate-report.json`: the gate on P_r and on the new anchors (D2 verdict and the registered rule: shares per",
        "    reserve and year, worst residuals, failure causes), diagnostics, reconstruction checks, universe, coverage.",
        "  - `run-log.json`: request counts, retries, splits, failures, timings, code sha, state.",
        "- **Holdout reserves (D1):** `holdouts/` with its own PROVENANCE.md." if (ctx.out / "holdouts").exists() else "",
        "",
    ]
    for r in ctx.order:
        x = dec.get(r, {})
        lines.append(f"{r}: {x.get('n_logs')} logs; by type {json.dumps(x.get('by_type'))}; other known "
                     f"{json.dumps(x.get('other_known'))}; unknown topic0 {json.dumps(x.get('unknown_topic0'))}.")
    lines += [""] + _gate_lines("Gate on P_r", gate) + _gate_lines("Gate on new anchors", gnew)
    if uni:
        lines += ["Extended universe: " + "; ".join(
            f"{r} {uni[r]['n_rule']} reach $1M ({uni[r]['n_new']} new vs P_r {uni[r]['n_P_r']})" for r in ctx.order) + "."]
    if cov:
        lines += ["Coverage of aToken totalSupply: " + "; ".join(
            f"{r} {cov[r]['b1_asof']['universe_share(P_r+new)']:.4f} anchored at block {cov[r]['b1_asof']['block']}, "
            f"{cov[r]['asof']['universe_share_reconstructed']:.4f} reconstructed at block {cov[r]['asof']['block']}"
            for r in ctx.order) + "."]
    lines += ["", "| file | bytes | sha256 |", "|---|---:|---|"]
    for n, f in sorted(files.items()):
        lines.append(f"| `{n}` | {f['bytes']} | `{f['sha256']}` |")
    return "\n".join(lines) + "\n"


def provenance_holdout_md(ctx: Ctx, meta: dict, files: dict) -> str:
    st = ctx.state
    a, ho = st["asof"], st["holdouts"]
    dec, uni = st.get("decode", {}), st.get("universe", {})
    gnew, cov = st.get("gate_new", {}), st.get("coverage", {})
    dep = st.get("deploy", {})
    lines = [
        "# depositor-events/holdouts — provenance",
        "",
        "Holdout reserves of Q26 B-gradient deviation D1 (blind confirmation; no fit reads them): Aave V3 Ethereum Core",
        "USD-stablecoin reserves other than USDC and USDT with aToken supply ≥ $50M at the asof block and listed ≥ 365 days",
        "before it. Same G.1–G.2 method as the parent directory: logs → decode → universe (≥ $1M at any time) → daily",
        "00:00Z anchors → gate (deviation D2 tolerance), plus daily reserve state. No labels or outcomes are computed.",
        f"Prereg `{PREREG['repo']}` `{PREREG['path']}` (commit `{PREREG['commit']}`), deviations D1 and D2 (`567955a`).",
        "",
        f"- **Selection (fixed mechanically at fetch time):** {ho['select_rule']}.",
        f"  {ho['peg_rule']}",
        f"  Pool `{POOL}`, PoolAddressesProvider `{ho['provider']}`, oracle at asof `{ho['oracle_asof']}`. Full table:",
        "  `holdout-candidates.csv`. Selected: " + (", ".join(
            f"{n} (`{v['asset']}`, aToken `{v['atoken']}`, {v['decimals']} decimals, listed block {dep[n]['block']} "
            f"{dep[n]['utc']})" for n, v in ho["reserves"].items()) or "none") + ".",
        *SOURCE_LINES,
        f"- **Asof:** block {a['block']} ({B.iso_utc(a['ts'])}, hash `{a['hash']}`), the same asof as `depositor-events/`.",
        "  Snapshot blocks: membrane-datasets `depositor-balances/blocks.csv` (`2ca6d16`, sha256 checked).",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{meta['code'].get('branch')}`, `{meta['code'].get('path')}`",
        "  `--mode holdout`. By session:",
        *_session_lines(st),
        f"- **Fetch window (UTC):** {meta['fetch_window_utc'][0]} → {meta['fetch_window_utc'][1]}.",
        ("- **Status:** CANONICAL, FROZEN (holdout inputs to Q26 B-gradient; do not refetch or edit)."
         if gnew.get("passes") else "- **Status:** FROZEN acquisition; the holdout gate did not pass (see gate-report.json)."),
        "- **Units:** raw integers in the token's own decimals (column `decimals` of the candidate table); 1 token is",
        "  counted as $1 (USD-pegged by the selection rule). Gate and universe run in 1e-6-token units.",
        "- **Formats** (per reserve directory `<reserve>/`):",
        *FORMAT_LINES,
        "    No reserve here has a `P_r`, so every universe member is `new` and is anchored.",
        "  - `daily-balances-<reserve>.csv.gz`: B.1 long format for every universe address, every B.1 daily snapshot",
        "    from its first event day (UTC) on, then `asof` (block 26180400) and `asof_events` (this asof).",
        "  - `reserve-state.csv`: depositor-balances columns at every daily snapshot block plus `asof` and `asof_events`.",
        "  - top level: `holdout-candidates.csv`, `gate-report.json` (pooled over the holdouts, per reserve and year, D2",
        "    verdict and the registered rule, reconstruction checks, coverage), `run-log.json`.",
        "",
    ]
    for r in ctx.order:
        x = dec.get(r, {})
        lines.append(f"{r}: {x.get('n_logs')} logs; by type {json.dumps(x.get('by_type'))}; other known "
                     f"{json.dumps(x.get('other_known'))}; unknown topic0 {json.dumps(x.get('unknown_topic0'))}.")
    lines += [""] + _gate_lines("Gate on the holdout universe", gnew)
    if uni:
        lines += ["Universe (≥ $1M at any time): " + "; ".join(f"{r} {uni[r]['n_rule']}" for r in ctx.order) + "."]
    if cov:
        lines += ["Coverage of aToken totalSupply: " + "; ".join(
            f"{r} {cov[r]['b1_asof']['universe_share(P_r+new)']:.4f} anchored at block {cov[r]['b1_asof']['block']}, "
            f"{cov[r]['asof']['new_anchored_share']:.4f} anchored at block {cov[r]['asof']['block']}" for r in ctx.order) + "."]
    lines += ["", "| file | bytes | sha256 |", "|---|---:|---|"]
    for n, f in sorted(files.items()):
        lines.append(f"| `{n}` | {f['bytes']} | `{f['sha256']}` |")
    return "\n".join(lines) + "\n"


def build_run_meta(ctx: Ctx) -> dict:
    events = []
    if ctx.events_path.exists():
        events = [json.loads(l) for l in ctx.events_path.read_text().splitlines() if l.strip()]
    sessions = ctx.state.get("sessions", [])
    net = [s for s in sessions if (s.get("logs_counts") or {}).get("requests", 0) or (s.get("state_counts") or {}).get("http_requests", 0)]
    tot_logs, tot_state = {}, {}
    for s in sessions:
        for src, dst in (("logs_counts", tot_logs), ("state_counts", tot_state)):
            for k, v in (s.get(src) or {}).items():
                if isinstance(v, (int, float)):
                    dst[k] = dst.get(k, 0) + v
                elif isinstance(v, dict):
                    dd = dst.setdefault(k, {})
                    for kk, vv in v.items():
                        dd[kk] = dd.get(kk, 0) + vv
    return {
        "dataset": "depositor-events" if ctx.mode == "main" else "depositor-events/holdouts", "prereg": PREREG,
        "deviations": {"D1": "holdout reserves", "D2": D2_RULE}, "mode": ctx.mode,
        "reserves": ctx.reserves,
        "holdout_selection": ({k: v for k, v in ctx.state["holdouts"].items() if k != "candidates"}
                              if "holdouts" in ctx.state else None),
        "logs_rpc_url": LOGS_RPC_URL, "state_rpc_url": STATE_RPC_URL, "user_agent": USER_AGENT,
        "logs_policy": {"range_max": RANGE_MAX, "range_min": RANGE_MIN, "interval_s": LOGS_INTERVAL_S,
                        "retry_wait_s": RETRY_WAIT_S, "max_retries": MAX_RETRIES, "cap_suspect": CAP_SUSPECT},
        "state_policy": {"max_requests_per_second": B.MAX_REQUESTS_PER_SECOND, "workers": B.WORKERS,
                         "retry_wait_s": B.RETRY_WAIT_S, "max_retries": B.MAX_RETRIES},
        "code": git_info(),
        "fetch_window_utc": [min((s["start_utc"] for s in net), default=None),
                             max((s.get("end_utc") or "" for s in net), default=None)],
        "asof": ctx.state.get("asof"), "asof_crosscheck": ctx.state.get("asof_crosscheck"),
        "deploy": ctx.state.get("deploy"), "signatures": ctx.state.get("signatures"), "refs": ctx.state.get("refs"),
        "logs_stats": ctx.state.get("logs_stats"), "timestamps": ctx.state.get("timestamps"),
        "decode": ctx.state.get("decode"), "b1_inputs": ctx.state.get("b1_inputs"),
        "universe": {r: {k: v for k, v in u.items() if k != "rows"} for r, u in ctx.state.get("universe", {}).items()},
        "coverage": ctx.state.get("coverage"),
        "calls_logs_endpoint": tot_logs, "calls_state_endpoint": tot_state,
        "retry_split_failure_events": events, "sessions": sessions,
    }


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

PHASES = ("preflight", "logs", "timestamps", "decode", "gate", "universe", "anchors", "gate_new", "write")
HOLDOUT_PHASES = ("select", "logs", "timestamps", "decode", "universe", "anchors", "rstate", "gate_new", "write")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--phases", default="all")
    ap.add_argument("--mode", choices=("main", "holdout"), default="main",
                    help="main = USDC/USDT; holdout = the deviation D1 holdout reserves")
    ap.add_argument("--main-work-dir", default=None, help="holdout mode: the main run's work dir (asof is reused)")
    args = ap.parse_args(argv)
    ddir = datasets_dir()
    holdout = args.mode == "holdout"
    out = Path(args.out_dir) if args.out_dir else ddir / "depositor-events" / ("holdouts" if holdout else "")
    ctx = Ctx(Path(args.work_dir), out, ddir, mode=args.mode, reserves={} if holdout else None)
    main_state = None
    if holdout:
        if ctx.state.get("holdouts", {}).get("done"):
            ctx.set_reserves(ctx.state["holdouts"]["reserves"])
        if not args.main_work_dir and not ctx.state.get("holdouts"):
            ap.error("holdout mode needs --main-work-dir on its first run")
        if args.main_work_dir:
            main_state = json.loads((Path(args.main_work_dir) / "state.json").read_text())
    for prev in ctx.state.get("sessions", []):
        if not prev.get("status"):
            prev["status"] = "interrupted (process ended before it recorded counts)"
    import signal

    def _term(signum, frame):
        raise B.TerminalError(f"signal {signum}")

    signal.signal(signal.SIGTERM, _term)
    phases = (HOLDOUT_PHASES if holdout else PHASES) if args.phases == "all" else tuple(
        p.strip() for p in args.phases.split(","))
    session = {"start_utc": utcnow(), "code": git_info(), "phases": list(phases), "phase_seconds": {}}
    ctx.state.setdefault("sessions", []).append(session)
    ctx.save_state()
    status = "ok"

    def close():
        session["end_utc"] = utcnow()
        session["logs_counts"] = ctx.logs_client.counts
        session["state_counts"] = ctx.rpc.counts

    try:
        for p in phases:
            t0 = time.monotonic()
            print(f"PHASE {p} start {utcnow()}", flush=True)
            if p == "preflight":
                phase_preflight(ctx)
            elif p == "select":
                phase_select(ctx, main_state or {})
            elif p == "rstate":
                phase_rstate(ctx)
            elif p == "logs":
                phase_logs(ctx)
            elif p == "timestamps":
                phase_timestamps(ctx)
            elif p == "decode":
                phase_decode(ctx)
            elif p == "gate":
                rep = phase_gate(ctx)
                if not rep["passes"]:
                    session["phase_seconds"][p] = round(time.monotonic() - t0, 1)
                    raise B.TerminalError("validation gate FAILED (D2 verdict): run stops")
            elif p == "universe":
                phase_universe(ctx)
            elif p == "anchors":
                phase_anchors(ctx)
            elif p == "gate_new":
                rep = phase_gate_new(ctx)
                ctx.state["coverage"] = coverage(ctx)
                ctx.save_state()
                print("COVERAGE " + json.dumps(ctx.state["coverage"]), flush=True)
                if not rep["passes"]:
                    raise B.TerminalError("gate on the new anchors FAILED (D2 verdict)")
            elif p == "write":
                session["phase_seconds"][p] = 0
                session["status"] = "ok"
                close()
                ctx.save_state()
                info = phase_write(ctx, lambda: build_run_meta(ctx))
                print("FILES " + json.dumps(info), flush=True)
            session["phase_seconds"][p] = round(time.monotonic() - t0, 1)
            ctx.save_state()
    except B.TerminalError as e:
        status = f"stopped: {e}"
        print(f"STOPPED {e}", flush=True)
    finally:
        close()
        session["status"] = status
        ctx.save_state()
    return 0 if status == "ok" else 2


if __name__ == "__main__":
    sys.exit(main())
