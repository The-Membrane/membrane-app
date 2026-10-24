"""Q26 R11.1-v5 audit counts for the label-B (fH) validation (coordinator request after the Codex O227 review).
Report only; no metric is recomputed differently.

  python3 r111v5_audit.py --work WORK --scr SCR --out OUT

1. EUR-stable exposure: a state-only replay of the r111v5_labels origins (same loop, no prices) flags positions with
   an EUR stable (EURS, jEUR, EURA, agEUR) as LT-weighted collateral or as debt; counts of scored label-B rows with
   the flag per horizon and distance bucket (rows and unique paths).
2. Bootstrap validity: boot_ci's draws replayed with the same seed and block layout; per metric and cell the draws
   kept vs dropped (no positive in the draw: every metric dropped; AUC also needs a negative).
3. Calibration slope: the same Newton fit with its iteration count and convergence flag (step < 1e-8 within 25).
Representative rule for "paths": the first scored row per asset x origin day x round(|k| / 0.0025) cell, in row order.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))
import r111v3_engine as E  # noqa: E402
import r111v3_gate as G  # noqa: E402
import r10_mechanics as M  # noqa: E402
import r111v5_labels as LB  # noqa: E402

EUR = {"EURS", "jEUR", "EURA", "agEUR"}


def eur_flags(work, Z):
    inp = E.Inputs(work)
    metas = G.arb_metas(work)
    hours = G.arb_hours(inp, work)
    import r111v5_gate as V5
    cm = V5.conf_metas(work)
    cm_blocks = np.array([m["block"] for m in cm], dtype=np.int64)
    sym = list(inp.symbols)
    eur = np.array([s in EUR for s in sym])
    inv_unit = 1.0 / (10.0 ** inp.dec)
    t, p = inp.tok, inp.pool
    tk = t["block"] * 1_000_000 + t["lidx"]
    fk = p["f_block"] * 1_000_000 + p["f_lidx"]
    ek = p["e_block"] * 1_000_000 + p["e_lidx"]
    st, idx = E.State(inp), E.Indexes(inp)
    ptr_t = ptr_f = ptr_e = 0
    hour_of = {h["hour"]: i for i, h in enumerate(hours)}
    days_sorted = sorted(metas)
    cache = {}
    flags, users_all, days_all = [], [], []
    d = LB.FIRST_ORIGIN
    while d <= LB.LAST_ORIGIN:
        t_or = LB.utc(d)
        hi = hour_of.get(t_or)
        if hi is None:
            d += dt.timedelta(days=1)
            continue
        h = hours[hi]
        K = h["block"] * 1_000_000 + 999_999
        e_t = int(np.searchsorted(tk, K, "right"))
        sl = slice(ptr_t, e_t)
        k_, u_, r_, dl = t["kind"][sl], t["user"][sl], t["res"][sl], t["delta"][sl]
        np.add.at(st.SA, (u_[k_ == 0], r_[k_ == 0]), dl[k_ == 0])
        np.add.at(st.SV, (u_[k_ == 1], r_[k_ == 1]), dl[k_ == 1])
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
        md = days_sorted[max(np.searchsorted(days_sorted, d.isoformat(), "right") - 1, 0)]
        ab = metas[md].get("block", 0)
        j = int(np.searchsorted(cm_blocks, h["block"], "right")) - 1
        key = ("c", j) if (j >= 0 and cm_blocks[j] > ab) else ("d", md)
        if key not in cache:
            meta = cm[j] if key[0] == "c" else metas[md]
            g = {x for x in meta["reserves"] if x in inp.gidx}
            cache[key] = M.Day({**meta, "reserves": {x: r for x, r in meta["reserves"].items() if x in g}}, inp.gidx)
        day = cache[key]
        users = np.nonzero((st.SV > 0.5).any(axis=1) | (st.SP > 0.5).any(axis=1))[0]
        if len(users) == 0:
            d += dt.timedelta(days=1)
            continue
        ss = E.stable_value(st.SP[users], st.SR[users], st.ST[users], float(h["ts"]))
        debt_u = st.SV[users] * Vt * inv_unit + ss * inv_unit
        keep = (debt_u * pxh).sum(axis=1) >= LB.MIN_DEBT
        users, debt_u = users[keep], debt_u[keep]
        ems = st.EM[users]
        LT = np.zeros((len(users), inp.R))
        for em in np.unique(ems):
            LT[ems == em] = day.eff(int(em))[0]
        cLT = st.SA[users] * Lt * inv_unit * LT * (st.FL[users] & (LT > 0))
        flags.append(((cLT > 0) & eur).any(axis=1) | ((debt_u > 0) & eur).any(axis=1))
        users_all.append(users)
        days_all.append(np.full(len(users), t_or, dtype=np.int64))
        d += dt.timedelta(days=1)
    f = np.concatenate(flags)
    u = np.concatenate(users_all)
    dd = np.concatenate(days_all)
    n = len(Z["u"])
    f, u, dd = f[:n], u[:n], dd[:n]          # the label pass stops where the 7 d price window runs out
    if len(u) != n or not (np.array_equal(u, Z["u"]) and np.array_equal(dd, Z["day"])):
        raise SystemExit("row order differs from rows-labels.npz")
    return f


def slope_conv(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    y = np.asarray(y, float)
    if y.sum() == 0 or y.sum() == len(y):
        return {"defined": False}
    z = np.log(p / (1 - p))
    X = np.c_[np.ones_like(z), z]
    w = np.zeros(2)
    for it in range(25):
        q = 1 / (1 + np.exp(-(X @ w)))
        Hm = (X * (q * (1 - q))[:, None]).T @ X + 1e-9 * np.eye(2)
        step = np.linalg.solve(Hm, X.T @ (y - q))
        w += step
        if np.abs(step).max() < 1e-8:
            return {"defined": True, "slope": float(w[1]), "iterations": it + 1, "converged": True}
    return {"defined": True, "slope": float(w[1]), "iterations": 25, "converged": False, "last_step": float(np.abs(step).max())}


def boot_validity(day, y, B=1000, seed=20261024):
    wk = (np.asarray(day) // LB.DAY - 4) // 7
    uw, inv = np.unique(wk, return_inverse=True)
    groups = [np.nonzero(inv == i)[0] for i in range(len(uw))]
    rng = np.random.default_rng(seed)
    kept = kept_auc = 0
    for _ in range(B):
        ii = np.concatenate([groups[j] for j in rng.integers(0, len(groups), len(groups))])
        pos = y[ii].sum()
        if pos == 0:
            continue
        kept += 1
        kept_auc += pos < len(ii)
    return {"draws": B, "kept_R_bss": int(kept), "dropped_R_bss_no_positive": int(B - kept),
            "kept_auc": int(kept_auc), "dropped_auc": int(B - kept_auc)}


def main():
    ap = argparse.ArgumentParser()
    for k in ("work", "scr", "out"):
        ap.add_argument(f"--{k}", required=True)
    a = ap.parse_args()
    Z = np.load(os.path.join(a.scr, "rows-labels.npz"))
    F = np.load(os.path.join(a.scr, "fh-dense.npz"))
    eurf = eur_flags(a.work, Z)
    levels = F["levels"]
    series = [str(x) for x in Z["series"]]
    day, hf0, single, kX, yB = Z["day"], Z["hf0"], Z["singleX"], Z["kX"], Z["yB"]
    out = {"what": "R11.1-v5 label-B validation audit (report only; coordinator request, Codex O227)",
           "representative_rule": "paths = the first scored row (row order: origin, then account id) per asset x origin day "
                                  "x round(|k| / 0.0025) cell",
           "eur_stables": sorted(EUR), "by_H": {}}
    vnames = [f"{LB.VBUCKETS[i]*100:g}-{LB.VBUCKETS[i+1]*100:g}%" for i in range(len(LB.VBUCKETS) - 1)] + [f">{LB.VBUCKETS[-1]*100:g}%"]
    for hj, Hh in enumerate(LB.HS):
        Hs = Hh * 3600
        sub = (hf0 >= 1.0) & (single >= 0) & (yB[:, hj] >= 0) & np.isfinite(kX[:, hj]) & (kX[:, hj] < 0) & (kX[:, hj] > -1)
        vi = np.nonzero(sub)[0]
        pf = np.full(len(vi), np.nan)
        for xi, x in enumerate(series):
            key = f"{x}|{Hh}|"
            if key + "ts" not in F.files:
                continue
            ts_x, fh_x, y_x = F[key + "ts"], F[key + "fH"], F[key + "y"].astype(float)
            o = np.argsort(ts_x)
            ts_x, fh_x = ts_x[o], fh_x[o]
            mx_ = np.where(single[vi] == xi)[0]
            if len(mx_) == 0:
                continue
            tt = day[vi[mx_]]
            j = np.searchsorted(ts_x, tt)
            have = (j < len(ts_x)) & (ts_x[np.minimum(j, len(ts_x) - 1)] == tt)
            nres = np.searchsorted(ts_x, tt - Hs, side="right")
            g = have & (nres >= 30)
            jj = np.minimum(j, len(ts_x) - 1)
            if g.any():
                pf[mx_[g]] = LB.interp_logp(kX[vi[mx_[g]], hj], levels, fh_x[jj[g]])
        okv = np.isfinite(pf)
        vi, pf = vi[okv], pf[okv]
        yb = yB[vi, hj].astype(float)
        kk = -kX[vi, hj]
        vb = LB.bucket_of(kk, LB.VBUCKETS)
        keyd = single[vi].astype(np.int64) * 10**12 + (day[vi] // LB.DAY) * 10**5 + np.round(kk / 0.0025).astype(np.int64)
        _, first = np.unique(keyd, return_index=True)
        dedup = np.zeros(len(vi), bool)
        dedup[first] = True
        ent = {}
        for i, nm in enumerate(vnames):
            m = vb == i
            if m.sum() == 0:
                continue
            md = m & dedup
            e = {"rows": int(m.sum()), "paths": int(md.sum()),
                 "eur_rows": int(eurf[vi][m].sum()), "eur_paths": int(eurf[vi][md].sum()),
                 "eur_positives_rows": int((eurf[vi][m] & (yb[m] > 0)).sum()),
                 "slope_paths": slope_conv(pf[md], yb[md]), "slope_rows": slope_conv(pf[m], yb[m])}
            if yb[md].sum() >= 5:
                e["boot_paths"] = boot_validity(day[vi][md], yb[md])
            if yb[m].sum() >= 5:
                e["boot_rows"] = boot_validity(day[vi][m], yb[m])
            ent[nm] = e
        out["by_H"][f"{Hh}h"] = ent
        print(Hh, json.dumps(ent), flush=True)
    os.makedirs(a.out, exist_ok=True)
    G.jdump(os.path.join(a.out, "r111v5-audit.json"), out)


if __name__ == "__main__":
    main()
