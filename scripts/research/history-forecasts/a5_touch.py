#!/usr/bin/env python3
"""Q26 workstream A5 -- depth-specific volatility shrinkage (fbL), per-source checks as a rule, estimate ranges, and
blind set 4.

Implements triccs/membrane-board `design/HISTORY_TOUCH_PREREG_A5.md` (registered at commit c0b400d, file sha256
f9af7a428e4b940e70fb8186c7d81da8337d5324f61d7bd532de590a8ae80301). Parents: A, A2 (D1-D3), A3 (D1), A4 (D1); every
definition not changed by A5 holds. The A/A2/A3/A4 code is imported and never modified.

Phases (run in this order into a fresh --out):
  dryrun    data-only counts (blind set 4 is not read)                                      -> dryrun.json
  dev       all development data (A4 data + blind set 3) fit, predict, score ONCE; seed-stable shipping a/f/fbL;
            labels with the per-source rule, the asset-matched and generic checks; basis strings; estimate ranges;
            freeze -> results-dev.json, frozen-a5.json (+ .sha256), predictions-*.csv.gz, beta-table.csv
  preview   panel preview from the frozen labels (before blind set 4)                       -> panel-preview.json
  blind4    blind set 4 read ONCE, only with the freeze file and --blind4-commit; A5.6 method verdict
            -> results-blind4.json, basis-final.csv, predictions-blind4-*.csv.gz
  panel     current-day panel with the blind-4 basis                                        -> panel.json
  manifest  sha256 of every output                                                          -> manifest.json
Light models only (frequency counts and FHS counts).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):   # one thread per worker
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
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
import a4_touch as M4  # noqa: E402

PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/HISTORY_TOUCH_PREREG_A5.md",
    "commit": "c0b400d",
    "sha256": "f9af7a428e4b940e70fb8186c7d81da8337d5324f61d7bd532de590a8ae80301",
    "parents": {"A": A.PREREG, "A2": M2.PREREG, "A3": M3.PREREG, "A4": M4.PREREG,
                "A4_D1": "display rules after review (labels can only go down); range wording 'estimate range'"},
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
BLIND3_DIR, BLIND3_COMMIT = "blind3-prices", "87053e9"
BLIND4_DIR = "blind4-prices"
SOURCES = {"ETH": ("bspan:ETH", "locked:coinbase-eth-usd"),
           "BTC": ("bspan:BTC", "locked:bitstamp-btc-usd", "locked:coinbase-btc-usd")}   # + the Chainlink dev rows
ASSET_MATCHED = M4.ASSET_MATCHED

N_BOOT = 2000
SEED_REG = 20261060
SEEDS_FURTHER = tuple(20261061 + i for i in range(20))
MIN_SEEDS = 16
SEED_BAND = M4.SEED_BAND           # estimate ranges "as A4.3" (default_rng(20261040))
SEED_BLIND4 = 20261061
N_BAND_REP, BAND_PCT = M4.N_BAND_REP, M4.BAND_PCT

RUNGS = ("a", "f", "fbL", "r30", "r90")
SHIP_ORDER = ("a", "f", "fbL")
COMPARISONS = (("fbL_vs_a", "fbL", "a"), ("f_vs_a", "f", "a"), ("fbL_vs_f", "fbL", "f"),
               ("a_vs_f", "a", "f"), ("a_vs_fbL", "a", "fbL"), ("f_vs_fbL", "f", "fbL"),
               ("r30_vs_a", "r30", "a"), ("r90_vs_a", "r90", "a"))
REPORT_COMPARISONS = ("fbL_vs_a", "fbL_vs_f", "f_vs_a", "r30_vs_a", "r90_vs_a")
CHECK_NEP, CHECK_R = M2.BLIND_NEP, M2.BLIND_R
VERDICT_T = (6, 24, 72, 168)       # A5.6: BSS vs (f) CI lower bound > -0.002 at 6 h - 7 d
VERDICT_BSS_LO = -0.002

DECISIONS = [
    "D-D1 development data (A5.1): the A4 data (Chainlink dev ETH/BTC/stETH, B-span, the A2 eight, the A3 locked "
    "set) plus blind set 3 (membrane-datasets 87053e9, 23 pairs, each verified against its git blob; folds from "
    "the first quarter >= 365 d after the first kline to 2026Q3, as A4.7). A3.1 null-hour rule, sigma_hat, "
    "sigma_ref, regime and folds are A3's functions unchanged.",
    "D-B1 (fbL): A3's evaluation origins (labelled training origins with sigma_hat and sigma_ref, >= 365 d after the "
    "series' first labelled origin, an as-of forecast for every beta) and A3's as-of FHS counts per beta; the mean "
    "as-of Brier is taken per level band (shallow -2/-3/-5%, middle -7/-10/-15%, deep -20% and deeper; stETH one "
    "band) and beta is chosen per (series, T, fold, band) with A3's tie rule (0.5, then nearer 0.5, then the "
    "smaller). No evaluation origin -> 0.5. A level's forecast is the (fbeta) share with its band's beta (beta = 1 "
    "is exactly (f)); the monotone fix follows.",
    "D-S1 comparisons/eligibility/seed stability/dominance/choice: A3.4-A3.6 (A3 D-S1/D-S2, A4 D-S1) with candidates "
    "a, f, fbL; tie order a < f < fbL; registered draws default_rng(20261060): dev ETH, BTC, stETH > T; then "
    "B-span ETH, BTC; the A2 eight; the A3 ten Binance pairs; Bitstamp BTC, Coinbase BTC, Coinbase ETH; the 23 "
    "blind-3 pairs in file-name order (each > T); then the pooled generic set > T. Further seeds 20261061..20261080 "
    "replay only the dev draws.",
    "D-S2 compute layout: each non-dev series is fit, monotone-fixed and written whole inside a worker, which "
    "returns day-level squared-error sums per comparison (rows where both rungs exist; pooled and per regime) and "
    "per (T, level, regime, rung) sum p, sum y, rows and episodes. Every BSS CI is computed in the main process "
    "from those sums with the registered draws, so the numbers equal a row-level computation.",
    "D-L1 labels: A3.5 v3. HIGH also needs (ETH/BTC) the A5.3 per-source rule: every single source with n_ep >= 10 "
    "(the Chainlink dev rows, B-span, locked Bitstamp, locked Coinbase of that asset; same rung, T, level, regime) "
    "has 0.67 <= R <= 1.5, else MEDIUM 'sources disagree'; the A4.4 pooled asset-matched check (the asset's other "
    "sources pooled, Chainlink dev rows excluded); and the generic check (the A4 18 holdouts plus the 23 blind-3 "
    "pairs pooled). stETH: generic only, at levels on the holdout ladder. Outcome order: 'sources disagree', "
    "'failed asset-matched', 'failed generic', then 'unconfirmed asset-matched', 'unconfirmed generic'.",
    "D-L2 basis string (A4.4): dev calibration, asset-matched (pooled), generic (A4 generic + blind set 3), blind set "
    "4 (after A5.6); each counts at n_ep >= 10. The live check is added when the live log has resolved rows (none "
    "at the freeze). The per-source rule decides labels; it is reported beside the basis, not counted in it.",
    "D-E1 estimate ranges (A4.3 and A4 D1 wording): A4's procedure and draw stream (default_rng(20261040), ETH, BTC, "
    "stETH > T > folds > DATA_END, day set of the shipped rung's training series); for (fbL) each band's beta stays "
    "at the fold's chosen value inside a resample (the as-of Brier is not recomputed per resample).",
    "D-V1 A5.6 method verdict: deep-band cells (-20/-25/-30/-40%) x every horizon x the low and high regimes, pooled "
    "over blind-4 pairs, kept when both (f) and (fbL) have n_ep >= 10 and a finite positive R; fbL passes when its "
    "median |ln R| is smaller than (f)'s AND the pooled BSS(fbL vs f) CI lower bound is > -0.002 at 6h, 1d, 3d and "
    "7d. Draws default_rng(20261061): pairs in file-name order > T, then the pooled union day sets > T.",
]


def band_of(asset, levels):
    return M4.band_of(asset if asset in DEV_ASSETS else "ladder", levels)


# ---------------------------------------------------------------------------------------------
# (fbL): per-band beta from the as-of Brier
# ---------------------------------------------------------------------------------------------
class Prep5:
    def __init__(self, ser, T_h, q_max=None):
        self.P = M3.Prep3(ser, T_h, beta_select=False)
        P = self.P
        self.T_h, self.K = T_h, P.K
        self.bands = band_of(ser.asset, ser.levels)
        self.nb = int(self.bands.max()) + 1
        n = len(P.lab_ok)
        i = np.arange(n)
        q_max = n if q_max is None else q_max
        self.ready = False
        if P.first_lab is None:
            return
        ev = (P.lab_ok & np.isfinite(ser.sigma) & np.isfinite(ser.sigma_ref)
              & (i >= P.first_lab + BETA_HISTORY_DAYS * 24) & (i + T_h <= q_max))
        asof = {}
        for b in BETAS:
            thr = P.thresholds(P.sig[b])
            asof[b] = M2.asof_fhs_counts(P.valid[b], P.z[b], ev, np.where(np.isfinite(thr), thr, 0.0), T_h)
        for b in BETAS:
            ev &= np.all(np.isfinite(asof[b]), axis=1)
        Y = np.where(P.lab_ok[:, None], np.nan_to_num(P.Y), 0.0)
        self.cumE = np.cumsum(ev.astype(np.int64))
        self.kb = np.array([(self.bands == bb).sum() for bb in range(self.nb)])
        self.cumSE = {}
        for b in BETAS:
            sq = (np.nan_to_num(asof[b]) - Y) ** 2
            for bb in range(self.nb):
                se = np.where(ev, sq[:, self.bands == bb].sum(axis=1), 0.0)
                self.cumSE[(b, bb)] = np.cumsum(se)
        self.ready = True

    def choose(self, qs_i):
        """{band: (beta, info)} for the fold with Q_start = qs_i (D-B1)."""
        lim = qs_i - self.T_h
        out = {}
        for bb in range(self.nb):
            if not self.ready or lim < 0 or self.cumE[min(lim, len(self.cumE) - 1)] == 0:
                out[bb] = (0.5, {"n_eval": 0, "brier": None, "rule": "no evaluation origin -> 0.5"})
                continue
            lim2 = min(lim, len(self.cumE) - 1)
            ne = int(self.cumE[lim2])
            br = {b: float(self.cumSE[(b, bb)][lim2] / (ne * self.kb[bb])) for b in BETAS}
            out[bb] = (M3.pick_beta(br), {"n_eval": ne, "brier": br, "rule": "min as-of Brier in the band"})
        return out


def sigma_beta_at(sg, sr, b):
    if b == 1.0:
        return sg
    if b == 0.0:
        return sr
    with np.errstate(invalid="ignore"):
        return np.power(sg, b) * np.power(sr, 1.0 - b)


def predict5(ser, P5, T_h, qs_i, te, te_sigma=None, te_sigma_ref=None, te_close=None):
    P = P5.P
    o = M3.predict3(ser, P, T_h, qs_i, te, 1.0, te_sigma=te_sigma,
                    te_sigma_ref=te_sigma_ref, te_close=te_close)
    o["raw"].pop("fb", None)
    sg = ser.sigma[te] if te_sigma is None else np.atleast_1d(np.asarray(te_sigma, float))
    sr = ser.sigma_ref[te] if te_sigma_ref is None else np.atleast_1d(np.asarray(te_sigma_ref, float))
    choice = P5.choose(qs_i)
    lim = qs_i - T_h
    i_all = np.arange(len(P.lab_ok))
    out = np.full((len(te), P5.K), np.nan)
    for bb, (b, _) in choice.items():
        cols = P5.bands == bb
        tr = P.valid[b] & (i_all <= lim)
        pb = M2.fhs_predict(P.z[b][tr], P.thresholds(sigma_beta_at(sg, sr, b)))
        out[:, cols] = pb[:, cols]
    o["raw"]["fbL"] = out
    o["betas"] = {int(bb): v for bb, v in choice.items()}
    return o


# ---------------------------------------------------------------------------------------------
# Series, tasks, assembly, reduction
# ---------------------------------------------------------------------------------------------
_SER = {}


def build_blind3(datasets, verify=True):
    names, meta = blind_files(datasets, BLIND3_DIR, BLIND3_COMMIT) if verify else (None, {})
    S, folds = {}, {}
    for n in names:
        st, cols = M3.load_locked_grid(os.path.join(datasets, BLIND3_DIR, n))
        key = "blind3:" + n.split("-1h.json")[0]
        ser = M3.S3(key, key.split(":", 1)[1], "binance", cols["close"], cols["low"], LADDER, st, st)
        S[key] = ser
        folds[key] = M3.quarters(M3.first_quarter_after(st, 365), (2026, 3), ser)
        meta[n].update(first_kline=A.iso(st), folds=[f["name"] for f in folds[key]])
    return S, folds, meta


def blind_files(datasets, sub, commit):
    r = subprocess.run(["git", "-C", datasets, "ls-tree", "--name-only", f"{commit}:{sub}"], capture_output=True,
                       text=True)
    if r.returncode != 0:
        raise SystemExit(f"STOP: commit {commit} has no {sub}/")
    names = sorted(n for n in r.stdout.split() if n.endswith("-1h.json") or n.endswith("-1h.json.gz"))
    if not names:
        raise SystemExit(f"STOP: no '*-1h.json' grids in {sub}")
    meta = {}
    for n in names:
        rel = f"{sub}/{n}"
        want = subprocess.run(["git", "-C", datasets, "rev-parse", f"{commit}:{rel}"], capture_output=True, text=True)
        got = subprocess.run(["git", "-C", datasets, "hash-object", rel], capture_output=True, text=True)
        if want.returncode or got.returncode or want.stdout.strip() != got.stdout.strip():
            raise SystemExit(f"STOP: {rel} does not match the git blob at {commit}")
        meta[n] = {"path": rel, "git_blob": got.stdout.strip(), "sha256": A.sha256_file(os.path.join(datasets, rel)),
                   "verified_against": commit}
    return names, meta


def build_all(datasets, verify=True):
    S, folds, lmeta = M4.build_all(datasets, verify_locked=verify)
    B3, f3, m3 = build_blind3(datasets, verify=verify)
    S.update(B3)
    folds.update(f3)
    return S, folds, {"locked": lmeta, "blind3": m3}


def other_keys(S):
    return (["bspan:ETH", "bspan:BTC"] + list(M4.A2_HOLDOUTS) + list(M4.A3_BINANCE) + list(M4.A3_USD)
            + sorted(k for k in S if k.startswith("blind3:")))


def generic_keys(S):
    return list(M4.GENERIC) + sorted(k for k in S if k.startswith("blind3:"))


def _clear(ser):
    ser._lab.clear()
    ser._wmin.clear()


def fold_loop(ser, P5, T_h, folds, data_end=False, P_a=None):
    imask = ser.issue_mask()
    res = []
    fl = list(folds) + ([{"name": "DATA_END", "qs_i": ser.N, "qe_i": ser.N + 1}] if data_end else [])
    for f in fl:
        te = M3.test_times(f, ser, imask) if f["name"] != "DATA_END" else np.array([ser.N])
        o = predict5(ser, P5, T_h, f["qs_i"], te)
        if P_a is not None:
            o["raw"]["a"] = np.tile(P_a.freq_upto(f["qs_i"] - T_h), (len(te), 1))
        o.update(fold=f["name"], te=te)
        res.append(o)
    return res


def assemble5(ser, folds, per_T, y_check=None):
    K, nT = len(ser.levels), len(HORIZONS_H)
    first = [o for o in per_T[HORIZONS_H[0]] if o["fold"] != "DATA_END"]
    te_all = np.concatenate([o["te"] for o in first]) if first else np.array([], int)
    fold_of = np.concatenate([[fi] * len(o["te"]) for fi, o in enumerate(first)]).astype(int) if first else \
        np.array([], int)
    n = len(te_all)
    G = {r: np.full((n, nT, K), np.nan) for r in RUNGS}
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
            for bb, (b, info) in o["betas"].items():
                beta_rows.append({"series": ser.name, "T": T_LABEL[T_h], "fold": o["fold"], "band": bb, "beta": b,
                                  "n_eval": info["n_eval"], **{f"brier_b{x}": (info["brier"] or {}).get(x)
                                                               for x in BETAS}})
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
    R["_te"] = (te_all, fold_of)
    de = {}
    if data_end:
        for r in RUNGS:
            g = np.array([data_end[T]["raw"][r][0] for T in HORIZONS_H])
            if not np.isnan(g).any():
                de[r] = A.monotone_fix(g[None])[0]
        de["betas"] = {T_LABEL[T]: {int(bb): v[0] for bb, v in data_end[T]["betas"].items()} for T in HORIZONS_H}
    _clear(ser)
    if y_check is not None:
        _clear(y_check)
    return R, beta_rows, de


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


def reduce_series(R):
    """D-S2: day-level squared-error sums per comparison (pooled, per regime) and per-cell R inputs, per T."""
    out = {}
    for T_h in HORIZONS_H:
        m = R["T_h"] == T_h
        sel = M3.select(R, m)
        days = np.unique(sel["day"])
        pos = np.searchsorted(days, sel["day"])
        nd = len(days)
        y = sel["y"]
        comp = {}
        for cname, rm, rb in COMPARISONS:
            pm, pb = sel[f"p_{rm}"], sel[f"p_{rb}"]
            ok = np.isfinite(pm) & np.isfinite(pb)
            d = {}
            for gname, gval in (("pooled", None),) + tuple((g, gi) for gi, g in enumerate(REGIMES)):
                mm = ok if gval is None else ok & (sel["regime"] == gval)
                d[gname] = (np.bincount(pos[mm], weights=(pm[mm] - y[mm]) ** 2, minlength=nd),
                            np.bincount(pos[mm], weights=(pb[mm] - y[mm]) ** 2, minlength=nd), int(mm.sum()))
            comp[cname] = d
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
        out[T_h] = {"days": days, "comp": comp, "cells": cells, "brier": brier,
                    "counts": M3.counts_of(R, m, T_h)}
    return out


def series_task(key):
    ser = _SER[key]
    folds = _SER["__folds__"][key]
    out_dir = _SER["__out__"]
    prefix = _SER["__prefix__"]
    q_max = max(f["qs_i"] for f in folds) if folds else 0
    per_T, betas = {}, []
    for T_h in HORIZONS_H:
        P5 = Prep5(ser, T_h, q_max=q_max)
        per_T[T_h] = fold_loop(ser, P5, T_h, folds)
        del P5
    R, br, _ = assemble5(ser, folds, per_T)
    del per_T
    if out_dir:
        write_rows(os.path.join(out_dir, f"predictions-{prefix}{key.replace(':', '-')}.csv.gz"), [(key, R)])
    red = reduce_series(R)
    _clear(ser)
    return key, {"reduced": red, "betas": br, "folds": R["fold_names"]}


def dev_task(args):
    a, T_h = args
    ls, os_ = _SER[f"long:{a}"], _SER[f"oracle:{a}"]
    P5 = Prep5(ls, T_h)
    Pa = P5.P if os_ is ls else M3.Prep3(os_, T_h, beta_select=False)
    res = fold_loop(ls, P5, T_h, M3.dev_folds(ls), data_end=True, P_a=Pa)
    _clear(ls)
    _clear(os_)
    return (a, T_h), res


def _dispatch(t):
    if t[0] == "dev":
        k, r = dev_task(t[1])
        return ("dev",) + k, r
    k, r = series_task(t[1])
    return ("ser", k), r


def run_pool(tasks, workers, log, t0):
    outs = {}
    ctx = mp.get_context("fork")
    if workers > 1:
        with ctx.Pool(workers, maxtasksperchild=3) as pool:
            for k, r in pool.imap_unordered(_dispatch, tasks):
                outs[k] = r
                log(f"  fit {k} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    else:
        for t in tasks:
            k, r = _dispatch(t)
            outs[k] = r
            log(f"  fit {k} ({len(outs)}/{len(tasks)}) {time.time() - t0:.0f}s")
    return outs


# ---------------------------------------------------------------------------------------------
# Statistics from reduced sums
# ---------------------------------------------------------------------------------------------
def bss_from_sums(se_m, se_b, n, counts):
    out = {"n_rows": int(n), "bss": float(1.0 - se_m.sum() / se_b.sum()) if se_b.sum() > 0 else None}
    with np.errstate(divide="ignore", invalid="ignore"):
        reps = 1.0 - (counts @ se_m) / (counts @ se_b)
    fin = np.isfinite(reps)
    if fin.sum() > 1 and se_b.sum() > 0:
        lo, hi = np.percentile(reps[fin], [2.5, 97.5])
        out.update(ci95=[float(lo), float(hi)], ci_above_0=bool(lo > 0), ci_below_0=bool(hi < 0))
    else:
        out.update(ci95=None, ci_above_0=False, ci_below_0=False)
    return out


def series_comparisons(red_T, counts):
    out, byreg = {}, {g: {} for g in REGIMES}
    for cname, d in red_T["comp"].items():
        se_m, se_b, n = d["pooled"]
        if n:
            out[cname] = bss_from_sums(se_m, se_b, n, counts)
        if cname in REPORT_COMPARISONS:
            for g in REGIMES:
                se_m, se_b, n = d[g]
                if n:
                    byreg[g][cname] = bss_from_sums(se_m, se_b, n, counts)
    return out, byreg


def pooled_reduced(reds, keys, T_h):
    """Union of days; summed squared errors; summed cell inputs (n_ep = sum of per-series episodes)."""
    days = np.unique(np.concatenate([reds[k][T_h]["days"] for k in keys]))
    nd = len(days)
    comp = {}
    for cname, *_ in COMPARISONS:
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
    return {"days": days, "comp": comp, "cells": cells}


def cell_R(st):
    if st is None or st["n_rows"] == 0:
        return None
    sp, sy = st["sum_p"], st["sum_y"]
    R = (sp / sy) if sy > 0 else (float("inf") if sp > 0 else None)
    return {"R": R, "n_ep": int(st["n_ep"]), "n_rows": int(st["n_rows"]), "sum_p": sp, "sum_y": sy}


def per_source_rule(dev_stat, src_stats):
    """D-L1: 'held' / 'sources disagree'; the sources with n_ep >= 10 and their R."""
    srcs = [("chainlink-dev", dev_stat)] + list(src_stats)
    used, bad = [], []
    for name, st in srcs:
        if st is None or st.get("n_ep") is None or st["n_ep"] < CHECK_NEP:
            continue
        R = st.get("R")
        ok = R is not None and math.isfinite(R) and CHECK_R[0] <= R <= CHECK_R[1]
        used.append({"source": name, "R": R, "n_ep": st["n_ep"], "inside": bool(ok)})
        if not ok:
            bad.append(name)
    return ("sources disagree" if bad else "held"), used


def label_after(asset, dev_label, rule_state, am, gen, on_ladder):
    if dev_label != "HIGH":
        return dev_label, "not HIGH"
    if asset == "stETH" and not on_ladder:
        return "MEDIUM", "unconfirmed (level not on the holdout ladder)"
    if asset in BSPAN_ASSETS and rule_state == "sources disagree":
        return "MEDIUM", "sources disagree"
    checks = ([("asset-matched", M3.check_one(am))] if asset in BSPAN_ASSETS else []) + [("generic", M3.check_one(gen))]
    for name, c in checks:
        if c == "failed":
            return "MEDIUM", f"failed {name}"
    for name, c in checks:
        if c == "unconfirmed":
            return "MEDIUM", f"unconfirmed {name}"
    return "HIGH", "passed checks"


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
    out["comparisons"] = M3.comparisons(sel, pos, len(days), counts, COMPARISONS)
    out["comparisons_by_regime"] = {g: M3.comparisons(sel, pos, len(days), counts,
                                                      [c for c in COMPARISONS if c[0] in REPORT_COMPARISONS],
                                                      mask=sel["regime"] == gi) for gi, g in enumerate(REGIMES)}
    out["levels"] = M3.level_stats_by_regime(sel, pos, len(days), counts, T_h, last_folds, RUNGS, True)
    return out, sel, pos


# ---------------------------------------------------------------------------------------------
# Estimate ranges (A4.3 procedure) for the shipped rung
# ---------------------------------------------------------------------------------------------
def band_samples_fbL(ser, P5, qs_i, te, counts, te_sigma=None, te_sigma_ref=None, chunk=50):
    P = P5.P
    T = P5.T_h
    n = len(P.lab_ok)
    i = np.arange(n)
    days, pos, _ = M4.fold_days(ser, P.lab_ok, T, qs_i)
    assert counts.shape[1] == len(days), "range draws do not match the training days"
    lim = qs_i - T
    sg = ser.sigma[te] if te_sigma is None else np.atleast_1d(np.asarray(te_sigma, float))
    sr = ser.sigma_ref[te] if te_sigma_ref is None else np.atleast_1d(np.asarray(te_sigma_ref, float))
    out = np.empty((counts.shape[0], len(te), P5.K))
    for bb, (b, _) in P5.choose(qs_i).items():
        cols = np.where(P5.bands == bb)[0]
        trb = P.valid[b] & (i <= lim)
        z = P.z[b][trb]
        order = np.argsort(z, kind="mergesort")
        zs, dpos = z[order], pos[trb][order]
        idx = np.searchsorted(zs, P.thresholds(sigma_beta_at(sg, sr, b))[:, cols], side="right")
        for s in range(0, counts.shape[0], chunk):
            W = counts[s:s + chunk][:, dpos]
            cw = np.concatenate([np.zeros((W.shape[0], 1)), np.cumsum(W, axis=1)], axis=1)
            out[s:s + chunk][:, :, cols] = cw[:, idx] / cw[:, -1][:, None, None]
    return out


def range_for(S, a, T_h, f, cnt, state, rung, te, te_sigma=None, te_sigma_ref=None):
    if state is None:
        state = {"P5": Prep5(S[f"long:{a}"], T_h) if rung in ("f", "fbL") else None,
                 "Po": M3.Prep3(S[f"oracle:{a}"], T_h, beta_select=False) if rung == "a" else None}
    if rung == "a":
        smp = M4.band_samples_a(S[f"oracle:{a}"], state["Po"], f["qs_i"], len(te), cnt)
    elif rung == "f":
        P4like = type("P4", (), {})()
        P4like.P, P4like.T_h, P4like.K = state["P5"].P, T_h, state["P5"].K
        smp = M4.band_samples_f(S[f"long:{a}"], P4like, f["qs_i"], te, cnt, fc=False, te_sigma=te_sigma)
    else:
        smp = band_samples_fbL(S[f"long:{a}"], state["P5"], f["qs_i"], te, cnt, te_sigma=te_sigma,
                               te_sigma_ref=te_sigma_ref)
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
    files = ("a5_touch.py", "test_a5_touch.py", "a4_touch.py", "a3_touch.py", "a2_touch.py", "a_touch.py")
    return {"path": "scripts/research/history-forecasts/a5_touch.py", "sha256": A.sha256_file(here),
            "deps_sha256": {f: A.sha256_file(os.path.join(d, f)) for f in files[2:]},
            "git": {"head_commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
                    "a5_touch_last_commit": run("log", "-1", "--format=%H", "--", "a5_touch.py"),
                    "dirty_code_files": run("status", "--porcelain", "--", *files).splitlines()}}


def to_cells_R(cells):
    return {kk: {r: {g: cell_R(st) for g, st in d.items()} for r, d in lv.items()} for kk, lv in cells.items()}


# ---------------------------------------------------------------------------------------------
# Phase: dry run
# ---------------------------------------------------------------------------------------------
def run_dryrun(datasets, out_dir, meta, log=print):
    path = os.path.join(out_dir, "dryrun.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    t0 = time.time()
    S, folds, fmeta = build_all(datasets)
    out = {"phase": "dryrun", "prereg": PREREG, "code": code_meta(), "inputs": meta, "files": fmeta,
           "note": "Data-only counts. No label value, frequency, Brier, BSS or R. Blind set 4 is not read.",
           "series": {}}
    for key in ["long:ETH", "long:BTC", "long:stETH"] + other_keys(S):
        ser = S[key]
        fl = M3.dev_folds(ser) if key.startswith("long:") else folds.get(key, [])
        imask = ser.issue_mask()
        te = np.concatenate([M3.test_times(f, ser, imask) for f in fl]) if fl else np.array([], int)
        out["series"][key] = {"start": A.iso(ser.ts(ser.start_i)), "folds": [f["name"] for f in fl][:1] +
                              [f["name"] for f in fl][-1:], "n_folds": len(fl), "test_issue_times": int(len(te)),
                              "test_regime_counts": {g: int((ser.regime[te] == gi).sum())
                                                     for gi, g in enumerate(REGIMES)}}
    out["runtime_seconds"] = round(time.time() - t0, 1)
    write_json(path, out, refuse_overwrite=True)
    log(f"dryrun written ({time.time() - t0:.0f}s)")
    return out


# ---------------------------------------------------------------------------------------------
# Phase: development (scored ONCE) and freeze
# ---------------------------------------------------------------------------------------------
def run_dev(datasets, out_dir, meta, workers=2, log=print, verify=True):
    rpath, fpath = os.path.join(out_dir, "results-dev.json"), os.path.join(out_dir, "frozen-a5.json")
    for p in (rpath, fpath):
        if os.path.exists(p):
            raise SystemExit(f"STOP: {p} exists. The development run is scored once.")
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_start = time.time()
    global _SER
    S, folds, fmeta = build_all(datasets, verify=verify)
    okeys = other_keys(S)
    gkeys = generic_keys(S)
    _SER = dict(S)
    _SER.update({"__folds__": folds, "__out__": out_dir, "__prefix__": ""})
    log(f"series built {time.time() - t_start:.0f}s ({len(okeys)} other series)")
    tasks = [("dev", (a, T)) for a in DEV_ASSETS for T in HORIZONS_H] + [("ser", k) for k in okeys]
    outs = run_pool(tasks, workers, log, t_start)
    t_fit = time.time() - t_start
    Rs, beta_rows, data_end = {}, [], {}
    for a in DEV_ASSETS:
        ls, os_ = S[f"long:{a}"], S[f"oracle:{a}"]
        R, br, de = assemble5(ls, M3.dev_folds(ls), {T: outs[("dev", a, T)] for T in HORIZONS_H},
                              y_check=None if os_ is ls else os_)
        Rs[a], data_end[a] = R, de
        beta_rows += br
    stored = M3.check_stored_a(datasets, Rs)
    reds = {}
    for k in okeys:
        reds[k] = outs[("ser", k)]["reduced"]
        beta_rows += outs[("ser", k)]["betas"]
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
            sc, sel, pos = score_dev_T(Rs[a], T_h, cnt, days)
            sels[(a, T_h)] = (sel, pos)
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
    generic, matched = {}, {a: {} for a in BSPAN_ASSETS}
    for T_h in HORIZONS_H:
        TL = T_LABEL[T_h]
        pr = pooled_reduced(reds, gkeys, T_h)
        idx, cnt = M3.draws(rng, len(pr["days"]), T_h)
        boot_meta[f"POOLED_GENERIC|{TL}"] = M3._bmeta(pr["days"], idx, T_h)
        cmp_, byreg = series_comparisons(pr, cnt)
        generic[TL] = {"comparisons": cmp_, "comparisons_by_regime": byreg, "levels": to_cells_R(pr["cells"]),
                       "n_series": len(gkeys), "n_days": int(len(pr["days"]))}
        for a in BSPAN_ASSETS:
            pa = pooled_reduced(reds, list(ASSET_MATCHED[a]), T_h)
            matched[a][TL] = {"levels": to_cells_R(pa["cells"])}
    log(f"  pooled checks ({time.time() - t_start:.0f}s)")
    seed_counts = {a: {T_LABEL[T]: {"f": 0, "fbL": 0} for T in HORIZONS_H} for a in DEV_ASSETS}
    for s in SEEDS_FURTHER:
        rs = np.random.default_rng(s)
        for a in DEV_ASSETS:
            for T_h in HORIZONS_H:
                days = dev_days[(a, T_h)]
                _, cnt = M3.draws(rs, len(days), T_h)
                sel, pos = sels[(a, T_h)]
                for r in ("f", "fbL"):
                    lo = M3.ci_lower(sel, pos, len(days), cnt, r, "a")
                    seed_counts[a][T_LABEL[T_h]][r] += int(lo is not None and lo > 0)
    del sels
    log(f"  seed stability ({time.time() - t_start:.0f}s)")
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
                    for g in REGIMES:
                        st = d.get(g)
                        if st is None:
                            entry[g] = {"dev": None, "after": None, "outcome": "no rows"}
                            continue
                        am = matched[a][TL]["levels"].get(kk, {}).get(r, {}).get(g) if a in BSPAN_ASSETS else None
                        gen = generic[TL]["levels"].get(kk, {}).get(r, {}).get(g) if on_ladder else None
                        if a in BSPAN_ASSETS:
                            srcs = [(k, res_other[k]["per_T"][TL]["levels"].get(kk, {}).get(r, {}).get(g))
                                    for k in SOURCES[a]]
                            rule_state, used = per_source_rule({"R": st["R"], "n_ep": st["n_ep"]}, srcs)
                        else:
                            rule_state, used = "n/a", []
                        after, outcome = label_after(a, st["label"], rule_state, am, gen, on_ladder)
                        checks = ([("asset-matched", M4.check_state(am))] if a in BSPAN_ASSETS else []) + \
                            [("generic", M4.check_state(gen))]
                        bstr, bdet, bk, bn = M4.basis(st, st["label"], checks)
                        entry[g] = {"dev": st["label"], "after": after, "outcome": outcome, "basis": bstr,
                                    "basis_checks": bdet, "k": bk, "n": bn, "n_ep": st["n_ep"], "R": st["R"],
                                    "R_ci95": st["R_ci95"], "cov_inf": st["cov_inf"], "per_source": used,
                                    "per_source_rule": rule_state,
                                    "asset_matched": {"R": am["R"], "n_ep": am["n_ep"]} if am else None,
                                    "generic": {"R": gen["R"], "n_ep": gen["n_ep"]} if gen else None}
                        label_rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                           "dev_label": st["label"], "outcome": outcome, "label": after,
                                           "basis": bstr, "per_source_rule": rule_state,
                                           "per_source": ";".join(f"{u['source']}:{u['R']:.3f}/{u['n_ep']}"
                                                                  if u['R'] is not None and math.isfinite(u['R'])
                                                                  else f"{u['source']}:inf/{u['n_ep']}" for u in used),
                                           "n_ep": st["n_ep"], "R": st["R"],
                                           "asset_matched_R": am["R"] if am else None,
                                           "asset_matched_n_ep": am["n_ep"] if am else None,
                                           "generic_R": gen["R"] if gen else None,
                                           "generic_n_ep": gen["n_ep"] if gen else None})
                    labs[r][kk] = entry
            comps = cell["comparisons"]
            elig, elig_info = ["a"], {}
            for r in ("f", "fbL"):
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
            bss_a = {"a": 0.0, "f": (comps.get("f_vs_a") or {}).get("bss"),
                     "fbL": (comps.get("fbL_vs_a") or {}).get("bss")}
            ship, info = ship_choice(elig, dom, n_high, n_med, bss_a)
            cell["shipping"] = {"eligibility": elig_info, "dominance": {f"{k[0]}>{k[1]}": v for k, v in dom.items()},
                                "n_high": n_high, "n_medium": n_med, "bss_vs_a": bss_a, "shipped_rung": ship, **info}
            cell["labels"] = labs
            shipped.setdefault(a, {})[TL] = ship
            frozen.setdefault(a, {})[TL] = labs
    log(f"  labels and shipping ({time.time() - t_start:.0f}s)")
    holder = {}

    def consume(a, T_h, f, cnt, state):
        ser = S[f"long:{a}"]
        ship = shipped[a][T_LABEL[T_h]]
        te = np.array([ser.N]) if f["name"] == "DATA_END" else M3.test_times(f, ser, ser.issue_mask())
        smp, state = range_for(S, a, T_h, f, cnt, state, ship, te)
        lo, hi = np.percentile(smp, BAND_PCT, axis=0)
        holder[(a, T_h, f["name"])] = (te, lo, hi)
        return state

    M4.replay_band_draws(S, shipped, consume=consume)
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
            off = 0
            for f in fl:
                te, lo, hi = holder[(a, T_h, f["name"])]
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
        glo = A.monotone_fix(np.array([holder[(a, T, "DATA_END")][1][0] for T in HORIZONS_H])[None])[0]
        ghi = A.monotone_fix(np.array([holder[(a, T, "DATA_END")][2][0] for T in HORIZONS_H])[None])[0]
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
    del holder
    for a in DEV_ASSETS:
        write_rows(os.path.join(out_dir, f"predictions-dev-{a}.csv.gz"), [(a, Rs[a])], bands=ranges_rows[a])
    A.write_csv(os.path.join(out_dir, "beta-table.csv"), ["series", "T", "fold", "band", "beta", "n_eval"] +
                [f"brier_b{x}" for x in BETAS], beta_rows)
    A.write_csv(os.path.join(out_dir, "labels-frozen.csv"),
                ["asset", "T", "k", "rung", "regime", "dev_label", "outcome", "label", "basis", "per_source_rule",
                 "per_source", "n_ep", "R", "asset_matched_R", "asset_matched_n_ep", "generic_R", "generic_n_ep"],
                label_rows)
    beta_summary = {}
    for r in beta_rows:
        d = beta_summary.setdefault(r["series"], {}).setdefault(r["T"], {}).setdefault(str(r["band"]), {})
        d[str(r["beta"])] = d.get(str(r["beta"]), 0) + 1
    for a in DEV_ASSETS:
        for T_h in HORIZONS_H:
            TL = T_LABEL[T_h]
            res_dev[a][TL]["p_data_end"] = {r: (data_end[a][r][HORIZONS_H.index(T_h)].tolist() if r in data_end[a]
                                                else None) for r in RUNGS}
            res_dev[a][TL]["betas_data_end"] = data_end[a]["betas"][TL]
    counts = {a: {TL: {"dev": M4.label_counts(frozen[a][TL][shipped[a][TL]], "dev"),
                       "after_checks": M4.label_counts(frozen[a][TL][shipped[a][TL]], "after")}
                  for TL in shipped[a]} for a in DEV_ASSETS}
    frozen_doc = {"what": "Q26 A5 frozen shipped rung per (asset, T), labels and basis strings, before blind set 4 "
                          "(A5.3)", "prereg": PREREG, "shipped": shipped, "labels": frozen,
                  "range_data_end": range_de, "betas_data_end": {a: data_end[a]["betas"] for a in DEV_ASSETS},
                  "fixed_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    doc = {"test": "Q26 workstream A5 -- development data", "prereg": PREREG, "code": code_meta(), "inputs": meta,
           "files_dev": fmeta, "environment": M3.env_meta(workers), "DECISIONS": DECISIONS, "deviations_run": [],
           "stored_a_check": stored, "bootstrap": boot_meta, "seed_registered": SEED_REG, "seed_range": SEED_BAND,
           "seed_stability": seed_counts, "per_asset": res_dev, "other_series": res_other,
           "generic_pooled": generic, "asset_matched_pooled": matched, "shipped": shipped,
           "label_counts_shipped": counts, "range_check": range_check, "range_data_end": range_de,
           "beta_summary": beta_summary, "run": {"started_utc": started, "fit_predict_seconds": round(t_fit, 1)}}
    write_json(fpath, frozen_doc, refuse_overwrite=True)
    fsha = A.sha256_file(fpath)
    with open(fpath + ".sha256", "w") as f:
        f.write(f"{fsha}  frozen-a5.json\n")
    doc["frozen_file"] = {"file": "frozen-a5.json", "sha256": fsha}
    doc["run"].update(total_seconds=round(time.time() - t_start, 1),
                      finished_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    write_json(rpath, doc, refuse_overwrite=True)
    log(f"results-dev written ({time.time() - t_start:.0f}s)")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: blind set 4 (ONCE, after the freeze, with the published commit)
# ---------------------------------------------------------------------------------------------
def method_verdict(pooled_T, comps_T):
    """D-V1."""
    deep = [repr(float(k)) for k in LADDER if k <= -0.20]
    lnf, lnb, cells = [], [], 0
    for TL in T_LABEL.values():
        for kk in deep:
            for g in ("low", "high"):
                sf = pooled_T[TL]["levels"].get(kk, {}).get("f", {}).get(g)
                sb = pooled_T[TL]["levels"].get(kk, {}).get("fbL", {}).get(g)
                if not sf or not sb or sf["n_ep"] < CHECK_NEP or sb["n_ep"] < CHECK_NEP:
                    continue
                if not (sf["R"] and sb["R"] and math.isfinite(sf["R"]) and math.isfinite(sb["R"])
                        and sf["R"] > 0 and sb["R"] > 0):
                    continue
                lnf.append(abs(math.log(sf["R"])))
                lnb.append(abs(math.log(sb["R"])))
                cells += 1
    med_f = float(np.median(lnf)) if lnf else None
    med_b = float(np.median(lnb)) if lnb else None
    part1 = med_f is not None and med_b is not None and med_b < med_f
    lows = {T_LABEL[T]: (comps_T[T_LABEL[T]].get("fbL_vs_f") or {}).get("ci95") for T in VERDICT_T}
    part2 = all(v is not None and v[0] > VERDICT_BSS_LO for v in lows.values())
    return {"deep_cells": cells, "median_abs_lnR_f": med_f, "median_abs_lnR_fbL": med_b, "deep_R_closer": bool(part1),
            "bss_fbL_vs_f_ci_by_T": lows, "bss_lower_bounds_above_-0.002": bool(part2),
            "verdict": "PASS" if (part1 and part2) else "FAIL"}


def run_blind4(datasets, out_dir, meta_inputs, commit, workers=2, log=print, verify=True, names_override=None):
    bpath = os.path.join(out_dir, "results-blind4.json")
    marker = os.path.join(out_dir, "blind4-run.started")
    if os.path.exists(bpath) or os.path.exists(marker):
        raise SystemExit("STOP: blind set 4 has already been read (results or start marker exist). It is read once.")
    fpath, dpath = os.path.join(out_dir, "frozen-a5.json"), os.path.join(out_dir, "results-dev.json")
    if not (os.path.exists(fpath) and os.path.exists(dpath)):
        raise SystemExit("STOP: frozen-a5.json and results-dev.json must exist before blind set 4 is read.")
    if not commit:
        raise SystemExit("STOP: --blind4-commit (the published blind set 4 commit) is required.")
    with open(dpath) as f:
        dev = json.load(f)
    fsha = A.sha256_file(fpath)
    if fsha != dev["frozen_file"]["sha256"]:
        raise SystemExit("STOP: frozen-a5.json sha256 mismatch")
    with open(fpath) as f:
        frozen = json.load(f)
    with open(marker, "w") as f:
        f.write(json.dumps({"started_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                            "frozen_sha256": fsha, "commit": commit}) + "\n")
    t_start = time.time()
    if verify:
        names, fmeta = blind_files(datasets, BLIND4_DIR, commit)
    else:
        names, fmeta = names_override, {n: {"path": f"{BLIND4_DIR}/{n}", "verified": False} for n in names_override}
    global _SER
    S, folds = {}, {}
    for n in names:
        st, cols = M3.load_locked_grid(os.path.join(datasets, BLIND4_DIR, n))
        key = "blind4:" + n.split("-1h.json")[0]
        ser = M3.S3(key, key.split(":", 1)[1], "binance", cols["close"], cols["low"], LADDER, st, st)
        S[key] = ser
        folds[key] = M3.quarters(M3.first_quarter_after(st, 365), (2026, 3), ser)
        fmeta[n].update(first_kline=A.iso(st), folds=[f["name"] for f in folds[key]])
    keys = sorted(k for k in S if folds[k])
    _SER = dict(S)
    _SER.update({"__folds__": folds, "__out__": out_dir, "__prefix__": ""})
    outs = run_pool([("ser", k) for k in keys], workers, log, t_start)
    reds = {k: outs[("ser", k)]["reduced"] for k in keys}
    betas = [b for k in keys for b in outs[("ser", k)]["betas"]]
    del outs
    rng = np.random.default_rng(SEED_BLIND4)
    per_pair = {}
    for k in keys:
        per_pair[k] = {"per_T": {}}
        for T_h in HORIZONS_H:
            x = reds[k][T_h]
            entry = {"counts": x["counts"], "levels": to_cells_R(x["cells"])}
            if len(x["days"]) >= A.block_length(T_h):
                _, cnt = M3.draws(rng, len(x["days"]), T_h)
                entry["comparisons"], entry["comparisons_by_regime"] = series_comparisons(x, cnt)
            per_pair[k]["per_T"][T_LABEL[T_h]] = entry
    pooled = {}
    for T_h in HORIZONS_H:
        pr = pooled_reduced(reds, keys, T_h)
        _, cnt = M3.draws(rng, len(pr["days"]), T_h)
        cmp_, byreg = series_comparisons(pr, cnt)
        pooled[T_LABEL[T_h]] = {"comparisons": cmp_, "comparisons_by_regime": byreg,
                                "levels": to_cells_R(pr["cells"]), "n_days": int(len(pr["days"]))}
    verdict = method_verdict(pooled, {TL: pooled[TL]["comparisons"] for TL in pooled})
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
                        chk["blind set 4"] = M4.check_state(st)
                        n = sum(v != "n/a" for v in chk.values())
                        k_ = sum(v == "held" for v in chk.values())
                        bstr = f"held in {k_} of {n} checks"
                        final.setdefault(a, {}).setdefault(TL, {}).setdefault(r, {}).setdefault(kk, {})[g] = {
                            "label": x["after"], "basis": bstr, "basis_checks": chk,
                            "blind4": {"R": st["R"], "n_ep": st["n_ep"]} if st else None}
                        rows.append({"asset": a, "T": TL, "k": float(kk), "rung": r, "regime": g,
                                     "shipped": frozen["shipped"][a][TL] == r, "label": x["after"], "basis": bstr,
                                     "blind4_R": st["R"] if st else None, "blind4_n_ep": st["n_ep"] if st else None})
    A.write_csv(os.path.join(out_dir, "basis-final.csv"),
                ["asset", "T", "k", "rung", "regime", "shipped", "label", "basis", "blind4_R", "blind4_n_ep"], rows)
    A.write_csv(os.path.join(out_dir, "beta-table-blind4.csv"), ["series", "T", "fold", "band", "beta", "n_eval"] +
                [f"brier_b{x}" for x in BETAS], betas)
    doc = {"test": "Q26 workstream A5 -- blind set 4 (A5.6, read once)", "prereg": PREREG, "code": code_meta(),
           "inputs": meta_inputs, "DECISIONS": DECISIONS, "deviations_run": [], "blind4_commit": commit,
           "blind4_files": fmeta, "frozen_file": {"file": "frozen-a5.json", "sha256": fsha},
           "results_dev_sha256": A.sha256_file(dpath), "seed": SEED_BLIND4, "per_pair": per_pair, "pooled": pooled,
           "method_verdict": verdict, "final_basis": final,
           "run": {"total_seconds": round(time.time() - t_start, 1),
                   "finished_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}}
    write_json(bpath, doc, refuse_overwrite=True)
    log(f"results-blind4 written ({time.time() - t_start:.0f}s); verdict {verdict['verdict']}")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: panel (preview before blind set 4; final after)
# ---------------------------------------------------------------------------------------------
def live_features(D, asof_ts, rounds_all):
    feats, ext_series = {}, {}
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
        feats[a] = {"sigma": float(sx.sigma[sx.N]), "sigma_ref": float(sx.sigma_ref[sx.N]), "regime": g_now,
                    "i_now": sx.N, "rv_pct": float(sx.rv_pct[sx.N]) if np.isfinite(sx.rv_pct[sx.N]) else None,
                    "live_hours": int(len(ext))}
        ext_series[a] = sx
    return feats, ext_series


def run_panel(datasets, out_dir, meta, final=False, try_rpc=True, log=print):
    path = os.path.join(out_dir, "panel.json" if final else "panel-preview.json")
    if os.path.exists(path):
        raise SystemExit(f"STOP: {path} exists.")
    with open(os.path.join(out_dir, "results-dev.json")) as f:
        dev = json.load(f)
    fpath = os.path.join(out_dir, "frozen-a5.json")
    if A.sha256_file(fpath) != dev["frozen_file"]["sha256"]:
        raise SystemExit("STOP: frozen-a5.json sha256 mismatch")
    with open(fpath) as f:
        frozen = json.load(f)
    fin = None
    if final:
        with open(os.path.join(out_dir, "results-blind4.json")) as f:
            fin = json.load(f)["final_basis"]
    shipped = frozen["shipped"]
    D = M3.build_dev(datasets)
    panel = {"phase": "panel" if final else "panel-preview", "prereg": PREREG, "code": code_meta(), "inputs": meta,
             "frozen_sha256": dev["frozen_file"]["sha256"], "basis_includes_blind4": bool(final),
             "range_wording": "estimate range lo-hi: how much this estimate moves when past data is resampled; not a "
                              "range of outcomes (A4 D1)", "assets": {}}
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
                                                "price": r_asof["answer"] / 10 ** dec}}
            asof_info = {"data_end": A.iso(DATA_END), "source": "chainlink getRoundData via public RPC",
                         "asof": A.iso(asof_ts), "rpc_calls": rpc.calls, "rpc_errors": rpc.errors,
                         "read_at_utc": A.iso(now)}
        except Exception as e:
            asof_info["rpc_failed"] = f"{type(e).__name__}: {e}"
            live, rounds_all = {}, {}
    panel["asof"] = asof_info
    panel["live_chainlink"] = live
    asof_ts = A.utc(asof_info["asof"])
    feat, ext_series = live_features(D, asof_ts, rounds_all)
    grids, ranges = {}, {}

    def consume(a, T_h, f, cnt, state):
        if f["name"] != "DATA_END":
            return state
        ser = D[f"long:{a}"]
        ship = shipped[a][T_LABEL[T_h]]
        fe = feat[a]
        te = np.array([ser.N])
        P5 = Prep5(ser, T_h)
        o = predict5(ser, P5, T_h, ser.N, te, te_sigma=[fe["sigma"]], te_sigma_ref=[fe["sigma_ref"]])
        sx = ext_series[a]
        lv = np.asarray(ser.levels, float)
        for name, nd in M2.REF_DAYS.items():
            sg = A.ref_daily_sigma(sx.close, np.array([fe["i_now"]]), nd)
            o["raw"][name] = A.touch_prob(lv[None, :], sg[:, None], A.T_DAYS[T_h])
        Po = M3.Prep3(D[f"oracle:{a}"], T_h, beta_select=False)
        o["raw"]["a"] = Po.freq_upto(ser.N - T_h)[None, :]
        smp, _ = range_for(D, a, T_h, f, cnt, {"P5": P5, "Po": Po}, ship, te, te_sigma=[fe["sigma"]],
                           te_sigma_ref=[fe["sigma_ref"]])
        lo, hi = np.percentile(smp, BAND_PCT, axis=0)
        ti = HORIZONS_H.index(T_h)
        for r in RUNGS:
            grids.setdefault(a, {}).setdefault(r, np.full((len(HORIZONS_H), len(ser.levels)), np.nan))[ti] = \
                o["raw"][r][0]
        ranges.setdefault(a, {"lo": np.full((len(HORIZONS_H), len(ser.levels)), np.nan),
                              "hi": np.full((len(HORIZONS_H), len(ser.levels)), np.nan),
                              "betas": {}})
        ranges[a]["lo"][ti], ranges[a]["hi"][ti] = lo[0], hi[0]
        ranges[a]["betas"][T_LABEL[T_h]] = {int(bb): v[0] for bb, v in o["betas"].items()}
        _clear(D[f"oracle:{a}"])
        return state

    M4.replay_band_draws(D, shipped, consume=consume)
    shown = {}
    for a in DEV_ASSETS:
        ser = D[f"long:{a}"]
        fixed = {r: A.monotone_fix(g[None])[0] for r, g in grids[a].items() if not np.isnan(g).any()}
        lo_g, hi_g = A.monotone_fix(ranges[a]["lo"][None])[0], A.monotone_fix(ranges[a]["hi"][None])[0]
        g_now = feat[a]["regime"]
        gname = REGIMES[g_now] if g_now >= 0 else None
        pgrid = np.array([fixed[shipped[a][T_LABEL[T]]][ti] for ti, T in enumerate(HORIZONS_H)])
        lo_g, hi_g = np.minimum(lo_g, pgrid), np.maximum(hi_g, pgrid)
        shown[a] = (pgrid, lo_g, hi_g, gname)
        cells = {}
        for ti, T_h in enumerate(HORIZONS_H):
            TL = T_LABEL[T_h]
            ship = shipped[a][TL]
            row = {"rung": ship, "regime_now": gname, "period": dev["per_asset"][a][TL]["counts"]["period"],
                   "betas_by_band": ranges[a]["betas"][TL] if ship == "fbL" else None, "levels": {}}
            for j, k in enumerate(ser.levels):
                kk = repr(float(k))
                e = frozen["labels"][a][TL][ship][kk].get(gname) if gname else None
                lab = e["after"] if e else "no regime"
                bstr = (fin[a][TL][ship][kk][gname]["basis"] if fin and gname else (e["basis"] if e else None))
                p, lo, hi = float(pgrid[ti, j]), float(lo_g[ti, j]), float(hi_g[ti, j])
                row["levels"][kk] = {"p": p, "lo": lo, "hi": hi, "regime": gname, "label": lab, "basis": bstr,
                                     "n_ep": e.get("n_ep") if e else None,
                                     "outcome": e.get("outcome") if e else None,
                                     "display": f"{A.fmt_p(p, dagger=False)}, estimate range {A.fmt_p(lo, dagger=False)}"
                                                f"–{A.fmt_p(hi, dagger=False)} · {lab} ({bstr}) · {gname} vol"}
            cells[TL] = row
        panel["assets"][a] = {"cells": cells, "regime_now": gname, "rv_pct_now": feat[a]["rv_pct"],
                              "sigma_hat_now": feat[a]["sigma"], "sigma_ref_now": feat[a]["sigma_ref"],
                              "live_hours_spliced": feat[a]["live_hours"],
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
                        f"(estimate range {A.fmt_p(pl, dagger=False)}–{A.fmt_p(ph, dagger=False)}) [{r['label']}]"
                        if r.get("repay") else f"{r['text']} [{r['label']}]")
    panel["action_example"] = {"label": "EXAMPLE position (not a real position; no number goes into app code)",
                               "position": {"collateral": f"{C:g} ETH", "LT": LT, "spot_S": Sx, "debt_D_usd": Dd,
                                            "distance_y": y_now}, "regime_now": gname, "rows": rows,
                               "display": [r["display"] for r in rows]}
    write_json(path, panel, refuse_overwrite=True)
    return panel


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phase", choices=("dryrun", "dev", "preview", "blind4", "panel", "manifest"), required=True)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--no-rpc", action="store_true")
    ap.add_argument("--blind4-commit", help="blind4: the published membrane-datasets commit holding blind4-prices/")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    if a.phase == "manifest":
        M3.run_manifest(a.out)
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
    elif a.phase == "blind4":
        run_blind4(a.datasets, a.out, meta, a.blind4_commit, workers=a.workers, log=log)
    elif a.phase == "panel":
        run_panel(a.datasets, a.out, meta, final=True, try_rpc=not a.no_rpc, log=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
