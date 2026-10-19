"""Q26 R16.2 development: zero-shot time-series foundation model (Chronos-Bolt-tiny, amazon/chronos-bolt-tiny, free
Apache-2.0 weights from the Hugging Face hub) as a volatility input to FHS. DEVELOPMENT ONLY (seen data).

Recorded in membrane-board design/Q26_ROUND16_PREREG.md D-R16.2a. Menu fixed here before any output:
  input   the daily series of ln(24 h annualized Parkinson variance) sampled at UTC-midnight origins (A6 HAR "D"
          component, as-of: it uses only bars before the origin); context = last 256 days; zero-shot, no fine-tune
  output  median forecast of the next 30 daily values; for an hourly origin i the forecast of the last midnight m <= i
          is used; sigma_cb(T) = sqrt(mean over days 1..ceil((T + h_since_midnight)/24) of exp(q50))
  models  cb   FHS with the OLS-calibrated scale [1, ln sigma_cb(T)]
          cbH  FHS with the HAR design plus ln sigma_cb(T)   (arXiv 2607.05291: pair a TSFM with log-HAR)
Rows use exactly the r16_dev row filter (the same fH/f keep rule), so they merge by (series key, ts).
Sampling Chronos price PATHS to the touch is not attempted: Chronos-Bolt returns quantiles, not paths, and per-origin
sampling of hourly paths with the original Chronos is far beyond the CPU budget (stated in D-R16.2a).

  python3 r16_cb.py forecast --datasets DS --out OUT [--threads 2]
  python3 r16_cb.py rows     --datasets DS --out OUT [--workers 3]
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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a2_touch as M2  # noqa: E402
import a6_touch as A6  # noqa: E402
import r12_tail as R12  # noqa: E402
import r16_dev as D  # noqa: E402

MODEL = "amazon/chronos-bolt-tiny"
CTX, H = 256, 30
STEP, DAY = 3600, 86400


def safe(k):
    return k.replace(":", "_").replace("/", "_").replace("#", "_")


def daily_series(spec):
    ser, folds, caps = R12.load_series(spec)
    N1 = len(ser.close) + 1
    with np.errstate(invalid="ignore", divide="ignore"):
        lnD = np.log(A6.har_of(ser)[:, 0])
    ts = ser.base_ts + STEP * np.arange(N1)
    mid = np.where(ts % DAY == 0)[0]
    return ser, mid, lnD[mid]


def cmd_forecast(a):
    import torch
    from chronos import BaseChronosPipeline
    torch.set_num_threads(a.threads)
    os.makedirs(os.path.join(a.out, "cb"), exist_ok=True)
    pipe = BaseChronosPipeline.from_pretrained(MODEL, device_map="cpu", torch_dtype=torch.float32)
    specs = R12.dev_specs(a.datasets)
    for sp in specs:
        if sp["kind"] == "chain":
            R12.load_series(sp)
            break
    t0 = time.time()
    buf, owners = [], []

    def flush():
        if not buf:
            return
        x = torch.tensor(np.stack(buf), dtype=torch.float32)
        q, _ = pipe.predict_quantiles(x, prediction_length=H, quantile_levels=[0.5])
        q = q[:, :, 0].numpy().astype(np.float32)
        for (store, j), row in zip(owners, q):
            store[j] = row
        buf.clear()
        owners.clear()
    pending = []
    for n_, sp in enumerate(specs):
        fp = os.path.join(a.out, "cb", safe(sp["key"]) + ".npz")
        if os.path.exists(fp):
            continue
        ser, mid, y = daily_series(sp)
        store = np.full((len(mid), H), np.nan, np.float32)
        for j in range(len(mid)):
            ctx = y[max(0, j - CTX + 1):j + 1]
            if np.isfinite(ctx).sum() < 30:
                continue
            if len(ctx) < CTX:
                ctx = np.concatenate([np.full(CTX - len(ctx), np.nan), ctx])
            buf.append(ctx)
            owners.append((store, j))
            if len(buf) >= 512:
                flush()
        pending.append((fp, mid, store))
        if len(pending) >= 8 or n_ == len(specs) - 1:
            flush()
            for fp_, mid_, st_ in pending:
                np.savez_compressed(fp_, mid=mid_, q50=st_)
            pending.clear()
            print(f"{R12.now_iso()} forecast {n_ + 1}/{len(specs)} ({time.time() - t0:.0f}s)", flush=True)
    flush()
    for fp_, mid_, st_ in pending:
        np.savez_compressed(fp_, mid=mid_, q50=st_)
    json.dump({"model": MODEL, "ctx": CTX, "H": H, "finished_utc": R12.now_iso(), "code": D.git_sha()},
              open(os.path.join(a.out, "cb", "meta.json"), "w"))


_OUT = {}


def lscb_of(fp, N1, base_ts, T):
    z = np.load(fp)
    mid, q = z["mid"], z["q50"]
    out = np.full(N1, np.nan)
    ts = base_ts + STEP * np.arange(N1)
    # last midnight index <= i
    pos = np.searchsorted(mid, np.arange(N1), side="right") - 1
    ok = pos >= 0
    hs = ((ts % DAY) // STEP).astype(int)
    nd = np.minimum(np.ceil((T + hs) / 24.0).astype(int), H)
    v = np.exp(q.astype(float))
    cs = np.concatenate([np.zeros((len(mid), 1)), np.cumsum(v, axis=1)], axis=1)
    ii = np.where(ok)[0]
    m = cs[pos[ii], nd[ii]] / nd[ii]
    with np.errstate(invalid="ignore", divide="ignore"):
        out[ii] = 0.5 * np.log(m)
    out[~np.isfinite(out)] = np.nan
    return out


def task_cb(spec):
    t0 = time.time()
    ser, folds, caps = R12.load_series(spec)
    N1 = len(ser.close) + 1
    fold_q = [f for f in folds if f["qs_i"] < N1]
    ts_all = ser.base_ts + STEP * np.arange(N1)
    fp = os.path.join(_OUT["dir"], "cb", safe(spec["key"]) + ".npz")
    rows = {}
    for T in D.TS:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        P, n = P6.P, P6.n
        lnk = np.log1p(np.array(D.LV[T]))
        i_all = np.arange(n)
        lcb = lscb_of(fp, N1, ser.base_ts, T)
        Xc = np.column_stack([np.ones(N1), lcb])
        okc = np.all(np.isfinite(Xc), axis=1)
        XcH = np.column_stack([P6.X, lcb[:len(P6.X)]])
        okcH = np.all(np.isfinite(XcH), axis=1)
        out = {k: [] for k in ("ts", "q2", "tail", "fH", "cb", "cbH")}
        st = D.ORIGIN_STEP[T]
        for f in fold_q:
            qs, qe = f["qs_i"], min(f["qe_i"], n)
            lim = qs - T
            if lim <= 0:
                continue
            tr = i_all <= lim
            tri = i_all[tr]
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
            res = {}
            for nm, X, okX in (("cb", Xc, okc), ("cbH", XcH, okcH)):
                c = D.ols_scale(X, okX, P6.lfut, P6.okH, tri)
                p_, _, _ = D.fhs_from_sigma(P, D.sig_from(X, okX, c), tr, te, lnk)
                bad = ~np.all(np.isfinite(p_), axis=1)
                p_[bad] = pH[bad]
                res[nm] = p_
            ts = ts_all[te]
            out["ts"].append(ts)
            out["q2"].append((ts + T * STEP > R12.Q2_START) & (ts < R12.Q2_END))
            out["tail"].append(ts + T * STEP > caps["primary"])
            out["fH"].append(np.minimum.accumulate(pH, axis=1).astype(np.float32))
            for nm in ("cb", "cbH"):
                out[nm].append(np.minimum.accumulate(res[nm], axis=1).astype(np.float32))
        if out["ts"]:
            R = {k: np.concatenate(v) for k, v in out.items()}
            m = ~R["q2"] & ~R["tail"]
            rows[T] = {k: v[m] for k, v in R.items() if k not in ("q2", "tail")}
    return {"key": spec["key"], "rows": rows, "sec": time.time() - t0}


def cmd_rows(a):
    _OUT["dir"] = a.out
    specs = R12.dev_specs(a.datasets)
    for sp in specs:
        if sp["kind"] == "chain":
            R12.load_series(sp)
            break
    meta = json.load(open(os.path.join(a.out, "rows-meta.json")))
    sid_of = {k: j for j, k in enumerate(meta["series"])}
    specs = [s for s in specs if s["key"] in sid_of]
    acc = {T: [] for T in D.TS}
    t0 = time.time()
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=8) as pool:
        for j, r in enumerate(pool.imap_unordered(task_cb, specs, chunksize=1)):
            for T, R in r["rows"].items():
                R["sid"] = np.full(len(R["ts"]), sid_of[r["key"]], np.int32)
                acc[T].append(R)
            if (j + 1) % 20 == 0:
                print(f"{R12.now_iso()} cb rows {j + 1}/{len(specs)} ({time.time() - t0:.0f}s)", flush=True)
    for T in D.TS:
        if acc[T]:
            R = {k: np.concatenate([x[k] for x in acc[T]]) for k in acc[T][0]}
            np.savez_compressed(os.path.join(a.out, f"rows-cb-T{T}.npz"), **R)
            print(f"wrote cb T{T}: {len(R['ts'])}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("forecast")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--threads", type=int, default=2)
    s = sub.add_parser("rows")
    s.add_argument("--datasets", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    {"forecast": cmd_forecast, "rows": cmd_rows}[a.cmd](a)


if __name__ == "__main__":
    main()
