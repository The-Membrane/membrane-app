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
SEED = 20261018
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


def dep_point_runs(H, N, K, pw, regime, comonotone, runs, rng, batch=500):
    n = N * H
    ndays = n + H - 1
    lam0 = 1.0 - (1.0 - pw) ** (1.0 / H)
    w = np.geomspace(0.25, 4.0, K) if K > 1 else np.ones(1)
    w = w / w.mean()
    out_d = []
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
        out_d.append(np.stack([(y - p).sum(1), p.sum(1)], axis=0))
        done += B
    a = np.concatenate(out_d, axis=1)
    return a[0], a[1].sum(1)                               # d (runs, n), E (runs,)


def touch_point_runs(T, N, sigma, runs, rng, batch=None):
    """Returns {unit: (d (runs, n), E (runs,))} for the single levels and the pooled ladder."""
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
    return {k: (np.concatenate(v[0]), np.concatenate(v[1])) for k, v in acc.items()}


def rates(d, E, T_h):
    L = R7.nw_lag(T_h)
    v2, fb = R7.lr_variance_v2(d, L)
    vb = R7.bartlett_variance(d, L)
    s = d.sum(1)
    show = E >= R7.MIN_E
    with np.errstate(divide="ignore", invalid="ignore"):
        z2 = np.where(v2 > 0, s / np.sqrt(np.where(v2 > 0, v2, 1.0)), np.nan)
        zb = np.where(vb > 0, s / np.sqrt(np.where(vb > 0, vb, 1.0)), np.nan)
    show = show & np.isfinite(z2)
    ns = int(show.sum())
    return {"runs": int(len(E)), "shown": ns,
            "hit2": int((np.abs(z2[show]) >= 2).sum()), "hit3": int((np.abs(z2[show]) >= 3).sum()),
            "hit2Bartlett": int((np.abs(zb[show]) >= 2).sum()), "fallback": int(np.asarray(fb)[show].sum()),
            "meanE": float(E[show].mean()) if ns else None}


def finish(r):
    ns = r["shown"]
    if ns:
        r["rate2"] = r["hit2"] / ns
        r["rate3"] = r["hit3"] / ns
        r["rate2Bartlett"] = r["hit2Bartlett"] / ns
        r["fallbackShare"] = r["fallback"] / ns
        r["se2"] = math.sqrt(r["rate2"] * (1 - r["rate2"]) / ns)
    return r


def add(tot, r):
    for k in ("runs", "shown", "hit2", "hit3", "hit2Bartlett", "fallback"):
        tot[k] = tot.get(k, 0) + r[k]


def run(runs, log=print, windows=REPORT_WINDOWS, dep_h=DEP_HORIZONS_H, touch_h=TOUCH_HORIZONS_H):
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
                                    rng = np.random.default_rng([SEED, li, T, N, pi])
                                    d, E = dep_point_runs(H, N, K, pw, regime, como, runs, rng)
                                    r = rates(d, E, T)
                                    add(tot, r)
                                    points.append(finish(dict(r, K=K, pw=pw, regime=regime, comonotone=como)))
                                    pi += 1
                else:
                    for pi, sig in enumerate(TOUCH_SIGMA_H):
                        rng = np.random.default_rng([SEED, li, T, N, pi])
                        units = touch_point_runs(T, N, sig, runs, rng)
                        for k, (d, E) in units.items():
                            r = rates(d, E, T)
                            add(tot, r)
                            points.append(finish(dict(r, sigmaPerHour=sig, unit=k if k == "pooled" else float(k))))
                tot = finish(tot)
                tot["designPoints"] = points
                tot["H"], tot["lag"], tot["issueDays"] = H, R7.nw_lag(T), N * H
                shown_rates = [p["rate2"] for p in points if p["shown"] >= 200]
                tot["pointRate2Range"] = [min(shown_rates), max(shown_rates)] if shown_rates else None
                res[logname].setdefault(f"{T}h", {})[str(N)] = tot
                log(f"{logname:7s} T={T:4d}h N={N:3d}: shown {tot['shown']:6d}  |z|>=2 HH {tot.get('rate2', float('nan')):.4f}"
                    f"  Bartlett {tot.get('rate2Bartlett', float('nan')):.4f}  fallback {tot.get('fallbackShare', float('nan')):.4f}")
    return res


def verdict(res, windows=GATE_WINDOWS):
    rows, ok = [], True
    for logname, byh in res.items():
        for th, byn in byh.items():
            for N in windows:
                r = byn.get(str(N))
                if r is None:
                    continue
                rate = r.get("rate2")
                inside = rate is not None and RATE_LO <= rate <= RATE_HI
                ok = ok and inside
                rows.append({"log": logname, "T": th, "N": N, "rate2": rate, "inBand": inside})
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
    a = ap.parse_args()
    t0 = time.time()
    res = run(a.runs)
    g = verdict(res)
    doc = {"schema": "q26-r8/gate-r81/1", "prereg": PREREG_R8, "code": {"commit": git_head(), "file": "r8_gate.py"},
           "runsPerPoint": a.runs, "decisions": DECISIONS_GATE, "gate": g, "results": res,
           "seconds": round(time.time() - t0, 1)}
    with open(a.out, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True, allow_nan=False)
    print("GATE", "PASS" if g["pass"] else "FAIL")
    for r in g["rows"]:
        print(f"  {r['log']:7s} {r['T']:>5s} N={r['N']:3d} rate {r['rate2']:.4f} {'ok' if r['inBand'] else 'OUT'}")


if __name__ == "__main__":
    main()
