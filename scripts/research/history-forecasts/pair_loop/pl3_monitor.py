"""Q26-PL PL.3: cap-headroom and oracle-configuration monitor for Aave V3 Ethereum correlated collateral (CAPO adapters).
Measured state, read live from keyless RPC. Never a probability. Output: one JSON document.
  - per capped asset: ratio, snapshot ratio/timestamp/age, max growth, implied cap now, headroom, isCapped, source address, description
  - what-if: pair-layer debt (latest public layers snapshot, bands by collateral-only distance) within s of its line for s in the
    set {the measured 2026-03-10 step 2.84 %, 1, 2, 3, 5 %}; a band is counted when its lower edge is below s (upper bound) and
    when its upper edge is below s (lower bound)
  - flags: isCapped, headroom < 1 %, snapshot age > 365 d, a cap event or source change since the last reading (when a previous doc is given)
No address of any user is read. Adapter and oracle addresses are protocol contracts.
"""
import argparse, json, time, urllib.request, datetime as dt
RPCS = ["https://eth.drpc.org", "https://ethereum-rpc.publicnode.com", "https://rpc.mevblocker.io"]
ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2"
ASSETS = {"wstETH": ("7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", "WETH"), "weETH": ("cd5fe23c85820f7b72d0926fc9b05b43e359b7ee", "WETH"),
          "rsETH": ("a1290d69c65a6fe4df752f95823fae25cb99e5a7", "WETH"), "osETH": ("f1c9acdc66974dfb6decb12aa385b9cd01190e38", "WETH"),
          "cbETH": ("be9895146f7af43049ca1c1ae358b0541ea49704", "WETH"), "rETH": ("ae78736cd615f374d3085123a210448e74fc6393", "WETH"),
          "ETHx": ("a35b1b31ce002fbf2058d22f30f95d405200a15b", "WETH"), "LBTC": ("8236a87084f8b84306f72007f36f2618a5634494", "WBTC"),
          "eBTC": ("657e8c867d8b37dcc18fa4caead9c45eb088c642", "WBTC")}
BASES = {"WETH": "c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "WBTC": "2260fac5e5542a773aa44fbcfedf7c193bc2c599"}
SEL = {"getSourceOfAsset": "0x92bf2be0", "getAssetPrice": "0xb3596f07", "description": "0x7284e416", "getSnapshotRatio": "0xfe4d9e79",
       "getSnapshotTimestamp": "0xdeb8c641", "getMaxRatioGrowthPerSecond": "0xf6ba77de", "getMaxYearlyGrowthRatePercent": "0xcaa4cdcf",
       "getRatio": "0xec1ebd7a", "isCapped": "0x671528d4", "latestAnswer": "0x50d25bcd"}
BANDS = ((0.0, 0.01), (0.01, 0.02), (0.02, 0.035), (0.035, 0.05), (0.05, 0.10001))
STEPS = {"mar2026": 0.0284, "1%": 0.01, "2%": 0.02, "3%": 0.03, "5%": 0.05}   # mar2026 = the measured 2026-03-10 wstETH step


def rpc(method, params):
    err = None
    for u in RPCS:
        try:
            p = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
            r = json.loads(urllib.request.urlopen(urllib.request.Request(u, p, {"content-type": "application/json", "user-agent": "membrane-research"}), timeout=45).read())
            if "result" in r: return r["result"]
            err = r
        except Exception as e: err = e
    raise RuntimeError(str(err)[:200])


def call(to, data, block="latest"):
    v = rpc("eth_call", [{"to": to, "data": data}, block])
    return v if v and v != "0x" else None


def u(v): return int(v, 16) if v else None


def read(block="latest", prev=None):
    head = int(rpc("eth_blockNumber", []), 16) if block == "latest" else int(block, 16)
    ts = int(rpc("eth_getBlockByNumber", [hex(head), False])["timestamp"], 16)
    doc = {"schema": "q26-pl3/1", "kind": "measured", "block": head, "readAt": dt.datetime.fromtimestamp(ts, dt.UTC).isoformat(), "assets": {}, "flags": []}
    basepx = {b: u(call(ORACLE, SEL["getAssetPrice"] + a.rjust(64, "0"), hex(head))) for b, a in BASES.items()}
    for nm, (addr, base) in ASSETS.items():
        src = call(ORACLE, SEL["getSourceOfAsset"] + addr.rjust(64, "0"), hex(head)); src = "0x" + src[-40:]
        d = call(src, SEL["description"], hex(head))
        try: n = int(d[66:130], 16); desc = bytes.fromhex(d[130:130 + n * 2]).decode(errors="replace")
        except Exception: desc = None
        g = {k: u(call(src, SEL[k], hex(head))) for k in ("getSnapshotRatio", "getSnapshotTimestamp", "getMaxRatioGrowthPerSecond", "getMaxYearlyGrowthRatePercent", "getRatio", "isCapped", "latestAnswer")}
        px = u(call(ORACLE, SEL["getAssetPrice"] + addr.rjust(64, "0"), hex(head)))
        rec = {"source": src, "description": desc, "oracleRatioVsBase": px / basepx[base] if px and basepx[base] else None, "base": base}
        if g["getSnapshotRatio"] and g["getRatio"] and g["getMaxRatioGrowthPerSecond"] is not None:
            cap = g["getSnapshotRatio"] * (1 + g["getMaxRatioGrowthPerSecond"] * (ts - g["getSnapshotTimestamp"]) / 1e18)
            rec.update({"capo": True, "ratio": g["getRatio"] / 1e18, "snapshotRatio": g["getSnapshotRatio"] / 1e18, "snapshotAgeDays": round((ts - g["getSnapshotTimestamp"]) / 86400, 2),
                        "maxYearlyGrowthPct": g["getMaxYearlyGrowthRatePercent"] / 100 if g["getMaxYearlyGrowthRatePercent"] else None,
                        "capNow": cap / 1e18, "headroomPct": round((cap / g["getRatio"] - 1) * 100, 4), "isCapped": bool(g["isCapped"])})
            if rec["isCapped"]: doc["flags"].append(f"{nm}: isCapped")
            if rec["headroomPct"] < 1.0: doc["flags"].append(f"{nm}: cap headroom {rec['headroomPct']:.2f} % < 1 %")
            if rec["snapshotAgeDays"] > 365: doc["flags"].append(f"{nm}: snapshot {rec['snapshotAgeDays']:.0f} d old")
        else:
            rec["capo"] = False
        if prev and nm in prev.get("assets", {}):
            p = prev["assets"][nm]
            if p.get("source") != src: doc["flags"].append(f"{nm}: price source changed {p.get('source')} -> {src}")
            if p.get("snapshotRatio") and rec.get("snapshotRatio") and abs(p["snapshotRatio"] - rec["snapshotRatio"]) > 1e-12:
                doc["flags"].append(f"{nm}: cap parameters updated (snapshot {p['snapshotRatio']:.6f} -> {rec['snapshotRatio']:.6f})")
        doc["assets"][nm] = rec
    return doc


def whatif(doc, layers_path):
    L = json.load(open(layers_path)); eth = [c for c in L["chains"] if c["chain"] == "ethereum"][0]
    pair = eth["layers"]["pair"]; out = {"layersReadAt": eth.get("readAt"), "layersBlock": eth.get("block"), "bands": ["0-1%", "1-2%", "2-3.5%", "3.5-5%", "5-10%"], "perStep": {}}
    for nm, rec in doc["assets"].items():
        if nm not in pair: continue
        for sn, s in STEPS.items():
            lo = sum(d for (a, b), d in zip(BANDS, pair[nm]["debtUsd"]) if b <= s)
            hi = sum(d for (a, b), d in zip(BANDS, pair[nm]["debtUsd"]) if a < s)
            out["perStep"].setdefault(sn, {})[nm] = {"stepPct": round(s * 100, 3), "debtUsdLowerBound": round(lo), "debtUsdUpperBound": round(hi)}
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--layers"); ap.add_argument("--prev"); ap.add_argument("--block", default="latest"); ap.add_argument("--out")
    a = ap.parse_args()
    prev = json.load(open(a.prev)) if a.prev else None
    doc = read(a.block, prev)
    if a.layers: doc["whatIf"] = whatif(doc, a.layers)
    js = json.dumps(doc, indent=1); print(js)
    if a.out: open(a.out, "w").write(js)
