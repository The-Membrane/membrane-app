"""Free chain reads for slice 1: reserve tables, USDC reserve state, accounts with USDC debt, e-mode, DEX depth.

Archive eth_call through Multicall3 (b_acquire.Rpc), eth_getLogs through l1_acquire_cash.Client (range split on
error). Addresses are opaque keys in memory; acquire.py writes them only to the local work directory, never to a
published file.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import b_acquire as B  # noqa: E402
import l1_acquire_cash as L1  # noqa: E402
import r118_acquire as A  # noqa: E402
from c1_baddebt import chain as C1C  # noqa: E402  (Uniswap v3 pool state and factory lookup)

from sim1 import config as CFG  # noqa: E402

SIG = {
    "getReservesList": "getReservesList()",
    "getReserveData": "getReserveData(address)",
    "getAssetPrice": "getAssetPrice(address)",
    "symbol": "symbol()",
    "decimals": "decimals()",
    "totalSupply": "totalSupply()",
    "balanceOf": "balanceOf(address)",
    "getVirtualUnderlyingBalance": "getVirtualUnderlyingBalance(address)",
    "getReserveDeficit": "getReserveDeficit(address)",
    "getInterestRateData": "getInterestRateData(address)",
    "getUserAccountData": "getUserAccountData(address)",
    "getUserEMode": "getUserEMode(address)",
    "getUserConfiguration": "getUserConfiguration(address)",
    "getEModeCategoryCollateralConfig": "getEModeCategoryCollateralConfig(uint8)",
    "getEModeCategoryCollateralBitmap": "getEModeCategoryCollateralBitmap(uint8)",
}
SEL = {k: B.selector(v) for k, v in SIG.items()}
T_BORROW = "0x" + B.keccak256(b"Borrow(address,address,address,uint256,uint8,uint256,uint16)").hex()
T_LIQ = "0x" + B.keccak256(b"LiquidationCall(address,address,address,uint256,uint256,address,bool)").hex()


def cd(name: str, *args) -> bytes:
    out = SEL[name]
    for a in args:
        out += B.enc_address(a) if isinstance(a, str) else int(a).to_bytes(32, "big")
    return out


def make_rpc(m: dict, interval: float = 0.3) -> B.Rpc:
    return B.Rpc(m["call_url"], None, interval=interval, retry_wait=10, max_retries=8)


def head_block(rpc: B.Rpc) -> int:
    return int(rpc.call("eth_blockNumber", [], "head"), 16)


def block_before(rpc: B.Rpc, ts: int, block_s: float) -> tuple[int, int, int]:
    """(b, ts(b), ts(b + 1)): the largest block with timestamp < ts."""
    hb = head_block(rpc)
    get = rpc.block_ts
    hts = get(hb)
    if hts < ts:
        raise RuntimeError("t0 is after the chain head")
    guess = max(1, int(hb - (hts - ts) / block_s))
    lo, hi = guess, guess
    span = max(100, int(3600 / block_s))
    while get(lo) >= ts:
        lo = max(1, lo - span)
        span *= 2
    span = max(100, int(3600 / block_s))
    while hi <= hb and get(hi) < ts:
        hi = min(hb, hi + span)
        span *= 2
    return A.find_before(ts, get, lo, hi)


def _dyn_addresses(ret: bytes) -> list[str]:
    w = B.decode_words(ret)
    n = w[1]
    return [B.word_to_address(x) for x in w[2:2 + n]]


def _string(ret: bytes) -> str:
    if len(ret) == 32:
        return ret.rstrip(b"\0").decode(errors="replace")
    w = B.decode_words(ret[:64])
    ln = w[1]
    return ret[64:64 + ln].decode(errors="replace")


def family_of(symbol: str) -> str:
    s = symbol.upper().replace("₮", "T")
    for fam, names in CFG.FAMILY_SYMBOLS.items():
        if s in names:
            return fam
    return "O"


def reserves(rpc: B.Rpc, m: dict, block: int) -> dict:
    ok, ret = rpc.multicall([(m["pool"], cd("getReservesList"))], block, "reserves")[0]
    if not ok:
        raise RuntimeError("getReservesList failed")
    assets = [a.lower() for a in _dyn_addresses(ret)]
    calls = []
    for a in assets:
        calls += [(m["pool"], cd("getReserveData", a)), (m["oracle"], cd("getAssetPrice", a)),
                  (a, cd("symbol")), (a, cd("decimals"))]
    res = []
    for i in range(0, len(calls), 200):
        res += rpc.multicall(calls[i:i + 200], block, "reserve_meta")
    out = {}
    for j, a in enumerate(assets):
        rd = B.decode_reserve_data(*res[4 * j])
        if rd["status"] != "ok":
            continue
        okp, rp = res[4 * j + 1]
        oks, rs = res[4 * j + 2]
        okd, rdc = res[4 * j + 3]
        conf = C1C.decode_config(rd["configuration"])
        sym = _string(rs) if oks else a
        out[a] = {"asset": a, "symbol": sym, "family": family_of(sym), "id": rd["id"],
                  "aToken": rd["aTokenAddress"], "vDebt": rd["variableDebtTokenAddress"],
                  "strategy": rd["interestRateStrategyAddress"], "price": B.decode_uint(rp) if okp else 0,
                  "decimals": B.decode_uint(rdc) if okd else conf["decimals"], "lt": conf["lt"], "lb": conf["lb"],
                  "fee": conf["protocol_fee"], "rf": (rd["configuration"] >> 64) & 0xFFFF,
                  "active": conf["active"], "frozen": conf["frozen"], "paused": conf["paused"],
                  "vrate_ray": rd["currentVariableBorrowRate"], "lrate_ray": rd["currentLiquidityRate"],
                  "unbacked": rd["unbacked"], "config": rd["configuration"]}
    return out


def usdc_state(rpc: B.Rpc, m: dict, block: int, R: dict) -> dict:
    u = R[m["usdc"]]
    if u["aToken"].lower() != m["atoken"]:
        raise RuntimeError("USDC aToken differs from the configured one")
    calls = [(u["aToken"], cd("totalSupply")), (u["vDebt"], cd("totalSupply")),
             (m["usdc"], cd("balanceOf", u["aToken"])), (m["pool"], cd("getVirtualUnderlyingBalance", m["usdc"])),
             (m["pool"], cd("getReserveDeficit", m["usdc"])), (u["strategy"], cd("getInterestRateData", m["usdc"]))]
    res = rpc.multicall(calls, block, "usdc_state")
    val = [B.decode_uint(r) if ok and len(r) == 32 else None for ok, r in res[:5]]
    ok6, r6 = res[5]
    curve = B.decode_words(r6) if ok6 and len(r6) == 128 else None
    if curve is None:
        raise RuntimeError("getInterestRateData failed (v2 strategy expected)")
    return {"atoken_total_supply": val[0], "vdebt_total_supply": val[1], "cash_balance": val[2],
            "virtual_balance": val[3], "deficit": val[4],
            "curve_ray": {"optimal": curve[0], "base": curve[1], "slope1": curve[2], "slope2": curve[3]},
            "vrate_ray": u["vrate_ray"], "lrate_ray": u["lrate_ray"], "rf_bps": u["rf"], "unbacked": u["unbacked"],
            "config": u["config"], "decimals": u["decimals"], "price": u["price"]}


def emode_meta(rpc: B.Rpc, m: dict, block: int, cats) -> dict:
    out = {}
    cats = sorted({int(c) for c in cats if c})
    if not cats:
        return out
    calls = []
    for c in cats:
        calls += [(m["pool"], cd("getEModeCategoryCollateralConfig", c)),
                  (m["pool"], cd("getEModeCategoryCollateralBitmap", c))]
    res = rpc.multicall(calls, block, "emode_meta")
    for k, c in enumerate(cats):
        (ok1, r1), (ok2, r2) = res[2 * k], res[2 * k + 1]
        if not (ok1 and ok2):
            raise RuntimeError(f"e-mode {c} unreadable (pre-3.2 layout not supported)")
        w = B.decode_words(r1)
        out[str(c)] = {"ltv": w[0], "lt": w[1], "lb": w[2], "collateral_bitmap": B.decode_uint(r2)}
    return out


def debt_scan(rpc: B.Rpc, block: int, vdebt: str, users: list[str], size: int = 800) -> dict:
    out = {}
    for i in range(0, len(users), size):
        chunk = users[i:i + size]
        res = rpc.multicall([(vdebt, cd("balanceOf", u)) for u in chunk], block, "debt_scan", tag=str(i))
        for u, (ok, r) in zip(chunk, res):
            if ok and len(r) == 32:
                v = B.decode_uint(r)
                if v > 0:
                    out[u] = v
    return out


ACCOUNT_FIELDS = ("totalCollateralBase", "totalDebtBase", "availableBorrowsBase", "currentLiquidationThreshold",
                  "ltv", "healthFactor")


def read_accounts(rpc: B.Rpc, m: dict, block: int, R: dict, users: list[str], per_call: int = 30) -> dict:
    """Per user: account totals, e-mode, configuration, aToken balances of every E/B-family reserve and variable
    debt of every E/B-family reserve and USDC."""
    fam = [a for a, r in R.items() if r["family"] in ("E", "B")]
    toks = [("a", a, R[a]["aToken"]) for a in fam] + [("d", a, R[a]["vDebt"]) for a in fam + [m["usdc"]]]
    out = {}
    k = 3 + len(toks)
    per_call = max(1, min(per_call, 900 // k))
    for i in range(0, len(users), per_call):
        chunk = users[i:i + per_call]
        calls = []
        for u in chunk:
            calls += [(m["pool"], cd("getUserAccountData", u)), (m["pool"], cd("getUserEMode", u)),
                      (m["pool"], cd("getUserConfiguration", u))]
            calls += [(t, cd("balanceOf", u)) for _, _, t in toks]
        res = rpc.multicall(calls, block, "accounts", tag=str(i))
        for j, u in enumerate(chunk):
            r = res[j * k:(j + 1) * k]
            if not all(ok for ok, _ in r):
                raise RuntimeError(f"account read failed at {block}")
            acc = dict(zip(ACCOUNT_FIELDS, B.decode_words(r[0][1])))
            acc["emode"] = B.decode_uint(r[1][1])
            acc["config"] = B.decode_uint(r[2][1])
            bal = {}
            for (kind, a, _), (_, ret) in zip(toks, r[3:]):
                v = B.decode_uint(ret)
                if v:
                    bal[f"{kind}:{a}"] = v
            acc["bal"] = bal
            out[u] = acc
    return out


def get_logs(m: dict, spec: dict, lo: int, hi: int) -> list[dict]:
    err = None
    for url in m["log_urls"]:
        try:
            return L1.fetch(L1.Client(url=url), spec, lo, hi)
        except SystemExit as e:
            err = e
    raise SystemExit(f"STOP: every log endpoint failed at [{lo},{hi}]: {err}")


def uni_states(rpc: B.Rpc, block: int, base: str, quote: str) -> list[dict]:
    pools = C1C.uni_get_pool(rpc, block, base, quote)
    out = []
    for fee, p in sorted(pools.items()):
        st = C1C.uni_pool_state(rpc, block, p)
        if st is not None and st["liquidity"] > 0:
            out.append(st)
    return out
