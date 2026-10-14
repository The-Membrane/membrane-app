#!/usr/bin/env python3
"""Q26 workstream A3 -- partial volatility scaling, regime-conditional confidence, seed-stable shipping, and the
locked final confirmation.

Implements triccs/membrane-board `design/HISTORY_TOUCH_PREREG_A3.md` (registered at commit ce8c704, file sha256
b5d8b79c2835e6770bc180c3815174de9e05b88f7ade3f73c7da8081de60ad3f). Parents: HISTORY_TOUCH_PREREG.md (A) and
HISTORY_TOUCH_PREREG_A2.md (A2, D1-D3); every definition not changed by A3 holds. The A and A2 code
(a_touch.py, a2_touch.py) is imported and never modified.

Phases (run in this order into a fresh --out):
  dryrun    data-only counts (no label value, no score; the locked set is not read)       -> dryrun.json
  dev       development span + development-blind sets (B-span, 8 holdouts) fit, predict and score ONCE;
            seed-stable shipping; freezes the shipped rung and every label
            -> results-dev.json, frozen-a3.json (+ .sha256), predictions-*.csv.gz, beta-table.csv
  locked    the locked final blind set (final-blind-prices/, membrane-datasets ab04005) read ONCE, only after the
            freeze file exists (refuses a second run) -> results-locked.json, labels-final.csv, predictions-locked-*
  panel     current-day panel (live Chainlink splice) -> panel.json
  manifest  sha256 of every output -> manifest.json
Light models only (frequency counts and FHS counts).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):   # one thread per worker
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import heapq  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import platform  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import warnings  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from numpy.lib.stride_tricks import sliding_window_view  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402

# ---------------------------------------------------------------------------------------------
# Registered constants (prereg A3.1-A3.8)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A3.md",
    "commit": "ce8c704",
    "sha256": "b5d8b79c2835e6770bc180c3815174de9e05b88f7ade3f73c7da8081de60ad3f",
    "parents": {"A": A.PREREG, "A2": M2.PREREG},
    "deviations": {"D1": "acea7d1 (locked-set fold windows; the A3.1 null-hour rule covers the pre-splice Binance hours "
                         "of the long dev series; (a) can be removed by Brier dominance)"},
}

STEP = 3600
DAY = 86400
DATA_END = A.DATA_END
BASE_DEV = M2.BASE_TS                       # A2 common grid (2017-08-17T04:00Z) for dev and dev-blind series
HORIZONS_H = A.HORIZONS_H
T_LABEL = A.T_LABEL
T_DAYS = A.T_DAYS
LEVELS = A.LEVELS
LADDER = A.LEVELS["ETH"]                    # B-span, holdouts and locked series (D-L1 as A2)
DEV_ASSETS = ("ETH", "BTC", "stETH")
BSPAN_ASSETS = ("ETH", "BTC")
HOLDOUTS = M2.HOLDOUTS

BETAS = (0.0, 0.25, 0.5, 0.75, 1.0)         # A3.2
BETA_HISTORY_DAYS = 365                     # as-of Brier over origins with >= 365 d of earlier training origins
BETA_TIE = 1e-12
NULL_FRAC = 0.05                            # A3.1 null-hour rule
REGIME_CUTS = (1.0 / 3.0, 2.0 / 3.0)        # A3.3
REGIMES = ("low", "mid", "high")
RV_TOL_FRAC = 0.05                          # DECISION D-R3: RV30 over >= 95% non-null returns

N_BOOT = 2000
SEED_REG = 20261030                         # A3.4
SEEDS_FURTHER = tuple(20261031 + i for i in range(20))   # A3.6
MIN_SEEDS = 16
SEED_LOCKED = 20261032                      # A3.7

RUNGS = ("a", "f", "fb", "r30", "r90")      # fb = (f-beta)
SHIP_ORDER = ("a", "f", "fb")               # A3.6 tie order (simpler first)
COMPARISONS = (("f_vs_a", "f", "a"), ("fb_vs_a", "fb", "a"), ("fb_vs_f", "fb", "f"),
               ("a_vs_f", "a", "f"), ("a_vs_fb", "a", "fb"), ("f_vs_fb", "f", "fb"),
               ("r30_vs_a", "r30", "a"), ("r90_vs_a", "r90", "a"))
REPORT_COMPARISONS = ("fb_vs_a", "fb_vs_f", "f_vs_a", "r30_vs_a", "r90_vs_a")

LOCKED_DIR = "final-blind-prices"
LOCKED_COMMIT = "ab04005"
LOCKED_SERIES = (  # A3.1 + D1 (acea7d1): (id, asset label, first test quarter or None = >= 365 d rule, last)
    ("bitstamp-btc-usd", "BTC/USD Bitstamp", (2012, 4), (2016, 3)),
    ("coinbase-btc-usd", "BTC/USD Coinbase", (2016, 4), (2018, 3)),
    ("coinbase-eth-usd", "ETH/USD Coinbase", (2017, 3), (2018, 3)),
) + tuple((f"binance-{p}USDT", f"{p}/USDT Binance", None, (2026, 3))
          for p in ("NEAR", "ZEC", "UNI", "QNT", "TRX", "INJ", "BAT", "FIL", "AAVE", "DOT"))
LOCKED_MIN_DAYS = 365

DECISIONS = [
    "D-G1 grids: dev and development-blind series use the A2 common grid (hour h opens at 2017-08-17T04:00Z + 3600*h); "
    "each locked series uses its own grid starting at its first candle. Every grid ends at DATA_END "
    "(2026-10-06T03:00Z). Spot, labels, monotone fix and folds follow A/A2; test issue times are 00/06/12/18Z.",
    "D-N1 A3.1 null-hour rule: a label window (hours t .. t+T-1h) is labelled from its non-null lows when its null "
    "hours are <= floor(0.05*T_h) (0, 1, 3, 8, 16, 36 for 6h..30d); otherwise, or when the spot close is null or the "
    "window passes the grid end, no label. It is applied to every series. On Chainlink hours (no internal nulls) it "
    "equals the A rule exactly (asserted: (a) and y equal A's stored rows). It also applies to the Binance "
    "(pre-splice) hours of the long ETH/BTC development series, so some 2017-2019 training labels exist that A2 "
    "dropped; (f) there differs from A2's (f) only through those training labels.",
    "D-B1 sigma_ref(t_i) = median (numpy convention; mean of the two middle values for an even count) of sigma_hat at "
    "every origin j < i of the series where sigma_hat is defined (expanding, running two-heap median). sigma_beta = "
    "sigma_hat^beta * sigma_ref^(1-beta), defined where both are; beta = 1 is exactly (f) (sigma_hat only, so its "
    "training set is (f)'s), beta = 0 uses sigma_ref only.",
    "D-B2 beta choice per (series, T, fold): evaluation origins = labelled origins t with t + T <= Q_start, sigma_hat "
    "and sigma_ref defined, and t >= (the series' first labelled origin) + 365 d ('training origins' as A.3: every "
    "labelled hour). At each, the as-of forecast for every beta uses the origins t' with t' + T <= t and "
    "sigma_beta(t') defined; an origin enters only if every beta has an as-of forecast. Mean Brier over those origins "
    "x all levels; the lowest wins; ties within 1e-12 pick 0.5, then the beta nearer 0.5, then the smaller. No "
    "evaluation origin (a tie of all) -> 0.5, counted.",
    "D-R3 regime (A3.3): RV30(t_i) = sqrt(8760 * sum(r^2)/m) over the m non-null returns among the 720 hourly returns "
    "ending at t_i, defined when m >= 684 (95%) and the 721 closes start at or after the series' first close (on "
    "series without internal nulls this is A's D3 exactly); rv_pct = "
    "a_touch.rv_pct_series (prior 730 d, >= 2,160 defined values); low < 1/3 <= mid < 2/3 <= high. Computed on the "
    "series' own closes (long spliced closes for ETH/BTC dev, as for sigma_hat). Undefined -> pooled metrics only.",
    "D-C1 confidence v3: a2_touch.level_stats (A2.5 statistics and thresholds unchanged) on the rows of one "
    "(asset, T, level, regime); the R CI uses the (asset, T) day-set draws; episodes and coverage cells use only that "
    "regime's rows; STALE uses the asset's last 4 folds. The pooled label uses every row (regime undefined included).",
    "D-C2 development-blind check (A3.5) per (rung, T, level, regime), applied to every rung's HIGH: ETH/BTC need the "
    "own-asset B-span AND the pooled 8 holdouts; stETH needs the pooled holdouts at the same level when that level is "
    "on the holdout ladder (-2%, -5%), otherwise 'unconfirmed (level not on the holdout ladder)'. A check passes "
    "with 0.67 <= R <= 1.5 and n_ep >= 10; pooled holdout R = sum p / sum y over the 8 pairs' rows of that regime, "
    "n_ep = the sum of per-pair episodes. Any failure -> 'failed dev-blind', else any n_ep < 10 -> 'unconfirmed "
    "dev-blind'; both drop HIGH to MEDIUM.",
    "D-S1 bootstrap: default_rng(20261030) draws one block draw per (asset, T) full day set in the order ETH, BTC, "
    "stETH > 6h..30d, then (same generator) B-span ETH, BTC > T, the holdouts in A2 order > T, and the pooled-holdout "
    "union day sets > T. Each further seed default_rng(20261031+i), i = 0..19, replays only the development "
    "(asset, T) draw order. CI = numpy percentile of finite replicates; 'CI lower bound above 0' is strict.",
    "D-S2 seed-stable shipping (A3.6) per (asset, T): (a) always eligible; f and fb eligible with BSS vs (a) CI lower "
    "bound > 0 under 20261030 and under >= 16 of the 20 further seeds. Dominance among the eligible, (a) included: X "
    "is removed when another eligible Y has BSS(Y vs X) CI lower bound > 0 under 20261030. Choice among the rest: "
    "most HIGH (regime-conditional labels after the development-blind check, summed over regimes and levels), then "
    "most MEDIUM, then higher BSS vs (a); an exact tie keeps the simpler rung (a < f < fb).",
    "D-F1 freeze: frozen-a3.json holds the shipped rung per (asset, T) and every label (per regime: before the check, "
    "the check outcome, after the check; pooled) for every rung; its sha256 is recorded in results-dev.json and in "
    "frozen-a3.json.sha256 before the locked phase can run.",
    "D-K1 locked folds (A3.1 as corrected by D1, acea7d1): Bitstamp BTC 2012Q4-2016Q3, Coinbase BTC 2016Q4-2018Q3, "
    "Coinbase ETH 2017Q3-2018Q3, the ten Binance pairs from the first quarter starting >= 365 d after the first kline "
    "to 2026Q3. The code starts at max(D1 first quarter, the >= 365 d quarter) and records whether that equals D1. Each series is "
    "its own asset (own training, own beta, own regime), levels = the ETH/BTC ladder. Files are verified against the "
    "git blob of membrane-datasets ab04005 before use. Draws from default_rng(20261032): series in the A3.1 order "
    "> 6h..30d, then the pooled union day sets > 6h..30d.",
    "D-K2 final label (A3.7): a frozen HIGH stays HIGH iff the locked set pooled over series gives 0.67 <= R <= 1.5 "
    "with n_ep >= 10 for that rung, T, level and regime (stETH levels off the ladder -> 'unconfirmed final'). "
    "Else MEDIUM: 'failed final' (n_ep >= 10, R outside) or 'unconfirmed final' (n_ep < 10). MEDIUM/LOW/insufficient/"
    "STALE are unchanged.",
    "D-P1 panel: every cell shows the shipped rung's monotone-fixed number (refit with Q_start = DATA_END, beta chosen "
    "in-fold the same way), the current regime (rv_pct at asof from the live Chainlink splice), the final label of "
    "that regime, its n_ep, the test period and the rung. ACTION rows carry the lower final label of the two grid "
    "levels the interpolation uses (current regime); a line within 1e-9 of a grid level uses that level (A2 D3).",
    "D-R1 references r30/r90 as A2 (Q25 T1.2 estimator; a null daily sample -> undefined, row missing for that rung).",
]


# ---------------------------------------------------------------------------------------------
# Series
# ---------------------------------------------------------------------------------------------
def window_min_null_rule(low, T_h, frac=NULL_FRAC):
    """A3.1: wmin[i] = min of non-null lows in hours i .. i+T_h-1 if their null count <= floor(frac*T_h), else NaN.
    Length N+1 (origins 0..N); windows past the grid end are NaN."""
    low = np.asarray(low, float)
    n = len(low)
    out = np.full(n + 1, np.nan)
    if n < T_h:
        return out
    nul = ~np.isfinite(low)
    lf = np.where(nul, np.inf, low)
    m = sliding_window_view(lf, T_h).min(axis=1)
    c = np.concatenate([[0], np.cumsum(nul)])
    nn = c[T_h:] - c[:-T_h]
    ok = (nn <= max_nulls(T_h, frac)) & np.isfinite(m)
    out[:len(m)] = np.where(ok, m, np.nan)
    return out


def max_nulls(T_h, frac=NULL_FRAC):
    return int(math.floor(frac * T_h + 1e-9))


def expanding_median(x):
    """med[i] = median of finite x[j], j < i (NaN if none). Two-heap running median."""
    x = np.asarray(x, float)
    out = np.full(len(x), np.nan)
    lo, hi = [], []          # lo: max-heap (negated), hi: min-heap
    for i in range(1, len(x)):
        v = x[i - 1]
        if v == v:
            if not lo or v <= -lo[0]:
                heapq.heappush(lo, -v)
            else:
                heapq.heappush(hi, v)
            if len(lo) > len(hi) + 1:
                heapq.heappush(hi, -heapq.heappop(lo))
            elif len(hi) > len(lo):
                heapq.heappush(lo, -heapq.heappop(hi))
        if lo:
            out[i] = -lo[0] if len(lo) > len(hi) else 0.5 * (-lo[0] + hi[0])
    return out


def rv30_tolerant(close, rv_h=A.RV_HOURS, tol=RV_TOL_FRAC):
    """D-R3: RV30 at origins 0..N over the non-null returns among the 720 ending at t_i (>= 95% non-null)."""
    close = np.asarray(close, float)
    n_orig = len(close) + 1
    r = np.full(len(close), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[1:] = np.log(close[1:] / close[:-1])
    valid = np.isfinite(r)
    out = np.full(n_orig, np.nan)
    if len(r) >= rv_h:
        s = sliding_window_view(np.where(valid, r * r, 0.0), rv_h).sum(axis=1)
        m = sliding_window_view(valid, rv_h).sum(axis=1)
        need = int(math.ceil((1.0 - tol) * rv_h - 1e-9))
        with np.errstate(invalid="ignore", divide="ignore"):
            v = np.sqrt(A.RV_ANNUAL * s / m)
        v[m < need] = np.nan
        out[rv_h:rv_h + len(v)] = v
        fin = np.where(np.isfinite(close))[0]
        f0 = int(fin[0]) if len(fin) else len(close)
        out[:min(n_orig, f0 + rv_h + 1)] = np.nan       # the window never reaches before the first close
    return out


def regime_of(rv_pct):
    """0 low, 1 mid, 2 high, -1 undefined."""
    g = np.full(len(rv_pct), -1, dtype=np.int8)
    f = np.isfinite(rv_pct)
    g[f & (rv_pct < REGIME_CUTS[0])] = 0
    g[f & (rv_pct >= REGIME_CUTS[0]) & (rv_pct < REGIME_CUTS[1])] = 1
    g[f & (rv_pct >= REGIME_CUTS[1])] = 2
    return g


class S3:
    """One series on its own hourly origin grid (base_ts)."""

    def __init__(self, name, asset, truth, close, low, levels, base_ts, start_ts):
        self.name, self.asset, self.truth = name, asset, truth
        self.levels = tuple(levels)
        self.base_ts = int(base_ts)
        si = (int(start_ts) - self.base_ts) // STEP
        close = np.array(close, float)
        low = np.array(low, float)
        close[:si] = np.nan
        low[:si] = np.nan
        self.close, self.low = close, low
        self.start_i = int(si)
        self.N = len(close)
        self.n_orig = self.N + 1
        self.spot = A.spot_series(close)
        self.sigma = M2.ewma_sigma(close)
        self.sigma_ref = expanding_median(self.sigma)
        self.rv30 = rv30_tolerant(close)
        self.rv_pct = A.rv_pct_series(self.rv30)
        self.regime = regime_of(self.rv_pct)
        self._lab, self._wmin = {}, {}

    def ts(self, i):
        return self.base_ts + STEP * int(i)

    def gi(self, ts):
        if (ts - self.base_ts) % STEP:
            raise ValueError("off grid")
        return (ts - self.base_ts) // STEP

    def wmin(self, T_h):
        if T_h not in self._wmin:
            self._wmin[T_h] = window_min_null_rule(self.low, T_h)
        return self._wmin[T_h]

    def labels(self, T_h):
        if T_h not in self._lab:
            self._lab[T_h] = A.make_labels(self.spot, self.wmin(T_h), self.levels)
        return self._lab[T_h]

    def issue_mask(self):
        return M2.issue_mask(self.n_orig, base_ts=self.base_ts)

    def sigma_beta(self, beta):
        if beta == 1.0:
            return self.sigma
        if beta == 0.0:
            return self.sigma_ref
        with np.errstate(invalid="ignore"):
            return np.power(self.sigma, beta) * np.power(self.sigma_ref, 1.0 - beta)


def s3_from(g, base_ts=BASE_DEV):
    """A2 GSeries -> S3 (same close/low arrays and start)."""
    return S3(g.name, g.asset, g.truth, g.close, g.low, g.levels, base_ts, base_ts + STEP * g.start_i)


def build_dev(datasets):
    G = M2.build_dev_series(datasets)
    S = {}
    for a in DEV_ASSETS:
        S[f"oracle:{a}"] = s3_from(G[f"oracle:{a}"])
        S[f"long:{a}"] = S[f"oracle:{a}"] if G[f"long:{a}"] is G[f"oracle:{a}"] else s3_from(G[f"long:{a}"])
    return S


def build_devblind(datasets):
    G = M2.build_blind_series(datasets)
    return {k: s3_from(v) for k, v in G.items()}


# ---------------------------------------------------------------------------------------------
# Folds
# ---------------------------------------------------------------------------------------------
def quarters(first, last, ser):
    (y, q), out = first, []
    while (y, q) <= last:
        ny, nq = (y, q + 1) if q < 4 else (y + 1, 1)
        qs, qe = A.quarter_start(y, q), A.quarter_start(ny, nq)
        out.append({"name": f"{y}Q{q}", "qs_ts": qs, "qe_ts": qe, "qs_i": ser.gi(qs), "qe_i": ser.gi(qe)})
        y, q = ny, nq
    return out


def first_quarter_after(first_ts, days):
    lim = first_ts + days * DAY
    y, q = int(A.iso(first_ts)[:4]), 1
    while A.quarter_start(y, q) < lim:
        y, q = (y, q + 1) if q < 4 else (y + 1, 1)
    return (y, q)


def dev_folds(ser):
    return quarters(*A.FOLD_SPAN[ser.asset], ser)


def devblind_folds(ser):
    if ser.name.startswith("bspan:"):
        return quarters(*M2.BSPAN_SPAN, ser)
    return quarters(M2.holdout_first_quarter(ser.ts(ser.start_i)), M2.HOLDOUT_LAST, ser)


def locked_fold_span(first_ts, stated_first, last):
    """D-K1: from max(stated first, first quarter >= 365 d after the first candle) to the stated last."""
    fq = first_quarter_after(first_ts, LOCKED_MIN_DAYS)
    start = max(fq, stated_first) if stated_first else fq
    return start, last


def test_times(f, ser, imask):
    i = np.arange(f["qs_i"], min(f["qe_i"], ser.n_orig))
    return i[imask[i]]


# ---------------------------------------------------------------------------------------------
# Per (series, T): labels, FHS depths per beta, as-of beta selection (A3.2)
# ---------------------------------------------------------------------------------------------
class Prep3:
    def __init__(self, ser, T_h, q_max=None, beta_select=True):
        self.T_h = T_h
        self.K = len(ser.levels)
        self.Y = ser.labels(T_h)
        self.lab_ok = np.isfinite(self.Y[:, 0])
        n = len(self.lab_ok)
        self.lnk = np.log1p(np.asarray(ser.levels, float))
        self.scale = math.sqrt(T_h / M2.SIGMA_ANNUAL)
        with np.errstate(invalid="ignore", divide="ignore"):
            self.depth = np.where(self.lab_ok, np.log(ser.wmin(T_h) / ser.spot), np.nan)
        Yz = np.where(self.lab_ok[:, None], self.Y, 0.0)
        self.cumY = np.cumsum(Yz, axis=0)
        self.cumN = np.cumsum(self.lab_ok.astype(np.int64))
        self.sig, self.valid, self.z = {}, {}, {}
        for b in BETAS:
            s = ser.sigma_beta(b)
            s = np.where(s > 0, s, np.nan)
            self.sig[b] = s
            self.valid[b] = self.lab_ok & np.isfinite(s)
            with np.errstate(invalid="ignore", divide="ignore"):
                self.z[b] = np.where(self.valid[b], self.depth / (s * self.scale), np.nan)
        lab_idx = np.where(self.lab_ok)[0]
        self.first_lab = int(lab_idx[0]) if len(lab_idx) else None
        self.beta_ready = False
        if beta_select and self.first_lab is not None:
            self._beta_data(ser, n if q_max is None else q_max)

    def thresholds(self, sigma):
        with np.errstate(invalid="ignore", divide="ignore"):
            return self.lnk[None, :] / (np.asarray(sigma, float)[:, None] * self.scale)

    def freq_upto(self, lim):
        if lim < 0 or self.cumN[lim] == 0:
            return np.full(self.K, np.nan)
        return self.cumY[lim] / self.cumN[lim]

    def _beta_data(self, ser, q_max):
        n = len(self.lab_ok)
        T = self.T_h
        i = np.arange(n)
        ev = (self.lab_ok & np.isfinite(ser.sigma) & np.isfinite(ser.sigma_ref)
              & (i >= self.first_lab + BETA_HISTORY_DAYS * 24) & (i + T <= q_max))
        asof = {}
        for b in BETAS:
            thr = self.thresholds(self.sig[b])
            asof[b] = M2.asof_fhs_counts(self.valid[b], self.z[b], ev, np.where(np.isfinite(thr), thr, 0.0), T)
        for b in BETAS:
            ev &= np.all(np.isfinite(asof[b]), axis=1)
        self.eval_mask = ev
        self.cumE = np.cumsum(ev.astype(np.int64))
        self.cumSE = {}
        for b in BETAS:
            se = np.where(ev, np.sum((np.nan_to_num(asof[b]) - np.where(self.lab_ok[:, None], self.Y, 0.0)) ** 2,
                                     axis=1), 0.0)
            self.cumSE[b] = np.cumsum(se)
        self.beta_ready = True

    def choose_beta(self, qs_i):
        """D-B2. Returns (beta, info)."""
        lim = qs_i - self.T_h
        if not self.beta_ready or lim < 0 or self.cumE[min(lim, len(self.cumE) - 1)] == 0:
            return 0.5, {"n_eval": 0, "brier": None, "rule": "no evaluation origin -> 0.5"}
        lim = min(lim, len(self.cumE) - 1)
        ne = int(self.cumE[lim])
        br = {b: float(self.cumSE[b][lim] / (ne * self.K)) for b in BETAS}
        return pick_beta(br), {"n_eval": ne, "brier": br, "rule": "min as-of Brier"}


def pick_beta(br):
    best = min(br.values())
    tied = [b for b in BETAS if br[b] - best <= BETA_TIE]
    if len(tied) == 1:
        return tied[0]
    if 0.5 in tied:
        return 0.5
    return sorted(tied, key=lambda b: (abs(b - 0.5), b))[0]


def predict3(ser, P, T_h, qs_i, te, beta, te_sigma=None, te_sigma_ref=None, te_close=None):
    """Raw predictions {rung: (len(te), K)} for one fold. te_* (panel) override test-origin features."""
    K = P.K
    lim = qs_i - T_h
    i_all = np.arange(len(P.lab_ok))
    out = {"raw": {}, "n_train": int(P.cumN[lim]) if lim >= 0 else 0}
    out["raw"]["a"] = np.tile(P.freq_upto(lim), (len(te), 1))
    sg = ser.sigma[te] if te_sigma is None else np.atleast_1d(np.asarray(te_sigma, float))
    sr = ser.sigma_ref[te] if te_sigma_ref is None else np.atleast_1d(np.asarray(te_sigma_ref, float))
    for name, b in (("f", 1.0), ("fb", beta)):
        tr = P.valid[b] & (i_all <= lim)
        if b == 1.0:
            s_te = sg
        elif b == 0.0:
            s_te = sr
        else:
            with np.errstate(invalid="ignore"):
                s_te = np.power(sg, b) * np.power(sr, 1.0 - b)
        out["raw"][name] = M2.fhs_predict(P.z[b][tr], P.thresholds(s_te))
        out[f"n_train_{name}"] = int(tr.sum())
    levels = np.asarray(ser.levels, float)
    cl = ser.close if te_close is None else te_close
    for name, nd in M2.REF_DAYS.items():
        sgr = A.ref_daily_sigma(cl, te, nd)
        out["raw"][name] = A.touch_prob(levels[None, :], sgr[:, None], T_DAYS[T_h])
    return out


# ---------------------------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------------------------
_SER = {}


def _fold_loop(ser, P, T_h, folds, extra_data_end=False, P_a=None):
    imask = ser.issue_mask()
    res = []
    fl = list(folds) + ([{"name": "DATA_END", "qs_i": ser.N, "qe_i": ser.N + 1}] if extra_data_end else [])
    for f in fl:
        te = test_times(f, ser, imask) if f["name"] != "DATA_END" else np.array([ser.N])
        beta, binfo = P.choose_beta(f["qs_i"])
        o = predict3(ser, P, T_h, f["qs_i"], te, beta)
        if P_a is not None:
            lim = f["qs_i"] - T_h
            o["raw"]["a"] = np.tile(P_a.freq_upto(lim), (len(te), 1))
            o["n_train"] = int(P_a.cumN[lim])
        o.update(fold=f["name"], te=te, beta=beta, beta_info=binfo)
        res.append(o)
    return res


def dev_task(args):
    asset, T_h = args
    lser, oser = _SER[f"long:{asset}"], _SER[f"oracle:{asset}"]
    P = Prep3(lser, T_h)
    Po = P if oser is lser else Prep3(oser, T_h, beta_select=False)
    return asset, T_h, _fold_loop(lser, P, T_h, dev_folds(lser), extra_data_end=True, P_a=Po)


def series_task(args):
    key, T_h = args
    ser = _SER[key]
    folds = _SER["__folds__"][key]
    q_max = max(f["qs_i"] for f in folds) if folds else 0
    P = Prep3(ser, T_h, q_max=q_max)
    return key, T_h, _fold_loop(ser, P, T_h, folds)


def run_pool(fn, tasks, workers, log, t0):
    outs = {}
    if workers > 1:
        with mp.get_context("fork").Pool(workers) as pool:
            for k, T_h, r in pool.imap_unordered(fn, tasks):
                outs[(k, T_h)] = r
                log(f"  fit {k} {T_LABEL[T_h]} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    else:
        for t in tasks:
            k, T_h, r = fn(t)
            outs[(k, T_h)] = r
            log(f"  fit {k} {T_LABEL[T_h]} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    return outs


def assemble3(ser, folds, per_T, y_check=None):
    """Grids (n_te, nT, K) per rung, monotone fix, labelled rows with regime and beta."""
    K, nT = len(ser.levels), len(HORIZONS_H)
    first = [o for o in per_T[HORIZONS_H[0]] if o["fold"] != "DATA_END"]
    te_all = np.concatenate([o["te"] for o in first]) if first else np.array([], int)
    fold_of = np.concatenate([[fi] * len(o["te"]) for fi, o in enumerate(first)]).astype(int) if first else \
        np.array([], int)
    n = len(te_all)
    G = {r: np.full((n, nT, K), np.nan) for r in RUNGS}
    B = np.full((n, nT), np.nan)
    beta_rows, data_end = [], {}
    for ti, T_h in enumerate(HORIZONS_H):
        off = 0
        for o in per_T[T_h]:
            if o["fold"] == "DATA_END":
                data_end[T_h] = o
                continue
            m = len(o["te"])
            sl = slice(off, off + m)
            assert np.array_equal(te_all[sl], o["te"])
            for r in RUNGS:
                G[r][sl, ti, :] = o["raw"][r]
            B[sl, ti] = o["beta"]
            bi = o["beta_info"]
            beta_rows.append({"series": ser.name, "T": T_LABEL[T_h], "fold": o["fold"], "beta": o["beta"],
                              "n_eval": bi["n_eval"], "rule": bi["rule"],
                              **{f"brier_b{b}": (bi["brier"] or {}).get(b) for b in BETAS}})
            off += m
        assert off == n
    F = {}
    for r in RUNGS:
        if r in ("r30", "r90"):
            F[r] = A.monotone_fix(G[r]) if n else G[r]
        else:
            assert not np.isnan(G[r]).any(), f"{ser.name} {r} grid has gaps"
            F[r] = A.monotone_fix(G[r]) if n else G[r]
    rows = {k: [] for k in ("t0_i", "fold_i", "T_h", "k_i", "k", "y", "regime", "beta")}
    rows.update({f"p_{r}": [] for r in RUNGS})
    for ti, T_h in enumerate(HORIZONS_H):
        Y = ser.labels(T_h)[te_all]
        if y_check is not None:
            Y2 = y_check.labels(T_h)[te_all]
            assert np.array_equal(np.isfinite(Y), np.isfinite(Y2)) and \
                np.array_equal(Y[np.isfinite(Y)], Y2[np.isfinite(Y2)]), f"{ser.name} long vs oracle labels differ"
        idx = np.where(np.isfinite(Y[:, 0]))[0]
        for j, k in enumerate(ser.levels):
            rows["t0_i"].append(te_all[idx])
            rows["fold_i"].append(fold_of[idx])
            rows["T_h"].append(np.full(len(idx), T_h))
            rows["k_i"].append(np.full(len(idx), j))
            rows["k"].append(np.full(len(idx), k))
            rows["y"].append(Y[idx, j])
            rows["regime"].append(ser.regime[te_all[idx]])
            rows["beta"].append(B[idx, ti])
            for r in RUNGS:
                rows[f"p_{r}"].append(F[r][idx, ti, j])
    R = {k: (np.concatenate(v) if v else np.array([])) for k, v in rows.items()}
    R["t0_i"] = R["t0_i"].astype(np.int64)
    R["fold_i"] = R["fold_i"].astype(np.int64)
    R["k_i"] = R["k_i"].astype(np.int64)
    R["T_h"] = R["T_h"].astype(np.int64)
    R["regime"] = R["regime"].astype(np.int8)
    R["day"] = (ser.base_ts + STEP * R["t0_i"]) // DAY
    R["fold_names"] = [f["name"] for f in folds]
    R["levels"] = list(ser.levels)
    R["base_ts"] = ser.base_ts
    de = {}
    if data_end:
        for r in RUNGS:
            g = np.array([data_end[T]["raw"][r][0] for T in HORIZONS_H])
            if not np.isnan(g).any():
                de[r] = A.monotone_fix(g[None])[0]
        de["beta"] = {T_LABEL[T]: data_end[T]["beta"] for T in HORIZONS_H}
        de["beta_info"] = {T_LABEL[T]: data_end[T]["beta_info"] for T in HORIZONS_H}
    return R, beta_rows, de


# ---------------------------------------------------------------------------------------------
# Scoring (A3.4, A3.5)
# ---------------------------------------------------------------------------------------------
def draws(rng, n_days, T_h):
    return M2.boot_counts(rng, n_days, T_h)


def comparisons(sel, pos, n_days, counts, comps, mask=None):
    out = {}
    y = sel["y"]
    for cname, rm, rb in comps:
        pm, pb = sel[f"p_{rm}"], sel[f"p_{rb}"]
        m = np.isfinite(pm) & np.isfinite(pb)
        if mask is not None:
            m &= mask
        if m.any() and np.sum((pb[m] - y[m]) ** 2) > 0:
            out[cname] = M2.bss_ci(pos[m], n_days, pm[m], pb[m], y[m], counts)
    return out


def ci_lower(sel, pos, n_days, counts, rm, rb):
    pm, pb, y = sel[f"p_{rm}"], sel[f"p_{rb}"], sel["y"]
    m = np.isfinite(pm) & np.isfinite(pb)
    se_m = np.bincount(pos[m], weights=(pm[m] - y[m]) ** 2, minlength=n_days)
    se_b = np.bincount(pos[m], weights=(pb[m] - y[m]) ** 2, minlength=n_days)
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (counts @ se_m) / (counts @ se_b)
    fin = np.isfinite(reps)
    return float(np.percentile(reps[fin], 2.5)) if fin.sum() > 1 else None


def select(R, mask):
    return {k: (v[mask] if isinstance(v, np.ndarray) else v) for k, v in R.items()}


def level_stats_by_regime(sel, pos, n_days, counts, T_h, last_folds, rungs, with_labels=True):
    """{level: {rung: {"pooled": stats, "low"/"mid"/"high": stats}}}."""
    out = {}
    for j, k in enumerate(sel["levels"]):
        mk = sel["k_i"] == j
        lv = {}
        for r in rungs:
            p = sel[f"p_{r}"]
            base = mk & np.isfinite(p)
            d = {}
            for gname, gval in (("pooled", None),) + tuple((g, gi) for gi, g in enumerate(REGIMES)):
                m = base if gval is None else base & (sel["regime"] == gval)
                if not m.any():
                    d[gname] = None
                    continue
                if with_labels:
                    d[gname] = M2.level_stats(sel["t0_i"][m], sel["fold_i"][m], pos[m], n_days, p[m], sel["y"][m],
                                              counts, T_h, last_folds)
                else:
                    Rr, ci = M2.ratio_ci(pos[m], n_days, p[m], sel["y"][m], counts)
                    d[gname] = {"R": Rr, "R_ci95": ci, "n_ep": M2.count_touch_episodes(sel["t0_i"][m], sel["y"][m]),
                                "n_rows": int(m.sum()), "sum_p": float(p[m].sum()), "sum_y": float(sel["y"][m].sum())}
            lv[r] = d
        out[repr(float(k))] = lv
    return out


def score_series_T(R, T_h, counts, days, rungs=RUNGS, with_labels=True, comps=COMPARISONS):
    m = R["T_h"] == T_h
    sel = select(R, m)
    pos = M2.day_positions(days, sel["day"])
    fn = R["fold_names"]
    last_folds = set(range(len(fn) - M2.STALE_FOLDS, len(fn)))
    out = {"counts": counts_of(R, m, T_h), "brier": {}, "comparisons": {}, "comparisons_by_regime": {}}
    for r in rungs:
        p = sel[f"p_{r}"]
        f = np.isfinite(p)
        if f.any():
            out["brier"][r] = {"brier": float(np.mean((p[f] - sel["y"][f]) ** 2)), "n_rows": int(f.sum()),
                               "n_undefined": int((~f).sum())}
    out["comparisons"] = comparisons(sel, pos, len(days), counts, comps)
    for gi, g in enumerate(REGIMES):
        out["comparisons_by_regime"][g] = comparisons(sel, pos, len(days), counts,
                                                      [c for c in comps if c[0] in REPORT_COMPARISONS],
                                                      mask=sel["regime"] == gi)
    out["regime_rows"] = {g: int((sel["regime"] == gi).sum()) for gi, g in enumerate(REGIMES)}
    out["regime_rows"]["undefined"] = int((sel["regime"] < 0).sum())
    out["levels"] = level_stats_by_regime(sel, pos, len(days), counts, T_h, last_folds, rungs, with_labels)
    return out, sel, pos


def counts_of(R, mask, T_h):
    t0 = np.unique(R["t0_i"][mask])
    b = R["base_ts"]
    return {"n_rows": int(mask.sum()), "n_issue_times": int(len(t0)), "n_days": int(len(np.unique(R["day"][mask]))),
            "n_windows": A.n_windows(len(t0), T_h),
            "period": [A.iso(b + STEP * int(t0.min())), A.iso(b + STEP * int(t0.max()) + STEP * T_h)]
            if len(t0) else None}


def pooled_series_stats(Rs, keys, T_h, counts, days, rungs):
    """Pooled over series (union day set): BSS per comparison and per (level, rung, regime) R / n_ep."""
    parts = [select(Rs[k], Rs[k]["T_h"] == T_h) for k in keys]
    cat = {c: np.concatenate([p[c] for p in parts]) for c in ("day", "y", "k_i", "regime") +
           tuple(f"p_{r}" for r in rungs)}
    pos = M2.day_positions(days, cat["day"])
    out = {"comparisons": comparisons(cat, pos, len(days), counts, [c for c in COMPARISONS if c[1] in rungs
                                                                       and c[2] in rungs]),
           "comparisons_by_regime": {}, "levels": {}, "n_rows": int(len(cat["y"])), "n_days": int(len(days))}
    for gi, g in enumerate(REGIMES):
        out["comparisons_by_regime"][g] = comparisons(cat, pos, len(days), counts,
                                                      [c for c in COMPARISONS if c[0] in REPORT_COMPARISONS
                                                       and c[1] in rungs and c[2] in rungs],
                                                      mask=cat["regime"] == gi)
    for j, k in enumerate(LADDER):
        kk = repr(float(k))
        lv = {}
        for r in rungs:
            d = {}
            for gname, gval in (("pooled", None),) + tuple((g, gi) for gi, g in enumerate(REGIMES)):
                m = (cat["k_i"] == j) & np.isfinite(cat[f"p_{r}"])
                if gval is not None:
                    m &= cat["regime"] == gval
                Rr, ci = M2.ratio_ci(pos[m], len(days), cat[f"p_{r}"][m], cat["y"][m], counts) if m.any() else (None, None)
                n_ep = 0
                for p in parts:
                    mp_ = (p["k_i"] == j) & np.isfinite(p[f"p_{r}"])
                    if gval is not None:
                        mp_ &= p["regime"] == gval
                    n_ep += M2.count_touch_episodes(p["t0_i"][mp_], p["y"][mp_])
                d[gname] = {"R": Rr, "R_ci95": ci, "n_ep": int(n_ep), "n_rows": int(m.sum()),
                            "sum_p": float(cat[f"p_{r}"][m].sum()), "sum_y": float(cat["y"][m].sum())}
            lv[r] = d
        out["levels"][kk] = lv
    return out


def check_one(stat):
    """A3.5 / A3.7 check of one blind/locked statistic: 'pass', 'failed', 'unconfirmed'."""
    if stat is None or stat.get("n_ep") is None or stat["n_ep"] < M2.BLIND_NEP:
        return "unconfirmed"
    R = stat.get("R")
    return "pass" if (R is not None and math.isfinite(R) and M2.BLIND_R[0] <= R <= M2.BLIND_R[1]) else "failed"


def devblind_outcome(asset, level_key, label, bspan_stat, hold_stat, hold_has_level):
    """D-C2: (label_after, outcome)."""
    if label != "HIGH":
        return label, "not HIGH"
    if asset == "stETH" and not hold_has_level:
        return "MEDIUM", "unconfirmed (level not on the holdout ladder)"
    checks = []
    if asset in BSPAN_ASSETS:
        checks.append(check_one(bspan_stat))
    checks.append(check_one(hold_stat))
    if "failed" in checks:
        return "MEDIUM", "failed dev-blind"
    if "unconfirmed" in checks:
        return "MEDIUM", "unconfirmed dev-blind"
    return "HIGH", "passed dev-blind"


def final_outcome(label, locked_stat, on_ladder=True):
    """D-K2: (final_label, outcome)."""
    if label != "HIGH":
        return label, "not HIGH"
    if not on_ladder:
        return "MEDIUM", "unconfirmed final"
    c = check_one(locked_stat)
    if c == "pass":
        return "HIGH", "confirmed final"
    return "MEDIUM", "failed final" if c == "failed" else "unconfirmed final"


def ship_choice(eligible, dominance, n_high, n_med, bss_a):
    """D-S2. eligible: rungs (a first); dominance: {(Y, X): bool} Y beats X. Returns (rung, info)."""
    rest = [x for x in eligible if not any(dominance.get((y, x), False) for y in eligible if y != x)]
    removed = [x for x in eligible if x not in rest]
    if not rest:            # cannot happen with a strict CI order, kept for safety
        rest = ["a"]
    key = lambda r: (n_high[r], n_med[r], bss_a.get(r) if bss_a.get(r) is not None else 0.0)  # noqa: E731
    best = max(key(r) for r in rest)
    tied = [r for r in rest if key(r) == best]
    choice = sorted(tied, key=SHIP_ORDER.index)[0]
    return choice, {"eligible": eligible, "removed_by_dominance": removed, "remaining": rest, "tied_at_top": tied}


# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------
def write_json(path, obj, refuse_overwrite=False):
    A.write_json(path, obj, refuse_overwrite=refuse_overwrite)


def code_meta():
    here = os.path.abspath(__file__)
    d = os.path.dirname(here)
    run = lambda *a: subprocess.run(["git", "-C", d, *a], capture_output=True, text=True).stdout.strip()  # noqa: E731
    return {"path": "scripts/research/history-forecasts/a3_touch.py", "sha256": A.sha256_file(here),
            "a2_touch_sha256": A.sha256_file(os.path.join(d, "a2_touch.py")),
            "a_touch_sha256": A.sha256_file(os.path.join(d, "a_touch.py")),
            "git": {"head_commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
                    "a3_touch_last_commit": run("log", "-1", "--format=%H", "--", "a3_touch.py"),
                    "dirty_code_files": run("status", "--porcelain", "--", "a3_touch.py", "test_a3_touch.py",
                                            "a2_touch.py", "a_touch.py").splitlines()}}


def env_meta(workers):
    import scipy
    return {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
            "workers": workers,
            "threads": {v: os.environ.get(v) for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")}}


def write_rows(path, named):
    header = ["series", "t0", "fold", "T", "k", "y", "regime", "beta"] + [f"p_{r}" for r in RUNGS]

    def gen():
        for name, R in named:
            fn, b = R["fold_names"], R["base_ts"]
            order = np.lexsort((R["k_i"], R["T_h"], R["t0_i"]))
            for i in order:
                g = int(R["regime"][i])
                yield ([name, A.iso(b + STEP * int(R["t0_i"][i])), fn[int(R["fold_i"][i])], T_LABEL[int(R["T_h"][i])],
                        repr(float(R["k"][i])), int(R["y"][i]), REGIMES[g] if g >= 0 else "",
                        A._f(R["beta"][i])] + [A._f(R[f"p_{r}"][i]) for r in RUNGS])
    A.write_csv_gz(path, header, gen())


def write_beta_table(path, rows):
    h = ["series", "T", "fold", "beta", "n_eval", "rule"] + [f"brier_b{b}" for b in BETAS]
    A.write_csv(path, h, rows)


def beta_summary(rows):
    out = {}
    for r in rows:
        d = out.setdefault(r["series"], {}).setdefault(r["T"], {})
        d[str(r["beta"])] = d.get(str(r["beta"]), 0) + 1
    return out


# ---------------------------------------------------------------------------------------------
# Phase: dry run (counts only)
# ---------------------------------------------------------------------------------------------
def run_dryrun(datasets, out_dir, meta, log=print):
    path = os.path.join(out_dir, "dryrun.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    t0 = time.time()
    D = build_dev(datasets)
    B = build_devblind(datasets)
    out = {"phase": "dryrun", "prereg": PREREG, "code": code_meta(), "inputs": meta,
           "note": "Data-only counts (labelled windows under the A rule vs the A3.1 rule, regime availability, beta "
                   "evaluation origins). No label value, frequency, Brier, BSS or R. The locked set is not read.",
           "series": {}}
    seen = set()
    for key, ser in list(D.items()) + list(B.items()):
        if id(ser) in seen:
            continue
        seen.add(id(ser))
        folds = dev_folds(ser) if key in D else devblind_folds(ser)
        imask = ser.issue_mask()
        s_out = {"start": A.iso(ser.ts(ser.start_i)), "folds": [f["name"] for f in folds],
                 "sigma_ref_first": A.iso(ser.ts(np.where(np.isfinite(ser.sigma_ref))[0][0])),
                 "regime_first_defined": (A.iso(ser.ts(np.where(ser.regime >= 0)[0][0]))
                                          if (ser.regime >= 0).any() else None), "per_T": {}}
        te_all = np.concatenate([test_times(f, ser, imask) for f in folds]) if folds else np.array([], int)
        s_out["test_issue_times"] = int(len(te_all))
        s_out["test_regime_counts"] = {g: int((ser.regime[te_all] == gi).sum()) for gi, g in enumerate(REGIMES)}
        s_out["test_regime_counts"]["undefined"] = int((ser.regime[te_all] < 0).sum())
        for T_h in HORIZONS_H:
            old = np.isfinite(ser.spot) & np.isfinite(A.window_min(ser.low, T_h))
            new = np.isfinite(ser.spot) & np.isfinite(ser.wmin(T_h))
            i = np.arange(ser.n_orig)
            first = int(np.where(new)[0][0]) if new.any() else None
            ev = new & np.isfinite(ser.sigma) & np.isfinite(ser.sigma_ref) & \
                (i >= (first or 0) + BETA_HISTORY_DAYS * 24)
            s_out["per_T"][T_LABEL[T_h]] = {
                "labelled_A_rule": int(old.sum()), "labelled_A3_rule": int(new.sum()),
                "added_by_A3_rule": int((new & ~old).sum()), "removed_by_A3_rule": int((old & ~new).sum()),
                "test_rows_labelled": int(new[te_all].sum()) * len(ser.levels),
                "beta_eval_origins_first_fold": int((ev & (i + T_h <= folds[0]["qs_i"])).sum()) if folds else None,
                "beta_eval_origins_last_fold": int((ev & (i + T_h <= folds[-1]["qs_i"])).sum()) if folds else None}
        out["series"][key] = s_out
        log(f"dryrun {key}")
    out["runtime_seconds"] = round(time.time() - t0, 1)
    write_json(path, out, refuse_overwrite=True)
    return out


# ---------------------------------------------------------------------------------------------
# Phase: development span + development-blind sets (scored ONCE), seed-stable shipping, freeze
# ---------------------------------------------------------------------------------------------
def check_stored_a(datasets, Rs):
    """(a) and y on the development rows equal A's stored predictions (the A3.1 rule leaves Chainlink unchanged)."""
    df = M2.load_stored_a(os.path.join(datasets, M2.A_STORED["pred"][0]))
    out = {}
    for a in DEV_ASSETS:
        R = dict(Rs[a])
        R2 = {k: R[k] for k in ("t0_i", "T_h", "k_i", "levels", "y", "p_a")}
        R2["in_d"] = np.zeros(len(R["y"]), bool)
        sub = df[df["asset"] == a].copy()
        sub["p_d"] = np.nan
        out[a] = M2.merge_stored(R2, sub, a)
    return out


def run_dev(datasets, out_dir, meta, workers=4, log=print):
    rpath = os.path.join(out_dir, "results-dev.json")
    fpath = os.path.join(out_dir, "frozen-a3.json")
    for p in (rpath, fpath):
        if os.path.exists(p):
            raise SystemExit(f"STOP: {p} exists. The development run is scored once.")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    global _SER
    D = build_dev(datasets)
    Bs = build_devblind(datasets)
    _SER = dict(D)
    _SER.update(Bs)
    bkeys = [f"bspan:{a}" for a in BSPAN_ASSETS] + [f"holdout:{p}" for p in HOLDOUTS]
    _SER["__folds__"] = {k: devblind_folds(Bs[k]) for k in bkeys}
    log(f"series built {time.time() - t_start:.0f}s")
    tasks = [("dev", a, T) for a in DEV_ASSETS for T in HORIZONS_H] + [("blind", k, T) for k in bkeys for T in HORIZONS_H]
    outs = run_pool(_dispatch, tasks, workers, log, t_start)
    t_fit = time.time() - t_start
    Rs, beta_rows, data_end = {}, [], {}
    for a in DEV_ASSETS:
        ls, os_ = D[f"long:{a}"], D[f"oracle:{a}"]
        R, br, de = assemble3(ls, dev_folds(ls), {T: outs[(f"dev:{a}", T)] for T in HORIZONS_H},
                              y_check=None if os_ is ls else os_)
        Rs[a], data_end[a] = R, de
        beta_rows += br
    stored = check_stored_a(datasets, Rs)
    for k in bkeys:
        R, br, _ = assemble3(Bs[k], _SER["__folds__"][k], {T: outs[(f"blind:{k}", T)] for T in HORIZONS_H})
        Rs[k] = R
        beta_rows += br
    log(f"assembled ({time.time() - t_start:.0f}s); scoring")
    # registered-seed draws (D-S1)
    rng = np.random.default_rng(SEED_REG)
    dev_days, dev_counts, boot_meta = {}, {}, {}
    res_dev, sels = {}, {}
    for a in DEV_ASSETS:
        R = Rs[a]
        res_dev[a] = {}
        for T_h in HORIZONS_H:
            days = np.unique(R["day"][R["T_h"] == T_h])
            idx, cnt = draws(rng, len(days), T_h)
            dev_days[(a, T_h)], dev_counts[(a, T_h)] = days, cnt
            boot_meta[f"{a}|{T_LABEL[T_h]}"] = _bmeta(days, idx, T_h)
            sc, sel, pos = score_series_T(R, T_h, cnt, days)
            sels[(a, T_h)] = (sel, pos)
            res_dev[a][T_LABEL[T_h]] = sc
            log(f"  scored {a} {T_LABEL[T_h]} ({time.time() - t_start:.0f}s)")
    res_blind = {}
    for k in bkeys:
        R = Rs[k]
        res_blind[k] = {"folds": R["fold_names"], "per_T": {}}
        for T_h in HORIZONS_H:
            days = np.unique(R["day"][R["T_h"] == T_h])
            idx, cnt = draws(rng, len(days), T_h)
            boot_meta[f"{k}|{T_LABEL[T_h]}"] = _bmeta(days, idx, T_h)
            sc, _, _ = score_series_T(R, T_h, cnt, days, with_labels=False)
            res_blind[k]["per_T"][T_LABEL[T_h]] = sc
        log(f"  scored {k} ({time.time() - t_start:.0f}s)")
    hk = [f"holdout:{p}" for p in HOLDOUTS]
    pooled = {}
    for T_h in HORIZONS_H:
        days = np.unique(np.concatenate([Rs[k]["day"][Rs[k]["T_h"] == T_h] for k in hk]))
        idx, cnt = draws(rng, len(days), T_h)
        boot_meta[f"POOLED_HOLDOUTS|{T_LABEL[T_h]}"] = _bmeta(days, idx, T_h)
        pooled[T_LABEL[T_h]] = pooled_series_stats(Rs, hk, T_h, cnt, days, RUNGS)
    log(f"  scored pooled holdouts ({time.time() - t_start:.0f}s)")
    # seed stability (A3.6)
    seed_counts = {a: {T_LABEL[T]: {"f": 0, "fb": 0} for T in HORIZONS_H} for a in DEV_ASSETS}
    seed_detail = {a: {T_LABEL[T]: {"f": [], "fb": []} for T in HORIZONS_H} for a in DEV_ASSETS}
    for s in SEEDS_FURTHER:
        rs = np.random.default_rng(s)
        for a in DEV_ASSETS:
            for T_h in HORIZONS_H:
                days = dev_days[(a, T_h)]
                _, cnt = draws(rs, len(days), T_h)
                sel, pos = sels[(a, T_h)]
                for r in ("f", "fb"):
                    lo = ci_lower(sel, pos, len(days), cnt, r, "a")
                    seed_detail[a][T_LABEL[T_h]][r].append(lo)
                    seed_counts[a][T_LABEL[T_h]][r] += int(lo is not None and lo > 0)
    log(f"  seed stability done ({time.time() - t_start:.0f}s)")
    # development-blind check and labels (A3.5), shipping (A3.6)
    shipped, frozen_labels = {}, {}
    label_rows = []
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            cell = res_dev[a][TL]
            bsp = res_blind.get(f"bspan:{a}", {}).get("per_T", {}).get(TL) if a in BSPAN_ASSETS else None
            hol = pooled[TL]
            labs = {r: {} for r in RUNGS}
            for kk, lvd in cell["levels"].items():
                on_ladder = float(kk) in [float(x) for x in LADDER]
                for r in RUNGS:
                    d = lvd[r]
                    out_l = {"pooled": d["pooled"]["label"] if d.get("pooled") else None}
                    for g in REGIMES:
                        st = d.get(g)
                        if st is None:
                            out_l[g] = {"dev": None, "outcome": "no rows", "after": None}
                            continue
                        b_stat = bsp["levels"].get(kk, {}).get(r, {}).get(g) if bsp else None
                        h_stat = hol["levels"].get(kk, {}).get(r, {}).get(g) if on_ladder else None
                        after, outcome = devblind_outcome(a, kk, st["label"], b_stat, h_stat, on_ladder)
                        out_l[g] = {"dev": st["label"], "outcome": outcome, "after": after, "n_ep": st["n_ep"],
                                    "R": st["R"], "R_ci95": st["R_ci95"], "cov_inf": st["cov_inf"],
                                    "n_inf_cells": st["n_inf_cells"],
                                    "bspan": {"R": b_stat["R"], "n_ep": b_stat["n_ep"]} if b_stat else None,
                                    "holdouts": {"R": h_stat["R"], "n_ep": h_stat["n_ep"]} if h_stat else None}
                        label_rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                           "dev_label": st["label"], "devblind_outcome": outcome,
                                           "label_after_devblind": after, "n_ep": st["n_ep"], "R": st["R"],
                                           "R_lo": (st["R_ci95"] or [None, None])[0],
                                           "R_hi": (st["R_ci95"] or [None, None])[1], "cov_inf": st["cov_inf"],
                                           "n_inf_cells": st["n_inf_cells"],
                                           "bspan_R": b_stat["R"] if b_stat else None,
                                           "bspan_n_ep": b_stat["n_ep"] if b_stat else None,
                                           "holdout_R": h_stat["R"] if h_stat else None,
                                           "holdout_n_ep": h_stat["n_ep"] if h_stat else None,
                                           "pooled_label": out_l["pooled"]})
                    labs[r][kk] = out_l
            comps = cell["comparisons"]
            elig = ["a"]
            elig_info = {}
            for r in ("f", "fb"):
                c = comps.get(f"{r}_vs_a")
                reg_ok = bool(c and c["ci_above_0"])
                n_ok = seed_counts[a][TL][r]
                elig_info[r] = {"registered_ci95": c["ci95"] if c else None, "registered_ok": reg_ok,
                                "seeds_ok": n_ok, "seeds_needed": MIN_SEEDS, "eligible": reg_ok and n_ok >= MIN_SEEDS}
                if elig_info[r]["eligible"]:
                    elig.append(r)
            dom = {}
            for y_ in elig:
                for x_ in elig:
                    if y_ != x_:
                        c = comps.get(f"{y_}_vs_{x_}")
                        dom[(y_, x_)] = bool(c and c["ci_above_0"])
            n_high = {r: sum(labs[r][kk][g]["after"] == "HIGH" for kk in labs[r] for g in REGIMES) for r in RUNGS}
            n_med = {r: sum(labs[r][kk][g]["after"] == "MEDIUM" for kk in labs[r] for g in REGIMES) for r in RUNGS}
            bss_a = {"a": 0.0, "f": (comps.get("f_vs_a") or {}).get("bss"), "fb": (comps.get("fb_vs_a") or {}).get("bss")}
            ship, info = ship_choice(elig, dom, n_high, n_med, bss_a)
            cell["shipping"] = {"eligibility": elig_info, "dominance": {f"{k[0]}>{k[1]}": v for k, v in dom.items()},
                                "n_high_after_devblind": n_high, "n_medium_after_devblind": n_med,
                                "bss_vs_a": bss_a, "shipped_rung": ship, **info}
            cell["labels"] = labs
            shipped.setdefault(a, {})[TL] = ship
            frozen_labels.setdefault(a, {})[TL] = labs
    # displayed numbers at DATA_END (frozen data)
    for a in DEV_ASSETS:
        de = data_end[a]
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            ti = HORIZONS_H.index(T_h)
            ship = shipped[a][TL]
            res_dev[a][TL]["p_data_end"] = {r: (de[r][ti].tolist() if r in de else None) for r in RUNGS}
            res_dev[a][TL]["beta_data_end"] = de["beta"][TL]
    # write predictions, tables
    for a in DEV_ASSETS:
        write_rows(os.path.join(out_dir, f"predictions-dev-{a}.csv.gz"), [(a, Rs[a])])
    for k in bkeys:
        write_rows(os.path.join(out_dir, f"predictions-devblind-{k.replace(':', '-')}.csv.gz"), [(k, Rs[k])])
    write_beta_table(os.path.join(out_dir, "beta-table.csv"), beta_rows)
    A.write_csv(os.path.join(out_dir, "labels-frozen.csv"),
                ["asset", "T", "k", "rung", "regime", "dev_label", "devblind_outcome", "label_after_devblind",
                 "pooled_label", "n_ep", "R", "R_lo", "R_hi", "cov_inf", "n_inf_cells", "bspan_R", "bspan_n_ep",
                 "holdout_R", "holdout_n_ep"], label_rows)
    counts = {a: {TL: {"before": _grid_counts(frozen_labels[a][TL][shipped[a][TL]], "dev"),
                       "after": _grid_counts(frozen_labels[a][TL][shipped[a][TL]], "after")}
                  for TL in shipped[a]} for a in DEV_ASSETS}
    frozen = {"what": "Q26 A3 frozen shipped rung per (asset, T) and every label, before the locked final set is read "
                      "(A3.6, D-F1)", "prereg": PREREG, "shipped": shipped, "labels": frozen_labels,
              "beta_data_end": {a: data_end[a]["beta"] for a in DEV_ASSETS},
              "fixed_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    doc = {"test": "Q26 workstream A3 -- development span and development-blind sets", "prereg": PREREG,
           "code": code_meta(), "inputs": meta, "environment": env_meta(workers), "DECISIONS": DECISIONS,
           "deviations_run": [], "stored_a_check": stored, "bootstrap": boot_meta, "seed_registered": SEED_REG,
           "seeds_further": list(SEEDS_FURTHER), "seed_stability": {"counts_ci_lower_above_0": seed_counts,
                                                                   "ci_lower_by_seed": seed_detail},
           "per_asset": res_dev, "devblind": {"per_series": res_blind, "pooled_holdouts": pooled},
           "beta_summary": beta_summary(beta_rows), "shipped": shipped,
           "label_counts_shipped_devblind": counts,
           "run": {"started_utc": started, "fit_predict_seconds": round(t_fit, 1)}}
    write_json(fpath, frozen, refuse_overwrite=True)
    fsha = A.sha256_file(fpath)
    with open(fpath + ".sha256", "w") as f:
        f.write(f"{fsha}  frozen-a3.json\n")
    doc["frozen_file"] = {"file": "frozen-a3.json", "sha256": fsha}
    doc["run"].update(total_seconds=round(time.time() - t_start, 1),
                      finished_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    write_json(rpath, doc, refuse_overwrite=True)
    log(f"results-dev written ({time.time() - t_start:.0f}s)")
    return doc


def _dispatch(t):
    kind, key, T_h = t
    if kind == "dev":
        k, T, r = dev_task((key, T_h))
        return f"dev:{k}", T, r
    k, T, r = series_task((key, T_h))
    return f"blind:{k}", T, r


def _bmeta(days, idx, T_h):
    return {"n_days": int(len(days)), "block_length": A.block_length(T_h),
            "first_day": A.iso(int(days[0]) * DAY) if len(days) else None,
            "last_day": A.iso(int(days[-1]) * DAY) if len(days) else None,
            "idx_sha256": hashlib.sha256(np.ascontiguousarray(idx, dtype=np.int64).tobytes()).hexdigest()}


def _grid_counts(labs_rung, key="after"):
    out = {g: {"HIGH": 0, "MEDIUM": 0, "LOW": 0, "insufficient": 0, "STALE": 0, "none": 0} for g in REGIMES}
    for kk, d in labs_rung.items():
        for g in REGIMES:
            v = d[g].get(key) if isinstance(d[g], dict) else None
            out[g][v if v else "none"] += 1
    return out


# ---------------------------------------------------------------------------------------------
# Phase: locked final blind set (ONCE, after the freeze)
# ---------------------------------------------------------------------------------------------
def locked_path(datasets, sid):
    for ext in (".json", ".json.gz"):
        rel = f"{LOCKED_DIR}/{sid}-1h{ext}"
        if os.path.exists(os.path.join(datasets, rel)):
            return rel
    raise SystemExit(f"STOP: locked series file for {sid} not found")


def git_blob_check(datasets, rel):
    want = subprocess.run(["git", "-C", datasets, "rev-parse", f"{LOCKED_COMMIT}:{rel}"], capture_output=True,
                          text=True)
    got = subprocess.run(["git", "-C", datasets, "hash-object", rel], capture_output=True, text=True)
    if want.returncode != 0 or got.returncode != 0 or want.stdout.strip() != got.stdout.strip():
        raise SystemExit(f"STOP: {rel} does not match the git blob at {LOCKED_COMMIT}")
    return {"path": rel, "git_blob": got.stdout.strip(), "sha256": A.sha256_file(os.path.join(datasets, rel)),
            "verified_against": LOCKED_COMMIT}


def load_locked_grid(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    d = json.loads(raw)
    st, step, cnt = int(d["startTs"]), int(d["stepSeconds"]), int(d["count"])
    if step != STEP or st % STEP:
        raise SystemExit(f"STOP: {path} not an hourly grid")
    if st + STEP * cnt != DATA_END:
        raise SystemExit(f"STOP: {path} does not end at the hour opening 2026-10-06T02:00Z")
    cols = {c: np.array([np.nan if v is None else float(v) for v in d["columns"][c]], float) for c in ("close", "low")}
    return st, cols


def build_locked(datasets, verify=True):
    S, meta, spans = {}, {}, {}
    for sid, label, sfirst, last in LOCKED_SERIES:
        rel = locked_path(datasets, sid)
        meta[sid] = git_blob_check(datasets, rel) if verify else {"path": rel, "verified": False}
        st, cols = load_locked_grid(os.path.join(datasets, rel))
        ser = S3(f"locked:{sid}", label, "locked", cols["close"], cols["low"], LADDER, st, st)
        S[f"locked:{sid}"] = ser
        first, lastq = locked_fold_span(st, sfirst, last)
        spans[f"locked:{sid}"] = quarters(first, lastq, ser)
        meta[sid].update(first_candle=A.iso(st), folds=[f["name"] for f in spans[f"locked:{sid}"]],
                         first_fold_equals_D1=(sfirst is None or first == sfirst))
    return S, meta, spans


def run_locked(datasets, out_dir, meta_inputs, workers=4, log=print, verify=True):
    lpath = os.path.join(out_dir, "results-locked.json")
    marker = os.path.join(out_dir, "locked-run.started")
    if os.path.exists(lpath) or os.path.exists(marker):
        raise SystemExit("STOP: the locked set has already been read (results-locked.json or the start marker "
                         "exists). It is read once.")
    fpath, dpath = os.path.join(out_dir, "frozen-a3.json"), os.path.join(out_dir, "results-dev.json")
    if not (os.path.exists(fpath) and os.path.exists(dpath)):
        raise SystemExit("STOP: frozen-a3.json and results-dev.json must exist before the locked set is read.")
    with open(dpath) as f:
        dev = json.load(f)
    fsha = A.sha256_file(fpath)
    if fsha != dev["frozen_file"]["sha256"]:
        raise SystemExit(f"STOP: frozen-a3.json sha256 {fsha} != recorded {dev['frozen_file']['sha256']}")
    with open(fpath) as f:
        frozen = json.load(f)
    with open(marker, "w") as f:
        f.write(json.dumps({"started_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                            "frozen_sha256": fsha}) + "\n")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    global _SER
    S, lmeta, spans = build_locked(datasets, verify=verify)
    keys = [f"locked:{sid}" for sid, *_ in LOCKED_SERIES]
    active = [k for k in keys if spans[k]]
    _SER = dict(S)
    _SER["__folds__"] = spans
    log(f"locked series built {time.time() - t_start:.0f}s; active {len(active)}/{len(keys)}")
    tasks = [(k, T) for k in active for T in HORIZONS_H]
    outs = run_pool(series_task, tasks, workers, log, t_start)
    Rs, beta_rows = {}, []
    for k in active:
        R, br, _ = assemble3(S[k], spans[k], {T: outs[(k, T)] for T in HORIZONS_H})
        Rs[k] = R
        beta_rows += br
    rng = np.random.default_rng(SEED_LOCKED)
    per_series, boot_meta = {}, {}
    for k in active:
        per_series[k] = {"folds": Rs[k]["fold_names"], "per_T": {}}
        for T_h in HORIZONS_H:
            days = np.unique(Rs[k]["day"][Rs[k]["T_h"] == T_h])
            if len(days) < A.block_length(T_h):
                per_series[k]["per_T"][T_LABEL[T_h]] = {"skipped": f"{len(days)} days < block length"}
                continue
            idx, cnt = draws(rng, len(days), T_h)
            boot_meta[f"{k}|{T_LABEL[T_h]}"] = _bmeta(days, idx, T_h)
            sc, _, _ = score_series_T(Rs[k], T_h, cnt, days, with_labels=False)
            per_series[k]["per_T"][T_LABEL[T_h]] = sc
        log(f"  scored {k} ({time.time() - t_start:.0f}s)")
    pooled = {}
    for T_h in HORIZONS_H:
        days = np.unique(np.concatenate([Rs[k]["day"][Rs[k]["T_h"] == T_h] for k in active]))
        idx, cnt = draws(rng, len(days), T_h)
        boot_meta[f"POOLED_LOCKED|{T_LABEL[T_h]}"] = _bmeta(days, idx, T_h)
        pooled[T_LABEL[T_h]] = pooled_series_stats(Rs, active, T_h, cnt, days, RUNGS)
    # final labels (A3.7)
    final, rows = {}, []
    ladder_keys = {repr(float(x)) for x in LADDER}
    for a in DEV_ASSETS:
        for TL, labs in frozen["labels"][a].items():
            for r, lv in labs.items():
                for kk, d in lv.items():
                    for g in REGIMES:
                        e = d[g]
                        if not isinstance(e, dict) or e.get("after") is None:
                            continue
                        st = pooled[TL]["levels"].get(kk, {}).get(r, {}).get(g) if kk in ladder_keys else None
                        fl, oc = final_outcome(e["after"], st, on_ladder=kk in ladder_keys)
                        final.setdefault(a, {}).setdefault(TL, {}).setdefault(r, {}).setdefault(kk, {})[g] = {
                            "frozen": e["after"], "final": fl, "outcome": oc,
                            "locked": {"R": st["R"], "n_ep": st["n_ep"]} if st else None}
                        rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                     "shipped": frozen["shipped"][a][TL] == r, "frozen_label": e["after"],
                                     "final_label": fl, "final_outcome": oc,
                                     "locked_R": st["R"] if st else None, "locked_n_ep": st["n_ep"] if st else None})
    A.write_csv(os.path.join(out_dir, "labels-final.csv"),
                ["asset", "T", "k", "rung", "regime", "shipped", "frozen_label", "final_label", "final_outcome",
                 "locked_R", "locked_n_ep"], rows)
    for k in active:
        write_rows(os.path.join(out_dir, f"predictions-locked-{k.split(':', 1)[1]}.csv.gz"), [(k, Rs[k])])
    write_beta_table(os.path.join(out_dir, "beta-table-locked.csv"), beta_rows)
    counts = {}
    for a in DEV_ASSETS:
        for TL in final[a]:
            ship = frozen["shipped"][a][TL]
            cg = {g: {"HIGH": 0, "MEDIUM": 0, "LOW": 0, "insufficient": 0, "STALE": 0} for g in REGIMES}
            for kk, d in final[a][TL][ship].items():
                for g, e in d.items():
                    cg[g][e["final"]] += 1
            counts.setdefault(a, {})[TL] = cg
    doc = {"test": "Q26 workstream A3 -- locked final blind set (A3.7, read once)", "prereg": PREREG,
           "code": code_meta(), "inputs": meta_inputs, "environment": env_meta(workers), "DECISIONS": DECISIONS,
           "deviations_run": [], "frozen_file": {"file": "frozen-a3.json", "sha256": fsha},
           "results_dev_sha256": A.sha256_file(dpath), "locked_files": lmeta, "seed": SEED_LOCKED,
           "bootstrap": boot_meta, "per_series": per_series, "pooled": pooled, "beta_summary": beta_summary(beta_rows),
           "final_labels": final, "label_counts_shipped_final": counts, "shipped": frozen["shipped"],
           "run": {"started_utc": started, "total_seconds": round(time.time() - t_start, 1),
                   "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}}
    write_json(lpath, doc, refuse_overwrite=True)
    log(f"results-locked written ({time.time() - t_start:.0f}s)")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: panel (A3.8)
# ---------------------------------------------------------------------------------------------
def run_panel(datasets, out_dir, meta, try_rpc=True, log=print):
    path = os.path.join(out_dir, "panel.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    with open(os.path.join(out_dir, "results-dev.json")) as f:
        dev = json.load(f)
    lpath = os.path.join(out_dir, "results-locked.json")
    with open(lpath) as f:
        locked = json.load(f)
    fpath = os.path.join(out_dir, "frozen-a3.json")
    if A.sha256_file(fpath) != dev["frozen_file"]["sha256"]:
        raise SystemExit("STOP: frozen-a3.json sha256 mismatch")
    with open(fpath) as f:
        frozen = json.load(f)
    shipped, final = frozen["shipped"], locked["final_labels"]
    D = build_dev(datasets)
    panel = {"phase": "panel", "prereg": PREREG, "code": code_meta(), "inputs": meta,
             "results_dev_sha256": A.sha256_file(os.path.join(out_dir, "results-dev.json")),
             "results_locked_sha256": A.sha256_file(lpath), "frozen_sha256": dev["frozen_file"]["sha256"],
             "display_rule": "every cell: number, current regime, the current regime's final label, n_ep, period, "
                             "rung (A3.8, D-P1)", "assets": {}}
    asof_info = {"data_end": A.iso(DATA_END), "source": "dataset", "asof": A.iso(DATA_END)}
    live, live_rounds = {}, {}
    if try_rpc:
        now = int(time.time())
        asof_ts = (now // STEP) * STEP
        try:
            rpc = A.Rpc()
            for a in DEV_ASSETS:
                proxy, dec = A.FEEDS[a]
                desc = rpc.call_many([(proxy, A.SEL_DESC)])[0]
                dtxt = desc[64:64 + int.from_bytes(desc[32:64], "big")].decode() if desc else None
                rounds = A.chainlink_rounds_since(rpc, proxy, DATA_END)
                live_rounds[a] = rounds
                r_asof = A.answer_in_force(rounds, asof_ts)
                live[a] = {"description": dtxt, "decimals": dec,
                           "in_force_at_asof": {"roundId": str(r_asof["roundId"]), "updatedAt": r_asof["updatedAt"],
                                                "updatedAt_iso": A.iso(r_asof["updatedAt"]),
                                                "price": r_asof["answer"] / 10 ** dec},
                           "n_rounds_after_data_end": int(sum(r["updatedAt"] > DATA_END for r in rounds))}
            asof_info = {"data_end": A.iso(DATA_END), "source": "chainlink getRoundData via public RPC",
                         "asof": A.iso(asof_ts), "rpc_calls": rpc.calls, "rpc_errors": rpc.errors,
                         "read_at_utc": A.iso(now)}
        except Exception as e:
            asof_info["rpc_failed"] = f"{type(e).__name__}: {e}"
            live, live_rounds = {}, {}
    panel["asof"] = asof_info
    panel["live_chainlink"] = live
    asof_ts = A.utc(asof_info["asof"])
    if live_rounds:
        rp = os.path.join(out_dir, "panel-chainlink-rounds.csv.gz")
        n_r = A.write_rounds_csv(rp, live, live_rounds, asof_ts)
        panel["chainlink_rounds_file"] = {"file": "panel-chainlink-rounds.csv.gz", "rows": n_r,
                                          "sha256": A.sha256_file(rp)}
    grids_all, regime_now = {}, {}
    for a in DEV_ASSETS:
        ser = D[f"long:{a}"]
        if a in live_rounds and asof_ts > DATA_END:
            dec = A.FEEDS[a][1]
            ends = np.arange(DATA_END + STEP, asof_ts + 1, STEP)
            ext = np.array([A.answer_in_force(live_rounds[a], int(e))["answer"] / 10 ** dec for e in ends])
        else:
            ext = np.array([])
        sx = S3(ser.name, a, ser.truth, np.concatenate([ser.close, ext]), np.concatenate([ser.low, ext]),
                ser.levels, ser.base_ts, ser.ts(ser.start_i)) if len(ext) else ser
        i_now = sx.N
        g_now = int(sx.regime[i_now])
        regime_now[a] = REGIMES[g_now] if g_now >= 0 else None
        grids = {}
        betas = {}
        for ti, T_h in enumerate(HORIZONS_H):
            P = Prep3(sx, T_h, q_max=ser.N)
            beta, binfo = P.choose_beta(ser.N)
            betas[T_LABEL[T_h]] = {"beta": beta, **binfo}
            o = predict3(sx, P, T_h, ser.N, np.array([i_now]), beta)
            Po = Prep3(D[f"oracle:{a}"], T_h, beta_select=False)
            o["raw"]["a"] = Po.freq_upto(ser.N - T_h)[None, :]
            for r, v in o["raw"].items():
                grids.setdefault(r, np.full((len(HORIZONS_H), len(ser.levels)), np.nan))[ti] = v[0]
        fixed = {r: A.monotone_fix(g[None])[0] for r, g in grids.items() if not np.isnan(g).any()}
        grids_all[a] = fixed
        cells = {}
        for ti, T_h in enumerate(HORIZONS_H):
            TL = T_LABEL[T_h]
            ship = shipped[a][TL]
            per = dev["per_asset"][a][TL]["counts"]["period"]
            row = {"rung": ship, "beta": betas[TL]["beta"] if ship == "fb" else None, "regime_now": regime_now[a],
                   "period": per, "levels": {}}
            for j, k in enumerate(ser.levels):
                kk = repr(float(k))
                p = float(fixed[ship][ti, j])
                g = regime_now[a]
                e = final[a][TL][ship][kk].get(g) if g else None
                lab = e["final"] if e else "no regime"
                n_ep = frozen["labels"][a][TL][ship][kk][g].get("n_ep") if g and isinstance(
                    frozen["labels"][a][TL][ship][kk][g], dict) else None
                row["levels"][kk] = {"p": p, "regime": g, "label": lab, "n_ep": n_ep,
                                     "final_outcome": e["outcome"] if e else None,
                                     "labels_all_regimes": {gg: (final[a][TL][ship][kk].get(gg) or {}).get("final")
                                                            for gg in REGIMES},
                                     "display": f"{A.fmt_p(p)} {lab} ({g} vol, n_ep {n_ep})"}
            cells[TL] = row
        panel["assets"][a] = {"cells": cells, "regime_now": regime_now[a],
                              "rv_pct_now": float(sx.rv_pct[i_now]) if np.isfinite(sx.rv_pct[i_now]) else None,
                              "sigma_hat_now": float(sx.sigma[i_now]), "sigma_ref_now": float(sx.sigma_ref[i_now]),
                              "live_hours_spliced": int(len(ext)), "betas_data_end": betas,
                              "grids_fixed_all_rungs": {r: g.tolist() for r, g in fixed.items()}}
    # ETH ACTION example
    lv = list(LEVELS["ETH"])
    Sx = live["ETH"]["in_force_at_asof"]["price"] if "ETH" in live else float(D["oracle:ETH"].close[-1])
    C, LT = A.EXAMPLE["collateral_units"], A.EXAMPLE["LT"]
    Dd = C * LT * Sx * (1.0 + A.EXAMPLE["line_distance"])
    y_now = Dd / (C * LT) / Sx - 1.0
    ti7 = HORIZONS_H.index(A.ACTION_T_H)
    g = regime_now["ETH"]
    ship7 = shipped["ETH"]["7d"]
    lab = lambda TL, k: (final["ETH"][TL][shipped["ETH"][TL]][repr(float(k))].get(g) or {}).get("final", "no regime")  # noqa: E731
    probs7 = [float(v) for v in grids_all["ETH"][ship7][ti7]]
    rows = A.action_rows(lv, probs7, Dd, C, LT, Sx, y_now=y_now)
    for r in rows:
        y_t = r.get("y_star", r.get("line_after"))
        if y_t is None:
            y_t = lv[0] if r["status"] == "shallower_than_grid" else lv[-1]
        k0, k1 = M2.bracket_levels(lv, y_t)
        r["label"] = M2.worse_label(lab("7d", k0), lab("7d", k1)) if g else "no regime"
        r["display"] = f"{r['text']} [{r['label']}, {g} vol]"
    cur = {}
    for ti, T_h in enumerate(HORIZONS_H):
        TL = T_LABEL[T_h]
        pT = [float(v) for v in grids_all["ETH"][shipped["ETH"][TL]][ti]]
        p, st = A.p_at_distance(lv, pT, y_now)
        k0, k1 = M2.bracket_levels(lv, y_now)
        lb = M2.worse_label(lab(TL, k0), lab(TL, k1)) if g else "no regime"
        txt = A.fmt_p(p) if st == "ok" else (A.fmt_bound(">", pT[0]) if st == "shallower_than_grid" else
                                             A.fmt_bound("<", pT[-1]))
        cur[TL] = {"rung": shipped["ETH"][TL], "p": p, "status": st, "label": lb, "display": f"{txt} {lb} ({g} vol)"}
    panel["action_example"] = {
        "label": "EXAMPLE position (not a real position; no number goes into app code)",
        "position": {"collateral": f"{C:g} ETH", "LT": LT, "spot_S": Sx, "debt_D_usd": Dd, "P_liq": Dd / (C * LT),
                     "distance_y": y_now}, "regime_now": g, "seven_day_rung": ship7, "rows": rows,
        "display": [r["display"] for r in rows], "current_line_by_horizon": cur}
    write_json(path, panel, refuse_overwrite=True)
    return panel


# ---------------------------------------------------------------------------------------------
def run_manifest(out_dir):
    files = sorted(f for f in os.listdir(out_dir) if f != "manifest.json" and not f.startswith("."))
    man = {"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta(),
           "prereg": PREREG,
           "files": {f: {"bytes": os.path.getsize(os.path.join(out_dir, f)),
                         "sha256": A.sha256_file(os.path.join(out_dir, f))} for f in files}}
    big = [f for f, v in man["files"].items() if v["bytes"] >= 50 * 1024 * 1024]
    if big:
        raise SystemExit(f"STOP: files >= 50 MB: {big}")
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
        f.write("\n")
    return man


def verify_dev_inputs(datasets):
    meta = M2.verify_all(datasets)
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", choices=("dryrun", "dev", "locked", "panel", "manifest"), required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--no-rpc", action="store_true")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    if a.phase == "manifest":
        run_manifest(a.out)
        return 0
    meta = verify_dev_inputs(a.datasets)
    print("inputs verified", flush=True)
    log = lambda *x: print(*x, flush=True)  # noqa: E731
    if a.phase == "dryrun":
        run_dryrun(a.datasets, a.out, meta, log=log)
    elif a.phase == "dev":
        run_dev(a.datasets, a.out, meta, workers=a.workers, log=log)
    elif a.phase == "locked":
        run_locked(a.datasets, a.out, meta, workers=a.workers, log=log)
    elif a.phase == "panel":
        run_panel(a.datasets, a.out, meta, try_rpc=not a.no_rpc, log=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
