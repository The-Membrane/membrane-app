"""Q26 R28: redesigned crowding correction for near-line borrower odds. DEVELOPMENT ONLY (seen data).

Design, arms, bins, shrinkage, fitting window, primary rule, guards and power: membrane-board
design/q26-r28-crowding-redesign-2026-10-25.md (registered before any score of this script).

  python3 r28_crowd.py --mode power --datasets DS --scr SCR --out OUT     # outcome-free power (arm p is true)
  python3 r28_crowd.py --mode score --datasets DS --scr SCR --out OUT [--commit C]

SCR holds the R11.1-v5 scratch rows-labels.npz and fh-dense.npz (Aave V3 Polygon, development). OUT receives
address-free aggregates only. No address, account id, key or secret is written.

Arms judged (fixed at registration), all on the R25 cell grid band x u6 bin x dn bin x n10 count bin:
  W   position-weighted fit: each ladder fit row (series-day, band) is weighted by the number of positions of that
      band on that series-day at origin (normalised to mean 1 over fit rows with a position), shrunk toward A.
  S   crowding surge: each R25-B cell is split by the surge ratio (n10 + 1) / (1 + mean n10 of the 7 prior days)
      at the per-count-bin median; day-weighted fit, shrunk toward the B cell.
  WS  S cells with the W weights, shrunk toward the W cell.
References (not judged): raw (fH), A (no crowding) and B (R25 count arm, reproduction check).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v5_labels as LB  # noqa: E402
import r23_nearline as N  # noqa: E402
import r24_uplift as U  # noqa: E402  (grid_feats, TwoWay, r_block, bss_block, auc_diff, dump)
import r25_bincal as R  # noqa: E402  (parent_bin, crowd_bin, qidx, qstart, band_levels, constants)

HS = LB.HS
TL = R.TL
DAY = 86400
BKS = R.BKS
BNAMES = R.BNAMES
T_LO, T_HI, SCORE_LO = R.T_LO, R.T_HI, R.SCORE_LO
SEED_BOOT, NB = 20261025, 2000
SEED_NULL, NSIM = 28, 2000
KAPPA = 2.0
CALM_U6 = R.CALM_U6
NPB, NCB = R.NPB, R.NCB

# ---- registered (fixed at registration; feature-only quantiles, see the design note) ----
BASE_DAYS = 7                                      # surge baseline: mean n10 of the 7 prior days (all inside data)
SURGE_SPLIT = {1: 0.955, 2: 1.167, 3: 1.503}       # per R25 count bin (1-4, 5-18, >=19): median surge, label period
JUDGED = ["W", "S", "WS"]
ORDER = ["W", "S", "WS"]                           # selection order among passing arms
REFS = ["raw", "A", "B"]
ARMS = REFS + JUDGED
R_BAND = (0.8, 1.25)
GUARD_TOL = 0.02                                   # pooled guards (as R25)
LEVEL_TOL = 0.05                                   # per-level calm-origin ladder guard
LEVEL_MIN_POS = 30                                 # per-level guard judged only if raw expected count >= 30
AUC_TOL = -0.005
GUARD_Q = (0.01, 0.99)                             # guard band of the arm's own day-shared null (calm, ladder)
B_EXP_1D = (0.901, 0.804, 0.811)                   # R25 B 1 d near R (reproduction check, stop if > 0.006 off)
RAW_EXP_6H = (0.667, 0.507, 0.366)


def crowd_build(day, hf0, single, k6, nser):
    """Per series and calendar day: n_act, n10, band counts (0-2, 2-5, 5-10 %), surge. Origin positions only."""
    first = int(day.min() // DAY)
    nd = int(T_HI // DAY) - first + 1
    act = ~(hf0 < 1.0) & (single >= 0) & np.isfinite(k6) & (k6 < 0)
    di = (day // DAY - first).astype(np.int64)
    ok = act & (di >= 0) & (di < nd)
    key = single.astype(np.int64) * nd + di
    nact = np.bincount(key[ok], minlength=nser * nd).reshape(nser, nd).astype(float)
    nb = np.zeros((nser, 3, nd))
    for b, (lo, hi) in enumerate(BKS[:3]):
        m = ok & (-k6 >= lo) & (-k6 < hi)
        nb[:, b] = np.bincount(key[m], minlength=nser * nd).reshape(nser, nd)
    m10 = ok & (k6 > -0.10)
    n10 = np.bincount(key[m10], minlength=nser * nd).reshape(nser, nd).astype(float)
    cs = np.concatenate([np.zeros((nser, 1)), np.cumsum(n10, 1)], 1)
    base = np.full((nser, nd), np.nan)
    base[:, BASE_DAYS:] = (cs[:, BASE_DAYS:nd] - cs[:, :nd - BASE_DAYS]) / BASE_DAYS
    surge = (n10 + 1.0) / (base + 1.0)
    return {"first": first, "nd": nd, "nact": nact, "n10": n10, "nb": nb, "surge": surge}


def crowd_at(C, xi, ts):
    i = np.asarray(ts, np.int64) // DAY - C["first"]
    ok = (i >= 0) & (i < C["nd"])
    ic = np.clip(i, 0, C["nd"] - 1)
    n10 = np.where(ok, C["n10"][xi, ic], 0.0)
    nact = np.where(ok, C["nact"][xi, ic], 0.0)
    shr = np.where(nact > 0, n10 / np.maximum(nact, 1), 0.0)
    nb = np.where(ok[None, :], C["nb"][xi][:, ic], 0.0)
    sg = np.where(ok, C["surge"][xi, ic], np.nan)
    return n10, shr, nb, sg


def surge_bin(cbB, sg):
    sb = np.zeros(len(cbB), int)
    for c, e in SURGE_SPLIT.items():
        sb[(cbB == c) & (sg > e)] = 1
    sb[~np.isfinite(sg)] = -1                     # baseline missing -> the S / WS row falls back to its parent
    return sb


def fit_tables(tab, Hs, q):
    """Walk-forward tables from label-period ladder rows resolved before quarter q (origin + H <= start)."""
    a = R.qstart(q)
    PP, YP = np.zeros((3, NPB)), np.zeros((3, NPB))
    PB, YB_, PW, YW = (np.zeros((3, NPB, NCB)) for _ in range(4))
    PS, YS, PWS, YWS = (np.zeros((3, NPB, NCB, 2)) for _ in range(4))
    nrow = 0
    for T in tab:
        m = (T["ts"] + Hs <= a) & (T["pb"] >= 0)
        nrow += int(m.sum())
        pb, cb, sb = T["pb"][m], T["cbB"][m], T["sb"][m]
        ms = sb >= 0
        T["_m"] = (m, ms)
    for b in range(3):
        allw = np.concatenate([T["NB"][T["_m"][0], b] for T in tab])
        nbar = float(allw[allw > 0].mean()) if (allw > 0).any() else 1.0
        for T in tab:
            m, ms = T["_m"]
            pb, cb, sb = T["pb"][m], T["cbB"][m], T["sb"][m]
            sp, sy = T["SP"][m, b], T["SY"][m, b]
            w = T["NB"][m, b] / nbar
            np.add.at(PP[b], pb, sp)
            np.add.at(YP[b], pb, sy)
            np.add.at(PB[b], (pb, cb), sp)
            np.add.at(YB_[b], (pb, cb), sy)
            np.add.at(PW[b], (pb, cb), w * sp)
            np.add.at(YW[b], (pb, cb), w * sy)
            np.add.at(PS[b], (pb[ms], cb[ms], sb[ms]), sp[ms])
            np.add.at(YS[b], (pb[ms], cb[ms], sb[ms]), sy[ms])
            np.add.at(PWS[b], (pb[ms], cb[ms], sb[ms]), (w * sp)[ms])
            np.add.at(YWS[b], (pb[ms], cb[ms], sb[ms]), (w * sy)[ms])
    for T in tab:
        T.pop("_m", None)
    mA = (YP + KAPPA) / (PP + KAPPA)
    mB = (YB_ + KAPPA * mA[:, :, None]) / (PB + KAPPA)
    mW = (YW + KAPPA * mA[:, :, None]) / (PW + KAPPA)
    mS = (YS + KAPPA * mB[..., None]) / (PS + KAPPA)
    mWS = (YWS + KAPPA * mW[..., None]) / (PWS + KAPPA)
    return {"A": mA, "B": mB, "W": mW, "S": mS, "WS": mWS, "rows": nrow, "YP": YP}


def mult_of(tabs_q, arm, q, band, pb, cb, sb):
    out = np.ones(len(pb))
    for qq in np.unique(q):
        sel = (q == qq) & (pb >= 0) & (band >= 0) & (band <= 2)
        if not sel.any():
            continue
        M = tabs_q[int(qq)]
        if arm == "A":
            out[sel] = M["A"][band[sel], pb[sel]]
        elif arm in ("B", "W"):
            out[sel] = M[arm][band[sel], pb[sel], cb[sel]]
        else:
            par = "B" if arm == "S" else "W"
            v = M[par][band[sel], pb[sel], cb[sel]]
            s = sb[sel]
            h = s >= 0
            v[h] = M[arm][band[sel][h], pb[sel][h], cb[sel][h], s[h]]
            out[sel] = v
    return out


def load(a, need_y):
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    series = [str(x) for x in Z["series"]]
    d = {"F": F, "series": series, "day": Z["day"], "hf0": Z["hf0"], "single": Z["singleX"], "kX": Z["kX"]}
    yB = Z["yB"]
    d["valid"] = yB >= 0                           # label defined (validity only)
    d["yB"] = yB if need_y else None
    del yB
    return d


def prepare_H(D, C, grids, hj, Hh, bl):
    """Ladder fit table, walk-forward tables, and the scored position set with all arm probabilities."""
    F, series = D["F"], D["series"]
    levels = F["levels"]
    Hs = Hh * 3600
    tab = []
    for xi, x in enumerate(series):
        key = f"{x}|{Hh}|"
        ts = F[key + "ts"]
        o = np.argsort(ts)
        ts = ts[o]
        m = (ts >= T_LO) & (ts <= T_HI)
        ts = ts[m]
        P = F[key + "fH"][o][m].astype(float)
        Y = F[key + "y"][o][m].astype(float)
        st, g = grids[x]
        f = U.grid_feats(st, g["close"], ts)
        n10, shr, nbv, sg = crowd_at(C, xi, ts)
        cbB = R.crowd_bin("B", n10, shr)
        T = {"ts": ts, "P": P, "Y": Y, "u6": f["u6"], "dn": f["dn"], "pb": R.parent_bin(f["u6"], f["dn"]),
             "cbB": cbB, "sb": surge_bin(cbB, sg), "NB": nbv.T.copy(), "q": R.qidx(ts)}
        T["SP"] = np.stack([P[:, bl[b]].sum(1) for b in range(3)], 1)
        T["SY"] = np.stack([Y[:, bl[b]].sum(1) for b in range(3)], 1)
        tab.append(T)
    q_lo, q_hi = int(R.qidx([SCORE_LO])[0]), int(R.qidx([T_HI])[0])
    tabs_q = {q: fit_tables(tab, Hs, q) for q in range(q_lo, q_hi + 1)}
    fin = fit_tables(tab, Hs, q_hi + 1)           # all rows resolved before 2026-10-01: the frozen table

    day, hf0, single, kX = D["day"], D["hf0"], D["single"], D["kX"]
    sub = ~(hf0 < 1.0) & (single >= 0) & D["valid"][:, hj] & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) \
        & (kX[:, hj] > -0.30) & (day >= SCORE_LO) & (day <= T_HI)
    vi = np.nonzero(sub)[0]
    k = kX[vi, hj].astype(float)
    sx = single[vi].astype(int)
    dv = day[vi]
    pf = np.full(len(vi), np.nan)
    u6 = np.full(len(vi), np.nan)
    dn = np.full(len(vi), np.nan)
    n10 = np.zeros(len(vi))
    shr = np.zeros(len(vi))
    sg = np.full(len(vi), np.nan)
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
        u6[m], dn[m] = fx["u6"], fx["dn"]
        a_, b_, _, c_ = crowd_at(C, xi, tt)
        n10[m], shr[m], sg[m] = a_, b_, c_
    ok = np.isfinite(pf)
    vi, k, sx, dv, pf, u6, dn, n10, shr, sg = (v[ok] for v in (vi, k, sx, dv, pf, u6, dn, n10, shr, sg))
    bk = np.full(len(k), -1)
    for bi, (lo, hi) in enumerate(BKS):
        bk[(-k >= lo) & (-k < hi)] = bi
    pb = R.parent_bin(u6, dn)
    cbB = R.crowd_bin("B", n10, shr)
    sb = surge_bin(cbB, sg)
    qv = R.qidx(dv)
    P = {"raw": pf}
    for arm in ARMS[1:]:
        P[arm] = np.minimum(1.0, pf * mult_of(tabs_q, arm, qv, bk, pb, cbB, sb))
    pos = {"vi": vi, "sx": sx, "dv": dv, "bk": bk, "u6": u6, "dn": dn, "cbB": cbB, "sb": sb, "P": P,
           "calm": (dn <= 0) & (u6 <= CALM_U6), "first": C["first"]}
    return tab, tabs_q, fin, pos


def ladder_rows(tab, tabs_q, arms, bl, C):
    """Scored-origin (2023-01 ..) ladder rows: per arm the P matrix (rows x all levels), Y, calm flag, group index."""
    out = {"P": {arm: [] for arm in arms}, "Y": [], "calm": [], "gsd": [], "di": []}
    for xi, T in enumerate(tab):
        m = T["ts"] >= SCORE_LO
        for arm in arms:
            Pc = T["P"][m].copy()
            if arm != "raw":
                for b in range(3):
                    mu = mult_of(tabs_q, arm, T["q"][m], np.full(m.sum(), b), T["pb"][m], T["cbB"][m], T["sb"][m])
                    Pc[:, bl[b]] = np.minimum(1.0, Pc[:, bl[b]] * mu[:, None])
            out["P"][arm].append(Pc)
        out["Y"].append(T["Y"][m])
        out["calm"].append((T["dn"][m] <= 0) & (T["u6"][m] <= CALM_U6))
        di = (T["ts"][m] // DAY - C["first"]).astype(np.int64)
        out["di"].append(di)
        out["gsd"].append(xi * C["nd"] + di)
    for k in ("Y", "calm", "gsd", "di"):
        out[k] = np.concatenate(out[k])
    out["P"] = {arm: np.concatenate(v) for arm, v in out["P"].items()}
    return out


def lad_sp(Pm, calm, near_lv):
    """Column sums for the ladder guard columns from a (rows x all levels) matrix (p or y)."""
    Pn = Pm[:, near_lv]
    return np.r_[Pn[calm].sum(0), Pn.sum(), Pn[calm].sum()]


def sim_sums(truths, pos, pos_masks, lad, near_lv, C, nser, nsim, seed, chunk=50):
    """Shared-path simulated positives under 'truth arm p is true', both bounds: one uniform per series x day ('sd')
    or one per day for all series ('day'). Uniforms are indexed by (series, calendar day), so positions and ladder
    rows of a series-day share a draw and the same seed couples every H. No observed label is read.
    -> {bound: {truth: {"pos": (nsim, Kp), "lad": (nsim, 14)}}}"""
    keep = np.zeros(len(pos["dv"]), bool)
    for m_ in pos_masks.values():
        keep |= m_
    di = (np.asarray(pos["dv"], np.int64)[keep] // DAY - C["first"]).astype(np.int64)
    gsd = pos["sx"][keep].astype(np.int64) * C["nd"] + di
    M = np.stack([m_[keep].astype(np.float32) for m_ in pos_masks.values()], 1)
    Pp = {t: pos["P"][t][keep].astype(np.float32) for t in truths}
    Pl = {t: lad["P"][t][:, near_lv].astype(np.float32) for t in truths}
    calm = lad["calm"]
    out = {}
    for bound in ("sd", "day"):
        rng = np.random.default_rng(seed)
        res = {t: {"pos": [], "lad": []} for t in truths}
        done = 0
        while done < nsim:
            m = min(chunk, nsim - done)
            Usd = rng.random((m, nser * C["nd"]), dtype=np.float32)
            Ud = rng.random((m, C["nd"]), dtype=np.float32)
            Up = Usd[:, gsd] if bound == "sd" else Ud[:, di]
            Ul = Usd[:, lad["gsd"]] if bound == "sd" else Ud[:, lad["di"]]
            for t in truths:
                ys = (Up < Pp[t][None, :]).astype(np.float32)
                res[t]["pos"].append(ys @ M)
                yl = Ul[:, :, None] < Pl[t][None, :, :]                        # m x rows x 12 (nested levels)
                res[t]["lad"].append(np.concatenate([yl[:, calm, :].sum(1), yl.sum((1, 2))[:, None],
                                                     yl[:, calm, :].sum((1, 2))[:, None]], 1).astype(float))
            done += m
        out[bound] = {t: {k: np.concatenate(v, 0) for k, v in d.items()} for t, d in res.items()}
    return out


def q3(v):
    v = v[np.isfinite(v)]
    return [float(np.quantile(v, q)) for q in (0.05, 0.5, 0.95)] if len(v) else None


def qb(v):
    """Guard band of the arm's own day-shared null: the GUARD_Q quantiles (multiplicity-sized, see the design)."""
    v = v[np.isfinite(v)]
    return [float(np.quantile(v, GUARD_Q[0])), float(np.quantile(v, GUARD_Q[1]))] if len(v) else None


def ratio(num, den):
    with np.errstate(divide="ignore", invalid="ignore"):
        return num / den


def ok_guard(ra, rr, band, tol):
    """Pass when the arm is not farther from 1 than raw (+ tol), or the arm R lies inside its own day-shared null
    5-95% band. Works on scalars or arrays; a non-finite arm R fails unless raw is also non-finite."""
    ra, rr = np.asarray(ra, float), np.asarray(rr, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        farther = np.abs(np.log(ra)) > np.abs(np.log(rr)) + tol
    inside = (ra >= band[0]) & (ra <= band[1]) if band is not None else np.zeros_like(ra, bool)
    return ~farther | inside


def lvl_names(levels, near_lv):
    return [f"{-levels[j] * 100:g}%" for j in near_lv]


def aux_sims(pos_by_H, truths, C, nser, nsim, seed):
    """Outcome-free AUC (1 d) and Brier-point (1 d, 3 d, 7 d) behaviour under 'arm p is true', all 0-30% positions.
    P(BSS point >= 0) is a lower bound on P(two-way 90% upper bound >= 0)."""
    res = {}
    for bound in ("sd", "day"):
        res[bound] = {t: {} for t in truths}
        for H in ("1d", "3d", "7d"):
            pos = pos_by_H[H]
            allm = pos["bk"] >= 0
            di = (np.asarray(pos["dv"], np.int64)[allm] // DAY - C["first"]).astype(np.int64)
            gsd = pos["sx"][allm].astype(np.int64) * C["nd"] + di
            q = pos["P"]["raw"][allm]
            iq = np.unique(q, return_inverse=True)[1]
            rng = np.random.default_rng(seed)
            for t in truths:
                p = pos["P"][t][allm]
                ip = np.unique(p, return_inverse=True)[1]
                bss, aucd = [], []
                for s in range(nsim):
                    Usd = rng.random(nser * C["nd"])
                    Ud = rng.random(C["nd"])
                    y = ((Usd[gsd] if bound == "sd" else Ud[di]) < p).astype(float)
                    bss.append(1 - ((p - y) ** 2).sum() / ((q - y) ** 2).sum())
                    if H == "1d":
                        one = np.ones(len(y))
                        aucd.append(U.wauc(y, ip, ip.max() + 1, one) - U.wauc(y, iq, iq.max() + 1, one))
                res[bound][t][H] = {"bss": np.array(bss), "auc": np.array(aucd) if aucd else None}
    return res


def run_power(a, D, C, grids, bl):
    """Outcome-free: labels simulated from each judged arm's own p. Real 184-week calendar, no week resampling."""
    series = D["series"]
    levels = D["F"]["levels"]
    near_lv = np.concatenate(bl)
    out = {"what": "Q26 R28 pre-score power: P(rule passes | arm p is true), shared-path labels, real development "
                   "calendar (no week resampling), both independence bounds; coupled across H by series-day",
           "nsim": a.nsim, "nsim_aux": a.nsim_aux, "seed": SEED_NULL, "by_arm": {}}
    st, meta, pos_by_H = {}, {}, {}
    for hj, Hh in enumerate(HS):
        tab, tabs_q, _, pos = prepare_H(D, C, grids, hj, Hh, bl)
        lad = ladder_rows(tab, tabs_q, ["raw"] + JUDGED, bl, C)
        bk, calm = pos["bk"], pos["calm"]
        near = (bk >= 0) & (bk <= 2)
        masks = {"pooled": near, "b0": bk == 0, "b1": bk == 1, "b2": bk == 2, "calm": near & calm}
        sdk = pos["sx"].astype(np.int64) * 10**7 + pos["dv"] // DAY
        meta[TL[Hh]] = {"positions_0_10": int(near.sum()), "positions_0_30": int((bk >= 0).sum()),
                        "series_days_0_10": int(len(np.unique(sdk[near]))),
                        "weeks": int(len(np.unique((pos["dv"] // DAY - 4) // 7))), "ladder_rows": int(len(lad["Y"]))}
        sims = sim_sums(JUDGED, pos, masks, lad, near_lv, C, len(series), a.nsim, SEED_NULL)
        sp = {arm: np.array([pos["P"][arm][masks[kk]].sum() for kk in masks]) for arm in ["raw"] + JUDGED}
        lsp = {arm: lad_sp(lad["P"][arm], lad["calm"], near_lv) for arm in ["raw"] + JUDGED}
        st[TL[Hh]] = (sims, list(masks), sp, lsp)
        if TL[Hh] in ("1d", "3d", "7d"):
            pos_by_H[TL[Hh]] = {k: pos[k] for k in ("bk", "sx", "dv", "P")}
        print(f"power H {Hh}: {meta[TL[Hh]]} {time.time() - T0:.0f}s", flush=True)
    out["calendar"] = meta
    aux = aux_sims(pos_by_H, JUDGED, C, len(series), a.nsim_aux, SEED_NULL + 1)
    for arm in JUDGED:
        ea = {}
        # day-shared 5-95% bands of the arm's own null (thresholds used by the rule), from the day draws
        bands = {}
        for H, (sims, keys, sp, lsp) in st.items():
            d = sims["day"][arm]
            bands[H] = {"pos": [q3(ratio(sp[arm][i], d["pos"][:, i])) for i in range(len(keys))],
                        "gpos": [qb(ratio(sp[arm][i], d["pos"][:, i])) for i in range(len(keys))],
                        "lad": [qb(ratio(lsp[arm][i], d["lad"][:, i])) for i in range(len(lsp[arm]))]}
        for bound in ("sd", "day"):
            def Rp(H, who, kk):
                sims, keys, sp, _ = st[H]
                return ratio(sp[who][keys.index(kk)], sims[bound][arm]["pos"][:, keys.index(kk)])

            def Rl(H, who, i):
                sims, _, _, lsp = st[H]
                return ratio(lsp[who][i], sims[bound][arm]["lad"][:, i])
            r1 = Rp("1d", arm, "pooled")
            q05_day = bands["1d"]["pos"][0][0]
            prim = (r1 >= R_BAND[0]) & (r1 <= R_BAND[1]) & (r1 >= q05_day)
            calm = np.ones(len(r1), bool)
            for H in ("6h", "1d"):
                b = bands[H]["gpos"][4]
                calm &= ok_guard(Rp(H, arm, "calm"), Rp(H, "raw", "calm"), (b[0], b[1]), GUARD_TOL)
            ladg = np.ones(len(r1), bool)
            for H in st:
                lsp = st[H][3]
                for i in range(14):
                    b = bands[H]["lad"][i]
                    if i < 12:
                        if lsp["raw"][i] < LEVEL_MIN_POS:               # judged only with raw expected count >= 30
                            continue
                        tol = LEVEL_TOL
                    else:
                        tol = GUARD_TOL
                    ladg &= ok_guard(Rl(H, arm, i), Rl(H, "raw", i), (b[0], b[1]), tol)
            longg = np.ones(len(r1), bool)
            for H in ("3d", "7d"):
                for kk in ("b0", "b1", "b2"):
                    ra, rr = Rp(H, arm, kk), Rp(H, "raw", kk)
                    longg &= ok_guard(ra, rr, R_BAND, GUARD_TOL)
            per_band = np.ones(len(r1), bool)
            for kk in ("b0", "b1", "b2"):
                rb = Rp("1d", arm, kk)
                per_band &= (rb >= R_BAND[0]) & (rb <= R_BAND[1])
            r6 = Rp("6h", arm, "pooled")
            ax = aux[bound][arm]
            aucok = ax["1d"]["auc"] >= AUC_TOL
            bssok = (ax["1d"]["bss"] >= 0) & (ax["3d"]["bss"] >= 0) & (ax["7d"]["bss"] >= 0)
            main_joint = float((prim & calm & ladg & longg).mean())
            aux_joint = float((aucok & bssok).mean())
            ea[bound] = {"primary_pass": round(float(prim.mean()), 3),
                         "calm_guard_pass": round(float(calm.mean()), 3), "ladder_guard_pass": round(float(ladg.mean()), 3),
                         "long_guard_pass": round(float(longg.mean()), 3),
                         "primary_calm_ladder_long_joint": round(main_joint, 3),
                         "auc_guard_pass": round(float(aucok.mean()), 3),
                         "brier_guard_pass_lower_bound": round(float(bssok.mean()), 3),
                         "full_rule_power_approx": round(main_joint * aux_joint, 3),
                         "q05_q50_q95_1d_pooled": q3(r1), "day_shared_q05_threshold": round(q05_day, 4),
                         "secondary_1d_all3_bands_in_0.8_1.25": round(float(per_band.mean()), 3),
                         "descriptive_6h_pooled_in_0.8_1.25": round(float(((r6 >= 0.8) & (r6 <= 1.25)).mean()), 3),
                         "q05_q50_q95_6h_pooled": q3(r6)}
        out["by_arm"][arm] = ea
        print(arm, json.dumps(ea), flush=True)
    os.makedirs(a.out, exist_ok=True)
    U.dump(out, os.path.join(a.out, "r28-power.json"))


def run_score(a, D, C, grids, bl):
    F, series = D["F"], D["series"]
    levels = F["levels"]
    near_lv = np.concatenate(bl)
    far_lv = np.nonzero((-levels > 0.10 + 1e-12) & (-levels <= 0.30 + 1e-12))[0]
    names = lvl_names(levels, near_lv)
    yB = D["yB"]
    out = {"what": "Q26 R28 redesigned crowding correction (W position-weighted, S surge, WS both) of TWAP-(fH), "
                   "development, Aave V3 Polygon label B; design membrane-board design/q26-r28-crowding-redesign-2026-10-25.md",
           "grid": {"u6_edges": R.U6_EDGES.tolist(), "dn_edges": R.DN_EDGES.tolist(), "n10_edges": R.CNT_EDGES.tolist(),
                    "surge_split_by_count_bin": SURGE_SPLIT, "base_days": BASE_DAYS, "kappa": KAPPA, "calm_u6": CALM_U6},
           "bootstrap": {"B": NB, "seed": SEED_BOOT, "kind": "pigeonhole two-way series x week; one-way week"},
           "null": {"nsim": a.nsim, "seed": SEED_NULL, "kind": "one uniform per series x day (sd) and per day (day)"},
           "by_H": {}, "final_tables": {}}
    for hj, Hh in enumerate(HS):
        tab, tabs_q, fin, pos = prepare_H(D, C, grids, hj, Hh, bl)
        out["final_tables"][TL[Hh]] = {arm: np.round(fin[arm], 5).tolist() for arm in ("A", "B", "W", "S", "WS")}
        out["final_tables"][TL[Hh]]["fit_rows"] = fin["rows"]
        lad = ladder_rows(tab, tabs_q, ARMS, bl, C)
        P, bk, sx, dv, calm = pos["P"], pos["bk"], pos["sx"], pos["dv"], pos["calm"]
        yb = yB[pos["vi"], hj].astype(float)
        pf = P["raw"]
        tw = U.TwoWay(sx, dv, len(series), seed=SEED_BOOT, B=NB)
        nearm = (bk >= 0) & (bk <= 2)
        allm = bk >= 0
        masks = {"pooled": nearm, "b0": bk == 0, "b1": bk == 1, "b2": bk == 2, "calm": nearm & calm}
        sims = sim_sums(ARMS, pos, masks, lad, near_lv, C, len(series), a.nsim, SEED_NULL)
        ent = {"rows_scored": int(len(bk)), "feature_missing_rows": int((R.parent_bin(pos["u6"], pos["dn"]) < 0).sum()),
               "surge_missing_rows": int((pos["sb"] < 0).sum()), "arms": {}, "null": {}, "ladder": {}}
        ylad = lad_sp(lad["Y"], lad["calm"], near_lv)
        for arm in ARMS:
            p = P[arm]
            e = {"R": {BNAMES[b]: U.r_block(tw, p, yb, bk == b) for b in range(len(BKS))}}
            e["R"]["near_0-10%"] = U.r_block(tw, p, yb, nearm)
            e["calm_near_R"] = U.r_block(tw, p, yb, nearm & calm)
            e["calm_R_by_bucket"] = {BNAMES[b]: U.r_block(tw, p, yb, (bk == b) & calm) for b in range(3)}
            if arm != "raw":
                e["bss_vs_raw_all"] = U.bss_block(tw, yb, p, pf, allm)
                e["bss_vs_raw_near"] = U.bss_block(tw, yb, p, pf, nearm)
                e["auc_all"] = U.auc_diff(tw, yb, p, pf, allm)
                e["uplift_vs_A_near"] = float(p[nearm].sum() / P["A"][nearm].sum())
            else:
                e["auc_all"] = {"auc": LB.auc(p[allm], yb[allm])}
            ent["arms"][arm] = e
            nul = {}
            for bound in ("sd", "day"):
                sp = np.array([p[masks[kk]].sum() for kk in masks])
                d = sims[bound][arm]["pos"]
                nul[bound] = {}
                for i, kk in enumerate(masks):
                    r = ratio(sp[i], d[:, i])
                    nul[bound][kk] = {"q05_q50_q95": q3(r), "guard_band": qb(r), "valid": int(np.isfinite(r).sum()),
                                      "dropped": int((~np.isfinite(r)).sum())}
            ent["null"][arm] = nul
            lsp = lad_sp(lad["P"][arm], lad["calm"], near_lv)
            lsp_raw = lad_sp(lad["P"]["raw"], lad["calm"], near_lv)
            dl = sims["day"][arm]["lad"]
            cols = [f"ordinary {nm}" for nm in names] + ["all-origin near pooled", "ordinary near pooled"]
            ent["ladder"][arm] = {c: {"R": float(lsp[i] / ylad[i]) if ylad[i] else None, "pos": int(ylad[i]),
                                      "raw_expected": float(lsp_raw[i]),
                                      "null_day": q3(ratio(lsp[i], dl[:, i])),
                                      "guard_band": qb(ratio(lsp[i], dl[:, i]))} for i, c in enumerate(cols)}
            Pall = lad["P"][arm]
            Yall = lad["Y"]
            ent["ladder"][arm]["all_origin_per_level"] = {
                f"{-levels[j] * 100:g}%": {"R": float(Pall[:, j].sum() / Yall[:, j].sum()) if Yall[:, j].sum() else None,
                                           "pos": int(Yall[:, j].sum())} for j in np.r_[near_lv, far_lv]}
        sdk = sx[nearm].astype(np.int64) * 10**7 + dv[nearm] // DAY
        ent["near_series_days"] = int(len(np.unique(sdk)))
        ent["near_series_days_with_pos"] = int(len(np.unique(sdk[yb[nearm] > 0])))
        out["by_H"][TL[Hh]] = ent
        rr = {arm: [round(ent["arms"][arm]["R"][BNAMES[b]]["R"], 3) for b in range(3)] +
              [round(ent["arms"][arm]["R"]["near_0-10%"]["R"], 3)] for arm in ARMS}
        print(f"H {Hh}: " + ("done (smoke: values hidden)" if a.smoke else f"near R (3 bands, pooled) {json.dumps(rr)}")
              + f" | {time.time() - T0:.0f}s", flush=True)
        if not a.smoke and Hh == 6 and any(abs(g_ - e_) > 0.006 for g_, e_ in zip(rr["raw"][:3], RAW_EXP_6H)):
            raise SystemExit(f"STOP: raw 6 h R {rr['raw']} does not reproduce {RAW_EXP_6H}")
        if not a.smoke and Hh == 24 and any(abs(g_ - e_) > 0.006 for g_, e_ in zip(rr["B"][:3], B_EXP_1D)):
            raise SystemExit(f"STOP: B 1 d R {rr['B']} does not reproduce R25 {B_EXP_1D}")
    out["rule"] = rule(out)
    sel = out["rule"]["selected"]
    os.makedirs(a.out, exist_ok=True)
    U.dump(out, os.path.join(a.out, "r28-crowd.json"))
    if sel and not a.smoke:
        fz = {"what": f"Q26 R28 FROZEN arm {sel} (development pass; frozen before any confirmation step)",
              "arm": sel, "grid": out["grid"], "weights": "W/WS: fit row weight n_band(series-day) / mean n_band over "
              "fit rows with n_band > 0, per band; n_band = positions of the band at the origin (6 h column distance)",
              "fit_rule": "label-period ladder rows (2022-03-16 on), all rows resolved before 2026-10-01; kappa 2; "
                          "hierarchy A <- B <- S, A <- W <- WS",
              "tables": {H: {k: v for k, v in t.items() if k in ("A", "B", "W", "S", "WS", "fit_rows")}
                         for H, t in out["final_tables"].items()},
              "code_commit": a.commit, "code_sha256": file_sha(os.path.abspath(__file__)),
              "frozen_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        U.dump(fz, os.path.join(a.out, "r28-frozen.json"))
    print("selected:", sel, f"{time.time() - T0:.0f}s", flush=True)


def rule(out):
    res = {}
    e1 = out["by_H"]["1d"]
    for arm in JUDGED:
        fails, g = [], {}
        R1 = e1["arms"][arm]["R"]["near_0-10%"]
        q_day = e1["null"][arm]["day"]["pooled"]["q05_q50_q95"]
        q_sd = e1["null"][arm]["sd"]["pooled"]["q05_q50_q95"]
        ok = R1["R"] is not None and R_BAND[0] <= R1["R"] <= R_BAND[1] and q_day is not None and R1["R"] >= q_day[0]
        prim = {"R": R1["R"], "pos": R1["pos"], "ci90_twoway": R1.get("ci90_twoway"), "valid": R1.get("valid_twoway"),
                "null_day_q05": q_day[0], "null_sd_q05_reported": q_sd[0],
                "above_sd_q05_reported": bool(R1["R"] >= q_sd[0]), "pass": bool(ok)}
        if not ok:
            fails.append("primary 1d pooled")
        for H in ("6h", "1d"):
            ent = out["by_H"][H]
            r0, r1 = ent["arms"]["raw"]["calm_near_R"]["R"], ent["arms"][arm]["calm_near_R"]["R"]
            b = ent["null"][arm]["day"]["calm"]["guard_band"]
            okc = bool(ok_guard(r1, r0, (b[0], b[1]), GUARD_TOL))
            g[f"{H} calm positions"] = {"raw": r0, "arm": r1, "pos": ent["arms"][arm]["calm_near_R"]["pos"],
                                        "null_day": b, "pass": okc}
            if not okc:
                fails.append(f"calm {H}")
        for H, ent in out["by_H"].items():
            L, L0 = ent["ladder"][arm], ent["ladder"]["raw"]
            for c, v in L.items():
                if c == "all_origin_per_level":
                    continue
                pooled = "pooled" in c
                judged = pooled or v["raw_expected"] >= LEVEL_MIN_POS
                okl = (not judged) or bool(ok_guard(v["R"], L0[c]["R"], tuple(v["guard_band"]),
                                                    GUARD_TOL if pooled else LEVEL_TOL))
                g[f"{H} ladder {c}"] = {"raw": L0[c]["R"], "arm": v["R"], "pos": v["pos"], "guard_band": v["guard_band"],
                                        "judged": judged, "pass": okl}
                if not okl:
                    fails.append(f"ladder {H} {c}")
        for H in ("3d", "7d"):
            ent = out["by_H"][H]
            for b in BNAMES[:3]:
                r0, r1 = ent["arms"]["raw"]["R"][b]["R"], ent["arms"][arm]["R"][b]["R"]
                okb = bool(ok_guard(r1, r0, R_BAND, GUARD_TOL))
                g[f"{H} near {b}"] = {"raw": r0, "arm": r1, "pos": ent["arms"][arm]["R"][b]["pos"], "pass": okb}
                if not okb:
                    fails.append(f"long {H} {b}")
        au = e1["arms"][arm]["auc_all"]["diff"]
        g["1d auc"] = {"diff": au, "ci90_twoway": e1["arms"][arm]["auc_all"].get("ci90_twoway"), "pass": bool(au >= AUC_TOL)}
        if au < AUC_TOL:
            fails.append("auc 1d")
        for H in ("1d", "3d", "7d"):
            bs = out["by_H"][H]["arms"][arm]["bss_vs_raw_all"]
            ci = bs["ci90_twoway"]
            okb = ci is not None and ci[1] >= 0.0
            g[f"{H} bss"] = {"bss": bs["bss"], "ci90_twoway": ci, "margin_half_width": (ci[1] - ci[0]) / 2 if ci else None,
                             "valid": bs.get("valid_twoway"), "pass": bool(okb)}
            if not okb:
                fails.append(f"bss {H}")
        sec = {}
        for H in ("1d", "6h"):
            ent = out["by_H"][H]
            for kk, b in (("b0", "0-2%"), ("b1", "2-5%"), ("b2", "5-10%"), ("pooled", "near_0-10%")):
                sec[f"{H} {b}"] = {"R": ent["arms"][arm]["R"][b]["R"], "pos": ent["arms"][arm]["R"][b]["pos"],
                                   "ci90_twoway": ent["arms"][arm]["R"][b].get("ci90_twoway"),
                                   "null_day": ent["null"][arm]["day"][kk]["q05_q50_q95"],
                                   "null_sd": ent["null"][arm]["sd"][kk]["q05_q50_q95"]}
        res[arm] = {"primary": prim, "guards": g, "secondary_descriptive": sec, "fails": fails, "PASSES": len(fails) == 0}
    passing = [x for x in ORDER if res[x]["PASSES"]]
    res["selected"] = passing[0] if passing else None
    return res



def file_sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


T0 = time.time()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("power", "score"), required=True)
    for k in ("datasets", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    ap.add_argument("--nsim", type=int, default=NSIM)
    ap.add_argument("--nsim-aux", type=int, default=200)
    ap.add_argument("--commit", default="")
    ap.add_argument("--smoke", action="store_true", help="score mode on RANDOM labels (code test, no outcome read)")
    a = ap.parse_args()
    D = load(a, need_y=(a.mode == "score" and not a.smoke))
    if a.smoke:
        D["yB"] = (np.random.default_rng(0).random(D["valid"].shape) < 0.02).astype(np.int8)
    bl = R.band_levels(D["F"]["levels"])
    assert [len(x) for x in bl] == [4, 4, 4]
    C = crowd_build(D["day"], D["hf0"], D["single"], D["kX"][:, 0], len(D["series"]))
    grids = {x: LB.read_iii(a.datasets, LB.SERIES[x][1]) for x in D["series"]}
    print(f"loaded {len(D['day']):,} rows, mode {a.mode} {time.time() - T0:.0f}s", flush=True)
    if a.mode == "power":
        run_power(a, D, C, grids, bl)
    else:
        run_score(a, D, C, grids, bl)


if __name__ == "__main__":
    main()
