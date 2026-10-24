#!/usr/bin/env python3
"""Operating characteristics of the D13 monitor on development data (membrane-board HISTORY_TOUCH_LIVE.md D13).

  python3 d13_oc.py --rows ROWS_DIR --out OC_JSON [--paths 2000] [--days 1826]

Same design as D12.6 / D12-A2 (live/d12_oc.py): development rows (raw (fH) on the D13 III grids, target (b) with the
strict null rule; d13_build.py rows), daily 00:00Z origins, seen data. Per unit and scenario rho, p is rescaled to
p * rho / R_dev (clipped at 1), so the unit's pooled development R is rho. Paths: a stationary block bootstrap of
calendar days (mean block 28 days, seed 20261025), shared by all units. The rule is d12_oc.run_paths (equal to
q26_live_d12.monitor_step day by day; test_q26_live_d12.py), which D13 runs unchanged.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import d12_oc as O12  # noqa: E402
import d13_build as DB  # noqa: E402
import q26_live_common as C  # noqa: E402
import q26_live_d13 as L  # noqa: E402

RHOS = (1.0, 1.25, 0.8, 1.4, 0.7, 2.0, 0.5)
YEARS = (1, 2, 3, 5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--paths", type=int, default=2000)
    ap.add_argument("--days", type=int, default=1826)
    a = ap.parse_args()
    U = L.load_universe()
    S = U["series"]
    R = DB.load_rows(a.rows)
    days = np.arange(O12.D0, O12.D1, L.DAY)
    nd = len(days)
    rng = np.random.default_rng(O12.SEED)
    idx = O12.boot_idx(a.paths, a.days, nd, rng)
    units = L.monitor_units()
    res = {"schema": "q26-touch-live/d13-oc/1", "code": DB.C_git(), "paths": a.paths, "days": a.days,
           "block": O12.BLOCK, "seed": O12.SEED, "pool": [C.iso(O12.D0), C.iso(O12.D1 - L.DAY)], "scenarios": {}}
    sums = {}
    for gk, T, js, g in units:
        ts, p, y = DB.unit_rows(L, R, S, g, T, js)
        m = (ts >= O12.D0) & (ts < O12.D1)
        ts, p, y = ts[m], p[m], y[m]
        sums[gk] = (np.repeat(ts, len(js)), p.ravel(), y.ravel())
    for rho in RHOS:
        firsts = {}
        res["scenarios"][str(rho)] = {"units": {}}
        for gk, T, js, g in units:
            ts, p, y = sums[gk]
            Rd = p.sum() / y.sum() if y.sum() > 0 else 1.0
            q = np.clip(p * rho / Rd, 0, 1)
            di = (ts - O12.D0) // L.DAY
            n_, P_, Y_ = (np.bincount(di, w, nd) for w in (np.ones_like(q), q, y))
            t0 = time.time()
            f = O12.run_paths(n_[idx], P_[idx], Y_[idx], L.h_of(T), U["v0"][gk]["A"], U["v0"][gk]["B"])
            firsts[gk] = f
            ok = f >= 0
            by = {f"{yy}y": float(np.mean(ok & (f < 365.25 * yy))) for yy in YEARS}
            med = float(np.median(np.where(ok, f, 10 ** 9)))
            res["scenarios"][str(rho)]["units"][gk] = {"P_downgrade_by": by, "median_days": med if med < 1e9 else None,
                                                      "positives": int(y.sum())}
            print(f"rho {rho} {gk:22s} {by} median {med if med < 1e9 else 'never'} ({time.time() - t0:.0f}s)",
                  flush=True)
        F = np.stack([firsts[u[0]] for u in units])
        nc = 2 * len(L.CELLS)

        def fam(Fs):
            return {f"{yy}y": float(np.mean(((Fs >= 0) & (Fs < 365.25 * yy)).any(0))) for yy in YEARS}
        res["scenarios"][str(rho)]["family_cells_70"] = fam(F[:nc])
        res["scenarios"][str(rho)]["family_pooled_10"] = fam(F[nc:])
        res["scenarios"][str(rho)]["family_all_80"] = fam(F)
        warn = [i for i, u in enumerate(units[:nc]) if L.default_class(u[3], u[1], L.L8[u[2][0]]) == L.CLASS_WARN]
        res["scenarios"][str(rho)]["family_warn_cells"] = fam(F[warn])
        res["scenarios"][str(rho)]["n_warn_cells"] = len(warn)
        print(f"rho {rho} FAMILY cells {fam(F[:nc])} pooled {fam(F[nc:])} all {fam(F)}", flush=True)
    with open(a.out, "w") as fo:
        json.dump(res, fo, indent=1)


if __name__ == "__main__":
    main()
