"""Q26 R16.2e strict GRU blind step: set listing check (Claude, O184 lane). membrane-board design/Q26_ROUND16_PREREG.md
D-R16.2e-a/b. LISTING DATA ONLY in this file: no candle, price, count, forecast or score is requested.

  list-p5   P5a/P5b listing per the R16.1 rule (inventory section 21): Coinbase Exchange and Kraken USD or USDT pairs
            whose base is on no used venue list (R12.5 Binance rule, KuCoin USDT folders, every B-set selection
            B9, B12, B14, B15, B17, B18, B19, B20, B21, B22), not excluded (R12.5 list), alphanumeric; venue precedence
            Coinbase, then Kraken; split sha256('Q26-R16.1-P5:' + base) first byte even (P5a) / odd (P5b).
            The first-hourly-candle rule (before 2024-01-01) needs candle metadata and is NOT applied here, so the
            listed counts are UPPER bounds on the set sizes.

  first-p5  P5a only (P5b untouched): the time of the first trade or daily candle of each listed pair, to apply the
            first-hourly-candle rule as a bound. Coinbase: daily candles in 300-day windows from 2015-01-01 until the
            first non-empty window (timestamps kept, OHLC discarded in code). Kraken: public Trades since=0 (first
            trade time kept, price and volume discarded). Kraken public OHLC serves only the last 720 bars, so a
            Kraken pair has no hourly history before 2024 from this source (as BingX in B20a).

  python3 r162e_blind.py list-p5  --datasets DS --out OUT
  python3 r162e_blind.py first-p5 --out OUT
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r125_fh_deep as R125  # noqa: E402
import r13_recal as R13  # noqa: E402
import r14_dr as R14  # noqa: E402

CB_PRODUCTS = "https://api.exchange.coinbase.com/products"
KR_PAIRS = "https://api.kraken.com/0/public/AssetPairs"
KR_ALIAS = {"XBT": "BTC", "XDG": "DOGE"}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cmd_list_p5(a):
    ds = a.datasets
    sel = lambda p: json.load(open(os.path.join(ds, p)))  # noqa: E731
    b12, kc, b14 = R13.used_lists(ds)
    b15, b17, b9 = R14.other_used(ds)
    b18 = set(sel("b18-poloniex-prices/selection-b18.json")["B18"])
    s19 = sel("b19-lbank-prices/selection-b19.json")
    b19 = set(s19["B19a"]) | set(s19["B19b"])
    s20 = sel("b20-xt-bingx-prices/selection-b20.json")
    b20 = set(s20["B20a"]) | set(s20["B20b"])
    s21 = sel("b21-hitbtc-prices/selection-b21.json")
    b21 = set(s21["B21a"]) | set(s21["B21b"])
    b22 = set(sel("b22-reserve-prices/selection-b22.json")["B22"])
    bn = set(R125.binance_symbols())
    rcb = R125.http_get(CB_PRODUCTS)
    rkr = R125.http_get(KR_PAIRS)
    items = []
    for p in sorted(json.loads(rcb), key=lambda x: x["id"]):
        if str(p.get("quote_currency")).upper() in ("USD", "USDT"):
            items.append(("coinbase", str(p["base_currency"]).upper(), p["id"],
                          p.get("status") == "online" and not p.get("trading_disabled", False)))
    for k, v in sorted(json.loads(rkr)["result"].items()):
        ws = str(v.get("wsname") or "")
        if "/" in ws and ws.split("/")[1].upper() in ("USD", "USDT"):
            b = ws.split("/")[0].upper()
            items.append(("kraken", KR_ALIAS.get(b, b), k, v.get("status", "online") == "online"))
    rec = {"coinbase_usd_usdt_pairs": sum(1 for i in items if i[0] == "coinbase"),
           "kraken_usd_usdt_pairs": sum(1 for i in items if i[0] == "kraken"),
           "not_online": [], "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [], "in_b15": [], "in_b17": [],
           "in_b18": [], "in_b19": [], "in_b20": [], "in_b21": [], "in_b22": [], "in_b9": [], "excluded": {},
           "kept": {}}
    for ven, base, pid, online in items:
        if base in rec["kept"]:
            continue
        checks = (("not_online", not online), ("on_binance", R125.on_binance(base, bn)), ("on_kucoin", base in kc),
                  ("in_b12", base in b12), ("in_b14", base in b14), ("in_b15", base in b15), ("in_b17", base in b17),
                  ("in_b18", base in b18), ("in_b19", base in b19), ("in_b20", base in b20), ("in_b21", base in b21),
                  ("in_b22", base in b22), ("in_b9", base in b9))
        hit = next((nm for nm, c in checks if c), None)
        if hit:
            if base not in rec[hit]:
                rec[hit].append(base)
        elif not re.fullmatch(r"[A-Z0-9]+", base):
            rec["excluded"][base] = "non-alphanumeric ticker"
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        else:
            rec["kept"][base] = {"venue": ven, "pair": pid}
    p5a = sorted(b for b in rec["kept"] if hashlib.sha256(("Q26-R16.1-P5:" + b).encode()).digest()[0] % 2 == 0)
    p5b = sorted(b for b in rec["kept"] if b not in p5a)
    out = {"schema": "q26-r162e-p5-listing-v1", "created_utc": now_iso(), "code_sha": R125.git_sha() if hasattr(R125, "git_sha") else None,
           "prereg": "membrane-board design/Q26_ROUND16_PREREG.md D-R16.2e-b; inventory section 21 (P5 rule)",
           "note": "listing data only; first-hourly-candle rule not applied, so counts are upper bounds",
           "P5a_upper": p5a, "P5b_upper": p5b, "record": rec}
    os.makedirs(a.out, exist_ok=True)
    json.dump(out, open(os.path.join(a.out, "listing-p5.json"), "w"), indent=1, sort_keys=True)
    print("kept", len(rec["kept"]), "P5a", len(p5a), "P5b", len(p5b),
          {k: len(v) for k, v in rec.items() if isinstance(v, (list, dict))})


def first_coinbase(pid):
    import time
    t = int(datetime(2015, 1, 1, tzinfo=timezone.utc).timestamp())
    end = int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp())
    while t < end:
        t2 = min(t + 299 * 86400, end)
        u = (f"https://api.exchange.coinbase.com/products/{pid}/candles?granularity=86400"
             f"&start={datetime.fromtimestamp(t, timezone.utc).isoformat()}&end={datetime.fromtimestamp(t2, timezone.utc).isoformat()}")
        x = json.loads(R125.http_get(u))
        time.sleep(0.4)
        if isinstance(x, list) and x:
            return int(min(r[0] for r in x))          # candle open times only; OHLC discarded here
        t = t2
    return None


def first_kraken(pid):
    import time
    x = json.loads(R125.http_get(f"https://api.kraken.com/0/public/Trades?pair={pid}&since=0&count=1"))
    time.sleep(1.2)
    res = x.get("result", {})
    for k, v in res.items():
        if k != "last" and isinstance(v, list) and v:
            return int(float(v[0][2]))                # trade time only; price and volume discarded here
    return None


def cmd_first_p5(a):
    L = json.load(open(os.path.join(a.out, "listing-p5.json")))
    out = {}
    for b in L["P5a_upper"]:
        k = L["record"]["kept"][b]
        t0 = first_coinbase(k["pair"]) if k["venue"] == "coinbase" else first_kraken(k["pair"])
        out[b] = {"venue": k["venue"], "pair": k["pair"], "first_ts": t0,
                  "first_utc": datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%d") if t0 else None}
        print(b, out[b], flush=True)
    json.dump({"schema": "q26-r162e-p5a-first-v1", "created_utc": now_iso(), "P5a": out,
               "note": "first trade or daily candle time only; no price, volume or outcome kept"},
              open(os.path.join(a.out, "first-p5a.json"), "w"), indent=1, sort_keys=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("list-p5")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("first-p5")
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"list-p5": cmd_list_p5, "first-p5": cmd_first_p5}[a.cmd](a)


if __name__ == "__main__":
    main()
