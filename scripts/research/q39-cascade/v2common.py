"""Shared helpers for the 2021-22 aid-test engines (aavev2.py, compv2.py).

Multicall3 (0xcA11...CA11) was deployed on Ethereum at block 14353601 (2022-03-09), after most of the
2021-22 snapshot days. `multicall` here runs the same Multicall3.tryAggregate call as rpc.Client.multicall
but passes Multicall3's runtime bytecode as an eth_call state override, so the identical aggregator works at
any archive block (all five keyless Ethereum endpoints in rpc.ENDPOINTS accept the third eth_call parameter;
probed 2026-10-18 at block 11600000). The override only places code at the aggregator address; every
target contract is read from real archive state.
"""
from __future__ import annotations

import rpc
from rpc import MULTICALL3, Client, Reverted, RpcError, words

_CODE: dict[str, str] = {}


def _code(c: Client) -> str:
    if c.chain not in _CODE:
        _CODE[c.chain] = c.call("eth_getCode", [MULTICALL3, "latest"], need_state=True)
    return _CODE[c.chain]


def multicall(c: Client, calls: list[tuple[str, str]], block: int, chunk=150) -> list[bytes | None]:
    """Multicall3.tryAggregate(false, calls) at `block` with Multicall3 code overridden in. Raw bytes or None."""
    out: list[bytes | None] = []
    for i in range(0, len(calls), chunk):
        part = calls[i:i + chunk]
        data = rpc._encode_try_aggregate(part)
        try:
            res = c.call("eth_call", [{"to": MULTICALL3, "data": data}, hex(block), {MULTICALL3: {"code": _code(c)}}],
                         need_state=True)
            out.extend(rpc._decode_try_aggregate(res))
        except (RpcError, Reverted, ValueError, IndexError):
            if len(part) == 1:
                out.append(None)
                continue
            half = max(1, len(part) // 2)
            out.extend(multicall(c, part[:half], block, half))
            out.extend(multicall(c, part[half:], block, half))
    return out


def w0(b: bytes | None):
    return words(b)[0] if b else None


S_BLOCK_TS = rpc.selector("getCurrentBlockTimestamp()")
CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"
S_LATEST_ANSWER = rpc.selector("latestAnswer()")


def log_ts(c: Client, lg: dict, cache: dict) -> int:
    """Block timestamp of a log: the `blockTimestamp` log field when the endpoint serves it, else one
    eth_getBlockByNumber per distinct block (cached)."""
    if lg.get("blockTimestamp"):
        return int(lg["blockTimestamp"], 16)
    b = int(lg["blockNumber"], 16)
    if b not in cache:
        cache[b] = c.block_ts(b)
    return cache[b]
