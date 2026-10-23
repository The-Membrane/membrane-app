#!/usr/bin/env python3
"""Q26 R18.3 step 5: RF1 / RF2 eligibility from parameter and configuration reads only
(membrane-board design/Q26_ROUND18_PREREG.md, section R18.3).

RF1 = Aave V2 Ethereum USDC. We read ONLY:
  - LendingPoolConfigurator logs whose topic1 is the USDC asset (freeze, activation, borrowing, reserve factor,
    rate-strategy and collateral changes),
  - LendingPool Paused() / Unpaused() logs (pool-wide),
  - eth_call of the rate-strategy getters (constants) and of getConfiguration(USDC) at the latest block.
No Supply/Withdraw/Borrow/Repay/Transfer log, no balance and no reserve-data (cash, debt, rate) read happens here.

RF2 = Aave V3 Ethereum Core PYUSD, USDS, RLUSD: PoolConfigurator events from the held governance-changes file.

  python3 r183_rfhistory.py rf1 --out <dir>
  python3 r183_rfhistory.py rf2 --datasets <membrane-datasets> --out <dir>

Keyless endpoint (tenderly public gateway), each range read twice with different chunk sizes; counts must match.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

URL = "https://mainnet.gateway.tenderly.co"
CONFIGURATOR = "0x311bb771e4f8952e6da169b425e7e92d6ac45756"
POOL = "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
START = 11362579      # V2 LendingPool deployment block (2020-11-30)

# ---------------------------------------------------------------- keccak-256 (pure python, for selectors)
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
       0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
       0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
       0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
M64 = (1 << 64) - 1


def _rol(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & M64


def _f(A):
    for rc in _RC:
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        A = [[A[x][y] ^ D[x] for y in range(5)] for x in range(5)]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
        A = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        A[0][0] ^= rc
    return A


def keccak256(data: bytes) -> bytes:
    rate = 136
    p = bytearray(data) + b"\x01"
    while len(p) % rate:
        p += b"\x00"
    p[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for off in range(0, len(p), rate):
        blk = p[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            A[x][y] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        A = _f(A)
    out = b"".join(A[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


def topic(sig):
    return "0x" + keccak256(sig.encode()).hex()


def selector(sig):
    return "0x" + keccak256(sig.encode()).hex()[:8]


assert topic("Transfer(address,address,uint256)") == \
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "keccak self-test"

CFG_EVENTS = [
    "ReserveInitialized(address,address,address,address,address)",
    "BorrowingEnabledOnReserve(address,bool)", "BorrowingDisabledOnReserve(address)",
    "CollateralConfigurationChanged(address,uint256,uint256,uint256)",
    "StableRateEnabledOnReserve(address)", "StableRateDisabledOnReserve(address)",
    "ReserveActivated(address)", "ReserveDeactivated(address)",
    "ReserveFrozen(address)", "ReserveUnfrozen(address)",
    "ReserveFactorChanged(address,uint256)", "ReserveDecimalsChanged(address,uint256)",
    "ReserveInterestRateStrategyChanged(address,address)",
    "ATokenUpgraded(address,address,address)", "StableDebtTokenUpgraded(address,address,address)",
    "VariableDebtTokenUpgraded(address,address,address)",
]
POOL_EVENTS = ["Paused()", "Unpaused()"]


# ---------------------------------------------------------------- rpc
def rpc(method, params, tries=8):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for k in range(tries):
        try:
            req = urllib.request.Request(URL, body, {"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                j = json.loads(r.read())
            if "error" in j:
                raise RuntimeError(str(j["error"])[:200])
            return j["result"]
        except Exception as e:     # noqa: BLE001
            if k == tries - 1:
                raise
            time.sleep(2 + 2 * k)


def logs(address, topics, lo, hi, span):
    out = []
    b = lo
    while b <= hi:
        e = min(hi, b + span - 1)
        out += rpc("eth_getLogs", [{"address": address, "fromBlock": hex(b), "toBlock": hex(e), "topics": topics}])
        b = e + 1
    return out


def block_ts(bn, cache):
    if bn not in cache:
        cache[bn] = int(rpc("eth_getBlockByNumber", [hex(bn), False])["timestamp"], 16)
    return cache[bn]


def utc(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def cmd_rf1(a):
    os.makedirs(a.out, exist_ok=True)
    head = int(rpc("eth_blockNumber", []), 16)
    names = {topic(s): s for s in CFG_EVENTS + POOL_EVENTS}
    asset_t = "0x" + "0" * 24 + USDC[2:]
    reads = {}
    for tag, addr, tps in (("configurator_usdc", CONFIGURATOR, [None, asset_t]),
                           ("pool_pause", POOL, [[topic(s) for s in POOL_EVENTS]])):
        r1 = logs(addr, tps, START, head, 500_000)
        r2 = logs(addr, tps, START, head, 250_000)
        k1 = sorted((x["blockNumber"], x["logIndex"]) for x in r1)
        k2 = sorted((x["blockNumber"], x["logIndex"]) for x in r2)
        assert k1 == k2, f"{tag}: two reads differ ({len(k1)} vs {len(k2)})"
        reads[tag] = r1
    cache = {}
    rows = []
    for tag, lst in reads.items():
        for x in lst:
            bn = int(x["blockNumber"], 16)
            t0 = x["topics"][0]
            nm = names.get(t0, "unknown:" + t0)
            data = x["data"][2:]
            words = [int(data[i:i + 64], 16) for i in range(0, len(data), 64)]
            row = {"block": bn, "ts": block_ts(bn, cache), "event": nm.split("(")[0], "source": tag}
            if nm.startswith("ReserveFactorChanged"):
                row["reserveFactorBps"] = words[0]
            elif nm.startswith("CollateralConfigurationChanged"):
                row["ltvBps"], row["liqThresholdBps"], row["liqBonusBps"] = words[:3]
            elif nm.startswith("ReserveInterestRateStrategyChanged"):
                row["strategy"] = "0x" + data[24:64]
            elif nm.startswith("BorrowingEnabledOnReserve"):
                row["stableRateEnabled"] = bool(words[0])
            elif nm.startswith("ReserveInitialized"):
                row["strategy"] = "0x" + data[-40:]
            row["utc"] = utc(row["ts"])
            rows.append(row)
    rows.sort(key=lambda r: (r["block"], r["event"]))
    # strategy constants (contract code constants, config read only)
    getters = ["OPTIMAL_UTILIZATION_RATE()", "baseVariableBorrowRate()", "variableRateSlope1()", "variableRateSlope2()"]
    strategies = {}
    for r in rows:
        s = r.get("strategy")
        if s and s not in strategies:
            vals = {}
            for g in getters:
                try:
                    v = rpc("eth_call", [{"to": s, "data": selector(g)}, "latest"])
                    vals[g[:-2]] = int(v, 16) / 1e27 if v not in ("0x", None) else None
                except Exception as e:   # noqa: BLE001
                    vals[g[:-2]] = f"error {str(e)[:60]}"
            strategies[s] = vals
    for r in rows:
        if r.get("strategy"):
            r["curve"] = strategies[r["strategy"]]
            r.pop("strategy")          # contract addresses of strategies are public config, but keep outputs address-free
    # configuration bitmap at head
    cfg = int(rpc("eth_call", [{"to": POOL, "data": selector("getConfiguration(address)") + "0" * 24 + USDC[2:]},
                               "latest"]), 16)
    bits = {"ltvBps": cfg & 0xFFFF, "liqThresholdBps": (cfg >> 16) & 0xFFFF, "liqBonusBps": (cfg >> 32) & 0xFFFF,
            "active": bool((cfg >> 56) & 1), "frozen": bool((cfg >> 57) & 1),
            "borrowingEnabled": bool((cfg >> 58) & 1), "stableBorrowEnabled": bool((cfg >> 59) & 1),
            "reserveFactorBps": (cfg >> 64) & 0xFFFF}
    paused = rpc("eth_call", [{"to": POOL, "data": selector("paused()")}, "latest"])
    out = {"schema": "q26-r183/rf1-history/1", "set": "RF1 = Aave V2 Ethereum USDC",
           "reads": "configurator logs with topic1 = USDC; pool Paused/Unpaused logs; strategy getters; "
                    "getConfiguration(USDC) and paused() at head. No flow, balance or reserve-data read.",
           "endpoint": URL, "blocks": [START, head], "headUtc": utc(block_ts(head, cache)),
           "doubleReadCountsMatch": True, "nLogs": {k: len(v) for k, v in reads.items()},
           "events": rows, "configAtHead": bits, "poolPausedAtHead": bool(int(paused, 16))}
    with open(os.path.join(a.out, "rf1-history.json"), "w") as f:
        json.dump(out, f, indent=1)
    for r in rows:
        print(r["utc"], r["event"], {k: v for k, v in r.items() if k not in ("utc", "event", "block", "ts", "source")})
    print("head", json.dumps(bits), "paused", out["poolPausedAtHead"])


def cmd_rf2(a):
    os.makedirs(a.out, exist_ok=True)
    j = json.load(open(os.path.join(a.datasets, "governance-changes/aave-v3-ethereum-core.json")))
    keep = ("PYUSD", "USDS", "RLUSD")
    sym = {k.lower(): v for k, v in j["symbols"].items()}
    rows = []
    for e in j["events"]:
        s_ = sym.get(str(e["args"].get("asset", "")).lower())
        if s_ in keep:
            args = {k: v for k, v in e["args"].items()
                    if k != "asset" and not (isinstance(v, str) and v.startswith("0x") and len(v) == 42)}
            rows.append({"utc": utc(e["ts"]), "block": e["block"], "symbol": s_, "event": e["name"], "args": args})
    names = sorted({e["name"] for e in j["events"]})
    out = {"schema": "q26-r183/rf2-history/1", "set": "RF2 = Aave V3 Ethereum Core PYUSD, USDS, RLUSD",
           "source": "membrane-datasets governance-changes/aave-v3-ethereum-core.json (held; config events only)",
           "n": len(rows), "events": rows, "eventTypesInFile": names,
           "fileSpan": [j.get("fromBlock"), j.get("toBlock")],
           "limit": "the held file has no supply/borrow cap or rate-data events; RLUSD has no event in it"}
    with open(os.path.join(a.out, "rf2-history.json"), "w") as f:
        json.dump(out, f, indent=1, default=str)
    print(len(rows))


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("rf1")
    p.add_argument("--out", required=True)
    p = sub.add_parser("rf2")
    p.add_argument("--datasets", required=True)
    p.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    {"rf1": cmd_rf1, "rf2": cmd_rf2}[a.cmd](a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
