"""Q26 Round 14: R14.1 dense-threshold distribution-regression (DR) correction of (fH) for the deep band.

membrane-board design/Q26_ROUND14_PREREG.md (R14.1, D-R14.1a ...), design/q26-ml-levers-deepen-2026-10-18.md (R14.1
draft), design/q26-blind-set-inventory-2026-10-17.md (B15b confirm; B18 reserve).

Commands
  select-b18   Poloniex USDT spot pairs on no used venue list; listing = the market's tradableStartTime from the
               public markets list (no candle is read). Reserve set for a revised R14.1 model.

No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r112_combine as R112  # noqa: E402
import r125_fh_deep as R125  # noqa: E402
import r13_recal as R13  # noqa: E402

POLO_MARKETS = "https://api.poloniex.com/markets"
B18_FIRST_MAX = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)   # tradable before 2025-07-01


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    return sha256b(open(p, "rb").read())


# =============================================================================================
# B18 selection (listings only)
# =============================================================================================
def other_used(datasets):
    """bases of every other price set whose prices were or will be read: B15 (both halves), B17 (both halves), B9, B10."""
    s15 = json.load(open(os.path.join(datasets, "b15-mexc-prices/selection-b15.json")))
    b15 = set(s15["eligible"])
    s17 = json.load(open(os.path.join(datasets, "b17-uniswap-alts/selection-r129.json")))
    b17 = {str(x.get("symbol", "")).upper() for x in s17["assets"]}
    b9 = set()
    for root, _, files in os.walk(os.path.join(datasets, "b9-delisted-prices")):
        for f in files:
            if f.endswith(".json.gz") and "USDT" in f:
                b9.add(f.split("-")[1].split("USDT")[0].upper() if "-" in f else f.split("USDT")[0].upper())
    return b15, b17, b9


def cmd_select_b18(a):
    raw = R125.http_get(POLO_MARKETS)
    mk = json.loads(raw)
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = other_used(a.datasets)
    bn = set(R125.binance_symbols())
    rec = {"poloniex_usdt_pairs": 0, "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [], "in_b15": [],
           "in_b17": [], "in_b9": [], "excluded": {}, "late": [], "kept": []}
    sym_of, start_of, state_of = {}, {}, {}
    for m in sorted(mk, key=lambda x: x["symbol"]):
        if m.get("quoteCurrencyName") != "USDT":
            continue
        rec["poloniex_usdt_pairs"] += 1
        base = m["baseCurrencyName"].upper()
        sym_of[base], start_of[base], state_of[base] = m["symbol"], int(m.get("tradableStartTime") or 0), m.get("state")
        if R125.on_binance(base, bn):
            rec["on_binance"].append(base)
        elif base in kc:
            rec["on_kucoin"].append(base)
        elif base in b12:
            rec["in_b12"].append(base)
        elif base in b14:
            rec["in_b14"].append(base)
        elif base in b15:
            rec["in_b15"].append(base)
        elif base in b17:
            rec["in_b17"].append(base)
        elif base in b9:
            rec["in_b9"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        elif not start_of[base] or start_of[base] >= B18_FIRST_MAX:
            rec["late"].append(base)
        else:
            rec["kept"].append(base)
    elig = sorted(rec["kept"])
    out = {"schema": "q26-r14-b18-selection-v1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "source": "Poloniex public REST /markets (keyless); candles /markets/{symbol}/candles HOUR_1 (not read)",
           "poloniex_markets_sha256": sha256b(raw), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc),
           "b12_assets": len(b12), "b14_assets": len(b14), "b15_assets": len(b15), "b17_symbols": len(b17),
           "b9_assets": len(b9), "eligible_tradable_start_before_utc": "2025-07-01T00:00:00Z",
           "eligible": elig, "B18": elig,
           "tradable_start_utc": {b: datetime.fromtimestamp(start_of[b] / 1000, timezone.utc).strftime("%Y-%m-%d")
                                  for b in elig},
           "state": {b: state_of[b] for b in elig}, "symbol": {b: sym_of[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b18.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()
                      if k not in ("tradable_start_utc", "state", "symbol")}, indent=1))
    print("sha256", sha_file(p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select-b18"])
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    {"select-b18": cmd_select_b18}[a.cmd](a)


if __name__ == "__main__":
    main()
