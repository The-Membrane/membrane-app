#!/usr/bin/env python3
"""Q26 workstream A6 -- horizon-matched volatility scale (fh), log-HAR scale (fH), beta recalibration (fHb),
sturdier evaluation, and blind set 5.

Implements triccs/membrane-board `design/HISTORY_TOUCH_PREREG_A6.md` (registered at commit 3a38083, file sha256
8fd0445ffad72db722244aaa1683e80d3431d19d400f396b3d9cfba32214a451). Parents: A, A2 (D1-D3), A3 (D1), A4 (D1),
A5 (D1); every definition not changed by A6 holds. The A..A5 code is imported and never modified.

Phases (run in this order into a fresh --out):
  dryrun    data-only counts (no label value, frequency, volatility statistic or score; blind set 5 not read)
            -> dryrun.json
  a60       A6.0 diagnostic: mean/median ln(sigma_fut/sigma_hat) by regime tercile (fits nothing, decides nothing)
            -> a60-diagnostic.json
  dev       all development data (A5 data + blind set 4) fit, predict and score ONCE; seed-stable shipping over
            a/f/fbL/fh/fH/fHb; labels (A3.5 + A5 per-source rule + asset-matched + generic); basis strings;
            sturdier evaluation (DM+HLN, CORP, stationary bootstrap, extra-seed label agreement); estimate ranges
            with every fitted quantity re-estimated per resample; freeze
            -> results-dev.json, frozen-a6.json (+ .sha256), predictions-dev-*.csv.gz, labels-frozen.csv,
               w-table.csv, har-table.csv, betamap-table.csv, beta-table.csv, levels-other-series.csv.gz
  preview   panel preview from the frozen labels at a current asof (before blind set 5) -> panel-preview.json
  blind5    blind set 5 read ONCE (A6.6), only with --blind5-commit and frozen-a6.json whose sha256 matches;
            writes a start marker and refuses a second run -> results-blind5.json, basis-final.csv
  panel     current-day panel with the blind-5 basis -> panel.json
  manifest  sha256 of every output -> manifest.json
Light models only (frequency counts, FHS counts, two closed-form regressions and a 4-parameter ridge logistic map).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):   # one thread per worker
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import copy  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import warnings  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.special import expit  # noqa: E402
from scipy.stats import t as student_t  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402
import a4_touch as M4  # noqa: E402
import a5_touch as M5  # noqa: E402

PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A6.md",
    "commit": "3a38083",
    "sha256": "8fd0445ffad72db722244aaa1683e80d3431d19d400f396b3d9cfba32214a451",
    "parents": {"A": A.PREREG, "A2": M2.PREREG, "A3": M3.PREREG, "A4": M4.PREREG, "A5": M5.PREREG,
                "A5_D1": "findings recorded after the A5 dev and blind-4 scores; rules unchanged"},
}

STEP, DAY = 3600, 86400
DATA_END = A.DATA_END
HORIZONS_H = A.HORIZONS_H
T_LABEL = A.T_LABEL
LEVELS = A.LEVELS
LADDER = M3.LADDER
REGIMES = M3.REGIMES
DEV_ASSETS = ("ETH", "BTC", "stETH")
BSPAN_ASSETS = ("ETH", "BTC")
BETAS = M3.BETAS
BETA_HISTORY_DAYS = M3.BETA_HISTORY_DAYS
BLIND3_DIR, BLIND3_COMMIT = M5.BLIND3_DIR, M5.BLIND3_COMMIT
BLIND4_DIR, BLIND4_COMMIT = M5.BLIND4_DIR, "cdcd997"
BLIND5_DIR = "blind5-prices"
SOURCES = M5.SOURCES
ASSET_MATCHED = M4.ASSET_MATCHED

N_BOOT = 2000
SEED_REG = 20261070                                       # A6.3
SEEDS_FURTHER = tuple(20261071 + i for i in range(20))    # 20261071..20261090
SEEDS_EXTRA = tuple(20261091 + i for i in range(5))       # 20261091..20261095 (label agreement)
MIN_SEEDS = 16
SEED_SENSITIVE_MIN = 2
SEED_BAND = M4.SEED_BAND                                  # estimate ranges as A4.3 (20261040)
SEED_BLIND5 = 20261071                                    # A6.6
N_BAND_REP, BAND_PCT = M4.N_BAND_REP, M4.BAND_PCT

W_CLIP = (0.0, 1.25)                                      # A6.2 (fh)
W_DEFAULT = 0.5                                           # D-W1: no regression origin
HAR_WINDOWS = (24, 168, 720)                              # A6.2 (fH): daily, weekly, monthly
ANNUAL = 8760.0
P_CLIP = M2.FEAT_CLIP                                     # D-HB1: [1e-4, 1 - 1e-4] before the logs
RIDGE = 1.0                                               # A6.2 (fHb)
IDENTITY = np.array([0.0, 1.0, 1.0, 0.0])                 # (intercept, ln p, -ln(1-p), v)
PARK = 1.0 / (4.0 * math.log(2.0))

CANDIDATES = ("a", "f", "fbL", "fh", "fH", "fHb")
NEW_RUNGS = ("fh", "fH", "fHb")
RUNGS = CANDIDATES + ("r30", "r90")
SHIP_ORDER = CANDIDATES                                   # A6.3 tie order
PAIRS = tuple((f"{y}_vs_{x}", y, x) for y in CANDIDATES for x in CANDIDATES if y != x) + \
    (("r30_vs_a", "r30", "a"), ("r90_vs_a", "r90", "a"))
REPORT_COMPARISONS = tuple(f"{r}_vs_a" for r in ("f", "fbL", "fh", "fH", "fHb", "r30", "r90")) + \
    tuple(f"{r}_vs_f" for r in ("fbL", "fh", "fH", "fHb"))
SER_COMPARISONS = tuple(c for c in PAIRS if c[0] in REPORT_COMPARISONS)
DM_COMPARISONS = ("fh_vs_f", "fH_vs_f", "fHb_vs_f", "fbL_vs_f")
CORP_RUNGS = ("a", "f", "fbL", "fh", "fH", "fHb")
CHECK_NEP, CHECK_R = M2.BLIND_NEP, M2.BLIND_R
VERDICT_T = M5.VERDICT_T
VERDICT_BSS_LO = M5.VERDICT_BSS_LO
DEEP = tuple(k for k in LADDER if k <= -0.20)

DECISIONS = [
    "D-D1 development data (A6.1): the A5 development data (Chainlink dev ETH/BTC/stETH on the A2 grid with the long "
    "spliced history, B-span ETH/BTC, the A2 eight, the A3 locked set, the 23 blind-3 pairs) plus the 42 blind-4 pairs "
    "(membrane-datasets cdcd997, each file verified against its git blob; folds from the first quarter >= 365 d after "
    "the first kline to 2026Q3, as A5.6). sigma_hat, sigma_ref, regime, labels, folds and the A3.1 null-hour rule are "
    "A3's functions unchanged.",
    "D-H1 hourly high/low (A6.2 fH): Binance/Bitstamp/Coinbase series use the kline/candle high and low of the same "
    "files the close and low come from. The Chainlink development span uses the frozen A.1 grid columns oracleHigh / "
    "oracleLow (same builder and AnswerUpdated rounds as the A-series oracleLow truth): the maximum / minimum of the "
    "round answers in force during the hour, i.e. the round in force at the hour start and every round printed in "
    "the hour. For hours with fewer than 2 printed rounds this equals the registered 'open and close' rule exactly; "
    "for hours with >= 2 printed rounds it can only be wider than the extremes of the printed rounds alone, which the "
    "frozen inputs do not hold (the builder does not store per-hour round counts or in-hour-only extremes). Full "
    "coverage: oracleHigh is non-null on every hour of each asset's oracle coverage span. The long ETH/BTC series "
    "take the Binance kline high before the splice hour, as the close and low do.",
    "D-H2 Parkinson and HAR components: v_j = ln(high_j/low_j)^2/(4 ln 2); v is null when high or low is null, "
    "non-positive or high < low. The daily/weekly/monthly component at origin t_i is 8760 x the mean of the non-null "
    "v_j over hours j = i-W .. i-1 (W = 24, 168, 720), defined when the null hours are <= floor(0.05 W) (A3.1 rule: 1, "
    "8, 36) and the window starts at or after the series' first close; a component <= 0 is undefined (its log is not "
    "finite).",
    "D-H3 sigma_fut(t_i; T) = sqrt(8760 x mean r_j^2) over the T_h hourly log returns r_j = ln(C_j/C_{j-1}), j = i .. "
    "i+T_h-1 (closes in (t_i, t_i + T]), no demeaning (as RV30), over the non-null returns when null returns are <= "
    "floor(0.05 T_h) (A3.1), the window inside the grid and C_{i-1} at or after the first close; sigma_fut <= 0 is "
    "undefined (as A2 treats sigma_hat <= 0). Regression origins: labelled training origins (t + T <= Q_start) where "
    "every log in the regression is finite; origins with an undefined log drop out (no floor is imposed).",
    "D-W1 (fh): w_T = sum(x y)/sum(x^2), x = ln sigma_hat - ln sigma_ref, y = ln sigma_fut - ln sigma_ref over the "
    "fold's regression origins, clipped to [0, 1.25]; no regression origin or sum(x^2) = 0 -> w_T = 0.5 (the A3/A5 "
    "no-data value), counted. sigma_h = sigma_hat^w sigma_ref^(1-w) at training and forecast origins (w = 1 is exactly "
    "(f)); the (f) formula, FHS share with the fold's purged training origins where sigma_h is defined.",
    "D-H4 (fH): OLS (normal equations from cumulative sums; numpy lstsq if singular) of ln sigma_fut on [1, ln D, "
    "ln W, ln M] over the fold's regression origins; sigma_H = exp(fitted) wherever all three components are "
    "defined, with the fold's coefficients at every training origin and at the forecast origin. A training origin "
    "without sigma_H leaves the FHS set; a test row without sigma_H (a zero or undefined component) takes the (f) "
    "forecast of that row (the A.4 (c) rule: an undefined feature takes the rung below), counted per cell. Fewer than "
    "4 regression origins -> no coefficients, every row takes (f), counted.",
    "D-HB1 (fHb): evaluation origins as A3/A5 D-B1 (labelled training origins t + T <= Q_start, t >= the series' "
    "first labelled origin + 365 d, sigma_hat, sigma_ref and sigma_H(t) defined, an as-of forecast from origins t' + T "
    "<= t with sigma_H(t') defined). The as-of (fH) forecasts use the fold's HAR coefficients at t and t' (one HAR fit "
    "per fold); only the FHS counts are as-of. p is clipped to [1e-4, 1 - 1e-4] before ln p and -ln(1 - p) (the A2 (s) "
    "clip); v = ln sigma_hat(t) - ln sigma_ref(t); rows = evaluation origins x the band's levels (A4 bands, stETH one "
    "band), unweighted.",
    "D-HB2 ridge: minimise sum of log-losses + (1.0/2)||theta - (0, 1, 1, 0)||^2 over (intercept, ln p, -ln(1-p), v), "
    "the sklearn C = 1.0 form every A-series logistic fit used, intercept included in the penalty, no standardisation "
    "(the identity map is in raw coordinates); Newton with Armijo backtracking from the identity, stop at max |step| "
    "< 1e-10 or 100 iterations. No evaluation origin -> the identity map (the ridge minimiser with no rows). Test: q = "
    "expit(theta . (1, ln p, -ln(1-p), v)) on the row's raw (fH) p (after D-H4) and v, before the monotone fix (as A4 "
    "(fc) maps the raw (f)); a row without v takes its (fH) p, counted.",
    "D-S1 comparisons/eligibility/seed stability/dominance/choice: A3.4-A3.6 with candidates a, f, fbL, fh, fH, fHb; "
    "tie order in that order; eligibility = BSS vs (a) CI lower bound > 0 under default_rng(20261070) AND under >= 16 "
    "of 20261071..20261090; dominance among the eligible ((a) included) under 20261070. Registered draws: dev ETH, "
    "BTC, stETH > T; then B-span ETH, BTC; the A2 eight; the A3 ten Binance pairs; Bitstamp BTC, Coinbase BTC, "
    "Coinbase ETH; the 23 blind-3 pairs; the 42 blind-4 pairs (file-name order, each > T, skipped when the day count "
    "is below the block length); then the pooled generic set > T; then the pooled blind-4 set > T. Further and extra "
    "seeds replay only the dev draws.",
    "D-S2 compute layout: as A5 D-S2 (each non-dev series fit, monotone-fixed and reduced inside a worker; BSS CIs "
    "from day-level squared-error sums in the main process, equal to a row-level computation).",
    "D-L1 labels: A3.5 v3 thresholds; HIGH also needs (ETH/BTC) the A5 per-source rule, the A4.4 pooled "
    "asset-matched check and the generic check. Generic pool = the A5.3 definition unchanged (the A4 18 holdouts + the "
    "23 blind-3 pairs); A6 does not change it, so blind set 4 is not added to it ('every definition not changed here "
    "holds'). Reported beside it, deciding nothing: how many labels would change with blind set 4 in the generic pool.",
    "D-L2 basis string: dev calibration, asset-matched (ETH/BTC), generic, blind set 4 (the A5.6 check, pooled over "
    "the 42 pairs, same rung/T/level/regime; now computed on development data for every rung), and blind set 5 after "
    "A6.6. Each counts at n_ep >= 10. The live check is not counted: the live log holds 3 issue days (2026-10-14..16) "
    "so no cell reaches 10 episodes, and the A6 rungs are not issued live.",
    "D-E1 estimate ranges (A4.3 + A6.3): the A4 procedure and draw stream (default_rng(20261040); ETH, BTC, stETH > "
    "T > folds > DATA_END; day set of the shipped rung's training series), 500 resamples, every fitted quantity "
    "re-estimated from the resample's day-count weights: (fbL) beta per band from the weighted as-of Brier (as-of "
    "forecasts not recomputed, as A4 D-B1 for (fc)); (fh) w_T by weighted least squares; (fH) HAR by weighted OLS; "
    "(fHb) HAR as (fH) and the beta map refit by weighted ridge-logistic on the fold's as-of rows (as-of (fH) "
    "forecasts held at the fold's values, as A4 D-B1). 5th/95th percentiles, monotone-fixed, widened to the point.",
    "D-DM1 Diebold-Mariano (reported): d(t0) = mean over levels of (p_new - y)^2 - (p_f - y)^2 per test issue time in "
    "time order (rows where both exist); Newey-West (Bartlett) long-run variance with lag L; HLN factor "
    "sqrt((n + 1 - 2h + h(h-1)/n)/n), h = L + 1, Student t with n - 1 df, two-sided. Primary L = ceil(T_h/6) - 1, the "
    "registered 'T_h - 1 hourly lags' expressed on the 6-hourly issue grid (every earlier issue time whose window "
    "overlaps); the literal L = T_h - 1 rows is reported beside it. Pooled generic: d(t0) averaged over all series' "
    "rows at that issue time.",
    "D-CORP1 CORP (Dimitriadis, Gneiting, Jordan 2021): PAV (non-decreasing, ties pooled) of y on p; MCB = BS(p) - "
    "BS(PAV), DSC = BS(ybar) - BS(PAV), UNC = BS(ybar); BS = MCB - DSC + UNC exactly. Per dev (asset, T) over all "
    "levels and per depth band, on the monotone-fixed test rows.",
    "D-SB1 stationary bootstrap (reported): Politis-Romano stationary bootstrap over test days (circular, geometric "
    "blocks), mean block = the Patton-Politis-White (2009) b_SB of the daily mean loss differential of that "
    "comparison (flat-top lag window, Politis-White 2004 rule for M, capped at min(3 sqrt(n), n/3), floored at 1); "
    "2,000 replicates from a generator spawned from SeedSequence(20261070) (independent of the registered stream); "
    "order dev ETH, BTC, stETH > T > comparison list, then the pooled generic set > T > list.",
    "D-SS1 seed-sensitive labels: under each of 20261091..20261095 the dev draws are replayed and every dev label "
    "recomputed (only the R CI depends on the draws), then the same checks; a label that differs from the "
    "registered-seed label under >= 2 of the 5 is flagged 'seed-sensitive' (reported, deciding nothing).",
    "D-A60 A6.0: per dev asset (long spliced series for ETH/BTC) and T, ln(sigma_fut(t;T)/sigma_hat(t)) at the dev "
    "test issue times with both defined, by A3.3 regime: mean, median, n; also over every hourly origin of the series, "
    "and pooled over the other development series' test issue times. The stated pattern check: low mean > high mean "
    "at every T >= 3 d.",
    "D-V6 A6.6 (blind set 5, read once): files verified against the git blobs of --blind5-commit; folds from the "
    "first quarter >= 365 d after the first kline to 2026Q3; A3.1 null rule; draws default_rng(20261071): pairs in "
    "file-name order > T (no BSS for a pair with fewer days than the block length), then the pooled union day sets "
    "> T. Method verdict per new rung exactly as A5 D-V1 with (fbL) replaced by the rung: deep cells (-20..-40%) x "
    "every T x {low, high}, pooled over all pairs, kept when (f) and the rung both have n_ep >= 10 and a finite "
    "positive R; PASS iff the rung's median |ln R| < (f)'s AND the pooled BSS(rung vs f) CI lower bound > -0.002 at "
    "6h, 1d, 3d and 7d. A6 D1: the pooled numbers are also reported without LUNAUSDT (CIs from a stream spawned "
    "from SeedSequence(20261071)), deciding nothing. Basis = the frozen dev checks + 'blind set 5' (pooled R in "
    "[0.67, 1.5] with n_ep >= 10, same rung, T, level, regime), written to basis-final-a6.csv with its sha256; "
    "labels and shipped rungs are not changed.",
    "D-P1 panel: as A5 D-P1 with the A6 rungs. Live hours after DATA_END come from Chainlink getRoundData rounds: "
    "close = the answer in force at the hour end; high/low = max/min of the answer in force at the hour start and "
    "every round with updatedAt in (start, end] (the D-H1 convention). Fits stay at DATA_END; features at asof.",
]


def band_of(asset, levels):
    return M5.band_of(asset, levels)


# ---------------------------------------------------------------------------------------------
# Volatility features: Parkinson, HAR components, sigma_fut
# ---------------------------------------------------------------------------------------------
def parkinson_v(high, low):
    """Hourly Parkinson variance (not annualized); NaN where high/low are null, non-positive or high < low."""
    high = np.asarray(high, float)
    low = np.asarray(low, float)
    with np.errstate(invalid="ignore", divide="ignore"):
        v = np.log(high / low) ** 2 * PARK
    bad = ~(np.isfinite(high) & np.isfinite(low) & (high > 0) & (low > 0) & (high >= low))
    v[bad] = np.nan
    return v


def window_mean_null_rule(x, W, start_i, frac=M3.NULL_FRAC):
    """m[i], origins i = 0..N: mean of the non-null x[j], j = i-W .. i-1, when the null count <= floor(frac W) and
    i - W >= start_i; else NaN (D-H2)."""
    x = np.asarray(x, float)
    n = len(x)
    out = np.full(n + 1, np.nan)
    if n < W:
        return out
    fin = np.isfinite(x)
    cs = np.concatenate([[0.0], np.cumsum(np.where(fin, x, 0.0))])
    cn = np.concatenate([[0], np.cumsum(fin)])
    i = np.arange(W, n + 1)
    s = cs[i] - cs[i - W]
    m = cn[i] - cn[i - W]
    ok = (W - m <= M3.max_nulls(W, frac)) & (m > 0) & (i - W >= start_i)
    out[i[ok]] = s[ok] / m[ok]
    return out


def har_components(high, low, start_i):
    """(N+1, 3) annualized daily/weekly/monthly Parkinson components at each origin; <= 0 -> NaN."""
    v = parkinson_v(high, low)
    C = np.column_stack([ANNUAL * window_mean_null_rule(v, W, start_i) for W in HAR_WINDOWS])
    C[~(C > 0)] = np.nan
    return C


def sigma_fut(close, T_h, start_i, frac=M3.NULL_FRAC):
    """sigma_fut[i], origins i = 0..N (D-H3)."""
    close = np.asarray(close, float)
    n = len(close)
    out = np.full(n + 1, np.nan)
    if n < T_h + 1:
        return out
    r = np.full(n, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[1:] = np.log(close[1:] / close[:-1])
    fin = np.isfinite(r)
    cs = np.concatenate([[0.0], np.cumsum(np.where(fin, r * r, 0.0))])
    cn = np.concatenate([[0], np.cumsum(fin)])
    i = np.arange(1, n - T_h + 1)
    s = cs[i + T_h] - cs[i]
    m = cn[i + T_h] - cn[i]
    with np.errstate(invalid="ignore", divide="ignore"):
        val = np.sqrt(ANNUAL * s / np.where(m > 0, m, 1))
    ok = (T_h - m <= M3.max_nulls(T_h, frac)) & (m > 0) & (i - 1 >= start_i) & (val > 0)
    out[i[ok]] = val[ok]
    return out


def attach_high(ser, high):
    h = np.array(high, float)
    if len(h) != ser.N:
        raise SystemExit(f"STOP: {ser.name} high column length {len(h)} != {ser.N}")
    h[:ser.start_i] = np.nan
    ser.high = h
    ser._har = None
    ser._sfut = {}


def har_of(ser):
    if getattr(ser, "_har", None) is None:
        ser._har = har_components(ser.high, ser.low, ser.start_i)
    return ser._har


def sfut_of(ser, T_h):
    if not hasattr(ser, "_sfut"):
        ser._sfut = {}
    if T_h not in ser._sfut:
        ser._sfut[T_h] = sigma_fut(ser.close, T_h, ser.start_i)
    return ser._sfut[T_h]


def _clear(ser):
    ser._lab.clear()
    ser._wmin.clear()
    if hasattr(ser, "_sfut"):
        ser._sfut.clear()


# ---------------------------------------------------------------------------------------------
# Data: series (A5 builders) + hourly highs
# ---------------------------------------------------------------------------------------------
def load_grid_cols(path, cols=("close", "low", "high")):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    d = json.loads(raw)
    st, step, cnt = int(d["startTs"]), int(d["stepSeconds"]), int(d["count"])
    if step != STEP or st % STEP or st + STEP * cnt != DATA_END:
        raise SystemExit(f"STOP: {path} is not an hourly grid ending at the hour opening 2026-10-06T02:00Z")
    return st, {c: np.array([np.nan if v is None else float(v) for v in d["columns"][c]], float) for c in cols}


def load_klines_cols(datasets, pair, cols=("close", "low", "high")):
    rel = M2.KLINES[pair][0]
    with open(os.path.join(datasets, rel)) as f:
        d = json.load(f)
    st, cnt = int(d["startTs"]), int(d["count"])
    off = (st - M2.BASE_TS) // STEP
    if (st - M2.BASE_TS) % STEP or off + cnt != M2.N_H:
        raise SystemExit(f"STOP: {rel} not on the common grid")
    out = {"first_ts": st, "first_i": off}
    for c in cols:
        a = np.full(M2.N_H, np.nan)
        a[off:] = [np.nan if v is None else float(v) for v in d["columns"][c]]
        out[c] = a
    return out


def _same(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return a.shape == b.shape and np.array_equal(np.isfinite(a), np.isfinite(b)) and \
        np.array_equal(a[np.isfinite(a)], b[np.isfinite(b)])


def attach_highs(datasets, S, folds):
    """Attach the hourly high to every series that the A6 rungs fit on (D-H1); asserts each rebuilt close equals the
    series close, so the high is on the same grid."""
    px = {a: A.load_price(os.path.join(datasets, A.INPUTS[k][0]), cols=("oracle", "oracleLow", "oracleHigh"))
          for a, k in (("ETH", "eth_price"), ("BTC", "btc_price"), ("stETH", "steth_price"))}
    meta = {}
    for a in DEV_ASSETS:
        oc, oh = M2.place_a_grid(px[a]["oracle"]), M2.place_a_grid(px[a]["oracleHigh"])
        ci = M2.gi(A.COVERAGE_START[a])
        cov_null = int(np.isnan(oh[ci:]).sum())
        meta[f"oracle:{a}"] = {"oracleHigh_null_hours_in_coverage": cov_null}
        if cov_null:
            raise SystemExit(f"STOP: oracleHigh has {cov_null} null hours inside the {a} oracle coverage span")
        ls = S[f"long:{a}"]
        if a in M2.LONG_PAIR:
            kl = load_klines_cols(datasets, M2.LONG_PAIR[a])
            oc2, oh2 = oc.copy(), oh.copy()
            oc2[:ci] = np.nan
            oh2[:ci] = np.nan
            si = M2.gi(M2.SPLICE_TS[a])
            c, h = oc2.copy(), oh2.copy()
            c[:si], h[:si] = kl["close"][:si], kl["high"][:si]
            c[:kl["first_i"]] = np.nan
            h[:kl["first_i"]] = np.nan
        else:
            c, h = oc.copy(), oh.copy()
        c[:ls.start_i] = np.nan
        if not _same(c, ls.close):
            raise SystemExit(f"STOP: rebuilt close of long:{a} differs from the series close")
        attach_high(ls, h)
    for a in BSPAN_ASSETS:
        kl = load_klines_cols(datasets, M2.LONG_PAIR[a])
        _check_attach(S[f"bspan:{a}"], kl["close"], kl["high"])
    for p in M2.HOLDOUTS:
        kl = load_klines_cols(datasets, p)
        _check_attach(S[f"holdout:{p}"], kl["close"], kl["high"])
    for sid, *_ in M3.LOCKED_SERIES:
        rel = M3.locked_path(datasets, sid)
        _, cols = load_grid_cols(os.path.join(datasets, rel))
        _check_attach(S[f"locked:{sid}"], cols["close"], cols["high"])
    for k in S:
        for pre, sub in (("blind3:", BLIND3_DIR), ("blind4:", BLIND4_DIR)):
            if k.startswith(pre):
                _, cols = load_grid_cols(os.path.join(datasets, sub, k.split(":", 1)[1] + "-1h.json"))
                _check_attach(S[k], cols["close"], cols["high"])
    return meta


def _check_attach(ser, close, high):
    c = np.array(close, float)
    c[:ser.start_i] = np.nan
    if not _same(c, ser.close):
        raise SystemExit(f"STOP: rebuilt close of {ser.name} differs from the series close")
    attach_high(ser, high)


def build_blind_dir(datasets, sub, commit, prefix, verify=True, names_override=None):
    if verify:
        names, meta = M5.blind_files(datasets, sub, commit)
    else:
        names = names_override if names_override is not None else sorted(
            n for n in os.listdir(os.path.join(datasets, sub)) if n.endswith("-1h.json"))
        meta = {n: {"path": f"{sub}/{n}", "verified": False} for n in names}
    S, folds = {}, {}
    for n in names:
        st, cols = load_grid_cols(os.path.join(datasets, sub, n))
        key = prefix + n.split("-1h.json")[0]
        ser = M3.S3(key, key.split(":", 1)[1], "binance", cols["close"], cols["low"], LADDER, st, st)
        attach_high(ser, cols["high"])
        S[key] = ser
        folds[key] = M3.quarters(M3.first_quarter_after(st, 365), (2026, 3), ser)
        meta[n].update(first_kline=A.iso(st), folds=[f["name"] for f in folds[key]])
    return S, folds, meta


def build_all(datasets, verify=True):
    S, folds, fmeta = M5.build_all(datasets, verify=verify)
    B4, f4, m4 = build_blind_dir(datasets, BLIND4_DIR, BLIND4_COMMIT, "blind4:", verify=verify)
    S.update(B4)
    folds.update(f4)
    fmeta["blind4"] = m4
    fmeta["highs"] = attach_highs(datasets, S, folds)
    return S, folds, fmeta


def blind3_keys(S):
    return sorted(k for k in S if k.startswith("blind3:"))


def blind4_keys(S):
    return sorted(k for k in S if k.startswith("blind4:"))


def other_keys(S):
    return M5.other_keys(S) + blind4_keys(S)


def generic_keys(S):
    """D-L1: the A5.3 generic pool unchanged (A4 18 + blind-3 23)."""
    return M5.generic_keys(S)


def generic_keys_with_b4(S):
    return generic_keys(S) + blind4_keys(S)


# ---------------------------------------------------------------------------------------------
# Ridge logistic (fHb)
# ---------------------------------------------------------------------------------------------
def _ridge_obj(X, y, w, th, th0, lam):
    eta = X @ th
    return float(np.sum(w * (np.logaddexp(0.0, eta) - y * eta)) + 0.5 * lam * np.sum((th - th0) ** 2))


def fit_ridge_logistic(X, y, w=None, lam=RIDGE, theta0=IDENTITY, start=None, tol=1e-10, max_iter=100):
    """D-HB2: argmin sum w*logloss + lam/2 ||theta - theta0||^2 (Newton + Armijo)."""
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    th0 = np.asarray(theta0, float)
    w = np.ones(len(y)) if w is None else np.asarray(w, float)
    th = th0.copy() if start is None else np.asarray(start, float).copy()
    if len(y) == 0:
        return th0.copy(), {"n_rows": 0, "iterations": 0, "converged": True}
    f = _ridge_obj(X, y, w, th, th0, lam)
    conv, it = False, 0
    for it in range(1, max_iter + 1):
        q = expit(X @ th)
        g = X.T @ (w * (q - y)) + lam * (th - th0)
        H = (X * (w * q * (1.0 - q))[:, None]).T @ X + lam * np.eye(len(th))
        step = np.linalg.solve(H, g)
        t, gs = 1.0, float(g @ step)
        while True:
            thn = th - t * step
            fn = _ridge_obj(X, y, w, thn, th0, lam)
            if fn <= f - 1e-4 * t * gs or t < 1e-12:
                break
            t *= 0.5
        th, f = thn, fn
        if np.max(np.abs(t * step)) < tol:
            conv = True
            break
    return th, {"n_rows": int(len(y)), "iterations": it, "converged": conv}


_PAIRS4 = [(i, j) for i in range(4) for j in range(i, 4)]


def _sym4(Hp):
    """(R, 10) upper-triangle products -> (R, 4, 4) symmetric."""
    H = np.empty((Hp.shape[0], 4, 4))
    for c, (i, j) in enumerate(_PAIRS4):
        H[:, i, j] = H[:, j, i] = Hp[:, c]
    return H


def fit_ridge_logistic_batch(X, y, W, start, lam=RIDGE, theta0=IDENTITY, tol=1e-9, max_iter=30, day=None,
                             counts=None):
    """D-HB2 fits for every row of the weight matrix W (R, n) (D-E1). If day (row -> day position) and counts (R, nd)
    are given, the first Newton step from the common start uses exact per-day gradient/Hessian aggregates at the
    start; then full row-level Newton steps until max |step| < tol. A row that does not converge is refit by
    fit_ridge_logistic (line search)."""
    th0 = np.asarray(theta0, float)
    Th = np.array(start, float)
    R = W.shape[0]
    if X.shape[0] == 0:
        return np.tile(th0, (R, 1))
    P10 = np.column_stack([X[:, i] * X[:, j] for i, j in _PAIRS4])
    lamI = lam * np.eye(4)[None]
    if day is not None and counts is not None:
        ts = Th[0]
        q = expit(X @ ts)
        nd = counts.shape[1]
        gd = np.column_stack([np.bincount(day, weights=(q - y) * X[:, c], minlength=nd) for c in range(4)])
        hd = np.column_stack([np.bincount(day, weights=q * (1.0 - q) * P10[:, c], minlength=nd) for c in range(10)])
        G = counts @ gd + lam * (ts - th0)[None]
        H = _sym4(counts @ hd) + lamI
        Th = ts[None] - np.linalg.solve(H, G[:, :, None])[:, :, 0]
    done = np.zeros(R, bool)
    for _ in range(max_iter):
        ia = np.where(~done)[0]
        if not len(ia):
            break
        Ta, Wa = Th[ia], W[ia]
        Q = expit(Ta @ X.T)
        G = (Wa * (Q - y[None, :])) @ X + lam * (Ta - th0)
        H = _sym4((Wa * (Q * (1.0 - Q))) @ P10) + lamI
        St = np.linalg.solve(H, G[:, :, None])[:, :, 0]
        Th[ia] = Ta - St
        done[ia[np.max(np.abs(St), axis=1) < tol]] = True
    for r in np.where(~done | ~np.all(np.isfinite(Th), axis=1))[0]:
        Th[r] = fit_ridge_logistic(X, y, w=W[r], lam=lam, theta0=th0, start=start[r] if np.ndim(start) == 2
                                   else start, tol=tol)[0]
    return Th


def map_design(p, v):
    pc = np.clip(np.asarray(p, float), P_CLIP, 1.0 - P_CLIP)
    return np.column_stack([np.ones(pc.size), np.log(pc).ravel(), -np.log1p(-pc).ravel(),
                            np.broadcast_to(v, pc.shape).ravel()])


def apply_map(theta, p, v):
    """q = expit(theta . (1, ln p, -ln(1-p), v)) elementwise; p (n, k), v (n,) -> (n, k)."""
    p = np.asarray(p, float)
    pc = np.clip(p, P_CLIP, 1.0 - P_CLIP)
    eta = theta[0] + theta[1] * np.log(pc) - theta[2] * np.log1p(-pc) + theta[3] * np.asarray(v, float)[:, None]
    return expit(eta)


# ---------------------------------------------------------------------------------------------
# Per (series, T): (a), (f), (fbL) from A5, plus (fh), (fH), (fHb)
# ---------------------------------------------------------------------------------------------
class Prep6:
    def __init__(self, ser, T_h, q_max=None, with_fbL=True):
        self.ser = ser
        self.T_h = T_h
        self.P5 = M5.Prep5(ser, T_h, q_max=q_max) if with_fbL else None
        self.P = self.P5.P if with_fbL else M3.Prep3(ser, T_h, beta_select=False)
        P = self.P
        self.K = P.K
        self.bands = band_of(ser.asset, ser.levels)
        self.nb = int(self.bands.max()) + 1
        n = len(P.lab_ok)
        self.n = n
        self.i = np.arange(n)
        with np.errstate(invalid="ignore", divide="ignore"):
            lsg, lsr = np.log(ser.sigma[:n]), np.log(ser.sigma_ref[:n])
            lfut = np.log(sfut_of(ser, T_h)[:n])
        self.v = lsg - lsr
        # (fh): x, y on labelled origins with finite logs
        x, y = lsg - lsr, lfut - lsr
        self.okh = P.lab_ok & np.isfinite(x) & np.isfinite(y)
        self.xh, self.yh = np.where(self.okh, x, 0.0), np.where(self.okh, y, 0.0)
        self.cum_xy = np.cumsum(self.xh * self.yh)
        self.cum_xx = np.cumsum(self.xh * self.xh)
        self.cum_nh = np.cumsum(self.okh)
        # (fH): design [1, ln D, ln W, ln M]
        with np.errstate(invalid="ignore", divide="ignore"):
            L = np.log(har_of(ser)[:n])
        self.X = np.column_stack([np.ones(n), L])
        self.okX = np.all(np.isfinite(L), axis=1)
        self.okH = P.lab_ok & self.okX & np.isfinite(lfut)
        Xz = np.where(self.okH[:, None], self.X, 0.0)
        self.lfut = np.where(self.okH, lfut, 0.0)
        self.cum_XtX = np.cumsum(Xz[:, :, None] * Xz[:, None, :], axis=0)
        self.cum_Xty = np.cumsum(Xz * self.lfut[:, None], axis=0)
        self.cum_nH = np.cumsum(self.okH)
        self.ok_v = np.isfinite(ser.sigma[:n]) & np.isfinite(ser.sigma_ref[:n])

    # ----- (fh)
    def fh_w(self, qs_i):
        lim = qs_i - self.T_h
        if lim < 0 or self.cum_nh[min(lim, self.n - 1)] == 0 or self.cum_xx[min(lim, self.n - 1)] <= 0:
            return W_DEFAULT, {"n_reg": int(self.cum_nh[min(lim, self.n - 1)]) if lim >= 0 else 0, "w_raw": None,
                               "rule": "no regression origin -> 0.5"}
        lim = min(lim, self.n - 1)
        raw = float(self.cum_xy[lim] / self.cum_xx[lim])
        return float(np.clip(raw, *W_CLIP)), {"n_reg": int(self.cum_nh[lim]), "w_raw": raw, "rule": "LS slope"}

    def sigma_h(self, w, sg=None, sr=None):
        ser = self.ser
        sg = ser.sigma[:self.n] if sg is None else sg
        sr = ser.sigma_ref[:self.n] if sr is None else sr
        return M5.sigma_beta_at(sg, sr, w)

    # ----- (fH)
    def har_coef(self, qs_i):
        lim = min(qs_i - self.T_h, self.n - 1)
        nreg = int(self.cum_nH[lim]) if lim >= 0 else 0
        if nreg < 4:
            return None, {"n_reg": nreg, "rule": "fewer than 4 regression origins -> every row takes (f)"}
        XtX, Xty = self.cum_XtX[lim], self.cum_Xty[lim]
        try:
            c = np.linalg.solve(XtX, Xty)
            rule = "OLS"
        except np.linalg.LinAlgError:
            c = np.linalg.lstsq(XtX, Xty, rcond=None)[0]
            rule = "OLS (lstsq, singular)"
        return c, {"n_reg": nreg, "rule": rule, "cond": float(np.linalg.cond(XtX))}

    def sigma_H(self, coef, X=None, okX=None):
        X = self.X if X is None else X
        okX = self.okX if okX is None else okX
        out = np.full(len(X), np.nan)
        if coef is not None:
            with np.errstate(over="ignore"):
                out[okX] = np.exp(X[okX] @ coef)
            out[~(out > 0) | ~np.isfinite(out)] = np.nan
        return out

    def z_of(self, sig):
        P = self.P
        s = np.where(sig > 0, sig, np.nan)
        valid = P.lab_ok & np.isfinite(s)
        with np.errstate(invalid="ignore", divide="ignore"):
            z = np.where(valid, P.depth / (s * P.scale), np.nan)
        return z, valid

    # ----- (fHb)
    def asof_rows(self, qs_i, sH, zH, validH):
        """Evaluation origins and their as-of (fH) forecasts (D-HB1). Returns (idx, asof (len(idx), K))."""
        P, T, i = self.P, self.T_h, self.i
        if P.first_lab is None:
            return np.array([], int), np.zeros((0, self.K))
        ev = (P.lab_ok & self.ok_v & np.isfinite(sH) & (i >= P.first_lab + BETA_HISTORY_DAYS * 24) & (i + T <= qs_i))
        if not ev.any():
            return np.array([], int), np.zeros((0, self.K))
        thr = P.thresholds(sH)
        asof = M2.asof_fhs_counts(validH, zH, ev, np.where(np.isfinite(thr), thr, 0.0), T)
        ev &= np.all(np.isfinite(asof), axis=1)
        idx = np.where(ev)[0]
        return idx, asof[idx]

    def map_rows(self, idx, asof, bb):
        cols = self.bands == bb
        pk = asof[:, cols]
        X = map_design(pk, self.v[idx][:, None])
        y = np.nan_to_num(self.P.Y[idx][:, cols]).ravel()
        return X, y, cols

    def beta_maps(self, qs_i, sH, zH, validH, rows_out=False):
        idx, asof = self.asof_rows(qs_i, sH, zH, validH)
        maps, rows = {}, {}
        for bb in range(self.nb):
            X, y, cols = self.map_rows(idx, asof, bb)
            th, info = fit_ridge_logistic(X, y)
            info["n_eval"] = int(len(idx))
            maps[bb] = (th, info)
            if rows_out:
                rows[bb] = (X, y, np.repeat(idx, int(cols.sum())))
        return (maps, rows) if rows_out else maps


def fold_predict6(ser, P6, T_h, qs_i, te, live=None, P_a=None):
    """Raw predictions {rung: (len(te), K)} of one fold + the fitted quantities. live (panel): dict with sigma,
    sigma_ref, har (3 annualized components) and close series for the references."""
    P = P6.P
    lim = qs_i - T_h
    if live is None:
        o = M5.predict5(ser, P6.P5, T_h, qs_i, te)
        sg, sr = ser.sigma[te], ser.sigma_ref[te]
        Xte, okte = P6.X[te], P6.okX[te]
    else:
        o = M5.predict5(ser, P6.P5, T_h, qs_i, te, te_sigma=[live["sigma"]], te_sigma_ref=[live["sigma_ref"]])
        sg, sr = np.array([live["sigma"]], float), np.array([live["sigma_ref"]], float)
        with np.errstate(invalid="ignore", divide="ignore"):
            Lte = np.log(np.asarray(live["har"], float))[None, :]
        Xte = np.column_stack([np.ones(1), Lte])
        okte = np.all(np.isfinite(Lte), axis=1)
    if P_a is not None:
        o["raw"]["a"] = np.tile(P_a.freq_upto(lim), (len(te), 1))
    tr_lim = P6.i <= lim
    # (fh)
    w, winfo = P6.fh_w(qs_i)
    zh, vh = P6.z_of(P6.sigma_h(w))
    o["raw"]["fh"] = M2.fhs_predict(zh[vh & tr_lim], P.thresholds(P6.sigma_h(w, sg, sr)))
    # (fH)
    coef, hinfo = P6.har_coef(qs_i)
    sH = P6.sigma_H(coef)
    zH, vH = P6.z_of(sH)
    sH_te = P6.sigma_H(coef, Xte, okte)
    pH = M2.fhs_predict(zH[vH & tr_lim], P.thresholds(sH_te))
    fbH = ~np.all(np.isfinite(pH), axis=1)
    pH[fbH] = o["raw"]["f"][fbH]
    o["raw"]["fH"] = pH
    # (fHb)
    maps = P6.beta_maps(qs_i, sH, zH, vH) if coef is not None else \
        {bb: (IDENTITY.copy(), {"n_rows": 0, "iterations": 0, "converged": True, "n_eval": 0,
                                "rule": "no HAR coefficients -> identity"}) for bb in range(P6.nb)}
    with np.errstate(invalid="ignore", divide="ignore"):
        v_te = np.log(sg) - np.log(sr)
    pHb = np.array(pH, float)
    okv = np.isfinite(v_te)
    for bb, (th, _) in maps.items():
        cols = P6.bands == bb
        if okv.any():
            pHb[np.ix_(okv, cols)] = apply_map(th, pH[okv][:, cols], v_te[okv])
    o["raw"]["fHb"] = pHb
    o["fit"] = {"w": w, "w_info": winfo, "har": None if coef is None else coef.tolist(), "har_info": hinfo,
                "maps": {int(bb): (th.tolist(), info) for bb, (th, info) in maps.items()},
                "fH_fallback_rows": int(fbH.sum()), "fHb_no_v_rows": int((~okv).sum())}
    return o


# ---------------------------------------------------------------------------------------------
# Tasks, assembly, reduction
# ---------------------------------------------------------------------------------------------
_SER = {}


def fold_loop(ser, P6, T_h, folds, data_end=False, P_a=None):
    imask = ser.issue_mask()
    res = []
    fl = list(folds) + ([{"name": "DATA_END", "qs_i": ser.N, "qe_i": ser.N + 1}] if data_end else [])
    for f in fl:
        te = M3.test_times(f, ser, imask) if f["name"] != "DATA_END" else np.array([ser.N])
        o = fold_predict6(ser, P6, T_h, f["qs_i"], te, P_a=P_a)
        o.update(fold=f["name"], te=te)
        res.append(o)
    return res


def fit_rows(ser, T_h, o):
    """Table rows for w_T, HAR coefficients, beta maps and the fbL betas of one fold."""
    TL = T_LABEL[T_h]
    ft = o["fit"]
    w = {"series": ser.name, "T": TL, "fold": o["fold"], "w": ft["w"], "w_raw": ft["w_info"].get("w_raw"),
         "n_reg": ft["w_info"]["n_reg"], "rule": ft["w_info"]["rule"]}
    c = ft["har"] or [None] * 4
    h = {"series": ser.name, "T": TL, "fold": o["fold"], "c0": c[0], "c_day": c[1], "c_week": c[2], "c_month": c[3],
         "n_reg": ft["har_info"]["n_reg"], "rule": ft["har_info"]["rule"], "cond": ft["har_info"].get("cond"),
         "fH_fallback_rows": ft["fH_fallback_rows"], "fHb_no_v_rows": ft["fHb_no_v_rows"]}
    m = [{"series": ser.name, "T": TL, "fold": o["fold"], "band": bb, "theta0": th[0], "theta_lnp": th[1],
          "theta_ln1mp": th[2], "theta_v": th[3], "n_eval": info.get("n_eval"), "n_rows": info["n_rows"],
          "iterations": info["iterations"], "converged": info["converged"]} for bb, (th, info) in ft["maps"].items()]
    b = [{"series": ser.name, "T": TL, "fold": o["fold"], "band": bb, "beta": bv, "n_eval": info["n_eval"],
          **{f"brier_b{x}": (info["brier"] or {}).get(x) for x in BETAS}} for bb, (bv, info) in o["betas"].items()]
    return w, h, m, b


def assemble6(ser, folds, per_T, y_check=None):
    K, nT = len(ser.levels), len(HORIZONS_H)
    first = [o for o in per_T[HORIZONS_H[0]] if o["fold"] != "DATA_END"]
    te_all = np.concatenate([o["te"] for o in first]) if first else np.array([], int)
    fold_of = np.concatenate([[fi] * len(o["te"]) for fi, o in enumerate(first)]).astype(int) if first else \
        np.array([], int)
    n = len(te_all)
    G = {r: np.full((n, nT, K), np.nan) for r in RUNGS}
    tables = {"w": [], "har": [], "map": [], "beta": []}
    data_end = {}
    for ti, T_h in enumerate(HORIZONS_H):
        off = 0
        for o in per_T[T_h]:
            w, h, m, b = fit_rows(ser, T_h, o)
            tables["w"].append(w)
            tables["har"].append(h)
            tables["map"] += m
            tables["beta"] += b
            if o["fold"] == "DATA_END":
                data_end[T_h] = o
                continue
            mm = len(o["te"])
            sl = slice(off, off + mm)
            assert np.array_equal(te_all[sl], o["te"])
            for r in RUNGS:
                G[r][sl, ti, :] = o["raw"][r]
            off += mm
        assert off == n
    F = {}
    for r in RUNGS:
        if r not in ("r30", "r90"):
            assert not np.isnan(G[r]).any(), f"{ser.name} {r} grid has gaps"
        F[r] = A.monotone_fix(G[r]) if n else G[r]
    rows = {k: [] for k in ("t0_i", "fold_i", "T_h", "k_i", "k", "y", "regime")}
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
            for r in RUNGS:
                rows[f"p_{r}"].append(F[r][idx, ti, j])
    R = {k: (np.concatenate(v) if v else np.array([])) for k, v in rows.items()}
    R["t0_i"] = R["t0_i"].astype(np.int64)
    R["fold_i"] = R["fold_i"].astype(np.int16)
    R["k_i"] = R["k_i"].astype(np.int8)
    R["T_h"] = R["T_h"].astype(np.int16)
    R["regime"] = R["regime"].astype(np.int8)
    R["day"] = (ser.base_ts + STEP * R["t0_i"]) // DAY
    R["fold_names"] = [f["name"] for f in folds]
    R["levels"] = list(ser.levels)
    R["base_ts"] = ser.base_ts
    R["_te"] = (te_all, fold_of)
    de = {}
    if data_end:
        for r in RUNGS:
            g = np.array([data_end[T]["raw"][r][0] for T in HORIZONS_H])
            if not np.isnan(g).any():
                de[r] = A.monotone_fix(g[None])[0]
        de["fits"] = {T_LABEL[T]: {"betas": {int(bb): v[0] for bb, v in data_end[T]["betas"].items()},
                                   "w": data_end[T]["fit"]["w"], "har": data_end[T]["fit"]["har"],
                                   "maps": {bb: v[0] for bb, v in data_end[T]["fit"]["maps"].items()}}
                      for T in HORIZONS_H}
    _clear(ser)
    if y_check is not None:
        _clear(y_check)
    return R, tables, de


def write_rows(path, named, bands=None):
    header = ["series", "t0", "fold", "T", "k", "y", "regime"] + [f"p_{r}" for r in RUNGS] + \
        (["range_lo_shipped_rung", "range_hi_shipped_rung"] if bands is not None else [])

    def gen():
        for name, R in named:
            fn, b = R["fold_names"], R["base_ts"]
            order = np.lexsort((R["k_i"], R["T_h"], R["t0_i"]))
            for i in order:
                g = int(R["regime"][i])
                row = [name, A.iso(b + STEP * int(R["t0_i"][i])), fn[int(R["fold_i"][i])], T_LABEL[int(R["T_h"][i])],
                       repr(float(R["k"][i])), int(R["y"][i]), REGIMES[g] if g >= 0 else ""] + \
                    [A._f(R[f"p_{r}"][i]) for r in RUNGS]
                if bands is not None:
                    row += [A._f(bands[0][i]), A._f(bands[1][i])]
                yield row
    A.write_csv_gz(path, header, gen())


def diag_values(ser, te):
    """A6.0 values ln(sigma_fut/sigma_hat) at origins te for every T, with the regime of each origin."""
    out = {}
    for T_h in HORIZONS_H:
        with np.errstate(invalid="ignore", divide="ignore"):
            d = np.log(sfut_of(ser, T_h)[te]) - np.log(ser.sigma[te])
        g = ser.regime[te]
        ok = np.isfinite(d) & (g >= 0)
        out[T_h] = (d[ok].astype(np.float32), g[ok].astype(np.int8))
    return out


def reduce_series(R, comps=SER_COMPARISONS, want_rows=False):
    """Day-level squared-error sums per comparison (pooled and per regime), per (level, rung, regime) R inputs,
    per-issue-time loss differentials for DM, and (optionally) compact (p, y) rows for pooled CORP."""
    out = {}
    for T_h in HORIZONS_H:
        m = R["T_h"] == T_h
        sel = M3.select(R, m)
        days = np.unique(sel["day"])
        pos = np.searchsorted(days, sel["day"])
        nd = len(days)
        y = sel["y"]
        comp = {}
        for cname, rm, rb in comps:
            pm, pb = sel[f"p_{rm}"], sel[f"p_{rb}"]
            ok = np.isfinite(pm) & np.isfinite(pb)
            d = {}
            for gname, gval in (("pooled", None),) + tuple((g, gi) for gi, g in enumerate(REGIMES)):
                mm = ok if gval is None else ok & (sel["regime"] == gval)
                d[gname] = (np.bincount(pos[mm], weights=(pm[mm] - y[mm]) ** 2, minlength=nd),
                            np.bincount(pos[mm], weights=(pb[mm] - y[mm]) ** 2, minlength=nd), int(mm.sum()))
            comp[cname] = d
        ts = R["base_ts"] + STEP * sel["t0_i"]
        tsu = np.unique(ts)
        tpos = np.searchsorted(tsu, ts)
        dm = {}
        for cname in DM_COMPARISONS:
            rm, rb = cname.split("_vs_")
            pm, pb = sel[f"p_{rm}"], sel[f"p_{rb}"]
            ok = np.isfinite(pm) & np.isfinite(pb)
            dm[cname] = (np.bincount(tpos[ok], weights=(pm[ok] - y[ok]) ** 2 - (pb[ok] - y[ok]) ** 2,
                                     minlength=len(tsu)), np.bincount(tpos[ok], minlength=len(tsu)))
        cells = {}
        for j, k in enumerate(R["levels"]):
            mk = sel["k_i"] == j
            lv = {}
            for r in RUNGS:
                p = sel[f"p_{r}"]
                d = {}
                for gname, gval in (("pooled", None),) + tuple((g, gi) for gi, g in enumerate(REGIMES)):
                    mm = mk & np.isfinite(p)
                    if gval is not None:
                        mm &= sel["regime"] == gval
                    d[gname] = {"sum_p": float(p[mm].sum()), "sum_y": float(y[mm].sum()), "n_rows": int(mm.sum()),
                                "n_ep": M2.count_touch_episodes(sel["t0_i"][mm], y[mm])}
                lv[r] = d
            cells[repr(float(k))] = lv
        brier = {r: (float(np.nansum((sel[f"p_{r}"] - y) ** 2)), int(np.isfinite(sel[f"p_{r}"]).sum())) for r in RUNGS}
        entry = {"days": days, "comp": comp, "cells": cells, "brier": brier, "dm_ts": tsu, "dm": dm,
                 "rows_day": np.bincount(pos, minlength=nd).astype(float), "counts": M3.counts_of(R, m, T_h)}
        if want_rows:
            entry["rows"] = {r: (sel[f"p_{r}"].astype(np.float64), sel["y"].astype(np.uint8),
                                 sel["k_i"].astype(np.int8)) for r in CORP_RUNGS}
        out[T_h] = entry
    return out


def series_task(key):
    ser = _SER[key]
    folds = _SER["__folds__"][key]
    out_dir = _SER["__out__"]
    prefix = _SER["__prefix__"]
    want_rows = _SER.get("__rows__", False)
    q_max = max(f["qs_i"] for f in folds) if folds else 0
    per_T = {}
    for T_h in HORIZONS_H:
        P6 = Prep6(ser, T_h, q_max=q_max)
        per_T[T_h] = fold_loop(ser, P6, T_h, folds)
        del P6
    R, tables, _ = assemble6(ser, folds, per_T)
    del per_T
    if out_dir and _SER.get("__write_pred__", True):
        write_rows(os.path.join(out_dir, f"predictions-{prefix}{key.replace(':', '-')}.csv.gz"), [(key, R)])
    red = reduce_series(R, want_rows=want_rows)
    te_all, _ = R["_te"]
    diag = diag_values(ser, te_all)
    _clear(ser)
    return key, {"reduced": red, "tables": tables, "folds": R["fold_names"], "diag": diag}


def dev_task(args):
    a, T_h = args
    ls, os_ = _SER[f"long:{a}"], _SER[f"oracle:{a}"]
    P6 = Prep6(ls, T_h)
    Pa = P6.P if os_ is ls else M3.Prep3(os_, T_h, beta_select=False)
    res = fold_loop(ls, P6, T_h, M3.dev_folds(ls), data_end=True, P_a=Pa)
    _clear(ls)
    _clear(os_)
    return (a, T_h), res


def _dispatch(t):
    if t[0] == "dev":
        k, r = dev_task(t[1])
        return ("dev",) + k, r
    if t[0] == "range":
        return ("range",) + tuple(t[1][:2]), range_block_task(t[1])
    k, r = series_task(t[1])
    return ("ser", k), r


def run_pool(tasks, workers, log, t0, maxtasks=3):
    outs = {}
    ctx = mp.get_context("fork")
    if workers > 1:
        with ctx.Pool(workers, maxtasksperchild=maxtasks) as pool:
            for k, r in pool.imap_unordered(_dispatch, tasks):
                outs[k] = r
                log(f"  done {k} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    else:
        for t in tasks:
            k, r = _dispatch(t)
            outs[k] = r
            log(f"  done {k} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    return outs


# ---------------------------------------------------------------------------------------------
# Statistics from reduced sums (A5 helpers with the A6 comparison sets)
# ---------------------------------------------------------------------------------------------
bss_from_sums = M5.bss_from_sums
cell_R = M5.cell_R
to_cells_R = M5.to_cells_R
per_source_rule = M5.per_source_rule
label_after = M5.label_after


def series_comparisons(red_T, counts):
    out, byreg = {}, {g: {} for g in REGIMES}
    for cname, d in red_T["comp"].items():
        se_m, se_b, n = d["pooled"]
        if n:
            out[cname] = bss_from_sums(se_m, se_b, n, counts)
        for g in REGIMES:
            se_m, se_b, n = d[g]
            if n:
                byreg[g][cname] = bss_from_sums(se_m, se_b, n, counts)
    return out, byreg


def pooled_reduced(reds, keys, T_h, comps=SER_COMPARISONS):
    """Union of days; summed squared errors; summed cell inputs (n_ep = sum of per-series episodes); DM loss
    differentials summed by issue time."""
    days = np.unique(np.concatenate([reds[k][T_h]["days"] for k in keys]))
    nd = len(days)
    comp = {}
    for cname, *_ in comps:
        d = {}
        for g in ("pooled",) + REGIMES:
            se_m, se_b, n = np.zeros(nd), np.zeros(nd), 0
            for k in keys:
                x = reds[k][T_h]
                pos = np.searchsorted(days, x["days"])
                a_, b_, nn = x["comp"][cname][g]
                se_m[pos] += a_
                se_b[pos] += b_
                n += nn
            d[g] = (se_m, se_b, n)
        comp[cname] = d
    cells = {}
    for k in keys:
        for kk, lv in reds[k][T_h]["cells"].items():
            for r, d in lv.items():
                for g, st in d.items():
                    c = cells.setdefault(kk, {}).setdefault(r, {}).setdefault(g, {"sum_p": 0.0, "sum_y": 0.0,
                                                                                    "n_rows": 0, "n_ep": 0})
                    for f in c:
                        c[f] += st[f]
    rows_day = np.zeros(nd)
    for k in keys:
        rows_day[np.searchsorted(days, reds[k][T_h]["days"])] += reds[k][T_h]["rows_day"]
    tsu = np.unique(np.concatenate([reds[k][T_h]["dm_ts"] for k in keys]))
    dm = {}
    for cname in DM_COMPARISONS:
        s, c = np.zeros(len(tsu)), np.zeros(len(tsu))
        for k in keys:
            x = reds[k][T_h]
            pos = np.searchsorted(tsu, x["dm_ts"])
            s[pos] += x["dm"][cname][0]
            c[pos] += x["dm"][cname][1]
        dm[cname] = (s, c)
    return {"days": days, "comp": comp, "cells": cells, "dm_ts": tsu, "dm": dm, "rows_day": rows_day}


def ship_choice(eligible, dominance, n_high, n_med, bss_a):
    rest = [x for x in eligible if not any(dominance.get((y, x), False) for y in eligible if y != x)] or ["a"]
    removed = [x for x in eligible if x not in rest]
    key = lambda r: (n_high[r], n_med[r], bss_a.get(r) if bss_a.get(r) is not None else 0.0)  # noqa: E731
    best = max(key(r) for r in rest)
    tied = [r for r in rest if key(r) == best]
    return sorted(tied, key=SHIP_ORDER.index)[0], {"eligible": eligible, "removed_by_dominance": removed,
                                                   "remaining": rest, "tied_at_top": tied}


def score_dev_T(R, T_h, counts, days):
    m = R["T_h"] == T_h
    sel = M3.select(R, m)
    pos = M2.day_positions(days, sel["day"])
    fn = R["fold_names"]
    last_folds = set(range(len(fn) - M2.STALE_FOLDS, len(fn)))
    out = {"counts": M3.counts_of(R, m, T_h), "brier": {}}
    for r in RUNGS:
        p = sel[f"p_{r}"]
        f = np.isfinite(p)
        if f.any():
            out["brier"][r] = {"brier": float(np.mean((p[f] - sel["y"][f]) ** 2)), "n_rows": int(f.sum())}
    out["comparisons"] = M3.comparisons(sel, pos, len(days), counts, PAIRS)
    out["comparisons_by_regime"] = {g: M3.comparisons(sel, pos, len(days), counts,
                                                      [c for c in PAIRS if c[0] in REPORT_COMPARISONS],
                                                      mask=sel["regime"] == gi) for gi, g in enumerate(REGIMES)}
    out["levels"] = M3.level_stats_by_regime(sel, pos, len(days), counts, T_h, last_folds, RUNGS, True)
    return out, sel, pos, last_folds


def dev_labels_for(sel, pos, n_days, counts, T_h, last_folds):
    """Dev (A2.5 v3) label per (level, rung, regime) under one draw set: {kk: {rung: {regime: label}}}."""
    lv = M3.level_stats_by_regime(sel, pos, n_days, counts, T_h, last_folds, RUNGS, True)
    return {kk: {r: {g: (d[r][g]["label"] if d[r].get(g) else None) for g in REGIMES} for r in RUNGS}
            for kk, d in lv.items()}


# ---------------------------------------------------------------------------------------------
# Sturdier evaluation (A6.3, reported, deciding nothing)
# ---------------------------------------------------------------------------------------------
def nw_lrv(e, L):
    """Newey-West (Bartlett) long-run variance of a demeaned series."""
    n = len(e)
    v = float(e @ e) / n
    for k in range(1, min(L, n - 1) + 1):
        v += 2.0 * (1.0 - k / (L + 1.0)) * float(e[k:] @ e[:-k]) / n
    return v


def dm_test(d, L):
    """D-DM1: DM with Newey-West lag L and the Harvey-Leybourne-Newbold correction (h = L + 1)."""
    d = np.asarray(d, float)
    n = len(d)
    if n < 3:
        return None
    dbar = float(d.mean())
    lrv = nw_lrv(d - dbar, L)
    if not lrv > 0:
        return {"n": n, "lag": L, "mean_diff": dbar, "dm": None, "dm_hln": None, "p_value": None}
    dm = dbar / math.sqrt(lrv / n)
    h = L + 1
    fac2 = (n + 1 - 2 * h + h * (h - 1) / n) / n
    hln = dm * math.sqrt(fac2) if fac2 > 0 else None
    p = float(2.0 * student_t.sf(abs(hln), n - 1)) if hln is not None else None
    return {"n": n, "lag": L, "mean_diff": dbar, "dm": dm, "dm_hln": hln, "p_value": p,
            "favours": "new" if dbar < 0 else "f"}


def dm_lags(T_h):
    return {"primary": int(math.ceil(T_h / A.ISSUE_EVERY_H)) - 1, "literal": T_h - 1}


def dm_from_series(s, c, T_h):
    ok = c > 0
    d = s[ok] / c[ok]
    L = dm_lags(T_h)
    return {"primary": dm_test(d, L["primary"]), "literal": dm_test(d, L["literal"])}


def dm_rows(sel, T_h, rm, rb, base_ts):
    pm, pb, y = sel[f"p_{rm}"], sel[f"p_{rb}"], sel["y"]
    ok = np.isfinite(pm) & np.isfinite(pb)
    ts = base_ts + STEP * sel["t0_i"][ok]
    tsu, tpos = np.unique(ts, return_inverse=True)
    s = np.bincount(tpos, weights=(pm[ok] - y[ok]) ** 2 - (pb[ok] - y[ok]) ** 2, minlength=len(tsu))
    c = np.bincount(tpos, minlength=len(tsu)).astype(float)
    return dm_from_series(s, c, T_h)


def pav(y, w):
    """Weighted pool-adjacent-violators (non-decreasing) fit of y in the given order."""
    y = np.asarray(y, float)
    w = np.asarray(w, float)
    vals, wts, cnt = [], [], []
    for yi, wi in zip(y.tolist(), w.tolist()):
        vals.append(yi)
        wts.append(wi)
        cnt.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            wsum = wts[-2] + wts[-1]
            v = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / wsum
            c = cnt[-2] + cnt[-1]
            vals[-2:], wts[-2:], cnt[-2:] = [v], [wsum], [c]
    return np.repeat(vals, cnt)


def corp(p, y):
    """D-CORP1: CORP decomposition of the Brier score (MCB - DSC + UNC = BS)."""
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    n = len(p)
    if n == 0:
        return None
    o = np.argsort(p, kind="mergesort")
    ps, ys = p[o], y[o]
    u, start, cnt = np.unique(ps, return_index=True, return_counts=True)
    sy = np.add.reduceat(ys, start)
    cal = np.repeat(pav(sy / cnt, cnt), cnt)
    bs = float(np.mean((ps - ys) ** 2))
    bs_cal = float(np.mean((cal - ys) ** 2))
    ybar = float(ys.mean())
    unc = float(np.mean((ybar - ys) ** 2))
    return {"n": int(n), "brier": bs, "MCB": bs - bs_cal, "DSC": unc - bs_cal, "UNC": unc,
            "identity_residual": (bs - bs_cal) - (unc - bs_cal) + unc - bs}


def ppw_block_length(x):
    """Patton-Politis-White (2009) optimal mean block length for the stationary bootstrap (D-SB1)."""
    x = np.asarray(x, float)
    n = len(x)
    if n < 8:
        return 1.0
    e = x - x.mean()
    b_max = math.ceil(min(3.0 * math.sqrt(n), n / 3.0))
    kn = max(5, int(math.sqrt(math.log10(n))))
    m_max = int(math.ceil(math.sqrt(n))) + kn
    cv = 2.0 * math.sqrt(math.log10(n) / n)
    acv = np.zeros(m_max + 1)
    rho = np.zeros(m_max + 1)
    v0 = float(e @ e)
    opt_m = None
    for k in range(m_max + 1):
        cp = float(e[k:] @ e[:n - k]) if k else v0
        acv[k] = cp / n
        rho[k] = abs(cp) / v0 if v0 > 0 else 0.0
        if k >= kn and opt_m is None and k >= 1 and np.all(rho[k - kn + 1:k + 1] < cv):
            opt_m = k - kn + 1
    M = 2 * max(opt_m, 1) if opt_m is not None else m_max
    M = min(M, m_max)
    g, lr = 0.0, acv[0]
    for k in range(1, M + 1):
        lam = 1.0 if k / M <= 0.5 else 2.0 * (1.0 - k / M)
        g += 2.0 * lam * k * acv[k]
        lr += 2.0 * lam * acv[k]
    if not lr > 0:
        return 1.0
    b = ((2.0 * g * g) / (2.0 * lr * lr)) ** (1.0 / 3.0) * n ** (1.0 / 3.0)
    return float(min(max(b, 1.0), b_max))


def stationary_counts(rng, n, b, n_rep=N_BOOT):
    """Politis-Romano stationary bootstrap (circular, mean block b): per-replicate day counts (n_rep, n)."""
    p = 1.0 / max(b, 1.0)
    idx = np.empty((n_rep, n), dtype=np.int64)
    idx[:, 0] = rng.integers(0, n, n_rep)
    new = rng.random((n_rep, n)) < p
    jump = rng.integers(0, n, (n_rep, n))
    for j in range(1, n):
        idx[:, j] = np.where(new[:, j], jump[:, j], (idx[:, j - 1] + 1) % n)
    return A.replicate_counts(idx, n)


def sb_bss(se_m, se_b, nrow_day, rng):
    ok = nrow_day > 0
    d = np.where(ok, (se_m - se_b) / np.where(ok, nrow_day, 1), 0.0)[ok]
    b = ppw_block_length(d)
    cnt = stationary_counts(rng, len(se_m), b)
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (cnt @ se_m) / (cnt @ se_b)
    fin = np.isfinite(reps)
    ci = [float(v) for v in np.percentile(reps[fin], [2.5, 97.5])] if fin.sum() > 1 else None
    return {"block_length_ppw": b, "bss": float(1.0 - se_m.sum() / se_b.sum()) if se_b.sum() > 0 else None,
            "ci95": ci}


SB_COMPARISONS = tuple(f"{r}_vs_a" for r in ("f", "fbL", "fh", "fH", "fHb")) + \
    tuple(f"{r}_vs_f" for r in ("fbL", "fh", "fH", "fHb"))


def day_sums(sel, pos, nd, rm, rb):
    pm, pb, y = sel[f"p_{rm}"], sel[f"p_{rb}"], sel["y"]
    m = np.isfinite(pm) & np.isfinite(pb)
    return (np.bincount(pos[m], weights=(pm[m] - y[m]) ** 2, minlength=nd),
            np.bincount(pos[m], weights=(pb[m] - y[m]) ** 2, minlength=nd),
            np.bincount(pos[m], minlength=nd).astype(float))


def deep_median_table(levels_T, rungs=CANDIDATES):
    """Median |ln R| over deep cells (-20..-40%) x every T, per regime, on cells where every rung has n_ep >= 10 and a
    finite positive R (n_ep is the same for every fitted rung)."""
    out = {}
    for g in REGIMES + ("low+high",):
        gs = ("low", "high") if g == "low+high" else (g,)
        vals = {r: [] for r in rungs}
        for TL, lv in levels_T.items():
            for k in DEEP:
                kk = repr(float(k))
                for gg in gs:
                    sts = [lv.get(kk, {}).get(r, {}).get(gg) for r in rungs]
                    if any(s is None or s.get("n_ep", 0) < CHECK_NEP or not s.get("R") or not math.isfinite(s["R"])
                           or s["R"] <= 0 for s in sts):
                        continue
                    for r, s in zip(rungs, sts):
                        vals[r].append(abs(math.log(s["R"])))
        out[g] = {"cells": len(vals[rungs[0]]),
                  "median_abs_lnR": {r: (float(np.median(v)) if v else None) for r, v in vals.items()}}
    return out


def a60_table(vals_by_T):
    """vals_by_T: {T_h: (d, g)} -> per T per regime mean/median/n + the stated check."""
    out = {}
    for T_h, (d, g) in vals_by_T.items():
        row = {}
        for gi, gname in enumerate(REGIMES):
            x = np.asarray(d, float)[np.asarray(g) == gi]
            row[gname] = {"n": int(len(x)), "mean": float(x.mean()) if len(x) else None,
                          "median": float(np.median(x)) if len(x) else None}
        lo, hi = row["low"], row["high"]
        row["low_above_high_mean"] = (lo["mean"] > hi["mean"]) if lo["n"] and hi["n"] else None
        row["low_above_high_median"] = (lo["median"] > hi["median"]) if lo["n"] and hi["n"] else None
        out[T_LABEL[T_h]] = row
    out["stated_pattern_every_T_ge_3d"] = all(out[T_LABEL[T]]["low_above_high_mean"] for T in HORIZONS_H if T >= 72
                                              if out[T_LABEL[T]]["low_above_high_mean"] is not None)
    return out


# ---------------------------------------------------------------------------------------------
# Estimate ranges (A4.3 procedure, every fitted quantity re-estimated per resample: D-E1)
# ---------------------------------------------------------------------------------------------
def _wshare(z, wts, thr):
    """Weighted FHS share for one resample: sum w[z <= thr] / sum w; thr (n_te, K)."""
    o = np.argsort(z, kind="mergesort")
    zs = z[o]
    cw = np.concatenate([[0.0], np.cumsum(wts[o])])
    if cw[-1] <= 0:
        return np.full(thr.shape, np.nan)
    return cw[np.searchsorted(zs, thr, side="right")] / cw[-1]


def _shares_fixed_z(z, dpos, thr, counts, chunk=50):
    """Weighted shares for all resamples when z does not change across resamples (A4/A5 cumsum trick)."""
    o = np.argsort(z, kind="mergesort")
    zs, dp = z[o], dpos[o]
    idx = np.searchsorted(zs, thr, side="right")
    out = np.empty((counts.shape[0],) + thr.shape)
    for s in range(0, counts.shape[0], chunk):
        W = counts[s:s + chunk][:, dp]
        cw = np.concatenate([np.zeros((W.shape[0], 1)), np.cumsum(W, axis=1)], axis=1)
        out[s:s + chunk] = cw[:, idx] / cw[:, -1][:, None, None]
    return out


def pick_beta_batch(br):
    """Vectorized A3 pick_beta: br (R, 5) in BETAS order -> beta per row."""
    betas = np.asarray(BETAS)
    best = br.min(axis=1, keepdims=True)
    tied = br - best <= M3.BETA_TIE
    out = np.empty(br.shape[0])
    pref = sorted(range(len(BETAS)), key=lambda j: (0 if BETAS[j] == 0.5 else 1, abs(BETAS[j] - 0.5), BETAS[j]))
    for r in range(br.shape[0]):
        out[r] = betas[[j for j in pref if tied[r, j]][0]]
    return out


def range_samples(ser, P6, rung, qs_i, te, counts, sg, sr, Xte, okte, ser_o=None, Po=None):
    """(n_rep, len(te), K) resampled forecasts of the shipped rung for one fold (D-E1)."""
    if rung == "a":
        return M4.band_samples_a(ser_o, Po, qs_i, len(te), counts)
    P = P6.P
    T = P6.T_h
    days, pos, _ = M4.fold_days(ser, P.lab_ok, T, qs_i)
    nd = len(days)
    assert counts.shape[1] == nd, "range draws do not match the training days"
    lim = qs_i - T
    i = P6.i
    Rn = counts.shape[0]

    def f_samples():
        P4like = type("P4", (), {})()
        P4like.P, P4like.T_h, P4like.K = P, T, P6.K
        return M4.band_samples_f(ser, P4like, qs_i, te, counts, fc=False, te_sigma=sg)
    if rung == "f":
        return f_samples()
    if rung == "fbL":
        P5 = P6.P5
        if not P5.ready:
            ev = np.zeros(len(i), bool)
        else:
            ev = (np.diff(np.concatenate([[0], P5.cumE])) > 0) & (i <= lim)
        evi = np.where(ev)[0]
        Wd = counts[:, pos[evi]] if len(evi) else np.zeros((Rn, 0))
        tot = Wd.sum(axis=1)
        out = np.empty((Rn, len(te), P6.K))
        for bb in range(P5.nb):
            cols = np.where(P5.bands == bb)[0]
            br = np.empty((Rn, len(BETAS)))
            for j, b in enumerate(BETAS):
                se = np.diff(np.concatenate([[0.0], P5.cumSE[(b, bb)]]))[evi] if P5.ready else np.zeros(0)
                with np.errstate(invalid="ignore", divide="ignore"):
                    br[:, j] = (Wd @ se) / (tot * P5.kb[bb])
            chosen = np.full(Rn, 0.5)
            has = tot > 0
            if has.any():
                chosen[has] = pick_beta_batch(br[has])
            for b in BETAS:
                rr = np.where(chosen == b)[0]
                if not len(rr):
                    continue
                trb = P.valid[b] & (i <= lim)
                thr = P.thresholds(M5.sigma_beta_at(sg, sr, b))[:, cols]
                out[np.ix_(rr, np.arange(len(te)), cols)] = _shares_fixed_z(P.z[b][trb], pos[trb], thr, counts[rr])
        return out
    if rung == "fh":
        reg = P6.okh & (i <= lim)
        XY = np.bincount(pos[reg], weights=P6.xh[reg] * P6.yh[reg], minlength=nd)
        XX = np.bincount(pos[reg], weights=P6.xh[reg] ** 2, minlength=nd)
        num, den = counts @ XY, counts @ XX
        with np.errstate(invalid="ignore", divide="ignore"):
            w = np.where(den > 0, np.clip(num / np.where(den > 0, den, 1.0), *W_CLIP), W_DEFAULT)
        out = np.empty((Rn, len(te), P6.K))
        trc = P.lab_ok & (i <= lim)
        sg_tr, sr_tr, dep = P6.ser.sigma[:P6.n][trc], P6.ser.sigma_ref[:P6.n][trc], P.depth[trc]
        dp = pos[trc]
        for r in range(Rn):
            s = M5.sigma_beta_at(sg_tr, sr_tr, w[r])
            ok = np.isfinite(s) & (s > 0)
            z = dep[ok] / (s[ok] * P.scale)
            out[r] = _wshare(z, counts[r, dp[ok]], P.thresholds(M5.sigma_beta_at(sg, sr, w[r])))
        return out
    # (fH) / (fHb)
    reg = P6.okH & (i <= lim)
    Xr = P6.X[reg]
    XtX_d = np.zeros((nd, 16))
    np.add.at(XtX_d, pos[reg], (Xr[:, :, None] * Xr[:, None, :]).reshape(-1, 16))
    Xty_d = np.zeros((nd, 4))
    np.add.at(Xty_d, pos[reg], Xr * P6.lfut[reg][:, None])
    XtX = (counts @ XtX_d).reshape(Rn, 4, 4)
    Xty = counts @ Xty_d
    nreg = counts @ np.bincount(pos[reg], minlength=nd).astype(float)
    coefs = np.full((Rn, 4), np.nan)
    for r in range(Rn):
        if nreg[r] >= 4:
            try:
                coefs[r] = np.linalg.solve(XtX[r], Xty[r])
            except np.linalg.LinAlgError:
                coefs[r] = np.linalg.lstsq(XtX[r], Xty[r], rcond=None)[0]
    trc = P.lab_ok & P6.okX & (i <= lim)
    Xtr, dep, dp = P6.X[trc], P.depth[trc], pos[trc]
    pH = np.empty((Rn, len(te), P6.K))
    fb_rows = ~np.asarray(okte, bool)
    fs = f_samples() if fb_rows.any() or np.isnan(coefs).any() else None
    for r in range(Rn):
        if np.isnan(coefs[r]).any():
            pH[r] = fs[r]
            continue
        with np.errstate(over="ignore"):
            s = np.exp(Xtr @ coefs[r])
            ste = np.where(okte, np.exp(np.where(np.asarray(okte)[:, None], Xte, 0.0) @ coefs[r]), np.nan)
        ok = np.isfinite(s) & (s > 0)
        z = dep[ok] / (s[ok] * P.scale)
        pr = _wshare(z, counts[r, dp[ok]], P.thresholds(np.where(np.isfinite(ste), ste, 1.0)))
        if fb_rows.any():
            pr[fb_rows] = fs[r][fb_rows]
        pH[r] = pr
    if rung == "fH":
        return pH
    # (fHb): beta map refit per resample on the fold's as-of rows (as-of forecasts fixed at the fold values)
    coef, _ = P6.har_coef(qs_i)
    out = np.array(pH)
    if coef is None:
        return out
    sH = P6.sigma_H(coef)
    zH, vH = P6.z_of(sH)
    maps, rows = P6.beta_maps(qs_i, sH, zH, vH, rows_out=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        v_te = np.log(sg) - np.log(sr)
    okv = np.isfinite(v_te)
    for bb, (th_fold, _) in maps.items():
        cols = P6.bands == bb
        X, y, oi = rows[bb]
        dpos = pos[oi]
        for s0 in range(0, Rn, 50):
            Wc = counts[s0:s0 + 50][:, dpos] if len(oi) else np.zeros((min(50, Rn - s0), 0))
            Th = fit_ridge_logistic_batch(X, y, Wc, np.tile(th_fold, (Wc.shape[0], 1)), tol=1e-6, day=dpos,
                                          counts=counts[s0:s0 + 50])
            for j in range(Wc.shape[0]):
                if okv.any():
                    out[s0 + j][np.ix_(okv, cols)] = apply_map(Th[j], pH[s0 + j][okv][:, cols], v_te[okv])
    return out


def band_plan(S, shipped):
    """Walk the registered A4.3 draw stream once (default_rng(20261040); ETH, BTC, stETH > T > folds > DATA_END)
    and record the generator state at the start of each (asset, T) block plus each fold's day count, so blocks can be
    replayed in parallel with identical draws."""
    rng = np.random.default_rng(SEED_BAND)
    plan = []
    for a in DEV_ASSETS:
        lser = S[f"long:{a}"]
        for T_h in HORIZONS_H:
            rung = shipped[a][T_LABEL[T_h]]
            st = M4.band_series(S, a, rung)
            lab = np.isfinite(st.spot) & np.isfinite(st.wmin(T_h))
            state = copy.deepcopy(rng.bit_generator.state)
            nds = []
            for f in M4.band_order(lser, M3.dev_folds(lser)):
                days, _, _ = M4.fold_days(st, lab, T_h, f["qs_i"])
                A.block_bootstrap_indices(rng, len(days), A.block_length(T_h), N_BAND_REP)
                nds.append(len(days))
            plan.append({"a": a, "T_h": T_h, "rung": rung, "state": state, "nds": nds})
            _clear(lser)
            _clear(st)
    return plan


def replay_counts(state, nds, T_h):
    rng = np.random.default_rng()
    rng.bit_generator.state = copy.deepcopy(state)
    for nd in nds:
        idx = A.block_bootstrap_indices(rng, nd, A.block_length(T_h), N_BAND_REP)
        yield A.replicate_counts(idx, nd)


def range_block_task(args):
    """One (asset, T) block of estimate ranges: every dev fold + DATA_END (mode 'dev'), or only DATA_END with live
    features (mode 'panel'). Returns {fold: (te, lo, hi)} (percentiles 5/95 per (te, level), raw)."""
    a, T_h, rung, state, nds, mode, live = args
    D = _SER
    ser = D[f"long:{a}"]
    ser_o = D[f"oracle:{a}"]
    fl = M4.band_order(ser, M3.dev_folds(ser))
    P6 = Prep6(ser, T_h) if rung != "a" else None
    Po = M3.Prep3(ser_o, T_h, beta_select=False) if rung == "a" else None
    st = M4.band_series(D, a, rung)
    lab = np.isfinite(st.spot) & np.isfinite(st.wmin(T_h))
    out = {}
    for f, nd, cnt in zip(fl, nds, replay_counts(state, nds, T_h)):
        if mode == "panel" and f["name"] != "DATA_END":
            continue
        days, _, _ = M4.fold_days(st, lab, T_h, f["qs_i"])
        assert len(days) == nd
        if f["name"] == "DATA_END":
            te = np.array([ser.N])
        else:
            te = M3.test_times(f, ser, ser.issue_mask())
        if live is not None and f["name"] == "DATA_END":
            sg, sr = np.array([live["sigma"]]), np.array([live["sigma_ref"]])
            with np.errstate(invalid="ignore", divide="ignore"):
                Lte = np.log(np.asarray(live["har"], float))[None, :]
            Xte, okte = np.column_stack([np.ones(1), Lte]), np.all(np.isfinite(Lte), axis=1)
        else:
            sg, sr = ser.sigma[te], ser.sigma_ref[te]
            Xte, okte = (P6.X[te], P6.okX[te]) if P6 is not None else (None, None)
        smp = range_samples(ser, P6, rung, f["qs_i"], te, cnt, sg, sr, Xte, okte, ser_o=ser_o, Po=Po)
        lo, hi = np.percentile(smp, BAND_PCT, axis=0)
        out[f["name"]] = (te, lo, hi)
    _clear(ser)
    _clear(ser_o)
    return out


# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------
def write_json(path, obj, refuse_overwrite=False):
    A.write_json(path, obj, refuse_overwrite=refuse_overwrite)


CODE_FILES = ("a6_touch.py", "test_a6_touch.py", "a6_fetch_blind5.py", "a5_touch.py", "a4_touch.py", "a3_touch.py",
              "a2_touch.py", "a_touch.py")


def code_meta():
    here = os.path.abspath(__file__)
    d = os.path.dirname(here)
    run = lambda *a: subprocess.run(["git", "-C", d, *a], capture_output=True, text=True).stdout.strip()  # noqa: E731
    return {"path": "scripts/research/history-forecasts/a6_touch.py", "sha256": A.sha256_file(here),
            "deps_sha256": {f: A.sha256_file(os.path.join(d, f)) for f in CODE_FILES[1:]
                            if os.path.exists(os.path.join(d, f))},
            "git": {"head_commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
                    "a6_touch_last_commit": run("log", "-1", "--format=%H", "--", "a6_touch.py"),
                    "dirty_code_files": run("status", "--porcelain", "--", *CODE_FILES).splitlines()}}


def require_clean_code():
    cm = code_meta()
    if cm["git"]["dirty_code_files"]:
        raise SystemExit(f"STOP: code files are dirty: {cm['git']['dirty_code_files']}. Commit before a scored run.")
    return cm


def env_meta(workers):
    return M3.env_meta(workers)


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


def write_levels_csv(path, named_levels):
    header = ["series", "T", "k", "rung", "regime", "R", "n_ep", "n_rows", "sum_p", "sum_y"]

    def gen():
        for name, per_T in named_levels:
            for TL, lv in per_T.items():
                for kk, d in lv.items():
                    for r, dd in d.items():
                        for g, st in dd.items():
                            if st is None:
                                continue
                            yield [name, TL, kk, r, g, A._f(st["R"]) if st["R"] is not None else "", st["n_ep"],
                                   st["n_rows"], A._f(st["sum_p"]), A._f(st["sum_y"])]
    A.write_csv_gz(path, header, gen())


# ---------------------------------------------------------------------------------------------
# Phase: dry run (data-only counts)
# ---------------------------------------------------------------------------------------------
def run_dryrun(datasets, out_dir, meta, log=print):
    path = os.path.join(out_dir, "dryrun.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    t0 = time.time()
    S, folds, fmeta = build_all(datasets)
    out = {"phase": "dryrun", "prereg": PREREG, "code": code_meta(), "inputs": meta, "files": fmeta,
           "note": "Data-only counts. No label value, frequency, volatility value, Brier, BSS or R. Blind set 5 is not "
                   "read.", "series": {}}
    for key in ["long:ETH", "long:BTC", "long:stETH"] + other_keys(S):
        ser = S[key]
        fl = M3.dev_folds(ser) if key.startswith("long:") else folds.get(key, [])
        imask = ser.issue_mask()
        te = np.concatenate([M3.test_times(f, ser, imask) for f in fl]) if fl else np.array([], int)
        live = np.isfinite(ser.close)
        v = parkinson_v(ser.high, ser.low)
        C = har_of(ser)
        e = {"start": A.iso(ser.ts(ser.start_i)), "folds": [f["name"] for f in fl][:1] + [f["name"] for f in fl][-1:],
             "n_folds": len(fl), "test_issue_times": int(len(te)),
             "test_regime_counts": {g: int((ser.regime[te] == gi).sum()) for gi, g in enumerate(REGIMES)},
             "hours_with_close": int(live.sum()), "hours_null_parkinson_among_closes": int((live & ~np.isfinite(v)).sum()),
             "hours_zero_parkinson": int((v == 0).sum()),
             "test_origins_undefined_har": {n: int((~np.isfinite(C[te, j])).sum()) for j, n in
                                            enumerate(("day", "week", "month"))},
             "test_origins_undefined_sigma_fut": {T_LABEL[T]: int((~np.isfinite(sfut_of(ser, T)[te])).sum())
                                                  for T in HORIZONS_H}}
        if key.startswith("long:"):
            ci = M2.gi(A.COVERAGE_START[key.split(":")[1]])
            if key == "long:stETH" or ci <= ser.start_i:
                ci = ser.start_i
            h, lo, c = ser.high[ci:], ser.low[ci:], ser.close[ci:]
            op = np.concatenate([[np.nan], c[:-1]])
            e["chainlink_hours"] = int(len(c))
            e["chainlink_share_high_eq_open_above_close"] = float(np.mean((h == op) & (c < op)))
            e["chainlink_share_low_eq_open_below_close"] = float(np.mean((lo == op) & (c > op)))
            e["chainlink_share_flat_hours"] = float(np.mean(h == lo))
        out["series"][key] = e
        _clear(ser)
    out["runtime_seconds"] = round(time.time() - t0, 1)
    write_json(path, out, refuse_overwrite=True)
    log(f"dryrun written ({time.time() - t0:.0f}s)")
    return out


# ---------------------------------------------------------------------------------------------
# Phase: A6.0 diagnostic (fits nothing, decides nothing)
# ---------------------------------------------------------------------------------------------
def run_a60(datasets, out_dir, meta, log=print, verify=True):
    path = os.path.join(out_dir, "a60-diagnostic.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists. A6.0 is computed once.")
    t0 = time.time()
    S, folds, fmeta = build_all(datasets, verify=verify)
    out = {"phase": "A6.0 diagnostic (fits nothing, decides nothing)", "prereg": PREREG, "code": code_meta(),
           "inputs": meta, "DECISION": [d for d in DECISIONS if d.startswith(("D-A60", "D-H3"))],
           "stated_before_the_run": "if mean reversion causes the A5 pattern, the low tercile reads above the high "
                                    "tercile at every T >= 3 d", "per_asset": {}, "per_asset_all_hours": {},
           "other_series_pooled": {}, "other_series": {}}
    for a in DEV_ASSETS:
        ser = S[f"long:{a}"]
        imask = ser.issue_mask()
        te = np.concatenate([M3.test_times(f, ser, imask) for f in M3.dev_folds(ser)])
        out["per_asset"][a] = a60_table(diag_values(ser, te))
        out["per_asset_all_hours"][a] = a60_table(diag_values(ser, np.arange(ser.n_orig)))
        _clear(ser)
    pooled = {T: ([], []) for T in HORIZONS_H}
    for k in other_keys(S):
        ser = S[k]
        fl = folds.get(k, [])
        if not fl:
            continue
        imask = ser.issue_mask()
        te = np.concatenate([M3.test_times(f, ser, imask) for f in fl])
        dv = diag_values(ser, te)
        out["other_series"][k] = a60_table(dv)
        for T in HORIZONS_H:
            pooled[T][0].append(dv[T][0])
            pooled[T][1].append(dv[T][1])
        _clear(ser)
    out["other_series_pooled"] = a60_table({T: (np.concatenate(v[0]), np.concatenate(v[1])) for T, v in pooled.items()})
    out["runtime_seconds"] = round(time.time() - t0, 1)
    write_json(path, out, refuse_overwrite=True)
    log(f"a60 written ({time.time() - t0:.0f}s)")
    return out


# ---------------------------------------------------------------------------------------------
# Phase: development (scored ONCE) and freeze
# ---------------------------------------------------------------------------------------------
def label_block(a, TL, cell, matched, generic, generic_b4, b4pool, res_other, ladder_keys):
    """Labels of every rung at one dev (asset, T): (labs, label_rows)."""
    labs, rows = {r: {} for r in RUNGS}, []
    for kk, lvd in cell["levels"].items():
        on_ladder = kk in ladder_keys
        for r in RUNGS:
            d = lvd[r]
            entry = {"pooled": d["pooled"]["label"] if d.get("pooled") else None}
            for g in REGIMES:
                st = d.get(g)
                if st is None:
                    entry[g] = {"dev": None, "after": None, "outcome": "no rows"}
                    continue
                am = matched[a][TL]["levels"].get(kk, {}).get(r, {}).get(g) if a in BSPAN_ASSETS else None
                gen = generic[TL]["levels"].get(kk, {}).get(r, {}).get(g) if on_ladder else None
                genb4 = generic_b4[TL]["levels"].get(kk, {}).get(r, {}).get(g) if on_ladder else None
                b4 = b4pool[TL]["levels"].get(kk, {}).get(r, {}).get(g) if on_ladder else None
                if a in BSPAN_ASSETS:
                    srcs = [(k, res_other[k]["per_T"][TL]["levels"].get(kk, {}).get(r, {}).get(g)) for k in SOURCES[a]]
                    rule_state, used = per_source_rule({"R": st["R"], "n_ep": st["n_ep"]}, srcs)
                else:
                    rule_state, used = "n/a", []
                after, outcome = label_after(a, st["label"], rule_state, am, gen, on_ladder)
                after_b4, _ = label_after(a, st["label"], rule_state, am, genb4, on_ladder)
                checks = ([("asset-matched", M4.check_state(am))] if a in BSPAN_ASSETS else []) + \
                    [("generic", M4.check_state(gen)), ("blind set 4", M4.check_state(b4))]
                bstr, bdet, bk, bn = M4.basis(st, st["label"], checks)
                entry[g] = {"dev": st["label"], "after": after, "outcome": outcome, "basis": bstr,
                            "basis_checks": bdet, "k": bk, "n": bn, "n_ep": st["n_ep"], "R": st["R"],
                            "R_ci95": st["R_ci95"], "cov_inf": st["cov_inf"], "per_source": used,
                            "per_source_rule": rule_state, "rule_inputs": {"am": am, "gen": gen, "on_ladder": on_ladder},
                            "asset_matched": {"R": am["R"], "n_ep": am["n_ep"]} if am else None,
                            "generic": {"R": gen["R"], "n_ep": gen["n_ep"]} if gen else None,
                            "blind4": {"R": b4["R"], "n_ep": b4["n_ep"]} if b4 else None,
                            "after_if_generic_with_blind4": after_b4}
                rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g, "dev_label": st["label"],
                             "outcome": outcome, "label": after, "basis": bstr, "per_source_rule": rule_state,
                             "per_source": ";".join(f"{u['source']}:{u['R']:.3f}/{u['n_ep']}"
                                                    if u['R'] is not None and math.isfinite(u['R'])
                                                    else f"{u['source']}:inf/{u['n_ep']}" for u in used),
                             "n_ep": st["n_ep"], "R": st["R"],
                             "asset_matched_R": am["R"] if am else None, "asset_matched_n_ep": am["n_ep"] if am else None,
                             "generic_R": gen["R"] if gen else None, "generic_n_ep": gen["n_ep"] if gen else None,
                             "blind4_R": b4["R"] if b4 else None, "blind4_n_ep": b4["n_ep"] if b4 else None,
                             "label_if_generic_with_blind4": after_b4})
            labs[r][kk] = entry
    return labs, rows


def run_dev(datasets, out_dir, meta, workers=4, log=print, verify=True, require_clean=True):
    rpath, fpath = os.path.join(out_dir, "results-dev.json"), os.path.join(out_dir, "frozen-a6.json")
    for p in (rpath, fpath):
        if os.path.exists(p):
            raise SystemExit(f"STOP: {p} exists. The development run is scored once.")
    cm = require_clean_code() if require_clean else code_meta()
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    global _SER
    S, folds, fmeta = build_all(datasets, verify=verify)
    okeys, gkeys, b4keys = other_keys(S), generic_keys(S), blind4_keys(S)
    gkeys_b4 = generic_keys_with_b4(S)
    _SER = dict(S)
    _SER.update({"__folds__": folds, "__out__": out_dir, "__prefix__": "", "__write_pred__": False})
    log(f"series built {time.time() - t_start:.0f}s ({len(okeys)} other series)")
    by_len = sorted(okeys, key=lambda k: -(S[k].N - S[k].start_i))
    tasks = [("dev", (a, T)) for a in ("ETH", "BTC") for T in HORIZONS_H] + [("ser", k) for k in by_len[:8]] + \
        [("dev", ("stETH", T)) for T in HORIZONS_H] + [("ser", k) for k in by_len[8:]]
    outs = run_pool(tasks, workers, log, t_start)
    t_fit = time.time() - t_start
    Rs, tables, data_end = {}, {"w": [], "har": [], "map": [], "beta": []}, {}
    for a in DEV_ASSETS:
        ls, os_ = S[f"long:{a}"], S[f"oracle:{a}"]
        R, tb, de = assemble6(ls, M3.dev_folds(ls), {T: outs[("dev", a, T)] for T in HORIZONS_H},
                              y_check=None if os_ is ls else os_)
        Rs[a], data_end[a] = R, de
        for k in tables:
            tables[k] += tb[k]
    stored = M3.check_stored_a(datasets, Rs)
    reds, diag_other = {}, {T: ([], []) for T in HORIZONS_H}
    for k in okeys:
        o = outs[("ser", k)]
        reds[k] = o["reduced"]
        for kk in tables:
            tables[kk] += o["tables"][kk]
        for T in HORIZONS_H:
            diag_other[T][0].append(o["diag"][T][0])
            diag_other[T][1].append(o["diag"][T][1])
    del outs
    log(f"assembled ({time.time() - t_start:.0f}s); scoring")
    rng = np.random.default_rng(SEED_REG)
    res_dev, sels, dev_days, boot_meta = {}, {}, {}, {}
    for a in DEV_ASSETS:
        res_dev[a] = {}
        for T_h in HORIZONS_H:
            days = np.unique(Rs[a]["day"][Rs[a]["T_h"] == T_h])
            idx, cnt = M3.draws(rng, len(days), T_h)
            dev_days[(a, T_h)] = days
            boot_meta[f"{a}|{T_LABEL[T_h]}"] = M3._bmeta(days, idx, T_h)
            sc, sel, pos, lastf = score_dev_T(Rs[a], T_h, cnt, days)
            sels[(a, T_h)] = (sel, pos, lastf)
            res_dev[a][T_LABEL[T_h]] = sc
        log(f"  scored {a} ({time.time() - t_start:.0f}s)")
    res_other = {}
    for k in okeys:
        res_other[k] = {"per_T": {}}
        for T_h in HORIZONS_H:
            x = reds[k][T_h]
            nd = len(x["days"])
            entry = {"counts": x["counts"], "brier": {r: (v[0] / v[1] if v[1] else None) for r, v in x["brier"].items()},
                     "levels": to_cells_R(x["cells"])}
            if nd >= A.block_length(T_h):
                idx, cnt = M3.draws(rng, nd, T_h)
                boot_meta[f"{k}|{T_LABEL[T_h]}"] = M3._bmeta(x["days"], idx, T_h)
                entry["comparisons"], entry["comparisons_by_regime"] = series_comparisons(x, cnt)
            else:
                entry["skipped_bss"] = "fewer days than the block length"
            res_other[k]["per_T"][T_LABEL[T_h]] = entry
    log(f"  scored other series ({time.time() - t_start:.0f}s)")
    generic, b4pool, matched, generic_b4 = {}, {}, {a: {} for a in BSPAN_ASSETS}, {}
    pooled_red = {}
    for name, keys, store in (("POOLED_GENERIC", gkeys, generic), ("POOLED_BLIND4", b4keys, b4pool)):
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            pr = pooled_reduced(reds, keys, T_h)
            pooled_red[(name, T_h)] = pr
            idx, cnt = M3.draws(rng, len(pr["days"]), T_h)
            boot_meta[f"{name}|{TL}"] = M3._bmeta(pr["days"], idx, T_h)
            cmp_, byreg = series_comparisons(pr, cnt)
            store[TL] = {"comparisons": cmp_, "comparisons_by_regime": byreg, "levels": to_cells_R(pr["cells"]),
                         "n_series": len(keys), "n_days": int(len(pr["days"])),
                         "dm": {c: dm_from_series(*pr["dm"][c], T_h) for c in DM_COMPARISONS}}
    for T_h in HORIZONS_H:
        TL = T_LABEL[T_h]
        for a in BSPAN_ASSETS:
            matched[a][TL] = {"levels": to_cells_R(pooled_reduced(reds, list(ASSET_MATCHED[a]), T_h)["cells"])}
        generic_b4[TL] = {"levels": to_cells_R(pooled_reduced(reds, gkeys_b4, T_h)["cells"])}
    log(f"  pooled checks ({time.time() - t_start:.0f}s)")
    seed_counts = {a: {T_LABEL[T]: {r: 0 for r in CANDIDATES[1:]} for T in HORIZONS_H} for a in DEV_ASSETS}
    for s in SEEDS_FURTHER:
        rs = np.random.default_rng(s)
        for a in DEV_ASSETS:
            for T_h in HORIZONS_H:
                days = dev_days[(a, T_h)]
                _, cnt = M3.draws(rs, len(days), T_h)
                sel, pos, _ = sels[(a, T_h)]
                for r in CANDIDATES[1:]:
                    lo = M3.ci_lower(sel, pos, len(days), cnt, r, "a")
                    seed_counts[a][T_LABEL[T_h]][r] += int(lo is not None and lo > 0)
    log(f"  seed stability ({time.time() - t_start:.0f}s)")
    extra_labels = {s: {} for s in SEEDS_EXTRA}
    for s in SEEDS_EXTRA:
        rs = np.random.default_rng(s)
        for a in DEV_ASSETS:
            for T_h in HORIZONS_H:
                days = dev_days[(a, T_h)]
                _, cnt = M3.draws(rs, len(days), T_h)
                sel, pos, lastf = sels[(a, T_h)]
                extra_labels[s][(a, T_h)] = dev_labels_for(sel, pos, len(days), cnt, T_h, lastf)
    log(f"  extra-seed labels ({time.time() - t_start:.0f}s)")
    shipped, frozen, label_rows = {}, {}, []
    ladder_keys = {repr(float(x)) for x in LADDER}
    seed_sens = {"rows": [], "counts": {}}
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            cell = res_dev[a][TL]
            labs, rows = label_block(a, TL, cell, matched, generic, generic_b4, b4pool, res_other, ladder_keys)
            label_rows += rows
            for kk in labs["a"]:
                for r in RUNGS:
                    for g in REGIMES:
                        e = labs[r][kk].get(g)
                        if not isinstance(e, dict) or e.get("after") is None:
                            continue
                        ri = e["rule_inputs"]
                        diffs = []
                        for s in SEEDS_EXTRA:
                            dl = extra_labels[s][(a, T_h)][kk][r][g]
                            al, _ = label_after(a, dl, e["per_source_rule"], ri["am"], ri["gen"], ri["on_ladder"])
                            diffs.append(al != e["after"])
                        e["extra_seed_labels_differ"] = int(sum(diffs))
                        e["seed_sensitive"] = bool(sum(diffs) >= SEED_SENSITIVE_MIN)
                        if e["seed_sensitive"]:
                            seed_sens["rows"].append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                                      "label": e["after"], "differ_under": int(sum(diffs))})
                        e.pop("rule_inputs")
            comps = cell["comparisons"]
            elig, elig_info = ["a"], {}
            for r in CANDIDATES[1:]:
                c = comps.get(f"{r}_vs_a")
                reg_ok = bool(c and c["ci_above_0"])
                n_ok = seed_counts[a][TL][r]
                elig_info[r] = {"registered_ci95": c["ci95"] if c else None, "registered_ok": reg_ok,
                                "seeds_ok": n_ok, "eligible": reg_ok and n_ok >= MIN_SEEDS}
                if elig_info[r]["eligible"]:
                    elig.append(r)
            dom = {(y_, x_): bool(comps.get(f"{y_}_vs_{x_}") and comps[f"{y_}_vs_{x_}"]["ci_above_0"])
                   for y_ in elig for x_ in elig if y_ != x_}
            n_high = {r: sum(labs[r][kk][g].get("after") == "HIGH" for kk in labs[r] for g in REGIMES) for r in RUNGS}
            n_med = {r: sum(labs[r][kk][g].get("after") == "MEDIUM" for kk in labs[r] for g in REGIMES) for r in RUNGS}
            bss_a = {"a": 0.0, **{r: (comps.get(f"{r}_vs_a") or {}).get("bss") for r in CANDIDATES[1:]}}
            ship, info = ship_choice(elig, dom, n_high, n_med, bss_a)
            cell["shipping"] = {"eligibility": elig_info, "dominance": {f"{k[0]}>{k[1]}": v for k, v in dom.items()},
                                "n_high": n_high, "n_medium": n_med, "bss_vs_a": bss_a, "shipped_rung": ship, **info}
            cell["labels"] = labs
            shipped.setdefault(a, {})[TL] = ship
            frozen.setdefault(a, {})[TL] = labs
    for a in DEV_ASSETS:
        for TL, ship in shipped[a].items():
            seed_sens["counts"].setdefault(a, {})[TL] = {
                "all_rungs": sum(1 for x in seed_sens["rows"] if x["asset"] == a and x["T"] == TL),
                "shipped_rung": sum(1 for x in seed_sens["rows"] if x["asset"] == a and x["T"] == TL
                                    and x["rung"] == ship)}
    log(f"  labels and shipping ({time.time() - t_start:.0f}s)")
    # ---- sturdier evaluation (reported, deciding nothing)
    sturdy = {"dm": {}, "corp": {}, "stationary_bootstrap": {}, "dm_pooled_generic": {}, "sb_pooled_generic": {}}
    sb_rng = np.random.default_rng(np.random.SeedSequence(SEED_REG).spawn(1)[0])
    for a in DEV_ASSETS:
        R = Rs[a]
        bands = band_of(a, R["levels"])
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            sel, pos, _ = sels[(a, T_h)]
            nd = len(dev_days[(a, T_h)])
            sturdy["dm"].setdefault(a, {})[TL] = {c: dm_rows(sel, T_h, *c.split("_vs_"), R["base_ts"])
                                                 for c in DM_COMPARISONS}
            cp = {}
            for r in CORP_RUNGS:
                p, y = sel[f"p_{r}"], sel["y"]
                cp[r] = {"all": corp(p, y)}
                for bb in range(int(bands.max()) + 1):
                    mk = bands[sel["k_i"]] == bb
                    cp[r][f"band{bb}"] = corp(p[mk], y[mk])
            sturdy["corp"].setdefault(a, {})[TL] = cp
            sb = {}
            for c in SB_COMPARISONS:
                rm, rb = c.split("_vs_")
                se_m, se_b, nr = day_sums(sel, pos, nd, rm, rb)
                sb[c] = {**sb_bss(se_m, se_b, nr, sb_rng),
                         "registered_day_block_ci95": (res_dev[a][TL]["comparisons"].get(c) or {}).get("ci95")}
            sturdy["stationary_bootstrap"].setdefault(a, {})[TL] = sb
    for T_h in HORIZONS_H:
        TL = T_LABEL[T_h]
        pr = pooled_red[("POOLED_GENERIC", T_h)]
        sturdy["dm_pooled_generic"][TL] = generic[TL]["dm"]
        sb = {}
        for c in SB_COMPARISONS:
            se_m, se_b, _ = pr["comp"][c]["pooled"]
            sb[c] = {**sb_bss(se_m, se_b, pr["rows_day"], sb_rng),
                     "registered_day_block_ci95": (generic[TL]["comparisons"].get(c) or {}).get("ci95")}
        sturdy["sb_pooled_generic"][TL] = sb
    deep = {"ETH": deep_median_table({TL: res_dev["ETH"][TL]["levels"] for TL in res_dev["ETH"]}),
            "BTC": deep_median_table({TL: res_dev["BTC"][TL]["levels"] for TL in res_dev["BTC"]}),
            "generic_pooled": deep_median_table({TL: generic[TL]["levels"] for TL in generic}),
            "blind4_pooled": deep_median_table({TL: b4pool[TL]["levels"] for TL in b4pool})}
    a60_other = a60_table({T: (np.concatenate(v[0]), np.concatenate(v[1])) for T, v in diag_other.items()})
    log(f"  sturdier evaluation ({time.time() - t_start:.0f}s)")
    del pooled_red, reds
    # ---- estimate ranges for the shipped rung (D-E1), (asset, T) blocks in parallel
    plan = band_plan(S, shipped)
    rtasks = [("range", (p["a"], p["T_h"], p["rung"], p["state"], p["nds"], "dev", None)) for p in plan]
    rtasks.sort(key=lambda t: {"fHb": 0, "fH": 1, "fh": 2, "fbL": 3, "f": 4, "a": 5}[t[1][2]])
    rout = run_pool(rtasks, workers, log, t_start, maxtasks=1)
    log(f"  estimate ranges ({time.time() - t_start:.0f}s)")
    ranges_rows, range_de, range_check = {}, {}, {}
    for a in DEV_ASSETS:
        R = Rs[a]
        ser = S[f"long:{a}"]
        te_all, _ = R["_te"]
        fl = M3.dev_folds(ser)
        K, nT = len(ser.levels), len(HORIZONS_H)
        LO = np.full((len(te_all), nT, K), np.nan)
        HI = np.full((len(te_all), nT, K), np.nan)
        for ti, T_h in enumerate(HORIZONS_H):
            blk = rout[("range", a, T_h)]
            off = 0
            for f in fl:
                te, lo, hi = blk[f["name"]]
                LO[off:off + len(te), ti] = lo
                HI[off:off + len(te), ti] = hi
                off += len(te)
        LO, HI = A.monotone_fix(LO), A.monotone_fix(HI)
        lo_rows, hi_rows = np.full(len(R["y"]), np.nan), np.full(len(R["y"]), np.nan)
        tpos = np.searchsorted(te_all, R["t0_i"])
        for ti, T_h in enumerate(HORIZONS_H):
            m = R["T_h"] == T_h
            p = R[f"p_{shipped[a][T_LABEL[T_h]]}"][m]
            lo_rows[m] = np.minimum(LO[tpos[m], ti, R["k_i"][m]], p)
            hi_rows[m] = np.maximum(HI[tpos[m], ti, R["k_i"][m]], p)
        ranges_rows[a] = (lo_rows, hi_rows)
        glo = A.monotone_fix(np.array([rout[("range", a, T)]["DATA_END"][1][0] for T in HORIZONS_H])[None])[0]
        ghi = A.monotone_fix(np.array([rout[("range", a, T)]["DATA_END"][2][0] for T in HORIZONS_H])[None])[0]
        pde = np.array([data_end[a][shipped[a][T_LABEL[T]]][ti] for ti, T in enumerate(HORIZONS_H)])
        range_de[a] = {"lo": np.minimum(glo, pde).tolist(), "hi": np.maximum(ghi, pde).tolist(), "p": pde.tolist()}
        range_check[a] = {}
        for T_h in HORIZONS_H:
            m = R["T_h"] == T_h
            p = R[f"p_{shipped[a][T_LABEL[T_h]]}"]
            cov, n_inf = 0, 0
            for fi in np.unique(R["fold_i"][m]):
                for j in range(K):
                    mc = m & (R["fold_i"] == fi) & (R["k_i"] == j)
                    if not mc.any():
                        continue
                    c = A.coverage_cell(R["y"][mc], p[mc], T_h)
                    if not (c["pbar"] >= 1.0 / c["n_w"] or c["ybar"] > 0):
                        continue
                    n_inf += 1
                    cov += int(lo_rows[mc].mean() <= c["ybar"] <= hi_rows[mc].mean())
            range_check[a][T_LABEL[T_h]] = {"informative_cells": n_inf, "covered": cov,
                                            "share": (cov / n_inf) if n_inf else None}
    del rout
    # ---- outputs
    for a in DEV_ASSETS:
        write_rows(os.path.join(out_dir, f"predictions-dev-{a}.csv.gz"), [(a, Rs[a])], bands=ranges_rows[a])
    A.write_csv(os.path.join(out_dir, "w-table.csv"), ["series", "T", "fold", "w", "w_raw", "n_reg", "rule"],
                tables["w"])
    A.write_csv(os.path.join(out_dir, "har-table.csv"), ["series", "T", "fold", "c0", "c_day", "c_week", "c_month",
                                                         "n_reg", "rule", "cond", "fH_fallback_rows", "fHb_no_v_rows"],
                tables["har"])
    A.write_csv(os.path.join(out_dir, "betamap-table.csv"), ["series", "T", "fold", "band", "theta0", "theta_lnp",
                                                             "theta_ln1mp", "theta_v", "n_eval", "n_rows",
                                                             "iterations", "converged"], tables["map"])
    A.write_csv(os.path.join(out_dir, "beta-table.csv"), ["series", "T", "fold", "band", "beta", "n_eval"] +
                [f"brier_b{x}" for x in BETAS], tables["beta"])
    A.write_csv(os.path.join(out_dir, "labels-frozen.csv"),
                ["asset", "T", "k", "rung", "regime", "dev_label", "outcome", "label", "basis", "per_source_rule",
                 "per_source", "n_ep", "R", "asset_matched_R", "asset_matched_n_ep", "generic_R", "generic_n_ep",
                 "blind4_R", "blind4_n_ep", "label_if_generic_with_blind4"], label_rows)
    write_levels_csv(os.path.join(out_dir, "levels-other-series.csv.gz"),
                     [(k, {TL: v["levels"] for TL, v in res_other[k]["per_T"].items()}) for k in okeys])
    for k in okeys:
        for TL in res_other[k]["per_T"]:
            res_other[k]["per_T"][TL].pop("levels")
    w_summary, fb_summary = {}, {}
    for r in tables["w"]:
        if r["series"] in [f"long:{a}" for a in DEV_ASSETS] or r["series"] == "oracle:stETH":
            w_summary.setdefault(r["series"], {}).setdefault(r["T"], []).append(r["w"])
    w_summary = {s: {T: {"min": min(v), "median": float(np.median(v)), "max": max(v), "n_folds": len(v),
                         "at_upper_clip": sum(x >= W_CLIP[1] for x in v), "at_lower_clip": sum(x <= W_CLIP[0] for x in v)}
                     for T, v in d.items()} for s, d in w_summary.items()}
    w_all = [r["w"] for r in tables["w"]]
    w_summary["all_series"] = {"n": len(w_all), "median": float(np.median(w_all)),
                               "share_at_upper_clip": float(np.mean([x >= W_CLIP[1] for x in w_all])),
                               "share_at_lower_clip": float(np.mean([x <= W_CLIP[0] for x in w_all])),
                               "no_regression_origin": sum(r["rule"].startswith("no") for r in tables["w"])}
    for r in tables["har"]:
        d = fb_summary.setdefault(r["series"], {"fH_fallback_rows": 0, "fHb_no_v_rows": 0, "no_coef_folds": 0})
        d["fH_fallback_rows"] += r["fH_fallback_rows"]
        d["fHb_no_v_rows"] += r["fHb_no_v_rows"]
        d["no_coef_folds"] += int(r["c0"] is None)
    fb_summary = {k: v for k, v in fb_summary.items() if any(v.values())}
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            res_dev[a][TL]["p_data_end"] = {r: (data_end[a][r][HORIZONS_H.index(T_h)].tolist() if r in data_end[a]
                                                else None) for r in RUNGS}
            res_dev[a][TL]["fits_data_end"] = data_end[a]["fits"][TL]
    counts = {a: {TL: {"dev": M4.label_counts(frozen[a][TL][shipped[a][TL]], "dev"),
                       "after_checks": M4.label_counts(frozen[a][TL][shipped[a][TL]], "after")}
                  for TL in shipped[a]} for a in DEV_ASSETS}
    sens_b4 = {"labels_changed_all_rungs": sum(1 for x in label_rows if x["label"] != x["label_if_generic_with_blind4"]),
               "labels_changed_shipped": sum(1 for x in label_rows if x["label"] != x["label_if_generic_with_blind4"]
                                             and shipped[x["asset"]][x["T"]] == x["rung"])}
    frozen_doc = {"what": "Q26 A6 frozen shipped rung per (asset, T), labels and basis strings, before blind set 5 "
                          "(A6.3)", "prereg": PREREG, "shipped": shipped, "labels": frozen,
                  "range_data_end": range_de, "fits_data_end": {a: data_end[a]["fits"] for a in DEV_ASSETS},
                  "fixed_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    doc = {"test": "Q26 workstream A6 -- development data", "prereg": PREREG, "code": cm, "inputs": meta,
           "files_dev": fmeta, "environment": env_meta(workers), "DECISIONS": DECISIONS, "deviations_run": [],
           "stored_a_check": stored, "bootstrap": boot_meta, "seed_registered": SEED_REG,
           "seeds_further": list(SEEDS_FURTHER), "seeds_extra": list(SEEDS_EXTRA), "seed_range": SEED_BAND,
           "seed_stability": seed_counts, "per_asset": res_dev, "other_series": res_other,
           "generic_pooled": generic, "blind4_pooled": b4pool, "asset_matched_pooled": matched,
           "shipped": shipped, "label_counts_shipped": counts, "seed_sensitive": seed_sens,
           "generic_with_blind4_sensitivity": sens_b4, "sturdier_evaluation": sturdy, "deep_band_median_abs_lnR": deep,
           "a60_other_series_pooled": a60_other, "w_summary": w_summary, "fallback_summary": fb_summary,
           "range_check": range_check, "range_data_end": range_de,
           "run": {"started_utc": started, "fit_predict_seconds": round(t_fit, 1)}}
    write_json(fpath, frozen_doc, refuse_overwrite=True)
    fsha = A.sha256_file(fpath)
    with open(fpath + ".sha256", "w") as f:
        f.write(f"{fsha}  frozen-a6.json\n")
    doc["frozen_file"] = {"file": "frozen-a6.json", "sha256": fsha}
    doc["run"].update(total_seconds=round(time.time() - t_start, 1),
                      finished_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    write_json(rpath, doc, refuse_overwrite=True)
    log(f"results-dev written ({time.time() - t_start:.0f}s)")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: blind set 5 (ONCE, after the freeze, with the published commit) -- A6.6
# ---------------------------------------------------------------------------------------------
def method_verdict(pooled_T, rung):
    """A6.6 per new rung (the A5 D-V1 rule with (fbL) replaced by the rung)."""
    lnf, lnr, cells = [], [], 0
    for TL in T_LABEL.values():
        for k in DEEP:
            kk = repr(float(k))
            for g in ("low", "high"):
                sf = pooled_T[TL]["levels"].get(kk, {}).get("f", {}).get(g)
                sr = pooled_T[TL]["levels"].get(kk, {}).get(rung, {}).get(g)
                if not sf or not sr or sf["n_ep"] < CHECK_NEP or sr["n_ep"] < CHECK_NEP:
                    continue
                if not (sf["R"] and sr["R"] and math.isfinite(sf["R"]) and math.isfinite(sr["R"])
                        and sf["R"] > 0 and sr["R"] > 0):
                    continue
                lnf.append(abs(math.log(sf["R"])))
                lnr.append(abs(math.log(sr["R"])))
                cells += 1
    med_f = float(np.median(lnf)) if lnf else None
    med_r = float(np.median(lnr)) if lnr else None
    part1 = med_f is not None and med_r is not None and med_r < med_f
    lows = {T_LABEL[T]: (pooled_T[T_LABEL[T]]["comparisons"].get(f"{rung}_vs_f") or {}).get("ci95") for T in VERDICT_T}
    part2 = all(v is not None and v[0] > VERDICT_BSS_LO for v in lows.values())
    return {"rung": rung, "deep_cells": cells, "median_abs_lnR_f": med_f, f"median_abs_lnR_{rung}": med_r,
            "deep_R_closer": bool(part1), f"bss_{rung}_vs_f_ci_by_T": lows,
            "bss_lower_bounds_above_-0.002": bool(part2), "verdict": "PASS" if (part1 and part2) else "FAIL"}


SENSITIVITY_EXCLUDE = ("blind5:binance-LUNAUSDT",)    # A6 D1: pooled also reported without it (deciding nothing)
PAIR_COUNT_COMPARISONS = ("fh_vs_f", "fH_vs_f", "fHb_vs_f", "fbL_vs_f", "f_vs_a", "fbL_vs_a", "fh_vs_a", "fH_vs_a",
                          "fHb_vs_a")


def pooled_block(reds, keys, rng):
    """Pooled BSS with CIs (draws from rng, > T), R / n_ep per (T, level, regime), DM and CORP over `keys`."""
    pooled = {}
    for T_h in HORIZONS_H:
        pr = pooled_reduced(reds, keys, T_h)
        _, cnt = M3.draws(rng, len(pr["days"]), T_h)
        cmp_, byreg = series_comparisons(pr, cnt)
        cp = {}
        for r in CORP_RUNGS:
            p = np.concatenate([reds[k][T_h]["rows"][r][0] for k in keys])
            y = np.concatenate([reds[k][T_h]["rows"][r][1] for k in keys]).astype(float)
            kb = band_of("ladder", LADDER)[np.concatenate([reds[k][T_h]["rows"][r][2] for k in keys])]
            cp[r] = {"all": corp(p, y), **{f"band{bb}": corp(p[kb == bb], y[kb == bb]) for bb in range(3)}}
        pooled[T_LABEL[T_h]] = {"comparisons": cmp_, "comparisons_by_regime": byreg,
                                "levels": to_cells_R(pr["cells"]), "n_days": int(len(pr["days"])),
                                "n_pairs": len(keys),
                                "dm": {c: dm_from_series(*pr["dm"][c], T_h) for c in DM_COMPARISONS}, "corp": cp}
    return pooled


def pair_table(per_pair):
    """Per-pair BSS rows and, per (T, comparison), how many pairs have the CI above 0 / containing 0 / below 0."""
    rows, counts = [], {}
    for k, d in per_pair.items():
        for TL, e in d["per_T"].items():
            for c, v in (e.get("comparisons") or {}).items():
                ci = v.get("ci95")
                side = "no CI" if not ci else ("above" if ci[0] > 0 else "below" if ci[1] < 0 else "contains")
                rows.append({"pair": k, "T": TL, "comparison": c, "n_rows": v["n_rows"], "bss": v["bss"],
                             "ci_lo": ci[0] if ci else None, "ci_hi": ci[1] if ci else None, "side": side})
                if c in PAIR_COUNT_COMPARISONS:
                    cc = counts.setdefault(TL, {}).setdefault(c, {"above": 0, "contains": 0, "below": 0, "no CI": 0})
                    cc[side] += 1
    return rows, counts


def basis_change_summary(frozen, final):
    """Shipped-rung cells: the blind-5 check state and whether the 'held in k of n' string changed from the dev
    basis; counts per (asset, T) plus totals."""
    out, tot = {}, {"held": 0, "not held": 0, "n/a": 0, "string_changed": 0, "cells": 0}
    for a, d in final.items():
        for TL, rr in d.items():
            ship = frozen["shipped"][a][TL]
            c = {"held": 0, "not held": 0, "n/a": 0, "string_changed": 0, "cells": 0, "not_held_cells": []}
            for kk, gg in rr.get(ship, {}).items():
                for g, x in gg.items():
                    st = x["basis_checks"]["blind set 5"]
                    c[st] += 1
                    c["cells"] += 1
                    dev = frozen["labels"][a][TL][ship][kk][g]["basis"]
                    c["string_changed"] += int(dev != x["basis"])
                    if st == "not held":
                        c["not_held_cells"].append({"k": float(kk), "regime": g, "label": x["label"],
                                                    "blind5": x["blind5"]})
            out.setdefault(a, {})[TL] = {"rung": ship, **c}
            for kk in tot:
                tot[kk] += c[kk]
    return {"per_cell": out, "totals_shipped": tot}


def blind5_gate(out_dir, commit):
    """Every check before blind set 5 may be read; returns (dev, frozen, fsha). Raises SystemExit on any failure."""
    bpath = os.path.join(out_dir, "results-blind5.json")
    marker = os.path.join(out_dir, "blind5-run.started")
    if os.path.exists(bpath) or os.path.exists(marker):
        raise SystemExit("STOP: blind set 5 has already been read (results or start marker exist). It is read once.")
    fpath, dpath = os.path.join(out_dir, "frozen-a6.json"), os.path.join(out_dir, "results-dev.json")
    if not (os.path.exists(fpath) and os.path.exists(dpath) and os.path.exists(fpath + ".sha256")):
        raise SystemExit("STOP: frozen-a6.json (+ .sha256) and results-dev.json must exist before blind set 5 is read.")
    if not commit:
        raise SystemExit("STOP: --blind5-commit (the published membrane-datasets commit holding blind5-prices/) is "
                         "required.")
    with open(dpath) as f:
        dev = json.load(f)
    fsha = A.sha256_file(fpath)
    with open(fpath + ".sha256") as f:
        recorded = f.read().split()[0] if f else ""
    if fsha != dev.get("frozen_file", {}).get("sha256") or fsha != recorded:
        raise SystemExit("STOP: frozen-a6.json sha256 does not match the recorded freeze")
    with open(fpath) as f:
        frozen = json.load(f)
    return dev, frozen, fsha


def run_blind5(datasets, out_dir, meta_inputs, commit, workers=4, log=print, verify=True, names_override=None,
               require_clean=True):
    dev, frozen, fsha = blind5_gate(out_dir, commit)
    cm = require_clean_code() if require_clean else code_meta()
    marker = os.path.join(out_dir, "blind5-run.started")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(marker, "w") as f:
        f.write(json.dumps({"started_utc": started, "frozen_sha256": fsha, "commit": commit,
                            "code": cm["git"]["head_commit"]}) + "\n")
    t_start = time.time()
    global _SER
    S, folds, fmeta = build_blind_dir(datasets, BLIND5_DIR, commit, "blind5:", verify=verify,
                                      names_override=names_override)
    keys = sorted(k for k in S if folds[k])
    _SER = dict(S)
    _SER.update({"__folds__": folds, "__out__": out_dir, "__prefix__": "", "__rows__": True,
                 "__write_pred__": True})
    outs = run_pool([("ser", k) for k in keys], workers, log, t_start)
    reds = {k: outs[("ser", k)]["reduced"] for k in keys}
    tables = {"w": [], "har": [], "map": [], "beta": []}
    for k in keys:
        for kk in tables:
            tables[kk] += outs[("ser", k)]["tables"][kk]
    del outs
    rng = np.random.default_rng(SEED_BLIND5)
    per_pair = {}
    for k in keys:
        per_pair[k] = {"per_T": {}}
        for T_h in HORIZONS_H:
            x = reds[k][T_h]
            entry = {"counts": x["counts"], "levels": to_cells_R(x["cells"]),
                     "dm": {c: dm_from_series(*x["dm"][c], T_h) for c in DM_COMPARISONS},
                     "corp": {r: corp(x["rows"][r][0], x["rows"][r][1]) for r in CORP_RUNGS}}
            if len(x["days"]) >= A.block_length(T_h):
                _, cnt = M3.draws(rng, len(x["days"]), T_h)
                entry["comparisons"], entry["comparisons_by_regime"] = series_comparisons(x, cnt)
            per_pair[k]["per_T"][T_LABEL[T_h]] = entry
    pooled = pooled_block(reds, keys, rng)                                  # registered (all pairs)
    verdicts = {r: method_verdict(pooled, r) for r in NEW_RUNGS}
    excl = [k for k in keys if k in SENSITIVITY_EXCLUDE]
    sens = None
    if excl:                                                                # A6 D1: reported, deciding nothing
        keys_s = [k for k in keys if k not in excl]
        ps = pooled_block(reds, keys_s, np.random.default_rng(np.random.SeedSequence(SEED_BLIND5).spawn(1)[0]))
        sens = {"excluded": excl, "n_pairs": len(keys_s), "note": "A6 D1: pooled without these pairs, reported "
                "beside the registered pooled numbers (which include them); deciding nothing. CIs from a stream "
                "spawned from SeedSequence(20261071).", "pooled": ps,
                "method_verdicts": {r: method_verdict(ps, r) for r in NEW_RUNGS}}
    pair_rows, pair_counts = pair_table(per_pair)
    ladder_keys = {repr(float(x)) for x in LADDER}
    rows, final = [], {}
    for a in DEV_ASSETS:
        for TL, labs in frozen["labels"][a].items():
            for r, lv in labs.items():
                for kk, e in lv.items():
                    for g in REGIMES:
                        x = e.get(g)
                        if not isinstance(x, dict) or x.get("after") is None:
                            continue
                        st = pooled[TL]["levels"].get(kk, {}).get(r, {}).get(g) if kk in ladder_keys else None
                        chk = dict(x["basis_checks"])
                        chk["blind set 5"] = M4.check_state(st)
                        n = sum(v != "n/a" for v in chk.values())
                        k_ = sum(v == "held" for v in chk.values())
                        bstr = f"held in {k_} of {n} checks"
                        final.setdefault(a, {}).setdefault(TL, {}).setdefault(r, {}).setdefault(kk, {})[g] = {
                            "label": x["after"], "basis": bstr, "basis_checks": chk,
                            "blind5": {"R": st["R"], "n_ep": st["n_ep"]} if st else None}
                        rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                     "shipped": frozen["shipped"][a][TL] == r, "label": x["after"], "basis": bstr,
                                     "blind5_R": st["R"] if st else None, "blind5_n_ep": st["n_ep"] if st else None})
    bpath = os.path.join(out_dir, "basis-final-a6.csv")
    A.write_csv(bpath, ["asset", "T", "k", "rung", "regime", "shipped", "label", "basis", "blind5_R", "blind5_n_ep"],
                rows)
    bsha = A.sha256_file(bpath)
    with open(bpath + ".sha256", "w") as f:
        f.write(f"{bsha}  basis-final-a6.csv\n")
    A.write_csv(os.path.join(out_dir, "pairs-blind5.csv"),
                ["pair", "T", "comparison", "n_rows", "bss", "ci_lo", "ci_hi", "side"], pair_rows)
    basis_changes = basis_change_summary(frozen, final)
    A.write_csv(os.path.join(out_dir, "w-table-blind5.csv"), ["series", "T", "fold", "w", "w_raw", "n_reg", "rule"],
                tables["w"])
    A.write_csv(os.path.join(out_dir, "har-table-blind5.csv"),
                ["series", "T", "fold", "c0", "c_day", "c_week", "c_month", "n_reg", "rule", "cond",
                 "fH_fallback_rows", "fHb_no_v_rows"], tables["har"])
    A.write_csv(os.path.join(out_dir, "betamap-table-blind5.csv"),
                ["series", "T", "fold", "band", "theta0", "theta_lnp", "theta_ln1mp", "theta_v", "n_eval", "n_rows",
                 "iterations", "converged"], tables["map"])
    doc = {"test": "Q26 workstream A6 -- blind set 5 (A6.6, read once)", "prereg": PREREG, "code": cm,
           "inputs": meta_inputs, "DECISIONS": DECISIONS, "deviations_run": [], "blind5_commit": commit,
           "blind5_files": fmeta, "frozen_file": {"file": "frozen-a6.json", "sha256": fsha},
           "results_dev_sha256": A.sha256_file(os.path.join(out_dir, "results-dev.json")), "seed": SEED_BLIND5,
           "per_pair": per_pair, "pooled": pooled, "method_verdicts": verdicts,
           "pooled_sensitivity_without": sens, "per_pair_ci_counts": pair_counts, "final_basis": final,
           "basis_file": {"file": "basis-final-a6.csv", "sha256": bsha}, "basis_changes": basis_changes,
           "run": {"marker_started_utc": started, "total_seconds": round(time.time() - t_start, 1),
                   "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}}
    write_json(os.path.join(out_dir, "results-blind5.json"), doc, refuse_overwrite=True)
    vv = {r: v["verdict"] for r, v in verdicts.items()}
    log(f"results-blind5 written ({time.time() - t_start:.0f}s); verdicts {vv}")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: panel (preview before blind set 5; final after)
# ---------------------------------------------------------------------------------------------
def hourly_from_rounds(rounds, ends, dec):
    """D-P1: close = answer in force at the hour end; high/low = max/min of the answer in force at the hour start and
    every round with updatedAt in (start, end]."""
    close, high, low = [], [], []
    for e in ends:
        s = int(e) - STEP
        r0 = A.answer_in_force(rounds, s)
        vals = ([r0["answer"]] if r0 else []) + [r["answer"] for r in rounds if s < r["updatedAt"] <= int(e)]
        rc = A.answer_in_force(rounds, int(e))
        close.append(rc["answer"] / 10 ** dec)
        high.append(max(vals) / 10 ** dec)
        low.append(min(vals) / 10 ** dec)
    return np.array(close), np.array(high), np.array(low)


def live_series(D, asof_ts, rounds_all):
    feats, ext = {}, {}
    for a in DEV_ASSETS:
        ser = D[f"long:{a}"]
        if a in rounds_all and asof_ts > DATA_END:
            dec = A.FEEDS[a][1]
            ends = np.arange(DATA_END + STEP, asof_ts + 1, STEP)
            c, h, lo = hourly_from_rounds(rounds_all[a], ends, dec)
            sx = M3.S3(ser.name, a, ser.truth, np.concatenate([ser.close, c]), np.concatenate([ser.low, lo]),
                       ser.levels, ser.base_ts, ser.ts(ser.start_i))
            attach_high(sx, np.concatenate([ser.high, h]))
            nlive = len(ends)
        else:
            sx, nlive = ser, 0
        g_now = int(sx.regime[sx.N])
        har = har_of(sx)[sx.N]
        feats[a] = {"sigma": float(sx.sigma[sx.N]), "sigma_ref": float(sx.sigma_ref[sx.N]), "regime": g_now,
                    "i_now": sx.N, "rv_pct": float(sx.rv_pct[sx.N]) if np.isfinite(sx.rv_pct[sx.N]) else None,
                    "live_hours": int(nlive), "har": [float(x) for x in har]}
        ext[a] = sx
    return feats, ext


def panel_block_task(args):
    """DATA_END fit of every rung at one (asset, T) with the live features, and the shipped rung's estimate range from
    the replayed A4.3 draws (only the DATA_END fold is consumed, as A5's panel)."""
    a, T_h, rung, state, nds, live, close_ext, i_now = args
    D = _SER
    ser, ser_o = D[f"long:{a}"], D[f"oracle:{a}"]
    P6 = Prep6(ser, T_h)
    te = np.array([ser.N])
    o = fold_predict6(ser, P6, T_h, ser.N, te, live=live)
    lv = np.asarray(ser.levels, float)
    for name, nd in M2.REF_DAYS.items():
        sg = A.ref_daily_sigma(close_ext, np.array([i_now]), nd)
        o["raw"][name] = A.touch_prob(lv[None, :], sg[:, None], A.T_DAYS[T_h])
    Po = M3.Prep3(ser_o, T_h, beta_select=False)
    o["raw"]["a"] = Po.freq_upto(ser.N - T_h)[None, :]
    fl = M4.band_order(ser, M3.dev_folds(ser))
    st = M4.band_series(D, a, rung)
    lab = np.isfinite(st.spot) & np.isfinite(st.wmin(T_h))
    lo = hi = None
    for f, nd, cnt in zip(fl, nds, replay_counts(state, nds, T_h)):
        if f["name"] != "DATA_END":
            continue
        days, _, _ = M4.fold_days(st, lab, T_h, f["qs_i"])
        assert len(days) == nd
        sg, sr = np.array([live["sigma"]]), np.array([live["sigma_ref"]])
        with np.errstate(invalid="ignore", divide="ignore"):
            Lte = np.log(np.asarray(live["har"], float))[None, :]
        Xte, okte = np.column_stack([np.ones(1), Lte]), np.all(np.isfinite(Lte), axis=1)
        smp = range_samples(ser, P6, rung, f["qs_i"], te, cnt, sg, sr, Xte, okte, ser_o=ser_o, Po=Po)
        lo, hi = np.percentile(smp, BAND_PCT, axis=0)
    _clear(ser)
    _clear(ser_o)
    return {"raw": {r: o["raw"][r][0] for r in RUNGS}, "fit": o["fit"], "betas": {int(b): v[0] for b, v in
                                                                               o["betas"].items()},
            "lo": lo[0], "hi": hi[0]}


def run_panel(datasets, out_dir, meta, final=False, try_rpc=True, workers=4, log=print):
    path = os.path.join(out_dir, "panel.json" if final else "panel-preview.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    with open(os.path.join(out_dir, "results-dev.json")) as f:
        dev = json.load(f)
    fpath = os.path.join(out_dir, "frozen-a6.json")
    if A.sha256_file(fpath) != dev["frozen_file"]["sha256"]:
        raise SystemExit("STOP: frozen-a6.json sha256 mismatch")
    with open(fpath) as f:
        frozen = json.load(f)
    fin = None
    if final:
        with open(os.path.join(out_dir, "results-blind5.json")) as f:
            fin = json.load(f)["final_basis"]
    shipped = frozen["shipped"]
    global _SER
    D = M3.build_dev(datasets)
    attach_highs_dev(datasets, D)
    panel = {"phase": "panel" if final else "panel-preview", "prereg": PREREG, "code": code_meta(), "inputs": meta,
             "frozen_sha256": dev["frozen_file"]["sha256"], "basis_includes_blind5": bool(final),
             "range_wording": "estimate range lo-hi: how much this estimate moves when past data is resampled (every "
                              "fitted quantity re-estimated); not a range of outcomes (A4 D1)", "assets": {}}
    asof_info = {"data_end": A.iso(DATA_END), "source": "dataset", "asof": A.iso(DATA_END)}
    live, rounds_all = {}, {}
    if try_rpc:
        now = int(time.time())
        asof_ts = (now // STEP) * STEP
        try:
            rpc = A.Rpc()
            for a in DEV_ASSETS:
                proxy, dec = A.FEEDS[a]
                rounds = A.chainlink_rounds_since(rpc, proxy, DATA_END)
                rounds_all[a] = rounds
                r_asof = A.answer_in_force(rounds, asof_ts)
                live[a] = {"in_force_at_asof": {"roundId": str(r_asof["roundId"]), "updatedAt": r_asof["updatedAt"],
                                                "price": r_asof["answer"] / 10 ** dec}, "rounds_read": len(rounds)}
            asof_info = {"data_end": A.iso(DATA_END), "source": "chainlink getRoundData via public RPC",
                         "asof": A.iso(asof_ts), "rpc_calls": rpc.calls, "rpc_errors": rpc.errors,
                         "read_at_utc": A.iso(now)}
        except Exception as e:  # noqa: BLE001
            asof_info["rpc_failed"] = f"{type(e).__name__}: {e}"
            live, rounds_all = {}, {}
    panel["asof"] = asof_info
    panel["live_chainlink"] = live
    asof_ts = A.utc(asof_info["asof"])
    feat, ext = live_series(D, asof_ts, rounds_all)
    _SER = dict(D)
    plan = band_plan(D, shipped)
    tasks = [("panel", (p["a"], p["T_h"], p["rung"], p["state"], p["nds"], feat[p["a"]], ext[p["a"]].close,
                        feat[p["a"]]["i_now"])) for p in plan]
    res = {}
    if workers > 1:
        with mp.get_context("fork").Pool(workers, maxtasksperchild=1) as pool:
            for (a, T_h), r in zip([(p["a"], p["T_h"]) for p in plan],
                                   pool.imap(panel_block_task, [t[1] for t in tasks])):
                res[(a, T_h)] = r
                log(f"  panel {a} {T_LABEL[T_h]}")
    else:
        for p, t in zip(plan, tasks):
            res[(p["a"], p["T_h"])] = panel_block_task(t[1])
    shown = {}
    for a in DEV_ASSETS:
        ser = D[f"long:{a}"]
        grids = {r: np.array([res[(a, T)]["raw"][r] for T in HORIZONS_H]) for r in RUNGS}
        fixed = {r: A.monotone_fix(g[None])[0] for r, g in grids.items() if not np.isnan(g).any()}
        lo_g = A.monotone_fix(np.array([res[(a, T)]["lo"] for T in HORIZONS_H])[None])[0]
        hi_g = A.monotone_fix(np.array([res[(a, T)]["hi"] for T in HORIZONS_H])[None])[0]
        g_now = feat[a]["regime"]
        gname = REGIMES[g_now] if g_now >= 0 else None
        pgrid = np.array([fixed[shipped[a][T_LABEL[T]]][ti] for ti, T in enumerate(HORIZONS_H)])
        lo_g, hi_g = np.minimum(lo_g, pgrid), np.maximum(hi_g, pgrid)
        shown[a] = (pgrid, lo_g, hi_g, gname)
        cells = {}
        for ti, T_h in enumerate(HORIZONS_H):
            TL = T_LABEL[T_h]
            ship = shipped[a][TL]
            ft = res[(a, T_h)]["fit"]
            row = {"rung": ship, "regime_now": gname, "period": dev["per_asset"][a][TL]["counts"]["period"],
                   "fits_data_end": {"w": ft["w"], "har": ft["har"], "maps": {b: v[0] for b, v in ft["maps"].items()},
                                     "fbL_betas": res[(a, T_h)]["betas"]}, "levels": {}}
            for j, k in enumerate(ser.levels):
                kk = repr(float(k))
                e = frozen["labels"][a][TL][ship][kk].get(gname) if gname else None
                lab = e["after"] if e else "no regime"
                bstr = (fin[a][TL][ship][kk][gname]["basis"] if fin and gname else (e["basis"] if e else None))
                p, lo, hi = float(pgrid[ti, j]), float(lo_g[ti, j]), float(hi_g[ti, j])
                row["levels"][kk] = {"p": p, "lo": lo, "hi": hi, "regime": gname, "label": lab, "basis": bstr,
                                     "n_ep": e.get("n_ep") if e else None,
                                     "outcome": e.get("outcome") if e else None,
                                     "seed_sensitive": e.get("seed_sensitive") if e else None,
                                     "display": f"{A.fmt_p(p, dagger=False)}, estimate range {A.fmt_p(lo, dagger=False)}"
                                                f"–{A.fmt_p(hi, dagger=False)} · {lab} ({bstr}) · {gname} vol"}
            cells[TL] = row
        panel["assets"][a] = {"cells": cells, "regime_now": gname, "rv_pct_now": feat[a]["rv_pct"],
                              "sigma_hat_now": feat[a]["sigma"], "sigma_ref_now": feat[a]["sigma_ref"],
                              "har_components_now": feat[a]["har"], "live_hours_spliced": feat[a]["live_hours"],
                              "grids_fixed_all_rungs": {r: g.tolist() for r, g in fixed.items()},
                              "range_lo": lo_g.tolist(), "range_hi": hi_g.tolist()}
    lv = list(LEVELS["ETH"])
    Sx = live["ETH"]["in_force_at_asof"]["price"] if "ETH" in live else float(D["oracle:ETH"].close[-1])
    C, LT = A.EXAMPLE["collateral_units"], A.EXAMPLE["LT"]
    Dd = C * LT * Sx * (1.0 + A.EXAMPLE["line_distance"])
    y_now = Dd / (C * LT) / Sx - 1.0
    ti7 = HORIZONS_H.index(A.ACTION_T_H)
    pg, lg, hg, gname = shown["ETH"]
    rows = A.action_rows(lv, [float(v) for v in pg[ti7]], Dd, C, LT, Sx, y_now=y_now)
    labs7 = frozen["labels"]["ETH"]["7d"][shipped["ETH"]["7d"]]
    for r in rows:
        y_t = r.get("line_after", r.get("y_star"))
        if y_t is None:
            y_t = lv[0] if r["status"] == "shallower_than_grid" else lv[-1]
        k0, k1 = M2.bracket_levels(lv, y_t)
        lab = lambda k: (labs7[repr(float(k))].get(gname) or {}).get("after", "no regime") if gname else "no regime"  # noqa: E731
        r["label"] = M2.worse_label(lab(k0), lab(k1)) if gname else "no regime"
        pl, _ = A.p_at_distance(lv, [float(v) for v in lg[ti7]], y_t)
        ph, _ = A.p_at_distance(lv, [float(v) for v in hg[ti7]], y_t)
        r.update(lo_at_line=pl, hi_at_line=ph)
        r["display"] = (f"Repay ${r['repay']:,} · line −{r['line_after_pct']}% · {r['Z']:.0%} "
                        f"(estimate range {_fp(pl)}–{_fp(ph)}) [{r['label']}]"
                        if r.get("repay") else f"{r['text']} [{r['label']}]")
    panel["action_example"] = {"label": "EXAMPLE position (not a real position; no number goes into app code)",
                               "position": {"collateral": f"{C:g} ETH", "LT": LT, "spot_S": Sx, "debt_D_usd": Dd,
                                            "distance_y": y_now}, "regime_now": gname, "rows": rows,
                               "display": [r["display"] for r in rows]}
    write_json(path, panel, refuse_overwrite=True)
    log(f"{os.path.basename(path)} written (asof {asof_info['asof']})")
    return panel


def _fp(p):
    return "n/a" if p is None else A.fmt_p(p, dagger=False)


def attach_highs_dev(datasets, D):
    """attach_highs for the dev series only (panel)."""
    px = {a: A.load_price(os.path.join(datasets, A.INPUTS[k][0]), cols=("oracle", "oracleLow", "oracleHigh"))
          for a, k in (("ETH", "eth_price"), ("BTC", "btc_price"), ("stETH", "steth_price"))}
    for a in DEV_ASSETS:
        oc, oh = M2.place_a_grid(px[a]["oracle"]), M2.place_a_grid(px[a]["oracleHigh"])
        ci = M2.gi(A.COVERAGE_START[a])
        ls = D[f"long:{a}"]
        if a in M2.LONG_PAIR:
            kl = load_klines_cols(datasets, M2.LONG_PAIR[a])
            oc2, oh2 = oc.copy(), oh.copy()
            oc2[:ci] = np.nan
            oh2[:ci] = np.nan
            si = M2.gi(M2.SPLICE_TS[a])
            c, h = oc2.copy(), oh2.copy()
            c[:si], h[:si] = kl["close"][:si], kl["high"][:si]
            c[:kl["first_i"]] = np.nan
            h[:kl["first_i"]] = np.nan
        else:
            c, h = oc.copy(), oh.copy()
        c[:ls.start_i] = np.nan
        if not _same(c, ls.close):
            raise SystemExit(f"STOP: rebuilt close of long:{a} differs from the series close")
        attach_high(ls, h)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", choices=("dryrun", "a60", "dev", "preview", "blind5", "panel", "manifest"),
                    required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--no-rpc", action="store_true")
    ap.add_argument("--blind5-commit", help="blind5: the published membrane-datasets commit holding blind5-prices/")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    if a.phase == "manifest":
        run_manifest(a.out)
        return 0
    if a.phase == "blind5":
        blind5_gate(a.out, a.blind5_commit)          # refuse before any input is read
    meta = M2.verify_all(a.datasets)
    print("inputs verified", flush=True)
    log = lambda *x: print(*x, flush=True)  # noqa: E731
    if a.phase == "dryrun":
        run_dryrun(a.datasets, a.out, meta, log=log)
    elif a.phase == "a60":
        run_a60(a.datasets, a.out, meta, log=log)
    elif a.phase == "dev":
        run_dev(a.datasets, a.out, meta, workers=a.workers, log=log)
    elif a.phase == "preview":
        run_panel(a.datasets, a.out, meta, final=False, try_rpc=not a.no_rpc, workers=a.workers, log=log)
    elif a.phase == "blind5":
        run_blind5(a.datasets, a.out, meta, a.blind5_commit, workers=a.workers, log=log)
    elif a.phase == "panel":
        run_panel(a.datasets, a.out, meta, final=True, try_rpc=not a.no_rpc, workers=a.workers, log=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
