#!/usr/bin/env python3
"""Q26 R18.4: explicit mechanical borrow cap + behavioural deposit/repay (D+Rp) kernel by state.

membrane-board design/Q26_ROUND18_PREREG.md R18.4 (defined by D-R18.3-review).

PRIMARY ESTIMAND. For an extra withdrawal X ($) in hour t0:
  kappa_DR(h | state) = [ extra third-party deposits + repays in hours t0+1..t0+h ] / X ,  h = 3, 24, 72,
  state = pre-shock utilisation below / at-or-above the curve's optimal point (X = 2% of supply < cash), or
  cash at 0 (X = cash + 2% of supply). The repeat unit and its alias are excluded (truth) or removed by the fixed
  behaviour rule (estimators).
Borrows are NOT in the primary estimand. Their change is split into
  blocked   : demand the parameter-free cap stops (net of any retry) -> mechanical, lives in the engine;
  behavioural: the change in borrow demand -> its own model, never used to infer refill.

  python3 r184_kernel.py calib --design P            # truth descriptives only (no candidate runs)
  python3 r184_kernel.py synth --design Dv4|P|Q|Z --reps R --boot B --work <dir>
  python3 r184_kernel.py build --datasets <ds> --work182 <r182 work> --work <dir>     # unit-level splits (real)
  python3 r184_kernel.py fit   --datasets <ds> --work182 <dir> --work <dir> --out <dir> # Core USDC, seen
  python3 r184_kernel.py case  --datasets <ds> --work182 <dir> --work <dir> --out <dir> # April 2026
No address is written. Unit ids are hashed in memory only (r182_refill.uid).
"""
import argparse
import copy
import json
import os
import sys
from datetime import datetime, timezone
from multiprocessing import Pool

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r182_refill as R  # noqa: E402
import r183_kernel as K  # noqa: E402
import r184_engine as E  # noqa: E402

HS = (3, 24, 72)
HMAX = 72
LAG0 = 340
ZWIN = K.ZWIN
ZKNOT = K.ZKNOT
CELLS = ("pooled", "below", "above", "cash0")

# ================================================================================================ synthetic DGP
_BASE = dict(n=30000, mr=0.5, resp="tanh", asym=1.0, lag="ema2", news_rp=0.0, news_rp_tau=24.0,
             lvl_hl=240.0, lvl_sd=0.0, rp_lvl=0.0, retry=0.0, retry_mean=1.0, retargets=(), bench_shift=None)
DESIGNS = {
    # development design (may be tuned)
    "Dv4": dict(_BASE, S0=4e9, u0=0.87, RF=0.10, curves=[(0, 0.90, 0.045, 0.60)],
                act_hi=2.5, act_stay=240, week_amp=0.25, d0=9.4e-4, w0=8e-4, rp0=7.4e-4, b0=8.6e-4, sig=1.0,
                big_p=0.003, big_scale=0.003, resp="tanh", c=0.05, kD=0.008, kR=0.004, kB=0.002, lag="ema1",
                lag_a=0.90, bench=(0.030, 0.9997, 2.5e-4), zr_off=0.008, news_rate=1 / 500, inf_lo=0.01,
                inf_hi=0.03, wave_lo=0.015, wave_hi=0.04, wave_win=(4, 48), dep_hit=0.5, dep_tau=30.0, news_rp=0.5,
                R_p=1 / 60, R_lo=0.01, R_hi=0.03, R_delay=24, R_alias=0.30, lvl_hl=240.0, lvl_sd=0.15, rp_lvl=0.6,
                retry=0.6, retry_mean=4.0, seed0=71000),
}


def design_P():
    return dict(_BASE, S0=5e9, u0=0.86, RF=0.12, curves=[(0, 0.92, 0.050, 0.45)],
                retargets=((8000, 0.88, 0.004), (16000, 0.88, 0.004), (23000, 0.88, 0.004)), s2_change=(16000, 0.75),
                act_hi=2.5, act_stay=300, week_amp=0.20, d0=9.4e-4, w0=8e-4, rp0=7.2e-4, b0=8.1e-4, sig=1.0,
                big_p=0.003, big_scale=0.0035, resp="tanh", c=0.06, asym=0.5, kD=0.009, kR=0.004, kB=0.002,
                lag="ema1", lag_a=0.92, bench=(0.032, 0.9998, 1e-4), bench_shift=(12000, 0.010), zr_off=0.010,
                news_rate=1 / 600, inf_lo=0.01, inf_hi=0.035, wave_lo=0.015, wave_hi=0.04, wave_win=(6, 60),
                dep_hit=0.5, dep_tau=30.0, news_rp=1.0, news_rp_tau=24.0,
                R_p=1 / 48, R_lo=0.015, R_hi=0.04, R_delay=36, R_alias=0.25,
                lvl_hl=240.0, lvl_sd=0.15, rp_lvl=0.5, retry=0.5, retry_mean=6.0, seed0=84400)


def design_Q():
    return dict(_BASE, S0=3e9, u0=0.85, RF=0.15, curves=[(0, 0.90, 0.040, 0.80)],
                act_hi=3.5, act_stay=168, week_amp=0.30, d0=9.8e-4, w0=8e-4, rp0=7.2e-4, b0=7.0e-4, sig=1.1,
                big_p=0.004, big_scale=0.003, resp="clip", c=0.10, asym=1.0, kD=0.006, kR=0.003, kB=0.003,
                lag="ema2", lag_a=0.75, bench=(0.035, 0.9995, 3e-4), zr_off=0.008,
                news_rate=1 / 400, inf_lo=0.015, inf_hi=0.04, wave_lo=0.02, wave_hi=0.05, wave_win=(2, 36),
                dep_hit=0.7, dep_tau=36.0, news_rp=0.0,
                R_p=1 / 72, R_lo=0.02, R_hi=0.05, R_delay=12, R_alias=0.40,
                lvl_hl=480.0, lvl_sd=0.18, rp_lvl=0.4, retry=0.8, retry_mean=2.0, seed0=85500)


DESIGNS["P"] = design_P()
DESIGNS["Q"] = design_Q()
DESIGNS["Z"] = dict(DESIGNS["P"], kD=0.0, kR=0.0, seed0=86600)   # NULL: no behavioural D+Rp rate response


class Sim4:
    """Hourly pool: Aave curve, cash >= 0, FIFO withdrawal queue, borrows capped by the cash left after deposits,
    repays and withdrawals (the parameter-free cap). Borrow demand has an exogenous mean-reverting level and a
    partial retry of blocked demand. All randomness is drawn up front, so a re-run from a saved state with an extra
    withdrawal is a paired (common random numbers) simulation."""

    def __init__(self, cfg, seed):
        self.c = c = cfg
        n = c["n"]
        self.n = n
        rng = np.random.default_rng(seed)
        t = np.arange(n)
        hod = t % 24
        st = np.zeros(n)
        s = 0
        sw = rng.random(n)
        for i in range(1, n):
            if sw[i] < 1.0 / c["act_stay"]:
                s = 1 - s
            st[i] = s
        self.A = np.exp(np.log(c["act_hi"]) * st + c["week_amp"] * np.sin(2 * np.pi * t / 168))
        self.cyc = 1 + 1.5 * (hod == 0) + 0.8 * (hod == 23)
        sg = c["sig"]
        ln = lambda: rng.lognormal(-0.5 * sg * sg, sg, n)
        self.eD, self.eW, self.eR, self.eB = ln(), ln(), ln(), ln()
        self.big = np.where(rng.random(n) < c["big_p"], np.minimum(c["big_scale"] * (rng.pareto(1.8, n) + 1), 0.05), 0.0)
        self.Rf = rng.random(n) < c["R_p"]
        self.Rsz = rng.uniform(c["R_lo"], c["R_hi"], n)
        self.Rdl = rng.integers(1, c["R_delay"] + 1, n)
        self.Ral = rng.random(n) < c["R_alias"]
        self.inf = np.zeros(n)
        self.wave = np.zeros(n)
        self.dmult = np.ones(n)
        self.rmult = np.ones(n)
        news = np.where(rng.random(n) < c["news_rate"])[0]
        self.news = news
        for tau in news:
            self.inf[tau] += rng.uniform(c["inf_lo"], c["inf_hi"])
            a, b = c["wave_win"]
            tot = rng.uniform(c["wave_lo"], c["wave_hi"])
            hrs = np.arange(tau + a, min(n, tau + b + 1))
            if len(hrs):
                self.wave[hrs] += tot * rng.dirichlet(np.ones(len(hrs)))
            k = np.arange(tau + 1, min(n, tau + 97))
            self.dmult[k] *= 1 - c["dep_hit"] * np.exp(-(k - tau) / c["dep_tau"])
            self.rmult[k] *= 1 + c["news_rp"] * np.exp(-(k - tau) / c["news_rp_tau"])     # deleveraging surge
        m0, ph, sd = c["bench"]
        x = np.zeros(n)
        e = rng.normal(0, sd, n)
        for i in range(1, n):
            x[i] = ph * x[i - 1] + e[i]
        self.bench = m0 + x
        if c.get("bench_shift"):
            h0, dl = c["bench_shift"]
            self.bench[h0:] += dl
        # borrow-demand log level: exogenous OU (mean reversion with half-life lvl_hl hours)
        rho = np.exp(-np.log(2) / c["lvl_hl"])
        el = rng.normal(0, c["lvl_sd"] * np.sqrt(1 - rho * rho), n)
        lv = np.zeros(n)
        for i in range(1, n):
            lv[i] = rho * lv[i - 1] + el[i]
        self.lvl = lv
        vol = np.exp(np.convolve(rng.normal(0, 0.15, n), np.ones(48) / 48, "same"))
        eth = np.abs(rng.standard_t(4, n)) * vol * 0.006
        for tau in news:
            eth[tau:min(n, tau + 6)] *= 3.0
        self.eth = eth
        self.opt = np.zeros(n)
        self.s1 = np.zeros(n)
        self.s2 = np.zeros(n)
        for (h0, o, a1, a2) in c["curves"]:
            self.opt[h0:], self.s1[h0:], self.s2[h0:] = o, a1, a2
        # governance retargets toward the benchmark (endogenous curve changes): slope1 so that the supply rate at
        # utilisation u_ref equals the benchmark + margin at the change hour
        for (h0, uref, mg) in c.get("retargets", ()):
            o = self.opt[h0]
            self.s1[h0:] = (self.bench[h0] + mg) * o / (uref * uref * (1 - c["RF"]))
        if c.get("s2_change"):
            h0, v = c["s2_change"]
            self.s2[h0:] = v

    def init_state(self):
        c = self.c
        return {"S": c["S0"], "Dbt": c["S0"] * c["u0"], "Sref": c["S0"], "Dref": c["S0"] * c["u0"], "q": [],
                "yD1": 0.0, "yD2": 0.0, "yR1": 0.0, "yR2": 0.0, "Rpend": [], "Racc": 0.0, "pool": 0.0}

    def f(self, z):
        c = self.c
        if c["resp"] == "linear":
            v = z
        elif c["resp"] == "clip":
            v = float(np.clip(z, -c["c"], c["c"]))
        else:
            v = c["c"] * np.tanh(z / c["c"])
        return v if v >= 0 else c["asym"] * v

    def step(self, st, t, extra=0.0, rec=None):
        """Advance one hour. Returns (D3P, Rp, Bexec, Wexec, Bdemand_total, blocked, retry_release, DR).
        D3P = third-party deposits (the repeat unit's returns DR are separate)."""
        c = self.c
        S, Dbt = st["S"], st["Dbt"]
        Sr, Dr = st["Sref"], st["Dref"]
        A, cy = self.A[t], self.cyc[t]
        mrD = (c["S0"] / Sr) ** c["mr"]
        mrB = (c["S0"] * c["u0"] / Dr) ** c["mr"]
        lv = self.lvl[t]
        yD = st["yD2"] if c["lag"] == "ema2" else st["yD1"]
        yR = st["yR2"] if c["lag"] == "ema2" else st["yR1"]
        D = max(c["d0"] * Sr * A * cy * self.eD[t] * self.dmult[t] * mrD + c["kD"] * Sr * yD, 0.0)
        Rp = max(c["rp0"] * Dr * A * cy * self.eR[t] * self.rmult[t] * np.exp(-c["rp_lvl"] * lv) + c["kR"] * Dr * yR, 0.0)
        Bnew = max(c["b0"] * Dr * A * cy * self.eB[t] * mrB * np.exp(lv) - c["kB"] * Dr * yR, 0.0)
        DR = 0.0
        keep = []
        for (hh, amt, al) in st["Rpend"]:
            if hh <= t:
                DR += amt
                if rec is not None:
                    rec.append((2 if al else 1, t, 1, amt))
            else:
                keep.append((hh, amt, al))
        st["Rpend"] = keep
        Rp = min(Rp, Dbt)
        S += D + DR
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
        if extra > 0:
            q.append([-1, extra, 0, 0])
        Wx = 0.0
        while q and cash > 1e-6:
            u_, amt, dl, al = q[0]
            e = min(amt, cash)
            cash -= e
            S -= e
            Wx += e
            if rec is not None and u_ != 0:
                rec.append((u_, t, 0, -e))
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
        # borrows: new demand + retry release, capped by the cash left (parameter-free cap)
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
        zD = r * u * (1 - c["RF"]) - self.bench[t]
        zR = r - (self.bench[t] + c["zr_off"])
        a = c["lag_a"]
        st["yD1"] = a * st["yD1"] + (1 - a) * self.f(zD)
        st["yD2"] = a * st["yD2"] + (1 - a) * st["yD1"]
        st["yR1"] = a * st["yR1"] + (1 - a) * self.f(zR)
        st["yR2"] = a * st["yR2"] + (1 - a) * st["yR1"]
        return D, Rp, Bx, Wx, Bd, blk, rel, DR

    def run(self, n_orig=300, xfrac=0.02, seed=0, truth=True):
        n = self.n
        st = self.init_state()
        rng = np.random.default_rng(seed + 7)
        orig = np.sort(rng.choice(np.arange(LAG0 + 200, n - HMAX - 2), n_orig, replace=False))
        oset = set(orig.tolist()) if truth else set()
        snaps = {}
        out = np.zeros((n, 8))
        Sx = np.zeros(n)
        Dx = np.zeros(n)
        rec = []
        for t in range(n):
            if t in oset:
                snaps[t] = copy.deepcopy(st)
            out[t] = self.step(st, t, rec=rec)
            Sx[t], Dx[t] = st["S"], st["Dbt"]
        rows = []
        maxdev = 0.0
        for t0 in (orig if truth else []):
            s0 = snaps[t0]
            S_, D_ = s0["S"], s0["Dbt"]
            cash0 = S_ - D_
            base = self._seg(s0, t0, 0.0)
            maxdev = max(maxdev, float(np.abs(base[:, :8] - out[t0:t0 + HMAX + 1, :8]).max() / S_))
            row = {"t0": int(t0), "S": S_, "Dbt": D_, "cash": cash0, "u": D_ / S_, "opt": self.opt[t0 - 1]}
            for nm, X in (("X1", xfrac * S_), ("X2", cash0 + xfrac * S_)):
                p = self._seg(s0, t0, X)
                dlt = (p - base)[1:]
                dD, dRp, dBx = dlt[:, 0], dlt[:, 1], dlt[:, 2]
                dBd, dblk, drel = dlt[:, 4], dlt[:, 5], dlt[:, 6]
                comp = {"D": dD, "Rp": dRp, "DR": dD + dRp, "G": dD + dRp - dBx,
                        # -dBexec = (dblocked - dretry)  +  (-(dBdemand - dretry))
                        "Bmech": dblk - drel, "Bbeh": -(dBd - drel)}
                for k_, v in comp.items():
                    cs = np.cumsum(v)
                    for h in HS:
                        row[f"{nm}_{k_}_{h}h"] = float(cs[h - 1] / X)
                row[f"{nm}_X"] = X
            rows.append(row)
        P = pd.DataFrame({"W": out[:, 3], "D": out[:, 0] + out[:, 7], "Rp": out[:, 1], "B": out[:, 2], "O": 0.0,
                          "S": Sx, "debt": Dx, "Bdem": out[:, 4], "Bblk": out[:, 5]})
        P["cash"] = P["S"] - P["debt"]
        P["util"] = P["debt"] / P["S"]
        P["kink"] = self.opt
        P["s1"], P["s2"] = self.s1, self.s2
        P["rf"] = self.c["RF"]
        P["base"] = 0.0
        P["hour_ts"] = R.H0 + 3600 * np.arange(n)
        ev = pd.DataFrame(rec, columns=["unit", "h", "k", "s"])
        return P, ev, pd.DataFrame(rows), maxdev

    def _seg(self, s0, t0, extra):
        st = copy.deepcopy(s0)
        o = np.zeros((HMAX + 1, 8))
        for j in range(HMAX + 1):
            o[j] = self.step(st, t0 + j, extra=extra if j == 0 else 0.0)
        return o


def truth_cells(T):
    T = T.copy()
    T["above"] = T["u"] >= T["opt"]
    ok = T["X1_X"] < T["cash"]
    tr = {}
    for comp in ("DR", "D", "Rp", "G", "Bmech", "Bbeh"):
        for nm, m in (("pooled", ok), ("below", ok & ~T["above"]), ("above", ok & T["above"])):
            tr.setdefault(comp, {})[nm] = {f"{h}h": float(T.loc[m, f"X1_{comp}_{h}h"].mean()) for h in HS}
            tr[comp][nm]["n"] = int(m.sum())
        tr[comp]["cash0"] = {f"{h}h": float(T[f"X2_{comp}_{h}h"].mean()) for h in HS}
        tr[comp]["cash0"]["n"] = int(len(T))
    return tr


# ================================================================================================ unit-level splits
def flows_by_kind(ev, n, mask_fn):
    """Per-hour inflow by kind (D, Rp; positive) for events where mask_fn(ev) is True."""
    out = {}
    m = mask_fn(ev)
    for k, nm in ((1, "D"), (2, "Rp")):
        x = ev[m & (ev["k"].to_numpy() == k)]
        a = np.zeros(n)
        np.add.at(a, x["h"].to_numpy(), np.abs(x["s"].to_numpy()))
        out[nm] = a
    return out


def window_mask(ev, win, forward):
    """Boolean per event: the event's unit has an executed withdrawal in [h - win, h] (forward False) or in
    (h, h + win] (forward True)."""
    w = ev[ev["k"] == 0]
    wh = {u: np.sort(g["h"].to_numpy()) for u, g in w.groupby("unit")}
    m = np.zeros(len(ev), bool)
    idx = np.arange(len(ev))
    for u, g in ev.assign(_i=idx).groupby("unit"):
        if u not in wh:
            continue
        hs = wh[u]
        h = g["h"].to_numpy()
        if forward:
            i0 = np.searchsorted(hs, h, side="right")
            i1 = np.searchsorted(hs, h + win, side="right")
            mm = i1 > i0
        else:
            i = np.searchsorted(hs, h, side="right")
            last = np.where(i > 0, hs[np.maximum(i - 1, 0)], -10 ** 9)
            mm = (h - last) <= win
        m[g["_i"].to_numpy()] = mm
    return m


def unit_splits(ev, n):
    """Repeat set (fixed behaviour rule, R18.3b), and per-kind inflow series to remove from the non-repeat D, Rp:
    recent withdrawers ([h-72, h]) and future withdrawers ((h, h+72]; the repay-then-withdraw check)."""
    rep, cnt = K.classify_repeat(ev)
    isr = ev["unit"].isin(rep).to_numpy()
    rep_fl = {}
    for k, nm in ((0, "W"), (1, "D"), (2, "Rp"), (3, "B")):
        x = ev[isr & (ev["k"].to_numpy() == k)]
        a = np.zeros(n)
        np.add.at(a, x["h"].to_numpy(), np.abs(x["s"].to_numpy()))
        rep_fl[nm] = a
    en = ev[~isr].reset_index(drop=True)
    rec_m = window_mask(en, 72, False)
    fut_m = window_mask(en, 72, True)
    recent = flows_by_kind(en, n, lambda e: rec_m)
    future_only = flows_by_kind(en, n, lambda e: fut_m & ~rec_m)      # not already removed as recent
    wuh = en[en["k"] == 0].groupby(["unit", "h"])["s"].sum().reset_index()
    wuh["x"] = -wuh["s"]
    top = wuh.sort_values("x", ascending=False).drop_duplicates("h").set_index("h")
    wtop = top["x"].reindex(range(n)).fillna(0).to_numpy()
    meta = {"nRepeatUnits": len(rep), "repeatTripsTotal": int(sum(cnt[u] for u in rep))}
    return rep_fl, recent, future_only, wtop, meta


def make_view(P, ev, eth, own=None):
    """Estimator view: D, Rp, B with the repeat set removed; yD, yRp = non-repeat, non-recent-withdrawer inflow;
    yDf, yRpf additionally without future withdrawers (repay-then-withdraw check)."""
    n = len(P)
    if own is None:
        own = np.zeros((4, 1, 1))       # hour-t withdrawer arrays are not used by the R18.4 estimators
    P = P.copy()
    if "Wtop_unit" not in P:
        P["Wtop_unit"] = 0
    d = R.make_data(P, own, eth)
    for k in ("S", "cash", "debt", "s1", "s2", "base", "rf"):
        d[k] = P[k].to_numpy(float)
    d["kink"] = P["kink"].to_numpy(float)
    d["r"] = K.curve_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"])
    zr = K.spread_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"], d["rf"])
    d["z"] = zr - pd.Series(zr).rolling(ZWIN, min_periods=1).mean().to_numpy()
    d["zb"] = d["r"] - pd.Series(d["r"]).rolling(ZWIN, min_periods=1).mean().to_numpy()
    add_fast_spreads(d, zr)
    rep_fl, recent, fut, wtop, meta = unit_splits(ev, n)
    d["Ball"] = d["B"].copy()
    for k in ("D", "Rp", "B"):
        d[k + "_nr"] = d[k] - rep_fl[k]
    d["Wrep"] = rep_fl["W"]
    d["Wtop"] = wtop
    d["yD"] = d["D_nr"] - recent["D"]
    d["yRp"] = d["Rp_nr"] - recent["Rp"]
    d["yDf"] = d["yD"] - fut["D"]
    d["yRpf"] = d["yRp"] - fut["Rp"]
    d["meta"] = meta
    return d


# ================================================================================================ SR-DR (behavioural)
ZWIN_FAST = 168
ZREF = {"z": ZWIN, "zb": ZWIN, "zf": ZWIN_FAST, "zbf": ZWIN_FAST}


def add_fast_spreads(d, zr):
    """Spreads against a 168 h trailing mean (identification from fast moves only; option "fast")."""
    d["zf"] = zr - pd.Series(zr).rolling(ZWIN_FAST, min_periods=1).mean().to_numpy()
    d["zbf"] = d["r"] - pd.Series(d["r"]).rolling(ZWIN_FAST, min_periods=1).mean().to_numpy()

def _lagmean(x, t, a, b):
    return R._lagsum(x, t, a, b) / (b - a + 1)


def _zcols(d, t, key="z"):
    za, zb = K.zpw(d[key])
    fs = (lambda v: v[t - 1], lambda v: _lagmean(v, t, 2, 6), lambda v: _lagmean(v, t, 7, 24),
          lambda v: _lagmean(v, t, 25, 72))
    return np.column_stack([f(x) for x in (za, zb) for f in fs])


NZ = 8


def sr_design(d, t, yser, opts, zkey="z", norm="S"):
    """Hourly y = yser / S(t-1). Controls: hour of week, activity means, ETH |return| lags 0-6, cash tightness at
    t-1, repeat-set and all-withdrawal lags, debt and supply level deviations (borrow-demand level dynamics).
    Kernel terms (last 2 + NZ columns): AR means of y (1-24, 25-168 h), piecewise spread lags."""
    S = np.maximum(d["S"], 1.0)
    N_ = np.maximum(d["debt"], 1.0) if norm == "debt" else S
    Nl = np.r_[N_[0], N_[:-1]]
    y = yser[t] / N_[t - 1]
    yy = yser / Nl
    gs = d["gross"] / S
    cols = [np.ones((len(t), 1)), R._dummies(d["how"][t]),
            np.column_stack([_lagmean(gs, t, a, b) for a, b in ((1, 24), (25, 168), (169, 336))]),
            np.column_stack([d["eth"][t - j] for j in range(7)])]
    cs = np.maximum(d["cash"], 0) / S
    if "cash" in opts:      # cash tightness at t-1 (a function of utilisation: competes with the spread)
        cols.append(np.column_stack([np.minimum(cs[t - 1], 0.01), (cs[t - 1] < 0.002).astype(float),
                                     np.minimum(cs[t - 1], 0.03), _lagmean(np.minimum(cs, 0.03), t, 2, 24)]))
    wr = d["Wrep"] / S
    wa = d["W"] / S
    if "nowlag" not in opts:    # repeat-set and all-withdrawal lags (news / post-shock co-movement controls)
        xs = (wr,) if "wker" in opts else (wr, wa)
        cols.append(np.column_stack([_lagmean(x, t, a, b) for x in xs for a, b in ((1, 6), (7, 24), (25, 72))]))
    if "lvl" in opts:       # supply and debt level deviations (borrow-demand level dynamics)
        for k in ("S", "debt"):
            v = np.log(np.maximum(d[k], 1.0))
            dv = v - pd.Series(v).rolling(720, min_periods=1).mean().to_numpy()
            cols.append(np.column_stack([dv[t - 1], _lagmean(dv, t, 2, 24)]))
    if "blag" in opts:      # borrow-demand level proxy: lagged non-repeat borrow flows (a control, never a kernel term)
        bs_ = d["B_nr"] / S
        cols.append(np.column_stack([_lagmean(bs_, t, a, b) for a, b in ((1, 24), (25, 168), (169, 336))]))
    if "act0" in opts:      # same-hour activity proxy: other flows in hours whose cash at t-1 was not tight
        ok = (cs[t - 1] > 0.005).astype(float)
        a0 = (d["W"][t] + d["Ball"][t]) / S[t - 1] * ok
        cols.append(np.column_stack([a0, np.log1p(a0 * 1e3), ok]))
    ar = np.column_stack([_lagmean(yy, t, 1, 24), _lagmean(yy, t, 25, 168)])
    kern = [ar, _zcols(d, t, zkey)]
    if "wker" in opts:
        wn = (d["W"] - d["Wrep"]) / S
        kern.append(np.column_stack([wn[t - 1], _lagmean(wn, t, 2, 6), _lagmean(wn, t, 7, 24), _lagmean(wn, t, 25, 72)]))
    X = np.column_stack([c if c.ndim == 2 else c[:, None] for c in cols] + kern)
    nk = sum(k_.shape[1] for k_ in kern)
    return X, y, X.shape[1] - nk


def _ols_boot(X, y, bidx, Wb, i0):
    nb = Wb.shape[1]
    p = X.shape[1]
    XX = np.zeros((nb, p, p))
    Xy = np.zeros((nb, p))
    for b in range(nb):
        m = bidx == b
        XX[b] = X[m].T @ X[m]
        Xy[b] = X[m].T @ y[m]
    lam = 1e-10 * np.trace(XX.sum(0)) / p
    beta = np.linalg.solve(XX.sum(0) + lam * np.eye(p), Xy.sum(0))
    bs = np.stack([np.linalg.solve(np.tensordot(w, XX, 1) + lam * np.eye(p), np.tensordot(w, Xy, 1)) for w in Wb])
    return beta[i0:], bs[:, i0:]


def fit_srdr(d, t, B=200, seed=3, opts=(), ykeys=("yD", "yRp"), block_days=30):
    """Behavioural D and Rp equations (same design, same block draws); and a borrow-demand equation on hours where
    the cap did not bind (cash at the end of the hour > 0.2% of supply), for the engine only."""
    rng = np.random.default_rng(seed)
    blk = ((d["hts"][t] - d["hts"][0]) // (block_days * 86400)).astype(int)
    bidx, Wb = R._block_draws(blk, B, rng)
    out = {"opts": list(opts)}
    zr_ = "zb" if "rpb" in opts else "z"
    f_ = "f" if "fast" in opts else ""
    out["zkeys"] = {"D": "z" + f_, "Rp": zr_ + f_, "Bbeh": zr_ + f_}
    out["norm"] = {"D": "S", "Rp": "debt" if "rpd" in opts else "S"}
    for nm, ys in (("D", d[ykeys[0]]), ("Rp", d[ykeys[1]])):
        X, y, i0 = sr_design(d, t, ys, opts, out["zkeys"][nm], out["norm"][nm])
        out[nm] = _ols_boot(X, y, bidx, Wb, i0)
    S = np.maximum(d["S"], 1.0)
    free = np.maximum(d["cash"][t], 0) > 0.002 * S[t]
    X, y, i0 = sr_design(d, t, -d["B_nr"], opts, zr_)
    b_, bs_ = _ols_boot(X[free], y[free], bidx[free], Wb, i0)
    out["Bbeh"] = (b_, bs_)
    return out


class _DRResponse:
    """Hour-j extra flows from the fitted kernel terms, given the spread-change histories from the engine.
    kinds[i] = "z" (supply-rate spread) or "zb" (borrow-rate spread) for equation i; zbase[kind] = (no, L) observed
    spread on the base path."""

    def __init__(self, th_list, kinds, zbase, S0, nb, no, L, wker=False):
        self.th = [np.atleast_2d(th) for th in th_list]     # each (nb, 2 + NZ [+4])
        self.kinds = kinds
        self.zb = zbase
        self.p0 = {k: K.zpw(v) for k, v in zbase.items()}
        self.S0 = S0
        sh = (nb, no, L)
        self.DA = {k: np.zeros(sh) for k in zbase}
        self.DB = {k: np.zeros(sh) for k in zbase}
        self.cum = {k: np.zeros((nb, no)) for k in zbase}
        self.Dy = [np.zeros(sh) for _ in th_list]
        self.wker = wker
        self.Wn = np.zeros(sh)          # extra non-repeat withdrawals (shock) per $ of S0 (wker only)

    def set_shock(self, X):
        self.Wn[:, :, 0] = X / (self.S0[0] if self.S0.ndim == 3 else self.S0)

    def __call__(self, j, dz_hist, dzb_hist):
        i = j - 1
        for k in self.zb:
            h_ = dzb_hist if k.startswith("zb") else dz_hist
            self.cum[k] = self.cum[k] + h_[..., i]
            Dz = h_[..., i] - self.cum[k] / ZREF[k]
            a_, b_ = K.zpw(self.zb[k][:, i] + Dz)
            self.DA[k][:, :, i], self.DB[k][:, :, i] = a_ - self.p0[k][0][:, i], b_ - self.p0[k][1][:, i]
        m = lambda arr, a, b: arr[:, :, max(0, j - b):max(0, j - a + 1)].sum(2) / (b - a + 1)
        res = []
        for th, Dy, kd in zip(self.th, self.Dy, self.kinds):
            c = lambda k: th[:, k][:, None]
            dy = c(0) * m(Dy, 1, 24) + c(1) * m(Dy, 25, 168)
            for Q_, o in ((self.DA[kd], 2), (self.DB[kd], 6)):
                dy = dy + c(o) * Q_[:, :, j - 1] + c(o + 1) * m(Q_, 2, 6) + c(o + 2) * m(Q_, 7, 24) + c(o + 3) * m(Q_, 25, 72)
            if self.wker:
                W_ = self.Wn
                dy = dy + c(10) * W_[:, :, j - 1] + c(11) * m(W_, 2, 6) + c(12) * m(W_, 7, 24) + c(13) * m(W_, 25, 72)
            Dy[:, :, j] = dy
            res.append(dy * (self.S0[len(res)] if self.S0.ndim == 3 else self.S0))
        return res


def base_path(d, t0s):
    """Engine base arrays for hours t0 .. t0+HMAX (hour 0 = the shock hour; offset fixed vs R18.3 SR)."""
    J = t0s[:, None] + np.arange(HMAX + 1)[None, :]
    return {"cash": np.maximum(d["cash"][J], 0.0), "S": d["S"][J], "debt": d["debt"][J], "B": d["Ball"][J],
            "opt": d["kink"][J], "s1": d["s1"][J], "s2": d["s2"][J], "base_rate": d["base"][J], "rf": d["rf"][J],
            "z": d["z"][J], "zb": d["zb"][J], "zf": d["zf"][J], "zbf": d["zbf"][J]}


def kernel_dr(fit, d, t0s, X, boot=True, wker=False):
    """D+Rp kernel along the realised base path with the cap in the engine. Returns dict of (nb, no, 3) arrays per $:
    DR, D, Rp, Bmech (blocked, mechanical). Index 0 of nb is the point fit, 1.. the bootstrap draws."""
    base = base_path(d, t0s)
    thD = np.vstack([fit["D"][0][None], fit["D"][1]]) if boot else fit["D"][0][None]
    thR = np.vstack([fit["Rp"][0][None], fit["Rp"][1]]) if boot else fit["Rp"][0][None]
    nb, no, L = thD.shape[0], len(t0s), HMAX + 1
    S0 = d["S"][t0s - 1]
    nm_ = fit.get("norm", {"D": "S", "Rp": "S"})
    sc = np.stack([(d["debt"] if nm_[k] == "debt" else d["S"])[t0s - 1] for k in ("D", "Rp")])[:, None, :]
    zk = fit.get("zkeys", {"D": "z", "Rp": "z"})
    resp = _DRResponse([thD, thR], [zk["D"], zk["Rp"]], {k: base[k] for k in set(zk.values())}, sc, nb, no,
                       L, wker=wker)
    Xb = np.broadcast_to(X, (nb, no)).astype(float)
    if wker:
        resp.set_shock(Xb)
    o = E.shock_path(base, Xb, resp)
    res = {}
    for k, v in (("D", o["dD"]), ("Rp", o["dRp"]), ("DR", o["dD"] + o["dRp"]), ("Bmech", o["blocked"])):
        cs = np.cumsum(v[..., 1:], axis=-1)
        res[k] = np.stack([cs[..., h - 1] / Xb for h in HS], axis=-1)
    return res


def kernel_bbeh(fit, d, t0s, X):
    """Behavioural borrow-demand change per $ (engine only; never refill): the borrow equation's spread terms
    driven by the mechanical shocked path (no D+Rp feedback)."""
    base = base_path(d, t0s)
    th = np.vstack([fit["Bbeh"][0][None], fit["Bbeh"][1]])
    nb, no, L = th.shape[0], len(t0s), HMAX + 1
    S0 = d["S"][t0s - 1]
    kd = fit.get("zkeys", {}).get("Bbeh", "z")
    resp = _DRResponse([th], [kd], {kd: base[kd]}, S0[None, :], nb, no, L)
    Xb = np.broadcast_to(X, (nb, no)).astype(float)
    o = E.shock_path(base, Xb, None)
    G = np.zeros((nb, no, L))
    for j in range(1, L):
        G[:, :, j] = resp(j, np.broadcast_to(o["dz"][..., :j], (nb, no, j)), np.broadcast_to(o["dzb"][..., :j], (nb, no, j)))[0]
    cs = np.cumsum(G[..., 1:], axis=-1)
    return np.stack([cs[..., h - 1] / Xb for h in HS], axis=-1)


def cells_from(kern, d, t0s, comps=("DR", "D", "Rp", "Bmech")):
    """kern: {'X1': {comp: (nb, no, 3)}, 'X2': {...}} -> cell summaries (point = draw 0; CI from draws 1..)."""
    i = t0s - 1
    above = d["util"][i] >= d["kink"][i]
    cash = np.maximum(d["cash"][i], 0)
    ok = 0.02 * d["S"][i] < cash
    masks = {"pooled": ("X1", ok), "below": ("X1", ok & ~above), "above": ("X1", ok & above),
             "cash0": ("X2", np.ones(len(i), bool))}
    out = {}
    for comp in comps:
        for nm, (xk, m) in masks.items():
            if m.sum() == 0 or comp not in kern[xk]:
                continue
            a = kern[xk][comp][:, m, :].mean(1)          # (nb, 3)
            out.setdefault(comp, {})[nm] = {
                f"{h}h": {"est": float(a[0, k]), "lo": float(np.percentile(a[1:, k], 2.5)),
                          "hi": float(np.percentile(a[1:, k], 97.5)), "sd": float(a[1:, k].std())}
                for k, h in enumerate(HS)}
            out[comp][nm]["nOrigins"] = int(m.sum())
    return out


def run_candidate(d, t, t0s, B, seed, opts=(), ykeys=("yD", "yRp"), block_days=30, with_bbeh=True):
    f = fit_srdr(d, t, B=B, seed=seed, opts=opts, ykeys=ykeys, block_days=block_days)
    i = t0s - 1
    X1 = 0.02 * d["S"][i]
    X2 = np.maximum(d["cash"][i], 0) + X1
    wk = "wker" in opts
    kern = {"X1": kernel_dr(f, d, t0s, X1, wker=wk), "X2": kernel_dr(f, d, t0s, X2, wker=wk)}
    if with_bbeh:
        kern["X1"]["Bbeh"] = kernel_bbeh(f, d, t0s, X1)
        kern["X2"]["Bbeh"] = kernel_bbeh(f, d, t0s, X2)
    res = cells_from(kern, d, t0s, comps=("DR", "D", "Rp", "Bmech") + (("Bbeh",) if with_bbeh else ()))
    res["theta"] = {"D": f["D"][0].tolist(), "Rp": f["Rp"][0].tolist(), "zkeys": f["zkeys"]}
    return res


# ---------------------------------------------------------------------------------------------- LP-DR (reported)
def fit_lpdr_state(d, t, B=200, seed=1):
    """Local projection of non-repeat D+Rp(h) (hour-t withdrawers removed via own arrays when present) on the
    largest non-repeat unit's withdrawal surprise, split by regime. Reported comparator, not a candidate."""
    rng = np.random.default_rng(seed)
    X1 = R.lp_controls(d, t, False)
    X2 = R.lp_controls(d, t, True)
    wrep = d["Wrep"]
    crowd = d["W"][t] - d["Wtop"][t] - wrep[t]
    cc = np.column_stack([crowd, np.log1p(np.maximum(crowd, 0)), wrep[t], np.log1p(wrep[t])])
    X1 = np.column_stack([X1, cc])
    reg = (d["util"][t - 1] >= d["kink"][t - 1]).astype(float)
    X2 = np.column_stack([X2, cc, reg])
    s = R._resid(X1, d["Wtop"][t])
    Rg = R._resid(X2, np.column_stack([s * (reg == 0), s * (reg == 1)]))
    y = d["yD"] + d["yRp"]
    cs = np.r_[0.0, np.cumsum(y)]
    Y = R._resid(X2, np.column_stack([cs[t + h + 1] - cs[t + 1] for h in HS]))
    bidx, Wb = R._block_draws(d["block"][t], B, rng)
    nb = Wb.shape[1]
    RR = np.stack([Rg[bidx == b].T @ Rg[bidx == b] for b in range(nb)])
    RY = np.stack([Rg[bidx == b].T @ Y[bidx == b] for b in range(nb)])
    est = np.linalg.solve(RR.sum(0), RY.sum(0))
    bs = np.stack([np.linalg.solve(np.tensordot(w, RR, 1), np.tensordot(w, RY, 1)) for w in Wb])
    out = {}
    for i_, nm in enumerate(("below", "above")):
        out[nm] = {f"{h}h": {"est": float(est[i_, k]), "lo": float(np.percentile(bs[:, i_, k], 2.5)),
                             "hi": float(np.percentile(bs[:, i_, k], 97.5))} for k, h in enumerate(HS)}
    return out


# ================================================================================================ synthetic runner
# frozen at the R18.4 registration (development on Dv4 only; D-R18.4a). Other opts ("cash", "nowlag", "blag", "act0",
# "rpd", "fast") were development variants and are not candidates.
CANDIDATES = {"SRDR": dict(opts=("lvl", "rpb")), "SRDR-W": dict(opts=("lvl", "rpb", "wker"))}


def one_rep(args):
    name, r, B, cands = args
    cfg = DESIGNS[name]
    sim = Sim4(cfg, cfg["seed0"] + r)
    P, ev, T, maxdev = sim.run(seed=cfg["seed0"] + r)
    n = len(P)
    d = make_view(P, ev, sim.eth)
    t = np.arange(LAG0, n - HMAX - 1)
    t0s = T["t0"].to_numpy()
    res = {"rep": r, "maxBaseDev": maxdev, "repeat": d["meta"], "truth": truth_cells(T), "desc": {
        "utilQ": [float(x) for x in np.quantile(d["util"], [0.01, 0.5, 0.99])],
        "shareAbove": float((d["util"] >= d["kink"]).mean()), "hoursCash0": int((d["cash"] < 1e-3 * d["S"]).sum()),
        "blockedShareOfDemand": float(P["Bblk"].sum() / P["Bdem"].sum()), "nNews": int(len(sim.news)),
        "Sfinal": float(d["S"][-1]), "Wq99": float(np.quantile(d["W"], 0.99))}}
    for cn in cands:
        res[cn] = run_candidate(d, t, t0s, B, r + 2, **CANDIDATES[cn])
    res["LPDR"] = fit_lpdr_state(d, t, B=B, seed=r + 1)
    return res


def check(reps, est_get, tru_get):
    out = {}
    for h in HS:
        k = f"{h}h"
        rows = [(est_get(r), tru_get(r)) for r in reps]
        rows = [(e[k], tr[k]) for e, tr in rows if e is not None and tr is not None and np.isfinite(tr[k])]
        if not rows:
            continue
        est = np.array([e["est"] for e, _ in rows])
        tru = np.array([t_ for _, t_ in rows])
        lo = np.array([e["lo"] for e, _ in rows])
        hi = np.array([e["hi"] for e, _ in rows])
        bias = float((est - tru).mean())
        tol = max(0.03, 0.25 * abs(float(tru.mean())))
        cov = float(((lo <= tru) & (tru <= hi)).mean())
        ub = float((hi >= tru).mean())
        out[k] = {"truth": float(tru.mean()), "meanEst": float(est.mean()), "bias": bias, "tol": tol,
                  "sdEst": float(est.std()), "coverage": cov, "ubConservative": ub, "n": len(rows),
                  "passBias": abs(bias) <= tol, "passCov": cov >= 0.85, "passUB": ub >= 0.90}
        out[k]["pass"] = out[k]["passBias"] and out[k]["passCov"] and out[k]["passUB"]
    out["passAll"] = bool(out) and all(v["pass"] for kk, v in out.items() if kk.endswith("h"))
    return out


def _dig(o, ks):
    for k in ks:
        if not isinstance(o, dict) or k not in o:
            return None
        o = o[k]
    return o


def synth_summary(reps, cands):
    g = lambda *ks: (lambda r: _dig(r, ks))
    S = {}
    for cn in cands:
        for cell in CELLS:
            S[f"{cn} DR {cell}"] = check(reps, g(cn, "DR", cell), g("truth", "DR", cell))
            S[f"{cn} Bmech {cell} (info)"] = check(reps, g(cn, "Bmech", cell), g("truth", "Bmech", cell))
            S[f"{cn} Bbeh {cell} (info)"] = check(reps, g(cn, "Bbeh", cell), g("truth", "Bbeh", cell))
    for cell in ("below", "above"):
        S[f"LPDR {cell} (reported)"] = check(reps, g("LPDR", cell), g("truth", "DR", cell))
    return S


def fmt_flags(v):
    return "".join((("B" if v[f"{h}h"]["passBias"] else "b") + ("C" if v[f"{h}h"]["passCov"] else "c")
                    + ("U" if v[f"{h}h"]["passUB"] else "u") + " ") for h in HS if f"{h}h" in v).strip()


def cmd_synth(a):
    os.makedirs(a.work, exist_ok=True)
    cands = a.cands.split(",")
    with Pool(a.procs) as p:
        reps = p.map(one_rep, [(a.design, r, a.boot, cands) for r in range(a.reps)])
    summ = synth_summary(reps, cands)
    out = {"schema": "q26-r184/synth/1", "design": a.design, "cfg": DESIGNS[a.design], "reps": a.reps,
           "boot": a.boot, "candidates": cands, "summary": summ, "perRep": reps,
           "code": {"file": "scripts/research/history-forecasts/r184_kernel.py",
                    "sha256": R.sha256_file(os.path.abspath(__file__)),
                    "engine_sha256": R.sha256_file(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                "r184_engine.py"))}}
    with open(os.path.join(a.work, f"synth-{a.design}.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)
    for k, v in summ.items():
        print(f"{k:28s}", "PASS" if v.get("passAll") else "fail", fmt_flags(v), " | ".join(
            f"{h}: {x['meanEst']:+.3f} ({x['truth']:+.3f}) cov {x['coverage']:.2f} ub {x['ubConservative']:.2f}"
            for h, x in v.items() if h.endswith("h")))
    print("desc", reps[0]["desc"], "maxBaseDev", max(r["maxBaseDev"] for r in reps))


def cmd_calib(a):
    """Truth descriptives only: no candidate is run (used to set a design's stability parameters)."""
    cfg = DESIGNS[a.design]
    rows = []
    for r in range(a.reps):
        sim = Sim4(cfg, cfg["seed0"] + 1000 + r)       # calibration seeds differ from the run seeds
        P, ev, T, md = sim.run(seed=cfg["seed0"] + 1000 + r, n_orig=60)
        tr = truth_cells(T)
        u = P["util"].to_numpy()
        rows.append({"utilQ": np.round(np.quantile(u, [0.01, 0.5, 0.99]), 3).tolist(),
                     "shareAbove": round(float((u >= P["kink"]).mean()), 3),
                     "hoursCash0": int((P["cash"] < 1e-3 * P["S"]).sum()),
                     "blockedShare": round(float(P["Bblk"].sum() / P["Bdem"].sum()), 4),
                     "S_end/S0": round(float(P["S"].iloc[-1] / cfg["S0"]), 2),
                     "Wq99/S": round(float(np.quantile(P["W"] / P["S"], 0.99)), 4), "maxBaseDev": md,
                     "truthDR72": {c: round(tr["DR"][c]["72h"], 3) for c in CELLS},
                     "truthBmech72": {c: round(tr["Bmech"][c]["72h"], 3) for c in CELLS},
                     "truthBbeh72": {c: round(tr["Bbeh"][c]["72h"], 3) for c in CELLS}})
        print(json.dumps(rows[-1]), flush=True)


# ================================================================================================ real data
END_TS = K.END_TS


def cmd_build(a):
    """Unit-level splits of the R18.2 events for Core USDC: repeat set, recent and future withdrawers by kind."""
    os.makedirs(a.work, exist_ok=True)
    cap = {}
    orig = R.own_flows

    def capture(ev, wuh, nh):
        cap["ev"] = ev.copy()
        return np.zeros((4, 1, 1))
    R.own_flows = capture
    try:
        P, _, meta = R.build_market(a.datasets, "USDC", END_TS)
    finally:
        R.own_flows = orig
    ev = cap["ev"]
    n = len(P)
    e = pd.DataFrame({"unit": ev["unit"].to_numpy(), "h": ev["h"].to_numpy().astype(np.int64),
                      "k": ev["k"].to_numpy().astype(int), "s": ev["s"].to_numpy(float)})
    e = e[(e["h"] >= 0) & (e["h"] < n)].reset_index(drop=True)
    rep_fl, recent, fut, wtop, rmeta = unit_splits(e, n)
    np.savez_compressed(os.path.join(a.work, "r184-usdc.npz"), wtop=wtop,
                        **{f"rep_{k}": v for k, v in rep_fl.items()},
                        **{f"recent_{k}": v for k, v in recent.items()}, **{f"future_{k}": v for k, v in fut.items()})
    W = P["W"].to_numpy()
    rmeta.update({"hours": n, "repeatShareOfW": float(rep_fl["W"].sum() / W.sum()),
                  "recentD": float(recent["D"].sum()), "recentRp": float(recent["Rp"].sum()),
                  "futureOnlyD": float(fut["D"].sum()), "futureOnlyRp": float(fut["Rp"].sum()),
                  "D_nr": float(P["D"].sum() - rep_fl["D"].sum()), "Rp_nr": float(P["Rp"].sum() - rep_fl["Rp"].sum())})
    with open(os.path.join(a.work, "build-r184.json"), "w") as f:
        json.dump(rmeta, f, indent=1)
    print(rmeta)


def load_real(a):
    """Core USDC hourly view (R18.2 panel + curve, as r183_kernel.load_real) with the R18.4 unit-level splits."""
    d = R.load_real(a.datasets, a.work182, "USDC")
    P, _ = R.load_panel(a.work182, "USDC")
    cv, chk = K.curve_hourly(a.datasets, "USDC", d["hts"])
    d["s1"], d["s2"], d["base"], d["kink"], d["rf"] = cv["slope1"], cv["slope2"], cv["base"], cv["optimal"], cv["rf"]
    d["cash"] = pd.Series(P["cash"].to_numpy(float)).bfill().to_numpy()      # pre-snapshot hours back-filled
    d["debt"] = pd.Series(P["debt"].to_numpy(float)).bfill().to_numpy()
    d["util"] = pd.Series(d["util"]).bfill().to_numpy()
    d["S"] = d["debt"] + np.maximum(d["cash"], 0.0)
    d["r"] = K.curve_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"])
    zr = K.spread_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"], d["rf"])
    d["z"] = zr - pd.Series(zr).rolling(ZWIN, min_periods=1).mean().to_numpy()
    d["zb"] = d["r"] - pd.Series(d["r"]).rolling(ZWIN, min_periods=1).mean().to_numpy()
    add_fast_spreads(d, zr)
    z = np.load(os.path.join(a.work, "r184-usdc.npz"))
    d["Ball"] = d["B"].copy()
    for k in ("D", "Rp", "B"):
        d[k + "_nr"] = d[k] - z[f"rep_{k}"]
    d["Wrep"] = z["rep_W"]
    d["Wtop"] = z["wtop"]
    d["yD"] = d["D_nr"] - z["recent_D"]
    d["yRp"] = d["Rp_nr"] - z["recent_Rp"]
    d["yDf"] = d["yD"] - z["future_D"]
    d["yRpf"] = d["yRp"] - z["future_Rp"]
    d["curveCheck"] = chk
    return d


def _cut(d, t, name):
    return K._cut(d, t, name)


def cmd_fit(a):
    os.makedirs(a.out, exist_ok=True)
    B = a.boot
    d = load_real(a)
    t_all = R.origins(d)
    rng = np.random.default_rng(20261840)
    t0s = np.sort(rng.choice(t_all, 400, replace=False))
    res = {"schema": "q26-r184/fit/1", "market": "Aave V3 Ethereum Core USDC (seen, development)", "B": B,
           "candidate": a.cand, "curveCheck": d["curveCheck"],
           "desc": {"hoursCashLE1M": int((d["cash"][t_all] <= 1e6).sum()),
                    "shareAboveOptimal": float((d["util"][t_all - 1] >= d["kink"][t_all - 1]).mean())}}
    opts = CANDIDATES[a.cand]["opts"]
    for cut, ykeys in (("all", ("yD", "yRp")), ("exQ2", ("yD", "yRp")), ("noFutureWithdrawers", ("yDf", "yRpf"))):
        t = _cut(d, t_all, "exQ2" if cut == "exQ2" else "all")
        so = t0s[np.isin(t0s, t)]
        res[cut] = run_candidate(d, t, so, B, 1, opts=opts, ykeys=ykeys)
        res[cut]["nOrigins"] = int(len(t))
        print(cut, json.dumps({c: res[cut]["DR"][c]["72h"]["est"] for c in res[cut]["DR"]}), flush=True)
    res["lpdr"] = fit_lpdr_state(d, t_all, B=B, seed=4)
    loo = []
    for b in np.unique(d["block"][t_all]):
        tt = t_all[d["block"][t_all] != b]
        so = t0s[np.isin(t0s, tt)]
        c1 = run_candidate(d, tt, so, 2, 7, opts=opts, with_bbeh=False)
        loo.append({"block": int(b), "start": int(d["hts"][t_all][d["block"][t_all] == b][0]),
                    "DR": {c: {k: c1["DR"][c][k]["est"] for k in ("3h", "24h", "72h")} for c in c1["DR"]}})
    res["leaveOneBlockOut"] = loo
    res["code"] = {"file": "scripts/research/history-forecasts/r184_kernel.py",
                   "sha256": R.sha256_file(os.path.abspath(__file__))}
    with open(os.path.join(a.out, "fit-r184.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)


def cmd_mech(a):
    """Mechanical-only cap accounting on Core USDC (no D+Rp response): blocked borrows per $ by cell, at the same 400
    origins as `fit`, with base executed borrows as demand. Bounds the cap's share when refill is slow."""
    os.makedirs(a.out, exist_ok=True)
    d = load_real(a)
    t_all = R.origins(d)
    t0s = np.sort(np.random.default_rng(20261840).choice(t_all, 400, replace=False))
    i = t0s - 1
    base = base_path(d, t0s)
    kern = {}
    for xk, X in (("X1", 0.02 * d["S"][i]), ("X2", np.maximum(d["cash"][i], 0) + 0.02 * d["S"][i])):
        o = E.shock_path(base, X, None)
        cs = np.cumsum(o["blocked"][:, 1:], axis=1)
        b = np.stack([cs[:, h - 1] / X for h in HS], axis=1)[None]
        kern[xk] = {"Bmech": np.concatenate([b, b], axis=0),
                    "queueLeft72hPer$": np.concatenate([(o["queue"][:, -1] / X)[None, :, None]] * 2, axis=0)}
    res = cells_from(kern, d, t0s, comps=("Bmech",))
    res["sumBaseBorrows72hPerX2"] = {"median": float(np.median(d["Ball"][t0s[:, None] + np.arange(1, 73)].sum(1) /
                                                                 (np.maximum(d["cash"][i], 0) + 0.02 * d["S"][i])))}
    res["note"] = "no D+Rp response: an upper reading of mechanical blocking; with the fitted SRDR refill see fit-r184.json"
    with open(os.path.join(a.out, "mech-r184.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)
    print(json.dumps({c: res["Bmech"][c]["72h"]["est"] for c in res["Bmech"]}))


def cmd_case(a):
    """April 2026 cash-out recomputed: aligned windows (observed and predicted both count hours i0+1..i0+h from the
    first hour with cash <= $1M) and a non-frozen base (the realised path with the excess drawdown withdrawals put
    back, hour by hour). The model is fitted without 2026Q2."""
    os.makedirs(a.out, exist_ok=True)
    d = load_real(a)
    hts = d["hts"]
    cash = d["cash"]
    lo = np.searchsorted(hts, int(datetime(2026, 4, 1, tzinfo=timezone.utc).timestamp()))
    hi = np.searchsorted(hts, int(datetime(2026, 5, 15, tzinfo=timezone.utc).timestamp()))
    i0 = lo + int(np.argmax(cash[lo:hi] <= 1e6))
    pk = i0 - 72 + int(np.argmax(cash[i0 - 72:i0 + 1]))
    dd = float(cash[pk] - cash[i0])
    out = {"firstCashLE1M": datetime.fromtimestamp(int(hts[i0]), timezone.utc).isoformat(),
           "peakHour": datetime.fromtimestamp(int(hts[pk]), timezone.utc).isoformat(), "drawdownUSD": dd}
    # observed third-party inflow (non-repeat, non-recent), with and without future withdrawers, minus the same
    # hours of week in the prior 4 weeks
    for tag, yk in (("all", ("yD", "yRp")), ("noFutureWithdrawers", ("yDf", "yRpf"))):
        y = d[yk[0]] + d[yk[1]]
        o = {}
        for start, i_s in (("fromCash0", i0), ("fromPeak", pk)):
            for h in HS:
                sl = slice(i_s + 1, i_s + h + 1)
                base = [float(y[i_s + 1 - 168 * w:i_s + h + 1 - 168 * w].sum()) for w in range(1, 5)]
                o[f"{start}_{h}h"] = {"obsUSD": float(y[sl].sum()), "obsPerDrawdown$": float(y[sl].sum()) / dd,
                                     "excessPerDrawdown$": (float(y[sl].sum()) - float(np.mean(base))) / dd,
                                     "D": float(d[yk[0]][sl].sum()), "Rp": float(d[yk[1]][sl].sum())}
        out["observed_" + tag] = o
    # prediction: excess withdrawals over the same-hours baseline in (pk, i0] form the shock vector; the base path
    # is the realised path with those withdrawals put back (cash and supply higher), so it is not frozen
    W = d["W"]
    wb = np.mean([W[pk + 1 - 168 * w:i0 + 1 - 168 * w] for w in range(1, 5)], axis=0)
    xs = np.maximum(W[pk + 1:i0 + 1] - wb, 0.0)
    out["shockExcessWithdrawalsUSD"] = float(xs.sum())
    t = _cut(d, R.origins(d), "exQ2")
    pred = {}
    for tag, yk in (("all", ("yD", "yRp")), ("noFutureWithdrawers", ("yDf", "yRpf"))):
        f = fit_srdr(d, t, B=a.boot, seed=21, opts=CANDIDATES[a.cand]["opts"], ykeys=yk)
        J = pk + 1 + np.arange(HMAX + (i0 - pk) + 1)
        cumx = np.r_[np.cumsum(xs), np.full(len(J) - len(xs), xs.sum())]
        base = {"cash": np.maximum(cash[J], 0.0) + cumx, "S": d["S"][J] + cumx, "debt": d["debt"][J],
                "B": d["Ball"][J], "opt": d["kink"][J], "s1": d["s1"][J], "s2": d["s2"][J],
                "base_rate": d["base"][J], "rf": d["rf"][J]}
        zr = K.spread_rate(base["debt"] / base["S"], base["opt"], base["s1"], base["s2"], base["base_rate"], base["rf"])
        zfull = d["z"].copy()
        zb = zfull[J] - (K.spread_rate(d["util"][J], base["opt"], base["s1"], base["s2"], base["base_rate"],
                                       base["rf"]) - zr)
        thD = np.vstack([f["D"][0][None], f["D"][1]])
        thR = np.vstack([f["Rp"][0][None], f["Rp"][1]])
        nb, L = thD.shape[0], len(J)
        zk = f["zkeys"]
        rb_ = K.curve_rate(base["debt"] / base["S"], base["opt"], base["s1"], base["s2"], base["base_rate"])
        zbb = d["zb"][J] - (d["r"][J] - rb_)
        sc = np.array([[[d["debt"][pk] if f["norm"][k] == "debt" else d["S"][pk]]] for k in ("D", "Rp")])
        zall = {"z": zb, "zb": zbb, "zf": d["zf"][J] - (d["z"][J] - zb), "zbf": d["zbf"][J] - (d["zb"][J] - zbb)}
        resp = _DRResponse([thD, thR], [zk["D"], zk["Rp"]], {k: zall[k][None, :] for k in set((zk["D"], zk["Rp"]))},
                           sc, nb, 1, L)
        # multi-hour shock: feed the excess withdrawals as extra queue demand hour by hour
        o = _multi_shock(base, xs, resp, nb)
        g = o["dD"] + o["dRp"]
        k0 = i0 - pk                     # index of hour i0 in J (J[0] = pk + 1)
        pr = {}
        for h in HS:
            v = g[:, k0 + 1:k0 + h + 1].sum(1) / dd
            vb = o["blocked"][:, k0 + 1:k0 + h + 1].sum(1) / dd
            pr[f"fromCash0_{h}h"] = {"DR": float(v[0]), "lo": float(np.percentile(v[1:], 2.5)),
                                     "hi": float(np.percentile(v[1:], 97.5)), "Bmech": float(vb[0])}
            v2 = g[:, :h].sum(1) / dd
            pr[f"fromPeak_{h}h"] = {"DR": float(v2[0]), "lo": float(np.percentile(v2[1:], 2.5)),
                                    "hi": float(np.percentile(v2[1:], 97.5))}
        pred[tag] = pr
    out["predicted_exQ2"] = pred
    with open(os.path.join(a.out, "case-april2026-r184.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)
    print(json.dumps(out, indent=1, default=float))


def _multi_shock(base, xs, resp, nb):
    """Engine loop (same order and cap as r184_engine.shock_path) with a shock spread over the first len(xs) hours:
    hour j adds xs[j] of extra withdrawal demand to the end of the queue."""
    L = base["cash"].shape[-1]
    sh = (nb, 1)
    out = {k: np.zeros((nb, L)) for k in ("dD", "dRp", "blocked")}
    q = np.zeros(sh)
    gap = np.zeros(sh)
    dS = np.zeros(sh)
    dDebt = np.zeros(sh)
    dz = np.zeros((nb, 1, L))
    dzb = np.zeros((nb, 1, L))
    for j in range(L):
        dD, dRp = (np.zeros(sh), np.zeros(sh)) if j == 0 else resp(j, dz[..., :j], dzb[..., :j])
        q = q + (xs[j] if j < len(xs) else 0.0)
        c, Bb = base["cash"][j], base["B"][j]
        pre = c + Bb + gap + dD + dRp
        Wx = np.minimum(q, np.maximum(pre, 0.0))
        q, pre = q - Wx, pre - Wx
        ex, _ = E.cap_borrows(pre, np.full(sh, Bb))
        gap = pre - ex - c
        dS = dS + dD - Wx
        dDebt = dDebt - dRp + (ex - Bb)
        S_s = base["S"][j] + dS
        debt_s = base["debt"][j] + dDebt
        u_s = np.where(q > 1e-6, 1.0, debt_s / np.maximum(S_s, 1.0))
        a_ = (base["opt"][j], base["s1"][j], base["s2"][j], base["base_rate"][j], base["rf"][j])
        dz[:, :, j] = E.supply_rate(u_s, *a_) - E.supply_rate(base["debt"][j] / base["S"][j], *a_)
        dzb[:, :, j] = E.curve_rate(u_s, *a_[:4]) - E.curve_rate(base["debt"][j] / base["S"][j], *a_[:4])
        out["dD"][:, j], out["dRp"][:, j], out["blocked"][:, j] = dD[:, 0], dRp[:, 0], (Bb - ex)[:, 0]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("synth")
    p.add_argument("--design", required=True)
    p.add_argument("--reps", type=int, default=40)
    p.add_argument("--boot", type=int, default=200)
    p.add_argument("--procs", type=int, default=4)
    p.add_argument("--cands", default="SRDR,SRDR-W")
    p.add_argument("--work", required=True)
    p = sub.add_parser("calib")
    p.add_argument("--design", required=True)
    p.add_argument("--reps", type=int, default=3)
    for nm in ("build", "fit", "case", "mech"):
        p = sub.add_parser(nm)
        p.add_argument("--datasets", required=True)
        p.add_argument("--work182", required=True)
        p.add_argument("--work183", default=None)
        p.add_argument("--work", required=True)
        p.add_argument("--out", default=".")
        p.add_argument("--boot", type=int, default=1000)
        p.add_argument("--cand", default="SRDR")
    a = ap.parse_args(argv)
    {"synth": cmd_synth, "calib": cmd_calib, "build": cmd_build, "fit": cmd_fit, "case": cmd_case,
     "mech": cmd_mech}[a.cmd](a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
