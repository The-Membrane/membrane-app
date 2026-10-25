#!/usr/bin/env python3
"""Q26 R11.1-mf item 3: which hourly reads lack a price, for which reserve and period (inputs only).

The integrity statistic `missing_price_any` (r111v4_gate.cmd_integrity) counts hourly reads where the engine price
vector has a 0 for ANY reserve of the market's final reserve list. This script splits those zeros by reserve and
period and sets each against the reserve's state in the daily anchor metas and the configurator listing events:
  - before listing: the reserve is not in the anchor meta of that day (not initialised in the Pool), or the hour is
    before its ReserveInitialized block;
  - listed but no price: listed, and the oracle read returned 0 or failed.
For "listed but no price" hours the reserve's anchor configuration (LT, active, frozen, borrowing bits) and the daily
anchor totals (aToken and debt supply) are reported, so the question "can any position hold a zero-priced reserve"
is answered from inputs only. It reads hourly reads, hourly-fix, metas, reserves and configurator events. It does not
open liq-LOCKED, the F1 key file or any outcome. Output is address-free (reserve symbols only).
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os

RES_INIT = "0x3a0ca721fc364424566385a1aa271ed508cc2c0949c2272575fb3013a163a45f"  # ReserveInitialized


def jl(p):
    with gzip.open(p, "rt") as f:
        return json.load(f)


def bits(cfg, lo, n):
    return (int(cfg) >> lo) & ((1 << n) - 1)


def day_of(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date().isoformat()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--first", default="2022-03-15")
    a = ap.parse_args()
    res_list = jl(os.path.join(a.work, "reserves.json.gz"))["reserves"]
    sym = {r["asset"].lower(): r["symbol"] for r in res_list}
    allres = list(sym)
    # listing block / ts from ReserveInitialized (topic1 = asset)
    ce = jl(os.path.join(a.work, "conf-events.json.gz"))["rows"]
    init = {}
    for r in ce:
        if r["topic0"].lower() == RES_INIT:
            asset = "0x" + r["topic1"][-40:].lower()
            init.setdefault(asset, r["ts"])
    metas = {}
    md = os.path.join(a.work, "meta")
    for n in sorted(os.listdir(md)):
        m = jl(os.path.join(md, n))
        metas[m["date"]] = {k.lower(): v for k, v in m["reserves"].items()}
    hd = os.path.join(a.work, "hourly")
    zero = {s: {"before_listing": 0, "listed_no_price": 0, "first": None, "last": None, "lnp_first": None,
                "lnp_last": None, "lnp_days": set(), "lnp_cfg": set(), "lnp_supply_nonzero_days": set()} for s in sym.values()}
    n_reads = n_any = n_any_listed = 0
    for n in sorted(os.listdir(hd)):
        h = jl(os.path.join(hd, n))
        assets = [x.lower() for x in h["assets"]]
        for row in h["rows"]:
            n_reads += 1
            px = {x: p for x, p in zip(assets, row["prices"])}
            any_, any_listed = False, False
            d = day_of(row["hour"] - 1)
            meta = metas.get(d, {})
            for x in allres:
                p = px.get(x)
                if p:
                    continue
                any_ = True
                z = zero[sym[x]]
                listed = x in meta and (x not in init or row["hour"] > init[x])
                if listed:
                    any_listed = True
                    z["listed_no_price"] += 1
                    z["lnp_first"] = z["lnp_first"] or row["hour"]
                    z["lnp_last"] = row["hour"]
                    z["lnp_days"].add(d)
                    c = meta[x].get("config")
                    if c is not None:
                        z["lnp_cfg"].add((bits(c, 16, 16), bits(c, 56, 1), bits(c, 57, 1), bits(c, 58, 1)))
                    supply = [int(meta[x].get(k) or 0) for k in ("aTokenTotal", "vDebtTotal", "sDebtTotal") if k in meta[x]]
                    if any(supply):
                        z["lnp_supply_nonzero_days"].add(d)
                else:
                    z["before_listing"] += 1
                z["first"] = z["first"] or row["hour"]
                z["last"] = row["hour"]
            n_any += int(any_)
            n_any_listed += int(any_listed)
    iso = lambda t: None if t is None else dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat()[:16]  # noqa: E731
    out = {"item": "Q26 R11.1-mf item 3: hourly reads without a price, by reserve (inputs only)",
           "hourly_reads": n_reads, "reads_missing_price_any": n_any,
           "reads_missing_price_for_a_listed_reserve": n_any_listed,
           "meta_keys_example": sorted(next(iter(next(iter(metas.values())).values())).keys()),
           "by_reserve": {}}
    for s, z in zero.items():
        if z["first"] is None:
            continue
        x = next(k for k, v in sym.items() if v == s)
        out["by_reserve"][s] = {"zero_hours_before_listing": z["before_listing"], "zero_hours_listed": z["listed_no_price"],
                                "zero_first_hour": iso(z["first"]), "zero_last_hour": iso(z["last"]),
                                "listing_ts": iso(init.get(x)), "first_anchor_meta_day": min((d for d in metas if x in metas[d]), default=None),
                                "listed_no_price_first": iso(z["lnp_first"]), "listed_no_price_last": iso(z["lnp_last"]),
                                "listed_no_price_days": len(z["lnp_days"]),
                                "listed_no_price_config_LT_active_frozen_borrow": sorted(z["lnp_cfg"]),
                                "listed_no_price_days_with_nonzero_supply_or_debt": sorted(z["lnp_supply_nonzero_days"])[:20],
                                "n_days_nonzero_supply_or_debt": len(z["lnp_supply_nonzero_days"])}
    # token rows of each new reserve between its listing and the end of its last zero-priced hour (the engine prices an
    # event with the hourly read of its hour, so events in that hour see price 0)
    import numpy as np
    win = {}
    for i, r in enumerate(res_list):
        s_, x = r["symbol"], r["asset"].lower()
        z = zero[s_]
        if z["first"] is not None and x in init:
            win[i] = (init[x], z["last"] + 3600)
    cnt = {i: {"rows": 0, "aToken_rows": 0, "debt_rows": 0, "users": set()} for i in win}
    td = os.path.join(a.work, "tok")
    for n in sorted(os.listdir(td), key=lambda q: int(q.split(".")[0])):
        zz = np.load(os.path.join(td, n))
        if not len(zz["ts"]):
            continue
        for i, (t0, t1) in win.items():
            m = (zz["res"] == i) & (zz["ts"] >= t0) & (zz["ts"] < t1)
            if m.any():
                c = cnt[i]
                c["rows"] += int(m.sum())
                c["aToken_rows"] += int((m & (zz["kind"] == 0)).sum())
                c["debt_rows"] += int((m & (zz["kind"] != 0)).sum())
                c["users"] |= set(zz["user"][m].tolist())
    for i, c in cnt.items():
        s_ = res_list[i]["symbol"]
        out["by_reserve"][s_]["zero_window_listing_to_first_priced_hour_min"] = round((win[i][1] - win[i][0]) / 60, 1)
        out["by_reserve"][s_]["token_rows_in_zero_window"] = {"rows": c["rows"], "aToken_rows": c["aToken_rows"],
                                                             "debt_rows": c["debt_rows"], "accounts": len(c["users"])}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(json.dumps(out, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
