#!/usr/bin/env python3
"""Q26 R18.5 step 1: count exogenous supply-rate instrument events (reserve-factor changes) from config history.

membrane-board design/Q26_ROUND18_PREREG.md R18.5 (feasibility and power check, development only).

Markets: Aave V3 Ethereum Core USDC and USDT (depositor-balances/reserve-state.csv daily snapshots: RF_bps and the
curve in force) and the seen R11.8 L2 V3 USDC markets (history-forecasts/r11/r118-inputs-9ab156bb/daily-v3-*.csv.gz:
reserve_factor_bps and the curve). RF1 (V2 Ethereum USDC) and RF2 (Core PYUSD/USDS/RLUSD) are NOT read.
The Core PoolConfigurator event file (governance-changes/aave-v3-ethereum-core.json) holds no ReserveFactorChanged or
ReserveInterestRateStrategyChanged events (only 5 event types), so day-level config snapshots are the source.

Resolution is daily: an RF event is a day d whose RF read differs from day d-1's read (reads at the last block before
00:00Z). The utilisation u_pre is at the d-1 read (the day before the change is in force).

Dose: the supply-rate change at u_pre, borrow rate unchanged (RF only moves the supply rate):
   rf_dose_pts = borrowRate_old(u_pre) * u_pre * (RF_old - RF_new) * 100
A same-day curve change also moves the borrow rate; those events are flagged (curve_same_day) and are not clean.
Curve changes within +-3 / +-7 daily reads are flagged too (curve_near3, curve_near7).

Outputs (address-free): r185-rf-events.csv, r185-rf-summary.json.

  python3 r185_events.py --datasets <membrane-datasets> --out <dir>
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r184_engine as E  # noqa: E402
from r184_signcheck import core_series, l2_series  # noqa: E402

CURVE = ["opt", "base", "s1", "s2"]


def rf_events(m, name, start):
    m = m.reset_index(drop=True)
    cch = (m[CURVE].diff().abs() > 1e-9).any(axis=1).to_numpy().copy()
    cch[0] = False
    rch = (m["rf"].diff().abs() > 1e-9).to_numpy().copy()
    rch[0] = False
    rows = []
    for e in np.where(rch)[0]:
        p, q = m.iloc[e - 1], m.iloc[e]
        u = float(p["debt"] / p["S"]) if p["S"] > 0 else np.nan
        br_old = float(E.curve_rate(u, p["opt"], p["s1"], p["s2"], p["base"]))
        rf_dose = br_old * u * (p["rf"] - q["rf"]) * 100
        tot = (float(E.supply_rate(u, q["opt"], q["s1"], q["s2"], q["base"], q["rf"]))
               - float(E.supply_rate(u, p["opt"], p["s1"], p["s2"], p["base"], p["rf"]))) * 100
        dbr = (float(E.curve_rate(u, q["opt"], q["s1"], q["s2"], q["base"])) - br_old) * 100
        near = lambda k: bool(cch[max(1, e - k):min(len(m), e + k + 1)].any())
        lo, hi = max(0, e - 7), min(len(m), e + 8)
        frozen = bool((m["frozen"].iloc[lo:hi] > 0).any())
        rows.append({"market": name, "date": q["date"].strftime("%Y-%m-%d"),
                     "pre_date": p["date"].strftime("%Y-%m-%d"),
                     "days_gap_pre": int((q["date"] - p["date"]).days),
                     "rf_old_bps": round(float(p["rf"]) * 1e4), "rf_new_bps": round(float(q["rf"]) * 1e4),
                     "u_pre": u, "kink": float(p["opt"]), "above_kink": bool(u >= p["opt"]),
                     "borrow_rate_pre_pts": br_old * 100,
                     "supply_rate_pre_pts": float(E.supply_rate(u, p["opt"], p["s1"], p["s2"], p["base"], p["rf"])) * 100,
                     "rf_dose_pts": rf_dose, "total_supply_dS_pts": tot, "borrow_dB_pts": dbr,
                     "supply_usd": float(p["S"]),
                     "curve_same_day": bool(cch[e]), "curve_near3": near(3), "curve_near7": near(7),
                     "frozen_near7": frozen, "before_r103_start": bool(q["date"] < pd.Timestamp(start)) if start else False,
                     "edge_7d": bool(e - 1 - 7 < 0 or e - 1 + 7 >= len(m))})
    nc = int(cch.sum())
    return rows, nc, (m["date"].min().strftime("%Y-%m-%d"), m["date"].max().strftime("%Y-%m-%d"), len(m))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    r118 = os.path.join(a.datasets, "history-forecasts/r11/r118-inputs-9ab156bb")
    starts = json.load(open(os.path.join(r118, "readings-r118.json")))["r103_start"]
    rows, span, ncurve = [], {}, {}
    for res in ("USDC", "USDT"):
        nm = f"core-{res.lower()}"
        r, nc, sp = rf_events(core_series(a.datasets, res), nm, None)
        rows += r; span[nm] = sp; ncurve[nm] = nc
    for p in sorted(glob.glob(os.path.join(r118, "daily-v3-*.csv.gz"))):
        nm = os.path.basename(p)[6:-7]
        r, nc, sp = rf_events(l2_series(p, "2000-01-01"), nm, starts[nm])
        rows += r; span[nm] = sp; ncurve[nm] = nc
    Ev = pd.DataFrame(rows).sort_values(["date", "market"]).reset_index(drop=True)
    # same-day multi-market payloads: dates with RF changes on >= 2 markets
    nd = Ev.groupby("date")["market"].transform("count")
    Ev["n_markets_same_day"] = nd
    Ev["clean"] = (~Ev["curve_same_day"]) & (~Ev["frozen_near7"]) & (~Ev["edge_7d"]) & (~Ev["before_r103_start"]) \
        & (Ev["days_gap_pre"] <= 2)
    Ev["clean_strict"] = Ev["clean"] & (~Ev["curve_near7"])
    Ev.to_csv(os.path.join(a.out, "r185-rf-events.csv"), index=False, float_format="%.6g")

    def desc(s):
        s = s.dropna()
        if not len(s):
            return {}
        q = np.percentile(np.abs(s), [10, 25, 50, 75, 90])
        return {"n": int(len(s)), "absDose_pts_q10_25_50_75_90": [round(float(x), 4) for x in q],
                "nRaisesSupplyRate": int((s > 0).sum()), "nCutsSupplyRate": int((s < 0).sum()),
                "nAbsGE0.10pts": int((np.abs(s) >= 0.10).sum()), "nAbsGE0.25pts": int((np.abs(s) >= 0.25).sum()),
                "nAbsGE0.50pts": int((np.abs(s) >= 0.50).sum())}

    multi = Ev[Ev["n_markets_same_day"] >= 2]
    mm = []
    for d, g in multi.groupby("date"):
        mm.append({"date": d, "markets": g["market"].tolist(), "u_pre": [round(x, 3) for x in g["u_pre"]],
                   "rf_dose_pts": [round(x, 3) for x in g["rf_dose_pts"]],
                   "doseRange_pts": round(float(g["rf_dose_pts"].max() - g["rf_dose_pts"].min()), 4),
                   "nClean": int(g["clean"].sum())})
    out = {"schema": "q26-r185/rf-events/1",
           "note": "Daily-resolution config reads only. Dose = borrowRate_old(u_pre)*u_pre*(RF_old-RF_new) in points.",
           "spans": span, "curveChangeDays": ncurve, "nRfEvents": int(len(Ev)),
           "byMarket": Ev["market"].value_counts().to_dict(),
           "nCurveSameDay": int(Ev["curve_same_day"].sum()), "nCurveNear3": int(Ev["curve_near3"].sum()),
           "nCurveNear7": int(Ev["curve_near7"].sum()), "nFrozenNear7": int(Ev["frozen_near7"].sum()),
           "nBeforeR103Start": int(Ev["before_r103_start"].sum()), "nEdge7d": int(Ev["edge_7d"].sum()),
           "nClean": int(Ev["clean"].sum()), "nCleanStrict": int(Ev["clean_strict"].sum()),
           "nCleanDates": int(Ev.loc[Ev["clean"], "date"].nunique()),
           "nCleanMarkets": int(Ev.loc[Ev["clean"], "market"].nunique()),
           "cleanByMarket": Ev.loc[Ev["clean"], "market"].value_counts().to_dict(),
           "doseAll": desc(Ev["rf_dose_pts"]), "doseClean": desc(Ev.loc[Ev["clean"], "rf_dose_pts"]),
           "doseCleanStrict": desc(Ev.loc[Ev["clean_strict"], "rf_dose_pts"]),
           "cleanAboveKink": int(Ev.loc[Ev["clean"], "above_kink"].sum()),
           "multiMarketDates": mm}
    with open(os.path.join(a.out, "r185-rf-summary.json"), "w") as f:
        json.dump(out, f, indent=1, default=str)
    pd.set_option("display.width", 250)
    print(Ev[["market", "date", "rf_old_bps", "rf_new_bps", "u_pre", "rf_dose_pts", "borrow_dB_pts", "curve_same_day",
              "curve_near7", "frozen_near7", "before_r103_start", "n_markets_same_day", "clean"]].to_string())
    print(json.dumps({k: v for k, v in out.items() if k != "multiMarketDates"}, indent=1, default=str))
    for x in mm:
        print(x)


if __name__ == "__main__":
    sys.exit(main())
