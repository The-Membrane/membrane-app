"""Reserve history for the shared-calendar flow blocks and the 24 h cash model (development data, grade C).

Core USDC: aave-pool-cash transfer streams (exact cash path) and the corrected W24 daily anchors
(history-forecasts/r9/run-dfdd3ad8), extended to t0 by sim1.acquire cashext. Arbitrum native USDC: the C1
streams and daily state (aave-pool-cash-c1, scored once by R11.11, grade C), extended the same way.

Hourly flow block for a historical day j (00:00Z) and hour k:
  f_cash[k] = (cash(j + k + 1 h) - cash(j + k h) - liquidation repay in hour k) / S_j     (double-count guard)
  dip[k]    = (min cash inside hour k - cash at its start) / S_j                          (<= 0)
  g_debt[d] = (D_{d+1} + liquidation repay of day d - D_d) / D_d, spread evenly over the day's 24 hours
with S_j the aToken supply at the day's anchor and D = S - C. The guard needs the historical USDC-debt
LiquidationCall repayments: Core only. Arbitrum's are the unscored L1 target and are not read, so Arbitrum flow
blocks keep their own liquidation repayments (disclosed).
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import r104_cash as R4  # noqa: E402
import r1111_cash as R11  # noqa: E402

DAY, HOUR = 86400, 3600
MICRO = 10 ** 6


def _jload(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)


def _ext_deltas(ext):
    rows = [(r["block"], r["ts"], r["tx_index"], int(r["amount_raw"])) for r in ext["in"]] + \
           [(r["block"], r["ts"], r["tx_index"], -int(r["amount_raw"])) for r in ext["out"]]
    if not rows:
        return pd.DataFrame({"block": [], "ts": [], "d": []})
    df = pd.DataFrame(rows, columns=["block", "ts", "tx_index", "d"])
    df["key"] = df["block"].astype(np.int64) * 100_000 + df["tx_index"].astype(np.int64)
    g = df.groupby("key", sort=True)
    return pd.DataFrame({"block": g["block"].first().values, "ts": g["ts"].first().values,
                         "d": g["d"].sum().values.astype(np.int64)})


def load_market(datasets: str, work: str, market: str, t0: int) -> dict:
    """Exact per-transaction cash path to t0 and daily anchors (supply, cash) for every day to t0."""
    ext = _jload(os.path.join(work, market, f"cashext-{t0}.json.gz"))
    if market == "core":
        tl = R4.load_cash_path(os.path.join(datasets, "aave-pool-cash"))
        if int(tl["block"].max()) > ext["from_block"] - 1:
            raise SystemExit("STOP: committed Core stream overlaps the extension")
        cts, cval = tl["ts"].to_numpy(np.int64), tl["cash"].to_numpy(np.int64)
        w = pd.read_csv(os.path.join(datasets, R4.W24))
        days = list(w["origin"])
        S = list(w["snap_supply"].to_numpy(float) * MICRO)
        Cs = list(np.round(w["snap_cash"].to_numpy(float) * MICRO))
    else:
        d = os.path.join(datasets, R11.C1_DIR)
        tin = pd.read_csv(os.path.join(d, R11.C1_FILES[0]), dtype={"amount_raw": str})
        tout = pd.read_csv(os.path.join(d, R11.C1_FILES[1]), dtype={"amount_raw": str})
        tl = R11.cash_path_exact(tin, tout)
        cts, cval = tl["ts"].to_numpy(np.int64), tl["cash"].to_numpy(np.int64)
        ds = pd.read_csv(os.path.join(d, R11.C1_FILES[2]), dtype=str).sort_values("day")
        days = list(ds["day"])
        S = [float(int(x)) for x in ds["atoken_total_supply"]]
        Cs = [float(int(x)) for x in ds["cash_balance"]]
    ed = _ext_deltas(ext)
    if len(ed):
        cts = np.concatenate([cts, ed["ts"].to_numpy(np.int64)])
        cval = np.concatenate([cval, cval[-1] + np.cumsum(ed["d"].to_numpy(np.int64))])
    for r in ext["daily"]:
        if r["day"] in days:
            continue
        days.append(r["day"])
        S.append(float(int(r["atoken_total_supply"])))
        Cs.append(float(int(r["cash_balance"])))
    t = np.array([R4.day_ts(x) for x in days], dtype=np.int64)
    if not (np.diff(t) == DAY).all():
        raise SystemExit(f"STOP: {market} daily anchors not consecutive")
    if t[-1] != t0:
        raise SystemExit(f"STOP: {market} daily anchors end {days[-1]}, t0 {t0}")
    S = np.array(S, float)
    C_snap = np.array(Cs, float)
    cash_anchor = np.array([R4.state_at(cts, cval, int(x) - 1) for x in t], dtype=float)
    g1 = int(np.sum(np.abs(cash_anchor - C_snap) > 1))
    cash_t0 = np.array([R4.state_at(cts, cval, int(x)) for x in t], dtype=float)
    dmin = np.full(len(t), np.nan)
    for i, x in enumerate(t):
        if x + DAY <= t0:
            dmin[i] = R4.window_min(cts, cval, int(cash_t0[i]), int(x), int(x) + DAY)
    return {"market": market, "days": days, "t": t, "S_snap": S, "C_end": cash_anchor, "C_snap": C_snap,
            "g1_mismatches": g1, "cash_t0": cash_t0, "dmin": dmin, "cts": cts, "cval": cval}


def liq_repay_hourly(work: str, t0: int, hour_ts: np.ndarray, block_ts_fn=None) -> np.ndarray:
    """Core USDC-debt LiquidationCall repayment (USDC micro units) per hour bucket of hour_ts."""
    lh = _jload(os.path.join(work, "core", f"liqhist-{t0}.json.gz"))
    rows = lh["rows"]
    if any("ts" not in r for r in rows):
        # C1 rows carry blocks only: map block -> ts through the cash path's own (block, ts) pairs
        if block_ts_fn is None:
            raise SystemExit("STOP: liquidation rows without ts need a block->ts map")
    out = np.zeros(len(hour_ts))
    for r in rows:
        ts = r.get("ts") or block_ts_fn(r["block"])
        k = int(np.searchsorted(hour_ts, ts, side="right")) - 1
        if 0 <= k < len(hour_ts):
            out[k] += r["debtToCover"]
    return out


def core_block_ts(datasets: str):
    """block -> ts from the Core cash streams (every block with a USDC transfer to/from aUSDC), by interpolation."""
    tl = R4.load_cash_path(os.path.join(datasets, "aave-pool-cash"))
    b = tl["block"].to_numpy(np.int64)
    ts = tl["ts"].to_numpy(np.int64)

    def f(block):
        return int(np.interp(block, b, ts))
    return f


def hourly_blocks(M: dict, t_first: int, t_last: int, liq_hourly: np.ndarray | None = None) -> dict:
    """Hourly cash at hour starts, intra-hour minima and liquidation repay for hours [t_first, t_last)."""
    hs = np.arange(t_first, t_last + 1, HOUR, dtype=np.int64)
    cts, cval = M["cts"], M["cval"]
    k = np.searchsorted(cts, hs, side="right") - 1
    c_at = np.where(k >= 0, cval[np.maximum(k, 0)], 0).astype(float)
    nh = len(hs) - 1
    mins = c_at[:-1].copy()
    i0 = np.searchsorted(cts, hs[:-1], side="right")
    i1 = np.searchsorted(cts, hs[1:], side="right")
    for h in range(nh):
        if i1[h] > i0[h]:
            mins[h] = min(mins[h], float(cval[i0[h]:i1[h]].min()))
    lq = np.zeros(nh) if liq_hourly is None else liq_hourly[:nh]
    return {"hours": hs[:-1], "cash_start": c_at[:-1], "cash_end": c_at[1:], "cash_min": mins, "liq": lq}


def flow_blocks(M: dict, HB: dict, days_idx: np.ndarray, H: int) -> dict:
    """Flow blocks (n_days, H) for the historical days in days_idx (indices into M['t'])."""
    t = M["t"]
    S, C = M["S_snap"], M["C_end"]
    D = S - C
    n = len(days_idx)
    fc = np.zeros((n, H))
    dip = np.zeros((n, H))
    gd = np.zeros((n, H))
    h0 = HB["hours"][0]
    day_liq = {}
    for r, i in enumerate(days_idx):
        a = int((t[i] - h0) // HOUR)
        sl = slice(a, a + H)
        Sj = S[i]
        fc[r] = (HB["cash_end"][sl] - HB["cash_start"][sl] - HB["liq"][sl]) / Sj
        dip[r] = (HB["cash_min"][sl] - HB["cash_start"][sl]) / Sj
        for dd in range(H // 24):
            j = i + dd
            if j not in day_liq:
                aa = int((t[j] - h0) // HOUR)
                day_liq[j] = HB["liq"][aa:aa + 24].sum()
            g = (D[j + 1] + day_liq[j] - D[j]) / D[j]
            gd[r, dd * 24:(dd + 1) * 24] = (1.0 + g) ** (1.0 / 24) - 1.0
    return {"f_cash": fc, "dip": np.minimum(dip, 0.0), "g_debt": gd}
