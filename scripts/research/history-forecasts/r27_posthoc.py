"""Q26 R27 POST-HOC (not registered): the same episodes and rules scored against the harm event = the first of the
TWAP-line touch and a real LiquidationCall inside the episode. Written after the registered R27 run showed that most
near-line episodes end at a real liquidation before any TWAP touch. DEVELOPMENT ONLY (seen).

  python3 r27_posthoc.py --work WORK --out OUT [--nb 2000]

Reads the R27 scratch (episodes.npz, checks.npz, denoms.npz, grids.npz) written by r27_atrisk.py build. Writes
address-free aggregates only (r27-posthoc-harm.json).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r27_atrisk as R  # noqa: E402

HOUR, DAY = R.HOUR, R.DAY


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nb", type=int, default=2000)
    a = ap.parse_args()
    E = dict(np.load(os.path.join(a.work, "episodes.npz")))
    C = dict(np.load(os.path.join(a.work, "checks.npz")))
    D = dict(np.load(os.path.join(a.work, "denoms.npz")))
    Gz = np.load(os.path.join(a.work, "grids.npz"))
    ns = len(Gz["series"])
    nep = len(E["x"])
    o = np.lexsort((C["c"], C["ep"]))
    C = {k: v[o] for k, v in C.items()}
    ep, c, d = C["ep"].astype(np.int64), C["c"], C["d"]
    ex, est, ereason, etouch = E["x"].astype(int), E["start"], E["reason"], E["touch"]
    liq_end = ereason == R.REASONS.index("liq")
    touch = etouch >= 0
    harm = touch | liq_end
    # harm time: touch bar open, or the liquidation time (the episode end) for liq-ended episodes
    ht = np.where(touch, etouch, np.where(liq_end, E["end"], -1)).astype(np.int64)
    scored = (est >= R.T_SC) & (est < R.T_HI + DAY)
    events = scored & harm
    eq = R.quarter_of(est)
    nq = len(R.QSTARTS)
    u6 = C["u6"].astype(float)
    cx = ex[ep]
    edges = np.full((ns, nq), np.nan)
    for xi in range(ns):
        st = int(Gz[f"st{xi}"])
        ua = np.asarray(Gz[f"u6{xi}"], float)
        ts = st + HOUR * np.arange(len(ua))
        for qi, qs in enumerate(R.QSTARTS):
            v = ua[(ts >= R.T_LO) & (ts < qs) & np.isfinite(ua)]
            edges[xi, qi] = np.quantile(v, 2 / 3)
    hi = np.isfinite(u6) & (u6 >= edges[cx, np.clip(eq[ep], 0, nq - 1)])
    S = {"R0": -d, "R0v": -d / np.where(hi, R.M_HI, 1.0), "R1": C["thru"].astype(float)}
    F = {k: R.Firing(ep, v, nep) for k, v in S.items()}
    pdx, pdd = D["pd_key"] // 10**6, (D["pd_key"] % 10**6) * DAY
    sc_pd = (pdd >= R.T_SC) & (pdd <= R.T_HI)
    PD = float(D["pd_n"][sc_pd].sum())
    weeks = np.arange(min(R.week_of(pdd[sc_pd]).min(), R.week_of(est[scored]).min()),
                      max(R.week_of(pdd[sc_pd]).max(), R.week_of(est[scored]).max()) + 1)
    BT = R.Boot(ns, weeks, a.nb)
    Spd = BT.cells(pdx[sc_pd], R.week_of(pdd[sc_pd]), D["pd_n"][sc_pd])
    ewk = R.week_of(est)

    def thr(k, tau):
        return F[k]._rank_from_sorted(np.searchsorted(F[k].ss, tau, side="left")) * np.ones(nep, np.int64)

    def outcome(j):
        j = np.where(scored, j, -1)
        fired = j >= 0
        jj = np.where(fired, j, 0)
        lead_s = np.where(fired & harm, ht - c[jj], -1)
        early = fired & harm & (lead_s >= HOUR)
        late = fired & harm & (lead_s < HOUR)
        false = fired & ~harm
        return {"fired": fired, "early": early, "late": late, "false": false, "lead_s": lead_s}

    def summ(o_, ci=False, mask=None):
        m = scored if mask is None else scored & mask
        ev = events & m
        n_ev, f = int(ev.sum()), int((o_["fired"] & m).sum())
        e_, l_, fa = (int((o_[k] & m).sum()) for k in ("early", "late", "false"))
        bw = PD / 7
        out = {"events": n_ev, "alerts": f, "early": e_, "late": l_, "false": fa,
               "recall_1h": R.rr(e_ / n_ev) if n_ev else None, "precision_1h": R.rr(e_ / f) if f else None,
               "fa_per_bw": R.rr(fa / bw, 5)}
        ls = o_["lead_s"][o_["early"] & m] / 3600
        if len(ls):
            out["lead_hours_early_q25_q50_q75"] = [round(float(v), 2) for v in np.quantile(ls, [.25, .5, .75])]
        for nm, msk in (("touch_events", touch), ("liq_events", liq_end)):
            evs = events & m & msk
            out[f"recall_1h_{nm}"] = R.rr((o_["early"] & evs).sum() / evs.sum()) if evs.sum() else None
        if ci:
            Sev = BT.cells(ex[ev], ewk[ev], np.ones(n_ev))
            Sea = BT.cells(ex[m], ewk[m], o_["early"][m])
            Sfa = BT.cells(ex[m], ewk[m], o_["false"][m])
            out["ci"] = {"recall_1h": BT.ci(Sea, Sev), "fa_per_bw": BT.ci(7 * Sfa, Spd)}
        return out

    def counts(o_):
        return np.array([int((o_["fired"] & scored & (eq == q)).sum()) for q in range(nq)])

    def gain(o1, o0):
        ev = events
        Sev = BT.cells(ex[ev], ewk[ev], np.ones(int(ev.sum())))
        Sd = BT.cells(ex[scored], ewk[scored], (o1["early"].astype(float) - o0["early"].astype(float))[scored])
        g = ((o1["early"] & scored).sum() - (o0["early"] & scored).sum()) / ev.sum()
        f0 = (o0["false"] & scored).sum()
        return {"recall_1h_gain": R.rr(g), "ci": BT.ci(Sd, Sev),
                "fa_ratio": R.rr((o1["false"] & scored).sum() / f0) if f0 else None}

    OUT = {"what": "Q26 R27 POST-HOC harm-event scoring (first of TWAP touch and real liquidation); not registered",
           "events": int(events.sum()), "touch_events": int((events & touch).sum()),
           "liq_events": int((events & liq_end).sum()), "scored_episodes": int(scored.sum())}
    dep = {"R0": outcome(F["R0"].first(thr("R0", -R.D_R0))), "R0v": outcome(F["R0v"].first(thr("R0v", -R.D_R0))),
           "R1": outcome(F["R1"].first(thr("R1", 0.5)))}
    OUT["deployable"] = {k: summ(v, ci=True) for k, v in dep.items()}
    for hn, hm in (("first_half", est < R.SPLIT), ("second_half", est >= R.SPLIT)):
        for k, v in dep.items():
            OUT["deployable"][k][hn] = summ(v, mask=hm)
    OUT["curve_R0"] = []
    OUT["curve_R0v"] = []
    for ds in R.R0_GRID:
        for k in ("R0", "R0v"):
            s_ = summ(outcome(F[k].first(thr(k, -ds))))
            s_["d_star"] = ds
            OUT[f"curve_{k}"].append(s_)
    mv = {}
    for ref in ("R0v", "R1"):
        tgt = counts(dep[ref])
        o0 = outcome(F["R0"].first(R.match_ranks(F["R0"], scored, tgt, eq, nq)))
        mv[f"matched_to_{ref}"] = {"R0": summ(o0, ci=True), ref: summ(dep[ref], ci=True),
                                   f"{ref}_vs_R0": gain(dep[ref], o0)}
    OUT["matched_volume"] = mv
    # borrower experience at the operating points (calm / volatile series-months, as in r27_atrisk score)
    def mon_of(t):
        m_ = np.asarray(t, np.int64).astype("datetime64[s]").astype("datetime64[M]").astype(np.int64)
        return (1970 + m_ // 12) * 100 + m_ % 12 + 1
    rv = {}
    for xi in range(ns):
        st = int(Gz[f"st{xi}"])
        cl = np.asarray(Gz[f"close{xi}"], float)
        ts = st + HOUR * np.arange(len(cl))
        lr = np.r_[np.nan, np.diff(np.log(cl))]
        sel = (ts >= R.T_SC) & (ts < R.T_HI + DAY) & np.isfinite(lr)
        mo = mon_of(ts[sel])
        for mv_ in np.unique(mo):
            rv[(xi, int(mv_))] = float(np.sqrt(np.mean(lr[sel][mo == mv_] ** 2)))
    vals = np.array(list(rv.values()))
    e1, e2 = np.quantile(vals, [1 / 3, 2 / 3])
    mst = {k_: (0 if v <= e1 else (2 if v > e2 else 1)) for k_, v in rv.items()}
    pd_st = np.array([mst.get((int(x_), int(m_)), -1) for x_, m_ in zip(pdx, mon_of(pdd))])
    pnx, pnd = D["pn_key"] // 10**6, (D["pn_key"] % 10**6) * DAY
    pn_st = np.array([mst.get((int(x_), int(m_)), -1) for x_, m_ in zip(pnx, mon_of(pnd))])
    sc_pn = (pnd >= R.T_SC) & (pnd <= R.T_HI)
    ep_st = np.array([mst.get((int(x_), int(m_)), -1) for x_, m_ in zip(ex, mon_of(est))])
    BX = {}
    for ds in (0.02, 0.03, 0.04, 0.05):
        o_ = outcome(F["R0"].first(thr("R0", -ds)))
        row = {}
        for nm, sv in (("calm", 0), ("mid", 1), ("volatile", 2)):
            pdn = float(D["pd_n"][sc_pd & (pd_st == sv)].sum())
            pnn = float(D["pn_n"][sc_pn & (pn_st == sv)].sum())
            me = scored & (ep_st == sv)
            row[nm] = {"alerts_per_borrower_month": R.rr(30.4375 * (o_["fired"] & me).sum() / pdn),
                       "alerts_per_nearline_borrower_month": R.rr(30.4375 * (o_["fired"] & me).sum() / pnn),
                       "false_harm_per_nearline_borrower_month": R.rr(30.4375 * (o_["false"] & me).sum() / pnn),
                       "precision_1h_harm": R.rr((o_["early"] & me).sum() / (o_["fired"] & me).sum())
                       if (o_["fired"] & me).sum() else None}
        ls = o_["lead_s"][o_["early"]] / 3600
        row["median_lead_hours_early_harm"] = R.rr(np.median(ls), 2) if len(ls) else None
        BX[f"R0_{ds}"] = row
    OUT["borrower_experience_R0"] = BX
    os.makedirs(a.out, exist_ok=True)
    json.dump(OUT, open(os.path.join(a.out, "r27-posthoc-harm.json"), "w"), indent=1,
              default=lambda v: v.item() if hasattr(v, "item") else str(v))
    print(json.dumps({k: OUT[k] for k in ("events", "touch_events", "liq_events")}))


if __name__ == "__main__":
    main()
