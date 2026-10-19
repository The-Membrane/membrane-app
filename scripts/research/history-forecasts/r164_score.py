#!/usr/bin/env python3
"""Q26 R16.4 Part A scoring: recursive (fH) vs (f), (fH), (a) on the development rows of `r164_recursive.py dev`.

membrane-board `design/Q26_ROUND16_PREREG.md` section R16.4. Seen data only.
Clusters: series (the five ETH/BTC series cluster by asset) x 182-day calendar blocks from 2018-01-01 (28-day blocks
reported beside at 24 h and 72 h). Pigeonhole two-way bootstrap (B 2,000), centred and percentile p, CGM z beside.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a6_touch as M6  # noqa: E402

EVAL_T = (24, 72, 168, 720)
T_NAME = {24: "1d", 72: "3d", 168: "7d", 720: "30d"}
BLOCK_ORIGIN_DAY = 17532
BANDS = {"shallow -2..-7%": (0, 1, 2, 3), "mid -10..-20%": (4, 5, 6), "deep -25..-40%": (7, 8, 9)}
MAJOR = {"bspan:ETH": "ETH", "locked:coinbase-eth-usd": "ETH", "bspan:BTC": "BTC",
         "locked:bitstamp-btc-usd": "BTC", "locked:coinbase-btc-usd": "BTC"}


def load_rows(rows_dir, cols=None):
    files = sorted(glob.glob(os.path.join(rows_dir, "*.npz")))
    parts = {}
    names, clusters = [], {}
    for si, f in enumerate(files):
        z = np.load(f)
        name = str(z["name"])
        names.append(name)
        cl = MAJOR.get(name, name)
        cid = clusters.setdefault(cl, len(clusters))
        n = len(z["y"])
        d = {"series": np.full(n, si, np.int16), "cluster": np.full(n, cid, np.int16),
             "major": np.full(n, name in MAJOR)}
        for k in z.files:
            if k in ("name", "asset", "levels", "base_ts"):
                continue
            if cols is not None and k not in cols and not k.startswith("p_"):
                continue
            d[k] = z[k]
        for k, v in d.items():
            parts.setdefault(k, []).append(v)
    keys = set.intersection(*[set(k for k in parts if len(parts[k]) == len(files))])
    out = {}
    for k in parts:
        if len(parts[k]) != len(files):
            # column missing in some series: pad with NaN
            arrs = []
            for f, z in zip(files, (np.load(f) for f in files)):
                n = len(z["y"])
                arrs.append(z[k].astype(np.float32) if k in z.files else np.full(n, np.nan, np.float32))
            out[k] = np.concatenate(arrs)
        else:
            out[k] = np.concatenate(parts[k])
    out["block182"] = ((out["day"].astype(np.int64) - BLOCK_ORIGIN_DAY) // 182).astype(np.int32)
    out["block28"] = ((out["day"].astype(np.int64) - BLOCK_ORIGIN_DAY) // 28).astype(np.int32)
    return out, names, clusters


def cells(cl, bl, vals):
    ucl, ic = np.unique(cl, return_inverse=True)
    ub, ib = np.unique(bl, return_inverse=True)
    S, B = len(ucl), len(ub)
    flat = ic * B + ib
    return [np.bincount(flat, weights=v, minlength=S * B).reshape(S, B) for v in vals], S, B


def twoway_mean(d, cl, bl, rng, n_rep=2000):
    """Mean of d with pigeonhole two-way bootstrap (clusters x blocks) and CGM z. Lower d = model better."""
    (Md, Mn), S, B = cells(cl, bl, [d, np.ones(len(d))])
    md = Md.sum() / Mn.sum()
    ws = rng.multinomial(S, np.full(S, 1.0 / S), size=n_rep).astype(float)
    wb = rng.multinomial(B, np.full(B, 1.0 / B), size=n_rep).astype(float)
    num = np.einsum("rs,sb,rb->r", ws, Md, wb, optimize=True)
    den = np.einsum("rs,sb,rb->r", ws, Mn, wb, optimize=True)
    mb = num / den
    sd = float(np.std(mb, ddof=1))
    u = (Md - md * Mn) / Mn.sum()
    v_cgm = (u.sum(1) ** 2).sum() + (u.sum(0) ** 2).sum() - (u ** 2).sum()
    return {"mean_d": float(md), "sd": sd, "z": float(md / sd) if sd > 0 else None,
            "p_centred": float((1 + np.sum(mb - md <= md)) / (n_rep + 1)) if md < 0 else
            float((1 + np.sum(mb - md >= md)) / (n_rep + 1)),
            "p_percentile_model_better": float((1 + np.sum(mb >= 0)) / (n_rep + 1)),
            "z_cgm": float(md / math.sqrt(v_cgm)) if v_cgm > 0 else None, "S": S, "B": B}


def leave_top(d, cl, k):
    g = -np.bincount(cl, weights=d)
    top = np.argsort(-g)[:k]
    keep = ~np.isin(cl, top)
    tot = g.sum()
    return {"k": k, "mean_d_leave_top": float(d[keep].mean()),
            "top_share": float(g[top].sum() / tot) if tot > 0 else None, "clusters_with_gain": int((g > 0).sum())}


def ratio_R(p, y):
    sy = y.sum()
    return float(p.sum() / sy) if sy > 0 else None


def top_quintile_R(p, y, k_i):
    num = den = 0.0
    for k in np.unique(k_i):
        m = k_i == k
        if m.sum() < 50:
            continue
        thr = np.quantile(p[m], 0.8)
        mm = m & (p >= thr)
        num += p[mm].sum()
        den += y[mm].sum()
    return float(num / den) if den > 0 else None


def score(rows, models, comps, out_json, n_rep=2000, seed=20261641, sub_steps=None):
    rng = np.random.default_rng(seed)
    res = {"models": models, "comparisons": comps, "per_T": {}}
    for T in EVAL_T:
        mT = rows["T_h"] == T
        ok = mT.copy()
        for m in models:
            ok &= np.isfinite(rows[f"p_{m}"])
        y = rows["y"][ok].astype(float)
        kk = rows["k_i"][ok]
        cl = rows["cluster"][ok]
        bl = rows["block182"][ok]
        bl28 = rows["block28"][ok]
        P = {m: rows[f"p_{m}"][ok].astype(float) for m in models}
        se = {m: (P[m] - y) ** 2 for m in models}
        rT = {"n_rows": int(ok.sum()), "n_rows_T": int(mT.sum()), "base_rate": float(y.mean()), "models": {},
              "comparisons": {}, "levels": {}}
        for m in models:
            cm = {"brier": float(se[m].mean()), "R": ratio_R(P[m], y), "R_top_quintile": top_quintile_R(P[m], y, kk)}
            mcb = dsc = 0.0
            for k in np.unique(kk):
                c = M6.corp(P[m][kk == k], y[kk == k])
                mcb += c["MCB"] / len(np.unique(kk))
                dsc += c["DSC"] / len(np.unique(kk))
            cm["MCB_mean_over_levels"], cm["DSC_mean_over_levels"] = mcb, dsc
            rT["models"][m] = cm
        nclu = len(np.unique(cl))
        kt = max(3, int(math.ceil(0.025 * nclu)))
        for a, b in comps:
            if a not in P or b not in P:
                continue
            d = se[a] - se[b]
            c = {"bss": float(1 - se[a].sum() / se[b].sum())}
            c.update(twoway_mean(d, cl, bl, rng, n_rep))
            if T <= 72:
                c["z_28d_blocks"] = twoway_mean(d, cl, bl28, rng, 500)["z"]
            c.update(leave_top(d, cl, kt))
            bands = {}
            for bn, ks in BANDS.items():
                mb = np.isin(kk, ks)
                tb = twoway_mean(d[mb], cl[mb], bl[mb], rng, 1000)
                bands[bn] = {"bss": float(1 - se[a][mb].sum() / se[b][mb].sum()), "z": tb["z"],
                             "p_centred": tb["p_centred"]}
            c["bands"] = bands
            rT["comparisons"][f"{a}_vs_{b}"] = c
        for k in np.unique(kk):
            mk = kk == k
            rT["levels"][int(k)] = {"base_rate": float(y[mk].mean()), "n": int(mk.sum()),
                                     **{m: {"R": ratio_R(P[m][mk], y[mk]), "brier": float(se[m][mk].mean())}
                                        for m in models}}
        res["per_T"][T_NAME[T]] = rT
        print(T_NAME[T], {m: round(rT["models"][m]["brier"], 6) for m in models}, flush=True)
        for cn, c in rT["comparisons"].items():
            print("   ", cn, "BSS %.4f z %.2f cgm %.2f p %.4f" % (c["bss"], c["z"] or 0, c["z_cgm"] or 0,
                                                                   c["p_centred"]), flush=True)
    if sub_steps:
        res["step_selection"] = step_select(rows, sub_steps, rng)
    M6.write_json(out_json, res)
    return res


def step_select(rows, steps, rng):
    """The docstring rule of r164_recursive.py (fixed before any output)."""
    out = {"rule": "mean Brier over 7 d and 30 d rows (equal weight per horizon), rec mode, every-7th-day subsample; "
                   "guard median |ln R| <= 12 h + 0.02; switch from 12 h only if two-way z vs 12 h <= -2.0"}
    sc, lnr, dmat = {}, {}, {}
    for s in steps:
        sc[s], lnr[s] = 0.0, []
    for T in (168, 720):
        ok = rows["T_h"] == T
        for s in steps:
            ok &= np.isfinite(rows[f"p_rec{s}"])
        y = rows["y"][ok].astype(float)
        kk = rows["k_i"][ok]
        for s in steps:
            p = rows[f"p_rec{s}"][ok].astype(float)
            sc[s] += 0.5 * float(((p - y) ** 2).mean())
            for k in np.unique(kk):
                r = ratio_R(p[kk == k], y[kk == k])
                if r:
                    lnr[s].append(abs(math.log(r)))
            dmat.setdefault(s, []).append(((p - y) ** 2, rows["cluster"][ok], rows["block182"][ok], len(y)))
        out[f"n_rows_{T}"] = int(ok.sum())
    out["score"] = {str(s): sc[s] for s in steps}
    out["median_abs_lnR"] = {str(s): float(np.median(lnr[s])) for s in steps}
    zs = {}
    for s in steps:
        if s == 12:
            continue
        # equal-weight per horizon difference: scale each horizon's d by 0.5/n_T so the mean matches the score
        ds, cls, bls, wts = [], [], [], []
        for (e_s, cl, bl, n), (e_12, _, _, _) in zip(dmat[s], dmat[12]):
            ds.append(e_s - e_12)
            cls.append(cl)
            bls.append(bl)
        tw = twoway_mean(np.concatenate(ds), np.concatenate(cls), np.concatenate(bls), rng, 2000)
        zs[str(s)] = tw["z"]
    out["z_vs_12"] = zs
    guard = {str(s): out["median_abs_lnR"][str(s)] <= out["median_abs_lnR"]["12"] + 0.02 for s in steps}
    out["guard_pass"] = guard
    cand = [s for s in steps if guard[str(s)] and s != 12 and zs[str(s)] is not None and zs[str(s)] <= -2.0]
    best = min(cand, key=lambda s: sc[s]) if cand else 12
    out["selected"] = best
    print("step selection", json.dumps(out), flush=True)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nrep", type=int, default=2000)
    a = ap.parse_args(argv)
    rows, names, clusters = load_rows(a.rows)
    models = ["a", "f", "fH", "rec12", "fix12", "recb12", "recc12"]
    comps = [("rec12", "fH"), ("rec12", "f"), ("rec12", "a"), ("fix12", "fH"), ("rec12", "fix12"),
             ("recb12", "fH"), ("recc12", "fH"), ("recc12", "rec12"), ("recb12", "rec12"), ("fH", "f"), ("f", "a"),
             ("fH", "a")]
    score(rows, models, comps, os.path.join(a.out, "score-main.json"), a.nrep, sub_steps=(1, 3, 6, 12))
    # subsample: every step on the same rows
    sm = ["fH", "f", "a", "rec1", "rec3", "rec6", "rec12"]
    sc = [(f"rec{s}", "fH") for s in (1, 3, 6, 12)] + [(f"rec{s}", "rec12") for s in (1, 3, 6)]
    score(rows, sm, sc, os.path.join(a.out, "score-steps.json"), a.nrep)


if __name__ == "__main__":
    main()
