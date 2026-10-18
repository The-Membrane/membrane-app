"""Q26 Round 12: deep-tail touch odds at 1 h - 3 d (R12.1) and an over-forecast correction for (fH) (R12.2).

membrane-board design/Q26_ROUND12_PREREG.md (registered at 9f3bc92), Deviations D-R12.1a / D-R12.2a (readings, before any
blind read), D-R12.1b / D-R12.2b (results). Blind sets B9 (Binance USDT pairs delisted before 2026-10-17, primary) and
B10 (Bitfinex USD pre-Binance windows, secondary): design/q26-blind-set-inventory-2026-10-17.md section 8.

  python3 r12_tail.py dev      --datasets DS --out OUT [--workers 4]
        development run on seen data only: (fH), (f), (a), (e), candidates C1-C4 and corrections K1-K3; pooled parts
        fitted and frozen; selection (R12.1d, R12.2b); power numbers. Reads no blind data.
  python3 r12_tail.py acquire  --datasets DS --acq ACQ
        outcome-blind builder: B9 monthly zips streamed (sha256 == published CHECKSUM, else STOP), compact hourly grids,
        raw zips never stored; B10 Bitfinex pages (sha256 per page). Prints counts only.
  python3 r12_tail.py counts   --acq ACQ --registered COUNTS_JSON
        counts-only check (registered definitions); STOP unless every registered count is equal.
  python3 r12_tail.py freeze   --datasets DS --acq ACQ --dev DEVOUT --out OUT
  python3 r12_tail.py run      --item r12.1|r12.2 --acq ACQ --dev DEVOUT --out OUT [--workers 4]

No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import bisect  # noqa: E402
import csv  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.optimize import minimize_scalar  # noqa: E402
from scipy.special import expit  # noqa: E402
from scipy.stats import norm  # noqa: E402
from scipy.stats import t as student_t  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a_touch as A  # noqa: E402
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402
import r112_combine as R112  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND12_PREREG.md", "registered_at": "9f3bc92",
          "deviations": "D-R12.1a, D-R12.2a (readings); D-R12.1b, D-R12.2b (results)"}
STEP, DAY, WEEK = 3600, 86400, 7 * 86400
MON0 = 345600                                   # 1970-01-05T00:00Z (Monday)
HORIZONS = (1, 3, 6, 12, 24, 72)
TL = {1: "1h", 3: "3h", 6: "6h", 12: "12h", 24: "1d", 72: "3d"}
LEVELS = tuple(A.LEVELS["ETH"])                 # -2% .. -40%
K = len(LEVELS)
DEEP = (-0.15, -0.20, -0.25, -0.30, -0.40)
DI = np.array([LEVELS.index(k) for k in DEEP])
SHOWN = {1: (-0.02, -0.03, -0.05), 3: (-0.02, -0.03, -0.05, -0.07, -0.10),
         12: (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15)}
BAND = {-0.02: 0, -0.03: 0, -0.05: 0, -0.07: 1, -0.10: 1, -0.15: 1}   # A4 depth bands
END = A.utc("2026-10-01T00:00:00Z")
Q2_START, Q2_END = A.utc("2026-04-01T00:00:00Z"), A.utc("2026-07-01T00:00:00Z")
LAST_FOLD = (2026, 3)
WARMUP_DAYS = 365
ISSUE_6H = 6 * STEP
MERGE_H = 72                                    # series-episode / cluster / declustering gap (hours)
TAIL_DAYS = 30                                  # B9 delisting tail
SQ8760 = math.sqrt(8760.0)

# candidates (R12.1b) -- constants fixed at registration
C1_Q = 0.95
XI_CLIP = (0.0, 0.5)
JUMP_SIG = 4.0
N168 = 168
C2_LAMBDA_FRAC = 0.01
C4_N0 = 20.0
SIMPLICITY = ("C4", "C1", "C2", "C3")
CANDS = ("C1", "C2", "C3", "C4")
CMPS = ("fH", "f", "a", "e")
C1_MIN_EXC = 5                                  # D-R12-I3: fewer declustered own exceedances -> C1 = (fH)
P_CLIP = 1e-4
# corrections (R12.2a)
K2_W = (7, 30, 90)
K2_KAPPA = (10, 20, 50)
K2_CLIP = (0.5, 1.5)
# tests
N_BOOT = 10000
SEED_R121, SEED_R122 = 20261812, 20261822
ALPHA_FAM = 0.05
R_BAND_121 = (0.8, 1.25)
R_BAND_122 = (0.9, 1.1)
MIN_POS_BLOCKS = 30
HAC_LAG = 168
Z_POW_121 = float(norm.ppf(1 - 0.05 / 30) + norm.ppf(0.8))
Z_POW_122 = float(norm.ppf(1 - 0.05 / 3) + norm.ppf(0.8))
UA = {"User-Agent": "membrane-research/1.0"}


def k2_rules():
    out = [("K1", None, None)]
    for W, kap in sorted(((W, k) for W in K2_W for k in K2_KAPPA), key=lambda x: x[0] * x[1]):
        out.append(("K2", W, kap))
    for W, kap in sorted(((W, k) for W in K2_W for k in K2_KAPPA), key=lambda x: x[0] * x[1]):
        out.append(("K3", W, kap))
    return out


KRULES = k2_rules()                             # simplicity order: K1, K2 by W*kappa, K3 by W*kappa
KNAMES = [r[0] if r[1] is None else f"{r[0]}_W{r[1]}_k{r[2]}" for r in KRULES]

DECISIONS = {
    "D-R12-I1": "Development series (seen): ETH and BTC long spliced Chainlink series (A6 build, folds 2021Q1-2026Q3); "
                "P1 Kraken ETH; the A2 eight; the A3 ten; blind sets 3-7; blind8 (56). 277 series. Generic series folds "
                "per A6.6 (first quarter >= 365 d after the first kline to 2026Q3). (a) uses each series' own grid.",
    "D-R12-I2": "Development scoring and every pooled frozen part (library, xi_T, G_T, (e), C2 maps, K1 offsets) use "
                "the 6-hourly development origin grid (00/06/12/18Z, A6 practice); the jump-rate Poisson regression uses "
                "every test-fold hour. Rows whose window meets 2026Q2 never enter a fit or a score. Per-series parts "
                "(sigma_H, FHS training sets, C1 u/beta, C4 n_k, C3 p_D) use every hourly training origin.",
    "D-R12-I3": "C1: own exceedances are training-origin depths e = -m above u (in-fold 95th percentile, numpy linear); "
                "declustered as one maximum per run with gaps <= 72 h; fewer than 5 declustered exceedances -> C1 = (fH). "
                "xi_T: profile likelihood over the pooled development declustered exceedances (series-own u at its 95th "
                "percentile of e over its scored rows, series-own beta), then clipped to [0, 0.5].",
    "D-R12-I4": "C2: map rows are the pooled out-of-fold development test rows (their raw (fH) forecasts are as-of); a "
                "walk-forward map for quarter Q uses rows with t' + T <= Q_start; no rows -> identity. v uses sigma_ref "
                "= the median of the fold's sigma_H over every earlier origin. Rows without x or v take (fH). Applied to "
                "the raw (fH) before the running minimum.",
    "D-R12-I5": "C3: jump hour j: r_j = ln(C_j / C_{j-1}) < -4 sigma_H(t_j; 1 h)/sqrt(8760), sigma_H(.; 1 h) with the "
                "fold's 1 h HAR coefficients (undefined -> not a jump). Jump size e_j(T) = -r_j / (sigma_H(t_j; T) "
                "sqrt(T/8760)); G_T(x) = share of pooled development jump hours with e >= x, beyond the pooled 95th "
                "percentile a GPD (xi, beta MLE on per-series 72 h declustered exceedances, xi clipped to [0, 0.5]). "
                "lambda: Poisson regression of the hourly jump indicator on ln(1 + N_168) over development test-fold hours.",
    "D-R12-I6": "C4: library = standardised minima m at development scored rows (6-hourly grid), per T. n_k = own in-fold "
                "series-episodes (72 h merge) among training origins with m <= z_k(t).",
    "D-R12-I7": "Dev selection SE: blocks per T from the -15% series-episodes (a positive at a deeper level is "
                "positive at -15%), crash-episode block rule as registered; CR1 SE of the mean paired difference "
                "against the lowest-Brier candidate. Power G* uses mean and SD of per-positive-block summed d at each cell.",
    "D-R12-I8": "R12.2: K2 sums run over the series' own resolved test origins (label defined, (fH) defined) with "
                "t - 24 W <= t' <= t - T, pooled over the T's shown levels, every hour; before any resolved origin "
                "R = kappa/kappa = 1. K1 delta per (T, band) is the logistic MLE offset on the pooled development rows; "
                "K3 applies K1 (with its monotone fix and clip), then K2 on the K1 output.",
    "D-R12-I9": "Scored blind rows: hourly origins inside a fold (A6.6), label defined, window end <= min(2026-10-01, "
                "same-asset cut, last kline + 1 h - 30 d for B9 primary), outside 2026Q2 windows, (fH)/(f)/(a) finite. "
                "Blocks are rebuilt on the scored rows of each cell.",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, obj):
    return R112.write_json(path, obj)


def logit(p):
    p = np.clip(p, P_CLIP, 1 - P_CLIP)
    return np.log(p) - np.log1p(-p)


def wk(t):
    return (np.asarray(t, np.int64) - MON0) // WEEK


# =============================================================================================
# series loading
# =============================================================================================
def load_json_grid(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    d = json.loads(raw)
    st = int(d["startTs"])
    cols = {c: np.array([np.nan if v is None else float(v) for v in d["columns"][c]], float)
            for c in ("close", "low", "high")}
    return st, cols


def generic_folds(ser, st):
    fl = M3.quarters(M3.first_quarter_after(st, WARMUP_DAYS), LAST_FOLD, ser)
    return [f for f in fl if f["qs_i"] < ser.n_orig]


_CHAIN = {}


def load_series(spec):
    """-> ser, folds, caps {'full': ts, 'primary': ts}."""
    kind = spec["kind"]
    if kind == "chain":
        if "D" not in _CHAIN:
            D = M3.build_dev(spec["datasets"])
            A6.attach_highs_dev(spec["datasets"], D)
            _CHAIN["D"] = D
        ser = _CHAIN["D"][f"long:{spec['asset']}"]
        folds = [f for f in M3.dev_folds(ser) if f["qs_i"] < ser.n_orig]
        return ser, folds, {"full": END, "primary": END}
    st, cols = load_json_grid(spec["path"])
    if "slice" in spec:                       # B9/B10: cut and redenomination split applied by index
        i0, i1 = spec["slice"]
        st = st + STEP * i0
        cols = {k: v[i0:i1] for k, v in cols.items()}
    ser = M3.S3(spec["key"], spec.get("asset", spec["key"]), "binance", cols["close"], cols["low"], LEVELS, st, st)
    A6.attach_high(ser, cols["high"])
    folds = generic_folds(ser, st)
    return ser, folds, {"full": int(spec.get("cap_full", END)), "primary": int(spec.get("cap_primary", END))}


def dev_specs(datasets):
    sp = [{"key": "dev:ETH", "kind": "chain", "asset": "ETH", "datasets": datasets},
          {"key": "dev:BTC", "kind": "chain", "asset": "BTC", "datasets": datasets},
          {"key": "P1:KRAKEN-ETH", "kind": "grid", "asset": "ETH",
           "path": os.path.join(datasets, "history-forecasts/r11/r1110-run-a91e04ad/acq/kraken-xethzusd-1h.json")}]
    for p in M2.HOLDOUTS:
        sp.append({"key": f"A2:{p}", "kind": "grid", "path": os.path.join(datasets, M2.KLINES[p][0])})
    fb = os.path.join(datasets, "final-blind-prices")
    for n in sorted(os.listdir(fb)):
        if n.startswith("binance-") and n.endswith("-1h.json"):
            sp.append({"key": f"A3:{n[8:-8]}", "kind": "grid", "path": os.path.join(fb, n)})
    for j in (3, 4, 5, 6, 7):
        d = os.path.join(datasets, f"blind{j}-prices")
        for n in sorted(os.listdir(d)):
            if n.endswith("-1h.json"):
                sp.append({"key": f"blind{j}:{n.split('-')[1]}", "kind": "grid", "path": os.path.join(d, n)})
    d = os.path.join(datasets, "history-forecasts/r11/r1110-p3-run-9ab156bb/acq")
    for n in sorted(os.listdir(d)):
        if n.startswith("binance-") and n.endswith("-1h.json.gz"):
            sp.append({"key": f"blind8:{n.split('-')[1]}", "kind": "grid", "path": os.path.join(d, n)})
    return sp


def volchg(ser):
    v = A6.parkinson_v(ser.high, ser.low)
    a24 = A6.window_mean_null_rule(v, 24, ser.start_i)
    a336 = A6.window_mean_null_rule(v, 336, ser.start_i)
    with np.errstate(invalid="ignore", divide="ignore"):
        x = 0.5 * np.log(a24 / a336)
    x[~np.isfinite(x)] = np.nan
    return x


# =============================================================================================
# per (series, T) worker: everything that uses only the series' own data
# =============================================================================================
def decluster_max(times, vals, gap=MERGE_H):
    """one maximum per run of exceedances with gaps <= gap hours; times sorted ascending."""
    if len(times) == 0:
        return np.zeros(0)
    brk = np.concatenate([[0], np.where(np.diff(times) > gap)[0] + 1])
    return np.maximum.reduceat(vals, brk)


def episode_steps(times_sorted_by_m):
    """running series-episode count (72 h merge) as points are added in the given order."""
    lst, out, c = [], np.zeros(len(times_sorted_by_m), np.int32), 0
    for j, t in enumerate(times_sorted_by_m.tolist()):
        k = bisect.bisect_left(lst, t)
        p = lst[k - 1] if k > 0 else None
        s = lst[k] if k < len(lst) else None
        a = p is not None and t - p <= MERGE_H
        b = s is not None and s - t <= MERGE_H
        ab = p is not None and s is not None and s - p <= MERGE_H
        c += 1 - int(a) - int(b) + int(ab)
        lst.insert(k, t)
        out[j] = c
    return out


def running_median_at(base_sorted, stream, start, want):
    """median of base + stream[start..t-1] at each t in want (sorted, >= start)."""
    L = list(base_sorted)
    out = np.full(len(want), np.nan)
    t = start
    for j, w in enumerate(want.tolist()):
        while t < w:
            v = stream[t]
            if v == v:
                bisect.insort(L, v)
            t += 1
        m = len(L)
        if m:
            out[j] = L[m // 2] if m % 2 else 0.5 * (L[m // 2 - 1] + L[m // 2])
    return out


def series_task(a):
    spec, T, grid = a["spec"], a["T"], a["grid"]
    ser, folds, caps = load_series(spec)
    P6 = A6.Prep6(ser, T, with_fbL=False)
    P6_1 = P6 if T == 1 else A6.Prep6(ser, 1, with_fbL=False)
    P = P6.P
    n, N = P6.n, ser.N
    scale = P.scale
    r = np.full(N, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[1:] = np.log(ser.close[1:] / ser.close[:-1])
    xv = volchg(ser)
    ts_all = ser.base_ts + STEP * np.arange(n)
    lab = P.lab_ok
    want_hourly = T in SHOWN
    shown_ix = np.array([LEVELS.index(k) for k in SHOWN[T]]) if want_hourly else None
    R = {k: [] for k in ("ts", "fold", "y", "pH", "pf", "pa", "fb", "thr", "pD", "n168", "nk", "x", "v", "m",
                         "q2", "tail")}
    H = {k: [] for k in ("ts", "y", "p")}
    fold_rec, jump_n, jump_j, jump_e, jump_t = [], np.zeros(N168 + 1), np.zeros(N168 + 1), [], []
    i_all = np.arange(n)
    for gid, f in enumerate(folds):
        qs, qe = f["qs_i"], min(f["qe_i"], n)
        lim = qs - T
        tr = i_all <= lim
        coef, _ = P6.har_coef(qs)
        sH = P6.sigma_H(coef)
        zH, vH = P6.z_of(sH)
        trH = vH & tr
        c1, _ = P6_1.har_coef(qs)
        s1 = P6_1.sigma_H(c1)
        with np.errstate(invalid="ignore"):
            jump = r < -JUMP_SIG * s1[:N] / SQ8760
        cJ = np.concatenate([[0], np.cumsum(jump)])
        wj = cJ[np.minimum(i_all + T, N)] - cJ[np.minimum(i_all, N)]
        n168 = cJ[np.minimum(i_all, N)] - cJ[np.maximum(np.minimum(i_all, N) - N168, 0)]
        # jump pooled material (test-fold hours, outside 2026Q2, before the cap)
        jh = np.arange(qs, min(qe, N))
        tj = ser.base_ts + STEP * jh
        okj = np.isfinite(s1[jh]) & np.isfinite(r[jh]) & (tj + STEP <= caps["full"]) & \
            ~((tj + STEP > Q2_START) & (tj < Q2_END))
        jh = jh[okj]
        np.add.at(jump_n, n168[jh], 1)
        np.add.at(jump_j, n168[jh], jump[jh].astype(float))
        jj = jh[jump[jh]]
        with np.errstate(invalid="ignore", divide="ignore"):
            ej = -r[jj] / (sH[jj] * scale)
        okE = np.isfinite(ej)
        jump_e.append(ej[okE])
        jump_t.append(jj[okE])
        # test origins
        te_h = np.arange(qs, qe)
        te_h = te_h[lab[te_h] & (ts_all[te_h] + T * STEP <= caps["full"])]
        if len(te_h) == 0:
            continue
        sH_h = P6.sigma_H(coef, P6.X[te_h], P6.okX[te_h])
        thr_h = P.thresholds(sH_h)
        pH_h = M2.fhs_predict(zH[trH], thr_h)
        pf_h = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], P.thresholds(ser.sigma[te_h]))
        fb_h = ~np.all(np.isfinite(pH_h), axis=1)
        pH_h[fb_h] = pf_h[fb_h]
        if want_hourly:
            okh = np.all(np.isfinite(pH_h), axis=1)
            H["ts"].append(ts_all[te_h[okh]])
            H["y"].append(P.Y[te_h[okh]][:, shown_ix].astype(np.int8))
            H["p"].append(np.minimum.accumulate(pH_h[okh], axis=1)[:, shown_ix].astype(np.float32))
        gsel = (ts_all[te_h] % ISSUE_6H == 0) if grid == "6h" else np.ones(len(te_h), bool)
        te = te_h[gsel]
        if len(te) == 0:
            continue
        sH_te, thr, pH, pf, fb = sH_h[gsel], thr_h[gsel], pH_h[gsel], pf_h[gsel], fb_h[gsel]
        pa = np.tile(P.freq_upto(lim), (len(te), 1))
        keep = np.all(np.isfinite(pH), axis=1) & np.all(np.isfinite(pf), axis=1) & np.all(np.isfinite(pa), axis=1)
        if not keep.any():
            continue
        te, sH_te, thr, pH, pf, pa, fb = te[keep], sH_te[keep], thr[keep], pH[keep], pf[keep], pa[keep], fb[keep]
        thr_d = thr[:, DI]
        # C1 own tail
        idx_tr = np.where(trH)[0]
        e_tr = -zH[idx_tr]
        rec = {"gid": gid, "name": f["name"], "qs_ts": int(f["qs_ts"]), "n_tr": int(len(idx_tr)), "u": None,
               "phat": None, "yv": np.zeros(0, np.float32)}
        if len(idx_tr) >= 20:
            u = float(np.quantile(e_tr, C1_Q))
            exc = e_tr > u
            yv = decluster_max(idx_tr[exc], e_tr[exc]) - u
            rec.update(u=u, phat=float(exc.mean()), yv=yv.astype(np.float64))
        fold_rec.append(rec)
        # C3 no-jump FHS
        pD = M2.fhs_predict(zH[trH & (wj == 0)], thr)[:, DI]
        # C4 own episode counts
        nk = np.zeros((len(te), len(DI)), np.int32)
        okt = np.isfinite(thr_d[:, 0]) & ~fb
        if okt.any():
            zmax = float(np.max(thr_d[okt, 0]))
            sub = idx_tr[zH[idx_tr] <= zmax]
            if len(sub):
                o = np.argsort(zH[sub], kind="mergesort")
                ms, tsrt = zH[sub][o], sub[o]
                steps = episode_steps(tsrt)
                kk = np.searchsorted(ms, np.where(np.isfinite(thr_d), thr_d, -np.inf), side="right")
                nk = np.where(kk > 0, steps[np.maximum(kk - 1, 0)], 0).astype(np.int32)
        # C2 features
        base = np.sort(sH[:qs][np.isfinite(sH[:qs])])
        sref = running_median_at(base, sH, qs, te)
        with np.errstate(invalid="ignore", divide="ignore"):
            v = np.log(sH_te / sref)
            m = P.depth[te] / (sH_te * scale)
        ts = ts_all[te]
        R["ts"].append(ts)
        R["fold"].append(np.full(len(te), gid, np.int32))
        R["y"].append(P.Y[te].astype(np.int8))
        R["pH"].append(pH.astype(np.float32))
        R["pf"].append(pf.astype(np.float32))
        R["pa"].append(pa.astype(np.float32))
        R["fb"].append(fb)
        R["thr"].append(thr_d.astype(np.float32))
        R["pD"].append(pD.astype(np.float32))
        R["n168"].append(n168[te].astype(np.int16))
        R["nk"].append(nk)
        R["x"].append(xv[te].astype(np.float32))
        R["v"].append(v.astype(np.float32))
        R["m"].append(m.astype(np.float32))
        R["q2"].append((ts + T * STEP > Q2_START) & (ts < Q2_END))
        R["tail"].append(ts + T * STEP > caps["primary"])
    out = {"key": spec["key"], "T": T, "folds": fold_rec, "jump_n": jump_n, "jump_j": jump_j,
           "jump_e": np.concatenate(jump_e) if jump_e else np.zeros(0),
           "jump_t": np.concatenate(jump_t) if jump_t else np.zeros(0, int)}
    if R["ts"]:
        out["rows"] = {k: np.concatenate(v) for k, v in R.items()}
    else:
        out["rows"] = None
    if want_hourly and H["ts"]:
        out["hourly"] = {k: np.concatenate(v) for k, v in H.items()}
    else:
        out["hourly"] = None
    return out


# =============================================================================================
# pooled parts
# =============================================================================================
def gpd_nll(beta, y, xi):
    if beta <= 0:
        return np.inf
    if abs(xi) < 1e-9:
        return len(y) * math.log(beta) + float(y.sum()) / beta
    z = 1.0 + xi * y / beta
    if np.any(z <= 0):
        return np.inf
    return len(y) * math.log(beta) + (1.0 + 1.0 / xi) * float(np.log(z).sum())


def gpd_beta(y, xi):
    y = np.asarray(y, float)
    mu = float(y.mean())
    if abs(xi) < 1e-9:
        return mu, gpd_nll(mu, y, 0.0)
    lo = math.log(max(mu, 1e-12)) - 12
    if xi < 0:
        lo = max(lo, math.log(-xi * float(y.max())) + 1e-9)
    res = minimize_scalar(lambda lb: gpd_nll(math.exp(lb), y, xi), bounds=(lo, math.log(max(mu, 1e-12)) + 12),
                          method="bounded", options={"xatol": 1e-10})
    return math.exp(res.x), float(res.fun)


def profile_xi(groups):
    """shared xi, own beta per group; returns the MLE over [-0.3, 1.0] and the clipped value."""
    groups = [np.asarray(g, float) for g in groups if len(g) >= 2]

    def prof(xi):
        return sum(gpd_beta(g, xi)[1] for g in groups)

    grid = np.round(np.arange(-0.30, 1.0001, 0.01), 4)
    vals = np.array([prof(x) for x in grid])
    j = int(np.argmin(vals))
    lo, hi = grid[max(j - 1, 0)], grid[min(j + 1, len(grid) - 1)]
    res = minimize_scalar(prof, bounds=(lo, hi), method="bounded", options={"xatol": 1e-6})
    xi_hat = float(res.x)
    return {"xi_mle": xi_hat, "xi": float(np.clip(xi_hat, *XI_CLIP)), "n_groups": len(groups),
            "n_exceedances": int(sum(len(g) for g in groups)), "profile_nll_min": float(res.fun)}


def gpd_fit2(y):
    """(xi, beta) MLE, xi clipped to XI_CLIP and beta refit given the clipped xi."""
    best = None
    for xi in np.arange(-0.3, 1.0001, 0.01):
        b, nll = gpd_beta(y, xi)
        if best is None or nll < best[2]:
            best = (xi, b, nll)
    res = minimize_scalar(lambda x: gpd_beta(y, x)[1], bounds=(best[0] - 0.01, best[0] + 0.01), method="bounded")
    xi_hat = float(res.x)
    xi = float(np.clip(xi_hat, *XI_CLIP))
    return {"xi_mle": xi_hat, "xi": xi, "beta": gpd_beta(y, xi)[0], "n": int(len(y))}


def gpd_sf(y, xi, beta):
    y = np.maximum(y, 0.0)
    if abs(xi) < 1e-9:
        return np.exp(-y / beta)
    return np.power(1.0 + xi * y / beta, -1.0 / xi)


def fit_poisson(jn, jj):
    x = np.log1p(np.arange(len(jn)))
    th = np.array([math.log(max(jj.sum(), 1) / max(jn.sum(), 1)), 0.0])
    for _ in range(100):
        lam = np.exp(th[0] + th[1] * x)
        mu = jn * lam
        g = np.array([np.sum(jj - mu), np.sum((jj - mu) * x)])
        Hm = np.array([[mu.sum(), (mu * x).sum()], [(mu * x).sum(), (mu * x * x).sum()]])
        st = np.linalg.solve(Hm, g)
        th = th + st
        if np.max(np.abs(st)) < 1e-12:
            break
    return {"a": float(th[0]), "b": float(th[1]), "hours": float(jn.sum()), "jumps": float(jj.sum())}


def fit_c2_map(lp, x, v, y, theta0, start=None, max_iter=60):
    """ridge logistic, one intercept per deep level + slopes on logit p, x, v; lambda = 0.01 * n_rows."""
    n, L = lp.shape
    nr = n * L
    lam = C2_LAMBDA_FRAC * nr
    th = theta0.copy() if start is None else start.copy()
    if n == 0:
        return theta0.copy(), {"n_rows": 0, "iterations": 0}

    def obj_grad_hess(th, want_h=True):
        eta = th[:L][None, :] + th[L] * lp + (th[L + 1] * x + th[L + 2] * v)[:, None]
        f = float(np.sum(np.logaddexp(0.0, eta) - y * eta)) + 0.5 * lam * float(np.sum((th - theta0) ** 2))
        if not want_h:
            return f, None, None
        p = expit(eta)
        res = p - y
        W = p * (1 - p)
        g = np.zeros(L + 3)
        g[:L] = res.sum(0)
        g[L] = (res * lp).sum()
        rs = res.sum(1)
        g[L + 1] = (rs * x).sum()
        g[L + 2] = (rs * v).sum()
        g += lam * (th - theta0)
        Hm = np.zeros((L + 3, L + 3))
        Hm[np.arange(L), np.arange(L)] = W.sum(0)
        Hm[:L, L] = Hm[L, :L] = (W * lp).sum(0)
        Hm[:L, L + 1] = Hm[L + 1, :L] = (W * x[:, None]).sum(0)
        Hm[:L, L + 2] = Hm[L + 2, :L] = (W * v[:, None]).sum(0)
        Ws = W.sum(1)
        Hm[L, L] = (W * lp * lp).sum()
        Hm[L, L + 1] = Hm[L + 1, L] = ((W * lp).sum(1) * x).sum()
        Hm[L, L + 2] = Hm[L + 2, L] = ((W * lp).sum(1) * v).sum()
        Hm[L + 1, L + 1] = (Ws * x * x).sum()
        Hm[L + 1, L + 2] = Hm[L + 2, L + 1] = (Ws * x * v).sum()
        Hm[L + 2, L + 2] = (Ws * v * v).sum()
        Hm += lam * np.eye(L + 3)
        return f, g, Hm

    it = 0
    f, g, Hm = obj_grad_hess(th)
    for it in range(1, max_iter + 1):
        st = np.linalg.solve(Hm, g)
        a = 1.0
        while True:
            f2, _, _ = obj_grad_hess(th - a * st, want_h=False)
            if f2 <= f - 1e-4 * a * float(g @ st) or a < 1e-8:
                break
            a *= 0.5
        th = th - a * st
        if np.max(np.abs(a * st)) < 1e-8:
            break
        f, g, Hm = obj_grad_hess(th)
    return th, {"n_rows": int(nr), "iterations": it}


def fit_delta(l, y):
    d = 0.0
    if len(l) == 0:
        return 0.0
    for _ in range(100):
        p = expit(l + d)
        g = float(np.sum(p - y))
        h = float(np.sum(p * (1 - p)))
        if h <= 0:
            break
        st = g / h
        d -= st
        if abs(st) < 1e-12:
            break
    return float(d)


def quarter_of(ts):
    d = datetime.fromtimestamp(int(ts), timezone.utc)
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def quarter_start_ts(name):
    return A.quarter_start(int(name[:4]), int(name[5]))


# =============================================================================================
# candidates from per-row intermediates + pooled params
# =============================================================================================
def c1_betas(folds_by_series, xi):
    """beta per (series, fold gid) given xi; None when fewer than C1_MIN_EXC exceedances."""
    out = {}
    for key, recs in folds_by_series.items():
        for rec in recs:
            if rec["u"] is None or len(rec["yv"]) < C1_MIN_EXC:
                out[(key, rec["gid"])] = None
            else:
                out[(key, rec["gid"])] = (rec["u"], rec["phat"], gpd_beta(rec["yv"], xi)[0])
    return out


def g_of(x, gpool):
    E = gpool["E"]
    n = len(E)
    q = gpool["q95"]
    emp = (n - np.searchsorted(E, x, side="left")) / n
    tail = gpool["phat"] * gpd_sf(x - q, gpool["xi"], gpool["beta"])
    return np.where(x > q, tail, emp)


def apply_candidates(rows, key, T, pooled, theta, betas):
    """-> dict rung -> (n, K) monotone-fixed forecasts: fH, f, a, C1..C4."""
    pH = rows["pH"].astype(float)
    n = len(pH)
    fb = rows["fb"]
    thr = rows["thr"].astype(float)
    pHd = pH[:, DI]
    out = {"fH": np.minimum.accumulate(pH, axis=1), "f": np.minimum.accumulate(rows["pf"].astype(float), axis=1),
           "a": np.minimum.accumulate(rows["pa"].astype(float), axis=1)}
    xk = -thr
    # C1
    c1 = pHd.copy()
    u = np.full(n, np.nan)
    ph = np.full(n, np.nan)
    be = np.full(n, np.nan)
    for gid in np.unique(rows["fold"]):
        b = betas.get((key, int(gid)))
        if b is not None:
            m = rows["fold"] == gid
            u[m], ph[m], be[m] = b
    with np.errstate(invalid="ignore"):
        use = np.isfinite(u)[:, None] & (xk > u[:, None]) & np.isfinite(xk)
    if use.any():
        uu = np.broadcast_to(u[:, None], xk.shape)[use]
        bb = np.broadcast_to(be[:, None], xk.shape)[use]
        pp = np.broadcast_to(ph[:, None], xk.shape)[use]
        c1[use] = pp * gpd_sf(xk[use] - uu, pooled["xi"][T], bb)
    # C2
    lp = logit(pHd)
    xx, vv = rows["x"].astype(float), rows["v"].astype(float)
    th = theta
    L = len(DI)
    c2 = expit(th[:, :L] + th[:, L:L + 1] * lp + (th[:, L + 1] * np.nan_to_num(xx) + th[:, L + 2] *
                                                    np.nan_to_num(vv))[:, None])
    bad = ~(np.isfinite(xx) & np.isfinite(vv))
    c2[bad] = pHd[bad]
    # C3
    pz = pooled["poisson"]
    lam = np.exp(pz["a"] + pz["b"] * np.log1p(rows["n168"].astype(float)))
    G = g_of(np.where(np.isfinite(xk), xk, np.inf), pooled["G"][T])
    pJ = 1.0 - np.exp(-lam[:, None] * T * G)
    pD = rows["pD"].astype(float)
    pD = np.where(np.isfinite(pD), pD, pHd)
    c3 = 1.0 - (1.0 - pD) * (1.0 - pJ)
    # C4
    lib = pooled["lib"][T]
    ppool = np.searchsorted(lib, np.where(np.isfinite(thr), thr, -np.inf), side="right") / len(lib)
    nk = rows["nk"].astype(float)
    w = nk / (nk + C4_N0)
    c4 = w * pHd + (1 - w) * ppool
    for name, c in (("C1", c1), ("C2", c2), ("C3", c3), ("C4", c4)):
        c = np.where(np.isfinite(c), c, pHd)
        c[fb] = pHd[fb]
        full = pH.copy()
        full[:, DI] = c
        out[name] = np.minimum.accumulate(full, axis=1)
    return out


def theta_rows(rows, T, theta_by_q, frozen=None):
    L = len(DI)
    ident = np.zeros(L + 3)
    ident[L] = 1.0
    if frozen is not None:
        return np.tile(frozen, (len(rows["ts"]), 1))
    q = np.array([quarter_of(t) for t in rows["ts"][[0]]]) if len(rows["ts"]) else []
    out = np.tile(ident, (len(rows["ts"]), 1))
    qs = np.array([quarter_of(t) for t in rows["ts"]])
    for qq in np.unique(qs):
        out[qs == qq] = theta_by_q.get(qq, ident)
    del q
    return out


# =============================================================================================
# R12.2 rules
# =============================================================================================
def k_rules_series(hourly, rows_ts, T, delta_by_q, frozen_delta=None, which=None):
    """-> dict rule -> (n_rows, len(SHOWN[T])) forecasts at rows_ts (subset of hourly ts)."""
    hts, hy, hp = hourly["ts"], hourly["y"].astype(float), hourly["p"].astype(float)
    bands = np.array([BAND[k] for k in SHOWN[T]])
    pos = np.searchsorted(hts, rows_ts)
    if np.any(pos >= len(hts)) or np.any(hts[np.minimum(pos, len(hts) - 1)] != rows_ts):
        raise SystemExit("STOP: scored row missing from the hourly (fH) array")
    hi = ((hts - hts[0]) // STEP).astype(np.int64)
    span = int(hi[-1]) + 1

    def mono_clip(p):
        return np.clip(np.minimum.accumulate(p, axis=1), P_CLIP, 1 - P_CLIP)

    # K1 hourly
    if frozen_delta is not None:
        dl = np.tile([frozen_delta[int(b)] for b in bands], (len(hts), 1))
    else:
        qs = np.array([quarter_of(t) for t in hts])
        dl = np.zeros_like(hp)
        for qq in np.unique(qs):
            dd = delta_by_q.get(qq, {})
            dl[qs == qq] = [dd.get(int(b), 0.0) for b in bands]
    pK1 = mono_clip(expit(logit(hp) + dl))
    sy = hy.sum(1)

    def ratio_at(sp, W, kap):
        ay = np.zeros(span)
        ap = np.zeros(span)
        ay[hi] = sy
        ap[hi] = sp
        cy = np.concatenate([[0.0], np.cumsum(ay)])
        cp = np.concatenate([[0.0], np.cumsum(ap)])
        t = hi[pos]
        hiE = np.clip(t - T + 1, 0, span)
        loE = np.clip(t - 24 * W, 0, span)
        Sy = np.where(hiE > loE, cy[hiE] - cy[loE], 0.0)
        Sp = np.where(hiE > loE, cp[hiE] - cp[loE], 0.0)
        return np.clip((Sy + kap) / (Sp + kap), *K2_CLIP)

    out = {}
    base = hp[pos]
    for (fam, W, kap), name in zip(KRULES, KNAMES):
        if which is not None and name not in which:
            continue
        if fam == "K1":
            out[name] = pK1[pos]
        elif fam == "K2":
            out[name] = mono_clip(base * ratio_at(hp.sum(1), W, kap)[:, None])
        else:
            out[name] = mono_clip(pK1[pos] * ratio_at(pK1.sum(1), W, kap)[:, None])
    return out


# =============================================================================================
# blocks and tests
# =============================================================================================
def series_episodes(ts_pos):
    if len(ts_pos) == 0:
        return []
    t = np.sort(ts_pos)
    brk = np.where(np.diff(t) > MERGE_H * STEP)[0]
    s = np.concatenate([[0], brk + 1])
    e = np.concatenate([brk, [len(t) - 1]])
    return list(zip(t[s].tolist(), t[e].tolist()))


def crash_blocks(ts, sid, y, T):
    """registered crash-episode blocks of one cell; returns (block id per row, n_blocks, positive mask per block)."""
    spans = []
    pw = set()
    for s in np.unique(sid):
        m = sid == s
        for a, b in series_episodes(ts[m & (y > 0)]):
            spans.append((a, b + T * STEP))
            pw.add(int(wk(a)))
    merged = set()
    for a, b in spans:
        for w in range(int(wk(a)), int(wk(b))):
            merged.add(w)
    wks = wk(ts)
    w0, w1 = int(wks.min()), int(wks.max())
    bid_of_week = {}
    cur, ln, b = w0, 1, 0
    bid_of_week[w0] = 0
    for w in range(w0 + 1, w1 + 1):
        if (w - 1) in merged and ln < 4:
            ln += 1
        else:
            b += 1
            ln = 1
        bid_of_week[w] = b
    lut = np.array([bid_of_week[w] for w in range(w0, w1 + 1)])
    bid = lut[wks - w0]
    u, inv = np.unique(bid, return_inverse=True)
    posb = np.zeros(len(u), bool)
    if pw:
        pb = np.unique(lut[np.array(sorted(pw)) - w0])
        posb = np.isin(u, pb)
    return inv, len(u), posb


def cluster_sums(g, d, G=None):
    G = int(g.max()) + 1 if G is None else G
    return np.bincount(g, weights=d, minlength=G), np.bincount(g, minlength=G).astype(float)


def cr1_test(g, d):
    S, Nn = cluster_sums(g, d)
    G = len(S)
    m = float(S.sum() / Nn.sum())
    u = S - m * Nn
    var = G / (G - 1) * float((u * u).sum()) / float(Nn.sum()) ** 2 if G > 1 else np.nan
    tt = m / math.sqrt(var) if var > 0 else np.nan
    return {"G": G, "mean_diff": m, "se": math.sqrt(var) if var > 0 else None, "t": tt,
            "p_one_sided": float(student_t.cdf(tt, G - 1)) if np.isfinite(tt) else None}


def boot_test(g, d, idx):
    S, Nn = cluster_sums(g, d)
    m = float(S.sum() / Nn.sum())
    ms = S[idx].sum(1) / Nn[idx].sum(1)
    p = (1 + int(np.sum(ms - m <= m))) / (len(ms) + 1)
    return {"G": len(S), "mean_diff": m, "p_one_sided": float(p), "B": int(len(ms))}


def dk_hac(ts, d, L=HAC_LAG):
    ts = np.asarray(ts, np.int64)
    d = np.asarray(d, float)
    t0 = int(ts.min())
    h = (ts - t0) // STEP
    Hn = int(h.max()) + 1
    S = np.bincount(h, weights=d, minlength=Hn)
    Nn = np.bincount(h, minlength=Hn).astype(float)
    m = float(S.sum() / Nn.sum())
    u = S - m * Nn
    lrv = A6.nw_lrv(u, L)
    var = Hn * lrv / (Nn.sum() ** 2)
    z = m / math.sqrt(var) if var > 0 else None
    return {"lag": L, "mean_diff": m, "z": z, "p_one_sided": float(norm.cdf(z)) if z is not None else None}


def holm(pvals, alpha=ALPHA_FAM):
    order = np.argsort(pvals)
    m = len(pvals)
    ok = np.zeros(m, bool)
    for j, i in enumerate(order):
        if pvals[i] <= alpha / (m - j):
            ok[i] = True
        else:
            break
    return ok


def brier(p, y):
    return float(np.mean((p - y) ** 2))


# =============================================================================================
# development run
# =============================================================================================
def run_pool(tasks, workers, log, label):
    t0 = time.time()
    out = []
    with mp.get_context("fork").Pool(workers, maxtasksperchild=8) as pool:
        for j, r in enumerate(pool.imap(series_task, tasks, chunksize=1)):
            out.append(r)
            if (j + 1) % 25 == 0 or j + 1 == len(tasks):
                log(f"  {label}: {j + 1}/{len(tasks)} series ({time.time() - t0:.0f}s)")
    return out


def stack_rows(res, keep=None):
    """concatenate rows of many series; keep: function(rows)->mask."""
    parts, sids, keys = [], [], []
    for j, r in enumerate(res):
        if r["rows"] is None:
            continue
        rw = r["rows"]
        m = keep(rw) if keep else np.ones(len(rw["ts"]), bool)
        if not m.any():
            continue
        parts.append({k: v[m] for k, v in rw.items()})
        sids.append(np.full(int(m.sum()), j, np.int32))
        keys.append(r["key"])
    if not parts:
        return None
    out = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    out["sid"] = np.concatenate(sids)
    return out


def pooled_fit_T(res, T, log, poisson=None):
    """frozen pooled parts at T from development pass rows (6-hourly, outside 2026Q2)."""
    keep = lambda rw: ~rw["q2"] & ~rw["tail"]  # noqa: E731
    S = stack_rows(res, keep)
    y = S["y"].astype(float)
    e_const = {repr(k): float(y[:, j].mean()) for j, k in enumerate(LEVELS)}
    m = S["m"].astype(float)
    lib = np.sort(m[np.isfinite(m)]).astype(np.float32)
    # xi_T from series-own declustered exceedances of e = -m
    groups = []
    for s in np.unique(S["sid"]):
        mm = (S["sid"] == s) & np.isfinite(m)
        if mm.sum() < 20:
            continue
        e = -m[mm]
        tt = (S["ts"][mm] // STEP).astype(np.int64)
        o = np.argsort(tt)
        e, tt = e[o], tt[o]
        u = float(np.quantile(e, C1_Q))
        exc = e > u
        groups.append(decluster_max(tt[exc], e[exc]) - u)
    xi = profile_xi(groups)
    log(f"  {TL[T]}: xi_T MLE {xi['xi_mle']:.4f} -> {xi['xi']:.4f} ({xi['n_exceedances']} exceedances, "
        f"{xi['n_groups']} series)")
    # G_T jump sizes
    E_all, ex_groups = [], []
    for r in res:
        if len(r["jump_e"]):
            E_all.append(r["jump_e"])
    E = np.sort(np.concatenate(E_all))
    q95 = float(np.quantile(E, C1_Q))
    for r in res:
        e, t = r["jump_e"], r["jump_t"]
        if len(e) == 0:
            continue
        o = np.argsort(t)
        e, t = e[o], t[o]
        exc = e > q95
        if exc.any():
            ex_groups.append(decluster_max(t[exc], e[exc]) - q95)
    gy = np.concatenate(ex_groups)
    gfit = gpd_fit2(gy)
    G = {"E": E, "q95": q95, "phat": float(np.mean(E > q95)), "xi": gfit["xi"], "beta": gfit["beta"],
         "xi_mle": gfit["xi_mle"], "n_jumps": int(len(E)), "n_declustered_exceedances": int(len(gy))}
    log(f"  {TL[T]}: G_T {len(E)} jump hours, q95 {q95:.3f}, GPD xi {gfit['xi_mle']:.3f}->{gfit['xi']:.3f} "
        f"beta {gfit['beta']:.3f}")
    if poisson is None:
        jn = sum(r["jump_n"] for r in res)
        jj = sum(r["jump_j"] for r in res)
        poisson = fit_poisson(jn, jj)
        log(f"  Poisson jump rate: a {poisson['a']:.4f} b {poisson['b']:.4f} ({poisson['jumps']:.0f} jumps in "
            f"{poisson['hours']:.0f} hours)")
    # C2 walk-forward maps
    L = len(DI)
    ident = np.zeros(L + 3)
    ident[L] = 1.0
    okr = ~S["fb"] & np.isfinite(S["x"]) & np.isfinite(S["v"])
    lp = logit(S["pH"][:, DI].astype(float))[okr]
    xx, vv = S["x"].astype(float)[okr], S["v"].astype(float)[okr]
    yy = y[:, DI][okr]
    tsr = S["ts"][okr]
    qnames = sorted({quarter_of(t) for t in S["ts"]})
    theta_by_q, info_q, th = {}, {}, None
    for qn in qnames + ["FROZEN"]:
        qst = END if qn == "FROZEN" else quarter_start_ts(qn)
        if qn == "FROZEN":
            th_f, inf = theta_by_q[qnames[-1]], info_q[qnames[-1]]
            break
        mm = tsr + T * STEP <= qst
        th, inf = fit_c2_map(lp[mm], xx[mm], vv[mm], yy[mm], ident, start=th)
        theta_by_q[qn], info_q[qn] = th.copy(), inf
    log(f"  {TL[T]}: C2 frozen map (last fit {qnames[-1]}, {inf['n_rows']} rows) "
        f"{np.round(th_f, 4).tolist()}")
    out = {"T": T, "e": e_const, "lib": lib, "xi": xi, "G": G, "poisson": poisson,
           "theta_by_q": theta_by_q, "theta_frozen": th_f, "theta_info": info_q}
    # K1 offsets
    if T in SHOWN:
        sh = np.array([LEVELS.index(k) for k in SHOWN[T]])
        pm = np.minimum.accumulate(S["pH"].astype(float), axis=1)[:, sh]
        lsh, ysh = logit(pm), y[:, sh]
        bands = np.array([BAND[k] for k in SHOWN[T]])
        delta_by_q = {}
        for qn in qnames:
            mm = S["ts"] + T * STEP <= quarter_start_ts(qn)
            delta_by_q[qn] = {int(b): fit_delta(lsh[mm][:, bands == b].ravel(), ysh[mm][:, bands == b].ravel())
                              for b in np.unique(bands)}
        out["delta_by_q"] = delta_by_q
        out["delta_frozen"] = delta_by_q[qnames[-1]]
        log(f"  {TL[T]}: K1 frozen offsets {delta_by_q[qnames[-1]]}")
    return out, S


def r121_dev_scores(res, T, pooled_T, pooled_all, log):
    S = stack_rows(res, lambda rw: ~rw["q2"] & ~rw["tail"])
    keys = [r["key"] for r in res if r["rows"] is not None]
    keymap = {j: r["key"] for j, r in enumerate(res)}
    betas = c1_betas({r["key"]: r["folds"] for r in res}, pooled_T["xi"]["xi"])
    P = {c: np.zeros((len(S["ts"]), K)) for c in ("fH", "f", "a") + CANDS}
    for j in np.unique(S["sid"]):
        m = S["sid"] == j
        rows = {k: v[m] for k, v in S.items()}
        th = theta_rows(rows, T, pooled_T["theta_by_q"])
        out = apply_candidates(rows, keymap[int(j)], T, pooled_all, th, betas)
        for c in P:
            P[c][m] = out[c]
    del keys
    y = S["y"].astype(float)
    yd = y[:, DI]
    ec = np.array([pooled_T["e"][repr(k)] for k in LEVELS])
    P["e"] = np.tile(ec, (len(y), 1))
    se = {c: ((P[c][:, DI] - yd) ** 2).mean(1) for c in P}
    br = {c: float(se[c].mean()) for c in se}
    # pooled deep blocks from -15% episodes
    gi, G, posb = crash_blocks(S["ts"], S["sid"], yd[:, 0], T)
    best = min(CANDS, key=lambda c: br[c])
    sel_tab = {}
    selected = None
    for c in SIMPLICITY:
        t = cr1_test(gi, se[c] - se[best])
        within = (br[c] - br[best]) <= (t["se"] or 0.0) + 1e-15
        sel_tab[c] = {"brier": br[c], "diff_vs_best": br[c] - br[best], "se_cr1": t["se"], "within_1se": bool(within)}
        if selected is None and within:
            selected = c
    log(f"  {TL[T]}: dev pooled deep Brier " + ", ".join(f"{c} {br[c]:.6f}" for c in ("fH", "f", "a", "e") + CANDS)
        + f"; best {best}; selected {selected}")
    res_T = {"T": TL[T], "rows": int(len(y)), "series": int(len(np.unique(S["sid"]))), "blocks": int(G),
             "positive_blocks_m15": int(posb.sum()), "brier_pooled_deep": br, "best": best, "selected": selected,
             "selection_table": sel_tab}
    res_T["bss_selected_vs"] = {c: 1 - br[selected] / br[c] for c in CMPS}
    res_T["bss_all_vs_fH"] = {c: 1 - br[c] / br["fH"] for c in CANDS}
    res_T["R_pooled_deep"] = {c: float(P[c][:, DI].sum() / yd.sum()) for c in P}
    # per cell: dev effect and power
    cells = {}
    for jj, k in enumerate(DEEP):
        col = DI[jj]
        g, Gc, pb = crash_blocks(S["ts"], S["sid"], y[:, col], T)
        cell = {"positive_origins": int(y[:, col].sum()), "blocks": int(Gc), "positive_blocks": int(pb.sum()),
                "R": {c: (float(P[c][:, col].sum() / y[:, col].sum()) if y[:, col].sum() > 0 else None)
                      for c in ("fH", "f", "a", "e", selected)}, "vs": {}}
        sec = (P[selected][:, col] - y[:, col]) ** 2
        for cmp in CMPS:
            d = sec - (P[cmp][:, col] - y[:, col]) ** 2
            Sb, _ = cluster_sums(g, d, Gc)
            sp = Sb[pb]
            mb = float(sp.mean()) if len(sp) else float("nan")
            sb = float(sp.std(ddof=1)) if len(sp) > 1 else float("nan")
            gstar = (Z_POW_121 * sb / mb) ** 2 if (mb < 0 and np.isfinite(sb)) else None
            sa = Sb
            gall = (Z_POW_121 * float(sa.std(ddof=1)) / float(sa.mean())) ** 2 if sa.mean() < 0 else None
            bcmp = brier(P[cmp][:, col], y[:, col])
            cell["vs"][cmp] = {"mean_d": float(d.mean()),
                               "bss": (1 - brier(P[selected][:, col], y[:, col]) / bcmp) if bcmp > 0 else None,
                               "block_mean_pos": mb, "block_sd_pos": sb, "G_star_positive_blocks": gstar,
                               "G_star_all_blocks": gall, "cr1": cr1_test(g, d)}
        gs = [cell["vs"][c]["G_star_positive_blocks"] for c in CMPS]
        cell["G_star_max"] = None if any(v is None for v in gs) else max(gs)
        cells[repr(k)] = cell
    res_T["cells"] = cells
    return res_T


def r122_rows(res, T, delta_by_q=None, frozen_delta=None, which=None, keep=None):
    """per scored row: K-rule forecasts on the shown cells -> dict of arrays."""
    sh = np.array([LEVELS.index(k) for k in SHOWN[T]])
    outs = {"ts": [], "sid": [], "y": [], "fH": [], "f": [], "rules": {n: [] for n in (which or KNAMES)}}
    for j, r in enumerate(res):
        if r["rows"] is None or r["hourly"] is None:
            continue
        rw = r["rows"]
        m = keep(rw) if keep else (~rw["q2"] & ~rw["tail"])
        if not m.any():
            continue
        ts = rw["ts"][m]
        kr = k_rules_series(r["hourly"], ts, T, delta_by_q, frozen_delta, which)
        outs["ts"].append(ts)
        outs["sid"].append(np.full(len(ts), j, np.int32))
        outs["y"].append(rw["y"][m][:, sh].astype(float))
        outs["fH"].append(np.minimum.accumulate(rw["pH"][m].astype(float), axis=1)[:, sh])
        outs["f"].append(np.minimum.accumulate(rw["pf"][m].astype(float), axis=1)[:, sh])
        for nme in outs["rules"]:
            outs["rules"][nme].append(kr[nme])
    o = {k: np.concatenate(v) for k, v in outs.items() if k != "rules"}
    o["rules"] = {k: np.concatenate(v) for k, v in outs["rules"].items()}
    return o


def r122_dev_scores(res, T, pooled_T, log, eth_sid=None):
    O = r122_rows(res, T, delta_by_q=pooled_T["delta_by_q"])
    y = O["y"]
    sh = [repr(k) for k in SHOWN[T]]
    ec = np.array([pooled_T["e"][k] for k in sh])
    se = {n: ((p - y) ** 2).mean(1) for n, p in O["rules"].items()}
    se["fH"] = ((O["fH"] - y) ** 2).mean(1)
    se["f"] = ((O["f"] - y) ** 2).mean(1)
    se["e"] = ((ec[None, :] - y) ** 2).mean(1)
    br = {n: float(v.mean()) for n, v in se.items()}
    gw = np.unique(wk(O["ts"]), return_inverse=True)[1]
    best = min(KNAMES, key=lambda n: br[n])
    tab, sel = {}, None
    for n in KNAMES:
        t = cr1_test(gw, se[n] - se[best])
        within = (br[n] - br[best]) <= (t["se"] or 0.0) + 1e-15
        tab[n] = {"brier": br[n], "diff_vs_best": br[n] - br[best], "se_week": t["se"], "within_1se": bool(within)}
        if sel is None and within:
            sel = n
    sy = float(y.sum())
    R = {n: float(p.sum() / sy) for n, p in O["rules"].items()}
    R["fH"] = float(O["fH"].sum() / sy)
    R["f"] = float(O["f"].sum() / sy)
    log(f"  {TL[T]}: R12.2 dev Brier fH {br['fH']:.6f}, best {best} {br[best]:.6f}, selected {sel}; "
        f"R fH {R['fH']:.3f} -> {R[sel]:.3f}")
    return {"T": TL[T], "rows": int(len(y)), "brier": br, "best": best, "selected_in_T": sel, "table": tab,
            "R": R, "weeks": int(gw.max() + 1)}, O, se


def r122_power(O, se, T, rule, pooled_T, eth_sid):
    out = {}
    gw_u, gw = np.unique(wk(O["ts"]), return_inverse=True)
    for cmp in ("fH", "e", "f"):
        d = se[rule] - se[cmp]
        Sw = np.bincount(gw, weights=d)
        mw, sw = float(Sw.mean()), float(Sw.std(ddof=1))
        out[cmp] = {"mean_d": float(d.mean()), "week_mean": mw, "week_sd": sw, "std_effect": mw / sw if sw > 0 else None,
                    "weeks_to_80pct": (Z_POW_122 * sw / mw) ** 2 if mw < 0 else None}
    if eth_sid is not None:
        m = O["sid"] == eth_sid
        if m.any():
            out["eth_live_days_to_80pct"] = {}
            for cmp in ("fH", "e"):
                d = (se[rule] - se[cmp])[m]
                mu = float(d.mean())
                lrv = A6.nw_lrv(d - mu, HAC_LAG // 6)
                n = (Z_POW_122 ** 2) * lrv / (mu * mu) if mu < 0 and lrv > 0 else None
                out["eth_live_days_to_80pct"][cmp] = {"mean_d": mu, "days": None if n is None else n / 4.0,
                                                       "note": "ETH long series, 6-hourly dev rows, HAC lag 28 (=168 h)"}
    return out


def family_choice(per_T):
    """R12.2b: family with the most T wins (tie: simpler); constants per T chosen inside that family."""
    fam = {n: n.split("_")[0] for n in KNAMES}
    wins = {"K1": 0, "K2": 0, "K3": 0}
    for v in per_T.values():
        wins[fam[v["selected_in_T"]]] += 1
    order = ("K1", "K2", "K3")
    best_f = sorted(order, key=lambda f: (-wins[f], order.index(f)))[0]
    chosen = {}
    for T, v in per_T.items():
        names = [n for n in KNAMES if fam[n] == best_f]
        bmin = min(names, key=lambda n: v["brier"][n])
        pick = None
        for n in names:
            if v["brier"][n] - v["brier"][bmin] <= (v["table_within_family"][n] if "table_within_family" in v
                                                     else 0.0) + 1e-15:
                pick = n
                break
        chosen[T] = pick
    return best_f, wins, chosen


def cmd_dev(a):
    t0 = time.time()
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "dev-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    specs = dev_specs(a.datasets)
    if a.limit:
        specs = specs[:a.limit]
    log(f"dev start; code {R112.git_sha()} clean {R112.git_clean()}; {len(specs)} development series")
    pooled = {"xi": {}, "G": {}, "lib": {}, "poisson": None}
    readings = {"schema": "q26-r12/dev-readings/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
                "clean": R112.git_clean(), "prereg": PREREG, "decisions": DECISIONS, "n_series": len(specs),
                "series": [s["key"] for s in specs], "r121": {}, "r122": {}, "pooled": {}}
    frozen = {"theta": {}, "delta": {}, "e": {}, "xi": {}, "G": {}}
    r122_T = {}
    eth_sid = 0
    for T in HORIZONS:
        tasks = [{"spec": s, "T": T, "grid": "6h"} for s in specs]
        res = run_pool(tasks, a.workers, log, f"dev {TL[T]}")
        pT, _ = pooled_fit_T(res, T, log, poisson=pooled["poisson"])
        pooled["poisson"] = pT["poisson"]
        pooled["xi"][T] = pT["xi"]["xi"]
        pooled["G"][T] = pT["G"]
        pooled["lib"][T] = pT["lib"]
        frozen["theta"][TL[T]] = pT["theta_frozen"].tolist()
        frozen["e"][TL[T]] = pT["e"]
        frozen["xi"][TL[T]] = pT["xi"]
        frozen["G"][TL[T]] = {k: v for k, v in pT["G"].items() if k != "E"}
        readings["pooled"][TL[T]] = {"xi": pT["xi"], "G": frozen["G"][TL[T]], "e": pT["e"],
                                     "lib_n": int(len(pT["lib"])),
                                     "theta_by_q": {q: np.round(v, 6).tolist() for q, v in pT["theta_by_q"].items()},
                                     "theta_frozen": pT["theta_frozen"].tolist(),
                                     "theta_info_last": pT["theta_info"][max(pT["theta_info"])]}
        readings["r121"][TL[T]] = r121_dev_scores(res, T, pT, pooled, log)
        if T in SHOWN:
            frozen["delta"][TL[T]] = {str(k): v for k, v in pT["delta_frozen"].items()}
            readings["pooled"][TL[T]]["delta_by_q"] = pT["delta_by_q"]
            sc, O, se = r122_dev_scores(res, T, pT, log)
            # within-family SE tables for the family rule
            gw = np.unique(wk(O["ts"]), return_inverse=True)[1]
            twf = {}
            for fam in ("K1", "K2", "K3"):
                names = [n for n in KNAMES if n.split("_")[0] == fam]
                bmin = min(names, key=lambda n: sc["brier"][n])
                for n in names:
                    twf[n] = cr1_test(gw, se[n] - se[bmin])["se"] or 0.0
            sc["table_within_family"] = twf
            r122_T[T] = (sc, O, se)
            readings["r122"][TL[T]] = sc
            pooled.setdefault("delta", {})[T] = pT["delta_frozen"]
        frozen["poisson"] = pooled["poisson"]
        del res
        log(f"  {TL[T]} done ({time.time() - t0:.0f}s)")
    # R12.2 family choice and power
    fam, wins, chosen = family_choice({T: v[0] for T, v in r122_T.items()})
    readings["r122_choice"] = {"family": fam, "wins": wins, "rule_per_T": {TL[T]: c for T, c in chosen.items()}}
    for T, (sc, O, se) in r122_T.items():
        rule = chosen[T]
        pw = r122_power(O, se, T, rule, None, eth_sid)
        readings["r122"][TL[T]]["chosen_rule"] = rule
        readings["r122"][TL[T]]["power"] = pw
        readings["r122"][TL[T]]["dev_effect"] = {
            "bss_vs_fH": 1 - sc["brier"][rule] / sc["brier"]["fH"], "bss_vs_f": 1 - sc["brier"][rule] / sc["brier"]["f"],
            "bss_vs_e": 1 - sc["brier"][rule] / sc["brier"]["e"], "R_fH": sc["R"]["fH"], "R_rule": sc["R"][rule]}
        # monthly R before/after
        mon = np.array([A.iso(int(t))[:7] for t in O["ts"]])
        mr = {}
        for u in np.unique(mon):
            mm = mon == u
            s_ = float(O["y"][mm].sum())
            if s_ > 0:
                mr[u] = {"R_fH": float(O["fH"][mm].sum() / s_), "R_rule": float(O["rules"][rule][mm].sum() / s_)}
        lr = lambda k: float(np.median([abs(math.log(v[k])) for v in mr.values() if v[k] > 0]))  # noqa: E731
        readings["r122"][TL[T]]["monthly_median_abs_lnR"] = {"fH": lr("R_fH"), "rule": lr("R_rule")}
        frozen["delta"][TL[T] + "_rule"] = rule
    readings["r121_selected"] = {TL[T]: readings["r121"][TL[T]]["selected"] for T in HORIZONS}
    readings["runtime_s"] = time.time() - t0
    h = write_json(os.path.join(a.out, "dev-readings-r12.json"), readings)
    frozen_parts = {"schema": "q26-r12/pooled-frozen/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
                    "selected_r121": readings["r121_selected"], "r122_rule": readings["r122_choice"],
                    "poisson": pooled["poisson"], "theta_frozen": frozen["theta"], "e": frozen["e"],
                    "xi": frozen["xi"], "G": frozen["G"],
                    "delta_frozen": {TL[T]: {str(k): v for k, v in d.items()} for T, d in pooled.get("delta", {}).items()},
                    "theta_layout": "intercepts for -15,-20,-25,-30,-40%; slope logit p_fH; slope x; slope v"}
    h2 = write_json(os.path.join(a.out, "pooled-frozen-r12.json"), frozen_parts)
    np.savez_compressed(os.path.join(a.out, "pooled-arrays-r12.npz"),
                        **{f"lib_{TL[T]}": pooled["lib"][T] for T in HORIZONS},
                        **{f"jumpE_{TL[T]}": pooled["G"][T]["E"].astype(np.float32) for T in HORIZONS})
    log(f"dev done in {time.time() - t0:.0f}s; readings sha256 {h}; pooled sha256 {h2}; "
        f"arrays sha256 {R112.sha256_file(os.path.join(a.out, 'pooled-arrays-r12.npz'))}")


# =============================================================================================
# acquisition (outcome-blind)
# =============================================================================================
BUCKET_LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix={p}&marker={m}"
BULK = "https://data.binance.vision/"
STABLE = {"AEUR", "AUD", "BKRW", "BUSD", "DAI", "GBP", "PAX", "SUSD", "USDP", "USDSB", "USDSOLD", "UST"}
WRAPPED = {"BETH", "BTCST"}
LEVERAGED_SUFFIX = ("UP", "DOWN", "BULL", "BEAR")
FIRST_CUT = A.utc("2024-01-01T00:00:00Z")
B9_CUT = {"BCHABCUSDT": "2019-11-28", "STRATUSDT": "2020-11-18", "LENDUSDT": "2020-10-15", "MATICUSDT": "2024-09-13",
          "RNDRUSDT": "2024-07-26", "KLAYUSDT": "2024-10-31", "FTMUSDT": "2025-01-16", "GALUSDT": "2024-07-19",
          "NANOUSDT": "2022-01-28", "POLYUSDT": "2022-10-17", "KEEPUSDT": "2022-02-25", "NUUSDT": "2022-02-25",
          "VENUSDT": "2018-07-25", "BTTUSDT": "2022-01-25", "ERDUSDT": "2020-09-03", "AGIXUSDT": "2024-03-27",
          "OCEANUSDT": "2024-03-27", "EOSUSDT": "2025-05-28", "MKRUSDT": "2025-09-17"}
B9_RENAME = {"XZCUSDT": "FIROUSDT", "TOMOUSDT": "VICUSDT", "STORMUSDT": "STMXUSDT", "ANYUSDT": "MULTIUSDT",
             "BZRXUSDT": "OOKIUSDT", "BCCUSDT": "BCHABCUSDT"}
B10_PAIRS = {"tLTCUSD": "2017-12-13T00:00Z", "tETCUSD": "2018-06-12T00:00Z", "tZECUSD": "2019-03-21T00:00Z",
             "tDSHUSD": "2019-03-28T00:00Z", "tXMRUSD": "B9:XMRUSDT", "tOMGUSD": "B9:OMGUSDT",
             "tBTGUSD": "B9:BTGUSDT", "tETPUSD": "END", "tSANUSD": "END", "tEDOUSD": "END", "tLEOUSD": "END"}
BFX = "https://api-pub.bitfinex.com/v2/candles/trade:1h:{p}/hist?start={s}&end={e}&limit=10000&sort=1"


def http_get(url, tries=6, allow404=False):
    last = None
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404 and allow404:
                return None
            last = repr(e)
        except Exception as e:          # retried
            last = repr(e)
        time.sleep(3.0 * (k + 1))
    raise SystemExit(f"STOP: request failed after {tries} tries: {last}")


def s3_list(prefix):
    out, marker = [], ""
    while True:
        x = http_get(BUCKET_LIST.format(p=prefix, m=marker)).decode()
        pre = re.findall(r"<Prefix>([^<]+)</Prefix>", x)
        keys = re.findall(r"<Key>([^<]+)</Key>", x)
        out += [p for p in pre if p != prefix] + keys
        if "<IsTruncated>true</IsTruncated>" not in x:
            break
        nm = re.findall(r"<NextMarker>([^<]+)</NextMarker>", x)
        marker = nm[0] if nm else (keys[-1] if keys else pre[-1])
    return out


def b9_selection(datasets):
    ex = json.load(open(os.path.join(datasets, "blind7-prices/binance-selection-exchangeInfo.json")))
    status = {s["symbol"]: s["status"] for s in ex["symbols"]}
    syms = sorted({p.rstrip("/").split("/")[-1] for p in s3_list("data/spot/monthly/klines/")})
    usdt = [s for s in syms if s.endswith("USDT")]
    nont = [s for s in usdt if status.get(s) != "TRADING"]
    lev = [s for s in nont if s[:-4].endswith(LEVERAGED_SUFFIX)]
    rest = [s for s in nont if s not in lev]
    stab = [s for s in rest if s[:-4] in STABLE]
    wrap = [s for s in rest if s[:-4] in WRAPPED]
    cand = [s for s in rest if s not in stab and s not in wrap]
    keys, late = {}, []
    for s in cand:
        ks = sorted(k for k in s3_list(f"data/spot/monthly/klines/{s}/1h/") if k.endswith(".zip"))
        if not ks:
            continue
        y, m = map(int, ks[0].split("-1h-")[1][:7].split("-"))
        if A.utc(f"{y:04d}-{m:02d}-01T00:00:00Z") >= FIRST_CUT:
            late.append(s)
            continue
        keys[s] = ks
    return {"bucket_usdt": len(usdt), "non_trading": len(nont), "leveraged": len(lev), "stable": stab,
            "wrapped": wrap, "first_kline_2024_or_later": late, "symbols": sorted(keys), "keys": keys,
            "exchangeInfo_sha256": R112.sha256_file(os.path.join(datasets,
                                                                "blind7-prices/binance-selection-exchangeInfo.json"))}


def to_sec(t):
    t = int(t)
    return t // 1_000_000 if t > 10 ** 14 else t // 1000


def write_grid(path, asset, source, st, rows):
    n = (max(rows) - st) // STEP + 1
    cols = {c: [None] * n for c in ("open", "high", "low", "close", "volume")}
    for t, v in rows.items():
        i = (t - st) // STEP
        for c, x in zip(("open", "high", "low", "close", "volume"), v):
            cols[c][i] = float(x)
    grid = {"asset": asset, "source": source, "startTs": st, "stepSeconds": STEP, "count": n, "columns": cols}
    with gzip.GzipFile(path, "wb", mtime=0) as f:
        f.write(json.dumps(grid, separators=(",", ":")).encode())
    return n, sum(1 for x in cols["close"] if x is None)


def cmd_acquire(a):
    b9d, b10d = os.path.join(a.acq, "b9"), os.path.join(a.acq, "b10")
    os.makedirs(b9d, exist_ok=True)
    os.makedirs(b10d, exist_ok=True)
    t_start = now_iso()
    sel = b9_selection(a.datasets)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in sel.items()}), flush=True)
    man = {"schema": "q26-r12/acquire-b9/1", "started_utc": t_start, "code_sha": R112.git_sha(),
           "selection": {k: v for k, v in sel.items() if k != "keys"}, "source": "data.binance.vision spot monthly "
           "klines 1h (free, public; each zip sha256 equal to its published .CHECKSUM)", "series": {}}
    tot_zip = 0
    for s in sel["symbols"]:
        gp = os.path.join(b9d, f"binance-{s}-1h.json.gz")
        rows, files = {}, []
        for key in sel["keys"][s]:
            body = http_get(BULK + key)
            want = http_get(BULK + key + ".CHECKSUM").decode().split()[0].lower()
            got = hashlib.sha256(body).hexdigest()
            if got != want:
                raise SystemExit(f"STOP: {key}: sha256 differs from the published CHECKSUM")
            with zipfile.ZipFile(io.BytesIO(body)) as z:
                txt = z.read(z.namelist()[0]).decode()
            nk = 0
            for ln in txt.splitlines():
                p = ln.split(",")
                if not p or not p[0].strip().isdigit():
                    continue
                t = to_sec(p[0])
                t -= t % STEP
                rows[t] = (p[1], p[2], p[3], p[4], p[5])
                nk += 1
            files.append({"key": key, "sha256": got, "bytes": len(body), "klines": nk})
            tot_zip += 1
            del body, txt
        st = min(rows)
        nh, nn = write_grid(gp, s, "binance bulk spot 1h klines (data.binance.vision)", st, rows)
        man["series"][s] = {"file": os.path.basename(gp), "sha256": R112.sha256_file(gp), "grid_start_utc": A.iso(st),
                            "hours": nh, "null_hours": nn, "zips": files}
        print(f"{s}: zips {len(files)}, hours {nh}, null {nn}", flush=True)
    man["zips_verified"] = tot_zip
    man["finished_utc"] = now_iso()
    man["status"] = "LOCKED for Round 12 (design/Q26_ROUND12_PREREG.md)"
    h9 = write_json(os.path.join(b9d, "manifest-acquire-b9.json"), man)
    # B10
    first9 = {s: int(min(json.loads(gzip.decompress(open(os.path.join(b9d, v["file"]), "rb").read()))["startTs"]
                         for _ in [0])) for s, v in man["series"].items() if s in ("XMRUSDT", "OMGUSDT", "BTGUSDT")}
    m10 = {"schema": "q26-r12/acquire-b10/1", "started_utc": now_iso(), "code_sha": R112.git_sha(),
           "source": "api-pub.bitfinex.com v2 candles trade:1h (free, keyless; no published checksum; sha256 of every "
           "raw page recorded)", "series": {}}
    for p, e in B10_PAIRS.items():
        if e == "END":
            end_ms = END * 1000
        elif e.startswith("B9:"):
            end_ms = first9[e[3:]] * 1000
        else:
            end_ms = A.utc(e.replace("Z", ":00Z")) * 1000
        rows, start, pages = {}, 0, []
        while True:
            raw = http_get(BFX.format(p=p, s=start, e=end_ms - 1))
            time.sleep(2.5)
            page = json.loads(raw)
            pages.append({"start": start, "sha256": hashlib.sha256(raw).hexdigest(), "candles": len(page)})
            if not page:
                break
            for c in page:   # [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
                rows[int(c[0]) // 1000] = (c[1], c[3], c[4], c[2], c[5])
            if len(page) < 10000:
                break
            start = page[-1][0] + 3600000
        gp = os.path.join(b10d, f"bitfinex-{p}-1h.json.gz")
        st = min(rows)
        nh, nn = write_grid(gp, p, "Bitfinex public candles trade:1h (api-pub.bitfinex.com)", st, rows)
        m10["series"][p] = {"file": os.path.basename(gp), "sha256": R112.sha256_file(gp), "end_exclusive_utc":
                            A.iso(end_ms // 1000), "candles": len(rows), "hours": nh, "null_hours": nn, "pages": pages}
        print(f"{p}: candles {len(rows)}, hours {nh}, null {nn}", flush=True)
    m10["finished_utc"] = now_iso()
    m10["status"] = "LOCKED for Round 12 (design/Q26_ROUND12_PREREG.md)"
    h10 = write_json(os.path.join(b10d, "manifest-acquire-b10.json"), m10)
    print(json.dumps({"b9_series": len(man["series"]), "b9_zips": tot_zip, "b10_series": len(m10["series"]),
                      "b9_manifest_sha256": h9, "b10_manifest_sha256": h10}))


# ---------------------------------------------------------------------------------------------
# blind specs (cuts, renames, redenomination splits) and the registered counts
# ---------------------------------------------------------------------------------------------
def redenom_splits(close):
    """indices i where a run of >= 24 null hours ends and close[i]/last close before the run is outside [0.2, 5]."""
    fin = np.isfinite(close)
    idx = np.where(fin)[0]
    out = []
    for a_, b_ in zip(idx[:-1], idx[1:]):
        if b_ - a_ - 1 >= 24:
            rr = close[b_] / close[a_]
            if not (0.2 <= rr <= 5.0):
                out.append(int(b_))
    return out


def blind_specs(acq, which):
    specs, notes = [], {"splits": [], "cuts": {}}
    if which == "b9":
        man = json.load(open(os.path.join(acq, "b9", "manifest-acquire-b9.json")))
        first = {s: A.utc(v["grid_start_utc"]) for s, v in man["series"].items()}
        cuts = {s: A.utc(d + "T00:00:00Z") for s, d in B9_CUT.items()}
        for old, new in B9_RENAME.items():
            if new in first:
                cuts[old] = min(cuts.get(old, 10 ** 12), first[new])
        for s, v in sorted(man["series"].items()):
            path = os.path.join(acq, "b9", v["file"])
            st, cols = load_json_grid(path)
            n = len(cols["close"])
            last = st + STEP * (n - 1)
            cap_full = min(END, last + STEP)
            cap_pri = min(END, last + STEP - TAIL_DAYS * DAY)
            i1 = n
            if s in cuts:
                i1 = max(0, min(n, (cuts[s] - st) // STEP))
                cap_full, cap_pri = min(cap_full, cuts[s]), min(cap_pri, cuts[s])
                notes["cuts"][s] = A.iso(cuts[s])
            sp = redenom_splits(cols["close"][:i1])
            bounds = [0] + sp + [i1]
            for j in range(len(bounds) - 1):
                if bounds[j + 1] - bounds[j] <= 0:
                    continue
                key = s if j == 0 else f"{s}#{j + 1}"
                specs.append({"key": key, "asset": s, "kind": "grid", "path": path, "slice": (bounds[j], bounds[j + 1]),
                              "cap_full": cap_full, "cap_primary": cap_pri})
            if sp:
                notes["splits"].append({"series": s, "at": [A.iso(st + STEP * i) for i in sp]})
    else:
        man = json.load(open(os.path.join(acq, "b10", "manifest-acquire-b10.json")))
        for p, v in sorted(man["series"].items()):
            path = os.path.join(acq, "b10", v["file"])
            st, cols = load_json_grid(path)
            n = len(cols["close"])
            last = st + STEP * (n - 1)
            sp = redenom_splits(cols["close"])
            bounds = [0] + sp + [n]
            for j in range(len(bounds) - 1):
                key = p if j == 0 else f"{p}#{j + 1}"
                specs.append({"key": key, "asset": p, "kind": "grid", "path": path, "slice": (bounds[j], bounds[j + 1]),
                              "cap_full": min(END, last + STEP), "cap_primary": min(END, last + STEP)})
            if sp:
                notes["splits"].append({"series": p, "at": [A.iso(st + STEP * i) for i in sp]})
    return specs, notes


def count_set(specs, tail):
    """registered counts-only definitions (count_episodes.py of the registration)."""
    from numpy.lib.stride_tricks import sliding_window_view
    acc = {T: {"orig": 0, "pos": [0] * K, "eps": [0] * K, "spans": [[] for _ in range(K)], "weeks": set()}
           for T in HORIZONS}
    nser = 0
    for spc in specs:
        st, cols = load_json_grid(spc["path"])
        i0, i1 = spc["slice"]
        lo, cl = cols["low"][i0:i1], cols["close"][i0:i1]
        t0 = st + STEP * i0
        lim = spc["cap_primary"] if tail else spc["cap_full"]
        n = len(cl)
        any_ = False
        per = {}
        for T in HORIZONS:
            if n - T < 1:
                per[T] = (np.zeros(0, np.int64), np.zeros((0, K), bool))
                continue
            idx = np.arange(1, n - T + 1)
            tt = t0 + idx * STEP
            ok = (tt >= t0 + WARMUP_DAYS * DAY) & (tt + T * STEP <= lim) & ~np.isnan(cl[idx - 1])
            ok &= ~((tt < Q2_END) & (tt + T * STEP > Q2_START))
            isn = np.isnan(lo).astype(np.int32)
            cs = np.concatenate([[0], np.cumsum(isn)])
            ok &= (cs[idx + T] - cs[idx]) <= math.floor(0.05 * T)
            lo_f = np.where(np.isnan(lo), np.inf, lo)
            wmin = lo_f[idx] if T == 1 else sliding_window_view(lo_f, T).min(axis=1)[idx]
            ok &= np.isfinite(wmin)
            sel = np.where(ok)[0]
            S = cl[idx - 1][sel]
            per[T] = (tt[sel], np.stack([wmin[sel] <= S * (1 + k) for k in LEVELS], axis=1))
            any_ |= len(sel) > 0
        if not any_:
            continue
        nser += 1
        for T in HORIZONS:
            tt, y = per[T]
            ac = acc[T]
            ac["orig"] += len(tt)
            ac["weeks"].update(wk(tt).tolist())
            for j in range(K):
                eps = series_episodes(tt[y[:, j]])
                ac["pos"][j] += int(y[:, j].sum())
                ac["eps"][j] += len(eps)
                ac["spans"][j] += [(s_, p_ + T * STEP) for s_, p_ in eps]
    res = {"series": nser, "T": {}}
    for T in HORIZONS:
        ac = acc[T]
        lv = []
        for j, k in enumerate(LEVELS):
            spans = sorted(ac["spans"][j])
            clus = []
            for s_, p_ in spans:
                if clus and s_ - clus[-1][1] <= MERGE_H * STEP:
                    clus[-1][1] = max(clus[-1][1], p_)
                else:
                    clus.append([s_, p_])
            merged, pw = set(), set()
            for s_, p_ in ac["spans"][j]:
                for b in range(int(wk(s_)), int(wk(p_))):
                    merged.add(b)
                pw.add(int(wk(s_)))
            w0, w1 = min(ac["weeks"]), max(ac["weeks"])
            blocks, cur, ln = [], [w0], 1
            for w in range(w0 + 1, w1 + 1):
                if (w - 1) in merged and ln < 4:
                    cur.append(w)
                    ln += 1
                else:
                    blocks.append(cur)
                    cur, ln = [w], 1
            blocks.append(cur)
            nb = sum(1 for b in blocks if any(w in ac["weeks"] for w in b))
            npb = sum(1 for b in blocks if any(w in pw for w in b))
            lv.append({"level": k, "blocks": nb, "positive_blocks": npb, "positive_origins": ac["pos"][j],
                       "series_episodes": ac["eps"][j], "calendar_clusters": len(clus)})
        res["T"][str(T)] = {"validated_origins": ac["orig"], "levels": lv}
    return res


def cmd_counts(a):
    reg = json.load(open(a.registered))
    out = {"schema": "q26-r12/counts/1", "created_utc": now_iso(), "note": "counts only: no forecast, no score"}
    s9, n9 = blind_specs(a.acq, "b9")
    s10, n10 = blind_specs(a.acq, "b10")
    out["b9_notes"], out["b10_notes"] = n9, n10
    out["B9_primary"] = count_set(s9, True)
    out["B9_full"] = count_set(s9, False)
    out["B10"] = count_set(s10, False)
    g = {}
    for nm, sp in (("B9", s9), ("B10", s10)):
        tot = nul = 0
        seen = set()
        for x in sp:
            if x["path"] in seen:
                continue
            seen.add(x["path"])
            st, cols = load_json_grid(x["path"])
            tot += len(cols["close"])
            nul += int(np.isnan(cols["close"]).sum())
        g[nm] = {"grid_hours": tot, "null_hours": nul, "series_fetched": len(seen)}
    out["grid"] = g
    mism = []
    for mine, theirs in (("B9_primary", "B9_primary_tailbuf30d"), ("B9_full", "B9_full_no_tailbuf"), ("B10", "B10")):
        A_, B_ = out[mine], reg[theirs]
        if A_["series"] != B_["series"]:
            mism.append(f"{mine} series {A_['series']} != {B_['series']}")
        for T in map(str, HORIZONS):
            if A_["T"][T]["validated_origins"] != B_["T"][T]["validated_origins"]:
                mism.append(f"{mine} T{T} validated {A_['T'][T]['validated_origins']} != "
                            f"{B_['T'][T]['validated_origins']}")
            for la, lb in zip(A_["T"][T]["levels"], B_["T"][T]["levels"]):
                for fld in ("blocks", "positive_blocks", "positive_origins", "series_episodes", "calendar_clusters"):
                    if la[fld] != lb[fld]:
                        mism.append(f"{mine} T{T} {la['level']} {fld} {la[fld]} != {lb[fld]}")
    for nm in ("B9", "B10"):
        for fld in ("grid_hours", "null_hours"):
            if g[nm][fld] != reg["grid"][nm][fld]:
                mism.append(f"{nm} {fld} {g[nm][fld]} != {reg['grid'][nm][fld]}")
    out["mismatches"] = mism
    out["equal_to_registered"] = not mism
    h = write_json(os.path.join(a.acq, "counts-r12-builder.json"), out)
    print(json.dumps({"grid": g, "splits_b9": n9["splits"], "splits_b10": n10["splits"],
                      "B9_series": out["B9_primary"]["series"], "B10_series": out["B10"]["series"],
                      "mismatches": mism[:20], "n_mismatches": len(mism), "sha256": h}, indent=1))
    if mism:
        raise SystemExit("STOP: builder counts differ from the registered counts")


# =============================================================================================
# freeze and blind run
# =============================================================================================
def cmd_freeze(a):
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "frozen-r12-config.json")
    if os.path.exists(path):
        raise SystemExit("STOP: frozen config exists")
    if not R112.git_clean():
        raise SystemExit("STOP: code tree not clean")
    cnt = json.load(open(os.path.join(a.acq, "counts-r12-builder.json")))
    if not cnt["equal_to_registered"]:
        raise SystemExit("STOP: counts not equal to the registered counts")
    inputs = {}
    for sub, mn in (("b9", "manifest-acquire-b9.json"), ("b10", "manifest-acquire-b10.json")):
        man = json.load(open(os.path.join(a.acq, sub, mn)))
        inputs[f"{sub}/{mn}"] = R112.sha256_file(os.path.join(a.acq, sub, mn))
        for s, v in man["series"].items():
            p = os.path.join(a.acq, sub, v["file"])
            if R112.sha256_file(p) != v["sha256"]:
                raise SystemExit(f"STOP: {p} sha256 differs from its manifest")
            inputs[f"{sub}/{v['file']}"] = v["sha256"]
    inputs["counts-r12-builder.json"] = R112.sha256_file(os.path.join(a.acq, "counts-r12-builder.json"))
    dev = {n: R112.sha256_file(os.path.join(a.dev, n)) for n in
           ("dev-readings-r12.json", "pooled-frozen-r12.json", "pooled-arrays-r12.npz")}
    pf = json.load(open(os.path.join(a.dev, "pooled-frozen-r12.json")))
    cfg = {"schema": "q26-r12/frozen-config/1", "created_utc": now_iso(), "prereg": PREREG,
           "code": {"repo": "The-Membrane/membrane-app", "sha": R112.git_sha(),
                    "path": "scripts/research/history-forecasts/r12_tail.py",
                    "sha256": R112.sha256_file(os.path.abspath(__file__)), "clean": R112.git_clean()},
           "inputs": inputs, "dev_outputs": dev,
           "selected_r121": pf["selected_r121"], "r122_rule": pf["r122_rule"],
           "pooled_frozen": {k: pf[k] for k in ("poisson", "theta_frozen", "e", "xi", "G", "delta_frozen")},
           "constants": {"horizons_h": list(HORIZONS), "levels": list(LEVELS), "deep": list(DEEP),
                         "shown": {TL[T]: list(v) for T, v in SHOWN.items()}, "c1_q": C1_Q, "xi_clip": list(XI_CLIP),
                         "jump_sigma": JUMP_SIG, "n168": N168, "c2_lambda_frac": C2_LAMBDA_FRAC, "c4_n0": C4_N0,
                         "c1_min_exceedances": C1_MIN_EXC, "k2_clip": list(K2_CLIP), "p_clip": P_CLIP,
                         "merge_h": MERGE_H, "tail_days": TAIL_DAYS, "n_boot": N_BOOT,
                         "seed_r121": SEED_R121, "seed_r122": SEED_R122, "alpha_family": ALPHA_FAM,
                         "R_band_r121": list(R_BAND_121), "R_band_r122": list(R_BAND_122),
                         "min_positive_blocks": MIN_POS_BLOCKS, "hac_lag_h": HAC_LAG, "end": A.iso(END),
                         "q2_reported": [A.iso(Q2_START), A.iso(Q2_END)], "warmup_days": WARMUP_DAYS},
           "decisions": DECISIONS}
    h = write_json(path, cfg)
    print(json.dumps({"frozen_config_sha256": h, "created_utc": cfg["created_utc"], "code": cfg["code"]["sha"]}))


def load_pooled(dev):
    pf = json.load(open(os.path.join(dev, "pooled-frozen-r12.json")))
    arr = np.load(os.path.join(dev, "pooled-arrays-r12.npz"))
    pooled = {"poisson": pf["poisson"], "xi": {}, "G": {}, "lib": {}}
    for T in HORIZONS:
        pooled["xi"][T] = pf["xi"][TL[T]]["xi"]
        g = dict(pf["G"][TL[T]])
        g["E"] = np.sort(arr[f"jumpE_{TL[T]}"].astype(float))
        pooled["G"][T] = g
        pooled["lib"][T] = arr[f"lib_{TL[T]}"]
    return pf, pooled


def r121_blind_T(res, T, sel, pf, pooled, log, tag, cell_seed_base, primary=True):
    keep = (lambda rw: ~rw["q2"] & ~rw["tail"]) if primary else (lambda rw: ~rw["q2"])
    S = stack_rows(res, keep)
    keymap = {j: r["key"] for j, r in enumerate(res)}
    betas = c1_betas({r["key"]: r["folds"] for r in res}, pooled["xi"][T])
    theta = np.array(pf["theta_frozen"][TL[T]])
    n = len(S["ts"])
    P = {c: np.zeros((n, K), np.float32) for c in ("fH", "f", "a", "SEL")}
    for j in np.unique(S["sid"]):
        m = S["sid"] == j
        rows = {k: v[m] for k, v in S.items()}
        out = apply_candidates(rows, keymap[int(j)], T, pooled, np.tile(theta, (int(m.sum()), 1)), betas)
        for c in ("fH", "f", "a"):
            P[c][m] = out[c]
        P["SEL"][m] = out[sel]
    y = S["y"].astype(np.float32)
    ec = np.array([pf["e"][TL[T]][repr(k)] for k in LEVELS], np.float32)
    cells = {}
    for jj, k in enumerate(DEEP):
        col = DI[jj]
        yc = y[:, col].astype(float)
        g, G, pb = crash_blocks(S["ts"], S["sid"], yc, T)
        rng = np.random.default_rng(np.random.SeedSequence([SEED_R121, cell_seed_base + jj]))
        idx = rng.integers(0, G, size=(N_BOOT, G))
        ps = P["SEL"][:, col].astype(float)
        sec = (ps - yc) ** 2
        cell = {"T": TL[T], "level": k, "rows": int(n), "positive_origins": int(yc.sum()), "blocks": int(G),
                "positive_blocks": int(pb.sum()), "series": int(len(np.unique(S["sid"]))),
                "R": float(ps.sum() / yc.sum()) if yc.sum() > 0 else None, "vs": {}}
        cell["R_cmp"] = {c: (float(P[c][:, col].sum() / yc.sum()) if yc.sum() > 0 else None) for c in ("fH", "f", "a")}
        cell["R_cmp"]["e"] = float(ec[col] * n / yc.sum()) if yc.sum() > 0 else None
        pmax = []
        for cmp in CMPS:
            pc = np.full(n, ec[col], float) if cmp == "e" else P[cmp][:, col].astype(float)
            d = sec - (pc - yc) ** 2
            bt = boot_test(g, d, idx)
            ct = cr1_test(g, d)
            dk = dk_hac(S["ts"], d)
            bc = float(np.mean((pc - yc) ** 2))
            Sb, _ = cluster_sums(g, d, G)
            cell["vs"][cmp] = {"mean_d": float(d.mean()), "bss": 1 - float(sec.mean()) / bc if bc > 0 else None,
                               "boot": bt, "cr1": ct, "dk_hac_reported": dk,
                               "largest_block_share_of_d_sum": float(np.max(np.abs(Sb)) / abs(Sb.sum()))
                               if Sb.sum() != 0 else None}
            pmax += [bt["p_one_sided"], ct["p_one_sided"] if ct["p_one_sided"] is not None else 1.0]
        cell["cell_p"] = float(max(pmax))
        cell["all_mean_d_negative"] = bool(all(cell["vs"][c]["mean_d"] < 0 for c in CMPS))
        cell["R_in_band"] = bool(cell["R"] is not None and R_BAND_121[0] <= cell["R"] <= R_BAND_121[1])
        cell["reported_only_low_blocks"] = bool(pb.sum() < MIN_POS_BLOCKS)
        # per-year R and BSS vs fH (reported)
        yr = np.array([int(A.iso(int(t))[:4]) for t in S["ts"]])
        py = {}
        for u in np.unique(yr):
            mm = yr == u
            sy = float(yc[mm].sum())
            bh = float(np.mean((P["fH"][mm, col] - yc[mm]) ** 2))
            py[str(u)] = {"rows": int(mm.sum()), "pos": sy, "R": float(ps[mm].sum() / sy) if sy > 0 else None,
                          "bss_vs_fH": 1 - float(sec[mm].mean()) / bh if bh > 0 else None}
        cell["per_year"] = py
        cell["corp"] = A6.corp(ps, yc)
        cells[repr(k)] = cell
        log(f"  {tag} {TL[T]} {k:+.2f}: R {cell['R']:.3f}; " + "; ".join(
            f"vs {c} BSS {cell['vs'][c]['bss']:+.4f} pb {cell['vs'][c]['boot']['p_one_sided']:.3g} "
            f"pt {cell['vs'][c]['cr1']['p_one_sided']:.3g}" for c in CMPS) + f"; cell p {cell['cell_p']:.3g}; "
            f"pos blocks {cell['positive_blocks']}")
    # pooled deep per T (reported, Bonferroni over 6) and all ten levels
    yd = y[:, DI].astype(float)
    sel_se = ((P["SEL"][:, DI] - yd) ** 2).mean(1)
    gi, G, _ = crash_blocks(S["ts"], S["sid"], yd[:, 0], T)
    pooledT = {}
    for cmp in CMPS:
        pc = np.tile(ec[DI], (n, 1)) if cmp == "e" else P[cmp][:, DI].astype(float)
        d = sel_se - ((pc - yd) ** 2).mean(1)
        pooledT[cmp] = {"mean_d": float(d.mean()), "bss": 1 - float(sel_se.mean()) / float(((pc - yd) ** 2).mean()),
                        "cr1": cr1_test(gi, d)}
    lv = {}
    for j, k in enumerate(LEVELS):
        sy = float(y[:, j].sum())
        bh = float(np.mean((P["fH"][:, j] - y[:, j]) ** 2))
        lv[repr(k)] = {"pos": sy, "R_sel": float(P["SEL"][:, j].sum() / sy) if sy else None,
                       "R_fH": float(P["fH"][:, j].sum() / sy) if sy else None,
                       "bss_sel_vs_fH": 1 - float(np.mean((P["SEL"][:, j] - y[:, j]) ** 2)) / bh if bh > 0 else None}
    # per-series spread of BSS vs fH over the deep cells (reported)
    spread = []
    for j in np.unique(S["sid"]):
        mm = S["sid"] == j
        bh = float(((P["fH"][mm][:, DI] - yd[mm]) ** 2).mean())
        if bh > 0 and yd[mm].sum() > 0:
            spread.append(1 - float(sel_se[mm].mean()) / bh)
    sp = np.array(spread)
    extra = {"pooled_deep": pooledT, "all_levels": lv, "rows": int(n),
             "per_series_bss_vs_fH": {"n": int(len(sp)), "median": float(np.median(sp)) if len(sp) else None,
                                      "q25": float(np.quantile(sp, 0.25)) if len(sp) else None,
                                      "q75": float(np.quantile(sp, 0.75)) if len(sp) else None,
                                      "n_positive": int((sp > 0).sum())}}
    return cells, extra


def r121_q2_reported(res, T, sel, pf, pooled):
    S = stack_rows(res, lambda rw: rw["q2"])
    if S is None:
        return None
    keymap = {j: r["key"] for j, r in enumerate(res)}
    betas = c1_betas({r["key"]: r["folds"] for r in res}, pooled["xi"][T])
    theta = np.array(pf["theta_frozen"][TL[T]])
    out = {}
    PS, PH = [], []
    for j in np.unique(S["sid"]):
        m = S["sid"] == j
        rows = {k: v[m] for k, v in S.items()}
        o = apply_candidates(rows, keymap[int(j)], T, pooled, np.tile(theta, (int(m.sum()), 1)), betas)
        PS.append(o[sel][:, DI])
        PH.append(o["fH"][:, DI])
    ps, ph = np.concatenate(PS), np.concatenate(PH)
    order = np.argsort(S["sid"], kind="mergesort")
    yd = S["y"][order][:, DI].astype(float)
    for jj, k in enumerate(DEEP):
        sy = float(yd[:, jj].sum())
        out[repr(k)] = {"rows": int(len(yd)), "pos": sy, "R_sel": float(ps[:, jj].sum() / sy) if sy else None,
                        "brier_sel": brier(ps[:, jj], yd[:, jj]), "brier_fH": brier(ph[:, jj], yd[:, jj])}
    return out


def lookahead(spec, T, sel, pf, pooled):
    """perturb prices from a cut on; forecasts at origins whose window ends at or before the cut must not change."""
    import copy
    r0 = series_task({"spec": spec, "T": T, "grid": "1h"})
    st, cols = load_json_grid(spec["path"])
    i0, i1 = spec["slice"]
    cut = i0 + int((i1 - i0) * 0.7)
    rng = np.random.default_rng(SEED_R121 + T)
    f = np.exp(rng.normal(0, 0.05, len(cols["close"]) - cut))
    tmp = os.path.join(os.path.dirname(spec["path"]), "..", "lookahead-tmp.json.gz")
    g = json.loads(gzip.decompress(open(spec["path"], "rb").read()))
    for c in ("open", "high", "low", "close"):
        g["columns"][c] = [v if (v is None or i < cut) else v * float(f[i - cut]) for i, v in enumerate(g["columns"][c])]
    with gzip.GzipFile(tmp, "wb", mtime=0) as fh:
        fh.write(json.dumps(g).encode())
    sp2 = copy.deepcopy(spec)
    sp2["path"] = tmp
    r1 = series_task({"spec": sp2, "T": T, "grid": "1h"})
    os.remove(tmp)
    cut_ts = st + STEP * cut
    md = 0.0
    theta = np.array(pf["theta_frozen"][TL[T]])
    outs = []
    for r in (r0, r1):
        betas = c1_betas({r["key"]: r["folds"]}, pooled["xi"][T])
        rows = r["rows"]
        o = apply_candidates(rows, r["key"], T, pooled, np.tile(theta, (len(rows["ts"]), 1)), betas)
        outs.append((rows["ts"], o))
    m0 = outs[0][0] + T * STEP <= cut_ts
    m1 = outs[1][0] + T * STEP <= cut_ts
    if m0.sum() != m1.sum() or np.any(outs[0][0][m0] != outs[1][0][m1]):
        return {"series": spec["key"], "T": TL[T], "cut_utc": A.iso(cut_ts), "max_abs_diff": float("inf")}
    for c in ("fH", "f", "a", sel):
        dd = np.abs(outs[0][1][c][m0] - outs[1][1][c][m1])
        if dd.size:
            md = max(md, float(np.nanmax(dd)))
    return {"series": spec["key"], "T": TL[T], "cut_utc": A.iso(cut_ts), "rows_checked": int(m0.sum()),
            "max_abs_diff": md}


def r122_blind_T(res, T, rule, pf, log, tag, seed_off):
    fd = {int(k): v for k, v in pf["delta_frozen"][TL[T]].items()}
    O = r122_rows(res, T, frozen_delta=fd, which=[rule])
    y = O["y"]
    p = O["rules"][rule]
    ec = np.array([pf["e"][TL[T]][repr(k)] for k in SHOWN[T]])
    se_r = ((p - y) ** 2).mean(1)
    se = {"fH": ((O["fH"] - y) ** 2).mean(1), "f": ((O["f"] - y) ** 2).mean(1), "e": ((ec[None, :] - y) ** 2).mean(1)}
    gw = np.unique(wk(O["ts"]), return_inverse=True)[1]
    G = int(gw.max()) + 1
    rng = np.random.default_rng(np.random.SeedSequence([SEED_R122, seed_off]))
    idx = rng.integers(0, G, size=(N_BOOT, G))
    out = {"T": TL[T], "rule": rule, "rows": int(len(y)), "weeks": G, "series": int(len(np.unique(O["sid"]))), "vs": {}}
    for cmp in ("fH", "f", "e"):
        d = se_r - se[cmp]
        out["vs"][cmp] = {"mean_d": float(d.mean()), "bss": 1 - float(se_r.mean()) / float(se[cmp].mean()),
                          "boot": boot_test(gw, d, idx), "dk_hac": dk_hac(O["ts"], d)}
    sy = float(y.sum())
    out["R_rule"] = float(p.sum() / sy)
    out["R_fH"] = float(O["fH"].sum() / sy)
    out["R_f"] = float(O["f"].sum() / sy)
    mon = np.array([A.iso(int(t))[:7] for t in O["ts"]])
    mr = {}
    for u in np.unique(mon):
        mm = mon == u
        s_ = float(y[mm].sum())
        if s_ > 0:
            mr[u] = {"rows": int(mm.sum()), "R_fH": float(O["fH"][mm].sum() / s_), "R_rule": float(p[mm].sum() / s_)}
    out["per_month"] = mr
    medf = float(np.median([abs(math.log(v["R_fH"])) for v in mr.values() if v["R_fH"] > 0]))
    medr = float(np.median([abs(math.log(v["R_rule"])) for v in mr.values() if v["R_rule"] > 0]))
    out["median_abs_lnR_month"] = {"fH": medf, "rule": medr}
    qn = np.array([quarter_of(t) for t in O["ts"]])
    out["per_quarter"] = {u: {"R_fH": float(O["fH"][qn == u].sum() / max(y[qn == u].sum(), 1e-12)),
                              "R_rule": float(p[qn == u].sum() / max(y[qn == u].sum(), 1e-12))} for u in np.unique(qn)}
    a3 = 0.05 / 3
    chk = {}
    for cmp in ("fH", "e"):
        v = out["vs"][cmp]
        chk[f"vs_{cmp}"] = bool(v["mean_d"] < 0 and v["boot"]["p_one_sided"] < a3 and
                                v["dk_hac"]["p_one_sided"] is not None and v["dk_hac"]["p_one_sided"] < a3)
    chk["R_in_band"] = bool(R_BAND_122[0] <= out["R_rule"] <= R_BAND_122[1])
    chk["monthly_lnR_better"] = bool(medr < medf)
    chk["bss_vs_f_not_negative"] = bool(out["vs"]["f"]["bss"] >= 0)
    out["checks"] = chk
    out["pass"] = bool(all(chk.values()))
    log(f"  {tag} {TL[T]}: pass={out['pass']} rule {rule}; R {out['R_fH']:.3f} -> {out['R_rule']:.3f}; " + "; ".join(
        f"vs {c} BSS {out['vs'][c]['bss']:+.4f} pb {out['vs'][c]['boot']['p_one_sided']:.3g} "
        f"phac {out['vs'][c]['dk_hac']['p_one_sided']:.3g}" for c in ("fH", "f", "e")) + f"; checks {chk}")
    return out


def cmd_run(a):
    t_start = time.time()
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "run-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    cpath = os.path.join(a.cfgdir, "frozen-r12-config.json")
    cfg = json.load(open(cpath))
    want = open(cpath + ".sha256").read().split()[0]
    if R112.sha256_file(cpath) != want:
        raise SystemExit("STOP: frozen config hash mismatch")
    if cfg["code"]["sha"] != R112.git_sha() or not R112.git_clean():
        raise SystemExit("STOP: code sha differs from the frozen config or tree not clean")
    for rel, h in cfg["inputs"].items():
        if R112.sha256_file(os.path.join(a.acq, rel)) != h:
            raise SystemExit(f"STOP: input {rel} sha256 differs")
    for rel, h in cfg["dev_outputs"].items():
        if R112.sha256_file(os.path.join(a.dev, rel)) != h:
            raise SystemExit(f"STOP: dev output {rel} sha256 differs")
    item = a.item
    rp = os.path.join(a.out, f"results-{item}.json")
    marker = os.path.join(a.out, f"run-started-{item}.json")
    if os.path.exists(rp) or os.path.exists(marker):
        raise SystemExit("STOP: one run only")
    write_json(marker, {"started_utc": now_iso(), "config_sha256": want, "item": item})
    log(f"RUN START {item} (UTC); config sha256 {want}; code {cfg['code']['sha']}")
    pf, pooled = load_pooled(a.dev)
    results = {"schema": f"q26-r12/results-{item}/1", "item": item, "started_utc": json.load(open(marker))["started_utc"],
               "config_sha256": want, "code_sha": cfg["code"]["sha"], "sets": {}}
    for setname in ("b9", "b10"):
        specs, notes = blind_specs(a.acq, setname)
        results["sets"][setname] = {"notes": notes, "n_specs": len(specs)}
        if item == "r12.1":
            cells_all, extra_all, full_all, q2_all = {}, {}, {}, {}
            for ti, T in enumerate(HORIZONS):
                tasks = [{"spec": s, "T": T, "grid": "1h"} for s in specs]
                res = run_pool(tasks, a.workers, log, f"{setname} {TL[T]}")
                sel = pf["selected_r121"][TL[T]]
                cells, extra = r121_blind_T(res, T, sel, pf, pooled, log, setname, 100 * ti + (0 if setname == "b9"
                                                                                                 else 50))
                cells_all.update({f"{TL[T]} {k}": v for k, v in cells.items()})
                extra_all[TL[T]] = extra
                if setname == "b9":
                    cf, _ = r121_blind_T(res, T, sel, pf, pooled, lambda s: None, "full", 100 * ti + 25, primary=False)
                    full_all[TL[T]] = {k: {"R": v["R"], "positive_blocks": v["positive_blocks"],
                                           "mean_d": {c: v["vs"][c]["mean_d"] for c in CMPS},
                                           "bss": {c: v["vs"][c]["bss"] for c in CMPS}, "cell_p": v["cell_p"]}
                                       for k, v in cells.items()}
                q2_all[TL[T]] = r121_q2_reported(res, T, sel, pf, pooled)
                del res
            names = list(cells_all)
            pv = np.array([cells_all[c]["cell_p"] for c in names])
            hk = holm(pv)
            for c, ok in zip(names, hk):
                v = cells_all[c]
                v["holm_pass"] = bool(ok)
                v["pass"] = bool(v["all_mean_d_negative"] and ok and v["R_in_band"])
            results["sets"][setname].update({"cells": cells_all, "per_T": extra_all, "q2_reported": q2_all})
            if setname == "b9":
                results["sets"][setname]["full_series_variant"] = full_all
                results["sets"][setname]["verdicts"] = {c: cells_all[c]["pass"] for c in names}
                # per-T pooled deep verdicts (reported, Bonferroni over 6)
                results["sets"][setname]["per_T_pooled_reported"] = {
                    T_: bool(all(extra_all[T_]["pooled_deep"][c]["mean_d"] < 0 and
                                 (extra_all[T_]["pooled_deep"][c]["cr1"]["p_one_sided"] or 1) < 0.05 / 6 for c in CMPS))
                    for T_ in extra_all}
                log(f"B9 verdicts: {sum(results['sets'][setname]['verdicts'].values())} of {len(names)} cells pass")
            else:
                b9c = results["sets"]["b9"]["cells"]
                era = {}
                for c in names:
                    v = cells_all[c]
                    era[c] = bool(b9c[c]["pass"] and v["all_mean_d_negative"] and v["cell_p"] < 0.05 and
                                  not v["reported_only_low_blocks"])
                results["sets"][setname]["era_robust"] = era
        else:
            per = {}
            for ti, T in enumerate(SHOWN):
                tasks = [{"spec": s, "T": T, "grid": "1h"} for s in specs]
                res = run_pool(tasks, a.workers, log, f"{setname} {TL[T]}")
                rule = pf["r122_rule"]["rule_per_T"][TL[T]]
                per[TL[T]] = r122_blind_T(res, T, rule, pf, log, setname, 10 * ti + (0 if setname == "b9" else 5))
                del res
            results["sets"][setname]["per_T"] = per
            if setname == "b10":
                results["sets"][setname]["era_robust"] = {
                    T_: bool(results["sets"]["b9"]["per_T"][T_]["pass"] and v["vs"]["fH"]["mean_d"] < 0 and
                             v["vs"]["e"]["mean_d"] < 0 and v["vs"]["fH"]["boot"]["p_one_sided"] < 0.05 and
                             v["vs"]["e"]["boot"]["p_one_sided"] < 0.05) for T_, v in per.items()}
            else:
                results["sets"][setname]["verdicts"] = {T_: v["pass"] for T_, v in per.items()}
    if item == "r12.1":
        s9, _ = blind_specs(a.acq, "b9")
        sp = [s for s in s9 if s["key"] == "ETCUSDT"] or [s9[0]]
        results["lookahead_check"] = [lookahead(sp[0], T, pf["selected_r121"][TL[T]], pf, pooled) for T in (1, 24)]
        log(f"lookahead {results['lookahead_check']}")
    results["finished_utc"] = now_iso()
    results["runtime_s"] = time.time() - t_start
    h = write_json(rp, results)
    log(f"RUN END {item} (UTC); results sha256 {h}; {results['runtime_s']:.0f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("dev", "acquire", "counts", "freeze", "run"))
    ap.add_argument("--datasets")
    ap.add_argument("--acq")
    ap.add_argument("--dev")
    ap.add_argument("--out")
    ap.add_argument("--cfgdir")
    ap.add_argument("--registered")
    ap.add_argument("--item", choices=("r12.1", "r12.2"))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    {"dev": cmd_dev, "acquire": cmd_acquire, "counts": cmd_counts, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
