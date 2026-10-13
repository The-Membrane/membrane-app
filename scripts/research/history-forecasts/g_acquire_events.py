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
  gate        G.2 validation gate against the frozen daily anchors of P_r (depositor-balances)
  universe    extended universe (event-reconstructed balance >= $1,000,000 at any time); only after
              the gate passed
  anchors     daily 00:00Z balanceOf for every new address (B.1 method)
  gate_new    the gate on the new anchors
  write       output files, gate-report.json, run-log.json, PROVENANCE.md

Usage:
  python3 g_acquire_events.py --work-dir DIR [--out-dir DIR] [--phases all|p1,p2,...]
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

    A: (n_addr, n_snap) int64 anchors at snapshot blocks snap_blocks (increasing); valid: bool mask.
    ev_*: one row per balance change (address row index, block, delta_raw, scaled delta).
    income: optional normalized income per snapshot (float, ray / 1e27) for the interest diagnostic.
    Returns dict of 1-D arrays."""
    import numpy as np
    n_addr, n_snap = A.shape
    n_pair = n_snap - 1
    S = np.zeros((n_addr, n_pair), dtype=np.int64)
    N = np.zeros((n_addr, n_pair), dtype=np.int64)
    SS = np.zeros((n_addr, n_pair), dtype=np.float64)
    ev_addr = np.asarray(ev_addr, dtype=np.int64)
    p = pair_index(snap_blocks, ev_block)
    m = (p >= 0) & (p < n_pair)
    np.add.at(S, (ev_addr[m], p[m]), np.asarray(ev_delta, dtype=np.int64)[m])
    np.add.at(N, (ev_addr[m], p[m]), 1)
    if ev_scaled is not None:
        np.add.at(SS, (ev_addr[m], p[m]), np.asarray(ev_scaled, dtype=np.float64)[m])
    both = valid[:, :-1] & valid[:, 1:]
    ai, pi = np.nonzero(both)
    a0 = A[ai, pi]
    a1 = A[ai, pi + 1]
    ev = S[ai, pi]
    diff = (a1 - a0) - ev
    out = {"addr": ai, "p": pi, "a0": a0, "a1": a1, "ev": ev, "n_ev": N[ai, pi], "diff": diff,
           "tol": gate_tolerance(a0, a1), "pass": gate_tolerance_pass(a0, a1, diff)}
    if income is not None:
        inc = np.asarray(income, dtype=np.float64)
        pred = (a0.astype(np.float64) / inc[pi] + SS[ai, pi]) * inc[pi + 1]
        out["res_interest"] = a1.astype(np.float64) - pred
    return out


def gate_summary(g: dict) -> dict:
    import numpy as np
    n = int(len(g["pass"]))
    has = g["n_ev"] > 0
    ne = int(has.sum())
    s_all = float(g["pass"].mean()) if n else None
    s_ev = float(g["pass"][has].mean()) if ne else None
    return {"n_pairs": n, "n_pass": int(g["pass"].sum()), "share_pass": s_all,
            "n_pairs_with_event": ne, "n_pass_with_event": int(g["pass"][has].sum()), "share_pass_with_event": s_ev,
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


class Ctx:
    def __init__(self, work: Path, out: Path, ddir: Path):
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
    for r in RESERVE_ORDER:
        a, at = RESERVES[r]["asset"], RESERVES[r]["atoken"]
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
    for r in RESERVE_ORDER:
        if r in dep:
            continue
        at = RESERVES[r]["atoken"]
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
    for r in RESERVE_ORDER:
        dep = ctx.state["deploy"][r]["block"]
        s = fetch_logs(ctx.store, ctx.logs_client, r, RESERVES[r]["atoken"], dep, asof, on_progress=prog)
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
    for r in RESERVE_ORDER:
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
    for r in RESERVE_ORDER:
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
            delta.append(dr)
            scaled.append(sd)
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
    for r in RESERVE_ORDER:
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


def b1_income(ctx: Ctx) -> dict[str, dict[str, float]]:
    """Normalized income (ray / 1e27) at each snapshot block from reserve-state.csv."""
    out: dict[str, dict[str, float]] = {r: {} for r in RESERVE_ORDER}
    for x in csv.DictReader(open(ctx.ddir / B1_DIR / "reserve-state.csv")):
        if x["liquidityIndex"] and x["liquidityRate_ray"] and x["lastUpdateTimestamp"]:
            inc = normalized_income(int(x["liquidityIndex"]), int(x["liquidityRate_ray"]),
                                    int(x["lastUpdateTimestamp"]), int(x["block_ts"]))
            out[x["reserve"]][x["snapshot"]] = inc / RAY
    return out


def b1_total_supply(ctx: Ctx) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {r: {} for r in RESERVE_ORDER}
    for x in csv.DictReader(open(ctx.ddir / B1_DIR / "reserve-state.csv")):
        if x["totalSupply"]:
            out[x["reserve"]][x["snapshot"]] = int(x["totalSupply"])
    return out


def load_anchor_matrix(path_or_rows, labels: list[str]):
    """Long anchors (snapshot, address, balance_raw, status) -> (addresses, A, valid) over `labels`."""
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
    ri = sub["address"].map(a_ix).to_numpy()
    ci = sub["snapshot"].map(lab_ix).to_numpy()
    A[ri, ci] = sub["balance_raw"].astype("int64").to_numpy()
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


def run_gate(ctx: Ctx, which: str, anchors: dict[str, tuple], labels: list[str], blocks: list[int],
             incomes: dict[str, list[float]]) -> dict:
    """anchors[r] = (addrs, A, valid) over daily labels; the gate on every consecutive daily pair."""
    import numpy as np
    per, pooled = {}, None
    allrows = []
    for r in RESERVE_ORDER:
        addrs, A, valid = anchors[r]
        d = decode_reserve(ctx, r)
        ea, eb, ed, es, _ = events_for(d, addrs)
        g = gate_pairs(A, valid, blocks, ea, eb, ed, ev_scaled=es, income=incomes[r])
        per[r] = gate_summary(g)
        g["reserve"] = np.full(len(g["pass"]), r, dtype=object)
        g["address"] = np.asarray(addrs, dtype=object)[g["addr"]] if len(g["addr"]) else np.zeros(0, dtype=object)
        allrows.append(g)
    keys = ["reserve", "address", "p", "a0", "a1", "ev", "n_ev", "diff", "tol", "pass", "res_interest"]
    G = {k: np.concatenate([g[k] for g in allrows]) for k in keys}
    pooled = gate_summary(G)
    # worst 20 by |diff| / tol
    ratio = np.abs(G["diff"]).astype(np.float64) / G["tol"].astype(np.float64)
    worst = np.argsort(-ratio, kind="stable")[:20]
    wrows = []
    for i in worst:
        p = int(G["p"][i])
        wrows.append({"reserve": G["reserve"][i], "address": short_addr(G["address"][i]),
                      "day": f"{labels[p]}→{labels[p + 1]}", "anchor0_usd": round(G["a0"][i] / 1e6, 2),
                      "anchor1_usd": round(G["a1"][i] / 1e6, 2), "event_sum_usd": round(G["ev"][i] / 1e6, 2),
                      "diff_usd": round(G["diff"][i] / 1e6, 2), "tol_usd": round(G["tol"][i] / 1e6, 2),
                      "ratio": round(float(ratio[i]), 3), "n_events": int(G["n_ev"][i]),
                      "interest_adjusted_diff_usd": round(float(G["res_interest"][i]) / 1e6, 2),
                      "pass": bool(G["pass"][i])})
    # failure causes
    fail = ~G["pass"]
    res_ok = np.abs(G["res_interest"]) <= G["tol"]
    causes = {
        "n_fail": int(fail.sum()),
        "interest_explained": int((fail & res_ok).sum()),
        "no_balance_event_unexplained": int((fail & ~res_ok & (G["n_ev"] == 0)).sum()),
        "with_events_unexplained": int((fail & ~res_ok & (G["n_ev"] > 0)).sum()),
        "rule": ("interest_explained: |a1 - (a0/I0 + sum(delta/index)) * I1| <= tol, I = normalized income at the "
                 "snapshot block from reserve-state.csv (diagnostic only; the gate itself ignores interest per G.2)"),
    }
    fu = fail & ~res_ok
    if fu.any():
        days = {}
        for i in np.nonzero(fu)[0]:
            k = f"{G['reserve'][i]} {labels[int(G['p'][i])]}"
            days[k] = days.get(k, 0) + 1
        causes["unexplained_by_day_top"] = sorted(days.items(), key=lambda x: -x[1])[:20]
        sgn = np.sign(G["diff"][fu])
        causes["unexplained_sign"] = {"positive(anchor_gain_exceeds_events)": int((sgn > 0).sum()),
                                      "negative": int((sgn < 0).sum())}
    if fail.any():
        days = {}
        for i in np.nonzero(fail)[0]:
            k = f"{G['reserve'][i]} {labels[int(G['p'][i])]}"
            days[k] = days.get(k, 0) + 1
        causes["fail_by_day_top"] = sorted(days.items(), key=lambda x: -x[1])[:20]
        causes["fail_abs_diff_usd_quantiles"] = {q: round(float(np.quantile(np.abs(G["diff"][fail]), q)) / 1e6, 2)
                                                 for q in (0.5, 0.9, 0.99, 1.0)}
    exact = np.abs(G["diff"]) <= 1000  # within 0.001 USD
    out = {"which": which, "rule": f"|anchor change - summed G.2 event change| <= max($10, 0.1% of the larger anchor); "
                                   f"pass iff share >= {GATE_SHARE} on all pairs AND on pairs holding >= 1 event",
           "event_definition": "a Mint (onBehalfOf), Burn (from) or BalanceTransfer (from or to) log naming the address, "
                               "in block (B_d, B_d+1]",
           "pooled": pooled, "per_reserve": per, "passes": pooled["passes"],
           "share_within_0.001usd": float(exact.mean()) if len(exact) else None,
           "worst20_by_diff_over_tol": wrows, "failure_causes": causes}
    return out


def anchored_income(ctx: Ctx, labels: list[str]) -> dict[str, list[float]]:
    inc = b1_income(ctx)
    out = {}
    for r in RESERVE_ORDER:
        vals = []
        for s in labels:
            v = inc[r].get(s)
            vals.append(v if v else float("nan"))
        out[r] = vals
    return out


def phase_gate(ctx: Ctx) -> dict:
    ctx.state["b1_inputs"] = check_b1_inputs(ctx)
    daily, asof = b1_blocks(ctx)
    labels = [s for s, _, _ in daily]
    blocks = [b for _, b, _ in daily]
    anchors = {}
    for r in RESERVE_ORDER:
        anchors[r] = load_anchor_matrix(ctx.ddir / B1_DIR / f"daily-balances-{r.lower()}.csv.gz", labels)
    rep = run_gate(ctx, "P_r (depositor-balances daily anchors)", anchors, labels, blocks, anchored_income(ctx, labels))
    rep["asof_pair_info"] = asof_pair_info(ctx, "b1", daily, asof)
    rep["reconstruction_checks"] = reconstruction_checks(ctx)
    ctx.state["gate"] = rep
    ctx.save_state()
    print("GATE " + json.dumps({k: rep[k] for k in ("pooled", "per_reserve", "passes")}), flush=True)
    return rep


def asof_pair_info(ctx: Ctx, which: str, daily, asof) -> dict:
    """The multi-day pair (last daily snapshot -> B.1 asof), reported, not in the gate."""
    import numpy as np
    labels = [daily[-1][0], "asof"]
    blocks = [daily[-1][1], asof[1]]
    out = {}
    for r in RESERVE_ORDER:
        addrs, A, valid = load_anchor_matrix(ctx.ddir / B1_DIR / f"daily-balances-{r.lower()}.csv.gz", labels)
        d = decode_reserve(ctx, r)
        ea, eb, ed, es, _ = events_for(d, addrs)
        g = gate_pairs(A, valid, blocks, ea, eb, ed)
        out[r] = gate_summary(g)
    out["note"] = f"pair {labels[0]} -> asof (block {asof[1]}), {which}; spans several days, not part of the gate"
    return out


def recon_scaled_at(d: Decoded, block: int):
    """Event-reconstructed scaled balance per address id after all events with block <= `block`."""
    import numpy as np
    m = d.block <= block
    out = np.zeros(len(d.addrs), dtype=np.int64)
    np.add.at(out, d.addr[m], d.scaled[m])
    return out


def reconstruction_checks(ctx: Ctx) -> dict:
    """Data checks of the full reconstruction (from zero at deployment): the sum of scaled balances vs
    scaledTotalSupply, and per-address balance vs the B.1 asof anchor of P_r."""
    import numpy as np
    out = {}
    refs = ctx.state["refs"]
    for r in RESERVE_ORDER:
        d = decode_reserve(ctx, r)
        o = {}
        for lab in ("b1_asof", "asof"):
            blk = refs[lab]["block"]
            sc = recon_scaled_at(d, blk)
            sts = int(refs[lab]["reads"][r]["scaledTotalSupply"])
            tot = int(sc.sum())
            o[lab] = {"block": blk, "recon_sum_scaled": str(tot), "scaledTotalSupply": str(sts),
                      "diff_raw": str(tot - sts), "rel_diff": (tot - sts) / sts if sts else None,
                      "n_negative_below_minus_1usd": int((sc < -10**6).sum())}
        # per-address vs B.1 asof anchors
        addrs, A, valid = load_anchor_matrix(ctx.ddir / B1_DIR / f"daily-balances-{r.lower()}.csv.gz", ["asof"])
        inc = int(refs["b1_asof"]["reads"][r]["normalizedIncome"])
        sc = recon_scaled_at(d, refs["b1_asof"]["block"])
        diffs = []
        for i, a in enumerate(addrs):
            if not valid[i, 0]:
                continue
            j = d.addr_ids.get(a)
            rb = ray_mul(int(sc[j]), inc) if j is not None else 0
            diffs.append((rb - int(A[i, 0]), int(A[i, 0])))
        dd = np.asarray([x for x, _ in diffs], dtype=np.int64)
        aa = np.asarray([y for _, y in diffs], dtype=np.int64)
        within = gate_tolerance_pass(aa, aa, dd)
        o["per_address_vs_b1_asof"] = {"n": int(len(dd)), "n_exact_within_10_raw": int((np.abs(dd) <= 10).sum()),
                                       "n_within_gate_tol": int(within.sum()),
                                       "max_abs_diff_usd": float(np.abs(dd).max()) / 1e6 if len(dd) else None}
        out[r] = o
    return out


# ---------------------------------------------------------------------------------------------
# Phase: universe
# ---------------------------------------------------------------------------------------------


def balance_maxima(d: Decoded, asof_block: int, asof_income: int):
    """Per address id: max event-reconstructed balance (raw) over every moment, with its block.

    Scaled balance s changes only at events; between events the balance s * I(t) grows with the
    index, so the maximum over an interval is at its end. Candidates: s before and after each
    event times the index of that event, and the final s times the income at the asof block."""
    import numpy as np
    n = len(d.addrs)
    if len(d.addr) == 0:
        return np.zeros(n), np.zeros(n, dtype=np.int64), np.zeros(n, dtype=np.int64)
    m = d.block <= asof_block
    addr, sc, idxf, blk = d.addr[m], d.scaled[m], d.index_f[m], d.block[m]
    order = np.argsort(addr, kind="stable")  # rows already in (block, log, sub) order
    a_s, s_s, i_s, b_s = addr[order], sc[order], idxf[order], blk[order]
    starts = np.r_[0, np.nonzero(np.diff(a_s))[0] + 1]
    cs = np.cumsum(s_s)
    seg_base = np.repeat(cs[starts] - s_s[starts], np.diff(np.r_[starts, len(a_s)]))
    after = cs - seg_base
    before = after - s_s
    cand = np.maximum(before, after).astype(np.float64) * i_s
    best = np.full(n, -np.inf)
    best_blk = np.zeros(n, dtype=np.int64)
    # per-address argmax
    seg_id = np.repeat(np.arange(len(starts)), np.diff(np.r_[starts, len(a_s)]))
    ord2 = np.lexsort((-cand, seg_id))
    first = np.r_[0, np.nonzero(np.diff(seg_id[ord2]))[0] + 1]
    rows = ord2[first]
    best[a_s[rows]] = cand[rows]
    best_blk[a_s[rows]] = b_s[rows]
    final = np.zeros(n, dtype=np.int64)
    np.add.at(final, addr, sc)
    fin_bal = final.astype(np.float64) * (asof_income / RAY)
    upd = fin_bal > best
    best[upd] = fin_bal[upd]
    best_blk[upd] = asof_block
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
    out: dict[str, dict[str, str]] = {r: {} for r in RESERVE_ORDER}
    for x in csv.DictReader(open(ctx.ddir / B1_DIR / "panel-population.csv")):
        out[x["reserve"]][x["address"]] = x["rule"]
    return out


def phase_universe(ctx: Ctx) -> None:
    gate = ctx.state.get("gate")
    if not gate or not gate.get("passes"):
        raise B.TerminalError("universe needs a passed gate")
    asof = ctx.state["asof"]["block"]
    tsl = ts_lookup(ctx)
    pop = b1_population(ctx)
    uni = {}
    for r in RESERVE_ORDER:
        d = decode_reserve(ctx, r)
        inc = int(ctx.state["refs"]["asof"]["reads"][r]["normalizedIncome"])
        best, best_blk, _ = balance_maxima(d, asof, inc)
        fb, cnt = first_event(d)
        rows = []
        reach = best >= THRESHOLD_RAW
        members = set(int(i) for i in reach.nonzero()[0])
        for a, rule in pop[r].items():
            if a in d.addr_ids:
                members.add(d.addr_ids[a])
        pr_missing = [a for a in pop[r] if a not in d.addr_ids]
        for i in sorted(members, key=lambda i: d.addrs[i]):
            a = d.addrs[i]
            fbi = int(fb[i])
            rows.append({"address": a, "in_P_r": int(a in pop[r]), "P_r_rule": pop[r].get(a, ""),
                         "reaches_1M_by_events": int(bool(reach[i])), "new": int(bool(reach[i]) and a not in pop[r]),
                         "max_event_balance_raw": int(round(best[i])), "max_at_block": int(best_blk[i]),
                         "first_event_block": fbi, "first_event_utc": B.iso_utc(tsl[fbi]),
                         "n_balance_events": int(cnt[i])})
        for a in pr_missing:
            rows.append({"address": a, "in_P_r": 1, "P_r_rule": pop[r][a], "reaches_1M_by_events": 0, "new": 0,
                         "max_event_balance_raw": 0, "max_at_block": "", "first_event_block": "", "first_event_utc": "",
                         "n_balance_events": 0})
        rows.sort(key=lambda x: x["address"])
        uni[r] = {"rows": rows, "n_rule": int(reach.sum()), "n_new": sum(x["new"] for x in rows),
                  "n_P_r": len(pop[r]), "n_P_r_reaching": sum(1 for x in rows if x["in_P_r"] and x["reaches_1M_by_events"]),
                  "n_P_r_not_reaching": sum(1 for x in rows if x["in_P_r"] and not x["reaches_1M_by_events"]),
                  "n_P_r_without_events": len(pr_missing), "n_file": len(rows)}
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
    for r in RESERVE_ORDER:
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
    for r in RESERVE_ORDER:
        for s, b, due in plan[r]["snaps"]:
            for ci, ch in enumerate(B.chunk(due)):
                if not ctx.anchor_store.has((s, r, ci)):
                    tasks.append((s, b, r, ci, ch))
    print(f"anchors: {len(tasks)} multicall requests to do", flush=True)

    def do(task):
        s, b, r, ci, addrs = task
        if ctx.rpc.stop.is_set():
            raise B.TerminalError("stopped")
        at = RESERVES[r]["atoken"]
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
    anchors = {}
    for r in RESERVE_ORDER:
        anchors[r] = load_anchor_matrix(new_anchor_rows(ctx, r, plan), labels)
    rep = run_gate(ctx, "new addresses (depositor-events daily-balances-ext anchors)", anchors, labels, blocks,
                   anchored_income(ctx, labels))
    # descriptive: new addresses with any 00:00Z anchor >= $1M
    import numpy as np
    desc = {}
    for r in RESERVE_ORDER:
        rows = new_anchor_rows(ctx, r, plan)
        big = {x[1] for x in rows if isinstance(x[2], int) and x[2] >= THRESHOLD_RAW and x[0] not in ("asof", "asof_events")}
        desc[r] = {"n_new": len(plan[r]["start"]), "n_with_daily_anchor_ge_1M": len(big),
                   "n_rows": len(rows), "n_non_ok": sum(1 for x in rows if x[3])}
    rep["new_anchor_summary"] = desc
    ctx.state["gate_new"] = rep
    ctx.save_state()
    print("GATE_NEW " + json.dumps({k: rep[k] for k in ("pooled", "per_reserve", "passes", "new_anchor_summary")}),
          flush=True)
    return rep


def coverage(ctx: Ctx) -> dict:
    """Share of aToken totalSupply at the B.1 asof snapshot held by the universe's anchored balances."""
    plan = new_anchor_plan(ctx)
    ts = b1_total_supply(ctx)
    out = {}
    for r in RESERVE_ORDER:
        addrs, A, valid = load_anchor_matrix(ctx.ddir / B1_DIR / f"daily-balances-{r.lower()}.csv.gz", ["asof"])
        pr = {a: int(A[i, 0]) for i, a in enumerate(addrs) if valid[i, 0]}
        newb = {x[1]: x[2] for x in new_anchor_rows(ctx, r, plan) if x[0] == "asof" and isinstance(x[2], int)}
        rows = ctx.state["universe"][r]["rows"]
        rule = {x["address"] for x in rows if x["reaches_1M_by_events"]}
        tot = ts[r]["asof"]
        s_pr = sum(pr.values())
        s_new = sum(newb.values())
        s_rule = sum(pr.get(a, 0) for a in rule) + sum(v for a, v in newb.items() if a in rule)
        out[r] = {"block": B1_ASOF_BLOCK, "totalSupply_raw": tot, "P_r_share": s_pr / tot, "new_share": s_new / tot,
                  "P_r_plus_new_share": (s_pr + s_new) / tot, "rule_members_share": s_rule / tot}
    return out


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


def phase_write(ctx: Ctx, run_meta_fn) -> dict:
    out = ctx.out
    out.mkdir(parents=True, exist_ok=True)
    tsl = ts_lookup(ctx)
    files = []
    for r in RESERVE_ORDER:
        at = RESERVES[r]["atoken"].lower()

        def raw_rows(r=r, at=at):
            for lg in ctx.store.iter_reserve(r):
                t = lg["topics"] + [""] * (4 - len(lg["topics"]))
                yield [at, lg["block"], lg["tx"], lg["tx_index"], lg["log_index"], *t, lg["data"]]

        files += write_partitioned(out, f"raw-logs-{r.lower()}", RAW_COLS, raw_rows, lambda row: tsl[row[1]])

        def ev_rows(r=r):
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

        files += write_partitioned(out, f"events-{r.lower()}", EVENT_COLS, ev_rows, lambda row: row[2])
    tab = block_table(ctx)

    def blk_rows():
        for b in sorted(tab):
            ts, h = tab[b]
            yield [b, tsl[b], h]

    files += write_partitioned(out, "block-timestamps", ["block", "ts", "block_hash"], blk_rows, lambda row: row[1])
    # extended universe
    if "universe" in ctx.state:
        cols = ["reserve", "address", "in_P_r", "P_r_rule", "reaches_1M_by_events", "new", "max_event_balance_raw",
                "max_at_block", "first_event_block", "first_event_utc", "n_balance_events"]
        rows = [[r] + [x[c] for c in cols[1:]] for r in RESERVE_ORDER for x in ctx.state["universe"][r]["rows"]]
        B.write_csv(out / "extended-universe.csv", cols, rows, gz=False)
        files.append("extended-universe.csv")
    if "gate_new" in ctx.state:
        plan = new_anchor_plan(ctx)
        for r in RESERVE_ORDER:
            name = f"daily-balances-ext-{r.lower()}.csv.gz"
            write_csv_gz(out / name, ["snapshot", "address", "balance_raw", "status"], new_anchor_rows(ctx, r, plan))
            files.append(name)
    rep = {"prereg": PREREG, "gate_P_r": ctx.state.get("gate"), "gate_new_addresses": ctx.state.get("gate_new"),
           "coverage": ctx.state.get("coverage"), "decode": ctx.state.get("decode")}
    (out / "gate-report.json").write_text(json.dumps(rep, indent=1, default=str) + "\n")
    files.append("gate-report.json")
    run_meta = run_meta_fn()
    (out / "run-log.json").write_text(json.dumps(run_meta, indent=1, default=str) + "\n")
    files.append("run-log.json")
    stale = [p.name for p in out.iterdir() if p.is_file() and p.name not in files and p.name != "PROVENANCE.md"]
    for n in stale:
        (out / n).unlink()
    info = {n: {"bytes": (out / n).stat().st_size, "sha256": B.sha256_file(out / n)} for n in sorted(files)}
    (out / "PROVENANCE.md").write_text(provenance_md(ctx, run_meta, info))
    return info


def provenance_md(ctx: Ctx, meta: dict, files: dict) -> str:
    st = ctx.state
    a = st["asof"]
    dep = st["deploy"]
    dec = st.get("decode", {})
    uni = st.get("universe", {})
    gate = st.get("gate", {})
    gnew = st.get("gate_new", {})
    sess = [x for x in st.get("sessions", []) if x.get("status") == "ok"]
    lines = [
        "# depositor-events — provenance",
        "",
        "Every log of the Aave V3 Ethereum Core aUSDC and aUSDT tokens from deployment to a pinned asof block,",
        "decoded per G.2, with the reconstruction validation gate, the extended universe and daily anchors for",
        f"its new addresses. Built exactly as preregistered in `{PREREG['repo']}` `{PREREG['path']}` §{PREREG['sections']}",
        f"(commit `{PREREG['commit']}`, sha256 `{PREREG['sha256'][:8]}…{PREREG['sha256'][-4:]}`). The builder computes no",
        "outcome (no gradient labels, exit counts or withdrawal rates); the gate compares balance changes only.",
        "",
        f"- **Sources:** logs by `eth_getLogs` on `{LOGS_RPC_URL}` (free, no key), ranges ≤ {RANGE_MAX:,} blocks split in",
        f"  half on any non-rate-limit error down to {RANGE_MIN:,} blocks, ≤ 2 requests/s, rate limit: wait {RETRY_WAIT_S} s,",
        f"  ≤ {MAX_RETRIES} retries, then stop. Block timestamps and hashes: the `blockTimestamp` / `blockHash` the logs",
        f"  endpoint returns with every log, a seeded sample ({TS_SAMPLE_PER_RESERVE} blocks per token) checked by",
        f"  `eth_getBlockByNumber` on `{STATE_RPC_URL}`. Deployment blocks (eth_getCode bisection), reference reads and",
        f"  the new anchors: archive `eth_call` on `{STATE_RPC_URL}`, Multicall3 `{B.MULTICALL3}` (B.1 method).",
        f"  aUSDC `{RESERVES['USDC']['atoken']}` (deployed block {dep['USDC']['block']}, {dep['USDC']['utc']});",
        f"  aUSDT `{RESERVES['USDT']['atoken']}` (deployed block {dep['USDT']['block']}, {dep['USDT']['utc']}).",
        f"- **Asof:** block {a['block']} ({B.iso_utc(a['ts'])}, hash `{a['hash']}`), the `finalized` block at start.",
        f"  Anchor inputs: membrane-datasets `{B1_DIR}/` (`2ca6d16`), sha256 checked; its asof block is {B1_ASOF_BLOCK}.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{meta['code'].get('branch')}`, `{meta['code'].get('path')}`",
        "  (helpers imported from `b_acquire.py`). By session:",
        *[f"  {', '.join(x['phases'])}: HEAD `{x['code'].get('sha')}`; builder `{x['code'].get('file_last_commit')}` "
          f"(sha256 `{x['code'].get('file_sha256')}`){' DIRTY' if x['code'].get('dirty') else ''}." for x in sess],
        f"- **Fetch window (UTC):** {meta['fetch_window_utc'][0]} → {meta['fetch_window_utc'][1]}.",
        "- **Status:** CANONICAL, FROZEN (inputs to Q26 B-gradient; do not refetch or edit).",
        "- **Units:** raw integers in 6-decimal underlying units (÷ 1e6 = USD); `index_ray` ÷ 1e27.",
        "- **Formats:**",
        "  - `raw-logs-{usdc,usdt}-<period>.csv.gz`: every log as returned (address, block, tx hash, tx index, log index,",
        "    topic0..3, data), sorted by block then log index.",
        "  - `events-{usdc,usdt}-<period>.csv.gz`: the four decoded types. `party1`/`party2` = Mint onBehalfOf/caller,",
        "    Burn from/target, BalanceTransfer from/to, Transfer from/to. `delta1_raw` = G.2 balance change of party1",
        "    (Mint value − balanceIncrease; Burn −(value + balanceIncrease); BalanceTransfer −rayMul(value, index)),",
        "    `delta2_raw` = change of party2 (BalanceTransfer +rayMul(value, index)); empty = no G.2 change (Transfer",
        "    rows duplicate the paired event and carry none). BalanceTransfer `value_raw` is the scaled amount.",
        "  - `block-timestamps-<period>.csv.gz`: block, ts, block hash for every block with a log of either token.",
        "  - `extended-universe.csv`: every address whose event-reconstructed balance reaches ≥ $1,000,000 at any",
        "    moment (`reaches_1M_by_events`), plus every `P_r` member; `new` = reaches and not in `P_r`. Balance =",
        "    scaled balance (Σ rayDiv(delta, index); BalanceTransfer moves `value` exactly) × the event's index, checked",
        "    before and after every event and at asof (normalized income); float64 for the maximum (±2 raw units).",
        "  - `daily-balances-ext-{usdc,usdt}.csv.gz`: B.1 long format for the new addresses, every B.1 daily snapshot",
        "    from the address's first event day (UTC) on, then `asof` (block 26180400) and `asof_events` (this asof).",
        "  - `gate-report.json`: the gate on P_r and on the new anchors, worst residuals, failure causes, checks.",
        "  - `run-log.json`: request counts, retries, splits, failures, timings, code sha, state.",
        "",
    ]
    for r in RESERVE_ORDER:
        x = dec.get(r, {})
        lines.append(f"{r}: {x.get('n_logs')} logs; by type {json.dumps(x.get('by_type'))}; other known "
                     f"{json.dumps(x.get('other_known'))}; unknown topic0 {json.dumps(x.get('unknown_topic0'))}.")
    if gate:
        p = gate["pooled"]
        lines += ["", f"Gate on P_r: {'PASS' if gate['passes'] else 'FAIL'} — {p['share_pass']:.5f} of {p['n_pairs']} pairs, "
                      f"{p['share_pass_with_event']:.5f} of {p['n_pairs_with_event']} pairs holding an event."]
    if gnew:
        p = gnew["pooled"]
        lines += [f"Gate on new anchors: {'PASS' if gnew['passes'] else 'FAIL'} — {p['share_pass']:.5f} of {p['n_pairs']} "
                  f"pairs, {p['share_pass_with_event']:.5f} of {p['n_pairs_with_event']} pairs holding an event."]
    if uni:
        lines += [f"Extended universe: " + "; ".join(
            f"{r} {uni[r]['n_rule']} reach $1M ({uni[r]['n_new']} new vs P_r {uni[r]['n_P_r']})" for r in RESERVE_ORDER) + "."]
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
        "dataset": "depositor-events", "prereg": PREREG,
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--phases", default="all")
    args = ap.parse_args(argv)
    ddir = datasets_dir()
    out = Path(args.out_dir) if args.out_dir else ddir / "depositor-events"
    ctx = Ctx(Path(args.work_dir), out, ddir)
    phases = PHASES if args.phases == "all" else tuple(p.strip() for p in args.phases.split(","))
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
                    raise B.TerminalError("validation gate FAILED: run stops (G.2)")
            elif p == "universe":
                phase_universe(ctx)
            elif p == "anchors":
                phase_anchors(ctx)
            elif p == "gate_new":
                phase_gate_new(ctx)
                ctx.state["coverage"] = coverage(ctx)
                ctx.save_state()
                print("COVERAGE " + json.dumps(ctx.state["coverage"]), flush=True)
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
