"""Joint ETH/BTC hourly price paths by the A6 (fH) recipe, with a shared calendar for reserve flows.

(fH) (membrane-board design/HISTORY_TOUCH_PREREG_A6.md A6.2): the scale is the log-HAR forecast of the realised
volatility over the horizon T, sigma_H(i) = exp([1, ln D_i, ln W_i, ln M_i] . c_T), with D, W, M the 24 h, 168 h
and 720 h mean Parkinson variances (a6_touch.har_components) and c_T the OLS fit of ln sigma_fut(i, T)
(a6_touch.sigma_fut) on origins whose window ended before t0. Filtered historical simulation: a path is one
historical T-hour window starting at a 00:00Z day j, every hourly log return (and the hour's low relative to the
previous close) multiplied by sigma_H(t0) / sigma_H(j). ETH and BTC use the same window, so their dependence is
the empirical one, and the same day j supplies the reserves' flow blocks (design 2.7, shared calendar).

Paths are scenarios, never outcomes (R11 rule 9). Touch odds shown to users come from the live A6 issue, not
from these paths; the path set's own touch frequencies are reported beside them as a consistency check only.
"""
from __future__ import annotations

import gzip
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import a6_touch as A6  # noqa: E402

HOUR, DAY = 3600, 86400


def load_bars(work: str, pair: str, t0: int) -> dict:
    with gzip.open(os.path.join(work, "prices", f"{pair}-{t0}.json.gz"), "rt") as f:
        d = json.load(f)
    ts = np.array(d["ts"], dtype=np.int64)
    o = np.array(d["ohlc"], float)
    start, step = int(ts[0]), int(d["step"])
    n = (t0 - start) // step
    grid = start + step * np.arange(n)
    idx = ((ts - start) // step).astype(int)
    keep = (idx >= 0) & (idx < n)
    high = np.full(n, np.nan)
    low = np.full(n, np.nan)
    close = np.full(n, np.nan)
    high[idx[keep]] = o[keep, 1]
    low[idx[keep]] = o[keep, 2]
    close[idx[keep]] = o[keep, 3]
    return {"ts": grid, "high": high, "low": low, "close": close}


def har_fit(bars: dict, T: int) -> dict:
    """OLS of ln sigma_fut(T) on [1, ln D, ln W, ln M] over every hourly origin with a complete window before t0;
    returns sigma_H at every origin i = 0..N (origin i = after bar i - 1 closes)."""
    C = A6.har_components(bars["high"], bars["low"], 0)          # (N + 1, 3)
    sf = A6.sigma_fut(bars["close"], T, 0)                        # (N + 1,)
    with np.errstate(invalid="ignore", divide="ignore"):
        L = np.log(C)
        y = np.log(sf)
    X = np.column_stack([np.ones(len(L)), L])
    ok = np.all(np.isfinite(X), axis=1) & np.isfinite(y)
    coef, *_ = np.linalg.lstsq(X[ok], y[ok], rcond=None)
    sig = np.full(len(L), np.nan)
    okX = np.all(np.isfinite(X), axis=1)
    sig[okX] = np.exp(X[okX] @ coef)
    return {"coef": coef.tolist(), "n_reg": int(ok.sum()), "sigma_H": sig}


def window(bars: dict, i: int, T: int):
    """log returns and log(low / previous close) for the T hours starting at origin i (bars i .. i + T - 1)."""
    c = bars["close"]
    prev = c[i - 1:i + T - 1]
    r = np.log(c[i:i + T] / prev)
    lo = np.log(np.minimum(bars["low"][i:i + T], np.minimum(prev, c[i:i + T])) / prev)
    return r, lo


def day_origins(bars: dict, first_day_ts: int, t0: int, T: int) -> np.ndarray:
    """Bar indices of 00:00Z origins j with first_day_ts <= j and j + T <= t0, complete data in the window."""
    ts = bars["ts"]
    out = []
    for i in np.where((ts % DAY == 0) & (ts >= first_day_ts) & (ts + T * HOUR <= t0))[0]:
        if i < 1:
            continue
        seg = bars["close"][i - 1:i + T]
        if np.isfinite(seg).all() and np.isfinite(bars["low"][i:i + T]).all():
            out.append(int(i))
    return np.array(out, dtype=int)


def make_paths(eth: dict, btc: dict, T: int, first_day_ts: int, t0: int, n_paths: int, rng,
               allowed_days: set | None = None) -> dict:
    """n_paths joint paths: close and low multipliers (n, T + 1) with column 0 = 1 (the t0 close)."""
    he, hb = har_fit(eth, T), har_fit(btc, T)
    if not (eth["ts"] == btc["ts"]).all():
        raise SystemExit("STOP: ETH and BTC hourly grids differ")
    N = len(eth["ts"])
    se_now, sb_now = he["sigma_H"][N], hb["sigma_H"][N]
    cand = day_origins(eth, first_day_ts, t0, T)
    cand = np.array([i for i in cand if np.isfinite(btc["close"][i - 1:i + T]).all()
                     and np.isfinite(btc["low"][i:i + T]).all()
                     and np.isfinite(he["sigma_H"][i]) and np.isfinite(hb["sigma_H"][i])
                     and (allowed_days is None or int(eth["ts"][i]) in allowed_days)], dtype=int)
    pick = rng.integers(0, len(cand), size=n_paths)
    J = cand[pick]
    out = {}
    for name, bars, h, s_now in (("eth", eth, he, se_now), ("btc", btc, hb, sb_now)):
        R = np.empty((len(cand), T))
        LO = np.empty((len(cand), T))
        for r, i in enumerate(cand):
            k = s_now / h["sigma_H"][i]
            rr, lo = window(bars, i, T)
            R[r], LO[r] = rr * k, lo * k
        cum = np.concatenate([np.zeros((len(cand), 1)), np.cumsum(R, axis=1)], axis=1)
        close = np.exp(cum)
        low = np.concatenate([np.ones((len(cand), 1)), close[:, :-1] * np.exp(LO)], axis=1)
        low = np.minimum(low, np.minimum(close, np.concatenate([close[:, :1], close[:, :-1]], axis=1)))
        out[name] = {"close": close[pick], "low": low[pick], "sigma_now": float(s_now), "har_coef": h["coef"],
                     "n_reg": h["n_reg"]}
    out["day_ts"] = eth["ts"][J].astype(np.int64)
    out["n_windows"] = int(len(cand))
    out["T"] = T
    return out


def oracle_path(close: np.ndarray, low: np.ndarray, dev: float, heartbeat_s: int) -> np.ndarray:
    """Oracle multipliers at 2 sub-steps per hour (the hour's low, then its close), (n, 2T): a push feed updates
    when the price moves by >= dev from its last answer, or when the heartbeat has elapsed (checked at closes)."""
    n, T1 = close.shape
    T = T1 - 1
    last = np.ones(n)
    age = np.zeros(n)
    out = np.empty((n, 2 * T))
    for h in range(1, T + 1):
        for s, p in enumerate((low[:, h], close[:, h])):
            upd = np.abs(p / last - 1.0) >= dev
            if s == 1:
                age += HOUR
                upd |= age >= heartbeat_s
            last = np.where(upd, p, last)
            age = np.where(upd, 0.0, age)
            out[:, 2 * (h - 1) + s] = last
    return out
