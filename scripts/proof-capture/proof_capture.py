#!/usr/bin/env python3
"""Proof capture: when the market moves, freeze the evidence.

One hourly pass:
  1. DETECT  — read Binance 1m klines and run every detector in detectors.json (price_drop, depeg). A trigger opens an
               event, or joins an event already open within merge_window_hours (one cascade = one event, many triggers).
               A detector that fired in the last cooldown_hours does not open a new event.
  2. CAPTURE — for every open event, take each stage that is due (default +0h, +8h, +24h, +72h after the trigger).
               A stage covers [trigger - lookback_hours, now] and writes, under <out>/proofs/<event-id>/stage-<NN>h/:
                 prices.json.gz         Binance 1m klines for every kline_symbol
                 chainlink.json.gz      every Chainlink round in the window (ETH/USD, BTC/USD)
                 liquidations.json.gz   Aave V3 LiquidationCall + Morpho Blue Liquidate logs, decoded, with block times
                 venues.json            Aave V3 USDC/USDT supply, cash on hand and utilization at the stage block
                 receipt.json           the numbers below, machine-readable
               Files are created exclusively and never rewritten. A failed part writes no file and is listed in the
               stage's manifest; the stage still counts as taken (nothing is backfilled).
  3. RECEIPT — receipt.md per event, rewritten after each stage: the trigger, the price path and how much of the drop
               had come back at each stage, and what borrowers PAID: liquidation cost = value of collateral seized minus
               debt repaid (the liquidator premium plus any protocol share), priced at the Binance 1m close of the
               log's minute. Collateral the job cannot price (no Binance pair) is counted but not valued.
               The Membrane counterfactual is NOT computed here: run lib/position-sim against the stage files.
  4. ALERT   — optional Telegram message (aggregates only, never an address) when an event opens or a stage lands.

Standard library only. Keyless public endpoints only. Output to stdout is counts only (the Actions log is public).

  python scripts/proof-capture/proof_capture.py --out <membrane-datasets checkout> [--now TS] [--force LABEL] [--dry-run]
  python scripts/proof-capture/proof_capture.py --self-test
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import http.client
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "membrane-proof-capture/1"
BINANCE_KLINES = "https://data-api.binance.vision/api/v3/klines"
ETH_LOG_EPS = [("https://mainnet.gateway.tenderly.co", 50_000), ("https://rpc.mevblocker.io", 50_000),
               ("https://ethereum-rpc.publicnode.com", 2_000)]
ETH_CALL_EPS = ["https://ethereum-rpc.publicnode.com", "https://mainnet.gateway.tenderly.co", "https://eth.drpc.org",
                "https://rpc.mevblocker.io"]
SECONDS_PER_BLOCK = 12

# --------------------------------------------------------------------------------------------------------- keccak-256
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
       0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
       0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
       0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _f1600(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & _M) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                r = _ROT[x][y]
                b[y][(2 * x + 3 * y) % 5] = ((a[x][y] << r) | (a[x][y] >> (64 - r))) & _M if r else a[x][y]
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    msg += b"\x00" * ((-len(msg)) % rate)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        blk = msg[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            a[x][y] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        a = _f1600(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


def sig_hash(sig: str) -> str:
    return "0x" + keccak256(sig.encode()).hex()


# Every selector and topic is derived from its signature, and the derivation is pinned by --self-test against values
# that other repo code already uses (Aave LiquidationCall topic, getReserveData / balanceOf / decimals selectors).
SIGS = {
    "aave_liq": "LiquidationCall(address,address,address,uint256,uint256,address,bool)",
    "morpho_liq": "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
}
FNS = {
    "getReserveData": "getReserveData(address)", "balanceOf": "balanceOf(address)", "totalSupply": "totalSupply()",
    "decimals": "decimals()", "symbol": "symbol()", "latestRoundData": "latestRoundData()",
    "getRoundData": "getRoundData(uint80)", "idToMarketParams": "idToMarketParams(bytes32)",
}
TOPIC = {k: sig_hash(v) for k, v in SIGS.items()}
SEL = {k: sig_hash(v)[2:10] for k, v in FNS.items()}
PINNED = {  # values already used elsewhere in membrane-app (q26_live_d14.py, lib/curatorFeed/abi.ts)
    "topic:aave_liq": "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286",
    "topic:morpho_liq": "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41",
    "sel:getReserveData": "35ea6a75", "sel:balanceOf": "70a08231", "sel:decimals": "313ce567",
    "sel:symbol": "95d89b41",
}

# ------------------------------------------------------------------------------------------------------------ io utils


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(ts))


def dumps(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def write_exclusive(path, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return hashlib.sha256(data).hexdigest()


def write_atomic(path, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def http_get_json(url, timeout=30, tries=4):
    err = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"user-agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
            err = e
            time.sleep(min(2 ** k, 10))
    raise RuntimeError(f"GET failed: {type(err).__name__}")


# ------------------------------------------------------------------------------------------------------------ binance


def klines(symbol, start_ms, end_ms, get=http_get_json):
    """1m klines [open_ms, open, high, low, close, volume] in [start_ms, end_ms], paged 1000 at a time."""
    out = []
    t = start_ms
    while t <= end_ms:
        rows = get(f"{BINANCE_KLINES}?symbol={symbol}&interval=1m&startTime={t}&endTime={end_ms}&limit=1000")
        if not rows:
            break
        for r in rows:
            out.append([int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])])
        nxt = int(rows[-1][0]) + 60_000
        if nxt <= t:
            break
        t = nxt
    return out


# ---------------------------------------------------------------------------------------------------------- detectors


def detect_price_drop(rows, windows, recent_minutes=90):
    """Largest high->later-low drop whose low lies in the last `recent_minutes` and whose high lies at most
    `minutes` before it. Returns the first window that crosses its threshold, with the measured path."""
    if not rows:
        return None
    n = len(rows)
    first_recent = max(0, n - recent_minutes)
    best = None
    for w in windows:
        span = int(w["minutes"])
        for j in range(first_recent, n):
            lo = rows[j][3]
            i0 = max(0, j - span)
            hi_i = max(range(i0, j + 1), key=lambda i: rows[i][2])
            hi = rows[hi_i][2]
            drop = 1 - lo / hi if hi > 0 else 0.0
            if drop >= w["drop"] and (best is None or drop > best["drop"]):
                best = {"drop": round(drop, 5), "window_minutes": span, "threshold": w["drop"],
                        "peak": hi, "peak_ts": rows[hi_i][0] // 1000, "trough": lo, "trough_ts": rows[j][0] // 1000}
    return best


def detect_depeg(rows, below, recent_minutes=90):
    recent = rows[-recent_minutes:]
    if not recent:
        return None
    k = min(range(len(recent)), key=lambda i: recent[i][3])
    lo = recent[k][3]
    if lo <= below:
        return {"low": lo, "threshold": below, "trough_ts": recent[k][0] // 1000}
    return None


def run_detectors(cfg, now, get=http_get_json):
    fired = []
    for d in cfg["detectors"]:
        span = max([w["minutes"] for w in d.get("windows", [])] + [0]) + 90
        try:
            rows = klines(d["symbol"], (now - span * 60) * 1000, now * 1000, get=get)
        except RuntimeError:
            print(f"detector {d['id']} unavailable")
            continue
        if d["kind"] == "price_drop":
            hit = detect_price_drop(rows, d["windows"])
        elif d["kind"] == "depeg":
            hit = detect_depeg(rows, d["below"])
        else:
            raise ValueError(f"unknown detector kind {d['kind']}")
        print(f"detector {d['id']} {'FIRED' if hit else 'quiet'}")
        if hit:
            fired.append({"detector": d["id"], "kind": d["kind"], "symbol": d["symbol"], **hit})
    return fired


def open_or_merge(state, fired, now, cap):
    """Attach triggers to an open event inside the merge window, else open one event for all new triggers."""
    events = state.setdefault("events", {})
    recent = {}
    for ev in events.values():
        for t in ev["triggers"]:
            recent[t["detector"]] = max(recent.get(t["detector"], 0), t["detected_ts"])
    fresh = [dict(f, detected_ts=now) for f in fired if now - recent.get(f["detector"], 0) >= cap["cooldown_hours"] * 3600]
    if not fresh:
        return None
    for ev in events.values():
        if not ev.get("closed") and now - ev["trigger_ts"] <= cap["merge_window_hours"] * 3600:
            ev["triggers"].extend(fresh)
            return ev["id"]
    eid = time.strftime("%Y%m%dT%H%MZ", time.gmtime(now)) + "-" + "+".join(sorted(f["detector"] for f in fresh))
    events[eid] = {"id": eid, "trigger_ts": now, "triggers": fresh, "stages_done": [], "closed": False}
    return eid


# --------------------------------------------------------------------------------------------------------------- rpc


class Rpc:
    def __init__(self, post=None, tries=12):
        self.post = post or self._post
        self.tries = tries
        self.i = 0

    @staticmethod
    def _post(url, payload, timeout=45):
        req = urllib.request.Request(url, data=payload, headers={"content-type": "application/json", "user-agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    def _one(self, url, method, params):
        body = self.post(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode())
        if "error" in body:
            raise ValueError(str(body["error"].get("message", ""))[:100])
        return body["result"]

    def call(self, method, params):
        err = None
        for k in range(self.tries):
            self.i += 1
            url = ETH_CALL_EPS[self.i % len(ETH_CALL_EPS)]
            try:
                return self._one(url, method, params)
            except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError, KeyError) as e:
                err = e
                if isinstance(e, ValueError) and "revert" in str(e).lower():
                    raise
                time.sleep(min(1.5 * (k + 1), 8))
        raise RuntimeError(f"{method}: {type(err).__name__}")

    def eth_call(self, to, data_hex, block="latest"):
        return self.call("eth_call", [{"to": to, "data": data_hex}, block])

    def logs(self, address, topic0, lo, hi):
        out, b, ep, fails = [], lo, 0, 0
        span = ETH_LOG_EPS[0][1]
        while b <= hi:
            url, cap = ETH_LOG_EPS[ep % len(ETH_LOG_EPS)]
            s = min(span, cap)
            e = min(hi, b + s - 1)
            try:
                res = self._one(url, "eth_getLogs", [{"fromBlock": hex(b), "toBlock": hex(e), "address": address,
                                                      "topics": [topic0]}])
                out.extend(res)
                b, fails, span = e + 1, 0, min(span * 2, ETH_LOG_EPS[0][1])
            except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError, KeyError):
                fails += 1
                ep += 1
                span = max(100, s // 4)
                if fails > 24:
                    raise RuntimeError("eth_getLogs: endpoints exhausted")
                time.sleep(min(0.5 * 2 ** min(fails, 5), 10))
        out.sort(key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16)))
        return out

    def block(self, tag):
        b = self.call("eth_getBlockByNumber", [tag if isinstance(tag, str) else hex(tag), False])
        return int(b["number"], 16), int(b["timestamp"], 16)


def words(hexdata):
    raw = bytes.fromhex(hexdata[2:] if hexdata.startswith("0x") else hexdata)
    return [int.from_bytes(raw[i:i + 32], "big") for i in range(0, len(raw), 32)]


def addr_of(v):
    return "0x" + format(v & ((1 << 160) - 1), "040x")


def topic_addr(t):
    return "0x" + t[-40:].lower()


def decode_symbol(hexdata):
    raw = bytes.fromhex(hexdata[2:])
    if len(raw) >= 96:
        n = int.from_bytes(raw[32:64], "big")
        return raw[64:64 + n].decode(errors="replace")
    return raw.rstrip(b"\x00").decode(errors="replace")


def decode_aave_liq(log):
    w = words(log["data"])
    return {"protocol": "aave-v3", "block": int(log["blockNumber"], 16), "tx": log["transactionHash"],
            "log_index": int(log["logIndex"], 16), "collateral_asset": topic_addr(log["topics"][1]),
            "debt_asset": topic_addr(log["topics"][2]), "borrower": topic_addr(log["topics"][3]),
            "debt_repaid_raw": str(w[0]), "collateral_seized_raw": str(w[1]), "liquidator": addr_of(w[2]),
            "receive_atoken": bool(w[3])}


def decode_morpho_liq(log):
    w = words(log["data"])
    return {"protocol": "morpho-blue", "block": int(log["blockNumber"], 16), "tx": log["transactionHash"],
            "log_index": int(log["logIndex"], 16), "market_id": log["topics"][1].lower(),
            "liquidator": topic_addr(log["topics"][2]), "borrower": topic_addr(log["topics"][3]),
            "debt_repaid_raw": str(w[0]), "collateral_seized_raw": str(w[2]), "bad_debt_raw": str(w[3])}


# ----------------------------------------------------------------------------------------------------------- capture

BINANCE_PAIR = {  # token symbol -> Binance pair used to value it; stables are valued at 1
    "WETH": "ETHUSDT", "ETH": "ETHUSDT", "WBTC": "BTCUSDT", "cbBTC": "BTCUSDT", "tBTC": "BTCUSDT", "LBTC": "BTCUSDT",
    "LINK": "LINKUSDT", "AAVE": "AAVEUSDT", "UNI": "UNIUSDT", "USDe": "USDEUSDT",
}


def is_stable(sym):
    s = (sym or "").upper()
    return any(k in s for k in ("USD", "DAI", "GHO")) and not s.startswith("S") and "USDE" not in s


def capture_stage(rpc, cfg, ev, now, get=http_get_json):
    """Returns (files: name -> bytes, receipt, failures)."""
    cap = cfg["capture"]
    start = ev["trigger_ts"] - cap["lookback_hours"] * 3600
    files, fails = {}, []

    prices = {}
    for sym in cap["kline_symbols"]:
        try:
            prices[sym] = klines(sym, start * 1000, now * 1000, get=get)
        except RuntimeError:
            fails.append(f"klines:{sym}")
    files["prices.json.gz"] = gzip.compress(dumps({"source": BINANCE_KLINES, "interval": "1m",
                                                   "columns": ["open_ms", "open", "high", "low", "close", "volume"],
                                                   "series": prices}), mtime=0)

    head_block, head_ts = rpc.block("latest")
    lo_block = max(0, head_block - (head_ts - start) // SECONDS_PER_BLOCK - 300)

    rounds = {}
    for name, feed in cap["chainlink_feeds"].items():
        try:
            rounds[name] = chainlink_rounds(rpc, feed, start)
        except (RuntimeError, ValueError):
            fails.append(f"chainlink:{name}")
    files["chainlink.json.gz"] = gzip.compress(dumps({"rounds": rounds, "columns": ["round_id", "answer", "updated_at"]}),
                                               mtime=0)

    liqs, tokens, markets = [], {}, {}
    try:
        for lg in rpc.logs(cap["aave_pool"], TOPIC["aave_liq"], lo_block, head_block):
            liqs.append(decode_aave_liq(lg))
    except RuntimeError:
        fails.append("logs:aave")
    try:
        for lg in rpc.logs(cap["morpho_blue"], TOPIC["morpho_liq"], lo_block, head_block):
            d = decode_morpho_liq(lg)
            if d["market_id"] not in markets:
                w = words(rpc.eth_call(cap["morpho_blue"], "0x" + SEL["idToMarketParams"] + d["market_id"][2:]))
                markets[d["market_id"]] = {"loan": addr_of(w[0]), "collateral": addr_of(w[1]), "lltv": w[4] / 1e18}
            m = markets[d["market_id"]]
            d.update(debt_asset=m["loan"], collateral_asset=m["collateral"], lltv=m["lltv"])
            liqs.append(d)
    except RuntimeError:
        fails.append("logs:morpho")
    block_ts = block_times(rpc, sorted({x["block"] for x in liqs}), (head_block, head_ts))
    for x in liqs:
        x["ts"] = block_ts[x["block"]]
        for a in (x["collateral_asset"], x["debt_asset"]):
            if a not in tokens:
                tokens[a] = token_meta(rpc, a)
    files["liquidations.json.gz"] = gzip.compress(dumps({"window": [start, now], "blocks": [lo_block, head_block],
                                                         "tokens": tokens, "events": liqs}), mtime=0)

    venues = {}
    for sym, asset in cap["aave_venues"].items():
        try:
            rd = words(rpc.eth_call(cap["aave_pool"], "0x" + SEL["getReserveData"] + "00" * 12 + asset[2:]))
            atoken = addr_of(rd[8])
            dec = tokens.get(asset, {}).get("decimals") or token_meta(rpc, asset)["decimals"]
            cash = words(rpc.eth_call(asset, "0x" + SEL["balanceOf"] + "00" * 12 + atoken[2:]))[0] / 10 ** dec
            supply = words(rpc.eth_call(atoken, "0x" + SEL["totalSupply"]))[0] / 10 ** dec
            venues[f"aave-v3:{sym}"] = {"supply": supply, "cash": cash,
                                        "utilization": round(1 - cash / supply, 6) if supply else None}
        except (RuntimeError, ValueError, IndexError):
            fails.append(f"venue:{sym}")
    files["venues.json"] = dumps({"block": head_block, "ts": head_ts, "venues": venues})

    receipt = build_receipt(ev, prices, liqs, tokens, venues, now)
    files["receipt.json"] = dumps(receipt)
    return files, receipt, fails


def chainlink_rounds(rpc, feed, since_ts, cap=3000):
    w = words(rpc.eth_call(feed, "0x" + SEL["latestRoundData"]))
    rid = w[0]
    out = []
    while len(out) < cap:
        ans = w[1] - (1 << 256) if w[1] >= 1 << 255 else w[1]
        out.append([str(w[0]), str(ans), w[3]])
        if w[3] < since_ts or (rid & ((1 << 64) - 1)) <= 1:
            break
        rid -= 1
        try:
            w = words(rpc.eth_call(feed, "0x" + SEL["getRoundData"] + rid.to_bytes(32, "big").hex()))
        except ValueError:      # a phase boundary reverts: stop there, the earlier phase is out of scope
            break
    out.reverse()
    return out


def block_times(rpc, blocks, head, exact_cap=400):
    hb, hts = head
    out = {}
    for i, b in enumerate(blocks):
        if i < exact_cap:
            try:
                out[b] = rpc.block(b)[1]
                continue
            except RuntimeError:
                pass
        out[b] = hts - (hb - b) * SECONDS_PER_BLOCK   # estimated: post-merge slot time, missed slots ignored
    return out


def token_meta(rpc, asset):
    meta = {"decimals": 18, "symbol": "?"}
    try:
        meta["decimals"] = words(rpc.eth_call(asset, "0x" + SEL["decimals"]))[0]
    except (RuntimeError, ValueError, IndexError):
        pass
    try:
        meta["symbol"] = decode_symbol(rpc.eth_call(asset, "0x" + SEL["symbol"]))
    except (RuntimeError, ValueError, IndexError):
        pass
    return meta


# ----------------------------------------------------------------------------------------------------------- receipt


def price_at(series, ts):
    """Close of the 1m candle containing ts (None if outside the series)."""
    if not series:
        return None
    m = (ts // 60) * 60_000
    lo, hi = 0, len(series) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] < m:
            lo = mid + 1
        elif series[mid][0] > m:
            hi = mid - 1
        else:
            return series[mid][4]
    return None


def usd_value(raw, meta, ts, prices):
    sym = meta.get("symbol", "?")
    amt = int(raw) / 10 ** meta.get("decimals", 18)
    if is_stable(sym):
        return amt
    pair = BINANCE_PAIR.get(sym)
    p = price_at(prices.get(pair), ts) if pair else None
    return amt * p if p else None


def build_receipt(ev, prices, liqs, tokens, venues, now):
    path = {}
    for t in ev["triggers"]:
        if t["kind"] != "price_drop":
            continue
        s = prices.get(t["symbol"]) or []
        last = s[-1][4] if s else None
        drop = t["peak"] - t["trough"]
        path[t["symbol"]] = {"peak": t["peak"], "trough": t["trough"], "drop": t["drop"], "now": last,
                             "retraced": round((last - t["trough"]) / drop, 4) if last and drop > 0 else None}
    by = {}
    per_borrower = {}
    for x in liqs:
        p = by.setdefault(x["protocol"], {"count": 0, "borrowers": set(), "debt_repaid_usd": 0.0,
                                          "collateral_seized_usd": 0.0, "cost_usd": 0.0, "unpriced": 0,
                                          "bad_debt_events": 0})
        p["count"] += 1
        p["borrowers"].add(x["borrower"])
        if int(x.get("bad_debt_raw", "0")) > 0:
            p["bad_debt_events"] += 1
        debt = usd_value(x["debt_repaid_raw"], tokens.get(x["debt_asset"], {}), x["ts"], prices)
        coll = usd_value(x["collateral_seized_raw"], tokens.get(x["collateral_asset"], {}), x["ts"], prices)
        if debt is None or coll is None:
            p["unpriced"] += 1
            continue
        cost = coll - debt
        p["debt_repaid_usd"] += debt
        p["collateral_seized_usd"] += coll
        p["cost_usd"] += cost
        k = (x["protocol"], x["borrower"])
        per_borrower[k] = per_borrower.get(k, 0.0) + cost
    for name, p in by.items():
        costs = sorted((v for (pr, _), v in per_borrower.items() if pr == name), reverse=True)
        p["borrowers"] = len(p["borrowers"])
        p["cost_pct_of_repaid"] = round(p["cost_usd"] / p["debt_repaid_usd"], 5) if p["debt_repaid_usd"] else None
        p["cost_per_borrower_median"] = round(statistics.median(costs), 2) if costs else None
        p["cost_per_borrower_p90"] = round(costs[max(0, int(len(costs) * 0.1) - 1)], 2) if costs else None
        p["top10_share_of_cost"] = round(sum(costs[:10]) / sum(costs), 4) if costs and sum(costs) > 0 else None
        for f in ("debt_repaid_usd", "collateral_seized_usd", "cost_usd"):
            p[f] = round(p[f], 2)
    return {"event": ev["id"], "taken_at": now, "triggers": ev["triggers"], "price_path": path,
            "liquidations": by, "venues": venues,
            "notes": ["cost = collateral seized minus debt repaid, both at the Binance 1m close of the log's minute",
                      "unpriced = a leg with no Binance pair (e.g. wstETH, LSTs, PTs); counted, not valued",
                      "Membrane counterfactual not computed here; run lib/position-sim on the stage files"]}


def receipt_md(ev, stages):
    L = [f"# Proof capture — {ev['id']}", "",
         f"Trigger: {iso(ev['trigger_ts'])}. Stages taken: {', '.join(f'+{h}h' for h in ev['stages_done']) or 'none'}.", ""]
    for t in ev["triggers"]:
        if t["kind"] == "price_drop":
            L.append(f"- **{t['detector']}**: {t['symbol']} fell {t['drop']:.1%} in ≤{t['window_minutes']} min "
                     f"({t['peak']:,.2f} → {t['trough']:,.2f}); threshold {t['threshold']:.0%}.")
        elif t["kind"] == "depeg":
            L.append(f"- **{t['detector']}**: {t['symbol']} traded at {t['low']:.4f}; threshold {t['threshold']}.")
        else:
            L.append(f"- **{t['detector']}**: manual capture ({t.get('label', '')}).")
    L += ["", "## By stage", "", "| Stage | Retraced | Protocol | Liquidations | Borrowers | Debt repaid | Borrower cost | Cost % | Median / p90 per borrower | Top-10 share | Unpriced |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]
    for h, r in stages:
        ret = ", ".join(f"{k} {v['retraced']:.0%}" for k, v in r["price_path"].items() if v.get("retraced") is not None) or "—"
        if not r["liquidations"]:
            L.append(f"| +{h}h | {ret} | — | 0 | | | | | | | |")
        for name, p in sorted(r["liquidations"].items()):
            pct = f"{p['cost_pct_of_repaid']:.2%}" if p["cost_pct_of_repaid"] is not None else "—"
            med = p["cost_per_borrower_median"]
            p90 = p["cost_per_borrower_p90"]
            share = f"{p['top10_share_of_cost']:.0%}" if p["top10_share_of_cost"] is not None else "—"
            L.append(f"| +{h}h | {ret} | {name} | {p['count']} | {p['borrowers']} | ${p['debt_repaid_usd']:,.0f} | "
                     f"${p['cost_usd']:,.0f} | {pct} | ${med or 0:,.0f} / ${p90 or 0:,.0f} | {share} | {p['unpriced']} |")
    if stages:
        v = stages[-1][1]["venues"]
        if v:
            L += ["", "## Venue cash at the latest stage", ""]
            for k, x in v.items():
                u = f"{x['utilization']:.1%}" if x.get("utilization") is not None else "—"
                L.append(f"- {k}: utilization {u}, cash ${x['cash']:,.0f} of ${x['supply']:,.0f}")
    L += ["", "## Notes", "", "- Borrower cost = collateral seized minus debt repaid at the 1m close: the liquidator premium "
          "(plus any protocol share). It is the market price of a liquidation, which Membrane also pays (caller fee + "
          "queue premium); the difference is how much is sold and when, not a zero fee.",
          "- Retraced = share of the trigger's drop that had come back by the stage.",
          "- Membrane counterfactual: not computed by this job. Run `lib/position-sim` on the stage files.", ""]
    return "\n".join(L)


# -------------------------------------------------------------------------------------------------------------- alert


def alert(text):
    tok, chat = os.environ.get("PROOF_TELEGRAM_BOT_TOKEN"), os.environ.get("PROOF_TELEGRAM_CHAT_ID")
    if not tok or not chat:
        return "alert skipped (no Telegram secrets)"
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_web_page_preview": "true"}).encode()
    try:
        urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=data),
                               timeout=20).read()
        return "alert sent"
    except (urllib.error.URLError, OSError):
        return "alert failed"


def trigger_short(t):
    if t["kind"] == "price_drop":
        return f"{t['symbol']} -{t['drop']:.1%}"
    if t["kind"] == "depeg":
        return f"{t['symbol']} {t['low']:.4f}"
    return f"manual: {t.get('label', '')}"


def alert_text(ev, hours, receipt):
    trig = "; ".join(trigger_short(t) for t in ev["triggers"])
    parts = [f"Proof capture {ev['id']} stage +{hours}h. Trigger: {trig}."]
    for name, p in sorted(receipt["liquidations"].items()):
        parts.append(f"{name}: {p['count']} liqs, {p['borrowers']} borrowers, ${p['debt_repaid_usd']:,.0f} repaid, "
                     f"borrowers paid ${p['cost_usd']:,.0f}.")
    return " ".join(parts)


# --------------------------------------------------------------------------------------------------------------- main


def run(out, now, force=None, dry=False, get=http_get_json, rpc=None):
    cfg = json.load(open(os.path.join(HERE, "detectors.json")))
    cap = cfg["capture"]
    root = os.path.join(out, "proofs")
    state_path = os.path.join(root, "state.json")
    state = read_json(state_path, {"events": {}})

    fired = run_detectors(cfg, now, get=get)
    if force:
        fired.append({"detector": f"manual-{force}", "kind": "manual", "symbol": "-", "label": force})
    eid = open_or_merge(state, fired, now, cap)
    if eid:
        print(f"event open: {eid}")
    rpc = rpc or Rpc()
    taken = 0
    for ev in state["events"].values():
        if ev.get("closed"):
            continue
        due = [h for h in cap["stages_hours"] if h not in ev["stages_done"] and now >= ev["trigger_ts"] + h * 3600]
        if not due:
            continue
        h = max(due)           # a late run takes the latest due stage once; skipped stages are recorded as missed
        if dry:
            print(f"dry-run: would take stage +{h}h of {ev['id']}")
            continue
        sdir = os.path.join(root, ev["id"], f"stage-{h:02d}h")
        files, receipt, fails = capture_stage(rpc, cfg, ev, now, get=get)
        manifest = {"taken_at": now, "stage_hours": h, "failed": fails, "files": {}}
        for name, data in files.items():
            manifest["files"][name] = write_exclusive(os.path.join(sdir, name), data)
        write_exclusive(os.path.join(sdir, "manifest.json"), dumps(manifest))
        ev["stages_done"].extend(due)
        ev.setdefault("missed", []).extend(x for x in due if x != h)
        ev["closed"] = all(x in ev["stages_done"] for x in cap["stages_hours"])
        stages = []
        for x in sorted(ev["stages_done"]):
            r = read_json(os.path.join(root, ev["id"], f"stage-{x:02d}h", "receipt.json"))
            if r:
                stages.append((x, r))
        write_atomic(os.path.join(root, ev["id"], "receipt.md"), receipt_md(ev, stages).encode())
        write_atomic(os.path.join(root, ev["id"], "PROVENANCE.md"), provenance(ev).encode())
        taken += 1
        print(f"stage +{h}h taken: {len(files)} files, {len(fails)} failed parts, "
              f"{sum(p['count'] for p in receipt['liquidations'].values())} liquidations")
        print(alert(alert_text(ev, h, receipt)))
    if not dry:
        write_atomic(state_path, json.dumps(state, indent=1, sort_keys=True).encode())
    print(f"done: {taken} stage(s) taken, {sum(1 for e in state['events'].values() if not e.get('closed'))} open event(s)")
    return state


def provenance(ev):
    return "\n".join([
        f"# {ev['id']}", "",
        "- Builder: membrane-app `scripts/proof-capture/proof_capture.py` via `.github/workflows/proof-capture.yml`; "
        "the app commit is in each stage's commit message.",
        "- Sources: Binance public klines (data-api.binance.vision), Chainlink aggregators and Aave V3 / Morpho Blue "
        "logs over keyless public Ethereum RPC.",
        f"- Trigger: {iso(ev['trigger_ts'])}; stages taken: {sorted(ev['stages_done'])}; missed: {ev.get('missed', [])}.",
        "- Each stage's `manifest.json` lists the sha256 of every file and any part that failed. Files are never rewritten.",
        "- Borrower addresses are stored here (private repo) for position-level replay; alerts and logs carry aggregates only.", ""])


def self_test():
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    got = {**{f"topic:{k}": v for k, v in TOPIC.items()}, **{f"sel:{k}": v for k, v in SEL.items()}}
    for k, v in PINNED.items():
        assert got[k] == v, (k, got[k], v)
    print("self-test ok:", ", ".join(f"{k}={v}" for k, v in sorted(SEL.items())))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="membrane-datasets checkout")
    ap.add_argument("--now", type=int, default=None)
    ap.add_argument("--force", help="open a manual event with this label (workflow_dispatch test)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    self_test()
    if a.self_test:
        return 0
    if not a.out:
        ap.error("--out is required")
    run(a.out, a.now or int(time.time()), force=a.force, dry=a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
