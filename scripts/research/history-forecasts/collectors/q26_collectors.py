#!/usr/bin/env python3
"""Q26 forward data collectors -- triccs/membrane-board design/Q26_COLLECTORS.md (preregistered at 14d01a8).

One run fetches each source once and writes one file per source:

    <out>/collectors/<source>/YYYY/MM/DD/HHMM.json.gz     (HHMM = the run's UTC start slot)
    <out>/collectors/manifest/YYYY/MM/DD.jsonl            (append-only, one line per source per run)

Sources (C.2), each in its own function and each failing on its own:
    polymarket-eth, polymarket-btc  Gamma (event discovery + market fields) and CLOB (top of book)
    deribit                         ETH option book summary + per-option ticker (bid/ask IV), DVOL, perpetual
    lido                            withdrawal-queue wait, stETH APR, Curve ETH/stETH pool balances
    hyperliquid                     ETH open interest + funding, and a histogram of open ETH notional by
                                    liquidation price in 1%-of-spot bins (aggregated in memory)

Rules enforced here:
- A data file is written with O_EXCL: an existing file is never rewritten (that source is reported "exists").
- A source whose required call fails writes no data file; its manifest line records the HTTP statuses.
- No address is ever stored. Records are built from whitelisted fields, and every serialized record is
  checked for a 0x + 40-hex string before it is written; a match fails that source (nothing is written).
- Every record carries the real fetch time, endpoint, HTTP status and sha256 of each response body.

Standard library only. Run:
    python3 q26_collectors.py --out <datasets checkout> [--sources lido,deribit] [--app-commit SHA]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "q26-collectors/1"
USER_AGENT = "membrane-q26-collectors/1 (+https://github.com/The-Membrane/membrane-app)"
TIMEOUT_S = 30
RETRIES = 3  # attempts per request on 429 / 5xx / network error

ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
DERIBIT = "https://www.deribit.com/api/v2/public"
LIDO_WQ = "https://wq-api.lido.fi/v2/request-time/calculate"
LIDO_APR_LAST = "https://eth-api.lido.fi/v1/protocol/steth/apr/last"
LIDO_APR_SMA = "https://eth-api.lido.fi/v1/protocol/steth/apr/sma"
CURVE_POOL_URL = "https://prices.curve.finance/v1/pools/ethereum/{pool}"
CURVE_STETH_POOL = "0x" + "DC24316b9AE028F1497c275EB9192a3Ea0f67022"  # Curve.fi ETH/stETH; never written out
HL_INFO = "https://api.hyperliquid.xyz/info"
HL_LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"

POLY_TITLE_RE = re.compile(r"^\s*What price will (Ethereum|Bitcoin) hit\b", re.I)
POLY_TAGS = {"ethereum": "Ethereum", "bitcoin": "Bitcoin"}
POLY_SOURCE = {"Ethereum": "polymarket-eth", "Bitcoin": "polymarket-btc"}
CLOB_CHUNK = 100

DERIBIT_RATE = 10.0   # requests / s for the per-option ticker sweep
DERIBIT_WORKERS = 4
HL_RATE = 8.0         # clearinghouseState is weight 2 of the 1200/min IP budget -> 960/min
HL_WORKERS = 4
HL_TOP_N = 1000       # accounts = top N by account value U top N by 30d volume U top N by 1d volume
HL_COIN = "ETH"

ALL_SOURCES = ["polymarket", "deribit", "lido", "hyperliquid"]


# ----------------------------------------------------------------------------------------------- HTTP

def utc_iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"


def default_transport(method: str, url: str, body: bytes | None, headers: dict) -> tuple[int, bytes]:
    """One HTTP request. Returns (status, body); raises on network error."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            data = e.read()
        except Exception:  # noqa: BLE001
            data = b""
        return e.code, data


class Http:
    """Retrying JSON client. Each call returns (parsed_or_None, request_record).

    The request record never holds a request body (Hyperliquid bodies name accounts) and holds the
    endpoint only as given by `label` (default: the URL)."""

    def __init__(self, transport=default_transport, sleep=time.sleep):
        self.transport = transport
        self.sleep = sleep

    def call(self, method: str, url: str, payload=None, label: str | None = None):
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        rec = {"endpoint": label or url, "method": method, "http_status": None, "attempts": 0,
               "fetched_at": None, "bytes": None, "sha256": None, "error": None}
        data = None
        for attempt in range(1, RETRIES + 1):
            rec["attempts"] = attempt
            rec["fetched_at"] = utc_iso()
            try:
                status, raw = self.transport(method, url, body, headers)
            except Exception as e:  # noqa: BLE001 -- network errors: retry, then record
                rec["http_status"], rec["error"] = None, f"{type(e).__name__}: {str(e)[:160]}"
                if attempt < RETRIES:
                    self.sleep(2 ** (attempt - 1))
                continue
            rec["http_status"], rec["bytes"] = status, len(raw)
            rec["sha256"] = hashlib.sha256(raw).hexdigest()
            if status == 429 or status >= 500:
                rec["error"] = f"HTTP {status}"
                if attempt < RETRIES:
                    self.sleep(2 ** (attempt - 1))
                continue
            if status != 200:
                rec["error"] = f"HTTP {status}"
                break
            try:
                data = json.loads(raw)
                rec["error"] = None
            except ValueError as e:
                rec["error"] = f"bad JSON: {str(e)[:120]}"
            break
        return data, rec

    def get(self, url, label=None):
        return self.call("GET", url, None, label)

    def post(self, url, payload, label=None):
        return self.call("POST", url, payload, label)


class RateLimiter:
    """Shared minimum spacing between request starts, across threads."""

    def __init__(self, per_second: float, sleep=time.sleep, clock=time.monotonic):
        self.gap = 1.0 / per_second if per_second > 0 else 0.0
        self.sleep, self.clock = sleep, clock
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self):
        with self.lock:
            now = self.clock()
            at = max(now, self.next_at)
            self.next_at = at + self.gap
        if at > now:
            self.sleep(at - now)


def sweep_summary(label: str, recs: list[dict]) -> dict:
    """One request record for a sweep of many similar calls."""
    counts: dict[str, int] = {}
    for r in recs:
        k = str(r["http_status"]) if r["http_status"] is not None else "network-error"
        counts[k] = counts.get(k, 0) + 1
    times = sorted(r["fetched_at"] for r in recs if r["fetched_at"])
    return {"endpoint": label, "method": recs[0]["method"] if recs else None, "sweep": True,
            "count": len(recs), "http_status_counts": counts,
            "ok": sum(1 for r in recs if r["http_status"] == 200 and r["error"] is None),
            "first_fetched_at": times[0] if times else None, "last_fetched_at": times[-1] if times else None,
            "bytes": sum(r["bytes"] or 0 for r in recs)}


def ok(rec: dict) -> bool:
    return rec["http_status"] == 200 and rec["error"] is None


class SourceFailed(Exception):
    def __init__(self, msg, requests):
        super().__init__(msg)
        self.requests = requests


def fnum(x):
    """float or None (Gamma and Hyperliquid send numbers as strings)."""
    if x is None or x == "":
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


# ----------------------------------------------------------------------------------------- Polymarket

STRIKE_RE = re.compile(r"\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kKmM])?")


def parse_strike(question: str):
    m = STRIKE_RE.search(question or "")
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    mult = {"k": 1e3, "m": 1e6}.get((m.group(2) or "").lower(), 1)
    return v * mult


def parse_side(question: str, group_title: str | None):
    q = (question or "").lower()
    if re.search(r"\bdip\b|\bfall\b|\bdrop\b|\bbelow\b", q) or (group_title or "").startswith("↓"):
        return "dip"
    if re.search(r"\breach\b|\bhit\b|\babove\b", q) or (group_title or "").startswith("↑"):
        return "reach"
    return None


def parse_iso(x):
    try:
        return datetime.fromisoformat(str(x).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def classify_window(series_slug: str | None, slug: str, start=None, end=None) -> str:
    """By the event's own span (start to end) when both dates parse; else by series slug, then event slug.
    The span comes first because Polymarket files the 'hit in 2026' event under the monthly series."""
    a, b = parse_iso(start), parse_iso(end)
    if a and b and b > a:
        days = (b - a).total_seconds() / 86400
        return "daily" if days <= 1.5 else "weekly" if days <= 8 else "monthly" if days <= 32 else "long"
    s = (series_slug or "").lower()
    for w in ("daily", "weekly", "monthly", "yearly", "annual"):
        if w in s:
            return "long" if w in ("yearly", "annual") else w
    sl = slug.lower()
    if re.search(r"-on-[a-z]+-\d{1,2}-\d{4}$", sl):
        return "daily"
    if re.search(r"-[a-z]+-\d{1,2}-\d{1,2}-\d{4}$", sl) or re.search(r"-[a-z]+-\d{1,2}-[a-z]+-\d{1,2}", sl):
        return "weekly"
    if re.search(r"-in-[a-z]+-\d{4}$", sl):
        return "monthly"
    if re.search(r"-before-\d{4}$|-in-\d{4}$", sl):
        return "long"
    return "other"


def json_list(x):
    if isinstance(x, list):
        return x
    if isinstance(x, str):
        try:
            v = json.loads(x)
            return v if isinstance(v, list) else None
        except ValueError:
            return None
    return None


def discover_polymarket(http: Http):
    """All active, open 'What price will Ethereum/Bitcoin hit' events, deduplicated by event id."""
    reqs, events = [], {}
    for tag in POLY_TAGS:
        offset = 0
        while True:
            url = f"{GAMMA}/events?tag_slug={tag}&active=true&closed=false&limit=100&offset={offset}"
            data, rec = http.get(url)
            reqs.append(rec)
            if not ok(rec) or not isinstance(data, list):
                raise SourceFailed(f"gamma events tag={tag} offset={offset}: {rec['error']}", reqs)
            for e in data:
                m = POLY_TITLE_RE.match(e.get("title") or "")
                if m and not e.get("closed"):
                    events.setdefault(str(e.get("id")), (m.group(1).capitalize(), e))  # first seen wins
            if len(data) < 100 or offset >= 5000:
                break
            offset += 100
    return events, reqs


def market_row(m: dict) -> dict:
    toks = json_list(m.get("clobTokenIds")) or []
    outcomes = json_list(m.get("outcomes")) or []
    prices = json_list(m.get("outcomePrices")) or []
    q = m.get("question") or ""
    return {
        "market_id": str(m.get("id")), "condition_id": m.get("conditionId"), "slug": m.get("slug"),
        "question": q, "group_item_title": m.get("groupItemTitle"),
        "strike": parse_strike(q), "side": parse_side(q, m.get("groupItemTitle")),
        "start": m.get("startDate"), "end": m.get("endDate"),
        "active": m.get("active"), "closed": m.get("closed"), "accepting_orders": m.get("acceptingOrders"),
        "outcomes": outcomes, "yes_token": str(toks[0]) if toks else None,
        "no_token": str(toks[1]) if len(toks) > 1 else None,
        "gamma_best_bid": fnum(m.get("bestBid")), "gamma_best_ask": fnum(m.get("bestAsk")),
        "gamma_last_trade_price": fnum(m.get("lastTradePrice")),
        "gamma_outcome_prices": [fnum(p) for p in prices],
        "volume": fnum(m.get("volumeNum", m.get("volume"))), "volume_24h": fnum(m.get("volume24hr")),
        "liquidity": fnum(m.get("liquidityNum", m.get("liquidity"))),
        "updated_at": m.get("updatedAt"), "clob": None,
    }


def top_of_book(book: dict) -> dict:
    def levels(side):
        out = []
        for lv in book.get(side) or []:
            p, s = fnum(lv.get("price")), fnum(lv.get("size"))
            if p is not None:
                out.append((p, s))
        return out
    bids, asks = levels("bids"), levels("asks")
    bb = max(bids, key=lambda t: t[0]) if bids else (None, None)
    ba = min(asks, key=lambda t: t[0]) if asks else (None, None)
    ts = book.get("timestamp")
    return {"best_bid": bb[0], "best_bid_size": bb[1], "best_ask": ba[0], "best_ask_size": ba[1],
            "last_trade_price": fnum(book.get("last_trade_price")),
            "book_ts_ms": int(ts) if str(ts or "").isdigit() else None,
            "bid_levels": len(bids), "ask_levels": len(asks)}


def collect_polymarket(http: Http) -> dict[str, tuple[dict, list]]:
    """Returns {source_name: (data, requests)} for polymarket-eth and polymarket-btc.
    Gamma discovery is required (raises SourceFailed for both); CLOB failures leave clob = null."""
    events, reqs = discover_polymarket(http)
    by_asset: dict[str, list] = {"Ethereum": [], "Bitcoin": []}
    yes_rows = {}
    for eid in sorted(events, key=lambda k: (events[k][1].get("endDate") or "", k)):
        asset, e = events[eid]
        rows = [market_row(m) for m in e.get("markets") or []]  # closed (resolved) rungs kept, flagged
        for r in rows:
            if r["yes_token"] and not r["closed"]:
                yes_rows.setdefault(r["yes_token"], []).append(r)
        by_asset[asset].append({
            "event_id": eid, "slug": e.get("slug"), "title": e.get("title"),
            "series_slug": e.get("seriesSlug"),
            "window": classify_window(e.get("seriesSlug"), e.get("slug") or "", e.get("startDate"), e.get("endDate")),
            "start": e.get("startDate"), "end": e.get("endDate"),
            "resolution_source": e.get("resolutionSource"),
            "volume": fnum(e.get("volume")), "liquidity": fnum(e.get("liquidity")),
            "open_interest": fnum(e.get("openInterest")), "markets": rows,
        })
    clob_recs = []
    toks = sorted(yes_rows)
    for i in range(0, len(toks), CLOB_CHUNK):
        chunk = toks[i:i + CLOB_CHUNK]
        data, rec = http.post(f"{CLOB}/books", [{"token_id": t} for t in chunk])
        clob_recs.append(rec)
        if ok(rec) and isinstance(data, list):
            for b in data:
                for r in yes_rows.get(str(b.get("asset_id")), []):
                    r["clob"] = top_of_book(b)
    clob_req = [sweep_summary(f"{CLOB}/books (POST, yes tokens in chunks of {CLOB_CHUNK})", clob_recs)] if clob_recs else []
    out = {}
    for asset, evs in by_asset.items():
        n_m = sum(len(e["markets"]) for e in evs)
        n_c = sum(1 for e in evs for r in e["markets"] if r["clob"] is not None)
        out[POLY_SOURCE[asset]] = ({"asset": asset, "events": evs, "n_events": len(evs), "n_markets": n_m,
                                    "n_markets_with_clob": n_c}, reqs + clob_req)
    return out


# -------------------------------------------------------------------------------------------- Deribit

OPT_NAME_RE = re.compile(r"^ETH-(\d{1,2}[A-Z]{3}\d{2})-(\d+(?:d\d+)?)-([CP])$")
OPT_COLUMNS = ["instrument", "expiry", "strike", "type", "mark_iv", "bid_iv", "ask_iv", "mark_price",
               "bid_price", "ask_price", "best_bid_amount", "best_ask_amount", "last", "underlying_price",
               "underlying_index", "open_interest", "volume", "volume_usd", "interest_rate", "delta", "gamma",
               "vega", "theta", "summary_ts_ms", "ticker_ts_ms"]


def collect_deribit(http: Http, rate: float = DERIBIT_RATE, workers: int = DERIBIT_WORKERS, sleep=time.sleep):
    reqs = []
    summ, rec = http.get(f"{DERIBIT}/get_book_summary_by_currency?currency=ETH&kind=option")
    reqs.append(rec)
    if not ok(rec) or not isinstance(summ, dict) or not isinstance(summ.get("result"), list):
        raise SourceFailed(f"book summary: {rec['error']}", reqs)
    rows = {}
    for s in summ["result"]:
        name = s.get("instrument_name") or ""
        m = OPT_NAME_RE.match(name)
        rows[name] = {
            "instrument": name, "expiry": m.group(1) if m else None,
            "strike": float(m.group(2).replace("d", ".")) if m else None, "type": m.group(3) if m else None,
            "mark_iv": fnum(s.get("mark_iv")), "bid_iv": None, "ask_iv": None,
            "mark_price": fnum(s.get("mark_price")), "bid_price": fnum(s.get("bid_price")),
            "ask_price": fnum(s.get("ask_price")), "best_bid_amount": None, "best_ask_amount": None,
            "last": fnum(s.get("last")), "underlying_price": fnum(s.get("underlying_price")),
            "underlying_index": s.get("underlying_index"), "open_interest": fnum(s.get("open_interest")),
            "volume": fnum(s.get("volume")), "volume_usd": fnum(s.get("volume_usd")),
            "interest_rate": fnum(s.get("interest_rate")), "delta": None, "gamma": None, "vega": None,
            "theta": None, "summary_ts_ms": s.get("creation_timestamp"), "ticker_ts_ms": None,
        }

    limiter = RateLimiter(rate, sleep=sleep)

    def ticker(name):
        limiter.wait()
        return name, *http.get(f"{DERIBIT}/ticker?instrument_name={name}")

    tick_recs = []
    with ThreadPoolExecutor(max(1, workers)) as ex:
        for name, data, trec in ex.map(ticker, sorted(rows)):
            tick_recs.append(trec)
            res = data.get("result") if ok(trec) and isinstance(data, dict) else None
            if isinstance(res, dict):
                g = res.get("greeks") or {}
                rows[name].update({
                    "bid_iv": fnum(res.get("bid_iv")), "ask_iv": fnum(res.get("ask_iv")),
                    "best_bid_amount": fnum(res.get("best_bid_amount")),
                    "best_ask_amount": fnum(res.get("best_ask_amount")),
                    "delta": fnum(g.get("delta")), "gamma": fnum(g.get("gamma")), "vega": fnum(g.get("vega")),
                    "theta": fnum(g.get("theta")), "ticker_ts_ms": res.get("timestamp")})
    if tick_recs:
        reqs.append(sweep_summary(f"{DERIBIT}/ticker?instrument_name=<each option>", tick_recs))

    end_ms = int(time.time() * 1000)
    dvol, rec = http.get(f"{DERIBIT}/get_volatility_index_data?currency=ETH&resolution=60"
                         f"&start_timestamp={end_ms - 3_600_000}&end_timestamp={end_ms}")
    reqs.append(rec)
    dvol_rows = None
    if ok(rec) and isinstance(dvol, dict):
        dvol_rows = (dvol.get("result") or {}).get("data")
    perp, rec = http.get(f"{DERIBIT}/ticker?instrument_name=ETH-PERPETUAL")
    reqs.append(rec)
    perp_out = None
    if ok(rec) and isinstance(perp, dict) and isinstance(perp.get("result"), dict):
        p = perp["result"]
        perp_out = {k: p.get(k) for k in ("timestamp", "index_price", "mark_price", "last_price",
                                           "current_funding", "funding_8h", "interest_value",
                                           "open_interest", "best_bid_price", "best_ask_price")}
    ordered = [rows[k] for k in sorted(rows)]
    return {
        "currency": "ETH",
        "options": {"columns": OPT_COLUMNS, "rows": [[r[c] for c in OPT_COLUMNS] for r in ordered]},
        "n_options": len(ordered), "n_with_ticker": sum(1 for r in ordered if r["ticker_ts_ms"] is not None),
        "dvol_1m_last_hour": {"columns": ["ts_ms", "open", "high", "low", "close"], "rows": dvol_rows},
        "perpetual": perp_out,
    }, reqs


# ----------------------------------------------------------------------------------------------- Lido

def collect_lido(http: Http):
    """Three independent parts; the source fails only if all three fail."""
    reqs, out = [], {"withdrawal_queue": None, "steth_apr_last": None, "steth_apr_sma": None, "curve_steth_pool": None}
    wq, rec = http.get(LIDO_WQ)
    reqs.append(rec)
    if ok(rec) and isinstance(wq, dict):
        ri = wq.get("requestInfo") or {}
        out["withdrawal_queue"] = {"finalization_in_ms": ri.get("finalizationIn"),
                                   "finalization_at": ri.get("finalizationAt"), "type": ri.get("type"),
                                   "status": wq.get("status"), "next_calculation_at": wq.get("nextCalculationAt")}
    last, rec = http.get(LIDO_APR_LAST)
    reqs.append(rec)
    if ok(rec) and isinstance(last, dict):
        d = last.get("data") or {}
        out["steth_apr_last"] = {"time_unix": d.get("timeUnix"), "apr_pct": fnum(d.get("apr"))}
    sma, rec = http.get(LIDO_APR_SMA)
    reqs.append(rec)
    if ok(rec) and isinstance(sma, dict):
        d = sma.get("data") or {}
        out["steth_apr_sma"] = {"sma_apr_pct": fnum(d.get("smaApr")),
                                "aprs": [{"time_unix": a.get("timeUnix"), "apr_pct": fnum(a.get("apr"))}
                                         for a in d.get("aprs") or []]}
    pool, rec = http.get(CURVE_POOL_URL.format(pool=CURVE_STETH_POOL),
                         label=CURVE_POOL_URL.format(pool="<Curve.fi ETH/stETH pool>"))
    reqs.append(rec)
    if ok(rec) and isinstance(pool, dict):
        out["curve_steth_pool"] = {
            "name": pool.get("name"), "coins": [c.get("symbol") for c in pool.get("coins") or []],
            "balances": [fnum(b) for b in pool.get("balances") or []],
            "balances_usd": [fnum(b) for b in pool.get("balances_usd") or []],
            "tvl_usd": fnum(pool.get("tvl_usd")), "virtual_price": pool.get("virtual_price"),
            "amplification_coefficient": pool.get("amplification_coefficient"),
            "trading_volume_24h": fnum(pool.get("trading_volume_24h")),
            "base_daily_apr": fnum(pool.get("base_daily_apr")),
        }
    if all(v is None for v in out.values()):
        raise SourceFailed("all Lido/Curve parts failed", reqs)
    return out, reqs


# ---------------------------------------------------------------------------------------- Hyperliquid

def liq_bin(liq_px: float, spot: float) -> int:
    """Bin k holds liquidation prices in [spot*(1+k/100), spot*(1+(k+1)/100))."""
    return math.floor((liq_px / spot - 1.0) * 100.0 + 1e-9)


def select_accounts(rows: list, top_n: int) -> list:
    """Top N by account value U top N by 30d volume U top N by 1d volume (first-seen order)."""
    def av(r):
        return fnum(r.get("accountValue")) or 0.0

    def vol(r, w):
        for name, perf in r.get("windowPerformances") or []:
            if name == w:
                return fnum((perf or {}).get("vlm")) or 0.0
        return 0.0
    picks = []
    picks += [r.get("ethAddress") for r in sorted(rows, key=lambda r: -av(r))[:top_n]]
    picks += [r.get("ethAddress") for r in sorted(rows, key=lambda r: -vol(r, "month"))[:top_n]]
    picks += [r.get("ethAddress") for r in sorted(rows, key=lambda r: -vol(r, "day"))[:top_n]]
    return [a for a in dict.fromkeys(picks) if isinstance(a, str) and a]


def collect_hyperliquid(http: Http, rate: float = HL_RATE, workers: int = HL_WORKERS, top_n: int = HL_TOP_N,
                        sleep=time.sleep):
    reqs = []
    meta, rec = http.post(HL_INFO, {"type": "metaAndAssetCtxs"}, label=f"{HL_INFO} (POST type=metaAndAssetCtxs)")
    reqs.append(rec)
    if not ok(rec) or not isinstance(meta, list) or len(meta) < 2:
        raise SourceFailed(f"metaAndAssetCtxs: {rec['error']}", reqs)
    names = [u.get("name") for u in (meta[0] or {}).get("universe") or []]
    if HL_COIN not in names:
        raise SourceFailed(f"{HL_COIN} not in universe", reqs)
    ctx = meta[1][names.index(HL_COIN)]
    asset = {k: ctx.get(k) for k in ("markPx", "oraclePx", "midPx", "openInterest", "funding", "premium",
                                     "dayNtlVlm", "prevDayPx", "impactPxs")}
    mark = fnum(ctx.get("markPx"))
    oi = fnum(ctx.get("openInterest"))

    pf, rec = http.post(HL_INFO, {"type": "predictedFundings"}, label=f"{HL_INFO} (POST type=predictedFundings)")
    reqs.append(rec)
    predicted = None
    if ok(rec) and isinstance(pf, list):
        for item in pf:
            if isinstance(item, list) and item and item[0] == HL_COIN:
                predicted = {venue: v for venue, v in item[1]} if len(item) > 1 else None

    hist = None
    lb, rec = http.get(HL_LEADERBOARD)
    reqs.append(rec)
    rows = (lb or {}).get("leaderboardRows") if ok(rec) and isinstance(lb, dict) else None
    if isinstance(rows, list) and mark:
        accounts = select_accounts(rows, top_n)
        n_rows = len(rows)
        del lb, rows  # addresses live only in `accounts`, in memory, until the sweep ends
        hist = _hl_histogram(http, accounts, mark, oi, rate, workers, sleep, reqs)
        hist["leaderboard_rows"] = n_rows
        del accounts
    return {"coin": HL_COIN, "asset_ctx": asset, "predicted_fundings": predicted, "liq_histogram": hist}, reqs


def _hl_histogram(http, accounts, spot, oi, rate, workers, sleep, reqs):
    limiter = RateLimiter(rate, sleep=sleep)

    def state(a):
        limiter.wait()
        return http.post(HL_INFO, {"type": "clearinghouseState", "user": a},
                         label=f"{HL_INFO} (POST type=clearinghouseState, one account)")

    bins: dict[int, dict] = {}
    no_liq = {"long_ntl": 0.0, "long_n": 0, "short_ntl": 0.0, "short_n": 0}
    tot = {"long_sz": 0.0, "short_sz": 0.0, "positions": 0, "accounts_with_position": 0}
    recs = []
    with ThreadPoolExecutor(max(1, workers)) as ex:
        for data, rec in ex.map(state, accounts):
            recs.append(rec)
            if not ok(rec) or not isinstance(data, dict):
                continue
            had = False
            for ap in data.get("assetPositions") or []:
                p = (ap or {}).get("position") or {}
                if p.get("coin") != HL_COIN:
                    continue
                szi = fnum(p.get("szi"))
                if not szi:
                    continue
                had = True
                side = "long" if szi > 0 else "short"
                ntl = abs(szi) * spot
                tot[f"{side}_sz"] += abs(szi)
                tot["positions"] += 1
                liq = fnum(p.get("liquidationPx"))
                if liq is None or liq <= 0:
                    tgt = no_liq
                else:
                    tgt = bins.setdefault(liq_bin(liq, spot), {"long_ntl": 0.0, "long_n": 0,
                                                               "short_ntl": 0.0, "short_n": 0})
                tgt[f"{side}_ntl"] += ntl
                tgt[f"{side}_n"] += 1
            tot["accounts_with_position"] += int(had)
    reqs.append(sweep_summary(f"{HL_INFO} (POST type=clearinghouseState, selected accounts)", recs))
    n_ok = sum(1 for r in recs if ok(r))
    return {
        "spot_ref": spot, "notional_at": "spot_ref", "bin_pct": 1,
        "bin_rule": "k = floor((liquidationPx / spot_ref - 1) * 100); bin k covers [k%, k+1%) from spot_ref",
        "bins": {str(k): {kk: round(vv, 2) if isinstance(vv, float) else vv for kk, vv in bins[k].items()}
                 for k in sorted(bins)},
        "no_liquidation_px": {k: round(v, 2) if isinstance(v, float) else v for k, v in no_liq.items()},
        "selection": f"leaderboard top {HL_TOP_N} by accountValue U top {HL_TOP_N} by month vlm U top {HL_TOP_N} by day vlm",
        "accounts_queried": len(recs), "accounts_ok": n_ok, "accounts_failed": len(recs) - n_ok,
        "accounts_with_position": tot["accounts_with_position"], "positions": tot["positions"],
        "long_size": round(tot["long_sz"], 6), "short_size": round(tot["short_sz"], 6),
        "open_interest": oi,
        "coverage_long": round(tot["long_sz"] / oi, 6) if oi else None,
        "coverage_short": round(tot["short_sz"] / oi, 6) if oi else None,
    }


# ---------------------------------------------------------------------------------------------- Store

def slot_parts(slot: datetime):
    return f"{slot:%Y}", f"{slot:%m}", f"{slot:%d}", f"{slot:%H%M}"


def find_address(obj) -> str | None:
    m = ADDRESS_RE.search(json.dumps(obj, ensure_ascii=False))
    return m.group(0) if m else None


def encode_record(record: dict) -> bytes:
    return gzip.compress(json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(),
                         compresslevel=9, mtime=0)


def write_new(path: Path, blob: bytes) -> None:
    """Create path with blob; raises FileExistsError if it exists (never overwrite)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def append_manifest(root: Path, slot: datetime, line: dict) -> Path:
    y, m, d, _ = slot_parts(slot)
    p = root / "collectors" / "manifest" / y / m / f"{d}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(line, sort_keys=True, separators=(",", ":")) + "\n")
    return p


def store(root: Path, slot: datetime, source: str, started: str, finished: str, app_commit: str | None,
          data, reqs, error: str | None) -> dict:
    """Write one source's file (when it has data) and its manifest line. Returns the manifest line."""
    y, m, d, hm = slot_parts(slot)
    rel = Path("collectors") / source / y / m / d / f"{hm}.json.gz"
    line = {"source": source, "slot": slot.strftime("%Y-%m-%dT%H:%MZ"), "started_at": started,
            "finished_at": finished, "app_commit": app_commit, "path": None, "sha256": None, "bytes": None,
            "status": "failed" if error else "ok", "error": error,
            "http": [{"endpoint": r["endpoint"], "status": r.get("http_status", r.get("http_status_counts"))}
                     for r in reqs]}
    if find_address(line):  # endpoints are labels; this is a last guard
        line["http"], line["error"] = [], "manifest line held an address; dropped"
    if error is None:
        record = {"schema": SCHEMA, "source": source, "slot": line["slot"], "started_at": started,
                  "finished_at": finished, "app_commit": app_commit,
                  "prereg": "triccs/membrane-board design/Q26_COLLECTORS.md @14d01a8",
                  "requests": reqs, "data": data}
        if find_address(record):
            line.update(status="failed", error="record held an address; nothing written")
        else:
            blob = encode_record(record)
            try:
                write_new(root / rel, blob)
                line.update(path=rel.as_posix(), sha256=hashlib.sha256(blob).hexdigest(), bytes=len(blob))
            except FileExistsError:
                line.update(status="exists", error="file already exists; not rewritten")
    append_manifest(root, slot, line)
    return line


# ----------------------------------------------------------------------------------------------- Main

def run_source(name, http, opts) -> list[tuple[str, str, str, object, list, str | None]]:
    """Returns [(source, started, finished, data, reqs, error)]; never raises."""
    started = utc_iso()
    try:
        if name == "polymarket":
            res = collect_polymarket(http)
            fin = utc_iso()
            return [(src, started, fin, data, reqs, None) for src, (data, reqs) in res.items()]
        if name == "deribit":
            data, reqs = collect_deribit(http, **opts.get("deribit", {}))
        elif name == "lido":
            data, reqs = collect_lido(http)
        elif name == "hyperliquid":
            data, reqs = collect_hyperliquid(http, **opts.get("hyperliquid", {}))
        else:
            raise ValueError(f"unknown source {name}")
        return [(name, started, utc_iso(), data, reqs, None)]
    except SourceFailed as e:
        err, reqs = str(e), e.requests
    except Exception as e:  # noqa: BLE001 -- one source never takes down the others
        err, reqs = f"{type(e).__name__}: {str(e)[:200]}", []
    srcs = list(POLY_SOURCE.values()) if name == "polymarket" else [name]
    fin = utc_iso()
    return [(s, started, fin, None, reqs, err) for s in srcs]


def run(out: Path, sources: list[str], now: datetime | None = None, app_commit: str | None = None,
        http: Http | None = None, opts: dict | None = None, parallel: bool = True) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    slot = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    http = http or Http()
    opts = opts or {}
    if parallel and len(sources) > 1:
        with ThreadPoolExecutor(len(sources)) as ex:
            results = list(ex.map(lambda s: run_source(s, http, opts), sources))
    else:
        results = [run_source(s, http, opts) for s in sources]
    lines = []
    for res in results:
        for src, started, fin, data, reqs, err in res:
            lines.append(store(out, slot, src, started, fin, app_commit, data, reqs, err))
    return lines


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, type=Path, help="root that holds collectors/ (the datasets checkout)")
    ap.add_argument("--sources", default=",".join(ALL_SOURCES), help=f"comma list of {ALL_SOURCES}")
    ap.add_argument("--app-commit", default=None, help="membrane-app commit recorded in each file")
    a = ap.parse_args(argv)
    sources = [s.strip() for s in a.sources.split(",") if s.strip()]
    bad = [s for s in sources if s not in ALL_SOURCES]
    if bad:
        ap.error(f"unknown sources {bad}")
    lines = run(a.out, sources, app_commit=a.app_commit)
    for ln in lines:
        print(f"{ln['source']:16s} {ln['status']:7s} {ln['bytes'] or '-':>9} {ln['path'] or ln['error']}")
    return 0 if any(ln["status"] == "ok" for ln in lines) else 1


if __name__ == "__main__":
    sys.exit(main())
