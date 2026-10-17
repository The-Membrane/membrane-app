#!/usr/bin/env python3
"""Q26 workstream A8 (R8.3) -- deep-only calm fix (fHD) for ETH/USD, and blind set 7.

Implements triccs/membrane-board `design/Q26_ROUND8_PREREG.md` section R8.3 (registered at commit 91a3eba, file sha256
70113555236390a8ccc570dc14a3f7cc54aa12064b50f8f69be39cefa4b3ff64). Parents: R7.4 / A7 (D2, D4) and A6 (D1-D3); every
definition not changed by R8.3 holds. The A..A7 code is imported and never modified.

Rung (fHD): p = max(p_fH, 0.75 * p_a) ONLY for deep levels (-20% and deeper) at origins in the low-volatility regime;
otherwise p = p_fH. p_a = plain unscaled history (rung a). No parameter is fitted. The monotone fix follows.
Candidates: (a), (f), (fH), (fHF), (fHD). (a), (f), (fH) are A6's exactly and (fHF) is A7's exactly (asserted against
the frozen A6 and A7 ETH development predictions on every row, and against their scores).

Phases (run in this order into a fresh --out):
  dev       ETH development data fit, predicted and scored ONCE: deep-band |ln R| by regime, BSS of (fHD) vs (fH),
            (fHF), (f) per T with CIs, CORP MCB/DSC, DM; freeze
            -> results-dev-a8.json, frozen-a8.json (+ .sha256), predictions-dev-a8-ETH.csv.gz
  blind7    blind set 7 read ONCE, only with --blind7-commit and --frozen-sha256 equal to frozen-a8.json's sha256 and
            a8_touch.py unchanged since the freeze (or --code-change-note); writes a start marker and refuses a second
            run -> results-blind7.json, pairs-blind7.csv
  manifest  sha256 of every output -> manifest.json
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):   # one thread per worker
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import json  # noqa: E402
import multiprocessing as mp  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import warnings  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as M6  # noqa: E402
import a7_touch as M7  # noqa: E402

PREREG = {
    "repo": "triccs/membrane-board",
    "path": "design/Q26_ROUND8_PREREG.md",
    "section": "R8.3",
    "commit": "91a3eba",
    "sha256": "70113555236390a8ccc570dc14a3f7cc54aa12064b50f8f69be39cefa4b3ff64",
    "parents": {"A7": M7.PREREG, "R7_D2_D4": "membrane-board design/Q26_ROUND7_PREREG.md deviations D2, D4"},
}

STEP, DAY = 3600, 86400
HORIZONS_H = M6.HORIZONS_H
T_LABEL = M6.T_LABEL
REGIMES = M6.REGIMES
LADDER = M6.LADDER
DEEP = M6.DEEP                                             # ladder levels <= -0.20 (-20% .. -40%)
DEEP_CUT = -0.20
LOW = REGIMES.index("low")                                 # regime code 0
ASSET = "ETH"
FLOOR = M7.FLOOR                                           # 0.75, as R7.4
CANDIDATES = ("a", "f", "fH", "fHF", "fHD")
COMPARISONS = (("fHD_vs_fH", "fHD", "fH"), ("fHD_vs_fHF", "fHD", "fHF"), ("fHD_vs_f", "fHD", "f"),
               ("fHD_vs_a", "fHD", "a"), ("fHF_vs_fH", "fHF", "fH"), ("fHF_vs_f", "fHF", "f"),
               ("fH_vs_f", "fH", "f"), ("fHF_vs_a", "fHF", "a"), ("fH_vs_a", "fH", "a"), ("f_vs_a", "f", "a"))
DM_COMPARISONS = ("fHD_vs_fH", "fHD_vs_fHF", "fHD_vs_f", "fH_vs_f")
A7_COMPARISONS = ("fHF_vs_fH", "fHF_vs_f", "fH_vs_f", "fHF_vs_a", "fH_vs_a", "f_vs_a")
SEED_DEV = M7.SEED_DEV                                     # 20261070: A6/A7 dev stream -> their ETH CIs reproduce
SEED_BLIND7 = 20261072                                     # next in the A-series blind streams (A7 used 20261071)
VERDICT_T = M6.VERDICT_T                                   # 6h, 1d, 3d, 7d
VERDICT_BSS_LO = M6.VERDICT_BSS_LO                         # -0.002
CHECK_NEP = M6.CHECK_NEP                                   # 10
BLIND7_DIR = "blind7-prices"
A7_RUN = "history-forecasts/a7/run-4deeb0e4"
A7_FROZEN_SHA = "ff62ab657d042b1fdd4e21d279035b6bcbfc414a3ac21ffb534e6e2980f865ae"

DECISIONS = [
    "D8-1 rung placement: on the raw (pre-fix) grids, p_fHD = raw p_fH everywhere except the cells (origin in the low "
    "regime, level <= -20%), where p_fHD = max(raw p_fH, 0.75 x raw p_a) (np.fmax, as A7 D7-1); then the monotone "
    "fix (A.monotone_fix over level then T), as every A-series map acts on raw forecasts before the fix. The regime is "
    "the A3.3 regime of the origin (ser.regime[t0]: trailing RV30 percentile over the prior 730 d, computed from closes "
    "before t0 only); an origin with an undefined regime is not low, so it keeps p_fH. 'Deep' = the A6 DEEP set "
    "(ladder levels <= -0.20), the same cells as the verdict. Because the fix is a running minimum over deeper levels "
    "then a running maximum over longer T, (fHD) equals (fH) exactly on every cell outside (low, deep) after the fix "
    "(asserted on every scored row); inside, a raised deep value is capped by the -15% value of the same row and T. "
    "Reported: the share of low-regime deep rows where the floor binds after the fix, and the largest difference from "
    "the alternative placement (floor applied to the fixed grids, same cells).",
    "D8-2 (a), (f), (fH), (fHF) come from A7's predictor (a7_touch.predict7, A6's Prep6/HAR/FHS code). The dev phase "
    "asserts every ETH development row (t0, fold, T, k, y, regime, p_a, p_f, p_fH) equals the frozen A6 predictions "
    "(A7's check, frozen-a6.json sha256 97501da3...) and (t0, fold, T, k, y, regime, p_a, p_f, p_fH, p_fHF) equals "
    "the frozen A7 predictions-dev-a7-ETH.csv.gz (membrane-datasets history-forecasts/a7/run-4deeb0e4, frozen-a7.json "
    "sha256 ff62ab65...) as printed text; and that A6's fH_vs_f / f_vs_a / fH_vs_a BSS+CI and fH/f/a level R, and A7's "
    "six comparisons' BSS+CI and fHF level R, reproduce exactly.",
    "D8-3 draws: dev default_rng(20261070) (the A6.3/A7 stream; one draw set per T, shared by every comparison, so "
    "the A6/A7 CIs reproduce); blind set 7 default_rng(20261072) (R8.3 names no seed; the next A-series blind stream "
    "after A7's 20261071): pairs in file-name order > T (no BSS for a pair with fewer days than the block length), "
    "then the pooled union day set > T.",
    "D8-4 verdict (R8.3): deep cells (-20..-40%) x every T in the LOW regime, pooled over all blind-7 pairs (R = sum y "
    "/ sum p per cell), kept when (fH) and (fHD) both have n_ep >= 10 and a finite positive R; PASS iff (fHD)'s "
    "median |ln R| < (fH)'s AND the pooled BSS(fHD vs fH) CI lower bound > -0.002 at 6h, 1d, 3d and 7d (each). "
    "Reported beside it, deciding nothing: the same medians in mid, high and low+high, all five rungs on their common "
    "cells, (fHD) vs (fHF), and the BSS of (fHD) vs (fH) on low-regime rows only.",
    "D8-5 blind set 7: files verified against the git blobs of --blind7-commit; folds from the first quarter >= 365 d "
    "after the first kline to 2026Q3 (A6.6); A3.1 null-hour rule; A6's Parkinson/HAR features on the kline high and "
    "low. The blind gate also refuses when a8_touch.py's sha256 differs from the one recorded in frozen-a8.json "
    "unless --code-change-note gives a reason, which is written to the marker and the results (A7 review log item: "
    "the A7 gate checked the frozen sha256 but not the code). No label or display is changed by this run; display "
    "follows the A6 D3 best-model rule only if (fHD) passes (a later step).",
    "D8-6 the dev phase reports, deciding nothing: BSS with day-block CIs per T (pooled and per regime), level R per "
    "(T, level, regime) for each rung with A2.5 v3 dev labels, CORP (MCB/DSC/UNC) per T over all levels, per A4 band "
    "and per regime, DM+HLN (A6 D-DM1 lags), deep-band median |ln R| per regime.",
]


# ---------------------------------------------------------------------------------------------
# The rung
# ---------------------------------------------------------------------------------------------
def deep_mask(levels):
    """Boolean per level: -20% and deeper (the A6 DEEP set on the ladder)."""
    return np.array([float(k) <= DEEP_CUT for k in levels], bool)


def floor_fHD(p_fH, p_a, low_rows, deep_cols, floor=FLOOR):
    """R8.3: p_fH, except max(p_fH, floor * p_a) on (low_rows x deep_cols). Inputs (n, K) [or (n, T, K)]."""
    p_fH = np.asarray(p_fH, float)
    out = p_fH.copy()
    cell = np.asarray(low_rows, bool)[:, None] & np.asarray(deep_cols, bool)[None, :]
    if out.ndim == 3:
        cell = cell[:, None, :]
    fl = np.fmax(p_fH, floor * np.asarray(p_a, float))
    return np.where(cell, fl, out)


def predict8(ser, P6, T_h, qs_i, te, P_a=None):
    """Raw (a), (f), (fH), (fHF) of one fold from A7's predictor, plus (fHD)."""
    o = M7.predict7(ser, P6, T_h, qs_i, te, P_a=P_a)
    raw = o["raw"]
    low = ser.regime[te] == LOW
    raw["fHD"] = floor_fHD(raw["fH"], raw["a"], low, deep_mask(ser.levels))
    o["fit"]["fHD_raw_binding"] = int(np.sum(raw["fHD"] > raw["fH"]))
    o["fit"]["low_rows"] = int(low.sum())
    return o


def fold_loop8(ser, P6, T_h, folds, P_a=None):
    imask = ser.issue_mask()
    res = []
    for f in folds:
        te = M3.test_times(f, ser, imask)
        o = predict8(ser, P6, T_h, f["qs_i"], te, P_a=P_a)
        o.update(fold=f["name"], te=te)
        res.append(o)
    return res


def assemble8(ser, folds, per_T, y_check=None):
    """Grids (n, T, K) per rung -> monotone fix per rung -> scored rows (A7 assemble7 layout + fHD)."""
    K, nT = len(ser.levels), len(HORIZONS_H)
    first = per_T[HORIZONS_H[0]]
    te_all = np.concatenate([o["te"] for o in first]) if first else np.array([], int)
    fold_of = np.concatenate([[fi] * len(o["te"]) for fi, o in enumerate(first)]).astype(int) if first else \
        np.array([], int)
    n = len(te_all)
    G = {r: np.full((n, nT, K), np.nan) for r in CANDIDATES}
    har_rows = []
    for ti, T_h in enumerate(HORIZONS_H):
        off = 0
        for o in per_T[T_h]:
            mm = len(o["te"])
            assert np.array_equal(te_all[off:off + mm], o["te"])
            for r in CANDIDATES:
                G[r][off:off + mm, ti, :] = o["raw"][r]
            off += mm
            c = o["fit"]["har"] or [None] * 4
            har_rows.append({"series": ser.name, "T": T_LABEL[T_h], "fold": o["fold"], "c0": c[0], "c_day": c[1],
                             "c_week": c[2], "c_month": c[3], "n_reg": o["fit"]["har_info"]["n_reg"],
                             "rule": o["fit"]["har_info"]["rule"], "fH_fallback_rows": o["fit"]["fH_fallback_rows"],
                             "floor_raw_binding_cells": o["fit"]["floor_raw_binding"],
                             "fHD_raw_binding_cells": o["fit"]["fHD_raw_binding"], "low_rows": o["fit"]["low_rows"]})
        assert off == n
    F = {}
    for r in CANDIDATES:
        assert not np.isnan(G[r]).any(), f"{ser.name} {r} grid has gaps"
        F[r] = A.monotone_fix(G[r]) if n else G[r]
    low_all = ser.regime[te_all] == LOW if n else np.array([], bool)
    dm_cols = deep_mask(ser.levels)
    if n:   # D8-1: outside (low, deep), fHD == fH exactly after the fix
        outside = ~(low_all[:, None, None] & dm_cols[None, None, :])
        outside = np.broadcast_to(outside, F["fH"].shape)
        assert np.array_equal(F["fHD"][outside], F["fH"][outside]), f"{ser.name} fHD differs from fH outside low-deep"
    alt = floor_fHD(F["fH"], F["a"], low_all, dm_cols) if n else F["fH"]     # D8-1 alternative placement (reported)
    rows = {k: [] for k in ("t0_i", "fold_i", "T_h", "k_i", "k", "y", "regime", "alt")}
    rows.update({f"p_{r}": [] for r in CANDIDATES})
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
            rows["alt"].append(alt[idx, ti, j])
            for r in CANDIDATES:
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
    M6._clear(ser)
    if y_check is not None:
        M6._clear(y_check)
    return R, har_rows


def floor_stats(R):
    """Share of scored rows where fHD (and fHF) bind after the fix, per T: all rows, low-regime rows, low-regime deep
    rows; max |alt - fHD| (D8-1)."""
    out = {}
    dm = deep_mask(R["levels"])
    for T_h in HORIZONS_H:
        m = R["T_h"] == T_h
        bD = R["p_fHD"][m] > R["p_fH"][m]
        bF = R["p_fHF"][m] > R["p_fH"][m]
        low = R["regime"][m] == LOW
        deep = dm[R["k_i"][m]] if m.any() else np.array([], bool)
        sh = lambda b, mm: float(b[mm].mean()) if mm.any() else None  # noqa: E731
        out[T_LABEL[T_h]] = {
            "n_rows": int(m.sum()), "n_low_deep_rows": int((low & deep).sum()),
            "fHD_binding_share_all": sh(bD, np.ones_like(bD)), "fHD_binding_share_low_deep": sh(bD, low & deep),
            "fHF_binding_share_all": sh(bF, np.ones_like(bF)), "fHF_binding_share_low": sh(bF, low),
            "max_abs_diff_alt_placement": float(np.max(np.abs(R["alt"][m] - R["p_fHD"][m]))) if m.any() else None}
    return out


# ---------------------------------------------------------------------------------------------
# Reduction (blind pairs) and pooling (A7 layout over this module's rungs)
# ---------------------------------------------------------------------------------------------
def reduce8(R):
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
        ts = R["base_ts"] + STEP * sel["t0_i"]
        tsu = np.unique(ts)
        tpos = np.searchsorted(tsu, ts)
        dm = {}
        for cname in DM_COMPARISONS:
            rm, rb = cname.split("_vs_")
            pm, pb = sel[f"p_{rm}"], sel[f"p_{rb}"]
            dm[cname] = (np.bincount(tpos, weights=(pm - y) ** 2 - (pb - y) ** 2, minlength=len(tsu)),
                         np.bincount(tpos, minlength=len(tsu)).astype(float))
        cells = {}
        for j, k in enumerate(R["levels"]):
            mk = sel["k_i"] == j
            lv = {}
            for r in CANDIDATES:
                p = sel[f"p_{r}"]
                d = {}
                for gname, gval in (("pooled", None),) + tuple((g, gi) for gi, g in enumerate(REGIMES)):
                    mm = mk if gval is None else mk & (sel["regime"] == gval)
                    d[gname] = {"sum_p": float(p[mm].sum()), "sum_y": float(y[mm].sum()), "n_rows": int(mm.sum()),
                                "n_ep": M2.count_touch_episodes(sel["t0_i"][mm], y[mm])}
                lv[r] = d
            cells[repr(float(k))] = lv
        out[T_h] = {"days": days, "comp": comp, "cells": cells, "dm_ts": tsu, "dm": dm,
                    "rows": {r: (sel[f"p_{r}"].astype(np.float64), y.astype(np.uint8), sel["k_i"].astype(np.int8),
                                 sel["regime"].astype(np.int8)) for r in CANDIDATES},
                    "counts": M3.counts_of(R, m, T_h)}
    return out


def pooled8(reds, keys, T_h):
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
    return {"days": days, "comp": comp, "cells": cells, "dm_ts": tsu, "dm": dm}


def deep_tables(levels_T):
    """Deep-band median |ln R| per regime: (fH, fHD) on their common cells (the verdict's cell set), (fHF, fHD), and
    all five rungs on theirs."""
    return {"fH_fHD": M6.deep_median_table(levels_T, rungs=("fH", "fHD")),
            "fHF_fHD": M6.deep_median_table(levels_T, rungs=("fHF", "fHD")),
            "all_rungs": M6.deep_median_table(levels_T, rungs=CANDIDATES)}


def verdict8(pooled_T):
    """D8-4: R8.3 verdict for (fHD)."""
    dt = M6.deep_median_table({TL: pooled_T[TL]["levels"] for TL in pooled_T}, rungs=("fH", "fHD"))
    low = dt["low"]
    mH, mD = low["median_abs_lnR"]["fH"], low["median_abs_lnR"]["fHD"]
    part1 = mH is not None and mD is not None and mD < mH
    lows = {T_LABEL[T]: (pooled_T[T_LABEL[T]]["comparisons"].get("fHD_vs_fH") or {}).get("ci95") for T in VERDICT_T}
    part2 = all(v is not None and v[0] > VERDICT_BSS_LO for v in lows.values())
    low_only = {T_LABEL[T]: M7._bci(((pooled_T[T_LABEL[T]].get("comparisons_by_regime") or {}).get("low") or {})
                                    .get("fHD_vs_fH")) for T in VERDICT_T}
    return {"rung": "fHD", "low_deep_cells": low["cells"], "median_abs_lnR_fH_low": mH, "median_abs_lnR_fHD_low": mD,
            "deep_R_closer_low": bool(part1), "bss_fHD_vs_fH_ci_by_T": lows,
            "bss_lower_bounds_above_-0.002": bool(part2), "verdict": "PASS" if (part1 and part2) else "FAIL",
            "reported_bss_fHD_vs_fH_low_regime_rows": low_only,
            "other_regimes_reported": {g: dt[g] for g in ("mid", "high", "low+high")}}


def pooled_block(reds, keys, rng):
    pooled = {}
    for T_h in HORIZONS_H:
        pr = pooled8(reds, keys, T_h)
        _, cnt = M3.draws(rng, len(pr["days"]), T_h)
        cmp_, byreg = M6.series_comparisons(pr, cnt)
        cp = {}
        for r in CANDIDATES:
            p = np.concatenate([reds[k][T_h]["rows"][r][0] for k in keys])
            y = np.concatenate([reds[k][T_h]["rows"][r][1] for k in keys]).astype(float)
            kb = M6.band_of("ladder", LADDER)[np.concatenate([reds[k][T_h]["rows"][r][2] for k in keys])]
            g = np.concatenate([reds[k][T_h]["rows"][r][3] for k in keys])
            cp[r] = M7.corp_block(p, y, kb, g)
        pooled[T_LABEL[T_h]] = {"comparisons": cmp_, "comparisons_by_regime": byreg,
                                "levels": M6.to_cells_R(pr["cells"]), "n_days": int(len(pr["days"])),
                                "n_pairs": len(keys),
                                "dm": {c: M6.dm_from_series(*pr["dm"][c], T_h) for c in DM_COMPARISONS}, "corp": cp}
    return pooled


# ---------------------------------------------------------------------------------------------
# Workers
# ---------------------------------------------------------------------------------------------
_SER = {}


def dev_task(T_h):
    ls, os_ = _SER[f"long:{ASSET}"], _SER[f"oracle:{ASSET}"]
    P6 = M6.Prep6(ls, T_h, with_fbL=False)
    Pa = P6.P if os_ is ls else M3.Prep3(os_, T_h, beta_select=False)
    res = fold_loop8(ls, P6, T_h, M3.dev_folds(ls), P_a=Pa)
    M6._clear(ls)
    M6._clear(os_)
    return res


def series_task(key):
    ser = _SER[key]
    folds = _SER["__folds__"][key]
    per_T = {}
    for T_h in HORIZONS_H:
        P6 = M6.Prep6(ser, T_h, with_fbL=False)
        per_T[T_h] = fold_loop8(ser, P6, T_h, folds)
        del P6
    R, har_rows = assemble8(ser, folds, per_T)
    return {"reduced": reduce8(R), "har": har_rows, "floor": floor_stats(R), "folds": R["fold_names"]}


def _dispatch(t):
    if t[0] == "dev":
        return t, dev_task(t[1])
    return t, series_task(t[1])


def run_pool(tasks, workers, log, t0):
    outs = {}
    if workers > 1:
        with mp.get_context("fork").Pool(workers, maxtasksperchild=3) as pool:
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
# Metadata, IO
# ---------------------------------------------------------------------------------------------
CODE_FILES = ("a8_touch.py", "test_a8_touch.py", "a8_fetch_blind7.py", "a7_touch.py", "a6_touch.py", "a5_touch.py",
              "a4_touch.py", "a3_touch.py", "a2_touch.py", "a_touch.py")


def code_meta():
    here = os.path.abspath(__file__)
    d = os.path.dirname(here)
    run = lambda *a: subprocess.run(["git", "-C", d, *a], capture_output=True, text=True).stdout.strip()  # noqa: E731
    return {"path": "scripts/research/history-forecasts/a8_touch.py", "sha256": A.sha256_file(here),
            "deps_sha256": {f: A.sha256_file(os.path.join(d, f)) for f in CODE_FILES[1:]
                            if os.path.exists(os.path.join(d, f))},
            "git": {"head_commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
                    "a8_touch_last_commit": run("log", "-1", "--format=%H", "--", "a8_touch.py"),
                    "dirty_code_files": run("status", "--porcelain", "--", *CODE_FILES).splitlines()}}


def require_clean_code():
    cm = code_meta()
    if cm["git"]["dirty_code_files"]:
        raise SystemExit(f"STOP: code files are dirty: {cm['git']['dirty_code_files']}. Commit before a scored run.")
    return cm


def write_rows(path, R, name):
    header = ["series", "t0", "fold", "T", "k", "y", "regime"] + [f"p_{r}" for r in CANDIDATES]

    def gen():
        fn, b = R["fold_names"], R["base_ts"]
        for i in np.lexsort((R["k_i"], R["T_h"], R["t0_i"])):
            g = int(R["regime"][i])
            yield [name, A.iso(b + STEP * int(R["t0_i"][i])), fn[int(R["fold_i"][i])], T_LABEL[int(R["T_h"][i])],
                   repr(float(R["k"][i])), int(R["y"][i]), REGIMES[g] if g >= 0 else ""] + \
                [A._f(R[f"p_{r}"][i]) for r in CANDIDATES]
    A.write_csv_gz(path, header, gen())


def check_against_a7(datasets, R):
    """D8-2: every ETH dev row equals the frozen A7 predictions (printed text) incl. p_fHF."""
    run = os.path.join(datasets, A7_RUN)
    fsha = A.sha256_file(os.path.join(run, "frozen-a7.json"))
    if fsha != A7_FROZEN_SHA:
        raise SystemExit("STOP: the A7 frozen file in the datasets checkout is not the D2 freeze")
    fn, b = R["fold_names"], R["base_ts"]
    order = np.lexsort((R["k_i"], R["T_h"], R["t0_i"]))
    cols = ("series", "t0", "fold", "T", "k", "y", "regime", "p_a", "p_f", "p_fH", "p_fHF")
    n, bad = 0, []
    with gzip.open(os.path.join(run, "predictions-dev-a7-ETH.csv.gz"), "rt", newline="") as fh:
        rd = csv.reader(fh)
        h = next(rd)
        col = {c: h.index(c) for c in cols}
        for i, row in zip(order, rd):
            g = int(R["regime"][i])
            mine = {"series": ASSET, "t0": A.iso(b + STEP * int(R["t0_i"][i])), "fold": fn[int(R["fold_i"][i])],
                    "T": T_LABEL[int(R["T_h"][i])], "k": repr(float(R["k"][i])), "y": str(int(R["y"][i])),
                    "regime": REGIMES[g] if g >= 0 else ""}
            mine.update({f"p_{r}": A._f(R[f"p_{r}"][i]) for r in ("a", "f", "fH", "fHF")})
            for c, j in col.items():
                if row[j] != mine[c] and len(bad) < 10:
                    bad.append({"row": n, "col": c, "a7": row[j], "a8": mine[c]})
            n += 1
        extra = sum(1 for _ in rd)
    if bad or n != len(order) or extra:
        raise SystemExit(f"STOP: A8 (a)/(f)/(fH)/(fHF) do not reproduce A7 ETH dev predictions: rows {n} vs "
                         f"{len(order)}, extra {extra}, first mismatches {bad}")
    return {"rows_compared": n, "columns": list(cols), "identical": True, "a7_frozen_sha256": fsha,
            "a7_predictions_sha256": A.sha256_file(os.path.join(run, "predictions-dev-a7-ETH.csv.gz"))}


def check_a7_scores(datasets, res):
    """D8-2: A7's six comparisons (BSS + CI, pooled and by regime) and the fHF level R / n_ep / label reproduce."""
    with open(os.path.join(datasets, A7_RUN, "results-dev-a7.json")) as f:
        a7 = json.load(f)["per_T"]
    bad = []
    res = A._clean(res)
    for TL, e in res.items():
        for c in A7_COMPARISONS:
            for x, y in ((e["comparisons"][c], a7[TL]["comparisons"][c]),) + tuple(
                    (e["comparisons_by_regime"][g][c], a7[TL]["comparisons_by_regime"][g][c]) for g in REGIMES):
                if x["bss"] != y["bss"] or list(x["ci95"] or []) != list(y["ci95"] or []):
                    bad.append((TL, c, x["bss"], y["bss"]))
        for kk, lv in e["levels"].items():
            for r in ("a", "f", "fH", "fHF"):
                for g in ("pooled",) + REGIMES:
                    x, y = lv[r].get(g), a7[TL]["levels"][kk][r].get(g)
                    if (x is None) != (y is None) or (x and (x["R"] != y["R"] or x["n_ep"] != y["n_ep"]
                                                            or x["label"] != y["label"])):
                        bad.append((TL, kk, r, g))
    if bad:
        raise SystemExit(f"STOP: A7 ETH dev scores do not reproduce: {bad[:10]}")
    return {"comparisons_checked": list(A7_COMPARISONS), "by_regime": True,
            "level_R_n_ep_label_checked": ["a", "f", "fH", "fHF"], "identical": True}


def score_dev(R, rng):
    """D8-3/D8-6: one draw set per T from rng (T order), every comparison, level stats, CORP and DM."""
    res, boot = {}, {}
    bands = M6.band_of(ASSET, R["levels"])
    fn = R["fold_names"]
    last_folds = set(range(len(fn) - M2.STALE_FOLDS, len(fn)))
    for T_h in HORIZONS_H:
        TL = T_LABEL[T_h]
        m = R["T_h"] == T_h
        days = np.unique(R["day"][m])
        idx, cnt = M3.draws(rng, len(days), T_h)
        boot[TL] = M3._bmeta(days, idx, T_h)
        sel = M3.select(R, m)
        pos = M2.day_positions(days, sel["day"])
        nd = len(days)
        res[TL] = {"counts": M3.counts_of(R, m, T_h),
                   "brier": {r: float(np.mean((sel[f"p_{r}"] - sel["y"]) ** 2)) for r in CANDIDATES},
                   "comparisons": M3.comparisons(sel, pos, nd, cnt, list(COMPARISONS)),
                   "comparisons_by_regime": {g: M3.comparisons(sel, pos, nd, cnt, list(COMPARISONS),
                                                               mask=sel["regime"] == gi)
                                             for gi, g in enumerate(REGIMES)},
                   "levels": M3.level_stats_by_regime(sel, pos, nd, cnt, T_h, last_folds, CANDIDATES, True),
                   "corp": {r: M7.corp_block(sel[f"p_{r}"], sel["y"].astype(float), bands[sel["k_i"]],
                                             sel["regime"]) for r in CANDIDATES},
                   "dm": {c: M6.dm_rows(sel, T_h, *c.split("_vs_"), R["base_ts"]) for c in DM_COMPARISONS}}
    return res, boot


def dev_tables(R, res):
    deep = deep_tables({TL: res[TL]["levels"] for TL in res})
    preview = verdict8({TL: {"levels": res[TL]["levels"], "comparisons": res[TL]["comparisons"],
                             "comparisons_by_regime": res[TL]["comparisons_by_regime"]} for TL in res})
    fl = floor_stats(R)
    bci = M7._bci
    summary = {TL: {"bss_fHD_vs_fH": bci(res[TL]["comparisons"].get("fHD_vs_fH")),
                    "bss_fHD_vs_fHF": bci(res[TL]["comparisons"].get("fHD_vs_fHF")),
                    "bss_fHD_vs_f": bci(res[TL]["comparisons"].get("fHD_vs_f")),
                    "bss_fHF_vs_fH": bci(res[TL]["comparisons"].get("fHF_vs_fH")),
                    "bss_fH_vs_f": bci(res[TL]["comparisons"].get("fH_vs_f")),
                    "bss_fHD_vs_fH_by_regime": {g: bci(res[TL]["comparisons_by_regime"][g].get("fHD_vs_fH"))
                                                for g in REGIMES},
                    "corp_all": {r: {k: res[TL]["corp"][r]["all"][k] for k in ("brier", "MCB", "DSC", "UNC")}
                                 for r in CANDIDATES},
                    "corp_low": {r: {k: res[TL]["corp"][r]["regime_low"][k] for k in ("brier", "MCB", "DSC", "UNC")}
                                 for r in CANDIDATES if res[TL]["corp"][r]["regime_low"]},
                    "fHD_binding_share_low_deep": fl[TL]["fHD_binding_share_low_deep"],
                    "fHD_binding_share_all": fl[TL]["fHD_binding_share_all"]} for TL in res}
    return deep, preview, fl, summary


# ---------------------------------------------------------------------------------------------
# Phase: dev (ETH, once)
# ---------------------------------------------------------------------------------------------
def run_dev(datasets, out_dir, meta, workers=4, log=print, require_clean=True):
    rpath, fpath = os.path.join(out_dir, "results-dev-a8.json"), os.path.join(out_dir, "frozen-a8.json")
    for p in (rpath, fpath):
        if os.path.exists(p):
            raise SystemExit(f"STOP: {p} exists. The development run is scored once.")
    cm = require_clean_code() if require_clean else code_meta()
    started = M7.now_utc()
    t0 = time.time()
    global _SER
    D = M3.build_dev(datasets)
    M6.attach_highs_dev(datasets, D)
    _SER = {f"long:{ASSET}": D[f"long:{ASSET}"], f"oracle:{ASSET}": D[f"oracle:{ASSET}"]}
    ls, os_ = _SER[f"long:{ASSET}"], _SER[f"oracle:{ASSET}"]
    outs = run_pool([("dev", T) for T in HORIZONS_H], workers, log, t0)
    folds = M3.dev_folds(ls)
    R, har_rows = assemble8(ls, folds, {T: outs[("dev", T)] for T in HORIZONS_H},
                            y_check=None if os_ is ls else os_)
    del outs
    write_rows(os.path.join(out_dir, "predictions-dev-a8-ETH.csv.gz"), R, ASSET)
    repro6 = M7.check_against_a6(datasets, R)
    repro7 = check_against_a7(datasets, R)
    log(f"A6/A7 reproduction: {repro6['rows_compared']} / {repro7['rows_compared']} rows identical "
        f"({time.time() - t0:.0f}s)")
    res, boot = score_dev(R, np.random.default_rng(SEED_DEV))
    a6_scores = M7.check_a6_scores(datasets, res)
    a7_scores = check_a7_scores(datasets, res)
    log(f"A6/A7 score reproduction: identical ({time.time() - t0:.0f}s)")
    deep, preview, fl, summary = dev_tables(R, res)
    frozen = {"what": "Q26 A8 (R8.3) freeze before blind set 7", "prereg": PREREG,
              "code_commit": cm["git"]["head_commit"], "code_sha256": cm["sha256"], "deps_sha256": cm["deps_sha256"],
              "rung": {"name": "fHD", "formula": "monotone_fix(raw p_fH, except max(raw p_fH, 0.75 * raw p_a) on "
                                                 "(low-regime origin, level <= -20%))", "floor": FLOOR,
                       "deep_levels": [float(k) for k in DEEP], "regime": "low", "fitted_parameters": 0},
              "candidates": list(CANDIDATES), "comparisons": [c[0] for c in COMPARISONS],
              "verdict_rule": {"regime": "low", "deep_levels": [float(k) for k in DEEP], "n_ep_min": CHECK_NEP,
                               "bss_comparison": "fHD_vs_fH", "bss_T": [T_LABEL[T] for T in VERDICT_T],
                               "bss_ci_lower_above": VERDICT_BSS_LO},
              "seeds": {"dev": SEED_DEV, "blind7": SEED_BLIND7}, "blind7_dir": BLIND7_DIR,
              "dev_summary": summary, "dev_deep_band": deep, "dev_verdict_preview": preview,
              "decisions": DECISIONS, "frozen_utc": M7.now_utc()}
    A.write_json(fpath, frozen, refuse_overwrite=True)
    fsha = A.sha256_file(fpath)
    with open(fpath + ".sha256", "w") as f:
        f.write(f"{fsha}  frozen-a8.json\n")
    doc = {"test": "Q26 workstream A8 (R8.3) -- ETH development run (once)", "prereg": PREREG, "code": cm,
           "inputs": meta, "environment": M3.env_meta(workers), "DECISIONS": DECISIONS, "seed": SEED_DEV,
           "bootstrap": boot,
           "reproduction": {"a6_predictions": repro6, "a7_predictions": repro7, "a6_scores": a6_scores,
                            "a7_scores": a7_scores},
           "per_T": res, "summary": summary, "deep_band_median_abs_lnR": deep,
           "verdict_rule_on_dev_deciding_nothing": preview, "floor": fl, "har_table": har_rows,
           "frozen_file": {"file": "frozen-a8.json", "sha256": fsha},
           "run": {"started_utc": started, "finished_utc": M7.now_utc(), "total_seconds": round(time.time() - t0, 1)}}
    A.write_json(rpath, doc, refuse_overwrite=True)
    log(f"results-dev-a8 written; frozen-a8.json sha256 {fsha} ({time.time() - t0:.0f}s)")
    return doc


# ---------------------------------------------------------------------------------------------
# Phase: blind set 7 (once)
# ---------------------------------------------------------------------------------------------
def blind7_gate(out_dir, commit, frozen_sha, code_change_note=None, code_sha=None):
    """Every check before blind set 7 may be read; returns (dev, frozen, fsha, code_check). SystemExit on failure."""
    bpath = os.path.join(out_dir, "results-blind7.json")
    marker = os.path.join(out_dir, "blind7-run.started")
    if os.path.exists(bpath) or os.path.exists(marker):
        raise SystemExit("STOP: blind set 7 has already been read (results or start marker exist). It is read once.")
    fpath, dpath = os.path.join(out_dir, "frozen-a8.json"), os.path.join(out_dir, "results-dev-a8.json")
    if not (os.path.exists(fpath) and os.path.exists(dpath) and os.path.exists(fpath + ".sha256")):
        raise SystemExit("STOP: frozen-a8.json (+ .sha256) and results-dev-a8.json must exist before blind set 7 is "
                         "read.")
    if not commit:
        raise SystemExit("STOP: --blind7-commit (the published membrane-datasets commit holding blind7-prices/) is "
                         "required.")
    if not frozen_sha:
        raise SystemExit("STOP: --frozen-sha256 (the published sha256 of frozen-a8.json) is required.")
    with open(dpath) as f:
        dev = json.load(f)
    fsha = A.sha256_file(fpath)
    with open(fpath + ".sha256") as f:
        recorded = (f.read().split() or [""])[0]
    if fsha != frozen_sha or fsha != recorded or fsha != dev.get("frozen_file", {}).get("sha256"):
        raise SystemExit("STOP: frozen-a8.json sha256 does not match --frozen-sha256 and the recorded freeze")
    with open(fpath) as f:
        frozen = json.load(f)
    now_sha = code_sha if code_sha is not None else A.sha256_file(os.path.abspath(__file__))
    same = now_sha == frozen.get("code_sha256")
    if not same and not code_change_note:
        raise SystemExit("STOP: a8_touch.py differs from the frozen code (sha256 "
                         f"{now_sha} vs {frozen.get('code_sha256')}). Pass --code-change-note with the reason.")
    code_check = {"frozen_code_sha256": frozen.get("code_sha256"), "current_code_sha256": now_sha,
                  "unchanged": bool(same), "code_change_note": None if same else code_change_note}
    return dev, frozen, fsha, code_check


def run_blind7(datasets, out_dir, commit, frozen_sha, workers=4, log=print, verify=True, names_override=None,
               require_clean=True, code_change_note=None, code_sha=None):
    dev, frozen, fsha, code_check = blind7_gate(out_dir, commit, frozen_sha, code_change_note, code_sha)
    cm = require_clean_code() if require_clean else code_meta()
    marker = os.path.join(out_dir, "blind7-run.started")
    started = M7.now_utc()
    with open(marker, "w") as f:
        f.write(json.dumps({"started_utc": started, "frozen_sha256": fsha, "commit": commit,
                            "code": cm["git"]["head_commit"], "code_check": code_check}) + "\n")
    t0 = time.time()
    global _SER
    S, folds, fmeta = M6.build_blind_dir(datasets, BLIND7_DIR, commit, "blind7:", verify=verify,
                                         names_override=names_override)
    keys = sorted(k for k in S if folds[k])
    _SER = dict(S)
    _SER["__folds__"] = folds
    outs = run_pool([("ser", k) for k in keys], workers, log, t0)
    reds = {k: outs[("ser", k)]["reduced"] for k in keys}
    har = [r for k in keys for r in outs[("ser", k)]["har"]]
    floors = {k: outs[("ser", k)]["floor"] for k in keys}
    del outs
    rng = np.random.default_rng(SEED_BLIND7)
    per_pair, pair_rows = {}, []
    for k in keys:
        per_pair[k] = {"per_T": {}}
        for T_h in HORIZONS_H:
            x = reds[k][T_h]
            TL = T_LABEL[T_h]
            entry = {"counts": x["counts"], "levels": M6.to_cells_R(x["cells"]),
                     "dm": {c: M6.dm_from_series(*x["dm"][c], T_h) for c in DM_COMPARISONS},
                     "corp": {r: M6.corp(x["rows"][r][0], x["rows"][r][1].astype(float)) for r in CANDIDATES}}
            if len(x["days"]) >= A.block_length(T_h):
                _, cnt = M3.draws(rng, len(x["days"]), T_h)
                entry["comparisons"], entry["comparisons_by_regime"] = M6.series_comparisons(x, cnt)
                for c, v in entry["comparisons"].items():
                    ci = v.get("ci95")
                    pair_rows.append({"pair": k, "T": TL, "comparison": c, "n_rows": v["n_rows"], "bss": v["bss"],
                                      "ci_lo": ci[0] if ci else None, "ci_hi": ci[1] if ci else None})
            else:
                entry["skipped_bss"] = "fewer days than the block length"
            per_pair[k]["per_T"][TL] = entry
    pooled = pooled_block(reds, keys, rng)
    verdict = verdict8(pooled)
    deep = deep_tables({TL: pooled[TL]["levels"] for TL in pooled})
    pair_counts = M7.pair_ci_counts(pair_rows)
    A.write_csv(os.path.join(out_dir, "pairs-blind7.csv"),
                ["pair", "T", "comparison", "n_rows", "bss", "ci_lo", "ci_hi"], pair_rows)
    A.write_csv(os.path.join(out_dir, "har-table-blind7.csv"),
                ["series", "T", "fold", "c0", "c_day", "c_week", "c_month", "n_reg", "rule", "fH_fallback_rows",
                 "floor_raw_binding_cells", "fHD_raw_binding_cells", "low_rows"], har)
    doc = {"test": "Q26 workstream A8 (R8.3) -- blind set 7 (read once)", "prereg": PREREG, "code": cm,
           "code_check": code_check, "DECISIONS": DECISIONS, "blind7_commit": commit, "blind7_files": fmeta,
           "frozen_file": {"file": "frozen-a8.json", "sha256": fsha},
           "results_dev_sha256": A.sha256_file(os.path.join(out_dir, "results-dev-a8.json")), "seed": SEED_BLIND7,
           "n_pairs": len(keys), "pairs_without_folds": sorted(k for k in S if not folds[k]),
           "per_pair": per_pair, "pooled": pooled, "verdict": verdict, "deep_band_median_abs_lnR": deep,
           "per_pair_ci_counts": pair_counts, "floor_per_pair": floors,
           "run": {"marker_started_utc": started, "finished_utc": M7.now_utc(),
                   "total_seconds": round(time.time() - t0, 1)}}
    A.write_json(os.path.join(out_dir, "results-blind7.json"), doc, refuse_overwrite=True)
    log(f"results-blind7 written ({time.time() - t0:.0f}s); verdict {verdict['verdict']}")
    return doc


def run_manifest(out_dir):
    files = sorted(f for f in os.listdir(out_dir) if f != "manifest.json" and not f.startswith("."))
    man = {"generated_utc": M7.now_utc(), "code": code_meta(), "prereg": PREREG,
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
    ap.add_argument("--phase", choices=("dev", "blind7", "manifest"), required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--blind7-commit", help="blind7: the published membrane-datasets commit holding blind7-prices/")
    ap.add_argument("--frozen-sha256", help="blind7: the published sha256 of frozen-a8.json")
    ap.add_argument("--code-change-note", help="blind7: reason a8_touch.py differs from the frozen code (recorded)")
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    if a.phase == "manifest":
        run_manifest(a.out)
        return 0
    log = lambda *x: print(*x, flush=True)  # noqa: E731
    if a.phase == "blind7":
        blind7_gate(a.out, a.blind7_commit, a.frozen_sha256, a.code_change_note)    # refuse before any input is read
        run_blind7(a.datasets, a.out, a.blind7_commit, a.frozen_sha256, workers=a.workers, log=log,
                   code_change_note=a.code_change_note)
        return 0
    meta = M2.verify_all(a.datasets)
    log("inputs verified")
    run_dev(a.datasets, a.out, meta, workers=a.workers, log=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
