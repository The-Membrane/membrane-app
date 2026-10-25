"""Q26 R23 POST-HOC diagnostic (not registered; report only, development). After the registered H3 result (series-day
weighting brings 6 h near-line R near 1), this asks whether near-line crowding on a series-day marks the under-forecast
days. Crowding = number of label-B position rows with 0 < |k| < 10% on that series and origin day (all rows).

  python3 r23_posthoc.py --scr SCR --out OUT
Uses the same scored set and (fH) interpolation as r23_nearline.py. Address-free aggregates only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402
import r23_nearline as N  # noqa: E402

DAY = 86400


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scr", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    series = [str(x) for x in Z["series"]]
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    out = {"what": "Q26 R23 post-hoc crowding diagnostic (NOT registered; report only; development, Polygon label B)",
           "by_H": {}}
    for hj, Hh in enumerate((6, 12, 24)):
        Hs = Hh * 3600
        sub = ~(hf0 < 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
            & (kX[:, hj] > -0.10)
        vi = np.nonzero(sub)[0]
        k = kX[vi, hj].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        pf = np.full(len(vi), np.nan)
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts_x, fh_x = F[key + "ts"], F[key + "fH"]
            o = np.argsort(ts_x)
            ts_x, fh_x = ts_x[o], fh_x[o].astype(float)
            m = np.nonzero(sx == xi)[0]
            j = np.searchsorted(ts_x, dv[m])
            jj = np.minimum(j, len(ts_x) - 1)
            nres = np.searchsorted(ts_x, dv[m] - Hs, side="right")
            g = (j < len(ts_x)) & (ts_x[jj] == dv[m]) & (nres >= 30)
            pf[m[g]] = N.interp(k[m[g]], levels, fh_x[jj[g]])
        ok = np.isfinite(pf)
        k, sx, dv, pf, yb = k[ok], sx[ok], dv[ok], pf[ok], yB[vi[ok], hj].astype(float)
        sd = sx.astype(np.int64) * 10**7 + dv // DAY
        u, inv = np.unique(sd, return_inverse=True)
        crowd = np.bincount(inv)[inv]
        keyd = sd * 10**5 + np.round(-k / 0.0025).astype(np.int64)
        _, first = np.unique(keyd, return_index=True)
        mF = np.zeros(len(k), bool)
        mF[first] = True
        e = {"series_days": int(len(u))}
        cu = np.bincount(inv)
        edges = np.quantile(cu, [1 / 3, 2 / 3])
        tb = np.searchsorted(edges, crowd, side="right")
        e["crowding_edges_positions"] = [float(x) for x in edges]
        for t in range(3):
            m = mF & (tb == t)
            e[f"crowd_t{t + 1}"] = {"series_days": int((np.searchsorted(edges, cu, side="right") == t).sum()),
                                   "cell_first": N.r_block(dv[m], pf[m], yb[m])}
        # concentration: share of near-line cell-first positives on the 10 series-days with most positives
        pos_day = np.bincount(inv[mF], weights=yb[mF], minlength=len(u))
        top = np.sort(pos_day)[::-1]
        e["positives_cell_first"] = int(yb[mF].sum())
        e["series_days_with_positive"] = int((pos_day > 0).sum())
        e["top10_series_days_share_of_positives"] = float(top[:10].sum() / max(top.sum(), 1))
        p_day = np.bincount(inv[mF], weights=pf[mF], minlength=len(u))
        it = np.argsort(pos_day)[::-1][:10]
        e["top10_R"] = float(p_day[it].sum() / pos_day[it].sum())
        rest = np.ones(len(u), bool)
        rest[it] = False
        e["rest_R"] = float(p_day[rest].sum() / pos_day[rest].sum())
        e["top10_years"] = sorted(int(1970 + (u[i] % 10**7) * DAY / (365.2425 * DAY)) for i in it)
        out["by_H"][f"{Hh}h"] = e
        print(Hh, json.dumps(e), flush=True)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "r23-posthoc-crowding.json"), "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
