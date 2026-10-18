#!/usr/bin/env python3
"""Q26 live forecast log -- fifth deep touch target: Membrane's own oracle (log only, never shown).

membrane-board design/HISTORY_TOUCH_LIVE.md Deviation D10 (owner approval 2026-10-18). Used only by
q26_live_score.py with --deep-fh --membrane-oracle (through q26_live_deep.score_deep). Without the flag nothing changes.
The issue side does not change: the D9 deep rows (ETH, BTC; 12 h, 1 d, 3 d; -15/-20/-25%) are scored against one more
truth path.

Oracle (membrane-solidity 70f965e4: contracts/Oracle.sol getPrice / getMedianRoutePrice / _scanSurvivors / _medianOf /
_normalizedRoutePrice / commitMedianPrice, contracts/lib/V3PoolSelector.sol evalRoute / _hopTwapLiq /
enumerateCandidateRoutes, contracts/LtvDisco.sol ROUTE_TWAP_SECS, script/DeployFullSystem.s.sol defaults), as built in
membrane-app 0dcd8884 r128_oracle.py (verified there to 0 ticks against observe):
  * per hop, Uniswap V3 observe([3600, 0]): mean tick = floor(delta tickCumulative / 3600) (Solidity truncation then
    -1 for a negative inexact quotient == Python floor division); hop price = 1.0001 ** meanTick;
  * route price = product of hop prices, times the terminal quote's USD price (here: the Chainlink USDC/USD, USDT/USD
    or DAI/USD answer in force; the contract reads the quote's own legacy oracle source, which no deploy config fixes);
  * oracle price = median of the surviving routes (odd n: middle; even n: mean of the two middle values).
  The tick cumulative is rebuilt from Swap logs: the last swap tick of a block holds from that block's timestamp to the
  next block with a swap (mints and burns do not move the tick). The store is seeded at bootstrap by slot0() at the
  finalized block, so no archive read and no history before the bootstrap block is needed.

Routes (fixed; D-R12.8a B16a for ETH and its reported-only WBTC companion set for BTC; the contracts fix only the
candidate set -- direct asset/{USDC,USDT,DAI} pools at 4 fee tiers and 2-hop asset/WETH/quote paths -- and governance
votes the top 5, so no deploy config names routes). Identity checked by token0/token1/fee and the factory getPool.

Touch target `membrane`: O(tau) on a fixed 1-minute grid (tau = whole minutes). S_o = O(t). y = 1 iff
min over tau in (t, t + T] of O(tau) <= S_o (1 + k). Flags (not part of y): the 5% anchor gate of getPrice with a
keeper that calls commitMedianPrice at every allowed minute (gated minutes would fall through to the legacy tier, which
is not emulated), routes dropped, quotes unpriceable. The circuit breaker and the legacy / operator fallback tiers are
not emulated (they need governance and operator inputs that do not exist on chain).
"""
import os
import time

import numpy as np

import q26_live_common as C

SCHEMA = "q26-touch-live/membrane/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "deviation": "D10",
          "oracleSpec": "design/Q26_ROUND12_PREREG.md D-R12.8a"}
ORACLE_SRC = {"repo": "triccs/membrane-solidity", "sha": "70f965e4092a29b0959c4ceec0370ca032484f83",
              "files": ["contracts/Oracle.sol", "contracts/lib/V3PoolSelector.sol", "contracts/LtvDisco.sol",
                        "script/DeployFullSystem.s.sol"],
              "construction": "membrane-app 0dcd8884 scripts/research/history-forecasts/r128_oracle.py"}
FIRST_ORIGIN = C.A.utc("2026-10-19T00:00:00Z")   # first whole hour after the D10 code pin; earlier rows: not_applicable
TWAP_SECS = 3600                                 # LtvDisco.ROUTE_TWAP_SECS = Oracle.MIN_TWAP_SECS
MAX_DEV = 0.05                                   # ORACLE_MAX_DEVIATION_PCT = 5e16
CB_TRIP = 0.10                                   # ORACLE_CB_TRIP_PCT = 1e17 (reported only; not emulated)
ANCHOR_INTERVAL = 3600                           # Oracle.ANCHOR_UPDATE_INTERVAL
GRID = 60

SUB = "membrane-oracle"
TICK_HEADER = ["pool", "blockNumber", "blockTimestamp", "tick", "kind"]
QUOTE_HEADER = ["feed", "blockNumber", "blockTimestamp", "logIndex", "aggregator", "roundId", "answer", "updatedAt",
                "kind"]
TOPIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
SEL_SLOT0 = "3850c7bd"
SEL_LATEST = "feaf968c"
SEL_OBSERVE = "883bdbfd"
RPC_URLS = ("https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com")
RPC_BATCH = {"https://rpc.mevblocker.io": 20, "https://ethereum-rpc.publicnode.com": 20}
SWAP_CHUNK = 1000

# Ethereum mainnet Uniswap V3 pools (factory 0x1F98431c8aD98523631AE4a59f267346ea31F984).
POOLS = {
    "WETH/USDC 0.05%": {"address": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "dec0": 6, "dec1": 18},
    "WETH/USDC 0.30%": {"address": "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", "dec0": 6, "dec1": 18},
    "WETH/USDT 0.05%": {"address": "0x11b815efb8f581194ae79006d24e0d814b7697f6", "dec0": 18, "dec1": 6},
    "WETH/USDT 0.30%": {"address": "0x4e68ccd3e89f51c3074ca5072bbac773960dfa36", "dec0": 18, "dec1": 6},
    "DAI/WETH 0.05%": {"address": "0x60594a405d53811d3bc4766596efd80fd545a270", "dec0": 18, "dec1": 18},
    "WBTC/USDC 0.30%": {"address": "0x99ac8ca7087fa4a2a1fb6357269965a2014abc35", "dec0": 8, "dec1": 6},
    "WBTC/USDT 0.30%": {"address": "0x9db9e0e53058c89e5b94e29621a205198648425b", "dec0": 8, "dec1": 6},
    "WBTC/WETH 0.05%": {"address": "0x4585fe77225b41b697c938b018e2ac67ac5a20c0", "dec0": 8, "dec1": 18},
}
POOL_KEYS = tuple(POOLS)
ADDR_TO_POOL = {v["address"]: k for k, v in POOLS.items()}
# Route = hops (pool, asset_is_token0) from the asset to the terminal quote, and the terminal quote.
ROUTES = {
    "ETH": [
        {"name": "WETH-USDC-500", "hops": [("WETH/USDC 0.05%", False)], "quote": "USDC"},
        {"name": "WETH-USDC-3000", "hops": [("WETH/USDC 0.30%", False)], "quote": "USDC"},
        {"name": "WETH-USDT-500", "hops": [("WETH/USDT 0.05%", True)], "quote": "USDT"},
        {"name": "WETH-USDT-3000", "hops": [("WETH/USDT 0.30%", True)], "quote": "USDT"},
        {"name": "WETH-DAI-500", "hops": [("DAI/WETH 0.05%", False)], "quote": "DAI"},
    ],
    "BTC": [
        {"name": "WBTC-USDC-3000", "hops": [("WBTC/USDC 0.30%", True)], "quote": "USDC"},
        {"name": "WBTC-USDT-3000", "hops": [("WBTC/USDT 0.30%", True)], "quote": "USDT"},
        {"name": "WBTC-WETH-500-USDC-500", "hops": [("WBTC/WETH 0.05%", True), ("WETH/USDC 0.05%", False)],
         "quote": "USDC"},
    ],
}
QUOTE_FEEDS = {"USDC": ("0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", 8),
               "USDT": ("0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", 8),
               "DAI": ("0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", 8)}

TARGET_DEF = ("Membrane oracle (membrane-solidity 70f965e4): median over fixed Uniswap V3 routes (ETH: WETH/USDC 0.05% "
              "and 0.30%, WETH/USDT 0.05% and 0.30%, DAI/WETH 0.05%; BTC: WBTC/USDC 0.30%, WBTC/USDT 0.30%, WBTC/WETH "
              "0.05% x WETH/USDC 0.05%) of the product of hop 1 h tick-TWAPs (observe([3600, 0]), floor mean tick, "
              "1.0001^tick) times the quote's Chainlink USD answer; O(tau) on the 1-minute grid; y = 1 iff min O(tau) "
              "over tau in (t, t + T] <= O(t) (1 + k). Anchor gate, dropped routes and unpriceable quotes are flags; "
              "circuit breaker and fallback tiers not emulated. Rows with origin before " + C.iso(FIRST_ORIGIN) +
              " are not_applicable.")


def store_paths(ldir):
    d = os.path.join(ldir, SUB)
    return {"ticks": os.path.join(d, "uniswap-ticks.csv.gz"), "quotes": os.path.join(d, "quote-feeds.csv.gz"),
            "log": os.path.join(d, "fetch-log.jsonl")}


# ---------------------------------------------------------------------------------------------
# Oracle arithmetic (pure)
# ---------------------------------------------------------------------------------------------
def mean_tick(delta, secs=TWAP_SECS):
    """V3PoolSelector._hopTwapLiq: int24(delta / secs), minus 1 for a negative inexact quotient == floor."""
    return delta // secs


def hop_price(tick, asset_is_token0, dec0, dec1):
    """Asset price in the hop's other token, human units (the contract's raw ratio has no decimal adjustment)."""
    p10 = np.power(1.0001, np.asarray(tick, float)) * 10.0 ** (dec0 - dec1)
    return p10 if asset_is_token0 else 1.0 / p10


def median_solidity(v):
    v = sorted(x for x in v if np.isfinite(x) and x > 0)
    n = len(v)
    if n == 0:
        return float("nan")
    return v[n // 2] if n % 2 else 0.5 * (v[n // 2 - 1] + v[n // 2])


def deviation(a, b):
    """Oracle._deviationPct: (hi - lo) / lo."""
    hi, lo = (a, b) if a >= b else (b, a)
    return (hi - lo) / lo if lo > 0 else 0.0


class PoolTicks:
    """Tick in force as a step function of time from the per-block last swap tick (seed row first)."""

    def __init__(self, ts, ticks):
        self.ts = np.asarray(ts, np.int64)
        self.tk = np.asarray(ticks, np.int64)
        seg = np.diff(self.ts) * self.tk[:-1]
        self.cum = np.concatenate([[0], np.cumsum(seg)]).astype(np.int64)

    def cumulative(self, x):
        """Tick cumulative at times x relative to ts[0]; NaN-free int64 where x >= ts[0], else a sentinel mask."""
        x = np.asarray(x, np.int64)
        i = np.searchsorted(self.ts, x, side="right") - 1
        ok = i >= 0
        ii = np.maximum(i, 0)
        return self.cum[ii] + (x - self.ts[ii]) * self.tk[ii], ok

    def mean_tick(self, tau):
        c1, ok1 = self.cumulative(tau)
        c0, ok0 = self.cumulative(np.asarray(tau, np.int64) - TWAP_SECS)
        return mean_tick(c1 - c0), ok1 & ok0


def quote_in_force(qrows, tau):
    """qrows: sorted list of (ts, answer_float). Returns the answer in force at each tau (NaN if none)."""
    if not qrows:
        return np.full(len(tau), np.nan)
    ts = np.array([q[0] for q in qrows], np.int64)
    ans = np.array([q[1] for q in qrows], float)
    i = np.searchsorted(ts, np.asarray(tau, np.int64), side="right") - 1
    return np.where(i >= 0, ans[np.maximum(i, 0)], np.nan)


def oracle_path(asset, pools, quotes, tau):
    """Membrane oracle at each tau. pools: {key: PoolTicks}; quotes: {feed: [(ts, answer)]}.
    Returns (median, n_routes_surviving, n_quotes_unpriced, per-route prices)."""
    tau = np.asarray(tau, np.int64)
    per = []
    unpriced = np.zeros(len(tau), int)
    for r in ROUTES[asset]:
        px = np.ones(len(tau))
        ok = np.ones(len(tau), bool)
        for key, a0 in r["hops"]:
            pt = pools.get(key)
            if pt is None:
                ok[:] = False
                continue
            mt, okh = pt.mean_tick(tau)
            px = px * hop_price(mt, a0, POOLS[key]["dec0"], POOLS[key]["dec1"])
            ok &= okh
        q = quote_in_force(quotes.get(r["quote"], []), tau)
        qok = np.isfinite(q) & (q > 0)
        unpriced += (~qok).astype(int)
        px = px * np.where(qok, q, 1.0)       # _normalizedRoutePrice: an unpriceable quote leaves the raw price
        per.append(np.where(ok, px, np.nan))
    P = np.vstack(per)
    n = np.isfinite(P).sum(axis=0)
    S = np.sort(np.where(np.isfinite(P), P, np.inf), axis=0)
    med = np.full(len(tau), np.nan)
    for m in np.unique(n):
        if m == 0:
            continue
        cols = n == m
        med[cols] = S[m // 2, cols] if m % 2 else 0.5 * (S[m // 2 - 1, cols] + S[m // 2, cols])
    return med, n, unpriced, P


def anchor_gate(med, tau):
    """getPrice gate with a keeper that commits whenever allowed (the commit lands first in that minute).
    Returns (anchor, served, deviation from anchor)."""
    anchor = np.full(len(tau), np.nan)
    dev = np.full(len(tau), np.nan)
    a, at = float("nan"), None
    for i, (m, t) in enumerate(zip(med, tau)):
        if np.isfinite(m):
            if not np.isfinite(a):
                a, at = float(m), int(t)
            elif t >= at + ANCHOR_INTERVAL:
                if deviation(m, a) <= MAX_DEV:
                    a = float(m)
                else:
                    step = a * MAX_DEV
                    a = a + step if m > a else max(a - step, 0.0)
                at = int(t)
            dev[i] = deviation(m, a)
        anchor[i] = a
    served = np.isfinite(dev) & (dev <= MAX_DEV)
    return anchor, served, dev


# ---------------------------------------------------------------------------------------------
# Store (scorer only; append-only gzip members; seeded at bootstrap)
# ---------------------------------------------------------------------------------------------
def read_ticks(path):
    out = {k: [] for k in POOL_KEYS}
    for r in C.read_gz_csv(path, TICK_HEADER):
        key, bn, ts, tk = r[0], int(r[1]), int(r[2]), int(r[3])
        if key not in POOLS:
            raise SystemExit(f"STOP: {path}: unknown pool {key}")
        lst = out[key]
        if lst and bn <= lst[-1][0]:
            raise SystemExit(f"STOP: {path}: {key} blocks not increasing at {bn}")
        lst.append((bn, ts, tk))
    return out


def read_quotes(path):
    out = {k: [] for k in QUOTE_FEEDS}
    for r in C.read_gz_csv(path, QUOTE_HEADER):
        out[r[0]].append((int(r[1]), int(r[2]), int(r[3]), r[4].lower(), int(r[5]), int(r[6]), int(r[7]), r[8]))
    return out


def coverage(ldir):
    blk = ts = None
    for e in C.read_fetch_log(store_paths(ldir)["log"]):
        if blk is None or int(e["toBlock"]) > blk:
            blk, ts = int(e["toBlock"]), int(e["toBlockTimestamp"])
    return blk, ts


def _word(b, i):
    return int.from_bytes(b[32 * i:32 * (i + 1)], "big")


def _int(v, bits=256):
    return v - (1 << bits) if v >= 1 << (bits - 1) else v


def _swap_logs(rpc, frm, to):
    out, step, b = [], SWAP_CHUNK, frm
    addrs = [POOLS[k]["address"] for k in POOL_KEYS]
    while b <= to:
        e = min(to, b + step - 1)
        try:
            res = rpc.request_many("eth_getLogs", [[{"address": addrs, "fromBlock": hex(b), "toBlock": hex(e),
                                                      "topics": [TOPIC_SWAP]}]])[0]
        except C.RpcError:
            if step <= 50:
                raise
            step //= 4
            rpc.cur = 0
            continue
        if not isinstance(res, list):
            raise C.RpcError("eth_getLogs returned no list")
        out += res
        b = e + 1
    return out


def _block_ts(rpc, logs):
    need = sorted({int(lg["blockNumber"], 16) for lg in logs if not lg.get("blockTimestamp")})
    bts = {}
    if need:
        for b, blk in zip(need, rpc.request_many("eth_getBlockByNumber", [[hex(b), False] for b in need])):
            bts[b] = int(blk["timestamp"], 16)
    return lambda lg: int(lg["blockTimestamp"], 16) if lg.get("blockTimestamp") else bts[int(lg["blockNumber"], 16)]


def observe_check(rpc, pools_ticks, blk, blk_ts):
    """Rebuilt 1 h mean tick vs observe([3600, 0]) at the finalized block, per pool (ticks)."""
    data = SEL_OBSERVE + format(32, "064x") + format(2, "064x") + format(TWAP_SECS, "064x") + "0" * 64
    res = rpc.eth_call_many([(POOLS[k]["address"], data) for k in POOL_KEYS], block=hex(blk))
    diffs = {}
    for k, r in zip(POOL_KEYS, res):
        rows = pools_ticks.get(k) or []
        if r is C.REVERTED or not rows or rows[0][1] > blk_ts - TWAP_SECS:
            continue
        c0, c1 = _int(_word(r, 3), 256), _int(_word(r, 4), 256)
        onchain = mean_tick(c1 - c0)
        pt = PoolTicks([x[1] for x in rows if x[0] <= blk], [x[2] for x in rows if x[0] <= blk])
        mine, ok = pt.mean_tick(np.array([blk_ts]))
        if ok[0]:
            diffs[k] = int(mine[0]) - onchain
    return diffs


def update_store(rpc, ldir, clock=time.time):
    """Bootstrap (slot0 and latestRoundData seeds at the finalized block) or append every Swap log of the fixed pools
    and every AnswerUpdated log of the three quote feeds up to the finalized block."""
    import q26_live_deep as QD
    P = store_paths(ldir)
    ticks = read_ticks(P["ticks"])
    quotes = read_quotes(P["quotes"])
    fin = QD._block(rpc, "finalized")
    last_blk, _ = coverage(ldir)
    trows, qrows = [], []
    if last_blk is None:
        mode = "bootstrap"
        res = rpc.eth_call_many([(POOLS[k]["address"], SEL_SLOT0) for k in POOL_KEYS], block=hex(fin[0]))
        for k, r in zip(POOL_KEYS, res):
            if r is C.REVERTED or len(r) < 64:
                raise C.RpcError(f"slot0() failed for {k}")
            trows.append((k, fin[0], fin[1], _int(_word(r, 1), 256), "seed"))
        for f, (proxy, _) in QUOTE_FEEDS.items():
            agg = QD._aggregator(rpc, proxy, fin[0])
            r = rpc.eth_call_many([(proxy, SEL_LATEST)], block=hex(fin[0]))[0]
            if r is C.REVERTED or len(r) < 160:
                raise C.RpcError(f"latestRoundData() failed for {f}")
            rid, ans, upd = _word(r, 0) & C.AGG_MASK, _int(_word(r, 1)), _word(r, 3)
            qrows.append((f, fin[0], upd, -1, agg.lower(), rid, ans, upd, "seed"))
        frm = fin[0] + 1
    else:
        mode = "append"
        frm = last_blk + 1
    aggs_now = {}
    if frm <= fin[0]:
        raw = _swap_logs(rpc, frm, fin[0])
        tsf = _block_ts(rpc, raw)
        last = {}
        for lg in raw:
            if lg.get("removed"):
                continue
            key = ADDR_TO_POOL.get(lg["address"].lower())
            if key is None:
                continue
            bn, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
            tick = _int(int(lg["data"][2 + 64 * 4: 2 + 64 * 5], 16))
            if (key, bn) not in last or li > last[(key, bn)][0]:
                last[(key, bn)] = (li, tsf(lg), tick)
        for (key, bn), (_, ts, tick) in sorted(last.items(), key=lambda x: (x[0][1], POOL_KEYS.index(x[0][0]))):
            trows.append((key, bn, ts, tick, "swap"))
        feed_of = {}
        for f, (proxy, _) in QUOTE_FEEDS.items():
            agg = QD._aggregator(rpc, proxy, fin[0]).lower()
            aggs_now[f] = agg
            for a in {q[3] for q in quotes[f]} | {q[4] for q in qrows if q[0] == f} | {agg}:
                feed_of[a] = f
        qraw = QD._get_logs(rpc, sorted(feed_of), frm, fin[0])
        qts = _block_ts(rpc, qraw)
        new = []
        for lg in qraw:
            if lg.get("removed"):
                continue
            f = feed_of.get(lg["address"].lower())
            if f is None:
                continue
            new.append((f, int(lg["blockNumber"], 16), qts(lg), int(lg["logIndex"], 16), lg["address"].lower(),
                        int(lg["topics"][2], 16), QD._decode_int256(lg["topics"][1]), int(lg["data"][2:66] or "0", 16),
                        "log"))
        new.sort(key=lambda x: (x[1], x[3]))
        qrows += new
    for key, bn, *_ in trows:
        if ticks[key] and bn <= ticks[key][-1][0]:
            raise SystemExit(f"STOP: {key}: new swap rows overlap the store")
    if trows:
        C.append_bytes(P["ticks"], C.gz_member(None if os.path.exists(P["ticks"]) else TICK_HEADER,
                                               [[str(v) for v in x] for x in trows]))
    if qrows:
        C.append_bytes(P["quotes"], C.gz_member(None if os.path.exists(P["quotes"]) else QUOTE_HEADER,
                                                [[str(v) for v in x] for x in qrows]))
    allt = read_ticks(P["ticks"])
    try:
        diffs = observe_check(rpc, allt, fin[0], fin[1]) if mode == "append" else {}
        chk = {"pools": len(diffs), "maxAbsDiffTicks": max((abs(v) for v in diffs.values()), default=None),
               "diffs": diffs}
    except Exception as e:  # noqa: BLE001  (the check is informative; it never blocks the store)
        chk = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
    entry = {"kind": "membrane-oracle", "mode": mode, "fetchedAt": int(clock()), "fromBlock": frm, "toBlock": fin[0],
             "toBlockTimestamp": fin[1], "appendedTicks": len(trows), "appendedQuotes": len(qrows),
             "storeTicks": sum(len(v) for v in allt.values()), "quoteAggregators": aggs_now, "observeCheck": chk}
    C.append_fetch_log(P["log"], entry)
    return entry


# ---------------------------------------------------------------------------------------------
# Truth
# ---------------------------------------------------------------------------------------------
def build_ctx(ldir):
    P = store_paths(ldir)
    ticks = read_ticks(P["ticks"])
    quotes = read_quotes(P["quotes"])
    _, cov = coverage(ldir)
    pools = {k: PoolTicks([x[1] for x in v], [x[2] for x in v]) for k, v in ticks.items() if v}
    q = {}
    gaps = {}
    for f, rows in quotes.items():
        dec = 10 ** QUOTE_FEEDS[f][1]
        rs = sorted(rows, key=lambda x: (x[0], x[2]))     # (block, logIndex); the seed has logIndex -1
        q[f] = sorted((x[1], x[5] / dec) for x in rs)
        g = 0
        for p, n in zip(rs, rs[1:]):
            if n[3] == p[3] and n[4] != p[4] + 1:
                g = max(g, n[1] - p[1])
        gaps[f] = g
    return {"pools": pools, "quotes": q, "cov": cov, "quoteGaps": gaps, "start": min(
        (int(p.ts[0]) for p in pools.values()), default=None), "anchor": {}}


def _anchor_for(ctx, asset, upto):
    """Anchor path on the whole-minute grid from the store start, cached per run."""
    c = ctx["anchor"].get(asset)
    if c is not None and c["end"] >= upto:
        return c
    st = -(-ctx["start"] // GRID) * GRID + TWAP_SECS
    tau = np.arange(st, upto + 1, GRID, dtype=np.int64)
    med, n, unp, _ = oracle_path(asset, ctx["pools"], ctx["quotes"], tau)
    anchor, served, dev = anchor_gate(med, tau)
    c = {"end": upto, "tau": tau, "med": med, "n": n, "unpriced": unp, "served": served, "dev": dev}
    ctx["anchor"][asset] = c
    return c


def truth_membrane(ctx, row):
    t, T_h, k, a = int(row["origin"]), int(row["T_h"]), float(row["k"]), row["asset"]
    if t < FIRST_ORIGIN:
        return "not_applicable", {"reason": "origin before the D10 first origin " + C.iso(FIRST_ORIGIN)}
    end = t + T_h * C.HOUR
    if ctx["cov"] is None or ctx["cov"] < end or ctx["start"] is None:
        return "pending", {"reason": "membrane-oracle store does not yet cover t + T"}
    c = _anchor_for(ctx, a, ctx["cov"] - ctx["cov"] % GRID)
    i0 = np.searchsorted(c["tau"], t)
    i1 = np.searchsorted(c["tau"], end, side="right")
    if i0 >= len(c["tau"]) or c["tau"][i0] != t:
        return "unresolved", {"reason": "oracle undefined at t (store starts after t - 1 h)"}
    S_o = float(c["med"][i0])
    win = slice(i0 + 1, i1)
    med = c["med"][win]
    nr = len(ROUTES[a])
    info = {"S_o": S_o, "L_o": S_o * (1.0 + k) if np.isfinite(S_o) else None, "nMinutes": int(i1 - i0 - 1),
            "spotVsChainlink": (S_o / float(row["S"]) - 1.0) if np.isfinite(S_o) else None,
            "minRoutes": int(c["n"][i0:i1].min()), "routes": nr,
            "minutesRoutesDropped": int((c["n"][i0:i1] < nr).sum()),
            "minutesQuoteUnpriced": int((c["unpriced"][i0:i1] > 0).sum()),
            "gatedMinutes": int((~c["served"][win]).sum()),
            "maxAnchorDev": float(np.nanmax(c["dev"][i0:i1])) if np.isfinite(c["dev"][i0:i1]).any() else None,
            "anchorDevOverCbTrip": bool(np.nanmax(c["dev"][i0:i1]) > CB_TRIP) if np.isfinite(c["dev"][i0:i1]).any()
            else None,
            "quoteMaxRoundGapSeconds": max(ctx["quoteGaps"].values()) if ctx["quoteGaps"] else 0}
    if not np.isfinite(S_o) or not np.isfinite(med).all() or len(med) == 0:
        return "unresolved", dict(info, reason="no surviving route at some minute")
    mn = float(med.min())
    return "resolved", dict(info, min=mn, y=int(mn <= S_o * (1.0 + k)))
