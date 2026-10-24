#!/usr/bin/env python3
"""Build the frozen D12 inputs (membrane-board design/HISTORY_TOUCH_LIVE.md D12) from the R19.2 development code.

  python3 d12_build.py --datasets DS [--workers 4]

Writes, next to this file:
  d12_golden.json    the R19.2 development rows (r192_borrower.task, unchanged) of the 20 D12 series at the three
                     replay origins: raw (fH), (f), (a) at the L8 levels (float32) and the spot label y.
  d12_universe.json  the 20 series (Binance ETHUSDT, BTCUSDT = ETHBTC; the 18 A2/A3 large caps = LARGE) with the
                     development grid paths and sha256; the climatology (e) per monitor group (the development
                     frequency of the spot label over every daily 00:00Z development row of the group); the plug-in
                     prior variances v0 per group and side (development days, p rescaled so that the group's pooled
                     development R is 1); the golden file sha256.
Also prints the development calibration table (R, BSS vs (a) and (e)) per monitor group. Development only (seen data).
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

sys.path.insert(0, C.MODEL_DIR)
import r192_borrower as B  # noqa: E402  (imported, never modified)
import r16_dev as RD  # noqa: E402

D11_UNIVERSE = os.path.join(HERE, "d11_universe.json")    # read only: the development grid paths and sha256


def d12_series():
    U = json.load(open(D11_UNIVERSE))
    out = []
    for e in U["series"]:
        pre = e["key"].split(":")[0]
        if e["symbol"] in ("ETHUSDT", "BTCUSDT"):
            g = "ETHBTC"
        elif pre in ("A2", "A3"):
            g = "LARGE"
        else:
            continue
        out.append({"key": f"{pre if g == 'LARGE' else 'binance'}:{e['symbol']}", "symbol": e["symbol"], "group": g,
                    "path": e["path"], "sha256": e["sha256"], "startTs": e["startTs"], "devEndOpen": e["devEndOpen"]})
    out.sort(key=lambda e: (e["group"] != "ETHBTC", e["symbol"] != "ETHUSDT", e["symbol"]))
    return out


def _task(args):
    e, datasets = args
    spec = {"key": e["key"], "kind": "grid", "path": os.path.join(datasets, e["path"])}
    r = B.task(spec)
    out = {}
    for T, R in r["rows"].items():
        m = R["ts"] % 86400 == 0
        out[T] = {k: np.asarray(R[k])[m] for k in ("ts", "y", "a", "f", "fH")}
    return e["symbol"], out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    assert tuple(B.L8) == L.L8 and tuple(B.TS_B) == L.TS
    S = d12_series()
    assert len(S) == 20 and sum(e["group"] == "ETHBTC" for e in S) == 2
    RD.init_btc(a.datasets)
    with mp.get_context("fork").Pool(a.workers) as pool:
        rows = dict(pool.map(_task, [(e, a.datasets) for e in S]))
    golden = {"schema": "q26-touch-live/d12-golden/1", "code": RD.git_sha(),
              "what": "r192_borrower.task development rows at the D12 replay origins", "rows": {}}
    for oi in L.REPLAY_ORIGINS:
        ts = C.A.utc(oi)
        golden["rows"][oi] = {}
        for e in S:
            d = {}
            for T in L.TS:
                R = rows[e["symbol"]].get(T)
                if R is None:
                    continue
                j = np.flatnonzero(R["ts"] == ts)
                if len(j) != 1:
                    continue
                j = int(j[0])
                d[L.TL[T]] = {nm: [float(v) for v in R[nm][j]] for nm in ("fH", "f", "a")}
                d[L.TL[T]]["y"] = [int(v) for v in R["y"][j]]
            golden["rows"][oi][e["symbol"]] = d
    gp = os.path.join(HERE, "d12_golden.json")
    if os.path.exists(gp) and json.load(open(gp))["rows"] == json.loads(json.dumps(golden["rows"])):
        print("golden rows unchanged; d12_golden.json kept byte for byte")
    else:
        with open(gp, "w") as f:
            json.dump(golden, f, indent=0, sort_keys=True)
            f.write("\n")
    clim, v0, table = {}, {}, {}
    for T in L.TS:                                   # D12-A2: climatology of every pooled level (secondaries only)
        for k in L.POOL_LV:
            for g in L.GROUPS:
                y = np.concatenate([rows[e["symbol"]][T]["y"][:, L.L8.index(k)].astype(float) for e in S
                                    if e["group"] == g and T in rows[e["symbol"]]])
                clim[L.gkey(T, k, g)] = float(y.mean())
        for g in L.GROUPS:                           # D12-A2: pooled shallow monitor prior variances
            ts, P_, Y_ = [], [], []
            for e in S:
                if e["group"] == g and T in rows[e["symbol"]]:
                    R_ = rows[e["symbol"]][T]
                    ts.append(R_["ts"])
                    P_.append(R_["fH"][:, list(L.POOL_J)].astype(float))
                    Y_.append(R_["y"][:, list(L.POOL_J)].astype(float))
            ts, P_, Y_ = np.concatenate(ts), np.concatenate(P_), np.concatenate(Y_)
            Rp = float(P_.sum() / Y_.sum())
            days, inv = np.unique(ts, return_inverse=True)
            Pd, Yd = np.bincount(inv, (P_ / Rp).sum(1)), np.bincount(inv, Y_.sum(1))
            v0[L.pkey(T, g)] = {"A": float(np.mean((Pd / L.R_BAND[1] - Yd) ** 2)),
                                "B": float(np.mean((Yd - Pd / L.R_BAND[0]) ** 2))}
            table[L.pkey(T, g)] = {"rows": int(len(ts)), "days": int(len(days)), "positives": int(Y_.sum()), "R": Rp}
            print(L.pkey(T, g), json.dumps(table[L.pkey(T, g)]))
    for (T, k) in L.CELLS:
        jl = L.L8.index(k)
        for g in L.GROUPS:
            gk = L.gkey(T, k, g)
            ts, p, y, pa = [], [], [], []
            for e in S:
                if e["group"] != g or T not in rows[e["symbol"]]:
                    continue
                R = rows[e["symbol"]][T]
                ts.append(R["ts"])
                p.append(R["fH"][:, jl].astype(float))
                y.append(R["y"][:, jl].astype(float))
                pa.append(R["a"][:, jl].astype(float))
            ts, p, y, pa = (np.concatenate(v) for v in (ts, p, y, pa))
            e_ = float(y.mean())
            clim[gk] = e_
            Rdev = float(p.sum() / y.sum())
            q = p / Rdev
            days, inv = np.unique(ts, return_inverse=True)
            Pd, Yd = np.bincount(inv, q), np.bincount(inv, y)
            v0[gk] = {"A": float(np.mean((Pd / L.R_BAND[1] - Yd) ** 2)), "B": float(np.mean((Yd - Pd / L.R_BAND[0]) ** 2))}
            bs = lambda c: float(np.sum((c - y) ** 2))   # noqa: E731
            table[gk] = {"rows": int(len(y)), "days": int(len(days)), "positives": int(y.sum()), "R": Rdev,
                         "BSS_vs_a": 1 - bs(p) / bs(pa), "BSS_vs_e": 1 - bs(p) / bs(np.full_like(y, e_)),
                         "first": C.iso(int(ts.min())), "last": C.iso(int(ts.max()))}
            print(gk, json.dumps(table[gk]))
    U = {"schema": "q26-touch-live/d12-universe/1",
         "what": "D12 universe: Binance ETHUSDT and BTCUSDT (group ETHBTC) and the 18 A2/A3 large caps of the R16.2/"
                 "R19.2 development pool (group LARGE). Paths are membrane-datasets development grids (sha256 checked "
                 "at every run). climatology = development frequency (e) per monitor group. v0 = plug-in prior "
                 "variance per monitor group and side (development days, p rescaled to pooled R = 1).",
         "series": S, "climatology": clim, "v0": v0, "devTable": table,
         "goldenSha256": hashlib.sha256(open(gp, "rb").read()).hexdigest(), "code": RD.git_sha()}
    with open(os.path.join(HERE, "d12_universe.json"), "w") as f:
        json.dump(U, f, indent=1)
        f.write("\n")
    n = sum(len(v) for o in golden["rows"].values() for v in o.values())
    print("golden rows (series x T):", n)


if __name__ == "__main__":
    main()
