"""Q26-PL PL.1: measured driver catalogue for Aave V3 Ethereum pair loops. No forecast.
  steps      hours with |Δ ln ER| >= 0.25 % for any capped collateral vs its base (ETH LSTs vs WETH, BTC LSTs vs WBTC)
  events     the LST/WETH liquidations classed step / mixed / accrual-candidate / dust (aggregates only, no address)
  exceed     WETH borrow-APR exceedance table (hours and 28-day blocks above fixed levels and above staking yield + m)
Aggregates only. Reads membrane-datasets pair-loop/hourly.jsonl, aave-liquidations/aave_liquidations.jsonl.gz, price-history/lst-rates-1d.json.
"""
import argparse, gzip, collections, datetime as dt, gzip, json, os
import numpy as np
import pl2_cells as P

ETH_LST = ["wstETH", "weETH", "rsETH", "osETH", "cbETH", "rETH", "ETHx"]
BTC_LST = ["LBTC", "eBTC"]
ADDR = {"WETH": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "WBTC": "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
        "wstETH": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", "weETH": "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
        "rsETH": "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7", "osETH": "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38",
        "cbETH": "0xbe9895146f7af43049ca1c1ae358b0541ea49704", "rETH": "0xae78736cd615f374d3085123a210448e74fc6393",
        "ETHx": "0xa35b1b31ce002fbf2058d22f30f95d405200a15b", "LBTC": "0x8236a87084f8b84306f72007f36f2618a5634494",
        "eBTC": "0x657e8c867d8b37dcc18fa4caead9c45eb088c642"}
STEP = 0.0025


def iso(t): return dt.datetime.fromtimestamp(int(t), dt.UTC).strftime("%Y-%m-%dT%H:%MZ")


def rows_of(path):
    rows = [json.loads(l) for l in (gzip.open(path + ".gz", "rt") if os.path.exists(path + ".gz") else open(path)) if l.strip()]
    rows = [r for r in rows if "err" not in r]
    rows.sort(key=lambda r: r["t"])
    return rows


def steps(rows):
    out = []
    for base, lsts in (("WETH", ETH_LST), ("WBTC", BTC_LST)):
        for c in lsts:
            prev = None
            for r in rows:
                pb, pc = r["px"].get(base), r["px"].get(c)
                if not pb or not pc:
                    prev = None; continue
                er = pc / pb
                if prev is not None and abs(np.log(er / prev[1])) >= STEP:
                    out.append({"asset": c, "base": base, "t": iso(r["t"]), "block": r["b"], "from": round(prev[1], 6), "to": round(er, 6),
                                "step_pct": round((er / prev[1] - 1) * 100, 3)})
                prev = (r["t"], er)
    return out


def events(liq_path, step_rows):
    rows = [json.loads(l) for l in gzip.open(liq_path, "rt")]
    byuser = collections.defaultdict(list)
    for r in rows: byuser[r["user"]].append(r)
    T = lambda r: dt.datetime.fromisoformat(r["block_time"].replace("Z", "+00:00")).timestamp()
    lst_by_addr = {v: k for k, v in ADDR.items() if k not in ("WETH", "WBTC")}
    step_times = [(s["asset"], dt.datetime.strptime(s["t"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.UTC).timestamp()) for s in step_rows]
    cls = collections.Counter(); wei = collections.Counter(); per = []
    for r in rows:
        da, ca = r["debt_asset"].lower(), r["collateral_asset"].lower()
        if da not in (ADDR["WETH"], ADDR["WBTC"]) or ca not in lst_by_addr:
            continue
        c = lst_by_addr[ca]
        if (c in ETH_LST) != (da == ADDR["WETH"]):      # a correlated pair only: ETH LST vs WETH, BTC LST vs WBTC
            continue
        t = T(r); repaid = int(r["debt_to_cover"]) / (1e18 if da == ADDR["WETH"] else 1e8)
        mixed = any(abs(T(o) - t) < 3 * 86400 and o["debt_asset"].lower() not in (ADDR["WETH"], ADDR["WBTC"]) for o in byuser[r["user"]])
        stepped = any(a == c and -3600 <= t - st <= 24 * 3600 for a, st in step_times)   # the hourly sample sees a step up to 1 h after it happened
        k = "step" if stepped else "mixed" if mixed else "dust" if repaid < 0.1 else "accrual-candidate"
        cls[(c, k)] += 1; wei[(c, k)] += repaid
        per.append((r["block_time"][:13], c, k))
    return {"counts": {f"{c}|{k}": v for (c, k), v in sorted(cls.items())}, "repaid": {f"{c}|{k}": round(v, 3) for (c, k), v in sorted(wei.items())},
            "by_hour": collections.Counter(per).most_common(10)}


def exceed(rows, lst_path):
    H = P.load_hourly_rows(rows) if hasattr(P, "load_hourly_rows") else None
    t = np.array([r["t"] for r in rows if r["r"].get("WETH", {}).get("vbi", 0) > 0]); r = np.array([x["r"]["WETH"]["vbr"] for x in rows if x["r"].get("WETH", {}).get("vbi", 0) > 0]) / P.RAY
    rT, rV = P.load_wsteth_rate(lst_path)
    y = P.staking_yield(rT, rV, t)
    blk = (t - t[0]) // (28 * 86400)
    out = {"hours": int(len(t)), "blocks": int(len(np.unique(blk))), "span": [iso(t[0]), iso(t[-1])], "levels": {}, "excess": {}}
    for lv in (0.05, 0.10, 0.15, 0.20, 0.30, 0.50):
        m = r > lv; out["levels"][f">{int(lv*100)}%"] = {"hours": int(m.sum()), "blocks": int(len(np.unique(blk[m])))}
    for m_ in (0.0, 0.02, 0.05, 0.10):
        m = r > y + m_; out["excess"][f">y+{int(m_*100)}pp"] = {"hours": int(m.sum()), "blocks": int(len(np.unique(blk[m])))}
    out["max_apr_pct"] = round(float(r.max()) * 100, 2); out["max_apr_at"] = iso(t[int(r.argmax())])
    out["median_y_pct"] = round(float(np.nanmedian(y)) * 100, 2)
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--data", required=True); ap.add_argument("--liq", required=True); ap.add_argument("--lst", required=True); ap.add_argument("--out")
    a = ap.parse_args()
    rows = rows_of(os.path.join(a.data, "hourly.jsonl"))
    st = steps(rows)
    res = {"schema": "q26-pl1/1", "steps": st, "events": events(a.liq, st), "exceed": exceed(rows, a.lst)}
    print(json.dumps(res, indent=1, default=str))
    if a.out: json.dump(res, open(a.out, "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
