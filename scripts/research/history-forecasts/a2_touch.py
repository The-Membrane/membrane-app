#!/usr/bin/env python3
"""Q26 workstream A2 -- price-touch forecasts: history in today's volatility, stacking, confidence rule v2,
blind tests.

Implements triccs/membrane-board `design/HISTORY_TOUCH_PREREG_A2.md` (registered at commit 5e45406, file
sha256 3bc790ea94446de3fb4f645c4956accc44e02f36328d6d517489496c8fba9a80) with its deviations D1 (f4e66b2:
numbers everywhere beside labels; a locked final blind set that A2 never reads) and D2 (f97216f: BTC also
gets the Binance long-history splice). Every A definition not changed by A2 holds (parent design
`design/HISTORY_TOUCH_PREREG.md`, d616a42); the A code `a_touch.py` is imported and never modified.

Phases (run in this order into a fresh --out):
  dryrun    data-only counts (no label value, no score)                       -> dryrun.json
  dev       development span fit + predict + score ONCE; fixes the shipped rung per cell
            -> results-dev.json, predictions-dev-<asset>.csv.gz, fits-dev.csv.gz, shipped-dev.json (+ .sha256)
  blind     blind sets scored ONCE (refuses without the frozen shipped-dev.json whose sha256 is recorded
            in results-dev.json) -> results-blind.json, predictions-blind-*.csv.gz, labels.csv
  panel     current-day panel (live Chainlink splice, live Deribit DVOL candle) -> panel.json
  manifest  sha256 of every output -> manifest.json
dev and blind refuse to overwrite their results. Light models only (frequency counts, FHS counts, sklearn
logistic regression).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):   # one thread per worker (deterministic)
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import bisect
import csv
import gzip
import hashlib
import io
import json
import math
import multiprocessing as mp
import platform
import sys
import time
import warnings
from datetime import datetime, timezone

import numpy as np
from scipy.signal import lfilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402  (A code reused, never modified)

# ---------------------------------------------------------------------------------------------
# Registered constants (prereg A2.1-A2.7; A definitions via a_touch)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A2.md",
    "commit": "5e45406",
    "sha256": "3bc790ea94446de3fb4f645c4956accc44e02f36328d6d517489496c8fba9a80",
    "deviations": {
        "D1": "f4e66b2 (numbers everywhere beside labels; locked final blind set, not read by A2)",
        "D2": "f97216f (BTC also gets Binance lows/closes spliced before 2020-01-01T00:00Z, from "
              "2017-08-17T04:00Z)",
    },
    "parent": A.PREREG,
}

STEP = 3600
DAY = 86400
BASE_TS = A.utc("2017-08-17T04:00:00Z")      # common grid: hour h opens at BASE_TS + 3600*h
DATA_END = A.DATA_END                          # 2026-10-06T03:00Z (last hour opens 02:00Z)
N_H = (DATA_END - BASE_TS) // STEP             # hours on the grid; origin N_H = DATA_END
OFF_A = (A.START_TS - BASE_TS) // STEP         # A grid hour 0 = common grid hour OFF_A

KLINES = {  # binance-klines @ membrane-datasets 64c326a (PROVENANCE.md)
    "ETHUSDT": ("binance-klines/ETHUSDT-1h.json", "d5c5532a9e32550066edaf0e40b3995d00b8ee54d8d0a64451bc4de0420442db"),
    "BTCUSDT": ("binance-klines/BTCUSDT-1h.json", "f01e2fbfd0b39939985106de3e53b94fd395893a90b823da626ae85a684f59bd"),
    "BNBUSDT": ("binance-klines/BNBUSDT-1h.json", "9b66f92ee6d37fe5ad9e99761595cd631050ee72b513f062b21298ea7522dc28"),
    "XRPUSDT": ("binance-klines/XRPUSDT-1h.json", "20d400a4d37afec5cab54a7fd975d845edddde1448d476ece56f058f752f3b74"),
    "ADAUSDT": ("binance-klines/ADAUSDT-1h.json", "19658a51526fc5c93f9794fc5bfd961c9070a551aa43f8d400f86a42305c5803"),
    "LTCUSDT": ("binance-klines/LTCUSDT-1h.json", "adcdd4c3654b6e5c5192b025234b5e345efca51c5c2d71e9a460620d1545da37"),
    "LINKUSDT": ("binance-klines/LINKUSDT-1h.json", "e282390a984f1ceac8fbb4606049d22ac2f278d8496975ee802ae18c79c7e969"),
    "DOGEUSDT": ("binance-klines/DOGEUSDT-1h.json", "2a977c971762469a9aaf088c73601e4ecf89cc40c2f10a447da6b4eda60a652a"),
    "SOLUSDT": ("binance-klines/SOLUSDT-1h.json", "076649c6ce5233b8e5fd5ce30273c6e5eb9db08f126612c8e886f99c3f5fdb31"),
    "AVAXUSDT": ("binance-klines/AVAXUSDT-1h.json", "a20470208a313bfeae7c2e65d3c9e1db566e4bc9cbc40073ef2ae6de6e47c64c"),
}
A_STORED = {  # A scored run, membrane-datasets fb8eb7a history-forecasts/a/run-533e3b5
    "pred": ("history-forecasts/a/run-533e3b5/predictions-test.csv.gz",
             "425b55b9dc80815e2df685b946832ef42010af84ff85c2cbd33ecef1d3d36f90"),
    "results": ("history-forecasts/a/run-533e3b5/results.json",
                "c83727f0768c79abf31c96ffd7bf2726642a3d29199f69157e3ce9ad1d59f6de"),
}

DEV_ASSETS = ("ETH", "BTC", "stETH")
D_ASSETS = ("ETH", "BTC")
LONG_PAIR = {"ETH": "ETHUSDT", "BTC": "BTCUSDT"}
SPLICE_TS = {"ETH": A.utc("2020-04-08T21:00:00Z"),   # A2.1: ETH before its first oracle hour
             "BTC": A.utc("2020-01-01T00:00:00Z")}   # D2: BTC before its first oracle hour
LONG_FIRST_TS = A.utc("2017-08-17T04:00:00Z")        # first ETHUSDT/BTCUSDT kline
HOLDOUTS = ("BNBUSDT", "XRPUSDT", "ADAUSDT", "LTCUSDT", "LINKUSDT", "DOGEUSDT", "SOLUSDT", "AVAXUSDT")
BSPAN_ASSETS = ("ETH", "BTC")
BSPAN_SPAN = ((2018, 4), (2020, 4))                  # A2.2: 9 quarters
HOLDOUT_LAST = (2026, 3)
HOLDOUT_MIN_DAYS = 365
LEVELS = A.LEVELS
HOLDOUT_LEVELS = A.LEVELS["ETH"]                     # DECISION D-L1
HORIZONS_H = A.HORIZONS_H
T_DAYS = A.T_DAYS
T_LABEL = A.T_LABEL
ISSUE_EVERY_H = A.ISSUE_EVERY_H

SIGMA_HALF_LIFE_H = 336.0     # A2.3 (f): weights 0.5^(j/336)
SIGMA_WARMUP = 1440           # A2.3 (f): needs 1,440 h of returns
SIGMA_ANNUAL = 8760.0
FEAT_CLIP = 1e-4              # A2.3 (s): logits clipped to [1e-4, 1 - 1e-4]
S_HALF_LIFE_D = 365.0         # A2.3 (s): recency weights 0.5^((Q_start - t)/365 d)
LOGIT_KW = dict(penalty="l2", C=1.0, solver="lbfgs", max_iter=1000)
REF_DAYS = {"r30": 30, "r90": 90}

N_BOOT = 2000
SEED_DEV = 20261020           # A2.4
SEED_BLIND = 20261021         # A2.7

# A2.5 confidence rule v2
HIGH_NEP, HIGH_R, HIGH_CI, HIGH_COV, HIGH_NINF = 20, (0.8, 1.25), (0.67, 1.5), 0.85, 8
MED_NEP, MED_R, MED_COV = 10, (0.67, 1.5), 0.70
STALE_FOLDS, STALE_R, STALE_NEP, STALE_COV, STALE_NINF = 4, (0.5, 2.0), 5, 0.5, 4
BLIND_R, BLIND_NEP = (0.67, 1.5), 10

FULL_RUNGS = ("a", "a_long", "f", "s", "r30", "r90", "b", "c")
D_RUNGS = ("fd", "s_d", "d")
FITTED = ("a", "a_long", "f", "s", "fd", "s_d", "r30", "r90")
CANDIDATES = ("a", "a_long", "f", "fd", "s", "s_d")          # A2.3 shipping candidates (refs never ship)
LADDER = ("a", "b", "c", "d", "a_long", "f", "fd", "s", "s_d")
BLIND_RUNGS = ("a", "f", "s", "r30", "r90")                    # A2.7
BLIND_ALIAS = {"a": "a", "a_long": "a", "f": "f", "s": "s", "r30": "r30", "r90": "r90"}  # DECISION D-B2
DEV_COMPARISONS_FULL = (("a_long_vs_a", "a_long", "a"), ("f_vs_a", "f", "a"), ("s_vs_a", "s", "a"),
                        ("b_vs_a", "b", "a"), ("c_vs_a", "c", "a"), ("r30_vs_a", "r30", "a"),
                        ("r90_vs_a", "r90", "a"), ("s_vs_f", "s", "f"))
DEV_COMPARISONS_D = (("fd_vs_a", "fd", "a"), ("s_d_vs_a", "s_d", "a"), ("d_vs_a", "d", "a"),
                     ("fd_vs_f", "fd", "f"), ("s_d_vs_s", "s_d", "s"))
BLIND_COMPARISONS = (("f_vs_a", "f", "a"), ("s_vs_a", "s", "a"), ("r30_vs_a", "r30", "a"),
                     ("r90_vs_a", "r90", "a"), ("s_vs_f", "s", "f"))

DECISIONS = [
    "D-G1 grid: one common hourly grid for every series, hour h opens at 2017-08-17T04:00Z + 3600*h, origins "
    "i = 0..N (i = N is DATA_END 2026-10-06T03:00Z). Origin index arithmetic, spot S(t_i) = close[i-1], label "
    "window lows[i .. i+T_h-1], the null rule and the monotone fix are a_touch's functions unchanged. Test issue "
    "times are origins whose UTC time is 00/06/12/18Z. A-grid arrays (price-history, DVOL) are placed at offset "
    "(2020-01-01 - 2017-08-17T04:00Z)/3600 = 20804 hours.",
    "D-G2 splice (A2.1 + D2): series-level, per hour. The long series takes the Binance kline close and low for "
    "every hour opening before the splice point (ETH 2020-04-08T21:00Z, BTC 2020-01-01T00:00Z) and the Chainlink "
    "oracle close and oracleLow from that hour on. A label whose window straddles the splice uses Binance lows for "
    "the pre-splice hours (and S from a Binance close at origins up to the splice hour). The ETH pre-coverage oracle "
    "island (2020-01-15..17) is replaced by Binance. Binance null hours stay null (no label, no return).",
    "D-G3 (a) 'as A' is computed on the oracle-only series (pre-coverage values null, exactly A's training origins); "
    "it is asserted equal to A's stored p_a and y. (a_long) is the same frequency on the long series. On the "
    "development test folds every long-series label equals the oracle label (asserted).",
    "D-F1 sigma_hat(t_i) = sqrt(8760 * num/den), num = sum_j lambda^j r_{i-1-j}^2, den = sum_j lambda^j over "
    "non-null returns only (null return: term and weight dropped), lambda = 0.5^(1/336), r_m = ln(close[m]/"
    "close[m-1]) the return of hour m (ending at t_{m+1}); lag j = 0 is the return ending at t_i. The EWMA is "
    "expanding over every return since the series start (recursive, scipy lfilter). Warm-up: defined iff at least "
    "1,440 non-null returns end at or before t_i. sigma_hat <= 0 -> undefined.",
    "D-F2 FHS (f): z(t'; T) = ln(window low / S(t')) / (sigma_hat(t') * sqrt(T_h/8760)) for every labelled training "
    "origin with sigma_hat defined; p_f(t0, k) = #{z <= ln(1+k)/(sigma_hat(t0)*sqrt(T_h/8760))} / n over the fold's "
    "training origins (t' + T <= Q_start), long history, equal weights. (fd): sigma = DVOL close of the candle "
    "opening at t - 1h, /100, at both training and forecast origins; training origins need that candle "
    "(from 2021-03-24T01:00Z); rung (d) folds only.",
    "D-S1 (s) is fit on the long spliced series (D2: '(f) and (s) use the long history'), so all of its features are "
    "computed on that series: the a-feature is the plain expanding frequency of the long series (at a test origin "
    "it equals (a_long)'s raw prediction; for stETH it equals (a)), the f-feature is (f), the r30-feature is the "
    "Q25 T1.2 RV30 formula on the long-series closes.",
    "D-S2 inner purge: the training value of the a- and f-features at origin t uses the labelled origins t' with "
    "t' + T <= t (the brief's 't'+T <= t'); the f-feature also needs sigma_hat(t') and sigma_hat(t). A training row "
    "needs all three features (n >= 1 for the frequencies, RV30 defined). (s_d) adds the fd-feature from origins "
    "with t' + T <= t and a DVOL candle at t' - 1h and t - 1h.",
    "D-S3 (s) logistic: sklearn LogisticRegression(penalty='l2', C=1.0, solver='lbfgs', max_iter=1000), intercept "
    "on; rows = training origins x levels (pooled over levels, no level feature); features standardized by the "
    "plain (unweighted) mean and population std over the training rows (a zero std -> 1); sample weights "
    "0.5^((Q_start - t)/(365*24 h)) rescaled to mean 1 over the rows. The FutureWarning for penalty='l2' is "
    "suppressed; ConvergenceWarnings are counted.",
    "D-S4 (s) at a test origin uses the raw (pre-monotone-fix) a, f (and fd) predictions of the same fold and "
    "RV30 at t0, each clipped to [1e-4, 1-1e-4] before the logit. Fallbacks (A.4 (c) analogue): a test origin "
    "with an undefined feature (RV30 or sigma_hat) takes the raw (f) prediction; a fold whose training rows hold "
    "no positive or no negative label takes (f). (s_d): a test origin without a DVOL candle takes raw (s); "
    "a degenerate fold takes (s). Counts are reported.",
    "D-M1 the monotone fix (a_touch.monotone_fix) is applied per (series, t0) to every rung's full grid of "
    "predictions (all six horizons x levels, unlabelled horizons included), r30/r90 included (a no-op: monotone "
    "by construction). Rows without a label are dropped after the fix. The stored A rungs b, c, d are already "
    "fixed.",
    "D-R1 references r30/r90 = Q25 T1.2 estimator (a_touch.ref_daily_sigma + touch_prob) on the series' closes; "
    "a null close at any daily sample point -> undefined (row missing for that rung; on Binance blind data the "
    "count is reported).",
    "D-C1 n_ep: test rows of the cell sorted by t0; an episode is a maximal run of rows with y = 1 whose t0 are "
    "consecutive issue times (6 h apart); a missing row breaks a run. Runs may cross fold boundaries.",
    "D-C2 R = sum(p)/sum(y) over the cell's rows; sum(y) = 0 -> R = +inf (sum(p) > 0). R CI: the cell's (asset, T, "
    "day set) block-bootstrap draws (the same draws as its BSS), replicate R* = (C @ p_day)/(C @ y_day) with "
    "+inf when the replicate has no touch; numpy percentile [2.5, 97.5] (linear) with +inf kept (a bound that "
    "touches +inf is +inf). 'CI inside [0.67, 1.5]' = lower >= 0.67 and upper <= 1.5.",
    "D-C3 informative (fold, level) cell: pbar >= 1/n_w or ybar > 0, n_w = a_touch.coverage_nw(rows, T); covered = "
    "ybar inside the A.5 binomial band (a_touch.binom_band), ends included. cov_inf undefined (fails every cut) "
    "with no informative cell. HIGH needs >= 8 informative cells; MEDIUM states no count.",
    "D-C4 STALE uses the asset's last 4 folds (2025Q4..2026Q3 on the development span) for every rung, the d set "
    "included: R over those rows outside [0.5, 2.0] with >= 5 episodes there, or cov_inf < 0.5 with >= 4 "
    "informative cells there. STALE overrides every label. A LOW cell with n_ep < 10 is labelled 'insufficient'.",
    "D-C5 day sets as A: unique UTC dates of t0 of the scored rows of (asset, T) over all folds (full) and over the "
    "rung (d) folds (d set, ETH/BTC). One block draw per (asset, T, set) from default_rng(20261020) in the order "
    "ETH, BTC, stETH > 6h..30d > full, d. Each draw is shared by every BSS and R of that set. Only block draws "
    "are made (no i.i.d. draws). CI = numpy percentile of finite replicate BSS; eligible = lower bound > 0.",
    "D-P1 shipping pool per cell (A2.6): (a), the A shipped rung (from A results.json), and every eligible A2.3 "
    "candidate among a_long, f, fd, s, s_d. The A rungs b, c, d other than the A shipped rung are re-labelled and "
    "reported, but they are not shipping candidates; r30/r90 never ship.",
    "D-P2 shipping choice: rank the pool by (#HIGH levels, #MEDIUM levels). If several tie at the top: (a) if it is "
    "among them, else the A shipped rung if it is among them ('a tie in labels keeps the lower rung'; a challenger "
    "replaces the rung it replaces only if more confident); else (only challengers tie) the higher BSS vs (a), and "
    "an exact BSS tie keeps the rung listed first in a, a_long, f, fd, s, s_d. The literal lexicographic "
    "(#HIGH, #MEDIUM, BSS vs a) choice is reported beside it for every cell where it differs.",
    "D-B1 blind sets: Binance-only series (close = spot, low = truth), the same functions as the development span. "
    "B-span: ETHUSDT/BTCUSDT from 2017-08-17T04:00Z, test folds 2018Q4..2020Q4. Holdouts: test folds from the first "
    "quarter starting >= 365 days after the first kline to 2026Q3, levels = the ETH/BTC ladder (D-L1). "
    "Draws from default_rng(20261021): B-span ETH then BTC, then the holdouts in the registered order, each "
    "6h..30d; the pooled-holdout day sets (union of dates) per horizon are drawn after every per-asset draw.",
    "D-B2 blind confirmation (A2.5) is applied to every rung's HIGH cells. The check uses the same rung on the blind "
    "sets: (a) and (a_long) use the blind (a) numbers (on Binance-only data the plain and the long history are the "
    "same procedure); f, s, r30, r90 their own. A rung not scored blind (b, c, d, fd, s_d) cannot be confirmed: "
    "'unconfirmed (rung not scored blind)' -> MEDIUM. ETH/BTC need both the own-asset B-span check and the pooled "
    "holdout check; any check with n_ep >= 10 and R outside [0.67, 1.5] -> 'failed blind'; otherwise any check "
    "with n_ep < 10 -> 'unconfirmed'; both pass -> 'confirmed'. Pooled holdout R = sum p / sum y over the 8 pairs, "
    "n_ep = the sum of per-pair episodes. stETH HIGH -> MEDIUM ('capped: no blind set'). The shipped rung never "
    "changes after a blind score.",
    "D-L1 holdout and blind levels = the ETH/BTC ladder (-2% .. -40%); stETH levels are never on a blind set.",
    "D-D1 display (D1): every cell shows its number beside its final label. The displayed number of a cell is the "
    "shipped rung's monotone-fixed prediction refit on all labelled origins up to DATA_END (results-dev: frozen "
    "data; panel: features at asof from the live Chainlink splice). A shipped A rung (b/c/d) is refit by "
    "a_touch.fit_predict_fold exactly as A's panel.",
    "D-D2 ACTION rows (A.8) are shown with a label: the lower of the final labels of the two grid levels the "
    "interpolation uses (HIGH > MEDIUM > LOW = insufficient > STALE). Under D1 the rows are shown at every label.",
]


# ---------------------------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------------------------
def ts_of(i):
    return BASE_TS + STEP * int(i)


def iso(ts):
    return A.iso(ts)


def gi(ts):
    """Common-grid index of a timestamp on the hour."""
    if (ts - BASE_TS) % STEP:
        raise ValueError(f"{ts} not on the hourly grid")
    return (ts - BASE_TS) // STEP


def clip_logit(p):
    p = np.clip(np.asarray(p, float), FEAT_CLIP, 1.0 - FEAT_CLIP)
    return np.log(p) - np.log1p(-p)


def issue_mask(n_orig, base_ts=BASE_TS):
    t = base_ts + STEP * np.arange(n_orig)
    return (t % (ISSUE_EVERY_H * STEP)) == 0


# ---------------------------------------------------------------------------------------------
# sigma_hat (A2.3 (f)) -- EWMA of squared hourly log returns, half-life 336 h, warm-up 1,440 returns
# ---------------------------------------------------------------------------------------------
def ewma_sigma(close, half_life_h=SIGMA_HALF_LIFE_H, warmup=SIGMA_WARMUP, annual=SIGMA_ANNUAL):
    """sigma_hat at origins i = 0..N (length N+1). Origin i uses returns r_m, m <= i-1 (D-F1)."""
    close = np.asarray(close, float)
    n = len(close)
    r = np.full(n, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[1:] = np.log(close[1:] / close[:-1])
    valid = np.isfinite(r)
    x = np.where(valid, r * r, 0.0)
    v = valid.astype(float)
    lam = 0.5 ** (1.0 / half_life_h)
    num = lfilter([1.0], [1.0, -lam], x)
    den = lfilter([1.0], [1.0, -lam], v)
    cnt = np.cumsum(valid)
    out = np.full(n + 1, np.nan)
    ok = (cnt >= warmup) & (den > 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        s = np.sqrt(annual * num / den)
    s[~ok] = np.nan
    s[~(s > 0)] = np.nan
    out[1:] = s
    return out


def ewma_sigma_direct(close, i, half_life_h=SIGMA_HALF_LIFE_H, warmup=SIGMA_WARMUP, annual=SIGMA_ANNUAL):
    """Direct (non-recursive) sigma_hat at one origin, for tests."""
    close = np.asarray(close, float)
    num = den = 0.0
    cnt = 0
    for m in range(i - 1, 0, -1):
        if not (np.isfinite(close[m]) and np.isfinite(close[m - 1])):
            continue
        j = i - 1 - m
        w = 0.5 ** (j / half_life_h)
        rr = math.log(close[m] / close[m - 1])
        num += w * rr * rr
        den += w
        cnt += 1
    if cnt < warmup or den <= 0:
        return float("nan")
    s = math.sqrt(annual * num / den)
    return s if s > 0 else float("nan")


# ---------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------
def verify_file(datasets, rel, want):
    path = os.path.join(datasets, rel)
    got = A.sha256_file(path)
    if got != want:
        raise SystemExit(f"STOP: sha256 mismatch for {rel}: got {got}, registered {want}")
    return {"path": rel, "sha256": got, "bytes": os.path.getsize(path), "verified": True}


def verify_all(datasets):
    meta = {"A.1": A.verify_inputs(datasets)}
    meta["binance_klines"] = {p: verify_file(datasets, *KLINES[p]) for p in KLINES}
    meta["a_stored"] = {k: verify_file(datasets, *v) for k, v in A_STORED.items()}
    return meta


def place_a_grid(arr):
    """A-grid array (hour 0 = 2020-01-01T00:00Z, length n_A) -> common grid (length N_H)."""
    out = np.full(N_H, np.nan)
    arr = np.asarray(arr, float)
    if OFF_A + len(arr) != N_H:
        raise SystemExit("STOP: A grid does not end at DATA_END on the common grid")
    out[OFF_A:] = arr
    return out


def load_klines(datasets, pair):
    rel = KLINES[pair][0]
    with open(os.path.join(datasets, rel)) as f:
        d = json.load(f)
    st, step, cnt = int(d["startTs"]), int(d["stepSeconds"]), int(d["count"])
    if step != STEP or (st - BASE_TS) % STEP or st < BASE_TS:
        raise SystemExit(f"STOP: {rel} grid start/step not on the common grid")
    off = (st - BASE_TS) // STEP
    if off + cnt != N_H:
        raise SystemExit(f"STOP: {rel} does not end at the hour opening 2026-10-06T02:00Z")
    out = {"first_ts": st, "first_i": off}
    for c in ("close", "low"):
        col = d["columns"][c]
        if len(col) != cnt:
            raise SystemExit(f"STOP: {rel} column {c} length")
        a = np.full(N_H, np.nan)
        a[off:] = [np.nan if v is None else float(v) for v in col]
        out[c] = a
    return out


def load_dvol_common(path):
    """a[h] = close of the DVOL candle opening at BASE_TS + 3600*h (NaN if absent)."""
    with open(path) as f:
        d = json.load(f)
    a = np.full(N_H + 1, np.nan)
    for row in d["rows"]:
        ts = int(row[0]) // 1000
        if int(row[0]) % 1000 or (ts - BASE_TS) % STEP:
            raise SystemExit("STOP: DVOL candle off the hourly grid")
        h = (ts - BASE_TS) // STEP
        if 0 <= h < len(a) and row[4] is not None:
            a[h] = float(row[4])
    return a


def splice(binance_close, binance_low, oracle_close, oracle_low, splice_i, first_i):
    """D-G2: hour h < splice_i takes Binance (from first_i), h >= splice_i takes the oracle."""
    c = np.array(oracle_close, float)
    lo = np.array(oracle_low, float)
    c[:splice_i] = binance_close[:splice_i]
    lo[:splice_i] = binance_low[:splice_i]
    c[:first_i] = np.nan
    lo[:first_i] = np.nan
    return c, lo


class GSeries:
    """One (asset, truth) input on the common hourly origin grid."""

    def __init__(self, name, asset, truth, close, low, levels, start_ts, dvol=None):
        self.name, self.asset, self.truth = name, asset, truth
        self.levels = tuple(levels)
        si = gi(start_ts)
        close = np.array(close, float)
        low = np.array(low, float)
        close[:si] = np.nan
        low[:si] = np.nan
        self.close, self.low = close, low
        self.start_i = si
        self.N = len(close)
        self.n_orig = self.N + 1
        self.spot = A.spot_series(close)
        self.sigma = ewma_sigma(close)
        self.sigma_dvol = None
        if dvol is not None:                       # origin i reads the candle opening at t_i - 1h
            s = np.full(self.n_orig, np.nan)
            s[1:] = np.asarray(dvol, float)[:self.N] / 100.0
            s[~(s > 0)] = np.nan
            self.sigma_dvol = s
        self._lab, self._wmin = {}, {}
        self._r30 = None

    def wmin(self, T_h):
        if T_h not in self._wmin:
            self._wmin[T_h] = A.window_min(self.low, T_h)
        return self._wmin[T_h]

    def labels(self, T_h):
        if T_h not in self._lab:
            self._lab[T_h] = A.make_labels(self.spot, self.wmin(T_h), self.levels)
        return self._lab[T_h]

    def r30_all(self):
        """Q25 T1.2 RV30 sigma at every origin (for (s) training rows)."""
        if self._r30 is None:
            self._r30 = A.ref_daily_sigma(self.close, np.arange(self.n_orig), REF_DAYS["r30"])
        return self._r30


def build_dev_series(datasets):
    pe = A.load_price(os.path.join(datasets, A.INPUTS["eth_price"][0]))
    pb = A.load_price(os.path.join(datasets, A.INPUTS["btc_price"][0]))
    ps = A.load_price(os.path.join(datasets, A.INPUTS["steth_price"][0]), cols=("oracle", "oracleLow"))
    dv = {"ETH": load_dvol_common(os.path.join(datasets, A.INPUTS["eth_dvol"][0])),
          "BTC": load_dvol_common(os.path.join(datasets, A.INPUTS["btc_dvol"][0]))}
    px = {"ETH": pe, "BTC": pb, "stETH": ps}
    S = {}
    for a in DEV_ASSETS:
        oc = place_a_grid(px[a]["oracle"])
        ol = place_a_grid(px[a]["oracleLow"])
        cov = A.COVERAGE_START[a]
        S[f"oracle:{a}"] = GSeries(f"oracle:{a}", a, "oracle", oc, ol, LEVELS[a], cov, dvol=dv.get(a))
        if a in LONG_PAIR:
            kl = load_klines(datasets, LONG_PAIR[a])
            oc2, ol2 = oc.copy(), ol.copy()
            ci = gi(cov)
            oc2[:ci] = np.nan
            ol2[:ci] = np.nan
            c, lo = splice(kl["close"], kl["low"], oc2, ol2, gi(SPLICE_TS[a]), kl["first_i"])
            S[f"long:{a}"] = GSeries(f"long:{a}", a, "long", c, lo, LEVELS[a], kl["first_ts"], dvol=dv.get(a))
        else:
            S[f"long:{a}"] = S[f"oracle:{a}"]
    return S


def build_blind_series(datasets):
    S = {}
    for a in BSPAN_ASSETS:
        kl = load_klines(datasets, LONG_PAIR[a])
        S[f"bspan:{a}"] = GSeries(f"bspan:{a}", a, "binance", kl["close"], kl["low"], HOLDOUT_LEVELS,
                                  kl["first_ts"])
    for p in HOLDOUTS:
        kl = load_klines(datasets, p)
        S[f"holdout:{p}"] = GSeries(f"holdout:{p}", p, "binance", kl["close"], kl["low"], HOLDOUT_LEVELS,
                                    kl["first_ts"])
    return S


# ---------------------------------------------------------------------------------------------
# Folds
# ---------------------------------------------------------------------------------------------
def quarters(first, last):
    (y, q), out = first, []
    while (y, q) <= last:
        ny, nq = (y, q + 1) if q < 4 else (y + 1, 1)
        qs, qe = A.quarter_start(y, q), A.quarter_start(ny, nq)
        out.append({"name": f"{y}Q{q}", "qs_ts": qs, "qe_ts": qe, "qs_i": gi(qs), "qe_i": gi(qe)})
        y, q = ny, nq
    return out


def dev_folds(asset):
    return quarters(*A.FOLD_SPAN[asset])


def d_fold_names(asset):
    return {f["name"] for f in quarters(*A.D_FOLD_SPAN)} if asset in D_ASSETS else set()


def holdout_first_quarter(first_ts):
    """A2.2: the first calendar quarter starting >= 365 days after the first kline."""
    lim = first_ts + HOLDOUT_MIN_DAYS * DAY
    y = int(iso(first_ts)[:4])
    q = 1
    while A.quarter_start(y, q) < lim:
        y, q = (y, q + 1) if q < 4 else (y + 1, 1)
    return (y, q)


def blind_folds(ser):
    if ser.name.startswith("bspan:"):
        return quarters(*BSPAN_SPAN)
    return quarters(holdout_first_quarter(ts_of(ser.start_i)), HOLDOUT_LAST)


def test_issue_times(qs_i, qe_i, n_orig, imask):
    i = np.arange(qs_i, min(qe_i, n_orig))
    return i[imask[i]]


# ---------------------------------------------------------------------------------------------
# Per (series, T): labels, FHS depths, as-of features (A2.3)
# ---------------------------------------------------------------------------------------------
def asof_fhs_counts(valid_src, zsrc, valid_q, thr, T_h):
    """For each origin i with valid_q[i]: fraction of {i' : valid_src[i'], i' + T_h <= i} with
    zsrc[i'] <= thr[i, k] (D-S2). NaN where undefined or the set is empty."""
    n_orig, K = thr.shape
    out = np.full((n_orig, K), np.nan)
    src = np.where(valid_src)[0]
    zl = zsrc[src].tolist()
    qi = np.where(valid_q)[0]
    thr_l = thr[qi].tolist()
    sl = []
    ptr, ns = 0, len(src)
    res = np.full((len(qi), K), np.nan)
    br = bisect.bisect_right
    ins = bisect.insort
    for row, i in enumerate(qi.tolist()):
        lim = i - T_h
        while ptr < ns and src[ptr] <= lim:
            ins(sl, zl[ptr])
            ptr += 1
        n = len(sl)
        if n:
            res[row] = [br(sl, u) / n for u in thr_l[row]]
    out[qi] = res
    return out


class PrepT:
    """Everything one (series, T) needs across folds."""

    def __init__(self, ser, T_h, asof=True, with_fd=False):
        self.T_h = T_h
        self.Y = ser.labels(T_h)
        self.lab_ok = np.isfinite(self.Y[:, 0])
        self.K = len(ser.levels)
        self.lnk = np.log1p(np.asarray(ser.levels, float))
        self.scale = math.sqrt(T_h / SIGMA_ANNUAL)
        with np.errstate(invalid="ignore", divide="ignore"):
            self.depth = np.where(self.lab_ok, np.log(ser.wmin(T_h) / ser.spot), np.nan)
        Yz = np.where(self.lab_ok[:, None], self.Y, 0.0)
        self.cumY = np.cumsum(Yz, axis=0)
        self.cumN = np.cumsum(self.lab_ok.astype(np.int64))
        sig = ser.sigma
        self.f_src = self.lab_ok & np.isfinite(sig)
        with np.errstate(invalid="ignore", divide="ignore"):
            self.z = np.where(self.f_src, self.depth / (sig * self.scale), np.nan)
        self.fd_src = None
        if with_fd and ser.sigma_dvol is not None:
            sd = ser.sigma_dvol
            self.fd_src = self.lab_ok & np.isfinite(sd)
            with np.errstate(invalid="ignore", divide="ignore"):
                self.zd = np.where(self.fd_src, self.depth / (sd * self.scale), np.nan)
        self.asof = None
        if asof:
            self._build_asof(ser, with_fd)

    def thresholds(self, sigma):
        with np.errstate(invalid="ignore", divide="ignore"):
            return self.lnk[None, :] / (np.asarray(sigma, float)[:, None] * self.scale)

    def freq_upto(self, lim):
        """Expanding frequency over labelled origins i' <= lim (lim = Q_start - T or t - T)."""
        if lim < 0 or self.cumN[lim] == 0:
            return np.full(self.K, np.nan)
        return self.cumY[lim] / self.cumN[lim]

    def _build_asof(self, ser, with_fd):
        n = len(self.lab_ok)
        T = self.T_h
        pa = np.full((n, self.K), np.nan)
        idx = np.arange(n) - T
        okl = idx >= 0
        cn = np.where(okl, self.cumN[np.clip(idx, 0, None)], 0)
        good = okl & (cn > 0)
        pa[good] = self.cumY[idx[good]] / cn[good][:, None]
        thr = self.thresholds(ser.sigma)
        pf = asof_fhs_counts(self.f_src, self.z, self.f_src, np.where(np.isfinite(thr), thr, 0.0), T)
        r30 = ser.r30_all()
        pr = A.touch_prob(np.asarray(ser.levels, float)[None, :], r30[:, None], T_DAYS[T])
        self.asof = {"a": pa, "f": pf, "r30": pr}
        if with_fd and self.fd_src is not None:
            thr_d = self.thresholds(ser.sigma_dvol)
            self.asof["fd"] = asof_fhs_counts(self.fd_src, self.zd, self.fd_src,
                                              np.where(np.isfinite(thr_d), thr_d, 0.0), T)


def fhs_predict(z_train, thr_te):
    """p = #{z <= thr}/n for each test origin and level (searchsorted right = bisect_right)."""
    zs = np.sort(z_train)
    n = len(zs)
    out = np.full(thr_te.shape, np.nan)
    if n == 0:
        return out
    ok = np.all(np.isfinite(thr_te), axis=1)
    if ok.any():
        out[ok] = np.searchsorted(zs, thr_te[ok], side="right") / n
    return out


def recency_weights(origins, qs_i):
    return A.recency_weights(origins, qs_i, S_HALF_LIFE_D)


def fit_stack(X, y, w):
    """D-S3: plain standardization, sample weights rescaled to mean 1."""
    from sklearn.exceptions import ConvergenceWarning
    from sklearn.linear_model import LogisticRegression
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd = np.where(sd > 0, sd, 1.0)
    sw = w / w.mean()
    m = LogisticRegression(**LOGIT_KW)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        m.fit((X - mu) / sd, y, sample_weight=sw)
    conv = not any(issubclass(c.category, ConvergenceWarning) for c in caught)
    return {"model": m, "mu": mu, "sd": sd, "coef": m.coef_[0].copy(), "intercept": float(m.intercept_[0]),
            "n_iter": int(np.max(m.n_iter_)), "converged": bool(conv)}


def predict_stack(fit, X):
    return fit["model"].predict_proba((X - fit["mu"]) / fit["sd"])[:, 1]


def stack_training(P, qs_i, feats):
    """(s)/(s_d) training rows: origins i with i + T <= Q_start and every as-of feature defined (D-S2).
    Returns X (rows x n_feat), y, w, n_origins."""
    T = P.T_h
    n = len(P.lab_ok)
    i = np.arange(n)
    ok = P.lab_ok & (i + T <= qs_i)
    for f in feats:
        ok &= np.all(np.isfinite(P.asof[f]), axis=1)
    tr = i[ok]
    if len(tr) == 0:
        return None, None, None, 0, tr
    X = np.stack([clip_logit(P.asof[f][tr]).ravel() for f in feats], axis=1)
    y = P.Y[tr].ravel()
    w = np.repeat(recency_weights(tr, qs_i), P.K)
    return X, y, w, len(tr), tr


def predict_fold(ser, P, T_h, qs_i, te, in_d, rungs, te_sigma=None, te_sigma_dvol=None, te_r30=None,
                 te_r90=None, keep_fits=False):
    """Raw (pre-fix) predictions {rung: (len(te), K)} for one (series, T, fold).
    te_* (panel only) replace the test-origin features read from `ser`."""
    K = P.K
    n_te = len(te)
    out = {"raw": {}, "flags": {}, "fits": []}
    lim = qs_i - T_h
    p_a = P.freq_upto(lim)
    out["n_train"] = int(P.cumN[lim]) if lim >= 0 else 0
    out["raw"]["a"] = np.tile(p_a, (n_te, 1))
    sig_te = ser.sigma[te] if te_sigma is None else np.atleast_1d(np.asarray(te_sigma, float))
    i_all = np.arange(len(P.lab_ok))
    trf = P.f_src & (i_all <= lim)
    out["n_train_f"] = int(trf.sum())
    p_f = fhs_predict(P.z[trf], P.thresholds(sig_te))
    out["raw"]["f"] = p_f
    out["flags"]["f_undefined"] = ~np.all(np.isfinite(p_f), axis=1)
    levels = np.asarray(ser.levels, float)
    for name, nd in REF_DAYS.items():
        if name in rungs or (name == "r30" and "s" in rungs):
            override = te_r30 if name == "r30" else te_r90
            sg = A.ref_daily_sigma(ser.close, te, nd) if override is None else np.atleast_1d(np.asarray(override, float))
            out["raw"][name] = A.touch_prob(levels[None, :], sg[:, None], T_DAYS[T_h])
    if "s" in rungs:
        X, y, w, n_or, _ = stack_training(P, qs_i, ("a", "f", "r30"))
        ps = p_f.copy()
        te_ok = np.all(np.isfinite(p_f), axis=1) & np.all(np.isfinite(out["raw"]["r30"]), axis=1) & \
            np.all(np.isfinite(out["raw"]["a"]), axis=1)
        rec = {"rung": "s", "n_train_origins": n_or, "n_rows": 0 if X is None else int(len(y))}
        cell_fb = X is None or y.min() == y.max()
        if not cell_fb:
            fit = fit_stack(X, y, w)
            if te_ok.any():
                Xt = np.stack([clip_logit(out["raw"]["a"][te_ok]).ravel(), clip_logit(p_f[te_ok]).ravel(),
                               clip_logit(out["raw"]["r30"][te_ok]).ravel()], axis=1)
                ps[te_ok] = predict_stack(fit, Xt).reshape(-1, K)
            rec.update(fallback=False, n_pos=int(y.sum()), coef=fit["coef"].tolist(), intercept=fit["intercept"],
                       mu=fit["mu"].tolist(), sd=fit["sd"].tolist(), n_iter=fit["n_iter"],
                       converged=fit["converged"])
            if keep_fits:
                out["fit_s"] = fit
        else:
            rec.update(fallback=True)
        out["fits"].append(rec)
        out["raw"]["s"] = ps
        out["flags"]["s_cell_fb"] = bool(cell_fb)
        out["flags"]["s_row_fb"] = ~te_ok
    if in_d and P.fd_src is not None and ("fd" in rungs or "s_d" in rungs):
        sd_te = ser.sigma_dvol[te] if te_sigma_dvol is None else np.atleast_1d(np.asarray(te_sigma_dvol, float))
        trd = P.fd_src & (i_all <= lim)
        out["n_train_fd"] = int(trd.sum())
        p_fd = fhs_predict(P.zd[trd], P.thresholds(sd_te))
        out["raw"]["fd"] = p_fd
        if "s_d" in rungs:
            X, y, w, n_or, _ = stack_training(P, qs_i, ("a", "f", "r30", "fd"))
            psd = out["raw"]["s"].copy()
            te_ok = np.all(np.isfinite(p_fd), axis=1) & ~out["flags"]["s_row_fb"]
            rec = {"rung": "s_d", "n_train_origins": n_or, "n_rows": 0 if X is None else int(len(y))}
            cell_fb = X is None or y.min() == y.max()
            if not cell_fb:
                fit = fit_stack(X, y, w)
                if te_ok.any():
                    Xt = np.stack([clip_logit(out["raw"]["a"][te_ok]).ravel(), clip_logit(p_f[te_ok]).ravel(),
                                   clip_logit(out["raw"]["r30"][te_ok]).ravel(),
                                   clip_logit(p_fd[te_ok]).ravel()], axis=1)
                    psd[te_ok] = predict_stack(fit, Xt).reshape(-1, K)
                rec.update(fallback=False, n_pos=int(y.sum()), coef=fit["coef"].tolist(),
                           intercept=fit["intercept"], mu=fit["mu"].tolist(), sd=fit["sd"].tolist(),
                           n_iter=fit["n_iter"], converged=fit["converged"])
            else:
                rec.update(fallback=True)
            out["fits"].append(rec)
            out["raw"]["s_d"] = psd
            out["flags"]["s_d_cell_fb"] = bool(cell_fb)
            out["flags"]["s_d_row_fb"] = ~te_ok
    return out


# ---------------------------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------------------------
_SER = {}


def dev_task(args):
    """One (asset, T): every fold of the development span plus the DATA_END refit (frozen data)."""
    asset, T_h = args
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
    lser, oser = _SER[f"long:{asset}"], _SER[f"oracle:{asset}"]
    has_d = asset in D_ASSETS
    PL = PrepT(lser, T_h, asof=True, with_fd=has_d)
    PO = PL if oser is lser else PrepT(oser, T_h, asof=False)
    imask = issue_mask(lser.n_orig)
    dn = d_fold_names(asset)
    res = []
    for f in dev_folds(asset) + [{"name": "DATA_END", "qs_i": N_H, "qe_i": N_H + 1}]:
        te = test_issue_times(f["qs_i"], f["qe_i"], lser.n_orig, imask) if f["name"] != "DATA_END" \
            else np.array([N_H])
        in_d = has_d and (f["name"] in dn or f["name"] == "DATA_END")
        rungs = ("f", "s", "r30", "r90") + (("fd", "s_d") if in_d else ())
        o = predict_fold(lser, PL, T_h, f["qs_i"], te, in_d, rungs)
        o["raw"]["a_long"] = o["raw"].pop("a")
        lim = f["qs_i"] - T_h
        o["raw"]["a"] = np.tile(PO.freq_upto(lim), (len(te), 1))
        o["n_train_a"] = int(PO.cumN[lim])
        o["fold"], o["te"], o["in_d"] = f["name"], te, in_d
        res.append(o)
    return asset, T_h, res


def blind_task(args):
    key, T_h = args
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
    ser = _SER[key]
    P = PrepT(ser, T_h, asof=True, with_fd=False)
    imask = issue_mask(ser.n_orig)
    res = []
    for f in blind_folds(ser):
        te = test_issue_times(f["qs_i"], f["qe_i"], ser.n_orig, imask)
        o = predict_fold(ser, P, T_h, f["qs_i"], te, False, ("f", "s", "r30", "r90"))
        o["fold"], o["te"], o["in_d"] = f["name"], te, False
        res.append(o)
    return key, T_h, res


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


def assemble(ser, folds, per_T, rungs, d_names=frozenset(), y_check_ser=None):
    """Stack per-horizon fold outputs into (n_te, nT, K) grids, monotone-fix each rung, flatten labelled rows."""
    K, nT = len(ser.levels), len(HORIZONS_H)
    te0 = [o["te"] for o in per_T[HORIZONS_H[0]] if o["fold"] != "DATA_END"]
    te_all = np.concatenate(te0)
    fold_of = np.concatenate([[fi] * len(t) for fi, t in enumerate(te0)]).astype(int)
    n = len(te_all)
    G = {r: np.full((n, nT, K), np.nan) for r in rungs}
    flags = {"s_row_fb": np.zeros((n, nT), bool), "s_cell_fb": np.zeros((n, nT), bool),
             "s_d_row_fb": np.zeros((n, nT), bool), "s_d_cell_fb": np.zeros((n, nT), bool)}
    fits, data_end = [], {}
    for ti, T_h in enumerate(HORIZONS_H):
        off = 0
        for o in per_T[T_h]:
            if o["fold"] == "DATA_END":
                data_end[T_h] = o
                continue
            m = len(o["te"])
            sl = slice(off, off + m)
            assert np.array_equal(te_all[sl], o["te"]) and folds[fold_of[off]]["name"] == o["fold"]
            for r in rungs:
                if r in o["raw"]:
                    G[r][sl, ti, :] = o["raw"][r]
            for fk in ("s_row_fb", "s_d_row_fb"):
                if fk in o["flags"]:
                    flags[fk][sl, ti] = o["flags"][fk]
            for fk in ("s_cell_fb", "s_d_cell_fb"):
                if fk in o["flags"]:
                    flags[fk][sl, ti] = o["flags"][fk]
            for rec in o["fits"]:
                fits.append({"series": ser.name, "T_h": T_h, "fold": o["fold"], **rec})
            off += m
        assert off == n
    in_d = np.array([folds[fi]["name"] in d_names for fi in fold_of], dtype=bool)
    F = {}
    for r in rungs:
        g = G[r]
        if r in ("fd", "s_d"):
            Fr = np.full_like(g, np.nan)
            if in_d.any():
                assert not np.isnan(g[in_d]).any(), f"{ser.name} {r} grid has gaps on the d folds"
                Fr[in_d] = A.monotone_fix(g[in_d])
            F[r] = Fr
        elif r in ("r30", "r90"):
            F[r] = A.monotone_fix(g)            # NaN rows (undefined RV) stay NaN for every cell
        else:
            assert not np.isnan(g).any(), f"{ser.name} {r} grid has gaps"
            F[r] = A.monotone_fix(g)
    rows = {k: [] for k in ("t0_i", "fold_i", "T_h", "k_i", "k", "y", "in_d", "s_fb", "s_d_fb")}
    rows.update({f"p_{r}": [] for r in rungs})
    for ti, T_h in enumerate(HORIZONS_H):
        Y = ser.labels(T_h)[te_all]
        if y_check_ser is not None:
            Y2 = y_check_ser.labels(T_h)[te_all]
            assert np.array_equal(np.isfinite(Y), np.isfinite(Y2)) and \
                np.array_equal(Y[np.isfinite(Y)], Y2[np.isfinite(Y2)]), f"{ser.name} long vs oracle labels differ"
        idx = np.where(np.isfinite(Y[:, 0]))[0]
        sfb = np.where(flags["s_cell_fb"][idx, ti], 1, np.where(flags["s_row_fb"][idx, ti], 2, 0))
        sdfb = np.where(flags["s_d_cell_fb"][idx, ti], 1, np.where(flags["s_d_row_fb"][idx, ti], 2, 0))
        for j, k in enumerate(ser.levels):
            rows["t0_i"].append(te_all[idx])
            rows["fold_i"].append(fold_of[idx])
            rows["T_h"].append(np.full(len(idx), T_h))
            rows["k_i"].append(np.full(len(idx), j))
            rows["k"].append(np.full(len(idx), k))
            rows["y"].append(Y[idx, j])
            rows["in_d"].append(in_d[idx])
            rows["s_fb"].append(sfb)
            rows["s_d_fb"].append(np.where(in_d[idx], sdfb, -1))
            for r in rungs:
                rows[f"p_{r}"].append(F[r][idx, ti, j])
    R = {k: np.concatenate(v) for k, v in rows.items()}
    R["day"] = (BASE_TS + STEP * R["t0_i"]) // DAY
    R["fold_names"] = [f["name"] for f in folds]
    R["levels"] = list(ser.levels)
    # DATA_END grids (frozen data), fixed per rung
    de = {}
    if data_end:
        for r in rungs:
            g = np.full((nT, K), np.nan)
            for ti, T_h in enumerate(HORIZONS_H):
                if T_h in data_end and r in data_end[T_h]["raw"]:
                    g[ti] = data_end[T_h]["raw"][r][0]
            if not np.isnan(g).any():
                de[r] = A.monotone_fix(g[None])[0]
    return R, fits, de


# ---------------------------------------------------------------------------------------------
# Stored A predictions (rungs b, c, d re-labelled, not refit)
# ---------------------------------------------------------------------------------------------
def load_stored_a(path):
    import pandas as pd
    df = pd.read_csv(path, compression="gzip", dtype={"asset": str, "t0": str, "fold": str, "T": str,
                                                      "c_fallback": str, "d_fallback": str})
    t = df["t0"].to_numpy(dtype=str)
    if not all(x.endswith("Z") and len(x) == 20 for x in t[:: max(1, len(t) // 1000)]):
        raise SystemExit("STOP: unexpected t0 format in the stored A predictions")
    df["ts"] = np.array([x[:19] for x in t], dtype="datetime64[s]").astype(np.int64)   # seconds, explicit unit
    return df


def merge_stored(R, df, asset):
    """Attach stored p_a (check), y (check), p_b, p_c, p_d to the rows R of `asset`."""
    sub = df[df["asset"] == asset]
    lv = R["levels"]
    t_h = {v: k for k, v in T_LABEL.items()}
    key_rows = {}
    ti = ((sub["ts"].to_numpy() - BASE_TS) // STEP).astype(np.int64)
    Th = sub["T"].map(t_h).to_numpy().astype(np.int64)
    kk = sub["k"].to_numpy()
    k_i = np.searchsorted(-np.asarray(lv), -kk)
    assert np.allclose(np.asarray(lv)[k_i], kk)
    code_s = (ti * 1000 + Th) * 100 + k_i
    code_r = (R["t0_i"].astype(np.int64) * 1000 + R["T_h"].astype(np.int64)) * 100 + R["k_i"].astype(np.int64)
    order = np.argsort(code_s)
    cs = code_s[order]
    pos = np.searchsorted(cs, code_r)
    found = (pos < len(cs)) & (cs[np.clip(pos, 0, len(cs) - 1)] == code_r)
    if not found.all() or len(cs) != len(code_r):
        raise SystemExit(f"STOP: stored A rows do not match recomputed rows for {asset}: "
                         f"{int((~found).sum())} missing, {len(cs)} stored vs {len(code_r)} recomputed")
    src = order[pos]
    y_s = sub["y"].to_numpy()[src]
    if not np.array_equal(y_s.astype(float), R["y"]):
        raise SystemExit(f"STOP: stored y differs from recomputed y for {asset}")
    pa_s = sub["p_a"].to_numpy()[src]
    dmax = float(np.max(np.abs(pa_s - R["p_a"])))
    if dmax > 1e-10:
        raise SystemExit(f"STOP: stored p_a differs from recomputed (a) for {asset}: max |diff| {dmax}")
    for r in ("b", "c", "d"):
        R[f"p_{r}"] = sub[f"p_{r}"].to_numpy(dtype=float)[src]
    dnan = np.isfinite(R["p_d"])
    if not np.array_equal(dnan, R["in_d"]):
        raise SystemExit(f"STOP: stored p_d rows are not the rung (d) folds for {asset}")
    return {"rows_matched": int(len(code_r)), "max_abs_diff_p_a": dmax, "y_equal": True}


# ---------------------------------------------------------------------------------------------
# Scoring: bootstrap, BSS, confidence rule v2 (A2.4, A2.5)
# ---------------------------------------------------------------------------------------------
def boot_counts(rng, n_days, T_h, n_rep=N_BOOT):
    idx = A.block_bootstrap_indices(rng, n_days, A.block_length(T_h), n_rep)
    return idx, A.replicate_counts(idx, n_days)


def pct_with_inf(reps):
    """95% percentile interval keeping +inf (D-C2); NaN replicates are dropped."""
    reps = np.asarray(reps, float)
    reps = reps[~np.isnan(reps)]
    if len(reps) < 2:
        return None
    fin = np.where(np.isinf(reps), np.finfo(float).max, reps)
    lo, hi = np.percentile(fin, [2.5, 97.5])
    conv = lambda v: float("inf") if v >= np.finfo(float).max / 2 else float(v)  # noqa: E731
    return [conv(lo), conv(hi)]


def bss_ci(day_pos, n_days, pm, pb, y, counts):
    se_m = np.bincount(day_pos, weights=(pm - y) ** 2, minlength=n_days)
    se_b = np.bincount(day_pos, weights=(pb - y) ** 2, minlength=n_days)
    n = len(y)
    out = {"n_rows": int(n), "brier_model": float(se_m.sum() / n), "brier_base": float(se_b.sum() / n),
           "bss": float(1.0 - se_m.sum() / se_b.sum()) if se_b.sum() > 0 else None}
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (counts @ se_m) / (counts @ se_b)
    fin = np.isfinite(reps)
    out["n_nonfinite_reps"] = int((~fin).sum())
    if fin.sum() > 1:
        lo, hi = np.percentile(reps[fin], [2.5, 97.5])
        out.update(ci95=[float(lo), float(hi)], ci_above_0=bool(lo > 0), ci_below_0=bool(hi < 0))
    else:
        out.update(ci95=None, ci_above_0=False, ci_below_0=False)
    return out


def ratio_ci(day_pos, n_days, p, y, counts):
    """R = sum p / sum y and its block-bootstrap CI (D-C2)."""
    sp, sy = float(np.sum(p)), float(np.sum(y))
    R = (sp / sy) if sy > 0 else (float("inf") if sp > 0 else None)
    P = np.bincount(day_pos, weights=p, minlength=n_days)
    Yd = np.bincount(day_pos, weights=y, minlength=n_days)
    num, den = counts @ P, counts @ Yd
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = np.where(den > 0, num / np.where(den > 0, den, 1.0), np.where(num > 0, np.inf, np.nan))
    return R, pct_with_inf(reps)


def count_touch_episodes(t0_i, y):
    """D-C1: maximal runs of y = 1 over consecutive issue times (6 h apart) in time order."""
    t0_i = np.asarray(t0_i)
    y = np.asarray(y)
    if len(t0_i) == 0:
        return 0
    o = np.argsort(t0_i, kind="mergesort")
    t, yy = t0_i[o], y[o]
    pos = yy == 1
    start = pos.copy()
    start[1:] = pos[1:] & ~(pos[:-1] & (np.diff(t) == ISSUE_EVERY_H))
    return int(start.sum())


def fold_cells(fold_i, p, y, T_h):
    """(fold, level) coverage cells of one level: list of dicts with informative/covered flags (D-C3)."""
    cells = []
    for fi in np.unique(fold_i):
        m = fold_i == fi
        c = A.coverage_cell(y[m], p[m], T_h)
        c["fold_i"] = int(fi)
        c["informative"] = bool(c["pbar"] >= 1.0 / c["n_w"] or c["ybar"] > 0)
        cells.append(c)
    return cells


def cov_inf_of(cells):
    inf = [c for c in cells if c["informative"]]
    return (float(np.mean([c["covered"] for c in inf])) if inf else None), len(inf)


def label_v2(n_ep, R, R_ci, cov_inf, n_inf, stale):
    """A2.5. Returns HIGH / MEDIUM / LOW / insufficient / STALE."""
    if stale:
        return "STALE"
    Rf = R is not None and math.isfinite(R)
    if (n_ep >= HIGH_NEP and Rf and HIGH_R[0] <= R <= HIGH_R[1] and R_ci is not None
            and R_ci[0] >= HIGH_CI[0] and R_ci[1] <= HIGH_CI[1]
            and cov_inf is not None and n_inf >= HIGH_NINF and cov_inf >= HIGH_COV):
        return "HIGH"
    if n_ep >= MED_NEP and Rf and MED_R[0] <= R <= MED_R[1] and cov_inf is not None and cov_inf >= MED_COV:
        return "MEDIUM"
    if n_ep < MED_NEP:
        return "insufficient"
    return "LOW"


def stale_v2(R_recent, n_ep_recent, cov_inf_recent, n_inf_recent):
    a = n_ep_recent >= STALE_NEP and R_recent is not None and not (STALE_R[0] <= R_recent <= STALE_R[1])
    b = n_inf_recent >= STALE_NINF and cov_inf_recent is not None and cov_inf_recent < STALE_COV
    return bool(a or b), {"R_outside": bool(a), "cov_inf_low": bool(b)}


def level_stats(t0_i, fold_i, day_pos, n_days, p, y, counts, T_h, last_folds):
    """Everything A2.5 needs for one (asset, T, level, rung) on its rows."""
    n_ep = count_touch_episodes(t0_i, y)
    R, R_ci = ratio_ci(day_pos, n_days, p, y, counts)
    cells = fold_cells(fold_i, p, y, T_h)
    cov_inf, n_inf = cov_inf_of(cells)
    rec = np.isin(fold_i, list(last_folds))
    n_ep_r = count_touch_episodes(t0_i[rec], y[rec])
    sp, sy = float(p[rec].sum()), float(y[rec].sum())
    R_r = (sp / sy) if sy > 0 else (float("inf") if sp > 0 else None)
    cells_r = [c for c in cells if c["fold_i"] in last_folds]
    cov_inf_r, n_inf_r = cov_inf_of(cells_r)
    cov_r = float(np.mean([c["covered"] for c in cells_r])) if cells_r else None
    stale, why = stale_v2(R_r, n_ep_r, cov_inf_r, n_inf_r)
    lab = label_v2(n_ep, R, R_ci, cov_inf, n_inf, stale)
    return {"label": lab, "n_ep": n_ep, "R": R, "R_ci95": R_ci, "cov_inf": cov_inf, "n_inf_cells": n_inf,
            "n_cells": len(cells), "cov_all": float(np.mean([c["covered"] for c in cells])) if cells else None,
            "recent": {"n_ep": n_ep_r, "R": R_r, "cov_inf": cov_inf_r, "n_inf_cells": n_inf_r, "cov_recent": cov_r,
                       "stale": stale, **why},
            "n_rows": int(len(y)), "sum_p": float(p.sum()), "sum_y": float(y.sum()),
            "mean_p": float(p.mean()) if len(p) else None, "mean_y": float(y.mean()) if len(y) else None}


def day_positions(days, day_col):
    pos = np.searchsorted(days, day_col)
    assert np.all(days[np.clip(pos, 0, len(days) - 1)] == day_col)
    return pos


def score_cell(R, mask, days, counts, T_h, rungs, comps, last_folds):
    """Brier, BSS comparisons and v2 labels of one (asset, T, set)."""
    out = {"brier": {}, "comparisons": {}, "levels": {}}
    sel = {k: (v[mask] if isinstance(v, np.ndarray) else v) for k, v in R.items()}
    pos = day_positions(days, sel["day"])
    y = sel["y"]
    for r in rungs:
        p = sel.get(f"p_{r}")
        if p is None:
            continue
        m = np.isfinite(p)
        if m.any():
            out["brier"][r] = {"brier": float(np.mean((p[m] - y[m]) ** 2)), "n_rows": int(m.sum()),
                               "n_rows_undefined": int((~m).sum()), "mean_p": float(p[m].mean()),
                               "mean_y": float(y[m].mean())}
    for cname, rm, rb in comps:
        pm, pb = sel.get(f"p_{rm}"), sel.get(f"p_{rb}")
        if pm is None or pb is None:
            continue
        m = np.isfinite(pm) & np.isfinite(pb)
        if m.any():
            out["comparisons"][cname] = bss_ci(pos[m], len(days), pm[m], pb[m], y[m], counts)
    for j, k in enumerate(R["levels"]):
        mk = sel["k_i"] == j
        lv = {}
        for r in rungs:
            p = sel.get(f"p_{r}")
            if p is None:
                continue
            m = mk & np.isfinite(p)
            if not m.any():
                continue
            lv[r] = level_stats(sel["t0_i"][m], sel["fold_i"][m], pos[m], len(days), p[m], y[m], counts, T_h,
                                last_folds)
        out["levels"][repr(float(k))] = lv
    return out


def counts_of(R, mask, T_h):
    t0 = np.unique(R["t0_i"][mask])
    return {"n_rows": int(mask.sum()), "n_issue_times": int(len(t0)), "n_days": int(len(np.unique(R["day"][mask]))),
            "n_windows": A.n_windows(len(t0), T_h),
            "period": [iso(ts_of(t0.min())), iso(ts_of(t0.max()) + STEP * T_h)] if len(t0) else None}


# ---------------------------------------------------------------------------------------------
# Shipping (A2.6) and blind confirmation (A2.5)
# ---------------------------------------------------------------------------------------------
def label_counts(labels):
    out = {"HIGH": 0, "MEDIUM": 0, "LOW": 0, "insufficient": 0, "STALE": 0}
    for v in labels:
        out[v] += 1
    return out


def choose_shipped(pool, n_high, n_med, bss_vs_a, incumbent):
    """D-P2. pool: rungs in ladder order with 'a' first. Returns (rung, reason, literal_choice)."""
    key = {r: (n_high[r], n_med[r]) for r in pool}
    best = max(key.values())
    tied = [r for r in pool if key[r] == best]
    lit = sorted(pool, key=lambda r: (-n_high[r], -n_med[r],
                                      -(bss_vs_a.get(r) if bss_vs_a.get(r) is not None else 0.0),
                                      LADDER.index(r)))[0]
    if len(tied) == 1:
        return tied[0], "most confident (unique top by #HIGH then #MEDIUM)", lit
    if "a" in tied:
        return "a", f"label tie among {tied}: keeps the lower rung (a)", lit
    if incumbent in tied:
        return incumbent, f"label tie among {tied}: keeps the A shipped rung ({incumbent})", lit
    ch = sorted(tied, key=lambda r: (-(bss_vs_a.get(r) if bss_vs_a.get(r) is not None else -math.inf),
                                     LADDER.index(r)))
    return ch[0], f"label tie among challengers {tied}: higher BSS vs (a)", lit


def blind_check(R, n_ep):
    if n_ep is None or R is None:
        return "unconfirmed"
    if n_ep < BLIND_NEP:
        return "unconfirmed"
    return "pass" if BLIND_R[0] <= R <= BLIND_R[1] else "failed"


def confirm_high(asset, rung, dev_label, bspan, holdout):
    """D-B2. bspan / holdout: dicts {R, n_ep} or None (not scored). Returns (final_label, outcome)."""
    if dev_label != "HIGH":
        return dev_label, "not HIGH"
    if asset == "stETH":
        return "MEDIUM", "capped: no blind set"
    if rung not in BLIND_ALIAS:
        return "MEDIUM", "unconfirmed (rung not scored blind)"
    checks = []
    if asset in BSPAN_ASSETS:
        checks.append(blind_check(*(bspan["R"], bspan["n_ep"]) if bspan else (None, None)))
    checks.append(blind_check(*(holdout["R"], holdout["n_ep"]) if holdout else (None, None)))
    if "failed" in checks:
        return "MEDIUM", "failed blind"
    if "unconfirmed" in checks:
        return "MEDIUM", "unconfirmed"
    return "HIGH", "confirmed"


# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------
def write_json(path, obj, refuse_overwrite=False):
    A.write_json(path, obj, refuse_overwrite=refuse_overwrite)


def _f(v):
    return A._f(v)


def code_meta():
    here = os.path.abspath(__file__)
    import subprocess
    d = os.path.dirname(here)
    run = lambda *a: subprocess.run(["git", "-C", d, *a], capture_output=True, text=True).stdout.strip()  # noqa: E731
    return {"path": "scripts/research/history-forecasts/a2_touch.py", "sha256": A.sha256_file(here),
            "a_touch_sha256": A.sha256_file(os.path.join(d, "a_touch.py")),
            "git": {"head_commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
                    "a2_touch_last_commit": run("log", "-1", "--format=%H", "--", "a2_touch.py"),
                    "dirty_code_files": run("status", "--porcelain", "--", "a2_touch.py", "test_a2_touch.py",
                                            "a_touch.py").splitlines()}}


def env_meta(workers):
    import scipy
    import sklearn
    return {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
            "sklearn": sklearn.__version__, "workers": workers,
            "threads": {v: os.environ.get(v) for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")}}


FB = {0: "", 1: "cell", 2: "row", -1: ""}


def write_rows_csv(path, Rs_named, rungs):
    header = ["series", "t0", "fold", "T", "k", "y"] + [f"p_{r}" for r in rungs] + ["s_fallback", "s_d_fallback"]

    def gen():
        for name, R in Rs_named:
            fn = R["fold_names"]
            order = np.lexsort((R["k_i"], R["T_h"], R["t0_i"]))
            cols = {r: R.get(f"p_{r}") for r in rungs}
            for i in order:
                row = [name, iso(ts_of(R["t0_i"][i])), fn[int(R["fold_i"][i])], T_LABEL[int(R["T_h"][i])],
                       repr(float(R["k"][i])), int(R["y"][i])]
                row += [_f(cols[r][i]) if cols[r] is not None else "" for r in rungs]
                row += [FB[int(R["s_fb"][i])], FB[int(R["s_d_fb"][i])]]
                yield row
    A.write_csv_gz(path, header, gen())


def write_fits_csv(path, fits):
    h = ["series", "T", "fold", "rung", "n_train_origins", "n_rows", "n_pos", "fallback", "intercept", "coef",
         "mu", "sd", "n_iter", "converged"]
    rows = []
    for f in fits:
        rows.append([f["series"], T_LABEL[f["T_h"]], f["fold"], f["rung"], f.get("n_train_origins", ""),
                     f.get("n_rows", ""), f.get("n_pos", ""), f.get("fallback", ""), _f(f.get("intercept")),
                     json.dumps(f.get("coef")) if f.get("coef") is not None else "",
                     json.dumps(f.get("mu")) if f.get("mu") is not None else "",
                     json.dumps(f.get("sd")) if f.get("sd") is not None else "",
                     f.get("n_iter", ""), f.get("converged", "")])
    A.write_csv_gz(path, h, rows)


def fmt_display(p, label):
    return f"{A.fmt_p(p)} {label}"


# ---------------------------------------------------------------------------------------------
# Phase: dry run (counts only)
# ---------------------------------------------------------------------------------------------
def run_dryrun(datasets, out_dir, meta, log=print):
    path = os.path.join(out_dir, "dryrun.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    t0 = time.time()
    S = build_dev_series(datasets)
    B = build_blind_series(datasets)
    out = {"phase": "dryrun", "prereg": PREREG, "code": code_meta(), "inputs": meta,
           "note": "Data-only counts: training origins, test issue times, labelled rows, feature availability. "
                   "No label value, frequency, Brier, BSS or R is computed.", "dev": {}, "blind": {}}
    seen = set()
    for key, ser in list(S.items()) + list(B.items()):
        if id(ser) in seen:
            continue
        seen.add(id(ser))
        blind = key in B
        folds = blind_folds(ser) if blind else dev_folds(ser.asset)
        dn = set() if blind else d_fold_names(ser.asset)
        imask = issue_mask(ser.n_orig)
        r30 = ser.r30_all()
        sf = np.where(np.isfinite(ser.sigma))[0]
        s_out = {"start": iso(ts_of(ser.start_i)), "levels": list(ser.levels),
                 "folds": [f["name"] for f in folds],
                 "sigma_hat_first_defined": iso(ts_of(sf[0])) if len(sf) else None,
                 "null_close_hours": int(np.isnan(ser.close[ser.start_i:]).sum()),
                 "null_low_hours": int(np.isnan(ser.low[ser.start_i:]).sum()), "per_T": {}}
        if ser.sigma_dvol is not None:
            dfin = np.where(np.isfinite(ser.sigma_dvol))[0]
            s_out["dvol_first_origin"] = iso(ts_of(dfin[0])) if len(dfin) else None
        for T_h in HORIZONS_H:
            lab_ok = np.isfinite(ser.spot) & np.isfinite(ser.wmin(T_h))   # null mask only, no label value
            per_fold = {}
            for f in folds:
                i = np.arange(ser.n_orig)
                tr = lab_ok & (i + T_h <= f["qs_i"])
                te = test_issue_times(f["qs_i"], f["qe_i"], ser.n_orig, imask)
                te_l = te[lab_ok[te]]
                rec = {"n_train_a": int(tr.sum()), "n_train_f": int((tr & np.isfinite(ser.sigma)).sum()),
                       "n_test_issue_times": int(len(te)), "n_test_labelled": int(len(te_l)),
                       "test_sigma_hat_defined": int(np.isfinite(ser.sigma[te]).sum()),
                       "test_r30_defined": int(np.isfinite(r30[te]).sum()),
                       "train_first": iso(ts_of(np.where(tr)[0][0])) if tr.any() else None}
                if f["name"] in dn and ser.sigma_dvol is not None:
                    rec["n_train_fd"] = int((tr & np.isfinite(ser.sigma_dvol)).sum())
                    rec["test_dvol_defined"] = int(np.isfinite(ser.sigma_dvol[te]).sum())
                per_fold[f["name"]] = rec
            s_out["per_T"][T_LABEL[T_h]] = {
                "per_fold": per_fold,
                "n_test_rows": int(sum(v["n_test_labelled"] for v in per_fold.values()) * len(ser.levels))}
        (out["blind"] if blind else out["dev"])[key] = s_out
        log(f"dryrun {key}")
    out["runtime_seconds"] = round(time.time() - t0, 1)
    write_json(path, out, refuse_overwrite=True)
    return out


# ---------------------------------------------------------------------------------------------
# Phase: development span (scored ONCE)
# ---------------------------------------------------------------------------------------------
def a_shipped_rungs(datasets):
    with open(os.path.join(datasets, A_STORED["results"][0])) as f:
        res = json.load(f)
    return {a: {T_LABEL[T]: res["primary"][a]["per_T"][T_LABEL[T]]["shipped_rung"] for T in HORIZONS_H}
            for a in DEV_ASSETS}


def run_dev(datasets, out_dir, meta, workers=4, log=print):
    rpath = os.path.join(out_dir, "results-dev.json")
    for p in (rpath, os.path.join(out_dir, "shipped-dev.json")):
        if os.path.exists(p):
            raise SystemExit(f"STOP: {p} exists. The development span is scored once.")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
    global _SER
    _SER = build_dev_series(datasets)
    log(f"series built {time.time() - t_start:.0f}s")
    tasks = [(a, T) for a in DEV_ASSETS for T in HORIZONS_H]
    outs = run_pool(dev_task, tasks, workers, log, t_start)
    t_fit = time.time() - t_start
    df = load_stored_a(os.path.join(datasets, A_STORED["pred"][0]))
    incumbent = a_shipped_rungs(datasets)
    Rs, fits_all, data_end, merge_meta = {}, [], {}, {}
    for a in DEV_ASSETS:
        lser = _SER[f"long:{a}"]
        oser = _SER[f"oracle:{a}"]
        rungs = FITTED
        R, fits, de = assemble(lser, dev_folds(a), {T: outs[(a, T)] for T in HORIZONS_H}, rungs,
                               d_names=d_fold_names(a), y_check_ser=None if oser is lser else oser)
        merge_meta[a] = merge_stored(R, df, a)
        Rs[a], data_end[a] = R, de
        fits_all += fits
    log(f"assembled ({time.time() - t_start:.0f}s); scoring")
    # bootstrap draws, registered order (D-C5)
    rng = np.random.default_rng(SEED_DEV)
    results = {}
    boot_meta = {}
    for a in DEV_ASSETS:
        R = Rs[a]
        fn = R["fold_names"]
        last_folds = set(range(len(fn) - STALE_FOLDS, len(fn)))
        per_T = {}
        for T_h in HORIZONS_H:
            cell = {}
            mT = R["T_h"] == T_h
            for s in ("full", "d"):
                if s == "d" and a not in D_ASSETS:
                    continue
                m = mT & (R["in_d"] if s == "d" else True)
                days = np.unique(R["day"][m])
                idx, cnt = boot_counts(rng, len(days), T_h)
                boot_meta[f"{a}|{T_LABEL[T_h]}|{s}"] = {
                    "n_days": int(len(days)), "block_length": A.block_length(T_h),
                    "first_day": iso(int(days[0]) * DAY), "last_day": iso(int(days[-1]) * DAY),
                    "idx_sha256": hashlib.sha256(np.ascontiguousarray(idx, dtype=np.int64).tobytes()).hexdigest()}
                rungs = (FULL_RUNGS if s == "full" else ("a", "f", "s") + D_RUNGS)
                comps = DEV_COMPARISONS_FULL if s == "full" else DEV_COMPARISONS_D
                sc = score_cell(R, m, days, cnt, T_h, rungs, comps, last_folds)
                sc["counts"] = counts_of(R, m, T_h)
                cell[s] = sc
                log(f"  scored {a} {T_LABEL[T_h]} {s} days={len(days)} ({time.time() - t_start:.0f}s)")
            per_T[T_LABEL[T_h]] = cell
        results[a] = per_T
    # labels per rung, eligibility, shipping
    shipped = {}
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            cell = results[a][TL]
            lab = {}
            for s, rr in (("full", FULL_RUNGS), ("d", D_RUNGS)):
                if s not in cell:
                    continue
                for r in rr:
                    lab[r] = {k: cell[s]["levels"][k][r]["label"] for k in cell[s]["levels"]
                              if r in cell[s]["levels"][k]}
            comps = dict(cell["full"]["comparisons"])
            if "d" in cell:
                comps.update(cell["d"]["comparisons"])
            bss_a = {"a": 0.0}
            elig = {"a": True}
            for r in ("a_long", "f", "s", "b", "c", "r30", "r90", "fd", "s_d", "d"):
                c = comps.get(f"{r}_vs_a")
                bss_a[r] = c["bss"] if c else None
                elig[r] = bool(c and c["ci_above_0"])
            inc = incumbent[a][TL]
            pool = ["a"] + ([inc] if inc != "a" else []) + [r for r in CANDIDATES[1:] if elig.get(r) and r in lab]
            n_high = {r: sum(v == "HIGH" for v in lab[r].values()) for r in pool}
            n_med = {r: sum(v == "MEDIUM" for v in lab[r].values()) for r in pool}
            ship, why, lit = choose_shipped(pool, n_high, n_med, bss_a, inc)
            cell["eligibility"] = {r: {"eligible": elig.get(r, False), "bss_vs_a": bss_a.get(r),
                                       "ci95": (comps.get(f"{r}_vs_a") or {}).get("ci95")}
                                   for r in ("a_long", "f", "fd", "s", "s_d", "b", "c", "d", "r30", "r90")}
            cell["labels_by_rung"] = lab
            cell["label_counts_by_rung"] = {r: label_counts(v.values()) for r, v in lab.items()}
            cell["shipping"] = {"a_shipped_rung": inc, "pool": pool, "n_high": n_high, "n_medium": n_med,
                                "bss_vs_a": {r: bss_a.get(r) for r in pool}, "shipped_rung": ship, "reason": why,
                                "literal_lexicographic_choice": lit, "literal_differs": lit != ship}
            shipped.setdefault(a, {})[TL] = ship
    # displayed numbers at DATA_END (frozen data) for the shipped rung
    need_a = {(a, TL) for a in shipped for TL, r in shipped[a].items() if r in ("b", "c", "d")}
    a_grids = a_rung_grids_frozen(datasets, need_a) if need_a else {}
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            ti = HORIZONS_H.index(T_h)
            cell = results[a][TL]
            ship = shipped[a][TL]
            g = a_grids[(a, ship)] if ship in ("b", "c", "d") else data_end[a].get(ship)
            s = "d" if ship in D_RUNGS else "full"
            disp = {}
            for j, k in enumerate(LEVELS[a]):
                kk = repr(float(k))
                st = cell[s]["levels"][kk][ship]
                p = float(g[ti, j]) if g is not None else None
                disp[kk] = {"p_data_end": p, "label_dev": st["label"],
                            "display_dev": fmt_display(p, st["label"]) if p is not None else None,
                            "n_ep": st["n_ep"], "R": st["R"], "R_ci95": st["R_ci95"], "cov_inf": st["cov_inf"],
                            "n_inf_cells": st["n_inf_cells"], "cov_recent": st["recent"]["cov_recent"]}
            cell["shipped_display_data_end"] = disp
            cell["p_data_end_all_rungs"] = {r: (data_end[a][r][ti].tolist() if r in data_end[a] else None)
                                            for r in FITTED}
    # predictions + fits
    for a in DEV_ASSETS:   # one file per asset (each < 50 MB)
        write_rows_csv(os.path.join(out_dir, f"predictions-dev-{a}.csv.gz"), [(a, Rs[a])],
                       ("a", "a_long", "f", "s", "r30", "r90", "fd", "s_d", "b", "c", "d"))
    write_fits_csv(os.path.join(out_dir, "fits-dev.csv.gz"), fits_all)
    fb = {}
    for f in fits_all:
        key = f"{f['series']}|{T_LABEL[f['T_h']]}|{f['rung']}"
        d = fb.setdefault(key, {"fits": 0, "fallback": 0, "not_converged": 0})
        d["fits"] += 1
        d["fallback"] += int(bool(f.get("fallback")))
        d["not_converged"] += int((not f.get("fallback")) and not f.get("converged", True))
    row_fb = {}
    for a in DEV_ASSETS:
        R = Rs[a]
        for T_h in HORIZONS_H:
            m = R["T_h"] == T_h
            row_fb[f"{a}|{T_LABEL[T_h]}"] = {"s_row_fallback_rows": int((R["s_fb"][m] == 2).sum()),
                                             "s_cell_fallback_rows": int((R["s_fb"][m] == 1).sum()),
                                             "s_d_row_fallback_rows": int((R["s_d_fb"][m] == 2).sum()),
                                             "s_d_cell_fallback_rows": int((R["s_d_fb"][m] == 1).sum())}
    summary_counts = {a: {TL: {"before_blind": label_counts(
        [results[a][TL]["d" if shipped[a][TL] in D_RUNGS else "full"]["levels"][repr(float(k))][shipped[a][TL]]["label"]
         for k in LEVELS[a]])} for TL in results[a]} for a in DEV_ASSETS}
    doc = {
        "test": "Q26 workstream A2 -- development span", "prereg": PREREG, "code": code_meta(), "inputs": meta,
        "environment": env_meta(workers),
        "constants": {"base_ts": iso(BASE_TS), "data_end": iso(DATA_END), "splice": {k: iso(v) for k, v in SPLICE_TS.items()},
                      "sigma_half_life_h": SIGMA_HALF_LIFE_H, "sigma_warmup_returns": SIGMA_WARMUP,
                      "feat_clip": FEAT_CLIP, "s_half_life_days": S_HALF_LIFE_D, "logistic": LOGIT_KW,
                      "n_boot": N_BOOT, "seed": SEED_DEV, "label_rule": {
                          "HIGH": {"n_ep": HIGH_NEP, "R": HIGH_R, "R_ci_inside": HIGH_CI, "cov_inf": HIGH_COV,
                                   "min_inf_cells": HIGH_NINF},
                          "MEDIUM": {"n_ep": MED_NEP, "R": MED_R, "cov_inf": MED_COV},
                          "STALE": {"last_folds": STALE_FOLDS, "R": STALE_R, "n_ep": STALE_NEP, "cov_inf": STALE_COV,
                                    "min_inf_cells": STALE_NINF}}},
        "DECISIONS": DECISIONS,
        "deviations_prereg": ["D1 (f4e66b2): every cell shows its number beside its label; locked final blind set "
                              "not read.", "D2 (f97216f): BTC long history spliced before 2020-01-01T00:00Z from "
                                           "2017-08-17T04:00Z; (a_long), (f), (s) use it for ETH and BTC."],
        "deviations_run": [],
        "stored_a_merge": merge_meta,
        "bootstrap": boot_meta,
        "per_asset": results,
        "shipped": shipped, "shipped_file": {"file": "shipped-dev.json", "sha256": None},
        "label_counts_shipped": summary_counts,
        "fit_fallbacks": fb, "row_fallbacks": row_fb,
        "notes": {"deciding": "Eligibility = BSS vs (a) CI lower bound > 0 on the development span (A2.4). The "
                              "shipped rung is chosen by A2.6 (D-P2) from the dev labels before any blind score.",
                  "bss": "BSS(r vs base) = 1 - Brier_r / Brier_base on rows where both exist; d-set comparisons on "
                         "the rung (d) folds (2022Q2..2026Q3)."},
        "run": {"started_utc": started, "fit_predict_seconds": round(t_fit, 1),
                "total_seconds": round(time.time() - t_start, 1),
                "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
    }
    doc["shipped_file"]["sha256"] = _write_frozen(out_dir, shipped)
    write_json(rpath, doc, refuse_overwrite=True)
    log(f"results-dev written ({time.time() - t_start:.0f}s)")
    return doc


def _write_frozen(out_dir, shipped):
    """Frozen shipped rung per cell (written once, after every dev score is computed, before results-dev)."""
    shipped_doc = {"what": "Q26 A2 shipped rung per (asset, T), fixed on the development span before any blind "
                           "score (A2.6, D-P1, D-P2)", "prereg": PREREG, "shipped": shipped,
                   "fixed_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    spath = os.path.join(out_dir, "shipped-dev.json")
    write_json(spath, shipped_doc, refuse_overwrite=True)
    ssha = A.sha256_file(spath)
    with open(spath + ".sha256", "w") as f:
        f.write(f"{ssha}  shipped-dev.json\n")
    return ssha


def a_rung_grids_frozen(datasets, need):
    """Refit A rungs b/c/d at DATA_END on frozen data exactly as A's panel (a_touch.fit_predict_fold)."""
    S = A.build_series(datasets)
    out = {}
    for a in sorted({x[0] for x in need}):
        ser = S[f"oracle:{a}"]
        N = ser.N
        g = {r: np.full((len(HORIZONS_H), len(ser.levels)), np.nan) for r in ("a", "b", "c", "d")}
        for ti, T_h in enumerate(HORIZONS_H):
            o = A.fit_predict_fold(ser, T_h, N, np.array([N]), in_d=a in A.D_ASSETS)
            for r in g:
                if r in o["raw"]:
                    g[r][ti] = o["raw"][r][0]
        for r in ("b", "c", "d"):
            if not np.isnan(g[r]).any():
                out[(a, r)] = A.monotone_fix(g[r][None])[0]
    return out


# ---------------------------------------------------------------------------------------------
# Phase: blind sets (scored ONCE, after the shipped rung is frozen)
# ---------------------------------------------------------------------------------------------
def run_blind(datasets, out_dir, meta, workers=4, log=print):
    bpath = os.path.join(out_dir, "results-blind.json")
    if os.path.exists(bpath):
        raise SystemExit(f"STOP: {bpath} exists. The blind sets are scored once.")
    spath = os.path.join(out_dir, "shipped-dev.json")
    dpath = os.path.join(out_dir, "results-dev.json")
    if not (os.path.exists(spath) and os.path.exists(dpath)):
        raise SystemExit("STOP: the frozen shipped-dev.json and results-dev.json must exist before the blind run.")
    with open(dpath) as f:
        dev = json.load(f)
    ssha = A.sha256_file(spath)
    if ssha != dev["shipped_file"]["sha256"]:
        raise SystemExit(f"STOP: shipped-dev.json sha256 {ssha} != recorded {dev['shipped_file']['sha256']}")
    with open(spath) as f:
        shipped = json.load(f)["shipped"]
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
    global _SER
    _SER = build_blind_series(datasets)
    keys = [f"bspan:{a}" for a in BSPAN_ASSETS] + [f"holdout:{p}" for p in HOLDOUTS]
    tasks = [(k, T) for k in keys for T in HORIZONS_H]
    outs = run_pool(blind_task, tasks, workers, log, t_start)
    Rs, fits_all = {}, []
    for k in keys:
        ser = _SER[k]
        R, fits, _ = assemble(ser, blind_folds(ser), {T: outs[(k, T)] for T in HORIZONS_H}, BLIND_RUNGS)
        Rs[k] = R
        fits_all += fits
    log(f"assembled ({time.time() - t_start:.0f}s); scoring")
    rng = np.random.default_rng(SEED_BLIND)
    per_series = {}
    boot_meta = {}
    for k in keys:
        R = Rs[k]
        fn = R["fold_names"]
        last_folds = set(range(len(fn) - STALE_FOLDS, len(fn)))
        per_T = {}
        for T_h in HORIZONS_H:
            m = R["T_h"] == T_h
            days = np.unique(R["day"][m])
            idx, cnt = boot_counts(rng, len(days), T_h)
            boot_meta[f"{k}|{T_LABEL[T_h]}"] = {
                "n_days": int(len(days)), "block_length": A.block_length(T_h),
                "first_day": iso(int(days[0]) * DAY), "last_day": iso(int(days[-1]) * DAY),
                "idx_sha256": hashlib.sha256(np.ascontiguousarray(idx, dtype=np.int64).tobytes()).hexdigest()}
            sc = score_cell(R, m, days, cnt, T_h, BLIND_RUNGS, BLIND_COMPARISONS, last_folds)
            sc["counts"] = counts_of(R, m, T_h)
            per_T[T_LABEL[T_h]] = sc
            log(f"  scored {k} {T_LABEL[T_h]} days={len(days)} ({time.time() - t_start:.0f}s)")
        per_series[k] = {"folds": fn, "per_T": per_T}
    # pooled holdouts: union of dates, drawn after every per-asset draw (D-B1)
    hk = [f"holdout:{p}" for p in HOLDOUTS]
    pooled = {}
    for T_h in HORIZONS_H:
        TL = T_LABEL[T_h]
        parts = [Rs[k] for k in hk]
        days = np.unique(np.concatenate([P["day"][P["T_h"] == T_h] for P in parts]))
        idx, cnt = boot_counts(rng, len(days), T_h)
        boot_meta[f"POOLED_HOLDOUTS|{TL}"] = {
            "n_days": int(len(days)), "block_length": A.block_length(T_h),
            "idx_sha256": hashlib.sha256(np.ascontiguousarray(idx, dtype=np.int64).tobytes()).hexdigest()}
        cat = {c: np.concatenate([P[c][P["T_h"] == T_h] for P in parts])
               for c in ("day", "y", "k_i") + tuple(f"p_{r}" for r in BLIND_RUNGS)}
        pos = day_positions(days, cat["day"])
        comps = {}
        for cname, rm, rb in BLIND_COMPARISONS:
            mm = np.isfinite(cat[f"p_{rm}"]) & np.isfinite(cat[f"p_{rb}"])
            comps[cname] = bss_ci(pos[mm], len(days), cat[f"p_{rm}"][mm], cat[f"p_{rb}"][mm], cat["y"][mm], cnt)
        brier = {r: float(np.mean((cat[f"p_{r}"][np.isfinite(cat[f"p_{r}"])] - cat["y"][np.isfinite(cat[f"p_{r}"])]) ** 2))
                 for r in BLIND_RUNGS}
        levels = {}
        for j, kv in enumerate(HOLDOUT_LEVELS):
            lv = {}
            for r in BLIND_RUNGS:
                mk = (cat["k_i"] == j) & np.isfinite(cat[f"p_{r}"])
                Rr, ci = ratio_ci(pos[mk], len(days), cat[f"p_{r}"][mk], cat["y"][mk], cnt)
                n_ep = sum(per_series[k]["per_T"][TL]["levels"][repr(float(kv))][r]["n_ep"] for k in hk
                           if r in per_series[k]["per_T"][TL]["levels"][repr(float(kv))])
                lv[r] = {"R": Rr, "R_ci95": ci, "n_ep": int(n_ep), "n_rows": int(mk.sum()),
                         "sum_p": float(cat[f"p_{r}"][mk].sum()), "sum_y": float(cat["y"][mk].sum())}
            levels[repr(float(kv))] = lv
        pooled[TL] = {"comparisons": comps, "brier": brier, "levels": levels, "n_days": int(len(days)),
                      "n_rows": int(len(cat["y"]))}
    # blind confirmation of every HIGH cell (dev labels), every rung
    confirm, labels_rows = {}, []
    counts_after = {}
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            cell = dev["per_asset"][a][TL]
            for s, rr in (("full", FULL_RUNGS), ("d", D_RUNGS)):
                if s not in cell:
                    continue
                for kk, lvd in cell[s]["levels"].items():
                    for r in rr:
                        if r not in lvd:
                            continue
                        st = lvd[r]
                        br = BLIND_ALIAS.get(r)
                        bsp = hol = None
                        if br is not None and a in BSPAN_ASSETS:
                            b = per_series[f"bspan:{a}"]["per_T"][TL]["levels"].get(kk, {}).get(br)
                            bsp = {"R": b["R"], "n_ep": b["n_ep"]} if b else None
                        if br is not None and a != "stETH":
                            h = pooled[TL]["levels"].get(kk, {}).get(br)
                            hol = {"R": h["R"], "n_ep": h["n_ep"]} if h else None
                        final, outcome = confirm_high(a, r, st["label"], bsp, hol)
                        ship = shipped[a][TL] == r
                        if st["label"] == "HIGH":
                            confirm.setdefault(a, {}).setdefault(TL, {}).setdefault(kk, {})[r] = {
                                "outcome": outcome, "final_label": final, "bspan": bsp, "holdout_pooled": hol,
                                "shipped": ship}
                        labels_rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "set": s,
                                            "shipped": ship, "dev_label": st["label"], "blind_outcome": outcome,
                                            "final_label": final, "n_ep": st["n_ep"], "R": st["R"],
                                            "R_lo": (st["R_ci95"] or [None, None])[0],
                                            "R_hi": (st["R_ci95"] or [None, None])[1], "cov_inf": st["cov_inf"],
                                            "n_inf_cells": st["n_inf_cells"],
                                            "blind_bspan_R": bsp["R"] if bsp else None,
                                            "blind_bspan_n_ep": bsp["n_ep"] if bsp else None,
                                            "blind_holdout_R": hol["R"] if hol else None,
                                            "blind_holdout_n_ep": hol["n_ep"] if hol else None})
    final_ship = {}
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            ship = shipped[a][TL]
            rows = [r for r in labels_rows if r["asset"] == a and r["T"] == TL and r["rung"] == ship]
            final_ship.setdefault(a, {})[TL] = {"rung": ship, "labels": {repr(r["k"]): r["final_label"] for r in rows},
                                               "outcomes": {repr(r["k"]): r["blind_outcome"] for r in rows}}
            counts_after.setdefault(a, {})[TL] = {"before_blind": label_counts([r["dev_label"] for r in rows]),
                                                 "after_blind": label_counts([r["final_label"] for r in rows])}
    write_csv_labels(os.path.join(out_dir, "labels.csv"), labels_rows)
    for k in keys:
        write_rows_csv(os.path.join(out_dir, f"predictions-blind-{k.replace(':', '-')}.csv.gz"), [(k, Rs[k])],
                       BLIND_RUNGS)
    write_fits_csv(os.path.join(out_dir, "fits-blind.csv.gz"), fits_all)
    r_undef = {k: {T_LABEL[T]: {r: int((~np.isfinite(Rs[k][f"p_{r}"][Rs[k]["T_h"] == T])).sum())
                               for r in ("r30", "r90")} for T in HORIZONS_H} for k in keys}
    s_fb = {k: {T_LABEL[T]: {"s_row_fallback_rows": int((Rs[k]["s_fb"][Rs[k]["T_h"] == T] == 2).sum()),
                             "s_cell_fallback_rows": int((Rs[k]["s_fb"][Rs[k]["T_h"] == T] == 1).sum())}
                for T in HORIZONS_H} for k in keys}
    doc = {"test": "Q26 workstream A2 -- blind sets (B-span, holdout assets)", "prereg": PREREG, "code": code_meta(),
           "inputs": meta, "environment": env_meta(workers), "DECISIONS": DECISIONS,
           "deviations_run": [],
           "dev_results_sha256": A.sha256_file(dpath), "shipped_file": {"file": "shipped-dev.json", "sha256": ssha},
           "shipped": shipped, "bootstrap": boot_meta, "seed": SEED_BLIND,
           "per_series": per_series, "pooled_holdouts": pooled,
           "blind_confirmation": confirm, "final_shipped_labels": final_ship,
           "label_counts_shipped": counts_after,
           "label_counts_all_rungs": label_totals(labels_rows),
           "ref_undefined_rows": r_undef, "s_fallback_rows": s_fb,
           "run": {"started_utc": started, "total_seconds": round(time.time() - t_start, 1),
                   "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}}
    write_json(bpath, doc, refuse_overwrite=True)
    log(f"results-blind written ({time.time() - t_start:.0f}s)")
    return doc


def label_totals(rows):
    out = {}
    for r in rows:
        d = out.setdefault(r["asset"], {}).setdefault(r["T"], {}).setdefault(r["rung"], {"dev": [], "final": []})
        d["dev"].append(r["dev_label"])
        d["final"].append(r["final_label"])
    return {a: {T: {rg: {"dev": label_counts(v["dev"]), "final": label_counts(v["final"])} for rg, v in d2.items()}
                for T, d2 in d1.items()} for a, d1 in out.items()}


def write_csv_labels(path, rows):
    h = ["asset", "T", "k", "rung", "set", "shipped", "dev_label", "blind_outcome", "final_label", "n_ep", "R",
         "R_lo", "R_hi", "cov_inf", "n_inf_cells", "blind_bspan_R", "blind_bspan_n_ep", "blind_holdout_R",
         "blind_holdout_n_ep"]
    A.write_csv(path, h, rows)


# ---------------------------------------------------------------------------------------------
# Phase: panel (A.8 with A2 rungs and v2 labels; D1 display)
# ---------------------------------------------------------------------------------------------
LABEL_RANK = {"HIGH": 3, "MEDIUM": 2, "LOW": 1, "insufficient": 1, "STALE": 0}


def worse_label(a, b):
    return a if LABEL_RANK[a] <= LABEL_RANK[b] else b


def bracket_levels(levels, y, tol=1e-9):
    """The grid levels the logit interpolation at distance y uses; y within tol of a level -> that level only."""
    for k in levels:
        if abs(y - k) <= tol:
            return k, k
    if y >= levels[0]:
        return levels[0], levels[0]
    if y <= levels[-1]:
        return levels[-1], levels[-1]
    for i in range(len(levels) - 1):
        if levels[i] >= y >= levels[i + 1]:
            return levels[i], levels[i + 1]
    return levels[-1], levels[-1]


def run_panel(datasets, out_dir, meta, try_rpc=True, log=print):
    path = os.path.join(out_dir, "panel.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    warnings.filterwarnings("ignore", category=FutureWarning, message=".*penalty.*")
    with open(os.path.join(out_dir, "results-dev.json")) as f:
        dev = json.load(f)
    bpath = os.path.join(out_dir, "results-blind.json")
    with open(bpath) as f:
        blind = json.load(f)
    spath = os.path.join(out_dir, "shipped-dev.json")
    if A.sha256_file(spath) != dev["shipped_file"]["sha256"]:
        raise SystemExit("STOP: shipped-dev.json sha256 mismatch")
    shipped = dev["shipped"]
    final = blind["final_shipped_labels"]
    S = build_dev_series(datasets)
    panel = {"phase": "panel", "prereg": PREREG, "code": code_meta(), "inputs": meta,
             "results_dev_sha256": A.sha256_file(os.path.join(out_dir, "results-dev.json")),
             "results_blind_sha256": A.sha256_file(bpath), "shipped_sha256": dev["shipped_file"]["sha256"],
             "fit": "each shipped rung refit once on all labelled origins with t + T <= DATA_END; features at asof "
                    "from the live Chainlink splice (sigma_hat, RV30) and a live Deribit DVOL candle",
             "display_rule": "D1: every cell shows its number beside its final label (after blind confirmation)",
             "assets": {}}
    asof_info = {"data_end": iso(DATA_END), "source": "dataset", "asof": iso(DATA_END)}
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
                r_end, r_asof = A.answer_in_force(rounds, DATA_END), A.answer_in_force(rounds, asof_ts)
                live[a] = {"description": dtxt, "decimals": dec,
                           "in_force_at_data_end": {"roundId": str(r_end["roundId"]), "updatedAt": r_end["updatedAt"],
                                                    "price": r_end["answer"] / 10 ** dec},
                           "in_force_at_asof": {"roundId": str(r_asof["roundId"]), "updatedAt": r_asof["updatedAt"],
                                                "updatedAt_iso": iso(r_asof["updatedAt"]),
                                                "price": r_asof["answer"] / 10 ** dec},
                           "n_rounds_after_data_end": int(sum(r["updatedAt"] > DATA_END for r in rounds))}
            asof_info = {"data_end": iso(DATA_END), "source": "chainlink getRoundData via public RPC",
                         "asof": iso(asof_ts), "rpc_calls": rpc.calls, "rpc_errors": rpc.errors, "read_at_utc": iso(now)}
        except Exception as e:
            asof_info["rpc_failed"] = f"{type(e).__name__}: {e}"
            live, live_rounds = {}, {}
    panel["asof"] = asof_info
    panel["live_chainlink"] = live
    asof_ts = A.utc(asof_info["asof"])
    if live_rounds:
        rp = os.path.join(out_dir, "panel-chainlink-rounds.csv.gz")
        n_r = A.write_rounds_csv(rp, live, live_rounds, asof_ts)
        panel["chainlink_rounds_file"] = {"file": "panel-chainlink-rounds.csv.gz", "rows": n_r, "sha256": A.sha256_file(rp)}
    grids_all = {}
    for a in DEV_ASSETS:
        ser = S[f"long:{a}"]
        need = set(shipped[a].values())
        # features at asof from the live splice (closes after DATA_END = answer in force at each hour end)
        if a in live_rounds and asof_ts > DATA_END:
            dec = A.FEEDS[a][1]
            ends = np.arange(DATA_END + STEP, asof_ts + 1, STEP)
            ext = np.array([A.answer_in_force(live_rounds[a], int(e))["answer"] / 10 ** dec for e in ends])
            cx = np.concatenate([ser.close, ext])
            src = "live Chainlink splice"
        else:
            ext = np.array([])
            cx = ser.close
            src = "frozen dataset (no live closes)"
        sig_x = ewma_sigma(cx)
        i_asof = len(cx)
        te_sigma = sig_x[i_asof]
        te_r30 = A.ref_daily_sigma(cx, np.array([i_asof]), 30)[0]
        te_r90 = A.ref_daily_sigma(cx, np.array([i_asof]), 90)[0]
        dv = None
        if need & {"fd", "s_d"}:
            dv = A.fetch_dvol_candle(a, asof_ts - STEP) if asof_ts > DATA_END else None
        te_sd = (dv["close"] / 100.0) if dv else (ser.sigma_dvol[N_H] if ser.sigma_dvol is not None else np.nan)
        feat = {"features_at": iso(asof_ts if len(ext) else DATA_END), "source": src, "live_hours_spliced": int(len(ext)),
                "sigma_hat": float(te_sigma), "rv30": float(te_r30), "rv90": float(te_r90),
                "dvol": dv if dv else ({"candle_open": iso(DATA_END - STEP), "close": float(te_sd * 100),
                                        "source": "frozen dataset"} if need & {"fd", "s_d"} else None)}
        grids = {}
        for ti, T_h in enumerate(HORIZONS_H):
            P = PrepT(ser, T_h, asof=True, with_fd=a in D_ASSETS)
            rungs = ("f", "s", "r30", "r90") + (("fd", "s_d") if a in D_ASSETS else ())
            o = predict_fold(ser, P, T_h, N_H, np.array([N_H]), a in D_ASSETS, rungs, te_sigma=[te_sigma],
                             te_sigma_dvol=[te_sd], te_r30=[te_r30], te_r90=[te_r90])
            o["raw"]["a_long"] = o["raw"].pop("a")
            Po = PrepT(S[f"oracle:{a}"], T_h, asof=False)
            o["raw"]["a"] = Po.freq_upto(N_H - T_h)[None, :]
            for r, v in o["raw"].items():
                grids.setdefault(r, np.full((len(HORIZONS_H), len(ser.levels)), np.nan))[ti] = v[0]
        fixed = {r: A.monotone_fix(g[None])[0] for r, g in grids.items() if not np.isnan(g).any()}
        if need & {"b", "c", "d"}:
            fixed.update(a_rung_grids_live(datasets, a, live_rounds.get(a), asof_ts, dv))
        grids_all[a] = fixed
        cells = {}
        for ti, T_h in enumerate(HORIZONS_H):
            TL = T_LABEL[T_h]
            ship = shipped[a][TL]
            row = {"shipped_rung": ship, "levels": {}}
            for j, k in enumerate(ser.levels):
                kk = repr(float(k))
                lab = final[a][TL]["labels"][kk]
                p = float(fixed[ship][ti, j])
                hc = history_count_g(ser, T_h, j)
                row["levels"][kk] = {"p": p, "label": lab, "display": fmt_display(p, lab),
                                     "blind_outcome": final[a][TL]["outcomes"][kk], "history_count": hc}
            cells[TL] = row
        panel["assets"][a] = {"cells": cells, "feature_note": feat,
                              "grids_fixed_all_rungs": {r: g.tolist() for r, g in fixed.items()}}
    # ETH ACTION example (A.8), labelled (D-D2)
    lv = list(LEVELS["ETH"])
    if "ETH" in live:
        Sx = live["ETH"]["in_force_at_asof"]["price"]
        s_src = f"Chainlink ETH/USD in force at asof {asof_info['asof']}"
    else:
        Sx = float(S["oracle:ETH"].close[N_H - 1])
        s_src = f"dataset oracle close at DATA_END {iso(DATA_END)}"
    C, LT = A.EXAMPLE["collateral_units"], A.EXAMPLE["LT"]
    D = C * LT * Sx * (1.0 + A.EXAMPLE["line_distance"])
    y_now = D / (C * LT) / Sx - 1.0
    ti7 = HORIZONS_H.index(A.ACTION_T_H)
    ship7 = shipped["ETH"]["7d"]
    probs7 = [float(v) for v in grids_all["ETH"][ship7][ti7]]
    lab7 = final["ETH"]["7d"]["labels"]
    rows = A.action_rows(lv, probs7, D, C, LT, Sx, y_now=y_now)
    for r in rows:
        y_t = r.get("y_star", r.get("line_after"))
        if y_t is None:
            y_t = lv[0] if r["status"] == "shallower_than_grid" else lv[-1]
        k0, k1 = bracket_levels(lv, y_t)
        r["label"] = worse_label(lab7[repr(float(k0))], lab7[repr(float(k1))])
        r["label_levels"] = [k0, k1]
        r["display"] = f"{r['text']} [{r['label']}]"
    cur = {}
    for ti, T_h in enumerate(HORIZONS_H):
        TL = T_LABEL[T_h]
        shipT = shipped["ETH"][TL]
        pT = [float(v) for v in grids_all["ETH"][shipT][ti]]
        p, st = A.p_at_distance(lv, pT, y_now)
        k0, k1 = bracket_levels(lv, y_now)
        labT = worse_label(final["ETH"][TL]["labels"][repr(float(k0))], final["ETH"][TL]["labels"][repr(float(k1))])
        if st == "ok":
            disp = f"{A.fmt_p(p)} {labT}"
        elif st == "shallower_than_grid":
            disp = f"{A.fmt_bound('>', pT[0])} {labT}"
        else:
            disp = f"{A.fmt_bound('<', pT[-1])} {labT}"
        cur[TL] = {"rung": shipT, "p": p, "status": st, "label": labT, "label_levels": [k0, k1], "display": disp}
    panel["action_example"] = {
        "label": "EXAMPLE position (not a real position; no number goes into app code)",
        "position": {"collateral": f"{C:g} ETH", "LT": LT, "spot_S": Sx, "spot_source": s_src, "debt_D_usd": D,
                     "debt_rule": "D = C * LT * S * (1 - 0.25) (line at -25% from spot)", "P_liq": D / (C * LT),
                     "distance_y": y_now, "distance_shown_pct": A.floor_pct_toward_risk(y_now)},
        "seven_day_rung": ship7, "rows": rows, "display": [r["display"] for r in rows],
        "current_line_by_horizon": cur}
    panel["dateline"] = (f"Trained on data to {iso(DATA_END)} (Chainlink truth; Binance before the splice); "
                         f"features and spot asof {asof_info['asof']} ({asof_info['source']}).")
    write_json(path, panel, refuse_overwrite=True)
    return panel


def history_count_g(ser, T_h, j):
    """A D20 history count on the common grid (non-overlapping windows over the full labelled history)."""
    y = ser.labels(T_h)[:, j]
    ok = np.isfinite(y)
    im = issue_mask(len(y))
    i_all = np.where(ok & im)[0]
    if not len(i_all):
        return None
    step = max(T_h, ISSUE_EVERY_H)
    starts = np.arange(i_all[0], len(y), step)
    starts = starts[ok[starts]]
    return {"touched": int(y[starts].sum()), "windows": int(len(starts)),
            "period": [iso(ts_of(starts[0])), iso(ts_of(starts[-1]) + STEP * T_h)]}


def a_rung_grids_live(datasets, a, rounds, asof_ts, dv):
    """A rungs b/c/d at asof, exactly as a_touch's panel (features from the live splice)."""
    S = A.build_series(datasets)
    ser = S[f"oracle:{a}"]
    N = ser.N
    te_feat, te_sigma = ser.feat[N][None, :], None
    if rounds and asof_ts > A.DATA_END:
        dec = A.FEEDS[a][1]
        ends = np.arange(A.DATA_END + STEP, asof_ts + 1, STEP)
        ext = np.array([A.answer_in_force(rounds, int(e))["answer"] / 10 ** dec for e in ends])
        sx = A.Series(a, "oracle", np.concatenate([ser.close, ext]), np.concatenate([ser.low, ext]),
                      A.COVERAGE_START[a])
        te_feat = sx.feat[sx.N][None, :]
    if a in A.D_ASSETS:
        te_sigma = np.array([dv["close"] / 100.0]) if dv else ser.sigma_dvol[[N]]
    g = {r: np.full((len(HORIZONS_H), len(ser.levels)), np.nan) for r in ("b", "c", "d")}
    for ti, T_h in enumerate(HORIZONS_H):
        o = A.fit_predict_fold(ser, T_h, N, np.array([N]), in_d=a in A.D_ASSETS, te_feat=te_feat, te_sigma=te_sigma)
        for r in g:
            if r in o["raw"]:
                g[r][ti] = o["raw"][r][0]
    return {r: A.monotone_fix(v[None])[0] for r, v in g.items() if not np.isnan(v).any()}


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


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", choices=("dryrun", "dev", "blind", "panel", "manifest"), required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--no-rpc", action="store_true")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    if a.phase == "manifest":
        run_manifest(a.out)
        return 0
    meta = verify_all(a.datasets)
    print("inputs verified", flush=True)
    log = lambda *x: print(*x, flush=True)  # noqa: E731
    if a.phase == "dryrun":
        run_dryrun(a.datasets, a.out, meta, log=log)
    elif a.phase == "dev":
        run_dev(a.datasets, a.out, meta, workers=a.workers, log=log)
    elif a.phase == "blind":
        run_blind(a.datasets, a.out, meta, workers=a.workers, log=log)
    elif a.phase == "panel":
        run_panel(a.datasets, a.out, meta, try_rpc=not a.no_rpc, log=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
