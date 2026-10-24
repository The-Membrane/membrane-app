"""Q26 R11.1-v5 hourly-read fix for sparse chains (D-R11.1u; inputs only, before the freeze).

An hourly read b_h is the last held Aave event block with header timestamp < h (D-R11.1l P-8). On Avalanche some
hours have no held event in [h - 1 h, h), so b_h is older than 1 h and the integrity bar (>= 99.9% within 1 h) fails.
For exactly those hours this re-reads the hour at the last CHAIN block with header timestamp < h (binary search on
block headers), with the same Multicall3 getAssetPrice read and the header's base fee. Other hours are unchanged.

  python3 r111v5_hourfix.py --mk avax --work WORK
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r111v3_acquire as A  # noqa: E402
import r111v3_rpc as X  # noqa: E402


def last_block_before(cl, ts, lo, hi):
    """Largest block in [lo, hi] with header timestamp < ts (lo has ts < ts)."""
    while lo < hi:
        m = (lo + hi + 1) // 2
        if cl.header_ts(m) < ts:
            lo = m
        else:
            hi = m - 1
    return lo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mk", required=True)
    ap.add_argument("--work", required=True)
    a = ap.parse_args()
    m = A.MARKETS[a.mk]
    cl = X.Client(m["chain"], interval=0.05, calls=True)
    hd = os.path.join(a.work, "hourly")
    rs = A.jload(os.path.join(a.work, "reserves.json.gz"))
    allassets = [r["asset"] for r in rs["reserves"]]
    data = X.aggregate3_data([(m["oracle"], X.sel("getAssetPrice(address)") + X.enc_addr(x)) for x in allassets])
    fixed = []
    for n in sorted(os.listdir(hd)):
        p = os.path.join(hd, n)
        h = A.jload(p)
        changed = False
        for i, r in enumerate(h["rows"]):
            if r["ts"] >= r["hour"] - 3600 or r.get("checked_last_chain_block"):
                continue
            step = 64
            while cl.header_ts(r["block"] + step) < r["hour"]:      # exponential search for an upper bound
                step *= 2
            blk = last_block_before(cl, r["hour"], r["block"], r["block"] + step)
            hdr = None
            for _ in range(20):
                hdr = cl.request("eth_getBlockByNumber", [hex(blk), False])
                if hdr and hdr.get("timestamp"):
                    break
            hts = int(hdr["timestamp"], 16)
            if not hts < r["hour"]:
                raise SystemExit(f"block search failed before {r['hour']}")
            halt = hts < r["hour"] - 3600     # no chain block at all in [h - 1 h, h): the chain halted (state = blk)
            dec = X.aggregate3_decode(cl.request("eth_call", [{"to": X.MULTICALL3, "data": data}, hex(blk)]))
            if len(dec) != len(allassets):
                raise SystemExit("hourly multicall undecodable")
            fixed.append({"hour": r["hour"], "old_block": r["block"], "old_age_s": r["hour"] - r["ts"], "new_age_s": r["hour"] - hts, "chain_halt": bool(halt)})
            h["rows"][i] = {"hour": r["hour"], "block": blk, "ts": hts, "base_fee": int(hdr.get("baseFeePerGas") or "0x0", 16),
                            "prices": [X.word(x) if ok and len(x) == 32 else None for ok, x in dec],
                            "checked_last_chain_block": True}
            changed = True
        if changed:
            A.jdump(p, h)
    old = A.jload(os.path.join(a.work, "hourly-fix.json.gz"))["fixed"] if os.path.exists(os.path.join(a.work, "hourly-fix.json.gz")) else []
    fixed = old + fixed
    A.jdump(os.path.join(a.work, "hourly-fix.json.gz"), {"fixed": fixed})
    print(json.dumps({"hours_fixed": len(fixed), "chain_halt_hours": sum(f["chain_halt"] for f in fixed),
                      "max_new_age_s_non_halt": max((f["new_age_s"] for f in fixed if not f["chain_halt"]), default=0),
                      "rpc": cl.stats}))


if __name__ == "__main__":
    main()
