"""Q26 Round 14: R14.1 dense-threshold distribution-regression (DR) correction of (fH) for the deep band.

membrane-board design/Q26_ROUND14_PREREG.md (R14.1, D-R14.1a ...), design/q26-ml-levers-deepen-2026-10-18.md (R14.1
draft), design/q26-blind-set-inventory-2026-10-17.md (B15b confirm; B18 reserve).

Commands
  select-b18   Poloniex USDT spot pairs on no used venue list; listing = the market's tradableStartTime from the
               public markets list (no candle is read). Reserve set for a revised R14.1 model.
  dev          development on SEEN data only (R12 development pool, B9 6-hourly; B12, B13a hourly check sets with
               leave-one-set-out maps): DR maps per menu entry, comparators, per-week sums for J, cell statistics.
  select       menu choice by J (one-SE rule, weekly bootstrap) and cell types from the development (fH) R.
  acquire-b15b outcome-blind B15b builder (MEXC 60m klines, sha256 per raw page). Prints hour counts only.
  counts       counts only on B15b (validated origins, positive origins, positive crash-episode blocks per cell).
  power        projected power of the chosen entry at the B15b counts from the development effects.
  freeze       frozen config (code sha, input sha256 values, maps, constants, seed, created_utc).
  run          one run on B15b from the frozen config.

No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import concurrent.futures as cf  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.special import expit  # noqa: E402
from scipy.stats import norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a2_touch as M2  # noqa: E402
import a6_touch as A6  # noqa: E402
import a_touch as A  # noqa: E402
import r112_combine as R112  # noqa: E402
import r125_fh_deep as R125  # noqa: E402
import r12_tail as R12  # noqa: E402
import r13_recal as R13  # noqa: E402

STEP = R12.STEP
DAY = 86400
TL = R12.TL
LEVELS = R12.LEVELS
KIX = {k: j for j, k in enumerate(LEVELS)}
HS = (12, 24, 72)
GRID = (-0.01, -0.015, -0.02, -0.03, -0.04, -0.05, -0.07, -0.085, -0.10, -0.125, -0.15, -0.175, -0.20, -0.25,
        -0.30, -0.35, -0.40)
LNG = np.log1p(np.array(GRID))
U = np.log(-LNG) - np.log(0.1)
DGRID = [j for j, k in enumerate(GRID) if k <= -0.15]                      # deep subgrid D (7 thresholds)
DLEV = (-0.15, -0.20, -0.25, -0.30, -0.40)
DPOS = [DGRID.index(GRID.index(k)) for k in DLEV]                            # scored levels inside D
CELLS = [(T, k) for T in HS for k in DLEV]                                   # 15 confirmatory cells (Holm family)
SECONDARY = [(T, k) for T in HS for k in (-0.25, -0.30, -0.40)]
MENU = [(deg, kap, W, fl) for deg in (1, 2) for kap in (50.0, 20.0) for W in (180, 90) for fl in (-0.10, -0.05)]
PCLIP = 1e-4
SEED = 20261841
NB_DEV = 2000
NI_MARGIN = -0.002
CAL_MARGIN = 0.03                                                            # calibrated-type |ln R| NI margin
CAL_TYPE_MAX = 0.05                                                          # calibrated if dev |ln R(fH)| <= 0.05
DSC_TOL = 0.01
ALPHA = 0.05
MIN_POS_J = 20
LEVEL_GRID = 6 * STEP
R13_DEV = "history-forecasts/r13/r131-dev-c3f36695/dev-r131.json"
R13_FROZEN = "history-forecasts/r13/r131-run-e7550b81/frozen-r131-config.json"
R12_DEV = "history-forecasts/r12/dev-49e1af3a"

POLO_MARKETS = "https://api.poloniex.com/markets"
B18_FIRST_MAX = int(datetime(2025, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)   # tradable before 2025-07-01


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    return sha256b(open(p, "rb").read())


# =============================================================================================
# B18 selection (listings only)
# =============================================================================================
def other_used(datasets):
    """bases of every other price set whose prices were or will be read: B15 (both halves), B17 (both halves), B9, B10."""
    s15 = json.load(open(os.path.join(datasets, "b15-mexc-prices/selection-b15.json")))
    b15 = set(s15["eligible"])
    s17 = json.load(open(os.path.join(datasets, "b17-uniswap-alts/selection-r129.json")))
    b17 = {str(x.get("symbol", "")).upper() for x in s17["assets"]}
    b9 = set()
    for root, _, files in os.walk(os.path.join(datasets, "b9-delisted-prices")):
        for f in files:
            if f.endswith(".json.gz") and "USDT" in f:
                b9.add(f.split("-")[1].split("USDT")[0].upper() if "-" in f else f.split("USDT")[0].upper())
    return b15, b17, b9


def cmd_select_b18(a):
    raw = R125.http_get(POLO_MARKETS)
    mk = json.loads(raw)
    b12, kc, b14 = R13.used_lists(a.datasets)
    b15, b17, b9 = other_used(a.datasets)
    bn = set(R125.binance_symbols())
    rec = {"poloniex_usdt_pairs": 0, "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [], "in_b15": [],
           "in_b17": [], "in_b9": [], "excluded": {}, "late": [], "kept": []}
    sym_of, start_of, state_of = {}, {}, {}
    for m in sorted(mk, key=lambda x: x["symbol"]):
        if m.get("quoteCurrencyName") != "USDT":
            continue
        rec["poloniex_usdt_pairs"] += 1
        base = m["baseCurrencyName"].upper()
        sym_of[base], start_of[base], state_of[base] = m["symbol"], int(m.get("tradableStartTime") or 0), m.get("state")
        if R125.on_binance(base, bn):
            rec["on_binance"].append(base)
        elif base in kc:
            rec["on_kucoin"].append(base)
        elif base in b12:
            rec["in_b12"].append(base)
        elif base in b14:
            rec["in_b14"].append(base)
        elif base in b15:
            rec["in_b15"].append(base)
        elif base in b17:
            rec["in_b17"].append(base)
        elif base in b9:
            rec["in_b9"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        elif not start_of[base] or start_of[base] >= B18_FIRST_MAX:
            rec["late"].append(base)
        else:
            rec["kept"].append(base)
    elig = sorted(rec["kept"])
    out = {"schema": "q26-r14-b18-selection-v1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "source": "Poloniex public REST /markets (keyless); candles /markets/{symbol}/candles HOUR_1 (not read)",
           "poloniex_markets_sha256": sha256b(raw), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc),
           "b12_assets": len(b12), "b14_assets": len(b14), "b15_assets": len(b15), "b17_symbols": len(b17),
           "b9_assets": len(b9), "eligible_tradable_start_before_utc": "2025-07-01T00:00:00Z",
           "eligible": elig, "B18": elig,
           "tradable_start_utc": {b: datetime.fromtimestamp(start_of[b] / 1000, timezone.utc).strftime("%Y-%m-%d")
                                  for b in elig},
           "state": {b: state_of[b] for b in elig}, "symbol": {b: sym_of[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b18.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()
                      if k not in ("tradable_start_utc", "state", "symbol")}, indent=1))
    print("sha256", sha_file(p))


# =============================================================================================
# rows: dense (fH) grid, dense labels, registered (fH)/(f)/(a) at the 10 levels
# =============================================================================================
def row_task(a):
    spec, T, grid = a["spec"], a["T"], a["grid"]
    ser, folds, caps = R13.load_any(spec)
    P6 = A6.Prep6(ser, T, with_fbL=False)
    P, n = P6.P, P6.n
    ts_all = ser.base_ts + STEP * np.arange(n)
    i_all = np.arange(n)
    scale = P.scale
    keys = ["ts", "y", "pH", "pf", "pa", "pG", "yG", "q2", "tail", "fold"]
    out = {k: [] for k in keys}
    for f in folds:
        qs, qe = f["qs_i"], min(f["qe_i"], n)
        lim = qs - T
        tr = i_all <= lim
        cH, _ = P6.har_coef(qs)
        sH = P6.sigma_H(cH)
        zH, vH = P6.z_of(sH)
        te = np.arange(qs, qe)
        te = te[P.lab_ok[te] & (ts_all[te] + T * STEP <= caps["full"])]
        if grid == "6h":
            te = te[ts_all[te] % LEVEL_GRID == 0]
        if len(te) == 0:
            continue
        zt, zf = zH[vH & tr], P.z[1.0][P.valid[1.0] & tr]
        pH = M2.fhs_predict(zt, P.thresholds(sH[te]))
        pf = M2.fhs_predict(zf, P.thresholds(ser.sigma[te]))
        fb = ~np.all(np.isfinite(pH), axis=1)
        pH[fb] = pf[fb]
        with np.errstate(invalid="ignore", divide="ignore"):
            thrG = LNG[None, :] / (sH[te][:, None] * scale)
            thrGf = LNG[None, :] / (ser.sigma[te][:, None] * scale)
        pG = M2.fhs_predict(zt, thrG)
        pGf = M2.fhs_predict(zf, thrGf)
        fbG = ~np.all(np.isfinite(pG), axis=1)
        pG[fbG] = pGf[fbG]
        pa = np.tile(P.freq_upto(lim), (len(te), 1))
        keep = (np.all(np.isfinite(pH), axis=1) & np.all(np.isfinite(pf), axis=1) & np.all(np.isfinite(pa), axis=1)
                & np.all(np.isfinite(pG), axis=1) & np.isfinite(P.depth[te]))
        te, pH, pf, pa, pG = te[keep], pH[keep], pf[keep], pa[keep], pG[keep]
        if len(te) == 0:
            continue
        ts = ts_all[te]
        out["ts"].append(ts)
        out["y"].append(P.Y[te].astype(np.int8))
        for k_, arr in (("pH", pH), ("pf", pf), ("pa", pa), ("pG", pG)):
            out[k_].append(np.minimum.accumulate(arr, axis=1).astype(np.float32))
        out["yG"].append((P.depth[te][:, None] <= LNG[None, :]).astype(np.int8))
        out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
        out["tail"].append(ts + T * STEP > caps["primary"])
        out["fold"].append(np.full(len(ts), int(f["qs_ts"]), np.int64))
    rows = {k: np.concatenate(v) for k, v in out.items()} if out["ts"] else None
    return {"key": spec["key"], "rows": rows}


def run_rows(specs, T, grid, workers, log, label):
    t0 = time.time()
    res = []
    with mp.get_context("fork").Pool(workers, maxtasksperchild=8) as pool:
        for j, r in enumerate(pool.imap(row_task, [{"spec": s, "T": T, "grid": grid} for s in specs], chunksize=1)):
            res.append(r)
            if (j + 1) % 100 == 0 or j + 1 == len(specs):
                log(f"  {label} {TL[T]}: {j + 1}/{len(specs)} ({time.time() - t0:.0f}s)")
    return R12.stack_rows(res)


# =============================================================================================
# the DR map
# =============================================================================================
lg = R13.lg


def fit_dr(pG, yG, deg):
    """logit P(y_j) = alpha_j + s(u_j) logit p_j over all 17 thresholds; s(u) = sum_m b_m u^m, m <= deg.
    Returns slope coefficients b and mean-preserving rotation points c_j (fit rows)."""
    J = len(GRID)
    k = J + deg + 1
    Ls = [lg(pG[:, j]) for j in range(J)]
    ys = [yG[:, j].astype(float) for j in range(J)]
    th = np.zeros(k)
    th[J] = 1.0
    for it in range(80):
        g = np.zeros(k)
        H = np.zeros((k, k))
        for j in range(J):
            um = U[j] ** np.arange(deg + 1)
            s = float(th[J:] @ um)
            L, y = Ls[j], ys[j]
            p = expit(th[j] + s * L)
            w = np.maximum(p * (1 - p), 1e-12)
            r = y - p
            sw, swL, swLL = w.sum(), (w * L).sum(), (w * L * L).sum()
            g[j] += r.sum()
            g[J:] += (r * L).sum() * um
            H[j, j] += sw
            H[j, J:] += swL * um
            H[J:, j] += swL * um
            H[J:, J:] += swLL * np.outer(um, um)
        step = np.linalg.solve(H + 1e-9 * np.eye(k), g)
        th += step
        if np.max(np.abs(step)) < 1e-9:
            break
    b = th[J:]
    cmp_ = []
    for j in range(J):
        s = float(b @ (U[j] ** np.arange(deg + 1)))
        target = float(np.clip(pG[:, j], PCLIP, 1 - PCLIP).mean())
        lo_, hi_ = -30.0, 30.0
        for _ in range(80):
            mid = 0.5 * (lo_ + hi_)
            v = float(expit(mid + s * (Ls[j] - mid)).mean())
            if (v < target) == (s < 1):
                lo_ = mid
            else:
                hi_ = mid
        cmp_.append(0.5 * (lo_ + hi_))
    return {"deg": deg, "b": b.tolist(), "alpha": th[:J].tolist(), "c_mp": cmp_,
            "slope_by_threshold": [float(b @ (U[j] ** np.arange(deg + 1))) for j in range(J)],
            "n_rows": int(pG.shape[0]), "iters": it + 1}


def dr_slope_only(pG, m):
    s = np.array(m["slope_by_threshold"])[None, :]
    c = np.array(m["c_mp"])[None, :]
    return expit(c + s * (lg(pG) - c))


def dr_apply(pG, yG, ts, sid, T, m, W, kappa, floor):
    """p' on the deep subgrid D: slope-only DR + subject level from the dense grid (thresholds floor .. -40%), then
    monotone rearrangement across D. Returns (p' at DLEV, slope-only at DLEV)."""
    pb = dr_slope_only(pG, m)
    F = [j for j, k in enumerate(GRID) if k <= floor + 1e-12]
    sp = pb[:, F].sum(axis=1)[:, None]
    sy = yG[:, F].sum(axis=1).astype(float)[:, None]
    a = R13.level_terms(ts, sid, sp, sy, T, W, kappa)[:, 0]
    pd = expit(lg(pb[:, DGRID]) + a[:, None])
    pd = -np.sort(-pd, axis=1)
    p2 = np.clip(pd[:, DPOS], PCLIP, 1 - PCLIP)
    ps = np.clip(-np.sort(-pb[:, DGRID], axis=1)[:, DPOS], PCLIP, 1 - PCLIP)
    return p2, ps


def name_of(e):
    deg, kap, W, fl = e
    return f"DR_d{deg}_k{int(kap)}_W{W}_f{int(round(-100 * fl))}"


# =============================================================================================
# cell statistics (calibration-led, both types) and power
# =============================================================================================
def cell_eval(ts, sid, y, T, P, ref="fH", seed=0, nb=NB_DEV, blocks=None):
    """P: name -> forecast column for this cell. Crash-episode blocks (precomputed blocks may be passed)."""
    g, G, posb = blocks if blocks is not None else R12.crash_blocks(ts, sid, y, T)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed]))
    idx = rng.integers(0, G, size=(nb, G))
    Sy = np.bincount(g, y, G)
    out = {"rows": int(len(y)), "pos": int(y.sum()), "blocks": int(G), "pos_blocks": int(posb.sum()), "f": {}}
    pre = {}
    for name, p in P.items():
        p = np.asarray(p, float)
        top, bot = R13.quint_masks(p)
        Sp = np.bincount(g, p, G)
        Spt, Syt = np.bincount(g, p * top, G), np.bincount(g, y * top, G)
        Se = np.bincount(g, (p - y) ** 2, G)
        R = Sp.sum() / Sy.sum() if Sy.sum() else np.nan
        Rt = Spt.sum() / Syt.sum() if Syt.sum() else np.nan
        Rb = (p * bot).sum() / (y * bot).sum() if (y * bot).sum() else np.nan
        c = R13.corp(p, y)
        with np.errstate(divide="ignore", invalid="ignore"):
            Rs = Sp[idx].sum(1) / Sy[idx].sum(1)
            Rts = Spt[idx].sum(1) / Syt[idx].sum(1)
        pre[name] = {"Se": Se, "absl": abs(math.log(R)) if R > 0 else np.nan,
                     "abslt": abs(math.log(Rt)) if Rt > 0 else np.nan,
                     "absl_s": np.abs(np.log(Rs)), "abslt_s": np.abs(np.log(Rts))}
        out["f"][name] = {"R": float(R), "R_top20": float(Rt), "R_bot20": float(Rb), **c}
    r = pre[ref]
    for name in P:
        if name == ref:
            continue
        q = pre[name]
        d, dt = q["absl"] - r["absl"], q["abslt"] - r["abslt"]
        ds, dts = q["absl_s"] - r["absl_s"], q["abslt_s"] - r["abslt_s"]
        ok = np.isfinite(ds) & np.isfinite(dts)
        ds, dts = ds[ok], dts[ok]
        B = len(ds)
        p_d = (1 + int(np.sum(ds - d <= d))) / (B + 1)
        p_dni = (1 + int(np.sum(ds - d <= d - CAL_MARGIN))) / (B + 1)
        p_t = (1 + int(np.sum(dts - dt <= dt))) / (B + 1)
        bss = 1 - q["Se"].sum() / r["Se"].sum()
        bs = 1 - q["Se"][idx].sum(1) / r["Se"][idx].sum(1)
        out["f"][name].update({
            "d_abslnR": float(d), "d_abslnR_se": float(np.std(ds)), "p_d": float(p_d), "p_d_ni": float(p_dni),
            "d_top": float(dt), "d_top_se": float(np.std(dts)), "p_top": float(p_t),
            "bss_vs_ref": float(bss), "bss_ci90": [float(np.quantile(bs, 0.05)), float(np.quantile(bs, 0.95))],
            "bss_se": float(np.std(bs))})
    return out


def cell_power(c, name, G_new, ctype, m=len(CELLS)):
    f = c["f"][name]
    G = max(c["pos_blocks"], 1)
    za = norm.ppf(1 - ALPHA / m)
    m1 = f["d_abslnR"] - (CAL_MARGIN if ctype == "calibrated" else 0.0)
    p1, g1 = R13.power_leg(m1, f["d_abslnR_se"], G, G_new, za)
    p2, g2 = R13.power_leg(f["d_top"], f["d_top_se"], G, G_new, za)
    p3, g3 = R13.power_leg(-(f["bss_vs_ref"] - NI_MARGIN), f["bss_se"], G, G_new, norm.ppf(0.95))
    return {"type": ctype, "power_absl": p1, "power_top": p2, "power_ni": p3, "power_min": min(p1, p2, p3),
            "gstar_absl": g1, "gstar_top": g2, "gstar_ni": g3}


# =============================================================================================
# development (seen data only)
# =============================================================================================
def logger(path):
    logf = open(path, "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    return log


def cmd_dev(a):
    os.makedirs(a.out, exist_ok=True)
    log = logger(os.path.join(a.out, "dev-log.txt"))
    log(f"START r14.1 dev (seen data only); code {R112.git_sha()}")
    lim = (lambda sp: sp[:a.limit]) if a.limit else (lambda sp: sp)
    sets = {"dev": (R12.dev_specs(a.datasets), "6h"),
            "b9": (R13.b9_specs(a.datasets, os.path.join(a.out, "acq_r12")), "6h"),
            "b12": (R13.b12_specs(a.datasets), "1h"),
            "b13a": (R13.b13a_specs(a.datasets), "1h")}
    r13dev = json.load(open(os.path.join(a.datasets, R13_DEV)))
    part = os.path.join(a.out, "dev-r141-partial.json")
    out = json.load(open(part)) if os.path.exists(part) else {
        "schema": "q26-r14.1-dev/1", "label": "DEVELOPMENT ONLY (seen data)", "code_sha": R112.git_sha(),
        "grid": list(GRID), "menu": [name_of(e) for e in MENU], "maps": {}, "maps_loo": {}, "cells": {},
        "label_mismatch": {}}
    hs = [int(x) for x in a.horizons.split(",")] if a.horizons else list(HS)
    for T in hs:
        if TL[T] in out["maps"]:
            log(f"  {TL[T]} already done (resume)")
            continue
        St, off = {}, 0
        for nm, (specs, grid) in sets.items():
            S = run_rows(lim(specs), T, grid, a.workers, log, nm)
            S["sid"] = S["sid"] + off
            off = int(S["sid"].max()) + 1
            St[nm] = S
        out["label_mismatch"][TL[T]] = {nm: int(np.sum(S_["yG"][:, [GRID.index(k) for k in LEVELS]] != S_["y"]))
                                        for nm, S_ in St.items()}
        fm = {nm: (~S_["q2"] & ~S_["tail"] & (S_["ts"] % LEVEL_GRID == 0)) for nm, S_ in St.items()}

        def pool(exclude, deg):
            pG = np.concatenate([St[nm]["pG"][fm[nm]] for nm in St if nm != exclude])
            yG = np.concatenate([St[nm]["yG"][fm[nm]] for nm in St if nm != exclude])
            return fit_dr(pG, yG, deg)
        maps = {str(d): pool(None, d) for d in (1, 2)}
        loo = {nm: {str(d): pool(nm, d) for d in (1, 2)} for nm in ("b12", "b13a")}
        out["maps"][TL[T]], out["maps_loo"][TL[T]] = maps, loo
        log(f"  maps {TL[T]}: d1 b {np.round(maps['1']['b'], 4).tolist()} d2 b {np.round(maps['2']['b'], 4).tolist()};"
            f" deep slopes d1 {np.round(np.array(maps['1']['slope_by_threshold'])[DGRID], 3).tolist()}")
        for nm in ("dev", "b9"):
            del St[nm]
        C = {k: np.concatenate([St["b12"][k], St["b13a"][k]]) for k in St["b12"]}
        nb12 = len(St["b12"]["ts"])
        del St
        setid = np.r_[np.zeros(nb12, np.int8), np.ones(len(C["ts"]) - nb12, np.int8)]
        sl = {"b12": slice(0, nb12), "b13a": slice(nb12, None)}
        score = ~C["q2"] & ~C["tail"]
        rows = np.flatnonzero(score)
        cols = [KIX[k] for k in DLEV]
        ec = R125.e_consts(os.path.join(a.datasets, R12_DEV), T)
        fH = C["pH"][:, cols].astype(np.float32)

        def gen():
            """forecasts one at a time (memory): name -> (n, 5) float32 at DLEV."""
            yield "f", C["pf"][:, cols].astype(np.float32)
            yield "a", C["pa"][:, cols].astype(np.float32)
            yield "e", np.tile(ec[cols].astype(np.float32), (len(C["ts"]), 1))
            yield "R13.1", np.vstack([R13.recal(C["pH"][s_].astype(float), C["ts"][s_], C["sid"][s_], C["y"][s_], T,
                                                r13dev["maps_loo"][TL[T]][nm], 90, 50.0, "c_mp")[0][:, cols]
                                      for nm, s_ in sl.items()]).astype(np.float32)
            for deg in (1, 2):
                ps = np.vstack([dr_slope_only(C["pG"][s_], loo[nm][str(deg)])[:, DGRID] for nm, s_ in sl.items()])
                yield f"DR_d{deg}_slope", np.clip(-np.sort(-ps, axis=1)[:, DPOS], PCLIP, 1 - PCLIP).astype(np.float32)
            for e in MENU:
                deg, kap, W, fl = e
                yield name_of(e), np.vstack([dr_apply(C["pG"][s_], C["yG"][s_], C["ts"][s_], C["sid"][s_], T,
                                                      loo[nm][str(deg)], W, kap, fl)[0]
                                             for nm, s_ in sl.items()]).astype(np.float32)
        wkid = R12.wk(C["ts"])
        jsum = {}
        tags = (("pooled", score), ("b12", score & (setid == 0)), ("b13a", score & (setid == 1)))
        rr_of = {tag: np.flatnonzero(m_) for tag, m_ in tags}
        blk = {}
        for ci, k in enumerate(DLEV):
            y = C["y"][:, KIX[k]].astype(float)
            for tag, rr in rr_of.items():
                blk[(ci, tag)] = R12.crash_blocks(C["ts"][rr], C["sid"][rr], y[rr], T)

        def add(n_, Pn):
            for ci, k in enumerate(DLEV):
                key = f"{TL[T]} {k}"
                y = C["y"][:, KIX[k]].astype(float)
                cur = out["cells"].setdefault(key, {})
                for tag, rr in rr_of.items():
                    Pd = {"fH": fH[rr, ci]} if n_ == "fH" else {"fH": fH[rr, ci], n_: Pn[rr, ci]}
                    res = cell_eval(C["ts"][rr], C["sid"][rr], y[rr], T, Pd,
                                    seed=1000 * T + int(-100 * k) + 7 * len(tag), blocks=blk[(ci, tag)])
                    if n_ == "fH":
                        cur[tag] = res
                    else:
                        cur[tag]["f"][n_] = res["f"][n_]
                    if tag != "pooled" and (n_ in ("fH", "R13.1") or (n_.startswith("DR_d")
                                                                       and not n_.endswith("_slope"))):
                        sidx = 0 if tag == "b12" else 1
                        uw, gi = np.unique(wkid[rr], return_inverse=True)
                        p = Pn[rr, ci].astype(float)
                        top, _ = R13.quint_masks(p)
                        kk = f"{TL[T]}|{k}|{sidx}|{n_}"
                        jsum[kk] = np.vstack([np.bincount(gi, v, len(uw)) for v in (p, y[rr], p * top, y[rr] * top)])
                        jsum[f"weeks|{kk}"] = uw
        add("fH", fH)
        for n_, Pn in gen():
            add(n_, Pn)
            f0 = {DLEV[ci]: out["cells"][f"{TL[T]} {k}"]["pooled"]["f"] for ci, k in enumerate(DLEV)}
            log(f"  {TL[T]} {n_}: " + " ".join(f"{k}:{f0[k][n_]['R']:.3f}/{f0[k][n_]['R_top20']:.3f}/"
                                                 f"{f0[k][n_]['bss_vs_ref']:+.4f}" for k in DLEV))
            del Pn
        log(f"  {TL[T]} fH: " + " ".join(f"{k}:{out['cells'][f'{TL[T]} {k}']['pooled']['f']['fH']['R']:.3f}/"
                                         f"{out['cells'][f'{TL[T]} {k}']['pooled']['f']['fH']['R_top20']:.3f} "
                                         f"posblk {out['cells'][f'{TL[T]} {k}']['pooled']['pos_blocks']}"
                                         for k in DLEV))
        np.savez_compressed(os.path.join(a.out, f"jsums-{TL[T]}.npz"), **jsum)
        del C, fH
        json.dump(out, open(part, "w"), indent=1, default=float)
    out["finished_utc"] = now_iso()
    json.dump(out, open(os.path.join(a.out, "dev-r141.json"), "w"), indent=1, default=float)
    log("END dev")


def cmd_select(a):
    sums, weeks = {}, {}
    for T in HS:
        z = np.load(os.path.join(a.out, f"jsums-{TL[T]}.npz"))
        for kk in z.files:
            (weeks.__setitem__(kk[6:], z[kk]) if kk.startswith("weeks|") else sums.__setitem__(kk, z[kk]))
    allw = np.unique(np.concatenate(list(weeks.values())))
    Gw = len(allw)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, 99]))
    Cb = np.stack([np.bincount(rng.integers(0, Gw, Gw), minlength=Gw) for _ in range(NB_DEV)]).astype(float)
    names = sorted({kk.split("|")[3] for kk in sums})
    cellkeys = sorted({"|".join(kk.split("|")[:3]) for kk in sums})
    elig = [ck for ck in cellkeys if sums[f"{ck}|fH"][1].sum() >= MIN_POS_J]
    J, Js = {}, {}
    for nm in names:
        tot, tots = 0.0, np.zeros(NB_DEV)
        for ck in elig:
            full = np.zeros((4, Gw))
            full[:, np.searchsorted(allw, weeks[f"{ck}|{nm}"])] = sums[f"{ck}|{nm}"]
            tot += abs(math.log(full[0].sum() / full[1].sum())) + abs(math.log(full[2].sum() / full[3].sum()))
            bs = Cb @ full.T
            with np.errstate(divide="ignore", invalid="ignore"):
                tots += np.abs(np.log(bs[:, 0] / bs[:, 1])) + np.abs(np.log(bs[:, 2] / bs[:, 3]))
        J[nm], Js[nm] = tot / len(elig), tots / len(elig)
    order = [name_of(e) for e in MENU]                       # MENU is already in simplicity order
    jmin = min(order, key=lambda n: J[n])
    jb = np.where(np.isfinite(Js[jmin]), Js[jmin], np.nan)
    se = float(np.nanstd(jb)) if np.isfinite(jb).sum() > 10 else 0.0
    chosen = next(n for n in order if J[n] <= J[jmin] + se)
    dev = json.load(open(os.path.join(a.out, "dev-r141.json")))
    types = {}
    for T, k in CELLS:
        R = dev["cells"][f"{TL[T]} {k}"]["pooled"]["f"]["fH"]["R"]
        types[f"{TL[T]} {k}"] = {"R_fH_dev": R, "type": "calibrated" if abs(math.log(R)) <= CAL_TYPE_MAX
                                 else "miscalibrated"}
    res = {"J": J, "J_se_of_min": se, "argmin": jmin, "simplicity_order": order, "chosen": chosen,
           "weeks": int(Gw), "cells_x_sets": len(elig), "cells_x_sets_all": len(cellkeys), "cell_types": types}
    h = R112.write_json(os.path.join(a.out, "select-r141.json"), res)
    print(json.dumps(res, indent=1))
    print("sha256", h)


# =============================================================================================
# B15b acquisition (outcome-blind), counts only, power
# =============================================================================================
def cmd_acquire_b15b(a):
    sel = json.load(open(os.path.join(a.datasets, "b15-mexc-prices/selection-b15.json")))
    vd = os.path.join(a.acq, "b15b")
    os.makedirs(vd, exist_ok=True)
    mp_ = os.path.join(vd, "manifest-acquire-b15b.json")
    man = json.load(open(mp_)) if os.path.exists(mp_) else {
        "schema": "q26-r14/acquire-b15b/1", "started_utc": now_iso(), "code_sha": R112.git_sha(),
        "selection_sha256": sha_file(os.path.join(a.datasets, "b15-mexc-prices/selection-b15.json")),
        "source": "MEXC public REST api/v3/klines 60m (free, keyless; no published checksum; sha256 of every raw "
                  "page recorded); a missing hour is null; no fill, no filter",
        "series": {}, "dropped": {}}

    def one(base):
        if base in man["series"] or base in man["dropped"]:
            return None
        rows, pages = R13.mexc_fetch(sel["symbol"][base], sel["first_month"][base])
        if not rows:
            return base, None, {"reason": "no data before the acquisition end"}
        st = min(rows)
        if st >= R125.FIRST_MAX:
            return base, None, {"reason": "first hour on or after 2025-07-01 (no A6.6 fold)", "first_utc": A.iso(st)}
        gp = os.path.join(vd, f"mexc-{base}USDT-1h.json.gz")
        nh, nn = R12.write_grid(gp, f"{base}USDT", "mexc 1h", st, rows)
        last = max(rows)
        return base, {"file": os.path.basename(gp), "sha256": R112.sha256_file(gp), "grid_start_utc": A.iso(st),
                      "last_hour_utc": A.iso(last), "ended": bool(last + STEP < R13.ACQ_END - R125.LIVE_GAP),
                      "hours": nh, "null_hours": nn, "pages": pages}, None

    done = 0
    with cf.ThreadPoolExecutor(4) as ex:
        for r in ex.map(one, sel["B15b"]):
            if r is None:
                continue
            b, v, drop = r
            if v is None:
                man["dropped"][b] = drop
            else:
                man["series"][b] = v
            done += 1
            if done % 10 == 0:
                R112.write_json(mp_, man)
                print(f"{now_iso()} acquired {done}/{len(sel['B15b'])}", flush=True)
    man["finished_utc"] = now_iso()
    man["status"] = "LOCKED for Q26 R14.1 (design/Q26_ROUND14_PREREG.md D-R14.1a)"
    h = R112.write_json(mp_, man)
    print(json.dumps({"series": len(man["series"]), "dropped": len(man["dropped"]),
                      "hours": sum(v["hours"] for v in man["series"].values()),
                      "null_hours": sum(v["null_hours"] for v in man["series"].values()),
                      "ended": sum(v["ended"] for v in man["series"].values()), "manifest_sha256": h}), flush=True)


def b15b_specs(acq):
    man = json.load(open(os.path.join(acq, "b15b", "manifest-acquire-b15b.json")))
    specs = []
    for b, v in sorted(man["series"].items()):
        path = os.path.join(acq, "b15b", v["file"])
        st, cols = R12.load_json_grid(path)
        n = len(cols["close"])
        last = st + STEP * (n - 1)
        cap_full = min(R13.ACQ_END, last + STEP)
        cap_pri = min(cap_full, last + STEP - R12.TAIL_DAYS * DAY) if v["ended"] else cap_full
        sp = R12.redenom_splits(cols["close"])
        bounds = [0] + sp + [n]
        for j in range(len(bounds) - 1):
            if bounds[j + 1] - bounds[j] <= 0:
                continue
            specs.append({"key": f"b15b:{b}" + ("" if j == 0 else f"#{j + 1}"), "asset": b, "kind": "grid",
                          "path": path, "slice": (bounds[j], bounds[j + 1]), "cap_full": cap_full,
                          "cap_primary": cap_pri})
    return specs


def cmd_counts(a):
    """counts only: validated origins, positive origins, positive crash-episode blocks per cell (R12 definitions)."""
    specs = b15b_specs(a.acq)
    c = R12.count_set(specs, True)
    out = {"schema": "q26-r14/counts-b15b/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "note": "counts only", "specs": len(specs), "series_with_origins": c["series"], "cells": {}}
    for T, k in CELLS:
        lv = next(x for x in c["T"][str(T)]["levels"] if x["level"] == k)
        out["cells"][f"{TL[T]} {k}"] = {"validated_origins": c["T"][str(T)]["validated_origins"],
                                       "positive_origins": lv["positive_origins"], "blocks": lv["blocks"],
                                       "positive_blocks": lv["positive_blocks"],
                                       "series_episodes": lv["series_episodes"]}
    h = R112.write_json(os.path.join(a.out, "counts-b15b.json"), out)
    for key, v in out["cells"].items():
        print(key, {kk: v[kk] for kk in ("validated_origins", "positive_blocks", "blocks")})
    print("series with origins", c["series"], "counts sha256", h)


def cmd_power(a):
    dev = json.load(open(os.path.join(a.dev, "dev-r141.json")))
    sel = json.load(open(os.path.join(a.dev, "select-r141.json")))
    cnt = json.load(open(os.path.join(a.out, "counts-b15b.json")))
    name = sel["chosen"]
    out = {"chosen": name, "cells": {}}
    for T, k in CELLS:
        key = f"{TL[T]} {k}"
        G_new = cnt["cells"][key]["positive_blocks"]
        pw = cell_power(dev["cells"][key]["pooled"], name, G_new, sel["cell_types"][key]["type"])
        out["cells"][key] = {"G_b15b": G_new, **pw}
        print(key, "G", G_new, {kk: (round(v, 3) if isinstance(v, float) else v) for kk, v in pw.items()})
    out["n_cells_ge80"] = int(sum(v["power_min"] >= 0.8 for v in out["cells"].values()))
    h = R112.write_json(os.path.join(a.out, "power-b15b.json"), out)
    print("cells at >= 80%:", out["n_cells_ge80"], "sha256", h)


# =============================================================================================
# freeze and run
# =============================================================================================
def parse_name(nm):
    return next(e for e in MENU if name_of(e) == nm)


def cmd_freeze(a):
    dev = json.load(open(os.path.join(a.dev, "dev-r141.json")))
    sel = json.load(open(os.path.join(a.dev, "select-r141.json")))
    deg, kap, W, fl = parse_name(sel["chosen"])
    r13f = os.path.join(a.datasets, R13_FROZEN)
    r13 = json.load(open(r13f))
    e = {TL[T]: [float(x) for x in R125.e_consts(os.path.join(a.datasets, R12_DEV), T)] for T in HS}
    me = os.path.abspath(__file__)
    cfg = {"schema": "q26-r14.1/frozen/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "code_sha256": {os.path.basename(f): sha_file(f) for f in
                           (me, os.path.join(HERE, "r13_recal.py"), os.path.join(HERE, "r12_tail.py"),
                            os.path.join(HERE, "a6_touch.py"), os.path.join(HERE, "a2_touch.py"),
                            os.path.join(HERE, "r125_fh_deep.py"))},
           "inputs": {"manifest_b15b_sha256": sha_file(os.path.join(a.acq, "b15b", "manifest-acquire-b15b.json")),
                      "counts_b15b_sha256": sha_file(os.path.join(a.out, "counts-b15b.json")),
                      "power_b15b_sha256": sha_file(os.path.join(a.out, "power-b15b.json")),
                      "dev_r141_sha256": sha_file(os.path.join(a.dev, "dev-r141.json")),
                      "select_r141_sha256": sha_file(os.path.join(a.dev, "select-r141.json")),
                      "r131_frozen_sha256": sha_file(r13f)},
           "chosen": sel["chosen"], "deg": deg, "kappa": kap, "W_days": W, "floor": fl,
           "dr_maps": {TL[T]: dev["maps"][TL[T]][str(deg)] for T in HS},
           "r131": {"maps": {TL[T]: r13["maps"][TL[T]] for T in HS}, "W_days": r13["W_days"],
                    "kappa": r13["kappa"], "cvar": r13["cvar"]},
           "cell_types": sel["cell_types"], "e_consts": e, "cells": CELLS, "secondary": SECONDARY,
           "grid": list(GRID), "seed": SEED, "n_boot": 10000, "ni_margin_bss": NI_MARGIN, "cal_margin": CAL_MARGIN,
           "dsc_tol": DSC_TOL, "alpha": ALPHA, "min_pos_blocks": 30, "level_grid_hours": 6, "pclip": PCLIP}
    h = R112.write_json(os.path.join(a.out, "frozen-r141-config.json"), cfg)
    print("frozen config sha256", h, "created_utc", cfg["created_utc"])


def forecasts_of(S, T, cfg):
    cols = [KIX[k] for k in DLEV]
    p2, ps = dr_apply(S["pG"], S["yG"], S["ts"], S["sid"], T, cfg["dr_maps"][TL[T]], cfg["W_days"], cfg["kappa"],
                      cfg["floor"])
    r = cfg["r131"]
    r13 = R13.recal(S["pH"].astype(float), S["ts"], S["sid"], S["y"], T, r["maps"][TL[T]], r["W_days"], r["kappa"],
                    r["cvar"])[0][:, cols]
    ec = np.array(cfg["e_consts"][TL[T]], float)[cols]
    return {"fH": S["pH"][:, cols].astype(float), "DR": p2, "DR_slope": ps, "R13.1": r13,
            "f": S["pf"][:, cols].astype(float), "a": S["pa"][:, cols].astype(float),
            "e": np.tile(ec, (len(S["ts"]), 1))}


def lookahead(spec, T, cfg, cut_frac=0.6):
    import gzip
    import tempfile
    st, cols = R12.load_json_grid(spec["path"])
    i0, i1 = spec["slice"]
    cut = i0 + int(cut_frac * (i1 - i0))
    cut_ts = st + STEP * cut
    raw = json.loads(gzip.decompress(open(spec["path"], "rb").read()))
    rng = np.random.default_rng(7)
    f = np.exp(rng.normal(0, 0.05, len(raw["columns"]["close"])))
    for c in ("open", "high", "low", "close"):
        raw["columns"][c] = [x if (x is None or j < cut) else x * f[j] for j, x in enumerate(raw["columns"][c])]
    td = tempfile.mkdtemp()
    p2 = os.path.join(td, "x.json.gz")
    with gzip.GzipFile(p2, "wb", mtime=0) as fh:
        fh.write(json.dumps(raw).encode())
    res = []
    for path in (spec["path"], p2):
        r = row_task({"spec": dict(spec, path=path), "T": T, "grid": "1h"})["rows"]
        r["sid"] = np.zeros(len(r["ts"]), np.int32)
        P = forecasts_of(r, T, cfg)
        m = r["ts"] <= cut_ts
        res.append((r["ts"][m], P["DR"][m]))
    same = len(res[0][0]) == len(res[1][0]) and np.array_equal(res[0][0], res[1][0])
    diff = float(np.max(np.abs(res[0][1] - res[1][1]))) if same and len(res[0][0]) else None
    return {"series": spec["key"], "T": TL[T], "cut_utc": A.iso(cut_ts), "rows_checked": int(len(res[0][0])),
            "same_rows": bool(same), "max_abs_diff": diff}


def cmd_run(a):
    cfg_p = os.path.join(a.out, "frozen-r141-config.json")
    cfg = json.load(open(cfg_p))
    if cfg["code_sha"] != R112.git_sha():
        raise SystemExit("STOP: code sha differs from the frozen config")
    run_dir = os.path.join(a.out, f"r141-run-{cfg['code_sha'][:8]}")
    os.makedirs(run_dir, exist_ok=True)
    log = logger(os.path.join(run_dir, "run-log.txt"))
    log(f"START R14.1 run on B15b; frozen config sha256 {sha_file(cfg_p)}; code {cfg['code_sha']}")
    specs = b15b_specs(a.acq)
    out = {"schema": "q26-r14.1/results/1", "frozen_config_sha256": sha_file(cfg_p), "code_sha": cfg["code_sha"],
           "started_utc": now_iso(), "cells": {}, "lookahead": []}
    for T in HS:
        S = run_rows(specs, T, "1h", a.workers, log, "B15b")
        P = forecasts_of(S, T, cfg)
        score = ~S["q2"] & ~S["tail"]
        rows = np.flatnonzero(score)
        for ci, k in enumerate(DLEV):
            key = f"{TL[T]} {k}"
            y = S["y"][rows, KIX[k]].astype(float)
            c = cell_eval(S["ts"][rows], S["sid"][rows], y, T, {n_: v[rows, ci] for n_, v in P.items()},
                          seed=1000 * T + int(-100 * k), nb=cfg["n_boot"])
            sec = cell_eval(S["ts"][rows], S["sid"][rows], y, T, {"R13.1": P["R13.1"][rows, ci],
                                                                  "DR": P["DR"][rows, ci]},
                            ref="R13.1", seed=1000 * T + int(-100 * k) + 5, nb=cfg["n_boot"])
            c["secondary_DR_vs_R13.1"] = {kk: sec["f"]["DR"][kk] for kk in ("bss_vs_ref", "bss_ci90", "bss_se")}
            d = (P["DR"][rows, ci] - y) ** 2 - (P["fH"][rows, ci] - y) ** 2
            c["dk_hac_168_DR_vs_fH"] = R12.dk_hac(S["ts"][rows], d)
            yr = np.array([datetime.fromtimestamp(int(t), timezone.utc).year for t in S["ts"][rows]])
            rep = {}
            for lab, grp in (("year", yr), ("fold", S["fold"][rows])):
                rep[lab] = {}
                for gv in np.unique(grp):
                    mm = grp == gv
                    sy = y[mm].sum()
                    rep[lab][str(gv)] = {"rows": int(mm.sum()), "pos": int(sy),
                                         **{f"R_{n_}": (float(P[n_][rows[mm], ci].sum() / sy) if sy else None)
                                            for n_ in ("fH", "DR", "R13.1")}}
            c["reported"] = rep
            c["type"] = cfg["cell_types"][key]["type"]
            out["cells"][key] = c
            f = c["f"]
            log(f"  {key} ({c['type']}): R fH {f['fH']['R']:.3f} DR {f['DR']['R']:.3f} R13.1 {f['R13.1']['R']:.3f};"
                f" top20 fH {f['fH']['R_top20']:.3f} DR {f['DR']['R_top20']:.3f}; BSS DR vs fH "
                f"{f['DR']['bss_vs_ref']:+.4f} {np.round(f['DR']['bss_ci90'], 4).tolist()}; p {f['DR']['p_d']:.4f}"
                f"/{f['DR']['p_d_ni']:.4f}/{f['DR']['p_top']:.4f}; MCB {f['fH']['MCB']:.6f}->{f['DR']['MCB']:.6f}"
                f" DSC {f['fH']['DSC']:.6f}->{f['DR']['DSC']:.6f}; pos blocks {c['pos_blocks']} of {c['blocks']}; "
                f"DR vs R13.1 BSS {c['secondary_DR_vs_R13.1']['bss_vs_ref']:+.4f}")
        if specs:
            out["lookahead"].append(lookahead(specs[len(specs) // 2], T, cfg))
            log(f"  look-ahead {out['lookahead'][-1]}")
        del S, P
    keys = [f"{TL[T]} {k}" for T, k in CELLS]
    pv = []
    for kk in keys:
        f = out["cells"][kk]["f"]["DR"]
        p1 = f["p_d_ni"] if out["cells"][kk]["type"] == "calibrated" else f["p_d"]
        f["cell_p"] = float(max(p1, f["p_top"]))
        pv.append(f["cell_p"])
    hol = R12.holm(np.array(pv), ALPHA)
    for kk, h in zip(keys, hol):
        c = out["cells"][kk]
        f, r = c["f"]["DR"], c["f"]["fH"]
        l1 = f["d_abslnR"] < (CAL_MARGIN if c["type"] == "calibrated" else 0.0)
        legs = {"L1_abslnR": l1, "L2_top_lt0": f["d_top"] < 0, "holm": bool(h),
                "L3_brier_ni": f["bss_ci90"][0] > NI_MARGIN, "L4_mcb_down": f["MCB"] < r["MCB"],
                "L4_dsc_not_down": f["DSC"] >= (1 - DSC_TOL) * r["DSC"], "L5_pos_blocks_ge30": c["pos_blocks"] >= 30}
        c["verdict"] = {"legs": {k_: bool(v) for k_, v in legs.items()},
                        "result": "PASS" if all(legs.values()) else "FAIL"}
        log(f"VERDICT {kk}: {c['verdict']['result']} {c['verdict']['legs']}")
    sk = [f"{TL[T]} {k}" for T, k in SECONDARY]
    out["secondary"] = {kk: {"bss_DR_vs_R13.1": out["cells"][kk]["secondary_DR_vs_R13.1"]["bss_vs_ref"],
                             "ci90": out["cells"][kk]["secondary_DR_vs_R13.1"]["bss_ci90"],
                             "lower_gt0": out["cells"][kk]["secondary_DR_vs_R13.1"]["bss_ci90"][0] > 0} for kk in sk}
    out["finished_utc"] = now_iso()
    h = R112.write_json(os.path.join(run_dir, "results-r141.json"), out)
    log(f"END results sha256 {h}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select-b18", "dev", "select", "acquire-b15b", "counts", "power", "freeze",
                                    "run"])
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--acq", default="")
    ap.add_argument("--dev", default="")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--horizons", default="")
    ap.add_argument("--limit", type=int, default=0, help="smoke test only: first N specs per set")
    a = ap.parse_args()
    {"select-b18": cmd_select_b18, "dev": cmd_dev, "select": cmd_select, "acquire-b15b": cmd_acquire_b15b,
     "counts": cmd_counts, "power": cmd_power, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)

if __name__ == "__main__":
    main()
