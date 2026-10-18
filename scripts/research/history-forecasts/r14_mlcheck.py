"""Q26 ML-levers deepen memo, external check (DEVELOPMENT ONLY, seen data). Not a preregistered test.

membrane-board design/q26-ml-levers-deepen-2026-10-18.md, section "Development check". It tests the core claim of the
memo's top lever (label efficiency through distribution regression on the running minimum):

  CLAIM. One recalibration of the (fH) running-minimum CDF, fitted jointly on a DENSE grid of thresholds (every window
  gives a label at every threshold, so deep thresholds borrow strength from shallow ones) with coefficients that are
  smooth in the threshold, matches or beats per-level recalibration of the touch odds on Brier and calibration
  out of sample, while using far fewer parameters.

Models (all fitted ONCE per T on the development pool, frozen, applied unchanged to the check set):
  fH  : the A6/R12 (fH) touch odds (FHS of HAR-standardised running minima), running minimum across levels.
  PL  : per-level logistic recalibration, logit p' = a_k + b_k * logit p, one fit per scored level  (2 x 10 = 20 params)
  PB  : the r13_devcheck map M, per-level intercept + per-band slope (shallow / deep)                (10 + 2 = 12 params)
  DR  : distribution regression on the dense grid G (17 thresholds -1% .. -40%, which contains the 10 scored levels):
        logit p'(x) = a0 + a1 u + a2 u^2 + (b0 + b1 u) * logit p(x),  u = ln(-ln(1 + k)) - ln(0.1)      (5 params)
  All outputs: running minimum across levels; p clipped to [1e-4, 1 - 1e-4] before any logit.

Data. Fit set: the R12 development pool (277 seen series), 6-hourly origins, A6.6 folds, 2026Q2 windows dropped.
Check set: B12 (OKX + Bybit; read by R12.5 and r13_devcheck, grade C), 6-HOURLY origins (not hourly: memory), R12.5
row rules (30-day tail of ended series dropped, 2026Q2 dropped). T in {12 h, 1 d, 3 d}; scored levels = R12 LEVELS.

PASS LINE (stated before the run). On the check set, deep cells = levels -15% .. -40% at the three horizons (15 cells);
a cell is eligible when it has >= 20 positive rows.
  P1: for each T, Brier summed over the 10 scored levels is no larger for DR than for PL (3 of 3 horizons);
  P2: BSS(DR vs PL) >= 0 in >= 2/3 of the eligible deep cells;
  P3: median over eligible deep cells of |ln R| is <= the PL median + 0.02 (R = sum p / sum y).
PASS iff P1 and P2 and P3. Otherwise FAIL.

Reported only: the same comparisons vs PB and fH; per-cell R, top-quintile R, BSS with 90% crash-episode-block (R12)
intervals; the fitted coefficients; and a POWER read for the evaluation lever: for DR vs fH, t = mean / SE of the
weekly-block sum of Brier differences (a) per cell and (b) summed over the 10 levels (a discrete threshold-weighted
CRPS on the running minimum, Matheson-Winkler / Gneiting-Ranjan), ratio (b) / max over cells of (a).

  python3 r14_mlcheck.py --datasets DS --out OUT [--workers 3]

No address, key or secret is read or written. Nothing here is blind evidence and nothing ships from it.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import multiprocessing as mp  # noqa: E402
import subprocess  # noqa: E402
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
HS = (12, 24, 72)
LEVELS = R12.LEVELS
GRID = (-0.01, -0.015, -0.02, -0.03, -0.04, -0.05, -0.07, -0.085, -0.10, -0.125, -0.15, -0.175, -0.20, -0.25,
        -0.30, -0.35, -0.40)
GI = np.array([GRID.index(k) for k in LEVELS])          # scored levels inside the dense grid
LNG = np.log1p(np.array(GRID))
U = np.log(-LNG) - np.log(0.1)
SHALLOW = [j for j, k in enumerate(LEVELS) if k >= -0.10]
DEEP = [j for j, k in enumerate(LEVELS) if k <= -0.15]
PCLIP = 1e-4
SEED = 20261814
NB = 2000
MIN_POS = 20


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "?"


def task(a):
    spec, T, = a["spec"], a["T"]
    ser, folds, caps = R12.load_series(spec)
    P6 = A6.Prep6(ser, T, with_fbL=False)
    P, n = P6.P, P6.n
    ts_all = ser.base_ts + STEP * np.arange(n)
    i_all = np.arange(n)
    scale = P.scale
    out = {k: [] for k in ("ts", "pG", "yG", "y", "q2", "tail")}
    nbad = 0
    for f in folds:
        qs, qe = f["qs_i"], min(f["qe_i"], n)
        lim = qs - T
        tr = i_all <= lim
        cH, _ = P6.har_coef(qs)
        sH = P6.sigma_H(cH)
        zH, vH = P6.z_of(sH)
        te = np.arange(qs, qe)
        te = te[P.lab_ok[te] & (ts_all[te] + T * STEP <= caps["full"])]
        te = te[ts_all[te] % (6 * STEP) == 0]
        if len(te) == 0:
            continue
        with np.errstate(invalid="ignore", divide="ignore"):
            thrG = LNG[None, :] / (sH[te][:, None] * scale)
            thrGf = LNG[None, :] / (ser.sigma[te][:, None] * scale)
        pG = M2.fhs_predict(zH[vH & tr], thrG)
        pf = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], thrGf)
        fb = ~np.all(np.isfinite(pG), axis=1)
        pG[fb] = pf[fb]
        keep = np.all(np.isfinite(pG), axis=1) & np.isfinite(P.depth[te])
        te, pG = te[keep], pG[keep]
        if len(te) == 0:
            continue
        yG = (P.depth[te][:, None] <= LNG[None, :]).astype(np.int8)
        y = P.Y[te].astype(np.int8)
        nbad += int(np.sum(yG[:, GI] != y))
        ts = ts_all[te]
        out["ts"].append(ts)
        out["pG"].append(np.minimum.accumulate(pG, axis=1).astype(np.float32))
        out["yG"].append(yG)
        out["y"].append(y)
        out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
        out["tail"].append(ts + T * STEP > caps["primary"])
    rows = {k: np.concatenate(v) for k, v in out.items()} if out["ts"] else None
    return {"key": spec["key"], "rows": rows, "label_mismatch": nbad}


def run(specs, T, workers, log, label):
    t0 = time.time()
    res, mism = [], 0
    with mp.get_context("fork").Pool(workers, maxtasksperchild=8) as pool:
        for j, r in enumerate(pool.imap(task, [{"spec": s, "T": T} for s in specs], chunksize=1)):
            mism += r.pop("label_mismatch")
            res.append(r)
            if (j + 1) % 50 == 0 or j + 1 == len(specs):
                log(f"  {label} {R12.TL[T]}: {j + 1}/{len(specs)} ({time.time() - t0:.0f}s)")
    S = R12.stack_rows(res, lambda rw: ~rw["q2"] & ~rw["tail"])
    return S, mism


def lg(p):
    p = np.clip(np.asarray(p, float), PCLIP, 1 - PCLIP)
    return np.log(p / (1 - p))


def irls(cols_iter, k, maxit=60):
    """generic logistic IRLS; cols_iter(theta) yields (X (m,k), y (m,)) chunks."""
    th = np.zeros(k)
    for _ in range(maxit):
        g = np.zeros(k)
        H = np.zeros((k, k))
        for X, y in cols_iter():
            p = expit(X @ th)
            w = np.maximum(p * (1 - p), 1e-12)
            g += X.T @ (y - p)
            H += (X * w[:, None]).T @ X
        step = np.linalg.solve(H + 1e-9 * np.eye(k), g)
        th += step
        if np.max(np.abs(step)) < 1e-8:
            break
    return th


def dr_design(L, u):
    return np.column_stack([np.ones_like(L), np.full_like(L, u), np.full_like(L, u * u), L, L * u])


def fit_dr(S):
    pG, yG = S["pG"], S["yG"]

    def it():
        for j in range(len(GRID)):
            yield dr_design(lg(pG[:, j]), U[j]), yG[:, j].astype(float)
    th = irls(it, 5)
    return th


def apply_dr(pG, th):
    out = np.empty((pG.shape[0], len(LEVELS)))
    for c, j in enumerate(GI):
        out[:, c] = expit(dr_design(lg(pG[:, j]), U[j]) @ th)
    return np.minimum.accumulate(out, axis=1)


def fit_pl(S):
    ths = []
    for c, j in enumerate(GI):
        L = lg(S["pG"][:, j])
        y = S["y"][:, c].astype(float)
        X = np.column_stack([np.ones_like(L), L])
        ths.append(irls(lambda: iter([(X, y)]), 2))
    return ths


def apply_pl(pG, ths):
    out = np.empty((pG.shape[0], len(LEVELS)))
    for c, j in enumerate(GI):
        out[:, c] = expit(ths[c][0] + ths[c][1] * lg(pG[:, j]))
    return np.minimum.accumulate(out, axis=1)


def fit_pb(S, cols):
    k = len(cols)
    n = S["pG"].shape[0]

    def it():
        for c_i, c in enumerate(cols):
            X = np.zeros((n, k + 1))
            X[:, c_i] = 1.0
            X[:, k] = lg(S["pG"][:, GI[c]])
            yield X, S["y"][:, c].astype(float)
    return irls(it, k + 1)


def apply_pb(pG, maps):
    out = np.empty((pG.shape[0], len(LEVELS)))
    for cols, th in maps:
        for c_i, c in enumerate(cols):
            out[:, c] = expit(th[c_i] + th[-1] * lg(pG[:, GI[c]]))
    return np.minimum.accumulate(out, axis=1)


def topq_R(p, y):
    o = np.argsort(p, kind="mergesort")
    top = o[int(0.8 * len(o)):]
    return float(p[top].sum() / y[top].sum()) if y[top].sum() > 0 else None


def boot_bss(ts, sid, y, T, pa, pb, seed):
    g, G, _ = R12.crash_blocks(ts, sid, y, T)
    ea, eb = np.bincount(g, (pa - y) ** 2, G), np.bincount(g, (pb - y) ** 2, G)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed]))
    idx = rng.integers(0, G, size=(NB, G))
    bs = 1 - ea[idx].sum(1) / eb[idx].sum(1)
    return float(1 - ea.sum() / eb.sum()), [float(np.quantile(bs, 0.05)), float(np.quantile(bs, 0.95))]


def week_t(ts, d):
    w = R12.wk(ts)
    _, inv = np.unique(w, return_inverse=True)
    s = np.bincount(inv, d)
    G = len(s)
    return float(s.mean() / (s.std(ddof=1) / np.sqrt(G))) if G > 2 and s.std() > 0 else None


def score(S, T, P, log, tag):
    res = {}
    for c, k in enumerate(LEVELS):
        y = S["y"][:, c].astype(float)
        d = {"rows": int(len(y)), "pos": int(y.sum())}
        for name, p in P.items():
            pc = p[:, c]
            d[name] = {"R": float(pc.sum() / y.sum()) if y.sum() else None, "R_top20": topq_R(pc, y),
                       "brier": float(np.mean((pc - y) ** 2))}
        if y.sum() > 0:
            for a_, b_ in (("DR", "PL"), ("DR", "PB"), ("DR", "fH"), ("PL", "fH"), ("PB", "fH")):
                b, ci = boot_bss(S["ts"], S["sid"], y, T, P[a_][:, c], P[b_][:, c], 1000 * T + c)
                d[f"bss_{a_}_vs_{b_}"], d[f"bss_{a_}_vs_{b_}_ci90"] = b, ci
            d["t_week_DR_vs_fH"] = week_t(S["ts"], (P["fH"][:, c] - y) ** 2 - (P["DR"][:, c] - y) ** 2)
        res[f"{R12.TL[T]} {k}"] = d
        if tag == "check":
            log(f"  {tag} {R12.TL[T]} {k}: pos {d['pos']}; R fH {d['fH']['R']} PL {d['PL']['R']} DR {d['DR']['R']}; "
                f"BSS DR vs PL {d.get('bss_DR_vs_PL')}")
    yy = S["y"].astype(float)
    tot = {name: float(np.sum(np.mean((p - yy) ** 2, axis=0))) for name, p in P.items()}
    dsum = np.sum((P["fH"] - yy) ** 2 - (P["DR"] - yy) ** 2, axis=1)
    return res, tot, week_t(S["ts"], dsum)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "mlcheck-log.txt"), "a")

    def log(s):
        line = f"{R12.now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    sha = git_sha()
    log(f"START r14 mlcheck (development only); code {sha}")
    dev = R12.dev_specs(a.datasets)
    b12 = R125.b12_specs(os.path.join(a.datasets, "b12-venue-unique-prices"))
    out = {"schema": "q26-r14-mlcheck/1", "label": "DEVELOPMENT ONLY (seen data)", "code": sha,
           "started_utc": R12.now_iso(), "grid": list(GRID), "levels": list(LEVELS), "params": {"PL": 20, "PB": 12,
                                                                                               "DR": 5},
           "fits": {}, "dev": {}, "check": {}, "sum_brier": {}, "power": {}, "label_mismatch": {}}
    for T in HS:
        Sd, md = run(dev, T, a.workers, log, "dev")
        Sc, mc = run(b12, T, a.workers, log, "B12")
        out["label_mismatch"][R12.TL[T]] = {"dev": md, "check": mc}
        th_dr = fit_dr(Sd)
        th_pl = fit_pl(Sd)
        maps_pb = [(SHALLOW, fit_pb(Sd, SHALLOW)), (DEEP, fit_pb(Sd, DEEP))]
        out["fits"][R12.TL[T]] = {"DR": th_dr.tolist(), "PL": [t.tolist() for t in th_pl],
                                  "PB": [m[1].tolist() for m in maps_pb], "dev_rows": int(Sd["pG"].shape[0]),
                                  "check_rows": int(Sc["pG"].shape[0])}
        log(f"  fits {R12.TL[T]}: DR {np.round(th_dr, 4).tolist()}; rows dev {Sd['pG'].shape[0]} "
            f"check {Sc['pG'].shape[0]}; label mismatch dev {md} check {mc}")
        for tag, S in (("dev", Sd), ("check", Sc)):
            pH = np.array(S["pG"][:, GI], float)
            P = {"fH": pH, "PL": apply_pl(S["pG"], th_pl), "PB": apply_pb(S["pG"], maps_pb),
                 "DR": apply_dr(S["pG"], th_dr)}
            cells, tot, t_sum = score(S, T, P, log, tag)
            out[tag].update(cells)
            out["sum_brier"].setdefault(tag, {})[R12.TL[T]] = tot
            tc = [c["t_week_DR_vs_fH"] for c in cells.values() if c.get("t_week_DR_vs_fH") is not None]
            out["power"].setdefault(tag, {})[R12.TL[T]] = {
                "t_sum_levels": t_sum, "t_cells_max_abs": float(max(np.abs(tc))) if tc else None,
                "ratio": float(abs(t_sum) / max(np.abs(tc))) if tc and t_sum is not None else None}
            log(f"  {tag} {R12.TL[T]} sum Brier {json.dumps({k: round(v, 6) for k, v in tot.items()})}; "
                f"power t_sum {t_sum} vs max cell {out['power'][tag][R12.TL[T]]['t_cells_max_abs']}")
        del Sd, Sc
    C = out["check"]
    p1 = int(sum(out["sum_brier"]["check"][R12.TL[T]]["DR"] <= out["sum_brier"]["check"][R12.TL[T]]["PL"]
                 for T in HS))
    deep = [C[f"{R12.TL[T]} {LEVELS[c]}"] for T in HS for c in DEEP]
    elig = [d for d in deep if d["pos"] >= MIN_POS]
    p2n = int(sum(d["bss_DR_vs_PL"] >= 0 for d in elig))
    medDR = float(np.median([abs(np.log(d["DR"]["R"])) for d in elig]))
    medPL = float(np.median([abs(np.log(d["PL"]["R"])) for d in elig]))
    ok = (p1 == 3) and (p2n * 3 >= 2 * len(elig)) and (medDR <= medPL + 0.02)
    out["verdict"] = {"P1_horizons_DR_le_PL": p1, "P2_deep_bss_ge0": p2n, "P2_eligible": len(elig),
                      "P3_median_abs_lnR_DR": medDR, "P3_median_abs_lnR_PL": medPL,
                      "result": "PASS" if ok else "FAIL"}
    log("VERDICT (development only): " + json.dumps(out["verdict"]))
    out["finished_utc"] = R12.now_iso()
    with open(os.path.join(a.out, "mlcheck-r14.json"), "w") as fh:
        json.dump(out, fh, indent=1, default=float)
    log("END")


if __name__ == "__main__":
    main()
