"""Q26 R23: cause of the near-line under-warning of TWAP-(fH) on label B, and a tested fix. DEVELOPMENT ONLY (seen data).

Design, hypotheses, tests, fix menu and repair rule: membrane-board design/q26-r23-nearline-underwarning-2026-10-25.md
(registered at board baef8d5 before any score of this script).

  python3 r23_nearline.py --datasets DS --scr SCR --out OUT

SCR holds the R11.1-v5 scratch rows-labels.npz and fh-dense.npz (Aave V3 Polygon, development). OUT receives
address-free aggregates only (r23-nearline.json). No address, account id, key or secret is written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402

HS = LB.HS                                   # (6, 12, 24, 72, 168)
DAY = 86400
NEAR = ((0.0, 0.02), (0.02, 0.05), (0.05, 0.10))
FAR = ((0.10, 0.20), (0.20, 0.30))
BKS = NEAR + FAR
BNAMES = ["0-2%", "2-5%", "5-10%", "10-20%", "20-30%"]
SPLIT = int(dt.datetime(2024, 6, 20, tzinfo=dt.timezone.utc).timestamp())
T_LO = LB.utc(LB.FIRST_ORIGIN)
T_HI = LB.utc(LB.LAST_ORIGIN)
KLINES = {"WETH": "binance-klines/ETHUSDT-1h.json", "WBTC": "binance-klines/BTCUSDT-1h.json",
          "LINK": "binance-klines/LINKUSDT-1h.json", "AAVE": "final-blind-prices/binance-AAVEUSDT-1h.json"}
SEED = 20261024
NB = 1000
THRU = -0.005


# ---------------------------------------------------------------------------------------------------------------------
# probability interpolation (vectorized copy of LB.interp_logp, checked against it)
# ---------------------------------------------------------------------------------------------------------------------
def interp(k, levels, P, extrap=False):
    x = np.log1p(np.asarray(k, float))
    X = np.log1p(np.asarray(levels, float))
    lp = np.log(np.maximum(np.asarray(P, float), 1e-7))
    j = np.searchsorted(-X, -x)
    jc = np.clip(j, 1, len(X) - 1)
    w = (x - X[jc - 1]) / (X[jc] - X[jc - 1])
    r = np.arange(len(x))
    mid = lp[r, jc - 1] + w * (lp[r, jc] - lp[r, jc - 1])
    out = np.where(j <= 0, lp[:, 0], np.where(j >= len(X), lp[:, -1], mid))
    if extrap:   # H3 clamp alternative: extend ln p in ln(1+k) with the 0.5%-1% slope for |k| < 0.5%, cap 1
        s = (lp[:, 1] - lp[:, 0]) / (X[1] - X[0])
        out = np.where(j <= 0, lp[:, 0] + s * (x - X[0]), out)
    return np.minimum(np.exp(out), 1.0)


# ---------------------------------------------------------------------------------------------------------------------
# statistics
# ---------------------------------------------------------------------------------------------------------------------
def week_groups(day):
    wk = (np.asarray(day) // DAY - 4) // 7
    _, inv = np.unique(wk, return_inverse=True)
    return inv


def boot(day, cols, stat, B=NB, seed=SEED):
    """Weekly-block bootstrap. cols: dict of per-row arrays summed per week; stat(sums) -> float or nan.
    -> (5%, 95%) and validity counts."""
    g = week_groups(day)
    ng = g.max() + 1 if len(g) else 0
    S = {k: np.bincount(g, weights=np.asarray(v, float), minlength=ng) for k, v in cols.items()}
    rng = np.random.default_rng(seed)
    vals, drop = [], 0
    for _ in range(B):
        c = np.bincount(rng.integers(0, ng, ng), minlength=ng).astype(float)
        v = stat({k: float(c @ s) for k, s in S.items()})
        if v is None or not np.isfinite(v):
            drop += 1
        else:
            vals.append(v)
    ci = [float(np.quantile(vals, 0.05)), float(np.quantile(vals, 0.95))] if vals else None
    return ci, {"kept": len(vals), "dropped": drop}


def r_stat(s):
    return s["p"] / s["y"] if s["y"] > 0 else None


def r_block(day, p, y):
    p, y = np.asarray(p, float), np.asarray(y, float)
    out = {"n": int(len(y)), "pos": int(y.sum()), "R": float(p.sum() / y.sum()) if y.sum() else None}
    if y.sum() >= 1:
        out["ci90"], out["boot"] = boot(day, {"p": p, "y": y}, r_stat)
    return out


def bss_block(day, y, p, q):
    """BSS of p against q with weekly-block interval."""
    y, p, q = (np.asarray(v, float) for v in (y, p, q))
    bp, bq = np.mean((p - y) ** 2), np.mean((q - y) ** 2)
    ci, cnt = boot(day, {"a": (p - y) ** 2, "b": (q - y) ** 2},
                   lambda s: 1 - s["a"] / s["b"] if s["b"] > 0 else None)
    return {"bss": float(1 - bp / bq) if bq > 0 else None, "ci90": ci, "boot": cnt}


def auc_block(day, y, p, q, B=NB, seed=SEED):
    """AUC of p and of q, and the AUC difference with a weekly-block interval."""
    y = np.asarray(y, bool)
    out = {"auc": LB.auc(p, y), "auc_ref": LB.auc(q, y)}
    if out["auc"] is None or out["auc_ref"] is None:
        return out
    g = week_groups(day)
    groups = [np.nonzero(g == i)[0] for i in range(g.max() + 1)]
    rng = np.random.default_rng(seed)
    d, drop = [], 0
    for _ in range(B):
        ii = np.concatenate([groups[j] for j in rng.integers(0, len(groups), len(groups))])
        a1, a2 = LB.auc(p[ii], y[ii]), LB.auc(q[ii], y[ii])
        if a1 is None or a2 is None:
            drop += 1
        else:
            d.append(a1 - a2)
    out["diff"] = out["auc"] - out["auc_ref"]
    out["diff_ci90"] = [float(np.quantile(d, 0.05)), float(np.quantile(d, 0.95))] if d else None
    out["boot"] = {"kept": len(d), "dropped": drop}
    return out


def logit(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def logit_fit(X, y, ridge=1e-6):
    w = np.zeros(X.shape[1])
    for _ in range(50):
        q = 1 / (1 + np.exp(-np.clip(X @ w, -35, 35)))
        g = X.T @ (y - q) - ridge * w
        Hm = (X * (q * (1 - q))[:, None]).T @ X + ridge * np.eye(X.shape[1])
        step = np.linalg.solve(Hm, g)
        w += step
        if np.abs(step).max() < 1e-9:
            break
    return w


# ---------------------------------------------------------------------------------------------------------------------
# price features per series and daily origin
# ---------------------------------------------------------------------------------------------------------------------
def features(datasets, x, sym):
    st_g, g = LB.read_iii(datasets, sym)
    gc = np.asarray(g["close"], float)
    d = json.load(open(os.path.join(datasets, KLINES[x])))
    st_k = int(d["startTs"])
    kc = np.array([np.nan if v is None else float(v) for v in d["columns"]["close"]])

    def at(ts):
        ts = np.asarray(ts, np.int64)
        bg = (ts - st_g) // 3600 - 1
        bk = (ts - st_k) // 3600 - 1

        def take(arr, i):
            ok = (i >= 0) & (i < len(arr))
            return np.where(ok, arr[np.clip(i, 0, len(arr) - 1)], np.nan)
        G0 = take(gc, bg)
        S0 = take(kc, bk)
        f = {"G0": G0, "S0": S0, "gap": np.log(S0 / G0)}
        for h in (1, 6, 24):
            f[f"r{h}"] = np.log(S0 / take(kc, bk - h))
        return f
    return at


# ---------------------------------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    for k in ("datasets", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    a = ap.parse_args()
    t0 = time.time()
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    series = [str(x) for x in Z["series"]]
    day, hf0, single = Z["day"], Z["hf0"], Z["singleX"]
    kX, yB, fc, actf = Z["kX"], Z["yB"], Z["fc_min"], Z["act_first"]
    sdebt, nvol = Z["stable_debt"], Z["nvol"]
    print(f"loaded {len(day):,} rows {time.time() - t0:.0f}s", flush=True)
    feat_fn = {x: features(a.datasets, x, LB.SERIES[x][1]) for x in series}
    near_lv = np.nonzero(np.abs(levels) <= 0.10)[0]
    out = {"what": "Q26 R23 near-line under-warning cause and fix (development, Aave V3 Polygon label B); "
                   "design membrane-board design/q26-r23-nearline-underwarning-2026-10-25.md",
           "split_utc": "2024-06-20T00:00Z", "bootstrap": {"B": NB, "seed": SEED, "blocks": "ISO-like weeks of origin day"},
           "by_H": {}}
    # interpolation check against the reference implementation
    rng0 = np.random.default_rng(1)
    kk_t = -rng0.uniform(0.0, 0.6, 500)
    P_t = np.sort(rng0.uniform(0, 1, (500, len(levels))), axis=1)[:, ::-1]
    assert np.allclose(interp(kk_t, levels, P_t), LB.interp_logp(kk_t, levels, P_t), rtol=1e-12, atol=0)

    for hj, Hh in enumerate(HS):
        Hs = Hh * 3600
        sub = ~(hf0 < 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
            & (kX[:, hj] > -0.30)
        vi = np.nonzero(sub)[0]
        n = len(vi)
        k = kX[vi, hj].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        pf, pa, pe, pfx, pk = (np.full(n, np.nan) for _ in range(5))
        fe = {c: np.full(n, np.nan) for c in ("G0", "S0", "gap", "r1", "r6", "r24")}
        # per-series origin tables for terciles and benchmarks
        bench = {}
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts_x, fh_x, a_x, y_x = F[key + "ts"], F[key + "fH"], F[key + "a"], F[key + "y"].astype(float)
            o = np.argsort(ts_x)
            ts_x, fh_x, a_x, y_x = ts_x[o], fh_x[o].astype(float), a_x[o].astype(float), y_x[o]
            cs = np.cumsum(y_x, axis=0)
            m = np.nonzero(sx == xi)[0]
            tt = dv[m]
            j = np.searchsorted(ts_x, tt)
            jj = np.minimum(j, len(ts_x) - 1)
            have = (j < len(ts_x)) & (ts_x[jj] == tt)
            nres = np.searchsorted(ts_x, tt - Hs, side="right")
            clim = np.where((nres > 0)[:, None], cs[np.maximum(nres - 1, 0)] / np.maximum(nres, 1)[:, None], np.nan)
            g = have & (nres >= 30)
            mg = m[g]
            pf[mg] = interp(k[mg], levels, fh_x[jj[g]])
            pa[mg] = interp(k[mg], levels, a_x[jj[g]])
            pe[mg] = interp(k[mg], levels, np.maximum(clim[g], 1e-7))
            pfx[mg] = interp(k[mg], levels, fh_x[jj[g]], extrap=True)
            ff = feat_fn[x](tt)
            for c in fe:
                fe[c][m] = ff[c]
            G0, S0 = ff["G0"][g], ff["S0"][g]
            keff = (1.0 + k[mg]) * G0 / S0 - 1.0
            pk[mg] = interp(np.minimum(keff, -1e-9), levels, fh_x[jj[g]])
            # origin table (label period) for terciles and benchmark
            om = (ts_x >= T_LO) & (ts_x <= T_HI)
            fo = feat_fn[x](ts_x[om])
            bench[xi] = {"fh": fh_x[om], "y": y_x[om], "f": fo, "ts": ts_x[om]}
        ok = np.isfinite(pf) & np.isfinite(pa) & np.isfinite(pe)
        sel = np.nonzero(ok)[0]
        vi, k, sx, dv = vi[sel], k[sel], sx[sel], dv[sel]
        pf, pa, pe, pfx, pk = pf[sel], pa[sel], pe[sel], pfx[sel], pk[sel]
        fe = {c: v[sel] for c, v in fe.items()}
        keff = (1.0 + k) * fe["G0"] / fe["S0"] - 1.0
        pk = np.where(np.isfinite(pk), pk, pf)       # missing kline hour: keep (fH) at k (counted below)
        yb = yB[vi, hj].astype(float)
        yA = ((fc[vi] >= 0) & (fc[vi] < Hh * 60)).astype(float)
        act = (actf[vi] > 0) & (actf[vi] <= dv + Hs)
        absk = -k
        bk = np.full(len(k), -1)
        for bi, (lo, hi) in enumerate(BKS):
            bk[(absk >= lo) & (absk < hi)] = bi
        cell = np.round(absk / 0.0025).astype(np.int64)
        keyd = sx.astype(np.int64) * 10**12 + (dv // DAY) * 10**5 + cell
        _, first = np.unique(keyd, return_index=True)
        _, last_r = np.unique(keyd[::-1], return_index=True)
        last = len(keyd) - 1 - last_r
        mF = np.zeros(len(k), bool)
        mF[first] = True
        mL = np.zeros(len(k), bool)
        mL[last] = True
        nearF = mF & (bk >= 0) & (bk <= 2)
        ent = {"rows_scored": int(len(k)), "paths_cell_first": int(mF.sum()),
               "kline_missing_rows": int((~np.isfinite(fe["S0"])).sum())}

        # ---- baseline (reproduces D-R11.1t) ----
        ent["baseline"] = {BNAMES[b]: r_block(dv[mF & (bk == b)], pf[mF & (bk == b)], yb[mF & (bk == b)])
                           for b in range(len(BKS))}
        ent["baseline"]["near_0-10%"] = r_block(dv[nearF], pf[nearF], yb[nearF])

        # ---- benchmark weights (near-line cell-first paths, nearest ladder level 0.5..10%) ----
        lvl_abs = -levels[near_lv]
        W = np.zeros((len(series), len(near_lv)))
        for i in np.nonzero(nearF)[0].tolist():
            W[sx[i], int(np.argmin(np.abs(lvl_abs - absk[i])))] += 1

        def strat(fname):
            """near-line R by per-series tercile of feature fname, with the level-matched all-origin benchmark."""
            res = {}
            tb_paths = np.full(len(k), -1)
            ball = np.zeros((3, 2))
            share_all = np.zeros(3)
            for xi in range(len(series)):
                B_ = bench[xi]
                fv = B_["f"][fname]
                okf = np.isfinite(fv)
                if okf.sum() < 30:
                    continue
                edges = np.quantile(fv[okf], [1 / 3, 2 / 3])
                tb_o = np.where(okf, np.searchsorted(edges, fv), -1)
                mi = sx == xi
                fp = fe[fname][mi]
                tb_paths[mi] = np.where(np.isfinite(fp), np.searchsorted(edges, fp), -1)
                for t in range(3):
                    mo = tb_o == t
                    ball[t, 0] += (B_["fh"][mo][:, near_lv].sum(0) * W[xi]).sum()
                    ball[t, 1] += (B_["y"][mo][:, near_lv].sum(0) * W[xi]).sum()
                    share_all[t] += mo.sum()
            share_all = share_all / max(share_all.sum(), 1)
            nf = nearF & (tb_paths >= 0)
            for t in range(3):
                m = nf & (tb_paths == t)
                res[f"t{t + 1}"] = {"near_share": float(m.sum() / max(nf.sum(), 1)), "all_share": float(share_all[t]),
                                    "near": r_block(dv[m], pf[m], yb[m]),
                                    "near_by_bucket": {BNAMES[b]: r_block(dv[m & (bk == b)], pf[m & (bk == b)],
                                                                          yb[m & (bk == b)]) for b in range(3)},
                                    "all_origins_level_matched_R": float(ball[t, 0] / ball[t, 1]) if ball[t, 1] else None}
            return res, tb_paths

        # ---- H1 ----
        g_near = fe["gap"][nearF]
        g_all = np.concatenate([bench[xi]["f"]["gap"] for xi in bench])
        g_all = g_all[np.isfinite(g_all)]
        g_near = g_near[np.isfinite(g_near)]
        qs = (0.05, 0.25, 0.5, 0.75, 0.95)
        h1 = {"gap_quantiles_near": {str(q): float(np.quantile(g_near, q)) for q in qs},
              "gap_quantiles_all_origins": {str(q): float(np.quantile(g_all, q)) for q in qs},
              "gap_neg_share_near": float((g_near < 0).mean()), "gap_neg_share_all": float((g_all < 0).mean())}
        h1["by_gap_tercile"], tb_gap = strat("gap")
        thru = mF & (keff >= THRU) & (bk >= 0) & (bk <= 2)
        h1["keff_corrected"] = {BNAMES[b]: r_block(dv[mF & (bk == b)], pk[mF & (bk == b)], yb[mF & (bk == b)])
                                for b in range(len(BKS))}
        h1["keff_corrected"]["near_0-10%"] = r_block(dv[nearF], pk[nearF], yb[nearF])
        h1["already_through_paths_near"] = {"n": int(thru.sum()), "pos": int(yb[thru].sum()),
                                            "touch_rate": float(yb[thru].mean()) if thru.any() else None,
                                            "mean_p_fH": float(pf[thru].mean()) if thru.any() else None}
        ent["H1"] = h1
        # ---- H2 ----
        ent["H2"] = {}
        tb_r = {}
        for c in ("r1", "r6", "r24"):
            ent["H2"][c], tb_r[c] = strat(c)
        # ---- H3 ----
        h3 = {"cell_first": ent["baseline"]["near_0-10%"],
              "cell_last": r_block(dv[mL & (bk >= 0) & (bk <= 2)], pf[mL & (bk >= 0) & (bk <= 2)],
                                   yb[mL & (bk >= 0) & (bk <= 2)])}
        nb = (bk >= 0) & (bk <= 2)
        h3["all_positions"] = r_block(dv[nb], pf[nb], yb[nb])
        h3["by_bucket"] = {}
        for b in range(3):
            m = bk == b
            e = {"cell_first": ent["baseline"][BNAMES[b]], "cell_last": r_block(dv[mL & m], pf[mL & m], yb[mL & m]),
                 "all_positions": r_block(dv[m], pf[m], yb[m])}
            # series-day weighted: one unit per series x origin x bucket
            kd = sx[m].astype(np.int64) * 10**7 + dv[m] // DAY
            u, inv = np.unique(kd, return_inverse=True)
            cnt = np.bincount(inv)
            mp_ = np.bincount(inv, weights=pf[m]) / cnt
            my_ = np.bincount(inv, weights=yb[m]) / cnt
            dd = (u % 10**7) * DAY
            e["series_day_weighted"] = r_block(dd, mp_, my_)
            Rs = []
            for s_ in range(1, 6):
                rr = np.random.default_rng(s_).permutation(len(k))
                _, fi = np.unique(keyd[rr], return_index=True)
                mR = np.zeros(len(k), bool)
                mR[rr[fi]] = True
                mm = mR & m
                Rs.append(r_block(dv[mm], pf[mm], yb[mm]))
            e["cell_random_5_seeds"] = {"R_mean": float(np.mean([r["R"] for r in Rs if r["R"]])),
                                        "R_range": [float(min(r["R"] for r in Rs if r["R"])),
                                                    float(max(r["R"] for r in Rs if r["R"]))],
                                        "ci90_per_seed": [r.get("ci90") for r in Rs]}
            h3["by_bucket"][BNAMES[b]] = e
        m05 = mF & (absk < 0.005)
        m052 = mF & (absk >= 0.005) & (absk < 0.02)
        h3["clamp"] = {"lt_0.5%": r_block(dv[m05], pf[m05], yb[m05]), "0.5-2%": r_block(dv[m052], pf[m052], yb[m052]),
                       "0-2%_extrapolated": r_block(dv[mF & (bk == 0)], pfx[mF & (bk == 0)], yb[mF & (bk == 0)])}
        ent["H3"] = h3
        # ---- H4 ----
        simple = sdebt[vi] & (nvol[vi] <= 1)
        h4 = {"simple_share_of_scored": float(simple.mean()), "by_bucket": {}}
        for b in range(3):
            m = mF & (bk == b)
            h4["by_bucket"][BNAMES[b]] = {"labelB": ent["baseline"][BNAMES[b]],
                                          "labelA_same_paths": r_block(dv[m], pf[m], yA[m]),
                                          "labelB_no_action": r_block(dv[m & ~act], pf[m & ~act], yb[m & ~act]),
                                          "agree_A_B": float((yA[m] == yb[m]).mean()) if m.any() else None}
        ent["H4"] = h4

        # ---- fixes, two-way walk-forward ----
        fixes = {"fH": pf.copy(), "F1": pk.copy(), "F2": np.full(len(k), np.nan), "F3": np.full(len(k), np.nan)}
        fitinfo = {}
        for half, (sc_m, fit_m) in {"early": (dv < SPLIT, dv >= SPLIT + 7 * DAY),
                                    "late": (dv >= SPLIT, dv + Hs <= SPLIT)}.items():
            # F2: already-through floor q from the fit half
            th_fit = mF & fit_m & (keff >= THRU)
            q = float(yb[th_fit].mean()) if th_fit.sum() else 0.0
            p2 = np.where(keff >= THRU, np.maximum(pk, q), pk)
            fixes["F2"][sc_m] = p2[sc_m]
            # F3: logistic on fit-half near paths
            fm = nearF & fit_m & np.isfinite(fe["r24"]) & np.isfinite(fe["gap"])
            X = np.c_[np.ones(fm.sum()), logit(pf[fm]), fe["r24"][fm], fe["gap"][fm]]
            w = logit_fit(X, yb[fm])
            r24 = np.where(np.isfinite(fe["r24"]), fe["r24"], 0.0)
            gp = np.where(np.isfinite(fe["gap"]), fe["gap"], 0.0)
            z = w[0] + w[1] * logit(pf) + w[2] * r24 + w[3] * gp
            p3 = 1 / (1 + np.exp(-np.clip(z, -35, 35)))
            fixes["F3"][sc_m] = p3[sc_m]
            fitinfo[f"scored_{half}"] = {"F2_q": q, "F2_fit_paths": int(th_fit.sum()),
                                         "F3_coef_a_b_r24_gap": [float(v) for v in w], "F3_fit_paths": int(fm.sum()),
                                         "F3_fit_pos": int(yb[fm].sum())}
        fx = {"fit": fitinfo, "by_bucket": {}}
        for b in range(len(BKS)):
            m = mF & (bk == b)
            eb = {}
            for nm, p in fixes.items():
                d_ = {"R": r_block(dv[m], p[m], yb[m])}
                if b <= 2 and yb[m].sum() >= 5:
                    d_["bss_vs_fH"] = bss_block(dv[m], yb[m], p[m], pf[m]) if nm != "fH" else None
                    d_["bss_vs_a"] = bss_block(dv[m], yb[m], p[m], pa[m])
                    d_["bss_vs_e"] = bss_block(dv[m], yb[m], p[m], pe[m])
                    d_["auc_vs_fH"] = auc_block(dv[m], yb[m], p[m], pf[m]) if nm != "fH" else {"auc": LB.auc(p[m], yb[m])}
                    d_["auc_vs_a"] = {"auc": LB.auc(p[m], yb[m]), "auc_a": LB.auc(pa[m], yb[m]),
                                      "auc_e": LB.auc(pe[m], yb[m])}
                for half, hm in (("early", dv < SPLIT), ("late", dv >= SPLIT)):
                    d_[f"R_{half}"] = r_block(dv[m & hm], p[m & hm], yb[m & hm])
                eb[nm] = d_
            fx["by_bucket"][BNAMES[b]] = eb
        ent["fixes"] = fx
        out["by_H"][f"{Hh}h"] = ent
        bl = ent["baseline"]
        print(f"H {Hh}: base R " + " ".join(f"{BNAMES[b]} {bl[BNAMES[b]]['R']}" for b in range(3))
              + f" | {time.time() - t0:.0f}s", flush=True)
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "r23-nearline.json")
    with open(p, "w") as f:
        json.dump(out, f, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    import r111v3_gate as G
    if G.ADDR_RE.search(open(p).read()):
        raise SystemExit("address pattern in output")
    print("wrote", p, f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
