"""Q26 R19.2 sequence-model family at borrower distances (Claude, Q26 lane, 2026-10-24). DEVELOPMENT ONLY (seen data).

membrane-board design/Q26_ROUND19_PREREG.md section R19.2 (grid, arms, criterion and selection rule committed there
before any score of this script). Parent work: design/Q26_ROUND16_PREREG.md D-R16.2e-a..g (rule D GRU).

Cells (25): T in {6 h, 12 h, 1 d, 3 d, 7 d} x k in {-5, -10, -15, -20, -30%}.
Labels (per row, origin t, spot S = close of the last finished hour):
  spot    y = 1 iff min hourly low over (t, t+T] <= S (1 + k)            (PRIMARY; the A3/R12/R16 label)
  or1m    y = 1 iff min over minutes m in (t, t+T] of G(m) <= S (1 + k), G(m) = exp(mean ln close over the 60 one-minute
          bars ending at m) (>= 50 of 60 present), Binance spot 1 m klines (data.binance.vision); ETH, BTC, A2, A3 only
  orlag   hourly LAGGED PROXY (labelled so): y = 1 iff min over hour ends j in (t, t+T] of exp((ln c_{j-1} + ln c_j) / 2)
          <= S (1 + k), c the hourly closes of the series' own grid; every series
  gap     spot-TWAP gap at the origin: ln(S / G(t)) (1 m G where present, else the lagged proxy). A row whose oracle
          proxy is already at or below the line at t (G(t) <= S (1 + k)) belongs to the imminent alert and is dropped
          from that cell's oracle-label scoring (counted).
Rows: the R12/R16.2 development pool (277 series, rows-meta order), origins as r16_dev ORIGIN_STEP, walk-forward
quarterly (fH)/(f)/(a) exactly as r16_dev.task (A6/R12 path), R12 drop rules (2026Q2 windows, ended-series tail).
Arms (residual GRU on logit (fH), rule D: 5 nets, fixed 8 epochs, best validation epoch 1..8, 100,000-row cap):
  i    rule D as trained (shallow targets), walk-forward replay of the D E1 seeds (r162e_cd c41dff8f, bit-exact state
       check against the published meta). The head is cell-specific (5 level units -2..-10%, horizon one-hot 1/3/12 h).
       i-A (primary transfer map): the residual of the -5% / -10% unit on the native 12 h input row at the same origin,
           added to logit (fH)(T, k) for k in {-5, -10}.
       i-B (reported): the borrower row's own inputs (its horizon's sigma_H, logit (fH) at -2..-10% for T), 12 h one-hot.
       i-X (reported only, extrapolation): the -10% unit residual applied at -15/-20/-30%.
  ii   refit: same architecture and protocol, borrower targets (5 level units -5..-30%, horizon one-hot over the 5
       borrower T), Tmax 168 h purge, seeds 31924000 + 1000 k + f, k = 1..5.
Recalibration: walk-forward Platt per arm, cell and label (D11 form: logit, rows with ts >= a - 730 d and ts + T <= a,
>= 1,000 rows and >= 20 positives else identity; refit per half-year fold), then running minimum over levels.

  python3 r192_borrower.py rows     --datasets DS --rowsmeta R16ROWS --out OUT [--workers 3]
  python3 r192_borrower.py check    --r16 R16ROWS --out OUT                 (labels/forecasts identical to r16 rows)
  python3 r192_borrower.py lookahead --datasets DS --out OUT                (truncation test of the row builder)
  python3 r192_borrower.py acq1m    --out OUT [--syms ETHUSDT,...]           (1 m klines -> hourly G summaries)
  python3 r192_borrower.py olabels  --datasets DS --out OUT                  (or1m labels for daily rows)
  python3 r192_borrower.py armi     --datasets DS --r16 R16ROWS --ref REFDIR --out OUT --ks 1,2 [--threads 1]
  python3 r192_borrower.py armii    --datasets DS --rowsmeta R16ROWS --out OUT --ks 1,2 [--threads 1]
  python3 r192_borrower.py score    --out OUT
  python3 r192_borrower.py synth    --out OUT [--threads 1]                  (known-answer, deep levels)
  python3 r192_borrower.py kat      --out OUT                                (scorer known-answer at rare events)
  python3 r192_borrower.py power    --out OUT
No address, key or secret is read or written. Nothing here is blind evidence and nothing ships from it.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a2_touch as M2  # noqa: E402
import a6_touch as A6  # noqa: E402
import r12_tail as R12  # noqa: E402
import r16_dev as D  # noqa: E402
import r16_nn as NN  # noqa: E402
import r16_nn_strict as S  # noqa: E402
import r162e_ens as E  # noqa: E402
import r162e_cd as CD  # noqa: E402

STEP, DAY = 3600, 86400
TS_B = (6, 12, 24, 72, 168)
LV_B = (-0.05, -0.10, -0.15, -0.20, -0.30)
LV_SH = NN.TIER_LV["shallow"]                      # (-0.02, -0.03, -0.05, -0.07, -0.10)
L8 = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.30)
JB = [L8.index(k) for k in LV_B]
JS = [L8.index(k) for k in LV_SH]
UNIT = {-0.05: 2, -0.10: 4}                         # shallow head units used by arm i
TMAX_B = max(TS_B)
SEED_II = 31924000
KS_II = (1, 2, 3, 4, 5)
TL = D.TL
FEATS = NN.STATIC                                   # lsH lsf dm wm r24 r168 r720 dd720 rng24 lvol btc_r24 btc_dm
RECAL_DAYS, RECAL_MIN_ROWS, RECAL_MIN_POS = 730, 1000, 20
B_BOOT = 2000
BOOT_SEED = 20261924
R_BAND = (0.8, 1.25)
MIN_POS_BLOCKS = 30
SHRINK_B20A = 2.3 / 5.8                            # realized / resampled z on B20a (D-R16.2e-a)
ONE_M_SYMS = None                                   # filled from keys (ETH, BTC, A2, A3)


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def group_of(key):
    if key in ("dev:BTC", "dev:ETH", "P1:KRAKEN-ETH"):
        return "btc_eth"
    return "large" if key.split(":")[0] in ("A2", "A3") else "small"


def binance_sym(key):
    if key in ("dev:ETH", "P1:KRAKEN-ETH"):
        return "ETHUSDT"
    if key == "dev:BTC":
        return "BTCUSDT"
    if key.split(":")[0] in ("A2", "A3"):
        return key.split(":")[1]
    return None


def seed_ii(k, f):
    return SEED_II + 1000 * k + f


# =====================================================================================================================
# rows (r16_dev.task restricted to a, f, fH and the GRU static features, at the L8 levels, borrower horizons)
# =====================================================================================================================
def _f0(ser, spec):
    N1 = len(ser.close) + 1
    vol = D.load_volume(spec)
    with np.errstate(invalid="ignore", divide="ignore"):
        HAR = np.log(A6.har_of(ser))
        lc = np.log(ser.spot)
        hi = np.concatenate([[np.nan], ser.high])
        lo = np.concatenate([[np.nan], ser.low])

    def lagret(L):
        o = np.full(N1, np.nan)
        o[L:] = lc[L:] - lc[:-L]
        return o

    def rollmax(x, W):
        from numpy.lib.stride_tricks import sliding_window_view
        o = np.full(N1, np.nan)
        if len(x) > W:
            v = sliding_window_view(np.where(np.isfinite(x), x, -np.inf), W).max(axis=1)
            o[W:] = v[:N1 - W]
        o[~np.isfinite(o)] = np.nan
        return o

    def rollmin(x, W):
        return -rollmax(-x, W)
    hmax720 = rollmax(hi[1:], 720)
    hmax24, lmin24 = rollmax(hi[1:], 24), rollmin(lo[1:], 24)
    F0 = {"dm": HAR[:, 0] - HAR[:, 2], "wm": HAR[:, 1] - HAR[:, 2], "r24": lagret(24), "r168": lagret(168),
          "r720": lagret(720)}
    with np.errstate(invalid="ignore", divide="ignore"):
        F0["dd720"] = lc - np.log(hmax720)
        F0["rng24"] = np.log(hmax24 / lmin24)
        if vol is not None and len(vol) == len(ser.close):
            v24, v720 = D.roll_mean(vol, 24, ser.start_i), D.roll_mean(vol, 720, ser.start_i)
            F0["lvol"] = np.log(v24 / v720)
        else:
            F0["lvol"] = np.full(N1, np.nan)
    for k_ in F0:
        F0[k_][~np.isfinite(F0[k_])] = np.nan
    ts_all = ser.base_ts + STEP * np.arange(N1)
    F0["btc_r24"], F0["btc_dm"] = D.btc_lookup(ts_all)
    return F0, ts_all


def first_touch(lowarr, i, T, spot, lnk):
    """first offset j in 0..T-1 with ln(low[i+j] / spot) <= ln(1 + k) (the label's own log comparison, per row and
    level); -1 if none."""
    from numpy.lib.stride_tricks import sliding_window_view as swv
    with np.errstate(invalid="ignore", divide="ignore"):
        W = np.log(swv(lowarr, T)[i] / spot[:, None])     # (m, T)
    hit = W[:, :, None] <= lnk[None, None, :]   # (m, T, K)
    anyh = hit.any(axis=1)
    return np.where(anyh, hit.argmax(axis=1), -1)


def lag_proxy(close):
    """Ghat[j] = exp((ln c[j-1] + ln c[j]) / 2), the hourly lagged proxy of the 1 h geometric mean ending at bar j's
    close (NaN where either close is missing)."""
    lc = np.log(close)
    g = np.full(len(close), np.nan)
    g[1:] = np.exp(0.5 * (lc[:-1] + lc[1:]))
    return g


def task(spec, truncate_ts=None):
    t0 = time.time()
    ser, folds, caps = R12.load_series(spec)
    if truncate_ts is not None:
        caps = {k: min(v, truncate_ts) for k, v in caps.items()}
    N1 = len(ser.close) + 1
    F0, ts_all = _f0(ser, spec)
    fold_q = [f for f in folds if f["qs_i"] < N1]
    lnk = np.log1p(np.array(L8))
    gl = lag_proxy(ser.close)                    # index j = bar j (opens at ts_all[j]); hour end = ts_all[j+1]
    rows = {}
    for T in TS_B:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        P, n = P6.P, P6.n
        i_all = np.arange(n)
        out = {k_: [] for k_ in ("i", "ts", "y", "a", "f", "fH", "q2", "tail") + FEATS}
        st = D.ORIGIN_STEP[T]
        for jf, f in enumerate(fold_q):
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
            te, pH, pf_ = te[keep], pH[keep], pf_[keep]
            if len(te) == 0:
                continue
            dtr = P.depth[tr & P.lab_ok]
            dtr = dtr[np.isfinite(dtr)]
            pa = np.stack([np.searchsorted(np.sort(dtr), lk, side="right") / max(len(dtr), 1)
                           for lk in lnk])[None, :].repeat(len(te), 0)
            for nm, v in (("a", pa), ("f", pf_), ("fH", pH)):
                out[nm].append(np.minimum.accumulate(np.asarray(v, float), axis=1).astype(np.float32))
            ts = ts_all[te]
            out["i"].append(te.astype(np.int64))
            out["ts"].append(ts)
            out["y"].append((P.depth[te][:, None] <= lnk[None, :]).astype(np.int8))
            out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
            out["tail"].append(ts + T * STEP > caps["primary"])
            for k_ in FEATS:
                if k_ == "lsH":
                    v = np.log(sH[te])
                elif k_ == "lsf":
                    v = np.log(ser.sigma[te])
                else:
                    v = F0[k_][te]
                out[k_].append(np.asarray(v, np.float32))
        if not out["ts"]:
            continue
        R = {k_: np.concatenate(v) for k_, v in out.items()}
        m = ~R["q2"] & ~R["tail"]
        R = {k_: v[m] for k_, v in R.items() if k_ not in ("q2", "tail")}
        # daily-origin extras: spot first touch, lagged-proxy label, its first hour, origin gap (lagged)
        dmask = R["ts"] % DAY == 0
        ii = R["i"][dmask]
        spot = ser.spot[ii]
        ft = first_touch(ser.low, ii, T, spot, lnk)
        ysp = R["y"][dmask]
        assert ((ft >= 0).astype(np.int8) == ysp).all(), "first-touch / label mismatch"
        glw_ok = np.isfinite(np.lib.stride_tricks.sliding_window_view(gl, T)[ii]).all(axis=1)
        ftl = first_touch(np.where(np.isfinite(gl), gl, np.inf), ii, T, spot, lnk)
        yl = np.where(glw_ok[:, None], (ftl >= 0).astype(np.int8), -1).astype(np.int8)
        with np.errstate(invalid="ignore", divide="ignore"):
            g0 = gl[ii - 1]                       # proxy ending at the origin (bar i-1 close)
            gap = np.log(spot / g0)
        R["d_idx"] = np.flatnonzero(dmask).astype(np.int64)
        R["d_spot"] = spot.astype(np.float64)
        R["d_ft"] = ft.astype(np.int16)           # hours after t of the first touching bar (bar opens t + j h)
        R["d_ylag"] = yl
        R["d_ftlag"] = np.where(yl >= 0, ftl, -1).astype(np.int16)
        R["d_gaplag"] = gap.astype(np.float32)
        R["d_glag0"] = g0.astype(np.float64)
        rows[T] = R
    return {"key": spec["key"], "rows": rows, "sec": time.time() - t0}


def _task_keyed(spec):
    return task(spec)


def cmd_rows(a):
    os.makedirs(a.out, exist_ok=True)
    keys = json.load(open(os.path.join(a.rowsmeta, "rows-meta.json")))["series"]
    specs = {s_["key"]: s_ for s_ in R12.dev_specs(a.datasets)}
    sp = [specs[k] for k in keys]
    if a.limit:
        sp = sp[:a.limit]
    D.init_btc(a.datasets)
    for s_ in sp:
        if s_["kind"] == "chain":
            R12.load_series(s_)
            break
    print(now(), f"START r192 rows; code {D.git_sha()}; series {len(sp)}", flush=True)
    acc = {T: [] for T in TS_B}
    t0 = time.time()
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=4) as pool:
        for j, r in enumerate(pool.imap_unordered(_task_keyed, sp, chunksize=1)):
            sid = keys.index(r["key"])
            for T, R in r["rows"].items():
                R["sid"] = np.full(len(R["ts"]), sid, np.int32)
                R["d_sid"] = np.full(len(R["d_idx"]), sid, np.int32)
                acc[T].append(R)
            if (j + 1) % 20 == 0 or j + 1 == len(sp):
                print(now(), f"  {j + 1}/{len(sp)} ({time.time() - t0:.0f}s; last {r['key']} {r['sec']:.0f}s)", flush=True)
    for T in TS_B:
        parts = sorted(acc[T], key=lambda R: int(R["sid"][0]))
        off = np.cumsum([0] + [len(R["ts"]) for R in parts])[:-1]
        out = {}
        for k_ in parts[0]:
            if k_ == "d_idx":
                out[k_] = np.concatenate([R[k_] + o for R, o in zip(parts, off)])
            else:
                out[k_] = np.concatenate([R[k_] for R in parts])
        np.savez_compressed(os.path.join(a.out, f"rowsB-T{T}.npz"), **out)
        print(now(), f"  wrote T {TL[T]}: {len(out['ts'])} rows, {len(out['d_idx'])} daily", flush=True)
    json.dump({"code": D.git_sha(), "series": keys, "finished_utc": now(), "levels": L8, "Ts": TS_B},
              open(os.path.join(a.out, "rowsB-meta.json"), "w"), indent=1)


def load_rowsB(out, T):
    return dict(np.load(os.path.join(out, f"rowsB-T{T}.npz")))


# =====================================================================================================================
# instrument checks
# =====================================================================================================================
def cmd_check(a):
    """labels and (fH)/(f)/(a)/features identical to the r16 development rows on every overlapping (T, level)."""
    res = {"code": D.git_sha(), "T": {}}
    ok_all = True
    for T in TS_B:
        B = load_rowsB(a.out, T)
        Z = np.load(os.path.join(a.r16, f"rows-T{T}.npz"))
        ob = np.lexsort((B["ts"], B["sid"]))
        oz = np.lexsort((Z["ts"], Z["sid"]))
        same_rows = len(ob) == len(oz) and (B["sid"][ob] == Z["sid"][oz]).all() and (B["ts"][ob] == Z["ts"][oz]).all()
        r = {"rows_B": int(len(ob)), "rows_r16": int(len(oz)), "same_row_set": bool(same_rows), "levels": {}}
        if same_rows:
            for j, k in enumerate(D.LV[T]):
                if k not in L8:
                    continue
                c = L8.index(k)
                lv = {}
                for nm in ("y", "fH", "f", "a"):
                    x, z = B[nm][ob, c], Z[nm][oz, j]
                    lv[nm] = int(np.sum(x != z))
                r["levels"][str(k)] = lv
                ok_all &= all(v == 0 for v in lv.values())
            r["features_max_absdiff"] = {k_: float(np.nanmax(np.abs(B[k_][ob].astype(np.float64) - Z[k_][oz])))
                                         for k_ in FEATS}
            r["features_nan_mismatch"] = {k_: int(np.sum(np.isnan(B[k_][ob]) != np.isnan(Z[k_][oz]))) for k_ in FEATS}
            ok_all &= all(v == 0 for v in r["features_max_absdiff"].values() if np.isfinite(v))
        else:
            ok_all = False
        res["T"][TL[T]] = r
        print(now(), TL[T], json.dumps(r), flush=True)
    res["pass"] = bool(ok_all)
    json.dump(res, open(os.path.join(a.out, "check-labels.json"), "w"), indent=1)
    print("CHECK pass", ok_all, flush=True)


def cmd_lookahead(a):
    """row-builder truncation test: rebuild 3 grid series with every input column (close, low, high, volume) set to
    null from CUT on; every row with ts + T <= CUT must be identical (y, fH, f, a, features). The lagged-proxy label and
    first touch of daily rows are compared too."""
    import gzip
    CUT = int(dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc).timestamp())
    D.init_btc(a.datasets)
    specs = {s_["key"]: s_ for s_ in R12.dev_specs(a.datasets)}
    b6 = sorted(k for k in specs if k.startswith("blind6:"))[0]
    res = {"cut": CUT, "series": {}, "code": D.git_sha()}
    ok = True
    for key in ("A2:SOLUSDT", "A3:AAVEUSDT", b6):
        full = task(specs[key])
        raw = open(specs[key]["path"], "rb").read()
        if specs[key]["path"].endswith(".gz"):
            raw = gzip.decompress(raw)
        d = json.loads(raw)
        cut_j = (CUT - int(d["startTs"])) // STEP
        for c in d["columns"]:
            col = d["columns"][c]
            for j in range(max(cut_j, 0), len(col)):
                col[j] = None
        tmp = os.path.join(a.out, "lookahead-tmp.json")
        json.dump(d, open(tmp, "w"))
        trn = task(dict(specs[key], path=tmp), truncate_ts=CUT)
        os.remove(tmp)
        r = {}
        for T in TS_B:
            Fa, Ft = full["rows"].get(T), trn["rows"].get(T)
            if Fa is None or Ft is None:
                continue
            ma = Fa["ts"] + T * STEP <= CUT
            mt = Ft["ts"] + T * STEP <= CUT
            same = bool((ma.sum() == mt.sum()) and (Fa["ts"][ma] == Ft["ts"][mt]).all())
            diff = {}
            if same:
                for nm in ("y", "fH", "f", "a") + FEATS:
                    x, z = Fa[nm][ma].astype(np.float64), Ft[nm][mt].astype(np.float64)
                    diff[nm] = int(np.sum(~((x == z) | (np.isnan(x) & np.isnan(z)))))
                da = Fa["ts"][Fa["d_idx"]] + T * STEP <= CUT
                dtt = Ft["ts"][Ft["d_idx"]] + T * STEP <= CUT
                for nm in ("d_ft", "d_ylag", "d_ftlag", "d_gaplag"):
                    x, z = Fa[nm][da].astype(np.float64), Ft[nm][dtt].astype(np.float64)
                    diff[nm] = int(np.sum(~((x == z) | (np.isnan(x) & np.isnan(z))))) if len(x) == len(z) else -1
            r[TL[T]] = {"rows": int(ma.sum()), "same_rows": same, "mismatch": diff}
            ok &= same and all(v == 0 for v in diff.values())
        res["series"][key] = r
        print(now(), key, json.dumps(r), flush=True)
    res["pass"] = bool(ok)
    json.dump(res, open(os.path.join(a.out, "lookahead.json"), "w"), indent=1)
    print("LOOKAHEAD pass", ok, flush=True)


# =====================================================================================================================
# 1 m klines -> hourly summaries of G (rolling 60-minute geometric mean)
# =====================================================================================================================
def _month_zip(sym, y, m):
    url = f"https://data.binance.vision/data/spot/monthly/klines/{sym}/1m/{sym}-1m-{y:04d}-{m:02d}.zip"
    for t in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                raw = r.read()
            return raw, hashlib.sha256(raw).hexdigest()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, None
            time.sleep(2 + 3 * t)
        except Exception:  # noqa: BLE001
            time.sleep(2 + 3 * t)
    raise RuntimeError(url)


def acq_sym(sym, out, y0=2017, y1=2026, m1=9):
    fn = os.path.join(out, f"g1m-{sym}.npz")
    if os.path.exists(fn):
        return sym, "exists"
    t_list, c_list, shas = [], [], {}
    for y in range(y0, y1 + 1):
        for m in range(1, 13):
            if (y, m) > (y1, m1):
                break
            raw, sha = _month_zip(sym, y, m)
            if raw is None:
                continue
            shas[f"{y:04d}-{m:02d}"] = sha
            z = zipfile.ZipFile(io.BytesIO(raw))
            txt = z.read(z.namelist()[0]).decode()
            arr = np.loadtxt(io.StringIO(txt), delimiter=",", usecols=(0, 4), ndmin=2,
                             comments=None, converters=None) if not txt.startswith("open") else \
                np.loadtxt(io.StringIO(txt), delimiter=",", usecols=(0, 4), ndmin=2, skiprows=1)
            ot = arr[:, 0]
            ot = np.where(ot > 1e14, ot / 1000.0, ot)          # microseconds from 2025
            t_list.append((ot // 1000).astype(np.int64))
            c_list.append(arr[:, 1])
    if not t_list:
        return sym, "none"
    t = np.concatenate(t_list)
    c = np.concatenate(c_list)
    hour_ts, gmin, gend, _ = g_summary(t, c)
    np.savez_compressed(fn, hour_ts=hour_ts, gmin=gmin, gend=gend)
    json.dump(shas, open(os.path.join(out, f"g1m-{sym}-sha256.json"), "w"), indent=0)
    return sym, f"{len(shas)} months, {len(hour_ts)} hours"


def g_summary(t, c):
    """minute open times t (s) and closes c -> hour open ts, min over the hour's minutes of G, G at the hour's last
    minute, and G per minute (G(m) = exp(mean ln close of the 60 bars ending at m), >= 50 present)."""
    t0 = (t.min() // STEP) * STEP
    nmin = (t.max() - t0) // 60 + 1
    lc = np.full(nmin, np.nan)
    lc[(t - t0) // 60] = np.log(c)
    ok = np.isfinite(lc)
    cs = np.concatenate([[0.0], np.cumsum(np.where(ok, lc, 0.0))])
    cn = np.concatenate([[0], np.cumsum(ok)])
    W = 60
    G = np.full(nmin, np.nan)                                 # G at minute m (bar m closed): bars m-59..m
    s_ = cs[W:] - cs[:-W]
    n_ = cn[W:] - cn[:-W]
    with np.errstate(invalid="ignore", divide="ignore"):
        G[W - 1:] = np.where(n_ >= 50, np.exp(s_ / np.maximum(n_, 1)), np.nan)
    nh = nmin // 60
    Gh = G[:nh * 60].reshape(nh, 60)
    allok = np.isfinite(Gh).all(axis=1)
    gmin = np.where(allok, np.nanmin(np.where(np.isfinite(Gh), Gh, np.inf), axis=1), np.nan)
    gend = Gh[:, -1]                                          # G at the last minute of the hour (= at hour end)
    return (t0 + STEP * np.arange(nh)).astype(np.int64), gmin, gend, G


def cmd_acq1m(a):
    os.makedirs(a.out, exist_ok=True)
    keys = json.load(open(os.path.join(a.out, "rowsB-meta.json")))["series"] if not a.syms else []
    syms = a.syms.split(",") if a.syms else sorted({binance_sym(k) for k in keys if binance_sym(k)})
    print(now(), "acq1m", syms, flush=True)
    import concurrent.futures as cf
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for s_, msg in ex.map(lambda s: acq_sym(s, a.out), syms):
            print(now(), s_, msg, flush=True)


def cmd_olabels(a):
    """or1m labels, first-touch hour and the 1 m origin gap for daily rows of series with a g1m file."""
    keys = json.load(open(os.path.join(a.out, "rowsB-meta.json")))["series"]
    specs = {s_["key"]: s_ for s_ in R12.dev_specs(a.datasets)}
    res = {}
    for T in TS_B:
        B = load_rowsB(a.out, T)
        nd = len(B["d_idx"])
        y1 = np.full((nd, len(L8)), -1, np.int8)
        ft1 = np.full((nd, len(L8)), -1, np.int16)
        gap1 = np.full(nd, np.nan, np.float32)
        imm1 = np.zeros((nd, len(L8)), bool)
        for sid in np.unique(B["d_sid"]):
            sym = binance_sym(keys[sid])
            fn = os.path.join(a.out, f"g1m-{sym}.npz") if sym else None
            if not fn or not os.path.exists(fn):
                continue
            Z = np.load(fn)
            h0 = int(Z["hour_ts"][0])
            gmin, gend = Z["gmin"], Z["gend"]
            m = np.flatnonzero(B["d_sid"] == sid)
            ts = B["ts"][B["d_idx"][m]]
            spot = B["d_spot"][m]
            j0 = (ts - h0) // STEP                       # hour opening at t
            okr = (j0 >= 1) & (j0 + T <= len(gmin))
            thr = spot[:, None] * (1.0 + np.array(L8))[None, :]
            idx = np.clip(j0[:, None] + np.arange(T)[None, :], 0, len(gmin) - 1)
            W = gmin[idx]
            wok = okr & np.isfinite(W).all(axis=1)
            hit = W[:, :, None] <= thr[:, None, :]
            anyh = hit.any(axis=1)
            y1[m] = np.where(wok[:, None], anyh.astype(np.int8), -1)
            ft1[m] = np.where(wok[:, None] & anyh, hit.argmax(axis=1), -1)
            g0 = np.where(okr, gend[np.clip(j0 - 1, 0, len(gend) - 1)], np.nan)
            with np.errstate(invalid="ignore", divide="ignore"):
                gap1[m] = np.log(spot / g0)
            imm1[m] = g0[:, None] <= thr
        np.savez_compressed(os.path.join(a.out, f"olab-T{T}.npz"), y1=y1, ft1=ft1, gap1=gap1, imm1=imm1)
        res[TL[T]] = {"daily_rows": int(nd), "rows_with_or1m": int((y1[:, 0] >= 0).sum())}
        print(now(), TL[T], res[TL[T]], flush=True)
    json.dump(res, open(os.path.join(a.out, "olabels-meta.json"), "w"), indent=1)


# =====================================================================================================================
# GRU arms
# =====================================================================================================================
def build_SA(a, keys):
    specs = {s_["key"]: s_ for s_ in R12.dev_specs(a.datasets)}
    SA = {j: NN.series_arrays(specs[k]) for j, k in enumerate(keys)}
    flags = S.exclusions(keys, SA)
    return SA, flags


def borrower_daily(out, keys, flags):
    """daily borrower rows (every T), excluded series removed: dict of arrays in (T, row) order."""
    drop = np.array([k in flags for k in keys])
    parts = []
    for jT, T in enumerate(TS_B):
        B = load_rowsB(out, T)
        di = B["d_idx"]
        keep = ~drop[B["sid"][di]]
        di = di[keep]
        parts.append({"T": np.full(len(di), T, np.int32), "sid": B["sid"][di], "ts": B["ts"][di],
                      "drow": np.flatnonzero(keep).astype(np.int64),
                      "LFsh": D.lg(B["fH"][di][:, JS]).astype(np.float32),
                      **{k_: B[k_][di] for k_ in FEATS}})
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def cmd_armi(a):
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, f"armi-log-{a.ks.replace(',', '_')}.txt"), "a")

    def log(s_):
        line = f"{now()} {s_}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r192 arm i (rule D replay, shallow targets) ks {a.ks}; code {D.git_sha()}")
    a.rows = a.r16
    keys, SA, flags, Rsh = E.load_dev(a)
    log(f"  shallow rows {len(Rsh['ts'])}; excluded {flags}")
    BD = borrower_daily(a.out, keys, flags)
    L, nT, Tmax = len(LV_SH), 3, 12
    F = S.folds(int(Rsh["ts"].max()))
    for k in [int(x) for x in a.ks.split(",")]:
        fn = os.path.join(a.out, f"armi-k{k}.npz")
        if os.path.exists(fn):
            log(f"  k {k} exists")
            continue
        ref = {m["fold"]: m for m in json.load(open(os.path.join(a.ref, f"meta-D-k{k}.json")))}
        rA = np.full((len(BD["ts"]), 2), np.nan, np.float32)
        rB = np.full((len(BD["ts"]), 2), np.nan, np.float32)
        sh_idx, sh_res, meta = [], [], []
        for fi, (fa, fb) in enumerate(F):
            sets = CD.fold_sets(Rsh, fa, fb, CD.seed_of(k, fi), Tmax, "D")
            if sets is None:
                continue
            tr, va, te, n_av = sets
            st, info = CD.fit_best(Rsh, SA, tr, va, L, nT, CD.seed_of(k, fi))
            match = info["state_sha256"] == ref[fi]["state_sha256"]
            info.update({"k": k, "fold": fi, "a": fa, "b": fb, "ref_state_sha256": ref[fi]["state_sha256"],
                         "replay_match": bool(match)})
            (pr,) = E.predict_res(Rsh, SA, te, [st], L, nT)
            sh_idx.append(te)
            sh_res.append(pr)
            # i-A: native 12 h rows at the same origin
            m12 = Rsh["T"][te] == 12
            key12 = {(int(s_), int(t_)): j for j, (s_, t_) in enumerate(zip(Rsh["sid"][te][m12], Rsh["ts"][te][m12]))}
            r12 = pr[m12]
            fm = np.flatnonzero((BD["ts"] >= fa) & (BD["ts"] < fb))
            got = 0
            for j in fm:
                q = key12.get((int(BD["sid"][j]), int(BD["ts"][j])))
                if q is not None:
                    rA[j] = r12[q, [UNIT[-0.05], UNIT[-0.10]]]
                    got += 1
            # i-B: borrower inputs with the 12 h one-hot
            if len(fm):
                o = np.lexsort((BD["ts"][fm], BD["sid"][fm]))
                fm_s = fm[o]
                Rb = {"sid": BD["sid"][fm_s], "ts": BD["ts"][fm_s], "Tidx": np.full(len(fm_s), 2, np.int32),
                      "LF": BD["LFsh"][fm_s], "Y": np.zeros((len(fm_s), L), np.int8),
                      **{k_: BD[k_][fm_s] for k_ in FEATS}}
                (pb,) = E.predict_res(Rb, SA, np.arange(len(fm_s)), [st], L, nT)
                rB[fm_s] = pb[:, [UNIT[-0.05], UNIT[-0.10]]]
            info.update({"borrower_rows": int(len(fm)), "iA_found": int(got)})
            meta.append(info)
            log(f"  k {k} fold {fi} {dt.datetime.utcfromtimestamp(fa):%Y-%m}: best epoch {info['best_epoch']} "
                f"replay {'MATCH' if match else 'MISMATCH'} borrower {len(fm)} iA {got} ({info['sec']:.0f}s)")
        np.savez_compressed(fn, rA=rA, rB=rB, sh_idx=np.concatenate(sh_idx),
                            sh_res=np.concatenate(sh_res).astype(np.float16))
        json.dump(meta, open(os.path.join(a.out, f"armi-meta-k{k}.json"), "w"), indent=1, default=float)
        log(f"  k {k} written; replay matches {sum(m['replay_match'] for m in meta)}/{len(meta)}")
    log("END arm i")


def tier_rows_B(out, keys, flags):
    drop = np.array([k in flags for k in keys])
    parts = []
    for jT, T in enumerate(TS_B):
        B = load_rowsB(out, T)
        keep = ~drop[B["sid"]]
        n = int(keep.sum())
        d_of = np.full(len(B["ts"]), -1, np.int64)
        d_of[B["d_idx"]] = np.arange(len(B["d_idx"]))
        parts.append({"sid": B["sid"][keep], "ts": B["ts"][keep], "Y": B["y"][keep][:, JB],
                      "LF": D.lg(B["fH"][keep][:, JB]).astype(np.float32), "T": np.full(n, T, np.int32),
                      "Tidx": np.full(n, jT, np.int32), "drow": d_of[keep],
                      **{k_: B[k_][keep] for k_ in FEATS}})
        del B
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def cmd_armii(a):
    import torch
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, f"armii-log-{a.ks.replace(',', '_')}.txt"), "a")

    def log(s_):
        line = f"{now()} {s_}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"START r192 arm ii (rule D refit, borrower targets) ks {a.ks}; code {D.git_sha()}")
    keys = json.load(open(os.path.join(a.rowsmeta, "rows-meta.json")))["series"]
    SA, flags = build_SA(a, keys)
    R = tier_rows_B(a.out, keys, flags)
    log(f"  borrower tier rows {len(R['ts'])}; excluded {flags}")
    json.dump(flags, open(os.path.join(a.out, "excluded.json"), "w"))
    L, nT = len(LV_B), len(TS_B)
    F = S.folds(int(R["ts"].max()))
    for k in [int(x) for x in a.ks.split(",")]:
        assert k in KS_II
        fn = os.path.join(a.out, f"armii-k{k}.npz")
        if os.path.exists(fn):
            log(f"  k {k} exists")
            continue
        idx, rr, meta = [], [], []
        for fi, (fa, fb) in enumerate(F):
            sets = CD.fold_sets(R, fa, fb, seed_ii(k, fi), TMAX_B, "D")
            if sets is None:
                continue
            tr, va, te, n_av = sets
            st, info = CD.fit_best(R, SA, tr, va, L, nT, seed_ii(k, fi))
            (pr,) = E.predict_res(R, SA, te, [st], L, nT)
            idx.append(te)
            rr.append(pr)
            info.update({"k": k, "fold": fi, "a": fa, "b": fb, "test": int(len(te)), "train_available": n_av})
            meta.append(info)
            log(f"  k {k} fold {fi} {dt.datetime.utcfromtimestamp(fa):%Y-%m}: train {len(tr)} val "
                f"{['%.5f' % v for v in info['val_bce_ep0_to_8']]} best epoch {info['best_epoch']} ({info['sec']:.0f}s)")
        te_all = np.concatenate(idx)
        np.savez_compressed(fn, T=R["T"][te_all], drow=R["drow"][te_all], sid=R["sid"][te_all], ts=R["ts"][te_all],
                            r=np.concatenate(rr).astype(np.float32))
        json.dump(meta, open(os.path.join(a.out, f"armii-meta-k{k}.json"), "w"), indent=1, default=float)
        log(f"  k {k} written")
    log("END arm ii")


# =====================================================================================================================
# scoring
# =====================================================================================================================
def runmin(p):
    return np.minimum.accumulate(np.clip(p, 0, 1), axis=1)


def sig(x):
    return 1 / (1 + np.exp(-x))


class TW(D.TwoWay):
    def boot(self, d, mask=None):
        si, bi = self.si, self.bi
        w = np.ones(len(d)) if mask is None else mask.astype(float)
        Sc = np.zeros((len(self.us), len(self.ub)))
        Nc = np.zeros_like(Sc)
        np.add.at(Sc, (si, bi), d * w)
        np.add.at(Nc, (si, bi), w)
        mean = Sc.sum() / Nc.sum()
        num = np.einsum("bs,sk,bk->b", self.ws, Sc, self.wb)
        den = np.einsum("bs,sk,bk->b", self.ws, Nc, self.wb)
        mb = num / np.where(den > 0, den, np.nan)
        mb = mb[np.isfinite(mb)]
        sd = float(np.std(mb))
        B = len(mb)
        return {"mean": float(mean), "sd": sd, "z": float(mean / sd) if sd > 0 else None,
                "p_centred": float((1 + np.sum(mb - mean <= mean)) / (B + 1)),
                "p_pct": float((1 + np.sum(mb >= 0)) / (B + 1)), "S": int(len(self.us)), "K": int(len(self.ub))}


def platt_fit(x, y):
    from scipy.optimize import minimize

    def f(w):
        z = w[0] + w[1] * x
        return float(np.sum(np.logaddexp(0, z) - y * z))

    def gr(w):
        s_ = 1 / (1 + np.exp(-(w[0] + w[1] * x)))
        return np.array([np.sum(s_ - y), np.sum((s_ - y) * x)])
    return minimize(f, np.array([0.0, 1.0]), jac=gr, method="L-BFGS-B").x


def lgc(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def recal(P, Y, ts, T, folds):
    """walk-forward Platt per level column (Y -1 = no label), then running minimum over levels."""
    out = np.array(P, float)
    starts = np.array([f[0] for f in folds])
    fo = np.searchsorted(starts, ts, side="right") - 1
    for fi in np.unique(fo):
        fa = folds[fi][0]
        te = fo == fi
        trm = (ts >= fa - RECAL_DAYS * DAY) & (ts + T * STEP <= fa)
        for c in range(P.shape[1]):
            m = trm & (Y[:, c] >= 0)
            if m.sum() < RECAL_MIN_ROWS or Y[m, c].sum() < RECAL_MIN_POS:
                continue
            w = platt_fit(lgc(P[m, c]), Y[m, c].astype(float))
            out[te, c] = sig(w[0] + w[1] * lgc(P[te, c]))
    return runmin(out)


def event_day_drop(ft, y, ts, sid, T):
    """largest event day: the UTC day with the most distinct series whose first touch falls on it, qualifying with
    >= max(5, 10% of series with an origin that day); returns (day, mask of rows to keep)."""
    pos = (y == 1) & (ft >= 0)
    if pos.sum() == 0:
        return None, np.ones(len(y), bool)
    tday = (ts[pos] + ft[pos].astype(np.int64) * STEP) // DAY
    pairs = np.unique(np.stack([tday, sid[pos]], 1), axis=0)
    days, cnt = np.unique(pairs[:, 0], return_counts=True)
    oday = ts // DAY
    best, bc = None, -1
    for dday, c in sorted(zip(days, cnt), key=lambda x: -x[1]):
        n_or = len(np.unique(sid[oday == dday]))
        if c >= max(5, 0.1 * n_or) and c > bc:
            best, bc = int(dday), int(c)
            break
    if best is None:
        return None, np.ones(len(y), bool)
    t0, t1 = best * DAY, (best + 1) * DAY
    meets = (ts < t1) & (ts + T * STEP > t0)              # window (t, t+T] meets the day
    return best, ~meets


def cell_stats(p1, p0, y, sid, ts, blk, ft, T, tw, keys_g, full=True):
    """d = (p1 - y)^2 - (p0 - y)^2 on labelled rows; BSS(1 vs 0), two-way, CGM, leave-top-k, event-day drop, R."""
    m = y >= 0
    p1, p0, yy, s_, t_, b_, f_ = p1[m], p0[m], y[m].astype(float), sid[m], ts[m], blk[m], ft[m]
    out = {"rows": int(m.sum()), "pos": int(yy.sum())}
    if yy.sum() == 0:
        out["note"] = "no positives"
        return out
    e1, e0 = (p1 - yy) ** 2, (p0 - yy) ** 2
    d = e1 - e0
    out["bss"] = float(1 - e1.sum() / e0.sum())
    out["R1"], out["R0"] = float(p1.sum() / yy.sum()), float(p0.sum() / yy.sum())
    posb = np.unique(b_[yy == 1])
    out["pos_blocks"], out["pos_series"] = int(len(posb)), int(len(np.unique(s_[yy == 1])))
    if not full:
        return out
    tw_ = TW(s_, b_, B=B_BOOT, seed=BOOT_SEED) if tw is None else tw
    bt = tw_.boot(d)
    out.update({"z": bt["z"], "p_centred": bt["p_centred"], "p_pct": bt["p_pct"], "cgm_z": S.cgm_z(d, s_, b_)})
    lk = D.leave_top_k(s_, d)
    us, inv = np.unique(s_, return_inverse=True)
    tot = np.bincount(inv, weights=d)
    top = np.argsort(tot)[:lk["k"]]
    keep = ~np.isin(inv, top)
    out["ltk"] = {"k": lk["k"], "mean_after": lk["mean_after"], "z_after": tw_.boot(d, keep)["z"],
                  "bss_after": float(1 - e1[keep].sum() / e0[keep].sum()), "top_share": lk["topk_share_of_gain"],
                  "series_gain": lk["series_with_gain"], "series": lk["series"]}
    day, kp = event_day_drop(f_, yy.astype(int), t_, s_, T)
    out["event"] = {"day": None if day is None else dt.datetime.utcfromtimestamp(day * DAY).strftime("%Y-%m-%d"),
                    "rows_dropped": int((~kp).sum()), "mean_after": float(d[kp].mean()),
                    "bss_after": float(1 - e1[kp].sum() / e0[kp].sum()) if e0[kp].sum() > 0 else None,
                    "z_after": tw_.boot(d, kp)["z"]}
    g = keys_g[m]
    out["groups"] = {}
    for gn in ("btc_eth", "large", "small"):
        sel = g == gn
        if sel.sum() == 0 or yy[sel].sum() == 0:
            out["groups"][gn] = {"rows": int(sel.sum()), "pos": int(yy[sel].sum())}
            continue
        twg = TW(s_[sel], b_[sel], B=B_BOOT, seed=BOOT_SEED)
        out["groups"][gn] = {"rows": int(sel.sum()), "pos": int(yy[sel].sum()),
                             "bss": float(1 - e1[sel].sum() / e0[sel].sum()), "z": twg.boot(d[sel])["z"],
                             "R1": float(p1[sel].sum() / yy[sel].sum()), "R0": float(p0[sel].sum() / yy[sel].sum()),
                             "pos_blocks": int(len(np.unique(b_[sel & (yy == 1)])))}
    return out


def asset_stats(p1, p0, y, sel, blk):
    """single-asset block bootstrap (4-week blocks) of d on rows sel (labelled)."""
    m = sel & (y >= 0)
    if m.sum() == 0 or y[m].sum() == 0:
        return {"rows": int(m.sum()), "pos": int((y[m] == 1).sum())}
    yy = y[m].astype(float)
    e1, e0 = (p1[m] - yy) ** 2, (p0[m] - yy) ** 2
    d = e1 - e0
    tw = TW(np.zeros(m.sum(), int), blk[m], B=B_BOOT, seed=BOOT_SEED)
    bt = tw.boot(d)
    return {"rows": int(m.sum()), "pos": int(yy.sum()), "bss": float(1 - e1.sum() / e0.sum()), "z": bt["z"],
            "p_pct": bt["p_pct"], "R1": float(p1[m].sum() / yy.sum()), "R0": float(p0[m].sum() / yy.sum()),
            "pos_blocks": int(len(np.unique(blk[m][yy == 1]))), "mean_d": float(d.mean()),
            "sd_mean_d": bt["sd"], "blocks": int(len(np.unique(blk[m]))), "mean_e0": float(e0.mean())}


def assemble(out_dir):
    """daily scoring table (T, row): labels, comparators, arm forecasts (seed-mean residual), restricted to rows that
    every arm predicts."""
    keys = json.load(open(os.path.join(out_dir, "rowsB-meta.json")))["series"]
    flags = json.load(open(os.path.join(out_dir, "excluded.json")))
    BD = borrower_daily(out_dir, keys, flags)
    n = len(BD["ts"])
    rA = np.mean([np.load(os.path.join(out_dir, f"armi-k{k}.npz"))["rA"] for k in CD.E1], axis=0)
    rB = np.mean([np.load(os.path.join(out_dir, f"armi-k{k}.npz"))["rB"] for k in CD.E1], axis=0)
    rA_k = {k: np.load(os.path.join(out_dir, f"armi-k{k}.npz"))["rA"] for k in CD.E1}
    # arm ii residuals mapped onto BD by (T, sid, ts)
    pos = {(int(T), int(s_), int(t_)): j for j, (T, s_, t_) in enumerate(zip(BD["T"], BD["sid"], BD["ts"]))}
    rii_k = {}
    for k in KS_II:
        Z = np.load(os.path.join(out_dir, f"armii-k{k}.npz"))
        r = np.full((n, len(LV_B)), np.nan, np.float32)
        j = np.array([pos.get((int(T), int(s_), int(t_)), -1) for T, s_, t_ in zip(Z["T"], Z["sid"], Z["ts"])])
        ok = j >= 0
        r[j[ok]] = Z["r"][ok]
        rii_k[k] = r
    rii = np.mean([rii_k[k] for k in KS_II], axis=0)
    # labels and comparators from the row files
    cols = {nm: [] for nm in ("y", "fH", "f", "a", "ft", "ylag", "ftlag", "gaplag", "y1", "ft1", "gap1", "imm1",
                              "glag0", "spot")}
    for T in TS_B:
        B = load_rowsB(out_dir, T)
        Ol = np.load(os.path.join(out_dir, f"olab-T{T}.npz")) if os.path.exists(os.path.join(out_dir, f"olab-T{T}.npz")) else None
        drop = np.array([k in flags for k in keys])
        di = B["d_idx"]
        keep = ~drop[B["sid"][di]]
        di_k = di[keep]
        cols["y"].append(B["y"][di_k][:, JB])
        for nm in ("fH", "f", "a"):
            cols[nm].append(B[nm][di_k][:, JB].astype(np.float64))
        cols["ft"].append(B["d_ft"][keep][:, JB])
        cols["ylag"].append(B["d_ylag"][keep][:, JB])
        cols["ftlag"].append(B["d_ftlag"][keep][:, JB])
        cols["gaplag"].append(B["d_gaplag"][keep])
        cols["glag0"].append(B["d_glag0"][keep])
        cols["spot"].append(B["d_spot"][keep])
        if Ol is not None:
            cols["y1"].append(Ol["y1"][keep][:, JB])
            cols["ft1"].append(Ol["ft1"][keep][:, JB])
            cols["gap1"].append(Ol["gap1"][keep])
            cols["imm1"].append(Ol["imm1"][keep][:, JB])
        else:
            nd = int(keep.sum())
            cols["y1"].append(np.full((nd, 5), -1, np.int8))
            cols["ft1"].append(np.full((nd, 5), -1, np.int16))
            cols["gap1"].append(np.full(nd, np.nan, np.float32))
            cols["imm1"].append(np.zeros((nd, 5), bool))
    X = {k: np.concatenate(v) for k, v in cols.items()}
    X.update({"T": BD["T"], "sid": BD["sid"], "ts": BD["ts"]})
    LFb = D.lg(X["fH"])
    # arm forecasts
    resA = np.column_stack([rA[:, 0], rA[:, 1], rA[:, 1], rA[:, 1], rA[:, 1]])
    resB = np.column_stack([rB[:, 0], rB[:, 1], rB[:, 1], rB[:, 1], rB[:, 1]])
    X["p_iA"] = runmin(sig(LFb + resA))
    X["p_iB"] = runmin(sig(LFb + resB))
    X["p_ii"] = runmin(sig(LFb + rii))
    X["p_ii_k"] = {k: runmin(sig(LFb + rii_k[k])) for k in KS_II}
    X["p_iA_k"] = {k: runmin(sig(LFb + np.column_stack([rA_k[k][:, 0]] + [rA_k[k][:, 1]] * 4))) for k in CD.E1}
    common = np.isfinite(rA).all(1) & np.isfinite(rii).all(1) & np.isfinite(rB).all(1)
    X["common"] = common
    X["n_all"] = n
    X["keys"] = keys
    X["grp"] = np.array([group_of(k) for k in keys])[X["sid"]]
    return X


def cmd_score(a):
    t0 = time.time()
    X = assemble(a.out)
    keys = X["keys"]
    cm = X["common"]
    sub = {k: (v[cm] if isinstance(v, np.ndarray) and len(v) == X["n_all"] else v) for k, v in X.items()
           if k not in ("p_ii_k", "p_iA_k")}
    sub["p_ii_k"] = {k: v[cm] for k, v in X["p_ii_k"].items()}
    sub["p_iA_k"] = {k: v[cm] for k, v in X["p_iA_k"].items()}
    X = sub
    folds = S.folds(int(X["ts"].max()))
    blk = (X["ts"] // (28 * DAY)).astype(np.int64)
    res = {"schema": "q26-r192/1", "label": "DEVELOPMENT ONLY (seen data)", "code": D.git_sha(),
           "rule_doc": "membrane-board design/Q26_ROUND19_PREREG.md R19.2", "rows_common": int(cm.sum()),
           "rows_all": int(X["n_all"]) if "n_all" in X else None, "cells": {}}
    print(now(), "scoring rows", int(cm.sum()), flush=True)
    labels = {"spot": ("y", "ft"), "orlag": ("ylag", "ftlag"), "or1m": ("y1", "ft1")}
    ethm = np.isin(X["sid"], [keys.index("dev:ETH"), keys.index("P1:KRAKEN-ETH")])
    btcm = X["sid"] == keys.index("dev:BTC")
    largem = X["grp"] == "large"
    arms = ("iA", "iB", "ii")
    SAVE = {}
    for T in TS_B:
        r = X["T"] == T
        sidT, tsT, blkT, gT = X["sid"][r], X["ts"][r], blk[r], X["grp"][r]
        for lab, (yc, fc) in labels.items():
            Y = X[yc][r].astype(int)
            if lab != "spot":
                imm = X["imm1"][r] if lab == "or1m" else (X["glag0"][r][:, None] <= X["spot"][r][:, None] * (1 + np.array(LV_B))[None, :])
                Y = np.where(imm, -1, Y)
            FT = X[fc][r]
            if (Y >= 0).sum() == 0:
                continue
            P = {"fH": runmin(X["fH"][r]), "f": runmin(X["f"][r]), "a": runmin(X["a"][r])}
            for arm in arms:
                P[arm] = X["p_" + arm][r]
            Pc = {nm: recal(P[nm], Y, tsT, T, folds) for nm in ("fH", "iA", "iB", "ii")}
            if lab == "spot":
                SAVE[T] = {"sid": sidT, "ts": tsT, "y": Y, "ft": FT, "grp": gT,
                           **{f"raw_{nm}": P[nm] for nm in ("fH", "iA", "ii")},
                           **{f"cal_{nm}": Pc[nm] for nm in ("fH", "iA", "ii")}}
            tw = None
            for c, k in enumerate(LV_B):
                cell = f"{TL[T]} {int(round(k * 100))}%"
                y = Y[:, c]
                ft = FT[:, c]
                if (y >= 0).sum() == 0:
                    continue
                lm = y >= 0
                tw = TW(sidT[lm], blkT[lm], B=B_BOOT, seed=BOOT_SEED)
                cr = {"label": lab, "imminent_dropped": int((X[yc][r][:, c] >= 0).sum() - lm.sum()) if lab != "spot" else 0}
                comps = []
                for arm in arms:
                    if arm in ("iA", "iB") and k not in UNIT:
                        tag = "extrapolated (report only)"
                    else:
                        tag = "direct"
                    for cmpn in ("fH", "f", "a"):
                        comps.append((f"{arm}_raw_vs_{cmpn}", P[arm][:, c], P[cmpn][:, c], tag))
                    comps.append((f"{arm}_recal_vs_fHrecal", Pc[arm][:, c], Pc["fH"][:, c], tag))
                comps.append(("fHrecal_vs_fH", Pc["fH"][:, c], P["fH"][:, c], "comparator"))
                comps.append(("fH_vs_f", P["fH"][:, c], P["f"][:, c], "comparator"))
                comps.append(("fH_vs_a", P["fH"][:, c], P["a"][:, c], "comparator"))
                full_set = {"iA_raw_vs_fH", "iA_recal_vs_fHrecal", "ii_raw_vs_fH", "ii_recal_vs_fHrecal",
                            "iB_raw_vs_fH", "fH_vs_f", "fHrecal_vs_fH", "ii_raw_vs_f", "iA_raw_vs_f"}
                for nm, p1, p0, tag in comps:
                    if lm.sum() == 0:
                        continue
                    st = cell_stats(p1[lm], p0[lm], y[lm], sidT[lm], tsT[lm], blkT[lm], ft[lm], T, tw, gT[lm],
                                    full=(nm in full_set) and lab in ("spot", "or1m", "orlag"))
                    st["tag"] = tag
                    # ETH and BTC separately; large caps
                    if nm in full_set:
                        st["ETH"] = asset_stats(p1, p0, y, ethm[r], blkT)
                        st["BTC"] = asset_stats(p1, p0, y, btcm[r], blkT)
                        st["ETHBTC"] = asset_stats(p1, p0, y, ethm[r] | btcm[r], blkT)
                        st["LARGE_blockonly"] = asset_stats(p1, p0, y, largem[r], blkT)
                    cr[nm] = st
                # seed spread (arm ii, arm iA) on the spot label, raw vs fH
                if lab == "spot":
                    cr["seeds_ii"] = [float(1 - ((X["p_ii_k"][kk][r][lm, c] - y[lm]) ** 2).sum() /
                                            ((P["fH"][lm, c] - y[lm]) ** 2).sum()) for kk in KS_II]
                    cr["seeds_iA"] = [float(1 - ((X["p_iA_k"][kk][r][lm, c] - y[lm]) ** 2).sum() /
                                            ((P["fH"][lm, c] - y[lm]) ** 2).sum()) for kk in CD.E1]
                    # gap terciles (lagged gap) R of fH and ii, report only
                    gp = X["gaplag"][r][lm]
                    qs_ = np.nanquantile(gp, [1 / 3, 2 / 3])
                    tt = np.digitize(gp, qs_)
                    cr["gap_terciles"] = {str(j): {"rows": int((tt == j).sum()), "pos": int(y[lm][tt == j].sum()),
                                                   "R_fH": float(P["fH"][lm, c][tt == j].sum() / max(y[lm][tt == j].sum(), 1)),
                                                   "R_ii": float(P["ii"][lm, c][tt == j].sum() / max(y[lm][tt == j].sum(), 1))}
                                          for j in range(3)}
                    cr["gap_cuts"] = [float(x) for x in qs_]
                res["cells"].setdefault(cell, {})[lab] = cr
                s0 = cr.get("ii_raw_vs_fH", {})
                print(now(), cell, lab, f"rows {s0.get('rows')} pos {s0.get('pos')} ii BSS {s0.get('bss')} z {s0.get('z')}",
                      flush=True)
    res["sec"] = round(time.time() - t0, 1)
    json.dump(res, open(os.path.join(a.out, "score-r192.json"), "w"), indent=1, default=float)
    np.savez_compressed(os.path.join(a.out, "score-forecasts.npz"), T=X["T"], sid=X["sid"], ts=X["ts"],
                        p_iA=X["p_iA"].astype(np.float32), p_iB=X["p_iB"].astype(np.float32),
                        p_ii=X["p_ii"].astype(np.float32))
    np.savez_compressed(os.path.join(a.out, "spot-forecasts.npz"),
                        **{f"T{T}_{k}": v for T, dd in SAVE.items() for k, v in dd.items()})
    print(now(), "END score", flush=True)


# =====================================================================================================================
# verdicts (R19.2d DEV-SKILL with Holm; R19.2e transfer)
# =====================================================================================================================
def devskill(cells, comp, names, lab="spot"):
    rows = []
    for nm in names:
        st = cells.get(nm, {}).get(lab, {}).get(comp)
        if not st or "z" not in st or st.get("z") is None:
            rows.append((nm, 1.0, st))
            continue
        rows.append((nm, max(st["p_centred"], st["p_pct"]) if st["bss"] > 0 else 1.0, st))
    m = len(rows)
    order = sorted(range(m), key=lambda i: rows[i][1])
    holm_ok, alive = {}, True
    for j, i in enumerate(order):
        alive = alive and rows[i][1] <= 0.05 / (m - j)
        holm_ok[rows[i][0]] = alive
    out = {}
    for nm, p, st in rows:
        if not st or "z" not in st:
            out[nm] = {"pass": False, "why": "no positives or no stats"}
            continue
        legs = {"holm": bool(holm_ok[nm]), "ltk": st["ltk"]["mean_after"] is not None and st["ltk"]["mean_after"] < 0,
                "event": st["event"]["mean_after"] < 0, "Rband": R_BAND[0] <= st["R1"] <= R_BAND[1],
                "pos_blocks": st["pos_blocks"] >= MIN_POS_BLOCKS}
        flag = None
        if st["z"] is not None and st["cgm_z"] is not None and (st["z"] < 0) != (st["cgm_z"] < 0):
            flag = "two-way and CGM signs disagree"
        out[nm] = {"pass": all(legs.values()), "legs": legs, "p": p, "bss": st["bss"], "z": st["z"],
                   "cgm_z": st["cgm_z"], "R1": st["R1"], "R0": st["R0"], "flag": flag}
    return out


def transfer(st):
    from scipy.stats import norm  # noqa: F401
    eb, lg_ = st.get("ETHBTC", {}), st.get("groups", {}).get("large", {})
    if "bss" not in eb or "bss" not in lg_:
        return {"verdict": "UNDETERMINED", "why": "no positives in a group"}
    v = "UNDETERMINED"
    if eb["bss"] > 0 and eb["z"] is not None and eb["z"] <= -1.645:
        v = "CARRIES"
    elif eb["bss"] < 0 and eb["z"] is not None and eb["z"] >= 1.645:
        v = "CONTRADICTED"
    out = {"verdict": v, "bss_ethbtc": eb["bss"], "z_ethbtc": eb["z"], "bss_large": lg_["bss"], "z_large": lg_["z"],
           "ratio": eb["bss"] / lg_["bss"] if lg_["bss"] not in (0, None) else None}
    if v == "UNDETERMINED" and lg_["bss"] > 0 and eb.get("sd_mean_d"):
        dass = lg_["bss"] * eb["mean_e0"]
        out["blocks_needed_80"] = float(eb["blocks"] * ((1.645 + 0.8416) * eb["sd_mean_d"] / dass) ** 2)
        out["blocks_have"] = eb["blocks"]
    return out


def cmd_verdict(a):
    sc = json.load(open(os.path.join(a.out, "score-r192.json")))
    cells = sc["cells"]
    allc = [f"{TL[T]} {int(round(k * 100))}%" for T in TS_B for k in LV_B]
    direct_i = [f"{TL[T]} {int(round(k * 100))}%" for T in TS_B for k in (-0.05, -0.10)]
    res = {"code": D.git_sha(), "label": "DEVELOPMENT ONLY (seen data)"}
    for lab in ("spot", "or1m", "orlag"):
        res[lab] = {"ii_recal": devskill(cells, "ii_recal_vs_fHrecal", allc, lab),
                    "ii_raw": devskill(cells, "ii_raw_vs_fH", allc, lab),
                    "iA_recal": devskill(cells, "iA_recal_vs_fHrecal", direct_i, lab),
                    "iA_raw": devskill(cells, "iA_raw_vs_fH", direct_i, lab)}
    res["transfer"] = {}
    for comp in ("ii_recal_vs_fHrecal", "iA_recal_vs_fHrecal", "ii_raw_vs_fH"):
        for lab in ("spot", "or1m"):
            res["transfer"][f"{comp}|{lab}"] = {c: transfer(cells[c][lab][comp]) for c in allc
                                                if lab in cells.get(c, {}) and comp in cells[c][lab]}
    cand = [c for c, v in res["spot"]["ii_recal"].items() if v["pass"]]
    arm = "ii"
    if not cand:
        cand = [c for c, v in res["spot"]["iA_recal"].items() if v["pass"]]
        arm = "iA"
    res["candidates"], res["arm"] = cand, arm
    json.dump(res, open(os.path.join(a.out, "devskill-r192.json"), "w"), indent=1, default=float)
    for lab in ("spot", "or1m"):
        for k_ in ("ii_recal", "iA_recal"):
            print(lab, k_, "DEV-SKILL:", [c for c, v in res[lab][k_].items() if v["pass"]], flush=True)
    print("candidates", arm, cand, flush=True)


# =====================================================================================================================
# power (D-R13.5c rule 1 as R16.5e, with the B20a shrink)
# =====================================================================================================================
SHAPES = {   # name: (series, months of scorable common window, note) -- listing data only, no reserved byte read
    "B23a": (6, 48, "Upbit/Bithumb KRW, first months 2020-02..2023-03; thin; owned by the R16.2e strict-GRU lane"),
    "B23a+B23b": (9, 48, "as B23a plus MOC/BIOT/MVC"),
    "P3b-b": (41, 9, "Binance 2025 listings (R13.4 hold-back); 365-day warm-up leaves <= ~9 months"),
    "P3c": (31, 0, "Binance 2026 listings (R13.4 hold-back); no scorable month after warm-up"),
    "B18 (published counts)": (11, 48, "Poloniex; 11-13 series pass the null rule (D-R16.5b); R16.5 family"),
    "B22": (17, 36, "Bitget/WhiteBIT/Crypto.com; depth unknown; R16.5 reserve"),
    "P5b": (4, 45, "Coinbase/Kraken; P5a bound had 4 eligible series; R16.1 reserve"),
}


def var_parts(d, sid, blk):
    n = len(d)
    e = d - d.mean()

    def v(g):
        _, inv = np.unique(g, return_inverse=True)
        s_ = np.bincount(inv, weights=e)
        return float((s_ ** 2).sum()) / n ** 2
    return v(sid), v(blk), v(sid.astype(np.int64) * 100000 + blk.astype(np.int64))


def power_cell(p1, p0, y, sid, ts, ft, T, S_new, B_new, C_new, alpha_m=1):
    from scipy.stats import norm
    m = y >= 0
    p1, p0, y, sid, ts, ft = p1[m], p0[m], y[m].astype(float), sid[m], ts[m], ft[m]
    blk = (ts // (28 * DAY)).astype(np.int64)
    d = (p1 - y) ** 2 - (p0 - y) ** 2
    tw = TW(sid, blk, B=B_BOOT, seed=BOOT_SEED)
    bt = tw.boot(d)
    var_b = bt["sd"] ** 2
    Vs, Vb, Vsb = var_parts(d, sid, blk)
    Vint = Vsb
    c_raw = (var_b - Vs - Vb) / Vint if Vint > 0 else 0.0
    c = max(c_raw, 0.0)          # D-R19.2a: a negative interaction estimate makes the factor fall as counts fall;
    #                              clipped at 0 (conservative: the dev factor is then (V_s + V_b) / var >= 1)
    S_dev = len(np.unique(sid[y == 1]))
    B_dev = len(np.unique(blk[y == 1]))
    C_dev = len(np.unique(sid[y == 1].astype(np.int64) * 100000 + blk[y == 1]))
    fac = (Vs * S_dev / max(S_new, 1e-9) + Vb * B_dev / max(B_new, 1e-9) + c * Vint * C_dev / max(C_new, 1e-9)) / var_b
    fac = max(fac, 1e-9)
    zdev = -bt["z"]                                   # gain-positive
    zproj = SHRINK_B20A * zdev / math.sqrt(fac)
    za = norm.ppf(1 - 0.05 / alpha_m)
    us, inv = np.unique(sid, return_inverse=True)
    tot = np.bincount(inv, weights=d)
    k = max(3, math.ceil(0.025 * len(us)))
    keep = ~np.isin(inv, np.argsort(tot)[:k])
    z_ltk = -(tw.boot(d, keep)["z"] or 0)
    _, kp = event_day_drop(ft, y.astype(int), ts, sid, T)
    z_ev = -(tw.boot(d, kp)["z"] or 0)
    sc = zproj / zdev if zdev else 0
    p_test = norm.cdf(zproj - za)
    p_ev = norm.cdf(z_ev * sc - za)
    p_ltk = norm.cdf(z_ltk * sc)
    # R band from bootstrap of ln R1
    Sc1 = np.zeros((len(tw.us), len(tw.ub)))
    Scy = np.zeros_like(Sc1)
    np.add.at(Sc1, (tw.si, tw.bi), p1)
    np.add.at(Scy, (tw.si, tw.bi), y)
    num = np.einsum("bs,sk,bk->b", tw.ws, Sc1, tw.wb)
    den = np.einsum("bs,sk,bk->b", tw.ws, Scy, tw.wb)
    lr = np.log(num[den > 0] / den[den > 0])
    lr0 = math.log(p1.sum() / y.sum())
    sdl = float(np.std(lr)) * math.sqrt(fac)
    p_R = norm.cdf((math.log(R_BAND[1]) - lr0) / sdl) - norm.cdf((math.log(R_BAND[0]) - lr0) / sdl)
    joint = min(p_test, p_ev) * p_ltk * p_R
    return {"z_dev": zdev, "factor": fac, "c": c, "c_raw": c_raw, "factor_at_dev_counts": (Vs + Vb + c * Vint) / var_b, "z_proj_shrunk": zproj, "test": p_test, "event": p_ev,
            "ltk": p_ltk, "Rband": p_R, "joint": joint, "S_dev": S_dev, "B_dev": B_dev, "C_dev": C_dev,
            "S_new": S_new, "B_new": B_new, "C_new": C_new}


def cmd_power(a):
    Z = np.load(os.path.join(a.out, "spot-forecasts.npz"))
    sc = json.load(open(os.path.join(a.out, "score-r192.json")))
    sel = json.load(open(os.path.join(a.out, "devskill-r192.json")))
    out = {"code": D.git_sha(), "rule": "D-R13.5c rule 1 (R16.5e) x B20a shrink 0.40", "shapes": SHAPES, "cells": {}}
    cand = sel["candidates"]
    for name in cand:
        T_s, k_s = name.split(" ")
        T = {v: k_ for k_, v in TL.items()}[T_s]
        c = LV_B.index(int(k_s[:-1]) / 100)
        arm = sel["arm"]
        g = lambda k_: Z[f"T{T}_{k_}"]  # noqa: E731
        y, sid, ts, ft = g("y")[:, c], g("sid"), g("ts"), g("ft")[:, c]
        p1, p0 = g(f"cal_{arm}")[:, c], g("cal_fH")[:, c]
        m = y >= 0
        n_series_dev = len(np.unique(sid[m]))
        blk = ts // (28 * DAY)
        months_dev = (ts[m].max() - ts[m].min()) / (30.44 * DAY)
        S_dev = len(np.unique(sid[m & (y == 1)]))
        B_dev = len(np.unique(blk[m & (y == 1)]))
        C_dev = len(np.unique(sid[m & (y == 1)].astype(np.int64) * 100000 + blk[m & (y == 1)]))
        pos_s_share = S_dev / n_series_dev
        posb_per_month = B_dev / months_dev
        posc_per_sm = C_dev / (n_series_dev * months_dev)
        res = {"dev": {"series": n_series_dev, "months": months_dev, "pos_series": S_dev, "pos_blocks": B_dev,
                       "pos_cells": C_dev}, "shapes": {}}
        for nm, (ns, mo, _) in SHAPES.items():
            if mo <= 0:
                res["shapes"][nm] = {"joint": 0.0, "note": "no scorable months"}
                continue
            res["shapes"][nm] = power_cell(p1, p0, y, sid, ts, ft, T, max(1, ns * pos_s_share),
                                           max(1, posb_per_month * mo), max(1, posc_per_sm * ns * mo))
        # prospective live log on the non-BTC/ETH development series: months to joint 0.80
        live = {}
        for mo in (6, 12, 24, 36, 60, 120, 240):
            ns = n_series_dev - 3
            live[str(mo)] = power_cell(p1, p0, y, sid, ts, ft, T, ns * pos_s_share, posb_per_month * mo,
                                       posc_per_sm * ns * mo)["joint"]
        res["live_months_joint"] = live
        out["cells"][name] = res
        print(now(), name, json.dumps({k_: round(v["joint"], 3) for k_, v in res["shapes"].items()}),
              "live", json.dumps({k_: round(v, 3) for k_, v in live.items()}), flush=True)
    json.dump(out, open(os.path.join(a.out, "power-r192.json"), "w"), indent=1, default=float)


# =====================================================================================================================
# known-answer checks
# =====================================================================================================================
def cmd_synth(a):
    """the r16_nn_strict.cmd_synth world at the borrower grid (levels -5..-30%, T 6 h..7 d), Monte Carlo truth with
    200,000 paths per grid point (deep levels are rare), rule D 5-net ensembles (r162e_cd.cmd_synth). NULL pass:
    two-way z > -1.96 (amended per D-R16.2e-g); POSITIVE pass: z <= -1.96 and BSS > 0."""
    import inspect
    src = inspect.getsource(S.cmd_synth)
    assert src.count("npath = 40000") == 1
    src = src.replace("npath = 40000", "npath = 200000")
    exec(compile(src, "r16_nn_strict_synth_r192", "exec"), S.__dict__)      # redefines S.cmd_synth in S's namespace
    NN.TIER_LV["shallow"] = LV_B
    D.TIERS["shallow"] = TS_B
    for T in TS_B:
        D.LV[T] = LV_B
    CD.cmd_synth(a)
    fn = os.path.join(a.out, "synth-r162e-ens5-D.json")
    j = json.load(open(fn))
    j["r192"] = {"levels": LV_B, "Ts": TS_B, "npath": 200000,
                 "pass_amended": {"NULL": bool(j["arms"]["NULL"]["tw_gru_vs_base"]["z"] > -1.96),
                                  "POSITIVE": bool(j["arms"]["POSITIVE"]["tw_gru_vs_base"]["z"] <= -1.96
                                                   and j["arms"]["POSITIVE"]["bss_gru_vs_base"] > 0)}}
    json.dump(j, open(os.path.join(a.out, "synth-r192.json"), "w"), indent=1, default=float)
    os.remove(fn)
    print("synth r192", j["r192"], flush=True)


def cmd_kat(a):
    """scorer known-answer at rare events: exact identities, size under an exchangeable null with a shared block
    shock, power under a true gain, leave-top-k and event-day drop remove exactly the intended rows."""
    rng = np.random.default_rng(BOOT_SEED)
    S_, days = 120, 2000
    res = {"null_rejections": 0, "gain_rejections": 0, "reps": 40}
    for rep in range(40):
        sid = np.repeat(np.arange(S_), days)
        ts = np.tile(np.arange(days) * DAY, S_) + 1546300800
        blk = ts // (28 * DAY)
        shock = rng.normal(0, 1.0, days)[(ts - 1546300800) // DAY]
        lp = np.log(0.004) + 0.8 * shock + rng.normal(0, 0.3, len(ts))
        p = np.clip(np.exp(lp), 0, 0.5)
        y = (rng.random(len(ts)) < p).astype(int)
        # null: two equally noisy forecasts; gain: truth vs a 1.6x over-forecast
        q1 = np.clip(p * np.exp(rng.normal(0, 0.2, len(p))), 0, 1)
        q0 = np.clip(p * np.exp(rng.normal(0, 0.2, len(p))), 0, 1)
        tw = TW(sid, blk, B=500, seed=rep)
        bn = tw.boot((q1 - y) ** 2 - (q0 - y) ** 2)
        bg = tw.boot((p - y) ** 2 - (np.clip(1.6 * p, 0, 1) - y) ** 2)
        res["null_rejections"] += int(bn["p_centred"] <= 0.05 and bn["p_pct"] <= 0.05)
        res["gain_rejections"] += int(bg["p_centred"] <= 0.05 and bg["p_pct"] <= 0.05)
        if rep == 0:
            d = (p - y) ** 2 - (np.clip(1.6 * p, 0, 1) - y) ** 2
            e1, e0 = (p - y) ** 2, (np.clip(1.6 * p, 0, 1) - y) ** 2
            res["identity_bss"] = float(abs((1 - e1.sum() / e0.sum()) - (-d.sum() / e0.sum())))
            lk = D.leave_top_k(sid, d)
            us, inv = np.unique(sid, return_inverse=True)
            tot = np.bincount(inv, weights=d)
            top = np.argsort(tot)[:lk["k"]]
            res["ltk_rows_dropped_ok"] = bool((~np.isin(inv, top)).sum() == len(d) - days * lk["k"])
            ft = np.where(y == 1, rng.integers(0, 24, len(y)), -1)
            y2, ft2 = y.copy(), ft.copy()
            inj = np.flatnonzero(((ts - 1546300800) // DAY == 500) & (sid < 30))     # a planted market-wide day
            y2[inj], ft2[inj] = 1, 3
            day, kp = event_day_drop(ft2, y2, ts, sid, 24)
            res["event_day_planted_found"] = bool(day == (1546300800 // DAY) + 500)
            t0 = day * DAY
            res["event_day"] = day
            res["event_drop_ok"] = bool(((ts < t0 + DAY) & (ts + 24 * STEP > t0) == ~kp).all())
    # 1 m geometric-mean label: a step 100 -> 80 at minute 330 crosses 90 when >= 29 of the 60 minutes are at 80
    tt = 1546300800 + 60 * np.arange(600)
    cc = np.where(np.arange(600) >= 330, 80.0, 100.0)
    _, gmin_, _, Gm = g_summary(tt, cc)
    first = int(np.argmax(Gm <= 90.0))
    res["step_first_cross_minute"] = first
    res["step_ok"] = bool(first == 358)               # 358 - 330 + 1 = 29 bars at 80
    res["size"] = res["null_rejections"] / 40
    res["power"] = res["gain_rejections"] / 40
    res["pass"] = bool(res["size"] <= 0.15 and res["power"] >= 0.8 and res["identity_bss"] < 1e-12
                       and res["ltk_rows_dropped_ok"] and res["event_drop_ok"] and res["event_day_planted_found"]
                       and res["step_ok"])
    json.dump(res, open(os.path.join(a.out, "kat-r192.json"), "w"), indent=1, default=float)
    print("KAT", json.dumps(res), flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("rows")
    s.add_argument("--datasets", required=True)
    s.add_argument("--rowsmeta", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    s.add_argument("--limit", type=int, default=0)
    s = sub.add_parser("check")
    s.add_argument("--r16", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("lookahead")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("acq1m")
    s.add_argument("--out", required=True)
    s.add_argument("--syms", default="")
    s.add_argument("--workers", type=int, default=4)
    s = sub.add_parser("olabels")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s = sub.add_parser("armi")
    s.add_argument("--datasets", required=True)
    s.add_argument("--r16", required=True)
    s.add_argument("--ref", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--ks", required=True)
    s.add_argument("--threads", type=int, default=1)
    s = sub.add_parser("armii")
    s.add_argument("--datasets", required=True)
    s.add_argument("--rowsmeta", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--ks", required=True)
    s.add_argument("--threads", type=int, default=1)
    s = sub.add_parser("score")
    s.add_argument("--out", required=True)
    s = sub.add_parser("synth")
    s.add_argument("--out", required=True)
    s.add_argument("--rule", default="D")
    s.add_argument("--threads", type=int, default=1)
    s = sub.add_parser("kat")
    s.add_argument("--out", required=True)
    s = sub.add_parser("power")
    s.add_argument("--out", required=True)
    s = sub.add_parser("verdict")
    s.add_argument("--out", required=True)
    a = ap.parse_args()
    {"rows": cmd_rows, "check": cmd_check, "lookahead": cmd_lookahead, "acq1m": cmd_acq1m, "olabels": cmd_olabels,
     "armi": cmd_armi, "armii": cmd_armii, "score": cmd_score, "synth": cmd_synth, "kat": cmd_kat,
     "power": cmd_power, "verdict": cmd_verdict}[a.cmd](a)


if __name__ == "__main__":
    main()
