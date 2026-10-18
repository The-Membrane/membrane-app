"""Morpho Blue (Ethereum, Base): event replay to daily position records (prereg C.2.1, deviation D1).

Each (borrower, market) is one isolated position. Collateral is exact from SupplyCollateral /
WithdrawCollateral / Liquidate. Borrow shares are exact from Borrow / Repay / Liquidate. Assets per share
and the oracle price are read by eth_call at each snapshot block: market(id) and IOracle(oracle).price().
Only markets whose collateral is ETH- or BTC-linked and whose loan token is neither are kept (C.1).
Loan tokens are valued at the chain's Aave oracle price when Aave lists them, else at $1 for a USD
stablecoin symbol, else the market is dropped and counted.
"""
from __future__ import annotations

import gzip
import json
import os

from classes import asset_class
from rpc import Client, Reverted, RpcError, enc_uint, selector, to_addr, topic, words

MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"
DEPLOY = {"ethereum": 18883124, "base": 13977148}

T_CREATE = topic("CreateMarket(bytes32,(address,address,address,address,uint256))")
T_SUPC = topic("SupplyCollateral(bytes32,address,address,uint256)")
T_WITHC = topic("WithdrawCollateral(bytes32,address,address,address,uint256)")
T_BORROW = topic("Borrow(bytes32,address,address,address,uint256,uint256)")
T_REPAY = topic("Repay(bytes32,address,address,uint256,uint256)")
T_LIQ = topic("Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)")

USD_STABLES = {"USDC", "USDT", "DAI", "USDS", "PYUSD", "USDE", "USDC.E", "USDBC", "FRAX", "LUSD", "GHO", "CRVUSD",
               "RLUSD", "USDA", "EUSD", "USD0", "USDT0", "USR", "DOLA", "MKUSD", "USDQ", "USD₮0", "AUSD", "FDUSD"}


def _sym(c, a):
    try:
        raw = c.eth_call(a, selector("symbol()"))
        b = bytes.fromhex(raw[2:])
        if len(b) == 32:
            return b.rstrip(b"\0").decode(errors="replace")
        off = int.from_bytes(b[0:32], "big")
        ln = int.from_bytes(b[off:off + 32], "big")
        return b[off + 32: off + 32 + ln].decode(errors="replace")
    except (Reverted, RpcError, ValueError):
        return "?"


def _dec(c, a):
    try:
        return words(c.eth_call(a, selector("decimals()")))[0]
    except (Reverted, RpcError):
        return None


def fetch(chain: str, work: str, to_block: int, step=200_000):
    c = Client(chain)
    os.makedirs(os.path.join(work, "logs"), exist_ok=True)
    a = DEPLOY[chain]
    while a <= to_block:
        b = min(to_block, a + step - 1)
        out = os.path.join(work, "logs", f"{a:010d}-{b:010d}.jsonl.gz")
        if os.path.exists(out):
            a = b + 1
            continue
        rows = []
        for lg in c.get_logs(MORPHO, [[T_CREATE, T_SUPC, T_WITHC, T_BORROW, T_REPAY, T_LIQ]], a, b, step=step):
            t0, tp = lg["topics"][0], lg["topics"]
            w = words(lg["data"])
            bl, li = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
            mid = tp[1]
            if t0 == T_CREATE:
                rows.append([bl, li, "C", mid, to_addr(w[0]), to_addr(w[1]), to_addr(w[2]), to_addr(w[3]), w[4]])
            elif t0 == T_SUPC:
                rows.append([bl, li, "SC", mid, to_addr(int(tp[3], 16)), w[0]])
            elif t0 == T_WITHC:
                rows.append([bl, li, "WC", mid, to_addr(int(tp[2], 16)), w[1]])
            elif t0 == T_BORROW:
                rows.append([bl, li, "B", mid, to_addr(int(tp[2], 16)), w[1], w[2]])
            elif t0 == T_REPAY:
                rows.append([bl, li, "R", mid, to_addr(int(tp[3], 16)), w[0], w[1]])
            else:
                rows.append([bl, li, "L", mid, to_addr(int(tp[3], 16)), w[0], w[1], w[2], w[3], w[4],
                             to_addr(int(tp[2], 16)), lg["transactionHash"]])
        rows.sort(key=lambda r: (r[0], r[1]))
        tmp = out + ".tmp"
        with gzip.open(tmp, "wt") as f:
            for r in rows:
                f.write(json.dumps([str(x) if isinstance(x, int) and abs(x) > 2**53 else x for x in r]) + "\n")
        os.replace(tmp, out)
        print(f"[morpho-{chain}] logs {a}-{b}: {len(rows)} rows (rpc {c.n_requests})", flush=True)
        a = b + 1


def iter_logs(work):
    d = os.path.join(work, "logs")
    for fn in sorted(os.listdir(d)):
        if fn.endswith(".jsonl.gz"):
            with gzip.open(os.path.join(d, fn), "rt") as f:
                for line in f:
                    r = json.loads(line)
                    yield [int(x) if isinstance(x, str) and x.isdigit() else x for x in r]


def markets(chain: str, work: str, aave_meta: dict | None) -> dict:
    """Relevant markets with token metadata. Cached."""
    p = os.path.join(work, "markets.json")
    if os.path.exists(p):
        return json.load(open(p))
    c = Client(chain)
    aave_assets = {r["asset"].lower() for r in (aave_meta or {}).get("reserves", [])}
    out, dropped = {}, {"class": 0, "loan_unpriced": 0}
    for r in iter_logs(work):
        if r[2] != "C":
            continue
        mid, loan, coll, orc, irm, lltv = r[3], r[4], r[5], r[6], r[7], r[8]
        cs, ls = _sym(c, coll), _sym(c, loan)
        ccl, lcl = asset_class(chain, cs), asset_class(chain, ls)
        if ccl == "O" or lcl != "O" or orc == "0x0000000000000000000000000000000000000000":
            dropped["class"] += 1
            continue
        priced = "aave" if loan.lower() in aave_assets else ("usd1" if ls.upper() in USD_STABLES else None)
        if priced is None:
            dropped["loan_unpriced"] += 1
            continue
        out[mid] = {"loan": loan, "coll": coll, "oracle": orc, "lltv": lltv, "csym": cs, "lsym": ls, "cls": ccl,
                    "cdec": _dec(c, coll), "ldec": _dec(c, loan), "loan_price": priced, "created": r[0]}
    json.dump({"markets": out, "dropped": dropped}, open(p, "w"), indent=1)
    return {"markets": out, "dropped": dropped}


SIG_MARKET = selector("market(bytes32)")
SIG_PRICE = selector("price()")
SIG_AAVE_PRICE = selector("getAssetPrice(address)")


def daily_state(chain: str, work: str, days: dict[int, int], mk: dict, aave_oracle: str | None):
    c = Client(chain)
    d = os.path.join(work, "state")
    os.makedirs(d, exist_ok=True)
    M = mk["markets"]
    for ts, blk in sorted(days.items()):
        out = os.path.join(d, f"{ts}.json")
        if os.path.exists(out) or blk < DEPLOY[chain]:
            continue
        live = [m for m, v in M.items() if v["created"] <= blk]
        calls = []
        for m in live:
            calls += [(MORPHO, SIG_MARKET + m[2:]), (M[m]["oracle"], SIG_PRICE)]
        loans = sorted({M[m]["loan"] for m in live if M[m]["loan_price"] == "aave"})
        if aave_oracle:
            calls += [(aave_oracle, SIG_AAVE_PRICE + w.lower().replace("0x", "").rjust(64, "0")) for w in loans]
        res = c.multicall(calls, blk, chunk=150)
        st = {"block": blk, "m": {}, "loanpx": {}}
        for i, m in enumerate(live):
            mr, pr = res[2 * i], res[2 * i + 1]
            if mr is None or pr is None:
                continue
            w = words(mr)
            st["m"][m] = {"tba": str(w[2]), "tbs": str(w[3]), "price": str(words(pr)[0])}
        k = 2 * len(live)
        for j, l in enumerate(loans):
            r = res[k + j]
            if r:
                st["loanpx"][l.lower()] = int.from_bytes(r[:32], "big") / 1e8
        json.dump(st, open(out + ".tmp", "w"))
        os.replace(out + ".tmp", out)
    print(f"[morpho-{chain}] daily state done (rpc {c.n_requests})", flush=True)


from aave import REC_FIELDS  # noqa: E402  (shared family schema)


def lif(lltv: int) -> float:
    return min(1.15, 1.0 / (0.3 * lltv / 1e18 + 0.7))


def replay(chain: str, work: str, days: dict[int, int], mk: dict):
    import numpy as np
    M = mk["markets"]
    out_dir = os.path.join(work, "positions")
    os.makedirs(out_dir, exist_ok=True)
    coll: dict[tuple, int] = {}
    shares: dict[tuple, int] = {}
    uid: dict[str, int] = {}
    sched = sorted((b, ts) for ts, b in days.items() if b >= DEPLOY[chain])
    si = 0
    dtype = np.dtype([(f, "f8") for f in REC_FIELDS] + [("market", "i8")])
    mids = sorted(M)
    midx = {m: i for i, m in enumerate(mids)}

    def snapshot(ts):
        st = json.load(open(os.path.join(work, "state", f"{ts}.json")))
        rows = []
        for (m, u), s in shares.items():
            if s <= 0 or m not in st["m"]:
                continue
            v = M[m]
            ms = st["m"][m]
            tba, tbs = int(ms["tba"]), int(ms["tbs"])
            if tbs == 0:
                continue
            borrowed = s * tba / tbs / 10 ** v["ldec"]
            lpx = st["loanpx"].get(v["loan"].lower(), 1.0) if v["loan_price"] == "aave" else 1.0
            debt_usd = borrowed * lpx
            cu = coll.get((m, u), 0)
            # collateral value in loan units: coll * price / 1e36 (price scaled by 1e36 * 10^(ldec - cdec))
            cval = cu * int(ms["price"]) / 1e36 / 10 ** v["ldec"] * lpx
            lt = v["lltv"] / 1e18
            if debt_usd <= 0:
                continue
            if u not in uid:
                uid[u] = len(uid)
            E = v["cls"] == "E"
            lb = lif(v["lltv"])
            rows.append((uid[u], cval if E else 0.0, 0.0 if E else cval, 0.0, lt if E else 0.0, 0.0 if E else lt, 0.0,
                         lb if E else 1.0, 1.0 if E else lb, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, debt_usd, debt_usd,
                         cval * lt / debt_usd, midx[m]))
        arr = np.array(rows, dtype=dtype)
        # model population only (decision D6n): shock-linked collateral and >= $1 of debt
        arr = arr[(arr["VE"] + arr["VB"] > 0) & (arr["DE"] + arr["DB"] + arr["DO"] >= 1.0)] if len(arr) else arr
        np.save(os.path.join(out_dir, f"{ts}.npy"), arr)

    def flush_until(block):
        nonlocal si
        while si < len(sched) and sched[si][0] < block:
            ts = sched[si][1]
            if not os.path.exists(os.path.join(out_dir, f"{ts}.npy")):
                snapshot(ts)
            si += 1

    for r in iter_logs(work):
        blk, kind, m = r[0], r[2], r[3]
        flush_until(blk)
        if m not in M:
            continue
        u = r[4]
        if u not in uid:
            uid[u] = len(uid)
        if kind == "SC":
            coll[(m, u)] = coll.get((m, u), 0) + r[5]
        elif kind == "WC":
            coll[(m, u)] = coll.get((m, u), 0) - r[5]
        elif kind == "B":
            shares[(m, u)] = shares.get((m, u), 0) + r[6]
        elif kind == "R":
            shares[(m, u)] = shares.get((m, u), 0) - r[6]
        elif kind == "L":
            # repaidShares r[6], seizedAssets r[7], badDebtShares r[9]
            shares[(m, u)] = shares.get((m, u), 0) - r[6] - r[9]
            coll[(m, u)] = coll.get((m, u), 0) - r[7]
    flush_until(10**12)
    json.dump({"users": sorted(uid, key=uid.get), "markets": mids}, open(os.path.join(work, "index.json"), "w"))
