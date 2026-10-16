#!/usr/bin/env python3
"""Q26 workstream B4: stress-window audit, threshold-matched history (v4a), estimated frailty (v4b), and the
blind set B-5 of unseen Aave stablecoin reserves.

Implements membrane-board `design/DEPOSITOR_BEHAVIOR_PREREG_B4.md` (registered at board commit 019adca, sha256
255c20e6...6106) on top of B3 (`DEPOSITOR_BEHAVIOR_PREREG_B3.md`, D1) and B-gradient (`_B2.md`, D1-D3), whose code
is imported unchanged: rows, intraday labels, cap, y_all, folds, the v2 model, G.7 labels, the monotone fix and the
segments come from bg_gradient.py / b3_segments.py; the D1 display from b3_panel_d1.py. Every B4 constant below
comes from the B4 file; where it is silent the choice is listed in DECISIONS (closest to the B3 code).

Phases (one fresh --out, in this order):
  --phase borrows   Aave V3 Core Pool Borrow events (free eth_getLogs) -> --borrow-dir (B4.0 borrow_exit only)
  --phase audit     B4.0 on the frozen B3 test predictions (fits nothing, decides nothing) -> audit-b4.json
  --phase dryrun    rows, segments per fold; no outcome
  --phase run       development phase ONCE: v2, v4a, v4b per fold x cell on USDC/USDT; B4.3 comparisons, shipping,
                    labels; the B3.6 per-reserve rule on DAI and USDe (development data); D1 panel preview
                    -> results-dev.json, labels-dev.csv, predictions-dev-*.csv.gz, panel-preview.csv (refuses overwrite)
  --phase freeze    shipped rungs, labels and fits -> shipped-b4.json + freeze-record.json (sha256)
  --phase blind5    B4.6 ONCE. Refuses without --blind5-commit SHA and --frozen-sha256 equal to the freeze record;
                    writes blind5-started.json first and refuses if it exists. NOT RUN by the dev session.
  --phase blind5-report  after the single B4.6 run: per-reserve BSS per (cell, segment) (reported only; STOPs
                    unless its recomputed predictions reproduce results-blind5.json exactly)
  --phase manifest  sha256 of every output
--workers N (default 3) sets the fit processes (fork; BLAS pinned to one thread).

Addresses are public on-chain data. This code attaches no identity, label or name to any address.
Light models only (sklearn logistic + empirical-Bayes shrinkage).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b_behavior as B  # noqa: E402
import bg_gradient as G  # noqa: E402
import b3_segments as S  # noqa: E402
import b3_panel_d1 as D1  # noqa: E402

# ---------------------------------------------------------------------------------------------
# Registered constants (B4.0-B4.6)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "membrane-board", "path": "design/DEPOSITOR_BEHAVIOR_PREREG_B4.md", "commit": "019adca",
    "sha256": "255c20e6ab75d4ef1947c7cae5b4ed084fe78d7b6c0eb1beba104049b9556106",
    "parents": {"B3": "design/DEPOSITOR_BEHAVIOR_PREREG_B3.md (cac7aeb; D1 5df2722)",
                "B-gradient": "design/DEPOSITOR_BEHAVIOR_PREREG_B2.md (5e45406; D1-D3)",
                "B": "design/DEPOSITOR_BEHAVIOR_PREREG.md (7a5f8a6)"},
}
DATASETS = dict(S.DATASETS)
B3_RUN = "history-forecasts/b3/run-6b2ff4d7/"
B3_RUN_FILES = ("results.json", "shipped-b3.json", "units.csv", "live-inputs.json", "holdout-codes.json") + tuple(
    f"predictions-test-{h}-{r}.csv.gz" for h in G.HNAMES for r in G.MAIN_RESERVES)
BLIND5_DIR = "depositor-blind5/"

SEED_B4 = 20261100                        # B4.3 bootstrap (draws in the order h, x, segment)
SEED_B5 = 20261101                        # DECISION B4-19 (B4.6 CIs; no registered seed)
SEED_B5_POOL = 20261102                   # DECISION B4-19 (B4.6 pooling-term CIs)
STRESS_START = 1776470400                 # 2026-04-18T00:00:00Z (B4.0)
STRESS_END = 1777075200                   # 2026-04-25T00:00:00Z
STATED_R = (0.8, 1.25)                    # B4.0 stated band, 7 d R without stress rows, wallets $1-10M
HIST_DAYS = 90                            # B4.2 v4a: last 90 days
DAYS_CAP = 365.0                          # B4.2 v4a: days since the last such origin, capped at 365
M_GRID = (0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 20.0, 50.0)   # B4.2 v4b
M_TIE_TARGET = 3.0                        # tie -> the value nearer 3
M_DEFAULT = 3.0                           # DECISION B4-6: a segment without training units keeps m = 3
HALF_LIFE_S = 180 * 86400                 # B4.2 v4b discount half-life
TIE_RTOL = 1e-12
RUNGS = ("v2", "v4a", "v4b")             # simpler first (a tie keeps the simpler rung)
LABEL_RANK = S.LABEL_RANK
NF2 = len(G.FEATURES_V2)                  # 13
KEEP_V2 = 11                              # v2 features kept by v4a (drops log1p_dec_count30, log1p_days_since_dec)
FEATURES_V4A = G.FEATURES_V2[:KEEP_V2] + ("log1p_n_x90", "maxdd90", "log1p_days_since_x")
XKEYS = tuple(f"x{x}" for x in G.SIZES) + ("all",)
SEG_IDS, SEG_NAMES, NSEG = S.SEG_IDS, S.SEG_NAMES, S.NSEG
HOLDOUT_RULE = S.HOLDOUT_RULE             # ("DAI", "USDe"); GHO reported only
B5_MIN_NEP_RESERVE = 50                   # B4.6 label rule
B5_R = (0.67, 1.5)
B5_VERDICT_NEP = 20                       # B4.6 (i) cells with n_ep >= 20
B5_VERDICT_HORIZONS = ("24h", "48h", "7d")
B5_VERDICT_SEGS = ("c2", "c3", "w3")      # contracts >= $10M and wallets >= $50M
B5_VERDICT_BSS_LO = -0.002                # B4.6 (ii)
B5_POOLTEST_FIRST = "2024Q4"              # DECISION B4-20 (B3.6 pooling-term test folds)

CORE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
BORROW_SIG = "Borrow(address,address,address,uint256,uint8,uint256,uint16)"
BORROW_FROM_SNAPSHOT = "2023-10-01"       # DECISION B4-3
BORROW_TO_BLOCK = 26_186_746

DECISIONS = [
    "B4-1 everything not changed by B4 is B3 (b3_segments.py, scored at 6b2ff4d7) and B-gradient (bg_gradient.py) "
    "imported unchanged: rows, intraday labels, liquidity cap, y_all, folds 2023Q4..2026Q3 with the t0 + h purge, the "
    "v2 model (13 features, logistic + unit EB m = 3), G.7 statistics and thresholds, the masked monotone fix applied "
    "per rung before scoring, segments (B3-2, B3-3), and B3-8 / B3-10 scoring conventions.",
    "B4-2 B4.0 stress rows: a test row's window (t0, t0 + h] overlaps [2026-04-18T00:00Z, 2026-04-25T00:00Z) with "
    "positive length, i.e. t0 < 2026-04-25T00:00Z and t0 + h > 2026-04-18T00:00Z. The shipped rung of B3 = "
    "shipped-b3.json per (cell, segment); where none ships the shown number is the population rate (pop column). R is "
    "reported for the shipped rung (or pop) and for v2, with and without stress rows. The statement check reads the "
    "7 d cells (x10..x90 and all_7d) of segment w1.",
    "B4-3 Borrow events: Aave V3 Core Pool Borrow(reserve, user, onBehalfOf, amount, interestRateMode, borrowRate, "
    "referralCode) logs from the 2023-10-01 snapshot block to block 26,186,746 (every B3 test window ends by "
    "2026-10-08), eth_getLogs on rpc.mevblocker.io with topic0 = keccak(signature), the G.1 range / retry policy. "
    "borrow_exit = some Borrow with onBehalfOf = the unit's address and block ts in (t0, t0 + h], any reserve.",
    "B4-4 cash_blocked: the window (t0, t0 + h] contains the daily snapshots d + j, j = 1..floor(h / 24 h) (none at "
    "1 h and 6 h). x cell: 100 * cash(d + j) < x * bal(t0) at some j (exact ints, the reserve's own cash). y_all cell: "
    "10 * cash(d + j) < 9 * avail(t0), avail = min(bal(t0), cash(t0)) (the amount its target needs).",
    "B4-5 v4a features per row and size x (y_all cells use y_all): prior origins t' = the unit's daily origins (valid "
    "anchor >= $1M, any cap or feature state) labelled at 24 h (window resolved, valid anchors) with y(x, 24 h; t') = 1. "
    "n_x90 = number of such t' with d - 90 <= t' <= d - 1 (t' + 24 h <= t0 holds since snapshots are 24 h apart); "
    "days since = d - (the last such t' <= d - 1 over the whole history), capped at 365, 365 if none. maxdd90 = "
    "max over j of (peak_j - B_j) / peak_j over the unit's valid daily 00:00Z anchors B on days d - 90 .. d (the 90 "
    "days ending at t0, t0 included; peak_j = running max from the window start; 0 when no positive peak). The two "
    "counts enter as log1p. The 11 other v2 features are unchanged; the row set (feat_ok) is v2's.",
    "B4-6 v4b: per fold and cell, v4a's logistic fit (same params, same p0). Weights w = 0.5 ^ ((T_ref - T0) / 180 d), "
    "T_ref = the fold start (asof fit: the asof time). O_d, E_d = sums of w * y and w * p0 (in-sample p0 of v4a). "
    "m_seg = argmax over the grid {0.25, ..., 50} of the negative-binomial marginal log likelihood sum over (unit, "
    "segment) of lgamma(O + m) - lgamma(m) + m ln(m / (m + E)) + O ln(E / (m + E)) with (O, E) = the unit's discounted "
    "training sums over its rows in that segment, units with E > 0 (the discounted values enter the likelihood, as "
    "they enter theta: 'discounted before pooling'). Ties (relative 1e-12) -> nearer 3 (|m - 3|, then |ln(m / 3)|). "
    "A segment without training units keeps m = 3. theta_i = (O_d,i + m_seg) / (E_d,i + m_seg) with O_d,i, E_d,i over "
    "all the unit's training rows of the cell and m_seg of the predicted row's segment; no training rows -> theta 1.",
    "B4-7 comparisons (B4.3 = B3.4): per (cell, segment) on its scored test rows, BSS of v2, v4a, v4b vs pop and own, "
    "and of v4a, v4b vs v2. One default_rng(20261100) stream, b3_segments.set_order (x cells h, x, segment; y_all "
    "cells h, segment; pooled x cells h, x; pooled y_all h), day-block draws (block 30, 2,000 replicates); a set with "
    "< 30 test days gets no draw (no CI). own and pop come from the v2 fit (same training rows for every rung).",
    "B4-8 shipping (B4.3, mirrors B3-9 without the tie route): eligible v2 iff its BSS vs pop and vs own have CI lower "
    "bounds > 0; eligible v4a (v4b) iff its BSS vs v2 has a CI lower bound > 0. Ship = the eligible rung with the best "
    "label (HIGH > MEDIUM > LOW > STALE), then the higher BSS vs pop; a tie keeps the simpler rung (v2 < v4a < v4b). "
    "No rung beating pop and own, or no eligible rung -> 'population-rate history', label LOW.",
    "B4-9 labels: G.7 per rung per (cell, segment) (B3-10). Then the B3.6 per-reserve rule (B3-11) with DAI and USDe "
    "as development data: the dev fold models (USDC/USDT only, theta_i = 1, so v4b = v4a there) predict the holdout "
    "test rows, rung grids monotone-fixed, the shipped rung of the row's segment taken (v2 where none ships); a HIGH "
    "stays HIGH iff DAI and USDe each with n_ep >= 50 and the DAI + USDe pool (n_ep >= 50) give 0.67 <= R <= 1.5; "
    "else MEDIUM 'failed transfer' / 'unconfirmed'. GHO reported only. Holdout segments: holder flags from "
    "cross-venue/address-flags.csv and B3's holdout-codes.json (B3-2).",
    "B4-10 display as B3 D1: panel composite fix over model cells only (b3_panel_d1.d1_fix), population cells among "
    "themselves; no tie route exists in B4. The panel preview = top 10 units per reserve at block 26,186,746 "
    "(B3-13 inputs: B3 live-inputs.json, the Chainlink round store), asof refits on every labelled uncapped row "
    "(v4b with T_ref = asof ts), v4a features at asof from daily origins with T + 24 h <= asof and daily anchors in "
    "[asof - 90 d, asof] plus the asof balance (days since in fractional days).",
    "B4-11 v2 check: pooled-over-segments v2 Brier per cell must equal B3 results.json pooled v2 Brier exactly (and "
    "the row counts); recorded as v2_equals_b3_check.",
    "B4-12 B4.4 reported: per (cell, segment) R and BSS of every rung without stress rows (the set's draw restricted "
    "to the other rows); the m_seg table per (segment, cell, fold); contract >= $50M R per rung.",
    "B4-13 freeze: shipped-b4.json = per (cell, segment) shipped rung, dev label, final label, holdout outcome, "
    "labels by rung; fold params of v2 and v4a, v4b m_seg per (fold, cell, segment); asof params; its sha256 and "
    "results-dev.json's in freeze-record.json.",
    "B4-14 B4.6 (blind5 phase, not run here): refuses unless --blind5-commit names a membrane-datasets commit that "
    "holds depositor-blind5/PROVENANCE.md equal to the checkout and --frozen-sha256 equals sha256(shipped-b4.json) "
    "and the freeze record; writes blind5-started.json before reading any B-5 file and refuses if it exists.",
    "B4-15 B-5 transfer: frozen fold models, theta_i = 1 (B-5 units have no own training rows), rung grids fixed, the "
    "shipped rung per (cell, segment) taken (v2 where none ships); pop = the frozen fold's USDC/USDT training rate "
    "(own = pop: no own rows). Per reserve and pooled: R, n_ep, BSS vs pop and own; v4a, v4b vs v2 per (cell, "
    "segment). Label rule: a frozen HIGH stays HIGH only if every B-5 reserve with n_ep >= 50 in that segment and the "
    "B-5 pool give 0.67 <= R <= 1.5; otherwise MEDIUM ('failed transfer'; pool n_ep < 50 -> 'unconfirmed').",
    "B4-16 B-5 pooling-term test (B3-12 form): folds 2024Q4..2026Q3 per B-5 reserve; theta_i from the unit's own "
    "rows of that reserve before Q_start (t0 + h <= Q_start): v2 and v4a with m = 3, v4b with the frozen fold m_seg "
    "of the row's segment and the 180 d discount to Q_start; baselines = that reserve's training rate and the unit's "
    "own rate. Reported per reserve and pooled.",
    "B4-17 B-5 method verdict per new rung (B4.6): (i) on the B-5 pool (theta = 1 transfer), the median |ln R| over "
    "the 24 h, 48 h, 7 d cells (x cells and y_all) of segments c2, c3, w3 with n_ep >= 20 is smaller than v2's on "
    "the same cells; fewer than one such cell -> 'not testable'. (ii) its BSS vs v2 pooled over segments has a CI "
    "lower bound > -0.002 in every cell at 24 h, 48 h and 7 d. Pass iff (i) and (ii).",
    "B4-18 holder type of B-5 addresses from depositor-blind5/<reserve>/holder-codes.csv (B5-6).",
    "B4-19 seeds without a registered value: B-5 CIs default_rng(20261101) in the B4.3 set order; pooling-term CIs "
    "default_rng(20261102).",
    "B4-20 B-5 is_usdt = 0 for every reserve (only Core USDT is USDT).",
]

sha256_file = B.sha256_file
write_json = B.write_json
ratio_R = G.ratio_R
_within = G._within


def code_meta():
    here = os.path.dirname(os.path.abspath(__file__))

    def git(*a):
        try:
            return subprocess.run(["git", "-C", here, *a], capture_output=True, text=True,
                                  timeout=30).stdout.strip() or None
        except Exception:
            return None
    me = os.path.basename(__file__)
    return {"git_head": git("rev-parse", "HEAD"), "last_commit_b4_depositor": git("log", "-1", "--format=%H", "--", me),
            "b4_depositor_sha256": sha256_file(os.path.abspath(__file__)),
            "b4_depositor_dirty": bool(git("status", "--porcelain", "--", me)),
            "b3_segments_sha256": sha256_file(os.path.join(here, "b3_segments.py")),
            "bg_gradient_sha256": sha256_file(os.path.join(here, "bg_gradient.py")),
            "b3_panel_d1_sha256": sha256_file(os.path.join(here, "b3_panel_d1.py")),
            "b_behavior_sha256": sha256_file(os.path.join(here, "b_behavior.py")),
            "python": sys.version.split()[0], "numpy": np.__version__,
            "sklearn": __import__("sklearn").__version__, "scipy": __import__("scipy").__version__,
            "pandas": __import__("pandas").__version__}


# ---------------------------------------------------------------------------------------------
# Core definitions (unit-tested on synthetic data)
# ---------------------------------------------------------------------------------------------
def stress_overlap(T0, hsec, s0=STRESS_START, s1=STRESS_END):
    """B4-2: window (t0, t0 + h] overlaps [s0, s1) with positive length."""
    T0 = np.asarray(T0, dtype=np.int64)
    return (T0 < s1) & (T0 + hsec > s0)


def cash_blocked_flags(t, bal, cash_t0, cash_days, hsec, x=None):
    """B4-4 per row: the window (t0, t0 + h] holds daily snapshots d + j, j = 1..floor(h / 24 h). cash_days =
    (cmat, ridx): cmat (n_reserves, D) daily cash in micro-units (-1 = missing), ridx the row's reserve index.
    x cell (x in percent): 100 * cash(d + j) < x * bal(t0) at some j; y_all (x None): 10 * cash(d + j) < 9 * avail,
    avail = min(bal(t0), cash(t0))."""
    cmat, ridx = cash_days
    t = np.asarray(t, dtype=np.int64)
    bal = np.asarray(bal, dtype=np.int64)
    ridx = np.asarray(ridx, dtype=np.int64)
    k = int(hsec // 86400)
    D = cmat.shape[1]
    out = np.zeros(len(t), bool)
    avail = np.minimum(bal, np.asarray(cash_t0, dtype=np.int64)) if x is None else None
    for j in range(1, k + 1):
        dj = t + j
        ok = dj < D
        c = np.where(ok, cmat[ridx, np.minimum(dj, D - 1)], -1)
        ok &= c >= 0
        if x is None:
            out |= ok & (10 * c < 9 * avail)
        else:
            out |= ok & (100 * c < x * bal)
    return out


def borrow_index(borrow_ts_by_addr, addrs):
    """Sorted keys (address index << 34 | ts) of every Borrow whose onBehalfOf is in addrs (index = position)."""
    keys = [(np.int64(i) << 34) | borrow_ts_by_addr[a].astype(np.int64) for i, a in enumerate(addrs)
            if a in borrow_ts_by_addr]
    return np.sort(np.concatenate(keys)) if keys else np.zeros(0, dtype=np.int64)


def borrow_flags(addr_idx, T0, hsec, bkeys):
    """B4-3 per row: some Borrow with onBehalfOf = the row's address and ts in (t0, t0 + h]."""
    a = np.asarray(addr_idx, dtype=np.int64) << 34
    T0 = np.asarray(T0, dtype=np.int64)
    if len(bkeys) == 0:
        return np.zeros(len(T0), bool)
    k = np.searchsorted(bkeys, a | T0, side="right")
    nxt = bkeys[np.minimum(k, len(bkeys) - 1)]
    return (k < len(bkeys)) & ((nxt >> 34) == (a >> 34)) & ((nxt & ((1 << 34) - 1)) <= T0 + hsec)


def hist_counts(unit, t, flag, n_units, D, window=HIST_DAYS, cap=DAYS_CAP):
    """B4-5 per row (unit, day t), rows unique per (unit, t): n = number of the unit's flagged origins t' with
    t - window <= t' <= t - 1; days = t - (last flagged t' <= t - 1), capped at cap, cap if none."""
    unit = np.asarray(unit, dtype=np.int64)
    t = np.asarray(t, dtype=np.int64)
    flag = np.asarray(flag, bool)
    M = np.zeros((n_units, D), dtype=bool)
    M[unit[flag], t[flag]] = True
    C = np.zeros((n_units, D + 1), dtype=np.int32)
    np.cumsum(M, axis=1, out=C[:, 1:])
    lo = np.maximum(t - window, 0)
    n = C[unit, t] - C[unit, lo]
    L = np.where(M, np.arange(D, dtype=np.int32)[None, :], -1).astype(np.int32)
    np.maximum.accumulate(L, axis=1, out=L)
    last = np.where(t >= 1, L[unit, np.maximum(t - 1, 0)], -1)
    days = np.where(last >= 0, np.minimum((t - last).astype(float), cap), cap)
    return n.astype(np.int64), days


def maxdd_rows(unit, t, Pbal, window=HIST_DAYS, chunk=100_000):
    """B4-5 maxdd90 per row: Pbal (n_units, D) float daily anchors (NaN = invalid). Window days t - window .. t."""
    unit = np.asarray(unit, dtype=np.int64)
    t = np.asarray(t, dtype=np.int64)
    n_units, D = Pbal.shape
    P = np.full((n_units, D + window), np.nan)
    P[:, window:] = Pbal
    off = np.arange(window + 1)
    out = np.zeros(len(t))
    for s in range(0, len(t), chunk):
        u, d = unit[s:s + chunk], t[s:s + chunk]
        W = P[u[:, None], d[:, None] + off[None, :]]
        out[s:s + chunk] = maxdd_matrix(W)
    return out


def maxdd_matrix(W):
    """Rows of balances in time order (NaN skipped) -> max of (running peak - B) / running peak (0 if none)."""
    W = np.asarray(W, float)
    peak = np.fmax.accumulate(W, axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where((peak > 0) & np.isfinite(W), (peak - W) / peak, np.nan)
    allnan = np.all(np.isnan(dd), axis=1)
    out = np.zeros(W.shape[0])
    if (~allnan).any():
        out[~allnan] = np.nanmax(dd[~allnan], axis=1)
    return out


def nb_loglik(O, E, m):
    """Negative-binomial (gamma-Poisson, shape = rate = m) marginal log likelihood of counts O given exposures E,
    without the m-free lgamma(O + 1) term. E > 0 required."""
    from scipy.special import gammaln
    O = np.asarray(O, float)
    E = np.asarray(E, float)
    return float(np.sum(gammaln(O + m) - gammaln(m) + m * np.log(m / (m + E)) + O * np.log(E / (m + E))))


def select_m(O, E, grid=M_GRID, target=M_TIE_TARGET):
    """B4-6: grid m maximizing the NB log likelihood over units with E > 0; ties -> nearer 3. Returns (m, lls, n)."""
    O = np.asarray(O, float)
    E = np.asarray(E, float)
    keep = E > 0
    n = int(keep.sum())
    if n == 0:
        return M_DEFAULT, None, 0
    lls = [nb_loglik(O[keep], E[keep], m) for m in grid]
    best = max(lls)
    ties = [m for m, ll in zip(grid, lls) if abs(ll - best) <= TIE_RTOL * max(1.0, abs(best))]
    m = min(ties, key=lambda v: (abs(v - target), abs(math.log(v / target))))
    return float(m), lls, n


def discount_weights(T0, T_ref, half_life=HALF_LIFE_S):
    return np.power(0.5, (float(T_ref) - np.asarray(T0, float)) / half_life)


def m_by_segment(unit, seg, w, y, p0, n_units, nseg=NSEG):
    """Per segment s: m_s from the (unit, s) discounted sums. Returns (m array, info list)."""
    m = np.full(nseg, M_DEFAULT)
    info = []
    for s in range(nseg):
        sel = seg == s
        O = np.bincount(unit[sel], weights=(w * y)[sel], minlength=n_units)
        E = np.bincount(unit[sel], weights=(w * p0)[sel], minlength=n_units)
        ms, lls, n = select_m(O, E)
        m[s] = ms
        info.append({"m": ms, "n_units": n, "O_d": float(O.sum()), "E_d": float(E.sum()), "loglik": lls})
    return m, info


def theta_v4b(Od, Ed, m_row):
    return (np.asarray(Od, float) + m_row) / (np.asarray(Ed, float) + m_row)


def ship_rung_b4(flags, labels, bss_pop):
    """B4-8. flags[r] = {'pop', 'own'} (+ 'v2' for v4a/v4b: BSS vs v2 CI above 0). Returns (rung or None, eligible)."""
    elig = []
    if flags["v2"]["pop"] and flags["v2"]["own"]:
        elig.append("v2")
    for r in ("v4a", "v4b"):
        if flags[r]["v2"]:
            elig.append(r)
    any_beats = any(flags[r]["pop"] and flags[r]["own"] for r in RUNGS)
    if not any_beats or not elig:
        return None, elig
    best = None
    for r in RUNGS:
        if r not in elig:
            continue
        key = (LABEL_RANK[labels[r]], -np.inf if bss_pop[r] is None else bss_pop[r])
        if best is None or key > best[0]:
            best = (key, r)
    return best[1], elig


def b5_label_rule(label, per_reserve, pool):
    """B4.6 label rule. per_reserve {name: (n_ep, R)}; pool (n_ep, R). -> (final label, outcome)."""
    if label != "HIGH":
        return label, None
    bad = any(n >= B5_MIN_NEP_RESERVE and not _within(R, B5_R) for n, R in per_reserve.values())
    if pool[0] >= B5_MIN_NEP_RESERVE and not _within(pool[1], B5_R):
        bad = True
    if bad:
        return "MEDIUM", "failed transfer"
    if pool[0] < B5_MIN_NEP_RESERVE:
        return "MEDIUM", "unconfirmed"
    return "HIGH", "confirmed"


def b5_verdict(cells_R, rung, bss_lo):
    """B4.6 method verdict. cells_R: list of (n_ep, R_v2, R_rung) over the 24 h-7 d cells of c2, c3, w3 on the B-5
    pool; bss_lo: list of CI lower bounds of the rung's BSS vs v2 pooled over segments at 24 h, 48 h, 7 d."""
    use = [(a, b) for n, a, b in cells_R if n >= B5_VERDICT_NEP and a and b and math.isfinite(a) and math.isfinite(b)
           and a > 0 and b > 0]
    if not use:
        i_res = "not testable"
    else:
        med_r = float(np.median([abs(math.log(b)) for _, b in use]))
        med_2 = float(np.median([abs(math.log(a)) for a, _ in use]))
        i_res = med_r < med_2
    ii = bool(bss_lo) and all(v is not None and v > B5_VERDICT_BSS_LO for v in bss_lo)
    if i_res == "not testable":
        return {"rung": rung, "i": "not testable", "ii": ii, "verdict": "not testable", "n_cells_i": 0}
    return {"rung": rung, "i": bool(i_res), "ii": ii, "verdict": "pass" if (i_res and ii) else "fail",
            "n_cells_i": len(use), "median_abs_lnR_rung": med_r, "median_abs_lnR_v2": med_2}


def check_start_marker(path):
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists; the B-5 scoring phase runs once.")


def blind5_gate(out_dir, blind5_commit, frozen_sha256, datasets_dir, verify_git=True):
    """B4-14: every condition before any B-5 file is read. Returns the freeze record."""
    if not blind5_commit:
        raise SystemExit("STOP: --blind5-commit <membrane-datasets commit holding depositor-blind5/> is required.")
    if not frozen_sha256:
        raise SystemExit("STOP: --frozen-sha256 <sha256 of shipped-b4.json> is required.")
    sp = os.path.join(out_dir, "shipped-b4.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    if not (os.path.exists(sp) and os.path.exists(fr)):
        raise SystemExit("STOP: the frozen shipped-b4.json and freeze-record.json must exist first.")
    with open(fr) as fh:
        rec = json.load(fh)
    got = sha256_file(sp)
    if got != rec["shipped_b4_sha256"] or got != frozen_sha256.lower():
        raise SystemExit(f"STOP: shipped-b4.json sha256 {got} != freeze record {rec['shipped_b4_sha256']} / "
                         f"--frozen-sha256 {frozen_sha256}")
    if sha256_file(os.path.join(out_dir, "results-dev.json")) != rec["results_dev_sha256"]:
        raise SystemExit("STOP: results-dev.json changed after the freeze.")
    check_start_marker(os.path.join(out_dir, "blind5-started.json"))
    if verify_git:
        def git(*a):
            return subprocess.run(["git", "-C", datasets_dir, *a], capture_output=True, text=True)
        r = git("cat-file", "-e", f"{blind5_commit}^{{commit}}")
        if r.returncode != 0:
            raise SystemExit(f"STOP: {blind5_commit} is not a commit of {datasets_dir}")
        r = git("show", f"{blind5_commit}:{BLIND5_DIR}PROVENANCE.md")
        if r.returncode != 0:
            raise SystemExit(f"STOP: commit {blind5_commit} holds no {BLIND5_DIR}PROVENANCE.md")
        if r.stdout != open(os.path.join(datasets_dir, BLIND5_DIR, "PROVENANCE.md")).read():
            raise SystemExit("STOP: depositor-blind5/PROVENANCE.md differs from the named commit")
    return rec


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------
def verify_b3_run(datasets_dir):
    run = os.path.join(datasets_dir, B3_RUN)
    man = json.load(open(os.path.join(run, "manifest.json")))
    out = {B3_RUN + "manifest.json": sha256_file(os.path.join(run, "manifest.json"))}
    for fn in B3_RUN_FILES:
        got = sha256_file(os.path.join(run, fn))
        if man["files"][fn]["sha256"] != got:
            raise SystemExit(f"STOP: {B3_RUN}{fn} sha256 {got} != its manifest")
        out[B3_RUN + fn] = got
    return out


def verify_inputs(datasets_dir, holdouts=True):
    out = G.verify_inputs(datasets_dir, holdouts=holdouts)
    out.update(S.verify_cv(datasets_dir))
    out.update(verify_b3_run(datasets_dir))
    return out


def b3_holdout_codes(datasets_dir):
    d = json.load(open(os.path.join(datasets_dir, B3_RUN, "holdout-codes.json")))
    return {a: {"contract": v["is_contract"], "eip7702": v["eip7702"], "adapter": False} for a, v in d["codes"].items()}


# ---------------------------------------------------------------------------------------------
# Rows, segments, v4a features
# ---------------------------------------------------------------------------------------------
def anchor_matrix(res, D):
    """Global (n_units, D) float daily anchors in micro-units, NaN where invalid."""
    return np.concatenate([np.where(R.Av[:, :D], R.A[:, :D].astype(float), np.nan) for R in res], axis=0)


def xcell24(xk):
    return int(G.XCELL[2, XKEYS.index(xk)]) if xk != "all" else int(G.ACELL[2])


def v4a_features(rows, res, D):
    """F[xkey] = (n, 3) array: log1p(n_x90), maxdd90, log1p(days since). Labels must be in rows."""
    mdd = maxdd_rows(rows["unit"], rows["t"], anchor_matrix(res, D))
    F = {}
    info = {"maxdd90_mean": float(mdd.mean())}
    for xk in XKEYS:
        ci = xcell24(xk)
        flag = rows["RES"][:, 2] & (rows["Y"][:, ci] == 1)
        n, days = hist_counts(rows["unit"], rows["t"], flag, rows["n_units"], D)
        F[xk] = np.column_stack([np.log1p(n.astype(float)), mdd, np.log1p(days)])
    rows["F4"] = F
    return info


def x4_matrix(rows, xk):
    return np.column_stack([rows["X"][:, :KEEP_V2], rows["F4"][xk]])


def add_segments(rows, flags_main, flags_extra=None):
    cu, missing = S.unit_contract(rows, flags_main, flags_extra)
    if missing:
        raise SystemExit(f"STOP: {len(missing)} addresses without a holder flag")
    rows["contract_unit"] = cu
    rows["band"] = S.band_of(rows["bal"])
    rows["seg"] = S.segment_of(cu[rows["unit"]], rows["band"])


def build_main_b4(datasets_dir, labels=True, log=print):
    ctx, res = G.load_main(datasets_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=labels)
    add_segments(rows, S.load_flags(datasets_dir))
    if labels:
        v4a_features(rows, res, ctx.D)
    return ctx, res, rows


def build_holdouts_b4(datasets_dir, log=print):
    ctx, res = G.load_holdouts(datasets_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=True)
    add_segments(rows, S.load_flags(datasets_dir), b3_holdout_codes(datasets_dir))
    v4a_features(rows, res, ctx.D)
    return ctx, res, rows


# ---------------------------------------------------------------------------------------------
# Fits (one task = one fold x cell: v2, v4a and v4b)
# ---------------------------------------------------------------------------------------------
_G4 = {}


def _params(m):
    return {"params": m["params"], "const_p0": m["const_p0"]}


def fit_one(rows, X2, X4, tri, ci, T_ref, n_units):
    """The three rungs' fits on training rows tri of cell ci. Returns a dict of models and v4b pieces."""
    from scipy.special import expit
    y = rows["Y"][tri, ci].astype(float)
    u = rows["unit"][tri]
    m2 = G.fit_cell_model(X2[tri], y, u, n_units)                  # B3 v2, exactly
    m4 = G.fit_cell_model(X4[tri], y, u, n_units)                  # v4a (unit theta m = 3)
    p0 = expit(B.decision(m4["fit"], X4[tri])) if m4["fit"] is not None else np.full(len(y), m4["const_p0"])
    w = discount_weights(rows["T0"][tri], T_ref)
    Od = np.bincount(u, weights=w * y, minlength=n_units)
    Ed = np.bincount(u, weights=w * p0, minlength=n_units)
    mseg, minfo = m_by_segment(u, rows["seg"][tri], w, y, p0, n_units)
    cnt = np.bincount(rows["seg"][tri], minlength=NSEG)
    seg_pop = np.where(cnt > 0, np.bincount(rows["seg"][tri], weights=y, minlength=NSEG) / np.maximum(cnt, 1), np.nan)
    return {"m2": m2, "m4": m4, "Od": Od, "Ed": Ed, "mseg": mseg, "minfo": minfo, "seg_pop": seg_pop,
            "n_exits": int(y.sum())}


def predict_rungs(f, X2, X4, idx, unit, seg):
    p2, _ = G.predict_p(f["m2"]["params"], f["m2"]["const_p0"], X2[idx], f["m2"]["theta"][unit])
    p4a, _ = G.predict_p(f["m4"]["params"], f["m4"]["const_p0"], X4[idx], f["m4"]["theta"][unit])
    th = theta_v4b(f["Od"][unit], f["Ed"][unit], f["mseg"][seg])
    p4b, _ = G.predict_p(f["m4"]["params"], f["m4"]["const_p0"], X4[idx], th)
    return p2, p4a, p4b


def _fit_task(task):
    kind, fi, ci = task
    rows = _G4["rows"]
    c = G.CELLS[ci]
    hi = c["hi"]
    X2 = rows["X"]
    X4 = _G4["X4"][XKEYS[c["xi"]] if c["kind"] == "x" else "all"]
    if kind == "fold":
        Tqs = int(_G4["T"][_G4["folds"][fi][1]])
        tr = G.train_mask_cell(rows["T0"], G.HSEC[hi], Tqs, rows["RES"][:, hi], rows["CAP"][:, ci], rows["feat_ok"])
        T_ref = Tqs
    else:
        tr = rows["RES"][:, hi] & ~rows["CAP"][:, ci] & rows["feat_ok"]
        T_ref = _G4["asof_ts"]
    tri = np.nonzero(tr)[0]
    f = fit_one(rows, X2, X4, tri, ci, T_ref, rows["n_units"])
    m2, m4 = f["m2"], f["m4"]
    res = {"kind": kind, "fi": fi, "ci": ci,
           "v2": dict(_params(m2), pop=m2["pop"], seg_pop=f["seg_pop"].tolist(),
                      info=dict(m2["info"], n_train_exits=f["n_exits"], pop_rate=m2["pop"])),
           "v4a": dict(_params(m4), info=dict(m4["info"], n_train_exits=f["n_exits"])),
           "v4b": {"m_seg": f["mseg"].tolist(), "seg_info": f["minfo"], "T_ref": T_ref}}
    if kind == "fold":
        te = _G4["test_idx"][fi]
        u = rows["unit"][te]
        res["p"] = predict_rungs(f, X2, X4, te, u, rows["seg"][te])
        res["own"] = m2["own"][u]
        res["pop"] = m2["pop"]
    else:
        sel = _G4["panel_units"]
        res["panel"] = {"theta_v2": m2["theta"][sel].tolist(), "theta_v4a": m4["theta"][sel].tolist(),
                        "Od": f["Od"][sel].tolist(), "Ed": f["Ed"][sel].tolist()}
    return res


def run_fits(ctx, rows, tasks, panel_units, asof_ts, workers=3, log=print):
    import multiprocessing as mp
    _G4.clear()
    _G4.update(rows=rows, T=ctx.T, folds=ctx.folds, panel_units=panel_units, asof_ts=asof_ts,
               X4={xk: x4_matrix(rows, xk) for xk in XKEYS},
               test_idx=[np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0] for fi in range(len(ctx.folds))])
    out = []
    t0 = time.time()
    if workers <= 1:
        for i, tk in enumerate(tasks):
            out.append(_fit_task(tk))
    else:
        with mp.get_context("fork").Pool(workers) as pool:
            for i, r in enumerate(pool.imap_unordered(_fit_task, tasks, chunksize=1)):
                out.append(r)
                if (i + 1) % 30 == 0:
                    log(f"    {i + 1}/{len(tasks)} fits ({time.time() - t0:.0f} s)")
    return out, _G4["test_idx"]


def assemble(rows, fits, test_idx):
    n = len(rows["t"])
    PR = {k: np.full((n, G.NC), np.nan) for k in ("v2", "v4a", "v4b", "own", "pop")}
    params, finfo, mtab = {}, {}, {}
    for r in fits:
        fi, ci = r["fi"], r["ci"]
        te = test_idx[fi]
        PR["v2"][te, ci], PR["v4a"][te, ci], PR["v4b"][te, ci] = r["p"]
        PR["own"][te, ci] = r["own"]
        PR["pop"][te, ci] = r["pop"]
        cid = G.CELLS[ci]["id"]
        params.setdefault(fi, {})[cid] = {
            "v2": {k: r["v2"][k] for k in ("params", "const_p0", "pop", "seg_pop")},
            "v4a": {k: r["v4a"][k] for k in ("params", "const_p0")},
            "v4b": {"m_seg": r["v4b"]["m_seg"], "T_ref": r["v4b"]["T_ref"]}}
        finfo.setdefault(cid, {})[fi] = {"v2": r["v2"]["info"], "v4a": r["v4a"]["info"]}
        mtab.setdefault(cid, {})[fi] = r["v4b"]["seg_info"]
    return PR, params, finfo, mtab


# ---------------------------------------------------------------------------------------------
# Scoring per (cell, segment)
# ---------------------------------------------------------------------------------------------
COMP4 = (("v2_vs_pop", "v2", "pop"), ("v2_vs_own", "v2", "own"), ("v4a_vs_pop", "v4a", "pop"),
         ("v4a_vs_own", "v4a", "own"), ("v4a_vs_v2", "v4a", "v2"), ("v4b_vs_pop", "v4b", "pop"),
         ("v4b_vs_own", "v4b", "own"), ("v4b_vs_v2", "v4b", "v2"))
_EMPTY = {"bss": None, "ci95": None, "ci_above_0": False, "ci_below_0": False}


def bss_point(pa, pb, y):
    sb = float(np.sum((pb - y) ** 2))
    return float(1 - np.sum((pa - y) ** 2) / sb) if sb > 0 else None


def score_set(Q, pr, dd, cb, fold_names, reserve_names, rungs=RUNGS, comps=COMP4):
    y = Q["y"]
    nd = len(dd)
    pos = np.searchsorted(dd, Q["t"])
    out = {"n": {"rows": int(len(y)), "days": int(nd), "units": int(len(np.unique(Q["unit"]))), "exits": int(y.sum()),
                 "n_ep": G.n_episodes(Q["unit"], Q["t"], y)},
           "brier": {k: float(np.mean((pr[k] - y) ** 2)) if len(y) else None for k in pr}, "bss": {}, "g7": {}}
    for cname, a, b in comps:
        out["bss"][cname] = G.bss_ci(pos, nd, pr[a], pr[b], y, cb) if cb is not None else dict(
            _EMPTY, bss=bss_point(pr[a], pr[b], y))
    for r in rungs:
        if cb is None or len(y) == 0:
            out["g7"][r] = {"label": "LOW", "n_ep": out["n"]["n_ep"], "R": ratio_R(pr[r].sum(), y.sum()),
                            "R_ci95": None, "note": "fewer than 30 test days: no draw"}
        else:
            out["g7"][r] = G.g7_block(Q, pr[r], pos, nd, cb, fold_names, reserve_names)
    return out, pos


def flags_b4(Sx):
    f = {}
    for r in RUNGS:
        b = Sx["bss"]
        f[r] = {"pop": bool(b[f"{r}_vs_pop"]["ci_above_0"]), "own": bool(b[f"{r}_vs_own"]["ci_above_0"])}
        if r != "v2":
            f[r]["v2"] = bool(b[f"{r}_vs_v2"]["ci_above_0"])
    return f


def restricted(pos, nd, pr, y, keep, cb, comps=COMP4, rungs=RUNGS):
    return {"rows": int(keep.sum()), "exits": int(y[keep].sum()),
            "bss": {cname: (G.bss_ci(pos[keep], nd, pr[a][keep], pr[b][keep], y[keep], cb) if cb is not None
                            else dict(_EMPTY, bss=bss_point(pr[a][keep], pr[b][keep], y[keep])))
                    for cname, a, b in comps},
            "R": {r: ratio_R(pr[r][keep].sum(), y[keep].sum()) for r in rungs}}


def score_b4(ctx, rows, PR, log=print):
    fold_names = [f[0] for f in ctx.folds]
    rn = rows["reserve_names"]
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    rng = np.random.default_rng(SEED_B4)
    cells, pooled = {}, {}
    for ci, s in S.set_order():
        c = G.CELLS[ci]
        hi = c["hi"]
        m = test & rows["RES"][:, hi] & ~rows["CAP"][:, ci]
        if s is not None:
            m &= rows["seg"] == s
        idx = np.nonzero(m)[0]
        dd = np.unique(rows["t"][idx])
        nd = len(dd)
        cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
            if nd >= G.BLOCK_DAYS else None
        Q = {"y": rows["Y"][idx, ci].astype(float), "t": rows["t"][idx], "unit": rows["unit"][idx],
             "reserve": rows["reserve"][idx], "fold": rows["fold"][idx]}
        pr = {k: PR[k][idx, ci] for k in ("v2", "v4a", "v4b", "own", "pop")}
        if any(np.isnan(v).any() for v in pr.values()):
            raise SystemExit(f"STOP: missing prediction in {c['id']} segment {s}")
        Sx, pos = score_set(Q, pr, dd, cb, fold_names, rn)
        stress = stress_overlap(rows["T0"][idx], G.HSEC[hi])
        Sx["no_stress"] = restricted(pos, nd, pr, Q["y"], ~stress, cb)
        Sx["stress_rows"] = {"rows": int(stress.sum()), "exits": int(Q["y"][stress].sum())}
        if s is None:
            pooled[c["id"]] = Sx
            continue
        fl = flags_b4(Sx)
        labels = {r: Sx["g7"][r]["label"] for r in RUNGS}
        bss_pop = {r: Sx["bss"][f"{r}_vs_pop"]["bss"] for r in RUNGS}
        rung, elig = ship_rung_b4(fl, labels, bss_pop)
        Sx.update(flags=fl, eligible=elig, shipped=rung, label=labels[rung] if rung else "LOW",
                  display="model" if rung else "population-rate history")
        cells.setdefault(c["id"], {})[SEG_IDS[s]] = Sx
        log(f"  {c['id']} {SEG_IDS[s]}: rows {Sx['n']['rows']} n_ep {Sx['n']['n_ep']} -> {rung} {Sx['label']}")
    return cells, pooled


# ---------------------------------------------------------------------------------------------
# Frozen-model prediction on other reserves (holdouts, B-5): theta_i = 1
# ---------------------------------------------------------------------------------------------
def predict_frozen_b4(rows, fold_params, fi, idx):
    """Raw rung predictions (n_idx, NC) from the fold-fi models with theta_i = 1 (v4b = v4a)."""
    out = {r: np.full((len(idx), G.NC), np.nan) for r in RUNGS}
    th = np.ones(len(idx))
    for ci, c in enumerate(G.CELLS):
        fp = fold_params[str(fi)][c["id"]] if str(fi) in fold_params else fold_params[fi][c["id"]]
        X4 = x4_matrix_idx(rows, c, idx)
        out["v2"][:, ci], _ = G.predict_p(fp["v2"]["params"], fp["v2"]["const_p0"], rows["X"][idx], th)
        out["v4a"][:, ci], _ = G.predict_p(fp["v4a"]["params"], fp["v4a"]["const_p0"], X4, th)
        out["v4b"][:, ci] = out["v4a"][:, ci]
    return out


def x4_matrix_idx(rows, c, idx):
    xk = XKEYS[c["xi"]] if c["kind"] == "x" else "all"
    return np.column_stack([rows["X"][idx, :KEEP_V2], rows["F4"][xk][idx]])


def pick_shipped_b4(rows, idx, F, cells):
    n = len(idx)
    p = np.full((n, G.NC), np.nan)
    seg = rows["seg"][idx]
    for ci, c in enumerate(G.CELLS):
        for s in range(NSEG):
            sh = cells[c["id"]][SEG_IDS[s]]["shipped"]
            m = seg == s
            p[m, ci] = F[sh or "v2"][m, ci]
    return p


def holdout_check(hctx, hrows, fold_params, cells, log=print):
    """B4-9 per-reserve rule on DAI and USDe (GHO reported)."""
    fold_names = [f[0] for f in hctx.folds]
    rn = hrows["reserve_names"]
    n = len(hrows["t"])
    P = np.full((n, G.NC), np.nan)
    PRr = {r: np.full((n, G.NC), np.nan) for r in RUNGS}
    for fi in range(len(fold_names)):
        te = np.nonzero((hrows["fold"] == fi) & hrows["feat_ok"])[0]
        if not len(te):
            continue
        raw = predict_frozen_b4(hrows, fold_params, fi, te)
        Fx = {r: S.fix_grid(raw[r], hrows["CAP"][te]) for r in RUNGS}
        for r in RUNGS:
            PRr[r][te] = Fx[r]
        P[te] = pick_shipped_b4(hrows, te, Fx, cells)
    test = (hrows["fold"] >= 0) & hrows["feat_ok"]
    out, lab = {}, []
    for ci, c in enumerate(G.CELLS):
        for s in range(NSEG):
            cs = cells[c["id"]][SEG_IDS[s]]
            m = test & hrows["RES"][:, c["hi"]] & ~hrows["CAP"][:, ci] & (hrows["seg"] == s)
            stats = {}
            for name, mm in [(r, m & (hrows["reserve"] == ri)) for ri, r in enumerate(rn)] + \
                            [("pool_DAI_USDe", m & np.isin(hrows["reserve"], [rn.index(x) for x in HOLDOUT_RULE]))]:
                y = hrows["Y"][mm, ci].astype(float)
                stats[name] = {"rows": int(mm.sum()), "sum_y": int(y.sum()), "sum_p": float(P[mm, ci].sum()),
                               "R": ratio_R(P[mm, ci].sum(), y.sum()),
                               "n_ep": G.n_episodes(hrows["unit"][mm], hrows["t"][mm], y),
                               "R_by_rung": {r: ratio_R(PRr[r][mm, ci].sum(), y.sum()) for r in RUNGS}}
            final, outcome = S.holdout_rule(cs["label"], {r: (stats[r]["n_ep"], stats[r]["R"]) for r in HOLDOUT_RULE},
                                            (stats["pool_DAI_USDe"]["n_ep"], stats["pool_DAI_USDe"]["R"]))
            out.setdefault(c["id"], {})[SEG_IDS[s]] = {"shipped": cs["shipped"], "label_dev": cs["label"],
                                                       "stats": stats, "outcome": outcome, "label_final": final}
            lab.append((c["id"], SEG_IDS[s], final, outcome))
    return out


# ---------------------------------------------------------------------------------------------
# Panel preview (B4-10): asof features, rung grids, D1 display
# ---------------------------------------------------------------------------------------------
def hist_at(T, flag_days, t_ref, window=HIST_DAYS, cap=DAYS_CAP):
    """v4a counts at an arbitrary origin t_ref from flagged daily origins (day indices) with T + 24 h <= t_ref."""
    T = np.asarray(T, dtype=np.int64)
    fd = np.asarray(sorted(flag_days), dtype=np.int64)
    ok = fd[T[fd] + 86400 <= t_ref] if len(fd) else fd
    n = int(((T[ok] >= t_ref - window * 86400)).sum()) if len(ok) else 0
    days = min((t_ref - int(T[ok].max())) / 86400.0, cap) if len(ok) else cap
    return n, days


def maxdd_at(T, bal_days, valid, t_ref, bal_ref, window=HIST_DAYS):
    T = np.asarray(T, dtype=np.int64)
    m = (T >= t_ref - window * 86400) & (T <= t_ref) & np.asarray(valid, bool)
    W = np.r_[np.asarray(bal_days, float)[m], float(bal_ref)]
    return float(maxdd_matrix(W[None])[0])


def panel_preview(ctx, res, rows, live, rv7, asof_fits, cells, final_labels, g9_all, panel_sel):
    D = ctx.D
    ap = {G.CELLS[f["ci"]]["id"]: f for f in asof_fits}
    out, prow = {}, []
    pk = 0
    for ri, R in enumerate(res):
        units, bals, srcs = panel_sel[R.name]
        st, s24 = live["asof"]["state"][R.name], live["minus24h"]["state"][R.name]
        util, bapr = st["util"], st["bapr_pct"]
        cash, sup = int(st["cash"]), int(st["totalSupply"])
        t0b = G.first_big_day(R.A, R.Av, D)
        lst = []
        for k, u in enumerate(units):
            bal = int(bals[k])
            gu = rows["unit_base"][R.name] + u
            mlog = R.logs["unit"] == u
            f7, dc, ds = G.own_flow_at(R.logs["ts"][mlog], R.logs["delta_f"][mlog], R.logs["block"][mlog],
                                       S.LIVE_ASOF_TS, S.LIVE_ASOF_BLOCK)
            age = (S.LIVE_ASOF_TS - int(ctx.T[t0b[u]])) / G.DAY if t0b[u] >= 0 else 0.0
            x2 = [util, util - s24["util"], bapr, bapr - s24["bapr_pct"], rv7, math.log10(bal / G.MICRO),
                  math.log1p(age), R.is_usdt, math.log(cash / bal), bal / sup, f7 / bal, math.log1p(dc), math.log1p(ds)]
            ur = np.nonzero(rows["unit"] == gu)[0]
            mdd = maxdd_at(ctx.T, R.A[u, :D].astype(float), R.Av[u, :D], S.LIVE_ASOF_TS, bal)
            f4 = {}
            for xk in XKEYS:
                ci24 = xcell24(xk)
                fl = ur[rows["RES"][ur, 2] & (rows["Y"][ur, ci24] == 1)]
                n, days = hist_at(ctx.T, rows["t"][fl], S.LIVE_ASOF_TS)
                f4[xk] = [math.log1p(n), mdd, math.log1p(days)]
            cu = int(rows["contract_unit"][gu])
            band = int(S.band_of([bal])[0])
            seg = int(S.segment_of([cu], [band])[0])
            grid = {r: np.full(G.NC, np.nan) for r in RUNGS}
            for ci, c in enumerate(G.CELLS):
                f = ap[c["id"]]
                xk = XKEYS[c["xi"]] if c["kind"] == "x" else "all"
                x4 = np.array(x2[:KEEP_V2] + f4[xk], float)[None]
                pn = f["panel"]
                grid["v2"][ci] = G.predict_p(f["v2"]["params"], f["v2"]["const_p0"], np.array(x2, float)[None],
                                             np.array([pn["theta_v2"][pk + k]]))[0][0]
                grid["v4a"][ci] = G.predict_p(f["v4a"]["params"], f["v4a"]["const_p0"], x4,
                                              np.array([pn["theta_v4a"][pk + k]]))[0][0]
                th = theta_v4b(pn["Od"][pk + k], pn["Ed"][pk + k], f["v4b"]["m_seg"][seg])
                grid["v4b"][ci] = G.predict_p(f["v4a"]["params"], f["v4a"]["const_p0"], x4, np.array([th]))[0][0]
            capx = np.array([x * bal > 100 * cash for x in G.SIZES])
            for r in RUNGS:
                grid[r][G.XCELL] = G.monotone_fix_masked(grid[r][G.XCELL][None], capx[None])[0]
            comp = np.full(G.NC, np.nan)
            model = np.zeros(G.NC, bool)
            for ci, c in enumerate(G.CELLS):
                sh = cells[c["id"]][SEG_IDS[seg]]["shipped"]
                if sh:
                    comp[ci], model[ci] = grid[sh][ci], True
                else:
                    comp[ci] = ap[c["id"]]["v2"]["seg_pop"][seg]
            comp[G.XCELL] = D1.d1_fix(comp[G.XCELL], model[G.XCELL], capx)
            hist = {rec["cell"]: rec for rec in g9_all.get(f"{R.name}:{R.addrs[u]}", []) if rec["type"] == "all"}
            cv = {}
            for ci, c in enumerate(G.CELLS):
                cp = c["kind"] == "x" and bool(capx[c["xi"]])
                h = hist.get(c["id"])
                lab = final_labels[c["id"]][SEG_IDS[seg]]
                sh = cells[c["id"]][SEG_IDS[seg]]["shipped"]
                cv[c["id"]] = {"p": None if cp else float(comp[ci]), "capped": cp, "label": lab, "rung": sh,
                               "capped_text": f"capped now: cash covers at most {100 * cash / bal:.1f}% of this balance"
                               if cp else None,
                               "display": "model" if sh else "population-rate history",
                               "history": G.g9_statement(c, h) if h else None,
                               "rung_values": {r: None if cp else float(grid[r][ci]) for r in RUNGS}}
                prow.append([R.name, k + 1, S.trunc(R.addrs[u]), SEG_IDS[seg], bal / G.MICRO, c["id"],
                             c["x"] if c["x"] else "all", c["h"], "capped" if cp else G.fmt(float(comp[ci])),
                             cv[c["id"]]["capped_text"] or "", lab, sh or "", cv[c["id"]]["display"],
                             cv[c["id"]]["history"] if (lab != "HIGH" or c["kind"] == "all") and h else ""])
            lst.append({"rank": k + 1, "address": S.to_checksum(R.addrs[u]), "address_short": S.trunc(R.addrs[u]),
                        "unit": int(gu), "balance_usd": bal / G.MICRO, "balance_source": srcs[k],
                        "segment": SEG_IDS[seg], "features_v2": dict(zip(G.FEATURES_V2, x2)),
                        "features_v4a": {xk: dict(zip(FEATURES_V4A[KEEP_V2:], f4[xk])) for xk in XKEYS}, "cells": cv})
        pk += len(units)
        out[R.name] = lst
    return out, prow


# ---------------------------------------------------------------------------------------------
# Borrow events (B4-3)
# ---------------------------------------------------------------------------------------------
BORROW_COLS = ["block", "ts", "tx_hash", "log_index", "reserve", "user", "onBehalfOf", "amount_raw",
               "interestRateMode", "referralCode"]


def decode_borrow(topics, data):
    import g_acquire_events as GA
    if len(topics) != 4 or topics[0].lower() != GA.topic0(BORROW_SIG):
        raise ValueError("not a Borrow log")
    d = data[2:]
    if len(d) != 64 * 4:
        raise ValueError(f"Borrow data length {len(d)}")
    w = [int(d[64 * i:64 * i + 64], 16) for i in range(4)]
    return {"reserve": GA.topic_address(topics[1]), "onBehalfOf": GA.topic_address(topics[2]),
            "referralCode": int(topics[3], 16), "user": "0x" + d[24:64].lower(), "amount_raw": w[1],
            "interestRateMode": w[2]}


def phase_borrows(datasets_dir, borrow_dir, log=print):
    import g_acquire_events as GA
    from pathlib import Path
    os.makedirs(borrow_dir, exist_ok=True)
    work = Path(borrow_dir) / "work"
    work.mkdir(exist_ok=True)
    blocks = {r["snapshot"]: int(r["block"]) for r in csv.DictReader(open(os.path.join(datasets_dir, G.DB,
                                                                                         "blocks.csv")))}
    start, end = blocks[BORROW_FROM_SNAPSHOT] + 1, BORROW_TO_BLOCK
    t0 = GA.topic0(BORROW_SIG)

    def post(payload):
        obj = json.loads(payload)
        obj["params"][0]["topics"] = [t0]
        return GA.http_post(GA.LOGS_RPC_URL, json.dumps(obj).encode())

    events = work / "events.jsonl"

    def log_event(ev):
        with open(events, "a") as f:
            f.write(json.dumps(dict(ev, utc=GA.utcnow()), default=str) + "\n")

    client = GA.LogsClient(post=post, log_event=log_event)
    store = GA.LogStore(work / "logs")
    t_start = GA.utcnow()
    last = [0.0]

    def prog(reserve, hi):
        if time.time() - last[0] > 30:
            last[0] = time.time()
            log(f"  borrows at block {hi} ({(hi - start) / (end - start):.1%}) req {client.counts['requests']} "
                f"logs {client.counts['logs']} splits {client.counts['splits']}")
    GA.fetch_logs(store, client, "Borrow", CORE_POOL, start, end, on_progress=prog)
    rows, bad = [], 0
    for lg in store.iter_reserve("Borrow"):
        try:
            d = decode_borrow(lg["topics"], lg["data"])
        except ValueError:
            bad += 1
            continue
        if lg["ts"] is None:
            raise SystemExit("STOP: a Borrow log without blockTimestamp")
        rows.append([lg["block"], lg["ts"], lg["tx"], lg["log_index"], d["reserve"], d["user"], d["onBehalfOf"],
                     d["amount_raw"], d["interestRateMode"], d["referralCode"]])
    rows.sort(key=lambda r: (r[0], r[3]))
    out = Path(borrow_dir)
    names = GA.write_partitioned(out, "borrow-events-core", BORROW_COLS, lambda: iter(rows), lambda r: r[1])
    man = {"files": {n: {"bytes": (out / n).stat().st_size, "sha256": sha256_file(out / n)} for n in names},
           "pool": CORE_POOL, "signature": BORROW_SIG, "topic0": t0, "from_block": start, "to_block": end,
           "rpc": GA.LOGS_RPC_URL, "n_events": len(rows), "n_undecodable": bad, "counts": client.counts,
           "fetch_window_utc": [t_start, GA.utcnow()], "decision": DECISIONS[2], "code": code_meta()}
    write_json(os.path.join(borrow_dir, "borrow-manifest.json"), man)
    log(f"borrows: {len(rows)} events -> {names}")
    return man


def load_borrows(borrow_dir):
    import pandas as pd
    man = json.load(open(os.path.join(borrow_dir, "borrow-manifest.json")))
    parts = []
    shas = {}
    for n, v in sorted(man["files"].items()):
        p = os.path.join(borrow_dir, n)
        got = sha256_file(p)
        if got != v["sha256"]:
            raise SystemExit(f"STOP: {n} sha256 {got} != borrow-manifest")
        shas[n] = got
        parts.append(pd.read_csv(p, usecols=["ts", "onBehalfOf"], dtype={"ts": np.int64, "onBehalfOf": str}))
    df = pd.concat(parts, ignore_index=True)
    by = {}
    for a, g in df.groupby(df["onBehalfOf"].str.lower()):
        by[a] = np.sort(g["ts"].to_numpy(np.int64))
    shas["borrow-manifest.json"] = sha256_file(os.path.join(borrow_dir, "borrow-manifest.json"))
    return by, shas, man


# ---------------------------------------------------------------------------------------------
# B4.0 audit
# ---------------------------------------------------------------------------------------------
def phase_audit(datasets_dir, out_dir, borrow_dir, log=print):
    import pandas as pd
    ap = os.path.join(out_dir, "audit-b4.json")
    if os.path.exists(ap):
        raise SystemExit(f"STOP: {ap} exists (the audit runs once).")
    t_start = time.time()
    shas = verify_inputs(datasets_dir, holdouts=False)
    borrows, bshas, bman = load_borrows(borrow_dir)
    ctx, res = G.load_main(datasets_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=False)
    run = os.path.join(datasets_dir, B3_RUN)
    shipped = json.load(open(os.path.join(run, "shipped-b3.json")))["cells"]
    units = pd.read_csv(os.path.join(run, "units.csv"), dtype=str)
    if len(units) != rows["n_units"] or not all(a.lower() == b for a, b in zip(units["address"], rows["unit_addr"])):
        raise SystemExit("STOP: B3 units.csv differs from the rebuilt unit list")
    bkeys = borrow_index(borrows, rows["unit_addr"])
    key = rows["unit"].astype(np.int64) * 10_000 + rows["t"]
    order = np.argsort(key)
    cmat = np.stack([R.state["cash"][:ctx.D] for R in res])
    day_index = ctx.day_index
    cells, pooled, tables = {}, {}, []
    for hi, h in enumerate(G.HNAMES):
        hsec = G.HSEC[hi]
        df = pd.concat([pd.read_csv(os.path.join(run, f"predictions-test-{h}-{r}.csv.gz")) for r in G.MAIN_RESERVES],
                       ignore_index=True)
        u = df["unit"].to_numpy(np.int64)
        t = df["date"].map(day_index).to_numpy(np.int64)
        k = u * 10_000 + t
        pos = np.searchsorted(key[order], k)
        if (pos >= len(order)).any() or (key[order][np.minimum(pos, len(order) - 1)] != k).any():
            raise SystemExit(f"STOP: B3 prediction rows not in the rebuilt rows ({h})")
        ri = order[pos]
        T0 = rows["T0"][ri]
        bal = rows["bal"][ri]
        rix = rows["reserve"][ri].astype(np.int64)
        stress = stress_overlap(T0, hsec)
        bexit = borrow_flags(u, T0, hsec, bkeys)
        seg = df["segment"].to_numpy()
        for c in [G.CELLS[int(x)] for x in list(G.XCELL[hi]) + [int(G.ACELL[hi])]]:
            cid = c["id"]
            y = df[f"y_{cid}"].to_numpy(float)
            ok = np.isfinite(y)
            if c["kind"] == "x":
                ok &= df[f"cap_{cid}"].to_numpy() == 0
            cblk = cash_blocked_flags(t, bal, rows["cash"][ri], (cmat, rix), hsec, c["x"] if c["kind"] == "x" else None)
            pv2 = df[f"v2_{cid}"].to_numpy(float)
            for sname in list(SEG_IDS) + [None]:
                m = ok & ((seg == sname) if sname else True)
                if sname:
                    sh = shipped[cid][sname]["shipped"]
                else:
                    sh = None
                if sname:
                    psh = df[f"{sh}_{cid}"].to_numpy(float) if sh else df[f"pop_{cid}"].to_numpy(float)
                else:
                    psh = np.full(len(df), np.nan)
                    for s2 in SEG_IDS:
                        r2 = shipped[cid][s2]["shipped"]
                        mm = seg == s2
                        psh[mm] = df[f"{r2}_{cid}"].to_numpy(float)[mm] if r2 else df[f"pop_{cid}"].to_numpy(float)[mm]
                if np.isnan(psh[m]).any() or np.isnan(pv2[m]).any():
                    raise SystemExit(f"STOP: missing B3 prediction {cid} {sname}")
                yy = y[m]

                def rr(p, mask):
                    return ratio_R(p[m][mask].sum(), yy[mask].sum())
                st_m = stress[m]
                rec = {"shown": sh or ("pop" if sname else "shipped per segment"), "rows": int(m.sum()),
                       "exits": int(yy.sum()), "n_ep": G.n_episodes(u[m], t[m], yy),
                       "R_shown": rr(psh, np.ones(len(yy), bool)), "R_shown_no_stress": rr(psh, ~st_m),
                       "R_v2": rr(pv2, np.ones(len(yy), bool)), "R_v2_no_stress": rr(pv2, ~st_m),
                       "stress_rows": int(st_m.sum()), "stress_exits": int(yy[st_m].sum()),
                       "R_shown_stress_rows": rr(psh, st_m)}
                for tag, fl in (("cash_blocked", cblk[m]), ("borrow_exit", bexit[m])):
                    rec[tag] = {"rows": int(fl.sum()), "exits": int(yy[fl].sum()),
                                "sum_p_shown": float(psh[m][fl].sum()), "R_shown_tagged": rr(psh, fl),
                                "R_shown_untagged": rr(psh, ~fl), "in_stress_rows": int((fl & st_m).sum())}
                if sname:
                    cells.setdefault(cid, {})[sname] = rec
                else:
                    pooled[cid] = rec
                tables.append([cid, sname or "pooled", rec["shown"], rec["rows"], rec["exits"], rec["n_ep"],
                               rec["R_shown"], rec["R_shown_no_stress"], rec["R_v2"], rec["R_v2_no_stress"],
                               rec["stress_rows"], rec["stress_exits"], rec["cash_blocked"]["rows"],
                               rec["cash_blocked"]["exits"], rec["borrow_exit"]["rows"], rec["borrow_exit"]["exits"]])
        log(f"  audit {h} done")
    stated = {}
    for c in G.CELLS:
        if c["h"] != "7d":
            continue
        r = cells[c["id"]]["w1"]
        stated[c["id"]] = {"R_shown": r["R_shown"], "R_shown_no_stress": r["R_shown_no_stress"],
                           "R_v2_no_stress": r["R_v2_no_stress"],
                           "within_0.8_1.25": _within(r["R_shown_no_stress"], STATED_R)}
    G.write_csv(os.path.join(out_dir, "audit-b4-cells.csv"),
                ["cell", "segment", "shown", "rows", "exits", "n_ep", "R_shown", "R_shown_no_stress", "R_v2",
                 "R_v2_no_stress", "stress_rows", "stress_exits", "cash_blocked_rows", "cash_blocked_exits",
                 "borrow_exit_rows", "borrow_exit_exits"], tables)
    out = {"phase": "audit", "prereg": PREREG, "section": "B4.0", "inputs_sha256": shas, "borrow_files_sha256": bshas,
           "borrow_manifest": {k: bman[k] for k in ("pool", "signature", "from_block", "to_block", "n_events", "rpc",
                                                    "fetch_window_utc")},
           "code": code_meta(), "decisions": DECISIONS[:4], "stress_window_utc": ["2026-04-18T00:00Z",
                                                                                  "2026-04-25T00:00Z"],
           "stated_test": {"rule": "if the April run causes the 7 d under-forecast, 7 d R without the stress rows lies "
                                   "within [0.8, 1.25] for wallets $1-10M (reported either way)", "w1_7d": stated},
           "cells": cells, "pooled": pooled, "runtime_s": time.time() - t_start,
           "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(ap, out, refuse_overwrite=True)
    log(f"audit: {ap}")
    return out


# ---------------------------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------------------------
def phase_dryrun(datasets_dir, out_dir, log=print):
    t0 = time.time()
    shas = verify_inputs(datasets_dir)
    ctx, res, rows = build_main_b4(datasets_dir, labels=False, log=log)
    out = {"phase": "dryrun", "prereg": PREREG, "inputs_sha256": shas, "code": code_meta(),
           "note": "rows and segments only; no exit count, rate, feature built from labels, or score"}
    ok = rows["feat_ok"]
    out["rows_kept"] = int(ok.sum())
    out["test_rows_by_segment"] = {SEG_IDS[s]: int((ok & (rows["fold"] >= 0) & (rows["seg"] == s)).sum())
                                   for s in range(NSEG)}
    out["per_fold_test_rows"] = {f[0]: {SEG_IDS[s]: int((ok & (rows["fold"] == fi) & (rows["seg"] == s)).sum())
                                        for s in range(NSEG)} for fi, f in enumerate(ctx.folds)}
    out["runtime_s"] = time.time() - t0
    write_json(os.path.join(out_dir, "dryrun.json"), out)
    log(f"dryrun: {out['rows_kept']} rows; {out['test_rows_by_segment']}")
    return out


def v2_check(datasets_dir, pooled):
    r3 = json.load(open(os.path.join(datasets_dir, B3_RUN, "results.json")))["pooled"]
    out = {}
    for cid, Sx in pooled.items():
        out[cid] = {"b4_v2": Sx["brier"]["v2"], "b3_v2": r3[cid]["brier"]["v2"], "rows_b4": Sx["n"]["rows"],
                    "rows_b3": r3[cid]["n"]["rows"],
                    "equal": Sx["brier"]["v2"] == r3[cid]["brier"]["v2"] and Sx["n"]["rows"] == r3[cid]["n"]["rows"]}
    return {"cells": out, "all_equal": all(v["equal"] for v in out.values())}


def write_predictions(out_dir, ctx, rows, PR, prefix="predictions-dev", max_bytes=45_000_000):
    import pandas as pd
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    fold_names = np.array([f[0] for f in ctx.folds])
    days = np.array(ctx.days)
    written = []
    for hi, h in enumerate(G.HNAMES):
        cis = list(G.XCELL[hi]) + [int(G.ACELL[hi])]
        m = np.nonzero(test & rows["RES"][:, hi])[0]
        m = m[np.lexsort((rows["t"][m], rows["unit"][m]))]
        for ri, r in enumerate(rows["reserve_names"]):
            idx = m[rows["reserve"][m] == ri]
            cols = {"unit": rows["unit"][idx], "date": days[rows["t"][idx]], "fold": fold_names[rows["fold"][idx]],
                    "segment": np.array(SEG_IDS)[rows["seg"][idx]],
                    "stress": stress_overlap(rows["T0"][idx], G.HSEC[hi]).astype(np.int8)}
            for c in cis[:G.NX]:
                cols[f"cap_{G.CELLS[c]['id']}"] = rows["CAP"][idx, c].astype(np.int8)
            for c in cis:
                cols[f"y_{G.CELLS[c]['id']}"] = rows["Y"][idx, c]
            for k in ("v2", "v4a", "v4b", "own", "pop"):
                for c in cis:
                    v = PR[k][idx, c].copy()
                    if c in cis[:G.NX]:
                        v[rows["CAP"][idx, c]] = np.nan
                    cols[f"{k}_{G.CELLS[c]['id']}"] = v
            p = os.path.join(out_dir, f"{prefix}-{h}-{r}.csv.gz")
            pd.DataFrame(cols).to_csv(p, index=False, float_format="%.6g",
                                      compression={"method": "gzip", "compresslevel": 9})
            if os.path.getsize(p) > max_bytes:
                raise SystemExit(f"STOP: {p} > {max_bytes} bytes")
            written.append(p)
    return written


def label_counts(cells, key):
    return {s: G._count([cells[c["id"]][s][key] for c in G.CELLS]) for s in SEG_IDS}


def phase_run(datasets_dir, out_dir, workers=3, log=print):
    rp = os.path.join(out_dir, "results-dev.json")
    if os.path.exists(rp):
        raise SystemExit(f"STOP: {rp} exists; the development phase runs once and never overwrites.")
    if not os.path.exists(os.path.join(out_dir, "dryrun.json")):
        raise SystemExit("STOP: dryrun.json missing; run --phase dryrun first.")
    t_start = time.time()
    shas = verify_inputs(datasets_dir)
    live = json.load(open(os.path.join(datasets_dir, B3_RUN, "live-inputs.json")))
    ctx, res, rows = build_main_b4(datasets_dir, labels=True, log=log)
    ua, ans, rsha = S.load_rounds(datasets_dir)
    H0 = S.LIVE_ASOF_TS - S.LIVE_ASOF_TS % 3600
    rv7, closes = S.rv7_from_rounds(ua[ua <= S.LIVE_ASOF_TS], ans[ua <= S.LIVE_ASOF_TS], H0)
    panel_sel = {}
    for R in res:
        bal, src, _ = S.live_balances(datasets_dir, R)
        order = sorted(range(R.n), key=lambda i: (-int(bal[i]), R.addrs[i]))[:10]
        panel_sel[R.name] = (order, [int(bal[i]) for i in order], [src[i] for i in order])
    panel_units = np.array([rows["unit_base"][r] + u for r in G.MAIN_RESERVES for u in panel_sel[r][0]],
                           dtype=np.int64)
    tasks = [("fold", fi, ci) for fi in range(len(ctx.folds)) for ci in range(G.NC)]
    tasks += [("asof", -1, ci) for ci in range(G.NC)]
    log(f"fits: {len(tasks)} tasks (v2 + v4a fits each) with {workers} workers ...")
    fits, test_idx = run_fits(ctx, rows, tasks, panel_units, S.LIVE_ASOF_TS, workers=workers, log=log)
    ff = [f for f in fits if f["kind"] == "fold"]
    af = sorted([f for f in fits if f["kind"] == "asof"], key=lambda f: f["ci"])
    PR, fparams, finfo, mtab = assemble(rows, ff, test_idx)
    PR = G.apply_fix(PR, rows, versions=RUNGS)
    log("scoring ...")
    cells, pooled = score_b4(ctx, rows, PR, log)
    v2c = v2_check(datasets_dir, pooled)
    log(f"v2 equals B3 pooled Brier in every cell: {v2c['all_equal']}")
    log("holdout per-reserve rule (DAI, USDe; GHO reported) ...")
    hctx, hres, hrows = build_holdouts_b4(datasets_dir, log)
    hold = holdout_check(hctx, hrows, fparams, cells, log)
    final = {cid: {s: hold[cid][s]["label_final"] for s in SEG_IDS} for cid in hold}
    for cid in cells:
        for s in SEG_IDS:
            cells[cid][s]["label_final"] = final[cid][s]
            cells[cid][s]["holdout_outcome"] = hold[cid][s]["outcome"]
    # B3 comparison of labels
    b3lab = {}
    with open(os.path.join(datasets_dir, B3_RUN, "labels.csv")) as f:
        for r in csv.DictReader(f):
            b3lab[(r["cell"], r["segment"])] = (r["shipped"], r["label_final"])
    # history + panel preview
    log("panel preview ...")
    panel, prow, panel_error = None, [], None
    try:                                  # reported only (B4-10): a failure here never stops the scored run
        order = np.argsort(rows["unit"], kind="mergesort")
        us, st_ = np.unique(rows["unit"][order], return_index=True)
        rowmap = {int(u): order[st_[k]:(st_[k + 1] if k + 1 < len(st_) else len(order))] for k, u in enumerate(us)}
        g9 = {}
        for R in res:
            eps, in_ep, _ = G.episodes_by_reserve(ctx, R)
            for u in panel_sel[R.name][0]:
                g9[f"{R.name}:{R.addrs[u]}"] = G.g9_unit(ctx, rows, rowmap, rows["unit_base"][R.name] + u, eps, in_ep)
        panel, prow = panel_preview(ctx, res, rows, live, rv7, af, cells, final, g9, panel_sel)
    except Exception:
        import traceback
        panel_error = traceback.format_exc()
        log("panel preview FAILED (reported, run continues):\n" + panel_error)
    log("writing ...")
    pred = write_predictions(out_dir, ctx, rows, PR)
    G.write_csv(os.path.join(out_dir, "panel-preview.csv"),
                ["reserve", "rank", "address_short", "segment", "balance_usd", "cell", "size", "horizon", "number",
                 "capped_text", "label", "rung", "display", "history"], prow)
    lab = []
    for c in G.CELLS:
        for s in SEG_IDS:
            Sx = cells[c["id"]][s]
            sh = Sx["shipped"]
            lab.append([c["id"], s, sh or "", Sx["label"], Sx["holdout_outcome"] or "", Sx["label_final"],
                        Sx["n"]["rows"], Sx["n"]["n_ep"], Sx["g7"][sh]["R"] if sh else None,
                        Sx["bss"]["v2_vs_pop"]["bss"], Sx["bss"]["v4a_vs_v2"]["bss"], Sx["bss"]["v4b_vs_v2"]["bss"],
                        b3lab[(c["id"], s)][0], b3lab[(c["id"], s)][1]])
    G.write_csv(os.path.join(out_dir, "labels-dev.csv"),
                ["cell", "segment", "shipped", "label_dev", "holdout_outcome", "label_final", "rows", "n_ep",
                 "R_shipped", "bss_v2_vs_pop", "bss_v4a_vs_v2", "bss_v4b_vs_v2", "b3_shipped", "b3_label_final"], lab)
    m_table = {cid: {fi: [{"segment": SEG_IDS[s], **mtab[cid][fi][s]} for s in range(NSEG)]
                     for fi in mtab[cid]} for cid in mtab}
    c3R = {c["id"]: {r: cells[c["id"]]["c3"]["g7"][r]["R"] for r in RUNGS} | {"n_ep": cells[c["id"]]["c3"]["n"]["n_ep"]}
           for c in G.CELLS}
    summary = {
        "phase": "run (development)", "prereg": PREREG, "datasets": DATASETS, "inputs_sha256": shas,
        "rounds_sha256": rsha, "dryrun_sha256": sha256_file(os.path.join(out_dir, "dryrun.json")),
        "code": code_meta(), "decisions": DECISIONS, "deviations": DEVIATIONS,
        "features": {"v2": G.FEATURES_V2, "v4a": FEATURES_V4A, "v4b": "v4a + estimated frailty (B4-6)"},
        "segments": dict(zip(SEG_IDS, SEG_NAMES)), "cells": cells, "pooled": pooled, "holdout": hold,
        "label_counts": {"dev": label_counts(cells, "label"), "final": label_counts(cells, "label_final")},
        "shipped_counts": {s: G._count([cells[c["id"]][s]["shipped"] or "pop" for c in G.CELLS]) for s in SEG_IDS},
        "b3_label_counts_final": {s: G._count([b3lab[(c["id"], s)][1] for c in G.CELLS]) for s in SEG_IDS},
        "v2_equals_b3_check": v2c, "m_seg_table": m_table, "contract_ge_50m_R": c3R,
        "fold_params": fparams, "fold_fits": finfo,
        "asof_params": {G.CELLS[f["ci"]]["id"]: {k: f[k] for k in ("v2", "v4a", "v4b")} for f in af},
        "panel_preview": panel, "panel_preview_error": panel_error, "panel_inputs": {"rv7": rv7, "H0": H0, "live": {k: live[k] for k in ("asof", "minus24h")}},
        "prediction_files": [os.path.basename(p) for p in pred],
        "single_class_fits": sum(int(f["v2"]["info"]["single_class"]) + int(f["v4a"]["info"]["single_class"])
                                 for f in fits),
        "convergence_warnings": sum(int(f["v2"]["info"].get("n_convergence_warnings", 0)) +
                                    int(f["v4a"]["info"].get("n_convergence_warnings", 0)) for f in fits),
        "runtime_s": time.time() - t_start, "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(rp, summary, refuse_overwrite=True)
    log(f"run: {rp} ({summary['runtime_s']:.0f} s)")
    return summary


def phase_freeze(out_dir, log=print):
    rp = os.path.join(out_dir, "results-dev.json")
    sp = os.path.join(out_dir, "shipped-b4.json")
    fr = os.path.join(out_dir, "freeze-record.json")
    if not os.path.exists(rp):
        raise SystemExit("STOP: no results-dev.json.")
    if os.path.exists(sp) or os.path.exists(fr):
        raise SystemExit("STOP: the freeze runs once.")
    res = json.load(open(rp))
    cells = {cid: {s: {"shipped": v["shipped"], "label_dev": v["label"], "label_final": v["label_final"],
                       "holdout_outcome": v["holdout_outcome"], "eligible": v["eligible"],
                       "labels_by_rung": {r: v["g7"][r]["label"] for r in RUNGS},
                       "dev_R_by_rung": {r: v["g7"][r]["R"] for r in RUNGS}, "dev_n_ep": v["n"]["n_ep"]}
                   for s, v in d.items()} for cid, d in res["cells"].items()}
    frozen = {"results_dev_sha256": sha256_file(rp), "prereg": PREREG, "features": res["features"], "cells": cells,
              "fold_params": res["fold_params"], "asof_params": res["asof_params"],
              "folds": [f[0] for f in B.fold_list()], "segments": res["segments"], "decisions": DECISIONS,
              "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta()}
    write_json(sp, frozen, refuse_overwrite=True)
    rec = {"shipped_b4_sha256": sha256_file(sp), "results_dev_sha256": frozen["results_dev_sha256"],
           "frozen_utc": frozen["frozen_utc"]}
    write_json(fr, rec, refuse_overwrite=True)
    log(f"freeze: shipped-b4.json sha256 {rec['shipped_b4_sha256']}")
    return rec


# ---------------------------------------------------------------------------------------------
# B4.6 blind set B-5 (implemented; run only by the parent after the freeze is published)
# ---------------------------------------------------------------------------------------------
def blind5_reserves(datasets_dir):
    d = os.path.join(datasets_dir, BLIND5_DIR)
    out = []
    with open(os.path.join(d, "unit-counts.csv")) as f:
        for r in csv.DictReader(f):
            if r["selected_b5"] == "True":
                out.append({"name": r["name"], "decimals": int(r["decimals"])})
    return out


def blind5_spec(datasets_dir, name, decimals):
    d = os.path.join(datasets_dir, BLIND5_DIR, name)
    lo = name.lower()
    evs = sorted(os.path.join(d, f) for f in os.listdir(d) if re.fullmatch(rf"events-{re.escape(lo)}-[0-9a-z-]+\.csv\.gz",
                                                                             f))
    return {"name": name, "decimals": decimals, "is_usdt": 0.0,
            "anchors": [os.path.join(d, f"daily-balances-{lo}.csv.gz")],
            "universe": os.path.join(d, "extended-universe.csv"), "events": evs,
            "state": os.path.join(d, "reserve-state.csv")}


def load_blind5(datasets_dir, log=print):
    """G.load_reserve on the B-5 layout (reserve_spec replaced for the duration of the load)."""
    specs = {r["name"]: blind5_spec(datasets_dir, r["name"], r["decimals"]) for r in blind5_reserves(datasets_dir)}
    ctx = G.load_ctx(datasets_dir)
    orig = G.reserve_spec
    G.reserve_spec = lambda dd, name: specs[name]
    try:
        res = [G.load_reserve(ctx, datasets_dir, n, log) for n in specs]
    finally:
        G.reserve_spec = orig
    flags = {}
    for n in specs:
        with open(os.path.join(datasets_dir, BLIND5_DIR, n, "holder-codes.csv")) as f:
            for r in csv.DictReader(f):
                flags[r["address"].lower()] = {"contract": r["is_contract"] == "1",
                                               "eip7702": r["eip7702_delegated"] == "1", "adapter": False}
    return ctx, res, flags


def verify_blind5(datasets_dir):
    d = os.path.join(datasets_dir, BLIND5_DIR)
    txt = open(os.path.join(d, "PROVENANCE.md")).read()
    table = dict(re.findall(r"\|\s*`([^`]+)`\s*\|\s*\d+\s*\|\s*`([0-9a-f]{64})`\s*\|", txt))
    out = {BLIND5_DIR + "PROVENANCE.md": sha256_file(os.path.join(d, "PROVENANCE.md"))}
    for fn, want in sorted(table.items()):
        if "raw-logs" in fn or "block-timestamps" in fn:
            continue
        got = sha256_file(os.path.join(d, fn))
        if got != want:
            raise SystemExit(f"STOP: {BLIND5_DIR}{fn} sha256 {got} != PROVENANCE")
        out[BLIND5_DIR + fn] = got
    return out


def phase_blind5(datasets_dir, out_dir, blind5_commit, frozen_sha256, log=print):
    rec = blind5_gate(out_dir, blind5_commit, frozen_sha256, datasets_dir)
    marker = os.path.join(out_dir, "blind5-started.json")
    write_json(marker, {"started_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "blind5_commit": blind5_commit, "frozen_sha256": rec["shipped_b4_sha256"],
                        "code": code_meta()}, refuse_overwrite=True)
    t0 = time.time()
    frozen = json.load(open(os.path.join(out_dir, "shipped-b4.json")))
    shas = G.verify_inputs(datasets_dir, holdouts=False)            # snapshot blocks, ETH prices (load_ctx)
    shas.update(verify_blind5(datasets_dir))
    ctx, res, flags = load_blind5(datasets_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=True)
    add_segments(rows, flags)
    v4a_features(rows, res, ctx.D)
    fp = frozen["fold_params"]
    cells_f = frozen["cells"]
    fold_names = [f[0] for f in ctx.folds]
    rn = rows["reserve_names"]
    n = len(rows["t"])
    PRr = {k: np.full((n, G.NC), np.nan) for k in RUNGS + ("pop",)}
    P = np.full((n, G.NC), np.nan)
    for fi in range(len(fold_names)):
        te = np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0]
        if not len(te):
            continue
        raw = predict_frozen_b4(rows, fp, fi, te)
        Fx = {r: S.fix_grid(raw[r], rows["CAP"][te]) for r in RUNGS}
        for r in RUNGS:
            PRr[r][te] = Fx[r]
        P[te] = pick_shipped_b4(rows, te, Fx, {cid: {s: {"shipped": v["shipped"]} for s, v in d.items()}
                                                for cid, d in cells_f.items()})
        for ci, c in enumerate(G.CELLS):
            PRr["pop"][te, ci] = fp[str(fi)][c["id"]]["v2"]["pop"]
    PRr["shipped"] = P
    PRr["own"] = PRr["pop"]
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    rng = np.random.default_rng(SEED_B5)
    comps = (("shipped_vs_pop", "shipped", "pop"), ("shipped_vs_own", "shipped", "own"),
             ("v2_vs_pop", "v2", "pop"), ("v4a_vs_v2", "v4a", "v2"), ("v4b_vs_v2", "v4b", "v2"))
    out_cells, pooled = {}, {}
    for ci, s in S.set_order():
        c = G.CELLS[ci]
        base = test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci]
        if s is not None:
            base &= rows["seg"] == s
        idx = np.nonzero(base)[0]
        dd = np.unique(rows["t"][idx])
        nd = len(dd)
        cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
            if nd >= G.BLOCK_DAYS else None
        y = rows["Y"][idx, ci].astype(float)
        pos = np.searchsorted(dd, rows["t"][idx])
        pr = {k: PRr[k][idx, ci] for k in ("shipped", "v2", "v4a", "v4b", "pop", "own")}
        cr = {"rows": int(len(idx)), "exits": int(y.sum()), "n_ep": G.n_episodes(rows["unit"][idx], rows["t"][idx], y),
              "R": {k: ratio_R(pr[k].sum(), y.sum()) for k in ("shipped", "v2", "v4a", "v4b")},
              "bss": {cn: (G.bss_ci(pos, nd, pr[a], pr[b], y, cb) if cb is not None
                           else dict(_EMPTY, bss=bss_point(pr[a], pr[b], y))) for cn, a, b in comps},
              "per_reserve": {}}
        for ri, r in enumerate(rn):
            mm = rows["reserve"][idx] == ri
            cr["per_reserve"][r] = {"rows": int(mm.sum()), "n_ep": G.n_episodes(rows["unit"][idx][mm],
                                                                               rows["t"][idx][mm], y[mm]),
                                     "R": {k: ratio_R(pr[k][mm].sum(), y[mm].sum()) for k in ("shipped", "v2", "v4a",
                                                                                              "v4b")}}
        if s is None:
            pooled[c["id"]] = cr
            continue
        fz = cells_f[c["id"]][SEG_IDS[s]]
        final, outcome = b5_label_rule(fz["label_final"], {r: (v["n_ep"], v["R"]["shipped"])
                                                           for r, v in cr["per_reserve"].items()},
                                       (cr["n_ep"], cr["R"]["shipped"]))
        cr.update(label_frozen=fz["label_final"], shipped=fz["shipped"], label_b5=final, outcome=outcome)
        out_cells.setdefault(c["id"], {})[SEG_IDS[s]] = cr
    verdict = {}
    for r in ("v4a", "v4b"):
        cr, lo = [], []
        for c in G.CELLS:
            if c["h"] not in B5_VERDICT_HORIZONS:
                continue
            for sg in B5_VERDICT_SEGS:
                x = out_cells[c["id"]][sg]
                cr.append((x["n_ep"], x["R"]["v2"], x["R"][r]))
            ci95 = pooled[c["id"]]["bss"][f"{r}_vs_v2"]["ci95"]
            lo.append(ci95[0] if ci95 else None)
        verdict[r] = b5_verdict(cr, r, lo)
    pt = blind5_pooling_test(ctx, rows, frozen)
    out = {"phase": "blind5", "prereg": PREREG, "section": "B4.6", "blind5_commit": blind5_commit,
           "frozen_sha256": rec["shipped_b4_sha256"],
           "inputs_sha256": shas, "code": code_meta(), "decisions": DECISIONS, "cells": out_cells, "pooled": pooled,
           "label_counts": {"frozen": label_counts({k: {s: {"x": v["label_frozen"]} for s, v in d.items()}
                                                    for k, d in out_cells.items()}, "x"),
                            "b5": label_counts({k: {s: {"x": v["label_b5"]} for s, v in d.items()}
                                                for k, d in out_cells.items()}, "x")},
           "verdict": verdict, "pooling_term_test": pt, "runtime_s": time.time() - t0,
           "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(os.path.join(out_dir, "results-blind5.json"), out, refuse_overwrite=True)
    log("blind5: results-blind5.json")
    return out


SEED_B5_RESERVE = 20261103               # supplement only (per-reserve CIs; no registered seed)


def phase_blind5_report(datasets_dir, out_dir, log=print):
    """Reported only, after the single B4.6 run: per-reserve BSS per (cell, segment), which results-blind5.json does
    not carry (it holds per-reserve R and n_ep; BSS only on the B-5 pool). Recomputes the theta = 1 predictions from
    the frozen fits exactly as phase_blind5 (deterministic), STOPs unless they reproduce every rows / n_ep / R / BSS
    point of results-blind5.json, then adds per reserve: BSS of the shipped rung vs pop (= vs own: own = pop with no
    own rows), v2 vs pop, v4a and v4b vs v2, with day-block CIs from default_rng(20261103) in the B4.3 set order,
    reserves in order inside each set. Decides nothing: labels and the method verdict are those of results-blind5.json."""
    rbp = os.path.join(out_dir, "results-blind5.json")
    outp = os.path.join(out_dir, "results-blind5-per-reserve.json")
    if not (os.path.exists(rbp) and os.path.exists(os.path.join(out_dir, "blind5-started.json"))):
        raise SystemExit("STOP: the single B4.6 run (results-blind5.json, blind5-started.json) must exist first.")
    if os.path.exists(outp):
        raise SystemExit(f"STOP: {outp} exists.")
    with open(os.path.join(out_dir, "freeze-record.json")) as fh:
        rec = json.load(fh)
    rb = json.load(open(rbp))
    if sha256_file(os.path.join(out_dir, "shipped-b4.json")) != rec["shipped_b4_sha256"] or \
            rb["frozen_sha256"] != rec["shipped_b4_sha256"]:
        raise SystemExit("STOP: frozen file differs from the freeze record / the B4.6 run.")
    t0 = time.time()
    frozen = json.load(open(os.path.join(out_dir, "shipped-b4.json")))
    shas = G.verify_inputs(datasets_dir, holdouts=False)
    shas.update(verify_blind5(datasets_dir))
    ctx, res, flags = load_blind5(datasets_dir, log)
    rows = G.build_rows(ctx, res, compute_labels=True)
    add_segments(rows, flags)
    v4a_features(rows, res, ctx.D)
    fp = frozen["fold_params"]
    cells_f = {cid: {s: {"shipped": v["shipped"]} for s, v in d.items()} for cid, d in frozen["cells"].items()}
    n = len(rows["t"])
    PRr = {k: np.full((n, G.NC), np.nan) for k in RUNGS + ("pop", "shipped")}
    for fi in range(len(ctx.folds)):
        te = np.nonzero((rows["fold"] == fi) & rows["feat_ok"])[0]
        if not len(te):
            continue
        raw = predict_frozen_b4(rows, fp, fi, te)
        Fx = {r: S.fix_grid(raw[r], rows["CAP"][te]) for r in RUNGS}
        for r in RUNGS:
            PRr[r][te] = Fx[r]
        PRr["shipped"][te] = pick_shipped_b4(rows, te, Fx, cells_f)
        for ci, c in enumerate(G.CELLS):
            PRr["pop"][te, ci] = fp[str(fi)][c["id"]]["v2"]["pop"]
    PRr["own"] = PRr["pop"]
    rn = rows["reserve_names"]
    test = (rows["fold"] >= 0) & rows["feat_ok"]
    comps = (("shipped_vs_pop", "shipped", "pop"), ("shipped_vs_own", "shipped", "own"), ("v2_vs_pop", "v2", "pop"),
             ("v4a_vs_v2", "v4a", "v2"), ("v4b_vs_v2", "v4b", "v2"))
    rng = np.random.default_rng(SEED_B5_RESERVE)
    out, n_checked = {}, 0
    for ci, s in S.set_order():
        c = G.CELLS[ci]
        base = test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci]
        if s is not None:
            base &= rows["seg"] == s
        idx = np.nonzero(base)[0]
        y = rows["Y"][idx, ci].astype(float)
        pr = {k: PRr[k][idx, ci] for k in ("shipped", "v2", "v4a", "v4b", "pop", "own")}
        ref = rb["pooled"][c["id"]] if s is None else rb["cells"][c["id"]][SEG_IDS[s]]
        chk = [ref["rows"] == len(idx), ref["n_ep"] == G.n_episodes(rows["unit"][idx], rows["t"][idx], y)]
        chk += [ref["R"][k] == ratio_R(pr[k].sum(), y.sum()) or (ref["R"][k] is None and not math.isfinite(
            ratio_R(pr[k].sum(), y.sum()))) for k in ("shipped", "v2", "v4a", "v4b")]
        chk += [ref["bss"][cn]["bss"] == bss_point(pr[a], pr[b], y) or (
            ref["bss"][cn]["bss"] is not None and bss_point(pr[a], pr[b], y) is not None and
            abs(ref["bss"][cn]["bss"] - bss_point(pr[a], pr[b], y)) <= 1e-12) for cn, a, b in comps]
        if not all(chk):
            raise SystemExit(f"STOP: recomputed predictions do not reproduce results-blind5.json at {c['id']} {s}")
        n_checked += 1
        per = {}
        for ri, r in enumerate(rn):
            jj = np.nonzero(rows["reserve"][idx] == ri)[0]
            dd = np.unique(rows["t"][idx][jj])
            nd = len(dd)
            cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
                if nd >= G.BLOCK_DAYS else None
            pos = np.searchsorted(dd, rows["t"][idx][jj])
            yy = y[jj]
            per[r] = {"rows": int(len(jj)), "exits": int(yy.sum()),
                      "n_ep": G.n_episodes(rows["unit"][idx][jj], rows["t"][idx][jj], yy),
                      "R": {k: ratio_R(pr[k][jj].sum(), yy.sum()) for k in ("shipped", "v2", "v4a", "v4b")},
                      "bss": {cn: (G.bss_ci(pos, nd, pr[a][jj], pr[b][jj], yy, cb) if cb is not None
                                   else dict(_EMPTY, bss=bss_point(pr[a][jj], pr[b][jj], yy)) if len(jj) else None)
                              for cn, a, b in comps}}
        out.setdefault(c["id"], {})["pooled_segments" if s is None else SEG_IDS[s]] = per
    res = {"phase": "blind5-report (supplement, reported only)", "prereg": PREREG, "section": "B4.6",
           "results_blind5_sha256": sha256_file(rbp), "frozen_sha256": rec["shipped_b4_sha256"],
           "inputs_sha256": shas, "code": code_meta(), "sets_reproduced_exactly": n_checked,
           "seed": SEED_B5_RESERVE, "note": phase_blind5_report.__doc__, "per_reserve": out,
           "runtime_s": time.time() - t0, "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    write_json(outp, res, refuse_overwrite=True)
    log(f"blind5-report: {n_checked} sets reproduced; {outp}")
    return res


def blind5_pooling_test(ctx, rows, frozen):
    """B4-16 (reported only)."""
    fold_names = [f[0] for f in ctx.folds]
    rn = rows["reserve_names"]
    f0 = fold_names.index(B5_POOLTEST_FIRST)
    nunits = rows["n_units"]
    n = len(rows["t"])
    PT = {r: np.full((n, G.NC), np.nan) for r in RUNGS}
    P1 = {r: np.full((n, G.NC), np.nan) for r in RUNGS}
    POP = np.full((n, G.NC), np.nan)
    OWN = np.full((n, G.NC), np.nan)
    fp = frozen["fold_params"]
    for fi in range(f0, len(fold_names)):
        Tqs = int(ctx.T[ctx.folds[fi][1]])
        for ri in range(len(rn)):
            inr = (rows["reserve"] == ri) & rows["feat_ok"]
            te = np.nonzero(inr & (rows["fold"] == fi))[0]
            if not len(te):
                continue
            pre = np.nonzero(inr & (rows["T0"] < Tqs))[0]
            raw_pre = predict_frozen_b4(rows, fp, fi, pre)
            raw_te = predict_frozen_b4(rows, fp, fi, te)
            th = {r: np.ones((len(te), G.NC)) for r in RUNGS}
            for ci, c in enumerate(G.CELLS):
                trm = (rows["T0"][pre] + G.HSEC[c["hi"]] <= Tqs) & rows["RES"][pre, c["hi"]] & ~rows["CAP"][pre, ci]
                tri = pre[trm]
                y = rows["Y"][tri, ci].astype(float)
                u = rows["unit"][tri]
                nn = np.bincount(u, minlength=nunits)
                for r in ("v2", "v4a"):
                    O = np.bincount(u, weights=y, minlength=nunits)
                    E = np.bincount(u, weights=raw_pre[r][trm, ci], minlength=nunits)
                    th[r][:, ci] = G.eb_theta(O, E)[rows["unit"][te]]
                w = discount_weights(rows["T0"][tri], Tqs)
                Od = np.bincount(u, weights=w * y, minlength=nunits)
                Ed = np.bincount(u, weights=w * raw_pre["v4a"][trm, ci], minlength=nunits)
                mseg = np.asarray(fp[str(fi)][c["id"]]["v4b"]["m_seg"])
                th["v4b"][:, ci] = theta_v4b(Od[rows["unit"][te]], Ed[rows["unit"][te]], mseg[rows["seg"][te]])
                pop = float(y.mean()) if len(y) else np.nan
                POP[te, ci] = pop
                OWN[te, ci] = G.own_rate(np.bincount(u, weights=y, minlength=nunits), nn, pop)[rows["unit"][te]]
            for r in RUNGS:
                P1[r][te] = S.fix_grid(raw_te[r], rows["CAP"][te])
                PT[r][te] = S.fix_grid(S.odds_mult(raw_te[r], th[r]), rows["CAP"][te])
    rng = np.random.default_rng(SEED_B5_POOL)
    out = {}
    test = rows["feat_ok"] & (rows["fold"] >= f0)
    for ci, c in enumerate(G.CELLS):
        base = test & rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci] & np.isfinite(PT["v2"][:, ci]) & \
            np.isfinite(POP[:, ci])
        out[c["id"]] = {}
        for name, m in [(r, base & (rows["reserve"] == ri)) for ri, r in enumerate(rn)] + [("pooled", base)]:
            idx = np.nonzero(m)[0]
            dd = np.unique(rows["t"][idx])
            nd = len(dd)
            y = rows["Y"][idx, ci].astype(float)
            pos = np.searchsorted(dd, rows["t"][idx])
            cb = B.replicate_counts(B.block_bootstrap_indices(rng, nd, G.BLOCK_DAYS, G.N_BOOT), nd) \
                if nd >= G.BLOCK_DAYS else None
            o = {"rows": int(len(idx)), "exits": int(y.sum()),
                 "n_ep": G.n_episodes(rows["unit"][idx], rows["t"][idx], y)}
            for r in RUNGS:
                o[r] = {"R_theta": ratio_R(PT[r][idx, ci].sum(), y.sum()), "R_theta1": ratio_R(P1[r][idx, ci].sum(),
                                                                                             y.sum())}
                for cn, a, b in (("theta_vs_theta1", PT[r], P1[r]), ("theta_vs_pop", PT[r], POP),
                                 ("theta_vs_own", PT[r], OWN)):
                    o[r][cn] = (G.bss_ci(pos, nd, a[idx, ci], b[idx, ci], y, cb) if cb is not None
                                else dict(_EMPTY, bss=bss_point(a[idx, ci], b[idx, ci], y)))
            out[c["id"]][name] = o
    return out


def phase_manifest(out_dir, log=print):
    files = {}
    for fn in sorted(os.listdir(out_dir)):
        p = os.path.join(out_dir, fn)
        if fn == "manifest.json" or not os.path.isfile(p):
            continue
        files[fn] = {"bytes": os.path.getsize(p), "sha256": sha256_file(p)}
    big = [f for f, v in files.items() if v["bytes"] >= 50_000_000]
    if big:
        raise SystemExit(f"STOP: files >= 50 MB: {big}")
    write_json(os.path.join(out_dir, "manifest.json"), {"files": files, "prereg": PREREG, "code": code_meta(),
                                                        "written_utc": datetime.now(timezone.utc).strftime(
                                                            "%Y-%m-%dT%H:%M:%SZ")})
    log(f"manifest: {len(files)} files")


DEVIATIONS = []


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", required=True, choices=("borrows", "audit", "dryrun", "run", "freeze", "blind5",
                                                       "blind5-report", "manifest"))
    ap.add_argument("--borrow-dir")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--blind5-commit")
    ap.add_argument("--frozen-sha256")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "borrows":
        phase_borrows(a.datasets, a.borrow_dir or os.path.join(a.out, "borrows"))
    elif a.phase == "audit":
        phase_audit(a.datasets, a.out, a.borrow_dir or os.path.join(a.out, "borrows"))
    elif a.phase == "dryrun":
        phase_dryrun(a.datasets, a.out)
    elif a.phase == "run":
        phase_run(a.datasets, a.out, workers=a.workers)
    elif a.phase == "freeze":
        phase_freeze(a.out)
    elif a.phase == "blind5":
        phase_blind5(a.datasets, a.out, a.blind5_commit, a.frozen_sha256)
    elif a.phase == "blind5-report":
        phase_blind5_report(a.datasets, a.out)
    else:
        phase_manifest(a.out)


if __name__ == "__main__":
    main()
