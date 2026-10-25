"""Q26 R24: a conditional vol-state correction of TWAP-(fH) for the near-line under-warning. DEVELOPMENT ONLY (seen data).

Design, candidates (C1 vol state, C2 + 24 h drop, C3 + crowding; F1 add-on), walk-forward fit, statistics, null and
repair rule: membrane-board design/q26-r24-conditional-uplift-2026-10-25.md (registered at board 6fb1b7d before any
score of this script).

  python3 r24_uplift.py --datasets DS --scr SCR --r195 R195ROWS --out OUT

SCR holds the R11.1-v5 scratch rows-labels.npz and fh-dense.npz (Aave V3 Polygon, development). R195ROWS is the R19.5
rows-r195.npz (input I = Binance spot (fH) of the 20 D12 series). OUT receives address-free aggregates only
(r24-uplift.json). No address, account id, key or secret is read into the output or written.
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
from scipy.optimize import minimize  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402
import r23_nearline as N  # noqa: E402

HS = LB.HS                                     # (6, 12, 24, 72, 168)
TL = {6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d"}
DAY = 86400
BKS = ((0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 0.30))
BNAMES = ["0-2%", "2-5%", "5-10%", "10-20%", "20-30%"]
T_LO, T_HI = LB.utc(LB.FIRST_ORIGIN), LB.utc(LB.LAST_ORIGIN)
HALVES = [LB.utc(dt.date(y, m, 1)) for y in range(2022, 2027) for m in (1, 7)]   # 2022-01-01 .. 2026-07-01
SEED_BOOT, NB = 20261025, 2000
SEED_NULL, NSIM = 7, 2000
P_CLIP = 1e-5
S_MAX = 0.45
U_CLIP = 2.0
DN_MAX = 6.0
RIDGE = 1e-6
MIN_C3_DAYS = 180
FIT_LV_MAX = 0.30
GUARD_TOL = 0.02
R_BAND = (0.8, 1.25)
ARMS = ["raw", "C1", "C2", "C3", "F1", "C1+F1", "C2+F1", "C3+F1"]
D12_SYMS_ETHBTC = ("ETHUSDT", "BTCUSDT")


# ---------------------------------------------------------------------------------------------------------------------
# price features
# ---------------------------------------------------------------------------------------------------------------------
def grid_feats(st, close, ts):
    """Per origin ts (hour boundary): u6, u24 (clipped log RV ratios to RV720), dn (standardised 24 h drop).
    Uses only bars that close at or before ts. NaN where fewer than 80% of returns are finite."""
    c = np.asarray(close, float)
    lr = np.r_[np.nan, np.diff(np.log(c))]
    fin = np.isfinite(lr)
    CS = np.r_[0.0, np.cumsum(np.where(fin, lr * lr, 0.0))]
    CN = np.r_[0, np.cumsum(fin)]
    b = (np.asarray(ts, np.int64) - st) // 3600           # bar that opens at ts; returns lr[b-n .. b-1]

    def rv(n):
        ok = (b - n >= 1) & (b <= len(lr))
        bb = np.clip(b, n + 1, len(lr))
        s, k = CS[bb] - CS[bb - n], CN[bb] - CN[bb - n]
        return np.where(ok & (k >= 0.8 * n), np.sqrt(s / np.maximum(k, 1)), np.nan)
    r6, r24, r720 = rv(6), rv(24), rv(720)
    with np.errstate(invalid="ignore", divide="ignore"):
        u6 = np.clip(np.log(r6 / r720), -U_CLIP, U_CLIP)
        u24 = np.clip(np.log(r24 / r720), -U_CLIP, U_CLIP)

        def take(i):
            ok = (i >= 0) & (i < len(c))
            return np.where(ok, c[np.clip(i, 0, len(c) - 1)], np.nan)
        ret24 = np.log(take(b - 1) / take(b - 25))
        dn = np.minimum(DN_MAX, np.maximum(0.0, -ret24) / (r720 * np.sqrt(24.0)))
    u6 = np.where(np.isfinite(r6) & np.isfinite(r720) & (r720 > 0), u6, np.nan)
    u24 = np.where(np.isfinite(r24) & np.isfinite(r720) & (r720 > 0), u24, np.nan)
    return {"u6": u6, "u24": u24, "dn": dn, "rv6r": r6 / r720}


def logit(p):
    q = np.clip(np.asarray(p, float), P_CLIP, 1 - P_CLIP)
    return np.log(q / (1 - q))


def sig(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def design(z, f, arm):
    """Columns of the correction for arm in C1/C2/C3 (C3 uses the C2 columns; c is added in stage 2)."""
    u6p = np.maximum(f["u6"], 0.0)
    ell = np.maximum(-z, 0.0)
    cols = [np.ones_like(z), f["u6"], f["u24"], u6p * ell]
    if arm in ("C2", "C3"):
        cols.append(f["dn"])
    return np.stack(cols, axis=1)


BOUNDS = {"C1": [(None, None), (0, None), (0, None), (0, S_MAX)],
          "C2": [(None, None), (0, None), (0, None), (0, S_MAX), (0, None)]}


def fit_offset(X, z, y, bounds):
    n = len(y)

    def f(w):
        zp = z + X @ w
        ll = np.logaddexp(0.0, zp) - y * zp
        g = X.T @ (sig(zp) - y) / n + 2 * RIDGE * w
        return ll.mean() + RIDGE * w @ w, g
    r = minimize(f, np.zeros(X.shape[1]), jac=True, method="L-BFGS-B", bounds=bounds,
                 options={"maxiter": 500, "gtol": 1e-10, "ftol": 1e-14})
    return r.x, bool(r.success), float(r.fun)


def fit_c(zoff, cr, y):
    n = len(y)

    def f(w):
        zp = zoff + w[0] * cr
        ll = np.logaddexp(0.0, zp) - y * zp
        return ll.mean() + RIDGE * w[0] ** 2, np.array([np.mean((sig(zp) - y) * cr) + 2 * RIDGE * w[0]])
    r = minimize(f, np.zeros(1), jac=True, method="L-BFGS-B", bounds=[(0, None)])
    return float(r.x[0]), bool(r.success)


def apply(p, f, arm, coef, cr=None):
    """p' for arm given coefficients; p' = p where a feature is missing."""
    if arm == "raw":
        return np.asarray(p, float)
    z = logit(p)
    base = "C2" if arm == "C3" else arm
    X = design(z, f, base)
    zp = z + X @ coef[base]
    if arm == "C3":
        zp = zp + coef["c"] * cr
    ok = np.all(np.isfinite(X), axis=1)
    return np.where(ok, sig(zp), p)


# ---------------------------------------------------------------------------------------------------------------------
# walk-forward fit on all origins x levels of a set of series
# ---------------------------------------------------------------------------------------------------------------------
def walk_forward(tab, Hh, crowd_ok):
    """tab: list of dicts per series: ts (n), P (n x L), Y (n x L), f (features per origin), cr (n) or None.
    -> {half_start: {"C1": w, "C2": w, "c": c, ...}}"""
    Hs = Hh * 3600
    out = {}
    for a in HALVES:
        Z, Y, F, CR, LP = [], [], {k: [] for k in ("u6", "u24", "dn")}, [], []
        for T in tab:
            m = (T["ts"] + Hs <= a)
            if not m.any():
                continue
            nl = T["P"].shape[1]
            Z.append(logit(T["P"][m]).ravel())
            Y.append(T["Y"][m].astype(float).ravel())
            for k in F:
                F[k].append(np.repeat(T["f"][k][m], nl))
            CR.append(np.repeat(T["cr"][m] if T["cr"] is not None else np.full(m.sum(), np.nan), nl))
            LP.append(np.repeat(T["ts"][m] >= T_LO, nl))
        z = np.concatenate(Z)
        y = np.concatenate(Y)
        f = {k: np.concatenate(v) for k, v in F.items()}
        cr = np.concatenate(CR)
        lp = np.concatenate(LP)
        e = {"fit_rows": int(len(y)), "fit_pos": int(y.sum())}
        for arm in ("C1", "C2"):
            X = design(z, f, arm)
            ok = np.all(np.isfinite(X), axis=1)
            w, succ, fun = fit_offset(X[ok], z[ok], y[ok], BOUNDS[arm])
            e[arm] = w
            e[arm + "_ok"] = succ
            e[arm + "_rows"] = int(ok.sum())
        e["c"] = 0.0
        if crowd_ok:
            X = design(z, f, "C2")
            ok = np.all(np.isfinite(X), axis=1) & lp & np.isfinite(cr)
            ndays = len(np.unique(np.concatenate([T["ts"][(T["ts"] + Hs <= a) & (T["ts"] >= T_LO)] for T in tab])))
            e["c3_days"] = int(ndays)
            if ndays >= MIN_C3_DAYS and ok.sum():
                zoff = z[ok] + X[ok] @ e["C2"]
                e["c"], e["c_ok"] = fit_c(zoff, cr[ok], y[ok])
        out[a] = e
    return out


def half_of(ts):
    return np.searchsorted(np.array(HALVES), np.asarray(ts), side="right") - 1


def coef_at(wf, hidx):
    return wf[HALVES[hidx]]


def apply_wf(p, f, arm, wf, ts, cr=None):
    """Apply walk-forward coefficients by the half-year of each origin; origins before the first half keep p."""
    out = np.array(p, float, copy=True)
    hi = half_of(ts)
    for h in np.unique(hi):
        if h < 0:
            continue
        m = hi == h
        fm = {k: v[m] for k, v in f.items()}
        out[m] = apply(np.asarray(p)[m], fm, arm, coef_at(wf, h), None if cr is None else cr[m])
    return out


# ---------------------------------------------------------------------------------------------------------------------
# statistics
# ---------------------------------------------------------------------------------------------------------------------
class TwoWay:
    """Pigeonhole two-way bootstrap (series x week) and one-way week bootstrap with fixed draws shared across arms."""

    def __init__(self, sid, day, ns, seed=SEED_BOOT, B=NB):
        wk = (np.asarray(day) // DAY - 4) // 7
        uw, self.w = np.unique(wk, return_inverse=True)
        self.s = np.asarray(sid, int)
        self.ns, self.nw = ns, len(uw)
        rng = np.random.default_rng(seed)
        self.cs = np.stack([np.bincount(rng.integers(0, ns, ns), minlength=ns) for _ in range(B)]).astype(float)
        self.cw = np.stack([np.bincount(rng.integers(0, self.nw, self.nw), minlength=self.nw)
                            for _ in range(B)]).astype(float)
        self.cell = self.s * self.nw + self.w

    def sums(self, v, mask):
        return np.bincount(self.cell[mask], weights=np.asarray(v, float)[mask],
                           minlength=self.ns * self.nw).reshape(self.ns, self.nw)

    def draws(self, S, two=True):
        if two:
            return np.einsum("bs,sw,bw->b", self.cs, S, self.cw)
        return self.cw @ S.sum(0)

    def weights(self, b, two=True):
        ws = self.cs[b][self.s] if two else 1.0
        return ws * self.cw[b][self.w]


def ratio_ci(tw, num, den, mask, f=lambda a, b: a / b):
    out = {}
    Sn, Sd = tw.sums(num, mask), tw.sums(den, mask)
    for nm, two in (("ci90_twoway", True), ("ci90_week", False)):
        a, b = tw.draws(Sn, two), tw.draws(Sd, two)
        with np.errstate(invalid="ignore", divide="ignore"):
            v = f(a, b)
        ok = np.isfinite(v) & (b > 0)
        out[nm] = [float(np.quantile(v[ok], 0.05)), float(np.quantile(v[ok], 0.95))] if ok.any() else None
        out[nm.replace("ci90", "valid")] = {"kept": int(ok.sum()), "dropped": int((~ok).sum())}
    return out


def r_block(tw, p, y, mask):
    y_ = y[mask]
    e = {"n": int(mask.sum()), "pos": int(y_.sum()), "R": float(p[mask].sum() / y_.sum()) if y_.sum() else None}
    if y_.sum():
        e.update(ratio_ci(tw, p, y, mask))
    return e


def bss_block(tw, y, p, q, mask):
    a, b = (p - y) ** 2, (q - y) ** 2
    e = {"bss": float(1 - a[mask].sum() / b[mask].sum())}
    e.update(ratio_ci(tw, a, b, mask, f=lambda u, v: 1 - u / v))
    return e


def wauc(y, inv, ng, w):
    """Weighted AUC with ties averaged; inv = rank-group index of p (ascending)."""
    w1 = np.bincount(inv, weights=w * y, minlength=ng)
    w0 = np.bincount(inv, weights=w * (1 - y), minlength=ng)
    W1, W0 = w1.sum(), w0.sum()
    if W1 <= 0 or W0 <= 0:
        return np.nan
    below = np.r_[0.0, np.cumsum(w0)[:-1]]
    return float((w1 * (below + 0.5 * w0)).sum() / (W1 * W0))


def auc_diff(tw, y, p, q, mask, B=500):
    """AUC of p and q and the difference with two-way and week intervals (first B shared draws)."""
    y_ = y[mask].astype(float)
    _, ip = np.unique(p[mask], return_inverse=True)
    _, iq = np.unique(q[mask], return_inverse=True)
    npg, nqg = ip.max() + 1, iq.max() + 1
    one = np.ones(len(y_))
    e = {"auc": wauc(y_, ip, npg, one), "auc_raw": wauc(y_, iq, nqg, one)}
    e["diff"] = e["auc"] - e["auc_raw"]
    sm, wm = tw.s[mask], tw.w[mask]
    for nm, two in (("ci90_twoway", True), ("ci90_week", False)):
        d = []
        for b in range(B):
            w = (tw.cs[b][sm] if two else 1.0) * tw.cw[b][wm]
            d.append(wauc(y_, ip, npg, w) - wauc(y_, iq, nqg, w))
        d = np.array(d)
        ok = np.isfinite(d)
        e[nm] = [float(np.quantile(d[ok], 0.05)), float(np.quantile(d[ok], 0.95))] if ok.any() else None
        e[nm.replace("ci90", "valid")] = {"kept": int(ok.sum()), "dropped": int((~ok).sum())}
    return e


def null_band(p_by_arm, sdinv, nsd, bk, nb, seed=SEED_NULL, nsim=NSIM, chunk=100):
    """Shared-path null: one uniform per series-day decides every position of it. Same U for all arms.
    -> {arm: {bucket: [q05, q50, q95]}}"""
    rng = np.random.default_rng(seed)
    acc = {a: [[] for _ in range(nb)] for a in p_by_arm}
    done = 0
    while done < nsim:
        m = min(chunk, nsim - done)
        U = rng.random((m, nsd))[:, sdinv]                 # m x n
        for a, p in p_by_arm.items():
            ys = (U < p[None, :])
            for b in range(nb):
                sel = bk == b
                if not sel.any():
                    continue
                sy = ys[:, sel].sum(1)
                with np.errstate(divide="ignore", invalid="ignore"):
                    acc[a][b].extend((p[sel].sum() / sy).tolist())
        done += m
    out = {}
    for a in acc:
        out[a] = {}
        for b in range(nb):
            v = np.array(acc[a][b], float)
            v = v[np.isfinite(v)]
            out[a][BNAMES[b]] = {"q05_q50_q95": [float(np.quantile(v, q)) for q in (0.05, 0.5, 0.95)] if len(v) else None,
                                 "valid": int(len(v)), "dropped": int(nsim - len(v))}
    return out


# ---------------------------------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    for k in ("datasets", "scr", "r195", "out"):
        ap.add_argument(f"--{k}", required=True)
    ap.add_argument("--nsim", type=int, default=NSIM)
    ap.add_argument("--skip-d12", action="store_true")
    ap.add_argument("--only-d12", action="store_true", help="refit (deterministic), add the D12 block to OUT json")
    a = ap.parse_args()
    t0 = time.time()
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    fit_lv = np.nonzero(-levels <= FIT_LV_MAX + 1e-12)[0]        # 0.5% .. 30% (18 levels)
    near_lv = np.nonzero(-levels <= 0.10 + 1e-12)[0]
    far_lv = np.nonzero((-levels > 0.10 + 1e-12) & (-levels <= FIT_LV_MAX + 1e-12))[0]
    assert len(fit_lv) == 18 and len(near_lv) == 12 and len(far_lv) == 6
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    series = [str(x) for x in Z["series"]]
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    print(f"loaded {len(day):,} rows {time.time() - t0:.0f}s", flush=True)

    # crowding n10 per (series, origin day): HF >= 1, single collateral, -10% < k < 0 at the 6 h column (no label use)
    k6 = kX[:, 0]
    cm = ~(hf0 < 1.0) & (single >= 0) & np.isfinite(k6) & (k6 < 0) & (k6 > -0.10)
    ckey = single[cm].astype(np.int64) * 10**7 + day[cm] // DAY
    cu, cc = np.unique(ckey, return_counts=True)
    del k6, cm, ckey

    def crowd_of(xi, ts):
        q = int(xi) * 10**7 + np.asarray(ts, np.int64) // DAY
        j = np.minimum(np.searchsorted(cu, q), len(cu) - 1)
        v = np.where(cu[j] == q, cc[j], 0).astype(float)
        return np.where((np.asarray(ts) >= T_LO) & (np.asarray(ts) <= T_HI + DAY), np.log1p(v), np.nan)

    # III grids and feature tables per series
    grids = {x: LB.read_iii(a.datasets, LB.SERIES[x][1]) for x in series}
    kfeat = {x: N.features(a.datasets, x, LB.SERIES[x][1]) for x in series}
    out = {"what": "Q26 R24 conditional vol-state correction of TWAP-(fH) (development, Aave V3 Polygon label B); "
                   "design membrane-board design/q26-r24-conditional-uplift-2026-10-25.md (registered 6fb1b7d)",
           "bootstrap": {"B": NB, "seed": SEED_BOOT, "kind": "pigeonhole two-way series x week; one-way week"},
           "null": {"nsim": a.nsim, "seed": SEED_NULL, "kind": "one uniform per series x origin day"},
           "by_H": {}, "coef": {}}
    wf_by_H = {}
    for hj, Hh in enumerate(HS):
        Hs = Hh * 3600
        tab = []
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts_x = F[key + "ts"]
            o = np.argsort(ts_x)
            ts_x = ts_x[o]
            st, g = grids[x]
            fx = grid_feats(st, g["close"], ts_x)
            tab.append({"x": x, "xi": xi, "ts": ts_x, "P": F[key + "fH"][o][:, fit_lv].astype(float),
                        "Y": F[key + "y"][o][:, fit_lv], "f": fx, "cr": crowd_of(xi, ts_x),
                        "Pall": F[key + "fH"][o].astype(float), "Yall": F[key + "y"][o].astype(float)})
        wf = walk_forward(tab, Hh, crowd_ok=True)
        wf_by_H[Hh] = wf
        out["coef"][TL[Hh]] = {dt.datetime.fromtimestamp(h, dt.timezone.utc).strftime("%Y-%m-%d"):
                               {"C1_a_b6_b24_s": [round(float(v), 5) for v in e["C1"]],
                                "C2_a_b6_b24_s_d": [round(float(v), 5) for v in e["C2"]],
                                "C3_c": round(float(e["c"]), 5), "c3_days": e.get("c3_days"),
                                "ok": [e["C1_ok"], e["C2_ok"], e.get("c_ok")],
                                "fit_rows": e["fit_rows"], "fit_pos": e["fit_pos"]} for h, e in wf.items()}
        print(f"H {Hh}: fitted {time.time() - t0:.0f}s; last C1 {np.round(wf[HALVES[-1]]['C1'], 3)} "
              f"C2 {np.round(wf[HALVES[-1]]['C2'], 3)} c {wf[HALVES[-1]]['c']:.3f}", flush=True)
        if a.only_d12:
            continue

        # ---- all-origin guard (label period) ----
        guard = {}
        for arm in ("raw", "C1", "C2", "C3"):
            Pn, Yn, Pf, Yf, Po, Yo = 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
            lvP, lvY = np.zeros(len(levels)), np.zeros(len(levels))
            for T in tab:
                m = (T["ts"] >= T_LO) & (T["ts"] <= T_HI)
                fm = {k: v[m] for k, v in T["f"].items()}
                P = T["Pall"][m]
                Pc = np.stack([apply_wf(P[:, j], fm, arm, wf, T["ts"][m], T["cr"][m]) for j in range(len(levels))], 1)
                Y = T["Yall"][m]
                lvP += Pc.sum(0)
                lvY += Y.sum(0)
                Pn += Pc[:, near_lv].sum()
                Yn += Y[:, near_lv].sum()
                Pf += Pc[:, far_lv].sum()
                Yf += Y[:, far_lv].sum()
                rr = T["f"]["rv6r"][m]
                okr = np.isfinite(rr)
                ed = np.quantile(rr[okr], 2 / 3)
                om = okr & (rr <= ed)
                Po += Pc[om][:, near_lv].sum()
                Yo += Y[om][:, near_lv].sum()
            guard[arm] = {"near_levels_R": Pn / Yn, "far_levels_R": Pf / Yf if Yf else None,
                          "ordinary_origins_near_levels_R": Po / Yo,
                          "per_level_R": {f"{-levels[j] * 100:g}%": (round(float(lvP[j] / lvY[j]), 3) if lvY[j] else None)
                                          for j in fit_lv},
                          "pos_near": int(Yn), "pos_far": int(Yf)}
        # ---- scored positions ----
        sub = ~(hf0 < 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
            & (kX[:, hj] > -0.30)
        vi = np.nonzero(sub)[0]
        k = kX[vi, hj].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        pf, pk = np.full(len(vi), np.nan), np.full(len(vi), np.nan)
        fe = {c: np.full(len(vi), np.nan) for c in ("u6", "u24", "dn")}
        cr = np.full(len(vi), np.nan)
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts_x, fh_x, y_x = F[key + "ts"], F[key + "fH"], F[key + "y"].astype(float)
            o = np.argsort(ts_x)
            ts_x, fh_x = ts_x[o], fh_x[o].astype(float)
            m = np.nonzero(sx == xi)[0]
            tt = dv[m]
            j = np.searchsorted(ts_x, tt)
            jj = np.minimum(j, len(ts_x) - 1)
            have = (j < len(ts_x)) & (ts_x[jj] == tt)
            nres = np.searchsorted(ts_x, tt - Hs, side="right")
            g = have & (nres >= 30)
            mg = m[g]
            pf[mg] = N.interp(k[mg], levels, fh_x[jj[g]])
            kf = kfeat[x](tt[g])
            keff = (1.0 + k[mg]) * kf["G0"] / kf["S0"] - 1.0
            pk_ = N.interp(np.minimum(np.where(np.isfinite(keff), keff, k[mg]), -1e-9), levels, fh_x[jj[g]])
            pk[mg] = np.where(np.isfinite(keff), pk_, pf[mg])
            st, gg = grids[x]
            fx = grid_feats(st, gg["close"], tt)
            for c in fe:
                fe[c][m] = fx[c]
            cr[m] = crowd_of(xi, tt)
        ok = np.isfinite(pf)
        vi, k, sx, dv, pf, pk, cr = vi[ok], k[ok], sx[ok], dv[ok], pf[ok], pk[ok], cr[ok]
        fe = {c: v[ok] for c, v in fe.items()}
        yb = yB[vi, hj].astype(float)
        absk = -k
        bk = np.full(len(k), -1)
        for bi, (lo, hi) in enumerate(BKS):
            bk[(absk >= lo) & (absk < hi)] = bi
        P = {"raw": pf, "F1": pk}
        for arm in ("C1", "C2", "C3"):
            P[arm] = apply_wf(pf, fe, arm, wf, dv, cr)
            P[arm + "+F1"] = apply_wf(pk, fe, arm, wf, dv, cr)
        tw = TwoWay(sx, dv, len(series))
        ent = {"rows_scored": int(len(k)), "feature_missing_rows": int((~np.isfinite(fe["u6"])).sum()),
               "guard_all_origins": guard, "arms": {}}
        for arm in ARMS:
            p = P[arm]
            e = {"R": {BNAMES[b]: r_block(tw, p, yb, bk == b) for b in range(len(BKS))}}
            e["R"]["near_0-10%"] = r_block(tw, p, yb, (bk >= 0) & (bk <= 2))
            allm = bk >= 0
            if arm != "raw":
                e["bss_vs_raw_all"] = bss_block(tw, yb, p, pf, allm)
                e["bss_vs_raw_near"] = bss_block(tw, yb, p, pf, (bk >= 0) & (bk <= 2))
                e["auc_all"] = auc_diff(tw, yb, p, pf, allm)
                e["auc_near"] = auc_diff(tw, yb, p, pf, (bk >= 0) & (bk <= 2))
            else:
                e["auc_all"] = {"auc": LB.auc(p[allm], yb[allm])}
            for nm, hm in (("2022-03..2022-12", dv < LB.utc(dt.date(2023, 1, 1))),
                           ("2023-01..2026-09", dv >= LB.utc(dt.date(2023, 1, 1)))):
                e[f"R_{nm}"] = {BNAMES[b]: r_block(tw, p, yb, (bk == b) & hm) for b in range(3)}
            ent["arms"][arm] = e
        # null band on near buckets
        nm_ = (bk >= 0) & (bk <= 2)
        sdk = sx[nm_].astype(np.int64) * 10**7 + dv[nm_] // DAY
        _, sdinv = np.unique(sdk, return_inverse=True)
        ent["null"] = null_band({arm: P[arm][nm_] for arm in ARMS}, sdinv, sdinv.max() + 1, bk[nm_], 3,
                                nsim=a.nsim)
        out["by_H"][TL[Hh]] = ent
        rr = {arm: [round(ent["arms"][arm]["R"][BNAMES[b]]["R"], 3) for b in range(3)] for arm in ARMS}
        print(f"H {Hh}: near R {json.dumps(rr)} | {time.time() - t0:.0f}s", flush=True)
        if Hh == 6:
            exp = (0.6707, 0.5029, 0.3643)
            got = rr["raw"]
            if any(abs(g_ - e_) > 0.005 for g_, e_ in zip(got, exp)):
                raise SystemExit(f"STOP: raw 6 h all-positions R {got} does not reproduce {exp}")

    os.makedirs(a.out, exist_ok=True)
    pth = os.path.join(a.out, "r24-uplift.json")
    if a.only_d12:
        coef = out["coef"]
        out = json.load(open(pth))
        assert json.loads(json.dumps(coef)) == out["coef"], "refit coefficients differ from the saved run"
    else:
        out["rule"] = rule(out)                  # ---- repair rule ----
        dump(out, pth)
    if not a.skip_d12:                           # ---- D12 cells ----
        out["d12"] = d12(a, wf_by_H)
    dump(out, pth)
    print("wrote", pth, f"{time.time() - t0:.0f}s")


def dump(out, pth):
    with open(pth, "w") as f:
        json.dump(out, f, indent=1, default=lambda o: o.item() if hasattr(o, "item") else
                  (o.tolist() if isinstance(o, np.ndarray) else str(o)))
    import r111v3_gate as G
    if G.ADDR_RE.search(open(pth).read()):
        raise SystemExit("address pattern in output")


def rule(out):
    res = {}
    for arm in ARMS[1:]:
        base_arm = arm
        cells, fails = {}, []
        for H in ("6h", "1d"):
            ent = out["by_H"][H]
            for b in BNAMES[:3]:
                R = ent["arms"][arm]["R"][b]["R"]
                q = ent["null"][arm][b]["q05_q50_q95"]
                ok = R is not None and R_BAND[0] <= R <= R_BAND[1] and q is not None and q[0] <= R <= q[2]
                cells[f"{H} {b}"] = {"R": R, "null": q, "pass": bool(ok)}
                if not ok:
                    fails.append(f"near {H} {b}")
        report_cells = {}
        for H in ("12h", "3d", "7d"):
            ent = out["by_H"][H]
            for b in BNAMES[:3]:
                R = ent["arms"][arm]["R"][b]["R"]
                q = ent["null"][arm][b]["q05_q50_q95"]
                report_cells[f"{H} {b}"] = {"R": R, "null": q,
                                            "pass": bool(R is not None and R_BAND[0] <= R <= R_BAND[1]
                                                         and q is not None and q[0] <= R <= q[2])}
        g = {}
        core = arm.replace("+F1", "")
        for H, ent in out["by_H"].items():
            gd = ent["guard_all_origins"]
            ga = gd.get(core if core != "F1" else "raw")
            for grp in ("near_levels_R", "far_levels_R"):
                r0, r1 = gd["raw"][grp], ga[grp]
                ok = r0 is None or abs(np.log(r1)) <= abs(np.log(r0)) + GUARD_TOL
                g[f"{H} all-origin {grp}"] = {"raw": r0, "arm": r1, "pass": bool(ok)}
                if not ok:
                    fails.append(f"guard {H} {grp}")
            for b in BNAMES[3:]:
                r0 = ent["arms"]["raw"]["R"][b]["R"]
                r1 = ent["arms"][arm]["R"][b]["R"]
                ok = (r0 is None or r1 is None or abs(np.log(r1)) <= abs(np.log(r0)) + GUARD_TOL
                      or R_BAND[0] <= r1 <= R_BAND[1])
                g[f"{H} far {b}"] = {"raw": r0, "arm": r1, "pass": bool(ok)}
                if not ok:
                    fails.append(f"far {H} {b}")
            bs = ent["arms"][arm]["bss_vs_raw_all"]
            ok = bs["ci90_twoway"] is not None and bs["ci90_twoway"][0] > -0.005
            g[f"{H} bss"] = {"bss": bs["bss"], "ci90_twoway": bs["ci90_twoway"], "pass": bool(ok)}
            if not ok:
                fails.append(f"bss {H}")
            au = ent["arms"][arm]["auc_all"]
            ok = au["diff"] >= -0.005
            g[f"{H} auc"] = {"diff": au["diff"], "pass": bool(ok)}
            if not ok:
                fails.append(f"auc {H}")
        res[base_arm] = {"near_cells": cells, "near_cells_pass": int(sum(c["pass"] for c in cells.values())),
                         "report_cells_other_H": report_cells, "guards": g, "fails": fails,
                         "REPAIRS": len(fails) == 0}
    order = ["C1", "C2", "C3", "C1+F1", "C2+F1", "C3+F1"]
    passing = [x for x in order if res[x]["REPAIRS"]]
    res["selected"] = passing[0] if passing else None
    res["most_near_cells_descriptive"] = max(order, key=lambda x: res[x]["near_cells_pass"])
    return res


# ---------------------------------------------------------------------------------------------------------------------
# D12 cells
# ---------------------------------------------------------------------------------------------------------------------
def d12_cells():
    rt = json.load(open(os.path.join(HERE, "liqwarn", "routing-table.json")))
    cells = set()
    for r in rt["rules"]:
        if r["class"] != "CALIBRATED-WARN" or r["source"] != "raw_fH":
            continue
        for grp in r["assets"]:
            if grp not in ("btc_eth", "large"):
                continue
            for lo, hi in r["horizon"]:
                for H in HS:
                    if lo <= H <= hi and r["levels"]["kind"] == "set":
                        for v in r["levels"]["values"]:
                            cells.add((grp, H, float(v)))
    return sorted(cells), rt["version"]


def d12(a, wf_by_H):
    import r195_inputs as R5
    U = json.load(open(os.path.join(HERE, "live", "d11_universe.json")))
    Z = np.load(a.r195)
    syms = sorted({k.split("|")[1] for k in Z.keys() if k.startswith("I|")})
    paths = {}
    for e in U["series"]:
        pre = e["key"].split(":")[0]
        if e["symbol"] in syms and (pre in ("A2", "A3") or e["symbol"] in D12_SYMS_ETHBTC):
            paths[e["symbol"]] = e["path"]
    assert len(paths) == 20, sorted(paths)
    L8 = R5.L8
    cells, ver = d12_cells()
    grp_of = {s: ("btc_eth" if s in D12_SYMS_ETHBTC else "large") for s in syms}
    out = {"routing_table_version": ver, "cells": [list(c) for c in cells], "by_cell": {}, "coef_refit": {}}
    feats = {}
    for s in syms:
        d = json.load(open(os.path.join(a.datasets, paths[s])))
        feats[s] = (int(d["startTs"]), np.array([np.nan if v is None else float(v) for v in d["columns"]["close"]]))
    for H in HS:
        rows = []
        tab = []
        for si, s in enumerate(syms):
            key = f"I|{s}|{H}|"
            if key + "ts" not in Z:
                continue
            ts = Z[key + "ts"]
            o = np.argsort(ts)
            ts = ts[o]
            fx = grid_feats(feats[s][0], feats[s][1], ts)
            P = Z[key + "fH"][o].astype(float)
            Y = Z[key + "y"][o]
            tab.append({"ts": ts, "P": P, "Y": Y, "f": fx, "cr": None})
            rows.append((si, s, ts, P, Y, fx))
        wf_own = walk_forward(tab, H, crowd_ok=False)
        out["coef_refit"][TL[H]] = {dt.datetime.fromtimestamp(h, dt.timezone.utc).strftime("%Y-%m-%d"):
                                    [round(float(v), 5) for v in e["C1"]] for h, e in wf_own.items()}
        for grp in ("btc_eth", "large"):
            lvs = sorted({c[2] for c in cells if c[0] == grp and c[1] == H}, reverse=True)
            if not lvs:
                continue
            sid, dd, pr, pc, po, yy, jl_ = [], [], [], [], [], [], []
            for si, s, ts, P, Y, fx in rows:
                if grp_of[s] != grp:
                    continue
                m = (ts >= T_LO) & (ts <= T_HI)
                fm = {k: v[m] for k, v in fx.items()}
                for lv in lvs:
                    j = L8.index(lv)
                    p0 = P[m, j]
                    sid.append(np.full(m.sum(), si))
                    dd.append(ts[m])
                    pr.append(p0)
                    pc.append(apply_wf(p0, fm, "C1", wf_by_H[H], ts[m]))
                    po.append(apply_wf(p0, fm, "C1", wf_own, ts[m]))
                    yy.append(Y[m, j].astype(float))
                    jl_.append(np.full(m.sum(), lv))
            sid, dd, pr, pc, po, yy, jl_ = (np.concatenate(v) for v in (sid, dd, pr, pc, po, yy, jl_))
            _, sid = np.unique(sid, return_inverse=True)        # series of this group only
            tw = TwoWay(sid, dd, int(sid.max()) + 1)
            for lv in lvs:
                m = jl_ == lv
                e = {"raw": r_block(tw, pr, yy, m), "C1_polygon": r_block(tw, pc, yy, m),
                     "C1_refit": r_block(tw, po, yy, m),
                     "bss_C1_polygon_vs_raw": bss_block(tw, yy, pc, pr, m),
                     "bss_C1_refit_vs_raw": bss_block(tw, yy, po, pr, m)}
                for arm, rk, bk_ in (("C1_polygon", "C1_polygon", "bss_C1_polygon_vs_raw"),
                                     ("C1_refit", "C1_refit", "bss_C1_refit_vs_raw")):
                    r0, r1 = e["raw"]["R"], e[rk]["R"]
                    ci = e[bk_]["ci90_twoway"]
                    if r0 is None or r1 is None:
                        e[arm + "_verdict"] = "no positives"
                        continue
                    harmed = ((R_BAND[0] <= r0 <= R_BAND[1]) and not (R_BAND[0] <= r1 <= R_BAND[1])) or \
                             (ci is not None and ci[1] < 0)
                    improved = abs(np.log(r1)) < abs(np.log(r0)) and e[bk_]["bss"] > 0
                    e[arm + "_verdict"] = "HARMED" if harmed else ("IMPROVED" if improved else "neutral")
                out["by_cell"][f"{grp} {TL[H]} {lv * 100:g}%"] = e
        print(f"D12 H {H} done", flush=True)
    for arm in ("C1_polygon", "C1_refit"):
        v = [e.get(arm + "_verdict") for e in out["by_cell"].values()]
        out[f"counts_{arm}"] = {x: v.count(x) for x in ("IMPROVED", "neutral", "HARMED", "no positives")}
    return out


if __name__ == "__main__":
    main()
