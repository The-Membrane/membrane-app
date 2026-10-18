"""Q26 Round 13: R13.1 slope-from-pool, level-from-subject recalibration of (fH); blind set B15 (MEXC venue-unique).

membrane-board design/Q26_ROUND13_PREREG.md (R13.1, D-R13.1a ...), design/q26-blind-set-inventory-2026-10-17.md
section 13 (B15a confirm, B15b held back).

Commands
  select-b15   MEXC live USDT spot pairs on no used venue list; listing probe = month of the first monthly kline
               (timestamp only; no price is kept or printed). Split by sha256('Q26-R13-B15:' + base).
  dev          development on SEEN data only (R12 development pool, B9, B12, B13a): slope fits, level menu,
               development effects and power inputs for R13.1; ln sigma_fut errors for R13.2/R13.3 power.
  acquire-b15a outcome-blind B15a builder (MEXC 60m klines, sha256 per raw page). Prints no label or price.
  counts       counts only on B15a (validated origins, positive origins, positive blocks per cell).
  power        projected power at the B15a counts from the development effects.
  freeze       frozen config (code sha, input sha256 values, maps, constants, seeds, created_utc).
  run          one run on B15a from the frozen config.

No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import concurrent.futures as cf  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.parse  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.special import expit  # noqa: E402
from scipy.stats import norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402
import a_touch as A  # noqa: E402
import r112_combine as R112  # noqa: E402
import r12_tail as R12  # noqa: E402
import r125_fh_deep as R125  # noqa: E402

STEP = R12.STEP
DAY = 86400
LEVELS = R12.LEVELS
KIX = {k: j for j, k in enumerate(LEVELS)}
SHALLOW = [j for j, k in enumerate(LEVELS) if k >= -0.10]
DEEP = [j for j, k in enumerate(LEVELS) if k <= -0.15]
BANDS = {"shallow": SHALLOW, "deep": DEEP}
HS = (1, 3, 12, 24, 72)
TL = R12.TL
# scored cells (fixed in D-R13.1a before any B15a byte): shallow = the R11.10 validated region; deep = R12.5 cells
CELLS_SHALLOW = [(1, -0.02), (1, -0.03), (3, -0.02), (3, -0.03), (3, -0.05), (3, -0.07),
                 (12, -0.02), (12, -0.03), (12, -0.05), (12, -0.07), (12, -0.10)]
CELLS_DEEP = [(12, -0.15), (12, -0.20), (24, -0.15), (24, -0.20), (72, -0.15), (72, -0.20)]
CELLS = CELLS_SHALLOW + CELLS_DEEP
MENU = [(30, 20.0), (30, 50.0), (90, 20.0), (90, 50.0)]   # (W days, kappa); simplicity order: larger kappa, longer W
LEVEL_GRID = 6 * STEP                                     # level sums use origins on the 6-hourly grid only
PCLIP = 1e-4
SEED = 20261831
NB = 2000
NI_MARGIN = -0.002                                        # Brier non-inferiority: BSS(p' vs fH) lower 90% bound
DSC_TOL = 0.01                                            # DSC(p') >= (1 - DSC_TOL) * DSC(fH)
ALPHA = 0.05
WICK_MULT = 9.0                                           # R13.3 constant, fixed in the memo

MEXC_INFO = "https://api.mexc.com/api/v3/exchangeInfo"
MEXC_K = "https://api.mexc.com/api/v3/klines?symbol={s}&interval={i}&startTime={a}&endTime={b}&limit={n}"
SPLIT_B15 = "Q26-R13-B15:"
B15_FIRST_MAX = "2025-06"                                 # first monthly kline month <= 2025-06
ACQ_END = R12.END


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    return sha256b(open(p, "rb").read())


# =============================================================================================
# B15 selection (listings only)
# =============================================================================================
def used_lists(datasets):
    s12 = json.load(open(os.path.join(datasets, "b12-venue-unique-prices/selection-b12.json")))
    b12 = {x.split("-")[0].replace("USDT", "") for x in set(s12["okx"]["kept"]) | set(s12["bybit"]["kept"])}
    s13 = json.load(open(os.path.join(datasets, "b13-kucoin-prices/selection-b13.json")))
    kc = set(s13["on_binance"]) | set(s13["in_b12"]) | set(s13["excluded"]) | set(s13["kept"])
    s14 = json.load(open(os.path.join(datasets, "b14-gate-prices/selection-b14.json")))
    b14 = set(s14["B14a"]) | set(s14["B14b"])
    return b12, kc, b14


def mexc_first_month(sym):
    """month (YYYY-MM) of the first monthly kline; only the open timestamp is read, prices are discarded."""
    raw = R125.http_get(MEXC_K.format(s=urllib.parse.quote(sym), i="1M", a=1483228800000, b=ACQ_END * 1000, n=1000))
    d = json.loads(raw)
    if not isinstance(d, list) or not d:
        return None
    t = min(int(x[0]) for x in d) // 1000
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m")


def cmd_select_b15(a):
    raw = R125.http_get(MEXC_INFO)
    info = json.loads(raw)
    b12, kc, b14 = used_lists(a.datasets)
    bn = set(R125.binance_symbols())
    rec = {"mexc_usdt_pairs": 0, "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [], "excluded": {},
           "kept": []}
    sym_of = {}
    for s in sorted(info["symbols"], key=lambda x: x["symbol"]):
        if s.get("quoteAsset") != "USDT":
            continue
        rec["mexc_usdt_pairs"] += 1
        base = s["baseAsset"].upper()
        sym_of[base] = s["symbol"]
        if R125.on_binance(base, bn):
            rec["on_binance"].append(base)
        elif base in kc:
            rec["on_kucoin"].append(base)
        elif base in b12:
            rec["in_b12"].append(base)
        elif base in b14:
            rec["in_b14"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        else:
            rec["kept"].append(base)
    with cf.ThreadPoolExecutor(6) as ex:
        first = dict(zip(rec["kept"], ex.map(lambda b: mexc_first_month(sym_of[b]), rec["kept"])))
    elig = sorted(b for b in rec["kept"] if first.get(b) and first[b] <= B15_FIRST_MAX)
    out = {"schema": "q26-r13-b15-selection-v1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "source": "MEXC public REST api/v3 klines 60m (keyless); live USDT spot pairs only (exchangeInfo)",
           "mexc_exchangeinfo_sha256": sha256b(raw), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc),
           "b12_assets": len(b12), "b14_assets": len(b14), "first_month": first,
           "eligible_first_month_le": B15_FIRST_MAX, "eligible": elig,
           "split_rule": f"sha256('{SPLIT_B15}' + base)[0:2] as hex byte: even -> B15a, odd -> B15b",
           "B15a": [b for b in elig if int(sha256b((SPLIT_B15 + b).encode())[:2], 16) % 2 == 0],
           "B15b": [b for b in elig if int(sha256b((SPLIT_B15 + b).encode())[:2], 16) % 2 == 1],
           "symbol": {b: sym_of[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b15.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()}, indent=1))
    print("sha256", sha_file(p))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "select-b15":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    cmd_select_b15(ap.parse_args())
