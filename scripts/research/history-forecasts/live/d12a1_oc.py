#!/usr/bin/env python3
"""Operating characteristics of the D12-A1 monitors on development data (membrane-board HISTORY_TOUCH_LIVE.md D12-A1).

  python3 d12a1_oc.py --rows ROWS_NPZ --out OC_JSON [--paths 2000] [--days 1826] [--workers 4]

Same design as d12_oc.py (D12.6): ROWS_NPZ is the daily development rows of the 54 A1 cells written by
d12a1_build.py --cache (r192_borrower.task at 6 h - 7 d, r16_dev.task at 1 h, 3 h, 30 d; seen data). Per monitor and
scenario rho, p is rescaled to p * rho / R_dev (clipped at 1), so the monitor's pooled development R is rho. Paths: the
d12_oc stationary block bootstrap of calendar days (mean block 28 days, seed 20261025), shared by all monitors. The
monitor is the registered rule, vectorised (d12_oc.run_paths, tested equal to q26_live_d12.monitor_step).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_d12 as L  # noqa: E402
import d12_oc as OC  # noqa: E402

_G = {}


def _unit(args):
    key, T = args
    Z, UA, idx, nd = _G["Z"], _G["UA"], _G["idx"], _G["nd"]
    ts, p, y = Z[key + "|ts"], Z[key + "|p"], Z[key + "|y"]
    di = (ts - OC.D0) // L.DAY
    m = (di >= 0) & (di < nd)
    ts, p, y, di = ts[m], p[m], y[m], di[m]
    out = {}
    for rho in OC.RHOS:
        q = np.clip(p * rho / (p.sum() / y.sum()), 0, 1)
        n_, P_, Y_ = (np.bincount(di, w, nd) for w in (np.ones_like(q), q, y))
        f = OC.run_paths(n_[idx], P_[idx], Y_[idx], L.h_of(T), UA["v0"][key]["A"], UA["v0"][key]["B"])
        out[rho] = f
    return key, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--paths", type=int, default=2000)
    ap.add_argument("--days", type=int, default=1826)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    UA = L.load_a1_universe()
    Z = dict(np.load(a.rows))
    nd = len(np.arange(OC.D0, OC.D1, L.DAY))
    rng = np.random.default_rng(OC.SEED)
    idx = OC.boot_idx(a.paths, a.days, nd, rng)
    _G.update(Z=Z, UA=UA, idx=idx, nd=nd)
    units = L.a1_units()
    with mp.get_context("fork").Pool(a.workers) as pool:
        firsts = dict(pool.map(_unit, [(u[0], u[1]) for u in units], chunksize=1))
    res = {"schema": "q26-touch-live/d12a1-oc/1", "code": UA["code"], "universeSha256": UA["fileSha256"],
           "paths": a.paths, "days": a.days, "block": OC.BLOCK, "seed": OC.SEED,
           "pool": [L.C.iso(OC.D0), L.C.iso(OC.D1 - L.DAY)], "scenarios": {}}
    for rho in OC.RHOS:
        sc = {"groups": {}}
        for key, T, js, g in units:
            f = firsts[key][rho]
            ok = f >= 0
            by = {f"{yy}y": float(np.mean(ok & (f < 365.25 * yy))) for yy in (1, 2, 3, 5)}
            med = float(np.median(np.where(ok, f, 10 ** 9)))
            sc["groups"][key] = {"P_downgrade_by": by, "median_days": (med if med < 10 ** 9 else None)}
        F = np.stack([firsts[u[0]][rho] for u in units])
        sc["family_any_of_54"] = {f"{yy}y": float(np.mean(((F >= 0) & (F < 365.25 * yy)).any(0)))
                                  for yy in (1, 2, 3, 5)}
        for g in L.GROUPS:
            Fg = np.stack([firsts[u[0]][rho] for u in units if u[3] == g])
            sc[f"family_any_{g}"] = {f"{yy}y": float(np.mean(((Fg >= 0) & (Fg < 365.25 * yy)).any(0)))
                                     for yy in (1, 2, 3, 5)}
        mx = {f"{yy}y": max(v["P_downgrade_by"][f"{yy}y"] for v in sc["groups"].values()) for yy in (1, 3, 5)}
        sc["max_per_monitor"] = mx
        res["scenarios"][str(rho)] = sc
        print(f"rho {rho}: max per monitor {mx}; family of 54 {sc['family_any_of_54']}", flush=True)
    with open(a.out, "w") as fo:
        json.dump(res, fo, indent=1)


if __name__ == "__main__":
    main()
