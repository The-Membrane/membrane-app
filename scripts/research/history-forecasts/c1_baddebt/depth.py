"""DEX depth curves from Uniswap v3 pool state, and the R8.5 stress impairment.

A curve gives the shortfall S(q) (in units of the sold token, valued at the pre-trade mid) of selling q
tokens, aggregated over every pool of the pair by moving all pools to the same relative price drop (the
arbitrage-aligned split). With depth factor phi (impairment) the curve is S_phi(q) = phi * S(q / phi).
DECISION C1-D4: the curve is held in sold-token units and re-centred on the current price every hour.
"""
from __future__ import annotations

import math

import numpy as np

D_GRID = np.concatenate([[0.0], np.geomspace(1e-6, 0.6, 600)])


def _walk(st: dict, base: str, decimals: dict) -> tuple[np.ndarray, np.ndarray, float]:
    """Cumulative (base in before fee, quote out) at each relative price drop of the base in D_GRID,
    for one pool. Returns (base_in, quote_out, mid quote-per-base) in human units."""
    base = base.lower()
    t0, t1 = st["token0"].lower(), st["token1"].lower()
    if base not in (t0, t1):
        raise ValueError("base not in pool")
    sell1 = base == t1
    s0 = st["sqrtPriceX96"] / 2**96
    L = float(st["liquidity"])
    ticks = sorted((int(k), int(v)) for k, v in st["ticks"].items())
    dec0, dec1 = decimals[t0], decimals[t1]
    if sell1:   # base token1: s rises; base price (token0 per token1) = 1/s^2
        targets = s0 / np.sqrt(1.0 - D_GRID)
        bounds = [(1.0001 ** (t / 2), n) for t, n in ticks if t > st["tick"]]
    else:       # base token0: s falls; base price = s^2
        targets = s0 * np.sqrt(1.0 - D_GRID)
        bounds = [(1.0001 ** (t / 2), n) for t, n in reversed(ticks) if t <= st["tick"]]
    bin_, qout = np.zeros(len(D_GRID)), np.zeros(len(D_GRID))
    s, cum_in, cum_out = s0, 0.0, 0.0
    j = 0
    bi = 0

    def seg(sa, sb, L):
        if sell1:
            return L * (sb - sa), L * (1.0 / sa - 1.0 / sb)
        return L * (1.0 / sb - 1.0 / sa), L * (sa - sb)

    while j < len(targets):
        nxt = bounds[bi][0] if bi < len(bounds) else (math.inf if sell1 else 0.0)
        tg = targets[j]
        if (sell1 and tg <= nxt) or (not sell1 and tg >= nxt):
            di, do = seg(s, tg, max(L, 0.0))
            bin_[j], qout[j] = cum_in + di, cum_out + do
            j += 1
            continue
        di, do = seg(s, nxt, max(L, 0.0))
        cum_in += di
        cum_out += do
        s = nxt
        L = L + bounds[bi][1] if sell1 else L - bounds[bi][1]
        bi += 1
    if sell1:
        base_in, quote_out = bin_ / 10**dec1, qout / 10**dec0
        mid = (1.0 / s0**2) * 10**dec1 / 10**dec0
    else:
        base_in, quote_out = bin_ / 10**dec0, qout / 10**dec1
        mid = s0**2 * 10**dec0 / 10**dec1
    return base_in, quote_out, mid


class Curve:
    """Shortfall curve for selling `base` across a list of pool states."""

    def __init__(self, states: list[dict], base: str, decimals: dict):
        Q = np.zeros(len(D_GRID))
        OUT = np.zeros(len(D_GRID))
        mids, wts = [], []
        for st in states:
            bi, qo, mid = _walk(st, base, decimals)
            fee = st["fee"] / 1e6
            Q += bi / (1.0 - fee)
            OUT += qo
            mids.append(mid)
            wts.append(qo[-1])
        self.mid = float(np.average(mids, weights=np.maximum(wts, 1e-12)))
        Q = np.maximum.accumulate(Q)
        self.q = Q
        self.short = np.maximum(Q - OUT / self.mid, 0.0)
        self.short = np.maximum.accumulate(self.short)
        self.q_max = float(Q[-1])
        self.out_max = float(OUT[-1] / self.mid)

    def shortfall(self, q):
        """S(q) in base units; beyond the grid every extra unit is lost (no more output)."""
        q = np.asarray(q, float)
        inside = np.interp(np.minimum(q, self.q_max), self.q, self.short)
        return np.where(q > self.q_max, q - self.out_max, inside)

    def shortfall_phi(self, q, phi):
        return phi * self.shortfall(q / phi)

    def table(self, sizes) -> list[dict]:
        return [{"q": float(x), "shortfall_frac": float(self.shortfall(x) / x) if x > 0 else 0.0} for x in sizes]


def depth_factor(close_mult: np.ndarray, drop: float = 0.10, window: int = 24, impaired: float = 0.5,
                 recovery_h: int = 72) -> np.ndarray:
    """R8.5 impairment per path and hour: phi = 0.5 at an hour where the close is >= 10 % below the max
    close of the trailing 24 h (start included); after the last such hour phi recovers linearly to 1 over
    72 h. close_mult: (n_paths, H + 1) with column 0 = 1 (the anchor)."""
    n, H1 = close_mult.shape
    phi = np.ones((n, H1))
    last = np.full(n, -10**9)
    for t in range(H1):
        lo = max(0, t - window)
        mx = close_mult[:, lo:t + 1].max(axis=1)
        trig = close_mult[:, t] <= (1.0 - drop) * mx
        last = np.where(trig, t, last)
        since = t - last
        phi[:, t] = np.where(since <= 0, impaired, np.minimum(1.0, impaired + (1 - impaired) * since / recovery_h))
    return phi
