"""Liquidation events with exact block timestamps, all v1 venues (prereg C.2.2, C.3.4 impact episodes).

Aave/Spark LiquidationCall, Morpho Blue Liquidate, Comet AbsorbCollateral and BuyCollateral.
Timestamps come from the log's blockTimestamp field when the node serves it, else eth_getBlockByNumber.
"""
from __future__ import annotations

import gzip
import json
import os

from rpc import Client, to_addr, words
import aave as A
import comet as C
import morpho as M


def _ts(c: Client, lg, cache):
    if lg.get("blockTimestamp"):
        return int(lg["blockTimestamp"], 16)
    b = int(lg["blockNumber"], 16)
    if b not in cache:
        cache[b] = c.block_ts(b)
    return cache[b]


def fetch(venue: str, chain: str, address, topics, frm: int, to: int, out: str, step=1_000_000):
    if os.path.exists(out):
        return
    c = Client(chain)
    cache = {}
    rows = []
    for lg in c.get_logs(address, topics, frm, to, step=step):
        rows.append({"block": int(lg["blockNumber"], 16), "logIndex": int(lg["logIndex"], 16),
                     "ts": _ts(c, lg, cache), "tx": lg["transactionHash"], "address": lg["address"].lower(),
                     "topics": lg["topics"], "data": lg["data"]})
    rows.sort(key=lambda r: (r["block"], r["logIndex"]))
    with gzip.open(out + ".tmp", "wt") as f:
        json.dump(rows, f)
    os.replace(out + ".tmp", out)
    print(venue, chain, len(rows), "events", flush=True)


def fetch_all(work: str, end_blocks: dict):
    d = os.path.join(work, "liq")
    os.makedirs(d, exist_ok=True)
    jobs = []
    for mk in ("aave-core-eth", "aave-prime-eth", "spark-eth", "aave-arb", "aave-op", "aave-base"):
        mp = os.path.join(work, mk, "meta.json")
        if not os.path.exists(mp):
            continue
        meta = json.load(open(mp))
        jobs.append((mk, meta["chain"], meta["pool"], [A.T_LIQ], meta["pool_deploy_block"]))
    for ch in ("ethereum", "base"):
        jobs.append((f"morpho-{ch}", ch, M.MORPHO, [M.T_LIQ], M.DEPLOY[ch]))
    for ch in ("ethereum", "arbitrum", "base", "optimism"):
        mp = os.path.join(work, f"comet-{ch}", "meta.json")
        if not os.path.exists(mp):
            continue
        meta = json.load(open(mp))
        for cm, v in meta["comets"].items():
            jobs.append((f"comet-{ch}-{cm[:8]}", ch, cm, [[C.T_ABSC, C.T_BUYC]], v["deploy"]))
    for name, ch, addr, tps, frm in jobs:
        fetch(name, ch, addr, tps, frm, end_blocks[ch], os.path.join(d, f"{name}.json.gz"))
