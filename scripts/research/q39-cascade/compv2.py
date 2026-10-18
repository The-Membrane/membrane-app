"""Compound V2 (Ethereum): event replay to daily position records (aid-test span 2021-01-01..2022-12-31).

Same record schema as aave.py (aave.REC_FIELDS); positions rebuilt from events (deviation D1), checked by
aidcheck.py against archive Comptroller.getAccountLiquidity and CToken.borrowBalanceStored.

Event semantics, verified against compound-finance/compound-protocol master (fetched 2026-10-18):
  CTokenInterfaces.sol
    Transfer(address indexed from, address indexed to, uint amount)  every accountTokens change emits one:
      mintFresh   -> Transfer(cToken, minter, mintTokens)     (Mint event is NOT used: no double count)
      redeemFresh -> Transfer(redeemer, cToken, redeemTokens)  (Redeem event is NOT used)
      transferTokens -> Transfer(src, dst, tokens)
      seizeInternal  -> Transfer(borrower, liquidator, liquidatorSeizeTokens) and, since the
                        protocolSeizeShare upgrade, Transfer(borrower, cToken, protocolSeizeTokens)
    So cToken balance = sum(in) - sum(out) over Transfer logs (the cToken address itself is a pseudo-account).
    Borrow(borrower, borrowAmount, accountBorrows, totalBorrows)              (all non-indexed)
    RepayBorrow(payer, borrower, repayAmount, accountBorrows, totalBorrows)  (liquidateBorrowFresh emits it too)
      -> accountBorrows[borrower] = {principal: accountBorrows, interestIndex: market borrowIndex}
    AccrueInterest(cashPrior, interestAccumulated, borrowIndex, totalBorrows)  (current)
    AccrueInterest(interestAccumulated, borrowIndex, totalBorrows)             (2019 cTokens, e.g. cETH)
      accrueInterest() returns early without an event when accrualBlockNumber == block.number, so the
      interestIndex of a Borrow/RepayBorrow is the borrowIndex of the LAST AccrueInterest of that cToken in
      log order (same or earlier block), not necessarily one in the same transaction.
  CToken.borrowBalanceStoredInternal: principal * borrowIndex / interestIndex (integer), read with the stored
    borrowIndex() at the snapshot block -> exact.
  Comptroller.sol: MarketEntered(CToken cToken, address account), MarketExited(...) (non-indexed). Borrowing
    auto-enters the market (borrowAllowed -> addToMarketInternal emits MarketEntered); exitMarket requires
    zero borrow. getHypotheticalAccountLiquidityInternal sums, over accountAssets (entered markets):
    collateral += collateralFactor * exchangeRateStored * price * cTokenBalance, debt += price * borrowBalance.
    Oracle getUnderlyingPrice(cToken) is USD scaled 1e(36 - underlying decimals). lt = collateralFactor.
Liquidation: close factor = closeFactorMantissa (0.5 in 2021-22), bonus multiplier lbX =
  liquidationIncentiveMantissa / 1e18 (one value for all markets). Protocol fee: CToken.seizeInternal takes
  protocolSeizeShareMantissa of ALL seized cTokens (2.8% where present; 0 on cTokens without the getter).
  callrule.m_call_vec defines fee = (seized - seized/lb) * fee_k (Aave V3: share of the bonus), so the
  record stores the equivalent fee_k = share * lb / (lb - 1), value-weighted per family.
"""
from __future__ import annotations

import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from aave import REC_FIELDS, _decode_string, deploy_block, iter_logs  # noqa: E402
from rpc import Client, Reverted, RpcError, enc_addr, selector, to_addr, topic, words  # noqa: E402
import v2common as v2  # noqa: E402

COMPTROLLER = "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B"

T_TRANSFER = topic("Transfer(address,address,uint256)")
T_BORROW = topic("Borrow(address,uint256,uint256,uint256)")
T_REPAY = topic("RepayBorrow(address,address,uint256,uint256,uint256)")
T_ACCRUE4 = topic("AccrueInterest(uint256,uint256,uint256,uint256)")
T_ACCRUE3 = topic("AccrueInterest(uint256,uint256,uint256)")
T_LIQ = topic("LiquidateBorrow(address,address,uint256,address,uint256)")
T_ENTER = topic("MarketEntered(address,address)")
T_EXIT = topic("MarketExited(address,address)")


def discover(work: str, to_block: int) -> dict:
    path = os.path.join(work, "meta.json")
    if os.path.exists(path):
        return json.load(open(path))
    c = Client("ethereum")
    r = words(c.eth_call(COMPTROLLER, selector("getAllMarkets()"), to_block))
    markets = []
    for w in r[2:2 + r[1]]:
        ct = to_addr(w)
        m = {"cToken": ct, "symbol": _decode_string(c.eth_call(ct, selector("symbol()")))}
        try:
            m["underlying"] = to_addr(words(c.eth_call(ct, selector("underlying()")))[0])
        except (Reverted, RpcError):
            m["underlying"] = None
        if m["underlying"] is None:
            m["usym"], m["udec"] = "ETH", 18
        else:
            m["udec"] = words(c.eth_call(m["underlying"], selector("decimals()")))[0]
            m["usym"] = _decode_string(c.eth_call(m["underlying"], selector("symbol()")))
        m["deploy_block"] = deploy_block(c, ct)
        markets.append(m)
    meta = {"market": "comp-v2-eth", "chain": "ethereum", "comptroller": COMPTROLLER.lower(), "markets": markets,
            "comptroller_deploy_block": deploy_block(c, COMPTROLLER), "to_block": to_block}
    json.dump(meta, open(path, "w"), indent=1)
    return meta


# --------------------------------------------------------------------------------------- logs
def fetch_logs(meta: dict, work: str, to_block: int, step=250_000):
    """Rows (block, logIndex, kind, ...) in resumable chunk files work/logs/*.jsonl.gz:
      T ci from to amount;  BI ci borrowIndex;  BR ci borrower accountBorrows;
      ME/MX ci account;     LQ ci(debt) borrower repayAmount ci(collateral) seizeTokens liquidator tx"""
    c = Client("ethereum")
    ci = {m["cToken"].lower(): i for i, m in enumerate(meta["markets"])}
    addrs = sorted(ci)
    os.makedirs(os.path.join(work, "logs"), exist_ok=True)
    a = meta["comptroller_deploy_block"]
    while a <= to_block:
        b = min(to_block, a + step - 1)
        out = os.path.join(work, "logs", f"{a:010d}-{b:010d}.jsonl.gz")
        if os.path.exists(out):
            a = b + 1
            continue
        rows = []
        for lg in c.get_logs(addrs, [[T_TRANSFER, T_BORROW, T_REPAY, T_ACCRUE4, T_ACCRUE3, T_LIQ]], a, b,
                             step=step, min_step=50):
            i = ci[lg["address"].lower()]
            t0 = lg["topics"][0]
            w = words(lg["data"])
            bl, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
            if t0 == T_TRANSFER:
                row = ["T", i, to_addr(int(lg["topics"][1], 16)), to_addr(int(lg["topics"][2], 16)), w[0]]
            elif t0 == T_ACCRUE4:
                row = ["BI", i, w[2]]
            elif t0 == T_ACCRUE3:
                row = ["BI", i, w[1]]
            elif t0 == T_BORROW:
                row = ["BR", i, to_addr(w[0]), w[2]]
            elif t0 == T_REPAY:
                row = ["BR", i, to_addr(w[1]), w[3]]
            else:
                row = ["LQ", i, to_addr(w[1]), w[2], ci.get(to_addr(w[3]), -1), w[4], to_addr(w[0]),
                       lg["transactionHash"]]
            rows.append([bl, li] + row)
        for lg in c.get_logs(meta["comptroller"], [[T_ENTER, T_EXIT]], a, b, step=step):
            w = words(lg["data"])
            rows.append([int(lg["blockNumber"], 16), int(lg["logIndex"], 16),
                         "ME" if lg["topics"][0] == T_ENTER else "MX", ci.get(to_addr(w[0]), -1), to_addr(w[1])])
        rows.sort(key=lambda r: (r[0], r[1]))
        tmp = out + ".tmp"
        with gzip.open(tmp, "wt") as f:
            for r in rows:
                f.write(json.dumps([str(x) if isinstance(x, int) and abs(x) > 2**53 else x for x in r]) + "\n")
        os.replace(tmp, out)
        print(f"[comp-v2-eth] logs {a}-{b}: {len(rows)} rows  (rpc {c.n_requests})", flush=True)
        a = b + 1


# --------------------------------------------------------------------------------- daily state
S_ORACLE = selector("oracle()")
S_CLOSE = selector("closeFactorMantissa()")
S_INCENT = selector("liquidationIncentiveMantissa()")
S_MARKETS = selector("markets(address)")
S_EXRATE = selector("exchangeRateStored()")
S_BINDEX = selector("borrowIndex()")
S_SHARE = selector("protocolSeizeShareMantissa()")
S_PRICE = selector("getUnderlyingPrice(address)")


def daily_state(meta: dict, work: str, days: dict[int, int]):
    """Per snapshot day: comptroller oracle/closeFactor/incentive; per listed cToken exchangeRateStored,
    borrowIndex, collateralFactor, protocolSeizeShare (None if absent), oracle price. Cached per day."""
    c = Client("ethereum")
    d = os.path.join(work, "state")
    os.makedirs(d, exist_ok=True)
    cm = meta["comptroller"]
    for ts, blk in sorted(days.items()):
        out = os.path.join(d, f"{ts}.json")
        if os.path.exists(out):
            continue
        h = v2.multicall(c, [(cm, S_ORACLE), (cm, S_CLOSE), (cm, S_INCENT)], blk)
        orc = to_addr(v2.w0(h[0]))
        live = [(i, m) for i, m in enumerate(meta["markets"]) if m["deploy_block"] <= blk]
        calls = []
        for i, m in live:
            ct = m["cToken"]
            calls += [(ct, S_EXRATE), (ct, S_BINDEX), (cm, S_MARKETS + enc_addr(ct)), (ct, S_SHARE),
                      (orc, S_PRICE + enc_addr(ct))]
        res = v2.multicall(c, calls, blk, chunk=125)
        st = {"block": blk, "oracle": orc, "close_factor": str(v2.w0(h[1])), "incentive": str(v2.w0(h[2])),
              "markets": {}}
        k = 0
        for i, m in live:
            ex, bi, mk, sh, px = res[k:k + 5]
            k += 5
            mw = words(mk) if mk else None
            st["markets"][str(i)] = {
                "exrate": str(v2.w0(ex)) if ex else None, "bindex": str(v2.w0(bi)) if bi else None,
                "listed": bool(mw[0]) if mw else False, "cf": str(mw[1]) if mw else None,
                "share": str(v2.w0(sh)) if sh else None, "price": str(v2.w0(px)) if px else None,
            }
        json.dump(st, open(out, "w"))
    print(f"[comp-v2-eth] daily state done (rpc {c.n_requests})", flush=True)


# ------------------------------------------------------------------------------------- replay
from classes import asset_class  # noqa: E402


class Book:
    """Replayed state: cToken balances, borrow snapshots (principal, interestIndex), memberships."""

    def __init__(self, n):
        self.tok: dict[str, dict[int, int]] = {}
        self.bor: dict[str, dict[int, tuple]] = {}
        self.mem: dict[str, set] = {}
        self.bidx = [10**18] * n   # CToken.initialize: borrowIndex = mantissaOne

    def apply(self, r):
        k = r[2]
        if k == "T":
            i, f, t, amt = r[3], r[4], r[5], r[6]
            self.tok.setdefault(f, {})[i] = self.tok.setdefault(f, {}).get(i, 0) - amt
            self.tok.setdefault(t, {})[i] = self.tok.setdefault(t, {}).get(i, 0) + amt
        elif k == "BI":
            self.bidx[r[3]] = r[4]
        elif k == "BR":
            i, u, p = r[3], r[4], r[5]
            self.bor.setdefault(u, {})[i] = (p, self.bidx[i])
        elif k == "ME":
            self.mem.setdefault(r[4], set()).add(r[3])
        elif k == "MX":
            self.mem.setdefault(r[4], set()).discard(r[3])

    def debtors(self):
        return {u for u, dv in self.bor.items() if any(p > 0 for p, _ in dv.values())}


def borrow_stored(p: int, ii: int, bindex: int) -> int:
    return p * bindex // ii if p > 0 and ii > 0 else 0


def position(meta, cls, st, book: Book, u: str):
    """USD collateral/debt by family for one account; integer-exact per-market amounts (Comptroller math)."""
    M = meta["markets"]
    ms = st["markets"]
    D = {"E": 0.0, "B": 0.0, "O": 0.0}
    per = {}
    for i, (p, ii) in book.bor.get(u, {}).items():
        s = ms.get(str(i))
        if p <= 0 or not s or not s["price"] or not s["bindex"]:
            continue
        val = borrow_stored(p, ii, int(s["bindex"])) * int(s["price"]) / 1e36
        D[cls[i]] += val
        per[i] = val
    dmaxo = max([x for i, x in per.items() if cls[i] == "O"], default=0.0)
    lb = int(st["incentive"]) / 1e18
    V_ = {"E": 0.0, "B": 0.0, "O": 0.0}
    S_ = {"E": 0.0, "B": 0.0, "O": 0.0}
    FE_ = {"E": 0.0, "B": 0.0, "O": 0.0}
    for i in book.mem.get(u, set()):
        s = ms.get(str(i))
        bal = book.tok.get(u, {}).get(i, 0)
        if bal <= 0 or not s or not s["price"] or not s["exrate"] or not s["cf"]:
            continue
        cf = int(s["cf"]) / 1e18
        if cf == 0:
            continue
        val = bal * int(s["exrate"]) / 1e18 * int(s["price"]) / 1e36
        share = int(s["share"]) / 1e18 if s["share"] else 0.0
        c = cls[i]
        V_[c] += val
        S_[c] += val * cf
        FE_[c] += val * (share * lb / (lb - 1) if lb > 1 else 0.0)
    return V_, S_, FE_, D, dmaxo, lb


def replay(meta: dict, work: str, days: dict[int, int]):
    """Replay events; at each snapshot day write work/positions/<day_ts>.npy (one row per account with a
    positive borrow; user = index into work/users.json). End-of-block state at the snapshot block."""
    import numpy as np
    out_dir = os.path.join(work, "positions")
    os.makedirs(out_dir, exist_ok=True)
    M = meta["markets"]
    cls = [asset_class("ethereum", m["usym"]) for m in M]
    book = Book(len(M))
    uid: dict[str, int] = {}
    sched = sorted((b, ts) for ts, b in days.items())
    si = 0
    dtype = np.dtype([(f, "f8") for f in REC_FIELDS])

    def snapshot(ts):
        st = json.load(open(os.path.join(work, "state", f"{ts}.json")))
        rows = []
        for u in sorted(book.debtors()):
            V_, S_, FE_, D, dmaxo, lb = position(meta, cls, st, book, u)
            dt = D["E"] + D["B"] + D["O"]
            if dt <= 0:
                continue
            hf = (S_["E"] + S_["B"] + S_["O"]) / dt
            if u not in uid:
                uid[u] = len(uid)
            q = lambda num, c, dflt: num[c] / V_[c] if V_[c] > 0 else dflt
            rows.append((uid[u], V_["E"], V_["B"], V_["O"], q(S_, "E", 0.0), q(S_, "B", 0.0), q(S_, "O", 0.0),
                         lb, lb, lb, q(FE_, "E", 0.0), q(FE_, "B", 0.0), q(FE_, "O", 0.0),
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
WORK = os.path.join(os.environ.get("Q39_WORK", "/home/user/q39work"), "comp-v2-eth")
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
    print("comp-v2-eth markets", [(m["symbol"], m["usym"]) for m in meta["markets"]], flush=True)
    ph = a.phases.split(",")
    if "logs" in ph:
        fetch_logs(meta, WORK, to_block)
    if "state" in ph:
        daily_state(meta, WORK, days)
    if "replay" in ph:
        replay(meta, WORK, days)


if __name__ == "__main__":
    main()
