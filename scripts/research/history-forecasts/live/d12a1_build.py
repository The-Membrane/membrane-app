#!/usr/bin/env python3
"""Build the frozen D12-A1 inputs (membrane-board design/HISTORY_TOUCH_LIVE.md D12-A1) from the development code.

  python3 d12a1_build.py --datasets DS [--workers 3] [--cache ROWS_NPZ]

Development rows (seen data, daily 00:00Z origins) of the 20 D12 series:
  6 h - 7 d     r192_borrower.task (unchanged; the D12 forecast path), L8 levels
  1 h, 3 h, 30 d r16_dev.task (unchanged; the R16.2 (fH) path that R19.3 graded at these T), r16_dev.LV levels
Writes, next to this file:
  d12a1_golden.json    the r16_dev.task rows of the 20 series at the three D12 replay origins for 1 h, 3 h and 30 d:
                       raw (fH), (f), (a) at r16_dev.LV[T] (float32) and the spot label y.
  d12a1_universe.json  the 54 A1 cells per group; climatology (e) per A1 monitor (development frequency); plug-in
                       prior variances v0 per monitor and side (development days, p rescaled to pooled R = 1); the
                       development table (rows, days, positives, R, BSS vs (a) and (e)); the golden file sha256.
With --cache, the daily development rows of the A1 cells are saved for d12a1_oc.py.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_d12 as L  # noqa: E402
import q26_live_common as C  # noqa: E402
import d12_build as DB  # noqa: E402

sys.path.insert(0, C.MODEL_DIR)
import r16_dev as RD  # noqa: E402  (imported, never modified)


def _task16(args):
    """r16_dev.task rows at the A1 horizons, daily 00:00Z origins only."""
    e, datasets = args
    r = RD.task({"key": e["key"], "kind": "grid", "path": os.path.join(datasets, e["path"])})
    out = {}
    for T in L.TS_A1:
        R = r["rows"].get(T)
        if R is None:
            continue
        m = np.asarray(R["ts"]) % 86400 == 0
        out[T] = {k: np.asarray(R[k])[m] for k in ("ts", "y", "a", "f", "fH")}
        out[T]["levels"] = tuple(RD.LV[T])
    return e["symbol"], out


def a1_rows(datasets, workers):
    """{symbol: {T: {ts, y, a, f, fH, levels}}} for every A1 horizon (6 h - 7 d from r192, 1/3/30 d from r16)."""
    S = L.load_universe()["series"]
    RD.init_btc(datasets)
    with mp.get_context("fork").Pool(workers, maxtasksperchild=2) as pool:
        r16 = dict(pool.map(_task16, [(e, datasets) for e in S], chunksize=1))
        r192 = dict(pool.map(DB._task, [(e, datasets) for e in S], chunksize=1))
    rows = {}
    for e in S:
        s_ = e["symbol"]
        rows[s_] = {}
        for T, R in r192[s_].items():
            rows[s_][T] = dict(R, levels=tuple(L.L8))
        for T, R in r16[s_].items():
            rows[s_][T] = R
    return S, rows


def cell_arrays(S, rows, g, T, k):
    ts, p, y, pa = [], [], [], []
    for e in S:
        if e["group"] != g or T not in rows[e["symbol"]]:
            continue
        R = rows[e["symbol"]][T]
        j = list(R["levels"]).index(k)
        ts.append(R["ts"])
        p.append(R["fH"][:, j].astype(float))
        y.append(R["y"][:, j].astype(float))
        pa.append(R["a"][:, j].astype(float))
    return tuple(np.concatenate(v) for v in (ts, p, y, pa))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--cache", default=None)
    a = ap.parse_args()
    assert tuple(RD.TS) == L.TS_ALL and all(tuple(RD.LV[T]) == L.A1_LV16[T] for T in L.TS_A1)
    for g in L.GROUPS:
        for (T, k) in L.A1_CELLS[g]:
            assert (T, k) not in L.CELLS, "an A1 cell repeats a D12 per-cell monitor"
            assert k in (L.L8 if T in L.TS else L.A1_LV16[T]), "an A1 level outside the development ladder"
    S, rows = a1_rows(a.datasets, a.workers)
    golden = {"schema": "q26-touch-live/d12a1-golden/1", "code": RD.git_sha(),
              "what": "r16_dev.task development rows (R16.2 (fH) path) at the D12 replay origins, 1 h / 3 h / 30 d",
              "rows": {}}
    for oi in L.REPLAY_ORIGINS:
        ts = C.A.utc(oi)
        golden["rows"][oi] = {}
        for e in S:
            d = {}
            for T in L.TS_A1:
                R = rows[e["symbol"]].get(T)
                if R is None:
                    continue
                j = np.flatnonzero(R["ts"] == ts)
                if len(j) != 1:
                    continue
                j = int(j[0])
                d[L.TL[T]] = {nm: [float(v) for v in R[nm][j]] for nm in ("fH", "f", "a")}
                d[L.TL[T]]["y"] = [int(v) for v in R["y"][j]]
                d[L.TL[T]]["levels"] = list(R["levels"])
            golden["rows"][oi][e["symbol"]] = d
    gp = L.a1_golden_path()
    if os.path.exists(gp) and json.load(open(gp))["rows"] == json.loads(json.dumps(golden["rows"])):
        print("golden rows unchanged; d12a1_golden.json kept byte for byte")
    else:
        with open(gp, "w") as f:
            json.dump(golden, f, indent=0, sort_keys=True)
            f.write("\n")
    clim, v0, table, cache = {}, {}, {}, {}
    for key, T, js, g in L.a1_units():
        k = L.L8[js[0]]
        ts, p, y, pa = cell_arrays(S, rows, g, T, k)
        e_ = float(y.mean())
        clim[key] = e_
        Rdev = float(p.sum() / y.sum())
        q = p / Rdev
        days, inv = np.unique(ts, return_inverse=True)
        Pd, Yd = np.bincount(inv, q), np.bincount(inv, y)
        v0[key] = {"A": float(np.mean((Pd / L.R_BAND[1] - Yd) ** 2)), "B": float(np.mean((Yd - Pd / L.R_BAND[0]) ** 2))}
        bs = lambda c: float(np.sum((c - y) ** 2))   # noqa: E731
        table[key] = {"rows": int(len(y)), "days": int(len(days)), "positives": int(y.sum()), "R": Rdev,
                      "BSS_vs_a": 1 - bs(p) / bs(pa), "BSS_vs_e": 1 - bs(p) / bs(np.full_like(y, e_)),
                      "first": C.iso(int(ts.min())), "last": C.iso(int(ts.max())),
                      "source": "r192_borrower.task" if T in L.TS else "r16_dev.task"}
        cache[key + "|ts"], cache[key + "|p"], cache[key + "|y"] = ts, p, y
        print(key, json.dumps(table[key]), flush=True)
    U = {"schema": "q26-touch-live/d12a1-universe/1", "deviation": "D12-A1",
         "what": "D12-A1 added cells (same 20 series and groups as d12_universe.json). climatology = development "
                 "frequency (e) per A1 monitor. v0 = plug-in prior variance per A1 monitor and side (development days, "
                 "p rescaled to pooled R = 1). 6 h - 7 d rows: r192_borrower.task; 1 h, 3 h, 30 d: r16_dev.task.",
         "cells": {g: [L.cell_name(*c) for c in L.A1_CELLS[g]] for g in L.GROUPS},
         "climatology": clim, "v0": v0, "devTable": table,
         "goldenSha256": hashlib.sha256(open(gp, "rb").read()).hexdigest(), "code": RD.git_sha()}
    with open(L.a1_universe_path(), "w") as f:
        json.dump(U, f, indent=1)
        f.write("\n")
    if a.cache:
        np.savez_compressed(a.cache, **cache)
    n = sum(len(v) for o in golden["rows"].values() for v in o.values())
    print("golden rows (series x T):", n, "A1 monitors:", len(v0))


if __name__ == "__main__":
    main()
