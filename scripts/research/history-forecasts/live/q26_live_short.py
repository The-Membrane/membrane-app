#!/usr/bin/env python3
"""Q26 live forecast log -- short horizons 1 h, 3 h, 12 h with (fH), shallow levels only (log only, never shown).

membrane-board design/HISTORY_TOUCH_LIVE.md Deviation D8 (owner approval 2026-10-18); recipe and evidence
design/Q26_ROUND11_PREREG.md R11.10 (D-R11.10a..g). Used by q26_live_issue.py only with --short-fh and by
q26_live_score.py whenever an issue file carries `shortRows`. Without the flag the issuer is unchanged.

Issue side (one block per daily issue, inside the existing 00:17Z job; no new schedule):
- Origins: every hour t with max(previous short origin + 1 h, asof - 23 h, FIRST_ORIGIN) <= t <= asof, so hourly
  origins, each issued at most once, with no backfill beyond 24 h (a missed day leaves its hours missing).
- One fit per issue (the R11.10 "one fit per (T, fold)" rule, the fold being this issue's origins): training
  origins t' + T <= first origin of the batch. Test rows at every origin of the batch, each computed from the
  series up to that origin only (the series is causal; a test asserts that rows do not change when every price
  after the origin is replaced).
- Rungs: (fH) (A6 D-H4 HAR scale, horizon-matched target, with the (f) fallback where sigma_H is undefined), (f)
  (FHS with sigma_hat) and (a) (plain history, expanding frequency to Q_start - T; oracle series for ETH/BTC as the
  A3/A6 live (a)); running minimum across the full ladder (R11.2 rule); code r1110_blind.fold_rungs unchanged.
- Levels: the validated shallow region of D-R11.10g per horizon (SHORT_LEVELS); stETH uses the same caps on its
  own ladder and is not validated (log only).
- Rows go to the issue file's top-level `shortRows` (after `rows`); the block `short` holds the metadata. Every
  other field of the issue file is byte-identical to a run without the flag.

Score side (inside the existing 00:47Z job): see score_short / summarize_short.
"""
import json
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402

MODEL_DIR = C.MODEL_DIR
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)
import a6_touch as M6  # noqa: E402  (imported, never modified)
import r1110_blind as R1110  # noqa: E402  (the frozen R11.10 recipe; fold_rungs imported unchanged)

SCHEMA = "q26-touch-live/short/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "deviation": "D8",
          "recipe": "design/Q26_ROUND11_PREREG.md R11.10 (D-R11.10a..g)"}
HORIZONS = (1, 3, 12)
TL = {1: "1h", 3: "3h", 12: "12h"}
RUNGS = ("fH", "f", "a")
# Validated shallow region (D-R11.10g: (fH) beats (f) only to about -3% at 1 h, -7% at 3 h, -10% at 12 h).
LEVEL_CAP = {1: -0.03, 3: -0.07, 12: -0.10}
SHORT_LEVELS = {a: {T: tuple(k for k in C.LEVELS[a] if k >= LEVEL_CAP[T] - 1e-12) for T in HORIZONS}
                for a in C.ASSETS}
FIRST_ORIGIN = C.A.utc("2026-10-18T03:00:00Z")   # first hour after the D8 code pin (no earlier price is a test row)
MAX_BATCH_H = 24                                 # at most the 24 hourly origins up to asof per issue

# Scoring (D8; the Q26 hourly-origin rule D-R11.10d)
HAC_LAG = 24
BOOT_B = 10000
BOOT_SEED = 20261018
ALPHA = 0.05 / 3
R_BAND = (0.8, 1.25)
# Live evidence threshold: origin-days (hourly origins / 24, ETH) before the verdict is read, the days to 80% power
# at the dev effect under the HAC lag-24 rule (Q26_ROUND11_PREREG P3-7: 444 / 544 / 2,163 vs (f)); R11.10-0 at the
# registered lag T - 1 needed 157 / 248 / 1,664. A horizon that has not reached it reports, never decides.
EVIDENCE_DAYS = {1: 444, 3: 544, 12: 2163}
EVIDENCE_DAYS_LAG_T1 = {1: 157, 3: 248, 12: 1664}
MAX_DAYS = 730
SHORT_OUTCOME_RE = re.compile(r"^short-outcomes-(\d{4}-\d{2})\.jsonl$")

DECISIONS = [
    "D-S1 origins: hourly, t in [max(previous short origin + 1 h, asof - 23 h, FIRST_ORIGIN), asof], inside the "
    "daily issue job (no new schedule). Rows for t < asof are computed after t by the pinned model from rounds with "
    "updatedAt <= t only; they are forward-blind because the model and its pin were fixed before those prices "
    "existed, not because of issue time. So no row is excluded for a touch before issuedAt (L.4 exclusion applies to "
    "the daily rows only); each row records issuedAt and its origin.",
    "D-S2 fit: one fit per issue (R11.10 one fit per (T, fold)): HAR coefficients and the FHS z sets from labelled "
    "origins t' with t' + T <= the first origin of the batch; (a) = expanding frequency to that first origin - T. "
    "r1110_blind.fold_rungs unchanged; running minimum across the full ladder per rung, then the shallow levels kept.",
    "D-S3 spot S = the answer in force at the origin (equals the series close of the hour ending there: asserted). "
    "Truth as L.4 primary (min of the answer in force at t and every round in (t, t + T] <= S (1 + k)); Binance "
    "hourly lows as secondary for ETH/BTC. A row resolves at the first scorer run >= 15 min after t + T once the "
    "round store covers t + T; a missing-data gap > 2 h leaves it unresolved.",
    "D-S4 nothing is displayed. The block exists for scoring only (owner approval 2026-10-18: log only).",
]


def prev_short_origin(idir):
    """lastOrigin of the newest issue file that has a short block, or None."""
    for _, name in reversed(C.list_issue_files(idir)):
        with open(os.path.join(idir, name), "rb") as f:
            doc = json.loads(f.read())
        sh = doc.get("short")
        if isinstance(sh, dict) and sh.get("lastOrigin") is not None:
            return int(sh["lastOrigin"])
    return None


def batch_origins(asof, prev_last):
    lo = max(asof - (MAX_BATCH_H - 1) * C.HOUR, FIRST_ORIGIN)
    if prev_last is not None:
        lo = max(lo, int(prev_last) + C.HOUR)
    lo = -(-lo // C.HOUR) * C.HOUR
    return list(range(lo, asof + 1, C.HOUR))


def series_for(datasets, rounds_by_asset, asof):
    """The live long/oracle series up to asof with the hourly high attached (the A6 live series)."""
    import q26_live_a6 as Q6
    S = C.build_live_series(datasets, rounds_by_asset, asof)
    Q6.attach_live_highs(datasets, S, rounds_by_asset, asof)
    return S


def asset_short(sl, so, origins):
    """{T: {"P": {rung: (n_origins, K) fixed grid}, "fallback": bool array, "fit": {...}}} for one asset."""
    te = np.array([sl.gi(t) for t in origins], dtype=np.int64)
    if te.max() > sl.N:
        raise ValueError("origin after the series end")
    qs_i = int(te[0])
    out = {}
    for T in HORIZONS:
        P6 = M6.Prep6(sl, T, with_fbL=False)
        Pa = P6.P if so is sl else C.A3.Prep3(so, T, beta_select=False)
        p, fit = R1110.fold_rungs(sl, P6, Pa, T, qs_i, te)
        coef, _ = P6.har_coef(qs_i)
        sH = P6.sigma_H(coef, P6.X[te], P6.okX[te])
        P = {r: np.minimum.accumulate(p[r], axis=1) for r in RUNGS}
        out[T] = {"P": P, "fallback": ~np.isfinite(sH), "fit": fit}
        del P6
    return out


def short_forecasts(datasets, rounds_by_asset, asof, origins, log=print):
    """Per asset: per-origin spot, regime, and the (fH)/(f)/(a) grids at each short horizon."""
    if not origins:
        return {}
    S = series_for(datasets, rounds_by_asset, asof)
    out = {}
    for a in C.ASSETS:
        sl, so = S[a]["long"], S[a]["oracle"]
        te = [sl.gi(t) for t in origins]
        out[a] = {"spot_series": [float(sl.spot[i]) for i in te],
                  "regime": [(C.REGIMES[int(sl.regime[i])] if int(sl.regime[i]) >= 0 else None) for i in te],
                  "T": asset_short(sl, so, origins)}
        for ser in {id(sl): sl, id(so): so}.values():
            M6._clear(ser)
        log(f"short {a}: {len(origins)} origins")
    return out


def short_rows(fc, rounds_by_asset, origins, issued_at):
    rows = []
    for a in C.ASSETS:
        if a not in fc:
            continue
        rs = C.sort_rounds(rounds_by_asset[a])
        f = fc[a]
        for oi, t in enumerate(origins):
            r_in = C.answer_in_force(rs, t)
            if r_in is None:
                raise SystemExit(f"STOP: {a}: no round in force at short origin {C.iso(t)}")
            S = C.price(r_in, a)
            if f["spot_series"][oi] != S:
                raise SystemExit(f"STOP: {a}: series spot at {C.iso(t)} != answer in force")
            for T in HORIZONS:
                ft = f["T"][T]
                for k in SHORT_LEVELS[a][T]:
                    j = C.LEVELS[a].index(k)
                    p = {r: float(ft["P"][r][oi, j]) for r in RUNGS}
                    rows.append({"origin": t, "originIso": C.iso(t), "asset": a, "T": TL[T], "T_h": T,
                                 "k": float(k), "S": S, "L": S * (1.0 + float(k)), "resolvesAt": t + T * C.HOUR,
                                 "issuedAt": issued_at, "regime": f["regime"][oi], "p": p,
                                 "fH_fallback": bool(ft["fallback"][oi])})
    return rows


def short_block(fc, origins, rows, prev_last):
    fits = {a: {TL[T]: fc[a]["T"][T]["fit"] for T in HORIZONS} for a in fc}
    return {"schema": SCHEMA, "prereg": PREREG, "display": "none (log only)",
            "what": "(fH) touch odds at 1 h, 3 h, 12 h on the validated shallow levels, with (f) and plain history "
                    "(a) beside for scoring; hourly origins inside the daily issue",
            "horizons": [TL[T] for T in HORIZONS], "rungs": list(RUNGS),
            "levels": {a: {TL[T]: list(SHORT_LEVELS[a][T]) for T in HORIZONS} for a in C.ASSETS},
            "firstOrigin": FIRST_ORIGIN, "firstOriginIso": C.iso(FIRST_ORIGIN), "prevLastOrigin": prev_last,
            "nOrigins": len(origins), "origins": origins,
            "lastOrigin": origins[-1] if origins else prev_last,
            "fits": fits, "decisions": DECISIONS, "nShortRows": len(rows)}


def dumps_issue(doc):
    """C.dumps_with_rows layout with a second compact row list `shortRows` after `rows`."""
    d = dict(doc)
    srows = d.pop("shortRows")
    head = C.dumps_with_rows(d).decode()
    assert head.endswith("\n ]\n}\n")
    body = ",\n".join("  " + json.dumps(C.clean(r), separators=(",", ":"), ensure_ascii=True, allow_nan=False)
                      for r in srows)
    tail = ("[\n" + body + "\n ]") if srows else "[]"
    return (head[:-3] + ',\n "shortRows": ' + tail + "\n}\n").encode()


# ---------------------------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------------------------
def short_key(r):
    return (int(r["origin"]), r["asset"], int(r["T_h"]), repr(float(r["k"])))


def load_short_rows(idir):
    rows = []
    for date, name in C.list_issue_files(idir):
        with open(os.path.join(idir, name), "rb") as f:
            doc = json.loads(f.read())
        sr = doc.get("shortRows")
        if sr is None:
            continue
        if doc.get("short", {}).get("nShortRows") != len(sr):
            raise SystemExit(f"STOP: {name}: nShortRows != number of short rows")
        for r in sr:
            rows.append(dict(r, date=date))
    return rows


def load_short_outcomes(sdir):
    out, seen = [], set()
    if not os.path.isdir(sdir):
        return out
    for name in sorted(os.listdir(sdir)):
        if not SHORT_OUTCOME_RE.match(name):
            continue
        with open(os.path.join(sdir, name)) as f:
            for line in f:
                if line.strip():
                    o = json.loads(line)
                    k = short_key(o)
                    if k in seen:
                        raise SystemExit(f"STOP: duplicate short outcome {k} in {name}")
                    seen.add(k)
                    out.append(o)
    return out


def resolve_short(row, rounds, kidx, coverage, now):
    end = int(row["resolvesAt"])
    if now < end + C.RESOLVE_MARGIN:
        return None, "before origin + T + 15 min"
    if coverage is None or coverage < end:
        return None, "round store does not yet cover origin + T"
    a, t, L = row["asset"], int(row["origin"]), float(row["L"])
    out = {k: row[k] for k in ("date", "origin", "asset", "T", "T_h", "k", "S", "L", "resolvesAt", "issuedAt",
                               "regime", "p", "fH_fallback")}
    out.update(scoredAt=now)
    w = C.round_window(rounds, a, t, end, t)
    if w is None:
        out.update(status="unresolved", reason="no round in force at the origin", y=None)
        return out, None
    out["truth"] = {"min": w["minPrice"], "nRounds": w["nRounds"], "maxMissingGapSeconds": w["maxMissingGap"],
                    "spotMatchesIssue": C.price(w["inForce"], a) == float(row["S"])}
    if w["maxMissingGap"] > C.MAX_GAP:
        out.update(status="unresolved", reason="round store gap > 2 h", y=None)
        return out, None
    out.update(status="resolved", y=int(w["minPrice"] <= L))
    if a in C.BINANCE_PAIRS:
        b = C.binance_window(kidx or {}, t, int(row["T_h"]))
        ok = b["maxGap"] <= C.MAX_GAP and b["minLow"] is not None
        out["secondary"] = {"status": "resolved" if ok else "unresolved",
                            "y": int(b["minLow"] <= L) if ok else None, "nMissing": b["nMissing"]}
    return out, None


def _pos_episodes(origins, y):
    o = np.argsort(origins)
    t, yy = np.asarray(origins)[o], np.asarray(y)[o]
    n = 0
    for i in range(len(t)):
        if yy[i] == 1 and not (i > 0 and yy[i - 1] == 1 and t[i] - t[i - 1] == C.HOUR):
            n += 1
    return n


def _rstats(rs):
    y = np.array([o["y"] for o in rs], float)
    st = {"n": len(rs), "sum_y": float(y.sum()), "n_ep": _pos_episodes([o["origin"] for o in rs], y)}
    for r in RUNGS:
        p = np.array([o["p"][r] for o in rs], float)
        st[r] = {"brier": float(np.mean((p - y) ** 2)), "sum_p": float(p.sum()), "R": C.ratio(float(p.sum()),
                                                                                              float(y.sum()))}
    for c in ("f", "a"):
        bc = st[c]["brier"]
        st[f"bss_fH_vs_{c}"] = (1.0 - st["fH"]["brier"] / bc) if bc > 0 else None
    return st


def per_origin_d(rs, cmp):
    """Per-origin mean over the logged cells of (p_fH - y)^2 - (p_cmp - y)^2, in origin order."""
    by = {}
    for o in rs:
        by.setdefault(int(o["origin"]), []).append((o["p"]["fH"] - o["y"]) ** 2 - (o["p"][cmp] - o["y"]) ** 2)
    ts = np.array(sorted(by), dtype=np.int64)
    return ts, np.array([np.mean(by[t]) for t in ts], float)


def hac_p(d, lag=HAC_LAG):
    from scipy.stats import norm
    n = len(d)
    if n < 2:
        return None
    mu = float(d.mean())
    lrv = M6.nw_lrv(d - mu, lag)
    if not lrv > 0:
        return None
    return float(norm.cdf(mu / np.sqrt(lrv / n)))


def week_boot_p(ts, d, B=BOOT_B, seed=BOOT_SEED):
    """Weekly blocks (Monday 00:00Z), resampled with replacement; p = (1 + #{m* - m <= m}) / (B + 1)."""
    if len(d) < 2:
        return None
    wk = (ts - 4 * C.DAY) // (7 * C.DAY)          # 1970-01-05 was a Monday
    uw, inv = np.unique(wk, return_inverse=True)
    s = np.bincount(inv, weights=d)
    c = np.bincount(inv).astype(float)
    if len(uw) < 2:
        return None
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(uw), size=(B, len(uw)))
    m = float(d.mean())
    ms = s[idx].sum(axis=1) / c[idx].sum(axis=1)
    return float((1 + np.sum(ms - m <= m)) / (B + 1))


def summarize_short(outcomes, rows, pending):
    res = [o for o in outcomes if o["status"] == "resolved"]
    out = {"schema": SCHEMA + "/summary", "prereg": PREREG, "display": "none (log only)",
           "nRows": len(rows), "nOutcomes": len(outcomes), "nResolved": len(res), "nPending": len(pending),
           "evidenceRule": {"test": f"per (asset, T): one-sided HAC (Newey-West Bartlett lag {HAC_LAG} h, normal) "
                                    "and weekly block bootstrap on per-origin Brier differences over the logged "
                                    "shallow cells, vs (f) and vs (a); pass = mean d < 0 and both p < 0.05/3 vs both, "
                                    "and pooled R(fH) in [0.8, 1.25] (D-R11.10d rule)",
                            "readAtOriginDays": {TL[T]: EVIDENCE_DAYS[T] for T in HORIZONS},
                            "originDaysAtLagTminus1": {TL[T]: EVIDENCE_DAYS_LAG_T1[T] for T in HORIZONS},
                            "maxDays": MAX_DAYS, "primaryAsset": "ETH",
                            "note": "read once per horizon when ETH reaches readAtOriginDays (or maxDays); before "
                                    "that every value is reported only. Live results never retune the model."},
           "cells": {}}
    for a in C.ASSETS:
        for T in HORIZONS:
            rs = [o for o in res if o["asset"] == a and o["T_h"] == T]
            if not rs:
                continue
            ts_all = sorted({int(o["origin"]) for o in rs})
            od = len(ts_all) / 24.0
            cell = {"originDays": od, "nOrigins": len(ts_all), "pooled": _rstats(rs),
                    "perLevel": {repr(float(k)): _rstats([o for o in rs if repr(float(o["k"])) == repr(float(k))])
                                 for k in SHORT_LEVELS[a][T]
                                 if any(repr(float(o["k"])) == repr(float(k)) for o in rs)},
                    "perMonth": {}, "tests": {}}
            for mth in sorted({C.iso(int(o["origin"]))[:7] for o in rs}):
                cell["perMonth"][mth] = _rstats([o for o in rs if C.iso(int(o["origin"]))[:7] == mth])
            for c in ("f", "a"):
                ts, d = per_origin_d(rs, c)
                cell["tests"][f"vs_{c}"] = {"mean_d": float(d.mean()), "hac_lag": HAC_LAG, "hac_p": hac_p(d),
                                            "boot_p": week_boot_p(ts, d)}
            R = cell["pooled"]["fH"]["R"]
            due = od >= EVIDENCE_DAYS[T] or od >= MAX_DAYS
            passed = (all(cell["tests"][f"vs_{c}"]["mean_d"] < 0
                          and (cell["tests"][f"vs_{c}"]["hac_p"] or 1) < ALPHA
                          and (cell["tests"][f"vs_{c}"]["boot_p"] or 1) < ALPHA for c in ("f", "a"))
                      and C.r_inside(R, *R_BAND))
            cell["verdict"] = {"applied": bool(due and a == "ETH"), "pass": bool(passed),
                               "originDaysNeeded": EVIDENCE_DAYS[T]}
            out["cells"].setdefault(a, {})[TL[T]] = cell
    return out


def score_short(idir, sdir, rounds, kidx, coverage, now):
    """Resolve due short rows (append-only short-outcomes-YYYY-MM.jsonl) and return (summary, new, pending)."""
    rows = load_short_rows(idir)
    done = load_short_outcomes(sdir)
    keys = {short_key(o) for o in done}
    new, pending = [], []
    for r in rows:
        if short_key(r) in keys:
            continue
        o, why = resolve_short(r, rounds[r["asset"]], kidx.get(r["asset"]), coverage[r["asset"]], now)
        if o is None:
            pending.append(why)
            continue
        new.append(o)
    if new:
        path = os.path.join(sdir, f"short-outcomes-{C.utc_date(now)[:7]}.jsonl")
        C.append_bytes(path, "".join(json.dumps(C.clean(o), separators=(",", ":"), allow_nan=False) + "\n"
                                     for o in new).encode())
    allo = done + new
    return summarize_short(allo, rows, pending), new, pending
