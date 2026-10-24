#!/usr/bin/env python3
"""Q26 R18.5 step 1b: supply-incentive switches (on-chain RewardsController) for the seen L2 V3 USDC markets.

membrane-board design/Q26_ROUND18_PREREG.md R18.5. Configuration history only (no outcome byte is read here except
the seen R11.8 daily totals, used to turn emissions into an APR at the pre-switch supply).

Sources (all free, keyless):
  - Aave V3 RewardsController `AssetConfigUpdated(asset, reward, oldEmission, newEmission, oldDistEnd, newDistEnd,
    assetIndex)` logs filtered by the USDC aToken:
      Optimism, Arbitrum, Polygon: eth_getLogs over the full range on *.gateway.tenderly.co (Arbitrum cross-checked
      on arb1.arbitrum.io in 10M-block chunks: identical);
      Avalanche: Routescan etherscan-compatible logs API (one detected gap: the 2024-10-08 sAVAX log's old emission
      matches no earlier log, so this source may be incomplete);
      Base: no log source worked keyless (Blockscout behind Cloudflare, tenderly 1000-block cap); getRewardsData is
      read at the R11.8 daily blocks (14-day scan + bisection), so a change that reverts within 14 days is missed.
  - Completeness: getRewardsByAsset(aToken) at latest lists every reward ever configured (the list only grows).
  - Reward token prices: DefiLlama coins chart (coingecko ids), daily.
  - Merit (ACI, off-chain) and Merkl campaigns are NOT covered: the ACI API serves current/previous APR only; Merkl
    lists one V3 USDC supply campaign in the window (Base, OP, 2024-07-09..07-23), reported separately.

A distribution end is a scheduled timestamp with no log; it is an "off" switch at the first daily read after it.
Dose at daily read d (points): sum over streams of [e_d * on_d - e_{d-1} * on_{d-1}] * 31536000 * price_{d-1} /
supply_{d-1} * 100, i.e. the change in incentive APR at the pre-switch price and supply.

  python3 r185_incentives.py --datasets <membrane-datasets> --work <scratch dir> --out <dir>
Outputs (address-free): r185-incentive-events.csv, r185-incentive-summary.json.
"""
import argparse
import bisect
import gzip
import csv
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

YEAR = 31536000
T0 = "0xac1777479f07f3e7c34da8402139d54027a6a260caaae168bdee825ca5580dc5"   # AssetConfigUpdated
SEL_BY_ASSET = "0x6657732f"   # getRewardsByAsset(address)
SEL_DATA = "0x7eff4ba8"       # getRewardsData(address,address)
IC = "0x929ec64c34a17401f460460d4b9390518e5b473e"
IC_BASE = "0xf9cc4f0d883f1a1eb2c253bdb46c254ca51e1f44"
AUSDCE = "0x625e7708f30ca75bfd92586e17077590c60eb4cd"
RPC = {"op": "https://optimism.gateway.tenderly.co", "arb": "https://arbitrum.gateway.tenderly.co",
       "poly": "https://polygon.gateway.tenderly.co", "avax": "https://api.avax.network/ext/bc/C/rpc",
       "base": "https://base.gateway.tenderly.co", "base_b": "https://base.drpc.org"}
ROUTESCAN_AVAX = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api"
MARKETS = {  # market -> (chain, aToken, controller)
    "v3-op-usdce": ("op", AUSDCE, IC), "v3-arb-usdce": ("arb", AUSDCE, IC), "v3-poly-usdce": ("poly", AUSDCE, IC),
    "v3-avax-usdc": ("avax", AUSDCE, IC),
    "v3-arb-usdc": ("arb", "0x724dc807b04555b71ed48a6896b6f41593b8c637", IC),
    "v3-op-usdc": ("op", "0x38d693ce1df5aadf7bc62595a37d667ad57922e5", IC),
    "v3-poly-usdc": ("poly", "0xa4d94019934d8333ef880abffbf2fdd611c762bd", IC),
    "v3-base-usdc": ("base", "0x4e65fe4dba92790696d040ac24aa414708f5c0ab", IC_BASE)}
# reward symbol -> (coingecko id or None for a USD aToken, decimals)
REWARD = {"OP": ("optimism", 18), "ARB": ("arbitrum", 18), "WAVAX": ("avalanche-2", 18),
          "sAVAX": ("benqi-liquid-staked-avax", 18), "aBasUSDC": (None, 6)}


def _post(url, body, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", "User-Agent": "curl/8"})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except Exception:
            time.sleep(2 + 2 * k)
    raise RuntimeError("rpc failed: " + url.split("/")[2])


def _get(url, tries=4):
    for k in range(tries):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8"}),
                                                    timeout=60))
        except Exception:
            time.sleep(2 + 2 * k)
    raise RuntimeError("get failed: " + url.split("/")[2])


def rpc(ch, method, params):
    r = _post(RPC[ch], {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "result" not in r:
        raise RuntimeError(f"{ch} {method}: {str(r.get('error'))[:120]}")
    return r["result"]


pad = lambda a: "0" * 24 + a.lower()[2:]


def dstr(h):
    b = bytes.fromhex(h[2:])
    o = int.from_bytes(b[:32], "big")
    n = int.from_bytes(b[o:o + 32], "big")
    return b[o + 32:o + 32 + n].decode()


def rewards_now(ch, at, ic):
    r = bytes.fromhex(rpc(ch, "eth_call", [{"to": ic, "data": SEL_BY_ASSET + pad(at)}, "latest"])[2:])
    n = int.from_bytes(r[32:64], "big") if len(r) >= 64 else 0
    out = []
    for i in range(n):
        rw = "0x" + r[64 + 32 * i + 12:64 + 32 * i + 32].hex()
        x = bytes.fromhex(rpc(ch, "eth_call", [{"to": ic, "data": SEL_DATA + pad(at) + pad(rw)}, "latest"])[2:])
        v = [int.from_bytes(x[32 * k:32 * k + 32], "big") for k in range(4)]
        sym = dstr(rpc(ch, "eth_call", [{"to": rw, "data": "0x95d89b41"}, "latest"]))
        out.append({"reward": rw, "sym": sym, "emission": v[1], "distEnd": v[3]})
    return out


def logs_for(ch, at, ic):
    if ch == "avax":
        u = (f"{ROUTESCAN_AVAX}?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address={ic}&topic0={T0}"
             f"&topic1=0x{pad(at)}&topic0_1_opr=and")
        L = _get(u)["result"]
    else:
        L = rpc(ch, "eth_getLogs", [{"address": ic, "topics": [T0, "0x" + pad(at)], "fromBlock": "0x0",
                                     "toBlock": "latest"}])
    out = []
    for l in L:
        d = bytes.fromhex(l["data"][2:])
        v = [int.from_bytes(d[32 * i:32 * i + 32], "big") for i in range(4)]
        out.append({"block": int(l["blockNumber"], 16), "logIndex": int(l.get("logIndex", "0x0"), 16),
                    "reward": "0x" + l["topics"][2][-40:], "oldE": v[0], "newE": v[1], "oldEnd": v[2], "newEnd": v[3]})
    return sorted(out, key=lambda x: (x["block"], x["logIndex"]))


def base_bisect(days, at, rw, ic):
    cache = {}

    def rd(i):
        if i not in cache:
            for ch in ("base", "base_b", "base"):
                try:
                    x = bytes.fromhex(rpc(ch, "eth_call", [{"to": ic, "data": SEL_DATA + pad(at) + pad(rw)},
                                                           hex(days[i][1])])[2:])
                    cache[i] = (int.from_bytes(x[32:64], "big"), int.from_bytes(x[96:128], "big"))
                    break
                except Exception:
                    time.sleep(2)
            else:
                raise RuntimeError("base read failed")
        return cache[i]
    idx = list(range(0, len(days), 14)) + [len(days) - 1]
    ch_ = []
    for a, b in zip(idx, idx[1:]):
        if rd(b) != rd(a):
            lo, hi = a, b
            while hi - lo > 1:
                m = (lo + hi) // 2
                lo, hi = (m, hi) if rd(m) == rd(lo) else (lo, m)
            ch_.append({"block": days[hi][1] - 1, "logIndex": 0, "reward": rw, "oldE": rd(lo)[0], "newE": rd(hi)[0],
                        "oldEnd": rd(lo)[1], "newEnd": rd(hi)[1], "approx_day_read": days[hi][0]})
    return ch_, len(cache)


def price_at(prices, cg, day, maxgap=7):
    """Last daily price on or before `day` (at most `maxgap` days old); None if absent."""
    P = prices.get(cg, {})
    if day in P:
        return P[day]
    ks = sorted(P)
    i = bisect.bisect_right(ks, day) - 1
    if i < 0:
        return None
    from datetime import date
    gap = (date.fromisoformat(day) - date.fromisoformat(ks[i])).days
    return P[ks[i]] if gap <= maxgap else None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--prices", default=None, help="cached reward_prices.json (DefiLlama) to skip the fetch")
    a = ap.parse_args(argv)
    os.makedirs(a.work, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)
    r118 = os.path.join(a.datasets, "history-forecasts/r11/r118-inputs-9ab156bb")
    starts = json.load(open(os.path.join(r118, "readings-r118.json")))["r103_start"]
    # prices
    if a.prices:
        prices = json.load(open(a.prices))["prices"]
    else:
        prices = {}
        for sym, (cg, _) in REWARD.items():
            if not cg:
                continue
            P = {}
            for st in (1648771200, 1648771200 + 400 * 86400, 1648771200 + 800 * 86400):
                d = _get(f"https://coins.llama.fi/chart/coingecko:{cg}?start={st}&span=400&period=1d")
                for v in d["coins"].values():
                    for p in v["prices"]:
                        P[time.strftime("%Y-%m-%d", time.gmtime(p["timestamp"]))] = p["price"]
            prices[cg] = dict(sorted(P.items()))
        json.dump({"source": "coins.llama.fi/chart", "prices": prices}, open(os.path.join(a.work, "reward_prices.json"), "w"))
    raw, events, summ = {}, [], {"markets": {}}
    for m, (ch, at, ic) in MARKETS.items():
        rows = list(csv.DictReader(gzip.open(os.path.join(r118, f"daily-{m}.csv.gz"), "rt")))
        days = [(r["date"], int(r["block"]), int(r["block_ts"])) for r in rows]
        blocks = [d[1] for d in days]
        sup = {}
        for r in rows:
            vb, cash = r["virtual_balance_raw"], r["cash_balance_raw"]
            av = float(vb) if vb not in ("", None) else float(cash or 0)
            debt = float(r["variable_debt_raw"] or 0) + float(r["stable_debt_raw"] or 0)
            sup[r["date"]] = (av + debt) / 1e6
        now = rewards_now(ch, at, ic)
        syms = {x["reward"]: x["sym"] for x in now}
        nb = None
        if ch == "base":
            L = []
            for x in now:
                c_, nb = base_bisect([(d[0], d[1]) for d in days], at, x["reward"], ic)
                L += c_
        else:
            L = logs_for(ch, at, ic) if now else []
        raw[m] = {"now": now, "logs": L}
        # last-log consistency with current state
        cons = {}
        for x in now:
            ls = [l for l in L if l["reward"] == x["reward"]]
            cons[x["sym"]] = bool(ls) and ls[-1]["newE"] == x["emission"] and ls[-1]["newEnd"] == x["distEnd"]
        # piecewise config per reward at each daily read: apply logs with block <= b_d
        streams = {}
        for rw in syms:
            ls = [l for l in L if l["reward"] == rw]
            seq = []
            for i, (dt, b, ts) in enumerate(days):
                cur = None
                for l in ls:
                    if l["block"] <= b:
                        cur = l
                e, end = (cur["newE"], cur["newEnd"]) if cur else (0, 0)
                seq.append((e, end, ts))
            streams[rw] = seq
        nlog_gap = 0
        for rw in syms:
            ls = [l for l in L if l["reward"] == rw]
            for p, q in zip(ls, ls[1:]):
                if q["oldE"] != p["newE"]:
                    nlog_gap += 1
        for i in range(1, len(days)):
            dt, b, ts = days[i]
            pdt = days[i - 1][0]
            S0 = sup.get(pdt, 0.0)
            dose, parts = 0.0, []
            for rw, seq in streams.items():
                e1, end1, ts1 = seq[i]
                e0, end0, ts0 = seq[i - 1]
                on1 = e1 if end1 > ts1 else 0
                on0 = e0 if end0 > ts0 else 0
                if on1 == on0:
                    continue
                sym = syms[rw]
                cg, dec = REWARD.get(sym, (None, 18))
                px = 1.0 if cg is None else price_at(prices, cg, pdt)
                if px is None or S0 <= 0:
                    parts.append((sym, on0, on1, None))
                    continue
                d_ = (on1 - on0) / 10 ** dec * YEAR * px / S0 * 100
                dose += d_
                kind = "on" if on0 == 0 else ("off" if on1 == 0 else "change")
                lapse = on1 == 0 and e1 > 0 and end1 <= ts1
                parts.append((sym, on0, on1, d_, kind, lapse))
            if not parts:
                continue
            apr_pre = 0.0
            for rw, seq in streams.items():
                e0, end0, ts0 = seq[i - 1]
                cg, dec = REWARD.get(syms[rw], (None, 18))
                px = 1.0 if cg is None else price_at(prices, cg, pdt)
                if e0 and end0 > ts0 and px and S0 > 0:
                    apr_pre += e0 / 10 ** dec * YEAR * px / S0 * 100
            events.append({"market": m, "date": dt, "pre_date": pdt,
                           "rewards": "+".join(p[0] for p in parts),
                           "kind": "/".join(p[4] if len(p) > 4 else "noprice" for p in parts),
                           "scheduled_lapse": any(len(p) > 5 and p[5] for p in parts),
                           "incentive_apr_pre_pts": apr_pre, "dose_pts": dose if all(p[3] is not None for p in parts) else None,
                           "supply_usd_pre": S0, "before_r103_start": dt < starts[m]})
        summ["markets"][m] = {"rewardsEverConfigured": [x["sym"] for x in now], "nConfigChanges": len(L),
                              "lastLogMatchesState": cons, "logSequenceGaps": nlog_gap,
                              **({"baseStateReads": nb} if nb else {})}
    json.dump(raw, open(os.path.join(a.work, "rc_raw.json"), "w"))   # holds addresses: scratch only
    import pandas as pd
    E = pd.DataFrame(events).sort_values(["date", "market"]).reset_index(drop=True)
    E.to_csv(os.path.join(a.out, "r185-incentive-events.csv"), index=False, float_format="%.6g")
    ok = E[(~E["before_r103_start"]) & E["dose_pts"].notna()]
    big = ok[ok["dose_pts"].abs() >= 0.10]
    q = lambda s: [round(float(x), 4) for x in s.abs().quantile([0.1, 0.25, 0.5, 0.75, 0.9])] if len(s) else []
    summ.update({"schema": "q26-r185/incentive-events/1", "nSwitchDays": int(len(E)),
                 "nInWindow": int(len(ok)), "nAbsGE0.10pts": int(len(big)),
                 "nAbsGE0.25pts": int((ok["dose_pts"].abs() >= 0.25).sum()),
                 "nAbsGE0.50pts": int((ok["dose_pts"].abs() >= 0.50).sum()),
                 "nAbsGE1.00pts": int((ok["dose_pts"].abs() >= 1.0).sum()),
                 "byMarketAbsGE0.10": big["market"].value_counts().to_dict(),
                 "absDoseQ10_25_50_75_90_AbsGE0.10": q(big["dose_pts"]),
                 "kindsAbsGE0.10": big["kind"].value_counts().to_dict(),
                 "scheduledLapsesAbsGE0.10": int(big["scheduled_lapse"].sum()),
                 "merklV3UsdcSupplyCampaigns": [{"market": "v3-base-usdc", "reward": "OP", "start": "2024-07-09",
                                                 "end": "2024-07-23", "note": "Merkl API; APR not computed"}],
                 "notCovered": "ACI Merit (off-chain; no free history), Merkl campaigns beyond the one listed"})
    json.dump(summ, open(os.path.join(a.out, "r185-incentive-summary.json"), "w"), indent=1, default=str)
    pd.set_option("display.width", 250)
    print(E.to_string())
    print(json.dumps(summ, indent=1, default=str))


if __name__ == "__main__":
    sys.exit(main())
