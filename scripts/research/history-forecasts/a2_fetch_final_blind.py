#!/usr/bin/env python3
"""Q26 A2 deviation D1: fetch the LOCKED FINAL BLIND price set. Data checks only.

Implements membrane-board `design/HISTORY_TOUCH_PREREG_A2.md` section "Deviations" -> D1
(board commit f4e66b2). The set is locked and NOT scored in A2: a later preregistration must
name it before anything reads an outcome from it. This builder computes no outcome: no touch
or drawdown frequency, no volatility statistic, no score. It checks the data only.

Series:
  bitstamp-btc-usd    Bitstamp BTC/USD hourly OHLC from its first candle
  coinbase-btc-usd    Coinbase Exchange BTC-USD hourly candles from the first candle
  coinbase-eth-usd    Coinbase Exchange ETH-USD hourly candles from the first candle
  binance-<PAIR>      Binance USDT spot holdouts fixed mechanically at fetch time (phase select)
All end at the hour opening 2026-10-06T02:00Z, inclusive.

Phases (resumable: every raw response body is cached in --work-dir and never refetched):
  select  Binance exchangeInfo + ticker/24hr snapshot -> top 40 USDT pairs by quote volume ->
          exclusions -> first 1h kline before 2022-01-01. Fetched ONCE; the cached snapshot fixes
          the list for every later run.
  fetch   page every series; raw bodies and a request log in --work-dir
  build   one hourly grid per series in --out-dir (gzip when > 20 MB)
  check   data checks and cross-checks -> <out>/checks.json
  write   <out>/manifest.json (sha256 of every raw response), selection files, PROVENANCE.md

Usage:
  python3 -I a2_fetch_final_blind.py --work-dir DIR [--out-dir DIR] [--phases all|select,fetch,...]

HTTP: header `user-agent: curl/8.5.0`, TLS verified, the environment's proxy. Paced per host
(Bitstamp < 2 req/s, Coinbase < 3 req/s, Binance < 3 req/s). HTTP 429/418, HTTP 5xx, an
unparseable body or a transport error: wait 60 s and retry the same request, at most 5 times,
then stop. Any other HTTP status stops at once.

Grid convention (as membrane-datasets price-history): index i is the hour opening at
startTs + 3600*i; each column holds that candle's value as the exact decimal text the source
returned (plain notation, trailing zeros removed); a missing hour is null in every column, never
forward-filled. startTs is the series' first candle open.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import http.client
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation
from pathlib import Path

# ---------------------------------------------------------------------------------------------
# Fixed by D1 and the parent task
# ---------------------------------------------------------------------------------------------

USER_AGENT = "curl/8.5.0"
STEP = 3600
END_OPEN = 1791252000  # 2026-10-06T02:00:00Z, the last candle open, inclusive
COLUMNS = ("open", "high", "low", "close", "volume")

PREREG = {
    "repo": "membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A2.md",
    "section": "Deviations / D1",
    "commit": "f4e66b2",
}

# Bitstamp: `start` + `limit` select the window [start, start + (limit-1) h]; it returns the
# candles inside it (empty before the first candle). The scan starts before Bitstamp opened
# (2011-08), so the first non-empty window holds the first candle.
BITSTAMP_URL = "https://www.bitstamp.net/api/v2/ohlc/btcusd/"
BITSTAMP_LIMIT = 1000
BITSTAMP_SCAN_FROM = 1293840000  # 2011-01-01T00:00Z

# Coinbase Exchange: start and end are both inclusive, at most 300 candles; hours without a
# trade have no candle. The scan starts before Coinbase Exchange opened (2015-01).
COINBASE_URL = "https://api.exchange.coinbase.com/products/{pid}/candles"
COINBASE_WINDOW = 300
COINBASE_SCAN_FROM = 1388534400  # 2014-01-01T00:00Z

BINANCE_BASE = "https://data-api.binance.vision/api/v3"
BINANCE_LIMIT = 1000
TOP_N = 40
FIRST_KLINE_BEFORE = 1640995200  # 2022-01-01T00:00Z

SERIES_FIXED = (
    {"id": "bitstamp-btc-usd", "asset": "BTC/USD", "host": "bitstamp", "kind": "bitstamp", "product": "btcusd"},
    {"id": "coinbase-btc-usd", "asset": "BTC/USD", "host": "coinbase", "kind": "coinbase", "product": "BTC-USD"},
    {"id": "coinbase-eth-usd", "asset": "ETH/USD", "host": "coinbase", "kind": "coinbase", "product": "ETH-USD"},
)

# Seconds between request starts, per host (strictly under the ceilings 2, 3 and 4 req/s;
# another process may share the Binance endpoint, so Binance stays at about 3 req/s).
PACE_S = {"bitstamp": 0.55, "coinbase": 0.36, "binance": 0.36}
RETRY_WAIT_S = 60
MAX_RETRIES = 5
HTTP_TIMEOUT_S = 60
RETRY_STATUSES = (418, 429)

GZIP_ABOVE_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 50 * 1024 * 1024

# Exclusions (base asset), fixed before the snapshot is read.
CORE = {"BTC", "ETH"}
A22_HOLDOUTS = {"BNB", "XRP", "ADA", "LTC", "LINK", "DOGE", "SOL", "AVAX"}
STABLE_FIAT_PEGGED = {
    # USD stablecoins (including ones that lost the peg) and fiat
    "USDC", "FDUSD", "TUSD", "DAI", "USDP", "PAX", "BUSD", "USDS", "USDSB", "SUSD", "UST", "USTC",
    "PYUSD", "USDE", "USD1", "RLUSD", "BFUSD", "XUSD", "USDD", "FRAX", "LUSD", "GUSD", "USDJ", "VAI",
    "USDF", "USDX", "USDG", "USDQ", "USDR", "USTB", "U", "EUR", "EURI", "AEUR", "EURC", "EURT", "GBP",
    "AUD", "TRY", "BRL", "RUB", "UAH", "NGN", "ZAR", "ARS", "IDRT", "BIDR", "BVND", "JPY", "MXN", "PLN",
    "RON", "CZK", "COP", "BKRW",
    # commodity-pegged
    "PAXG", "XAUT",
}
WRAPPED_STAKED = {
    "WBTC", "WBETH", "BETH", "WETH", "STETH", "WSTETH", "BNSOL", "CBBTC", "LBTC", "SOLVBTC", "BTCB",
    "HBTC", "RENBTC", "WBNB", "WSOL", "BBTC", "CBETH", "RETH", "METH", "EZETH", "WEETH", "JITOSOL",
    "MSOL", "BFBTC",
}
LEVERAGED_SUFFIX_PAIRS = (("UP", "DOWN"), ("BULL", "BEAR"))

_DEC = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")
_INT = re.compile(r"^\d+$")


# ---------------------------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------------------------


def iso_utc(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_num(s) -> str:
    """Source decimal text (string; exponent allowed) -> exact plain decimal text, no trailing zeros."""
    if not isinstance(s, str) or not _DEC.match(s):
        raise ValueError(f"not a decimal: {s!r}")
    try:
        d = Decimal(s)
    except InvalidOperation as e:  # pragma: no cover (regex guards)
        raise ValueError(f"not a decimal: {s!r}") from e
    t = format(d, "f")
    if "." in t:
        t = t.rstrip("0").rstrip(".")
    return "0" if t in ("-0", "") else t


def parse_ts(x) -> int:
    if isinstance(x, bool):
        raise ValueError(f"bad timestamp {x!r}")
    if isinstance(x, int):
        v = x
    elif isinstance(x, str) and _INT.match(x):
        v = int(x)
    else:
        raise ValueError(f"bad timestamp {x!r}")
    if v % STEP:
        raise ValueError(f"timestamp not on the hour: {v}")
    return v


def parse_bitstamp(body: bytes) -> list[tuple]:
    """Bitstamp OHLC body -> [(ts, o, h, l, c, v)] with exact decimal text."""
    d = json.loads(body)
    try:
        rows = d["data"]["ohlc"]
        pair = d["data"]["pair"]
    except (KeyError, TypeError) as e:
        raise ValueError(f"bitstamp body has no data.ohlc: {body[:200]!r}") from e
    if pair != "BTC/USD" or not isinstance(rows, list):
        raise ValueError(f"bitstamp body pair/rows unexpected: {pair!r}")
    out = []
    for r in rows:
        if not isinstance(r, dict) or set(r) != {"timestamp", *COLUMNS}:
            raise ValueError(f"bitstamp row shape: {r!r}")
        out.append((parse_ts(r["timestamp"]), *(norm_num(r[c]) for c in COLUMNS)))
    return out


def parse_coinbase(body: bytes) -> list[tuple]:
    """Coinbase candles body ([time, low, high, open, close, volume], newest first) -> [(ts, o, h, l, c, v)]."""
    rows = json.loads(body, parse_float=str, parse_int=str)
    if not isinstance(rows, list):
        raise ValueError(f"coinbase body is not an array: {body[:200]!r}")
    out = []
    for r in rows:
        if not isinstance(r, list) or len(r) != 6:
            raise ValueError(f"coinbase row shape: {r!r}")
        t, lo, hi, op, cl, vol = r
        out.append((parse_ts(t), norm_num(op), norm_num(hi), norm_num(lo), norm_num(cl), norm_num(vol)))
    return out


def parse_binance(body: bytes) -> list[tuple]:
    """Binance klines body -> [(ts, o, h, l, c, v)]; checks the 1 h close time."""
    rows = json.loads(body)
    if not isinstance(rows, list):
        raise ValueError(f"binance body is not an array: {body[:200]!r}")
    out = []
    for r in rows:
        if not isinstance(r, list) or len(r) != 12 or not isinstance(r[0], int) or isinstance(r[0], bool):
            raise ValueError(f"binance row shape: {r!r}")
        if r[0] % 1000 or r[6] != r[0] + STEP * 1000 - 1:
            raise ValueError(f"binance open/close time: {r[0]} {r[6]}")
        out.append((parse_ts(r[0] // 1000), *(norm_num(r[k]) for k in range(1, 6))))
    return out


PARSERS = {"bitstamp": parse_bitstamp, "coinbase": parse_coinbase, "binance": parse_binance}


def window_starts(scan_from: int, window_h: int, end_open: int = END_OPEN) -> list[int]:
    """Start of every request window from scan_from until a window starts after end_open."""
    return list(range(scan_from, end_open + 1, window_h * STEP))


def dedupe(rows: list[tuple]) -> tuple[list[tuple], dict]:
    """Sort by open; drop identical duplicates (counted). A conflicting duplicate raises."""
    seen: dict[int, tuple] = {}
    ident = 0
    for r in rows:
        if r[0] in seen:
            if seen[r[0]] != r:
                raise ValueError(f"conflicting duplicate candles at {iso_utc(r[0])}: {seen[r[0]]} vs {r}")
            ident += 1
        else:
            seen[r[0]] = r
    return [seen[k] for k in sorted(seen)], {"duplicate_identical": ident, "duplicate_conflicting": 0}


def build_grid(rows: list[tuple], end_open: int = END_OPEN) -> dict:
    """Candles (any order) -> hourly grid of exact decimal text from the first candle to end_open."""
    rows = [r for r in rows if r[0] <= end_open]
    if not rows:
        raise ValueError("no candles at or before the end open")
    rows, dup = dedupe(rows)
    first = rows[0][0]
    count = (end_open - first) // STEP + 1
    cols = {c: [None] * count for c in COLUMNS}
    for r in rows:
        i = (r[0] - first) // STEP
        for k, c in enumerate(COLUMNS, start=1):
            cols[c][i] = r[k]
    return {"startTs": first, "count": count, "columns": cols, "rows": len(rows), "lastOpenTs": rows[-1][0], **dup}


def serialize_grid(asset: str, source: str, grid: dict, fetched_at: str) -> bytes:
    def arr(vals):
        return "[" + ",".join("null" if v is None else v for v in vals) + "]"
    cols = ",".join(f"{json.dumps(c)}:{arr(grid['columns'][c])}" for c in COLUMNS)
    head = (f'{{"asset":{json.dumps(asset)},"source":{json.dumps(source)},'
            f'"startTs":{grid["startTs"]},"stepSeconds":{STEP},"count":{grid["count"]},')
    return (head + f'"columns":{{{cols}}},"fetchedAt":{json.dumps(fetched_at)}}}\n').encode()


def null_runs(col: list) -> list[tuple[int, int]]:
    runs, start = [], None
    for i, v in enumerate(col):
        if v is None:
            if start is None:
                start = i
        elif start is not None:
            runs.append((start, i - start))
            start = None
    if start is not None:
        runs.append((start, len(col) - start))
    return runs


def by_year(start_ts: int, idx: list[int]) -> dict[str, int]:
    out: dict[str, int] = {}
    for i in idx:
        y = str(dt.datetime.fromtimestamp(start_ts + STEP * i, dt.timezone.utc).year)
        out[y] = out.get(y, 0) + 1
    return dict(sorted(out.items()))


def coverage(grid: dict) -> dict:
    col = grid["columns"]["close"]
    nulls = [i for i, v in enumerate(col) if v is None]
    same = all([i for i, v in enumerate(grid["columns"][k]) if v is None] == nulls for k in COLUMNS)
    runs = null_runs(col)
    longest = max(runs, key=lambda r: (r[1], -r[0])) if runs else None
    s = grid["startTs"]
    return {
        "first_open": iso_utc(s),
        "last_open": iso_utc(s + STEP * (grid["count"] - 1)),
        "last_candle_open": iso_utc(grid["lastOpenTs"]),
        "count": grid["count"],
        "candles": grid["rows"],
        "null_hours": len(nulls),
        "null_runs": len(runs),
        "null_hours_by_year": by_year(s, nulls),
        "longest_gap_hours": longest[1] if longest else 0,
        "longest_gap_start": iso_utc(s + STEP * longest[0]) if longest else None,
        "nulls_aligned_across_columns": same,
    }


def value_checks(grid: dict) -> dict:
    """OHLC consistency, non-positive values, zero-volume hours (exact decimal compare)."""
    c, s = grid["columns"], grid["startTs"]
    low_viol = high_viol = low_gt_high = 0
    zero = {k: 0 for k in COLUMNS}
    neg = {k: 0 for k in COLUMNS}
    zero_vol_idx, flat_zero_vol = [], 0
    for i in range(grid["count"]):
        if c["open"][i] is None:
            continue
        d = {k: Decimal(c[k][i]) for k in COLUMNS}
        if d["low"] > min(d["open"], d["close"]):
            low_viol += 1
        if d["high"] < max(d["open"], d["close"]):
            high_viol += 1
        if d["low"] > d["high"]:
            low_gt_high += 1
        for k in COLUMNS:
            if d[k] == 0:
                zero[k] += 1
            elif d[k] < 0:
                neg[k] += 1
        if d["volume"] == 0:
            zero_vol_idx.append(i)
            if d["open"] == d["high"] == d["low"] == d["close"]:
                flat_zero_vol += 1
    nonpos_price = sum(zero[k] + neg[k] for k in ("open", "high", "low", "close"))
    return {"low_gt_min_open_close": low_viol, "high_lt_max_open_close": high_viol, "low_gt_high": low_gt_high,
            "nonpositive_price_values": nonpos_price, "negative_volume": neg["volume"],
            "zero_values": zero, "negative_values": neg,
            "zero_volume_hours": len(zero_vol_idx), "zero_volume_flat_hours": flat_zero_vol,
            "zero_volume_hours_by_year": by_year(s, zero_vol_idx)}


def quantile_nearest_rank(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return float("nan")
    k = max(1, math.ceil(q * len(sorted_vals)))
    return sorted_vals[k - 1]


def rel_diff_stats(a: dict, b: dict, col: str = "close", from_ts: int | None = None,
                   to_ts: int | None = None) -> dict:
    """|a/b - 1| over hours where both grids have a value (b is the reference). Data check only."""
    lo = max(a["startTs"], b["startTs"], from_ts if from_ts is not None else -1)
    hi = min(a["startTs"] + STEP * (a["count"] - 1), b["startTs"] + STEP * (b["count"] - 1),
             to_ts if to_ts is not None else 1 << 62)
    av, bv = a["columns"][col], b["columns"][col]
    vals, max_rel, max_at, a_only, b_only = [], -1.0, None, 0, 0
    t = lo + ((-lo) % STEP)
    while t <= hi:
        x, y = av[(t - a["startTs"]) // STEP], bv[(t - b["startTs"]) // STEP]
        if x is not None and y is not None:
            r = abs(float(x) / float(y) - 1.0)
            vals.append(r)
            if r > max_rel:
                max_rel, max_at = r, iso_utc(t)
        elif x is not None:
            a_only += 1
        elif y is not None:
            b_only += 1
        t += STEP
    vals.sort()
    return {"from": iso_utc(lo), "to": iso_utc(hi), "column": col, "hours_both_present": len(vals),
            "hours_first_only": a_only, "hours_reference_only": b_only,
            "median_abs_rel_diff": quantile_nearest_rank(vals, 0.5),
            "p99_abs_rel_diff": quantile_nearest_rank(vals, 0.99),
            "max_abs_rel_diff": max_rel if vals else float("nan"), "max_at": max_at,
            "hours_gt_1pct": sum(1 for v in vals if v > 0.01)}


def leveraged(base: str, all_bases: set[str]) -> bool:
    """A leveraged token comes as a pair X+UP / X+DOWN (or BULL/BEAR) of base assets on the exchange."""
    for s1, s2 in LEVERAGED_SUFFIX_PAIRS:
        for mine, other in ((s1, s2), (s2, s1)):
            if base.endswith(mine) and len(base) > len(mine) and base[: -len(mine)] + other in all_bases:
                return True
    return False


def exclusion_reason(base: str, all_bases: set[str]) -> str | None:
    if base in CORE:
        return "ETH/BTC"
    if base in A22_HOLDOUTS:
        return "A2.2 holdout"
    if base in STABLE_FIAT_PEGGED:
        return "stablecoin/fiat/pegged"
    if base in WRAPPED_STAKED:
        return "wrapped/staked"
    if leveraged(base, all_bases):
        return "leveraged token"
    return None


def rank_usdt_pairs(exchange_info: dict, tickers: list) -> tuple[list[dict], set[str]]:
    """USDT spot pairs with status TRADING ranked by 24 h quoteVolume (desc; ties by symbol)."""
    all_bases = {s["baseAsset"] for s in exchange_info["symbols"]}
    qv = {t["symbol"]: t for t in tickers}
    pairs = []
    for s in exchange_info["symbols"]:
        if s.get("quoteAsset") != "USDT" or s.get("status") != "TRADING" or s.get("isSpotTradingAllowed") is not True:
            continue
        t = qv.get(s["symbol"])
        q = t["quoteVolume"] if t else "0"
        pairs.append({"symbol": s["symbol"], "baseAsset": s["baseAsset"], "quoteVolume": q,
                      "tickerOpenTime": t.get("openTime") if t else None,
                      "tickerCloseTime": t.get("closeTime") if t else None})
    pairs.sort(key=lambda p: (-Decimal(p["quoteVolume"]), p["symbol"]))
    for i, p in enumerate(pairs, start=1):
        p["rank"] = i
    return pairs, all_bases


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def bitstamp_url(start: int) -> str:
    return f"{BITSTAMP_URL}?step={STEP}&limit={BITSTAMP_LIMIT}&start={start}"


def coinbase_url(pid: str, start: int) -> str:
    end = start + (COINBASE_WINDOW - 1) * STEP
    return f"{COINBASE_URL.format(pid=pid)}?granularity={STEP}&start={iso_utc(start)}&end={iso_utc(end)}"


def binance_klines_url(symbol: str, start_ms: int, limit: int = BINANCE_LIMIT) -> str:
    return f"{BINANCE_BASE}/klines?symbol={symbol}&interval=1h&startTime={start_ms}&limit={limit}"


# ---------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------


class FetchStop(RuntimeError):
    pass


def urllib_get(url: str):
    """GET through the environment's proxy settings, TLS verified. Returns (status, body, headers)."""
    req = urllib.request.Request(url, headers={"user-agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            return r.status, r.read(), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        body = e.read() if e.fp else b""
        return e.code, body, {k.lower(): v for k, v in (e.headers or {}).items()}


class Http:
    """Paced GET for one host with the retry policy (60 s wait, at most 5 retries, then stop)."""

    def __init__(self, host: str, interval: float, events_path: Path | None = None, opener=urllib_get,
                 sleep=time.sleep, clock=time.monotonic):
        self.host, self.interval = host, interval
        self.opener, self.sleep, self.clock = opener, sleep, clock
        self.events_path = events_path
        self.requests = self.retries = 0
        self.status_counts: dict[str, int] = {}
        self.max_used_weight_1m = 0
        self._last = None

    def _event(self, ev: dict) -> None:
        ev = {"t": now_utc(), "host": self.host, **ev}
        print(json.dumps(ev), file=sys.stderr, flush=True)
        if self.events_path:
            with open(self.events_path, "a") as f:
                f.write(json.dumps(ev) + "\n")

    def _pace(self) -> None:
        if self._last is not None:
            wait = self.interval - (self.clock() - self._last)
            if wait > 0:
                self.sleep(wait)
        self._last = self.clock()

    def get(self, url: str):
        """Returns (body, info). The body is valid JSON. Raises FetchStop."""
        attempt = 0
        while True:
            self._pace()
            attempt += 1
            self.requests += 1
            status, body, headers, err = None, b"", {}, None
            try:
                status, body, headers = self.opener(url)
            except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
                err = f"transport: {e!r}"
            key = str(status) if status is not None else "transport"
            self.status_counts[key] = self.status_counts.get(key, 0) + 1
            w = headers.get("x-mbx-used-weight-1m")
            if w and str(w).isdigit():
                self.max_used_weight_1m = max(self.max_used_weight_1m, int(w))
            if status == 200:
                try:
                    json.loads(body)
                except ValueError as e:
                    err = f"unparseable body: {e}"
            elif status is not None:
                if status in RETRY_STATUSES or status >= 500:
                    err = f"HTTP {status}"
                else:
                    self._event({"kind": "stop", "url": url, "status": status,
                                 "body": body[:300].decode("utf-8", "replace")})
                    raise FetchStop(f"HTTP {status} for {url}: {body[:300]!r}")
            if err is None:
                return body, {"status": status, "attempts": attempt}
            if attempt > MAX_RETRIES:
                self._event({"kind": "stop", "url": url, "error": err, "attempts": attempt})
                raise FetchStop(f"{err} after {MAX_RETRIES} retries for {url}")
            self.retries += 1
            self._event({"kind": "retry", "url": url, "error": err, "attempt": attempt,
                         "retry_after": headers.get("retry-after"), "wait_s": RETRY_WAIT_S})
            self.sleep(RETRY_WAIT_S)

    def stats(self) -> dict:
        return {"requests": self.requests, "retries": self.retries, "status_counts": self.status_counts,
                "max_used_weight_1m": self.max_used_weight_1m}


# ---------------------------------------------------------------------------------------------
# Raw cache + request log
# ---------------------------------------------------------------------------------------------


def load_log(work: Path) -> dict:
    """(series, key) -> request record."""
    out, p = {}, work / "requests.jsonl"
    if p.exists():
        for line in p.read_text().splitlines():
            if line.strip():
                rec = json.loads(line)
                out[(rec["series"], str(rec["key"]))] = rec
    return out


def raw_path(work: Path, series: str, key) -> Path:
    return work / "raw" / series / f"{key}.json"


def cached_get(work: Path, http_: Http, log: dict, series: str, key, url: str, parse=None):
    """Raw body for (series, key): from the sha256-verified cache, else one logged request."""
    rec = log.get((series, str(key)))
    p = raw_path(work, series, key)
    if rec and p.exists() and sha256_file(p) == rec["sha256"]:
        return p.read_bytes(), rec
    t = now_utc()
    body, info = http_.get(url)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        rows = parse(body) if parse else None  # schema problems stop here (no retry)
    except ValueError as e:
        p.with_suffix(".rejected").write_bytes(body)
        raise FetchStop(f"{series} {key}: schema problem: {e}") from e
    p.write_bytes(body)
    rec = {"series": series, "key": str(key), "url": url, "status": info["status"], "bytes": len(body),
           "sha256": sha256_bytes(body), "fetchedAt": t, "attempts": info["attempts"]}
    if rows is not None:
        rec.update({"rows": len(rows), "firstOpen": min(r[0] for r in rows) if rows else None,
                    "lastOpen": max(r[0] for r in rows) if rows else None})
    with open(work / "requests.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    log[(series, str(key))] = rec
    return body, rec


def read_raw(work: Path, rec: dict) -> bytes:
    p = raw_path(work, rec["series"], rec["key"])
    b = p.read_bytes()
    if sha256_bytes(b) != rec["sha256"]:
        raise SystemExit(f"STOP: raw page {p} does not match its logged sha256")
    return b


# ---------------------------------------------------------------------------------------------
# Select (Binance holdout list, fixed once)
# ---------------------------------------------------------------------------------------------


def phase_select(work: Path, http_: Http) -> dict:
    sel_path = work / "selection.json"
    if sel_path.exists():
        sel = json.loads(sel_path.read_text())
        print(f"[select] reusing the fixed list: {[p['symbol'] for p in sel['kept']]}", file=sys.stderr)
        return sel
    log = load_log(work)
    ei_body, ei_rec = cached_get(work, http_, log, "select", "exchangeInfo", f"{BINANCE_BASE}/exchangeInfo")
    tk_body, tk_rec = cached_get(work, http_, log, "select", "ticker24hr", f"{BINANCE_BASE}/ticker/24hr")
    ei, tk = json.loads(ei_body), json.loads(tk_body)
    ranked, all_bases = rank_usdt_pairs(ei, tk)
    top = ranked[:TOP_N]
    table, kept = [], []
    for p in top:
        row = dict(p)
        row["excluded"] = exclusion_reason(p["baseAsset"], all_bases)
        if row["excluded"] is None:
            body, rec = cached_get(work, http_, log, "select", f"first-{p['symbol']}",
                                   binance_klines_url(p["symbol"], 0, 1), parse_binance)
            rows = parse_binance(body)
            if len(rows) != 1:
                raise FetchStop(f"first-kline probe for {p['symbol']} returned {len(rows)} rows")
            row["firstKlineOpen"] = iso_utc(rows[0][0])
            row["firstKlineOpenTs"] = rows[0][0]
            row["firstKlineRaw"] = body.decode()
            row["keep"] = rows[0][0] < FIRST_KLINE_BEFORE
            if row["keep"]:
                kept.append({"symbol": p["symbol"], "baseAsset": p["baseAsset"], "rank": p["rank"],
                             "firstKlineOpen": row["firstKlineOpen"]})
        else:
            row["keep"] = False
        table.append(row)
    sel = {
        "rule": ("Binance USDT spot pairs (quoteAsset USDT, status TRADING, isSpotTradingAllowed) ranked by "
                 f"24 h quoteVolume at fetch time; top {TOP_N}; exclude ETH, BTC, the eight A2.2 holdouts, "
                 "stablecoins/fiat/pegged, wrapped/staked and leveraged tokens; keep a pair whose first 1 h "
                 f"kline (startTime=0, limit=1) opens before {iso_utc(FIRST_KLINE_BEFORE)}."),
        "prereg": PREREG,
        "exchangeInfo": {"url": ei_rec["url"], "fetchedAt": ei_rec["fetchedAt"], "bytes": ei_rec["bytes"],
                         "sha256": ei_rec["sha256"], "serverTime": ei.get("serverTime"),
                         "serverTimeUtc": iso_utc(ei["serverTime"] // 1000) if ei.get("serverTime") else None},
        "ticker24hr": {"url": tk_rec["url"], "fetchedAt": tk_rec["fetchedAt"], "bytes": tk_rec["bytes"],
                       "sha256": tk_rec["sha256"],
                       "maxCloseTimeUtc": iso_utc(max(t["closeTime"] for t in tk) // 1000)},
        "usdtTradingSpotPairs": len(ranked),
        "exclusionLists": {"core": sorted(CORE), "a22Holdouts": sorted(A22_HOLDOUTS),
                           "stableFiatPegged": sorted(STABLE_FIAT_PEGGED), "wrappedStaked": sorted(WRAPPED_STAKED),
                           "leveraged": "base X+UP with X+DOWN (or X+BULL with X+BEAR) also a base asset"},
        "top": table,
        "kept": kept,
        "fixedAt": now_utc(),
    }
    sel_path.write_text(json.dumps(sel, indent=1) + "\n")
    print(f"[select] kept {[(k['symbol'], k['firstKlineOpen']) for k in kept]}", file=sys.stderr)
    return sel


def load_selection(work: Path) -> dict:
    p = work / "selection.json"
    if not p.exists():
        raise SystemExit("STOP: no selection.json; run the select phase first")
    return json.loads(p.read_text())


def all_series(sel: dict) -> list[dict]:
    out = [dict(s) for s in SERIES_FIXED]
    for k in sel["kept"]:
        out.append({"id": f"binance-{k['symbol']}", "asset": f"{k['baseAsset']}/USDT", "host": "binance",
                    "kind": "binance", "product": k["symbol"]})
    return out


def source_text(s: dict) -> str:
    if s["kind"] == "bitstamp":
        return f"Bitstamp OHLC, {BITSTAMP_URL}?step={STEP}&limit={BITSTAMP_LIMIT}&start=<unix> (public market data, no key)"
    if s["kind"] == "coinbase":
        return (f"Coinbase Exchange candles, {COINBASE_URL.format(pid=s['product'])}?granularity={STEP}"
                "&start=<iso>&end=<iso> (public market data, no key)")
    return f"Binance spot klines, {BINANCE_BASE}/klines?symbol={s['product']}&interval=1h (public market data, no key)"


# ---------------------------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------------------------


def window_plan(s: dict) -> tuple[int, int, callable]:
    if s["kind"] == "bitstamp":
        return BITSTAMP_SCAN_FROM, BITSTAMP_LIMIT, bitstamp_url
    return COINBASE_SCAN_FROM, COINBASE_WINDOW, lambda start: coinbase_url(s["product"], start)


def fetch_window_series(work: Path, http_: Http, s: dict) -> list[dict]:
    """Every window from the scan start to the end open. Rows must lie inside their window."""
    log = load_log(work)
    scan_from, wh, url_of = window_plan(s)
    parse = PARSERS[s["kind"]]
    pages, seen_data = [], False
    for start in window_starts(scan_from, wh):
        body, rec = cached_get(work, http_, log, s["id"], start, url_of(start), parse)
        rows = parse(body)
        outside = [r[0] for r in rows if not start <= r[0] <= start + (wh - 1) * STEP]
        if outside:
            raise FetchStop(f"{s['id']}: window {iso_utc(start)} returned rows outside it, first {iso_utc(outside[0])}")
        seen_data = seen_data or bool(rows)
        pages.append(rec)
    if not seen_data:
        raise FetchStop(f"{s['id']}: no candles at all")
    return pages


def fetch_binance_series(work: Path, http_: Http, s: dict) -> list[dict]:
    """Chain pages from startTime=0 (the first kline) to the end open."""
    log = load_log(work)
    sym, start, pages = s["product"], 0, []
    while True:
        body, rec = cached_get(work, http_, log, s["id"], start, binance_klines_url(sym, start), parse_binance)
        rows = parse_binance(body)
        pages.append(rec)
        if not rows:
            raise FetchStop(f"{sym}: empty page at startTime={start} before the end open")
        if rows[0][0] * 1000 < start:
            raise FetchStop(f"{sym}: page at startTime={start} begins earlier ({rows[0][0]})")
        last = rows[-1][0]
        if last >= END_OPEN:
            return pages
        if len(rows) < BINANCE_LIMIT:
            raise FetchStop(f"{sym}: short page ({len(rows)}) ends at {iso_utc(last)} before the end open")
        start = (last + STEP) * 1000


def series_pages(work: Path, s: dict) -> list[dict]:
    """Logged pages of one series in order (no requests)."""
    log = load_log(work)
    if s["kind"] in ("bitstamp", "coinbase"):
        scan_from, wh, _ = window_plan(s)
        out = []
        for start in window_starts(scan_from, wh):
            rec = log.get((s["id"], str(start)))
            if rec is None:
                raise SystemExit(f"STOP: {s['id']} fetch is incomplete (window {iso_utc(start)})")
            out.append(rec)
        return out
    out, start = [], 0
    while (rec := log.get((s["id"], str(start)))) is not None:
        out.append(rec)
        if not rec["rows"]:
            raise SystemExit(f"STOP: {s['id']} has an empty page at startTime={start}")
        if rec["lastOpen"] >= END_OPEN:
            return out
        start = (rec["lastOpen"] + STEP) * 1000
    raise SystemExit(f"STOP: {s['id']} fetch is incomplete (next startTime {start})")


def series_rows(work: Path, s: dict, pages: list[dict]) -> list[tuple]:
    parse, rows = PARSERS[s["kind"]], []
    for rec in pages:
        rows.extend(parse(read_raw(work, rec)))
    return rows


def phase_fetch(work: Path, https: dict, sel: dict) -> None:
    for s in all_series(sel):
        t0 = time.monotonic()
        h = https[s["host"]]
        pages = fetch_window_series(work, h, s) if s["kind"] != "binance" else fetch_binance_series(work, h, s)
        print(f"[fetch] {s['id']}: {len(pages)} pages, {sum(p.get('rows') or 0 for p in pages)} rows, "
              f"{time.monotonic() - t0:.1f}s; {s['host']} {h.stats()}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------
# Build / check / write
# ---------------------------------------------------------------------------------------------


def out_name(s: dict, gz: bool) -> str:
    return f"{s['id']}-1h.json" + (".gz" if gz else "")


def phase_build(work: Path, out: Path, sel: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for s in all_series(sel):
        pages = series_pages(work, s)
        grid = build_grid(series_rows(work, s, pages))
        fetched_at = max(p["fetchedAt"] for p in pages)
        data = serialize_grid(s["asset"], source_text(s), grid, fetched_at)
        back = json.loads(data)
        assert back["count"] == grid["count"] and all(len(back["columns"][c]) == grid["count"] for c in COLUMNS)
        gz = len(data) > GZIP_ABOVE_BYTES
        stale = out / out_name(s, not gz)
        if stale.exists():
            stale.unlink()
        path = out / out_name(s, gz)
        path.write_bytes(gzip.compress(data, mtime=0) if gz else data)
        if path.stat().st_size >= MAX_FILE_BYTES:
            raise SystemExit(f"STOP: {path} is {path.stat().st_size} bytes (limit 50 MB)")
        print(f"[build] {s['id']}: {path.name} {path.stat().st_size} bytes, count {grid['count']}", file=sys.stderr)


def load_grid_file(path: Path) -> dict:
    raw = path.read_bytes()
    if path.suffix == ".gz":
        raw = gzip.decompress(raw)
    d = json.loads(raw, parse_float=str, parse_int=str)
    d["startTs"], d["count"], d["stepSeconds"] = int(d["startTs"]), int(d["count"]), int(d["stepSeconds"])
    return d


def find_grid(dirpath: Path, stem: str) -> Path | None:
    for p in (dirpath / f"{stem}.json", dirpath / f"{stem}.json.gz"):
        if p.exists():
            return p
    return None


def datasets_dir() -> Path:
    env = os.environ.get("MEMBRANE_DATASETS_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[3].parent / "membrane-datasets"


def phase_check(work: Path, out: Path, sel: dict) -> dict:
    res = {"series": {}, "cross_check": {}, "inputs": {}}
    grids = {}
    for s in all_series(sel):
        pages = series_pages(work, s)
        rows = series_rows(work, s, pages)
        in_window = [r for r in rows if r[0] <= END_OPEN]
        path = find_grid(out, f"{s['id']}-1h")
        d = load_grid_file(path)
        rebuilt = build_grid(rows)
        grid = {"startTs": d["startTs"], "count": d["count"], "columns": d["columns"],
                "rows": rebuilt["rows"], "lastOpenTs": rebuilt["lastOpenTs"]}
        grids[s["id"]] = grid
        res["series"][s["id"]] = {
            "file": path.name, "asset": s["asset"], "pages": len(pages),
            "pages_empty": sum(1 for p in pages if not p.get("rows")),
            "rows_fetched": len(rows), "rows_after_end_dropped": len(rows) - len(in_window),
            "duplicate_identical": rebuilt["duplicate_identical"], "duplicate_conflicting": 0,
            "file_matches_raw": rebuilt["columns"] == grid["columns"] and rebuilt["startTs"] == grid["startTs"],
            **coverage(grid), **value_checks(grid),
        }
        c = res["series"][s["id"]]
        print(f"[check] {s['id']}: {c['first_open']} count {c['count']} nulls {c['null_hours']} "
              f"gap {c['longest_gap_hours']}h@{c['longest_gap_start']}", file=sys.stderr)
    res["cross_check"]["bitstamp_vs_coinbase_btc_close"] = rel_diff_stats(
        grids["bitstamp-btc-usd"], grids["coinbase-btc-usd"], "close")
    bk = datasets_dir() / "binance-klines"
    lo, hi = 1514764800, 1609455600  # 2018-01-01T00:00Z .. 2020-12-31T23:00Z
    for asset, pair, cb in (("ETH", "ETHUSDT", "coinbase-eth-usd"), ("BTC", "BTCUSDT", "coinbase-btc-usd")):
        p = find_grid(bk, f"{pair}-1h")
        key = f"coinbase_vs_binance_{asset.lower()}_close_2018_2020"
        if p is None:
            res["cross_check"][key] = {"skipped": f"{bk}/{pair}-1h.json not present at check time"}
            continue
        ref = load_grid_file(p)
        res["inputs"][f"binance-klines/{p.name}"] = {"sha256": sha256_file(p), "bytes": p.stat().st_size}
        res["cross_check"][key] = rel_diff_stats(grids[cb], ref, "close", lo, hi)
    (out / "checks.json").write_text(json.dumps(res, indent=1) + "\n")
    return res


def git_info() -> dict:
    root = Path(__file__).resolve().parents[3]
    try:
        def g(*a):
            return subprocess.check_output(["git", "-C", str(root), *a], text=True).strip()
        rel = str(Path(__file__).resolve().relative_to(root))
        return {"sha": g("rev-parse", "HEAD"), "branch": g("rev-parse", "--abbrev-ref", "HEAD"), "path": rel,
                "dirty": bool(g("status", "--porcelain", "--", rel)),
                "file_last_commit": g("log", "-1", "--format=%H", "--", rel),
                "file_sha256": sha256_file(Path(__file__).resolve())}
    except Exception as e:  # pragma: no cover
        return {"error": str(e)}


def load_run_log(work: Path) -> dict:
    p = work / "run-log.json"
    return json.loads(p.read_text()) if p.exists() else {"sessions": []}


def write_selection_files(work: Path, out: Path, sel: dict) -> list[str]:
    """Copy the raw snapshot bodies byte-for-byte (gzip if > 20 MB) and the derived list."""
    log = load_log(work)
    names = []
    for key, name in (("exchangeInfo", "binance-selection-exchangeInfo.json"),
                      ("ticker24hr", "binance-selection-ticker-24hr.json")):
        body = read_raw(work, log[("select", key)])
        gz = len(body) > GZIP_ABOVE_BYTES
        path = out / (name + (".gz" if gz else ""))
        path.write_bytes(gzip.compress(body, mtime=0) if gz else body)
        names.append(path.name)
    (out / "binance-selection.json").write_text(json.dumps(sel, indent=1) + "\n")
    names.append("binance-selection.json")
    return names


def phase_write(work: Path, out: Path, sel: dict, run_log: dict) -> None:
    log = load_log(work)
    checks = json.loads((out / "checks.json").read_text())
    sel_files = write_selection_files(work, out, sel)
    series_meta, used = {}, set()
    for s in all_series(sel):
        pages = series_pages(work, s)
        used |= {(p["series"], p["key"]) for p in pages}
        series_meta[s["id"]] = {
            "asset": s["asset"], "source": source_text(s), "file": checks["series"][s["id"]]["file"],
            "pages": [{k: p.get(k) for k in ("key", "url", "status", "bytes", "sha256", "rows", "firstOpen",
                                             "lastOpen", "fetchedAt", "attempts")} for p in pages]}
    sel_recs = [r for (ser, _), r in log.items() if ser == "select"]
    used |= {(r["series"], r["key"]) for r in sel_recs}
    fetch_sessions = [x for x in run_log["sessions"] if any(h.get("requests") for h in x.get("http", {}).values())]
    by_host: dict[str, dict] = {}
    for x in fetch_sessions:
        for host, h in x["http"].items():
            t = by_host.setdefault(host, {"requests": 0, "retries": 0, "max_used_weight_1m": 0})
            t["requests"] += h["requests"]
            t["retries"] += h["retries"]
            t["max_used_weight_1m"] = max(t["max_used_weight_1m"], h.get("max_used_weight_1m", 0))
    all_recs = [r for k, r in log.items() if k in used]
    manifest = {
        "dataset": "final-blind-prices",
        "status": "CANONICAL, LOCKED FINAL BLIND - do not score until a preregistration names it",
        "prereg": PREREG,
        "endOpenUtc": iso_utc(END_OPEN),
        "grid": {"stepSeconds": STEP, "columns": list(COLUMNS),
                 "convention": "index i is the candle opening at startTs + 3600*i; values are the source's decimal "
                               "text in plain notation (trailing zeros removed); null = no candle for that hour "
                               "in every column, never forward-filled"},
        "fetchWindowUtc": [min(r["fetchedAt"] for r in all_recs), max(r["fetchedAt"] for r in all_recs)],
        "http": {"byHost": by_host, "pages": len(all_recs), "logged_requests_unused": len(set(log) - used)},
        "sessions": run_log["sessions"],
        "selection": {"files": sel_files, "requests": sel_recs},
        "series": series_meta,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    write_provenance(out, manifest, checks, sel)


def fmt_rel(x) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.4f} %"


def write_provenance(out: Path, manifest: dict, checks: dict, sel: dict) -> None:
    pr = PREREG
    sess_lines = []
    for x in manifest["sessions"]:
        c = x.get("code", {})
        sess_lines.append(f"  {', '.join(x['phases'])}: HEAD `{c.get('sha')}`; builder `{c.get('file_last_commit')}`"
                          f" (sha256 `{c.get('file_sha256')}`){' DIRTY' if c.get('dirty') else ''}.")
    g = (manifest["sessions"] or [{}])[-1].get("code", {})
    hb = manifest["http"]["byHost"]
    req_line = "; ".join(f"{h} {v['requests']} requests, {v['retries']} retries" for h, v in sorted(hb.items()))
    kept = ", ".join(f"{k['symbol']} (rank {k['rank']}, first kline {k['firstKlineOpen']})" for k in sel["kept"])
    excluded = ", ".join(f"{r['symbol']} ({r['excluded'] or 'first kline ' + r.get('firstKlineOpen', '?')})"
                         for r in sel["top"] if not r["keep"])
    lines = [
        "# final-blind-prices — provenance",
        "",
        "**Status: CANONICAL, LOCKED FINAL BLIND — do not score until a preregistration names it.**",
        "",
        f"Q26 A2 deviation D1 (`{pr['repo']}` `{pr['path']}`, {pr['section']}, board commit `{pr['commit']}`).",
        "This set is locked and NOT scored in A2. It is scored once only, when a later preregistration names",
        "it as the final confirmation. The builder computed no outcome: no touch or drawdown frequency, no",
        "volatility statistic, no score. Only the data checks and source cross-checks below.",
        "",
        "## Sources",
        "",
        f"- **Bitstamp BTC/USD:** `{BITSTAMP_URL}?step=3600&limit={BITSTAMP_LIMIT}&start=<unix>`. Windows of",
        f"  {BITSTAMP_LIMIT} h from {iso_utc(BITSTAMP_SCAN_FROM)} (before Bitstamp opened); the first non-empty window",
        "  holds the first candle. Bitstamp emits a zero-volume candle (open = high = low = close = previous",
        "  close) for an hour without trades; those candles are kept as the source returned them and counted below.",
        "- **Coinbase Exchange ETH-USD, BTC-USD:** `https://api.exchange.coinbase.com/products/<ID>/candles?",
        f"  granularity=3600&start=<iso>&end=<iso>`, windows of {COINBASE_WINDOW} h (both ends inclusive) from",
        f"  {iso_utc(COINBASE_SCAN_FROM)} (before Coinbase Exchange opened). An hour without trades has no candle (null).",
        f"- **Binance USDT holdouts:** `{BINANCE_BASE}/klines?symbol=<PAIR>&interval=1h&startTime=<ms>&limit=1000`",
        "  from `startTime=0` (the first kline), next page = last open + 1 h.",
        f"- **Holdout list (fixed mechanically at fetch time):** {sel['rule']}",
        f"  Snapshot: `exchangeInfo` fetched {sel['exchangeInfo']['fetchedAt']} (serverTime {sel['exchangeInfo']['serverTimeUtc']}),",
        f"  `ticker/24hr` fetched {sel['ticker24hr']['fetchedAt']} (24 h window to {sel['ticker24hr']['maxCloseTimeUtc']}).",
        f"  {sel['usdtTradingSpotPairs']} USDT TRADING spot pairs ranked. Kept: {kept}.",
        f"  Top {TOP_N} not kept: {excluded}.",
        "  Raw bodies byte-for-byte: `binance-selection-exchangeInfo.json`, `binance-selection-ticker-24hr.json`;",
        "  the derivation (rank table, exclusion reason, first-kline raw text): `binance-selection.json`.",
        "- All requests: header `user-agent: curl/8.5.0`, TLS verified, free public endpoints, no key.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}`, `{g.get('path')}`. By session",
        "  (phases: HEAD; last commit touching the builder; its sha256):",
        *sess_lines,
        f"- **Fetch window (UTC):** {manifest['fetchWindowUtc'][0]} → {manifest['fetchWindowUtc'][1]}. {req_line};",
        f"  {manifest['http']['pages']} logged responses (raw sha256 each in `manifest.json`).",
        f"- **End:** the candle opening {manifest['endOpenUtc']}, inclusive.",
        "- **Grid:** `{asset, source, startTs, stepSeconds: 3600, count, columns: {open, high, low, close, volume}, fetchedAt}`.",
        "  `startTs` = the series' first candle open; index i opens at `startTs + 3600·i`; values are the source's",
        "  decimal text in plain notation (trailing zeros removed); a missing hour is null in every column, never",
        "  forward-filled. `fetchedAt` = the UTC time of the series' last page request.",
        "",
        "## Coverage and data checks",
        "",
        "| series | first open | last open | count | null hours | longest gap (h, UTC start) | zero-volume hours |",
        "|---|---|---|---:|---:|---|---:|",
    ]
    ser = checks["series"]
    for sid, c in ser.items():
        gap = f"{c['longest_gap_hours']} ({c['longest_gap_start']})" if c["longest_gap_hours"] else "0"
        lines.append(f"| {sid} | {c['first_open']} | {c['last_open']} | {c['count']} | {c['null_hours']} | {gap} | "
                     f"{c['zero_volume_hours']} |")
    tot = lambda k: sum(c[k] for c in ser.values())  # noqa: E731
    lines += [
        "",
        f"All series: duplicate candles {tot('duplicate_identical')} identical / 0 conflicting, "
        f"low > min(open, close) {tot('low_gt_min_open_close')}, high < max(open, close) {tot('high_lt_max_open_close')}, "
        f"low > high {tot('low_gt_high')}, non-positive prices {tot('nonpositive_price_values')}, negative volume "
        f"{tot('negative_volume')}, file matches raw: {all(c['file_matches_raw'] for c in ser.values())}. "
        "Null hours per year, zero-volume hours per year and per-series counts are in `checks.json`.",
        "",
        "## Cross-checks (source agreement, |a/b − 1| on hourly closes, both present; p99 = nearest rank)",
        "",
    ]
    for key, x in checks["cross_check"].items():
        if "skipped" in x:
            lines.append(f"- `{key}`: skipped — {x['skipped']}.")
        else:
            lines.append(f"- `{key}` ({x['from']} → {x['to']}): {x['hours_both_present']} hours, median "
                         f"{fmt_rel(x['median_abs_rel_diff'])}, p99 {fmt_rel(x['p99_abs_rel_diff'])}, max "
                         f"{fmt_rel(x['max_abs_rel_diff'])} at {x['max_at']}, {x['hours_gt_1pct']} hours > 1 %.")
    for k, v in checks.get("inputs", {}).items():
        lines.append(f"  Input `{k}` sha256 `{v['sha256']}` ({v['bytes']} bytes).")
    lines += ["", "## Files", "", "| file | bytes | sha256 |", "|---|---:|---|"]
    for p in sorted(out.iterdir()):
        if p.is_file() and p.name != "PROVENANCE.md":
            lines.append(f"| `{p.name}` | {p.stat().st_size} | `{sha256_file(p)}` |")
    (out / "PROVENANCE.md").write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

ALL_PHASES = ("select", "fetch", "build", "check", "write")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True, type=Path)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--phases", default="all")
    a = ap.parse_args(argv)
    phases = ALL_PHASES if a.phases == "all" else tuple(x.strip() for x in a.phases.split(","))
    unknown = set(phases) - set(ALL_PHASES)
    if unknown:
        ap.error(f"unknown phases {sorted(unknown)}")
    work = a.work_dir
    out = a.out_dir or datasets_dir() / "final-blind-prices"
    work.mkdir(parents=True, exist_ok=True)
    run_log = load_run_log(work)
    https = {h: Http(h, PACE_S[h], events_path=work / "events.jsonl") for h in PACE_S}
    session = {"phases": list(phases), "started": now_utc(), "code": git_info()}
    rc = 0
    try:
        sel = phase_select(work, https["binance"]) if "select" in phases else load_selection(work)
        if "fetch" in phases:
            phase_fetch(work, https, sel)
        if "build" in phases:
            phase_build(work, out, sel)
        if "check" in phases:
            phase_check(work, out, sel)
    except FetchStop as e:
        print(f"STOP: {e}", file=sys.stderr)
        rc = 2
    finally:
        session["ended"] = now_utc()
        session["http"] = {h: x.stats() for h, x in https.items()}
        if rc:
            session["stopped"] = True
        run_log["sessions"].append(session)
        (work / "run-log.json").write_text(json.dumps(run_log, indent=1) + "\n")
    if rc == 0 and "write" in phases:
        phase_write(work, out, sel, run_log)
    return rc


if __name__ == "__main__":
    sys.exit(main())
