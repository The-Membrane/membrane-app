"""Q26-P1 registration: daily end-of-day Aave V2 USDC/USDT variable borrow rate + index from ReserveDataUpdated logs,
keyless public RPC. Generalises step-1 fetch_v2_rates.py (Ethereum) to the reserved CF chains.

SEAL: polygon / avalanche (CF1 / CF2 scoring set) refuse to run unless P1_CF_UNSEAL=<sha256 of REGISTRATION.md> is set
and matches the file passed with --registration. Ethereum (development data) runs freely and is the code's self-test.

Usage: python3 -I fetch_cf_rates.py <chain> <start YYYY-MM-DD> <end YYYY-MM-DD> <out_json> [--registration REGISTRATION.md]
Output rows: date, reserve, block, ts, liquidityRate_ray, variableBorrowRate_ray, liquidityIndex, variableBorrowIndex
(the last ReserveDataUpdated with ts <= day end UTC). Same schema as v2eth-rates-daily.json, so prep reads either.
"""
import hashlib, json, os, sys, time, urllib.request, datetime as dt

TOPIC0 = "0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a"  # ReserveDataUpdated (V2, all deployments)
CHAINS = {
    # Aave V2 Ethereum LendingPool (dev; step-1 source)
    "ethereum": {"rpc": ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com"],
                 "pool": "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9", "bph": 300, "back": 2500, "fwd": 400,
                 "res": {"USDC": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDT": "0xdac17f958d2ee523a2206206994597c13d831ec7"}},
    # forward shadow: Aave V3 Ethereum Core Pool (the development rate source after 2023-02); same event signature
    "ethereum_v3": {"rpc": ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
                    "pool": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", "bph": 300, "back": 2500, "fwd": 400,
                    "res": {"USDC": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDT": "0xdac17f958d2ee523a2206206994597c13d831ec7"}},
    # CF1: Aave V2 Polygon LendingPool; USDC (PoS bridged), USDT (PoS)
    "polygon": {"rpc": ["https://polygon.gateway.tenderly.co", "https://gateway.tenderly.co/public/polygon", "https://polygon.drpc.org",
                        "https://polygon-rpc.com"],  # R11.1-v4 keyless set (logs with 100k-block spans on Tenderly)
                "pool": "0x8dff5e27ea6b7ac08ebfdf9eb090f32ee9a30fcf", "bph": 1700, "back": 3000, "fwd": 500,
                "res": {"USDC": "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "USDT": "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"}},
    # CF2: Aave V2 Avalanche LendingPool; USDC.e, USDT.e (bridged; the V2 market's stable reserves)
    "avalanche": {"rpc": ["https://avalanche.gateway.tenderly.co", "https://api.avax.network/ext/bc/C/rpc",
                          "https://avalanche.api.onfinality.io/public/ext/bc/C/rpc"],  # R11.1-v5 keyless set
                  "pool": "0x4f01aed16d97e3ab5ab2b501154dc9bb0f1a5a2c", "bph": 1800, "back": 3000, "fwd": 500,
                  "res": {"USDC": "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664", "USDT": "0xc7198437980c041c805a1edcba50c1ce5db95118"}},
}
SEALED = {"polygon", "avalanche"}


def main():
    chain, start, end, outp = sys.argv[1:5]
    cfg = CHAINS[chain]
    if chain in SEALED:
        reg = sys.argv[sys.argv.index("--registration") + 1] if "--registration" in sys.argv else None
        h = hashlib.sha256(open(reg, "rb").read()).hexdigest() if reg else None
        if not h or os.environ.get("P1_CF_UNSEAL") != h:
            sys.exit(f"SEALED: {chain} is the reserved CF scoring set; set P1_CF_UNSEAL to the REGISTRATION.md sha256")
    state = {"k": 0}

    def rpc(method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        err = None
        for k in range(10):
            url = cfg["rpc"][(state["k"] + k) % len(cfg["rpc"])]
            try:
                req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "curl/8.5.0"})
                r = json.loads(urllib.request.urlopen(req, timeout=60).read())
                if "error" in r:
                    raise RuntimeError(r["error"])
                return r["result"]
            except Exception as e:  # rotate endpoint, back off
                err = e; time.sleep(1 + k)
        raise err

    def block_ts(nb):
        return int(rpc("eth_getBlockByNumber", [hex(nb), False])["timestamp"], 16)

    latest = int(rpc("eth_blockNumber", []), 16)

    def find_block(ts, lo=1, hi=latest):
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if block_ts(mid) <= ts:
                lo = mid
            else:
                hi = mid
        return lo

    # reserve check (at fetch time, before any rate row): the configured reserves must be in the pool's list
    lst = rpc("eth_call", [{"to": cfg["pool"], "data": "0xd1946dbc"}, "latest"])  # getReservesList()
    have = {"0x" + lst[2 + 64 * (2 + i) + 24: 2 + 64 * (3 + i)] for i in range(int(lst[2 + 64: 2 + 128], 16))}
    miss = [s for s, a in cfg["res"].items() if a not in have]
    if miss:
        sys.exit(f"reserve address not in pool list: {miss} (fix the address from the pool list, never from results)")

    d0 = dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc)
    d1 = dt.datetime.fromisoformat(end).replace(tzinfo=dt.timezone.utc)
    days = [d0 + dt.timedelta(days=i) for i in range((d1 - d0).days + 1)]
    anchors = {}
    for i in list(range(0, len(days), 15)) + [len(days) - 1]:
        t = int((days[i] + dt.timedelta(days=1)).timestamp()) - 1
        anchors[i] = (t, find_block(t))
    ak = sorted(anchors)
    rows, misses = [], []
    for i, day in enumerate(days):
        t_end = int((day + dt.timedelta(days=1)).timestamp()) - 1
        a = max(k for k in ak if k <= i); b = min(k for k in ak if k >= i)
        (ta, ba), (tb, bb) = anchors[a], anchors[b]
        est = ba if a == b else int(ba + (bb - ba) * (t_end - ta) / (tb - ta))
        for sym, addr in cfg["res"].items():
            lo, hi = est - cfg["back"], est + cfg["fwd"]
            got = None
            for _ in range(8):
                logs = rpc("eth_getLogs", [{"address": cfg["pool"], "fromBlock": hex(max(lo, 1)), "toBlock": hex(hi),
                                             "topics": [TOPIC0, "0x" + "0" * 24 + addr[2:]]}])
                cand = sorted((int(l["blockNumber"], 16), int(l["logIndex"], 16), l["data"]) for l in logs)
                tss = {}
                ok = []
                for bn, li, dd in reversed(cand):
                    if bn not in tss:
                        tss[bn] = block_ts(bn)
                    if tss[bn] <= t_end:
                        ok.append((bn, li, tss[bn], dd)); break
                if ok:
                    got = ok[0]; break
                hi = lo; lo -= cfg["back"] * 4  # widen backwards (no event in the window: last event is older)
            if got is None:
                misses.append((day.date().isoformat(), sym)); continue
            w = [int(got[3][2 + 64 * k: 2 + 64 * (k + 1)], 16) for k in range(5)]
            rows.append({"date": day.date().isoformat(), "reserve": sym, "block": got[0], "ts": got[2],
                         "liquidityRate_ray": str(w[0]), "variableBorrowRate_ray": str(w[2]),
                         "liquidityIndex": str(w[3]), "variableBorrowIndex": str(w[4])})
        if i % 20 == 0:
            print(chain, day.date(), len(rows), "misses", len(misses), flush=True)
        time.sleep(0.2)
    json.dump({"source": f"eth_getLogs Aave V2 {chain} LendingPool {cfg['pool']} ReserveDataUpdated, last event <= day end UTC",
               "chain": chain, "reserves": cfg["res"], "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
               "misses": misses, "rows": rows}, open(outp, "w"))
    print("done", len(rows), "misses", len(misses))


if __name__ == "__main__":
    main()
