"""Q26 R33 secondary metrics (reported, NOT gating) for the R0 3 % alert on one chain's R27 work.

  python3 r33_secondary.py --work R27WORK --out OUT.json [--nb 2000]

Reads the unchanged r27_atrisk build output (grids, episodes, checks, denoms; internal position index only). The
touch target, the 24-check liquidation continuation and the first-alert rule are re-derived exactly as in
r30_replicate.cmd_score (copied, not changed). Outputs address-free aggregates only.

Secondary metrics (registered in r33/REGISTRATION.md section 5):
  S1 recall with the alert required >= 1 h before the Aave liquidation on touches that come from the liquidation
     continuation (the R32 must-fix definition, review rev.py "strict_1h_before_liq"): early & (not lc or
     alert <= liquidation - 1 h). Beside it, the REVIEW Q26-R31 "strict" form (alert before the liquidation).
  S2 liquidations with no TWAP touch, as their own class (not false alarms): count, alerts on them, share of R0 false
     alarms they make up, false alarms per borrower-week without them, and the share of all liquidation-ended
     episodes alerted >= 1 h before the liquidation.
  S3 the 2024 slice (episode-start year 2024; false alarms over 2024 position-days), with every year beside it.
  S4 per series (ETH vs BTC, and LINK, AAVE): events, recall, false alarms over the series' own position-days,
     median lead over early hits.
Intervals: r27_atrisk.Boot (two-way series x week and week-only, seed 20261025).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r27_atrisk as R  # noqa: E402

HOUR, DAY = 3600, 86400
THR = 0.03


def rr(v, d=4):
    return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), d)


def med(v):
    v = np.asarray(v, float)
    return rr(np.median(v), 2) if len(v) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nb", type=int, default=2000)
    a = ap.parse_args()
    Gz = np.load(os.path.join(a.work, "grids.npz"))
    series = [str(x) for x in Gz["series"]]
    ns = len(series)
    GR = {xi: (int(Gz[f"st{xi}"]), np.asarray(Gz[f"close{xi}"], float), np.asarray(Gz[f"low{xi}"], float))
          for xi in range(ns)}
    E = dict(np.load(os.path.join(a.work, "episodes.npz")))
    C = dict(np.load(os.path.join(a.work, "checks.npz")))
    D = dict(np.load(os.path.join(a.work, "denoms.npz")))
    nep = len(E["x"])
    x = E["x"].astype(int)
    est, tch, rs_, Lx, een = E["start"], E["touch"], E["reason"], E["L"], E["end"].astype(np.int64)
    scored = (est >= R.T_SC) & (est < R.T_HI + DAY)
    pdx, pdd = D["pd_key"] // 10**6, (D["pd_key"] % 10**6) * DAY
    sc_pd = (pdd >= R.T_SC) & (pdd <= R.T_HI)
    pdn = D["pd_n"].astype(float)
    BW = float(pdn[sc_pd].sum()) / 7.0
    ep, c, d = C["ep"].astype(int), C["c"], C["d"]
    # ---- touch target with the liquidation continuation: copied from r30_replicate.cmd_score ----
    cf = tch.copy()
    Xc = []
    liq_reason = R.REASONS.index("liq")
    for i in np.nonzero(scored & (rs_ == liq_reason))[0]:
        st, cl, lw = GR[x[i]]
        te = int(E["end"][i])
        bs = (te - st) // HOUR
        if st + bs * HOUR < te and lw[bs] <= Lx[i]:
            cf[i] = st + bs * HOUR
            continue
        c0 = ((te - st + HOUR - 1) // HOUR) * HOUR + st
        for kk_ in range(24):
            cc = c0 + kk_ * HOUR
            b = (cc - st) // HOUR
            if b < 1 or b >= len(cl) or not (np.isfinite(cl[b - 1]) and np.isfinite(lw[b])):
                break
            dd = 1 - Lx[i] / cl[b - 1]
            if dd > 0.10:
                break
            Xc.append((i, cc, dd))
            if lw[b] <= Lx[i]:
                cf[i] = cc
                break
    Xa = np.array(Xc, dtype=float).reshape(-1, 3)
    ep2 = np.r_[ep, Xa[:, 0].astype(int)]
    c2 = np.r_[c, Xa[:, 1].astype(np.int64)]
    d2 = np.r_[d, Xa[:, 2]]
    ev = (cf >= 0) & scored
    aa = np.full(nep, -1, np.int64)
    idx = np.nonzero(d2 <= THR)[0]
    # first check by time: sort the qualifying checks by (episode, time) first
    o = np.lexsort((c2[idx], ep2[idx]))
    idx = idx[o]
    uu, f = np.unique(ep2[idx], return_index=True)
    aa[uu] = c2[idx[f]]
    aa[~scored] = -1
    fired = aa >= 0
    hit = fired & ev
    lt = np.where(hit, (cf - aa) // HOUR, -999)
    early = hit & (lt >= 1)
    false = fired & ~ev
    liq = scored & (rs_ == liq_reason)
    lc = ev & (tch < 0) & liq                       # touch from the liquidation continuation
    strict1h = early & (~lc | (aa <= een - HOUR))
    strict0 = early & (~lc | (aa < een))            # alert before the liquidation (REVIEW Q26-R31 / R32 "strict")
    liq_nt = liq & ~ev                              # liquidation with no TWAP touch
    liq1h = fired & liq & (aa <= een - HOUR)
    weeks = np.arange(min(R.week_of(pdd[sc_pd]).min(), R.week_of(est[scored]).min()),
                      max(R.week_of(pdd[sc_pd]).max(), R.week_of(est[scored]).max()) + 1)
    BT = R.Boot(ns, weeks, a.nb)
    ewk = R.week_of(est)
    pwk = R.week_of(pdd)

    def cells(mask, v):
        return BT.cells(x[mask], ewk[mask], np.asarray(v, float)[mask])

    def pd_cells(mask):
        return BT.cells(pdx[mask], pwk[mask], pdn[mask])

    def ratio_ci(num, den, m=None):
        m = scored if m is None else m
        return BT.ci(cells(m, num), cells(m, den))

    out = {"what": "Q26 R33 secondary metrics, R0 3 %, not gating (registration section 5). Development until "
                   "published; registered replication, one run.",
           "series": series}
    nE = int(ev.sum())
    out["check_vs_score"] = {"events": nE, "alerts": int(fired.sum()), "early_hits": int(early.sum()),
                             "false_alarms": int(false.sum()), "recall_lead_ge_1h": rr(early.sum() / max(nE, 1)),
                             "fa_per_bw": rr(false.sum() / BW, 5)}
    # S1
    out["S1_recall_alert_ge_1h_before_aave_liquidation"] = {
        "definition": "early & (not liquidation-continuation touch, or alert <= Aave liquidation - 1 h)",
        "continuation_touches": int(lc.sum()), "early_hits_on_continuation": int((early & lc).sum()),
        "early_hits_after_or_within_1h_of_liquidation": int((early & lc & ~(aa <= een - HOUR)).sum()),
        "recall": rr(strict1h.sum() / max(nE, 1)),
        "ci": ratio_ci(strict1h, ev),
        "recall_alert_before_liquidation_any_lead": rr(strict0.sum() / max(nE, 1)),
        "early_hits_after_liquidation": int((early & lc & ~(aa < een)).sum())}
    # S2
    fa_ex = false & ~liq_nt
    out["S2_liquidations_without_touch"] = {
        "liquidation_ended_episodes": int(liq.sum()), "with_touch": int((liq & ev).sum()),
        "without_touch": int(liq_nt.sum()), "alerts_on_without_touch": int((fired & liq_nt).sum()),
        "share_of_R0_false_alarms": rr((fired & liq_nt).sum() / max(false.sum(), 1)),
        "fa_per_bw_registered": rr(false.sum() / BW, 5),
        "fa_per_bw_without_this_class": rr(fa_ex.sum() / BW, 5),
        "ci_fa_per_bw_without_this_class": BT.ci(7 * cells(scored, fa_ex), pd_cells(sc_pd)),
        "liquidation_target_alert_ge_1h_before": rr(liq1h.sum() / max(liq.sum(), 1)),
        "ci_liquidation_target": ratio_ci(liq1h, liq),
        "without_touch_alert_ge_1h_before": rr((liq1h & liq_nt).sum() / max(liq_nt.sum(), 1))}
    # S3 per year (2024 is the registered slice)
    yr_e = np.array([dt.datetime.fromtimestamp(int(t), dt.timezone.utc).year for t in est])
    yr_p = np.array([dt.datetime.fromtimestamp(int(t), dt.timezone.utc).year for t in pdd])
    years = {}
    for y in (2023, 2024, 2025, 2026):
        m, mp = scored & (yr_e == y), sc_pd & (yr_p == y)
        bwy = float(pdn[mp].sum()) / 7.0
        ne = int((ev & m).sum())
        r = {"events": ne, "alerts": int((fired & m).sum()), "early_hits": int((early & m).sum()),
             "recall_lead_ge_1h": rr((early & m).sum() / ne) if ne else None,
             "recall_alert_ge_1h_before_liq": rr((strict1h & m).sum() / ne) if ne else None,
             "fa_per_bw": rr((false & m).sum() / bwy, 5) if bwy else None,
             "median_lead_h_early_hits": med(lt[early & m])}
        if y == 2024 and ne:
            r["ci_recall"] = ratio_ci(early, ev, m)
        years[str(y)] = r
    out["S3_by_year"] = years
    # S4 per series
    ser = {}
    for xi, nm in enumerate(series):
        m, mp = scored & (x == xi), sc_pd & (pdx == xi)
        bws = float(pdn[mp].sum()) / 7.0
        ne = int((ev & m).sum())
        r = {"events": ne, "alerts": int((fired & m).sum()), "early_hits": int((early & m).sum()),
             "recall_lead_ge_1h": rr((early & m).sum() / ne) if ne else None,
             "recall_alert_ge_1h_before_liq": rr((strict1h & m).sum() / ne) if ne else None,
             "fa_per_bw": rr((false & m).sum() / bws, 5) if bws else None,
             "median_lead_h_early_hits": med(lt[early & m]), "position_days": int(pdn[mp].sum())}
        if ne:
            r["ci_recall_week_only"] = ratio_ci(early, ev, m)["ci90_week"]
        ser[nm] = r
    out["S4_by_series"] = ser
    out["bootstrap"] = {"draws": a.nb, "series_units": ns,
                        "series_with_touches": int(sum(1 for v in ser.values() if v["events"] > 0)),
                        "weeks": int(len(weeks)), "seed": R.SEED_BOOT}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
