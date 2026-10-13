#!/usr/bin/env python3
"""Q26 workstream A -- history-repeats liquidation touch ladder.

Implements triccs/membrane-board `design/HISTORY_TOUCH_PREREG.md` (registered at commit d616a42,
file sha256 dd2c3b8b7424a1ad9bbafbea2c123fcbf9bb060011df384b3062fee4e078a7db) as registered.
Every constant below comes from that file. Changing one is a deviation.

Phases (run in this order, fresh --out to reproduce):
  python3 a_touch.py --datasets DIR --out DIR --phase dryrun    data-only counts -> dryrun.json
  python3 a_touch.py --datasets DIR --out DIR --phase run       fit + predict + score ONCE -> results.json ...
  python3 a_touch.py --datasets DIR --out DIR --phase panel     refit shipped rungs to DATA_END -> panel.json
  python3 a_touch.py --datasets DIR --out DIR --phase manifest  sha256 of every output -> manifest.json
The dry run computes no Brier, BSS or label frequency. The run phase refuses to overwrite an
existing results.json (scored once).

Rungs: (a) expanding frequency, (b) recency-weighted frequency (H = 365 d), (c) weighted logistic
on rv_pct / trend90 / dd90, (d) (c) plus a DVOL touch-probability feature. Light models only.
"""
import argparse
import bisect
import csv
import gzip
import hashlib
import io
import json
import math
import multiprocessing as mp
import os
import platform
import subprocess
import sys
import time
import urllib.request
import warnings
from datetime import datetime, timezone

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.special import ndtr
from scipy.stats import binom

# ---------------------------------------------------------------------------------------------
# Registered constants (prereg A.1-A.8)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG.md",
    "commit": "d616a42",
    "sha256": "dd2c3b8b7424a1ad9bbafbea2c123fcbf9bb060011df384b3062fee4e078a7db",
}

INPUTS = {  # A.1 frozen inputs: relative path in membrane-datasets @ 03daad5 -> sha256
    "eth_price": ("price-history/eth-usd-1h.json",
                  "48b53d72351dbba6b05939a75660babc361678304747bf764d59e97d968bd26c"),
    "btc_price": ("price-history/btc-usd-1h.json",
                  "07ba823671e557a7a73415903f8c4be153c1bb6f0ca1215361eb2304a6bd5d37"),
    "steth_price": ("price-history/steth-eth-1h.json",
                    "dd24ac5600438fb305d7920b43ae9a6d6889358f2382b63d45c6887f14a7e973"),
    "eth_dvol": ("deribit-dvol/dvol-eth-1h.json",
                 "c55620d0227bb88f3d695a51c6c6ffefbd90db04428fa88728127d64011a9617"),
    "btc_dvol": ("deribit-dvol/dvol-btc-1h.json",
                 "e736f4cde9de756d3ebd7916373d60f1c15aec4940f86b3b06e6dead1fc7308d"),
}

START_TS = 1577836800  # hour i opens at START_TS + 3600*i
STEP = 3600
DAY = 86400


def utc(s):
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


def iso(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


DATA_END = utc("2026-10-06T03:00:00Z")  # A.1: last hour opens 02:00Z

ASSETS = ("ETH", "BTC", "stETH")
SECONDARY_ASSETS = ("ETH", "BTC")
D_ASSETS = ("ETH", "BTC")
LEVELS = {  # A.2, ordered shallow -> deep
    "ETH": (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.25, -0.30, -0.40),
    "BTC": (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.25, -0.30, -0.40),
    "stETH": (-0.005, -0.01, -0.02, -0.05),
}
HORIZONS_H = (6, 24, 72, 168, 336, 720)               # A.2, ordered short -> long
T_DAYS = {6: 0.25, 24: 1.0, 72: 3.0, 168: 7.0, 336: 14.0, 720: 30.0}
T_LABEL = {6: "6h", 24: "1d", 72: "3d", 168: "7d", 336: "14d", 720: "30d"}

COVERAGE_START = {  # A.1 oracle coverage with no internal nulls (hour OPEN of the first close)
    "ETH": utc("2020-04-08T21:00:00Z"),
    "BTC": utc("2020-01-01T00:00:00Z"),
    "stETH": utc("2021-08-25T19:00:00Z"),
}
BINANCE_COVERAGE_START = START_TS  # secondary truth: binance columns from the grid start

FOLD_SPAN = {"ETH": ((2021, 1), (2026, 3)), "BTC": ((2021, 1), (2026, 3)),
             "stETH": ((2022, 4), (2026, 3))}  # A.3
D_FOLD_SPAN = ((2022, 2), (2026, 3))               # A.3 rung (d), ETH and BTC only
ISSUE_EVERY_H = 6                                   # A.3: 00, 06, 12, 18Z

H_MAIN = 365.0              # A.4 (b) half-life, days
H_SENS = (180.0, 730.0)     # A.4 (b) sensitivity, never deciding
RV_HOURS = 720              # A.4 (c) RV30 over 720 hourly log returns
RV_ANNUAL = 8760.0
PCT_WINDOW_H = 730 * 24     # rv_pct over [t - 730 d, t)
PCT_MIN_PAST = 2160         # >= 2,160 defined past values
LB90_H = 90 * 24            # trend90 / dd90 lookback
DVOL_CLIP = 1e-4            # A.4 (d)
MIN_EPISODES = 5            # A.4 (c) fallback
LOGIT_KW = dict(penalty="l2", C=1.0, solver="lbfgs", max_iter=1000)  # A.4 (c), intercept on

N_BOOT = 2000               # A.5
SEED_BLOCK = 20261013
SEED_IID = 20261014
ECE_BINS = 10
REF_RV_DAYS = {"rv30": 30, "rv90": 90}  # reference (Q25 T1.2 estimator)

ACTION_T_H = 168            # A.8 reverse solve at T = 7 d
ACTION_Z = (0.10, 0.05, 0.01)
ACTION_LOGIT_CLIP = 1e-6    # DECISION: keeps logit finite when a grid p is exactly 0 or 1
EXAMPLE = {"collateral_units": 10.0, "asset": "ETH", "LT": 0.83, "line_distance": -0.25}

RUNGS = ("a", "b", "c", "d")


def block_length(T_h):
    return int(max(30, 2 * T_DAYS[T_h]))  # A.5: 30 for 6 h to 14 d, 60 for 30 d


DECISIONS = [
    "D1 coverage: oracle/oracleLow values in hours opening before the A.1 coverage start are treated as "
    "null (ETH has a 49-hour pre-coverage island 2020-01-15T21:00Z..2020-01-17T21:00Z; it is excluded). "
    "Secondary truth (binance/binanceLow) uses the grid start 2020-01-01T00:00Z as coverage start; its "
    "32 null hours are handled by the null rule.",
    "D2 indexing: origin t_i = 1577836800 + 3600*i (i = 0..N, i = N is DATA_END). C(t_i) = close of the hour "
    "opening at t_i - 1h = col[i-1]. S(t_i) = oracle[i-1]. Label window = oracleLow[i .. i+T_h-1]; L = "
    "S*(1.0+k) in float64; y = 1 iff window min <= L. A null S or any null low in the window -> no label "
    "(for every level and rung).",
    "D3 RV30(t_i) = sqrt(8760 * sum(r^2)/720), r_j = ln(C[j]/C[j-1]) for the 720 returns j = i-720..i-1 "
    "(721 closes C[i-721..i-1]); any null close -> undefined. Sum = numpy sum over the 720-wide window.",
    "D4 rv_pct(t_i) = #{s in [i-17520, i-1] : RV30(s) defined and RV30(s) <= RV30(t_i)} / #{s in that range: "
    "RV30(s) defined}; undefined if RV30(t_i) is undefined or fewer than 2160 defined past values.",
    "D5 trend90 = ln(C[i-1] / C[i-1-2160]) (C(t-90d) = close of the hour opening t-90d-1h). dd90 = C[i-1] / "
    "max(C[i-2160 .. i-1]) - 1 (the 2160 hourly prices at times in (t-90d, t]). Any null -> undefined.",
    "D6 standardization: weighted mean mu = sum(w x)/sum(w), weighted population std sqrt(sum(w (x-mu)^2)/"
    "sum(w)), w = the (b) recency weights of the fit's rows; a zero std is replaced by 1.",
    "D7 logistic: sklearn LogisticRegression(penalty='l2', C=1.0, solver='lbfgs', max_iter=1000) exactly as "
    "registered (fit_intercept default True; lbfgs does not penalize the intercept; tol default 1e-4). "
    "sklearn 1.9 emits a FutureWarning for penalty='l2' (equivalent to l1_ratio=0); it is suppressed. "
    "sample_weight = w / mean(w) over the fit's rows. ConvergenceWarnings are counted and reported.",
    "D8 episodes: counted on the rung's own training rows (c: labelled origins with all three features; "
    "d: those with a DVOL candle at t-1h too), sorted by time. A run breaks at a label change or at a gap "
    "> 1 h between consecutive training rows.",
    "D9 fallback chain (before the monotone fix): c cell fallback -> raw (b) prediction; c test row with an "
    "undefined feature -> raw (b). d cell fallback -> raw (c) prediction (itself possibly (b)); d test row "
    "with an undefined feature or no DVOL -> raw (c). Each rung's grid is then monotone-fixed on its own.",
    "D10 monotone fix per (asset, t0) over the rung's full grid of predictions (all 6 horizons x levels, "
    "predictions exist for every horizon); rows without a label are dropped after the fix. This equals a "
    "fix over labelled rows only, because label availability at a t0 is a prefix of the horizon order.",
    "D11 day sets: sorted unique UTC dates of t0 over scored rows of (asset, T) in the set's folds (full = "
    "all folds of the asset; d = 2022Q2..2026Q3). Draw order: asset (ETH, BTC, stETH) > horizon (6h..30d) > "
    "set (full, then d). The day-level i.i.d. draws (block 1, rng 20261014) follow the same order.",
    "D12 CI = numpy.percentile(finite replicate BSS, [2.5, 97.5]) (linear). 'Entirely above 0' = lower "
    "bound > 0 (strict). Var_iid and Var_block use ddof=1 over finite replicates.",
    "D13 non-deciding sets reuse the registered draws of the same (asset, T, set): binance-truth rows are "
    "mapped to the oracle day set by date (dates not in it are dropped; the count is reported). Pooled "
    "ETH+BTC uses the union of dates and new draws from the same two generators continued after every "
    "registered draw (order 6h..30d, full then d).",
    "D14 reference RV30/RV90 raw = Q25 T1.2 estimator at each 6-hourly t0: P_j = close of the hour opening "
    "t0-1h-j*86400 (j = 0..30 / 0..90), log returns, mean removed, ddof=1, x365, sqrt; p = min(1, 2*Phi(ln(1+k)"
    "/(sigma*sqrt(T_days/365)))), T_days 0.25 for 6 h. Not monotone-fixed (monotone by construction). "
    "Secondary truth: same estimator on binance closes.",
    "D15 n_windows = n_issue * 6 / max(T_h, 6) as a float (not floored), n_issue = distinct t0 with a "
    "scored row. Coverage n_w per (fold, level) cell = max(1, floor(n_rows * 6 / max(T_h, 6))) (one row per "
    "t0 per level). Cells with no rows are skipped.",
    "D16 shipping climbs on the per-(asset, T) cell pass flags, not on the per-asset verdict. The "
    "confidence label of a shipped rung uses that rung's rows (the d set if (d) ships).",
    "D17 H sensitivity (180 d, 730 d) is applied to rung (b) only, monotone-fixed like every rung.",
    "D18 'higher rung beats both rungs below a failed rung': for a failed rung f (f fails vs f-1), a higher "
    "rung r is flagged when BSS(r vs f) and BSS(r vs f-1) both have CI lower bound > 0. Reported only.",
    "D19 ACTION: logit(p) uses p clipped to [1e-6, 1-1e-6]. Reverse solve searches adjacent grid levels "
    "shallow->deep for the first bracket with logit p_shallow >= logit Z >= logit p_deep and interpolates "
    "ln(1+y*) linearly. Z above p(-2%) -> y* shallower than the grid (repay <= 0 at the example). Z below "
    "p(-40%) -> unsolvable inside the grid (reported with the -40% repay as a lower bound). X = ceil((D - "
    "C*LT*S*(1+y*))/10)*10 with the raw amount rounded to 1e-6 first (float noise). Shown distance = the line after repaying X, whole %, magnitude floored (toward "
    "spot) after rounding to 1e-9.",
    "D20 panel: each rung's full grid at asof is monotone-fixed, then the shipped rung is taken per horizon. "
    "History count = non-overlapping windows over the asset's full labelled history: start at the first "
    "6-hourly origin with a label, step max(T, 6h), windows without a label skipped; k = touched windows.",
]


# ---------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_inputs(datasets_dir):
    """A.1 sha256 check. Any mismatch -> SystemExit (STOP)."""
    meta = {}
    for key, (rel, want) in INPUTS.items():
        path = os.path.join(datasets_dir, rel)
        got = sha256_file(path)
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for {rel}: got {got}, registered {want}")
        meta[key] = {"path": rel, "sha256": got, "bytes": os.path.getsize(path), "verified": True}
    return meta


def _arr(values):
    return np.array([np.nan if v is None else float(v) for v in values], dtype=float)


def load_price(path, cols=("oracle", "oracleLow", "binance", "binanceLow")):
    with open(path) as f:
        d = json.load(f)
    if int(d["startTs"]) != START_TS or int(d["stepSeconds"]) != STEP:
        raise SystemExit(f"STOP: {path} grid is not startTs={START_TS}, step={STEP}")
    out = {c: _arr(d["columns"][c]) for c in cols if c in d["columns"]}
    n = len(out["oracle"])
    if START_TS + STEP * n != DATA_END:
        raise SystemExit(f"STOP: {path} grid ends at {iso(START_TS + STEP * n)}, registered DATA_END "
                         f"{iso(DATA_END)}")
    return out


def load_dvol_array(path, n_hours):
    """-> array a with a[j] = close of the DVOL candle opening at START_TS + 3600*j (NaN if absent),
    length n_hours + 1 (so the candle opening at DATA_END - 1h is the last one used by any origin)."""
    with open(path) as f:
        d = json.load(f)
    a = np.full(n_hours + 1, np.nan)
    for row in d["rows"]:
        open_ms = int(row[0])
        if open_ms % 1000:
            raise SystemExit(f"STOP: DVOL open_ms not whole seconds: {open_ms}")
        ts = open_ms // 1000
        if (ts - START_TS) % STEP:
            raise SystemExit(f"STOP: DVOL candle not on the hourly grid: {ts}")
        j = (ts - START_TS) // STEP
        if 0 <= j < len(a) and row[4] is not None:
            a[j] = float(row[4])
    return a


# ---------------------------------------------------------------------------------------------
# Labels and features (A.2, A.4)
# ---------------------------------------------------------------------------------------------
def spot_series(close):
    """S(t_i) = close of the hour opening at t_i - 1h = close[i-1]; length N+1, S[0] = NaN."""
    s = np.full(len(close) + 1, np.nan)
    s[1:] = close
    return s


def window_min(low, T_h):
    """wmin[i] = min(low[i .. i+T_h-1]) for origins i = 0..N (NaN if any null or past the grid)."""
    out = np.full(len(low) + 1, np.nan)
    if len(low) >= T_h:
        v = sliding_window_view(low, T_h).min(axis=1)  # NaN propagates
        out[:len(v)] = v
    return out


def make_labels(spot, wmin, levels):
    """(N+1, n_levels) float array, NaN = no label."""
    ok = np.isfinite(spot) & np.isfinite(wmin)
    y = np.full((len(spot), len(levels)), np.nan)
    for j, k in enumerate(levels):
        y[ok, j] = (wmin[ok] <= spot[ok] * (1.0 + k)).astype(float)
    return y


def rv30_series(close, rv_h=RV_HOURS):
    """RV30 at origins i = 0..N (D3)."""
    n_orig = len(close) + 1
    r = np.full(len(close), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[1:] = np.log(close[1:] / close[:-1])
    out = np.full(n_orig, np.nan)
    if len(r) >= rv_h:
        s = sliding_window_view(r * r, rv_h).sum(axis=1)   # s[m] -> origin m + rv_h
        out[rv_h:rv_h + len(s)] = np.sqrt(RV_ANNUAL * s / rv_h)
    return out


def rv_pct_series(rv, window=PCT_WINDOW_H, min_past=PCT_MIN_PAST):
    """rv_pct at each origin from RV30 values at origins [i - window, i - 1] only (D4)."""
    n = len(rv)
    out = np.full(n, np.nan)
    fin = np.isfinite(rv)
    sl = []
    for i in range(n):
        j = i - 1
        if j >= 0 and fin[j]:
            bisect.insort(sl, rv[j])
        old = i - window - 1
        if old >= 0 and fin[old]:
            del sl[bisect.bisect_left(sl, rv[old])]
        if fin[i] and len(sl) >= min_past:
            out[i] = bisect.bisect_right(sl, rv[i]) / len(sl)
    return out


def trend_dd_series(close, lb=LB90_H):
    """trend90 and dd90 at origins i = 0..N (D5)."""
    n_orig = len(close) + 1
    trend = np.full(n_orig, np.nan)
    dd = np.full(n_orig, np.nan)
    i = np.arange(n_orig)
    v = i - 1 - lb >= 0
    with np.errstate(invalid="ignore", divide="ignore"):
        trend[v] = np.log(close[i[v] - 1] / close[i[v] - 1 - lb])
        if len(close) >= lb:
            mx = sliding_window_view(close, lb).max(axis=1)   # mx[m] = max close[m..m+lb-1] -> origin m+lb
            dd[lb:lb + len(mx)] = close[lb - 1:lb - 1 + len(mx)] / mx - 1.0
    return trend, dd


def touch_prob(k, sigma, T_days):
    """Zero-drift first passage, vectorized: min(1, 2*Phi(ln(1+k) / (sigma*sqrt(T/365))))."""
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.minimum(1.0, 2.0 * ndtr(np.log(1.0 + k) / (sigma * np.sqrt(T_days / 365.0))))


def logit(p):
    return np.log(p) - np.log1p(-p)


def dvol_feature(sigma, k, T_days):
    """x_dvol = logit(clip(p_dvol, 1e-4, 1 - 1e-4)) (A.4 (d))."""
    p = touch_prob(k, sigma, T_days)
    return logit(np.clip(p, DVOL_CLIP, 1.0 - DVOL_CLIP))


def ref_daily_sigma(close, origins, n_days):
    """Q25 T1.2 realized vol at origins: P_j = close[i-1-24j], j = 0..n_days (D14)."""
    origins = np.asarray(origins)
    idx = origins[:, None] - 1 - 24 * np.arange(n_days + 1)[None, :]
    sig = np.full(len(origins), np.nan)
    ok = idx.min(axis=1) >= 0
    if ok.any():
        P = close[np.clip(idx[ok], 0, None)]
        good = np.all(np.isfinite(P) & (P > 0), axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            r = np.log(P[:, :-1] / P[:, 1:])
            var = r.var(axis=1, ddof=1)
            s = np.sqrt(var * 365.0)
        s[~good] = np.nan
        s[~(s > 0)] = np.nan
        sig[ok] = s
    return sig


class Series:
    """One (asset, truth) input on the hourly origin grid."""

    def __init__(self, asset, truth, close, low, cov_ts, dvol=None, levels=None):
        self.asset, self.truth = asset, truth
        self.key = f"{truth}:{asset}"
        self.levels = tuple(levels if levels is not None else LEVELS[asset])
        cov_i = (cov_ts - START_TS) // STEP
        close = np.array(close, dtype=float)
        low = np.array(low, dtype=float)
        close[:cov_i] = np.nan
        low[:cov_i] = np.nan
        self.close, self.low = close, low
        self.cov_i = int(cov_i)
        self.N = len(close)
        self.n_orig = self.N + 1
        self.spot = spot_series(close)
        self.rv30 = rv30_series(close)
        self.rv_pct = rv_pct_series(self.rv30)
        self.trend90, self.dd90 = trend_dd_series(close)
        self.feat = np.column_stack([self.rv_pct, self.trend90, self.dd90])
        self.feat_ok = np.all(np.isfinite(self.feat), axis=1)
        self.sigma_dvol = None
        if dvol is not None:  # origin i reads the candle opening at t_i - 1h = dvol[i-1]
            s = np.full(self.n_orig, np.nan)
            s[1:] = dvol[:self.N] / 100.0
            s[~(s > 0)] = np.nan
            self.sigma_dvol = s
        self._labels = {}

    def labels(self, T_h):
        if T_h not in self._labels:
            self._labels[T_h] = make_labels(self.spot, window_min(self.low, T_h), self.levels)
        return self._labels[T_h]


def build_series(datasets_dir):
    eth = load_price(os.path.join(datasets_dir, INPUTS["eth_price"][0]))
    btc = load_price(os.path.join(datasets_dir, INPUTS["btc_price"][0]))
    st = load_price(os.path.join(datasets_dir, INPUTS["steth_price"][0]), cols=("oracle", "oracleLow"))
    n = len(eth["oracle"])
    dv = {"ETH": load_dvol_array(os.path.join(datasets_dir, INPUTS["eth_dvol"][0]), n),
          "BTC": load_dvol_array(os.path.join(datasets_dir, INPUTS["btc_dvol"][0]), n)}
    px = {"ETH": eth, "BTC": btc, "stETH": st}
    series = {}
    for a in ASSETS:
        series[f"oracle:{a}"] = Series(a, "oracle", px[a]["oracle"], px[a]["oracleLow"], COVERAGE_START[a],
                                       dvol=dv.get(a))
    for a in SECONDARY_ASSETS:
        series[f"binance:{a}"] = Series(a, "binance", px[a]["binance"], px[a]["binanceLow"],
                                        BINANCE_COVERAGE_START, dvol=dv.get(a))
    return series


# ---------------------------------------------------------------------------------------------
# Folds (A.3)
# ---------------------------------------------------------------------------------------------
def quarter_start(y, q):
    return utc(f"{y:04d}-{3 * (q - 1) + 1:02d}-01T00:00:00Z")


def quarters(first, last):
    (y, q), out = first, []
    while (y, q) <= last:
        ny, nq = (y, q + 1) if q < 4 else (y + 1, 1)
        qs, qe = quarter_start(y, q), quarter_start(ny, nq)
        out.append({"name": f"{y}Q{q}", "qs_ts": qs, "qe_ts": qe,
                    "qs_i": (qs - START_TS) // STEP, "qe_i": (qe - START_TS) // STEP})
        y, q = ny, nq
    return out


def folds_for(asset):
    return quarters(*FOLD_SPAN[asset])


def d_fold_names(asset):
    return {f["name"] for f in quarters(*D_FOLD_SPAN)} if asset in D_ASSETS else set()


def train_origins(lab_ok, qs_i, T_h):
    """A.3 label purge: every labelled hourly origin i with t_i + T <= Q_start (i + T_h <= qs_i)."""
    i = np.arange(len(lab_ok))
    return i[lab_ok & (i + T_h <= qs_i)]


def test_origins(qs_i, qe_i, n_orig):
    """A.3 issue times: every 6 h (00/06/12/18Z) in [Q_start, Q_end)."""
    i = np.arange(qs_i, min(qe_i, n_orig))
    return i[i % ISSUE_EVERY_H == 0]


# ---------------------------------------------------------------------------------------------
# Rungs (A.4)
# ---------------------------------------------------------------------------------------------
def recency_weights(origins, qs_i, H_days):
    """w(t) = 0.5 ** ((Q_start - t) / H)."""
    age_h = (qs_i - np.asarray(origins)).astype(float)
    return np.power(0.5, age_h / (H_days * 24.0))


def freq_a(Y):
    return Y.mean(axis=0)


def freq_b(Y, w):
    return (w[:, None] * Y).sum(axis=0) / w.sum()


def count_episodes(origins, y):
    """(positive episodes, negative episodes): maximal runs of consecutive hourly origins with one label (D8)."""
    origins = np.asarray(origins)
    y = np.asarray(y)
    if len(origins) == 0:
        return 0, 0
    new = np.ones(len(origins), dtype=bool)
    new[1:] = (np.diff(origins) != 1) | (y[1:] != y[:-1])
    first = y[new]
    return int((first == 1).sum()), int((first == 0).sum())


def weighted_standardize_params(X, w):
    mu = (w[:, None] * X).sum(axis=0) / w.sum()
    sd = np.sqrt((w[:, None] * (X - mu) ** 2).sum(axis=0) / w.sum())
    sd = np.where(sd > 0, sd, 1.0)
    return mu, sd


def fit_logistic(X, y, w):
    """A.4 (c): standardized by weighted mean/std, sample weights w rescaled to mean 1."""
    from sklearn.exceptions import ConvergenceWarning
    from sklearn.linear_model import LogisticRegression
    mu, sd = weighted_standardize_params(X, w)
    Z = (X - mu) / sd
    sw = w / w.mean()
    m = LogisticRegression(**LOGIT_KW)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        m.fit(Z, y, sample_weight=sw)
    conv = not any(issubclass(c.category, ConvergenceWarning) for c in caught)
    return {"model": m, "mu": mu, "sd": sd, "coef": m.coef_[0].copy(), "intercept": float(m.intercept_[0]),
            "n_iter": int(np.max(m.n_iter_)), "converged": bool(conv)}


def predict_logistic(fit, X):
    return fit["model"].predict_proba((X - fit["mu"]) / fit["sd"])[:, 1]


def fit_predict_fold(ser, T_h, qs_i, te, in_d, H_main=H_MAIN, H_sens=H_SENS, keep_models=False,
                     te_feat=None, te_sigma=None):
    """Fit every rung of one (series, T, fold) on its training origins and predict at origins `te`.
    Returns raw (pre-fix) predictions {rung: (len(te), n_levels)} plus fallback flags and fit records.
    te_feat / te_sigma (panel only) replace the test-origin features read from `ser`."""
    y = ser.labels(T_h)
    lab_ok = np.isfinite(y[:, 0])
    tr = train_origins(lab_ok, qs_i, T_h)
    nK = len(ser.levels)
    n_te = len(te)
    Ytr = y[tr]
    w = recency_weights(tr, qs_i, H_main)
    out = {"n_train_ab": int(len(tr)), "raw": {}, "fits": []}
    if len(tr) == 0:
        raise RuntimeError(f"{ser.key} T={T_h} qs={iso(START_TS + STEP * qs_i)}: no training origins")
    p_a = freq_a(Ytr)
    p_b = freq_b(Ytr, w)
    out["p_a"], out["p_b"] = p_a, p_b
    out["raw"]["a"] = np.tile(p_a, (n_te, 1))
    out["raw"]["b"] = np.tile(p_b, (n_te, 1))
    for H in H_sens:
        out["raw"][f"b{int(H)}"] = np.tile(freq_b(Ytr, recency_weights(tr, qs_i, H)), (n_te, 1))

    # (c)
    fo = ser.feat_ok[tr]
    trc, wc, Xc = tr[fo], w[fo], ser.feat[tr[fo]]
    Xte = ser.feat[te] if te_feat is None else np.atleast_2d(np.asarray(te_feat, float))
    te_ok = np.all(np.isfinite(Xte), axis=1)
    pc = np.tile(p_b, (n_te, 1))
    c_cell_fb = np.zeros(nK, dtype=bool)
    models_c = [None] * nK
    out["n_train_c"] = int(len(trc))
    for j in range(nK):
        yc = y[trc, j]
        pos, neg = count_episodes(trc, yc)
        rec = {"rung": "c", "k": ser.levels[j], "n_train": int(len(trc)), "pos_episodes": pos,
               "neg_episodes": neg}
        if pos < MIN_EPISODES or neg < MIN_EPISODES:
            c_cell_fb[j] = True
            rec["fallback"] = True
        else:
            fit = fit_logistic(Xc, yc, wc)
            if te_ok.any():
                pc[te_ok, j] = predict_logistic(fit, Xte[te_ok])
            rec.update(fallback=False, coef=fit["coef"].tolist(), intercept=fit["intercept"],
                       mu=fit["mu"].tolist(), sd=fit["sd"].tolist(), n_iter=fit["n_iter"],
                       converged=fit["converged"])
            if keep_models:
                models_c[j] = fit
        out["fits"].append(rec)
    out["raw"]["c"] = pc
    out["c_cell_fb"] = c_cell_fb
    out["c_row_fb"] = ~te_ok
    out["models_c"] = models_c

    # (d)
    out["d_cell_fb"] = None
    out["d_row_fb"] = None
    out["models_d"] = None
    if in_d and ser.sigma_dvol is not None:
        od = np.isfinite(ser.sigma_dvol[trc])
        trd, wd = trc[od], wc[od]
        sig_te = ser.sigma_dvol[te] if te_sigma is None else np.atleast_1d(np.asarray(te_sigma, float))
        te_ok_d = te_ok & np.isfinite(sig_te)
        pdd = pc.copy()
        d_cell_fb = np.zeros(nK, dtype=bool)
        models_d = [None] * nK
        out["n_train_d"] = int(len(trd))
        for j, k in enumerate(ser.levels):
            yd = y[trd, j]
            pos, neg = count_episodes(trd, yd)
            rec = {"rung": "d", "k": k, "n_train": int(len(trd)), "pos_episodes": pos, "neg_episodes": neg}
            if pos < MIN_EPISODES or neg < MIN_EPISODES:
                d_cell_fb[j] = True
                rec["fallback"] = True
            else:
                Xd = np.column_stack([ser.feat[trd], dvol_feature(ser.sigma_dvol[trd], k, T_DAYS[T_h])])
                fit = fit_logistic(Xd, yd, wd)
                if te_ok_d.any():
                    Xt = np.column_stack([Xte[te_ok_d],
                                          dvol_feature(sig_te[te_ok_d], k, T_DAYS[T_h])])
                    pdd[te_ok_d, j] = predict_logistic(fit, Xt)
                rec.update(fallback=False, coef=fit["coef"].tolist(), intercept=fit["intercept"],
                           mu=fit["mu"].tolist(), sd=fit["sd"].tolist(), n_iter=fit["n_iter"],
                           converged=fit["converged"])
                if keep_models:
                    models_d[j] = fit
            out["fits"].append(rec)
        out["raw"]["d"] = pdd
        out["d_cell_fb"] = d_cell_fb
        out["d_row_fb"] = ~te_ok_d
        out["models_d"] = models_d
    return out


def monotone_fix(P):
    """P[..., T, k] with T short->long and k shallow->deep:
    q[T][k] = min(P[T][k'], k' at or shallower than k); p'[T][k] = max(q[T'][k], T' <= T)."""
    q = np.minimum.accumulate(P, axis=-1)
    return np.maximum.accumulate(q, axis=-2)


# ---------------------------------------------------------------------------------------------
# Metrics (A.5)
# ---------------------------------------------------------------------------------------------
def brier(p, y):
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    return float(np.mean((p - y) ** 2)) if len(p) else None


def block_bootstrap_indices(rng, n_days, block, n_rep):
    """Moving block bootstrap, non-circular: block starts uniform on 0..n_days-block,
    ceil(n_days/block) blocks per replicate, concatenated and truncated to n_days."""
    if n_days < block:
        raise ValueError(f"n_days={n_days} < block={block}")
    n_blocks = math.ceil(n_days / block)
    starts = rng.integers(0, n_days - block + 1, size=(n_rep, n_blocks))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_rep, n_blocks * block)
    return idx[:, :n_days]


def replicate_counts(idx, n_days):
    n_rep = idx.shape[0]
    flat = (idx + np.arange(n_rep)[:, None] * n_days).ravel()
    return np.bincount(flat, minlength=n_rep * n_days).reshape(n_rep, n_days).astype(float)


def draw_order(day_sets):
    """Registered order of (asset, T_h, set) keys present in day_sets (D11)."""
    keys = []
    for a in ASSETS:
        for T_h in HORIZONS_H:
            for s in ("full", "d"):
                if (a, T_h, s) in day_sets:
                    keys.append((a, T_h, s))
    return keys


def draw_all(day_sets, n_rep=N_BOOT, seed_block=SEED_BLOCK, seed_iid=SEED_IID, rngs=None):
    """Yield (key, idx_block, idx_iid) in the registered order from ONE generator per kind."""
    rb, ri = rngs if rngs is not None else (np.random.default_rng(seed_block), np.random.default_rng(seed_iid))
    for key in draw_order(day_sets):
        n = len(day_sets[key])
        yield key, block_bootstrap_indices(rb, n, block_length(key[1]), n_rep), \
            block_bootstrap_indices(ri, n, 1, n_rep)


def bss_stats(day_idx, n_days, p_m, p_b, y, counts_blk, counts_iid):
    """Point BSS = 1 - B_m/B_b on the given rows; 95% percentile CI over block replicates; n_eff_boot."""
    p_m, p_b, y = (np.asarray(v, float) for v in (p_m, p_b, y))
    se_m = np.bincount(day_idx, weights=(p_m - y) ** 2, minlength=n_days)
    se_b = np.bincount(day_idx, weights=(p_b - y) ** 2, minlength=n_days)
    n = len(y)
    out = {"n_rows": int(n), "n_days": int(n_days),
           "n_days_with_rows": int(np.count_nonzero(np.bincount(day_idx, minlength=n_days))),
           "brier_model": float(se_m.sum() / n) if n else None,
           "brier_base": float(se_b.sum() / n) if n else None}
    out["bss"] = float(1.0 - se_m.sum() / se_b.sum()) if se_b.sum() > 0 else None
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (counts_blk @ se_m) / (counts_blk @ se_b)
        reps_i = 1.0 - (counts_iid @ se_m) / (counts_iid @ se_b)
    fin, fin_i = np.isfinite(reps), np.isfinite(reps_i)
    out["n_nonfinite_reps"] = int((~fin).sum())
    if fin.sum() > 1:
        lo, hi = np.percentile(reps[fin], [2.5, 97.5])
        out["ci95"] = [float(lo), float(hi)]
        out["ci_above_0"] = bool(lo > 0)
        out["ci_below_0"] = bool(hi < 0)
        vb = float(np.var(reps[fin], ddof=1))
        vi = float(np.var(reps_i[fin_i], ddof=1)) if fin_i.sum() > 1 else None
        out["var_block"], out["var_iid"] = vb, vi
        out["n_eff_boot"] = float(n_days * vi / vb) if (vi is not None and vb > 0) else None
    else:
        out.update(ci95=None, ci_above_0=False, ci_below_0=False, var_block=None, var_iid=None,
                   n_eff_boot=None)
    return out


def ece_equal_width(p, y, nbins=ECE_BINS):
    """Equal-width bins on [0,1]; bin b = [b/n, (b+1)/n), last bin closed."""
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    edges = np.arange(nbins + 1) / nbins
    b = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, nbins - 1)
    N = len(p)
    ece, table = 0.0, []
    for i in range(nbins):
        m = b == i
        n_b = int(m.sum())
        row = {"bin": i, "p_lo": float(edges[i]), "p_hi": float(edges[i + 1]), "n": n_b,
               "mean_p": None, "mean_y": None}
        if n_b:
            mp, my = float(p[m].mean()), float(y[m].mean())
            row.update(mean_p=mp, mean_y=my)
            ece += (n_b / N) * abs(my - mp)
        table.append(row)
    return float(ece), table


def ece_equal_mass(p, y, nbins=ECE_BINS):
    """Stable sort by p, numpy.array_split into nbins contiguous chunks (ties may straddle chunks)."""
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    order = np.argsort(p, kind="mergesort")
    N = len(p)
    ece, table = 0.0, []
    for i, ch in enumerate(np.array_split(order, nbins)):
        n_b = len(ch)
        row = {"bin": i, "p_lo": None, "p_hi": None, "n": n_b, "mean_p": None, "mean_y": None}
        if n_b:
            mp, my = float(p[ch].mean()), float(y[ch].mean())
            row.update(p_lo=float(p[ch].min()), p_hi=float(p[ch].max()), mean_p=mp, mean_y=my)
            ece += (n_b / N) * abs(my - mp)
        table.append(row)
    return float(ece), table


def binom_band(n_w, pbar):
    """[F^-1(0.025), F^-1(0.975)] / n_w with F = Binomial(n_w, pbar) CDF."""
    lo = float(binom.ppf(0.025, n_w, pbar)) / n_w
    hi = float(binom.ppf(0.975, n_w, pbar)) / n_w
    return lo, hi


def coverage_nw(n_issue, T_h):
    return max(1, int(math.floor(n_issue * ISSUE_EVERY_H / max(T_h, ISSUE_EVERY_H))))


def coverage_cell(y, p, T_h):
    """One (fold, level) cell: ybar, pbar, n_w, band, covered (ends included)."""
    n = len(y)
    ybar, pbar = float(np.mean(y)), float(np.mean(p))
    n_w = coverage_nw(n, T_h)
    lo, hi = binom_band(n_w, pbar)
    return {"n_rows": n, "n_w": n_w, "ybar": ybar, "pbar": pbar, "band_lo": lo, "band_hi": hi,
            "covered": bool(lo <= ybar <= hi)}


def n_windows(n_issue, T_h):
    return n_issue * ISSUE_EVERY_H / max(T_h, ISSUE_EVERY_H)


def confidence_label(cov, cov_recent, ece_m, n_w_total):
    """A.7. STALE overrides every label."""
    if cov_recent < 0.60:
        return "STALE"
    if cov >= 0.90 and ece_m <= 0.02 and n_w_total >= 50:
        return "HIGH"
    if cov >= 0.75 and ece_m <= 0.05:
        return "MEDIUM"
    return "LOW"


def shipped_rung(passes, has_d):
    """A.6: climb from (a) while each next rung passes vs the one below; stop at the first failure."""
    r = "a"
    if passes.get("b_vs_a"):
        r = "b"
        if passes.get("c_vs_b"):
            r = "c"
            if has_d and passes.get("d_vs_c"):
                r = "d"
    return r


# ---------------------------------------------------------------------------------------------
# ACTION rows (A.8)
# ---------------------------------------------------------------------------------------------
def _lg(p):
    p = min(max(float(p), ACTION_LOGIT_CLIP), 1.0 - ACTION_LOGIT_CLIP)
    return math.log(p) - math.log1p(-p)


def _ilg(x):
    return 1.0 / (1.0 + math.exp(-x))


def p_at_distance(levels, probs, y):
    """P(y): logit(p) linear in ln(1+k) between the two grid levels bracketing y.
    levels shallow->deep. Returns (p or None, status) with status 'ok', 'deeper_than_grid'
    ('< p(deepest)') or 'shallower_than_grid' ('> p(shallowest)')."""
    if y > levels[0]:
        return None, "shallower_than_grid"
    if y < levels[-1]:
        return None, "deeper_than_grid"
    for i in range(len(levels) - 1):
        k0, k1 = levels[i], levels[i + 1]
        if k0 >= y >= k1:
            x0, x1, x = math.log(1 + k0), math.log(1 + k1), math.log(1 + y)
            f = 0.0 if x1 == x0 else (x - x0) / (x1 - x0)
            return _ilg(_lg(probs[i]) + f * (_lg(probs[i + 1]) - _lg(probs[i]))), "ok"
    return float(probs[-1]), "ok"  # y == the single level


def solve_distance(levels, probs, Z):
    """y* with P(y*) = Z by the same interpolation (D19). Returns (y* or None, status)."""
    lz = _lg(Z)
    L = [_lg(p) for p in probs]
    if L[0] < lz:
        return None, "shallower_than_grid"   # even the shallowest level is below Z
    if L[-1] > lz:
        return None, "deeper_than_grid"      # even the deepest level is above Z
    for i in range(len(levels) - 1):
        if L[i] >= lz >= L[i + 1]:
            x0, x1 = math.log(1 + levels[i]), math.log(1 + levels[i + 1])
            if L[i] == L[i + 1]:
                return levels[i], "ok"
            x = x0 + (lz - L[i]) / (L[i + 1] - L[i]) * (x1 - x0)
            return math.exp(x) - 1.0, "ok"
    return levels[-1], "ok"


def repay_amount(D, C, LT, S, y_target):
    """X = D - C*LT*S*(1+y*), rounded up to the next $10."""
    raw = D - C * LT * S * (1.0 + y_target)
    return int(math.ceil(round(raw, 6) / 10.0) * 10), raw


def floor_pct_toward_risk(y):
    """Whole-% distance with magnitude floored (closer to spot): -0.276 -> 27."""
    return int(math.floor(round(abs(y) * 100.0, 7)))


def fmt_p(p, dagger=True):
    """Displayed probability (DESIGN_RULES section 4: never print 0%). Anything that rounds to 0.0% at one
    decimal (exact zeros included) prints '<0.1%'; anything that rounds to 100.0% prints '>99.9%'."""
    p = float(p)
    s = f"{p:.1%}"
    if p <= 0 or s == "0.0%":
        s = "<0.1%"
    elif s == "100.0%":
        s = ">99.9%"
    return s + ("\u2020" if dagger else "")


def fmt_bound(op, p, dagger=True):
    """'< p(-40%)' / '> p(-2%)' bounds, keeping the no-0% rule: '<' with a sub-0.1% bound prints '<0.1%'."""
    s = fmt_p(p, dagger=False)
    if op == "<":
        out = s if s.startswith("<") else "<" + s
    else:
        if s.startswith("<"):
            out = f">{float(p) * 100:.2g}%"
        elif s.startswith(">"):
            out = s
        else:
            out = ">" + s
    return out + ("\u2020" if dagger else "")


def level_toward_risk(levels, y):
    """Grid level used for a history count at distance y: the deepest level at or shallower than y
    (clamped to the grid)."""
    cand = [k for k in levels if k >= y]
    return cand[-1] if cand else levels[0]


def current_line_display(levels, probs, y_now, label, hc):
    """Current-line P(y, T) display. HIGH/MEDIUM shows the probability, or '> p(-2%)' / '< p(-40%)' outside
    the grid. LOW/STALE shows the history count (hc) at the level toward risk."""
    p, st = p_at_distance(levels, probs, y_now)
    if label in ("HIGH", "MEDIUM"):
        if st == "ok":
            return f"{fmt_p(p)} {label}", p, st
        if st == "shallower_than_grid":
            return f"{fmt_bound('>', probs[0])} {label} (line shallower than \u2212{abs(levels[0]):.0%})", None, st
        return f"{fmt_bound('<', probs[-1])} {label} (line beyond \u2212{abs(levels[-1]):.0%})", None, st
    txt = (f"touched in {hc['touched']} of {hc['windows']} non-overlapping windows at {level_toward_risk(levels, y_now):+.0%}, "
           f"{hc['period'][0][:10]}..{hc['period'][1][:10]}" + (" [hatched]" if label == "STALE" else ""))
    return txt, p, st


def action_rows(levels, probs7, D, C, LT, S, targets=ACTION_Z, y_now=None):
    """ACTION rows at T = 7 d. y_now = current line distance (default: from D, C, LT, S). 'no repay needed'
    is printed only when it is implied: the current line is at or deeper than the solved line, or Z is above
    p(-2%) and the current line is inside the grid. Outside the grid the row uses '> p(-2%)' / '< p(-40%)'."""
    if y_now is None:
        y_now = D / (C * LT * S) - 1.0
    rows = []
    for Z in targets:
        ys, st = solve_distance(levels, probs7, Z)
        row = {"Z": Z, "status": st, "y_now": y_now}
        if st == "shallower_than_grid":
            if y_now <= levels[0]:
                row.update(repay=0, text=f"no repay needed (7d \u2264 {fmt_p(probs7[0])} < {Z:.0%} at the line "
                                         f"\u2212{floor_pct_toward_risk(y_now)}%)")
            else:
                X, raw = repay_amount(D, C, LT, S, levels[0])
                row.update(repay_upper_bound=X, repay_raw=raw,
                           text=f"Repay \u2264 ${X:,} \u2192 line at \u2212{abs(levels[0]):.0%} \u2192 7d < {Z:.0%} "
                                f"(now 7d {fmt_bound('>', probs7[0])}: line shallower than \u2212{abs(levels[0]):.0%})")
        elif st == "deeper_than_grid":
            X, raw = repay_amount(D, C, LT, S, levels[-1])
            if y_now < levels[-1]:
                row.update(text=f"line beyond \u2212{abs(levels[-1]):.0%}: 7d {fmt_bound('<', probs7[-1])}; "
                                f"7d {Z:.0%} not resolvable inside the grid")
            else:
                row.update(repay_lower_bound=X, text=f"Repay > ${X:,} \u2192 line beyond \u2212{abs(levels[-1]):.0%} "
                                                    f"\u2192 7d < {Z:.0%} not reachable inside the grid")
        else:
            X, raw = repay_amount(D, C, LT, S, ys)
            row["y_star"] = ys
            row["repay_raw"] = raw
            if X <= 0:
                row.update(repay=0, text="no repay needed")
            else:
                y_new = (D - X) / (C * LT * S) - 1.0
                Y = floor_pct_toward_risk(y_new)
                row.update(repay=X, line_after=y_new, line_after_pct=Y,
                           text=f"Repay ${X:,} \u2192 line at \u2212{Y}% \u2192 7d {Z:.0%}")
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------------------------
# Worker: one (series, horizon) across all its folds
# ---------------------------------------------------------------------------------------------
_SERIES = {}


def series_folds(ser):
    folds = folds_for(ser.asset)
    dn = d_fold_names(ser.asset)
    return folds, dn


def run_series_horizon(key_T):
    key, T_h = key_T
    ser = _SERIES[key]
    folds, dn = series_folds(ser)
    res = []
    for f in folds:
        te = test_origins(f["qs_i"], f["qe_i"], ser.n_orig)
        o = fit_predict_fold(ser, T_h, f["qs_i"], te, f["name"] in dn)
        o.pop("models_c", None)
        o.pop("models_d", None)
        o["fold"] = f["name"]
        o["te"] = te
        res.append(o)
    return key, T_h, res


def assemble(ser, per_T):
    """Stack per-horizon fold outputs into (n_te, nT, nK) grids, fix, and flatten to labelled rows."""
    folds, dn = series_folds(ser)
    nK, nT = len(ser.levels), len(HORIZONS_H)
    te_all = np.concatenate([test_origins(f["qs_i"], f["qe_i"], ser.n_orig) for f in folds])
    fold_of = np.concatenate([[fi] * len(test_origins(f["qs_i"], f["qe_i"], ser.n_orig))
                              for fi, f in enumerate(folds)]).astype(int)
    n = len(te_all)
    rung_names = ["a", "b", "c", "d"] + [f"b{int(H)}" for H in H_SENS]
    G = {r: np.full((n, nT, nK), np.nan) for r in rung_names}
    c_fb = np.zeros((n, nT, nK), dtype=np.int8)   # 0 none, 1 cell, 2 row
    d_fb = np.zeros((n, nT, nK), dtype=np.int8)
    fits = []
    for ti, T_h in enumerate(HORIZONS_H):
        off = 0
        for fi, o in enumerate(per_T[T_h]):
            assert o["fold"] == folds[fi]["name"]
            m = len(o["te"])
            sl = slice(off, off + m)
            assert np.array_equal(te_all[sl], o["te"])
            for r in rung_names:
                if r in o["raw"]:
                    G[r][sl, ti, :] = o["raw"][r]
            c_fb[sl, ti, :] = np.where(o["c_cell_fb"][None, :], 1, np.where(o["c_row_fb"][:, None], 2, 0))
            if o["d_cell_fb"] is not None:
                d_fb[sl, ti, :] = np.where(o["d_cell_fb"][None, :], 1, np.where(o["d_row_fb"][:, None], 2, 0))
            for rec in o["fits"]:
                fits.append({"series": ser.key, "T_h": T_h, "fold": o["fold"], **rec,
                             "n_train_ab": o["n_train_ab"]})
            fits.append({"series": ser.key, "T_h": T_h, "fold": o["fold"], "rung": "a/b",
                         "p_a": o["p_a"].tolist(), "p_b": o["p_b"].tolist(), "n_train_ab": o["n_train_ab"]})
            off += m
        assert off == n
    in_d = np.array([folds[fi]["name"] in dn for fi in fold_of])
    F = {}
    for r in rung_names:
        if r == "d":
            Gd = G["d"][in_d]
            assert not np.isnan(Gd).any(), "d grid has gaps"
            Fd = np.full_like(G["d"], np.nan)
            Fd[in_d] = monotone_fix(Gd)
            F[r] = Fd
        else:
            assert not np.isnan(G[r]).any(), f"{r} grid has gaps"
            F[r] = monotone_fix(G[r])
    # flatten labelled rows
    rows = {k: [] for k in ("t0_i", "fold_i", "T_h", "k", "y", "c_fb", "d_fb", "in_d")}
    rows.update({f"p_{r}": [] for r in rung_names})
    rows.update({"p_rv30": [], "p_rv90": []})
    ref_sig = {name: ref_daily_sigma(ser.close, te_all, nd) for name, nd in REF_RV_DAYS.items()}
    for ti, T_h in enumerate(HORIZONS_H):
        Y = ser.labels(T_h)[te_all]          # (n, nK)
        ok = np.isfinite(Y[:, 0])
        idx = np.where(ok)[0]
        for j, k in enumerate(ser.levels):
            rows["t0_i"].append(te_all[idx])
            rows["fold_i"].append(fold_of[idx])
            rows["T_h"].append(np.full(len(idx), T_h))
            rows["k"].append(np.full(len(idx), k))
            rows["y"].append(Y[idx, j])
            rows["c_fb"].append(c_fb[idx, ti, j])
            rows["d_fb"].append(np.where(in_d[idx], d_fb[idx, ti, j], -1))
            rows["in_d"].append(in_d[idx])
            for r in rung_names:
                rows[f"p_{r}"].append(F[r][idx, ti, j])
            for name in REF_RV_DAYS:
                rows[f"p_{name}"].append(touch_prob(k, ref_sig[name][idx], T_DAYS[T_h]))
    R = {k: np.concatenate(v) for k, v in rows.items()}
    R["day"] = (START_TS + STEP * R["t0_i"]) // DAY
    R["fold_names"] = [f["name"] for f in folds]
    return R, fits


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
FULL_COMPARISONS = (("b_vs_a", "b", "a"), ("c_vs_b", "c", "b"),
                    ("ref_a_vs_rv30raw", "a", "rv30"), ("ref_a_vs_rv90raw", "a", "rv90"),
                    ("x_c_vs_a", "c", "a"),
                    ("sens_b180_vs_a", "b180", "a"), ("sens_b730_vs_a", "b730", "a"),
                    ("sens_b180_vs_b", "b180", "b"), ("sens_b730_vs_b", "b730", "b"))
D_COMPARISONS = (("d_vs_c", "d", "c"), ("x_d_vs_b", "d", "b"), ("x_d_vs_a", "d", "a"))
DECIDING = ("b_vs_a", "c_vs_b", "d_vs_c")


def _sel(R, mask):
    return {k: (v[mask] if isinstance(v, np.ndarray) else v) for k, v in R.items()}


def comparisons_on(R, mask, days, counts_blk, counts_iid, comps, levels, with_levels=True):
    """All comparisons of one day set on rows `mask` of R (rows whose day is not in `days` are dropped)."""
    pos = np.searchsorted(days, R["day"])
    in_set = (pos < len(days)) & (days[np.clip(pos, 0, len(days) - 1)] == R["day"])
    dropped = int((mask & ~in_set).sum())
    m0 = mask & in_set
    out = {"rows_dropped_not_in_day_set": dropped, "all": {}, "per_level": {}}
    subsets = [("all", m0)]
    if with_levels:
        subsets += [(repr(k), m0 & (R["k"] == k)) for k in levels]
    for sname, m in subsets:
        res = {}
        for cname, rm, rb in comps:
            pm, pb = R[f"p_{rm}"], R[f"p_{rb}"]
            mm = m & np.isfinite(pm) & np.isfinite(pb)
            if not mm.any():
                res[cname] = None
                continue
            res[cname] = bss_stats(pos[mm], len(days), pm[mm], pb[mm], R["y"][mm], counts_blk, counts_iid)
        if sname == "all":
            out["all"] = res
        else:
            out["per_level"][sname] = res
    return out


def rung_tables(R, mask, rungs, T_h, fold_names, last4):
    """Brier, ECE, reliability and coverage per rung on rows `mask`."""
    out = {"brier": {}, "ece": {}, "coverage": {}, "reliability": {}, "coverage_cells": {}}
    R = _sel(R, mask)
    mask = np.ones(len(R["y"]), dtype=bool)
    y = R["y"]
    for r in rungs:
        p = R[f"p_{r}"]
        m = mask & np.isfinite(p)
        if not m.any():
            continue
        out["brier"][r] = {"brier": brier(p[m], y[m]), "n_rows": int(m.sum()), "mean_p": float(p[m].mean()),
                           "mean_y": float(y[m].mean())}
        ew, tw = ece_equal_width(p[m], y[m])
        em, tm = ece_equal_mass(p[m], y[m])
        out["ece"][r] = {"equal_width": ew, "equal_mass": em, "n": int(m.sum()),
                         "share_p_below_0.1": float(np.mean(p[m] < 0.1))}
        out["reliability"][r] = {"equal_mass": tm, "equal_width": tw}
        cells = []
        for fi in np.unique(R["fold_i"][m]):
            for k in np.unique(R["k"][m]):
                mc = m & (R["fold_i"] == fi) & (R["k"] == k)
                if not mc.any():
                    continue
                c = coverage_cell(y[mc], p[mc], T_h)
                c.update(fold=fold_names[fi], k=float(k))
                cells.append(c)
        cov = float(np.mean([c["covered"] for c in cells])) if cells else None
        rec = [c for c in cells if c["fold"] in last4]
        cov_r = float(np.mean([c["covered"] for c in rec])) if rec else None
        out["coverage"][r] = {"cov": cov, "cov_recent": cov_r, "n_cells": len(cells), "n_cells_recent": len(rec),
                              "recent_folds": sorted(last4)}
        out["coverage_cells"][r] = cells
    return out


def set_counts(R, mask, T_h):
    t0 = np.unique(R["t0_i"][mask])
    n_issue = int(len(t0))
    return {"n_rows": int(mask.sum()), "n_issue_times": n_issue,
            "n_days": int(len(np.unique(R["day"][mask]))),
            "n_windows": n_windows(n_issue, T_h),
            "period": [iso(START_TS + STEP * int(t0.min())), iso(START_TS + STEP * int(t0.max()) + STEP * T_h)]
            if n_issue else None}


def fallback_counts(R, mask, nfolds_levels):
    out = {}
    for r, col in (("c", "c_fb"), ("d", "d_fb")):
        v = R[col][mask]
        if r == "d":
            v = v[v >= 0]
        out[f"{r}_test_rows_cell_fallback"] = int((v == 1).sum())
        out[f"{r}_test_rows_feature_fallback"] = int((v == 2).sum())
        out[f"{r}_test_rows"] = int(len(v))
    return out


def run_score(series, Rs, fits_all, out_dir, log=print):
    """Bootstrap draws in the registered order; every comparison and table."""
    results = {"primary": {}, "secondary_binance": {}, "pooled_eth_btc": {}}
    # day sets (primary truth defines them)
    day_sets, masks = {}, {}
    for a in ASSETS:
        R = Rs[f"oracle:{a}"]
        for T_h in HORIZONS_H:
            m_full = R["T_h"] == T_h
            day_sets[(a, T_h, "full")] = np.unique(R["day"][m_full])
            masks[(a, T_h, "full")] = m_full
            if a in D_ASSETS:
                m_d = m_full & R["in_d"]
                day_sets[(a, T_h, "d")] = np.unique(R["day"][m_d])
                masks[(a, T_h, "d")] = m_d
    boot_meta = {}
    comp_store = {}
    for key, idx_b, idx_i in draw_all(day_sets):
        a, T_h, s = key
        days = day_sets[key]
        cb, ci = replicate_counts(idx_b, len(days)), replicate_counts(idx_i, len(days))
        boot_meta[f"{a}|{T_LABEL[T_h]}|{s}"] = {
            "n_days": int(len(days)), "block_length": block_length(T_h),
            "blocks_per_replicate": math.ceil(len(days) / block_length(T_h)),
            "first_day": iso(int(days[0]) * DAY), "last_day": iso(int(days[-1]) * DAY),
            "idx_block_sha256": hashlib.sha256(np.ascontiguousarray(idx_b, dtype=np.int64).tobytes()).hexdigest()}
        comps = FULL_COMPARISONS if s == "full" else D_COMPARISONS
        for truth in ("oracle", "binance"):
            sk = f"{truth}:{a}"
            if sk not in Rs:
                continue
            R = Rs[sk]
            m = (R["T_h"] == T_h) & (R["in_d"] if s == "d" else True)
            comp_store[(truth, a, T_h, s)] = comparisons_on(R, m, days, cb, ci, comps, series[sk].levels,
                                                            with_levels=True)
        log(f"  boot {a} {T_LABEL[T_h]} {s}: days={len(days)}")
    # pooled ETH+BTC (non-deciding; draws continue after every registered draw)
    rb, ri = np.random.default_rng(SEED_BLOCK), np.random.default_rng(SEED_IID)
    for _ in draw_all(day_sets, rngs=(rb, ri)):
        pass  # advance both generators past the registered draws
    pooled_sets = {}
    for T_h in HORIZONS_H:
        for s in ("full", "d"):
            pooled_sets[("POOLED", T_h, s)] = np.union1d(day_sets[("ETH", T_h, s)], day_sets[("BTC", T_h, s)])
    pooled_store = {}
    for T_h in HORIZONS_H:
        for s in ("full", "d"):
            days = pooled_sets[("POOLED", T_h, s)]
            idx_b = block_bootstrap_indices(rb, len(days), block_length(T_h), N_BOOT)
            idx_i = block_bootstrap_indices(ri, len(days), 1, N_BOOT)
            cb, ci = replicate_counts(idx_b, len(days)), replicate_counts(idx_i, len(days))
            for truth in ("oracle", "binance"):
                Rp = pool_rows([Rs[f"{truth}:ETH"], Rs[f"{truth}:BTC"]])
                m = (Rp["T_h"] == T_h) & (Rp["in_d"] if s == "d" else True)
                comps = FULL_COMPARISONS if s == "full" else D_COMPARISONS
                pooled_store[(truth, T_h, s)] = comparisons_on(Rp, m, days, cb, ci, comps, LEVELS["ETH"],
                                                               with_levels=False)
                pooled_store[(truth, T_h, s)]["brier"] = {
                    r: brier(Rp[f"p_{r}"][m & np.isfinite(Rp[f"p_{r}"])], Rp["y"][m & np.isfinite(Rp[f"p_{r}"])])
                    for r in ("a", "b", "c", "d", "b180", "b730", "rv30", "rv90")
                    if (m & np.isfinite(Rp[f"p_{r}"])).any()}
                pooled_store[(truth, T_h, s)]["counts"] = set_counts(Rp, m, T_h)
    # tables per series
    rel_rows, cov_rows = [], []
    for truth, block in (("oracle", "primary"), ("binance", "secondary_binance")):
        for a in (ASSETS if truth == "oracle" else SECONDARY_ASSETS):
            sk = f"{truth}:{a}"
            R = Rs[sk]
            fold_names = R["fold_names"]
            last4 = set(fold_names[-4:])
            has_d = a in D_ASSETS
            per_T = {}
            for T_h in HORIZONS_H:
                mT = R["T_h"] == T_h
                mD = mT & R["in_d"]
                cell = {"counts": set_counts(R, mT, T_h)}
                if has_d:
                    cell["counts_d_set"] = set_counts(R, mD, T_h)
                full_t = rung_tables(R, mT, ("a", "b", "c", "b180", "b730", "rv30", "rv90"), T_h, fold_names, last4)
                cell["brier"] = full_t["brier"]
                cell["ece"] = full_t["ece"]
                cell["coverage"] = full_t["coverage"]
                cs = comp_store[(truth, a, T_h, "full")]
                cell["comparisons"] = dict(cs["all"])
                cell["rows_dropped_not_in_day_set"] = {"full": cs["rows_dropped_not_in_day_set"]}
                cell["per_level"] = {k: {"comparisons": v} for k, v in cs["per_level"].items()}
                tables = {"full": full_t}
                if has_d:
                    d_t = rung_tables(R, mD, ("a", "b", "c", "d"), T_h, fold_names, last4)
                    cell["d_set"] = {"brier": d_t["brier"], "ece": d_t["ece"], "coverage": d_t["coverage"]}
                    ds = comp_store[(truth, a, T_h, "d")]
                    cell["comparisons"].update(ds["all"])
                    cell["rows_dropped_not_in_day_set"]["d"] = ds["rows_dropped_not_in_day_set"]
                    for k, v in ds["per_level"].items():
                        cell["per_level"].setdefault(k, {"comparisons": {}})["comparisons"].update(v)
                    tables["d"] = d_t
                # per-level Brier
                for k in series[sk].levels:
                    mk = mT & (R["k"] == k)
                    pl = cell["per_level"].setdefault(repr(k), {"comparisons": {}})
                    pl["brier"] = {r: brier(R[f"p_{r}"][mk], R["y"][mk]) for r in ("a", "b", "c", "b180", "b730")}
                    pl["n_rows"] = int(mk.sum())
                    pl["mean_y"] = float(R["y"][mk].mean()) if mk.any() else None
                    if has_d:
                        mkd = mk & R["in_d"]
                        pl["brier_d_set"] = {r: brier(R[f"p_{r}"][mkd], R["y"][mkd]) for r in ("a", "b", "c", "d")}
                        pl["n_rows_d_set"] = int(mkd.sum())
                # per-fold Brier and point BSS
                pf = {}
                for fi, fname in enumerate(fold_names):
                    mf = mT & (R["fold_i"] == fi)
                    if not mf.any():
                        continue
                    b = {r: brier(R[f"p_{r}"][mf], R["y"][mf]) for r in ("a", "b", "c")}
                    if has_d and R["in_d"][mf].all():
                        b["d"] = brier(R["p_d"][mf], R["y"][mf])
                    pf[fname] = {"n_rows": int(mf.sum()), "mean_y": float(R["y"][mf].mean()), "brier": b,
                                 "bss_point": {
                                     "b_vs_a": (1 - b["b"] / b["a"]) if b["a"] > 0 else None,
                                     "c_vs_b": (1 - b["c"] / b["b"]) if b["b"] > 0 else None,
                                     "d_vs_c": ((1 - b["d"] / b["c"]) if b["c"] > 0 else None) if "d" in b else None}}
                cell["per_fold"] = pf
                # pass flags, shipping, labels
                passes = {c: bool(cell["comparisons"].get(c) and cell["comparisons"][c]["ci_above_0"])
                          for c in DECIDING if c in cell["comparisons"]}
                cell["cell_pass"] = passes
                ship = shipped_rung(passes, has_d)
                cell["shipped_rung"] = ship
                cell["higher_rung_reports"] = higher_rung_reports(passes, cell["comparisons"], has_d)
                labels = {}
                for r in ("a", "b", "c") + (("d",) if has_d else ()):
                    src = tables["d"] if r == "d" else tables["full"]
                    cnt = cell["counts_d_set"] if r == "d" else cell["counts"]
                    cv = src["coverage"][r]
                    labels[r] = {"cov": cv["cov"], "cov_recent": cv["cov_recent"],
                                 "ece_m": src["ece"][r]["equal_mass"], "n_w_total": cnt["n_windows"],
                                 "period": cnt["period"]}
                    labels[r]["label"] = confidence_label(labels[r]["cov"], labels[r]["cov_recent"],
                                                          labels[r]["ece_m"], labels[r]["n_w_total"])
                cell["labels_all_rungs"] = labels
                cell["confidence_label"] = {"rung": ship, **labels[ship]}
                cell["fallbacks"] = fallback_counts(R, mT, None)
                cell["fallbacks"].update(cell_fallback_counts(fits_all[sk], T_h))
                per_T[T_LABEL[T_h]] = cell
                for setname, tb in tables.items():
                    for r, rel in tb["reliability"].items():
                        for binning in ("equal_mass", "equal_width"):
                            for row in rel[binning]:
                                rel_rows.append({"truth": truth, "asset": a, "T": T_LABEL[T_h], "set": setname,
                                                 "rung": r, "binning": binning, **row})
                    for r, cells in tb["coverage_cells"].items():
                        for c in cells:
                            cov_rows.append({"truth": truth, "asset": a, "T": T_LABEL[T_h], "set": setname,
                                             "rung": r, **c})
            verdicts = {}
            for c in DECIDING:
                if c == "d_vs_c" and not has_d:
                    continue
                n_pass = sum(bool(per_T[T_LABEL[T]]["cell_pass"].get(c)) for T in HORIZONS_H)
                verdicts[c] = {"horizons_passing": n_pass, "required": 4,
                               "verdict": "PASS" if n_pass >= 4 else "FAIL",
                               "per_horizon": {T_LABEL[T]: per_T[T_LABEL[T]]["cell_pass"].get(c) for T in HORIZONS_H}}
            results[block][a] = {"per_T": per_T, "rung_verdicts": verdicts}
    for (truth, T_h, s), v in pooled_store.items():
        results["pooled_eth_btc"].setdefault(truth, {}).setdefault(T_LABEL[T_h], {})[s] = v
    return results, boot_meta, rel_rows, cov_rows


def pool_rows(Rlist):
    keys = [k for k in Rlist[0] if isinstance(Rlist[0][k], np.ndarray)]
    out = {k: np.concatenate([R[k] for R in Rlist]) for k in keys}
    return out


def cell_fallback_counts(fits, T_h):
    out = {"c_cells": 0, "c_cells_fallback": 0, "d_cells": 0, "d_cells_fallback": 0,
           "c_fits_not_converged": 0, "d_fits_not_converged": 0}
    for f in fits:
        if f["T_h"] != T_h or f["rung"] not in ("c", "d"):
            continue
        r = f["rung"]
        out[f"{r}_cells"] += 1
        out[f"{r}_cells_fallback"] += int(f["fallback"])
        if not f["fallback"] and not f["converged"]:
            out[f"{r}_fits_not_converged"] += 1
    return out


def higher_rung_reports(passes, comps, has_d):
    order = ["a", "b", "c"] + (["d"] if has_d else [])
    name = {("b", "a"): "b_vs_a", ("c", "b"): "c_vs_b", ("d", "c"): "d_vs_c", ("c", "a"): "x_c_vs_a",
            ("d", "b"): "x_d_vs_b", ("d", "a"): "x_d_vs_a"}
    out = []
    for fi in range(1, len(order)):
        f, below = order[fi], order[fi - 1]
        if passes.get(name[(f, below)]):
            continue
        for r in order[fi + 1:]:
            c1, c2 = comps.get(name[(r, f)]), comps.get(name[(r, below)])
            if c1 and c2 and c1["ci_above_0"] and c2["ci_above_0"]:
                out.append({"failed_rung": f, "higher_rung": r, "beats": [f, below], "ships": False,
                            "note": "reported only; needs an owner ruling (A.6)"})
    return out


# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------
def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating,)):
        o = float(o)
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    return o


def write_json(path, obj, refuse_overwrite=False):
    if refuse_overwrite and os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists; refusing to overwrite.")
    with open(path, "w") as f:
        json.dump(_clean(obj), f, indent=1, allow_nan=False, ensure_ascii=False)
        f.write("\n")


def _f(v, fmt="{:.12g}"):
    if v is None:
        return ""
    v = float(v)
    return "" if not math.isfinite(v) else fmt.format(v)


def write_csv_gz(path, header, rows_iter):
    """Deterministic gzip (mtime=0, no embedded filename)."""
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            with io.TextIOWrapper(gz, encoding="utf-8", newline="") as txt:
                w = csv.writer(txt, lineterminator="\n")
                w.writerow(header)
                for r in rows_iter:
                    w.writerow(r)


def write_csv(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        for r in rows:
            w.writerow([_fmt_cell(r.get(h)) for h in header])


def _fmt_cell(v):
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, float):
        return _f(v)
    return "" if v is None else str(v)


FB = {0: "", 1: "cell", 2: "row", -1: ""}


def write_predictions(path, R, asset, rungs, extra_cols=()):
    fn = R["fold_names"]
    header = ["asset", "t0", "fold", "T", "k", "y"] + [f"p_{r}" for r in rungs] + list(extra_cols)
    order = np.lexsort((R["k"] * -1, R["T_h"], R["t0_i"]))

    def gen():
        for i in order:
            row = [asset, iso(START_TS + STEP * int(R["t0_i"][i])), fn[int(R["fold_i"][i])], T_LABEL[int(R["T_h"][i])],
                   repr(float(R["k"][i])), int(R["y"][i])]
            row += [_f(R[f"p_{r}"][i]) for r in rungs]
            for c in extra_cols:
                if c == "c_fallback":
                    row.append(FB[int(R["c_fb"][i])])
                elif c == "d_fallback":
                    row.append(FB[int(R["d_fb"][i])])
            yield row
    return header, gen()


def git_info(path):
    d = os.path.dirname(os.path.abspath(path))
    try:
        sha = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", d, "status", "--porcelain", "--", "a_touch.py", "test_a_touch.py"],
                               capture_output=True, text=True).stdout.strip()
        br = subprocess.run(["git", "-C", d, "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True,
                            text=True).stdout.strip()
        fc = subprocess.run(["git", "-C", d, "log", "-1", "--format=%H", "--", "a_touch.py"], capture_output=True,
                            text=True).stdout.strip()
        return {"head_commit": sha, "a_touch_last_commit": fc, "branch": br,
                "dirty_code_files": dirty.splitlines() if dirty else []}
    except Exception as e:  # pragma: no cover
        return {"error": str(e)}


def code_meta():
    here = os.path.abspath(__file__)
    return {"path": "scripts/research/history-forecasts/a_touch.py", "sha256": sha256_file(here), "git": git_info(here)}


# ---------------------------------------------------------------------------------------------
# Phase: dry run (data only; no scores)
# ---------------------------------------------------------------------------------------------
def run_dryrun(series, out_dir, input_meta, log=print):
    path = os.path.join(out_dir, "dryrun.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    t0 = time.time()
    out = {"phase": "dryrun", "prereg": PREREG, "code": code_meta(), "inputs": input_meta,
           "note": "Data-only counts. No Brier, BSS or label frequency is computed here. Fallback flags come "
                   "from episode counts of the training labels (counts are not reported).",
           "series": {}}
    for key, ser in series.items():
        folds, dn = series_folds(ser)
        s_out = {"asset": ser.asset, "truth": ser.truth, "levels": list(ser.levels),
                 "coverage_start": iso(START_TS + STEP * ser.cov_i),
                 "feature_first_defined": {}, "per_T": {}}
        for name, arr in (("rv30", ser.rv30), ("rv_pct", ser.rv_pct), ("trend90", ser.trend90),
                          ("dd90", ser.dd90), ("all3", np.where(ser.feat_ok, 1.0, np.nan))) + (
                (("dvol", ser.sigma_dvol),) if ser.sigma_dvol is not None else ()):
            fin = np.where(np.isfinite(arr))[0]
            s_out["feature_first_defined"][name] = iso(START_TS + STEP * int(fin[0])) if len(fin) else None
            s_out["feature_first_defined"][name + "_n_undefined_after_first"] = \
                int((~np.isfinite(arr[fin[0]:])).sum()) if len(fin) else None
        for T_h in HORIZONS_H:
            y = ser.labels(T_h)
            lab_ok = np.isfinite(y[:, 0])
            per_fold = {}
            tot = {"c_fallback_cells": 0, "d_fallback_cells": 0, "cells": 0, "d_cells": 0}
            for f in folds:
                tr = train_origins(lab_ok, f["qs_i"], T_h)
                te = test_origins(f["qs_i"], f["qe_i"], ser.n_orig)
                te_l = te[lab_ok[te]]
                trc = tr[ser.feat_ok[tr]]
                in_d = f["name"] in dn and ser.sigma_dvol is not None
                trd = trc[np.isfinite(ser.sigma_dvol[trc])] if in_d else np.array([], dtype=int)
                c_fb, d_fb = [], []
                for j in range(len(ser.levels)):
                    pos, neg = count_episodes(trc, y[trc, j])
                    c_fb.append(bool(pos < MIN_EPISODES or neg < MIN_EPISODES))
                    if in_d:
                        pos, neg = count_episodes(trd, y[trd, j])
                        d_fb.append(bool(pos < MIN_EPISODES or neg < MIN_EPISODES))
                tot["cells"] += len(ser.levels)
                tot["c_fallback_cells"] += sum(c_fb)
                if in_d:
                    tot["d_cells"] += len(ser.levels)
                    tot["d_fallback_cells"] += sum(d_fb)
                per_fold[f["name"]] = {
                    "n_train_ab": int(len(tr)), "n_train_c": int(len(trc)), "n_train_d": int(len(trd)) if in_d else None,
                    "train_first": iso(START_TS + STEP * int(tr[0])) if len(tr) else None,
                    "train_last": iso(START_TS + STEP * int(tr[-1])) if len(tr) else None,
                    "train_last_window_end": iso(START_TS + STEP * (int(tr[-1]) + T_h)) if len(tr) else None,
                    "n_test_issue_times": int(len(te)), "n_test_labelled_t0": int(len(te_l)),
                    "n_test_rows_per_level": int(len(te_l)),
                    "test_t0_feature_defined": int(ser.feat_ok[te_l].sum()),
                    "test_t0_dvol_defined": int(np.isfinite(ser.sigma_dvol[te_l]).sum()) if in_d else None,
                    "c_fallback_levels": [ser.levels[j] for j, v in enumerate(c_fb) if v],
                    "d_fallback_levels": [ser.levels[j] for j, v in enumerate(d_fb) if v] if in_d else None,
                    "in_d_folds": f["name"] in dn,
                }
            s_out["per_T"][T_LABEL[T_h]] = {"per_fold": per_fold, "totals": tot,
                                            "n_test_rows_total": int(sum(v["n_test_labelled_t0"] for v in per_fold.values())
                                                                     * len(ser.levels))}
        out["series"][key] = s_out
        log(f"dryrun {key} done")
    out["runtime_seconds"] = round(time.time() - t0, 2)
    write_json(path, out, refuse_overwrite=True)
    return out


# ---------------------------------------------------------------------------------------------
# Phase: run (fit + predict + score ONCE)
# ---------------------------------------------------------------------------------------------
def run_all(series, out_dir, input_meta, workers=4, log=print):
    results_path = os.path.join(out_dir, "results.json")
    if os.path.exists(results_path):
        raise SystemExit(f"STOP: {results_path} exists. The test set is scored once.")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
    global _SERIES
    _SERIES = series
    tasks = [(k, T_h) for k in series for T_h in HORIZONS_H]
    outs = {}
    if workers > 1:
        ctx = mp.get_context("fork")
        with ctx.Pool(workers) as pool:
            for key, T_h, res in pool.imap_unordered(run_series_horizon, tasks):
                outs[(key, T_h)] = res
                log(f"  fit {key} {T_LABEL[T_h]} ({len(outs)}/{len(tasks)}) {time.time() - t_start:.0f}s")
    else:
        for t in tasks:
            key, T_h, res = run_series_horizon(t)
            outs[(key, T_h)] = res
            log(f"  fit {key} {T_LABEL[T_h]} ({len(outs)}/{len(tasks)}) {time.time() - t_start:.0f}s")
    t_fit = time.time() - t_start
    Rs, fits_all = {}, {}
    for key, ser in series.items():
        Rs[key], fits_all[key] = assemble(ser, {T_h: outs[(key, T_h)] for T_h in HORIZONS_H})
    log(f"assembled; scoring ({time.time() - t_start:.0f}s)")
    res, boot_meta, rel_rows, cov_rows = run_score(series, Rs, fits_all, out_dir, log=log)

    # outputs
    rung_cols = ["a", "b", "c", "d"]
    for truth, fname in (("oracle", "predictions-test.csv.gz"), ("binance", "predictions-test-binance.csv.gz")):
        header, gens = None, []
        for a in (ASSETS if truth == "oracle" else SECONDARY_ASSETS):
            h, g = write_predictions(None, Rs[f"{truth}:{a}"], a, rung_cols, ("c_fallback", "d_fallback"))
            header = h
            gens.append(g)
        write_csv_gz(os.path.join(out_dir, fname), header, (r for g in gens for r in g))
    for truth, fname in (("oracle", "predictions-test-sens-ref.csv.gz"),
                         ("binance", "predictions-test-binance-sens-ref.csv.gz")):
        header, gens = None, []
        for a in (ASSETS if truth == "oracle" else SECONDARY_ASSETS):
            h, g = write_predictions(None, Rs[f"{truth}:{a}"], a, ["b180", "b730", "rv30", "rv90"])
            header = h
            gens.append(g)
        write_csv_gz(os.path.join(out_dir, fname), header, (r for g in gens for r in g))
    rel_h = ["truth", "asset", "T", "set", "rung", "binning", "bin", "n", "mean_p", "mean_y", "p_lo", "p_hi"]
    write_csv(os.path.join(out_dir, "reliability.csv"), rel_h, rel_rows)
    cov_h = ["truth", "asset", "T", "set", "rung", "fold", "k", "n_rows", "n_w", "ybar", "pbar", "band_lo",
             "band_hi", "covered"]
    write_csv(os.path.join(out_dir, "coverage.csv"), cov_h, cov_rows)
    fit_h = ["series", "T", "fold", "rung", "k", "n_train_ab", "n_train", "pos_episodes", "neg_episodes", "fallback",
             "intercept", "coef", "mu", "sd", "n_iter", "converged", "p_a", "p_b"]
    fit_rows = []
    for key in series:
        for f in fits_all[key]:
            fit_rows.append([f["series"], T_LABEL[f["T_h"]], f["fold"], f["rung"], repr(f.get("k", "")),
                             f.get("n_train_ab", ""), f.get("n_train", ""), f.get("pos_episodes", ""),
                             f.get("neg_episodes", ""), f.get("fallback", ""), _f(f.get("intercept")),
                             json.dumps(f.get("coef")) if f.get("coef") is not None else "",
                             json.dumps(f.get("mu")) if f.get("mu") is not None else "",
                             json.dumps(f.get("sd")) if f.get("sd") is not None else "",
                             f.get("n_iter", ""), f.get("converged", ""),
                             json.dumps(f.get("p_a")) if f.get("p_a") is not None else "",
                             json.dumps(f.get("p_b")) if f.get("p_b") is not None else ""])
    write_csv_gz(os.path.join(out_dir, "fits.csv.gz"), fit_h, fit_rows)

    import sklearn
    import scipy
    summary = {
        "test": "Q26 workstream A", "prereg": PREREG, "code": code_meta(), "inputs": input_meta,
        "environment": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
                        "sklearn": sklearn.__version__, "workers": workers},
        "constants": {"levels": LEVELS, "horizons_h": HORIZONS_H, "H_main_days": H_MAIN, "H_sens_days": H_SENS,
                      "n_boot": N_BOOT, "seed_block": SEED_BLOCK, "seed_iid": SEED_IID,
                      "data_end": iso(DATA_END), "coverage_start": {a: iso(v) for a, v in COVERAGE_START.items()},
                      "logistic": LOGIT_KW, "min_episodes": MIN_EPISODES},
        "DECISIONS": DECISIONS,
        "deviations": [],
        "notes": {
            "ece_equal_width": "Equal-width ECE is dominated by near-zero probabilities (most rows have p < 0.1, "
                               "so it mostly measures the first bin). Equal-mass ECE is the one A.7 uses.",
            "deciding": "Deciding: primary truth (oracle), H = 365 d, comparisons b_vs_a, c_vs_b (all folds) and "
                        "d_vs_c (rung-d folds). Everything else (secondary_binance, pooled_eth_btc, sens_*, "
                        "ref_*, x_*, per_level, per_fold) is reported, never deciding.",
            "bss": "BSS(r vs base) = 1 - Brier_r / Brier_base on rows where both exist.",
        },
        "bootstrap": boot_meta,
        **res,
        "run": {"started_utc": started, "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "fit_predict_seconds": round(t_fit, 1), "total_seconds": round(time.time() - t_start, 1)},
    }
    write_json(results_path, summary, refuse_overwrite=True)
    log(f"results written ({time.time() - t_start:.0f}s)")
    return summary


# ---------------------------------------------------------------------------------------------
# Phase: panel (A.8)
# ---------------------------------------------------------------------------------------------
PUBLIC_RPCS = ("https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://rpc.ankr.com/eth",
               "https://eth.drpc.org", "https://cloudflare-eth.com")
FEEDS = {"ETH": ("0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", 8),
         "BTC": ("0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", 8),
         "stETH": ("0x86392dC19c0b719886221c78AB11eb8Cf5c52812", 18)}
SEL_LATEST = "feaf968c"
SEL_GET = "9a6fc8f5"
SEL_DESC = "7284e416"


class Rpc:
    def __init__(self, urls=PUBLIC_RPCS, timeout=20):
        self.urls, self.timeout, self.cur, self.calls, self.errors = list(urls), timeout, 0, 0, []

    def call_many(self, calls):
        body = [{"jsonrpc": "2.0", "id": i + 1, "method": "eth_call", "params": [{"to": to, "data": "0x" + d}, "latest"]}
                for i, (to, d) in enumerate(calls)]
        while self.cur < len(self.urls):
            try:
                req = urllib.request.Request(self.urls[self.cur], data=json.dumps(body).encode(), method="POST",
                                             headers={"Content-Type": "application/json",
                                                      "User-Agent": "membrane-research/1.0"})
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    resp = json.loads(r.read())
                if isinstance(resp, dict):
                    resp = [resp]
                by = {x.get("id"): x for x in resp}
                out = []
                for q in body:
                    x = by.get(q["id"])
                    if x is None or "error" in x:
                        out.append(None)
                    else:
                        out.append(bytes.fromhex(x["result"][2:]))
                self.calls += len(calls)
                if any(o is None for o in out) and len(calls) > 1 and all(o is None for o in out):
                    raise RuntimeError("batch rejected")
                return out
            except Exception as e:
                self.errors.append(f"rpc#{self.cur}: {type(e).__name__}")
                self.cur += 1
        raise RuntimeError("all public RPCs failed")


def _round(b):
    w = [int.from_bytes(b[32 * i:32 * (i + 1)], "big") for i in range(5)]
    ans = w[1] - (1 << 256) if w[1] >= (1 << 255) else w[1]
    return {"roundId": w[0], "answer": ans, "updatedAt": w[3]}


def chainlink_rounds_since(rpc, proxy, t_stop, max_rounds=3000):
    """Walk back from latestRoundData through aggregator round ids (same phase) until a round with
    updatedAt <= t_stop is found. Returns rounds ascending by updatedAt (the first is in force at t_stop)."""
    latest = _round(rpc.call_many([(proxy, SEL_LATEST)])[0])
    rounds = [latest]
    rid = latest["roundId"]
    phase, agg = rid >> 64, rid & ((1 << 64) - 1)
    while rounds[-1]["updatedAt"] > t_stop:
        ids = [(phase << 64) | a for a in range(agg - 1, max(0, agg - 26), -1)]
        if not ids:
            raise RuntimeError("phase start reached before t_stop")
        res = rpc.call_many([(proxy, SEL_GET + format(r, "064x")) for r in ids])
        for r_id, b in zip(ids, res):
            if b is None:
                raise RuntimeError("getRoundData failed")
            r = _round(b)
            if r["updatedAt"] == 0:
                raise RuntimeError("empty round")
            rounds.append(r)
            if r["updatedAt"] <= t_stop:
                break
        agg = ids[-1] & ((1 << 64) - 1)
        if len(rounds) > max_rounds:
            raise RuntimeError("too many rounds")
    return sorted(rounds, key=lambda r: (r["updatedAt"], r["roundId"]))


def answer_in_force(rounds, ts):
    best = None
    for r in rounds:
        if r["updatedAt"] <= ts:
            best = r
    return best


def history_count(ser, T_h, j):
    """D20: non-overlapping windows over the full labelled history."""
    y = ser.labels(T_h)[:, j]
    ok = np.isfinite(y)
    i_all = np.where(ok & (np.arange(len(y)) % ISSUE_EVERY_H == 0))[0]
    if not len(i_all):
        return None
    step = max(T_h, ISSUE_EVERY_H)
    starts = np.arange(i_all[0], len(y), step)
    starts = starts[ok[starts]]
    k = int(y[starts].sum())
    return {"touched": k, "windows": int(len(starts)),
            "period": [iso(START_TS + STEP * int(starts[0])), iso(START_TS + STEP * (int(starts[-1]) + T_h))]}


def fetch_dvol_candle(asset, open_ts):
    """Deribit public get_volatility_index_data (no key): the hourly candle opening at open_ts.
    Returns {candle_open, close, fetched_at_utc, response_sha256, url} or None."""
    url = ("https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=" + asset +
           f"&start_timestamp={(open_ts - 6 * STEP) * 1000}&end_timestamp={open_ts * 1000}&resolution=3600")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "membrane-research/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
        rows = json.loads(raw)["result"]["data"]
        hit = [row for row in rows if int(row[0]) == open_ts * 1000]
        if not hit:
            return None
        return {"candle_open": iso(open_ts), "close": float(hit[0][4]), "source": url,
                "fetched_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "response_sha256": hashlib.sha256(raw).hexdigest()}
    except Exception:
        return None


def coverage_nontrivial(cells, last_folds):
    """Coverage after excluding trivial cells (ybar == 0 and pbar < 1/n_w), reported beside the registered
    cov (which is not changed). cells: dicts with fold, ybar, pbar, n_w, covered."""
    def cov_flag(v):
        return v.strip() in ("1", "True", "true") if isinstance(v, str) else bool(v)

    def frac(cs):
        return float(np.mean([cov_flag(c["covered"]) for c in cs])) if cs else None
    keep = [c for c in cells if not (float(c["ybar"]) == 0.0 and float(c["pbar"]) < 1.0 / int(c["n_w"]))]
    rec_all = [c for c in cells if c["fold"] in last_folds]
    rec = [c for c in keep if c["fold"] in last_folds]
    return {"cov_nontrivial": frac(keep), "cov_recent_nontrivial": frac(rec),
            "n_cells": len(cells), "n_cells_excluded": len(cells) - len(keep), "n_cells_nontrivial": len(keep),
            "n_cells_recent": len(rec_all), "n_cells_recent_nontrivial": len(rec),
            "cov_registered_recomputed": frac(cells), "cov_recent_registered_recomputed": frac(rec_all),
            "rule": "exclude cells with ybar == 0 and pbar < 1/n_w; reported only, the registered label is unchanged"}


def level_means(cells):
    """Per-level mean forecast vs realized test frequency, row-weighted over fold cells."""
    out = {}
    for k in sorted({float(c["k"]) for c in cells}, reverse=True):
        cs = [c for c in cells if float(c["k"]) == k]
        n = sum(int(c["n_rows"]) for c in cs)
        mp = sum(int(c["n_rows"]) * float(c["pbar"]) for c in cs) / n
        my = sum(int(c["n_rows"]) * float(c["ybar"]) for c in cs) / n
        out[repr(k)] = {"n_rows": n, "mean_forecast": mp, "realized_frequency": my,
                        "forecast_over_realized": (mp / my) if my > 0 else None}
    return out


def read_coverage_cells(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def write_rounds_csv(path, live, live_rounds, asof_ts):
    """Every Chainlink round used for the panel: the round in force at DATA_END and every round after it."""
    rows = []
    for a, rounds in live_rounds.items():
        dec = FEEDS[a][1]
        for r in rounds:
            role = ("in_force_at_data_end" if r["updatedAt"] <= DATA_END else
                    "after_data_end_up_to_asof" if r["updatedAt"] <= asof_ts else "after_asof_not_used")
            rows.append([a, live[a]["description"], FEEDS[a][0], dec, str(r["roundId"]), r["roundId"] >> 64,
                         r["roundId"] & ((1 << 64) - 1), str(r["answer"]), repr(r["answer"] / 10 ** dec),
                         r["updatedAt"], iso(r["updatedAt"]), role])
    write_csv_gz(path, ["asset", "description", "proxy", "decimals", "roundId", "phaseId", "aggregatorRoundId",
                        "answer_raw", "price", "updatedAt", "updatedAt_iso", "role"], rows)
    return len(rows)


def run_panel(series, out_dir, input_meta, try_rpc=True, log=print, results_dir=None, results_sha256=None):
    path = os.path.join(out_dir, "panel.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
    results_dir = results_dir or out_dir
    res_path = os.path.join(results_dir, "results.json")
    res_sha = sha256_file(res_path)
    if results_sha256 is not None and res_sha != results_sha256:
        raise SystemExit(f"STOP: results.json sha256 {res_sha} != expected {results_sha256}")
    with open(res_path) as f:
        res = json.load(f)
    cov_path = os.path.join(results_dir, "coverage.csv")
    cov_cells = read_coverage_cells(cov_path)
    N = series["oracle:ETH"].N
    qs = N  # Q_start = DATA_END
    panel = {"phase": "panel", "prereg": PREREG, "code": code_meta(), "inputs": input_meta,
             "results_sha256": res_sha, "results_path": os.path.abspath(res_path),
             "coverage_csv_sha256": sha256_file(cov_path),
             "fit": "each shipped rung refit once on all labelled origins with t + T <= DATA_END "
                    f"({iso(DATA_END)}); recency weights age from DATA_END",
             "assets": {}, "asof": {}, "notes": []}
    # asof / live closes (A.8)
    asof_info = {"data_end": iso(DATA_END), "source": "dataset", "asof": iso(DATA_END)}
    live, live_rounds = {}, {}
    if try_rpc:
        now = int(time.time())
        asof_ts = (now // STEP) * STEP
        try:
            rpc = Rpc()
            for a in ASSETS:
                proxy, dec = FEEDS[a]
                desc = rpc.call_many([(proxy, SEL_DESC)])[0]
                dtxt = desc[64:64 + int.from_bytes(desc[32:64], "big")].decode() if desc else None
                rounds = chainlink_rounds_since(rpc, proxy, DATA_END)
                live_rounds[a] = rounds
                r_end = answer_in_force(rounds, DATA_END)
                r_asof = answer_in_force(rounds, asof_ts)
                live[a] = {"description": dtxt, "decimals": dec,
                           "in_force_at_data_end": {"roundId": str(r_end["roundId"]), "updatedAt": r_end["updatedAt"],
                                                    "price": r_end["answer"] / 10 ** dec},
                           "dataset_close_at_data_end": float(series[f"oracle:{a}"].close[N - 1]),
                           "in_force_at_asof": {"roundId": str(r_asof["roundId"]), "updatedAt": r_asof["updatedAt"],
                                                "updatedAt_iso": iso(r_asof["updatedAt"]),
                                                "price": r_asof["answer"] / 10 ** dec},
                           "n_rounds_after_data_end": int(sum(r["updatedAt"] > DATA_END for r in rounds)),
                           "rounds_sha256": hashlib.sha256(json.dumps(
                               [[str(r["roundId"]), r["answer"], r["updatedAt"]] for r in rounds]).encode()).hexdigest()}
            asof_info = {"data_end": iso(DATA_END), "source": "chainlink getRoundData via public RPC",
                         "asof": iso(asof_ts), "rpc_calls": rpc.calls, "rpc_errors": rpc.errors,
                         "read_at_utc": iso(now)}
        except Exception as e:
            asof_info["rpc_failed"] = f"{type(e).__name__}: {e}"
            live, live_rounds = {}, {}
    panel["asof"] = asof_info
    panel["live_chainlink"] = live
    asof_ts = utc(asof_info["asof"])
    if live_rounds:
        rpath = os.path.join(out_dir, "panel-chainlink-rounds.csv.gz")
        n_r = write_rounds_csv(rpath, live, live_rounds, asof_ts)
        panel["chainlink_rounds_file"] = {"file": "panel-chainlink-rounds.csv.gz", "rows": n_r,
                                          "sha256": sha256_file(rpath),
                                          "columns": "asset, description, proxy, decimals, roundId, phaseId, "
                                                     "aggregatorRoundId, answer_raw, price, updatedAt, updatedAt_iso, role"}
    for a in ASSETS:
        ser = series[f"oracle:{a}"]
        prim = res["primary"][a]["per_T"]
        has_d = a in D_ASSETS
        nK = len(ser.levels)
        needs = {prim[T_LABEL[T]]["shipped_rung"] for T in HORIZONS_H}
        grids = {r: np.full((len(HORIZONS_H), nK), np.nan) for r in ("a", "b", "c", "d")}
        te_feat, te_sigma, feat_info = None, None, None
        if needs & {"c", "d"}:
            if a in live_rounds and asof_ts > DATA_END:
                # hourly closes after DATA_END = answer in force at each hour end, from the recorded rounds
                dec = FEEDS[a][1]
                ends = np.arange(DATA_END + STEP, asof_ts + 1, STEP)
                ext = np.array([answer_in_force(live_rounds[a], int(e))["answer"] / 10 ** dec for e in ends])
                ser_x = Series(a, "oracle", np.concatenate([ser.close, ext]), np.concatenate([ser.low, ext]),
                               COVERAGE_START[a])
                te_feat = ser_x.feat[ser_x.N][None, :]
                feat_info = {"features_at": iso(asof_ts), "live_hours_spliced": int(len(ext)),
                             "rv_pct": float(te_feat[0, 0]), "trend90": float(te_feat[0, 1]),
                             "dd90": float(te_feat[0, 2])}
            else:
                te_feat = ser.feat[N][None, :]
                feat_info = {"features_at": iso(DATA_END), "note": "no live closes; frozen data", 
                             "rv_pct": float(te_feat[0, 0]), "trend90": float(te_feat[0, 1]),
                             "dd90": float(te_feat[0, 2])}
            if "d" in needs and has_d:
                dv = fetch_dvol_candle(a, asof_ts - STEP) if asof_ts > DATA_END else None
                if dv is not None:
                    te_sigma = np.array([dv["close"] / 100.0])
                    feat_info["dvol"] = dv
                else:
                    te_sigma = ser.sigma_dvol[[N]]
                    feat_info["dvol"] = {"candle_open": iso(DATA_END - STEP), "close": float(te_sigma[0] * 100),
                                         "source": "frozen dataset"}
        train_n = {}
        for ti, T_h in enumerate(HORIZONS_H):
            o = fit_predict_fold(ser, T_h, qs, np.array([N]), in_d=has_d, keep_models=False,
                                 te_feat=te_feat, te_sigma=te_sigma)
            for r in ("a", "b", "c", "d"):
                if r in o["raw"]:
                    grids[r][ti] = o["raw"][r][0]
            train_n[T_LABEL[T_h]] = {"n_train_ab": o["n_train_ab"], "n_train_c": o.get("n_train_c"),
                                     "n_train_d": o.get("n_train_d"),
                                     "c_cell_fallback": [ser.levels[j] for j in range(nK) if o["c_cell_fb"][j]]}
        feat_note = feat_info
        fixed = {r: monotone_fix(g) for r, g in grids.items() if not np.isnan(g).any()}
        cells = {}
        for ti, T_h in enumerate(HORIZONS_H):
            pc = prim[T_LABEL[T_h]]
            ship = pc["shipped_rung"]
            lab = pc["confidence_label"]
            row = {"shipped_rung": ship, "label": lab["label"], "n_w_total": lab["n_w_total"],
                   "period": lab["period"], "levels": {}}
            setname = "d" if ship == "d" else "full"
            sc = [c for c in cov_cells if c["truth"] == "oracle" and c["asset"] == a and c["T"] == T_LABEL[T_h]
                  and c["set"] == setname and c["rung"] == ship]
            last4 = set(sorted({c["fold"] for c in sc})[-4:])
            row["coverage_nontrivial"] = coverage_nontrivial(sc, last4)
            row["coverage_nontrivial"]["cov_registered"] = lab["cov"]
            row["coverage_nontrivial"]["cov_recent_registered"] = lab["cov_recent"]
            row["forecast_vs_realized_by_level"] = level_means(sc)
            for j, k in enumerate(ser.levels):
                p = float(fixed[ship][ti, j])
                hc = history_count(ser, T_h, j)
                cellv = {"history_count": hc}
                if lab["label"] in ("HIGH", "MEDIUM"):
                    cellv["display"] = (f"{fmt_p(p)} {lab['label']} n={lab['n_w_total']:.0f} "
                                        f"{lab['period'][0][:10]}..{lab['period'][1][:10]}")
                    cellv["p"] = p
                else:
                    cellv["display"] = (f"touched in {hc['touched']} of {hc['windows']} non-overlapping windows, "
                                        f"{hc['period'][0][:10]}..{hc['period'][1][:10]}" +
                                        (" [hatched]" if lab["label"] == "STALE" else ""))
                    cellv["p_not_for_display"] = p
                row["levels"][repr(k)] = cellv
            cells[T_LABEL[T_h]] = row
        panel["assets"][a] = {"cells": cells, "training_counts": train_n, "feature_note": feat_note,
                              "grids_fixed_all_rungs_not_for_display": {r: g.tolist() for r, g in fixed.items()}}
    # ACTION rows, ETH example
    ser = series["oracle:ETH"]
    if "ETH" in live:
        S = live["ETH"]["in_force_at_asof"]["price"]
        s_src = f"Chainlink ETH/USD answer in force at asof {asof_info['asof']} (round {live['ETH']['in_force_at_asof']['roundId']})"
    else:
        S = float(ser.close[N - 1])
        s_src = f"dataset oracle close at DATA_END {iso(DATA_END)}"
    C, LT = EXAMPLE["collateral_units"], EXAMPLE["LT"]
    D = C * LT * S * (1.0 + EXAMPLE["line_distance"])
    ti7 = HORIZONS_H.index(ACTION_T_H)
    prim = res["primary"]["ETH"]["per_T"]
    lab7 = prim["7d"]["confidence_label"]["label"]
    ship7 = prim["7d"]["shipped_rung"]
    probs7 = [float(v) for v in panel["assets"]["ETH"]["grids_fixed_all_rungs_not_for_display"][ship7][ti7]]
    P_liq = D / (C * LT)
    y_now = P_liq / S - 1.0
    computed = action_rows(LEVELS["ETH"], probs7, D, C, LT, S, y_now=y_now)
    cur = {}
    for ti, T_h in enumerate(HORIZONS_H):
        shipT = prim[T_LABEL[T_h]]["shipped_rung"]
        labT = prim[T_LABEL[T_h]]["confidence_label"]["label"]
        pT = [float(v) for v in panel["assets"]["ETH"]["grids_fixed_all_rungs_not_for_display"][shipT][ti]]
        jl = LEVELS["ETH"].index(level_toward_risk(LEVELS["ETH"], y_now))
        hc = history_count(ser, T_h, jl)
        disp, p, st = current_line_display(LEVELS["ETH"], pT, y_now, labT, hc)
        cur[T_LABEL[T_h]] = {"label": labT, "rung": shipT, "P_computed_not_for_display_unless_HIGH_MEDIUM": p,
                             "status": st, "display": disp}
    hc7 = history_count(ser, ACTION_T_H, LEVELS["ETH"].index(level_toward_risk(LEVELS["ETH"], y_now)))
    panel["action_example"] = {
        "label": "EXAMPLE position (not a real position; no number goes into app code)",
        "position": {"collateral": f"{C:g} ETH", "LT": LT, "spot_S": S, "spot_source": s_src,
                     "debt_D_usd": D, "debt_rule": "D = C * LT * S * (1 - 0.25), exact (line at -25% from spot)",
                     "P_liq": P_liq, "distance_y": y_now, "distance_shown_pct": floor_pct_toward_risk(y_now)},
        "seven_day_label": lab7, "seven_day_rung": ship7,
        "action_rows_displayed": lab7 in ("HIGH", "MEDIUM"),
        "display": ([r["text"] for r in computed] if lab7 in ("HIGH", "MEDIUM") else
                    [f"touched in {hc7['touched']} of {hc7['windows']} non-overlapping 7d windows at "
                     f"{level_toward_risk(LEVELS['ETH'], y_now):+.0%}, "
                     f"{hc7['period'][0][:10]}..{hc7['period'][1][:10]} (no action row: 7d label {lab7})"]),
        "computed_not_for_display_unless_HIGH_MEDIUM": computed,
        "current_line_by_horizon": cur,
    }
    panel["dateline"] = (f"Probabilities trained on Chainlink oracle data to {iso(DATA_END)}; spot asof "
                         f"{asof_info['asof']} ({asof_info['source']}). Input age at asof: "
                         f"{(utc(asof_info['asof']) - DATA_END) / 3600:.0f} h since DATA_END.")
    write_json(path, panel, refuse_overwrite=True)
    return panel


def run_manifest(out_dir):
    files = sorted(f for f in os.listdir(out_dir) if f != "manifest.json" and not f.startswith("."))
    man = {"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "code": code_meta(),
           "files": {f: {"bytes": os.path.getsize(os.path.join(out_dir, f)),
                         "sha256": sha256_file(os.path.join(out_dir, f))} for f in files}}
    big = [f for f, v in man["files"].items() if v["bytes"] >= 50 * 1024 * 1024]
    if big:
        raise SystemExit(f"STOP: files >= 50 MB: {big}")
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
        f.write("\n")
    return man


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", choices=("dryrun", "run", "panel", "manifest"), required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--no-rpc", action="store_true")
    ap.add_argument("--results-dir", help="panel: directory holding the scored results.json and coverage.csv "
                                          "(default --out); read in place, never copied")
    ap.add_argument("--results-sha256", help="panel: expected sha256 of results.json (STOP on mismatch)")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "manifest":
        run_manifest(a.out)
        return 0
    meta = verify_inputs(a.datasets)
    print("inputs verified:", ", ".join(v["path"] for v in meta.values()), flush=True)
    t = time.time()
    series = build_series(a.datasets)
    print(f"series built in {time.time() - t:.1f}s", flush=True)
    log = lambda *x: print(*x, flush=True)
    if a.phase == "dryrun":
        run_dryrun(series, a.out, meta, log=log)
    elif a.phase == "run":
        run_all(series, a.out, meta, workers=a.workers, log=log)
    elif a.phase == "panel":
        run_panel(series, a.out, meta, try_rpc=not a.no_rpc, log=log, results_dir=a.results_dir,
                  results_sha256=a.results_sha256)
    return 0


if __name__ == "__main__":
    sys.exit(main())
