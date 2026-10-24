"""Q26 R20: granular volatility input for raw (fH) and a counts-only data-lever audit. DEVELOPMENT ONLY (seen data).

Design, arms, measures and rules: membrane-board design/q26-r20-granular-vol-2026-10-24.md (registered at board
45e4fea before any score of this script).

Arms (HAR design of A6.Prep6; everything else is the unchanged r192_borrower.task):
  P     1, ln Park_D, ln Park_W, ln Park_M                (raw (fH))
  RV5   1, ln RV5_D, ln RV5_W, ln RV5_M                   (hourly sums of squared 5-minute log returns, Binance 1 m)
  RV5S  1, ln RS-_D, ln RS+_D, ln RV5_W, ln RV5_M         (daily negative / positive 5-minute semivariance)

  python3 r20_rv.py acq      --out OUT [--workers 2] [--syms ETHUSDT,...]   (1 m klines -> hourly RV5 / RS- / RS+)
  python3 r20_rv.py rows     --datasets DS --out OUT [--workers 2]          (daily rows per arm on the Binance grids)
  python3 r20_rv.py check    --datasets DS --out OUT                        (P rows vs R19.5 input I; RV5 hand check)
  python3 r20_rv.py score    --datasets DS --out OUT                        (sigma diagnostics, cells, verdict)
  python3 r20_rv.py nlrows   --datasets DS --out OUT                        (dense-ladder rows on the D13 III grids)
  python3 r20_rv.py nearline --datasets DS --out OUT --r111 SCR             (unchanged r111v5 report per arm)
  python3 r20_rv.py counts   --datasets DS --out OUT                        (lever B: episodes and two-way N_eff)
No address, key or secret is read or written. Nothing here is blind evidence and nothing ships from it.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import datetime as dt  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import multiprocessing as mp  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "live"))

STEP, DAY = 3600, 86400
ANNUAL = 8760.0
TS_B = (6, 12, 24, 72, 168)
TL = {6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d"}
L8 = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.30)
LV = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20)
JL = [L8.index(k) for k in LV]
JR = [L8.index(k) for k in (-0.05, -0.07, -0.10, -0.15, -0.20)]      # tau_R pooled levels
ARMS = ("P", "RV5", "RV5S")
B_BOOT, SEED = 1000, 20262000
SPAN2021 = 1609459200
MIN_RET_PER_HOUR = 10
R195_DIR = "history-forecasts/r19/r195-inputs-f4056460"
D13_DIR = "history-forecasts/r19/d13-inputs-93d337c9"
DISK_STOP = 1.5e9


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_sha():
    try:
        return subprocess.check_output(["git", "-C", HERE, "rev-parse", "--short=8", "HEAD"], text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def universe():
    return json.load(open(os.path.join(HERE, "live", "d12_universe.json")))["series"]


def free_disk():
    return shutil.disk_usage("/").free


# =====================================================================================================================
# acq: Binance 1 m closes -> hourly 5-minute realized variance and semivariances
# =====================================================================================================================
def get(url, tries=6, timeout=120):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={"user-agent": "curl/8.5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            time.sleep(2 + 4 * t)
        except Exception:  # noqa: BLE001
            time.sleep(2 + 4 * t)
    raise RuntimeError(url)


def parse_zip(raw):
    """-> minute open times (s), closes. Microsecond stamps (Binance 2025+) are converted."""
    import pandas as pd
    z = zipfile.ZipFile(io.BytesIO(raw))
    with z.open(z.namelist()[0]) as f:
        df = pd.read_csv(f, header=None, usecols=[0, 4], dtype=str)
    df = df.apply(pd.to_numeric, errors="coerce").dropna()
    ot = df.iloc[:, 0].to_numpy(float)
    ot = np.where(ot > 1e14, ot / 1000.0, ot)
    return (ot // 1000).astype(np.int64), df.iloc[:, 1].to_numpy(float)


def hourly_rv5(t, c):
    """minute open times t (s, sorted unique), closes c -> hour_ts, rv, rsn, rsp, cnt (registered 5-minute rule)."""
    slot = t // 300
    last = (t % 300) == 240                       # the minute opening at slot start + 4 min closes the slot
    s_id, s_c = slot[last], c[last]
    s0 = int(s_id.min())
    ns = int(s_id.max() - s0 + 1)
    lc = np.full(ns, np.nan)
    lc[s_id - s0] = np.log(s_c)
    r = np.full(ns, np.nan)
    r[1:] = lc[1:] - lc[:-1]                      # r[s] = ln close_s - ln close_{s-1}, assigned to slot s's hour
    h0 = (s0 * 300) // STEP
    off = s0 - h0 * 12                            # slots of hour h0 before the first slot close (0..11)
    r = np.concatenate([np.full(off, np.nan), r])  # array index 0 = first slot of hour h0
    nh = int(math.ceil(len(r) / 12))
    r = np.concatenate([r, np.full(nh * 12 - len(r), np.nan)]).reshape(nh, 12)
    ok = np.isfinite(r)
    cnt = ok.sum(1)
    r0 = np.where(ok, r, 0.0)
    sc = np.where(cnt >= MIN_RET_PER_HOUR, 12.0 / np.maximum(cnt, 1), np.nan)
    rv = (r0 ** 2).sum(1) * sc
    rsn = (np.where(r0 < 0, r0, 0.0) ** 2).sum(1) * sc
    rsp = (np.where(r0 > 0, r0, 0.0) ** 2).sum(1) * sc
    hts = (h0 + np.arange(nh)) * STEP
    return hts.astype(np.int64), rv, rsn, rsp, cnt.astype(np.int8)


def acq_sym(args):
    sym, out = args
    fn = os.path.join(out, "rv5", f"rv5-{sym}.npz")
    if os.path.exists(fn):
        return sym, "exists"
    if free_disk() < DISK_STOP:
        return sym, f"STOP free disk {free_disk() / 1e9:.2f} GB"
    tl, cl, shas = [], [], {}
    urls = []
    for y in range(2017, 2027):
        for m in range(1, 13):
            if (y, m) > (2026, 9):
                break
            urls.append((f"{y:04d}-{m:02d}",
                         f"https://data.binance.vision/data/spot/monthly/klines/{sym}/1m/{sym}-1m-{y:04d}-{m:02d}.zip"))
    for d in range(1, 7):
        urls.append((f"2026-10-{d:02d}",
                     f"https://data.binance.vision/data/spot/daily/klines/{sym}/1m/{sym}-1m-2026-10-{d:02d}.zip"))
    for tag, url in urls:
        raw = get(url)
        if raw is None:
            continue
        shas[tag] = hashlib.sha256(raw).hexdigest()
        t, c = parse_zip(raw)
        del raw
        tl.append(t)
        cl.append(c)
    if not tl:
        return sym, "none"
    t = np.concatenate(tl)
    c = np.concatenate(cl)
    del tl, cl
    o = np.argsort(t, kind="mergesort")
    t, c = t[o], c[o]
    keep = np.r_[True, np.diff(t) > 0] & (c > 0) & np.isfinite(c) & (t % 60 == 0)
    t, c = t[keep], c[keep]
    hts, rv, rsn, rsp, cnt = hourly_rv5(t, c)
    # hand-check samples: 5 seeded valid hours with their raw minute closes (61 minutes ending at the hour end)
    rng = np.random.default_rng(np.random.SeedSequence([SEED, int(hashlib.sha256(sym.encode()).hexdigest()[:8], 16)]))
    cand = np.flatnonzero(np.isfinite(rv) & (cnt == 12))
    samp = []
    for j in rng.choice(cand, size=min(5, len(cand)), replace=False):
        h = int(hts[j])
        m = (t >= h - 300) & (t < h + STEP)
        samp.append({"hour_open": h, "minute_open": t[m].tolist(), "close": c[m].tolist(), "rv": float(rv[j]),
                     "rsn": float(rsn[j]), "rsp": float(rsp[j])})
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    np.savez_compressed(fn, hour_ts=hts, rv=rv, rsn=rsn, rsp=rsp, cnt=cnt)
    json.dump({"sym": sym, "files": shas, "minutes": int(len(t)), "first_minute": int(t[0]), "last_minute": int(t[-1]),
               "hours": int(len(hts)), "valid_hours": int(np.isfinite(rv).sum()), "samples": samp},
              open(os.path.join(out, "rv5", f"rv5-{sym}-meta.json"), "w"))
    return sym, f"{len(shas)} files, {len(hts)} hours, valid {int(np.isfinite(rv).sum())}"


def cmd_acq(a):
    syms = [e["symbol"] for e in universe()] if not a.syms else a.syms.split(",")
    print(now(), "acq", syms, "free GB", round(free_disk() / 1e9, 2), flush=True)
    with mp.get_context("fork").Pool(a.workers) as pool:
        for s_, msg in pool.imap_unordered(acq_sym, [(s, a.out) for s in syms]):
            print(now(), s_, msg, "free GB", round(free_disk() / 1e9, 2), flush=True)


# =====================================================================================================================
# HAR swap
# =====================================================================================================================
_RV = {}
_LAST_SER = {}


def load_rv(out, sym):
    if sym not in _RV:
        Z = np.load(os.path.join(out, "rv5", f"rv5-{sym}.npz"))
        _RV[sym] = {k: Z[k] for k in Z.files}
    return _RV[sym]


def on_grid(ser, sym, out, col):
    d = load_rv(out, sym)
    n = ser.N
    v = np.full(n, np.nan)
    j = (d["hour_ts"] - ser.base_ts) // STEP
    m = (j >= 0) & (j < n)
    v[j[m]] = d[col][m]
    v[:ser.start_i] = np.nan
    return v


def har_variant(arm, sym, out):
    import a6_touch as A6

    def comps(ser):
        def wm(v):
            c = ANNUAL * A6.window_mean_null_rule(v, 24, ser.start_i), \
                ANNUAL * A6.window_mean_null_rule(v, 168, ser.start_i), \
                ANNUAL * A6.window_mean_null_rule(v, 720, ser.start_i)
            return c
        rv = on_grid(ser, sym, out, "rv")
        D_, W_, M_ = wm(rv)
        if arm == "RV5":
            C = np.column_stack([D_, W_, M_])
        elif arm == "RV5S":
            n_ = ANNUAL * A6.window_mean_null_rule(on_grid(ser, sym, out, "rsn"), 24, ser.start_i)
            p_ = ANNUAL * A6.window_mean_null_rule(on_grid(ser, sym, out, "rsp"), 24, ser.start_i)
            # a null daily RV5 voids both semivariance terms (same null rule)
            n_[~np.isfinite(D_)] = np.nan
            p_[~np.isfinite(D_)] = np.nan
            C = np.column_stack([n_, p_, W_, M_])
        else:
            raise ValueError(arm)
        C[~(C > 0)] = np.nan
        return C

    def har_of(ser):
        _LAST_SER["ser"] = ser
        if getattr(ser, "_har", None) is None:
            ser._har = comps(ser)
        return ser._har
    return har_of


def park_of_factory():
    import a6_touch as A6
    orig = A6.har_of

    def har_of(ser):
        _LAST_SER["ser"] = ser
        return orig(ser)
    return har_of, orig


def run_arm(spec, arm, out, levels=None):
    """r192_borrower.task with the arm's HAR; -> {T: daily rows incl. ln sigma_H, ln sigma_fut, vol state}."""
    import a6_touch as A6
    import r192_borrower as B
    orig = A6.har_of
    origL8 = B.L8
    try:
        if arm == "P":
            A6.har_of, _ = park_of_factory()
        else:
            A6.har_of = har_variant(arm, spec["sym"], out)
        if levels is not None:
            B.L8 = levels
        sp = {k: v for k, v in spec.items() if k in ("key", "kind", "path", "asset", "datasets")}
        r = B.task(sp)
        ser = _LAST_SER["ser"]
    finally:
        A6.har_of = orig
        B.L8 = origL8
    pv = A6.parkinson_v(ser.high, ser.low)
    pD = A6.window_mean_null_rule(pv, 24, ser.start_i)
    pY = A6.window_mean_null_rule(pv, 8760, ser.start_i)
    with np.errstate(invalid="ignore", divide="ignore"):
        vs_all = 0.5 * np.log(pD / pY)
    res = {}
    for T, R in r["rows"].items():
        m = R["ts"] % DAY == 0
        i = np.asarray(R["i"])[m]
        sf = A6.sigma_fut(ser.close, T, ser.start_i)
        with np.errstate(invalid="ignore", divide="ignore"):
            lsf = np.log(sf[i])
        res[T] = {"ts": np.asarray(R["ts"])[m], "y": np.asarray(R["y"])[m], "a": np.asarray(R["a"])[m],
                  "fH": np.asarray(R["fH"])[m], "lsH": np.asarray(R["lsH"])[m].astype(np.float64),
                  "lsfut": lsf, "vs": vs_all[i]}
    return res


def _rows_job(args):
    spec, arm, out = args
    t0 = time.time()
    return spec["sym"], arm, run_arm(spec, arm, out), time.time() - t0


def cmd_rows(a):
    import r16_dev as RD
    RD.init_btc(a.datasets)
    jobs = []
    for e in universe():
        spec = {"key": e["key"], "kind": "grid", "path": os.path.join(a.datasets, e["path"]), "sym": e["symbol"]}
        for arm in ARMS:
            jobs.append((spec, arm, a.out))
    print(now(), f"START r20 rows; code {git_sha()}; jobs {len(jobs)}", flush=True)
    arr = {}
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=3) as pool:
        for j, (sym, arm, res, sec) in enumerate(pool.imap_unordered(_rows_job, jobs, chunksize=1)):
            for T, R in res.items():
                for c, v in R.items():
                    arr[f"{arm}|{sym}|{T}|{c}"] = v
            print(now(), f"  {j + 1}/{len(jobs)} {sym} {arm} {sec:.0f}s", flush=True)
    np.savez_compressed(os.path.join(a.out, "rows-r20.npz"), **arr)
    json.dump({"code": git_sha(), "finished_utc": now(), "jobs": len(jobs)},
              open(os.path.join(a.out, "rows-r20-meta.json"), "w"), indent=1)


def load_rows(out, name="rows-r20.npz"):
    Z = np.load(os.path.join(out, name))
    R = {}
    for k in Z.files:
        arm, sym, T, c = k.split("|")
        R.setdefault((arm, sym, int(T)), {})[c] = Z[k]
    return R


# =====================================================================================================================
# check
# =====================================================================================================================
def cmd_check(a):
    R = load_rows(a.out)
    Z = np.load(os.path.join(a.datasets, R195_DIR, "rows-r195.npz"))
    out = {"code": git_sha(), "p_vs_r195_I": {}, "rv5_hand": {}, "support": {}}
    worst = 0.0
    for e in universe():
        sym = e["symbol"]
        for T in TS_B:
            P = R[("P", sym, T)]
            ts1 = Z[f"I|{sym}|{T}|ts"]
            f1 = Z[f"I|{sym}|{T}|fH"]
            y1 = Z[f"I|{sym}|{T}|y"]
            com, i0, i1 = np.intersect1d(P["ts"], ts1, return_indices=True)
            d = float(np.nanmax(np.abs(P["fH"][i0].astype(np.float64) - f1[i1].astype(np.float64)))) if len(com) else None
            yeq = bool((P["y"][i0] == y1[i1]).all()) if len(com) else None
            worst = max(worst, d or 0.0)
            out["p_vs_r195_I"][f"{sym}|{T}"] = {"rows_r20": int(len(P["ts"])), "rows_r195": int(len(ts1)),
                                                "common": int(len(com)), "max_abs_fH_diff": d, "labels_equal": yeq}
            fin = {arm: np.isfinite(R[(arm, sym, T)]["lsH"]) for arm in ARMS}
            out["support"][f"{sym}|{T}"] = {arm: int(fin[arm].sum()) for arm in ARMS}
    out["p_vs_r195_I_worst"] = worst
    # RV5 hand check from the stored raw minute samples
    for e in universe():
        sym = e["symbol"]
        meta = json.load(open(os.path.join(a.out, "rv5", f"rv5-{sym}-meta.json")))
        errs = []
        for s_ in meta["samples"]:
            t = np.array(s_["minute_open"])
            c = np.array(s_["close"])
            h = s_["hour_open"]
            closes = []
            for k in range(-1, 12):
                m = t == h + 300 * k + 240
                closes.append(float(c[m][0]) if m.any() else np.nan)
            r = np.diff(np.log(closes))
            errs.append(abs(np.nansum(r ** 2) - s_["rv"]) / s_["rv"])
            errs.append(abs(np.nansum(np.minimum(r, 0) ** 2) - s_["rsn"]) / max(s_["rsn"], 1e-30))
        out["rv5_hand"][sym] = float(max(errs))
    json.dump(out, open(os.path.join(a.out, "checks-r20.json"), "w"), indent=1)
    print(json.dumps({"p_vs_r195_I_worst": worst, "rv5_hand_worst": max(out["rv5_hand"].values()),
                      "labels_equal_all": all(v["labels_equal"] for v in out["p_vs_r195_I"].values()
                                              if v["labels_equal"] is not None)}))


# =====================================================================================================================
# score
# =====================================================================================================================
def dl_tau(m, v):
    """DerSimonian-Laird between-group s.d. of estimates m with within variances v."""
    m, v = np.asarray(m, float), np.asarray(v, float)
    ok = np.isfinite(m) & np.isfinite(v) & (v > 0)
    m, v = m[ok], v[ok]
    k = len(m)
    if k < 2:
        return float("nan")
    w = 1 / v
    mu = (w * m).sum() / w.sum()
    Q = (w * (m - mu) ** 2).sum()
    c = w.sum() - (w ** 2).sum() / w.sum()
    return float(math.sqrt(max(0.0, (Q - (k - 1)) / c)))


def cgm_z(d, sid, blk):
    """mean(d) / two-way CGM SE (series, block; minus intersection)."""
    n = len(d)
    mu = d.mean()
    u = d - mu

    def v(g):
        _, gi = np.unique(g, return_inverse=True)
        s = np.bincount(gi, u)
        return (s ** 2).sum() / n ** 2
    inter = sid.astype(np.int64) * (int(blk.max()) + 1) + blk
    V = v(sid) + v(blk) - v(inter)
    if len(np.unique(sid)) < 3:
        V = v(blk)
    return float(mu / math.sqrt(V)) if V > 0 else float("nan")


def boot_z(d, Wset):
    pi, P, W = Wset
    sd_ = np.bincount(pi, d, P)
    sn = np.bincount(pi, np.ones(len(d)), P)
    draws = (W @ sd_) / (W @ sn)
    return float(d.mean() / draws.std(ddof=1)) if draws.std() > 0 else float("nan")


def join_arms(R, sym, T, tmin, R195):
    keys = None
    for arm in ARMS:
        if (arm, sym, T) not in R:
            return None
        s = set(R[(arm, sym, T)]["ts"].tolist())
        keys = s if keys is None else keys & s
    ts = np.array(sorted(keys), np.int64)
    ts = ts[ts >= tmin]

    def pick(arm, c):
        d = R[(arm, sym, T)]
        ix = np.searchsorted(d["ts"], ts)
        return d[c][ix]
    lsH = {arm: pick(arm, "lsH") for arm in ARMS}
    ok = np.ones(len(ts), bool)
    for arm in ARMS:
        ok &= np.isfinite(lsH[arm])
    n_all = len(ts)
    out = {"n_before_support": int(n_all)}
    p = {arm: pick(arm, "fH").astype(np.float64) for arm in ARMS}
    y = pick("P", "y")
    for arm in ARMS:
        ok &= np.isfinite(p[arm]).all(axis=1)
    ok &= (y >= 0).all(axis=1)
    # target (b): R19.5 input III label at the same (sym, T, ts)
    tb = R195[f"III|{sym}|{T}|ts"]
    yb_all = R195[f"III|{sym}|{T}|y"]
    ix = np.searchsorted(tb, ts)
    ixc = np.clip(ix, 0, len(tb) - 1)
    hasb = (tb[ixc] == ts)
    yb = np.where(hasb[:, None], yb_all[ixc], -1).astype(np.int8)
    out.update({"ts": ts[ok], "p": {a_: v[ok] for a_, v in p.items()}, "y": y[ok], "a": pick("P", "a")[ok].astype(np.float64),
                "yb": yb[ok], "lsH": {a_: v[ok] for a_, v in lsH.items()}, "lsfut": pick("P", "lsfut")[ok],
                "vs": pick("P", "vs")[ok], "n_support": int(ok.sum())})
    return out


def cmd_score(a):
    import r193_regrade as G
    R = load_rows(a.out)
    R195 = dict(np.load(os.path.join(a.datasets, R195_DIR, "rows-r195.npz")))
    U = universe()
    groups = {"ETHBTC": [e["symbol"] for e in U if e["symbol"] in ("ETHUSDT", "BTCUSDT")],
              "LARGE": [e["symbol"] for e in U if e["symbol"] not in ("ETHUSDT", "BTCUSDT")]}
    res = {"code": git_sha(), "started_utc": now(), "spans": {}}
    for span, smin in (("full", 0), ("2021", SPAN2021)):
        S = {"sigma": {}, "cells": {}, "pooled": {}, "support": {}}
        for g, syms in groups.items():
            time_only = g == "ETHBTC"
            for T in TS_B:
                parts = []
                for si, sym in enumerate(syms):
                    J = join_arms(R, sym, T, smin, R195)
                    if J is None or J["n_support"] == 0:
                        continue
                    J["sid"] = np.full(J["n_support"], si)
                    S["support"][f"{g}|{TL[T]}|{sym}"] = [J["n_before_support"], J["n_support"]]
                    parts.append(J)
                cat = {k: np.concatenate([q[k] for q in parts]) for k in ("ts", "y", "a", "yb", "lsfut", "vs", "sid")}
                pp = {arm: np.concatenate([q["p"][arm] for q in parts]) for arm in ARMS}
                lh = {arm: np.concatenate([q["lsH"][arm] for q in parts]) for arm in ARMS}
                ts, sid = cat["ts"], cat["sid"]
                blk = G.block_of(ts, T)
                Wset = G.boot_weights(sid, blk, time_only, B_BOOT, 7 * T + (0 if g == "ETHBTC" else 3))
                pi, Pn, W = Wset
                # ---- sigma diagnostics (2.1)
                vs = cat["vs"]
                okv = np.isfinite(vs) & np.isfinite(cat["lsfut"])
                qs = np.nanquantile(vs[okv], np.linspace(0, 1, 11))
                dec = np.clip(np.searchsorted(qs, vs, side="right") - 1, 0, 9)
                dec[~okv] = -1
                sig = {}
                for arm in ARMS:
                    e = cat["lsfut"] - lh[arm]
                    ok = okv & np.isfinite(e)
                    ent = {"n": int(ok.sum()), "sd_e": float(np.std(e[ok])), "mean_e": float(np.mean(e[ok]))}
                    me, ve, Rd, vR = [], [], [], []
                    for q in range(10):
                        m = ok & (dec == q)
                        ee = np.where(m, e, 0.0)
                        se_ = np.bincount(pi, ee, Pn)
                        sn_ = np.bincount(pi, m.astype(float), Pn)
                        draws = (W @ se_) / (W @ sn_)
                        me.append(float(ee.sum() / m.sum()))
                        ve.append(float(np.var(draws, ddof=1)))
                        # R over pooled levels -5..-20 (target a)
                        pr = np.where(m[:, None], pp[arm][:, JR], 0.0).sum(1)
                        yr = np.where(m[:, None], cat["y"][:, JR], 0).sum(1).astype(float)
                        sp_, sy_ = np.bincount(pi, pr, Pn), np.bincount(pi, yr, Pn)
                        if yr.sum() >= 10:
                            with np.errstate(divide="ignore", invalid="ignore"):
                                dr = np.log((W @ sp_) / (W @ sy_))
                            dr = dr[np.isfinite(dr)]
                            Rd.append(float(math.log(pr.sum() / yr.sum())))
                            vR.append(float(np.var(dr, ddof=1)) if len(dr) > 10 else float("nan"))
                        else:
                            Rd.append(float("nan"))
                            vR.append(float("nan"))
                    ent.update({"mean_e_by_decile": me, "tau_e": dl_tau(me, ve),
                                "R_by_decile": [math.exp(x) if np.isfinite(x) else None for x in Rd],
                                "tau_R": dl_tau(Rd, vR)})
                    sig[arm] = ent
                S["sigma"][f"{g}|{TL[T]}"] = sig
                # ---- cells (2.2)
                for tgt in ("a", "b"):
                    ycol = cat["y"] if tgt == "a" else cat["yb"]
                    okt = (ycol >= 0).all(axis=1)
                    if tgt == "b":
                        Wt = G.boot_weights(sid[okt], blk[okt], time_only, B_BOOT, 7 * T + 11)
                    else:
                        Wt = Wset
                    dpool = {arm: [] for arm in ARMS[1:]}
                    rowid = {arm: [] for arm in ARMS[1:]}
                    for jj, (j, k) in enumerate(zip(JL, LV)):
                        yy = ycol[okt, j].astype(np.float64)
                        pe = G.asof_rate(ts[okt], T, yy)
                        bP = (pp["P"][okt, j] - yy) ** 2
                        for arm in ARMS:
                            p = np.clip(pp[arm][okt, j], 0, 1)
                            st = G.cell_stats(p, cat["a"][okt, j], yy, sid[okt], blk[okt], time_only=time_only,
                                              B=B_BOOT, seed=1000 * T + 10 * jj + (0 if tgt == "a" else 5), pe=pe)
                            st["class"] = G.classify(st)
                            st["mean_p"] = float(p.mean())
                            st["rate"] = float(yy.mean())
                            if arm != "P":
                                d = (p - yy) ** 2 - bP
                                st["bss_P"] = float(1 - ((p - yy) ** 2).sum() / bP.sum())
                                st["z_boot"] = boot_z(d, Wt)
                                st["z_cgm"] = cgm_z(d, sid[okt], blk[okt])
                                dpool[arm].append(d)
                            S["cells"][f"{arm}|{g}|{TL[T]}|{int(round(k * 100))}|{tgt}"] = st
                    for arm in ARMS[1:]:
                        d = np.stack(dpool[arm], axis=1).mean(1)       # per row mean over levels (same clusters)
                        S["pooled"][f"{arm}|{g}|{TL[T]}|{tgt}"] = {"mean_d": float(d.mean()), "z_boot": boot_z(d, Wt),
                                                                   "z_cgm": cgm_z(d, sid[okt], blk[okt]),
                                                                   "rows": int(len(d))}
                print(now(), span, g, TL[T], "rows", len(ts), flush=True)
        res["spans"][span] = S
    res["finished_utc"] = now()
    json.dump(res, open(os.path.join(a.out, "score-r20.json"), "w"))
    verdict(res, a.out)


def verdict(res, out):
    lines = []
    V = {}
    for span, S in res["spans"].items():
        lines.append(f"## span {span}\n")
        lines.append("### sigma diagnostics (target a; tau_R over -5..-20%)\n")
        lines.append("| panel | arm | sd e | mean e | tau_e | tau_R | R dec1 | R dec10 | mean e dec1 | mean e dec10 |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
        red = {arm: {"tau_e": [], "tau_R": []} for arm in ARMS}
        for pk, sig in S["sigma"].items():
            for arm in ARMS:
                s_ = sig[arm]
                rd = s_["R_by_decile"]
                lines.append(f"| {pk} | {arm} | {s_['sd_e']:.3f} | {s_['mean_e']:+.3f} | {s_['tau_e']:.3f} | "
                             f"{s_['tau_R']:.3f} | {rd[0] if rd[0] is None else round(rd[0], 2)} | "
                             f"{rd[9] if rd[9] is None else round(rd[9], 2)} | {s_['mean_e_by_decile'][0]:+.3f} | "
                             f"{s_['mean_e_by_decile'][9]:+.3f} |")
                red[arm]["tau_e"].append(s_["tau_e"])
                red[arm]["tau_R"].append(s_["tau_R"])
        fix = {}
        for arm in ARMS[1:]:
            te0, tr0 = np.nanmean(red["P"]["tau_e"]), np.nanmean(red["P"]["tau_R"])
            te1, tr1 = np.nanmean(red[arm]["tau_e"]), np.nanmean(red[arm]["tau_R"])
            fix[arm] = {"tau_e_P": te0, "tau_e": te1, "tau_R_P": tr0, "tau_R": tr1,
                        "drop_e": 1 - te1 / te0 if te0 > 0 else None, "drop_R": 1 - tr1 / tr0 if tr0 > 0 else None}
            fix[arm]["fix"] = bool(fix[arm]["drop_e"] is not None and fix[arm]["drop_R"] is not None
                                   and fix[arm]["drop_e"] >= 0.25 and fix[arm]["drop_R"] >= 0.25)
        lines.append("\nfix rule: " + json.dumps(fix) + "\n")
        sel = {}
        for g in ("ETHBTC", "LARGE"):
            for tgt in ("a", "b"):
                lines.append(f"### cells {g} target ({tgt})\n")
                lines.append("| cell | P class R slope | RV5 BSS_P z_boot z_cgm class R | RV5S BSS_P z_boot z_cgm class R | pos |")
                lines.append("|---|---|---|---|---|")
                cnt = {arm: 0 for arm in ARMS}
                worse = {arm: 0 for arm in ARMS[1:]}
                for T in TS_B:
                    for k in LV:
                        kk = int(round(k * 100))
                        c = {arm: S["cells"].get(f"{arm}|{g}|{TL[T]}|{kk}|{tgt}") for arm in ARMS}
                        if c["P"] is None:
                            continue

                        def f(st):
                            if not st.get("estimable", True) or "R" not in st:
                                return st.get("class", "HC")
                            return f"{st['class'][:2]} R {st['R'][0]:.2f} s {st['slope'][0]:.2f}"
                        row = f"| {TL[T]} {kk}% | {f(c['P'])} |"
                        for arm in ARMS[1:]:
                            st = c[arm]
                            if "bss_P" in st:
                                row += f" {st['bss_P']:+.4f} {st['z_boot']:+.2f} {st['z_cgm']:+.2f} {f(st)} |"
                                if st["bss_P"] < -0.01 and st["z_boot"] >= 2:
                                    worse[arm] += 1
                            else:
                                row += " - |"
                        row += f" {c['P'].get('pos')} |"
                        lines.append(row)
                        for arm in ARMS:
                            cnt[arm] += c[arm].get("class") == "CALIBRATED-WARN"
                lines.append("")
                lines.append("| pooled | " + " | ".join(
                    f"{arm} {TL[T]} z {S['pooled'][f'{arm}|{g}|{TL[T]}|{tgt}']['z_boot']:+.2f}/"
                    f"{S['pooled'][f'{arm}|{g}|{TL[T]}|{tgt}']['z_cgm']:+.2f}"
                    for arm in ARMS[1:] for T in TS_B) + " |\n")
                # group-level pooled z over all cells: combine per-T pooled mean d weighted by rows
                for arm in ARMS[1:]:
                    zs = [S["pooled"][f"{arm}|{g}|{TL[T]}|{tgt}"]["z_boot"] for T in TS_B]
                    zg = float(np.nansum(zs) / math.sqrt(np.isfinite(zs).sum()))   # Stouffer over horizons
                    sel[f"{arm}|{g}|{tgt}"] = {"z_group_stouffer": zg, "cells_worse": worse[arm],
                                               "cw": cnt[arm], "cw_P": cnt["P"],
                                               "better": bool(zg <= -2 and worse[arm] == 0 and cnt[arm] >= cnt["P"])}
                lines.append("CALIBRATED-WARN counts: " + json.dumps(cnt) + "\n")
        lines.append("selection: " + json.dumps(sel) + "\n")
        V[span] = {"fix": fix, "selection": sel}
    json.dump(V, open(os.path.join(out, "verdict-r20.json"), "w"), indent=1)
    open(os.path.join(out, "summary-r20.md"), "w").write("\n".join(lines))
    print(json.dumps(V, indent=1))


# =====================================================================================================================
# near-line: dense-ladder rows on the D13 III grids, then the unchanged r111v5 report
# =====================================================================================================================
NL_SERIES = {"WETH": ("binance:ETHUSDT", "ETHUSDT"), "WBTC": ("binance:BTCUSDT", "BTCUSDT"),
             "LINK": ("A2:LINKUSDT", "LINKUSDT"), "AAVE": ("A3:AAVEUSDT", "AAVEUSDT")}


def _nl_job(args):
    key, sym, path, arm, out = args
    import r111v5_labels as LB
    res = run_arm({"key": key, "kind": "grid", "path": path, "sym": sym}, arm, out, levels=LB.DENSE)
    return key, arm, res


def cmd_nlrows(a):
    import r16_dev as RD
    import r111v5_labels as LB
    RD.init_btc(a.datasets)
    jobs = [(key, sym, os.path.join(a.datasets, D13_DIR, f"III-{sym}-1h.json.gz"), arm, a.out)
            for key, sym in NL_SERIES.values() for arm in ARMS]
    res = {}
    with mp.get_context("fork").Pool(a.workers, maxtasksperchild=2) as pool:
        for key, arm, r in pool.imap_unordered(_nl_job, jobs, chunksize=1):
            res[(key, arm)] = r
            print(now(), "nl", key, arm, flush=True)
    for arm in ARMS:
        arr = {}
        for x, (key, sym) in NL_SERIES.items():
            for T, R in res[(key, arm)].items():
                for k in ("ts", "y", "a", "fH"):
                    arr[f"{x}|{T}|{k}"] = R[k]
                arr[f"{x}|{T}|lsH"] = R["lsH"]
        d = os.path.join(a.out, "nl", arm)
        os.makedirs(d, exist_ok=True)
        np.savez(os.path.join(d, "fh-dense.npz"), levels=np.array(LB.DENSE), **arr)


def cmd_nearline(a):
    """Run the unchanged report per arm in OUT/nl/<arm>/ with a read-only symlink to the R11.1-v5 rows."""
    src = os.path.join(a.r111, "rows-labels.npz")
    if not os.path.exists(src):
        raise SystemExit("near-line rows not available: " + src)
    runs = {"orig": os.path.join(a.r111, "fh-dense.npz")}
    for arm in ARMS:
        runs[arm] = os.path.join(a.out, "nl", arm, "fh-dense.npz")
    for nm, fh in runs.items():
        d = os.path.join(a.out, "nl", "run-" + nm)
        os.makedirs(d, exist_ok=True)
        for f, s in (("rows-labels.npz", src), ("fh-dense.npz", fh)):
            p = os.path.join(d, f)
            if os.path.lexists(p):
                os.remove(p)
            os.symlink(os.path.abspath(s), p)
        if nm != "orig":
            # common support: the report reads fH only; rows of an arm with (f) fallback keep the fallback value
            pass
        cmd = [sys.executable, os.path.join(HERE, "r111v5_labels.py"), "report", "--scr", d, "--out", d]
        print(now(), "report", nm, flush=True)
        subprocess.run(cmd, check=True, cwd=HERE)


# =====================================================================================================================
# counts (lever B)
# =====================================================================================================================
CELLS = ((-0.10, 72), (-0.15, 72), (-0.20, 72), (-0.15, 24))
BINANCE_START = 1502928000                                          # 2017-08-17T00:00Z


def load_hl(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    d = json.loads(raw)
    st = int(d["startTs"])
    cols = d["columns"]

    def col(nm):
        return np.array([np.nan if v is None else float(v) for v in cols[nm]], float)
    return st, col("close"), col("low")


def hits(close, low, x, H):
    """hit[t] for origin t (close of bar t): any low in bars t+1..t+H <= close_t (1 - x). NaN-safe (null -> no hit)."""
    from numpy.lib.stride_tricks import sliding_window_view as swv
    n = len(close)
    lo = np.where(np.isfinite(low), low, np.inf)
    h = np.zeros(n, bool)
    if n <= H:
        return h, np.zeros(n, bool)
    mn = swv(lo[1:], H).min(axis=1)                                # mn[t] = min low[t+1..t+H], t = 0..n-H-1
    m = np.isfinite(close[:n - H])
    h[:n - H] = m & (mn <= close[:n - H] * (1 + x))
    valid = np.zeros(n, bool)
    valid[:n - H] = m & np.isfinite(mn)
    return h, valid


def episodes(times, H):
    """episode start times: hit origins merge while the gap is <= H hours."""
    if len(times) == 0:
        return np.zeros(0, np.int64)
    t = np.sort(times)
    brk = np.r_[True, np.diff(t) > H * STEP]
    return t[brk]


def neff_cgm(y, sid, blk):
    y = y.astype(float)
    n = len(y)
    p = y.mean()
    u = y - p

    def v(g):
        _, gi = np.unique(g, return_inverse=True)
        s = np.bincount(gi, u)
        return (s ** 2).sum() / n ** 2
    inter = sid.astype(np.int64) * (int(blk.max()) + 1) + blk
    V = v(sid) + v(blk) - v(inter) if len(np.unique(sid)) > 2 else v(blk)
    V = max(V, v(blk) * 0 + 1e-300)
    ne = p * (1 - p) / V
    return {"rows": int(n), "pos": int(y.sum()), "p": float(p), "n_eff": float(ne), "pos_eff": float(p * ne)}


def cmd_counts(a):
    import r12_tail as R12
    fb = os.path.join(a.datasets, "final-blind-prices")
    src = {"binance-ETH": (os.path.join(a.datasets, "binance-klines/ETHUSDT-1h.json"), "ETH"),
           "binance-BTC": (os.path.join(a.datasets, "binance-klines/BTCUSDT-1h.json"), "BTC"),
           "kraken-ETH": (os.path.join(a.datasets, "history-forecasts/r11/r1110-run-a91e04ad/acq/kraken-xethzusd-1h.json"), "ETH"),
           "coinbase-ETH": (os.path.join(fb, "coinbase-eth-usd-1h.json"), "ETH"),
           "bitstamp-BTC": (os.path.join(fb, "bitstamp-btc-usd-1h.json"), "BTC"),
           "coinbase-BTC": (os.path.join(fb, "coinbase-btc-usd-1h.json"), "BTC")}
    S = {k: load_hl(p) for k, (p, _) in src.items()}
    out = {"code": git_sha(), "cells": {}, "sources": {k: {"start": int(v[0]), "hours": int(len(v[1]))} for k, v in S.items()}}
    # dev pool for altcoins
    pool = []
    for sp in R12.dev_specs(a.datasets):
        if sp["kind"] != "grid" or sp["key"] == "P1:KRAKEN-ETH":
            continue
        try:
            pool.append((sp["key"],) + load_hl(sp["path"]))
        except Exception as e:  # noqa: BLE001
            print("skip", sp["key"], e)
    print(now(), "pool series", len(pool), flush=True)
    for x, H in CELLS:
        ck = f"{int(round(x * 100))}%/{H}h"
        C = {}
        ep = {}
        hitmask = {}
        for k, (st, c, lo) in S.items():
            h, val = hits(c, lo, x, H)
            t = st + STEP * np.flatnonzero(h)
            ep[k] = episodes(t, H)
            hitmask[k] = (st, h, val)
            C[k] = {"episodes": int(len(ep[k])), "before_binance": int((ep[k] < BINANCE_START).sum())}
        base = episodes(np.concatenate([st + STEP * np.flatnonzero(h) for k, (st, h, v) in hitmask.items()
                                        if k.startswith("binance")]), H)
        pre_all = np.concatenate([st + STEP * np.flatnonzero(h) for k, (st, h, v) in hitmask.items()
                                  if not k.startswith("binance")])
        pre = episodes(pre_all[pre_all < BINANCE_START], H)
        pre_eth = episodes(np.concatenate([st + STEP * np.flatnonzero(h) for k, (st, h, v) in hitmask.items()
                                           if k in ("kraken-ETH", "coinbase-ETH")]), H)
        pre_eth = pre_eth[pre_eth < BINANCE_START]
        pre_btc = episodes(np.concatenate([st + STEP * np.flatnonzero(h) for k, (st, h, v) in hitmask.items()
                                           if k in ("bitstamp-BTC", "coinbase-BTC")]), H)
        pre_btc = pre_btc[pre_btc < BINANCE_START]
        C["binance_union"] = int(len(base))
        C["pre2017_distinct"] = int(len(pre))
        C["pre2017_eth_distinct"] = int(len(pre_eth))
        C["pre2017_btc_distinct"] = int(len(pre_btc))
        # weeks (Monday start: epoch 1970-01-01 is a Thursday, offset 4 days)
        wk = lambda t: (np.asarray(t) + 3 * DAY) // (7 * DAY)  # noqa: E731
        ebw = set(wk(base).tolist())
        # altcoins: per series hit masks and episodes
        hitw = {}
        livew = {}
        alt_ep = []
        rows_y, rows_s, rows_b = [], [], []
        for si, (key, st, c, lo) in enumerate(pool):
            h, val = hits(c, lo, x, H)
            t_all = st + STEP * np.arange(len(c))
            e_ = episodes(t_all[h], H)
            alt_ep.append((key, e_))
            for w in set(wk(t_all[val]).tolist()):
                livew[w] = livew.get(w, 0) + 1
            for w in set(wk(t_all[h]).tolist()):
                hitw[w] = hitw.get(w, 0) + 1
            # sampled rows for N_eff: every 24th origin (daily) to bound memory; clusters series x 4-week block
            sel = np.flatnonzero(val)[::24]
            rows_y.append(h[sel])
            rows_s.append(np.full(len(sel), si))
            rows_b.append(t_all[sel] // (28 * DAY))
        share = {w: hitw.get(w, 0) / livew[w] for w in livew if livew[w] >= 10}
        thr = np.quantile(list(share.values()), 0.9) if share else 1.0
        mw = ebw | {w for w, s in share.items() if s >= thr}
        n_alt = sum(len(e_) for _, e_ in alt_ep)
        off = [t for _, e_ in alt_ep for t in e_ if wk(t) not in mw]
        C["alt_episodes"] = int(n_alt)
        C["alt_episodes_off_market_weeks"] = int(len(off))
        C["alt_off_share"] = float(len(off) / n_alt) if n_alt else None
        C["alt_distinct_off_weeks"] = int(len(set(wk(off).tolist()))) if off else 0
        C["alt_distinct_periods_all"] = int(len(episodes(np.concatenate([e_ for _, e_ in alt_ep]), H)))
        C["market_weeks"] = int(len(mw))
        C["share_threshold_top_decile"] = float(thr)
        # N_eff panels (daily-sampled origins; series x 4-week block)
        def panel(keys):
            ys, ss, bs = [], [], []
            for si, k in enumerate(keys):
                st, h, val = hitmask[k]
                t_all = st + STEP * np.arange(len(h))
                sel = np.flatnonzero(val)[::24]
                ys.append(h[sel])
                ss.append(np.full(len(sel), si))
                bs.append(t_all[sel] // (28 * DAY))
            return np.concatenate(ys), np.concatenate(ss), np.concatenate(bs)
        y0, s0, b0 = panel(["binance-ETH", "binance-BTC"])
        C["neff_binance_ethbtc"] = neff_cgm(y0, s0, b0)
        ypre, spre, bpre = panel(["kraken-ETH", "coinbase-ETH", "bitstamp-BTC", "coinbase-BTC"])
        cut = bpre < BINANCE_START // (28 * DAY)
        y1 = np.concatenate([y0, ypre[cut]])
        s1 = np.concatenate([s0, spre[cut] + 10])
        b1 = np.concatenate([b0, bpre[cut]])
        C["neff_ethbtc_plus_pre2017"] = neff_cgm(y1, s1, b1)
        # pre-2017 alone with one venue per asset (no duplicated venues in the same hours): Bitstamp BTC; Kraken ETH
        # until its last hour, then Coinbase ETH; all rows before 2017-08-17. Time-disjoint from the Binance panel,
        # so effective positives of the two panels add (approximately).
        yk, sk, bk_ = panel(["kraken-ETH"])
        yc, sc_, bc = panel(["coinbase-ETH"])
        yb_, sb_, bb_ = panel(["bitstamp-BTC"])
        kend = bk_.max()
        ypa = np.concatenate([yk, yc[bc > kend], yb_])
        spa = np.concatenate([np.zeros(len(yk), int), np.zeros(int((bc > kend).sum()), int), np.ones(len(yb_), int)])
        bpa = np.concatenate([bk_, bc[bc > kend], bb_])
        cut2 = bpa < BINANCE_START // (28 * DAY)
        C["neff_pre2017_alone"] = neff_cgm(ypa[cut2], spa[cut2], bpa[cut2])
        C["pos_blocks_binance_ethbtc"] = int(len(np.unique(b0[y0])))
        C["pos_blocks_pre2017"] = int(len(np.unique(bpa[cut2][ypa[cut2]])))
        ya, sa, ba = np.concatenate(rows_y), np.concatenate(rows_s), np.concatenate(rows_b)
        C["neff_alt_pool"] = neff_cgm(ya, sa, ba)
        # off-market-week rows: drop rows whose week is a market-wide week
        ta = ba  # block ids only; recompute week ids from sampled times
        del ta
        wa = np.concatenate([wk(pool[i][1] + STEP * np.flatnonzero(hits(pool[i][2], pool[i][3], x, H)[1])[::24])
                             for i in range(len(pool))])
        offm = ~np.isin(wa, list(mw))
        C["neff_alt_off_market_weeks"] = neff_cgm(ya[offm], sa[offm], ba[offm])
        C["neff_alt_rows_note"] = "daily-sampled origins (every 24th valid hour) per series"
        out["cells"][ck] = C
        print(now(), ck, json.dumps({k: v for k, v in C.items() if not isinstance(v, dict)}), flush=True)
    json.dump(out, open(os.path.join(a.out, "counts-r20.json"), "w"), indent=1)


def cmd_groupz(a):
    """Registered group-pooled z (2.2 rule 1): per-row Brier difference averaged over the 7 levels, concatenated over the
    5 horizons, one two-way bootstrap over the shared (series, 4-week block) clusters. Replaces the Stouffer combination
    first used in verdict() (Stouffer treats correlated horizons as independent; D-R20a)."""
    import r193_regrade as G
    R = load_rows(a.out)
    R195 = dict(np.load(os.path.join(a.datasets, R195_DIR, "rows-r195.npz")))
    U = universe()
    groups = {"ETHBTC": [e["symbol"] for e in U if e["symbol"] in ("ETHUSDT", "BTCUSDT")],
              "LARGE": [e["symbol"] for e in U if e["symbol"] not in ("ETHUSDT", "BTCUSDT")]}
    out = {}
    for span, smin in (("full", 0), ("2021", SPAN2021)):
        for g, syms in groups.items():
            for tgt in ("a", "b"):
                D_ = {arm: [] for arm in ARMS[1:]}
                sids, blks = [], []
                for T in TS_B:
                    for si, sym in enumerate(syms):
                        J = join_arms(R, sym, T, smin, R195)
                        if J is None or J["n_support"] == 0:
                            continue
                        y = J["y"] if tgt == "a" else J["yb"]
                        ok = (y >= 0).all(axis=1)
                        yy = y[ok][:, JL].astype(float)
                        bP = ((J["p"]["P"][ok][:, JL] - yy) ** 2).mean(1)
                        for arm in ARMS[1:]:
                            D_[arm].append(((np.clip(J["p"][arm][ok][:, JL], 0, 1) - yy) ** 2).mean(1) - bP)
                        sids.append(np.full(ok.sum(), si))
                        blks.append(G.block_of(J["ts"][ok], T))
                sid, blk = np.concatenate(sids), np.concatenate(blks)
                Wt = G.boot_weights(sid, blk, g == "ETHBTC", B_BOOT, 99)
                for arm in ARMS[1:]:
                    d = np.concatenate(D_[arm])
                    out[f"{span}|{arm}|{g}|{tgt}"] = {"mean_d": float(d.mean()), "z_boot": boot_z(d, Wt),
                                                      "z_cgm": cgm_z(d, sid, blk), "rows": int(len(d))}
    json.dump(out, open(os.path.join(a.out, "groupz-r20.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


# =====================================================================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--out", required=True)
    ap.add_argument("--datasets", default="/home/user/membrane-datasets")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--syms", default="")
    ap.add_argument("--r111", default="")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    {"acq": cmd_acq, "rows": cmd_rows, "check": cmd_check, "score": cmd_score, "nlrows": cmd_nlrows,
     "nearline": cmd_nearline, "counts": cmd_counts, "groupz": cmd_groupz}[a.cmd](a)


if __name__ == "__main__":
    main()
