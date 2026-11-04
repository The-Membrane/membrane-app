"""Q26-PL PL.2: registered forecast cells for Aave V3 Ethereum pair loops (membrane-board design/Q26_PAIR_LOOP_PREREG.md,
registered 2026-11-04, board commit 01a8466). Everything here is fixed by that file. Single series: Aave Core WETH, hourly.

Inputs (membrane-datasets pair-loop/): hourly.jsonl (acquire_hourly.py), strategy_daily.jsonl (acquire_strategy_daily.py),
price-history/lst-rates-1d.json (wstETH stEthPerToken daily, the staking-yield reference).

  counts   positives and positive time blocks per cell (no forecast is computed)   -> what the prereg calls §0.8
  score    the registered score: (a), (e), (fU), (fU+) per cell with one-way block bootstrap, class per R19.3d + 5-block floor
Aggregates only. No address exists in these inputs.
"""
import argparse, gzip, json, math, os, sys
import numpy as np

RAY = 1e27
H_F1 = {"1d": 24, "7d": 168, "30d": 720}
M_F1 = [0.0, 0.02, 0.05, 0.10, 0.20]
H_F2 = {"7d": 168, "30d": 720, "90d": 2160}
LVL_F2 = [0.001, 0.0025, 0.005, 0.01, 0.02]
K_RUN = 24
BLOCK_H = {"1d": 28 * 24, "7d": 28 * 24, "30d": 56 * 24, "90d": 112 * 24}   # 90 d block length chosen before scoring (D-PL.2a)
B_DRAWS, SEED = 1000, 20261104
LAMBDA_DAY, VOL_DAYS, WARMUP_H = 0.94, 90, 90 * 24
MIN_KNOWN_H = 28 * 24          # (a)/(e) need 28 days of known labels before an origin is scored
YEAR_S = 365.0 * 86400


def Phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2))


# ----------------------------------------------------------------------------------------------------- inputs
def load_hourly(path):
    rows = [json.loads(l) for l in (gzip.open(path + ".gz", "rt") if os.path.exists(path + ".gz") else open(path)) if l.strip()]
    rows = [r for r in rows if "err" not in r and r.get("r", {}).get("WETH", {}).get("vbi", 0) > 0]
    rows.sort(key=lambda r: r["t"])
    t = np.array([r["t"] for r in rows], dtype=np.int64)
    # keep one row per hour on the registered grid; drop duplicates
    _, idx = np.unique(t, return_index=True)
    rows = [rows[i] for i in idx]
    t = t[idx]
    w = lambda k: np.array([r["r"]["WETH"][k] for r in rows], dtype=np.float64)
    out = {"t": t, "ts": np.array([r["ts"] for r in rows], dtype=np.int64), "vbr": w("vbr") / RAY, "vbi": w("vbi") / RAY,
           "li_weth": w("li") / RAY,
           "li_wsteth": np.array([r["r"].get("wstETH", {}).get("li", 0) for r in rows], dtype=np.float64) / RAY,
           "px_weth": np.array([r["px"].get("WETH", 0) for r in rows], dtype=np.float64),
           "px_wsteth": np.array([r["px"].get("wstETH", 0) for r in rows], dtype=np.float64)}
    return out


def load_strategy(path):
    rows = [json.loads(l) for l in (gzip.open(path + ".gz", "rt") if os.path.exists(path + ".gz") else open(path)) if l.strip()]
    rows = [r for r in rows if "err" not in r and r.get("a", {}).get("WETH", {}).get("optimal")]
    rows.sort(key=lambda r: r["T"])
    T = np.array([r["T"] for r in rows], dtype=np.int64)
    g = lambda k: np.array([r["a"]["WETH"][k] or 0 for r in rows], dtype=np.float64) / RAY
    return {"T": T, "optimal": g("optimal"), "base": g("base"), "slope1": g("slope1"), "slope2": g("slope2")}


def load_wsteth_rate(path):
    d = json.load(open(path))
    col = d["columns"]["wstethStEthPerToken"]
    t0, step = d["startTs"], d["stepSeconds"]
    T = np.array([t0 + i * step for i in range(len(col))], dtype=np.int64)
    v = np.array([np.nan if x is None else float(x) for x in col])
    ok = ~np.isnan(v)
    return T[ok], v[ok]


# ----------------------------------------------------------------------------------------------- derived series
def asof(T, V, t):
    """V at the last T <= t (per element)."""
    i = np.searchsorted(T, t, side="right") - 1
    i = np.clip(i, 0, len(T) - 1)
    return V[i]


def curve_params(strat, t):
    return tuple(asof(strat["T"], strat[k], t) for k in ("optimal", "base", "slope1", "slope2"))


def rate_to_util(r, opt, base, s1, s2):
    """Invert the Aave V3 variable-rate curve. Returns u in [0, +inf); > 1 means unreachable."""
    r = np.asarray(r, dtype=np.float64)
    low = opt * np.clip(r - base, 0, None) / np.where(s1 > 0, s1, np.inf)
    high = opt + (1 - opt) * (r - base - s1) / np.where(s2 > 0, s2, np.inf)
    return np.where(r <= base + s1, low, high)


def util_to_rate(u, opt, base, s1, s2):
    return np.where(u <= opt, base + s1 * u / opt, base + s1 + s2 * (u - opt) / (1 - opt))


def staking_yield(rT, rV, t, hourly=None):
    """Annualised 30-day trailing wstETH exchange-rate growth at t (daily stEthPerToken; falls back to the oracle ratio)."""
    t = np.asarray(t)
    v1 = asof(rT, rV, t)
    v0 = asof(rT, rV, t - 30 * 86400)
    y = np.log(v1 / v0) * (YEAR_S / (30 * 86400))
    if hourly is not None:
        # fallback where the daily series is missing (its last date before t is older than 2 days)
        stale = (t - asof(rT, rT, t)) > 2 * 86400
        if stale.any():
            er = hourly["px_wsteth"] / np.where(hourly["px_weth"] > 0, hourly["px_weth"], np.nan)
            e1 = asof(hourly["t"], er, t)
            e0 = asof(hourly["t"], er, t - 30 * 86400)
            y = np.where(stale, np.log(e1 / e0) * (YEAR_S / (30 * 86400)), y)
    return y


def ewma_sigma(du, lam_h):
    """EWMA RMS of hourly utilization changes (uses only the past: sigma[i] from du[:i])."""
    s = np.zeros_like(du)
    v = 0.0
    n = 0
    for i in range(len(du)):
        s[i] = math.sqrt(v) if n > 0 else np.nan
        x = du[i] if not np.isnan(du[i]) else 0.0
        v = lam_h * v + (1 - lam_h) * x * x
        n += 1
    return s


def sliding_max(x, w):
    """max of x[i+1 : i+1+w] for each i (future window, exclusive of i). nan where the window is incomplete."""
    n = len(x)
    out = np.full(n, np.nan)
    if n <= w:
        return out
    from collections import deque
    dq = deque()
    for j in range(1, n):
        while dq and x[dq[-1]] <= x[j]:
            dq.pop()
        dq.append(j)
        i = j - w          # window for origin i is (i, i+w]
        if i >= 0:
            while dq[0] <= i:
                dq.popleft()
            out[i] = x[dq[0]]
    return out


def run_indicator(cond, k):
    """1 where a run of k consecutive True ends at this index."""
    c = cond.astype(np.int64)
    cs = np.concatenate([[0], np.cumsum(c)])
    ends = np.zeros(len(cond), dtype=bool)
    ends[k - 1:] = (cs[k:] - cs[:-k]) == k
    return ends


# ------------------------------------------------------------------------------------------------- labels
def build(hourly, strat, rT, rV):
    t = hourly["t"]
    n = len(t)
    opt, base, s1, s2 = curve_params(strat, t)
    r = hourly["vbr"]
    u = rate_to_util(r, opt, base, s1, s2)
    y = staking_yield(rT, rV, t, hourly)
    du = np.diff(u, prepend=np.nan)
    du[np.abs(du) > 0.5] = np.nan     # a curve change between two hours is not utilization movement
    sigma = ewma_sigma(du, LAMBDA_DAY ** (1 / 24))
    # exact accrual of a frozen loop: ln VBI_weth − ln LI_wsteth (collateral supply interest), per hour from t0
    lnvbi = np.log(hourly["vbi"])
    lnli = np.log(np.where(hourly["li_wsteth"] > 0, hourly["li_wsteth"], 1.0))
    acc = lnvbi - lnli
    labels = {}
    for Hn, Hh in H_F1.items():
        for m in M_F1:
            cond = r > (y + m)[:, None].ravel() if False else None
            # the threshold is fixed at the ORIGIN's y(t0); evaluate per origin via the run indicator on r - y(t0) - m.
            # For speed use y at the origin broadcast across its window: do it blockwise.
            lab = np.full(n, np.nan)
            ends_cache = {}
            # vectorised approximation would need per-origin thresholds; loop over origins in chunks of equal y rounding
            yr = np.round(y, 4)
            for yy in np.unique(yr[~np.isnan(yr)]):
                idx = np.where(yr == yy)[0]
                ends = run_indicator(r > yy + m, K_RUN)
                # for origin i, label = any run end in (i + K_RUN - 1, i + Hh]
                cs = np.concatenate([[0], np.cumsum(ends)])
                lo = np.minimum(idx + K_RUN, n)          # run ends at index >= i+K_RUN (run fully inside (i, i+Hh])
                hi = np.minimum(idx + Hh + 1, n)
                ok = (idx + Hh) < n
                val = (cs[hi] - cs[lo]) > 0
                lab[idx[ok]] = val[ok].astype(float)
            labels[("F1", Hn, m)] = lab
    for Hn, Hh in H_F2.items():
        # D(t0,t) − (t−t0)·y(t0) maximised over the window; y per origin -> use the identity
        # max_t [acc(t) − acc(t0) − y0·(t−t0)/yr] computed by chunks of equal rounded y0 (as above)
        lab_by_h = {h: np.full(n, np.nan) for h in LVL_F2}
        yr = np.round(y, 4)
        secs = (hourly["ts"] - hourly["ts"][0]).astype(np.float64)
        for yy in np.unique(yr[~np.isnan(yr)]):
            idx = np.where(yr == yy)[0]
            g = acc - yy * secs / YEAR_S                  # drift removed with this origin group's yield
            mx = sliding_max(g, Hh)
            dec = mx - g                                  # max over (i, i+Hh] of g(t) − g(t0)
            for h in LVL_F2:
                v = dec[idx]
                ok = ~np.isnan(v)
                lab_by_h[h][idx[ok]] = (v[ok] >= h).astype(float)
        for h in LVL_F2:
            labels[("F2", Hn, h)] = lab_by_h[h]
    return {"t": t, "r": r, "u": u, "y": y, "sigma": sigma, "opt": opt, "base": base, "s1": s1, "s2": s2, "labels": labels}


# ------------------------------------------------------------------------------------------------ forecasts
def forecasts(S, key):
    fam, Hn, lvl = key
    t, u, y, sig = S["t"], S["u"], S["y"], S["sigma"]
    opt, base, s1, s2 = S["opt"], S["base"], S["s1"], S["s2"]
    lab = S["labels"][key]
    Hh = (H_F1 if fam == "F1" else H_F2)[Hn]
    n = len(t)
    # threshold rate at the origin
    if fam == "F1":
        rstar = y + lvl
    else:
        rstar = y + lvl / (Hh * 3600 / YEAR_S)          # average-rate proxy: decay h over H means mean excess h/H per year
    ustar = rate_to_util(rstar, opt, base, s1, s2)
    z = (ustar - u) / np.where(sig > 0, sig * math.sqrt(Hh), np.nan)
    fU = np.where(u >= ustar, 1.0, np.minimum(1.0, 2 * (1 - np.vectorize(Phi)(np.nan_to_num(z, nan=50.0)))))
    fU = np.where(ustar > 1.0, 0.0, fU)
    sig2 = np.where(u >= opt, sig * 0.5, sig)
    z2 = (ustar - u) / np.where(sig2 > 0, sig2 * math.sqrt(Hh), np.nan)
    fUp = np.where(u >= ustar, 1.0, np.minimum(1.0, 2 * (1 - np.vectorize(Phi)(np.nan_to_num(z2, nan=50.0)))))
    fUp = np.where(ustar > 1.0, 0.0, fUp)
    # (a) as-of base rate and (e) state climatology, walk-forward with labels known at t0 (origin + H <= t0)
    known = np.zeros(n)
    kn_cnt = np.zeros(n)
    state = (u >= opt).astype(int)
    a = np.full(n, np.nan)
    e = np.full(n, np.nan)
    cum_y = np.zeros(2)
    cum_n = np.zeros(2)
    tot_y = tot_n = 0.0
    j = 0  # origins whose label is known at i: origin index j with j + Hh <= i
    first_known = None
    for i in range(n):
        while j + Hh <= i:
            if not np.isnan(lab[j]):
                tot_y += lab[j]; tot_n += 1
                cum_y[state[j]] += lab[j]; cum_n[state[j]] += 1
                if first_known is None:
                    first_known = i
            j += 1
        if tot_n > 0 and first_known is not None and i - first_known >= MIN_KNOWN_H:
            a[i] = tot_y / tot_n
            s = state[i]
            e[i] = cum_y[s] / cum_n[s] if cum_n[s] > 0 else a[i]
    valid = ~np.isnan(lab) & ~np.isnan(a) & ~np.isnan(e) & ~np.isnan(fU) & (np.arange(n) >= WARMUP_H) & ~np.isnan(sig)
    return {"y": lab, "a": a, "e": e, "fU": fU, "fUp": fUp, "valid": valid, "Hh": Hh}


# ------------------------------------------------------------------------------------------------- statistics
def logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def slope_fit(xbins, ybins, nbins):
    """Weighted logistic y ~ alpha + beta * x on bins (x = mean logit p, y = positives, n = count). Newton, 25 steps."""
    a, b = 0.0, 1.0
    for _ in range(25):
        eta = a + b * xbins
        p = 1 / (1 + np.exp(-eta))
        w = nbins * p * (1 - p)
        g = np.array([np.sum(ybins - nbins * p), np.sum(xbins * (ybins - nbins * p))])
        Hm = np.array([[np.sum(w), np.sum(w * xbins)], [np.sum(w * xbins), np.sum(w * xbins * xbins)]])
        if abs(np.linalg.det(Hm)) < 1e-12:
            return np.nan
        step = np.linalg.solve(Hm, g)
        a, b = a + step[0], b + step[1]
        if np.max(np.abs(step)) < 1e-9:
            break
    return b


def auc_from_bins(pos, neg):
    """pos/neg counts per p-bin sorted ascending by p; ties in a bin count one half."""
    P, N = pos.sum(), neg.sum()
    if P == 0 or N == 0:
        return np.nan
    cneg = np.cumsum(neg) - neg
    return float(np.sum(pos * (cneg + 0.5 * neg)) / (P * N))


def cell_stats(y, p, pa, pe, blocks, rng=None):
    """Point statistics on the rows given. Bins are fixed from the full cell (quantiles of p / logit p)."""
    out = {}
    out["R"] = float(p.sum() / y.sum()) if y.sum() > 0 else np.nan
    bs = lambda q: float(np.mean((q - y) ** 2))
    out["brier"] = bs(p)
    out["BSS_a"] = 1 - bs(p) / bs(pa) if bs(pa) > 0 else np.nan
    out["BSS_e"] = 1 - bs(p) / bs(pe) if bs(pe) > 0 else np.nan
    return out


def bootstrap_cell(F, t):
    y, p, pa, pe, pp, valid, Hh = F["y"], F["fU"], F["a"], F["e"], F["fUp"], F["valid"], F["Hh"]
    y, p, pa, pe, pp, tt = y[valid], p[valid], pa[valid], pe[valid], pp[valid], t[valid]
    res = {"rows": int(len(y)), "positives": int(y.sum())}
    if len(y) == 0:
        return res
    Hn = [k for k, v in {**H_F1, **H_F2}.items() if v == Hh][0]
    bl = ((tt - tt[0]) // (BLOCK_H[Hn] * 3600)).astype(int)
    ub = np.unique(bl)
    posb = np.unique(bl[y == 1])
    res["blocks"] = int(len(ub)); res["positive_blocks"] = int(len(posb))
    # fixed bins
    qs = np.quantile(logit(p), np.linspace(0, 1, 101))
    sbin = np.clip(np.searchsorted(qs, logit(p), side="right") - 1, 0, 99)
    qa = np.quantile(p, np.linspace(0, 1, 201))
    abin = np.clip(np.searchsorted(qa, p, side="right") - 1, 0, 199)
    lp = logit(p)

    def stats(idx):
        yy, q, qa_, qe, qp = y[idx], p[idx], pa[idx], pe[idx], pp[idx]
        o = {}
        o["R"] = q.sum() / yy.sum() if yy.sum() > 0 else np.nan
        b = lambda x: np.mean((x - yy) ** 2)
        o["BSS_a"] = 1 - b(q) / b(qa_) if b(qa_) > 0 else np.nan
        o["BSS_e"] = 1 - b(q) / b(qe) if b(qe) > 0 else np.nan
        o["BSS_fUp_a"] = 1 - b(qp) / b(qa_) if b(qa_) > 0 else np.nan
        sb = sbin[idx]
        nb = np.bincount(sb, minlength=100).astype(float); yb = np.bincount(sb, weights=yy, minlength=100)
        xb = np.bincount(sb, weights=lp[idx], minlength=100) / np.where(nb > 0, nb, 1)
        keep = nb > 0
        o["slope"] = slope_fit(xb[keep], yb[keep], nb[keep]) if keep.sum() >= 2 and 0 < yy.sum() < len(yy) else np.nan
        ab = abin[idx]
        pos = np.bincount(ab, weights=yy, minlength=200); neg = np.bincount(ab, minlength=200) - pos
        o["AUC"] = auc_from_bins(pos, neg)
        return o

    point = stats(np.arange(len(y)))
    rng = np.random.default_rng(SEED)
    members = {b: np.where(bl == b)[0] for b in ub}
    draws = {k: [] for k in point}
    for _ in range(B_DRAWS):
        pick = rng.choice(ub, size=len(ub), replace=True)
        idx = np.concatenate([members[b] for b in pick])
        o = stats(idx)
        for k in point:
            draws[k].append(o[k])
    for k, v in point.items():
        arr = np.array(draws[k], dtype=float)
        okd = ~np.isnan(arr)
        res[k] = float(v) if not np.isnan(v) else None
        res[k + "_ci"] = [float(np.nanpercentile(arr, 2.5)), float(np.nanpercentile(arr, 97.5))] if okd.sum() > 50 else None
        res[k + "_draws_ok"] = int(okd.sum())
    # class rule: R19.3d + 5-block floor (fixed in the prereg)
    cls = None
    if res["positives"] < 30 or res["positive_blocks"] < 5 or any(res.get(k) is None for k in ("R", "slope", "BSS_a", "BSS_e")) \
            or res.get("BSS_a_ci") is None or res.get("BSS_e_ci") is None or res.get("slope_ci") is None:
        cls = "HISTORY COUNT"
    elif res["BSS_a_ci"][0] <= 0 or res["BSS_e_ci"][0] <= 0:
        cls = "DO NOT SHOW"
    elif 0.8 <= res["R"] <= 1.25 and res["slope_ci"][0] <= 1 <= res["slope_ci"][1]:
        cls = "CALIBRATED-WARN"
    else:
        cls = "RECALIBRATE"
    res["class"] = cls
    return res


def key_name(k):
    fam, Hn, lvl = k
    return f"{fam}|{Hn}|{'+%.0fpp' % (lvl * 100) if fam == 'F1' else '%.2f%%' % (lvl * 100)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["counts", "score"])
    ap.add_argument("--data", default=os.environ.get("PAIR_LOOP_DIR", "../../../../../membrane-datasets/pair-loop"))
    ap.add_argument("--lst", default=os.environ.get("LST_RATES", "../../../../../membrane-datasets/price-history/lst-rates-1d.json"))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    hourly = load_hourly(os.path.join(a.data, "hourly.jsonl"))
    strat = load_strategy(os.path.join(a.data, "strategy_daily.jsonl"))
    rT, rV = load_wsteth_rate(a.lst)
    S = build(hourly, strat, rT, rV)
    out = {"schema": "q26-pl2/1", "mode": a.mode, "rows": int(len(S["t"])), "span": [int(S["t"][0]), int(S["t"][-1])],
           "prereg": "membrane-board design/Q26_PAIR_LOOP_PREREG.md @01a8466", "cells": {}}
    for key in S["labels"]:
        F = forecasts(S, key)
        if a.mode == "counts":
            y, v, t = F["y"], F["valid"], S["t"]
            Hn = key[1]
            bl = ((t - t[0]) // (BLOCK_H[Hn] * 3600)).astype(int)
            yy = y[v]
            out["cells"][key_name(key)] = {"rows": int(v.sum()), "positives": int(np.nansum(yy)),
                                           "positive_blocks": int(len(np.unique(bl[v][yy == 1]))), "blocks": int(len(np.unique(bl[v])))}
        else:
            out["cells"][key_name(key)] = bootstrap_cell(F, S["t"])
    js = json.dumps(out, indent=1)
    if a.out:
        open(a.out, "w").write(js)
    # print a compact table
    for k, c in out["cells"].items():
        line = f"{k:22s} rows {c.get('rows',0):6d} pos {c.get('positives',0):6d} posblk {c.get('positive_blocks',0):3d}/{c.get('blocks',0):3d}"
        if a.mode == "score":
            f = lambda x: "  nan " if x is None else f"{x:6.3f}"
            line += f"  R {f(c.get('R'))} slope {f(c.get('slope'))} BSSa {f(c.get('BSS_a'))} {c.get('BSS_a_ci')} BSSe {f(c.get('BSS_e'))} {c.get('BSS_e_ci')} AUC {f(c.get('AUC'))}  {c.get('class')}"
        print(line)


if __name__ == "__main__":
    main()
