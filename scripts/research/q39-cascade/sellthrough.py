"""Sell-through of seized collateral (prereg C.2.2), measured from transaction receipts.

For one liquidation (or Comet buyCollateral) transaction, the seized class X (E or B) is sold in the same
transaction when X-class tokens flow into an address that is a net X receiver AND a net payer of non-X
("O") tokens in that transaction: a swap counterparty (AMM pool, V4 pool manager, RFQ maker). Routers and
liquidator contracts net out to zero X and are not counted; the lending protocol is a net X payer.
sold = sum over such addresses of their net X inflow, in ETH- (or BTC-) equivalents at the day's lender
oracle prices; sell-through = min(1, sold / seized). Native-ETH legs (unwrapped WETH) are not visible in
logs and count as unsold (stated limit C.11).
Development-span sample: seed 20261018, up to N_PER_VENUE transactions per venue (decision D-Q39-4).
"""
from __future__ import annotations

import json
import os
import random
from concurrent.futures import ThreadPoolExecutor

from classes import asset_class
from rpc import Client, Reverted, RpcError, topic, words
import aave as _a

T_TRANSFER = topic("Transfer(address,address,uint256)")
SEED = 20261018
N_PER_VENUE = 1500


class TokenBook:
    def __init__(self, chain: str, cache_path: str):
        self.c = Client(chain)
        self.path = cache_path
        self.d = json.load(open(cache_path)) if os.path.exists(cache_path) else {}

    def info(self, tok: str):
        tok = tok.lower()
        if tok not in self.d:
            try:
                sym = _a._decode_string(self.c.eth_call(tok, "0x95d89b41"))
            except (Reverted, RpcError, ValueError, UnicodeDecodeError):
                sym = "?"
            try:
                dec = words(self.c.eth_call(tok, "0x313ce567"))[0]
            except (Reverted, RpcError, ValueError, IndexError):
                dec = 18
            self.d[tok] = {"sym": sym, "dec": dec if dec < 80 else 18}
        return self.d[tok]

    def save(self):
        json.dump(self.d, open(self.path, "w"))


def measure(receipt: dict, cls: str, chain: str, book: TokenBook, ratio: dict) -> float:
    """Units of cls-equivalent (ETH or BTC) sold to swap counterparties in this receipt."""
    netX: dict[str, float] = {}
    netO: dict[str, float] = {}
    for lg in receipt["logs"]:
        tp = lg["topics"]
        if not tp or tp[0] != T_TRANSFER or len(tp) != 3 or lg["data"] in ("0x", ""):
            continue
        tok = lg["address"].lower()
        info = book.info(tok)
        k = asset_class(chain, info["sym"])
        amt = int(lg["data"][:66], 16) / 10 ** info["dec"]
        fr, to = "0x" + tp[1][-40:], "0x" + tp[2][-40:]
        if k == cls:
            x = amt * ratio.get(tok, 1.0)
            netX[fr] = netX.get(fr, 0.0) - x
            netX[to] = netX.get(to, 0.0) + x
        elif k == "O":
            netO[fr] = netO.get(fr, 0.0) - 1.0   # any outflow of a non-X token marks a payer
            netO[to] = netO.get(to, 0.0) + 1.0
    sold = 0.0
    zero = "0x" + "0" * 40
    for a, x in netX.items():
        if a == zero or x <= 1e-12:
            continue
        if netO.get(a, 0.0) < 0:
            sold += x
    return sold


def sample(events: list[dict], n=N_PER_VENUE, seed=SEED) -> list[dict]:
    """Seeded sample of distinct transactions (events sorted by (block, logIndex) first)."""
    by_tx = {}
    for e in sorted(events, key=lambda e: (e["block"], e["logIndex"])):
        by_tx.setdefault(e["tx"], []).append(e)
    txs = sorted(by_tx)
    rnd = random.Random(seed)
    pick = txs if len(txs) <= n else sorted(rnd.sample(txs, n))
    return [{"tx": t, "events": by_tx[t]} for t in pick]


def run(chain: str, items: list[dict], book: TokenBook, out_path: str, threads=6):
    """items: [{tx, cls, seized_units (cls-equivalent), day_ratio: {token: ratio}}]. Appends results (resumable)."""
    done = {}
    if os.path.exists(out_path):
        for line in open(out_path):
            r = json.loads(line)
            done[r["tx"]] = r
    todo = [it for it in items if it["tx"] not in done]
    c = Client(chain)

    def one(it):
        rc = None
        for _ in range(4):
            try:
                rc = c.call("eth_getTransactionReceipt", [it["tx"]], need_logs=True)
            except RpcError as e:
                return {"tx": it["tx"], "error": str(e)[:200]}
            if rc:
                break
        if not rc:
            return {"tx": it["tx"], "error": "null receipt x4"}
        sold = measure(rc, it["cls"], chain, book, it.get("ratio", {}))
        return {"tx": it["tx"], "cls": it["cls"], "seized": it["seized"], "sold": sold,
                "st": min(1.0, sold / it["seized"]) if it["seized"] > 0 else None, "block": it["block"]}

    with open(out_path, "a") as f, ThreadPoolExecutor(threads) as ex:
        for i, r in enumerate(ex.map(one, todo)):
            f.write(json.dumps(r) + "\n")
            if i % 200 == 0:
                f.flush()
                book.save()
    book.save()
