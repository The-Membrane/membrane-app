"""Q26 R26: an "act now" borrower trigger judged per position by hit rate and false alarms. DEVELOPMENT ONLY (seen).

Design, rules (R0 distance, R1 R12.7 already-through, R2 distance + vol state + 24 h drop, R3 R2 + crowding; OD the
TWAP-(fH) odds comparator), walk-forward budgets, metrics, intervals, null and judgement rules: membrane-board
design/q26-r26-act-now-trigger-2026-10-25.md (registered before any score of this script).

  python3 r26_actnow.py --datasets DS --scr SCR --out OUT [--nb 2000] [--nsim 500]

SCR holds the R11.1-v5 scratch rows-labels.npz and fh-dense.npz (Aave V3 Polygon, development). OUT receives
address-free aggregates only (r26-actnow.json). No address, account id, key or secret is read into the output.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402
import r23_nearline as N  # noqa: E402
import r24_uplift as U  # noqa: E402

DAY = 86400
T_LO, T_HI = LB.utc(LB.FIRST_ORIGIN), LB.utc(LB.LAST_ORIGIN)
QSTARTS = [LB.utc(dt.date(y, m, 1)) for y in range(2023, 2027) for m in (1, 4, 7, 10)]
QSTARTS = [q for q in QSTARTS if q <= T_HI]                       # 2023-Q1 .. 2026-Q3
QEND = T_HI + DAY
SPLIT = LB.utc(dt.date(2024, 11, 12))
HSET = (1, 6, 24)
COL = {1: 0, 6: 0, 24: 2}                                         # kX / yB / universe column
FH_H = {1: 6, 6: 6, 24: 24}                                       # (fH) horizon used as the OD score
RULES = ["R0", "R1", "R2", "R3", "OD"]
THR_RULES = ["R0", "R2", "R3", "OD"]
BUDGETS = ["B2", "B5", "BR1"]
DBK = ((0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 0.30))
DBN = ["0-2%", "2-5%", "5-10%", "10-30%"]
L_EPS = 0.0025
RIDGE = 1e-3
SEED_BOOT, SEED_NULL = 20261025, 7


# ---------------------------------------------------------------------------------------------------------------------
def logit_fit(X, y, ridge=RIDGE):
    """Ridge logistic on columns standardized with fit-window moments; intercept not penalised."""
    mu, sd = X.mean(0), X.std(0)
    sd = np.where(sd > 0, sd, 1.0)
    Xs = np.c_[np.ones(len(X)), (X - mu) / sd]
    w = np.zeros(Xs.shape[1])
    pen = np.r_[0.0, np.full(X.shape[1], ridge)] * len(y)
    for _ in range(60):
        q = 1 / (1 + np.exp(-np.clip(Xs @ w, -35, 35)))
        g = Xs.T @ (y - q) - pen * w
        Hm = (Xs * (q * (1 - q))[:, None]).T @ Xs + np.diag(pen) + 1e-9 * np.eye(len(w))
        step = np.linalg.solve(Hm, g)
        w += step
        if np.abs(step).max() < 1e-8:
            break
    return {"w": w, "mu": mu, "sd": sd}


def logit_score(m, X):
    return np.c_[np.ones(len(X)), (X - m["mu"]) / m["sd"]] @ m["w"]


def thr_fire(s_fit, s_new, b):
    """Fire on s_new >= tau, tau = the fit-window score that fires on a share b of fit rows."""
    if b <= 0 or len(s_fit) == 0:
        return np.zeros(len(s_new), bool), None
    srt = np.sort(s_fit)[::-1]
    tau = srt[min(len(srt) - 1, max(0, int(np.ceil(b * len(srt))) - 1))]
    return s_new >= tau, float(tau)


def metrics(f, y, j, mask):
    f, y = f[mask], y[mask]
    n = int(mask.sum())
    pos, fires, cau = int(y.sum()), int(f.sum()), int((f & y).sum())
    bw = n / 7.0
    jj = j[mask][f & y]
    out = {"n": n, "bw": round(bw, 1), "touches": pos, "fires": fires, "caught": cau,
           "recall": cau / pos if pos else None, "precision": cau / fires if fires else None,
           "fa_per_bw": (fires - cau) / bw if bw else None,
           "per_1000bw": {"alerts": 1000 * fires / bw if bw else None, "caught": 1000 * cau / bw if bw else None,
                          "missed": 1000 * (pos - cau) / bw if bw else None},
           "alerts_per_caught": fires / cau if cau else None}
    if len(jj):
        out["lead"] = {"hour1": float(np.mean(jj == 0)), "hours2_6": float(np.mean((jj >= 1) & (jj <= 5))),
                       "hours7_24": float(np.mean(jj >= 6)), "median_touch_hour": float(np.median(jj + 1))}
    return out


def r(v, d=4):
    return None if v is None else round(float(v), d)


# ---------------------------------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    for k in ("datasets", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    ap.add_argument("--nb", type=int, default=2000)
    ap.add_argument("--nsim", type=int, default=500)
    a = ap.parse_args()
    t0 = time.time()
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    series = [str(x) for x in Z["series"]]
    ns = len(series)
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    print(f"loaded {len(day):,} rows {time.time() - t0:.0f}s", flush=True)

    # crowding n10 (R24 definition: HF >= 1, single collateral, -10% < k6 < 0; origin data only)
    k6 = kX[:, 0]
    cm = ~(hf0 < 1.0) & (single >= 0) & np.isfinite(k6) & (k6 < 0) & (k6 > -0.10)
    ckey = single[cm].astype(np.int64) * 10**7 + day[cm] // DAY
    cu, cc = np.unique(ckey, return_counts=True)
    del k6, cm, ckey

    def crowd_of(xi, ts):
        q = int(xi) * 10**7 + np.asarray(ts, np.int64) // DAY
        jx = np.minimum(np.searchsorted(cu, q), len(cu) - 1)
        return np.where(cu[jx] == q, cc[jx], 0).astype(float)

    grids = {x: LB.read_iii(a.datasets, LB.SERIES[x][1]) for x in series}
    kfeat = {x: N.features(a.datasets, x, LB.SERIES[x][1]) for x in series}
    # vol-state tercile edges per series: u6 over all label-period 00:00Z origins of the grid
    vedges = {}
    for x in series:
        st, g = grids[x]
        ts_all = np.arange(T_LO, T_HI + 1, DAY, dtype=np.int64)
        u6a = U.grid_feats(st, g["close"], ts_all)["u6"]
        u6a = u6a[np.isfinite(u6a)]
        vedges[x] = np.quantile(u6a, [1 / 3, 2 / 3])

    out = {"what": "Q26 R26 act-now trigger (development, Aave V3 Polygon label B); design membrane-board "
                   "design/q26-r26-act-now-trigger-2026-10-25.md",
           "bootstrap": {"B": a.nb, "seed": SEED_BOOT, "kind": "pigeonhole two-way series x week; one-way week"},
           "null": {"nsim": a.nsim, "seed": SEED_NULL, "kind": "y* = 1(U <= p), one uniform per series x origin day"},
           "split_halves_utc": "2024-11-12", "scored": "2023-01-01 .. 2026-09-23", "by_H": {}}
    uni_cache = {}
    for Hh in HSET:
        hj = COL[Hh]
        Hs = Hh * 3600
        if hj not in uni_cache:
            sub = ~(hf0 < 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
                & (kX[:, hj] > -0.30)
            vi = np.nonzero(sub)[0]
            uni_cache[hj] = vi
        vi = uni_cache[hj]
        k = kX[vi, hj].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        n = len(vi)
        pf = np.full(n, np.nan)
        G0, S0 = np.full(n, np.nan), np.full(n, np.nan)
        u6, dn, cr = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
        vt = np.full(n, -1)
        y = np.zeros(n, bool)
        fj = np.full(n, -1)
        lab_ok = np.zeros(n, bool)
        Hf = FH_H[Hh]
        for xi, x in enumerate(series):
            key = f"{x}|{Hf}|"
            ts_x, fh_x = F[key + "ts"], F[key + "fH"]
            o = np.argsort(ts_x)
            ts_x, fh_x = ts_x[o], fh_x[o].astype(float)
            m = np.nonzero(sx == xi)[0]
            tt = dv[m]
            jx = np.searchsorted(ts_x, tt)
            jjx = np.minimum(jx, len(ts_x) - 1)
            have = (jx < len(ts_x)) & (ts_x[jjx] == tt)
            nres = np.searchsorted(ts_x, tt - Hf * 3600, side="right")
            g = have & (nres >= 30)
            pf[m[g]] = N.interp(k[m[g]], levels, fh_x[jjx[g]])
            kf = kfeat[x](tt)
            G0[m], S0[m] = kf["G0"], kf["S0"]
            st, gg = grids[x]
            fx = U.grid_feats(st, gg["close"], tt)
            u6[m], dn[m] = fx["u6"], fx["dn"]
            cr[m] = crowd_of(xi, tt)
            vt[m] = np.where(np.isfinite(fx["u6"]), np.searchsorted(vedges[x], fx["u6"]), -1)
            # label recomputation from the III low path (first touch hour)
            low, close = np.asarray(gg["low"], float), np.asarray(gg["close"], float)
            ud, inv = np.unique(tt, return_inverse=True)
            order = np.argsort(inv, kind="stable")
            bnd = np.searchsorted(inv[order], np.arange(len(ud) + 1))
            for di, t_or in enumerate(ud.tolist()):
                b0 = (t_or - st) // 3600
                if b0 - 1 < 0 or b0 + Hh > len(low):
                    continue
                lw = low[b0:b0 + Hh]
                g0 = close[b0 - 1]
                if not (np.isfinite(g0) and np.all(np.isfinite(lw))):
                    continue
                rows = m[order[bnd[di]:bnd[di + 1]]]
                line = g0 * (1.0 + k[rows])
                Mn = np.minimum.accumulate(lw)
                jt = np.searchsorted(-Mn, -line, side="left")
                hit = jt < Hh
                y[rows] = hit
                fj[rows] = np.where(hit, jt, -1)
                lab_ok[rows] = True
        if Hh in (6, 24):
            yb = yB[vi, hj]
            chk = lab_ok & (yb >= 0)
            mism = int((y[chk] != (yb[chk] == 1)).sum())
            print(f"H {Hh}: label check rows {int(chk.sum()):,} mismatches {mism}", flush=True)
            assert mism == 0, "label recomputation does not reproduce stored yB"
        miss_u6, miss_dn = int((~np.isfinite(u6)).sum()), int((~np.isfinite(dn)).sum())
        ok = np.isfinite(pf) & np.isfinite(G0) & np.isfinite(S0) & lab_ok
        sel = np.nonzero(ok)[0]
        k, sx, dv, pf, G0, S0, u6, dn, cr, vt, y, fj = (v[sel] for v in (k, sx, dv, pf, G0, S0, u6, dn, cr, vt, y, fj))
        miss_u6_s, miss_dn_s = int((~np.isfinite(u6)).sum()), int((~np.isfinite(dn)).sum())
        u6z, dnz = np.where(np.isfinite(u6), u6, 0.0), np.where(np.isfinite(dn), dn, 0.0)
        d = -k
        ell = np.log(d + L_EPS)
        c = np.log1p(cr)
        X2 = np.c_[ell, u6z, dnz, np.maximum(u6z, 0) * ell]
        X3 = np.c_[X2, c, c * ell]
        r1 = S0 <= G0 * (1.0 + k)
        n = len(k)
        ent = {"rows": n, "rows_before_feature_filter": int(len(vi)), "missing_u6_set_0": miss_u6_s,
               "missing_dn_set_0": miss_dn_s, "missing_u6_before_filter": miss_u6, "missing_dn_before_filter": miss_dn,
               "fh_horizon_used_for_OD": f"{Hf}h", "coef": {}, "budgets": {}}
        print(f"H {Hh}: universe {n:,} rows {time.time() - t0:.0f}s", flush=True)

        # ---- walk-forward ----
        fire = {(rl, b): np.zeros(n, bool) for rl in THR_RULES for b in BUDGETS}
        scored = np.zeros(n, bool)
        for qi, qs in enumerate(QSTARTS):
            qe = QSTARTS[qi + 1] if qi + 1 < len(QSTARTS) else QEND
            fm = (dv >= T_LO) & (dv + Hs <= qs)
            sm = (dv >= qs) & (dv < qe)
            scored |= sm
            m2 = logit_fit(X2[fm], y[fm].astype(float))
            m3 = logit_fit(X3[fm], y[fm].astype(float))
            qn = dt.datetime.fromtimestamp(qs, dt.timezone.utc).strftime("%Y-%m-%d")
            ent["coef"][qn] = {"R2_w_std": [r(v) for v in m2["w"]], "R3_w_std": [r(v) for v in m3["w"]],
                               "fit_rows": int(fm.sum()), "fit_touches": int(y[fm].sum())}
            sc = {"R0": -d, "R2": logit_score(m2, X2), "R3": logit_score(m3, X3), "OD": pf}
            bud = {"B2": float(np.mean(d[fm] <= 0.02)), "B5": float(np.mean(d[fm] <= 0.05)),
                   "BR1": float(np.mean(r1[fm]))}
            ent["budgets"][qn] = {b: r(v, 6) for b, v in bud.items()}
            for b, bv in bud.items():
                for rl in THR_RULES:
                    fq, _ = thr_fire(sc[rl][fm], sc[rl][sm], bv)
                    fire[(rl, b)][np.nonzero(sm)[0]] = fq
        fr1 = r1 & scored
        tw = U.TwoWay(sx, dv, ns, B=a.nb)

        def fset(rl, b):
            return fr1 if rl == "R1" else fire[(rl, b)]

        halves = {"all": scored, "first_half": scored & (dv < SPLIT), "second_half": scored & (dv >= SPLIT)}
        res = {}
        for b in BUDGETS:
            rb = {}
            for rl in RULES:
                f = fset(rl, b)
                e = {"by_period": {hn: metrics(f, y, fj, hm) for hn, hm in halves.items()}}
                fa = (f & ~y).astype(float)
                yy = y.astype(float)
                e["ci"] = {"recall": U.ratio_ci(tw, (f & y), yy, scored),
                           "precision": U.ratio_ci(tw, (f & y), f.astype(float), scored),
                           "fa_per_bw": U.ratio_ci(tw, 7 * fa, np.ones(n), scored)}
                e["by_distance"] = {}
                for bi, (lo, hi) in enumerate(DBK):
                    mb = scored & (d >= lo) & (d < hi)
                    e["by_distance"][DBN[bi]] = metrics(f, y, fj, mb)
                    if bi < 3:
                        e["by_distance"][DBN[bi]]["recall_ci"] = U.ratio_ci(tw, (f & y), yy, mb)
                e["by_vol_tercile"] = {f"t{t + 1}": metrics(f, y, fj, scored & (vt == t)) for t in range(3)}
                # series-day view
                sdk = sx.astype(np.int64) * 10**6 + dv // DAY
                mp = scored & y
                usd, inv = np.unique(sdk[mp], return_inverse=True)
                frac = np.bincount(inv, weights=f[mp].astype(float)) / np.bincount(inv)
                e["series_day"] = {"touch_series_days": int(len(usd)),
                                   "fire_series_days": int(len(np.unique(sdk[scored & f]))),
                                   "recall_sd_weighted": r(frac.mean()) if len(frac) else None}
                for refn in ("R0", "OD"):
                    if refn == rl:
                        continue
                    f0 = fset(refn, b)
                    dd = {}
                    for hn, hm in halves.items():
                        pos = y[hm].sum()
                        dd[hn] = {"recall_gain": r(((f & y)[hm].sum() - (f0 & y)[hm].sum()) / pos) if pos else None,
                                  "fa_ratio": r((f & ~y)[hm].sum() / (f0 & ~y)[hm].sum())
                                  if (f0 & ~y)[hm].sum() else None}
                    dd["all"]["gain_ci"] = U.ratio_ci(tw, (f & y).astype(float) - (f0 & y).astype(float), yy, scored)
                    dd["all"]["fa_ratio_ci"] = U.ratio_ci(tw, (f & ~y).astype(float), (f0 & ~y).astype(float), scored)
                    e[f"vs_{refn}"] = dd
                rb[rl] = e
            res[b] = rb
        ent["rules"] = res
        # ---- shared-path null (6 h and 24 h) ----
        if Hh in (6, 24) and a.nsim > 0:
            sdk = sx.astype(np.int64) * 10**6 + dv // DAY
            _, sdinv = np.unique(sdk, return_inverse=True)
            nsd = sdinv.max() + 1
            rng = np.random.default_rng(SEED_NULL)
            gains = {(rl, b): [] for b in BUDGETS for rl in RULES if rl != "OD"}
            sm = np.nonzero(scored)[0]
            pfs, sdi = pf[sm], sdinv[sm]
            fs = {(rl, b): fset(rl, b)[sm] for b in BUDGETS for rl in RULES}
            for _ in range(a.nsim):
                ys = rng.random(nsd)[sdi] <= pfs
                P = ys.sum()
                for b in BUDGETS:
                    cod = (fs[("OD", b)] & ys).sum()
                    for rl in RULES:
                        if rl == "OD":
                            continue
                        gains[(rl, b)].append(((fs[(rl, b)] & ys).sum() - cod) / P if P else np.nan)
            nb_ = {}
            for (rl, b), v in gains.items():
                v = np.array(v, float)
                v = v[np.isfinite(v)]
                obs = ent["rules"][b][rl]["vs_OD"]["all"]["recall_gain"]
                nb_.setdefault(b, {})[rl] = {"null_gain_vs_OD_q05_q50_q95": [r(np.quantile(v, q)) for q in (0.05, 0.5, 0.95)],
                                             "observed_gain_vs_OD": obs,
                                             "observed_above_null_q95": (obs is not None and obs > float(np.quantile(v, 0.95))),
                                             "valid": int(len(v))}
            ent["null"] = nb_
        out["by_H"][f"{Hh}h"] = ent
        print(f"H {Hh}: done {time.time() - t0:.0f}s", flush=True)
    out["judgement"] = judge(out)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "r26-actnow.json"), "w") as fo:
        json.dump(out, fo, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    print(json.dumps(out["judgement"], indent=1, default=str))


def beats(e, ref):
    v = e.get(f"vs_{ref}")
    if not v:
        return None
    g, ci, far = v["all"]["recall_gain"], v["all"]["gain_ci"].get("ci90_twoway"), v["all"]["fa_ratio"]
    return bool(g is not None and g >= 0.05 and ci is not None and ci[0] > 0 and far is not None and far <= 1.10)


def judge(out):
    J = {}
    for Hn, ent in out["by_H"].items():
        J[Hn] = {}
        for b in BUDGETS:
            J[Hn][b] = {rl: {"beats_R0": beats(ent["rules"][b][rl], "R0"), "beats_OD": beats(ent["rules"][b][rl], "OD"),
                             "recall": ent["rules"][b][rl]["by_period"]["all"]["recall"]}
                        for rl in RULES}
    cand = [rl for rl in ("R1", "R2", "R3", "OD") if J["6h"]["B2"][rl]["beats_R0"]]
    best = max(cand, key=lambda rl: J["6h"]["B2"][rl]["recall"] or -1) if cand else None
    stable = None
    if best:
        stable = all(out["by_H"][Hn]["rules"]["B2"][best]["vs_R0"][hv]["recall_gain"] is not None
                     and out["by_H"][Hn]["rules"]["B2"][best]["vs_R0"][hv]["recall_gain"] > 0
                     for Hn in ("6h", "24h") for hv in ("first_half", "second_half"))
    J["primary_6h_B2"] = {"rules_beating_R0": cand, "best_rule": best, "best_stable_both_halves_6h_24h": stable}
    return J


if __name__ == "__main__":
    main()
