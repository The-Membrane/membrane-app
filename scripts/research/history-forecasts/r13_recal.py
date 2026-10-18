"""Q26 Round 13: R13.1 slope-from-pool, level-from-subject recalibration of (fH); blind set B15 (MEXC venue-unique).

membrane-board design/Q26_ROUND13_PREREG.md (R13.1, D-R13.1a ...), design/q26-blind-set-inventory-2026-10-17.md
section 13 (B15a confirm, B15b held back).

Commands
  select-b15   MEXC live USDT spot pairs on no used venue list; listing probe = month of the first monthly kline
               (timestamp only; no price is kept or printed). Split by sha256('Q26-R13-B15:' + base).
  dev          development on SEEN data only (R12 development pool, B9, B12, B13a): slope fits, level menu,
               development effects and power inputs for R13.1; ln sigma_fut errors for R13.2/R13.3 power.
  acquire-b15a outcome-blind B15a builder (MEXC 60m klines, sha256 per raw page). Prints no label or price.
  counts       counts only on B15a (validated origins, positive origins, positive blocks per cell).
  power        projected power at the B15a counts from the development effects.
  freeze       frozen config (code sha, input sha256 values, maps, constants, seeds, created_utc).
  run          one run on B15a from the frozen config.

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
import urllib.parse  # noqa: E402
import warnings  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402
from scipy.special import expit  # noqa: E402
from scipy.stats import norm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a2_touch as M2  # noqa: E402
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402
import a_touch as A  # noqa: E402
import r112_combine as R112  # noqa: E402
import r12_tail as R12  # noqa: E402
import r125_fh_deep as R125  # noqa: E402

STEP = R12.STEP
DAY = 86400
LEVELS = R12.LEVELS
KIX = {k: j for j, k in enumerate(LEVELS)}
SHALLOW = [j for j, k in enumerate(LEVELS) if k >= -0.10]
DEEP = [j for j, k in enumerate(LEVELS) if k <= -0.15]
BANDS = {"shallow": SHALLOW, "deep": DEEP}
HS = (1, 3, 12, 24, 72)
TL = R12.TL
# scored cells (fixed in D-R13.1a before any B15a byte): shallow = the R11.10 validated region; deep = R12.5 cells
CELLS_SHALLOW = [(1, -0.02), (1, -0.03), (3, -0.02), (3, -0.03), (3, -0.05), (3, -0.07),
                 (12, -0.02), (12, -0.03), (12, -0.05), (12, -0.07), (12, -0.10)]
CELLS_DEEP = [(12, -0.15), (12, -0.20), (24, -0.15), (24, -0.20), (72, -0.15), (72, -0.20)]
CELLS = CELLS_SHALLOW + CELLS_DEEP
MENU = [(30, 20.0), (30, 50.0), (90, 20.0), (90, 50.0)]   # (W days, kappa); simplicity order: larger kappa, longer W
LEVEL_GRID = 6 * STEP                                     # level sums use origins on the 6-hourly grid only
PCLIP = 1e-4
SEED = 20261831
NB = 2000
NI_MARGIN = -0.002                                        # Brier non-inferiority: BSS(p' vs fH) lower 90% bound
DSC_TOL = 0.01                                            # DSC(p') >= (1 - DSC_TOL) * DSC(fH)
ALPHA = 0.05
WICK_MULT = 9.0                                           # R13.3 constant, fixed in the memo

MEXC_INFO = "https://api.mexc.com/api/v3/exchangeInfo"
MEXC_K = "https://api.mexc.com/api/v3/klines?symbol={s}&interval={i}&startTime={a}&endTime={b}&limit={n}"
SPLIT_B15 = "Q26-R13-B15:"
B15_FIRST_MAX = "2025-06"                                 # first monthly kline month <= 2025-06
ACQ_END = R12.END


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256b(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(p):
    return sha256b(open(p, "rb").read())


# =============================================================================================
# B15 selection (listings only)
# =============================================================================================
def used_lists(datasets):
    s12 = json.load(open(os.path.join(datasets, "b12-venue-unique-prices/selection-b12.json")))
    b12 = {x.split("-")[0].replace("USDT", "") for x in set(s12["okx"]["kept"]) | set(s12["bybit"]["kept"])}
    s13 = json.load(open(os.path.join(datasets, "b13-kucoin-prices/selection-b13.json")))
    kc = set(s13["on_binance"]) | set(s13["in_b12"]) | set(s13["excluded"]) | set(s13["kept"])
    s14 = json.load(open(os.path.join(datasets, "b14-gate-prices/selection-b14.json")))
    b14 = set(s14["B14a"]) | set(s14["B14b"])
    return b12, kc, b14


def mexc_first_month(sym):
    """month (YYYY-MM) of the first monthly kline; only the open timestamp is read, prices are discarded."""
    raw = R125.http_get(MEXC_K.format(s=urllib.parse.quote(sym), i="1M", a=1483228800000, b=ACQ_END * 1000, n=1000))
    d = json.loads(raw)
    if not isinstance(d, list) or not d:
        return None
    t = min(int(x[0]) for x in d) // 1000
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m")


def cmd_select_b15(a):
    raw = R125.http_get(MEXC_INFO)
    info = json.loads(raw)
    b12, kc, b14 = used_lists(a.datasets)
    bn = set(R125.binance_symbols())
    rec = {"mexc_usdt_pairs": 0, "on_binance": [], "on_kucoin": [], "in_b12": [], "in_b14": [], "excluded": {},
           "kept": []}
    sym_of = {}
    for s in sorted(info["symbols"], key=lambda x: x["symbol"]):
        if s.get("quoteAsset") != "USDT":
            continue
        rec["mexc_usdt_pairs"] += 1
        base = s["baseAsset"].upper()
        sym_of[base] = s["symbol"]
        if R125.on_binance(base, bn):
            rec["on_binance"].append(base)
        elif base in kc:
            rec["on_kucoin"].append(base)
        elif base in b12:
            rec["in_b12"].append(base)
        elif base in b14:
            rec["in_b14"].append(base)
        elif R125.excluded(base):
            rec["excluded"][base] = R125.excluded(base)
        else:
            rec["kept"].append(base)
    with cf.ThreadPoolExecutor(6) as ex:
        first = dict(zip(rec["kept"], ex.map(lambda b: mexc_first_month(sym_of[b]), rec["kept"])))
    elig = sorted(b for b in rec["kept"] if first.get(b) and first[b] <= B15_FIRST_MAX)
    out = {"schema": "q26-r13-b15-selection-v1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "source": "MEXC public REST api/v3 klines 60m (keyless); live USDT spot pairs only (exchangeInfo)",
           "mexc_exchangeinfo_sha256": sha256b(raw), "binance_spot_symbols": len(bn),
           "binance_list_sha256": sha256b("\n".join(sorted(bn)).encode()), "kucoin_usdt_dirs": len(kc),
           "b12_assets": len(b12), "b14_assets": len(b14), "first_month": first,
           "eligible_first_month_le": B15_FIRST_MAX, "eligible": elig,
           "split_rule": f"sha256('{SPLIT_B15}' + base)[0:2] as hex byte: even -> B15a, odd -> B15b",
           "B15a": [b for b in elig if int(sha256b((SPLIT_B15 + b).encode())[:2], 16) % 2 == 0],
           "B15b": [b for b in elig if int(sha256b((SPLIT_B15 + b).encode())[:2], 16) % 2 == 1],
           "symbol": {b: sym_of[b] for b in elig}, **rec}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-b15.json")
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in out.items()}, indent=1))
    print("sha256", sha_file(p))


# =============================================================================================
# series loading (R12 grids, B13a hourly npz, B15a grids)
# =============================================================================================
def load_any(spec):
    if spec["kind"] != "npz":
        return R12.load_series(spec)
    d = np.load(spec["path"])
    st = int(d["startTs"])
    ser = M3.S3(spec["key"], spec["key"], "kucoin", np.asarray(d["close"], float), np.asarray(d["low"], float),
                LEVELS, st, st)
    A6.attach_high(ser, np.asarray(d["high"], float))
    folds = R12.generic_folds(ser, st)
    return ser, folds, {"full": int(spec["cap_full"]), "primary": int(spec["cap_primary"])}


def b13a_specs(datasets):
    acq = os.path.join(datasets, "b13-kucoin-prices/b13a")
    man = json.load(open(os.path.join(acq, "manifest-acquire-B13a.json")))
    out = []
    for p in man["pairs"]:
        if p.get("empty") or not p.get("hours"):
            continue
        last = p.get("last_minute_ts")
        ended = last is not None and last < ACQ_END - R12.TAIL_DAYS * DAY
        cap_pri = (last + 60 - R12.TAIL_DAYS * DAY) // STEP * STEP if ended else ACQ_END
        out.append({"key": "b13a:" + p["pair"], "kind": "npz", "path": os.path.join(acq, p["pair"] + ".npz"),
                    "cap_full": int(ACQ_END), "cap_primary": int(cap_pri)})
    return out


def b9_specs(datasets, tmp):
    R125.link_acq(tmp, datasets)
    sp, _ = R12.blind_specs(tmp, "b9")
    for x in sp:
        x["key"] = "b9:" + x["key"]
    return sp


def b12_specs(datasets):
    sp = R125.b12_specs(os.path.join(datasets, "b12-venue-unique-prices"))
    for x in sp:
        x["key"] = "b12:" + x["key"]
    return sp


# =============================================================================================
# rows: (fH), (f), (a) touch forecasts and, optionally, ln sigma_fut errors of (fH), (fHQ), (fHW)
# =============================================================================================
def wick_design(P6, ser):
    """R13.3: X = [1, ln D_w, ln W, ln M], D_w = mean_24h min(v, 9 * median_24h(v)) with the A6 null rule."""
    from numpy.lib.stride_tricks import sliding_window_view
    n = P6.n
    v = A6.parkinson_v(ser.high, ser.low)
    N = len(v)
    dw = np.full(N + 1, np.nan)
    if N >= 24:
        W = sliding_window_view(v, 24)                      # W[j] = v[j .. j+23] -> origin i = j + 24
        nn = np.sum(~np.isfinite(W), axis=1)
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(W, axis=1)
            Wc = np.minimum(W, WICK_MULT * med[:, None])
            mw = np.nanmean(Wc, axis=1)
        i = np.arange(24, N + 1)
        ok = (nn <= M3.max_nulls(24, M3.NULL_FRAC)) & (nn < 24) & (i - 24 >= ser.start_i)
        dw[i[ok]] = mw[ok]
    with np.errstate(invalid="ignore", divide="ignore"):
        L = np.log(A6.har_of(ser)[:n])
        ld = np.log(A6.ANNUAL * dw[:n])
        lfut = np.log(A6.sfut_of(ser, P6.T_h)[:n])
    X = np.column_stack([np.ones(n), ld, L[:, 1], L[:, 2]])
    okX = np.all(np.isfinite(X), axis=1)
    okH = P6.P.lab_ok & okX & np.isfinite(lfut)
    Xz = np.where(okH[:, None], X, 0.0)
    yz = np.where(okH, lfut, 0.0)
    return {"X": X, "okX": okX, "cXX": np.cumsum(Xz[:, :, None] * Xz[:, None, :], axis=0),
            "cXy": np.cumsum(Xz * yz[:, None], axis=0), "cn": np.cumsum(okH), "lfut": lfut}


def row_task(a):
    import r13_devcheck as DC
    spec, T, grid, with_vol = a["spec"], a["T"], a["grid"], a.get("vol", False)
    ser, folds, caps = load_any(spec)
    P6 = A6.Prep6(ser, T, with_fbL=False)
    P, n = P6.P, P6.n
    Q = DC.harq_design(P6, ser) if with_vol else None
    Wd = wick_design(P6, ser) if with_vol else None
    ts_all = ser.base_ts + STEP * np.arange(n)
    i_all = np.arange(n)
    keys = ["ts", "y", "pH", "pf", "pa", "q2", "tail"] + (["lfut", "lsH", "lsQ", "lsW"] if with_vol else [])
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
        pH = M2.fhs_predict(zH[vH & tr], P.thresholds(sH[te]))
        pf = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], P.thresholds(ser.sigma[te]))
        fb = ~np.all(np.isfinite(pH), axis=1)
        pH[fb] = pf[fb]
        pa = np.tile(P.freq_upto(lim), (len(te), 1))
        keep = np.all(np.isfinite(pH), axis=1) & np.all(np.isfinite(pf), axis=1) & np.all(np.isfinite(pa), axis=1)
        te, pH, pf, pa = te[keep], pH[keep], pf[keep], pa[keep]
        if len(te) == 0:
            continue
        ts = ts_all[te]
        out["ts"].append(ts)
        out["y"].append(P.Y[te].astype(np.int8))
        for k_, arr in (("pH", pH), ("pf", pf), ("pa", pa)):
            out[k_].append(np.minimum.accumulate(arr, axis=1).astype(np.float32))
        out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
        out["tail"].append(ts + T * STEP > caps["primary"])
        if with_vol:
            lsH = np.log(sH[te])
            sQ = DC.sig_of(Q["X"], Q["okX"], DC.coef_of(Q, lim))
            sW = DC.sig_of(Wd["X"], Wd["okX"], DC.coef_of(Wd, lim))
            lsQ, lsW = np.log(sQ[te]), np.log(sW[te])
            out["lfut"].append(Q["lfut"][te].astype(np.float32))
            out["lsH"].append(lsH.astype(np.float32))
            out["lsQ"].append(np.where(np.isfinite(lsQ), lsQ, lsH).astype(np.float32))
            out["lsW"].append(np.where(np.isfinite(lsW), lsW, lsH).astype(np.float32))
    rows = {k: np.concatenate(v) for k, v in out.items()} if out["ts"] else None
    return {"key": spec["key"], "rows": rows}


def run_rows(specs, T, grid, workers, log, label, vol=False):
    t0 = time.time()
    res = []
    with mp.get_context("fork").Pool(workers, maxtasksperchild=8) as pool:
        for j, r in enumerate(pool.imap(row_task, [{"spec": s, "T": T, "grid": grid, "vol": vol} for s in specs],
                                        chunksize=1)):
            res.append(r)
            if (j + 1) % 100 == 0 or j + 1 == len(specs):
                log(f"  {label} {TL[T]}: {j + 1}/{len(specs)} ({time.time() - t0:.0f}s)")
    S = R12.stack_rows(res)
    keys = [r["key"] for r in res if r["rows"] is not None and len(r["rows"]["ts"])]
    return S, keys


# =============================================================================================
# the R13.1 map
# =============================================================================================
def lg(p):
    p = np.clip(np.asarray(p, float), PCLIP, 1 - PCLIP)
    return np.log(p / (1 - p))


def fit_slope(pH, y, cols):
    """unpenalised IRLS: logit P(y) = alpha_level + b * logit p over the band's columns -> (b, alphas, c_k)."""
    L = lg(pH[:, cols]).ravel(order="F")
    yy = y[:, cols].astype(float).ravel(order="F")
    n, k = pH.shape[0], len(cols)
    lev = np.repeat(np.arange(k), n)
    th = np.zeros(k + 1)
    th[k] = 1.0
    for _ in range(60):
        eta = th[lev] + th[k] * L
        p = expit(eta)
        w = np.maximum(p * (1 - p), 1e-12)
        r = yy - p
        g = np.zeros(k + 1)
        H = np.zeros((k + 1, k + 1))
        g[:k] = np.bincount(lev, r, k)
        g[k] = np.sum(r * L)
        H[np.arange(k), np.arange(k)] = np.bincount(lev, w, k)
        H[:k, k] = H[k, :k] = np.bincount(lev, w * L, k)
        H[k, k] = np.sum(w * L * L)
        step = np.linalg.solve(H + 1e-9 * np.eye(k + 1), g)
        th += step
        if np.max(np.abs(step)) < 1e-9:
            break
    c = lg(pH[:, cols]).mean(axis=0)
    return {"b": float(th[k]), "alpha": th[:k].tolist(), "c": c.tolist(), "n_rows": int(n)}


def fit_maps(S, mask):
    """per band: slope b and rotation points c_k from rows S[mask] (6-hourly, outside 2026Q2 and tails)."""
    pH, y = S["pH"][mask].astype(float), S["y"][mask]
    return {b: fit_slope(pH, y, cols) for b, cols in BANDS.items()}


def slope_only(pH, maps):
    pb = np.array(pH, float)
    for b, cols in BANDS.items():
        c = np.array(maps[b]["c"])[None, :]
        pb[:, cols] = expit(c + maps[b]["b"] * (lg(pH[:, cols]) - c))
    return pb


def level_terms(ts, sid, pb, y, T, W, kappa):
    """a_s(t) per row and level: ln((sum y + kappa) / (sum p_b + kappa)) over the same series' resolved rows on the
    6-hourly grid with t' + T <= t and t' >= t - W days."""
    a = np.zeros_like(pb)
    o = np.lexsort((ts, sid))
    ts_o, sid_o = ts[o], sid[o]
    brk = np.flatnonzero(np.diff(sid_o)) + 1
    st = np.concatenate([[0], brk])
    en = np.concatenate([brk, [len(o)]])
    for s0, e0 in zip(st, en):
        idx = o[s0:e0]
        t = ts_o[s0:e0]
        g = t % LEVEL_GRID == 0
        if not g.any():
            continue
        tg = t[g]
        ig = idx[g]
        csy = np.vstack([np.zeros((1, pb.shape[1])), np.cumsum(y[ig].astype(float), axis=0)])
        csp = np.vstack([np.zeros((1, pb.shape[1])), np.cumsum(pb[ig], axis=0)])
        hi = np.searchsorted(tg + T * STEP, t, side="right")
        lo = np.searchsorted(tg, t - W * DAY, side="left")
        lo = np.minimum(lo, hi)
        sy = csy[hi] - csy[lo]
        sp = csp[hi] - csp[lo]
        a[idx] = np.log((sy + kappa) / (sp + kappa))
    return a


def recal(pH, ts, sid, y, T, maps, W, kappa):
    pb = slope_only(pH, maps)
    a = level_terms(ts, sid, pb, y, T, W, kappa)
    p2 = expit(lg(pb) + a)
    p2 = np.minimum.accumulate(p2, axis=1)
    return np.clip(p2, PCLIP, 1 - PCLIP), np.clip(np.minimum.accumulate(pb, axis=1), PCLIP, 1 - PCLIP)


# =============================================================================================
# scores
# =============================================================================================
def corp(p, y):
    """CORP decomposition of the mean Brier score (PAV over distinct forecast values)."""
    from scipy.optimize import isotonic_regression
    o = np.argsort(p, kind="mergesort")
    ps, ys = p[o], y[o].astype(float)
    cut = np.flatnonzero(np.diff(ps)) + 1
    st = np.concatenate([[0], cut])
    cnt = np.diff(np.concatenate([st, [len(ps)]]))
    sy = np.add.reduceat(ys, st)
    iso = isotonic_regression(sy / cnt, weights=cnt.astype(float)).x
    fit = np.repeat(iso, cnt)
    S = float(np.mean((ps - ys) ** 2))
    Src = float(np.mean((fit - ys) ** 2))
    yb = float(ys.mean())
    Smg = float(np.mean((yb - ys) ** 2))
    return {"brier": S, "MCB": S - Src, "DSC": Smg - Src, "UNC": Smg}


def quint_masks(p):
    o = np.argsort(p, kind="mergesort")
    n = len(p)
    top = np.zeros(n, bool)
    bot = np.zeros(n, bool)
    top[o[int(0.8 * n):]] = True
    bot[o[:int(0.2 * n)]] = True
    return top, bot


def blocks_of(S, rows, T, k, family):
    y = S["y"][rows, KIX[k]].astype(float)
    if family == "shallow":
        w = R12.wk(S["ts"][rows])
        u, g = np.unique(w, return_inverse=True)
        posb = np.bincount(g, y, len(u)) > 0
        return g, len(u), posb
    return R12.crash_blocks(S["ts"][rows], S["sid"][rows], y, T)


def cell_eval(S, rows, T, k, family, P, ref="fH", seed=0, nb=NB):
    """calibration-led statistics of every forecast in P vs the reference, with block-bootstrap draws."""
    col = KIX[k]
    y = S["y"][rows, col].astype(float)
    g, G, posb = blocks_of(S, rows, T, k, family)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, seed]))
    idx = rng.integers(0, G, size=(nb, G))
    Sy = np.bincount(g, y, G)
    out = {"rows": int(len(y)), "pos": int(y.sum()), "blocks": int(G), "pos_blocks": int(posb.sum()), "f": {}}
    pre = {}
    for name, pp in P.items():
        p = pp[rows, col].astype(float)
        top, bot = quint_masks(p)
        Sp = np.bincount(g, p, G)
        Spt, Syt = np.bincount(g, p * top, G), np.bincount(g, y * top, G)
        Se = np.bincount(g, (p - y) ** 2, G)
        R = Sp.sum() / Sy.sum() if Sy.sum() else np.nan
        Rt = Spt.sum() / Syt.sum() if Syt.sum() else np.nan
        Rb = (p * bot).sum() / (y * bot).sum() if (y * bot).sum() else np.nan
        c = corp(p, y)
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
        pd_ = (1 + int(np.sum(ds - d <= d))) / (len(ds) + 1)
        pt_ = (1 + int(np.sum(dts - dt <= dt))) / (len(dts) + 1)
        bss = 1 - q["Se"].sum() / r["Se"].sum()
        bs = 1 - q["Se"][idx].sum(1) / r["Se"][idx].sum(1)
        out["f"][name].update({
            "d_abslnR": float(d), "d_abslnR_se": float(np.std(ds)), "p_d": float(pd_),
            "d_top": float(dt), "d_top_se": float(np.std(dts)), "p_top": float(pt_),
            "bss_vs_ref": float(bss), "bss_ci90": [float(np.quantile(bs, 0.05)), float(np.quantile(bs, 0.95))],
            "bss_se": float(np.std(bs)),
            "cell_p": float(max(pd_, pt_))})
    return out


def power_leg(m, se, G_have, G_new, z):
    """one-sided power of a mean-difference leg with effect m (< 0 good), SE at G_have blocks, projected to G_new."""
    if not (np.isfinite(m) and np.isfinite(se)) or se <= 0 or m >= 0:
        return 0.0, None
    se_new = se * math.sqrt(G_have / max(G_new, 1))
    gstar = G_have * ((z + norm.ppf(0.8)) * se / abs(m)) ** 2
    return float(norm.cdf(abs(m) / se_new - z)), float(gstar)


def cell_power(c, name, G_new, m_family):
    f = c["f"][name]
    G = max(c["pos_blocks"], 1)
    za = norm.ppf(1 - ALPHA / m_family)
    p1, g1 = power_leg(f["d_abslnR"], f["d_abslnR_se"], G, G_new, za)
    p2, g2 = power_leg(f["d_top"], f["d_top_se"], G, G_new, za)
    p3, g3 = power_leg(-(f["bss_vs_ref"] - NI_MARGIN), f["bss_se"], G, G_new, norm.ppf(0.95))
    return {"power_absl": p1, "power_top": p2, "power_ni": p3, "power_min": min(p1, p2, p3),
            "gstar_absl": g1, "gstar_top": g2, "gstar_ni": g3,
            "gstar_max": max([x for x in (g1, g2, g3)], default=None) if None not in (g1, g2, g3) else None}


def vol_power(S, rows, T, which):
    """R13.2/R13.3 primary: weekly-cluster mean of (e_new^2 - e_fH^2) for ln sigma_fut and weeks to 80% power."""
    e0 = (S["lfut"][rows] - S["lsH"][rows]).astype(float) ** 2
    e1 = (S["lfut"][rows] - S[which][rows]).astype(float) ** 2
    ok = np.isfinite(e0) & np.isfinite(e1)
    d = (e1 - e0)[ok]
    w = R12.wk(S["ts"][rows][ok])
    u, g = np.unique(w, return_inverse=True)
    t = R12.cr1_test(g, d)
    G = len(u)
    out = {"rows": int(ok.sum()), "weeks": int(G), "mse_fH": float(e0[ok].mean()), "mse_new": float(e1[ok].mean()),
           "mean_diff": t["mean_diff"], "se": t["se"], "p_one_sided": t["p_one_sided"],
           "median_sq_fH": float(np.median(e0[ok])), "median_sq_new": float(np.median(e1[ok]))}
    za = norm.ppf(1 - ALPHA / 4) + norm.ppf(0.8)
    if t["se"] and t["mean_diff"] < 0:
        out["weeks_to_80"] = float(G * (za * t["se"] / abs(t["mean_diff"])) ** 2)
    else:
        out["weeks_to_80"] = None
    return out


# =============================================================================================
# development (seen data only)
# =============================================================================================
def cmd_dev(a):
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "dev-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r13.1 dev (seen data only); code {R112.git_sha()}")
    lim = (lambda sp: sp[:a.limit]) if a.limit else (lambda sp: sp)
    sets = {"dev": (R12.dev_specs(a.datasets), "6h", False),
            "b9": (b9_specs(a.datasets, os.path.join(a.out, "acq_r12")), "6h", False),
            "b12": (b12_specs(a.datasets), "1h", True),
            "b13a": (b13a_specs(a.datasets), "1h", True)}
    out = {"schema": "q26-r13.1-dev/1", "label": "DEVELOPMENT ONLY (seen data)", "code_sha": R112.git_sha(),
           "menu": MENU, "maps": {}, "maps_loo": {}, "cells": {}, "power": {}, "vol": {}, "J": {}}
    hs = [int(x) for x in a.horizons.split(",")] if a.horizons else list(HS)
    for T in hs:
        St, off = {}, 0
        for name, (specs, grid, vol) in sets.items():
            S, keys = run_rows(lim(specs), T, grid, a.workers, log, name, vol=vol)
            S["sid"] = S["sid"] + off
            off = int(S["sid"].max()) + 1
            St[name] = S
        fitmask = {nm: (~S_["q2"] & ~S_["tail"] & (S_["ts"] % LEVEL_GRID == 0)) for nm, S_ in St.items()}

        def pool_maps(exclude):
            cat = {k: np.concatenate([St[nm][k][fitmask[nm]] for nm in St if nm != exclude]) for k in ("pH", "y")}
            return fit_maps(cat, np.ones(len(cat["y"]), bool))
        maps_all = pool_maps(None)
        out["maps"][TL[T]] = maps_all
        loo = {"b12": pool_maps("b12"), "b13a": pool_maps("b13a")}
        out["maps_loo"][TL[T]] = loo
        log(f"  maps {TL[T]}: all b shallow {maps_all['shallow']['b']:.3f} deep {maps_all['deep']['b']:.3f}; "
            f"loo-b12 {loo['b12']['shallow']['b']:.3f}/{loo['b12']['deep']['b']:.3f}; "
            f"loo-b13a {loo['b13a']['shallow']['b']:.3f}/{loo['b13a']['deep']['b']:.3f}")
        # check set = B12 (maps without B12) U B13a (maps without B13a), hourly rows
        C = {k: np.concatenate([St["b12"][k], St["b13a"][k]]) for k in St["b12"]}
        nb12 = len(St["b12"]["ts"])
        P = {"fH": C["pH"], "f": C["pf"], "a": C["pa"]}
        pb_parts = []
        for nm, sl in (("b12", slice(0, nb12)), ("b13a", slice(nb12, None))):
            pb_parts.append(slope_only(C["pH"][sl].astype(float), loo[nm]))
        pb = np.clip(np.minimum.accumulate(np.vstack(pb_parts), axis=1), PCLIP, 1 - PCLIP)
        P["slope"] = pb.astype(np.float32)
        for W, kap in MENU:
            parts = []
            for nm, sl in (("b12", slice(0, nb12)), ("b13a", slice(nb12, None))):
                parts.append(recal(C["pH"][sl].astype(float), C["ts"][sl], C["sid"][sl], C["y"][sl], T, loo[nm],
                                   W, kap)[0].astype(np.float32))
            P[f"M2_W{W}_k{int(kap)}"] = np.vstack(parts)
        score = ~C["q2"] & ~C["tail"]
        setid = np.r_[np.zeros(nb12, np.int8), np.ones(len(C["ts"]) - nb12, np.int8)]
        for fam, cells in (("shallow", CELLS_SHALLOW), ("deep", CELLS_DEEP)):
            for TT, k in cells:
                if TT != T:
                    continue
                key = f"{TL[T]} {k}"
                res = {}
                for tag, rmask in (("pooled", score), ("b12", score & (setid == 0)), ("b13a", score & (setid == 1))):
                    rows = np.flatnonzero(rmask)
                    res[tag] = cell_eval(C, rows, T, k, fam, P, seed=1000 * T + int(-100 * k) + 7 * len(tag))
                out["cells"][key] = {"family": fam, **res}
                f0 = res["pooled"]["f"]
                log(f"  {key} pooled: R fH {f0['fH']['R']:.3f} slope {f0['slope']['R']:.3f} "
                    + " ".join(f"{m}:{f0[m]['R']:.3f}/{f0[m]['R_top20']:.3f}/{f0[m]['bss_vs_ref']:+.4f}"
                               for m in P if m.startswith("M2"))
                    + f"; top fH {f0['fH']['R_top20']:.3f}; pos blocks {res['pooled']['pos_blocks']}")
        # R13.2 / R13.3 vol errors (check set, hourly, scored rows)
        rows = np.flatnonzero(score)
        out["vol"][TL[T]] = {w: vol_power(C, rows, T, w) for w in ("lsQ", "lsW")}
        for tag, sl in (("b12", setid == 0), ("b13a", setid == 1)):
            rr = np.flatnonzero(score & sl)
            out["vol"][TL[T]][tag] = {w: vol_power(C, rr, T, w) for w in ("lsQ", "lsW")}
        log(f"  vol {TL[T]}: fHQ d {out['vol'][TL[T]]['lsQ']['mean_diff']:+.5f} (weeks80 "
            f"{out['vol'][TL[T]]['lsQ']['weeks_to_80']}), fHW d {out['vol'][TL[T]]['lsW']['mean_diff']:+.5f} "
            f"(weeks80 {out['vol'][TL[T]]['lsW']['weeks_to_80']})")
        # per-week sums for the menu criterion J (written to an npz, combined after the loop)
        wkid = R12.wk(C["ts"])
        Jp = {}
        for fam, cells in (("shallow", CELLS_SHALLOW), ("deep", CELLS_DEEP)):
            for TT, k in cells:
                if TT != T:
                    continue
                col = KIX[k]
                for sidx in (0, 1):
                    m = score & (setid == sidx)
                    yy = C["y"][m, col].astype(float)
                    w = wkid[m]
                    for nm in P:
                        if not (nm.startswith("M2") or nm == "fH"):
                            continue
                        p = P[nm][m, col]
                        top, _ = quint_masks(p)
                        Jp[f"{TL[T]}|{k}|{sidx}|{nm}"] = np.stack([w, p, yy, p * top, yy * top])
        np.savez_compressed(os.path.join(a.out, f"jsums-{TL[T]}.npz"),
                            **{kk: np.vstack([np.bincount(np.searchsorted(np.unique(v[0]), v[0]), v[j])
                                              for j in range(1, 5)]) for kk, v in Jp.items()},
                            **{f"weeks|{kk}": np.unique(v[0]) for kk, v in Jp.items()})
        del St, C, P
        json.dump(out, open(os.path.join(a.out, "dev-r131-partial.json"), "w"), indent=1, default=float)
    out["finished_utc"] = now_iso()
    json.dump(out, open(os.path.join(a.out, "dev-r131.json"), "w"), indent=1, default=float)
    log("END dev")


def cmd_select(a):
    """menu choice from the per-week sums (weekly bootstrap, the same weeks for every cell and set)."""
    sums, weeks = {}, {}
    for T in HS:
        z = np.load(os.path.join(a.out, f"jsums-{TL[T]}.npz"))
        for kk in z.files:
            if kk.startswith("weeks|"):
                weeks[kk[6:]] = z[kk]
            else:
                sums[kk] = z[kk]
    allw = np.unique(np.concatenate(list(weeks.values())))
    Gw = len(allw)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, 99]))
    C = np.stack([np.bincount(rng.integers(0, Gw, Gw), minlength=Gw) for _ in range(NB)]).astype(float)
    names = sorted({kk.split("|")[3] for kk in sums})
    cellkeys = sorted({"|".join(kk.split("|")[:3]) for kk in sums})
    J, Js = {}, {}
    for nm in names:
        tot, tots = 0.0, np.zeros(NB)
        for ck in cellkeys:
            s = sums[f"{ck}|{nm}"]
            pos = np.searchsorted(allw, weeks[f"{ck}|{nm}"])
            full = np.zeros((4, Gw))
            full[:, pos] = s
            R = full[0].sum() / full[1].sum()
            Rt = full[2].sum() / full[3].sum()
            tot += abs(math.log(R)) + abs(math.log(Rt))
            bs = C @ full.T
            with np.errstate(divide="ignore", invalid="ignore"):
                tots += np.abs(np.log(bs[:, 0] / bs[:, 1])) + np.abs(np.log(bs[:, 2] / bs[:, 3]))
        J[nm], Js[nm] = tot / len(cellkeys), tots / len(cellkeys)
    order = [f"M2_W{W}_k{int(k)}" for W, k in sorted(MENU, key=lambda x: (-x[1], -x[0]))]
    jmin = min(order, key=lambda n: J[n])
    se = float(np.nanstd(Js[jmin]))
    chosen = next(n for n in order if J[n] <= J[jmin] + se)
    res = {"J": J, "J_se_of_min": se, "argmin": jmin, "simplicity_order": order, "chosen": chosen,
           "weeks": int(Gw), "cells_x_sets": len(cellkeys)}
    json.dump(res, open(os.path.join(a.out, "select-r131.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select-b15", "dev", "select"])
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--horizons", default="")
    ap.add_argument("--limit", type=int, default=0, help="smoke test only: first N specs per set")
    a = ap.parse_args()
    {"select-b15": cmd_select_b15, "dev": cmd_dev, "select": cmd_select}[a.cmd](a)


if __name__ == "__main__":
    main()
