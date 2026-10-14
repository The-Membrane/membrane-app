#!/usr/bin/env python3
"""Q26 live forecast log -- the A5 model extension (HISTORY_TOUCH_PREREG_A5.md A5.5).

Used by q26_live_issue.py only when it is given --frozen-a5 and --frozen-a5-sha256. Without them the issuer is
unchanged (schema q26-touch-live/issue/1, A3 rungs and labels).

With them, each issue (schema q26-touch-live/issue/2, top-level `model` = A5):
- still issues the A3 rungs (a), (f), (fb), computed by the existing A3 refit at asof (unchanged numbers);
- adds (fbL) (a5_touch Prep5 / predict5 refit at asof: training origins t + T <= asof, beta per level band chosen
  on the as-of Brier with Q_start = asof);
- marks the A5 shipped rung per (asset, T) from frozen-a5.json and gives its estimate range (A4.3 procedure at
  Q_start = asof) and its A5 label, basis string and n_ep for the current regime (the basis string from the final
  basis file of the blind-4 phase when one is given, else the frozen dev basis);
- keeps the A3 shipped rung and A3 label under `a3` in every row, so the record stays comparable.
"""
import csv
import io
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402

MODEL_DIR = C.MODEL_DIR
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)
import a4_touch as M4  # noqa: E402  (imported, never modified)
import a5_touch as M5  # noqa: E402  (imported, never modified)

SCHEMA_V2 = "q26-touch-live/issue/2"
MODEL_VERSION = "A5"
RANGE_SEED = M5.SEED_BAND                  # 20261040, combined with asof per issue (D-LV2)
RANGE_WORDING = "estimate range"           # A4 D1 wording
SCORED_RUNGS = C.SCORED_RUNGS              # a, f, fb, fbL

DECISIONS_A5 = [
    "D-LV1 model A5 (A5.5): rows keep the A3 rungs a/f/fb (the existing A3 refit at asof, unchanged) and add fbL "
    "(a5_touch Prep5/predict5 at the asof origin with Q_start = asof: training origins t + T <= asof; beta per "
    "level band by the as-of Brier on evaluation origins t + T <= asof). 'shipped' is the A5 shipped rung from "
    "frozen-a5.json; (a) and (f) of A5 are the same estimators as A3's, so p['a'] and p['f'] serve both. "
    "'frozen_label' is the A5 label (frozen after the development checks), its n_ep and basis string for the "
    "current regime; the A3 shipped rung, its p and its A3 label stay under 'a3'. p is monotone-fixed per rung "
    "(as the A rungs are scored), p_raw beside.",
    "D-LV2 estimate range (A4.3 procedure, A4 D1 wording) for the A5 shipped rung at Q_start = asof: the training "
    "days are the UTC dates of the labelled training origins (t + T <= asof) of the shipped rung's series (the "
    "oracle series for (a), the long series for (f)/(fbL)); 500 moving-block resamples (block max(30, 2T) days) "
    "drawn from default_rng([20261040, asof]) in the order ETH, BTC, stETH > 6h..30d; 5th/95th percentiles; lo "
    "and hi are monotone-fixed over T and widened to contain p. The seed includes asof, so each issue is "
    "reproducible from its own inputs.",
    "D-LV3 basis string: from the final basis file of the A5 blind-4 phase (dev checks + blind set 4) when the "
    "issuer is given one (--basis-final with its sha256), else the frozen dev basis of frozen-a5.json; the source "
    "is named in each row. 'live' is added to basis strings only once the live check is applied (L.5, 90 resolved "
    "issue days per horizon); until then it is not part of the basis.",
]


# ---------------------------------------------------------------------------------------------
# Frozen inputs
# ---------------------------------------------------------------------------------------------
def _read_checked(datasets, rel, sha, what):
    path = rel if os.path.isabs(rel) else os.path.join(datasets, rel)
    with open(path, "rb") as f:
        raw = f.read()
    got = C.sha256_bytes(raw)
    if got != sha:
        raise SystemExit(f"STOP: {what} sha256 {got} != expected {sha}")
    return raw


def load_frozen_a5(datasets, rel, sha):
    doc = json.loads(_read_checked(datasets, rel, sha, "frozen-a5.json"))
    if "shipped" not in doc or "labels" not in doc:
        raise SystemExit("STOP: frozen-a5.json lacks shipped/labels")
    for a in C.ASSETS:
        for T_h in C.HORIZONS_H:
            if doc["shipped"][a][C.T_LABEL[T_h]] not in M5.SHIP_ORDER:
                raise SystemExit(f"STOP: frozen-a5.json shipped rung for {a} {C.T_LABEL[T_h]} is not a/f/fbL")
    return doc


def load_basis_final(datasets, rel, sha):
    """basis-final.csv of the A5 blind-4 phase -> {(asset, T, repr(k), rung, regime): (label, basis)}."""
    raw = _read_checked(datasets, rel, sha, "basis-final.csv")
    out = {}
    for r in csv.DictReader(io.StringIO(raw.decode())):
        out[(r["asset"], r["T"], repr(float(r["k"])), r["rung"], r["regime"])] = (r["label"], r["basis"])
    if not out:
        raise SystemExit("STOP: basis-final.csv has no rows")
    return out


def a5_label(frozen_a5, asset, TL, rung, k, regime, basis_final=None):
    e = frozen_a5["labels"][asset][TL][rung][repr(float(k))]
    g = e.get(regime) if regime else None
    if not isinstance(g, dict):
        return {"label": None if regime else "no regime", "dev": None, "outcome": None, "n_ep": None,
                "basis": None, "basisSource": None, "perSourceRule": None, "pooled": e.get("pooled")}
    basis, src = g.get("basis"), "frozen-a5 (development checks)"
    if basis_final is not None:
        key = (asset, TL, repr(float(k)), rung, regime)
        if key not in basis_final:
            raise SystemExit(f"STOP: basis-final.csv has no row for {key}")
        lab_f, basis = basis_final[key]
        if lab_f != g.get("after"):
            raise SystemExit(f"STOP: basis-final.csv label {lab_f} != frozen label {g.get('after')} at {key}")
        src = "basis-final (development checks + blind set 4)"
    return {"label": g.get("after"), "dev": g.get("dev"), "outcome": g.get("outcome"), "n_ep": g.get("n_ep"),
            "basis": basis, "basisSource": src, "perSourceRule": g.get("per_source_rule"), "pooled": e.get("pooled")}


# ---------------------------------------------------------------------------------------------
# Model: fbL and the estimate range of the A5 shipped rung, at asof
# ---------------------------------------------------------------------------------------------
def _range_samples(sl, so, P5, T_h, i_now, ship, counts):
    te = np.array([i_now])
    if ship == "a":
        Po = P5.P if so is sl else C.A3.Prep3(so, T_h, beta_select=False)
        return M4.band_samples_a(so, Po, i_now, 1, counts)
    if ship == "f":
        P4 = type("P4", (), {})()
        P4.P, P4.T_h, P4.K = P5.P, T_h, P5.K
        return M4.band_samples_f(sl, P4, i_now, te, counts, fc=False)
    return M5.band_samples_fbL(sl, P5, i_now, te, counts)


def a5_extend(fc, sl, so, asof, shipped_a, rng):
    """Add fbL (raw, fixed), its per-band betas and the estimate range of the shipped rung to one asset's A3
    forecast dict `fc` (from C.forecast_series at the same asof). Draws one (500 x days) count matrix per T from
    `rng`, in the order 6h..30d."""
    i_now = sl.gi(asof)
    if i_now != sl.N:
        raise ValueError("series must end at asof")
    K = len(sl.levels)
    nT = len(C.HORIZONS_H)
    raw_l = np.full((nT, K), np.nan)
    lo = np.full((nT, K), np.nan)
    hi = np.full((nT, K), np.nan)
    betas_l, n_days = {}, {}
    for ti, T_h in enumerate(C.HORIZONS_H):
        TL = C.T_LABEL[T_h]
        ship = shipped_a[TL]
        P5 = M5.Prep5(sl, T_h, q_max=i_now)
        o = M5.predict5(sl, P5, T_h, i_now, np.array([i_now]))
        raw_l[ti] = o["raw"]["fbL"][0]
        betas_l[TL] = {str(bb): {"beta": b, "n_eval": info["n_eval"]} for bb, (b, info) in o["betas"].items()}
        ser_t = so if ship == "a" else sl
        lab = np.isfinite(ser_t.spot) & np.isfinite(ser_t.wmin(T_h))
        days, _, _ = M4.fold_days(ser_t, lab, T_h, i_now)
        idx = C.A.block_bootstrap_indices(rng, len(days), C.A.block_length(T_h), M5.N_BAND_REP)
        cnt = C.A.replicate_counts(idx, len(days))
        smp = _range_samples(sl, so, P5, T_h, i_now, ship, cnt)
        q = np.percentile(smp, M5.BAND_PCT, axis=0)
        lo[ti], hi[ti] = q[0][0], q[1][0]
        n_days[TL] = int(len(days))
    fixed_l = C.A.monotone_fix(raw_l[None])[0] if not np.isnan(raw_l).any() else None
    out = dict(fc)
    out["raw"] = dict(fc["raw"], fbL=raw_l)
    out["fixed"] = dict(fc["fixed"], fbL=fixed_l)
    out["betas_fbL"] = betas_l
    out["range_days"] = n_days
    grids = [out["fixed"][shipped_a[C.T_LABEL[T]]] for T in C.HORIZONS_H]
    if any(g is None for g in grids) or np.isnan(lo).any() or np.isnan(hi).any():
        out["range_lo"] = out["range_hi"] = None
    else:
        p = np.array([grids[ti][ti] for ti in range(nT)])           # (nT, K): the shipped rung's p per T
        lo_f, hi_f = C.A.monotone_fix(lo[None])[0], C.A.monotone_fix(hi[None])[0]
        out["range_lo"], out["range_hi"] = np.minimum(lo_f, p), np.maximum(hi_f, p)
    return out


def a5_forecasts(datasets, rounds_by_asset, asof, frozen_a5, log=print):
    """The A3 refit (C.forecast_series, exactly as C.model_forecasts) plus a5_extend per asset."""
    S = C.build_live_series(datasets, rounds_by_asset, asof)
    rng = np.random.default_rng([RANGE_SEED, int(asof)])
    out = {}
    for a in C.ASSETS:
        t0 = time.time()
        fc = C.forecast_series(S[a]["long"], S[a]["oracle"], asof)
        fc.update(live_hours=int(len(S[a]["live_close"])), rounds_used=S[a]["rounds_used"],
                  frozen_oracle_close_last=S[a]["frozen_oracle_close_last"],
                  frozen_oracle_low_last=S[a]["frozen_oracle_low_last"])
        out[a] = a5_extend(fc, S[a]["long"], S[a]["oracle"], asof, frozen_a5["shipped"][a], rng)
        log(f"model {a}: regime {fc['regime']}; A3 rungs, fbL and estimate ranges ({time.time() - t0:.0f}s)")
    return out


# ---------------------------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------------------------
def issue_rows_a5(fc, frozen_a3, frozen_a5, spot, asof, issued_at, basis_final=None):
    """C.issue_rows (A3 rungs, A3 shipped rung and label) extended per row with fbL, the A5 shipped rung, its
    estimate range and A5 label; the A3 fields move under 'a3'."""
    rows = C.issue_rows(fc, frozen_a3, spot, asof, issued_at)
    i = 0
    for a in C.ASSETS:
        f = fc[a]
        for ti, T_h in enumerate(C.HORIZONS_H):
            TL = C.T_LABEL[T_h]
            ship = frozen_a5["shipped"][a][TL]
            for j, k in enumerate(C.LEVELS[a]):
                r = rows[i]
                assert r["asset"] == a and r["T_h"] == T_h and r["k"] == float(k)
                r["model"] = MODEL_VERSION
                r["a3"] = {"shipped": r["shipped"], "p_shipped": r["p_shipped"], "frozen_label": r["frozen_label"]}
                r["p"]["fbL"] = float(f["fixed"]["fbL"][ti, j]) if f["fixed"]["fbL"] is not None else None
                r["p_raw"]["fbL"] = float(f["raw"]["fbL"][ti, j])
                r["betas_fbL"] = f["betas_fbL"][TL]
                r["shipped"] = ship
                r["p_shipped"] = r["p"][ship]
                r["estimateRange"] = ({"lo": float(f["range_lo"][ti, j]), "hi": float(f["range_hi"][ti, j]),
                                       "wording": RANGE_WORDING, "rung": ship}
                                      if f["range_lo"] is not None else None)
                r["frozen_label"] = a5_label(frozen_a5, a, TL, ship, k, f["regime"], basis_final)
                i += 1
    assert i == len(rows)
    return rows
