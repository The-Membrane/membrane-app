#!/usr/bin/env python3
"""T1 -- does Deribit DVOL implied vol predict liquidation-level touches better than realized vol?

Implements triccs/membrane-board `design/VALIDATION_PREREG.md` (commit 506e7c5), section T1
(T1.1-T1.8), as registered. Retrospective only: every row carries kind="retrospective" and
asof = t0 (the simulated information time). No row has an issue-timestamp field (prereg 0, T1.2).

One fit, then one score:
  python3 t1_touch.py --datasets DIR --out DIR --phase fit    # calibration rows -> isotonic maps (+sha256)
  python3 t1_touch.py --datasets DIR --out DIR --phase score  # test rows -> Brier/BSS/CI/ECE/verdict
  --phase all runs both in sequence (use a fresh --out to reproduce).
The fit phase refuses to overwrite existing maps and the score phase refuses to overwrite existing
results (prereg T1.4 "Scored ONCE", T1.5 "Fitted once").

stdlib + numpy only.

Public API for the live issuer (T5):
  load_maps(path, expected_sha256=None) -> maps
  features_at(grid, dvol_close, t0)      -> {"S", "DVOL", "RV30", "RV90"} (None where missing)
  touch_forecast(asset, S, sigma, levels, horizons, maps, source="DVOL") -> rows with p_raw, p_cal
"""
import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
import platform
import sys
import time
from datetime import datetime, timezone

import numpy as np

# ---------------------------------------------------------------------------------------------
# Registered constants (prereg T1.1-T1.7). Changing any of these is a deviation.
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/VALIDATION_PREREG.md",
    "commit": "506e7c5",
    "section": "T1 (T1.1-T1.8)",
}

INPUTS = {  # T1.1 frozen inputs: relative path in membrane-datasets -> sha256
    "eth_price": ("price-history/eth-usd-1h.json",
                  "48b53d72351dbba6b05939a75660babc361678304747bf764d59e97d968bd26c"),
    "btc_price": ("price-history/btc-usd-1h.json",
                  "07ba823671e557a7a73415903f8c4be153c1bb6f0ca1215361eb2304a6bd5d37"),
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


CALIB_START = utc("2021-03-25T00:00:00Z")  # T1.4: first day with a DVOL candle opening at t0-1h
SPLIT = utc("2024-01-01T00:00:00Z")        # T1.4: calibration labels end <= SPLIT; test t0 >= SPLIT
TEST_END = utc("2026-10-06T03:00:00Z")     # T1.4: last close of the frozen price data
BOUNDS = (CALIB_START, SPLIT, TEST_END)

ASSETS = ("ETH", "BTC")
LEVELS = (-0.05, -0.10, -0.15, -0.20, -0.30)   # T1.2
HORIZONS = (1, 3, 7, 14, 30)                    # T1.2, days
SOURCES = ("DVOL", "RV30", "RV90")
RV_DAYS = {"RV30": 30, "RV90": 90}              # number of daily log returns
SEED = 20261012                                  # T1.6
N_BOOT = 2000                                    # T1.6
ECE_BINS = 10                                    # T1.6
ECE_MAX = 0.05                                   # T1.7 (B)
MIN_HORIZONS = 3                                 # T1.7 (A)

# Fixed comparison order (model, baseline). The bootstrap day indices are drawn ONCE per horizon
# (horizons in order 1,3,7,14,30 from one generator) and shared by every comparison and subset at
# that horizon, so comparisons consume no random numbers and their order cannot change any CI.
COMPARISONS = (
    ("primary_calDVOL_vs_calRV30", "cal_DVOL", "cal_RV30"),
    ("rawDVOL_vs_rawRV30", "raw_DVOL", "raw_RV30"),
    ("calDVOL_vs_rawRV30", "cal_DVOL", "raw_RV30"),
    ("calDVOL_vs_calRV90", "cal_DVOL", "cal_RV90"),
    ("rawDVOL_vs_rawRV90", "raw_DVOL", "raw_RV90"),
    ("calDVOL_vs_rawRV90", "cal_DVOL", "raw_RV90"),
    ("calRV30_vs_calRV90", "cal_RV30", "cal_RV90"),
    ("calDVOL_vs_rawDVOL", "cal_DVOL", "raw_DVOL"),
)
PREDICTORS = ("cal_DVOL", "cal_RV30", "cal_RV90", "raw_DVOL", "raw_RV30", "raw_RV90")


def block_length(T):
    return max(30, 2 * T)  # T1.6


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
    """Check the four T1.1 sha256 values. Any mismatch -> SystemExit (STOP)."""
    meta = {}
    for key, (rel, want) in INPUTS.items():
        path = os.path.join(datasets_dir, rel)
        got = sha256_file(path)
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for {rel}: got {got}, registered {want}")
        meta[key] = {"path": rel, "sha256": got, "bytes": os.path.getsize(path), "verified": True}
    return meta


def _to_float_array(values):
    return np.array([np.nan if v is None else float(v) for v in values], dtype=float)


class PriceGrid:
    """Hourly grid. Hour i opens at start + step*i. col[i] for a close column is the price at the
    hour's END; col[i] for a low column is the minimum inside hour i. Nulls are NaN."""

    def __init__(self, start, step, columns):
        self.start = int(start)
        self.step = int(step)
        self.cols = {k: _to_float_array(v) for k, v in columns.items()}
        lens = {len(v) for v in self.cols.values()}
        if len(lens) != 1:
            raise ValueError("columns differ in length")
        self.n = lens.pop()

    @property
    def end_ts(self):
        """Close time of the last hour."""
        return self.start + self.step * self.n

    def index_of_open(self, ts):
        d = int(ts) - self.start
        if d % self.step:
            raise ValueError(f"{ts} is not on the hourly grid")
        i = d // self.step
        return i if 0 <= i < self.n else None

    def value_at_open(self, col, ts):
        """Value of `col` for the hour OPENING at ts (a close column -> price at ts + 1h)."""
        i = self.index_of_open(ts)
        if i is None:
            return None
        v = self.cols[col][i]
        return float(v) if math.isfinite(v) else None

    def window_min(self, col, first_open, last_open):
        """min(col[j]) over hours j opening in [first_open, last_open] (inclusive).
        None if any hour is null or outside the grid."""
        i0 = self.index_of_open(first_open)
        i1 = self.index_of_open(last_open)
        if i0 is None or i1 is None or i1 < i0:
            return None
        seg = self.cols[col][i0:i1 + 1]
        if not np.all(np.isfinite(seg)):
            return None
        return float(seg.min())


def load_price_grid(path):
    with open(path) as f:
        d = json.load(f)
    if int(d["startTs"]) != START_TS or int(d["stepSeconds"]) != STEP:
        raise SystemExit(f"STOP: {path} grid is not startTs={START_TS}, step={STEP}")
    cols = {c: d["columns"][c] for c in ("oracle", "oracleLow", "binanceLow")}
    return PriceGrid(d["startTs"], d["stepSeconds"], cols)


def load_dvol(path):
    """-> {open_seconds: close (vol points) or None}."""
    with open(path) as f:
        d = json.load(f)
    out = {}
    for row in d["rows"]:
        open_ms, close = int(row[0]), row[4]
        if open_ms % 1000:
            raise SystemExit(f"STOP: DVOL open_ms not whole seconds: {open_ms}")
        out[open_ms // 1000] = None if close is None else float(close)
    return out


def load_all(datasets_dir):
    grids = {
        "ETH": load_price_grid(os.path.join(datasets_dir, INPUTS["eth_price"][0])),
        "BTC": load_price_grid(os.path.join(datasets_dir, INPUTS["btc_price"][0])),
    }
    dvols = {
        "ETH": load_dvol(os.path.join(datasets_dir, INPUTS["eth_dvol"][0])),
        "BTC": load_dvol(os.path.join(datasets_dir, INPUTS["btc_dvol"][0])),
    }
    return grids, dvols


# ---------------------------------------------------------------------------------------------
# Forecast (T1.2)
# ---------------------------------------------------------------------------------------------
def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def touch_prob(k, sigma, T):
    """Zero-drift first passage: p = min(1, 2*Phi(ln(1+k) / (sigma*sqrt(T/365))))."""
    return min(1.0, 2.0 * norm_cdf(math.log(1.0 + k) / (sigma * math.sqrt(T / 365.0))))


def realized_vol(closes):
    """breach-surface estimator. closes = [P_0, P_1, ..., P_K], P_k = daily close k days back.
    Log returns ln(P_k/P_{k+1}), mean removed, sample variance (n-1), x365, sqrt.
    Any null / non-positive close -> None."""
    for c in closes:
        if c is None or not math.isfinite(c) or c <= 0:
            return None
    r = [math.log(closes[k] / closes[k + 1]) for k in range(len(closes) - 1)]
    n = len(r)
    if n < 2:
        return None
    m = math.fsum(r) / n
    var = math.fsum((x - m) ** 2 for x in r) / (n - 1)
    return math.sqrt(var * 365.0)


def _valid_sigma(s):
    return s if (s is not None and math.isfinite(s) and s > 0) else None


def features_at(grid, dvol_close, t0):
    """Inputs known at info time t0 (UTC midnight).
    S        = oracle close of the hour opening at t0-1h (= price at t0).
    DVOL     = close of the DVOL candle opening at t0-1h, / 100.
    RV30/90  = realized_vol over P_k = oracle close of the hour opening at t0-1h-k*86400,
               k = 0..30 / 0..90.
    Missing input -> None (no forecast for that source)."""
    t_s = t0 - STEP
    out = {"S": grid.value_at_open("oracle", t_s)}
    dv = dvol_close.get(t_s)
    out["DVOL"] = _valid_sigma(dv / 100.0) if dv is not None else None
    for name, K in RV_DAYS.items():
        closes = [grid.value_at_open("oracle", t_s - k * DAY) for k in range(K + 1)]
        out[name] = _valid_sigma(realized_vol(closes))
    return out


def touch_forecast(asset, S, sigma, levels=LEVELS, horizons=HORIZONS, maps=None, source="DVOL"):
    """Raw and calibrated touch probabilities for one asset at one information time.

    sigma: annualized vol as a fraction (0.55 = 55%), or a dict {source: sigma} to forecast several
    sources at once. maps: output of load_maps() (or None -> p_cal is None). Maps are pooled over
    assets, so `asset` only labels the rows. Returns a list of dicts
    {asset, source, T, k, S, L, sigma, p_raw, p_cal}."""
    sig = sigma if isinstance(sigma, dict) else {source: sigma}
    rows = []
    for src, s in sig.items():
        for T in horizons:
            for k in levels:
                p_raw = touch_prob(k, s, T)
                p_cal = None
                if maps is not None:
                    p_cal = float(apply_map(maps[src][int(T)], np.array([p_raw]))[0])
                rows.append({"asset": asset, "source": src, "T": int(T), "k": k, "S": S,
                             "L": S * (1.0 + k), "sigma": s, "p_raw": p_raw, "p_cal": p_cal})
    return rows


# ---------------------------------------------------------------------------------------------
# Split + truth (T1.3, T1.4)
# ---------------------------------------------------------------------------------------------
def split_of(t0, T, bounds=BOUNDS):
    """'calib' iff t0 >= calib_start and t0 + T days <= split (label purge);
    'test' iff t0 >= split and t0 + T days <= test_end; else None (purged / out of range)."""
    calib_start, split, test_end = bounds
    end = t0 + T * DAY
    if t0 >= calib_start and end <= split:
        return "calib"
    if t0 >= split and end <= test_end:
        return "test"
    return None


def truth_window(t0, T):
    """Hours j opening in [t0, t0 + T*86400 - 3600], i.e. the window (t0, t0 + T]."""
    return t0, t0 + T * DAY - STEP


def build_rows(grids, dvols, which, bounds=BOUNDS, levels=LEVELS, horizons=HORIZONS):
    """All paired rows of one set ('calib' or 'test') plus drop accounting.
    A row is kept only if S, sigma_DVOL, sigma_RV30, sigma_RV90 and the oracle truth all exist."""
    calib_start, split, test_end = bounds
    d0, d_end = (calib_start, split) if which == "calib" else (split, test_end)
    rows = []
    acct = {T: {"candidates": 0, "kept": 0, "no_S": 0, "no_DVOL": 0, "no_RV30": 0, "no_RV90": 0,
                "no_truth_oracle": 0, "rv90_only_drop": 0, "kept_no_truth_binance": 0}
            for T in horizons}
    t0 = d0
    while t0 + min(horizons) * DAY <= d_end:
        for asset in ASSETS:
            f = features_at(grids[asset], dvols[asset], t0)
            for T in horizons:
                if split_of(t0, T, bounds) != which:
                    continue
                a, b = truth_window(t0, T)
                lo_or = grids[asset].window_min("oracleLow", a, b)
                lo_bn = grids[asset].window_min("binanceLow", a, b)
                for k in levels:
                    ac = acct[T]
                    ac["candidates"] += 1
                    miss = {"no_S": f["S"] is None, "no_DVOL": f["DVOL"] is None,
                            "no_RV30": f["RV30"] is None, "no_RV90": f["RV90"] is None,
                            "no_truth_oracle": lo_or is None}
                    for key, v in miss.items():
                        ac[key] += int(v)
                    if miss["no_RV90"] and not (miss["no_S"] or miss["no_DVOL"] or miss["no_RV30"]
                                                or miss["no_truth_oracle"]):
                        ac["rv90_only_drop"] += 1
                    if any(miss.values()):
                        continue
                    S = f["S"]
                    L = S * (1.0 + k)
                    row = {"kind": "retrospective", "asof": t0, "asset": asset, "T": T, "k": k,
                           "S": S, "L": L,
                           "sigma_DVOL": f["DVOL"], "sigma_RV30": f["RV30"], "sigma_RV90": f["RV90"],
                           "y_oracle": 1 if lo_or <= L else 0,
                           "y_binance": None if lo_bn is None else (1 if lo_bn <= L else 0)}
                    for src in SOURCES:
                        row["p_raw_" + src] = touch_prob(k, f[src], T)
                    ac["kept"] += 1
                    ac["kept_no_truth_binance"] += int(lo_bn is None)
                    rows.append(row)
        t0 += DAY
    return rows, acct


def to_columns(rows):
    cols = {}
    for key in ("asof", "T"):
        cols[key] = np.array([r[key] for r in rows], dtype=np.int64)
    for key in ("k", "S", "L", "sigma_DVOL", "sigma_RV30", "sigma_RV90",
                "p_raw_DVOL", "p_raw_RV30", "p_raw_RV90", "y_oracle"):
        cols[key] = np.array([r[key] for r in rows], dtype=float)
    cols["y_binance"] = np.array([np.nan if r["y_binance"] is None else r["y_binance"] for r in rows],
                                 dtype=float)
    cols["asset"] = np.array([r["asset"] for r in rows])
    return cols


# ---------------------------------------------------------------------------------------------
# Calibration: isotonic regression by pool-adjacent-violators (T1.5)
# ---------------------------------------------------------------------------------------------
def pava(y, w):
    """Weighted increasing isotonic regression. Returns the fitted value for each input (inputs in
    x-order). Adjacent blocks are pooled while the left block mean exceeds the right one."""
    sums, wts, cnts = [], [], []
    for yi, wi in zip(np.asarray(y, float), np.asarray(w, float)):
        s, ww, c = yi * wi, wi, 1
        while sums and sums[-1] / wts[-1] > s / ww:
            s += sums.pop()
            ww += wts.pop()
            c += cnts.pop()
        sums.append(s)
        wts.append(ww)
        cnts.append(c)
    return np.repeat(np.array(sums) / np.array(wts), cnts)


def aggregate_ties(x, y):
    """Unique sorted x, mean y per unique x, count per unique x."""
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    order = np.argsort(x, kind="mergesort")
    xs, ys = x[order], y[order]
    ux, first, counts = np.unique(xs, return_index=True, return_counts=True)
    sums = np.add.reduceat(ys, first)
    return ux, sums / counts, counts


def fit_isotonic(x, y):
    """Unit weights on rows; ties in x aggregated first (mean y, weight = count) -> PAVA."""
    ux, my, cnt = aggregate_ties(x, y)
    fy = pava(my, cnt)
    return {"x": [float(v) for v in ux], "y": [float(v) for v in fy],
            "n_rows": int(cnt.sum()), "n_unique_x": int(len(ux)),
            "n_tied_rows": int(cnt.sum() - len(ux)), "n_levels": int(len(np.unique(fy)))}


def apply_map(m, p):
    """numpy.interp over the unique fitted x (constant beyond the ends), clipped to [0, 1]."""
    return np.clip(np.interp(np.asarray(p, float), np.asarray(m["x"], float),
                             np.asarray(m["y"], float)), 0.0, 1.0)


def map_sha256(source, T, m):
    blob = json.dumps({"source": source, "T": int(T), "x": m["x"], "y": m["y"]},
                      separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def maps_from_json(obj):
    out = {}
    for src, by_T in obj["maps"].items():
        out[src] = {int(T): {"x": m["x"], "y": m["y"]} for T, m in by_T.items()}
    return out


def load_maps(path, expected_sha256=None, verify_each=True):
    """Load calibration-maps.json. Optional whole-file sha256 check; per-map sha256 always checked."""
    if expected_sha256 is not None:
        got = sha256_file(path)
        if got != expected_sha256:
            raise ValueError(f"maps sha256 {got} != expected {expected_sha256}")
    with open(path) as f:
        obj = json.load(f)
    maps = maps_from_json(obj)
    if verify_each:
        for src, by_T in obj["maps"].items():
            for T, m in by_T.items():
                if map_sha256(src, T, m) != m["sha256"]:
                    raise ValueError(f"map {src}/T={T} sha256 mismatch")
    return maps


def add_calibrated(cols, maps):
    for src in SOURCES:
        p = np.empty(len(cols["T"]))
        for T in np.unique(cols["T"]):
            m = cols["T"] == T
            p[m] = apply_map(maps[src][int(T)], cols["p_raw_" + src][m])
        cols["p_cal_" + src] = p
    return cols


def predictor(cols, name):
    kind, src = name.split("_")
    return cols[("p_cal_" if kind == "cal" else "p_raw_") + src]


# ---------------------------------------------------------------------------------------------
# Metrics (T1.6)
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
    """(n_rep, n_days) matrix: how many times each day is drawn in each replicate."""
    n_rep = idx.shape[0]
    flat = (idx + np.arange(n_rep)[:, None] * n_days).ravel()
    return np.bincount(flat, minlength=n_rep * n_days).reshape(n_rep, n_days)


def bss_ci(day_idx, n_days, p_model, p_base, y, counts):
    """Point BSS = 1 - B_model/B_base and the 95% percentile interval over replicates. Each drawn day
    carries all its rows; model and baseline share the same draws."""
    se_m = np.bincount(day_idx, weights=(p_model - y) ** 2, minlength=n_days)
    se_b = np.bincount(day_idx, weights=(p_base - y) ** 2, minlength=n_days)
    n = len(y)
    out = {"n_rows": int(n), "n_days_with_rows": int(np.count_nonzero(np.bincount(day_idx, minlength=n_days))),
           "brier_model": float(se_m.sum() / n), "brier_baseline": float(se_b.sum() / n)}
    out["bss"] = float(1.0 - se_m.sum() / se_b.sum()) if se_b.sum() > 0 else None
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (counts @ se_m) / (counts @ se_b)
    fin = np.isfinite(reps)
    out["n_nonfinite_reps"] = int((~fin).sum())
    if fin.sum():
        lo, hi = np.percentile(reps[fin], [2.5, 97.5])
        out["ci95"] = [float(lo), float(hi)]
        out["ci_above_0"] = bool(lo > 0)
        out["ci_below_0"] = bool(hi < 0)
    else:
        out["ci95"], out["ci_above_0"], out["ci_below_0"] = None, False, False
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
               "mean_p": None, "mean_y": None, "abs_gap": None}
        if n_b:
            mp, my = float(p[m].mean()), float(y[m].mean())
            row.update(mean_p=mp, mean_y=my, abs_gap=abs(my - mp))
            ece += (n_b / N) * abs(my - mp)
        table.append(row)
    return float(ece), table


def ece_equal_mass(p, y, nbins=ECE_BINS):
    """Sort by p (stable), split rows into nbins contiguous chunks of near-equal size
    (numpy.array_split); tied p may straddle a chunk boundary."""
    p = np.asarray(p, float)
    y = np.asarray(y, float)
    order = np.argsort(p, kind="mergesort")
    N = len(p)
    ece, table = 0.0, []
    for i, ch in enumerate(np.array_split(order, nbins)):
        n_b = len(ch)
        row = {"bin": i, "p_lo": None, "p_hi": None, "n": n_b, "mean_p": None, "mean_y": None,
               "abs_gap": None}
        if n_b:
            mp, my = float(p[ch].mean()), float(y[ch].mean())
            row.update(p_lo=float(p[ch].min()), p_hi=float(p[ch].max()), mean_p=mp, mean_y=my,
                       abs_gap=abs(my - mp))
            ece += (n_b / N) * abs(my - mp)
        table.append(row)
    return float(ece), table


# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------
CSV_COLS = ("kind", "asof", "asset", "T", "k", "S", "L", "sigma_dvol", "sigma_rv30", "sigma_rv90",
            "p_raw_dvol", "p_raw_rv30", "p_raw_rv90", "p_cal_dvol", "p_cal_rv30", "p_cal_rv90",
            "y_oracle", "y_binance")


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return "" if not math.isfinite(v) else repr(v)
    return str(v)


def write_forecasts_csv_gz(path, cols):
    """Deterministic gzip (mtime=0, no embedded filename)."""
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            with io.TextIOWrapper(gz, encoding="utf-8", newline="") as txt:
                w = csv.writer(txt, lineterminator="\n")
                w.writerow(CSV_COLS)
                for i in range(len(cols["T"])):
                    yb = cols["y_binance"][i]
                    w.writerow([
                        "retrospective", iso(cols["asof"][i]), cols["asset"][i], int(cols["T"][i]),
                        _fmt(float(cols["k"][i])), _fmt(float(cols["S"][i])), _fmt(float(cols["L"][i])),
                        _fmt(float(cols["sigma_DVOL"][i])), _fmt(float(cols["sigma_RV30"][i])),
                        _fmt(float(cols["sigma_RV90"][i])),
                        _fmt(float(cols["p_raw_DVOL"][i])), _fmt(float(cols["p_raw_RV30"][i])),
                        _fmt(float(cols["p_raw_RV90"][i])),
                        _fmt(float(cols["p_cal_DVOL"][i])), _fmt(float(cols["p_cal_RV30"][i])),
                        _fmt(float(cols["p_cal_RV90"][i])),
                        int(cols["y_oracle"][i]), "" if not math.isfinite(yb) else int(yb)])


def write_json(path, obj, compact=False):
    with open(path, "w") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"))
        else:
            json.dump(obj, f, indent=2)
        f.write("\n")


def _clean(o):
    """Replace NaN/inf by None so the JSON is strict."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if isinstance(o, np.floating):
        return _clean(float(o))
    if isinstance(o, np.integer):
        return int(o)
    return o


def base_rates(cols, truth="y_oracle", by_asset=False):
    out = {}
    for T in sorted(set(int(t) for t in cols["T"])):
        out[str(T)] = {}
        for k in LEVELS:
            m = (cols["T"] == T) & (cols["k"] == k)
            y = cols[truth][m]
            y = y[np.isfinite(y)]
            out[str(T)][str(k)] = {"n": int(len(y)), "rate": float(y.mean()) if len(y) else None}
        m = cols["T"] == T
        y = cols[truth][m]
        y = y[np.isfinite(y)]
        out[str(T)]["all_levels"] = {"n": int(len(y)), "rate": float(y.mean()) if len(y) else None}
    return out


def set_counts(cols, acct):
    out = {}
    for T in HORIZONS:
        m = cols["T"] == T
        out[str(T)] = {"n_rows": int(m.sum()), "n_days": int(len(np.unique(cols["asof"][m]))),
                       "first_asof": iso(cols["asof"][m].min()) if m.any() else None,
                       "last_asof": iso(cols["asof"][m].max()) if m.any() else None,
                       "n_rows_ETH": int((m & (cols["asset"] == "ETH")).sum()),
                       "n_rows_BTC": int((m & (cols["asset"] == "BTC")).sum()),
                       "drop_accounting": acct[T]}
    return out


DECISIONS = [
    "Info time t0 = each UTC day 00:00; S = oracle close of the hour opening at t0-1h; sigma_DVOL = close "
    "of the DVOL candle opening at t0-1h / 100; RV30/RV90 = breach-surface estimator over oracle closes of "
    "the hours opening at t0-1h-k*86400 (k=0..30 / 0..90), mean removed, ddof=1, x365, sqrt (math.fsum).",
    "Return direction ln(P_k/P_{k+1}) (newer over older); sign does not affect the variance.",
    "A sigma that is null, non-finite or <= 0 counts as missing (none occurred if drop counts show 0).",
    "Phi(x) = 0.5*(1+math.erf(x/sqrt 2)) as registered; deep-tail raw p underflows to exactly 0.0 "
    "(those rows are ties at x=0 in the isotonic fit).",
    "Paired sets: a row is kept only if S, sigma_DVOL, sigma_RV30, sigma_RV90 and the oracle truth exist. "
    "Binance-truth metrics use the subset of kept rows whose binanceLow window has no null.",
    "Truth window: hours opening in [t0, t0+T*86400-3600]; y=1 iff min(low) <= L = S*(1+k); any null "
    "low in the window -> no truth.",
    "Split: calib iff t0 >= 2021-03-25T00Z and t0+T*86400 <= 2024-01-01T00Z; test iff t0 >= 2024-01-01T00Z "
    "and t0+T*86400 <= 2026-10-06T03Z; other rows are purged.",
    "Isotonic: ties in x aggregated before PAVA (mean y, weight = count of rows) = unit row weights; "
    "PAVA pools while left block mean > right block mean (strict); stored x = every unique calibration x, "
    "y = fitted value at it; prediction numpy.interp (constant beyond ends) clipped to [0,1].",
    "Maps are applied as re-read from calibration-maps.json (JSON float repr round-trips exactly).",
    "Bootstrap: one numpy.random.default_rng(20261012); for T in 1,3,7,14,30 (in that order) ONE draw "
    "rng.integers(0, N_days-b_T+1, size=(2000, ceil(N_days/b_T))) of block starts; the same day indices "
    "are shared by every comparison, subset and truth at that horizon (comparisons consume no random "
    "numbers). Issue days = sorted unique asof with >= 1 paired row at that horizon.",
    "CI = numpy.percentile(replicate BSS, [2.5, 97.5]) (linear interpolation). 'Entirely above 0' = lower "
    "bound > 0 (strict).",
    "Replicate BSS = 1 - sum_d c_d*SE_model(d) / sum_d c_d*SE_base(d) where c_d = times day d is drawn; "
    "per-asset / per-level / Binance subsets use the same draws (a drawn day carries only its subset rows).",
    "ECE equal-width: edges b/10, bin = searchsorted(edges, p, 'right')-1 clipped to 0..9 (p=1 in last "
    "bin). Equal-mass: stable argsort by p, numpy.array_split into 10 chunks (ties may straddle chunks).",
    "Comparison order (fixed): " + ", ".join(c[0] for c in COMPARISONS) +
    "; subsets in order all, asset ETH, asset BTC, level -0.05..-0.30; truths oracle then binance (binance: "
    "subset all only).",
]


# ---------------------------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------------------------
def run_fit(grids, dvols, out_dir, bounds=BOUNDS, input_meta=None, overwrite=False, log=print):
    os.makedirs(out_dir, exist_ok=True)
    maps_path = os.path.join(out_dir, "calibration-maps.json")
    if os.path.exists(maps_path) and not overwrite:
        raise SystemExit(f"STOP: {maps_path} exists. The fit runs once; use a fresh --out to reproduce.")
    t_start = time.time()
    rows, acct = build_rows(grids, dvols, "calib", bounds)
    cols = to_columns(rows)
    log(f"calibration rows: {len(rows)}")
    maps_obj = {"test": "T1", "prereg": PREREG, "kind": "retrospective",
                "method": "isotonic regression, pool-adjacent-violators, increasing; ties in x aggregated "
                          "(mean y, weight=count) before PAVA; one map per sigma source x horizon, pooled "
                          "over ETH+BTC and all five levels; truth = oracleLow touch; prediction = "
                          "numpy.interp(p_raw, x, y) clipped to [0,1], constant beyond the ends",
                "fit_set": {"calib_start": iso(bounds[0]), "label_end_max": iso(bounds[1])},
                "maps": {}}
    for src in SOURCES:
        maps_obj["maps"][src] = {}
        for T in HORIZONS:
            m = cols["T"] == T
            fit = fit_isotonic(cols["p_raw_" + src][m], cols["y_oracle"][m])
            fit["sha256"] = map_sha256(src, T, fit)
            maps_obj["maps"][src][str(T)] = fit
            log(f"  map {src} T={T}: rows={fit['n_rows']} unique_x={fit['n_unique_x']} "
                f"levels={fit['n_levels']}")
    write_json(maps_path, maps_obj, compact=True)
    maps_sha = sha256_file(maps_path)
    maps = load_maps(maps_path, expected_sha256=maps_sha)
    add_calibrated(cols, maps)
    write_forecasts_csv_gz(os.path.join(out_dir, "forecasts-calib.csv.gz"), cols)
    insample = {}
    for T in HORIZONS:
        m = cols["T"] == T
        insample[str(T)] = {name: brier(predictor(cols, name)[m], cols["y_oracle"][m])
                            for name in PREDICTORS}
    summary = {
        "test": "T1", "phase": "fit", "prereg": PREREG, "kind": "retrospective",
        "code": {"path": "scripts/research/validation/t1_touch.py",
                 "sha256": sha256_file(os.path.abspath(__file__))},
        "inputs": input_meta,
        "bounds": {"calib_start": iso(bounds[0]), "split": iso(bounds[1]), "test_end": iso(bounds[2])},
        "calibration_maps": {
            "file": "calibration-maps.json", "sha256": maps_sha, "bytes": os.path.getsize(maps_path),
            "per_map": {src: {str(T): {k: maps_obj["maps"][src][str(T)][k]
                                       for k in ("sha256", "n_rows", "n_unique_x", "n_tied_rows", "n_levels")}
                              for T in HORIZONS} for src in SOURCES}},
        "calibration_set": set_counts(cols, acct),
        "calibration_base_rates_oracle": base_rates(cols, "y_oracle"),
        "calibration_base_rates_binance": base_rates(cols, "y_binance"),
        "calibration_insample_brier_oracle": insample,
        "fit_seconds": round(time.time() - t_start, 3),
        "fit_finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    write_json(os.path.join(out_dir, "fit-summary.json"), _clean(summary))
    log(f"maps sha256 {maps_sha}")
    return summary


def run_score(grids, dvols, out_dir, bounds=BOUNDS, n_boot=N_BOOT, seed=SEED, input_meta=None,
              overwrite=False, log=print):
    results_path = os.path.join(out_dir, "results.json")
    if os.path.exists(results_path) and not overwrite:
        raise SystemExit(f"STOP: {results_path} exists. The test set is scored once.")
    t_start = time.time()
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(os.path.join(out_dir, "fit-summary.json")) as f:
        fit_summary = json.load(f)
    maps_path = os.path.join(out_dir, "calibration-maps.json")
    maps_sha = fit_summary["calibration_maps"]["sha256"]
    maps = load_maps(maps_path, expected_sha256=maps_sha)  # unchanged since the fit or STOP

    rows, acct = build_rows(grids, dvols, "test", bounds)
    cols = to_columns(rows)
    add_calibrated(cols, maps)
    log(f"test rows: {len(rows)}")

    rng = np.random.default_rng(seed)  # created ONCE
    subsets = [("all", None)] + [("asset", a) for a in ASSETS] + [("level", k) for k in LEVELS]
    comparisons, brier_tab, boot_meta = [], {}, {}
    for T in HORIZONS:  # draw order: 1, 3, 7, 14, 30
        mT = cols["T"] == T
        days = np.unique(cols["asof"][mT])
        n_days = len(days)
        b = block_length(T)
        idx = block_bootstrap_indices(rng, n_days, b, n_boot)
        counts = replicate_counts(idx, n_days)
        boot_meta[str(T)] = {"n_days": int(n_days), "block_length": b,
                             "blocks_per_replicate": math.ceil(n_days / b),
                             "valid_start_positions": int(n_days - b + 1), "replicates": n_boot}
        day_idx_all = np.searchsorted(days, cols["asof"])
        brier_tab[str(T)] = {}
        for truth in ("oracle", "binance"):
            ycol = cols["y_" + truth]
            brier_tab[str(T)][truth] = {}
            for sname, sval in subsets:
                m = mT & np.isfinite(ycol)
                if sname == "asset":
                    m &= cols["asset"] == sval
                elif sname == "level":
                    m &= cols["k"] == sval
                skey = "all" if sname == "all" else f"{sname}={sval}"
                brier_tab[str(T)][truth][skey] = {"n_rows": int(m.sum()), **{
                    name: brier(predictor(cols, name)[m], ycol[m]) for name in PREDICTORS}}
                if truth == "binance" and sname != "all":
                    continue
                for cname, model, base in COMPARISONS:
                    r = bss_ci(day_idx_all[m], n_days, predictor(cols, model)[m],
                               predictor(cols, base)[m], ycol[m], counts)
                    comparisons.append({"comparison": cname, "model": model, "baseline": base,
                                        "truth": truth, "subset": skey, "T": T, **r})
        prim = [c for c in comparisons if c["T"] == T and c["comparison"] == COMPARISONS[0][0]
                and c["truth"] == "oracle" and c["subset"] == "all"][0]
        log(f"T={T}: days={n_days} rows={int(mT.sum())} primary BSS={prim['bss']:.4f} "
            f"CI={prim['ci95']}")

    # ECE (oracle truth)
    ece = {"note": "Equal-width ECE is dominated by near-zero probabilities: most rows have p < 0.1, so the "
                   "pooled equal-width number mostly measures the first bin. Equal-mass ECE and the per-horizon "
                   "values are reported beside it (not deciding).",
           "pooled": {}, "per_horizon": {}, "share_rows_p_below_0.1": {}}
    rel_rows_w, rel_rows_m = [], []
    for name in PREDICTORS:
        p = predictor(cols, name)
        y = cols["y_oracle"]
        ew, tw = ece_equal_width(p, y)
        em, tm = ece_equal_mass(p, y)
        ece["pooled"][name] = {"equal_width": ew, "equal_mass": em, "n": int(len(p))}
        ece["share_rows_p_below_0.1"][name] = float(np.mean(p < 0.1))
        rel_rows_w += [{"scope": "pooled", "predictor": name, **r} for r in tw]
        rel_rows_m += [{"scope": "pooled", "predictor": name, **r} for r in tm]
        ece["per_horizon"][name] = {}
        for T in HORIZONS:
            m = cols["T"] == T
            ew_T, tw_T = ece_equal_width(p[m], y[m])
            em_T, tm_T = ece_equal_mass(p[m], y[m])
            ece["per_horizon"][name][str(T)] = {"equal_width": ew_T, "equal_mass": em_T, "n": int(m.sum())}
            rel_rows_w += [{"scope": f"T={T}", "predictor": name, **r} for r in tw_T]
            rel_rows_m += [{"scope": f"T={T}", "predictor": name, **r} for r in tm_T]
    mb = np.isfinite(cols["y_binance"])
    ece["pooled_binance_truth_cal_DVOL"] = {
        "equal_width": ece_equal_width(cols["p_cal_DVOL"][mb], cols["y_binance"][mb])[0],
        "equal_mass": ece_equal_mass(cols["p_cal_DVOL"][mb], cols["y_binance"][mb])[0], "n": int(mb.sum())}
    for fname, rel in (("reliability-test-equal-width.csv", rel_rows_w),
                       ("reliability-test-equal-mass.csv", rel_rows_m)):
        with open(os.path.join(out_dir, fname), "w", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            keys = ("scope", "predictor", "bin", "p_lo", "p_hi", "n", "mean_p", "mean_y", "abs_gap")
            w.writerow(keys)
            for r in rel:
                w.writerow([_fmt(r[k]) for k in keys])

    # Verdict (T1.7)
    def horizon_line(cname):
        sel = [c for c in comparisons if c["comparison"] == cname and c["truth"] == "oracle"
               and c["subset"] == "all"]
        return {str(c["T"]): {"bss": c["bss"], "ci95": c["ci95"], "ci_above_0": c["ci_above_0"]} for c in sel}

    prim_line = horizon_line(COMPARISONS[0][0])
    n_above = sum(v["ci_above_0"] for v in prim_line.values())
    ece_primary = ece["pooled"]["cal_DVOL"]["equal_width"]
    A = n_above >= MIN_HORIZONS
    B = ece_primary <= ECE_MAX
    rv90_line = horizon_line("calDVOL_vs_calRV90")
    n_above_rv90 = sum(v["ci_above_0"] for v in rv90_line.values())
    verdict_rv90 = "PASS" if (n_above_rv90 >= MIN_HORIZONS and B) else "FAIL"
    verdict = {
        "verdict": "PASS" if (A and B) else "FAIL",
        "A_horizons_ci_above_0": n_above, "A_required": MIN_HORIZONS, "A_pass": bool(A),
        "A_per_horizon": prim_line,
        "B_pooled_ece_cal_DVOL_equal_width": ece_primary, "B_max": ECE_MAX, "B_pass": bool(B),
        "against_RV90_reported_not_deciding": {
            "verdict_if_baseline_were_cal_RV90": verdict_rv90,
            "horizons_ci_above_0": n_above_rv90, "per_horizon": rv90_line,
            "differs_from_primary": verdict_rv90 != ("PASS" if (A and B) else "FAIL")},
        "consequence": "FAIL -> M1 dropped, app keeps realized vol" if not (A and B) else
                       "PASS -> paid backfills for M6/M5 may be proposed; NOT prospective validation (T5 is)",
        "note": "Retrospective result; not prospective validation (prereg 0, T1.7).",
    }

    results = {
        "test": "T1", "kind": "retrospective", "prereg": PREREG,
        "code": {"path": "scripts/research/validation/t1_touch.py",
                 "sha256": sha256_file(os.path.abspath(__file__)),
                 "fit_phase_code_sha256": fit_summary["code"]["sha256"]},
        "inputs": input_meta,
        "environment": {"python": platform.python_version(), "numpy": np.__version__},
        "seed": seed, "n_boot": n_boot, "bootstrap": boot_meta,
        "decisions": DECISIONS,
        "calibration": {k: fit_summary[k] for k in ("calibration_maps", "calibration_set",
                                                     "calibration_base_rates_oracle",
                                                     "calibration_base_rates_binance",
                                                     "calibration_insample_brier_oracle", "bounds")},
        "test_set": set_counts(cols, acct),
        "test_base_rates_oracle": base_rates(cols, "y_oracle"),
        "test_base_rates_binance": base_rates(cols, "y_binance"),
        "verdict": verdict,
        "brier": brier_tab,
        "comparisons": comparisons,
        "ece": ece,
        "run": {"score_started_utc": started,
                "score_finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "score_seconds": round(time.time() - t_start, 3),
                "fit_seconds": fit_summary.get("fit_seconds"),
                "fit_finished_utc": fit_summary.get("fit_finished_utc")},
    }
    write_forecasts_csv_gz(os.path.join(out_dir, "forecasts-test.csv.gz"), cols)
    write_json(results_path, _clean(results))
    write_provenance(out_dir, results)
    log(f"VERDICT {verdict['verdict']}: A {n_above}/5 horizons CI>0 (need {MIN_HORIZONS}); "
        f"B pooled ECE cal DVOL = {ece_primary:.4f} (max {ECE_MAX})")
    return results


def write_provenance(out_dir, results):
    files = sorted(f for f in os.listdir(out_dir) if f != "PROVENANCE.md" and not f.startswith("."))
    lines = [
        "# validation/t1 -- provenance",
        "",
        "- **Test:** T1 of `triccs/membrane-board` `design/VALIDATION_PREREG.md` (commit 506e7c5). "
        "Retrospective: rows carry `kind: retrospective` and `asof`; no issue timestamp.",
        "- **Code:** `The-Membrane/membrane-app` branch `research/validation-pilots`, "
        f"`scripts/research/validation/t1_touch.py` (sha256 `{results['code']['sha256']}`), tests in "
        "`test_t1.py`.",
        "- **Inputs (sha256 verified before compute):** " + ", ".join(
            f"`{v['path']}` `{v['sha256']}`" for v in (results["inputs"] or {}).values()),
        f"- **Seed:** {results['seed']}, {results['n_boot']} bootstrap replicates.",
        f"- **Verdict:** {results['verdict']['verdict']} (see `results.json` -> `verdict`).",
        "- **Reproduce:** `python3 scripts/research/validation/t1_touch.py --datasets <membrane-datasets> "
        "--out <fresh dir> --phase all` then compare sha256 of `calibration-maps.json`, "
        "`forecasts-*.csv.gz` and the metrics in `results.json` (run times differ).",
        "",
        "| file | bytes | sha256 |",
        "|---|---:|---|",
    ]
    for f in files:
        p = os.path.join(out_dir, f)
        lines.append(f"| `{f}` | {os.path.getsize(p)} | `{sha256_file(p)}` |")
    with open(os.path.join(out_dir, "PROVENANCE.md"), "w") as fh:
        fh.write("\n".join(lines) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True, help="membrane-datasets checkout")
    ap.add_argument("--out", required=True, help="output dir (e.g. membrane-datasets/validation/t1)")
    ap.add_argument("--phase", choices=("fit", "score", "all"), default="all")
    a = ap.parse_args(argv)
    meta = verify_inputs(a.datasets)
    print("inputs verified:", ", ".join(f"{v['path']}" for v in meta.values()))
    grids, dvols = load_all(a.datasets)
    if a.phase in ("fit", "all"):
        run_fit(grids, dvols, a.out, input_meta=meta)
    if a.phase in ("score", "all"):
        run_score(grids, dvols, a.out, input_meta=meta)


if __name__ == "__main__":
    sys.exit(main())
