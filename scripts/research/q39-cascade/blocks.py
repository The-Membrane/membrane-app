"""Daily snapshot blocks: for each UTC day 00:00, the last block with timestamp <= 00:00 (prereg C.2.1)."""
from __future__ import annotations

import json
import os

from rpc import Client

DAY = 86400


def last_block_at_or_before(c: Client, ts: int, lo: int, hi: int, cache: dict) -> int:
    def t(n):
        if n not in cache:
            cache[n] = c.block_ts(n)
        return cache[n]
    # interpolation search then bisection; invariant t(lo) <= ts < t(hi)
    while hi - lo > 1:
        tl, th = t(lo), t(hi)
        if th == tl:
            mid = (lo + hi) // 2
        else:
            mid = lo + int((ts - tl) * (hi - lo) / (th - tl))
            mid = min(max(mid, lo + 1), hi - 1)
            # guard against slow convergence: alternate with bisection
            if hi - lo > 64 and (mid - lo < (hi - lo) // 64 or hi - mid < (hi - lo) // 64):
                mid = (lo + hi) // 2
        if t(mid) <= ts:
            lo = mid
        else:
            hi = mid
    return lo


def _local(c, ts, lo, head, cache, guess=None):
    """Bracket locally from the previous day's block (guess = the previous day's block count), then search."""
    def t(n):
        if n not in cache:
            cache[n] = c.block_ts(n)
        return cache[n]
    if lo <= 1 or t(lo) > ts:
        return last_block_at_or_before(c, ts, max(lo, 1), head, cache)
    if guess:
        g = lo + guess
        if g < head and t(g) <= ts:
            lo = g
            step = max(64, guess // 50)
        else:
            lo2 = max(lo, g - max(64, guess // 50))
            if t(lo2) <= ts:
                return last_block_at_or_before(c, ts, lo2, min(g, head), cache)
            step = max(64, guess // 50)
    else:
        step = max(64, int((ts - t(lo)) / 2) + 1)
    hi = lo + step
    while hi < head and t(hi) <= ts:
        lo, step = hi, step * 2
        hi = min(head, lo + step)
    return last_block_at_or_before(c, ts, lo, hi, cache)


def day_blocks(c: Client, start_ts: int, end_ts: int, path: str) -> dict[int, int]:
    """{day_ts: block}. Cached in a JSON file per chain; resumable."""
    out = {}
    if os.path.exists(path):
        out = {int(k): v for k, v in json.load(open(path)).items()}
    head = c.block_number()
    cache: dict[int, int] = {}
    lo_known, prev = 1, None
    for ts in range(start_ts, end_ts + 1, DAY):
        if ts in out:
            prev = out[ts] - lo_known if lo_known > 1 else None
            lo_known = out[ts]
            continue
        b = _local(c, ts, lo_known, head, cache, prev)
        prev = b - lo_known if lo_known > 1 else None
        out[ts] = b
        lo_known = b
        if len(out) % 50 == 0:
            json.dump(out, open(path, "w"))
    json.dump(out, open(path, "w"))
    return out
