"""Q26 R31 breakdowns required by REVIEW Q26-R30 (board 57653f4), run beside the registered R31 verdict.

This is the R30 reviewer's check code (membrane-datasets history-forecasts/r30/review/r30_review_checks.py, commit
3808995), copied with this docstring as the only change. It is descriptive: it does not change the R31 verdict.

From the address-free R27 work arrays (episodes, checks, denoms, grids) it recomputes the R0 3% alert against the
TWAP-touch target (REVIEW Q26-R27 / R29 part C: liquidation-ended episodes continue up to 24 hourly checks on the
frozen line while d <= 10%) and gives: the headline, the touch events without the liquidation continuation, by series,
by episode-start year, leave-top-k touch weeks (their position-days leave the denominator), without WETH, false
alarms per all and per near-line borrower-week (a near-line row has own 6 h line distance at 00:00Z of 10% or less),
equal volume under both denominators, and recall at equal false-alarm rate. Aggregates only; no position index.

  python3 -I r31_breakdowns.py WORKDIR [WORKDIR_REF]
"""
import datetime as dt
import json
import sys

import numpy as np

HOUR, DAY = 3600, 86400
REASONS = ["touch", "exit", "act", "liq", "gap", "data", "data_end"]


def utc(y, m, d):
    return int(dt.datetime(y, m, d, tzinfo=dt.timezone.utc).timestamp())


T_SC, T_HI = utc(2023, 1, 1), utc(2026, 9, 23)
THR = 0.03


def week_of(t):
    return (np.asarray(t, np.int64) // DAY - 4) // 7


def load(work):
    G = np.load(f"{work}/grids.npz")
    series = [str(s) for s in G["series"]]
    GR = {i: (int(G[f"st{i}"]), np.asarray(G[f"close{i}"], float), np.asarray(G[f"low{i}"], float))
          for i in range(len(series))}
    E = dict(np.load(f"{work}/episodes.npz"))
    C = dict(np.load(f"{work}/checks.npz"))
    D = dict(np.load(f"{work}/denoms.npz"))
    x = E["x"].astype(int)
    est, tch, rs, L, end = E["start"], E["touch"], E["reason"], E["L"], E["end"]
    scored = (est >= T_SC) & (est < T_HI + DAY)
    cf = tch.astype(np.int64).copy()
    ext_ep, ext_c, ext_d = [], [], []
    for i in np.nonzero(scored & (rs == REASONS.index("liq")))[0]:
        st, cl, lw = GR[x[i]]
        te = int(end[i])
        bs = (te - st) // HOUR
        if st + bs * HOUR < te and lw[bs] <= L[i]:      # touch inside the bar holding the liquidation
            cf[i] = st + bs * HOUR
            continue
        c0 = st + ((te - st + HOUR - 1) // HOUR) * HOUR
        for k in range(24):
            cc = c0 + k * HOUR
            b = (cc - st) // HOUR
            if b < 1 or b >= len(cl) or not (np.isfinite(cl[b - 1]) and np.isfinite(lw[b])):
                break
            dd = 1 - L[i] / cl[b - 1]
            if dd > 0.10:
                break
            ext_ep.append(i), ext_c.append(cc), ext_d.append(dd)
            if lw[b] <= L[i]:
                cf[i] = cc
                break
    ep = np.r_[C["ep"].astype(np.int64), np.array(ext_ep, np.int64)]
    cc = np.r_[C["c"].astype(np.int64), np.array(ext_c, np.int64)]
    dd = np.r_[C["d"].astype(float), np.array(ext_d, float)]
    o = np.lexsort((cc, ep))
    ep, cc, dd = ep[o], cc[o], dd[o]
    pdx, pdd = D["pd_key"] // 10**6, (D["pd_key"] % 10**6) * DAY
    sc_pd = (pdd >= T_SC) & (pdd <= T_HI)
    pnx, pnd = D["pn_key"] // 10**6, (D["pn_key"] % 10**6) * DAY
    sc_pn = (pnd >= T_SC) & (pnd <= T_HI)
    return dict(series=series, x=x, est=est, scored=scored, cf=cf, liqcont=(tch < 0) & (cf >= 0), ep=ep, c=cc,
                d=dd, pdx=pdx[sc_pd], pdd=pdd[sc_pd], pdn=D["pd_n"][sc_pd].astype(float), pnx=pnx[sc_pn],
                pnd=pnd[sc_pn], pnn=D["pn_n"][sc_pn].astype(float), nep=len(x))


def first_fire(W, thr):
    aa = np.full(W["nep"], -1, np.int64)
    idx = np.nonzero(W["d"] <= thr)[0]
    u, f = np.unique(W["ep"][idx], return_index=True)
    aa[u] = W["c"][idx[f]]
    aa[~W["scored"]] = -1
    return aa


def summ(W, aa, ep_mask=None, pd_mask=None, pn_mask=None):
    m = W["scored"] if ep_mask is None else W["scored"] & ep_mask
    ev = (W["cf"] >= 0) & m
    fired = (aa >= 0) & m
    hit = fired & ev
    lt = (W["cf"] - aa) // HOUR
    early = hit & (lt >= 1)
    false = fired & ~ev
    pdn = W["pdn"] if pd_mask is None else W["pdn"][pd_mask]
    pnn = W["pnn"] if pn_mask is None else W["pnn"][pn_mask]
    bw, bwn = pdn.sum() / 7, pnn.sum() / 7
    nE, nA = int(ev.sum()), int(fired.sum())
    med = lambda v: float(np.median(v)) if len(v) else None
    return {"events": nE, "alerts": nA, "early": int(early.sum()), "false": int(false.sum()),
            "recall": round(early.sum() / nE, 4) if nE else None,
            "fa_bw": round(false.sum() / bw, 5) if bw else None,
            "fa_near_bw": round(false.sum() / bwn, 4) if bwn else None,
            "precision": round(early.sum() / nA, 4) if nA else None,
            "alerts_per_1000bw": round(1000 * nA / bw, 2) if bw else None,
            "med_lead_early_h": med(lt[early]), "med_lead_all_h": med(lt[hit]),
            "touch_events_liq_continuation": int((ev & W["liqcont"]).sum())}


def year_of(t):
    return np.array([dt.datetime.fromtimestamp(int(v), dt.timezone.utc).year for v in t])


def run(work, label):
    W = load(work)
    aa = first_fire(W, THR)
    out = {"chain_work": label, "headline_R0_3pct": summ(W, aa)}
    # recall excluding liquidation-continuation touches (episodes whose touch came from the continuation dropped)
    out["touch_without_liq_continuation_episodes"] = summ(W, aa, ep_mask=~W["liqcont"])
    out["by_series"] = {s: summ(W, aa, W["x"] == i, W["pdx"] == i, W["pnx"] == i) for i, s in enumerate(W["series"])}
    ye, yp, yn = year_of(W["est"]), year_of(W["pdd"]), year_of(W["pnd"])
    out["by_year"] = {int(y): summ(W, aa, ye == y, yp == y, yn == y) for y in range(2023, 2027)}
    # leave-top-k weeks by touch count (episode-start week); the dropped weeks' position-days leave the denominator
    ev = (W["cf"] >= 0) & W["scored"]
    wk = week_of(W["est"])
    uw, cnt = np.unique(wk[ev], return_counts=True)
    order = uw[np.argsort(-cnt, kind="stable")]
    top_share = {k: round(float(np.sort(cnt)[::-1][:k].sum() / cnt.sum()), 4) for k in (1, 3, 5, 10)}
    out["touch_week_concentration_top_k_share"] = top_share
    out["top10_touch_weeks_monday_utc"] = [dt.datetime.fromtimestamp(int((w * 7 + 4) * DAY), dt.timezone.utc)
                                           .date().isoformat() for w in order[:10]]
    pw, nw = week_of(W["pdd"]), week_of(W["pnd"])
    lk = {}
    for k in (1, 2, 3, 5, 10, 20):
        drop = order[:k]
        lk[k] = summ(W, aa, ~np.isin(wk, drop), ~np.isin(pw, drop), ~np.isin(nw, drop))
    out["leave_top_k_touch_weeks"] = lk
    # WETH removed / WETH only
    if "WETH" in W["series"]:
        iw = W["series"].index("WETH")
        out["without_WETH"] = summ(W, aa, W["x"] != iw, W["pdx"] != iw, W["pnx"] != iw)
    # threshold curve on a 0.05% grid for equal-volume matching
    grid = np.round(np.arange(0.005, 0.10001, 0.0005), 4)
    out["_grid"] = [[float(t), summ(W, first_fire(W, t))["alerts_per_1000bw"]] for t in grid]
    out["_W"] = W
    return out


def equal_volume(R, vol_ref, label):
    W = R["_W"]
    g = np.array(R["_grid"])
    thr = float(np.interp(vol_ref, g[:, 1], g[:, 0]))
    near = float(g[np.argmin(np.abs(g[:, 0] - thr)), 0])
    lo = float(g[g[:, 0] <= thr][-1, 0])
    hi = float(g[g[:, 0] >= thr][0, 0])
    return {"matched_to": label, "ref_alerts_per_1000bw": vol_ref, "thr_interp": round(thr, 5),
            "grid_lo": [lo, summ(W, first_fire(W, lo))], "grid_hi": [hi, summ(W, first_fire(W, hi))]}


def main():
    A = run(sys.argv[1], "target")
    res = {"target": {k: v for k, v in A.items() if not k.startswith("_")}}
    if len(sys.argv) > 2:
        B = run(sys.argv[2], "reference")
        res["reference"] = {k: v for k, v in B.items() if not k.startswith("_")}
        hv = B["headline_R0_3pct"]
        res["equal_volume_per_all_bw"] = equal_volume(A, hv["alerts_per_1000bw"], "reference R0 3% alerts/1000bw")
        # equal volume per near-line borrower-week (rows with own d0 <= 10%)
        Wa, Wb = A["_W"], B["_W"]
        vb = 1000 * hv["alerts"] / (Wb["pnn"].sum() / 7)
        g = np.array([[t, 1000 * int((first_fire(Wa, t) >= 0).sum()) / (Wa["pnn"].sum() / 7)]
                      for t in np.round(np.arange(0.005, 0.10001, 0.0005), 4)])
        thr = float(np.interp(vb, g[:, 1], g[:, 0]))
        near = float(g[np.argmin(np.abs(g[:, 0] - thr)), 0])
        res["equal_volume_per_near_bw"] = {"ref_alerts_per_1000_near_bw": round(vb, 2),
                                           "target_at_3pct": round(float(g[np.isclose(g[:, 0], 0.03), 1][0]), 2),
                                           "thr_interp": round(thr, 5),
                                           "nearest_grid": [near, summ(Wa, first_fire(Wa, near))]}
        # recall at equal false-alarm rate (both denominators) and at equal precision-free volume: ranking parity
        cur = np.array([[t, *(lambda r: (r["recall"], r["fa_bw"], r["fa_near_bw"], r["precision"]))(
            summ(Wa, first_fire(Wa, t)))] for t in np.round(np.arange(0.005, 0.10001, 0.0005), 4)], float)
        eqfa = {}
        for col, key in ((2, "fa_bw"), (3, "fa_near_bw")):
            o = np.argsort(cur[:, col])
            eqfa[key] = {"reference_fa": hv[key], "reference_recall": hv["recall"],
                         "target_thr": round(float(np.interp(hv[key], cur[o, col], cur[o, 0])), 5),
                         "target_recall": round(float(np.interp(hv[key], cur[o, col], cur[o, 1])), 4)}
        res["recall_at_equal_false_alarm_rate"] = eqfa
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
