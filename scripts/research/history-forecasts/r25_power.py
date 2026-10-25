"""Q26 R25 power for a confirmation step (outcome-free: uses the arms' probabilities and the position distances only).

Question: if an arm's probability were exactly true, how often would a confirmation set of a given calendar length
pass the R25 near-line cells (R between 0.8 and 1.25)? Labels are simulated from the arm's own p with the shared-path
rule (one uniform per series x origin day). Calendar length is varied by resampling whole weeks of the Polygon
development positions (2023-01 .. 2026-09). No observed label enters any number here.

  python3 r25_power.py --datasets DS --scr SCR --out OUT
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402
import r23_nearline as N  # noqa: E402
import r24_uplift as U  # noqa: E402
import r25_bincal as R  # noqa: E402

DAY = R.DAY
SEED = 20261026
NSIM = 2000
WEEKS = (50, 100, 195)


def main():
    ap = argparse.ArgumentParser()
    for k in ("datasets", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    a = ap.parse_args()
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    bl = R.band_levels(levels)
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    series = [str(x) for x in Z["series"]]
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    k6 = kX[:, 0]
    act = ~(hf0 < 1.0) & (single >= 0) & np.isfinite(k6) & (k6 < 0)
    near = act & (k6 > -0.10)
    au, ac = np.unique(single[act].astype(np.int64) * 10**7 + day[act] // DAY, return_counts=True)
    nu, nc = np.unique(single[near].astype(np.int64) * 10**7 + day[near] // DAY, return_counts=True)

    def crowd_of(xi, ts):
        q = int(xi) * 10**7 + np.asarray(ts, np.int64) // DAY
        j = np.minimum(np.searchsorted(nu, q), len(nu) - 1)
        cnt = np.where(nu[j] == q, nc[j], 0).astype(float)
        j2 = np.minimum(np.searchsorted(au, q), len(au) - 1)
        nact = np.where(au[j2] == q, ac[j2], 0).astype(float)
        return cnt, np.where(nact > 0, cnt / np.maximum(nact, 1), 0.0)

    grids = {x: LB.read_iii(a.datasets, LB.SERIES[x][1]) for x in series}
    q_lo, q_hi = int(R.qidx([R.SCORE_LO])[0]), int(R.qidx([R.T_HI])[0])
    rng = np.random.default_rng(SEED)
    out = {"what": "R25 confirmation power under 'arm p is true' (outcome-free), shared-path labels, week resampling "
                   "of Polygon development positions", "nsim": NSIM, "seed": SEED, "by_H": {}}
    for hj, Hh in ((0, 6), (2, 24)):
        Hs = Hh * 3600
        tab = []
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts = F[key + "ts"]
            o = np.argsort(ts)
            ts = ts[o]
            m = (ts >= R.T_LO) & (ts <= R.T_HI)
            ts = ts[m]
            P = F[key + "fH"][o][m].astype(float)
            Y = F[key + "y"][o][m].astype(float)       # fit rows of the walk-forward tables only (as R25)
            st, g = grids[x]
            f = U.grid_feats(st, g["close"], ts)
            cnt, shr = crowd_of(xi, ts)
            T = {"ts": ts, "pb": R.parent_bin(f["u6"], f["dn"]), "cbB": R.crowd_bin("B", cnt, shr),
                 "cbC": R.crowd_bin("C", cnt, shr)}
            T["SP"] = np.stack([P[:, bl[b]].sum(1) for b in range(3)], 1)
            T["SY"] = np.stack([Y[:, bl[b]].sum(1) for b in range(3)], 1)
            tab.append(T)
        tabs_q = {q: R.fit_tables(tab, Hs, q) for q in range(q_lo, q_hi + 1)}
        sub = ~(hf0 < 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
            & (kX[:, hj] > -0.10) & (day >= R.SCORE_LO) & (day <= R.T_HI)
        vi = np.nonzero(sub)[0]
        k = kX[vi, hj].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        pf = np.full(len(vi), np.nan)
        pb = np.full(len(vi), -1)
        cbB = np.zeros(len(vi), int)
        cbC = np.zeros(len(vi), int)
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts_x, fh_x = F[key + "ts"], F[key + "fH"]
            o = np.argsort(ts_x)
            ts_x, fh_x = ts_x[o], fh_x[o].astype(float)
            m = np.nonzero(sx == xi)[0]
            tt = dv[m]
            j = np.searchsorted(ts_x, tt)
            jj = np.minimum(j, len(ts_x) - 1)
            nres = np.searchsorted(ts_x, tt - Hs, side="right")
            g = (j < len(ts_x)) & (ts_x[jj] == tt) & (nres >= 30)
            pf[m[g]] = N.interp(k[m[g]], levels, fh_x[jj[g]])
            st, gg = grids[x]
            fx = U.grid_feats(st, gg["close"], tt)
            pb[m] = R.parent_bin(fx["u6"], fx["dn"])
            c, s = crowd_of(xi, tt)
            cbB[m], cbC[m] = R.crowd_bin("B", c, s), R.crowd_bin("C", c, s)
        ok = np.isfinite(pf)
        k, sx, dv, pf, pb, cbB, cbC = (v[ok] for v in (k, sx, dv, pf, pb, cbB, cbC))
        bk = np.searchsorted([0.02, 0.05], -k, side="right")
        qv = R.qidx(dv)
        sdk = sx.astype(np.int64) * 10**7 + dv // DAY
        usd, sdinv = np.unique(sdk, return_inverse=True)
        wk = (dv // DAY - 4) // 7
        uw, winv = np.unique(wk, return_inverse=True)
        sd_week = np.zeros(len(usd), int)
        sd_week[sdinv] = winv
        res = {"weeks_dev": int(len(uw)), "series_days": int(len(usd))}
        for arm in ("A", "B", "C"):
            p = np.minimum(1.0, pf * R.mult_of(tabs_q, arm, qv, bk, pb, cbB, cbC))
            # per series-day sums of p by bucket, and per series-day sorted p for the shared-path draw
            o = np.lexsort((-p, sdinv))
            ps, ss, bs = p[o], sdinv[o], bk[o]
            ea = {}
            for W in WEEKS:
                cell_ok = np.zeros((NSIM, 3), bool)
                pooled_ok = np.zeros(NSIM, bool)
                for s in range(NSIM):
                    wsel = rng.integers(0, len(uw), W)
                    cw = np.bincount(wsel, minlength=len(uw)).astype(float)
                    wsd = cw[sd_week]                     # weight per series-day (week multiplicity)
                    u = rng.random(len(usd))
                    ys = (u[ss] < ps).astype(float)       # one uniform per series-day
                    w = wsd[ss]
                    num = np.bincount(bs, weights=w * ps, minlength=3)
                    den = np.bincount(bs, weights=w * ys, minlength=3)
                    with np.errstate(divide="ignore", invalid="ignore"):
                        r = num / den
                        rp = num.sum() / den.sum()
                    cell_ok[s] = (r >= R.R_BAND[0]) & (r <= R.R_BAND[1])
                    pooled_ok[s] = R.R_BAND[0] <= rp <= R.R_BAND[1]
                ea[f"{W}w"] = {"cell_pass": [round(float(v), 3) for v in cell_ok.mean(0)],
                               "all3_pass": round(float(cell_ok.all(1).mean()), 3),
                               "pooled_0_10_pass": round(float(pooled_ok.mean()), 3)}
            res[arm] = ea
        out["by_H"][R.TL[Hh]] = res
        print(Hh, json.dumps(res), flush=True)
    os.makedirs(a.out, exist_ok=True)
    U.dump(out, os.path.join(a.out, "r25-power.json"))


if __name__ == "__main__":
    main()
