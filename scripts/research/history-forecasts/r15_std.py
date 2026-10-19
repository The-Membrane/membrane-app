"""Q26 Round 15: standardization programme -- pool events in abstract (vol-scaled) space, model there, decode with the
target's ex-ante state and a per-class tail scale.

membrane-board design/Q26_ROUND15_PREREG.md (items R15.1-R15.4, Deviations D-R15.*), design/q26-blind-set-inventory-
2026-10-17.md (section 18: R15 reservations). Parents: design/Q26_ROUND13_PREREG.md (R13.1, R13.4, D-R13.4b-c),
design/Q26_ROUND14_PREREG.md (D-R14.1d, D-R14.2c rules), design/Q26_ROUND12_PREREG.md (R12.7, R12.9).

Owner goal (2026-10-19, relayed by the Q26 parent): "We should be testing standardization for everything possible
because event count will make our models better."

Subcommands (each is a fixed recipe; menus are chosen on development data only)
  select-b19   LBank venue-unique USDT pairs (listing data and the first monthly candle's open time only; prices are
               discarded in code). Split by sha256('Q26-R15-B19:' + base): first byte even -> B19a, odd -> B19b.
  dev1         R15.1 development on the R13.4 dev rows (deep cells, mature thin-tail rows; daily encoder).
  dev3         R15.3 development on the R12.9 dev split and the seen B17a (route-median oracle alert).
  dev2         R15.2 development on the R13.1 development pool (shallow cells; pooled-shape (fH) + the R13.1 map).
  counts1/3    counts-only checks of a reserved set (positives, blocks, series; no forecast, no score).
  power        power at the counts (D-R14.2c rules: every gate, joint power for PASS).
  freeze/run   only after the run Deviation.

Free data only. No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND15_PREREG.md", "items": "R15.1-R15.4",
          "deviations": "D-R15.*"}
DAY = 86400


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_sha():
    try:
        import subprocess
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"]).decode().strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)


# =============================================================================================
# B19: LBank venue-unique USDT pairs (reservation; listing data only)
# =============================================================================================
LB_PAIRS = "https://api.lbkex.com/v2/currencyPairs.do"
LB_K = "https://api.lbkex.com/v2/kline.do?symbol={s}&size={n}&type={t}&time={a}"
B19_FIRST_MAX = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp())
SALT_B19 = "Q26-R15-B19:"


def lbank_first_month(sym):
    """open time (UTC seconds) of the first monthly candle from 2017-01-01; prices are discarded in code."""
    import r125_fh_deep as R125
    raw = R125.http_get(LB_K.format(s=sym, n=2, t="month1", a=1483228800))
    d = json.loads(raw)
    if d.get("result") != "true" or not d.get("data"):
        return None
    return int(d["data"][0][0])


def cmd_select_b19(a):
    import concurrent.futures as cf

    import r125_fh_deep as R125
    import r13_recal as R13
    import r14_dr as R14
    raw = R125.http_get(LB_PAIRS)
    pairs = json.loads(raw)["data"]
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = R14.other_used(a.datasets)
    s18 = json.load(open(os.path.join(a.datasets, "b18-poloniex-prices/selection-b18.json")))
    b18 = set(s18["B18"])
    bn = set(R125.binance_symbols())
    rec = {"lbank_usdt_pairs": 0, "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [], "in_b15": [],
           "in_b17": [], "in_b18": [], "in_b9": [], "excluded": {}, "no_history": [], "late": [], "kept": []}
    cand = {}
    for p in sorted(pairs):
        if not p.endswith("_usdt"):
            continue
        rec["lbank_usdt_pairs"] += 1
        base = p[:-5].upper()
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
        elif base in b18:
            rec["in_b18"].append(base)
        elif base in b9:
            rec["in_b9"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        else:
            cand[base] = p
    first = {}
    with cf.ThreadPoolExecutor(8) as ex:
        for base, t0 in zip(cand, ex.map(lbank_first_month, cand.values())):
            first[base] = t0
    for base in sorted(cand):
        t0 = first[base]
        if t0 is None:
            rec["no_history"].append(base)
        elif t0 >= B19_FIRST_MAX:
            rec["late"].append(base)
        else:
            rec["kept"].append(base)
    elig = sorted(rec["kept"])
    split = {b: ("B19a" if hashlib.sha256((SALT_B19 + b).encode()).digest()[0] % 2 == 0 else "B19b") for b in elig}
    out = {"schema": "q26-r15-b19-selection-v1", "created_utc": now_iso(), "code_sha": git_sha(), "prereg": PREREG,
           "source": "LBank public REST v2 currencyPairs.do (keyless); kline.do month1 first open time only "
                     "(prices discarded); hourly candles not read",
           "lbank_pairs_sha256": sha256b(raw), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc),
           "b12_assets": len(b12), "b14_assets": len(b14), "b15_assets": len(b15), "b17_symbols": len(b17),
           "b18_assets": len(b18), "b9_assets": len(b9), "eligible_first_month_before_utc": "2025-07-01T00:00:00Z",
           "salt": SALT_B19, "eligible": elig,
           "B19a": sorted(b for b in elig if split[b] == "B19a"), "B19b": sorted(b for b in elig if split[b] == "B19b"),
           "first_month_utc": {b: datetime.fromtimestamp(first[b], timezone.utc).strftime("%Y-%m") for b in elig},
           "symbol": {b: cand[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b19.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()
                      if k not in ("first_month_utc", "symbol")}, indent=1))
    yrs = {}
    for b in elig:
        yrs[out["first_month_utc"][b][:4]] = yrs.get(out["first_month_utc"][b][:4], 0) + 1
    print("first-month years", dict(sorted(yrs.items())))
    print("sha256", sha_file(p))


# =============================================================================================
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select-b19")
    s.add_argument("--datasets", default="/home/user/membrane-datasets")
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"select-b19": cmd_select_b19}[a.cmd](a)


if __name__ == "__main__":
    main()
