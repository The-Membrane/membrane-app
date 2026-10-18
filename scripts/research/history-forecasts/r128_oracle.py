"""Q26 R12.8: the TWAP "already through" alert on ETH, with Membrane's exact oracle construction.

membrane-board design/Q26_ROUND12_PREREG.md, Deviation D-R12.8a (registered; NOT RUN: the primary cells are
underpowered at the development effect). Parent findings: D-R12.6e, D-R12.7a-e. Owner ruling 10.

Membrane's oracle (membrane-solidity 70f965e4, contracts/Oracle.sol + contracts/lib/V3PoolSelector.sol +
contracts/LtvDisco.sol), as built here:
  * Route mode. Up to 5 Uniswap V3 routes per asset (the LtvDisco vote-ranked top 5, filtered by a route-health gate),
    one TWAP window for the whole set: LtvDisco.ROUTE_TWAP_SECS = Oracle.MIN_TWAP_SECS = 3600 s.
  * Route price = product over hops of the hop TWAP. A hop TWAP is pool.observe([3600, 0]): mean tick =
    floor((tickCum_now - tickCum_3600s_ago) / 3600), price = 1.0001 ** meanTick. This is a per-second time-weighted
    GEOMETRIC mean of the pool tick (block-level steps), not an arithmetic mean of 1 m closes.
  * Each route price is multiplied by its terminal quote's own exogenous oracle price (USDC, USDT, DAI -> USD).
  * Routes with a broken TWAP or below the quote's minimum USD liquidity floor are dropped.
  * Oracle price = median of the surviving route prices (odd n: middle; even n: mean of the two middle values).
  * getPrice serves the median only if it is within maxDeviationPct (deploy default 5%) of lastGoodMedian, an anchor
    that the permissionless commitMedianPrice moves at most once per 3600 s and by at most maxDeviationPct per step.
    Otherwise it falls through to the legacy single-pool UV3 TWAP / operator fallback (staleness 600 s).
  * getPrice is a view: the price at time t is computed at read time (no heartbeat).

Subcommands
  verify  --rpc URL                    check the swap-log TWAP reconstruction against pool.observe([3600, 0]) at one
                                       recent block (October 2026, outside every reserved window); prints ticks only
  power   --binance DIR --out OUT      counts-only power from SEEN Binance ETH/BTC hours (alert flags only; no
                                       outcome is computed), at the development effect of D-R12.7b
  acquire / build / counts / freeze / run
          registered in D-R12.8a and NOT IMPLEMENTED: R12.8 does not run (power). A revised registration must add
          them before any B16 byte is read.

No wallet address, key or secret is read or written. Pool contract identifiers are public Uniswap V3 pools.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND12_PREREG.md", "item": "R12.8",
          "deviation": "D-R12.8a"}
ORACLE_SRC = {"repo": "triccs/membrane-solidity", "sha": "70f965e4092a29b0959c4ceec0370ca032484f83",
              "files": ["contracts/Oracle.sol", "contracts/lib/V3PoolSelector.sol", "contracts/LtvDisco.sol",
                        "script/DeployFullSystem.s.sol"]}
ROUTE_TWAP_SECS = 3600
MAX_DEVIATION = 0.05          # ORACLE_MAX_DEVIATION_PCT = 5e16 (deploy default)
ANCHOR_UPDATE_INTERVAL = 3600
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"

# B16a routes (Ethereum mainnet, single-hop WETH -> stable). Fixed in D-R12.8a. Identity checked by token0/token1/fee.
B16A_ROUTES = [
    {"name": "WETH/USDC 0.05%", "pool": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "asset_is_token0": False,
     "dec0": 6, "dec1": 18, "quote": "USDC"},
    {"name": "WETH/USDC 0.30%", "pool": "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", "asset_is_token0": False,
     "dec0": 6, "dec1": 18, "quote": "USDC"},
    {"name": "WETH/USDT 0.05%", "pool": "0x11b815efb8f581194ae79006d24e0d814b7697f6", "asset_is_token0": True,
     "dec0": 18, "dec1": 6, "quote": "USDT"},
    {"name": "WETH/USDT 0.30%", "pool": "0x4e68ccd3e89f51c3074ca5072bbac773960dfa36", "asset_is_token0": True,
     "dec0": 18, "dec1": 6, "quote": "USDT"},
    {"name": "DAI/WETH 0.05%", "pool": "0x60594a405d53811d3bc4766596efd80fd545a270", "asset_is_token0": False,
     "dec0": 18, "dec1": 18, "quote": "DAI"},
]

LEVELS_PRIMARY = (-0.02, -0.03, -0.05)
LEVELS_REPORTED = (-0.07, -0.10)
HORIZONS_H = (1, 3, 6)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc(s):
    return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp())


# ---------------------------------------------------------------------------------------------------------------
# Oracle construction (pure functions; the parts a run would use)
# ---------------------------------------------------------------------------------------------------------------

def mean_tick_floor(delta: int, secs: int) -> int:
    """V3PoolSelector._hopTwapLiq: Solidity truncation toward zero, then -1 for a negative inexact quotient."""
    q = int(delta / secs) if delta >= 0 else -((-delta) // secs)
    if delta < 0 and delta % secs != 0:
        q -= 1
    return q


def tick_to_asset_usd(tick: int, asset_is_token0: bool, dec0: int, dec1: int, quote_usd: float = 1.0) -> float:
    """Price of the asset in its quote (then USD), from a pool tick (token1 per token0 = 1.0001**tick, raw units)."""
    p10 = 1.0001 ** tick * 10.0 ** (dec0 - dec1)        # token1 per token0, human units
    px = p10 if asset_is_token0 else 1.0 / p10
    return px * quote_usd


def tick_cumulative(block_ts: np.ndarray, block_tick: np.ndarray, t0_tick: int, t_start: int, t: np.ndarray):
    """Tick cumulative at times t (relative to t_start), from the per-block last swap tick.

    A swap in a block at timestamp b sets the tick from b onward (Uniswap writes the previous tick into the oracle at the
    first swap of a block, so the post-block tick is held from b until the next block with a swap). t0_tick is the
    tick in force at t_start."""
    ts = np.concatenate([[t_start], block_ts]).astype(np.int64)
    tk = np.concatenate([[t0_tick], block_tick]).astype(np.int64)
    seg = np.diff(ts) * tk[:-1]
    cum = np.concatenate([[0], np.cumsum(seg)])
    i = np.searchsorted(ts, t, side="right") - 1
    return cum[i] + (t - ts[i]) * tk[i]


def median_solidity(prices):
    """Oracle._medianOf: odd n -> middle; even n -> mean of the two middle values."""
    v = sorted(p for p in prices if p and p > 0)
    n = len(v)
    if n == 0:
        return float("nan")
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])


def anchor_gate(median_path: np.ndarray, ts: np.ndarray, max_dev=MAX_DEVIATION, interval=ANCHOR_UPDATE_INTERVAL):
    """Served-price flag under Oracle.getPrice, assuming a keeper calls commitMedianPrice whenever allowed.

    Returns (anchor, served) where served[i] is True when |median/anchor - 1| <= max_dev (median path is served);
    False minutes fall through to the legacy single-pool tier (modelled as the deepest route's own 1 h TWAP)."""
    anchor = np.full(len(ts), np.nan)
    a, at = float("nan"), -10 ** 12
    for i, (m, t) in enumerate(zip(median_path, ts)):
        if not np.isfinite(m):
            anchor[i] = a
            continue
        if not np.isfinite(a):
            a, at = m, t
        elif t >= at + interval:
            a = m if abs(m / a - 1) <= max_dev else (a * (1 + max_dev) if m > a else a * (1 - max_dev))
            at = t
        anchor[i] = a
    served = np.abs(median_path / anchor - 1) <= max_dev
    return anchor, served


# ---------------------------------------------------------------------------------------------------------------
# RPC helpers
# ---------------------------------------------------------------------------------------------------------------

def rpc(url, method, params, tries=5):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                                  "User-Agent": "q26-r128"})
            r = json.load(urllib.request.urlopen(req, timeout=90))
            if "error" in r:
                raise RuntimeError(str(r["error"])[:200])
            return r["result"]
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(2 * (k + 1))


def swap_ticks(url, pool, b0, b1, step=2000):
    """Per-block last swap tick in [b0, b1] (block numbers). Streams logs; keeps (block, tick) only."""
    out = {}
    b = b0
    while b <= b1:
        e = min(b + step - 1, b1)
        for lg in rpc(url, "eth_getLogs", [{"address": pool, "topics": [SWAP_TOPIC],
                                             "fromBlock": hex(b), "toBlock": hex(e)}]):
            word = int(lg["data"][2 + 64 * 4: 2 + 64 * 5], 16)
            tick = word - (1 << 256) if word >= 1 << 255 else word
            out[int(lg["blockNumber"], 16)] = tick       # logs arrive in order; the last one per block wins
        b = e + 1
    return out


def block_ts(url, bn):
    return int(rpc(url, "eth_getBlockByNumber", [hex(bn), False])["timestamp"], 16)


def block_ts_many(url, bns, chunk=50):
    """Batch JSON-RPC eth_getBlockByNumber; returns {block: timestamp}."""
    out = {}
    bns = list(bns)
    for i in range(0, len(bns), chunk):
        part = bns[i:i + chunk]
        body = json.dumps([{"jsonrpc": "2.0", "id": j, "method": "eth_getBlockByNumber", "params": [hex(b), False]}
                           for j, b in enumerate(part)]).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                              "User-Agent": "q26-r128"})
        for r in json.load(urllib.request.urlopen(req, timeout=90)):
            out[part[r["id"]]] = int(r["result"]["timestamp"], 16)
    return out


def cmd_verify(a):
    """Reconstruct one pool's 1 h mean tick from swap logs and compare with observe([3600, 0]) at the same block."""
    url = a.rpc
    head = int(rpc(url, "eth_blockNumber", []), 16) - 20
    t_head = block_ts(url, head)
    res = {"utc": now_iso(), "head_block": head, "head_ts": t_head, "pools": []}
    for r in B16A_ROUTES:
        b0 = head - 600          # about 2 h of blocks: covers the window plus the tick in force at its start
        ticks = swap_ticks(url, r["pool"], b0, head)
        blocks = sorted(ticks)
        # timestamps only for blocks with swaps (and the head); window start tick = last swap before t_head - 3600
        bts = block_ts_many(url, blocks)
        t_start = t_head - ROUTE_TWAP_SECS
        before = [bn for bn in blocks if bts[bn] <= t_start]
        if not before:
            res["pools"].append({"name": r["name"], "status": "no swap before window start in probe span"})
            continue
        t0_tick = ticks[before[-1]]
        inside = [bn for bn in blocks if t_start < bts[bn] <= t_head]
        bt = np.array([bts[bn] for bn in inside], dtype=np.int64)
        tk = np.array([ticks[bn] for bn in inside], dtype=np.int64)
        # Uniswap counts the tick in force over each second; the tick set in block b applies from b's timestamp
        delta = int(tick_cumulative(bt, tk, t0_tick, t_start, np.array([t_head]))[0])
        mine = mean_tick_floor(delta, ROUTE_TWAP_SECS)
        data = "0x883bdbfd" + "0" * 62 + "20" + "0" * 63 + "2" + hex(ROUTE_TWAP_SECS)[2:].zfill(64) + "0" * 64
        raw = rpc(url, "eth_call", [{"to": r["pool"], "data": data}, hex(head)])
        words = [int(raw[2 + 64 * i: 2 + 64 * (i + 1)], 16) for i in range(len(raw[2:]) // 64)]
        c0, c1 = words[3], words[4]
        c0 = c0 - (1 << 256) if c0 >= 1 << 255 else c0
        c1 = c1 - (1 << 256) if c1 >= 1 << 255 else c1
        onchain = mean_tick_floor(c1 - c0, ROUTE_TWAP_SECS)
        res["pools"].append({"name": r["name"], "swaps_blocks_in_window": len(inside), "mean_tick_logs": mine,
                             "mean_tick_observe": onchain, "diff_ticks": mine - onchain})
        print(f"  {r['name']}: blocks with swaps {len(inside)}, mean tick logs {mine} observe {onchain} "
              f"diff {mine - onchain}")
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        json.dump(res, open(os.path.join(a.out, "verify-r128.json"), "w"), indent=1)


# ---------------------------------------------------------------------------------------------------------------
# Power (counts only, seen Binance hours; development effect from D-R12.7b)
# ---------------------------------------------------------------------------------------------------------------

def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def cmd_power(a):
    Q2 = (utc("2026-04-01"), utc("2026-07-01"))
    # development effect (D-R12.7b Binance ETH replay, 2018-10..2026-09, seen) and the KuCoin B13b value (D-R12.7d)
    dev = {"ETHUSDT": {-0.02: (0.673, 0.0318, 254), -0.03: (0.754, 0.0520, 65), -0.05: (0.647, 0.0975, 17)}}
    kucoin = {-0.02: 0.758, -0.03: 0.751, -0.05: 0.729}
    z_holm = 2.128              # one-sided alpha 0.05/3 (Holm worst step, 3 primary cells)
    z_tost = 1.645              # 90% CI inside the margin
    windows = {"B16a full (2021-06-01..2026-09-30)": (utc("2021-06-01"), utc("2026-09-30T18:00:00")),
               "B16a last 2 y (2024-10-01..2026-09-30)": (utc("2024-10-01"), utc("2026-09-30T18:00:00")),
               "B16a first part (2021-06-01..2024-09-30)": (utc("2021-06-01"), utc("2024-10-01"))}
    res = {"schema": "q26-r128-power-v1", "prereg": PREREG, "utc": now_iso(), "exposure": "alert flags only "
           "(spot vs Binance 1 h TWAP at hour boundaries, seen development data); no outcome computed",
           "windows": []}
    for pair in ("ETHUSDT", "BTCUSDT"):
        d = np.load(os.path.join(a.binance, f"{pair}.npz"))
        st = int(d["startTs"])
        ts = st + 3600 * np.arange(len(d["close"]))
        gap = np.log(d["close"] / d["tw_end"])
        ok = np.isfinite(gap)
        wk = (ts + 3 * 86400) // (7 * 86400)
        for wname, (t0, t1) in windows.items():
            m = ok & (ts >= t0) & (ts < t1) & ~((ts + 6 * 3600 > Q2[0]) & (ts < Q2[1]))
            row = {"pair": pair, "window": wname, "origins": int(m.sum()), "cells": []}
            for k in (-0.005, -0.01, -0.015) + LEVELS_PRIMARY + LEVELS_REPORTED:
                al = m & (gap <= math.log(1 + k))
                n = int(al.sum())
                c = {"level": k, "alerts_1h": n, "alert_weeks": int(len(np.unique(wk[al])))}
                if pair in dev and k in dev[pair] and n > 0:
                    p, sd, n0 = dev[pair][k]
                    se = sd * math.sqrt(n0 / n)
                    c["se_at_dev_design_effect"] = round(se, 4)
                    c["power_H1_p_gt_half"] = round(phi((p - 0.5) / se - z_holm), 3)
                    # TOST +-0.05 vs KuCoin at the development difference, and at a true difference of 0
                    for lab, diff in (("dev_diff", p - kucoin[k]), ("zero_diff", 0.0)):
                        pw = phi((0.05 - diff) / se - z_tost) + phi((0.05 + diff) / se - z_tost) - 1
                        c[f"power_equiv_kucoin_{lab}"] = round(max(0.0, pw), 3)
                    # TOST +-0.05 vs the random-walk null (paired; per-alert SD of y - p_null about 0.45 x design
                    # effect from the Binance replay), at a true difference of 0
                    se_null = 0.45 * (sd * math.sqrt(n0)) / math.sqrt(p * (1 - p)) / math.sqrt(n)
                    c["power_equiv_null_zero_diff"] = round(max(0.0, 2 * phi(0.05 / se_null - z_tost) - 1), 3)
                    c["alerts_needed_equiv_null_80pct"] = int(math.ceil(
                        (0.45 * (sd * math.sqrt(n0)) / math.sqrt(p * (1 - p)) * (z_tost + 1.2816) / 0.05) ** 2))
                row["cells"].append(c)
            res["windows"].append(row)
            print(pair, wname, row["origins"], [(c["level"], c["alerts_1h"], c.get("power_H1_p_gt_half"))
                                                 for c in row["cells"]])
    os.makedirs(a.out, exist_ok=True)
    json.dump(res, open(os.path.join(a.out, "power-r128.json"), "w"), indent=1)


def cmd_not_run(a):
    raise SystemExit("R12.8 is registered and NOT RUN (D-R12.8a): primary cells underpowered. "
                     "A revised registration must add acquire/build/counts/freeze/run before any B16 byte is read.")


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    v = sp.add_parser("verify")
    v.add_argument("--rpc", default="https://ethereum-rpc.publicnode.com")
    v.add_argument("--out")
    v.set_defaults(fn=cmd_verify)
    p = sp.add_parser("power")
    p.add_argument("--binance", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_power)
    for c in ("acquire", "build", "counts", "freeze", "run"):
        sp.add_parser(c).set_defaults(fn=cmd_not_run)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
