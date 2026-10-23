"""Q26 B23 listing-only reserve: Korean venue-unique Upbit/Bithumb pool (Claude, O184 lane, 2026-10-23).

membrane-board design/q26-blind-set-inventory-2026-10-17.md section 25 (B23) and design/Q26_ROUND16_PREREG.md
D-R16.2e-review (candidate pool). LISTING DATA ONLY. Rules fixed here before the first call of this script:
  candidates  AHT, MOC, OBSR, BIOT, MEV, MVC, TEMCO, AZIT, FANC (named by the review); VAL only if liquid enough
  listing     Upbit api.upbit.com/v1/market/all and Bithumb api.bithumb.com/v1/market/all (keyless), today's lists
  venue-unique  the base is on no Binance spot list (R12.5 rule), in no KuCoin USDT folder, not a B12 kept asset, not in
              B14a/B14b, B15, B17, B18, B19a/B19b, B20a/B20b, B21a/B21b, B22 or B9, not listed on Coinbase Exchange or
              Kraken (P5a/P5b), not a key of the R12/R16.2 development pool, not excluded (R12.5 list), and
              currently listed on Upbit or Bithumb
  series      one market per base: KRW quote first; then the earliest first monthly candle; then Upbit before Bithumb
  first date  open time of the earliest monthly candle (candles/months, count 200); prices, volumes discarded in code.
              Hourly depth: whether an hourly candle exists at 2023-01-01 and 2024-01-01 (count 1; only the
              timestamp is kept)
  VAL         included iff its current 24 h turnover in KRW (sum over its Upbit/Bithumb markets; BTC markets converted
              at the current KRW-BTC price, a seen asset) is at least the smallest such turnover of the 9 named bases.
              Only acc_trade_price_24h is kept from the ticker; the current 24 h lies outside any blind window
  split       sha256("Q26-R16.2e-B23:" + base) first byte even -> B23a (confirm), odd -> B23b (reserve)
No address, key or secret. No historical price, outcome, count, forecast or score is read or kept.

  python3 r162e_b23.py select --datasets DS --rows ROWS --out OUT
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r125_fh_deep as R125  # noqa: E402
import r13_recal as R13  # noqa: E402
import r14_dr as D14  # noqa: E402
import r165_h2h as H  # noqa: E402

NAMED = ("AHT", "MOC", "OBSR", "BIOT", "MEV", "MVC", "TEMCO", "AZIT", "FANC")
COND = ("VAL",)
UP_LIST = "https://api.upbit.com/v1/market/all?isDetails=true"
BT_LIST = "https://api.bithumb.com/v1/market/all?isDetails=true"
HOST = {"upbit": "https://api.upbit.com/v1", "bithumb": "https://api.bithumb.com/v1"}
SALT = "Q26-R16.2e-B23:"
PROBES = ("2023-01-01T00:00:00Z", "2024-01-01T00:00:00Z")


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_json(url):
    time.sleep(0.25)
    return json.loads(R125.http_get(url))


def first_month(ven, market):
    d = get_json(f"{HOST[ven]}/candles/months?market={market}&count=200")
    ts = [x["candle_date_time_utc"] for x in d] if isinstance(d, list) else []
    del d                                                    # prices and volumes discarded
    return (min(ts)[:10], len(ts)) if ts else (None, 0)


def hourly_exists(ven, market, at):
    d = get_json(f"{HOST[ven]}/candles/minutes/60?market={market}&count=1&to={at}")
    t = d[0]["candle_date_time_utc"] if isinstance(d, list) and d else None
    del d
    return t                                                 # the last hourly candle before `at` (timestamp only)


def turnover_krw(ven, markets, krw_btc):
    d = get_json(f"{HOST[ven]}/ticker?markets={','.join(markets)}")
    out = {}
    for x in d:
        q = x["market"].split("-")[0]
        v = float(x["acc_trade_price_24h"])
        out[x["market"]] = v if q == "KRW" else (v * krw_btc if q == "BTC" else None)
    del d
    return out


def cmd_select(a):
    t_start = now()
    raw_up, raw_bt = R125.http_get(UP_LIST), R125.http_get(BT_LIST)
    up, bt = json.loads(raw_up), json.loads(raw_bt)
    mk = {}
    for ven, lst in (("upbit", up), ("bithumb", bt)):
        for m in lst:
            q, b = m["market"].split("-")
            mk.setdefault(b.upper(), []).append((ven, m["market"], q))
    # used lists (as select-b22, plus B22 itself and the development pool)
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = D14.other_used(a.datasets)
    sel = lambda p: json.load(open(os.path.join(a.datasets, p)))  # noqa: E731
    b18 = set(sel("b18-poloniex-prices/selection-b18.json")["B18"])
    s19 = sel("b19-lbank-prices/selection-b19.json")
    b19 = set(s19["B19a"]) | set(s19["B19b"])
    s20 = sel("b20-xt-bingx-prices/selection-b20.json")
    b20 = set(s20["B20a"]) | set(s20["B20b"])
    s21 = sel("b21-hitbtc-prices/selection-b21.json")
    b21 = set(s21["B21a"]) | set(s21["B21b"])
    b22 = set(sel("b22-reserve-prices/selection-b22.json")["B22"])
    rcb = R125.http_get(H.CB_PRODUCTS)
    cb = {str(p["base_currency"]).upper() for p in json.loads(rcb)}
    rkr = R125.http_get(H.KR_PAIRS)
    kr = set()
    for v in json.loads(rkr)["result"].values():
        ws = str(v.get("wsname") or "")
        if "/" in ws:
            kr.add(ws.split("/")[0].upper())
    p5 = cb | kr | {"XBT", "XDG"}
    bn = set(R125.binance_symbols())
    keys = json.load(open(os.path.join(a.rows, "rows-meta.json")))["series"]
    dev = set()
    for k in keys:
        s_ = k.split(":")[-1].replace("KRAKEN-", "").upper()
        s_ = re.sub(r"[-_/]?(USDT|USDC|USD|BUSD|EUR|BTC)$", "", s_)
        dev.add(s_)
    rec = {"candidates": list(NAMED + COND), "checks": {}, "venue_unique": [], "dropped": {}}
    for b in NAMED + COND:
        checks = {"listed_upbit_or_bithumb": b in mk, "on_binance": R125.on_binance(b, bn), "on_kucoin": b in kc,
                  "in_b12": b in b12, "in_b14": b in b14, "in_b15": b in b15, "in_b17": b in b17, "in_b18": b in b18,
                  "in_b19": b in b19, "in_b20": b in b20, "in_b21": b in b21, "in_b22": b in b22, "in_b9": b in b9,
                  "on_p5_venue": b in p5, "in_dev_pool": b in dev, "excluded_r125": R125.excluded(b)}
        rec["checks"][b] = checks
        bad = [n for n, v in checks.items() if (n != "listed_upbit_or_bithumb" and v) or
               (n == "listed_upbit_or_bithumb" and not v)]
        if bad:
            rec["dropped"][b] = bad
        else:
            rec["venue_unique"].append(b)
    # markets, first monthly candle, hourly depth
    info = {}
    for b in rec["venue_unique"]:
        ms = []
        for ven, market, q in mk[b]:
            if q not in ("KRW", "BTC"):
                ms.append({"venue": ven, "market": market, "quote": q, "first_month": None, "months": None,
                           "note": "quote not KRW/BTC; not considered"})
                continue
            fm, n = first_month(ven, market)
            ms.append({"venue": ven, "market": market, "quote": q, "first_month": fm, "months": n})
        cand = [m for m in ms if m["first_month"]]
        cand.sort(key=lambda m: (m["quote"] != "KRW", m["first_month"], m["venue"] != "upbit"))
        ch = cand[0] if cand else None
        if ch:
            ch["hourly_last_before"] = {p: hourly_exists(ch["venue"], ch["market"], p) for p in PROBES}
        info[b] = {"markets": ms, "series": ch}
    # VAL liquidity rule (current 24 h turnover only)
    krw_btc = None
    d = get_json(f"{HOST['upbit']}/ticker?markets=KRW-BTC")
    krw_btc = float(d[0]["trade_price"])
    del d
    turn = {}
    for b in rec["venue_unique"]:
        tot = 0.0
        for ven in ("upbit", "bithumb"):
            mm = [m["market"] for m in info[b]["markets"] if m["venue"] == ven and m["quote"] in ("KRW", "BTC")]
            if mm:
                for v in turnover_krw(ven, mm, krw_btc).values():
                    tot += v or 0.0
        turn[b] = tot
    named_ok = [b for b in rec["venue_unique"] if b in NAMED]
    floor = min(turn[b] for b in named_ok) if named_ok else None
    members = list(named_ok)
    for b in COND:
        if b in rec["venue_unique"]:
            ok = floor is not None and turn[b] >= floor
            rec.setdefault("conditional", {})[b] = {"turnover_krw_24h": turn[b], "floor_krw_24h": floor, "included": ok}
            if ok:
                members.append(b)
    members = [b for b in members if info[b]["series"] is not None]
    split = {b: ("B23a" if int(hashlib.sha256((SALT + b).encode()).hexdigest()[:2], 16) % 2 == 0 else "B23b")
             for b in members}
    out = {"schema": "q26-b23-selection-v1", "created_utc": now(), "started_utc": t_start,
           "code_sha": H.R112.git_sha(), "label": "LISTING DATA ONLY: no historical price, outcome or count read",
           "inventory": "membrane-board design/q26-blind-set-inventory-2026-10-17.md section 25",
           "upbit_market_all_sha256": hashlib.sha256(raw_up).hexdigest(), "upbit_markets": len(up),
           "bithumb_market_all_sha256": hashlib.sha256(raw_bt).hexdigest(), "bithumb_markets": len(bt),
           "coinbase_products_sha256": hashlib.sha256(rcb).hexdigest(), "kraken_pairs_sha256": hashlib.sha256(rkr).hexdigest(),
           "binance_spot_symbols": len(bn), "kucoin_usdt_dirs": len(kc), "dev_pool_series": len(keys),
           "sizes": {"b12": len(b12), "b14": len(b14), "b15": len(b15), "b17": len(b17), "b18": len(b18),
                     "b19": len(b19), "b20": len(b20), "b21": len(b21), "b22": len(b22), "b9": len(b9), "p5": len(p5)},
           **rec, "turnover_krw_24h_current": turn, "krw_btc_current": krw_btc, "info": info,
           "B23": sorted(members), "split": split,
           "B23a": sorted(b for b, s in split.items() if s == "B23a"),
           "B23b": sorted(b for b, s in split.items() if s == "B23b")}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b23.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("B23", "B23a", "B23b", "dropped")}, indent=1))
    print({b: (info[b]["series"] or {}).get("market") for b in members})
    print({b: (info[b]["series"] or {}).get("first_month") for b in members})
    print("written", p, hashlib.sha256(open(p, "rb").read()).hexdigest())


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select")
    s.add_argument("--datasets", required=True)
    s.add_argument("--rows", required=True)
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"select": cmd_select}[a.cmd](a)


if __name__ == "__main__":
    main()
