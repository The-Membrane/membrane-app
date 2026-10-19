"""Q26 R11.1-v4 stages (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1j, D-R11.1k, D-R11.1l).

R11.1-v4 = the frozen R11.1-v3 engine (rule unchanged) on inputs that never carry a zero timestamp, with pre-freeze
integrity checks and a confirmation gate on the unused L1-secondary set Aave V3 Polygon USDC debt.

  python3 r111v4_gate.py dcomp     --r10work R10WORK --dev DEVOUT --out OUT       D: price-drop comparator X, D priors,
                                                                                 D effects and days to 80% power
  python3 r111v4_gate.py integrity --mk poly --work WORK --out OUT --scratch S    inputs only: timestamps, hourly
                                                                                 reads, indexes vs chain, balances vs
                                                                                 chain, rebuilt HF vs chain
  python3 r111v4_gate.py counts    --mk poly --work WORK --out OUT               counts only (no volume, no class)
  python3 r111v4_gate.py freeze    --mk poly --work WORK --rule RULE --dcomp DC --integrity IN --out OUT
  python3 r111v4_gate.py run       --mk poly --work WORK --out OUT               the gate, once: simulated volume and
                                                                                 the volume <= debt bound first; the
                                                                                 locked outcomes are read only if the
                                                                                 bound holds

No address is written to OUT (every output is checked for 0x + 40 hex).
"""
from __future__ import annotations

import argparse
import bisect
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import sys

import numpy as np
from scipy.stats import spearmanr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_engine as E  # noqa: E402
import r111v3_gate as G  # noqa: E402
import r111v3_acquire as A  # noqa: E402

RAY = 10**27
CORE_WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
CORE_WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"
MK = {
    "poly": {"chain": "polygon", "usdc": ["0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
                                          "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
             "gas": "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",            # WPOL (formerly WMATIC)
             "pd_assets": ["0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",      # WETH
                           "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"],     # WBTC (the D set; binding)
             "pd_assets_reported": ["0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
                                    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"],   # + WPOL, reported only
             "first": dt.date(2022, 3, 15), "last": dt.date(2026, 9, 30)},
}
EXCLUDE = {"2025-10-10", "2025-10-11"}
Q2 = (dt.date(2026, 4, 1), dt.date(2026, 6, 30))
PD_GRID = [round(0.02 + 0.005 * i, 4) for i in range(37)]       # 2.0% .. 20.0%
MAG = {"spearman_min": 0.50, "ratio_lo": 0.5, "ratio_hi": 2.0}
HF_SAMPLE = {"seed": 20261018, "blocks": 40, "uniform_per_block": 25, "near_per_block": 15, "near_hf": 1.10,
             "min_debt_usd": 1.0}   # D-R11.1m: accounts under $1 of debt fail on the chain's 1e-8 USD base-unit rounding
IDX_TOL, IDX_SHARE, IDX_MAX = 1e-3, 0.99, 1e-2
HOUR_GAP_SHARE = 0.999


def utcnow():
    return G.utcnow()


def jl(p):
    with gzip.open(p, "rt") as f:
        return json.load(f)


# ---------------------------------------------------------------------------------------------
# price-drop comparator: max over the collateral set of the 24 h drawdown ending in the day
# ---------------------------------------------------------------------------------------------

def drawdown_by_day(hour_ts, prices):
    """hour_ts: array of hour boundaries (state at the boundary), prices: (n_hours, n_assets) USD (0 = missing).
    dd_h = max over assets of 1 - P_h / max(P over boundaries in [h - 24 h, h]); day of a boundary = UTC date of
    (h - 1 s), so the 00:00Z boundary closes the previous day. DD_d = max dd_h over the day's boundaries."""
    o = np.argsort(hour_ts)
    ht, P = np.asarray(hour_ts)[o], np.asarray(prices, dtype=float)[o]
    out = {}
    lo = 0
    for i in range(len(ht)):
        while ht[lo] < ht[i] - 24 * 3600:
            lo += 1
        w = P[lo:i + 1]
        dd = 0.0
        for a in range(P.shape[1]):
            col = w[:, a]
            col = col[col > 0]
            if len(col) and P[i, a] > 0:
                dd = max(dd, 1.0 - P[i, a] / col.max())
        d = dt.datetime.fromtimestamp(int(ht[i]) - 1, dt.timezone.utc).date().isoformat()
        out[d] = max(out.get(d, 0.0), dd)
    return out


def classify4(days, sim, real, scale, dd, x_pd, priors=None):
    """Per threshold: Y, sim, E (real on d-1) and PD (DD_d >= x_pd) classes; H/F/J; Brier with online calibration
    (D prior, 10 pseudo-days); pooled one-sided DM vs climatology, E and PD."""
    out = {}
    allk = sorted(real)
    real_prev = {d: (real[allk[i - 1]] if i > 0 else 0.0) for i, d in enumerate(allk)}
    dmat = {"clim": [], "E": [], "PD": []}
    pdc = np.array([dd.get(d, 0.0) >= x_pd for d in days], dtype=int)
    for X in G.THRESH_CORE:
        thr = np.array([X * scale[d] for d in days])
        y = np.array([real[d] >= x for d, x in zip(days, thr)], dtype=int)
        s = np.array([sim.get(d, 0.0) >= x for d, x in zip(days, thr)], dtype=int)
        e = np.array([real_prev[d] >= x for d, x in zip(days, thr)], dtype=int)
        pos, neg = y == 1, y == 0
        base = float(y.mean())

        def hf(c):
            H = float(c[pos].mean()) if pos.any() else None
            F = float(c[neg].mean()) if neg.any() else None
            return H, F, (None if H is None or F is None else H - F)

        def freq(c):
            return [float(y[c == 0].mean()) if (c == 0).any() else base, float(y[c == 1].mean()) if (c == 1).any() else base]

        pr = priors[str(int(X))] if priors else {"sim": freq(s), "E": freq(e), "PD": freq(pdc), "clim": base}
        p = {"sim": G.online_prob(s, y, pr["sim"]), "E": G.online_prob(e, y, pr["E"]),
             "PD": G.online_prob(pdc, y, pr["PD"]), "clim": G.online_prob(np.zeros(len(y)), y, [pr["clim"]])}
        bs = {k: float(np.mean((v - y) ** 2)) for k, v in p.items()}
        for k in dmat:
            dmat[k].append((p["sim"] - y) ** 2 - (p[k] - y) ** 2)
        H, F, J = hf(s)
        HE, FE, JE = hf(e)
        HP, FP, JP = hf(pdc)
        out[str(int(X))] = {"positive_days": int(pos.sum()), "negative_days": int(neg.sum()),
                            "sim_positive_days": int(s.sum()), "pd_positive_days": int(pdc.sum()),
                            "H": H, "F": F, "J": J, "H_E": HE, "F_E": FE, "J_E": JE, "H_PD": HP, "F_PD": FP, "J_PD": JP,
                            "brier": bs, "bss_vs_clim": 1 - bs["sim"] / bs["clim"] if bs["clim"] > 0 else None,
                            "bss_vs_E": 1 - bs["sim"] / bs["E"] if bs["E"] > 0 else None,
                            "bss_vs_PD": 1 - bs["sim"] / bs["PD"] if bs["PD"] > 0 else None, "prior": pr,
                            "threshold_usd_median": float(np.median(thr))}
    pooled = {}
    for k, v in dmat.items():
        r = G.dm_test(np.mean(np.vstack(v), axis=0))
        r["days_to_80pct_power"] = G.days80(r["mean_d"], r["nw_var"])
        pooled[k] = r
    return out, pooled


def magnitude(days, sim, real, debt_usd):
    s = G.secondary(days, sim, real)
    viol = [d for d in days if sim.get(d, 0.0) > debt_usd.get(d, 0.0)]
    ratio = s["sim_total_usd"] / s["real_total_usd"] if s["real_total_usd"] > 0 else None
    checks = {
        "spearman_ge10k>=0.50": bool(s["spearman_days_max_ge_10k"] is not None
                                     and s["spearman_days_max_ge_10k"] >= MAG["spearman_min"]),
        "spearman_ge10k>E_rank": bool(s["spearman_days_max_ge_10k"] is not None and s["spearman_E_days_max_ge_10k"] is not None
                                      and s["spearman_days_max_ge_10k"] > s["spearman_E_days_max_ge_10k"]),
        "usd_log_error<E": bool(s["usd_weighted_abs_log_error"] is not None and s["usd_weighted_abs_log_error_E"] is not None
                                and s["usd_weighted_abs_log_error"] < s["usd_weighted_abs_log_error_E"]),
        "sim/real_total_in[0.5,2]": bool(ratio is not None and MAG["ratio_lo"] <= ratio <= MAG["ratio_hi"]),
        "volume<=debt_all_days": len(viol) == 0}
    return {"secondary": s, "sim_over_real_total": ratio, "days_sim_gt_debt": len(viol), "checks": checks,
            "pass": all(checks.values())}


def verdict4(cls, pooled, mag):
    """Binding: per threshold H >= 0.60 and J > J_E; mean J over the three thresholds > mean J_PD; pooled Brier DM vs
    climatology, E and PD; the magnitude sanity gate. Per-threshold J > J_PD is reported (D-R11.1l power: at the
    L1-clean development effect it holds at $2.5M in about 67% of resamples)."""
    checks, reported = {}, {}
    for X, v in cls.items():
        checks[f"H>=0.60@{X}"] = bool(v["H"] is not None and v["H"] >= 0.60)
        checks[f"J>J_E@{X}"] = bool(v["J"] is not None and v["J_E"] is not None and v["J"] > v["J_E"])
        reported[f"J>J_PD@{X}"] = bool(v["J"] is not None and v["J_PD"] is not None and v["J"] > v["J_PD"])
    js = [v["J"] for v in cls.values()]
    jp = [v["J_PD"] for v in cls.values()]
    checks["meanJ>meanJ_PD"] = bool(None not in js and None not in jp and np.mean(js) > np.mean(jp))
    for k in ("clim", "E", "PD"):
        checks[f"DM_brier_vs_{k}_p<0.05"] = bool(pooled[k]["p_one_sided"] < 0.05 and pooled[k]["mean_d"] < 0)
    classifier = all(checks.values())
    return {"checks": checks, "reported_checks": reported, "mean_J": float(np.mean(js)) if None not in js else None,
            "mean_J_PD": float(np.mean(jp)) if None not in jp else None, "classifier_pass": classifier,
            "magnitude_checks": mag["checks"], "magnitude_pass": mag["pass"], "pass": bool(classifier and mag["pass"])}


# ---------------------------------------------------------------------------------------------
# D: comparator choice, priors and power (development data only)
# ---------------------------------------------------------------------------------------------

def core_dd(r10work, assets):
    hts, P = [], []
    for n in sorted(os.listdir(os.path.join(r10work, "hourly"))):
        h = jl(os.path.join(r10work, "hourly", n))
        ix = [h["assets"].index(a) for a in assets]
        for r in h["rows"]:
            hts.append(r["hour"] + 3600)        # R10.1 row = state at the end of its hour (core_hours rule)
            P.append([(r["prices"][j] or 0) / 1e8 for j in ix])
    return drawdown_by_day(np.array(hts), np.array(P))


def cmd_dcomp(a):
    t0 = utcnow()
    rows = list(csv.DictReader(open(os.path.join(a.dev, "dev-daily.csv"))))
    days = [r["date"] for r in rows]
    sim = {r["date"]: float(r["sim_v3_usd"]) for r in rows}
    real_d = {r["date"]: float(r["real_usd"]) for r in rows}
    scale = {r["date"]: float(r["scale"]) for r in rows}
    pub = {r["date"]: r for r in csv.DictReader(open(os.path.join(G.DATASETS, "history-forecasts/r10/r101-run-d96f48c8/liq-daily.csv")))}
    real = {d: float(pub[d]["real_usdc_usd"]) for d in pub}
    assert all(abs(real[d] - real_d[d]) < 0.01 for d in days)
    dd = core_dd(a.r10work, [CORE_WETH, CORE_WBTC])
    grid = []
    for x in PD_GRID:
        c, _ = classify4(days, sim, real, scale, dd, x)
        js = [c[k]["J_PD"] for k in c]
        grid.append({"x": x, "J_PD": js, "mean_J_PD": float(np.mean(js)), "pd_days": c["500000"]["pd_positive_days"]})
    best = max(grid, key=lambda g: (round(g["mean_J_PD"], 12), -g["x"]))
    x_pd = best["x"]
    cls, pooled = classify4(days, sim, real, scale, dd, x_pd)
    eth = core_dd(a.r10work, [CORE_WETH])
    res = {"stage": "dcomp (D only, in-sample)", "days": len(days), "pd_assets_core": ["WETH", "WBTC"],
           "rule": "X maximises the mean over the three thresholds of the comparator's J on D; ties -> smaller X; grid 2%..20% step 0.5%",
           "grid": grid, "x_pd": x_pd, "classification": cls, "pooled_dm": pooled,
           "priors_for_poly": {X: v["prior"] for X, v in cls.items()},
           "eth_only_dd_ge_x_days": int(sum(eth.get(d, 0) >= x_pd for d in days)),
           "utc_start": t0, "utc_end": utcnow()}
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, "dcomp.json"), res)
    print(json.dumps({"x_pd": x_pd, "best": best, "pooled_dm": pooled,
                      "classification": {X: {k: v[k] for k in ("positive_days", "H", "F", "J", "J_E", "H_PD", "F_PD", "J_PD",
                                                                 "bss_vs_clim", "bss_vs_PD")} for X, v in cls.items()}},
                     indent=1, default=float))


# ---------------------------------------------------------------------------------------------
# market inputs
# ---------------------------------------------------------------------------------------------

def mk_days(mk, include_q2=False):
    m = MK[mk]
    out, d = [], m["first"]
    while d <= m["last"]:
        s = d.isoformat()
        if s not in EXCLUDE and (include_q2 or not (Q2[0] <= d <= Q2[1])):
            out.append(s)
        d += dt.timedelta(days=1)
    return out


def debt_usd(mk, work, metas):
    debt = jl(os.path.join(work, "usdc-debt.json.gz"))
    out = {}
    for d, m in metas.items():
        usd = 0.0
        for u in MK[mk]["usdc"]:
            x = debt.get(d, {}).get(u)
            if x and u in m["reserves"]:
                usd += (int(x["v"]) + int(x["s"])) / 1e6 * ((m["reserves"][u]["price"] or 1e8) / 1e8)
        out[d] = usd
    return out


def mk_dd(mk, hours, inp, key="pd_assets"):
    ix = [inp.gidx[a] for a in MK[mk][key]]
    return drawdown_by_day(np.array([h["hour"] for h in hours]), np.array([h["prices"][ix] for h in hours]))


# ---------------------------------------------------------------------------------------------
# integrity checks (inputs only, before the freeze; no outcome is read)
# ---------------------------------------------------------------------------------------------

def stream(inp):
    t, p = inp.tok, inp.pool
    return E.merged_order([(0, t["block"] * 1_000_000 + t["lidx"]), (1, p["f_block"] * 1_000_000 + p["f_lidx"]),
                           (2, p["e_block"] * 1_000_000 + p["e_lidx"])])


def advance(st, inp, ks, ty, pos, ptr, lim):
    t, p = inp.tok, inp.pool
    while ptr < len(ks) and ks[ptr] <= lim:
        tt, pp = ty[ptr], pos[ptr]
        if tt == 0:
            st.apply_tok(t, pp)
        elif tt == 1:
            st.apply_flag(p, pp)
        else:
            st.apply_emode(p, pp)
        ptr += 1
    return ptr


def cmd_integrity(a):
    import r111v3_rpc as X
    t0 = utcnow()
    m = MK[a.mk]
    work = a.work
    res = {"stage": f"integrity (inputs only, {a.mk})", "utc_start": t0}
    # 1. timestamps: every input row positive (engine check) and one monotonic block lookup
    inp = E.Inputs(work)
    inp.load_oracle()
    _, bb, tt = A.ts_to_block_fn(work)
    res["timestamps"] = {"rows_checked": int(len(inp.tok["ts"]) + len(inp.pool["rdu_ts"]) + len(inp.pool["f_ts"])
                                             + len(inp.pool["e_ts"]) + len(inp.ora["ts"])),
                         "non_positive": 0, "lookup_blocks": int(len(bb)), "lookup_monotonic": True}
    liq = jl(os.path.join(work, "liq-LOCKED.json.gz"))["rows"]
    res["timestamps"]["liquidation_rows_non_positive_ts"] = int(sum(1 for r in liq if not r["ts"] or r["ts"] <= 0))
    del liq
    # 2. hourly reads: header ts in [h - 1 h, h), b_h non-decreasing
    hours = G.arb_hours(inp, work)
    hh = np.array([h["hour"] for h in hours])
    hb = np.array([h["block"] for h in hours])
    hts = np.array([h["ts"] for h in hours])
    o = np.argsort(hh)
    gap = (hts[o] < hh[o] - 3600)
    res["hourly"] = {"reads": int(len(hh)), "ts_not_before_hour": int((hts >= hh).sum()),
                     "older_than_1h": int(gap.sum()), "share_within_1h": float(1 - gap.mean()),
                     "block_decreasing": int((np.diff(hb[o]) < 0).sum()),
                     "missing_price_any": int(sum(1 for h in hours if (h["prices"] == 0).any())),
                     "pass": bool((hts < hh).all() and (1 - gap.mean()) >= HOUR_GAP_SHARE and (np.diff(hb[o]) >= 0).all())}
    # 3. rebuilt indexes vs getReserveNormalizedIncome / VariableDebt at every daily anchor
    metas = G.arb_metas(work)
    idx = E.Indexes(inp)
    errs, worst = [], []
    for d in sorted(metas):
        md = metas[d]
        idx.advance(md["block"] * 1_000_000 + 999_999)
        Lt, Vt = idx.at(float(md["ts"]))
        for asst, r in md["reserves"].items():
            k = inp.gidx.get(asst)
            if k is None or r["income"] in (None, "None") or r["vindex"] in (None, "None"):
                continue
            for mdl, chain in ((Lt[k], int(r["income"]) / RAY), (Vt[k], int(r["vindex"]) / RAY)):
                if chain > 0:
                    e = abs(mdl / chain - 1)
                    errs.append(e)
                    if e > IDX_MAX:
                        worst.append(d)
    errs = np.array(errs)
    res["indexes"] = {"reserve_day_index_pairs": int(len(errs)), "share_within_0p1pct": float(np.mean(errs <= IDX_TOL)),
                      "err_q50_q99_max": [float(np.quantile(errs, q)) for q in (0.5, 0.99, 1.0)],
                      "pairs_over_1pct": int((errs > IDX_MAX).sum()), "days_with_pair_over_1pct": len(set(worst)),
                      "pass": bool(np.mean(errs <= IDX_TOL) >= IDX_SHARE and (errs > IDX_MAX).sum() == 0)}
    print(json.dumps({k: res[k] for k in ("timestamps", "hourly", "indexes")}, indent=1, default=float), flush=True)
    # 4. balances vs scaledBalanceOf (sampled) and USDC scaled debt sums vs scaledTotalSupply (v3 check, this chain)
    res["balances"] = balances(a.mk, work, inp, metas)
    print(json.dumps(res["balances"], indent=1, default=float), flush=True)
    # 5. rebuilt HF vs getUserAccountData on a seeded random sample of account-blocks
    res["hf"] = hf_check(a.mk, work, inp, metas, hours, a.scratch)
    res["pass"] = bool(res["hourly"]["pass"] and res["indexes"]["pass"] and res["balances"]["pass"] and res["hf"]["pass"]
                       and res["timestamps"]["liquidation_rows_non_positive_ts"] == 0)
    res["utc_end"] = utcnow()
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, "integrity.json"), res)
    print(json.dumps({"hf": res["hf"], "pass": res["pass"]}, indent=1, default=float))


def balances(mk, work, inp, metas, seed=111):
    import r111v3_rpc as X
    cl = X.Client(MK[mk]["chain"], interval=0.1, calls=True)
    days = sorted(metas)
    pick = [days[int(i)] for i in np.linspace(0, len(days) - 1, 5)]
    months = [d for d in days if d.endswith("-01")]
    targets = sorted({metas[d]["block"]: d for d in pick + months}.items())
    st = E.State(inp)
    t = inp.tok
    o = np.argsort(t["block"] * 1_000_000 + t["lidx"], kind="stable")
    ptr = 0
    rng = np.random.default_rng(seed)
    uinv = {v: k for k, v in inp.uid.items()}
    tok_addr = {}
    for i, r in enumerate(inp.reserves):
        tok_addr[(i, 0)], tok_addr[(i, 1)] = r["aToken"], r["vDebt"]
    pe, se = [], []
    for blk, d in targets:
        while ptr < len(o) and t["block"][o[ptr]] <= blk:
            st.apply_tok(t, o[ptr])
            ptr += 1
        if d in pick:
            nz = np.argwhere((st.SA > 0.5) | (st.SV > 0.5))
            sel = nz[rng.choice(len(nz), size=min(60, len(nz)), replace=False)]
            calls, want = [], []
            for u, r in sel:
                kind = 0 if st.SA[u, r] > 0.5 and (st.SV[u, r] <= 0.5 or rng.random() < 0.5) else 1
                calls.append((tok_addr[(r, kind)], X.sel("scaledBalanceOf(address)") + X.enc_addr("0x" + uinv[u].hex())))
                want.append(st.SA[u, r] if kind == 0 else st.SV[u, r])
            for (ok, rr), w, (u, r) in zip(X.aggregate3(cl, calls, blk), want, sel):
                v = (X.word(rr) if ok else 0) or 0
                px = (metas[d]["reserves"].get(inp.assets[r], {}).get("price") or 0) / 1e8
                floor = 10 ** inp.dec[r] / px if px > 0 else 1e-6 * 10 ** inp.dec[r]
                pe.append(abs(w - v) / max(v, floor))
        calls = [(tok_addr[(inp.gidx[u], 1)], X.sel("scaledTotalSupply()")) for u in MK[mk]["usdc"] if u in inp.gidx]
        for u, (ok, rr) in zip(MK[mk]["usdc"], X.aggregate3(cl, calls, blk)):
            v = X.word(rr) if ok else None
            if v:
                se.append(abs(st.SV[:, inp.gidx[u]].sum() / v - 1))
    pe, se = np.array(pe), np.array(se)
    return {"pairs": int(len(pe)), "pairs_share_within_0p1pct": float(np.mean(pe <= 0.001)),
            "pairs_err_q99_max": [float(np.quantile(pe, 0.99)), float(pe.max())], "sum_checks": int(len(se)),
            "sum_share_within_0p1pct": float(np.mean(se <= 0.001)), "sum_err_max": float(se.max()),
            "pass": bool(np.mean(pe <= 0.001) >= 0.99 and np.mean(se <= 0.001) >= 0.99), "rpc": cl.stats}


def hf_check(mk, work, inp, metas, hours, scratch):
    """Rebuilt HF (engine formulas, no overlay) at hourly read blocks vs getUserAccountData at the same block.
    Blocks: seeded random hourly reads in the gate span. Accounts: USDC-debt accounts, a uniform sample (gated) and
    a near-threshold sample (rebuilt HF < 1.10, reported)."""
    import r111v3_rpc as X
    cfg = HF_SAMPLE
    rng = np.random.default_rng(cfg["seed"])
    cl = X.Client(MK[mk]["chain"], interval=0.1, calls=True)
    first = int(dt.datetime.combine(MK[mk]["first"], dt.time(), dt.timezone.utc).timestamp())
    last = int(dt.datetime.combine(MK[mk]["last"], dt.time(), dt.timezone.utc).timestamp())
    cand = [h for h in hours if first <= h["hour"] <= last]
    pick = sorted(rng.choice(len(cand), size=cfg["blocks"], replace=False).tolist())
    picks = [cand[i] for i in pick]
    st = E.State(inp)
    idx = E.Indexes(inp)
    ks, ty, pos = stream(inp)
    ptr = 0
    inv_unit = 1.0 / 10.0 ** inp.dec
    usdc = [inp.gidx[u] for u in MK[mk]["usdc"] if u in inp.gidx]
    days_sorted = sorted(metas)
    uinv = {v: k for k, v in inp.uid.items()}
    pool = A.MARKETS[mk]["pool"]
    rows = []
    for h in picks:
        lim = h["block"] * 1_000_000 + 999_999
        ptr = advance(st, inp, ks, ty, pos, ptr, lim)
        idx.advance(lim)
        Lt, Vt = idx.at(float(h["ts"]))
        dstr = dt.datetime.fromtimestamp(h["hour"], dt.timezone.utc).date().isoformat()
        md = days_sorted[max(bisect.bisect_right(days_sorted, dstr) - 1, 0)]
        meta = metas[md]
        day = E.M.Day({**meta, "reserves": {k: v for k, v in meta["reserves"].items() if k in inp.gidx}}, inp.gidx)
        px = h["prices"]
        users = np.nonzero((st.SV[:, usdc] > 0.5).any(axis=1) | (st.SP[:, usdc] > 0.5).any(axis=1))[0]
        if len(users) == 0:
            continue
        sa, sv = st.SA[users], st.SV[users]
        ss = E.stable_value(st.SP[users], st.SR[users], st.ST[users], float(h["ts"]))
        LT = np.zeros((len(users), inp.R))
        ems = st.EM[users]
        for em in np.unique(ems):
            LT[ems == em] = day.eff(em)[0]
        coll = sa * (Lt * inv_unit * px)
        debt = sv * (Vt * inv_unit * px) + ss * (inv_unit * px)
        num = (coll * LT * (st.FL[users] & (LT > 0))).sum(axis=1)
        td = debt.sum(axis=1)
        hf = np.where(td > 0, num / np.where(td > 0, td, 1), np.inf)
        big = np.nonzero(td >= cfg["min_debt_usd"])[0]
        if len(big) == 0:
            continue
        uni = rng.choice(big, size=min(cfg["uniform_per_block"], len(big)), replace=False)
        near_pool = np.nonzero((hf < cfg["near_hf"]) & (td >= cfg["min_debt_usd"]))[0]
        near = rng.choice(near_pool, size=min(cfg["near_per_block"], len(near_pool)), replace=False) if len(near_pool) else []
        sel = [(int(i), "uniform") for i in uni] + [(int(i), "near") for i in near]
        calls = [(pool, X.sel("getUserAccountData(address)") + X.enc_addr("0x" + uinv[int(users[i])].hex())) for i, _ in sel]
        out = X.aggregate3(cl, calls, h["block"])
        for (i, stratum), (ok, rr) in zip(sel, out):
            hc = X.word(rr, 5) / 1e18 if ok and len(rr) >= 192 else None
            dbt = X.word(rr, 1) if ok and len(rr) >= 192 else None
            e = abs(hf[i] / hc - 1) if hc and hc > 0 and np.isfinite(hf[i]) and dbt else float("inf")
            rows.append({"stratum": stratum, "hour": int(h["hour"]), "hf_model": float(hf[i]), "hf_chain": hc,
                         "err": float(e), "emode": int(ems[i]), "v33": bool(day.v33)})
    if scratch:
        os.makedirs(scratch, exist_ok=True)
        with open(os.path.join(scratch, f"hf-rows-{mk}.json"), "w") as f:
            json.dump(rows, f)
    res = {"sample": cfg, "rpc": cl.stats}
    for s in ("uniform", "near"):
        e = np.array([r["err"] for r in rows if r["stratum"] == s])
        if len(e) == 0:
            res[s] = {"n": 0}
            continue
        fin = e[np.isfinite(e)]
        res[s] = {"n": int(len(e)), "share_within_0p1pct": float(np.mean(e <= 0.001)), "n_infinite": int((~np.isfinite(e)).sum()),
                  "err_q50_q90_q99_max": [float(np.quantile(fin, q)) for q in (0.5, 0.9, 0.99, 1.0)] if len(fin) else None,
                  "emode_users_share_within": float(np.mean([r["err"] <= 0.001 for r in rows if r["stratum"] == s and r["emode"]]))
                  if any(r["emode"] for r in rows if r["stratum"] == s) else None}
    res["pass"] = bool(res["uniform"].get("n", 0) > 0 and res["uniform"]["share_within_0p1pct"] >= G.VALID_SHARE)
    res["bar"] = ("uniform stratum (USDC-debt accounts with rebuilt debt >= $1): rebuilt HF within 0.1% of chain HF on >= 99% "
                  "(registered D bar); near stratum reported")
    return res


# ---------------------------------------------------------------------------------------------
# counts-only, freeze, run
# ---------------------------------------------------------------------------------------------

def cmd_counts(a):
    t0 = utcnow()
    inp = E.Inputs(a.work)
    inp.load_oracle()
    metas = G.arb_metas(a.work)
    hours = G.arb_hours(inp, a.work)
    rows = jl(os.path.join(a.work, "liq-LOCKED.json.gz"))["rows"]
    usdc = set(MK[a.mk]["usdc"])
    gd = set(mk_days(a.mk))
    ur = [r for r in rows if r["debt"] in usdc]
    evd = [dt.datetime.fromtimestamp(r["ts"], dt.timezone.utc).date().isoformat() for r in ur]
    res = {"stage": f"counts-only ({a.mk})", "reserves": inp.R, "token_logs": int(len(inp.tok["block"])), "accounts": inp.U,
           "rdu_reserve_hours": int(len(inp.pool["rdu_block"])), "flag_logs": int(len(inp.pool["f_block"])),
           "emode_logs": int(len(inp.pool["e_block"])), "aggregators": len(inp.aggs), "answer_logs": int(len(inp.ora["block"])),
           "weekly_walks": len(inp.walks), "sentinel_present_any": any((w.get("sentinel") or {}).get("present") for w in inp.walks),
           "meta_days": len(metas), "hourly_reads": len(hours),
           "gate_days": len(gd), "q2_days_reported_only": len(mk_days(a.mk, True)) - len(gd),
           "liquidation_logs_all": len(rows), "usdc_debt_events_all": len(ur),
           "usdc_debt_events_on_gate_days": sum(1 for d in evd if d in gd), "gate_days_with_a_usdc_debt_event": len(set(evd) & gd),
           "utc_start": t0, "utc_end": utcnow()}
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, f"counts-{a.mk}.json"), res)
    print(json.dumps(res, indent=1, default=float))


READINGS = {
    "P-1": "Subject: LiquidationCall with debt USDC.e or native USDC on Aave V3 Polygon; USD = debtToCover / 1e6 x that "
           "reserve's oracle price at the hourly read of the hour holding the block timestamp; UTC day of the block timestamp.",
    "P-2": "Gate days 2022-03-15..2026-09-30 minus 2025-10-10/11; 2026Q2 reported only (rule 6).",
    "P-3": "Thresholds X in {0.5M, 1M, 2.5M} x (USDC.e + USDC total debt at the day's anchor, USD) / 530,255,152.",
    "P-4": "Sim class = v4 daily simulated USDC-debt repay >= X; E = real on the previous calendar day >= X; PD = max over "
           "WETH and WBTC of the 24 h drawdown of the hourly oracle price ending in the day >= x_pd (x_pd = 6%, fixed on D "
           "with WETH, WBTC); probabilities: online class frequency with the D prior (10 pseudo-days). WETH+WBTC+WPOL "
           "variant reported only.",
    "P-5": "Classifier pass: per threshold H >= 0.60 and J > J_E; mean J over the three thresholds > mean J_PD; pooled "
           "Brier DM (NW lag 7, HLN, one-sided) p < 0.05 vs climatology, E and PD. Per-threshold J > J_PD reported.",
    "P-6": "Magnitude sanity gate (binding): Spearman on days with max(sim, real) >= $10k >= 0.50 and > E-rank; USD-weighted "
           "absolute log error < E's; sim/real total in [0.5, 2]; simulated daily volume <= USDC total debt at the anchor on "
           "every gate day (checked before the outcome file is opened).",
    "P-7": "Cost: hour base fee + 30 gwei priority x 686,675 gas x WPOL price; no builder payment; dust minimum $6.43 gross bonus. "
           "No PriceOracleSentinel on Polygon.",
    "P-8": "Hourly read b_h = the last held event block with header timestamp < h; daily anchor = the same rule at 00:00Z.",
}


def cmd_freeze(a):
    sha, dirty = G.git_sha()
    if dirty:
        raise SystemExit("worktree dirty: freeze from a clean committed checkout")
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, f"frozen-r111v4-{a.mk}.json")
    if os.path.exists(path):
        raise SystemExit("frozen config exists")
    dc = json.load(open(os.path.join(a.dcomp, "dcomp.json")))
    integ = json.load(open(os.path.join(a.integrity, "integrity.json")))
    if not integ["pass"]:
        raise SystemExit("integrity checks did not pass: no freeze")
    cfg = {"item": "Q26 R11.1-v4 gate on Aave V3 Polygon USDC debt (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1k, l)",
           "code_sha": sha, "utc_created": utcnow(), "rule": json.load(open(a.rule)), "priors": dc["priors_for_poly"],
           "x_pd": dc["x_pd"], "pd_assets": ["WETH", "WBTC"],
           "dcomp_sha256": G.sha256_file(os.path.join(a.dcomp, "dcomp.json")),
           "integrity_sha256": G.sha256_file(os.path.join(a.integrity, "integrity.json")),
           "thresholds_core": G.THRESH_CORE, "ref_core_usdc_debt": G.REF_CORE_DEBT, "prior_pseudo_days": G.PRIOR_A,
           "nw_lag": G.NW_LAG, "secondary_min_usd": G.SEC_MIN, "dust_day_usd": G.DUST_DAY, "cand_hf": E.CAND_HF,
           "magnitude_bars": MAG, "gate_days": len(mk_days(a.mk)), "exclude": sorted(EXCLUDE), "readings": READINGS,
           "inputs_sha256": G.l1_input_digests(a.work)}
    G.jdump(path, cfg)
    print(json.dumps({"frozen": path, "sha256": G.sha256_file(path), "utc_created": cfg["utc_created"], "code_sha": sha}))


def cmd_run(a):
    t0 = utcnow()
    path = os.path.join(a.out, f"frozen-r111v4-{a.mk}.json")
    cfg = json.load(open(path))
    sha, dirty = G.git_sha()
    if dirty or sha != cfg["code_sha"]:
        raise SystemExit(f"code {sha} dirty={dirty} != frozen {cfg['code_sha']}")
    if not a.scratch:
        raise SystemExit("--scratch (checkpoint directory, never published) is required")
    os.makedirs(a.scratch, exist_ok=True)
    ck = os.path.join(a.scratch, f"ckpt-r111v4-{a.mk}.pkl")
    started = os.path.join(a.out, "run-started")
    if os.path.exists(os.path.join(a.out, "r111v4-results.json")):
        raise SystemExit("one run only: results exist")
    if os.path.exists(started) and not (a.resume and os.path.exists(ck)):
        raise SystemExit("one run only: a started marker exists (resume needs --resume and a checkpoint)")
    if a.resume and not os.path.exists(started):
        raise SystemExit("--resume without a started run")
    if G.l1_input_digests(a.work) != cfg["inputs_sha256"]:
        raise SystemExit("input digests differ from the frozen config")
    if a.resume:
        open(started, "a").write(f"resume {t0}\n")
        print(f"run resume {t0} frozen sha256 {G.sha256_file(path)}", flush=True)
    else:
        open(started, "w").write(t0 + "\n")
        print(f"run start {t0} frozen sha256 {G.sha256_file(path)}", flush=True)
    t0 = open(started).read().split("\n")[0].strip()
    m = MK[a.mk]
    inp = E.Inputs(a.work)
    inp.load_oracle()
    metas = G.arb_metas(a.work)
    hours = G.arb_hours(inp, a.work)
    first = int(dt.datetime.combine(m["first"], dt.time(), dt.timezone.utc).timestamp())
    rp = E.Replay(inp, metas, hours, cfg["rule"], m["usdc"], first, inp.gidx[m["gas"]], record=False)
    rp.checkpoint = ck
    sim = rp.run()
    days = mk_days(a.mk)
    debt = debt_usd(a.mk, a.work, metas)
    viol = [d for d in days if sim.get(d, 0.0) > debt.get(d, 0.0)]
    t_sim = utcnow()
    if viol:
        res = {"item": cfg["item"], "stopped": "simulated daily volume > USDC total debt before any outcome read",
               "days_sim_gt_debt": len(viol), "gate_days": len(days), "utc_start": t0, "utc_sim_end": t_sim}
        G.jdump(os.path.join(a.out, "r111v4-bound-stop.json"), res)
        raise SystemExit(json.dumps(res))
    print(f"volume <= debt bound holds on all {len(days)} gate days at {t_sim}; opening the locked outcome file", flush=True)
    real_ev, n_ev = real_events(a.work, hours, inp, m["usdc"])
    real = {}
    d = m["first"] - dt.timedelta(days=1)
    while d <= m["last"]:
        real[d.isoformat()] = real_ev.get(d.isoformat(), 0.0)
        d += dt.timedelta(days=1)
    scale = {k: v / G.REF_CORE_DEBT for k, v in debt.items()}
    dd = mk_dd(a.mk, hours, inp)
    cls, pooled = classify4(days, sim, real, scale, dd, cfg["x_pd"], priors=cfg["priors"])
    mag = magnitude(days, sim, real, debt)
    dd_w = mk_dd(a.mk, hours, inp, "pd_assets_reported")
    cls_w, pooled_w = classify4(days, sim, real, scale, dd_w, cfg["x_pd"], priors=cfg["priors"])
    q2 = [x for x in mk_days(a.mk, True) if x not in set(days)]
    cls_q2, pooled_q2 = classify4(q2, sim, real, scale, dd, cfg["x_pd"], priors=cfg["priors"])
    by_year = {}
    for y in sorted({x[:4] for x in days}):
        dy = [x for x in days if x[:4] == y]
        c, _ = classify4(dy, sim, real, scale, dd, cfg["x_pd"], priors=cfg["priors"])
        by_year[y] = {X: {k: v[k] for k in ("positive_days", "H", "F", "J", "J_E", "J_PD")} for X, v in c.items()}
    res = {"item": cfg["item"], "frozen_sha256": G.sha256_file(path), "code_sha": sha, "gate_days": len(days),
           "real_usdc_debt_events": n_ev, "classification": cls, "pooled_dm": pooled, "magnitude": mag,
           "verdict": verdict4(cls, pooled, mag),
           "reported_only": {"q2_2026": {"classification": cls_q2, "pooled_dm": pooled_q2}, "by_year": by_year,
                             "pd_with_wpol": {X: {k: v[k] for k in ("H_PD", "F_PD", "J_PD", "bss_vs_PD")} for X, v in cls_w.items()},
                             "pd_with_wpol_dm": pooled_w["PD"],
                             "scale_q05_q50_q95": [float(np.quantile([scale[x] for x in days], q)) for q in (0.05, 0.5, 0.95)]},
           "engine": {"hours": rp.rec["hours"], "evals": rp.rec["evals"],
                      "cand_median": float(np.median(rp.rec["cand_sizes"])) if rp.rec["cand_sizes"] else 0,
                      "sentinel_blocked_evals": rp.rec.get("sentinel_blocked_evals", 0)},
           "utc_start": t0, "utc_sim_end": t_sim, "utc_end": utcnow()}
    G.jdump(os.path.join(a.out, "r111v4-results.json"), res)
    with open(os.path.join(a.out, "r111v4-daily.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "sim_usdc_usd", "real_usdc_usd", "usdc_debt_usd", "scale", "pd_drawdown", "gate_day", "q2_reported_only"])
        for x in mk_days(a.mk, True):
            w.writerow([x, f"{sim.get(x, 0.0):.2f}", f"{real[x]:.2f}", f"{debt.get(x, 0.0):.2f}", f"{scale.get(x, 0.0):.6f}",
                        f"{dd.get(x, 0.0):.5f}", int(x in set(days)), int(x in set(q2))])
    for n in os.listdir(a.out):
        if n.endswith((".json", ".csv")) and G.ADDR_RE.search(open(os.path.join(a.out, n)).read()):
            raise SystemExit(f"address pattern in {n}")
    print(json.dumps({"verdict": res["verdict"], "pooled_dm": pooled, "magnitude": {k: mag[k] for k in ("sim_over_real_total", "checks")},
                      "classification": {X: {k: v[k] for k in ("positive_days", "H", "F", "J", "J_E", "J_PD", "bss_vs_clim", "bss_vs_PD")}
                                         for X, v in cls.items()}, "utc_start": t0, "utc_end": res["utc_end"]}, indent=1, default=float))


def real_events(work, hours, inp, usdc):
    rows = jl(os.path.join(work, "liq-LOCKED.json.gz"))["rows"]
    hp = {h["hour"]: h["prices"] for h in hours}
    real, n = {}, 0
    for r in rows:
        if r["debt"] not in usdc:
            continue
        if not r["ts"] or r["ts"] <= 0:
            raise SystemExit("liquidation row without a timestamp")
        d = dt.datetime.fromtimestamp(r["ts"], dt.timezone.utc).date().isoformat()
        px = hp.get(r["ts"] // 3600 * 3600)
        k = inp.gidx[r["debt"]]
        p = px[k] if px is not None and px[k] > 0 else 1.0
        real[d] = real.get(d, 0.0) + r["debtToCover"] / 1e6 * p
        n += 1
    return real, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    for k in ("mk", "work", "out", "rule", "dev", "dcomp", "integrity", "scratch", "r10work"):
        ap.add_argument(f"--{k}")
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()
    {"dcomp": cmd_dcomp, "integrity": cmd_integrity, "counts": cmd_counts, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
