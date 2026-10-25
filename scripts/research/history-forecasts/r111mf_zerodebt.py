#!/usr/bin/env python3
"""Q26 R11.1-mf item 1: zero-debt gate days in the R11.1 v3/v4/v5 gates (post hoc, published outputs only).

The v3/v4/v5 gates classify Y = real >= X, sim >= X, E = real(d-1) >= X with X = X_core * USDC debt / ref. On a day with
USDC total debt 0 the threshold is 0, so 0 >= 0 makes the day positive for Y, sim and E, but not for PD (drawdown).
This script reads only the published per-day outputs (membrane-datasets history-forecasts/r11/...), reproduces the
published classifier statistics with the gate code itself (r111v3_gate.classify, r111v4_gate.classify4), and recomputes
them with the zero-debt days removed from the scored set. E keeps the previous calendar day's real value (as coded).

Two values the published daily files do not hold: real volume on the day before the first gate day and on 2025-10-11
(an excluded day whose value feeds E on 2025-10-12). Both are resolved by matching the published E statistics; the
chosen resolution is written to the output. Nothing is re-simulated and no locked file is read.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import itertools
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_gate as G  # noqa: E402
import r111v4_gate as V  # noqa: E402

DS = os.environ.get("MEMBRANE_DATASETS_DIR", os.path.join(HERE, "..", "..", "..", "..", "membrane-datasets"))
R11 = os.path.join(DS, "history-forecasts", "r11")
BIG = 1e18

RUNS = {
    "v3-arbitrum-L1": {"daily": "r111v3-run-a34ba15b/r111v3-daily.csv", "results": "r111v3-run-a34ba15b/r111v3-results.json",
                       "frozen": "r111v3-run-a34ba15b/frozen-r111v3.json", "kind": "v3", "registered": "D-R11.1i (scored)"},
    "v4-polygon": {"daily": "r111v4-run-caf536f4/r111v4-daily.csv", "results": "r111v4-run-caf536f4/r111v4-results.json",
                   "frozen": "r111v4-run-caf536f4/pre-run/frozen-r111v4-poly.json", "kind": "v4",
                   "registered": "D-R11.1p (scored, FAIL on magnitude)"},
    "v5-polygon-dev": {"daily": "r111v5-0d6f31d9/dev/r111v5-poly-dev-daily.csv", "results": "r111v5-0d6f31d9/dev/r111v5-poly-dev.json",
                       "frozen": "r111v4-run-caf536f4/pre-run/frozen-r111v4-poly.json", "kind": "v4",
                       "registered": "D-R11.1v (development reading, priors frozen in v4)"},
    "v5-avalanche-blind": {"daily": "r111v5-0d6f31d9/blind-avax/r111v5-daily.csv",
                           "results": "r111v5-0d6f31d9/blind-avax/r111v5-results.json",
                           "frozen": "r111v5-0d6f31d9/blind-avax/pre-run/frozen-r111v5-avax.json", "kind": "v4",
                           "registered": "D-R11.1w (scored blind, PASS)"},
}
KEYS = ("positive_days", "H", "F", "J", "H_E", "F_E", "J_E", "H_PD", "F_PD", "J_PD", "bss_vs_clim", "bss_vs_E", "bss_vs_PD")


def load(name):
    r = RUNS[name]
    rows = list(csv.DictReader(open(os.path.join(R11, r["daily"]))))
    sim = {x["date"]: float(x["sim_usdc_usd"]) for x in rows}
    real = {x["date"]: float(x["real_usdc_usd"]) for x in rows}
    if "usdc_debt_usd" in rows[0]:
        debt = {x["date"]: float(x["usdc_debt_usd"]) for x in rows}
        scale = {d: v / G.REF_CORE_DEBT for d, v in debt.items()}
    else:
        debt = None
        scale = {x["date"]: float(x["scale"]) for x in rows}
    dd = {x["date"]: float(x["pd_drawdown"]) for x in rows if "pd_drawdown" in x}
    q2 = lambda d: G.Q2[0] <= dt.date.fromisoformat(d) <= G.Q2[1]  # noqa: E731
    days = [x["date"] for x in rows if x["gate_day"] == "1" and not q2(x["date"])]
    return rows, sim, real, debt, scale, dd, days


def classify(kind, days, sim, real, scale, dd, frozen):
    if kind == "v3":
        return G.classify(days, sim, real, scale, priors=frozen["priors"])
    return V.classify4(days, sim, real, scale, dd, frozen["x_pd"], priors=frozen["priors"])


def maxdiff(a, b):
    m = 0.0
    for X in a:
        for k in ("H", "F", "J", "H_E", "F_E", "J_E", "H_PD", "F_PD", "J_PD"):
            if k in b[X] and b[X][k] is not None:
                m = max(m, abs(a[X][k] - b[X][k]))
        m = max(m, abs(a[X]["positive_days"] - b[X]["positive_days"]))
    return m


def verdict(kind, cls, pooled):
    if kind == "v3":
        return G.verdict(cls, pooled)
    js = [v["J"] for v in cls.values()]
    jp = [v["J_PD"] for v in cls.values()]
    v = V.verdict4(cls, pooled, {"checks": {}, "pass": True})
    return {"checks": v["checks"], "reported_checks": v["reported_checks"], "classifier_pass": v["classifier_pass"],
            "mean_J": float(np.mean(js)), "mean_J_PD": float(np.mean(jp)),
            "mean_J_margin": float(np.mean(js) - np.mean(jp))}


def slim(cls, pooled):
    return {"classification": {X: {k: v.get(k) for k in KEYS if k in v} for X, v in cls.items()},
            "pooled_dm": {k: {kk: v[kk] for kk in ("mean_d", "t", "p_one_sided", "n")} for k, v in pooled.items()}}


def run(name):
    r = RUNS[name]
    rows, sim, real, debt, scale, dd, days = load(name)
    frozen = json.load(open(os.path.join(R11, r["frozen"])))
    pub = json.load(open(os.path.join(R11, r["results"])))
    first = dt.date.fromisoformat(rows[0]["date"])
    pre = (first - dt.timedelta(days=1)).isoformat()
    # Unpublished E inputs: try 0 or "large" (>= every threshold) and keep the combination that reproduces the
    # published statistics.
    best, nmatch = None, 0
    for vpre, v1011 in itertools.product((0.0, BIG), (0.0, BIG)):
        rr = dict(real)
        rr[pre] = vpre
        rr["2025-10-10"] = 0.0
        rr["2025-10-11"] = v1011
        cls, pooled = classify(r["kind"], days, sim, rr, scale, dd, frozen)
        md = maxdiff(cls, pub["classification"])
        nmatch += int(md < 1e-12)
        if best is None or md < best[0]:
            best = (md, vpre, v1011, rr, cls, pooled)
    md, vpre, v1011, rr, cls, pooled = best
    pdm = max(abs(pooled[k]["p_one_sided"] - pub["pooled_dm"][k]["p_one_sided"]) for k in pooled)
    zero = [d for d in days if scale[d] == 0.0]
    tiny = [d for d in days if 0.0 < scale[d] * G.THRESH_CORE[0] < G.DUST_DAY]
    zero_rows = [{"date": d, "real": real[d], "sim": sim[d], "pd_drawdown": dd.get(d),
                  "pd_class": (dd.get(d, 0.0) >= frozen["x_pd"]) if "x_pd" in frozen else None} for d in zero]
    keep = [d for d in days if d not in set(zero)]
    cls2, pooled2 = classify(r["kind"], keep, sim, rr, scale, dd, frozen)
    out = {"run": name, "registered_as": r["registered"], "daily_file": r["daily"], "gate_days": len(days),
           "reproduction": {"max_abs_diff_classification": md, "max_abs_diff_dm_p": pdm,
                            "unpublished_E_inputs_resolved": {"day_before_first": "0" if vpre == 0 else ">= every threshold",
                                                              "2025-10-11": "0" if v1011 == 0 else ">= every threshold",
                                                              "combinations_reproducing_exactly_of_4": nmatch}},
           "zero_debt_gate_days": zero_rows,
           "gate_days_with_threshold_below_1k_at_0p5M_nonzero_debt": len(tiny),
           "as_published": {**slim(cls, pooled), "verdict_classifier": verdict(r["kind"], cls, pooled)},
           "without_zero_debt_days": {"gate_days": len(keep), **slim(cls2, pooled2),
                                      "verdict_classifier": verdict(r["kind"], cls2, pooled2)}}
    out["classifier_verdict_changes"] = (out["as_published"]["verdict_classifier"]["classifier_pass"]
                                         if r["kind"] != "v3" else out["as_published"]["verdict_classifier"]["pass"]) != (
        out["without_zero_debt_days"]["verdict_classifier"]["classifier_pass"]
        if r["kind"] != "v3" else out["without_zero_debt_days"]["verdict_classifier"]["pass"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    res = {"item": "Q26 R11.1-mf item 1: zero-debt gate days (post hoc, published per-day outputs only)",
           "utc_created": G.utcnow(), "code_sha": G.git_sha()[0], "runs": [run(n) for n in RUNS],
           "not_affected": {"R11.1c v2 gate (D-R11.1c)": "absolute thresholds (small days real > 0 and <= $250k; zero days real = 0); no scaled X",
                            "v3 development on D (Core)": "Core USDC debt is never 0 on D"}}
    # Sensitivity: the Avalanche priors are the Polygon v5 development class frequencies (r111v5_power.priors_from),
    # which include Polygon's 2 zero-debt days. Recompute them without those days, check that the published priors
    # are reproduced with them, and rerun the Avalanche classifier with the corrected priors.
    import r111v5_power as P
    _, psim, preal, pdebt_d, _, pdd, pdays = load("v5-polygon-dev")
    fz = json.load(open(os.path.join(R11, RUNS["v5-avalanche-blind"]["frozen"])))
    pr_pub = P.priors_from(pdays, psim, preal, pdebt_d, pdd, fz["x_pd"])
    pdays0 = [d for d in pdays if pdebt_d[d] > 0]
    pr_fix = P.priors_from(pdays0, psim, preal, pdebt_d, pdd, fz["x_pd"])
    rep = max(abs(a_ - b_) for X in pr_pub for k in pr_pub[X] for a_, b_ in zip(np.atleast_1d(pr_pub[X][k]), np.atleast_1d(fz["priors"][X][k])))
    _, asim, areal, adebt, ascale, add_, adays = load("v5-avalanche-blind")
    areal = dict(areal)
    areal[(dt.date.fromisoformat(adays[0]) - dt.timedelta(days=1)).isoformat()] = 0.0
    areal["2025-10-10"] = areal["2025-10-11"] = 0.0
    sens = {}
    for lab, dl in (("all_gate_days", adays), ("without_zero_debt_days", [d for d in adays if ascale[d] > 0])):
        c, pp = V.classify4(dl, asim, areal, ascale, add_, fz["x_pd"], priors=pr_fix)
        sens[lab] = {**slim(c, pp), "verdict_classifier": verdict("v4", c, pp)}
    res["avalanche_priors_sensitivity"] = {
        "published_priors_reproduced_max_abs_diff": rep, "priors_without_polygon_zero_debt_days": pr_fix,
        "avalanche_with_corrected_priors": sens,
        "note": "priors affect only the Brier legs (online calibration), not H, F or J"}
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, "zero-debt-recheck.json"), res)
    for x in res["runs"]:
        a1, a2 = x["as_published"]["verdict_classifier"], x["without_zero_debt_days"]["verdict_classifier"]
        print(x["run"], "repro", x["reproduction"]["max_abs_diff_classification"], x["reproduction"]["max_abs_diff_dm_p"],
              x["reproduction"]["unpublished_E_inputs_resolved"], "zero", [z["date"] for z in x["zero_debt_gate_days"]],
              "tiny", x["gate_days_with_threshold_below_1k_at_0p5M_nonzero_debt"])
        for lab, s in (("pub", x["as_published"]), ("no0", x["without_zero_debt_days"])):
            c = s["classification"]
            print(" ", lab, {X: (v["positive_days"], round(v["H"], 3), round(v["J"], 3), round(v["J_E"], 3),
                                 None if v.get("J_PD") is None else round(v["J_PD"], 3)) for X, v in c.items()},
                  {k: "%.2g" % v["p_one_sided"] for k, v in s["pooled_dm"].items()},
                  {k: s["verdict_classifier"].get(k) for k in ("mean_J", "mean_J_PD", "classifier_pass", "pass")})
        print("  verdict changes:", x["classifier_verdict_changes"])
    sv = res["avalanche_priors_sensitivity"]
    print("priors repro", sv["published_priors_reproduced_max_abs_diff"])
    for k, v in sv["avalanche_with_corrected_priors"].items():
        print(" ", k, {kk: "%.2g" % vv["p_one_sided"] for kk, vv in v["pooled_dm"].items()},
              {kk: v["verdict_classifier"][kk] for kk in ("mean_J", "mean_J_PD", "classifier_pass")})


if __name__ == "__main__":
    main()
