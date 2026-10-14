#!/usr/bin/env python3
"""Q26 live forecast log -- the A5 model extension (HISTORY_TOUCH_PREREG_A5.md A5.5).

Used by q26_live_issue.py only when it is given --frozen-a5 and --frozen-a5-sha256. Without them the issuer is
unchanged (schema q26-touch-live/issue/1, A3 rungs and labels).

With them, each issue (schema q26-touch-live/issue/2, top-level `model` = A5):
- still issues the A3 rungs (a), (f), (fb), computed by the existing A3 refit at asof (unchanged numbers);
- adds (fbL) (a5_touch Prep5 / predict5 refit at asof: training origins t + T <= asof, beta per level band chosen
  in-fold on the as-of Brier);
- marks the A5 shipped rung per (asset, T) from frozen-a5.json and gives its estimate range (A4.3 procedure at
  Q_start = asof) and its A5 label, basis string and n_ep for the current regime;
- keeps the A3 shipped rung and A3 label under `a3` in every row, so the record stays comparable.
"""
import json
import os
import sys

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
SCORED_RUNGS = ("a", "f", "fb", "fbL")

DECISIONS_A5 = [
    "D-LV1 model A5 (A5.5): rows keep the A3 rungs a/f/fb (the existing A3 refit at asof, unchanged) and add fbL "
    "(a5_touch Prep5/predict5 at the asof origin with Q_start = asof). 'shipped' is the A5 shipped rung from "
    "frozen-a5.json; 'frozen_label' is its A5 label, basis and n_ep for the current regime; the A3 shipped rung and "
    "A3 label stay under 'a3'. p is monotone-fixed per rung (as the A rungs are scored), p_raw beside.",
    "D-LV2 estimate range (A4.3 procedure, A4 D1 wording) for the A5 shipped rung at Q_start = asof: the training "
    "days are the UTC dates of the shipped rung's training origins; 500 moving-block resamples (block max(30, 2T) "
    "days) from default_rng([20261040, asof]) in the order ETH, BTC, stETH > 6h..30d; 5th/95th percentiles; lo and "
    "hi are monotone-fixed and widened to contain p. The seed includes asof so every issue is reproducible.",
]


def load_frozen_a5(datasets, rel, sha):
    path = os.path.join(datasets, rel)
    with open(path, "rb") as f:
        raw = f.read()
    got = C.sha256_bytes(raw)
    if got != sha:
        raise SystemExit(f"STOP: frozen-a5.json sha256 {got} != expected {sha}")
    doc = json.loads(raw)
    if "shipped" not in doc or "labels" not in doc:
        raise SystemExit("STOP: frozen-a5.json lacks shipped/labels")
    return doc


def a5_label(frozen_a5, asset, TL, rung, k, regime):
    e = frozen_a5["labels"][asset][TL][rung][repr(float(k))]
    g = e.get(regime) if regime else None
    if not isinstance(g, dict):
        return {"label": None if regime else "no regime", "dev": None, "outcome": None, "n_ep": None,
                "basis": None, "pooled": e.get("pooled")}
    return {"label": g.get("after"), "dev": g.get("dev"), "outcome": g.get("outcome"), "n_ep": g.get("n_ep"),
            "basis": g.get("basis"), "pooled": e.get("pooled")}


def _range_samples(sl, so, P5, Po, T_h, i_now, ship, counts):
    te = np.array([i_now])
    f = {"qs_i": i_now}
    if ship == "a":
        return M4.band_samples_a(so, Po, i_now, 1, counts)
    if ship == "f":
        P4 = type("P4", (), {})()
        P4.P, P4.T_h, P4.K = P5.P, T_h, P5.K
        return M4.band_samples_f(sl, P4, i_now, te, counts, fc=False)
    del f
    return M5.band_samples_fbL(sl, P5, i_now, te, counts)


def a5_forecasts(datasets, rounds_by_asset, asof, frozen_a5, log=print, base_forecaster=None):
    """A3 forecasts (a, f, fb) plus fbL, the A5 estimate range of the shipped rung, and the per-band betas."""
    base_forecaster = base_forecaster or C.model_forecasts
    base = base_forecaster(datasets, rounds_by_asset, asof, log=log)
    S = C.build_live_series(datasets, rounds_by_asset, asof)
    rng = np.random.default_rng([RANGE_SEED, int(asof)])
    out = {}
    for a in C.ASSETS:
        sl, so = S[a]["long"], S[a]["oracle"]
        i_now = sl.gi(asof)
        K = len(sl.levels)
        raw_l = np.full((len(C.HORIZONS_H), K), np.nan)
        lo = np.full((len(C.HORIZONS_H), K), np.nan)
        hi = np.full((len(C.HORIZONS_H), K), np.nan)
        betas_l = {}
        for ti, T_h in enumerate(C.HORIZONS_H):
            TL = C.T_LABEL[T_h]
            ship = frozen_a5["shipped"][a][TL]
            P5 = M5.Prep5(sl, T_h, q_max=i_now)
            o = M5.predict5(sl, P5, T_h, i_now, np.array([i_now]))
            raw_l[ti] = o["raw"]["fbL"][0]
            betas_l[TL] = {str(bb): v[0] for bb, v in o["betas"].items()}
            Po = P5.P if so is sl else C.A3.Prep3(so, T_h, beta_select=False)
            ser_t = so if ship == "a" else sl
            lab = np.isfinite(ser_t.spot) & np.isfinite(ser_t.wmin(T_h))
            days, _, _ = M4.fold_days(ser_t, lab, T_h, i_now)
            idx = C.A.block_bootstrap_indices(rng, len(days), C.A.block_length(T_h), M5.N_BAND_REP)
            cnt = C.A.replicate_counts(idx, len(days))
            smp = _range_samples(sl, so, P5, Po, T_h, i_now, ship, cnt)
            q = np.percentile(smp, M5.BAND_PCT, axis=0)
            lo[ti], hi[ti] = q[0][0], q[1][0]
        fixed_l = C.A.monotone_fix(raw_l[None])[0]
        b = dict(base[a])
        b["raw"] = dict(b["raw"], fbL=raw_l)
        b["fixed"] = dict(b["fixed"], fbL=fixed_l)
        b["betas_fbL"] = betas_l
        pship = np.array([b["fixed"][frozen_a5["shipped"][a][C.T_LABEL[T]]][ti] for ti, T in enumerate(C.HORIZONS_H)])
        lo_f, hi_f = C.A.monotone_fix(lo[None])[0], C.A.monotone_fix(hi[None])[0]
        b["range_lo"], b["range_hi"] = np.minimum(lo_f, pship), np.maximum(hi_f, pship)
        out[a] = b
        log(f"model A5 {a}: fbL and ranges done")
    return out


def issue_rows_a5(fc, frozen_a3, frozen_a5, spot, asof, issued_at):
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
                r["a3"] = {"shipped": r["shipped"], "p_shipped": r["p_shipped"], "frozen_label": r["frozen_label"]}
                r["p"]["fbL"] = float(f["fixed"]["fbL"][ti, j])
                r["p_raw"]["fbL"] = float(f["raw"]["fbL"][ti, j])
                r["betas_fbL"] = f["betas_fbL"][TL]
                r["model"] = MODEL_VERSION
                r["shipped"] = ship
                r["p_shipped"] = r["p"][ship]
                r["estimateRange"] = {"lo": float(f["range_lo"][ti, j]), "hi": float(f["range_hi"][ti, j]),
                                      "wording": "estimate range"}
                r["frozen_label"] = a5_label(frozen_a5, a, TL, ship, k, f["regime"])
                i += 1
    assert i == len(rows)
    return rows
