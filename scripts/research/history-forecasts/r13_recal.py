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
    keys = ["ts", "y", "pH", "pf", "pa", "q2", "tail", "fold"] + (["lfut", "lsH", "lsQ", "lsW"] if with_vol else [])
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
        out["fold"].append(np.full(len(ts), int(f["qs_ts"]), np.int64))
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
    Lm = lg(pH[:, cols])
    c = Lm.mean(axis=0)
    # D-R13.1a variant: mean-preserving rotation point, mean(expit(c + b (L - c))) = mean(p) on the fit rows
    b = float(th[k])
    cmp_ = []
    for j in range(k):
        target = float(np.clip(pH[:, cols[j]], PCLIP, 1 - PCLIP).mean())
        lo_, hi_ = -30.0, 30.0
        for _ in range(80):
            mid = 0.5 * (lo_ + hi_)
            v = float(expit(mid + b * (Lm[:, j] - mid)).mean())
            if (v < target) == (b < 1):
                lo_ = mid
            else:
                hi_ = mid
        cmp_.append(0.5 * (lo_ + hi_))
    return {"b": b, "alpha": th[:k].tolist(), "c": c.tolist(), "c_mp": cmp_, "n_rows": int(n)}


def fit_maps(S, mask):
    """per band: slope b and rotation points c_k from rows S[mask] (6-hourly, outside 2026Q2 and tails)."""
    pH, y = S["pH"][mask].astype(float), S["y"][mask]
    return {b: fit_slope(pH, y, cols) for b, cols in BANDS.items()}


def slope_only(pH, maps, cvar="c"):
    pb = np.array(pH, float)
    for b, cols in BANDS.items():
        c = np.array(maps[b][cvar])[None, :]
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


def recal(pH, ts, sid, y, T, maps, W, kappa, cvar="c"):
    pb = slope_only(pH, maps, cvar)
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
    part = os.path.join(a.out, "dev-r131-partial.json")
    if os.path.exists(part):                    # resume: keep horizons already finished (same code path)
        prev = json.load(open(part))
        for kk in ("maps", "maps_loo", "cells", "vol"):
            out[kk].update(prev.get(kk, {}))
        out["resumed_from"] = {"code_sha": prev.get("code_sha"), "horizons": sorted(prev.get("maps", {}))}
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
        n_b12 = len(St["b12"]["ts"])
        log(f"  maps {TL[T]}: all b shallow {maps_all['shallow']['b']:.3f} deep {maps_all['deep']['b']:.3f}; "
            f"loo-b12 {loo['b12']['shallow']['b']:.3f}/{loo['b12']['deep']['b']:.3f}; "
            f"loo-b13a {loo['b13a']['shallow']['b']:.3f}/{loo['b13a']['deep']['b']:.3f}")
        # check set = B12 (maps without B12) U B13a (maps without B13a), hourly rows
        C = {k: np.concatenate([St["b12"][k], St["b13a"][k]]) for k in St["b12"]}
        del St
        nb12 = n_b12
        score = ~C["q2"] & ~C["tail"]
        setid = np.r_[np.zeros(nb12, np.int8), np.ones(len(C["ts"]) - nb12, np.int8)]
        Pall = {}
        for vi, (cvar, pre) in enumerate((("c", ""), ("c_mp", "mp_"))):
            P = {"fH": C["pH"], "f": C["pf"], "a": C["pa"]} if vi == 0 else {"fH": C["pH"]}
            pb_parts = [slope_only(C["pH"][sl].astype(float), loo[nm], cvar)
                        for nm, sl in (("b12", slice(0, nb12)), ("b13a", slice(nb12, None)))]
            P[pre + "slope"] = np.clip(np.minimum.accumulate(np.vstack(pb_parts), axis=1), PCLIP,
                                       1 - PCLIP).astype(np.float32)
            del pb_parts
            for W, kap in MENU:
                parts = [recal(C["pH"][sl].astype(float), C["ts"][sl], C["sid"][sl], C["y"][sl], T, loo[nm], W, kap,
                               cvar)[0].astype(np.float32)
                         for nm, sl in (("b12", slice(0, nb12)), ("b13a", slice(nb12, None)))]
                P[f"{pre}M2_W{W}_k{int(kap)}"] = np.vstack(parts)
                del parts
            for fam, cells in (("shallow", CELLS_SHALLOW), ("deep", CELLS_DEEP)):
                for TT, k in cells:
                    if TT != T:
                        continue
                    key = f"{TL[T]} {k}"
                    for tag, rmask in (("pooled", score), ("b12", score & (setid == 0)),
                                       ("b13a", score & (setid == 1))):
                        rows = np.flatnonzero(rmask)
                        res = cell_eval(C, rows, T, k, fam, P, seed=1000 * T + int(-100 * k) + 7 * len(tag))
                        cur = out["cells"].setdefault(key, {"family": fam})
                        if tag not in cur or vi == 0:
                            cur[tag] = res
                        else:
                            cur[tag]["f"].update({kk: vv for kk, vv in res["f"].items() if kk != "fH"})
                    f0 = out["cells"][key]["pooled"]["f"]
                    log(f"  {key} pooled [{cvar}]: R fH {f0['fH']['R']:.3f} slope {f0[pre + 'slope']['R']:.3f} "
                        + " ".join(f"{m}:{f0[m]['R']:.3f}/{f0[m]['R_top20']:.3f}/{f0[m]['bss_vs_ref']:+.4f}"
                                   for m in P if "M2" in m)
                        + f"; top fH {f0['fH']['R_top20']:.3f}; pos blocks "
                          f"{out['cells'][key]['pooled']['pos_blocks']}")
            wkid = R12.wk(C["ts"])
            for fam, cells in (("shallow", CELLS_SHALLOW), ("deep", CELLS_DEEP)):
                for TT, k in cells:
                    if TT != T:
                        continue
                    col = KIX[k]
                    for sidx in (0, 1):
                        m = np.flatnonzero(score & (setid == sidx))
                        yy = C["y"][m, col].astype(float)
                        uw, gi = np.unique(wkid[m], return_inverse=True)
                        for nm in P:
                            if not ("M2" in nm or (nm == "fH" and vi == 0)):
                                continue
                            p = P[nm][m, col].astype(float)
                            top, _ = quint_masks(p)
                            kk = f"{TL[T]}|{k}|{sidx}|{nm}"
                            Pall[kk] = np.vstack([np.bincount(gi, v, len(uw)) for v in (p, yy, p * top, yy * top)])
                            Pall[f"weeks|{kk}"] = uw
            del P
        np.savez_compressed(os.path.join(a.out, f"jsums-{TL[T]}.npz"), **Pall)
        # R13.2 / R13.3 vol errors (check set, hourly, scored rows)
        rows = np.flatnonzero(score)
        out["vol"][TL[T]] = {w: vol_power(C, rows, T, w) for w in ("lsQ", "lsW")}
        for tag, sl in (("b12", setid == 0), ("b13a", setid == 1)):
            rr = np.flatnonzero(score & sl)
            out["vol"][TL[T]][tag] = {w: vol_power(C, rr, T, w) for w in ("lsQ", "lsW")}
        log(f"  vol {TL[T]}: fHQ d {out['vol'][TL[T]]['lsQ']['mean_diff']:+.5f} (weeks80 "
            f"{out['vol'][TL[T]]['lsQ']['weeks_to_80']}), fHW d {out['vol'][TL[T]]['lsW']['mean_diff']:+.5f} "
            f"(weeks80 {out['vol'][TL[T]]['lsW']['weeks_to_80']})")
        del C
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
    order = [f"{pre}M2_W{W}_k{int(k)}" for pre in ("", "mp_") for W, k in sorted(MENU, key=lambda x: (-x[1], -x[0]))]
    order = [o for o in order if o in J]
    jmin = min(order, key=lambda n: J[n])
    se = float(np.nanstd(Js[jmin]))
    chosen = next(n for n in order if J[n] <= J[jmin] + se)
    res = {"J": J, "J_se_of_min": se, "argmin": jmin, "simplicity_order": order, "chosen": chosen,
           "weeks": int(Gw), "cells_x_sets": len(cellkeys)}
    json.dump(res, open(os.path.join(a.out, "select-r131.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


# =============================================================================================
# B15a acquisition (outcome-blind), counts only
# =============================================================================================
def mexc_fetch(sym, first_month):
    """60m klines from the first month to ACQ_END (exclusive), 500 hours per page; sha256 per raw page."""
    rows, pages = {}, []
    t = int(datetime.strptime(first_month + "-01", "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    span = 500 * STEP
    while t < ACQ_END:
        e = min(t + span, ACQ_END)
        url = MEXC_K.format(s=urllib.parse.quote(sym), i="60m", a=t * 1000, b=e * 1000 - 1, n=500)
        for k in range(8):
            raw = R125.http_get(url)
            try:
                d = json.loads(raw)
            except ValueError:
                d = None
            if isinstance(d, list):
                break
            time.sleep(2.0 * (k + 1))
        else:
            raise SystemExit(f"STOP: MEXC {sym}: no list after retries")
        pages.append({"start": t, "end": e, "sha256": sha256b(raw), "candles": len(d)})
        for c in d:                         # [open_ms, o, h, l, c, vol, close_ms, quote_vol]
            ot = int(c[0]) // 1000
            if t <= ot < e and ot % STEP == 0:
                rows[ot] = (c[1], c[2], c[3], c[4], c[5])
        t = e
        time.sleep(0.06)
    return rows, pages


def cmd_acquire_b15a(a):
    sel = json.load(open(os.path.join(a.datasets, "b15-mexc-prices/selection-b15.json")))
    vd = os.path.join(a.acq, "b15a")
    os.makedirs(vd, exist_ok=True)
    mp_ = os.path.join(vd, "manifest-acquire-b15a.json")
    man = json.load(open(mp_)) if os.path.exists(mp_) else {
        "schema": "q26-r13/acquire-b15a/1", "started_utc": now_iso(), "code_sha": R112.git_sha(),
        "selection_sha256": sha_file(os.path.join(a.datasets, "b15-mexc-prices/selection-b15.json")),
        "source": "MEXC public REST api/v3/klines 60m (free, keyless; no published checksum; sha256 of every raw "
                  "page recorded); a missing hour is null; no fill, no filter",
        "series": {}, "dropped": {}}

    def one(base):
        if base in man["series"] or base in man["dropped"]:
            return None
        rows, pages = mexc_fetch(sel["symbol"][base], sel["first_month"][base])
        if not rows:
            return base, None, {"reason": "no data before the acquisition end"}
        st = min(rows)
        if st >= R125.FIRST_MAX:
            return base, None, {"reason": "first hour on or after 2025-07-01 (no A6.6 fold)", "first_utc": A.iso(st)}
        gp = os.path.join(vd, f"mexc-{base}USDT-1h.json.gz")
        nh, nn = R12.write_grid(gp, f"{base}USDT", "mexc 1h", st, rows)
        last = max(rows)
        return base, {"file": os.path.basename(gp), "sha256": R112.sha256_file(gp), "grid_start_utc": A.iso(st),
                      "last_hour_utc": A.iso(last), "ended": bool(last + STEP < ACQ_END - R125.LIVE_GAP),
                      "hours": nh, "null_hours": nn, "pages": pages}, None

    done = 0
    with cf.ThreadPoolExecutor(4) as ex:
        for r in ex.map(one, sel["B15a"]):
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
                print(f"{now_iso()} acquired {done}/{len(sel['B15a'])}", flush=True)
    man["finished_utc"] = now_iso()
    man["status"] = "LOCKED for Q26 R13.1 (design/Q26_ROUND13_PREREG.md D-R13.1a)"
    h = R112.write_json(mp_, man)
    print(json.dumps({"series": len(man["series"]), "dropped": len(man["dropped"]),
                      "hours": sum(v["hours"] for v in man["series"].values()),
                      "null_hours": sum(v["null_hours"] for v in man["series"].values()),
                      "ended": sum(v["ended"] for v in man["series"].values()), "manifest_sha256": h}), flush=True)


def b15a_specs(acq):
    man = json.load(open(os.path.join(acq, "b15a", "manifest-acquire-b15a.json")))
    specs = []
    for b, v in sorted(man["series"].items()):
        path = os.path.join(acq, "b15a", v["file"])
        st, cols = R12.load_json_grid(path)
        n = len(cols["close"])
        last = st + STEP * (n - 1)
        cap_full = min(ACQ_END, last + STEP)
        cap_pri = min(cap_full, last + STEP - R12.TAIL_DAYS * DAY) if v["ended"] else cap_full
        sp = R12.redenom_splits(cols["close"])
        bounds = [0] + sp + [n]
        for j in range(len(bounds) - 1):
            if bounds[j + 1] - bounds[j] <= 0:
                continue
            specs.append({"key": f"b15a:{b}" + ("" if j == 0 else f"#{j + 1}"), "asset": b, "kind": "grid",
                          "path": path, "slice": (bounds[j], bounds[j + 1]), "cap_full": cap_full,
                          "cap_primary": cap_pri})
    return specs


def cmd_counts(a):
    """counts only: validated origins, positive origins, positive crash-episode blocks (R12 definitions) and positive
    calendar weeks per cell. No forecast, no score, no price statistic."""
    from numpy.lib.stride_tricks import sliding_window_view
    specs = b15a_specs(a.acq)
    c = R12.count_set(specs, True)
    pw = {T: [set() for _ in LEVELS] for T in HS}
    allw = {T: set() for T in HS}
    for spc in specs:
        st, cols = R12.load_json_grid(spc["path"])
        i0, i1 = spc["slice"]
        lo, cl = cols["low"][i0:i1], cols["close"][i0:i1]
        t0 = st + STEP * i0
        n = len(cl)
        for T in HS:
            if n - T < 1:
                continue
            idx = np.arange(1, n - T + 1)
            tt = t0 + idx * STEP
            ok = (tt >= t0 + R12.WARMUP_DAYS * DAY) & (tt + T * STEP <= spc["cap_primary"]) & ~np.isnan(cl[idx - 1])
            ok &= ~((tt < R12.Q2_END) & (tt + T * STEP > R12.Q2_START))
            cs = np.concatenate([[0], np.cumsum(np.isnan(lo).astype(np.int32))])
            ok &= (cs[idx + T] - cs[idx]) <= math.floor(0.05 * T)
            lo_f = np.where(np.isnan(lo), np.inf, lo)
            wmin = lo_f[idx] if T == 1 else sliding_window_view(lo_f, T).min(axis=1)[idx]
            ok &= np.isfinite(wmin)
            sel = np.where(ok)[0]
            S = cl[idx - 1][sel]
            w = R12.wk(tt[sel])
            allw[T].update(w.tolist())
            for j, k in enumerate(LEVELS):
                pw[T][j].update(w[wmin[sel] <= S * (1 + k)].tolist())
    out = {"schema": "q26-r13/counts-b15a/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "note": "counts only", "specs": len(specs), "series_with_origins": c["series"], "cells": {}}
    for T, k in CELLS:
        lv = next(x for x in c["T"][str(T)]["levels"] if x["level"] == k)
        out["cells"][f"{TL[T]} {k}"] = {"validated_origins": c["T"][str(T)]["validated_origins"],
                                       "positive_origins": lv["positive_origins"], "blocks": lv["blocks"],
                                       "positive_blocks": lv["positive_blocks"],
                                       "series_episodes": lv["series_episodes"], "weeks": len(allw[T]),
                                       "positive_weeks": len(pw[T][KIX[k]])}
    h = R112.write_json(os.path.join(a.out, "counts-b15a.json"), out)
    for key, v in out["cells"].items():
        print(key, {kk: v[kk] for kk in ("validated_origins", "positive_blocks", "blocks", "positive_weeks", "weeks")})
    print("series with origins", c["series"], "counts sha256", h)


def cmd_power(a):
    """projected power of the chosen M2 at the B15a counts (development effect = pooled B12 U B13a check set)."""
    dev = json.load(open(os.path.join(a.dev, "dev-r131.json")))
    sel = json.load(open(os.path.join(a.dev, "select-r131.json")))
    cnt = json.load(open(os.path.join(a.out, "counts-b15a.json")))
    name = sel["chosen"]
    out = {"chosen": name, "cells": {}}
    for fam, cells in (("shallow", CELLS_SHALLOW), ("deep", CELLS_DEEP)):
        m = len(cells)
        for T, k in cells:
            key = f"{TL[T]} {k}"
            cc = cnt["cells"][key]
            G_new = cc["positive_weeks"] if fam == "shallow" else cc["positive_blocks"]
            pw = cell_power(dev["cells"][key]["pooled"], name, G_new, m)
            out["cells"][key] = {"family": fam, "G_b15a": G_new, **pw}
            print(key, fam, "G", G_new, {kk: (round(v, 3) if isinstance(v, float) else v) for kk, v in pw.items()})
    out["n_cells_ge80"] = int(sum(v["power_min"] >= 0.8 for v in out["cells"].values()))
    h = R112.write_json(os.path.join(a.out, "power-b15a.json"), out)
    print("cells at >= 80%:", out["n_cells_ge80"], "sha256", h)


# =============================================================================================
# freeze and run
# =============================================================================================
def cmd_freeze(a):
    dev = json.load(open(os.path.join(a.dev, "dev-r131.json")))
    sel = json.load(open(os.path.join(a.dev, "select-r131.json")))
    W, kap = next((W, k) for W, k in MENU if sel["chosen"].endswith(f"M2_W{W}_k{int(k)}"))
    cvar = "c_mp" if sel["chosen"].startswith("mp_") else "c"
    e = {}
    for T in HS:
        ec = R125.e_consts(os.path.join(a.datasets, "history-forecasts/r12/dev-49e1af3a"), T)
        e[TL[T]] = [float(x) for x in ec]
    me = os.path.abspath(__file__)
    cfg = {"schema": "q26-r13.1/frozen/1", "created_utc": now_iso(), "code_sha": R112.git_sha(),
           "code_sha256": {os.path.basename(f): sha_file(f) for f in
                           (me, os.path.join(HERE, "r12_tail.py"), os.path.join(HERE, "a6_touch.py"),
                            os.path.join(HERE, "r13_devcheck.py"), os.path.join(HERE, "r125_fh_deep.py"))},
           "inputs": {"manifest_b15a_sha256": sha_file(os.path.join(a.acq, "b15a", "manifest-acquire-b15a.json")),
                      "counts_b15a_sha256": sha_file(os.path.join(a.out, "counts-b15a.json")),
                      "power_b15a_sha256": sha_file(os.path.join(a.out, "power-b15a.json")),
                      "dev_r131_sha256": sha_file(os.path.join(a.dev, "dev-r131.json")),
                      "select_r131_sha256": sha_file(os.path.join(a.dev, "select-r131.json"))},
           "maps": dev["maps"], "chosen": sel["chosen"], "W_days": W, "kappa": kap, "cvar": cvar, "e_consts": e,
           "cells_shallow": CELLS_SHALLOW, "cells_deep": CELLS_DEEP, "seed": SEED, "n_boot": 10000,
           "ni_margin_bss": NI_MARGIN, "dsc_tol": DSC_TOL, "alpha": ALPHA, "min_pos_blocks": 30,
           "level_grid_hours": 6, "pclip": PCLIP}
    h = R112.write_json(os.path.join(a.out, "frozen-r131-config.json"), cfg)
    print("frozen config sha256", h, "created_utc", cfg["created_utc"])


def lookahead(spec, T, cfg, cut_frac=0.6):
    """perturb prices after a cut; no p' issued at or before the cut may change."""
    import gzip
    import tempfile
    st, cols = R12.load_json_grid(spec["path"])
    i0, i1 = spec["slice"]
    n = i1 - i0
    cut = i0 + int(cut_frac * n)
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
        sp = dict(spec, path=path)
        r = row_task({"spec": sp, "T": T, "grid": "1h"})["rows"]
        sid = np.zeros(len(r["ts"]), np.int32)
        p2_, _ = recal(r["pH"].astype(float), r["ts"], sid, r["y"], T, cfg["maps"][TL[T]], cfg["W_days"],
                       cfg["kappa"], cfg["cvar"])
        m = r["ts"] <= cut_ts - T * STEP * 0     # origins at or before the cut
        res.append((r["ts"][m], p2_[m]))
    same = len(res[0][0]) == len(res[1][0]) and np.array_equal(res[0][0], res[1][0])
    diff = float(np.max(np.abs(res[0][1] - res[1][1]))) if same and len(res[0][0]) else None
    return {"series": spec["key"], "T": TL[T], "cut_utc": A.iso(cut_ts), "rows_checked": int(len(res[0][0])),
            "same_rows": bool(same), "max_abs_diff": diff}


def cmd_run(a):
    cfg_p = os.path.join(a.out, "frozen-r131-config.json")
    cfg = json.load(open(cfg_p))
    if cfg["code_sha"] != R112.git_sha():
        raise SystemExit("STOP: code sha differs from the frozen config")
    run_dir = os.path.join(a.out, f"r131-run-{cfg['code_sha'][:8]}")
    os.makedirs(run_dir, exist_ok=True)
    logf = open(os.path.join(run_dir, "run-log.txt"), "a")

    def log(s):
        line = f"{now_iso()} {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START R13.1 run on B15a; frozen config sha256 {sha_file(cfg_p)}; code {cfg['code_sha']}")
    specs = b15a_specs(a.acq)
    out = {"schema": "q26-r13.1/results/1", "frozen_config_sha256": sha_file(cfg_p), "code_sha": cfg["code_sha"],
           "started_utc": now_iso(), "cells": {}, "lookahead": []}
    name = cfg["chosen"]
    hs = sorted({T for T, _ in CELLS})
    for T in hs:
        S, keys = run_rows(specs, T, "1h", a.workers, log, "B15a")
        maps = cfg["maps"][TL[T]]
        p2, pb = recal(S["pH"].astype(float), S["ts"], S["sid"], S["y"], T, maps, cfg["W_days"], cfg["kappa"],
                       cfg["cvar"])
        ec = np.array(cfg["e_consts"][TL[T]], float)
        P = {"fH": S["pH"], "M2": p2.astype(np.float32), "slope": pb.astype(np.float32), "f": S["pf"],
             "a": S["pa"], "e": np.tile(ec.astype(np.float32), (len(S["ts"]), 1))}
        score = ~S["q2"] & ~S["tail"]
        rows = np.flatnonzero(score)
        for fam, cells in (("shallow", CELLS_SHALLOW), ("deep", CELLS_DEEP)):
            for TT, k in cells:
                if TT != T:
                    continue
                key = f"{TL[T]} {k}"
                c = cell_eval(S, rows, T, k, fam, P, seed=1000 * T + int(-100 * k), nb=cfg["n_boot"])
                col = KIX[k]
                y = S["y"][rows, col].astype(float)
                d = (P["M2"][rows, col].astype(float) - y) ** 2 - (P["fH"][rows, col].astype(float) - y) ** 2
                c["dk_hac_168_M2_vs_fH"] = R12.dk_hac(S["ts"][rows], d)
                yr = np.array([datetime.fromtimestamp(int(t), timezone.utc).year for t in S["ts"][rows]])
                mo = np.array([datetime.fromtimestamp(int(t), timezone.utc).strftime("%Y-%m") for t in S["ts"][rows]])
                rep = {}
                for lab, grp in (("year", yr), ("month", mo), ("fold", S["fold"][rows])):
                    rep[lab] = {}
                    for gv in np.unique(grp):
                        mm = grp == gv
                        sy = y[mm].sum()
                        rep[lab][str(gv)] = {"rows": int(mm.sum()), "pos": int(sy),
                                             "R_fH": float(P["fH"][rows[mm], col].sum() / sy) if sy else None,
                                             "R_M2": float(P["M2"][rows[mm], col].sum() / sy) if sy else None}
                c["reported"] = rep
                c["family"] = fam
                out["cells"][key] = c
                f = c["f"]
                log(f"  {key}: R fH {f['fH']['R']:.3f} M2 {f['M2']['R']:.3f} slope {f['slope']['R']:.3f}; top20 "
                    f"fH {f['fH']['R_top20']:.3f} M2 {f['M2']['R_top20']:.3f}; BSS M2 vs fH {f['M2']['bss_vs_ref']:+.4f}"
                    f" {f['M2']['bss_ci90']}; p {f['M2']['p_d']:.4f}/{f['M2']['p_top']:.4f}; MCB {f['fH']['MCB']:.5f}"
                    f"->{f['M2']['MCB']:.5f} DSC {f['fH']['DSC']:.5f}->{f['M2']['DSC']:.5f}; pos blocks "
                    f"{c['pos_blocks']} of {c['blocks']}")
        if T in (12, 72) and specs:
            out["lookahead"].append(lookahead(specs[len(specs) // 2], T, cfg))
            log(f"  look-ahead {out['lookahead'][-1]}")
        del S, P, p2, pb
    # verdicts
    for fam, cells in (("shallow", CELLS_SHALLOW), ("deep", CELLS_DEEP)):
        keys = [f"{TL[T]} {k}" for T, k in cells]
        pv = np.array([out["cells"][kk]["f"]["M2"]["cell_p"] for kk in keys])
        hol = R12.holm(pv, ALPHA)
        for kk, h in zip(keys, hol):
            c = out["cells"][kk]
            f, r = c["f"]["M2"], c["f"]["fH"]
            legs = {"d_abslnR_lt0": f["d_abslnR"] < 0, "d_top_lt0": f["d_top"] < 0, "holm": bool(h),
                    "brier_ni": f["bss_ci90"][0] > NI_MARGIN, "mcb_down": f["MCB"] < r["MCB"],
                    "dsc_not_down": f["DSC"] >= (1 - DSC_TOL) * r["DSC"], "pos_blocks_ge30": c["pos_blocks"] >= 30}
            c["verdict"] = {"legs": {k_: bool(v) for k_, v in legs.items()},
                            "result": "PASS" if all(legs.values()) else "FAIL"}
            log(f"VERDICT {kk} ({fam}): {c['verdict']['result']} {c['verdict']['legs']}")
    out["finished_utc"] = now_iso()
    h = R112.write_json(os.path.join(run_dir, "results-r131.json"), out)
    log(f"END results sha256 {h}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select-b15", "dev", "select", "acquire-b15a", "counts", "power", "freeze", "run"])
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--acq", default="")
    ap.add_argument("--dev", default="")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--horizons", default="")
    ap.add_argument("--limit", type=int, default=0, help="smoke test only: first N specs per set")
    a = ap.parse_args()
    {"select-b15": cmd_select_b15, "dev": cmd_dev, "select": cmd_select, "acquire-b15a": cmd_acquire_b15a,
     "counts": cmd_counts, "power": cmd_power, "freeze": cmd_freeze, "run": cmd_run}[a.cmd](a)


if __name__ == "__main__":
    main()
