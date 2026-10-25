"""Q26 R29: borrower alerts and odds re-scored against Membrane's ACTUAL liquidation rule (8 h delay timer).
DEVELOPMENT ONLY (seen): Aave V3 Polygon label-B rows of R11.1-v5, the D13 III grids, the R27 episodes and checks.

Design, the pinned timer rule (membrane-solidity file:line), event definitions, metrics, null and judgement rules:
membrane-board design/q26-r29-membrane-timer-2026-10-25.md (registered before any score of this script).

  python3 r29_timer.py selftest
  python3 r29_timer.py score --scr SCR --work R27WORK --out OUT [--nb 2000] [--nnull 2000]

SCR holds rows-labels.npz and fh-dense.npz (read only). R27WORK holds the R27 episodes, checks, denominators and grids
(read only). OUT receives address-free aggregates only (r29-timer.json). No address, key or secret is read or written.

Membrane rule (default delayed mode), mapped to the hourly III proxy of the oracle TWAP. Bar b opens at st + 3600 b;
low[b] is the lowest 1 h TWAP value inside bar b, close[b] the value at its end. L is the frozen liquidation line.
  - touch: low[b] <= L (LTV > avgMaxLtv). A keeper call starts the timer inside bar b (timer start = touch).
  - immediate: low[b] <= L / IMM (LTV > avgMaxLtv * (1 + maxThresholdToDelay)), IMM = 1.04 at launch.
    Without a timer this is outcome Immediate; with an armed timer it is BrokeWindow. Both liquidate at once.
  - expiry: the timer started in bar j expires inside bar j + 8. If the TWAP is past the line there (low <= L),
    a keeper liquidates (DelayExpired).
  - clearing, variant "hourly" (primary): anyone may clear a timer once the position is back under the line. An
    hourly checker clears it at the first bar end with close > L before expiry. A later touch starts a fresh timer.
  - clearing, variant "none" (upper bound): nobody clears. Any bar j+8 .. j+15 with low <= L liquidates; at j + 16 the
    stale-timer amnesty clears the timer and the bar is classified fresh.
  Event time of M is the END of the bar in which it happens (conservative for "by horizon H").
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))

HOUR, DAY = 3600, 86400
DELAY_BARS = 8                    # LIQUIDATION_DELAY 28800 s
IMM_LAUNCH = 1.04                 # 1 + LAUNCH_THRESHOLD_TO_DELAY (4e16)
IMM_PERMISSIONLESS = 1.95         # 1 + 95e16 (Collateral.sol permissionless onboarding default)
HS = (6, 12, 24, 72, 168)         # label-B horizons in rows-labels.npz
H_DESC = (6, 24, 72, 168)
H_ODDS = (6, 24)
NEAR_BANDS = ((0.0, 0.02), (0.02, 0.05), (0.05, 0.10))
NEAR_NAMES = ["0-2%", "2-5%", "5-10%"]
DESC_BANDS = ((0.0, 0.01), (0.01, 0.02), (0.02, 0.035), (0.035, 0.05), (0.05, 0.10))
DESC_NAMES = ["0-1%", "1-2%", "2-3.5%", "3.5-5%", "5-10%"]
ALERT_D = (0.02, 0.03, 0.04, 0.05)
ACT_K = (1, 2, 4)
SHARE_MIN_TOUCH = 20              # walk-forward share: below this many fit touches in a band, use the pooled share
SEED_BOOT, SEED_NULL = 20261025, 7
KIND = {0: "none", 1: "immediate", 2: "broke_window", 3: "expiry", -1: "censored"}


# =====================================================================================================================
# Membrane timer state machine (pure; unit-tested on synthetic paths in selftest)
# =====================================================================================================================
def msim(close, low, b0, b1, L, imm=IMM_LAUNCH, clear="hourly", dbars=DELAY_BARS):
    """Run the delayed-mode rule on bars b0 .. b1-1 with no armed timer at b0.

    Returns (m_bar, kind, first_touch_bar, own): m_bar = bar in which M happens (-1 none), kind (see KIND),
    first_touch_bar (-1 none), own = True iff M came from the FIRST timer (or an immediate breach before any timer)."""
    Li = L / imm
    timer = -1
    first = -1
    n_timers = 0
    b = b0
    while b < b1:
        lw = low[b]
        cl = close[b]
        if not (np.isfinite(lw) and np.isfinite(cl)):
            return -1, -1, first, False
        if timer < 0:
            if lw <= Li:
                if first < 0:
                    first = b
                return b, 1, first, n_timers == 0
            if lw <= L:
                timer = b
                n_timers += 1
                if first < 0:
                    first = b
                if clear == "hourly" and cl > L:
                    timer = -1
            b += 1
            continue
        off = b - timer
        if clear == "none" and off >= 2 * dbars:
            timer = -1                      # stale-timer amnesty: classify this bar fresh
            continue
        if lw <= Li:
            return b, 2, first, n_timers == 1
        if clear == "hourly":
            if off == dbars:
                if lw <= L:
                    return b, 3, first, n_timers == 1
                timer = -1
            elif cl > L:
                timer = -1
        else:
            if off >= dbars and lw <= L:
                return b, 3, first, n_timers == 1
        b += 1
    return -1, 0, first, False


def selftest():
    L = 100.0

    def path(lows, closes=None):
        lw = np.asarray(lows, float)
        return (np.asarray(closes, float) if closes is not None else lw.copy()), lw

    # 1. below the line for 9 bars from bar 2 -> expiry in bar 10
    c, lw = path([105, 103] + [99] * 9 + [104] * 5)
    assert msim(c, lw, 0, len(lw), L)[:3] == (10, 3, 2), msim(c, lw, 0, len(lw), L)
    # 2. touch at bar 2, close recovers at bar 4 -> cleared; no M (hourly); none-variant: liquidated at bar 10 low
    lows = [105, 103, 99, 99, 99, 104, 104, 104, 104, 104, 99.5, 104, 104]
    closes = [105, 103, 99, 99, 101, 104, 104, 104, 104, 104, 101, 104, 104]
    c, lw = path(lows, closes)
    assert msim(c, lw, 0, len(lw), L)[:2] == (-1, 0)
    assert msim(c, lw, 0, len(lw), L, clear="none")[:2] == (10, 3)
    # 3. immediate: low <= L / 1.04 without a timer
    c, lw = path([105, 96.0, 104])
    assert msim(c, lw, 0, 3, L)[:2] == (1, 1)
    # 4. touch then deeper drop inside the window -> broke window
    c, lw = path([105, 99, 98, 95.0, 99, 99])
    assert msim(c, lw, 0, 6, L)[:2] == (3, 2)
    # 5. no-clear amnesty at j+16 then a fresh timer that expires
    lows = [99] + [104] * 15 + [99] * 9
    c, lw = path(lows)
    r = msim(c, lw, 0, len(lw), L, clear="none")
    assert r[:2] == (24, 3) and r[3] is False, r
    # 6. horizon: expiry outside b1 -> no M
    c, lw = path([99] * 9)
    assert msim(c, lw, 0, 8, L)[:2] == (-1, 0) and msim(c, lw, 0, 9, L)[:2] == (8, 3)
    # 7. hourly: touch bar closes above the line -> cleared at once; re-touch later starts fresh, own False
    lows = [99, 104, 99] + [99] * 8
    closes = [101, 104, 99] + [99] * 8
    c, lw = path(lows, closes)
    r = msim(c, lw, 0, len(lw), L)
    assert r[:3] == (10, 3, 0) and r[3] is False, r
    # 8. permissionless window 95 %: a 5 % breach is not immediate
    c, lw = path([96.0] * 9)
    assert msim(c, lw, 0, 9, L, imm=IMM_PERMISSIONLESS)[:2] == (8, 3)
    # 9. censored
    c, lw = path([105, np.nan, 99])
    assert msim(c, lw, 0, 3, L)[1] == -1
    print("selftest ok (9 cases)")


# =====================================================================================================================
# helpers
# =====================================================================================================================
def rr(v, d=4):
    return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), d)


def Rr(p, y):
    sy = float(np.sum(y))
    return float(np.sum(p) / sy) if sy > 0 else None


def q3(v):
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    return [float(x) for x in np.quantile(v, [0.25, 0.5, 0.75])] if len(v) else None


def cmd_score(a):
    import r27_atrisk as R
    import r23_nearline as N
    t0 = time.time()
    df = os.statvfs("/")
    print(f"free {df.f_bavail * df.f_frsize / 1e9:.2f} GB", flush=True)
    Gz = np.load(os.path.join(a.work, "grids.npz"))
    series = [str(x) for x in Gz["series"]]
    ns = len(series)
    GR = {xi: (int(Gz[f"st{xi}"]), np.asarray(Gz[f"close{xi}"], float), np.asarray(Gz[f"low{xi}"], float),
               np.asarray(Gz[f"u6{xi}"], float)) for xi in range(ns)}
    # full-sample (label period) u6 tercile edges per series: descriptive vol state only
    vedge = {}
    for xi in range(ns):
        st, cl, lo, u6 = GR[xi]
        ts = st + HOUR * np.arange(len(u6))
        v = u6[(ts >= R.T_LO) & (ts <= R.T_HI + DAY) & np.isfinite(u6)]
        vedge[xi] = np.quantile(v, [1 / 3, 2 / 3])

    def vterc(xi, b):
        u = GR[xi][3][b] if 0 <= b < len(GR[xi][3]) else np.nan
        return int(np.searchsorted(vedge[xi], u, side="right")) if np.isfinite(u) else -1

    OUT = {"what": "Q26 R29 Membrane 8 h timer re-score (development, Aave V3 Polygon label B, III proxy of the oracle "
                   "TWAP); design membrane-board design/q26-r29-membrane-timer-2026-10-25.md",
           "rule": {"delay_bars": DELAY_BARS, "imm_launch": IMM_LAUNCH, "imm_permissionless": IMM_PERMISSIONLESS,
                    "event_time": "end of the bar in which M happens"}}

    # =================================================================================================================
    # Part A: rows (positions at daily 00:00Z origins), M labels at 6 h, 1 d, 3 d, 7 d
    # =================================================================================================================
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    assert [str(x) for x in Z["series"]] == series
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    base = ~(hf0 < 1.0) & (single >= 0)
    rowsets = {}
    lab = {}
    for Hh in H_DESC:
        hj = HS.index(Hh)
        k = kX[:, hj]
        sub = base & (yB[:, hj] >= 0) & np.isfinite(k) & (k < 0) & (k > -0.10)
        vi = np.nonzero(sub)[0]
        kk = k[vi].astype(float)
        sx = single[vi].astype(int)
        dv = day[vi]
        yb = yB[vi, hj].astype(int)
        res = {}
        for var, imm, clear in (("M", IMM_LAUNCH, "hourly"), ("M_noclear", IMM_LAUNCH, "none"),
                                ("M_delayonly", IMM_PERMISSIONLESS, "hourly")):
            yM = np.zeros(len(vi), np.int8)
            kind = np.zeros(len(vi), np.int8)
            own = np.zeros(len(vi), bool)
            rep = 0
            for i in np.nonzero(yb == 1)[0]:
                st, cl, lo, _ = GR[sx[i]]
                b0 = (int(dv[i]) - st) // HOUR
                L = cl[b0 - 1] * (1.0 + kk[i])
                mb, kd, ft, ow = msim(cl, lo, b0, b0 + Hh, L, imm=imm, clear=clear)
                if ft < 0:
                    rep += 1               # label B says touch but no touch seen: reproduction failure
                yM[i] = 1 if mb >= 0 else (-1 if kd == -1 else 0)
                kind[i] = kd
                own[i] = ow
            res[var] = (yM, kind, own, rep)
        rowsets[Hh] = {"vi": vi, "k": kk, "sx": sx, "dv": dv, "yb": yb}
        lab[Hh] = res
        print(f"rows H={Hh}: near {len(vi):,} touches {int(yb.sum()):,} M {int((res['M'][0] == 1).sum()):,} "
              f"repro_fail {res['M'][3]} {time.time() - t0:.0f}s", flush=True)

    # ---- descriptive: touch -> M by distance at origin and vol state ----
    desc = {}
    for Hh in H_DESC:
        rs = rowsets[Hh]
        absk = -rs["k"]
        vt = np.array([vterc(int(x), (int(t) - GR[int(x)][0]) // HOUR) for x, t in zip(rs["sx"], rs["dv"])])
        e = {"near_rows": int(len(absk)), "touch_rows": int(rs["yb"].sum())}
        for var in ("M", "M_noclear", "M_delayonly"):
            yM, kind, own, rep = lab[Hh][var]
            t = rs["yb"] == 1
            ok = t & (yM >= 0)
            ev = {"censored_touch_rows": int((t & (yM < 0)).sum()), "repro_fail": int(rep),
                  "M_rows": int((yM == 1).sum()),
                  "share_touch_to_M": rr((yM[ok] == 1).mean()) if ok.any() else None,
                  "M_kind_share": {KIND[kd]: rr(((kind == kd) & (yM == 1)).sum() / max((yM == 1).sum(), 1))
                                   for kd in (1, 2, 3)},
                  "M_from_first_timer_share": rr((own & (yM == 1)).sum() / max((yM == 1).sum(), 1))}
            if var == "M":
                bd = {}
                for bi, (lo_, hi_) in enumerate(DESC_BANDS):
                    m = ok & (absk > lo_) & (absk <= hi_)
                    bd[DESC_NAMES[bi]] = {"touch_rows": int(m.sum()), "M_rows": int((yM[m] == 1).sum()),
                                          "share": rr((yM[m] == 1).mean()) if m.any() else None,
                                          "touch_rate": rr(t[(absk > lo_) & (absk <= hi_)].mean())}
                ev["by_distance_at_origin"] = bd
                vd = {}
                for tt in (0, 1, 2):
                    m = ok & (vt == tt)
                    vd[f"t{tt + 1}"] = {"touch_rows": int(m.sum()), "M_rows": int((yM[m] == 1).sum()),
                                        "share": rr((yM[m] == 1).mean()) if m.any() else None}
                ev["by_vol_tercile_u6_at_origin"] = vd
                cross = {}
                for bi, (lo_, hi_) in enumerate(NEAR_BANDS):
                    for tt in (0, 1, 2):
                        m = ok & (absk > lo_) & (absk <= hi_) & (vt == tt)
                        cross[f"{NEAR_NAMES[bi]}|t{tt + 1}"] = [int(m.sum()), rr((yM[m] == 1).mean()) if m.any()
                                                               else None]
                ev["band_x_vol_touch_rows_share"] = cross
            e[var] = ev
        desc[f"{Hh}h"] = e
    OUT["A_rows_touch_to_M"] = desc
    print(f"descriptive done {time.time() - t0:.0f}s", flush=True)

    # =================================================================================================================
    # Part B: odds at 6 h and 1 d — raw P(touch) and P(M) = P(touch) x walk-forward persist share, against M
    # =================================================================================================================
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    QS = np.asarray(R.QSTARTS, np.int64)
    odds = {}
    rng = np.random.default_rng(SEED_NULL)
    for Hh in H_ODDS:
        rs = rowsets[Hh]
        Hs = Hh * HOUR
        k, sx, dv, yb = rs["k"], rs["sx"], rs["dv"], rs["yb"]
        yM = lab[Hh]["M"][0]
        pf = np.full(len(k), np.nan)
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            ts_x, fh_x = F[key + "ts"], F[key + "fH"].astype(float)
            o = np.argsort(ts_x)
            ts_x, fh_x = ts_x[o], fh_x[o]
            m = np.nonzero(sx == xi)[0]
            j = np.searchsorted(ts_x, dv[m])
            jj = np.minimum(j, len(ts_x) - 1)
            nres = np.searchsorted(ts_x, dv[m] - Hs, side="right")
            g = (j < len(ts_x)) & (ts_x[jj] == dv[m]) & (nres >= 30)
            pf[m[g]] = N.interp(k[m[g]], levels, fh_x[jj[g]])
        absk = -k
        band = np.searchsorted([0.02, 0.05], absk, side="right")     # [0,2) [2,5) [5,10), as REVIEW Q26-R23
        qi = np.searchsorted(QS, dv, side="right") - 1
        res_ok = (yM >= 0) & np.isfinite(pf)
        # walk-forward persist share per scored quarter and band
        share = np.full(len(k), np.nan)
        shr_log = {}
        for q in range(len(QS)):
            fit = res_ok & (dv + Hs <= QS[q]) & (yb == 1)
            pooled = (yM[fit] == 1).mean() if fit.sum() >= SHARE_MIN_TOUCH else np.nan
            row = {"fit_touch": int(fit.sum()), "pooled": rr(pooled)}
            for b in range(3):
                fb = fit & (band == b)
                s = (yM[fb] == 1).mean() if fb.sum() >= SHARE_MIN_TOUCH else pooled
                share[(qi == q) & (band == b)] = s
                row[NEAR_NAMES[b]] = [int(fb.sum()), rr(s)]
            shr_log[R.qname(int(QS[q]))] = row
        sc = res_ok & (dv >= R.T_SC) & (dv <= R.T_HI) & np.isfinite(share)
        pM = pf * share
        sd = sx.astype(np.int64) * 10**7 + dv // DAY
        full = res_ok & (dv >= R.T_LO) & (dv <= R.T_HI)
        repro = {NEAR_NAMES[b]: rr(Rr(pf[full & (band == b)], yb[full & (band == b)])) for b in range(3)}
        e = {"A_full_label_period_all_positions_R_repro": repro, "scored_rows": int(sc.sum()), "touch": int(yb[sc].sum()), "M": int((yM[sc] == 1).sum()),
             "walk_forward_share": shr_log}
        arms = {"A_ptouch_vs_touch": (pf, yb.astype(float)), "B_ptouch_vs_M": (pf, (yM == 1).astype(float)),
                "C_pM_vs_M": (pM, (yM == 1).astype(float))}
        for an, (p, y) in arms.items():
            row = {}
            for b in range(3):
                m = sc & (band == b)
                row[NEAR_NAMES[b]] = {"n_pos": int(m.sum()), "sum_p": rr(p[m].sum(), 2), "y": int(y[m].sum()),
                                      "R": rr(Rr(p[m], y[m]))}
            row["pooled_0-10%"] = {"n_pos": int(sc.sum()), "sum_p": rr(p[sc].sum(), 2), "y": int(y[sc].sum()),
                                   "R": rr(Rr(p[sc], y[sc]))}
            e[an] = row
        # shared-price-path null for arms A and C: calibrated p, one uniform per series-day (comonotone positions);
        # day-shared bound: one uniform per date for all series
        u, inv = np.unique(sd[sc], return_inverse=True)
        dates = u % 10**7
        _, dinv = np.unique(dates, return_inverse=True)
        bsc = band[sc]
        for an in ("A_ptouch_vs_touch", "C_pM_vs_M"):
            p = arms[an][0][sc]
            nul = {}
            for mode in ("series_day", "date"):
                draws = {nm: [] for nm in NEAR_NAMES + ["pooled_0-10%"]}
                for _ in range(a.nnull):
                    Ud = rng.random(len(u)) if mode == "series_day" else rng.random(dinv.max() + 1)[dinv]
                    ys = (Ud[inv] < p).astype(float)
                    for b in range(3):
                        mb = bsc == b
                        draws[NEAR_NAMES[b]].append(Rr(p[mb], ys[mb]) or np.nan)
                    draws["pooled_0-10%"].append(Rr(p, ys) or np.nan)
                nul[mode] = {nm: [rr(np.nanquantile(v, 0.05)), rr(np.nanquantile(v, 0.95))] for nm, v in draws.items()}
            e[an]["null_q05_q95"] = nul
            obs = {nm: e[an][nm]["R"] for nm in NEAR_NAMES + ["pooled_0-10%"]}
            e[an]["under_warns_vs_null"] = {nm: {mode: (obs[nm] is not None and nul[mode][nm][0] is not None and
                                                        obs[nm] < nul[mode][nm][0]) for mode in nul}
                                            for nm in obs}
        odds[f"{Hh}h"] = e
        print(f"odds H={Hh} done {time.time() - t0:.0f}s", flush=True)
    OUT["B_odds"] = odds
    del Z, kX, yB, day, hf0, single

    # =================================================================================================================
    # Part C: alerts — R27 episodes on the TWAP-touch target (Aave liquidations ignored, 24 h continuation)
    # =================================================================================================================
    E = dict(np.load(os.path.join(a.work, "episodes.npz")))
    C = dict(np.load(os.path.join(a.work, "checks.npz")))
    D = dict(np.load(os.path.join(a.work, "denoms.npz")))
    nep = len(E["x"])
    x = E["x"].astype(int)
    est, tch, rs_, Lx = E["start"], E["touch"], E["reason"], E["L"]
    scored = (est >= R.T_SC) & (est < R.T_HI + DAY)
    pdx, pdd = D["pd_key"] // 10**6, (D["pd_key"] % 10**6) * DAY
    sc_pd = (pdd >= R.T_SC) & (pdd <= R.T_HI)
    PD = float(D["pd_n"][sc_pd].sum())
    BW = PD / 7.0
    ep, c, d = C["ep"].astype(int), C["c"], C["d"]
    # TWAP-touch target exactly as REVIEW Q26-R27 (rev_matched_cf.py): liquidation-ended scored episodes continue up
    # to 24 hourly checks on the same frozen line while d <= 10 %
    cf = tch.copy()
    X = []
    liq_reason = R.REASONS.index("liq")
    for i in np.nonzero(scored & (rs_ == liq_reason))[0]:
        st, cl, lw, _ = GR[x[i]]
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
            X.append((i, cc, dd))
            if lw[b] <= Lx[i]:
                cf[i] = cc
                break
    Xa = np.array(X, dtype=float).reshape(-1, 3)
    ep2 = np.r_[ep, Xa[:, 0].astype(int)]
    c2 = np.r_[c, Xa[:, 1].astype(np.int64)]
    d2 = np.r_[d, Xa[:, 2]]
    o = np.lexsort((c2, ep2))
    ep2, c2, d2 = ep2[o], c2[o], d2[o]
    ev_touch = (cf >= 0) & scored
    # M per touch: fresh state machine from the touch bar, M event time <= touch + 24 h (restarts allowed)
    TM = {v: np.full(nep, -1, np.int64) for v in ("M", "M_noclear")}
    KD = {v: np.zeros(nep, np.int8) for v in ("M", "M_noclear")}
    OWN = {v: np.zeros(nep, bool) for v in ("M", "M_noclear")}
    cens = {v: 0 for v in TM}
    for i in np.nonzero(ev_touch)[0]:
        st, cl, lw, _ = GR[x[i]]
        bT = (int(cf[i]) - st) // HOUR
        for v, clear in (("M", "hourly"), ("M_noclear", "none")):
            mb, kd, ft, ow = msim(cl, lw, bT, min(bT + 24, len(cl)), Lx[i], clear=clear)
            assert ft == bT, (i, ft, bT)
            if mb >= 0:
                TM[v][i] = st + (mb + 1) * HOUR
            if kd == -1:
                cens[v] += 1
            KD[v][i] = kd
            OWN[v][i] = ow
    BT = R.Boot(ns, np.arange(min(R.week_of(pdd[sc_pd]).min(), R.week_of(est[scored]).min()),
                              max(R.week_of(pdd[sc_pd]).max(), R.week_of(est[scored]).max()) + 1), a.nb)
    Spd = BT.cells(pdx[sc_pd], R.week_of(pdd[sc_pd]), D["pd_n"][sc_pd])
    ewk = R.week_of(est)

    # ---- descriptive per TWAP touch ----
    vt_touch = np.array([vterc(x[i], (int(cf[i]) - GR[x[i]][0]) // HOUR) if ev_touch[i] else -9 for i in range(nep)])
    dt_ = {}
    for v in TM:
        evM = (TM[v] >= 0) & ev_touch
        own1 = evM & OWN[v]
        r = {"touches": int(ev_touch.sum()), "censored": int(cens[v]), "M_within_24h": int(evM.sum()),
             "share_M_within_24h": rr(evM.sum() / ev_touch.sum()),
             "share_first_timer_M": rr(own1.sum() / ev_touch.sum()),
             "M_kind_count": {KIND[kd]: int((evM & (KD[v] == kd)).sum()) for kd in (1, 2, 3)},
             "hours_touch_to_M_q25_q50_q75": q3(((TM[v] - cf) / HOUR)[evM])}
        Sn = BT.cells(x[ev_touch], ewk[ev_touch], evM[ev_touch])
        Sd = BT.cells(x[ev_touch], ewk[ev_touch], np.ones(int(ev_touch.sum())))
        r["share_M_within_24h_ci"] = BT.ci(Sn, Sd)
        if v == "M":
            r["by_vol_tercile_u6_at_touch"] = {
                f"t{t + 1}": {"touches": int((ev_touch & (vt_touch == t)).sum()),
                              "share_M": rr((evM & (vt_touch == t)).sum() / max((ev_touch & (vt_touch == t)).sum(), 1))}
                for t in (0, 1, 2)}
            r["by_series"] = {series[xi]: {"touches": int((ev_touch & (x == xi)).sum()),
                                           "share_M": rr((evM & (x == xi)).sum() / max((ev_touch & (x == xi)).sum(),
                                                                                       1))} for xi in range(ns)}
        dt_[v] = r
    OUT["C0_twap_touches_to_M"] = dt_

    # ---- R0 alerts against M ----
    def first_fire(thr):
        aa = np.full(nep, -1, np.int64)
        idx = np.nonzero(d2 <= thr)[0]
        uu, f = np.unique(ep2[idx], return_index=True)
        aa[uu] = c2[idx[f]]
        aa[~scored] = -1
        return aa

    def alert_summary(aa, tm, ci=False):
        evM = (tm >= 0) & scored
        fired = aa >= 0
        hitM = fired & evM
        lt = np.where(hitM, (cf - aa) // HOUR, -999)          # lead to touch, bars (touch-bar open)
        lm = np.where(hitM, (tm - aa) / HOUR, np.nan)           # lead to M, hours
        early_t = hitM & (lt >= 1)
        early_m = hitM & (lm >= 1)
        false = fired & ~evM
        nM = int(evM.sum())
        out = {"M_events": nM, "alerts": int(fired.sum()), "false_alarms": int(false.sum()),
               "recall_lead_to_touch_ge_1h": rr(early_t.sum() / nM), "recall_lead_to_M_ge_1h": rr(early_m.sum() / nM),
               "recall_any": rr(hitM.sum() / nM), "precision_lead_to_touch_ge_1h": rr(early_t.sum() / fired.sum()),
               "precision_any": rr(hitM.sum() / fired.sum()), "fa_per_bw": rr(false.sum() / BW, 5),
               "lead_to_touch_h_q25_q50_q75_hits": q3(lt[hitM].astype(float)),
               "lead_to_M_h_q25_q50_q75_hits": q3(lm[hitM]),
               "share_M_events_lead_to_M_ge_8h": rr((hitM & (lm >= 8)).sum() / nM)}
        if ci:
            m = scored
            out["ci_recall_lead_to_touch_ge_1h"] = BT.ci(BT.cells(x[m], ewk[m], early_t[m]),
                                                         BT.cells(x[evM], ewk[evM], np.ones(nM)))["ci90_twoway"]
            out["ci_fa_per_bw"] = BT.ci(7 * BT.cells(x[m], ewk[m], false[m]), Spd)["ci90_twoway"]
            out["ci_precision_lead_to_touch_ge_1h"] = BT.ci(BT.cells(x[m], ewk[m], early_t[m]),
                                                            BT.cells(x[m], ewk[m], fired[m]))["ci90_twoway"]
        return out

    al = {}
    for v in TM:
        al[v] = {}
        for thr in ALERT_D:
            al[v][f"R0_{thr * 100:g}%"] = alert_summary(first_fire(thr), TM[v], ci=(v == "M" and thr == 0.03))
    # reference: the same alerts against the TWAP touch (reproduces REVIEW Q26-R27 numbers)
    al["reference_touch_target"] = {f"R0_{thr * 100:g}%": alert_summary(first_fire(thr), np.where(ev_touch, cf, -1))
                                    for thr in ALERT_D}
    OUT["C1_alerts_vs_M"] = al

    # ---- "timer started" as the alert, and act-within-k ----
    ts_ = {}
    for v in TM:
        evM = (TM[v] >= 0) & ev_touch
        mbar_off = np.where(evM, (TM[v] - cf) // HOUR - 1, -1)    # bar offset of the M bar from the touch bar
        nM = int(evM.sum())
        r = {"alerts_timer_started": int(ev_touch.sum()), "M_events": nM,
             "precision": rr(nM / ev_touch.sum()), "fa_per_bw": rr((ev_touch & ~evM).sum() / BW, 5),
             "alerts_per_1000bw": rr(1000 * ev_touch.sum() / BW, 2),
             "lead_timer_start_to_M_h_q25_q50_q75": q3(((TM[v] - cf) / HOUR)[evM])}
        act = {}
        for kk_ in ACT_K:
            cons = evM & (mbar_off >= kk_ + 1)        # M bar opens at least k h after the end of the touch bar
            opt = evM & (mbar_off >= kk_)              # M bar opens at least k h after the touch-bar open
            act[f"k{kk_}h"] = {"avoid_share_conservative": rr(cons.sum() / nM),
                               "avoid_share_optimistic": rr(opt.sum() / nM)}
        r["act_within_k_after_timer_start_avoids_M"] = act
        r["M_in_touch_bar_share"] = rr((evM & (mbar_off == 0)).sum() / nM)
        ts_[v] = r
    # R0 3 % alert then act within k of the alert, for comparison: avoided iff the M bar opens >= alert time + k h
    a3 = first_fire(0.03)
    evM = (TM["M"] >= 0) & scored
    hit = evM & (a3 >= 0)
    ts_["R0_3%_then_act_within_k_of_alert_avoids_M_share_of_all_M"] = {
        f"k{kk_}h": rr((hit & ((TM["M"] - HOUR) - a3 >= kk_ * HOUR)).sum() / evM.sum()) for kk_ in ACT_K}
    ts_["R0_3%_or_timer_started_then_act_within_k_avoids_M_share_of_all_M"] = {
        f"k{kk_}h": rr((evM & (((a3 >= 0) & ((TM["M"] - HOUR) - a3 >= kk_ * HOUR)) |
                               ((TM["M"] - cf) // HOUR - 1 >= kk_ + 1))).sum() / evM.sum()) for kk_ in ACT_K}
    OUT["C2_timer_started_alert"] = ts_
    OUT["episodes"] = {"scored": int(scored.sum()), "twap_touches": int(ev_touch.sum()),
                       "position_days_scored": int(PD), "continued_checks": int(len(Xa))}
    os.makedirs(a.out, exist_ok=True)
    json.dump(OUT, open(os.path.join(a.out, "r29-timer.json"), "w"), indent=1)
    print(f"done {time.time() - t0:.0f}s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("selftest")
    s = sp.add_parser("score")
    s.add_argument("--scr", required=True)
    s.add_argument("--work", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--nb", type=int, default=2000)
    s.add_argument("--nnull", type=int, default=2000)
    a = ap.parse_args()
    if a.cmd == "selftest":
        selftest()
    else:
        cmd_score(a)


if __name__ == "__main__":
    main()
