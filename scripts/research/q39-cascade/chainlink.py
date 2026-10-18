"""Chainlink ETH/USD and BTC/USD rounds on Ethereum mainnet, every aggregator phase (prereg C.2.3, C.3.3).

AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt) on each phase aggregator
from phaseAggregators(phaseId). Output CSV: updatedAt,answer,phase,aggRoundId,block.
"""
from __future__ import annotations

import csv
import gzip
import os

from rpc import Client, selector, signed, to_addr, topic, words

PROXIES = {"eth-usd": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
           "btc-usd": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c"}
T_ANS = topic("AnswerUpdated(int256,uint256,uint256)")


def fetch(feed: str, out: str, from_block: int, to_block: int):
    if os.path.exists(out):
        return
    c = Client("ethereum")
    px = PROXIES[feed]
    ph = words(c.eth_call(px, selector("phaseId()")))[0]
    rows = []
    for p in range(1, ph + 1):
        agg = to_addr(words(c.eth_call(px, selector("phaseAggregators(uint16)") + hex(p)[2:].rjust(64, "0")))[0])
        if int(agg, 16) == 0:
            continue
        logs = c.get_logs(agg, [T_ANS], from_block, to_block, step=1_000_000)
        for lg in logs:
            rows.append((int(lg["data"], 16), signed(int(lg["topics"][1], 16)), p, int(lg["topics"][2], 16),
                         int(lg["blockNumber"], 16)))
        print(feed, "phase", p, agg, len(logs), flush=True)
    rows.sort()
    tmp = out + ".tmp"
    with gzip.open(tmp, "wt", newline="") as f:
        w = csv.writer(f)
        w.writerow(["updatedAt", "answer", "phase", "aggRoundId", "block"])
        w.writerows(rows)
    os.replace(tmp, out)


def load(path):
    import numpy as np
    ts, ans = [], []
    with gzip.open(path, "rt") as f:
        r = csv.DictReader(f)
        for row in r:
            ts.append(int(row["updatedAt"]))
            ans.append(int(row["answer"]) / 1e8)
    return np.array(ts), np.array(ans)
