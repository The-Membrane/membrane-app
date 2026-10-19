#!/usr/bin/env python3
"""Q26 R15.4b: big-wallet exits pooled across lending markets in units of each market's own exit rate.

Item: membrane-board `design/Q26_ROUND15_PREREG.md` R15.4 (register row "Big-wallet and contract exits"), Deviation
D-R15.4b (this design) and later D-R15.4c/d. Parents: `design/Q26_ROUND14_PREREG.md` R14.2 (L0, D-R14.2a-c).

Model M_s ("standardized L0"). The frozen R14.2 L0 ladder (Core fold fits, theta = 1) gives each big-wallet row its
relative exit risk. The level comes from the row's own market: per market m, quarter q and cell (x, h),
    O = sum of y, E = sum of p_L0 over every row of market m (all segments, bal >= $1M) resolved before q starts
    theta_m = (O + KAPPA) / (E + KAPPA),   p_s = 1 - (1 - p_L0) ** theta_m,   then the B4 2-D monotone fix.
So the model is pooled in standardized units (exit risk relative to the market's own exit rate) and decoded with the
market's own as-of rate. KAPPA = 10 expected exits (fixed in D-R15.4b, no menu).

Scored set: thin pool = segments w3 (wallets >= $50M), c2, c3 (contracts >= $10M); Brier summed over the 5 x cells.
Primary cells (D-R15.4b): P1 = 24 h, M_s vs B4 v4a theta1; P2 = 7 d, M_s vs L0 (the standardization leg).

Phases:
  dev      development on D1 (Aave V2 Ethereum USDC/USDT, grade C after R14.2): M_s, L0, b4t1, b4v4a_t1, market pop;
           two-way (unit x 30-day block) pigeonhole bootstrap, CGM cross-check, concentration, power inputs.
           Writes no address.
"""
import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "2")

import argparse  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r142_ladder as L  # noqa: E402

G, S, F, B = L.G, L.S, L.F, L.B
NX, NH = L.NX, L.NH
THIN_IDX = L.THIN_IDX
KAPPA = 10.0
BLOCK_DAYS = 30
N_BOOT = 10_000
SEED_DEV = 20261954
PRIMARY = (("P1", "24h", "Ms", "b4v4a_t1"), ("P2", "7d", "Ms", "L0"))
REPORTED = (("24h", "Ms", "b4t1"), ("24h", "Ms", "L0"), ("24h", "Ms", "pop_mkt"), ("48h", "Ms", "b4v4a_t1"),
            ("48h", "Ms", "L0"), ("7d", "Ms", "b4v4a_t1"), ("7d", "Ms", "b4t1"), ("7d", "Ms", "pop_mkt"),
            ("24h", "L0", "b4v4a_t1"), ("7d", "L0", "b4v4a_t1"))
R_BAND = (0.8, 1.25)
R142_RUN = "history-forecasts/r14/r142-run-0182bcd9/"


def market_decoder(rows, ctx, PR, kappa=KAPPA):
    """theta per (row, cell) from the row's own market rows resolved before the row's quarter start (all segments)."""
    n = len(rows["t"])
    th = np.full((n, G.NC), np.nan)
    pop = np.full((n, G.NC), np.nan)
    res = rows["reserve"]
    for qn, qs, qe in ctx.folds:
        Tqs = int(ctx.T[qs]) if qs < ctx.D else int(ctx.T[-1]) + 86400
        for m in np.unique(res):
            te = np.nonzero((rows["t"] >= qs) & (rows["t"] < qe) & rows["feat_ok"] & (res == m))[0]
            if not len(te):
                continue
            for hi in range(NH):
                for xi in range(NX):
                    ci = int(G.XCELL[hi, xi])
                    tr = G.train_mask_cell(rows["T0"], G.HSEC[hi], Tqs, rows["RES"][:, hi], rows["CAP"][:, ci],
                                           rows["feat_ok"]) & (res == m)
                    y = rows["Y"][tr, ci].astype(float)
                    e = PR["L0"][tr, ci]
                    ok = np.isfinite(e)
                    O, E = float(y[ok].sum()), float(e[ok].sum())
                    th[te, ci] = (O + kappa) / (E + kappa)
                    pop[te, ci] = float(y.mean()) if len(y) else np.nan
    return th, pop


def apply_decoder(rows, P, th):
    out = P.copy()
    xc = G.XCELL.ravel()
    out[:, xc] = 1.0 - np.power(np.clip(1.0 - P[:, xc], 0.0, 1.0), th[:, xc])
    return S.fix_grid(out, rows["CAP"])


def stack(rows, PR, test, h, a, b, segs=THIN_IDX):
    hi = G.HNAMES.index(h)
    T, Y, A, Bb, U, X, R = [], [], [], [], [], [], []
    for xi in range(NX):
        ci = int(G.XCELL[hi, xi])
        m = test & rows["RES"][:, hi] & ~rows["CAP"][:, ci] & np.isin(rows["seg"], list(segs))
        m &= np.isfinite(PR[a][:, ci]) & np.isfinite(PR[b][:, ci])
        T.append(rows["t"][m]); Y.append(rows["Y"][m, ci].astype(float)); A.append(PR[a][m, ci])
        Bb.append(PR[b][m, ci]); U.append(rows["unit"][m]); X.append(np.full(int(m.sum()), xi))
        R.append(rows["reserve"][m])
    return [np.concatenate(v) for v in (T, Y, A, Bb, U, X, R)]


def twoway(t, clus, y, a, b, seed, n_rep=N_BOOT, t0=None):
    """Pigeonhole bootstrap: clusters and 30-day calendar blocks resampled independently; row weight = product.
    Returns stats on BSS and mean d (d = (a-y)^2 - (b-y)^2; negative = a better)."""
    dm, db = (a - y) ** 2, (b - y) ** 2
    t0 = t.min() if t0 is None else t0
    blk = (t - t0) // BLOCK_DAYS
    uu, iu = np.unique(clus, return_inverse=True)
    bb, ib = np.unique(blk, return_inverse=True)
    cell = iu * len(bb) + ib
    cc, ic = np.unique(cell, return_inverse=True)
    sm = np.bincount(ic, dm); sb = np.bincount(ic, db); nn = np.bincount(ic).astype(float)
    cu, cb = cc // len(bb), cc % len(bb)
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
    ok = np.isfinite(bss_r)
    br = bss_r[ok]
    p_centred = (1 + np.sum(br - bss >= bss)) / (len(br) + 1)
    p_pct = (1 + np.sum(br <= 0)) / (len(br) + 1)
    sd_md = float(np.nanstd(md_r))
    return {"bss": float(bss), "ci95": [float(np.percentile(br, 2.5)), float(np.percentile(br, 97.5))],
            "p_centred": float(p_centred), "p_percentile": float(p_pct), "mean_d": md, "sd_mean_d_2way": sd_md,
            "z_mean_d_2way": float(-md / sd_md) if sd_md > 0 else None, "clusters": int(len(uu)),
            "blocks": int(len(bb)), "n_rep": int(n_rep)}


def cgm(t, clus, y, a, b, t0=None):
    """Cameron-Gelbach-Miller two-way cluster-robust SE of mean d (clusters x 30-day blocks)."""
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
    g = -np.bincount(iu, d)                         # gain per unit (positive = a better)
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
    """R = sum p / sum y and the two-way SD of ln R."""
    t0 = t.min()
    blk = (t - t0) // BLOCK_DAYS
    uu, iu = np.unique(clus, return_inverse=True)
    bb, ib = np.unique(blk, return_inverse=True)
    cell = iu * len(bb) + ib
    cc, ic = np.unique(cell, return_inverse=True)
    sp, sy = np.bincount(ic, a), np.bincount(ic, y)
    cu, cb = cc // len(bb), cc % len(bb)
    rng = np.random.default_rng(seed)
    lr = []
    for _ in range(n_rep):
        wu = np.bincount(rng.integers(0, len(uu), len(uu)), minlength=len(uu))
        wb = np.bincount(rng.integers(0, len(bb), len(bb)), minlength=len(bb))
        w = wu[cu] * wb[cb]
        Y_ = (w * sy).sum()
        if Y_ > 0:
            lr.append(math.log((w * sp).sum() / Y_))
    return {"R": float(a.sum() / y.sum()), "sd_lnR_2way": float(np.std(lr)), "exits": int(y.sum())}


def score(rows, PR, test, h, a, b, seed):
    t, y, pa, pb, u, x, r = stack(rows, PR, test, h, a, b)
    out = {"pairs": int(len(y)), "exits": int(y.sum()), "units": int(len(np.unique(u))),
           "units_with_exit": int(len(np.unique(u[y == 1]))), "blocks_30d": int(len(np.unique((t - t.min()) // 30))),
           "cells_unit_block": int(len(np.unique(u.astype(np.int64) * 100000 + (t - t.min()) // 30))),
           "unit_days": int(len(np.unique(u.astype(np.int64) * 100000 + t))),
           "twoway_unit_x_block": twoway(t, u, y, pa, pb, seed), "cgm_unit_x_block": cgm(t, u, y, pa, pb),
           "market_x_block_reported": twoway(t, r, y, pa, pb, seed + 1, n_rep=2000),
           "concentration": concentration(u, y, pa, pb, t, seed + 2),
           "calib_a": calib(t, u, y, pa, seed + 3), "R_b": float(pb.sum() / y.sum()) if y.sum() else None}
    return out


def phase_dev(datasets_dir, d1_dir, out_dir, log):
    os.makedirs(out_dir, exist_ok=True)
    p = os.path.join(out_dir, "dev-r154.json")
    if os.path.exists(p):
        raise SystemExit(f"STOP: {p} exists")
    t0 = time.time()
    ctx, res, rows, qinfo = L.d1_rows(datasets_dir, d1_dir, log)
    frozen = json.load(open(os.path.join(datasets_dir, R142_RUN, "frozen-r142.json")))
    shipped = json.load(open(os.path.join(datasets_dir, L.B4_RUN, "shipped-b4.json")))
    test = rows["feat_ok"].copy()
    n = len(rows["t"])
    mf = rows["model_fold"].astype(int)
    PR = {"L0": np.full((n, G.NC), np.nan)}
    for fi in sorted(set(mf[test].tolist())):
        te = np.nonzero(test & (mf == fi))[0]
        PR["L0"][te] = S.fix_grid(L.predict_L(rows, frozen["fold_params_L"][str(fi)], te, None), rows["CAP"][te])
    PR.update(L.b4_theta1(rows, shipped["fold_params"], shipped["cells"], mf, test))
    log("decoder ...")
    th, pop = market_decoder(rows, ctx, PR)
    PR["Ms"] = apply_decoder(rows, PR["L0"], th)
    PR["pop_mkt"] = pop
    xc = G.XCELL.ravel()
    thin = test & np.isin(rows["seg"], list(THIN_IDX))
    theta_summary = {h: {"median": float(np.nanmedian(th[thin][:, int(G.XCELL[G.HNAMES.index(h), 2])])),
                         "p10": float(np.nanpercentile(th[thin][:, int(G.XCELL[G.HNAMES.index(h), 2])], 10)),
                         "p90": float(np.nanpercentile(th[thin][:, int(G.XCELL[G.HNAMES.index(h), 2])], 90))}
                     for h in ("24h", "48h", "7d")}
    _ = xc
    out = {"phase": "dev (D1, seen; no D2 byte)", "code": L.code_meta(), "kappa": KAPPA,
           "rows_feat_ok": int(test.sum()), "thin_rows": int(thin.sum()),
           "theta_x50_thin": theta_summary, "primary": {}, "reported": {}}
    for i, (cid, h, a, b) in enumerate(PRIMARY):
        log(f"primary {cid} {h} {a} vs {b}")
        out["primary"][cid] = {"h": h, "a": a, "b": b, **score(rows, PR, test, h, a, b, SEED_DEV + 10 * i)}
    for j, (h, a, b) in enumerate(REPORTED):
        log(f"reported {h} {a} vs {b}")
        out["reported"][f"{h}_{a}_vs_{b}"] = score(rows, PR, test, h, a, b, SEED_DEV + 100 + 10 * j)
    out["runtime_s"] = time.time() - t0
    out["created_utc"] = L.utcnow()
    B.write_json(p, out, refuse_overwrite=True)
    L.guard_no_address(p)
    log(f"wrote {p}")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["dev"])
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--d1-dir")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    def log(m):
        print(f"[{L.utcnow()}] {m}", flush=True)
    if a.phase == "dev":
        phase_dev(a.datasets, a.d1_dir, a.out, log)


if __name__ == "__main__":
    main()
