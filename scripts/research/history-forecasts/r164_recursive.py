#!/usr/bin/env python3
"""Q26 R16.4: recursive (fH) path simulation and probability ranges for touch odds.

membrane-board `design/Q26_ROUND16_PREREG.md` section R16.4. Parents: A6 (`design/HISTORY_TOUCH_PREREG_A6.md`),
R16.1 (same file), D-R13.5c, `design/q26-retro-twoway-2026-10-19.md`, `design/q26-standardization-diagnosis-2026-10-19.md`.

DEVELOPMENT ON SEEN DATA ONLY: the A6 development pool (88 series) and blind set 5 (42 series, grade C for touch),
exactly the R16.1 development series. No reserved or unseen set is opened by any phase of this file.

Recursive (fH) ("fR"), per step size s in {1, 3, 6, 12} hours (12 h primary, owner guidance 2026-10-19):
  * step model: log-HAR of the s-hour realised close-to-close vol on [1, ln D, ln W, ln M] (A6 Parkinson components,
    the (fH) design with T = s), OLS on origins whose s-bar target window ends before the fold start;
  * pool: every training origin j's next s hourly bars (close, high, low as log ratios to close[j-1]) divided by that
    origin's step forecast sigma_s(j) / sqrt(8760) (standardized blocks; any multiplicative bias of sigma_s cancels);
  * simulation from origin i0: N paths; per step draw a block per path, scale by the path's current sigma_s, append
    the simulated bars, update the path's Parkinson D/W/M windows from the simulated high/low, recompute sigma_s;
    the touch odds at T are the share of paths whose running min low reaches ln(1 + level) by bar T.
  Modes (common random numbers across modes):
    rec   recursive (vol inputs updated after every step)
    fix   the same engine with sigma_s frozen at the origin for the whole horizon (ablation: no feedback)
    recb  rec + vol-state bias correction: the draw is scaled by lambda_b = rms of the pool's standardized step return
          in the path's vol-state quintile b / overall rms (diagnosis 2026-10-19, fault 1 analogue for sigma_s)
    recc  rec + standardized blocks sampled conditional on the path's vol-state quintile
  Vol state = ln sigma_s - 0.5 ln M (short forecast vs monthly level), quintile edges from the training pool.

STEP SELECTION RULE (fixed in this docstring before any development output, owner guidance 2026-10-19):
  compared on the shared subsample (00:00Z origins on days since epoch divisible by 14, all 130 series), mode rec only, steps 1/3/6/12 h.
  Score = mean Brier over the 7 d and 30 d rows (all levels, equal weight per horizon). Calibration guard: the
  step's median |ln R| over the 7 d and 30 d level cells must be <= the 12 h step's + 0.02. The selected step is the
  guard-passing step with the lowest score; 12 h is kept unless another step's two-way (series x 182-day block)
  bootstrap z of the mean Brier difference vs 12 h is <= -2.0. Any other choice is labelled post hoc and cannot
  become a blind primary without fresh development justification.

Phases
  known      instrument check 1: GJR/GARCH-t synthetic hourly data with Brownian-bridge intrahour lows; the true touch
             odds come from the true model (exact state); recursive, fixed and the A6 (f)/(fH) recipes are scored
             against the truth -> known.json
  lookahead  instrument check 2: predictions recomputed with every bar at or after the origin deleted must be
             identical -> lookahead.json
  dev        per series: A6 recipes (a, f, fbL, fH) + fR modes at daily 00:00Z origins + (fH) block-bootstrap refits
             (parameter-uncertainty ranges) -> <out>/rows/<series>.npz
  score      Part A statistics -> score.json
  ranges     Part B range constructions and series x time-block CV validation -> ranges.json
The A..A6 code is imported and never modified. Free data only. No address, key or secret.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as M6  # noqa: E402

ANNUAL = 8760.0
SQA = math.sqrt(ANNUAL)
PARK = M6.PARK
EVAL_T = (24, 72, 168, 720)
HMAX = max(EVAL_T)
HISTW = 720
NB_STATE = 5
SEED = 20261640
CMP_RUNGS = ("a", "f", "fbL", "fH")
BOOT_B = 20
BOOT_BLOCK_H = 720
BLIND5_COMMIT = "f9389b6"
DAY = 86400
MAIN_EVERY = 2          # main-step (12 h) origins: 00:00Z on days divisible by 2 (days since epoch)
MODES_EVERY = 4         # fix / recb / recc on days divisible by 4


# ---------------------------------------------------------------------------------------------
# Step model and simulator
# ---------------------------------------------------------------------------------------------
def raw_blocks(close, high, low, s):
    """(N+1, s, 3) float32: for origin j, bars j..j+s-1 as ln(close/close[j-1]), ln(high/close[j-1]),
    ln(low/close[j-1]). NaN where any input is missing or out of range."""
    n = len(close)
    out = np.full((n + 1, s, 3), np.nan, np.float32)
    with np.errstate(invalid="ignore", divide="ignore"):
        lc, lh, ll = np.log(close), np.log(high), np.log(low)
    j = np.arange(1, n - s + 1)          # origins with spot close[j-1] and bars up to j+s-1 <= n-1
    for m in range(s):
        out[j, m, 0] = lc[j + m] - lc[j - 1]
        out[j, m, 1] = lh[j + m] - lc[j - 1]
        out[j, m, 2] = ll[j + m] - lc[j - 1]
    return out


class SeriesInputs:
    """Per-series arrays shared by all folds and step sizes."""

    def __init__(self, close, high, low, start_i, steps=(12,)):
        self.close, self.high, self.low = close, high, low
        self.start_i = start_i
        self.N = len(close)
        self.v = M6.parkinson_v(high, low)
        self.har = M6.har_components(high, low, start_i)
        with np.errstate(invalid="ignore", divide="ignore"):
            self.LX = np.log(self.har)
        self.okX = np.all(np.isfinite(self.LX), axis=1)
        self.steps = {}
        for s in steps:
            with np.errstate(invalid="ignore", divide="ignore"):
                lsf = np.log(M6.sigma_fut(close, s, start_i))
            blk = raw_blocks(close, high, low, s)
            okb = np.all(np.isfinite(blk.reshape(len(blk), -1)), axis=1)
            self.steps[s] = {"lsf": lsf, "blk": blk, "okb": okb}


class StepModel:
    def __init__(self, si: SeriesInputs, s, qs_i):
        """Fit on information available at origin qs_i (fold start): HAR rows j with j + s <= qs_i."""
        self.s = s
        d = si.steps[s]
        lim = qs_i - s
        j = np.arange(si.N + 1)
        okr = (j <= lim) & si.okX & np.isfinite(d["lsf"])
        self.ok = False
        if okr.sum() < 200:
            return
        X = np.column_stack([np.ones(okr.sum()), si.LX[okr]])
        y = d["lsf"][okr]
        self.coef = np.linalg.lstsq(X, y, rcond=None)[0]
        okp = (j <= lim) & si.okX & d["okb"]
        if okp.sum() < 200:
            return
        jp = np.where(okp)[0]
        lsig = np.column_stack([np.ones(len(jp)), si.LX[jp]]) @ self.coef
        sig = np.exp(lsig)
        U = d["blk"][jp] / (sig / SQA)[:, None, None].astype(np.float32)
        self.U = np.ascontiguousarray(U, np.float32)
        st = lsig - 0.5 * si.LX[jp, 2]
        self.edges = np.quantile(st, np.linspace(0, 1, NB_STATE + 1)[1:-1])
        b = np.searchsorted(self.edges, st)
        self.bin_idx = [np.where(b == k)[0] for k in range(NB_STATE)]
        r2 = U[:, -1, 0].astype(float) ** 2
        rms = math.sqrt(r2.mean())
        self.lam = np.array([math.sqrt(r2[ix].mean()) / rms if len(ix) else 1.0 for ix in self.bin_idx])
        self.n_pool = len(jp)
        self.ok = True

    def lsig(self, LD, LW, LM):
        c = self.coef
        return c[0] + c[1] * LD + c[2] * LW + c[3] * LM


def hist_buffers(si: SeriesInputs, i0):
    """Finite-value cumulative sums and counts of the real Parkinson v over bars i0-HISTW .. i0-1."""
    lo = i0 - HISTW
    v = np.full(HISTW, np.nan)
    a = max(lo, 0)
    v[a - lo:] = si.v[a:i0]
    fin = np.isfinite(v)
    ch = np.concatenate([[0.0], np.cumsum(np.where(fin, v, 0.0))])
    cn = np.concatenate([[0], np.cumsum(fin)])
    return ch, cn


def simulate(model: StepModel, si: SeriesInputs, i0, lnk, n_paths, seed, modes=("rec", "fix", "recb", "recc"),
             Ts=EVAL_T):
    """Touch odds {mode: (len(Ts), K)} from origin i0. Returns None when the origin's HAR inputs are missing."""
    if not (model.ok and si.okX[i0]):
        return None
    s = model.s
    nst = HMAX // s
    rng = np.random.default_rng(seed)
    Uu = rng.random((nst, n_paths))
    ch, cn = hist_buffers(si, i0)
    W = M6.HAR_WINDOWS
    LX0 = si.LX[i0]
    lsig0 = model.lsig(*LX0)
    t_idx = {T: T // s for T in Ts}
    lnk = np.asarray(lnk, float)
    out = {}
    for mode in modes:
        L = np.zeros(n_paths)
        runmin = np.full(n_paths, np.inf)
        cs = np.zeros((n_paths, HMAX + 1))
        res = np.zeros((len(Ts), len(lnk)))
        lsig = np.full(n_paths, lsig0)
        for k in range(nst):
            t = k * s
            if k > 0 and mode != "fix":
                comps = []
                for w in W:
                    a = t - w
                    if a >= 0:
                        ssum = cs[:, t] - cs[:, a]
                        cnt = w
                    else:
                        ssum = cs[:, t] + (ch[HISTW] - ch[HISTW + a])
                        cnt = t + (cn[HISTW] - cn[HISTW + a])
                    comps.append(np.log(np.maximum(ANNUAL * ssum / cnt, 1e-300)))
                lsig = model.lsig(*comps)
            st = lsig - 0.5 * (LX0[2] if (mode == "fix" or k == 0) else comps[2])
            u = Uu[k]
            if mode == "recc":
                b = np.searchsorted(model.edges, st)
                idx = np.empty(n_paths, np.int64)
                for bb in range(NB_STATE):
                    m = b == bb
                    if m.any():
                        pool = model.bin_idx[bb]
                        idx[m] = pool[np.minimum((u[m] * len(pool)).astype(np.int64), len(pool) - 1)]
            else:
                idx = np.minimum((u * model.n_pool).astype(np.int64), model.n_pool - 1)
            sc = np.exp(lsig) / SQA
            if mode == "recb":
                sc = sc * model.lam[np.searchsorted(model.edges, st)]
            blk = model.U[idx].astype(float) * sc[:, None, None]
            lows = L[:, None] + blk[:, :, 2]
            runmin = np.minimum(runmin, lows.min(axis=1))
            vv = (blk[:, :, 1] - blk[:, :, 2]) ** 2 * PARK
            cs[:, t + 1:t + s + 1] = cs[:, t:t + 1] + np.cumsum(vv, axis=1)
            L = L + blk[:, -1, 0]
            for ti, T in enumerate(Ts):
                if t_idx[T] == k + 1:
                    res[ti] = (runmin[:, None] <= lnk[None, :]).mean(axis=0)
        out[mode] = res
    return out


# ---------------------------------------------------------------------------------------------
# Compiled simulator (numba); must equal `simulate` exactly on the same random numbers (checked in `lookahead`)
# ---------------------------------------------------------------------------------------------
try:
    import numba as _nb
except ImportError:          # pragma: no cover
    _nb = None

MODE_ID = {"rec": 0, "fix": 1, "recb": 2, "recc": 3}


def _kernel_py(U, coef, edges, bin_order, bin_starts, lam, hist_v, LX0, Uu, mode, s, Ts, lnk):
    n_pool = U.shape[0]
    nst, n_paths = Uu.shape
    nT, K = Ts.shape[0], lnk.shape[0]
    hits = np.zeros((nT, K))
    W = (24, 168, 720)
    vsim = np.empty(HMAX)
    sums0 = np.zeros(3)
    cnts0 = np.zeros(3)
    for wi in range(3):
        w = W[wi]
        for q in range(HISTW - w, HISTW):
            x = hist_v[q]
            if x == x:
                sums0[wi] += x
                cnts0[wi] += 1.0
    sums = np.zeros(3)
    cnts = np.zeros(3)
    for pth in range(n_paths):
        for wi in range(3):
            sums[wi] = sums0[wi]
            cnts[wi] = cnts0[wi]
        L = 0.0
        rmin = 1e300
        lsig = coef[0] + coef[1] * LX0[0] + coef[2] * LX0[1] + coef[3] * LX0[2]
        lnM = LX0[2]
        t = 0
        for k in range(nst):
            if k > 0 and mode != 1:
                lD = math.log(max(ANNUAL * sums[0] / cnts[0], 1e-300))
                lW = math.log(max(ANNUAL * sums[1] / cnts[1], 1e-300))
                lnM = math.log(max(ANNUAL * sums[2] / cnts[2], 1e-300))
                lsig = coef[0] + coef[1] * lD + coef[2] * lW + coef[3] * lnM
            st = lsig - 0.5 * lnM
            b = 0
            for e in range(edges.shape[0]):
                if edges[e] < st:
                    b = e + 1
            u = Uu[k, pth]
            if mode == 3:
                a0 = bin_starts[b]
                nb_ = bin_starts[b + 1] - a0
                j = int(u * nb_)
                if j > nb_ - 1:
                    j = nb_ - 1
                idx = bin_order[a0 + j]
            else:
                idx = int(u * n_pool)
                if idx > n_pool - 1:
                    idx = n_pool - 1
            sc = math.exp(lsig) / SQA
            if mode == 2:
                sc = sc * lam[b]
            for m in range(s):
                hh = float(U[idx, m, 1]) * sc
                ll = float(U[idx, m, 2]) * sc
                lo = L + ll
                if lo < rmin:
                    rmin = lo
                v = (hh - ll) ** 2 * PARK
                vsim[t] = v
                for wi in range(3):
                    w = W[wi]
                    sums[wi] += v
                    cnts[wi] += 1.0
                    q = HISTW + t - w          # position leaving the window
                    if q >= 0:
                        if q < HISTW:
                            x = hist_v[q]
                            if x == x:
                                sums[wi] -= x
                                cnts[wi] -= 1.0
                        else:
                            sums[wi] -= vsim[q - HISTW]
                            cnts[wi] -= 1.0
                t += 1
                for ti in range(nT):
                    if Ts[ti] == t:
                        for kk in range(K):
                            if rmin <= lnk[kk]:
                                hits[ti, kk] += 1.0
            L = L + float(U[idx, s - 1, 0]) * sc
    return hits / n_paths


_kernel = _nb.njit(cache=True, fastmath=False)(_kernel_py) if _nb is not None else _kernel_py


def prep_fast(model: StepModel):
    if getattr(model, "_fast", None) is None and model.ok:
        order = np.concatenate(model.bin_idx).astype(np.int64)
        starts = np.concatenate([[0], np.cumsum([len(ix) for ix in model.bin_idx])]).astype(np.int64)
        model._fast = (np.ascontiguousarray(model.U), np.asarray(model.coef, float), np.asarray(model.edges, float),
                       order, starts, np.asarray(model.lam, float))
    return model._fast


def simulate_fast(model: StepModel, si: SeriesInputs, i0, lnk, n_paths, seed, modes=("rec", "fix", "recb", "recc"),
                  Ts=EVAL_T):
    """Same contract and random numbers as `simulate`; compiled kernel."""
    if not (model.ok and si.okX[i0]):
        return None
    s = model.s
    nst = HMAX // s
    rng = np.random.default_rng(seed)
    Uu = rng.random((nst, n_paths))
    lo = i0 - HISTW
    hv = np.full(HISTW, np.nan)
    a = max(lo, 0)
    hv[a - lo:] = si.v[a:i0]
    U, coef, edges, order, starts, lam = prep_fast(model)
    LX0 = np.asarray(si.LX[i0], float)
    Ta = np.asarray(Ts, np.int64)
    lk = np.asarray(lnk, float)
    return {m: _kernel(U, coef, edges, order, starts, lam, hv, LX0, Uu, MODE_ID[m], s, Ta, lk) for m in modes}


# ---------------------------------------------------------------------------------------------
# (fH) block-bootstrap refits (parameter-uncertainty range, construction (i))
# ---------------------------------------------------------------------------------------------
def fh_boot(P6, qs_i, te, rng, B=BOOT_B):
    """B replicate (fH) predictions (B, len(te), K) at test origins te: training origins resampled in 30-day blocks;
    HAR coefficients and the standardized-depth ECDF refitted with the replicate weights."""
    P = P6.P
    lim = qs_i - P6.T_h
    n = P6.n
    i = np.arange(n)
    okr = P6.okH & (i <= lim)
    if okr.sum() < 50:
        return None
    rows = np.where(okr)[0]
    blk = (rows - rows[0]) // BOOT_BLOCK_H
    nb = int(blk.max()) + 1
    X = P6.X[rows]
    y = P6.lfut[rows]
    XtX = np.zeros((nb, 4, 4))
    Xty = np.zeros((nb, 4))
    np.add.at(XtX, blk, X[:, :, None] * X[:, None, :])
    np.add.at(Xty, blk, X * y[:, None])
    dep = P.depth[rows]
    Xte = P6.X[te]
    okte = P6.okX[te]
    out = np.full((B, len(te), P6.K), np.nan)
    for b in range(B):
        w = rng.multinomial(nb, np.full(nb, 1.0 / nb)).astype(float)
        try:
            c = np.linalg.solve(np.tensordot(w, XtX, 1), np.tensordot(w, Xty, 1))
        except np.linalg.LinAlgError:
            continue
        sH = np.exp(X @ c)
        z = dep / (sH * P.scale)
        wr = w[blk]
        okz = np.isfinite(z) & (wr > 0)
        zs, ws = z[okz], wr[okz]
        o = np.argsort(zs)
        zs, cw = zs[o], np.cumsum(ws[o])
        tot = cw[-1]
        sHte = np.full(len(te), np.nan)
        sHte[okte] = np.exp(Xte[okte] @ c)
        thr = P.thresholds(sHte)
        ok = np.all(np.isfinite(thr), axis=1)
        pos = np.searchsorted(zs, thr[ok], side="right")
        val = np.where(pos > 0, cw[np.maximum(pos - 1, 0)], 0.0) / tot
        out[b, ok] = val
    return out


# ---------------------------------------------------------------------------------------------
# dev phase
# ---------------------------------------------------------------------------------------------
_S = {}


def _identity_maps(self, qs_i, sH, zH, validH, rows_out=False):
    m = {bb: (M6.IDENTITY.copy(), {"n_rows": 0, "iterations": 0, "converged": True, "n_eval": 0,
                                   "rule": "R16.4: (fHb) not a candidate, map skipped"}) for bb in range(self.nb)}
    return (m, {}) if rows_out else m


def series_seed(name):
    return int(hashlib.sha256(name.encode()).hexdigest()[:8], 16)


def run_series(ser, folds, n_paths, steps_main=(12,), steps_sub=(6, 3, 1), sub_every_days=7, do_boot=True,
               modes_main=("rec", "fix", "recb", "recc"), log=None):
    M6.Prep6.beta_maps = _identity_maps
    q_max = max(f["qs_i"] for f in folds)
    per_T, boots = {}, {}
    sid = series_seed(ser.name)
    rngb = np.random.default_rng([SEED, sid, 7])
    for T_h in M6.HORIZONS_H:
        P6 = M6.Prep6(ser, T_h, q_max=q_max)
        per_T[T_h] = M6.fold_loop(ser, P6, T_h, folds)
        if do_boot and T_h in EVAL_T:
            imask = ser.issue_mask()
            for f in folds:
                te = M3.test_times(f, ser, imask)
                te = te[((ser.base_ts + 3600 * te) % DAY) == 0]
                if len(te):
                    boots[(T_h, f["name"])] = (te, fh_boot(P6, f["qs_i"], te, rngb))
        del P6
    R, _, _ = M6.assemble6(ser, folds, per_T)
    del per_T
    ts0 = ser.base_ts + 3600 * R["t0_i"]
    keep = np.isin(R["T_h"], EVAL_T) & ((ts0 % DAY) == 0)
    rows = {k: R[k][keep] for k in ("t0_i", "fold_i", "T_h", "k_i", "y", "regime", "day")}
    for r in CMP_RUNGS:
        rows[f"p_{r}"] = R[f"p_{r}"][keep]
    levels = np.array(R["levels"], float)
    lnk = np.log1p(levels)
    K = len(levels)
    # simulation per fold
    steps_all = tuple(steps_main) + tuple(steps_sub)
    si = SeriesInputs(ser.close, ser.high, ser.low, ser.start_i, steps=steps_all)
    origins = np.unique(rows["t0_i"])
    pos_T = {T: i for i, T in enumerate(EVAL_T)}
    sims = {}
    for f in folds:
        oo = origins[(origins >= f["qs_i"]) & (origins < f["qe_i"])]
        if not len(oo):
            continue
        for s in steps_all:
            day_of = (ser.base_ts + 3600 * oo) // DAY
            if s not in steps_main:
                oo_s = oo[(day_of % sub_every_days) == 0]
            else:
                oo_s = oo[(day_of % MAIN_EVERY) == 0]
            if not len(oo_s):
                continue
            mdl = StepModel(si, s, f["qs_i"])
            for i0 in oo_s:
                # main step: rec every MAIN_EVERY days, all modes every MODES_EVERY days (compute budget, shared
                # machine); other steps: rec only, every sub_every_days days
                if s in steps_main:
                    modes = modes_main if ((ser.base_ts + 3600 * int(i0)) // DAY) % MODES_EVERY == 0 else ("rec",)
                else:
                    modes = ("rec",)
                res = simulate_fast(mdl, si, int(i0), lnk, n_paths, [SEED, sid, int(i0), s], modes=modes)
                if res is None:
                    continue
                for m, arr in res.items():
                    sims[(f"{m}{s}", int(i0))] = arr
    names = sorted({k[0] for k in sims})
    ti = np.array([pos_T[int(T)] for T in rows["T_h"]])
    for nm in names:
        col = np.full(len(rows["y"]), np.nan)
        # vectorized fill
        d = {i0: arr for (m, i0), arr in sims.items() if m == nm}
        if d:
            o_keys = np.array(sorted(d))
            stack = np.stack([d[k] for k in o_keys])          # (n_o, nT, K)
            stack = A.monotone_fix(stack)
            pos = np.searchsorted(o_keys, rows["t0_i"])
            pos = np.minimum(pos, len(o_keys) - 1)
            hit = o_keys[pos] == rows["t0_i"]
            col[hit] = stack[pos[hit], ti[hit], rows["k_i"][hit]]
        rows[f"p_{nm}"] = col
    # bootstrap quantiles
    if do_boot:
        qs = (0.05, 0.25, 0.5, 0.75, 0.95)
        bq = np.full((len(rows["y"]), len(qs)), np.nan)
        bsd = np.full(len(rows["y"]), np.nan)
        for (T_h, fn), (te, arr) in boots.items():
            if arr is None:
                continue
            arr = np.minimum.accumulate(arr, axis=-1)          # monotone in level
            qv = np.nanquantile(arr, qs, axis=0)              # (5, len(te), K)
            sd = np.nanstd(arr, axis=0)
            m = (rows["T_h"] == T_h)
            mi = np.where(m)[0]
            p_ = np.searchsorted(te, rows["t0_i"][mi])
            p_ = np.minimum(p_, len(te) - 1)
            hit = te[p_] == rows["t0_i"][mi]
            mi, p_ = mi[hit], p_[hit]
            kk = rows["k_i"][mi]
            bq[mi] = qv[:, p_, kk].T
            bsd[mi] = sd[p_, kk]
        rows["boot_q"] = bq
        rows["boot_sd"] = bsd
    rows["levels"] = levels
    rows["base_ts"] = np.array(ser.base_ts)
    return rows


def series_job(key):
    ser = _S[key]
    folds = _S["__folds__"][key]
    outd = _S["__out__"]
    cfg = _S["__cfg__"]
    path = os.path.join(outd, key.replace(":", "-") + ".npz")
    if os.path.exists(path):
        return key, "cached"
    if not folds:
        return key, "no folds"
    t0 = time.time()
    rows = run_series(ser, folds, cfg["n_paths"], sub_every_days=cfg["sub_every"])
    save = {}
    for k, v in rows.items():
        if k.startswith("p_") or k in ("boot_q", "boot_sd"):
            save[k] = np.asarray(v, np.float32)
        else:
            save[k] = v
    save["name"] = np.array(key)
    save["asset"] = np.array(ser.asset)
    np.savez_compressed(path + ".tmp.npz", **save)
    os.replace(path + ".tmp.npz", path)
    M6._clear(ser)
    return key, f"{len(rows['y'])} rows {time.time() - t0:.0f}s"


def build_series(datasets):
    S1, f1, _ = M6.build_all(datasets, verify=True)
    keys1 = M6.other_keys(S1)
    S = {k: S1[k] for k in keys1}
    folds = {k: f1[k] for k in keys1}
    S5, f5, _ = M6.build_blind_dir(datasets, M6.BLIND5_DIR, BLIND5_COMMIT, "blind5:", verify=True)
    S.update(S5)
    folds.update(f5)
    return S, folds


def run_dev(datasets, out, workers, n_paths, sub_every, only=None):
    global _S
    t0 = time.time()
    S, folds = build_series(datasets)
    if only:
        S = {k: S[k] for k in S if any(o in k for o in only)}
    rd = os.path.join(out, "rows")
    os.makedirs(rd, exist_ok=True)
    _S = dict(S)
    _S.update({"__folds__": folds, "__out__": rd, "__cfg__": {"n_paths": n_paths, "sub_every": sub_every}})
    keys = sorted(S, key=lambda k: -(S[k].N - S[k].start_i))
    print(f"series built {time.time() - t0:.0f}s: {len(keys)}", flush=True)
    if workers <= 1:
        for i, k in enumerate(keys):
            print(f"  {i + 1}/{len(keys)}", *series_job(k), f"{time.time() - t0:.0f}s", flush=True)
        return
    ctx = mp.get_context("fork")
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for i, (k, msg) in enumerate(pool.imap_unordered(series_job, keys)):
            print(f"  {i + 1}/{len(keys)} {k}: {msg} {time.time() - t0:.0f}s", flush=True)


# ---------------------------------------------------------------------------------------------
# Instrument check 2: no look-ahead
# ---------------------------------------------------------------------------------------------
def run_lookahead(datasets, out, n_series=4, n_orig=6):
    S, folds = build_series(datasets)
    keys = sorted(S)[::max(1, len(S) // n_series)][:n_series]
    rep = []
    for k in keys:
        ser = S[k]
        f = folds[k][len(folds[k]) // 2]
        rng = np.random.default_rng(1)
        imask = ser.issue_mask()
        te = M3.test_times(f, ser, imask)
        te = te[((ser.base_ts + 3600 * te) % DAY) == 0]
        pick = np.sort(rng.choice(te, size=min(n_orig, len(te)), replace=False))
        lnk = np.log1p(np.array(ser.levels, float))
        full = SeriesInputs(ser.close, ser.high, ser.low, ser.start_i, steps=(12, 3))
        for i0 in pick:
            i0 = int(i0)
            c, h, l_ = ser.close.copy(), ser.high.copy(), ser.low.copy()
            c[i0:] = np.nan
            h[i0:] = np.nan
            l_[i0:] = np.nan
            tr = SeriesInputs(c, h, l_, ser.start_i, steps=(12, 3))
            for s in (12, 3):
                a = simulate_fast(StepModel(full, s, f["qs_i"]), full, i0, lnk, 400, [9, i0, s])
                b = simulate_fast(StepModel(tr, s, f["qs_i"]), tr, i0, lnk, 400, [9, i0, s])
                c_ = simulate(StepModel(full, s, f["qs_i"]), full, i0, lnk, 400, [9, i0, s])
                same = (a is None and b is None) or all(np.array_equal(a[m], b[m]) for m in a)
                fast_eq = (a is None and c_ is None) or all(np.array_equal(a[m], c_[m]) for m in a)
                rep.append({"series": k, "fold": f["name"], "i0": i0, "s": s, "identical": bool(same),
                            "compiled_equals_python": bool(fast_eq), "valid_origin": a is not None})
            # and the bootstrap refit of (fH) at T 168: truncation after qs_i - T must not change it
        print(k, "done", flush=True)
    res = {"checks": rep, "all_identical": all(r["identical"] for r in rep), "n": len(rep),
           "all_compiled_equal": all(r["compiled_equals_python"] for r in rep),
           "n_valid": sum(r["valid_origin"] for r in rep),
           "note": "each prediction recomputed with every bar at or after the origin set to NaN (close, high, low)"}
    M6.write_json(os.path.join(out, "lookahead.json"), res)
    print(json.dumps({k: res[k] for k in ("all_identical", "all_compiled_equal", "n", "n_valid")}))


# ---------------------------------------------------------------------------------------------
# Instrument check 1: known answer on synthetic GJR-GARCH-t data
# ---------------------------------------------------------------------------------------------
SYN = {"omega_ann": 0.70, "alpha": 0.06, "gamma": 0.04, "beta": 0.91, "nu": 5.0}


def bb_min(r, sig, u):
    """Minimum of a Brownian bridge from 0 to r over unit time with variance sig^2 (exact)."""
    return 0.5 * (r - np.sqrt(r * r - 2.0 * sig * sig * np.log(u)))


def garch_step(h, eps, p):
    return p["w"] + (p["alpha"] + p["gamma"] * (eps < 0)) * eps * eps + p["beta"] * h


def syn_params():
    p = dict(SYN)
    h_bar = (p["omega_ann"] ** 2) / ANNUAL
    pers = p["alpha"] + 0.5 * p["gamma"] + p["beta"]
    p["w"] = h_bar * (1 - pers)
    p["h_bar"] = h_bar
    p["tsc"] = math.sqrt((p["nu"] - 2) / p["nu"])
    return p


def syn_series(n, rng, p):
    h = np.empty(n + 1)
    h[0] = p["h_bar"]
    close, high, low = np.empty(n), np.empty(n), np.empty(n)
    lp = 0.0
    for t in range(n):
        sig = math.sqrt(h[t])
        z = rng.standard_t(p["nu"]) * p["tsc"]
        eps = sig * z
        u1, u2 = rng.random(2)
        mn = bb_min(eps, sig, u1)
        mx = eps - bb_min(eps, sig, u2)
        low[t] = lp + mn
        high[t] = lp + mx
        lp += eps
        close[t] = lp
        h[t + 1] = garch_step(h[t], eps, p)
    return np.exp(close), np.exp(high), np.exp(low), h


def syn_true(h0, lnk, n_paths, rng, p, Ts=EVAL_T):
    """True touch odds given the conditional variance h0 of the first bar (exact model)."""
    h = np.full(n_paths, h0)
    L = np.zeros(n_paths)
    rm = np.full(n_paths, np.inf)
    out = np.zeros((len(Ts), len(lnk)))
    for t in range(HMAX):
        sig = np.sqrt(h)
        eps = sig * rng.standard_t(p["nu"], n_paths) * p["tsc"]
        mn = bb_min(eps, sig, rng.random(n_paths))
        rm = np.minimum(rm, L + mn)
        L = L + eps
        h = garch_step(h, eps, p)
        for ti, T in enumerate(Ts):
            if T == t + 1:
                out[ti] = (rm[:, None] <= lnk[None, :]).mean(0)
    return out


def _known_series(args):
    si_, n, n_true, n_paths, n_orig = args
    p = syn_params()
    rng = np.random.default_rng([SEED, 11, si_])
    close, high, low, hh = syn_series(n, rng, p)
    base_ts = A.quarter_start(2018, 1)
    name = f"syn:{si_}"
    ser = M3.S3(name, name, "syn", close, low, A.LEVELS["ETH"], base_ts, base_ts)
    M6.attach_high(ser, high)
    last = A.iso(base_ts + 3600 * (n - HMAX - 24))
    y, mo = int(last[:4]), int(last[5:7])
    lastq = (y, (mo - 1) // 3 + 1)
    folds = M3.quarters(M3.first_quarter_after(base_ts, 365), lastq, ser)
    folds = [f for f in folds if f["qe_i"] + HMAX < n]
    M6.Prep6.beta_maps = _identity_maps
    per_T = {T: M6.fold_loop(ser, M6.Prep6(ser, T, q_max=max(f["qs_i"] for f in folds)), T, folds)
             for T in M6.HORIZONS_H}
    R, _, _ = M6.assemble6(ser, folds, per_T)
    ts0 = ser.base_ts + 3600 * R["t0_i"]
    keep = np.isin(R["T_h"], EVAL_T) & ((ts0 % DAY) == 0)
    lnk = np.log1p(np.array(ser.levels, float))
    si = SeriesInputs(close, high, low, ser.start_i, steps=(12, 3))
    origins = np.unique(R["t0_i"][keep])
    rng2 = np.random.default_rng([SEED, 12, si_])
    pick = np.sort(rng2.choice(origins, size=min(n_orig, len(origins)), replace=False))
    rows = []
    fold_of = {}
    for f in folds:
        for o in pick[(pick >= f["qs_i"]) & (pick < f["qe_i"])]:
            fold_of[int(o)] = f
    models = {}
    for i0 in pick:
        i0 = int(i0)
        f = fold_of[i0]
        tru = syn_true(hh[i0], lnk, n_true, np.random.default_rng([SEED, 13, si_, i0]), p)
        sims = {}
        for s in (12, 3):
            key = (f["name"], s)
            if key not in models:
                models[key] = StepModel(si, s, f["qs_i"])
            r = simulate_fast(models[key], si, i0, lnk, n_paths, [SEED, 14, si_, i0, s],
                         modes=("rec", "fix", "recc") if s == 12 else ("rec",))
            if r is not None:
                sims.update({f"{m}{s}": v for m, v in r.items()})
        m = keep & (R["t0_i"] == i0)
        for idx in np.where(m)[0]:
            ti = EVAL_T.index(int(R["T_h"][idx]))
            k = int(R["k_i"][idx])
            row = {"series": si_, "i0": i0, "T": int(R["T_h"][idx]), "k": k, "y": float(R["y"][idx]),
                   "p_true": float(tru[ti, k])}
            for r_ in CMP_RUNGS:
                row[f"p_{r_}"] = float(R[f"p_{r_}"][idx])
            for nm, v in sims.items():
                row[f"p_{nm}"] = float(v[ti, k])
            rows.append(row)
    return rows


def run_known(out, n_series=12, n_hours=52000, n_true=20000, n_paths=2000, n_orig=60, workers=4):
    args = [(i, n_hours, n_true, n_paths, n_orig) for i in range(n_series)]
    rows = []
    ctx = mp.get_context("fork")
    with ctx.Pool(workers) as pool:
        for r in pool.imap_unordered(_known_series, args):
            rows += r
            print("series done", len(rows), flush=True)
    import pandas as pd
    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(out, "known-rows.csv.gz"), index=False)
    models = [c[2:] for c in df.columns if c.startswith("p_") and c != "p_true"]
    res = {"params": SYN, "n_series": n_series, "n_hours": n_hours, "n_true_paths": n_true, "n_paths": n_paths,
           "cells": []}
    for T in EVAL_T:
        for grp, ks in (("shallow -2..-7%", (0, 1, 2, 3)), ("mid -10..-20%", (4, 5, 6)),
                        ("deep -25..-40%", (7, 8, 9))):
            d = df[(df["T"] == T) & df["k"].isin(ks)]
            if not len(d):
                continue
            pt = d["p_true"].to_numpy()
            cell = {"T": T, "levels": grp, "n": len(d), "mean_true": float(pt.mean()), "models": {}}
            for m in models:
                pm = d[f"p_{m}"].to_numpy()
                ok = np.isfinite(pm)
                e = pm[ok] - pt[ok]
                cell["models"][m] = {
                    "R_vs_true": float(pm[ok].sum() / pt[ok].sum()) if pt[ok].sum() > 0 else None,
                    "mae": float(np.abs(e).mean()), "rmse": float(np.sqrt((e ** 2).mean())),
                    "mean_sq_err_vs_truth": float((e ** 2).mean()),
                    "corr_logit": float(np.corrcoef(np.log(np.clip(pm[ok], 1e-4, 1)), np.log(np.clip(pt[ok], 1e-4, 1)))[0, 1]),
                    "brier_y": float(((pm[ok] - d["y"].to_numpy()[ok]) ** 2).mean())}
            cell["brier_y_true"] = float(((pt - d["y"].to_numpy()) ** 2).mean())
            res["cells"].append(cell)
    M6.write_json(os.path.join(out, "known.json"), res)
    for c in res["cells"]:
        print(c["T"], c["levels"], "true", round(c["mean_true"], 4),
              {m: (round(v["R_vs_true"] or 0, 3), round(v["mae"], 4)) for m, v in c["models"].items()})


def _oracle_series(args):
    """Engine check with the true scale: same synthetic series and origins as `known`; the step model is replaced by
    the exact GARCH variance (1 h steps, standardized hourly bars u = bar / sqrt(h), h updated by the GARCH recursion
    from the simulated return). Isolates the bootstrap/recursion/running-min engine from the HAR step model."""
    si_, n, n_paths, origins_folds = args
    p = syn_params()
    rng = np.random.default_rng([SEED, 11, si_])
    close, high, low, hh = syn_series(n, rng, p)
    lc, lh, ll = np.log(close), np.log(high), np.log(low)
    spot = np.concatenate([[0.0], lc[:-1]])
    sd = np.sqrt(hh[:n])
    Uc, Ul = (lc - spot) / sd, (ll - spot) / sd
    lnk = np.log1p(np.array(A.LEVELS["ETH"], float))
    out = []
    for i0, qs in origins_folds:
        pool = np.arange(1, qs)                     # bars fully observed before the fold start
        r2 = np.random.default_rng([SEED, 15, si_, i0])
        h = np.full(n_paths, hh[i0])
        L = np.zeros(n_paths)
        rm = np.full(n_paths, np.inf)
        res = np.zeros((len(EVAL_T), len(lnk)))
        for t in range(HMAX):
            j = pool[r2.integers(0, len(pool), n_paths)]
            sg = np.sqrt(h)
            rm = np.minimum(rm, L + sg * Ul[j])
            eps = sg * Uc[j]
            L = L + eps
            h = garch_step(h, eps, p)
            for ti, T in enumerate(EVAL_T):
                if T == t + 1:
                    res[ti] = (rm[:, None] <= lnk[None, :]).mean(0)
        out.append((si_, i0, res))
    return out


def run_known_oracle(out, n_hours=52000, n_paths=4000, workers=2):
    import pandas as pd
    df = pd.read_csv(os.path.join(out, "known-rows.csv.gz"))
    base_ts = A.quarter_start(2018, 1)
    args = []
    for si_, d in df.groupby("series"):
        ors = sorted(d["i0"].unique())
        of = []
        for i0 in ors:
            ts = base_ts + 3600 * int(i0)
            y, mo = int(A.iso(ts)[:4]), int(A.iso(ts)[5:7])
            qs = (A.quarter_start(y, (mo - 1) // 3 + 1) - base_ts) // 3600
            of.append((int(i0), int(qs)))
        args.append((int(si_), n_hours, n_paths, of))
    po = {}
    ctx = mp.get_context("fork")
    with ctx.Pool(workers) as pool:
        for r in pool.imap_unordered(_oracle_series, args):
            for si_, i0, res in r:
                po[(si_, i0)] = res
            print("oracle series done", flush=True)
    df["p_oracle1"] = [po[(int(a), int(b))][EVAL_T.index(int(T)), int(k)]
                       for a, b, T, k in zip(df["series"], df["i0"], df["T"], df["k"])]
    df.to_csv(os.path.join(out, "known-rows-oracle.csv.gz"), index=False)
    res = []
    for T in EVAL_T:
        for grp, ks in (("shallow", (0, 1, 2, 3)), ("mid", (4, 5, 6)), ("deep", (7, 8, 9))):
            d = df[(df["T"] == T) & df["k"].isin(ks)]
            row = {"T": T, "levels": grp, "mean_true": float(d["p_true"].mean())}
            for m in ("oracle1", "fH", "rec12", "fix12", "recc12", "rec3", "f", "a"):
                pm, pt = d[f"p_{m}"].to_numpy(), d["p_true"].to_numpy()
                row[m] = {"R": float(pm.sum() / pt.sum()), "mae": float(np.abs(pm - pt).mean())}
            res.append(row)
            print(T, grp, {m: (round(v["R"], 3), round(v["mae"], 4)) for m, v in row.items() if isinstance(v, dict)})
    M6.write_json(os.path.join(out, "known-oracle.json"), {"n_paths": n_paths, "cells": res,
                  "note": "engine with the exact GARCH scale (1 h steps); truth from 20,000 exact-model paths"})


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=("known", "known-oracle", "lookahead", "dev"))
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--paths", type=int, default=1000)
    ap.add_argument("--sub-every", type=int, default=14)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--n-series", type=int, default=12)
    ap.add_argument("--n-orig", type=int, default=60)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "known":
        run_known(a.out, n_series=a.n_series, n_orig=a.n_orig, workers=a.workers, n_paths=a.paths)
    elif a.phase == "known-oracle":
        run_known_oracle(a.out, workers=a.workers)
    elif a.phase == "lookahead":
        run_lookahead(a.datasets, a.out)
    elif a.phase == "dev":
        run_dev(a.datasets, a.out, a.workers, a.paths, a.sub_every, a.only)


if __name__ == "__main__":
    main()
