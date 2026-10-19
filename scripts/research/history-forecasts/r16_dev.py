"""Q26 R16.2 new-model bake-off for price-touch odds: DEVELOPMENT (seen data only). Not a preregistered test.

membrane-board design/Q26_ROUND16_PREREG.md section R16.2. Owner (2026-10-19): "if our baseline is simply a model that
worked better, let's try new ones". Blind sets B20a/B20b were reserved before this file existed (inventory section 20).

Target: P(min hourly low over (t, t+T] <= spot * (1 + k)), spot = close of the last finished hour.

Development data (all seen; grade C for touch): the R12 development pool (277 series: ETH, BTC, Kraken ETH, the A2
holdouts, final-blind, blind3-8) and B12 (OKX + Bybit venue-unique pairs) when --with-b12 is given. Walk-forward
quarterly folds as A6/R12 (every model is fitted only on data before the fold start minus T). 2026Q2 windows and the
30-day tail of ended series are dropped (R12 rules).

Horizons and tier cells (fixed before any development read):
  shallow 1-12 h : 1 h {-2,-3,-5%}; 3 h {-2,-3,-5,-7%}; 12 h {-2,-3,-5,-7,-10%}            origins every 6 h
  mid 6 h-3 d    : 6 h {-3,-5,-7,-10%}; 1 d {-5,-7,-10,-15%}; 3 d {-5,-10,-15,-20%}         6 h: 6-hourly, 1 d/3 d: 12-hourly
  long 7-30 d    : 7 d {-10,-15,-20,-25,-30%}; 30 d {-15,-20,-25,-30,-40%}                  origins daily

Models (FHS = empirical CDF of the series' own standardized training minima z = ln(wmin/spot)/(sigma*sqrt(T/8760)))
  a    plain history (empirical CDF of raw training depths)                              baseline
  f    FHS, EWMA scale (A3)                                                              baseline
  fH   FHS, log-HAR Parkinson scale (A6)                                                 current best 1 h-3 d
  hj   FHS, HAR-RV-J scale: OLS of ln sigma_fut on [1, ln RV_D, ln RV_W, ln RV_M, ln(1+J_D/RV_D)]
  hcj  FHS, HAR-CJ scale: [1, ln BPV_D, ln BPV_W, ln BPV_M, ln(1+J_D/BPV_D), ln(1+J_W/BPV_W)]
  sh   FHS, SHAR scale: [1, ln RS-_D, ln RS+_D, ln Park_W, ln Park_M]
  gP   FHS, pure GJR-GARCH(1,1) skew-t horizon scale (Barone-Adesi FHS; no OLS)
  gF   FHS, OLS-calibrated GJR horizon scale [1, ln sigma_GJR(T)]
  gH   FHS, HAR + GJR: [fH design, ln sigma_GJR(T)]
  eF   FHS, OLS-calibrated EGARCH(1,1,1) skew-t one-step scale [1, ln sigma_EG]
  ms   2-state Markov-switching (Hamilton filter on the 24 h log Parkinson variance; switching mean and variance):
       regime-mixture FHS, p = pi_hi * F_hi + (1 - pi_hi) * F_lo, F_r the fH-standardized training ECDF of regime r,
       pi_hi the filtered high-regime probability propagated over the horizon (average over the window)
  gS   GJR-GARCH skew-t PARAMETRIC simulation to the touch (hourly steps, simulated close path plus a bootstrapped
       standardized intrahour wick), daily origins only; N 1000 paths for T <= 72 h, 300 for 7 d / 30 d
  gE   conditional EVT (McNeil-Frey): GJR filter, empirical standardized residuals with GPD tails beyond q05 / q95,
       simulated to the touch as gS
  gb   direct touch classifier: sklearn HistGradientBoosting (log loss), one model per T over the tier levels,
       features below, monotone +1 in ln(1+k) and in logit p_fH; cross-fitted (below)
  st   stacking: logistic log-linear pool of {fH, f, hj, sh, gH, ms, gb} (7 weights + intercept per T), cross-fitted
  lp   linear pool of the same 7 (non-negative least squares on Brier, normalized), cross-fitted
  Every model falls back to fH on a row where it is undefined; the fallback rate is reported.

gb features (as-of): logit p_fH at the level, ln(1+k), ln sigma_H, ln sigma_EWMA, ln sigma_GJR(T), ln sigma_SHAR,
ln D - ln M, ln W - ln M, 24 h / 7 d / 30 d log returns, drawdown from the 30-day high, 24 h range, ln(vol24/vol720)
(NaN where volume is absent), day of week, hour, series age, BTC 24 h log return and BTC ln D - ln M (Binance BTCUSDT).

Cross-fitting of learned models (gb, st, lp): series groups g = sha256('Q26-R16.2-dev:' + key)[0] % 4 x time blocks
{<= 2020, 2021-22, 2023-24, >= 2025}; a cell (g, b) is predicted by a model trained on rows of other groups AND other
blocks whose windows end at least T before the block start or start after its end (no random rows).

Scores per (model, cell): rows, positives, Brier, log score, BSS vs fH and vs f (pooled Brier), R = sum p / sum y,
top-quintile R, CORP MCB and DSC (PAV), two-way (series x 4-week block) pigeonhole bootstrap z of the mean Brier
difference vs fH and vs f, series with a gain, leave-top-k mean difference (k = max(3, ceil(2.5% S))).

PRE-STATED SELECTION RULE (fixed in this docstring before any development output exists).
Comparator C: fH for the shallow and mid tiers; f for the long tier (unless R16.1 has registered another before the
score step, which is then recorded as a Deviation).
For each tier, pool the Brier differences d = B_m - B_C over every tier cell (one row per origin and level).
A candidate m is ELIGIBLE iff
  E1  the two-way bootstrap z of the tier mean d is <= -2.0 (a gain),
  E2  BSS(m vs C) >= -0.002 in every tier cell,
  E3  the tier mean d stays < 0 after leaving out the top-k gaining series,
  E4  median over the tier cells of |ln R_m| <= median of |ln R_C| + 0.02.
Eligible candidates are ranked by tier z (most negative first); at most 2 are selected per tier.
Early drop (bounded time): a family whose tier BSS vs C is below -0.01 on the first pass is not refined further.
Baselines a, f, fH are not candidates. Selection uses development data only.

  python3 r16_dev.py rows  --datasets DS --out OUT [--workers 3] [--with-b12] [--limit N]
  python3 r16_dev.py score --out OUT

No address, key or secret is read or written. Nothing here is blind evidence and nothing ships from it.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import warnings  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a2_touch as M2  # noqa: E402
import a6_touch as A6  # noqa: E402
import r12_tail as R12  # noqa: E402

STEP = 3600
DAY = 86400
TS = (1, 3, 6, 12, 24, 72, 168, 720)
LV = {1: (-0.02, -0.03, -0.05), 3: (-0.02, -0.03, -0.05, -0.07), 12: (-0.02, -0.03, -0.05, -0.07, -0.10),
      6: (-0.03, -0.05, -0.07, -0.10), 24: (-0.05, -0.07, -0.10, -0.15), 72: (-0.05, -0.10, -0.15, -0.20),
      168: (-0.10, -0.15, -0.20, -0.25, -0.30), 720: (-0.15, -0.20, -0.25, -0.30, -0.40)}
ORIGIN_STEP = {1: 6, 3: 6, 6: 6, 12: 6, 24: 12, 72: 12, 168: 24, 720: 24}
TIERS = {"shallow": (1, 3, 12), "mid": (6, 24, 72), "long": (168, 720)}
TIER_C = {"shallow": "fH", "mid": "fH", "long": "f"}
TL = {1: "1h", 3: "3h", 6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d", 720: "30d"}
SCALE_MODELS = ("hj", "hcj", "sh", "gP", "gF", "gH", "eF")
BASE = ("a", "f", "fH")
SIM = ("gS", "gE")
ALL_ROW_MODELS = BASE + SCALE_MODELS + ("ms",) + SIM
FEATS = ("lsH", "lsf", "lsg", "lssh", "dm", "wm", "r24", "r168", "r720", "dd720", "rng24", "lvol", "dow", "hour",
         "age", "btc_r24", "btc_dm")
SIM_H_SHORT, SIM_N_SHORT, SIM_N_LONG = 72, 1000, 300
GARCH_WIN = 8760
PCLIP = 1e-4
SEED = 20261902
SALT = "Q26-R16.2-dev:"
_BTC = {}


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "?"


def lg(p):
    p = np.clip(np.asarray(p, float), PCLIP, 1 - PCLIP)
    return np.log(p / (1 - p))


# =============================================================================================
# realized measures (origin i uses bars <= i-1), GARCH, regime
# =============================================================================================
def roll_mean(x, W, start_i):
    return A6.window_mean_null_rule(x, W, start_i)


def realized(ser):
    c = ser.close
    n = len(c)
    r = np.full(n, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[1:] = np.log(c[1:] / c[:-1])
    r[:ser.start_i + 1] = np.nan
    r2 = r * r
    bp = np.full(n, np.nan)
    bp[1:] = (math.pi / 2) * np.abs(r[1:]) * np.abs(r[:-1])
    rsm = np.where(r < 0, r2, np.where(np.isfinite(r), 0.0, np.nan))
    rsp = np.where(r > 0, r2, np.where(np.isfinite(r), 0.0, np.nan))
    out = {"r": r}
    for nm, x in (("RV", r2), ("BPV", bp), ("RSm", rsm), ("RSp", rsp)):
        for W, wn in ((24, "D"), (168, "W"), (720, "M")):
            out[nm + wn] = 8760.0 * roll_mean(x, W, ser.start_i)
    for wn in "DWM":
        out["J" + wn] = np.maximum(out["RV" + wn] - out["BPV" + wn], 0.0)
    return out


def _gjr_filter(r100, om, al, ga, be, s0):
    n = len(r100)
    s2 = np.empty(n + 1)
    s2[0] = s0
    rr = np.where(np.isfinite(r100), r100, 0.0)
    for t in range(n):
        x = rr[t]
        s2[t + 1] = om + (al + (ga if x < 0 else 0.0)) * x * x + be * s2[t]
    return s2                   # s2[i] = variance of bar i given bars < i  (i = 0..n)


def _eg_filter(r100, om, al, ga, be, s0):
    n = len(r100)
    ls = np.empty(n + 1)
    ls[0] = math.log(s0)
    k = math.sqrt(2 / math.pi)
    for t in range(n):
        x = r100[t]
        if not np.isfinite(x):
            ls[t + 1] = om + be * ls[t]
            continue
        z = x / math.exp(0.5 * ls[t])
        ls[t + 1] = min(om + al * (abs(z) - k) + ga * z + be * ls[t], 50.0)
    return np.exp(ls)


def fit_arch(r100, vol):
    from arch import arch_model
    x = r100[np.isfinite(r100)]
    if len(x) < 2000:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if vol == "GJR":
                m = arch_model(x, mean="Zero", vol="GARCH", p=1, o=1, q=1, dist="skewt", rescale=False)
            else:
                m = arch_model(x, mean="Zero", vol="EGARCH", p=1, o=1, q=1, dist="skewt", rescale=False)
            res = m.fit(disp="off", options={"maxiter": 300})
        p = res.params
        if vol == "GJR":
            om, al, ga, be = (float(p["omega"]), float(p["alpha[1]"]), float(p["gamma[1]"]), float(p["beta[1]"]))
        else:
            om, al, ga, be = (float(p["omega"]), float(p["alpha[1]"]), float(p["gamma[1]"]), float(p["beta[1]"]))
        nu, lam = float(p["eta"]), float(p["lambda"])
        if not all(np.isfinite([om, al, ga, be, nu, lam])):
            return None
        return {"om": om, "al": al, "ga": ga, "be": be, "nu": nu, "lam": lam, "var": float(np.var(x))}
    except Exception:  # noqa: BLE001
        return None


def gjr_horizon_var(s2next, g, T):
    """sum_{h=1..T} E sigma^2_{t+h} given the one-step variance (per hour, in %^2)."""
    phi = g["al"] + 0.5 * g["ga"] + g["be"]
    if not (0 < phi < 0.9999):
        return s2next * T
    sbar = g["om"] / (1 - phi)
    return T * sbar + (s2next - sbar) * (1 - phi ** T) / (1 - phi)


def ms_fit(y):
    """2-state Markov switching mean and variance on a daily series; returns params ordered (lo, hi) or None."""
    try:
        import statsmodels.api as sm
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            mod = sm.tsa.MarkovRegression(y, k_regimes=2, trend="c", switching_variance=True)
            res = mod.fit(disp=False, maxiter=200, search_reps=3)
        P = np.asarray(res.regime_transition)[:, :, 0]    # P[i, j] = P(s_t = i | s_{t-1} = j)
        par = dict(zip(res.model.param_names, res.params))
        mu = np.array([par["const[0]"], par["const[1]"]])
        sd = np.sqrt(np.array([par["sigma2[0]"], par["sigma2[1]"]]))
        p00, p11 = P[0, 0], P[1, 1]
        if mu[0] > mu[1]:
            mu, sd, p00, p11 = mu[::-1], sd[::-1], p11, p00
        if not np.all(np.isfinite([*mu, *sd, p00, p11])) or np.any(sd <= 0):
            return None
        return {"mu": mu, "sd": sd, "p00": float(p00), "p11": float(p11)}
    except Exception:  # noqa: BLE001
        return None


def ms_filter(x, m):
    """filtered P(high) for each hourly origin, run along 24 separate phase sequences (24 h step)."""
    n = len(x)
    out = np.full(n, np.nan)
    p00, p11 = m["p00"], m["p11"]
    pinf = (1 - p00) / (2 - p00 - p11) if (2 - p00 - p11) > 0 else 0.5
    for ph in range(24):
        idx = np.arange(ph, n, 24)
        ph_ = pinf
        for j in idx:
            pred = ph_ * p11 + (1 - ph_) * (1 - p00)
            v = x[j]
            if np.isfinite(v):
                l1 = math.exp(-0.5 * ((v - m["mu"][1]) / m["sd"][1]) ** 2) / m["sd"][1]
                l0 = math.exp(-0.5 * ((v - m["mu"][0]) / m["sd"][0]) ** 2) / m["sd"][0]
                den = pred * l1 + (1 - pred) * l0
                ph_ = pred * l1 / den if den > 0 else pred
            else:
                ph_ = pred
            out[j] = ph_
    return out


def ms_horizon(p, m, T):
    p00, p11 = m["p00"], m["p11"]
    lam = p00 + p11 - 1
    pinf = (1 - p00) / (2 - p00 - p11) if (2 - p00 - p11) > 0 else 0.5
    D = T / 24.0
    if abs(1 - lam) < 1e-9 or D <= 0:
        return p
    avg = lam * (1 - lam ** D) / (D * (1 - lam))
    return pinf + (p - pinf) * avg


# =============================================================================================
# simulation to the touch (gS parametric skew-t; gE empirical + GPD tails)
# =============================================================================================
def innov_bank(kind, g, zres, N, H, rng):
    if kind == "gS":
        from arch.univariate import SkewStudent
        sim = SkewStudent(seed=rng).simulate([g["nu"], g["lam"]])
        return np.asarray(sim(N * H), float).reshape(N, H)
    from scipy.stats import genpareto
    z = zres[np.isfinite(zres)]
    lo, hi = np.quantile(z, [0.05, 0.95])
    el, eh = lo - z[z < lo], z[z > hi] - hi
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        cl = genpareto.fit(el, floc=0) if len(el) > 50 else None
        ch = genpareto.fit(eh, floc=0) if len(eh) > 50 else None
    d = rng.choice(z, size=(N, H), replace=True)
    if cl is not None:
        m = d < lo
        d[m] = lo - genpareto.rvs(cl[0], 0, cl[2], size=int(m.sum()), random_state=rng)
    if ch is not None:
        m = d > hi
        d[m] = hi + genpareto.rvs(ch[0], 0, ch[2], size=int(m.sum()), random_state=rng)
    d = (d - d.mean()) / d.std()
    return d


def simulate_touch(s2_0, g, Z, Wk, Hs, lnks):
    """s2_0 (m,) one-step variance (%^2) at each origin; Z (N, H) innovations; Wk (N, H) standardized wicks (<= 0).
    Returns {T: (m, len(lnks)) probabilities} for T in Hs."""
    m, (N, H) = len(s2_0), Z.shape
    s2 = np.repeat(s2_0[:, None], N, axis=1)
    x = np.zeros((m, N))
    runmin = np.full((m, N), np.inf)
    out = {}
    Tset = set(Hs)
    for h in range(H):
        sd = np.sqrt(s2)
        rr = sd * Z[None, :, h]
        xn = x + rr
        low = np.minimum(x, xn) + sd * Wk[None, :, h]
        runmin = np.minimum(runmin, low)
        x = xn
        s2 = g["om"] + (g["al"] + g["ga"] * (rr < 0)) * rr * rr + g["be"] * s2
        if (h + 1) in Tset:
            lm = runmin / 100.0
            out[h + 1] = np.stack([(lm <= lk).mean(axis=1) for lk in lnks[h + 1]], axis=1)
    return out


# =============================================================================================
# per-series worker
# =============================================================================================
def ols_scale(X, okX, lfut, okH, tr_idx):
    rows = tr_idx[okX[tr_idx] & okH[tr_idx]]
    if len(rows) < 50:
        return None
    rows = rows[::3]
    c, *_ = np.linalg.lstsq(X[rows], lfut[rows], rcond=None)
    return c


def sig_from(X, okX, c):
    out = np.full(len(X), np.nan)
    if c is None:
        return out
    with np.errstate(over="ignore", invalid="ignore"):
        out[okX] = np.exp(X[okX] @ c)
    out[~(out > 0) | ~np.isfinite(out)] = np.nan
    return out


def fhs_from_sigma(P, sig, tr_mask, te, lnk):
    s = np.where(sig > 0, sig, np.nan)
    valid = P.lab_ok & np.isfinite(s)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = P.depth / (s * P.scale)
    ztr = z[valid & tr_mask]
    with np.errstate(invalid="ignore", divide="ignore"):
        thr = lnk[None, :] / (s[te][:, None] * P.scale)
    return M2.fhs_predict(ztr, thr), z, valid


def load_volume(spec):
    if spec.get("kind") != "grid":
        return None
    try:
        raw = open(spec["path"], "rb").read()
        if spec["path"].endswith(".gz"):
            raw = gzip.decompress(raw)
        d = json.loads(raw)
        if "volume" not in d["columns"]:
            return None
        v = np.array([np.nan if x is None else float(x) for x in d["columns"]["volume"]], float)
        if "slice" in spec:
            v = v[spec["slice"][0]:spec["slice"][1]]
        return v
    except Exception:  # noqa: BLE001
        return None


def btc_lookup(ts):
    B = _BTC
    if not B:
        return np.full(len(ts), np.nan), np.full(len(ts), np.nan)
    k = (ts - B["st"]) // STEP
    ok = (k >= 0) & (k < len(B["r24"]))
    a, b = np.full(len(ts), np.nan), np.full(len(ts), np.nan)
    a[ok], b[ok] = B["r24"][k[ok]], B["dm"][k[ok]]
    return a, b


def task(spec):
    t0 = time.time()
    rng = np.random.default_rng(int(hashlib.sha256((str(SEED) + spec["key"]).encode()).hexdigest()[:8], 16))
    ser, folds, caps = R12.load_series(spec)
    RM = realized(ser)
    N1 = len(ser.close) + 1
    r100 = RM["r"] * 100.0
    vol = load_volume(spec)
    with np.errstate(invalid="ignore", divide="ignore"):
        HAR = np.log(A6.har_of(ser))                           # (N+1, 3)
        lc = np.log(ser.spot)
        # features independent of T
        hi = np.concatenate([[np.nan], ser.high])
        lo = np.concatenate([[np.nan], ser.low])
    def lagret(L):
        o = np.full(N1, np.nan)
        o[L:] = lc[L:] - lc[:-L]
        return o
    def rollmax(x, W):
        from numpy.lib.stride_tricks import sliding_window_view
        o = np.full(N1, np.nan)
        if len(x) > W:
            v = sliding_window_view(np.where(np.isfinite(x), x, -np.inf), W).max(axis=1)
            o[W:] = v[:N1 - W]
        o[~np.isfinite(o)] = np.nan
        return o
    def rollmin(x, W):
        return -rollmax(-x, W)
    # hi[i] = high of bar i-1 (origin-aligned); window of origins i: bars i-W..i-1 = hi[i-W+1..i]
    hmax720 = rollmax(hi[1:], 720)
    hmax24, lmin24 = rollmax(hi[1:], 24), rollmin(lo[1:], 24)
    F0 = {"dm": HAR[:, 0] - HAR[:, 2], "wm": HAR[:, 1] - HAR[:, 2], "r24": lagret(24), "r168": lagret(168),
          "r720": lagret(720)}
    with np.errstate(invalid="ignore", divide="ignore"):
        F0["dd720"] = lc - np.log(hmax720)
        F0["rng24"] = np.log(hmax24 / lmin24)
        if vol is not None and len(vol) == len(ser.close):
            v24, v720 = roll_mean(vol, 24, ser.start_i), roll_mean(vol, 720, ser.start_i)
            F0["lvol"] = np.log(v24 / v720)
        else:
            F0["lvol"] = np.full(N1, np.nan)
    for k_ in F0:
        F0[k_][~np.isfinite(F0[k_])] = np.nan
    ts_all = ser.base_ts + STEP * np.arange(N1)
    F0["dow"] = ((ts_all // DAY) + 3) % 7
    F0["hour"] = (ts_all // STEP) % 24
    F0["age"] = (np.arange(N1) - ser.start_i) / 24.0
    F0["btc_r24"], F0["btc_dm"] = btc_lookup(ts_all)
    # scale designs (T-independent)
    with np.errstate(invalid="ignore", divide="ignore"):
        D = {}
        D["hj"] = np.column_stack([np.ones(N1), np.log(RM["RVD"]), np.log(RM["RVW"]), np.log(RM["RVM"]),
                                   np.log1p(RM["JD"] / RM["RVD"])])
        D["hcj"] = np.column_stack([np.ones(N1), np.log(RM["BPVD"]), np.log(RM["BPVW"]), np.log(RM["BPVM"]),
                                    np.log1p(RM["JD"] / RM["BPVD"]), np.log1p(RM["JW"] / RM["BPVW"])])
        D["sh"] = np.column_stack([np.ones(N1), np.log(RM["RSmD"]), np.log(RM["RSpD"]), HAR[:, 1], HAR[:, 2]])
    for k_ in D:
        D[k_][~np.isfinite(D[k_])] = np.nan
    okD = {k_: np.all(np.isfinite(v), axis=1) for k_, v in D.items()}
    # ---- GARCH fits (yearly refits at fold starts) and filtered one-step variances
    fold_q = [f for f in folds if f["qs_i"] < N1]
    s2g = np.full(N1, np.nan)
    s2e = np.full(N1, np.nan)
    gpar = {}
    epar = {}
    zres_by = {}
    wick_by = {}
    msp = np.full(N1, np.nan)
    mspar = {}
    nfit = {"gjr": 0, "eg": 0, "ms": 0, "gjr_fail": 0, "eg_fail": 0, "ms_fail": 0}
    blocks = []
    for j in range(0, len(fold_q), 4):
        qs = fold_q[j]["qs_i"]
        qe = fold_q[min(j + 3, len(fold_q) - 1)]["qe_i"]
        blocks.append((j, qs, min(qe, N1)))
    lnD = HAR[:, 0]
    for (j, qs, qe) in blocks:
        a0 = max(ser.start_i + 1, qs - 1 - GARCH_WIN)
        win = r100[a0:qs - 1]                       # bars a0..qs-2 (all before origin qs)
        g = fit_arch(win, "GJR")
        e = fit_arch(win, "EG")
        nfit["gjr" if g else "gjr_fail"] += 1
        nfit["eg" if e else "eg_fail"] += 1
        seg = r100[a0:qe]                           # filter from a0 through the block
        if g:
            s2 = _gjr_filter(seg, g["om"], g["al"], g["ga"], g["be"], g["var"])
            # s2[k] = variance of bar a0+k  => origin i = a0 + k
            ii = np.arange(qs, qe)
            s2g[ii] = s2[ii - a0]
            gpar[j] = g
            zz = win / np.sqrt(s2[:len(win)])
            zres_by[j] = zz[np.isfinite(zz)]
            # standardized wicks of training bars: w = ln(low / min(prev close, close)) / sigma (in %)
            bars = np.arange(a0, qs - 1)
            with np.errstate(invalid="ignore", divide="ignore"):
                ref = np.minimum(ser.close[bars - 1], ser.close[bars])
                w = 100 * np.log(ser.low[bars] / ref) / np.sqrt(s2[:len(win)])
            w = np.minimum(w[np.isfinite(w)], 0.0)
            wick_by[j] = w if len(w) > 500 else None
        if e:
            se = _eg_filter(seg, e["om"], e["al"], e["ga"], e["be"], e["var"])
            ii = np.arange(qs, qe)
            s2e[ii] = se[ii - a0]
            epar[j] = e
        # Markov switching on the daily-sampled 24 h log Parkinson variance before qs (phase of qs)
        di = np.arange(qs - 24, max(ser.start_i, qs - 24 * 730), -24)[::-1]
        y = lnD[di]
        y = y[np.isfinite(y)]
        m = ms_fit(y) if len(y) >= 200 else None
        nfit["ms" if m else "ms_fail"] += 1
        if m:
            a1 = max(ser.start_i, qs - 24 * 60)
            pf = ms_filter(lnD[a1:qe], m)
            ii = np.arange(qs, qe)
            msp[ii] = pf[ii - a1]
            # training regime labels: filter the whole history up to qs with these params
            pt = ms_filter(lnD[:qs], m)
            mspar[j] = (m, pt)
    blk_of_fold = {}
    for (j, qs, qe) in blocks:
        for jj in range(j, min(j + 4, len(fold_q))):
            blk_of_fold[jj] = j
    lnks_all = {T: np.log1p(np.array(LV[T])) for T in TS}
    rows = {}
    nfb = {}
    for T in TS:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        P, n = P6.P, P6.n
        lnk = lnks_all[T]
        i_all = np.arange(n)
        out = {k_: [] for k_ in ("ts", "y", "q2", "tail") + ALL_ROW_MODELS + tuple(FEATS)}
        fbc = {m_: 0 for m_ in ALL_ROW_MODELS}
        st = ORIGIN_STEP[T]
        for jf, f in enumerate(fold_q):
            qs, qe = f["qs_i"], min(f["qe_i"], n)
            lim = qs - T
            if lim <= 0:
                continue
            tr = i_all <= lim
            tri = i_all[tr]
            te = np.arange(qs, qe)
            te = te[P.lab_ok[te] & (ts_all[te] + T * STEP <= caps["full"]) & (ts_all[te] % (st * STEP) == 0)]
            te = te[np.isfinite(P.depth[te])]
            if len(te) == 0:
                continue
            cH, _ = P6.har_coef(qs)
            sH = P6.sigma_H(cH)
            zH, vH = P6.z_of(sH)
            with np.errstate(invalid="ignore", divide="ignore"):
                thrH = lnk[None, :] / (sH[te][:, None] * P.scale)
                thrf = lnk[None, :] / (ser.sigma[te][:, None] * P.scale)
            pf_ = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], thrf)
            pH = M2.fhs_predict(zH[vH & tr], thrH)
            fb = ~np.all(np.isfinite(pH), axis=1)
            pH[fb] = pf_[fb]
            keep = np.all(np.isfinite(pH), axis=1) & np.all(np.isfinite(pf_), axis=1)
            te, pH, pf_ = te[keep], pH[keep], pf_[keep]
            if len(te) == 0:
                continue
            dtr = P.depth[tr & P.lab_ok]
            dtr = dtr[np.isfinite(dtr)]
            pa = np.stack([np.searchsorted(np.sort(dtr), lk, side="right") / max(len(dtr), 1)
                           for lk in lnk])[None, :].repeat(len(te), 0)
            res = {"a": pa, "f": pf_, "fH": pH}
            # HAR-family scale models
            for nm in ("hj", "hcj", "sh"):
                c = ols_scale(D[nm], okD[nm], P6.lfut, P6.okH, tri)
                sg = sig_from(D[nm], okD[nm], c)
                p_, _, _ = fhs_from_sigma(P, sg, tr, te, lnk)
                res[nm] = p_
                if nm == "sh":
                    lssh = np.log(sg[te])
            # GARCH-scale models
            jb = blk_of_fold.get(jf)
            g = gpar.get(jb)
            if g is not None:
                with np.errstate(invalid="ignore", divide="ignore"):
                    hv = gjr_horizon_var(s2g, g, T)
                    sgj = np.sqrt(8760.0 * hv / T) / 100.0      # annualized horizon sigma
                lsg = np.log(sgj)
                okg = np.isfinite(lsg)
                p_, _, _ = fhs_from_sigma(P, np.where(okg, sgj, np.nan), tr, te, lnk)
                res["gP"] = p_
                Xg = np.column_stack([np.ones(N1), np.where(okg, lsg, np.nan)])
                okXg = np.all(np.isfinite(Xg), axis=1)
                c = ols_scale(Xg, okXg, P6.lfut, P6.okH, tri)
                p_, _, _ = fhs_from_sigma(P, sig_from(Xg, okXg, c), tr, te, lnk)
                res["gF"] = p_
                XgH = np.column_stack([P6.X, np.where(okg, lsg, np.nan)[:len(P6.X)]])
                okXgH = np.all(np.isfinite(XgH), axis=1)
                c = ols_scale(XgH, okXgH, P6.lfut, P6.okH, tri)
                p_, _, _ = fhs_from_sigma(P, sig_from(XgH, okXgH, c), tr, te, lnk)
                res["gH"] = p_
                lsg_te = lsg[te]
            else:
                lsg_te = np.full(len(te), np.nan)
            if epar.get(jb) is not None:
                with np.errstate(invalid="ignore", divide="ignore"):
                    lse = 0.5 * np.log(8760.0 * s2e / 1e4)
                Xe = np.column_stack([np.ones(N1), lse])
                okXe = np.all(np.isfinite(Xe), axis=1)
                c = ols_scale(Xe, okXe, P6.lfut, P6.okH, tri)
                p_, _, _ = fhs_from_sigma(P, sig_from(Xe, okXe, c), tr, te, lnk)
                res["eF"] = p_
            # Markov-switching regime mixture of fH-standardized ECDFs
            if jb in mspar and np.isfinite(msp[te]).any():
                m, ptr = mspar[jb]
                trv = vH & tr
                trv_i = np.where(trv)[0]
                trv_i = trv_i[trv_i < len(ptr)]
                hiR = ptr[trv_i] > 0.5
                zt = zH[trv_i]
                if hiR.sum() >= 200 and (~hiR).sum() >= 200:
                    Fh = M2.fhs_predict(zt[hiR], thrH[keep])
                    Fl = M2.fhs_predict(zt[~hiR], thrH[keep])
                    pi = ms_horizon(msp[te], m, T)
                    pm = pi[:, None] * Fh + (1 - pi[:, None]) * Fl
                    res["ms"] = pm
            # simulation to the touch at daily origins
            if g is not None and (jb in wick_by) and wick_by[jb] is not None:
                dmask = (ts_all[te] % DAY == 0) & np.isfinite(s2g[te])
                if dmask.any():
                    key_ = ("sim", jb, jf, T)
                    res["_dmask"] = dmask
                    res["_simkey"] = key_
            # assemble
            for m_ in ALL_ROW_MODELS:
                if m_ in res:
                    v = np.asarray(res[m_], float)
                    bad = ~np.all(np.isfinite(v), axis=1)
                    fbc[m_] += int(bad.sum())
                    v[bad] = pH[bad]
                else:
                    v = pH.copy() if m_ not in SIM else np.full_like(pH, np.nan)
                    if m_ not in SIM:
                        fbc[m_] += len(te)
                out[m_].append(np.minimum.accumulate(v, axis=1).astype(np.float32))
            # simulations (filled in after; placeholder rows above are NaN)
            if "_simkey" in res:
                dmask = res["_dmask"]
                idx = np.where(dmask)[0]
                Tsim = [T]
                Hn = T
                Nn = SIM_N_SHORT if T <= SIM_H_SHORT else SIM_N_LONG
                Wk = rng.choice(wick_by[jb], size=(Nn, Hn), replace=True)
                for kind in SIM:
                    Z = innov_bank(kind, g, zres_by[jb], Nn, Hn, rng)
                    for c0 in range(0, len(idx), 64):
                        ii = idx[c0:c0 + 64]
                        ps = simulate_touch(s2g[te[ii]], g, Z, Wk, Tsim, {T: lnk})[T]
                        out[kind][-1][ii] = np.minimum.accumulate(ps, axis=1).astype(np.float32)
            ts = ts_all[te]
            Y = (P.depth[te][:, None] <= lnk[None, :]).astype(np.int8)
            out["ts"].append(ts)
            out["y"].append(Y)
            out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
            out["tail"].append(ts + T * STEP > caps["primary"])
            for k_ in FEATS:
                if k_ == "lsH":
                    v = np.log(sH[te])
                elif k_ == "lsf":
                    v = np.log(ser.sigma[te])
                elif k_ == "lsg":
                    v = lsg_te
                elif k_ == "lssh":
                    v = lssh
                else:
                    v = F0[k_][te]
                out[k_].append(np.asarray(v, np.float32))
        if out["ts"]:
            R = {k_: np.concatenate(v) for k_, v in out.items()}
            m = ~R["q2"] & ~R["tail"]
            R = {k_: v[m] for k_, v in R.items() if k_ not in ("q2", "tail")}
            rows[T] = R
        nfb[T] = fbc
        A6._clear(ser) if hasattr(A6, "_clear") else None
    return {"key": spec["key"], "rows": rows, "fallback": nfb, "fits": nfit, "sec": time.time() - t0}


def init_btc(datasets):
    st, cols = R12.load_json_grid(os.path.join(datasets, "binance-klines/BTCUSDT-1h.json"))
    c, h, l_ = cols["close"], cols["high"], cols["low"]
    n = len(c)
    spot = np.concatenate([[np.nan], c])
    r24 = np.full(n + 1, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r24[24:] = np.log(spot[24:] / spot[:-24])
        v = A6.parkinson_v(h, l_)
        d = A6.window_mean_null_rule(v, 24, 0)
        mth = A6.window_mean_null_rule(v, 720, 0)
        dm = 0.5 * np.log(d / mth)
    _BTC.update({"st": st, "r24": r24, "dm": dm})


def cmd_rows(a):
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "rows-log.txt"), "a")

    def log(s):
        line = f"{R12.now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    sha = git_sha()
    specs = R12.dev_specs(a.datasets)
    if a.with_b12:
        import r125_fh_deep as R125
        specs += R125.b12_specs(os.path.join(a.datasets, "b12-venue-unique-prices"))
    if a.only:
        specs = [s for s in specs if s["key"] in a.only.split(",")]
    if a.limit:
        specs = specs[:a.limit]
    init_btc(a.datasets)
    for sp in specs:                      # build the chain series once in the parent (shared by forked workers)
        if sp["kind"] == "chain":
            R12.load_series(sp)
            break
    log(f"START r16 dev rows; code {sha}; series {len(specs)}; workers {a.workers}")
    acc = {T: [] for T in TS}
    meta = {"code": sha, "series": [], "fallback": {}, "fits": {}, "started_utc": R12.now_iso()}
    t0 = time.time()
    # chain series (dev:ETH / dev:BTC) first in the parent so forked workers share the cache
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=4) as pool:
        for j, r in enumerate(pool.imap_unordered(task, specs, chunksize=1)):
            sid = len(meta["series"])
            meta["series"].append(r["key"])
            meta["fallback"][r["key"]] = r["fallback"]
            meta["fits"][r["key"]] = r["fits"]
            for T, R in r["rows"].items():
                R["sid"] = np.full(len(R["ts"]), sid, np.int32)
                acc[T].append(R)
            if (j + 1) % 10 == 0 or j + 1 == len(specs):
                log(f"  {j + 1}/{len(specs)} series ({time.time() - t0:.0f}s; last {r['key']} {r['sec']:.0f}s)")
    for T in TS:
        if not acc[T]:
            continue
        R = {k_: np.concatenate([x[k_] for x in acc[T]]) for k_ in acc[T][0]}
        np.savez_compressed(os.path.join(a.out, f"rows-T{T}.npz"), **R)
        log(f"  wrote T {TL[T]}: {len(R['ts'])} rows")
    meta["finished_utc"] = R12.now_iso()
    json.dump(meta, open(os.path.join(a.out, "rows-meta.json"), "w"), indent=1, default=int)
    log("END rows")


# =============================================================================================
# scoring
# =============================================================================================
def corp(p, y):
    """CORP decomposition (Dimitriadis-Gneiting-Jordan): Brier = MCB - DSC + UNC, PAV recalibration."""
    from sklearn.isotonic import IsotonicRegression
    o = np.argsort(p, kind="stable")
    ps, ys = p[o], y[o].astype(float)
    if len(ps) > 400000:          # PAV on quantile bins of equal-p groups for speed (ties kept together)
        pass
    iso = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip")
    cal = iso.fit_transform(ps, ys)
    yb = ys.mean()
    b = np.mean((ps - ys) ** 2)
    bc = np.mean((cal - ys) ** 2)
    unc = yb * (1 - yb)
    return float(b - bc), float(unc - bc)


class TwoWay:
    """pigeonhole two-way bootstrap over series x 4-week blocks of per-row differences d."""

    def __init__(self, sid, blk, B=1000, seed=SEED):
        self.us, self.si = np.unique(sid, return_inverse=True)
        self.ub, self.bi = np.unique(blk, return_inverse=True)
        self.B = B
        rng = np.random.default_rng(seed)
        S, K = len(self.us), len(self.ub)
        self.ws = rng.multinomial(S, np.ones(S) / S, size=B).astype(float)
        self.wb = rng.multinomial(K, np.ones(K) / K, size=B).astype(float)
        self.Nc = np.zeros((S, K))
        np.add.at(self.Nc, (self.si, self.bi), 1.0)

    def z(self, d, mask=None):
        si, bi = self.si, self.bi
        w = np.ones(len(d)) if mask is None else mask.astype(float)
        Sc = np.zeros((len(self.us), len(self.ub)))
        Nc = np.zeros_like(Sc)
        np.add.at(Sc, (si, bi), d * w)
        np.add.at(Nc, (si, bi), w)
        mean = Sc.sum() / Nc.sum()
        num = np.einsum("bs,sk,bk->b", self.ws, Sc, self.wb)
        den = np.einsum("bs,sk,bk->b", self.ws, Nc, self.wb)
        mb = num / np.where(den > 0, den, np.nan)
        sd = np.nanstd(mb)
        # variance components for power: series-only and block-only bootstraps
        ns = (self.ws @ Sc.sum(1)) / (self.ws @ Nc.sum(1))
        nb = (self.wb @ Sc.sum(0)) / (self.wb @ Nc.sum(0))
        return {"mean": float(mean), "sd2": float(sd), "z": float(mean / sd) if sd > 0 else None,
                "sd_series": float(np.std(ns)), "sd_block": float(np.std(nb)),
                "pct_p": float((1 + np.sum(mb >= 0)) / (self.B + 1)), "S": len(self.us), "K": len(self.ub)}


def leave_top_k(sid, d):
    us, inv = np.unique(sid, return_inverse=True)
    tot = np.bincount(inv, weights=d)
    cnt = np.bincount(inv)
    k = max(3, math.ceil(0.025 * len(us)))
    top = np.argsort(tot)[:k]                    # largest gains = most negative sums
    keep = ~np.isin(inv, top)
    gain_series = int(np.sum(tot < 0))
    share = float(tot[top].sum() / tot[tot < 0].sum()) if tot.sum() < 0 and (tot < 0).any() else None
    return {"k": k, "mean_after": float(d[keep].mean()) if keep.any() else None, "series_with_gain": gain_series,
            "series": len(us), "topk_share_of_gain": share, "mean_rows_per_series": float(cnt.mean())}


def groups_of(keys):
    return np.array([hashlib.sha256((SALT + k).encode()).digest()[0] % 4 for k in keys])


def tblock(ts):
    yr = (ts // (365.2425 * DAY) + 1970).astype(int)
    return np.where(yr <= 2020, 0, np.where(yr <= 2022, 1, np.where(yr <= 2024, 2, 3)))


TB_EDGES = [None, None]


def crossfit(R, T, keys, log, make_pred):
    """returns predictions for every row from models trained on other series groups and other time blocks
    (embargo: training windows must end >= T before the test block starts or start after it ends)."""
    import datetime as _dt
    g = groups_of(keys)[R["sid"]]
    b = tblock(R["ts"])
    edges = [int(_dt.datetime(y_, 1, 1, tzinfo=_dt.timezone.utc).timestamp()) for y_ in (2021, 2023, 2025)]
    lo_ = {0: -np.inf, 1: edges[0], 2: edges[1], 3: edges[2]}
    hi_ = {0: edges[0], 1: edges[1], 2: edges[2], 3: np.inf}
    pred = None
    for gg in range(4):
        for bb in range(4):
            te = (g == gg) & (b == bb)
            if not te.any():
                continue
            tr = (g != gg) & ((R["ts"] + T * STEP <= lo_[bb]) | (R["ts"] >= hi_[bb]))
            if tr.sum() < 1000:
                tr = (g != gg) & (b != bb)
            p = make_pred(tr, te)
            if pred is None:
                pred = np.full((len(R["ts"]),) + p.shape[1:], np.nan, np.float32)
            pred[te] = p
    return pred


def gb_design(R, idx, lvl_j, lnk):
    cols = [lg(R["fH"][idx, lvl_j]), np.full(len(idx), lnk[lvl_j])]
    for f_ in FEATS:
        cols.append(R[f_][idx].astype(float))
    return np.column_stack(cols)


def fit_gb(R, tr, lnk, rng, max_rows=500000):
    from sklearn.ensemble import HistGradientBoostingClassifier
    L = len(lnk)
    idx = np.where(tr)[0]
    per = max(1, max_rows // L)
    if len(idx) > per:
        idx = rng.choice(idx, per, replace=False)
    X = np.vstack([gb_design(R, idx, j, lnk) for j in range(L)])
    y = np.concatenate([R["y"][idx, j] for j in range(L)])
    mono = [1, 1] + [0] * len(FEATS)
    clf = HistGradientBoostingClassifier(loss="log_loss", learning_rate=0.05, max_iter=250, max_leaf_nodes=31,
                                         min_samples_leaf=500, l2_regularization=1.0, monotonic_cst=mono,
                                         early_stopping=False, random_state=SEED)
    clf.fit(X, y)
    return clf


STACK = ("fH", "f", "hj", "sh", "gH", "ms", "gb")


def fit_stack_llp(R, tr, P, L, rng, max_rows=400000):
    from sklearn.linear_model import LogisticRegression
    idx = np.where(tr)[0]
    per = max(1, max_rows // L)
    if len(idx) > per:
        idx = rng.choice(idx, per, replace=False)
    X = np.vstack([np.column_stack([lg(P[m][idx, j]) for m in STACK]) for j in range(L)])
    y = np.concatenate([R["y"][idx, j] for j in range(L)])
    clf = LogisticRegression(C=100.0, max_iter=500)
    clf.fit(X, y)
    return clf


def fit_lp(R, tr, P, L, rng, max_rows=400000):
    from scipy.optimize import nnls
    idx = np.where(tr)[0]
    per = max(1, max_rows // L)
    if len(idx) > per:
        idx = rng.choice(idx, per, replace=False)
    X = np.vstack([np.column_stack([P[m][idx, j] for m in STACK]) for j in range(L)])
    y = np.concatenate([R["y"][idx, j] for j in range(L)]).astype(float)
    w, _ = nnls(X, y)
    return w / w.sum() if w.sum() > 0 else np.ones(len(STACK)) / len(STACK)


def score_cells(R, T, P, models, tw, sids, log):
    lnk = np.log1p(np.array(LV[T]))
    blk = (R["ts"] // (28 * DAY)).astype(np.int64)
    out = {}
    for j, k in enumerate(LV[T]):
        y = R["y"][:, j].astype(float)
        cell = {"rows": int(len(y)), "pos": int(y.sum()), "pos_blocks": int(len(np.unique(blk[y > 0])))}
        bH = (P["fH"][:, j] - y) ** 2
        bf = (P["f"][:, j] - y) ** 2
        for m in models:
            p = np.clip(P[m][:, j].astype(float), 0, 1)
            if not np.isfinite(p).all():
                mk = np.isfinite(p)
            else:
                mk = None
            pp, yy = (p, y) if mk is None else (p[mk], y[mk])
            b = (pp - yy) ** 2
            pc = np.clip(pp, PCLIP, 1 - PCLIP)
            ls = -(yy * np.log(pc) + (1 - yy) * np.log(1 - pc))
            q80 = np.quantile(pp, 0.8)
            top = pp >= q80
            mcb, dsc = corp(pp, yy)
            bHm = bH if mk is None else bH[mk]
            bfm = bf if mk is None else bf[mk]
            cell[m] = {"n": int(len(pp)), "brier": float(b.mean()), "logs": float(ls.mean()),
                       "bss_fH": float(1 - b.mean() / bHm.mean()), "bss_f": float(1 - b.mean() / bfm.mean()),
                       "R": float(pp.sum() / max(yy.sum(), 1)),
                       "R_top20": float(pp[top].sum() / max(yy[top].sum(), 1)), "MCB": mcb, "DSC": dsc}
        out[f"{TL[T]} {k}"] = cell
    return out


def cmd_score(a):
    out_dir = a.out
    meta = json.load(open(os.path.join(out_dir, "rows-meta.json")))
    keys = meta["series"]
    logf = open(os.path.join(out_dir, "score-log.txt"), "a")

    def log(s):
        line = f"{R12.now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    rng = np.random.default_rng(SEED)
    log(f"START r16 dev score; code {git_sha()}; rows code {meta['code']}")
    res = {"schema": "q26-r16.2-dev/1", "label": "DEVELOPMENT ONLY (seen data)", "code": git_sha(),
           "rows_code": meta["code"], "cells": {}, "tiers": {}, "weights": {}, "fallback_rate": {}}
    D_tier = {t: {} for t in TIERS}
    for T in TS:
        fp = os.path.join(out_dir, f"rows-T{T}.npz")
        if not os.path.exists(fp):
            continue
        Z = np.load(fp)
        R = {k_: Z[k_] for k_ in Z.files}
        n = len(R["ts"])
        L = len(LV[T])
        lnk = np.log1p(np.array(LV[T]))
        P = {m: R[m].astype(np.float32) for m in ALL_ROW_MODELS}
        # cross-fitted gb
        t0 = time.time()

        def mk_gb(tr, te):
            clf = fit_gb(R, tr, lnk, rng)
            idx = np.where(te)[0]
            return np.column_stack([clf.predict_proba(gb_design(R, idx, j, lnk))[:, 1] for j in range(L)])
        P["gb"] = np.minimum.accumulate(crossfit(R, T, keys, log, mk_gb), axis=1)
        log(f"  {TL[T]} gb cross-fit done ({time.time() - t0:.0f}s, {n} rows)")

        def mk_st(tr, te):
            clf = fit_stack_llp(R, tr, P, L, rng)
            idx = np.where(te)[0]
            return np.column_stack([clf.predict_proba(np.column_stack([lg(P[m][idx, j]) for m in STACK]))[:, 1]
                                    for j in range(L)])
        P["st"] = np.minimum.accumulate(crossfit(R, T, keys, log, mk_st), axis=1)

        def mk_lp(tr, te):
            w = fit_lp(R, tr, P, L, rng)
            idx = np.where(te)[0]
            return np.column_stack([np.column_stack([P[m][idx, j] for m in STACK]) @ w for j in range(L)])
        P["lp"] = np.minimum.accumulate(crossfit(R, T, keys, log, mk_lp), axis=1)
        allm = BASE + SCALE_MODELS + ("ms", "gb", "st", "lp")
        cells = score_cells(R, T, P, allm, None, R["sid"], log)
        # simulation models on their daily-origin subset (paired with fH / f on the same rows)
        smask = np.isfinite(P["gS"][:, 0]) & np.isfinite(P["gE"][:, 0])
        if smask.any():
            Rs = {k_: v[smask] for k_, v in R.items()}
            Ps = {m: v[smask] for m, v in P.items()}
            cs = score_cells(Rs, T, Ps, ("fH", "f") + SIM, None, Rs["sid"], log)
            for ck in cs:
                cells[ck]["sim_subset"] = cs[ck]
        res["cells"].update(cells)
        # tier pooled differences
        tier = [t for t, Ts in TIERS.items() if T in Ts][0]
        C = TIER_C[tier]
        Y = R["y"].astype(float)
        dd = {}
        for m in allm + SIM:
            pm = P[m].astype(float)
            mk = np.all(np.isfinite(pm), axis=1)
            d = np.where(mk[:, None], (pm - Y) ** 2 - (P[C] - Y) ** 2, np.nan).sum(axis=1) / L
            dd[m] = d
        dd["_sid"], dd["_ts"] = R["sid"], R["ts"]
        D_tier[tier][T] = dd
        for m in allm:
            fr = float(np.mean([meta["fallback"][k_].get(str(T), meta["fallback"][k_].get(T, {})).get(m, 0)
                                for k_ in keys])) if m in ALL_ROW_MODELS else 0.0
            res["fallback_rate"].setdefault(TL[T], {})[m] = fr
        log(f"  {TL[T]} scored: " + ", ".join(f"{m} {np.mean([cells[c][m]['bss_fH'] for c in cells if c.startswith(TL[T] + ' ')]):+.4f}" for m in allm if m != "fH"))
        del R, P, Z
    # tiers
    for tier, dct in D_tier.items():
        if not dct:
            continue
        C = TIER_C[tier]
        sid = np.concatenate([dct[T]["_sid"] for T in dct])
        ts = np.concatenate([dct[T]["_ts"] for T in dct])
        blk = (ts // (28 * DAY)).astype(np.int64)
        tw = TwoWay(sid, blk, B=1000)
        tr = {}
        for m in list(dct[next(iter(dct))].keys()):
            if m.startswith("_") or m == C or m in BASE:
                continue
            d = np.concatenate([dct[T][m] for T in dct])
            mk = np.isfinite(d)
            if mk.sum() == 0:
                continue
            zz = TwoWay(sid[mk], blk[mk], B=1000).z(d[mk]) if not mk.all() else tw.z(d)
            lk = leave_top_k(sid[mk], d[mk])
            tcells = [c for c in res["cells"] if any(c.startswith(TL[T] + " ") for T in TIERS[tier])]
            if m in SIM:
                bss = [res["cells"][c]["sim_subset"][m]["bss_fH" if C == "fH" else "bss_f"] for c in tcells
                       if "sim_subset" in res["cells"][c]]
                lr = [abs(math.log(res["cells"][c]["sim_subset"][m]["R"])) for c in tcells
                      if "sim_subset" in res["cells"][c]]
                lrC = [abs(math.log(res["cells"][c]["sim_subset"][C]["R"])) for c in tcells
                       if "sim_subset" in res["cells"][c]]
            else:
                bss = [res["cells"][c][m]["bss_fH" if C == "fH" else "bss_f"] for c in tcells]
                lr = [abs(math.log(res["cells"][c][m]["R"])) for c in tcells]
                lrC = [abs(math.log(res["cells"][c][C]["R"])) for c in tcells]
            e1 = zz["z"] is not None and zz["z"] <= -2.0
            e2 = min(bss) >= -0.002 if bss else False
            e3 = lk["mean_after"] is not None and lk["mean_after"] < 0
            e4 = (np.median(lr) <= np.median(lrC) + 0.02) if lr else False
            tr[m] = {"two_way": zz, "leave_top_k": lk, "bss_vs_C_cells": bss, "bss_vs_C_mean": float(np.mean(bss)),
                     "median_abs_lnR": float(np.median(lr)), "median_abs_lnR_C": float(np.median(lrC)),
                     "E1": bool(e1), "E2": bool(e2), "E3": bool(e3), "E4": bool(e4),
                     "eligible": bool(e1 and e2 and e3 and e4), "early_drop": bool(np.mean(bss) < -0.01)}
        elig = sorted([m for m in tr if tr[m]["eligible"]], key=lambda m: tr[m]["two_way"]["z"])
        res["tiers"][tier] = {"comparator": C, "candidates": tr, "eligible_ranked": elig, "selected": elig[:2]}
        log(f"TIER {tier} vs {C}: selected {elig[:2]}; eligible {elig}")
        for m in sorted(tr, key=lambda m: (tr[m]["two_way"]["z"] if tr[m]["two_way"]["z"] is not None else 99)):
            t_ = tr[m]
            log(f"   {m:4s} bssC {t_['bss_vs_C_mean']:+.4f} min {min(t_['bss_vs_C_cells']):+.4f} z {t_['two_way']['z']:+.2f} "
                f"E {int(t_['E1'])}{int(t_['E2'])}{int(t_['E3'])}{int(t_['E4'])} lnR {t_['median_abs_lnR']:.3f}/{t_['median_abs_lnR_C']:.3f}")
    res["finished_utc"] = R12.now_iso()
    with open(os.path.join(out_dir, "dev-r162.json"), "w") as fh:
        json.dump(res, fh, indent=1, default=float)
    log("END score")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("rows")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    s.add_argument("--with-b12", action="store_true")
    s.add_argument("--limit", type=int, default=0)
    s.add_argument("--only", default="")
    s = sub.add_parser("score")
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"rows": cmd_rows, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
