"""ETH hourly paths: 7-day block bootstrap of hourly returns, reweighted to A6 7-day touch probabilities.

Source: membrane-datasets price-history/eth-usd-1h.json (primary segments: coinbase, then Chainlink
oracle grade), extended after its last hour with the q26-touch-live Chainlink round store (close = answer
in force at the hour end; low = min of the answer in force at the hour start and every round in the hour).
With 7-day blocks and horizons <= 7 days a path is one contiguous historical 168-hour block, relative to its
start close (DECISION C1-D2). Only blocks that end at or before the anchor hour are drawn.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import os

import numpy as np

H7 = 168


def load_eth_hourly(datasets: str, until_ts: int | None = None) -> dict:
    d = json.load(open(os.path.join(datasets, "price-history/eth-usd-1h.json")))
    n, t0, step = d["count"], d["startTs"], d["stepSeconds"]
    close = np.full(n, np.nan)
    low = np.full(n, np.nan)
    for seg in d["primary"]["segments"]:
        a, b, src = seg["fromIndex"], seg["toIndex"], seg["source"]
        c = d["columns"][src]
        lw = d["columns"][src + "Low"]
        for i in range(a, b + 1):
            if c[i] is not None:
                close[i] = c[i]
            if lw[i] is not None:
                low[i] = lw[i]
    ts = t0 + step * np.arange(n)
    ext = _rounds_hours(datasets, int(ts[-1]))
    if ext is not None:
        ts = np.concatenate([ts, ext[0]])
        close = np.concatenate([close, ext[1]])
        low = np.concatenate([low, ext[2]])
    # forward-fill closes, low falls back to close, and never above it
    for i in range(1, len(close)):
        if not np.isfinite(close[i]):
            close[i] = close[i - 1]
    low = np.where(np.isfinite(low), low, close)
    low = np.minimum(low, close)
    if until_ts is not None:
        keep = ts <= until_ts
        ts, close, low = ts[keep], close[keep], low[keep]
    return {"ts": ts.astype(np.int64), "close": close, "low": low}


def _rounds_hours(datasets: str, last_ts: int):
    p = os.path.join(datasets, "forecasts/q26-touch-live/rounds/eth-usd.csv.gz")
    if not os.path.exists(p):
        return None
    raw = gzip.open(p, "rb").read().decode()
    rows = []
    for line in raw.splitlines():
        if not line or line.startswith("roundId"):
            continue
        r = line.split(",")
        rows.append((int(r[2]), int(r[1]) / 1e8))
    rows.sort()
    if not rows:
        return None
    ut = np.array([r[0] for r in rows])
    ans = np.array([r[1] for r in rows])
    hours = np.arange(last_ts + 3600, (ut[-1] // 3600) * 3600 + 1, 3600)
    ts_o, c_o, l_o = [], [], []
    for h in hours:   # hour labelled by its open (as price-history): close at h + 3600
        start, end = h, h + 3600
        i0 = np.searchsorted(ut, start, side="right") - 1
        i1 = np.searchsorted(ut, end, side="right") - 1
        if i0 < 0 or ut[-1] < end:
            continue
        seg = ans[i0:i1 + 1]
        ts_o.append(h)
        c_o.append(ans[i1])
        l_o.append(seg.min())
    if not ts_o:
        return None
    return np.array(ts_o), np.array(c_o), np.array(l_o)


def bootstrap(close: np.ndarray, low: np.ndarray, n_paths: int, rng, H: int = H7) -> dict:
    """Draw n_paths start hours uniformly from blocks [s, s + H] inside the series. Returns close and low
    multipliers (n_paths, H + 1) relative to the start close; column 0 = 1."""
    starts = rng.integers(0, len(close) - H, size=n_paths)
    idx = starts[:, None] + np.arange(H + 1)[None, :]
    base = close[starts][:, None]
    mc = close[idx] / base
    ml = low[idx] / base
    ml[:, 0] = 1.0
    return {"starts": starts, "close": mc, "low": ml}


def touch_min(low_mult: np.ndarray, H: int) -> np.ndarray:
    return low_mult[:, 1:H + 1].min(axis=1)


def reweight(path_min: np.ndarray, levels: list[float], targets: list[float]) -> tuple[np.ndarray, dict]:
    """Weights (sum 1) so the weighted P(path min <= 1 + k) equals the target at every level k (nested
    bins between consecutive levels). A bin with target mass but no path passes its mass to the next
    shallower bin that has paths (DECISION C1-D3, reported)."""
    order = np.argsort(levels)[::-1]           # -0.02, -0.03, ..., -0.40
    lv = [levels[i] for i in order]
    tg = [targets[i] for i in order]
    for i in range(1, len(tg)):                # monotone (the issue is already monotone-fixed)
        tg[i] = min(tg[i], tg[i - 1])
    edges = [1.0 + k for k in lv]
    nb = len(edges) + 1
    b = np.zeros(len(path_min), int)
    for i, e in enumerate(edges):
        b = np.where(path_min <= e, i + 1, b)
    mass = [1.0 - tg[0]] + [tg[i] - tg[i + 1] for i in range(len(tg) - 1)] + [tg[-1]]
    counts = np.bincount(b, minlength=nb)
    moved = []
    for i in range(nb - 1, 0, -1):
        if counts[i] == 0 and mass[i] > 0:
            moved.append({"bin": i, "mass": mass[i]})
            mass[i - 1] += mass[i]
            mass[i] = 0.0
    w = np.zeros(len(path_min))
    for i in range(nb):
        if counts[i]:
            w[b == i] = mass[i] / counts[i]
    w /= w.sum()
    raw = [float((path_min <= e).mean()) for e in edges]
    got = [float(w[path_min <= e].sum()) for e in edges]
    ess = float(1.0 / np.sum(w**2))
    return w, {"levels": lv, "targets": tg, "raw_touch": raw, "weighted_touch": got, "bin_counts": counts.tolist(),
               "moved_mass": moved, "ess": ess}


def wquantile(x: np.ndarray, w: np.ndarray, q: float) -> float:
    o = np.argsort(x)
    cw = np.cumsum(w[o])
    cw /= cw[-1]
    return float(x[o][np.searchsorted(cw, q, side="left").clip(0, len(x) - 1)])
