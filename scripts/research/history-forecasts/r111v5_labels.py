"""Q26 R11.1-v5 borrower-warning labels from the replay (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1s).

Aave V3 mechanics and Aave's Chainlink oracle are used as a PROXY for the borrower-facing quantity
P(liquidated by H | no action). Polygon is development data. No address leaves this module.

  python3 r111v5_labels.py prices --work WORK --out SCR
      Per-asset minute envelopes (last, min, max) of the engine's Aave oracle rule (hourly read x driver-aggregator
      ratios), written to SCR/px-min.npz (scratch).
  python3 r111v5_labels.py fh --datasets DS --out SCR [--workers 2]
      Raw (fH), (a) and labels of r192_borrower.task on the D13 III grids of ETH, BTC, LINK and AAVE at the dense
      ladder (D-R11.1s), daily 00:00Z origins. SCR/fh-dense.npz (scratch; can be published: no account data).
  python3 r111v5_labels.py labels --work WORK --scr SCR --datasets DS
      Positions at every daily 00:00Z origin, label A (Chainlink, frozen position), distance k*, label B (III TWAP,
      single-asset subset), no-action and real-liquidation flags. SCR/rows-*.npz (scratch: holds account ids).
  python3 r111v5_labels.py report --scr SCR --out OUT
      Address-free aggregates (distance distribution, label rates, no-action check, rescue-adjusted rate, (fH)
      validation with weekly-block bootstrap intervals) to OUT.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v3_engine as E  # noqa: E402
import r111v3_gate as G  # noqa: E402
import r10_mechanics as M  # noqa: E402

HS = (6, 12, 24, 72, 168)
DENSE = tuple(-x / 1000 for x in (5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100, 120, 150, 175, 200, 250, 300, 400, 500))
STABLE_SYMS = {"DAI", "USDC", "USDT0", "USDT", "miMATIC", "EURS", "jEUR", "EURA", "agEUR", "USDC.e", "GHO", "LUSD", "FRAX"}
SERIES = {"WETH": ("binance:ETHUSDT", "ETHUSDT"), "WBTC": ("binance:BTCUSDT", "BTCUSDT"),
          "LINK": ("A2:LINKUSDT", "LINKUSDT"), "AAVE": ("A3:AAVEUSDT", "AAVEUSDT")}
D13_DIR = "history-forecasts/r19/d13-inputs-93d337c9"
FIRST_ORIGIN = dt.date(2022, 3, 16)
LAST_ORIGIN = dt.date(2026, 9, 23)
MIN_DEBT = 100.0
BUCKETS = (0.0, 0.01, 0.02, 0.05, 0.10, 0.20, 0.30, 0.50, 10.0)
VBUCKETS = (0.0, 0.02, 0.05, 0.10, 0.20, 0.30)
DAY = 86400


def utc(d):
    return int(dt.datetime.combine(d, dt.time(), dt.timezone.utc).timestamp())


# =====================================================================================================================
# prices: minute envelopes of the engine's Aave oracle rule
# =====================================================================================================================
def asset_points(inp, hours, hour_key, a, by_agg):
    """(ts, price) of asset a under the engine rule: at each hourly read px_h; at each driver update inside the hour
    px_h x prod(A_f / A_f(at the hour read)) (factor 1 when either answer is not positive)."""
    n_h = len(hours)
    drv = [tuple(inp.drivers_at(h["block"]).get(a, ())) for h in hours]
    pxh = np.array([h["prices"][a] for h in hours])
    hts = np.array([h["hour"] for h in hours], dtype=np.int64)
    pts_t, pts_p = [hts], [pxh]
    i = 0
    while i < n_h:
        j = i
        while j + 1 < n_h and drv[j + 1] == drv[i]:
            j += 1
        D = drv[i]
        if D:
            lo, hi = hour_key[i], (hour_key[j + 1] if j + 1 < n_h else np.iinfo(np.int64).max)
            ev_k, ev_t = [], []
            for f in D:
                kf, tf, _ = by_agg[f]
                s, e = np.searchsorted(kf, lo, "right"), np.searchsorted(kf, hi, "right")
                ev_k.append(kf[s:e])
                ev_t.append(tf[s:e])
            k_all = np.concatenate(ev_k)
            t_all = np.concatenate(ev_t)
            if len(k_all):
                o = np.argsort(k_all, kind="stable")
                k_all, t_all = k_all[o], t_all[o]
                hi_idx = np.searchsorted(hour_key, k_all, "right") - 1
                ratio = np.ones(len(k_all))
                for f in D:
                    kf, _, af = by_agg[f]
                    ia = np.searchsorted(kf, k_all, "right") - 1
                    ih = np.searchsorted(kf, hour_key[hi_idx], "right") - 1
                    A_now = np.where(ia >= 0, af[np.maximum(ia, 0)], np.nan)
                    A_h = np.where(ih >= 0, af[np.maximum(ih, 0)], np.nan)
                    ok = (A_now > 0) & (A_h > 0)
                    ratio *= np.where(ok, A_now / np.where(ok, A_h, 1.0), 1.0)
                pts_t.append(t_all)
                pts_p.append(pxh[hi_idx] * ratio)
        i = j + 1
    t = np.concatenate(pts_t)
    p = np.concatenate(pts_p)
    o = np.argsort(t, kind="stable")
    return t[o], p[o]


def minute_env(t, p, T0, nmin):
    """last / min / max of a step path over each minute [T0 + 60 m, T0 + 60 (m + 1)); the value carried into a minute
    counts in its envelope."""
    m = (t - T0) // 60
    keep = (m >= 0) & (m < nmin)
    m, p = m[keep], p[keep]
    last = np.full(nmin, np.nan, dtype=np.float64)
    mn = np.full(nmin, np.inf)
    mx = np.full(nmin, -np.inf)
    if len(m):
        # t is sorted, so each minute's points are contiguous
        starts = np.r_[0, np.nonzero(np.diff(m))[0] + 1]
        um = m[starts]
        mn[um] = np.minimum.reduceat(p, starts)
        mx[um] = np.maximum.reduceat(p, starts)
        lastpos = np.r_[starts[1:] - 1, len(m) - 1]
        last[um] = p[lastpos]
    # forward fill last; the carried value enters the next minute's envelope
    idx = np.where(np.isfinite(last), np.arange(nmin), -1)
    np.maximum.accumulate(idx, out=idx)
    carry = np.where(idx >= 0, last[np.maximum(idx, 0)], np.nan)
    prev = np.r_[np.nan, carry[:-1]]
    has_prev = np.isfinite(prev)
    mn = np.where(has_prev, np.minimum(mn, prev), mn)
    mx = np.where(has_prev, np.maximum(mx, prev), mx)
    mn = np.where(np.isfinite(mn), mn, carry)
    mx = np.where(np.isfinite(mx), mx, carry)
    return carry.astype(np.float32), mn.astype(np.float32), mx.astype(np.float32)


def cmd_prices(a):
    t0 = time.time()
    inp = E.Inputs(a.work)
    inp.load_oracle()
    hours = G.arb_hours(inp, a.work)
    hour_key = np.array([h["block"] * 1_000_000 + 999_999 for h in hours], dtype=np.int64)
    ora = inp.ora
    o = np.argsort(ora["agg"], kind="stable")
    ag = ora["agg"][o]
    bounds = np.r_[0, np.nonzero(np.diff(ag))[0] + 1, len(ag)]
    by_agg = {}
    for s, e in zip(bounds[:-1], bounds[1:]):
        if e > s:
            ii = o[s:e]
            by_agg[int(ag[s])] = (ora["key"][ii], ora["ts"][ii], ora["answer"][ii])
    del o, ag
    T0 = int(hours[0]["hour"])
    nmin = (int(hours[-1]["hour"]) + 3600 - T0) // 60
    L, MN, MX = (np.zeros((inp.R, nmin), np.float32) for _ in range(3))
    for k in range(inp.R):
        t, p = asset_points(inp, hours, hour_key, k, by_agg)
        L[k], MN[k], MX[k] = minute_env(t, p, T0, nmin)
        print(f"asset {inp.symbols[k]} points {len(t):,} {time.time() - t0:.0f}s", flush=True)
    os.makedirs(a.out, exist_ok=True)
    np.savez(os.path.join(a.out, "px-min.npz"), T0=T0, last=L, mn=MN, mx=MX, symbols=np.array(inp.symbols))
    print(json.dumps({"T0": T0, "minutes": nmin, "assets": inp.R, "sec": round(time.time() - t0)}))


# =====================================================================================================================
# fh: dense-ladder raw (fH) on the D13 III grids
# =====================================================================================================================
def _fh_task(args):
    key, path = args
    import r16_dev as RD  # noqa: F401
    import r192_borrower as B
    B.L8 = DENSE
    r = B.task({"key": key, "kind": "grid", "path": path})
    out = {}
    for T, R in r["rows"].items():
        m = R["ts"] % DAY == 0
        out[T] = {k: np.asarray(R[k])[m] for k in ("ts", "y", "a", "fH")}
    return key, out


def cmd_fh(a):
    import multiprocessing as mp
    import r16_dev as RD
    RD.init_btc(a.datasets)
    jobs = [(key, os.path.join(a.datasets, D13_DIR, f"III-{sym}-1h.json.gz")) for key, sym in SERIES.values()]
    with mp.get_context("fork").Pool(int(a.workers or 2)) as pool:
        res = dict(pool.imap_unordered(_fh_task, jobs))
    arr = {}
    for x, (key, sym) in SERIES.items():
        for T, R in res[key].items():
            for k, v in R.items():
                arr[f"{x}|{T}|{k}"] = v
    os.makedirs(a.out, exist_ok=True)
    np.savez(os.path.join(a.out, "fh-dense.npz"), levels=np.array(DENSE), **arr)
    print(json.dumps({"series": list(SERIES), "keys": len(arr)}))


# =====================================================================================================================
# labels
# =====================================================================================================================
def read_iii(datasets, sym):
    import q26_live_d13 as L
    st, g = L.read_grid(os.path.join(datasets, D13_DIR, f"III-{sym}-1h.json.gz"))
    return st, g


def action_and_liq_times(inp, liq_rows):
    """Per account: sorted timestamps of borrower actions (token rows outside own liquidations, borrower flag rows,
    e-mode rows) and of real LiquidationCall rows."""
    tm, fm = E.liq_row_masks(inp, liq_rows)
    t, p = inp.tok, inp.pool
    users = np.concatenate([t["user"][~tm], p["f_user"][~fm], p["e_user"]])
    ts = np.concatenate([t["ts"][~tm], p["f_ts"][~fm], p["e_ts"]])
    o = np.lexsort((ts, users))
    users, ts = users[o], ts[o]
    starts = np.searchsorted(users, np.arange(inp.U + 1))
    lu = np.array([r["u"] if r["u"] is not None else -1 for r in liq_rows], dtype=np.int64)
    lt = np.array([r["ts"] for r in liq_rows], dtype=np.int64)
    o2 = np.lexsort((lt, lu))
    lu, lt = lu[o2], lt[o2]
    lstarts = np.searchsorted(lu, np.arange(inp.U + 1))
    return (ts, starts), (lt, lstarts)


def any_in(times_starts, users, lo, hi):
    """For each user: is there a time in (lo, hi]? lo, hi arrays (per row)."""
    ts, starts = times_starts
    s, e = starts[users], starts[users + 1]
    out = np.zeros(len(users), dtype=bool)
    first = np.full(len(users), -1, dtype=np.int64)
    nz = np.nonzero(e > s)[0]
    for i in nz.tolist():
        seg = ts[s[i]:e[i]]
        j = np.searchsorted(seg, lo[i], "right")
        if j < len(seg) and seg[j] <= hi[i]:
            out[i] = True
            first[i] = seg[j]
    return out, first


def cmd_labels(a):
    t_start = time.time()
    inp = E.Inputs(a.work)
    metas = G.arb_metas(a.work)
    hours = G.arb_hours(inp, a.work)
    import r111v5_gate as V5
    cm = V5.conf_metas(a.work)
    cm_blocks = np.array([m["block"] for m in cm], dtype=np.int64)
    rows_liq = V5.jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    liq = E.liq_rows_with_uid(inp, rows_liq)
    for r, x in zip(liq, rows_liq):
        r["ts"] = x["ts"]
    act, lq = action_and_liq_times(inp, liq)
    px = np.load(os.path.join(a.scr, "px-min.npz"))
    T0, PL, PMN, PMX = int(px["T0"]), px["last"], px["mn"], px["mx"]
    sym = list(inp.symbols)
    R = inp.R
    stable = np.array([s in STABLE_SYMS for s in sym])
    inv_unit = 1.0 / (10.0 ** inp.dec)
    iii = {x: read_iii(a.datasets, s) for x, (_, s) in SERIES.items()}
    xk = {x: sym.index(x) for x in SERIES if x in sym}
    # stream of position events
    t, p = inp.tok, inp.pool
    tk = t["block"] * 1_000_000 + t["lidx"]
    fk = p["f_block"] * 1_000_000 + p["f_lidx"]
    ek = p["e_block"] * 1_000_000 + p["e_lidx"]
    st = E.State(inp)
    idx = E.Indexes(inp)
    ptr_t = ptr_f = ptr_e = 0
    hour_of = {h["hour"]: i for i, h in enumerate(hours)}
    days_sorted = sorted(metas)
    day_cache = {}

    def day_cfg(d, b_h):
        md = days_sorted[max(np.searchsorted(days_sorted, d, "right") - 1, 0)]
        ab = metas[md].get("block", 0)
        j = int(np.searchsorted(cm_blocks, b_h, "right")) - 1
        key = ("c", j) if (j >= 0 and cm_blocks[j] > ab) else ("d", md)
        if key not in day_cache:
            meta = cm[j] if key[0] == "c" else metas[md]
            g = {x: inp.gidx[x] for x in meta["reserves"] if x in inp.gidx}
            day_cache[key] = M.Day({**meta, "reserves": {x: r for x, r in meta["reserves"].items() if x in g}}, inp.gidx)
        return day_cache[key]

    out = {k: [] for k in ("day", "u", "debt", "hf0", "kstar", "fc_min", "fc_min_last", "act_first", "liq_first",
                           "singleX", "kX", "yB", "pos_ge1", "stable_debt", "nvol")}
    n_minutes = 168 * 60
    d = FIRST_ORIGIN
    n_cand_total = 0
    while d <= LAST_ORIGIN:
        t_or = utc(d)
        hi = hour_of.get(t_or)
        if hi is None:
            d += dt.timedelta(days=1)
            continue
        h = hours[hi]
        K = h["block"] * 1_000_000 + 999_999
        # apply events with key <= K
        e_t = int(np.searchsorted(tk, K, "right"))
        sl = slice(ptr_t, e_t)
        k_, u_, r_, dl = t["kind"][sl], t["user"][sl], t["res"][sl], t["delta"][sl]
        m0 = k_ == 0
        np.add.at(st.SA, (u_[m0], r_[m0]), dl[m0])
        m1 = k_ == 1
        np.add.at(st.SV, (u_[m1], r_[m1]), dl[m1])
        for i in (np.nonzero(k_ == 2)[0] + ptr_t).tolist():
            st.apply_tok(t, i)
        ptr_t = e_t
        e_f = int(np.searchsorted(fk, K, "right"))
        for i in range(ptr_f, e_f):
            st.apply_flag(p, i)
        ptr_f = e_f
        e_e = int(np.searchsorted(ek, K, "right"))
        for i in range(ptr_e, e_e):
            st.apply_emode(p, i)
        ptr_e = e_e
        idx.advance(K)
        Lt, Vt = idx.at(float(h["ts"]))
        pxh = np.asarray(h["prices"], dtype=float)
        day = day_cfg(d.isoformat(), h["block"])
        has_debt = (st.SV > 0.5).any(axis=1) | (st.SP > 0.5).any(axis=1)
        users = np.nonzero(has_debt)[0]
        if len(users) == 0:
            d += dt.timedelta(days=1)
            continue
        ss = E.stable_value(st.SP[users], st.SR[users], st.ST[users], float(h["ts"]))
        debt_u = st.SV[users] * Vt * inv_unit + ss * inv_unit            # units of each debt asset
        debt_usd = (debt_u * pxh).sum(axis=1)
        pos_ge1 = int((debt_usd >= 1.0).sum())
        keep = debt_usd >= MIN_DEBT
        users, debt_u, debt_usd = users[keep], debt_u[keep], debt_usd[keep]
        ems = st.EM[users]
        LT = np.zeros((len(users), R))
        for em in np.unique(ems):
            LT[ems == em] = day.eff(int(em))[0]
        elig = st.FL[users] & (LT > 0)
        cLT = st.SA[users] * Lt * inv_unit * LT * elig                   # LT-weighted collateral units
        coll_usd = (cLT * pxh).sum(axis=1)
        hf0 = np.where(debt_usd > 0, coll_usd / debt_usd, np.inf)
        # distance k*: all non-stable assets move together; stables fixed
        Cst = (cLT * pxh * stable).sum(axis=1)
        Cv = (cLT * pxh * ~stable).sum(axis=1)
        Dst = (debt_u * pxh * stable).sum(axis=1)
        Dv = (debt_u * pxh * ~stable).sum(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            kstar = np.where(Cv - Dv > 0, (Dst + Dv - Cst - Cv) / (Cv - Dv), np.nan)
        # growth rates over the window
        vr = idx.vr.copy()
        lr = idx.lr.copy()
        # screen: lower bound of HF over 7 d with window envelopes
        m0i = (t_or - T0) // 60
        m1i = m0i + n_minutes
        if m1i > PMN.shape[1]:
            break
        wmin = PMN[:, m0i:m1i].min(axis=1).astype(float)
        wmax = PMX[:, m0i:m1i].max(axis=1).astype(float)
        gV = np.exp(np.maximum(vr, 0) * 168 * 3600 / E.YEAR)
        with np.errstate(divide="ignore", invalid="ignore"):
            lb = np.where(debt_usd > 0, (cLT * wmin).sum(axis=1) / (debt_u * wmax * gV).sum(axis=1), np.inf)
        cand = np.nonzero(lb < 1.0)[0]
        n_cand_total += len(cand)
        fc = np.full(len(users), -1, dtype=np.int32)
        fcl = np.full(len(users), -1, dtype=np.int32)
        tau = (np.arange(n_minutes) + 1) * 60.0 / E.YEAR
        for i in cand.tolist():
            ka = np.nonzero(cLT[i] > 0)[0]
            ja = np.nonzero(debt_u[i] > 0)[0]
            num = np.zeros(n_minutes)
            numl = np.zeros(n_minutes)
            for k in ka.tolist():
                g = 1.0 + lr[k] * tau
                num += cLT[i, k] * g * PMN[k, m0i:m1i]
                numl += cLT[i, k] * g * PL[k, m0i:m1i]
            den = np.zeros(n_minutes)
            denl = np.zeros(n_minutes)
            for j in ja.tolist():
                g = np.exp(vr[j] * tau)
                den += debt_u[i, j] * g * PMX[j, m0i:m1i]
                denl += debt_u[i, j] * g * PL[j, m0i:m1i]
            w = np.nonzero(num < den)[0]
            if len(w):
                fc[i] = int(w[0])
            w = np.nonzero(numl < denl)[0]
            if len(w):
                fcl[i] = int(w[0])
        # single-asset subset and label B
        volc = (cLT > 0) & ~stable[None, :]
        vold = (debt_u > 0) & ~stable[None, :]
        nvol = volc.sum(axis=1)
        single = np.full(len(users), -1, dtype=np.int8)
        kX = np.full((len(users), len(HS)), np.nan, dtype=np.float32)
        yB = np.full((len(users), len(HS)), -1, dtype=np.int8)
        for xi, (x, k) in enumerate(xk.items()):
            sel = np.nonzero((nvol == 1) & volc[:, k] & ~vold.any(axis=1))[0]
            if len(sel) == 0:
                continue
            single[sel] = xi
            st_iii, g_iii = iii[x]
            close, low = np.asarray(g_iii["close"], float), np.asarray(g_iii["low"], float)
            b0 = (t_or - st_iii) // 3600            # bar index of the hour starting at t
            if b0 - 1 < 0 or b0 + 168 > len(close):
                continue
            G0 = close[b0 - 1]
            for hj, Hh in enumerate(HS):
                gVh = np.exp(np.maximum(vr, 0) * Hh * 3600 / E.YEAR)
                Dh = (debt_u[sel] * pxh * gVh).sum(axis=1)
                Pst = (cLT[sel] * pxh * stable).sum(axis=1)
                with np.errstate(divide="ignore", invalid="ignore"):
                    pstar = (Dh - Pst) / cLT[sel, k]
                    kk = pstar / pxh[k] - 1.0
                kX[sel, hj] = kk
                lows = low[b0:b0 + Hh]
                if not np.isfinite(G0) or not np.all(np.isfinite(lows)):
                    continue
                yB[sel, hj] = (lows.min() <= G0 * (1.0 + kk)).astype(np.int8)
        # no-action and real liquidation within 7 d (first times kept; per-H flags derive from them)
        hi_t = np.full(len(users), t_or + 168 * 3600, dtype=np.int64)
        lo_t = np.full(len(users), t_or, dtype=np.int64)
        _, act_first = any_in(act, users, lo_t, hi_t)
        _, liq_first = any_in(lq, users, lo_t, hi_t)
        out["day"].append(np.full(len(users), t_or, dtype=np.int64))
        out["u"].append(users.astype(np.int64))
        out["debt"].append(debt_usd.astype(np.float32))
        out["hf0"].append(hf0.astype(np.float32))
        out["kstar"].append(kstar.astype(np.float32))
        out["fc_min"].append(fc)
        out["fc_min_last"].append(fcl)
        out["act_first"].append(act_first)
        out["liq_first"].append(liq_first)
        out["singleX"].append(single)
        out["kX"].append(kX)
        out["yB"].append(yB)
        out["pos_ge1"].append(np.array([pos_ge1], dtype=np.int64))
        out["stable_debt"].append(~vold.any(axis=1))
        out["nvol"].append(nvol.astype(np.int8))
        if d.day == 1:
            print(f"{d} positions {len(users):,} cand {len(cand)} {time.time() - t_start:.0f}s", flush=True)
        d += dt.timedelta(days=1)
    arr = {k: np.concatenate(v) for k, v in out.items()}
    np.savez(os.path.join(a.scr, "rows-labels.npz"), symbols=np.array(sym), series=np.array(list(xk)), **arr)
    print(json.dumps({"rows": int(len(arr["u"])), "screen_candidates": n_cand_total, "sec": round(time.time() - t_start)}))


# =====================================================================================================================
# report (address-free aggregates)
# =====================================================================================================================
def interp_logp(k, levels, P):
    """P: (n, L) probabilities at the dense levels (shallow -> deep); k: (n,) negative distances. Linear in ln p over
    ln(1 + k); |k| below the shallowest level takes its value; beyond the deepest, the deepest value."""
    x = np.log1p(np.asarray(k, float))
    X = np.log1p(np.asarray(levels, float))            # decreasing
    lp = np.log(np.maximum(np.asarray(P, float), 1e-7))
    out = np.empty(len(x))
    j = np.searchsorted(-X, -x)                        # first level deeper than or equal to k
    for i in range(len(x)):
        jj = j[i]
        if jj <= 0:
            out[i] = lp[i, 0]
        elif jj >= len(X):
            out[i] = lp[i, -1]
        else:
            w = (x[i] - X[jj - 1]) / (X[jj] - X[jj - 1])
            out[i] = lp[i, jj - 1] + w * (lp[i, jj] - lp[i, jj - 1])
    return np.minimum(np.exp(out), 1.0)


def auc(p, y):
    y = np.asarray(y, bool)
    n1, n0 = int(y.sum()), int((~y).sum())
    if n1 == 0 or n0 == 0:
        return None
    from scipy.stats import rankdata
    r = rankdata(p)
    return float((r[y].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def calib_slope(p, y):
    """Logistic recalibration slope b in logit P(y) = a + b logit(p) (Newton, 25 steps)."""
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    y = np.asarray(y, float)
    if y.sum() == 0 or y.sum() == len(y):
        return None
    z = np.log(p / (1 - p))
    X = np.c_[np.ones_like(z), z]
    w = np.zeros(2)
    for _ in range(25):
        q = 1 / (1 + np.exp(-(X @ w)))
        g = X.T @ (y - q)
        Hm = (X * (q * (1 - q))[:, None]).T @ X + 1e-9 * np.eye(2)
        step = np.linalg.solve(Hm, g)
        w += step
        if np.abs(step).max() < 1e-8:
            break
    return float(w[1])


def metrics(p, a_, e_, y):
    y = np.asarray(y, float)
    out = {"n": int(len(y)), "pos": int(y.sum())}
    if len(y) == 0:
        return out
    bf, ba, be = (float(np.mean((v - y) ** 2)) for v in (p, a_, e_))
    out.update({"mean_p": float(np.mean(p)), "rate": float(y.mean()),
                "R": float(np.sum(p) / y.sum()) if y.sum() else None, "slope": calib_slope(p, y),
                "brier_fH": bf, "brier_a": ba, "brier_e": be,
                "bss_vs_a": 1 - bf / ba if ba > 0 else None, "bss_vs_e": 1 - bf / be if be > 0 else None,
                "auc_fH": auc(p, y), "auc_a": auc(a_, y), "auc_e": auc(e_, y)})
    return out


def boot_ci(day, p, a_, e_, y, B=1000, seed=20261024, with_auc=True):
    """Weekly-block bootstrap over origin days: 90% intervals of R, BSS vs (a)/(e), AUC differences."""
    wk = (np.asarray(day) // DAY - 4) // 7
    uw, inv = np.unique(wk, return_inverse=True)
    groups = [np.nonzero(inv == i)[0] for i in range(len(uw))]
    rng = np.random.default_rng(seed)
    res = {k: [] for k in ("R", "bss_vs_a", "bss_vs_e", "auc_fH_minus_a", "auc_fH_minus_e", "slope")}
    for _ in range(B):
        ii = np.concatenate([groups[j] for j in rng.integers(0, len(groups), len(groups))])
        yy, pp, aa, ee = y[ii], p[ii], a_[ii], e_[ii]
        if yy.sum() == 0:
            continue
        bf, ba, be = np.mean((pp - yy) ** 2), np.mean((aa - yy) ** 2), np.mean((ee - yy) ** 2)
        res["R"].append(pp.sum() / yy.sum())
        res["bss_vs_a"].append(1 - bf / ba if ba > 0 else np.nan)
        res["bss_vs_e"].append(1 - bf / be if be > 0 else np.nan)
        if with_auc:
            af, aa_, ae = auc(pp, yy), auc(aa, yy), auc(ee, yy)
            res["auc_fH_minus_a"].append(np.nan if None in (af, aa_) else af - aa_)
            res["auc_fH_minus_e"].append(np.nan if None in (af, ae) else af - ae)
    return {k: ([float(np.nanquantile(v, 0.05)), float(np.nanquantile(v, 0.95))] if len(v) else None)
            for k, v in res.items() if k != "slope"}


def bucket_of(absk, edges):
    return np.searchsorted(np.asarray(edges), absk, side="right") - 1


def cmd_report(a):
    t0 = time.time()
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    levels = F["levels"]
    series = [str(x) for x in Z["series"]]
    day, debt, hf0, kst = Z["day"], Z["debt"], Z["hf0"], Z["kstar"]
    fc, fcl, actf, liqf = Z["fc_min"], Z["fc_min_last"], Z["act_first"], Z["liq_first"]
    single, kX, yB = Z["singleX"], Z["kX"], Z["yB"]
    sdebt = Z["stable_debt"] if "stable_debt" in Z.files else np.ones(len(day), bool)
    nvol = Z["nvol"] if "nvol" in Z.files else np.ones(len(day), np.int8)
    simple = sdebt & (nvol <= 1)       # at most one volatile collateral, USD/EUR-stable debt: the envelope is exact
    below = hf0 < 1.0
    absk = np.where(np.isfinite(kst), -kst, np.inf)
    bk = np.where(np.isfinite(kst), bucket_of(absk, BUCKETS), len(BUCKETS) - 1)
    bnames = [f"{BUCKETS[i]*100:g}-{BUCKETS[i+1]*100:g}%" for i in range(len(BUCKETS) - 2)] + [f">{BUCKETS[-2]*100:g}%"]
    years = (day // DAY * DAY).astype("datetime64[s]").astype("datetime64[Y]").astype(int) + 1970
    out = {"item": "Q26 R11.1-v5 borrower-warning labels, Aave V3 Polygon (development, D-R11.1s); Aave mechanics as a "
                   "proxy, not Membrane", "rows_positions": int(len(day)), "origins": int(len(np.unique(day))),
           "positions_ge_1usd_total": int(Z["pos_ge1"].sum()), "rows_below_line_at_origin": int(below.sum()),
           "rows_no_line": int((~np.isfinite(kst) & ~below).sum())}
    # 1. distance distribution
    ok = ~below & np.isfinite(kst)
    out["distance"] = {"quantiles_abs_kstar": {q: float(np.quantile(absk[ok], q)) for q in (0.05, 0.1, 0.25, 0.5, 0.75, 0.9)},
                       "by_bucket": {bnames[i]: int(((bk == i) & ok).sum()) for i in range(len(bnames))},
                       "by_year_bucket": {int(yv): {bnames[i]: int(((bk == i) & ok & (years == yv)).sum())
                                                    for i in range(len(bnames))} for yv in np.unique(years)}}
    out["by_H"] = {}
    for hj, Hh in enumerate(HS):
        Hs = Hh * 3600
        yA = (fc >= 0) & (fc < Hh * 60)
        yAl = (fcl >= 0) & (fcl < Hh * 60)
        act = (actf > 0) & (actf <= day + Hs)
        lq = (liqf > 0) & (liqf <= day + Hs)
        late = (liqf > day + Hs) & (liqf <= day + Hs + DAY)
        sc = ~below
        rep = {"rows": int(sc.sum()), "yA_rate": float(yA[sc].mean()), "yA_last_rate": float(yAl[sc].mean()),
               "yA_envelope_only_share_of_pos": float(((yA & ~yAl)[sc]).sum() / max(yA[sc].sum(), 1)),
               "yA_envelope_only_share_simple": float(((yA & ~yAl)[sc & simple]).sum() / max(yA[sc & simple].sum(), 1)),
               "yA_envelope_only_share_complex": float(((yA & ~yAl)[sc & ~simple]).sum() / max(yA[sc & ~simple].sum(), 1)),
               "rows_simple": int((sc & simple).sum()), "by_bucket": {}, "by_bucket_simple": {}, "by_bucket_complex": {}}
        for i, nm in enumerate(bnames):
            m = sc & (bk == i) & np.isfinite(kst)
            if m.sum() == 0:
                continue
            rep["by_bucket"][nm] = {"n": int(m.sum()), "yA_rate": float(yA[m].mean()),
                                    "real_liq_rate_protocol_only": float(lq[m].mean()),
                                    "no_action_share": float((~act[m]).mean()),
                                    "yA_rate_no_action": float(yA[m & ~act].mean()) if (m & ~act).any() else None,
                                    "real_liq_rate_no_action": float(lq[m & ~act].mean()) if (m & ~act).any() else None}
        for tag, msk in (("by_bucket_simple", simple), ("by_bucket_complex", ~simple)):
            for i, nm in enumerate(bnames):
                m = sc & msk & (bk == i) & np.isfinite(kst)
                if m.sum() == 0:
                    continue
                rep[tag][nm] = {"n": int(m.sum()), "yA_rate": float(yA[m].mean()), "yA_last_rate": float(yAl[m].mean()),
                                "real_liq_rate_protocol_only": float(lq[m].mean()),
                                "yA_rate_no_action": float(yA[m & ~act].mean()) if (m & ~act).any() else None,
                                "real_liq_rate_no_action": float(lq[m & ~act].mean()) if (m & ~act).any() else None}
        # 2b. no-action check on the simple rows (exact label) and with the minute-last label (lower bound)
        for tag, lab, msk in (("no_action_check_simple", yA, simple), ("no_action_check_last_label", yAl, np.ones(len(day), bool))):
            na_ = sc & ~act & msk
            rep[tag] = {"rows": int(na_.sum()), "label1_liq": int((na_ & lab & lq).sum()), "label1_no_liq": int((na_ & lab & ~lq).sum()),
                        "label0_liq": int((na_ & ~lab & lq).sum()), "label0_no_liq": int((na_ & ~lab & ~lq).sum()),
                        "label1_no_liq_small_debt_lt_1k": int((na_ & lab & ~lq & (debt < 1000)).sum()),
                        "label1_no_liq_late_24h": int((na_ & lab & ~lq & late).sum())}
        # 2. no-action instrument check
        na = sc & ~act
        n11, n10 = int((na & yA & lq).sum()), int((na & yA & ~lq).sum())
        n01, n00 = int((na & ~yA & lq).sum()), int((na & ~yA & ~lq).sum())
        small = debt < 1000
        rep["no_action_check"] = {
            "rows": int(na.sum()), "label1_liq": n11, "label1_no_liq": n10, "label0_liq": n01, "label0_no_liq": n00,
            "label0_liq_share_of_label0": n01 / max(n01 + n00, 1), "label1_liq_share_of_label1": n11 / max(n11 + n10, 1),
            "label1_no_liq_reasons": {"late_within_24h_after_H": int((na & yA & ~lq & late).sum()),
                                      "small_debt_lt_1k": int((na & yA & ~lq & ~late & small).sum()),
                                      "other": int((na & yA & ~lq & ~late & ~small).sum())},
            "label0_liq_debt_usd_sum": float(debt[na & ~yA & lq].sum()),
            "label0_liq_by_hf0": {k_: int((na & ~yA & lq & (hf0 >= lo) & (hf0 < hi_)).sum())
                                  for k_, lo, hi_ in (("1-1.01", 1, 1.01), ("1.01-1.05", 1.01, 1.05), ("1.05-1.2", 1.05, 1.2),
                                                      (">=1.2", 1.2, np.inf))}}
        # 3. fH validation on the single-asset subset
        # k <= -100% means stable collateral alone covers the debt: no line, not scored
        sub = sc & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) & (kX[:, hj] > -1)
        vi = np.nonzero(sub)[0]
        pf = np.full(len(vi), np.nan)
        pa = np.full(len(vi), np.nan)
        pe = np.full(len(vi), np.nan)
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            if key + "ts" not in F.files:
                continue
            ts_x, fh_x, a_x, y_x = F[key + "ts"], F[key + "fH"], F[key + "a"], F[key + "y"].astype(float)
            o = np.argsort(ts_x)
            ts_x, fh_x, a_x, y_x = ts_x[o], fh_x[o], a_x[o], y_x[o]
            # as-of climatology: mean of y over rows resolved before t (ts + H <= t)
            cs = np.cumsum(y_x, axis=0)
            mx_ = np.where(single[vi] == xi)[0]
            if len(mx_) == 0:
                continue
            tt = day[vi[mx_]]
            j = np.searchsorted(ts_x, tt)
            have = (j < len(ts_x)) & (ts_x[np.minimum(j, len(ts_x) - 1)] == tt)
            nres = np.searchsorted(ts_x, tt - Hs, side="right")
            clim = np.where((nres > 0)[:, None], cs[np.maximum(nres - 1, 0)] / np.maximum(nres, 1)[:, None], np.nan)
            kk = kX[vi[mx_], hj]
            g = have & (nres >= 30)
            jj = np.minimum(j, len(ts_x) - 1)
            if g.any():
                pf[mx_[g]] = interp_logp(kk[g], levels, fh_x[jj[g]])
                pa[mx_[g]] = interp_logp(kk[g], levels, a_x[jj[g]])
                pe[mx_[g]] = interp_logp(kk[g], levels, np.maximum(clim[g], 1e-7))
        okv = np.isfinite(pf) & np.isfinite(pa) & np.isfinite(pe)
        vi, pf, pa, pe = vi[okv], pf[okv], pa[okv], pe[okv]
        yb = yB[vi, hj].astype(float)
        ya = yA[vi].astype(float)
        kk = -kX[vi, hj]
        vb = bucket_of(kk, VBUCKETS)
        vnames = [f"{VBUCKETS[i]*100:g}-{VBUCKETS[i+1]*100:g}%" for i in range(len(VBUCKETS) - 1)] + [f">{VBUCKETS[-1]*100:g}%"]
        dd = np.round(kk / 0.0025).astype(np.int64)
        keyd = (single[vi].astype(np.int64) * 10**12 + (day[vi] // DAY) * 10**5 + dd)
        _, first = np.unique(keyd, return_index=True)
        dedup = np.zeros(len(vi), bool)
        dedup[first] = True
        val = {"rows_scored": int(len(vi)), "rows_subset_without_fh": int(sub.sum() - len(vi)),
               "series_rows": {x: int((single[vi] == xi).sum()) for xi, x in enumerate(series)}, "by_bucket": {}}
        for i, nm in enumerate(vnames):
            m = vb == i
            if m.sum() == 0:
                continue
            md = m & dedup
            ent = {"labelB_rows": metrics(pf[m], pa[m], pe[m], yb[m]),
                   "labelB_paths": metrics(pf[md], pa[md], pe[md], yb[md]),
                   "labelA_rows": metrics(pf[m], pa[m], pe[m], ya[m])}
            if yb[md].sum() >= 5:
                ent["labelB_paths_ci90"] = boot_ci(day[vi][md], pf[md], pa[md], pe[md], yb[md])
            if yb[m].sum() >= 5:
                ent["labelB_rows_ci90"] = boot_ci(day[vi][m], pf[m], pa[m], pe[m], yb[m], B=1000, with_auc=False)
            ent["agree_labelA_labelB"] = float((ya[m] == yb[m]).mean())
            val["by_bucket"][nm] = ent
        allm = np.ones(len(vi), bool)
        val["all_buckets_paths"] = metrics(pf[dedup], pa[dedup], pe[dedup], yb[dedup])
        val["all_buckets_rows"] = metrics(pf, pa, pe, yb)
        rep["fh_validation"] = val
        out["by_H"][f"{Hh}h"] = rep
        print(f"H {Hh} done {time.time() - t0:.0f}s", flush=True)
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, "r111v5-labels-report.json"), out)
    if G.ADDR_RE.search(open(os.path.join(a.out, "r111v5-labels-report.json")).read()):
        raise SystemExit("address pattern in report")
    print(json.dumps({k: out[k] for k in ("rows_positions", "origins", "rows_below_line_at_origin")}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    for k in ("work", "out", "scr", "datasets", "workers"):
        ap.add_argument(f"--{k}")
    a = ap.parse_args()
    {"prices": cmd_prices, "fh": cmd_fh, "labels": cmd_labels, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
