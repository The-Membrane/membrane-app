"""Q26 R11.3 calibration control layer on the frontier touch rung (membrane-board design/Q26_ROUND11_PREREG.md R11.3
and its Deviations D-R11.3*; parents design/Q26_ROUND10_PREREG.md D3, D4, D-R10.5c).

History only: a walk-forward on the A6 development predictions (non-blind history), with the R10.5 D3 live emulation.
The live anytime-valid test (R11.3c) is implemented here (`live_controller`, `eprocess_path`, `live_eprocess`) and
verified on history by block sign-flipping (the p/p' block-swap null). It is NOT wired into the live scorer: that
needs a later pinned APP_SHA and a HISTORY_TOUCH_LIVE Deviation.

  python3 r113_controller.py freeze --out OUT   write and hash the frozen config (UTC timestamp; before any score)
  python3 r113_controller.py run    --out OUT   one fit: grid paths, nested walk-forward selection, final freeze
                                                (frozen-r113.json, hashed), then results (results-history.json)

Controller, per cell (asset, T, depth band), daily at issue time t (00:00Z), using only rows resolved by t:
  delta_t = (1 - rho) * delta_{t-1} + g * sum_i (y_i - p'_i) / max(sum_i p'_i (1 - p'_i), 1)
            over rows i of the cell whose truth window ended in (t - 1 d, t]; delta clipped to [-1, 1]; delta_0 = 0
  p'      = expit(logit p + delta_t), then the running minimum across levels shallow -> deep at that (asset, T, issue)
  p       = the displayed rung (display-a6.json, A6 D3)
No address is read or written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DATASETS = os.environ.get("MEMBRANE_DATASETS", os.path.join(os.path.expanduser("~"), "membrane-datasets"))
A6_DIR = "history-forecasts/a6/run-015512cb"
R105_DIR = "history-forecasts/r10/r105-run-2d377e73"
INPUTS = {
    "predictions-dev-ETH.csv.gz": f"{A6_DIR}/predictions-dev-ETH.csv.gz",
    "predictions-dev-BTC.csv.gz": f"{A6_DIR}/predictions-dev-BTC.csv.gz",
    "predictions-dev-stETH.csv.gz": f"{A6_DIR}/predictions-dev-stETH.csv.gz",
    "display-a6.json": f"{A6_DIR}/display-a6.json",
    "frozen-r105.json": f"{R105_DIR}/frozen-r105.json",
}
DISPLAY_SHA256 = "8e9086179ac40da1ec90976c5ba6a551c3893b002f0b7338a097a777a8362e62"   # HISTORY_TOUCH_LIVE D5
R105_SHA256 = "0f33d1d80edc9f380f1edae1e5d272bd6b0fc25db6e6f86c5624506db69e7b96"      # R10.5 D4
ASSETS = ["ETH", "BTC", "stETH"]
HORIZONS = {"6h": 6, "1d": 24, "3d": 72, "7d": 168, "14d": 336, "30d": 720}
TESTED = ["6h", "1d", "3d"]
GAINS = [0.05, 0.1, 0.2]
MEMORY_DAYS = [30, 90, 180]                     # rho = 1 / memory
GRID = [(g, m) for g in GAINS for m in MEMORY_DAYS]
DELTA_CLIP = 1.0
EPS = 1e-12
ISSUE_HOUR = 0
BURN_IN_DAYS = 120
Q2 = (pd.Timestamp("2026-04-01", tz="UTC"), pd.Timestamp("2026-07-01", tz="UTC"))
BAND_SHALLOW, BAND_MIDDLE = (-0.02, -0.03, -0.05), (-0.07, -0.10, -0.15)
NW_LAG = 7
ALPHA_HIST = 0.025 / 3
K_FAMILY = 6
ALPHA_LIVE = 0.025 / K_FAMILY
BET_CAP = 0.5                                   # lambda_t in [0, 1/2] on the d scale
MAX_LIVE_DAYS = 730
MIN_LNR_DAYS = 30
NULL_BLOCK = 30
NULL_REPS = 2000
NULL_SEED = 20261118
POWER_STEP = 30
R105_W, R105_KAPPA = 90, 20
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

DECISIONS = {
    "R113-1": "Inputs and emulation as R10.5 D3 (R105-1, R105-2): p = the displayed rung per (asset, T) from "
              "display-a6.json; dev issues are the 00:00Z origins only; the dev level grid equals the live grid.",
    "R113-2": "Cells: (asset, T, depth band), A4 bands: ETH and BTC shallow -2/-3/-5%, middle -7/-10/-15%, deep -20% "
              "and deeper; stETH one band. All six T are simulated; only 6h, 1d, 3d are tested.",
    "R113-3": "Daily clock: one step per UTC calendar day from the cell's first issue day to its last, including days "
              "with no issue or no resolved row (decay only). At day t: delta_t = (1 - rho) delta_{t-1} + g * "
              "sum(y - p') / max(sum p'(1 - p'), 1) over the band's rows with origin + T in (t - 24 h, t] (the edge "
              "row ending exactly at t is included, D-R10.5c edge rule); clip to [-1, 1]; then rows issued at t get "
              "p' = expit(logit p + delta_t). p' in the step is the issued p' (after the monotone fix).",
    "R113-4": "p in {0, 1} stays unchanged; otherwise logit uses p clipped to [1e-12, 1 - 1e-12]. Monotone fix: "
              "running minimum across levels shallow -> deep at each (asset, T, issue), not across T.",
    "R113-5": "Selection sample S: issues with t0 >= the asset's first dev origin + 120 days (as R105-6, so the R10.5 "
              "comparator rows match), excluding rows whose (t0, t0 + T] meets 2026-04-01..2026-06-30. Pooled "
              "Brier for selection = mean over S rows of ETH, BTC, stETH at the tested T (6h, 1d, 3d), all levels. "
              "One grid point for all cells. Ties: smaller g, then longer memory.",
    "R113-6": "Nested walk-forward: for each year Y in 2022..2026, the grid point with the lowest pooled Brier on S "
              "tested rows with origin + T <= Y-01-01 is applied to S rows with t0 in Y. Each grid point's delta path "
              "runs continuously from the start; choosing a point for Y selects that path's p' (no reset). Final "
              "frozen point: chosen on all S tested rows (dev origins through 2026-09-30).",
    "R113-7": "History test (R11.3b) per T in 6h, 1d, 3d on the nested walk-forward rows (S, t0 in 2022..2026): "
              "d_t = mean Brier(comparator) - mean Brier(p') over the issue day's rows (all assets, levels). "
              "One-sided Newey-West t-test (Bartlett, lag 7) of mean d > 0, p from Student t with n - 1 df. Pass: "
              "p < 0.025/3 vs the static rung AND vs rung (a) (p_a, plain-history frequency), AND median |ln R| of p' "
              "<= the static rung's over (asset, level) cells with sum y >= 1 (R = sum p / sum y).",
    "R113-8": "E-process (R11.3c): K_n = prod (1 + lambda_t d_t), lambda_t = clip(mu_{t-1} / (s2_{t-1} + "
              "mu_{t-1}^2), 0, 1/2) with mu_t = sum_{i<=t} d_i / (t + 1), s2_t = (1 + sum_{i<=t} (d_i - mu_i)^2) / "
              "(t + 1). This is Waudby-Smith and Ramdas aGRAPA with c = 1/2 and its default priors (1/2, 1/4) on "
              "X = (d + 1)/2, m = 1/2, mapped to d. Missing days are skipped (no bet). T = 3d: three interleaved "
              "subsequences by (issue date ordinal) mod 3, each its own aGRAPA state; the statistic is their mean. "
              "Pass at a pair: max over issue days n <= 730 of K_n >= 1/alpha, alpha = 0.025/6.",
    "R113-9": "Null check: per pair (R10.5 frozen rung; R11.3 nested controller) x (6h, 1d, 3d), the dev daily d "
              "series on S (R11.3: nested rows). Each of 2000 reps draws a window of 730 consecutive issue days "
              "(start uniform; whole series if shorter), flips the sign of d in 30-calendar-day blocks anchored at "
              "the window's first day (independent fair signs = swapping p and p' by block), and runs the e-process "
              "to 730 days. False-pass rate = share of reps with max K >= 1/alpha. A fresh default_rng(20261118) per "
              "pair, pairs in the order R10.5 then R11.3, 6h, 1d, 3d. It must be <= alpha = 0.025/6 per pair.",
    "R113-10": "Reported only: the unflipped dev e-process on 730-day windows starting every 30 issue days (share "
               "reaching 1/alpha, final and max log K), and the capped bound sum log(1 + d/2) (the best constant "
               "bet), per pair; frozen-point in-sample statistics; 7d-30d; per asset; per year; 2026Q2; delta paths; "
               "the frozen R10.5 rung (W 90, kappa 20) on the same rows.",
}


# ---------------------------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------------------------
def logit(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p) - np.log1p(-p)


def expit(x):
    return 1.0 / (1.0 + np.exp(-x))


def band_of(asset, levels):
    if asset == "stETH":
        return np.zeros(len(levels), dtype=int)
    return np.array([0 if k in BAND_SHALLOW else 1 if k in BAND_MIDDLE else 2 for k in levels], dtype=int)


def simulate_cell(day, kpos, p, y, n_levels, bands, T_h, grid):
    """One (asset, T) cell, every grid point at once.
    day: issue-day index per row (0 = the cell's first issue day); kpos: level position, 0 = shallowest.
    y: outcome per row (NaN = unresolved). Returns p' (G, n_rows) and delta paths (G, n_days, n_bands)."""
    day = np.asarray(day, int)
    kpos = np.asarray(kpos, int)
    n_days = int(day.max()) + 1
    P = np.full((n_days, n_levels), np.nan)
    Y = np.full((n_days, n_levels), np.nan)
    P[day, kpos] = p
    Y[day, kpos] = y
    gains = np.array([g for g, _ in grid], float)[:, None]
    rho = np.array([1.0 / m for _, m in grid], float)[:, None]
    G = len(grid)
    bands = np.asarray(bands, int)
    nb = int(bands.max()) + 1
    lag = int(math.ceil(T_h / 24.0))
    delta = np.zeros((G, nb))
    out = np.full((G, n_days, n_levels), np.nan)
    D = np.zeros((G, n_days, nb))
    lp = logit(P)
    for t in range(n_days):
        delta = (1.0 - rho) * delta
        j = t - lag
        if j >= 0:
            yy = Y[j]
            pp = out[:, j, :]
            ok = ~np.isnan(yy) & ~np.isnan(pp[0])
            for b in range(nb):
                m = ok & (bands == b)
                if m.any():
                    q = pp[:, m]
                    num = (yy[m][None, :] - q).sum(axis=1)
                    den = np.maximum((q * (1.0 - q)).sum(axis=1), 1.0)
                    delta[:, b] += gains[:, 0] * num / den
        delta = np.clip(delta, -DELTA_CLIP, DELTA_CLIP)
        D[:, t] = delta
        row = P[t]
        have = ~np.isnan(row)
        if have.any():
            q = expit(lp[t][None, :] + delta[:, bands])
            q = np.where(row[None, :] <= 0.0, 0.0, np.where(row[None, :] >= 1.0, 1.0, q))
            q = np.where(have[None, :], q, np.nan)
            q = np.fmin.accumulate(q, axis=1)            # NaN-skipping running minimum, shallow -> deep
            out[:, t] = np.where(have[None, :], q, np.nan)
    return out[:, day, kpos], D


def apply_controller(d, grid):
    """d: rows with asset, T, k, y, p, t0 (00:00Z). Returns p' (G, n) in d's positional order and delta paths."""
    pr = np.full((len(grid), len(d)), np.nan)
    paths = {}
    pos = np.arange(len(d))
    for (a, T), g in d.groupby(["asset", "T"], sort=False):
        levels = sorted(g["k"].unique(), reverse=True)           # -0.02 (shallow) first
        kmap = {k: i for i, k in enumerate(levels)}
        day0 = g["t0"].dt.floor("D").min()
        day = ((g["t0"].dt.floor("D") - day0) / pd.Timedelta(days=1)).round().astype(int).to_numpy()
        kpos = g["k"].map(kmap).to_numpy()
        bands = band_of(a, levels)
        out, D = simulate_cell(day, kpos, g["p"].to_numpy(float), g["y"].to_numpy(float), len(levels), bands,
                               HORIZONS[T], grid)
        idx = pos[g.index.to_numpy()] if isinstance(d.index, pd.RangeIndex) else d.index.get_indexer(g.index)
        pr[:, idx] = out
        paths[(a, T)] = {"day0": day0, "bands": bands, "levels": levels, "D": D}
    return pr, paths


# ---------------------------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------------------------
def daily_diff(g, col_cmp, col_new):
    """Per issue day: mean Brier(comparator) - mean Brier(new), sorted by day."""
    b = g.assign(bc=(g[col_cmp] - g["y"]) ** 2, bn=(g[col_new] - g["y"]) ** 2)
    per = b.groupby("day")[["bc", "bn"]].mean().sort_index()
    return per.index.to_numpy(), (per["bc"] - per["bn"]).to_numpy()


def hac_test(x, lag=NW_LAG):
    """One-sided Newey-West (Bartlett) t-test of mean > 0. Returns mean, se, t, p (Student t, n - 1 df)."""
    from scipy import stats
    x = np.asarray(x, float)
    n = len(x)
    mu = x.mean()
    e = x - mu
    v = e @ e / n
    for l in range(1, min(lag, n - 1) + 1):
        v += 2.0 * (1.0 - l / (lag + 1.0)) * (e[l:] @ e[:-l]) / n
    se = math.sqrt(max(v, 0.0) / n)
    t = mu / se if se > 0 else (math.inf if mu > 0 else -math.inf if mu < 0 else 0.0)
    p = float(stats.t.sf(t, n - 1))
    return {"n_days": int(n), "mean_d": float(mu), "se": float(se), "t": float(t), "p_one_sided": p}


def med_abs_lnR(g, col):
    vals = []
    for _, c in g.groupby(["asset", "k"]):
        sy = c["y"].sum()
        if sy >= 1:
            vals.append(abs(math.log(max(c[col].sum(), 1e-300) / sy)))
    return (float(np.median(vals)) if vals else None), len(vals)


def basic_stats(g, col):
    b0 = ((g["p"] - g["y"]) ** 2).sum()
    bn = ((g[col] - g["y"]) ** 2).sum()
    return {"n_rows": int(len(g)), "n_days": int(g["day"].nunique()), "n_y": int(g["y"].sum()),
            "brier_new": float(bn / max(len(g), 1)), "brier_static": float(b0 / max(len(g), 1)),
            "bss_vs_static": float(1 - bn / b0) if b0 > 0 else None,
            "R_new": float(g[col].sum() / max(g["y"].sum(), 1e-12)),
            "R_static": float(g["p"].sum() / max(g["y"].sum(), 1e-12))}


# ---------------------------------------------------------------------------------------------
# Anytime-valid e-process (R11.3c)
# ---------------------------------------------------------------------------------------------
def agrapa_wealth(d, cap=BET_CAP):
    """Wealth path K_1..K_n of prod (1 + lambda_t d_t), aGRAPA lambda (predictable), d in [-1, 1]."""
    d = np.asarray(d, float)
    K = np.empty(len(d))
    w = 1.0
    s = 0.0          # sum d_i
    ss = 0.0         # sum (d_i - mu_i)^2
    mu_prev, s2_prev = 0.0, 1.0
    for t, x in enumerate(d):
        lam = mu_prev / (s2_prev + mu_prev * mu_prev)
        lam = min(max(lam, 0.0), cap)
        w *= 1.0 + lam * x
        K[t] = w
        s += x
        mu = s / (t + 2.0)
        ss += (x - mu) ** 2
        mu_prev, s2_prev = mu, (1.0 + ss) / (t + 2.0)
    return K


def day_ordinals(days):
    """Days since 1970-01-01 (UTC dates) for strings, Timestamps or datetime64 values."""
    arr = np.asarray(days)
    if not np.issubdtype(arr.dtype, np.datetime64):
        arr = np.array([np.datetime64(str(x)[:10], "D") for x in arr])
    return arr.astype("datetime64[D]").astype(np.int64)


def eprocess_path(days, d, T, cap=BET_CAP):
    """Statistic path over issue days (sorted). days: issue dates (datetime64 / str / Timestamp). For T = 3d the mean of
    three aGRAPA processes on the (date ordinal) mod 3 subsequences; each process holds its wealth on other days."""
    d = np.asarray(d, float)
    if T != "3d":
        return agrapa_wealth(d, cap)
    sub = day_ordinals(days) % 3
    W = np.ones((3, len(d)))
    for r in range(3):
        m = sub == r
        if m.any():
            K = agrapa_wealth(d[m], cap)
            path = np.full(len(d), np.nan)
            path[np.where(m)[0]] = K
            path = pd.Series(path).ffill().fillna(1.0).to_numpy()
            W[r] = path
    return W.mean(axis=0)


def eprocess_decision(days, d, T, alpha=ALPHA_LIVE, max_days=MAX_LIVE_DAYS):
    days = list(days)[:max_days]
    d = np.asarray(d, float)[:max_days]
    if len(d) == 0:
        return {"n_days": 0, "K_max": 1.0, "K_last": 1.0, "crossed": False, "cross_day": None}
    K = eprocess_path(days, d, T)
    hit = np.where(K >= 1.0 / alpha)[0]
    return {"n_days": int(len(d)), "K_max": float(K.max()), "K_last": float(K[-1]), "crossed": bool(len(hit)),
            "cross_day": (int(hit[0]) + 1) if len(hit) else None}


def null_false_pass(days, d, T, alpha=ALPHA_LIVE, reps=NULL_REPS, seed=NULL_SEED, block=NULL_BLOCK,
                    window=MAX_LIVE_DAYS):
    """Block sign-flip null on a dev daily series: share of reps whose e-process reaches 1/alpha within the window."""
    rng = np.random.default_rng(seed)
    days = day_ordinals(days).astype("datetime64[D]")
    d = np.asarray(d, float)
    n = len(d)
    w = min(window, n)
    hits, kmax = 0, []
    for _ in range(reps):
        s = int(rng.integers(0, n - w + 1))
        dd = d[s:s + w]
        dy = days[s:s + w]
        blk = ((dy - dy[0]) / np.timedelta64(1, "D")).astype(int) // block
        signs = rng.choice([-1.0, 1.0], size=int(blk.max()) + 1)
        K = eprocess_path(dy, dd * signs[blk], T)
        km = float(K.max())
        kmax.append(km)
        hits += km >= 1.0 / alpha
    kmax = np.array(kmax)
    se = math.sqrt(max(hits, 0.5) / reps * (1 - hits / reps) / reps)
    return {"reps": reps, "window_days": int(w), "n_series_days": int(n), "false_pass": int(hits),
            "false_pass_rate": hits / reps, "mc_se": se, "alpha": alpha, "ok": bool(hits / reps <= alpha),
            "Kmax_q50": float(np.quantile(kmax, 0.5)), "Kmax_q99": float(np.quantile(kmax, 0.99)),
            "Kmax_max": float(kmax.max())}


def power_report(days, d, T, alpha=ALPHA_LIVE, step=POWER_STEP, window=MAX_LIVE_DAYS):
    days = list(days)
    d = np.asarray(d, float)
    n = len(d)
    starts = list(range(0, max(n - window, 0) + 1, step)) if n >= window else [0]
    res = []
    for s in starts:
        r = eprocess_decision(days[s:s + window], d[s:s + window], T, alpha, window)
        res.append(r)
    logK = np.log([r["K_last"] for r in res])
    logKmax = np.log([r["K_max"] for r in res])
    bound = [float(np.sum(np.log1p(BET_CAP * d[s:s + window]))) for s in starts]
    return {"windows": len(starts), "share_crossed": float(np.mean([r["crossed"] for r in res])),
            "logK_last_median": float(np.median(logK)), "logK_max_max": float(logKmax.max()),
            "log_threshold": float(math.log(1.0 / alpha)), "capped_bound_logK_median": float(np.median(bound)),
            "capped_bound_logK_max": float(np.max(bound)), "mean_d": float(d.mean()), "sd_d": float(d.std())}


# ---------------------------------------------------------------------------------------------
# Live (designed; wiring needs a new pin and a HISTORY_TOUCH_LIVE Deviation)
# ---------------------------------------------------------------------------------------------
def live_rows(outcomes):
    rows = []
    for o in outcomes:
        if o.get("status") != "resolved" or not o.get("displayed"):
            continue
        p = (o.get("p") or {}).get(o["displayed"])
        if p is None:
            continue
        rows.append({"date": o["date"], "asset": o["asset"], "T": o["T"], "k": float(o["k"]), "y": float(o["y"]),
                     "p": float(p), "t0": pd.Timestamp(int(o["asof"]), unit="s", tz="UTC")})
    df = pd.DataFrame(rows)
    if len(df):
        df = df.drop_duplicates(["date", "asset", "T", "k"]).reset_index(drop=True)
        df["day"] = df["date"]
    return df


def live_controller(outcomes, g, memory_days):
    """p' of the frozen controller on live resolved displayed-rung rows (each row's p' uses rows resolved by its asof)."""
    df = live_rows(outcomes)
    if not len(df):
        return df
    pr, _ = apply_controller(df, [(g, memory_days)])
    return df.assign(p_new=pr[0])


def live_eprocess(df, family_T, alpha=ALPHA_LIVE):
    """df: live rows with day, asset, k, y, p, p_new for ONE rule. Per tested T: e-process decision, |ln R| check
    (>= 30 resolved issue days), status pass / running / not shown."""
    res = {}
    for T in family_T:
        g = df[df["T"] == T] if len(df) else df
        if not len(g):
            res[T] = {"n_days": 0, "status": "running"}
            continue
        days, d = daily_diff(g, "p", "p_new")
        r = eprocess_decision(days, d, T, alpha)
        g730 = g[g["day"].isin(days[:MAX_LIVE_DAYS])]
        m1, _ = med_abs_lnR(g730, "p_new")
        m0, _ = med_abs_lnR(g730, "p")
        r["medAbsLnR_new"], r["medAbsLnR_static"] = m1, m0
        lnr_ok = r["n_days"] >= MIN_LNR_DAYS and m1 is not None and m0 is not None and m1 <= m0
        r["pass"] = bool(r["crossed"] and lnr_ok)
        r["status"] = "pass" if r["pass"] else ("not shown" if r["n_days"] >= MAX_LIVE_DAYS else "running")
        res[T] = r
    return res


# ---------------------------------------------------------------------------------------------
# Data and IO
# ---------------------------------------------------------------------------------------------
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_sha():
    sha = subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", HERE, "status", "--porcelain", "--", "."], text=True).strip()
    return sha, bool(dirty)


def load_dev(displayed):
    frames = []
    for a in ASSETS:
        d = pd.read_csv(os.path.join(DATASETS, INPUTS[f"predictions-dev-{a}.csv.gz"]))
        d["t0"] = pd.to_datetime(d["t0"], utc=True)
        d = d[d["t0"].dt.hour == ISSUE_HOUR].copy()
        p = np.full(len(d), np.nan)
        for T in HORIZONS:
            m = (d["T"] == T).to_numpy()
            p[m] = d.loc[m, "p_" + displayed[a][T]].to_numpy()
        d["p"] = p
        d["asset"] = a
        frames.append(d[["asset", "t0", "T", "k", "y", "regime", "p", "p_a"]])
    d = pd.concat(frames, ignore_index=True)
    if d["p"].isna().any() or d["p_a"].isna().any():
        raise SystemExit("STOP: missing p")
    d["T_h"] = d["T"].map(HORIZONS)
    d["t0_h"] = (d["t0"] - pd.Timestamp("1970-01-01", tz="UTC")).dt.total_seconds() / 3600.0
    d["day"] = d["t0"].dt.strftime("%Y-%m-%d")
    first = d.groupby("asset")["t0"].transform("min")
    end = d["t0"] + pd.to_timedelta(d["T_h"], unit="h")
    d["inQ2"] = (d["t0"] < Q2[1]) & (end > Q2[0])
    d["burnin"] = d["t0"] < first + pd.Timedelta(days=BURN_IN_DAYS)
    d["res"] = end
    d["year"] = d["t0"].dt.year
    return d


def guard(text):
    if ADDR_RE.search(text):
        raise SystemExit("STOP: address-like string in output")


def write_json(path, obj):
    s = json.dumps(obj, indent=1, sort_keys=False, default=float)
    guard(s)
    with open(path, "w") as f:
        f.write(s + "\n")
    return sha256_file(path)


def gkey(g, m):
    return f"g{g}_m{m}"


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------
def frozen_config(created=None):
    sha, dirty = git_sha()
    if dirty:
        raise SystemExit("STOP: uncommitted code")
    ins = {k: {"path": v, "sha256": sha256_file(os.path.join(DATASETS, v))} for k, v in INPUTS.items()}
    if ins["display-a6.json"]["sha256"] != DISPLAY_SHA256:
        raise SystemExit("STOP: display-a6.json sha256 mismatch")
    if ins["frozen-r105.json"]["sha256"] != R105_SHA256:
        raise SystemExit("STOP: frozen-r105.json sha256 mismatch")
    disp = json.load(open(os.path.join(DATASETS, INPUTS["display-a6.json"])))["displayed"]
    return {"schema": "q26-r113/frozen-config/1", "item": "Q26 R11.3 calibration control layer (history + e-process)",
            "prereg": "triccs/membrane-board design/Q26_ROUND11_PREREG.md R11.3 (Deviations D-R11.3*)",
            "createdUTC": created,
            "code": {"repo": "The-Membrane/membrane-app", "sha": sha,
                     "path": "scripts/research/history-forecasts/r113_controller.py"},
            "inputs": ins, "displayed": disp,
            "grid": {"gain": GAINS, "memory_days": MEMORY_DAYS, "rho": "1 / memory_days"},
            "deltaClip": DELTA_CLIP, "eps": EPS, "issueHourUTC": ISSUE_HOUR, "burnInDays": BURN_IN_DAYS,
            "q2Excluded": [str(Q2[0].date()), "2026-06-30"], "testedHorizons": TESTED,
            "nestedYears": [2022, 2023, 2024, 2025, 2026],
            "historyTest": {"nw_lag": NW_LAG, "alpha": ALPHA_HIST, "comparators": ["static", "rung_a"]},
            "eprocess": {"k": K_FAMILY, "alpha": ALPHA_LIVE, "bet_cap": BET_CAP, "max_days": MAX_LIVE_DAYS,
                         "min_lnR_days": MIN_LNR_DAYS, "null_block_days": NULL_BLOCK, "null_reps": NULL_REPS,
                         "null_seed": NULL_SEED, "power_step_days": POWER_STEP},
            "r105Comparator": {"W_days": R105_W, "kappa": R105_KAPPA},
            "decisions": DECISIONS}


def cmd_freeze(out):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "frozen-r113-config.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    created = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    h = write_json(path, frozen_config(created))
    with open(path + ".sha256", "w") as f:
        f.write(f"{h}  frozen-r113-config.json\n")
    print("frozen config", h, created)


def history_block(rows, col):
    """History statistics of p' (col) vs static and rung (a) on rows (one T)."""
    days, d_s = daily_diff(rows, "p", col)
    _, d_a = daily_diff(rows, "p_a", col)
    hs, ha = hac_test(d_s), hac_test(d_a)
    m1, nc = med_abs_lnR(rows, col)
    m0, _ = med_abs_lnR(rows, "p")
    r = basic_stats(rows, col)
    r.update({"hac_vs_static": hs, "hac_vs_rung_a": ha, "medAbsLnR_new": m1, "medAbsLnR_static": m0,
              "n_cells_lnR": nc, "brier_rung_a": float(((rows["p_a"] - rows["y"]) ** 2).mean())})
    return r, days, d_s


def cmd_run(out):
    import r105_recal as R105
    path = os.path.join(out, "frozen-r113-config.json")
    cfg = json.load(open(path))
    want = open(path + ".sha256").read().split()[0]
    if sha256_file(path) != want:
        raise SystemExit("STOP: frozen config hash")
    now = frozen_config(cfg["createdUTC"])
    if now["code"]["sha"] != cfg["code"]["sha"] or now["inputs"] != cfg["inputs"]:
        raise SystemExit("STOP: code or inputs differ from the frozen config")
    log = [f"config {want} created {cfg['createdUTC']} code {cfg['code']['sha']}"]
    d = load_dev(cfg["displayed"])
    y = d["y"].to_numpy(float)
    pr, paths = apply_controller(d, GRID)                       # the one fit: every grid path
    d["p_r105"] = R105.apply_all(d, R105_W, R105_KAPPA)
    S = (~d["burnin"]) & (~d["inQ2"])
    tested = d["T"].isin(TESTED)
    sel = (S & tested).to_numpy()
    briers = ((pr - y[None, :]) ** 2)

    def choose(mask):
        sc = [(float(briers[i, mask].mean()), GAINS.index(g), -MEMORY_DAYS.index(m), i) for i, (g, m) in enumerate(GRID)]
        return min(sc)[3]

    # nested walk-forward
    nested = np.full(len(d), np.nan)
    years = {}
    for Y in cfg["nestedYears"]:
        ys = pd.Timestamp(f"{Y}-01-01", tz="UTC")
        tr = sel & (d["res"] <= ys).to_numpy()
        te = (S & (d["year"] == Y)).to_numpy()
        if tr.sum() == 0 or te.sum() == 0:
            continue
        i = choose(tr)
        nested[te] = pr[i, te]
        q2 = (d["inQ2"] & (d["year"] == Y)).to_numpy()
        years[str(Y)] = {"chosen": {"gain": GRID[i][0], "memory_days": GRID[i][1]}, "train_rows": int(tr.sum()),
                         "test_rows_tested_T": int((te & tested.to_numpy()).sum())}
        if q2.any():
            years[str(Y)]["q2_rows"] = int(q2.sum())
            d.loc[q2, "p_nested_q2"] = pr[i, q2]
    d["p_nested"] = nested
    # final freeze
    i_f = choose(sel)
    g_f, m_f = GRID[i_f]
    sel_brier = {gkey(g, m): float(briers[i, sel].mean()) for i, (g, m) in enumerate(GRID)}
    b_static = float(((d["p"].to_numpy() - y)[sel] ** 2).mean())
    frozen = {"schema": "q26-r113/frozen/1", "configSha256": want, "code": cfg["code"],
              "selected": {"gain": g_f, "memory_days": m_f, "rho": 1.0 / m_f},
              "rule": {"state": "one logit offset delta per (asset, T, depth band); A4 bands",
                       "update": "delta_t = (1 - rho) delta_{t-1} + g sum(y - p') / max(sum p'(1 - p'), 1) over the "
                                 "band's rows resolved in (t - 1 d, t]; clip [-1, 1]; delta_0 = 0; daily at 00:00Z",
                       "output": "p' = expit(logit p + delta_t), then running minimum across levels shallow -> deep",
                       "p": "displayed rung (display-a6.json)", "edges": DECISIONS["R113-4"]},
              "selectionBrier": sel_brier, "selectionBrierStatic": b_static, "selectionRows": int(sel.sum()),
              "liveTest": {"k": K_FAMILY, "alpha": ALPHA_LIVE, "bet": "aGRAPA, cap 1/2", "max_days": MAX_LIVE_DAYS}}
    fh = write_json(os.path.join(out, "frozen-r113.json"), frozen)
    with open(os.path.join(out, "frozen-r113.json.sha256"), "w") as f:
        f.write(f"{fh}  frozen-r113.json\n")
    log.append(f"frozen gain={g_f} memory={m_f}d frozen-r113.json {fh}")
    print(log[-1])

    # ---- results
    d["p_frozen"] = pr[i_f]
    res = {"schema": "q26-r113/results-history/1", "frozenSha256": fh, "configSha256": want,
           "selected": frozen["selected"], "selectionBrier": sel_brier, "selectionBrierStatic": b_static,
           "nestedYears": years, "historyTest": {}, "reportedLongHorizons": {}, "r105SameRows": {},
           "frozenInSample": {}, "perAsset": {}, "perYear": {}, "q2Reported": {}, "deltaPaths": {},
           "eprocessNull": {}, "eprocessPower": {}}
    NR = S & d["p_nested"].notna()
    dserie = {}
    for T in HORIZONS:
        rows = d[NR & (d["T"] == T)]
        blk, days, d_s = history_block(rows, "p_nested")
        if T in TESTED:
            blk["pass"] = bool(blk["hac_vs_static"]["p_one_sided"] < ALPHA_HIST
                               and blk["hac_vs_rung_a"]["p_one_sided"] < ALPHA_HIST
                               and blk["medAbsLnR_new"] is not None and blk["medAbsLnR_static"] is not None
                               and blk["medAbsLnR_new"] <= blk["medAbsLnR_static"])
            res["historyTest"][T] = blk
            dserie[("R11.3", T)] = (days, d_s)
        else:
            res["reportedLongHorizons"][T] = blk
        r5, _, _ = history_block(rows, "p_r105")
        res["r105SameRows"][T] = r5
        fr = d[S & (d["T"] == T)]
        fb, _, _ = history_block(fr, "p_frozen")
        res["frozenInSample"][T] = fb
        for a in ASSETS:
            ga = rows[rows["asset"] == a]
            if len(ga):
                st = basic_stats(ga, "p_nested")
                st["medAbsLnR_new"], st["medAbsLnR_static"] = med_abs_lnR(ga, "p_nested")[0], med_abs_lnR(ga, "p")[0]
                res["perAsset"].setdefault(a, {})[T] = st
        for Y in sorted(rows["year"].unique()):
            gy = rows[rows["year"] == Y]
            res["perYear"].setdefault(str(int(Y)), {})[T] = basic_stats(gy, "p_nested")
        q = d[d["inQ2"] & (d["T"] == T) & d.get("p_nested_q2", pd.Series(np.nan, index=d.index)).notna()]
        if len(q):
            res["q2Reported"][T] = basic_stats(q, "p_nested_q2")
    # delta paths at the frozen point (summary; full daily paths go to deltas-frozen.csv.gz)
    drows = []
    for (a, T), pth in paths.items():
        D = pth["D"][i_f]
        names = ["one"] if a == "stETH" else ["shallow", "middle", "deep"]
        for b, nm in enumerate(names):
            v = D[:, b]
            res["deltaPaths"].setdefault(a, {}).setdefault(T, {})[nm] = {
                "q05": float(np.quantile(v, 0.05)), "median": float(np.median(v)), "q95": float(np.quantile(v, 0.95)),
                "last": float(v[-1]), "share_at_clip": float(np.mean(np.abs(v) >= DELTA_CLIP - 1e-12))}
        dd = pd.DataFrame(D, columns=names)
        dd.insert(0, "day", (pth["day0"] + pd.to_timedelta(np.arange(len(dd)), unit="D")).strftime("%Y-%m-%d"))
        dd.insert(1, "T", T)
        dd.insert(1, "asset", a)
        drows.append(dd)
    deltas = pd.concat(drows, ignore_index=True)
    # e-process null check and power (R10.5 frozen rung on S; R11.3 nested controller)
    for T in TESTED:
        rows5 = d[S & (d["T"] == T)]
        dserie[("R10.5", T)] = daily_diff(rows5, "p", "p_r105")
    for rule in ["R10.5", "R11.3"]:
        for T in TESTED:
            days, dd_ = dserie[(rule, T)]
            res["eprocessNull"].setdefault(rule, {})[T] = null_false_pass(days, dd_, T)
            res["eprocessPower"].setdefault(rule, {})[T] = power_report(days, dd_, T)
            nf = res["eprocessNull"][rule][T]
            log.append(f"null {rule} {T}: false-pass {nf['false_pass']}/{nf['reps']} ok={nf['ok']} "
                       f"Kmax q99 {nf['Kmax_q99']:.3f}")
    res["liveFamily"] = {"R10.5": TESTED, "R11.3": [T for T in TESTED if res["historyTest"][T]["pass"]],
                         "alpha_per_pair": ALPHA_LIVE, "k": K_FAMILY}
    rh = write_json(os.path.join(out, "results-history.json"), res)
    dcsv = os.path.join(out, "deltas-frozen.csv.gz")
    deltas.to_csv(dcsv, index=False, float_format="%.6g")
    log.append(f"results-history.json {rh}")
    log.append(f"deltas-frozen.csv.gz {sha256_file(dcsv)}")
    for T, r in res["historyTest"].items():
        log.append(f"{T} BSS {r['bss_vs_static']:+.5f} p_static {r['hac_vs_static']['p_one_sided']:.4g} "
                   f"p_a {r['hac_vs_rung_a']['p_one_sided']:.4g} med|lnR| {r['medAbsLnR_new']:.3f} vs "
                   f"{r['medAbsLnR_static']:.3f} pass={r['pass']}")
    with open(os.path.join(out, "run-log.txt"), "w") as f:
        f.write("\n".join(log) + "\n")
    print("\n".join(log))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["freeze", "run"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cmd_freeze(a.out) if a.cmd == "freeze" else cmd_run(a.out)


if __name__ == "__main__":
    main()
