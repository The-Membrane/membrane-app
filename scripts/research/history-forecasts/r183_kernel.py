#!/usr/bin/env python3
"""Q26 R18.3 gross, state-dependent third-party refill kernel (membrane-board design/Q26_ROUND18_PREREG.md, R18.3).

ESTIMAND (parent decision, D-R18.2-review). For a withdrawal surprise s_t ($) in UTC hour t:
  kappa_G(h | state) = d E[ G3P(t, t+h] | s_t, F(t-1), state ] / d s_t ,  h = 3, 24, 72 h,
  G3P(t, t+h] = deposits + repays - borrows in hours t+1..t+h by actors other than the hour-t withdrawers.
Other holders' exits (third-party withdrawals) are NOT in G3P: the depositor-exit modules model them.
The net version (R18.2 rho_3P, which also subtracts third-party withdrawals) is reported beside it.
State: utilisation at t-1 vs the curve's optimal point, the borrow rate, and the cash level, including cash at 0.

  python3 r183_kernel.py synth --design Dv|H|N --reps R --boot B --work <dir>   # synthetic, paired-simulation truth
  python3 r183_kernel.py build --datasets <ds> --work182 <r182 work dir> --work <dir>   # g3P series, rate path
  python3 r183_kernel.py fit   --datasets <ds> --work182 <dir> --work <dir> --out <dir>  # real-data candidates
  python3 r183_kernel.py case  --datasets <ds> --work182 <dir> --work <dir> --out <dir>  # April 2026 case study

Candidates (fixed in D-R18.3a before any real fit):
  LP-G       local projection of G3P(h) on the R18.2 surprise s_t (R18.2 controls), state-independent.
  LP-G-state LP-G with s_t split by the pre-shock regime (u_{t-1} below / at-or-above the optimal point).
  SR         structural rate-curve response: hourly non-recent-withdrawer gross inflow / supply regressed on
             distributed lags of the borrow-rate spread z = r(u) - trailing 168 h mean of r, with calendar,
             activity and AR controls. The kernel is the forward simulation of a withdrawal X through the
             curve (cash, queue at cash 0, utilisation -> rate -> inflow -> cash), evaluated at observed states.
No address is written. Unit ids are hashed in memory only (r182_refill.uid).
"""
import argparse
import copy
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from multiprocessing import Pool

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r182_refill as R  # noqa: E402

HS = (3, 24, 72)
HMAX = 72
LAG0 = 340
ZWIN = 720          # trailing window of the SR rate reference (hours); D-R18.3a
ZKNOT = 0.02        # SR piecewise-linear spread: slope may differ beyond +-2 points (saturation); D-R18.3a
ZKIND = "supply"    # SR spread on the supply rate r(u) * u * (1 - RF) ("borrow": r(u)); D-R18.3a


def spread_rate(u, opt, s1, s2, base, rf):
    r = curve_rate(u, opt, s1, s2, base)
    return r * np.clip(u, 0, 1) * (1 - rf) if ZKIND == "supply" else r


def zpw(z):
    a = np.clip(z, -ZKNOT, ZKNOT)
    return a, z - a


def sha256_file(p):
    return R.sha256_file(p)


# ================================================================================================ rate curve
def curve_rate(u, opt, s1, s2, base=0.0):
    u = np.clip(u, 0.0, 1.0)
    return np.where(u <= opt, base + s1 * u / opt, base + s1 + s2 * (u - opt) / (1.0 - opt))


# ================================================================================================ synthetic DGP
DESIGNS = {
    # development design: may be used for debugging and tuning
    "Dv": dict(n=30000, S0=4e9, u0=0.87, RF=0.10, curves=[(0, 0.90, 0.045, 0.60)],
               act_hi=2.5, act_stay=240, week_amp=0.25, d0=9.0e-4, w0=8e-4, rp0=8e-4, b0=8.4e-4, sig=1.0,
               big_p=0.003, big_scale=0.003, resp="tanh", c=0.08, kD=0.004, kR=0.0016, kB=0.0016, lag_a=0.7,
               bench=(0.032, 0.9995, 3e-4), zr_off=0.008, news_rate=1 / 720, inf_lo=0.01, inf_hi=0.03, wave_lo=0.01,
               wave_hi=0.03, wave_win=(4, 36), dep_hit=0.4, dep_tau=24.0, R_p=1 / 72, R_lo=0.01, R_hi=0.025,
               R_delay=24, R_alias=0.15, seed0=91000),
    # HELD-OUT design (D-R18.3a): run once, after the candidates are frozen
    "H": dict(n=30000, S0=4e9, u0=0.88, RF=0.10, curves=[(0, 0.90, 0.040, 0.60), (15000, 0.92, 0.055, 0.35)],
              act_hi=3.0, act_stay=240, week_amp=0.30, d0=9.6e-4, w0=8e-4, rp0=7e-4, b0=7.6e-4, sig=1.1,
              big_p=0.004, big_scale=0.004, resp="tanh", c=0.04, kD=0.006, kR=0.0025, kB=0.0025, lag_a=0.85,
              bench=(0.030, 0.9997, 2.5e-4), zr_off=0.008, news_rate=1 / 504, inf_lo=0.015, inf_hi=0.04, wave_lo=0.02,
              wave_hi=0.05, wave_win=(4, 48), dep_hit=0.6, dep_tau=36.0, R_p=1 / 60, R_lo=0.01, R_hi=0.03,
              R_delay=24, R_alias=0.30, seed0=44300),
}
DESIGNS["N"] = dict(DESIGNS["H"], kD=0.0, kR=0.0, kB=0.0, seed0=55300)   # null: no rate response


class Sim:
    """Hourly pool with an Aave curve, cash capped at 0 and a FIFO withdrawal queue. All randomness is drawn up
    front per hour, so a run from a saved state with an extra withdrawal is a paired (common random numbers)
    simulation."""

    def __init__(self, cfg, seed):
        self.c = cfg
        n = cfg["n"]
        rng = np.random.default_rng(seed)
        t = np.arange(n)
        self.n = n
        hod = t % 24
        # activity: two-state Markov (x act_hi) plus a weekly cycle
        st = np.zeros(n)
        s = 0
        sw = rng.random(n)
        for i in range(1, n):
            if sw[i] < 1.0 / cfg["act_stay"]:
                s = 1 - s
            st[i] = s
        self.A = np.exp(np.log(cfg["act_hi"]) * st + cfg["week_amp"] * np.sin(2 * np.pi * t / 168))
        self.cyc = 1 + 1.5 * (hod == 0) + 0.8 * (hod == 23)
        sg = cfg["sig"]
        ln = lambda: rng.lognormal(-0.5 * sg * sg, sg, n)
        self.eD, self.eW, self.eR, self.eB = ln(), ln(), ln(), ln()
        self.big = np.where(rng.random(n) < cfg["big_p"],
                            np.minimum(cfg["big_scale"] * (rng.pareto(1.8, n) + 1), 0.05), 0.0)
        # repeat unit: random hours, returns after 1..R_delay hours, sometimes from an unlinked alias
        self.Rf = rng.random(n) < cfg["R_p"]
        self.Rsz = rng.uniform(cfg["R_lo"], cfg["R_hi"], n)
        self.Rdl = rng.integers(1, cfg["R_delay"] + 1, n)
        self.Ral = rng.random(n) < cfg["R_alias"]
        # news: informed exit at tau, third-party exit wave later, depressed third-party deposits
        self.inf = np.zeros(n)
        self.wave = np.zeros(n)
        self.dmult = np.ones(n)
        news = np.where(rng.random(n) < cfg["news_rate"])[0]
        self.news = news
        for tau in news:
            self.inf[tau] += rng.uniform(cfg["inf_lo"], cfg["inf_hi"])
            a, b = cfg["wave_win"]
            tot = rng.uniform(cfg["wave_lo"], cfg["wave_hi"])
            hrs = np.arange(tau + a, min(n, tau + b + 1))
            if len(hrs):
                wts = rng.dirichlet(np.ones(len(hrs)))
                self.wave[hrs] += tot * wts
            k = np.arange(tau + 1, min(n, tau + 97))
            self.dmult[k] *= 1 - cfg["dep_hit"] * np.exp(-(k - tau) / cfg["dep_tau"])
        # benchmark rate (unobserved by the candidates) and an observed market driver
        m0, ph, sd = cfg["bench"]
        x = np.zeros(n)
        e = rng.normal(0, sd, n)
        for i in range(1, n):
            x[i] = ph * x[i - 1] + e[i]
        self.bench = m0 + x
        vol = np.exp(np.convolve(rng.normal(0, 0.15, n), np.ones(48) / 48, "same"))
        eth = np.abs(rng.standard_t(4, n)) * vol * 0.006
        for tau in news:
            eth[tau:min(n, tau + 6)] *= 3.0
        self.eth = eth
        # curve per hour
        self.opt = np.zeros(n)
        self.s1 = np.zeros(n)
        self.s2 = np.zeros(n)
        for (h0, o, a1, a2) in cfg["curves"]:
            self.opt[h0:], self.s1[h0:], self.s2[h0:] = o, a1, a2

    def init_state(self):
        c = self.c
        return {"S": c["S0"], "Dbt": c["S0"] * c["u0"], "Sref": c["S0"], "Dref": c["S0"] * c["u0"], "q": [],
                "yD1": 0.0, "yD2": 0.0, "yR1": 0.0, "yR2": 0.0, "Rpend": []}

    def f(self, z):
        c = self.c
        if c["resp"] == "linear":
            return z
        return c["c"] * np.tanh(z / c["c"])

    def step(self, st, t, extra=0.0, rec=None):
        """Advance one hour. Returns (D, Rp, B, Wexec) and appends tracked-unit events to rec (list) if given.
        Units: 1 = repeat unit, 2 = its unlinked alias, 1000+t big exit, 100000+t informed exit, 200000+t wave,
        -1 = the perturbation (never returns)."""
        c = self.c
        S, Dbt = st["S"], st["Dbt"]
        Sr, Dr = st["Sref"], st["Dref"]       # 30-day EMA scales: one shock barely moves them
        A, cy = self.A[t], self.cyc[t]
        mrD = (c["S0"] / Sr) ** c.get("mr", 0.5)                 # weak pull of the scale toward the target
        mrB = (c["S0"] * c["u0"] / Dr) ** c.get("mr", 0.5)
        D = c["d0"] * Sr * A * cy * self.eD[t] * self.dmult[t] * mrD + c["kD"] * Sr * st["yD2"]
        D = max(D, 0.0)
        Rp = max(c["rp0"] * Dr * A * cy * self.eR[t] + c["kR"] * Dr * st["yR2"], 0.0)
        Bd = max(c["b0"] * Dr * A * cy * self.eB[t] * mrB - c["kB"] * Dr * st["yR2"], 0.0)
        # repeat-unit returns due this hour
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
        # new withdrawal demands (generic first), FIFO queue
        q = st["q"]
        gen = c["w0"] * Sr * A * cy * self.eW[t]
        q.append([0, gen, 0, 0])
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
                    st["Rpend"].append((t + dl, self._Rtot(st, amt, e), al))
            else:
                q[0][1] = amt - e
                if u_ == 1:
                    st.setdefault("Racc", 0.0)
                    st["Racc"] = st.get("Racc", 0.0) + e
                break
        Bx = min(Bd, max(cash, 0.0))
        Dbt += Bx
        st["S"], st["Dbt"] = S, Dbt
        st["Sref"] += (S - st["Sref"]) / 720.0
        st["Dref"] += (Dbt - st["Dref"]) / 720.0
        u = Dbt / S
        r = curve_rate(u, self.opt[t], self.s1[t], self.s2[t])
        zD = r * u * (1 - c["RF"]) - self.bench[t]
        zR = r - (self.bench[t] + c["zr_off"])
        a = c["lag_a"]
        st["yD1"] = a * st["yD1"] + (1 - a) * self.f(zD)
        st["yD2"] = a * st["yD2"] + (1 - a) * st["yD1"]
        st["yR1"] = a * st["yR1"] + (1 - a) * self.f(zR)
        st["yR2"] = a * st["yR2"] + (1 - a) * st["yR1"]
        return D + DR, Rp, Bx, Wx

    @staticmethod
    def _Rtot(st, amt, e):
        """Total executed by the repeat unit for this demand (it returns what it took out)."""
        tot = e + st.get("Racc", 0.0)
        st["Racc"] = 0.0
        return tot

    def run(self, n_orig=300, xfrac=0.02, seed=0):
        n = self.n
        st = self.init_state()
        rng = np.random.default_rng(seed + 7)
        orig = np.sort(rng.choice(np.arange(LAG0 + 200, n - HMAX - 2), n_orig, replace=False))
        oset = set(orig.tolist())
        snaps = {}
        out = np.zeros((n, 4))
        Sx = np.zeros(n)
        Dx = np.zeros(n)
        rec = []
        for t in range(n):
            if t in oset:
                snaps[t] = copy.deepcopy(st)
            out[t] = self.step(st, t, rec=rec)
            Sx[t], Dx[t] = st["S"], st["Dbt"]
        # paired-simulation truth at the sampled origins
        truth = []
        maxdev = 0.0
        for t0 in orig:
            s0 = snaps[t0]
            S_, D_ = s0["S"], s0["Dbt"]
            cash0 = S_ - D_
            X1 = xfrac * S_
            X2 = cash0 + xfrac * S_
            base = self._seg(s0, t0, 0.0)
            maxdev = max(maxdev, float(np.abs(base[:, :3] - out[t0:t0 + HMAX + 1, :3]).max() / S_))
            row = {"t0": int(t0), "S": S_, "Dbt": D_, "cash": cash0, "u": D_ / S_, "opt": self.opt[t0 - 1]}
            for nm, X in (("X1", X1), ("X2", X2)):
                p = self._seg(s0, t0, X)
                g = (p[:, 0] + p[:, 1] - p[:, 2]) - (base[:, 0] + base[:, 1] - base[:, 2])
                net = g - (p[:, 3] - base[:, 3]) + np.r_[X, np.zeros(HMAX)] * 0   # third-party W difference
                for h in HS:
                    row[f"{nm}_G_{h}h"] = float(g[1:h + 1].sum() / X)
                    # net excludes the perturbation unit's own executions (queued remainder): computed in _seg
                    row[f"{nm}_N_{h}h"] = float((g[1:h + 1].sum() - (p[1:h + 1, 3] - base[1:h + 1, 3]).sum()
                                                 + self._own_exec[1:h + 1].sum()) / X)
                row[f"{nm}_X"] = X
            truth.append(row)
        P = pd.DataFrame({"W": out[:, 3], "D": out[:, 0], "Rp": out[:, 1], "B": out[:, 2], "O": 0.0,
                          "S": Sx, "debt": Dx})
        P["cash"] = P["S"] - P["debt"]
        P["util"] = P["debt"] / P["S"]
        P["kink"] = self.opt
        P["s1"], P["s2"] = self.s1, self.s2
        P["rf"] = self.c["RF"]
        P["hour_ts"] = R.H0 + 3600 * np.arange(n)
        ev = pd.DataFrame(rec, columns=["unit", "h", "k", "s"])
        return P, ev, pd.DataFrame(truth), maxdev

    def _seg(self, s0, t0, extra):
        st = copy.deepcopy(s0)
        o = np.zeros((HMAX + 1, 4))
        recp = []
        for j in range(HMAX + 1):
            o[j] = self.step(st, t0 + j, extra=extra if j == 0 else 0.0, rec=recp)
        own = np.zeros(HMAX + 1)
        rep = np.zeros(HMAX + 1)
        for (u_, h, k, s) in recp:
            if u_ == -1 and k == 0:
                own[h - t0] += -s
            if u_ in (1, 2) and k > 0:
                rep[h - t0] += s
        self._own_exec = own
        o[:, 0] -= rep          # truth: third parties only (the repeat unit is excluded under both ids)
        return o


def unit_arrays(ev, n, Wtot):
    """own[k][t, j] (R18.2 convention: k 0 W, 1 D, 2 Rp, 3 B; signed) for tracked units, the top unit per hour,
    and the per-hour flows by units with an executed withdrawal in [h-72, h] (for the SR inflow series)."""
    ev = ev.copy()
    wuh = ev[ev["k"] == 0].groupby(["unit", "h"])["s"].sum().reset_index()
    wuh["x"] = -wuh["s"]
    e2 = ev.rename(columns={"k": "k"})[["unit", "h", "s", "k"]]
    own = R.own_flows(e2, wuh[["unit", "h", "x"]], n)
    recent = recent_withdrawer_flows(ev, n)
    top = wuh.sort_values("x", ascending=False).drop_duplicates("h").set_index("h")
    tu = top["unit"].reindex(range(n)).fillna(0).astype(np.int64).to_numpy()
    # the generic (untracked) withdrawal of an hour counts as one unit when it is the largest
    wtop = top["x"].reindex(range(n)).fillna(0).to_numpy()
    tu = np.where(wtop >= 0.5 * Wtot, tu, 3 + np.arange(n))
    return own, recent, tu.astype(np.uint64), wtop


REPEAT_MIN_W = 1e6      # a qualifying withdrawal (USD)
REPEAT_SHARE = 0.5      # redeposit at least this share of it ...
REPEAT_WIN = 24         # ... within this many hours
REPEAT_MIN_N = 10       # units with at least this many such round trips are repeat units (fixed, whole span)


def classify_repeat(ev):
    """Behaviour rule (no address used): unit-hours with withdrawals >= $1M followed by the same unit's
    deposits >= 50% of that amount within 24 h. Units with >= 10 such round trips form the fixed repeat set."""
    w = ev[ev["k"] == 0].groupby(["unit", "h"])["s"].sum().reset_index()
    w["x"] = -w["s"]
    w = w[w["x"] >= REPEAT_MIN_W]
    dep = ev[ev["k"] == 1].groupby(["unit", "h"])["s"].sum().reset_index()
    cnt = {}
    dg = {u: (g["h"].to_numpy(), np.concatenate([[0.0], np.cumsum(g["s"].to_numpy())])) for u, g in dep.groupby("unit")}
    for u, g in w.groupby("unit"):
        if u not in dg:
            continue
        hs, cs = dg[u]
        h = g["h"].to_numpy()
        i0 = np.searchsorted(hs, h, side="right")
        i1 = np.searchsorted(hs, h + REPEAT_WIN, side="right")
        cnt[u] = int(((cs[i1] - cs[i0]) >= REPEAT_SHARE * g["x"].to_numpy()).sum())
    return {u for u, c in cnt.items() if c >= REPEAT_MIN_N}, cnt


def repeat_split(ev, n):
    """Series and arrays with the fixed repeat set removed: rep flows per hour (D, Rp, B, W; positive amounts),
    own_nr (R18.2 convention, non-repeat units only), recent_nr (non-repeat inflow by units with a withdrawal in
    [h-72, h]), Wtop_nr (largest non-repeat single-unit withdrawal per hour)."""
    rep, cnt = classify_repeat(ev)
    isr = ev["unit"].isin(rep).to_numpy()
    er, en = ev[isr], ev[~isr]
    flows = {}
    for k, nm in ((0, "W"), (1, "D"), (2, "Rp"), (3, "B")):
        x = er[er["k"] == k]
        a = np.zeros(n)
        np.add.at(a, x["h"].to_numpy(), np.abs(x["s"].to_numpy()))
        flows[nm] = a
    wuh = en[en["k"] == 0].groupby(["unit", "h"])["s"].sum().reset_index()
    wuh["x"] = -wuh["s"]
    own = R.own_flows(en[["unit", "h", "s", "k"]], wuh[["unit", "h", "x"]], n)
    recent = recent_withdrawer_flows(en, n)
    top = wuh.sort_values("x", ascending=False).drop_duplicates("h").set_index("h")
    wtop = top["x"].reindex(range(n)).fillna(0).to_numpy()
    meta = {"nRepeatUnits": len(rep), "repeatTripsTotal": int(sum(cnt[u] for u in rep)),
            "repeatShareOfW": None}
    return flows, own, recent, wtop, meta


def recent_withdrawer_flows(ev, n, win=72):
    """Signed D + Rp - B at hour h by units that had an executed withdrawal in [h - win, h]."""
    out = np.zeros(n)
    w = ev[ev["k"] == 0]
    inflow = ev[ev["k"] > 0]
    if len(inflow) == 0 or len(w) == 0:
        return out
    wh = {u: np.sort(g["h"].to_numpy()) for u, g in w.groupby("unit")}
    for u, g in inflow.groupby("unit"):
        if u not in wh:
            continue
        hs = wh[u]
        h = g["h"].to_numpy()
        i = np.searchsorted(hs, h, side="right")      # withdrawals at hours <= h
        last = np.where(i > 0, hs[np.maximum(i - 1, 0)], -10 ** 9)
        m = (h - last) <= win
        np.add.at(out, h[m], g["s"].to_numpy()[m])
    return out


# ================================================================================================ candidates
def make_d(P, own, eth, recent, unit, wtop=None):
    P = P.copy()
    P["Wtop_unit"] = unit
    if wtop is not None:
        P["Wtop"] = wtop
    d = R.make_data(P, own, eth)
    d["S"] = P["S"].to_numpy(float) if "S" in P else (P["debt"] + np.maximum(P["cash"], 0)).to_numpy(float)
    d["cash"] = P["cash"].to_numpy(float)
    d["debt"] = P["debt"].to_numpy(float)
    d["s1"] = P["s1"].to_numpy(float)
    d["s2"] = P["s2"].to_numpy(float)
    d["base"] = P["base"].to_numpy(float) if "base" in P else np.zeros(len(P))
    d["rf"] = P["rf"].to_numpy(float) if "rf" in P else np.full(len(P), 0.10)
    d["r"] = curve_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"])
    zr = spread_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"], d["rf"])
    d["z"] = zr - pd.Series(zr).rolling(ZWIN, min_periods=1).mean().to_numpy()
    d["g3P_hour"] = d["D"] + d["Rp"] - d["B"] - recent
    d["Wtop"] = P["Wtop"].to_numpy(float) if "Wtop" in P else d["W"].copy()
    return d


def nr_view(d, flows, own_nr, recent_nr, wtop_nr):
    """d with the repeat set removed from D, Rp, B (outcomes), own = non-repeat hour-t withdrawers, the shock
    series = largest non-repeat unit, and the repeat units' same-hour withdrawals kept as a control."""
    e = dict(d)
    for k in ("D", "Rp", "B"):
        e[k] = d[k] - flows[k]
    e["own"] = own_nr
    e["Wtop"] = wtop_nr
    e["Wrep"] = flows["W"]
    e["g3P_hour"] = e["D"] + e["Rp"] - e["B"] - recent_nr
    return e


def gross_out(d, t, h, mode="3P", pre=False):
    return sum(R.outcomes(d, t, h, mode, comp=c, pre=pre) for c in ("D", "Rp", "B"))


def fit_lpg(d, t, B=200, seed=1, regime=None, with_net=True, shock="top"):
    """LP-G (regime None) or LP-G-state (regime = 0/1 array). Outcomes: G3P(h), and net rho_3P(h).
    shock="W": R18.2 surprise of total withdrawals. shock="top": surprise of the largest single unit's withdrawal,
    with the same hour's other withdrawals (the crowd, an activity proxy) as a control in both stages."""
    rng = np.random.default_rng(seed)
    X1 = R.lp_controls(d, t, False)
    X2 = R.lp_controls(d, t, True)
    if shock == "top":
        wrep = d.get("Wrep", np.zeros_like(d["W"]))
        crowd = (d["W"][t] - d["Wtop"][t] - wrep[t])
        cc = np.column_stack([crowd, np.log1p(np.maximum(crowd, 0)), wrep[t], np.log1p(wrep[t])])
        X1 = np.column_stack([X1, cc])
        X2 = np.column_stack([X2, cc])
        s = R._resid(X1, d["Wtop"][t])
    else:
        s = R._resid(X1, d["W"][t])
    if regime is None:
        regs = [s]
        names = ["all"]
    else:
        X2 = np.column_stack([X2, regime.astype(float)])
        regs = [s * (regime == 0), s * (regime == 1)]
        names = ["below", "above"]
    Rg = R._resid(X2, np.column_stack(regs))
    Ys, keys = [], []
    for h in HS:
        Ys.append(gross_out(d, t, h))
        keys.append(("G", h))
        if with_net:
            Ys.append(R.outcomes(d, t, h, "3P"))
            keys.append(("N", h))
            Ys.append(gross_out(d, t, h, "all"))
            keys.append(("Gall", h))
    Y = R._resid(X2, np.column_stack(Ys))
    bidx, Wb = R._block_draws(d["block"][t], B, rng)
    nb = Wb.shape[1]
    k = Rg.shape[1]
    RR = np.zeros((nb, k, k))
    RY = np.zeros((nb, k, Y.shape[1]))
    for b in range(nb):
        m_ = bidx == b
        RR[b] = Rg[m_].T @ Rg[m_]
        RY[b] = Rg[m_].T @ Y[m_]
    est = np.linalg.solve(RR.sum(0), RY.sum(0))
    bs = np.stack([np.linalg.solve(np.tensordot(w, RR, 1), np.tensordot(w, RY, 1)) for w in Wb])
    out = {}
    for i, nm in enumerate(names):
        for j, (kind, h) in enumerate(keys):
            v = bs[:, i, j]
            out.setdefault(nm, {}).setdefault(kind, {})[f"{h}h"] = {
                "est": float(est[i, j]), "lo": float(np.percentile(v, 2.5)), "hi": float(np.percentile(v, 97.5)),
                "sd": float(v.std())}
    if regime is not None:
        for j, (kind, h) in enumerate(keys):
            v = bs[:, 1, j] - bs[:, 0, j]
            out.setdefault("above_minus_below", {}).setdefault(kind, {})[f"{h}h"] = {
                "est": float(est[1, j] - est[0, j]), "lo": float(np.percentile(v, 2.5)),
                "hi": float(np.percentile(v, 97.5)), "sd": float(v.std())}
        out["shareAbove"] = float(regime.mean())
    # pre-trend of G (all actors) on s, first-stage controls only
    Yp = R._resid(X1, np.column_stack([gross_out(d, t, h, "all", pre=True) for h in HS]))
    e, b_ = R.boot_ratio(s[:, None] * Yp, s * s, d["block"][t], B, rng)
    out["pretrendG"] = dict(zip([f"{h}h" for h in HS], R.summarize(e, b_)))
    out["_s"] = s
    return out


# ---------------------------------------------------------------------------------------------- SR (structural)
def _lagmean(x, t, a, b):
    return R._lagsum(x, t, a, b) / (b - a + 1)


def sr_design(d, t):
    S = np.maximum(d["S"], 1.0)
    y = d["g3P_hour"][t] / S[t - 1]
    gs = d["gross"] / S
    yy = d["g3P_hour"] / np.r_[S[0], S[:-1]]
    z = d["z"]
    cols = [np.ones(len(t)), R._dummies(d["how"][t])]
    cols.append(np.column_stack([_lagmean(gs, t, a_, b_) for a_, b_ in ((1, 24), (25, 168), (169, 336))]))
    cols.append(np.column_stack([d["eth"][t - j] for j in range(0, 7)]))
    ar = np.column_stack([_lagmean(yy, t, 1, 24), _lagmean(yy, t, 25, 168)])
    za, zb = zpw(z)
    zf = np.column_stack([f(x) for x in (za, zb) for f in (lambda v: v[t - 1], lambda v: _lagmean(v, t, 2, 6),
                                                           lambda v: _lagmean(v, t, 7, 24),
                                                           lambda v: _lagmean(v, t, 25, 72))])
    X = np.column_stack([c if c.ndim == 2 else c[:, None] for c in cols] + [ar, zf])
    return X, y, X.shape[1] - 10    # index of the first AR column


def fit_sr(d, t, B=200, seed=3):
    rng = np.random.default_rng(seed)
    X, y, i0 = sr_design(d, t)
    bidx, Wb = R._block_draws(d["block"][t], B, rng)
    nb = Wb.shape[1]
    p = X.shape[1]
    XX = np.zeros((nb, p, p))
    Xy = np.zeros((nb, p))
    for b in range(nb):
        m_ = bidx == b
        XX[b] = X[m_].T @ X[m_]
        Xy[b] = X[m_].T @ y[m_]
    lam = 1e-10 * np.trace(XX.sum(0)) / p
    beta = np.linalg.solve(XX.sum(0) + lam * np.eye(p), Xy.sum(0))
    bs = np.stack([np.linalg.solve(np.tensordot(w, XX, 1) + lam * np.eye(p), np.tensordot(w, Xy, 1)) for w in Wb])
    return {"theta": beta[i0:], "thetaBoot": bs[:, i0:],
            "names": ["ar1_24", "ar25_168"] + [f"{p}{g}" for p in ("zin_", "zout_") for g in ("1", "2_6", "7_24", "25_72")]}


def sr_kernel(theta, st, X):
    """Forward simulation of an extra withdrawal X at hour t0 along the REALISED base path (D-R18.3a).
    theta: (..., 10) = ar1, ar2, inner-piece z1, z2_6, z7_24, z25_72, outer-piece same lags.
    st: per-origin arrays; st["path"] holds base-path arrays (n_orig, HMAX+1) for hours t0-1+j, j = 0..HMAX:
    S, Dbt, cash, opt, s1, s2, base, rf, z (the observed spread). Returns the kernel per $ at HS: (..., n_orig, 3).
    Shocked path: the unrefilled part of X (X - cumulative extra inflow) is withdrawn when cash allows; while it
    exceeds base cash, cash is 0 (queue) and utilisation is 1."""
    th = np.atleast_2d(theta)
    nb, no = th.shape[0], len(X)
    P_ = st["path"]
    L = HMAX + 1
    rs = lambda u, j: spread_rate(u, P_["opt"][:, j], P_["s1"][:, j], P_["s2"][:, j], P_["base"][:, j], P_["rf"][:, j])
    ub = P_["Dbt"] / np.maximum(P_["S"], 1.0)
    rb = np.stack([rs(ub[:, j], j) for j in range(L)], axis=1)          # (no, L)
    za0, zb0 = zpw(P_["z"])
    Dr = np.zeros((nb, no, L))
    Dy = np.zeros((nb, no, L))
    DA = np.zeros((nb, no, L))
    DB = np.zeros((nb, no, L))
    G = np.zeros((nb, no, L))
    cumg = np.zeros((nb, no))
    S0 = P_["S"][:, 0]

    def shocked(j):
        rem = X - cumg                                  # not yet refilled
        cash_s = P_["cash"][:, j] - rem
        queue = np.maximum(-cash_s, 0.0)
        S_s = P_["S"][:, j] - rem + queue
        u = np.where(queue > 1e-6, 1.0, P_["Dbt"][:, j] / np.maximum(S_s, 1.0))
        return rs(u, j) - rb[:, j]

    def upd(j):
        Dz = Dr[:, :, j] - Dr[:, :, :j + 1].sum(2) / ZWIN
        a_, b_ = zpw(P_["z"][:, j] + Dz)
        DA[:, :, j], DB[:, :, j] = a_ - za0[:, j], b_ - zb0[:, j]
    Dr[:, :, 0] = shocked(0)
    upd(0)
    a1, a2 = th[:, 0][:, None], th[:, 1][:, None]
    zi = [th[:, 2 + k][:, None] for k in range(4)]
    zo = [th[:, 6 + k][:, None] for k in range(4)]
    for j in range(1, L):
        m = lambda arr, a, b: arr[:, :, max(0, j - b):max(0, j - a + 1)].sum(2) / (b - a + 1)
        dy = a1 * m(Dy, 1, 24) + a2 * m(Dy, 25, 168)
        for Q_, c_ in ((DA, zi), (DB, zo)):
            dy = dy + c_[0] * Q_[:, :, j - 1] + c_[1] * m(Q_, 2, 6) + c_[2] * m(Q_, 7, 24) + c_[3] * m(Q_, 25, 72)
        Dy[:, :, j] = dy
        g = dy * S0
        G[:, :, j] = g
        cumg = cumg + g
        Dr[:, :, j] = shocked(j)
        upd(j)
    cum = np.cumsum(G, axis=2)
    return np.stack([cum[:, :, h] / X for h in HS], axis=2)


def sr_state(d, t0s):
    i = t0s - 1
    J = i[:, None] + np.arange(HMAX + 1)[None, :]
    path = {"S": d["S"][J], "Dbt": d["debt"][J], "cash": np.maximum(d["cash"][J], 0.0), "opt": d["kink"][J],
            "s1": d["s1"][J], "s2": d["s2"][J], "base": d["base"][J], "rf": d["rf"][J], "z": d["z"][J]}
    return {"S": d["S"][i], "cash": np.maximum(d["cash"][i], 0.0), "path": path}


def sr_cells(fit, d, t0s, xfrac=0.02):
    """SR kernel cells at the given origins: X1 = xfrac*S (cells below/above when X1 < cash), X2 = cash + X1."""
    i = t0s - 1
    st = sr_state(d, t0s)
    X1 = xfrac * st["S"]
    X2 = st["cash"] + X1
    est1 = sr_kernel(fit["theta"], st, X1)[0]
    est2 = sr_kernel(fit["theta"], st, X2)[0]
    bs1 = sr_kernel(fit["thetaBoot"], st, X1)
    bs2 = sr_kernel(fit["thetaBoot"], st, X2)
    above = d["util"][i] >= d["kink"][i]
    ok = X1 < st["cash"]
    cells = {"pooled": (ok, est1, bs1), "below": (ok & ~above, est1, bs1), "above": (ok & above, est1, bs1),
             "cash0": (np.ones(len(i), bool), est2, bs2)}
    out = {}
    for nm, (m, e, b) in cells.items():
        if m.sum() == 0:
            continue
        ee = e[m].mean(0)
        bb = b[:, m, :].mean(1)
        out[nm] = {f"{h}h": {"est": float(ee[k]), "lo": float(np.percentile(bb[:, k], 2.5)),
                             "hi": float(np.percentile(bb[:, k], 97.5)), "sd": float(bb[:, k].std())}
                   for k, h in enumerate(HS)}
        out[nm]["nOrigins"] = int(m.sum())
    return out


# ================================================================================================ synthetic runner
def one_rep(args):
    name, r, B = args
    cfg = DESIGNS[name]
    sim = Sim(cfg, cfg["seed0"] + r)
    P, ev, T, maxdev = sim.run(seed=cfg["seed0"] + r)
    n = len(P)
    own, recent, unit, wtop = unit_arrays(ev, n, P["W"].to_numpy())
    d = make_d(P, own, sim.eth, recent, unit, wtop)
    flows, own_nr, rec_nr, wtop_nr, rmeta = repeat_split(ev, n)
    e = nr_view(d, flows, own_nr, rec_nr, wtop_nr)
    t = np.arange(LAG0, n - HMAX - 1)
    res = {"rep": r, "maxBaseDev": maxdev, "repeat": rmeta, "desc": {
        "utilQ": [float(x) for x in np.quantile(d["util"], [0.01, 0.5, 0.99])],
        "shareAbove": float((d["util"] >= d["kink"]).mean()), "hoursCash0": int((d["cash"] < 1e-3 * d["S"]).sum()),
        "nNews": int(len(sim.news)), "Sfinal": float(d["S"][-1])}}
    # truth cells
    T["above"] = T["u"] >= T["opt"]
    ok = T["X1_X"] < T["cash"]
    tr = {}
    for nm, m in (("pooled", ok), ("below", ok & ~T["above"]), ("above", ok & T["above"])):
        tr[nm] = {f"{h}h": float(T.loc[m, f"X1_G_{h}h"].mean()) for h in HS}
        tr[nm]["n"] = int(m.sum())
        tr[nm + "_net"] = {f"{h}h": float(T.loc[m, f"X1_N_{h}h"].mean()) for h in HS}
    tr["cash0"] = {f"{h}h": float(T[f"X2_G_{h}h"].mean()) for h in HS}
    tr["cash0"]["n"] = int(len(T))
    res["truth"] = tr
    lp = fit_lpg(e, t, B=B, seed=r)
    lpW = fit_lpg(d, t, B=B, seed=r, shock="W")          # R18.2 definitions (net for continuity)
    reg = (d["util"][t - 1] >= d["kink"][t - 1]).astype(int)
    lps = fit_lpg(e, t, B=B, seed=r + 1, regime=reg, with_net=False)
    srf = fit_sr(e, t, B=B, seed=r + 2)
    sr = sr_cells(srf, e, T["t0"].to_numpy())
    strip = lambda o: {k: v for k, v in o.items() if not k.startswith("_")}
    res["lp"] = strip(lp)
    res["lpW"] = strip(lpW)
    res["lps"] = strip(lps)
    res["sr"] = sr
    res["srTheta"] = srf["theta"].tolist()
    res["old_r72"] = R.old_r72(d, t)
    return res


def synth_summary(reps):
    def chk(get_est, get_truth):
        out = {}
        for h in HS:
            k = f"{h}h"
            rows = [(get_est(r), get_truth(r)) for r in reps]
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
    g = lambda *ks: (lambda r: _dig(r, ks))
    S = {
        "LP-G pooled (G)": chk(g("lp", "all", "G"), g("truth", "pooled")),
        "LP-G total-W shock, R18.2 3P (G)": chk(g("lpW", "all", "G"), g("truth", "pooled")),
        "R18.2 LP-3P net (continuity)": chk(g("lpW", "all", "N"), g("truth", "pooled_net")),
        "LP-G-state below": chk(g("lps", "below", "G"), g("truth", "below")),
        "LP-G-state above": chk(g("lps", "above", "G"), g("truth", "above")),
        "SR pooled": chk(g("sr", "pooled"), g("truth", "pooled")),
        "SR below": chk(g("sr", "below"), g("truth", "below")),
        "SR above": chk(g("sr", "above"), g("truth", "above")),
        "SR cash0": chk(g("sr", "cash0"), g("truth", "cash0")),
    }
    S["LP pretrend G (truth 0)"] = chk(g("lp", "pretrendG"), lambda r: {f"{h}h": 0.0 for h in HS})
    return S


def _dig(o, ks):
    for k in ks:
        if not isinstance(o, dict) or k not in o:
            return None
        o = o[k]
    return o


def cmd_synth(a):
    os.makedirs(a.work, exist_ok=True)
    jobs = [(a.design, r, a.boot) for r in range(a.reps)]
    with Pool(a.procs) as p:
        reps = p.map(one_rep, jobs)
    summ = synth_summary(reps)
    out = {"schema": "q26-r183/synth/1", "design": a.design, "cfg": DESIGNS[a.design], "reps": a.reps,
           "boot": a.boot, "summary": summ, "perRep": reps,
           "code": {"file": "scripts/research/history-forecasts/r183_kernel.py",
                    "sha256": sha256_file(os.path.abspath(__file__))}}
    with open(os.path.join(a.work, f"synth-{a.design}.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)
    for k, v in summ.items():
        print(k, "PASS" if v.get("passAll") else "fail", {h: (round(x["truth"], 3), round(x["meanEst"], 3),
                                                               round(x["coverage"], 2), round(x["ubConservative"], 2))
                                                           for h, x in v.items() if h.endswith("h")})
    print("desc", [r["desc"] for r in reps[:3]], "maxBaseDev", max(r["maxBaseDev"] for r in reps))


# ================================================================================================ real data
END_TS = int(datetime(2026, 10, 13, 23, tzinfo=timezone.utc).timestamp())


def curve_hourly(ds, res, hts):
    st = pd.read_csv(os.path.join(ds, "depositor-balances/reserve-state.csv"),
                     usecols=["snapshot", "reserve", "block_ts", "optimal", "base", "slope1", "slope2",
                              "variableBorrowRate_ray", "cash", "variableDebt", "RF_bps"])
    st = st[(st["reserve"] == res) & st["optimal"].notna() & (st["snapshot"] != "asof")].sort_values("block_ts")
    for c in ("optimal", "base", "slope1", "slope2", "variableBorrowRate_ray"):
        st[c] = pd.to_numeric(st[c], errors="coerce") / 1e27
    idx = np.searchsorted(st["block_ts"].to_numpy(), hts, side="right") - 1
    idx = np.clip(idx, 0, None)
    out = {c: st[c].to_numpy()[idx] for c in ("optimal", "base", "slope1", "slope2")}
    out["rf"] = pd.to_numeric(st["RF_bps"], errors="coerce").fillna(1000).to_numpy()[idx] / 1e4
    # instrument check: curve at the snapshot utilisation vs the on-chain variable borrow rate
    cash = pd.to_numeric(st["cash"], errors="coerce").to_numpy()
    debt = pd.to_numeric(st["variableDebt"], errors="coerce").to_numpy()
    u = debt / (debt + cash)
    rc = curve_rate(u, st["optimal"].to_numpy(), st["slope1"].to_numpy(), st["slope2"].to_numpy(),
                    st["base"].to_numpy())
    err = np.abs(rc - st["variableBorrowRate_ray"].to_numpy())
    chk = {"n": int(np.isfinite(err).sum()), "medianAbsErr": float(np.nanmedian(err)),
           "q99AbsErr": float(np.nanquantile(err, 0.99)), "maxAbsErr": float(np.nanmax(err))}
    return out, chk


def cmd_build(a):
    """Repeat-unit split of the R18.2 unit-level events (behaviour rule, hashed ids in memory only)."""
    os.makedirs(a.work, exist_ok=True)
    cap = {}
    orig = R.own_flows

    def capture(ev, wuh, nh):
        cap["ev"] = ev.copy()
        return np.zeros((4, 1, 1))
    out = {}
    for res in ("USDC", "USDT"):
        R.own_flows = capture
        try:
            P, _, meta = R.build_market(a.datasets, res, END_TS)
        finally:
            R.own_flows = orig
        ev = cap["ev"]
        n = len(P)
        e = pd.DataFrame({"unit": ev["unit"].to_numpy(), "h": ev["h"].to_numpy().astype(np.int64),
                          "k": ev["k"].to_numpy().astype(int), "s": ev["s"].to_numpy(float)})
        e = e[(e["h"] >= 0) & (e["h"] < n)]
        flows, own_nr, rec_nr, wtop_nr, rmeta = repeat_split(e, n)
        np.savez_compressed(os.path.join(a.work, f"nr-{res.lower()}.npz"), recent=rec_nr, wtop=wtop_nr,
                            **{f"rep_{k}": v for k, v in flows.items()})
        np.save(os.path.join(a.work, f"own-nr-{res.lower()}.npy"), own_nr.astype(np.float32))
        W = P["W"].to_numpy()
        rmeta["repeatShareOfW"] = float(flows["W"].sum() / W.sum())
        rmeta["repeatShareOfD"] = float(flows["D"].sum() / P["D"].sum())
        big = W >= np.quantile(W[LAG0:], 0.99)
        rmeta["repeatShareOfWInTop1pctHours"] = float(flows["W"][big].sum() / W[big].sum())
        out[res] = {"hours": n, "repeat": rmeta, "recentInflowUSD": float(rec_nr.sum())}
        print(res, out[res], flush=True)
    with open(os.path.join(a.work, "build-r183.json"), "w") as f:
        json.dump(out, f, indent=1)


def load_real(a, res):
    d = R.load_real(a.datasets, a.work182, res)
    P, _ = R.load_panel(a.work182, res)
    hts = d["hts"]
    cv, chk = curve_hourly(a.datasets, res, hts)
    d["s1"], d["s2"], d["base"] = cv["slope1"], cv["slope2"], cv["base"]
    d["kink"] = cv["optimal"]
    d["cash"] = P["cash"].to_numpy(float)
    d["debt"] = P["debt"].to_numpy(float)
    d["S"] = d["debt"] + np.maximum(d["cash"], 0.0)
    d["rf"] = cv["rf"]
    d["r"] = curve_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"])
    zr = spread_rate(d["util"], d["kink"], d["s1"], d["s2"], d["base"], d["rf"])
    d["z"] = zr - pd.Series(zr).rolling(ZWIN, min_periods=1).mean().to_numpy()
    z = np.load(os.path.join(a.work, f"nr-{res.lower()}.npz"))
    flows = {k: z[f"rep_{k}"] for k in ("W", "D", "Rp", "B")}
    own_nr = np.load(os.path.join(a.work, f"own-nr-{res.lower()}.npy")).astype(float)
    d["Wtop"] = d["W"].copy()
    d["g3P_hour"] = d["D"] + d["Rp"] - d["B"]
    e = nr_view(d, flows, own_nr, z["recent"], z["wtop"])
    e["curveCheck"] = chk
    e["d182"] = d
    return e


def _cut(d, t, name):
    h = d["hts"][t]
    q0 = int(datetime(2026, 4, 1, tzinfo=timezone.utc).timestamp())
    q1 = int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp())
    if name == "exQ2":
        return t[(h + 3600 * HMAX < q0) | (h - 3600 * 336 >= q1)]
    return t


def fit_all(d, t, B, seed, sr_orig):
    reg = (d["util"][t - 1] >= d["kink"][t - 1]).astype(int)
    lp = fit_lpg(d, t, B=B, seed=seed)
    lps = fit_lpg(d, t, B=B, seed=seed + 1, regime=reg, with_net=False)
    srf = fit_sr(d, t, B=B, seed=seed + 2)
    so = sr_orig[np.isin(sr_orig, t)]
    sr = sr_cells(srf, d, so)
    return lp, lps, srf, sr


def cmd_fit(a):
    os.makedirs(a.out, exist_ok=True)
    B = a.boot
    d = load_real(a, "USDC")
    t_all = R.origins(d)
    rng = np.random.default_rng(20261830)
    sr_orig = np.sort(rng.choice(t_all, 400, replace=False))
    strip = lambda o: {k: v for k, v in o.items() if not k.startswith("_")}
    res = {"schema": "q26-r183/fit/1", "market": "Aave V3 Ethereum Core USDC (seen, development)", "B": B,
           "curveCheck": d["curveCheck"]}
    for cut in ("all", "exQ2"):
        t = _cut(d, t_all, cut)
        lp, lps, srf, sr = fit_all(d, t, B, 1, sr_orig)
        res[cut] = {"nOrigins": int(len(t)), "lpG": strip(lp), "lpGstate": strip(lps), "sr": sr,
                    "srTheta": dict(zip(srf["names"], srf["theta"].tolist())),
                    "srThetaSD": dict(zip(srf["names"], srf["thetaBoot"].std(0).tolist()))}
        print(cut, "done", flush=True)
    # robustness: leave-one-30-day-block-out (LP-G and SR point estimates), drop the 20 largest origins
    t = t_all
    lp = fit_lpg(d, t, B=50, seed=5)
    s = lp["_s"]
    blocks = np.unique(d["block"][t])
    loo = []
    for b in blocks:
        tt = t[d["block"][t] != b]
        l1 = fit_lpg(d, tt, B=2, seed=6)
        f1 = fit_sr(d, tt, B=2, seed=7)
        c1 = sr_cells(f1, d, sr_orig[np.isin(sr_orig, tt)])
        loo.append({"block": int(b), "start": int(d["hts"][t][d["block"][t] == b][0]),
                    "lpG": {k: l1["all"]["G"][k]["est"] for k in ("3h", "24h", "72h")},
                    "lpN": {k: l1["all"]["N"][k]["est"] for k in ("3h", "24h", "72h")},
                    "sr": {c: {k: c1[c][k]["est"] for k in ("3h", "24h", "72h")} for c in c1}})
    res["leaveOneBlockOut"] = loo
    X2 = R.lp_controls(d, t, True)
    r = R._resid(X2, s[:, None])[:, 0]
    top = t[np.argsort(-r * r)[:20]]
    keep = ~np.isin(t, top)
    tt = t[keep]
    l2 = fit_lpg(d, tt, B=B, seed=8)
    l2s = fit_lpg(d, tt, B=B, seed=9, regime=(d["util"][tt - 1] >= d["kink"][tt - 1]).astype(int), with_net=False)
    f2 = fit_sr(d, tt, B=B, seed=10)
    res["dropTop20"] = {"shockVarShareTop20": float((r[~keep] ** 2).sum() / (r ** 2).sum()),
                        "lpG": strip(l2), "lpGstate": strip(l2s),
                        "sr": sr_cells(f2, d, sr_orig[np.isin(sr_orig, tt)])}
    # USDT (no exact cash path: components only; reported)
    try:
        du = load_real(a, "USDT")
        tu = R.origins(du)
        tu = tu[np.isfinite(du["util"][tu - 1]) & np.isfinite(du["kink"][tu - 1])]
        res["usdt"] = {"lpG": strip(fit_lpg(du, tu, B=B, seed=11)),
                       "lpGstate": strip(fit_lpg(du, tu, B=B, seed=12,
                                                 regime=(du["util"][tu - 1] >= du["kink"][tu - 1]).astype(int),
                                                 with_net=False)),
                       "note": "USDT cash is component-based (no transfer stream); SR not fitted"}
    except Exception as e:   # noqa: BLE001
        res["usdt"] = {"error": str(e)[:200]}
    res["code"] = {"file": "scripts/research/history-forecasts/r183_kernel.py",
                   "sha256": sha256_file(os.path.abspath(__file__))}
    with open(os.path.join(a.out, "fit-r183.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)


def cmd_case(a):
    """April 2026 cash-out case study (named, reported; it is in the seen set)."""
    os.makedirs(a.out, exist_ok=True)
    d = load_real(a, "USDC")
    hts = d["hts"]
    cash, util = d["cash"], d["util"]
    lo = np.searchsorted(hts, int(datetime(2026, 4, 1, tzinfo=timezone.utc).timestamp()))
    hi = np.searchsorted(hts, int(datetime(2026, 5, 15, tzinfo=timezone.utc).timestamp()))
    i0 = lo + int(np.argmax(cash[lo:hi] <= 1e6))           # first hour with cash <= $1M
    pk = i0 - 72 + int(np.argmax(cash[i0 - 72:i0 + 1]))     # cash peak in the prior 72 h
    out = {"firstCashLE1M": datetime.fromtimestamp(int(hts[i0]), timezone.utc).isoformat(),
           "peakHour": datetime.fromtimestamp(int(hts[pk]), timezone.utc).isoformat(),
           "cashPeakUSD": float(cash[pk]), "cashAtI0USD": float(cash[i0]),
           "supplyAtPeakUSD": float(d["S"][pk])}
    dd = float(cash[pk] - cash[i0])
    Wd = float(d["W"][pk + 1:i0 + 1].sum())
    out["drawdownUSD"], out["withdrawalsInDrawdownUSD"] = dd, Wd
    hours_ge97 = 0
    while i0 + hours_ge97 < len(util) and util[i0 + hours_ge97] >= 0.97:
        hours_ge97 += 1
    out["hoursUtilGE0.97"] = hours_ge97
    rec = np.load(os.path.join(a.work, "recent-usdc.npy"))
    for h in HS:
        sl = slice(i0 + 1, i0 + h + 1)
        G_all = float((d["D"][sl] + d["Rp"][sl] - d["B"][sl]).sum())
        G_nonrecent = float((d["D"][sl] + d["Rp"][sl] - d["B"][sl] - rec[sl]).sum())
        W_ = float(d["W"][sl].sum())
        out[f"{h}h"] = {"grossAllUSD": G_all, "grossNonRecentWithdrawersUSD": G_nonrecent, "withdrawalsUSD": W_,
                        "D": float(d["D"][sl].sum()), "Rp": float(d["Rp"][sl].sum()), "B": float(d["B"][sl].sum()),
                        "grossAllPerDrawdown$": G_all / dd, "grossNonRecentPerDrawdown$": G_nonrecent / dd,
                        "cashChangeUSD": float(cash[i0 + h] - cash[i0])}
    # baseline: the same hours of week in the 4 weeks before the peak (gross non-recent inflow)
    base = []
    for w in range(1, 5):
        b0 = i0 - 168 * w
        sl = slice(b0 + 1, b0 + 73)
        base.append(float((d["D"][sl] + d["Rp"][sl] - d["B"][sl] - rec[sl]).sum()))
    out["baseline72hSameHoursPrior4wUSD"] = base
    out["excess72hNonRecentPerDrawdown$"] = (out["72h"]["grossNonRecentWithdrawersUSD"] - float(np.mean(base))) / dd
    # rate path
    out["borrowRateAtI0"] = float(d["r"][i0])
    out["borrowRateTrailing168AtPeak"] = float(pd.Series(d["r"]).rolling(168, min_periods=1).mean().iloc[pk])
    # SR prediction for this case, fitted without 2026Q2 (out-of-sample for the case)
    t = _cut(d, R.origins(d), "exQ2")
    srf = fit_sr(d, t, B=a.boot, seed=21)
    st = {"S": d["S"][pk:pk + 1], "Dbt": d["debt"][pk:pk + 1], "cash": np.maximum(d["cash"][pk:pk + 1], 0),
          "opt": d["kink"][pk:pk + 1], "s1": d["s1"][pk:pk + 1], "s2": d["s2"][pk:pk + 1],
          "base": d["base"][pk:pk + 1]}
    X = np.array([Wd])
    e = sr_kernel(srf["theta"], st, X)[0, 0]
    b = sr_kernel(srf["thetaBoot"], st, X)[:, 0, :]
    out["SR_exQ2_prediction_perWithdrawn$"] = {f"{h}h": {"est": float(e[k]), "lo": float(np.percentile(b[:, k], 2.5)),
                                                         "hi": float(np.percentile(b[:, k], 97.5))}
                                               for k, h in enumerate(HS)}
    out["note"] = ("SR is applied from the cash peak with the drawdown's withdrawals as one shock; its window "
                   "starts at the peak, the observed window starts at cash <= $1M.")
    with open(os.path.join(a.out, "case-april2026.json"), "w") as f:
        json.dump(out, f, indent=1, default=float)
    print(json.dumps(out, indent=1, default=float))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("synth")
    p.add_argument("--design", required=True)
    p.add_argument("--reps", type=int, default=40)
    p.add_argument("--boot", type=int, default=200)
    p.add_argument("--procs", type=int, default=4)
    p.add_argument("--work", required=True)
    for nm in ("build", "fit", "case"):
        p = sub.add_parser(nm)
        p.add_argument("--datasets", required=True)
        p.add_argument("--work182", required=True)
        p.add_argument("--work", required=True)
        p.add_argument("--out", default=".")
        p.add_argument("--boot", type=int, default=1000)
    a = ap.parse_args(argv)
    {"synth": cmd_synth, "build": cmd_build, "fit": cmd_fit, "case": cmd_case}[a.cmd](a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
