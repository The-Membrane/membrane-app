"""Q26 R24 POST-HOC diagnostics (chosen after the registered R24 scores; not registered). DEVELOPMENT ONLY (seen data).

Question: can ANY correction fitted on all origins of the price series, using the R24 price features, lift the
near-line all-positions R to the 0.8-1.25 band? Three in-sample checks on label-period origins (no walk-forward, so
they are ceilings, not forecasts):
  P1  C2 fitted in-sample on label-period origins (all 18 levels).
  P2  saturated bin calibration: bins of u6 (pooled quantiles 0-50-80-95-99-100%) x standardised 24 h drop dn
      (0, 0-1, 1-2, > 2); per bin multiplier = sum y / sum p over the near levels (0.5-10%), all label-period origins.
  P3  per bin: share of near-line positives and positions, near-line R, and the all-origin near-level R.

  python3 r24_posthoc.py --datasets DS --scr SCR --out OUT
Aggregates only. No address or account id is written.
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

DAY = 86400
QE = (0.5, 0.8, 0.95, 0.99)
DNE = (0.0, 1.0, 2.0)


def main():
    ap = argparse.ArgumentParser()
    for k in ("datasets", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    a = ap.parse_args()
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    fit_lv = np.nonzero(-levels <= 0.30 + 1e-12)[0]
    near_lv = np.nonzero(-levels <= 0.10 + 1e-12)[0]
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    series = [str(x) for x in Z["series"]]
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    grids = {x: LB.read_iii(a.datasets, LB.SERIES[x][1]) for x in series}
    out = {"what": "Q26 R24 POST-HOC in-sample ceiling diagnostics (not registered); development, Polygon label B",
           "by_H": {}}
    for Hh in (6, 24):
        hj = LB.HS.index(Hh)
        Hs = Hh * 3600
        tab = []
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts = F[key + "ts"]
            o = np.argsort(ts)
            ts = ts[o]
            m = (ts >= U.T_LO) & (ts <= U.T_HI)
            st, g = grids[x]
            f = U.grid_feats(st, g["close"], ts[m])
            tab.append({"ts": ts[m], "P": F[key + "fH"][o][m].astype(float), "Y": F[key + "y"][o][m].astype(float),
                        "f": f, "fh_ts": ts, "fh": F[key + "fH"][o].astype(float)})
        # P1 in-sample C2
        zs, ys, fs = [], [], {k: [] for k in ("u6", "u24", "dn")}
        for T in tab:
            zs.append(U.logit(T["P"][:, fit_lv]).ravel())
            ys.append(T["Y"][:, fit_lv].ravel())
            for k in fs:
                fs[k].append(np.repeat(T["f"][k], len(fit_lv)))
        z, y = np.concatenate(zs), np.concatenate(ys)
        f = {k: np.concatenate(v) for k, v in fs.items()}
        X = U.design(z, f, "C2")
        ok = np.all(np.isfinite(X), axis=1)
        w, _, _ = U.fit_offset(X[ok], z[ok], y[ok], U.BOUNDS["C2"])
        # P2 bins
        u6all = np.concatenate([T["f"]["u6"] for T in tab])
        qe = np.quantile(u6all[np.isfinite(u6all)], QE)

        def bin_of(u6, dn):
            bu = np.searchsorted(qe, u6, side="right")
            bd = np.where(dn <= 0, 0, np.searchsorted(DNE, dn, side="left"))
            return np.where(np.isfinite(u6) & np.isfinite(dn), bu * 4 + bd, -1)
        nb = (len(QE) + 1) * 4
        bp, by = np.zeros(nb), np.zeros(nb)
        P1near = [0.0, 0.0]
        for T in tab:
            b = bin_of(T["f"]["u6"], T["f"]["dn"])
            okb = b >= 0
            bp += np.bincount(b[okb], weights=T["P"][okb][:, near_lv].sum(1), minlength=nb)
            by += np.bincount(b[okb], weights=T["Y"][okb][:, near_lv].sum(1), minlength=nb)
            fm = {k: v for k, v in T["f"].items()}
            pc = np.stack([U.apply(T["P"][:, j], fm, "C2", {"C2": w}) for j in near_lv], 1)
            P1near[0] += pc.sum()
            P1near[1] += T["Y"][:, near_lv].sum()
        mult = np.where(bp > 0, by / np.maximum(bp, 1e-12), 1.0)
        # positions
        sub = ~(hf0 < 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
            & (kX[:, hj] > -0.10)
        vi = np.nonzero(sub)[0]
        k = kX[vi, hj].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        pf = np.full(len(vi), np.nan)
        fe = {c: np.full(len(vi), np.nan) for c in ("u6", "u24", "dn")}
        for xi, x in enumerate(series):
            T = tab[xi]
            ts_x, fh_x = T["fh_ts"], T["fh"]
            m = np.nonzero(sx == xi)[0]
            tt = dv[m]
            j = np.searchsorted(ts_x, tt)
            jj = np.minimum(j, len(ts_x) - 1)
            nres = np.searchsorted(ts_x, tt - Hs, side="right")
            g = (j < len(ts_x)) & (ts_x[jj] == tt) & (nres >= 30)
            pf[m[g]] = N.interp(k[m[g]], levels, fh_x[jj[g]])
            st, gg = grids[x]
            fx = U.grid_feats(st, gg["close"], tt)
            for c in fe:
                fe[c][m] = fx[c]
        ok = np.isfinite(pf)
        k, pf, dv, sx = k[ok], pf[ok], dv[ok], sx[ok]
        fe = {c: v[ok] for c, v in fe.items()}
        yb = yB[vi[ok], hj].astype(float)
        bk = np.searchsorted([0.02, 0.05], -k, side="right")
        p1 = U.apply(pf, fe, "C2", {"C2": w})
        b = bin_of(fe["u6"], fe["dn"])
        p2 = np.where(b >= 0, np.minimum(1.0, pf * mult[np.maximum(b, 0)]), pf)
        e = {"P1_C2_insample_coef": [round(float(v), 4) for v in w],
             "P1_all_origin_near_levels_R": P1near[0] / P1near[1],
             "u6_bin_edges": [round(float(v), 3) for v in qe], "dn_bin_edges": list(DNE)}
        for nm, p in (("raw", pf), ("P1_C2_insample", p1), ("P2_bin_calibrated_insample", p2)):
            e[nm] = {B_: (round(float(p[bk == i].sum() / yb[bk == i].sum()), 3) if yb[bk == i].sum() else None)
                     for i, B_ in enumerate(("0-2%", "2-5%", "5-10%"))}
        rows = []
        for i in range(nb):
            m = b == i
            if not m.any() and by[i] == 0:
                continue
            rows.append({"bin_u6": int(i // 4), "bin_dn": int(i % 4), "near_positions": int(m.sum()),
                         "near_pos": int(yb[m].sum()), "near_R": (round(float(pf[m].sum() / yb[m].sum()), 3)
                                                                  if yb[m].sum() else None),
                         "allorigin_near_levels_R": (round(float(bp[i] / by[i]), 3) if by[i] else None),
                         "allorigin_pos": int(by[i])})
        e["P3_bins"] = rows
        e["near_pos_total"] = int(yb.sum())
        out["by_H"][f"{Hh}h"] = e
        print(Hh, json.dumps({kk: e[kk] for kk in ("raw", "P1_C2_insample", "P2_bin_calibrated_insample",
                                                   "P1_all_origin_near_levels_R")}), flush=True)
    os.makedirs(a.out, exist_ok=True)
    pth = os.path.join(a.out, "r24-posthoc.json")
    json.dump(out, open(pth, "w"), indent=1, default=float)
    import r111v3_gate as G
    if G.ADDR_RE.search(open(pth).read()):
        raise SystemExit("address pattern in output")
    print("wrote", pth)


if __name__ == "__main__":
    main()
