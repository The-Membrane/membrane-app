"""Q26 R12.4 input acquisition, blind set B11 (membrane-board design/Q26_ROUND12_PREREG.md D-R12.3a R12.3-1, D-R12.4a).
Inputs only: no forecast, loss, outcome comparison or score is computed here.

  python3 r124_acquire.py meta   --work DIR                 resolve each reserve by symbol at the latest block; decimals;
                                                             the three latest-block checks (list, curve, rate-on-curve)
  python3 r124_acquire.py blocks --chain C --work DIR       b_d = last block with ts < d 00:00Z (r118_acquire, unchanged)
  python3 r124_acquire.py daily  --market M --work DIR      one read per day at b_d (r118_acquire.read_day, unchanged)
  python3 r124_acquire.py export --work DIR --out DIR       address-free daily inputs, counts and the R10.3 start reading

The daily read, block rule and RPC client are r118_acquire's (D-R11.8a R11.8-2). Curve-change hours are not read.
Free keyless JSON-RPC only. Contract addresses stay in code and --work; exported files name markets only.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r118_acquire as A  # noqa: E402

LAST_DAY = dt.date(2026, 10, 18)       # last read: block before 2026-10-18 00:00Z
RAY = 10 ** 27

CHAINS = {
    "ethereum": {"urls": ["https://eth.drpc.org", "https://rpc.mevblocker.io", "https://mainnet.gateway.tenderly.co"],
                 "first": dt.date(2020, 12, 1)},
    "polygon": {"urls": ["https://polygon.drpc.org", "https://polygon.gateway.tenderly.co"],
                "first": dt.date(2021, 3, 31)},
    # api.avax.network answered archive calls in about 1.8 s; Tenderly in about 0.13 s (2026-10-18)
    "avalanche": {"urls": ["https://avalanche.gateway.tenderly.co", "https://gateway.tenderly.co/public/avalanche"],
                  "first": dt.date(2021, 9, 20)},
    "arbitrum": {"urls": ["https://arbitrum.gateway.tenderly.co", "https://gateway.tenderly.co/public/arbitrum"],
                 "first": dt.date(2022, 9, 1), "min_block": 22_207_818},          # Nitro genesis
    "optimism": {"urls": ["https://mainnet.optimism.io", "https://optimism.gateway.tenderly.co"],
                 "first": dt.date(2022, 3, 12), "legacy_urls": ["https://mainnet.optimism.io"],
                 "bedrock": 105_235_063},
    "base": {"urls": ["https://mainnet.base.org", "https://base.gateway.tenderly.co", "https://base.drpc.org"],
             "first": dt.date(2023, 8, 8)},
    "metis": {"urls": ["https://andromeda.metis.io/?owner=1088", "https://metis.drpc.org",
                       "https://metis-rpc.publicnode.com"], "first": dt.date(2023, 5, 8)},
    "gnosis": {"urls": ["https://rpc.gnosischain.com"], "first": dt.date(2023, 11, 7)},
    "bnb": {"urls": ["https://bsc-mainnet.public.blastapi.io"], "first": dt.date(2024, 1, 23)},
    "scroll": {"urls": ["https://rpc.scroll.io", "https://scroll.drpc.org", "https://scroll-rpc.publicnode.com"],
               "first": dt.date(2024, 2, 9)},
    "zksync": {"urls": ["https://mainnet.era.zksync.io"], "first": dt.date(2024, 9, 20)},
    "linea": {"urls": ["https://rpc.linea.build", "https://linea.drpc.org"], "first": dt.date(2025, 2, 11)},
    "sonic": {"urls": ["https://rpc.soniclabs.com", "https://sonic.drpc.org", "https://sonic-rpc.publicnode.com"],
              "first": dt.date(2025, 3, 3)},
    # Celo L2 migration 2025-03-26: earlier state is not served by the keyless endpoints (D-R12.3a: first readable day)
    "celo": {"urls": ["https://forno.celo.org", "https://celo.drpc.org"], "first": dt.date(2025, 3, 27),
             "min_block": 31_056_500},
    "mantle": {"urls": ["https://rpc.mantle.xyz", "https://mantle.drpc.org"], "first": dt.date(2023, 7, 21)},
}

V3_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
POOLS = {   # instance: (chain, pool, getReserveData layout)
    "v2-eth": ("ethereum", "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9", 2),
    "v3-prime": ("ethereum", "0x4e033931ad43597d96D6bcc25c280717730B58B1", 3),
    "v3-etherfi": ("ethereum", "0x0AA97c284e98396202b6A04024F5E2c65026F3c0", 3),
    "v2-poly": ("polygon", "0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf", 2),
    "v3-poly": ("polygon", V3_POOL, 3),
    "v2-avax": ("avalanche", "0x4F01AeD16D97E3aB5ab2B501154DC9bb0F1A5A2C", 2),
    "v3-avax": ("avalanche", V3_POOL, 3),
    "v3-arb": ("arbitrum", V3_POOL, 3),
    "v3-op": ("optimism", V3_POOL, 3),
    "granary-op": ("optimism", "0x8FD4aF47E4E63d1D2D45582c3286b4BD9Bb95DfE", 2),
    "v3-base": ("base", "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", 3),
    "seamless": ("base", "0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7", 3),
    "v3-metis": ("metis", "0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57", 3),
    "v3-gnosis": ("gnosis", "0xb50201558B00496A145fE76f7424749556E326D8", 3),
    "v3-bnb": ("bnb", "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", 3),
    "v3-scroll": ("scroll", "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", 3),
    "v3-zksync": ("zksync", "0x78e30497a3c7527d953c6B1E3541b021A98Ac43c", 3),
    "v3-linea": ("linea", "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac", 3),
    "v3-sonic": ("sonic", "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3", 3),
    "v3-celo": ("celo", "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402", 3),
    "lendle": ("mantle", "0xCFa5aE7c2CE8Fadc6426C1ff872cA45378Fb7cF3", 2),
}
# market id -> (instance, reserve symbol at the latest block). The 42 B11 reserves of D-R12.3a R12.3-1.
B11 = {
    "v2-eth-dai": ("v2-eth", "DAI"), "v3-prime-usdc": ("v3-prime", "USDC"), "v3-etherfi-usdc": ("v3-etherfi", "USDC"),
    "v2-poly-dai": ("v2-poly", "DAI"), "v2-poly-usdc": ("v2-poly", "USDC"), "v2-poly-usdt": ("v2-poly", "USDT0"),
    "v3-poly-dai": ("v3-poly", "DAI"), "v3-poly-usdt": ("v3-poly", "USDT0"),
    "v2-avax-dai": ("v2-avax", "DAI.e"), "v2-avax-usdt": ("v2-avax", "USDT.e"), "v2-avax-usdc": ("v2-avax", "USDC.e"),
    "v3-avax-dai": ("v3-avax", "DAI.e"), "v3-avax-usdt": ("v3-avax", "USDt"),
    "v3-arb-dai": ("v3-arb", "DAI"), "v3-arb-usdt": ("v3-arb", "USD₮0"),
    "v3-op-dai": ("v3-op", "DAI"), "v3-op-usdt": ("v3-op", "USDT"),
    "granary-op-dai": ("granary-op", "DAI"), "granary-op-usdc": ("granary-op", "USDC"),
    "granary-op-usdt": ("granary-op", "USDT"),
    "v3-base-usdbc": ("v3-base", "USDbC"), "seamless-usdbc": ("seamless", "USDbC"), "seamless-usdc": ("seamless", "USDC"),
    "seamless-dai": ("seamless", "DAI"),
    "v3-metis-dai": ("v3-metis", "m.DAI"), "v3-metis-usdc": ("v3-metis", "m.USDC"), "v3-metis-usdt": ("v3-metis", "m.USDT"),
    "v3-gnosis-usdc": ("v3-gnosis", "USDC"), "v3-gnosis-usdce": ("v3-gnosis", "USDC.e"),
    "v3-gnosis-wxdai": ("v3-gnosis", "WXDAI"),
    "v3-bnb-usdc": ("v3-bnb", "USDC"), "v3-bnb-usdt": ("v3-bnb", "USDT"), "v3-scroll-usdc": ("v3-scroll", "USDC"),
    "v3-zksync-usdc": ("v3-zksync", "USDC"), "v3-zksync-usdt": ("v3-zksync", "USDT"),
    "v3-linea-usdc": ("v3-linea", "USDC"), "v3-linea-usdt": ("v3-linea", "USDT"), "v3-sonic-usdc": ("v3-sonic", "USDC"),
    "v3-celo-usdc": ("v3-celo", "USDC"), "v3-celo-usdt": ("v3-celo", "USD₮"),
    "lendle-usdc": ("lendle", "USDC"), "lendle-usdt": ("lendle", "USDT"),
}
SIG_LIST = A.B.keccak256(b"getReservesList()")[:4]
SIG_SYMBOL = A.B.keccak256(b"symbol()")[:4]
SIG_DEC = A.B.keccak256(b"decimals()")[:4]


def install(work):
    """Point r118_acquire's globals at B11 (its functions read CHAINS, MARKETS and LAST_DAY at call time)."""
    A.CHAINS.clear()
    A.CHAINS.update(CHAINS)
    A.LAST_DAY = LAST_DAY
    A.MARKETS.clear()
    meta = A.jload(os.path.join(work, "meta.json.gz"), {})
    for m, r in meta.items():
        if r.get("included"):
            A.MARKETS[m] = {"chain": r["chain"], "pool": r["pool"], "v": r["v"], "asset": r["asset"]}
    return meta


def decode_string(h):
    b = bytes.fromhex(h[2:]) if h and h != "0x" else b""
    if len(b) == 32:
        return b.rstrip(b"\0").decode(errors="replace")
    if len(b) >= 64:
        n = int.from_bytes(b[32:64], "big")
        return b[64:64 + n].decode(errors="replace")
    return ""


def rate_on_curve(d):
    """True when the stored variable rate is within 1% of the curve at current usage (mechanics check)."""
    o, b0, s1, s2 = [int(x) for x in d["curve"]]
    debt = int(d["vdebt"]) + int(d["sdebt"])
    av = int(d["virtual"]) if d.get("virtual") not in (None, "None") else int(d["cash"])
    if debt + av == 0 or o == 0:
        return False
    U = debt * RAY // (debt + av)
    r = b0 + (s1 * U // o if U <= o else s1 + s2 * (U - o) // (RAY - o))
    st = int(d["rate_ray"])
    return abs(r - st) <= 0.01 * max(st, 1)


def phase_meta(work):
    path = os.path.join(work, "meta.json.gz")
    out = A.jload(path, {})
    lists = {}
    for m, (inst, sym) in B11.items():
        if m in out and out[m].get("checked"):
            continue
        chain, pool, v = POOLS[inst]
        rpc = A.Rpc(CHAINS[chain]["urls"], interval=0.4)
        rec = {"chain": chain, "pool": pool, "v": v, "symbol": sym, "checked": False, "included": False}
        try:
            if inst not in lists:
                res = rpc.batch([("eth_call", [{"to": pool, "data": "0x" + SIG_LIST.hex()}, "latest"])])[0]
                w = A.words(res)
                lists[inst] = ["0x" + x.to_bytes(32, "big")[12:].hex() for x in w[2:]] if w else []
            syms = []
            for i in range(0, len(lists[inst]), 5):     # small batches: some keyless endpoints refuse large ones
                syms += rpc.batch([("eth_call", [{"to": a, "data": "0x" + SIG_SYMBOL.hex()}, "latest"])
                                   for a in lists[inst][i:i + 5]])
            hits = [a for a, h in zip(lists[inst], syms) if decode_string(h) == sym]
            rec["check_listed"] = len(hits) == 1
            if len(hits) == 1:
                a = hits[0]
                rec["asset"] = a
                rec["decimals"] = A.one(rpc.batch([("eth_call", [{"to": a, "data": "0x" + SIG_DEC.hex()},
                                                                  "latest"])])[0])
                hb, _ = A.head(rpc)
                d = A.read_day(rpc, {"chain": chain, "pool": pool, "v": v, "asset": a}, hb - 5, CHAINS[chain]["urls"])
                rec["check_curve"] = bool(d.get("listed")) and d.get("curve") is not None
                rec["curve_abi"] = d.get("curve_abi")
                rec["check_rate_on_curve"] = bool(rec["check_curve"] and rate_on_curve(d))
            rec["checked"] = True
            rec["included"] = bool(rec.get("check_listed") and rec.get("check_curve") and rec.get("check_rate_on_curve"))
        except RuntimeError as e:          # endpoint failure: not checked; rerun meta to resume
            rec["error"] = str(e)[:80]
        out[m] = rec
        A.jdump(path, out)
        print(f"meta {m}: checked {rec['checked']} included {rec['included']}", flush=True)
    n = sum(1 for r in out.values() if r.get("included"))
    print(f"meta: {n} of {len(B11)} included; unchecked {[m for m, r in out.items() if not r.get('checked')]}; "
          f"dropped {[m for m, r in out.items() if r.get('checked') and not r.get('included')]}", flush=True)


def phase_export(work, out_dir):
    meta = install(work)
    os.makedirs(out_dir, exist_ok=True)
    counts, r103_start, info = {}, {}, {}
    for m in B11:
        r = meta.get(m, {})
        if not r.get("included"):
            counts[m] = {"status": "dropped" if r.get("checked") else "unchecked",
                         "checks": {k: r.get(k) for k in ("check_listed", "check_curve", "check_rate_on_curve")}}
            continue
        daily = A.jload(os.path.join(work, f"daily-{m}.json.gz"))
        if not daily:
            counts[m] = {"status": "missing"}
            continue
        dec = int(r["decimals"])
        strat_ids, rows = {}, []
        for k in sorted(daily):
            x = daily[k]
            if not x.get("listed"):
                continue
            sid = strat_ids.setdefault(x["strategy"], len(strat_ids))
            c = x["curve"] or [None] * 4
            rows.append({"date": k, "block": x["block"], "block_ts": x["block_ts"], "rate_ray": x["rate_ray"],
                         "variable_debt_raw": x["vdebt"], "stable_debt_raw": x["sdebt"], "cash_balance_raw": x["cash"],
                         "virtual_balance_raw": x["virtual"] if x["virtual"] is not None else "",
                         "optimal_usage_ray": c[0], "base_rate_ray": c[1], "slope1_ray": c[2], "slope2_ray": c[3],
                         "curve_abi": x["curve_abi"], "strategy_idx": sid, "active": x["active"],
                         "frozen": x["frozen"], "reserve_factor_bps": x["rf_bps"]})
        if not rows:
            counts[m] = {"status": "never listed in the read span"}
            continue
        p = os.path.join(out_dir, f"daily-{m}.csv.gz")
        with gzip.open(p, "wt", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        bad, n_debt = [], 0
        for x in rows:
            debt = int(x["variable_debt_raw"]) + int(x["stable_debt_raw"] if x["stable_debt_raw"] != "None" else 0)
            avail = int(x["virtual_balance_raw"]) if x["virtual_balance_raw"] != "" else int(x["cash_balance_raw"])
            n_debt += debt >= 1_000_000 * 10 ** dec
            if not (debt > 0 and avail > 0):
                bad.append(x["date"])
        last_bad = bad[-1] if bad else None
        r103_start[m] = ((dt.date.fromisoformat(last_bad) + dt.timedelta(days=1)).isoformat() if last_bad
                         else rows[0]["date"])
        dates = [dt.date.fromisoformat(x["date"]) for x in rows]
        info[m] = {"version": r["v"], "chain": r["chain"], "symbol": r["symbol"], "decimals": dec}
        counts[m] = {"status": "ok", "days": len(rows), "first": rows[0]["date"], "last": rows[-1]["date"],
                     "gaps": sum(1 for a, b in zip(dates, dates[1:]) if (b - a).days != 1),
                     "curve_missing": sum(1 for x in rows if x["optimal_usage_ray"] is None),
                     "strategies": len(strat_ids),
                     "stable_debt_days": sum(1 for x in rows if x["stable_debt_raw"] not in ("0", "None")),
                     "virtual_days": sum(1 for x in rows if x["virtual_balance_raw"] != ""),
                     "usage_outside_open_unit_days": len(bad), "days_debt_ge_1m": n_debt,
                     "sha256_daily": A.sha256_file(p)}
    with open(os.path.join(out_dir, "reserves-r124.json"), "w") as f:
        json.dump(info, f, indent=1, ensure_ascii=False)
    with open(os.path.join(out_dir, "readings-r124.json"), "w") as f:
        json.dump({"r103_start": r103_start,
                   "rule": "R10.3 day series of a market starts the day after its last day with usage outside (0,1) "
                           "(debt = 0 or available = 0), else on its first listed day (D-R11.8b reading); counts only."},
                  f, indent=1)
    with open(os.path.join(out_dir, "acquire-counts.json"), "w") as f:
        json.dump({"created_utc": A.utcnow(), "markets": counts}, f, indent=1, ensure_ascii=False)
    for name in os.listdir(out_dir):
        fp = os.path.join(out_dir, name)
        data = gzip.open(fp, "rt").read() if name.endswith(".gz") else open(fp).read()
        if A.ADDR_RE.search(data):
            raise SystemExit(f"STOP: address-like string in {name}")
    print(json.dumps(counts, indent=1, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["meta", "blocks", "daily", "export"])
    ap.add_argument("--chain")
    ap.add_argument("--market")
    ap.add_argument("--work", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    print(f"start {A.utcnow()} {a.cmd} {a.chain or a.market or ''}", flush=True)
    if a.cmd == "meta":
        install(a.work)
        phase_meta(a.work)
    elif a.cmd == "blocks":
        install(a.work)
        A.phase_blocks(a.chain, a.work)
    elif a.cmd == "daily":
        meta = install(a.work)
        if not meta.get(a.market, {}).get("included"):
            raise SystemExit(f"STOP: {a.market} is not an included B11 reserve")
        A.phase_daily(a.market, a.work)
    else:
        phase_export(a.work, a.out)
    print(f"end {A.utcnow()}", flush=True)


if __name__ == "__main__":
    main()
