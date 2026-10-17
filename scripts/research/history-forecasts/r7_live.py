#!/usr/bin/env python3
"""Q26 round 7 live helpers shared by both live logs (membrane-board design/Q26_ROUND7_PREREG.md @5568616).

R7.1 live traffic lights (both scorers; nothing refit):
- daily sums O_d (outcomes) and E_d (sum p) over resolved rows of a unit; z = sum(O_d - E_d) / sqrt(NW variance of
  (O_d - E_d)) with Bartlett lag ceil(T_h / 24) - 1;
- a light shows only when E >= 5 and the unit's resolved issue days >= 30 * ceil(T_h / 24), else "insufficient
  evidence"; bands green |z| < 2, amber 2 <= |z| < 3, red |z| >= 3;
- actions as output fields: amber -> label annotation "live: amber" and the weekly note lists it; red on two
  consecutive weekly evaluations -> STALE and a model review opens;
- comparison rows (BSS of the displayed rung vs plain history and vs the previous model) and an early warning from
  day 7 (running R with a moving-block bootstrap CI), both reported and deciding nothing.

R7.2 top-holder stress (depositor issuer, Aave V3 Core USDC only; reported, deciding nothing): S2 / S5 / S10 and the
class run-off shortfalls at the issue asof, and hours until cash >= 0 from the frozen refill-speed file
(r7_refill.py). Holders are ranked only; no address enters the block.
"""
import json
import math
import zlib
from datetime import datetime, timezone

import numpy as np

PREREG_R7 = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND7_PREREG.md", "commit": "5568616"}

Z_AMBER, Z_RED = 2.0, 3.0
MIN_E = 5.0
DAYS_PER_HORIZON_DAY = 30
EARLY_DAYS = 7
BOOT_B = 1000
BOOT_SEED = 20261017
BANDS = ("green", "amber", "red")
INSUFFICIENT = "insufficient evidence"
AMBER_LABEL = "live: amber"
STALE_LABEL = "STALE"
WEEKLY_FILE = "traffic-weekly.jsonl"
WEEKLY_SCHEMA = "q26-live/traffic-weekly/1"

DECISIONS_R7 = [
    "R7-1 statistic: rows are grouped by issue date; d_t = O_d - E_d is placed on the calendar-day grid from the "
    "unit's first to its last resolved issue day, a day without a resolved row contributing d = 0 (so the NW lag is "
    "in calendar days). NW variance = sum_t d_t^2 + 2 sum_{l=1..L} (1 - l / (L + 1)) sum_t d_t d_{t-l}, uncentred "
    "(E[d] = 0 under calibration; a score-type test), L = ceil(T_h / 24) - 1. A variance <= 0 shows no light.",
    "R7-2 evidence: E = sum of p over the unit's resolved rows; resolved issue days = distinct issue dates with a "
    "resolved row in the unit.",
    "R7-3 actions: a light with |z| >= 2 (amber, and red that is not yet STALE) carries the annotation 'live: amber' "
    "and is listed in weeklyNote (red is a stronger amber; the registered red action is the STALE rule only). A unit "
    "is STALE when its band was red in two consecutive weekly evaluations; STALE latches (staleSince = the second "
    "red evaluation) until a preregistered fix, and its annotation is 'STALE' with modelReview = true.",
    "R7-4 weekly evaluation = the first scorer run on a UTC Monday. It appends one line per Monday to "
    "scores/traffic-weekly.jsonl (append-only; a later run on the same Monday writes nothing). 'Consecutive' means "
    "consecutive recorded evaluations: a Monday without a scorer run is not an evaluation. Units without a light "
    "count as not red.",
    "R7-5 early warning (from 7 resolved issue days in the unit, deciding nothing): R = sum p / sum y over the unit's "
    "resolved rows; 95% CI from a circular moving-block bootstrap of the calendar-day (O_d, E_d) series, block "
    "length ceil(T_h / 24) days, 1000 resamples, numpy default_rng([20261017, crc32(unit key)]) (deterministic per "
    "unit); lower = 2.5% quantile (method 'lower'), upper = 97.5% quantile (method 'higher'); a resample with sum y "
    "= 0 < sum p is R = inf.",
    "R7-6 comparison rows: BSS = 1 - Brier(displayed) / Brier(reference) on the unit's resolved rows that carry both "
    "p values; reported only, never deciding.",
    "R7-7 change date: from the first scorer run of this code the L.5 / DL.6 live STALE no longer decides "
    "(liveStale stays reported, staleRule names the R7.1 rule). The L.5 / DL.6 live checks stay reported unchanged.",
]


# ---------------------------------------------------------------------------------------------
# R7.1 statistics
# ---------------------------------------------------------------------------------------------
def horizon_days(T_h):
    return int(math.ceil(float(T_h) / 24.0))


def nw_lag(T_h):
    return horizon_days(T_h) - 1


def min_days(T_h):
    return DAYS_PER_HORIZON_DAY * horizon_days(T_h)


def day_ordinal(d):
    return datetime.strptime(d, "%Y-%m-%d").toordinal()


def daily_series(dates, y, p):
    """Calendar-day grid from the first to the last date: (ordinals, O_d, E_d, has_row)."""
    o = np.array([day_ordinal(d) for d in dates], int)
    y = np.asarray(y, float)
    p = np.asarray(p, float)
    lo, hi = int(o.min()), int(o.max())
    n = hi - lo + 1
    O = np.zeros(n)
    E = np.zeros(n)
    has = np.zeros(n, bool)
    np.add.at(O, o - lo, y)
    np.add.at(E, o - lo, p)
    has[o - lo] = True
    return np.arange(lo, hi + 1), O, E, has


def nw_variance(d, lag):
    """Uncentred Newey-West (Bartlett) long-run variance of the sum of d."""
    d = np.asarray(d, float)
    v = float(np.dot(d, d))
    for l in range(1, min(int(lag), len(d) - 1) + 1):
        v += 2.0 * (1.0 - l / (lag + 1.0)) * float(np.dot(d[l:], d[:-l]))
    return v


def _dot_last(a, b):
    return np.einsum("...i,...i->...", a, b)


def bartlett_variance(d, lag):
    """nw_variance along the last axis (arrays of runs x days; used by the R8.1 fallback and the go-live gate)."""
    d = np.asarray(d, float)
    v = _dot_last(d, d)
    for l in range(1, min(int(lag), d.shape[-1] - 1) + 1):
        v = v + 2.0 * (1.0 - l / (lag + 1.0)) * _dot_last(d[..., l:], d[..., :-l])
    return v


def hh_variance(d, lag):
    """R8.1 Hansen-Hodrick truncated (uniform-weight) long-run variance of the sum of d, uncentred, along the last
    axis: sum_t d_t^2 + 2 sum_{l=1..L} sum_t d_t d_{t-l}. Can be <= 0 (no positive-definiteness guarantee)."""
    d = np.asarray(d, float)
    v = _dot_last(d, d)
    for l in range(1, min(int(lag), d.shape[-1] - 1) + 1):
        v = v + 2.0 * _dot_last(d[..., l:], d[..., :-l])
    return v


def lr_variance_v2(d, lag):
    """R8.1 variance: Hansen-Hodrick at lag L; where that is <= 0, the R7.1 Bartlett variance at the same lag.
    Returns (variance, fellBack) with the shape of d without its last axis."""
    hh = hh_variance(d, lag)
    fb = np.asarray(hh) <= 0
    if np.any(fb):
        v = np.where(fb, bartlett_variance(d, lag), hh)
    else:
        v = hh
    if np.ndim(v) == 0:
        return float(v), bool(fb)
    return v, fb


def band_of(z):
    if z is None:
        return INSUFFICIENT
    a = abs(z)
    return "red" if a >= Z_RED else ("amber" if a >= Z_AMBER else "green")


def ratio(sp, sy):
    if sy > 0:
        return sp / sy
    return "inf" if sp > 0 else None


def bss(p, y, pref):
    p, y, pref = (np.asarray(v, float) for v in (p, y, pref))
    if not len(p):
        return None
    b, br = float(np.mean((p - y) ** 2)), float(np.mean((pref - y) ** 2))
    return {"n": int(len(p)), "brier": b, "brier_ref": br, "bss": (1.0 - b / br) if br > 0 else None}


def boot_ci(O, E, T_h, key, B=BOOT_B):
    n = len(O)
    b = max(1, horizon_days(T_h))
    rng = np.random.default_rng([BOOT_SEED, zlib.crc32(key.encode())])
    nb = int(math.ceil(n / b))
    starts = rng.integers(0, n, size=(B, nb))
    idx = (starts[:, :, None] + np.arange(b)[None, None, :]).reshape(B, -1)[:, :n] % n
    so, se = O[idx].sum(1), E[idx].sum(1)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(so > 0, se / np.where(so > 0, so, 1.0), np.where(se > 0, np.inf, np.nan))
    r = r[~np.isnan(r)]
    if not len(r):
        return None, None
    lo = float(np.quantile(r, 0.025, method="lower"))
    hi = float(np.quantile(r, 0.975, method="higher"))
    return (lo if math.isfinite(lo) else "inf"), (hi if math.isfinite(hi) else "inf")


def light(key, dates, y, p, T_h, refs=None, rung=None):
    """One traffic light. refs = {name: array of reference p (nan where absent)} for the comparison rows."""
    dates = list(dates)
    y = np.asarray(y, float)
    p = np.asarray(p, float)
    out = {"rung": rung, "T_h": int(T_h), "lag": nw_lag(T_h), "minDays": min_days(T_h), "minE": MIN_E}
    if not len(dates):
        out.update(band=INSUFFICIENT, z=None, n=0, nDays=0, O=0.0, E=0.0, evidence=False)
        return out
    _, O, E, has = daily_series(dates, y, p)
    nd = int(has.sum())
    d = O - E
    v = nw_variance(d, nw_lag(T_h))
    so, se = float(O.sum()), float(E.sum())
    z = (so - se) / math.sqrt(v) if v > 0 else None
    evidence = bool(se >= MIN_E and nd >= min_days(T_h) and z is not None)
    out.update(n=int(len(dates)), nDays=nd, O=so, E=se, nwVar=v, zRaw=z, evidence=evidence,
               z=z if evidence else None, band=band_of(z) if evidence else INSUFFICIENT,
               firstDay=min(dates), lastDay=max(dates))
    if nd >= EARLY_DAYS:
        lo, hi = boot_ci(O, E, T_h, key)
        out["earlyWarning"] = {"R": ratio(se, so), "ci95": [lo, hi], "blockDays": max(1, horizon_days(T_h)),
                               "B": BOOT_B, "decides": False}
    if refs:
        comp = {}
        for name, pr in refs.items():
            pr = np.asarray(pr, float)
            m = np.isfinite(pr) & np.isfinite(p)
            comp[name] = bss(p[m], y[m], pr[m]) if m.any() else None
        out["comparison"] = dict(comp, decides=False)
    return out


# ---------------------------------------------------------------------------------------------
# Weekly evaluation, STALE latch and actions
# ---------------------------------------------------------------------------------------------
def utc_date(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")


def is_monday(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).weekday() == 0


def read_weekly(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                if line.strip():
                    out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out


def weekly_record(now, lights, code_commit=None):
    return {"schema": WEEKLY_SCHEMA, "date": utc_date(now), "computedAt": int(now),
            "code": code_commit, "bands": {k: v["band"] for k, v in sorted(lights.items())},
            "z": {k: v.get("z") for k, v in sorted(lights.items()) if v.get("z") is not None}}


def weekly_due(records, now):
    """True on a UTC Monday with no record dated that day yet (R7-4)."""
    return is_monday(now) and not any(r["date"] == utc_date(now) for r in records)


def stale_state(records):
    """Per unit key: STALE after red in two consecutive recorded weekly evaluations; latched (R7-3, R7-4)."""
    recs = sorted(records, key=lambda r: (r["date"], r["computedAt"]))
    keys = sorted({k for r in recs for k in r["bands"]})
    out = {}
    for k in keys:
        prev_red, since, run = False, None, 0
        for r in recs:
            red = r["bands"].get(k) == "red"
            run = run + 1 if red else 0
            if red and prev_red and since is None:
                since = r["date"]
            prev_red = red
        out[k] = {"stale": since is not None, "staleSince": since, "consecutiveRed": run,
                  "lastWeekly": recs[-1]["date"] if recs else None,
                  "lastWeeklyBand": recs[-1]["bands"].get(k) if recs else None}
    return out


def apply_actions(lights, stale):
    """Adds the action fields to each light and returns the weekly-note list."""
    note = []
    for k, L in lights.items():
        st = stale.get(k, {"stale": False, "staleSince": None, "consecutiveRed": 0})
        L["stale"] = bool(st["stale"])
        L["staleSince"] = st["staleSince"]
        L["consecutiveWeeklyRed"] = st.get("consecutiveRed", 0)
        if L["stale"]:
            L["labelAnnotation"], L["modelReview"] = STALE_LABEL, True
        elif L["band"] in ("amber", "red"):
            L["labelAnnotation"], L["modelReview"] = AMBER_LABEL, False
        else:
            L["labelAnnotation"], L["modelReview"] = None, False
        L["weeklyNote"] = bool(L["stale"] or L["band"] in ("amber", "red"))
        if L["weeklyNote"]:
            note.append({"unit": k, "band": L["band"], "z": L.get("z"), "stale": L["stale"],
                         "annotation": L["labelAnnotation"]})
    return note


def run_weekly(path, lights, now, code_commit=None, append=None):
    """Append the weekly record when due, then the STALE state from every record. Returns (state, appended?)."""
    recs = read_weekly(path)
    appended = False
    if weekly_due(recs, now):
        rec = weekly_record(now, lights, code_commit)
        line = (json.dumps(rec, separators=(",", ":"), sort_keys=True, allow_nan=False) + "\n").encode()
        if append is None:
            import os
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "ab") as f:
                f.write(line)
        else:
            append(path, line)
        recs.append(rec)
        appended = True
    return stale_state(recs), appended, recs


def traffic_block(lights, stale_path, now, code_commit=None, append=None, write=True):
    """Full R7.1 output: lights (with actions), weekly note, weekly record status."""
    if write:
        st, appended, recs = run_weekly(stale_path, lights, now, code_commit, append)
    else:
        recs = read_weekly(stale_path)
        st, appended = stale_state(recs), False
    note = apply_actions(lights, st)
    counts = {b: sum(1 for L in lights.values() if L["band"] == b) for b in BANDS + (INSUFFICIENT,)}
    return {"prereg": PREREG_R7, "lights": lights, "bandCounts": counts,
            "staleUnits": sorted(k for k, L in lights.items() if L["stale"]),
            "weeklyNote": note, "weeklyEvaluation": {"file": "scores/" + WEEKLY_FILE, "appendedThisRun": appended,
                                                     "nEvaluations": len(recs),
                                                     "dates": [r["date"] for r in recs][-8:]},
            "decisionsR7": DECISIONS_R7}


STALE_RULE = {"deciding": "R7.1 traffic lights (trafficLights; STALE after red on two consecutive weekly "
                          "evaluations)",
              "liveStale": "reported only from the R7.1 change date (Q26_ROUND7_PREREG.md R7.1)",
              "liveCheck": "reported unchanged"}


# ---------------------------------------------------------------------------------------------
# R7.2 top-holder stress (USDC)
# ---------------------------------------------------------------------------------------------
RUNOFF_CLASSES = (("wallet $1-10M", False, 1_000_000, 10_000_000, 0.10),
                  ("wallet $10-50M", False, 10_000_000, 50_000_000, 0.25),
                  ("wallet >= $50M", False, 50_000_000, None, 0.40),
                  ("contract", True, 0, None, 1.00))
TOP_K = (2, 5, 10)
REFILL_HOURS = (3, 24, 72)
MICRO = 10 ** 6

DECISIONS_R72 = [
    "R7.2-1 holders = the issue's USDC units (balanceOf >= $1M at the asof block, any anchor status), ranked by "
    "balanceOf; 1 USDC = $1 (raw / 1e6). Cash = USDC balanceOf(aUSDC) and supply = aUSDC totalSupply(), both at the "
    "asof block (the issue's reserveState.asof). Shortfall = withdrawal - cash (negative = cash left); share = "
    "shortfall / supply.",
    "R7.2-2 class run-off: holder type is the unit's issued contract flag; wallets by balanceOf: [$1M, $10M) 10%, "
    "[$10M, $50M) 25%, >= $50M 40%; contracts 100% of any size. Holders below $1M are outside the universe and "
    "withdraw nothing.",
    "R7.2-3 hours until cash >= 0: refill(h) = beta(h) * withdrawal, with beta from the frozen refill file at 3, 24, "
    "72 h and beta(0) = 0, linear between knots (each knot's beta floored at 0, cumulative max over h); the first h "
    "with refill(h) >= shortfall. A shortfall <= 0 gives 0; not reached by 72 h gives null with reachedBy72h = false. "
    "The intercept (baseline repayments) is not credited.",
]


def stress_block(units, cash_raw, supply_raw, refill, reserve="USDC"):
    """units = [(balance_raw, is_contract)] of the reserve at asof. Pure function of asof inputs and the frozen
    refill betas; no address enters (the caller passes none)."""
    bals = sorted(((int(b), int(c)) for b, c in units), key=lambda t: -t[0])
    cash = int(cash_raw) / MICRO
    supply = int(supply_raw) / MICRO
    betas = refill["beta"] if refill else None

    def hours_to_cover(shortfall, withdrawal):
        if shortfall <= 0:
            return 0.0, True
        if betas is None:
            return None, None
        hs = [0] + list(REFILL_HOURS)
        bs, m = [0.0], 0.0
        for h in REFILL_HOURS:
            m = max(m, max(0.0, float(betas[f"{h}h"])))
            bs.append(m)
        need = shortfall / withdrawal if withdrawal > 0 else math.inf
        for i in range(1, len(hs)):
            if bs[i] >= need:
                b0, b1 = bs[i - 1], bs[i]
                h = hs[i - 1] + (hs[i] - hs[i - 1]) * ((need - b0) / (b1 - b0) if b1 > b0 else 1.0)
                return float(h), True
        return None, False

    def scen(name, w):
        sf = w - cash
        h, ok = hours_to_cover(sf, w)
        return {"scenario": name, "withdrawalUSD": w, "shortfallUSD": sf,
                "shortfallShareOfSupply": sf / supply if supply > 0 else None,
                "withdrawalShareOfSupply": w / supply if supply > 0 else None,
                "hoursUntilCashNonNegative": h, "reachedBy72h": ok}
    out = {"reserve": reserve, "cashUSD": cash, "supplyUSD": supply, "nHolders": len(bals),
           "topHolders": [], "scenarios": []}
    for k in TOP_K:
        top = bals[:k]
        w = sum(b for b, _ in top) / MICRO
        s = scen(f"S{k}", w)
        s["ranks"] = list(range(1, len(top) + 1))
        s["nContracts"] = sum(c for _, c in top)
        out["scenarios"].append(s)
    classes = []
    w_tot = 0.0
    for name, is_c, lo, hi, rate in RUNOFF_CLASSES:
        sel = [b / MICRO for b, c in bals if bool(c) == is_c and (is_c or (b / MICRO >= lo and (hi is None or
                                                                                               b / MICRO < hi)))]
        w = rate * sum(sel)
        w_tot += w
        classes.append({"class": name, "rate": rate, "nHolders": len(sel), "balanceUSD": sum(sel),
                        "withdrawalUSD": w})
    s = scen("class run-off", w_tot)
    s["classes"] = classes
    out["scenarios"].append(s)
    out["topHolders"] = [{"rank": i + 1, "balanceUSD": b / MICRO, "isContract": c,
                          "shareOfSupply": (b / MICRO) / supply if supply > 0 else None}
                         for i, (b, c) in enumerate(bals[:max(TOP_K)])]
    out["refill"] = ({"beta": {f"{h}h": float(betas[f"{h}h"]) for h in REFILL_HOURS},
                      "file": refill.get("_file"), "sha256": refill.get("_sha256")} if refill else None)
    out["decides"] = False
    out["decisionsR72"] = DECISIONS_R72
    return out
