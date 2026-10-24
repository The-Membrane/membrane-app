"""Q26 D13 input III: the 1 h geometric-mean TWAP of Binance 1 m closes, computed one way for development and live.

membrane-board design/HISTORY_TOUCH_LIVE.md D13 (owner approval 2026-10-24 "Deploy D13"); design/Q26_ROUND19_PREREG.md
R19.5b input III and D-R19.5-review (e): the TWAP is a windowed sum over each 60-minute window, so the development grid
and the live bars are bit-identical (no cumulative-sum differencing).

  G(m) = exp( fsum(ln close of the present slots m-59 .. m) / n ),  n = present slots in the window, n >= 50, else null.

Slot m is the 1 m kline opening at t0 + 60 m (it closes at t0 + 60 (m + 1)); G(m) is the TWAP at that close.
math.fsum returns the correctly rounded sum of the window, independent of summation order, and math.log / math.exp are
the platform libm (glibc on the runner and here). Prices are parsed from the API strings with float().

Hour bar of the hour opening at t0 + 3600 j (slots 60 j .. 60 j + 59, i.e. minutes that close inside the hour):
  close = G at the hour end (slot 60 j + 59); low / high = min / max of G over the 60 slots, null if any G is null.
Every bar value is rounded to 10 significant digits (round10), the format of the development grid files.
No key, address or secret is used here.
"""
from __future__ import annotations

import math

W = 60          # minutes per TWAP window (LtvDisco.ROUTE_TWAP_SECS = 3600)
MIN_PRESENT = 50
STEP = 3600


def round10(v):
    """The grid storage rounding (r195_inputs.write_grid): 10 significant digits."""
    return float(f"{v:.10g}")


def ln_closes(closes):
    """closes: list of float or None per minute slot -> list of ln close or None."""
    return [None if (c is None or not (c > 0) or c != c) else math.log(c) for c in closes]


def minute_G(lc):
    """lc: list of ln close or None per minute slot. -> list of G (float) or None, same length."""
    n = len(lc)
    out = [None] * n
    cnt = 0
    for m in range(n):
        if lc[m] is not None:
            cnt += 1
        if m >= W and lc[m - W] is not None:
            cnt -= 1
        if m < W - 1 or cnt < MIN_PRESENT:
            continue
        win = lc[m - W + 1:m + 1]
        if cnt == W:
            s = math.fsum(win)
        else:
            s = math.fsum([x for x in win if x is not None])
        out[m] = math.exp(s / cnt)
    return out


def hour_bars(G, j0=0, j1=None):
    """G: minute TWAPs from an hour boundary t0. -> (low, high, close) lists per hour j0 .. j1-1 (None = null),
    each value round10. low/high are null if any minute G of the hour is null; close needs only the last minute."""
    nh = len(G) // W
    j1 = nh if j1 is None else min(j1, nh)
    lo, hi, cl = [], [], []
    for j in range(j0, j1):
        g = G[j * W:(j + 1) * W]
        last = g[-1]
        cl.append(None if last is None else round10(last))
        if any(x is None for x in g):
            lo.append(None)
            hi.append(None)
        else:
            lo.append(round10(min(g)))
            hi.append(round10(max(g)))
    return lo, hi, cl


def bars_from_closes(closes, j0=0, j1=None):
    """closes per minute slot from an hour boundary (float or None) -> hour bars (low, high, close)."""
    return hour_bars(minute_G(ln_closes(closes)), j0, j1)
