"""Q26 R11.1-v3 stages (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1e, f, g).

  python3 r111v3_gate.py validate --core CORE --r10work R10WORK --diag DIAG --out OUT   D: rebuilt HF vs block-1 reads
  python3 r111v3_gate.py calib    --core CORE --r10work R10WORK --diag DIAG --out OUT   D: cost / dust / scale params
  python3 r111v3_gate.py dev      --core CORE --r10work R10WORK --diag DIAG --rule RULE --out OUT
                                                                                         D: in-sample v3 run + power
  python3 r111v3_gate.py counts   --arb ARB --out OUT                                    L1: counts only
  python3 r111v3_gate.py freeze   --arb ARB --rule RULE --dev DEVOUT --out OUT           L1: frozen config + sha256
  python3 r111v3_gate.py run      --arb ARB --out OUT                                    L1: the gate, once

No address is written to OUT (every output is checked for 0x + 40 hex).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
from scipy.stats import spearmanr, norm, t as student_t

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_engine as E  # noqa: E402

ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")
RAY = 10**27
D_FIRST, D_LAST = dt.date(2023, 2, 1), dt.date(2024, 12, 31)
L1_FIRST, L1_LAST = dt.date(2022, 9, 1), dt.date(2026, 9, 30)
L1_EXCLUDE = {"2025-10-10", "2025-10-11"}
CORE_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
ARB_USDC = ["0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"]
C1_LOGS = "history-forecasts/c1/run-e79f9341/logs.json.gz"
DATASETS = os.environ.get("MEMBRANE_DATASETS_DIR", os.path.join(HERE, "..", "..", "..", "..", "membrane-datasets"))
VALID_TOL, VALID_SHARE = 0.001, 0.99
DEC_CORE = {}


def utcnow():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def jdump(path, obj):
    txt = json.dumps(obj, indent=1, sort_keys=True, default=float)
    if ADDR_RE.search(txt):
        raise SystemExit(f"address pattern in {path}")
    with open(path, "w") as f:
        f.write(txt)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_sha():
    sha = subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", HERE, "status", "--porcelain", "--", "."], text=True).strip()
    return sha, bool(dirty)


def jl(p):
    with gzip.open(p, "rt") as f:
        return json.load(f)


def r10_metas(r10work):
    anchors = jl(os.path.join(r10work, "anchors.json.gz"))
    return {k: jl(os.path.join(r10work, "meta", f"{k}.json.gz")) for k in anchors}


# ---------------------------------------------------------------------------------------------
# validation (D): rebuilt positions vs the R11.1 block-1 diagnostic reads
# ---------------------------------------------------------------------------------------------

def diag_records(diag):
    out = []
    for n in os.listdir(os.path.join(diag, "diag-blocks")):
        out.append(jl(os.path.join(diag, "diag-blocks", n)))
    return sorted(out, key=lambda r: r["block"])


def cmd_validate(a):
    t0 = utcnow()
    inp = E.Inputs(a.core)
    metas = r10_metas(a.r10work)
    days = sorted(metas)
    anchors = {d: metas[d]["block"] for d in days}
    recs = diag_records(a.diag)
    st = E.State(inp)
    t, p = inp.tok, inp.pool
    tk = t["block"] * 1_000_000 + t["lidx"]
    fk = p["f_block"] * 1_000_000 + p["f_lidx"]
    ek = p["e_block"] * 1_000_000 + p["e_lidx"]
    ks, ty, pos = E.merged_order([(0, tk), (1, fk), (2, ek)])
    ptr = 0
    inv_unit = 1.0 / 10.0 ** inp.dec
    errs, rows = [], []
    flag_mis, em_mis, bal_mis = 0, 0, 0
    import bisect
    for rec in recs:
        lim = (rec["block"] - 1) * 1_000_000 + 999_999
        while ptr < len(ks) and ks[ptr] <= lim:
            tt, pp = ty[ptr], pos[ptr]
            if tt == 0:
                st.apply_tok(t, pp)
            elif tt == 1:
                st.apply_flag(p, pp)
            else:
                st.apply_emode(p, pp)
            ptr += 1
        i = bisect.bisect_left([anchors[d] for d in days], rec["block"])
        d = days[i - 1]
        meta = metas[d]
        day = E.M.Day({**meta, "reserves": {k: v for k, v in meta["reserves"].items() if k in inp.gidx}}, inp.gidx)
        px = np.zeros(inp.R)
        L, V = np.ones(inp.R), np.ones(inp.R)
        for j, asst in enumerate(rec["assets"]):
            k = inp.gidx[asst]
            px[k] = (rec["prices"][j] or 0) / 1e8
            if rec["income"][j] not in (None, "None"):
                L[k] = int(rec["income"][j]) / RAY
            if rec["vindex"][j] not in (None, "None"):
                V[k] = int(rec["vindex"][j]) / RAY
        for user, acc in rec["accounts"].items():
            u = inp.uid.get(bytes.fromhex(user[2:]))
            hf_chain = int(acc["hf"]) / 1e18
            if u is None:
                errs.append(np.inf)
                rows.append({"block": rec["block"], "hf_chain": hf_chain, "hf_model": None, "why": "unknown"})
                continue
            em = int(st.EM[u])
            em_mis += int(em != int(acc["emode"] or 0))
            lt, _ = day.eff(em)
            coll = st.SA[u] * L * inv_unit * px
            debt = (st.SV[u] * V + st.SP[u]) * inv_unit * px
            elig = st.FL[u] & (lt > 0)
            cfg = int(acc["config"])
            chain_coll = np.array([(cfg >> (2 * int(meta["reserves"][x]["id"]) + 1)) & 1 if x in meta["reserves"] else 0
                                   for x in inp.assets], dtype=bool)
            flag_mis += int(np.any((st.FL[u] != chain_coll) & ((st.SA[u] > 0) | chain_coll)))
            # balances vs block-1 reads (flagged reserves only)
            for asst, b in acc["bal"].items():
                k = inp.gidx[asst]
                if "a" in b:
                    m_ = st.SA[u, k] * L[k]
                    if abs(m_ - int(b["a"])) > max(1e-6 * int(b["a"]), 2):
                        bal_mis += 1
                if "v" in b:
                    m_ = st.SV[u, k] * V[k]
                    if abs(m_ - int(b["v"])) > max(1e-6 * int(b["v"]), 2):
                        bal_mis += 1
            td = debt.sum()
            hf_m = (coll[elig] * lt[elig]).sum() / td if td > 0 else np.inf
            e = abs(hf_m / hf_chain - 1) if hf_chain > 0 and np.isfinite(hf_m) else np.inf
            errs.append(e)
            rows.append({"block": rec["block"], "hf_chain": hf_chain, "hf_model": hf_m, "err": e})
    errs = np.array(errs)
    share = float(np.mean(errs <= VALID_TOL))
    res = {"stage": "validate (D only)", "n_account_blocks": int(len(errs)), "share_within_0p1pct": share,
           "bar": VALID_SHARE, "pass": bool(share >= VALID_SHARE),
           "rel_err_q50_q90_q99_max": [float(np.quantile(errs[np.isfinite(errs)], q)) for q in (0.5, 0.9, 0.99, 1.0)],
           "n_infinite": int(np.sum(~np.isfinite(errs))), "emode_mismatch": em_mis, "collateral_flag_mismatch": flag_mis,
           "balance_mismatch_gt_1e-6": bal_mis, "utc_start": t0, "utc_end": utcnow()}
    os.makedirs(a.out, exist_ok=True)
    jdump(os.path.join(a.out, "validate.json"), res)
    os.makedirs(a.scratch or a.out, exist_ok=True)
    with open(os.path.join(a.scratch or a.out, "validate-rows.json"), "w") as f:
        json.dump(rows, f, default=float)
    print(json.dumps(res, indent=1, default=float))


# ---------------------------------------------------------------------------------------------
# D calibration: cost model, dust minimum, Core USDC debt reference (all from D only)
# ---------------------------------------------------------------------------------------------

def core_real_events(r10work):
    logs = jl(os.path.join(DATASETS, C1_LOGS))["liquidations"]
    return [lg for lg in logs if lg["debt"].lower() == CORE_USDC]


def core_usdc_debt_by_day(r10work):
    """Core USDC total debt (USD) at the first hourly read of each day (R10.1 hourly rows)."""
    out = {}
    for n in sorted(os.listdir(os.path.join(r10work, "hourly"))):
        h = jl(os.path.join(r10work, "hourly", n))
        j = h["assets"].index(CORE_USDC)
        rows = sorted(h["rows"], key=lambda r: r["hour"])
        if rows:
            r = rows[0]
            out[h["date"]] = (int(r["vDebtTotal"]) + int(r["sDebtTotal"])) / 1e6 * ((r["prices"][j] or 1e8) / 1e8)
    return out


def cmd_calib(a):
    t0 = utcnow()
    for r in jl(os.path.join(a.core, "reserves.json.gz"))["reserves"]:
        DEC_CORE[r["asset"]] = r["dec"]
    recs = {r["block"]: r for r in diag_records(a.diag)}
    receipts = jl(os.path.join(a.diag, "diag-receipts.json.gz"))
    evs = core_real_events(a.r10work)
    D_lo = min(recs)
    D_hi = max(recs)
    gas_used, prio, cost_eth = [], [], []
    for tx, r in receipts.items():
        b = r["block"]
        if b not in recs:
            continue
        bf = recs[b]["base_fee"]
        gas_used.append(r["gasUsed"])
        prio.append(max(r["effectiveGasPrice"] - bf, 0))
        cost_eth.append(r["gasUsed"] * r["effectiveGasPrice"] / 1e18)
    gross = []
    for lg in evs:
        rec = recs.get(lg["block"])
        if rec is None:
            continue
        a_ = rec["assets"]
        pc = (rec["prices"][a_.index(lg["collateral"].lower())] or 0) / 1e8
        pu = (rec["prices"][a_.index(CORE_USDC)] or 0) / 1e8
        meta_dec = None
        dec = DEC_CORE.get(lg["collateral"].lower())
        gross.append(lg["collateralAmount"] / 10 ** dec * pc - lg["debtToCover"] / 1e6 * pu)
    gross = np.array(gross)
    debt = core_usdc_debt_by_day(a.r10work)
    dd = [v for k, v in debt.items() if D_FIRST.isoformat() <= k <= D_LAST.isoformat()]
    res = {"stage": "calib (D only)", "n_receipts": len(gas_used), "G_median_gasUsed": float(np.median(gas_used)),
           "prio_wei_mean": float(np.mean(prio)), "prio_wei_median": float(np.median(prio)),
           "prio_wei_q75": float(np.quantile(prio, 0.75)),
           "real_cost_eth_q05_q50_q95": [float(np.quantile(cost_eth, q)) for q in (0.05, 0.5, 0.95)],
           "n_events": int(len(gross)), "gross_bonus_usd_q01_q05_q10_q50": [float(np.quantile(gross, q)) for q in (0.01, 0.05, 0.10, 0.5)],
           "dust_usd_q05": float(np.quantile(gross, 0.05)),
           "core_usdc_debt_usd_median_D": float(np.median(dd)), "core_usdc_debt_days": len(dd),
           "utc_start": t0, "utc_end": utcnow()}
    os.makedirs(a.out, exist_ok=True)
    jdump(os.path.join(a.out, "calib.json"), res)
    print(json.dumps(res, indent=1, default=float))


# ---------------------------------------------------------------------------------------------
# gate statistics (shared by the D development run and the L1 run)
# ---------------------------------------------------------------------------------------------
THRESH_CORE = [500_000.0, 1_000_000.0, 2_500_000.0]
PRIOR_A = 10.0                 # pseudo-days of the D prior in the online calibration
NW_LAG = 7
SEC_MIN = 10_000.0             # secondary Spearman: days with max(sim, real) >= $10k
DUST_DAY = 1_000.0             # declared dust threshold for small-day H / F


def dm_test(d, lag=NW_LAG):
    """One-sided DM (mean d < 0) with Newey-West (Bartlett) variance and the HLN factor; Student t, n-1 df."""
    d = np.asarray(d, dtype=float)
    n = len(d)
    mu = d.mean()
    x = d - mu
    g0 = (x * x).mean()
    v = g0
    for k in range(1, lag + 1):
        v += 2 * (1 - k / (lag + 1)) * (x[k:] * x[:-k]).mean()
    se = math.sqrt(max(v, 1e-300) / n)
    h = lag + 1
    hln = math.sqrt((n + 1 - 2 * h + h * (h - 1) / n) / n)
    tstat = mu / se * hln
    return {"mean_d": float(mu), "t": float(tstat), "p_one_sided": float(student_t.cdf(tstat, n - 1)), "n": n,
            "nw_var": float(v)}


def days80(mu, var_nw, alpha=0.05):
    if mu >= 0:
        return None
    return int(math.ceil(((norm.ppf(1 - alpha) + norm.ppf(0.80)) ** 2) * var_nw / mu ** 2))


def online_prob(cls, y, prior, a=PRIOR_A):
    """p_t = (positives among past days in the same class + a * prior[class]) / (past days in class + a)."""
    n = {}
    k = {}
    out = np.empty(len(y))
    for t, (c, yy) in enumerate(zip(cls, y)):
        c = int(c)
        out[t] = (k.get(c, 0) + a * prior[c]) / (n.get(c, 0) + a)
        n[c] = n.get(c, 0) + 1
        k[c] = k.get(c, 0) + int(yy)
    return out


def classify(days, sim, real, scale, priors=None):
    """Per threshold: Y, sim class, E class (real on d-1), H/F/J, Brier with online calibration."""
    out = {}
    real_prev = {}
    allk = sorted(real)
    for i, d in enumerate(allk):
        real_prev[d] = real[allk[i - 1]] if i > 0 else 0.0
    dmat = {"clim": [], "E": []}
    for X in THRESH_CORE:
        thr = np.array([X * scale[d] for d in days])
        y = np.array([real[d] >= x for d, x in zip(days, thr)], dtype=int)
        s = np.array([sim.get(d, 0.0) >= x for d, x in zip(days, thr)], dtype=int)
        e = np.array([real_prev[d] >= x for d, x in zip(days, thr)], dtype=int)
        pos, neg = y == 1, y == 0
        H = float(s[pos].mean()) if pos.any() else None
        F = float(s[neg].mean()) if neg.any() else None
        HE = float(e[pos].mean()) if pos.any() else None
        FE = float(e[neg].mean()) if neg.any() else None
        base = float(y.mean())
        pr = priors[str(int(X))] if priors else {
            "sim": [float(y[s == 0].mean()) if (s == 0).any() else base, float(y[s == 1].mean()) if (s == 1).any() else base],
            "E": [float(y[e == 0].mean()) if (e == 0).any() else base, float(y[e == 1].mean()) if (e == 1).any() else base],
            "clim": base}
        p_sim = online_prob(s, y, pr["sim"])
        p_e = online_prob(e, y, pr["E"])
        p_c = online_prob(np.zeros(len(y)), y, [pr["clim"]])
        bs = {k: float(np.mean((p - y) ** 2)) for k, p in (("sim", p_sim), ("E", p_e), ("clim", p_c))}
        dmat["clim"].append((p_sim - y) ** 2 - (p_c - y) ** 2)
        dmat["E"].append((p_sim - y) ** 2 - (p_e - y) ** 2)
        out[str(int(X))] = {"positive_days": int(pos.sum()), "negative_days": int(neg.sum()),
                            "sim_positive_days": int(s.sum()), "H": H, "F": F, "J": None if H is None else H - F,
                            "H_E": HE, "F_E": FE, "J_E": None if HE is None else HE - FE,
                            "brier": bs, "bss_vs_clim": 1 - bs["sim"] / bs["clim"] if bs["clim"] > 0 else None,
                            "bss_vs_E": 1 - bs["sim"] / bs["E"] if bs["E"] > 0 else None, "prior": pr,
                            "threshold_usd_median": float(np.median(thr))}
    pooled = {}
    for k, v in dmat.items():
        dd = np.mean(np.vstack(v), axis=0)
        r = dm_test(dd)
        r["days_to_80pct_power"] = days80(r["mean_d"], r["nw_var"])
        pooled[k] = r
    return out, pooled


def secondary(days, sim, real):
    sel = [d for d in days if max(sim.get(d, 0.0), real[d]) >= SEC_MIN]
    sp = spearmanr([sim.get(d, 0.0) for d in sel], [real[d] for d in sel]).correlation if len(sel) > 2 else None
    w = np.array([max(sim.get(d, 0.0), real[d]) for d in days])
    le = np.array([abs(math.log((sim.get(d, 0.0) + 1) / (real[d] + 1))) for d in days])
    allk = sorted(real)
    trail = {}
    for i, d in enumerate(allk):
        prev = [real[x] for x in allk[max(0, i - 7):i]]
        trail[d] = float(np.mean(prev)) if prev else 0.0
    selE = [d for d in days if max(trail[d], real[d]) >= SEC_MIN]
    spE = spearmanr([trail[d] for d in selE], [real[d] for d in selE]).correlation if len(selE) > 2 else None
    wE = np.array([max(trail[d], real[d]) for d in days])
    leE = np.array([abs(math.log((trail[d] + 1) / (real[d] + 1))) for d in days])
    small = [d for d in days if real[d] >= DUST_DAY]
    zero = [d for d in days if real[d] < DUST_DAY]
    return {"spearman_days_max_ge_10k": None if sp is None else float(sp), "n_days_max_ge_10k": len(sel),
            "spearman_E_days_max_ge_10k": None if spE is None else float(spE), "n_days_E_max_ge_10k": len(selE),
            "usd_weighted_abs_log_error": float((w * le).sum() / w.sum()) if w.sum() > 0 else None,
            "usd_weighted_abs_log_error_E": float((wE * leE).sum() / wE.sum()) if wE.sum() > 0 else None,
            "dust_threshold_usd": DUST_DAY,
            "small_H_real_ge_dust": float(np.mean([sim.get(d, 0.0) >= DUST_DAY for d in small])) if small else None,
            "small_F_real_lt_dust": float(np.mean([sim.get(d, 0.0) >= DUST_DAY for d in zero])) if zero else None,
            "n_days_real_ge_dust": len(small), "n_days_real_lt_dust": len(zero),
            "spearman_all_days": float(spearmanr([sim.get(d, 0.0) for d in days], [real[d] for d in days]).correlation),
            "sim_total_usd": float(sum(sim.get(d, 0.0) for d in days)), "real_total_usd": float(sum(real[d] for d in days))}


def verdict(cls_stats, pooled):
    checks = {}
    for X, v in cls_stats.items():
        checks[f"H>=0.60@{X}"] = bool(v["H"] is not None and v["H"] >= 0.60)
        checks[f"J>J_E@{X}"] = bool(v["J"] is not None and v["J_E"] is not None and v["J"] > v["J_E"])
    checks["DM_brier_vs_clim_p<0.05"] = bool(pooled["clim"]["p_one_sided"] < 0.05 and pooled["clim"]["mean_d"] < 0)
    checks["DM_brier_vs_E_p<0.05"] = bool(pooled["E"]["p_one_sided"] < 0.05 and pooled["E"]["mean_d"] < 0)
    return {"checks": checks, "pass": all(checks.values())}


# ---------------------------------------------------------------------------------------------
# D development run (in-sample; sets the priors and states the power)
# ---------------------------------------------------------------------------------------------

def core_hours(inp, r10work, diag):
    import r111_replay as R
    bts = jl(os.path.join(r10work, "rdu-block-ts.json.gz"))
    bts = dict(zip(bts["block"], bts["ts"]))
    bf = R.basefee_by_hour(r10work, diag)
    out = []
    for n in sorted(os.listdir(os.path.join(r10work, "hourly"))):
        h = jl(os.path.join(r10work, "hourly", n))
        idx = [inp.gidx.get(a) for a in h["assets"]]
        for r in h["rows"]:
            px = np.zeros(inp.R)
            for j, k in enumerate(idx):
                if k is not None:
                    px[k] = (r["prices"][j] or 0) / 1e8
            out.append({"hour": r["hour"] + 3600, "block": r["block"], "ts": bts.get(r["block"], r["hour"] + 3599),
                        "prices": px, "base_fee": bf.get(r["hour"], 0.0)})
    out.sort(key=lambda x: x["block"])
    return out


def cmd_dev(a):
    t0 = utcnow()
    rule = json.load(open(a.rule))
    inp = E.Inputs(a.core)
    inp.load_oracle()
    metas = r10_metas(a.r10work)
    hours = core_hours(inp, a.r10work, a.diag)
    first = int(dt.datetime(D_FIRST.year, D_FIRST.month, D_FIRST.day, tzinfo=dt.timezone.utc).timestamp())
    last = int(dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc).timestamp())
    hours = [h for h in hours if first <= h["hour"] <= last]
    weth = inp.gidx["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]
    rp = E.Replay(inp, metas, hours, rule, [CORE_USDC], first, weth, record=True)
    sim = rp.run()
    days = [d.isoformat() for d in (D_FIRST + dt.timedelta(days=i) for i in range((D_LAST - D_FIRST).days + 1))]
    pub = {r["date"]: r for r in csv.DictReader(open(os.path.join(DATASETS, "history-forecasts/r10/r101-run-d96f48c8/liq-daily.csv")))}
    real = {d: float(pub[d]["real_usdc_usd"]) for d in pub}
    r101 = {d: float(pub[d]["sim_usdc_usd"]) for d in pub}
    debt = core_usdc_debt_by_day(a.r10work)
    calib = json.load(open(os.path.join(a.calib, "calib.json")))
    ref = calib["core_usdc_debt_usd_median_D"]
    scale = {d: debt.get(d, ref) / ref for d in days}
    cls_v3, pooled_v3 = classify(days, sim, real, scale)
    cls_r101, pooled_r101 = classify(days, r101, real, scale)
    priors = {X: v["prior"] for X, v in cls_v3.items()}
    res = {"stage": "dev (D only, in-sample)", "days": len(days), "rule": rule,
           "v3": {"classification": cls_v3, "pooled_dm": pooled_v3, "verdict_if_this_were_the_gate": verdict(cls_v3, pooled_v3),
                  "secondary": secondary(days, sim, real)},
           "r101_frozen": {"classification": cls_r101, "pooled_dm": pooled_r101, "secondary": secondary(days, r101, real)},
           "priors_for_L1": priors, "engine": {"hours": rp.rec["hours"], "evals": rp.rec["evals"],
                                              "cand_median": float(np.median(rp.rec["cand_sizes"])) if rp.rec["cand_sizes"] else 0,
                                              "calls": len(rp.rec["calls"])},
           "utc_start": t0, "utc_end": utcnow()}
    os.makedirs(a.out, exist_ok=True)
    jdump(os.path.join(a.out, "dev.json"), res)
    with open(os.path.join(a.out, "dev-daily.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "sim_v3_usd", "real_usd", "sim_r101_usd", "scale"])
        for d in days:
            w.writerow([d, f"{sim.get(d, 0.0):.2f}", f"{real[d]:.2f}", f"{r101[d]:.2f}", f"{scale[d]:.4f}"])
    print(json.dumps({k: res[k] for k in ("v3", "r101_frozen", "engine")}, indent=1, default=float))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    for k in ("core", "r10work", "diag", "out", "arb", "rule", "dev", "scratch", "calib"):
        ap.add_argument(f"--{k}")
    a = ap.parse_args()
    {"validate": cmd_validate, "calib": cmd_calib, "dev": cmd_dev}[a.cmd](a)


if __name__ == "__main__":
    main()
