#!/usr/bin/env python3
"""Q26 R11.5 depositor-driven pool cash, Aave V3 Core USDC, minimum raw cash over (t0, t0 + 24 h].

membrane-board design/Q26_ROUND11_PREREG.md R11.5 (registered at board 348d813) with the run readings of Deviation
D-R11.5a (posted on the board before this run). Process: Q26_ROUND9_PREREG D8 rules and R11 binding rules 1-10.

Model D (aggregated per-deposit exits):
  * per-deposit 24 h (and 7 d, reported only) exit ladders P(drop >= x), x in {10, 25, 50, 75, 90}%, from B4 v4a as
    shipped (B4 display: the shipped rung per (cell, segment), else the v2 segment population rate), refit with the
    frozen recipe on every B3 fold plus one extra fold 2026Q4 (2026-10-01..10-07, the last anchor day); the refit must
    reproduce every published B6 'b4' value (gate G2). B6 v4ac (corrected inputs, y_cash) the same way on the B6c
    rows (gate G3), reported only.
  * fraction withdrawn per deposit: 0 with probability 1 - p10, piecewise uniform between rungs, uniform on
    [0.90, 1.00] with probability p90. Exits are joined by a one-factor Gaussian copula with correlation rho,
    estimated at each origin by the method of moments on training days (Var(N - P) = mean V(rho), V the copula
    variance of the daily >= 10% exit count, Gauss-Hermite).
  * big-holder outflow O = sum balance x fraction, 10,000 draws, default_rng(20261119).
  * residual = (realised window minimum raw cash - cashX(t_i) + realised big-holder >= 10% outflow) / supplyX(t_i)
    on training days in the trailing 730 days; draws pair O with a uniformly drawn residual day.
  * min cash = min(cashX(t0) - O + residual x supplyX(t0), raw cash(t0)); quantiles q05, q25, q50.
Model C: quantile average of D and the published R10.4 step 1 forecast.
Scoring at 24 h vs R10.4 step 1 and the empirical baseline (trailing-730-day quantiles of min-cash / cash(t0) x
cash(t0)): one-sided DM, Newey-West lag 7, HLN, p < 0.0125; q05 hit rate in [2.5%, 10%]. Lock odds reported only.

Phases:
  --inputs-only   load and gate inputs, print counts, stop (no fit, no forecast, no score)
  --freeze-only   write frozen-r115.json (code, inputs sha256, readings, constants, frozen_utc), hash it, stop
  (default)       ONE run from the frozen config (refuses if code, inputs or readings differ, or if a run already
                  started): per-deposit refits with gates G2/G3; R10.4 path reproduction (gate G4); D, C; scores.
No address is held in any output (units are integer indices in memory only; every output is checked).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import secrets  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy.special import ndtr, ndtri  # noqa: E402
from scipy.stats import t as student_t  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r104_cash as R4  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND11_PREREG.md", "item": "R11.5",
          "registered": "348d813", "readings": "D-R11.5a"}
SCHEMA = "q26-r11/r115/1"
MICRO = 10 ** 6
DAY = 86400
QS = (0.05, 0.25, 0.50)
XS = (0.10, 0.25, 0.50, 0.75, 0.90)
HMODEL = {"24h": 1, "7d": 7}                 # 24 h scored; 7 d reported only
HCELL = {"24h": 2, "7d": 4}                  # index in bg_gradient HNAMES (1h, 6h, 24h, 48h, 7d)
TRAIL_DAYS = 730
N_DRAWS = 10_000
SEED = 20261119
RHO_GRID = np.round(np.arange(0.0, 0.99, 0.01), 2)      # 0.00 .. 0.98
GH_NODES = 32
RHO_MIN_DAYS = 30
NW_LAG = 7
HLN_H = 8                                    # HLN horizon so that the Newey-West lag = h - 1 = 7
ALPHA = 0.025 / 2                            # Bonferroni over D and C
HIT_LO, HIT_HI = 0.025, 0.10
LOCK_SHARE = 0.005                           # L1c / R9.1(c) lock threshold: raw cash / supply < 0.5%
LOW_SHARE = 0.01
EXTRA_FOLD = ("2026Q4", "2026-10-01")       # refit fold for origins after the last B3 fold (to the last anchor day)
SCORE_DATA_END = "2026-10-07"                # last depositor anchor day (depositor-balances/blocks.csv)
TAU_GRID = np.arange(0.0005, 1.0, 0.001)     # quantile grid for C lock odds
B6_RUN = "history-forecasts/b6/run-80e83a01/"
B6C_RUN = "history-forecasts/r9/b6c-run-da52297d/"
R104_RUN = "history-forecasts/r10/r104-run-7b6ca7aa/"
R104_FILES = {"forecasts-r104.csv.gz": "", "frozen-r104.json": "c2f2ca9c75225e468bb9866d216e5d6f0c22e534c84cc81749974a5ca08d998b"}
B6C_PRED_SHA = {"24h": "22d32a9add82eabf3292703b552e41b21395baddad024aaf54fb12eb799c2a5e",
                "7d": "b2bf6c9b2daaa8a667c6b0e77cbe59a158083212d5ba289b9ded427189c1b4e0"}
LABELS_R9 = "history-forecasts/r9/run-dfdd3ad8/labels-r9-usdc.csv"
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

DECISIONS = [
    "R115-1 Truth, origins, endpoints and round trips are R10.4's (D-R10.4a, code r104_cash.py at 7b6ca7aa imported "
    "unchanged): raw per-transaction cash minimum over (t0, t0 + h]; cashX/supplyX = endpoints with QRTs and debt-side "
    "round trips added back (every round trip in history, the t0 + 60 min live rule at t0). Gate G1 (R10.4) and gate "
    "G1b: the rebuilt 24 h truth equals the published R10.4 y_min_cash_usd at every published origin.",
    "R115-2 Scoring origins: R10.4's 24 h scoring origins whose t0 is a depositor anchor day (<= 2026-10-07): 920 of "
    "925. 2026-10-08..10-12 have no per-deposit balances (depositor-balances ends 2026-10-07) and are reported as "
    "not forecast. 2026Q2 origins are reported only. 7 d (913 origins, all <= 2026-10-06) is reported only.",
    "R115-3 Deposit set at t0: every B6c row (USDC extended universe, feature-view balance >= $1M at the 00:00Z "
    "snapshot, QRT-neutralised per B6c-3) on the origin day; balance = that feature-view balance.",
    "R115-4 Ladders: B4 v4a as shipped = B6's 'b4' column recipe (b6_cash.py 80e83a01: B4 fits on USDC + USDT rows, "
    "2-D monotone fix without mask, shipped rung per (cell, segment) from shipped-b4.json, else the fold's v2 segment "
    "population rate), refit with the frozen recipe on the 12 B3 folds and one extra fold 2026Q4 (training rows with "
    "t + h <= 2026-10-01, test rows 2026-10-01..10-07). Gate G2: the refit equals every published B6 b4 value at 24 h "
    "and 7 d (6 significant digits). B6 v4ac = B6c's recipe on the corrected rows, the same folds; gate G3 vs the "
    "published B6c v4ac. A deposit without a ladder (features undefined, or a B6c row with no B4 row) draws no "
    "outflow; counted.",
    "R115-5 Fraction withdrawn: the ladder is first made non-increasing in x by a running minimum (the shipped "
    "segment-population fallback is per cell, so a ladder can rise with x; counted). P(f = 0) = 1 - p10; for x_k <= f < x_{k+1} uniform with mass p_k - p_{k+1} (x_6 = 1, "
    "p_6 = 0); so f >= 0.90 is uniform on [0.90, 1.00]. Inverse-CDF map from the copula uniform; the exit side is the "
    "upper tail of the latent variable.",
    "R115-6 Copula: U_i = sqrt(rho) Z + sqrt(1 - rho) e_i; s_i = 1 - Phi(U_i); f_i = F_i^-1(s_i) on the survival "
    "scale. rho by the method of moments on training days d in [t0 - 730 d, t0 - h] with ladders: Var_d(N_d - P_d) "
    "(ddof 1) = mean_d V_d(rho), N_d = realised count of >= 10% exits (resolved rows with a ladder), P_d = sum p10, "
    "V_d(rho) = E_Z[sum q(1 - q)] + Var_Z[sum q], q_i(z) = Phi((Phi^-1(p_i) + sqrt(rho) z) / sqrt(1 - rho)), "
    "32-node Gauss-Hermite, rho on a 0.00..0.98 grid with linear interpolation; rho = 0 if the empirical variance is "
    "at or below V(0), 0.98 if above V(0.98). At least 30 training days required. Realised exits: B4 variant = "
    "neutralised y_old x10 (B6c label view); v4ac variant = corrected y_cash x10.",
    "R115-7 Big-holder outflow O = sum_i balance_i x f_i over 10,000 draws. Realised big-holder outflow on day i = "
    "sum over that day's deposit set of balance x realised drawdown fraction (balance - window minimum of the "
    "neutralised balance path) / balance, counted only when that fraction is >= 10% (the y_old x10 event), so the "
    "ladder's domain and the realised outflow match; sub-10% drawdowns stay in the residual. The same realised O is "
    "used for the v4ac variant (reported only).",
    "R115-8 Residual on training day i (t_i + h <= t0, i >= t0 - 730 d): r_i = (rawmin_h(i) - cashX_i + Oreal_h(i)) / "
    "supplyX_i, history endpoints with every round trip applied. Each draw takes one residual day uniformly from "
    "the origin's residual days.",
    "R115-9 min cash per draw = min(cashX_live(t0) - O + r x supplyX_live(t0), raw cash(t0)); quantiles numpy "
    "'linear'. Draw order: one default_rng(20261119) for the whole run; horizons 24h then 7d, origins ascending; per "
    "origin Z (10,000), the residual-day indices (10,000), then e (10,000 x deposits). The v4ac variant reuses the "
    "same draws (common random numbers).",
    "R115-10 Model C = (D + R10.4 step 1) / 2 per quantile, R10.4 from the published forecasts-r104.csv.gz. For C lock "
    "odds the R10.4 path minima are recomputed with r104_cash.forecast_origin's construction (gate G4: its q05, q25, "
    "q50 equal the published values within $1) and C's quantile function = mean of the two quantile functions on a "
    "0.001 grid.",
    "R115-11 Empirical baseline (D-R10.4c): ratio_i = rawmin_h(i) / raw cash(t_i) over days i in [t0 - 730 d, t0 - h]; "
    "quantiles (linear) x raw cash(t0). No-change: min raw cash over (t0 - h, t0] (R10.4).",
    "R115-12 Pass per model (D, C) at 24 h: mean pinball over q05, q25, q50 below R10.4 AND below the empirical "
    "baseline, each by a one-sided DM test on per-origin loss differences (model - comparator), Newey-West Bartlett "
    "lag 7, HLN factor with h = 8, Student t with T - 1 df, p < 0.0125; and q05 hit rate (y < q05) in [2.5%, 10%].",
    "R115-13 Lock odds (reported, never scored): P(min cash <= 0.5% x raw supply(t0)) (the R9.1(c) / L1c lock "
    "threshold) and P(min cash <= 1% x raw supply(t0)), per origin, D and C, B4 and v4ac variants; April 2026 "
    "stress line beside the realised raw minimum share and the published LOCK6 24 h labels.",
    "R115-14 Reported only: per-quantile losses and hits, by year, rho path, v4ac variant, 2026Q2, top-10-holder "
    "share of E[O], 7 d, skill vs no-change, deposits without a ladder.",
]


# ---------------------------------------------------------------------------------------------
# pure pieces (tested on synthetic arrays)
# ---------------------------------------------------------------------------------------------
def frac_from_survival(s, P):
    """s: (M, m) survival-scale uniforms; P: (m, 5) monotone ladders p10 >= ... >= p90. -> (M, m) fractions."""
    xs = np.array(XS + (1.0,))
    Pp = np.concatenate([P, np.zeros((P.shape[0], 1))], axis=1)       # p_6 = 0
    f = np.zeros_like(s)
    for k in range(5):
        hi, lo = Pp[:, k], Pp[:, k + 1]
        w = hi - lo
        m = (s <= hi[None, :]) & (s > lo[None, :])
        with np.errstate(divide="ignore", invalid="ignore"):
            frac = np.where(w[None, :] > 0, (hi[None, :] - s) / w[None, :], 0.0)
        val = xs[k] + (xs[k + 1] - xs[k]) * frac
        f = np.where(m, val, f)
    return f


def outflow_draws(U, P, bal, topmask):
    """Same map as frac_from_survival, computed only where an exit happens (s <= p10, i.e. U >= -Phi^-1(p10)).
    U (M, m) latent draws; P (m, 5) ladders; bal (m,). -> (O (M,), O from the topmask deposits (M,))."""
    M_, m = U.shape
    xs = np.array(XS + (1.0,))
    Pp = np.concatenate([P, np.zeros((m, 1))], axis=1)
    with np.errstate(divide="ignore"):
        thr = -ndtri(np.clip(Pp[:, 0], 0.0, 1.0))                     # +inf where p10 = 0
    r, c = np.nonzero(U >= thr[None, :])
    sv = ndtr(-U[r, c])
    Pc = Pp[c]
    keep = sv <= Pc[:, 0]                                              # guards rounding at the threshold
    r, c, sv, Pc = r[keep], c[keep], sv[keep], Pc[keep]
    k = (Pc[:, 1:] >= sv[:, None]).sum(axis=1)
    hi = Pc[np.arange(len(k)), k]
    lo = Pc[np.arange(len(k)), k + 1]
    f = xs[k] + (xs[k + 1] - xs[k]) * (hi - sv) / (hi - lo)
    w = f * bal[c]
    O = np.bincount(r, weights=w, minlength=M_)
    Ot = np.bincount(r, weights=w * topmask[c], minlength=M_)
    return O, Ot


def gh_nodes(k=GH_NODES):
    x, w = np.polynomial.hermite_e.hermegauss(k)
    return x, w / w.sum()


def copula_var_grid(p, rho_grid=RHO_GRID, nodes=None):
    """V(rho) on the grid for one day's exit probabilities p (m,)."""
    z, w = nodes if nodes is not None else gh_nodes()
    p = np.clip(np.asarray(p, float), 1e-9, 1 - 1e-9)
    a = ndtri(p)
    out = np.empty(len(rho_grid))
    for j, r in enumerate(rho_grid):
        if r == 0:
            out[j] = float(np.sum(p * (1 - p)))
            continue
        q = ndtr((a[:, None] + np.sqrt(r) * z[None, :]) / np.sqrt(1 - r))     # (m, K)
        s = q.sum(axis=0)
        ev = (w * (q * (1 - q)).sum(axis=0)).sum()
        mu = (w * s).sum()
        out[j] = float(ev + (w * (s - mu) ** 2).sum())
    return out


def solve_rho(target, vmean, rho_grid=RHO_GRID):
    """rho such that the mean copula variance equals target (linear interpolation on a monotone grid)."""
    if not np.isfinite(target) or target <= vmean[0]:
        return 0.0
    if target >= vmean[-1]:
        return float(rho_grid[-1])
    v = np.maximum.accumulate(vmean)
    return float(np.interp(target, v, rho_grid))


def dm_hln(d, lag=NW_LAG, h=HLN_H):
    """one-sided DM test of mean(d) < 0 with Newey-West (Bartlett, lag) variance and the HLN factor. -> (stat, p)."""
    d = np.asarray(d, float)
    T = len(d)
    mu = d.mean()
    e = d - mu
    lrv = float(e @ e) / T
    for k in range(1, lag + 1):
        lrv += 2 * (1 - k / (lag + 1)) * float(e[k:] @ e[:-k]) / T
    if lrv <= 0:
        return float("nan"), float("nan")
    dm = mu / np.sqrt(lrv / T)
    adj = np.sqrt((T + 1 - 2 * h + h * (h - 1) / T) / T)
    stat = dm * adj
    return float(stat), float(student_t.cdf(stat, df=T - 1))


def pinball3(y, Q):
    """mean over the three quantiles of the pinball loss; Q (n, 3)."""
    return np.mean([R4.pinball(y, Q[:, j], QS[j]) for j in range(3)], axis=0)


def emp_baseline(ratio, cash_t0, n, H, trail=TRAIL_DAYS):
    lo = max(0, n - trail)
    r = ratio[lo:n - H + 1]
    r = r[np.isfinite(r)]
    if len(r) < 30:
        return None
    return np.quantile(r, QS, method="linear") * cash_t0[n]


def r104_paths(n, H, xS, xD, dip, S0, D0, cash0, trail=TRAIL_DAYS):
    """r104_cash.forecast_origin's step-1 construction, returning the path minima (for C lock odds)."""
    lo = max(0, n - trail)
    hi = n - 1
    cS, sigS, _ = R4.har_fit(xS[:n], lo, hi)
    cD, sigD, _ = R4.har_fit(xD[:n], lo, hi)
    if cS is None or cD is None:
        return None
    zS = xS[:n] / sigS[:n]
    zD = xD[:n] / sigD[:n]
    ok = np.isfinite(zS) & np.isfinite(zD) & np.isfinite(dip[:n])
    starts = [s for s in range(lo, n - H + 1) if ok[s:s + H].all()]
    if len(starts) < 30:
        return None
    st = np.array(starts)
    blk = st[:, None] + np.arange(H)[None, :]
    return R4.path_minima(S0, D0, zS[blk], zD[blk], dip[blk], sigS[n], sigD[n], cash0, H)


def prob_le_from_quantile_fn(qfn, thr, tau=TAU_GRID):
    """P(X <= thr) for a quantile function sampled on tau."""
    return float(np.mean(qfn <= thr))


# ---------------------------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------------------------
def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    me = os.path.basename(__file__)
    deps = ("r104_cash.py", "b6c_cash.py", "b6_cash.py", "b5_econ.py", "b4_depositor.py", "bg_gradient.py",
            "b3_segments.py", "b_behavior.py", "a_touch.py")
    return {"git_head": git("rev-parse", "HEAD"), "tree_dirty": bool(git("status", "--porcelain", "--", me, *deps)),
            "sha256": {d: R4.sha256_file(os.path.join(here, d)) for d in (me,) + deps},
            "python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__}


def load_pool(datasets, cash_dir, say):
    """R10.4's series (R104-1..5), rebuilt with r104_cash functions. cash_dir holds the three aave-pool-cash files
    (the RDU file rebuilt from its .part files, as R10.4)."""
    shas = {}
    for f, hh in R4.CASH_SHA.items():
        got = R4.sha256_file(os.path.join(cash_dir, f))
        if got != hh:
            raise SystemExit(f"STOP: {f} sha256 {got} != {hh}")
        shas[f"aave-pool-cash/{f}"] = got
    for rel, hh in R4.R9_SHA.items():
        got = R4.sha256_file(os.path.join(datasets, rel))
        if got != hh:
            raise SystemExit(f"STOP: {rel} sha256 {got} != {hh}")
        shas[rel] = got
    for rel in R4.BORROWS + R4.REPAYS:
        shas[rel] = R4.sha256_file(os.path.join(datasets, rel))
    w = pd.read_csv(os.path.join(datasets, R4.W24))
    origins = w["origin"].tolist()
    t = np.array([R4.day_ts(d) for d in origins], dtype=np.int64)
    anc = t - 1
    S_snap = w["snap_supply"].to_numpy(float) * MICRO
    C_snap = w["snap_cash"].to_numpy(float) * MICRO
    tl = R4.load_cash_path(cash_dir)
    cts = tl["ts"].to_numpy(np.int64)
    cval = tl["cash"].to_numpy(np.int64)
    end_ts = int(cts.max())
    k = np.searchsorted(cts, anc, side="right") - 1
    cash_anchor = cval[k]
    g1 = int(np.sum(np.abs(cash_anchor - np.round(C_snap)) > 1))
    say("G1 mismatches", g1)
    if g1:
        raise SystemExit("STOP: G1 failed")
    C_end = cash_anchor.astype(float)
    cash_t0 = np.array([R4.state_at(cts, cval, int(x)) for x in t], dtype=float)
    dmin = np.full(len(t), np.nan)
    for i, x in enumerate(t):
        if x + DAY <= end_ts:
            dmin[i] = R4.window_min(cts, cval, int(cash_t0[i]), int(x), int(x) + DAY)
    legs = pd.read_csv(os.path.join(datasets, R4.QRT_LEGS), dtype={"neutral_raw": str, "event_amount_raw": str})
    legs = legs[["qrt_id", "leg", "ts", "neutral_raw"]].assign(block=legs["ts"])
    vis = t + R4.LOOKAHEAD_S
    Q_full = R4.qrt_outstanding(legs, anc).astype(float)
    Q_live = R4.qrt_outstanding(legs, anc, visible_by=vis).astype(float)
    salt = secrets.token_hex(32)
    bo, re_ = R4.load_borrow_repay(datasets, salt)
    drts = R4.detect_drt(bo, re_)
    del bo, re_
    R_full = R4.drt_outstanding(drts, anc, key="ts").astype(float)
    R_live = R4.drt_outstanding(drts, anc, visible_by=vis, key="ts").astype(float)
    full = R4.make_flows(S_snap, C_end, dmin, Q_full, R_full)
    live = R4.make_flows(S_snap, C_end, dmin, Q_live, R_live)
    T = len(t)
    ytrue = {}
    for hn, H in HMODEL.items():
        ytrue[hn] = np.array([np.min(dmin[i:i + H]) if i + H <= T and np.isfinite(dmin[i:i + H]).all()
                              else np.nan for i in range(T)])
    nc = {hn: np.array([np.min(dmin[i - H:i]) if i - H >= 0 else np.nan for i in range(T)])
          for hn, H in HMODEL.items()}
    q2a, q2b = R4.day_ts(R4.Q2[0]), R4.day_ts(R4.Q2[1])
    sets = {}
    for hn, H in HMODEL.items():
        res = (t + H * DAY <= end_ts)
        inq2 = (t + H * DAY > q2a) & (t < q2b)
        first = t >= R4.day_ts(R4.SCORE_FIRST)
        sets[hn] = {"score": np.where(first & res & ~inq2)[0], "q2": np.where(first & res & inq2)[0]}
    return {"origins": origins, "t": t, "S_snap": S_snap, "cash_t0": cash_t0, "dmin": dmin, "full": full,
            "live": live, "ytrue": ytrue, "nc": nc, "sets": sets, "end_ts": end_ts, "shas": shas,
            "counts": {"origins": T, "qrt_anchors_full": int((Q_full > 0).sum()),
                       "qrt_anchors_live": int((Q_live > 0).sum()), "drt": len(drts),
                       "drt_anchors_full": int((R_full > 0).sum()), "drt_anchors_live": int((R_live > 0).sum())}}


def load_r104_published(datasets, pool, say):
    run = os.path.join(datasets, R104_RUN)
    shas = {}
    man = R4.sha256_file(os.path.join(run, "frozen-r104.json"))
    if man != R104_FILES["frozen-r104.json"]:
        raise SystemExit("STOP: frozen-r104.json is not the R10.4 freeze")
    shas[R104_RUN + "frozen-r104.json"] = man
    shas[R104_RUN + "forecasts-r104.csv.gz"] = R4.sha256_file(os.path.join(run, "forecasts-r104.csv.gz"))
    prov = open(os.path.join(run, "PROVENANCE.md")).read()
    if shas[R104_RUN + "forecasts-r104.csv.gz"] not in prov:
        raise SystemExit("STOP: forecasts-r104.csv.gz sha256 not in its PROVENANCE")
    df = pd.read_csv(os.path.join(run, "forecasts-r104.csv.gz"))
    oi = {o: i for i, o in enumerate(pool["origins"])}
    out = {}
    g1b = {}
    for hn in HMODEL:
        d = df[df["h"] == hn]
        Q = np.full((len(pool["origins"]), 3), np.nan)
        idx = np.array([oi[o] for o in d["origin"]])
        Q[idx] = d[["q05", "q25", "q50"]].to_numpy(float) * MICRO
        y = d["y_min_cash_usd"].to_numpy(float) * MICRO
        mism = int(np.sum(np.abs(pool["ytrue"][hn][idx] - y) > 1.0))
        g1b[hn] = {"published": int(len(d)), "truth_mismatches_over_1usd": mism}
        if mism:
            raise SystemExit(f"STOP: G1b failed at {hn}: {mism} truth mismatches vs published R10.4")
        out[hn] = Q
    say("G1b", json.dumps(g1b))
    return out, shas, g1b


def deposit_input_hashes(datasets):
    """sha256 of every per-deposit input, checked against the registered values / manifests."""
    import b4_depositor as F
    import b5_econ as E5
    import b6c_cash as BC
    out = dict(F.verify_inputs(datasets, holdouts=False))
    out.update(E5.verify_b4_run(datasets))
    out.update(BC.verify_b6_run(datasets))
    for fn, want in BC.R9_SHA.items():
        got = R4.sha256_file(os.path.join(datasets, BC.R9_RUN, fn))
        if got != want:
            raise SystemExit(f"STOP: {fn} sha256 {got} != {want}")
        out[BC.R9_RUN + fn] = got
    got = R4.sha256_file(os.path.join(datasets, BC.L1C_PANEL))
    if got != BC.L1C_PANEL_SHA:
        raise SystemExit("STOP: L1c panel sha256 differs")
    out[BC.L1C_PANEL] = got
    ddir = os.path.join(datasets, "aave-pool-debt")
    for fn in sorted(os.listdir(ddir)):
        out["aave-pool-debt/" + fn] = R4.sha256_file(os.path.join(ddir, fn))
    for hn, want in B6C_PRED_SHA.items():
        fn = f"predictions-b6c-{hn}-USDC.csv.gz"
        got = R4.sha256_file(os.path.join(datasets, B6C_RUN, fn))
        if got != want:
            raise SystemExit(f"STOP: {fn} sha256 differs from its PROVENANCE")
        out[B6C_RUN + fn] = got
    return out


def _extend_folds(ctx):
    name, start = EXTRA_FOLD
    if ctx.folds[-1][0] != "2026Q3":
        raise SystemExit("STOP: unexpected fold list")
    ctx.folds = list(ctx.folds) + [(name, ctx.day_index[start], ctx.D)]


def b4_ladders(datasets, workers, say, fit=True):
    """B4 as shipped (B6 'b4' recipe), refit on all B3 folds + 2026Q4. -> dict(unit, t, P (n, NC)) for USDC rows."""
    import bg_gradient as G
    import b3_segments as S
    import b4_depositor as F
    import b5_econ as E5
    ctx, res = G.load_main(datasets, say)
    _extend_folds(ctx)
    rows = G.build_rows(ctx, res, compute_labels=True)
    F.add_segments(rows, S.load_flags(datasets))
    F.v4a_features(rows, res, ctx.D)
    sel = np.nonzero(rows["reserve"] == 0)[0]
    info = {"rows_usdc": int(len(sel)), "rows_usdc_extra_fold": int(((rows["fold"] == len(ctx.folds) - 1)
                                                                   & (rows["reserve"] == 0)).sum()),
            "days": ctx.D, "last_day": ctx.days[-1]}
    if not fit:
        return None, info, ctx
    shipped4 = json.load(open(os.path.join(datasets, E5.B4_RUN, "shipped-b4.json")))["cells"]
    xc = [int(c) for c in G.XCELL.ravel()]
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc]
    say(f"B4 refits: {len(tasks)} tasks")
    fits4, test4 = F.run_fits(ctx, rows, tasks, np.zeros(0, np.int64), S.LIVE_ASOF_TS, workers=workers, log=say)
    PR4, fp4, _, _ = F.assemble(rows, fits4, test4)
    raw4 = {r: E5.fix_nomask(PR4[r][sel]) for r in F.RUNGS}
    seg = rows["seg"][sel]
    fold = rows["fold"][sel]
    P = np.full((len(sel), G.NC), np.nan)
    for ci in xc:
        cid = G.CELLS[ci]["id"]
        for s in range(S.NSEG):
            sh = shipped4[cid][S.SEG_IDS[s]]["shipped"]
            m = seg == s
            if sh:
                P[m, ci] = raw4[sh][m, ci]
            else:
                for fi in range(len(ctx.folds)):
                    mm = m & (fold == fi)
                    v = fp4[fi][cid]["v2"]["seg_pop"][s]
                    P[mm, ci] = v if np.isfinite(v) else fp4[fi][cid]["v2"]["pop"]
    test = (fold >= 0) & rows["feat_ok"][sel]
    P[~test] = np.nan
    return {"unit": rows["unit"][sel].astype(np.int64), "t": rows["t"][sel].astype(np.int64), "P": P,
            "days": ctx.days}, info, ctx


def corrected_rows(datasets, workers, say, fit=True):
    """B6c corrected rows (label-view neutralised paths, feature-view balances), realised drawdowns and labels, and
    the v4ac ladders refit on all B3 folds + 2026Q4."""
    import bg_gradient as G
    import b3_segments as S
    import b4_depositor as F
    import b5_econ as E5
    import b6_cash as B6
    import b6c_cash as BC
    ctx, res = G.load_main(datasets, say)
    _extend_folds(ctx)
    legs, w24, r9s = BC.load_r9(datasets)
    R = res[0]
    qrts, role_unit = BC.map_legs(datasets, legs, R.addrs)
    info = {"qrts": len(qrts)}
    info["pool"] = BC.patch_pool(ctx, R, w24)
    info["neutralisation"] = {k: v for k, v in BC.patch_usdc(ctx, R, qrts).items() if not k.startswith("path_gate")}
    # = BC.build_c, keeping the window minima (MN) of the rows
    rows = G.build_rows(ctx, res, compute_labels=True)
    F.add_segments(rows, S.load_flags(datasets))
    F.v4a_features(rows, res, ctx.D)
    R.A = R.A_label
    debt_dir = os.path.join(datasets, B6.DEBT_DIR)
    E, debt, dinfo, dshas = E5.build_econ(datasets, debt_dir, ctx, res, rows, say)
    T = np.asarray(ctx.T, dtype=np.int64)
    wr = BC.load_withdrawal_rows_keyed(datasets, R.addrs, int(T[0]))
    wr["amount"], _ = BC.neutral_withdrawals(wr["block"], wr["log"], wr["unit"], wr["amount"], wr["kind"], qrts)
    R.A = R.A_feature
    wd = B6.withdrawal_table(wr["unit"], wr["ts"], wr["amount"], wr["kind"])
    Yc, RESc = B6.cash_labels(R, debt, wd, T, E["unit"], E["t"], E["bal"], E["RESOLD"])
    if not np.array_equal(RESc, E["RES"]):
        raise SystemExit("STOP: y_cash resolved set differs from y_econ's (B6-2)")
    C = dict(E)
    C["Y"] = Yc
    C["YECON"] = E["Y"]
    mdd = rows["F4"]["x10"][E["sel"], 1]
    C["F4"] = E5.econ_hist_features(C["unit"], C["t"], Yc, RESc, mdd, rows["n_units"], ctx.D)
    sel = E["sel"]
    C["MN"] = rows["MN"][sel]
    C["HAS"] = rows["HAS"][sel]
    info["rows"] = int(len(sel))
    shas = dict(r9s)
    shas.update(dshas)
    if not fit:
        return C, None, info, shas, ctx
    xc = [int(c) for c in G.XCELL.ravel()]
    usdc_units = np.arange(len(R.addrs), dtype=np.int64)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in xc]
    say(f"v4ac refits: {len(tasks)} tasks")
    fitsC, testC = F.run_fits(ctx, C, tasks, usdc_units, S.LIVE_ASOF_TS, workers=workers, log=say)
    PRC, _, _, _ = F.assemble(C, fitsC, testC)
    Pv = E5.fix_nomask(PRC["v4a"])
    test = (C["fold"] >= 0) & C["feat_ok"]
    Pv[~test] = np.nan
    return C, Pv, info, shas, ctx


def gate_published(datasets, days, unit, t, P, which, say):
    """refit ladders vs published predictions at 24 h and 7 d (6 significant digits)."""
    import bg_gradient as G
    out = {}
    D = len(days)
    key = unit * D + t
    o = np.argsort(key)
    ks = key[o]
    day_index = {s: i for i, s in enumerate(days)}
    for hn in HMODEL:
        hi = HCELL[hn]
        if which == "b4":
            fp = os.path.join(datasets, B6_RUN, f"predictions-b6-{hn}-USDC.csv.gz")
            man = json.load(open(os.path.join(datasets, B6_RUN, "manifest.json")))
            if man["files"][os.path.basename(fp)]["sha256"] != R4.sha256_file(fp):
                raise SystemExit(f"STOP: {fp} sha256 differs from its manifest")
            col = "b4"
        else:
            fp = os.path.join(datasets, B6C_RUN, f"predictions-b6c-{hn}-USDC.csv.gz")
            if R4.sha256_file(fp) != B6C_PRED_SHA[hn]:
                raise SystemExit(f"STOP: {fp} sha256 differs from its PROVENANCE")
            col = "v4ac"
        df = pd.read_csv(fp)
        dk = df["unit"].to_numpy(np.int64) * D + df["date"].map(day_index).to_numpy(np.int64)
        j = np.searchsorted(ks, dk)
        ok = (j < len(ks)) & (ks[np.minimum(j, len(ks) - 1)] == dk)
        r = o[j[ok]]
        mism, cmp_ = 0, 0
        for ci in G.XCELL[hi]:
            cid = G.CELLS[ci]["id"]
            pub = df[f"{col}_{cid}"].to_numpy(float)[ok]
            mine = P[r, ci]
            fin = np.isfinite(pub)
            cmp_ += int(fin.sum())
            bad = fin & ~(np.isfinite(mine) & (np.abs(mine - pub) <= 5e-6 * np.maximum(np.abs(pub), 1e-12) + 1e-12))
            mism += int(bad.sum())
        out[hn] = {"published_rows": int(len(df)), "rows_not_found": int((~ok).sum()), "values_compared": cmp_,
                   "mismatches": mism}
    out["all_equal"] = all(out[h]["rows_not_found"] == 0 and out[h]["mismatches"] == 0 for h in HMODEL)
    say(f"gate {which}", json.dumps(out))
    return out


# ---------------------------------------------------------------------------------------------
# realised series and rho
# ---------------------------------------------------------------------------------------------
def realised(C, days, pool, hn):
    """per origin index: realised big-holder >= 10% outflow (USD micro) for window h; and per-row realised bits."""
    import bg_gradient as G
    hi = HCELL[hn]
    c10 = G.XCELL[hi, 0]
    bal = C["bal"].astype(float)
    mn = C["MN"][:, hi].astype(float)
    f = np.clip((bal - mn) / bal, 0.0, 1.0)
    y10 = C["YOLD"][:, c10].astype(bool)
    contrib = np.where(y10, bal * f, 0.0)
    oi = {o: i for i, o in enumerate(pool["origins"])}
    row_o = np.array([oi.get(days[int(d)], -1) for d in C["t"]], dtype=np.int64)
    O = np.full(len(pool["origins"]), np.nan)
    dset = set(days)
    have = np.array([o in dset for o in pool["origins"]])               # every anchor day (0 if no big deposit)
    O[have] = 0.0
    np.add.at(O, row_o[row_o >= 0], contrib[row_o >= 0])
    return O, row_o, f, y10


def rho_day_grids(row_o, P10, y, resv, n_orig, say, label):
    """per origin day: N_d, P_d, V_d(rho grid) over resolved rows with a ladder."""
    nodes = gh_nodes()
    N = np.full(n_orig, np.nan)
    Pd = np.full(n_orig, np.nan)
    V = np.full((n_orig, len(RHO_GRID)), np.nan)
    ok = (row_o >= 0) & np.isfinite(P10) & resv
    order = np.argsort(row_o[ok], kind="mergesort")
    ro = row_o[ok][order]
    pp = P10[ok][order]
    yy = y[ok][order].astype(float)
    starts = np.r_[0, np.nonzero(np.diff(ro))[0] + 1]
    ends = np.r_[starts[1:], len(ro)]
    t0 = time.time()
    for a, b in zip(starts, ends):
        d = ro[a]
        N[d] = yy[a:b].sum()
        Pd[d] = pp[a:b].sum()
        V[d] = copula_var_grid(pp[a:b], nodes=nodes)
    say(f"  rho grids {label}: {len(starts)} days ({time.time() - t0:.0f} s)")
    return N, Pd, V


def rho_at(n, H, N, Pd, V, trail=TRAIL_DAYS):
    lo = max(0, n - trail)
    d = np.arange(lo, n - H + 1)
    d = d[np.isfinite(N[d])]
    if len(d) < RHO_MIN_DAYS:
        return float("nan"), len(d)
    emp = float(np.var(N[d] - Pd[d], ddof=1))
    return solve_rho(emp, V[d].mean(axis=0)), len(d)


# ---------------------------------------------------------------------------------------------
def guard_file(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        if ADDR_RE.search(f.read()):
            raise SystemExit(f"STOP: address-like string in {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--cash", required=True, help="dir with the 3 aave-pool-cash files (RDU rebuilt from parts)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--inputs-only", action="store_true")
    ap.add_argument("--freeze-only", action="store_true", help="write and hash frozen-r115.json, then stop")
    ap.add_argument("--allow-dirty", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    logf = open(os.path.join(a.out, "run.log" if not a.inputs_only else "inputs-only.log"), "a")

    def say(*m):
        s = " ".join(str(x) for x in m)
        print(s, flush=True)
        logf.write(s + "\n")
        logf.flush()

    meta = code_meta()
    if not a.inputs_only:
        if os.path.exists(os.path.join(a.out, "results-r115.json")) or (
                not a.freeze_only and os.path.exists(os.path.join(a.out, "run.log"))
                and "FIT START" in open(os.path.join(a.out, "run.log")).read()):
            raise SystemExit("STOP: results exist; R11.5 runs once")
        if meta["tree_dirty"] and not a.allow_dirty:
            raise SystemExit("STOP: uncommitted changes in the code; commit before the run")
    t_start = time.time()
    say("pool series (R10.4)")
    pool = load_pool(a.datasets, a.cash, say)
    R104, r104_shas, g1b = load_r104_published(a.datasets, pool, say)
    shas = dict(pool["shas"])
    shas.update(r104_shas)
    lp = os.path.join(a.datasets, LABELS_R9)
    shas[LABELS_R9] = R4.sha256_file(lp)
    shas.update(deposit_input_hashes(a.datasets))
    origins = pool["origins"]
    oi = {o: i for i, o in enumerate(origins)}
    score_sets = {}
    for hn in HMODEL:
        sc = pool["sets"][hn]["score"]
        keep = np.array([n for n in sc if origins[n] <= SCORE_DATA_END], dtype=int)
        score_sets[hn] = {"score": keep, "q2": pool["sets"][hn]["q2"],
                          "not_forecast": [origins[n] for n in sc if origins[n] > SCORE_DATA_END]}
    counts = {"pool": pool["counts"], "g1b": g1b,
              "scoring_origins": {h: int(len(v["score"])) for h, v in score_sets.items()},
              "r104_scoring_origins": {h: int(len(pool["sets"][h]["score"])) for h in HMODEL},
              "q2_origins": {h: int(len(v["q2"])) for h, v in score_sets.items()},
              "not_forecast": {h: v["not_forecast"] for h, v in score_sets.items()}}
    say("counts", json.dumps(counts))
    if a.inputs_only:
        say("per-deposit inputs (rows only, no fit)")
        _, b4info, _ = b4_ladders(a.datasets, a.workers, say, fit=False)
        C, _, cinfo, cshas, ctx = corrected_rows(a.datasets, a.workers, say, fit=False)
        days = ctx.days
        rd = {}
        for hn in HMODEL:
            O, row_o, f, y10 = realised(C, days, pool, hn)
            rd[hn] = {"days_with_rows": int(np.isfinite(O).sum()), "rows_mapped": int((row_o >= 0).sum()),
                      "rows_y10": int(y10.sum())}
        nr = np.bincount(C["t"].astype(int), minlength=len(days))
        sc = score_sets["24h"]["score"]
        per = [int(nr[ctx.day_index[origins[n]]]) for n in sc]
        say("inputs", json.dumps({"b4": b4info, "corrected": {k: cinfo[k] for k in ("qrts", "rows")},
                                  "realised": rd, "deposits_per_scoring_origin_24h": {
                                      "min": min(per), "median": float(np.median(per)), "max": max(per)},
                                  "corrected_rows_on_or_after_2026-10-01": int((C["t"] >= ctx.day_index[
                                      "2026-10-01"]).sum())}, default=str))
        say("inputs-only: stop before freeze (no fit, no forecast, no score)")
        return

    # ---------- freeze before any fit, forecast or score ----------
    frozen = {"schema": SCHEMA, "prereg": PREREG, "code": meta, "started": started, "inputs_sha256": shas,
              "decisions": DECISIONS,
              "constants": {"QS": QS, "XS": XS, "HMODEL": HMODEL, "TRAIL_DAYS": TRAIL_DAYS, "N_DRAWS": N_DRAWS,
                            "SEED": SEED, "RHO_GRID": [float(RHO_GRID[0]), float(RHO_GRID[-1]), 0.01],
                            "GH_NODES": GH_NODES, "RHO_MIN_DAYS": RHO_MIN_DAYS, "NW_LAG": NW_LAG, "HLN_H": HLN_H,
                            "ALPHA": ALPHA, "HIT": [HIT_LO, HIT_HI], "LOCK_SHARE": LOCK_SHARE,
                            "LOW_SHARE": LOW_SHARE, "EXTRA_FOLD": EXTRA_FOLD, "SCORE_DATA_END": SCORE_DATA_END},
              "input_counts": counts}
    fp = os.path.join(a.out, "frozen-r115.json")
    if a.freeze_only:
        if os.path.exists(fp):
            raise SystemExit("STOP: frozen-r115.json exists; R11.5 freezes once")
        frozen["frozen_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(fp, "w") as f:
            json.dump(frozen, f, indent=1, default=str)
        guard_file(fp)
        say("FROZEN frozen-r115.json sha256", R4.sha256_file(fp), "at", frozen["frozen_utc"])
        say("freeze-only: stop before any fit, forecast or score")
        return
    if not os.path.exists(fp):
        raise SystemExit("STOP: run --freeze-only first; the frozen config is hashed and posted before the run")
    fz = json.load(open(fp))
    fh = R4.sha256_file(fp)
    for k in ("decisions", "constants", "inputs_sha256", "input_counts"):
        if json.loads(json.dumps(frozen[k], default=str)) != fz[k]:
            raise SystemExit(f"STOP: frozen config field {k} differs from this run")
    if fz["code"]["git_head"] != meta["git_head"] or fz["code"]["sha256"] != meta["sha256"]:
        raise SystemExit("STOP: code differs from the frozen config")
    frozen["frozen_utc"] = fz["frozen_utc"]
    say("using FROZEN frozen-r115.json sha256", fh, "created", fz["frozen_utc"])

    # ---------- per-deposit ladders (refits + gates) ----------
    say("FIT START")
    say("B4 ladders")
    L4, b4info, ctx4 = b4_ladders(a.datasets, a.workers, say)
    g2 = gate_published(a.datasets, L4["days"], L4["unit"], L4["t"], L4["P"], "b4", say)
    if not g2["all_equal"]:
        raise SystemExit("STOP: gate G2 failed (B4 refit does not reproduce the published b4 ladders)")
    say("corrected rows and v4ac ladders")
    C, Pv, cinfo, cshas, ctx = corrected_rows(a.datasets, a.workers, say)
    days = ctx.days
    if list(days) != list(L4["days"]):
        raise SystemExit("STOP: day lists differ")
    g3 = gate_published(a.datasets, days, C["unit"].astype(np.int64), C["t"].astype(np.int64), Pv, "v4ac", say)
    if not g3["all_equal"]:
        raise SystemExit("STOP: gate G3 failed (v4ac refit does not reproduce the published B6c ladders)")
    # B4 ladders onto the corrected rows
    D = len(days)
    k4 = L4["unit"] * D + L4["t"]
    o4 = np.argsort(k4)
    kc = C["unit"].astype(np.int64) * D + C["t"].astype(np.int64)
    j = np.searchsorted(k4[o4], kc)
    okj = (j < len(k4)) & (k4[o4][np.minimum(j, len(k4) - 1)] == kc)
    P4 = np.full(Pv.shape, np.nan)
    P4[okj] = L4["P"][o4[j[okj]]]
    del L4
    import bg_gradient as G
    ladders = {"b4": P4, "v4ac": Pv}

    # ---------- realised series, residuals, rho ----------
    nO = len(origins)
    full, live = pool["full"], pool["live"]
    SX, CX = full[0], full[1]
    SXl, CXl = live[0], live[1]
    cash_t0 = pool["cash_t0"]
    S_snap = pool["S_snap"]
    resid, Oreal, rho_inputs = {}, {}, {}
    row_o_all = None
    for hn, H in HMODEL.items():
        O, row_o, f, y10 = realised(C, days, pool, hn)
        row_o_all = row_o
        Oreal[hn] = O
        resid[hn] = (pool["ytrue"][hn] - CX + O) / SX
        hi = HCELL[hn]
        c10 = G.XCELL[hi, 0]
        rho_inputs[hn] = {
            "b4": rho_day_grids(row_o, ladders["b4"][:, c10], C["YOLD"][:, c10], C["RESOLD"][:, hi], nO, say,
                                f"b4 {hn}"),
            "v4ac": rho_day_grids(row_o, ladders["v4ac"][:, c10], C["Y"][:, c10], C["RES"][:, hi], nO, say,
                                  f"v4ac {hn}")}
    # rows per origin
    order = np.argsort(row_o_all, kind="mergesort")
    ro_sorted = row_o_all[order]
    balUSD = C["bal"].astype(float)

    def rows_of(n):
        lo_, hi_ = np.searchsorted(ro_sorted, n, "left"), np.searchsorted(ro_sorted, n, "right")
        return order[lo_:hi_]

    # ---------- R10.4 paths for C lock odds (gate G4) ----------
    def r104_q_paths(n, H):
        SXa, CXa, DXa, xS, xD, dp = full
        sl, cl, dl = live[0][n], live[1][n], live[2][n]
        xs, xd, dd = xS[:n].copy(), xD[:n].copy(), dp[:n].copy()
        xs[n - 1] = np.log(sl / SXa[n - 1])
        xd[n - 1] = np.log(dl / DXa[n - 1])
        dd[n - 1] = max(0.0, min(CXa[n - 1], cl) - pool["dmin"][n - 1]) / SXa[n - 1]
        return r104_paths(n, H, np.append(xs, np.nan), np.append(xd, np.nan), np.append(dd, np.nan), sl, dl,
                          cash_t0[n])

    # ---------- forecasts ----------
    rng = np.random.default_rng(SEED)
    ratio = {hn: pool["ytrue"][hn] / cash_t0 for hn in HMODEL}
    recs = {hn: {} for hn in HMODEL}
    g4 = {}
    for hn, H in HMODEL.items():
        t0h = time.time()
        idx_all = np.sort(np.concatenate([score_sets[hn]["score"], score_sets[hn]["q2"]]))
        idx_all = idx_all[[origins[n] <= SCORE_DATA_END for n in idx_all]]
        g4_bad, g4_n = 0, 0
        c10 = G.XCELL[HCELL[hn], 0]
        xcells = G.XCELL[HCELL[hn]]
        for cnt, n in enumerate(idx_all):
            n = int(n)
            lo = max(0, n - TRAIL_DAYS)
            rdays = np.arange(lo, n - H + 1)
            rdays = rdays[np.isfinite(resid[hn][rdays])]
            rws = rows_of(n)
            m = len(rws)
            Z = rng.standard_normal(N_DRAWS)
            ridx = rng.integers(0, len(rdays), N_DRAWS)
            E = rng.standard_normal((N_DRAWS, m))
            rec = {"n_deposits": m, "n_resid_days": int(len(rdays)), "bal_usd": float(balUSD[rws].sum() / MICRO)}
            base, S0 = CXl[n], SXl[n]
            r_draw = resid[hn][rdays][ridx]
            top = rws[np.argsort(-balUSD[rws], kind="mergesort")[:10]]
            topmask = np.isin(rws, top)
            for var in ("b4", "v4ac"):
                Nn, Pdn, Vn = rho_inputs[hn][var]
                rho, nd = rho_at(n, H, Nn, Pdn, Vn)
                if not np.isfinite(rho):
                    raise SystemExit(f"STOP: fewer than {RHO_MIN_DAYS} rho training days at {origins[n]} {hn}")
                Pm = ladders[var][rws][:, xcells]
                noL = ~np.all(np.isfinite(Pm), axis=1)
                Pm = np.where(noL[:, None], 0.0, Pm)
                nonmono = int(np.any(np.diff(Pm, axis=1) > 0, axis=1).sum())
                Pm = np.minimum.accumulate(Pm, axis=1)                  # R115-5: ladder made non-increasing in x
                U = np.sqrt(rho) * Z[:, None] + np.sqrt(1.0 - rho) * E
                Ob, Otop = outflow_draws(U, Pm, balUSD[rws], topmask.astype(float))
                del U
                mc = np.minimum(base - Ob + r_draw * S0, cash_t0[n])
                q = np.quantile(mc, QS, method="linear")
                qfn = np.quantile(mc, TAU_GRID, method="linear")
                rec[var] = {"rho": rho, "rho_days": nd, "q": q, "qfn": qfn, "no_ladder": int(noL.sum()), "nonmonotone": nonmono,
                            "EO": float(Ob.mean()), "top10_share": float(Otop.mean() / Ob.mean()) if Ob.mean() > 0
                            else float("nan"),
                            "p_lock": float(np.mean(mc <= LOCK_SHARE * S_snap[n])),
                            "p_low": float(np.mean(mc <= LOW_SHARE * S_snap[n]))}
            del E
            pm = r104_q_paths(n, H)
            qr = np.quantile(pm, QS, method="linear")
            g4_n += 1
            if np.any(np.abs(qr - R104[hn][n]) > MICRO):
                g4_bad += 1
            rec["r104_qfn"] = np.quantile(pm, TAU_GRID, method="linear")
            eb = emp_baseline(ratio[hn], cash_t0, n, H)
            rec["emp"] = eb
            recs[hn][n] = rec
            if (cnt + 1) % 100 == 0:
                say(f"  {hn}: {cnt + 1}/{len(idx_all)} origins ({time.time() - t0h:.0f} s)")
        g4[hn] = {"origins": g4_n, "mismatches_over_1usd": g4_bad}
        say(f"G4 {hn}", json.dumps(g4[hn]))
        if g4_bad:
            raise SystemExit(f"STOP: gate G4 failed at {hn} (R10.4 path reproduction)")

    # ---------- scores ----------
    def model_Q(hn, n, var, kind):
        r = recs[hn][n]
        if kind == "D":
            return r[var]["q"]
        return 0.5 * (r[var]["q"] + R104[hn][n])

    results = {"schema": SCHEMA, "frozen_sha256": fh, "frozen_utc": frozen["frozen_utc"], "code": meta,
               "counts": counts, "gates": {"G1b": g1b, "G2_b4": g2, "G3_v4ac": g3, "G4_r104_paths": g4},
               "b4_info": b4info, "corrected_info": {k: cinfo[k] for k in ("qrts", "rows")}, "per_h": {}}
    rows_out = []
    lab = pd.read_csv(lp)
    lock6 = dict(zip(lab["origin"], lab["LOCK6_24h"]))
    for hn, H in HMODEL.items():
        y = pool["ytrue"][hn]
        per_set = {}
        for setname in ("score", "q2"):
            idx = np.array([n for n in score_sets[hn][setname] if n in recs[hn]], dtype=int)
            if len(idx) == 0:
                continue
            Y = y[idx]
            QR = R104[hn][idx]
            QE = np.array([recs[hn][n]["emp"] for n in idx])
            QN = np.repeat(pool["nc"][hn][idx][:, None], 3, axis=1)
            Lr, Le, Ln = pinball3(Y, QR), pinball3(Y, QE), pinball3(Y, QN)
            res = {"n": int(len(idx)), "first": origins[idx[0]], "last": origins[idx[-1]],
                   "mean_pinball_usd": {"r104": float(Lr.mean() / MICRO), "empirical": float(Le.mean() / MICRO),
                                        "nochange": float(Ln.mean() / MICRO)},
                   "hit_q05": {"r104": float(np.mean(Y < QR[:, 0])), "empirical": float(np.mean(Y < QE[:, 0]))},
                   "models": {}}
            for var in ("b4", "v4ac"):
                for kind in ("D", "C"):
                    Qm = np.array([model_Q(hn, n, var, kind) for n in idx])
                    Lm = pinball3(Y, Qm)
                    st_r, p_r = dm_hln(Lm - Lr)
                    st_e, p_e = dm_hln(Lm - Le)
                    hit = float(np.mean(Y < Qm[:, 0]))
                    rec = {"mean_pinball_usd": float(Lm.mean() / MICRO),
                           "vs_r104": {"improvement": float(1 - Lm.mean() / Lr.mean()), "dm_stat": st_r, "p": p_r},
                           "vs_empirical": {"improvement": float(1 - Lm.mean() / Le.mean()), "dm_stat": st_e,
                                            "p": p_e},
                           "skill_vs_nochange": float(1 - Lm.mean() / Ln.mean()),
                           "hit": {str(q): float(np.mean(Y < Qm[:, jq])) for jq, q in enumerate(QS)},
                           "per_quantile_pinball_usd": {str(q): float(np.mean(R4.pinball(Y, Qm[:, jq], q)) / MICRO)
                                                        for jq, q in enumerate(QS)}}
                    rec["PASS"] = bool(Lm.mean() < Lr.mean() and Lm.mean() < Le.mean() and p_r < ALPHA
                                       and p_e < ALPHA and HIT_LO <= hit <= HIT_HI)
                    yrs = {}
                    for yy in ("2024", "2025", "2026"):
                        mm = np.array([origins[n].startswith(yy) for n in idx])
                        if mm.sum():
                            yrs[yy] = {"n": int(mm.sum()), "vs_r104": float(1 - Lm[mm].mean() / Lr[mm].mean()),
                                       "vs_empirical": float(1 - Lm[mm].mean() / Le[mm].mean())}
                    rec["by_year"] = yrs
                    res["models"][f"{kind}_{var}"] = rec
            res["per_quantile_pinball_usd"] = {
                nm: {str(q): float(np.mean(R4.pinball(Y, QQ[:, jq], q)) / MICRO) for jq, q in enumerate(QS)}
                for nm, QQ in (("r104", QR), ("empirical", QE), ("nochange", QN))}
            per_set[setname] = res
        rh = {var: np.array([recs[hn][n][var]["rho"] for n in sorted(recs[hn])]) for var in ("b4", "v4ac")}
        sh = np.array([recs[hn][n]["b4"]["top10_share"] for n in sorted(recs[hn])])
        per_set["rho_summary"] = {var: {"min": float(v.min()), "median": float(np.median(v)), "max": float(v.max())}
                                  for var, v in rh.items()}
        per_set["top10_share_of_EO_b4"] = {"median": float(np.nanmedian(sh)), "p90": float(np.nanpercentile(sh, 90))}
        per_set["no_ladder_rows_total"] = {var: int(sum(recs[hn][n][var]["no_ladder"] for n in recs[hn]))
                                           for var in ("b4", "v4ac")}
        per_set["nonmonotone_ladder_rows_total"] = {var: int(sum(recs[hn][n][var]["nonmonotone"] for n in recs[hn]))
                                                    for var in ("b4", "v4ac")}
        per_set["deposit_rows_total"] = int(sum(recs[hn][n]["n_deposits"] for n in recs[hn]))
        results["per_h"][hn] = per_set
        sset = set(score_sets[hn]["score"].tolist())
        for n in sorted(recs[hn]):
            r = recs[hn][n]
            thr_l, thr_1 = LOCK_SHARE * S_snap[n], LOW_SHARE * S_snap[n]
            row = {"h": hn, "origin": origins[n], "set": "score" if n in sset else "q2",
                   "y_min_cash_usd": y[n] / MICRO, "nochange_usd": pool["nc"][hn][n] / MICRO,
                   "cash_t0_usd": cash_t0[n] / MICRO, "cashX_t0_usd": CXl[n] / MICRO,
                   "supplyX_t0_usd": SXl[n] / MICRO, "supply_raw_t0_usd": S_snap[n] / MICRO,
                   "n_deposits": r["n_deposits"], "deposit_bal_usd": r["bal_usd"], "n_resid_days": r["n_resid_days"]}
            for j, q in enumerate(("q05", "q25", "q50")):
                row[f"r104_{q}"] = R104[hn][n][j] / MICRO
                row[f"emp_{q}"] = r["emp"][j] / MICRO
            for var in ("b4", "v4ac"):
                v = r[var]
                qc = 0.5 * (v["q"] + R104[hn][n])
                qfn_c = 0.5 * (v["qfn"] + r["r104_qfn"])
                for j, q in enumerate(("q05", "q25", "q50")):
                    row[f"D_{var}_{q}"] = v["q"][j] / MICRO
                    row[f"C_{var}_{q}"] = qc[j] / MICRO
                row[f"rho_{var}"] = v["rho"]
                row[f"EO_{var}_usd"] = v["EO"] / MICRO
                row[f"top10_share_{var}"] = v["top10_share"]
                row[f"no_ladder_{var}"] = v["no_ladder"]
                row[f"D_{var}_p_lock"] = v["p_lock"]
                row[f"D_{var}_p_le_1pct"] = v["p_low"]
                row[f"C_{var}_p_lock"] = prob_le_from_quantile_fn(qfn_c, thr_l)
                row[f"C_{var}_p_le_1pct"] = prob_le_from_quantile_fn(qfn_c, thr_1)
            row["realised_min_share"] = y[n] / S_snap[n]
            row["LOCK6_24h_label"] = lock6.get(origins[n], float("nan")) if hn == "24h" else float("nan")
            rows_out.append(row)
    fc = pd.DataFrame(rows_out)
    apr = fc[(fc["h"] == "24h") & (fc["origin"] >= "2026-03-25") & (fc["origin"] <= "2026-05-05")]
    results["april_2026_stress_line"] = apr[["origin", "D_b4_p_lock", "C_b4_p_lock", "D_b4_p_le_1pct",
                                             "C_b4_p_le_1pct", "realised_min_share", "LOCK6_24h_label"]].to_dict(
        orient="records")
    lk = fc[fc["h"] == "24h"]
    results["lock_odds_summary_24h"] = {c: {"mean": float(lk[c].mean()), "max": float(lk[c].max()),
                                            "origins_over_1pct": int((lk[c] > 0.01).sum())}
                                        for c in ("D_b4_p_lock", "C_b4_p_lock", "D_b4_p_le_1pct", "C_b4_p_le_1pct",
                                                  "D_v4ac_p_lock", "C_v4ac_p_lock")}
    sc24 = results["per_h"]["24h"]["score"]["models"]
    results["verdict_24h"] = {"D": sc24["D_b4"]["PASS"], "C": sc24["C_b4"]["PASS"],
                              "note": "B4 variant decides; v4ac variant and 7 d are reported only"}
    results["runtime_s"] = time.time() - t_start
    results["finished_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rp = os.path.join(a.out, "results-r115.json")
    with open(rp, "w") as f:
        json.dump(results, f, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
    fcp = os.path.join(a.out, "forecasts-r115.csv.gz")
    fc.to_csv(fcp, index=False, compression="gzip")
    for p in (rp, fcp, os.path.join(a.out, "run.log")):
        guard_file(p)
    say("verdict 24h", json.dumps(results["verdict_24h"]))
    say("DONE results", R4.sha256_file(rp))


if __name__ == "__main__":
    main()
