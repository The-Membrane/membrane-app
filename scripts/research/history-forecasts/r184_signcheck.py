#!/usr/bin/env python3
"""Q26 R18.4 pooled curve-change SIGN CHECK (membrane-board design/Q26_ROUND18_PREREG.md R18.4f). Sign only.

Events: days on which a market's rate curve (optimal, base, slope1, slope2) differs from the previous daily read.
Markets: Aave V3 Ethereum Core USDC and USDT (depositor-balances/reserve-state.csv daily snapshots) and the R11.8
L2 USDC markets (history-forecasts/r11/r118-inputs-9ab156bb/daily-*.csv.gz). RF1 (V2 Ethereum USDC) is excluded.
These configuration reads and daily totals were already seen (R11.8, R18.3). No per-unit byte is read.

Treatment: ds = supply rate on the new curve minus on the old curve, both at the pre-change utilisation (points).
Outcomes over k = 3 and 7 days from the last pre-change read: change in log supply, change in log debt, change in
cash share. Controls: the same-window pre-trend, the change in the 3-month T-bill (FRED DTB3) and in the Sky/Maker
savings rate (DefiLlama sUSDS from 2025-02-21, sDAI before), the pre-change supply-rate gap to the T-bill, market
fixed effects. CI: pairs bootstrap clustered by calendar date (shared governance dates), 4,000 draws.

  python3 r184_signcheck.py --datasets <ds> --ext <dir with dtb3.csv, sdai.json, susds.json> --out <dir>
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

RAY = 1e27
KS = (3, 7)


def core_series(ds, res):
    s = pd.read_csv(os.path.join(ds, "depositor-balances/reserve-state.csv"))
    s = s[(s["reserve"] == res) & (s["snapshot"] != "asof")].copy()
    s["date"] = pd.to_datetime(s["snapshot"])
    out = pd.DataFrame({"date": s["date"], "S": pd.to_numeric(s["totalSupply"], errors="coerce") / 1e6,
                        "debt": pd.to_numeric(s["variableDebt"], errors="coerce") / 1e6,
                        "cash": pd.to_numeric(s["cash"], errors="coerce") / 1e6,
                        "opt": pd.to_numeric(s["optimal"], errors="coerce") / RAY,
                        "base": pd.to_numeric(s["base"], errors="coerce") / RAY,
                        "s1": pd.to_numeric(s["slope1"], errors="coerce") / RAY,
                        "s2": pd.to_numeric(s["slope2"], errors="coerce") / RAY,
                        "rf": pd.to_numeric(s["RF_bps"], errors="coerce") / 1e4, "frozen": 0})
    return out.dropna(subset=["S", "debt", "opt"]).sort_values("date").reset_index(drop=True)


def l2_series(path, start):
    s = pd.read_csv(path)
    s["date"] = pd.to_datetime(s["date"])
    vb = pd.to_numeric(s["virtual_balance_raw"], errors="coerce")
    cash = pd.to_numeric(s["cash_balance_raw"], errors="coerce")
    avail = vb.where(vb.notna(), cash) / 1e6
    debt = (pd.to_numeric(s["variable_debt_raw"], errors="coerce").fillna(0)
            + pd.to_numeric(s["stable_debt_raw"], errors="coerce").fillna(0)) / 1e6
    out = pd.DataFrame({"date": s["date"], "S": avail + debt, "debt": debt, "cash": avail,
                        "opt": pd.to_numeric(s["optimal_usage_ray"], errors="coerce") / RAY,
                        "base": pd.to_numeric(s["base_rate_ray"], errors="coerce") / RAY,
                        "s1": pd.to_numeric(s["slope1_ray"], errors="coerce") / RAY,
                        "s2": pd.to_numeric(s["slope2_ray"], errors="coerce") / RAY,
                        "rf": pd.to_numeric(s["reserve_factor_bps"], errors="coerce") / 1e4,
                        "frozen": pd.to_numeric(s["frozen"], errors="coerce").fillna(0)
                        + (1 - pd.to_numeric(s["active"], errors="coerce").fillna(1))})
    out = out[out["date"] >= pd.Timestamp(start)]
    return out.dropna(subset=["S", "debt", "opt"]).sort_values("date").reset_index(drop=True)


def benchmarks(ext):
    tb = pd.read_csv(os.path.join(ext, "dtb3.csv"))
    tb.columns = ["date", "tbill"]
    tb["date"] = pd.to_datetime(tb["date"])
    tb["tbill"] = pd.to_numeric(tb["tbill"], errors="coerce")
    sv = []
    for f, lo in (("sdai.json", None), ("susds.json", "2025-02-21")):
        d = pd.DataFrame(json.load(open(os.path.join(ext, f)))["data"])
        d["date"] = pd.to_datetime(d["timestamp"].str[:10])
        d = d.groupby("date")["apy"].last()
        sv.append(d if lo is None else d[d.index >= lo])
    sav = sv[0].copy()
    sav.loc[sv[1].index] = sv[1]
    idx = pd.date_range("2020-01-01", "2026-12-31", freq="D")
    B = pd.DataFrame(index=idx)
    B["tbill"] = tb.set_index("date")["tbill"].reindex(idx).ffill()
    B["sav"] = sav.sort_index().reindex(idx).ffill()
    return B


def events(m, name):
    k = ["opt", "base", "s1", "s2"]
    ch = (m[k].diff().abs() > 1e-9).any(axis=1)
    ch.iloc[0] = False
    rows = []
    for e in np.where(ch.to_numpy())[0]:
        if e - 1 - max(KS) < 0 or e - 1 + max(KS) >= len(m):
            continue
        w = m.iloc[e - 1 - max(KS):e + max(KS)]
        if (w["frozen"] > 0).any():
            continue
        p, q = m.iloc[e - 1], m.iloc[e]
        u = p["debt"] / p["S"]
        ds = (E.supply_rate(u, q["opt"], q["s1"], q["s2"], q["base"], q["rf"])
              - E.supply_rate(u, p["opt"], p["s1"], p["s2"], p["base"], p["rf"])) * 100
        r0 = E.supply_rate(u, p["opt"], p["s1"], p["s2"], p["base"], p["rf"]) * 100
        row = {"market": name, "date": q["date"], "pre_date": p["date"], "u_pre": float(u), "ds_pts": float(ds),
               "supply_rate_pre": float(r0)}
        for kk in KS:
            a, b, c = m.iloc[e - 1 - kk], m.iloc[e - 1], m.iloc[e - 1 + kk]
            row[f"gS_{kk}"] = float(np.log(c["S"] / b["S"]))
            row[f"preS_{kk}"] = float(np.log(b["S"] / a["S"]))
            row[f"gD_{kk}"] = float(np.log(c["debt"] / b["debt"]))
            row[f"preD_{kk}"] = float(np.log(b["debt"] / a["debt"]))
            row[f"gC_{kk}"] = float(c["cash"] / c["S"] - b["cash"] / b["S"])
            row[f"preC_{kk}"] = float(b["cash"] / b["S"] - a["cash"] / a["S"])
            row[f"end_{kk}"] = c["date"]
        rows.append(row)
    return rows


def regress(E_, y, pre, kk, bench=True, B=4000, seed=7):
    X = [np.ones(len(E_)), E_["ds_pts"].to_numpy(), E_[pre].to_numpy()]
    if bench:
        X += [E_[f"dtb_{kk}"].to_numpy(), E_[f"dsav_{kk}"].to_numpy(), E_["gap_tb"].to_numpy()]
    mk = pd.get_dummies(E_["market"], drop_first=True).to_numpy(float)
    X = np.column_stack(X + ([mk] if mk.shape[1] else []))
    Y = E_[y].to_numpy()
    ok = np.isfinite(X).all(1) & np.isfinite(Y)
    X, Y = X[ok], Y[ok]
    cl = E_["date"].dt.strftime("%Y-%m-%d").to_numpy()[ok]
    beta = np.linalg.lstsq(X, Y, rcond=None)[0]
    uc, inv = np.unique(cl, return_inverse=True)
    rng = np.random.default_rng(seed)
    bs = []
    for _ in range(B):
        w = np.bincount(rng.integers(0, len(uc), len(uc)), minlength=len(uc))[inv].astype(float)
        sw = np.sqrt(w)
        bs.append(np.linalg.lstsq(X * sw[:, None], Y * sw, rcond=None)[0][1])
    bs = np.array(bs)
    return {"beta_per_pt": float(beta[1]), "lo": float(np.percentile(bs, 2.5)), "hi": float(np.percentile(bs, 97.5)),
            "shareBootPositive": float((bs > 0).mean()), "nEvents": int(ok.sum()), "nDates": int(len(uc))}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--ext", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    r118 = os.path.join(a.datasets, "history-forecasts/r11/r118-inputs-9ab156bb")
    starts = json.load(open(os.path.join(r118, "readings-r118.json")))["r103_start"]
    rows = []
    for res in ("USDC", "USDT"):
        rows += events(core_series(a.datasets, res), f"core-{res.lower()}")
    for p in sorted(glob.glob(os.path.join(r118, "daily-v3-*.csv.gz"))):
        nm = os.path.basename(p)[6:-7]
        rows += events(l2_series(p, starts[nm]), nm)
    Ev = pd.DataFrame(rows)
    Bm = benchmarks(a.ext)
    get = lambda col, dts: Bm[col].reindex(pd.DatetimeIndex(dts)).to_numpy()
    for kk in KS:
        Ev[f"dtb_{kk}"] = get("tbill", Ev[f"end_{kk}"]) - get("tbill", Ev["pre_date"])
        Ev[f"dsav_{kk}"] = get("sav", Ev[f"end_{kk}"]) - get("sav", Ev["pre_date"])
    Ev["gap_tb"] = Ev["supply_rate_pre"] - get("tbill", Ev["pre_date"])
    Ev["savAvailable"] = np.isfinite(get("sav", Ev["pre_date"]))
    out = {"schema": "q26-r184/signcheck/1", "note": "SIGN CHECK ONLY. Curve changes are mostly risk-steward retargets "
           "toward external benchmarks (endogenous); the benchmark controls are partial.",
           "nEvents": int(len(Ev)), "eventsByMarket": Ev["market"].value_counts().to_dict(),
           "nEventsAbsDsGE0.25": int((Ev["ds_pts"].abs() >= 0.25).sum()), "results": {}}
    for sub, m in (("all", np.ones(len(Ev), bool)), ("absDsGE0.25", Ev["ds_pts"].abs().to_numpy() >= 0.25),
                   ("savAvailable", Ev["savAvailable"].to_numpy()), ("coreOnly", Ev["market"].str.startswith("core").to_numpy())):
        Es = Ev[m].reset_index(drop=True)
        if len(Es) < 8:
            continue
        r = {}
        for kk in KS:
            for y, pre in (("gS", "preS"), ("gD", "preD"), ("gC", "preC")):
                key = f"{y}_{kk}d"
                bench = sub != "coreOnly" or True
                r[key] = {"withBenchmarks": regress(Es.dropna(subset=[f"dsav_{kk}"]) if sub == "savAvailable" else
                                                    Es.fillna({f"dsav_{kk}": 0.0}), f"{y}_{kk}", f"{pre}_{kk}", kk, bench),
                          "noBenchmarks": regress(Es, f"{y}_{kk}", f"{pre}_{kk}", kk, False)}
                big = Es[Es["ds_pts"].abs() >= 0.25]
                net = big[f"{y}_{kk}"] - big[f"{pre}_{kk}"]
                r[key]["signConcordanceAbsDsGE0.25"] = float((np.sign(net) == np.sign(big["ds_pts"])).mean()) if len(big) else None
        out["results"][sub] = r
    Ev.drop(columns=[c for c in Ev.columns if c.startswith("end_")]).to_csv(
        os.path.join(a.out, "signcheck-events.csv"), index=False, float_format="%.6g")
    with open(os.path.join(a.out, "signcheck-r184.json"), "w") as f:
        json.dump(out, f, indent=1, default=str)
    for sub, r in out["results"].items():
        for key, v in r.items():
            w = v["withBenchmarks"]
            print(f"{sub:13s} {key:7s} beta/pt {w['beta_per_pt']:+.5f} ({w['lo']:+.5f}, {w['hi']:+.5f}) P(b>0) "
                  f"{w['shareBootPositive']:.2f} n {w['nEvents']} dates {w['nDates']} | noBench {v['noBenchmarks']['beta_per_pt']:+.5f}"
                  f" | concord {v['signConcordanceAbsDsGE0.25']}")
    print(out["eventsByMarket"], out["nEvents"], out["nEventsAbsDsGE0.25"])


if __name__ == "__main__":
    sys.exit(main())
