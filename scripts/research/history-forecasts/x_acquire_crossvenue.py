#!/usr/bin/env python3
"""Q26 cross-venue deposit histories: every USDC/USDT/USDS/DAI lending receipt token with max monthly
TVL >= $25M, its event logs for the depositor-events address universe, share-balance paths, daily share
prices, monthly balance anchors and a reconstruction gate.

Data acquisition only. It computes no outcome: no withdrawal rates, no exit counts and no lead/lag
statistics between venues. The gate compares reconstructed balances with on-chain balances.

Phases, each resumable from the work directory (checkpoints are JSONL / gz CSV):
  preflight  inputs (roster, universe, snapshot blocks) and their sha256, topic0 self-check, asof block on
             both endpoints, token sanity reads (decimals, underlying, Aave pool) at the asof block
  tvl        TVL in USD of every roster token at the 45 monthly blocks (Multicall3 aggregate3); the
             selection (max monthly TVL >= $25M) and tvl-monthly.csv / selected-tokens.csv are written
             to the output directory before any log is fetched
  deploy     exact deployment block of each selected token (eth_getCode check or bisection)
  logs       eth_getLogs, deployment -> asof, ranges <= 50,000 blocks sized to the token's log density,
             split in half on error down to 1,000 blocks, <= 2 requests/s, one checkpoint per range
  prices     daily share price of every selected token (one multicall per daily block + the asof blocks;
             Comet also at pre-panel blocks for the principal conversion)
  codes      eth_getCode at the asof block for every universe address
  nesting    balances of roster tokens held by the selected tokens and by Morpho V2 adapters
  decode     per-family decode, universe filter, share-balance paths at every snapshot
  anchors    on-chain balances (roster method) at the 45 monthly blocks + both asof blocks for every
             (universe address, selected token) whose share path is ever nonzero
  comet      daily Comet balanceOf for every Comet pair (Comet principal and present value differ)
  gate       the reconstruction gate per token and per family
  write      output files, gate-report.json, run-log.json, PROVENANCE.md

Usage:
  python3 x_acquire_crossvenue.py --work-dir DIR --roster tokens_verified.csv [--out-dir DIR] --phases p1,p2

RPC: eth_call / eth_getCode on https://eth.drpc.org (<= 4 req/s); eth_getLogs on https://rpc.mevblocker.io
(<= 2 req/s). Rate limit: wait 30 s, at most 5 retries, then stop.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import datetime as dt
import gzip
import heapq
import http.client
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import b_acquire as B  # noqa: E402  (state RPC client, multicall encode/decode, keccak, JSONL store)
import g_acquire_events as G  # noqa: E402  (eth_getLogs client, range splitting, log checkpoints, ray math)

# ---------------------------------------------------------------------------------------------
# Fixed parameters
# ---------------------------------------------------------------------------------------------

DATASET = "cross-venue"
LOGS_RPC_URL = G.LOGS_RPC_URL                # https://rpc.mevblocker.io
STATE_RPC_URL = B.RPC_URL                    # https://eth.drpc.org
USER_AGENT = B.USER_AGENT
MULTICALL3 = B.MULTICALL3

UNIVERSE_REL = "depositor-events/extended-universe.csv"
BLOCKS_REL = "depositor-balances/blocks.csv"
ASOF_LOGS = 26_186_746          # depositor-events asof (logs and paths run to here)
ASOF_B1 = 26_180_400            # depositor-balances asof (blocks.csv)
EXCLUDED = {  # Aave V3 Core aEthUSDC / aEthUSDT: covered by depositor-events
    "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c": "aEthUSDC (Aave V3 Core)",
    "0x23878914efe38d27c4d67ab83ed1b93a74d4086a": "aEthUSDT (Aave V3 Core)",
}
TVL_MIN_USD = 25_000_000
USD_PER_UNIT = 1.0              # USDC, USDT, USDS and DAI are all counted at $1
SMALL_TOKEN_LOGS = 50_000       # tokens with fewer logs keep every log
GATE_ABS_USD = 10
GATE_REL_NUM, GATE_REL_DEN = 5, 1000   # 0.5% of the anchor
GATE_SHARE = 0.99

RANGE_MAX = G.RANGE_MAX         # 50,000 blocks
RANGE_MIN = G.RANGE_MIN         # 1,000 blocks
LOGS_INTERVAL_S = G.LOGS_INTERVAL_S   # <= 2 requests/s over all log workers
LOGS_WORKERS = 4
TARGET_LOGS_PER_RANGE = 6_000   # the endpoint caps a response at 10,000 logs for ranges > 10,000 blocks
MIN_SIZE_RETRIES = 5            # an error at the minimum range size: wait 30 s and retry, then stop
RETRY_WAIT_S = 30
MAX_RETRIES = 5

STATE_WORKERS = 4
MAX_CALLS = 1000                # per multicall (light calls)
MAX_CALLS_HEAVY = 200           # per multicall: convertToAssets / totalAssets of vaults
COMET_PREPANEL_STEP = 7_200     # Comet index reads before the first daily snapshot, one per ~day
OUT_FILE_MAX_BYTES = 49 * 10**6

RAY = G.RAY
COMET_INDEX_SCALE = 10**15


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------


def token_kind(family: str, method: str) -> str:
    m = method.lower()
    if m.startswith("converttoassets"):
        return "erc4626"
    if "exchangeratestored" in m:
        return "ctoken"
    if "supply base" in m:
        return "comet"
    if "rebasing" in m:
        return "atoken_v2" if family in ("AaveV2", "AaveV2-AMM") else "atoken_v3"
    raise ValueError(f"unknown method {method!r}")


def parse_bracket(precision: str) -> tuple[int, int] | None:
    p = precision.strip()
    if p.startswith("bracket(") and p.endswith(")"):
        lo, hi = p[len("bracket("):-1].split("..")
        return int(lo), int(hi)
    return None


def load_roster(path: Path) -> list[dict]:
    out = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            a = B.norm_address(r["address"])
            out.append({"family": r["family"], "symbol": r["symbol"], "name": r["name"], "address": a,
                        "dec": int(r["token_dec"]), "underlying": B.norm_address(r["underlying"]),
                        "udec": int(r["udec"]), "method": r["method"], "kind": token_kind(r["family"], r["method"]),
                        "deploy_block": int(r["deploy_block"]), "deploy_precision": r["deploy_precision"],
                        "excluded": a in EXCLUDED})
    if len({t["address"] for t in out}) != len(out):
        raise B.TerminalError("duplicate roster address")
    return out


def load_universe(path: Path) -> dict[str, set[str]]:
    """address -> set of reserves (USDC / USDT) it is a universe member of."""
    U: dict[str, set[str]] = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            U.setdefault(B.norm_address(r["address"]), set()).add(r["reserve"])
    return U


def load_blocks(path: Path) -> dict:
    daily, monthly, asof = [], [], None
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["kind"] == "daily":
                row = (r["snapshot"], int(r["block"]), int(r["block_ts"]))
                daily.append(row)
                if r["monthly"] == "1":
                    monthly.append(row)
            elif r["kind"] == "asof":
                asof = (int(r["block"]), int(r["block_ts"]))
    if asof is None or asof[0] != ASOF_B1:
        raise B.TerminalError(f"blocks.csv asof {asof} != {ASOF_B1}")
    if any(b2[1] <= b1[1] for b1, b2 in zip(daily, daily[1:])):
        raise B.TerminalError("daily blocks not increasing")
    return {"daily": daily, "monthly": monthly, "asof_b1": asof}


def snapshot_list(blocks: dict) -> list[tuple[str, int]]:
    """Every snapshot (label, block), increasing: the daily blocks, then asof_b1 and asof."""
    snaps = [(d, b) for d, b, _ in blocks["daily"]]
    snaps.append(("asof_b1", ASOF_B1))
    snaps.append(("asof", ASOF_LOGS))
    return snaps


def anchor_labels(blocks: dict) -> list[tuple[str, int]]:
    return [(d, b) for d, b, _ in blocks["monthly"]] + [("asof_b1", ASOF_B1), ("asof", ASOF_LOGS)]


# ---------------------------------------------------------------------------------------------
# ABI
# ---------------------------------------------------------------------------------------------

FN = {
    "totalAssets": "totalAssets()", "totalSupply": "totalSupply()", "decimals": "decimals()",
    "exchangeRateStored": "exchangeRateStored()", "convertToAssets": "convertToAssets(uint256)",
    "balanceOf": "balanceOf(address)", "scaledBalanceOf": "scaledBalanceOf(address)",
    "asset": "asset()", "UNDERLYING_ASSET_ADDRESS": "UNDERLYING_ASSET_ADDRESS()", "POOL": "POOL()",
    "getReserveNormalizedIncome": "getReserveNormalizedIncome(address)", "baseToken": "baseToken()",
    "underlying": "underlying()", "totalsBasic": "totalsBasic()", "userBasic": "userBasic(address)",
    "adaptersLength": "adaptersLength()", "adapters": "adapters(uint256)",
}
FSEL = {k: B.selector(v) for k, v in FN.items()}


def enc_arg(x) -> bytes:
    if isinstance(x, str):
        return B.enc_address(x)
    return B.enc_word(int(x))


def cdata(fn: str, *args) -> bytes:
    return FSEL[fn] + b"".join(enc_arg(a) for a in args)


def u256(ok: bool, ret: bytes) -> tuple[int | None, str]:
    """(value, status): status ok / empty (no code or no return data) / fail (reverted) / bad."""
    if not ok:
        return None, "fail"
    if len(ret) == 0:
        return None, "empty"
    if len(ret) < 32:
        return None, "bad"
    return int.from_bytes(ret[:32], "big"), "ok"


def s256(w: int) -> int:
    return w - (1 << 256) if w >> 255 else w


def addr_word(ok: bool, ret: bytes) -> str | None:
    v, st = u256(ok, ret)
    if st != "ok" or v >> 160:
        return None
    return "0x" + v.to_bytes(20, "big").hex()


# ---------------------------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------------------------


def t0(sig: str) -> str:
    return "0x" + B.keccak256(sig.encode()).hex()


SIG = {
    "Transfer": "Transfer(address,address,uint256)",
    "Approval": "Approval(address,address,uint256)",
    "Deposit": "Deposit(address,address,uint256,uint256)",                       # ERC-4626
    "Withdraw": "Withdraw(address,address,address,uint256,uint256)",             # ERC-4626
    "MintV3": "Mint(address,address,uint256,uint256,uint256)",                   # Aave V3 aToken
    "BurnV3": "Burn(address,address,uint256,uint256,uint256)",
    "BalanceTransfer": "BalanceTransfer(address,address,uint256,uint256)",       # Aave V2 and V3
    "MintV2": "Mint(address,uint256,uint256)",                                   # Aave V2 aToken / cToken Mint
    "BurnV2": "Burn(address,address,uint256,uint256)",
    "Supply": "Supply(address,address,uint256)",                                 # Comet
    "CometWithdraw": "Withdraw(address,address,uint256)",
    "Redeem": "Redeem(address,uint256,uint256)",                                 # cToken
    "Mint4": "Mint(address,uint256,uint256,uint256)",                            # Venus VToken
    "Redeem4": "Redeem(address,uint256,uint256,uint256)",
}
T = {k: t0(v) for k, v in SIG.items()}
# Canonical topic0 values (self-check of the keccak implementation and the signature strings)
KNOWN_TOPIC0 = {
    "Transfer": "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    "Approval": "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    "Deposit": "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7",
    "Withdraw": "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db",
}

# Non-balance events, labelled so that `unknown` means "not recognised" (counts are recorded either way)
OTHER_SIGS = [
    "Approval(address,address,uint256)", "OwnershipTransferred(address,address)",
    "OwnershipTransferStarted(address,address)", "Upgraded(address)",
    "AdminChanged(address,address)", "BeaconUpgraded(address)", "Initialized(uint8)", "Initialized(uint64)",
    "Paused(address)", "Unpaused(address)", "RoleGranted(bytes32,address,address)",
    "RoleRevoked(bytes32,address,address)", "RoleAdminChanged(bytes32,bytes32,bytes32)", "EIP712DomainChanged()",
    "Initialized(address,address,address,address,uint8,string,string,bytes)",
    # MetaMorpho (Morpho V1 vaults)
    "AccrueInterest(uint256,uint256)", "UpdateLastTotalAssets(uint256)",
    "ReallocateSupply(address,bytes32,uint256,uint256)", "ReallocateWithdraw(address,bytes32,uint256,uint256)",
    "SetCap(address,bytes32,uint256)", "SubmitCap(address,bytes32,uint256)", "SetSupplyQueue(address,bytes32[])",
    "SetWithdrawQueue(address,bytes32[])", "SetFee(address,uint256)", "SetFeeRecipient(address)",
    "SetCurator(address)", "SetIsAllocator(address,bool)", "SetGuardian(address,address)", "SubmitGuardian(address)",
    "SetTimelock(address,uint256)", "SubmitTimelock(uint256)", "SetSkimRecipient(address)",
    "Skim(address,address,uint256)", "SubmitMarketRemoval(address,bytes32)", "RevokePendingCap(address,bytes32)",
    "RevokePendingTimelock(address)", "RevokePendingGuardian(address)",
    "RevokePendingMarketRemoval(address,bytes32)", "SetName(string)", "SetSymbol(string)",
    "UpdateLostAssets(uint256)",
    # Sky / Spark savings
    "Drip(uint256,uint256)", "Referral(uint16,address,uint256,uint256)", "File(bytes32,uint256)",
    "Rely(address)", "Deny(address)",
    # Comet
    "SupplyCollateral(address,address,address,uint256)", "WithdrawCollateral(address,address,address,uint256)",
    "TransferCollateral(address,address,address,uint256)", "AbsorbDebt(address,address,uint256,uint256)",
    "AbsorbCollateral(address,address,address,uint256,uint256)", "BuyCollateral(address,address,uint256,uint256)",
    "PauseAction(bool,bool,bool,bool,bool)", "WithdrawReserves(address,uint256)",
    # Compound V2 / Venus
    "AccrueInterest(uint256,uint256,uint256,uint256)", "AccrueInterest(uint256,uint256,uint256)",
    "Borrow(address,uint256,uint256,uint256)", "RepayBorrow(address,address,uint256,uint256,uint256)",
    "LiquidateBorrow(address,address,uint256,address,uint256)", "ReservesAdded(address,uint256,uint256)",
    "ReservesReduced(address,uint256,uint256)", "NewReserveFactor(uint256,uint256)",
    "NewMarketInterestRateModel(address,address)", "NewComptroller(address,address)", "NewAdmin(address,address)",
    "NewPendingAdmin(address,address)", "NewImplementation(address,address)", "Failure(uint256,uint256,uint256)",
]
OTHER_TOPIC0 = {}
for _s in OTHER_SIGS:
    OTHER_TOPIC0.setdefault(t0(_s), _s.split("(")[0])

# Per kind: topic0 -> decoder name. Balance-carrying types are listed in BALANCE_TYPES.
DECODERS = {
    "erc4626": {T["Transfer"]: "Transfer", T["Deposit"]: "Deposit", T["Withdraw"]: "Withdraw"},
    "atoken_v3": {T["MintV3"]: "MintV3", T["BurnV3"]: "BurnV3", T["BalanceTransfer"]: "BalanceTransferV3",
                  T["Transfer"]: "TransferInfo"},
    "atoken_v2": {T["MintV2"]: "MintV2", T["BurnV2"]: "BurnV2", T["BalanceTransfer"]: "BalanceTransferV2",
                  T["Transfer"]: "TransferInfo"},
    "comet": {T["Transfer"]: "Transfer", T["Supply"]: "Supply", T["CometWithdraw"]: "CometWithdraw"},
    "ctoken": {T["Transfer"]: "Transfer", T["MintV2"]: "CMint", T["Redeem"]: "CRedeem",
               T["Mint4"]: "CMint", T["Redeem4"]: "CRedeem"},
}
BALANCE_TYPES = {"erc4626": {"Transfer"}, "comet": {"Transfer"}, "ctoken": {"Transfer"},
                 "atoken_v3": {"MintV3", "BurnV3", "BalanceTransferV3"},
                 "atoken_v2": {"MintV2", "BurnV2", "BalanceTransferV2"}}


class DecodeError(Exception):
    pass


ZERO24 = "0" * 24


def topic_addr(t: str) -> str:
    if len(t) != 66 or t[2:26] != ZERO24:
        raise DecodeError(f"not an address topic {t[:20]}")
    return "0x" + t[26:]


def data_words(data: str, n: int | None = None) -> list[int]:
    d = data[2:]
    if len(d) % 64:
        raise DecodeError(f"data length {len(d)}")
    if n is not None and len(d) != 64 * n:
        raise DecodeError(f"data words {len(d) // 64} != {n}")
    return [int(d[i:i + 64], 16) for i in range(0, len(d), 64)]


def word_addr(w: int) -> str:
    if w >> 160:
        raise DecodeError("address word with high bits")
    return "0x" + w.to_bytes(20, "big").hex()


def names_universe(topics: list[str], data: str, U) -> bool:
    """True if an indexed topic or a data word is an address of U."""
    for t in topics[1:]:
        if len(t) == 66 and t[2:26] == ZERO24 and ("0x" + t[26:]) in U:
            return True
    d = data[2:]
    for i in range(0, len(d) - 63, 64):
        if d[i:i + 24] == ZERO24 and ("0x" + d[i + 24:i + 64]) in U:
            return True
    return False


def decode_event(kind: str, topics: list[str], data: str) -> dict:
    """Decode one log of a token of `kind`.

    Returns {type, parties [<=3], values [<=3], deltas [(address, delta_raw, scaled_or_None)]}.
    delta_raw is the change of the holder's balance in the token's own balance unit as the event states it
    (shares for ERC-4626 and cTokens, underlying for aTokens per depositor-events G.2, present value for
    Comet); scaled is the change in share units (aToken scaled balance; ERC-4626 / cToken shares; None for
    Comet, whose principal needs the supply index)."""
    if not topics:
        raise DecodeError("no topics")
    name = DECODERS[kind].get(topics[0])
    if name is None:
        other = OTHER_TOPIC0.get(topics[0])
        parties = []
        for t in topics[1:]:
            if len(t) == 66 and t[2:26] == ZERO24:
                parties.append("0x" + t[26:])
        try:
            vals = data_words(data)[:3]
        except DecodeError:
            vals = []
        return {"type": other or "unknown", "parties": parties[:3], "values": vals, "deltas": [],
                "known": other is not None}
    ev = {"type": name, "parties": [], "values": [], "deltas": [], "known": True}
    if name in ("Transfer", "TransferInfo"):
        if len(topics) != 3:
            raise DecodeError(f"Transfer with {len(topics)} topics")
        frm, to = topic_addr(topics[1]), topic_addr(topics[2])
        (v,) = data_words(data, 1)
        ev.update(parties=[frm, to], values=[v])
        if name == "Transfer":
            ev["deltas"] = [(frm, -v, None if kind == "comet" else -v), (to, v, None if kind == "comet" else v)]
    elif name == "Deposit":
        if len(topics) != 3:
            raise DecodeError("Deposit topics")
        assets, shares = data_words(data, 2)
        ev.update(parties=[topic_addr(topics[1]), topic_addr(topics[2])], values=[assets, shares])
    elif name == "Withdraw":
        if len(topics) != 4:
            raise DecodeError("Withdraw topics")
        assets, shares = data_words(data, 2)
        ev.update(parties=[topic_addr(topics[1]), topic_addr(topics[2]), topic_addr(topics[3])],
                  values=[assets, shares])
    elif name == "MintV3":
        if len(topics) != 3:
            raise DecodeError("MintV3 topics")
        caller, on_behalf = topic_addr(topics[1]), topic_addr(topics[2])
        v, bi, idx = data_words(data, 3)
        if idx == 0:
            raise DecodeError("Mint index 0")
        ev.update(parties=[on_behalf, caller], values=[v, bi, idx],
                  deltas=[(on_behalf, v - bi, G.signed_ray_div(v - bi, idx))])
    elif name == "BurnV3":
        if len(topics) != 3:
            raise DecodeError("BurnV3 topics")
        frm, target = topic_addr(topics[1]), topic_addr(topics[2])
        v, bi, idx = data_words(data, 3)
        if idx == 0:
            raise DecodeError("Burn index 0")
        ev.update(parties=[frm, target], values=[v, bi, idx], deltas=[(frm, -(v + bi), -G.ray_div(v + bi, idx))])
    elif name == "BalanceTransferV3":
        if len(topics) != 3:
            raise DecodeError("BalanceTransfer topics")
        frm, to = topic_addr(topics[1]), topic_addr(topics[2])
        v, idx = data_words(data, 2)
        amt = G.ray_mul(v, idx)
        ev.update(parties=[frm, to], values=[v, idx], deltas=[(frm, -amt, -v), (to, amt, v)])
    elif name == "MintV2":
        if len(topics) != 2:
            raise DecodeError("MintV2 topics")
        frm = topic_addr(topics[1])
        v, idx = data_words(data, 2)
        if idx == 0:
            raise DecodeError("Mint index 0")
        ev.update(parties=[frm], values=[v, idx], deltas=[(frm, v, G.ray_div(v, idx))])
    elif name == "BurnV2":
        if len(topics) != 3:
            raise DecodeError("BurnV2 topics")
        frm, target = topic_addr(topics[1]), topic_addr(topics[2])
        v, idx = data_words(data, 2)
        if idx == 0:
            raise DecodeError("Burn index 0")
        ev.update(parties=[frm, target], values=[v, idx], deltas=[(frm, -v, -G.ray_div(v, idx))])
    elif name == "BalanceTransferV2":
        if len(topics) != 3:
            raise DecodeError("BalanceTransfer topics")
        frm, to = topic_addr(topics[1]), topic_addr(topics[2])
        v, idx = data_words(data, 2)
        if idx == 0:
            raise DecodeError("BalanceTransfer index 0")
        sc = G.ray_div(v, idx)
        ev.update(parties=[frm, to], values=[v, idx], deltas=[(frm, -v, -sc), (to, v, sc)])
    elif name in ("Supply", "CometWithdraw"):
        if len(topics) != 3:
            raise DecodeError(f"{name} topics")
        (v,) = data_words(data, 1)
        ev.update(parties=[topic_addr(topics[1]), topic_addr(topics[2])], values=[v])
    elif name in ("CMint", "CRedeem"):
        if len(topics) != 1:
            raise DecodeError(f"{name} topics")
        w = data_words(data)
        if len(w) not in (3, 4):
            raise DecodeError(f"{name} data words {len(w)}")
        ev.update(parties=[word_addr(w[0])], values=w[1:4])
    else:  # pragma: no cover
        raise DecodeError(f"no decoder {name}")
    return ev


def check_signatures() -> dict:
    out = {"known_match": {k: T[k] == v for k, v in KNOWN_TOPIC0.items()},
           "topic0": {SIG[k]: v for k, v in T.items()}, "g_self_check": G.check_signatures()["ok"]}
    out["ok"] = all(out["known_match"].values()) and out["g_self_check"]
    return out


# ---------------------------------------------------------------------------------------------
# Share-balance paths
# ---------------------------------------------------------------------------------------------


class PathBuilder:
    """Running share balances of tracked addresses; at every snapshot (label, block) the balances after all
    events in blocks <= block. emit(label, address, shares) is called at the first snapshot after a change
    (change points only; an address absent before its first emission held 0)."""

    def __init__(self, snaps: list[tuple[str, int]], tracked, emit):
        self.snaps = snaps
        self.tracked = tracked
        self.emit = emit
        self.bal: dict[str, int] = {}
        self.last: dict[str, int] = {}
        self.changed: set[str] = set()
        self.ever: set[str] = set()
        self.neg: set[str] = set()
        self.si = 0
        self.last_block = -1

    def advance(self, block: int) -> None:
        if block < self.last_block:
            raise ValueError(f"events out of order: {block} < {self.last_block}")
        self.last_block = block
        while self.si < len(self.snaps) and self.snaps[self.si][1] < block:
            label = self.snaps[self.si][0]
            for a in sorted(self.changed):
                v = self.bal[a]
                if self.last.get(a, 0) != v:
                    self.emit(label, a, v)
                    self.last[a] = v
            self.changed.clear()
            self.si += 1

    def apply(self, block: int, address: str, delta: int) -> None:
        if self.tracked is not None and address not in self.tracked:
            return
        self.advance(block)
        v = self.bal.get(address, 0) + delta
        self.bal[address] = v
        self.changed.add(address)
        if v != 0:
            self.ever.add(address)
        if v < 0:
            self.neg.add(address)

    def finish(self) -> None:
        self.advance(1 << 62)


def path_lookup(points: list[tuple[int, int]], snap_index: int) -> int:
    """points = [(snapshot index, shares)] increasing; the value in force at snap_index (0 before)."""
    i = bisect.bisect_right(points, (snap_index, float("inf"))) - 1
    return points[i][1] if i >= 0 else 0


def interp_index(blocks: list[int], values: list[float], b: int) -> float:
    """Linear interpolation of an index in block number (clamped at the ends)."""
    i = bisect.bisect_right(blocks, b) - 1
    if i < 0:
        return values[0]
    if i >= len(blocks) - 1:
        return values[-1]
    b0, b1 = blocks[i], blocks[i + 1]
    if b == b0:
        return values[i]
    return values[i] + (values[i + 1] - values[i]) * (b - b0) / (b1 - b0)


def underlying_from_shares(kind: str, shares: int, price: dict) -> int | None:
    """Reconstructed underlying (raw) = shares x the day's price."""
    if price is None:
        return None
    if kind == "erc4626":
        return shares * price["assets"] // price["probe"]
    if kind in ("atoken_v2", "atoken_v3"):
        return G.ray_mul(shares, price["income"]) if shares >= 0 else -G.ray_mul(-shares, price["income"])
    if kind == "ctoken":
        return shares * price["rate"] // 10**18
    if kind == "comet":
        return int(round(shares * price["index"] / COMET_INDEX_SCALE))
    raise ValueError(kind)


# ---------------------------------------------------------------------------------------------
# Gate math
# ---------------------------------------------------------------------------------------------


def gate_pass(recon: int, anchor: int, udec: int) -> bool:
    """|recon - anchor| <= max($10, 0.5% of anchor), exact in integers."""
    diff = abs(recon - anchor)
    return diff <= GATE_ABS_USD * 10**udec or diff * GATE_REL_DEN <= GATE_REL_NUM * abs(anchor)


def gate_summary(rows: list[dict]) -> dict:
    n = len(rows)
    k = sum(1 for r in rows if r["pass"])
    return {"n": n, "pass": k, "share": (k / n) if n else None, "passes": (k / n >= GATE_SHARE) if n else None}


# ---------------------------------------------------------------------------------------------
# State RPC with soft failures (a multicall that errors is split instead of stopping the run)
# ---------------------------------------------------------------------------------------------


class SoftFail(Exception):
    pass


class StateRpc(B.Rpc):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.counts.update({"soft_failures": 0, "multicall_splits": 0})

    def call_soft(self, method: str, params: list, phase: str, tag: str = "", validate=None, transient_max: int = 2):
        """Like call(), but a non-rate-limit error raises SoftFail (no stop); transient errors are retried
        transient_max times first. Rate limits follow the stop policy (30 s, <= 5 retries)."""
        with self.lock:
            self._id += 1
            rid = self._id
        payload = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode()
        rl, tr = 0, 0
        while True:
            if self.stop.is_set():
                raise B.TerminalError("stopped")
            self.pacer.wait()
            with self.lock:
                self.counts["http_requests"] += 1
                self.counts["by_method"][method] = self.counts["by_method"].get(method, 0) + 1
                self.counts["by_phase"][phase] = self.counts["by_phase"].get(phase, 0) + 1
            try:
                t_0 = time.monotonic()
                try:
                    body = self._post(payload)
                finally:
                    with self.lock:
                        self.counts["seconds_in_requests"] += time.monotonic() - t_0
                if not isinstance(body, dict):
                    raise B.Transient("unexpected body")
                if body.get("error") is not None:
                    err = body["error"]
                    kind = B.classify_rpc_error(err if isinstance(err, dict) else {"message": str(err)})
                    raise kind(f"rpc error {json.dumps(err)[:300]}")
                if "result" not in body:
                    raise B.Transient("no result field")
                if validate is not None:
                    try:
                        validate(body["result"])
                    except B.DecodeError as e:
                        raise B.Transient(f"decode: {e}")
                return body["result"]
            except B.RateLimited as e:
                rl += 1
                if rl > self.max_retries:
                    with self.lock:
                        self.counts["failures"] += 1
                    self.log_event({"type": "failure", "kind": "rate_limit", "phase": phase, "tag": tag,
                                    "error": str(e)[:300]})
                    self.stop.set()
                    raise B.TerminalError(f"rate limit after {self.max_retries} retries: {e}")
                with self.lock:
                    self.counts["retries"] += 1
                    self.counts["rate_limit_retries"] += 1
                self.log_event({"type": "retry", "kind": "rate_limit", "phase": phase, "tag": tag, "attempt": rl,
                                "error": str(e)[:300], "wait_s": self.retry_wait})
                self.pacer.pause(self.retry_wait)
                self.sleep(self.retry_wait)
            except B.Transient as e:
                tr += 1
                if tr > transient_max:
                    with self.lock:
                        self.counts["soft_failures"] += 1
                    raise SoftFail(f"transient x{tr}: {e}")
                with self.lock:
                    self.counts["retries"] += 1
                    self.counts["transient_retries"] += 1
                self.log_event({"type": "retry", "kind": "transient", "phase": phase, "tag": tag, "attempt": tr,
                                "error": str(e)[:300], "wait_s": self.retry_wait})
                self.sleep(self.retry_wait)
            except B.Fatal as e:
                with self.lock:
                    self.counts["soft_failures"] += 1
                raise SoftFail(str(e))

    def multicall_soft(self, calls: list[tuple[str, bytes]], block: int, phase: str, tag: str = "",
                       max_calls: int = MAX_CALLS) -> list[tuple[bool, bytes]]:
        """aggregate3 (allowFailure) in chunks of <= max_calls; a chunk that errors is split in half down to
        one call; a single call that still errors is returned as (False, b'') and logged."""
        out: list[tuple[bool, bytes]] = []
        for i in range(0, len(calls), max_calls):
            out.extend(self._mc(calls[i:i + max_calls], block, phase, tag))
        return out

    def _mc(self, calls, block, phase, tag):
        n = len(calls)
        if n == 0:
            return []

        def v(res):
            if not isinstance(res, str) or not res.startswith("0x") or len(res) % 2:
                raise B.DecodeError("bad eth_call result")
            B.decode_aggregate3_result(bytes.fromhex(res[2:]), n)
        try:
            res = self.call_soft("eth_call", [{"to": MULTICALL3, "data": "0x" + B.encode_aggregate3(calls).hex()},
                                              hex(block)], phase, tag=tag, validate=v)
            return B.decode_aggregate3_result(bytes.fromhex(res[2:]), n)
        except SoftFail as e:
            if n == 1:
                self.log_event({"type": "call_failed", "phase": phase, "tag": tag, "block": block,
                                "target": calls[0][0], "error": str(e)[:300]})
                return [(False, b"")]
            with self.lock:
                self.counts["multicall_splits"] += 1
            self.log_event({"type": "multicall_split", "phase": phase, "tag": tag, "block": block, "n": n,
                            "error": str(e)[:200]})
            h = n // 2
            return self._mc(calls[:h], block, phase, tag) + self._mc(calls[h:], block, phase, tag)


# ---------------------------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------------------------


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git_info() -> dict:
    root = B.repo_root()
    me = Path(__file__).resolve()
    try:
        rel = str(me.relative_to(root))
        g = lambda *a: subprocess.check_output(["git", "-C", str(root), *a], text=True).strip()  # noqa: E731
        return {"sha": g("rev-parse", "HEAD"), "branch": g("rev-parse", "--abbrev-ref", "HEAD"), "path": rel,
                "dirty": bool(g("status", "--porcelain", "--", rel)),
                "file_last_commit": g("log", "-1", "--format=%H", "--", rel), "file_sha256": B.sha256_file(me),
                "helpers": {p: g("log", "-1", "--format=%H", "--", f"scripts/research/history-forecasts/{p}")
                            for p in ("b_acquire.py", "g_acquire_events.py")}}
    except Exception as e:  # pragma: no cover
        return {"error": str(e)}


def short(a: str) -> str:
    return a[:6] + "…" + a[-4:]


class Ctx:
    def __init__(self, work: Path, out: Path, ddir: Path, roster_path: Path | None):
        self.work = Path(work)
        self.out = Path(out)
        self.ddir = Path(ddir)
        self.work.mkdir(parents=True, exist_ok=True)
        (self.work / "state").mkdir(exist_ok=True)
        self.events_path = self.work / "events.jsonl"
        self.lock = threading.Lock()
        self.rpc = StateRpc(STATE_RPC_URL, self.events_path)
        self.logs_counts: dict = {}
        self.store = TokenLogStore(self.work / "logs")
        self.roster_path = Path(roster_path) if roster_path else None
        inp = self.get("inputs")
        if inp and self.roster_path is None:
            self.roster_path = Path(inp["roster"]["path"])
        self._roster = None
        self._universe = None
        self._blocks = None
        self.only_tokens: set[str] | None = None   # test runs: restrict every phase to these tokens
        self.logs_first: list[str] = []            # tokens fetched first (then oldest deployment first)

    # state: one JSON file per key (two processes write disjoint keys)
    def get(self, key: str, default=None):
        p = self.work / "state" / f"{key}.json"
        return json.loads(p.read_text()) if p.exists() else default

    def put(self, key: str, obj) -> None:
        p = self.work / "state" / f"{key}.json"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(obj, indent=1, sort_keys=True, default=str))
        os.replace(tmp, p)

    def log_event(self, ev: dict) -> None:
        ev = {"utc": utcnow(), **ev}
        print("EVENT " + json.dumps(ev, default=str)[:400], flush=True)
        with self.lock:
            with open(self.events_path, "a") as f:
                f.write(json.dumps(ev, default=str) + "\n")

    @property
    def roster(self) -> list[dict]:
        if self._roster is None:
            self._roster = load_roster(self.roster_path)
        return self._roster

    @property
    def universe(self) -> dict[str, set[str]]:
        if self._universe is None:
            self._universe = load_universe(self.ddir / UNIVERSE_REL)
        return self._universe

    @property
    def blocks(self) -> dict:
        if self._blocks is None:
            self._blocks = load_blocks(self.ddir / BLOCKS_REL)
        return self._blocks

    def selected(self) -> list[dict]:
        sel = self.get("select")
        if not sel:
            raise B.TerminalError("selection not made (run the tvl phase)")
        by = {t["address"]: t for t in self.roster}
        dep = self.get("deploy") or {}
        out = []
        for a in sel["selected"]:
            if self.only_tokens is not None and a not in self.only_tokens:
                continue
            t = dict(by[a])
            if a in dep:
                t["deploy_exact"] = dep[a]["block"]
            out.append(t)
        return out

    def start_block(self, t: dict) -> int:
        if "deploy_exact" not in t:
            raise B.TerminalError(f"no exact deployment block for {t['symbol']} (run the deploy phase)")
        return t["deploy_exact"]


# ---------------------------------------------------------------------------------------------
# Phase: preflight
# ---------------------------------------------------------------------------------------------


def logs_block(tag: str) -> dict:
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": [tag, False]}).encode()
    status, body = G.http_post(LOGS_RPC_URL, payload, timeout=60)
    obj = json.loads(body)
    if status != 200 or not isinstance(obj.get("result"), dict):
        raise B.TerminalError(f"cannot read block {tag} from the logs endpoint: {status}")
    return obj["result"]


def phase_preflight(ctx: Ctx) -> None:
    sig = check_signatures()
    if not sig["ok"]:
        raise B.TerminalError(f"topic0 self-check failed: {sig['known_match']}")
    roster = ctx.roster
    files = {"roster": ctx.roster_path, "universe": ctx.ddir / UNIVERSE_REL, "blocks": ctx.ddir / BLOCKS_REL}
    inputs = {k: {"path": str(p), "sha256": B.sha256_file(p), "bytes": p.stat().st_size} for k, p in files.items()}
    inputs["roster"]["n_tokens"] = len(roster)
    inputs["roster"]["n_excluded"] = sum(t["excluded"] for t in roster)
    inputs["roster"]["by_kind"] = {}
    for t in roster:
        inputs["roster"]["by_kind"][t["kind"]] = inputs["roster"]["by_kind"].get(t["kind"], 0) + 1
    U = ctx.universe
    inputs["universe"]["n_addresses_union"] = len(U)
    inputs["universe"]["by_reserve"] = {r: sum(1 for s in U.values() if r in s) for r in ("USDC", "USDT")}
    bl = ctx.blocks
    inputs["blocks"].update({"n_daily": len(bl["daily"]), "n_monthly": len(bl["monthly"]), "asof_b1": bl["asof_b1"]})
    if len(bl["monthly"]) != 45:
        raise B.TerminalError(f"{len(bl['monthly'])} monthly blocks, expected 45")
    ctx.put("inputs", inputs)
    # asof block on both endpoints
    lb = logs_block(hex(ASOF_LOGS))
    sb = ctx.rpc.block_obj(ASOF_LOGS, "preflight")
    asof = {"block": ASOF_LOGS, "hash_logs_endpoint": lb["hash"], "hash_state_endpoint": sb["hash"],
            "ts": int(sb["timestamp"], 16), "match": lb["hash"] == sb["hash"]}
    asof["utc"] = B.iso_utc(asof["ts"])
    if not asof["match"]:
        raise B.TerminalError("asof block hash differs between endpoints")
    b1 = ctx.rpc.block_obj(ASOF_B1, "preflight")
    asof["b1"] = {"block": ASOF_B1, "hash": b1["hash"], "ts": int(b1["timestamp"], 16)}
    # token sanity at the asof block
    calls, meta = [], []
    for t in roster:
        if t["excluded"]:
            continue
        a = t["address"]
        calls.append((a, cdata("decimals"))); meta.append((a, "decimals"))
        if t["kind"] == "erc4626":
            calls.append((a, cdata("asset"))); meta.append((a, "underlying"))
        elif t["kind"].startswith("atoken"):
            calls.append((a, cdata("UNDERLYING_ASSET_ADDRESS"))); meta.append((a, "underlying"))
            calls.append((a, cdata("POOL"))); meta.append((a, "pool"))
        elif t["kind"] == "comet":
            calls.append((a, cdata("baseToken"))); meta.append((a, "underlying"))
        elif t["kind"] == "ctoken":
            calls.append((a, cdata("underlying"))); meta.append((a, "underlying"))
    res = ctx.rpc.multicall_soft(calls, ASOF_B1, "preflight", "sanity")
    sanity: dict[str, dict] = {}
    by = {t["address"]: t for t in roster}
    for (a, what), (ok, ret) in zip(meta, res):
        s = sanity.setdefault(a, {})
        if what == "decimals":
            v, st = u256(ok, ret)
            s["decimals"] = v
            s["decimals_ok"] = v == by[a]["dec"]
        else:
            w = addr_word(ok, ret)
            s[what] = w
            if what == "underlying":
                s["underlying_ok"] = w == by[a]["underlying"]
    bad = {a: s for a, s in sanity.items() if not (s.get("decimals_ok") and s.get("underlying_ok"))}
    ctx.put("preflight", {"signatures": sig, "asof": asof, "sanity": sanity, "sanity_mismatch": bad,
                          "utc": utcnow()})
    print(f"PREFLIGHT ok: {len(roster)} tokens ({inputs['roster']['n_excluded']} excluded), universe {len(U)}, "
          f"sanity mismatches {len(bad)}", flush=True)


# ---------------------------------------------------------------------------------------------
# Phase: tvl + selection
# ---------------------------------------------------------------------------------------------


def tvl_calls(t: dict) -> list[tuple[str, bytes]]:
    a = t["address"]
    if t["kind"] == "erc4626":
        return [(a, cdata("totalAssets"))]
    if t["kind"] == "ctoken":
        return [(a, cdata("totalSupply")), (a, cdata("exchangeRateStored"))]
    return [(a, cdata("totalSupply"))]


def tvl_value(t: dict, results: list[tuple[bool, bytes]]) -> tuple[int | None, str]:
    """(TVL in raw underlying units, status). Before deployment (no return data) the TVL is 0."""
    vals = [u256(ok, ret) for ok, ret in results]
    sts = {st for _, st in vals}
    if sts == {"empty"}:
        return 0, "not_deployed"
    if sts != {"ok"}:
        return None, "+".join(sorted(sts))
    if t["kind"] == "ctoken":
        return vals[0][0] * vals[1][0] // 10**18, "ok"
    return vals[0][0], "ok"


def phase_tvl(ctx: Ctx) -> None:
    if ctx.get("select"):
        print("TVL: selection already made; not re-run", flush=True)
        return
    toks = [t for t in ctx.roster if not t["excluded"]]
    store = B.JsonlStore(ctx.work / "tvl.jsonl")
    plan = []
    for t in toks:
        for c in tvl_calls(t):
            plan.append((t["address"], c))
    monthly = ctx.blocks["monthly"]

    def task(m):
        label, block, _ = m
        if store.has(label):
            return
        res = ctx.rpc.multicall_soft([c for _, c in plan], block, "tvl", label, max_calls=MAX_CALLS_HEAVY)
        store.put(label, {"block": block, "res": [[ok, ret.hex()] for ok, ret in res]})
    B.run_pool(ctx_pool(ctx), "tvl", monthly, task)
    rows, per = [], {t["address"]: [] for t in toks}
    for label, block, _ in monthly:
        rec = store.get(label)
        res = [(ok, bytes.fromhex(h)) for ok, h in rec["res"]]
        i = 0
        for t in toks:
            n = len(tvl_calls(t))
            raw, st = tvl_value(t, res[i:i + n])
            i += n
            usd = None if raw is None else raw / 10**t["udec"] * USD_PER_UNIT
            rows.append([label, block, t["family"], t["symbol"], t["address"], t["kind"], st,
                         "" if raw is None else raw, "" if usd is None else f"{usd:.2f}"])
            per[t["address"]].append((label, usd, st))
    sel_rows, selected = [], []
    for t in toks:
        vals = [(u, lab) for lab, u, st in per[t["address"]] if u is not None]
        mx, at = max(vals) if vals else (None, None)
        n_fail = sum(1 for _, u, st in per[t["address"]] if u is None)
        n_pos = sum(1 for _, u, _ in per[t["address"]] if u)
        ok = mx is not None and mx >= TVL_MIN_USD
        if ok:
            selected.append(t["address"])
            sel_rows.append([t["family"], t["symbol"], t["name"], t["address"], t["kind"], t["dec"], t["underlying"],
                             t["udec"], t["method"], t["deploy_block"], t["deploy_precision"], f"{mx:.2f}", at, n_pos,
                             n_fail])
    ctx.out.mkdir(parents=True, exist_ok=True)
    B.write_csv(ctx.out / "tvl-monthly.csv", ["snapshot", "block", "family", "symbol", "address", "kind", "status",
                                              "tvl_raw", "tvl_usd"], rows, gz=False)
    B.write_csv(ctx.out / "selected-tokens.csv", ["family", "symbol", "name", "address", "kind", "token_dec",
                                                  "underlying", "udec", "method", "roster_deploy_block",
                                                  "roster_deploy_precision", "max_monthly_tvl_usd", "max_at_snapshot",
                                                  "n_months_tvl_gt0", "n_months_tvl_unreadable"], sel_rows, gz=False)
    fam: dict[str, dict] = {}
    for t in toks:
        f = fam.setdefault(t["family"], {"roster": 0, "selected": 0})
        f["roster"] += 1
        f["selected"] += t["address"] in selected
    unreadable = {t["address"]: sum(1 for _, u, _ in per[t["address"]] if u is None) for t in toks}
    ctx.put("select", {
        "rule": f"max over the 45 monthly snapshots of TVL (USD, underlying at $1) >= ${TVL_MIN_USD:,}; "
                "ERC-4626 totalAssets, aToken/Comet totalSupply, cToken totalSupply x exchangeRateStored / 1e18; "
                "before deployment = 0; an unreadable month (reverted call) is left out of the maximum",
        "selected": selected, "n_selected": len(selected), "n_roster_used": len(toks), "by_family": fam,
        "unreadable_months": {a: n for a, n in unreadable.items() if n},
        "files": {n: {"sha256": B.sha256_file(ctx.out / n), "bytes": (ctx.out / n).stat().st_size,
                      "written_utc": utcnow()} for n in ("tvl-monthly.csv", "selected-tokens.csv")},
    })
    shutil.copy(ctx.out / "tvl-monthly.csv", ctx.work / "tvl-monthly.csv")
    shutil.copy(ctx.out / "selected-tokens.csv", ctx.work / "selected-tokens.csv")
    print(f"TVL: {len(selected)} of {len(toks)} tokens selected; by family "
          + json.dumps({k: v["selected"] for k, v in fam.items() if v["selected"]}), flush=True)


class _PoolCtx:
    def __init__(self, rpc, workers):
        self.rpc = rpc
        self.workers = workers


def ctx_pool(ctx: Ctx, workers: int = STATE_WORKERS) -> _PoolCtx:
    return _PoolCtx(ctx.rpc, workers)


# ---------------------------------------------------------------------------------------------
# Phase: deploy
# ---------------------------------------------------------------------------------------------


def code_len(ctx: Ctx, address: str, block: int, phase: str = "deploy") -> int:
    code = ctx.rpc.call("eth_getCode", [address, hex(block)], phase, tag=f"code {address} {block}")
    if not isinstance(code, str) or not code.startswith("0x"):
        raise B.TerminalError("bad eth_getCode result")
    return (len(code) - 2) // 2


def phase_deploy(ctx: Ctx) -> None:
    dep = ctx.get("deploy") or {}
    for t in ctx.selected():
        a = t["address"]
        if a in dep:
            continue
        has = lambda b, a=a: code_len(ctx, a, b) > 0  # noqa: E731
        br = parse_bracket(t["deploy_precision"])
        probes0 = ctx.rpc.counts["http_requests"]
        if br is None:
            d = t["deploy_block"]
            if has(d) and not has(d - 1):
                block, how = d, "roster block verified (code at b, none at b-1)"
            else:
                block, how = G.find_deploy_block(has, 1, ASOF_LOGS), "roster block failed the check; bisection"
        else:
            lo, hi = br
            if has(lo) or not has(hi):
                block, how = G.find_deploy_block(has, 1, ASOF_LOGS), "bracket invalid; full bisection"
            else:
                block, how = G.find_deploy_block(has, lo, hi), "eth_getCode bisection in the roster bracket"
        dep[a] = {"block": block, "how": how, "symbol": t["symbol"], "probes": ctx.rpc.counts["http_requests"] - probes0,
                  "roster_block": t["deploy_block"], "roster_precision": t["deploy_precision"]}
        ctx.put("deploy", dep)
        print(f"DEPLOY {t['symbol']} {short(a)} {block} ({how})", flush=True)


# ---------------------------------------------------------------------------------------------
# Phase: logs
# ---------------------------------------------------------------------------------------------


def next_size(n_logs: int, span: int) -> int:
    """Next range size from the observed log density, aiming at TARGET_LOGS_PER_RANGE (<= 50,000)."""
    if n_logs <= 0:
        return RANGE_MAX
    s = int(TARGET_LOGS_PER_RANGE * span / n_logs)
    return max(RANGE_MIN, min(RANGE_MAX, s))


def fetch_token(store, client, key: str, start: int, end: int, log_event, sleep=time.sleep, progress=None,
                stop=None) -> dict:
    """Fill every gap of [start, end]: ranges <= 50,000 blocks sized by density; a range that errors is
    split in half down to 1,000 blocks; an error at 1,000 blocks is retried after 30 s up to 5 times,
    then the run stops."""
    stats = {"ranges_ok": 0, "splits": 0, "min_size_retries": 0, "logs": 0}
    size = RANGE_MAX
    cap = float(RANGE_MAX)   # after an error at span s the next ranges start at <= s/2, growing 10% per success
    for glo, ghi in G.uncovered(start, end, store.done(key)):
        pos = glo
        while pos <= ghi:
            hi = min(pos + size - 1, ghi)
            stack = [(pos, hi)]
            while stack:
                lo, h = stack.pop()
                tries = 0
                while True:
                    if stop is not None and stop.is_set():
                        raise B.TerminalError("stopped")
                    try:
                        logs = client.get_logs(key, lo, h)
                        break
                    except G.RangeError as e:
                        halves = G.split_range(lo, h)
                        if halves is not None:
                            logs = None
                            cap = max(float(RANGE_MIN), min(cap, (h - lo + 1) / 2))
                            stats["splits"] += 1
                            client.counts["splits"] += 1
                            log_event({"type": "split", "src": "logs", "token": key, "range": [lo, h],
                                       "into": [list(halves[0]), list(halves[1])],
                                       "kind": G.range_error_kind(str(e)), "error": str(e)[:160]})
                            stack.append(halves[1])
                            stack.append(halves[0])
                            break
                        tries += 1
                        if tries > MIN_SIZE_RETRIES:
                            client.counts["failures"] += 1
                            log_event({"type": "failure", "src": "logs", "kind": "range_at_minimum", "token": key,
                                       "range": [lo, h], "error": str(e)[:300]})
                            raise B.TerminalError(f"{key} range [{lo},{h}] errored at the minimum size: {e}")
                        stats["min_size_retries"] += 1
                        client.counts["min_size_retries"] = client.counts.get("min_size_retries", 0) + 1
                        log_event({"type": "retry", "src": "logs", "kind": "min_size", "token": key, "range": [lo, h],
                                   "attempt": tries, "error": str(e)[:200], "wait_s": RETRY_WAIT_S})
                        sleep(RETRY_WAIT_S)
                if logs is None:
                    continue
                store.save(key, lo, h, logs)
                stats["ranges_ok"] += 1
                stats["logs"] += len(logs)
                cap = min(float(RANGE_MAX), cap * 1.1)
                size = min(next_size(len(logs), h - lo + 1), int(cap))
                if progress:
                    progress(key, h, len(logs))
            pos = hi + 1
    if G.uncovered(start, end, store.done(key)):
        raise B.TerminalError(f"{key}: coverage incomplete")
    return stats


class TokenLogStore(G.LogStore):
    """G.LogStore with (a) no file for an empty range (index entry n = 0), (b) batched index appends (one
    fsync per batch), (c) an in-memory coverage map per token. Compatible with G.LogStore checkpoints."""

    def __init__(self, root: Path):
        super().__init__(root)
        self._cov: dict[str, list[tuple[int, int]]] = {}
        for r in self.index.values():
            self._cov.setdefault(r["k"][0], []).append((r["k"][1], r["k"][2]))
        for k in self._cov:
            self._cov[k].sort()
        self._lock = threading.Lock()

    def done(self, reserve: str) -> list[tuple[int, int]]:
        with self._lock:
            out = list(self._cov.get(reserve, []))
        for (a1, b1), (a2, b2) in zip(out, out[1:]):
            if a2 <= b1:
                raise B.TerminalError(f"overlapping checkpoint ranges {reserve} [{a1},{b1}] [{a2},{b2}]")
        return out

    def save(self, reserve: str, lo: int, hi: int, logs: list[dict]) -> None:
        self.save_many([(reserve, lo, hi, logs)])

    def save_many(self, entries: list[tuple[str, int, int, list[dict]]]) -> None:
        lines, recs = [], []
        for reserve, lo, hi, logs in entries:
            sha = None
            if logs:
                p = self.path(reserve, lo, hi)
                p.parent.mkdir(parents=True, exist_ok=True)
                tmp = p.with_suffix(".tmp")
                with gzip.open(tmp, "wt", newline="", compresslevel=6) as f:
                    w = csv.writer(f, lineterminator="\n")
                    w.writerow(self.COLS)
                    for lg in logs:
                        t = lg["topics"] + [""] * (4 - len(lg["topics"]))
                        w.writerow([lg["block"], "" if lg["ts"] is None else lg["ts"], lg["block_hash"], lg["tx"],
                                    lg["tx_index"], lg["log_index"], *t, lg["data"]])
                os.replace(tmp, p)
                sha = B.sha256_file(p)
            rec = {"k": [reserve, lo, hi], "n": len(logs), "sha256": sha}
            recs.append(rec)
            lines.append(json.dumps(rec, separators=(",", ":")) + "\n")
        with self.index.lock:
            with open(self.index.path, "a") as f:
                f.write("".join(lines))
                f.flush()
                os.fsync(f.fileno())
            for rec in recs:
                self.index.data[json.dumps(rec["k"])] = rec
        with self._lock:
            for rec in recs:
                c = self._cov.setdefault(rec["k"][0], [])
                bisect.insort(c, (rec["k"][1], rec["k"][2]))

    def load(self, reserve: str, lo: int, hi: int) -> list[dict]:
        rec = self.index.get((reserve, lo, hi))
        if rec is not None and rec["n"] == 0:
            return []
        return super().load(reserve, lo, hi)

    def overlaps(self, reserve: str, s: int, e: int) -> bool:
        """True if any recorded range of `reserve` intersects [s, e]."""
        with self._lock:
            c = self._cov.get(reserve, [])
            i = bisect.bisect_right(c, (e, float("inf"))) - 1
            return i >= 0 and c[i][1] >= s

    def count(self, reserve: str) -> int:
        return sum(r["n"] for r in self.index.values() if r["k"][0] == reserve)


def validate_group_logs(result, addrs: set[str], lo: int, hi: int) -> dict[str, list[dict]]:
    """Like G.validate_logs for a multi-address filter; returns logs per address (sorted). A response of
    >= 10,000 logs over > 10,000 blocks may be capped by the endpoint and counts as a range error."""
    if not isinstance(result, list):
        raise G.RangeError(f"result is {type(result).__name__}")
    if len(result) >= G.CAP_SUSPECT and hi - lo + 1 > 10_000:
        raise G.RangeError(f"{len(result)} logs: possibly capped")
    seen, out = set(), {}
    for lg in result:
        try:
            a = str(lg["address"]).lower()
            if a not in addrs:
                raise G.RangeError(f"log of {a}")
            b = int(lg["blockNumber"], 16)
            if not lo <= b <= hi:
                raise G.RangeError(f"block {b} outside [{lo},{hi}]")
            if lg.get("removed"):
                raise G.RangeError("removed log")
            li = int(lg["logIndex"], 16)
            ti = int(lg["transactionIndex"], 16)
            th = str(lg["transactionHash"]).lower()
            bh = str(lg.get("blockHash") or "").lower()
            topics = [str(t).lower() for t in lg["topics"]]
            data = str(lg["data"]).lower()
            ts = int(lg["blockTimestamp"], 16) if lg.get("blockTimestamp") else None
        except (KeyError, TypeError, ValueError) as e:
            raise G.RangeError(f"malformed log: {e}")
        if not (1 <= len(topics) <= 4) or len(th) != 66 or not data.startswith("0x"):
            raise G.RangeError("malformed log fields")
        if (b, li) in seen:
            raise G.RangeError(f"duplicate log {b}/{li}")
        seen.add((b, li))
        out.setdefault(a, []).append({"block": b, "ts": ts, "block_hash": bh, "tx": th, "tx_index": ti,
                                      "log_index": li, "topics": topics, "data": data})
    for v in out.values():
        v.sort(key=lambda x: (x["block"], x["log_index"]))
    return out


class GroupLogsClient(G.LogsClient):
    """eth_getLogs with an address list (same pacing, rate-limit and error policy as G.LogsClient)."""

    def get_group_logs(self, addresses: list[str], lo: int, hi: int) -> dict[str, list[dict]]:
        self._id += 1
        payload = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": "eth_getLogs",
                              "params": [{"address": addresses, "fromBlock": hex(lo), "toBlock": hex(hi)}]}).encode()
        addrs = set(addresses)
        retries = 0
        while True:
            self.pacer.wait()
            self.counts["requests"] += 1
            t_0 = time.monotonic()
            err, status = None, None
            try:
                try:
                    status, body = self.post(payload)
                finally:
                    self.counts["seconds_in_requests"] += time.monotonic() - t_0
                self.counts["bytes"] += len(body)
                if status == 200:
                    try:
                        obj = json.loads(body)
                    except ValueError:
                        raise G.RangeError(f"non-JSON body ({len(body)} bytes)")
                    if not isinstance(obj, dict):
                        raise G.RangeError("non-object body")
                    err = obj.get("error")
                    if err is not None and not isinstance(err, dict):
                        err = {"message": str(err)}
                    if err is None:
                        if "result" not in obj:
                            raise G.RangeError("no result")
                        logs = validate_group_logs(obj["result"], addrs, lo, hi)
                        self.counts["ok"] += 1
                        self.counts["logs"] += sum(len(v) for v in logs.values())
                        return logs
                if G.is_rate_limit(status, err):
                    retries += 1
                    if retries > self.max_retries:
                        self.counts["failures"] += 1
                        self.log_event({"type": "failure", "kind": "rate_limit", "range": [lo, hi],
                                        "retries": retries - 1, "status": status, "error": err})
                        raise B.TerminalError(f"rate limit after {self.max_retries} retries at [{lo},{hi}]")
                    self.counts["rate_limit_retries"] += 1
                    self.log_event({"type": "retry", "kind": "rate_limit", "range": [lo, hi], "attempt": retries,
                                    "status": status, "error": err, "wait_s": self.retry_wait})
                    self.pacer.pause(self.retry_wait)
                    self.sleep(self.retry_wait)
                    continue
                if err is not None:
                    raise G.RangeError(f"rpc error {json.dumps(err)[:300]}")
                raise G.RangeError(f"HTTP {status}")
            except G.RangeError as e:
                self.counts["range_errors"] += 1
                kind = G.range_error_kind(str(e))
                self.counts["range_error_kinds"][kind] = self.counts["range_error_kinds"].get(kind, 0) + 1
                raise
            except (OSError, http.client.HTTPException) as e:
                self.counts["range_errors"] += 1
                self.counts["range_error_kinds"]["transport"] = self.counts["range_error_kinds"].get("transport", 0) + 1
                raise G.RangeError(f"transport: {type(e).__name__}: {e}")


GROUP_CHUNK = 250_000           # block chunks handed to the log workers in the multi-address sweep


def group_members(toks: list[dict], deploy: dict[str, int], lo: int, hi: int, overlaps) -> list[str]:
    """Tokens alive in [lo, hi] whose whole live part of [lo, hi] is uncovered (partially covered tokens
    are left to the per-token gap pass, so checkpoint ranges never overlap)."""
    out = []
    for t in toks:
        a = t["address"]
        d = deploy[a]
        if d > hi:
            continue
        if not overlaps(a, max(lo, d), hi):
            out.append(a)
    return sorted(out)


def fetch_group_chunk(store: TokenLogStore, client: GroupLogsClient, toks: list[dict], deploy: dict[str, int],
                      clo: int, chi: int, log_event, sleep=time.sleep, stop=None) -> dict:
    """Multi-address sweep of [clo, chi]: ranges <= 50,000 blocks sized by the combined log density and
    capped after errors; a range that errors is split in half down to 1,000 blocks; at 1,000 blocks the
    address list is split in half; a single address at 1,000 blocks is retried after 30 s up to 5 times,
    then the run stops. Each member token gets the range [max(lo, deploy), hi] recorded (n may be 0)."""
    stats = {"requests_ok": 0, "splits": 0, "address_splits": 0, "min_size_retries": 0, "logs": 0}
    cap = float(RANGE_MAX)
    size = RANGE_MAX
    pos = clo
    while pos <= chi:
        hi = min(pos + size - 1, chi)
        members = group_members(toks, deploy, pos, hi, store.overlaps)
        if not members:
            pos = hi + 1
            continue
        stack = [(pos, hi, members)]
        while stack:
            lo, h, mem = stack.pop()
            tries = 0
            while True:
                if stop is not None and stop.is_set():
                    raise B.TerminalError("stopped")
                try:
                    res = client.get_group_logs(mem, lo, h)
                    break
                except G.RangeError as e:
                    res = None
                    halves = G.split_range(lo, h)
                    if halves is not None:
                        cap = max(float(RANGE_MIN), min(cap, (h - lo + 1) / 2))
                        stats["splits"] += 1
                        client.counts["splits"] += 1
                        log_event({"type": "split", "src": "logs", "group": len(mem), "range": [lo, h],
                                   "into": [list(halves[0]), list(halves[1])], "kind": G.range_error_kind(str(e)),
                                   "error": str(e)[:160]})
                        stack.append((halves[1][0], halves[1][1], mem))
                        stack.append((halves[0][0], halves[0][1], mem))
                        break
                    if len(mem) > 1:
                        k = len(mem) // 2
                        stats["address_splits"] += 1
                        client.counts["address_splits"] = client.counts.get("address_splits", 0) + 1
                        log_event({"type": "address_split", "src": "logs", "range": [lo, h], "group": len(mem),
                                   "error": str(e)[:160]})
                        stack.append((lo, h, mem[k:]))
                        stack.append((lo, h, mem[:k]))
                        break
                    tries += 1
                    if tries > MIN_SIZE_RETRIES:
                        client.counts["failures"] += 1
                        log_event({"type": "failure", "src": "logs", "kind": "range_at_minimum", "token": mem[0],
                                   "range": [lo, h], "error": str(e)[:300]})
                        raise B.TerminalError(f"{mem[0]} range [{lo},{h}] errored at the minimum size: {e}")
                    stats["min_size_retries"] += 1
                    client.counts["min_size_retries"] = client.counts.get("min_size_retries", 0) + 1
                    log_event({"type": "retry", "src": "logs", "kind": "min_size", "token": mem[0], "range": [lo, h],
                               "attempt": tries, "error": str(e)[:200], "wait_s": RETRY_WAIT_S})
                    sleep(RETRY_WAIT_S)
            if res is None:
                continue
            store.save_many([(a, max(lo, deploy[a]), h, res.get(a, [])) for a in mem])
            n = sum(len(v) for v in res.values())
            stats["requests_ok"] += 1
            stats["logs"] += n
            cap = min(float(RANGE_MAX), cap * 1.1)
            size = min(next_size(n, h - lo + 1), int(cap))
        pos = hi + 1
    return stats


def phase_logs(ctx: Ctx) -> None:
    """Multi-address sweep over block chunks (all selected tokens alive in a range in one request), then a
    per-token pass that fills any remaining gap with single-address requests."""
    toks = sorted(ctx.selected(), key=lambda t: (t["address"] not in ctx.logs_first, ctx.start_block(t)))
    deploy = {t["address"]: ctx.start_block(t) for t in toks}
    store = ctx.store
    shared = B.Pacer(LOGS_INTERVAL_S)
    stats = ctx.get("logs") or {}
    clients, err = [], []
    stop = threading.Event()
    lock = threading.Lock()
    t_start = time.monotonic()
    pending = [t for t in toks if not stats.get(t["address"], {}).get("complete")]
    lo0 = min((deploy[t["address"]] for t in pending), default=ASOF_LOGS + 1)
    chunks: "queue.Queue[tuple[int, int]]" = queue.Queue()
    for s0 in range(lo0, ASOF_LOGS + 1, GROUP_CHUNK):
        chunks.put((s0, min(s0 + GROUP_CHUNK - 1, ASOF_LOGS)))
    n_chunks = chunks.qsize()
    done_chunks = [0]
    gstats = {"requests_ok": 0, "splits": 0, "address_splits": 0, "min_size_retries": 0, "logs": 0}

    def new_client():
        c = GroupLogsClient(log_event=lambda ev: ctx.log_event({"src": "logs", **ev}))
        c.pacer = shared
        c.counts["min_size_retries"] = 0
        c.counts["address_splits"] = 0
        with lock:
            clients.append(c)
        return c

    def group_worker():
        c = new_client()
        while not stop.is_set():
            try:
                clo, chi = chunks.get_nowait()
            except queue.Empty:
                return
            try:
                st = fetch_group_chunk(store, c, pending, deploy, clo, chi, ctx.log_event, stop=stop)
            except B.TerminalError as e:
                err.append(e)
                stop.set()
                return
            except Exception as e:  # unexpected: stop everything and surface it
                err.append(B.TerminalError(f"{type(e).__name__}: {e}"))
                stop.set()
                return
            with lock:
                for k, v in st.items():
                    gstats[k] += v
                done_chunks[0] += 1
                print(f"LOGS chunk [{clo},{chi}] done ({done_chunks[0]}/{n_chunks}) logs={st['logs']} "
                      f"reqs={sum(x.counts['requests'] for x in clients)} elapsed={time.monotonic() - t_start:.0f}s",
                      flush=True)

    def gap_worker(q):
        c = new_client()
        while not stop.is_set():
            try:
                t = q.get_nowait()
            except queue.Empty:
                return
            a = t["address"]
            try:
                st = fetch_token(store, c, a, deploy[a], ASOF_LOGS, ctx.log_event, stop=stop)
            except B.TerminalError as e:
                err.append(e)
                stop.set()
                return
            except Exception as e:
                err.append(B.TerminalError(f"{type(e).__name__}: {e}"))
                stop.set()
                return
            with lock:
                stats[a] = {"symbol": t["symbol"], "complete": True, "logs": store.count(a),
                            "ranges": len(store.done(a)), "gap_pass": st, "from_block": deploy[a],
                            "to_block": ASOF_LOGS}
                ctx.put("logs", stats)

    def run(target, *args):
        ths = [threading.Thread(target=target, args=args, daemon=True) for _ in range(LOGS_WORKERS)]
        for th in ths:
            th.start()
        try:
            while any(th.is_alive() for th in ths):
                for th in ths:
                    th.join(timeout=1.0)
        except B.TerminalError as e:  # signal: stop the workers at their next request
            err.append(e)
            stop.set()
            for th in ths:
                th.join(timeout=150)

    run(group_worker)
    if not err:
        q: "queue.Queue[dict]" = queue.Queue()
        for t in pending:
            q.put(t)
        run(gap_worker, q)
    tot: dict = {}
    for c in clients:
        for k, v in c.counts.items():
            if isinstance(v, (int, float)):
                tot[k] = tot.get(k, 0) + v
            elif isinstance(v, dict):
                d = tot.setdefault(k, {})
                for kk, vv in v.items():
                    d[kk] = d.get(kk, 0) + vv
    ctx.logs_counts = tot
    prev = ctx.get("logs_group") or []
    prev.append({"utc": utcnow(), "stats": gstats, "chunks_done": done_chunks[0], "chunks": n_chunks})
    ctx.put("logs_group", prev)
    if err:
        raise err[0]
    print(f"LOGS complete: {sum(stats[t['address']]['logs'] for t in toks)} logs over {len(toks)} tokens", flush=True)


# ---------------------------------------------------------------------------------------------
# Phase: prices
# ---------------------------------------------------------------------------------------------


def price_calls(t: dict, pool: str | None) -> list[tuple[str, bytes]]:
    a = t["address"]
    if t["kind"] == "erc4626":
        return [(a, cdata("convertToAssets", 10 ** (t["dec"] + 6)))]
    if t["kind"].startswith("atoken"):
        return [(pool, cdata("getReserveNormalizedIncome", t["underlying"]))]
    if t["kind"] == "comet":
        return [(a, cdata("totalSupply")), (a, cdata("totalsBasic"))]
    if t["kind"] == "ctoken":
        return [(a, cdata("exchangeRateStored"))]
    raise ValueError(t["kind"])


def price_value(t: dict, res: list[tuple[bool, bytes]], block: int) -> dict | None:
    """Parsed price at a block, or None (not deployed / unreadable)."""
    if block < t["deploy_exact"]:
        return None
    if t["kind"] == "erc4626":
        v, st = u256(*res[0])
        return {"assets": v, "probe": 10 ** (t["dec"] + 6)} if st == "ok" else {"status": st}
    if t["kind"].startswith("atoken"):
        v, st = u256(*res[0])
        return {"income": v} if st == "ok" and v else {"status": st}
    if t["kind"] == "ctoken":
        v, st = u256(*res[0])
        return {"rate": v} if st == "ok" else {"status": st}
    if t["kind"] == "comet":
        ts, st1 = u256(*res[0])
        ok, ret = res[1]
        if st1 != "ok" or not ok or len(ret) < 256:
            return {"status": "fail"}
        w = [int.from_bytes(ret[i:i + 32], "big") for i in range(0, 256, 32)]
        base_supply_index, total_supply_base, last_accrual = w[0], w[4], w[6]
        index = ts * COMET_INDEX_SCALE / total_supply_base if total_supply_base else float(base_supply_index)
        return {"index": index, "totalSupply": ts, "totalSupplyBase": total_supply_base,
                "baseSupplyIndex": base_supply_index, "lastAccrualTime": last_accrual}
    raise ValueError(t["kind"])


def price_blocks(ctx: Ctx) -> list[tuple[str, int]]:
    return snapshot_list(ctx.blocks)


def comet_prepanel_blocks(ctx: Ctx, t: dict) -> list[tuple[str, int]]:
    first = ctx.blocks["daily"][0][1]
    s = t["deploy_exact"]
    return [(f"pre:{b}", b) for b in range(s, first, COMET_PREPANEL_STEP)]


def phase_prices(ctx: Ctx) -> None:
    toks = ctx.selected()
    pools = (ctx.get("preflight") or {}).get("sanity", {})
    store = B.JsonlStore(ctx.work / "prices.jsonl")
    plan = []
    for t in toks:
        pool = pools.get(t["address"], {}).get("pool") if t["kind"].startswith("atoken") else None
        if t["kind"].startswith("atoken") and not pool:
            raise B.TerminalError(f"no POOL for {t['symbol']}")
        for c in price_calls(t, pool):
            plan.append((t["address"], c))
    tasks = [(label, b, None) for label, b in price_blocks(ctx)]
    for t in toks:
        if t["kind"] == "comet":
            tasks += [(label, b, t["address"]) for label, b in comet_prepanel_blocks(ctx, t)]

    def task(x):
        label, block, only = x
        if store.has(label):
            return
        calls = [c for a, c in plan if only is None or a == only]
        res = ctx.rpc.multicall_soft(calls, block, "prices", label, max_calls=MAX_CALLS_HEAVY)
        store.put(label, {"block": block, "only": only, "res": [[ok, r.hex()] for ok, r in res]})
    B.run_pool(ctx_pool(ctx), "prices", tasks, task)
    ctx.put("prices", {"n_blocks": len(tasks), "complete": True, "plan_tokens": [t["address"] for t in toks]})


def load_prices(ctx: Ctx) -> dict[str, dict[str, dict]]:
    """token -> label -> parsed price (or None); also '_block' map label -> block."""
    toks = ctx.selected()
    pools = (ctx.get("preflight") or {}).get("sanity", {})
    store = B.JsonlStore(ctx.work / "prices.jsonl")
    ncalls = {t["address"]: len(price_calls(t, pools.get(t["address"], {}).get("pool") or MULTICALL3)) for t in toks}
    out: dict[str, dict] = {t["address"]: {} for t in toks}
    blocks: dict[str, int] = {}
    for rec in store.values():
        label, block, only = rec["k"], rec["block"], rec.get("only")
        blocks[label] = block
        res = [(ok, bytes.fromhex(h)) for ok, h in rec["res"]]
        i = 0
        for t in toks:
            if only is not None and t["address"] != only:
                continue
            n = ncalls[t["address"]]
            out[t["address"]][label] = price_value(t, res[i:i + n], block)
            i += n
        if i != len(res):
            raise B.TerminalError(f"price record {label}: {len(res)} results, {i} expected")
    out["_block"] = blocks
    return out


# ---------------------------------------------------------------------------------------------
# Phase: codes
# ---------------------------------------------------------------------------------------------


def phase_codes(ctx: Ctx) -> None:
    store = B.JsonlStore(ctx.work / "codes.jsonl")
    addrs = sorted(ctx.universe)

    def task(a):
        if store.has(a):
            return
        code = ctx.rpc.call("eth_getCode", [a, hex(ASOF_LOGS)], "codes", tag=f"code {a}")
        if not isinstance(code, str) or not code.startswith("0x"):
            raise B.TerminalError("bad eth_getCode result")
        n = (len(code) - 2) // 2
        store.put(a, {"n": n, "head": code[:48]})
    B.run_pool(ctx_pool(ctx), "codes", addrs, task)
    ctx.put("codes", {"n": len(addrs), "complete": True, "block": ASOF_LOGS})


def code_kind(rec: dict) -> str:
    if rec["n"] == 0:
        return "eoa"
    if rec["n"] == 23 and rec["head"].startswith("0xef0100"):
        return "eip7702"
    return "contract"


# ---------------------------------------------------------------------------------------------
# Phase: nesting
# ---------------------------------------------------------------------------------------------


def phase_nesting(ctx: Ctx) -> None:
    toks = ctx.selected()
    by = {t["address"]: t for t in ctx.roster}
    store = B.JsonlStore(ctx.work / "nesting.jsonl")
    v2 = [t for t in toks if t["family"] == "Morpho-V2"]
    targets = [t for t in toks] + [by[a] for a in EXCLUDED]
    labels = anchor_labels(ctx.blocks)

    def task(x):
        label, block = x
        if store.has(label):
            return
        # Morpho V2 adapters at this block
        live_v2 = [t for t in v2 if block >= t["deploy_exact"]]
        res = ctx.rpc.multicall_soft([(t["address"], cdata("adaptersLength")) for t in live_v2], block, "nesting",
                                     label) if live_v2 else []
        acalls, owners = [], []
        for t, (ok, ret) in zip(live_v2, res):
            n, st = u256(ok, ret)
            for i in range(min(n or 0, 64) if st == "ok" else 0):
                acalls.append((t["address"], cdata("adapters", i)))
                owners.append(t["address"])
        adapters = {}
        if acalls:
            for own, (ok, ret) in zip(owners, ctx.rpc.multicall_soft(acalls, block, "nesting", label)):
                w = addr_word(ok, ret)
                if w:
                    adapters.setdefault(w, []).append(own)
        holders = [(t["address"], "selected_token") for t in toks if block >= t["deploy_exact"]]
        holders += [(a, "morpho_v2_adapter") for a in sorted(adapters)]
        live_targets = [t for t in targets if t["address"] in EXCLUDED or block >= t["deploy_exact"]]
        calls, meta = [], []
        for h, hk in holders:
            for tg in live_targets:
                if tg["address"] == h:
                    continue
                calls.append((tg["address"], cdata("balanceOf", h)))
                meta.append((h, tg["address"]))
        res = ctx.rpc.multicall_soft(calls, block, "nesting", label)
        rows = []
        for (h, tg), (ok, ret) in zip(meta, res):
            v, st = u256(ok, ret)
            if st != "ok":
                if st not in ("empty",):
                    rows.append([h, tg, None, st])
                continue
            if v:
                rows.append([h, tg, v, "ok"])
        store.put(label, {"block": block, "adapters": adapters, "holders": holders, "rows": rows})
    B.run_pool(ctx_pool(ctx), "nesting", labels, task)
    ctx.put("nesting", {"complete": True, "labels": [lab for lab, _ in labels]})


# ---------------------------------------------------------------------------------------------
# Phase: decode (+ share paths)
# ---------------------------------------------------------------------------------------------

EVENT_COLS = ["token", "symbol", "block", "ts", "tx_hash", "tx_index", "log_index", "type", "party1", "party2",
              "party3", "value1", "value2", "value3", "delta1_raw", "delta2_raw", "scaled1", "scaled2",
              "in_universe", "topic0", "data"]
PATH_COLS = ["snapshot", "address", "shares_raw"]


def _fmt(v):
    return "" if v is None else v


def decode_token(ctx: Ctx, t: dict, U: set[str], comet_px: tuple[list[int], list[float]] | None) -> dict:
    a = t["address"]
    kind = t["kind"]
    total = sum(r["n"] for r in ctx.store.index.values() if r["k"][0] == a)
    keep_all = total < SMALL_TOKEN_LOGS
    ddir = ctx.work / "decoded"
    pdir = ctx.work / "paths"
    ddir.mkdir(exist_ok=True)
    pdir.mkdir(exist_ok=True)
    ev_w = G._GzCsv(ddir / f"{a}.csv.gz", EVENT_COLS)
    pa_w = G._GzCsv(pdir / f"{a}.csv.gz", PATH_COLS)
    snaps = snapshot_list(ctx.blocks)
    pb = PathBuilder(snaps, U, lambda lab, ad, v: pa_w.w.writerow([lab, ad, v]))
    stats = {"symbol": t["symbol"], "family": t["family"], "kind": kind, "n_logs": total, "keep_all": keep_all,
             "by_type": {}, "other_known": {}, "unknown_topic0": {}, "unknown_topic0_in_universe": {},
             "decode_errors": 0, "decode_error_examples": [], "kept_rows": 0, "balance_rows_universe": 0,
             "missing_ts": 0}
    ts_missing = []
    for lg in ctx.store.iter_reserve(a):
        topics, data = lg["topics"], lg["data"]
        inu = names_universe(topics, data, U)
        try:
            ev = decode_event(kind, topics, data)
        except DecodeError as e:
            stats["decode_errors"] += 1
            if len(stats["decode_error_examples"]) < 5:
                stats["decode_error_examples"].append({"block": lg["block"], "log_index": lg["log_index"],
                                                       "topic0": topics[0] if topics else None, "error": str(e)})
            ev = {"type": "decode_error", "parties": [], "values": [], "deltas": [], "known": False}
        typ = ev["type"]
        if typ == "unknown":
            stats["unknown_topic0"][topics[0]] = stats["unknown_topic0"].get(topics[0], 0) + 1
            if inu:
                stats["unknown_topic0_in_universe"][topics[0]] = stats["unknown_topic0_in_universe"].get(topics[0], 0) + 1
        elif typ in DECODERS[kind].values() or typ == "decode_error":
            stats["by_type"][typ] = stats["by_type"].get(typ, 0) + 1
        else:
            stats["other_known"][typ] = stats["other_known"].get(typ, 0) + 1
        if lg["ts"] is None:
            stats["missing_ts"] += 1
            ts_missing.append(lg["block"])
        if typ in BALANCE_TYPES[kind]:
            for ad, d, sc in ev["deltas"]:
                if kind == "comet":
                    idx = interp_index(comet_px[0], comet_px[1], lg["block"])
                    sc = int(round(d * COMET_INDEX_SCALE / idx))
                if keep_all or ad in U:
                    stats["balance_rows_universe"] += 1
                pb.apply(lg["block"], ad, sc)
        if not (inu or keep_all):
            continue
        stats["kept_rows"] += 1
        p = ev["parties"] + [None] * (3 - len(ev["parties"]))
        v = ev["values"] + [None] * (3 - len(ev["values"]))
        dl = ev["deltas"] if typ in BALANCE_TYPES[kind] else []
        d1 = dl[0] if len(dl) > 0 else (None, None, None)
        d2 = dl[1] if len(dl) > 1 else (None, None, None)
        unk = typ in ("unknown", "decode_error")
        ev_w.w.writerow([a, t["symbol"], lg["block"], _fmt(lg["ts"]), lg["tx"], lg["tx_index"], lg["log_index"], typ,
                         _fmt(p[0]), _fmt(p[1]), _fmt(p[2]), _fmt(v[0]), _fmt(v[1]), _fmt(v[2]), _fmt(d1[1]),
                         _fmt(d2[1]), _fmt(d1[2]), _fmt(d2[2]), int(inu), topics[0] if unk else "",
                         data if unk and inu else ""])
    pb.finish()
    ev_w.close()
    pa_w.close()
    tracked_ever = pb.ever
    stats.update({"n_universe_addresses_ever_nonzero": len(tracked_ever),
                  "n_negative_paths_universe": len(pb.neg),
                  "negative_examples": sorted(pb.neg)[:5],
                  "ts_missing_blocks": sorted(set(ts_missing))[:20]})
    (ctx.work / "pairs").mkdir(exist_ok=True)
    (ctx.work / "pairs" / f"{a}.json").write_text(json.dumps(sorted(tracked_ever)))
    return stats


def comet_index_series(prices: dict, t: dict) -> tuple[list[int], list[float]]:
    pts = []
    for label, p in prices[t["address"]].items():
        if p and "index" in p:
            pts.append((prices["_block"][label], p["index"]))
    pts.sort()
    if not pts:
        raise B.TerminalError(f"no Comet index points for {t['symbol']}")
    return [b for b, _ in pts], [v for _, v in pts]


def phase_decode(ctx: Ctx) -> None:
    U = set(ctx.universe)
    toks = ctx.selected()
    logs = ctx.get("logs") or {}
    st = ctx.get("decode") or {}
    prices = None
    for t in toks:
        a = t["address"]
        if a in st:
            continue
        if not logs.get(a, {}).get("complete"):
            raise B.TerminalError(f"logs incomplete for {t['symbol']}")
        cpx = None
        if t["kind"] == "comet":
            prices = prices or load_prices(ctx)
            cpx = comet_index_series(prices, t)
        t0_ = time.monotonic()
        s = decode_token(ctx, t, U, cpx)
        s["seconds"] = round(time.monotonic() - t0_, 1)
        st[a] = s
        ctx.put("decode", st)
        print(f"DECODE {t['symbol']} {short(a)}: {s['n_logs']} logs, kept {s['kept_rows']}, "
              f"pairs {s['n_universe_addresses_ever_nonzero']}, unknown {sum(s['unknown_topic0'].values())}, "
              f"errors {s['decode_errors']}, neg {s['n_negative_paths_universe']}", flush=True)


def load_pairs(ctx: Ctx, t: dict) -> list[str]:
    return json.loads((ctx.work / "pairs" / f"{t['address']}.json").read_text())


def load_paths(ctx: Ctx, t: dict, snap_pos: dict[str, int]) -> dict[str, list[tuple[int, int]]]:
    out: dict[str, list[tuple[int, int]]] = {}
    with gzip.open(ctx.work / "paths" / f"{t['address']}.csv.gz", "rt", newline="") as f:
        r = csv.reader(f)
        next(r)
        for lab, ad, v in r:
            out.setdefault(ad, []).append((snap_pos[lab], int(v)))
    return out


# ---------------------------------------------------------------------------------------------
# Phase: anchors (monthly + asof) and Comet daily balances
# ---------------------------------------------------------------------------------------------


def anchor_calls(t: dict, addr: str) -> list[tuple[str, bytes]]:
    a = t["address"]
    if t["kind"].startswith("atoken"):
        return [(a, cdata("balanceOf", addr)), (a, cdata("scaledBalanceOf", addr))]
    if t["kind"] == "comet":
        return [(a, cdata("balanceOf", addr)), (a, cdata("userBasic", addr))]
    return [(a, cdata("balanceOf", addr))]


def phase_anchors(ctx: Ctx) -> None:
    toks = ctx.selected()
    store = B.JsonlStore(ctx.work / "anchors.jsonl")
    pairs = {t["address"]: load_pairs(ctx, t) for t in toks}
    prices = load_prices(ctx)

    def task(x):
        label, block = x
        if store.has(label):
            return
        calls, meta = [], []
        for t in toks:
            if block < t["deploy_exact"]:
                continue
            for ad in pairs[t["address"]]:
                cs = anchor_calls(t, ad)
                calls += cs
                meta.append((t["address"], ad, len(cs)))
        res = ctx.rpc.multicall_soft(calls, block, "anchors", label)
        recs, i, conv, conv_meta = [], 0, [], []
        by = {t["address"]: t for t in toks}
        for ta, ad, n in meta:
            r = res[i:i + n]
            i += n
            t = by[ta]
            v, st = u256(*r[0])
            rec = {"t": ta, "a": ad, "st": st, "bal": v}
            if t["kind"].startswith("atoken"):
                rec["shares"], rec["st2"] = u256(*r[1])
                rec["und"] = v
            elif t["kind"] == "comet":
                ok, ret = r[1]
                rec["shares"] = s256(int.from_bytes(ret[:32], "big")) if ok and len(ret) >= 32 else None
                rec["und"] = v
            elif t["kind"] == "ctoken":
                rec["shares"] = v
                p = prices[ta].get(label)
                rec["und"] = v * p["rate"] // 10**18 if (v is not None and p and "rate" in p) else None
            else:  # erc4626: convertToAssets(balanceOf)
                rec["shares"] = v
                rec["und"] = 0 if v == 0 else None
                if v:
                    conv.append((ta, cdata("convertToAssets", v)))
                    conv_meta.append(len(recs))
            recs.append(rec)
        if conv:
            res2 = ctx.rpc.multicall_soft(conv, block, "anchors", label + ":convert", max_calls=MAX_CALLS_HEAVY)
            for j, (ok, ret) in zip(conv_meta, res2):
                v, st = u256(ok, ret)
                recs[j]["und"] = v
                recs[j]["st2"] = st
        store.put(label, {"block": block, "recs": [[r["t"], r["a"], r["st"], r.get("shares"), r.get("und"),
                                                   r.get("st2")] for r in recs]})
    B.run_pool(ctx_pool(ctx), "anchors", anchor_labels(ctx.blocks), task)
    ctx.put("anchors", {"complete": True, "n_pairs": sum(len(v) for v in pairs.values()),
                        "n_labels": len(anchor_labels(ctx.blocks))})


def phase_comet(ctx: Ctx) -> None:
    toks = [t for t in ctx.selected() if t["kind"] == "comet"]
    store = B.JsonlStore(ctx.work / "comet_daily.jsonl")
    pairs = {t["address"]: load_pairs(ctx, t) for t in toks}
    snaps = snapshot_list(ctx.blocks)

    def task(x):
        label, block = x
        if store.has(label):
            return
        calls, meta = [], []
        for t in toks:
            if block < t["deploy_exact"]:
                continue
            for ad in pairs[t["address"]]:
                calls.append((t["address"], cdata("balanceOf", ad)))
                meta.append((t["address"], ad))
        res = ctx.rpc.multicall_soft(calls, block, "comet", label) if calls else []
        rows = []
        for (ta, ad), (ok, ret) in zip(meta, res):
            v, st = u256(ok, ret)
            if st != "ok" or v:
                rows.append([ta, ad, v, st])
        store.put(label, {"block": block, "n": len(calls), "rows": rows})
    B.run_pool(ctx_pool(ctx), "comet", snaps, task)
    ctx.put("comet", {"complete": True, "n_pairs": {t["symbol"]: len(pairs[t["address"]]) for t in toks}})


# ---------------------------------------------------------------------------------------------
# Phase: gate
# ---------------------------------------------------------------------------------------------


def share_tolerance_ok(kind: str, recon: int, anchor: int | None) -> bool | None:
    """Share-level diagnostic: exact for ERC-4626 / cToken shares; aToken scaled and Comet principal are
    reconstructed with rounding, so +/- (2 units + 1e-6 relative) is accepted."""
    if anchor is None:
        return None
    if kind in ("erc4626", "ctoken"):
        return recon == anchor
    if kind == "comet":
        anchor = max(anchor, 0)
    return abs(recon - anchor) <= 2 + abs(anchor) // 10**6


def phase_gate(ctx: Ctx) -> dict:
    toks = ctx.selected()
    snaps = snapshot_list(ctx.blocks)
    snap_pos = {lab: i for i, (lab, _) in enumerate(snaps)}
    prices = load_prices(ctx)
    astore = B.JsonlStore(ctx.work / "anchors.jsonl")
    labels = anchor_labels(ctx.blocks)
    by = {t["address"]: t for t in toks}
    fam_rows: dict[str, list] = {}
    all_rows: dict[str, list] = {}
    paths = {}
    for lab, block in labels:
        rec = astore.get(lab)
        if rec is None:
            raise B.TerminalError(f"anchors missing for {lab}")
        for ta, ad, st, shares, und, st2 in rec["recs"]:
            t = by[ta]
            if ta not in paths:
                paths[ta] = load_paths(ctx, t, snap_pos)
            sh = path_lookup(paths[ta].get(ad, []), snap_pos[lab])
            p = prices[ta].get(lab)
            recon = underlying_from_shares(t["kind"], sh, p) if (p and "status" not in p) else None
            if und is None or recon is None:
                row = {"t": ta, "a": ad, "lab": lab, "status": f"unreadable({st},{st2},{'price' if recon is None else ''})",
                       "pass": False, "anchor": und, "recon": recon, "shares_recon": sh, "shares_anchor": shares}
            else:
                if und == 0 and recon == 0:
                    continue
                row = {"t": ta, "a": ad, "lab": lab, "status": "ok", "pass": gate_pass(recon, und, t["udec"]),
                       "anchor": und, "recon": recon, "shares_recon": sh, "shares_anchor": shares,
                       "share_ok": share_tolerance_ok(t["kind"], sh, shares)}
            all_rows.setdefault(ta, []).append(row)
    report_tokens = {}
    for t in toks:
        rows = all_rows.get(t["address"], [])
        g = gate_summary(rows)
        big = [r for r in rows if max(abs(r["anchor"] or 0), abs(r["recon"] or 0)) >= 1000 * 10**t["udec"]]
        g["n_ge_1000usd"] = gate_summary(big)
        g["share_level_exact_or_rounding"] = sum(1 for r in rows if r.get("share_ok")) / len(rows) if rows else None
        fails = [r for r in rows if not r["pass"]]
        g["n_fail"] = len(fails)
        g["fail_causes"] = {}
        for r in fails:
            c = ("unreadable" if r["status"] != "ok" else
                 "share_mismatch" if r.get("share_ok") is False else "price_or_rounding")
            g["fail_causes"][c] = g["fail_causes"].get(c, 0) + 1
        fails.sort(key=lambda r: -abs((r["recon"] or 0) - (r["anchor"] or 0)))
        g["worst"] = [{"address": r["a"], "snapshot": r["lab"], "anchor_raw": r["anchor"], "recon_raw": r["recon"],
                       "shares_anchor": r["shares_anchor"], "shares_recon": r["shares_recon"], "status": r["status"]}
                      for r in fails[:10]]
        g["n_pairs_failing"] = len({r["a"] for r in fails})
        g.update({"symbol": t["symbol"], "family": t["family"], "kind": t["kind"], "udec": t["udec"]})
        report_tokens[t["address"]] = g
        fam_rows.setdefault(t["family"], []).extend(rows)
    report_fam = {}
    for f, rows in sorted(fam_rows.items()):
        g = gate_summary(rows)
        g["tokens"] = sorted(by[a]["symbol"] for a in report_tokens if by[a]["family"] == f)
        g["tokens_failing"] = sorted(report_tokens[a]["symbol"] for a in report_tokens
                                     if by[a]["family"] == f and report_tokens[a]["passes"] is False)
        report_fam[f] = g
    rep = {"rule": f"|reconstructed - anchor| <= max(${GATE_ABS_USD}, {GATE_REL_NUM / GATE_REL_DEN:.1%} of anchor) on "
                   f">= {GATE_SHARE:.0%} of nonzero (address, token, snapshot) pairs per family; nonzero = anchor or "
                   "reconstruction != 0 (raw); snapshots = the 45 monthly blocks + asof_b1 (26180400) + asof "
                   "(26186746); reconstruction = share path x the snapshot's share price; an unreadable anchor or "
                   "price counts as a failure",
           "families": report_fam, "tokens": report_tokens,
           "passes_all_families": all(g["passes"] is not False for g in report_fam.values())}
    ctx.put("gate", rep)
    for f, g in report_fam.items():
        print(f"GATE {f}: {g['pass']}/{g['n']} = {g['share']} passes={g['passes']} failing={g['tokens_failing']}",
              flush=True)
    return rep


# ---------------------------------------------------------------------------------------------
# Phase: write
# ---------------------------------------------------------------------------------------------


def safe(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in s).lower()


def _reader(path: Path):
    with gzip.open(path, "rt", newline="") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            yield row


def write_outputs(ctx: Ctx) -> dict:
    out = ctx.out
    out.mkdir(parents=True, exist_ok=True)
    toks = ctx.selected()
    by = {t["address"]: t for t in toks}
    snaps = snapshot_list(ctx.blocks)
    snap_block = dict(snaps)
    files = []
    sel = ctx.get("select")
    for n, info in sel["files"].items():
        if B.sha256_file(out / n) != info["sha256"]:
            raise B.TerminalError(f"{n} changed after selection")
        files.append(n)
    # events per family (merge of per-token decoded files, by block)
    fams: dict[str, list] = {}
    for t in toks:
        fams.setdefault(t["family"], []).append(t)
    for f, ts in sorted(fams.items()):
        files += write_family_events_simple(ctx, out, f, ts)
    # share prices
    prices = load_prices(ctx)
    pb = prices["_block"]

    def price_rows():
        for t in toks:
            labs = sorted((l for l in prices[t["address"]] if l in snap_block or l.startswith("pre:")),
                          key=lambda l: pb[l])
            for l in labs:
                p = prices[t["address"]][l]
                if p is None:
                    continue
                if "status" in p:
                    yield [l, pb[l], t["address"], t["symbol"], t["kind"], "", "", "", p["status"]]
                elif t["kind"] == "erc4626":
                    yield [l, pb[l], t["address"], t["symbol"], t["kind"], "convertToAssets(probe)", p["assets"],
                           p["probe"], "ok"]
                elif t["kind"].startswith("atoken"):
                    yield [l, pb[l], t["address"], t["symbol"], t["kind"], "getReserveNormalizedIncome", p["income"],
                           RAY, "ok"]
                elif t["kind"] == "ctoken":
                    yield [l, pb[l], t["address"], t["symbol"], t["kind"], "exchangeRateStored", p["rate"], 10**18, "ok"]
                else:
                    yield [l, pb[l], t["address"], t["symbol"], t["kind"],
                           f"totalSupply*1e15/totalSupplyBase ({p['totalSupply']}/{p['totalSupplyBase']}; "
                           f"stored baseSupplyIndex {p['baseSupplyIndex']} at {p['lastAccrualTime']})",
                           f"{p['index']:.6f}", COMET_INDEX_SCALE, "ok"]
    B.write_csv(out / "share-price-daily.csv.gz", ["snapshot", "block", "token", "symbol", "kind", "price_basis",
                                                   "price_num", "price_den", "status"], price_rows(), gz=True)
    files.append("share-price-daily.csv.gz")

    # share paths (change points)
    def path_rows():
        for t in toks:
            for lab, ad, v in _reader(ctx.work / "paths" / f"{t['address']}.csv.gz"):
                yield [t["address"], t["symbol"], lab, snap_block[lab], ad, v]
    B.write_csv(out / "share-paths-daily.csv.gz", ["token", "symbol", "snapshot", "block", "address", "shares_raw"],
                path_rows(), gz=True)
    files.append("share-paths-daily.csv.gz")
    # monthly anchors
    astore = B.JsonlStore(ctx.work / "anchors.jsonl")

    def anchor_rows():
        for lab, block in anchor_labels(ctx.blocks):
            for ta, ad, st, shares, und, st2 in astore.get(lab)["recs"]:
                if st == "ok" and not shares and not und and (st2 in (None, "ok")):
                    continue
                yield [lab, block, ta, by[ta]["symbol"], ad, _fmt(shares), _fmt(und), st, _fmt(st2)]
    B.write_csv(out / "monthly-anchors.csv.gz", ["snapshot", "block", "token", "symbol", "address", "shares_raw",
                                                 "underlying_raw", "status", "status2"], anchor_rows(), gz=True)
    files.append("monthly-anchors.csv.gz")
    # Comet daily balances
    if any(t["kind"] == "comet" for t in toks):
        cstore = B.JsonlStore(ctx.work / "comet_daily.jsonl")

        def comet_rows():
            for lab, block in snaps:
                rec = cstore.get(lab)
                if rec is None:
                    continue
                for ta, ad, v, st in rec["rows"]:
                    yield [lab, block, ta, by[ta]["symbol"], ad, _fmt(v), st]
        B.write_csv(out / "comet-balances-daily.csv.gz", ["snapshot", "block", "token", "symbol", "address",
                                                          "balance_raw", "status"], comet_rows(), gz=True)
        files.append("comet-balances-daily.csv.gz")
    # nesting and address flags
    files += write_flags_and_nesting(ctx, out, toks, prices)
    # gate report
    gate = ctx.get("gate")
    (out / "gate-report.json").write_text(json.dumps(gate, indent=1, default=str) + "\n")
    files.append("gate-report.json")
    for n in files:
        if (out / n).stat().st_size > OUT_FILE_MAX_BYTES:
            raise B.TerminalError(f"{n} above the size limit")
    return files


def write_family_events_simple(ctx: Ctx, out: Path, family: str, toks: list[dict]) -> list[str]:
    stem = f"events-{safe(family)}"

    def rows():
        streams = [(((int(r[2]), int(r[6]), r[0]), r) for r in _reader(ctx.work / "decoded" / f"{t['address']}.csv.gz"))
                   for t in toks]
        for _, r in heapq.merge(*streams, key=lambda x: x[0]):
            yield r

    def ts_of(r):
        if not r[3]:
            raise B.TerminalError(f"row without timestamp at block {r[2]}")
        return int(r[3])
    return G.write_partitioned(out, stem, EVENT_COLS, rows, ts_of)


def write_flags_and_nesting(ctx: Ctx, out: Path, toks: list[dict], prices: dict) -> list[str]:
    by_all = {t["address"]: t for t in ctx.roster}
    sel = {t["address"] for t in toks}
    nstore = B.JsonlStore(ctx.work / "nesting.jsonl")
    nest: dict[tuple[str, str], dict] = {}
    adapters_of: dict[str, set] = {}
    for lab, block in anchor_labels(ctx.blocks):
        rec = nstore.get(lab)
        if rec is None:
            continue
        for ad, owners in rec["adapters"].items():
            adapters_of.setdefault(ad, set()).update(owners)
        kinds = dict((h, k) for h, k in rec["holders"])
        for h, tg, v, st in rec["rows"]:
            e = nest.setdefault((h, tg), {"kind": kinds.get(h, ""), "n": 0, "max": 0, "max_at": None, "asof": 0,
                                          "unreadable": 0})
            if st != "ok":
                e["unreadable"] += 1
                continue
            t = by_all[tg]
            if tg in EXCLUDED:
                und = v
            else:
                p = prices[tg].get(lab)
                und = underlying_from_shares(t["kind"], v, p) if (p and "status" not in p) else None
            e["n"] += 1
            if und is not None and und > e["max"]:
                e["max"], e["max_at"] = und, lab
            if lab == "asof" and und is not None:
                e["asof"] = und
    rows = []
    for (h, tg), e in sorted(nest.items()):
        if not e["n"]:
            continue
        ht = by_all.get(h)
        rows.append([h, e["kind"], ht["symbol"] if ht else "", ";".join(sorted(adapters_of.get(h, []))), tg,
                     by_all[tg]["symbol"], int(tg in sel), e["n"], e["max"], _fmt(e["max_at"]), e["asof"]])
    B.write_csv(out / "nesting.csv", ["holder", "holder_kind", "holder_symbol", "adapter_of_vaults", "held_token",
                                      "held_symbol", "held_token_selected", "n_snapshots_nonzero",
                                      "max_underlying_raw", "max_at_snapshot", "asof_underlying_raw"], rows, gz=False)
    nesting_holders = {r[0] for r in rows}
    ctx.put("nesting_summary", {"n_rows": len(rows), "n_holders": len(nesting_holders),
                                "holders_selected_tokens": sorted(by_all[h]["symbol"] for h in nesting_holders if h in by_all),
                                "n_adapter_holders": sum(1 for h in nesting_holders if h in adapters_of)})
    # address flags
    cstore = B.JsonlStore(ctx.work / "codes.jsonl")
    U = ctx.universe
    ntok: dict[str, int] = {}
    for t in toks:
        for ad in load_pairs(ctx, t):
            if ad in U:
                ntok[ad] = ntok.get(ad, 0) + 1
    frows = []
    for a in sorted(U):
        c = cstore.get(a)
        k = code_kind(c) if c else ""
        frows.append([a, int("USDC" in U[a]), int("USDT" in U[a]), "" if not c else int(k == "contract"),
                      "" if not c else int(k == "eip7702"), "" if not c else c["n"], int(a in sel), int(a in by_all),
                      ";".join(sorted(adapters_of.get(a, []))), int(a in nesting_holders), ntok.get(a, 0)])
    B.write_csv(out / "address-flags.csv", ["address", "in_usdc_universe", "in_usdt_universe", "is_contract",
                                            "eip7702_delegated", "code_bytes", "is_selected_token", "is_roster_token",
                                            "morpho_v2_adapter_of", "holds_roster_tokens", "n_selected_tokens_nonzero_path"],
                frows, gz=False)
    return ["nesting.csv", "address-flags.csv"]


def build_run_meta(ctx: Ctx) -> dict:
    sessions = []
    sp = ctx.work / "sessions.jsonl"
    if sp.exists():
        sessions = [json.loads(l) for l in sp.read_text().splitlines() if l.strip()]
    events = []
    if ctx.events_path.exists():
        events = [json.loads(l) for l in ctx.events_path.read_text().splitlines() if l.strip()]
    tot_logs, tot_state = {}, {}
    for s in sessions:
        for src, dst in (("logs_counts", tot_logs), ("state_counts", tot_state)):
            for k, v in (s.get(src) or {}).items():
                if isinstance(v, (int, float)):
                    dst[k] = dst.get(k, 0) + v
                elif isinstance(v, dict):
                    dd = dst.setdefault(k, {})
                    for kk, vv in v.items():
                        dd[kk] = dd.get(kk, 0) + vv
    net = [s for s in sessions if (s.get("logs_counts") or {}).get("requests") or
           (s.get("state_counts") or {}).get("http_requests")]
    ev_counts = {}
    for e in events:
        k = f"{e.get('src', 'state')}:{e.get('type')}:{e.get('kind', '')}"
        ev_counts[k] = ev_counts.get(k, 0) + 1
    return {
        "dataset": DATASET, "inputs": ctx.get("inputs"), "excluded_tokens": EXCLUDED,
        "logs_rpc_url": LOGS_RPC_URL, "state_rpc_url": STATE_RPC_URL, "user_agent": USER_AGENT,
        "multicall3": MULTICALL3,
        "logs_policy": {"range_max": RANGE_MAX, "range_min": RANGE_MIN, "interval_s": LOGS_INTERVAL_S,
                        "workers": LOGS_WORKERS, "target_logs_per_range": TARGET_LOGS_PER_RANGE,
                        "retry_wait_s": RETRY_WAIT_S, "max_retries": MAX_RETRIES,
                        "min_size_retries": MIN_SIZE_RETRIES, "cap_suspect": G.CAP_SUSPECT},
        "state_policy": {"max_requests_per_second": B.MAX_REQUESTS_PER_SECOND, "workers": STATE_WORKERS,
                         "max_calls": MAX_CALLS, "max_calls_heavy": MAX_CALLS_HEAVY, "retry_wait_s": B.RETRY_WAIT_S,
                         "max_retries": B.MAX_RETRIES, "soft_failure": "a multicall error splits the batch in half "
                         "down to one call; a single call that still errors is recorded as failed"},
        "asof": {"logs": ASOF_LOGS, "b1": ASOF_B1, "preflight": (ctx.get("preflight") or {}).get("asof")},
        "code": git_info(),
        "fetch_window_utc": [min((s["start_utc"] for s in net), default=None),
                             max((s.get("end_utc") or "" for s in net), default=None)],
        "selection": {k: v for k, v in (ctx.get("select") or {}).items()},
        "deploy": ctx.get("deploy"), "logs": ctx.get("logs"), "decode": ctx.get("decode"),
        "preflight": {k: v for k, v in (ctx.get("preflight") or {}).items() if k != "sanity"},
        "nesting": ctx.get("nesting_summary"), "anchors": ctx.get("anchors"), "comet": ctx.get("comet"),
        "calls_logs_endpoint": tot_logs, "calls_state_endpoint": tot_state, "event_counts": ev_counts,
        "retry_split_failure_events_sample": [e for e in events if e.get("type") != "split"][:200],
        "sessions": sessions,
    }


def provenance_md(ctx: Ctx, meta: dict, files: dict) -> str:
    g = meta["code"]
    sel = meta["selection"]
    gate = ctx.get("gate") or {}
    lg = meta["calls_logs_endpoint"]
    stc = meta["calls_state_endpoint"]
    pre = (ctx.get("preflight") or {}).get("asof", {})
    sessions = meta["sessions"]
    lines = [
        "# cross-venue — provenance",
        "",
        "Deposit histories of the Q26 depositor universe across USDC/USDT/USDS/DAI lending receipt tokens: TVL-based",
        "token selection, decoded event logs that name a universe address, share-balance paths, daily share prices,",
        "monthly balance anchors and the reconstruction gate. Data acquisition only: the builder computes no outcome",
        "(no withdrawal rates, no exit counts, no lead/lag statistics between venues).",
        "",
        f"- **Sources:** logs by `eth_getLogs` on `{LOGS_RPC_URL}` (free, no key); ranges <= {RANGE_MAX:,} blocks sized to",
        f"  the token's log density (target {TARGET_LOGS_PER_RANGE:,} logs), split in half on any non-rate-limit error",
        f"  down to {RANGE_MIN:,} blocks (an error there: wait 30 s, <= {MIN_SIZE_RETRIES} retries, then stop), <= 2 requests/s",
        "  over all log workers; rate limit: wait 30 s, <= 5 retries, then stop. State (TVL, prices, anchors, nesting,",
        f"  deployment checks, eth_getCode): archive `eth_call` / `eth_getCode` on `{STATE_RPC_URL}` (header",
        f"  `user-agent: {USER_AGENT}`), Multicall3 `{MULTICALL3}` aggregate3 with allowFailure, <= 4 requests/s.",
        f"- **Inputs:** token roster `{Path(meta['inputs']['roster']['path']).name}` (sha256 `{meta['inputs']['roster']['sha256']}`,",
        f"  {meta['inputs']['roster']['n_tokens']} tokens; Aave V3 Core aEthUSDC / aEthUSDT excluded: covered by",
        f"  `depositor-events/`); universe = union of the addresses of `{UNIVERSE_REL}` (sha256",
        f"  `{meta['inputs']['universe']['sha256']}`, {meta['inputs']['universe']['n_addresses_union']} addresses); snapshot",
        f"  blocks `{BLOCKS_REL}` (sha256 `{meta['inputs']['blocks']['sha256']}`).",
        f"- **Asof:** logs and paths to block {ASOF_LOGS} ({pre.get('utc')}, hash `{pre.get('hash_state_endpoint')}`, same",
        f"  hash on both endpoints) = the depositor-events asof; anchors also at {ASOF_B1} (depositor-balances asof).",
        f"- **Builder:** `The-Membrane/membrane-app` branch `{g.get('branch')}`, `{g.get('path')}` (helpers",
        "  `b_acquire.py`, `g_acquire_events.py`). By session (phases: HEAD; builder last commit; builder sha256; status):",
    ]
    for s in sessions:
        c = s.get("code", {})
        lines.append(f"  {', '.join(s.get('phases', []))}: HEAD `{c.get('sha')}`; builder `{c.get('file_last_commit')}`"
                     f"{' (dirty)' if c.get('dirty') else ''} (sha256 `{c.get('file_sha256')}`); status `{s.get('status')}`.")
    fam = sel.get("by_family", {})
    lines += [
        f"- **Fetch window (UTC):** {meta['fetch_window_utc'][0]} → {meta['fetch_window_utc'][1]}.",
        "- **Status:** CANDIDATE (data checks only; not frozen until the parent review). Not committed.",
        f"- **Selection (before any log fetch):** {sel.get('rule')}. {sel.get('n_selected')} of {sel.get('n_roster_used')} "
        "roster tokens: " + ", ".join(f"{k} {v['selected']}/{v['roster']}" for k, v in sorted(fam.items())) + ".",
        "- **Approximation:** underlying balance(t) = share balance after all events in blocks <= the snapshot block ×",
        "  that block's share price (ERC-4626 convertToAssets(10^(decimals+6)) / 10^(decimals+6); aToken",
        "  Pool.getReserveNormalizedIncome (ray); cToken exchangeRateStored / 1e18; Comet: principal × accrued supply",
        "  index, the index taken as totalSupply × 1e15 / totalsBasic.totalSupplyBase and the principal of each Comet",
        "  Transfer as its present value / the index interpolated linearly in block number between daily reads). Comet",
        "  balances are also read directly every day (`comet-balances-daily.csv.gz`) because principal and present value",
        "  differ. aToken share paths are scaled balances (depositor-events G.2: Mint +(value − balanceIncrease), Burn",
        "  −(value + balanceIncrease), BalanceTransfer value·index/1e27 for V3; V2: Mint +value, Burn −value,",
        "  BalanceTransfer ±value, each ÷ index).",
        f"- **Gate:** {gate.get('rule')}.",
        "- **Units:** raw integers (token or underlying base units); USD = underlying / 10^udec (USDC, USDT, USDS, DAI at $1).",
        "",
        "Gate per family: " + "; ".join(f"{f} {g['pass']}/{g['n']} ({(g['share'] or 0):.4f}) "
                                        f"{'PASS' if g['passes'] else ('FAIL' if g['passes'] is False else 'n/a')}"
                                        for f, g in sorted((gate.get('families') or {}).items())) + ".",
        "",
        f"Logs endpoint: {lg.get('requests', 0)} requests, {lg.get('logs', 0)} logs, {lg.get('splits', 0)} splits, "
        f"{lg.get('rate_limit_retries', 0)} rate-limit retries, {lg.get('min_size_retries', 0)} min-size retries, "
        f"{lg.get('failures', 0)} failures. State endpoint: {stc.get('http_requests', 0)} requests, "
        f"{stc.get('retries', 0)} retries, {stc.get('multicall_splits', 0)} multicall splits, "
        f"{stc.get('failures', 0)} failures.",
        "",
        "Formats:",
        "- `tvl-monthly.csv`: TVL per roster token and monthly snapshot (`status` not_deployed = no code / no data).",
        "- `selected-tokens.csv`: the selection, written before any log was fetched (sha256 recorded in run-log).",
        "- `events-<family>[-<period>].csv.gz`: decoded logs that name a universe address in an indexed topic or a",
        "  data word (`in_universe` = 1), plus every log of tokens with < 50,000 logs. `delta1_raw`/`delta2_raw` =",
        "  balance change of party1/party2 in the token's balance unit (shares; aToken underlying per G.2; Comet",
        "  present value); `scaled1`/`scaled2` = change in share units (aToken scaled; empty for Comet). Only balance",
        "  types carry deltas (Transfer for ERC-4626 / cToken / Comet; Mint / Burn / BalanceTransfer for aTokens).",
        "  `topic0`/`data` are filled for unknown topic0 only.",
        "- `share-price-daily.csv.gz`: price_num / price_den per token and snapshot (daily 00:00Z blocks, asof_b1,",
        "  asof; Comet also `pre:<block>` reads before 2023-02-01).",
        "- `share-paths-daily.csv.gz`: change points of each (token, universe address) share balance at the snapshots",
        "  (the value holds until the next row; before the first row the balance is 0).",
        "- `monthly-anchors.csv.gz`: on-chain balances at the 45 monthly blocks + asof_b1 + asof for every pair with a",
        "  nonzero share path at any time (zero rows omitted): shares (balanceOf; aToken scaledBalanceOf; Comet",
        "  userBasic.principal) and underlying (roster method).",
        "- `comet-balances-daily.csv.gz`: Comet balanceOf at every snapshot for every Comet pair (zero rows omitted).",
        "- `nesting.csv`: roster tokens held by selected tokens and by Morpho V2 adapters (max underlying over the",
        "  monthly + asof snapshots).",
        "- `address-flags.csv`: eth_getCode at the asof block (is_contract excludes EIP-7702 delegation designators),",
        "  roster / adapter membership, number of selected tokens with a nonzero path.",
        "",
        "| file | bytes | sha256 |",
        "|---|---:|---|",
    ]
    for n in sorted(files):
        lines.append(f"| `{n}` | {files[n]['bytes']} | `{files[n]['sha256']}` |")
    return "\n".join(lines) + "\n"


def phase_write(ctx: Ctx) -> dict:
    names = write_outputs(ctx)
    meta = build_run_meta(ctx)
    (ctx.out / "run-log.json").write_text(json.dumps(meta, indent=1, default=str) + "\n")
    names.append("run-log.json")
    keep = set(names)
    files = {n: {"bytes": (ctx.out / n).stat().st_size, "sha256": B.sha256_file(ctx.out / n)} for n in sorted(keep)}
    (ctx.out / "PROVENANCE.md").write_text(provenance_md(ctx, meta, files))
    for p in ctx.out.iterdir():
        if p.is_file() and p.name not in keep and p.name != "PROVENANCE.md":
            print(f"WRITE note: stray file {p.name} left untouched", flush=True)
    return files


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

PHASES = ("preflight", "tvl", "deploy", "logs", "prices", "codes", "nesting", "decode", "anchors", "comet", "gate",
          "write")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--roster", default=None)
    ap.add_argument("--phases", required=True)
    ap.add_argument("--tokens", default=None, help="test runs only: comma-separated token addresses")
    ap.add_argument("--logs-first", default="", help="comma-separated token addresses fetched first")
    args = ap.parse_args(argv)
    ddir = B.datasets_dir()
    out = Path(args.out_dir) if args.out_dir else ddir / DATASET
    ctx = Ctx(Path(args.work_dir), out, ddir, Path(args.roster) if args.roster else None)
    if ctx.roster_path is None:
        ap.error("--roster is required on the first run")
    if args.tokens:
        ctx.only_tokens = {B.norm_address(a) for a in args.tokens.split(",")}
    ctx.logs_first = [B.norm_address(a) for a in args.logs_first.split(",") if a.strip()]
    import signal

    def _term(signum, frame):
        raise B.TerminalError(f"signal {signum}")
    signal.signal(signal.SIGTERM, _term)
    phases = PHASES if args.phases == "all" else tuple(p.strip() for p in args.phases.split(","))
    for p in phases:
        if p not in PHASES:
            ap.error(f"unknown phase {p}")
    session = {"start_utc": utcnow(), "code": git_info(), "phases": list(phases), "phase_seconds": {}, "pid": os.getpid(),
               "only_tokens": sorted(ctx.only_tokens) if ctx.only_tokens else None}
    status = "ok"
    try:
        for p in phases:
            t_0 = time.monotonic()
            print(f"PHASE {p} start {utcnow()}", flush=True)
            if p == "write":
                session["status"] = "ok (write)"
                session["end_utc"] = utcnow()
                session["state_counts"] = ctx.rpc.counts
                session["logs_counts"] = ctx.logs_counts
                _append_session(ctx, session, provisional=True)
                info = phase_write(ctx)
                print("FILES " + json.dumps(info), flush=True)
            else:
                {"preflight": phase_preflight, "tvl": phase_tvl, "deploy": phase_deploy, "logs": phase_logs,
                 "prices": phase_prices, "codes": phase_codes, "nesting": phase_nesting, "decode": phase_decode,
                 "anchors": phase_anchors, "comet": phase_comet, "gate": phase_gate}[p](ctx)
            session["phase_seconds"][p] = round(time.monotonic() - t_0, 1)
    except B.TerminalError as e:
        status = f"stopped: {e}"
        print(f"STOPPED {e}", flush=True)
    finally:
        session["end_utc"] = utcnow()
        session["state_counts"] = ctx.rpc.counts
        session["logs_counts"] = ctx.logs_counts
        session["status"] = status
        if "write" not in phases:
            _append_session(ctx, session)
    return 0 if status == "ok" else 2


def _append_session(ctx: Ctx, session: dict, provisional: bool = False) -> None:
    with ctx.lock:
        with open(ctx.work / "sessions.jsonl", "a") as f:
            f.write(json.dumps(session, default=str) + "\n")


if __name__ == "__main__":
    sys.exit(main())
