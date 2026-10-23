#!/usr/bin/env python3
"""Q26 R18.1: blind step of B6c v4ac (cash-exit target y_cash) against B4 per-deposit exit odds at 6 h-7 d.

Item: membrane-board `design/Q26_ROUND18_PREREG.md` section R18.1 (and its dated Deviations).
Parents: `design/Q26_ROUND9_PREREG.md` R9.1(d)3 and D6-D8 (B6c), `design/Q26_ROUND15_PREREG.md` D-R15.4b-d (D2,
power rule, market x block), `design/Q26_ROUND13_PREREG.md` D-R13.5c (bootstrap-z power, 1-2 primary cells,
registered count fields only), `design/q26-retro-twoway-2026-10-19.md` (centred and percentile p),
`design/q26-closed-path-audit-2026-10-19.md` (B6c eligible for a blind step on D2/D5, not a pass).

Scored segment: wallets under $50M (B3 segments w1, w2). Contracts and wallets >= $50M are out of scope.
Brier is summed over the 5 x cells (10, 25, 50, 75, 90 %) per horizon. Cash-blocked rows (x * bal > cash) are not
scored (they are shown as capped). Windows meeting 2026-04-01..2026-06-30 are not scored (Q26 standing rule).

Phases:
  dev     development on Aave V3 Core USDC (seen) from the published B6c predictions (membrane-datasets d2e93f8
          history-forecasts/r9/b6c-run-da52297d/): v4ac vs b4 on corrected y_cash, common rows, per horizon;
          two-way unit x 30-day block pigeonhole bootstrap (B 10,000; centred and percentile p of BSS), CGM,
          concentration (leave-top-k units), R and its two-way SD; power at development counts (Holm-1 and Holm-2).
          Writes no address (the published files hold integer unit indices only).
  power   joint power per primary cell at the counts of a counts file (D-R15.4b component rule, anchored to the
          development bootstrap SD, D-R13.5c rule 1).
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "2")

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
B6C_RUN = "history-forecasts/r9/b6c-run-da52297d/"
B6C_PRED_SHA = {
    "6h": "157c5fc13731effd019c73bb3a3e5b8d6062aa92f53247275f0ca3389a88c39b",
    "24h": "22d32a9add82eabf3292703b552e41b21395baddad024aaf54fb12eb799c2a5e",
    "48h": "6109fea2be898d25afaf03c1d29e1f0d82bb47e6a31817f7ebac1a4827090b47",
    "7d": "b2bf6c9b2daaa8a667c6b0e77cbe59a158083212d5ba289b9ded427189c1b4e0",
}
HORIZONS = ("6h", "24h", "48h", "7d")
H_DAYS = {"6h": 0.25, "24h": 1.0, "48h": 2.0, "7d": 7.0}
XS = (10, 25, 50, 75, 90)
SEGS = ("w1", "w2")
BLOCK_DAYS = 30
N_BOOT = 10_000
SEED_DEV = 20261810
R_BAND = (0.8, 1.25)
Q2_LO, Q2_HI = "2026-04-01", "2026-07-01"
Z_ONE_SIDED = {1: 1.6448536269514722, 2: 1.959963984540054}   # Holm first step, one-sided alpha 0.05 / M


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def code_meta():
    def git(*a):
        try:
            return subprocess.run(["git", "-C", HERE, *a], capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:
            return None
    me = os.path.basename(__file__)
    return {"git_head": git("rev-parse", "HEAD"), "script_sha256": sha256_file(os.path.abspath(__file__)),
            "script_dirty": bool(git("status", "--porcelain", "--", me)), "python": sys.version.split()[0],
            "numpy": np.__version__, "pandas": pd.__version__}


def _ncdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


# ---------------------------------------------------------------------------------------------
# Statistics (same estimators as r154_exit_std.py; clusters = units or markets, blocks = 30-day calendar blocks)
# ---------------------------------------------------------------------------------------------
def _cells(t, clus, t0):
    blk = (t - t0) // BLOCK_DAYS
    uu, iu = np.unique(clus, return_inverse=True)
    bb, ib = np.unique(blk, return_inverse=True)
    cell = iu.astype(np.int64) * len(bb) + ib
    cc, ic = np.unique(cell, return_inverse=True)
    return uu, bb, cc // len(bb), cc % len(bb), ic


def twoway(t, clus, y, a, b, seed, n_rep=N_BOOT, t0=None):
    """Pigeonhole bootstrap. d = (a-y)^2 - (b-y)^2 summed over x per row (negative = a better)."""
    dm, db = (a - y) ** 2, (b - y) ** 2
    t0 = t.min() if t0 is None else t0
    uu, bb, cu, cb, ic = _cells(t, clus, t0)
    sm = np.bincount(ic, dm); sb = np.bincount(ic, db); nn = np.bincount(ic).astype(float)
    rng = np.random.default_rng(seed)
    bss_r, md_r = np.empty(n_rep), np.empty(n_rep)
    for r in range(n_rep):
        wu = np.bincount(rng.integers(0, len(uu), len(uu)), minlength=len(uu))
        wb = np.bincount(rng.integers(0, len(bb), len(bb)), minlength=len(bb))
        w = wu[cu] * wb[cb]
        Sm, Sb, N = (w * sm).sum(), (w * sb).sum(), (w * nn).sum()
        bss_r[r] = 1.0 - Sm / Sb if Sb > 0 else np.nan
        md_r[r] = (Sm - Sb) / N if N > 0 else np.nan
    bss = 1.0 - dm.sum() / db.sum()
    md = float((dm - db).mean())
    br = bss_r[np.isfinite(bss_r)]
    p_centred = (1 + np.sum(br - bss >= bss)) / (len(br) + 1)
    p_pct = (1 + np.sum(br <= 0)) / (len(br) + 1)
    sd_md = float(np.nanstd(md_r))
    return {"bss": float(bss), "ci95": [float(np.percentile(br, 2.5)), float(np.percentile(br, 97.5))],
            "p_centred": float(p_centred), "p_percentile": float(p_pct), "mean_d": md, "sd_mean_d_2way": sd_md,
            "z_mean_d_2way": float(-md / sd_md) if sd_md > 0 else None, "clusters": int(len(uu)),
            "blocks": int(len(bb)), "n_rep": int(n_rep)}


def cgm(t, clus, y, a, b, t0=None):
    d = (a - y) ** 2 - (b - y) ** 2
    e = d - d.mean()
    n = len(d)
    t0 = t.min() if t0 is None else t0
    blk = (t - t0) // BLOCK_DAYS

    def v(g):
        _, ig = np.unique(g, return_inverse=True)
        s = np.bincount(ig, e)
        return float((s ** 2).sum()) / n ** 2
    vu, vt = v(clus), v(blk)
    vut = v(clus.astype(np.int64) * 100000 + blk.astype(np.int64))
    var = vu + vt - vut
    var_used = var if var > 0 else max(vu, vt)
    return {"mean_d": float(d.mean()), "se_cgm": math.sqrt(var_used), "z_cgm": float(-d.mean() / math.sqrt(var_used)),
            "v_unit": vu, "v_block": vt, "v_inter": vut, "negative_var_fallback": bool(var <= 0)}


def concentration(clus, y, a, b, t, seed, n_rep=2000):
    d = (a - y) ** 2 - (b - y) ** 2
    uu, iu = np.unique(clus, return_inverse=True)
    g = -np.bincount(iu, d)
    S_ = len(uu)
    k = max(3, int(math.ceil(0.025 * S_)))
    top = np.argsort(-g)[:k]
    keep = ~np.isin(iu, top)
    tot = g.sum()
    out = {"units": int(S_), "k": int(k), "units_with_gain": int((g > 0).sum()),
           "top_k_share_of_gain": float(g[top].sum() / tot) if tot > 0 else None,
           "mean_d_leave_top_k": float(d[keep].mean()) if keep.any() else None,
           "bss_leave_top_k": float(1 - ((a - y) ** 2)[keep].sum() / ((b - y) ** 2)[keep].sum()) if keep.any() else None}
    if keep.any():
        tw = twoway(t[keep], clus[keep], y[keep], a[keep], b[keep], seed, n_rep=n_rep, t0=t.min())
        out["z_mean_d_leave_top_k_2way"] = tw["z_mean_d_2way"]
    return out


def calib(t, clus, y, a, seed, n_rep=2000):
    uu, bb, cu, cb, ic = _cells(t, clus, t.min())
    sp, sy = np.bincount(ic, a), np.bincount(ic, y)
    rng = np.random.default_rng(seed)
    lr = []
    for _ in range(n_rep):
        wu = np.bincount(rng.integers(0, len(uu), len(uu)), minlength=len(uu))
        wb = np.bincount(rng.integers(0, len(bb), len(bb)), minlength=len(bb))
        w = wu[cu] * wb[cb]
        Y_ = (w * sy).sum()
        if Y_ > 0:
            lr.append(math.log((w * sp).sum() / Y_))
    sd = float(np.std(lr))
    R = float(a.sum() / y.sum())
    # one-sided band tests on ln R (smooth legs, no kink): H0 ln R <= ln 0.8 and H0 ln R >= ln 1.25
    za = (math.log(R) - math.log(R_BAND[0])) / sd if sd > 0 else None
    zb = (math.log(R_BAND[1]) - math.log(R)) / sd if sd > 0 else None
    return {"R": R, "sd_lnR_2way": sd, "exits": int(y.sum()), "z_lo_leg": za, "z_hi_leg": zb}


def project_cell(P, U_r, B_r, C_r, crit):
    """D-R15.4b component rule, anchored to the development pigeonhole bootstrap SD (D-R13.5c rule 1)."""
    c, tw = P["cgm_unit_x_block"], P["twoway_unit_x_block"]
    vu, vt, vi = c["v_unit"], c["v_block"], c["v_inter"]
    Vu, Vt = max(vu - vi, 0.0), max(vt - vi, 0.0)
    base = Vu + Vt + 3.0 * vi
    f = (Vu / U_r + Vt / B_r + 3.0 * vi / C_r) / base
    md = -tw["mean_d"]
    z_dev = md / tw["sd_mean_d_2way"]
    z = md / (tw["sd_mean_d_2way"] * math.sqrt(f))
    p_test = _ncdf(z - crit) if md > 0 else 0.0
    R, sl = P["calib_a"]["R"], P["calib_a"]["sd_lnR_2way"] * math.sqrt(f)
    p_R = _ncdf((math.log(R_BAND[1]) - math.log(R)) / sl) - _ncdf((math.log(R_BAND[0]) - math.log(R)) / sl)
    zc = P["concentration"].get("z_mean_d_leave_top_k_2way")
    p_conc = _ncdf(zc * z / z_dev) if (zc is not None and md > 0) else 0.0
    return {"U_r": U_r, "B_r": B_r, "C_r": C_r, "var_factor": f, "z_dev": z_dev, "z_proj": z, "p_test": p_test,
            "p_R_band": p_R, "p_concentration": p_conc, "joint": p_test * p_R * p_conc}


def score_stack(t, u, y, pa, pb, seed, market=None):
    out = {"pairs": int(len(y)), "exits": int(y.sum()), "units": int(len(np.unique(u))),
           "units_with_exit": int(len(np.unique(u[y == 1]))),
           "blocks_30d": int(len(np.unique((t - t.min()) // BLOCK_DAYS))),
           "cells_unit_block": int(len(np.unique(u.astype(np.int64) * 100000 + (t - t.min()) // BLOCK_DAYS))),
           "unit_days": int(len(np.unique(u.astype(np.int64) * 100000 + t))),
           "twoway_unit_x_block": twoway(t, u, y, pa, pb, seed), "cgm_unit_x_block": cgm(t, u, y, pa, pb),
           "concentration": concentration(u, y, pa, pb, t, seed + 2),
           "calib_a": calib(t, u, y, pa, seed + 3), "R_b": float(pb.sum() / y.sum()) if y.sum() else None}
    if market is not None and len(np.unique(market)) >= 2:
        out["market_x_block"] = twoway(t, market, y, pa, pb, seed + 1, n_rep=N_BOOT)
    else:
        out["market_x_block"] = "not estimable (one market)"
    return out


# ---------------------------------------------------------------------------------------------
# Development (Core USDC, seen)
# ---------------------------------------------------------------------------------------------
def dev_stack(datasets, h):
    p = os.path.join(datasets, B6C_RUN, f"predictions-b6c-{h}-USDC.csv.gz")
    if sha256_file(p) != B6C_PRED_SHA[h]:
        raise SystemExit(f"STOP: sha256 mismatch {p}")
    cols = ["unit", "date", "segment", "in_b6"]
    for x in XS:
        cols += [f"cash_blocked_x{x}_{h}", f"ycash_x{x}_{h}", f"v4ac_x{x}_{h}", f"b4_x{x}_{h}"]
    d = pd.read_csv(p, usecols=cols)
    day = (pd.to_datetime(d["date"]) - pd.Timestamp("1970-01-01")).dt.days.to_numpy()
    q2lo = (pd.Timestamp(Q2_LO) - pd.Timestamp("1970-01-01")).days
    q2hi = (pd.Timestamp(Q2_HI) - pd.Timestamp("1970-01-01")).days
    meets_q2 = (day + H_DAYS[h] > q2lo) & (day < q2hi)
    base = d["segment"].isin(SEGS).to_numpy() & (d["in_b6"].to_numpy() == 1) & ~meets_q2
    T, U, Y, A, Bb = [], [], [], [], []
    for x in XS:
        m = base & (d[f"cash_blocked_x{x}_{h}"].to_numpy() == 0)
        m &= np.isfinite(d[f"v4ac_x{x}_{h}"].to_numpy()) & np.isfinite(d[f"b4_x{x}_{h}"].to_numpy())
        T.append(day[m]); U.append(d["unit"].to_numpy()[m]); Y.append(d[f"ycash_x{x}_{h}"].to_numpy()[m].astype(float))
        A.append(d[f"v4ac_x{x}_{h}"].to_numpy()[m]); Bb.append(d[f"b4_x{x}_{h}"].to_numpy()[m])
    info = {"rows_file": int(len(d)), "rows_segment_common_noQ2": int(base.sum()), "excluded_q2_rows": int(meets_q2.sum())}
    return [np.concatenate(v) for v in (T, U, Y, A, Bb)], info


def phase_dev(datasets, out_path, log):
    if os.path.exists(out_path):
        raise SystemExit(f"STOP: {out_path} exists")
    out = {"phase": "dev (Aave V3 Core USDC, seen; no D2 or D5 byte)", "code": code_meta(),
           "inputs": {h: {"path": B6C_RUN + f"predictions-b6c-{h}-USDC.csv.gz", "sha256": B6C_PRED_SHA[h]}
                      for h in HORIZONS},
           "segments": list(SEGS), "seed": SEED_DEV, "n_boot": N_BOOT, "cells": {}, "created_utc": None}
    for i, h in enumerate(HORIZONS):
        log(f"dev {h}")
        (t, u, y, a, b), info = dev_stack(datasets, h)
        P = {"h": h, "a": "v4ac", "b": "b4", **info, **score_stack(t, u, y, a, b, SEED_DEV + 10 * i)}
        P["power_at_dev_counts"] = {f"holm{M}": project_cell(P, 1.0, 1.0, 1.0, Z_ONE_SIDED[M]) for M in (1, 2)}
        out["cells"][h] = P
        tw = P["twoway_unit_x_block"]
        log(f"  {h} BSS {tw['bss']:+.4f} ci {tw['ci95']} p {tw['p_centred']:.4g}/{tw['p_percentile']:.4g} "
            f"z {tw['z_mean_d_2way']:.2f} R {P['calib_a']['R']:.3f} power1 {P['power_at_dev_counts']['holm1']['joint']:.3f}")
    out["created_utc"] = utcnow()
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    log(f"wrote {out_path} sha256 {sha256_file(out_path)}")


def phase_power(dev_json, counts_json, cells, out_path, log):
    if os.path.exists(out_path):
        raise SystemExit(f"STOP: {out_path} exists")
    dev = json.load(open(dev_json))
    cnt = json.load(open(counts_json))
    k = cnt["pooled"]
    M = len(cells)
    out = {"phase": "power at counts", "code": code_meta(), "dev_json_sha256": sha256_file(dev_json),
           "counts_json_sha256": sha256_file(counts_json), "holm_M": M, "crit_z": Z_ONE_SIDED[M], "cells": {}}
    joint = []
    for h in cells:
        P = dev["cells"][h]
        kh = k[h] if h in k else k
        r = project_cell(P, kh["units"] / P["units"], kh["blocks_30d"] / P["blocks_30d"],
                         kh["cells_unit_block"] / P["cells_unit_block"], Z_ONE_SIDED[M])
        out["cells"][h] = {"dev_counts": {"U": P["units"], "B": P["blocks_30d"], "C": P["cells_unit_block"]},
                           "target_counts": {"U": kh["units"], "B": kh["blocks_30d"], "C": kh["cells_unit_block"]}, **r}
        joint.append(r["joint"])
    # PASS = at least one primary cell passes (Holm); report the best cell and P(at least one) under independence
    out["best_cell_joint"] = max(joint)
    out["any_cell_joint_indep"] = 1.0 - float(np.prod([1 - j for j in joint]))
    out["created_utc"] = utcnow()
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    log(json.dumps({h: {kk: round(v[kk], 4) for kk in ("z_proj", "p_test", "p_R_band", "p_concentration", "joint")}
                    for h, v in out["cells"].items()}))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["dev", "power"])
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--dev-json")
    ap.add_argument("--counts-json")
    ap.add_argument("--cells", default="")
    a = ap.parse_args(argv)

    def log(m):
        print(f"[{utcnow()}] {m}", flush=True)
    if a.phase == "dev":
        phase_dev(a.datasets, a.out, log)
    elif a.phase == "power":
        phase_power(a.dev_json, a.counts_json, [c for c in a.cells.split(",") if c], a.out, log)


if __name__ == "__main__":
    main()
