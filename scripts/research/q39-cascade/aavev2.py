"""Aave V2 Ethereum main market: event replay to daily position records (aid-test span 2021-01-01..2022-12-31).

Same record schema as aave.py (aave.REC_FIELDS), same deviation D1 (positions rebuilt from token events; the
reader check in aidcheck.py compares the rebuild against archive getUserAccountData).

Event semantics, verified against aave/protocol-v2 master (fetched 2026-10-18):
  AToken.sol / IAToken.sol
    Mint(from, value, index)                 mint(): _mint(user, amount.rayDiv(index)); value is UNSCALED
    Burn(from, target, value, index)         burn(): _burn(user, amount.rayDiv(index))
    BalanceTransfer(from, to, value, index)  _transfer(): super._transfer(from, to, amount.rayDiv(index));
                                             also emitted by transferOnLiquidation (receiveAToken liquidations)
    mintToTreasury emits Mint(treasury, ...) with the same rule. The plain ERC20 Transfer that accompanies
    each of these is NOT used (it would double count).
  VariableDebtToken.sol / IVariableDebtToken.sol
    Mint(from, onBehalfOf, value, index)     _mint(onBehalfOf, amount.rayDiv(index))
    Burn(user, amount, index)                _burn(user, amount.rayDiv(index))
  rayDiv is half-up: (a*1e27 + b//2)//b (WadRayMath.sol), so scaled balances are reproduced exactly.
  StableDebtToken.sol / IStableDebtToken.sol (per-user principal P, rate r, timestamp t;
  balanceOf = P.rayMul(MathUtils.calculateCompoundedInterest(r, t, now))):
    borrow  mint():  _mint(onBehalfOf, amount + balanceIncrease) -> P' = currentBalance + amount;
                     emits Transfer(0, onBehalfOf, amount) immediately before
                     Mint(user, onBehalfOf, amount, currentBalance, balanceIncrease, newRate, avgRate, supply)
    repay   burn():  if balanceIncrease > repay: _mint(user, balanceIncrease - repay), emits
                     Mint(user, user, amountToMint, currentBalance, balanceIncrease, userRate, ...)
                     -> P' = currentBalance - balanceIncrease + amountToMint;
                     else _burn(user, repay - balanceIncrease), emits
                     Burn(user, amountToBurn, currentBalance, balanceIncrease, avgRate, supply)
                     -> P' = currentBalance - balanceIncrease - amountToBurn; r = 0 when fully repaid.
    The two Mint paths are told apart by the Transfer-from-zero log at logIndex-1 (borrow path only).
    t' = block timestamp of the event (log field blockTimestamp, else eth_getBlockByNumber).
    With (P, r, t) and the snapshot block timestamp the stable balance is reproduced exactly (no
    approximation of intra-period accrual).
  LendingPool.sol / LendingPoolCollateralManager.sol: ReserveUsedAsCollateralEnabled/Disabled are emitted on
    every change of the usingAsCollateral bit (first deposit, first aToken receipt, explicit toggle, balance
    to zero on withdraw/transfer/seizure), so the bit is replayed from those events.
  GenericLogic.calculateUserAccountData: collateral counts reserves with usingAsCollateral and
    liquidationThreshold != 0; debt = stable + variable balanceOf; prices are oracle getAssetPrice (ETH wei).
    USD = ETH value * Chainlink ETH/USD latestAnswer at the same block (the ratio cancels in hf).
Exception: aSTETH (Lido AStETH) and aAMPL (AAmplToken) are rebasing aTokens whose Mint/Burn/BalanceTransfer
units are not plain liquidity-index scaled; their collateral balances are read with balanceOf at the snapshot
block (see SPECIAL_SYMS). Their debt tokens are standard (stETH is not borrowable; AMPL debt checked exact).
Liquidation (LendingPoolCollateralManager): close factor fixed 50% (LIQUIDATION_CLOSE_FACTOR_PERCENT = 5000),
bonus multiplier = configuration bonus / 1e4, no protocol fee in V2 -> feeX = 0.
"""
from __future__ import annotations

import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from aave import REC_FIELDS, _decode_string, conf_fields, deploy_block, iter_logs, ray_div, ray_mul  # noqa: E402
from rpc import Client, Reverted, RpcError, enc_addr, selector, to_addr, topic, words  # noqa: E402
import v2common as v2  # noqa: E402

PROVIDER = "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5"
RAY = 10**27
SECONDS_PER_YEAR = 365 * 86400
CLOSE_FACTOR = 0.5

T_RESERVE_INIT = topic("ReserveInitialized(address,address,address,address,address)")
T_A_MINT = topic("Mint(address,uint256,uint256)")
T_A_BURN = topic("Burn(address,address,uint256,uint256)")
T_BXFER = topic("BalanceTransfer(address,address,uint256,uint256)")
T_V_MINT = topic("Mint(address,address,uint256,uint256)")
T_V_BURN = topic("Burn(address,uint256,uint256)")
T_S_MINT = topic("Mint(address,address,uint256,uint256,uint256,uint256,uint256,uint256)")
T_S_BURN = topic("Burn(address,uint256,uint256,uint256,uint256,uint256)")
T_TRANSFER = topic("Transfer(address,address,uint256)")
T_COLL_ON = topic("ReserveUsedAsCollateralEnabled(address,address)")
T_COLL_OFF = topic("ReserveUsedAsCollateralDisabled(address,address)")
T_LIQ = topic("LiquidationCall(address,address,address,uint256,uint256,address,bool)")
ZERO32 = "0x" + "0" * 64


def _addr_call(c, to, sig, block="latest"):
    return to_addr(words(c.eth_call(to, selector(sig), block))[0])


def discover(work: str, to_block: int) -> dict:
    path = os.path.join(work, "meta.json")
    if os.path.exists(path):
        return json.load(open(path))
    c = Client("ethereum")
    pool = _addr_call(c, PROVIDER, "getLendingPool()")
    meta = {"market": "aave-v2-eth", "chain": "ethereum", "provider": PROVIDER.lower(), "pool": pool,
            "oracle": _addr_call(c, PROVIDER, "getPriceOracle()"),
            "configurator": _addr_call(c, PROVIDER, "getLendingPoolConfigurator()"),
            "close_factor": CLOSE_FACTOR, "to_block": to_block}
    meta["pool_deploy_block"] = deploy_block(c, pool)
    reserves = []
    for lg in c.get_logs(meta["configurator"], [T_RESERVE_INIT], meta["pool_deploy_block"], to_block, step=2_000_000):
        w = words(lg["data"])
        reserves.append({"asset": to_addr(int(lg["topics"][1], 16)), "aToken": to_addr(int(lg["topics"][2], 16)),
                         "sDebt": to_addr(w[0]), "vDebt": to_addr(w[1]), "init_block": int(lg["blockNumber"], 16)})
    for r in reserves:
        try:
            r["decimals"] = words(c.eth_call(r["asset"], selector("decimals()")))[0]
        except (Reverted, RpcError):
            r["decimals"] = None
        try:
            r["symbol"] = _decode_string(c.eth_call(r["asset"], selector("symbol()")))
        except (Reverted, RpcError):
            r["symbol"] = "?"
    meta["reserves"] = reserves
    json.dump(meta, open(path, "w"), indent=1)
    return meta


# --------------------------------------------------------------------------------------- logs
def fetch_logs(meta: dict, work: str, to_block: int, step=500_000):
    """Rows (block, logIndex, kind, ...), sorted, in resumable chunk files work/logs/*.jsonl.gz:
      aM/aB  ri user value index          aX ri from to value index
      vM/vB  ri user value index
      sM     ri user P' rate ts            sB ri user P' ts       (P' = stable principal after the event)
      CON/COFF ri user                     LIQ coll debt user debtToCover collAmount liquidator tx"""
    c = Client("ethereum")
    tokens = {}
    for i, r in enumerate(meta["reserves"]):
        tokens[r["aToken"].lower()] = (i, "a")
        tokens[r["vDebt"].lower()] = (i, "v")
        tokens[r["sDebt"].lower()] = (i, "s")
    addrs = sorted(tokens)
    groups = [addrs[i:i + 40] for i in range(0, len(addrs), 40)]
    stable = sorted(r["sDebt"].lower() for r in meta["reserves"])
    rs = {r["asset"].lower(): i for i, r in enumerate(meta["reserves"])}
    os.makedirs(os.path.join(work, "logs"), exist_ok=True)
    tsc: dict = {}
    a = meta["pool_deploy_block"]
    while a <= to_block:
        b = min(to_block, a + step - 1)
        out = os.path.join(work, "logs", f"{a:010d}-{b:010d}.jsonl.gz")
        if os.path.exists(out):
            a = b + 1
            continue
        mint_xfer = {(int(lg["blockNumber"], 16), int(lg["logIndex"], 16), lg["address"].lower())
                     for lg in c.get_logs(stable, [T_TRANSFER, ZERO32], a, b, step=step)}
        rows = []
        for g in groups:
            for lg in c.get_logs(g, [[T_A_MINT, T_A_BURN, T_BXFER, T_V_MINT, T_V_BURN, T_S_MINT, T_S_BURN]],
                                 a, b, step=step):
                addr = lg["address"].lower()
                ri, kind = tokens[addr]
                t0 = lg["topics"][0]
                w = words(lg["data"])
                tp = [to_addr(int(x, 16)) for x in lg["topics"][1:]]
                bl, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
                if kind == "a" and t0 == T_A_MINT:
                    row = ["aM", ri, tp[0], w[0], w[1]]
                elif kind == "a" and t0 == T_A_BURN:
                    row = ["aB", ri, tp[0], w[0], w[1]]
                elif kind == "a" and t0 == T_BXFER:
                    row = ["aX", ri, tp[0], tp[1], w[0], w[1]]
                elif kind == "v" and t0 == T_V_MINT:
                    row = ["vM", ri, tp[1], w[0], w[1]]
                elif kind == "v" and t0 == T_V_BURN:
                    row = ["vB", ri, tp[0], w[0], w[1]]
                elif kind == "s" and t0 == T_S_MINT:
                    amt, cur, inc, rate = w[0], w[1], w[2], w[3]
                    borrow = (bl, li - 1, addr) in mint_xfer
                    p = cur + amt if borrow else cur - inc + amt
                    row = ["sM", ri, tp[1], p, rate, v2.log_ts(c, lg, tsc)]
                elif kind == "s" and t0 == T_S_BURN:
                    amt, cur, inc = w[0], w[1], w[2]
                    row = ["sB", ri, tp[0], cur - inc - amt, v2.log_ts(c, lg, tsc)]
                else:
                    continue
                rows.append([bl, li] + row)
        for lg in c.get_logs(meta["pool"], [[T_COLL_ON, T_COLL_OFF, T_LIQ]], a, b, step=step):
            t0 = lg["topics"][0]
            bl, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
            if t0 in (T_COLL_ON, T_COLL_OFF):
                rows.append([bl, li, "CON" if t0 == T_COLL_ON else "COFF",
                             rs.get(to_addr(int(lg["topics"][1], 16)), -1), to_addr(int(lg["topics"][2], 16))])
            else:
                w = words(lg["data"])
                rows.append([bl, li, "LIQ", rs.get(to_addr(int(lg["topics"][1], 16)), -1),
                             rs.get(to_addr(int(lg["topics"][2], 16)), -1), to_addr(int(lg["topics"][3], 16)),
                             w[0], w[1], to_addr(w[2]), lg["transactionHash"]])
        rows.sort(key=lambda r: (r[0], r[1]))
        tmp = out + ".tmp"
        with gzip.open(tmp, "wt") as f:
            for r in rows:
                f.write(json.dumps([str(x) if isinstance(x, int) and abs(x) > 2**53 else x for x in r]) + "\n")
        os.replace(tmp, out)
        print(f"[aave-v2-eth] logs {a}-{b}: {len(rows)} rows  (rpc {c.n_requests})", flush=True)
        a = b + 1


# --------------------------------------------------------------------------------- daily state
SIG_INCOME = selector("getReserveNormalizedIncome(address)")
SIG_VDEBT = selector("getReserveNormalizedVariableDebt(address)")
SIG_CONF = selector("getConfiguration(address)")
SIG_PRICE = selector("getAssetPrice(address)")


def daily_state(meta: dict, work: str, days: dict[int, int]):
    """Per snapshot day (one multicall): block timestamp, Chainlink ETH/USD, and per live reserve normalized
    income, normalized variable debt, configuration bitmap, oracle price (ETH wei). Cached per day."""
    c = Client("ethereum")
    d = os.path.join(work, "state")
    os.makedirs(d, exist_ok=True)
    pool, orc = meta["pool"], meta["oracle"]
    from rpc import MULTICALL3
    for ts, blk in sorted(days.items()):
        out = os.path.join(d, f"{ts}.json")
        if os.path.exists(out) or blk < meta["pool_deploy_block"]:
            continue
        live = [(i, r) for i, r in enumerate(meta["reserves"]) if r["init_block"] <= blk]
        calls = [(MULTICALL3, v2.S_BLOCK_TS), (v2.CHAINLINK_ETH_USD, v2.S_LATEST_ANSWER)]
        for i, r in live:
            ad = enc_addr(r["asset"])
            calls += [(pool, SIG_INCOME + ad), (pool, SIG_VDEBT + ad), (pool, SIG_CONF + ad), (orc, SIG_PRICE + ad)]
        res = v2.multicall(c, calls, blk, chunk=120)
        st = {"block": blk, "ts": v2.w0(res[0]), "eth_usd": v2.w0(res[1]), "reserves": {}}
        k = 2
        for i, r in live:
            inc, vd, conf, px = res[k:k + 4]
            k += 4
            st["reserves"][str(i)] = {
                "income": str(words(inc)[0]) if inc else None,
                "vdebt": str(words(vd)[0]) if vd else None,
                "conf": str(words(conf)[0]) if conf else None,
                "price": str(words(px)[0]) if px else None,
            }
        json.dump(st, open(out, "w"))
    print(f"[aave-v2-eth] daily state done (rpc {c.n_requests})", flush=True)


# ------------------------------------------------------------------------------------- replay
from classes import asset_class  # noqa: E402


def compounded_interest(rate: int, last_ts: int, now: int) -> int:
    """MathUtils.calculateCompoundedInterest (Aave V2), integer-exact."""
    exp = now - last_ts
    if exp <= 0:
        return RAY
    em1 = exp - 1
    em2 = exp - 2 if exp > 2 else 0
    rps = rate // SECONDS_PER_YEAR
    p2 = ray_mul(rps, rps)
    p3 = ray_mul(p2, rps)
    return RAY + rps * exp + exp * em1 * p2 // 2 + exp * em1 * em2 * p3 // 6


def stable_balance(p: int, rate: int, t: int, now: int) -> int:
    return ray_mul(p, compounded_interest(rate, t, now)) if p > 0 else 0


class Book:
    """Replayed per-user state: A scaled aToken, V scaled variable debt, S stable (P, rate, ts), coll bits."""

    def __init__(self):
        self.A: dict[str, dict[int, int]] = {}
        self.V: dict[str, dict[int, int]] = {}
        self.S: dict[str, dict[int, tuple]] = {}
        self.coll: dict[str, set] = {}

    def apply(self, r):
        kind = r[2]
        if kind in ("aM", "aB", "vM", "vB"):
            ri, u, amt, idx = r[3], r[4], r[5], r[6]
            d = ray_div(amt, idx)
            if kind[1] == "B":
                d = -d
            bu = (self.A if kind[0] == "a" else self.V).setdefault(u, {})
            bu[ri] = bu.get(ri, 0) + d
        elif kind == "aX":
            ri, u1, u2, amt, idx = r[3], r[4], r[5], r[6], r[7]
            s = ray_div(amt, idx)
            self.A.setdefault(u1, {})[ri] = self.A.setdefault(u1, {}).get(ri, 0) - s
            self.A.setdefault(u2, {})[ri] = self.A.setdefault(u2, {}).get(ri, 0) + s
        elif kind == "sM":
            self.S.setdefault(r[4], {})[r[3]] = (r[5], r[6], r[7])
        elif kind == "sB":
            ri, u, p, t = r[3], r[4], r[5], r[6]
            old = self.S.setdefault(u, {}).get(ri, (0, 0, 0))
            self.S[u][ri] = (p, old[1] if p > 0 else 0, t)
        elif kind == "CON":
            self.coll.setdefault(r[4], set()).add(r[3])
        elif kind == "COFF":
            self.coll.setdefault(r[4], set()).discard(r[3])

    def debtors(self):
        us = {u for u, dv in self.V.items() if any(x > 0 for x in dv.values())}
        us |= {u for u, dv in self.S.items() if any(x[0] > 0 for x in dv.values())}
        return us


# Rebasing aTokens whose events are not in the standard units (spot check 2026-10-18 at block 16301023: all
# 120 sampled standard aToken/vDebt/sDebt balances matched exactly; aSTETH (Lido AStETH, balance also scales
# with the stETH share rate) and aAMPL (AAmplToken) did not). Their collateral balances are read with
# aToken.balanceOf(user) at the snapshot block for every debtor whose collateral bit is set (cached).
SPECIAL_SYMS = {"stETH", "AMPL"}


def special_balances(meta, work, st, ts, book: Book, debtors) -> dict:
    """{user: {ri: balanceOf}} for SPECIAL_SYMS aTokens, cached in work/special/<ts>.json."""
    d = os.path.join(work, "special")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{ts}.json")
    if os.path.exists(path):
        return {u: {int(k): int(v) for k, v in dv.items()} for u, dv in json.load(open(path)).items()}
    R = meta["reserves"]
    sp = [i for i, r in enumerate(R) if r["symbol"] in SPECIAL_SYMS and str(i) in st["reserves"]]
    pairs = [(u, ri) for u in sorted(debtors) for ri in sp
             if ri in book.coll.get(u, set()) and ri in book.A.get(u, {})]
    out: dict = {}
    if pairs:
        c = Client("ethereum")
        res = v2.multicall(c, [(R[ri]["aToken"], selector("balanceOf(address)") + enc_addr(u)) for u, ri in pairs],
                           st["block"])
        for (u, ri), r in zip(pairs, res):
            if r is None:
                raise RpcError(f"special balanceOf failed {u} {ri} at {st['block']}")
            out.setdefault(u, {})[ri] = v2.w0(r)
    json.dump({u: {str(k): str(v) for k, v in dv.items()} for u, dv in out.items()}, open(path, "w"))
    return out


def position(meta, cls, st, book: Book, u: str, special: dict | None = None):
    """(V, S(lt*V), LB(bonus*V), D, dmaxO) for one user at state `st` (USD). `special` overrides the
    collateral balance of SPECIAL_SYMS aTokens with balanceOf read at the snapshot block."""
    R = meta["reserves"]
    eth = st["eth_usd"] / 1e8
    rs = st["reserves"]
    now = st["ts"]
    D = {"E": 0.0, "B": 0.0, "O": 0.0}
    per_res_debt: dict[int, float] = {}
    for ri in set(book.V.get(u, {})) | set(book.S.get(u, {})):
        v = rs.get(str(ri))
        if not v or v["price"] is None or v["vdebt"] is None:
            continue
        amt = 0
        s = book.V.get(u, {}).get(ri, 0)
        if s > 0:
            amt += ray_mul(s, int(v["vdebt"]))
        p, rate, t = book.S.get(u, {}).get(ri, (0, 0, 0))
        amt += stable_balance(p, rate, t, now)
        if amt <= 0:
            continue
        val = amt / 10 ** R[ri]["decimals"] * int(v["price"]) / 1e18 * eth
        D[cls[ri]] += val
        per_res_debt[ri] = val
    dmaxo = max([x for ri, x in per_res_debt.items() if cls[ri] == "O"], default=0.0)
    V_ = {"E": 0.0, "B": 0.0, "O": 0.0}
    S_ = {"E": 0.0, "B": 0.0, "O": 0.0}
    LB_ = {"E": 0.0, "B": 0.0, "O": 0.0}
    cu = book.coll.get(u, set())
    sp_ri = {i for i, r in enumerate(R) if r["symbol"] in SPECIAL_SYMS}
    for ri, s in book.A.get(u, {}).items():
        if ri in sp_ri:
            s = None
        v = rs.get(str(ri))
        if ri in cu and s is None:
            bal = (special or {}).get(u, {}).get(ri, 0)
        else:
            bal = None
        if ((s is None and not bal) or (s is not None and s <= 0) or ri not in cu or not v or v["price"] is None
                or v["conf"] is None or v["income"] is None):
            continue
        f = conf_fields(int(v["conf"]))
        if f["lt"] == 0:
            continue
        amt = bal if s is None else ray_mul(s, int(v["income"]))
        val = amt / 10 ** R[ri]["decimals"] * int(v["price"]) / 1e18 * eth
        c = cls[ri]
        V_[c] += val
        S_[c] += val * f["lt"] / 1e4
        LB_[c] += val * f["bonus"] / 1e4
    return V_, S_, LB_, D, dmaxo


def replay(meta: dict, work: str, days: dict[int, int]):
    """Replay events; at each snapshot day write work/positions/<day_ts>.npy (one row per user with debt;
    user = index into work/users.json). Events inside the snapshot block are included (end-of-block state,
    which is what eth_call at that block returns)."""
    import numpy as np
    out_dir = os.path.join(work, "positions")
    os.makedirs(out_dir, exist_ok=True)
    R = meta["reserves"]
    cls = [asset_class("ethereum", r["symbol"]) for r in R]
    book = Book()
    uid: dict[str, int] = {}
    sched = sorted((b, ts) for ts, b in days.items() if b >= meta["pool_deploy_block"])
    si = 0
    dtype = np.dtype([(f, "f8") for f in REC_FIELDS])

    def snapshot(ts):
        st = json.load(open(os.path.join(work, "state", f"{ts}.json")))
        rows = []
        debtors = book.debtors()
        special = special_balances(meta, work, st, ts, book, debtors)
        for u in sorted(debtors):
            V_, S_, LB_, D, dmaxo = position(meta, cls, st, book, u, special)
            dt = D["E"] + D["B"] + D["O"]
            if dt <= 0:
                continue
            hf = (S_["E"] + S_["B"] + S_["O"]) / dt
            if u not in uid:
                uid[u] = len(uid)
            q = lambda num, c, dflt: num[c] / V_[c] if V_[c] > 0 else dflt
            rows.append((uid[u], V_["E"], V_["B"], V_["O"], q(S_, "E", 0.0), q(S_, "B", 0.0), q(S_, "O", 0.0),
                         q(LB_, "E", 1.0), q(LB_, "B", 1.0), q(LB_, "O", 1.05), 0.0, 0.0, 0.0,
                         D["E"], D["B"], D["O"], dmaxo, hf))
        np.save(os.path.join(out_dir, f"{ts}.npy"), np.array(rows, dtype=dtype))

    def flush_until(block):
        nonlocal si
        while si < len(sched) and sched[si][0] < block:
            snapshot(sched[si][1])
            si += 1

    for r in iter_logs(work):
        flush_until(r[0])
        book.apply(r)
    flush_until(10**12)
    json.dump(sorted(uid, key=uid.get), open(os.path.join(work, "users.json"), "w"))


# ------------------------------------------------------------------------------------- driver
WORK = os.path.join(os.environ.get("Q39_WORK", "/home/user/q39work"), "aave-v2-eth")
START_TS, END_TS = 1609459200, 1672444800


def main():
    import argparse
    from acquire import load_days
    ap = argparse.ArgumentParser()
    ap.add_argument("--phases", default="discover,logs,state,replay")
    a = ap.parse_args()
    os.makedirs(WORK, exist_ok=True)
    days = {k: v for k, v in load_days("ethereum", START_TS).items() if k <= END_TS}
    assert len(days) == (END_TS - START_TS) // 86400 + 1, "ethereum day blocks incomplete"
    to_block = days[END_TS]
    meta = discover(WORK, to_block)
    print("aave-v2-eth pool", meta["pool"], "deployed", meta["pool_deploy_block"], "reserves", len(meta["reserves"]),
          flush=True)
    ph = a.phases.split(",")
    if "logs" in ph:
        fetch_logs(meta, WORK, to_block)
    if "state" in ph:
        daily_state(meta, WORK, days)
    if "replay" in ph:
        replay(meta, WORK, days)


if __name__ == "__main__":
    main()
