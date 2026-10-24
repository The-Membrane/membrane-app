#!/usr/bin/env python3
"""Q26 live forecast log -- D12: live calibration monitor for the CALIBRATED-WARN borrower-warning cells.

membrane-board design/HISTORY_TOUCH_LIVE.md Deviation D12 (owner ruling 2026-10-24, board e06202c: calibrated,
informative raw (fH) odds may drive borrower warnings "with live tracking"; knowledge/q26-ui-confidence-map.md class
CALIBRATED-WARN). Evidence: design/Q26_ROUND19_PREREG.md D-R19.2-review.

This module is its own block of the live log, with its own store under forecasts/q26-touch-live/d12/. It never reads
or writes the main issue files or the D11 block, so those are byte-identical with or without it.

Issue (q26_live_d12.py issue; inside the existing 00:17Z run, no new schedule):
  origin    the daily 00:00Z origin t of the UTC day of the run, logged at most once, only when the run starts before
            t + 23 h (no backfill). One issue file per origin: d12/issues/YYYY-MM-DD.json.gz, hash-chained.
  series    Binance ETHUSDT, BTCUSDT (group ETHBTC) and the 18 A2/A3 large caps of the R16.2/R19.2 development pool
            (group LARGE), spot USDT hourly klines (data-api.binance.vision, free, public).
  inputs    the frozen development kline grid of each series (membrane-datasets, sha256-checked) plus the D12 kline
            store d12/klines/<SYMBOL>.csv.gz (every closed hourly kline after the development grid ends). Only bars
            that open before t are read.
  (fH)      raw, exactly the R19.2 development (fH) (r192_borrower.task, which is r16_dev.task at the L8 levels): HAR
            coefficients and the FHS z set of the quarter fold that contains t (training origins i <= qs - T), (f)
            fallback where sigma_H is undefined, running minimum over the L8 ladder (-2 ... -30%), float32. No Platt.
  (a)       plain history as r192_borrower.task: the expanding frequency of the training depths (i <= qs - T).
Score (q26_live_d12.py score; inside the existing 00:47Z run):
  truth     y = 1 iff the minimum hourly Binance low over (t, t + T] <= S (1 + k), S = the close of the hour ending
            at t (the R19.2 spot label: a3_touch.window_min_null_rule on the hourly lows, depth ln(wmin/S) <= ln(1+k)).
  monitor   per monitor group (cell x asset group), two one-sided e-processes on the daily sums (day = unit):
            side A (over-forecast, R > 1.25): X = sum p / 1.25 - sum y; side B (under-forecast, R < 0.8):
            X = sum y - sum p / 0.8. Bets are aGRAPA plug-ins truncated by a bound known at the origin and use only
            outcomes resolved before the origin. Overlap: horizon T >= 1 d spans h = T / 1 d daily origins, so the
            days split into h interleaved subsequences (one test supermartingale each); the group's e-value is
            max_j (K_A,j + K_B,j) / 2 against the threshold h / alpha (Bonferroni over the subsequences).
            Downgrade CALIBRATED-WARN -> CALIBRATED (terminal) at the first crossing with the cumulative point R
            outside 0.8-1.25. The class flag is written in the ledger and in d12/classes.json for the UI.
No address, key or secret is read or written. Public endpoint only (data-api.binance.vision).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import copy  # noqa: E402
import gzip  # noqa: E402
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
import a2_touch as M2  # noqa: E402  (imported, never modified)
import a3_touch as M3  # noqa: E402
import a6_touch as A6  # noqa: E402
import r12_tail as R12  # noqa: E402

HOUR, DAY = C.HOUR, C.DAY
D12_SUB = "d12"
SCHEMA = "q26-touch-live/d12/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "deviation": "D12",
          "ruling": "board e06202c (owner 2026-10-24, 'Yes, with live tracking')"}
TS = (6, 12, 24, 72, 168)
TL = {6: "6h", 12: "12h", 24: "1d", 72: "3d", 168: "7d"}
L8 = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.30)   # r192_borrower.L8 (the running-minimum ladder)
CELLS = ((6, -0.10), (12, -0.10), (24, -0.10), (72, -0.10), (168, -0.10), (24, -0.20), (72, -0.20), (168, -0.20))
GROUPS = ("ETHBTC", "LARGE")
FIRST_ORIGIN = C.A.utc("2026-10-25T00:00:00Z")        # first daily origin after the D12 registration (no earlier one)
MAX_LATE = 23 * HOUR                                  # an origin is logged only by a run starting before t + 23 h
KLINE_HEADER = ["openTime", "open", "high", "low", "close", "volume", "closeTime"]
RESOLVE_MARGIN = 900                                  # due at the first scorer run >= 15 min after t + T
GIVE_UP = 72 * HOUR                                   # a store still not covering t + T 72 h later -> censored
DELIST_DAYS = 30
ALPHA = 0.05
R_BAND = (0.8, 1.25)
CAP_FRAC = 0.5                                        # lambda <= CAP_FRAC / B (B known at the origin)
N0 = 30                                               # prior weight (days) of the plug-in; m0 = 0 on both sides
CLASS_WARN, CLASS_DOWN = "CALIBRATED-WARN", "CALIBRATED"
REPLAY_ORIGINS = ("2025-03-15T00:00:00Z", "2026-01-20T00:00:00Z", "2026-09-01T00:00:00Z")
LOOKAHEAD_N = 5
BOOT_B, BOOT_SEED = 1000, 20261025


def cell_name(T, k):
    return f"{TL[T]} {int(round(k * 100))}%"


def h_of(T):
    """Daily origins whose windows can overlap: h = ceil(T / 1 d)."""
    return max(1, -(-T // 24))


# =====================================================================================================================
# universe and frozen constants
# =====================================================================================================================
def universe_path():
    return os.path.join(HERE, "d12_universe.json")


def load_universe():
    with open(universe_path()) as f:
        return json.load(f)


def check_universe(U, datasets):
    for e in U["series"]:
        p = os.path.join(datasets, e["path"])
        if not os.path.exists(p):
            raise SystemExit(f"STOP: d12 development grid missing for {e['symbol']}")
        if C.sha256_file(p) != e["sha256"]:
            raise SystemExit(f"STOP: d12 development grid sha256 mismatch for {e['symbol']}")


def group_of(U, sym):
    return [e["group"] for e in U["series"] if e["symbol"] == sym][0]


# =====================================================================================================================
# kline grids: the frozen development grid + the D12 store, cut before the origin
# =====================================================================================================================
def read_dev_grid(path):
    raw = open(path, "rb").read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    d = json.loads(raw)
    st = int(d["startTs"])
    cols = {c: np.array([np.nan if v is None else float(v) for v in d["columns"][c]], float)
            for c in ("close", "low", "high")}
    return st, cols


def store_path(ldir, sym):
    return os.path.join(ldir, D12_SUB, "klines", sym + ".csv.gz")


def read_store(path):
    rows = C.read_gz_csv(path, KLINE_HEADER)
    prev = None
    for r in rows:
        o = int(r[0])
        if o % (HOUR * 1000) or (prev is not None and o <= prev):
            raise SystemExit(f"STOP: {path}: kline open times not increasing on the hour grid at {o}")
        prev = o
    return rows


def extend_grid(st, cols, rows, upto):
    """Grid of hours opening st .. upto - 1 h: development values, then store klines (missing hour = NaN)."""
    n_dev = len(cols["close"])
    n = (upto - st) // HOUR
    out = {c: np.full(n, np.nan) for c in ("close", "low", "high")}
    m = min(n, n_dev)
    for c in out:
        out[c][:m] = cols[c][:m]
    for r in rows:
        j = (int(r[0]) // 1000 - st) // HOUR
        if j < n_dev:
            continue            # the store starts after the development grid; never overrides it
        if j >= n:
            break
        out["close"][j], out["high"][j], out["low"][j] = float(r[4]), float(r[2]), float(r[3])
    return out


def update_store(ldir, entry, http_get=None, clock=time.time):
    """Append every closed kline after the last stored one (bootstrap: after the development grid's last hour)."""
    sym = entry["symbol"]
    path = store_path(ldir, sym)
    existing = read_store(path)
    last_open = int(existing[-1][0]) if existing else int(entry["devEndOpen"]) * 1000
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
    """A symbol is covered up to the fetch time when its fetch succeeded (a missing kline before it is a real gap)."""
    ok, failed, added = {}, [], 0
    for e in U["series"]:
        try:
            r = update_store(ldir, e, http_get=http_get, clock=clock)
            ok[e["symbol"]] = r["fetchedAt"]
            added += r["appended"]
        except (OSError, ValueError, TimeoutError) as ex:
            failed.append([e["symbol"], f"{type(ex).__name__}: {str(ex)[:120]}"])
        sleep(0.05)
    kd = os.path.join(ldir, D12_SUB, "klines")
    C.append_bytes(os.path.join(kd, "coverage.jsonl"),
                   (json.dumps({"fetchedAt": int(clock()), "covered": ok}, separators=(",", ":")) + "\n").encode())
    C.append_bytes(os.path.join(kd, "fetch-log.jsonl"),
                   (json.dumps({"kind": "d12-klines", "fetchedAt": int(clock()), "ok": len(ok), "failed": failed,
                                "appended": added}, separators=(",", ":")) + "\n").encode())
    log(f"d12 klines: {len(ok)} ok, {len(failed)} failed, +{added} klines")
    return ok, failed


def coverage(ldir):
    path = os.path.join(ldir, D12_SUB, "klines", "coverage.jsonl")
    cov = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.strip():
                    for s_, t_ in json.loads(line)["covered"].items():
                        cov[s_] = max(cov.get(s_, 0), int(t_))
    return cov


# =====================================================================================================================
# the R19.2 development row (r192_borrower.task) at one origin
# =====================================================================================================================
def quarter_start(ts):
    y, mo = map(int, C.iso(ts)[:7].split("-"))
    q = (mo - 1) // 3 + 1
    return C.A.quarter_start(y, q), (y, q)


def make_ser(key, st, cols):
    ser = M3.S3(key, key, "binance", cols["close"], cols["low"], R12.LEVELS, st, st)
    A6.attach_high(ser, cols["high"])
    return ser


def series_origin(key, st, cols, origin):
    """raw (fH), (f) and (a) at the L8 levels for every T at one origin (grid cut at the origin). None if not issuable."""
    ser = make_ser(key, st, cols)
    i = (origin - st) // HOUR
    assert i == ser.N, "the grid must end at the origin"
    if not np.isfinite(ser.spot[i]):
        return None, "no close in the hour before the origin"
    qs_ts, (qy, qq) = quarter_start(origin)
    if (qy, qq) < M3.first_quarter_after(st, R12.WARMUP_DAYS):
        return None, "younger than the development fold rule (first quarter >= 365 d after the first kline)"
    qs = ser.gi(qs_ts)
    lnk = np.log1p(np.array(L8))
    out = {}
    for T in TS:
        P6 = A6.Prep6(ser, T, with_fbL=False)
        P, n = P6.P, P6.n
        lim = qs - T
        if lim <= 0:
            return None, f"no training origin at {TL[T]}"
        tr = np.arange(n) <= lim
        cH, _ = P6.har_coef(qs)
        sH = P6.sigma_H(cH)
        zH, vH = P6.z_of(sH)
        te = np.array([i])
        with np.errstate(invalid="ignore", divide="ignore"):
            thrH = lnk[None, :] / (sH[te][:, None] * P.scale)
            thrf = lnk[None, :] / (ser.sigma[te][:, None] * P.scale)
        pf_ = M2.fhs_predict(P.z[1.0][P.valid[1.0] & tr], thrf)
        pH = M2.fhs_predict(zH[vH & tr], thrH)
        fb = ~np.all(np.isfinite(pH), axis=1)
        pH[fb] = pf_[fb]
        if not (np.all(np.isfinite(pH)) and np.all(np.isfinite(pf_))):
            return None, f"(fH)/(f) undefined at {TL[T]}"
        dtr = P.depth[tr & P.lab_ok]
        dtr = dtr[np.isfinite(dtr)]
        pa = np.stack([np.searchsorted(np.sort(dtr), lk, side="right") / max(len(dtr), 1) for lk in lnk])[None, :]
        out[T] = {nm: np.minimum.accumulate(np.asarray(v, float), axis=1).astype(np.float32)[0]
                  for nm, v in (("fH", pH), ("f", pf_), ("a", pa))}
        out[T]["fallback"] = bool(fb[0])
        del P6
    return {"S": float(ser.spot[i]), "T": out}, None


def compute_series(e, origin, datasets, ldir, garble=False):
    st, cols = read_dev_grid(os.path.join(datasets, e["path"]))
    if garble:                         # no-look-ahead test: every bar opening at or after the origin is garbled
        j0 = (origin - st) // HOUR
        rng = np.random.default_rng(7)
        for c_ in cols:
            cols[c_][j0:] = rng.uniform(0.5, 2.0, max(0, len(cols[c_]) - j0)) * np.nanmax(cols[c_][:j0])
    rows = read_store(store_path(ldir, e["symbol"])) if ldir else []
    g = extend_grid(st, cols, rows, origin)
    last = np.flatnonzero(np.isfinite(g["close"]))
    if len(last) == 0 or (origin - (st + HOUR * int(last[-1]))) > DELIST_DAYS * DAY:
        return None, "no kline in the 30 days before the origin (delisted or halted)"
    try:
        return series_origin(e["key"], st, g, origin)
    except Exception as ex:  # noqa: BLE001  (one series failing never stops the block; recorded as not issued)
        return None, f"error {type(ex).__name__}: {str(ex)[:160]}"


def _job(args):
    e, origin, datasets, ldir, garble = args
    t0 = time.time()
    res, why = compute_series(e, origin, datasets, ldir, garble)
    return e["symbol"], res, why, time.time() - t0


def compute_origin(datasets, ldir, U, origin, workers=2, garble=False, only=None):
    import multiprocessing as mp
    jobs = [(e, origin, datasets, ldir, garble) for e in U["series"] if only is None or e["symbol"] in only]
    res, why, sec = {}, {}, {}
    it = (map(_job, jobs) if workers <= 1 else None)
    if it is not None:
        results = list(it)
    else:
        with mp.get_context("fork").Pool(workers, maxtasksperchild=10) as pool:
            results = list(pool.imap(_job, jobs, chunksize=1))
    for sym, r, w, s_ in results:
        res[sym], sec[sym] = r, s_
        if w:
            why[sym] = w
    return res, why, sec


# =====================================================================================================================
# truth (the R19.2 spot label on the D12 store)
# =====================================================================================================================
def label_from_lows(low, S, T):
    """y list over L8 (None = censored: the window fails the null rule or S is not positive)."""
    wmin = M3.window_min_null_rule(np.asarray(low[:T], float), T)[0]
    if not np.isfinite(wmin) or not (S > 0):
        return None
    depth = math.log(wmin / S)
    return [int(depth <= math.log1p(k)) for k in L8]


def labels_for(entry, ldir, origin, S, T, cov):
    """y list over L8, None (censored), or 'wait' when the store has not been fetched through origin + T."""
    sym = entry["symbol"]
    if cov.get(sym, 0) < origin + T * HOUR:
        return "wait"
    low = np.full(T, np.nan)
    for r in read_store(store_path(ldir, sym)):
        j = (int(r[0]) // 1000 - origin) // HOUR
        if 0 <= j < T:
            low[j] = float(r[3])
    return label_from_lows(low, S, T)


# =====================================================================================================================
# issue
# =====================================================================================================================
def issue_dir(ldir):
    return os.path.join(ldir, D12_SUB, "issues")


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
            raise SystemExit(f"STOP: d12 issue chain broken at {n}")
        prev = sha
    return prev


def gz_json(obj):
    return gzip.compress(C.dumps(obj), compresslevel=9, mtime=0)


def f32(x):
    return [float(np.float32(v)) for v in x]


def retired_symbols(ldir):
    out = set()
    for n in list_issues(ldir):
        doc, _ = read_issue(ldir, n)
        for r in doc["series"]:
            if not r["issued"] and str(r.get("why", "")).startswith(("no kline in the 30 days", "retired earlier")):
                out.add(r["symbol"])
    return out


def issue(a, U, log=print, clock=time.time, http_get=None):
    datasets, ldir = a.datasets, C.live_dir(a.out)
    now = int(clock())
    origin = now - now % DAY
    check_universe(U, datasets)
    ensure_ci_replay(a, U, log=log)
    update_all(ldir, U, http_get=http_get, clock=clock, log=log)
    if origin < FIRST_ORIGIN:
        log(f"d12 issue: none (before the first origin {C.iso(FIRST_ORIGIN)})")
        return 0
    if now >= origin + MAX_LATE:
        log("d12 issue: none (run started 23 h or more after the origin)")
        return 0
    name = C.utc_date(origin) + ".json.gz"
    names = list_issues(ldir)
    if name in names:
        log("d12 issue: none (origin already issued)")
        return 0
    if names and names[-1] > name:
        raise SystemExit("STOP: d12 a later issue file exists (clock went backwards?)")
    prev = verify_issue_chain(ldir)
    cov = coverage(ldir)
    t0 = time.time()
    res, why, _ = compute_origin(datasets, ldir, U, origin, workers=a.workers)
    for s_ in retired_symbols(ldir):
        if res.get(s_) is not None:
            res[s_], why[s_] = None, "retired earlier (30 days without a kline)"
    series = []
    for e in U["series"]:
        s_ = e["symbol"]
        row = {"symbol": s_, "key": e["key"], "group": e["group"]}
        if res.get(s_) is None:
            row.update({"issued": False, "why": why.get(s_, "?")})
        else:
            r = res[s_]
            ca = cov.get(s_, 0) < origin      # the issued set is fixed at t; a late store keeps the series, censored
            row.update({"issued": True, "S": r["S"],
                        "fH": {TL[T]: f32(r["T"][T]["fH"]) for T in TS},
                        "f": {TL[T]: f32(r["T"][T]["f"]) for T in TS},
                        "a": {TL[T]: f32(r["T"][T]["a"]) for T in TS},
                        "fHfallback": {TL[T]: r["T"][T]["fallback"] for T in TS},
                        "censorAll": ca, "censorWhy": ("kline store not fetched through the origin" if ca else None)})
        series.append(row)
    n_iss = sum(r["issued"] for r in series)
    doc = {"schema": SCHEMA, "prereg": PREREG,
           "display": "monitor only: the UI reads d12/classes.json, never these rows",
           "date": C.utc_date(origin), "origin": origin, "originIso": C.iso(origin), "issuedAt": now,
           "issuedAtIso": C.iso(now), "code": a.code, "levels": list(L8), "cells": [cell_name(*c) for c in CELLS],
           "universeSha256": C.sha256_file(universe_path()), "prevSha256": prev, "nIssued": n_iss,
           "modelSeconds": round(time.time() - t0, 1), "series": series}
    C.write_exclusive(os.path.join(issue_dir(ldir), name), gz_json(doc))
    log(f"d12 issue: {n_iss} series issued, {len(series) - n_iss} not issued")
    return 0


# =====================================================================================================================
# the monitor (two one-sided e-processes per group, day = unit, overlap by interleaved subsequences)
# =====================================================================================================================
def day_sums(rows, j):
    """rows: [(p list over L8, y list or None)] of one group and T, level index j. Sums over labelled rows; the bounds
    use every issued row (known at the origin)."""
    n_iss, n_lab, P, Y, BA, BB, A_ = 0, 0, 0.0, 0, 0.0, 0.0, []
    for p, y, a_, e_ in rows:
        n_iss += 1
        BA += 1 - p[j] / R_BAND[1]
        BB += p[j] / R_BAND[0]
        if y is None:
            continue
        n_lab += 1
        P += p[j]
        Y += y[j]
        A_.append(((p[j] - y[j]) ** 2, (a_[j] - y[j]) ** 2, (e_ - y[j]) ** 2))
    xa = P / R_BAND[1] - Y
    xb = Y - P / R_BAND[0]
    bs = [sum(v[q] for v in A_) for q in range(3)]
    return {"nIssued": n_iss, "nLabelled": n_lab, "sumP": P, "sumY": Y, "XA": xa, "XB": xb, "BA": BA, "BB": BB,
            "bsP": bs[0], "bsA": bs[1], "bsE": bs[2]}


def plugin_lambda(hist, v0, B):
    """aGRAPA plug-in (m0 = 0, N0 prior days at variance v0) over the resolved history, truncated by CAP_FRAC / B."""
    n = len(hist)
    s1 = float(sum(hist))
    s2 = float(sum(x * x for x in hist))
    mh = s1 / (N0 + n)
    vh = (N0 * v0 + s2) / (N0 + n)
    if B <= 0 or vh <= 0:
        return 0.0
    return min(max(mh / vh, 0.0), CAP_FRAC / B)


def new_group_state(T):
    h = h_of(T)
    return {"class": CLASS_WARN, "downgradedAt": None, "h": h, "logKA": [0.0] * h, "logKB": [0.0] * h,
            "sumP": 0.0, "sumY": 0, "nLabelled": 0, "days": 0, "bsP": 0.0, "bsA": 0.0, "bsE": 0.0,
            "logE": 0.0, "threshold": h / ALPHA}


def monitor_step(st, ds, day_index, hist, v0, date):
    """One observed day of one group. hist: {'A': [...], 'B': [...]} X values of days with index <= day_index - h.
    Returns the new state, the bets and the events."""
    st = copy.deepcopy(st)
    ds = {k_: (float(v) if k_ not in ("nIssued", "nLabelled") else int(v)) for k_, v in ds.items()}
    events = []
    h = st["h"]
    j = day_index % h
    lamA = plugin_lambda(hist["A"], v0["A"], ds["BA"])
    lamB = plugin_lambda(hist["B"], v0["B"], ds["BB"])
    st["logKA"][j] += math.log1p(lamA * ds["XA"])
    st["logKB"][j] += math.log1p(lamB * ds["XB"])
    st["sumP"] += ds["sumP"]
    st["sumY"] += int(round(ds["sumY"]))
    st["nLabelled"] += ds["nLabelled"]
    st["days"] += 1
    for q in ("bsP", "bsA", "bsE"):
        st[q] += ds[q]
    e = [0.5 * (math.exp(a_) + math.exp(b_)) for a_, b_ in zip(st["logKA"], st["logKB"])]
    st["logE"] = math.log(max(e))
    R = st["sumP"] / st["sumY"] if st["sumY"] > 0 else (math.inf if st["sumP"] > 0 else None)
    st["R"] = R if (R is None or math.isfinite(R)) else None
    st["Rinf"] = bool(R is not None and not math.isfinite(R))
    crossed = max(e) >= st["threshold"]
    outside = R is not None and (R > R_BAND[1] or R < R_BAND[0])
    if crossed and st["class"] == CLASS_WARN:
        if outside:
            st["class"] = CLASS_DOWN
            st["downgradedAt"] = date
            side = "over-forecast (R > 1.25)" if R > R_BAND[1] else "under-forecast (R < 0.8)"
            events.append(f"downgrade {CLASS_WARN} -> {CLASS_DOWN}: e-value crossed h/alpha, {side}")
        else:
            events.append("e-value crossed h/alpha but the cumulative R is inside 0.8-1.25 (no change)")
    return st, {"lamA": lamA, "lamB": lamB, "sub": j}, events


# =====================================================================================================================
# score
# =====================================================================================================================
def ledger_path(ldir):
    return os.path.join(ldir, D12_SUB, "ledger.jsonl")


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
                raise SystemExit("STOP: d12 ledger hash chain broken")
            prev = C.sha256_bytes(raw)
            out.append(d)
    return out, prev


def outcomes_path(ldir, origin):
    return os.path.join(ldir, D12_SUB, "outcomes", f"outcomes-{C.utc_date(origin)[:7]}.jsonl")


def read_outcomes(ldir):
    d = os.path.join(ldir, D12_SUB, "outcomes")
    out = {}
    if os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            with open(os.path.join(d, n), "rb") as f:
                for raw in f.read().splitlines(keepends=True):
                    if raw.strip():
                        out[C.sha256_bytes(raw)] = json.loads(raw)
    return out


def gkey(T, k, g):
    return f"{cell_name(T, k)} {g}"


def initial_state():
    return {gkey(T, k, g): new_group_state(T) for (T, k) in CELLS for g in GROUPS}


def day_index_of(origin):
    return (origin - FIRST_ORIGIN) // DAY


def score(a, U, log=print, clock=time.time, http_get=None):
    ldir = C.live_dir(a.out)
    ensure_ci_replay(a, U, log=log)
    update_all(ldir, U, http_get=http_get, clock=clock, log=log)
    now = int(clock())
    verify_issue_chain(ldir)
    names = list_issues(ldir)
    led, prev = read_ledger(ldir)
    outs = read_outcomes(ldir)
    for d_ in led:
        o = outs.get(d_["outcomeSha256"])
        if o is None or o["origin"] != d_["origin"] or o["T"] != d_["T"]:
            raise SystemExit(f"STOP: d12 outcome line named by the ledger for {d_['date']} {d_['T']} is missing")
    done = {(d_["origin"], d_["T"]) for d_ in led}
    state = led[-1]["state"] if led else initial_state()
    hist = {gkey(T, k, g): [] for (T, k) in CELLS for g in GROUPS}     # (day index, XA, XB) per group, in order
    for d_ in led:
        for gk, m in d_["groups"].items():
            if m.get("observed"):
                hist[gk].append((d_["dayIndex"], m["XA"], m["XB"]))
    v0 = U["v0"]
    clim = U["climatology"]
    cov = coverage(ldir)
    docs = {}
    n_fin, n_pend = 0, 0
    for T in TS:
        for name in names:
            doc = docs.get(name) or read_issue(ldir, name)[0]
            docs[name] = doc
            t = doc["origin"]
            if (t, TL[T]) in done:
                continue
            if now < t + T * HOUR + RESOLVE_MARGIN:
                n_pend += 1
                break
            ys, waiting = {}, False
            for r in doc["series"]:
                if not r["issued"]:
                    continue
                e = [x for x in U["series"] if x["symbol"] == r["symbol"]][0]
                lab = None if r.get("censorAll") else labels_for(e, ldir, t, r["S"], T, cov)
                if lab == "wait":
                    if now < t + T * HOUR + GIVE_UP:
                        waiting = True
                        break
                    lab = None
                ys[r["symbol"]] = lab
            if waiting:
                n_pend += 1
                break                          # days finalize in order per horizon
            series_out = [{"symbol": r["symbol"], "group": r["group"], "fH": r["fH"][TL[T]], "a": r["a"][TL[T]],
                           "y": ys[r["symbol"]]} for r in doc["series"] if r["issued"]]
            oraw = (json.dumps(C.clean({"date": doc["date"], "origin": t, "T": TL[T], "series": series_out}),
                               separators=(",", ":")) + "\n").encode()
            di = day_index_of(t)
            line = {"schema": SCHEMA + "/ledger", "date": doc["date"], "origin": t, "T": TL[T], "dayIndex": di,
                    "groups": {}, "events": []}
            st_new = json.loads(json.dumps(state))
            for k in [k_ for (T_, k_) in CELLS if T_ == T]:
                j = L8.index(k)
                for g in GROUPS:
                    gk = gkey(T, k, g)
                    rows = [(r["fH"], r["y"], r["a"], clim[gk]) for r in series_out if r["group"] == g]
                    ds = day_sums(rows, j)
                    m = dict(ds)
                    m["observed"] = ds["nLabelled"] > 0
                    if m["observed"]:
                        h = h_of(T)
                        hh = [x for x in hist[gk] if x[0] <= di - h]      # outcomes resolved before origin t
                        st_g, bets, ev = monitor_step(st_new[gk], ds, di, {"A": [x[1] for x in hh],
                                                                          "B": [x[2] for x in hh]}, v0[gk], doc["date"])
                        st_new[gk] = st_g
                        m.update(bets)
                        m["logKA"], m["logKB"], m["logE"] = (st_g["logKA"][bets["sub"]], st_g["logKB"][bets["sub"]],
                                                            st_g["logE"])
                        line["events"] += [f"{gk}: {x}" for x in ev]
                        hist[gk].append((di, ds["XA"], ds["XB"]))
                    line["groups"][gk] = m
            line["state"] = st_new
            line["classes"] = {gk: st_new[gk]["class"] for gk in st_new}
            line["prevSha256"] = prev
            line["outcomeSha256"] = C.sha256_bytes(oraw)
            raw = (json.dumps(C.clean(line), separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()
            C.append_bytes(outcomes_path(ldir, t), oraw)
            C.append_bytes(ledger_path(ldir), raw)   # a crash between the two appends leaves an orphan outcome line
            prev = C.sha256_bytes(raw)
            led.append(line)
            done.add((t, TL[T]))
            state = st_new
            n_fin += 1
    log(f"d12 scored: {n_fin} cell-days finalized, {n_pend} horizons pending, ledger {len(led)} lines")
    write_summary(ldir, U, led, state)
    return 0


# =====================================================================================================================
# derived files: classes.json (read by the UI) and summary.json (secondaries, report only)
# =====================================================================================================================
def slope_fit(p, y):
    """Calibration slope and intercept: logistic regression of y on logit p (reported only)."""
    from scipy.optimize import minimize
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))

    def f(w):
        z = w[0] + w[1] * x
        return float(np.sum(np.logaddexp(0, z) - y * z))

    def gr(w):
        s_ = 1 / (1 + np.exp(-(w[0] + w[1] * x)))
        return np.array([np.sum(s_ - y), np.sum((s_ - y) * x)])
    return minimize(f, np.array([0.0, 1.0]), jac=gr, method="L-BFGS-B").x


def secondaries(rows):
    """rows: list of (week, p, a, e, y). R, slope, BSS vs (a) and (e) with weekly block bootstrap 95% intervals."""
    if not rows:
        return None
    wk = np.array([r[0] for r in rows])
    p, a_, e_, y = (np.array([r[q] for r in rows], float) for q in (1, 2, 3, 4))
    out = {"rows": len(rows), "positives": int(y.sum()), "weeks": int(len(np.unique(wk))),
           "R": float(p.sum() / y.sum()) if y.sum() > 0 else None}
    bsp, bsa, bse = np.sum((p - y) ** 2), np.sum((a_ - y) ** 2), np.sum((e_ - y) ** 2)
    out["BSS_vs_a"] = float(1 - bsp / bsa) if bsa > 0 else None
    out["BSS_vs_e"] = float(1 - bsp / bse) if bse > 0 else None
    if y.sum() >= 5 and (1 - y).sum() >= 5:
        out["slope"] = float(slope_fit(p, y)[1])
    weeks = np.unique(wk)
    if len(weeks) >= 8 and y.sum() >= 5:
        rng = np.random.default_rng(BOOT_SEED)
        idx = {w: np.flatnonzero(wk == w) for w in weeks}
        bs = {"R": [], "BSS_vs_a": [], "BSS_vs_e": []}
        for _ in range(BOOT_B):
            sel = np.concatenate([idx[w] for w in rng.choice(weeks, len(weeks))])
            yy, pp, aa, ee = y[sel], p[sel], a_[sel], e_[sel]
            if yy.sum() > 0:
                bs["R"].append(pp.sum() / yy.sum())
            bp = np.sum((pp - yy) ** 2)
            for nm, cmp_ in (("BSS_vs_a", aa), ("BSS_vs_e", ee)):
                bc = np.sum((cmp_ - yy) ** 2)
                if bc > 0:
                    bs[nm].append(1 - bp / bc)
        for nm, v in bs.items():
            if len(v) >= 100:
                out[nm + "_ci95"] = [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))]
    return out


def write_summary(ldir, U, led, state):
    classes = {"schema": SCHEMA + "/classes", "prereg": PREREG,
               "rule": "CALIBRATED-WARN until the registered D12 monitor fires; then CALIBRATED (terminal)",
               "lastLedgerDate": led[-1]["date"] if led else None, "cells": {}}
    for (T, k) in CELLS:
        for g in GROUPS:
            gk = gkey(T, k, g)
            s_ = state[gk]
            classes["cells"][gk] = {"horizon": TL[T], "level": k, "group": g,
                                    "assets": [e["symbol"] for e in U["series"] if e["group"] == g],
                                    "class": s_["class"], "downgradedAt": s_["downgradedAt"],
                                    "observedDays": s_["days"]}
    C.write_atomic(os.path.join(ldir, D12_SUB, "classes.json"), C.dumps(classes))
    outs = read_outcomes(ldir)
    clim = U["climatology"]
    acc = {}
    for d_ in led:
        o = outs[d_["outcomeSha256"]]
        T = [T_ for T_ in TS if TL[T_] == d_["T"]][0]
        week = (d_["origin"] - FIRST_ORIGIN) // (7 * DAY)
        for r in o["series"]:
            if r["y"] is None:
                continue
            for (T_, k) in CELLS:
                if T_ != T:
                    continue
                j = L8.index(k)
                gk = gkey(T, k, r["group"])
                item = (week, r["fH"][j], r["a"][j], clim[gk], r["y"][j])
                acc.setdefault(gk, []).append(item)
                acc.setdefault(f"{cell_name(T, k)} {r['symbol']}", []).append(item)
    summ = {"schema": SCHEMA + "/summary", "display": "report only; the UI reads classes.json",
            "ledgerLines": len(led), "lastDate": led[-1]["date"] if led else None, "groups": {}, "perAsset": {}}
    for (T, k) in CELLS:
        for g in GROUPS:
            gk = gkey(T, k, g)
            s_ = state[gk]
            summ["groups"][gk] = {"class": s_["class"], "downgradedAt": s_["downgradedAt"], "days": s_["days"],
                                  "R_cum": s_.get("R"), "eValue": math.exp(s_["logE"]), "threshold": s_["threshold"],
                                  "secondaries": secondaries(acc.get(gk, []))}
        for sym in ("ETHUSDT", "BTCUSDT"):
            summ["perAsset"][f"{cell_name(T, k)} {sym}"] = secondaries(acc.get(f"{cell_name(T, k)} {sym}", []))
    C.write_atomic(os.path.join(ldir, D12_SUB, "summary.json"), C.dumps(summ))


# =====================================================================================================================
# instrument replay (development days) -- run locally before deployment and once on the CI runner (recorded)
# =====================================================================================================================
def golden_path():
    return os.path.join(HERE, "d12_golden.json")


def replay(datasets, U, workers=2, log=print):
    """Live code on development grids cut at each replay origin vs the R19.2 development rows (r192_borrower.task):
    raw (fH), (f), (a) bit for bit and the label (from the full development grid) equal; no look-ahead (bars at and
    after the origin garbled on LOOKAHEAD_N series: identical rows)."""
    G = json.load(open(golden_path()))
    n_cmp, n_eq, n_lab, n_lab_eq, bad = 0, 0, 0, 0, []
    for oi in REPLAY_ORIGINS:
        origin = C.A.utc(oi)
        res, why, _ = compute_origin(datasets, None, U, origin, workers=workers)
        for e in U["series"]:
            gd = G["rows"].get(oi, {}).get(e["symbol"])
            if gd is None:
                continue
            r = res.get(e["symbol"])
            st, cols = read_dev_grid(os.path.join(datasets, e["path"]))
            j0 = (origin - st) // HOUR
            for T in TS:
                g = gd.get(TL[T])
                if g is None:
                    continue
                n_cmp += 1
                ok = r is not None and all(
                    np.array_equal(np.asarray(r["T"][T][nm], np.float32), np.asarray(g[nm], np.float32))
                    for nm in ("fH", "f", "a"))
                n_eq += ok
                if not ok:
                    bad.append([oi, e["symbol"], TL[T], "rows" if r is not None else str(why.get(e["symbol"]))])
                if r is not None:
                    y = label_from_lows(cols["low"][j0:j0 + T], r["S"], T)
                    n_lab += 1
                    lab_ok = y == g["y"]
                    n_lab_eq += lab_ok
                    if not lab_ok:
                        bad.append([oi, e["symbol"], TL[T], "label"])
    origin = C.A.utc(REPLAY_ORIGINS[-1])
    look = [e["symbol"] for e in U["series"]][:LOOKAHEAD_N]
    r0, _, _ = compute_origin(datasets, None, U, origin, workers=workers, only=set(look))
    rg, _, _ = compute_origin(datasets, None, U, origin, workers=workers, garble=True, only=set(look))
    la_ok = all(r0[s_] is not None and rg[s_] is not None and r0[s_]["S"] == rg[s_]["S"] and all(
        np.array_equal(r0[s_]["T"][T][nm], rg[s_]["T"][T][nm]) for T in TS for nm in ("fH", "f", "a"))
        for s_ in look)
    ok = n_cmp > 0 and n_eq == n_cmp and n_lab == n_cmp and n_lab_eq == n_lab and la_ok
    out = {"replayOrigins": list(REPLAY_ORIGINS), "compared": n_cmp, "rowsEqual": n_eq, "labelsCompared": n_lab,
           "labelsEqual": n_lab_eq, "noLookAhead_series": len(look), "noLookAhead_equal": bool(la_ok),
           "mismatches": bad[:20], "goldenSha256": C.sha256_file(golden_path()), "python": sys.version.split()[0],
           "numpy": np.__version__, "pass": bool(ok)}
    log(f"d12 replay: {n_eq} of {n_cmp} rows equal, {n_lab_eq} of {n_lab} labels equal, "
        f"{int(la_ok) * len(look)} of {len(look)} look-ahead equal")
    return out


def ensure_ci_replay(a, U, log=print):
    """The first run on the CI runner records the replay (d12/checks/ci-replay.json, written once). The block refuses
    to issue or score unless that record exists and passed (fail closed)."""
    p = os.path.join(C.live_dir(a.out), D12_SUB, "checks", "ci-replay.json")
    if os.path.exists(p):
        rec = json.load(open(p))
        if not rec.get("pass"):
            raise SystemExit("STOP: d12 CI replay record failed; the block stays closed")
        return rec
    if C.sha256_file(golden_path()) != U["goldenSha256"]:
        raise SystemExit("STOP: d12 golden replay file sha256 mismatch")
    check_universe(U, a.datasets)
    rec = replay(a.datasets, U, workers=a.workers, log=log)
    rec.update({"code": a.code, "recordedAt": C.iso(int(time.time()))})
    C.write_exclusive(p, C.dumps(rec))
    if not rec["pass"]:
        raise SystemExit("STOP: d12 CI replay failed (record written; the block stays closed)")
    return rec


# =====================================================================================================================
# CLI
# =====================================================================================================================
D12_FILES = ("live/q26_live_d12.py", "live/d12_universe.json", "live/d12_golden.json", "live/q26_live_common.py",
             "a2_touch.py", "a3_touch.py", "a6_touch.py", "a_touch.py", "r12_tail.py")


def code_meta(expect_commit=None):
    import subprocess

    def git(*args):
        r = subprocess.run(["git", "-C", MODEL_DIR, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    commit = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain", "--", *D12_FILES)
    if expect_commit is not None and commit != expect_commit:
        raise SystemExit(f"STOP: code checkout is at {commit}, expected the pinned commit {expect_commit}")
    if expect_commit is not None and dirty:
        raise SystemExit("STOP: d12 code files differ from the pinned commit")
    return {"repo": "The-Membrane/membrane-app", "commit": commit, "dirty": bool(dirty),
            "python": sys.version.split()[0], "numpy": np.__version__}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("issue", "score", "replay"))
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect-commit", default=None)
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args(argv)
    U = load_universe()
    a.code = code_meta(a.expect_commit)
    log = (lambda *x: print(*x, flush=True))
    if a.cmd == "replay":
        check_universe(U, a.datasets)
        rec = replay(a.datasets, U, workers=a.workers, log=log)
        print(json.dumps(C.clean(rec), indent=1), file=sys.stderr)
        return 0 if rec["pass"] else 1
    return {"issue": issue, "score": score}[a.cmd](a, U, log=log)


if __name__ == "__main__":
    sys.exit(main())
