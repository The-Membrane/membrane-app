"""Aid-test reader check (the study's external check for aavev2.py / compv2.py records).

Per venue: 100 (user, day) pairs drawn with numpy default_rng(20261018) (a fresh generator per venue, venue
order aave-v2-eth then comp-v2-eth) uniformly without replacement from all record rows 2021-01-01..2022-12-31
(every row is a user with debt). Each pair is compared against archive eth_call at that day's snapshot block:

  Aave V2   LendingPool.getUserAccountData(user) -> totalCollateralETH, totalDebtETH, availableBorrowsETH,
            currentLiquidationThreshold, ltv, healthFactor. Record totals are converted to ETH with the same
            Chainlink ETH/USD answer the record used. Note the contract truncates the value-weighted
            liquidation threshold to integer bps before computing healthFactor (GenericLogic), so the
            on-chain HF differs from the exact weighted HF by up to 1/LT_bps (~1.2e-4); we report the raw
            comparison and the comparison with the record's weighted LT truncated the same way.
  Compound  Comptroller.getAccountLiquidity(account) -> (error, liquidity, shortfall) and per-market
            CToken.borrowBalanceStored(account). On-chain debt = sum price*borrowBalanceStored/1e36 with the
            snapshot's oracle prices (same oracle the comptroller reads); on-chain weighted collateral
            = liquidity - shortfall + debt; HF = weighted collateral / debt.

Output: /home/user/q39work/aid-reader-check.json
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from rpc import Client, enc_addr, selector, words  # noqa: E402
import v2common as v2  # noqa: E402

WORK = os.environ.get("Q39_WORK", "/home/user/q39work")
SEED = 20261018
TOL = (1e-4, 1e-3, 1e-2)


def load_rows(venue):
    d = os.path.join(WORK, venue, "positions")
    users = json.load(open(os.path.join(WORK, venue, "users.json")))
    out = []
    for fn in sorted(os.listdir(d), key=lambda f: int(f.split(".")[0])):
        ts = int(fn.split(".")[0])
        if not (1609459200 <= ts <= 1672444800):
            continue
        arr = np.load(os.path.join(d, fn))
        for k in range(len(arr)):
            out.append((ts, k))
    return out, users


def draw(venue):
    rows, users = load_rows(venue)
    rng = np.random.default_rng(SEED)
    pick = sorted(rng.choice(len(rows), 100, replace=False))
    cache = {}
    res = []
    for p in pick:
        ts, k = rows[p]
        if ts not in cache:
            cache[ts] = np.load(os.path.join(WORK, venue, "positions", f"{ts}.npy"))
        rec = cache[ts][k]
        res.append((ts, users[int(rec["user"])], rec))
    return res


def rel(a, b):
    if b == 0:
        return 0.0 if a == 0 else float("inf")
    return abs(a - b) / abs(b)


def summarize(errs):
    e = np.array(errs, dtype=float)
    return {f"within_{t:g}": float(np.mean(e <= t)) for t in TOL} | {"max": float(np.max(e)),
                                                                      "median": float(np.median(e))}


def check_aave():
    meta = json.load(open(os.path.join(WORK, "aave-v2-eth", "meta.json")))
    c = Client("ethereum")
    sel = selector("getUserAccountData(address)")
    out = []
    for ts, u, rec in draw("aave-v2-eth"):
        st = json.load(open(os.path.join(WORK, "aave-v2-eth", "state", f"{ts}.json")))
        w = words(c.eth_call(meta["pool"], sel + enc_addr(u), st["block"]))
        coll_eth, debt_eth, _, lt_bps, ltv, hf = w[:6]
        eth = st["eth_usd"] / 1e8
        V = rec["VE"] + rec["VB"] + rec["VO"]
        S = rec["VE"] * rec["ltE"] + rec["VB"] * rec["ltB"] + rec["VO"] * rec["ltO"]
        D = rec["DE"] + rec["DB"] + rec["DO"]
        lt_trunc = np.floor(S / V * 1e4 + 1e-9) if V > 0 else 0.0
        hf_trunc = V * lt_trunc / 1e4 / D
        out.append({"day": ts, "block": st["block"], "user": u,
                    "rec_coll_eth": V / eth, "chain_coll_eth": coll_eth / 1e18,
                    "rec_debt_eth": D / eth, "chain_debt_eth": debt_eth / 1e18,
                    "rec_lt_bps": S / V * 1e4 if V > 0 else 0.0, "chain_lt_bps": lt_bps,
                    "rec_hf": float(rec["hf"]), "rec_hf_lt_truncated": hf_trunc, "chain_hf": hf / 1e18,
                    "err_coll": rel(V / eth, coll_eth / 1e18), "err_debt": rel(D / eth, debt_eth / 1e18),
                    "err_hf": rel(float(rec["hf"]), hf / 1e18), "err_hf_lt_truncated": rel(hf_trunc, hf / 1e18)})
    return {"pairs": out, "summary": {k: summarize([p[k] for p in out])
                                      for k in ("err_hf", "err_hf_lt_truncated", "err_coll", "err_debt")},
            "rpc_requests": c.n_requests}


def check_comp():
    meta = json.load(open(os.path.join(WORK, "comp-v2-eth", "meta.json")))
    c = Client("ethereum")
    cm = meta["comptroller"]
    s_liq = selector("getAccountLiquidity(address)")
    s_bb = selector("borrowBalanceStored(address)")
    out = []
    for ts, u, rec in draw("comp-v2-eth"):
        st = json.load(open(os.path.join(WORK, "comp-v2-eth", "state", f"{ts}.json")))
        blk = st["block"]
        live = [i for i in range(len(meta["markets"])) if str(i) in st["markets"]]
        calls = [(cm, s_liq + enc_addr(u))] + [(meta["markets"][i]["cToken"], s_bb + enc_addr(u)) for i in live]
        res = v2.multicall(c, calls, blk)
        if res[0] is None:     # oracle reverts (cETH, 2022-08-31..09-07): getAccountLiquidity reverts
            err, liq, short = -1, 0, 0
        else:
            err, liq, short = words(res[0])[:3]
        debt = 0
        per = {}
        for i, r in zip(live, res[1:]):
            bb = v2.w0(r) or 0
            px = int(st["markets"][str(i)]["price"] or 0)
            debt += bb * px // 10**18      # mul_ScalarTruncate(price, borrowBalance)
            if bb:
                per[meta["markets"][i]["symbol"] + "/" + meta["markets"][i]["usym"]] = bb
        wcoll = liq - short + debt
        S = rec["VE"] * rec["ltE"] + rec["VB"] * rec["ltB"] + rec["VO"] * rec["ltO"]
        D = rec["DE"] + rec["DB"] + rec["DO"]
        chain_hf = wcoll / debt if debt and err == 0 else float("nan")
        out.append({"day": ts, "block": blk, "user": u, "error_code": err,
                    "rec_wcoll_usd": S, "chain_wcoll_usd": wcoll / 1e18,
                    "rec_debt_usd": D, "chain_debt_usd": debt / 1e18, "chain_borrow_balances": per,
                    "rec_hf": float(rec["hf"]), "chain_hf": chain_hf,
                    "err_wcoll": rel(S, wcoll / 1e18) if err == 0 else None, "err_debt": rel(D, debt / 1e18),
                    "err_hf": rel(float(rec["hf"]), chain_hf) if err == 0 else None})
    ok = [p for p in out if p["error_code"] == 0]
    return {"pairs": out, "n_liquidity_unavailable": len(out) - len(ok),
            "summary": {k: summarize([p[k] for p in (ok if k != "err_debt" else out)])
                        for k in ("err_hf", "err_wcoll", "err_debt")},
            "rpc_requests": c.n_requests}


def main():
    path = os.path.join(WORK, "aid-reader-check.json")
    rep = json.load(open(path)) if os.path.exists(path) else {}
    rep["design"] = {"seed": SEED, "pairs_per_venue": 100, "span": [1609459200, 1672444800],
                     "tolerances": list(TOL), "note": __doc__}
    for venue, fn in (("aave-v2-eth", check_aave), ("comp-v2-eth", check_comp)):
        if len(sys.argv) > 1 and venue not in sys.argv[1:]:
            continue
        rep[venue] = fn()
        print(venue, json.dumps(rep[venue]["summary"], indent=1), flush=True)
        json.dump(rep, open(path, "w"), indent=1)


if __name__ == "__main__":
    main()
