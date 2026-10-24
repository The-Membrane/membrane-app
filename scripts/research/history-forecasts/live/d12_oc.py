#!/usr/bin/env python3
"""Operating characteristics of the D12 monitor rule on development data (membrane-board HISTORY_TOUCH_LIVE.md D12).

  python3 d12_oc.py --datasets DS --out OC_JSON [--paths 2000] [--days 1826] [--workers 4]

Development rows: r192_borrower.task (unchanged) on the 20 D12 series, daily 00:00Z origins (seen data). Per monitor
group and scenario rho, p is rescaled to p * rho / R_dev (clipped at 1), so the group's pooled development R is rho.
rho = 1 is calibration holding; 1.25 and 0.8 are the band edges (the null boundary); 1.4, 0.7, 2.0 and 0.5 are
miscalibration. Paths: a stationary block bootstrap of calendar days (mean block 28 days, seed 20261025), shared by all
groups (so the family-wise rate keeps the cross-group dependence). The monitor is the registered rule, vectorised over
paths: run_paths() equals q26_live_d12.monitor_step day by day (test_q26_live_d12.py checks it).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_d12 as L  # noqa: E402
import q26_live_common as C  # noqa: E402

RHOS = (1.0, 1.25, 0.8, 1.4, 0.7, 2.0, 0.5)
BLOCK = 28
SEED = 20261025
D0, D1 = C.A.utc("2018-10-01T00:00:00Z"), C.A.utc("2026-10-01T00:00:00Z")


def run_paths(n, P, Y, h, v0A, v0B):
    """n, P, Y: (paths, N) daily sums of one group (n = issued rows; every row labelled). Returns the first day index
    at which the group downgrades (the resolution day of the crossing day), or -1."""
    paths, N = P.shape
    XA, BA = P / L.R_BAND[1] - Y, n - P / L.R_BAND[1]
    XB, BB = Y - P / L.R_BAND[0], P / L.R_BAND[0]
    lKA, lKB = np.zeros((paths, h)), np.zeros((paths, h))
    s1A, s2A, s1B, s2B, cnt = (np.zeros(paths) for _ in range(5))
    cP, cY = np.zeros(paths), np.zeros(paths)
    first = np.full(paths, -1)
    thr = math.log(h / L.ALPHA)
    for s in range(N):
        r = s - h
        if r >= 0:                                    # day s - h has resolved by origin s: it joins the plug-in
            ob = n[:, r] > 0
            s1A += np.where(ob, XA[:, r], 0)
            s2A += np.where(ob, XA[:, r] ** 2, 0)
            s1B += np.where(ob, XB[:, r], 0)
            s2B += np.where(ob, XB[:, r] ** 2, 0)
            cnt += ob
        ob = n[:, s] > 0
        j = s % h
        mA, vA = s1A / (L.N0 + cnt), (L.N0 * v0A + s2A) / (L.N0 + cnt)
        mB, vB = s1B / (L.N0 + cnt), (L.N0 * v0B + s2B) / (L.N0 + cnt)
        with np.errstate(divide="ignore", invalid="ignore"):
            lamA = np.where(BA[:, s] > 0, np.clip(mA / vA, 0, L.CAP_FRAC / np.where(BA[:, s] > 0, BA[:, s], 1)), 0)
            lamB = np.where(BB[:, s] > 0, np.clip(mB / vB, 0, L.CAP_FRAC / np.where(BB[:, s] > 0, BB[:, s], 1)), 0)
        lKA[:, j] += np.where(ob, np.log1p(lamA * XA[:, s]), 0)
        lKB[:, j] += np.where(ob, np.log1p(lamB * XB[:, s]), 0)
        cP += np.where(ob, P[:, s], 0)
        cY += np.where(ob, Y[:, s], 0)
        e = (0.5 * (np.exp(lKA) + np.exp(lKB))).max(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            R = np.where(cY > 0, cP / np.where(cY > 0, cY, 1), np.where(cP > 0, np.inf, np.nan))
        out = (R > L.R_BAND[1]) | (R < L.R_BAND[0])
        fire = ob & (np.log(np.maximum(e, 1e-300)) >= thr) & out & (first < 0)
        first[fire] = s + h
    return first


def boot_idx(paths, N, nd, rng):
    idx = np.empty((paths, N), np.int64)
    cur = rng.integers(0, nd, paths)
    for t in range(N):
        jump = rng.random(paths) < 1 / BLOCK
        cur = np.where(jump, rng.integers(0, nd, paths), (cur + 1) % nd)
        idx[:, t] = cur
    return idx


def main():
    import d12_build as DB
    import r16_dev as RD
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--paths", type=int, default=2000)
    ap.add_argument("--days", type=int, default=1826)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    U = L.load_universe()
    S = U["series"]
    RD.init_btc(a.datasets)
    with mp.get_context("fork").Pool(a.workers) as pool:
        rows = dict(pool.map(DB._task, [(e, a.datasets) for e in S]))
    days = np.arange(D0, D1, L.DAY)
    nd = len(days)
    rng = np.random.default_rng(SEED)
    idx = boot_idx(a.paths, a.days, nd, rng)
    res = {"schema": "q26-touch-live/d12-oc/1", "code": RD.git_sha(), "paths": a.paths, "days": a.days,
           "block": BLOCK, "seed": SEED, "pool": [C.iso(D0), C.iso(D1 - L.DAY)], "scenarios": {}}
    firsts = {}
    for rho in RHOS:
        firsts[rho] = {}
        res["scenarios"][str(rho)] = {"groups": {}}
        for (T, k) in L.CELLS:
            jl = L.L8.index(k)
            for g in L.GROUPS:
                gk = L.gkey(T, k, g)
                ts, p, y = [], [], []
                for e in S:
                    if e["group"] == g and T in rows[e["symbol"]]:
                        R_ = rows[e["symbol"]][T]
                        ts.append(R_["ts"])
                        p.append(R_["fH"][:, jl].astype(float))
                        y.append(R_["y"][:, jl].astype(float))
                ts, p, y = (np.concatenate(v) for v in (ts, p, y))
                q = np.clip(p * rho / (p.sum() / y.sum()), 0, 1)
                di = (ts - D0) // L.DAY
                n_, P_, Y_ = (np.bincount(di, w, nd) for w in (np.ones_like(q), q, y))
                t0 = time.time()
                f = run_paths(n_[idx], P_[idx], Y_[idx], L.h_of(T), U["v0"][gk]["A"], U["v0"][gk]["B"])
                firsts[rho][gk] = f
                ok = f >= 0
                by = {f"{yy}y": float(np.mean(ok & (f < 365.25 * yy))) for yy in (1, 2, 3, 5)}
                med = float(np.median(np.where(ok, f, 10 ** 9)))
                res["scenarios"][str(rho)]["groups"][gk] = {"P_downgrade_by": by,
                                                           "median_days": (med if med < 10 ** 9 else None)}
                print(f"rho {rho} {gk:16s} {by} median {med if med < 1e9 else 'never'} ({time.time() - t0:.0f}s)",
                      flush=True)
        F = np.stack(list(firsts[rho].values()))
        fam = {f"{yy}y": float(np.mean(((F >= 0) & (F < 365.25 * yy)).any(0))) for yy in (1, 2, 3, 5)}
        res["scenarios"][str(rho)]["family_any_of_16"] = fam
        print(f"rho {rho} FAMILY {fam}", flush=True)
    with open(a.out, "w") as fo:
        json.dump(res, fo, indent=1)


if __name__ == "__main__":
    main()
