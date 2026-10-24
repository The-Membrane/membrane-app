"""Q26 R19.3 release regrade of the UI map (Claude, Q26 lane, 2026-10-24). DEVELOPMENT AND SPENT SETS ONLY.

membrane-board design/Q26_ROUND19_PREREG.md section R19.3 (class rule, statistics, recalibration candidates,
validation and selection rule registered at board a8fedc7 before any score of this script).

Graded forecast: raw (fH) (A6/R12 path), running minimum over levels. Comparators: plain history (a) and climatology
(e) = in-sample frequency of the scored cell, re-estimated inside every bootstrap draw.

  python3 r193_regrade.py blindrows --datasets DS --out OUT [--workers 3] [--sets b12,b13a,b15a,b15b,b20a]
  python3 r193_regrade.py grade     --r162 R162DIR --r192 R192DIR --out OUT          (development + spent-blind)
  python3 r193_regrade.py recal     --r162 R162DIR --r192 R192DIR --out OUT          (walk-forward C1/C2/C3)
  python3 r193_regrade.py freeze    --r162 R162DIR --r192 R192DIR --out OUT --cand C?
  python3 r193_regrade.py blindcheck --out OUT                                        (frozen map on spent sets)
No address, key or secret is read or written. No reserved set is read. Nothing ships from this file.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

STEP, DAY = 3600, 86400
TS = (1, 3, 6, 12, 24, 72, 168, 720)
TL = {1: "1h", 3: "3h", 6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d", 720: "30d"}
LG = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.25, -0.30, -0.40)
L8 = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.30)          # R19.2 rows (6 h - 7 d)
LV162 = {1: (-0.02, -0.03, -0.05), 3: (-0.02, -0.03, -0.05, -0.07), 720: (-0.15, -0.20, -0.25, -0.30, -0.40)}
# graded levels per T (R19.3b): R16.2 grid at 1 h / 3 h / 30 d; -2..-30% at 6 h - 7 d (shallow levels skipped where
# the cell is trivially near-certain is not done: every level is graded)
GRID = {1: LV162[1], 3: LV162[3], 6: L8, 12: L8, 24: L8, 72: L8, 168: L8, 720: LV162[720]}
SETS = ("b12", "b13a", "b15a", "b15b", "b20a")
EXCL_KEYS = {"P1:KRAKEN-ETH": "second ETH (R19.3b)", "blind8:JUPUSDT": "pattern (r16_nn_strict)"}
B_BOOT = 1000
SEED = 20261930
NBIN_X, NBIN_P = 100, 200
R_BAND = (0.8, 1.25)
MIN_POS = 30
RECAL_MIN_ROWS, RECAL_MIN_POS = 1000, 20
W_C3, KAPPA_C3 = 90, 50.0
PCLIP = 1e-4


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def sha_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def group_of(key):
    if key in ("dev:BTC", "dev:ETH"):
        return "btc_eth"
    if key.split(":")[0] in ("A2", "A3"):
        return "large"
    return "alt"


# =====================================================================================================================
# spent-blind rows: raw (fH), (a), y at LG for every T (the r192_borrower.task path without GRU features or extras)
# =====================================================================================================================
def set_specs(name, datasets):
    import r13_recal as R13
    import r14_dr as R14
    import r16_blind as RB
    if name == "b12":
        return R13.b12_specs(datasets)
    if name == "b13a":
        return R13.b13a_specs(datasets)
    if name == "b15a":
        return R13.b15a_specs(os.path.join(datasets, "b15-mexc-prices"))
    if name == "b15b":
        return R14.b15b_specs(os.path.join(datasets, "b15-mexc-prices"))
    if name == "b20a":
        return RB.b20_specs(datasets, "B20a")
    raise SystemExit(name)


def blind_task(spec):
    import a2_touch as M2
    import a6_touch as A6
    import r12_tail as R12
    import r13_recal as R13
    import r16_dev as D
    t0 = time.time()
    ser, folds, caps = R13.load_any(spec)
    N1 = len(ser.close) + 1
    ts_all = ser.base_ts + STEP * np.arange(N1)
    fold_q = [f for f in folds if f["qs_i"] < N1]
    lnk = np.log1p(np.array(LG))
    # pegged-like data check (r16_nn_strict.exclusions second leg): median |24 h log return| sampled daily
    with np.errstate(invalid="ignore", divide="ignore"):
        lc = np.log(ser.close)
    r24 = (lc[24:] - lc[:-24])[::24] if len(lc) > 24 else np.zeros(0)
    r24 = r24[np.isfinite(r24) & (r24 != 0)]
    pegged = bool(len(r24) > 30 and np.median(np.abs(r24)) < 0.002)
    rows = {}
    for T in TS:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        P, n = P6.P, P6.n
        i_all = np.arange(n)
        out = {k_: [] for k_ in ("ts", "y", "a", "fH", "q2", "tail")}
        st = D.ORIGIN_STEP[T]
        for f in fold_q:
            qs, qe = f["qs_i"], min(f["qe_i"], n)
            lim = qs - T
            if lim <= 0:
                continue
            tr = i_all <= lim
            te = np.arange(qs, qe)
            te = te[P.lab_ok[te] & (ts_all[te] + T * STEP <= caps["full"]) & (ts_all[te] % (st * STEP) == 0)]
            te = te[np.isfinite(P.depth[te])]
            if len(te) == 0:
                continue
            cH, _ = P6.har_coef(qs)
            sH = P6.sigma_H(cH)
            zH, vH = P6.z_of(sH)
            with np.errstate(invalid="ignore", divide="ignore"):
                thrH = lnk[None, :] / (sH[te][:, None] * P.scale)
                thrf = lnk[None, :] / (ser.sigma[te][:, None] * P.scale)
            pf_ = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], thrf)
            pH = M2.fhs_predict(zH[vH & tr], thrH)
            fb = ~np.all(np.isfinite(pH), axis=1)
            pH[fb] = pf_[fb]
            keep = np.all(np.isfinite(pH), axis=1) & np.all(np.isfinite(pf_), axis=1)
            te, pH = te[keep], pH[keep]
            if len(te) == 0:
                continue
            dtr = P.depth[tr & P.lab_ok]
            dtr = np.sort(dtr[np.isfinite(dtr)])
            pa = np.stack([np.searchsorted(dtr, lk, side="right") / max(len(dtr), 1)
                           for lk in lnk])[None, :].repeat(len(te), 0)
            out["a"].append(np.minimum.accumulate(pa, axis=1).astype(np.float32))
            out["fH"].append(np.minimum.accumulate(np.asarray(pH, float), axis=1).astype(np.float32))
            ts = ts_all[te]
            out["ts"].append(ts)
            out["y"].append((P.depth[te][:, None] <= lnk[None, :]).astype(np.int8))
            out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
            out["tail"].append(ts + T * STEP > caps["primary"])
        if not out["ts"]:
            continue
        R = {k_: np.concatenate(v) for k_, v in out.items()}
        m = ~R["q2"] & ~R["tail"]
        rows[T] = {k_: v[m] for k_, v in R.items() if k_ not in ("q2", "tail")}
    return {"key": spec["key"], "rows": rows, "pegged": pegged, "sec": time.time() - t0}


def cmd_blindrows(a):
    import r16_nn_strict as S
    os.makedirs(a.out, exist_ok=True)
    meta = {"code": git_sha(), "started_utc": now(), "sets": {}, "levels": LG, "Ts": TS}
    for name in a.sets.split(","):
        specs = set_specs(name, a.datasets)
        keys = [s_["key"] for s_ in specs]
        print(now(), f"START {name}: {len(specs)} specs; code {git_sha()}", flush=True)
        acc = {T: [] for T in TS}
        flags = {}
        t0 = time.time()
        with mp.get_context("fork").Pool(a.workers, maxtasksperchild=8) as pool:
            for j, r in enumerate(pool.imap_unordered(blind_task, specs, chunksize=1)):
                sym = S.symbol_of(r["key"]).split("#")[0]
                why = []
                if S.EXCL_PAT.search(sym if sym.endswith("USDT") else sym + "USDT"):
                    why.append("pattern")
                if r["pegged"]:
                    why.append("pegged-like")
                if why:
                    flags[r["key"]] = why
                    continue
                sid = keys.index(r["key"])
                for T, R in r["rows"].items():
                    R["sid"] = np.full(len(R["ts"]), sid, np.int32)
                    acc[T].append(R)
                if (j + 1) % 50 == 0 or j + 1 == len(specs):
                    print(now(), f"  {name} {j + 1}/{len(specs)} ({time.time() - t0:.0f}s)", flush=True)
        for T in TS:
            if not acc[T]:
                continue
            out = {k_: np.concatenate([R[k_] for R in acc[T]]) for k_ in acc[T][0]}
            np.savez_compressed(os.path.join(a.out, f"blind-{name}-T{T}.npz"), **out)
        meta["sets"][name] = {"specs": len(specs), "keys": keys, "excluded": flags}
        json.dump(meta, open(os.path.join(a.out, "blindrows-meta.json"), "w"), indent=1)
    meta["finished_utc"] = now()
    json.dump(meta, open(os.path.join(a.out, "blindrows-meta.json"), "w"), indent=1)



# =====================================================================================================================
# loading graded rows
# =====================================================================================================================
def lvcols(T, src_levels):
    return [list(src_levels).index(k) for k in GRID[T]]


def load_dev(a, T, extra=()):
    """development rows for T at GRID[T] levels; P1:KRAKEN-ETH and blind8:JUPUSDT excluded."""
    keys = json.load(open(os.path.join(a.r162, "rows-meta.json")))["series"]
    if T in (6, 12, 24, 72, 168):
        z = np.load(os.path.join(a.r192, f"rowsB-T{T}.npz"))
        src = L8
    else:
        z = np.load(os.path.join(a.r162, f"rows-T{T}.npz"))
        src = LV162[T]
    cols = lvcols(T, src)
    sid = z["sid"]
    bad = np.array([keys.index(k) for k in EXCL_KEYS])
    m = ~np.isin(sid, bad)
    R = {"ts": z["ts"][m], "sid": sid[m], "y": z["y"][m][:, cols], "fH": z["fH"][m][:, cols].astype(np.float64),
         "a": z["a"][m][:, cols].astype(np.float64)}
    for k_ in extra:
        R[k_] = z[k_][m]
    R["keys"] = keys
    R["grp"] = np.array([group_of(k) for k in keys])[R["sid"]]
    return R


def load_blind(out, T):
    meta = json.load(open(os.path.join(out, "blindrows", "blindrows-meta.json")))
    parts, keys, off = [], [], 0
    for name in SETS:
        p = os.path.join(out, "blindrows", f"blind-{name}-T{T}.npz")
        if name not in meta["sets"] or not os.path.exists(p):
            continue
        z = np.load(p)
        cols = [LG.index(k) for k in GRID[T]]
        parts.append({"ts": z["ts"], "sid": z["sid"] + off, "y": z["y"][:, cols],
                      "fH": z["fH"][:, cols].astype(np.float64), "a": z["a"][:, cols].astype(np.float64)})
        keys += meta["sets"][name]["keys"]
        off = len(keys)
    R = {k_: np.concatenate([P[k_] for P in parts]) for k_ in ("ts", "sid", "y", "fH", "a")}
    R["keys"] = keys
    R["grp"] = np.full(len(R["ts"]), "alt")
    return R


# =====================================================================================================================
# cell statistics with the two-way pigeonhole bootstrap (series x time block); btc_eth: time block only
# =====================================================================================================================
def lgt(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def block_of(ts, T):
    L = (56 if T == 720 else 28) * DAY
    return (ts // L).astype(np.int64)


def boot_weights(sid, blk, time_only, B, seed):
    """per-row-cluster (pair) weights for B draws: w = n_s(series) * n_b(block) (pigeonhole)."""
    us, si = np.unique(sid, return_inverse=True)
    ub, bi = np.unique(blk, return_inverse=True)
    pair = si.astype(np.int64) * len(ub) + bi
    up, pi = np.unique(pair, return_inverse=True)
    ps, pb = up // len(ub), up % len(ub)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed]))
    Wb = rng.multinomial(len(ub), np.full(len(ub), 1.0 / len(ub)), size=B).astype(np.float64)
    if time_only:
        Ws = np.ones((B, len(us)))
    else:
        Ws = rng.multinomial(len(us), np.full(len(us), 1.0 / len(us)), size=B).astype(np.float64)
    W = Ws[:, ps] * Wb[:, pb]                 # (B, pairs)
    return pi, len(up), W


def logit_fit(n, sy, x, iters=40):
    """weighted logistic y ~ a + b x on bins (rows of arrays are draws), damped Newton from (a, b) = (0, 1)."""
    n, sy, x = np.atleast_2d(n), np.atleast_2d(sy), np.atleast_2d(x)
    a_ = np.zeros(n.shape[0])
    b_ = np.ones(n.shape[0])
    for _ in range(iters):
        eta = np.clip(a_[:, None] + b_[:, None] * x, -35, 35)
        mu = 1 / (1 + np.exp(-eta))
        w = n * mu * (1 - mu)
        r = sy - n * mu
        g0, g1 = r.sum(1), (r * x).sum(1)
        h00, h01, h11 = w.sum(1), (w * x).sum(1), (w * x * x).sum(1)
        det = h00 * h11 - h01 ** 2
        det = np.where(np.abs(det) < 1e-12, np.nan, det)
        da = (h11 * g0 - h01 * g1) / det
        db = (-h01 * g0 + h00 * g1) / det
        sc = np.minimum(1.0, 2.0 / np.maximum(np.abs(db), 1e-12))
        a_, b_ = a_ + sc * da, b_ + sc * db
    return b_, a_


def cell_stats(p, pa, y, sid, blk, time_only, B=B_BOOT, seed=0, extra=None):
    """R, slope, BSS vs (a), BSS vs (e), AUC with percentile 95% intervals. extra: {name: p2} -> Brier/AUC/R/slope of
    p2 and the paired Brier change p2 - p (for the recalibration validation)."""
    from scipy import sparse
    y = y.astype(np.float64)
    n_rows, pos = len(y), int(y.sum())
    out = {"rows": int(n_rows), "pos": pos, "series": int(len(np.unique(sid))),
           "blocks": int(len(np.unique(blk))), "pos_blocks": int(len(np.unique(blk[y > 0])))}
    if pos < 2 or pos == n_rows:
        out["estimable"] = False
        return out
    pi, P, W = boot_weights(sid, blk, time_only, B, seed)
    one = np.ones(n_rows)

    def agg(v):
        return np.bincount(pi, v, P)
    base = {"n": agg(one), "sy": agg(y)}

    def forecast_parts(q):
        x = lgt(q)
        qx = np.unique(np.quantile(x, np.linspace(0, 1, NBIN_X + 1)))
        bx = np.clip(np.searchsorted(qx, x, side="right") - 1, 0, max(len(qx) - 2, 0))
        nbx = max(len(qx) - 1, 1)
        qp = np.unique(np.quantile(q, np.linspace(0, 1, NBIN_P + 1)))
        bp = np.clip(np.searchsorted(qp, q, side="right") - 1, 0, max(len(qp) - 2, 0))
        nbp = max(len(qp) - 1, 1)

        def mat(bins, nb, v):
            return sparse.csr_matrix((v, (pi, bins)), shape=(P, nb))
        return {"sp": agg(q), "se": agg((q - y) ** 2),
                "Mn": mat(bx, nbx, one), "My": mat(bx, nbx, y), "Mx": mat(bx, nbx, x),
                "Pp": mat(bp, nbp, y), "Pn": mat(bp, nbp, 1 - y)}

    def stats_from(Wr, fp, sea, base_):
        """Wr: (D, P) weights (D draws, or one row of ones for the point estimate)."""
        n = Wr @ base_["n"]
        sy = Wr @ base_["sy"]
        sp, se = Wr @ fp["sp"], Wr @ fp["se"]
        bn = np.asarray((fp["Mn"].T @ Wr.T).T)
        by = np.asarray((fp["My"].T @ Wr.T).T)
        bxs = np.asarray((fp["Mx"].T @ Wr.T).T)
        with np.errstate(invalid="ignore", divide="ignore"):
            xb = np.where(bn > 0, bxs / np.maximum(bn, 1e-12), 0.0)
        slope, icpt = logit_fit(bn, by, xb)
        pp = np.asarray((fp["Pp"].T @ Wr.T).T)
        pn = np.asarray((fp["Pn"].T @ Wr.T).T)
        cn = np.cumsum(pn, 1) - pn
        with np.errstate(invalid="ignore", divide="ignore"):
            auc = (pp * cn + 0.5 * pp * pn).sum(1) / (pp.sum(1) * pn.sum(1))
            r = sp / sy
            bss_a = 1 - se / sea if sea is not None else None
            bss_e = 1 - se / (sy - sy ** 2 / n)
        d = {"R": r, "slope": slope, "auc": auc, "bss_e": bss_e, "brier": se / n}
        if sea is not None:
            d["bss_a"] = bss_a
        return d
    fp = forecast_parts(p)
    fa = agg((pa - y) ** 2)
    one_w = np.ones((1, P))
    pt = stats_from(one_w, fp, one_w @ fa, base)
    bt = {k_: [] for k_ in pt}
    ext = {}
    if extra:
        fx = {nm: forecast_parts(q) for nm, q in extra.items()}
        ptx = {nm: stats_from(one_w, f_, None, base) for nm, f_ in fx.items()}
        btx = {nm: {k_: [] for k_ in ptx[nm]} | {"dbrier_rel": []} for nm in fx}
    for c0 in range(0, B, 100):
        Wr = W[c0:c0 + 100]
        s_ = stats_from(Wr, fp, Wr @ fa, base)
        for k_ in bt:
            bt[k_].append(s_[k_])
        if extra:
            for nm, f_ in fx.items():
                s2 = stats_from(Wr, f_, None, base)
                for k_ in s2:
                    btx[nm][k_].append(s2[k_])
                btx[nm]["dbrier_rel"].append(s2["brier"] / s_["brier"] - 1)

    def summ(ptv, arr):
        arr = np.concatenate(arr)
        arr = arr[np.isfinite(arr)]
        lo, hi = (np.quantile(arr, [0.025, 0.975]) if len(arr) > 0.9 * B else (np.nan, np.nan))
        return [float(ptv), float(lo), float(hi)]
    for k_ in pt:
        out[k_] = summ(pt[k_][0], bt[k_])
    out["estimable"] = bool(all(np.isfinite(out[k_][0]) for k_ in ("R", "slope", "auc", "bss_a", "bss_e")))
    if extra:
        for nm in fx:
            e = {k_: summ(ptx[nm][k_][0], btx[nm][k_]) for k_ in ptx[nm]}
            e["dbrier_rel"] = summ(ptx[nm]["brier"][0] / pt["brier"][0] - 1, btx[nm]["dbrier_rel"])
            ext[nm] = e
        out["extra"] = ext
    return out


def classify(st):
    """R19.3d class rule."""
    if not st.get("estimable") or st["pos"] < MIN_POS:
        return "HISTORY COUNT"
    if not (st["bss_a"][1] > 0 and st["bss_e"][1] > 0):
        return "DO NOT SHOW"
    if R_BAND[0] <= st["R"][0] <= R_BAND[1] and st["slope"][1] <= 1 <= st["slope"][2]:
        return "CALIBRATED-WARN"
    return "RECALIBRATE"


def classify_lenient(st):
    if not st.get("estimable") or st["pos"] < MIN_POS:
        return "HISTORY COUNT"
    if not (st["bss_a"][1] > 0 and st["bss_e"][1] > 0):
        return "DO NOT SHOW"
    if st["R"][1] <= R_BAND[1] and st["R"][2] >= R_BAND[0] and st["slope"][1] <= 1 <= st["slope"][2]:
        return "CALIBRATED-WARN"
    return "RECALIBRATE"


def cmd_grade(a):
    os.makedirs(a.out, exist_ok=True)
    res = {"schema": "q26-r19.3/grade/1", "label": "DEVELOPMENT AND SPENT SETS ONLY", "code": git_sha(),
           "started_utc": now(), "B": B_BOOT, "seed": SEED, "cells": {}}
    seed = 0
    for T in TS:
        for src in ("dev", "blind"):
            if src == "blind":
                if not os.path.exists(os.path.join(a.out, "blindrows", "blindrows-meta.json")):
                    continue
                R = load_blind(a.out, T)
            else:
                R = load_dev(a, T)
            blk = block_of(R["ts"], T)
            for g in (("alt",) if src == "blind" else ("alt", "large", "btc_eth")):
                m = R["grp"] == g
                for j, k in enumerate(GRID[T]):
                    seed += 1
                    st = cell_stats(R["fH"][m, j], R["a"][m, j], R["y"][m, j], R["sid"][m], blk[m], g == "btc_eth",
                                    seed=seed)
                    if g == "btc_eth":
                        for nm in ("dev:ETH", "dev:BTC"):
                            mm = m & (R["sid"] == R["keys"].index(nm))
                            s1 = cell_stats(R["fH"][mm, j], R["a"][mm, j], R["y"][mm, j], R["sid"][mm], blk[mm],
                                            True, B=300, seed=seed + 100000)
                            st[nm] = {k_: s1.get(k_) for k_ in ("pos", "R", "slope", "bss_a", "bss_e", "auc")}
                    st["class"] = classify(st)
                    st["class_lenient"] = classify_lenient(st)
                    key = f"{src}|{g}|{TL[T]}|{int(round(k * 100))}"
                    res["cells"][key] = st
                    print(now(), key, st["pos"], st["class"],
                          *(f"{n_}={st[n_][0]:.3f}[{st[n_][1]:.3f},{st[n_][2]:.3f}]" for n_ in
                            ("R", "slope", "bss_a", "bss_e", "auc") if n_ in st), flush=True)
            del R
        json.dump(res, open(os.path.join(a.out, "grade-r193.json"), "w"), indent=1)
    # young-listing supplement: development altcoin rows with series age 85-364 days at the origin (r162 'age')
    for T in (24, 72):
        z = np.load(os.path.join(a.r162, f"rows-T{T}.npz"))
        keys = json.load(open(os.path.join(a.r162, "rows-meta.json")))["series"]
        grp = np.array([group_of(k) for k in keys])[z["sid"]]
        age = z["age"]
        res.setdefault("young_age_units", {"min": float(np.nanmin(age)), "max": float(np.nanmax(age))})
        lv = {24: (-0.05, -0.07, -0.10, -0.15), 72: (-0.05, -0.10, -0.15, -0.20)}[T]
        m = (grp == "alt") & np.isfinite(age)
        res["young_age_note"] = "age column of R16.2 rows (r16_dev FEATS 'age'); unit checked in the output"
        blk = block_of(z["ts"], T)
        for j, k in enumerate(lv):
            for lo_, hi_ in (("85", "364"),):
                mm = m & (age >= float(lo_)) & (age <= float(hi_))
                seed += 1
                st = cell_stats(z["fH"][mm, j].astype(float), z["a"][mm, j].astype(float), z["y"][mm, j],
                                z["sid"][mm], blk[mm], False, seed=seed)
                st["class"] = classify(st)
                st["class_lenient"] = classify_lenient(st)
                key = f"dev-young{lo_}-{hi_}|alt|{TL[T]}|{int(round(k * 100))}"
                res["cells"][key] = st
                print(now(), key, st["pos"], st["class"], flush=True)
    res["finished_utc"] = now()
    json.dump(res, open(os.path.join(a.out, "grade-r193.json"), "w"), indent=1)


# =====================================================================================================================
# recalibration candidates (R19.3e) with walk-forward series x calendar-year validation (R19.3f)
# =====================================================================================================================
XB = np.linspace(-14, 14, 281)                      # fixed logit bins (width 0.1) for pooled sufficient statistics


def year_start(Y):
    return int(dt.datetime(Y, 1, 1, tzinfo=dt.timezone.utc).timestamp())


def res_year(ts, T):
    """calendar year of the label resolution time ts + T (a row trains a fold for year Y iff res_year < Y)."""
    t = ts + T * STEP - 1
    return np.array([dt.datetime.fromtimestamp(int(v), dt.timezone.utc).year for v in np.unique(t // DAY) * DAY]
                    )[np.searchsorted(np.unique(t // DAY), t // DAY)]


def ser_group(keys, grp_name, sid):
    """fold group per row: altcoins 4 hash groups; majors leave-one-series-out."""
    hg = np.array([hashlib.sha256(("Q26-R193:" + k).encode()).digest()[0] % 4 for k in keys])
    return np.where(grp_name == "alt", hg[sid], 100 + sid)


def pav(v, w):
    from scipy.optimize import isotonic_regression
    return isotonic_regression(v, weights=w).x


def fit_c1(n, sy, sx):
    ok = n > 0
    if n.sum() < RECAL_MIN_ROWS or sy.sum() < RECAL_MIN_POS:
        return None
    b, a_ = logit_fit(n[ok][None], sy[ok][None], (sx[ok] / n[ok])[None])
    if not (np.isfinite(b[0]) and np.isfinite(a_[0])):
        return None
    return float(a_[0]), float(b[0])


def fit_c2(n, sy, sx):
    ok = n > 0
    if n.sum() < RECAL_MIN_ROWS or sy.sum() < RECAL_MIN_POS:
        return None
    xm = sx[ok] / n[ok]
    iso = pav(sy[ok] / n[ok], n[ok].astype(float))
    return xm, np.clip(iso, PCLIP, 1 - PCLIP)


def apply_c1(par, x):
    a_, b = par
    return 1 / (1 + np.exp(-np.clip(a_ + b * x, -35, 35)))


def apply_c2(par, x):
    xm, iso = par
    return np.interp(x, xm, iso)


def level_term(ts, sid, p1, y, T, rows_mask):
    """R13.1 subject level a_s(t) = ln((sum y + kappa) / (sum p1 + kappa)) over the same series' rows with
    t' + T <= t and t' >= t - W days; computed for rows in rows_mask (y of rows with t' + T <= t are resolved)."""
    out = np.zeros(len(ts))
    o = np.lexsort((ts, sid))
    so = sid[o]
    brk = np.flatnonzero(np.diff(so)) + 1
    for s0, e0 in zip(np.r_[0, brk], np.r_[brk, len(o)]):
        idx = o[s0:e0]
        if not rows_mask[idx].any():
            continue
        t = ts[idx]
        csy = np.r_[0.0, np.cumsum(y[idx].astype(float))]
        csp = np.r_[0.0, np.cumsum(p1[idx])]
        hi = np.searchsorted(t + T * STEP, t, side="right")
        lo = np.minimum(np.searchsorted(t, t - W_C3 * DAY, side="left"), hi)
        out[idx] = np.log((csy[hi] - csy[lo] + KAPPA_C3) / (csp[hi] - csp[lo] + KAPPA_C3))
    return out


def recal_cv(R, T, pool_mask, test_mask, grp_name):
    """walk-forward predictions of C1/C2/C3 for rows in test_mask, fitted on pool rows (other fold groups, labels
    resolved before 1 January of the test year). Returns preds {C: (n, L)} and active (n, L)."""
    n, L = R["y"].shape
    x = lgt(R["fH"])
    bx = np.clip(np.searchsorted(XB, x, side="right") - 1, 0, len(XB) - 2)
    fg = ser_group(R["keys"], grp_name, R["sid"])
    ry = res_year(R["ts"], T)
    ty = np.array([dt.datetime.fromtimestamp(int(v), dt.timezone.utc).year
                   for v in np.unique(R["ts"] // DAY) * DAY])[np.searchsorted(np.unique(R["ts"] // DAY), R["ts"] // DAY)]
    years = np.unique(ty[test_mask])
    gl = np.unique(fg[test_mask])
    preds = {c: R["fH"].copy() for c in ("C1", "C2", "C3")}
    active = np.zeros((n, L), bool)
    # pooled sufficient statistics per (fold group, resolution year, level, bin)
    ug, gi = np.unique(fg[pool_mask], return_inverse=True)
    uy = np.arange(2015, 2028)
    yi = np.clip(ry[pool_mask] - 2015, 0, len(uy) - 1)
    NB = len(XB) - 1
    stats = {}
    for j in range(L):
        key = (gi * len(uy) + yi) * NB + bx[pool_mask, j]
        size = len(ug) * len(uy) * NB
        stats[j] = [np.bincount(key, w, size).reshape(len(ug), len(uy), NB) for w in
                    (np.ones(pool_mask.sum()), R["y"][pool_mask, j].astype(float), x[pool_mask, j])]
    for Y in years:
        yidx = Y - 2015
        for g in gl:
            te = test_mask & (fg == g) & (ty == Y)
            if not te.any():
                continue
            keep_g = ug != g
            # rows of the test series needed by the C3 level term (own resolved history within W days)
            for j in range(L):
                sN, sY, sX = (st_[keep_g][:, :yidx].sum((0, 1)) for st_ in stats[j])
                p1 = fit_c1(sN, sY, sX)
                p2 = fit_c2(sN, sY, sX)
                if p1 is None or p2 is None:
                    continue
                active[te, j] = True
                preds["C1"][te, j] = apply_c1(p1, x[te, j])
                preds["C2"][te, j] = apply_c2(p2, x[te, j])
                ctx = (fg == g) & (R["ts"] >= year_start(Y) - (W_C3 + T // 24 + 2) * DAY) & (ty <= Y)
                pc = apply_c1(p1, x[ctx, j])
                lt = level_term(R["ts"][ctx], R["sid"][ctx], pc, R["y"][ctx, j], T, te[ctx])
                pc3 = 1 / (1 + np.exp(-np.clip(lgt(pc) + lt, -35, 35)))
                preds["C3"][ctx & te, j] = pc3[te[ctx]]
    for c in preds:
        preds[c] = np.clip(np.minimum.accumulate(preds[c], axis=1), PCLIP, 1 - PCLIP)
    return preds, active


def load_alt_all(a, T):
    """altcoin rows of the development pool plus the spent-blind pool (D-R19.3a), one key list, src flag."""
    Rd = load_dev(a, T)
    m = Rd["grp"] == "alt"
    Rb = load_blind(a.out, T)
    off = len(Rd["keys"])
    R = {k_: np.concatenate([Rd[k_][m], Rb[k_] + (off if k_ == "sid" else 0)]) for k_ in ("ts", "sid", "y", "fH", "a")}
    R["keys"] = Rd["keys"] + Rb["keys"]
    R["grp"] = np.full(len(R["ts"]), "alt")
    R["src"] = np.r_[np.zeros(m.sum(), np.int8), np.ones(len(Rb["ts"]), np.int8)]
    return R


def eval_cell(R, m, j, preds, blk, time_only, seed, cls):
    st = cell_stats(R["fH"][m, j], R["a"][m, j], R["y"][m, j], R["sid"][m], blk[m], time_only, seed=seed,
                    extra={c: preds[c][m, j] for c in preds})
    st["active_rows"] = int(m.sum())
    st["grade_class"] = cls
    st["repairs"] = {c: bool(R_BAND[0] <= e["R"][0] <= R_BAND[1] and e["slope"][1] <= 1 <= e["slope"][2]
                             and e["dbrier_rel"][0] < 0 and st["auc"][0] - e["auc"][0] <= 0.005)
                     for c, e in st["extra"].items()}
    return st


def show(key, st):
    print(now(), key, st["grade_class"], "raw R %.3f sl %.3f" % (st["R"][0], st["slope"][0]),
          *("%s R %.3f sl %.3f[%.2f,%.2f] dB %+.4f dAUC %+.4f %s" % (
              c, e["R"][0], e["slope"][0], e["slope"][1], e["slope"][2], e["dbrier_rel"][0],
              e["auc"][0] - st["auc"][0], "REP" if st["repairs"][c] else "-") for c, e in st["extra"].items()),
          flush=True)


def cmd_recal(a):
    """walk-forward validation of C1/C2/C3 (R19.3f as amended by D-R19.3a); selection on RECALIBRATE cells."""
    grade = json.load(open(os.path.join(a.out, "grade-r193.json")))["cells"]
    res = {"schema": "q26-r19.3/recal/1", "label": "DEVELOPMENT AND SPENT SETS ONLY", "code": git_sha(),
           "started_utc": now(), "cells": {}}
    seed = 500000
    for T in TS:
        # altcoins: pooled dev + spent-blind training; scored on spent-blind (primary) and dev (reported)
        R = load_alt_all(a, T)
        blk = block_of(R["ts"], T)
        allm = np.ones(len(R["ts"]), bool)
        preds, active = recal_cv(R, T, allm, allm, "alt")
        for j, k in enumerate(GRID[T]):
            for src, sflag in (("blind", 1), ("dev", 0)):
                key = f"{src}|alt|{TL[T]}|{int(round(k * 100))}"
                m = (R["src"] == sflag) & active[:, j]
                seed += 1
                if m.sum() == 0 or R["y"][m, j].sum() < 2:
                    res["cells"][key] = {"active_rows": int(m.sum()), "estimable": False}
                    continue
                st = eval_cell(R, m, j, preds, blk, False, seed, grade.get(key, {}).get("class"))
                res["cells"][key] = st
                show(key, st)
        del R, preds, active
        # majors: development, leave-one-series-out on the pooled majors
        R = load_dev(a, T)
        blk = block_of(R["ts"], T)
        pool = np.isin(R["grp"], ("large", "btc_eth"))
        preds, active = recal_cv(R, T, pool, pool, "maj")
        for g in ("large", "btc_eth"):
            for j, k in enumerate(GRID[T]):
                key = f"dev|{g}|{TL[T]}|{int(round(k * 100))}"
                m = (R["grp"] == g) & active[:, j]
                seed += 1
                if m.sum() == 0 or R["y"][m, j].sum() < 2:
                    res["cells"][key] = {"active_rows": int(m.sum()), "estimable": False}
                    continue
                st = eval_cell(R, m, j, preds, blk, g == "btc_eth", seed, grade.get(key, {}).get("class"))
                res["cells"][key] = st
                show(key, st)
        del R, preds, active
        json.dump(res, open(os.path.join(a.out, "recal-r193.json"), "w"), indent=1)
    # selection (R19.3g): RECALIBRATE cells of the primary source (spent-blind for altcoins, dev for majors)
    prim = [k for k in res["cells"] if not k.startswith("dev|alt")]
    rc = [k for k in prim if res["cells"][k].get("grade_class") == "RECALIBRATE" and "repairs" in res["cells"][k]]
    sel = {}
    for c in ("C1", "C2", "C3"):
        sel[c] = {"repairs": int(sum(res["cells"][k]["repairs"][c] for k in rc)),
                  "mean_rel_brier_change": float(np.mean([res["cells"][k]["extra"][c]["dbrier_rel"][0] for k in rc]))
                  if rc else None}
    order = {"C1": 0, "C3": 1, "C2": 2}
    pick = sorted(sel, key=lambda c: (-sel[c]["repairs"], sel[c]["mean_rel_brier_change"] or 0, order[c]))[0] \
        if rc else None
    res["selection"] = {"recalibrate_cells": rc, "by_candidate": sel, "pick": pick,
                        "repaired_by_pick": [k for k in rc if pick and res["cells"][k]["repairs"][pick]]}
    res["finished_utc"] = now()
    json.dump(res, open(os.path.join(a.out, "recal-r193.json"), "w"), indent=1)
    print(json.dumps(res["selection"], indent=1))


def fit_all(R, mask, j, cand):
    x = lgt(R["fH"][mask, j])
    bx = np.clip(np.searchsorted(XB, x, side="right") - 1, 0, len(XB) - 2)
    NB = len(XB) - 1
    n = np.bincount(bx, None, NB).astype(float)
    sy = np.bincount(bx, R["y"][mask, j].astype(float), NB)
    sx = np.bincount(bx, x, NB)
    c1 = fit_c1(n, sy, sx)
    out = {"rows": int(mask.sum()), "pos": int(sy.sum())}
    if cand in ("C1", "C3"):
        out["a"], out["b"] = (c1 if c1 else (None, None))
    if cand == "C2":
        c2 = fit_c2(n, sy, sx)
        out["xm"], out["iso"] = ([float(v) for v in c2[0]], [float(v) for v in c2[1]]) if c2 else (None, None)
    return out


def apply_frozen(R, mask, T, params, cand):
    """frozen map on rows in mask, all GRID[T] levels; running minimum over levels; C3 adds the subject level."""
    P = R["fH"][mask].copy()
    for j, k in enumerate(GRID[T]):
        q = params.get(str(int(round(k * 100))))
        if not q or (cand != "C2" and q.get("a") is None) or (cand == "C2" and q.get("xm") is None):
            continue
        x = lgt(R["fH"][mask, j])
        if cand == "C2":
            P[:, j] = apply_c2((np.array(q["xm"]), np.array(q["iso"])), x)
        else:
            p1 = apply_c1((q["a"], q["b"]), x)
            if cand == "C3":
                lt = level_term(R["ts"][mask], R["sid"][mask], p1, R["y"][mask, j], T, np.ones(mask.sum(), bool))
                p1 = 1 / (1 + np.exp(-np.clip(lgt(p1) + lt, -35, 35)))
            P[:, j] = p1
    return np.clip(np.minimum.accumulate(P, axis=1), PCLIP, 1 - PCLIP)


def cmd_freeze(a):
    rec = json.load(open(os.path.join(a.out, "recal-r193.json")))
    cand = a.cand or rec["selection"]["pick"]
    fr = {"schema": "q26-r19.3/frozen-recal/1", "label": "fitted on development and spent rows (D-R19.3a)",
          "candidate": cand, "code": git_sha(), "created_utc": now(), "W_days": W_C3, "kappa": KAPPA_C3,
          "pclip": PCLIP, "applies_to_cells": rec["selection"]["repaired_by_pick"],
          "pools": {"alt": "development altcoins + spent-blind B12/B13a/B15a/B15b/B20a",
                    "majors": "development large caps (A2/A3) + dev:ETH + dev:BTC; serves large and btc_eth"},
          "maps": {}, "inputs_sha256": {}}
    for T in TS:
        R = load_alt_all(a, T)
        fr["maps"].setdefault("alt", {})[TL[T]] = {str(int(round(k * 100))): fit_all(R, np.ones(len(R["ts"]), bool),
                                                                                       j, cand)
                                                    for j, k in enumerate(GRID[T])}
        del R
        R = load_dev(a, T)
        pool = np.isin(R["grp"], ("large", "btc_eth"))
        fr["maps"].setdefault("majors", {})[TL[T]] = {str(int(round(k * 100))): fit_all(R, pool, j, cand)
                                                       for j, k in enumerate(GRID[T])}
        del R
        src = os.path.join(a.r192, f"rowsB-T{T}.npz") if T in (6, 12, 24, 72, 168) else \
            os.path.join(a.r162, f"rows-T{T}.npz")
        fr["inputs_sha256"][os.path.basename(os.path.dirname(src)) + "/" + os.path.basename(src)] = sha_file(src)
        for name in SETS:
            pb = os.path.join(a.out, "blindrows", f"blind-{name}-T{T}.npz")
            if os.path.exists(pb):
                fr["inputs_sha256"]["blindrows/" + os.path.basename(pb)] = sha_file(pb)
        print(now(), "froze", TL[T], flush=True)
    fr["inputs_sha256"]["recal-r193.json"] = sha_file(os.path.join(a.out, "recal-r193.json"))
    fr["inputs_sha256"]["grade-r193.json"] = sha_file(os.path.join(a.out, "grade-r193.json"))
    fr["code_sha256"] = sha_file(os.path.abspath(__file__))
    p = os.path.join(a.out, "frozen-r193-recal.json")
    json.dump(fr, open(p, "w"), indent=1)
    print("frozen", p, sha_file(p))


def cmd_transfer(a):
    """D-R19.3a item 4: the picked candidate refitted on development altcoin rows only, applied once to the
    spent-blind rows; and the frozen map's in-sample view for majors is not a test (not run)."""
    rec = json.load(open(os.path.join(a.out, "recal-r193.json")))
    cand = rec["selection"]["pick"]
    rep = set(rec["selection"]["repaired_by_pick"])
    out = {"schema": "q26-r19.3/transfer/1", "label": "fit: development altcoins only; test: spent-blind altcoins",
           "candidate": cand, "code": git_sha(), "started_utc": now(), "cells": {}}
    seed = 900000
    for T in TS:
        R = load_alt_all(a, T)
        dev = R["src"] == 0
        params = {str(int(round(k * 100))): fit_all(R, dev, j, cand) for j, k in enumerate(GRID[T])}
        bl = R["src"] == 1
        P = apply_frozen(R, bl, T, params, cand)
        blk = block_of(R["ts"][bl], T)
        for j, k in enumerate(GRID[T]):
            key = f"blind|alt|{TL[T]}|{int(round(k * 100))}"
            seed += 1
            st = cell_stats(R["fH"][bl, j], R["a"][bl, j], R["y"][bl, j], R["sid"][bl], blk, False, seed=seed,
                            extra={cand: P[:, j]})
            e = st["extra"][cand]
            st["repaired_in_cv"] = key in rep
            st["transfer_repairs"] = bool(R_BAND[0] <= e["R"][0] <= R_BAND[1] and e["slope"][1] <= 1 <= e["slope"][2]
                                          and e["dbrier_rel"][0] < 0 and st["auc"][0] - e["auc"][0] <= 0.005)
            out["cells"][key] = st
            print(now(), key, "cv-rep" if key in rep else "-", "raw R %.3f sl %.3f" % (st["R"][0], st["slope"][0]),
                  "%s R %.3f sl %.3f[%.2f,%.2f] dB %+.4f[%+.4f,%+.4f] dAUC %+.4f %s" % (
                      cand, e["R"][0], e["slope"][0], e["slope"][1], e["slope"][2], e["dbrier_rel"][0],
                      e["dbrier_rel"][1], e["dbrier_rel"][2], e["auc"][0] - st["auc"][0],
                      "REP" if st["transfer_repairs"] else "-"), flush=True)
        del R, P
        json.dump(out, open(os.path.join(a.out, "transfer-r193.json"), "w"), indent=1)
    out["finished_utc"] = now()
    json.dump(out, open(os.path.join(a.out, "transfer-r193.json"), "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--r162")
    ap.add_argument("--r192")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--sets", default=",".join(SETS))
    ap.add_argument("--cand")
    a = ap.parse_args()
    {"blindrows": cmd_blindrows, "grade": cmd_grade, "recal": cmd_recal, "freeze": cmd_freeze,
     "transfer": cmd_transfer}[a.cmd](a)


if __name__ == "__main__":
    main()
