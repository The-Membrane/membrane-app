#!/usr/bin/env python3
"""Q26 round 8 R8.1 go-live gate (membrane-board design/Q26_ROUND8_PREREG.md @91a3eba).

Registered: "before going live, a simulation of calibrated forecasts with overlapping windows at every live horizon
must give |z| >= 2 in 3-7% of runs (nominal about 5%). Otherwise this item stops and is reported."

The z is the production statistic: r7_live.lr_variance_v2 (Hansen-Hodrick at L = ceil(T_h / 24) - 1, Bartlett
fallback where that is <= 0) on the calendar-day series d_t = O_d - E_d. The R7.1 Bartlett z is reported beside it.

  python3 scripts/research/history-forecasts/r8_gate.py --out gate-r81.json [--runs 4000]

Readings (DECISIONS_GATE) are fixed here before the first run; the verdict is the 'gate' block of the output.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time

import numpy as np
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r7_live as R7  # noqa: E402

PREREG_R8 = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND8_PREREG.md", "commit": "91a3eba"}
PREREG_R8B = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND8_PREREG.md", "commit": "c090fb1",
              "section": "D1 R8.1b"}
SEED = 20261018
SEED_R8B = 20261019
SEED_R8C = 20261020
PREREG_R8C = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND8_PREREG.md", "section": "D3 R8.1c"}
GATE_WINDOWS_R8B = (20, 30)
REPORT_WINDOWS_R8B = (20, 30, 90)
RATE_LO, RATE_HI = 0.03, 0.07
GATE_WINDOWS = (10, 30)              # provisional and full minimum evidence (R8.1)
REPORT_WINDOWS = (10, 30, 90)
DEP_HORIZONS_H = (1, 6, 24, 48, 168)
TOUCH_HORIZONS_H = (6, 24, 72, 168, 336, 720)
ETH_LADDER = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.25, -0.30, -0.40)
TOUCH_SINGLE = (-0.02, -0.05, -0.10, -0.20)
TOUCH_SIGMA_H = (0.004, 0.008)
DEP_K = (1, 25)
DEP_PW = (0.05, 0.25)
REGIME_M = (0.5, 2.0)
REGIME_STAY = 0.97

DECISIONS_GATE = [
    "G1 grid: daily issue origins; a run holds exactly N * H issue days, H = ceil(T_h / 24), N in {10, 30, 90} "
    "independent windows (10 = provisional minimum, 30 = full minimum, 90 reported only). Every issue day has rows "
    "and every window resolves, so the day condition of the light always holds; a run counts only where E >= 5 "
    "(the light shows). Calibration is exact by construction: p is the true conditional probability at the origin.",
    "G2 deposit log (1h, 6h, 24h, 48h, 7d), daily-event model: K rows per day (K = 1, or K = 25 rows with hazard "
    "weights geomspace(0.25, 4) / mean); row j has a daily event with probability lam_js = min(0.95, lam0 * w_j * "
    "m_s), lam0 = 1 - (1 - pw)^(1/H), pw in {0.05, 0.25}; m_s = 1 (constant) or a two-state Markov multiplier "
    "{0.5, 2.0} with daily stay probability 0.97, started from its stationary law and known to the forecaster. "
    "Rows are independent or comonotone (one uniform per day shared by all rows; nested events, the strongest "
    "within-day dependence). y = any event in the window's H days; p = 1 - prod(1 - lam). Sub-day horizons have "
    "H = 1 (no overlap at daily cadence), so 1h / 6h / 24h share the structure and differ only in seed.",
    "G3 touch log (6h, 1d, 3d, 7d, 14d, 30d), path model: hourly Gaussian log returns with sigma in {0.004, 0.008} "
    "per hour, continuous-path minimum inside each hour drawn exactly from the Brownian-bridge law, so p = 2 * "
    "Phi(ln(1 + k) / (sigma * sqrt(T))) is exact (zero drift); origins every 24 h; window (t, t + T]. Units: single "
    "levels -2%, -5%, -10%, -20% and the pooled ETH ladder (10 levels, all rows of a day summed).",
    "G4 statistic: d_t = O_d - E_d per issue day; z = sum d / sqrt(r7_live.lr_variance_v2(d, L)), L = ceil(T_h / 24) "
    "- 1 (the production function); the R7.1 Bartlett z on the same d is reported beside. Rates: share of shown runs "
    "with |z| >= 2 (and >= 3, reported).",
    "G5 verdict: per (log, horizon, N) the rate pools every shown run over that horizon's design points. The gate "
    "PASSES iff every (log, horizon) rate at N = 10 and at N = 30 lies in [3%, 7%] (inclusive). N = 90 and the per "
    "design-point rates are reported and decide nothing. Runs per design point: 4000; seeds numpy "
    "default_rng([20261018, log, T_h, N, point]).",
]

DECISIONS_GATE_R8B = [
    "G1b-G5b (--rule r8b, Q26_ROUND8_PREREG.md D1 R8.1b @c090fb1): the simulator, design points, statistic (HH, "
    "Bartlett fallback) and 4000 runs per point are G1-G4 unchanged; seeds default_rng([20261019, log, T_h, N, "
    "point]); N in {20, 30} gated, 90 reported. A run shows a light iff r7_live.evidence_tier_v2(E, O, N) is full "
    "(E >= 20, O + E >= 30, N >= 30) or provisional (E >= 10, N >= 20); O = sum d + E. Rates are over runs with a "
    "light (either tier; per-tier rates reported); a run without a light is 'no light', not a failure, and the share "
    "of runs with a light is reported. Verdict: PASS iff every (log, horizon, N in {20, 30}) with at least one light "
    "has a rate in [3%, 7%]; a cell with no light at all is reported as 'no light' and does not fail.",
]

DECISIONS_GATE_R8C = [
    "G1c-G5c (--rule r8c, Q26_ROUND8_PREREG.md D3 R8.1c): as G1b-G5b except seeds default_rng([20261020, log, T_h, N, "
    "point]) and the light rule r7_live.evidence_tier_v3(ED, N): full iff ED >= 20 and N >= 30, provisional iff ED >= "
    "10 and N >= 20. ED = sum over issue days of 1 - prod_i (1 - p_di) from the forecasts (deposit: over the K rows "
    "of the day; touch: n * p for a single level, n * (1 - prod_k (1 - p_k)) over the pooled ladder's 10 levels, the "
    "registered formula applied to nested levels as written).",
]


def dep_point_runs(H, N, K, pw, regime, comonotone, runs, rng, batch=500, with_ed=False):
    n = N * H
    ndays = n + H - 1
    lam0 = 1.0 - (1.0 - pw) ** (1.0 / H)
    w = np.geomspace(0.25, 4.0, K) if K > 1 else np.ones(1)
    w = w / w.mean()
    out_d, out_ed = [], []
    done = 0
    while done < runs:
        B = min(batch, runs - done)
        if regime:
            P = np.empty((B, ndays), bool)                 # True = high state
            P[:, 0] = rng.random(B) < 0.5
            flips = rng.random((B, ndays)) >= REGIME_STAY
            for s in range(1, ndays):
                P[:, s] = np.where(flips[:, s], ~P[:, s - 1], P[:, s - 1])
            m = np.where(P, REGIME_M[1], REGIME_M[0])
        else:
            m = np.ones((B, ndays))
        lam = np.minimum(0.95, lam0 * w[None, :, None] * m[:, None, :])        # (B, K, ndays)
        if comonotone:
            U = rng.random((B, 1, ndays))
        else:
            U = rng.random((B, K, ndays))
        ev = (U < lam).astype(np.int32)
        cs = np.concatenate([np.zeros((B, K, 1), np.int32), np.cumsum(ev, axis=2)], axis=2)
        y = (cs[:, :, H:H + n] - cs[:, :, :n]) > 0
        ll = np.concatenate([np.zeros((B, K, 1)), np.cumsum(np.log1p(-lam), axis=2)], axis=2)
        p = 1.0 - np.exp(ll[:, :, H:H + n] - ll[:, :, :n])
        ed = (1.0 - np.exp(np.log1p(-np.minimum(p, 1.0)).sum(1))).sum(1)              # R8.1c event-days
        out_d.append(np.stack([(y - p).sum(1), p.sum(1)], axis=0))
        out_ed.append(ed)
        done += B
    a = np.concatenate(out_d, axis=1)
    if with_ed:
        return a[0], a[1].sum(1), np.concatenate(out_ed)   # d (runs, n), E (runs,), ED (runs,)
    return a[0], a[1].sum(1)                               # d (runs, n), E (runs,)


def touch_point_runs(T, N, sigma, runs, rng, batch=None, with_ed=False):
    """Returns {unit: (d (runs, n), E (runs,))} for the single levels and the pooled ladder; with_ed adds ED (runs,)
    (R8.1c event-days: n * p for a single level, n * (1 - prod_k (1 - p_k)) for the pooled ladder)."""
    H = int(math.ceil(T / 24.0))
    n = N * H
    hours = 24 * (n - 1) + T
    if batch is None:
        batch = max(8, min(500, int(2.5e7 // max(1, n * T))))
    levels = sorted(set(ETH_LADDER) | set(TOUCH_SINGLE))
    b = np.log1p(np.array(levels))
    p_k = 2.0 * ndtr(b / (sigma * math.sqrt(T)))
    acc = {k: ([], []) for k in list(TOUCH_SINGLE) + ["pooled"]}
    done = 0
    while done < runs:
        B = min(batch, runs - done)
        dx = rng.normal(0.0, sigma, (B, hours))
        U = rng.random((B, hours))
        X = np.concatenate([np.zeros((B, 1)), np.cumsum(dx, axis=1)], axis=1)
        mstep = X[:, :-1] + 0.5 * (dx - np.sqrt(dx * dx - 2.0 * sigma * sigma * np.log(U)))
        win = np.lib.stride_tricks.sliding_window_view(mstep, T, axis=1)[:, ::24][:, :n]
        wmin = win.min(axis=2) - X[:, 0:24 * n:24]                              # (B, n)
        y = wmin[:, :, None] <= b[None, None, :]                               # (B, n, L)
        dk = y - p_k[None, None, :]
        for k in TOUCH_SINGLE:
            i = levels.index(k)
            acc[k][0].append(dk[:, :, i])
            acc[k][1].append(np.full(B, n * p_k[i]))
        lad = [levels.index(k) for k in ETH_LADDER]
        acc["pooled"][0].append(dk[:, :, lad].sum(2))
        acc["pooled"][1].append(np.full(B, n * p_k[lad].sum()))
        done += B
    out = {k: (np.concatenate(v[0]), np.concatenate(v[1])) for k, v in acc.items()}
    if with_ed:
        lad = [levels.index(k) for k in ETH_LADDER]
        for k in list(out):
            if k == "pooled":
                ed = n * (1.0 - np.prod(1.0 - p_k[lad]))
            else:
                ed = n * p_k[levels.index(k)]
            out[k] = out[k] + (np.full(len(out[k][1]), ed),)
    return out


def rates(d, E, T_h, rule="r81", N=None, ED=None):
    L = R7.nw_lag(T_h)
    v2, fb = R7.lr_variance_v2(d, L)
    vb = R7.bartlett_variance(d, L)
    s = d.sum(1)
    if rule == "r8b":
        tier = R7.evidence_tier_v2(E, s + E, np.full(len(E), N))
        show = tier > 0
    elif rule == "r8c":
        tier = R7.evidence_tier_v3(ED, np.full(len(E), N))
        show = tier > 0
    else:
        tier = None
        show = E >= R7.MIN_E
    with np.errstate(divide="ignore", invalid="ignore"):
        z2 = np.where(v2 > 0, s / np.sqrt(np.where(v2 > 0, v2, 1.0)), np.nan)
        zb = np.where(vb > 0, s / np.sqrt(np.where(vb > 0, vb, 1.0)), np.nan)
    show = show & np.isfinite(z2)
    ns = int(show.sum())
    extra = {}
    if tier is not None:
        for name, c in (("Full", 2), ("Prov", 1)):
            m = show & (tier == c)
            extra["shown" + name] = int(m.sum())
            extra["hit2" + name] = int((np.abs(z2[m]) >= 2).sum())
    return {**extra, "runs": int(len(E)), "shown": ns,
            "hit2": int((np.abs(z2[show]) >= 2).sum()), "hit3": int((np.abs(z2[show]) >= 3).sum()),
            "hit2Bartlett": int((np.abs(zb[show]) >= 2).sum()), "fallback": int(np.asarray(fb)[show].sum()),
            "meanE": float(E[show].mean()) if ns else None}


def finish(r):
    ns = r["shown"]
    r["lightShare"] = ns / r["runs"] if r["runs"] else None
    for name in ("Full", "Prov"):
        if r.get("shown" + name):
            r["rate2" + name] = r["hit2" + name] / r["shown" + name]
    if ns:
        r["rate2"] = r["hit2"] / ns
        r["rate3"] = r["hit3"] / ns
        r["rate2Bartlett"] = r["hit2Bartlett"] / ns
        r["fallbackShare"] = r["fallback"] / ns
        r["se2"] = math.sqrt(r["rate2"] * (1 - r["rate2"]) / ns)
    return r


def add(tot, r):
    for k in ("runs", "shown", "hit2", "hit3", "hit2Bartlett", "fallback", "shownFull", "hit2Full", "shownProv",
              "hit2Prov"):
        if k in r:
            tot[k] = tot.get(k, 0) + r[k]


def run(runs, log=print, windows=REPORT_WINDOWS, dep_h=DEP_HORIZONS_H, touch_h=TOUCH_HORIZONS_H, rule="r81"):
    seed = {"r8b": SEED_R8B, "r8c": SEED_R8C}.get(rule, SEED)
    wed = rule == "r8c"
    res = {"deposit": {}, "touch": {}}
    for li, (logname, hs) in enumerate((("deposit", dep_h), ("touch", touch_h))):
        for T in hs:
            H = R7.horizon_days(T)
            for N in windows:
                points, tot = [], {}
                if logname == "deposit":
                    pi = 0
                    for K in DEP_K:
                        for pw in DEP_PW:
                            for regime in (False, True):
                                for como in ((False,) if K == 1 else (False, True)):
                                    rng = np.random.default_rng([seed, li, T, N, pi])
                                    o = dep_point_runs(H, N, K, pw, regime, como, runs, rng, with_ed=wed)
                                    r = rates(o[0], o[1], T, rule, N, o[2] if wed else None)
                                    add(tot, r)
                                    points.append(finish(dict(r, K=K, pw=pw, regime=regime, comonotone=como)))
                                    pi += 1
                else:
                    for pi, sig in enumerate(TOUCH_SIGMA_H):
                        rng = np.random.default_rng([seed, li, T, N, pi])
                        units = touch_point_runs(T, N, sig, runs, rng, with_ed=wed)
                        for k, o in units.items():
                            r = rates(o[0], o[1], T, rule, N, o[2] if wed else None)
                            add(tot, r)
                            points.append(finish(dict(r, sigmaPerHour=sig, unit=k if k == "pooled" else float(k))))
                tot = finish(tot)
                tot["designPoints"] = points
                tot["H"], tot["lag"], tot["issueDays"] = H, R7.nw_lag(T), N * H
                shown_rates = [p["rate2"] for p in points if p["shown"] >= 200]
                tot["pointRate2Range"] = [min(shown_rates), max(shown_rates)] if shown_rates else None
                res[logname].setdefault(f"{T}h", {})[str(N)] = tot
                log(f"{logname:7s} T={T:4d}h N={N:3d}: shown {tot['shown']:6d}/{tot['runs']:6d}  |z|>=2 HH {tot.get('rate2', float('nan')):.4f}"
                    f"  Bartlett {tot.get('rate2Bartlett', float('nan')):.4f}  fallback {tot.get('fallbackShare', float('nan')):.4f}")
    return res


def verdict(res, windows=GATE_WINDOWS, rule="r81"):
    rows, ok = [], True
    for logname, byh in res.items():
        for th, byn in byh.items():
            for N in windows:
                r = byn.get(str(N))
                if r is None:
                    continue
                rate = r.get("rate2")
                if rule in ("r8b", "r8c") and rate is None:
                    rows.append({"log": logname, "T": th, "N": N, "rate2": None, "inBand": None, "noLight": True,
                                 "lightShare": r.get("lightShare")})
                    continue
                inside = rate is not None and RATE_LO <= rate <= RATE_HI
                ok = ok and inside
                rows.append({"log": logname, "T": th, "N": N, "rate2": rate, "inBand": inside,
                             "lightShare": r.get("lightShare")})
    return {"pass": bool(ok), "band": [RATE_LO, RATE_HI], "windows": list(windows), "rows": rows}


def git_head():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--runs", type=int, default=4000)
    ap.add_argument("--rule", choices=("r81", "r8b", "r8c"), default="r81")
    a = ap.parse_args()
    t0 = time.time()
    if a.rule == "r8c":
        res = run(a.runs, windows=REPORT_WINDOWS_R8B, rule="r8c")
        g = verdict(res, GATE_WINDOWS_R8B, rule="r8c")
        meta = {"schema": "q26-r8/gate-r81c/1", "prereg": PREREG_R8C,
                "decisions": DECISIONS_GATE + DECISIONS_GATE_R8C}
    elif a.rule == "r8b":
        res = run(a.runs, windows=REPORT_WINDOWS_R8B, rule="r8b")
        g = verdict(res, GATE_WINDOWS_R8B, rule="r8b")
        meta = {"schema": "q26-r8/gate-r81b/1", "prereg": PREREG_R8B, "decisions": DECISIONS_GATE + DECISIONS_GATE_R8B}
    else:
        res = run(a.runs)
        g = verdict(res)
        meta = {"schema": "q26-r8/gate-r81/1", "prereg": PREREG_R8, "decisions": DECISIONS_GATE}
    doc = {**meta, "code": {"commit": git_head(), "file": "r8_gate.py"}, "rule": a.rule,
           "runsPerPoint": a.runs, "gate": g, "results": res,
           "seconds": round(time.time() - t0, 1)}
    with open(a.out, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True, allow_nan=False)
    print("GATE", "PASS" if g["pass"] else "FAIL")
    for r in g["rows"]:
        rate = "no run shown" if r["rate2"] is None else f"{r['rate2']:.4f}"
        flag = "no light" if r.get("noLight") else ("ok" if r["inBand"] else "OUT")
        print(f"  {r['log']:7s} {r['T']:>5s} N={r['N']:3d} rate {rate} {flag} lightShare {r.get('lightShare')}")


if __name__ == "__main__":
    main()
