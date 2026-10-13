#!/usr/bin/env python3
"""Q26 workstream A2 data acquisition: Binance spot hourly klines.

Implements membrane-board `design/HISTORY_TOUCH_PREREG_A2.md` section A2.1 (registered at
membrane-board commit 5e45406). It fetches and stores klines and runs data checks only:
coverage, gaps, schema, OHLC consistency, and a cross-check against price-history. It computes
no outcome: no touch frequencies, no drawdown or volatility statistics, no score.

Phases (resumable: every raw response body is cached in the work directory, never refetched):
  fetch   page /api/v3/klines for every pair; raw bodies and a request log in --work-dir
  build   one hourly grid per pair: <out>/<PAIR>-1h.json (gzip when > 20 MB)
  check   data checks: <out>/checks.json
  write   <out>/manifest.json (sha256 of every raw response) and <out>/PROVENANCE.md

Usage:
  python3 -I a2_fetch_binance.py --work-dir DIR [--out-dir DIR] [--phases all|fetch,build,check,write]

Endpoint: https://data-api.binance.vision only (free, no key). At most 4 requests per second.
HTTP 429/418, HTTP 5xx, an unparseable body or a transport error: wait 60 s and retry the same
request, at most 5 times, then stop. Any other HTTP status stops at once. Every retry is logged.

Grid convention (as membrane-datasets price-history): index i is the hour opening at
startTs + 3600*i; each column holds that kline's value; a missing hour is null in every column
(never forward-filled). startTs is the first kline open; the grid ends at the hour opening
END_OPEN inclusive. Values are written as the exact decimal text Binance returned, trailing
zeros removed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal
from pathlib import Path

# ---------------------------------------------------------------------------------------------
# Fixed by the preregistration (A2.1)
# ---------------------------------------------------------------------------------------------

BASE_URL = "https://data-api.binance.vision/api/v3/klines"
USER_AGENT = "curl/8.5.0"
INTERVAL = "1h"
LIMIT = 1000
STEP = 3600
STEP_MS = STEP * 1000

# (symbol, startTime parameter in ms). ETH and BTC from 2017-08-17T00:00Z; the holdout pairs
# from their first kline (startTime=0 returns the first kline the pair has).
PAIRS = (
    ("ETHUSDT", 1502928000000),
    ("BTCUSDT", 1502928000000),
    ("BNBUSDT", 0),
    ("XRPUSDT", 0),
    ("ADAUSDT", 0),
    ("LTCUSDT", 0),
    ("LINKUSDT", 0),
    ("DOGEUSDT", 0),
    ("SOLUSDT", 0),
    ("AVAXUSDT", 0),
)
END_OPEN_MS = 1791252000000  # 2026-10-06T02:00:00Z, the last kline open, inclusive

PREREG = {
    "repo": "membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A2.md",
    "section": "A2.1",
    "commit": "5e45406",
    "sha256": "3bc790ea94446de3fb4f645c4956accc44e02f36328d6d517489496c8fba9a80",
}

MAX_REQUESTS_PER_SECOND = 4  # registered ceiling is 5
RETRY_WAIT_S = 60
MAX_RETRIES = 5
HTTP_TIMEOUT_S = 60
RETRY_STATUSES = (418, 429)

GZIP_ABOVE_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 50 * 1024 * 1024

# Cross-check (data check only): price-history `binance` close and `binanceLow` columns.
XCHECK = {"ETHUSDT": "price-history/eth-usd-1h.json", "BTCUSDT": "price-history/btc-usd-1h.json"}
XCHECK_REL_TOL = 1e-4  # 0.01 %

COLUMNS = ("open", "high", "low", "close", "volume")
KLINE_FIELDS = 12  # openTime, o, h, l, c, v, closeTime, quoteVol, trades, takerBase, takerQuote, ignore
_NUM = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?$")


# ---------------------------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------------------------


def iso_utc(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def asset_name(symbol: str) -> str:
    assert symbol.endswith("USDT"), symbol
    return f"{symbol[:-4]}/USDT"


def norm_decimal(s) -> str:
    """Binance decimal text -> canonical JSON number text (exact; trailing zeros removed)."""
    if not isinstance(s, str) or not _NUM.match(s):
        raise ValueError(f"not a plain decimal string: {s!r}")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    if s == "-0":
        s = "0"
    return s


def row_problems(r) -> list[str]:
    """Schema problems of one kline array (empty list = valid)."""
    if not isinstance(r, list) or len(r) != KLINE_FIELDS:
        return ["shape"]
    out = []
    if not isinstance(r[0], int) or isinstance(r[0], bool):
        out.append("openTime")
    elif r[0] % STEP_MS:
        out.append("misaligned")
    if not isinstance(r[6], int) or isinstance(r[6], bool) or (isinstance(r[0], int) and r[6] != r[0] + STEP_MS - 1):
        out.append("closeTime")
    for k in range(1, 6):
        if not isinstance(r[k], str) or not _NUM.match(r[k]):
            out.append(COLUMNS[k - 1])
    return out


def order_problems(opens: list[int]) -> dict:
    """Duplicate and out-of-order opens in fetch order."""
    dup = unsorted = 0
    for a, b in zip(opens, opens[1:]):
        if b == a:
            dup += 1
        elif b < a:
            unsorted += 1
    return {"duplicate_opens": dup, "unsorted_opens": unsorted}


def build_grid(rows: list, end_open_ms: int = END_OPEN_MS) -> dict:
    """Kline arrays in fetch order -> hourly grid of exact decimal text (None = missing hour).

    Rows opening after end_open_ms are dropped. Raises on any schema, duplicate, order or
    alignment problem: the grid is never built from rows that fail a check.
    """
    bad = [(i, p) for i, r in enumerate(rows) if (p := row_problems(r))]
    if bad:
        raise ValueError(f"{len(bad)} rows fail the schema, first: {bad[0]}")
    rows = [r for r in rows if r[0] <= end_open_ms]
    if not rows:
        raise ValueError("no klines at or before the end open")
    opens = [r[0] for r in rows]
    op = order_problems(opens)
    if op["duplicate_opens"] or op["unsorted_opens"]:
        raise ValueError(f"opens not strictly increasing: {op}")
    first = opens[0]
    count = (end_open_ms - first) // STEP_MS + 1
    cols = {c: [None] * count for c in COLUMNS}
    for r in rows:
        i = (r[0] - first) // STEP_MS
        for k, c in enumerate(COLUMNS, start=1):
            cols[c][i] = norm_decimal(r[k])
    return {"startTs": first // 1000, "count": count, "columns": cols, "rows": len(rows),
            "lastOpenTs": opens[-1] // 1000}


def serialize_grid(symbol: str, grid: dict, fetched_at: str, source: str) -> bytes:
    """JSON text with keys in the convention's order; numbers are the exact decimal text."""
    def arr(vals):
        return "[" + ",".join("null" if v is None else v for v in vals) + "]"
    cols = ",".join(f"{json.dumps(c)}:{arr(grid['columns'][c])}" for c in COLUMNS)
    head = (f'{{"asset":{json.dumps(asset_name(symbol))},"source":{json.dumps(source)},'
            f'"startTs":{grid["startTs"]},"stepSeconds":{STEP},"count":{grid["count"]},')
    return (head + f'"columns":{{{cols}}},"fetchedAt":{json.dumps(fetched_at)}}}\n').encode()


def null_runs(col: list) -> list[tuple[int, int]]:
    """(start index, length) of every maximal run of None."""
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


def nulls_by_year(start_ts: int, col: list) -> dict[str, int]:
    out: dict[str, int] = {}
    for i, v in enumerate(col):
        if v is None:
            y = str(dt.datetime.fromtimestamp(start_ts + STEP * i, dt.timezone.utc).year)
            out[y] = out.get(y, 0) + 1
    return dict(sorted(out.items()))


def value_checks(grid: dict) -> dict:
    """OHLC consistency and zero/negative counts over present hours (exact decimal compare)."""
    c = grid["columns"]
    low_viol = high_viol = low_gt_high = 0
    zero = {k: 0 for k in COLUMNS}
    neg = {k: 0 for k in COLUMNS}
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
    return {"low_gt_min_open_close": low_viol, "high_lt_max_open_close": high_viol, "low_gt_high": low_gt_high,
            "zero_values": zero, "negative_values": neg}


def coverage(grid: dict) -> dict:
    col = grid["columns"]["close"]
    nulls = [i for i, v in enumerate(col) if v is None]
    # every column is null on exactly the same hours (one kline fills all five)
    same = all([i for i, v in enumerate(grid["columns"][k]) if v is None] == nulls for k in COLUMNS)
    runs = null_runs(col)
    longest = max(runs, key=lambda r: (r[1], -r[0])) if runs else None
    s = grid["startTs"]
    return {
        "first_open": iso_utc(s),
        "last_open": iso_utc(s + STEP * (grid["count"] - 1)),
        "last_kline_open": iso_utc(grid["lastOpenTs"]),
        "count": grid["count"],
        "klines": grid["rows"],
        "null_hours": len(nulls),
        "null_runs": len(runs),
        "null_hours_by_year": nulls_by_year(s, col),
        "longest_gap_hours": longest[1] if longest else 0,
        "longest_gap_start": iso_utc(s + STEP * longest[0]) if longest else None,
        "nulls_aligned_across_columns": same,
    }


def cross_check(grid: dict, ref: dict, ours_col: str, ref_col: str, rel_tol: float = XCHECK_REL_TOL) -> dict:
    """Compare one of our columns with a price-history column over the reference grid."""
    if int(ref["stepSeconds"]) != STEP:
        raise ValueError("reference step is not 3600")
    r0, rn = int(ref["startTs"]), int(ref["count"])
    rv = ref["columns"][ref_col]
    ov = grid["columns"][ours_col]
    both = over = exact = ours_null = ref_null = 0
    max_rel, max_at = 0.0, None
    for j in range(rn):
        ts = r0 + STEP * j
        i = (ts - grid["startTs"]) // STEP
        a = ov[i] if 0 <= i < grid["count"] else None
        b = rv[j]
        if a is None and b is None:
            continue
        if a is None:
            ours_null += 1
            continue
        if b is None:
            ref_null += 1
            continue
        both += 1
        fa, fb = float(a), float(b)
        if fa == fb:
            exact += 1
        rel = abs(fa - fb) / abs(fb) if fb else (0.0 if fa == 0 else float("inf"))
        if rel > rel_tol:
            over += 1
        if rel > max_rel:
            max_rel, max_at = rel, iso_utc(ts)
    return {"from": iso_utc(r0), "to": iso_utc(r0 + STEP * (rn - 1)), "column_ours": ours_col,
            "column_ref": ref_col, "hours_both_present": both, "hours_exact_equal": exact,
            "hours_rel_diff_gt_0.01pct": over, "ours_null_ref_present": ours_null,
            "ref_null_ours_present": ref_null, "max_rel_diff": max_rel, "max_rel_diff_at": max_at}


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def page_url(symbol: str, start_ms: int) -> str:
    return f"{BASE_URL}?symbol={symbol}&interval={INTERVAL}&startTime={start_ms}&limit={LIMIT}"


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


def parse_klines(body: bytes) -> list:
    rows = json.loads(body)
    if not isinstance(rows, list):
        raise ValueError(f"klines body is not a JSON array: {body[:200]!r}")
    return rows


class Http:
    """Paced GET with the registered retry policy."""

    def __init__(self, events_path: Path | None = None, opener=urllib_get, sleep=time.sleep,
                 clock=time.monotonic, interval: float = 1.0 / MAX_REQUESTS_PER_SECOND):
        self.opener, self.sleep, self.clock, self.interval = opener, sleep, clock, interval
        self.events_path = events_path
        self.requests = 0
        self.retries = 0
        self.status_counts: dict[str, int] = {}
        self.max_used_weight_1m = 0
        self._last = None

    def _event(self, ev: dict) -> None:
        ev = {"t": now_utc(), **ev}
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
        """Returns (body, rows, info). Stops (FetchStop) after MAX_RETRIES failed retries."""
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
            rows = None
            if status == 200:
                try:
                    rows = parse_klines(body)
                except ValueError as e:
                    err = f"unparseable body: {e}"
            elif status is not None:
                if status in RETRY_STATUSES or status >= 500:
                    err = f"HTTP {status}"
                else:
                    self._event({"kind": "stop", "url": url, "status": status, "body": body[:300].decode("utf-8", "replace")})
                    raise FetchStop(f"HTTP {status} for {url}: {body[:300]!r}")
            if err is None:
                return body, rows, {"status": status, "attempts": attempt, "usedWeight1m": w}
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
# Fetch (raw cache + request log)
# ---------------------------------------------------------------------------------------------


def load_log(path: Path) -> dict:
    """(symbol, startTime) -> page record."""
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip():
                rec = json.loads(line)
                out[(rec["symbol"], rec["startTime"])] = rec
    return out


def raw_path(work: Path, symbol: str, start_ms: int) -> Path:
    return work / "raw" / symbol / f"{start_ms}.json"


def fetch_pair(work: Path, http_: Http, symbol: str, start_param: int, end_open_ms: int = END_OPEN_MS) -> list[dict]:
    """Page one pair to the end open. Cached pages (sha256-verified) are not refetched."""
    log_path = work / "requests.jsonl"
    log = load_log(log_path)
    pages, start, page = [], start_param, 0
    while True:
        rec = log.get((symbol, start))
        p = raw_path(work, symbol, start)
        if rec and p.exists() and sha256_file(p) == rec["sha256"]:
            rows = parse_klines(p.read_bytes())
        else:
            url = page_url(symbol, start)
            t = now_utc()
            body, rows, info = http_.get(url)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            rec = {"symbol": symbol, "page": page, "startTime": start, "url": url, "status": info["status"],
                   "bytes": len(body), "sha256": sha256_bytes(body), "rows": len(rows),
                   "firstOpen": rows[0][0] if rows else None, "lastOpen": rows[-1][0] if rows else None,
                   "fetchedAt": t, "attempts": info["attempts"], "usedWeight1m": info["usedWeight1m"]}
            with open(log_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
        pages.append(rec)
        if not rows:
            raise FetchStop(f"{symbol}: empty page at startTime={start} before the end open")
        if rows[0][0] < start:
            raise FetchStop(f"{symbol}: page at startTime={start} begins earlier ({rows[0][0]})")
        last = rows[-1][0]
        if last >= end_open_ms:
            return pages
        if len(rows) < LIMIT:
            raise FetchStop(f"{symbol}: short page ({len(rows)}) ends at {last} before the end open")
        start = last + STEP_MS
        page += 1


def pair_rows(work: Path, pages: list[dict]) -> list:
    rows = []
    for rec in pages:
        p = raw_path(work, rec["symbol"], rec["startTime"])
        b = p.read_bytes()
        if sha256_bytes(b) != rec["sha256"]:
            raise SystemExit(f"STOP: raw page {p} does not match its logged sha256")
        rows.extend(parse_klines(b))
    return rows


def pair_pages(work: Path, symbol: str, start_param: int, end_open_ms: int = END_OPEN_MS) -> list[dict]:
    """Logged pages of one pair in chain order (no requests)."""
    log = load_log(work / "requests.jsonl")
    out, start = [], start_param
    while (rec := log.get((symbol, start))) is not None:
        out.append(rec)
        if not rec["rows"]:
            raise SystemExit(f"STOP: {symbol} has an empty page at startTime={start}")
        if rec["lastOpen"] >= end_open_ms:
            return out
        start = rec["lastOpen"] + STEP_MS
    raise SystemExit(f"STOP: {symbol} fetch is incomplete (next startTime {start}); run the fetch phase")


# ---------------------------------------------------------------------------------------------
# Repo / run metadata
# ---------------------------------------------------------------------------------------------


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def datasets_dir() -> Path:
    env = os.environ.get("MEMBRANE_DATASETS_DIR")
    return Path(env) if env else repo_root().parent / "membrane-datasets"


def git_info() -> dict:
    root = repo_root()
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


def source_text(symbol: str) -> str:
    return f"Binance spot klines, {BASE_URL}?symbol={symbol}&interval={INTERVAL} (public market data, no key)"


def out_name(symbol: str, gz: bool) -> str:
    return f"{symbol}-1h.json" + (".gz" if gz else "")


# ---------------------------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------------------------


def phase_fetch(work: Path, http_: Http) -> None:
    for symbol, start in PAIRS:
        t0 = time.monotonic()
        pages = fetch_pair(work, http_, symbol, start)
        print(f"[fetch] {symbol}: {len(pages)} pages, {sum(p['rows'] for p in pages)} rows, "
              f"{time.monotonic() - t0:.1f}s; http {http_.stats()}", file=sys.stderr, flush=True)


def phase_build(work: Path, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    built = {}
    for symbol, start in PAIRS:
        pages = pair_pages(work, symbol, start)
        rows = pair_rows(work, pages)
        grid = build_grid(rows)
        fetched_at = max(p["fetchedAt"] for p in pages)
        data = serialize_grid(symbol, grid, fetched_at, source_text(symbol))
        back = json.loads(data)  # round-trip guard
        assert back["count"] == grid["count"] and all(len(back["columns"][c]) == grid["count"] for c in COLUMNS)
        gz = len(data) > GZIP_ABOVE_BYTES
        for stale in (out_name(symbol, not gz),):
            if (out / stale).exists():
                (out / stale).unlink()
        path = out / out_name(symbol, gz)
        path.write_bytes(gzip.compress(data, mtime=0) if gz else data)
        if path.stat().st_size >= MAX_FILE_BYTES:
            raise SystemExit(f"STOP: {path} is {path.stat().st_size} bytes (limit 50 MB)")
        built[symbol] = path.name
        print(f"[build] {symbol}: {path.name} {path.stat().st_size} bytes, count {grid['count']}", file=sys.stderr)
    return built


def load_grid_file(path: Path) -> dict:
    """Read a written grid back as exact decimal text (no float conversion)."""
    raw = path.read_bytes()
    if path.suffix == ".gz":
        raw = gzip.decompress(raw)
    d = json.loads(raw, parse_float=str, parse_int=str)
    d["startTs"], d["count"], d["stepSeconds"] = int(d["startTs"]), int(d["count"]), int(d["stepSeconds"])
    return d


def phase_check(work: Path, out: Path) -> dict:
    ddir = datasets_dir()
    res = {"pairs": {}, "cross_check": {}, "inputs": {}}
    for symbol, start in PAIRS:
        pages = pair_pages(work, symbol, start)
        rows = pair_rows(work, pages)
        in_window = [r for r in rows if isinstance(r, list) and r and isinstance(r[0], int) and r[0] <= END_OPEN_MS]
        schema = {}
        for r in in_window:
            for prob in row_problems(r):
                schema[prob] = schema.get(prob, 0) + 1
        path = next(p for p in (out / out_name(symbol, False), out / out_name(symbol, True)) if p.exists())
        d = load_grid_file(path)
        grid = {"startTs": d["startTs"], "count": d["count"], "columns": d["columns"],
                "rows": len(in_window), "lastOpenTs": in_window[-1][0] // 1000}
        rebuilt = build_grid(rows)
        res["pairs"][symbol] = {
            "file": path.name,
            "pages": len(pages),
            "rows_fetched": len(rows),
            "rows_after_end_dropped": len(rows) - len(in_window),
            "file_matches_raw": rebuilt["columns"] == grid["columns"] and rebuilt["startTs"] == grid["startTs"],
            "schema_problems": schema,
            **order_problems([r[0] for r in in_window]),
            **coverage(grid),
            **value_checks(grid),
        }
        if symbol in XCHECK:
            ref_path = ddir / XCHECK[symbol]
            ref = json.loads(ref_path.read_bytes())
            res["inputs"][XCHECK[symbol]] = {"sha256": sha256_file(ref_path), "bytes": ref_path.stat().st_size}
            res["cross_check"][symbol] = {
                "close_vs_binance": cross_check(grid, ref, "close", "binance"),
                "low_vs_binanceLow": cross_check(grid, ref, "low", "binanceLow"),
            }
        print(f"[check] {symbol}: {json.dumps({k: res['pairs'][symbol][k] for k in ('count', 'null_hours', 'longest_gap_hours', 'longest_gap_start')})}",
              file=sys.stderr)
    (out / "checks.json").write_text(json.dumps(res, indent=1) + "\n")
    return res


def run_log_path(work: Path) -> Path:
    return work / "run-log.json"


def load_run_log(work: Path) -> dict:
    p = run_log_path(work)
    return json.loads(p.read_text()) if p.exists() else {"sessions": []}


def phase_write(work: Path, out: Path, run_log: dict) -> None:
    log = load_log(work / "requests.jsonl")
    checks = json.loads((out / "checks.json").read_text())
    pairs_meta, all_pages = {}, []
    for symbol, start in PAIRS:
        pages = pair_pages(work, symbol, start)
        all_pages += pages
        pairs_meta[symbol] = {"startTimeParam": start, "file": checks["pairs"][symbol]["file"],
                              "pages": [{k: p[k] for k in ("page", "startTime", "url", "status", "bytes", "sha256",
                                                            "rows", "firstOpen", "lastOpen", "fetchedAt", "attempts")}
                                        for p in pages]}
    used = {(p["symbol"], p["startTime"]) for p in all_pages}
    fetch_sessions = [s for s in run_log["sessions"] if s.get("http", {}).get("requests")]
    http_tot = {"requests": sum(s["http"]["requests"] for s in fetch_sessions),
                "retries": sum(s["http"]["retries"] for s in fetch_sessions),
                "pages": len(all_pages), "logged_pages_unused": len(set(log) - used),
                "max_used_weight_1m": max([s["http"]["max_used_weight_1m"] for s in fetch_sessions] or [0])}
    window = [min(p["fetchedAt"] for p in all_pages), max(p["fetchedAt"] for p in all_pages)]
    manifest = {
        "dataset": "binance-klines",
        "prereg": PREREG,
        "endpoint": BASE_URL,
        "params": {"interval": INTERVAL, "limit": LIMIT, "user-agent": USER_AGENT},
        "endOpenUtc": iso_utc(END_OPEN_MS // 1000),
        "grid": {"stepSeconds": STEP, "columns": list(COLUMNS),
                 "convention": "index i is the kline opening at startTs + 3600*i; values are that kline's "
                               "open/high/low/close/volume as Binance's decimal text (trailing zeros removed); "
                               "null = no kline for that hour in every column, never forward-filled"},
        "fetchWindowUtc": window,
        "http": http_tot,
        "sessions": run_log["sessions"],
        "pairs": pairs_meta,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    write_provenance(out, manifest, checks)


def write_provenance(out: Path, manifest: dict, checks: dict) -> None:
    pr = PREREG
    sess_lines = []
    for s in manifest["sessions"]:
        c = s.get("code", {})
        sess_lines.append(f"  {', '.join(s['phases'])}: HEAD `{c.get('sha')}`; builder `{c.get('file_last_commit')}`"
                          f" (sha256 `{c.get('file_sha256')}`){' DIRTY' if c.get('dirty') else ''}.")
    g = (manifest["sessions"] or [{}])[-1].get("code", {})
    h = manifest["http"]
    lines = [
        "# binance-klines — provenance",
        "",
        "Binance spot hourly klines for Q26 workstream A2 (ETH and BTC long history, B-span blind set,",
        "and the eight holdout pairs). Fetched exactly as preregistered in",
        f"`{pr['repo']}` `{pr['path']}` §{pr['section']} (commit `{pr['commit']}`, sha256 `{pr['sha256'][:8]}…{pr['sha256'][-4:]}`).",
        "The builder computes no outcome (no touch frequencies, drawdown or volatility statistics, no score).",
        "",
        f"- **Source:** `{BASE_URL}?symbol=<PAIR>&interval={INTERVAL}&startTime=<ms>&limit={LIMIT}` (free, no key),",
        f"  header `user-agent: {USER_AGENT}`. ETHUSDT and BTCUSDT from `startTime` 2017-08-17T00:00Z; the other pairs from",
        "  `startTime=0` (each pair's first kline). Next page `startTime` = last open + 1 h. Paced ≤ "
        f"{MAX_REQUESTS_PER_SECOND} requests/s.",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}`, `{g.get('path')}`. By session",
        "  (phases: HEAD; last commit touching the builder; its sha256):",
        *sess_lines,
        f"- **Fetch window (UTC):** {manifest['fetchWindowUtc'][0]} → {manifest['fetchWindowUtc'][1]}. "
        f"{h['requests']} HTTP requests, {h['retries']} retries, {h['pages']} pages.",
        f"- **End:** the kline opening {manifest['endOpenUtc']}, inclusive.",
        "- **Grid:** `{asset, source, startTs, stepSeconds: 3600, count, columns: {open, high, low, close, volume}, fetchedAt}`.",
        "  `startTs` = the first kline open; index i opens at `startTs + 3600·i`; values are Binance's decimal text",
        "  (trailing zeros removed); a missing hour is null in every column, never forward-filled. `fetchedAt` = the",
        "  UTC time of the pair's last page request.",
        "- **Status:** CANONICAL (inputs to Q26 A2; do not refetch or edit). Raw response sha256 per request in",
        "  `manifest.json`; data checks in `checks.json`.",
        "",
        "| pair | first open | last open | count | null hours | longest gap (h, UTC start) |",
        "|---|---|---|---:|---:|---|",
    ]
    for symbol, _ in PAIRS:
        c = checks["pairs"][symbol]
        gap = f"{c['longest_gap_hours']} ({c['longest_gap_start']})" if c["longest_gap_hours"] else "0"
        lines.append(f"| {symbol} | {c['first_open']} | {c['last_open']} | {c['count']} | {c['null_hours']} | {gap} |")
    tot = lambda k: sum(checks["pairs"][s][k] for s, _ in PAIRS)  # noqa: E731
    neg = sum(sum(checks["pairs"][s]["negative_values"].values()) for s, _ in PAIRS)
    schema = sum(sum(checks["pairs"][s]["schema_problems"].values()) for s, _ in PAIRS)
    lines += [
        "",
        "Data checks (all pairs): duplicate opens "
        f"{tot('duplicate_opens')}, unsorted opens {tot('unsorted_opens')}, schema problems {schema}, "
        f"low > min(open, close) {tot('low_gt_min_open_close')}, high < max(open, close) {tot('high_lt_max_open_close')}, "
        f"negative values {neg}. Zero values per pair are in `checks.json`.",
    ]
    for symbol, x in checks.get("cross_check", {}).items():
        cc = x["close_vs_binance"]
        lines.append(f"Cross-check {symbol} close vs `{XCHECK[symbol]}` `binance` ({cc['from']} → {cc['to']}): "
                     f"{cc['hours_both_present']} hours both present, {cc['hours_rel_diff_gt_0.01pct']} with |diff| > 0.01 %, "
                     f"{cc['ours_null_ref_present']} null here only, {cc['ref_null_ours_present']} null there only.")
    lines += ["", "| file | bytes | sha256 |", "|---|---:|---|"]
    for p in sorted(out.iterdir()):
        if p.is_file() and p.name != "PROVENANCE.md":
            lines.append(f"| `{p.name}` | {p.stat().st_size} | `{sha256_file(p)}` |")
    (out / "PROVENANCE.md").write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

ALL_PHASES = ("fetch", "build", "check", "write")


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
    out = a.out_dir or datasets_dir() / "binance-klines"
    work.mkdir(parents=True, exist_ok=True)
    run_log = load_run_log(work)
    http_ = Http(events_path=work / "events.jsonl")
    session = {"phases": list(phases), "started": now_utc(), "code": git_info()}
    rc = 0
    try:
        if "fetch" in phases:
            phase_fetch(work, http_)
        if "build" in phases:
            phase_build(work, out)
        if "check" in phases:
            phase_check(work, out)
    except FetchStop as e:
        print(f"STOP: {e}", file=sys.stderr)
        rc = 2
    finally:
        session["ended"] = now_utc()
        session["http"] = http_.stats()
        if rc:
            session["stopped"] = True
        run_log["sessions"].append(session)
        run_log_path(work).write_text(json.dumps(run_log, indent=1) + "\n")
    if rc == 0 and "write" in phases:
        phase_write(work, out, run_log)
    return rc


if __name__ == "__main__":
    sys.exit(main())
