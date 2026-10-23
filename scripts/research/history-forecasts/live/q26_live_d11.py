#!/usr/bin/env python3
"""Q26 live forecast log -- D11: the frozen GRU rule D vs (fH) on 273 Binance development series (log only, never shown).

membrane-board design/HISTORY_TOUCH_LIVE.md Deviation D11 (owner approval 2026-10-23, verbatim in D11). Evidence and
model: design/Q26_ROUND16_PREREG.md D-R16.2e-a/-e/-f/-g. Frozen rule D: membrane-datasets 90b1c1a
history-forecasts/r16/r162e-cd-c41dff8f/frozen-r162e-ens5-D.pt (sha256 65e59e5a...) and .json (bd152a0b...).

This module is its own block of the live log, with its own store under forecasts/q26-touch-live/d11/. It never reads or
writes the main issue files, so the daily (A3/A5/A6), short (D8) and deep (D9/D10) blocks are byte-identical with or
without it.

Issue (q26_live_d11.py issue; inside the existing 00:17Z run, no new schedule):
  origin    the daily 00:00Z origin t of the UTC day of the run, logged at most once, only when the run starts before
            t + 23 h (no backfill). One issue file per origin: d11/issues/YYYY-MM-DD.json.gz, hash-chained.
  series    the 273 non-BTC/ETH development series of R16.2e (D11_UNIVERSE), Binance spot USDT klines. ETHUSDT and
            BTCUSDT are issued too and are DESCRIPTIVE ONLY (never in the test).
  inputs    the frozen development kline grid of each series (membrane-datasets, sha256-checked) plus the D11 kline
            store d11/klines/<SYMBOL>.csv.gz (every closed hourly kline after the development grid ends). Only bars
            that open before t are read.
  (fH)      the R16.2 development (fH) exactly (r16_dev.task): HAR coefficients and the FHS z set of the quarter fold
            that contains t (training origins i <= qs - T), (f) fallback where sigma_H is undefined, running minimum
            over the T's development levels, stored as float32 (as the development rows).
  D         the frozen rule-D ensemble (5 GRUs, 3 torch threads): p = running minimum over the tier levels of
            sigmoid(logit(fH) + mean residual); inputs built by r16_nn.series_arrays / build_batch unchanged.
  STOP      the weights file sha256, the config sha256, every net state sha256, the dev-calibration sha256 and every
            development grid sha256 are checked before any forecast; a mismatch stops the block (fail closed).
Score (q26_live_d11.py score; inside the existing 00:47Z run):
  truth     y = 1 iff the minimum hourly Binance low over (t, t + T] <= S (1 + k), S = the close of the hour ending
            at t (the development label, a3_touch.make_labels on the same grid). A window with a missing hour is
            censored (no label), as development.
  recal     per arm and cell, Platt on logit p over the rows with origin in [t - 730 d, t - 1 d]: the frozen development
            calibration rows (devcal.npz) and the resolved live rows of the 273 series (DESIGN in D11).
  e-process the daily paired Brier difference (recalibrated (fH) minus recalibrated D, 3 h pooled) bet by aGRAPA with
            a development prior, truncated by a predictable bound; ledger d11/ledger.jsonl, append-only, hash-chained.
No address, key or secret is read or written. Public endpoint only (data-api.binance.vision).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_common as C  # noqa: E402

MODEL_DIR = C.MODEL_DIR
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)
import a3_touch as M3  # noqa: E402  (imported, never modified)
import a6_touch as A6  # noqa: E402
import r12_tail as R12  # noqa: E402
import r16_dev as RD  # noqa: E402
import r16_nn as NN  # noqa: E402

SCHEMA = "q26-touch-live/d11/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "deviation": "D11",
          "evidence": "design/Q26_ROUND16_PREREG.md D-R16.2e-a/-e/-f/-g"}
STEP, HOUR, DAY = 3600, 3600, 86400
D11_SUB = "d11"
HORIZONS = (1, 3, 12)
TL = {1: "1h", 3: "3h", 12: "12h"}
TIER_LV = NN.TIER_LV["shallow"]                       # (-0.02, -0.03, -0.05, -0.07, -0.10)
DEV_LV = {T: RD.LV[T] for T in HORIZONS}              # development cells (12)
D8_LV = {1: (-0.02, -0.03), 3: (-0.02, -0.03, -0.05, -0.07), 12: (-0.02, -0.03, -0.05, -0.07, -0.10)}
PRIMARY_T = 3
FIRST_ORIGIN = C.A.utc("2026-10-24T00:00:00Z")        # first daily origin after the D11 pin (no earlier origin)
MAX_LATE = 23 * HOUR                                  # an origin is logged only by a run starting before t + 23 h
DESCRIPTIVE = ("ETHUSDT", "BTCUSDT")
BTC_FEATURE = "BTCUSDT"                               # btc_r24 / btc_dm features (r16_dev.init_btc)
KLINE_HEADER = ["openTime", "open", "high", "low", "close", "volume", "closeTime"]
TORCH_VERSION = "2.14.1+cpu"
THREADS = 3

# Frozen model (D-R16.2e-f) and frozen development calibration (D11)
WEIGHTS_REL = "history-forecasts/r16/r162e-cd-c41dff8f/frozen-r162e-ens5-D.pt"
WEIGHTS_SHA = "65e59e5af5c9ff9a70600f57d94dba08da65f3c827edab20b1620cb9bf60ce21"
CONFIG_REL = "history-forecasts/r16/r162e-cd-c41dff8f/frozen-r162e-ens5-D.json"
CONFIG_SHA = "bd152a0b956e7ebb27888a45d2e703ce02aa7f6f61bd6fb562577700cec34681"
NET_SHA = ("f22b9e248abc0d8e578f7ae008c1423f8a9553f2a5bbb9caddd7fbfd17a4232c",
           "bd26d4ab344cd729161ab8274e777cfd0bbb20e3473421e7e5155e72ba21d966",
           "64a7ef874e82d7d619e0bb04224d24b3f34d442a9a1350ad0a8947fd1a6fc005",
           "f06a243b47754a3b8a42fb891a64f1302694f289c63acec94fe34171d98caed8",
           "22235a99dc0371b0df1c0cd7a84577e7899bd7218f8be461a65b1a6270b9b6bc")
GOLDEN_TOL = 1e-6                                     # CI vs local frozen-D p on the replay day (numerics only)
REPLAY_ORIGIN = C.A.utc("2026-09-30T00:00:00Z")       # development origin of the instrument replay

# Recalibration (D11): Platt per arm and cell over [t - 730 d, t - 1 d]
RECAL_DAYS = 730
RECAL_MIN_ROWS, RECAL_MIN_POS = 1000, 20
PCLIP_RECAL = 1e-6
# e-process (D11): aGRAPA with a development prior, truncated by a predictable bound
ALPHA = 0.05
N0 = 30
CAP_FRAC = 0.5
DEV_MU = {1: 2.177075e-03, 3: 2.239404e-03, 12: 2.497137e-03}      # development mean daily difference (efinal)
DEV_V0 = {1: 2.512153e-04, 3: 2.526450e-04, 12: 2.811750e-04}      # development mean squared daily difference
MIN_SERIES_DAY = 50                                   # an origin counts as an observed day with >= 50 issued series
R_BAND = (0.8, 1.25)
FUTILITY_DAYS = (365, 730)
CAP_DAYS = 1095
FIXED_DAYS = 450
FIXED_LAG = 7
BOOT_B, BOOT_SEED = 10000, 20261024
RESOLVE_MARGIN = 900
GIVE_UP = 72 * HOUR
DELIST_DAYS = 30
STATUS_PROVING = "proving"


# =====================================================================================================================
# universe
# =====================================================================================================================
def universe_path():
    return os.path.join(HERE, "d11_universe.json")


def load_universe():
    with open(universe_path()) as f:
        U = json.load(f)
    return U


def symbol_of(key):
    return key.split(":")[-1]


# =====================================================================================================================
# kline grids: the frozen development grid + the D11 store, cut before the origin
# =====================================================================================================================
def read_dev_grid(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    d = json.loads(raw)
    st = int(d["startTs"])
    cols = {c: np.array([np.nan if v is None else float(v) for v in d["columns"][c]], float)
            for c in ("close", "low", "high")}
    vol = None
    if "volume" in d["columns"]:
        vol = np.array([np.nan if v is None else float(v) for v in d["columns"]["volume"]], float)
    return st, cols, vol


def store_path(ldir, sym):
    return os.path.join(ldir, D11_SUB, "klines", sym + ".csv.gz")


def read_store(path):
    rows = C.read_gz_csv(path, KLINE_HEADER)
    prev = None
    for r in rows:
        o = int(r[0])
        if o % (HOUR * 1000) or (prev is not None and o <= prev):
            raise SystemExit(f"STOP: {path}: kline open times not increasing on the hour grid at {o}")
        prev = o
    return rows


def extend_grid(st, cols, vol, rows, upto):
    """Grid of hours opening st .. upto - 1 h: development values, then store klines (missing hour = NaN)."""
    n_dev = len(cols["close"])
    n = (upto - st) // HOUR
    out = {c: np.full(n, np.nan) for c in ("close", "low", "high")}
    v = np.full(n, np.nan)
    m = min(n, n_dev)
    for c in out:
        out[c][:m] = cols[c][:m]
    if vol is not None:
        v[:m] = vol[:m]
    for r in rows:
        j = (int(r[0]) // 1000 - st) // HOUR
        if j < n_dev:
            continue            # the store starts after the development grid; never overrides it
        if j >= n:
            break
        out["close"][j], out["high"][j], out["low"][j], v[j] = float(r[4]), float(r[2]), float(r[3]), float(r[5])
    return out, (v if vol is not None else None)


# =====================================================================================================================
# per-series computation at one origin (the R16.2 development row, r16_dev.task, at a single origin)
# =====================================================================================================================
def quarter_start(ts):
    y, mo = map(int, C.iso(ts)[:7].split("-"))
    q = (mo - 1) // 3 + 1
    return C.A.quarter_start(y, q), (y, q)


def make_ser(key, st, cols):
    ser = M3.S3(key, key, "binance", cols["close"], cols["low"], R12.LEVELS, st, st)
    A6.attach_high(ser, cols["high"])
    return ser


def btc_arrays(st, cols):
    """r16_dev.init_btc on a cut BTCUSDT grid."""
    c, h, l_ = cols["close"], cols["high"], cols["low"]
    n = len(c)
    spot = np.concatenate([[np.nan], c])
    r24 = np.full(n + 1, np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        r24[24:] = np.log(spot[24:] / spot[:-24])
        v = A6.parkinson_v(h, l_)
        d = A6.window_mean_null_rule(v, 24, 0)
        mth = A6.window_mean_null_rule(v, 720, 0)
        dm = 0.5 * np.log(d / mth)
    return {"st": st, "r24": r24, "dm": dm}


def series_origin(key, st, cols, vol, origin, btc):
    """Development (fH) / (f) and GRU features at one origin. Returns None when the series cannot be issued."""
    ser = make_ser(key, st, cols)
    i = (origin - st) // HOUR
    N1 = ser.N + 1
    assert i == ser.N, "the grid must end at the origin"
    if not np.isfinite(ser.spot[i]):
        return None, "no close in the hour before the origin"
    qs_ts, (qy, qq) = quarter_start(origin)
    if (qy, qq) < M3.first_quarter_after(st, R12.WARMUP_DAYS):
        return None, "younger than the development fold rule (first quarter >= 365 d after the first kline)"
    qs = ser.gi(qs_ts)
    with np.errstate(invalid="ignore", divide="ignore"):
        HAR = np.log(A6.har_of(ser))
        lc = np.log(ser.spot)
        hi = np.concatenate([[np.nan], ser.high])
        lo = np.concatenate([[np.nan], ser.low])

    def lagret(L):
        return lc[i] - lc[i - L] if i - L >= 0 else np.nan

    def winmax(x, W):          # r16_dev rollmax at origin i: max over x[i-W .. i-1] of the bar-aligned x, -inf -> NaN
        if i < W:
            return np.nan
        w = x[i - W:i]
        v = np.max(np.where(np.isfinite(w), w, -np.inf))
        return v if np.isfinite(v) else np.nan

    def winmin(x, W):
        v = winmax(-x, W)
        return -v if np.isfinite(v) else np.nan
    hmax720 = winmax(hi[1:], 720)
    hmax24, lmin24 = winmax(hi[1:], 24), winmin(lo[1:], 24)
    F0 = {"dm": HAR[i, 0] - HAR[i, 2], "wm": HAR[i, 1] - HAR[i, 2], "r24": lagret(24), "r168": lagret(168),
          "r720": lagret(720)}
    with np.errstate(invalid="ignore", divide="ignore"):
        F0["dd720"] = lc[i] - np.log(hmax720)
        F0["rng24"] = np.log(hmax24 / lmin24)
        if vol is not None and len(vol) == len(ser.close):
            v24 = RD.roll_mean(vol, 24, ser.start_i)[i]
            v720 = RD.roll_mean(vol, 720, ser.start_i)[i]
            F0["lvol"] = np.log(v24 / v720)
        else:
            F0["lvol"] = np.nan
    for k_ in F0:
        if not np.isfinite(F0[k_]):
            F0[k_] = np.nan
    k = (origin - btc["st"]) // STEP
    ok = 0 <= k < len(btc["r24"])
    F0["btc_r24"] = btc["r24"][k] if ok else np.nan
    F0["btc_dm"] = btc["dm"][k] if ok else np.nan
    out = {}
    for T in HORIZONS:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        P = P6.P
        lnk = np.log1p(np.array(DEV_LV[T]))
        lim = qs - T
        tr = P6.i <= lim
        cH, _ = P6.har_coef(qs)
        sH = P6.sigma_H(cH)
        zH, vH = P6.z_of(sH)
        te = np.array([i])
        with np.errstate(invalid="ignore", divide="ignore"):
            thrH = lnk[None, :] / (sH[te][:, None] * P.scale)
            thrf = lnk[None, :] / (ser.sigma[te][:, None] * P.scale)
        pf_ = C.M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], thrf)
        pH = C.M2.fhs_predict(zH[vH & tr], thrH)
        fb = ~np.all(np.isfinite(pH), axis=1)
        pH[fb] = pf_[fb]
        if not (np.all(np.isfinite(pH)) and np.all(np.isfinite(pf_))):
            return None, f"(fH)/(f) undefined at {TL[T]}"
        pH32 = np.minimum.accumulate(pH, axis=1).astype(np.float32)[0]
        feats = dict(F0)
        feats["lsH"] = np.log(sH[i])
        feats["lsf"] = np.log(ser.sigma[i])
        out[T] = {"fH": pH32, "fallback": bool(fb[0]), "feat": {kk: np.float32(feats[kk]) for kk in NN.STATIC}}
        A6._clear(ser) if hasattr(A6, "_clear") else None
        del P6
    return {"S": float(ser.spot[i]), "T": out, "ser": ser}, None


def series_arrays_from(ser, vol):
    """r16_nn.series_arrays (unchanged code) on an in-memory series: its two loaders are pointed at this series."""
    saved = (R12.load_series, RD.load_volume)
    try:
        R12.load_series = (lambda spec: (ser, [], {}))
        RD.load_volume = (lambda spec: vol)
        return NN.series_arrays({"key": ser.name})
    finally:
        R12.load_series, RD.load_volume = saved


# =====================================================================================================================
# D11 kline store: every CLOSED hourly kline after the development grid ends (append-only gzip members)
# =====================================================================================================================
def dev_end_open(entry):
    return int(entry["devEndOpen"])


def update_store(ldir, entry, http_get=None, clock=time.time):
    """Append every closed kline after the last stored one (bootstrap: after the development grid's last hour)."""
    sym = entry["symbol"]
    path = store_path(ldir, sym)
    existing = read_store(path)
    last_open = int(existing[-1][0]) if existing else dev_end_open(entry) * 1000
    fetched_ms = int(clock() * 1000)
    new = []
    while True:
        url = f"{C.BINANCE_API}?symbol={sym}&interval=1h&startTime={last_open + HOUR * 1000}&limit=1000"
        data = json.loads(C.get_with_retry(url, get=http_get))
        if not isinstance(data, list):
            raise ValueError(f"binance {sym}: unexpected response")
        batch = []
        for k in data:
            o, c = int(k[0]), int(k[6])
            if o <= last_open or c >= fetched_ms:
                continue                   # an open (unfinished) kline is never stored
            if o % (HOUR * 1000):
                raise ValueError(f"binance {sym}: kline off the hour grid {o}")
            batch.append([str(o), str(k[1]), str(k[2]), str(k[3]), str(k[4]), str(k[5]), str(c)])
        if not batch:
            break
        new += batch
        last_open = int(batch[-1][0])
        if len(data) < 1000:
            break
    if new:
        C.append_bytes(path, C.gz_member(None if existing else KLINE_HEADER, new))
    return {"symbol": sym, "appended": len(new), "fetchedAt": fetched_ms // 1000}


def update_all(ldir, U, http_get=None, clock=time.time, log=print, sleep=time.sleep):
    """Store update for every universe and descriptive series. Coverage: a symbol is covered up to the hour before
    the fetch time when its fetch succeeded (a missing kline before that is a real gap)."""
    ok, failed, added = {}, [], 0
    for e in U["series"]:
        try:
            r = update_store(ldir, e, http_get=http_get, clock=clock)
            ok[e["symbol"]] = r["fetchedAt"]
            added += r["appended"]
        except (OSError, ValueError, TimeoutError) as ex:
            failed.append([e["symbol"], f"{type(ex).__name__}: {str(ex)[:120]}"])
        sleep(0.05)
    entry = {"kind": "d11-klines", "fetchedAt": int(clock()), "ok": len(ok), "failed": failed, "appended": added}
    cov_path = os.path.join(ldir, D11_SUB, "klines", "coverage.jsonl")
    C.append_bytes(cov_path, (json.dumps({"fetchedAt": int(clock()), "covered": ok}, separators=(",", ":"))
                              + "\n").encode())
    C.append_bytes(os.path.join(ldir, D11_SUB, "klines", "fetch-log.jsonl"),
                   (json.dumps(entry, separators=(",", ":")) + "\n").encode())
    log(f"d11 klines: {len(ok)} ok, {len(failed)} failed, +{added} klines")
    return ok, failed


def coverage(ldir):
    """symbol -> the latest fetch time (s) of a successful update (the store is complete for hours closed before it)."""
    path = os.path.join(ldir, D11_SUB, "klines", "coverage.jsonl")
    cov = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.strip():
                    for s_, t_ in json.loads(line)["covered"].items():
                        cov[s_] = max(cov.get(s_, 0), int(t_))
    return cov


# =====================================================================================================================
# inputs and frozen model checks (fail closed)
# =====================================================================================================================
def check_universe(U, datasets):
    """sha256 of every development grid (STOP on a mismatch)."""
    for e in U["series"]:
        p = os.path.join(datasets, e["path"])
        if not os.path.exists(p):
            raise SystemExit(f"STOP: d11 development grid missing for {e['symbol']}")
        if C.sha256_file(p) != e["sha256"]:
            raise SystemExit(f"STOP: d11 development grid sha256 mismatch for {e['symbol']}")


def load_nets(datasets):
    """The frozen rule-D ensemble. STOP unless the file, the config and every net state sha256 match, the torch build
    is the pinned one, and 3 threads are set."""
    import torch
    import r162e_ens as E
    if torch.__version__ != TORCH_VERSION:
        raise SystemExit(f"STOP: torch {torch.__version__} != {TORCH_VERSION}")
    torch.set_num_threads(THREADS)
    wp, cp = os.path.join(datasets, WEIGHTS_REL), os.path.join(datasets, CONFIG_REL)
    if C.sha256_file(wp) != WEIGHTS_SHA:
        raise SystemExit("STOP: d11 weights file sha256 mismatch")
    if C.sha256_file(cp) != CONFIG_SHA:
        raise SystemExit("STOP: d11 config sha256 mismatch")
    cfg = json.load(open(cp))
    if tuple(cfg["net_state_sha256"]) != NET_SHA or cfg["rule"] != "D" or cfg["threads"] != THREADS:
        raise SystemExit("STOP: d11 config does not name the registered rule-D nets")
    blob = torch.load(wp, map_location="cpu", weights_only=True)
    states = blob["states"]
    shas = [E.sha_state(st) for st in states]
    if tuple(shas) != NET_SHA:
        raise SystemExit("STOP: d11 net state sha256 mismatch")
    L, nT = len(TIER_LV), len(HORIZONS)
    nets = []
    for st in states:
        n_ = NN.make_model("ngru", len(NN.STATIC) + 2 + nT, L)
        n_.load_state_dict(st)
        n_.eval()
        nets.append(n_)
    return nets, {"weights_sha256": WEIGHTS_SHA, "config_sha256": CONFIG_SHA, "net_state_sha256": list(shas),
                  "torch": torch.__version__, "threads": torch.get_num_threads(),
                  "cpu_capability": torch.backends.cpu.get_cpu_capability()}


def run_nets(nets, H, Dd, S, LF):
    """Mean residual logit over the 5 nets (float64) and p = running min over tier levels of sigmoid(LF + mean)."""
    import torch
    with torch.no_grad():
        h, d, s, lf = (torch.from_numpy(x) for x in (H, Dd, S, LF))
        rs = [(n_(h, d, s, lf) - lf).numpy() for n_ in nets]
    mres = np.mean(np.stack(rs).astype(np.float64), axis=0)
    p = 1 / (1 + np.exp(-(LF.astype(np.float64) + mres)))
    return np.clip(np.minimum.accumulate(p, axis=1), 0, 1), mres


# =====================================================================================================================
# per-series worker (fork pool): grid, development row, GRU inputs
# =====================================================================================================================
_W = {}


def _worker(args):
    e, origin, datasets, ldir, cut_after = args
    t0 = time.time()
    try:
        st, cols, vol = read_dev_grid(os.path.join(datasets, e["path"]))
        if cut_after:                  # no-look-ahead test: every bar opening at or after the origin is garbled
            j0 = (origin - st) // HOUR
            rng = np.random.default_rng(7)
            for c_ in cols:
                cols[c_][j0:] = rng.uniform(0.5, 2.0, max(0, len(cols[c_]) - j0)) * np.nanmax(cols[c_][:j0])
            if vol is not None:
                vol[j0:] = rng.uniform(0, 1e9, max(0, len(vol) - j0))
        rows = read_store(store_path(ldir, e["symbol"])) if ldir else []
        g, v = extend_grid(st, cols, vol, rows, origin)
        last = np.flatnonzero(np.isfinite(g["close"]))
        if len(last) == 0 or (origin - (st + HOUR * int(last[-1]))) > DELIST_DAYS * DAY:
            return e["symbol"], None, "no kline in the 30 days before the origin (delisted or halted)", time.time() - t0
        res, why = series_origin(e["key"], st, g, v, origin, _W["btc"])
        if res is None:
            return e["symbol"], None, why, time.time() - t0
        SA = series_arrays_from(res["ser"], v)
        out = {"S": res["S"], "T": {}}
        F = {k: np.array([res["T"][T]["feat"][k] for T in HORIZONS], np.float32) for k in NN.STATIC}
        H, Dd, Sx = NN.build_batch({0: SA}, np.zeros(3, np.int64), np.full(3, origin, np.int64), F,
                                   np.arange(3), len(HORIZONS))
        LF = np.zeros((3, len(TIER_LV)), np.float32)
        for jT, T in enumerate(HORIZONS):
            for j, k in enumerate(DEV_LV[T]):
                LF[jT, TIER_LV.index(k)] = RD.lg(res["T"][T]["fH"][j])
            out["T"][T] = {"fH": res["T"][T]["fH"], "fallback": res["T"][T]["fallback"],
                           "feat": {k: res["T"][T]["feat"][k] for k in NN.STATIC}}
        out["batch"] = (H, Dd, Sx, LF)
        return e["symbol"], out, None, time.time() - t0
    except Exception as ex:  # noqa: BLE001  (one series failing never stops the block; recorded as not issued)
        return e["symbol"], None, f"error {type(ex).__name__}: {str(ex)[:160]}", time.time() - t0


def btc_for(datasets, ldir, U, origin):
    e = [x for x in U["series"] if x["symbol"] == BTC_FEATURE][0]
    st, cols, vol = read_dev_grid(os.path.join(datasets, e["path"]))
    rows = read_store(store_path(ldir, BTC_FEATURE)) if ldir else []
    g, _ = extend_grid(st, cols, vol, rows, origin)
    return btc_arrays(st, g)


def compute_origin(datasets, ldir, U, origin, workers=4, log=print, garble=False, only=None):
    """Every series at one origin: {symbol: out or None}, {symbol: reason}, seconds per series."""
    import multiprocessing as mp
    _W["btc"] = btc_for(datasets, ldir, U, origin)
    jobs = [(e, origin, datasets, ldir, garble) for e in U["series"] if only is None or e["symbol"] in only]
    res, why, sec = {}, {}, {}
    if workers <= 1:
        it = map(_worker, jobs)
        for sym, out, w, s_ in it:
            res[sym], sec[sym] = out, s_
            if w:
                why[sym] = w
    else:
        with mp.get_context("fork").Pool(workers, maxtasksperchild=20) as pool:
            for sym, out, w, s_ in pool.imap(_worker, jobs, chunksize=1):
                res[sym], sec[sym] = out, s_
                if w:
                    why[sym] = w
    return res, why, sec


def forecast_rows(U, res, nets):
    """Frozen-D p on every issued series (one batch, rows ordered as the universe, T = 1, 3, 12)."""
    syms = [e["symbol"] for e in U["series"] if res.get(e["symbol"]) is not None]
    if not syms:
        return {}
    H = np.concatenate([res[s_]["batch"][0] for s_ in syms])
    Dd = np.concatenate([res[s_]["batch"][1] for s_ in syms])
    Sx = np.concatenate([res[s_]["batch"][2] for s_ in syms])
    LF = np.concatenate([res[s_]["batch"][3] for s_ in syms])
    p, mres = run_nets(nets, H, Dd, Sx, LF)
    out = {}
    for j, s_ in enumerate(syms):
        out[s_] = {}
        for jT, T in enumerate(HORIZONS):
            r = 3 * j + jT
            nlev = len(DEV_LV[T])
            out[s_][T] = {"D": p[r, :nlev], "res": mres[r, :nlev]}
    return out


# =====================================================================================================================
# issue
# =====================================================================================================================
def issue_dir(ldir):
    return os.path.join(ldir, D11_SUB, "issues")


def list_issues(ldir):
    d = issue_dir(ldir)
    if not os.path.isdir(d):
        return []
    return sorted(n for n in os.listdir(d) if n.endswith(".json.gz") and len(n) == len("YYYY-MM-DD.json.gz"))


def read_issue(ldir, name):
    with open(os.path.join(issue_dir(ldir), name), "rb") as f:
        raw = f.read()
    return json.loads(gzip.decompress(raw)), C.sha256_bytes(raw)


def verify_issue_chain(ldir):
    prev = C.ZERO_SHA
    for n in list_issues(ldir):
        doc, sha = read_issue(ldir, n)
        if doc.get("prevSha256") != prev or doc.get("date") != n[:10]:
            raise SystemExit(f"STOP: d11 issue chain broken at {n}")
        prev = sha
    return prev


def gz_json(obj):
    return gzip.compress(C.dumps(obj), compresslevel=9, mtime=0)


def f32(x):
    return [float(np.float32(v)) for v in x]


def issue(a, U, log=print, clock=time.time, http_get=None):
    datasets, ldir = a.datasets, C.live_dir(a.out)
    now = int(clock())
    origin = now - now % DAY
    check_universe(U, datasets)
    ensure_ci_replay(a, U, log=log)
    update_all(ldir, U, http_get=http_get, clock=clock, log=log)
    if origin < FIRST_ORIGIN:
        log(f"d11 issue: none (before the first origin {C.iso(FIRST_ORIGIN)})")
        return 0
    if now >= origin + MAX_LATE:
        log("d11 issue: none (run started 23 h or more after the origin)")
        return 0
    name = C.utc_date(origin) + ".json.gz"
    names = list_issues(ldir)
    if name in names:
        log("d11 issue: none (origin already issued)")
        return 0
    if names and names[-1] > name:
        raise SystemExit("STOP: d11 a later issue file exists (clock went backwards?)")
    prev = verify_issue_chain(ldir)
    cov = coverage(ldir)
    nets, model = load_nets(datasets)
    t0 = time.time()
    res, why, sec = compute_origin(datasets, ldir, U, origin, workers=a.workers, log=log)
    censor_all = set()                 # D11 amendment A: a store fetch after t never removes an issued series;
    for e in U["series"]:              # it stays in the day's set with every row censored (0 and its bound)
        s_ = e["symbol"]
        if res.get(s_) is not None and cov.get(s_, 0) < origin:
            censor_all.add(s_)
    retired = retired_symbols(ldir)
    for s_ in retired:
        if res.get(s_) is not None:
            res[s_], why[s_] = None, "retired earlier (30 days without a kline)"
    fc = forecast_rows(U, res, nets)
    series = []
    for e in U["series"]:
        s_ = e["symbol"]
        row = {"symbol": s_, "key": e["key"], "role": e["role"]}
        if res.get(s_) is None:
            row.update({"issued": False, "why": why.get(s_, "?")})
        else:
            r = res[s_]
            row.update({"issued": True, "S": r["S"],
                        "fH": {TL[T]: f32(r["T"][T]["fH"]) for T in HORIZONS},
                        "D": {TL[T]: [float(x) for x in fc[s_][T]["D"]] for T in HORIZONS},
                        "res": {TL[T]: [float(x) for x in fc[s_][T]["res"]] for T in HORIZONS},
                        "fHfallback": {TL[T]: bool(r["T"][T]["fallback"]) for T in HORIZONS},
                        "censorAll": (s_ in censor_all),
                        "censorWhy": ("kline store not fetched through the origin" if s_ in censor_all else None)})
        series.append(row)
    n_iss = sum(r["issued"] for r in series if r["role"] == "test")
    doc = {"schema": SCHEMA, "prereg": PREREG, "display": "none (log only; DO NOT SHOW)",
           "date": C.utc_date(origin), "origin": origin, "originIso": C.iso(origin), "issuedAt": now,
           "issuedAtIso": C.iso(now), "code": a.code,
           "model": model, "levels": {TL[T]: list(DEV_LV[T]) for T in HORIZONS},
           "universeSha256": C.sha256_file(universe_path()), "prevSha256": prev,
           "nTestIssued": n_iss, "nDescriptiveIssued": sum(r["issued"] for r in series if r["role"] != "test"),
           "modelSeconds": round(time.time() - t0, 1), "series": series}
    C.write_exclusive(os.path.join(issue_dir(ldir), name), gz_json(doc))
    log(f"d11 issue: {n_iss} test series issued, {sum(1 for r in series if not r['issued'])} not issued")
    return 0


def retired_symbols(ldir):
    """Symbols that once had no kline for 30 days before an origin: out of the panel for good (symbol-reuse guard)."""
    out = set()
    for n in list_issues(ldir):
        doc, _ = read_issue(ldir, n)
        for r in doc["series"]:
            if not r["issued"] and str(r.get("why", "")).startswith(("no kline in the 30 days", "retired earlier")):
                out.add(r["symbol"])
    return out


# =====================================================================================================================
# truth (the development label on the D11 grid)
# =====================================================================================================================
def labels_for(entry, ldir, origin, S, cov):
    """{T: y list (None = censored)} or None when the store has not yet been fetched through origin + 12 h."""
    sym = entry["symbol"]
    if cov.get(sym, 0) < origin + 12 * HOUR:
        return None
    rows = read_store(store_path(ldir, sym))
    low = np.full(12, np.nan)
    for r in rows:
        j = (int(r[0]) // 1000 - origin) // HOUR
        if 0 <= j < 12:
            low[j] = float(r[3])
    out = {}
    for T in HORIZONS:
        wmin = M3.window_min_null_rule(low[:T], T)[0]
        if not np.isfinite(wmin) or not (S > 0):
            out[T] = None
            continue
        depth = math.log(wmin / S)
        out[T] = [int(depth <= math.log1p(k)) for k in DEV_LV[T]]
    return out


# =====================================================================================================================
# recalibration (Platt per arm and cell, walk-forward)
# =====================================================================================================================
def lgc(p):
    p = np.clip(np.asarray(p, float), PCLIP_RECAL, 1 - PCLIP_RECAL)
    return np.log(p / (1 - p))


def platt_fit(x, y):
    from scipy.optimize import minimize

    def f(w):
        z = w[0] + w[1] * x
        return float(np.sum(np.logaddexp(0, z) - y * z))

    def gr(w):
        s_ = 1 / (1 + np.exp(-(w[0] + w[1] * x)))
        return np.array([np.sum(s_ - y), np.sum((s_ - y) * x)])
    return minimize(f, np.array([0.0, 1.0]), jac=gr, method="L-BFGS-B").x


CELLS = [(T, k) for T in HORIZONS for k in DEV_LV[T]]


def cell_name(T, k):
    return f"{TL[T]} {k}"


class CalPool:
    """Calibration rows by cell: origin ts, p_fH, p_D, y (frozen development rows, then live rows as days finalize)."""

    def __init__(self, devcal):
        Z = np.load(devcal)
        self.dev, self.live = {}, {}
        for c in CELLS:
            nm = cell_name(*c).replace(" ", "_")
            self.dev[c] = {f: np.asarray(Z[f"{nm}_{f}"]) for f in ("ts", "fH", "D", "y")}
            self.live[c] = {f: [] for f in ("ts", "fH", "D", "y")}

    def add(self, origin, T, k, pH, pD, y):
        r = self.live[(T, k)]
        r["ts"].append(int(origin))
        r["fH"].append(float(pH))
        r["D"].append(float(pD))
        r["y"].append(int(y))

    def cell(self, c):
        d, l_ = self.dev[c], self.live[c]
        return {"ts": np.concatenate([d["ts"].astype(np.int64), np.array(l_["ts"], np.int64)]),
                "fH": np.concatenate([d["fH"].astype(np.float64), np.array(l_["fH"], np.float64)]),
                "D": np.concatenate([d["D"].astype(np.float64), np.array(l_["D"], np.float64)]),
                "y": np.concatenate([d["y"].astype(np.float64), np.array(l_["y"], np.float64)])}

    def maps(self, origin):
        out = {}
        for c in CELLS:
            r = self.cell(c)
            m = (r["ts"] >= origin - RECAL_DAYS * DAY) & (r["ts"] <= origin - DAY)
            y = r["y"][m]
            out[c] = {}
            for arm in ("fH", "D"):
                if m.sum() < RECAL_MIN_ROWS or y.sum() < RECAL_MIN_POS:
                    out[c][arm] = (0.0, 1.0, int(m.sum()), int(y.sum()), "identity")
                    continue
                w = platt_fit(lgc(r[arm][m]), y)
                out[c][arm] = (float(w[0]), float(w[1]), int(m.sum()), int(y.sum()), "platt")
        return out


def apply_maps(maps, T, arm, p):
    q = np.array([1 / (1 + math.exp(-(maps[(T, k)][arm][0] + maps[(T, k)][arm][1] * float(lgc(pp)))))
                  for k, pp in zip(DEV_LV[T], p)])
    return np.minimum.accumulate(q)


# =====================================================================================================================
# e-process (aGRAPA with a development prior, truncated by a predictable bound)
# =====================================================================================================================
def grapa_step(state, delta, B, m0, v0):
    """state {n, s1, s2, logK}; returns the new state and the bet. lambda uses only earlier days and B (known at the
    origin)."""
    n, s1, s2 = state["n"], state["s1"], state["s2"]
    mh = (N0 * m0 + s1) / (N0 + n)
    vh = (N0 * v0 + s2) / (N0 + n)
    lam = min(max(mh / vh, 0.0), CAP_FRAC / B) if B > 0 else 0.0
    logK = state["logK"] + math.log1p(lam * delta)
    return {"n": n + 1, "s1": s1 + delta, "s2": s2 + delta * delta, "logK": logK}, lam


def day_delta(rows, maps, T, levels):
    """rows: [(pH list, pD list, y list or None)] over issued test series. Delta = (1/N) sum over labelled rows of
    (qH - y)^2 - (qD - y)^2 (N = issued rows, censored rows add 0); L, U = (1/N) sum over issued rows of the per-row
    min(0, .) / max(0, .) over y in {0, 1}; B = max(-L, U)."""
    idx = [DEV_LV[T].index(k) for k in levels]
    N, num, lo, hi, sy, sqD, sqH, nlab, pess = 0, 0.0, 0.0, 0.0, 0, 0.0, 0.0, 0, 0.0
    for pH, pD, y in rows:
        qH = apply_maps(maps, T, "fH", pH)
        qD = apply_maps(maps, T, "D", pD)
        for j in idx:
            N += 1
            a0, a1 = qH[j] ** 2 - qD[j] ** 2, (1 - qH[j]) ** 2 - (1 - qD[j]) ** 2
            lo += min(0.0, a0, a1)
            hi += max(0.0, a0, a1)
            if y is None:
                pess += min(a0, a1)            # pessimistic: a censored row takes its worst outcome for D
            else:
                num += a1 if y[j] else a0
                pess += a1 if y[j] else a0
                sy += y[j]
                sqD += qD[j]
                sqH += qH[j]
                nlab += 1
    if N == 0:
        return None
    L, U = lo / N, hi / N
    return {"delta": num / N, "deltaPess": pess / N, "L": L, "U": U, "B": max(-L, U), "N": N, "labelled": nlab, "pos": sy,
            "sum_qD": sqD, "sum_qH": sqH}


# =====================================================================================================================
# score
# =====================================================================================================================
def ledger_path(ldir):
    return os.path.join(ldir, D11_SUB, "ledger.jsonl")


def read_ledger(ldir):
    p = ledger_path(ldir)
    out, prev = [], C.ZERO_SHA
    if not os.path.exists(p):
        return out, prev
    with open(p, "rb") as f:
        for raw in f.read().splitlines(keepends=True):
            if not raw.strip():
                continue
            d = json.loads(raw)
            if d.get("prevSha256") != prev:
                raise SystemExit("STOP: d11 ledger hash chain broken")
            prev = C.sha256_bytes(raw)
            out.append(d)
    return out, prev


def outcomes_path(ldir, origin):
    return os.path.join(ldir, D11_SUB, "outcomes", f"outcomes-{C.utc_date(origin)[:7]}.jsonl")


def read_outcomes(ldir):
    """{sha256 of the line bytes: outcome} over every outcome line (orphan lines from a crash included)."""
    d = os.path.join(ldir, D11_SUB, "outcomes")
    out = {}
    if os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            with open(os.path.join(d, n), "rb") as f:
                for raw in f.read().splitlines(keepends=True):
                    if raw.strip():
                        out[C.sha256_bytes(raw)] = json.loads(raw)
    return out


def nw_z(x, lag):
    x = np.asarray(x, float)
    n = len(x)
    c = x - x.mean()
    v = float(c @ c) / n
    for j in range(1, lag + 1):
        v += 2 * (1 - j / (lag + 1)) * float(c[j:] @ c[:-j]) / n
    return float(x.mean() / math.sqrt(max(v, 1e-30) / n))


def fixed_read(deltas, R3):
    from scipy.stats import norm
    d = np.asarray(deltas, float)
    z = nw_z(d, FIXED_LAG)
    rng = np.random.default_rng(BOOT_SEED)
    nb = int(math.ceil(len(d) / 7))
    starts = rng.integers(0, len(d) - 6, size=(BOOT_B, nb))
    bm = np.array([np.concatenate([d[s_:s_ + 7] for s_ in row])[:len(d)].mean() for row in starts])
    p_boot = float(np.mean(bm - d.mean() >= d.mean()))
    return {"days": len(d), "mean_delta": float(d.mean()), "nw_lag": FIXED_LAG, "z": z, "p_hac": float(1 - norm.cdf(z)),
            "p_boot_weekly": p_boot, "R3_recal_D": R3, "R_band": list(R_BAND),
            "pass_reported_only": bool(d.mean() > 0 and 1 - norm.cdf(z) < ALPHA and p_boot < ALPHA
                                       and R_BAND[0] <= R3 <= R_BAND[1])}


def score(a, U, log=print, clock=time.time, http_get=None):
    datasets, ldir = a.datasets, C.live_dir(a.out)
    ensure_ci_replay(a, U, log=log)
    update_all(ldir, U, http_get=http_get, clock=clock, log=log)
    now = int(clock())
    names = list_issues(ldir)
    verify_issue_chain(ldir)
    led, prev = read_ledger(ldir)
    done = {d["origin"] for d in led}
    todo = [n for n in names if read_issue(ldir, n)[0]["origin"] not in done]
    if not todo:
        log(f"d11 scored: 0 days finalized, 0 pending, ledger {len(led)} days")
        write_summary(ldir, led)
        return 0
    if C.sha256_file(os.path.join(datasets, a.devcal)) != a.devcal_sha256:
        raise SystemExit("STOP: d11 devcal sha256 mismatch")
    pool = CalPool(os.path.join(datasets, a.devcal))
    tests = {e["symbol"] for e in U["series"] if e["role"] == "test"}
    outs = read_outcomes(ldir)
    for d_ in led:                                     # live calibration rows: the outcome line each ledger line names
        o = outs.get(d_["outcomeSha256"])
        if o is None or o["origin"] != d_["origin"]:
            raise SystemExit(f"STOP: d11 outcome line named by the ledger for {d_['date']} is missing")
        for r in o["series"]:
            if r["symbol"] in tests and r.get("y"):
                for T in HORIZONS:
                    y = r["y"].get(TL[T])
                    if y is not None:
                        for j, k in enumerate(DEV_LV[T]):
                            pool.add(o["origin"], T, k, r["fH"][TL[T]][j], r["D"][TL[T]][j], y[j])
    cov = coverage(ldir)
    state = led[-1]["state"] if led else {"status": STATUS_PROVING, "events": [], "obs": 0,
                                         "primary": {"n": 0, "s1": 0.0, "s2": 0.0, "logK": 0.0},
                                         "harm": {"n": 0, "s1": 0.0, "s2": 0.0, "logK": 0.0},
                                         "sec": {TL[T]: {"n": 0, "s1": 0.0, "s2": 0.0, "logK": 0.0} for T in (1, 12)},
                                         "sum_qD3": 0.0, "sum_y3": 0, "fixed": None}
    deltas = [d["primary"]["delta"] for d in led if d.get("primary")]
    n_fin, n_pend = 0, 0
    for name in todo:
        doc, _ = read_issue(ldir, name)
        t = doc["origin"]
        if now < t + 12 * HOUR + RESOLVE_MARGIN:
            n_pend += 1
            break
        ys, waiting = {}, False
        for e in U["series"]:
            r = [x for x in doc["series"] if x["symbol"] == e["symbol"]][0]
            if not r["issued"]:
                continue
            lab = ({T: None for T in HORIZONS} if r.get("censorAll") else labels_for(e, ldir, t, r["S"], cov))
            if lab is None:
                if now < t + 12 * HOUR + GIVE_UP:
                    waiting = True
                    break
                lab = {T: None for T in HORIZONS}
            ys[e["symbol"]] = lab
        if waiting:
            n_pend += 1
            break
        maps = pool.maps(t)
        series_out, rows_T = [], {T: [] for T in HORIZONS}
        desc = {}
        for r in doc["series"]:
            if not r["issued"]:
                continue
            lab = ys[r["symbol"]]
            y_out = {TL[T]: lab[T] for T in HORIZONS}
            series_out.append({"symbol": r["symbol"], "role": r["role"], "fH": r["fH"], "D": r["D"], "y": y_out})
            for T in HORIZONS:
                item = (r["fH"][TL[T]], r["D"][TL[T]], lab[T])
                if r["role"] == "test":
                    rows_T[T].append(item)
                else:
                    desc.setdefault(r["symbol"], {})[TL[T]] = day_delta([item], maps, T, D8_LV[T])
        n_series = sum(1 for r in doc["series"] if r["issued"] and r["role"] == "test")
        not_issued = {}
        for r in doc["series"]:
            if r["role"] == "test" and not r["issued"]:
                w_ = str(r.get("why", "?")).split(":")[0][:60]
                not_issued[w_] = not_issued.get(w_, 0) + 1
        observed = n_series >= MIN_SERIES_DAY
        line = {"schema": SCHEMA + "/ledger", "date": doc["date"], "origin": t, "nSeriesIssued": n_series,
                "observed": observed, "recal": {cell_name(*c): {arm: list(maps[c][arm]) for arm in ("fH", "D")}
                                               for c in CELLS}}
        prim = day_delta(rows_T[PRIMARY_T], maps, PRIMARY_T, D8_LV[PRIMARY_T])
        line["notIssued"] = not_issued
        line["censorAllSeries"] = sum(1 for r in doc["series"] if r["issued"] and r["role"] == "test"
                                      and r.get("censorAll"))
        secs = {T: day_delta(rows_T[T], maps, T, D8_LV[T]) for T in (1, 12)}
        st = json.loads(json.dumps(state))
        st["events"] = []
        st.pop("deltas", None)
        if observed and prim is not None:
            st["obs"] += 1
            st["primary"], lam = grapa_step(st["primary"], prim["delta"], prim["B"], 0.5 * DEV_MU[3], DEV_V0[3])
            st["harm"], lamh = grapa_step(st["harm"], -prim["delta"], prim["B"], 0.0, DEV_V0[3])
            st.setdefault("pess", {"n": 0, "s1": 0.0, "s2": 0.0, "logK": 0.0})
            st["pess"], _ = grapa_step(st["pess"], prim["deltaPess"], prim["B"], 0.5 * DEV_MU[3], DEV_V0[3])
            for T in (1, 12):
                if secs[T] is not None:
                    st["sec"][TL[T]], _ = grapa_step(st["sec"][TL[T]], secs[T]["delta"], secs[T]["B"],
                                                     0.5 * DEV_MU[T], DEV_V0[T])
            deltas.append(prim["delta"])
            st["sum_qD3"] += prim["sum_qD"]
            st["sum_y3"] += prim["pos"]
            R3 = st["sum_qD3"] / st["sum_y3"] if st["sum_y3"] > 0 else None
            line["primary"] = dict(prim, lam=lam, lamHarm=lamh, logK=st["primary"]["logK"],
                                   logKharm=st["harm"]["logK"], logKpess=st["pess"]["logK"], R3=R3,
                                   censoredShare=1 - prim["labelled"] / prim["N"])
            line["secondary"] = {TL[T]: (dict(secs[T], logK=st["sec"][TL[T]]["logK"]) if secs[T] else None)
                                 for T in (1, 12)}
            n_obs = st["obs"]
            thr = math.log(1 / ALPHA)
            if st["status"] == STATUS_PROVING:
                if st["primary"]["logK"] >= thr and R3 is not None and R_BAND[0] <= R3 <= R_BAND[1]:
                    st["status"] = "graduated"
                elif st["primary"]["logK"] >= thr:
                    st["events"].append("e-value crossed 1/alpha but the R guard failed (stays proving)")
                if st["status"] == STATUS_PROVING and st["harm"]["logK"] >= thr:
                    st["status"] = "retired: worse than (fH) (harm e-process crossed 1/alpha)"
                if st["status"] == STATUS_PROVING and n_obs in FUTILITY_DAYS and np.mean(deltas) <= 0:
                    st["status"] = f"retired: futility (mean daily difference <= 0 at {n_obs} days)"
                if st["status"] == STATUS_PROVING and n_obs >= CAP_DAYS:
                    st["status"] = f"retired: not confirmed by {CAP_DAYS} days"
                if st["status"] != STATUS_PROVING:
                    st["events"].append(f"status -> {st['status']}")
            if n_obs == FIXED_DAYS:
                st["fixed"] = fixed_read(deltas, R3)
                line["fixed450"] = st["fixed"]
        line["descriptive"] = desc
        line["state"] = st
        line["prevSha256"] = prev
        oraw = (json.dumps(C.clean({"date": doc["date"], "origin": t, "series": series_out}),
                           separators=(",", ":")) + "\n").encode()
        line["outcomeSha256"] = C.sha256_bytes(oraw)
        raw = (json.dumps(C.clean(line), separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()
        C.append_bytes(outcomes_path(ldir, t), oraw)
        C.append_bytes(ledger_path(ldir), raw)    # a crash between the two appends leaves an orphan outcome line,
        #                                           which no ledger line names (ignored; the day is redone)
        prev = C.sha256_bytes(raw)
        led.append(line)
        state = st
        for r in series_out:                         # this day's rows join the calibration pool for later days
            if r["symbol"] in tests:
                for T in HORIZONS:
                    y = r["y"][TL[T]]
                    if y is not None:
                        for j, k in enumerate(DEV_LV[T]):
                            pool.add(t, T, k, r["fH"][TL[T]][j], r["D"][TL[T]][j], y[j])
        n_fin += 1
    n_pend = max(n_pend, len(todo) - n_fin)
    log(f"d11 scored: {n_fin} days finalized, {n_pend} pending, ledger {len(led)} days")
    write_summary(ldir, led)
    return 0


def write_summary(ldir, led):
    deltas = [d["primary"]["delta"] for d in led if d.get("primary")]
    last = led[-1] if led else None
    st = last["state"] if last else None
    summ = {"schema": SCHEMA + "/summary", "display": "none (log only; DO NOT SHOW)", "ledgerDays": len(led),
            "observedDays": st["obs"] if st else 0, "status": st["status"] if st else STATUS_PROVING,
            "eValuePrimary": math.exp(st["primary"]["logK"]) if st else 1.0,
            "eValueHarm": math.exp(st["harm"]["logK"]) if st else 1.0,
            "eValuePessimistic_reportOnly": math.exp(st["pess"]["logK"]) if st and "pess" in st else 1.0,
            "eValueSecondary": {k: math.exp(v["logK"]) for k, v in st["sec"].items()} if st else None,
            "threshold": 1 / ALPHA, "meanDailyDelta3h": (float(np.mean(deltas)) if deltas else None),
            "R3_recal_D": (st["sum_qD3"] / st["sum_y3"]) if st and st["sum_y3"] else None,
            "fixed450": st["fixed"] if st else None, "lastDate": last["date"] if last else None}
    C.write_atomic(os.path.join(ldir, D11_SUB, "summary.json"), C.dumps(summ))


# =====================================================================================================================
# instrument replay (development day) -- run locally before deployment and once on the CI runner (recorded)
# =====================================================================================================================
def replay(datasets, U, golden, workers=4, log=print):
    """Live code on the development grids at REPLAY_ORIGIN vs the development rows (fH and the 12 GRU features, bit
    for bit) and vs the local frozen-D p (tolerance GOLDEN_TOL); plus the no-look-ahead check (bars after the origin
    garbled on 5 series: identical rows)."""
    G = np.load(golden)
    gkeys = [str(k) for k in G["keys"]]
    res, why, sec = compute_origin(datasets, None, U, REPLAY_ORIGIN, workers=workers)
    nets, model = load_nets(datasets)
    fc = forecast_rows(U, res, nets)
    sym_of = {e["key"]: e["symbol"] for e in U["series"]}
    n_cmp, n_fh_eq, n_ft_eq, n_missing, max_dp = 0, 0, 0, 0, 0.0
    bad = []
    for gi, key in enumerate(gkeys):
        s_ = sym_of[key]
        for T in HORIZONS:
            if not G[f"have_T{T}"][gi]:
                continue
            n_cmp += 1
            r = res.get(s_)
            if r is None:
                n_missing += 1
                bad.append([s_, TL[T], "not computed: " + str(why.get(s_))])
                continue
            fh_ok = np.array_equal(np.asarray(r["T"][T]["fH"], np.float32), G[f"fH_T{T}"][gi][:len(DEV_LV[T])])
            gf = G[f"feat_T{T}"][gi]
            lf = np.array([r["T"][T]["feat"][k] for k in NN.STATIC], np.float32)
            ft_ok = bool(np.all((lf == gf) | (np.isnan(lf) & np.isnan(gf))))
            n_fh_eq += fh_ok
            n_ft_eq += ft_ok
            if not (fh_ok and ft_ok):
                bad.append([s_, TL[T], "fH" if not fh_ok else "features"])
            dp = float(np.max(np.abs(fc[s_][T]["D"] - G[f"pD_T{T}"][gi][:len(DEV_LV[T])])))
            max_dp = max(max_dp, dp)
    look = [e["symbol"] for e in U["series"] if e["role"] == "test"][:5]
    res_g, _, _ = compute_origin(datasets, None, U, REPLAY_ORIGIN, workers=workers, garble=True, only=set(look))
    la_ok = all(res_g[s_] is not None and res[s_] is not None and all(
        np.array_equal(res_g[s_]["T"][T]["fH"], res[s_]["T"][T]["fH"]) and
        all(np.array_equal(x, y) for x, y in zip(res_g[s_]["batch"], res[s_]["batch"])) for T in HORIZONS)
        for s_ in look)
    ok = (n_cmp > 0 and n_missing == 0 and n_fh_eq == n_cmp and n_ft_eq == n_cmp and max_dp <= GOLDEN_TOL and la_ok)
    out = {"replayOrigin": C.iso(REPLAY_ORIGIN), "compared": n_cmp, "fH_equal": n_fh_eq, "features_equal": n_ft_eq,
           "missing": n_missing, "maxAbsDiff_pD_vs_local": max_dp, "tolerance_pD": GOLDEN_TOL,
           "noLookAhead_series": len(look), "noLookAhead_equal": bool(la_ok), "mismatches": bad[:20],
           "model": model, "python": sys.version.split()[0], "numpy": np.__version__,
           "secondsPerSeries_median": float(np.median(list(sec.values()))), "pass": bool(ok)}
    log(f"d11 replay: {n_fh_eq} of {n_cmp} (fH) equal, {n_ft_eq} of {n_cmp} features equal, "
        f"{int(la_ok) * len(look)} of {len(look)} look-ahead equal")
    return out


def ensure_ci_replay(a, U, log=print):
    """The first run on the CI runner records the replay (checks/ci-replay.json, written once). The block refuses to
    issue or score unless that record exists and passed (fail closed)."""
    ldir = C.live_dir(a.out)
    p = os.path.join(ldir, D11_SUB, "checks", "ci-replay.json")
    if os.path.exists(p):
        rec = json.load(open(p))
        if not rec.get("pass"):
            raise SystemExit("STOP: d11 CI replay record failed; the block stays closed")
        return rec
    if C.sha256_file(os.path.join(a.datasets, a.golden)) != a.golden_sha256:
        raise SystemExit("STOP: d11 golden replay file sha256 mismatch")
    check_universe(U, a.datasets)
    rec = replay(a.datasets, U, os.path.join(a.datasets, a.golden), workers=a.workers, log=log)
    rec.update({"code": a.code, "recordedAt": C.iso(int(time.time()))})
    C.write_exclusive(p, C.dumps(rec))
    if not rec["pass"]:
        raise SystemExit("STOP: d11 CI replay failed (record written; the block stays closed)")
    return rec


# =====================================================================================================================
# development inputs (built once, published to membrane-datasets history-forecasts/r16/d11-inputs/)
# =====================================================================================================================
def build_inputs(a, U):
    """devcal.npz: per cell, the 273 test series' development daily rows with origin in [FIRST_ORIGIN - 730 d,
    2026-10-01): ts, raw (fH) (development float32), raw D (walk-forward E1 rule-D ensemble, D-R16.2e-f), y.
    replay-golden.npz: the development (fH) and GRU features at REPLAY_ORIGIN and the local frozen-D p."""
    rows_dir, cd = a.rows, os.path.join(a.datasets, "history-forecasts/r16/r162e-cd-c41dff8f")
    keys = json.load(open(os.path.join(rows_dir, "rows-meta.json")))["series"]
    excl = json.load(open(os.path.join(cd, "excluded.json")))
    tests = {e["key"] for e in U["series"] if e["role"] == "test"}
    parts = []
    for T in HORIZONS:
        Z = np.load(os.path.join(rows_dir, f"rows-T{T}.npz"))
        n = len(Z["ts"])
        Y = np.full((n, 5), -1, np.int8)
        P = np.full((n, 5), np.nan, np.float64)
        for j, k in enumerate(DEV_LV[T]):
            c = TIER_LV.index(k)
            Y[:, c] = Z["y"][:, j]
            P[:, c] = Z["fH"][:, j]
        parts.append({"sid": Z["sid"], "ts": Z["ts"], "Y": Y, "P": P, "T": np.full(n, T, np.int32)})
        if T == 1:
            gold_rows = {}
        m = Z["ts"] == REPLAY_ORIGIN
        fsel = {k: np.asarray(Z[k])[m] for k in NN.STATIC}
        fh_m, sid_m = Z["fH"][m], Z["sid"][m]
        gold_rows[T] = {int(s_): (fh_m[jj], np.array([fsel[k][jj] for k in NN.STATIC], np.float32))
                        for jj, s_ in enumerate(sid_m)}
        del Z, fsel
    X = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    del parts
    keep = ~np.array([k in excl for k in keys])[X["sid"]]
    M = np.load(os.path.join(cd, "cd-mean-residuals.npz"))
    g = np.flatnonzero(keep)[M["idx"]]
    sid, ts, T_, Y, PH = X["sid"][g], X["ts"][g], X["T"][g], X["Y"][g], X["P"][g]
    msk = Y >= 0
    LF = np.zeros_like(PH)
    LF[msk] = RD.lg(PH[msk])
    LF = LF.astype(np.float32).astype(np.float64)          # tier_rows stores LF as float32
    PD = np.clip(np.minimum.accumulate(1 / (1 + np.exp(-(LF + M["D_E1"].astype(np.float64)))), axis=1), 0, 1)
    is_test = np.array([k in tests for k in keys])[sid]
    win = is_test & (ts >= FIRST_ORIGIN - RECAL_DAYS * DAY) & (ts % DAY == 0)
    out = {}
    for (T, k) in CELLS:
        c = TIER_LV.index(k)
        r = win & (T_ == T) & msk[:, c]
        nm = cell_name(T, k).replace(" ", "_")
        out[f"{nm}_ts"] = ts[r].astype(np.int64)
        out[f"{nm}_fH"] = PH[r, c].astype(np.float32)
        out[f"{nm}_D"] = PD[r, c].astype(np.float64)
        out[f"{nm}_y"] = Y[r, c].astype(np.int8)
    os.makedirs(a.inputs_out, exist_ok=True)
    np.savez_compressed(os.path.join(a.inputs_out, "devcal.npz"), **out)
    # golden replay
    gkeys = [k for k in keys if k in tests]
    res, why, _ = compute_origin(a.datasets, None, U, REPLAY_ORIGIN, workers=a.workers)
    nets, model = load_nets(a.datasets)
    fc = forecast_rows(U, res, nets)
    sym_of = {e["key"]: e["symbol"] for e in U["series"]}
    G = {"keys": np.array(gkeys)}
    for T in HORIZONS:
        n = len(gkeys)
        G[f"have_T{T}"] = np.zeros(n, bool)
        G[f"fH_T{T}"] = np.full((n, 5), np.nan, np.float32)
        G[f"feat_T{T}"] = np.full((n, len(NN.STATIC)), np.nan, np.float32)
        G[f"pD_T{T}"] = np.full((n, 5), np.nan, np.float64)
        for gi, key in enumerate(gkeys):
            s_id = keys.index(key)
            if s_id in gold_rows[T] and res.get(sym_of[key]) is not None:
                G[f"have_T{T}"][gi] = True
                G[f"fH_T{T}"][gi, :len(DEV_LV[T])] = gold_rows[T][s_id][0]
                G[f"feat_T{T}"][gi] = gold_rows[T][s_id][1]
                G[f"pD_T{T}"][gi, :len(DEV_LV[T])] = fc[sym_of[key]][T]["D"]
    np.savez_compressed(os.path.join(a.inputs_out, "replay-golden.npz"), **G)
    print("devcal rows per cell", {k[:-3]: int(len(v)) for k, v in out.items() if k.endswith("_ts")})
    print("golden", {T: int(G[f"have_T{T}"].sum()) for T in HORIZONS}, "of", len(gkeys), "model", model)


# =====================================================================================================================
# CLI
# =====================================================================================================================
D11_FILES = ("live/q26_live_d11.py", "live/d11_universe.json", "live/q26_live_common.py", "a3_touch.py", "a6_touch.py",
             "r12_tail.py", "r16_dev.py", "r16_nn.py", "r162e_ens.py", "a2_touch.py", "a_touch.py")


def code_meta(expect_commit=None):
    import subprocess

    def git(*args):
        r = subprocess.run(["git", "-C", MODEL_DIR, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    commit = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain", "--", *D11_FILES)
    if expect_commit is not None and commit != expect_commit:
        raise SystemExit(f"STOP: code checkout is at {commit}, expected the pinned commit {expect_commit}")
    if expect_commit is not None and dirty:
        raise SystemExit("STOP: d11 code files differ from the pinned commit")
    return {"repo": "The-Membrane/membrane-app", "commit": commit, "dirty": bool(dirty),
            "python": sys.version.split()[0], "numpy": np.__version__}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("issue", "score", "replay"):
        s = sub.add_parser(name)
        s.add_argument("--datasets", required=True)
        s.add_argument("--out", required=True)
        s.add_argument("--expect-commit", default=None)
        s.add_argument("--devcal", required=True)
        s.add_argument("--devcal-sha256", required=True)
        s.add_argument("--golden", required=True)
        s.add_argument("--golden-sha256", required=True)
        s.add_argument("--workers", type=int, default=4)
    s = sub.add_parser("build-inputs")
    s.add_argument("--datasets", required=True)
    s.add_argument("--rows", required=True)
    s.add_argument("--inputs-out", required=True)
    s.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(argv)
    U = load_universe()
    if a.cmd == "build-inputs":
        return build_inputs(a, U)
    a.code = code_meta(a.expect_commit)
    log = (lambda *x: print(*x, flush=True))
    if C.sha256_file(os.path.join(a.datasets, a.devcal)) != a.devcal_sha256:
        raise SystemExit("STOP: d11 devcal sha256 mismatch")
    if a.cmd == "replay":
        rec = replay(a.datasets, U, os.path.join(a.datasets, a.golden), workers=a.workers, log=log)
        print(json.dumps(C.clean(rec), indent=1), file=sys.stderr)
        return 0 if rec["pass"] else 1
    return {"issue": issue, "score": score}[a.cmd](a, U, log=log)


if __name__ == "__main__":
    sys.exit(main())
