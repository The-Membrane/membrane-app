#!/usr/bin/env python3
"""Q26 live forecast log -- shared code for the issuer (q26_live_issue.py) and the scorer (q26_live_score.py).

Implements triccs/membrane-board `design/HISTORY_TOUCH_LIVE.md` (registered at commit 9ce3c61, file sha256
8961eb5ca2b6da58d080a3b19d8eb04712eecfc777021fc56f8dfe040a1cc4e4). The A3 model code (a3_touch.py, a99eff8) and the
A / A2 code it imports are reused unchanged: the live refit is the A3 dev fold loop with Q_start = asof.

Contents
  - time, hashing, exclusive / atomic writes, JSON
  - public JSON-RPC client (eth.drpc.org, fallback rpc.mevblocker.io; no key) and a Chainlink feed reader
    (getRoundData walking, phase-aware; ported from Q25 scripts/research/validation/chainlink.py)
  - the live round store rounds/{eth-usd,btc-usd,steth-eth}.csv.gz and the Binance kline store binance/
    (append-only gzip members, never rewritten)
  - hourly close / low from rounds, the answer in force at a time
  - the issue-file hash chain (ported from Q25 t5_common.py)
  - the A3 refit at asof (rungs a, f, fb) and the issue rows
  - truth, exclusion, gap and summary math for the scorer
"""
import csv
import gzip
import hashlib
import http.client
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import NamedTuple

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.dirname(HERE)                      # scripts/research/history-forecasts
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)

import numpy as np  # noqa: E402

import a3_touch as A3  # noqa: E402  (A3 code reused, never modified)

A = A3.A
M2 = A3.M2

# ---------------------------------------------------------------------------------------------
# Registered constants (HISTORY_TOUCH_LIVE.md L.1-L.6)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/HISTORY_TOUCH_LIVE.md",
    "commit": "9ce3c61",
    "sha256": "8961eb5ca2b6da58d080a3b19d8eb04712eecfc777021fc56f8dfe040a1cc4e4",
    "model": {"A3": A3.PREREG["commit"], "code": "a3_touch.py @ a99eff8"},
}

LIVE_REL = "forecasts/q26-touch-live"
ISSUES_SUB = "issues"
ROUNDS_SUB = "rounds"
BINANCE_SUB = "binance"
SCORES_SUB = "scores"
ISSUE_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")
OUTCOME_FILE_RE = re.compile(r"^outcomes-(\d{4}-\d{2})\.jsonl$")
ZERO_SHA = "0" * 64

HOUR = 3600
DAY = 86400
DATA_END = A.DATA_END                                  # 2026-10-06T03:00Z (frozen grids end here)
BOOTSTRAP_TS = DATA_END - HOUR                         # the last frozen price-history hour opens 2026-10-06T02:00Z

ASSETS = ("ETH", "BTC", "stETH")
STORE_NAME = {"ETH": "eth-usd", "BTC": "btc-usd", "stETH": "steth-eth"}
FEEDS = {a: A.FEEDS[a] for a in ASSETS}                # (proxy, decimals): ETH/USD, BTC/USD, STETH/ETH
FROZEN_DP = {"ETH": 2, "BTC": 2, "stETH": 6}           # price-history rounding (used only for a reported check)
BINANCE_PAIRS = {"ETH": "ETHUSDT", "BTC": "BTCUSDT"}
BINANCE_API = "https://data-api.binance.vision/api/v3/klines"

RPC_URLS = ("https://eth.drpc.org", "https://rpc.mevblocker.io")
RPC_MAX_BATCH = {"https://eth.drpc.org": 3, "https://rpc.mevblocker.io": 50}   # drpc free plan: <= 3 per batch
USER_AGENT = "curl/8.5.0"                              # drpc refuses the urllib default user agent

FROZEN_A3_REL = "history-forecasts/a3/run-a99eff8/frozen-a3.json"
FROZEN_A3_SHA256 = "17a1299c3f6b51f14afa345e6838e8ed57f43b990ac0a0ea6de7dc8cf9444f27"

HORIZONS_H = A3.HORIZONS_H
T_LABEL = A3.T_LABEL
LEVELS = A3.LEVELS
RUNGS = ("a", "f", "fb")                               # the A3 refit (issued by every model version)
SCORED_RUNGS = ("a", "f", "fb", "fbL")                 # every rung a model-A5 row carries (fbL from model A5 on)
ALL_SCORED_RUNGS = SCORED_RUNGS + ("fh", "fH", "fHb")  # every rung a row may carry (fh/fH/fHb from model A6 on)
ROW_OPTIONAL = ("model", "estimateRange", "a3", "a5",  # copied into the outcome when the row has them
                "displayed", "estimateRangeDisplayed", "frozen_label_displayed")   # (displayed: A6 D3)
REGIMES = A3.REGIMES

RESOLVE_MARGIN = 900                                   # L.4: first scorer run >= 15 min after asof + T
MAX_GAP = 2 * HOUR                                     # L.4: a truth-source gap > 2 h -> unresolved
LIVE_CHECK_R, LIVE_CHECK_NEP = (0.67, 1.5), 10         # L.5
STALE_WINDOW_DAYS, STALE_R, STALE_NEP = 90, (0.5, 2.0), 5
MIN_DAYS_PASS = 90

SEL_LATEST = "feaf968c"           # latestRoundData()
SEL_GET = "9a6fc8f5"              # getRoundData(uint80)
SEL_PHASE_AGG = "c1597304"        # phaseAggregators(uint16)
AGG_MASK = (1 << 64) - 1

ROUND_HEADER = ["roundId", "answer", "updatedAt"]
KLINE_HEADER = ["openTime", "open", "high", "low", "close", "volume", "closeTime"]


# ---------------------------------------------------------------------------------------------
# Time / hashing / files
# ---------------------------------------------------------------------------------------------
def iso(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_date(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d")


def date_ordinal(d):
    return datetime.strptime(d, "%Y-%m-%d").toordinal()


def floor_hour(ts):
    ts = int(ts)
    return ts - ts % HOUR


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_meta(path, rel=None):
    return {"path": rel or path, "sha256": sha256_file(path), "bytes": os.path.getsize(path)}


def write_exclusive(path, data):
    """Create `path` with `data`; FileExistsError if it exists (a file is never rewritten)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "xb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def write_atomic(path, data):
    """Replace a DERIVED file (summary) atomically. Never used for issue files, stores or outcomes."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def append_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "ab") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def clean(o):
    """JSON-safe: numpy scalars -> Python, non-finite floats -> None."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        o = float(o)
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def dumps(obj):
    return (json.dumps(clean(obj), indent=1, ensure_ascii=True, allow_nan=False) + "\n").encode()


def dumps_with_rows(doc, key="rows"):
    """Pretty top level, one compact JSON object per row (valid JSON)."""
    d = dict(doc)
    rows = d.pop(key)
    head = json.dumps(clean(d), indent=1, ensure_ascii=True, allow_nan=False)
    assert head.endswith("\n}")
    body = ",\n".join("  " + json.dumps(clean(r), separators=(",", ":"), ensure_ascii=True, allow_nan=False)
                      for r in rows)
    return (head[:-2] + f',\n "{key}": [\n' + body + "\n ]\n}\n").encode()


def live_dir(out_root):
    return os.path.join(out_root, LIVE_REL)


# ---------------------------------------------------------------------------------------------
# HTTP GET (Binance) with retries
# ---------------------------------------------------------------------------------------------
def urllib_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_with_retry(url, get=None, tries=4, backoff=2.0, sleep=time.sleep):
    get = get or urllib_get
    for i in range(tries):
        try:
            return get(url)
        except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, ValueError):
            if i == tries - 1:
                raise
            sleep(backoff * (2 ** i))


# ---------------------------------------------------------------------------------------------
# Public JSON-RPC client (ported from Q25 chainlink.RpcClient; per-provider batch caps; block pinning)
# ---------------------------------------------------------------------------------------------
class RpcError(Exception):
    pass


class _BadResponse(Exception):
    pass


class _Reverted:
    pass


REVERTED = _Reverted()


def assert_public(url):
    p = urllib.parse.urlparse(url)
    if p.scheme != "https" or p.username or p.password or p.query or p.fragment:
        raise ValueError("RPC URL must be a plain public https endpoint (no key, query or userinfo)")
    for seg in p.path.split("/"):
        if len(seg) > 16:
            raise ValueError("RPC URL path looks like it carries a key; public endpoints only")


def urllib_post(url, body, timeout):
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


class RpcClient:
    """JSON-RPC over the public providers in order. A provider that rejects a batch gets a smaller cap;
    single-call failures retry with backoff, then the next provider is used for the rest of the run."""

    def __init__(self, urls=RPC_URLS, post=None, max_calls=20000, retries=3, backoff=1.0, sleep=time.sleep,
                 timeout=30, max_batch=None, log=None):
        for u in urls:
            assert_public(u)
        self.urls = tuple(urls)
        self._post = post or urllib_post
        self.max_calls = int(max_calls)
        self.retries = int(retries)
        self.backoff = float(backoff)
        self._sleep = sleep
        self.timeout = timeout
        caps = dict(RPC_MAX_BATCH)
        caps.update(max_batch or {})
        self._cap = [int(caps.get(u, 50)) for u in self.urls]
        self.cur = 0
        self._id = 0
        self._log = log or (lambda *_: None)
        self.calls = 0
        self.per_url = {u: {"httpRequests": 0, "calls": 0} for u in self.urls}
        self.switches = 0
        self.errors = []

    def stats(self):
        return {"providers": list(self.urls), "used": {u: v for u, v in self.per_url.items() if v["httpRequests"]},
                "calls": self.calls, "providerSwitches": self.switches, "errors": self.errors[-10:],
                "note": "public endpoints without a key"}

    def _post_once(self, p, reqs):
        if self.calls + len(reqs) > self.max_calls:
            raise RpcError(f"RPC call budget {self.max_calls} exhausted")
        url = self.urls[p]
        self.calls += len(reqs)
        self.per_url[url]["httpRequests"] += 1
        self.per_url[url]["calls"] += len(reqs)
        body = json.dumps(reqs[0] if len(reqs) == 1 else reqs).encode()
        try:
            resp = json.loads(self._post(url, body, self.timeout))
        except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, ValueError) as e:
            raise _BadResponse(f"{type(e).__name__}: {str(e)[:120]}")
        if isinstance(resp, dict):
            resp = [resp]
        if not isinstance(resp, list) or len(resp) != len(reqs):
            raise _BadResponse("unexpected response shape")
        by_id = {r.get("id"): r for r in resp if isinstance(r, dict)}
        out = []
        for q in reqs:
            r = by_id.get(q["id"])
            if r is None:
                raise _BadResponse("missing id in response")
            if "error" in r:
                err = r["error"] or {}
                text = str(err.get("message", "")).lower()
                if q["method"] == "eth_call" and (err.get("code") == 3 or "revert" in text):
                    out.append(REVERTED)
                    continue
                raise _BadResponse(f"rpc error {err.get('code')}: {str(err.get('message'))[:120]}")
            out.append(r.get("result"))
        return out

    def _exchange(self, reqs):
        last = "no provider tried"
        while self.cur < len(self.urls):
            p = self.cur
            if len(reqs) > self._cap[p]:
                out, step = [], self._cap[p]
                for i in range(0, len(reqs), step):
                    out += self._exchange(reqs[i:i + step])
                return out
            shrunk = False
            for attempt in range(self.retries):
                try:
                    return self._post_once(p, reqs)
                except _BadResponse as e:
                    last = str(e)
                    if len(reqs) > 1:
                        self._cap[p] = max(1, len(reqs) // 4)
                        shrunk = True
                        break
                    self._sleep(self.backoff * (2 ** attempt))
            if shrunk:
                continue
            self.errors.append(f"{self.urls[p]}: {last}")
            self._log(f"rpc {self.urls[p]} failed ({last}); falling back")
            self.cur += 1
            self.switches += 1
        raise RpcError(f"all public RPCs failed; last error: {last}")

    def request_many(self, method, params_list):
        reqs = []
        for params in params_list:
            self._id += 1
            reqs.append({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        return self._exchange(reqs)

    def head(self):
        """(block number, block timestamp) of the provider's latest block."""
        b = self.request_many("eth_getBlockByNumber", [["latest", False]])[0]
        if not isinstance(b, dict) or "number" not in b or "timestamp" not in b:
            raise RpcError("eth_getBlockByNumber returned no block")
        return int(b["number"], 16), int(b["timestamp"], 16)

    def eth_call_many(self, calls, block="latest"):
        res = self.request_many("eth_call", [[{"to": to, "data": "0x" + d}, block] for to, d in calls])
        out = []
        for r in res:
            if r is REVERTED:
                out.append(REVERTED)
            elif isinstance(r, str) and r.startswith("0x"):
                out.append(bytes.fromhex(r[2:]))
            else:
                raise RpcError("eth_call result is not hex")
        return out


# ---------------------------------------------------------------------------------------------
# Chainlink feed (getRoundData walking; ported from Q25 chainlink.Feed, pinned to one block)
# ---------------------------------------------------------------------------------------------
class Round(NamedTuple):
    round_id: int
    answer: int
    updated_at: int

    @property
    def phase(self):
        return self.round_id >> 64

    @property
    def agg(self):
        return self.round_id & AGG_MASK


def decode_round(b):
    if len(b) < 160:
        raise RpcError(f"short round data ({len(b)} bytes)")
    w = [int.from_bytes(b[32 * i:32 * (i + 1)], "big") for i in range(5)]
    ans = w[1] - (1 << 256) if w[1] >= (1 << 255) else w[1]
    return Round(w[0], ans, w[3])


def enc_uint(v):
    return format(int(v), "064x")


class Feed:
    def __init__(self, rpc, proxy, block="latest"):
        self.rpc, self.proxy, self.block = rpc, proxy, block
        self._cache = {}
        self._latest = None

    def latest(self):
        if self._latest is None:
            b = self.rpc.eth_call_many([(self.proxy, SEL_LATEST)], self.block)[0]
            if b is REVERTED:
                raise RpcError("latestRoundData reverted")
            self._latest = decode_round(b)
            self._cache[self._latest.round_id] = self._latest
        return self._latest

    def get_rounds(self, ids):
        missing = [r for r in dict.fromkeys(ids) if r not in self._cache]
        if missing:
            res = self.rpc.eth_call_many([(self.proxy, SEL_GET + enc_uint(r)) for r in missing], self.block)
            for rid, b in zip(missing, res):
                r = None if b is REVERTED else decode_round(b)
                if r is not None and r.updated_at == 0:
                    r = None
                if r is not None and r.round_id != rid:
                    raise RpcError(f"getRoundData({rid}) returned round {r.round_id}")
                self._cache[rid] = r
        return [self._cache[r] for r in ids]

    def need(self, rid):
        r = self.get_rounds([rid])[0]
        if r is None:
            raise RpcError(f"round {rid >> 64}/{rid & AGG_MASK} has no data")
        return r

    def phase_latest(self, phase):
        if phase < 1:
            return None
        b = self.rpc.eth_call_many([(self.proxy, SEL_PHASE_AGG + enc_uint(phase))], self.block)[0]
        if b is REVERTED or len(b) < 32:
            return None
        addr = int.from_bytes(b[12:32], "big")
        if addr == 0:
            return None
        b = self.rpc.eth_call_many([("0x" + format(addr, "040x"), SEL_LATEST)], self.block)[0]
        if b is REVERTED:
            raise RpcError(f"phase {phase} aggregator latestRoundData reverted")
        return self.need((phase << 64) | (decode_round(b).round_id & AGG_MASK))

    def _search_phase(self, phase, hi_agg, ts):
        """Largest agg id r < hi_agg with updatedAt(r) <= ts (updatedAt(hi_agg) > ts); None if round 1 is after ts."""
        base = phase << 64
        good_hi, step = hi_agg, 1
        while True:
            probe = max(1, good_hi - step)
            if probe >= good_hi:
                return None
            r = self.need(base | probe)
            if r.updated_at <= ts:
                lo = probe
                break
            good_hi = probe
            if probe == 1:
                return None
            step *= 2
        while good_hi - lo > 1:
            mid = (lo + good_hi) // 2
            if self.need(base | mid).updated_at <= ts:
                lo = mid
            else:
                good_hi = mid
        return self.need(base | lo)

    def answer_at(self, ts, upper=None):
        """Round in force at ts (largest updatedAt <= ts)."""
        top = upper if upper is not None else self.latest()
        if top.updated_at <= ts:
            return top
        phase = top.phase
        r = self._search_phase(phase, top.agg, ts)
        while r is None:
            phase -= 1
            prev = self.phase_latest(phase)
            if prev is None:
                raise LookupError(f"no Chainlink round at or before {iso(ts)}")
            if prev.updated_at <= ts:
                return prev
            r = self._search_phase(phase, prev.agg, ts)
        return r

    def ids_after(self, last, latest):
        """Round ids after `last` up to `latest`, across phases."""
        if latest.round_id < last.round_id:
            raise RpcError("the feed's latest round is older than the stored last round")
        ids = []
        for phase in range(last.phase, latest.phase + 1):
            first = last.agg + 1 if phase == last.phase else 1
            if phase == latest.phase:
                end = latest.agg
            else:
                pl = self.phase_latest(phase)
                end = pl.agg if pl is not None else 0
            ids += [(phase << 64) | i for i in range(first, end + 1)]
        return ids

    def rounds_after(self, last, latest):
        ids = self.ids_after(last, latest)
        rs = self.get_rounds(ids)
        for rid, r in zip(ids, rs):
            if r is None:
                raise RpcError(f"round {rid >> 64}/{rid & AGG_MASK} has no data")
        return rs

    def rounds_from(self, t_a, latest):
        """[round in force at t_a] + every round after it up to `latest` (store bootstrap)."""
        r_a = self.answer_at(t_a, upper=latest)
        return [r_a] + self.rounds_after(r_a, latest)


# ---------------------------------------------------------------------------------------------
# Append-only gzip stores
# ---------------------------------------------------------------------------------------------
def gz_member(header, rows):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    if header:
        w.writerow(header)
    for r in rows:
        w.writerow(r)
    return gzip.compress(buf.getvalue().encode(), compresslevel=9, mtime=0)


def read_gz_csv(path, header):
    if not os.path.exists(path):
        return []
    with open(path, "rb") as f:
        text = gzip.decompress(f.read()).decode()
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or rows[0] != header:
        raise SystemExit(f"STOP: {path}: header {rows[:1]} != {header}")
    return rows[1:]


def round_store_path(ldir, asset):
    return os.path.join(ldir, ROUNDS_SUB, STORE_NAME[asset] + ".csv.gz")


def binance_store_path(ldir, pair):
    return os.path.join(ldir, BINANCE_SUB, pair + "-1h.csv.gz")


def check_round_sequence(rounds, prev=None):
    """Strictly increasing round ids; updatedAt non-decreasing (also against `prev`)."""
    seq = ([prev] if prev is not None else []) + list(rounds)
    for p, q in zip(seq, seq[1:]):
        if q.round_id <= p.round_id:
            raise SystemExit(f"STOP: round ids not increasing ({p.round_id} -> {q.round_id})")
        if q.updated_at < p.updated_at:
            raise SystemExit(f"STOP: updatedAt goes backwards at round {q.round_id}")


def read_round_store(path):
    rs = [Round(int(a), int(b), int(c)) for a, b, c in read_gz_csv(path, ROUND_HEADER)]
    check_round_sequence(rs)
    return rs


def append_rounds(path, new, existing):
    if not new:
        return 0
    check_round_sequence(new, existing[-1] if existing else None)
    append_bytes(path, gz_member(None if existing else ROUND_HEADER,
                                 [[str(r.round_id), str(r.answer), str(r.updated_at)] for r in new]))
    return len(new)


def read_fetch_log(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def append_fetch_log(path, entry):
    append_bytes(path, (json.dumps(entry, separators=(",", ":"), sort_keys=True) + "\n").encode())


def update_round_store(rpc, ldir, asset, head, clock=time.time):
    """Append every round printed since the last stored round (bootstrap: from the round in force at
    2026-10-06T02:00Z). Every read is pinned to block `head`, so the store is complete through head's
    timestamp; that coverage is written to rounds/fetch-log.jsonl."""
    path = round_store_path(ldir, asset)
    existing = read_round_store(path)
    block_no, block_ts = head
    feed = Feed(rpc, FEEDS[asset][0], block=hex(block_no))
    latest = feed.latest()
    if latest.updated_at > block_ts:
        raise RpcError(f"{asset}: latest round updatedAt {latest.updated_at} after its block {block_ts}")
    if existing:
        new = feed.rounds_after(existing[-1], latest)
        mode = "append"
    else:
        new = feed.rounds_from(BOOTSTRAP_TS, latest)
        mode = "bootstrap"
    n = append_rounds(path, new, existing)
    entry = {"kind": "chainlink", "asset": asset, "mode": mode, "fetchedAt": int(clock()), "block": block_no,
             "coveredThrough": block_ts, "latestRoundId": str(latest.round_id), "appended": n,
             "storeRounds": len(existing) + n}
    append_fetch_log(os.path.join(ldir, ROUNDS_SUB, "fetch-log.jsonl"), entry)
    entry.update(file_meta(path, os.path.relpath(path, ldir)))
    return entry


def round_coverage(ldir, asset, rounds):
    """Time through which the store holds every round: max(fetch-log coveredThrough, last stored updatedAt)."""
    cov = rounds[-1].updated_at if rounds else None
    for e in read_fetch_log(os.path.join(ldir, ROUNDS_SUB, "fetch-log.jsonl")):
        if e.get("kind") == "chainlink" and e.get("asset") == asset:
            c = int(e["coveredThrough"])
            cov = c if cov is None else max(cov, c)
    return cov


def read_binance_store(path):
    rows = read_gz_csv(path, KLINE_HEADER)
    prev = None
    for r in rows:
        o = int(r[0])
        if o % (HOUR * 1000) or (prev is not None and o <= prev):
            raise SystemExit(f"STOP: {path}: kline open times not increasing on the hour grid at {o}")
        prev = o
    return rows


def update_binance_store(ldir, pair, http_get=None, clock=time.time):
    """Append every CLOSED hourly kline after the last stored one (bootstrap: from the hour opening
    2026-10-06T02:00Z, the last frozen hour)."""
    path = binance_store_path(ldir, pair)
    existing = read_binance_store(path)
    last_open = int(existing[-1][0]) if existing else (BOOTSTRAP_TS - HOUR) * 1000
    fetched_ms = int(clock() * 1000)
    new = []
    while True:
        url = f"{BINANCE_API}?symbol={pair}&interval=1h&startTime={last_open + HOUR * 1000}&limit=1000"
        data = json.loads(get_with_retry(url, get=http_get))
        if not isinstance(data, list):
            raise ValueError(f"binance {pair}: unexpected response")
        batch = []
        for k in data:
            o, c = int(k[0]), int(k[6])
            if o <= last_open or c >= fetched_ms:
                continue
            if o % (HOUR * 1000):
                raise ValueError(f"binance {pair}: kline off the hour grid {o}")
            batch.append([str(o), str(k[1]), str(k[2]), str(k[3]), str(k[4]), str(k[5]), str(c)])
        if not batch:
            break
        new += batch
        last_open = int(batch[-1][0])
        if len(data) < 1000:
            break
    if new:
        append_bytes(path, gz_member(None if existing else KLINE_HEADER, new))
    entry = {"kind": "binance", "pair": pair, "fetchedAt": fetched_ms // 1000, "appended": len(new),
             "lastOpen": iso(last_open // 1000) if (new or existing) else None, "storeKlines": len(existing) + len(new)}
    append_fetch_log(os.path.join(ldir, BINANCE_SUB, "fetch-log.jsonl"), entry)
    if os.path.exists(path):
        entry.update(file_meta(path, os.path.relpath(path, ldir)))
    return entry


def update_all_stores(ldir, rpc, http_get=None, clock=time.time, log=print):
    """Each run appends the round stores (all three feeds) and the Binance stores. Returns (report, errors)."""
    rep, err = {"chainlink": {}, "binance": {}}, {}
    head = None
    try:
        head = rpc.head()
        rep["head"] = {"block": head[0], "timestamp": head[1], "timestampIso": iso(head[1])}
    except (RpcError, LookupError, ValueError) as e:
        err["head"] = f"{type(e).__name__}: {e}"
    for a in ASSETS:
        if head is None:
            err[f"chainlink:{a}"] = "no block head"
            continue
        try:
            rep["chainlink"][a] = update_round_store(rpc, ldir, a, head, clock=clock)
            log(f"rounds {a}: {rep['chainlink'][a]['mode']} +{rep['chainlink'][a]['appended']} "
                f"(store {rep['chainlink'][a]['storeRounds']})")
        except (RpcError, LookupError, ValueError) as e:
            err[f"chainlink:{a}"] = f"{type(e).__name__}: {e}"
            log(f"rounds {a}: FAILED {err[f'chainlink:{a}']}")
    for a, pair in BINANCE_PAIRS.items():
        try:
            rep["binance"][pair] = update_binance_store(ldir, pair, http_get=http_get, clock=clock)
            log(f"binance {pair}: +{rep['binance'][pair]['appended']} (store {rep['binance'][pair]['storeKlines']})")
        except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, ValueError) as e:
            err[f"binance:{pair}"] = f"{type(e).__name__}: {str(e)[:160]}"
            log(f"binance {pair}: FAILED {err[f'binance:{pair}']}")
    rep["rpc"] = rpc.stats()
    return rep, err


# ---------------------------------------------------------------------------------------------
# Rounds -> prices
# ---------------------------------------------------------------------------------------------
def price(r, asset):
    return r.answer / 10 ** FEEDS[asset][1]


def sort_rounds(rounds):
    return sorted(rounds, key=lambda r: (r.updated_at, r.round_id))


def answer_in_force(rounds, ts):
    """The round with the largest updatedAt <= ts (rounds sorted by (updatedAt, roundId)); None if none."""
    best = None
    for r in rounds:
        if r.updated_at <= ts:
            best = r
        else:
            break
    return best


def hourly_close_low(rounds, asset, start_ts, end_ts):
    """Hours opening at start_ts .. end_ts - 1h. close = answer in force at the hour end; low = min of the
    answer in force at the hour start and every round with updatedAt in (start, end]. NaN where no round is
    in force at the hour start."""
    rs = sort_rounds(rounds)
    t = np.array([r.updated_at for r in rs], dtype=np.int64)
    p = np.array([price(r, asset) for r in rs], dtype=float)
    hours = np.arange(int(start_ts), int(end_ts), HOUR, dtype=np.int64)
    close = np.full(len(hours), np.nan)
    low = np.full(len(hours), np.nan)
    for j, h in enumerate(hours):
        i0 = int(np.searchsorted(t, h, side="right")) - 1
        i1 = int(np.searchsorted(t, h + HOUR, side="right"))
        if i0 < 0:
            continue
        close[j] = p[i1 - 1]
        low[j] = p[i0:i1].min()
    return close, low


# ---------------------------------------------------------------------------------------------
# Issue-file hash chain (ported from Q25 t5_common.verify_chain)
# ---------------------------------------------------------------------------------------------
def issues_dir(ldir):
    return os.path.join(ldir, ISSUES_SUB)


def list_issue_files(idir):
    if not os.path.isdir(idir):
        return []
    return sorted((m.group(1), n) for n in os.listdir(idir) if (m := ISSUE_FILE_RE.match(n)))


def read_chain_jsonl(idir):
    path = os.path.join(idir, "chain.jsonl")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def verify_chain(idir):
    """[] when intact. file[0].prevSha256 = 64 zeros; file[i].prevSha256 = sha256(bytes of file[i-1]);
    chain.jsonl line i = file i with the sha256 of its current bytes."""
    problems = []
    files = list_issue_files(idir)
    entries = read_chain_jsonl(idir)
    if len(entries) != len(files):
        problems.append(f"chain.jsonl has {len(entries)} lines but there are {len(files)} issue files")
    prev_sha, prev_name = ZERO_SHA, None
    for i, (date, name) in enumerate(files):
        with open(os.path.join(idir, name), "rb") as f:
            raw = f.read()
        sha = sha256_bytes(raw)
        try:
            doc = json.loads(raw)
        except ValueError:
            problems.append(f"{name}: not valid JSON")
            prev_sha, prev_name = sha, name
            continue
        if doc.get("date") != date:
            problems.append(f"{name}: date {doc.get('date')!r} != file name")
        if doc.get("prevSha256") != prev_sha:
            problems.append(f"{name}: prevSha256 does not equal the sha256 of {prev_name or 'genesis'}")
        if doc.get("prevFile") != prev_name:
            problems.append(f"{name}: prevFile {doc.get('prevFile')!r} != {prev_name!r}")
        if i < len(entries):
            e = entries[i]
            if e.get("file") != name or e.get("sha256") != sha or e.get("prevSha256") != prev_sha:
                problems.append(f"chain.jsonl line {i + 1} does not match {name} (file changed after issue?)")
        prev_sha, prev_name = sha, name
    return problems


def preflight(idir, date, issued_at):
    """L.6 refusals. Returns (prevFile, prevSha256)."""
    files = list_issue_files(idir)
    later = [n for d, n in files if d >= date]
    if later:
        raise SystemExit(f"STOP: issue file(s) dated {date} or later exist: {later}. A file is never rewritten "
                         "and nothing is backfilled.")
    problems = verify_chain(idir)
    if problems:
        raise SystemExit("STOP: hash chain broken:\n  " + "\n  ".join(problems))
    if not files:
        return None, ZERO_SHA
    name = files[-1][1]
    with open(os.path.join(idir, name), "rb") as f:
        raw = f.read()
    prev_issued = json.loads(raw).get("issuedAt")
    if prev_issued is None or int(prev_issued) >= issued_at:
        raise SystemExit(f"STOP: clock went backwards: {name} issuedAt {prev_issued} >= now {issued_at}")
    return name, sha256_bytes(raw)


def check_store_clock(ldir, now):
    """L.6 clock guard on the stores: no stored round or closed kline may post-date the clock."""
    for a in ASSETS:
        rs = read_round_store(round_store_path(ldir, a))
        if rs and rs[-1].updated_at > now:
            raise SystemExit(f"STOP: clock went backwards: stored {a} round updatedAt {iso(rs[-1].updated_at)} "
                             f"> now {iso(now)}")
    for pair in BINANCE_PAIRS.values():
        ks = read_binance_store(binance_store_path(ldir, pair))
        if ks and int(ks[-1][6]) // 1000 > now:
            raise SystemExit(f"STOP: clock went backwards: stored {pair} kline closes after now {iso(now)}")


# ---------------------------------------------------------------------------------------------
# Frozen inputs, code provenance
# ---------------------------------------------------------------------------------------------
def frozen_input_list():
    keys = ("eth_price", "btc_price", "steth_price", "eth_dvol", "btc_dvol")
    out = [A.INPUTS[k] for k in keys]
    out += [M2.KLINES[p] for p in ("ETHUSDT", "BTCUSDT")]
    out.append((FROZEN_A3_REL, FROZEN_A3_SHA256))
    return out


def verify_frozen_inputs(datasets):
    """sha256 of every frozen file the live refit reads (A.1 prices + DVOL as loaded by
    a2_touch.build_dev_series, the ETH/BTC Binance klines of the long splice, frozen-a3.json)."""
    meta = {}
    for rel, want in frozen_input_list():
        path = os.path.join(datasets, rel)
        got = sha256_file(path)
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for {rel}: {got} != registered {want}")
        meta[rel] = {"sha256": got, "bytes": os.path.getsize(path)}
    return meta


def load_frozen_a3(datasets):
    with open(os.path.join(datasets, FROZEN_A3_REL), "rb") as f:
        raw = f.read()
    if sha256_bytes(raw) != FROZEN_A3_SHA256:
        raise SystemExit("STOP: frozen-a3.json sha256 mismatch")
    return json.loads(raw)


CODE_FILES = ("live/q26_live_common.py", "live/q26_live_issue.py", "live/q26_live_score.py",
              "live/q26_live_a5.py", "live/q26_live_a6.py", "a6_touch.py", "a5_touch.py", "a4_touch.py",
              "a3_touch.py", "a2_touch.py", "a_touch.py", "r7_live.py", "live/q26_live_short.py", "r1110_blind.py",
              "r112_combine.py", "live/q26_live_deep.py")


def code_meta(expect_commit=None):
    def git(*args):
        r = subprocess.run(["git", "-C", MODEL_DIR, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    commit = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain", "--", *CODE_FILES)
    out = {"repo": "The-Membrane/membrane-app", "dir": "scripts/research/history-forecasts", "commit": commit,
           "dirty": (dirty.splitlines() if dirty else []) if dirty is not None else None,
           "sha256": {f: sha256_file(os.path.join(MODEL_DIR, f)) for f in CODE_FILES},
           "python": sys.version.split()[0], "numpy": np.__version__}
    try:
        import scipy
        out["scipy"] = scipy.__version__
    except ImportError:
        pass
    if expect_commit is not None and commit != expect_commit:
        raise SystemExit(f"STOP: code checkout is at {commit}, expected the pinned commit {expect_commit}")
    return out


# ---------------------------------------------------------------------------------------------
# Model: the A3 refit at asof (rungs a, f, fb), as the A3 dev fold loop with Q_start = asof
# ---------------------------------------------------------------------------------------------
def build_live_series(datasets, rounds_by_asset, asof):
    """Frozen A2 dev series (long Binance->Chainlink splice for ETH/BTC; oracle for stETH and for (a))
    extended with the live hours 2026-10-06T03:00Z .. asof-1h from rounds with updatedAt <= asof only."""
    if asof < DATA_END or asof % HOUR:
        raise ValueError("asof must be an hour at or after DATA_END")
    D = M2.build_dev_series(datasets)
    out = {}
    for a in ASSETS:
        rs = [r for r in rounds_by_asset[a] if r.updated_at <= asof]        # no price after asof
        close, low = hourly_close_low(rs, a, DATA_END, asof)
        if len(close) and not (np.isfinite(close).all() and np.isfinite(low).all()):
            raise SystemExit(f"STOP: {a}: live hours without a round in force (store must start before DATA_END)")
        g, go = D[f"long:{a}"], D[f"oracle:{a}"]

        def ext(gs):
            return A3.S3(gs.name, a, gs.truth, np.concatenate([gs.close, close]), np.concatenate([gs.low, low]),
                         gs.levels, A3.BASE_DEV, A3.BASE_DEV + HOUR * gs.start_i)
        sl = ext(g)
        so = sl if go is g else ext(go)
        out[a] = {"long": sl, "oracle": so, "live_close": close, "live_low": low, "rounds_used": len(rs),
                  "frozen_oracle_close_last": float(go.close[-1]), "frozen_oracle_low_last": float(go.low[-1])}
    return out


def forecast_series(sl, so, asof):
    """Raw and monotone-fixed (6 x K) grids of rungs a, f, fb at origin asof (Q_start = asof: training
    origins t with t + T <= asof). (a) uses the oracle series, f/fb the long series (A3 dev_task)."""
    i_now = sl.gi(asof)
    if i_now != sl.N or (so is not sl and so.N != sl.N):
        raise ValueError("series must end at asof")
    K = len(sl.levels)
    raw = {r: np.full((len(HORIZONS_H), K), np.nan) for r in RUNGS}
    betas, n_train = {}, {}
    for ti, T_h in enumerate(HORIZONS_H):
        P = A3.Prep3(sl, T_h, q_max=i_now)
        beta, binfo = P.choose_beta(i_now)
        o = A3.predict3(sl, P, T_h, i_now, np.array([i_now]), beta)
        Po = P if so is sl else A3.Prep3(so, T_h, beta_select=False)
        lim = i_now - T_h
        raw["a"][ti] = Po.freq_upto(lim)
        raw["f"][ti] = o["raw"]["f"][0]
        raw["fb"][ti] = o["raw"]["fb"][0]
        betas[T_LABEL[T_h]] = {"beta": beta, "n_eval": binfo["n_eval"], "rule": binfo["rule"]}
        n_train[T_LABEL[T_h]] = {"a": int(Po.cumN[lim]), "f": int(o["n_train_f"]), "fb": int(o["n_train_fb"])}
    fixed = {r: (A.monotone_fix(g[None])[0] if not np.isnan(g).any() else None) for r, g in raw.items()}
    g_now = int(sl.regime[i_now])
    return {"raw": raw, "fixed": fixed, "betas": betas, "n_train": n_train,
            "regime": REGIMES[g_now] if g_now >= 0 else None,
            "rv_pct": float(sl.rv_pct[i_now]) if np.isfinite(sl.rv_pct[i_now]) else None,
            "sigma_hat": float(sl.sigma[i_now]) if np.isfinite(sl.sigma[i_now]) else None,
            "sigma_ref": float(sl.sigma_ref[i_now]) if np.isfinite(sl.sigma_ref[i_now]) else None,
            "spot_series": float(sl.spot[i_now])}


def model_forecasts(datasets, rounds_by_asset, asof, log=print):
    S = build_live_series(datasets, rounds_by_asset, asof)
    out = {}
    for a in ASSETS:
        t0 = time.time()
        fc = forecast_series(S[a]["long"], S[a]["oracle"], asof)
        fc.update(live_hours=int(len(S[a]["live_close"])), rounds_used=S[a]["rounds_used"],
                  frozen_oracle_close_last=S[a]["frozen_oracle_close_last"],
                  frozen_oracle_low_last=S[a]["frozen_oracle_low_last"])
        out[a] = fc
        log(f"model {a}: regime {fc['regime']} ({time.time() - t0:.0f}s)")
    return out


def frozen_label(frozen, asset, TL, rung, k, regime):
    e = frozen["labels"][asset][TL][rung][repr(float(k))]
    g = e.get(regime) if regime else None
    if not isinstance(g, dict):
        return {"label": None if regime else "no regime", "dev": None, "outcome": None, "n_ep": None,
                "pooled": e.get("pooled")}
    return {"label": g.get("after"), "dev": g.get("dev"), "outcome": g.get("outcome"), "n_ep": g.get("n_ep"),
            "pooled": e.get("pooled")}


def issue_rows(fc, frozen, spot, asof, issued_at):
    """One row per (asset, T, level): rungs a/f/fb (monotone-fixed, as A3 scores them; raw beside), shipped rung
    and its frozen label in the current regime, regime, spot, asof, issuedAt."""
    rows = []
    for a in ASSETS:
        f = fc[a]
        S = spot[a]
        for ti, T_h in enumerate(HORIZONS_H):
            TL = T_LABEL[T_h]
            ship = frozen["shipped"][a][TL]
            for j, k in enumerate(LEVELS[a]):
                p = {r: (float(f["fixed"][r][ti, j]) if f["fixed"][r] is not None else None) for r in RUNGS}
                rows.append({
                    "asset": a, "T": TL, "T_h": T_h, "k": float(k), "S": S, "L": S * (1.0 + k),
                    "asof": asof, "asofIso": iso(asof), "issuedAt": issued_at, "issuedAtIso": iso(issued_at),
                    "resolvesAt": asof + T_h * HOUR, "resolvesAtIso": iso(asof + T_h * HOUR),
                    "regime": f["regime"], "p": p,
                    "p_raw": {r: float(f["raw"][r][ti, j]) for r in RUNGS},
                    "beta_fb": f["betas"][TL]["beta"], "shipped": ship, "p_shipped": p[ship],
                    "frozen_label": frozen_label(frozen, a, TL, ship, k, f["regime"])})
    return rows


# ---------------------------------------------------------------------------------------------
# Scoring: truth, exclusion, gaps
# ---------------------------------------------------------------------------------------------
def round_window(rounds, asset, asof, end, issued_at):
    """Primary truth inputs over (asof, end]: the answer in force at asof plus every round printed in
    (asof, end]. Missing-data gaps = spans between consecutive stored rounds whose ids are not consecutive
    (same phase: agg + 1; a new phase: agg 1). Also the rounds printed in (asof, issuedAt]."""
    rs = sort_rounds(rounds)
    inf = answer_in_force(rs, asof)
    if inf is None:
        return None
    win = [r for r in rs if asof < r.updated_at <= end]
    seq = [inf] + win
    max_missing = 0
    for p, q in zip(seq, seq[1:]):
        contiguous = (q.agg == p.agg + 1) if q.phase == p.phase else (q.phase > p.phase and q.agg == 1)
        if not contiguous:
            max_missing = max(max_missing, q.updated_at - p.updated_at)
    times = [asof] + [r.updated_at for r in win] + [end]
    mn = min(seq, key=lambda r: (r.answer, r.updated_at))
    pre = [r for r in win if r.updated_at <= issued_at]
    pre_min = min(pre, key=lambda r: (r.answer, r.updated_at)) if pre else None
    return {"inForce": inf, "min": mn, "minPrice": price(mn, asset), "nRounds": len(seq),
            "maxMissingGap": max_missing, "maxRoundSpacing": int(max(np.diff(times))) if len(times) > 1 else 0,
            "preIssueMin": price(pre_min, asset) if pre_min else None, "nPreIssue": len(pre)}


def kline_index(rows):
    """{open_ts (s): (low, close)}"""
    return {int(r[0]) // 1000: (float(r[3]), float(r[4])) for r in rows}


def binance_window(kidx, asof, T_h):
    """Secondary truth inputs: Binance hourly lows of the hours opening asof .. asof + T - 1h; longest run of
    missing hours; the close of the hour opening asof - 1h (Binance's own spot at asof)."""
    hours = [asof + j * HOUR for j in range(T_h)]
    lows = [kidx[h][0] for h in hours if h in kidx]
    run = best = 0
    for h in hours:
        run = run + 1 if h not in kidx else 0
        best = max(best, run)
    prev = kidx.get(asof - HOUR)
    return {"minLow": min(lows) if lows else None, "nHours": len(lows), "nMissing": T_h - len(lows),
            "maxGap": best * HOUR, "ownSpot": prev[1] if prev else None}


def resolve_row(row, rounds, kidx, coverage, now):
    """Outcome dict for a due row, or (None, reason) while pending. L.4."""
    end = int(row["resolvesAt"])
    if now < end + RESOLVE_MARGIN:
        return None, "before asof + T + 15 min"
    if coverage is None or coverage < end:
        return None, "round store does not yet cover asof + T"
    a, asof, issued, L = row["asset"], int(row["asof"]), int(row["issuedAt"]), float(row["L"])
    w = round_window(rounds, a, asof, end, issued)
    out = {k: row[k] for k in ("date", "asset", "T", "T_h", "k", "asof", "issuedAt", "resolvesAt", "S", "L",
                               "regime", "shipped", "p", "frozen_label")}
    out.update({k: row[k] for k in ROW_OPTIONAL if k in row})
    out.update(scoredAt=now, scoredAtIso=iso(now))
    if w is None:
        out.update(status="unresolved", reason="no round in force at asof in the store", y=None)
        return out, None
    spot_store = price(w["inForce"], a)
    out["truth"] = {"source": "chainlink round store", "min": w["minPrice"], "minRoundId": str(w["min"].round_id),
                    "minUpdatedAt": w["min"].updated_at, "nRounds": w["nRounds"],
                    "inForceAtAsof": {"roundId": str(w["inForce"].round_id), "price": spot_store,
                                      "updatedAt": w["inForce"].updated_at},
                    "spotMatchesIssue": spot_store == float(row["S"]),
                    "maxMissingGapSeconds": w["maxMissingGap"], "maxRoundSpacingSeconds": w["maxRoundSpacing"],
                    "preIssueMin": w["preIssueMin"], "nRoundsPreIssue": w["nPreIssue"]}
    if w["preIssueMin"] is not None and w["preIssueMin"] <= L:
        out.update(status="excluded_touched_before_issue", y=None)
        return out, None
    if w["maxMissingGap"] > MAX_GAP:
        out.update(status="unresolved", reason="round store gap > 2 h", y=None)
        return out, None
    y = int(w["minPrice"] <= L)
    out.update(status="resolved", y=y,
               brier={r: ((row["p"][r] - y) ** 2 if row["p"].get(r) is not None else None)
                      for r in ALL_SCORED_RUNGS if r in row["p"]})
    if a in BINANCE_PAIRS:
        b = binance_window(kidx or {}, asof, int(row["T_h"]))
        sec = {"source": f"binance {BINANCE_PAIRS[a]} hourly lows", "minLow": b["minLow"], "nHours": b["nHours"],
               "nMissing": b["nMissing"], "maxGapSeconds": b["maxGap"], "ownSpot": b["ownSpot"]}
        if b["maxGap"] > MAX_GAP or b["minLow"] is None:
            sec.update(status="unresolved", y=None)
        else:
            sec.update(status="resolved", y=int(b["minLow"] <= L),
                       y_own_spot=(int(b["minLow"] <= b["ownSpot"] * (1.0 + float(row["k"])))
                                   if b["ownSpot"] else None))
        out["secondary"] = sec
    return out, None


# ---------------------------------------------------------------------------------------------
# Summary math
# ---------------------------------------------------------------------------------------------
def count_episodes(dates, y):
    """Maximal runs of y = 1 over consecutive issue days (A2 D-C1 with daily issues)."""
    if not len(dates):
        return 0
    o = sorted(range(len(dates)), key=lambda i: dates[i])
    d = [date_ordinal(dates[i]) for i in o]
    yy = [int(y[i]) for i in o]
    n = 0
    for i in range(len(d)):
        if yy[i] == 1 and not (i > 0 and yy[i - 1] == 1 and d[i] - d[i - 1] == 1):
            n += 1
    return n


def ratio(sp, sy):
    if sy > 0:
        return sp / sy
    return "inf" if sp > 0 else None


def cell_stats(rows, rung, ykey="y"):
    """n, n_ep, Brier, BSS vs (a), R for one rung over resolved rows (rows where the rung and (a) exist)."""
    rs = [r for r in rows if r["p"].get(rung) is not None and r["p"].get("a") is not None]
    if not rs:
        return None
    y = np.array([r[ykey] for r in rs], float)
    p = np.array([r["p"][rung] for r in rs], float)
    pa = np.array([r["p"]["a"] for r in rs], float)
    b, ba = float(np.mean((p - y) ** 2)), float(np.mean((pa - y) ** 2))
    return {"n": len(rs), "n_ep": count_episodes([r["date"] for r in rs], y), "brier": b,
            "bss_vs_a": (1.0 - b / ba) if ba > 0 else None, "R": ratio(float(p.sum()), float(y.sum())),
            "sum_p": float(p.sum()), "sum_y": float(y.sum())}


def r_inside(R, lo, hi):
    return R is not None and R != "inf" and lo <= R <= hi
