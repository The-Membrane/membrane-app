"""Q26 R11.1-v5 blind-chain power (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1r, owner ruling 10).

Development analogue: the Polygon v5 development daily series (r111v5_gate.py devrun, r111v5-poly-dev-daily.csv).
Weekly moving-block bootstrap (block 7 days, B = 2,000, seed 20261024) of Polygon gate days, resampled to the blind
chain's gate-day count; per resample the registered composite (classifier + magnitude, D-R11.1l) with the blind-run
priors (the Polygon v5 development class frequencies). Two variants: plain, and thinned (each Polygon event day kept
with probability min(1, blind event-day share / Polygon event-day share), else sim and real set to 0).
Power = the smaller of the two. Resampled days are relabelled as a synthetic consecutive calendar (as the v4 power).

  python3 r111v5_power.py --dev DEVDIR --n-days N --event-share S --out OUT
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_gate as G  # noqa: E402
import r111v4_gate as V  # noqa: E402

B, SEED, L = 2000, 20261024, 7


def load(dev):
    rows = list(csv.DictReader(open(os.path.join(dev, "r111v5-poly-dev-daily.csv"))))
    days = [r["date"] for r in rows if r["gate_day"] == "1"]
    sim = {r["date"]: float(r["sim_usdc_usd"]) for r in rows}
    real = {r["date"]: float(r["real_usdc_usd"]) for r in rows}
    debt = {r["date"]: float(r["usdc_debt_usd"]) for r in rows}
    dd = {r["date"]: float(r["pd_drawdown"]) for r in rows}
    return days, sim, real, debt, dd


def priors_from(days, sim, real, debt, dd, x_pd):
    """Polygon v5 development class frequencies per threshold (classify4 with priors=None computes them)."""
    scale = {d: debt[d] / G.REF_CORE_DEBT for d in days}
    real_ = dict(real)
    c, _ = V.classify4(days, sim, real_, scale, dd, x_pd, priors=None)
    return {X: v["prior"] for X, v in c.items()}


def composite(days, sim, real, debt, dd, x_pd, pri):
    scale = {d: debt[d] / G.REF_CORE_DEBT for d in days}
    c, p = V.classify4(days, sim, real, scale, dd, x_pd, priors=pri)
    m = V.magnitude(days, sim, real, debt)
    return V.verdict4(c, p, m), m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", required=True)
    ap.add_argument("--frozen-v4", required=True)
    ap.add_argument("--n-days", type=int, required=True)
    ap.add_argument("--event-share", type=float, default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    x_pd = json.load(open(a.frozen_v4))["x_pd"]
    days, sim, real, debt, dd = load(a.dev)
    pri = priors_from(days, sim, real, debt, dd, x_pd)
    v0, m0 = composite(days, sim, real, debt, dd, x_pd, pri)
    pg_share = float(np.mean([real[d] > 0 for d in days]))
    keep_p = None if a.event_share is None else min(1.0, a.event_share / pg_share)
    n = a.n_days
    res = {"item": "Q26 R11.1-v5 blind-chain power from the Polygon v5 development series (D-R11.1r)",
           "polygon_gate_days": len(days), "polygon_event_day_share": pg_share, "blind_gate_days": n,
           "blind_event_day_share": a.event_share, "thinning_keep_prob": keep_p,
           "polygon_point": {"verdict": v0, "sim_over_real": m0["sim_over_real_total"]}, "priors_for_blind": pri,
           "variants": {}}
    for name in ("plain", "thinned"):
        if name == "thinned" and keep_p is None:
            continue
        rng = np.random.default_rng(SEED)
        hold, cls_hold, mag_hold = 0, 0, 0
        per = {}
        for b in range(B):
            starts = rng.integers(0, len(days) - L + 1, size=n // L + 1)
            idx = np.concatenate([np.arange(s, s + L) for s in starts])[:n]
            base = dt.date(2000, 1, 1)
            bd = [(base + dt.timedelta(days=i + 1)).isoformat() for i in range(n)]
            src = [days[i] for i in idx]
            kill = (rng.random(n) >= keep_p) if name == "thinned" else np.zeros(n, bool)
            sim_b = {bd[i]: (0.0 if kill[i] and real[s] > 0 else sim.get(s, 0.0)) for i, s in enumerate(src)}
            real_b = {bd[i]: (0.0 if kill[i] and real[s] > 0 else real[s]) for i, s in enumerate(src)}
            real_b[base.isoformat()] = 0.0
            debt_b = {bd[i]: debt[s] for i, s in enumerate(src)}
            dd_b = {bd[i]: dd.get(s, 0.0) for i, s in enumerate(src)}
            vb, _ = composite(bd, sim_b, real_b, debt_b, dd_b, x_pd, pri)
            hold += vb["pass"]
            cls_hold += vb["classifier_pass"]
            mag_hold += vb["magnitude_pass"]
            for k, ok in list(vb["checks"].items()) + list(vb["magnitude_checks"].items()):
                per[k] = per.get(k, 0) + bool(ok)
        res["variants"][name] = {"composite_pass_share": hold / B, "classifier_pass_share": cls_hold / B,
                                 "magnitude_pass_share": mag_hold / B, "per_check_share": {k: c / B for k, c in per.items()}}
        print(name, json.dumps(res["variants"][name]), flush=True)
    res["power"] = min(v["composite_pass_share"] for v in res["variants"].values())
    res["decision"] = "run once" if res["power"] >= 0.80 else "no blind run on this chain (power < 0.80)"
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, "r111v5-power.json"), res)
    print(json.dumps({"power": res["power"], "decision": res["decision"]}))


if __name__ == "__main__":
    main()
