"""Q26 R12.9: the TWAP "already through" alert on non-ETH assets priced by Membrane's exact oracle construction.

membrane-board design/Q26_ROUND12_PREREG.md, Deviations D-R12.9a, b, ... Parent findings: D-R12.6e, D-R12.7a-e,
D-R12.8a (the oracle definition and the ETH power gap). Owner decision 2026-10-18 (option B): test the alert on smaller
(non-ETH) assets priced by the same Uniswap V3 route-median oracle; Membrane will list non-ETH collateral.

Oracle (membrane-solidity 70f965e4; see r128_oracle.py for the source walk-through):
  * route price = product of hop TWAPs, hop TWAP = 1.0001 ** floor(d tickCumulative / 3600) (observe([3600, 0]));
    times the terminal quote's own USD price (Chainlink USDC/USD, USDT/USD, DAI/USD answers in force);
  * oracle = median of surviving routes (odd n middle, even n mean of the two middle values);
  * served only within 5% of an anchor (lastGoodMedian) that a keeper moves at most once per 3600 s by at most 5%;
    otherwise the legacy single-pool tier (here: the top-ranked route's own TWAP);
  * circuit breaker (10%) needs an operator fallback price (not in any free data): a proxy rate is reported.

Route set (governance stand-in, fixed in D-R12.9a; LtvDisco's vote-ranked top 5 is not deployed):
  candidate pools = canonical Uniswap V3 factory pools (asset, Q) for Q in {USDC, USDT, DAI} (one-hop route) and
  (asset, WETH) (two-hop route asset -> WETH -> USDC via the fixed bridge WETH/USDC 0.05%), every fee tier.
  For each calendar quarter, active routes = the up to 5 candidate pools with the most swap blocks in the previous
  quarter, among pools created at least 30 days before the quarter and with at least MIN_SWAP_BLOCKS swap blocks in
  the previous quarter (activity / maturity proxy for the route-health gate). An asset-quarter is scorable when at
  least 2 routes are active. One route per asset-proximal pool.

Subcommands
  select   universe and split (listings and head state only; no historical price is read)
  acquire  --group dev|b17a|bridge|chainlink  outcome-blind per-block tick builder (swap logs -> last tick per block)
  dev      development readings on the dev split (seen)
  counts   counts-only check of a confirmatory set (alert flags and label positives counted separately)
  power    power at the development effect and the confirmatory counts
  freeze / run   only after registration (D-R12.9 deviations)

Free keyless RPC only (rpc.mevblocker.io). No wallet address, key or secret is read or written. Pool and token
identifiers are public contracts.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from r128_oracle import mean_tick_floor  # noqa: E402  (same Solidity rounding as V3PoolSelector._hopTwapLiq)
import q26cache  # noqa: E402  (shared Q26 data cache; Q26_ETH_RPC_URL first when set, keyless fallback)

PREREG = {"repo": "triccs/membrane-board", "path": "design/Q26_ROUND12_PREREG.md", "item": "R12.9",
          "deviations": "D-R12.9a.."}
ORACLE_SRC = {"repo": "triccs/membrane-solidity", "sha": "70f965e4092a29b0959c4ceec0370ca032484f83"}
KEYLESS_RPCS = os.environ.get("R129_RPC", "https://gateway.tenderly.co/public/mainnet,https://rpc.mevblocker.io").split(",")
RPCS = q26cache.rpc_endpoints("ethereum", KEYLESS_RPCS, kind="logs")         # eth_getLogs: keyless only
STATE_RPCS = q26cache.rpc_endpoints("ethereum", KEYLESS_RPCS, kind="state")  # eth_call/headers: Q26_ETH_RPC_URL first
RPC = RPCS[0]
UA = "curl/8.5.0"

FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984"
FACTORY_BLOCK = 12369621
POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
ANSWER_UPDATED = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f"

WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"
DAI = "0x6b175474e89094c44da98b954eedeac495271d0f"
QUOTES = {USDC: ("USDC", 6), USDT: ("USDT", 6), DAI: ("DAI", 18)}
BRIDGE = {"name": "WETH/USDC 0.05%", "pool": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "token0": USDC,
          "token1": WETH, "fee": 500}
CHAINLINK_PROXY = {"USDC": "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6",
                   "USDT": "0x3e7d1eab13ad0104d2750b8863b489d65364e32d",
                   "DAI": "0xaed0c38402a5d19df6e4c03f4e2dced6e29c1ee9"}

SPAN = ("2021-06-01", "2026-10-01")       # minute grid; origins need a full prior quarter of route history
FIRST_QUARTER = "2021-07-01"                # first quarter that can be scored (route selection uses the previous one)
Q2_2026 = ("2026-04-01", "2026-07-01")      # never validated (Round 12 rule 6)
MIN_SWAP_BLOCKS = 1000                      # swap blocks in the previous quarter (about 11 a day)
MIN_POOL_AGE_DAYS = 30
MAX_ROUTES = 5
ASSET_TVL_USD = 250_000.0                   # selection: quote-side balance held by a pool at a coarse snapshot
ROUTE_MIN_USD = 100_000.0                   # route activation: quote-side balance at the quarter start
COARSE_SNAPSHOTS = ("2021-12-01", "2022-09-01", "2023-06-01", "2024-03-01", "2024-12-01", "2025-09-01")
LISTED_BY = "2025-06-30"                    # selection: first eligible pool created on or before this date
ROUTE_TWAP_SECS = 3600
MAX_DEV = 0.05
CB_TRIP = 0.10
HORIZONS_H = (1, 3, 6)
LEVELS = (-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20)
LEVELS_PRIMARY = (-0.02, -0.03, -0.05)
KUCOIN_B13B = {1: {-0.02: 0.758, -0.03: 0.751, -0.05: 0.729, -0.07: 0.713, -0.10: 0.681},
               3: {-0.02: 0.841, -0.03: 0.833, -0.05: 0.814, -0.07: 0.798, -0.10: 0.773},
               6: {-0.02: 0.885, -0.03: 0.878, -0.05: 0.863, -0.07: 0.846, -0.10: 0.825}}

# Pegged or non-volatile assets are not this target (their route path is a peg times ETH, BTC, gold or USD):
# stablecoins, ETH and BTC wrappers, liquid (re)staking tokens, gold, plus WBTC, which B16a holds (D-R12.8a).
EXCLUDE_SYMBOL_SUBSTR = ("USD", "EUR", "DAI", "ETH", "BTC", "XAU", "PAXG", "GHO", "FRAX", "LUSD", "CRVUSD",
                         "GOLD", "GBP", "JPY", "CHF", "CNY", "SGD", "AUD", "CAD", "TRY", "BRL")
EXCLUDE_SYMBOL_EXACT = {"STETH", "WSTETH", "RETH", "CBETH", "WEETH", "EZETH", "RSETH", "SFRXETH", "FRXETH", "OSETH",
                        "METH", "SWETH", "ANKRETH", "ETHX", "PUFETH", "WBTC", "CBBTC", "TBTC", "LBTC", "SOLVBTC",
                        "RENBTC", "HBTC", "SBTC", "XAUT", "PAXG", "USDE", "SUSDE", "USDS", "SUSDS", "PYUSD", "FDUSD",
                        "TUSD", "BUSD", "GUSD", "USDP", "RAI", "FEI", "MIM", "DOLA", "ALUSD", "SDAI", "EURC",
                        "EURS", "AGEUR", "XSGD", "OUSG", "USDY", "BUIDL", "ETH2X-FLI", "WEETHS", "AMPL", "STKAAVE",
                        "UST", "USTC", "XIDR", "EURA", "EURT", "USD1", "USDD"}
# Assets whose 1 m single-venue TWAP target was computed in R12.6 development (membrane-datasets
# history-forecasts/r12/r126-dev-1cb578fc/manifest-dev-hours.json). They form the development split.
R126_DEV_BASES_FILE = "history-forecasts/r12/r126-dev-1cb578fc/manifest-dev-hours.json"
B13_SELECTION_FILE = "b13-kucoin-prices/selection-b13.json"
SYMBOL_ALIASES = {"RNDR": "RENDER", "MATIC": "POL", "FTX TOKEN": "FTT", "TONCOIN": "TON"}   # same asset, renamed


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc(s):
    return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp())


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------------------------
# RPC
# ---------------------------------------------------------------------------------------------------------------

def _post(body, timeout=180, url=None):
    req = urllib.request.Request(url or RPC, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": UA,
                                          "Accept-Encoding": "gzip"})
    resp = urllib.request.urlopen(req, timeout=timeout)
    raw = resp.read()
    if resp.headers.get("Content-Encoding") == "gzip":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def rpc(method, params, tries=12):
    for k in range(tries):
        try:
            urls = q26cache.endpoints_for("ethereum", method, KEYLESS_RPCS)
            r = _post({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, url=urls[k % len(urls)])
            if "error" in r:
                raise RuntimeError(json.dumps(r["error"])[:300])
            return r["result"]
        except Exception as e:  # noqa: BLE001
            if any(m in str(e) for m in TOO_MANY):
                raise
            if k == tries - 1:
                raise
            time.sleep(min(60, 1 + 2 * k))


def rpc_batch(calls, chunk=100, tries=10):
    """calls: list of (method, params). Returns list of results (None on per-call error)."""
    out = []
    for i in range(0, len(calls), chunk):
        part = calls[i:i + chunk]
        body = [{"jsonrpc": "2.0", "id": j, "method": m, "params": p} for j, (m, p) in enumerate(part)]
        for k in range(tries):
            try:
                urls = RPCS if any(m in q26cache.LOG_METHODS for m, _ in part) else STATE_RPCS
                r = _post(body, url=urls[k % len(urls)])
                if isinstance(r, dict):
                    raise RuntimeError(json.dumps(r)[:300])
                res = [None] * len(part)
                for x in r:
                    res[x["id"]] = x.get("result")
                out.extend(res)
                break
            except Exception:  # noqa: BLE001
                if k == tries - 1:
                    raise
                time.sleep(min(60, 1 + 2 * k))
    return out


TOO_MANY = ("Log response size exceeded", "more than 10000 results", "query returned more than",
            "Query returned more than")


def get_logs(addresses, topic0, b0, b1, max_span=10000):
    """All logs for addresses (list) and topic0 in [b0, b1]. Splits a range on the 10k-log cap."""
    out = []
    stack = [(b0, b1)]
    while stack:
        a, b = stack.pop()
        if b - a + 1 > max_span:
            mid = a + max_span - 1
            stack.append((mid + 1, b))
            stack.append((a, mid))
            continue
        try:
            res = rpc("eth_getLogs", [{"address": addresses, "topics": [topic0], "fromBlock": hex(a),
                                       "toBlock": hex(b)}])
            out.extend(res)
        except RuntimeError as e:
            if any(m in str(e) for m in TOO_MANY) and b > a:
                mid = (a + b) // 2
                stack.append((mid + 1, b))
                stack.append((a, mid))
            else:
                raise
    return out


def block_ts(bn):
    return int(rpc("eth_getBlockByNumber", [hex(bn), False])["timestamp"], 16)


def block_at(ts, lo=FACTORY_BLOCK, hi=None):
    """First block with timestamp >= ts."""
    if hi is None:
        hi = int(rpc("eth_blockNumber", []), 16)
    while lo < hi:
        mid = (lo + hi) // 2
        if block_ts(mid) < ts:
            lo = mid + 1
        else:
            hi = mid
    return lo


def word(hexdata, i):
    return int(hexdata[2 + 64 * i: 2 + 64 * (i + 1)], 16)


def sword(hexdata, i):
    w = word(hexdata, i)
    return w - (1 << 256) if w >= 1 << 255 else w


def decode_string(res):
    if not res or res == "0x":
        return None
    try:
        if len(res) >= 2 + 64 * 3 and word(res, 0) == 32:
            n = word(res, 1)
            return bytes.fromhex(res[2 + 128: 2 + 128 + 2 * n]).decode("utf-8", "replace")
        return bytes.fromhex(res[2:66]).rstrip(b"\0").decode("utf-8", "replace")      # bytes32 (e.g. MKR)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------------------------------------------
# select: universe and split (listings + head state only)
# ---------------------------------------------------------------------------------------------------------------

def balances_at(pools, block, workers):
    """Quote-side balance (raw) of each pool at `block` (ERC20 balanceOf; state only, no price path)."""
    from concurrent.futures import ThreadPoolExecutor
    calls = [("eth_call", [{"to": p["quote"], "data": "0x70a08231" + p["pool"][2:].zfill(64)}, hex(block)])
             for p in pools]
    parts = [calls[i:i + 2000] for i in range(0, len(calls), 2000)]
    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(rpc_batch, parts))
    out = []
    for r in res:
        out.extend(int(x, 16) if x and x != "0x" else 0 for x in r)
    return out


def eth_usd_at(block):
    sq = word(rpc("eth_call", [{"to": BRIDGE["pool"], "data": "0x3850c7bd"}, hex(block)]), 0)
    return 1.0 / ((sq / 2 ** 96) ** 2 * 10 ** (6 - 18))


def quote_usd(p, raw, eth_usd):
    return raw / 1e18 * eth_usd if p["quote"] == WETH else raw / 10 ** QUOTES[p["quote"]][1]


def cmd_select(a):
    os.makedirs(a.out, exist_ok=True)
    head = int(rpc("eth_blockNumber", []), 16) - 64
    t_head = block_ts(head)
    cut_block = block_at(utc(SPAN[1]), hi=head)
    print(f"head {head} ({datetime.fromtimestamp(t_head, timezone.utc)}), span-end block {cut_block}", flush=True)
    cache = os.path.join(a.out, "poolcreated-cache.json")
    if os.path.exists(cache):
        logs = json.load(open(cache))
    else:
        logs = []
        b = FACTORY_BLOCK
        step = 200_000
        while b <= cut_block:
            e = min(b + step - 1, cut_block)
            try:
                logs.extend(rpc("eth_getLogs", [{"address": FACTORY, "topics": [POOL_CREATED], "fromBlock": hex(b),
                                                 "toBlock": hex(e)}]))
                b = e + 1
            except RuntimeError as ex:
                if any(m in str(ex) for m in TOO_MANY):
                    step //= 2
                    continue
                raise
        json.dump(logs, open(cache, "w"))
    keep_q = set(QUOTES) | {WETH}
    pools = []
    for lg in logs:
        t0 = "0x" + lg["topics"][1][-40:]
        t1 = "0x" + lg["topics"][2][-40:]
        fee = int(lg["topics"][3], 16)
        pool = "0x" + lg["data"][2 + 64 + 24: 2 + 128]
        if (t0 in keep_q) == (t1 in keep_q):
            continue
        asset, quote = (t1, t0) if t0 in keep_q else (t0, t1)
        pools.append({"pool": pool, "token0": t0, "token1": t1, "fee": fee, "asset": asset, "quote": quote,
                      "created_block": int(lg["blockNumber"], 16),
                      "created_ts": int(lg.get("blockTimestamp", "0x0"), 16)})
    print(f"PoolCreated logs {len(logs)}; asset-vs-(USDC|USDT|DAI|WETH) pools {len(pools)}", flush=True)
    # stage 1: coarse snapshots, every pool created before the snapshot
    snaps = {}
    elig_assets = {}
    for d in COARSE_SNAPSHOTS:
        bn = block_at(utc(d), hi=head)
        ps = [p for p in pools if p["created_block"] < bn]
        eu = eth_usd_at(bn)
        bal = balances_at(ps, bn, a.workers)
        deep = {}
        for p, r in zip(ps, bal):
            if quote_usd(p, r, eu) >= ASSET_TVL_USD:
                deep.setdefault(p["asset"], []).append(p["pool"])
        snaps[d] = {"block": bn, "pools": len(ps), "assets_2deep": sum(1 for v in deep.values() if len(v) >= 2)}
        for x, v in deep.items():
            if len(v) >= 2:
                elig_assets.setdefault(x, []).append(d)
        print(f"  snapshot {d} block {bn}: pools {len(ps)}, assets with >=2 deep pools "
              f"{snaps[d]['assets_2deep']}", flush=True)
    assets = sorted(elig_assets)
    meta = rpc_batch([("eth_call", [{"to": x, "data": "0x95d89b41"}, hex(head)]) for x in assets]
                     + [("eth_call", [{"to": x, "data": "0x313ce567"}, hex(head)]) for x in assets])
    syms = [decode_string(r) for r in meta[:len(assets)]]
    decs = [int(r, 16) if r and r != "0x" else None for r in meta[len(assets):]]
    dev_bases = set()
    man = json.load(open(os.path.join(a.datasets, R126_DEV_BASES_FILE)))
    for pr in man["pairs"]:
        dev_bases.add(pr["pair"][:-4].upper())
    rows = []
    for x, sym, dec in zip(assets, syms, decs):
        su = (sym or "").upper().strip()
        reason = None
        if not su or dec is None:
            reason = "no symbol/decimals"
        elif su in EXCLUDE_SYMBOL_EXACT or any(s_ in su for s_ in EXCLUDE_SYMBOL_SUBSTR):
            reason = "pegged/stable/wrapper (symbol rule)"
        elif utc(elig_assets[x][0]) > utc(LISTED_BY) + 86400 * 92:
            reason = "first deep snapshot after the listing cut"
        h = hashlib.sha256(("Q26-R12.9-B17:" + x).encode()).digest()[0]
        split = "dev" if su in dev_bases else ("b17a" if h % 2 == 0 else "b17b")
        rows.append({"asset": x, "symbol": sym, "decimals": dec, "excluded": reason, "split": split,
                     "deep_snapshots": elig_assets[x]})
    kept = {r["asset"] for r in rows if not r["excluded"]}
    cand = [p_ for p_ in pools if p_["asset"] in kept]
    # stage 2: quote-side depth of every candidate pool of a kept asset at each quarter start (route activation)
    qdepth = {}
    for q in quarters():
        bn = block_at(q["start"], hi=head)
        ps = [p for p in cand if p["created_block"] < bn]
        eu = eth_usd_at(bn)
        bal = balances_at(ps, bn, a.workers)
        for p, r in zip(ps, bal):
            p.setdefault("quote_usd_q", {})[q["q"]] = round(quote_usd(p, r, eu))
        qdepth[q["q"]] = {"block": bn, "pools": len(ps)}
        print(f"  quarter {q['q']} block {bn}: candidate pools {len(ps)}", flush=True)
    res = {"schema": "q26-r129-selection-v2", "prereg": PREREG, "utc": now_iso(), "head_block": head,
           "head_ts": t_head, "span_end_block": cut_block, "rules": {
               "pools": "canonical UniswapV3Factory PoolCreated, asset vs USDC/USDT/DAI/WETH, any fee tier",
               "eligible_asset": f">= 2 pools each holding >= ${ASSET_TVL_USD:,.0f} of the quote token at one coarse "
                                 f"snapshot {COARSE_SNAPSHOTS}; first such snapshot within one quarter of {LISTED_BY}",
               "exclusions": "stablecoins, ETH/BTC wrappers, LSTs/LRTs, gold, WBTC (B16a); symbol rules",
               "split": "dev = symbol in the R12.6 development 1 m list; else sha256('Q26-R12.9-B17:' + "
                        "lowercase address) first byte even -> b17a, odd -> b17b",
               "route_activation": f"per quarter: pools created >= {MIN_POOL_AGE_DAYS} d before the quarter, "
                                   f">= ${ROUTE_MIN_USD:,.0f} quote-side balance at the quarter start, "
                                   f">= {MIN_SWAP_BLOCKS} swap blocks in the previous quarter; top {MAX_ROUTES} by "
                                   "quote-side balance; scorable with >= 2"},
           "coarse_snapshots": snaps, "quarter_snapshots": qdepth, "n_poolcreated": len(logs),
           "n_candidate_pools_all": len(pools), "n_candidate_pools_kept": len(cand), "assets": rows}
    p = os.path.join(a.out, "selection-r129.json")
    json.dump(res, open(p, "w"), indent=1)
    json.dump({"schema": "q26-r129-candidate-pools-v2", "head_block": head, "pools": cand},
              open(os.path.join(a.out, "candidate-pools-r129.json"), "w"), indent=1)
    for sp in ("dev", "b17a", "b17b"):
        ks = [r for r in rows if not r["excluded"] and r["split"] == sp]
        print(sp, len(ks), " ".join(sorted(r["symbol"] for r in ks)))
    print("excluded", sum(1 for r in rows if r["excluded"]), " ".join(sorted(r["symbol"] or "?" for r in rows
                                                                            if r["excluded"])))
    print("sha256", sha256_file(p))


# ---------------------------------------------------------------------------------------------------------------
# acquire: outcome-blind per-block last-tick builder (prints counts only)
# ---------------------------------------------------------------------------------------------------------------

def group_pools(sel_dir, group):
    if group == "b17b":
        raise SystemExit("B17b is reserved for a revised model (D-R12.9a); it is not acquired in R12.9.")
    if group == "bridge":
        return [BRIDGE["pool"]]
    sel = json.load(open(os.path.join(sel_dir, "selection-r129.json")))
    keep = {r["asset"] for r in sel["assets"] if not r["excluded"] and r["split"] == group}
    cand = json.load(open(os.path.join(sel_dir, "candidate-pools-r129.json")))["pools"]
    return sorted({p["pool"] for p in cand if p["asset"] in keep})


def cmd_acquire(a):
    out = a.out
    os.makedirs(out, exist_ok=True)
    if a.group == "chainlink":
        return acquire_chainlink(a)
    pools = group_pools(a.sel, a.group)
    idx = {p: i for i, p in enumerate(pools)}
    prog_p = os.path.join(out, f"progress-{a.group}.json")
    raw_p = os.path.join(out, f"ticks-{a.group}.csv.gz")
    b_end = a.end_block
    prog = json.load(open(prog_p)) if os.path.exists(prog_p) else {"next_block": FACTORY_BLOCK, "logs": 0,
                                                                   "started_utc": now_iso()}
    print(f"group {a.group}: {len(pools)} pools, blocks {prog['next_block']}..{b_end}", flush=True)
    b = prog["next_block"]
    t0 = time.time()
    from concurrent.futures import ThreadPoolExecutor

    def fetch(rng_):
        b_, e_ = rng_
        lg_ = []
        for i in range(0, len(pools), a.max_addr):
            lg_.extend(get_logs(pools[i:i + a.max_addr], SWAP_TOPIC, b_, e_))
        last_ = {}
        for lg in sorted(lg_, key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16))):
            bn = int(lg["blockNumber"], 16)
            last_[(lg["address"].lower(), bn)] = (int(lg["blockTimestamp"], 16), sword(lg["data"], 4))
        return len(lg_), last_

    ex = ThreadPoolExecutor(a.workers)
    k_print = 0
    while b <= b_end:
        rngs = []
        for _ in range(a.workers * 2):
            if b > b_end:
                break
            e = min(b + a.chunk - 1, b_end)
            rngs.append((b, e))
            b = e + 1
        res = list(ex.map(fetch, rngs))
        with gzip.open(raw_p, "at") as f:
            for nlog, last in res:
                for (pa, bn), (ts, tk) in sorted(last.items(), key=lambda kv: (kv[0][1], kv[0][0])):
                    f.write(f"{idx[pa]},{bn},{ts},{tk}\n")
                prog["logs"] += nlog
        prog["next_block"] = rngs[-1][1] + 1
        json.dump(prog, open(prog_p, "w"))
        k_print += 1
        if k_print % 10 == 0:
            done = (rngs[-1][1] - FACTORY_BLOCK) / max(1, b_end - FACTORY_BLOCK)
            print(f"  block {rngs[-1][1]} ({done:.1%}) logs {prog['logs']} {time.time() - t0:.0f}s", flush=True)
    ex.shutdown()
    # finalize: one npz with per-pool (block, ts, tick) arrays (last swap per block)
    arr = np.loadtxt(gzip.open(raw_p, "rt"), delimiter=",", dtype=np.int64, ndmin=2)
    res = {}
    n_with = 0
    for i, p in enumerate(pools):
        m = arr[:, 0] == i
        sub = arr[m]
        if len(sub):
            _, u = np.unique(sub[:, 1][::-1], return_index=True)       # dedupe a resumed chunk: keep the last
            sub = sub[::-1][u]
            sub = sub[np.argsort(sub[:, 1])]
            n_with += 1
        res[p + "_block"] = sub[:, 1].astype(np.int64)
        res[p + "_ts"] = sub[:, 2].astype(np.int64)
        res[p + "_tick"] = sub[:, 3].astype(np.int32)
    npz = os.path.join(out, f"ticks-{a.group}.npz")
    np.savez_compressed(npz, **res)
    man = {"schema": "q26-r129-acquire-v1", "prereg": PREREG, "group": a.group, "rpc": [q26cache.redact(u) for u in RPCS],
           "state_rpc": [q26cache.redact(u) for u in STATE_RPCS],
           "started_utc": prog["started_utc"], "finished_utc": now_iso(), "blocks": [FACTORY_BLOCK, b_end],
           "pools": len(pools), "pools_with_swaps": n_with, "swap_logs": prog["logs"],
           "swap_blocks": int(len(arr)), "npz": os.path.basename(npz), "npz_sha256": sha256_file(npz),
           "content": "per pool: block number, block timestamp and pool tick after the last Swap of each block "
                      "with a swap; nothing else is kept (no amount, no address other than the pool)"}
    json.dump(man, open(os.path.join(out, f"manifest-{a.group}.json"), "w"), indent=1)
    print(json.dumps({k: man[k] for k in ("group", "pools", "pools_with_swaps", "swap_logs", "swap_blocks",
                                          "npz_sha256")}))


def acquire_chainlink(a):
    """AnswerUpdated history of every aggregator phase behind the USDC/USD, USDT/USD and DAI/USD proxies.

    Logs go through the shared q26cache (aligned 2,000,000-block windows; only windows at least 128 blocks behind
    the head are stored), unless --no-cache. Output is byte-identical to the uncached fetch (verified 2026-10-19)."""
    res = {"schema": "q26-r129-chainlink-v1", "utc": now_iso(), "feeds": {}}
    cache = None if getattr(a, "no_cache", False) else q26cache.Cache(log=print)
    final_block = int(rpc("eth_blockNumber", []), 16) - 128 if cache else None

    def answer_logs(agg, b0, b1):
        if cache is None:
            return get_logs([agg], ANSWER_UPDATED, b0, b1, max_span=2_000_000)
        return q26cache.cached_get_logs(
            cache, "ethereum", agg, ANSWER_UPDATED, b0, b1,
            lambda lo, hi: get_logs([agg], ANSWER_UPDATED, lo, hi, max_span=2_000_000),
            chunk=2_000_000, finalized_block=final_block, source_url=RPCS[0])
    for q, proxy in CHAINLINK_PROXY.items():
        n = int(rpc("eth_call", [{"to": proxy, "data": "0x58303b10"}, "latest"]), 16)      # phaseId()
        rows = []
        for ph in range(1, n + 1):
            agg = "0x" + rpc("eth_call", [{"to": proxy, "data": "0xc1597304" + hex(ph)[2:].zfill(64)},
                                          "latest"])[-40:]                               # phaseAggregators(ph)
            if int(agg, 16) == 0:
                continue
            logs = answer_logs(agg, FACTORY_BLOCK - 2_000_000, a.end_block)
            for lg in logs:
                ans = int(lg["topics"][1], 16)
                ans = ans - (1 << 256) if ans >= 1 << 255 else ans
                rows.append((int(lg["blockTimestamp"], 16) if "blockTimestamp" in lg else word(lg["data"], 0),
                             ans / 1e8))
        rows.sort()
        res["feeds"][q] = {"proxy": proxy, "phases": n, "updates": rows}
        print(q, "phases", n, "updates", len(rows))
    p = os.path.join(a.out, "chainlink-r129.json")
    json.dump(res, open(p, "w"))
    print("sha256", sha256_file(p))
    if cache is not None:
        print("q26cache", json.dumps(cache.stats))


# ---------------------------------------------------------------------------------------------------------------
# Oracle path on a minute grid
# ---------------------------------------------------------------------------------------------------------------

LN_TICK = math.log(1.0001)
LN_DEV = math.log(1 + MAX_DEV)
LN_CB = math.log(1 + CB_TRIP)


def minute_grid():
    return utc(SPAN[0]) + 60 * np.arange((utc(SPAN[1]) - utc(SPAN[0])) // 60 + 1, dtype=np.int64)


def quarters():
    out = []
    y, m = 2021, 7
    while True:
        s = utc(f"{y:04d}-{m:02d}-01")
        if s >= utc(SPAN[1]):
            break
        m2, y2 = (m + 3, y) if m < 10 else (1, y + 1)
        e = min(utc(f"{y2:04d}-{m2:02d}-01"), utc(SPAN[1]))
        pm, py = (m - 3, y) if m > 3 else (m + 9, y - 1)
        out.append({"q": f"{y}Q{(m - 1) // 3 + 1}", "start": s, "end": e, "prev_start": utc(f"{py:04d}-{pm:02d}-01")})
        y, m = y2, m2
    return out


def pool_minute_ticks(bts, btk, grid):
    """(twap_tick, spot_tick, valid) on the grid from per-block last-swap ticks.

    twap_tick = floor((cum(t) - cum(t - 3600)) / 3600), the V3PoolSelector._hopTwapLiq mean tick of observe([3600, 0])
    read at time t; spot_tick = pool tick after the last swap strictly before t. valid needs a swap at or before
    t - 3600 (window fully covered by the reconstruction)."""
    n = len(grid)
    twap = np.zeros(n, dtype=np.int64)
    spot = np.zeros(n, dtype=np.int64)
    if len(bts) == 0:
        return twap, spot, np.zeros(n, dtype=bool)
    ts = bts.astype(np.int64)
    tk = btk.astype(np.int64)
    seg = np.diff(ts) * tk[:-1]
    cum = np.concatenate([[0], np.cumsum(seg)])

    def cum_at(t):
        i = np.searchsorted(ts, t, side="right") - 1
        ok = i >= 0
        i = np.maximum(i, 0)
        return np.where(ok, cum[i] + (t - ts[i]) * tk[i], 0), ok

    c1, ok1 = cum_at(grid)
    c0, ok0 = cum_at(grid - ROUTE_TWAP_SECS)
    twap = (c1 - c0) // ROUTE_TWAP_SECS                    # floor division == Solidity trunc-then-decrement
    j = np.searchsorted(ts, grid, side="left") - 1
    spot = tk[np.maximum(j, 0)]
    valid = ok0 & ok1 & (j >= 0)
    return twap, spot, valid


def step_series(times, values, grid, default=1.0):
    if not len(times):
        return np.full(len(grid), default)
    i = np.searchsorted(np.asarray(times), grid, side="right") - 1
    v = np.asarray(values, dtype=float)
    return np.where(i >= 0, v[np.maximum(i, 0)], default)


def log_median(stack):
    """Oracle._medianOf on prices given as logs; stack (n_routes, n). Odd n: middle; even n: mean of two middle."""
    s = np.sort(stack, axis=0)
    n = s.shape[0]
    if n % 2:
        return s[n // 2]
    a, b = s[n // 2 - 1], s[n // 2]
    return a + np.log1p(np.exp(b - a)) - math.log(2.0)


class Ctx:
    """Shared inputs: grid, bridge hop ticks, Chainlink quote prices, candidate pools, tick arrays."""

    def __init__(self, sel_dir, data_dirs, group):
        self.grid = minute_grid()
        self.sel = json.load(open(os.path.join(sel_dir, "selection-r129.json")))
        self.cand = json.load(open(os.path.join(sel_dir, "candidate-pools-r129.json")))["pools"]
        self.group = group
        self.ticks = {}
        for d in data_dirs:
            for f in os.listdir(d):
                if f.startswith("ticks-") and f.endswith(".npz") and (f in (f"ticks-{group}.npz",
                                                                             "ticks-bridge.npz")):
                    z = np.load(os.path.join(d, f))
                    for k in z.files:
                        self.ticks[k] = z[k]
            cl = os.path.join(d, "chainlink-r129.json")
            if os.path.exists(cl):
                self.chainlink = json.load(open(cl))
        g = self.grid
        bp = BRIDGE["pool"]
        tw, sp, ok = pool_minute_ticks(self.ticks[bp + "_ts"], self.ticks[bp + "_tick"], g)
        # bridge: token0 USDC (6), token1 WETH (18); WETH in USDC = 1 / (1.0001^tick * 10^(6-18))
        self.br_twap = -(tw * LN_TICK + (6 - 18) * math.log(10))
        self.br_spot = -(sp * LN_TICK + (6 - 18) * math.log(10))
        self.br_ok = ok
        self.quote_usd = {}
        for q in ("USDC", "USDT", "DAI"):
            up = self.chainlink["feeds"][q]["updates"]
            self.quote_usd[q] = np.log(step_series([u[0] for u in up], [u[1] for u in up], g))
        self.qs = quarters()

    def assets(self):
        return [r for r in self.sel["assets"] if not r["excluded"] and r["split"] == self.group]


def build_asset(ctx, row):
    """Minute-level oracle for one asset. Returns dict with per-minute served log price, spot, flags and the route
    table per quarter."""
    g = ctx.grid
    x = row["asset"]
    adec = row["decimals"]
    pools = [p for p in ctx.cand if p["asset"] == x]
    n = len(g)
    route_cache = {}

    def route(p):
        if p["pool"] in route_cache:
            return route_cache[p["pool"]]
        bts = ctx.ticks.get(p["pool"] + "_ts", np.zeros(0, np.int64))
        btk = ctx.ticks.get(p["pool"] + "_tick", np.zeros(0, np.int32))
        tw, sp, ok = pool_minute_ticks(bts, btk, g)
        a_is0 = p["token0"] == x
        qdec = 18 if p["quote"] == WETH else QUOTES[p["quote"]][1]
        dec0, dec1 = (adec, qdec) if a_is0 else (qdec, adec)
        c = (dec0 - dec1) * math.log(10)
        sgn = 1.0 if a_is0 else -1.0
        ltw = sgn * (tw * LN_TICK + c)
        lsp = sgn * (sp * LN_TICK + c)
        if p["quote"] == WETH:
            ltw = ltw + ctx.br_twap + ctx.quote_usd["USDC"]
            lsp = lsp + ctx.br_spot + ctx.quote_usd["USDC"]
            ok = ok & ctx.br_ok
        else:
            qn = QUOTES[p["quote"]][0]
            ltw = ltw + ctx.quote_usd[qn]
            lsp = lsp + ctx.quote_usd[qn]
        route_cache[p["pool"]] = (ltw, lsp, ok)
        return route_cache[p["pool"]]

    served = np.full(n, np.nan)
    med = np.full(n, np.nan)
    spot = np.full(n, np.nan)
    fb = np.full(n, np.nan)
    nroutes = np.zeros(n, dtype=np.int8)
    qtab = []
    for q in ctx.qs:
        elig = []
        for p in pools:
            bts = ctx.ticks.get(p["pool"] + "_ts")
            if bts is None or p["created_ts"] > q["start"] - MIN_POOL_AGE_DAYS * 86400:
                continue
            c = int(np.sum((bts >= q["prev_start"]) & (bts < q["start"])))
            dep = p.get("quote_usd_q", {}).get(q["q"], 0)
            if c >= MIN_SWAP_BLOCKS and dep >= ROUTE_MIN_USD:
                elig.append((dep, c, p))
        elig.sort(key=lambda t: (-t[0], t[2]["pool"]))
        act = [p for _, _, p in elig[:MAX_ROUTES]]
        qtab.append({"q": q["q"], "routes": [{"pool": p["pool"], "fee": p["fee"], "quote": QUOTES.get(p["quote"],
                     ("WETH",))[0], "quote_usd_q_start": dep, "swap_blocks_prev_q": c}
                     for dep, c, p in elig[:MAX_ROUTES]]})
        if not act:
            continue
        i0 = np.searchsorted(g, q["start"])
        i1 = np.searchsorted(g, q["end"])
        sl = slice(i0, i1)
        tws, sps, oks = zip(*[route(p) for p in act])
        tw = np.vstack([t[sl] for t in tws])
        spm = np.vstack([s[sl] for s in sps])
        okm = np.vstack([o[sl] for o in oks]).all(axis=0)
        m = log_median(tw)
        s = log_median(spm)
        m[~okm] = np.nan
        s[~okm] = np.nan
        med[sl] = m
        spot[sl] = s
        fb[sl] = tws[0][sl]
        nroutes[sl] = len(act)
    # anchor gate: a keeper commits at every hour boundary (Oracle.commitMedianPrice, at most once per 3600 s, clamped
    # to +-5% per step); getPrice serves the median iff (hi - lo) / lo <= 5% versus the anchor, else the legacy tier.
    hours = np.arange(0, n - 1, 60)
    anchor_h = np.full(len(hours), np.nan)
    clamp_h = np.zeros(len(hours), dtype=bool)
    a_ = np.nan
    mh = med[hours]
    for j in range(len(hours)):
        v = mh[j]
        if np.isfinite(v):
            if not np.isfinite(a_):
                a_ = v
            else:
                d = v - a_
                if abs(d) <= LN_DEV:
                    a_ = v
                else:
                    clamp_h[j] = True
                    a_ = a_ + (math.log(1 + MAX_DEV) if d > 0 else math.log(1 - MAX_DEV))
        anchor_h[j] = a_
    anchor = np.repeat(anchor_h, 60)[:n]
    if len(anchor) < n:
        anchor = np.concatenate([anchor, np.full(n - len(anchor), anchor_h[-1])])
    gated = np.isfinite(med) & (np.abs(med - anchor) > LN_DEV)
    served = np.where(gated, fb, med)
    cb_h = np.isfinite(fb[hours]) & (np.abs(fb[hours] - anchor_h) > LN_CB)
    return {"served": served, "med": med, "spot": spot, "nroutes": nroutes, "gated": gated, "anchor": anchor,
            "clamp_h": clamp_h, "cb_h": cb_h, "hours": hours, "qtab": qtab}


def origins_for(ctx, b):
    """Hourly origins (minute indices) whose [t - 1 h, t + 6 h] lies inside one quarter with >= 2 active routes,
    with finite served and spot values, window end <= span end. Returns indices and a reported-only flag (2026Q2)."""
    g = ctx.grid
    hrs = b["hours"]
    keep = np.zeros(len(hrs), dtype=bool)
    for q in ctx.qs:
        i0 = np.searchsorted(g, q["start"])
        i1 = np.searchsorted(g, q["end"])
        m = (hrs >= i0 + 60) & (hrs + 360 < i1)
        keep |= m
    keep &= b["nroutes"][hrs] >= 2
    keep &= np.isfinite(b["served"][hrs]) & np.isfinite(b["spot"][hrs])
    idx = hrs[keep]
    t = g[idx]
    rep = (t + 6 * 3600 > utc(Q2_2026[0])) & (t - 3600 < utc(Q2_2026[1]))
    return idx, rep


def labels_and_alerts(b, idx):
    """alert[k] (spot at or below O_t(1 + k)) and y[T][k] (served oracle at any minute in (t, t + T] at or below
    O_t(1 + k)). Window minima from per-hour minima of the served path."""
    s = b["served"]
    n = len(s)
    hmin = np.full(n // 60 + 8, np.nan)
    blk = s[1: 1 + 60 * ((n - 1) // 60)].reshape(-1, 60)
    hmin[: blk.shape[0]] = np.nanmin(np.where(np.isfinite(blk), blk, np.inf), axis=1)
    hidx = idx // 60
    O = s[idx]
    S = b["spot"][idx]
    alerts = {k: S <= O + math.log(1 + k) for k in LEVELS}
    y = {}
    for T in HORIZONS_H:
        w = np.min(np.vstack([hmin[hidx + j] for j in range(T)]), axis=0)
        y[T] = {k: w <= O + math.log(1 + k) for k in LEVELS}
    return alerts, y


def null_probs(b, idx_alert, seed, n_paths=2000, t3=False):
    """Driftless minute random walk from S_t with sigma = RMS of 1 m log changes of the spot median over the trailing
    24 h (>= 1,300 minutes); the oracle path is O_t updated with the geometric 60-minute window (known history, then
    simulated minutes). Returns p_null[T][k] arrays (NaN where sigma is undefined)."""
    rng = np.random.default_rng(seed)
    sp = b["spot"]
    out = {T: {k: np.full(len(idx_alert), np.nan) for k in LEVELS} for T in HORIZONS_H}
    M = 60 * max(HORIZONS_H)
    for a_i, i in enumerate(idx_alert):
        w = sp[i - 1440: i + 1]
        d = np.diff(w)
        d = d[np.isfinite(d)]
        if len(d) < 1300:
            continue
        sig = math.sqrt(float(np.mean(d * d)))
        hist = sp[i - 59: i + 1]
        if not np.all(np.isfinite(hist)):
            continue
        z = rng.standard_t(3, size=(n_paths, M)) / math.sqrt(3.0) if t3 else rng.standard_normal((n_paths, M))
        xs = sp[i] + sig * np.cumsum(z, axis=1)
        old = np.concatenate([np.broadcast_to(hist, (n_paths, 60)), xs[:, : M - 60]], axis=1)
        lo = b["served"][i] + np.cumsum(xs - old, axis=1) / 60.0
        run = np.minimum.accumulate(lo, axis=1)
        O = b["served"][i]
        for T in HORIZONS_H:
            r = run[:, 60 * T - 1]
            for k in LEVELS:
                out[T][k][a_i] = float(np.mean(r <= O + math.log(1 + k)))
    return out


def week_id(t):
    return (t + 3 * 86400) // (7 * 86400)


def boot_ratio(num_w, den_w, B=10000, seed=7):
    """Weekly block bootstrap of sum(num)/sum(den); returns (point, lo90, hi90, sd, p_le_half)."""
    G = len(num_w)
    if G == 0 or den_w.sum() == 0:
        return None
    rng = np.random.default_rng(seed)
    cnt = rng.multinomial(G, np.full(G, 1.0 / G), size=B)
    nn = cnt @ num_w
    dd = cnt @ den_w
    r = np.where(dd > 0, nn / np.maximum(dd, 1e-12), np.nan)
    pt = num_w.sum() / den_w.sum()
    return {"p": round(float(pt), 4), "ci90": [round(float(np.nanpercentile(r, 5)), 4),
                                                round(float(np.nanpercentile(r, 95)), 4)],
            "sd": round(float(np.nanstd(r)), 4), "p_le_half": float((1 + np.sum(r <= 0.5)) / (B + 1))}


def collect(ctx, with_labels=True, with_null=True, seed=20261018, log=print):
    """Per asset: build, origins, alerts, labels, null. Returns a list of per-origin records (compact arrays)."""
    recs = []
    diag = {"assets": [], "minutes_scorable": 0, "minutes_gated": 0, "hours_scorable": 0, "hours_clamped": 0,
            "hours_cb_proxy": 0}
    for ai, row in enumerate(ctx.assets()):
        t0 = time.time()
        b = build_asset(ctx, row)
        idx, rep = origins_for(ctx, b)
        sc = b["nroutes"] >= 2
        hsc = sc[b["hours"]]
        diag["minutes_scorable"] += int(sc.sum())
        diag["minutes_gated"] += int((b["gated"] & sc).sum())
        diag["hours_scorable"] += int(hsc.sum())
        diag["hours_clamped"] += int((b["clamp_h"] & hsc).sum())
        diag["hours_cb_proxy"] += int((b["cb_h"] & hsc).sum())
        nq = sum(1 for q in b["qtab"] if len(q["routes"]) >= 2)
        diag["assets"].append({"symbol": row["symbol"], "scorable_quarters": nq, "origins": int(len(idx)),
                               "routes_per_quarter": [len(q["routes"]) for q in b["qtab"]],
                               "gated_minutes": int((b["gated"] & sc).sum()),
                               "clamped_hours": int((b["clamp_h"] & hsc).sum()),
                               "cb_proxy_hours": int((b["cb_h"] & hsc).sum()), "qtab": b["qtab"]})
        if len(idx) == 0:
            continue
        alerts, y = labels_and_alerts(b, idx)
        rec = {"asset": row["symbol"], "t": ctx.grid[idx], "rep": rep,
               "alerts": {k: alerts[k] for k in LEVELS}}
        if with_labels:
            rec["y"] = y
        if with_null and with_labels:
            ia = idx[alerts[LEVELS[0]]]
            pn = null_probs(b, ia, seed + ai)
            rec["pnull"] = pn
            rec["pnull_t3"] = null_probs(b, ia, seed + 1000 + ai, n_paths=500, t3=True)
            rec["alert_idx_pos"] = np.nonzero(alerts[LEVELS[0]])[0]
        recs.append(rec)
        log(f"  {row['symbol']}: quarters {nq}, origins {len(idx)}, alerts(-2%) {int(alerts[-0.02].sum())}, "
            f"{time.time() - t0:.0f}s")
        del b
    return recs, diag


def score(recs, scored=True):
    """Pooled cell statistics over scored origins (2026Q2 excluded when scored=True)."""
    res = {}
    for T in HORIZONS_H:
        for k in LEVELS:
            wk_al, wk_hit, wk_pos, wk_dn, wk_dn_n, wk_d3 = {}, {}, {}, {}, {}, {}
            n_or = 0
            for r in recs:
                m = ~r["rep"] if scored else np.ones(len(r["t"]), bool)
                al = r["alerts"][k] & m
                yy = r["y"][T][k] & m
                w = week_id(r["t"])
                n_or += int(m.sum())
                for arr, dct in ((al, wk_al), (al & yy, wk_hit), (yy, wk_pos)):
                    u, c = np.unique(w[arr], return_counts=True)
                    for a_, c_ in zip(u, c):
                        dct[a_] = dct.get(a_, 0) + c_
                if "pnull" in r:
                    pos = r["alert_idx_pos"]
                    pn = r["pnull"][T][k]
                    p3 = r["pnull_t3"][T][k]
                    sel = r["alerts"][k][pos] & m[pos] & np.isfinite(pn)
                    d = yy[pos][sel].astype(float) - pn[sel]
                    d3 = yy[pos][sel & np.isfinite(p3)].astype(float) - p3[sel & np.isfinite(p3)]
                    ww = w[pos][sel]
                    for a_, v in zip(ww, d):
                        wk_dn[a_] = wk_dn.get(a_, 0.0) + v
                        wk_dn_n[a_] = wk_dn_n.get(a_, 0) + 1
                    for a_, v in zip(w[pos][sel & np.isfinite(p3)], d3):
                        wk_d3[a_] = wk_d3.get(a_, 0.0) + v
            weeks = sorted(set(wk_al) | set(wk_pos))
            al_w = np.array([wk_al.get(x, 0) for x in weeks], float)
            hit_w = np.array([wk_hit.get(x, 0) for x in weeks], float)
            pos_w = np.array([wk_pos.get(x, 0) for x in weeks], float)
            c = {"T": T, "k": k, "origins": n_or, "alerts": int(al_w.sum()), "alert_weeks": int((al_w > 0).sum()),
                 "positives": int(pos_w.sum()), "weeks": len(weeks)}
            if al_w.sum() > 0:
                c["hit"] = boot_ratio(hit_w, al_w)
                c["recall"] = round(float(hit_w.sum() / max(1, pos_w.sum())), 4)
                c["alert_rate"] = round(float(al_w.sum() / max(1, n_or)), 6)
                c["false_alarm_rate"] = round(float((al_w.sum() - hit_w.sum()) / max(1, n_or - pos_w.sum())), 6)
            if wk_dn:
                wd = sorted(wk_dn)
                dn = np.array([wk_dn[x] for x in wd])
                nn = np.array([wk_dn_n[x] for x in wd], float)
                bt = boot_ratio(dn, nn, seed=11)
                c["y_minus_pnull"] = bt
                c["n_null"] = int(nn.sum())
                if wk_d3:
                    d3 = np.array([wk_d3.get(x, 0.0) for x in wd])
                    c["y_minus_pnull_t3"] = round(float(d3.sum() / nn.sum()), 4)
            if T in KUCOIN_B13B and k in KUCOIN_B13B[T] and "hit" in c:
                c["kucoin_b13b"] = KUCOIN_B13B[T][k]
            res[f"{T}h_{int(round(k * 100))}"] = c
    return res


def per_year(recs, T=1, k=-0.02):
    out = {}
    for r in recs:
        yr = np.array([datetime.fromtimestamp(int(x), timezone.utc).year for x in r["t"]])
        m = ~r["rep"]
        for Y in np.unique(yr):
            mm = m & (yr == Y)
            al = r["alerts"][k] & mm
            o = out.setdefault(int(Y), [0, 0, 0])
            o[0] += int(mm.sum())
            o[1] += int(al.sum())
            o[2] += int((al & r["y"][T][k]).sum())
    return {Y: {"origins": v[0], "alerts": v[1], "hit": round(v[2] / v[1], 4) if v[1] else None}
            for Y, v in sorted(out.items())}


def cmd_dev(a):
    t_start = now_iso()
    ctx = Ctx(a.sel, a.data, "dev")
    recs, diag = collect(ctx)
    res = {"schema": "q26-r129-dev-v1", "prereg": PREREG, "oracle_src": ORACLE_SRC, "utc_start": t_start,
           "group": "dev", "assets": [r["symbol"] for r in ctx.assets()], "cells": score(recs),
           "cells_including_2026q2": score(recs, scored=False), "per_year_1h_m2": per_year(recs),
           "per_asset_1h_m2": {r["asset"]: {"alerts": int((r["alerts"][-0.02] & ~r["rep"]).sum()),
                                            "hits": int((r["alerts"][-0.02] & r["y"][1][-0.02] & ~r["rep"]).sum())}
                               for r in recs},
           "oracle_events": {k: v for k, v in diag.items() if k != "assets"}, "assets_diag": diag["assets"]}
    res["oracle_events"]["share_minutes_gated"] = diag["minutes_gated"] / max(1, diag["minutes_scorable"])
    res["oracle_events"]["share_hours_clamped"] = diag["hours_clamped"] / max(1, diag["hours_scorable"])
    res["oracle_events"]["share_hours_cb_proxy"] = diag["hours_cb_proxy"] / max(1, diag["hours_scorable"])
    res["utc_end"] = now_iso()
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "dev-r129.json")
    json.dump(res, open(p, "w"), indent=1, default=float)
    for key, c in res["cells"].items():
        h = c.get("hit") or {}
        print(key, c["alerts"], c["alert_weeks"], h.get("p"), h.get("ci90"), c.get("recall"),
              (c.get("y_minus_pnull") or {}).get("p"), (c.get("y_minus_pnull") or {}).get("ci90"))
    print(json.dumps(res["oracle_events"]))
    print("sha256", sha256_file(p))


def cmd_counts(a):
    """Counts-only check: alert flags and label positives counted separately (no joint count, no hit rate)."""
    t_start = now_iso()
    ctx = Ctx(a.sel, a.data, a.group)
    recs, diag = collect(ctx, with_null=False)
    cells = {}
    for T in HORIZONS_H:
        for k in LEVELS:
            al_w, pos_w, n = set(), set(), 0
            al = pos = 0
            for r in recs:
                m = ~r["rep"]
                w = week_id(r["t"])
                n += int(m.sum())
                aa = r["alerts"][k] & m
                yy = r["y"][T][k] & m
                al += int(aa.sum())
                pos += int(yy.sum())
                al_w |= set(np.unique(w[aa]).tolist())
                pos_w |= set(np.unique(w[yy]).tolist())
            cells[f"{T}h_{int(round(k * 100))}"] = {"origins": n, "alerts": al, "alert_weeks": len(al_w),
                                                     "positives": pos, "positive_weeks": len(pos_w)}
    weeks = set()
    for r in recs:
        weeks |= set(np.unique(week_id(r["t"][~r["rep"]])).tolist())
    res = {"schema": "q26-r129-counts-v1", "prereg": PREREG, "group": a.group, "utc_start": t_start,
           "utc_end": now_iso(), "exposure": "alert flags and label positives counted separately; no joint count, "
           "no hit rate, no forecast, no null", "weeks": len(weeks), "cells": cells,
           "assets": [{k: d[k] for k in ("symbol", "scorable_quarters", "origins")} for d in diag["assets"]],
           "oracle_events": {k: v for k, v in diag.items() if k != "assets"}}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, f"counts-r129-{a.group}.json")
    json.dump(res, open(p, "w"), indent=1)
    print("weeks", len(weeks))
    for key, c in cells.items():
        print(key, c)
    print("sha256", sha256_file(p))


def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


Z_HOLM = {1: 2.128, 3: 2.394, 6: 2.394}   # one-sided, worst Holm step: 1 h family of 3; 3 h + 6 h family of 6
Z_TOST = 1.645


def power_cells(dev, counts):
    out = {}
    for key, c in dev["cells"].items():
        T, k = c["T"], c["k"]
        n_dev = c["alerts"]
        n_c = counts["cells"][key]["alerts"]
        row = {"T": T, "k": k, "alerts_dev": n_dev, "alerts_b17a": n_c,
               "alert_weeks_b17a": counts["cells"][key]["alert_weeks"]}
        h = c.get("hit")
        if h and n_c > 0 and n_dev >= 20 and h["sd"] > 0:
            se = h["sd"] * math.sqrt(n_dev / n_c)
            row["P_dev"] = h["p"]
            row["se_b17a"] = round(se, 4)
            row["power_H1"] = round(phi((h["p"] - 0.5) / se - Z_HOLM[T]), 3)
            if T in KUCOIN_B13B and k in KUCOIN_B13B[T]:
                d = h["p"] - KUCOIN_B13B[T][k]
                row["dev_diff_vs_kucoin"] = round(d, 4)
                row["power_H2a"] = round(max(0.0, phi((0.05 - d) / se - Z_TOST) + phi((0.05 + d) / se - Z_TOST) - 1), 3)
            yn = c.get("y_minus_pnull")
            if yn and yn["sd"] > 0:
                se2 = yn["sd"] * math.sqrt(c["n_null"] / max(1, n_c))
                d2 = yn["p"]
                row["dev_y_minus_pnull"] = d2
                row["se2_b17a"] = round(se2, 4)
                row["power_H2b"] = round(max(0.0, phi((0.05 - d2) / se2 - Z_TOST) + phi((0.05 + d2) / se2 - Z_TOST)
                                             - 1), 3)
                row["power_H2b_zero_diff"] = round(max(0.0, 2 * phi(0.05 / se2 - Z_TOST) - 1), 3)
        out[key] = row
    return out


def cmd_power(a):
    dev = json.load(open(a.dev))
    counts = json.load(open(a.counts))
    res = {"schema": "q26-r129-power-v1", "prereg": PREREG, "utc": now_iso(), "dev_sha256": sha256_file(a.dev),
           "counts_sha256": sha256_file(a.counts), "method": "SE = development weekly-bootstrap SD x sqrt(n_dev / "
           "n_b17a); H1 one-sided at the worst Holm step; H2a/H2b TOST +-0.05 at the development difference",
           "cells": power_cells(dev, counts)}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "power-r129.json")
    json.dump(res, open(p, "w"), indent=1)
    for key, r in res["cells"].items():
        print(key, {k: v for k, v in r.items() if k not in ("T", "k")})
    print("sha256", sha256_file(p))


CODE_FILES = ("r129_alt_oracle.py", "r128_oracle.py")


def cmd_freeze(a):
    here = os.path.dirname(os.path.abspath(__file__))
    import subprocess
    sha = subprocess.check_output(["git", "-C", here, "rev-parse", "HEAD"]).decode().strip()
    dirty = subprocess.check_output(["git", "-C", here, "status", "--porcelain", "--", "."]).decode().strip()
    if dirty:
        raise SystemExit("freeze needs a clean tree")
    inputs = {}
    for p in a.inputs:
        inputs[os.path.basename(p)] = sha256_file(p)
    cfg = {"schema": "q26-r129-frozen-v1", "prereg": PREREG, "oracle_src": ORACLE_SRC, "created_utc": now_iso(),
           "code_sha": sha, "code_files_sha256": {f: sha256_file(os.path.join(here, f)) for f in CODE_FILES},
           "inputs_sha256": inputs, "group": "b17a", "primary_cells": a.primary, "seed": 20261018,
           "constants": {"SPAN": SPAN, "MIN_SWAP_BLOCKS": MIN_SWAP_BLOCKS, "MIN_POOL_AGE_DAYS": MIN_POOL_AGE_DAYS,
                         "MAX_ROUTES": MAX_ROUTES, "ROUTE_MIN_USD": ROUTE_MIN_USD, "ROUTE_TWAP_SECS": ROUTE_TWAP_SECS,
                         "MAX_DEV": MAX_DEV, "CB_TRIP": CB_TRIP, "HORIZONS_H": HORIZONS_H, "LEVELS": LEVELS,
                         "KUCOIN_B13B": {str(t): {str(k): v for k, v in d.items()} for t, d in KUCOIN_B13B.items()},
                         "Z_HOLM": {str(k): v for k, v in Z_HOLM.items()}, "bootstrap": 10000, "null_paths": 2000}}
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "frozen-r129-config.json")
    json.dump(cfg, open(p, "w"), indent=1)
    print("frozen", p, sha256_file(p), cfg["created_utc"])


def holm(pvals, alpha=0.05):
    order = sorted(pvals, key=lambda kv: kv[1])
    m = len(order)
    out = {}
    stop = False
    for i, (k, p) in enumerate(order):
        if stop or p > alpha / (m - i):
            stop = True
            out[k] = False
        else:
            out[k] = True
    return out


def cmd_run(a):
    cfg = json.load(open(a.frozen))
    t_start = now_iso()
    print("run start", t_start, flush=True)
    ctx = Ctx(a.sel, a.data, "b17a")
    recs, diag = collect(ctx, seed=cfg["seed"])
    cells = score(recs)
    prim = set(cfg["primary_cells"])
    tests = {}
    for key, c in cells.items():
        h = c.get("hit")
        t = {"primary": key in prim}
        if h:
            t["H1_p"] = h["p_le_half"]
            if "kucoin_b13b" in c:
                lo, hi = h["ci90"][0] - c["kucoin_b13b"], h["ci90"][1] - c["kucoin_b13b"]
                t["H2a_diff_ci90"] = [round(lo, 4), round(hi, 4)]
                t["H2a_pass"] = bool(lo > -0.05 and hi < 0.05)
            yn = c.get("y_minus_pnull")
            if yn:
                t["H2b_ci90"] = yn["ci90"]
                t["H2b_pass"] = bool(yn["ci90"][0] > -0.05 and yn["ci90"][1] < 0.05)
        tests[key] = t
    for fam in ({k for k in prim if k.startswith("1h_")}, {k for k in prim if not k.startswith("1h_")}):
        hp = holm([(k, tests[k]["H1_p"]) for k in fam if "H1_p" in tests[k]])
        for k, v in hp.items():
            tests[k]["H1_pass_holm"] = v
    res = {"schema": "q26-r129-results-v1", "prereg": PREREG, "frozen_sha256": sha256_file(a.frozen),
           "utc_start": t_start, "group": "b17a", "assets": [r["symbol"] for r in ctx.assets()], "cells": cells,
           "tests": tests, "cells_including_2026q2": score(recs, scored=False), "per_year_1h_m2": per_year(recs),
           "per_asset_1h_m2": {r["asset"]: {"alerts": int((r["alerts"][-0.02] & ~r["rep"]).sum()),
                                            "hits": int((r["alerts"][-0.02] & r["y"][1][-0.02] & ~r["rep"]).sum())}
                               for r in recs},
           "oracle_events": {k: v for k, v in diag.items() if k != "assets"}, "assets_diag": diag["assets"]}
    ev = res["oracle_events"]
    ev["share_minutes_gated"] = diag["minutes_gated"] / max(1, diag["minutes_scorable"])
    ev["share_hours_clamped"] = diag["hours_clamped"] / max(1, diag["hours_scorable"])
    ev["share_hours_cb_proxy"] = diag["hours_cb_proxy"] / max(1, diag["hours_scorable"])
    res["utc_end"] = now_iso()
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "results-r129.json")
    json.dump(res, open(p, "w"), indent=1, default=float)
    for key, c in cells.items():
        h = c.get("hit") or {}
        print(key, c["alerts"], h.get("p"), h.get("ci90"), c.get("recall"), tests[key])
    print(json.dumps(ev))
    print("run end", res["utc_end"], "sha256", sha256_file(p))


def cmd_relabel(a):
    """Re-apply the symbol exclusion rule and the R12.6 alias rule to an existing selection (no RPC). Used once,
    2026-10-18, before any tick of any split was read: adds UST, USTC and XIDR (stablecoins missed by the
    substring rule) to the exclusions and moves to dev every asset whose single-venue 1 m TWAP target was already
    computed: renamed R12.6 development assets (RNDR = RENDER) and B13a/B13b KuCoin series (ADS, XYO, EFI, REVV)."""
    sel = json.load(open(os.path.join(a.sel, "selection-r129.json")))
    cand = json.load(open(os.path.join(a.sel, "candidate-pools-r129.json")))
    for r in sel["assets"]:
        su = (r["symbol"] or "").upper().strip()
        if not r["excluded"] and (su in EXCLUDE_SYMBOL_EXACT or any(x in su for x in EXCLUDE_SYMBOL_SUBSTR)):
            r["excluded"] = "pegged/stable/wrapper (symbol rule, relabel 2026-10-18)"
        dev_bases = {pr["pair"][:-4].upper() for pr in json.load(open(os.path.join(a.datasets,
                                                                               R126_DEV_BASES_FILE)))["pairs"]}
        b13 = json.load(open(os.path.join(a.datasets, B13_SELECTION_FILE)))
        b13_bases = set(b13["B13a"]) | set(b13["B13b"])
        base = SYMBOL_ALIASES.get(su, su)
        if r["split"] != "dev" and base in dev_bases:
            r["split"] = "dev"
            r["split_note"] = f"alias {su} = {base} (R12.6 development 1 m list)"
        elif r["split"] != "dev" and base in b13_bases:
            r["split"] = "dev"
            r["split_note"] = f"{base} is a B13a/B13b KuCoin series (1 m TWAP alert computed in R12.6/R12.7)"
    kept = {r["asset"] for r in sel["assets"] if not r["excluded"]}
    cand["pools"] = [p for p in cand["pools"] if p["asset"] in kept]
    sel["n_candidate_pools_kept"] = len(cand["pools"])
    sel["relabel_utc"] = now_iso()
    os.makedirs(a.out, exist_ok=True)
    p = os.path.join(a.out, "selection-r129.json")
    json.dump(sel, open(p, "w"), indent=1)
    json.dump(cand, open(os.path.join(a.out, "candidate-pools-r129.json"), "w"), indent=1)
    for sp in ("dev", "b17a", "b17b"):
        ks = [r for r in sel["assets"] if not r["excluded"] and r["split"] == sp]
        print(sp, len(ks), " ".join(sorted(r["symbol"] for r in ks)))
    print("sha256", sha256_file(p), sha256_file(os.path.join(a.out, "candidate-pools-r129.json")))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("select")
    s.add_argument("--datasets", default="/home/user/membrane-datasets")
    s.add_argument("--out", required=True)
    s.add_argument("--workers", type=int, default=3)
    s.set_defaults(fn=cmd_select)
    rl = sp.add_parser("relabel")
    rl.add_argument("--sel", required=True)
    rl.add_argument("--out", required=True)
    rl.add_argument("--datasets", default="/home/user/membrane-datasets")
    rl.set_defaults(fn=cmd_relabel)
    q = sp.add_parser("acquire")
    q.add_argument("--group", required=True, choices=["dev", "b17a", "b17b", "bridge", "chainlink"])
    q.add_argument("--sel", required=True)
    q.add_argument("--out", required=True)
    q.add_argument("--end-block", type=int, required=True)
    q.add_argument("--chunk", type=int, default=10000)
    q.add_argument("--max-addr", type=int, default=400)
    q.add_argument("--workers", type=int, default=4)
    q.add_argument("--no-cache", action="store_true", help="chainlink: bypass the shared q26cache")
    q.set_defaults(fn=cmd_acquire)
    for name, fn in (("dev", cmd_dev), ("counts", cmd_counts)):
        x = sp.add_parser(name)
        x.add_argument("--sel", required=True)
        x.add_argument("--data", nargs="+", required=True)
        x.add_argument("--out", required=True)
        x.add_argument("--group", default="dev")
        x.set_defaults(fn=fn)
    pw = sp.add_parser("power")
    pw.add_argument("--dev", required=True)
    pw.add_argument("--counts", required=True)
    pw.add_argument("--out", required=True)
    pw.set_defaults(fn=cmd_power)
    fz = sp.add_parser("freeze")
    fz.add_argument("--inputs", nargs="+", required=True)
    fz.add_argument("--primary", nargs="+", required=True)
    fz.add_argument("--out", required=True)
    fz.set_defaults(fn=cmd_freeze)
    rn = sp.add_parser("run")
    rn.add_argument("--frozen", required=True)
    rn.add_argument("--sel", required=True)
    rn.add_argument("--data", nargs="+", required=True)
    rn.add_argument("--out", required=True)
    rn.set_defaults(fn=cmd_run)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
