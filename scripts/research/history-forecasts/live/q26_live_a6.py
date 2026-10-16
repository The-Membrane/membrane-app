#!/usr/bin/env python3
"""Q26 live forecast log -- the A6 model extension (HISTORY_TOUCH_PREREG_A6.md A6.5).

Used by q26_live_issue.py only when it is given --frozen-a6 and --frozen-a6-sha256 (which need the A5 flags as
well). Without them the issuer is unchanged (model A5 with the A5 flags, model A3 without).

With them, each issue (schema q26-touch-live/issue/3, top-level `model` = A6):
- computes the model-A5 part exactly as q26_live_a5.a5_forecasts does (the same A3 refit, the same (fbL), the same
  A5 estimate ranges from the same default_rng([20261040, asof]) stream), so every A3/A5 field of a row is
  byte-identical to an A5-mode run at the same asof;
- adds the A6 rungs (fh), (fH), (fHb) (a6_touch Prep6 / fold_predict6 at the asof origin with Q_start = asof:
  w_T, HAR coefficients and the beta maps refit on the labelled origins t + T <= asof);
- marks the A6 shipped rung per (asset, T) from frozen-a6.json, with its A6 estimate range (a6_touch range_samples,
  every fitted quantity re-estimated per resample) from a separate default_rng([20261040, asof, 6]) stream, and its
  A6 label, basis string and n_ep for the current regime (the frozen dev basis, or a final basis file when given);
- keeps the A5 shipped rung, p, estimate range and label under `a5` and the A3 ones under `a3` in every row.
The hourly high of the live span is max(answer in force at the hour start, every round with updatedAt in
(start, end]) from rounds with updatedAt <= asof (the A6 D1 reading of D-H1); the frozen span uses oracleHigh
(and the ETH/BTC Binance kline high before the splice hour), as the A6 dev run.
"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402
import q26_live_a5 as Q5  # noqa: E402

MODEL_DIR = C.MODEL_DIR
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)
import a4_touch as M4  # noqa: E402  (imported, never modified)
import a5_touch as M5  # noqa: E402,F401  (imported, never modified)
import a6_touch as M6  # noqa: E402  (imported, never modified; the dev-run code of 015512cb)

SCHEMA_V3 = "q26-touch-live/issue/3"
MODEL_VERSION = "A6"
A6_RUNGS = ("fh", "fH", "fHb")
SCORED_RUNGS = Q5.SCORED_RUNGS + A6_RUNGS          # a, f, fb, fbL, fh, fH, fHb
RANGE_SEED = M6.SEED_BAND                          # 20261040, combined with asof and 6 per issue (D-LA2)
RANGE_STREAM = 6
RANGE_WORDING = Q5.RANGE_WORDING

DECISIONS_A6 = [
    "D-LA1 model A6 (A6.5): the A5 part is q26_live_a5.a5_forecasts unchanged (same functions, same order, same "
    "default_rng([20261040, asof]) range stream), so every A3/A5 field of a row is byte-identical to an A5-mode run "
    "at the same asof; the A5 shipped rung, its p, estimate range and A5 label move under 'a5' (the A3 ones stay "
    "under 'a3'). Rows add fh/fH/fHb: a6_touch Prep6 + fold_predict6 at the asof origin with Q_start = asof (w_T, "
    "HAR coefficients and the per-band beta maps refit on the labelled origins t + T <= asof; the (fH) row takes "
    "(f) when a HAR component is undefined, A6 D-H4). 'shipped' is the A6 shipped rung from frozen-a6.json; its p "
    "is that rung's monotone-fixed p (a/f/fbL from the A5 part, which a6_touch reproduces exactly: asserted).",
    "D-LA2 A6 estimate range: a6_touch range_samples (A6 D-E1: beta per band, w_T, HAR coefficients and the beta "
    "map re-estimated in each resample) for the A6 shipped rung at Q_start = asof; training days as A5 D-LV2 (the "
    "oracle series for (a), the long series otherwise); 500 moving-block resamples from default_rng([20261040, "
    "asof, 6]) in the order ETH, BTC, stETH > 6h..30d (a stream separate from the A5 one, so the A5 ranges are "
    "unchanged); 5th/95th percentiles, monotone-fixed over T, widened to contain p.",
    "D-LA3 hourly high: frozen span = price-history oracleHigh (the round in force at the hour start and every "
    "round printed in the hour; A6 D1 ruling on D-H1) with the Binance kline high before the ETH/BTC splice hour, "
    "exactly as the A6 dev run; live span (2026-10-06T03:00Z .. asof-1h) = max of the answer in force at the hour "
    "start and every round with updatedAt in (start, end], from rounds with updatedAt <= asof only (the same window "
    "as the live low). The frozen close rebuilt from the same files must equal the series close (asserted).",
    "D-LA4 A6 label and basis: frozen-a6.json labels[asset][T][shipped][k][current regime] ('after': the label "
    "after the A6 development checks), its n_ep, the dev basis string (dev calibration, asset-matched, generic, "
    "blind set 4) and the seed-sensitive flag. Blind set 5 is not in the basis until A6.6 has run and a deviation "
    "adds its final basis file (--basis-final-a6). 'live' joins the basis only once the L.5 live check applies.",
]


# ---------------------------------------------------------------------------------------------
# Frozen inputs
# ---------------------------------------------------------------------------------------------
def load_frozen_a6(datasets, rel, sha):
    doc = json.loads(Q5._read_checked(datasets, rel, sha, "frozen-a6.json"))
    if "shipped" not in doc or "labels" not in doc:
        raise SystemExit("STOP: frozen-a6.json lacks shipped/labels")
    for a in C.ASSETS:
        for T_h in C.HORIZONS_H:
            if doc["shipped"][a][C.T_LABEL[T_h]] not in M6.SHIP_ORDER:
                raise SystemExit(f"STOP: frozen-a6.json shipped rung for {a} {C.T_LABEL[T_h]} is not an A6 candidate")
    return doc


def load_basis_final_a6(datasets, rel, sha):
    """basis-final.csv of the A6 blind-5 phase (same columns as A5's, blind5_R/blind5_n_ep)."""
    return Q5.load_basis_final(datasets, rel, sha)


def a6_label(frozen_a6, asset, TL, rung, k, regime, basis_final=None):
    e = frozen_a6["labels"][asset][TL][rung][repr(float(k))]
    g = e.get(regime) if regime else None
    if not isinstance(g, dict):
        return {"label": None if regime else "no regime", "dev": None, "outcome": None, "n_ep": None,
                "basis": None, "basisSource": None, "perSourceRule": None, "seedSensitive": None,
                "pooled": e.get("pooled")}
    basis, src = g.get("basis"), "frozen-a6 (development checks)"
    if basis_final is not None:
        key = (asset, TL, repr(float(k)), rung, regime)
        if key not in basis_final:
            raise SystemExit(f"STOP: A6 basis-final.csv has no row for {key}")
        lab_f, basis = basis_final[key]
        if lab_f != g.get("after"):
            raise SystemExit(f"STOP: A6 basis-final.csv label {lab_f} != frozen label {g.get('after')} at {key}")
        src = "basis-final A6 (development checks + blind set 5)"
    return {"label": g.get("after"), "dev": g.get("dev"), "outcome": g.get("outcome"), "n_ep": g.get("n_ep"),
            "basis": basis, "basisSource": src, "perSourceRule": g.get("per_source_rule"),
            "seedSensitive": g.get("seed_sensitive"), "pooled": e.get("pooled")}


# ---------------------------------------------------------------------------------------------
# Hourly high: frozen span and live span (D-LA3)
# ---------------------------------------------------------------------------------------------
def hourly_high(rounds, asset, start_ts, end_ts):
    """Hours opening at start_ts .. end_ts - 1h: max of the answer in force at the hour start and every round with
    updatedAt in (start, end] (the window of C.hourly_close_low). NaN where no round is in force at the start."""
    rs = C.sort_rounds(rounds)
    t = np.array([r.updated_at for r in rs], dtype=np.int64)
    p = np.array([C.price(r, asset) for r in rs], dtype=float)
    hours = np.arange(int(start_ts), int(end_ts), C.HOUR, dtype=np.int64)
    high = np.full(len(hours), np.nan)
    for j, h in enumerate(hours):
        i0 = int(np.searchsorted(t, h, side="right")) - 1
        i1 = int(np.searchsorted(t, h + C.HOUR, side="right"))
        if i0 < 0:
            continue
        high[j] = p[i0:i1].max()
    return high


def frozen_long_high(datasets, asset, n_frozen, start_i, close_frozen):
    """The frozen-span high of the long series on the A2 common grid (as a6_touch.attach_highs_dev), checked by
    rebuilding the close from the same files."""
    px = C.A.load_price(os.path.join(datasets, C.A.INPUTS[{"ETH": "eth_price", "BTC": "btc_price",
                                                           "stETH": "steth_price"}[asset]][0]),
                        cols=("oracle", "oracleLow", "oracleHigh"))
    oc, oh = C.M2.place_a_grid(px["oracle"]), C.M2.place_a_grid(px["oracleHigh"])
    ci = C.M2.gi(C.A.COVERAGE_START[asset])
    if asset in C.M2.LONG_PAIR:
        kl = M6.load_klines_cols(datasets, C.M2.LONG_PAIR[asset])
        oc2, oh2 = oc.copy(), oh.copy()
        oc2[:ci] = np.nan
        oh2[:ci] = np.nan
        si = C.M2.gi(C.M2.SPLICE_TS[asset])
        c, h = oc2.copy(), oh2.copy()
        c[:si], h[:si] = kl["close"][:si], kl["high"][:si]
        c[:kl["first_i"]] = np.nan
        h[:kl["first_i"]] = np.nan
    else:
        c, h = oc.copy(), oh.copy()
    c[:start_i] = np.nan
    if len(c) != n_frozen or not M6._same(c, close_frozen):
        raise SystemExit(f"STOP: rebuilt frozen close of long:{asset} differs from the live series close")
    return h


def attach_live_highs(datasets, S, rounds_by_asset, asof):
    """Attach the hourly high (frozen span + live span from rounds with updatedAt <= asof) to each long series."""
    for a in C.ASSETS:
        sl = S[a]["long"]
        nlive = len(S[a]["live_close"])
        nfz = sl.N - nlive
        rs = [r for r in rounds_by_asset[a] if r.updated_at <= asof]          # no price after asof
        hl = hourly_high(rs, a, C.DATA_END, asof)
        if len(hl) != nlive or (nlive and not np.isfinite(hl).all()):
            raise SystemExit(f"STOP: {a}: live hours without a round in force for the high")
        hf = frozen_long_high(datasets, a, nfz, sl.start_i, sl.close[:nfz])
        M6.attach_high(sl, np.concatenate([hf, hl]))
        S[a]["live_high"] = hl
    return S


# ---------------------------------------------------------------------------------------------
# Model: fh, fH, fHb and the A6 estimate range of the A6 shipped rung, at asof
# ---------------------------------------------------------------------------------------------
def a6_extend(fc5, sl, so, asof, shipped_a, rng6):
    """Add fh/fH/fHb (raw, fixed), the A6 fits and the A6 shipped rung's estimate range to one asset's model-A5
    forecast dict `fc5` (from q26_live_a5.a5_extend at the same asof). One (500 x days) count matrix per T is drawn
    from `rng6`, in the order 6h..30d."""
    i_now = sl.gi(asof)
    if i_now != sl.N:
        raise ValueError("series must end at asof")
    K = len(sl.levels)
    nT = len(C.HORIZONS_H)
    raw = {r: np.full((nT, K), np.nan) for r in A6_RUNGS}
    lo = np.full((nT, K), np.nan)
    hi = np.full((nT, K), np.nan)
    fits, n_days = {}, {}
    te = np.array([i_now])
    for ti, T_h in enumerate(C.HORIZONS_H):
        TL = C.T_LABEL[T_h]
        ship = shipped_a[TL]
        P6 = M6.Prep6(sl, T_h, q_max=i_now)
        Pa = P6.P if so is sl else C.A3.Prep3(so, T_h, beta_select=False)
        o = M6.fold_predict6(sl, P6, T_h, i_now, te, P_a=Pa)
        for r, key in (("a", "a"), ("f", "f"), ("fbL", "fbL")):            # a6_touch reproduces the A5 part
            if not np.array_equal(o["raw"][r][0], fc5["raw"][key][ti], equal_nan=True):
                raise SystemExit(f"STOP: a6_touch {r} at asof differs from the model-A5 {key} ({TL})")
        for r in A6_RUNGS:
            raw[r][ti] = o["raw"][r][0]
        ft = o["fit"]
        fits[TL] = {"w_fh": ft["w"], "w_info": ft["w_info"], "har": ft["har"], "har_info": ft["har_info"],
                    "maps_fHb": {str(b): {"theta": th, "n_rows": info["n_rows"], "n_eval": info.get("n_eval"),
                                          "converged": info["converged"]} for b, (th, info) in ft["maps"].items()},
                    "fH_fallback": bool(ft["fH_fallback_rows"]), "fHb_no_v": bool(ft["fHb_no_v_rows"])}
        ser_t = so if ship == "a" else sl
        lab = np.isfinite(ser_t.spot) & np.isfinite(ser_t.wmin(T_h))
        days, _, _ = M4.fold_days(ser_t, lab, T_h, i_now)
        idx = C.A.block_bootstrap_indices(rng6, len(days), C.A.block_length(T_h), M6.N_BAND_REP)
        cnt = C.A.replicate_counts(idx, len(days))
        Po = C.A3.Prep3(so, T_h, beta_select=False) if ship == "a" else None
        smp = M6.range_samples(sl, P6, ship, i_now, te, cnt, sl.sigma[te], sl.sigma_ref[te], P6.X[te], P6.okX[te],
                               ser_o=so, Po=Po)
        q = np.percentile(smp, M6.BAND_PCT, axis=0)
        lo[ti], hi[ti] = q[0][0], q[1][0]
        n_days[TL] = int(len(days))
        del P6, smp
    fixed = {r: (C.A.monotone_fix(g[None])[0] if not np.isnan(g).any() else None) for r, g in raw.items()}
    out = dict(fc5)
    out["raw6"], out["fixed6"] = raw, fixed
    out["fits6"] = fits
    out["range6_days"] = n_days
    out["har_now"] = [float(x) for x in M6.har_of(sl)[i_now]]
    allfixed = dict(fc5["fixed"], **fixed)
    grids = [allfixed[shipped_a[C.T_LABEL[T]]] for T in C.HORIZONS_H]
    if any(g is None for g in grids) or np.isnan(lo).any() or np.isnan(hi).any():
        out["range6_lo"] = out["range6_hi"] = None
    else:
        p = np.array([grids[ti][ti] for ti in range(nT)])
        lo_f, hi_f = C.A.monotone_fix(lo[None])[0], C.A.monotone_fix(hi[None])[0]
        out["range6_lo"], out["range6_hi"] = np.minimum(lo_f, p), np.maximum(hi_f, p)
    return out


def a6_forecasts(datasets, rounds_by_asset, asof, frozen_a5, frozen_a6, log=print):
    """q26_live_a5.a5_forecasts step for step (same series, same A5 rng stream), then a6_extend per asset."""
    S = C.build_live_series(datasets, rounds_by_asset, asof)
    attach_live_highs(datasets, S, rounds_by_asset, asof)
    rng = np.random.default_rng([Q5.RANGE_SEED, int(asof)])
    rng6 = np.random.default_rng([RANGE_SEED, int(asof), RANGE_STREAM])
    out = {}
    for a in C.ASSETS:
        t0 = time.time()
        fc = C.forecast_series(S[a]["long"], S[a]["oracle"], asof)
        fc.update(live_hours=int(len(S[a]["live_close"])), rounds_used=S[a]["rounds_used"],
                  frozen_oracle_close_last=S[a]["frozen_oracle_close_last"],
                  frozen_oracle_low_last=S[a]["frozen_oracle_low_last"])
        f5 = Q5.a5_extend(fc, S[a]["long"], S[a]["oracle"], asof, frozen_a5["shipped"][a], rng)
        t1 = time.time()
        out[a] = a6_extend(f5, S[a]["long"], S[a]["oracle"], asof, frozen_a6["shipped"][a], rng6)
        for ser in {id(S[a]["long"]): S[a]["long"], id(S[a]["oracle"]): S[a]["oracle"]}.values():
            M6._clear(ser)
        log(f"model {a}: regime {fc['regime']}; A3/A5 part ({t1 - t0:.0f}s), A6 rungs and range ({time.time() - t1:.0f}s)")
    return out


# ---------------------------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------------------------
def issue_rows_a6(fc, frozen_a3, frozen_a5, frozen_a6, spot, asof, issued_at, basis_final5=None, basis_final6=None):
    """q26_live_a5.issue_rows_a5 rows (unchanged A3/A5 fields), extended with fh/fH/fHb; the A5 shipped fields move
    under 'a5' and the A6 shipped rung, its p, estimate range and A6 label take the top-level fields."""
    rows = Q5.issue_rows_a5(fc, frozen_a3, frozen_a5, spot, asof, issued_at, basis_final5)
    i = 0
    for a in C.ASSETS:
        f = fc[a]
        for ti, T_h in enumerate(C.HORIZONS_H):
            TL = C.T_LABEL[T_h]
            ship = frozen_a6["shipped"][a][TL]
            for j, k in enumerate(C.LEVELS[a]):
                r = rows[i]
                assert r["asset"] == a and r["T_h"] == T_h and r["k"] == float(k)
                r["model"] = MODEL_VERSION
                r["a5"] = {"shipped": r["shipped"], "p_shipped": r["p_shipped"], "estimateRange": r["estimateRange"],
                           "frozen_label": r["frozen_label"]}
                for rr in A6_RUNGS:
                    r["p"][rr] = float(f["fixed6"][rr][ti, j]) if f["fixed6"][rr] is not None else None
                    r["p_raw"][rr] = float(f["raw6"][rr][ti, j])
                r["w_fh"] = f["fits6"][TL]["w_fh"]
                r["shipped"] = ship
                r["p_shipped"] = r["p"][ship]
                r["estimateRange"] = ({"lo": float(f["range6_lo"][ti, j]), "hi": float(f["range6_hi"][ti, j]),
                                       "wording": RANGE_WORDING, "rung": ship}
                                      if f["range6_lo"] is not None else None)
                r["frozen_label"] = a6_label(frozen_a6, a, TL, ship, k, f["regime"], basis_final6)
                i += 1
    assert i == len(rows)
    return rows
