"""Q26 Round 13 deepen memo, external check (DEVELOPMENT ONLY, seen data). Not a preregistered test.

membrane-board design/q26-price-improvement-deepen-2026-10-18.md, section "Development check". Two core claims of the
memo's top ideas are replicated on data that is already seen (grade C for 1 h - 3 d touch):

  fit set   : the R12 development pool (277 seen series: ETH, BTC, P1 Kraken ETH, A2 eight, A3 ten, blind 3-7, blind8),
              6-hourly origins, A6.6 folds, 2026Q2 windows dropped.
  check set : B12 (337 OKX + Bybit venue-unique USDT pairs; read by R12.5, grade C), hourly origins, 30-day tail of
              ended series dropped, 2026Q2 windows dropped. Exactly the R12.5 row rules.

Idea 1, slope/intercept recalibration "M". Per T and depth band (shallow -2..-10%, deep -15..-40%):
  logit p' = a_level + b_band * logit(clip(p_fH, 1e-4, 1 - 1e-4)), unpenalised IRLS on the pooled out-of-fold (fH)
  forecasts of the fit set (one fit per T, frozen), then applied unchanged to B12, then the running minimum across levels.
  PASS LINE (stated before the run): at the six R12.5 cells (12 h, 1 d, 3 d x -15%, -20%) on B12, M beats (fH)
  on Brier (BSS >= 0) in >= 5 of 6 cells AND |ln R| is smaller than (fH)'s in >= 5 of 6 AND the top-quintile R
  (rows ranked by the forecast) is closer to 1 in >= 5 of 6. Otherwise FAIL.

Idea 2, HARQ-type log-HAR scale "(fHQ)". (fH) with one added regressor:
  ln sigma_fut = c + b_d lnD + b_w lnW + b_m lnM + b_q * (q - 1) * (lnD - lnW),
  q = sqrt(mean_24h(v^2)) / mean_24h(v), v = hourly Parkinson variance (a scale-free quarticity / jumpiness ratio,
  the measurement-error proxy of Bollerslev-Patton-Quaedvlieg 2016 in log form). Fitted per (series, T, fold) exactly
  like (fH) (in-fold OLS, purge t + T <= Q_start). Rows where q is undefined take (fH).
  PASS LINE (stated before the run): on B12, BSS (fHQ) vs (fH) > 0 in >= 6 of 9 cells (the six R12.5 cells plus
  1 h -3%, 3 h -5%, 12 h -10%) AND the out-of-fold mean squared error of ln sigma_fut is lower for (fHQ) at >= 4 of
  the 5 horizons. Otherwise FAIL.

Both are reported on the fit set too. Crash-episode-block (R12) bootstrap 90% intervals are reported, not deciding.

  python3 r13_devcheck.py --datasets DS --out OUT [--workers 4]

No address, key or secret is read or written. Nothing here is blind evidence and nothing ships from it.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402
from scipy.special import expit  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a2_touch as M2  # noqa: E402
import a6_touch as A6  # noqa: E402
import r12_tail as R12  # noqa: E402
import r125_fh_deep as R125  # noqa: E402

STEP = R12.STEP
HS = (1, 3, 12, 24, 72)
LEVELS = R12.LEVELS
KIX = {k: j for j, k in enumerate(LEVELS)}
SHALLOW = [j for j, k in enumerate(LEVELS) if k >= -0.10]
DEEP = [j for j, k in enumerate(LEVELS) if k <= -0.15]
CELLS1 = [(12, -0.15), (12, -0.20), (24, -0.15), (24, -0.20), (72, -0.15), (72, -0.20)]
CELLS2 = CELLS1 + [(1, -0.03), (3, -0.05), (12, -0.10)]
PCLIP = 1e-4
SEED = 20261813
NB = 2000


def harq_design(P6, ser):
    """X = [1, lnD, lnW, lnM, (q-1)(lnD-lnW)] with the A6 null rule; cumulative normal equations like Prep6."""
    n = P6.n
    v = A6.parkinson_v(ser.high, ser.low)
    m1 = A6.window_mean_null_rule(v, 24, ser.start_i)[:n]
    m2 = A6.window_mean_null_rule(v * v, 24, ser.start_i)[:n]
    with np.errstate(invalid="ignore", divide="ignore"):
        q = np.sqrt(m2) / m1
        L = np.log(A6.har_of(ser)[:n])
        lfut = np.log(A6.sfut_of(ser, P6.T_h)[:n])
    xq = (q - 1.0) * (L[:, 0] - L[:, 1])
    X = np.column_stack([np.ones(n), L, xq])
    okX = np.all(np.isfinite(X), axis=1)
    okH = P6.P.lab_ok & okX & np.isfinite(lfut)
    Xz = np.where(okH[:, None], X, 0.0)
    yz = np.where(okH, lfut, 0.0)
    return {"X": X, "okX": okX, "cXX": np.cumsum(Xz[:, :, None] * Xz[:, None, :], axis=0),
            "cXy": np.cumsum(Xz * yz[:, None], axis=0), "cn": np.cumsum(okH), "lfut": lfut}


def coef_of(Q, lim):
    lim = min(lim, len(Q["cn"]) - 1)
    if lim < 0 or Q["cn"][lim] < 6:
        return None
    try:
        return np.linalg.solve(Q["cXX"][lim], Q["cXy"][lim])
    except np.linalg.LinAlgError:
        return np.linalg.lstsq(Q["cXX"][lim], Q["cXy"][lim], rcond=None)[0]


def sig_of(X, okX, c):
    out = np.full(len(X), np.nan)
    if c is not None:
        with np.errstate(over="ignore"):
            out[okX] = np.exp(X[okX] @ c)
    out[~(out > 0) | ~np.isfinite(out)] = np.nan
    return out


def task(a):
    spec, T, grid = a["spec"], a["T"], a["grid"]
    ser, folds, caps = R12.load_series(spec)
    P6 = A6.Prep6(ser, T, with_fbL=False)
    P, n = P6.P, P6.n
    Q = harq_design(P6, ser)
    ts_all = ser.base_ts + STEP * np.arange(n)
    i_all = np.arange(n)
    out = {k: [] for k in ("ts", "y", "pH", "pQ", "pf", "lfut", "lsH", "lsQ", "q2", "tail")}
    for f in folds:
        qs, qe = f["qs_i"], min(f["qe_i"], n)
        lim = qs - T
        tr = i_all <= lim
        cH, _ = P6.har_coef(qs)
        sH = P6.sigma_H(cH)
        zH, vH = P6.z_of(sH)
        cQ = coef_of(Q, lim)
        sQ = sig_of(Q["X"], Q["okX"], cQ)
        zQ, vQ = P6.z_of(sQ)
        te = np.arange(qs, qe)
        te = te[P.lab_ok[te] & (ts_all[te] + T * STEP <= caps["full"])]
        if grid == "6h":
            te = te[ts_all[te] % (6 * STEP) == 0]
        if len(te) == 0:
            continue
        pH = M2.fhs_predict(zH[vH & tr], P.thresholds(sH[te]))
        pf = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], P.thresholds(ser.sigma[te]))
        pQ = M2.fhs_predict(zQ[vQ & tr], P.thresholds(sQ[te]))
        fbH = ~np.all(np.isfinite(pH), axis=1)
        pH[fbH] = pf[fbH]
        fbQ = ~np.all(np.isfinite(pQ), axis=1)
        pQ[fbQ] = pH[fbQ]
        keep = np.all(np.isfinite(pH), axis=1) & np.all(np.isfinite(pf), axis=1)
        te, pH, pQ, pf = te[keep], pH[keep], pQ[keep], pf[keep]
        if len(te) == 0:
            continue
        ts = ts_all[te]
        out["ts"].append(ts)
        out["y"].append(P.Y[te].astype(np.int8))
        for k_, arr in (("pH", pH), ("pQ", pQ), ("pf", pf)):
            out[k_].append(np.minimum.accumulate(arr, axis=1).astype(np.float32))
        lsQ = np.log(sQ[te])
        lsQ = np.where(np.isfinite(lsQ), lsQ, np.log(sH[te]))
        out["lfut"].append(Q["lfut"][te].astype(np.float32))
        out["lsH"].append(np.log(sH[te]).astype(np.float32))
        out["lsQ"].append(lsQ.astype(np.float32))
        out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
        out["tail"].append(ts + T * STEP > caps["primary"])
    rows = {k: np.concatenate(v) for k, v in out.items()} if out["ts"] else None
    return {"key": spec["key"], "rows": rows}


def run(specs, T, grid, workers, log, label):
    t0 = time.time()
    res = []
    with mp.get_context("fork").Pool(workers, maxtasksperchild=8) as pool:
        for j, r in enumerate(pool.imap(task, [{"spec": s, "T": T, "grid": grid} for s in specs], chunksize=1)):
            res.append(r)
            if (j + 1) % 50 == 0 or j + 1 == len(specs):
                log(f"  {label} {R12.TL[T]}: {j + 1}/{len(specs)} ({time.time() - t0:.0f}s)")
    S = R12.stack_rows(res, lambda rw: ~rw["q2"] & ~rw["tail"])
    return S


def lg(p):
    p = np.clip(p, PCLIP, 1 - PCLIP)
    return np.log(p / (1 - p))


def fit_map(S, cols):
    """unpenalised IRLS: logit p' = a_level + b * logit p over the band's columns."""
    L = lg(S["pH"][:, cols].astype(float)).ravel(order="F")
    y = S["y"][:, cols].astype(float).ravel(order="F")
    n = S["pH"].shape[0]
    k = len(cols)
    lev = np.repeat(np.arange(k), n)
    th = np.zeros(k + 1)
    th[k] = 1.0
    for _ in range(50):
        eta = th[lev] + th[k] * L
        p = expit(eta)
        w = np.maximum(p * (1 - p), 1e-12)
        g = np.zeros(k + 1)
        H = np.zeros((k + 1, k + 1))
        r = y - p
        g[:k] = np.bincount(lev, r, k)
        g[k] = np.sum(r * L)
        H[np.arange(k), np.arange(k)] = np.bincount(lev, w, k)
        H[:k, k] = H[k, :k] = np.bincount(lev, w * L, k)
        H[k, k] = np.sum(w * L * L)
        step = np.linalg.solve(H + 1e-9 * np.eye(k + 1), g)
        th += step
        if np.max(np.abs(step)) < 1e-8:
            break
    return th


def apply_map(S, maps):
    pm = np.array(S["pH"], float)
    for cols, th in maps:
        pm[:, cols] = expit(th[:len(cols)][None, :] + th[-1] * lg(pm[:, cols]))
    return np.minimum.accumulate(pm, axis=1)


def topq_R(p, y):
    o = np.argsort(p, kind="mergesort")
    top = o[int(0.8 * len(o)):]
    return float(p[top].sum() / y[top].sum()) if y[top].sum() > 0 else None


def boot_bss(S, T, col, pa, pb, seed):
    """BSS of a vs b with a crash-episode-block bootstrap 90% interval (R12 blocks)."""
    y = S["y"][:, col].astype(float)
    g, G, _ = R12.crash_blocks(S["ts"], S["sid"], y, T)
    ea, eb = np.bincount(g, (pa - y) ** 2, G), np.bincount(g, (pb - y) ** 2, G)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed]))
    idx = rng.integers(0, G, size=(NB, G))
    bs = 1 - ea[idx].sum(1) / eb[idx].sum(1)
    return float(1 - ea.sum() / eb.sum()), [float(np.quantile(bs, 0.05)), float(np.quantile(bs, 0.95))]


def cell_stats(S, T, k, P, seed):
    col = KIX[k]
    y = S["y"][:, col].astype(float)
    d = {"rows": int(len(y)), "pos": int(y.sum())}
    for name, p in P.items():
        pc = p[:, col]
        d[name] = {"R": float(pc.sum() / y.sum()) if y.sum() else None, "R_top20": topq_R(pc, y),
                   "brier": float(np.mean((pc - y) ** 2))}
    for name in P:
        if name != "fH":
            b, ci = boot_bss(S, T, col, P[name][:, col], P["fH"][:, col], seed)
            d[name]["bss_vs_fH"], d[name]["bss_vs_fH_ci90"] = b, ci
    b, ci = boot_bss(S, T, col, P["fH"][:, col], P["f"][:, col], seed + 1)
    d["fH"]["bss_vs_f"], d["fH"]["bss_vs_f_ci90"] = b, ci
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "devcheck-log.txt"), "a")

    def log(s):
        line = f"{R12.now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r13 devcheck (development only); code {R12.R112.git_sha() if hasattr(R12, 'R112') else '?'}")
    dev = R12.dev_specs(a.datasets)
    b12 = R125.b12_specs(os.path.join(a.datasets, "b12-venue-unique-prices"))
    out = {"schema": "q26-r13-devcheck/1", "label": "DEVELOPMENT ONLY (seen data)", "maps": {}, "dev": {}, "b12": {},
           "vol_mse": {}}
    for T in HS:
        Sd = run(dev, T, "6h", a.workers, log, "dev")
        Sb = run(b12, T, "1h", a.workers, log, "B12")
        maps = [(SHALLOW, fit_map(Sd, SHALLOW)), (DEEP, fit_map(Sd, DEEP))]
        out["maps"][R12.TL[T]] = {"shallow": maps[0][1].tolist(), "deep": maps[1][1].tolist()}
        log(f"  map {R12.TL[T]}: shallow slope {maps[0][1][-1]:.3f}, deep slope {maps[1][1][-1]:.3f}")
        for tag, S in (("dev", Sd), ("b12", Sb)):
            P = {"fH": S["pH"].astype(float), "f": S["pf"].astype(float), "fHQ": S["pQ"].astype(float),
                 "M": apply_map(S, maps)}
            e2H = (S["lfut"] - S["lsH"]) ** 2
            e2Q = (S["lfut"] - S["lsQ"]) ** 2
            ok = np.isfinite(e2H) & np.isfinite(e2Q)
            out["vol_mse"].setdefault(tag, {})[R12.TL[T]] = {"fH": float(e2H[ok].mean()),
                                                           "fHQ": float(e2Q[ok].mean()), "n": int(ok.sum())}
            for k in sorted({kk for TT, kk in CELLS2 if TT == T} | ({-0.15, -0.20} if T >= 12 else set())):
                c = cell_stats(S, T, k, P, 1000 * T + int(-100 * k))
                out[tag][f"{R12.TL[T]} {k}"] = c
                log(f"  {tag} {R12.TL[T]} {k}: R fH {c['fH']['R']:.3f} M {c['M']['R']:.3f}; top20 R fH "
                    f"{c['fH']['R_top20']} M {c['M']['R_top20']}; BSS M vs fH {c['M']['bss_vs_fH']:+.4f}; "
                    f"BSS fHQ vs fH {c['fHQ']['bss_vs_fH']:+.4f}; BSS fH vs f {c['fH']['bss_vs_f']:+.4f}")
            log(f"  {tag} {R12.TL[T]} vol MSE fH {out['vol_mse'][tag][R12.TL[T]]['fH']:.5f} "
                f"fHQ {out['vol_mse'][tag][R12.TL[T]]['fHQ']:.5f}")
        del Sd, Sb
    # verdicts on B12 (pass lines in the docstring, fixed before the run)
    B = out["b12"]
    c1 = [B[f"{R12.TL[T]} {k}"] for T, k in CELLS1]
    v1a = sum(c["M"]["bss_vs_fH"] >= 0 for c in c1)
    v1b = sum(abs(np.log(c["M"]["R"])) < abs(np.log(c["fH"]["R"])) for c in c1)
    v1c = sum(abs(np.log(c["M"]["R_top20"])) < abs(np.log(c["fH"]["R_top20"])) for c in c1)
    c2 = [B[f"{R12.TL[T]} {k}"] for T, k in CELLS2]
    v2a = sum(c["fHQ"]["bss_vs_fH"] > 0 for c in c2)
    v2b = sum(out["vol_mse"]["b12"][R12.TL[T]]["fHQ"] < out["vol_mse"]["b12"][R12.TL[T]]["fH"] for T in HS)
    out["verdict"] = {
        "idea1_M": {"bss_ge0": v1a, "absLnR_better": v1b, "top20_better": v1c,
                    "result": "PASS" if (v1a >= 5 and v1b >= 5 and v1c >= 5) else "FAIL"},
        "idea2_fHQ": {"bss_gt0_of9": v2a, "volmse_better_of5": v2b,
                      "result": "PASS" if (v2a >= 6 and v2b >= 4) else "FAIL"}}
    log("VERDICT (development only): " + json.dumps(out["verdict"]))
    out["finished_utc"] = R12.now_iso()
    with open(os.path.join(a.out, "devcheck-r13.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    log("END")


if __name__ == "__main__":
    main()
