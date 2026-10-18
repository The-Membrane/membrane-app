#!/usr/bin/env python3
"""Q26 R14.2: one depositor-exit model across every (size x, horizon h) cell.

Item: membrane-board `design/Q26_ROUND14_PREREG.md` R14.2 (Deviations D-R14.2a, b, ...); draft in
`design/q26-ml-levers-deepen-2026-10-18.md` section 3. Comparators and data come from B4 (`b4_depositor.py`), B6c
(`b6c_cash.py`, Round 9 D6 readings) and B-gradient (`bg_gradient.py`), imported unchanged.

Model L ("ladder"). For origin row r (unit i, 00:00Z day t, bal(t0) >= $1M), size x in {10, 25, 50, 75, 90} and the
5 nested horizon intervals k = (0, 1h], (1h, 6h], (6h, 24h], (24h, 48h], (48h, 7d]: the discrete hazard
lambda_k(x) = P(first fall >= x in interval k | none before), one weighted logistic fit per fold over every (r, x, k)
interval row:
    logit lambda = alpha_k + g1 u + g2 u^2 + g3 u tau_k + sum_j z_j (b_j + d_j u + e_j tau_k) [+ ln theta_i]
u = (x - 50) / 40 (distribution regression across x: coefficients smooth in x), tau_k = ln(h_k / 1 day) / 2
(hazard across h), z = the 11 v4a pool / unit features, is_contract and the 3 threshold-matched history features of x
(standardised on the fold's training origins). P(fall >= x within h_K) = 1 - prod_{k <= K} (1 - lambda_k).
Cash-blocked days are censored, not dropped and not scored as 0 in training: interval k of (r, x) is kept only if
no daily snapshot in (t0, t0 + h_k] has cash < x bal(t0) / 100 (the origin cap, x bal > 100 cash(t0), keeps no
interval: B4's G5 cap). theta_i is the B4 v4b frailty computed on the interval rows (discounted O / E, m per segment
by the negative-binomial grid). L0 = L with theta = 1 (the form scored on D1, where no unit has Core rows).
Non-event interval rows are sampled with a fixed per-segment rate q (weight 1 / q); every event row is kept.
The B4 2-D monotone fix (G10) is applied to every model grid before scoring.

Phases (one --out per phase family; outputs refuse to overwrite):
  dev      development on seen Core USDC / USDT (USDC with the Round 9 corrections as B6c: W24 pool state, QRT
           neutralisation of paths, anchors and labels); fits L per Core fold; scores L, L0 against B4 shipped,
           B4 (theta = 1, frozen fold fits), B6c v4ac (USDC), own and pop; power statistics. Never opens
           depositor-blind5.
  counts   D1 counts-only check: units, rows, test rows and exits per (cell, segment pool). Prints counts only.
  freeze   frozen-r142.json (code sha, inputs, readings, seeds, L fold parameters) + freeze-record.json (sha256).
  run      D1 ONCE (refuses without --frozen-sha256 equal to the freeze record; writes run-started.json first).
No address is written to any output.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "2")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import warnings  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b_behavior as B  # noqa: E402
import bg_gradient as G  # noqa: E402
import b3_segments as S  # noqa: E402
import b4_depositor as F  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND14_PREREG.md", "item": "R14.2",
          "draft": "design/q26-ml-levers-deepen-2026-10-18.md section 3 (board bebf035)"}
B4_RUN = "history-forecasts/b4/run-2035639d/"
B6C_RUN = "history-forecasts/r9/b6c-run-da52297d/"
NX, NH = len(G.SIZES), len(G.HNAMES)
XS = np.array(G.SIZES)
U_X = (XS - 50.0) / 40.0
TAU = np.log(np.array(G.HSEC, float) / 86400.0) / 2.0
THIN = ("w3", "c2", "c3")                      # B4 has no blind skill: wallets >= $50M, contracts >= $10M
THIN_IDX = tuple(S.SEG_IDS.index(s) for s in THIN)
Q_SEG = {"w1": 0.04, "w2": 0.2, "w3": 1.0, "c1": 0.2, "c2": 1.0, "c3": 1.0}   # non-event sampling rate
SEED_SAMPLE = 20261901
SEED_DEV = 20261902                            # dev bootstrap (30-day day blocks, 2,000 replicates)
SEED_D1 = 20261903                             # D1 bootstrap
PRIMARY_H = ("24h", "48h", "7d")               # B4.6 verdict horizons
HIGH_GUARD = (("x10_24h", "w1"), ("x25_24h", "w1"))   # B4 final HIGH cells (labels-b4-d2.csv)
GUARD_LO = -0.002
R_BAND = (0.8, 1.25)
ALPHA = 0.05
LOGIT_C = 1.0
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
FEAT_NAMES = list(G.FEATURES_V2[:F.KEEP_V2]) + ["is_contract", "log1p_n_x90", "maxdd90", "log1p_days_since_x"]
NZ = len(FEAT_NAMES)

DECISIONS = [
    "L1 rows, labels, cap, features, folds and segments are B4's (bg_gradient / b4_depositor imported unchanged). "
    "USDC carries the Round 9 B6c corrections exactly as b6c_cash.phase_run builds them (patch_pool W24 pool state, "
    "patch_usdc QRT neutralisation of per-block paths, label-view and feature-view anchors); USDT is uncorrected "
    "(Round 9 registered USDC only; the drain is a USDC wallet).",
    "L2 interval rows: event in k iff y(x, h_k) = 1 and y(x, h_{k-1}) = 0; at risk iff y(x, h_{k-1}) = 0. Training: "
    "feat_ok, resolved (RES) and t0 + h_k <= the fold start (the B4 training rule per horizon), not capped at the "
    "origin, not censored.",
    "L3 censoring: cash of each daily snapshot d in (t0, t0 + 7 d] (USDC: W24 mean cash, the B6c cash_blocked input; "
    "USDT and D1: snapshot cash). Interval k of (r, x) is censored iff some T_d in (t0, t0 + h_k] has 100 cash_d < "
    "x bal(t0).",
    "L4 sampling: every event row kept; non-event rows kept with probability Q_SEG[segment of the row] by one "
    "default_rng(SEED_SAMPLE + fold) uniform per (row, x, k) in C order; weight 1 / q.",
    "L5 fit: sklearn LogisticRegression(C=1.0, lbfgs, fit_intercept=False, max_iter=3000) on the 53-column design "
    "(5 interval intercepts, u, u^2, u tau, z, z u, z tau) with sample weights. z standardised by the weighted mean "
    "and sd of the fold's sampled training interval rows (sd 0 -> 1).",
    "L6 frailty (L only): per unit O_d, E_d = sums of w y and w lambda-hat over its training interval rows, w = (1 / q) "
    "x 0.5^((fold start - t0) / 180 d); m per segment by F.select_m over the units' (O_d, E_d) of rows in that "
    "segment; theta = (O_d + m_seg(row)) / (E_d + m_seg(row)), 1 without training rows. ln theta is added to every "
    "interval logit.",
    "L7 prediction grid: P(x, h_K) = 1 - prod (1 - lambda_k), then S.fix_grid (B4 G10 monotone fix with the cap).",
    "L8 comparators (dev): b4 = the B4 shipped rung per (cell, segment) from the published B4 dev predictions "
    "(shipped rung column; segment training rate seg_pop where B4 ships none, the B4 display rule), b4t1 = the same "
    "rule with the frozen B4 fold fits at theta = 1 on these rows (the form available on D1), v4ac = B6c (USDC only, "
    "trained on y_cash: reported only), own / pop = G9 on the corrected labels (training rows of the fold).",
    "L9 scoring sets: test rows (fold >= 0, feat_ok), resolved at h, not capped at x. Thin pool = rows of segments "
    "w3, c2, c3. Primary statistic per h in PRIMARY_H: BSS of L0 vs b4t1 on the thin pool with the Brier summed over "
    "the 5 x cells (pairs stacked), CI from 30-day moving day blocks (B4 bootstrap form). Per-cell statistics are "
    "reported.",
]


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:      # noqa: BLE001
            return None
    files = ("r142_ladder.py", "r142_acquire_d1.py", "b4_depositor.py", "b6c_cash.py", "bg_gradient.py",
             "b3_segments.py", "b_behavior.py", "b5_econ.py", "b6_cash.py")
    dirty = git("status", "--porcelain", "--", *files)
    return {"git_head": git("rev-parse", "HEAD"), "tree_dirty": bool(dirty),
            "sha256": {f: B.sha256_file(os.path.join(here, f)) for f in files}}


def guard_no_address(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        if ADDR_RE.search(f.read()):
            raise SystemExit(f"STOP: {path} holds an address-like string")


# ---------------------------------------------------------------------------------------------
# Interval rows, design, fit, prediction
# ---------------------------------------------------------------------------------------------
def cash_matrix(res, rows, D):
    """(n, 7) cash at the daily snapshots t + 1 .. t + 7 (micro), -1 where unknown (treated as not blocked)."""
    n = len(rows["t"])
    C = np.full((n, 7), -1, dtype=np.int64)
    for ri, R in enumerate(res):
        m = rows["reserve"] == ri
        c = np.asarray(R.state["cash"][:D], dtype=np.int64)
        t = rows["t"][m]
        for j in range(7):
            d = t + 1 + j
            ok = d < D
            v = np.full(len(t), -1, dtype=np.int64)
            v[ok] = c[d[ok]]
            C[np.nonzero(m)[0], j] = v
    return C


def censor_masks(rows, Cm):
    """keep[x][k] (n,) bool: interval k of (row, x) is not censored (L3) and the origin is not capped."""
    bal = rows["bal"].astype(np.int64)
    out = np.zeros((NX, NH, len(bal)), dtype=bool)
    for xi, x in enumerate(G.SIZES):
        cap0 = rows["CAP"][:, G.XCELL[0, xi]]
        blocked = (Cm >= 0) & (100 * Cm < x * bal[:, None])          # (n, 7): snapshot t + 1 + j blocked
        for k, hs in enumerate(G.HSEC):
            nd = hs // 86400                                         # snapshots with T_d <= t0 + h_k
            b = blocked[:, :nd].any(axis=1) if nd > 0 else np.zeros(len(bal), bool)
            out[xi, k] = ~cap0 & ~b
    return out


def zfeat(rows, xi, idx):
    xk = F.XKEYS[xi]
    return np.column_stack([rows["X"][idx, :F.KEEP_V2], rows["contract_unit"][rows["unit"][idx]].astype(float),
                            rows["F4"][xk][idx]])


def design(Z, xi, k):
    """Z standardised (n, NZ); scalar xi, k -> (n, 53)."""
    n = len(Z)
    u, tau = U_X[xi], TAU[k]
    oh = np.zeros((n, NH))
    oh[:, k] = 1.0
    base = np.column_stack([oh, np.full(n, u), np.full(n, u * u), np.full(n, u * tau)])
    return np.hstack([base, Z, Z * u, Z * tau])


NCOL = NH + 3 + 3 * NZ


def interval_training(rows, keep, tr_origin, Tqs, fold_seed):
    """Sampled training interval rows -> list of (idx, xi, k, y, w) blocks."""
    rng = np.random.default_rng(fold_seed)
    qrow = np.array([Q_SEG[s] for s in S.SEG_IDS])[rows["seg"]]
    blocks = []
    for xi in range(NX):
        prev = np.zeros(len(rows["t"]), dtype=np.int8)
        for k, hs in enumerate(G.HSEC):
            ci = G.XCELL[k, xi]
            yk = rows["Y"][:, ci]
            m = tr_origin & rows["RES"][:, k] & (rows["T0"] + hs <= Tqs) & keep[xi, k] & (prev == 0)
            idx = np.nonzero(m)[0]
            ev = (yk[idx] == 1)
            uni = rng.random(len(idx))
            q = np.where(ev, 1.0, qrow[idx])
            s = ev | (uni < q)
            blocks.append((idx[s], xi, k, ev[s].astype(float), 1.0 / q[s]))
            prev = np.maximum(prev, yk)
    return blocks


def fit_L(rows, blocks, Tqs):
    from sklearn.exceptions import ConvergenceWarning
    from sklearn.linear_model import LogisticRegression
    Zs = [zfeat(rows, xi, idx) for idx, xi, k, y, w in blocks]
    W = np.concatenate([b[4] for b in blocks])
    Zall = np.vstack(Zs)
    mu = np.average(Zall, axis=0, weights=W)
    sd = np.sqrt(np.average((Zall - mu) ** 2, axis=0, weights=W))
    sd = np.where(sd > 0, sd, 1.0)
    del Zall
    X = np.vstack([design((Z - mu) / sd, b[1], b[2]) for Z, b in zip(Zs, blocks)])
    del Zs
    y = np.concatenate([b[3] for b in blocks])
    with warnings.catch_warnings(record=True) as wl:
        warnings.simplefilter("always")
        warnings.filterwarnings("ignore", category=FutureWarning)
        clf = LogisticRegression(C=LOGIT_C, solver="lbfgs", fit_intercept=False, max_iter=3000).fit(X, y, sample_weight=W)
    nconv = sum(1 for x in wl if issubclass(x.category, ConvergenceWarning))
    coef = clf.coef_[0]
    eta = X @ coef
    del X
    # frailty pieces on the interval rows (L6)
    from scipy.special import expit
    lam = expit(eta)
    idx_all = np.concatenate([b[0] for b in blocks])
    unit = rows["unit"][idx_all]
    disc = F.discount_weights(rows["T0"][idx_all], Tqs)
    wd = W * disc
    n_units = rows["n_units"]
    Od = np.bincount(unit, weights=wd * y, minlength=n_units)
    Ed = np.bincount(unit, weights=wd * lam, minlength=n_units)
    seg = rows["seg"][idx_all]
    mseg = np.full(S.NSEG, F.M_DEFAULT)
    minfo = []
    for s in range(S.NSEG):
        sel = seg == s
        O = np.bincount(unit[sel], weights=(wd * y)[sel], minlength=n_units)
        E = np.bincount(unit[sel], weights=(wd * lam)[sel], minlength=n_units)
        ms, lls, nn = F.select_m(O, E)
        mseg[s] = ms
        minfo.append({"m": ms, "n_units": nn})
    info = {"interval_rows": int(len(y)), "events": int(y.sum()), "weighted_rows": float(W.sum()),
            "n_iter": int(np.max(clf.n_iter_)), "convergence_warnings": nconv,
            "events_by_xk": {f"x{G.SIZES[b[1]]}_{G.HNAMES[b[2]]}": int(b[3].sum()) for b in blocks}}
    return {"coef": coef.tolist(), "mu": mu.tolist(), "sd": sd.tolist(), "m_seg": mseg.tolist(), "m_info": minfo,
            "info": info}, Od, Ed


def predict_L(rows, params, idx, theta=None):
    """-> (n_idx, NC) grid of P(fall >= x within h) (NaN on y_all cells), before the monotone fix."""
    from scipy.special import expit, logit
    coef, mu, sd = np.asarray(params["coef"]), np.asarray(params["mu"]), np.asarray(params["sd"])
    P = np.full((len(idx), G.NC), np.nan)
    lth = np.zeros(len(idx)) if theta is None else np.log(theta)
    for xi in range(NX):
        Z = (zfeat(rows, xi, idx) - mu) / sd
        surv = np.ones(len(idx))
        for k in range(NH):
            lam = expit(design(Z, xi, k) @ coef + lth)
            surv *= (1.0 - lam)
            P[:, G.XCELL[k, xi]] = 1.0 - surv
    _ = logit
    return P


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def boot_counts(rng, nd):
    return B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) if nd >= G.BLOCK_DAYS \
        else None


def stack_set(rows, idx_by_cell, PR, names):
    """Stack (row, cell) pairs -> t, y, {name: p}."""
    t, y, ps = [], [], {k: [] for k in names}
    for ci, idx in idx_by_cell:
        t.append(rows["t"][idx])
        y.append(rows["Y"][idx, ci].astype(float))
        for k in names:
            ps[k].append(PR[k][idx, ci])
    return np.concatenate(t), np.concatenate(y), {k: np.concatenate(v) for k, v in ps.items()}


def score_stack(t, y, ps, comps, rng, models):
    dd = np.unique(t)
    nd = len(dd)
    pos = np.searchsorted(dd, t)
    cb = boot_counts(rng, nd)
    out = {"pairs": int(len(y)), "days": int(nd), "exits": int(y.sum()),
           "R": {k: (float(ps[k].sum() / y.sum()) if y.sum() > 0 else None) for k in models}, "bss": {}, "R_ci": {}}
    for name, a, b in comps:
        if cb is None or not np.isfinite(ps[a]).all() or not np.isfinite(ps[b]).all():
            out["bss"][name] = None
            continue
        r = G.bss_ci(pos, nd, ps[a], ps[b], y, cb)
        se_m = np.bincount(pos, weights=(ps[a] - y) ** 2, minlength=nd)
        se_b = np.bincount(pos, weights=(ps[b] - y) ** 2, minlength=nd)
        with np.errstate(divide="ignore", invalid="ignore"):
            reps = 1.0 - (cb @ se_m) / (cb @ se_b)
        reps = reps[np.isfinite(reps)]
        r["p_one_sided"] = float((np.sum(reps <= 0) + 1) / (len(reps) + 1))
        r["se_boot"] = float(np.std(reps, ddof=1)) if len(reps) > 1 else None
        # block statistics for the D-R11.3e power rule: 30-day calendar blocks of the Brier difference
        blk = (dd[pos] - dd[0]) // G.BLOCK_DAYS
        nb = int(blk.max()) + 1
        dsum = np.bincount(blk, weights=(ps[b] - y) ** 2 - (ps[a] - y) ** 2, minlength=nb)
        cnt = np.bincount(blk, minlength=nb)
        okb = cnt > 0
        bm = dsum[okb] / cnt[okb]
        r["blocks"] = int(okb.sum())
        r["block_mean"] = float(bm.mean())
        r["block_sd"] = float(bm.std(ddof=1)) if okb.sum() > 1 else None
        out["bss"][name] = r
    for k in models:
        if cb is not None and np.isfinite(ps[k]).all():
            out["R_ci"][k], _ = G.r_ci(pos, nd, ps[k], y, cb)
    return out


def cell_sets(rows, test, segs):
    """{(cid, seg_label): [(ci, idx)]} for x cells; seg_label 'thin' or a segment id or 'all'."""
    out = {}
    for hi in range(NH):
        for xi in range(NX):
            ci = int(G.XCELL[hi, xi])
            base = test & rows["RES"][:, hi] & ~rows["CAP"][:, ci]
            for lab, ss in segs.items():
                idx = np.nonzero(base & np.isin(rows["seg"], ss))[0]
                out[(G.CELLS[ci]["id"], lab)] = [(ci, idx)]
    return out


def evaluate(rows, PR, test, models, comps, seed, extra_keep=None):
    segs = {"thin": list(THIN_IDX), "all": list(range(S.NSEG))}
    segs.update({s: [i] for i, s in enumerate(S.SEG_IDS)})
    keep = test if extra_keep is None else (test & extra_keep)
    cs = cell_sets(rows, keep, segs)
    rng = np.random.default_rng(seed)
    res = {"primary": {}, "cells": {}}
    names = sorted(set(models) | {a for _, a, _ in comps} | {b for _, _, b in comps})
    for h in PRIMARY_H:                                     # primary first (fixed stream order)
        hi = G.HNAMES.index(h)
        parts = [cs[(G.CELLS[int(G.XCELL[hi, xi])]["id"], "thin")][0] for xi in range(NX)]
        t, y, ps = stack_set(rows, parts, PR, names)
        res["primary"][h] = score_stack(t, y, ps, comps, rng, models)
    for (cid, lab), parts in cs.items():
        t, y, ps = stack_set(rows, parts, PR, names)
        sc = score_stack(t, y, ps, comps, rng, models) if len(y) else {"pairs": 0}
        sc["n_ep"] = int(G.n_episodes(rows["unit"][parts[0][1]], rows["t"][parts[0][1]], y)) if len(y) else 0
        res["cells"].setdefault(cid, {})[lab] = sc
    return res


def power_from(stat, exits_target, alpha_k):
    """Exit-count projection of the dev z: z_t = z_dev sqrt(E_t / E_dev); power = Phi(z_t - z_{1-alpha_k})."""
    from scipy.stats import norm
    b = stat
    if b is None or b.get("se_boot") in (None, 0) or b.get("bss") is None:
        return None
    z = b["bss"] / b["se_boot"]
    out = {"z_dev": z, "alpha_k": alpha_k}
    if b.get("block_sd") and b["block_mean"] > 0:
        out["G_star_blocks"] = ((norm.ppf(1 - alpha_k) + norm.ppf(0.8)) * b["block_sd"] / b["block_mean"]) ** 2
    out["exits_target"] = exits_target
    return out


# ---------------------------------------------------------------------------------------------
# Development (seen Core data)
# ---------------------------------------------------------------------------------------------
def build_dev_rows(datasets_dir, log):
    import b6c_cash as C6
    shas = F.verify_inputs(datasets_dir, holdouts=False)
    legs, w24, r9s = C6.load_r9(datasets_dir)
    shas.update(r9s)
    ctx, res = G.load_main(datasets_dir, log)
    R = res[0]
    qrts, role_unit = C6.map_legs(datasets_dir, legs, R.addrs)
    pinfo = C6.patch_pool(ctx, R, w24)
    ninfo = C6.patch_usdc(ctx, R, qrts)
    rows = G.build_rows(ctx, res, compute_labels=True)
    F.add_segments(rows, S.load_flags(datasets_dir))
    F.v4a_features(rows, res, ctx.D)
    info = {"qrts": len(qrts), "pool": pinfo, "neutralisation": {k: v for k, v in ninfo.items()
                                                                 if not k.startswith("path_gate")},
            "path_gate_neutralised": ninfo["path_gate_neutralised"]}
    return ctx, res, rows, shas, info, role_unit


def join_published(datasets_dir, ctx, rows, log):
    """B4 dev predictions (both reserves) and B6c predictions (USDC) joined by (unit, date)."""
    import pandas as pd
    D = ctx.D
    n = len(rows["t"])
    key = rows["unit"].astype(np.int64) * D + rows["t"]
    o = np.argsort(key)
    ks = key[o]
    shipped = json.load(open(os.path.join(datasets_dir, B4_RUN, "shipped-b4.json")))
    PR = {k: np.full((n, G.NC), np.nan) for k in ("b4", "v4ac", "b6c_y")}
    yb4 = np.full((n, G.NC), -1, np.int8)
    stats = {}

    def match(df):
        dk = df["unit"].to_numpy(np.int64) * D + df["date"].map(ctx.day_index).to_numpy(np.int64)
        j = np.searchsorted(ks, dk)
        ok = (j < n) & (ks[np.minimum(j, n - 1)] == dk)
        return o[j[ok]], ok

    for h in G.HNAMES:
        hi = G.HNAMES.index(h)
        for rname in ("USDC", "USDT"):
            df = pd.read_csv(os.path.join(datasets_dir, B4_RUN, f"predictions-dev-{h}-{rname}.csv.gz"))
            if rname == "USDT":
                df["unit"] = df["unit"]            # published index is the global unit index (checked below)
            rr, ok = match(df)
            stats[f"b4_{h}_{rname}_unmatched"] = int((~ok).sum())
            segs = df["segment"].to_numpy()[ok]
            folds = df["fold"].to_numpy()[ok]
            fnames = shipped["folds"]
            for xi in range(NX):
                ci = int(G.XCELL[hi, xi])
                cid = G.CELLS[ci]["id"]
                yb4[rr, ci] = df[f"y_{cid}"].to_numpy()[ok]
                for s in S.SEG_IDS:
                    m = segs == s
                    sh = shipped["cells"][cid][s]["shipped"]
                    if sh:
                        PR["b4"][rr[m], ci] = df[f"{sh}_{cid}"].to_numpy(float)[ok][m]
                    else:
                        for fi, fn in enumerate(fnames):
                            mm = m & (folds == fn)
                            v = shipped["fold_params"][str(fi)][cid]["v2"]["seg_pop"][S.SEG_IDS.index(s)]
                            PR["b4"][rr[mm], ci] = v if v is not None and np.isfinite(v) else \
                                shipped["fold_params"][str(fi)][cid]["v2"]["pop"]
        df = pd.read_csv(os.path.join(datasets_dir, B6C_RUN, f"predictions-b6c-{h}-USDC.csv.gz"))
        rr, ok = match(df)
        stats[f"b6c_{h}_unmatched"] = int((~ok).sum())
        for xi in range(NX):
            ci = int(G.XCELL[hi, xi])
            cid = G.CELLS[ci]["id"]
            PR["v4ac"][rr, ci] = df[f"v4ac_{cid}"].to_numpy(float)[ok]
            PR["b6c_y"][rr, ci] = df[f"y_{cid}"].to_numpy(float)[ok]
            bb = df[f"b4_{cid}"].to_numpy(float)[ok]
            mine = PR["b4"][rr, ci]
            both = np.isfinite(bb) & np.isfinite(mine)
            stats.setdefault("b4_vs_b6c_b4_maxabs", 0.0)
            if both.any():
                stats["b4_vs_b6c_b4_maxabs"] = max(stats["b4_vs_b6c_b4_maxabs"], float(np.abs(bb[both] - mine[both]).max()))
    return PR, yb4, stats


def own_pop(rows, folds, T):
    """G9 on the corrected labels: own = unit's training y fraction per cell (pop if none), pop = cell rate."""
    n = len(rows["t"])
    own = np.full((n, G.NC), np.nan)
    pop = np.full((n, G.NC), np.nan)
    for fi, (_, qs, qe) in enumerate(folds):
        Tqs = int(T[qs])
        te = np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0]
        for hi in range(NH):
            for xi in range(NX):
                ci = int(G.XCELL[hi, xi])
                tr = G.train_mask_cell(rows["T0"], G.HSEC[hi], Tqs, rows["RES"][:, hi], rows["CAP"][:, ci],
                                       rows["feat_ok"])
                y = rows["Y"][tr, ci].astype(float)
                u = rows["unit"][tr]
                p = float(y.mean()) if len(y) else np.nan
                O = np.bincount(u, weights=y, minlength=rows["n_units"])
                nn = np.bincount(u, minlength=rows["n_units"])
                o = np.where(nn > 0, O / np.maximum(nn, 1), p)
                own[te, ci] = o[rows["unit"][te]]
                pop[te, ci] = p
    return own, pop


def b4_theta1(rows, fold_params, cells_f, fold_of_row, idx_mask):
    """Frozen B4 fold fits at theta = 1, shipped rung or seg_pop (the display rule), monotone-fixed."""
    n = len(rows["t"])
    out = {k: np.full((n, G.NC), np.nan) for k in ("b4t1", "b4v4a_t1")}
    for fi in sorted(set(fold_of_row[idx_mask].tolist())):
        te = np.nonzero(idx_mask & (fold_of_row == fi))[0]
        if not len(te):
            continue
        raw = F.predict_frozen_b4(rows, fold_params, fi, te)
        Fx = {r: S.fix_grid(raw[r], rows["CAP"][te]) for r in F.RUNGS}
        seg = rows["seg"][te]
        p = np.full((len(te), G.NC), np.nan)
        for ci, c in enumerate(G.CELLS):
            if c["kind"] != "x":
                continue
            fp = fold_params[str(fi)][c["id"]]["v2"]
            for s in range(S.NSEG):
                m = seg == s
                sh = cells_f[c["id"]][S.SEG_IDS[s]]["shipped"]
                if sh:
                    p[m, ci] = Fx[sh][m, ci]
                else:
                    v = fp["seg_pop"][s]
                    p[m, ci] = v if v is not None and np.isfinite(v) else fp["pop"]
        out["b4t1"][te] = p
        out["b4v4a_t1"][te] = Fx["v4a"]
    return out


def fit_all_folds(ctx, rows, keep, log, folds_to_fit=None):
    fits, PRL, PRL0 = {}, np.full((len(rows["t"]), G.NC), np.nan), np.full((len(rows["t"]), G.NC), np.nan)
    tr_origin = rows["feat_ok"]
    for fi, (fname, qs, qe) in enumerate(ctx.folds):
        if folds_to_fit is not None and fi not in folds_to_fit:
            continue
        t0 = time.time()
        Tqs = int(ctx.T[qs])
        blocks = interval_training(rows, keep, tr_origin, Tqs, SEED_SAMPLE + fi)
        params, Od, Ed = fit_L(rows, blocks, Tqs)
        del blocks
        te = np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0]
        if len(te):
            mrow = np.asarray(params["m_seg"])[rows["seg"][te]]
            u = rows["unit"][te]
            theta = (Od[u] + mrow) / (Ed[u] + mrow)
            PRL[te] = S.fix_grid(predict_L(rows, params, te, theta), rows["CAP"][te])
            PRL0[te] = S.fix_grid(predict_L(rows, params, te, None), rows["CAP"][te])
        fits[fi] = params
        log(f"  fold {fname}: {params['info']['interval_rows']} interval rows, {params['info']['events']} events, "
            f"iter {params['info']['n_iter']} ({time.time() - t0:.0f} s)")
    return fits, PRL, PRL0


DEV_MODELS = ("L", "L0", "b4", "b4t1", "own", "pop")
DEV_COMPS = (("L0_vs_b4t1", "L0", "b4t1"), ("L_vs_b4", "L", "b4"), ("L0_vs_b4", "L0", "b4"),
             ("L_vs_pop", "L", "pop"), ("L_vs_own", "L", "own"), ("L0_vs_pop", "L0", "pop"),
             ("b4_vs_pop", "b4", "pop"), ("b4t1_vs_pop", "b4t1", "pop"))


def phase_dev(datasets_dir, out_dir, log, allow_dirty=False):
    rp = os.path.join(out_dir, "results-dev-r142.json")
    if os.path.exists(rp):
        raise SystemExit(f"STOP: {rp} exists")
    meta = code_meta()
    if meta["tree_dirty"] and not allow_dirty:
        raise SystemExit("STOP: commit the code before the dev run")
    os.makedirs(out_dir, exist_ok=True)
    t_start = time.time()
    started = utcnow()
    log("dev rows (B6c-corrected USDC, raw USDT) ...")
    ctx, res, rows, shas, info, role_unit = build_dev_rows(datasets_dir, log)
    PRp, yb4, jstats = join_published(datasets_dir, ctx, rows, log)
    # label gate: corrected labels equal B6c's published y on its rows; USDT labels equal B4's
    gate = {}
    for ci in G.XCELL.ravel():
        m = np.isfinite(PRp["b6c_y"][:, ci])
        gate.setdefault("b6c_rows", 0)
        gate["b6c_rows"] += int(m.sum())
        gate.setdefault("b6c_mismatch", 0)
        gate["b6c_mismatch"] += int((rows["Y"][m, ci] != PRp["b6c_y"][m, ci]).sum())
        mt = (yb4[:, ci] >= 0) & (rows["reserve"] == 1)
        gate.setdefault("b4_usdt_rows", 0)
        gate["b4_usdt_rows"] += int(mt.sum())
        gate.setdefault("b4_usdt_mismatch", 0)
        gate["b4_usdt_mismatch"] += int((rows["Y"][mt, ci] != yb4[mt, ci]).sum())
    gate.update(jstats)
    log(f"  label gate: {gate}")
    if gate["b6c_mismatch"] or gate["b4_usdt_mismatch"] or gate["b4_vs_b6c_b4_maxabs"] > 1e-6:
        raise SystemExit("STOP: label or comparator gate failed")
    Cm = cash_matrix(res, rows, ctx.D)
    keep = censor_masks(rows, Cm)
    cens = {f"x{G.SIZES[xi]}_{G.HNAMES[k]}": int((~keep[xi, k] & ~rows["CAP"][:, G.XCELL[0, xi]]).sum())
            for xi in range(NX) for k in range(NH)}
    log(f"  censored (beyond the origin cap) origin x interval cells: {sum(cens.values())}")
    log("L fits per fold ...")
    fits, PRL, PRL0 = fit_all_folds(ctx, rows, keep, log)
    own, pop = own_pop(rows, ctx.folds, ctx.T)
    shipped = json.load(open(os.path.join(datasets_dir, B4_RUN, "shipped-b4.json")))
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    b4t = b4_theta1(rows, shipped["fold_params"], shipped["cells"], rows["fold"].astype(int), test)
    PR = {"L": PRL, "L0": PRL0, "b4": PRp["b4"], "b4t1": b4t["b4t1"], "own": own, "pop": pop}
    has_b4 = np.isfinite(PR["b4"]).all(axis=1) | True
    # rows scored: test rows with a published B4 prediction in every x cell of their horizon
    pubok = np.ones(len(rows["t"]), bool)
    for ci in G.XCELL.ravel():
        pubok &= np.isfinite(PR["b4"][:, ci]) | rows["CAP"][:, ci] | ~test
    log(f"  test rows {int(test.sum())}, with all published B4 cells {int((test & pubok).sum())}")
    log("scoring ...")
    ev = evaluate(rows, PR, test & pubok, DEV_MODELS, DEV_COMPS, SEED_DEV)
    # reported: USDC only with v4ac (B6c, y_cash-trained) on its rows
    PRu = dict(PR, v4ac=PRp["v4ac"])
    usdc = (rows["reserve"] == 0)
    v4ok = np.ones(len(rows["t"]), bool)
    for ci in G.XCELL.ravel():
        v4ok &= np.isfinite(PRu["v4ac"][:, ci]) | rows["CAP"][:, ci]
    ev_u = evaluate(rows, PRu, test & pubok & usdc & v4ok, DEV_MODELS + ("v4ac",),
                    DEV_COMPS + (("L_vs_v4ac", "L", "v4ac"), ("v4ac_vs_b4", "v4ac", "b4")), SEED_DEV + 1)
    nocens = np.ones(len(rows["t"]), bool)
    for xi in range(NX):
        nocens &= keep[xi, NH - 1] | rows["CAP"][:, G.XCELL[0, xi]]
    ev_nc = evaluate(rows, PR, test & pubok & nocens, DEV_MODELS, DEV_COMPS[:3], SEED_DEV + 2)
    out = {"phase": "dev (development on seen Core USDC/USDT; not blind evidence)", "prereg": PREREG,
           "decisions": DECISIONS, "code": meta, "inputs_sha256": shas, "info": info, "label_gate": gate,
           "censored_cells": cens, "fold_params_L": {str(k): v for k, v in fits.items()},
           "q_seg": Q_SEG, "features": FEAT_NAMES, "eval": ev, "eval_usdc_with_v4ac": ev_u,
           "eval_without_censored_windows": ev_nc, "started_utc": started, "finished_utc": utcnow(),
           "runtime_s": time.time() - t_start}
    _ = has_b4
    B.write_json(rp, out, refuse_overwrite=True)
    guard_no_address(rp)
    log(f"dev: {rp} ({out['runtime_s']:.0f} s)")
    return out


# ---------------------------------------------------------------------------------------------
# D1
# ---------------------------------------------------------------------------------------------
D1_RESERVES = ("V2_USDC", "V2_USDT")
D1_FIT_BEFORE_CORE = 11        # fold index (2026Q3 Core fit) for D1 rows dated before 2023-10-01


def d1_ctx(datasets_dir, d1_dir):
    c = G.Ctx()
    c.days, c.T, c.blocks, c.asof = B.load_blocks(os.path.join(d1_dir, "blocks.csv"))
    c.D = len(c.days)
    c.day_index = {s: i for i, s in enumerate(c.days)}
    c.eth_start, _, c.oracle = B.load_eth(os.path.join(datasets_dir, "price-history/eth-usd-1h.json"))
    c.eth = np.array([B.eth_at(c.eth_start, c.oracle, int(T)) for T in c.T])
    c.eth_prev = np.array([B.eth_at(c.eth_start, c.oracle, int(T) - 86400) for T in c.T])
    c.rv7 = np.array([B.rv7_at(c.eth_start, c.oracle, int(T)) for T in c.T])
    c.rv7_last = B.rv7_at(c.eth_start, c.oracle, c.eth_start + 3600 * len(c.oracle))
    c.spike_onsets = []
    # D1 quarters (reporting and rolling baselines): 2020Q4 .. 2026Q2
    qs = []
    for y in range(2020, 2027):
        for q in range(1, 5):
            a = f"{y}-{3 * (q - 1) + 1:02d}-01"
            ny, nq = (y, q + 1) if q < 4 else (y + 1, 1)
            b = f"{ny}-{3 * (nq - 1) + 1:02d}-01"
            ia = c.day_index.get(a, 0 if a < c.days[0] else None)
            ib = c.day_index.get(b, c.D if b > c.days[-1] else None)
            if ia is None or ib is None or ia >= ib:
                continue
            qs.append((f"{y}Q{q}", ia, ib))
    c.folds = qs
    return c


def load_d1(datasets_dir, d1_dir, log):
    ctx = d1_ctx(datasets_dir, d1_dir)
    specs = {}
    for r in D1_RESERVES:
        lo = r.lower()
        d = os.path.join(d1_dir, r)
        evs = sorted(os.path.join(d, f) for f in os.listdir(d) if re.fullmatch(rf"events-{lo}-\d{{4}}\.csv\.gz", f))
        specs[r] = {"name": r, "decimals": 6, "is_usdt": 1.0 if r.endswith("USDT") else 0.0,
                    "anchors": [os.path.join(d, f"daily-balances-{lo}.csv.gz")],
                    "universe": os.path.join(d, "extended-universe.csv"), "events": evs,
                    "state": os.path.join(d, "reserve-state.csv")}
    orig = G.reserve_spec
    G.reserve_spec = lambda dd, name: specs[name]
    try:
        res = [G.load_reserve(ctx, datasets_dir, r, log) for r in D1_RESERVES]
    finally:
        G.reserve_spec = orig
    flags = {}
    for r in D1_RESERVES:
        with open(os.path.join(d1_dir, r, "holder-codes.csv")) as f:
            for x in csv.DictReader(f):
                flags[x["address"].lower()] = {"contract": x["is_contract"] == "1",
                                               "eip7702": x["eip7702_delegated"] == "1", "adapter": False}
    return ctx, res, flags


def d1_rows(datasets_dir, d1_dir, log, qrt=True):
    ctx, res, flags = load_d1(datasets_dir, d1_dir, log)
    qinfo = {}
    if qrt:
        qinfo = apply_qrt_d1(ctx, res, d1_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=True)
    F.add_segments(rows, flags)
    F.v4a_features(rows, res, ctx.D)
    # model fold per row: Core fold of the row's quarter from 2023Q4, the 2026Q3 Core fit before
    shipped_folds = ["2023Q4", "2024Q1", "2024Q2", "2024Q3", "2024Q4", "2025Q1", "2025Q2", "2025Q3", "2025Q4",
                     "2026Q1", "2026Q2", "2026Q3"]
    qname = np.array([""] * len(rows["t"]), dtype=object)
    for qn, a, b in ctx.folds:
        qname[(rows["t"] >= a) & (rows["t"] < b)] = qn
    mf = np.array([shipped_folds.index(q) if q in shipped_folds else D1_FIT_BEFORE_CORE for q in qname])
    rows["model_fold"] = mf.astype(np.int16)
    rows["qname"] = qname
    return ctx, res, rows, qinfo


def qrt_from_events(d1_dir, R):
    """R9.1(b) QRT detector (r9_correct.detect_qrt, thresholds unchanged) on one D1 reserve's decoded events.
    Supply before a burn = exact scaled total supply at the end of the previous transaction x the burn's index
    (every Mint / Burn of the aToken since its first log is in the files). -> qrts in the b6c_cash.map_legs format."""
    import pandas as pd
    import r9_correct as R9
    lo = R.name.lower()
    d = os.path.join(d1_dir, R.name)
    files = sorted(os.path.join(d, f) for f in os.listdir(d) if re.fullmatch(rf"events-{lo}-\d{{4}}\.csv\.gz", f))
    ev = pd.concat([pd.read_csv(f, dtype=str, keep_default_na=False) for f in files], ignore_index=True)
    blk = ev["block"].astype(np.int64).to_numpy()
    txi = ev["tx_index"].astype(np.int64).to_numpy()
    li = ev["log_index"].astype(np.int64).to_numpy()
    o = np.lexsort((li, blk))
    ev = ev.iloc[o].reset_index(drop=True)
    blk, txi, li = blk[o], txi[o], li[o]
    ts = ev["ts"].astype(np.int64).to_numpy()
    typ = ev["type"].to_numpy()
    val = [int(v) for v in ev["value_raw"]]
    idx = [int(v) for v in ev["index_ray"]]
    p1 = ev["party1"].str.lower().to_numpy()
    tot = 0
    sup_before = {}
    cur_tx, tx_start_tot = None, 0
    unit_events, burns = {}, []
    for i in range(len(ev)):
        tk = (int(blk[i]), int(txi[i]))
        if tk != cur_tx:
            cur_tx, tx_start_tot = tk, tot
        sv = R9.ray_div(val[i], idx[i])
        key = (int(blk[i]), int(txi[i]), int(li[i]))
        if typ[i] == "Mint":
            tot += sv
            if val[i] > 0:
                unit_events.setdefault(p1[i], []).append((key, int(ts[i]), "M", val[i], i))
        elif typ[i] == "Burn":
            tot -= sv
            burns.append({"key": key, "unit": p1[i], "w": val[i], "ts": int(ts[i]), "i": i})
            sup_before[i] = R9.ray_mul(tx_start_tot, idx[i])
        elif typ[i] == "BalanceTransfer":
            unit_events.setdefault(p1[i], []).append((key, int(ts[i]), "T", 0, i))
    found = R9.detect_qrt(burns, unit_events, lambda b: sup_before[b["i"]])
    aarr = np.array(R.addrs)
    qrts = []
    for qi, q in enumerate(found):
        b = q["burn"]
        a = b["unit"]
        ui = int(np.searchsorted(aarr, a))
        unit = ui if ui < len(aarr) and aarr[ui] == a else -1
        rl = [(int(blk[ref]), int(li[ref]), int(t), int(take)) for ref, take, t, key in q["legs"]]
        qrts.append({"qrt": qi, "role": f"d1-{unit}", "unit": unit, "w_block": int(blk[b["i"]]),
                     "w_log": int(li[b["i"]]), "w_ts": b["ts"], "neutral": int(q["neutral"]), "redeposit": sorted(rl),
                     "done_ts": max(x[2] for x in rl)})
    return qrts


def apply_qrt_d1(ctx, res, d1_dir, log):
    """R9.1(b) on D1 with the B6c patch (paths, label-view and feature-view anchors) on each reserve."""
    import b6c_cash as C6
    out = {}
    for R in res:
        qrts = qrt_from_events(d1_dir, R)
        inu = [q for q in qrts if q["unit"] >= 0]
        by_year = {}
        for q in qrts:
            y = datetime.fromtimestamp(q["w_ts"], timezone.utc).year
            by_year[str(y)] = by_year.get(str(y), 0) + 1
        info = C6.patch_usdc(ctx, R, inu) if inu else {"note": "no QRT in the universe"}
        out[R.name] = {"qrts": len(qrts), "qrts_in_universe": len(inu), "units": len({q["unit"] for q in inu}),
                       "by_year": by_year, "neutralised_usd": sum(q["neutral"] for q in inu) / 1e6,
                       "path_gate": {k: v for k, v in info.items() if k.startswith("path_gate")}}
        log(f"  QRT {R.name}: {out[R.name]['qrts']} ({out[R.name]['qrts_in_universe']} in the universe)")
    return out


def phase_counts(datasets_dir, d1_dir, out_dir, log):
    """Counts only: units, rows, test rows, exits per (cell, segment pool). No rate, model or score."""
    os.makedirs(out_dir, exist_ok=True)
    p = os.path.join(out_dir, "counts-d1.json")
    if os.path.exists(p):
        raise SystemExit(f"STOP: {p} exists")
    ctx, res, rows, qinfo = d1_rows(datasets_dir, d1_dir, log)
    test = rows["feat_ok"]
    pools = {"thin": list(THIN_IDX), "all": list(range(S.NSEG))}
    pools.update({s: [i] for i, s in enumerate(S.SEG_IDS)})
    cnt = {}
    for hi in range(NH):
        for xi in range(NX):
            ci = int(G.XCELL[hi, xi])
            base = test & rows["RES"][:, hi] & ~rows["CAP"][:, ci]
            for lab, ss in pools.items():
                m = base & np.isin(rows["seg"], ss)
                y = rows["Y"][m, ci]
                cnt.setdefault(G.CELLS[ci]["id"], {})[lab] = {
                    "rows": int(m.sum()), "exits": int(y.sum()), "days": int(len(np.unique(rows["t"][m]))),
                    "units": int(len(np.unique(rows["unit"][m]))),
                    "n_ep": int(G.n_episodes(rows["unit"][m], rows["t"][m], y.astype(float)))}
    prim = {}
    for h in PRIMARY_H:
        hi = G.HNAMES.index(h)
        prim[h] = {"thin_pairs": sum(cnt[G.CELLS[int(G.XCELL[hi, xi])]["id"]]["thin"]["rows"] for xi in range(NX)),
                   "thin_exits": sum(cnt[G.CELLS[int(G.XCELL[hi, xi])]["id"]]["thin"]["exits"] for xi in range(NX))}
    out = {"phase": "counts (D1 counts-only check; no rate, model or score)", "code": code_meta(),
           "units": {R.name: R.n for R in res}, "rows": int(len(rows["t"])), "rows_feat_ok": int(test.sum()),
           "rows_by_segment": {s: int((test & (rows["seg"] == i)).sum()) for i, s in enumerate(S.SEG_IDS)},
           "rows_by_model_fold": {str(k): int(v) for k, v in zip(*np.unique(rows["model_fold"][test], return_counts=True))},
           "qrt": qinfo, "cells": cnt, "primary_counts": prim, "created_utc": utcnow()}
    B.write_json(p, out, refuse_overwrite=True)
    guard_no_address(p)
    log(json.dumps(prim))
    return out


def d1_manifest(d1_dir):
    out = {}
    for root, _, fs in os.walk(d1_dir):
        for f in sorted(fs):
            if f.endswith((".csv", ".csv.gz")) and "logs" not in root and not f.startswith("state-raw"):
                pth = os.path.join(root, f)
                out[os.path.relpath(pth, d1_dir)] = B.sha256_file(pth)
    return out


def phase_freeze(dev_results, d1_dir, out_dir, readings, log):
    os.makedirs(out_dir, exist_ok=True)
    fp = os.path.join(out_dir, "frozen-r142.json")
    if os.path.exists(fp):
        raise SystemExit(f"STOP: {fp} exists")
    meta = code_meta()
    if meta["tree_dirty"]:
        raise SystemExit("STOP: commit the code before the freeze")
    dev = json.load(open(dev_results))
    frozen = {"prereg": PREREG, "readings": readings, "code": meta, "decisions": DECISIONS,
              "dev_results_sha256": B.sha256_file(dev_results), "dev_code": dev["code"],
              "fold_params_L": dev["fold_params_L"], "features": FEAT_NAMES, "q_seg": Q_SEG,
              "primary": {"model": "L0", "comparator": "b4t1", "horizons": list(PRIMARY_H), "pool": list(THIN),
                          "statistic": "BSS, Brier summed over the 5 x cells (stacked pairs), 30-day day blocks",
                          "holm_alpha": ALPHA, "R_band": list(R_BAND), "guard_cells": [list(g) for g in HIGH_GUARD],
                          "guard_lo": GUARD_LO},
              "d1_fit_before_core_fold": D1_FIT_BEFORE_CORE, "seeds": {"d1_bootstrap": SEED_D1},
              "d1_inputs_sha256": d1_manifest(d1_dir), "b4_run": B4_RUN, "frozen_utc": utcnow()}
    B.write_json(fp, frozen, refuse_overwrite=True)
    guard_no_address(fp)
    rec = {"frozen_sha256": B.sha256_file(fp), "frozen_utc": frozen["frozen_utc"], "code_head": meta["git_head"]}
    B.write_json(os.path.join(out_dir, "freeze-record.json"), rec, refuse_overwrite=True)
    log(f"freeze: {rec}")
    return rec


def rolling_own_pop(rows, ctx):
    """D1 plain history (own) and empirical frequency (pop): G9 on D1 rows resolved before each D1 quarter start."""
    n = len(rows["t"])
    own = np.full((n, G.NC), np.nan)
    pop = np.full((n, G.NC), np.nan)
    for qn, qs, qe in ctx.folds:
        Tqs = int(ctx.T[qs]) if qs < ctx.D else int(ctx.T[-1]) + 86400
        te = np.nonzero((rows["t"] >= qs) & (rows["t"] < qe) & rows["feat_ok"])[0]
        if not len(te):
            continue
        for hi in range(NH):
            for xi in range(NX):
                ci = int(G.XCELL[hi, xi])
                tr = G.train_mask_cell(rows["T0"], G.HSEC[hi], Tqs, rows["RES"][:, hi], rows["CAP"][:, ci],
                                       rows["feat_ok"])
                y = rows["Y"][tr, ci].astype(float)
                if not len(y):
                    continue
                u = rows["unit"][tr]
                p = float(y.mean())
                O = np.bincount(u, weights=y, minlength=rows["n_units"])
                nn = np.bincount(u, minlength=rows["n_units"])
                o = np.where(nn > 0, O / np.maximum(nn, 1), p)
                own[te, ci] = o[rows["unit"][te]]
                pop[te, ci] = p
    return own, pop


D1_MODELS = ("L0", "b4t1", "b4v4a_t1", "pop_core", "own_d1", "pop_d1")
D1_COMPS = (("L0_vs_b4t1", "L0", "b4t1"), ("L0_vs_b4v4a_t1", "L0", "b4v4a_t1"), ("L0_vs_pop_core", "L0", "pop_core"),
            ("b4t1_vs_pop_core", "b4t1", "pop_core"))
D1_COMPS_HIST = (("L0_vs_own_d1", "L0", "own_d1"), ("L0_vs_pop_d1", "L0", "pop_d1"),
                 ("b4t1_vs_own_d1", "b4t1", "own_d1"), ("b4t1_vs_pop_d1", "b4t1", "pop_d1"))


def holm(pvals, alpha=ALPHA):
    order = sorted(range(len(pvals)), key=lambda i: pvals[i])
    rej = [False] * len(pvals)
    for r, i in enumerate(order):
        if pvals[i] <= alpha / (len(pvals) - r):
            rej[i] = True
        else:
            break
    return rej


def phase_run(datasets_dir, d1_dir, out_dir, frozen_sha256, log):
    rec = json.load(open(os.path.join(out_dir, "freeze-record.json")))
    fp = os.path.join(out_dir, "frozen-r142.json")
    if frozen_sha256 != rec["frozen_sha256"] or B.sha256_file(fp) != rec["frozen_sha256"]:
        raise SystemExit("STOP: frozen sha256 differs from the freeze record")
    meta = code_meta()
    if meta["tree_dirty"]:
        raise SystemExit("STOP: dirty tree")
    frozen = json.load(open(fp))
    if d1_manifest(d1_dir) != frozen["d1_inputs_sha256"]:
        raise SystemExit("STOP: D1 inputs differ from the frozen manifest")
    marker = os.path.join(out_dir, "run-started.json")
    started = utcnow()
    B.write_json(marker, {"started_utc": started, "frozen_sha256": frozen_sha256, "code": meta}, refuse_overwrite=True)
    t0 = time.time()
    ctx, res, rows, qinfo = d1_rows(datasets_dir, d1_dir, log)
    shipped = json.load(open(os.path.join(datasets_dir, B4_RUN, "shipped-b4.json")))
    test = rows["feat_ok"].copy()
    n = len(rows["t"])
    mf = rows["model_fold"].astype(int)
    PR = {k: np.full((n, G.NC), np.nan) for k in ("L0", "pop_core")}
    for fi in sorted(set(mf[test].tolist())):
        te = np.nonzero(test & (mf == fi))[0]
        PR["L0"][te] = S.fix_grid(predict_L(rows, frozen["fold_params_L"][str(fi)], te, None), rows["CAP"][te])
        for ci in G.XCELL.ravel():
            PR["pop_core"][te, ci] = shipped["fold_params"][str(fi)][G.CELLS[ci]["id"]]["v2"]["pop"]
    PR.update(b4_theta1(rows, shipped["fold_params"], shipped["cells"], mf, test))
    PR["own_d1"], PR["pop_d1"] = rolling_own_pop(rows, ctx)
    log("scoring ...")
    ev = evaluate(rows, PR, test, D1_MODELS[:4], D1_COMPS, SEED_D1)
    hist_ok = np.ones(n, bool)
    for ci in G.XCELL.ravel():
        hist_ok &= np.isfinite(PR["pop_d1"][:, ci]) | rows["CAP"][:, ci]
    ev_hist = evaluate(rows, PR, test & hist_ok, D1_MODELS, D1_COMPS_HIST, SEED_D1 + 1)
    # verdict (registered in D-R14.2a)
    pv = [ev["primary"][h]["bss"]["L0_vs_b4t1"]["p_one_sided"] for h in PRIMARY_H]
    rej = holm(pv)
    prim = {}
    for h, r in zip(PRIMARY_H, rej):
        P = ev["primary"][h]
        R = P["R"]["L0"]
        prim[h] = {"bss": P["bss"]["L0_vs_b4t1"]["bss"], "ci95": P["bss"]["L0_vs_b4t1"].get("ci95"),
                   "p_one_sided": P["bss"]["L0_vs_b4t1"]["p_one_sided"], "holm_reject": r, "R_L0": R,
                   "R_in_band": R is not None and R_BAND[0] <= R <= R_BAND[1],
                   "pass": bool(r and R is not None and R_BAND[0] <= R <= R_BAND[1])}
    guard = {}
    for cid, sg in HIGH_GUARD:
        c = ev["cells"][cid][sg]["bss"].get("L0_vs_b4t1") if ev["cells"][cid][sg].get("bss") else None
        lo = c["ci95"][0] if c and c.get("ci95") else None
        guard[f"{cid}_{sg}"] = {"bss": c["bss"] if c else None, "ci95": c.get("ci95") if c else None,
                                "pass": lo is not None and lo > GUARD_LO}
    passed = any(v["pass"] for v in prim.values()) and all(v["pass"] for v in guard.values())
    out = {"phase": "run (D1 blind set, once)", "prereg": PREREG, "frozen_sha256": frozen_sha256, "code": meta,
           "qrt": qinfo, "units": {R.name: R.n for R in res}, "rows": int(n), "rows_scored": int(test.sum()),
           "verdict": {"PASS": bool(passed), "primary": prim, "guard": guard}, "eval": ev, "eval_with_d1_history": ev_hist,
           "started_utc": started, "finished_utc": utcnow(), "runtime_s": time.time() - t0}
    rp = os.path.join(out_dir, "results-d1-r142.json")
    B.write_json(rp, out, refuse_overwrite=True)
    guard_no_address(rp)
    log(f"run: PASS = {passed}; {rp}")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=("dev", "counts", "freeze", "run"))
    ap.add_argument("--datasets", default=os.path.expanduser("~/membrane-datasets"))
    ap.add_argument("--d1", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--allow-dirty", action="store_true")
    ap.add_argument("--frozen-sha256", default=None)
    ap.add_argument("--dev-results", default=None)
    ap.add_argument("--readings", default=None, help="JSON of the D-R14.2a readings (board commit, deviation id)")
    a = ap.parse_args(argv)

    def log(m):
        print(f"[{utcnow()}] {m}", flush=True)
    if a.phase == "dev":
        phase_dev(a.datasets, a.out, log, a.allow_dirty)
    elif a.phase == "counts":
        phase_counts(a.datasets, a.d1, a.out, log)
    elif a.phase == "freeze":
        phase_freeze(a.dev_results, a.d1, a.out, json.load(open(a.readings)), log)
    else:
        phase_run(a.datasets, a.d1, a.out, a.frozen_sha256, log)


if __name__ == "__main__":
    sys.exit(main())
