"""Q26 Round 16, item R16.2: new-model bake-off for price-touch odds P(min low over (t, t+T] <= level).

membrane-board design/Q26_ROUND16_PREREG.md section "R16.2" (Deviations D-R16.2*), design/q26-blind-set-inventory-
2026-10-17.md (section 20: R16.2 reservations B20a/B20b). Owner (2026-10-19): "if our baseline is simply a model that
worked better, let's try new ones".

Subcommands
  select-b20   XT.com venue-unique USDT pairs (listing data and monthly-candle open times only; prices are discarded in
               code). Split by sha256('Q26-R16-B20:' + base): first byte even -> B20a (confirm), odd -> B20b (reserve).
  rows         development rows (seen data only; see r16_dev.py).
  score        development scoring and the pre-stated selection rule (see r16_dev.py).

Free data only. No address, key or secret is read or written.
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

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND16_PREREG.md", "item": "R16.2",
          "deviations": "D-R16.2*"}
XT_SYMBOLS = "https://sapi.xt.com/v4/public/symbol"
XT_K = "https://sapi.xt.com/v4/public/kline?symbol={s}&interval={i}&limit={n}"
B20_FIRST_MAX = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp())
SALT_B20 = "Q26-R16-B20:"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def git_sha():
    try:
        import subprocess
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"]).decode().strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def xt_first_month(sym):
    """open time (UTC s) of the earliest monthly candle the endpoint returns (up to 100 months back, i.e. 2018-06);
    prices are discarded in code."""
    import r125_fh_deep as R125
    try:
        d = json.loads(R125.http_get(XT_K.format(s=sym, i="1M", n=1000)))
    except Exception:  # noqa: BLE001
        return None
    r = d.get("result") or []
    if not r:
        return None
    return int(min(int(x["t"]) for x in r) // 1000)


def cmd_select_b20(a):
    import concurrent.futures as cf

    import r125_fh_deep as R125
    import r13_recal as R13
    import r14_dr as R14
    raw = R125.http_get(XT_SYMBOLS)
    syms = json.loads(raw)["result"]["symbols"]
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = R14.other_used(a.datasets)
    b18 = set(json.load(open(os.path.join(a.datasets, "b18-poloniex-prices/selection-b18.json")))["B18"])
    s19 = json.load(open(os.path.join(a.datasets, "b19-lbank-prices/selection-b19.json")))
    b19 = set(s19["B19a"]) | set(s19["B19b"])
    bn = set(R125.binance_symbols())
    rec = {"xt_usdt_pairs": 0, "not_online": [], "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [],
           "in_b15": [], "in_b17": [], "in_b18": [], "in_b19": [], "in_b9": [], "excluded": {}, "no_history": [],
           "late": [], "kept": []}
    cand = {}
    for s in sorted(syms, key=lambda x: x["symbol"]):
        if s.get("quoteCurrency") != "usdt":
            continue
        rec["xt_usdt_pairs"] += 1
        base = s["baseCurrency"].upper()
        if s.get("state") != "ONLINE":
            rec["not_online"].append(base)
        elif R125.on_binance(base, bn):
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
        elif base in b18:
            rec["in_b18"].append(base)
        elif base in b19:
            rec["in_b19"].append(base)
        elif base in b9:
            rec["in_b9"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        else:
            cand[base] = s["symbol"]
    first = {}
    with cf.ThreadPoolExecutor(6) as ex:
        for base, t0 in zip(cand, ex.map(xt_first_month, cand.values())):
            first[base] = t0
    for base in sorted(cand):
        t0 = first[base]
        if t0 is None:
            rec["no_history"].append(base)
        elif t0 >= B20_FIRST_MAX:
            rec["late"].append(base)
        else:
            rec["kept"].append(base)
    elig = sorted(rec["kept"])
    split = {b: ("B20a" if hashlib.sha256((SALT_B20 + b).encode()).digest()[0] % 2 == 0 else "B20b") for b in elig}
    out = {"schema": "q26-r16-b20-selection-v1", "created_utc": now_iso(), "code_sha": git_sha(), "prereg": PREREG,
           "source": "XT.com public REST v4 public/symbol (keyless); kline 1M earliest open time only (prices "
                     "discarded); hourly candles not read",
           "xt_symbols_sha256": sha256b(raw), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc),
           "b12_assets": len(b12), "b14_assets": len(b14), "b15_assets": len(b15), "b17_symbols": len(b17),
           "b18_assets": len(b18), "b19_assets": len(b19), "b9_assets": len(b9),
           "eligible_first_month_before_utc": "2025-07-01T00:00:00Z", "salt": SALT_B20, "eligible": elig,
           "B20a": sorted(b for b in elig if split[b] == "B20a"), "B20b": sorted(b for b in elig if split[b] == "B20b"),
           "first_month_utc": {b: datetime.fromtimestamp(first[b], timezone.utc).strftime("%Y-%m") for b in elig},
           "symbol": {b: cand[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b20.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()
                      if k not in ("first_month_utc", "symbol")}, indent=1))
    for part in ("B20a", "B20b"):
        yrs = {}
        for b in out[part]:
            yrs[out["first_month_utc"][b][:4]] = yrs.get(out["first_month_utc"][b][:4], 0) + 1
        print(part, len(out[part]), dict(sorted(yrs.items())))
    print("sha256", hashlib.sha256(open(p, "rb").read()).hexdigest())


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select-b20")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"select-b20": cmd_select_b20}[a.cmd](a)


if __name__ == "__main__":
    main()
