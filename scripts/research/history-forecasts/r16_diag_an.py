"""Q26 R16 diagnosis, analysis stages (pit, cv, fh, power). See r16_diag.py for the docstring and data rules.

Notation (per row = origin t of one series, horizon h bars):
  depth = ln(min L_{t+1..t+h} / C_t)        s0 = sigma_hat_t(h) sqrt(h) (frozen R13.4 encoder)
  m0 = depth / s0                            (the R13.4 encoded depth)
  e  = ln sigma_real - ln sigma_hat          sigma_real^2 = mean bar variance over t+1..t+h (the encoder's own target)
  m* = depth / (sigma_real sqrt h)           so m0 = m* . exp(e) exactly
  vol state = ln sigma_hat_t(1) - 0.5 ln LR_t (LR = trailing 252-bar mean bar variance; ex ante)
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r134_library as L4  # noqa: E402
import r16_diag as D  # noqa: E402

CLASSES = D.CLASSES
ZS = (-1.0, -2.0, -3.0, -4.0)
ZD = (-2.0, -3.0, -4.0)
QGRID = (0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 0.5)
LAMZ = np.array([-4.0, -3.5, -3.0, -2.5, -2.0, -1.5])
SEED = 2026160


def logger(out, name):
    os.makedirs(out, exist_ok=True)
    f = open(os.path.join(out, name), "a")

    def log(s):
        line = f"{D.now_iso()} {s}"
        print(line, flush=True)
        f.write(line + "\n")
        f.flush()
    return log


def gkey(*a):
    return int.from_bytes(hashlib.sha256(":".join(map(str, a)).encode()).digest()[:4], "little")


def group_F(m, w, g, G, z):
    """weighted share of m <= z per group (rows weighted by w within group)."""
    y = (m <= z).astype(float)
    num = np.bincount(g, weights=w * y, minlength=G)
    den = np.bincount(g, weights=w, minlength=G)
    return num, den


def qmap_within(x, g, G, w_pool):
    """quantile-map x within each group onto the pooled (class-equal weighted) distribution of x."""
    lib = D.lib_from(x, w_pool)
    ms, cw = lib
    out = np.empty_like(x)
    for k in range(G):
        mk = np.where(g == k)[0]
        if len(mk) == 0:
            continue
        o = np.argsort(x[mk], kind="mergesort")
        u = (np.arange(len(mk)) + 0.5) / len(mk)
        out[mk[o]] = ms[np.minimum(np.searchsorted(cw, u, side="left"), len(ms) - 1)]
    return out


def fit_lam(lib, Fc, zgrid=LAMZ, ok=None):
    ok = np.ones(len(zgrid), bool) if ok is None else ok
    if ok.sum() < 2:
        return 1.0
    best = (np.inf, 1.0)
    for l_ in np.arange(0.5, 2.501, 0.01):
        Fl = np.maximum(D.F_at(lib, zgrid[ok] / l_), 1e-12)
        s = float(np.sum((np.log(Fc[ok]) - np.log(Fl)) ** 2))
        if s < best[0]:
            best = (s, float(l_))
    return best[1]


# =============================================================================================
# pit
# =============================================================================================
def tau_from(lnR, se, pos):
    st = [{"lnR": float(x), "se": float(s), "pos": int(p)} for x, s, p in zip(lnR, se, pos)
          if np.isfinite(x) and np.isfinite(s) and s > 0]
    return D.excess_dispersion(st)


def cmd_pit(a):
    from scipy.stats import norm
    log = logger(a.out, "pit.log")
    log(f"R16 pit start; code {D.git_sha()}")
    res = {"created_utc": D.now_iso(), "code_sha": D.git_sha(), "nb": a.nb, "block_weeks": D.BLOCK_WEEKS,
           "horizon": {}, "groups": {}, "decomp": {}, "forecast_error": {}, "level_slope": {}}
    for hh in D.H_BARS:
        R = D.Rows(a.rows, a.meta, hh)
        e = 0.5 * R.lnrv - (R.lns0 - 0.5 * math.log(hh))
        mstar = R.depth / np.exp(0.5 * R.lnrv + 0.5 * math.log(hh))
        w = D.cls_weights(R.cls)
        lib = D.lib_from(R.m0, w)
        Fpool = {z: float(D.F_at(lib, np.array([z]))[0]) for z in ZS}
        G, cuts = D.groupings(R)
        lvl = 0.5 * R.lnLR
        G["level_decile"] = np.digitize(lvl, np.quantile(lvl, np.linspace(0.1, 0.9, 9)))
        isc = R.cls == 0
        cq = np.quantile(R.vstate[isc], np.linspace(0.1, 0.9, 9))
        G["crypto_vstate_decile"] = np.where(isc, np.digitize(R.vstate, cq), -1)
        lq = np.quantile(lvl[isc], np.linspace(0.1, 0.9, 9))
        G["crypto_level_decile"] = np.where(isc, np.digitize(lvl, lq), -1)
        subs = R.subs[R.sid]
        sub_ix = {"pool": 0, "b9": 1, "b12": 2, "b13a": 3}
        G["crypto_set"] = np.where(isc, np.array([sub_ix.get(s, -1) for s in subs]), -1)
        cuts["crypto_vstate_cuts"] = cq.tolist()
        cuts["crypto_level_cuts"] = lq.tolist()
        # ---- horizon: class-equal F_h(z) vs Brownian reflection reference 2 Phi(z)
        hz = {}
        for z in ZS:
            y = (R.m0 <= z).astype(float)
            dr = D.twoway_var(R.sid, R.block, w * y, w, a.nb, gkey("hz", hh, z))
            ref = 2 * norm.cdf(z)
            hz[str(z)] = {"F": Fpool[z], "lo90": float(np.quantile(dr, 0.05)), "hi90": float(np.quantile(dr, 0.95)),
                          "ratio_BM": Fpool[z] / ref, "BM": ref}
            for ci, c in enumerate(CLASSES):
                mk = R.cls == ci
                hz[str(z)][f"F_{c}"] = float(np.mean(R.m0[mk] <= z))
        res["horizon"][str(hh)] = hz
        log(f"h={hh} rows {R.n}; F_pool " + " ".join(f"{z}:{Fpool[z]:.5f}" for z in ZS) +
            " | ratio to 2Phi " + " ".join(f"{z}:{hz[str(z)]['ratio_BM']:.2f}" for z in ZS))
        # ---- forecast error summary
        fe = {}
        for nm, g in G.items():
            ok = g >= 0
            u = np.unique(g[ok])
            fe[nm] = {int(k): {"mean_e": float(e[ok & (g == k)].mean()), "sd_e": float(e[ok & (g == k)].std()),
                               "rows": int((ok & (g == k)).sum()),
                               "spike": float(np.nanmean(R.spike[ok & (g == k)])),
                               "vov": float(np.nanmean(R.vov[ok & (g == k)])),
                               "F_mstar_-1": float(np.mean(mstar[ok & (g == k)] <= -1.0)),
                               "F_mstar_-1.5": float(np.mean(mstar[ok & (g == k)] <= -1.5))} for k in u}
        res["forecast_error"][str(hh)] = fe
        sids = np.unique(R.sid)
        me = np.bincount(R.sid, weights=e)[sids] / np.bincount(R.sid)[sids]
        lv = np.bincount(R.sid, weights=lvl)[sids] / np.bincount(R.sid)[sids]
        cs_ = np.array([R.cls[R.sid == s][0] for s in sids])
        wcl = np.array([1.0 / np.sum(cs_ == c) for c in cs_])
        A_ = np.c_[np.ones(len(lv)), lv]
        b_all = np.linalg.lstsq(A_ * np.sqrt(wcl)[:, None], me * np.sqrt(wcl), rcond=None)[0]
        A2 = np.c_[np.eye(len(CLASSES))[cs_], lv]
        b_within = np.linalg.lstsq(A2, me, rcond=None)[0]
        res["level_slope"][str(hh)] = {"slope_e_on_ln_sigma_level_across": float(b_all[1]),
                                       "slope_within_class_FE": float(b_within[-1])}
        # ---- per-group ratios with two-way CIs
        gres = {}
        for nm, g in G.items():
            ok = g >= 0
            u = np.unique(g[ok])
            ent = {"cuts": cuts.get(nm.replace("_decile", "_cuts")) if nm.endswith("decile") else None,
                   "groups": {}, "tau": {}}
            for k in u:
                mk = ok & (g == k)
                gi = {"rows": int(mk.sum())}
                for z in ZS:
                    y = (R.m0[mk] <= z).astype(float)
                    gi[str(z)] = D.group_ratio_ci(R.sid[mk], R.block[mk], y, np.full(int(mk.sum()), Fpool[z]),
                                                  a.nb, gkey(nm, hh, k, z))
                uq = D.F_at(lib, R.m0[mk])
                gi["calib"] = {str(q): float(np.mean(uq <= q) / q) for q in QGRID}
                ent["groups"][int(k)] = gi
            for z in ZS:
                st = [ent["groups"][int(k)][str(z)] for k in u]
                ent["tau"][str(z)] = D.excess_dispersion([s for s in st if s.get("lnR") is not None])
            gres[nm] = ent
            tt = ent["tau"]
            log(f"  h={hh} {nm}: tau " + " ".join(f"{z}:{(tt[str(z)] or {}).get('tau', float('nan')):.3f}" for z in ZS)
                + " | R " + " ".join(f"{int(k)}:{ent['groups'][int(k)]['-3.0'].get('R', float('nan')):.2f}" for k in u))
        res["groups"][str(hh)] = gres
        # ---- Shapley decomposition of cross-group dispersion: m0 = m* exp(e); factors A (bias of e), D (spread /
        #      shape of centred e), B (path geometry m*)
        dec = {}
        for nm in ("class", "vstate_decile", "level_decile", "era", "age", "crypto_vstate_decile",
                   "crypto_level_decile", "crypto_set"):
            g0 = G[nm]
            ok = g0 >= 0
            gg = np.unique(g0[ok], return_inverse=True)[1]
            Gn = gg.max() + 1
            sub = np.where(ok)[0]
            w_ = w[sub] if not nm.startswith("crypto") else np.ones(len(sub))
            es, ms_ = e[sub], mstar[sub]
            gm = np.bincount(gg, weights=w_ * es, minlength=Gn) / np.bincount(gg, weights=w_, minlength=Gn)
            pm = float(np.sum(w_ * es) / np.sum(w_))
            ec = es - gm[gg]
            ec_map = qmap_within(ec, gg, Gn, w_)
            ms_map = qmap_within(ms_, gg, Gn, w_)
            base_se = {z: np.array([gres[nm]["groups"][int(k)][str(z)].get("se", np.nan)
                                    for k in np.unique(g0[ok])]) for z in ZD}
            base_pos = {z: np.array([gres[nm]["groups"][int(k)][str(z)].get("pos", 0)
                                     for k in np.unique(g0[ok])]) for z in ZD}
            tau2 = {}
            for A_on, D_on, B_on in itertools.product((0, 1), repeat=3):
                ebar = np.full(len(sub), pm) if A_on else gm[gg]
                ecc = ec_map if D_on else ec
                mm = (ms_map if B_on else ms_) * np.exp(ebar + ecc)
                libc = D.lib_from(mm, w_)
                t2 = {}
                for z in ZD:
                    Fz = float(D.F_at(libc, np.array([z]))[0])
                    num, den = group_F(mm, np.ones(len(sub)), gg, Gn, z)
                    pos = num
                    with np.errstate(all="ignore"):
                        lnR = np.log(num / den / Fz)
                        se = base_se[z] * np.sqrt(np.maximum(base_pos[z], 1) / np.maximum(pos, 1))
                    tt = tau_from(lnR, se, pos)
                    t2[str(z)] = (tt["tau"] ** 2) if tt else float("nan")
                tau2[(A_on, D_on, B_on)] = t2
            sh = {}
            for z in ZD:
                v = {k: tau2[k][str(z)] for k in tau2}
                tot = v[(0, 0, 0)]
                phi = {}
                for fi, fname in enumerate(("A_bias", "D_spread", "B_geometry")):
                    acc = 0.0
                    for S in itertools.product((0, 1), repeat=3):
                        if S[fi]:
                            continue
                        k = sum(S)
                        wgt = math.factorial(k) * math.factorial(2 - k) / 6.0
                        S1 = list(S)
                        S1[fi] = 1
                        acc += wgt * (v[S] - v[tuple(S1)])
                    phi[fname] = acc
                sh[str(z)] = {"tau_base": math.sqrt(tot) if tot == tot else None, "tau2_base": tot,
                              "tau2_all_removed": v[(1, 1, 1)], "shapley_tau2_reduction": phi,
                              "share": {k_: (val / tot if tot and tot > 0 else None) for k_, val in phi.items()},
                              "tau_only": {"A": math.sqrt(max(v[(1, 0, 0)], 0)), "D": math.sqrt(max(v[(0, 1, 0)], 0)),
                                           "B": math.sqrt(max(v[(0, 0, 1)], 0)),
                                           "AD": math.sqrt(max(v[(1, 1, 0)], 0))}}
            # per-group scale lambda_g on the base pool and the shape residual left after it
            lam_g, resid = {}, {}
            for k in range(Gn):
                mk = gg == k
                Fc = np.array([np.mean(R.m0[sub][mk] <= z) for z in LAMZ])
                okz = Fc * mk.sum() >= 10
                if okz.sum() < 2:
                    continue
                lg = fit_lam(lib, Fc, LAMZ, okz & (Fc > 0))
                lam_g[k] = lg
                resid[k] = {str(z): float(np.log(max(np.mean(R.m0[sub][mk] <= z), 1e-12)) -
                                          np.log(max(float(D.F_at(lib, np.array([z / lg]))[0]), 1e-12))) for z in ZD}
            for z in ZD:
                ks = sorted(resid)
                x = np.array([resid[k][str(z)] for k in ks])
                se = np.array([base_se[z][k] for k in ks])
                pos = np.array([base_pos[z][k] for k in ks])
                tt = tau_from(x, se, pos)
                sh[str(z)]["tau_after_group_lambda"] = tt["tau"] if tt else None
            sh["lambda_g"] = {int(k): v_ for k, v_ in lam_g.items()}
            dec[nm] = sh
            log(f"  h={hh} decomp {nm}: " + " ".join(
                f"z{z}: tau {sh[str(z)]['tau_base'] or float('nan'):.3f} A {sh[str(z)]['share']['A_bias'] or 0:+.2f} "
                f"D {sh[str(z)]['share']['D_spread'] or 0:+.2f} B {sh[str(z)]['share']['B_geometry'] or 0:+.2f} "
                f"| after lam_g {sh[str(z)]['tau_after_group_lambda'] or float('nan'):.3f}" for z in ZD))
        res["decomp"][str(hh)] = dec
        del R
    D.write_json(os.path.join(a.out, "pit-r16.json"), res)
    log("pit done")


# =============================================================================================
# cv: candidate encoder fixes
# =============================================================================================
SALT_CV = "Q26-R16-cv:"
TBLOCKS = [("<2012", None, "2012-01-01"), ("2012-2017", "2012-01-01", "2018-01-01"),
           ("2018-2021", "2018-01-01", "2022-01-01"), ("2022+", "2022-01-01", None)]
VARIANTS = ("V0", "V1", "V2", "V3")
DECODERS = ("pool", "lam_c", "lam_cs", "reg1", "reg2", "tilt", "qm")
REG_Z = np.array([-1.0, -1.5, -2.0, -2.5, -3.0, -4.0])
REG_N = 30000
LEVELS = {0: (-0.15, -0.25, -0.40), 1: (-0.05, -0.10, -0.20), 2: (-0.05, -0.10, -0.20), 3: (-0.02, -0.05, -0.10),
          4: (-0.02, -0.05, -0.10), 5: (-0.02, -0.05, -0.10)}
LVARR = np.array([LEVELS[c] for c in range(6)])
EDGES = (-4.0, -3.0, -2.0, -1.0, 0.0)
KAPPA_OWN = 250.0
KAPPA_TILT = 300.0
KAPPA_QM = 2000.0
Z1, Z2 = -1.5, -2.5


def series_fold(keys):
    return np.array([hashlib.sha256((SALT_CV + k).encode()).digest()[0] % 4 for k in keys])


def tblock_of(day):
    out = np.zeros(len(day), np.int8)
    for j, (_, lo, hi) in enumerate(TBLOCKS):
        mk = np.ones(len(day), bool)
        if lo:
            mk &= day >= L4.date_days(lo)
        if hi:
            mk &= day < L4.date_days(hi)
        out[mk] = j
    return out


def design(R, V):
    """regressors and target (ln variance) for encoder variant V (V1/V2 equivariant: everything minus ln LR)."""
    L = R.lnLR.astype(np.float64)
    if V == "V1":
        X = np.c_[np.ones(R.n), R.lnD - L, R.lnW - L, R.lnM - L]
    else:
        X = np.c_[np.ones(R.n), R.lnD - L, R.lnW - L, R.lnM - L, R.lnEW - L, R.lnRVcc - L]
    return X, R.lnrv.astype(np.float64) - L, L


def fit_variant(R, V, tr):
    X, y, L = design(R, "V1" if V == "V1" else "V2")
    ok = tr & np.all(np.isfinite(X), axis=1) & np.isfinite(y)
    w = D.cls_weights(R.cls, ok)
    sw = np.sqrt(w[ok])
    b, *_ = np.linalg.lstsq(X[ok] * sw[:, None], y[ok] * sw, rcond=None)
    smear = float(np.sum(w[ok] * np.exp(y[ok] - X[ok] @ b)) / np.sum(w[ok]))
    return b, math.log(smear)


def own_asof_mean(R, idx_all, val, kappa):
    """per row: shrunk as-of mean of val over the series' own resolved rows (end < day): sum / (n + kappa)."""
    out = np.zeros(R.n)
    nres = np.zeros(R.n)
    sid = R.sid[idx_all]
    order = np.lexsort((R.end[idx_all], sid))
    ii = idx_all[order]
    s_sorted = R.sid[ii]
    starts = np.r_[0, np.flatnonzero(np.diff(s_sorted)) + 1, len(ii)]
    for a0, a1 in zip(starts[:-1], starts[1:]):
        rr = ii[a0:a1]
        ed = R.end[rr]
        cs = np.r_[0.0, np.cumsum(val[rr])]
        k = np.searchsorted(ed, R.day[rr], side="left")
        out[rr] = cs[k] / (k + kappa)
        nres[rr] = k
    return out, nres


def own_asof_counts(R, idx_all, m, zs):
    """per row: own resolved counts of m <= z for each z, and n resolved."""
    E = np.zeros((R.n, len(zs)))
    N = np.zeros(R.n)
    order = np.lexsort((R.end[idx_all], R.sid[idx_all]))
    ii = idx_all[order]
    s_sorted = R.sid[ii]
    starts = np.r_[0, np.flatnonzero(np.diff(s_sorted)) + 1, len(ii)]
    for a0, a1 in zip(starts[:-1], starts[1:]):
        rr = ii[a0:a1]
        ed = R.end[rr]
        k = np.searchsorted(ed, R.day[rr], side="left")
        for j, z in enumerate(zs):
            cs = np.r_[0.0, np.cumsum(m[rr] <= z)]
            E[rr, j] = cs[k]
        N[rr] = k
    return E, N


def lnscale(R, V, tr, te_series_rows):
    """ln s_V (scale incl. sqrt h) for all rows; V3 uses own as-of residual shrinkage on te/tr series alike."""
    h = R.h
    if V == "V0":
        return R.lns0.copy(), None
    b, ls = fit_variant(R, V, tr)
    X, y, L = design(R, "V1" if V == "V1" else "V2")
    lnv = X @ b + L
    info = {"beta": b.tolist(), "ln_smear": ls}
    if V != "V1":
        # V2/V3 inputs (EWMA, close-to-close RV) are missing on some rows: fall back to V1 there (same smearing
        # convention), so no row gets a non-finite scale (a NaN scale would decode to P = 1)
        b1, ls1 = fit_variant(R, "V1", tr)
        X1, _, _ = design(R, "V1")
        bad = ~np.isfinite(lnv)
        lnv[bad] = X1[bad] @ b1 + L[bad] + (ls1 - ls)
        info["fallback_rows"] = int(bad.sum())
    if V == "V3":
        r = np.where(np.isfinite(y), y - (lnv - L), 0.0)
        adj, _ = own_asof_mean(R, np.arange(R.n), r, KAPPA_OWN)
        lnv = lnv + adj
    return 0.5 * (lnv + ls) + 0.5 * math.log(h), info


class Decoder:
    def __init__(self, R, m, tr, kind, vcuts):
        self.kind = kind
        w = D.cls_weights(R.cls, tr)
        self.lib = D.lib_from(m, w)
        self.lam_c = np.ones(len(CLASSES))
        self.lam_cs = np.ones((len(CLASSES), 5))
        self.vcuts = vcuts
        vb = np.digitize(R.vstate, vcuts)
        if kind in ("lam_c", "lam_cs", "tilt", "qm"):
            for ci in range(len(CLASSES)):
                mk = tr & (R.cls == ci)
                if mk.sum() < 1000:
                    continue
                Fc = np.array([np.mean(m[mk] <= z) for z in LAMZ])
                okz = (Fc * mk.sum() >= 10) & (Fc > 0)
                self.lam_c[ci] = fit_lam(self.lib, Fc, LAMZ, okz)
                if kind == "lam_cs":
                    for b_ in range(5):
                        mb = mk & (vb == b_)
                        if mb.sum() < 2000:
                            self.lam_cs[ci, b_] = self.lam_c[ci]
                            continue
                        Fb = np.array([np.mean(m[mb] <= z) for z in LAMZ])
                        okb = (Fb * mb.sum() >= 10) & (Fb > 0)
                        self.lam_cs[ci, b_] = fit_lam(self.lib, Fb, LAMZ, okb) if okb.sum() >= 2 else self.lam_c[ci]
        if kind in ("reg1", "reg2"):
            self._fit_reg(R, m, tr, kind)
        if kind == "qm":
            u = D.F_at(self.lib, m[tr])
            age3 = np.digitize(R.age[tr], [365, 1460])
            cell = R.cls[tr].astype(np.int64) * 100 + vb[tr] * 10 + age3
            self.qm = {}
            for c_ in np.unique(cell):
                self.qm[int(c_)] = np.sort(u[cell == c_])

    # ---- covariate-scaled decoder: ln lambda_i = c_class + g.x_i (reg1); reg2 adds a tail-shape term whose
    #      size also depends on class and x: ln lambda_i(z) = c + g.x + (d_class + q.x) t(z), t = (-z - 2) / 2
    def _feats(self, R, idx):
        sp = R.spike[idx].astype(float)
        sp = np.where(np.isfinite(sp), sp, self.sp_fill[R.cls[idx]])
        vov = R.vov[idx].astype(float)
        vov = np.where(np.isfinite(vov), vov, self.vov_fill[R.cls[idx]])
        X = np.c_[R.vstate[idx], vov, sp, np.log1p(R.age[idx]), 0.5 * R.lnLR[idx]]
        return (X - self.xm) / self.xs

    def _lnF(self, zz):
        lf = np.interp(zz, self.zg, self.lnFg)
        g = np.interp(zz, self.zg, self.dlnFg)
        return lf, g

    def _fit_reg(self, R, m, tr, kind):
        from scipy.optimize import minimize
        rng = np.random.default_rng(gkey("reg", int(tr.sum()), kind))
        self.zg = np.linspace(-20.0, 0.5, 2051)
        nlib = len(self.lib[0])
        self.lnFg = np.log(np.maximum(D.F_at(self.lib, self.zg), 0.5 / nlib))
        self.dlnFg = np.gradient(self.lnFg, self.zg)
        self.sp_fill = np.zeros(len(CLASSES))
        self.vov_fill = np.zeros(len(CLASSES))
        pick = []
        for ci in range(len(CLASSES)):
            ii = np.where(tr & (R.cls == ci))[0]
            if len(ii) < 1000:
                continue
            self.sp_fill[ci] = float(np.nanmedian(R.spike[ii]))
            self.vov_fill[ci] = float(np.nanmedian(R.vov[ii]))
            pick.append(rng.choice(ii, min(REG_N, len(ii)), replace=False))
        pick = np.concatenate(pick)
        self.xm = np.zeros(5)
        self.xs = np.ones(5)
        X0 = self._feats(R, pick)
        self.xm, self.xs = X0.mean(axis=0), X0.std(axis=0) + 1e-9
        X = (X0 - self.xm) / self.xs
        C = np.eye(len(CLASSES))[R.cls[pick]]
        Y = (m[pick][:, None] <= REG_Z[None, :]).astype(float)
        t = (-REG_Z - 2.0) / 2.0
        k = X.shape[1]
        nc = len(CLASSES)
        two = kind == "reg2"

        def unpack(th):
            c, g = th[:nc], th[nc:nc + k]
            if two:
                d, q = th[nc + k:2 * nc + k], th[2 * nc + k:]
                return c, g, d, q
            return c, g, None, None

        def f(th):
            c, g, d, q = unpack(th)
            a = C @ c + X @ g
            ll = a[:, None] + ((C @ d + X @ q)[:, None] * t[None, :] if two else 0.0)
            zz = REG_Z[None, :] / np.exp(ll)
            lf, gr = self._lnF(zz)
            lf = np.minimum(lf, -1e-9)
            P = np.exp(lf)
            nll = -(Y * lf + (1 - Y) * np.log1p(-np.minimum(P, 1 - 1e-9)))
            dnll_dlf = np.where(Y > 0, -1.0, P / np.maximum(1 - P, 1e-9))
            dlf_dll = gr * (-zz)
            G = dnll_dlf * dlf_dll                     # (n, J) derivative wrt ln lambda
            gs = G.sum(axis=1)
            grad = [C.T @ gs, X.T @ gs]
            if two:
                gt = (G * t[None, :]).sum(axis=1)
                grad += [C.T @ gt, X.T @ gt]
            n = len(Y)
            return float(nll.sum() / n), np.concatenate(grad) / n

        th0 = np.zeros(2 * nc + 2 * k if two else nc + k)
        r = minimize(f, th0, jac=True, method="L-BFGS-B", options={"maxiter": 300})
        self.theta = r.x
        self.reg_info = {"nll": float(r.fun), "iters": int(r.nit), "theta": r.x.tolist()}
        self._unpack = unpack
        self._two = two

    def _prob_reg(self, R, idx, zt):
        c, g, d, q = self._unpack(self.theta)
        X = self._feats(R, idx)
        a = c[R.cls[idx]] + X @ g
        if self._two:
            b = d[R.cls[idx]] + X @ q
            tt = (-zt - 2.0) / 2.0
            ll = a[:, None] + b[:, None] * np.clip(tt, -0.5, 3.0)
        else:
            ll = np.repeat(a[:, None], zt.shape[1], axis=1)
        lf, _ = self._lnF(zt / np.exp(ll))
        return np.exp(np.minimum(lf, 0.0))

    def prob(self, R, idx, zt, m_own=None):
        """P(m_V <= zt) for rows idx; zt (len(idx), J)."""
        if self.kind in ("reg1", "reg2"):
            return np.clip(self._prob_reg(R, idx, zt), 1e-7, 1.0)
        if self.kind == "pool":
            return np.stack([D.F_at(self.lib, zt[:, j]) for j in range(zt.shape[1])], 1)
        if self.kind in ("lam_c", "tilt", "qm"):
            lam = self.lam_c[R.cls[idx]][:, None]
        else:
            vb = np.digitize(R.vstate[idx], self.vcuts)
            lam = self.lam_cs[R.cls[idx], vb][:, None]
        P = np.stack([D.F_at(self.lib, zt[:, j] / lam[:, 0]) for j in range(zt.shape[1])], 1)
        if self.kind == "tilt":
            E, N = m_own
            F1 = D.F_at(self.lib, Z1 / lam[:, 0])
            F2 = D.F_at(self.lib, Z2 / lam[:, 0])
            a1 = np.log((E[:, 0] + KAPPA_TILT * F1) / (N + KAPPA_TILT)) - np.log(np.maximum(F1, 1e-12))
            a2 = np.log((E[:, 1] + KAPPA_TILT * F2) / (N + KAPPA_TILT)) - np.log(np.maximum(F2, 1e-12))
            sl = (a2 - a1) / (Z2 - Z1)
            adj = a1[:, None] + sl[:, None] * (zt - Z1)
            adj = np.clip(adj, -1.5, 1.5)
            P = np.minimum(P * np.exp(adj), 1.0)
        if self.kind == "qm":
            vb = np.digitize(R.vstate[idx], self.vcuts)
            age3 = np.digitize(R.age[idx], [365, 1460])
            cell = R.cls[idx].astype(np.int64) * 100 + vb * 10 + age3
            Q = np.stack([D.F_at(self.lib, zt[:, j]) for j in range(zt.shape[1])], 1)
            P = Q.copy()
            for c_ in np.unique(cell):
                mk = cell == c_
                us = self.qm.get(int(c_))
                n = 0 if us is None else len(us)
                if n == 0:
                    continue
                cnt = np.searchsorted(us, Q[mk], side="right")
                P[mk] = (cnt + KAPPA_QM * Q[mk]) / (n + KAPPA_QM)
        return np.clip(P, 1e-7, 1.0)


def events_for(R, idx, lnsV):
    """thresholds in m_V units for: baseline-z edges (price levels fixed at z_ref * s0) and fixed % levels."""
    s0 = np.exp(R.lns0[idx])
    sV = np.exp(lnsV[idx])
    ze = np.stack([np.full(len(idx), z) * s0 / sV for z in EDGES], 1)
    lv = LVARR[R.cls[idx]]
    zl = np.log1p(lv) / sV[:, None]
    return ze, zl


def labels_for(R, idx):
    ye = np.stack([(R.m0[idx] <= z) for z in EDGES], 1).astype(np.int8)
    lv = LVARR[R.cls[idx]]
    yl = (R.depth[idx][:, None] <= np.log1p(lv)).astype(np.int8)
    return ye, yl


def bin_logscore(Pe, ye):
    """multinomial log score over bins (-inf,-4],(-4,-3],(-3,-2],(-2,-1],(-1,0],(0,inf) in baseline z."""
    C = np.maximum.accumulate(Pe, axis=1)
    C = np.minimum(C, 1.0)
    pb = np.diff(np.c_[np.zeros(len(C)), C, np.ones(len(C))], axis=1)
    pb = np.maximum(pb, 1e-6)
    pb /= pb.sum(axis=1, keepdims=True)
    yb = np.c_[np.zeros(len(ye), np.int8), ye, np.ones(len(ye), np.int8)]
    k = np.argmax(np.diff(yb, axis=1) > 0, axis=1)
    return np.log(pb[np.arange(len(pb)), k])


def cmd_cv(a):
    log = logger(a.out, "cv.log")
    log(f"R16 cv start; code {D.git_sha()}")
    res = {"created_utc": D.now_iso(), "code_sha": D.git_sha(), "tblocks": TBLOCKS, "variants": VARIANTS,
           "decoders": DECODERS, "levels": {CLASSES[k]: v for k, v in LEVELS.items()}, "edges": EDGES,
           "kappa": {"own_level": KAPPA_OWN, "tilt": KAPPA_TILT, "qm": KAPPA_QM}, "h": {}}
    hs = [int(x) for x in (a.cv or "1,3,5,10,20").split(",")]
    variants = tuple(os.environ.get("R16_VARIANTS", ",".join(VARIANTS)).split(","))
    res["variants"] = variants
    for hh in hs:
        R = D.Rows(a.rows, a.meta, hh)
        sf = series_fold(R.keys)[R.sid]
        tb = tblock_of(R.day)
        G, cuts = D.groupings(R)
        lvl = 0.5 * R.lnLR
        G["level_decile"] = np.digitize(lvl, np.quantile(lvl, np.linspace(0.1, 0.9, 9)))
        n = R.n
        ye, yl = labels_for(R, np.arange(n))
        preds = {}
        betas = {}
        for V in variants:
            for Dk in DECODERS:
                preds[(V, Dk)] = (np.full((n, len(EDGES)), np.nan, np.float32),
                                  np.full((n, 3), np.nan, np.float32))
        for k in range(4):
            for j in range(4):
                te = (sf == k) & (tb == j)
                if te.sum() == 0:
                    continue
                lo = L4.date_days(TBLOCKS[j][1]) if TBLOCKS[j][1] else -10 ** 9
                hi = L4.date_days(TBLOCKS[j][2]) if TBLOCKS[j][2] else 10 ** 9
                tr = (sf != k) & (tb != j) & ~((R.day < lo) & (R.end >= lo)) & ~((R.day < hi) & (R.end >= hi))
                idx = np.where(te)[0]
                vcuts = np.quantile(R.vstate[tr], [0.2, 0.4, 0.6, 0.8])
                for V in variants:
                    lnsV, info = lnscale(R, V, tr, te)
                    betas[f"{V}/{k}{j}"] = info
                    mV = R.depth / np.exp(lnsV)
                    ze, zl = events_for(R, idx, lnsV)
                    own = None
                    for Dk in DECODERS:
                        if Dk == "tilt" and own is None:
                            Eo, No = own_asof_counts(R, np.where(sf == k)[0], mV, (Z1, Z2))
                            own = (Eo[idx], No[idx])
                        dec = Decoder(R, mV, tr, Dk, vcuts)
                        if Dk in ("reg1", "reg2"):
                            betas[f"{V}+{Dk}/{k}{j}"] = dec.reg_info
                        if Dk == "lam_cs":
                            betas[f"{V}+lam_cs/{k}{j}"] = {"lam_c": dec.lam_c.tolist(), "lam_cs": dec.lam_cs.tolist()}
                        pe = dec.prob(R, idx, ze, own)
                        pl = dec.prob(R, idx, zl, own)
                        preds[(V, Dk)][0][idx] = pe
                        preds[(V, Dk)][1][idx] = pl
                log(f"  h={hh} cell s{k} t{j}: test rows {len(idx)}, train rows {int(tr.sum())}")
        # ---- scores
        out = {"rows": int(n), "scores": {}, "dispersion": {}, "crypto_slope": {}}
        if ("V0", "pool") not in preds:      # baseline needed for every comparison
            lnsV = R.lns0
            for k in range(4):
                for j in range(4):
                    te = (sf == k) & (tb == j)
                    if not te.any():
                        continue
                    lo = L4.date_days(TBLOCKS[j][1]) if TBLOCKS[j][1] else -10 ** 9
                    hi = L4.date_days(TBLOCKS[j][2]) if TBLOCKS[j][2] else 10 ** 9
                    tr = (sf != k) & (tb != j) & ~((R.day < lo) & (R.end >= lo)) & ~((R.day < hi) & (R.end >= hi))
                    idx = np.where(te)[0]
                    dec = Decoder(R, R.m0, tr, "pool", np.quantile(R.vstate[tr], [0.2, 0.4, 0.6, 0.8]))
                    ze, zl = events_for(R, idx, lnsV)
                    preds.setdefault(("V0", "pool"), (np.full((n, len(EDGES)), np.nan, np.float32),
                                                      np.full((n, 3), np.nan, np.float32)))
                    preds[("V0", "pool")][0][idx] = dec.prob(R, idx, ze)
                    preds[("V0", "pool")][1][idx] = dec.prob(R, idx, zl)
        base = preds[("V0", "pool")]
        ls_base = bin_logscore(base[0].astype(np.float64), ye)
        # SEs of per-group ln R from the baseline predictions (reused for every candidate)
        se_tab = {}
        for nm in ("class", "vstate_decile", "era", "age", "level_decile"):
            g = G[nm]
            se_tab[nm] = {}
            for zi, z in enumerate(EDGES[:3]):
                st = []
                for kk in np.unique(g):
                    mk = g == kk
                    st.append(D.group_ratio_ci(R.sid[mk], R.block[mk], ye[mk, zi], base[0][mk, zi].astype(float),
                                               300, gkey("cvse", hh, nm, kk, z)))
                se_tab[nm][z] = st
        for (V, Dk), (pe, pl) in preds.items():
            pe = pe.astype(np.float64)
            pl = pl.astype(np.float64)
            okr = np.all(np.isfinite(pe), axis=1) & np.all(np.isfinite(pl), axis=1)
            ls = bin_logscore(np.where(np.isfinite(pe), pe, 0.5), ye)
            sc = {}
            for ci, c in enumerate(CLASSES):
                mk = okr & (R.cls == ci)
                if mk.sum() < 1000:
                    continue
                ent = {"rows": int(mk.sum()), "logscore": float(ls[mk].mean()),
                       "d_logscore_vs_base": float(ls[mk].mean() - ls_base[mk].mean())}
                for zi, z in enumerate(EDGES[:4]):
                    p, y = pe[mk, zi], ye[mk, zi]
                    pb = base[0][mk, zi].astype(float)
                    ent[f"z{z}"] = {"R": float(y.sum() / p.sum()), "brier": float(np.mean((p - y) ** 2)),
                                    "bss_vs_base": float(1 - np.mean((p - y) ** 2) / np.mean((pb - y) ** 2)),
                                    "pos": int(y.sum())}
                for li, lv in enumerate(LEVELS[ci]):
                    p, y = pl[mk, li], yl[mk, li]
                    pb = base[1][mk, li].astype(float)
                    ent[f"k{lv}"] = {"R": float(y.sum() / max(p.sum(), 1e-12)), "brier": float(np.mean((p - y) ** 2)),
                                     "bss_vs_base": float(1 - np.mean((p - y) ** 2) / max(np.mean((pb - y) ** 2),
                                                                                           1e-300)),
                                     "pos": int(y.sum())}
                sc[c] = ent
            cls_ok = [c for c in sc]
            sc["_class_mean_d_logscore"] = float(np.mean([sc[c]["d_logscore_vs_base"] for c in cls_ok]))
            sc["_class_mean_bss_z"] = {str(z): float(np.mean([sc[c][f"z{z}"]["bss_vs_base"] for c in cls_ok]))
                                       for z in EDGES[:4]}
            out["scores"][f"{V}+{Dk}"] = sc
            disp = {}
            for nm, st_nm in se_tab.items():
                g = G[nm]
                u = np.unique(g)
                disp[nm] = {}
                for zi, z in enumerate(EDGES[:3]):
                    lnR, se, pos = [], [], []
                    for kk, s0 in zip(u, st_nm[z]):
                        mk = okr & (g == kk)
                        yv = ye[mk, zi].sum()
                        pv = pe[mk, zi].sum()
                        lnR.append(math.log(yv / pv) if yv > 0 and pv > 0 else np.nan)
                        se.append(s0.get("se", np.nan))
                        pos.append(int(yv))
                    tt = tau_from(np.array(lnR), np.array(se), np.array(pos))
                    disp[nm][str(z)] = {"tau": tt["tau"] if tt else None, "Q": tt["Q"] if tt else None,
                                        "R": [float(np.exp(x)) if np.isfinite(x) else None for x in lnR]}
            out["dispersion"][f"{V}+{Dk}"] = disp
            # crypto calibration slope (D-R15.0c metric): R by decile of the forecast at fixed % levels
            mk = okr & (R.cls == 0)
            cs_ = {}
            for li, lv in enumerate(LEVELS[0]):
                p, y = pl[mk, li], yl[mk, li]
                q = np.quantile(p, np.linspace(0.1, 0.9, 9))
                b = np.digitize(p, q)
                cs_[str(lv)] = [float(y[b == d].sum() / max(p[b == d].sum(), 1e-12)) for d in range(10)]
            out["crypto_slope"][f"{V}+{Dk}"] = cs_
            log(f"  h={hh} {V}+{Dk}: dLS class-mean {sc['_class_mean_d_logscore']:+.5f}; BSS z-2/-3/-4 " +
                " ".join(f"{sc['_class_mean_bss_z'][str(z)]:+.4f}" for z in EDGES[1:4]) + " | tau class/vdec/era/age z-3 " +
                " ".join(f"{(disp[nm]['-3.0']['tau'] or 0):.3f}" for nm in ("class", "vstate_decile", "era", "age")) +
                f" | crypto R dec1/dec10 k-25% {cs_['-0.25'][0]:.2f}/{cs_['-0.25'][9]:.2f}")
        out["betas"] = betas
        res["h"][str(hh)] = out
        D.write_json(os.path.join(a.out, "cv-r16.json"), res)
        del R, preds
    D.write_json(os.path.join(a.out, "cv-r16.json"), res)
    log("cv done")


# =============================================================================================
# fh: pooling's shortfall vs (fH)
# =============================================================================================
CRYPTO_LEVELS = (-0.15, -0.20, -0.25, -0.30, -0.40)


def twofe_decomp(r, si, wi, iters=60):
    """||r||^2 / n = week part + series-given-week part + rest (orthogonal: projection onto week dummies is nested in
    the projection onto week + series dummies, fitted by alternating projections)."""
    n = len(r)
    su, s_ = np.unique(si, return_inverse=True)
    wu, w_ = np.unique(wi, return_inverse=True)
    cw = np.bincount(w_, minlength=len(wu)).astype(float)
    cs = np.bincount(s_, minlength=len(su)).astype(float)
    pw = (np.bincount(w_, weights=r, minlength=len(wu)) / cw)[w_]
    a_s = np.zeros(len(su))
    b_w = np.zeros(len(wu))
    for _ in range(iters):
        b_w = np.bincount(w_, weights=r - a_s[s_], minlength=len(wu)) / cw
        a_s = np.bincount(s_, weights=r - b_w[w_], minlength=len(su)) / cs
    f2 = a_s[s_] + b_w[w_]
    return {"total": float(np.sum(r * r) / n), "week": float(np.sum(pw * pw) / n),
            "series_given_week": float(np.sum((f2 - pw) ** 2) / n), "rest": float(np.sum((r - f2) ** 2) / n)}


def murphy(p, y, nbins=20):
    q = np.unique(np.quantile(p, np.linspace(0, 1, nbins + 1)))
    b = np.clip(np.searchsorted(q, p, side="right") - 1, 0, len(q) - 2)
    ybar = y.mean()
    rel = res_ = 0.0
    for k in range(len(q) - 1):
        mk = b == k
        if not mk.any():
            continue
        nk = mk.sum()
        rel += nk * (p[mk].mean() - y[mk].mean()) ** 2
        res_ += nk * (y[mk].mean() - ybar) ** 2
    n = len(p)
    return {"rel": rel / n, "res": res_ / n, "unc": float(ybar * (1 - ybar)), "brier": float(np.mean((p - y) ** 2))}


def fix_predict(R, tr, idx, V, Dk, levels):
    """predictions of encoder variant V + decoder Dk, trained on tr, for rows idx at fixed % levels."""
    lnsV, _ = lnscale(R, V, tr, None)
    mV = R.depth / np.exp(lnsV)
    vcuts = np.quantile(R.vstate[tr], [0.2, 0.4, 0.6, 0.8])
    zt = np.log1p(np.array(levels))[None, :] / np.exp(lnsV[idx])[:, None]
    own = None
    if Dk == "tilt":
        Eo, No = own_asof_counts(R, idx, mV, (Z1, Z2))
        own = (Eo[idx], No[idx])
    dec = Decoder(R, mV, tr, Dk, vcuts)
    return dec.prob(R, idx, zt, own)


def neff_events(R, mask, z, w, nb, seed):
    y = (R.m0[mask] <= z).astype(float)
    ww = w[mask]
    F = float(np.sum(ww * y) / np.sum(ww))
    out = {"F": F, "rows": int(mask.sum()), "events": int(y.sum())}
    for mode in ("two", "series", "block"):
        d = D.twoway_var(R.sid[mask], R.block[mask], ww * y, ww, nb, seed, mode)
        v = float(np.var(d))
        out[f"var_{mode}"] = v
        out[f"neff_events_{mode}"] = float(F * F * (1 - F) / v / (1 - F)) if v > 0 else None  # = F(1-F)/v * F
    return out


def cmd_fh(a):
    log = logger(a.out, "fh.log")
    log(f"R16 fh start; code {D.git_sha()}")
    best = (a.cv or "V3+lam_cs").split("+")
    FH = np.load(a.fh)
    res = {"created_utc": D.now_iso(), "code_sha": D.git_sha(), "best_fix": "+".join(best), "cells": {}, "neff": {}}
    for hh in (1, 3):
        R = D.Rows(a.rows, a.meta, hh)
        T = 24 * hh
        kid = {k: i for i, k in enumerate(np.unique(FH[f"T{T}_key"]))}
        code = np.array([kid[k] for k in FH[f"T{T}_key"]], np.int64) * 10 ** 6 + FH[f"T{T}_ts"] // DAY_
        lut = dict(zip(code.tolist(), range(len(code))))
        for scored in ("b12", "b9"):
            ids = np.where(R.subs == scored)[0]
            insc = (R.cls == 0) & np.isin(R.sid, ids)
            tr = ~insc
            idx = np.where(insc)[0]
            mk_ = np.array([kid.get(R.keys[s], -1) for s in R.sid[idx]], np.int64)
            cc = mk_ * 10 ** 6 + (R.day[idx].astype(np.int64) + 1)
            hit = np.array([lut.get(c_, -1) if m_ >= 0 else -1 for c_, m_ in zip(cc.tolist(), mk_.tolist())])
            okh = hit >= 0
            idx = idx[okh]
            hit = hit[okh]
            pf = FH[f"T{T}_pH"][hit].astype(float)
            yf = FH[f"T{T}_y"][hit]
            Y = (R.depth[idx][:, None] <= np.log1p(np.array(CRYPTO_LEVELS))[None, :]).astype(np.int8)
            mism = float(np.mean(yf != Y))
            w = D.cls_weights(R.cls, tr)
            lib = D.lib_from(R.m0, w)
            zt = np.log1p(np.array(CRYPTO_LEVELS))[None, :] / np.exp(R.lns0[idx])[:, None]
            pL = np.stack([D.F_at(lib, zt[:, j]) for j in range(len(CRYPTO_LEVELS))], 1)
            pX = fix_predict(R, tr, idx, best[0], best[1], CRYPTO_LEVELS)
            log(f"h={hh} {scored}: matched fH rows {len(idx)}; label mismatch {mism:.2e}")
            for j, k in enumerate(CRYPTO_LEVELS):
                y = Y[:, j].astype(float)
                ok = np.isfinite(pf[:, j])
                y_, si, wk = y[ok], R.sid[idx][ok], R.week[idx][ok]
                bl = R.block[idx][ok]
                ent = {"rows": int(ok.sum()), "pos": int(y_.sum())}
                comp = {"L_all": pL[ok, j], "fix": pX[ok, j], "fH": pf[ok, j]}
                for nm_, p in comp.items():
                    ent[nm_] = {"R": float(p.sum() / max(y_.sum(), 1)), "brier": float(np.mean((p - y_) ** 2)),
                                "decomp": twofe_decomp(y_ - p, si, wk), "murphy": murphy(p, y_)}
                for cand in ("L_all", "fix"):
                    d = (comp[cand] - y_) ** 2 - (comp["fH"] - y_) ** 2
                    one = np.ones(len(d))
                    v2 = float(np.var(D.twoway_var(si, bl, d, one, a.nb, gkey("fh2", hh, scored, k, cand))))
                    vs = float(np.var(D.twoway_var(si, bl, d, one, a.nb, gkey("fhs", hh, scored, k, cand), "series")))
                    vb = float(np.var(D.twoway_var(si, bl, d, one, a.nb, gkey("fhb", hh, scored, k, cand), "block")))
                    md = float(d.mean())
                    ent[f"{cand}_vs_fH"] = {"mean_d": md, "z_two": md / math.sqrt(v2) if v2 > 0 else None,
                                            "z_series": md / math.sqrt(vs) if vs > 0 else None,
                                            "z_block": md / math.sqrt(vb) if vb > 0 else None,
                                            "deff_two_vs_series": v2 / vs if vs > 0 else None,
                                            "bss": float(1 - ent[cand]["brier"] / ent["fH"]["brier"])}
                res["cells"][f"h{hh}/{scored}/{k}"] = ent
                sL, sX = ent["L_all_vs_fH"], ent["fix_vs_fH"]
                log(f"  h={hh} {scored} k={k}: pos {ent['pos']} | R L_all {ent['L_all']['R']:.2f} fix "
                    f"{ent['fix']['R']:.2f} fH {ent['fH']['R']:.2f} | BSS vs fH L_all {sL['bss']:+.4f} (z2 "
                    f"{sL['z_two'] or 0:+.2f}, zS {sL['z_series'] or 0:+.2f}) fix {sX['bss']:+.4f} (z2 "
                    f"{sX['z_two'] or 0:+.2f})")
        # ---- effective independent deep events, with and without pooling (all dev rows)
        w_ce = D.cls_weights(R.cls)
        one = np.ones(R.n)
        isc = R.cls == 0
        for z in (-3.0, -4.0):
            ne = {"crypto_only": neff_events(R, isc, z, one, a.nb, gkey("ne1", hh, z)),
                  "all_rows_unweighted": neff_events(R, np.ones(R.n, bool), z, one, a.nb, gkey("ne2", hh, z)),
                  "all_class_equal": neff_events(R, np.ones(R.n, bool), z, w_ce, a.nb, gkey("ne3", hh, z)),
                  "non_crypto_class_equal": neff_events(R, ~isc, z, D.cls_weights(R.cls, ~isc), a.nb,
                                                        gkey("ne4", hh, z))}
            res["neff"][f"h{hh}/z{z}"] = ne
            log(f"  h={hh} z={z} neff events (two-way / series-only / block-only): " + "; ".join(
                f"{k_} {v_['events']} raw -> {v_['neff_events_two'] or 0:.0f} / {v_['neff_events_series'] or 0:.0f} / "
                f"{v_['neff_events_block'] or 0:.0f}" for k_, v_ in ne.items()))
        del R
    D.write_json(os.path.join(a.out, "fh-r16.json"), res)
    log("fh done")


DAY_ = 86400


# =============================================================================================
# power (draft projection only; no set is read)
# =============================================================================================
def cmd_power(a):
    from scipy.stats import norm
    log = logger(a.out, "power.log")
    log(f"R16 power start; code {D.git_sha()}")
    best = (a.cv or "V3+lam_cs").split("+")
    res = {"created_utc": D.now_iso(), "code_sha": D.git_sha(), "best_fix": "+".join(best), "cells": {}}
    # hypothetical targets: (series, 4-week blocks spanned by scored young rows); counts are public listing facts only
    targets = {"B14a-like (Gate, 197 pairs, ~8 y span)": (197, 103), "P3b-b (41 pairs, 2025-26)": (41, 19),
               "B18 (Poloniex 171 pairs, ~4 y)": (171, 52), "B19b (LBank 62 pairs, ~4.5 y)": (62, 58),
               "B14a+B18+B19b pooled": (430, 103)}
    for hh in (1, 3):
        R = D.Rows(a.rows, a.meta, hh)
        ids = np.where(np.isin(R.subs, ["b12", "b9"]))[0]
        insc = (R.cls == 0) & np.isin(R.sid, ids)
        young = insc & (R.age < L4.YOUNG_BARS)
        # library and fix trained without the scored series (both sets out)
        tr = ~insc
        idx = np.where(young)[0]
        lv = (-0.15, -0.20)
        w = D.cls_weights(R.cls, tr)
        lib = D.lib_from(R.m0, w)
        zt = np.log1p(np.array(lv))[None, :] / np.exp(R.lns0[idx])[:, None]
        P = {"L_all": np.stack([D.F_at(lib, zt[:, j]) for j in range(len(lv))], 1),
             "fix": fix_predict(R, tr, idx, best[0], best[1], lv)}
        # own and (a), as-of on the series' own rows (all its resolved rows, not only young)
        own = np.full((len(idx), len(lv)), np.nan)
        pa = np.full_like(own, np.nan)
        allrows = np.where(insc)[0]
        Yall = (R.depth[:, None] <= np.log1p(np.array(lv))[None, :])
        zk_all = np.log1p(np.array(lv))[None, :] / np.exp(R.lns0)[:, None]
        pos_of = {r: i for i, r in enumerate(idx)}
        for s in np.unique(R.sid[idx]):
            rr = allrows[R.sid[allrows] == s]
            rr = rr[np.argsort(R.day[rr], kind="mergesort")]
            o = L4.own_ecdf_asof(R.day[rr], R.end[rr], R.m0[rr], zk_all[rr])
            f = L4.own_freq_asof(R.day[rr], R.end[rr], Yall[rr].astype(float))
            for jj, r in enumerate(rr):
                i = pos_of.get(r)
                if i is not None:
                    own[i] = o[jj]
                    pa[i] = f[jj]
        e_const = Yall[tr & (R.cls == 0)].mean(axis=0)
        P["own"], P["a"], P["e"] = own, pa, np.tile(e_const, (len(idx), 1))
        okr = np.all(np.isfinite(own), axis=1) & np.all(np.isfinite(pa), axis=1)
        for j, k in enumerate(lv):
            y = Yall[idx][okr, j].astype(float)
            si, bl = R.sid[idx][okr], R.block[idx][okr]
            S_dev, G_dev = len(np.unique(si)), len(np.unique(bl))
            ent = {"rows": int(okr.sum()), "pos": int(y.sum()), "series": S_dev, "blocks": G_dev, "legs": {}}
            for cand in ("L_all", "fix"):
                ent["legs"][cand] = {}
                pc = P[cand][okr, j]
                ent[f"R_{cand}"] = float(pc.sum() / y.sum())
                for comp in ("own", "a", "e"):
                    d = (pc - y) ** 2 - (P[comp][okr, j] - y) ** 2
                    one = np.ones(len(d))
                    md = float(d.mean())
                    v = {mode: float(np.var(D.twoway_var(si, bl, d, one, a.nb, gkey("pw", hh, k, cand, comp, mode),
                                                         mode))) for mode in ("two", "series", "block")}
                    viid = float(np.var(d) / len(d))
                    leg = {"mean_d": md, "bss": float(1 - np.mean((pc - y) ** 2) / np.mean((P[comp][okr, j] - y) ** 2)),
                           "z_two": md / math.sqrt(v["two"]), "var": v, "var_iid": viid}
                    proj = {}
                    for tn, (S_new, G_new) in targets.items():
                        vs = max(v["series"] - viid, 0.0) * S_dev / S_new
                        vb = max(v["block"] - viid, 0.0) * G_dev / G_new
                        vi = viid * S_dev / S_new          # rows scale with series (young windows <= 365 bars)
                        vn = vs + vb + vi
                        zn = abs(md) / math.sqrt(vn) if md < 0 else 0.0
                        proj[tn] = {"z_proj": zn, "power_holm1": float(norm.cdf(zn - 1.645)) if md < 0 else 0.0,
                                    "power_holm2": float(norm.cdf(zn - 1.960)) if md < 0 else 0.0}
                    leg["projection"] = proj
                    ent["legs"][cand][comp] = leg
                for tn in targets:
                    ent.setdefault("joint_tests_holm2", {}).setdefault(cand, {})[tn] = float(np.prod(
                        [ent["legs"][cand][c]["projection"][tn]["power_holm2"] for c in ("own", "a", "e")]))
            res["cells"][f"h{hh}/{k}"] = ent
            log(f"  young h={hh} k={k}: rows {ent['rows']} pos {ent['pos']} S {S_dev} G {G_dev} | R L_all "
                f"{ent['R_L_all']:.2f} fix {ent['R_fix']:.2f} | z_two fix vs own/a/e " +
                " ".join(f"{ent['legs']['fix'][c]['z_two']:+.2f}" for c in ("own", "a", "e")) + " | L_all " +
                " ".join(f"{ent['legs']['L_all'][c]['z_two']:+.2f}" for c in ("own", "a", "e")) +
                " | joint Holm2 fix: " + "; ".join(f"{tn.split(' ')[0]} {v_:.2f}"
                                                   for tn, v_ in ent["joint_tests_holm2"]["fix"].items()))
        del R
    D.write_json(os.path.join(a.out, "power-r16.json"), res)
    log("power done")


# =============================================================================================
# pitnet: cross-group dispersion net of class composition; within-class splits; D-R15.0c slope reproduction
# =============================================================================================
def cmd_pitnet(a):
    log = logger(a.out, "pitnet.log")
    log(f"R16 pitnet start; code {D.git_sha()}")
    res = {"created_utc": D.now_iso(), "code_sha": D.git_sha(), "h": {}}
    for hh in D.H_BARS:
        R = D.Rows(a.rows, a.meta, hh)
        G, cuts = D.groupings(R)
        lvl = 0.5 * R.lnLR
        G["level_decile"] = np.digitize(lvl, np.quantile(lvl, np.linspace(0.1, 0.9, 9)))
        Fc = {z: np.array([np.mean(R.m0[R.cls == ci] <= z) for ci in range(len(CLASSES))]) for z in ZS}
        out = {"net_of_class": {}, "within_class": {}, "crypto_pdecile": {}}
        for nm in ("vstate_decile", "era", "age", "level_decile"):
            g = G[nm]
            ent = {}
            for z in ZD:
                st = []
                for k in np.unique(g):
                    mk = g == k
                    y = (R.m0[mk] <= z).astype(float)
                    st.append(dict(D.group_ratio_ci(R.sid[mk], R.block[mk], y, Fc[z][R.cls[mk]], a.nb,
                                                    gkey("net", hh, nm, k, z)), group=int(k)))
                ent[str(z)] = {"groups": st, "tau": D.excess_dispersion([s for s in st if s.get("lnR") is not None])}
            out["net_of_class"][nm] = ent
            log(f"  h={hh} net-of-class {nm}: tau z-2/-3/-4 " + " ".join(
                f"{(ent[str(z)]['tau'] or {}).get('tau', float('nan')):.3f}" for z in ZD) + " | R(z-3) " +
                " ".join(f"{s.get('R', float('nan')):.2f}" for s in ent["-3.0"]["groups"]))
        for ci, c in ((0, "crypto"), (1, "equity"), (3, "fx")):
            for nm in ("vstate_decile", "era", "age"):
                g = G[nm]
                isc = R.cls == ci
                ent = {}
                for z in ZD:
                    st = []
                    for k in np.unique(g[isc]):
                        mk = isc & (g == k)
                        if mk.sum() < 2000:
                            continue
                        y = (R.m0[mk] <= z).astype(float)
                        st.append(dict(D.group_ratio_ci(R.sid[mk], R.block[mk], y, np.full(int(mk.sum()), Fc[z][ci]),
                                                        a.nb, gkey("win", hh, c, nm, k, z)), group=int(k)))
                    ent[str(z)] = {"groups": st, "tau": D.excess_dispersion([s for s in st if s.get("lnR") is not None])}
                out["within_class"][f"{c}/{nm}"] = ent
                log(f"  h={hh} within {c} {nm}: tau z-2/-3/-4 " + " ".join(
                    f"{(ent[str(z)]['tau'] or {}).get('tau', float('nan')):.3f}" for z in ZD) + " | R(z-3) " +
                    " ".join(f"{s.get('R', float('nan')):.2f}" for s in ent["-3.0"]["groups"]))
        # D-R15.0c reproduction: crypto, pooled library forecast deciles at fixed % levels
        w = D.cls_weights(R.cls)
        lib = D.lib_from(R.m0, w)
        isc = np.where(R.cls == 0)[0]
        for k in (-0.15, -0.25, -0.40):
            zt = math.log1p(k) / np.exp(R.lns0[isc])
            p = D.F_at(lib, zt)
            y = (R.depth[isc] <= math.log1p(k)).astype(float)
            q = np.quantile(p, np.linspace(0.1, 0.9, 9))
            b = np.digitize(p, q)
            out["crypto_pdecile"][str(k)] = [{"R": float(y[b == d].sum() / p[b == d].sum()), "pos": int(y[b == d].sum()),
                                              "mean_vstate": float(R.vstate[isc][b == d].mean()),
                                              "mean_ln_sigma_level": float(lvl[isc][b == d].mean())} for d in range(10)]
            log(f"  h={hh} crypto p-decile k={k}: R " + " ".join(f"{e_['R']:.2f}" for e_ in out["crypto_pdecile"][str(k)])
                + " | vstate " + " ".join(f"{e_['mean_vstate']:+.2f}" for e_ in out["crypto_pdecile"][str(k)]))
        res["h"][str(hh)] = out
        del R
    D.write_json(os.path.join(a.out, "pitnet-r16.json"), res)
    log("pitnet done")
