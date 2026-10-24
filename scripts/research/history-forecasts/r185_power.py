#!/usr/bin/env python3
"""Q26 R18.5 step 2: synthetic power check for exogenous supply-rate instruments (RF changes; incentive switches).

membrane-board design/Q26_ROUND18_PREREG.md R18.5 (registered before the run seeds are used). Development only.

DGP ("Sim5"): ten hourly R18.4 pools (r184_kernel.Sim4 dynamics, design P confounders: activity regime, news with
informed exit + wave + deposit hit + deleveraging repay surge, dominant repeat unit with an unlinked alias, mean-
reverting borrow-demand level, partial retry of blocked borrows, endogenous slope1 retargets toward the benchmark)
plus:
  - a common benchmark, a common ETH |return| series, common news (all markets) on top of idiosyncratic news, and a
    half-common activity regime;
  - whale round trips (calibrated per market to the seen q99 of |7-day log supply change|; off in the light world);
  - the counted RF schedule (r185-rf-events.csv: same market, day and supply-rate dose at the pre-change
    utilisation: the RF step is set so that borrowRate(u)*u*dRF equals the counted dose at the simulated u) and the
    counted incentive schedule (r185-incentive-events.csv; incentive APR level winsorised to [0, 5] points);
  - a KNOWN deposit response to the supply-rate spread: D += kD * Sref * EMA(zD), zD = supply rate + incentive APR
    - benchmark, linear (no saturation, no asymmetry). Repays keep P's borrow-rate response (kR), which RF and
    incentives do not move. kD_real is calibrated so that the paired-simulation 7-day truth per point equals the
    R18.4 SRDR deposit equation's 7-day cumulative response per point of supply-rate change (0.0268).

Truth (per event): paired simulation from the pre-event state with the event removed (common random numbers);
truth_k = log S_main - log S_cf at the k-day read; pooled per point as sum(d*T)/sum(d^2) (the OLS weighting).

Estimator (frozen at registration): daily panel local projection (continuous-treatment DiD event study)
  y_k = log S(d-1+k) - log S(d-1) on dose_d (points) with market and date fixed effects and controls:
  u, (u-kink)+, its square at d-1; mean u and mean (u-kink)+ over days d-4..d-2, d-11..d-5, d-31..d-12; supply rate
  (+ incentive) at d-1; activity proxies (mean |dlog S| and |dlog debt| over 1-7 and 8-30 days); lagged changes;
  ETH |return| proxies (news); the k-day pre-trend. Rows within [d_e-8, d_e+14] of any other event in the same
  market are dropped. SE: two-way cluster (market, date), CI with t(G-1), G = min(#markets, #dates).
  A = RF clean events only (primary). B = RF + incentive clean events (reported; pooled valuation assumption).

  python3 r185_power.py calib-kd  --events <dir> --datasets <ds>
  python3 r185_power.py calib-whale --events <dir> --datasets <ds>
  python3 r185_power.py run --events <dir> --datasets <ds> --world cal|light --scale 1 --reps R --seed0 S --out f.json
No address is read or written.
"""
import argparse
import copy
import json
import zlib
import os
import sys
from datetime import date
from multiprocessing import Pool

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r183_kernel as K  # noqa: E402
import r184_engine as E  # noqa: E402
import r184_kernel as K4  # noqa: E402

DAY0 = date(2022, 3, 12)
NDAY = 1681                     # 2022-03-12 .. 2026-10-17
BURN = 60                       # burn-in days before DAY0
H0 = BURN * 24
NH = H0 + 24 * (NDAY + 1)
KS = (3, 7)
KMAX = 7
SRDR_PER_PT = {3: 0.0151, 7: 0.0268}   # R18.4 SRDR deposit equation, cumulative per point (r185 calc, see prereg)
INC_CAP = 5.0                   # incentive APR level winsorised at 5 points in the DGP
WIN_PRE, WIN_POST = KMAX + 1, 14
MARKETS = ["core-usdc", "core-usdt", "v3-arb-usdc", "v3-arb-usdce", "v3-avax-usdc", "v3-base-usdc", "v3-op-usdc",
           "v3-op-usdce", "v3-poly-usdc", "v3-poly-usdce"]
# seen-data descriptives (r185 calc on seen daily totals; RF/incentive windows +-10 d excluded): start, end, median u,
# kink, q99 of |7-day log supply change - median|; Q5090 below holds q50 and q90 of the same
MKT = {
    "core-usdc": ("2023-02-01", "2026-10-07", 0.863, 0.92, 0.462),
    "core-usdt": ("2023-02-14", "2026-10-07", 0.802, 0.92, 1.394),
    "v3-arb-usdc": ("2023-07-24", "2026-10-17", 0.821, 0.90, 0.431),
    "v3-arb-usdce": ("2022-09-01", "2026-10-17", 0.800, 0.90, 0.365),
    "v3-avax-usdc": ("2022-03-18", "2026-10-17", 0.810, 0.90, 0.489),
    "v3-base-usdc": ("2023-12-22", "2026-10-17", 0.823, 0.90, 0.687),
    "v3-op-usdc": ("2023-11-29", "2026-10-17", 0.816, 0.90, 0.623),
    "v3-op-usdce": ("2022-03-17", "2026-10-17", 0.655, 0.90, 0.786),
    "v3-poly-usdc": ("2023-12-22", "2026-10-17", 0.706, 0.90, 0.541),
    "v3-poly-usdce": ("2022-03-17", "2026-10-17", 0.805, 0.90, 0.392),
}
Q5090 = {"core-usdc": (0.0289, 0.1093), "core-usdt": (0.0481, 0.1799), "v3-arb-usdc": (0.0389, 0.1210),
         "v3-arb-usdce": (0.0298, 0.1177), "v3-avax-usdc": (0.0314, 0.1200), "v3-base-usdc": (0.0406, 0.1788),
         "v3-op-usdc": (0.0245, 0.1064), "v3-op-usdce": (0.0283, 0.1557), "v3-poly-usdc": (0.0186, 0.0819),
         "v3-poly-usdce": (0.0368, 0.1218)}
dix = lambda s: (date.fromisoformat(s) - DAY0).days
# calibrated at registration (calib-kd / calib-whale; truth and noise descriptives only, calib seeds 990000+)
KD_REAL = None
WHALE_MED = {}


def base_cfg(m, kD, fR=1.0):
    st, en, u0, kink, _ = MKT[m]
    return dict(K4._BASE, n=NH, S0=1e9, u0=u0, RF=0.10, curves=[(0, kink, 0.05, 0.60)], retargets=(),
                s2_change=None, bench_shift=None, act_hi=2.5, act_stay=300, week_amp=0.20, d0=9.4e-4, w0=8e-4,
                rp0=7.2e-4, b0=8.1e-4 * u0 / 0.86, sig=1.0, big_p=0.003, big_scale=0.0035 * fR, resp="linear", c=0.06,
                asym=1.0, kD=kD, kR=0.004, kB=0.002, lag="ema1", lag_a=0.92, bench=(0.032, 0.9998, 1e-4),
                zr_off=0.010, news_rate=1 / 1200, inf_lo=0.01, inf_hi=0.035, wave_lo=0.015, wave_hi=0.04,
                wave_win=(6, 60), dep_hit=0.5, dep_tau=30.0, news_rp=1.0, news_rp_tau=24.0, R_p=1 / 48,
                R_lo=0.015 * fR, R_hi=0.04 * fR, R_delay=36, R_alias=0.25, lvl_hl=240.0, lvl_sd=0.15, rp_lvl=0.5, retry=0.5,
                retry_mean=6.0, seed0=0)


class Common:
    """Shared series: benchmark, ETH |return|, common news, common activity regime."""

    def __init__(self, seed):
        rng = np.random.default_rng(seed)
        n = NH
        x = np.zeros(n)
        e = rng.normal(0, 1e-4, n)
        for i in range(1, n):
            x[i] = 0.9998 * x[i - 1] + e[i]
        self.bench = 0.032 + x
        vol = np.exp(np.convolve(rng.normal(0, 0.15, n), np.ones(48) / 48, "same"))
        self.eth = np.abs(rng.standard_t(4, n)) * vol * 0.006
        self.news = np.where(rng.random(n) < 1 / 1200)[0]
        for tau in self.news:
            self.eth[tau:min(n, tau + 6)] *= 3.0
        st = np.zeros(n)
        s = 0
        sw = rng.random(n)
        for i in range(1, n):
            if sw[i] < 1 / 300:
                s = 1 - s
            st[i] = s
        self.act = st


class Sim5(K4.Sim4):
    """Sim4 with a time-varying RF, an incentive APR term in the deposit spread, whale round trips, and shared
    benchmark / ETH / news / activity. All randomness drawn up front (paired re-runs are exact)."""

    def __init__(self, cfg, seed, com, whale_med, events, mkt_seed):
        super().__init__(cfg, seed)
        c = self.c
        n = self.n
        rng = np.random.default_rng(seed + 55)
        self.bench = com.bench.copy()
        self.eth = com.eth.copy()
        own = (np.log(c["act_hi"]) * 0.5 * (com.act + (np.log(self.A / np.exp(c["week_amp"] * np.sin(
            2 * np.pi * np.arange(n) / 168))) > 1e-9)))
        self.A = np.exp(own + c["week_amp"] * np.sin(2 * np.pi * np.arange(n) / 168))
        for tau in com.news:        # common news on top of the idiosyncratic news drawn by Sim4
            f = rng.uniform(0.5, 1.5)
            self.inf[tau] += f * rng.uniform(c["inf_lo"], c["inf_hi"])
            a, b = c["wave_win"]
            hrs = np.arange(tau + a, min(n, tau + b + 1))
            if len(hrs):
                self.wave[hrs] += f * rng.uniform(c["wave_lo"], c["wave_hi"]) * rng.dirichlet(np.ones(len(hrs)))
            k = np.arange(tau + 1, min(n, tau + 97))
            self.dmult[k] *= 1 - c["dep_hit"] * np.exp(-(k - tau) / c["dep_tau"])
            self.rmult[k] *= 1 + c["news_rp"] * np.exp(-(k - tau) / c["news_rp_tau"])
        # three endogenous slope1 retargets toward the benchmark at market-specific hours
        for h0 in np.sort(rng.choice(np.arange(H0 + 2000, n - 2000), 3, replace=False)):
            o = self.opt[h0]
            self.s1[h0:] = (self.bench[h0] + 0.004) * o / (0.88 * 0.88 * (1 - c["RF"]))
        # whales: daily rate 1/200, lognormal size (sigma 1.2, median whale_med of supply, cap 0.3), sign +-,
        # round trip of the EXECUTED amount after U(1,45) days with prob 0.7
        self.wh = np.zeros(n)
        self.whback = {}
        if whale_med > 0:
            hrs = np.where(rng.random(n) < 1 / (200 * 24))[0]
            for h in hrs:
                sz = min(whale_med * np.exp(rng.normal(0, 1.2)), 0.3)
                sg = 1.0 if rng.random() < 0.5 else -1.0
                self.wh[h] += sg * sz
                if rng.random() < 0.7:
                    hb = int(h + rng.integers(24, 45 * 24))
                    if hb < n:
                        self.whback.setdefault(hb, []).append((-sg, h))
        self.events = {}            # hour -> list of (kind, value)
        for ev in events:
            self.events.setdefault(ev["hour"], []).append(ev)

    def init_state(self):
        st = super().init_state()
        st.update({"RF": self.c["RF"], "inc": 0.0, "whsz": {}})
        return st

    def apply_events(self, st, t, skip=None):
        for ev in self.events.get(t, ()):
            if skip is not None and ev["id"] == skip:
                continue
            if ev["kind"] == "rf":
                u = st["Dbt"] / st["S"]
                r = float(K.curve_rate(u, self.opt[t], self.s1[t], self.s2[t]))
                st["RF"] = float(np.clip(st["RF"] - ev["dose"] / 100.0 / max(r * u, 1e-6), 0.0, 0.99))
            else:
                st["inc"] = ev["level"] / 100.0

    def step(self, st, t, extra=0.0, rec=None):
        c = self.c
        S, Dbt = st["S"], st["Dbt"]
        Sr, Dr = st["Sref"], st["Dref"]
        A, cy = self.A[t], self.cyc[t]
        mrD = (c["S0"] / Sr) ** c["mr"]
        mrB = (c["S0"] * c["u0"] / Dr) ** c["mr"]
        lv = self.lvl[t]
        yD, yR = st["yD1"], st["yR1"]
        D = max(c["d0"] * Sr * A * cy * self.eD[t] * self.dmult[t] * mrD + c["kD"] * Sr * yD, 0.0)
        Rp = max(c["rp0"] * Dr * A * cy * self.eR[t] * self.rmult[t] * np.exp(-c["rp_lvl"] * lv) + c["kR"] * Dr * yR, 0.0)
        Bnew = max(c["b0"] * Dr * A * cy * self.eB[t] * mrB * np.exp(lv) - c["kB"] * Dr * yR, 0.0)
        DR = 0.0
        keep = []
        for (hh, amt, al) in st["Rpend"]:
            if hh <= t:
                DR += amt
            else:
                keep.append((hh, amt, al))
        st["Rpend"] = keep
        # whales: deposits now, withdrawals queued; round trips reverse the executed amount
        wdep, wwd = 0.0, 0.0
        if self.wh[t] > 0:
            wdep = self.wh[t] * S
            st["whsz"][t] = wdep
        elif self.wh[t] < 0:
            wwd = -self.wh[t] * S
            st["whsz"][t] = 0.0           # filled with the executed amount in the queue loop
        for (sg, h0) in self.whback.get(t, ()):
            amt = st["whsz"].pop(h0, 0.0)
            if sg > 0:
                wdep += amt
            elif amt > 0:
                wwd += amt
        Rp = min(Rp, Dbt)
        S += D + DR + wdep
        Dbt -= Rp
        cash = S - Dbt
        q = st["q"]
        q.append([0, c["w0"] * Sr * A * cy * self.eW[t], 0, 0])
        if self.big[t] > 0:
            q.append([1000 + t, self.big[t] * Sr, 0, 0])
        if self.inf[t] > 0:
            q.append([100000 + t, self.inf[t] * Sr, 0, 0])
        if self.wave[t] > 0:
            q.append([200000 + t, self.wave[t] * Sr, 0, 0])
        if self.Rf[t]:
            q.append([1, self.Rsz[t] * Sr, int(self.Rdl[t]), int(self.Ral[t])])
        if wwd > 0:
            q.append([300000 + t if self.wh[t] < 0 else 400000 + t, wwd, 0, 0])
        Wx = 0.0
        while q and cash > 1e-6:
            u_, amt, dl, al = q[0]
            e = min(amt, cash)
            cash -= e
            S -= e
            Wx += e
            if 300000 <= u_ < 400000 and (u_ - 300000) in st["whsz"]:
                st["whsz"][u_ - 300000] += e
            if e >= amt - 1e-9:
                q.pop(0)
                if u_ == 1:
                    st["Rpend"].append((t + dl, e + st["Racc"], al))
                    st["Racc"] = 0.0
            else:
                q[0][1] = amt - e
                if u_ == 1:
                    st["Racc"] += e
                break
        rel = st["pool"] / c["retry_mean"] if c["retry"] > 0 else 0.0
        st["pool"] -= rel
        Bd = Bnew + rel
        Bx, blk = E.cap_borrows(cash, Bd)
        Bx, blk = float(Bx), float(blk)
        if c["retry"] > 0:
            st["pool"] += c["retry"] * blk
        Dbt += Bx
        st["S"], st["Dbt"] = S, Dbt
        st["Sref"] += (S - st["Sref"]) / 720.0
        st["Dref"] += (Dbt - st["Dref"]) / 720.0
        u = Dbt / S
        r = K.curve_rate(u, self.opt[t], self.s1[t], self.s2[t])
        zD = r * u * (1 - st["RF"]) + st["inc"] - self.bench[t]
        zR = r - (self.bench[t] + c["zr_off"])
        a = c["lag_a"]
        st["yD1"] = a * st["yD1"] + (1 - a) * zD
        st["yR1"] = a * st["yR1"] + (1 - a) * zR
        return S, Dbt

    def run_main(self, keep_snap):
        n = self.n
        st = self.init_state()
        Sx, Dx, RFx, INCx = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
        snaps = {}
        for t in range(n):
            if t in keep_snap:
                snaps[t] = copy.deepcopy(st)
            self.apply_events(st, t)
            self.step(st, t)
            Sx[t], Dx[t], RFx[t], INCx[t] = st["S"], st["Dbt"], st["RF"], st["inc"]
        return Sx, Dx, RFx, INCx, snaps

    def run_seg(self, s0, t0, t1, skip):
        st = copy.deepcopy(s0)
        out = np.zeros(t1 - t0)
        for t in range(t0, t1):
            self.apply_events(st, t, skip=skip)
            self.step(st, t)
            out[t - t0] = st["S"]
        return out


# ------------------------------------------------------------------------------------------------ event schedules
def read_hour(d):
    """Hour index whose end state is the day-d read (last block before d 00:00Z)."""
    return H0 + 24 * d - 1


def load_events(evdir, datasets):
    rf = pd.read_csv(os.path.join(evdir, "r185-rf-events.csv"))
    inc = pd.read_csv(os.path.join(evdir, "r185-incentive-events.csv"))
    # curve-change and frozen days for incentive cleanliness (same config series as r185_events)
    from r185_events import core_series, l2_series  # noqa
    import glob
    r118 = os.path.join(datasets, "history-forecasts/r11/r118-inputs-9ab156bb")
    cfg = {}
    for p in sorted(glob.glob(os.path.join(r118, "daily-v3-*.csv.gz"))):
        nm = os.path.basename(p)[6:-7]
        m = l2_series(p, "2000-01-01").reset_index(drop=True)
        cc = (m[["opt", "base", "s1", "s2"]].diff().abs() > 1e-9).any(axis=1)
        cc.iloc[0] = False
        cfg[nm] = (set(m.loc[cc, "date"].dt.strftime("%Y-%m-%d")), set(m.loc[m["frozen"] > 0, "date"].dt.strftime("%Y-%m-%d")))
    allsw = {}
    for _, r in rf.iterrows():
        allsw.setdefault(r["market"], []).append(dix(r["date"]))
    for _, r in inc.iterrows():
        allsw.setdefault(r["market"], []).append(dix(r["date"]))
    evs = []
    for i, r in rf.iterrows():
        evs.append({"id": f"rf{i}", "kind": "rf", "market": r["market"], "day": dix(r["date"]),
                    "dose": float(r["rf_dose_pts"]), "clean": bool(r["clean"])})
    lvl = {}
    for i, r in inc.sort_values("date").iterrows():
        m = r["market"]
        if pd.isna(r["dose_pts"]):
            continue
        post = float(np.clip(r["incentive_apr_pre_pts"] + r["dose_pts"], 0.0, INC_CAP))
        pre = lvl.get(m, 0.0)
        lvl[m] = post
        d = dix(r["date"])
        st, en = dix(MKT[m][0]), dix(MKT[m][1])
        near = [x for x in allsw[m] if x != d and abs(x - d) <= 7]
        cc, fz = cfg.get(m, (set(), set()))
        dd = lambda k: (DAY0.toordinal() + k)
        win = {date.fromordinal(dd(d + j)).isoformat() for j in range(-7, 8)}
        clean = (abs(post - pre) >= 0.10 and d - 32 >= st and d + KMAX <= en and not near
                 and r["date"] not in cc and not (win & fz))
        evs.append({"id": f"inc{i}", "kind": "inc", "market": m, "day": d, "level": post, "dose": post - pre,
                    "clean": bool(clean), "raw_dose": float(r["dose_pts"])})
    return evs


def scaled_events(evs, scale, rng):
    """Informational count scan: add (scale-1) x the clean RF events as copies at random clean days in random markets
    (doses resampled from the counted clean RF doses)."""
    if scale <= 1:
        return evs
    cl = [e for e in evs if e["kind"] == "rf" and e["clean"]]
    out = list(evs)
    taken = {(e["market"], e["day"]) for e in evs}
    j = 0
    while j < (scale - 1) * len(cl):
        m = MARKETS[rng.integers(len(MARKETS))]
        st, en = dix(MKT[m][0]), dix(MKT[m][1])
        d = int(rng.integers(st + 40, en - 20))
        if any(mm == m and abs(dd - d) <= 25 for (mm, dd) in taken):
            continue
        taken.add((m, d))
        out.append({"id": f"rfx{j}", "kind": "rf", "market": m, "day": d, "dose": cl[rng.integers(len(cl))]["dose"],
                    "clean": True})
        j += 1
    return out


# ------------------------------------------------------------------------------------------------ one replication
def sim_rep(args):
    rep, seed, kD, world, evs_all = args
    com = Common(seed)
    rng = np.random.default_rng(seed + 3)
    panel, truths = {}, []
    maxdev = 0.0
    for mi, m in enumerate(MARKETS):
        evs = []
        for e in evs_all:
            if e["market"] != m:
                continue
            e2 = dict(e)
            e2["hour"] = H0 + 24 * (e["day"] - 1) + int(np.random.default_rng(seed * 100 + zlib.crc32(e["id"].encode()) % 9973).integers(24))
            evs.append(e2)
        cm = WHALE_MED.get(m, {"wm": 0.0, "fR": 1.0})
        wm = cm["wm"] if world == "cal" else 0.0
        sim = Sim5(base_cfg(m, kD, cm["fR"]), seed * 31 + mi, com, wm, evs, mi)
        keep = {e["hour"] for e in evs if e["clean"]}
        Sx, Dx, RFx, INCx, snaps = sim.run_main(keep)
        days = np.arange(NDAY + 1)
        rh = np.clip(read_hour(days), 0, NH - 1)
        S, Dbt = Sx[rh], Dx[rh]
        ethd = np.add.reduceat(com.eth[H0 - 24:H0 - 24 + 24 * (NDAY + 1)], np.arange(0, 24 * (NDAY + 1), 24)) / 24
        kink = MKT[m][3]
        u = Dbt / S
        r = K.curve_rate(u, kink, sim.s1[rh], sim.s2[rh])
        panel[m] = {"S": S, "D": Dbt, "u": u, "sr": (r * u * (1 - RFx[rh]) + INCx[rh]) * 100, "eth": ethd,
                    "kink": kink}
        for e in evs:
            if not e["clean"]:
                continue
            d = e["day"]
            t0 = e["hour"]
            t1 = read_hour(d - 1 + KMAX) + 1
            cf = sim.run_seg(snaps[t0], t0, t1, skip=e["id"])
            if rep == 0 or rng.random() < 0.1:
                wi = sim.run_seg(snaps[t0], t0, t1, skip=None)
                maxdev = max(maxdev, float(np.abs(wi - Sx[t0:t1]).max() / Sx[t0]))
            tr = {k: float(np.log(Sx[read_hour(d - 1 + k)]) - np.log(cf[read_hour(d - 1 + k) - t0])) for k in KS}
            truths.append({"id": e["id"], "kind": e["kind"], "market": m, "day": d, "dose": e["dose"], **tr})
    return panel, truths, maxdev


# ------------------------------------------------------------------------------------------------ estimator
def _lm(x, d, a, b):
    """Mean of x over days d-b..d-a (a<=b), vectorised over the day index array d."""
    cs = np.r_[0.0, np.cumsum(np.nan_to_num(x))]
    return (cs[d - a + 1] - cs[d - b]) / (b - a + 1)


def build_rows(panel, evs, k, which, noU=False):
    X_all, y_all, x_all, mk_all, dt_all, pre_all = [], [], [], [], [], []
    for mi, m in enumerate(MARKETS):
        P = panel[m]
        st, en = dix(MKT[m][0]), dix(MKT[m][1])
        ls, ld = np.log(P["S"]), np.log(np.maximum(P["D"], 1.0))
        u, kink = P["u"], P["kink"]
        p = np.maximum(u - kink, 0.0)
        dls = np.r_[0.0, np.diff(ls)]
        dld = np.r_[0.0, np.diff(ld)]
        d = np.arange(max(st + 32, 32 + k, 9 + k), en - k + 1)
        ev_m = [e for e in evs if e["market"] == m]
        dose = np.zeros(len(d))
        drop = np.zeros(len(d), bool)
        pos = {int(x): i for i, x in enumerate(d)}
        for e in ev_m:
            treat = e["clean"] and (e["kind"] == "rf" or which == "B")
            for j in range(e["day"] - WIN_PRE, e["day"] + WIN_POST + 1):
                if j in pos and (j != e["day"] or not treat):
                    drop[pos[j]] = True
        for e in ev_m:
            treat = e["clean"] and (e["kind"] == "rf" or which == "B")
            if treat and e["day"] in pos:
                dose[pos[e["day"]]] += e["dose"]
                drop[pos[e["day"]]] = False
        y = ls[d - 1 + k] - ls[d - 1]
        pre = ls[d - 1] - ls[d - 1 - k]
        plc = ls[d - 8] - ls[d - 8 - k]     # placebo window ends at d-8 (outside the signed lag controls)
        cols = [u[d - 1]] if noU else [u[d - 1], p[d - 1], p[d - 1] ** 2] + \
            [_lm(v, d, a, b) for v in (u, p) for a, b in ((2, 4), (5, 11), (12, 31))]
        cols += [P["sr"][d - 1], _lm(np.abs(dls), d, 1, 7), _lm(np.abs(dls), d, 8, 30), _lm(np.abs(dld), d, 1, 7),
                 _lm(np.abs(dld), d, 8, 30), dls[d - 1], _lm(dls, d, 2, 7), dld[d - 1], P["eth"][d - 1],
                 np.max(np.stack([P["eth"][d - j] for j in (1, 2, 3)]), 0), _lm(P["eth"], d, 2, 7), pre]
        X = np.column_stack(cols)
        keep = ~drop & np.isfinite(y) & np.isfinite(X).all(1)
        X_all.append(X[keep]); y_all.append(y[keep]); x_all.append(dose[keep])
        mk_all.append(np.full(keep.sum(), mi)); dt_all.append(d[keep]); pre_all.append(plc[keep])
    return (np.vstack(X_all), np.concatenate(y_all), np.concatenate(x_all), np.concatenate(mk_all),
            np.concatenate(dt_all), np.concatenate(pre_all))


def demean2(Z, g1, g2, it=200, tol=1e-11):
    Z = Z.copy()
    n1, n2 = g1.max() + 1, g2.max() + 1
    c1, c2 = np.bincount(g1, minlength=n1), np.bincount(g2, minlength=n2)
    for _ in range(it):
        m1 = np.stack([np.bincount(g1, Z[:, j], n1) for j in range(Z.shape[1])], 1) / np.maximum(c1, 1)[:, None]
        Z -= m1[g1]
        m2 = np.stack([np.bincount(g2, Z[:, j], n2) for j in range(Z.shape[1])], 1) / np.maximum(c2, 1)[:, None]
        Z -= m2[g2]
        if np.abs(m2).max() < tol:
            break
    return Z


def estimate(X, y, x, mk, dt):
    _, g2 = np.unique(dt, return_inverse=True)
    Z = demean2(np.column_stack([y, x, X]), mk, g2)
    yt, xt, Xt = Z[:, 0], Z[:, 1], Z[:, 2:]
    sd = Xt.std(0)
    Xt = Xt[:, sd > 1e-12]
    bx = np.linalg.lstsq(Xt, xt, rcond=None)[0]
    by = np.linalg.lstsq(Xt, yt, rcond=None)[0]
    xr, yr = xt - Xt @ bx, yt - Xt @ by
    sxx = (xr * xr).sum()
    if sxx <= 0:
        return None
    b = (xr * yr).sum() / sxx
    e = yr - b * xr
    s = xr * e
    G1, G2 = mk.max() + 1, g2.max() + 1

    def vcl(g, G):
        return (np.bincount(g, s, G) ** 2).sum() * G / (G - 1) / sxx ** 2
    v1, v2, v0 = vcl(mk, G1), vcl(g2, G2), (s * s).sum() / sxx ** 2
    v = v1 + v2 - v0
    if v <= 0:
        v = max(v1, v2)
    G = min(G1, G2)
    from math import sqrt
    tq = {9: 2.262, 8: 2.306, 7: 2.365, 6: 2.447, 5: 2.571, 4: 2.776, 3: 3.182}.get(G - 1, 2.262)
    se = sqrt(v)
    nt = int((x != 0).sum())
    return {"b": float(b), "se": float(se), "lo": float(b - tq * se), "hi": float(b + tq * se),
            "rej": bool(abs(b) > tq * se), "seWhite": float(sqrt(v0)), "nTreated": nt, "nRows": int(len(y)),
            "G": int(G), "nTreatedMarkets": int(len(np.unique(mk[x != 0]))), "nTreatedDates": int(len(np.unique(dt[x != 0])))}


def analyse(panel, truths, evs):
    out = {}
    for which in ("A", "B"):
        for k in KS:
            for var in ("main", "noU", "placebo"):
                X, y, x, mk, dt, pre = build_rows(panel, evs, k, which, noU=(var == "noU"))
                if var == "placebo":
                    y = pre
                r = estimate(X, y, x, mk, dt)
                tr = [t for t in truths if t["kind"] == "rf" or which == "B"]
                dd = np.array([t["dose"] for t in tr])
                TT = np.array([t[k] for t in tr])
                truth = float((dd * TT).sum() / (dd * dd).sum()) if len(tr) else float("nan")
                out[f"{which}_{k}d_{var}"] = dict(r or {}, truth=0.0 if var == "placebo" else truth)
    return out


def _job(a):
    rep, seed, kD, world, evs = a
    panel, truths, md = sim_rep(a)
    return {"rep": rep, "seed": seed, "maxBaseDev": md, "res": analyse(panel, truths, evs),
            "nTruth": len(truths)}


def summarise(R, real_truth=None):
    keys = sorted(R[0]["res"].keys())
    s = {}
    for kk in keys:
        rr = [r["res"][kk] for r in R if r["res"][kk].get("b") is not None]
        if not rr:
            continue
        b = np.array([x["b"] for x in rr]); t = np.array([x["truth"] for x in rr])
        lo = np.array([x["lo"] for x in rr]); hi = np.array([x["hi"] for x in rr])
        s[kk] = {"n": len(rr), "meanEst": float(b.mean()), "meanTruth": float(t.mean()), "bias": float((b - t).mean()),
                 "sdEst": float(b.std()), "meanSE": float(np.mean([x["se"] for x in rr])),
                 "coverage": float(((lo <= t) & (t <= hi)).mean()), "rejectRate": float(np.mean([x["rej"] for x in rr])),
                 "nTreated": float(np.mean([x["nTreated"] for x in rr])),
                 "nTreatedMarkets": float(np.mean([x["nTreatedMarkets"] for x in rr]))}
    return s


def main(argv=None):
    global KD_REAL, WHALE_MED
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["calib-kd", "calib-whale", "run"])
    ap.add_argument("--events", required=True)
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--calib", default=None, help="calibration json (kD_real, whale medians)")
    ap.add_argument("--world", default="cal")
    ap.add_argument("--arm", default="real", choices=["null", "half", "real"])
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--reps", type=int, default=4)
    ap.add_argument("--seed0", type=int, default=990000)
    ap.add_argument("--procs", type=int, default=4)
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)
    evs = load_events(a.events, a.datasets)
    if a.calib:
        cj = json.load(open(a.calib))
        KD_REAL, WHALE_MED = cj["kD_real"], cj["whale_med"]
    if a.cmd == "calib-kd":
        kd = 0.01
        args = [(r, a.seed0 + r, kd, "light", evs) for r in range(a.reps)]
        with Pool(a.procs) as p:
            res = p.map(sim_rep, args)
        T = {k: [] for k in KS}
        for panel, truths, md in res:
            tr = [t for t in truths if t["kind"] == "rf"]
            dd = np.array([t["dose"] for t in tr])
            for k in KS:
                T[k].append((dd * np.array([t[k] for t in tr])).sum() / (dd * dd).sum())
        per = {k: float(np.mean(v)) for k, v in T.items()}
        kdr = kd * SRDR_PER_PT[7] / per[7]
        print(json.dumps({"kD_test": kd, "truthPerPt_at_kD_test": per, "kD_real": kdr,
                          "impliedTruth3dPerPt_at_kD_real": per[3] * kdr / kd, "maxBaseDev": max(r[2] for r in res)}))
        return
    if a.cmd == "calib-whale":
        out = {}
        cal = dict(WHALE_MED) if WHALE_MED else {m: {"wm": 0.05, "fR": 1.0} for m in MARKETS}
        for it in range(6):
            WHALE_MED = cal
            args = [(r, a.seed0 + 100 * it + r, 0.0, "cal", []) for r in range(a.reps)]
            with Pool(a.procs) as p:
                res = p.map(sim_rep, args)
            new = {}
            for m in MARKETS:
                qs = []
                for panel, _, _ in res:
                    ls = np.log(panel[m]["S"])
                    st, en = dix(MKT[m][0]), dix(MKT[m][1])
                    g = ls[st + 7:en] - ls[st:en - 7]
                    g = g - np.median(g)
                    qs.append([np.quantile(np.abs(g), q) for q in (0.5, 0.9, 0.99)])
                q = np.mean(qs, 0)
                t50, t90 = Q5090[m]
                out[m] = {**cal[m], "q50": q[0], "q90": q[1], "q99": q[2], "t50": t50, "t90": t90, "t99": MKT[m][4]}
                new[m] = {"fR": float(np.clip(cal[m]["fR"] * (t50 / max(q[0], 1e-4)) ** 1.5, 0.05, 3.0)),
                          "wm": float(np.clip(cal[m]["wm"] * (MKT[m][4] / max(q[2], 1e-4)) ** 1.2, 0.0, 0.3))}
            print(it, json.dumps({m: {k: round(v, 4) for k, v in o.items()} for m, o in out.items()}), flush=True)
            if it < 5:
                cal = new
        print(json.dumps({"whale_med": cal, "last": out}))
        return
    kd = {"null": 0.0, "half": 0.5 * KD_REAL, "real": KD_REAL}[a.arm]
    rng = np.random.default_rng(a.seed0 + 17)
    args = []
    for r in range(a.reps):
        ev_r = scaled_events(evs, a.scale, np.random.default_rng(a.seed0 + 7 * r + 1))
        args.append((r, a.seed0 + r, kd, a.world, ev_r))
    with Pool(a.procs) as p:
        R = p.map(_job, args)
    out = {"schema": "q26-r185/power/1", "arm": a.arm, "world": a.world, "scale": a.scale, "kD": kd,
           "kD_real": KD_REAL, "reps": a.reps, "seed0": a.seed0, "whale_med": WHALE_MED if a.world == "cal" else {},
           "maxBaseDev": max(r["maxBaseDev"] for r in R), "summary": summarise(R),
           "code_sha256": __import__("hashlib").sha256(open(__file__, "rb").read()).hexdigest(), "reps_detail": R}
    if a.out:
        json.dump(out, open(a.out, "w"), default=float)
    for kk, v in out["summary"].items():
        print(f"{kk:18s} est {v['meanEst']:+.4f} truth {v['meanTruth']:+.4f} bias {v['bias']:+.4f} sd {v['sdEst']:.4f} "
              f"se {v['meanSE']:.4f} cov {v['coverage']:.2f} rej {v['rejectRate']:.2f} nT {v['nTreated']:.1f}")
    print("maxBaseDev", out["maxBaseDev"])


if __name__ == "__main__":
    sys.exit(main())
