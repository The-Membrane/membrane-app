#!/usr/bin/env python3
"""Q26 R16.1: are the 7-30 d price-touch odds worth shipping as calibrated, labelled context?

membrane-board `design/Q26_ROUND16_PREREG.md` section R16.1. Parents: `design/HISTORY_TOUCH_PREREG_A6.md` (A6 D1-D3),
`design/Q26_ROUND13_PREREG.md` D-R13.5c, `design/q26-retro-twoway-2026-10-19.md`.

H1: (f) beats plain history (a) at 7 d and 30 d. H2: calibration (R and slope) of the displayed 7-30 d rungs holds in
every label class, not only HIGH.

DEVELOPMENT ON SEEN DATA ONLY in phase `dev`: the frozen A6 recipes (a), (f), (fbL), (fH) are re-run per series on
the A6 development pool (A6 build_all: holdouts, B-span, locked series, A4 18, blind 3, blind 4) and blind set 5
(read by A6.6, grade C for touch). No reserved or unseen set is opened by `dev` or `power`.

Phases
  dev     per-series day-level aggregates (squared error per rung, sums of p and y, mean logit per group) at 7/14/30 d
          -> <out>/agg/<series>.npz (the A6 recipes unchanged; (fHb) maps are skipped because (fHb) is not a candidate
          here and its maps do not enter (a), (f), (fbL) or (fH))
  ethbtc  the same aggregates from the published A6 ETH/BTC development predictions (Chainlink truth)
  stats   two-way (series x time block) statistics for H1 and H2 on a set of aggregate files -> json
  power   power projection (D-R13.5c rule: the test's own two-way bootstrap z, scaled to a target set's counts)

The A..A6 code is imported and never modified. Free data only. No address, key or secret.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as M6  # noqa: E402

LONG_T = (168, 336, 720)
RUNGS = ("a", "f", "fbL", "fH")
BLIND5_COMMIT = "f9389b6"
DAY = 86400
STEP = 3600
CLIP = 1e-4


def _identity_maps(self, qs_i, sH, zH, validH, rows_out=False):
    m = {bb: (M6.IDENTITY.copy(), {"n_rows": 0, "iterations": 0, "converged": True, "n_eval": 0,
                                   "rule": "R16.1: (fHb) not a candidate, map skipped"}) for bb in range(self.nb)}
    return (m, {}) if rows_out else m


M6.Prep6.beta_maps = _identity_maps


def logit(p):
    p = np.clip(np.asarray(p, float), CLIP, 1 - CLIP)
    return np.log(p) - np.log1p(-p)


def aggregate(T_h, k_i, regime, day, y, P):
    """Group rows by (T, k_i, regime, day). Returns dict of arrays: keys and per-rung sums."""
    m = np.isin(T_h, LONG_T)
    for r in RUNGS:
        m &= np.isfinite(P[r])
    T_h, k_i, regime, day, y = T_h[m], k_i[m], regime[m], day[m], y[m]
    P = {r: P[r][m] for r in RUNGS}
    key = np.stack([T_h.astype(np.int64), k_i.astype(np.int64), regime.astype(np.int64) + 1, day.astype(np.int64)], 1)
    u, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    G = len(u)
    out = {"T": u[:, 0].astype(np.int16), "k": u[:, 1].astype(np.int8), "regime": (u[:, 2] - 1).astype(np.int8),
           "day": u[:, 3].astype(np.int32), "n": np.bincount(inv, minlength=G).astype(np.int32),
           "sy": np.bincount(inv, weights=y, minlength=G)}
    for r in RUNGS:
        p = P[r]
        out[f"sp_{r}"] = np.bincount(inv, weights=p, minlength=G)
        out[f"se_{r}"] = np.bincount(inv, weights=(p - y) ** 2, minlength=G)
        out[f"sl_{r}"] = np.bincount(inv, weights=logit(p), minlength=G)
    return out


_S = {}


def series_job(key):
    ser = _S[key]
    folds = _S["__folds__"][key]
    outd = _S["__out__"]
    path = os.path.join(outd, key.replace(":", "-") + ".npz")
    if os.path.exists(path):
        return key, "cached"
    if not folds:
        return key, "no folds"
    q_max = max(f["qs_i"] for f in folds)
    per_T = {}
    for T_h in M6.HORIZONS_H:
        P6 = M6.Prep6(ser, T_h, q_max=q_max)
        per_T[T_h] = M6.fold_loop(ser, P6, T_h, folds)
        del P6
    R, _, _ = M6.assemble6(ser, folds, per_T)
    del per_T
    agg = aggregate(R["T_h"], R["k_i"], R["regime"], R["day"], R["y"], {r: R[f"p_{r}"] for r in RUNGS})
    agg["levels"] = np.array(R["levels"], float)
    np.savez_compressed(path, **agg)
    M6._clear(ser)
    return key, f"{len(agg['n'])} groups"


def run_dev(datasets, out, workers, include):
    global _S
    t0 = time.time()
    S, folds = {}, {}
    if "pool" in include:
        S1, f1, _ = M6.build_all(datasets, verify=True)
        keys1 = M6.other_keys(S1)
        S.update({k: S1[k] for k in keys1})
        folds.update({k: f1[k] for k in keys1})
    if "blind5" in include:
        S5, f5, _ = M6.build_blind_dir(datasets, M6.BLIND5_DIR, BLIND5_COMMIT, "blind5:", verify=True)
        S.update(S5)
        folds.update(f5)
    agg_dir = os.path.join(out, "agg")
    os.makedirs(agg_dir, exist_ok=True)
    _S = dict(S)
    _S.update({"__folds__": folds, "__out__": agg_dir})
    keys = sorted(S, key=lambda k: -(S[k].N - S[k].start_i))
    print(f"series built {time.time() - t0:.0f}s: {len(keys)}", flush=True)
    ctx = mp.get_context("fork")
    with ctx.Pool(workers, maxtasksperchild=2) as pool:
        for i, (k, msg) in enumerate(pool.imap_unordered(series_job, keys)):
            print(f"  {i + 1}/{len(keys)} {k}: {msg} {time.time() - t0:.0f}s", flush=True)


def run_ethbtc(datasets, out):
    """ETH and BTC development predictions (A6 dev run, Chainlink truth) -> the same aggregates."""
    agg_dir = os.path.join(out, "agg-ethbtc")
    os.makedirs(agg_dir, exist_ok=True)
    tl = {v: k for k, v in A.T_LABEL.items()}
    reg = {"low": 0, "mid": 1, "high": 2, "": -1}
    for a in ("ETH", "BTC"):
        path = os.path.join(datasets, f"history-forecasts/a6/run-015512cb/predictions-dev-{a}.csv.gz")
        import pandas as pd
        levels = list(A.LEVELS[a])
        df = pd.read_csv(path, usecols=["t0", "T", "k", "y", "regime"] + [f"p_{r}" for r in RUNGS],
                         keep_default_na=False)
        df = df[df["T"].isin([A.T_LABEL[t] for t in LONG_T])]
        ts = ((pd.to_datetime(df["t0"], utc=True) - pd.Timestamp("1970-01-01", tz="UTC")).dt.total_seconds()).astype("int64")
        lv = {round(x, 6): i for i, x in enumerate(levels)}
        C = {"T": df["T"].map(tl).to_numpy(), "k": df["k"].astype(float).round(6).map(lv).to_numpy(),
             "regime": df["regime"].map(reg).to_numpy(), "day": (ts // DAY).to_numpy(),
             "y": df["y"].to_numpy()}
        for r in RUNGS:
            C[r] = df[f"p_{r}"].astype(float).to_numpy()
        agg = aggregate(C["T"], C["k"], C["regime"], C["day"], C["y"].astype(float), {r: C[r] for r in RUNGS})
        agg["levels"] = np.array(levels, float)
        np.savez_compressed(os.path.join(agg_dir, f"chainlink-{a}.npz"), **agg)
        print(a, len(agg["n"]), "groups", flush=True)



# ---------------------------------------------------------------------------------------------
# Statistics (H1, H2): pigeonhole two-way bootstrap over series x calendar blocks; CGM cross-check
# ---------------------------------------------------------------------------------------------
BLOCK_ORIGIN_DAY = 17532          # 2018-01-01 (Monday) as days since epoch; blocks are counted from here
DISPLAYED = {"ETH": "fbL", "BTC": "fH"}      # A6 D3 displayed rung at 7-30 d
CLASSES = ("HIGH", "MEDIUM", "LOWER")         # LOWER = LOW + STALE + insufficient (every cell shows its number)
T_NAME = {168: "7d", 336: "14d", 720: "30d"}
Q2_LO, Q2_HI = 20544, 20635       # 2026-04-01 .. 2026-06-30 (days since epoch); windows meeting it are not scored


def q2_ok(day, T_h):
    """R15 rule 9 analogue: drop origins whose window meets 2026-04-01..2026-06-30."""
    end = day + np.ceil(np.asarray(T_h) / 24).astype(np.int64)
    return (end < Q2_LO) | (day > Q2_HI)


def load_aggs(paths):
    out = []
    for p in paths:
        z = np.load(p)
        d = {k: z[k] for k in z.files}
        d["name"] = os.path.basename(p)[:-4]
        out.append(d)
    return out


def labels_map(path):
    lab = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            a = r["asset"]
            if a in DISPLAYED and r["rung"] == DISPLAYED[a] and r["T"] in ("7d", "14d", "30d"):
                c = r["label"] if r["label"] in ("HIGH", "MEDIUM") else "LOWER"
                lab[(a, r["T"], round(float(r["k"]), 4), r["regime"])] = c
    return lab


def cells_matrix(aggs, sel_fn, val_fns, block_days):
    """Sum each value over (series, block) after the row filter sel_fn(d) -> mask. Returns dict of (S, B) arrays,
    the block ids and the (series, block) occupancy."""
    blocks = set()
    tmp = []
    for d in aggs:
        m = sel_fn(d)
        b = (d["day"][m].astype(np.int64) - BLOCK_ORIGIN_DAY) // block_days
        tmp.append((m, b))
        blocks.update(np.unique(b).tolist())
    bl = np.array(sorted(blocks), np.int64)
    S, B = len(aggs), len(bl)
    M = {k: np.zeros((S, B)) for k in val_fns}
    for si, (d, (m, b)) in enumerate(zip(aggs, tmp)):
        bi = np.searchsorted(bl, b)
        for k, fn in val_fns.items():
            M[k][si] = np.bincount(bi, weights=fn(d)[m], minlength=B)
    return M, bl


def boot_weights(rng, S, B, n_rep):
    ws = rng.multinomial(S, np.full(S, 1.0 / S), size=n_rep).astype(float)
    wb = rng.multinomial(B, np.full(B, 1.0 / B), size=n_rep).astype(float)
    return ws, wb


def twoway_sum(M, ws, wb):
    """sum_{s,b} ws[r,s] M[s,b] wb[r,b] for every replicate r."""
    return np.einsum("rs,sb,rb->r", ws, M, wb, optimize=True)


def cgm_var_ratio(num, den):
    """CGM two-way variance of ratio estimator theta = sum num / sum den, from (S, B) cell sums."""
    th = num.sum() / den.sum()
    u = (num - th * den) / den.sum()
    vs = (u.sum(1) ** 2).sum()
    vb = (u.sum(0) ** 2).sum()
    vi = (u ** 2).sum()
    return th, vs, vb, vi


def h1_cell(aggs, T_h, rm, rb, block_days, rng, n_rep, k_top=None):
    sel = lambda d: (d["T"] == T_h) & q2_ok(d["day"], T_h)
    M, bl = cells_matrix(aggs, sel, {"em": lambda d: d[f"se_{rm}"], "eb": lambda d: d[f"se_{rb}"],
                                     "n": lambda d: d["n"].astype(float)}, block_days)
    S, B = M["n"].shape
    em, eb, n = M["em"].sum(), M["eb"].sum(), M["n"].sum()
    bss = 1 - em / eb
    md = (em - eb) / n
    ws, wb = boot_weights(rng, S, B, n_rep)
    block_only = S < 5
    if block_only:                      # ETH/BTC own data: series are fixed, time blocks only
        ws = np.ones_like(ws)
    Em, Eb, N = twoway_sum(M["em"], ws, wb), twoway_sum(M["eb"], ws, wb), twoway_sum(M["n"], ws, wb)
    bss_b = 1 - Em / Eb
    md_b = (Em - Eb) / N
    p_cent = (1 + np.sum(bss_b - bss >= bss)) / (n_rep + 1)
    p_perc = (1 + np.sum(bss_b <= 0)) / (n_rep + 1)
    sd_md = float(np.std(md_b, ddof=1))
    d_cells = M["em"] - M["eb"]
    _, vs, vb, vi = cgm_var_ratio(d_cells, M["n"])
    v_cgm = vs + vb - vi
    v_pig = vs + vb + vi
    gain = -(d_cells.sum(1))             # per series gain of rm over rb (positive = rm better)
    k = k_top if k_top is not None else max(3, int(math.ceil(0.025 * S)))
    if block_only:
        k = 0
    top = np.argsort(-gain)[:k]
    keep = np.ones(S, bool)
    keep[top] = False
    bss_lt = 1 - M["em"][keep].sum() / M["eb"][keep].sum()
    md_lt = (M["em"][keep].sum() - M["eb"][keep].sum()) / M["n"][keep].sum()
    ws2, wb2 = boot_weights(rng, max(int(keep.sum()), 1), B, 2000)
    if block_only:
        ws2 = np.ones((2000, int(keep.sum())))
    md_lt_b = (twoway_sum(M["em"][keep], ws2, wb2) - twoway_sum(M["eb"][keep], ws2, wb2)) / \
        twoway_sum(M["n"][keep], ws2, wb2)
    occ = int((M["n"] > 0).sum())
    return {"T": T_NAME[T_h], "comparison": f"{rm}_vs_{rb}", "block_days": block_days, "S": S, "B": B,
            "cells_occupied": occ, "n_rows": int(n), "bss": float(bss),
            "bss_ci95": [float(np.quantile(bss_b, 0.025)), float(np.quantile(bss_b, 0.975))],
            "mean_d": float(md), "p_centred": float(p_cent), "p_percentile": float(p_perc),
            "z_twoway": float(-md / sd_md) if sd_md > 0 else None, "bootstrap": "blocks only" if block_only else "pigeonhole series x blocks", "sd_mean_d_twoway": sd_md,
            "z_cgm": float(-md / math.sqrt(v_cgm)) if v_cgm > 0 else None,
            "var_components": {"V_s": float(vs), "V_b": float(vb), "V_int": float(vi), "pig_analytic": float(v_pig),
                               "boot": sd_md ** 2},
            "leave_top_k": {"k": k, "bss": float(bss_lt), "mean_d": float(md_lt),
                            "z_twoway": float(-md_lt / np.std(md_lt_b, ddof=1))},
            "top_k_share": float(gain[top].sum() / gain.sum()) if gain.sum() > 0 else None,
            "series_with_gain": int((gain > 0).sum())}


def h2_class(aggs, asset_of_map, lab, cls, block_days, rng, n_rep, Ts=(168, 336, 720)):
    """Calibration of the displayed rung of `asset_of_map` (ETH -> fbL, BTC -> fH) on the rows whose
    (T, level, regime) cell carries label class `cls` for that asset. R = sum p / sum y; logistic calibration slope
    of y on the group's mean logit (day groups), one-step bootstrap."""
    r = DISPLAYED[asset_of_map]

    def sel(d):
        lv = d["levels"]
        m = np.zeros(len(d["n"]), bool)
        for T_h in Ts:
            for ki, k in enumerate(lv):
                for gi, g in enumerate(("low", "mid", "high")):
                    if lab.get((asset_of_map, T_NAME[T_h], round(float(k), 4), g)) == cls:
                        m |= (d["T"] == T_h) & (d["k"] == ki) & (d["regime"] == gi)
        return m & q2_ok(d["day"], d["T"].astype(np.int64))

    # slope fit on all groups first (full sample), then per-cell score / Hessian sums at the estimate
    xs, ys, ns, sidx, days = [], [], [], [], []
    for si, d in enumerate(aggs):
        m = sel(d)
        xs.append(d[f"sl_{r}"][m] / d["n"][m])
        ys.append(d["sy"][m])
        ns.append(d["n"][m].astype(float))
        sidx.append(np.full(int(m.sum()), si))
        days.append(d["day"][m])
    x, yv, nv, si_all, day = (np.concatenate(v) for v in (xs, ys, ns, sidx, days))
    if nv.sum() == 0:
        return None
    th = np.array([0.0, 1.0])
    for _ in range(50):
        eta = th[0] + th[1] * x
        mu = 1 / (1 + np.exp(-eta))
        g = np.array([np.sum(yv - nv * mu), np.sum((yv - nv * mu) * x)])
        w = nv * mu * (1 - mu)
        H = np.array([[w.sum(), (w * x).sum()], [(w * x).sum(), (w * x * x).sum()]])
        step = np.linalg.solve(H, g)
        th = th + step
        if np.max(np.abs(step)) < 1e-10:
            break
    eta = th[0] + th[1] * x
    mu = 1 / (1 + np.exp(-eta))
    res = yv - nv * mu
    w = nv * mu * (1 - mu)
    M, bl = cells_matrix(aggs, sel, {"sp": lambda d: d[f"sp_{r}"], "sy": lambda d: d["sy"],
                                     "n": lambda d: d["n"].astype(float), "se": lambda d: d[f"se_{r}"]}, block_days)
    S, B = M["n"].shape
    bi = np.searchsorted(bl, (day.astype(np.int64) - BLOCK_ORIGIN_DAY) // block_days)
    def cell(v):
        out = np.zeros((S, B))
        np.add.at(out, (si_all, bi), v)
        return out
    G0, G1 = cell(res), cell(res * x)
    ws, wb = boot_weights(rng, S, B, n_rep)
    # full Newton per replicate on (series, block, logit-bin 0.05) groups
    xb = np.round(x / 0.05).astype(np.int64)
    key = np.stack([si_all, bi, xb], 1)
    uk, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    gn = np.bincount(inv, weights=nv)
    gy = np.bincount(inv, weights=yv)
    gx = np.bincount(inv, weights=nv * x) / gn
    gs, gb = uk[:, 0], uk[:, 1]
    slope_b = np.empty(n_rep)
    CH = 50
    for c0 in range(0, n_rep, CH):
        W = ws[c0:c0 + CH][:, gs] * wb[c0:c0 + CH][:, gb]           # (CH, G)
        t0 = np.full(W.shape[0], th[0])
        t1 = np.full(W.shape[0], th[1])
        for _ in range(8):
            eta = t0[:, None] + t1[:, None] * gx[None, :]
            mu_ = 1 / (1 + np.exp(-eta))
            r_ = W * (gy[None, :] - gn[None, :] * mu_)
            w_ = W * gn[None, :] * mu_ * (1 - mu_)
            a0, a1 = r_.sum(1), (r_ * gx).sum(1)
            h00, h01, h11 = w_.sum(1), (w_ * gx).sum(1), (w_ * gx * gx).sum(1)
            det = h00 * h11 - h01 ** 2
            d0 = (h11 * a0 - h01 * a1) / det
            d1 = (-h01 * a0 + h00 * a1) / det
            t0, t1 = t0 + d0, t1 + d1
            if np.max(np.abs(d1)) < 1e-8:
                break
        slope_b[c0:c0 + CH] = np.where(np.isfinite(t1), t1, 1e-9)   # a non-converged replicate counts as outside the band
    sp, sy = M["sp"].sum(), M["sy"].sum()
    lnR = math.log(sp / sy)
    slope_bin_full = float(np.median(slope_b))
    lnR_b = np.log(twoway_sum(M["sp"], ws, wb) / twoway_sum(M["sy"], ws, wb))
    lnb = math.log(th[1]) if th[1] > 0 else float("nan")
    lnb_b = np.log(np.clip(slope_b, 1e-9, None))
    d = math.log(1.25)

    def tost(est, boot):
        # centred: H0 est <= -d  -> p_lo = P*(boot - est >= est + d); H0 est >= d -> p_hi = P*(boot - est <= est - d)
        c_lo = (1 + np.sum(boot - est >= est + d)) / (n_rep + 1)
        c_hi = (1 + np.sum(boot - est <= est - d)) / (n_rep + 1)
        q_lo = (1 + np.sum(boot <= -d)) / (n_rep + 1)
        q_hi = (1 + np.sum(boot >= d)) / (n_rep + 1)
        return {"p_centred": float(max(c_lo, c_hi)), "p_percentile": float(max(q_lo, q_hi)),
                "ci90": [float(np.quantile(boot, 0.05)), float(np.quantile(boot, 0.95))],
                "sd": float(np.std(boot, ddof=1))}
    # CGM for ln R: linearised u = p/sum p - y/sum y
    u = M["sp"] / sp - M["sy"] / sy
    vs, vb, vi = (u.sum(1) ** 2).sum(), (u.sum(0) ** 2).sum(), (u ** 2).sum()
    # CGM for slope: sandwich with two-way clustered scores
    Hf = np.array([[w.sum(), (w * x).sum()], [(w * x).sum(), (w * x * x).sum()]])
    Hi = np.linalg.inv(Hf)
    def clus(A0, A1):
        return np.einsum("i,j->ij", A0, A1)
    Us = np.stack([G0.sum(1), G1.sum(1)], 1)
    Ub = np.stack([G0.sum(0), G1.sum(0)], 1)
    Uc = np.stack([G0.ravel(), G1.ravel()], 1)
    Vsl = Hi @ (Us.T @ Us + Ub.T @ Ub - Uc.T @ Uc) @ Hi
    se_slope_cgm = math.sqrt(max(Vsl[1, 1], 0.0))
    # per-cell R (cancellation guard): cells = (T, k, regime) of this class
    cell_R = []
    return {"asset_map": asset_of_map, "rung": r, "class": cls, "block_days": block_days, "S": S, "B": B,
            "cells_occupied": int((M["n"] > 0).sum()), "n_rows": int(M["n"].sum()), "sum_p": float(sp),
            "sum_y": float(sy), "R": float(math.exp(lnR)), "lnR": lnR, "lnR_tost": tost(lnR, lnR_b),
            "lnR_cgm_se": float(math.sqrt(max(vs + vb - vi, 0))), "lnR_var_components": [float(vs), float(vb), float(vi)],
            "slope": float(th[1]), "intercept": float(th[0]), "ln_slope_tost": tost(lnb, lnb_b),
            "slope_cgm_se": se_slope_cgm, "ln_slope_cgm_se": se_slope_cgm / th[1] if th[1] > 0 else None}


def corp_mcb_dsc(aggs, r, sel_fn):
    """CORP decomposition (PAV) on day-group means is not exact; computed on day groups weighted by n (reported)."""
    ps, ys, ns = [], [], []
    for d in aggs:
        m = sel_fn(d)
        ps.append(d[f"sp_{r}"][m] / d["n"][m])
        ys.append(d["sy"][m])
        ns.append(d["n"][m].astype(float))
    p, yv, n = (np.concatenate(v) for v in (ps, ys, ns))
    o = np.argsort(p, kind="mergesort")
    p, yv, n = p[o], yv[o], n[o]
    fit = M6.pav(yv / n, n)
    ybar = yv.sum() / n.sum()
    def sbar(q):
        return float((n * ((q ** 2) - 2 * q * (yv / n)) ).sum() / n.sum())   # E[q^2 - 2 q y] (+ E[y] const)
    s_p, s_c, s_u = sbar(p), sbar(fit), sbar(np.full_like(p, ybar))
    return {"MCB": s_p - s_c, "DSC": s_u - s_c, "UNC": float(ybar * (1 - ybar)), "note": "day-group means, PAV"}


def run_stats(paths, out_json, labels_csv, seed, n_rep, blocks=(91,), h2=True, comps=None):
    aggs = load_aggs(paths)
    lab = labels_map(labels_csv)
    rng = np.random.default_rng(seed)
    comps = comps or (("f", "a"), ("fbL", "a"), ("fH", "a"), ("fH", "f"))
    res = {"series": [d["name"] for d in aggs], "seed": seed, "n_rep": n_rep, "h1": [], "h2": [], "corp": {}}
    for bd in blocks:
        for T_h in LONG_T:
            for rm, rb in comps:
                res["h1"].append(h1_cell(aggs, T_h, rm, rb, bd, rng, n_rep))
                x = res["h1"][-1]
                print(f"H1 {bd}d {x['T']} {x['comparison']}: BSS {x['bss']:+.4f} {x['bss_ci95']} z2w {x['z_twoway']:.2f} "
                      f"zcgm {x['z_cgm']:.2f} pc {x['p_centred']:.4f} pp {x['p_percentile']:.4f} "
                      f"lt{x['leave_top_k']['k']} {x['leave_top_k']['bss']:+.4f} (z {x['leave_top_k']['z_twoway']:.2f}) "
                      f"S {x['S']} B {x['B']} C {x['cells_occupied']}", flush=True)
        if h2:
            for a in ("ETH", "BTC"):
                for c in CLASSES:
                    x = h2_class(aggs, a, lab, c, bd, rng, n_rep)
                    res["h2"].append(x)
                    if x:
                        print(f"H2 {bd}d {a}/{x['rung']} {c}: R {x['R']:.3f} lnR sd {x['lnR_tost']['sd']:.3f} "
                              f"(cgm {x['lnR_cgm_se']:.3f}) p {x['lnR_tost']['p_centred']:.4f}/{x['lnR_tost']['p_percentile']:.4f} "
                              f"slope {x['slope']:.3f} lnb sd {x['ln_slope_tost']['sd']:.3f} (cgm {x['ln_slope_cgm_se']}) "
                              f"p {x['ln_slope_tost']['p_centred']:.4f}/{x['ln_slope_tost']['p_percentile']:.4f} rows {x['n_rows']}",
                              flush=True)
    for T_h in LONG_T:
        for r in RUNGS:
            res["corp"][f"{T_NAME[T_h]}|{r}"] = corp_mcb_dsc(aggs, r, lambda d: (d["T"] == T_h) & q2_ok(d["day"], T_h))
    with open(out_json, "w") as f:
        json.dump(res, f, indent=1)


# ---------------------------------------------------------------------------------------------
# Power (D-R13.5c / D-R15.4b component-wise rule): scale the development two-way variance to a target set
# ---------------------------------------------------------------------------------------------
def _phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def var_factor(vs, vb, vi, boot_var, dev_counts, new_counts):
    """factor = projected / development pigeonhole variance. V_s ~ 1/S, V_b ~ 1/B, interaction ~ 1/C; the
    interaction multiplier c is calibrated so that vs + vb + c vi equals the development bootstrap variance."""
    c = max((boot_var - vs - vb) / vi, 0.0) if vi > 0 else 0.0
    S0, B0, C0 = dev_counts
    S1, B1, C1 = new_counts
    num = vs * S0 / S1 + vb * B0 / B1 + c * vi * C0 / C1
    return num / (vs + vb + c * vi), c


def tost_power(mu, sd, delta=math.log(1.25), z=1.6449):
    return max(0.0, _phi((delta - abs(mu)) / sd - z) + _phi((delta + abs(mu)) / sd - z) - 1.0)


def run_power(dev_json, new_counts_json, out_json, block_days, h1_cells, z_crit_h1):
    dev = json.load(open(dev_json))
    newc = json.load(open(new_counts_json))
    out = {"rule": "z_proj = z_dev / sqrt(factor); factor from V_s, V_b, interaction scaled by S, B, C ratios "
                   "(interaction multiplier calibrated to the development bootstrap variance)",
           "block_days": block_days, "z_crit_h1": z_crit_h1, "h1": {}, "h2": {}}
    for cell in h1_cells:                       # e.g. "7d|f_vs_a"
        T, comp = cell.split("|")
        x = [r for r in dev["h1"] if r["T"] == T and r["comparison"] == comp and r["block_days"] == block_days][0]
        v = x["var_components"]
        nc = newc[T]
        f, c = var_factor(v["V_s"], v["V_b"], v["V_int"], v["boot"], (x["S"], x["B"], x["cells_occupied"]),
                          (nc["S"], nc["B"], nc["C"]))
        zd = x["z_twoway"]
        zp = zd / math.sqrt(f)
        test = _phi(zp - z_crit_h1) if zd > 0 else 0.0
        conc = _phi(x["leave_top_k"]["z_twoway"] * zp / zd) if zd > 0 else 0.0
        out["h1"][cell] = {"z_dev": zd, "factor": f, "c_int": c, "z_proj": zp, "test": test, "concentration": conc,
                           "joint": test * conc, "dev_counts": [x["S"], x["B"], x["cells_occupied"]],
                           "new_counts": [nc["S"], nc["B"], nc["C"]]}
    joint = 1.0
    for x in dev["h2"]:
        if not x or x["block_days"] != block_days:
            continue
        nc = newc["7d"]
        vs, vb, vi = x["lnR_var_components"]
        f, c = var_factor(vs, vb, vi, x["lnR_tost"]["sd"] ** 2, (x["S"], x["B"], x["cells_occupied"]),
                          (nc["S"], nc["B"], nc["C"]))
        sdR = x["lnR_tost"]["sd"] * math.sqrt(f)
        sdb = x["ln_slope_tost"]["sd"] * math.sqrt(f)
        lnb = math.log(x["slope"]) if x["slope"] > 0 else -10
        pR, pb = tost_power(x["lnR"], sdR), tost_power(lnb, sdb)
        key = f"{x['asset_map']}/{x['rung']}|{x['class']}"
        out["h2"][key] = {"lnR": x["lnR"], "sd_lnR_dev": x["lnR_tost"]["sd"], "slope": x["slope"],
                          "sd_lnslope_dev": x["ln_slope_tost"]["sd"], "factor": f, "power_R": pR, "power_slope": pb,
                          "joint": pR * pb}
        joint *= pR * pb
    out["h2_joint_all_classes"] = joint
    with open(out_json, "w") as fh:
        json.dump(out, fh, indent=1)
    print(json.dumps(out, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=("dev", "ethbtc", "stats", "power"))
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--include", default="pool,blind5")
    ap.add_argument("--aggs", nargs="*")
    ap.add_argument("--json")
    ap.add_argument("--labels", default="/home/user/membrane-datasets/history-forecasts/a6/run-015512cb/labels-frozen.csv")
    ap.add_argument("--seed", type=int, default=20261610)
    ap.add_argument("--nrep", type=int, default=10000)
    ap.add_argument("--blocks", default="91")
    ap.add_argument("--no-h2", action="store_true")
    ap.add_argument("--dev-json")
    ap.add_argument("--counts-json")
    ap.add_argument("--h1-cells", default="7d|f_vs_a,30d|fH_vs_a")
    ap.add_argument("--zcrit", type=float, default=1.95996)
    a = ap.parse_args(argv)
    if a.phase == "dev":
        run_dev(a.datasets, a.out, a.workers, a.include.split(","))
    elif a.phase == "ethbtc":
        run_ethbtc(a.datasets, a.out)
    elif a.phase == "power":
        run_power(a.dev_json, a.counts_json, a.json, int(a.blocks), a.h1_cells.split(","), a.zcrit)
    elif a.phase == "stats":
        run_stats(a.aggs, a.json, a.labels, a.seed, a.nrep, tuple(int(x) for x in a.blocks.split(",")), not a.no_h2)


if __name__ == "__main__":
    main()
