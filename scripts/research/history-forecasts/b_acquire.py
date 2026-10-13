#!/usr/bin/env python3
"""Q26 workstream B data acquisition: exact aToken balances on Aave V3 Ethereum (USDC, USDT).

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG.md` section B.1 (registered at
membrane-board commit 7a5f8a6). It only reads chain state and writes the frozen panel. It
computes no outcome: no exits, episodes, withdrawal rates or hazards.

Phases, each resumable from the work directory (completed results are checkpointed as JSONL):
  preflight   pin the asof block (latest at build time), verify contracts, check decoding
              against the IRM fixture in tests/unit/fixtures/net-apy-irm.json
  blocks      for every daily snapshot T (00:00Z): the largest block with timestamp < T
  monthly     aToken.balanceOf(a) for every a in U_r at the 1st of each month
  population  P_r = (balance >= $1M at >= 1 monthly snapshot) U (supply event >= $1M)
  daily       P_r balances, reserve state and the rate curve at every daily block + asof
  validate    direct (non-multicall) re-reads and data checks
  write       output files, run-log.json, PROVENANCE.md

Usage:
  python3 b_acquire.py --work-dir DIR [--out-dir DIR] [--phases all|p1,p2,...]

RPC: https://eth.drpc.org only (no key). At most 4 requests per second. HTTP 429 or a
rate-limit error (and transient transport errors): wait 30 s and retry the same request, at
most 5 times, then stop. Every retry and failure is logged.
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
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ---------------------------------------------------------------------------------------------
# Fixed by the preregistration (B.1)
# ---------------------------------------------------------------------------------------------

RPC_URL = "https://eth.drpc.org"
USER_AGENT = "curl/8.5.0"  # urllib's default UA gets HTTP 403 from this endpoint

POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
RESERVES = {
    "USDC": {
        "asset": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "atoken": "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
    },
    "USDT": {
        "asset": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "atoken": "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a",
    },
}
RESERVE_ORDER = ("USDC", "USDT")

LENDER_FLOWS_REL = "lender-retention/lender_flows_raw.csv.gz"
LENDER_FLOWS_SHA256 = "1d6bd8df903860311ccf534833d7ed0d76f29a8d6bbc218ede35a8e9324f7ac1"
RESERVE_HISTORY_REL = "rate-spike-flows/reserve_history_daily.csv"
PREREG = {
    "repo": "membrane-board",
    "path": "design/DEPOSITOR_BEHAVIOR_PREREG.md",
    "commit": "7a5f8a6",
    "sha256": "e1f9860f2023818f0aff62ed7a5fbbc8095bd29354d62ad94e10be39ed384451",
}

DAILY_START = dt.date(2023, 2, 1)
DAILY_END = dt.date(2026, 10, 7)  # inclusive
MONTHLY_START = dt.date(2023, 2, 1)
MONTHLY_END = dt.date(2026, 10, 1)  # inclusive
THRESHOLD_RAW = 1_000_000 * 10**6  # $1,000,000 in 6-decimal underlying units
THRESHOLD_USD = 1_000_000.0

MAX_CALLS_PER_MULTICALL = 1000
MAX_REQUESTS_PER_SECOND = 4
WORKERS = 4
RETRY_WAIT_S = 30
MAX_RETRIES = 5
HTTP_TIMEOUT_S = 90

FIXTURE_REL = "tests/unit/fixtures/net-apy-irm.json"
FIXTURE_BLOCK = 26_120_000
VALIDATION_SEED = 20261013
VALIDATION_N = 20

# ---------------------------------------------------------------------------------------------
# Keccak-256 (Ethereum's hash; NOT NIST SHA3-256). Pure Python, only used for selectors.
# ---------------------------------------------------------------------------------------------

_KECCAK_RC = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)
# rotation offsets r[x][y]
_KECCAK_ROT = (
    (0, 36, 3, 41, 18),
    (1, 44, 10, 45, 2),
    (62, 6, 43, 15, 61),
    (28, 55, 25, 21, 56),
    (27, 20, 39, 8, 14),
)
_M64 = (1 << 64) - 1


def _rol64(v: int, n: int) -> int:
    return ((v << n) | (v >> (64 - n))) & _M64 if n else v


def _keccak_f1600(a: list[list[int]]) -> list[list[int]]:
    for rc in _KECCAK_RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol64(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol64(a[x][y], _KECCAK_ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    while len(msg) % rate:
        msg += b"\x00"
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        a = _keccak_f1600(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


# ---------------------------------------------------------------------------------------------
# ABI encode / decode
# ---------------------------------------------------------------------------------------------


class DecodeError(Exception):
    pass


def selector(signature: str) -> bytes:
    return keccak256(signature.encode())[:4]


SIG = {
    "aggregate3": "aggregate3((address,bool,bytes)[])",
    "balanceOf": "balanceOf(address)",
    "totalSupply": "totalSupply()",
    "decimals": "decimals()",
    "getReserveData": "getReserveData(address)",
    "UNDERLYING_ASSET_ADDRESS": "UNDERLYING_ASSET_ADDRESS()",
    "POOL": "POOL()",
    # rate strategy, ABI v1 (DefaultReserveInterestRateStrategy, no args, ray)
    "OPTIMAL_USAGE_RATIO": "OPTIMAL_USAGE_RATIO()",
    "getBaseVariableBorrowRate": "getBaseVariableBorrowRate()",
    "getVariableRateSlope1": "getVariableRateSlope1()",
    "getVariableRateSlope2": "getVariableRateSlope2()",
    # rate strategy, ABI v2 (DefaultReserveInterestRateStrategyV2, per asset, ray struct)
    "getInterestRateData": "getInterestRateData(address)",
}
SEL = {k: selector(v) for k, v in SIG.items()}
V1_CURVE = ("OPTIMAL_USAGE_RATIO", "getBaseVariableBorrowRate", "getVariableRateSlope1", "getVariableRateSlope2")


def norm_address(a: str) -> str:
    a = a.strip().lower()
    if not (a.startswith("0x") and len(a) == 42):
        raise ValueError(f"bad address {a!r}")
    int(a, 16)
    return a


def enc_word(n: int) -> bytes:
    if n < 0 or n >= 1 << 256:
        raise ValueError("uint256 out of range")
    return n.to_bytes(32, "big")


def enc_address(a: str) -> bytes:
    return enc_word(int(norm_address(a), 16))


def call_data(name: str, *address_args: str) -> bytes:
    return SEL[name] + b"".join(enc_address(a) for a in address_args)


def encode_aggregate3(calls: list[tuple[str, bytes]]) -> bytes:
    """aggregate3(Call3[]) with allowFailure = true for every call. calls = [(target, data)]."""
    tails = []
    for target, data in calls:
        pad = (-len(data)) % 32
        tails.append(enc_address(target) + enc_word(1) + enc_word(96) + enc_word(len(data)) + data + b"\x00" * pad)
    n = len(calls)
    offsets, off = [], 32 * n
    for t in tails:
        offsets.append(off)
        off += len(t)
    return SEL["aggregate3"] + enc_word(32) + enc_word(n) + b"".join(enc_word(o) for o in offsets) + b"".join(tails)


def _word(raw: bytes, pos: int) -> int:
    if pos < 0 or pos + 32 > len(raw):
        raise DecodeError(f"read past end at {pos} (len {len(raw)})")
    return int.from_bytes(raw[pos:pos + 32], "big")


def decode_aggregate3_result(raw: bytes, n_expected: int) -> list[tuple[bool, bytes]]:
    """Decode Result[] = (bool success, bytes returnData)[]; strict bounds checks."""
    arr = _word(raw, 0)
    n = _word(raw, arr)
    if n != n_expected:
        raise DecodeError(f"result count {n} != {n_expected}")
    base = arr + 32
    out = []
    for i in range(n):
        tpos = base + _word(raw, base + 32 * i)
        succ = _word(raw, tpos)
        if succ not in (0, 1):
            raise DecodeError(f"bad bool {succ}")
        dpos = tpos + _word(raw, tpos + 32)
        ln = _word(raw, dpos)
        if dpos + 32 + ln > len(raw):
            raise DecodeError("returnData past end")
        out.append((succ == 1, raw[dpos + 32:dpos + 32 + ln]))
    return out


def decode_uint(ret: bytes) -> int:
    if len(ret) != 32:
        raise DecodeError(f"uint len {len(ret)}")
    return int.from_bytes(ret, "big")


def decode_words(ret: bytes) -> list[int]:
    if len(ret) % 32:
        raise DecodeError(f"len {len(ret)} not a multiple of 32")
    return [int.from_bytes(ret[i:i + 32], "big") for i in range(0, len(ret), 32)]


def word_to_address(w: int) -> str:
    if w >> 160:
        raise DecodeError("address word has high bits set")
    return "0x" + w.to_bytes(20, "big").hex()


ZERO_ADDRESS = "0x" + "00" * 20


def reserve_factor_bps(configuration: int) -> int:
    """Reserve factor = bits 64-79 of ReserveConfigurationMap.data."""
    return (configuration >> 64) & 0xFFFF


# getReserveData return layout observed at build time (15 static words)
RD_FIELDS = (
    "configuration", "liquidityIndex", "currentLiquidityRate", "variableBorrowIndex",
    "currentVariableBorrowRate", "currentStableBorrowRate", "lastUpdateTimestamp", "id",
    "aTokenAddress", "stableDebtTokenAddress", "variableDebtTokenAddress",
    "interestRateStrategyAddress", "accruedToTreasury", "unbacked", "isolationModeTotalDebt",
)
RD_ADDRESS_FIELDS = {"aTokenAddress", "stableDebtTokenAddress", "variableDebtTokenAddress", "interestRateStrategyAddress"}


def decode_reserve_data(ok: bool, ret: bytes) -> dict:
    """Return {'status', 'words', fields...}. Fields only when exactly 15 words."""
    if not ok:
        return {"status": "fail", "words": None}
    if len(ret) % 32:
        return {"status": f"badlen:{len(ret)}", "words": None}
    words = decode_words(ret)
    if len(words) != len(RD_FIELDS):
        return {"status": f"words:{len(words)}", "words": len(words)}
    out = {"status": "ok", "words": len(words)}
    for name, w in zip(RD_FIELDS, words):
        out[name] = word_to_address(w) if name in RD_ADDRESS_FIELDS else w
    out["listed"] = out["aTokenAddress"] != ZERO_ADDRESS
    return out


def balance_entry(ok: bool, ret: bytes):
    """Checkpoint form of a balanceOf sub-call: int, or a status string."""
    if not ok:
        return "fail"
    if len(ret) == 0:
        return "empty"  # success with no return data: the target had no code at that block
    if len(ret) != 32:
        return f"badlen:{len(ret)}"
    return int.from_bytes(ret, "big")


def decode_curve(v1: list[tuple[bool, str]] | None, v2: tuple[bool, str] | None) -> dict:
    """v1 = 4 (ok, hex) results in V1_CURVE order; v2 = (ok, hex) of getInterestRateData.
    Values are ray as returned. curve_abi: v1 | v2 | both | none."""
    out = {"v1": None, "v2": None}
    if v1 is not None and all(ok and len(bytes.fromhex(h)) == 32 for ok, h in v1):
        out["v1"] = [int(h, 16) for _, h in v1]
    if v2 is not None and v2[0] and len(bytes.fromhex(v2[1])) == 128:
        out["v2"] = decode_words(bytes.fromhex(v2[1]))
    if out["v1"] and out["v2"]:
        out["abi"] = "both"
        out["main"] = out["v2"] if out["v1"] == out["v2"] else None
    elif out["v1"]:
        out["abi"], out["main"] = "v1", out["v1"]
    elif out["v2"]:
        out["abi"], out["main"] = "v2", out["v2"]
    else:
        out["abi"], out["main"] = "none", None
    return out


# ---------------------------------------------------------------------------------------------
# Block search
# ---------------------------------------------------------------------------------------------

SLOT_S = 12  # post-merge: consecutive blocks are >= 12 s apart (one slot each)


class BlockSearchError(Exception):
    pass


def find_block_before(T: int, get_ts, guess: int, lo: int | None = None, head: int | None = None,
                      max_iter: int = 80) -> tuple[int, int, int]:
    """Largest block b with ts(b) < T. Returns (b, ts(b), ts(b + 1)).

    Correctness rests only on fetched timestamps, which strictly increase with block number: the
    search stops when it holds lo and hi = lo + 1 with ts(lo) < T <= ts(hi), both fetched. The
    12 s slot rule (post-merge, consecutive blocks are >= 12 s apart) only chooses the next
    probe; if it is violated the search falls back to the plain bracket. `lo` is an optional
    block known to have ts(lo) < T; `head` an optional block with ts(head) >= T."""
    known: dict[int, int] = {}

    def ts(b: int) -> int:
        if b not in known:
            known[b] = int(get_ts(b))
        return known[b]

    hi = None
    if lo is not None and ts(lo) >= T:
        raise BlockSearchError(f"seed lo {lo} has ts {ts(lo)} >= T {T}")
    if head is not None:
        if ts(head) < T:
            raise BlockSearchError(f"T {T} is after the head block {head}")
        hi = head
    p = guess
    for _ in range(max_iter):
        if lo is not None and hi is not None and hi == lo + 1:
            return lo, known[lo], known[hi]
        lower = lo + 1 if lo is not None else 0
        if p < lower:
            p = lower
        if hi is not None and p > hi - 1:
            p = hi - 1
        if ts(p) < T:
            lo = p
        else:
            hi = p
        p = _next_probe(T, lo, hi, ts)
    raise BlockSearchError(f"no convergence for T={T}")


def _next_probe(T: int, lo: int | None, hi: int | None, ts) -> int:
    if lo is not None and hi is None:
        return lo + max(1, (T - 1 - ts(lo)) // SLOT_S)
    if hi is not None and lo is None:
        return max(0, hi - max(1, -(-(ts(hi) - T + 1) // SLOT_S)))
    if hi == lo + 1:
        return lo
    ub = min(hi - 1, lo + (T - 1 - ts(lo)) // SLOT_S)          # answer <= ub under the slot rule
    lb = max(lo, hi - (-(-(ts(hi) - T + 1) // SLOT_S)))        # answer >= lb under the slot rule
    if lb > ub:  # slot rule violated (pre-merge or bad data): bisect the plain bracket
        return (lo + hi) // 2 if hi - lo > 1 else lo + 1
    if ub == lo:
        return lo + 1  # answer is lo; fetch lo + 1 for the proof
    if (T - ts(lo)) <= (ts(hi) - T):
        return ub      # nearer to lo: its bound is the tighter one
    return lb if lb > lo else ub


def utc_ts(d: dt.date) -> int:
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp())


def iso_utc(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def daily_dates() -> list[dt.date]:
    out, d = [], DAILY_START
    while d <= DAILY_END:
        out.append(d)
        d += dt.timedelta(days=1)
    return out


def monthly_dates() -> list[dt.date]:
    out, d = [], MONTHLY_START
    while d <= MONTHLY_END:
        out.append(d)
        d = dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return out


# ---------------------------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------------------------


def chunk(seq: list, size: int = MAX_CALLS_PER_MULTICALL) -> list[list]:
    return [seq[i:i + size] for i in range(0, len(seq), size)]


N_DEPENDENT_MAX = 12  # per reserve: variableDebt.totalSupply + 4 v1 curve + 1 v2 curve


def daily_layout(n_lead: int, n_bal: int) -> tuple[list[tuple[int, int]], int]:
    """Plan of a daily block: positions [0, n_lead + n_bal) of the call list L (lead state calls
    then balances) split into chunks of <= 1000. Returns (spans, dep_chunk): spans[i] = (start,
    end) into L; dep_chunk = index of the chunk that also carries the <= 12 dependent calls
    (they need chunk 0's getReserveData), always > 0 and with room for 12."""
    total = n_lead + n_bal
    spans = [(s, min(s + MAX_CALLS_PER_MULTICALL, total)) for s in range(0, total, MAX_CALLS_PER_MULTICALL)]
    last = spans[-1]
    if len(spans) > 1 and (last[1] - last[0]) + N_DEPENDENT_MAX <= MAX_CALLS_PER_MULTICALL:
        return spans, len(spans) - 1
    return spans, len(spans)  # a separate final chunk with only the dependent calls


# ---------------------------------------------------------------------------------------------
# JSONL checkpoint store
# ---------------------------------------------------------------------------------------------


class JsonlStore:
    """Append-only key -> object store. A torn last line (crash mid-write) is truncated."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.data: dict[str, dict] = {}
        if self.path.exists():
            raw = self.path.read_bytes()
            if raw and not raw.endswith(b"\n"):
                cut = raw.rfind(b"\n") + 1
                raw = raw[:cut]
                with open(self.path, "r+b") as f:
                    f.truncate(cut)
            for line in raw.splitlines():
                if line.strip():
                    obj = json.loads(line)
                    self.data[json.dumps(obj["k"])] = obj
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _key(k) -> str:
        return json.dumps(list(k) if isinstance(k, tuple) else k)

    def has(self, k) -> bool:
        return self._key(k) in self.data

    def get(self, k):
        return self.data.get(self._key(k))

    def put(self, k, obj: dict) -> None:
        rec = {"k": list(k) if isinstance(k, tuple) else k, **obj}
        line = json.dumps(rec, separators=(",", ":")) + "\n"
        with self.lock:
            with open(self.path, "a") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
            self.data[self._key(k)] = rec

    def values(self):
        return list(self.data.values())


# ---------------------------------------------------------------------------------------------
# RPC client: pacing, retries, logging
# ---------------------------------------------------------------------------------------------


class TerminalError(Exception):
    pass


class RateLimited(Exception):
    pass


class Transient(Exception):
    pass


class Fatal(Exception):
    pass


class Pacer:
    """At most one request start per `interval` seconds across all threads (<= 4 req/s)."""

    def __init__(self, interval: float):
        self.interval = interval
        self.lock = threading.Lock()
        self.next_t = 0.0
        self.pause_until = 0.0

    def wait(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                t = max(now, self.next_t, self.pause_until)
                self.next_t = t + self.interval
            if t > now:
                time.sleep(t - now)
            with self.lock:
                if time.monotonic() >= self.pause_until:
                    return

    def pause(self, seconds: float) -> None:
        with self.lock:
            self.pause_until = max(self.pause_until, time.monotonic() + seconds)


_RATE_WORDS = ("rate limit", "rate-limit", "ratelimit", "too many", "limit exceeded", "exceeded the", "throttl", "quota", "capacity", "429")
_TRANSIENT_WORDS = ("timeout", "timed out", "temporar", "unavailable", "upstream", "try again", "busy", "overload",
                    "header not found", "missing trie node", "internal error", "bad gateway", "gateway")


def classify_rpc_error(err: dict) -> type:
    msg = str(err.get("message", "")).lower() + " " + str(err.get("data", "")).lower()
    code = err.get("code")
    if code in (429, -32005) or any(w in msg for w in _RATE_WORDS):
        return RateLimited
    if "revert" in msg:
        return Fatal
    if code == -32603 or any(w in msg for w in _TRANSIENT_WORDS):
        return Transient
    return Fatal


class Rpc:
    def __init__(self, url: str, events_path: Path | None, interval: float = 1.0 / MAX_REQUESTS_PER_SECOND,
                 retry_wait: float = RETRY_WAIT_S, max_retries: int = MAX_RETRIES, sleep=time.sleep):
        self.url = url
        self.pacer = Pacer(interval)
        self.retry_wait = retry_wait
        self.max_retries = max_retries
        self.sleep = sleep
        self.lock = threading.Lock()
        self.events_path = events_path
        self.stop = threading.Event()
        self.counts = {"http_requests": 0, "by_method": {}, "by_phase": {}, "retries": 0, "failures": 0,
                       "rate_limit_retries": 0, "transient_retries": 0, "seconds_in_requests": 0.0}
        self._id = 0

    def log_event(self, ev: dict) -> None:
        ev = {"utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"), **ev}
        print("EVENT " + json.dumps(ev), flush=True)
        if self.events_path:
            with self.lock:
                with open(self.events_path, "a") as f:
                    f.write(json.dumps(ev) + "\n")

    def _post(self, payload: bytes):
        req = urllib.request.Request(self.url, data=payload, headers={
            "content-type": "application/json", "accept": "application/json", "user-agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
                body = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise RateLimited("HTTP 429")
            if e.code >= 500 or e.code == 408:
                raise Transient(f"HTTP {e.code}")
            raise Fatal(f"HTTP {e.code}")
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, http.client.HTTPException) as e:
            raise Transient(f"{type(e).__name__}: {e}")
        try:
            return json.loads(body)
        except ValueError:
            raise Transient(f"non-JSON body ({len(body)} bytes): {body[:120]!r}")

    def call(self, method: str, params: list, phase: str, tag: str = "", validate=None):
        """One JSON-RPC call in its own HTTP request. `validate(result)` may raise DecodeError,
        which is retried like a transient error. A retry re-sends the identical payload."""
        with self.lock:
            self._id += 1
            rid = self._id
        payload = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode()
        retries = 0
        while True:
            if self.stop.is_set():
                raise TerminalError("stopped")
            self.pacer.wait()
            with self.lock:
                self.counts["http_requests"] += 1
                self.counts["by_method"][method] = self.counts["by_method"].get(method, 0) + 1
                self.counts["by_phase"][phase] = self.counts["by_phase"].get(phase, 0) + 1
            try:
                t0 = time.monotonic()
                try:
                    body = self._post(payload)
                finally:
                    with self.lock:
                        self.counts["seconds_in_requests"] += time.monotonic() - t0
                if not isinstance(body, dict):
                    raise Transient(f"unexpected body type {type(body).__name__}")
                if body.get("error") is not None:
                    err = body["error"]
                    kind = classify_rpc_error(err if isinstance(err, dict) else {"message": str(err)})
                    raise kind(f"rpc error {json.dumps(err)[:300]}")
                if "result" not in body:
                    raise Transient("no result field")
                result = body["result"]
                if validate is not None:
                    try:
                        validate(result)
                    except DecodeError as e:
                        raise Transient(f"decode: {e}")
                return result
            except (RateLimited, Transient) as e:
                kind = "rate_limit" if isinstance(e, RateLimited) else "transient"
                retries += 1
                if retries > self.max_retries:
                    with self.lock:
                        self.counts["failures"] += 1
                    self.log_event({"type": "failure", "kind": kind, "phase": phase, "tag": tag, "method": method,
                                    "retries": retries - 1, "error": str(e)[:400]})
                    self.stop.set()
                    raise TerminalError(f"{kind} after {self.max_retries} retries: {e}")
                with self.lock:
                    self.counts["retries"] += 1
                    self.counts[f"{kind}_retries"] += 1
                self.log_event({"type": "retry", "kind": kind, "phase": phase, "tag": tag, "method": method,
                                "attempt": retries, "error": str(e)[:400], "wait_s": self.retry_wait})
                if isinstance(e, RateLimited):
                    self.pacer.pause(self.retry_wait)
                self.sleep(self.retry_wait)
            except Fatal as e:
                with self.lock:
                    self.counts["failures"] += 1
                self.log_event({"type": "failure", "kind": "fatal", "phase": phase, "tag": tag, "method": method,
                                "error": str(e)[:400]})
                self.stop.set()
                raise TerminalError(f"fatal: {e}")

    # helpers ---------------------------------------------------------------------------------

    def block_ts(self, block: int, phase: str = "blocks") -> int:
        def v(res):
            if not isinstance(res, dict) or "timestamp" not in res or int(res["number"], 16) != block:
                raise DecodeError("bad block object")
        res = self.call("eth_getBlockByNumber", [hex(block), False], phase, tag=f"block {block}", validate=v)
        return int(res["timestamp"], 16)

    def block_obj(self, tag_or_num, phase: str) -> dict:
        p = tag_or_num if isinstance(tag_or_num, str) else hex(tag_or_num)

        def v(res):
            if not isinstance(res, dict) or "timestamp" not in res:
                raise DecodeError("bad block object")
        return self.call("eth_getBlockByNumber", [p, False], phase, tag=f"block {p}", validate=v)

    def eth_call(self, to: str, data: bytes, block: int, phase: str, tag: str = "", validate=None) -> bytes:
        def v(res):
            if not isinstance(res, str) or not res.startswith("0x") or len(res) % 2:
                raise DecodeError("bad eth_call result")
            if validate:
                validate(bytes.fromhex(res[2:]))
        res = self.call("eth_call", [{"to": to, "data": "0x" + data.hex()}, hex(block)], phase, tag=tag, validate=v)
        return bytes.fromhex(res[2:])

    def multicall(self, calls: list[tuple[str, bytes]], block: int, phase: str, tag: str = "") -> list[tuple[bool, bytes]]:
        if not 0 < len(calls) <= MAX_CALLS_PER_MULTICALL:
            raise ValueError(f"multicall size {len(calls)}")
        n = len(calls)
        raw = self.eth_call(MULTICALL3, encode_aggregate3(calls), block, phase, tag=tag,
                            validate=lambda b: decode_aggregate3_result(b, n))
        return decode_aggregate3_result(raw, n)


# ---------------------------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def datasets_dir() -> Path:
    env = os.environ.get("MEMBRANE_DATASETS_DIR")
    return Path(env) if env else repo_root().parent / "membrane-datasets"


def git_info() -> dict:
    root = repo_root()
    try:
        sha = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        branch = subprocess.check_output(["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"], text=True).strip()
        rel = str(Path(__file__).resolve().relative_to(root))
        dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--", rel], text=True).strip()
        return {"sha": sha, "branch": branch, "path": rel, "dirty": bool(dirty)}
    except Exception as e:  # pragma: no cover
        return {"error": str(e)}


class Ctx:
    def __init__(self, work: Path, out: Path, rpc: Rpc, workers: int = WORKERS):
        self.work = Path(work)
        self.out = Path(out)
        self.rpc = rpc
        self.workers = workers
        self.work.mkdir(parents=True, exist_ok=True)
        self.ts_cache = JsonlStore(self.work / "ts_cache.jsonl")
        self.blocks = JsonlStore(self.work / "blocks.jsonl")
        self.monthly = JsonlStore(self.work / "monthly.jsonl")
        self.daily = JsonlStore(self.work / "daily.jsonl")
        self.state = self._load_json("state.json", {})

    def _load_json(self, name, default):
        p = self.work / name
        return json.loads(p.read_text()) if p.exists() else default

    def save_state(self) -> None:
        tmp = self.work / "state.json.tmp"
        tmp.write_text(json.dumps(self.state, indent=1, sort_keys=True))
        os.replace(tmp, self.work / "state.json")

    def get_ts(self, block: int, phase: str = "blocks") -> int:
        rec = self.ts_cache.get(block)
        if rec is not None:
            return rec["ts"]
        ts = self.rpc.block_ts(block, phase)
        self.ts_cache.put(block, {"ts": ts})
        return ts


def progress(phase: str, done: int, total: int, t0: float, rpc: Rpc) -> None:
    el = time.monotonic() - t0
    rate = done / el if el > 0 else 0
    eta = (total - done) / rate if rate > 0 else float("nan")
    print(f"PROGRESS {phase} {done}/{total} elapsed={el:.0f}s eta={eta:.0f}s http={rpc.counts['http_requests']} "
          f"retries={rpc.counts['retries']}", flush=True)


def run_pool(ctx: Ctx, phase: str, tasks: list, fn) -> None:
    """Run fn(task) in a pool of workers; stop all on TerminalError."""
    t0 = time.monotonic()
    total = len(tasks)
    done = 0
    err = None
    with ThreadPoolExecutor(max_workers=ctx.workers) as ex:
        futs = [ex.submit(fn, t) for t in tasks]
        for f in as_completed(futs):
            try:
                f.result()
            except TerminalError as e:
                err = err or e
                ctx.rpc.stop.set()
            except Exception as e:  # unexpected: stop and surface
                err = err or e
                ctx.rpc.stop.set()
            done += 1
            if done % 50 == 0 or done == total:
                progress(phase, done, total, t0, ctx.rpc)
    if err is not None:
        raise err if isinstance(err, TerminalError) else TerminalError(f"{type(err).__name__}: {err}")


# ---------------------------------------------------------------------------------------------
# Phase: preflight
# ---------------------------------------------------------------------------------------------


def phase_preflight(ctx: Ctx) -> None:
    rpc = ctx.rpc
    if "asof" not in ctx.state:
        b = rpc.block_obj("latest", "preflight")
        ctx.state["asof"] = {"block": int(b["number"], 16), "ts": int(b["timestamp"], 16), "hash": b["hash"],
                             "pinned_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "rule": "eth_getBlockByNumber('latest') at build time, pinned by number"}
        ctx.save_state()
    asof = ctx.state["asof"]["block"]
    if "preflight" in ctx.state:
        return
    pf = {"block": asof, "code_bytes": {}, "checks": {}}
    names = {"Pool": POOL, "Multicall3": MULTICALL3}
    for r in RESERVE_ORDER:
        names[r] = RESERVES[r]["asset"]
        names["a" + r] = RESERVES[r]["atoken"]
    for name, addr in names.items():
        code = rpc.call("eth_getCode", [addr, hex(asof)], "preflight", tag=f"code {name}")
        pf["code_bytes"][name] = (len(code) - 2) // 2
    calls, labels = [], []
    for r in RESERVE_ORDER:
        a, at = RESERVES[r]["asset"], RESERVES[r]["atoken"]
        for lab, tgt, data in (("rd", POOL, call_data("getReserveData", a)),
                               ("underlying", at, call_data("UNDERLYING_ASSET_ADDRESS")),
                               ("pool", at, call_data("POOL")),
                               ("dec_asset", a, call_data("decimals")),
                               ("dec_atoken", at, call_data("decimals"))):
            calls.append((tgt, data))
            labels.append((r, lab))
    res = rpc.multicall(calls, asof, "preflight", tag="verify")
    for (r, lab), (ok, ret) in zip(labels, res):
        c = pf["checks"].setdefault(r, {})
        if lab == "rd":
            rd = decode_reserve_data(ok, ret)
            c["rd_words"] = rd["words"]
            c["rd_aToken_matches"] = rd.get("aTokenAddress") == norm_address(RESERVES[r]["atoken"])
            c["strategy"] = rd.get("interestRateStrategyAddress")
            c["variableDebtToken"] = rd.get("variableDebtTokenAddress")
        elif lab == "underlying":
            c["aToken_underlying_matches"] = ok and word_to_address(decode_uint(ret)) == norm_address(RESERVES[r]["asset"])
        elif lab == "pool":
            c["aToken_pool_matches"] = ok and word_to_address(decode_uint(ret)) == norm_address(POOL)
        else:
            c[lab] = decode_uint(ret) if ok else None
    ok_all = all(v > 0 for v in pf["code_bytes"].values()) and all(
        c["rd_words"] == 15 and c["rd_aToken_matches"] and c["aToken_underlying_matches"] and c["aToken_pool_matches"]
        and c["dec_asset"] == 6 and c["dec_atoken"] == 6 for c in pf["checks"].values())
    pf["all_ok"] = ok_all
    pf["fixture"] = fixture_check(ctx)
    ctx.state["preflight"] = pf
    ctx.save_state()
    print("PREFLIGHT " + json.dumps(pf), flush=True)
    if not ok_all:
        raise TerminalError("contract verification failed")


def fixture_check(ctx: Ctx) -> dict:
    """Decode getReserveData and both curve ABIs at the fixture block; compare with the fixture."""
    fx = json.loads((repo_root() / FIXTURE_REL).read_text())
    by_key = {s["venueKey"]: s for s in fx["snapshots"]}
    block = int(fx["anchor"]["blockNumber"].rstrip("n"))
    out = {"block": block, "fixture": FIXTURE_REL, "reserves": {}}
    rd_calls = [(POOL, call_data("getReserveData", RESERVES[r]["asset"])) for r in RESERVE_ORDER]
    rd_calls += [(RESERVES[r]["atoken"], call_data("totalSupply")) for r in RESERVE_ORDER]
    res = ctx.rpc.multicall(rd_calls, block, "preflight", tag="fixture rd")
    rds = {r: decode_reserve_data(*res[i]) for i, r in enumerate(RESERVE_ORDER)}
    ts = {r: decode_uint(res[2 + i][1]) for i, r in enumerate(RESERVE_ORDER)}
    calls, labels = [], []
    for r in RESERVE_ORDER:
        strat = rds[r]["interestRateStrategyAddress"]
        for nm in V1_CURVE:
            calls.append((strat, call_data(nm)))
            labels.append((r, nm))
        calls.append((strat, call_data("getInterestRateData", RESERVES[r]["asset"])))
        labels.append((r, "getInterestRateData"))
    res2 = ctx.rpc.multicall(calls, block, "preflight", tag="fixture curve")
    for r in RESERVE_ORDER:
        idx = [i for i, (rr, _) in enumerate(labels) if rr == r]
        v1 = [(res2[i][0], res2[i][1].hex()) for i in idx[:4]]
        v2 = (res2[idx[4]][0], res2[idx[4]][1].hex())
        cur = decode_curve(v1, v2)
        f = by_key[f"aave-v3-{r.lower()}"]
        irm, st = f["irm"], f["state"]
        num = lambda s: int(str(s).rstrip("n"))
        exp_curve = [num(irm[k]) * 10**23 for k in ("optimalUsageRatioBps", "baseVariableBorrowRateBps",
                                                     "variableRateSlope1Bps", "variableRateSlope2Bps")]
        rd = rds[r]
        out["reserves"][r] = {
            "curve_abi": cur["abi"], "curve_ray": cur["main"], "curve_expected_ray_from_bps": exp_curve,
            "curve_matches": cur["main"] == exp_curve,
            "strategy_matches": rd["interestRateStrategyAddress"] == norm_address(irm["strategy"]),
            "aToken_matches": rd["aTokenAddress"] == norm_address(st["aToken"]),
            "variableDebtToken_matches": rd["variableDebtTokenAddress"] == norm_address(st["variableDebtToken"]),
            "liquidityRate_matches": rd["currentLiquidityRate"] == num(st["storedLiquidityRateRay"]),
            "variableBorrowRate_matches": rd["currentVariableBorrowRate"] == num(st["storedVariableBorrowRateRay"]),
            "RF_bps": reserve_factor_bps(rd["configuration"]), "RF_matches": reserve_factor_bps(rd["configuration"]) == num(st["reserveFactorBps"]),
            "lastUpdateTimestamp_matches": rd["lastUpdateTimestamp"] == num(st["lastUpdateTimestamp"]),
            "aToken_totalSupply": ts[r], "fixture_totalSupplied": num(st["totalSupplied"]),
            "totalSupply_matches": ts[r] == num(st["totalSupplied"]),
        }
    return out


# ---------------------------------------------------------------------------------------------
# Phase: blocks
# ---------------------------------------------------------------------------------------------


def snapshot_list(ctx: Ctx) -> list[tuple[str, int]]:
    return [(d.isoformat(), utc_ts(d)) for d in daily_dates()]


def phase_blocks(ctx: Ctx) -> None:
    rpc = ctx.rpc
    asof = ctx.state["asof"]
    head, head_ts = asof["block"], asof["ts"]
    if not ctx.ts_cache.has(head):
        ctx.ts_cache.put(head, {"ts": head_ts})
    if "anchor" not in ctx.state:
        ab = 16_500_000
        ctx.state["anchor"] = {"block": ab, "ts": ctx.get_ts(ab)}
        ctx.save_state()
    anc = ctx.state["anchor"]
    snaps = snapshot_list(ctx)
    n = len(snaps)
    k = ctx.workers
    bounds = [(i * n) // k for i in range(k + 1)]
    segs = [snaps[bounds[i]:bounds[i + 1]] for i in range(k)]
    t0 = time.monotonic()
    done_count = [sum(1 for s, _ in snaps if ctx.blocks.has(s))]

    def run_segment(seg):
        prev = None  # (block, ts) of the previous solved day
        prev2 = None
        for label, T in seg:
            if rpc.stop.is_set():
                raise TerminalError("stopped")
            rec = ctx.blocks.get(label)
            if rec is not None:
                prev2, prev = prev, (rec["block"], rec["block_ts"])
                continue
            if prev is not None and prev2 is not None and prev[0] > prev2[0]:
                rate = (prev[1] - prev2[1]) / (prev[0] - prev2[0])
                guess = prev[0] + int(round((T - prev[1]) / rate))
            elif prev is not None:
                guess = prev[0] + int(round((T - prev[1]) / 12.08))
            else:
                guess = anc["block"] + int(round((T - anc["ts"]) * (head - anc["block"]) / (head_ts - anc["ts"])))
            b, bts, nts = find_block_before(T, lambda x: ctx.get_ts(x), guess,
                                            lo=prev[0] if prev is not None else None, head=head)
            if not (bts < T <= nts):
                raise TerminalError(f"block proof failed for {label}")
            ctx.blocks.put(label, {"T": T, "block": b, "block_ts": bts, "next_ts": nts})
            prev2, prev = prev, (b, bts)
            with rpc.lock:
                done_count[0] += 1
                if done_count[0] % 50 == 0:
                    progress("blocks", done_count[0], n, t0, rpc)

    run_pool(ctx, "blocks", segs, run_segment)
    progress("blocks", sum(1 for s, _ in snaps if ctx.blocks.has(s)), n, t0, rpc)


# ---------------------------------------------------------------------------------------------
# Universe and monthly selection
# ---------------------------------------------------------------------------------------------


def load_flows(ddir: Path):
    import pandas as pd
    p = ddir / LENDER_FLOWS_REL
    got = sha256_file(p)
    if got != LENDER_FLOWS_SHA256:
        raise TerminalError(f"lender flows sha256 mismatch: {got}")
    return pd.read_csv(p, dtype={"user_id": str, "reserve": str, "event_type": str})


def universe(flows) -> dict[str, list[str]]:
    out = {}
    for r in RESERVE_ORDER:
        u = flows.loc[flows["reserve"] == r, "user_id"].map(norm_address).unique().tolist()
        out[r] = sorted(u)
    return out


def phase_monthly(ctx: Ctx, U: dict[str, list[str]]) -> None:
    tasks = []
    for d in monthly_dates():
        label = d.isoformat()
        blk = ctx.blocks.get(label)
        if blk is None:
            raise TerminalError(f"no block for {label}")
        for r in RESERVE_ORDER:
            for ci, _ in enumerate(chunk(U[r])):
                if not ctx.monthly.has((label, r, ci)):
                    tasks.append((label, blk["block"], r, ci))
    print(f"monthly: {len(tasks)} chunk requests to do", flush=True)
    chunks = {r: chunk(U[r]) for r in RESERVE_ORDER}

    def do(task):
        label, block, r, ci = task
        if ctx.rpc.stop.is_set():
            raise TerminalError("stopped")
        addrs = chunks[r][ci]
        at = RESERVES[r]["atoken"]
        res = ctx.rpc.multicall([(at, call_data("balanceOf", a)) for a in addrs], block, "monthly",
                                tag=f"monthly {label} {r} {ci}")
        ctx.monthly.put((label, r, ci), {"block": block, "first": addrs[0], "n": len(addrs),
                                         "v": [balance_entry(ok, ret) for ok, ret in res]})

    run_pool(ctx, "monthly", tasks, do)


def monthly_table(ctx: Ctx, U: dict[str, list[str]]):
    """Yields (label, block, reserve, address, entry) for every monthly sub-call."""
    chunks = {r: chunk(U[r]) for r in RESERVE_ORDER}
    for d in monthly_dates():
        label = d.isoformat()
        for r in RESERVE_ORDER:
            for ci, addrs in enumerate(chunks[r]):
                rec = ctx.monthly.get((label, r, ci))
                if rec is None:
                    raise TerminalError(f"monthly chunk missing {label} {r} {ci}")
                if rec["first"] != addrs[0] or rec["n"] != len(addrs):
                    raise TerminalError(f"monthly chunk layout changed {label} {r} {ci}")
                for a, v in zip(addrs, rec["v"]):
                    yield label, rec["block"], r, a, v


def phase_population(ctx: Ctx, U, flows) -> dict:
    if "population" in ctx.state:
        return ctx.state["population"]
    by_bal: dict[str, dict[str, int]] = {r: {} for r in RESERVE_ORDER}
    max_bal: dict[str, dict[str, int]] = {r: {} for r in RESERVE_ORDER}
    for label, block, r, a, v in monthly_table(ctx, U):
        if isinstance(v, int):
            if v > max_bal[r].get(a, -1):
                max_bal[r][a] = v
            if v >= THRESHOLD_RAW:
                by_bal[r][a] = 1
    sup = flows[(flows["event_type"] == "supply") & (flows["amount_usd"] >= THRESHOLD_USD)]
    pop = {}
    for r in RESERVE_ORDER:
        ev = set(sup.loc[sup["reserve"] == r, "user_id"].map(norm_address))
        bal = set(by_bal[r])
        members = sorted(bal | ev)
        rows = []
        for a in members:
            rule = "both" if (a in bal and a in ev) else ("balance" if a in bal else "supply_event")
            rows.append([a, rule, max_bal[r].get(a)])
        pop[r] = {"rows": rows, "n": len(members), "n_balance_rule": len(bal), "n_event_rule": len(ev),
                  "n_balance_only": len(bal - ev), "n_event_only": len(ev - bal), "n_both": len(bal & ev),
                  "n_universe": len(U[r])}
    ctx.state["population"] = pop
    ctx.save_state()
    for r in RESERVE_ORDER:
        print(f"POPULATION {r}: " + json.dumps({k: v for k, v in pop[r].items() if k != "rows"}), flush=True)
    return pop


# ---------------------------------------------------------------------------------------------
# Phase: daily
# ---------------------------------------------------------------------------------------------


def lead_calls() -> list[tuple[tuple, str, bytes]]:
    """State calls that need no prior read: per reserve getReserveData, aToken.totalSupply, cash."""
    out = []
    for r in RESERVE_ORDER:
        a, at = RESERVES[r]["asset"], RESERVES[r]["atoken"]
        out.append((("rd", r), POOL, call_data("getReserveData", a)))
        out.append((("aTotalSupply", r), at, call_data("totalSupply")))
        out.append((("cash", r), a, call_data("balanceOf", at)))
    return out


def dependent_calls(rd_by_reserve: dict[str, dict]) -> list[tuple[tuple, str, bytes]]:
    """Calls on addresses read from getReserveData at the same block. Skipped for a reserve whose
    getReserveData did not decode or that is not listed (zero aToken)."""
    out = []
    for r in RESERVE_ORDER:
        rd = rd_by_reserve.get(r)
        if not rd or rd.get("status") != "ok" or not rd.get("listed"):
            continue
        vdt, strat = rd["variableDebtTokenAddress"], rd["interestRateStrategyAddress"]
        if vdt != ZERO_ADDRESS:
            out.append((("vdTotalSupply", r, vdt), vdt, call_data("totalSupply")))
        if strat != ZERO_ADDRESS:
            for nm in V1_CURVE:
                out.append((("v1", r, strat, nm), strat, call_data(nm)))
            out.append((("v2", r, strat), strat, call_data("getInterestRateData", RESERVES[r]["asset"])))
    return out


def daily_snapshots(ctx: Ctx) -> list[tuple[str, int]]:
    out = []
    for d in daily_dates():
        rec = ctx.blocks.get(d.isoformat())
        if rec is None:
            raise TerminalError(f"no block for {d}")
        out.append((d.isoformat(), rec["block"]))
    out.append(("asof", ctx.state["asof"]["block"]))
    return out


def daily_plan(pop: dict) -> tuple[list, list, int]:
    lead = lead_calls()
    bal = []
    for r in RESERVE_ORDER:
        at = RESERVES[r]["atoken"]
        for a, _, _ in pop[r]["rows"]:
            bal.append((("bal", r, a), at, call_data("balanceOf", a)))
    return lead, bal, len(lead)


def phase_daily(ctx: Ctx, pop: dict) -> None:
    lead, bal, n_lead = daily_plan(pop)
    L = lead + bal
    spans, dep_chunk = daily_layout(n_lead, len(bal))
    n_chunks = max(len(spans), dep_chunk + 1)
    snaps = daily_snapshots(ctx)
    todo = [(s, b) for s, b in snaps if not all(ctx.daily.has((s, ci)) for ci in range(n_chunks))]
    print(f"daily: {len(todo)} of {len(snaps)} snapshots to do; {n_chunks} requests each "
          f"(L={len(L)}, dependent calls in chunk {dep_chunk})", flush=True)
    ctx.state["daily_layout"] = {"n_lead": n_lead, "n_bal": len(bal), "spans": spans, "dep_chunk": dep_chunk}
    ctx.save_state()

    def encode_entry(label, ok, ret):
        if label[0] == "bal":
            return balance_entry(ok, ret)
        return [1 if ok else 0, ret.hex()]

    def do(task):
        snap, block = task
        if ctx.rpc.stop.is_set():
            raise TerminalError("stopped")
        rec0 = ctx.daily.get((snap, 0))
        if rec0 is None:
            specs = L[spans[0][0]:spans[0][1]]
            res = ctx.rpc.multicall([(t, d) for _, t, d in specs], block, "daily", tag=f"daily {snap} 0")
            rec0 = {"block": block, "v": [encode_entry(lab, ok, ret) for (lab, _, _), (ok, ret) in zip(specs, res)]}
            ctx.daily.put((snap, 0), rec0)
        rd = {}
        for i, (lab, _, _) in enumerate(L[:n_lead]):
            if lab[0] == "rd":
                ok, h = rec0["v"][i]
                rd[lab[1]] = decode_reserve_data(bool(ok), bytes.fromhex(h))
        dep = dependent_calls(rd)
        for ci in range(1, n_chunks):
            if ctx.daily.has((snap, ci)):
                continue
            specs = L[spans[ci][0]:spans[ci][1]] if ci < len(spans) else []
            extra = dep if ci == dep_chunk else []
            allspecs = specs + extra
            if not allspecs:
                ctx.daily.put((snap, ci), {"block": block, "dep": [], "v": []})
                continue
            res = ctx.rpc.multicall([(t, d) for _, t, d in allspecs], block, "daily", tag=f"daily {snap} {ci}")
            vals = [encode_entry(lab, ok, ret) for (lab, _, _), (ok, ret) in zip(allspecs, res)]
            ctx.daily.put((snap, ci), {"block": block, "dep": [list(lab) for lab, _, _ in extra], "v": vals})

    run_pool(ctx, "daily", todo, do)


def daily_records(ctx: Ctx, pop: dict):
    """Reassemble each daily snapshot: returns {snap: {"block", "lead": {label: (ok, bytes)},
    "bal": {(r, a): entry}, "dep": {label: (ok, bytes)}}}."""
    lead, bal, n_lead = daily_plan(pop)
    L = lead + bal
    lay = ctx.state["daily_layout"]
    spans = [tuple(s) for s in lay["spans"]]
    dep_chunk = lay["dep_chunk"]
    n_chunks = max(len(spans), dep_chunk + 1)
    out = {}
    for snap, block in daily_snapshots(ctx):
        rec = {"block": block, "lead": {}, "bal": {}, "dep": {}}
        for ci in range(n_chunks):
            c = ctx.daily.get((snap, ci))
            if c is None:
                raise TerminalError(f"daily chunk missing {snap} {ci}")
            if c["block"] != block:
                raise TerminalError(f"daily block mismatch {snap} {ci}")
            specs = L[spans[ci][0]:spans[ci][1]] if ci < len(spans) else []
            vals = c["v"]
            for (lab, _, _), v in zip(specs, vals[:len(specs)]):
                if lab[0] == "bal":
                    rec["bal"][(lab[1], lab[2])] = v
                else:
                    rec["lead"][lab] = (bool(v[0]), bytes.fromhex(v[1]))
            for lab, v in zip(c.get("dep", []), vals[len(specs):]):
                rec["dep"][tuple(lab)] = (bool(v[0]), bytes.fromhex(v[1]))
        out[snap] = rec
    return out


def reserve_state_rows(ctx: Ctx, recs: dict) -> list[dict]:
    rows = []
    for snap, rec in recs.items():
        blk = ctx.blocks.get(snap) if snap != "asof" else None
        block_ts = blk["block_ts"] if blk else ctx.state["asof"]["ts"]
        for r in RESERVE_ORDER:
            row = {"snapshot": snap, "reserve": r, "block": rec["block"], "block_ts": block_ts}
            rd = decode_reserve_data(*rec["lead"][("rd", r)])
            row["rd_status"] = rd["status"]
            row["rd_words"] = rd["words"]
            for lab, col in (("aTotalSupply", "totalSupply"), ("cash", "cash")):
                ok, ret = rec["lead"][(lab, r)]
                row[col] = decode_uint(ret) if ok and len(ret) == 32 else None
                row[col + "_status"] = "ok" if ok and len(ret) == 32 else ("fail" if not ok else ("empty" if not ret else f"badlen:{len(ret)}"))
            listed = rd.get("status") == "ok" and rd.get("listed")
            row["listed"] = int(bool(listed)) if rd.get("status") == "ok" else None
            for f in ("liquidityIndex", "variableBorrowIndex", "lastUpdateTimestamp"):
                row[f] = rd.get(f)
            row["liquidityRate_ray"] = rd.get("currentLiquidityRate")
            row["variableBorrowRate_ray"] = rd.get("currentVariableBorrowRate")
            row["configuration"] = rd.get("configuration")
            row["RF_bps"] = reserve_factor_bps(rd["configuration"]) if rd.get("status") == "ok" else None
            row["aToken_rd"] = rd.get("aTokenAddress")
            row["aToken_matches"] = (int(rd.get("aTokenAddress") == norm_address(RESERVES[r]["atoken"]))
                                     if rd.get("status") == "ok" else None)
            row["variableDebtToken"] = rd.get("variableDebtTokenAddress")
            row["strategy"] = rd.get("interestRateStrategyAddress")
            vd = [(lab, v) for lab, v in rec["dep"].items() if lab[0] == "vdTotalSupply" and lab[1] == r]
            if vd:
                ok, ret = vd[0][1]
                row["variableDebt"] = decode_uint(ret) if ok and len(ret) == 32 else None
                row["variableDebt_status"] = "ok" if ok and len(ret) == 32 else ("fail" if not ok else ("empty" if not ret else f"badlen:{len(ret)}"))
            else:
                row["variableDebt"] = None
                row["variableDebt_status"] = ("rd_" + rd["status"]) if rd.get("status") != "ok" else (
                    "not_listed" if not listed else "not_called")
            v1 = [rec["dep"].get(("v1", r, row["strategy"], nm)) for nm in V1_CURVE] if row["strategy"] else [None] * 4
            v2 = rec["dep"].get(("v2", r, row["strategy"])) if row["strategy"] else None
            called = v2 is not None
            cur = decode_curve([(ok, ret.hex()) for ok, ret in v1] if all(v1) else None,
                               (v2[0], v2[1].hex()) if v2 else None)
            if called:
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
            v1ok = [int(bool(x and x[0])) for x in v1] if v1 else []
            row["v1_success"] = "".join(map(str, v1ok)) if v1 and all(v1) else ""
            row["v2_success"] = (1 if v2[0] else 0) if v2 else None
            rows.append(row)
    return rows


RESERVE_STATE_COLS = [
    "snapshot", "reserve", "block", "block_ts", "listed", "totalSupply", "cash", "variableDebt",
    "liquidityRate_ray", "variableBorrowRate_ray", "configuration", "RF_bps", "strategy",
    "optimal", "base", "slope1", "slope2", "curve_abi",
    "v1_optimal", "v1_base", "v1_slope1", "v1_slope2", "v2_optimal", "v2_base", "v2_slope1", "v2_slope2",
    "v1_success", "v2_success", "liquidityIndex", "variableBorrowIndex", "lastUpdateTimestamp",
    "aToken_rd", "aToken_matches", "variableDebtToken", "rd_status", "rd_words",
    "totalSupply_status", "cash_status", "variableDebt_status",
]


# ---------------------------------------------------------------------------------------------
# Phase: validate
# ---------------------------------------------------------------------------------------------


def phase_validate(ctx: Ctx, pop: dict, recs: dict, rs_rows: list[dict], ddir: Path) -> dict:
    import numpy as np
    import pandas as pd
    val = ctx.state.get("validation", {})
    # (a) direct re-reads of balanceOf for random (address, day) pairs with a nonzero balance
    if "a" not in val:
        cands = []
        for snap, rec in recs.items():
            for (r, a), v in rec["bal"].items():
                if isinstance(v, int) and v > 0:
                    cands.append((snap, rec["block"], r, a, v))
        cands.sort()
        rng = random.Random(VALIDATION_SEED)
        pick = rng.sample(cands, min(VALIDATION_N, len(cands)))
        rows = []
        for snap, block, r, a, v in pick:
            ret = ctx.rpc.eth_call(RESERVES[r]["atoken"], call_data("balanceOf", a), block, "validate",
                                   tag=f"direct {snap} {r} {a}", validate=decode_uint)
            got = decode_uint(ret)
            rows.append({"snapshot": snap, "block": block, "reserve": r, "address": a, "multicall": v,
                         "direct": got, "equal": got == v})
        val["a"] = {"seed": VALIDATION_SEED, "population": "daily rows with balance > 0 and status ok",
                    "n": len(rows), "n_equal": sum(x["equal"] for x in rows), "pairs": rows}
        ctx.state["validation"] = val
        ctx.save_state()
    # (b) aToken totalSupply at 00:00Z of D+1 vs reserve_history_daily total_liquidity_raw of D
    hist = pd.read_csv(ddir / RESERVE_HISTORY_REL)
    rs = pd.DataFrame(rs_rows)
    rs = rs[rs["snapshot"] != "asof"].copy()
    rs["date_prev"] = (pd.to_datetime(rs["snapshot"]) - pd.Timedelta(days=1)).dt.strftime("%Y-%m-%d")
    b = {"alignment": "ours: totalSupply/1e6 at 00:00Z of D+1; theirs: total_liquidity_raw of D (last update in D)",
         "reserve_history_sha256": sha256_file(ddir / RESERVE_HISTORY_REL)}
    for r in RESERVE_ORDER:
        m = rs[rs["reserve"] == r].merge(hist[hist["symbol"] == r], left_on="date_prev", right_on="date")
        m = m[m["totalSupply"].notna() & (m["total_liquidity_raw"] > 0)]
        rel = (m["totalSupply"].astype(float) / 1e6 - m["total_liquidity_raw"]) / m["total_liquidity_raw"]
        ar = rel.abs()
        b[r] = {"n_days": int(len(m)), "median_abs_rel_diff": float(ar.median()) if len(m) else None,
                "p95_abs_rel_diff": float(ar.quantile(0.95)) if len(m) else None,
                "max_abs_rel_diff": float(ar.max()) if len(m) else None,
                "max_on": m.loc[ar.idxmax(), "date_prev"] if len(m) else None,
                "n_over_1pct": int((ar > 0.01).sum())}
    val["b"] = b
    # (c) failed sub-calls per type
    c = {}

    def bump(typ, status):
        c.setdefault(typ, {}).setdefault(status, 0)
        c[typ][status] += 1

    for snap, rec in recs.items():
        for lab, (ok, ret) in list(rec["lead"].items()) + list(rec["dep"].items()):
            typ = "daily:" + lab[0] + (":" + lab[3] if lab[0] == "v1" else "") + ":" + lab[1]
            bump(typ, "success" if ok else "fail")
        for (r, a), v in rec["bal"].items():
            bump(f"daily:balanceOf:{r}", "ok" if isinstance(v, int) else v)
    U = ctx._U
    for label, block, r, a, v in monthly_table(ctx, U):
        bump(f"monthly:balanceOf:{r}", "ok" if isinstance(v, int) else v)
    val["c"] = c
    # (d) days with no decodable curve
    d = {}
    for r in RESERVE_ORDER:
        sub = rs[rs["reserve"] == r]
        d[r] = {"n_days": int(len(sub)), "by_curve_abi": {k: int(v) for k, v in sub["curve_abi"].value_counts().items()},
                "n_no_curve": int((~sub["curve_abi"].isin(["v1", "v2", "both"])).sum()),
                "no_curve_dates": sub.loc[~sub["curve_abi"].isin(["v1", "v2", "both"]), "snapshot"].tolist()[:60]}
    val["d"] = d
    # layout of getReserveData across blocks
    allrs = pd.DataFrame(rs_rows)
    val["rd_layout"] = {f"{k[0]}:{k[1]}": int(v) for k, v in allrs.groupby(["reserve", "rd_status"]).size().items()}
    val["rd_words"] = {str(k): int(v) for k, v in allrs["rd_words"].value_counts(dropna=False).items()}
    val["aToken_mismatch_rows"] = int((allrs["aToken_matches"] == 0).sum())
    ctx.state["validation"] = val
    ctx.save_state()
    return val


# ---------------------------------------------------------------------------------------------
# Phase: write
# ---------------------------------------------------------------------------------------------


def write_csv(path: Path, header: list[str], rows, gz: bool) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    if gz:
        with open(tmp, "wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as g:
                t = io.TextIOWrapper(g, encoding="utf-8", newline="")
                w = csv.writer(t, lineterminator="\n")
                w.writerow(header)
                for row in rows:
                    w.writerow(row)
                t.flush()
                t.detach()
    else:
        with open(tmp, "w", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(header)
            for row in rows:
                w.writerow(row)
    os.replace(tmp, path)


def fmt(v):
    return "" if v is None else v


def phase_write(ctx: Ctx, U, pop, recs, rs_rows, val, run_meta) -> dict:
    out = ctx.out
    out.mkdir(parents=True, exist_ok=True)
    files = {}
    # blocks.csv
    monthly = {d.isoformat() for d in monthly_dates()}
    brows = []
    for d in daily_dates():
        s = d.isoformat()
        b = ctx.blocks.get(s)
        brows.append([s, "daily", int(s in monthly), b["T"], iso_utc(b["T"]), b["block"], b["block_ts"],
                      iso_utc(b["block_ts"]), b["next_ts"], "ok" if b["block_ts"] < b["T"] <= b["next_ts"] else "FAIL"])
    a = ctx.state["asof"]
    brows.append(["asof", "asof", 0, "", "", a["block"], a["ts"], iso_utc(a["ts"]), fmt(a.get("next_ts")), ""])
    write_csv(out / "blocks.csv", ["snapshot", "kind", "monthly", "T", "T_utc", "block", "block_ts", "block_utc",
                                   "next_ts", "proof"], brows, gz=False)
    # monthly balances: nonzero balances and any non-ok sub-call; zero balances omitted
    for r in RESERVE_ORDER:
        def gen(r=r):
            for label, block, rr, addr, v in monthly_table(ctx, U):
                if rr != r:
                    continue
                if isinstance(v, int):
                    if v != 0:
                        yield [label, block, addr, v, "ok"]
                else:
                    yield [label, block, addr, "", v]
        write_csv(out / f"monthly-balances-{r.lower()}.csv.gz", ["snapshot", "block", "address", "balance_raw", "status"],
                  gen(), gz=True)
    # panel population
    prow = []
    for r in RESERVE_ORDER:
        for addr, rule, mx in pop[r]["rows"]:
            prow.append([r, addr, rule, fmt(mx)])
    write_csv(out / "panel-population.csv", ["reserve", "address", "rule", "max_monthly_balance_raw"], prow, gz=False)
    # daily balances, long format, every (address, snapshot) incl. zeros, sorted by address then snapshot
    snaps = list(recs.keys())
    for r in RESERVE_ORDER:
        def gen(r=r):
            for addr, _, _ in pop[r]["rows"]:
                for s in snaps:
                    v = recs[s]["bal"][(r, addr)]
                    yield [s, addr, v, ""] if isinstance(v, int) else [s, addr, "", v]
        write_csv(out / f"daily-balances-{r.lower()}.csv.gz", ["snapshot", "address", "balance_raw", "status"],
                  gen(), gz=True)
    # reserve state
    write_csv(out / "reserve-state.csv", RESERVE_STATE_COLS,
              ([fmt(row.get(c)) for c in RESERVE_STATE_COLS] for row in rs_rows), gz=False)
    # run-log.json
    (out / "run-log.json").write_text(json.dumps(run_meta, indent=1, sort_keys=False, default=str) + "\n")
    for p in sorted(out.iterdir()):
        if p.is_file() and p.name != "PROVENANCE.md":
            files[p.name] = {"bytes": p.stat().st_size, "sha256": sha256_file(p)}
    return files


def provenance_md(run_meta: dict, files: dict, val: dict, pop: dict) -> str:
    g = run_meta["code"]
    a = run_meta["asof"]
    lines = [
        "# depositor-balances — provenance",
        "",
        "Exact aToken balances of large Aave V3 Ethereum Core USDC and USDT depositors, with daily reserve",
        "state and the rate curve, read from chain for Q26 workstream B. Built exactly as preregistered in",
        f"`{PREREG['repo']}` `{PREREG['path']}` §B.1 (commit `{PREREG['commit']}`, sha256 `{PREREG['sha256'][:8]}…{PREREG['sha256'][-4:]}`).",
        "The builder computes no outcome (no exits, episodes, withdrawal rates or hazards).",
        "",
        f"- **Source:** archive `eth_call` / `eth_getBlockByNumber` on `{RPC_URL}` (free, no key), Multicall3",
        f"  `{MULTICALL3}` `aggregate3` with `allowFailure = true`, ≤ {MAX_CALLS_PER_MULTICALL} calls per request.",
        f"  Pool `{POOL}`; aUSDC `{RESERVES['USDC']['atoken']}`; aUSDT `{RESERVES['USDT']['atoken']}`.",
        f"  Address universe `U_r` = every `user_id` of the reserve in `lender-retention/lender_flows_raw.csv.gz`",
        f"  (sha256 `{LENDER_FLOWS_SHA256}`).",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}` at `{g.get('sha')}`, `{g.get('path')}`.",
        f"- **Fetch window (UTC):** {run_meta['fetch_window_utc'][0]} → {run_meta['fetch_window_utc'][1]}.",
        f"- **Snapshots:** daily 00:00Z {DAILY_START} → {DAILY_END} ({len(daily_dates())} days); block = the largest",
        "  block with timestamp < T, proved by `block_ts < T <= next_ts` in `blocks.csv`. Monthly selection = the 1st of",
        f"  each month {MONTHLY_START} → {MONTHLY_END} ({len(monthly_dates())}). Asof = latest block at build time:",
        f"  {a['block']} ({iso_utc(a['ts'])}, hash `{a['hash']}`).",
        "- **Status:** CANONICAL, FROZEN (inputs to Q26 B; do not refetch or edit).",
        "- **Units:** every balance, supply, cash and debt is the raw integer in underlying base units (6 decimals);",
        "  ÷ 1e6 = USD (USDC and USDT counted at $1). Rates and curve parameters are ray (÷ 1e27 × 100 = APR %).",
        "  `RF_bps` = bits 64–79 of `configuration`.",
        "- **Formats:**",
        "  - `blocks.csv`: one row per snapshot (`snapshot` = UTC date, or `asof`), `T`, `block`, `block_ts`, `next_ts`.",
        "  - `monthly-balances-{usdc,usdt}.csv.gz`: long; only nonzero balances and non-ok sub-calls are listed; an",
        "    address of `U_r` absent at a snapshot read exactly 0. Status `empty` = success with no return data (aToken",
        "    not yet deployed), `fail` = sub-call reverted.",
        "  - `panel-population.csv`: `P_r` with the rule that admitted each address (`balance`, `supply_event`, `both`).",
        "  - `daily-balances-{usdc,usdt}.csv.gz`: long, every (address in `P_r`, snapshot) incl. zeros, sorted by address",
        "    then snapshot; the asof snapshot is labelled `asof`.",
        "  - `reserve-state.csv`: per snapshot and reserve. `curve_abi` = which strategy ABI answered (`v1` = no-arg",
        "    getters, `v2` = `getInterestRateData(asset)`); `optimal/base/slope1/slope2` from that ABI; both raw sets kept.",
        "  - `run-log.json`: request counts, retries, failures, timings, RPC URL, code git sha, preflight and validation.",
        "",
        f"P_r: USDC {pop['USDC']['n']} (balance rule {pop['USDC']['n_balance_rule']}, supply-event rule {pop['USDC']['n_event_rule']}, both {pop['USDC']['n_both']});",
        f"USDT {pop['USDT']['n']} (balance rule {pop['USDT']['n_balance_rule']}, supply-event rule {pop['USDT']['n_event_rule']}, both {pop['USDT']['n_both']}).",
        "",
        "| file | bytes | sha256 |",
        "|---|---:|---|",
    ]
    for name, f in sorted(files.items()):
        lines.append(f"| `{name}` | {f['bytes']} | `{f['sha256']}` |")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

PHASES = ("preflight", "blocks", "monthly", "population", "daily", "validate", "write")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--phases", default="all")
    ap.add_argument("--workers", type=int, default=WORKERS)
    args = ap.parse_args(argv)
    if args.workers > WORKERS:
        ap.error("at most 4 workers")
    ddir = datasets_dir()
    out = Path(args.out_dir) if args.out_dir else ddir / "depositor-balances"
    work = Path(args.work_dir)
    work.mkdir(parents=True, exist_ok=True)
    rpc = Rpc(RPC_URL, work / "events.jsonl")
    ctx = Ctx(work, out, rpc, workers=args.workers)
    phases = PHASES if args.phases == "all" else tuple(p.strip() for p in args.phases.split(","))
    session = {"start_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": git_info(),
               "phases": list(phases), "phase_seconds": {}}
    ctx.state.setdefault("sessions", []).append(session)
    ctx.save_state()
    status = "ok"
    try:
        flows = U = pop = recs = rs_rows = val = None
        if any(p in phases for p in ("monthly", "population", "daily", "validate", "write")):
            flows = load_flows(ddir)
            U = universe(flows)
            ctx._U = U
            ctx.state["universe"] = {r: len(U[r]) for r in RESERVE_ORDER}
            print("UNIVERSE " + json.dumps(ctx.state["universe"]), flush=True)
        for p in phases:
            t0 = time.monotonic()
            print(f"PHASE {p} start", flush=True)
            if p == "preflight":
                phase_preflight(ctx)
            elif p == "blocks":
                phase_blocks(ctx)
            elif p == "monthly":
                phase_monthly(ctx, U)
            elif p == "population":
                pop = phase_population(ctx, U, flows)
            elif p == "daily":
                pop = pop or phase_population(ctx, U, flows)
                phase_daily(ctx, pop)
            elif p == "validate":
                pop = pop or phase_population(ctx, U, flows)
                recs = daily_records(ctx, pop)
                rs_rows = reserve_state_rows(ctx, recs)
                val = phase_validate(ctx, pop, recs, rs_rows, ddir)
                print("VALIDATION " + json.dumps({k: v for k, v in val.items() if k != "c"}, default=str)[:4000], flush=True)
            elif p == "write":
                pop = pop or phase_population(ctx, U, flows)
                recs = recs or daily_records(ctx, pop)
                rs_rows = rs_rows or reserve_state_rows(ctx, recs)
                val = ctx.state.get("validation", {})
                a = ctx.state["asof"]
                if "next_ts" not in a:
                    a["next_ts"] = ctx.get_ts(a["block"] + 1, "write")
                    chk = rpc.block_obj(a["block"], "write")
                    a["hash_recheck"] = chk["hash"]
                    a["hash_unchanged"] = chk["hash"] == a["hash"]
                    ctx.save_state()
                session["phase_seconds"][p] = round(time.monotonic() - t0, 1)
                session["end_utc"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                session["counts"] = rpc.counts
                session["status"] = "ok"
                ctx.save_state()
                run_meta = build_run_meta(ctx, work)
                files = phase_write(ctx, U, pop, recs, rs_rows, val, run_meta)
                (out / "PROVENANCE.md").write_text(provenance_md(run_meta, files, val, pop))
                print("FILES " + json.dumps(files), flush=True)
            session["phase_seconds"][p] = round(time.monotonic() - t0, 1)
            ctx.save_state()
    except TerminalError as e:
        status = f"stopped: {e}"
        print(f"STOPPED {e}", flush=True)
    finally:
        session["end_utc"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        session["counts"] = rpc.counts
        session["status"] = status
        ctx.save_state()
    return 0 if status == "ok" else 2


def build_run_meta(ctx: Ctx, work: Path) -> dict:
    events = []
    ep = work / "events.jsonl"
    if ep.exists():
        events = [json.loads(l) for l in ep.read_text().splitlines() if l.strip()]
    sessions = ctx.state.get("sessions", [])
    tot = {"http_requests": 0, "retries": 0, "failures": 0, "rate_limit_retries": 0, "transient_retries": 0,
           "by_method": {}, "by_phase": {}, "seconds_in_requests": 0.0}
    for s in sessions:
        c = s.get("counts") or {}
        for k in ("http_requests", "retries", "failures", "rate_limit_retries", "transient_retries", "seconds_in_requests"):
            tot[k] += c.get(k, 0)
        for k in ("by_method", "by_phase"):
            for kk, vv in (c.get(k) or {}).items():
                tot[k][kk] = tot[k].get(kk, 0) + vv
    starts = [s["start_utc"] for s in sessions]
    ends = [s.get("end_utc") for s in sessions if s.get("end_utc")]
    return {
        "dataset": "depositor-balances",
        "prereg": PREREG,
        "rpc_url": RPC_URL,
        "user_agent": USER_AGENT,
        "pacing": {"max_requests_per_second": MAX_REQUESTS_PER_SECOND, "workers": ctx.workers,
                   "retry_wait_s": RETRY_WAIT_S, "max_retries": MAX_RETRIES},
        "code": sessions[-1]["code"] if sessions else git_info(),
        "fetch_window_utc": [min(starts) if starts else None, max(ends) if ends else None],
        "asof": ctx.state.get("asof"),
        "universe": ctx.state.get("universe"),
        "population": {r: {k: v for k, v in ctx.state["population"][r].items() if k != "rows"} for r in RESERVE_ORDER},
        "calls": tot,
        "retry_and_failure_events": events,
        "sessions": sessions,
        "preflight": ctx.state.get("preflight"),
        "daily_layout": ctx.state.get("daily_layout"),
        "validation": ctx.state.get("validation"),
        "inputs": {LENDER_FLOWS_REL: LENDER_FLOWS_SHA256},
    }


if __name__ == "__main__":
    sys.exit(main())
