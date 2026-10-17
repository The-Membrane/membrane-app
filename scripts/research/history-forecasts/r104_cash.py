#!/usr/bin/env python3
"""Q26 R10.4 two-flow daily-minimum cash forecast (Aave V3 Core USDC), then exactly one driver test.

membrane-board design/Q26_ROUND10_PREREG.md R10.4 (runs because R10.1 Pass A passed: D2, D-review-R10.1).
Process: Q26_ROUND9_PREREG D8 rules. Run-time readings are in the board Deviation for R10.4 before the run and in
DECISIONS below. One run: inputs are hashed and `frozen-r104.json` (code sha, input sha256 values, readings, seed)
is written and hashed before any forecast is scored; results go to separate files.

  python3 r104_cash.py --datasets <membrane-datasets> --cash <dir with the 3 aave-pool-cash files>
                       --funding <dir with funding-ethusdt.csv> --code-sha <sha> --out <dir>

Target: min raw pool cash over (t0, t0 + h], h in {24 h, 7 d}, quantiles q05, q25, q50; raw cash from the exact
USDC Transfer stream, per-transaction states, short dips kept.
Model (step 1): daily log-changes of ex-round-trip supply S and debt D (D = S - cash), each standardized by its
own log-HAR forecast (A6 (fH) form, daily), joint same-day blocks from the trailing 730 days, rescaled by the HAR
forecast at t0; cash = S - D per path; the intraday dip below the lower day endpoint from the same historical day as
a share of supply; path minimum also bounded by the raw cash at t0.
Step 2 (the only driver): carry spread = ETHUSDT funding annualised over the trailing 7 d minus the W24 mean Core USDC
variable borrow APR; shifts the standardized debt-flow mean by beta * (spread_t0 - spread_day), beta by OLS on the
trailing 730 days.
Baseline: no-change, every quantile = min raw cash over (t0 - h, t0].
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from a_touch import block_bootstrap_indices  # noqa: E402

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND10_PREREG.md", "item": "R10.4"}
SCHEMA = "q26-r10/r104/1"
MICRO = 10 ** 6
RAY = 10 ** 27
DAY = 86400
QS = (0.05, 0.25, 0.50)
HORIZONS = {"24h": 1, "7d": 7}
TRAIL_DAYS = 730
HAR_LAGS = (1, 7, 30)
SCORE_FIRST = "2024-01-01"
Q2 = ("2026-04-01", "2026-07-01")        # [start, end) excluded from scoring windows
END_BLOCK = 26186746
LOOKAHEAD_S = 3600                       # R9.1(b): a round trip counts at t0 iff it completes by t0 + 60 min
DRT_MIN_RAW = 20_000_000 * MICRO         # R9 D3 debt-side round trip size
DRT_WINDOW_S = 2 * 3600
DRT_FILL = 0.95
FUND_WINDOW_S = 7 * DAY
STEP1_PASS = 0.10
STEP2_PASS = 0.03
BOOT_BLOCK = 30
BOOT_REPS = 2000
SEED = 20261017
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")

R9_DIR = "history-forecasts/r9/run-dfdd3ad8"
W24 = f"{R9_DIR}/w24-pool-usdc.csv"
QRT_LEGS = f"{R9_DIR}/qrt-legs-usdc.csv.gz"
BLOCKS = "depositor-balances/blocks.csv"
BORROWS = [f"aave-pool-borrows/borrow-events-core-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
REPAYS = [f"aave-pool-debt/repay-events-core-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
CASH_FILES = ("raw-logs-usdc-in.csv.gz", "raw-logs-usdc-out.csv.gz", "raw-logs-rdu.csv.gz")
CASH_SHA = {"raw-logs-rdu.csv.gz": "de5eceb0965d71dd705a66b41864f796df62115d5e7728d65f0db84a99595f19",
            "raw-logs-usdc-in.csv.gz": "bdadb6a357f2495e99c9a8f7e51f47af8f7ae8c846521d9dd5185e057c2ff830",
            "raw-logs-usdc-out.csv.gz": "074d31612d4107aec246fc8b65090ed0c2f9a4a86ac474d8f83bedb124d6afc8"}
R9_SHA = {W24: "b3cbe460e38ac62f6abfc4b3521ae26328f9aa7ea9ec81c2357f56540f991912",
          QRT_LEGS: "f3da86020fbd5dd4841e816c66611d3bb31a65a9812d5c18bf87f96d5dc5bd8e"}

DECISIONS = [
    "R104-1 Raw cash is the truth for the target and the baseline: cash(t) = sum of USDC Transfers into minus out of "
    "the aToken from deployment (R9 V1: offset 0), evaluated per transaction (block, tx) as R9.1(a). Round trips are "
    "NOT removed from the target, the baseline or the intraday dip: the drain-role nightly withdraw/redeposit and "
    "the Q4 2024 overnight borrow/repay are real cash dips. Window minimum over (t0, t0 + h] = min of cash held just "
    "after t0 (= cash(t0)) and every per-transaction state with ts in (t0, t0 + h]; daily windows (t_i, t_i + 1 d] "
    "tile the 7 d window, so the 7 d minimum is the minimum of 7 daily minima.",
    "R104-2 Endpoints: day i's endpoint is the state at the depositor-balances anchor block of origin t_i (last block "
    "before 00:00Z): supply and cash from R9 run-dfdd3ad8 w24-pool-usdc.csv snap_supply / snap_cash. Gate G1: the "
    "rebuilt cash path equals snap_cash at every anchor block (stop otherwise). Debt D := S - cash (unbacked and stable "
    "debt are 0, D1), so cash = S - D holds exactly.",
    "R104-3 Round trips in the FLOW history (supply and debt log-changes, the dip's endpoints, the path start): (a) "
    "aToken same-wallet round trips = the R9.1(b) QRTs in qrt-legs-usdc.csv.gz; a QRT is outstanding at an anchor "
    "block when its withdraw leg is at or before the block and its last redeposit leg after it; the outstanding "
    "amount = neutral - redeposit neutral already at or before the block; it is added back to S and to cash "
    "(D unchanged). (b) Debt-side round trips (R9 D3 definition, now neutralised in flows only): a USDC Borrow of >= "
    "$20M (onBehalfOf = A) followed by USDC Repays with user = A and useATokens = 0 within 2 h, summed in time order, "
    "reaching >= 95% of the borrow; neutral = min(borrow, that sum); each repay consumed once; outstanding at an "
    "anchor block when the borrow is at or before it and the completing repay after it; the outstanding amount "
    "(neutral - consumed repays at or before the block) is added back to cash and removed from D (S unchanged). "
    "Addresses are salted hashes in memory only.",
    "R104-4 Look-ahead: for history endpoints every round trip is applied (all complete within 2 h, before the next "
    "origin). The endpoint AT the forecast origin t0 applies only round trips that complete by t0 + 60 min (R9.1(b) "
    "live rule); this endpoint enters the last training change, the last dip and the path start.",
    "R104-5 Dip: dip_i = max(0, min(cashX_i, cashX_{i+1}) - rawmin_i) / SX_i, rawmin_i the raw minimum over "
    "(t_i, t_i + 1 d]. Path day k: daymin_k = min(C_k, C_{k+1}) - dip_{s+k} * S_k with C = S - D; path min = "
    "min over k of daymin_k and the raw cash at t0 (cash held just after t0 is part of the window by definition).",
    "R104-6 HAR (A6 (fH) in daily form) per flow at each origin: OLS of ln|x_i| on [1, ln v_{i-1}, ln mean v_{i-7..i-1}, "
    "ln mean v_{i-30..i-1}], v = x^2, over training days i in the trailing 730 days (i+1 <= t0, every log finite); "
    "sigma_i = exp(fitted) with the origin's coefficients; z_i = x_i / sigma_i (not demeaned). Forecast sigma at t0 "
    "from the components ending at t0. The constant bias of E ln|x| cancels between standardizing and rescaling.",
    "R104-7 Joint draws: every block start s in the trailing 730 days with s + H <= t0 (H = 1 or 7 days) and z and dip "
    "defined on all H days gives one path; same-day supply and debt z are kept together, rescaled by the origin's "
    "sigma for every day of the path. Deterministic (no sampling). Quantiles numpy 'linear'.",
    "R104-8 Scoring origins: 00:00Z from 2024-01-01 to the last origin with t0 + h <= the data end (block 26,186,746, "
    "2026-10-13T23:05:59Z): 24 h to 2026-10-12, 7 d to 2026-10-06; an origin is excluded when (t0, t0 + h] meets "
    "[2026-04-01, 2026-07-01) (2026Q2 reported only). Loss per origin = mean over q05, q25, q50 of the pinball loss in "
    "USD; skill = 1 - mean(model) / mean(no-change) over scoring origins. Step 1 passes per h iff skill >= 10%.",
    "R104-9 Step 2 spread_i = 365/7 x sum of ETHUSDT funding rates with calc_time rounded to the minute in "
    "[t_i - 7 d, t_i) minus the W24 time-weighted mean USDC variable borrow APR over (t_i - 24 h, t_i] (RDU step "
    "function; the R9 corrected APR, not the drain-inflated point value). Defined iff the funding file covers the whole "
    "window. OLS z^D_i = a + b spread_i over the origin's HAR training days with spread defined; path debt z = "
    "z^D_{s+k} + b (spread_t0 - spread_{s+k}). If spread_t0 is undefined (funding not yet published) the step-2 "
    "forecast equals step 1 at that origin (counted). Step 2 is computed at both h regardless of step 1.",
    "R104-10 Step 2 acceptance per h: I = 1 - mean(L_step2) / mean(L_step1) >= 3% AND the 95% percentile CI of I from "
    "a 30-day moving-block bootstrap over the ordered scoring origins (a_touch.block_bootstrap_indices, 2,000 reps, "
    "default_rng(20261017)) has lower bound > 0. The same bootstrap CI is reported for step 1 skill (deciding nothing).",
    "R104-11 Reported only, deciding nothing: per-quantile pinball and hit rates, skill by year, skill with losses "
    "scaled by supply at t0, 2026Q2 origins, a step-1 sensitivity with raw endpoints (no round-trip neutralisation "
    "in flows), round-trip counts, beta and funding coverage.",
]


# ---------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------
def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def day_ts(d):
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def ts_day(t):
    return datetime.fromtimestamp(int(t), tz=timezone.utc).strftime("%Y-%m-%d")


def word(data, i):
    return int(data[2 + 64 * i: 2 + 64 * (i + 1)], 16)


def pinball(y, f, q):
    d = y - f
    return np.maximum(q * d, (q - 1.0) * d)


def window_min(ts, vals, cash_before, a, b):
    """min of a right-continuous step path over (a, b]: the value held just after a and every state in (a, b]."""
    i0 = int(np.searchsorted(ts, a, side="right"))
    i1 = int(np.searchsorted(ts, b, side="right"))
    m = cash_before
    if i1 > i0:
        m = min(m, int(vals[i0:i1].min()))
    return m


def state_at(ts, vals, t):
    k = int(np.searchsorted(ts, t, side="right")) - 1
    return int(vals[k]) if k >= 0 else 0


def tw_mean_step(ts, vals, a, b):
    """time-weighted mean of a right-continuous step function over (a, b]; NaN if no step at or before a."""
    k0 = int(np.searchsorted(ts, a, side="right")) - 1
    if k0 < 0:
        return float("nan")
    k1 = int(np.searchsorted(ts, b, side="right"))
    idx = np.arange(k0, k1)
    starts = np.maximum(ts[idx].astype(float), a)
    ends = np.minimum(np.append(ts[idx[1:]].astype(float), b), b)
    w = np.maximum(ends - starts, 0.0)
    return float((vals[idx] * w).sum() / w.sum())


# ---------------------------------------------------------------------------------------------
# round trips (pure, tested)
# ---------------------------------------------------------------------------------------------
def qrt_outstanding(legs, anchor_blocks, anchor_ts=None, visible_by=None):
    """legs: DataFrame (qrt_id, leg, block, ts, neutral_raw). Returns int array of outstanding neutral per anchor.
    A QRT counts at anchor j iff withdraw.block <= a_j < last redeposit block (and, if visible_by is given, its last
    redeposit ts <= visible_by[j])."""
    out = np.zeros(len(anchor_blocks), dtype=object)
    out[:] = 0
    for _, g in legs.groupby("qrt_id", sort=False):
        w = g[g["leg"] == "withdraw"]
        r = g[g["leg"] == "redeposit"].sort_values("block", kind="mergesort")
        if len(w) != 1 or len(r) == 0:
            continue
        wb = int(w["block"].iloc[0])
        neutral = int(w["neutral_raw"].iloc[0])
        rb = r["block"].to_numpy(np.int64)
        rn = [int(x) for x in r["neutral_raw"]]
        done_b, done_ts = int(rb[-1]), int(r["ts"].iloc[-1])
        j0 = int(np.searchsorted(anchor_blocks, wb, side="left"))
        j1 = int(np.searchsorted(anchor_blocks, done_b, side="left"))
        for j in range(j0, j1):          # wb <= a_j < done_b
            if visible_by is not None and done_ts > visible_by[j]:
                continue
            paid = sum(n for b, n in zip(rb, rn) if b <= anchor_blocks[j])
            amt = neutral - paid
            if amt > 0:
                out[j] += amt
    return np.array([int(x) for x in out], dtype=object)


def detect_drt(borrows, repays, min_raw=DRT_MIN_RAW, window_s=DRT_WINDOW_S, fill=DRT_FILL):
    """borrows: DataFrame (block, log_index, ts, unit, amount) USDC borrows; repays: (block, log_index, ts, unit,
    amount) USDC repays with useATokens = 0. Returns list of dicts {borrow_block, borrow_ts, done_block, done_ts,
    neutral, legs: [(block, amount)]} (legs = consumed repays up to completion)."""
    borrows = borrows.sort_values(["block", "log_index"], kind="mergesort")
    repays = repays.sort_values(["block", "log_index"], kind="mergesort").reset_index(drop=True)
    used = np.zeros(len(repays), bool)
    rblock = repays["block"].to_numpy(np.int64)
    rlog = repays["log_index"].to_numpy(np.int64)
    rts = repays["ts"].to_numpy(np.int64)
    ramt = repays["amount"].to_numpy(object)
    by_unit = {u: g.index.to_numpy() for u, g in repays.groupby("unit", sort=False)}
    out = []
    for b in borrows.itertuples(index=False):
        amt = int(b.amount)
        if amt < min_raw:
            continue
        idx = by_unit.get(b.unit)
        if idx is None:
            continue
        start = int(np.searchsorted(rblock[idx], int(b.block), side="left"))
        cum, legs, done = 0, [], None
        for k in idx[start:]:
            if used[k] or (rblock[k], rlog[k]) <= (int(b.block), int(b.log_index)):
                continue
            if rts[k] > int(b.ts) + window_s:
                break
            cum += int(ramt[k])
            legs.append(k)
            if cum >= fill * amt:
                done = k
                break
        if done is None:
            continue
        for k in legs:
            used[k] = True
        out.append({"borrow_block": int(b.block), "borrow_ts": int(b.ts), "done_block": int(rblock[done]),
                    "done_ts": int(rts[done]), "neutral": min(amt, cum),
                    "legs": [(int(rblock[k]), int(ramt[k])) for k in legs]})
    return out


def drt_outstanding(drts, anchor_blocks, visible_by=None):
    out = [0] * len(anchor_blocks)
    for d in drts:
        j0 = int(np.searchsorted(anchor_blocks, d["borrow_block"], side="left"))
        j1 = int(np.searchsorted(anchor_blocks, d["done_block"], side="left"))
        for j in range(j0, j1):
            if visible_by is not None and d["done_ts"] > visible_by[j]:
                continue
            paid = sum(a for b, a in d["legs"] if b <= anchor_blocks[j])
            amt = d["neutral"] - paid
            if amt > 0:
                out[j] += amt
    return np.array(out, dtype=object)


# ---------------------------------------------------------------------------------------------
# model (pure, tested)
# ---------------------------------------------------------------------------------------------
def har_fit(x, lo, hi):
    """x: daily changes (NaN allowed). Fit on training days i in [lo, hi] (inclusive). Returns (coef, sigma array
    over all days where components are defined, n_reg) or (None, None, n)."""
    n = len(x)
    v = x * x
    cs = np.concatenate([[0.0], np.nancumsum(v)])
    cn = np.concatenate([[0], np.cumsum(np.isfinite(v))])
    comps = []
    for L in HAR_LAGS:
        c = np.full(n + 1, np.nan)
        for i in range(L, n + 1):           # components for day i use days i-L .. i-1
            k = cn[i] - cn[i - L]
            if k == L:
                c[i] = (cs[i] - cs[i - L]) / L
        comps.append(c)
    with np.errstate(divide="ignore", invalid="ignore"):
        X = np.column_stack([np.ones(n + 1)] + [np.log(c) for c in comps])   # row i: forecast for day i
        y = np.log(np.abs(np.append(x, np.nan)))
    okX = np.all(np.isfinite(X), axis=1)
    rows = np.arange(n + 1)
    tr = okX & np.isfinite(y) & (rows >= lo) & (rows <= hi)
    nreg = int(tr.sum())
    if nreg < 4:
        return None, None, nreg
    c, *_ = np.linalg.lstsq(X[tr], y[tr], rcond=None)
    sig = np.full(n + 1, np.nan)
    with np.errstate(over="ignore"):
        sig[okX] = np.exp(X[okX] @ c)
    return c, sig, nreg


def path_minima(S0, D0, zS, zD, dip, sigS, sigD, cash0, H):
    """zS, zD, dip: (P, H) arrays of historical blocks. Returns (P,) path minima of cash."""
    xS = zS * sigS
    xD = zD * sigD
    S = S0 * np.exp(np.concatenate([np.zeros((len(zS), 1)), np.cumsum(xS, axis=1)], axis=1))
    D = D0 * np.exp(np.concatenate([np.zeros((len(zD), 1)), np.cumsum(xD, axis=1)], axis=1))
    C = S - D
    daymin = np.minimum(C[:, :H], C[:, 1:H + 1]) - dip * S[:, :H]
    return np.minimum(daymin.min(axis=1), cash0)


def forecast_origin(n, H, xS, xD, dip, S0, D0, cash0, spread=None, trail=TRAIL_DAYS):
    """Forecast at origin index n (days 0..n-1 are complete). Returns dict with step-1 (and step-2) quantiles."""
    lo = max(0, n - trail)
    hi = n - 1
    cS, sigS, nS = har_fit(xS[:n], lo, hi)
    cD, sigD, nD = har_fit(xD[:n], lo, hi)
    if cS is None or cD is None:
        return None
    zS = xS[:n] / sigS[:n]
    zD = xD[:n] / sigD[:n]
    ok = np.isfinite(zS) & np.isfinite(zD) & np.isfinite(dip[:n])
    starts = [s for s in range(lo, n - H + 1) if ok[s:s + H].all()]
    if len(starts) < 30:
        return None
    st = np.array(starts)
    blk = st[:, None] + np.arange(H)[None, :]
    pm1 = path_minima(S0, D0, zS[blk], zD[blk], dip[blk], sigS[n], sigD[n], cash0, H)
    out = {"q1": np.quantile(pm1, QS, method="linear"), "n_paths": len(st), "nreg": (nS, nD),
           "sig": (float(sigS[n]), float(sigD[n]))}
    if spread is not None:
        sp = spread[:n]
        tr = np.arange(n)
        m = (tr >= lo) & np.isfinite(zD) & np.isfinite(sp)
        beta = None
        if np.isfinite(spread[n]) and m.sum() >= 30:
            A = np.column_stack([np.ones(m.sum()), sp[m]])
            (a0, beta), *_ = np.linalg.lstsq(A, zD[m], rcond=None)
            shift = beta * (spread[n] - sp[blk])
            shift = np.where(np.isfinite(shift), shift, 0.0)
            pm2 = path_minima(S0, D0, zS[blk], zD[blk] + shift, dip[blk], sigS[n], sigD[n], cash0, H)
            out["q2"] = np.quantile(pm2, QS, method="linear")
            out["beta"] = float(beta)
        else:
            out["q2"] = out["q1"].copy()
            out["beta"] = None
    return out


def boot_ratio_ci(la, lb, rng, block=BOOT_BLOCK, reps=BOOT_REPS):
    """95% percentile CI of 1 - mean(la)/mean(lb) under a moving-block bootstrap over ordered origins."""
    idx = block_bootstrap_indices(rng, len(la), block, reps)
    r = 1.0 - la[idx].mean(axis=1) / lb[idx].mean(axis=1)
    return float(np.percentile(r, 2.5)), float(np.percentile(r, 97.5))


# ---------------------------------------------------------------------------------------------
# run pieces (pure, tested end to end on synthetic arrays)
# ---------------------------------------------------------------------------------------------
def make_flows(S_snap, C_end, dmin, Q, R):
    SX = S_snap + Q
    CX = C_end + Q + R
    DX = SX - CX
    with np.errstate(divide="ignore", invalid="ignore"):
        xS = np.log(SX[1:] / SX[:-1])
        xD = np.log(DX[1:] / DX[:-1])
        dp = np.maximum(0.0, np.minimum(CX[:-1], CX[1:]) - dmin[:-1]) / SX[:-1]
    return SX, CX, DX, xS, xD, dp


def run_variant(F, Flive, dmin, cash_t0, sets, spread, with_spread):
    SX, CX, DX, xS, xD, dp = F
    out = {}
    for hn, H in HORIZONS.items():
        rows = {}
        for n in np.concatenate([sets[hn]["score"], sets[hn]["q2"]]):
            n = int(n)
            xs, xd, dd = xS[:n].copy(), xD[:n].copy(), dp[:n].copy()
            if Flive is not None:      # endpoint n with the live rule (R104-4)
                sl, cl, dl = Flive[0][n], Flive[1][n], Flive[2][n]
                xs[n - 1] = np.log(sl / SX[n - 1])
                xd[n - 1] = np.log(dl / DX[n - 1])
                dd[n - 1] = max(0.0, min(CX[n - 1], cl) - dmin[n - 1]) / SX[n - 1]
                S0, D0 = sl, dl
            else:
                S0, D0 = SX[n], DX[n]
            rows[n] = forecast_origin(n, H, np.append(xs, np.nan), np.append(xd, np.nan), np.append(dd, np.nan),
                                      S0, D0, cash_t0[n], spread=spread if with_spread else None)
        out[hn] = rows
    return out


def score_all(dmin, sets, main_fc, raw_fc, S_snap, origins, spread, Q_live, R_live, rng, say=print):
    T = len(dmin)
    per_h, rows_out = {}, []
    for hn, H in HORIZONS.items():
        ytrue = np.array([np.min(dmin[i:i + H]) if i + H <= T and np.isfinite(dmin[i:i + H]).all()
                          else np.nan for i in range(T)])
        nc = np.array([np.min(dmin[i - H:i]) if i - H >= 0 else np.nan for i in range(T)])

        def losses(idx, fc, key):
            L, Lnc, keep = [], [], []
            for n in idx:
                fo = fc[hn].get(int(n))
                if fo is None or not np.isfinite(ytrue[n]) or not np.isfinite(nc[n]):
                    continue
                q = fo[key]
                L.append(np.mean([pinball(ytrue[n], q[j], QS[j]) for j in range(3)]) / MICRO)
                Lnc.append(np.mean([pinball(ytrue[n], nc[n], QS[j]) for j in range(3)]) / MICRO)
                keep.append(int(n))
            return np.array(L), np.array(Lnc), np.array(keep, dtype=int)

        sc = sets[hn]["score"]
        L1, Lnc, keep = losses(sc, main_fc, "q1")
        L2, _, keep2 = losses(sc, main_fc, "q2")
        if len(keep) == 0 or not (keep == keep2).all():
            raise SystemExit(f"STOP: no scorable origins or key mismatch at {hn}")
        skill1 = 1.0 - L1.mean() / Lnc.mean()
        I2 = 1.0 - L2.mean() / L1.mean()
        ci1 = boot_ratio_ci(L1, Lnc, rng)
        ci2 = boot_ratio_ci(L2, L1, rng)
        Lr, Lncr, _ = losses(sc, raw_fc, "q1")
        Lq, Lncq, keepq = losses(sets[hn]["q2"], main_fc, "q1")
        Sx = S_snap[keep] / MICRO
        per_q = {}
        for j, q in enumerate(QS):
            f1 = np.array([main_fc[hn][n]["q1"][j] for n in keep])
            f2 = np.array([main_fc[hn][n]["q2"][j] for n in keep])
            per_q[str(q)] = {"pinball_model": float(np.mean(pinball(ytrue[keep], f1, q)) / MICRO),
                             "pinball_step2": float(np.mean(pinball(ytrue[keep], f2, q)) / MICRO),
                             "pinball_nochange": float(np.mean(pinball(ytrue[keep], nc[keep], q)) / MICRO),
                             "hit_model": float(np.mean(ytrue[keep] < f1)),
                             "hit_nochange": float(np.mean(ytrue[keep] < nc[keep]))}
        years = {}
        for y in ("2024", "2025", "2026"):
            m = np.array([origins[n].startswith(y) for n in keep])
            if m.sum():
                years[y] = {"n": int(m.sum()), "skill1": float(1 - L1[m].mean() / Lnc[m].mean()),
                            "I2": float(1 - L2[m].mean() / L1[m].mean())}
        betas = [main_fc[hn][n].get("beta") for n in keep]
        bd = [b for b in betas if b is not None]
        res = {"n_scoring": int(len(keep)), "n_missing_forecast": int(len(sc) - len(keep)),
               "first": origins[keep[0]], "last": origins[keep[-1]],
               "mean_pinball_model_musd": float(L1.mean()), "mean_pinball_nochange_musd": float(Lnc.mean()),
               "mean_pinball_step2_musd": float(L2.mean()),
               "step1_skill": float(skill1), "step1_skill_ci95": ci1, "step1_PASS": bool(skill1 >= STEP1_PASS),
               "step2_improvement": float(I2), "step2_ci95": ci2,
               "step2_ACCEPTED": bool(I2 >= STEP2_PASS and ci2[0] > 0),
               "step2_origins_equal_step1_no_funding": int(sum(1 for b in betas if b is None)),
               "beta_median": float(np.median(bd)) if bd else None,
               "beta_range": [float(np.min(bd)), float(np.max(bd))] if bd else None,
               "per_quantile": per_q, "by_year": years,
               "skill_supply_scaled": float(1 - (L1 / Sx).mean() / (Lnc / Sx).mean()),
               "sensitivity_raw_endpoints_step1_skill": float(1 - Lr.mean() / Lncr.mean()) if len(Lr) else None,
               "q2_reported": {"n": int(len(keepq)),
                               "skill1": float(1 - Lq.mean() / Lncq.mean()) if len(Lq) else None},
               "n_paths_median": float(np.median([main_fc[hn][n]["n_paths"] for n in keep]))}
        per_h[hn] = res
        say(hn, json.dumps({k: res[k] for k in ("n_scoring", "step1_skill", "step1_PASS", "step2_improvement",
                                                "step2_ci95", "step2_ACCEPTED")}))
        qset = set(keepq.tolist())
        for n in np.concatenate([keep, keepq]):
            n = int(n)
            fo = main_fc[hn][n]
            rows_out.append({"h": hn, "origin": origins[n], "q2": n in qset,
                             "y_min_cash_usd": ytrue[n] / MICRO, "nochange_usd": nc[n] / MICRO,
                             "q05": fo["q1"][0] / MICRO, "q25": fo["q1"][1] / MICRO, "q50": fo["q1"][2] / MICRO,
                             "s2_q05": fo["q2"][0] / MICRO, "s2_q25": fo["q2"][1] / MICRO,
                             "s2_q50": fo["q2"][2] / MICRO, "beta": fo.get("beta"), "n_paths": fo["n_paths"],
                             "spread": spread[n], "supply_usd": S_snap[n] / MICRO,
                             "qrt_out_live_usd": Q_live[n] / MICRO, "drt_out_live_usd": R_live[n] / MICRO})
    return per_h, rows_out



# ---------------------------------------------------------------------------------------------
# loaders
# ---------------------------------------------------------------------------------------------
def load_cash_path(cash_dir):
    parts = []
    for f, sign in ((CASH_FILES[0], 1), (CASH_FILES[1], -1)):
        r = pd.read_csv(os.path.join(cash_dir, f), usecols=["block", "ts", "tx_index", "data"], dtype={"data": str})
        parts.append(pd.DataFrame({"block": r["block"].astype(np.int64), "ts": r["ts"].astype(np.int64),
                                   "tx_index": r["tx_index"].astype(np.int64),
                                   "d": np.array([sign * int(d, 16) for d in r["data"]], dtype=np.int64)}))
    lg = pd.concat(parts, ignore_index=True)
    lg = lg[lg["block"] <= END_BLOCK]
    key = lg["block"].to_numpy(np.int64) * 100_000 + lg["tx_index"].to_numpy(np.int64)
    g = lg.groupby(key, sort=True)
    tl = pd.DataFrame({"block": g["block"].first().values, "ts": g["ts"].first().values, "d": g["d"].sum().values})
    tl["cash"] = np.cumsum(tl["d"].to_numpy(np.int64))
    return tl


def load_rdu_rate(cash_dir):
    r = pd.read_csv(os.path.join(cash_dir, CASH_FILES[2]), usecols=["block", "ts", "tx_index", "log_index", "data"],
                    dtype={"data": str})
    r = r[r["block"] <= END_BLOCK]
    r = r.sort_values(["block", "tx_index", "log_index"], kind="mergesort")
    vb = np.array([word(d, 2) / RAY for d in r["data"]])
    df = pd.DataFrame({"ts": r["ts"].to_numpy(np.int64), "vb": vb}).groupby("ts", sort=True).tail(1)
    return df["ts"].to_numpy(np.int64), df["vb"].to_numpy(float)


def load_borrow_repay(datasets, salt):
    def h(a):
        return hashlib.sha256((salt + str(a).lower()).encode()).hexdigest()[:16]
    bs, rs = [], []
    for rel in BORROWS:
        b = pd.read_csv(os.path.join(datasets, rel), usecols=["block", "ts", "log_index", "reserve", "onBehalfOf",
                                                              "amount_raw"], dtype={"amount_raw": str, "reserve": str,
                                                                                    "onBehalfOf": str})
        b = b[b["reserve"].str.lower() == USDC]
        bs.append(pd.DataFrame({"block": b["block"].astype(np.int64).values, "log_index": b["log_index"].astype(
            np.int64).values, "ts": b["ts"].astype(np.int64).values, "unit": [h(a) for a in b["onBehalfOf"]],
            "amount": [int(x) for x in b["amount_raw"]]}))
    for rel in REPAYS:
        r = pd.read_csv(os.path.join(datasets, rel), usecols=["block", "ts", "log_index", "reserve", "user",
                                                              "amount_raw", "useATokens"],
                        dtype={"amount_raw": str, "reserve": str, "user": str, "useATokens": str})
        r = r[(r["reserve"].str.lower() == USDC) & (r["useATokens"].str.lower().isin(["0", "false"]))]
        rs.append(pd.DataFrame({"block": r["block"].astype(np.int64).values, "log_index": r["log_index"].astype(
            np.int64).values, "ts": r["ts"].astype(np.int64).values, "unit": [h(a) for a in r["user"]],
            "amount": [int(x) for x in r["amount_raw"]]}))
    return pd.concat(bs, ignore_index=True), pd.concat(rs, ignore_index=True)


def load_funding(fdir):
    f = pd.read_csv(os.path.join(fdir, "funding-ethusdt.csv"))
    t = ((f["calc_time_ms"].to_numpy(np.int64) + 30_000) // 60_000) * 60
    return t, f["last_funding_rate"].to_numpy(float), f["funding_interval_hours"].to_numpy(np.int64)


def funding_7d(t_f, r_f, ih, t0):
    """365/7 x sum of rates with t in [t0 - 7 d, t0); NaN unless the file covers the window."""
    if len(t_f) == 0 or t_f[0] > t0 - FUND_WINDOW_S or t_f[-1] + int(ih[-1]) * 3600 < t0:
        return float("nan")
    i0 = int(np.searchsorted(t_f, t0 - FUND_WINDOW_S, side="left"))
    i1 = int(np.searchsorted(t_f, t0, side="left"))
    return float(r_f[i0:i1].sum() * 365.0 / 7.0)


def guard(path):
    txt = open(path).read()
    if ADDR_RE.search(txt):
        raise SystemExit(f"STOP: address-like string in {path}")


# ---------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--cash", required=True)
    ap.add_argument("--funding", required=True)
    ap.add_argument("--code-sha", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--inputs-only", action="store_true",
                    help="load and gate the inputs, print counts, stop before the freeze (no forecast, no score)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log = open(os.path.join(a.out, "run.log"), "a")

    def say(*m):
        s = " ".join(str(x) for x in m)
        print(s, flush=True)
        log.write(s + "\n")
        log.flush()

    # ---------- input hashes ----------
    shas = {}
    for f, hh in CASH_SHA.items():
        got = sha256_file(os.path.join(a.cash, f))
        if got != hh:
            raise SystemExit(f"STOP: {f} sha256 {got} != {hh}")
        shas[f"aave-pool-cash/{f}"] = got
    for rel, hh in R9_SHA.items():
        got = sha256_file(os.path.join(a.datasets, rel))
        if got != hh:
            raise SystemExit(f"STOP: {rel} sha256 {got} != {hh}")
        shas[rel] = got
    for rel in [BLOCKS] + BORROWS + REPAYS:
        shas[rel] = sha256_file(os.path.join(a.datasets, rel))
    shas["funding-ethusdt.csv"] = sha256_file(os.path.join(a.funding, "funding-ethusdt.csv"))
    code_path = os.path.abspath(__file__)
    shas["r104_cash.py"] = sha256_file(code_path)

    # ---------- inputs ----------
    say("load w24 / blocks")
    w = pd.read_csv(os.path.join(a.datasets, W24))
    bl = pd.read_csv(os.path.join(a.datasets, BLOCKS))
    bl = bl[bl["kind"] == "daily"].set_index("snapshot")
    w = w[w["origin"].isin(bl.index)].reset_index(drop=True)
    origins = w["origin"].tolist()
    t = np.array([day_ts(d) for d in origins], dtype=np.int64)
    if not (np.diff(t) == DAY).all():
        raise SystemExit("STOP: origins not consecutive days")
    ablk = bl.loc[origins, "block"].to_numpy(np.int64)
    S_snap = w["snap_supply"].to_numpy(float) * MICRO     # raw units (float)
    C_snap = w["snap_cash"].to_numpy(float) * MICRO
    say("load cash path")
    tl = load_cash_path(a.cash)
    cblk = tl["block"].to_numpy(np.int64)
    cts = tl["ts"].to_numpy(np.int64)
    cval = tl["cash"].to_numpy(np.int64)
    end_ts = int(cts.max())
    # G1
    k = np.searchsorted(cblk, ablk, side="right") - 1
    cash_anchor = cval[k]
    g1_mis = int(np.sum(np.abs(cash_anchor - np.round(C_snap)) > 1))
    say("G1 mismatches", g1_mis, "of", len(ablk))
    if g1_mis:
        raise SystemExit("STOP: G1 failed")
    C_end = cash_anchor.astype(float)
    cash_t0 = np.array([state_at(cts, cval, int(x)) for x in t], dtype=float)
    dmin = np.full(len(t), np.nan)
    for i, x in enumerate(t):
        if x + DAY <= end_ts:
            dmin[i] = window_min(cts, cval, int(cash_t0[i]), int(x), int(x) + DAY)
    # round trips
    say("round trips")
    legs = pd.read_csv(os.path.join(a.datasets, QRT_LEGS), dtype={"neutral_raw": str, "event_amount_raw": str})
    legs = legs[["qrt_id", "leg", "block", "ts", "neutral_raw"]]
    vis = t + LOOKAHEAD_S
    Q_full = qrt_outstanding(legs, ablk).astype(float)
    Q_live = qrt_outstanding(legs, ablk, visible_by=vis).astype(float)
    salt = secrets.token_hex(32)
    bo, re_ = load_borrow_repay(a.datasets, salt)
    drts = detect_drt(bo, re_)
    del bo, re_
    R_full = drt_outstanding(drts, ablk).astype(float)
    R_live = drt_outstanding(drts, ablk, visible_by=vis).astype(float)
    # APR and funding
    say("apr / funding")
    rts, rvb = load_rdu_rate(a.cash)
    apr24 = np.array([tw_mean_step(rts, rvb, float(x - DAY), float(x)) for x in t])
    tf, rf, ih = load_funding(a.funding)
    f7 = np.array([funding_7d(tf, rf, ih, int(x)) for x in t])
    spread = f7 - apr24

    # scoring sets
    q2a, q2b = day_ts(Q2[0]), day_ts(Q2[1])
    sets = {}
    for hn, H in HORIZONS.items():
        res = (t + H * DAY <= end_ts)
        inq2 = (t + H * DAY > q2a) & (t < q2b)
        first = t >= day_ts(SCORE_FIRST)
        sets[hn] = {"score": np.where(first & res & ~inq2)[0], "q2": np.where(first & res & inq2)[0]}

    counts = {"origins": len(t), "first_origin": origins[0], "last_origin": origins[-1], "data_end_ts": end_ts,
              "qrt_outstanding_anchors_full": int((Q_full > 0).sum()),
              "qrt_outstanding_anchors_live": int((Q_live > 0).sum()),
              "drt_detected": len(drts), "drt_outstanding_anchors_full": int((R_full > 0).sum()),
              "drt_outstanding_anchors_live": int((R_live > 0).sum()),
              "drt_by_year": {y: sum(1 for d in drts if ts_day(d["borrow_ts"]).startswith(y))
                              for y in ("2023", "2024", "2025", "2026")},
              "spread_defined": int(np.isfinite(spread).sum()),
              "funding_undefined_origins": [origins[i] for i in np.where(~np.isfinite(f7))[0]][-20:],
              "scoring_origins": {h: int(len(v["score"])) for h, v in sets.items()},
              "q2_origins": {h: int(len(v["q2"])) for h, v in sets.items()}}
    say("counts", json.dumps(counts))
    if a.inputs_only:
        say("inputs-only: stop before freeze")
        return

    # ---------- freeze before scoring ----------
    frozen = {"schema": SCHEMA, "prereg": PREREG, "code_sha": a.code_sha, "started": started,
              "inputs_sha256": shas, "decisions": DECISIONS,
              "constants": {"QS": QS, "HORIZONS": HORIZONS, "TRAIL_DAYS": TRAIL_DAYS, "HAR_LAGS": HAR_LAGS,
                            "SCORE_FIRST": SCORE_FIRST, "Q2": Q2, "END_BLOCK": END_BLOCK, "LOOKAHEAD_S": LOOKAHEAD_S,
                            "DRT_MIN_USD": DRT_MIN_RAW // MICRO, "DRT_WINDOW_S": DRT_WINDOW_S, "DRT_FILL": DRT_FILL,
                            "STEP1_PASS": STEP1_PASS, "STEP2_PASS": STEP2_PASS, "BOOT_BLOCK": BOOT_BLOCK,
                            "BOOT_REPS": BOOT_REPS, "SEED": SEED},
              "input_counts": counts}
    fp = os.path.join(a.out, "frozen-r104.json")
    with open(fp, "w") as f:
        json.dump(frozen, f, indent=1, default=str)
    guard(fp)
    fh = sha256_file(fp)
    say("FROZEN frozen-r104.json sha256", fh)

    # ---------- forecasts and scores ----------
    full = make_flows(S_snap, C_end, dmin, Q_full, R_full)
    live = make_flows(S_snap, C_end, dmin, Q_live, R_live)
    raw = make_flows(S_snap, C_end, dmin, np.zeros(len(t)), np.zeros(len(t)))
    say("forecast main")
    main_fc = run_variant(full, live, dmin, cash_t0, sets, spread, True)
    say("forecast sensitivity (raw endpoints)")
    raw_fc = run_variant(raw, None, dmin, cash_t0, sets, spread, False)
    rng = np.random.default_rng(SEED)
    per_h, rows_out = score_all(dmin, sets, main_fc, raw_fc, S_snap, origins, spread, Q_live, R_live, rng, say)
    results = {"schema": SCHEMA, "frozen_sha256": fh, "code_sha": a.code_sha, "counts": counts, "per_h": per_h}
    results["finished"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rp = os.path.join(a.out, "results-r104.json")
    with open(rp, "w") as f:
        json.dump(results, f, indent=1, default=str)
    fcp = os.path.join(a.out, "forecasts-r104.csv.gz")
    pd.DataFrame(rows_out).to_csv(fcp, index=False, compression="gzip")
    guard(rp)
    with gzip.open(fcp, "rt") as f:
        if ADDR_RE.search(f.read()):
            raise SystemExit("STOP: address-like string in forecasts")
    say("DONE results", sha256_file(rp))


if __name__ == "__main__":
    main()
