#!/usr/bin/env python3
"""Q26 workstream A4 -- forecast bands, label basis, BTC/ETH calm-market recalibration (fc), asset-matched checks,
and blind set 3.

Implements triccs/membrane-board `design/HISTORY_TOUCH_PREREG_A4.md` (registered at commit d800253, file sha256
152613fc7787b86095fa98e8fa27552d716574771c6def468e1ccd1f95db7010). Parents: A, A2 (D1-D3), A3 (D1); every definition
not changed by A4 holds. The A/A2/A3 code (a_touch.py, a2_touch.py, a3_touch.py) is imported and never modified.

Phases (run in this order into a fresh --out):
  dryrun    data-only counts (blind set 3 is not read)                                      -> dryrun.json
  dev       all development data (Chainlink dev, B-span, A2 eight, A3 locked set) fit, predict, score ONCE;
            seed-stable shipping; labels with the asset-matched and generic checks; basis strings; forecast bands;
            freeze -> results-dev.json, frozen-a4.json (+ .sha256), predictions-*.csv.gz, bands-*.csv.gz
  preview   panel preview from the frozen labels (before blind set 3)                       -> panel-preview.json
  blind3    blind set 3 read ONCE, only with the freeze file and --blind3-commit (the published commit)
            -> results-blind3.json, basis-final.csv, predictions-blind3-*.csv.gz
  panel     current-day panel with the blind-3 basis                                        -> panel.json
  manifest  sha256 of every output                                                          -> manifest.json
Light models only (frequency counts, FHS counts, a shrunk ratio).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):   # one thread per worker
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
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402

PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A4.md",
    "commit": "d800253",
    "sha256": "152613fc7787b86095fa98e8fa27552d716574771c6def468e1ccd1f95db7010",
    "parents": {"A": A.PREREG, "A2": M2.PREREG, "A3": M3.PREREG},
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
A2_HOLDOUTS = tuple(f"holdout:{p}" for p in M2.HOLDOUTS)
A3_BINANCE = tuple(f"locked:{s[0]}" for s in M3.LOCKED_SERIES[3:])
A3_USD = tuple(f"locked:{s[0]}" for s in M3.LOCKED_SERIES[:3])      # Bitstamp BTC, Coinbase BTC, Coinbase ETH
GENERIC = A2_HOLDOUTS + A3_BINANCE                                     # the 18 holdouts (A4.4 generic check)
ASSET_MATCHED = {"ETH": ("bspan:ETH", "locked:coinbase-eth-usd"),
                 "BTC": ("bspan:BTC", "locked:bitstamp-btc-usd", "locked:coinbase-btc-usd")}

M_SHRINK = 20.0                                   # A4.2 theta = (O + 20) / (E + 20)
BAND_SHALLOW, BAND_MIDDLE = (-0.02, -0.03, -0.05), (-0.07, -0.10, -0.15)
N_BAND_REP = 500                                  # A4.3
BAND_PCT = (5.0, 95.0)
SEED_BAND = 20261040
SEED_BLIND3 = 20261041
SEED_REG = M3.SEED_REG                            # A3.4 unchanged (20261030)
SEEDS_FURTHER = M3.SEEDS_FURTHER                  # A3.6 unchanged (20261031..20261050)
MIN_SEEDS = M3.MIN_SEEDS
BETA_HISTORY_DAYS = M3.BETA_HISTORY_DAYS          # >= 365 d of earlier origins for the as-of (f) rows

RUNGS = ("a", "f", "fc", "r30", "r90")
SHIP_ORDER = ("a", "f", "fc")
COMPARISONS = (("fc_vs_a", "fc", "a"), ("f_vs_a", "f", "a"), ("fc_vs_f", "fc", "f"),
               ("a_vs_f", "a", "f"), ("a_vs_fc", "a", "fc"), ("f_vs_fc", "f", "fc"),
               ("r30_vs_a", "r30", "a"), ("r90_vs_a", "r90", "a"))
REPORT_COMPARISONS = ("fc_vs_a", "fc_vs_f", "f_vs_a", "r30_vs_a", "r90_vs_a")
CHECK_NEP = M2.BLIND_NEP                          # 10
CHECK_R = M2.BLIND_R                              # [0.67, 1.5]
BLIND3_DIR = "blind3-prices"

DECISIONS = [
    "D-D1 development data (A4.1): Chainlink dev ETH/BTC/stETH (A2/A3 grids, long spliced history), B-span ETH/BTC, the "
    "A2 eight holdouts, and the A3 locked set (Bitstamp BTC 2012Q4-2016Q3, Coinbase BTC 2016Q4-2018Q3, Coinbase ETH "
    "2017Q3-2018Q3, the ten Binance pairs; A3 D1 folds; files verified against the git blob at ab04005). The A3.1 "
    "null-hour rule, sigma_hat, regime (A3 D-R3) and folds are A3's functions unchanged.",
    "D-C1 (fc): training rows = the fold's labelled training origins t (t + T <= Q_start) with sigma_hat(t) defined, "
    "t >= the series' first labelled origin + 365 d and an as-of (f) forecast from origins t' + T <= t (A3's as-of "
    "FHS counts with beta = 1). O and E sum labels and as-of forecasts over those rows' levels in a band, per regime "
    "of t. theta = (O + 20)/(E + 20); p_fc = theta*p/(1 - p + theta*p) (p = 0 or 1 stay). Bands: shallow -2/-3/-5%, "
    "middle -7/-10/-15%, deep -20% and deeper; stETH one band. A test row with an undefined regime uses theta over "
    "all regimes of its band. The monotone fix follows.",
    "D-B1 forecast band (A4.3) for the shipped rung: per (asset, T, fold), the fold's training DAYS = UTC dates of the "
    "labelled training origins of the series the rung trains on (oracle-only for (a) on ETH/BTC, the long spliced "
    "series for (f)/(fc)); 500 moving-block resamples (block max(30, 2T) d, a_touch.block_bootstrap_indices) "
    "weight every training origin by its day's count. (a): weighted frequency; (f): weighted FHS share; (fc): the "
    "resampled (f) share with theta re-estimated from the resampled O and E (the as-of forecasts are not recomputed "
    "inside a resample). 5th/95th percentiles per (test origin, level), then each of lo and hi is monotone-fixed over "
    "the (T, level) grid and widened to contain the point forecast. Draws come from one default_rng(20261040) stream "
    "in the order ETH, BTC, stETH > 6h..30d > folds in time order > the DATA_END refit; the panel replays it. Bands "
    "are computed for every development test row (not only 00:00Z).",
    "D-B2 band check (reported, deciding nothing): per (asset, T), informative (fold, level) cells of the shipped rung "
    "(A2.5 definition, regimes pooled); covered iff the realized fold frequency lies in [mean lo, mean hi] of that "
    "fold's rows.",
    "D-S1 comparisons, eligibility, seed stability, dominance and choice are A3.4-A3.6 (A3 D-S1/D-S2) with candidates "
    "(a), (f), (fc), tie order a < f < fc. default_rng(20261030) draws: dev ETH, BTC, stETH > T; then B-span ETH, BTC; "
    "the A2 eight; the A3 ten Binance pairs; Bitstamp BTC, Coinbase BTC, Coinbase ETH (each > T); then the pooled 18 "
    "holdouts (union day sets) > T. Further seeds replay only the dev draws.",
    "D-L1 labels: A3.5 v3 (a2_touch.level_stats per regime, thresholds unchanged). Asset-matched check (ETH/BTC): pool "
    "the asset's other read series (ETH: B-span ETH, Coinbase ETH; BTC: B-span BTC, Bitstamp BTC, Coinbase BTC); the "
    "Chainlink dev rows are the label's own rows and are excluded. Generic check: the 18 holdouts pooled. Pooled R = sum "
    "p / sum y, n_ep = sum of per-series episodes, same rung, T, level and regime. A HIGH needs both (stETH: generic, "
    "only at levels on the holdout ladder; else 'unconfirmed (level not on the holdout ladder)'); any failure -> "
    "MEDIUM 'failed <check>', else any n_ep < 10 -> MEDIUM 'unconfirmed <check>'.",
    "D-L2 basis string per (asset, T, level, regime, rung): 'held in k of n checks'. Checks: dev calibration (counts when "
    "the regime's dev n_ep >= 10; held when the dev v3 label is HIGH or MEDIUM), asset-matched (ETH/BTC), generic, "
    "blind set 3 (after A4.7); each counts when its pooled n_ep >= 10 and is held when 0.67 <= R <= 1.5. No live check "
    "exists yet.",
    "D-K1 blind set 3 (A4.7): read only in the blind3 phase, only with the freeze file (sha256 as recorded) and an "
    "explicit --blind3-commit; every file is verified against that commit's git blob; a start marker refuses a second "
    "run. Pairs = every '*-1h.json[.gz]' grid in blind3-prices/; folds from the first quarter >= 365 d after the first "
    "kline to 2026Q3; levels = the ETH/BTC ladder; draws default_rng(20261041): pairs in file-name order > T, then the "
    "pooled union day sets > T. Frozen labels are not changed; only the basis strings add the blind-3 check.",
    "D-P1 panel: number, band, current regime, the current regime's label and basis, n_ep, period, rung. The band at "
    "asof uses the DATA_END fold's replayed draws with the live features. ACTION rows: 'Repay $X · line -Y% · Z% "
    "(lo-hi)' with lo/hi the band grids interpolated (A.p_at_distance) at the line after the repay; the label is the "
    "lower of the two grid levels used (A2 D-D2/D3).",
]


def band_of(asset, levels):
    if asset == "stETH":
        return np.zeros(len(levels), dtype=int)
    return np.array([0 if k in BAND_SHALLOW else 1 if k in BAND_MIDDLE else 2 for k in levels], dtype=int)


def odds_mult(p, theta):
    p = np.asarray(p, float)
    return theta * p / (1.0 - p + theta * p)


# ---------------------------------------------------------------------------------------------
# Per (series, T) preparation: A3 Prep3 (beta = 1 only) + the as-of (f) rows for (fc)
# ---------------------------------------------------------------------------------------------
class Prep4:
    def __init__(self, ser, T_h, q_max=None):
        self.P = M3.Prep3(ser, T_h, beta_select=False)
        P = self.P
        self.T_h, self.K = T_h, P.K
        self.bands = band_of(ser.asset if ser.asset in DEV_ASSETS else "ladder", ser.levels)
        self.nb = int(self.bands.max()) + 1
        n = len(P.lab_ok)
        i = np.arange(n)
        q_max = n if q_max is None else q_max
        self.reg = ser.regime[:n].astype(int)
        if P.first_lab is None:
            self.ev = np.zeros(n, bool)
            asof = np.full((n, self.K), np.nan)
        else:
            ev = (P.lab_ok & np.isfinite(ser.sigma) & (i >= P.first_lab + BETA_HISTORY_DAYS * 24) & (i + T_h <= q_max))
            thr = P.thresholds(P.sig[1.0])
            asof = M2.asof_fhs_counts(P.valid[1.0], P.z[1.0], ev, np.where(np.isfinite(thr), thr, 0.0), T_h)
            ev &= np.all(np.isfinite(asof), axis=1)
            self.ev = ev
        Yz = np.where(self.ev[:, None], np.nan_to_num(P.Y), 0.0)
        Ez = np.where(self.ev[:, None], np.nan_to_num(asof), 0.0)
        self.O_t = np.stack([Yz[:, self.bands == b].sum(axis=1) for b in range(self.nb)], axis=1)   # (n, nb)
        self.E_t = np.stack([Ez[:, self.bands == b].sum(axis=1) for b in range(self.nb)], axis=1)
        self.cum = {}
        for g in (0, 1, 2, -9):                     # -9 = all regimes
            m = self.ev if g == -9 else (self.ev & (self.reg == g))
            self.cum[g] = (np.cumsum(np.where(m[:, None], self.O_t, 0.0), axis=0),
                           np.cumsum(np.where(m[:, None], self.E_t, 0.0), axis=0))

    def theta(self, qs_i):
        lim = qs_i - self.T_h
        out = {}
        for g in (0, 1, 2, -9):
            O = self.cum[g][0][lim] if lim >= 0 else np.zeros(self.nb)
            E = self.cum[g][1][lim] if lim >= 0 else np.zeros(self.nb)
            out[g] = {"O": O.tolist(), "E": E.tolist(), "theta": ((O + M_SHRINK) / (E + M_SHRINK)).tolist()}
        return out


def fc_from(p_f, regimes_te, th, bands):
    """Apply the fold theta per row (regime) and level (band)."""
    out = np.array(p_f, float)
    for r in range(out.shape[0]):
        g = int(regimes_te[r])
        gk = g if g in (0, 1, 2) else -9
        tb = np.asarray(th[gk]["theta"])[bands]
        out[r] = odds_mult(out[r], tb)
    return out


def predict4(ser, P4, T_h, qs_i, te, te_sigma=None, te_regime=None, te_close=None):
    o = M3.predict3(ser, P4.P, T_h, qs_i, te, 1.0, te_sigma=te_sigma, te_sigma_ref=None if te_sigma is None else
                    np.full(len(te), np.nan), te_close=te_close)
    o["raw"].pop("fb", None)
    th = P4.theta(qs_i)
    reg = ser.regime[te] if te_regime is None else np.atleast_1d(te_regime)
    o["raw"]["fc"] = fc_from(o["raw"]["f"], reg, th, P4.bands)
    o["theta"] = th
    return o


# ---------------------------------------------------------------------------------------------
# Series and tasks
# ---------------------------------------------------------------------------------------------
_SER = {}


def build_all(datasets, verify_locked=True):
    D = M3.build_dev(datasets)
    B = M3.build_devblind(datasets)
    L, lmeta, lspans = M3.build_locked(datasets, verify=verify_locked)
    S = dict(D)
    S.update(B)
    S.update(L)
    folds = {}
    for k in ("bspan:ETH", "bspan:BTC") + A2_HOLDOUTS:
        folds[k] = M3.devblind_folds(S[k])
    folds.update(lspans)
    return S, folds, lmeta


def _clear(ser):
    ser._lab.clear()
    ser._wmin.clear()


def fold_loop(ser, P4, T_h, folds, data_end=False, P_a=None):
    imask = ser.issue_mask()
    res = []
    fl = list(folds) + ([{"name": "DATA_END", "qs_i": ser.N, "qe_i": ser.N + 1}] if data_end else [])
    for f in fl:
        te = M3.test_times(f, ser, imask) if f["name"] != "DATA_END" else np.array([ser.N])
        o = predict4(ser, P4, T_h, f["qs_i"], te)
        if P_a is not None:
            lim = f["qs_i"] - T_h
            o["raw"]["a"] = np.tile(P_a.freq_upto(lim), (len(te), 1))
        o.update(fold=f["name"], te=te)
        res.append(o)
    return res


def task(args):
    kind, key, T_h = args
    if kind == "dev":
        ls, os_ = _SER[f"long:{key}"], _SER[f"oracle:{key}"]
        P4 = Prep4(ls, T_h)
        Pa = P4.P if os_ is ls else M3.Prep3(os_, T_h, beta_select=False)
        res = fold_loop(ls, P4, T_h, M3.dev_folds(ls), data_end=True, P_a=Pa)
        _clear(ls)
        _clear(os_)
        return f"dev:{key}", T_h, res
    ser = _SER[key]
    folds = _SER["__folds__"][key]
    q_max = max(f["qs_i"] for f in folds) if folds else 0
    P4 = Prep4(ser, T_h, q_max=q_max)
    res = fold_loop(ser, P4, T_h, folds)
    _clear(ser)
    return key, T_h, res


def run_pool(tasks, workers, log, t0):
    outs = {}
    if workers > 1:
        with mp.get_context("fork").Pool(workers, maxtasksperchild=4) as pool:
            for k, T_h, r in pool.imap_unordered(task, tasks):
                outs[(k, T_h)] = r
                log(f"  fit {k} {T_LABEL[T_h]} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    else:
        for t in tasks:
            k, T_h, r = task(t)
            outs[(k, T_h)] = r
            log(f"  fit {k} {T_LABEL[T_h]} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    return outs


def assemble4(ser, folds, per_T, y_check=None):
    """As a3_touch.assemble3 for the A4 rungs (a, f, fc, r30, r90); theta per fold kept."""
    K, nT = len(ser.levels), len(HORIZONS_H)
    first = [o for o in per_T[HORIZONS_H[0]] if o["fold"] != "DATA_END"]
    te_all = np.concatenate([o["te"] for o in first]) if first else np.array([], int)
    fold_of = np.concatenate([[fi] * len(o["te"]) for fi, o in enumerate(first)]).astype(int) if first else \
        np.array([], int)
    n = len(te_all)
    G = {r: np.full((n, nT, K), np.nan) for r in RUNGS}
    thetas, data_end = [], {}
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
            for g, d in o["theta"].items():
                thetas.append({"series": ser.name, "T": T_LABEL[T_h], "fold": o["fold"],
                               "regime": REGIMES[g] if g in (0, 1, 2) else "all",
                               **{f"theta_b{b}": d["theta"][b] for b in range(len(d["theta"]))},
                               **{f"O_b{b}": d["O"][b] for b in range(len(d["O"]))},
                               **{f"E_b{b}": d["E"][b] for b in range(len(d["E"]))}})
            off += m
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
    R["_te"] = (te_all, fold_of)          # tuple: not masked by row selection
    de = {}
    if data_end:
        for r in RUNGS:
            g = np.array([data_end[T]["raw"][r][0] for T in HORIZONS_H])
            if not np.isnan(g).any():
                de[r] = A.monotone_fix(g[None])[0]
        de["theta"] = {T_LABEL[T]: data_end[T]["theta"] for T in HORIZONS_H}
    _clear(ser)
    if y_check is not None:
        _clear(y_check)
    return R, thetas, de


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def score_T(R, T_h, counts, days, with_labels=True):
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
    out["comparisons"] = M3.comparisons(sel, pos, len(days), counts, COMPARISONS)
    out["comparisons_by_regime"] = {g: M3.comparisons(sel, pos, len(days), counts,
                                                      [c for c in COMPARISONS if c[0] in REPORT_COMPARISONS],
                                                      mask=sel["regime"] == gi) for gi, g in enumerate(REGIMES)}
    out["levels"] = M3.level_stats_by_regime(sel, pos, len(days), counts, T_h, last_folds, RUNGS, with_labels)
    return out, sel, pos


def pooled_stats(Rs, keys, T_h, counts=None, days=None):
    """Pooled over series: R / n_ep per (level, rung, regime); BSS when counts are given."""
    parts = [M3.select(Rs[k], Rs[k]["T_h"] == T_h) for k in keys]
    cat = {c: np.concatenate([p[c] for p in parts]) for c in ("day", "y", "k_i", "regime") +
           tuple(f"p_{r}" for r in RUNGS)}
    out = {"n_rows": int(len(cat["y"])), "levels": {}}
    if counts is not None:
        pos = M2.day_positions(days, cat["day"])
        out["comparisons"] = M3.comparisons(cat, pos, len(days), counts, COMPARISONS)
        out["comparisons_by_regime"] = {g: M3.comparisons(cat, pos, len(days), counts,
                                                          [c for c in COMPARISONS if c[0] in REPORT_COMPARISONS],
                                                          mask=cat["regime"] == gi) for gi, g in enumerate(REGIMES)}
    for j, k in enumerate(LADDER):
        lv = {}
        for r in RUNGS:
            d = {}
            for gname, gval in (("pooled", None),) + tuple((g, gi) for gi, g in enumerate(REGIMES)):
                m = (cat["k_i"] == j) & np.isfinite(cat[f"p_{r}"])
                if gval is not None:
                    m &= cat["regime"] == gval
                sp, sy = float(cat[f"p_{r}"][m].sum()), float(cat["y"][m].sum())
                Rr = (sp / sy) if sy > 0 else (float("inf") if sp > 0 else None)
                n_ep = 0
                for p in parts:
                    mp_ = (p["k_i"] == j) & np.isfinite(p[f"p_{r}"])
                    if gval is not None:
                        mp_ &= p["regime"] == gval
                    n_ep += M2.count_touch_episodes(p["t0_i"][mp_], p["y"][mp_])
                d[gname] = {"R": Rr, "n_ep": int(n_ep), "n_rows": int(m.sum()), "sum_p": sp, "sum_y": sy}
            lv[r] = d
        out["levels"][repr(float(k))] = lv
    return out


def check_state(stat):
    """'held', 'not held' or 'n/a' (fewer than 10 episodes / no data) for one pooled check statistic."""
    c = M3.check_one(stat)
    return {"pass": "held", "failed": "not held"}.get(c, "n/a")


def label_after_checks(asset, dev_label, am, gen, on_ladder):
    """D-L1: (label, outcome)."""
    if dev_label != "HIGH":
        return dev_label, "not HIGH"
    if asset == "stETH" and not on_ladder:
        return "MEDIUM", "unconfirmed (level not on the holdout ladder)"
    checks = []
    if asset in BSPAN_ASSETS:
        checks.append(("asset-matched", M3.check_one(am)))
    checks.append(("generic", M3.check_one(gen)))
    for name, c in checks:
        if c == "failed":
            return "MEDIUM", f"failed {name}"
    for name, c in checks:
        if c == "unconfirmed":
            return "MEDIUM", f"unconfirmed {name}"
    return "HIGH", "passed checks"


def basis(dev_stat, dev_label, checks):
    """D-L2: checks = list of (name, state); dev counts when n_ep >= 10."""
    states = []
    if dev_stat is not None and dev_stat.get("n_ep", 0) >= CHECK_NEP:
        states.append(("dev calibration", "held" if dev_label in ("HIGH", "MEDIUM") else "not held"))
    else:
        states.append(("dev calibration", "n/a"))
    states += list(checks)
    n = sum(s != "n/a" for _, s in states)
    k = sum(s == "held" for _, s in states)
    return f"held in {k} of {n} checks", {nm: s for nm, s in states}, k, n


def ship_choice(eligible, dominance, n_high, n_med, bss_a):
    rest = [x for x in eligible if not any(dominance.get((y, x), False) for y in eligible if y != x)] or ["a"]
    removed = [x for x in eligible if x not in rest]
    key = lambda r: (n_high[r], n_med[r], bss_a.get(r) if bss_a.get(r) is not None else 0.0)  # noqa: E731
    best = max(key(r) for r in rest)
    tied = [r for r in rest if key(r) == best]
    return sorted(tied, key=SHIP_ORDER.index)[0], {"eligible": eligible, "removed_by_dominance": removed,
                                                   "remaining": rest, "tied_at_top": tied}


# ---------------------------------------------------------------------------------------------
# Forecast bands (A4.3)
# ---------------------------------------------------------------------------------------------
def fold_days(ser, lab_ok, T_h, qs_i):
    """Training days of a fold (UTC dates of its labelled training origins) and each origin's day position."""
    n = len(lab_ok)
    i = np.arange(n)
    tr = lab_ok & (i + T_h <= qs_i)
    d_all = (ser.base_ts + STEP * i) // DAY
    days = np.unique(d_all[tr])
    pos = np.full(n, -1, dtype=np.int64)
    pos[tr] = np.searchsorted(days, d_all[tr])
    return days, pos, tr


def band_samples_a(ser_o, Po, qs_i, n_te, counts):
    """(n_rep, n_te, K) resampled (a) forecasts: day-count-weighted frequency over the fold's training origins."""
    days, pos, tr = fold_days(ser_o, Po.lab_ok, Po.T_h, qs_i)
    nd = len(days)
    assert counts.shape[1] == nd, "band draws do not match the (a) training days"
    yday = np.zeros((nd, Po.K))
    np.add.at(yday, pos[tr], Po.Y[tr])
    nday = np.bincount(pos[tr], minlength=nd).astype(float)
    p = (counts @ yday) / (counts @ nday)[:, None]
    return np.repeat(p[:, None, :], n_te, axis=1)


def band_samples_f(ser, P4, qs_i, te, counts, fc=False, te_sigma=None, te_regime=None, chunk=50):
    """(n_rep, len(te), K) resampled (f) or (fc) forecasts of one fold (D-B1)."""
    P = P4.P
    T = P4.T_h
    n = len(P.lab_ok)
    i = np.arange(n)
    days, pos, _ = fold_days(ser, P.lab_ok, T, qs_i)
    nd = len(days)
    assert counts.shape[1] == nd, "band draws do not match the training days"
    n_rep, K = counts.shape[0], P4.K
    lim = qs_i - T
    trf = P.valid[1.0] & (i <= lim)
    z = P.z[1.0][trf]
    order = np.argsort(z, kind="mergesort")
    zs = z[order]
    dpos = pos[trf][order]
    sg = ser.sigma[te] if te_sigma is None else np.atleast_1d(np.asarray(te_sigma, float))
    idx = np.searchsorted(zs, P.thresholds(sg), side="right")           # (n_te, K)
    out = np.empty((n_rep, len(te), K))
    for s in range(0, n_rep, chunk):
        W = counts[s:s + chunk][:, dpos]
        cw = np.concatenate([np.zeros((W.shape[0], 1)), np.cumsum(W, axis=1)], axis=1)
        out[s:s + chunk] = cw[:, idx] / cw[:, -1][:, None, None]
    if not fc:
        return out
    ev = P4.ev & (i <= lim)
    th = {}
    for g in (0, 1, 2, -9):
        m = ev if g == -9 else ev & (P4.reg == g)
        Od = np.zeros((nd, P4.nb))
        Ed = np.zeros((nd, P4.nb))
        np.add.at(Od, pos[m], P4.O_t[m])
        np.add.at(Ed, pos[m], P4.E_t[m])
        th[g] = (counts @ Od + M_SHRINK) / (counts @ Ed + M_SHRINK)          # (n_rep, nb)
    regs = ser.regime[te] if te_regime is None else np.atleast_1d(te_regime)
    for r in range(len(te)):
        g = int(regs[r])
        g = g if g in (0, 1, 2) else -9
        out[:, r, :] = odds_mult(out[:, r, :], th[g][:, P4.bands])
    return out


def band_order(ser, folds):
    """Fold list in the registered draw order for one (asset, T): folds in time order, then DATA_END."""
    return list(folds) + [{"name": "DATA_END", "qs_i": ser.N, "qe_i": ser.N + 1}]


def band_series(S, a, rung):
    """The series the shipped rung trains on: the oracle-only series for (a) (plain history), else the long series."""
    return S[f"oracle:{a}"] if rung == "a" else S[f"long:{a}"]


def replay_band_draws(S, shipped, consume=None):
    """Iterate (asset, T_h, fold, counts) in the registered order from one default_rng(20261040) stream. The day count
    of each fold is that of the shipped rung's training series. consume(a, T_h, fold, counts, state) -> state."""
    rng = np.random.default_rng(SEED_BAND)
    for a in DEV_ASSETS:
        lser = S[f"long:{a}"]
        for T_h in HORIZONS_H:
            st = band_series(S, a, shipped[a][T_LABEL[T_h]])
            lab = np.isfinite(st.spot) & np.isfinite(st.wmin(T_h))
            state = None
            for f in band_order(lser, M3.dev_folds(lser)):
                days, _, _ = fold_days(st, lab, T_h, f["qs_i"])
                idx = A.block_bootstrap_indices(rng, len(days), A.block_length(T_h), N_BAND_REP)
                cnt = A.replicate_counts(idx, len(days))
                if consume is not None:
                    state = consume(a, T_h, f, cnt, state)
            _clear(lser)
            _clear(st)


def band_for(S, a, T_h, f, cnt, state, rung, te, te_sigma=None, te_regime=None):
    """Band samples of the shipped rung for one fold; state caches the Prep objects of (asset, T)."""
    if state is None:
        state = {"P4": Prep4(S[f"long:{a}"], T_h) if rung in ("f", "fc") else None,
                 "Po": M3.Prep3(S[f"oracle:{a}"], T_h, beta_select=False) if rung == "a" else None}
    if rung == "a":
        smp = band_samples_a(S[f"oracle:{a}"], state["Po"], f["qs_i"], len(te), cnt)
    else:
        smp = band_samples_f(S[f"long:{a}"], state["P4"], f["qs_i"], te, cnt, fc=(rung == "fc"),
                             te_sigma=te_sigma, te_regime=te_regime)
    return smp, state


# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------
def write_json(path, obj, refuse_overwrite=False):
    A.write_json(path, obj, refuse_overwrite=refuse_overwrite)


def code_meta():
    here = os.path.abspath(__file__)
    d = os.path.dirname(here)
    run = lambda *a: subprocess.run(["git", "-C", d, *a], capture_output=True, text=True).stdout.strip()  # noqa: E731
    return {"path": "scripts/research/history-forecasts/a4_touch.py", "sha256": A.sha256_file(here),
            "a3_touch_sha256": A.sha256_file(os.path.join(d, "a3_touch.py")),
            "a2_touch_sha256": A.sha256_file(os.path.join(d, "a2_touch.py")),
            "a_touch_sha256": A.sha256_file(os.path.join(d, "a_touch.py")),
            "git": {"head_commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
                    "a4_touch_last_commit": run("log", "-1", "--format=%H", "--", "a4_touch.py"),
                    "dirty_code_files": run("status", "--porcelain", "--", "a4_touch.py", "test_a4_touch.py",
                                            "a3_touch.py", "a2_touch.py", "a_touch.py").splitlines()}}


def write_rows(path, named, bands=None):
    header = ["series", "t0", "fold", "T", "k", "y", "regime"] + [f"p_{r}" for r in RUNGS] + \
        (["band_lo_shipped_rung", "band_hi_shipped_rung"] if bands is not None else [])

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


def label_counts(grid, key):
    out = {g: {"HIGH": 0, "MEDIUM": 0, "LOW": 0, "insufficient": 0, "STALE": 0, "none": 0} for g in REGIMES}
    for kk, d in grid.items():
        for g in REGIMES:
            v = d[g].get(key) if isinstance(d.get(g), dict) else None
            out[g][v if v else "none"] += 1
    return out


# ---------------------------------------------------------------------------------------------
# Phase: dry run
# ---------------------------------------------------------------------------------------------
def run_dryrun(datasets, out_dir, meta, log=print):
    path = os.path.join(out_dir, "dryrun.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    t0 = time.time()
    S, folds, lmeta = build_all(datasets)
    out = {"phase": "dryrun", "prereg": PREREG, "code": code_meta(), "inputs": meta, "locked_files": lmeta,
           "note": "Data-only counts. No label value, frequency, Brier, BSS or R. Blind set 3 is not read.",
           "series": {}}
    for key, ser in S.items():
        if key.startswith("oracle:") and S.get(key.replace("oracle:", "long:")) is not ser:
            continue
        fl = M3.dev_folds(ser) if key.startswith("long:") else folds.get(key, [])
        imask = ser.issue_mask()
        te = np.concatenate([M3.test_times(f, ser, imask) for f in fl]) if fl else np.array([], int)
        s_out = {"start": A.iso(ser.ts(ser.start_i)), "folds": [f["name"] for f in fl], "test_issue_times": int(len(te)),
                 "test_regime_counts": {g: int((ser.regime[te] == gi).sum()) for gi, g in enumerate(REGIMES)}}
        s_out["test_regime_counts"]["undefined"] = int((ser.regime[te] < 0).sum())
        lab = np.isfinite(ser.spot) & np.isfinite(ser.wmin(168))
        first = int(np.where(lab)[0][0]) if lab.any() else None
        if fl and first is not None:
            i = np.arange(ser.n_orig)
            ev = lab & np.isfinite(ser.sigma) & (i >= first + BETA_HISTORY_DAYS * 24)
            s_out["fc_rows_7d_first_fold"] = int((ev & (i + 168 <= fl[0]["qs_i"])).sum())
            s_out["fc_rows_7d_last_fold"] = int((ev & (i + 168 <= fl[-1]["qs_i"])).sum())
        _clear(ser)
        out["series"][key] = s_out
    out["runtime_seconds"] = round(time.time() - t0, 1)
    write_json(path, out, refuse_overwrite=True)
    log(f"dryrun written ({time.time() - t0:.0f}s)")
    return out


# ---------------------------------------------------------------------------------------------
# Phase: development (scored ONCE) and freeze
# ---------------------------------------------------------------------------------------------
def run_dev(datasets, out_dir, meta, workers=2, log=print, verify_locked=True):
    rpath, fpath = os.path.join(out_dir, "results-dev.json"), os.path.join(out_dir, "frozen-a4.json")
    for p in (rpath, fpath):
        if os.path.exists(p):
            raise SystemExit(f"STOP: {p} exists. The development run is scored once.")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    global _SER
    S, folds, lmeta = build_all(datasets, verify_locked=verify_locked)
    _SER = dict(S)
    _SER["__folds__"] = folds
    okeys = ["bspan:ETH", "bspan:BTC"] + list(A2_HOLDOUTS) + list(A3_BINANCE) + list(A3_USD)
    log(f"series built {time.time() - t_start:.0f}s")
    tasks = [("dev", a, T) for a in DEV_ASSETS for T in HORIZONS_H] + [("ser", k, T) for k in okeys for T in HORIZONS_H]
    outs = run_pool(tasks, workers, log, t_start)
    t_fit = time.time() - t_start
    Rs, thetas, data_end = {}, [], {}
    for a in DEV_ASSETS:
        ls, os_ = S[f"long:{a}"], S[f"oracle:{a}"]
        R, th, de = assemble4(ls, M3.dev_folds(ls), {T: outs[(f"dev:{a}", T)] for T in HORIZONS_H},
                              y_check=None if os_ is ls else os_)
        Rs[a], data_end[a] = R, de
        thetas += th
    stored = M3.check_stored_a(datasets, Rs)
    for k in okeys:
        R, th, _ = assemble4(S[k], folds[k], {T: outs[(k, T)] for T in HORIZONS_H})
        Rs[k] = R
        thetas += th
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
            sc, sel, pos = score_T(Rs[a], T_h, cnt, days)
            sels[(a, T_h)] = (sel, pos)
            res_dev[a][T_LABEL[T_h]] = sc
        log(f"  scored {a} ({time.time() - t_start:.0f}s)")
    res_other = {}
    for k in okeys:
        res_other[k] = {"folds": Rs[k]["fold_names"], "per_T": {}}
        for T_h in HORIZONS_H:
            days = np.unique(Rs[k]["day"][Rs[k]["T_h"] == T_h])
            if len(days) < A.block_length(T_h):
                res_other[k]["per_T"][T_LABEL[T_h]] = {"skipped": "fewer days than the block length"}
                continue
            idx, cnt = M3.draws(rng, len(days), T_h)
            boot_meta[f"{k}|{T_LABEL[T_h]}"] = M3._bmeta(days, idx, T_h)
            sc, _, _ = score_T(Rs[k], T_h, cnt, days, with_labels=False)
            res_other[k]["per_T"][T_LABEL[T_h]] = sc
    log(f"  scored other series ({time.time() - t_start:.0f}s)")
    generic, matched = {}, {a: {} for a in BSPAN_ASSETS}
    for T_h in HORIZONS_H:
        TL = T_LABEL[T_h]
        days = np.unique(np.concatenate([Rs[k]["day"][Rs[k]["T_h"] == T_h] for k in GENERIC]))
        idx, cnt = M3.draws(rng, len(days), T_h)
        boot_meta[f"POOLED_GENERIC|{TL}"] = M3._bmeta(days, idx, T_h)
        generic[TL] = pooled_stats(Rs, GENERIC, T_h, cnt, days)
        for a in BSPAN_ASSETS:
            matched[a][TL] = pooled_stats(Rs, ASSET_MATCHED[a], T_h)
    log(f"  pooled checks ({time.time() - t_start:.0f}s)")
    seed_counts = {a: {T_LABEL[T]: {"f": 0, "fc": 0} for T in HORIZONS_H} for a in DEV_ASSETS}
    for s in SEEDS_FURTHER:
        rs = np.random.default_rng(s)
        for a in DEV_ASSETS:
            for T_h in HORIZONS_H:
                days = dev_days[(a, T_h)]
                _, cnt = M3.draws(rs, len(days), T_h)
                sel, pos = sels[(a, T_h)]
                for r in ("f", "fc"):
                    lo = M3.ci_lower(sel, pos, len(days), cnt, r, "a")
                    seed_counts[a][T_LABEL[T_h]][r] += int(lo is not None and lo > 0)
    del sels
    log(f"  seed stability ({time.time() - t_start:.0f}s)")
    # labels, checks, basis, shipping
    shipped, frozen, label_rows = {}, {}, []
    ladder_keys = {repr(float(x)) for x in LADDER}
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            cell = res_dev[a][TL]
            labs = {r: {} for r in RUNGS}
            for kk, lvd in cell["levels"].items():
                on_ladder = kk in ladder_keys
                for r in RUNGS:
                    d = lvd[r]
                    entry = {"pooled": d["pooled"]["label"] if d.get("pooled") else None}
                    for gi, g in enumerate(REGIMES):
                        st = d.get(g)
                        am = matched[a][TL]["levels"].get(kk, {}).get(r, {}).get(g) if a in BSPAN_ASSETS else None
                        gen = generic[TL]["levels"].get(kk, {}).get(r, {}).get(g) if on_ladder else None
                        if st is None:
                            entry[g] = {"dev": None, "after": None, "outcome": "no rows"}
                            continue
                        after, outcome = label_after_checks(a, st["label"], am, gen, on_ladder)
                        checks = []
                        if a in BSPAN_ASSETS:
                            checks.append(("asset-matched", check_state(am)))
                        checks.append(("generic", check_state(gen)))
                        bstr, bdet, bk, bn = basis(st, st["label"], checks)
                        entry[g] = {"dev": st["label"], "after": after, "outcome": outcome, "basis": bstr,
                                    "basis_checks": bdet, "k": bk, "n": bn, "n_ep": st["n_ep"], "R": st["R"],
                                    "R_ci95": st["R_ci95"], "cov_inf": st["cov_inf"],
                                    "asset_matched": {"R": am["R"], "n_ep": am["n_ep"]} if am else None,
                                    "generic": {"R": gen["R"], "n_ep": gen["n_ep"]} if gen else None}
                        label_rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                           "dev_label": st["label"], "outcome": outcome, "label": after,
                                           "basis": bstr, "n_ep": st["n_ep"], "R": st["R"],
                                           "asset_matched_R": am["R"] if am else None,
                                           "asset_matched_n_ep": am["n_ep"] if am else None,
                                           "generic_R": gen["R"] if gen else None,
                                           "generic_n_ep": gen["n_ep"] if gen else None})
                    labs[r][kk] = entry
            comps = cell["comparisons"]
            elig, elig_info = ["a"], {}
            for r in ("f", "fc"):
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
            bss_a = {"a": 0.0, "f": (comps.get("f_vs_a") or {}).get("bss"), "fc": (comps.get("fc_vs_a") or {}).get("bss")}
            ship, info = ship_choice(elig, dom, n_high, n_med, bss_a)
            cell["shipping"] = {"eligibility": elig_info, "dominance": {f"{k[0]}>{k[1]}": v for k, v in dom.items()},
                                "n_high": n_high, "n_medium": n_med, "bss_vs_a": bss_a, "shipped_rung": ship, **info}
            cell["labels"] = labs
            shipped.setdefault(a, {})[TL] = ship
            frozen.setdefault(a, {})[TL] = labs
    log(f"  labels and shipping ({time.time() - t_start:.0f}s)")
    # forecast bands for the shipped rung (A4.3)
    bands_rows, band_de, band_check = {}, {}, {}
    holder = {}

    def consume(a, T_h, f, cnt, state):
        ser = S[f"long:{a}"]
        ship = shipped[a][T_LABEL[T_h]]
        te = np.array([ser.N]) if f["name"] == "DATA_END" else M3.test_times(f, ser, ser.issue_mask())
        smp, state = band_for(S, a, T_h, f, cnt, state, ship, te)
        lo, hi = np.percentile(smp, BAND_PCT, axis=0)
        holder[(a, T_h, f["name"])] = (te, lo, hi)
        return state

    replay_band_draws(S, shipped, consume=consume)
    log(f"  bands ({time.time() - t_start:.0f}s)")
    for a in DEV_ASSETS:
        R = Rs[a]
        ser = S[f"long:{a}"]
        te_all, fold_of = R["_te"]
        fl = M3.dev_folds(ser)
        K, nT = len(ser.levels), len(HORIZONS_H)
        LO = np.full((len(te_all), nT, K), np.nan)
        HI = np.full((len(te_all), nT, K), np.nan)
        for ti, T_h in enumerate(HORIZONS_H):
            off = 0
            for f in fl:
                te, lo, hi = holder[(a, T_h, f["name"])]
                LO[off:off + len(te), ti] = lo
                HI[off:off + len(te), ti] = hi
                off += len(te)
        LO, HI = A.monotone_fix(LO), A.monotone_fix(HI)
        # point forecast of the shipped rung per (t0, T, k) for widening
        lo_rows, hi_rows = np.full(len(R["y"]), np.nan), np.full(len(R["y"]), np.nan)
        tpos = np.searchsorted(te_all, R["t0_i"])
        for ti, T_h in enumerate(HORIZONS_H):
            m = R["T_h"] == T_h
            p = R[f"p_{shipped[a][T_LABEL[T_h]]}"][m]
            lo_rows[m] = np.minimum(LO[tpos[m], ti, R["k_i"][m]], p)
            hi_rows[m] = np.maximum(HI[tpos[m], ti, R["k_i"][m]], p)
        bands_rows[a] = (lo_rows, hi_rows)
        # DATA_END band
        glo = np.array([holder[(a, T, "DATA_END")][1][0] for T in HORIZONS_H])
        ghi = np.array([holder[(a, T, "DATA_END")][2][0] for T in HORIZONS_H])
        glo, ghi = A.monotone_fix(glo[None])[0], A.monotone_fix(ghi[None])[0]
        pde = np.array([data_end[a][shipped[a][T_LABEL[T]]][ti] for ti, T in enumerate(HORIZONS_H)])
        band_de[a] = {"lo": np.minimum(glo, pde).tolist(), "hi": np.maximum(ghi, pde).tolist(), "p": pde.tolist()}
        # band check
        band_check[a] = {}
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
            band_check[a][T_LABEL[T_h]] = {"informative_cells": n_inf, "covered": cov,
                                           "share": (cov / n_inf) if n_inf else None}
    del holder
    # outputs
    for a in DEV_ASSETS:
        write_rows(os.path.join(out_dir, f"predictions-dev-{a}.csv.gz"), [(a, Rs[a])], bands=bands_rows[a])
    for k in okeys:
        write_rows(os.path.join(out_dir, f"predictions-{k.replace(':', '-')}.csv.gz"), [(k, Rs[k])])
    th_cols = ["series", "T", "fold", "regime"] + [f"{p}_b{b}" for p in ("theta", "O", "E") for b in range(3)]
    A.write_csv(os.path.join(out_dir, "theta-table.csv"), th_cols, thetas)
    A.write_csv(os.path.join(out_dir, "labels-frozen.csv"),
                ["asset", "T", "k", "rung", "regime", "dev_label", "outcome", "label", "basis", "n_ep", "R",
                 "asset_matched_R", "asset_matched_n_ep", "generic_R", "generic_n_ep"], label_rows)
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            res_dev[a][TL]["p_data_end"] = {r: (data_end[a][r][HORIZONS_H.index(T_h)].tolist() if r in data_end[a]
                                                else None) for r in RUNGS}
            res_dev[a][TL]["theta_data_end"] = data_end[a]["theta"][TL]
    counts = {a: {TL: {"dev": label_counts(frozen[a][TL][shipped[a][TL]], "dev"),
                       "after_checks": label_counts(frozen[a][TL][shipped[a][TL]], "after")}
                  for TL in shipped[a]} for a in DEV_ASSETS}
    frozen_doc = {"what": "Q26 A4 frozen shipped rung per (asset, T), labels and basis strings, before blind set 3 "
                          "(A4.5)", "prereg": PREREG, "shipped": shipped, "labels": frozen, "band_data_end": band_de,
                  "fixed_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    doc = {"test": "Q26 workstream A4 -- development data", "prereg": PREREG, "code": code_meta(), "inputs": meta,
           "locked_files_dev": lmeta, "environment": M3.env_meta(workers), "DECISIONS": DECISIONS,
           "deviations_run": [], "stored_a_check": stored, "bootstrap": boot_meta, "seed_registered": SEED_REG,
           "seed_band": SEED_BAND, "seed_stability": seed_counts, "per_asset": res_dev, "other_series": res_other,
           "generic_pooled": generic, "asset_matched_pooled": matched, "shipped": shipped,
           "label_counts_shipped": counts, "band_check": band_check, "band_data_end": band_de,
           "run": {"started_utc": started, "fit_predict_seconds": round(t_fit, 1)}}
    write_json(fpath, frozen_doc, refuse_overwrite=True)
    fsha = A.sha256_file(fpath)
    with open(fpath + ".sha256", "w") as f:
        f.write(f"{fsha}  frozen-a4.json\n")
    doc["frozen_file"] = {"file": "frozen-a4.json", "sha256": fsha}
    doc["run"].update(total_seconds=round(time.time() - t_start, 1),
                      finished_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    write_json(rpath, doc, refuse_overwrite=True)
    log(f"results-dev written ({time.time() - t_start:.0f}s)")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: blind set 3 (ONCE, after the freeze, with the published commit)
# ---------------------------------------------------------------------------------------------
def blind3_files(datasets, commit):
    r = subprocess.run(["git", "-C", datasets, "ls-tree", "--name-only", f"{commit}:{BLIND3_DIR}"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"STOP: commit {commit} has no {BLIND3_DIR}/")
    names = sorted(n for n in r.stdout.split() if n.endswith("-1h.json") or n.endswith("-1h.json.gz"))
    if not names:
        raise SystemExit("STOP: no '*-1h.json' grids in blind set 3")
    meta = {}
    for n in names:
        rel = f"{BLIND3_DIR}/{n}"
        want = subprocess.run(["git", "-C", datasets, "rev-parse", f"{commit}:{rel}"], capture_output=True, text=True)
        got = subprocess.run(["git", "-C", datasets, "hash-object", rel], capture_output=True, text=True)
        if want.returncode or got.returncode or want.stdout.strip() != got.stdout.strip():
            raise SystemExit(f"STOP: {rel} does not match the git blob at {commit}")
        meta[n] = {"path": rel, "git_blob": got.stdout.strip(), "sha256": A.sha256_file(os.path.join(datasets, rel))}
    return names, meta


def run_blind3(datasets, out_dir, meta_inputs, commit, workers=2, log=print, verify=True, names_override=None):
    bpath = os.path.join(out_dir, "results-blind3.json")
    marker = os.path.join(out_dir, "blind3-run.started")
    if os.path.exists(bpath) or os.path.exists(marker):
        raise SystemExit("STOP: blind set 3 has already been read (results or start marker exist). It is read once.")
    fpath, dpath = os.path.join(out_dir, "frozen-a4.json"), os.path.join(out_dir, "results-dev.json")
    if not (os.path.exists(fpath) and os.path.exists(dpath)):
        raise SystemExit("STOP: frozen-a4.json and results-dev.json must exist before blind set 3 is read.")
    if not commit:
        raise SystemExit("STOP: --blind3-commit (the published blind set 3 commit) is required.")
    with open(dpath) as f:
        dev = json.load(f)
    fsha = A.sha256_file(fpath)
    if fsha != dev["frozen_file"]["sha256"]:
        raise SystemExit("STOP: frozen-a4.json sha256 mismatch")
    with open(fpath) as f:
        frozen = json.load(f)
    with open(marker, "w") as f:
        f.write(json.dumps({"started_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                            "frozen_sha256": fsha, "commit": commit}) + "\n")
    t_start = time.time()
    if verify:
        names, fmeta = blind3_files(datasets, commit)
    else:
        names, fmeta = names_override, {n: {"path": f"{BLIND3_DIR}/{n}", "verified": False} for n in names_override}
    global _SER
    S, folds = {}, {}
    for n in names:
        st, cols = M3.load_locked_grid(os.path.join(datasets, BLIND3_DIR, n))
        key = "blind3:" + n.split("-1h.json")[0]
        ser = M3.S3(key, key.split(":", 1)[1], "binance", cols["close"], cols["low"], LADDER, st, st)
        S[key] = ser
        folds[key] = M3.quarters(M3.first_quarter_after(st, 365), (2026, 3), ser)
        fmeta[n].update(first_kline=A.iso(st), folds=[f["name"] for f in folds[key]])
    keys = [k for k in S if folds[k]]
    _SER = dict(S)
    _SER["__folds__"] = folds
    outs = run_pool([("ser", k, T) for k in keys for T in HORIZONS_H], workers, log, t_start)
    Rs = {}
    for k in keys:
        Rs[k], _, _ = assemble4(S[k], folds[k], {T: outs[(k, T)] for T in HORIZONS_H})
    del outs
    rng = np.random.default_rng(SEED_BLIND3)
    per_pair = {}
    for k in keys:
        per_pair[k] = {"folds": Rs[k]["fold_names"], "per_T": {}}
        for T_h in HORIZONS_H:
            days = np.unique(Rs[k]["day"][Rs[k]["T_h"] == T_h])
            if len(days) < A.block_length(T_h):
                per_pair[k]["per_T"][T_LABEL[T_h]] = {"skipped": "fewer days than the block length"}
                continue
            _, cnt = M3.draws(rng, len(days), T_h)
            sc, _, _ = score_T(Rs[k], T_h, cnt, days, with_labels=False)
            per_pair[k]["per_T"][T_LABEL[T_h]] = sc
    pooled = {}
    for T_h in HORIZONS_H:
        days = np.unique(np.concatenate([Rs[k]["day"][Rs[k]["T_h"] == T_h] for k in keys]))
        _, cnt = M3.draws(rng, len(days), T_h)
        pooled[T_LABEL[T_h]] = pooled_stats(Rs, keys, T_h, cnt, days)
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
                        chk["blind set 3"] = check_state(st)
                        n = sum(v != "n/a" for v in chk.values())
                        k_ = sum(v == "held" for v in chk.values())
                        bstr = f"held in {k_} of {n} checks"
                        final.setdefault(a, {}).setdefault(TL, {}).setdefault(r, {}).setdefault(kk, {})[g] = {
                            "label": x["after"], "basis": bstr, "basis_checks": chk,
                            "blind3": {"R": st["R"], "n_ep": st["n_ep"]} if st else None}
                        rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                     "shipped": frozen["shipped"][a][TL] == r, "label": x["after"], "basis": bstr,
                                     "blind3_R": st["R"] if st else None, "blind3_n_ep": st["n_ep"] if st else None})
    A.write_csv(os.path.join(out_dir, "basis-final.csv"),
                ["asset", "T", "k", "rung", "regime", "shipped", "label", "basis", "blind3_R", "blind3_n_ep"], rows)
    for k in keys:
        write_rows(os.path.join(out_dir, f"predictions-blind3-{k.split(':', 1)[1]}.csv.gz"), [(k, Rs[k])])
    doc = {"test": "Q26 workstream A4 -- blind set 3 (A4.7, read once)", "prereg": PREREG, "code": code_meta(),
           "inputs": meta_inputs, "DECISIONS": DECISIONS, "deviations_run": [], "blind3_commit": commit,
           "blind3_files": fmeta, "frozen_file": {"file": "frozen-a4.json", "sha256": fsha},
           "results_dev_sha256": A.sha256_file(dpath), "seed": SEED_BLIND3, "per_pair": per_pair, "pooled": pooled,
           "final_basis": final, "run": {"total_seconds": round(time.time() - t_start, 1),
                                         "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}}
    write_json(bpath, doc, refuse_overwrite=True)
    log(f"results-blind3 written ({time.time() - t_start:.0f}s)")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: panel (preview before blind set 3; final after)
# ---------------------------------------------------------------------------------------------
def run_panel(datasets, out_dir, meta, final=False, try_rpc=True, log=print):
    path = os.path.join(out_dir, "panel.json" if final else "panel-preview.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    with open(os.path.join(out_dir, "results-dev.json")) as f:
        dev = json.load(f)
    fpath = os.path.join(out_dir, "frozen-a4.json")
    if A.sha256_file(fpath) != dev["frozen_file"]["sha256"]:
        raise SystemExit("STOP: frozen-a4.json sha256 mismatch")
    with open(fpath) as f:
        frozen = json.load(f)
    fin = None
    if final:
        with open(os.path.join(out_dir, "results-blind3.json")) as f:
            fin = json.load(f)["final_basis"]
    shipped = frozen["shipped"]
    D = M3.build_dev(datasets)
    panel = {"phase": "panel" if final else "panel-preview", "prereg": PREREG, "code": code_meta(), "inputs": meta,
             "frozen_sha256": dev["frozen_file"]["sha256"], "basis_includes_blind3": bool(final), "assets": {}}
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
                                                "price": r_asof["answer"] / 10 ** dec},
                           "n_rounds_after_data_end": int(sum(r["updatedAt"] > DATA_END for r in rounds))}
            asof_info = {"data_end": A.iso(DATA_END), "source": "chainlink getRoundData via public RPC",
                         "asof": A.iso(asof_ts), "rpc_calls": rpc.calls, "rpc_errors": rpc.errors,
                         "read_at_utc": A.iso(now)}
        except Exception as e:
            asof_info["rpc_failed"] = f"{type(e).__name__}: {e}"
            live, rounds_all = {}, {}
    panel["asof"] = asof_info
    panel["live_chainlink"] = live
    asof_ts = A.utc(asof_info["asof"])
    ext_series, feat = {}, {}
    for a in DEV_ASSETS:
        ser = D[f"long:{a}"]
        if a in rounds_all and asof_ts > DATA_END:
            dec = A.FEEDS[a][1]
            ends = np.arange(DATA_END + STEP, asof_ts + 1, STEP)
            ext = np.array([A.answer_in_force(rounds_all[a], int(e))["answer"] / 10 ** dec for e in ends])
            sx = M3.S3(ser.name, a, ser.truth, np.concatenate([ser.close, ext]), np.concatenate([ser.low, ext]),
                       ser.levels, ser.base_ts, ser.ts(ser.start_i))
        else:
            ext, sx = np.array([]), ser
        g_now = int(sx.regime[sx.N])
        feat[a] = {"sigma": float(sx.sigma[sx.N]), "regime": g_now, "close": sx.close, "i_now": sx.N,
                   "rv_pct": float(sx.rv_pct[sx.N]) if np.isfinite(sx.rv_pct[sx.N]) else None, "live_hours": len(ext)}
        ext_series[a] = sx
    grids, bands = {}, {}

    def consume(a, T_h, f, cnt, state):
        if f["name"] != "DATA_END":
            return state
        ser = D[f"long:{a}"]
        ship = shipped[a][T_LABEL[T_h]]
        fe = feat[a]
        te = np.array([ser.N])
        P4 = Prep4(ser, T_h)
        o = predict4(ser, P4, T_h, ser.N, te, te_sigma=[fe["sigma"]], te_regime=[fe["regime"]])
        sx = ext_series[a]
        lv = np.asarray(ser.levels, float)
        for name, nd in M2.REF_DAYS.items():
            sg = A.ref_daily_sigma(sx.close, np.array([fe["i_now"]]), nd)
            o["raw"][name] = A.touch_prob(lv[None, :], sg[:, None], A.T_DAYS[T_h])
        Po = M3.Prep3(D[f"oracle:{a}"], T_h, beta_select=False)
        o["raw"]["a"] = Po.freq_upto(ser.N - T_h)[None, :]
        st = {"P4": P4, "Po": Po}
        smp, _ = band_for(D, a, T_h, f, cnt, st, ship, te, te_sigma=[fe["sigma"]], te_regime=[fe["regime"]])
        lo, hi = np.percentile(smp, BAND_PCT, axis=0)
        ti = HORIZONS_H.index(T_h)
        for r in RUNGS:
            grids.setdefault(a, {}).setdefault(r, np.full((len(HORIZONS_H), len(ser.levels)), np.nan))[ti] = \
                o["raw"][r][0]
        bands.setdefault(a, {"lo": np.full((len(HORIZONS_H), len(ser.levels)), np.nan),
                             "hi": np.full((len(HORIZONS_H), len(ser.levels)), np.nan)})
        bands[a]["lo"][ti] = lo[0]
        bands[a]["hi"][ti] = hi[0]
        return state

    replay_band_draws(D, shipped, consume=consume)
    shown = {}
    for a in DEV_ASSETS:
        ser = D[f"long:{a}"]
        fixed = {r: A.monotone_fix(g[None])[0] for r, g in grids[a].items() if not np.isnan(g).any()}
        lo_g, hi_g = A.monotone_fix(bands[a]["lo"][None])[0], A.monotone_fix(bands[a]["hi"][None])[0]
        g_now = feat[a]["regime"]
        gname = REGIMES[g_now] if g_now >= 0 else None
        cells = {}
        pgrid = np.array([fixed[shipped[a][T_LABEL[T]]][ti] for ti, T in enumerate(HORIZONS_H)])
        lo_g, hi_g = np.minimum(lo_g, pgrid), np.maximum(hi_g, pgrid)
        shown[a] = (pgrid, lo_g, hi_g, gname)
        for ti, T_h in enumerate(HORIZONS_H):
            TL = T_LABEL[T_h]
            ship = shipped[a][TL]
            row = {"rung": ship, "regime_now": gname, "period": dev["per_asset"][a][TL]["counts"]["period"], "levels": {}}
            for j, k in enumerate(ser.levels):
                kk = repr(float(k))
                e = frozen["labels"][a][TL][ship][kk].get(gname) if gname else None
                lab = e["after"] if e else "no regime"
                bstr = (fin[a][TL][ship][kk][gname]["basis"] if fin and gname else (e["basis"] if e else None))
                p, lo, hi = float(pgrid[ti, j]), float(lo_g[ti, j]), float(hi_g[ti, j])
                row["levels"][kk] = {"p": p, "lo": lo, "hi": hi, "regime": gname, "label": lab, "basis": bstr,
                                     "n_ep": e.get("n_ep") if e else None,
                                     "display": f"{A.fmt_p(p, dagger=False)}, likely {A.fmt_p(lo, dagger=False)}–"
                                                f"{A.fmt_p(hi, dagger=False)} · {lab} ({bstr}) · {gname} vol"}
            cells[TL] = row
        panel["assets"][a] = {"cells": cells, "regime_now": gname, "rv_pct_now": feat[a]["rv_pct"],
                              "sigma_hat_now": feat[a]["sigma"], "live_hours_spliced": feat[a]["live_hours"],
                              "grids_fixed_all_rungs": {r: g.tolist() for r, g in fixed.items()},
                              "band_lo": lo_g.tolist(), "band_hi": hi_g.tolist()}
    # ETH ACTION rows with ranges
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
        pp, _ = A.p_at_distance(lv, [float(v) for v in pg[ti7]], y_t)
        r.update(p_at_line=pp, lo_at_line=pl, hi_at_line=ph)
        if r.get("repay"):
            r["display"] = (f"Repay ${r['repay']:,} · line −{r['line_after_pct']}% · {r['Z']:.0%} "
                            f"({A.fmt_p(pl, dagger=False)}–{A.fmt_p(ph, dagger=False)}) [{r['label']}]")
        else:
            r["display"] = f"{r['text']} [{r['label']}]"
    panel["action_example"] = {"label": "EXAMPLE position (not a real position; no number goes into app code)",
                               "position": {"collateral": f"{C:g} ETH", "LT": LT, "spot_S": Sx, "debt_D_usd": Dd,
                                            "distance_y": y_now}, "regime_now": gname, "rows": rows,
                               "display": [r["display"] for r in rows]}
    write_json(path, panel, refuse_overwrite=True)
    return panel


def run_manifest(out_dir):
    return M3.run_manifest(out_dir)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", choices=("dryrun", "dev", "preview", "blind3", "panel", "manifest"), required=True)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--no-rpc", action="store_true")
    ap.add_argument("--blind3-commit", help="blind3: the published membrane-datasets commit holding blind3-prices/")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    if a.phase == "manifest":
        run_manifest(a.out)
        return 0
    meta = M2.verify_all(a.datasets)
    print("inputs verified", flush=True)
    log = lambda *x: print(*x, flush=True)  # noqa: E731
    if a.phase == "dryrun":
        run_dryrun(a.datasets, a.out, meta, log=log)
    elif a.phase == "dev":
        run_dev(a.datasets, a.out, meta, workers=a.workers, log=log)
    elif a.phase == "preview":
        run_panel(a.datasets, a.out, meta, final=False, try_rpc=not a.no_rpc, log=log)
    elif a.phase == "blind3":
        run_blind3(a.datasets, a.out, meta, a.blind3_commit, workers=a.workers, log=log)
    elif a.phase == "panel":
        run_panel(a.datasets, a.out, meta, final=True, try_rpc=not a.no_rpc, log=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
