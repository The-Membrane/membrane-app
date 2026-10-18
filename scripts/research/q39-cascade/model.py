"""Q39 labels, splits, models and scores (prereg C.4, C.5, C.7).

Labels follow scripts/position/build-touch-history.mjs (t1 rule) on the frozen oracle-hour series
(membrane-datasets price-history/{eth,btc}-usd-1h.json, sha256 pinned in HISTORY_TOUCH_PREREG A.1):
  origin t = UTC day 00:00; S = oracle close of the hour opening t - 1h;
  y(d, T) = 1 iff min(oracleLow over hours opening in [t, t + T*86400 - 3600]) <= S * (1 - d).
Any null in the window or a null S drops the row.
"""
from __future__ import annotations

import json
import math
import os

import numpy as np

DAY = 86400
H = 3600
LEVELS = (0.05, 0.10, 0.15, 0.20, 0.30)
HORIZONS = (1, 7, 30)
STRESS = {"E1": "2020-03-12", "E2": "2021-05-19", "E3": "2022-06-13", "E4": "2024-08-05", "E5": "2025-10-10"}
DEV = (1672531200, 1751241600)      # 2023-01-01 .. 2025-06-30 (origins)
TEST_START = 1751328000             # 2025-07-01
DATA_END = 1791255600               # 2026-10-06T03:00Z
PRICE_SHA = {"eth": "48b53d72351dbba6b05939a75660babc361678304747bf764d59e97d968bd26c",
             "btc": "07ba823671e557a7a73415903f8c4be153c1bb6f0ca1215361eb2304a6bd5d37"}


def ts_of(date: str) -> int:
    import calendar
    y, m, d = map(int, date.split("-"))
    return calendar.timegm((y, m, d, 0, 0, 0))


def load_series(datasets: str, asset: str):
    import hashlib
    p = os.path.join(datasets, "price-history", f"{asset}-usd-1h.json")
    sha = hashlib.sha256(open(p, "rb").read()).hexdigest()
    if sha != PRICE_SHA[asset]:
        raise SystemExit(f"price-history {asset} sha256 {sha} != pinned {PRICE_SHA[asset]}")
    d = json.load(open(p))
    col = d["columns"]
    close = np.array([np.nan if x is None else x for x in col["oracle"]], float)
    low = np.array([np.nan if x is None else x for x in col["oracleLow"]], float)
    return d["startTs"], close, low


def stress_purged(t: int, T: int) -> bool:
    """C.4: origins in [E - 30 d, E + 1 d], or whose label window [t, t + T] touches [E, E + 1 d]."""
    for e in STRESS.values():
        E = ts_of(e)
        if E - 30 * DAY <= t <= E + DAY:
            return True
        if t <= E + DAY and t + T * DAY >= E:
            return True
    return False


def labels(start, close, low, origins, levels=LEVELS, horizons=HORIZONS):
    """{(t, d, T): y} plus spot S(t) and sigma_daily(t) (RV30 of hourly oracle log returns, daily-scaled)."""
    out, S, sig = {}, {}, {}
    lr = np.diff(np.log(close))
    for t in origins:
        i = (t - start) // H        # hour opening at t
        if i - 1 < 0 or i + 1 >= len(close):
            continue
        s = close[i - 1]
        if not np.isfinite(s):
            continue
        S[t] = s
        r = lr[max(0, i - 1 - 720): i - 1]
        sig[t] = float(np.sqrt(24.0 * np.mean(r[np.isfinite(r)] ** 2))) if np.isfinite(r).sum() > 600 else np.nan
        for T in horizons:
            j = i + T * 24
            if t + T * DAY > DATA_END or j > len(low):
                continue
            w = low[i:j]
            if not np.all(np.isfinite(w)):
                continue
            m = w.min()
            for d in levels:
                out[(t, d, T)] = int(m <= s * (1.0 - d))
    return out, S, sig


def origins_in(a: int, b: int) -> list[int]:
    return list(range(a, b + 1, DAY))


def plain_touch(lab: dict, dev_origins: list[int], levels=LEVELS, horizons=HORIZONS) -> dict:
    """p0(d, T) from development origins (stress-purged). Clipped to [0.5/n, 1 - 0.5/n] (decision D-Q39-5)."""
    p0 = {}
    for T in horizons:
        for d in levels:
            ys = [lab[(t, d, T)] for t in dev_origins if (t, d, T) in lab and not stress_purged(t, T)]
            n = len(ys)
            k = sum(ys)
            p = k / n if n else float("nan")
            p0[(d, T)] = {"p": min(max(p, 0.5 / n), 1 - 0.5 / n) if n else float("nan"), "k": k, "n": n}
    return p0


def logit(p):
    return math.log(p / (1 - p))


def fit_beta(rows) -> float:
    """One parameter beta with offset: logit p = off + beta x (no intercept). Newton on the log-likelihood."""
    off = np.array([r[0] for r in rows])
    x = np.array([r[1] for r in rows])
    y = np.array([r[2] for r in rows])
    if not np.any(x != 0):
        return 0.0
    b = 0.0
    for _ in range(100):
        p = 1 / (1 + np.exp(-(off + b * x)))
        g = np.sum((y - p) * x)
        h = -np.sum(p * (1 - p) * x * x)
        if h == 0:
            break
        step = g / h
        b -= step
        if abs(step) < 1e-10:
            break
    return float(b)


def brier(p, y):
    p, y = np.asarray(p), np.asarray(y)
    return float(np.mean((p - y) ** 2))


def ece(p, y, bins=10):
    p, y = np.asarray(p), np.asarray(y)
    e = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for a, b in zip(edges[:-1], edges[1:]):
        m = (p >= a) & ((p < b) if b < 1 else (p <= b))
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(e)


def block_bootstrap_bss(days, pc, pb, y, block, reps=2000, seed=20261018):
    """BSS = 1 - B_cand/B_base with a moving block bootstrap over test days (each day carries all its rows)."""
    rng = np.random.default_rng(seed)
    ud = sorted(set(days))
    di = {d: i for i, d in enumerate(ud)}
    N = len(ud)
    rows_by_day = [[] for _ in ud]
    for k, d in enumerate(days):
        rows_by_day[di[d]].append(k)
    pc, pb, y = map(np.asarray, (pc, pb, y))
    sc = np.array([np.sum((pc[r] - y[r]) ** 2) for r in rows_by_day])
    sb = np.array([np.sum((pb[r] - y[r]) ** 2) for r in rows_by_day])
    est = 1 - sc.sum() / sb.sum()
    b = min(block, N)
    nb = math.ceil(N / b)
    out = np.empty(reps)
    for i in range(reps):
        starts = rng.integers(0, N - b + 1, nb)
        idx = np.concatenate([np.arange(s, s + b) for s in starts])[:N]
        out[i] = 1 - sc[idx].sum() / max(sb[idx].sum(), 1e-18)
    return float(est), out
