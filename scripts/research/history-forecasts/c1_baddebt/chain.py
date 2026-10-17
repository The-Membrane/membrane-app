"""Chain reads for C1 (Q26 R8.5): Aave V3 Core state at an anchor block, logs, Uniswap v3 pool state.

Free sources only: archive eth_call on https://eth.drpc.org (user-agent curl/8.5.0, Multicall3 batches)
and eth_getLogs on https://rpc.mevblocker.io. Addresses are handled as opaque keys; no identity is attached.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import b_acquire as B  # noqa: E402  (keccak, Multicall3 encode/decode, paced RPC client)

POOL = B.POOL
ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2"   # AaveOracle, Aave V3 Ethereum Core
UNI_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
LOGS_URL = "https://rpc.mevblocker.io"

# Subject assets (Aave V3 Ethereum Core). Collateral family and the debt asset.
ETH_ASSETS = {
    "WETH": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "wstETH": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    "weETH": "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
    "rsETH": "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
}
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
ALL_ASSETS = {**ETH_ASSETS, "USDC": USDC}
ASSET_BY_ADDR = {v: k for k, v in ALL_ASSETS.items()}

SIG = {
    "getUserAccountData": "getUserAccountData(address)",
    "getUserEMode": "getUserEMode(address)",
    "getUserConfiguration": "getUserConfiguration(address)",
    "getConfiguration": "getConfiguration(address)",
    "getReserveData": "getReserveData(address)",
    "getAssetPrice": "getAssetPrice(address)",
    "balanceOf": "balanceOf(address)",
    "scaledBalanceOf": "scaledBalanceOf(address)",
    "getReserveNormalizedIncome": "getReserveNormalizedIncome(address)",
    "getEModeCategoryCollateralConfig": "getEModeCategoryCollateralConfig(uint8)",
    "getEModeCategoryCollateralBitmap": "getEModeCategoryCollateralBitmap(uint8)",
    "getEModeCategoryData": "getEModeCategoryData(uint8)",
    "slot0": "slot0()",
    "liquidity": "liquidity()",
    "tickSpacing": "tickSpacing()",
    "token0": "token0()",
    "token1": "token1()",
    "fee": "fee()",
    "tickBitmap": "tickBitmap(int16)",
    "ticks": "ticks(int24)",
    "getPool": "getPool(address,address,uint24)",
}
SEL = {k: B.selector(v) for k, v in SIG.items()}

EVENT_SIGS = {
    "LiquidationCall": "LiquidationCall(address,address,address,uint256,uint256,address,bool)",
    "DeficitCreated": "DeficitCreated(address,address,uint256)",
    "Borrow": "Borrow(address,address,address,uint256,uint8,uint256,uint16)",
}


def topic0(name: str) -> str:
    return "0x" + B.keccak256(EVENT_SIGS[name].encode()).hex()


def addr_topic(a: str) -> str:
    return "0x" + "00" * 12 + B.norm_address(a)[2:]


def enc_int(n: int) -> bytes:
    return (n % (1 << 256)).to_bytes(32, "big")


def cd(name: str, *args) -> bytes:
    out = SEL[name]
    for a in args:
        out += B.enc_address(a) if isinstance(a, str) else enc_int(int(a))
    return out


def words(ret: bytes) -> list[int]:
    return B.decode_words(ret)


def signed(w: int, bits: int = 256) -> int:
    w &= (1 << bits) - 1
    return w - (1 << bits) if w >> (bits - 1) else w


# ---------------------------------------------------------------------------------------------
# Reserve configuration bit layout (ReserveConfigurationMap, Aave V3)
# ---------------------------------------------------------------------------------------------

def decode_config(c: int) -> dict:
    return {"ltv": c & 0xFFFF, "lt": (c >> 16) & 0xFFFF, "lb": (c >> 32) & 0xFFFF,
            "decimals": (c >> 48) & 0xFF, "active": (c >> 56) & 1, "frozen": (c >> 57) & 1,
            "borrowing": (c >> 58) & 1, "paused": (c >> 60) & 1,
            "protocol_fee": (c >> 152) & 0xFFFF}


def user_config_flags(cfg: int, reserve_id: int) -> tuple[bool, bool]:
    """(borrowing, using as collateral) for reserve id from UserConfigurationMap."""
    return bool((cfg >> (2 * reserve_id)) & 1), bool((cfg >> (2 * reserve_id + 1)) & 1)


# ---------------------------------------------------------------------------------------------
# RPC
# ---------------------------------------------------------------------------------------------

def make_rpc(events_path=None, interval: float = 0.3) -> B.Rpc:
    return B.Rpc(B.RPC_URL, events_path, interval=interval, retry_wait=10, max_retries=8)


def block_at(rpc: B.Rpc, ts: int, head: int) -> int:
    """Largest block with timestamp < ts (B.find_block_before); the anchor is the state at its end."""
    head_ts = rpc.block_ts(head)
    guess = max(1, head - (head_ts - ts) // 12)
    b, _, _ = B.find_block_before(ts, rpc.block_ts, guess, head=head)
    return b


def multicall_chunks(rpc: B.Rpc, calls: list[tuple[str, bytes]], block: int, size: int, phase: str):
    out = []
    for i in range(0, len(calls), size):
        out.extend(rpc.multicall(calls[i:i + size], block, phase, tag=f"{phase} {i}"))
    return out


def reserve_meta(rpc: B.Rpc, block: int) -> dict:
    calls = []
    for name, a in ALL_ASSETS.items():
        calls += [(POOL, cd("getReserveData", a)), (POOL, cd("getConfiguration", a)), (ORACLE, cd("getAssetPrice", a))]
    res = rpc.multicall(calls, block, "reserve_meta")
    out = {}
    for j, (name, a) in enumerate(ALL_ASSETS.items()):
        rd = B.decode_reserve_data(*res[3 * j])
        if rd["status"] != "ok":
            raise RuntimeError(f"getReserveData {name} at {block}: {rd['status']}")
        ok_c, rc = res[3 * j + 1]
        ok_p, rp = res[3 * j + 2]
        if not (ok_c and ok_p):
            raise RuntimeError(f"config/price {name} at {block}")
        conf = decode_config(B.decode_uint(rc))
        out[name] = {"asset": a, "id": rd["id"], "aToken": rd["aTokenAddress"],
                     "vDebt": rd["variableDebtTokenAddress"], "price": B.decode_uint(rp), **conf}
    return out


def emode_meta(rpc: B.Rpc, block: int, cats: list[int]) -> dict:
    """E-mode categories (Aave >= 3.2: per-category collateral config + collateral bitmap)."""
    out = {}
    cats = sorted({c for c in cats if c})
    if not cats:
        return out
    calls = []
    for c in cats:
        calls += [(POOL, cd("getEModeCategoryCollateralConfig", c)), (POOL, cd("getEModeCategoryCollateralBitmap", c))]
    res = rpc.multicall(calls, block, "emode_meta")
    for k, c in enumerate(cats):
        (ok1, r1), (ok2, r2) = res[2 * k], res[2 * k + 1]
        if not (ok1 and ok2):
            raise RuntimeError(f"e-mode {c} unreadable at {block} (pre-3.2 layout not supported)")
        w = words(r1)
        out[c] = {"ltv": w[0], "lt": w[1], "lb": w[2], "collateral_bitmap": B.decode_uint(r2)}
    return out


def usdc_debt_scan(rpc: B.Rpc, block: int, vdebt_usdc: str, users: list[str], size: int = 900) -> dict:
    calls = [(vdebt_usdc, cd("balanceOf", u)) for u in users]
    res = multicall_chunks(rpc, calls, block, size, "usdc_debt_scan")
    out = {}
    for u, (ok, r) in zip(users, res):
        if ok and len(r) == 32:
            v = B.decode_uint(r)
            if v > 0:
                out[u] = v
    return out


ACCOUNT_FIELDS = ("totalCollateralBase", "totalDebtBase", "availableBorrowsBase", "currentLiquidationThreshold",
                  "ltv", "healthFactor")


def read_accounts(rpc: B.Rpc, block: int, meta: dict, users: list[str], per_call: int = 40) -> dict:
    """Per user: account totals, e-mode, user configuration, aToken balances of the ETH family and USDC
    and variable debt of the ETH family and USDC."""
    toks = []
    for n in ETH_ASSETS:
        toks.append(("a_" + n, meta[n]["aToken"]))
    for n in ALL_ASSETS:
        toks.append(("d_" + n, meta[n]["vDebt"]))
    out = {}
    for i in range(0, len(users), per_call):
        chunk = users[i:i + per_call]
        calls = []
        for u in chunk:
            calls += [(POOL, cd("getUserAccountData", u)), (POOL, cd("getUserEMode", u)),
                      (POOL, cd("getUserConfiguration", u))]
            calls += [(t, cd("balanceOf", u)) for _, t in toks]
        res = rpc.multicall(calls, block, "accounts", tag=f"accounts {i}")
        k = 3 + len(toks)
        for j, u in enumerate(chunk):
            r = res[j * k:(j + 1) * k]
            if not all(ok for ok, _ in r):
                raise RuntimeError(f"account read failed at {block}")
            acc = dict(zip(ACCOUNT_FIELDS, words(r[0][1])))
            acc["emode"] = B.decode_uint(r[1][1])
            acc["config"] = B.decode_uint(r[2][1])
            for (name, _), (_, ret) in zip(toks, r[3:]):
                acc[name] = B.decode_uint(ret)
            out[u] = acc
    return out


# ---------------------------------------------------------------------------------------------
# Logs (eth_getLogs with a topic filter, recursive range split)
# ---------------------------------------------------------------------------------------------

def _post(url: str, payload: dict, timeout: float = 120):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={
        "content-type": "application/json", "user-agent": B.USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get_logs(address: str, topics: list, lo: int, hi: int, url: str = LOGS_URL, step: int = 50_000,
             pause: float = 0.5, log=print) -> list[dict]:
    out = []
    stack = [(s, min(s + step - 1, hi)) for s in range(lo, hi + 1, step)][::-1]
    while stack:
        a, b = stack.pop()
        tries = 0
        while True:
            time.sleep(pause)
            try:
                body = _post(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                                   "params": [{"address": address, "topics": topics,
                                               "fromBlock": hex(a), "toBlock": hex(b)}]})
                err = body.get("error")
                if err is None and isinstance(body.get("result"), list) and len(body["result"]) < 10_000:
                    res = body["result"]
                    break
                msg = json.dumps(err)[:200] if err else f"{len(body.get('result') or [])} logs"
            except (urllib.error.URLError, OSError, ValueError) as e:
                msg = f"{type(e).__name__}: {e}"
            if "429" in msg or "rate" in msg.lower():
                tries += 1
                if tries > 8:
                    raise RuntimeError(f"rate limited at [{a},{b}]")
                time.sleep(10)
                continue
            if b - a < 100:
                tries += 1
                if tries > 5:
                    raise RuntimeError(f"getLogs failed at [{a},{b}]: {msg}")
                time.sleep(5)
                continue
            m = (a + b) // 2
            stack += [(m + 1, b), (a, m)]
            res = None
            break
        if res is None:
            continue
        for lg in res:
            if lg.get("removed"):
                continue
            out.append({"block": int(lg["blockNumber"], 16), "log_index": int(lg["logIndex"], 16),
                        "tx": lg["transactionHash"].lower(), "topics": [t.lower() for t in lg["topics"]],
                        "data": lg["data"].lower()})
    out.sort(key=lambda x: (x["block"], x["log_index"]))
    return out


def topic_addr(t: str) -> str:
    return "0x" + t[26:].lower()


def decode_liquidation(lg: dict) -> dict:
    d = lg["data"][2:]
    w = [int(d[i:i + 64], 16) for i in range(0, len(d), 64)]
    return {"block": lg["block"], "log_index": lg["log_index"], "tx": lg["tx"],
            "collateral": topic_addr(lg["topics"][1]), "debt": topic_addr(lg["topics"][2]),
            "user": topic_addr(lg["topics"][3]), "debtToCover": w[0], "collateralAmount": w[1],
            "liquidator": "0x" + format(w[2], "040x"), "receiveAToken": w[3]}


def decode_deficit(lg: dict) -> dict:
    return {"block": lg["block"], "log_index": lg["log_index"], "tx": lg["tx"],
            "user": topic_addr(lg["topics"][1]), "debt": topic_addr(lg["topics"][2]),
            "amount": int(lg["data"][2:66], 16)}


def decode_borrow(lg: dict) -> dict:
    return {"block": lg["block"], "reserve": topic_addr(lg["topics"][1]),
            "onBehalfOf": topic_addr(lg["topics"][2])}


# ---------------------------------------------------------------------------------------------
# Uniswap v3 pool state (for the depth curve)
# ---------------------------------------------------------------------------------------------

def uni_pool_state(rpc: B.Rpc, block: int, pool: str, span_ticks: int = 9200) -> dict:
    """slot0, liquidity, spacing, tokens, fee, and every initialized tick within +-span_ticks of the
    current tick (+-9200 ticks = price x/÷ 2.5) with its liquidityNet."""
    res = rpc.multicall([(pool, cd(n)) for n in ("slot0", "liquidity", "tickSpacing", "token0", "token1", "fee")],
                        block, "uni_meta")
    if not all(ok and len(r) >= 32 for ok, r in res):
        return None   # pool not deployed (no code) at this block
    s0 = words(res[0][1])
    st = {"pool": pool.lower(), "sqrtPriceX96": s0[0], "tick": signed(s0[1]), "liquidity": B.decode_uint(res[1][1]),
          "spacing": signed(B.decode_uint(res[2][1])), "token0": B.word_to_address(B.decode_uint(res[3][1])),
          "token1": B.word_to_address(B.decode_uint(res[4][1])), "fee": B.decode_uint(res[5][1])}
    sp = st["spacing"]
    lo_w = ((st["tick"] - span_ticks) // sp) >> 8
    hi_w = ((st["tick"] + span_ticks) // sp) >> 8
    wl = list(range(lo_w, hi_w + 1))
    bm = rpc.multicall([(pool, cd("tickBitmap", w)) for w in wl], block, "uni_bitmap")
    ticks = []
    for w, (ok, r) in zip(wl, bm):
        v = B.decode_uint(r)
        for bit in range(256):
            if (v >> bit) & 1:
                t = ((w << 8) + bit) * sp
                if abs(t - st["tick"]) <= span_ticks:
                    ticks.append(t)
    nets = {}
    if ticks:
        res = multicall_chunks(rpc, [(pool, cd("ticks", t)) for t in ticks], block, 500, "uni_ticks")
        for t, (ok, r) in zip(ticks, res):
            nets[t] = signed(words(r)[1])
    st["ticks"] = {str(k): v for k, v in sorted(nets.items())}
    return st


def uni_get_pool(rpc: B.Rpc, block: int, a: str, b: str, fees=(100, 500, 3000, 10000)) -> dict:
    res = rpc.multicall([(UNI_FACTORY, cd("getPool", a, b, f)) for f in fees], block, "uni_factory")
    out = {}
    for f, (ok, r) in zip(fees, res):
        p = B.word_to_address(B.decode_uint(r))
        if p != B.ZERO_ADDRESS:
            out[f] = p
    return out
