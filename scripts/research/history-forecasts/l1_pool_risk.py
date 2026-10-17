#!/usr/bin/env python3
"""Q26 round 8 R8.4 lender lock and spike risk (workstream L1; Aave V3 Core USDC, pool level).

membrane-board design/Q26_ROUND8_PREREG.md @91a3eba, item R8.4.

  python3 l1_pool_risk.py fit   --datasets <membrane-datasets> --cash <aave-pool-cash dir> --out <dir>
  python3 l1_pool_risk.py score --datasets <membrane-datasets> --cash <aave-pool-cash dir> --out <dir> \
                                --frozen-sha256 <sha256 of <out>/frozen-l1.json>

Targets (daily origins t0 = 00:00Z): LOCK(h) = 1 iff pool cash < 0.5% of aUSDC supply at any event time in
(t0, t0 + h]; SPIKE(h) = 1 iff the supply APR reaches >= 2 x its t0 value and >= t0 value + 3 pp in (t0, t0 + h].
h in {24 h, 7 d}.

Model: penalized (ridge, lambda = 1.0) logistic regression on pool state at t0: utilization, cash/supply, log cash,
borrow APR and its 1-day change, ETH RV7, top-10 holder share of supply, R7.2 S10 shortfall/cash. Expanding-window
folds by test quarter from 2024Q1, one fit per fold (and per target x horizon).

Phases: `fit` builds the panel, fits every fold, writes frozen-l1.json (coefficients, scaling, clip bounds, input
sha256) and the out-of-sample predictions, and prints the frozen file's sha256. `score` refuses unless the frozen
file's sha256 matches --frozen-sha256, then writes results-l1.json (events per year, BSS vs the historical base
rate, R = sum p / sum y, block-bootstrap CIs, the April 2026 case, labels capped at MEDIUM).

Readings of the registered text are in DECISIONS below.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND8_PREREG.md", "commit": "91a3eba",
          "item": "R8.4"}
SCHEMA = "q26-r8/l1/1"
MICRO = 10 ** 6
RAY = 10 ** 27
LOCK_FRAC = 0.005
SPIKE_MULT = 2.0
SPIKE_ADD = 0.03
HORIZONS = {"24h": 86400, "7d": 7 * 86400}
TARGETS = ("LOCK", "SPIKE")
FEATURES = ("util", "cash_supply", "log_cash", "borrow_apr", "d_borrow_apr", "eth_rv7", "top10_share",
            "s10_shortfall_cash")
RIDGE_LAMBDA = 1.0
FIRST_TEST_Q = (2024, 1)
CLIP_Q = (0.01, 0.99)
BOOT_B = 2000
BOOT_BLOCK_DAYS = 30
BOOT_SEED = 20261084
APRIL = ("2026-04-10", "2026-04-30")
APRIL_WINDOW = ("2026-04-18", "2026-04-25")
USDC_ADDR = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
AUSDC = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c"

RESERVE_STATE = "depositor-balances/reserve-state.csv"
BLOCKS = "depositor-balances/blocks.csv"
BAL_P = "depositor-balances/daily-balances-usdc.csv.gz"
BAL_EXT = "depositor-events/daily-balances-ext-usdc.csv.gz"
EVENTS = [f"depositor-events/events-usdc-{y}.csv.gz" for y in (2023, 2024, 2025, 2026)]
ETH = "price-history/eth-usd-1h.json"
R7_REFILL = "history-forecasts/r7/r7-refill-usdc.json"
CASH_FILES = ("raw-logs-usdc-in.csv.gz", "raw-logs-usdc-out.csv.gz", "raw-logs-rdu.csv.gz")

DECISIONS = [
    "L1-1 cash = USDC.balanceOf(aUSDC), the reserve-state `cash` field. Intraday cash = the reserve-state cash at "
    "the 2023-02-01 snapshot plus every later USDC Transfer into aUSDC minus every Transfer out (aave-pool-cash, "
    "acquired for this item). The run checks the reconstruction equals the reserve-state cash at every daily "
    "snapshot and the asof block, exactly in raw units; a mismatch stops the run.",
    "L1-2 supply = aUSDC totalSupply. Intraday supply = the latest snapshot totalSupply at or before the event "
    "(daily reserve-state rows plus asof) plus the sum of depositor-events Mint/Burn `delta1_raw` after that "
    "snapshot block (Mint value - balanceIncrease; Burn -(value + balanceIncrease); treasury mints included; "
    "BalanceTransfer nets to zero). Interest accrued inside the day is not added (<= ~0.03% of supply per day; "
    "reported as the end-of-day residual against the next snapshot).",
    "L1-3 'event time' = the end of each transaction that changes cash or supply or emits ReserveDataUpdated (all "
    "logs of a transaction applied together). Intra-transaction states (e.g. a flash loan's borrowed leg) are "
    "not event times. Window (t0, t0 + h] by block timestamp: t0 < ts <= t0 + h.",
    "L1-4 supply APR = Pool ReserveDataUpdated `liquidityRate` / 1e27 for USDC (the last one in a transaction). "
    "The t0 value is the reserve-state `liquidityRate` at the t0 snapshot (the rate in force at t0). SPIKE needs "
    "max over the window >= 2 r0 AND >= r0 + 0.03.",
    "L1-5 features at t0 from the t0 snapshot (largest block with timestamp < t0): util = variableDebt / "
    "(variableDebt + cash); cash_supply = cash / totalSupply; log_cash = ln(1 + cash USD); borrow_apr = "
    "variableBorrowRate / 1e27; d_borrow_apr = borrow_apr(t0) - borrow_apr(t0 - 1 d); eth_rv7 = sqrt(sum of "
    "squared hourly log returns of the price-history primary ETH/USD series) over the 168 returns whose later "
    "bar is stamped <= t0 - 1 h (a bar stamped t0 - 1 h has closed by t0 whether the stamp is its open or close); "
    "top10_share = sum of the 10 largest aUSDC balances at the snapshot (depositor-balances P_r plus the "
    "depositor-events extended universe, i.e. every address that ever reached $1M or entered P_r) / totalSupply; "
    "s10_shortfall_cash = (that top-10 sum - cash) / cash (R7.2 S10 shortfall over cash; cash floored at $1).",
    "L1-6 fit: per fold, each feature is clipped to the training rows' 1st/99th percentiles, then z-scored with "
    "the training mean and sd (sd 0 -> 1); test rows use the training bounds and scaling. Ridge lambda = 1.0 on "
    "this scale: minimize sum_i logloss_i + 0.5 * 1.0 * ||beta||^2, intercept unpenalized (= scikit-learn C = 1), "
    "Newton iterations to |step| < 1e-10. Clipping is part of the fitting procedure, needed because "
    "s10_shortfall_cash reaches ~1e5 when cash is near 0; it is not a feature change.",
    "L1-7 folds: test quarter Q (2024Q1 .. the last quarter with origins). Training rows: every origin with all "
    "features whose label window has closed by the start of Q (t0 + h <= Q start). A fold whose training rows "
    "hold no positive or no negative label predicts the training base rate (recorded as `degenerate`).",
    "L1-8 historical base rate = the fold's training-row mean of y (no look-ahead); BSS = 1 - Brier(model) / "
    "Brier(base rate) on pooled out-of-sample rows. R = sum p / sum y (R < 1 = under-forecast). CIs: moving-block "
    "bootstrap over origin days, 30-day blocks, 2000 draws, numpy default_rng(20261084). Reported, deciding "
    "nothing.",
    "L1-9 events per year: positive origin days; episodes = maximal runs of consecutive positive origin days; "
    "for LOCK also intraday lock spells (cash < 0.5% of supply, spells less than 24 h apart merged), all per "
    "calendar year (2026 partial).",
    "L1-10 label (prereg: few events cap the label at MEDIUM; HIGH needs the live log): MEDIUM iff test-period "
    "episodes >= 10 AND 0.67 <= R <= 1.5 AND the BSS CI lower bound > 0; else LOW. Whether the B2 MEDIUM count "
    "(n_ep >= 50) is met is reported beside it.",
    "L1-11 origins: 2023-02-02 (first day with a prior snapshot) through 2026-10-06 (last day with ETH RV7 and a "
    "full 7 d window inside the cash data, end block 26186746 at 2026-10-13T23:05:59Z). Each target x horizon "
    "uses the origins whose window is fully covered.",
]


# ---------------------------------------------------------------------------------------------
# helpers
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


def quarter_start(y, q):
    return int(datetime(y, 3 * (q - 1) + 1, 1, tzinfo=timezone.utc).timestamp())


def quarter_of(t):
    d = datetime.fromtimestamp(int(t), tz=timezone.utc)
    return d.year, (d.month - 1) // 3 + 1


def next_quarter(y, q):
    return (y + 1, 1) if q == 4 else (y, q + 1)


def word(data, i):
    s = data[2 + 64 * i: 2 + 64 * (i + 1)]
    return int(s, 16)


# ---------------------------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------------------------
def load_reserve_state(datasets):
    rs = pd.read_csv(os.path.join(datasets, RESERVE_STATE), dtype=str)
    rs = rs[rs["reserve"] == "USDC"].copy()
    out = pd.DataFrame({
        "snapshot": rs["snapshot"].values,
        "block": rs["block"].astype(np.int64).values,
        "block_ts": rs["block_ts"].astype(np.int64).values,
        "supply": [int(x) for x in rs["totalSupply"]],
        "cash": [int(x) for x in rs["cash"]],
        "vdebt": [int(x) for x in rs["variableDebt"]],
        "liq_rate": [int(x) / RAY for x in rs["liquidityRate_ray"]],
        "vb_rate": [int(x) / RAY for x in rs["variableBorrowRate_ray"]],
    })
    return out.sort_values("block").reset_index(drop=True)


def read_raw(path):
    return pd.read_csv(path, dtype={"data": str, "topic1": str, "topic2": str, "tx_hash": str})


def load_cash_streams(cash_dir):
    """-> DataFrame of log-level rows: block, ts, tx_index, log_index, dcash (int), liq_rate (float or NaN)."""
    fin, fout, frdu = (os.path.join(cash_dir, f) for f in CASH_FILES)
    rows = []
    for path, sign in ((fin, 1), (fout, -1)):
        r = read_raw(path)
        v = [sign * int(d, 16) for d in r["data"]]
        rows.append(pd.DataFrame({"block": r["block"].astype(np.int64), "ts": r["ts"].astype(np.int64),
                                  "tx_index": r["tx_index"].astype(np.int64),
                                  "log_index": r["log_index"].astype(np.int64),
                                  "dcash": np.array(v, dtype=np.int64), "dsupply": 0, "liq_rate": np.nan,
                                  "vb_rate": np.nan}))
    r = read_raw(frdu)
    rows.append(pd.DataFrame({"block": r["block"].astype(np.int64), "ts": r["ts"].astype(np.int64),
                              "tx_index": r["tx_index"].astype(np.int64),
                              "log_index": r["log_index"].astype(np.int64), "dcash": 0, "dsupply": 0,
                              "liq_rate": [word(d, 0) / RAY for d in r["data"]],
                              "vb_rate": [word(d, 2) / RAY for d in r["data"]]}))
    return rows


def load_supply_events(datasets):
    out = []
    for rel in EVENTS:
        for ch in pd.read_csv(os.path.join(datasets, rel), usecols=["block", "ts", "tx_index", "log_index", "type",
                                                                    "delta1_raw"],
                              dtype={"delta1_raw": "object"}, chunksize=2_000_000):
            ch = ch[ch["type"].isin(["Mint", "Burn"]) & ch["delta1_raw"].notna()]
            out.append(pd.DataFrame({"block": ch["block"].astype(np.int64), "ts": ch["ts"].astype(np.int64),
                                     "tx_index": ch["tx_index"].astype(np.int64),
                                     "log_index": ch["log_index"].astype(np.int64), "dcash": 0,
                                     "dsupply": ch["delta1_raw"].astype(np.int64).to_numpy(),
                                     "liq_rate": np.nan, "vb_rate": np.nan}))
    return out


def tx_timeline(parts, rs, end_block):
    """Merge log-level parts into end-of-transaction states with exact integer cash and anchored supply.

    Returns (tl, check): tl has block, ts, cash (USD float), supply (USD float), liq_rate (last in tx or NaN,
    forward-filled as liq_ff), cash_raw exact int; check = reconstruction diagnostics against reserve-state."""
    ev = pd.concat(parts, ignore_index=True)
    ev = ev[(ev["block"] > int(rs["block"].iloc[0])) & (ev["block"] <= end_block)]
    ev = ev.sort_values(["block", "tx_index", "log_index"], kind="mergesort").reset_index(drop=True)
    key = ev["block"].to_numpy(np.int64) * 100_000 + ev["tx_index"].to_numpy(np.int64)
    g = ev.groupby(key, sort=True)
    dcash = g["dcash"].sum()
    dsup = g["dsupply"].sum()
    lr = g["liq_rate"].last()
    vb = g["vb_rate"].last()
    blk = g["block"].first()
    ts = g["ts"].first()
    tl = pd.DataFrame({"block": blk.values, "ts": ts.values, "dcash": dcash.values, "dsupply": dsup.values,
                       "liq_rate": lr.values, "vb_rate": vb.values})
    # exact cash from the first snapshot
    c0 = int(rs["cash"].iloc[0])
    cash_raw = c0 + np.cumsum(tl["dcash"].to_numpy(np.int64))
    tl["cash_raw"] = cash_raw
    # check at every snapshot: cash after all tx with block <= snapshot block
    blocks = tl["block"].to_numpy(np.int64)
    mism = []
    for _, r in rs.iterrows():
        k = int(np.searchsorted(blocks, int(r["block"]), side="right")) - 1
        rec = c0 if k < 0 else int(cash_raw[k])
        if int(r["block"]) > end_block:
            continue
        if rec != int(r["cash"]):
            mism.append({"snapshot": r["snapshot"], "block": int(r["block"]), "recon": rec, "actual": int(r["cash"])})
    # supply anchored at the latest snapshot at or before each tx
    sb = rs["block"].to_numpy(np.int64)
    ssup = rs["supply"].tolist()
    dsup_cum = np.cumsum(tl["dsupply"].to_numpy(np.int64))
    anchor_idx = np.searchsorted(sb, blocks, side="left") - 1      # snapshot block < tx block
    cum_at_anchor = []
    for j in range(len(sb)):
        k = int(np.searchsorted(blocks, sb[j], side="right")) - 1
        cum_at_anchor.append(0 if k < 0 else int(dsup_cum[k]))
    ssup_a = np.array(ssup, dtype=np.int64)
    cum_a = np.array(cum_at_anchor, dtype=np.int64)
    if (anchor_idx < 0).any():
        raise SystemExit("STOP: a transaction precedes the first snapshot")
    supply = (ssup_a[anchor_idx] + dsup_cum - cum_a[anchor_idx]) / MICRO
    # end-of-day supply residual vs the next snapshot (interest accrual and anything missed)
    resid = []
    for j in range(len(sb) - 1):
        if sb[j + 1] > end_block:
            break
        k = int(np.searchsorted(blocks, sb[j + 1], side="right")) - 1
        pred = ssup[j] + (int(dsup_cum[k]) if k >= 0 else 0) - cum_at_anchor[j]
        resid.append((ssup[j + 1] - pred) / ssup[j + 1] if ssup[j + 1] else 0.0)
    resid = np.abs(np.array(resid))
    tl["cash"] = cash_raw.astype(float) / MICRO
    tl["supply"] = supply
    tl["liq_ff"] = tl["liq_rate"].ffill()
    tl["ratio"] = tl["cash"] / tl["supply"]
    check = {"nTx": int(len(tl)), "nLogs": int(len(ev)), "cashMismatches": len(mism), "cashMismatchFirst": mism[:5],
             "snapshotsChecked": int((rs["block"] <= end_block).sum()),
             "supplyResidualAbsRel": {"median": float(np.median(resid)), "p99": float(np.quantile(resid, 0.99)),
                                      "max": float(resid.max())}}
    return tl.drop(columns=["dcash", "dsupply"]), check


def load_eth(datasets):
    d = json.load(open(os.path.join(datasets, ETH)))
    n = d["count"]
    px = np.full(n, np.nan)
    for seg in d["primary"]["segments"]:
        col = d["columns"][seg["source"]]
        for i in range(seg["fromIndex"], seg["toIndex"] + 1):
            v = col[i]
            px[i] = np.nan if v is None else float(v)
    ts = d["startTs"] + d["stepSeconds"] * np.arange(n)
    return ts.astype(np.int64), px


def eth_rv7(eth_ts, eth_px, t0):
    """sqrt(sum r^2) over the 168 hourly log returns whose later bar is stamped <= t0 - 3600."""
    k = int(np.searchsorted(eth_ts, t0 - 3600, side="right")) - 1
    if k - 168 < 0 or eth_ts[k] != t0 - 3600:
        return np.nan
    p = eth_px[k - 168: k + 1]
    if np.isnan(p).any():
        return np.nan
    r = np.diff(np.log(p))
    return float(np.sqrt(np.sum(r * r)))


def top10_by_snapshot(datasets):
    sums = {}
    for rel in (BAL_P, BAL_EXT):
        for ch in pd.read_csv(os.path.join(datasets, rel), usecols=["snapshot", "address", "balance_raw"],
                              dtype={"balance_raw": "object", "snapshot": str}, chunksize=2_000_000):
            ch = ch[ch["balance_raw"].notna() & ~ch["snapshot"].isin(["asof", "asof_events"])]
            ch = ch.assign(b=ch["balance_raw"].astype(float))
            ch = ch[ch["b"] > 0]
            for snap, grp in ch.groupby("snapshot"):
                top = grp.nlargest(10, "b")[["address", "b"]]
                sums.setdefault(snap, []).append(top)
    out = {}
    for snap, lst in sums.items():
        t = pd.concat(lst).drop_duplicates("address", keep="first").nlargest(10, "b")
        out[snap] = float(t["b"].sum()) / MICRO
    return out


# ---------------------------------------------------------------------------------------------
# panel: features and labels
# ---------------------------------------------------------------------------------------------
def features(rs, top10, eth_ts, eth_px):
    rows = []
    prev = None
    for _, r in rs.iterrows():
        snap = r["snapshot"]
        if snap == "asof":
            continue
        t0 = day_ts(snap)
        cash = r["cash"] / MICRO
        sup = r["supply"] / MICRO
        vd = r["vdebt"] / MICRO
        f = {"snapshot": snap, "t0": t0, "block": int(r["block"]),
             "util": vd / (vd + cash) if vd + cash > 0 else np.nan,
             "cash_supply": cash / sup if sup > 0 else np.nan,
             "log_cash": math.log1p(cash),
             "borrow_apr": r["vb_rate"],
             "d_borrow_apr": (r["vb_rate"] - prev["vb_rate"]) if prev is not None
             and day_ts(prev["snapshot"]) == t0 - 86400 else np.nan,
             "eth_rv7": eth_rv7(eth_ts, eth_px, t0),
             "top10_share": top10[snap] / sup if snap in top10 and sup > 0 else np.nan,
             "s10_shortfall_cash": (top10[snap] - cash) / max(cash, 1.0) if snap in top10 else np.nan,
             "r0": r["liq_rate"]}
        rows.append(f)
        prev = r
    return pd.DataFrame(rows)


def labels(panel, tl, end_ts):
    """LOCK/SPIKE per origin and horizon; NaN where the window is not covered by the cash data."""
    ts = tl["ts"].to_numpy(np.int64)
    ratio = tl["ratio"].to_numpy(float)
    lr = tl["liq_rate"].to_numpy(float)
    lock = ratio < LOCK_FRAC
    out = {}
    for hn, hs in HORIZONS.items():
        yl, ys = [], []
        for t0, r0 in zip(panel["t0"].to_numpy(np.int64), panel["r0"].to_numpy(float)):
            if t0 + hs > end_ts:
                yl.append(np.nan)
                ys.append(np.nan)
                continue
            a = int(np.searchsorted(ts, t0, side="right"))
            b = int(np.searchsorted(ts, t0 + hs, side="right"))
            yl.append(float(lock[a:b].any()))
            w = lr[a:b]
            w = w[~np.isnan(w)]
            m = w.max() if len(w) else -np.inf
            ys.append(float(m >= SPIKE_MULT * r0 and m >= r0 + SPIKE_ADD))
        out[f"LOCK_{hn}"] = yl
        out[f"SPIKE_{hn}"] = ys
    return pd.DataFrame(out, index=panel.index)


def lock_spells(tl, merge_s=86400):
    ts = tl["ts"].to_numpy(np.int64)
    lock = tl["ratio"].to_numpy(float) < LOCK_FRAC
    spells = []
    i, n = 0, len(ts)
    while i < n:
        if lock[i]:
            j = i
            while j + 1 < n and lock[j + 1]:
                j += 1
            end = ts[j + 1] if j + 1 < n else ts[j]
            if spells and ts[i] - spells[-1][1] < merge_s:
                spells[-1][1] = end
            else:
                spells.append([int(ts[i]), int(end)])
            i = j + 1
        else:
            i += 1
    return spells


# ---------------------------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------------------------
def ridge_logit(X, y, lam=RIDGE_LAMBDA, tol=1e-10, max_iter=100):
    """min sum logloss + 0.5 lam ||beta||^2 (intercept unpenalized). X without intercept column."""
    n, k = X.shape
    Z = np.column_stack([np.ones(n), X])
    w = np.zeros(k + 1)
    pen = np.full(k + 1, lam)
    pen[0] = 0.0
    for _ in range(max_iter):
        eta = Z @ w
        p = 1.0 / (1.0 + np.exp(-eta))
        g = Z.T @ (p - y) + pen * w
        W = p * (1 - p)
        H = (Z * W[:, None]).T @ Z + np.diag(pen) + 1e-12 * np.eye(k + 1)
        step = np.linalg.solve(H, g)
        w = w - step
        if np.max(np.abs(step)) < tol:
            break
    return w


def fit_scaler(X):
    lo = np.quantile(X, CLIP_Q[0], axis=0)
    hi = np.quantile(X, CLIP_Q[1], axis=0)
    Xc = np.clip(X, lo, hi)
    mu = Xc.mean(axis=0)
    sd = Xc.std(axis=0)
    sd[sd == 0] = 1.0
    return {"lo": lo.tolist(), "hi": hi.tolist(), "mu": mu.tolist(), "sd": sd.tolist()}


def apply_scaler(X, s):
    return (np.clip(X, np.array(s["lo"]), np.array(s["hi"])) - np.array(s["mu"])) / np.array(s["sd"])


def predict(fit, X):
    if fit["degenerate"]:
        return np.full(len(X), fit["baseRate"])
    Z = apply_scaler(X, fit["scaler"])
    w = np.array(fit["coef"])
    return 1.0 / (1.0 + np.exp(-(w[0] + Z @ w[1:])))


def fold_list(t0s):
    last = quarter_of(int(max(t0s)))
    out, q = [], FIRST_TEST_Q
    while q <= last:
        out.append(q)
        q = next_quarter(*q)
    return out


def train_mask(t0, hs, q_start):
    """Rows whose label window (t0, t0 + hs] has closed by the test-quarter start."""
    return t0 + hs <= q_start


def fit_folds(panel, ycol, hs):
    ok = panel[list(FEATURES)].notna().all(axis=1) & panel[ycol].notna()
    P = panel[ok]
    t0 = P["t0"].to_numpy(np.int64)
    X = P[list(FEATURES)].to_numpy(float)
    y = P[ycol].to_numpy(float)
    fits, preds = [], []
    for (yy, qq) in fold_list(t0):
        qs = quarter_start(yy, qq)
        qe = quarter_start(*next_quarter(yy, qq))
        tr = train_mask(t0, hs, qs)
        te = (t0 >= qs) & (t0 < qe)
        if not te.any():
            continue
        ytr = y[tr]
        base = float(ytr.mean()) if len(ytr) else float("nan")
        fit = {"quarter": f"{yy}Q{qq}", "testStart": ts_day(qs), "nTrain": int(tr.sum()),
               "nTrainPos": int(ytr.sum()), "baseRate": base, "lastTrainOrigin": ts_day(t0[tr].max())
               if tr.any() else None}
        if len(ytr) == 0 or ytr.sum() == 0 or ytr.sum() == len(ytr):
            fit["degenerate"] = True
        else:
            fit["degenerate"] = False
            sc = fit_scaler(X[tr])
            w = ridge_logit(apply_scaler(X[tr], sc), ytr)
            fit["scaler"] = sc
            fit["coef"] = w.tolist()
        p = predict(fit, X[te])
        fit["nTest"] = int(te.sum())
        fits.append(fit)
        preds.append(pd.DataFrame({"snapshot": P["snapshot"].values[te], "t0": t0[te], "y": y[te], "p": p,
                                   "p_base": base, "quarter": fit["quarter"]}))
    return fits, (pd.concat(preds, ignore_index=True) if preds else pd.DataFrame())


# ---------------------------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------------------------
def brier(p, y):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def bss(p, pref, y):
    br = brier(pref, y)
    return (1.0 - brier(p, y) / br) if br > 0 else None


def ratio_R(p, y):
    sy = float(np.sum(y))
    return float(np.sum(p)) / sy if sy > 0 else None


def episodes(dates_pos):
    """Maximal runs of consecutive days -> list of (start, end)."""
    ds = sorted(day_ts(d) for d in dates_pos)
    runs = []
    for t in ds:
        if runs and t - runs[-1][1] == 86400:
            runs[-1][1] = t
        else:
            runs.append([t, t])
    return [(ts_day(a), ts_day(b)) for a, b in runs]


def block_boot(pr, B=BOOT_B, block=BOOT_BLOCK_DAYS, seed=BOOT_SEED):
    rng = np.random.default_rng(seed)
    n = len(pr)
    p, pb, y = pr["p"].to_numpy(float), pr["p_base"].to_numpy(float), pr["y"].to_numpy(float)
    nb = int(math.ceil(n / block))
    bs, rs_ = [], []
    for _ in range(B):
        starts = rng.integers(0, max(1, n - block + 1), size=nb)
        idx = np.concatenate([np.arange(s, min(s + block, n)) for s in starts])[:n]
        v = bss(p[idx], pb[idx], y[idx])
        if v is not None:
            bs.append(v)
        r = ratio_R(p[idx], y[idx])
        if r is not None:
            rs_.append(r)
    q = lambda a: [float(np.quantile(a, 0.025)), float(np.quantile(a, 0.975))] if len(a) else None
    return {"bssCI": q(bs), "RCI": q(rs_), "B": B, "blockDays": block, "seed": seed}


def per_year(dates):
    out = {}
    for d in dates:
        out[d[:4]] = out.get(d[:4], 0) + 1
    return dict(sorted(out.items()))


def label_for(n_ep, R, ci):
    if n_ep >= 10 and R is not None and 0.67 <= R <= 1.5 and ci and ci[0] > 0:
        return "MEDIUM"
    return "LOW"


def score_cell(pr, panel_y, ycol):
    y, p, pb = pr["y"].to_numpy(float), pr["p"].to_numpy(float), pr["p_base"].to_numpy(float)
    pos = pr.loc[pr["y"] == 1, "snapshot"].tolist()
    eps = episodes(pos)
    allpos = panel_y.loc[panel_y[ycol] == 1, "snapshot"].tolist()
    alleps = episodes(allpos)
    R = ratio_R(p, y)
    boot = block_boot(pr)
    clim = float(y.mean())
    res = {"nTest": int(len(y)), "testFrom": pr["snapshot"].min(), "testTo": pr["snapshot"].max(),
           "nPos": int(y.sum()), "nEpisodes": len(eps), "brier": brier(p, y), "brierBase": brier(pb, y),
           "bssVsBase": bss(p, pb, y), "bssVsTestClimatology": bss(p, np.full(len(y), clim), y),
           "R": R, "Rbase": ratio_R(pb, y), **boot,
           "positiveDaysPerYearAll": per_year(allpos),
           "episodesPerYearAll": per_year([a for a, _ in alleps]),
           "nOriginsAll": int(panel_y[ycol].notna().sum()), "nPosAll": int(len(allpos))}
    ex = ~pr["snapshot"].between(*APRIL_WINDOW)
    res["withoutApril18to25"] = {"n": int(ex.sum()), "nPos": int(y[ex].sum()),
                                 "bssVsBase": bss(p[ex], pb[ex], y[ex]), "R": ratio_R(p[ex], y[ex])}
    res["label"] = label_for(len(eps), R, boot["bssCI"])
    res["labelCap"] = "MEDIUM (few events; HIGH needs 90 resolved live days)"
    res["b2MediumCountMet"] = len(eps) >= 50
    return res


# ---------------------------------------------------------------------------------------------
# pipeline
# ---------------------------------------------------------------------------------------------
def build_panel(datasets, cash_dir, end_block=None):
    rs = load_reserve_state(datasets)
    raw_rdu = read_raw(os.path.join(cash_dir, CASH_FILES[2]))
    run_log = json.load(open(os.path.join(cash_dir, "run-log.json")))
    end_block = end_block or int(run_log["endBlock"])
    parts = load_cash_streams(cash_dir) + load_supply_events(datasets)
    tl, check = tx_timeline(parts, rs, end_block)
    if check["cashMismatches"]:
        raise SystemExit(f"STOP: cash reconstruction mismatch: {json.dumps(check['cashMismatchFirst'])}")
    end_ts = int(max(raw_rdu["ts"].max(), tl["ts"].max()))
    eth_ts, eth_px = load_eth(datasets)
    top10 = top10_by_snapshot(datasets)
    panel = features(rs, top10, eth_ts, eth_px)
    panel = pd.concat([panel, labels(panel, tl, end_ts)], axis=1)
    return panel, tl, check, end_ts


def inputs_sha(datasets, cash_dir):
    d = {rel: sha256_file(os.path.join(datasets, rel)) for rel in [RESERVE_STATE, BAL_P, BAL_EXT, ETH] + EVENTS}
    for f in CASH_FILES + ("run-log.json",):
        d[f"aave-pool-cash/{f}"] = sha256_file(os.path.join(cash_dir, f))
    return d


def phase_fit(a):
    panel, tl, check, end_ts = build_panel(a.datasets, a.cash)
    os.makedirs(a.out, exist_ok=True)
    frozen = {"schema": SCHEMA, "prereg": PREREG, "features": list(FEATURES), "ridgeLambda": RIDGE_LAMBDA,
              "clipQuantiles": list(CLIP_Q), "decisions": DECISIONS, "inputs": inputs_sha(a.datasets, a.cash),
              "code": {"file": "scripts/research/history-forecasts/l1_pool_risk.py",
                       "sha256": sha256_file(os.path.abspath(__file__))},
              "reconstruction": check, "cashDataEndTs": end_ts, "fits": {}}
    allpred = []
    for tgt in TARGETS:
        for hn, hs in HORIZONS.items():
            col = f"{tgt}_{hn}"
            fits, pr = fit_folds(panel, col, hs)
            frozen["fits"][col] = fits
            pr["cell"] = col
            allpred.append(pr)
    pred = pd.concat(allpred, ignore_index=True)
    panel.to_csv(os.path.join(a.out, "panel-l1.csv.gz"), index=False)
    pred.to_csv(os.path.join(a.out, "oos-predictions-l1.csv.gz"), index=False)
    frozen["outputs"] = {f: sha256_file(os.path.join(a.out, f)) for f in ("panel-l1.csv.gz",
                                                                          "oos-predictions-l1.csv.gz")}
    p = os.path.join(a.out, "frozen-l1.json")
    if os.path.exists(p):
        raise SystemExit(f"STOP: {p} exists (fit once; never rewritten)")
    data = (json.dumps(frozen, indent=1, sort_keys=True, default=float) + "\n").encode()
    with open(p, "xb") as f:
        f.write(data)
    spells = lock_spells(tl)
    with open(os.path.join(a.out, "lock-spells-l1.json"), "w") as f:
        json.dump([{"start": datetime.fromtimestamp(s, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
                    "end": datetime.fromtimestamp(e, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
                    "hours": (e - s) / 3600} for s, e in spells], f, indent=1)
    print(hashlib.sha256(data).hexdigest())
    return 0


def phase_score(a):
    p = os.path.join(a.out, "frozen-l1.json")
    if sha256_file(p) != a.frozen_sha256:
        raise SystemExit("STOP: frozen-l1.json sha256 does not match --frozen-sha256")
    frozen = json.load(open(p))
    for f, h in frozen["outputs"].items():
        if sha256_file(os.path.join(a.out, f)) != h:
            raise SystemExit(f"STOP: {f} changed since the freeze")
    panel = pd.read_csv(os.path.join(a.out, "panel-l1.csv.gz"))
    pred = pd.read_csv(os.path.join(a.out, "oos-predictions-l1.csv.gz"))
    spells = json.load(open(os.path.join(a.out, "lock-spells-l1.json")))
    res = {"schema": SCHEMA, "prereg": PREREG, "frozenSha256": a.frozen_sha256, "decides": False,
           "decisions": DECISIONS, "reconstruction": frozen["reconstruction"], "cells": {}}
    for col in frozen["fits"]:
        pr = pred[pred["cell"] == col].sort_values("t0").reset_index(drop=True)
        res["cells"][col] = score_cell(pr, panel, col)
        fl = frozen["fits"][col]
        res["cells"][col]["folds"] = [{k: f.get(k) for k in ("quarter", "nTrain", "nTrainPos", "baseRate",
                                                             "degenerate", "nTest")} for f in fl]
        last = [f for f in fl if not f["degenerate"]]
        if last:
            res["cells"][col]["lastFoldCoef"] = dict(zip(["intercept"] + list(FEATURES), last[-1]["coef"]))
    res["lockSpellsPerYear"] = per_year([s["start"] for s in spells])
    res["lockSpells"] = spells
    # April 2026 case
    ap = panel[panel["snapshot"].between(*APRIL)].copy()
    rows = []
    for _, r in ap.iterrows():
        row = {"origin": r["snapshot"], "cash_supply": r["cash_supply"], "util": r["util"],
               "supplyAPR_t0": r["r0"], "borrowAPR": r["borrow_apr"], "top10_share": r["top10_share"]}
        for col in frozen["fits"]:
            m = pred[(pred["cell"] == col) & (pred["snapshot"] == r["snapshot"])]
            row[col] = {"y": None if pd.isna(r[col]) else int(r[col]),
                        "p": float(m["p"].iloc[0]) if len(m) else None,
                        "p_base": float(m["p_base"].iloc[0]) if len(m) else None}
        rows.append(row)
    res["april2026"] = rows
    out = os.path.join(a.out, "results-l1.json")
    with open(out, "w") as f:
        json.dump(res, f, indent=1, sort_keys=True, default=float)
    summ = {c: {k: v[k] for k in ("nTest", "nPos", "nEpisodes", "bssVsBase", "bssCI", "R", "label")}
            for c, v in res["cells"].items()}
    print(json.dumps(summ, indent=1, default=float))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("phase", choices=["fit", "score"])
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--cash", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--frozen-sha256")
    a = ap.parse_args(argv)
    return phase_fit(a) if a.phase == "fit" else phase_score(a)


if __name__ == "__main__":
    sys.exit(main())
