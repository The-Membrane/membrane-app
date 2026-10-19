#!/usr/bin/env python3
"""Q26 R16.4 Part B: probability ranges for touch odds, validated by series x time-block cross-validation.

membrane-board `design/Q26_ROUND16_PREREG.md` section R16.4. Seen data only (rows of `r164_recursive.py dev`).

Target (operational, outcome-free grouping). An evaluation group G is (horizon T, level, tier, point-forecast bin,
series group, 182-day block): the forecasts one fifth of the tier's series issued in one half-year whose point forecast
falls in the same bin. A nominal 90% range "covers" G when the group's realised frequency ybar_G lies inside the
group's mean range [mean L, mean U]. Bins: deciles of logit p_point per (T, level, tier), computed on forecasts only.
Series groups: 5, by sha256 of the cluster name (ETH and BTC series cluster by asset). Majors tier = ETH and BTC
(5 series, 2 clusters, so its series groups are the 2 assets); alts tier = the other 125 series.

Constructions (point forecast = (fH) unless stated):
  PU    (i)   parameter uncertainty: 5%-95% of the (fH) 30-day block-bootstrap refits (20 replicates)
  DIS   (ii)  model disagreement: [min, max] over {a, f, fbL, fH, rec12}
  CAL   (iii) calibration-conformal: [p q05, p q95] (clipped to 0..1) where q are the row-weighted 5% and 95%
              quantiles of the training groups' ratio rho_G = sum y / sum p; training groups are every group of the
              same (T, level, tier) outside the held-out series group AND outside the held-out block (two-way CV)
  CALr  (iii) the same with the recursive rec12 forecast as the point
  H_CD  (iv)  hull of CAL and DIS
  H_CP  (iv)  hull of CAL and PU
Metrics per (T, level, tier): coverage (share of groups covered, and row-weighted), its block-bootstrap 90% interval,
median and 90th-percentile width (probability points), share of rows with width < 10 points, share of rows whose range
excludes the cell's training base rate, and the mean interval score IS = (U - L) + (2/alpha)((L - ybar)+ +
(ybar - U)+), alpha = 0.10, over groups.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a6_touch as M6  # noqa: E402
from r164_score import load_rows, EVAL_T, T_NAME  # noqa: E402

ALPHA = 0.10
N_SG = 5
NBIN = 10
DIS_SET = ("a", "f", "fbL", "fH", "rec12")
CONSTR = ("PU", "DIS", "CAL", "CALr", "H_CD", "H_CP")


def wquant(x, w, q):
    o = np.argsort(x)
    x, w = x[o], w[o]
    cw = np.cumsum(w) / w.sum()
    return np.interp(q, cw, x)


def sg_of(names_by_cluster, major_flag):
    """series-group id per cluster."""
    out = {}
    for name, cid in names_by_cluster.items():
        if name in ("ETH", "BTC"):
            out[cid] = 0 if name == "ETH" else 1
        else:
            out[cid] = int(hashlib.sha256(("Q26-R16.4-SG:" + name).encode()).hexdigest()[:8], 16) % N_SG
    return out


def run(rows_dir, out_json, nominal=0.90, seed=20261642):
    rows, names, clusters = load_rows(rows_dir)
    sgmap = sg_of(clusters, None)
    sg = np.array([sgmap[c] for c in rows["cluster"]], np.int16)
    rng = np.random.default_rng(seed)
    qlo, qhi = (1 - nominal) / 2, 1 - (1 - nominal) / 2
    res = {"nominal": nominal, "cells": []}
    has_boot = "boot_q" in rows
    for T in EVAL_T:
        for tier, tmask in (("alts", ~rows["major"]), ("majors", rows["major"])):
            for k in range(10):
                m = (rows["T_h"] == T) & (rows["k_i"] == k) & tmask
                for c in ("p_fH", "p_rec12", "p_a", "p_f", "p_fbL"):
                    m &= np.isfinite(rows[c])
                if has_boot:
                    m &= np.all(np.isfinite(rows["boot_q"]), axis=1)
                if m.sum() < 500:
                    continue
                y = rows["y"][m].astype(float)
                p = rows["p_fH"][m].astype(float)
                pr = rows["p_rec12"][m].astype(float)
                blk = rows["block182"][m]
                g = sg[m]
                D = np.stack([rows[f"p_{x}"][m].astype(float) for x in DIS_SET])
                lo = {"DIS": D.min(0)}
                hi = {"DIS": D.max(0)}
                if has_boot:
                    bq = rows["boot_q"][m].astype(float)
                    lo["PU"], hi["PU"] = bq[:, 0], bq[:, 4]
                # bins on forecasts only
                lp = np.log(np.clip(p, 1e-5, 1 - 1e-5))
                edges = np.unique(np.quantile(lp, np.linspace(0, 1, NBIN + 1)[1:-1]))
                b = np.searchsorted(edges, lp)
                ub, bi = np.unique(blk, return_inverse=True)
                nb = len(ub)
                gid = (b * N_SG + g) * nb + bi                 # group id
                ng = (NBIN + 1) * N_SG * nb
                cnt = np.bincount(gid, minlength=ng)
                sy = np.bincount(gid, weights=y, minlength=ng)
                sp = np.bincount(gid, weights=p, minlength=ng)
                spr = np.bincount(gid, weights=pr, minlength=ng)
                occ = np.where(cnt > 0)[0]
                g_sg = (occ // nb) % N_SG
                g_bl = occ % nb
                # CAL per held-out fold (sg, block)
                lo["CAL"] = np.full(len(y), np.nan)
                hi["CAL"] = np.full(len(y), np.nan)
                lo["CALr"] = np.full(len(y), np.nan)
                hi["CALr"] = np.full(len(y), np.nan)
                base = np.full(len(y), np.nan)
                rho = np.where(sp[occ] > 0, sy[occ] / np.maximum(sp[occ], 1e-12), np.nan)
                rhor = np.where(spr[occ] > 0, sy[occ] / np.maximum(spr[occ], 1e-12), np.nan)
                w = cnt[occ].astype(float)
                for gg in np.unique(g):
                    for bb in range(nb):
                        hold = (g == gg) & (bi == bb)
                        if not hold.any():
                            continue
                        tr = (g_sg != gg) & (g_bl != bb)
                        ok = tr & np.isfinite(rho)
                        if ok.sum() < 10:
                            continue
                        q1, q2 = wquant(rho[ok], w[ok], [qlo, qhi])
                        lo["CAL"][hold], hi["CAL"][hold] = p[hold] * q1, np.minimum(1.0, p[hold] * q2)
                        okr = tr & np.isfinite(rhor)
                        q1, q2 = wquant(rhor[okr], w[okr], [qlo, qhi])
                        lo["CALr"][hold], hi["CALr"][hold] = pr[hold] * q1, np.minimum(1.0, pr[hold] * q2)
                        rows_tr = ~((g == gg) | (bi == bb))
                        base[hold] = y[rows_tr].mean() if rows_tr.any() else np.nan
                lo["H_CD"], hi["H_CD"] = np.minimum(lo["CAL"], lo["DIS"]), np.maximum(hi["CAL"], hi["DIS"])
                if has_boot:
                    lo["H_CP"], hi["H_CP"] = np.minimum(lo["CAL"], lo["PU"]), np.maximum(hi["CAL"], hi["PU"])
                cell = {"T": T_NAME[T], "level": k, "tier": tier, "n_rows": int(m.sum()), "base_rate": float(y.mean()),
                        "n_groups": int(len(occ)), "n_blocks": int(nb), "constructions": {}}
                ybar = sy[occ] / cnt[occ]
                for cname in CONSTR:
                    if cname not in lo:
                        continue
                    L, U = lo[cname], hi[cname]
                    okr_ = np.isfinite(L) & np.isfinite(U)
                    sL = np.bincount(gid[okr_], weights=L[okr_], minlength=ng)[occ]
                    sU = np.bincount(gid[okr_], weights=U[okr_], minlength=ng)[occ]
                    cn = np.bincount(gid[okr_], minlength=ng)[occ]
                    okg = cn > 0
                    Lg, Ug = sL[okg] / cn[okg], sU[okg] / cn[okg]
                    yg = ybar[okg]
                    cov = (yg >= Lg - 1e-12) & (yg <= Ug + 1e-12)
                    wid = (U - L)[okr_]
                    IS = (Ug - Lg) + (2 / ALPHA) * (np.maximum(Lg - yg, 0) + np.maximum(yg - Ug, 0))
                    # block bootstrap of group coverage
                    gb = g_bl[okg]
                    covb = []
                    for _ in range(500):
                        dr = rng.integers(0, nb, nb)
                        wts = np.bincount(dr, minlength=nb)[gb]
                        if wts.sum():
                            covb.append(float((cov * wts).sum() / wts.sum()))
                    bse = base[okr_]
                    excl = ((bse < L[okr_]) | (bse > U[okr_]))
                    cell["constructions"][cname] = {
                        "coverage_groups": float(cov.mean()), "coverage_rows": float((cov * cn[okg]).sum() / cn[okg].sum()),
                        "coverage_ci90": [float(np.quantile(covb, 0.05)), float(np.quantile(covb, 0.95))],
                        "width_median_pts": float(np.median(wid) * 100), "width_p90_pts": float(np.quantile(wid, 0.9) * 100),
                        "share_width_lt10pts": float((wid < 0.10).mean()),
                        "share_excludes_base_rate": float(np.nanmean(excl)) if np.isfinite(bse).any() else None,
                        "interval_score_pts": float(IS.mean() * 100), "n_groups": int(okg.sum()),
                        "rows_with_range": int(okr_.sum())}
                res["cells"].append(cell)
                cc = cell["constructions"]
                print(T_NAME[T], tier, k, "base %.4f" % cell["base_rate"],
                      " | ".join(f"{c}: cov {v['coverage_groups']:.2f} w {v['width_median_pts']:.1f}/{v['width_p90_pts']:.1f} IS {v['interval_score_pts']:.1f}"
                                 for c, v in cc.items()), flush=True)
    M6.write_json(out_json, res)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nominal", type=float, default=0.90)
    a = ap.parse_args(argv)
    run(a.rows, os.path.join(a.out, f"ranges-{int(a.nominal * 100)}.json"), a.nominal)


if __name__ == "__main__":
    main()
