"""Q26-TERMINAL prototype (membrane-board PROPOSAL Q26-TERMINAL, 2026-10-29): measured, non-forecast analytics.

  liqmap    Liquidation map from the D14 public hourly lines (forecasts/q26-borrower-alert/aave-v3/hourly/*.jsonl):
            Aave V3 debt by the price drop that brings it to health factor 1, per asset and distance band, summed over
            chains, for one arm (default: oracle), plus the change against the line 24 h earlier.
  xray      Position X-ray for one Aave V3 account, read live from keyless public RPC with the D14 readers: health
            factor, distance (k*: all non-stable prices move together, stables fixed), liquidation price of the main
            collateral, distance in units of trailing daily volatility (Binance 1 d closes, EWMA lambda 0.94), and the
            debt the latest map holds in the same band.

Every number is MEASURED (state or trailing history) and stamped with its source and time. Nothing here forecasts.
Scope limits (state them next to any display):
  - D14 bands only positions with 0 < d <= 10 %, debt >= $100 and at least one non-stable collateral. Stable/stable
    positions (depeg risk) and dust are not mapped. Audit 2026-10-29 (88 h, 6 chains): of 80 liquidated users, 50 were
    dust (< $100 repaid), 25 stable/stable, 5 volatile-collateral; D14 recorded 4 mapped-episode liquidations.
  - A position is banded under its largest non-stable collateral; k* moves every non-stable price together.
  - COVERAGE GAP (full Ethereum scan 2026-10-29 12:3xZ): of Aave V3 debt with health factor <= 1/0.9, the k* map
    holds ~$27M. Pair positions (non-stable debt against correlated collateral: weETH, rsETH, wstETH, osETH vs WETH)
    hold ~$3.8B and stable-only positions ~$0.37B; k* gives them no line (or one > 10 %). Their trigger is the
    collateral/debt RATIO. On Ethereum Aave prices weETH, rsETH, wstETH, osETH with "Capped <LST> / ETH / USD"
    exchange-rate oracles and USDe as "Capped USDT/USD" (read 2026-10-29): a market depeg does not move them, so
    these loops liquidate through rate accrual (borrow cost above the staking yield) or an exchange-rate drop.
    The X-ray reports them as riskType "pair" / "stable" with the collateral-only distance 1 - 1/HF.
  - Volatility in sigma units is trailing and measured; it is not a probability and must not be shown as one.
NO ADDRESS IS WRITTEN OR LOGGED by this module; xray returns only metrics.
"""
import argparse
import glob
import json
import math
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import q26_live_d14 as D  # noqa: E402

DAY_S = 86400
EWMA_LAMBDA = 0.94
VOL_DAYS = 90
SOURCE = "Aave V3 public state via D14 (membrane-app scripts/research/history-forecasts/live/q26_live_d14.py)"


# =====================================================================================================================
# liquidation map
# =====================================================================================================================
def load_rows(hourly_dir):
    rows = []
    for f in sorted(glob.glob(os.path.join(hourly_dir, "*.jsonl"))):
        with open(f) as fh:
            rows += [json.loads(line) for line in fh if line.strip()]
    rows.sort(key=lambda r: r["c"])
    return rows


def map_of(row, arm="oracle", only=None):
    """{asset: {"debtUsd": [5 bands], "n": [5 bands]}} summed over chains whose status is ok (and in `only` when
    given); plus chain status."""
    out, ok, stale = {}, [], []
    for ch, v in sorted(row.get("chains", {}).items()):
        if only is not None and ch not in only:
            continue
        if v.get("status") != "ok":
            stale.append(ch)
            continue
        ok.append(ch)
        for a, b in v.get("bands", {}).get(arm, {}).items():
            t = out.setdefault(a, {"debtUsd": [0.0] * len(D.BANDS), "n": [0] * len(D.BANDS)})
            t["debtUsd"] = [x + y for x, y in zip(t["debtUsd"], b["debtUsd"])]
            t["n"] = [x + y for x, y in zip(t["n"], b["n"])]
    return out, ok, stale


def liqmap(rows, arm="oracle", top=8, ago_h=24):
    if not rows:
        raise ValueError("no hourly lines")
    cur = rows[-1]
    m, ok, stale = map_of(cur, arm)
    prev_row = next((r for r in reversed(rows) if r["c"] <= cur["c"] - ago_h * 3600), None)
    # The 24 h change compares only chains that are ok in both lines; a stale chain must not read as a debt move.
    common = sorted(set(ok) & set(map_of(prev_row, arm)[1])) if prev_row else []
    pm = map_of(prev_row, arm, set(common))[0] if prev_row else {}
    mc = map_of(cur, arm, set(common))[0]
    assets = sorted(m, key=lambda a: -sum(m[a]["debtUsd"]))[:top]
    res = {"schema": "q26-terminal/liqmap/1", "asOf": D.iso(cur["c"]), "arm": arm, "bands": list(D.BAND_NAMES),
           "chainsOk": ok, "chainsStale": stale, "source": SOURCE, "kind": "measured",
           "compareTo": D.iso(prev_row["c"]) if prev_row else None, "compareChains": common, "assets": {}}
    for a in assets:
        z = {"debtUsd": [0.0] * len(D.BANDS)}
        p, c = pm.get(a, z), mc.get(a, z)
        res["assets"][a] = {"debtUsd": [round(x) for x in m[a]["debtUsd"]], "n": m[a]["n"],
                            "deltaUsd": [round(x - y) for x, y in zip(c["debtUsd"], p["debtUsd"])] if prev_row
                            else None}
    res["totalUsd"] = [round(sum(m[a]["debtUsd"][i] for a in m)) for i in range(len(D.BANDS))]
    og = cur.get("oracleGap") or {}
    if og.get("status") == "ok":
        res["oracleGap"] = {k: {"gapPct": v.get("gap_pct"), "oracle": v.get("oracle_gated"), "spot": v.get("spot")}
                            for k, v in og.get("assets", {}).items()}
        res["oracleGapAt"] = og.get("t")
    return res


def band_debt(lm, asset, band):
    a = lm["assets"].get(asset)
    return (a["debtUsd"][band], a["n"][band]) if a and band is not None else (None, None)


# =====================================================================================================================
# volatility (trailing, measured)
# =====================================================================================================================
def daily_closes(sym, days=VOL_DAYS, http_get=None):
    get = http_get or (lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": D.UA}),
                                                         timeout=30).read())
    url = f"{D.BINANCE_API}?symbol={sym}&interval=1d&limit={days + 1}"
    data = json.loads(get(url))
    now_ms = int(time.time() * 1000)
    return [float(k[4]) for k in data if int(k[6]) < now_ms]      # closed days only


def daily_bars(sym, start_ms, http_get=None):
    """Closed Binance 1 d bars from start_ms -> [(open_ms, close, low)]."""
    get = http_get or (lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": D.UA}),
                                                         timeout=30).read())
    out, t, now_ms = [], start_ms, int(time.time() * 1000)
    while True:
        data = json.loads(get(f"{D.BINANCE_API}?symbol={sym}&interval=1d&startTime={t}&limit=1000"))
        out += [(int(k[0]), float(k[4]), float(k[3])) for k in data if int(k[6]) < now_ms]
        if len(data) < 1000:
            return out
        t = int(data[-1][0]) + DAY_S * 1000


def history_breaches(bars, d, windows=(1, 7, 30), worst=3):
    """Measured history: for each window w (days), the windows whose low fell >= d below the close before it.
    Counts non-overlapping-start windows (every day starts one). Not a probability."""
    res = {}
    for w in windows:
        n = hits = 0
        drops = []
        for i in range(len(bars) - w):
            c0 = bars[i][1]
            lo = min(b[2] for b in bars[i + 1:i + 1 + w])
            dd = 1 - lo / c0
            n += 1
            hits += dd >= d
            drops.append((dd, bars[i + 1][0]))
        drops.sort(reverse=True)
        top, seen = [], []
        for dd, t in drops:                              # worst distinct episodes (starts > w days apart)
            if all(abs(t - u) > w * DAY_S * 1000 for u in seen):
                top.append({"drop": round(dd, 4), "start": time.strftime("%Y-%m-%d", time.gmtime(t / 1000))})
                seen.append(t)
            if len(top) == worst:
                break
        res[f"{w}d"] = {"windows": n, "breaches": hits, "worst": top}
    return res


def ewma_daily_vol(closes, lam=EWMA_LAMBDA):
    r = [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]
    if len(r) < 20:
        return None
    var = sum(x * x for x in r[:20]) / 20
    for x in r[20:]:
        var = lam * var + (1 - lam) * x * x
    return math.sqrt(var)


# =====================================================================================================================
# position X-ray
# =====================================================================================================================
def xray_metrics(market, det, lm=None, vol=None):
    """Pure part of the X-ray: market + detail -> metrics dict (no I/O)."""
    pm = D.position_metrics(market, det)
    hf = pm["hf"]
    k = pm["kstar"]
    # Joint-price distance: the common drop of every non-stable price that brings HF to 1. Only a line below 100 %
    # is a price line; k* >= 1 in size means the position is (nearly) hedged against a common move.
    dj = -k if k is not None and 0 < -k < 1 else (0.0 if k is not None and k >= 0 else None)
    dc = (1 - 1 / hf) if 0 < hf < math.inf else None            # collateral-only drop, debt fixed
    vol_debt = any(draw and not D.is_stable(market["reserves"][a]["symbol"]) for a, (_, draw) in det["bal"].items())
    if vol_debt and pm["asset"] != "stable-only":
        risk = "pair"
    elif dj is not None:
        risk = "price"
    else:
        risk = "stable"         # stable-only, or stable collateral alone covers the debt: no price line
    d = dj if risk == "price" else dc
    out = {"healthFactor": None if math.isinf(hf) else round(hf, 4), "debtUsd": round(pm["debt_usd"], 2),
           "mainCollateral": pm["asset"], "riskType": risk,
           "distance": None if d is None else round(d, 5),
           "distanceJointPrice": None if dj is None else round(dj, 5),
           "distanceCollateralOnly": None if dc is None else round(dc, 5)}
    sym = pm["asset"]
    px = next((r["price"] / 1e8 for r in market["reserves"].values() if r["symbol"] == sym and r["price"]), None)
    if risk == "price" and d is not None and px:
        out["oraclePrice"] = round(px, 6)
        out["liquidationPrice"] = round(px * (1 - d), 6)
    band = D.band_of(d) if d is not None and 0 < d <= D.X_BAND else None
    out["band"] = D.BAND_NAMES[band] if band is not None else ("over 10%" if d and d > D.X_BAND else None)
    if lm and band is not None and risk == "price":            # the D14 map holds price-risk positions only
        bd, bn = band_debt(lm, sym, band)
        out["sameBand"] = {"debtUsd": bd, "positions": bn, "asOf": lm["asOf"]}
    if vol and d and risk == "price":
        out["dailyVol"] = round(vol, 5)
        out["distanceInDailySigma"] = round(math.log(1 / (1 - d)) / vol, 2)
    notes = ["measured state; sigma = trailing EWMA of daily log returns, not a probability"]
    if risk == "price":
        notes.append("distance: every non-stable price falls together, stables fixed (k*)")
    elif risk == "pair":
        notes.append("distance: collateral falls against the debt asset (ratio move); check the reserve's oracle type")
    else:
        notes.append("distance: collateral falls against the debt (depeg); stables are not price-banded")
    out["notes"] = notes
    return out


ARCHIVE_CALL = {"ethereum": ["https://mainnet.gateway.tenderly.co"]}   # keyless endpoint that serves past-block eth_call
YIELD_WINDOW_D = 30


def carry_metrics(market, det, old_price, supply_apr, borrow_apr, window_d=YIELD_WINDOW_D, base="WETH"):
    """HF log-drift at today's rates: collateral growth (oracle-ratio growth vs `base` over window_d + supply APR)
    minus debt growth (borrow APR + the debt asset's own ratio growth). Measured rates held constant; a scenario
    arithmetic, not a forecast. -> {"carryGapPerYear": debt growth - collateral growth, "daysToHf1AtCurrentRates"}"""
    R = market["reserves"]
    b = next((a for a, r in R.items() if r["symbol"] == base), None)

    def ry(a):
        if b is None or D.is_stable(R[a]["symbol"]) or not old_price.get(a) or not old_price.get(b):
            return 0.0
        return math.log((R[a]["price"] / R[b]["price"]) / (old_price[a] / old_price[b])) * 365 / window_d
    cv = dv = cy = dy = 0.0
    for a, (c, d) in det["bal"].items():
        r = R[a]
        if not r["price"]:
            continue
        px = r["price"] / 1e8 / 10 ** int(r["dec"])
        if c:
            cv += c * px
            cy += c * px * (ry(a) + supply_apr.get(a, 0.0))
        if d:
            dv += d * px
            dy += d * px * (borrow_apr.get(a, 0.0) + ry(a))
    if not (cv and dv):
        return {}
    gap = dy / dv - cy / cv
    hf = D.position_metrics(market, det)["hf"]
    days = math.log(hf) / gap * 365 if gap > 0 and 1 < hf < math.inf else None
    return {"carryGapPerYear": round(gap, 5), "daysToHf1AtCurrentRates": None if days is None else round(days, 1),
            "carryNote": f"collateral: {window_d}d oracle-ratio growth vs {base} + supply APR; debt: borrow APR; "
                         "today's rates held constant (scenario arithmetic, not a forecast)"}


def read_carry_inputs(rpc, cfg, chain, market, block, window_d=YIELD_WINDOW_D):
    assets = market["assets"]
    rr = rpc.aggregate3([(cfg["pool"], D.sel("getReserveData") + D.enc_addr(a)) for a in assets], block)
    sup = {a: D.word(x, 2) / 1e27 for a, (ok, x) in zip(assets, rr) if ok}
    bor = {a: D.word(x, 4) / 1e27 for a, (ok, x) in zip(assets, rr) if ok}
    old_block = block - int(window_d * DAY_S / 12)
    data = D.aggregate3_data([(market["oracle"], D.sel("getAssetPrice") + D.enc_addr(a)) for a in assets])
    raw = rpc.call("eth_call", [{"to": D.MULTICALL3, "data": data}, hex(old_block)], urls=ARCHIVE_CALL[chain])
    old = {a: D.word(x) for a, (ok, x) in zip(assets, D.aggregate3_decode(raw)) if ok}
    return old, sup, bor


def xray(chain, address, lm=None, rpc=None, http_get=None):
    cfg = D.CHAINS[chain]
    rpc = rpc or D.Rpc(chain, cfg, deadline=time.time() + 300)
    block = rpc.head() - cfg["confirm"]
    market = D.read_market(rpc, cfg, block)
    det = D.read_details(rpc, market, cfg["pool"], [address.lower()], block).get(address.lower())
    if det is None:
        raise ValueError("account read failed")
    pm = D.position_metrics(market, det)
    vol = None
    sym = D.III_SYMBOL.get(pm["asset"])
    if sym:
        try:
            vol = ewma_daily_vol(daily_closes(sym, http_get=http_get))
        except Exception:
            vol = None
    out = xray_metrics(market, det, lm, vol)
    if out["riskType"] == "price" and sym and out["distance"]:
        try:
            bars = daily_bars(sym, int(time.mktime((2019, 1, 1, 0, 0, 0, 0, 0, 0))) * 1000, http_get=http_get)
            out["history"] = {"source": f"Binance {sym} 1d, since {time.strftime('%Y-%m-%d', time.gmtime(bars[0][0] / 1000))}",
                              "note": "past windows whose low fell at least this far; history, not a probability",
                              **history_breaches(bars, out["distance"])}
        except Exception:
            out["history"] = None
    if out["riskType"] == "pair" and chain in ARCHIVE_CALL:
        try:
            out.update(carry_metrics(market, det, *read_carry_inputs(rpc, cfg, chain, market, block)))
        except Exception:
            out["carryGapPerYear"] = None
    out.update({"chain": chain, "block": block, "readAt": D.iso(int(time.time())), "source": SOURCE,
                "volSource": f"Binance {sym} 1d closes, {VOL_DAYS}d, EWMA {EWMA_LAMBDA}" if vol else None})
    return out


def classify(market, det):
    """-> (riskType, distance, mainCollateral, debtUsd) with the same rules as xray_metrics."""
    x = xray_metrics(market, det)
    return x["riskType"], x["distance"], x["mainCollateral"], x["debtUsd"]


def layered_map(market, dets, carry=None):
    """Full liquidation map over all three layers from detail reads (no address kept):
    {layer: {asset: {"debtUsd": [5], "n": [5]}}}, plus carry buckets of pair debt when carry inputs are given."""
    out = {"price": {}, "pair": {}, "stable": {}}
    cb = {"hfRises": 0.0, "le30d": 0.0, "30to90d": 0.0, "90to365d": 0.0, "gt1y": 0.0, "unknown": 0.0}
    for det in dets:
        risk, d, asset, debt = classify(market, det)
        b = D.band_of(d) if d is not None and 0 < d <= D.X_BAND else None
        if b is None:
            continue
        t = out[risk].setdefault(asset, {"debtUsd": [0.0] * len(D.BANDS), "n": [0] * len(D.BANDS)})
        t["debtUsd"][b] += debt
        t["n"][b] += 1
        if risk == "pair" and carry:
            c = carry_metrics(market, det, *carry)
            g, days = c.get("carryGapPerYear"), c.get("daysToHf1AtCurrentRates")
            k = ("unknown" if g is None else "hfRises" if g <= 0 else "le30d" if days is not None and days <= 30
                 else "30to90d" if days is not None and days <= 90 else "90to365d" if days is not None and days <= 365
                 else "gt1y")
            cb[k] += debt
    for layer in out.values():
        for v in layer.values():
            v["debtUsd"] = [round(x) for x in v["debtUsd"]]
    res = {"layers": out, "totalUsd": {k: round(sum(sum(v["debtUsd"]) for v in L.values())) for k, L in out.items()}}
    if carry:
        res["pairCarryUsd"] = {k: round(v) for k, v in cb.items()}
    return res


def scan_chain(root, chain, deadline_s=850, rpc=None):
    """Live full scan of one chain's D14 borrower list (datasets root) -> layered map, aggregates only."""
    cfg = D.CHAINS[chain]
    rpc = rpc or D.Rpc(chain, cfg, deadline=time.time() + deadline_s)
    addrs = list(dict.fromkeys(a.lower() for a in D.load_addresses(root, chain)))
    block = (rpc.head() - cfg["confirm"])
    market = D.read_market(rpc, cfg, block)
    acc = D.scan_accounts(rpc, cfg["pool"], addrs, block)
    near = [a for a, x in zip(addrs, acc) if x and x[1] >= D.MIN_DEBT_USD * 1e8 and x[3] < 1e18 / (1 - D.X_BAND)]
    dets = list(D.read_details(rpc, market, cfg["pool"], near, block).values())
    carry = None
    if chain in ARCHIVE_CALL:
        try:
            carry = read_carry_inputs(rpc, cfg, chain, market, block)
        except Exception:
            carry = None
    res = layered_map(market, dets, carry)
    res.update({"schema": "q26-terminal/layered/1", "chain": chain, "block": block, "readAt": D.iso(int(time.time())),
                "borrowers": len(addrs), "read": sum(1 for x in acc if x), "near": len(near), "detailed": len(dets),
                "kind": "measured", "source": SOURCE})
    return res


# =====================================================================================================================
# oracle transparency
# =====================================================================================================================
OSEL = {"getSourceOfAsset": "92bf2be0", "description": "7284e416", "latestRoundData": "feaf968c"}


def _abi_string(raw):
    try:
        n = D.word(raw, 1)
        return raw[64:64 + n].decode(errors="ignore") or None
    except Exception:
        return None


def feed_kind(desc):
    if not desc:
        return "unknown"
    d = desc.lower()
    if d.startswith("capped") and "/" in d:
        return "exchange-rate (capped)" if d.count("/") >= 2 or "(" in d else "capped peg"
    return "market feed"


def oracle_rows(market, sources, descs, rounds, spot, now):
    """Pure: per reserve -> feed description, kind, oracle price, Binance spot gap, seconds since feed update."""
    rows = []
    for a, r in market["reserves"].items():
        px = r["price"] / 1e8 if r["price"] else None
        sym = D.III_SYMBOL.get(r["symbol"])
        sp = spot.get(sym) if sym else None
        upd = rounds.get(a)
        rows.append({"symbol": r["symbol"], "feed": descs.get(a), "kind": feed_kind(descs.get(a)), "oracleUsd": px,
                     "spotUsd": sp, "gapPct": round(px / sp - 1, 5) if px and sp else None,
                     "ageS": now - upd if upd else None})
    return sorted(rows, key=lambda x: x["symbol"].lower())


def oracle_table(chain, rpc=None, http_get=None):
    cfg = D.CHAINS[chain]
    rpc = rpc or D.Rpc(chain, cfg, deadline=time.time() + 300)
    block = rpc.head() - cfg["confirm"]
    market = D.read_market(rpc, cfg, block)
    assets = market["assets"]
    sel = lambda n: bytes.fromhex(OSEL[n])  # noqa: E731
    src = rpc.aggregate3([(market["oracle"], sel("getSourceOfAsset") + D.enc_addr(a)) for a in assets], block)
    sources = {a: D.as_addr(D.word(x)) for a, (ok, x) in zip(assets, src) if ok}
    calls = []
    for a in assets:
        calls += [(sources.get(a, D.MULTICALL3), sel("description")), (sources.get(a, D.MULTICALL3), sel("latestRoundData"))]
    res = rpc.aggregate3(calls, block)
    descs, rounds = {}, {}
    for j, a in enumerate(assets):
        okd, bd = res[2 * j]
        okr, br = res[2 * j + 1]
        descs[a] = _abi_string(bd) if okd else None
        rounds[a] = D.word(br, 3) if okr and br and len(br) >= 160 else None
    get = http_get or (lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": D.UA}),
                                                         timeout=30).read())
    spot = {}
    for sym in sorted({D.III_SYMBOL[r["symbol"]] for r in market["reserves"].values() if r["symbol"] in D.III_SYMBOL}):
        try:
            spot[sym] = float(json.loads(get(f"https://data-api.binance.vision/api/v3/ticker/price?symbol={sym}"))["price"])
        except Exception:
            pass
    now = int(time.time())
    return {"schema": "q26-terminal/oracles/1", "chain": chain, "block": block, "readAt": D.iso(now), "kind": "measured",
            "rows": oracle_rows(market, sources, descs, rounds, spot, now),
            "notes": ["gapPct = Aave oracle / Binance spot - 1 at read time", "ageS = seconds since the feed's last round "
                      "(adapters without latestRoundData show null)"]}


# =====================================================================================================================
# exit capacity
# =====================================================================================================================
def exit_rows(market, supplied, available, sup_apr, bor_apr):
    """Pure: per reserve -> supplied and withdrawable now (USD), utilization, supply/borrow APR."""
    rows = []
    for a, r in market["reserves"].items():
        if not r["price"] or a not in supplied:
            continue
        unit = r["price"] / 1e8 / 10 ** int(r["dec"])
        s_, av = supplied[a] * unit, available.get(a, 0) * unit
        rows.append({"symbol": r["symbol"], "suppliedUsd": round(s_), "withdrawableUsd": round(min(av, s_)),
                     "utilization": round(1 - av / s_, 4) if s_ else None,
                     "supplyApr": round(sup_apr.get(a, 0.0), 5), "borrowApr": round(bor_apr.get(a, 0.0), 5)})
    return sorted(rows, key=lambda x: -x["suppliedUsd"])


def exit_table(chain, rpc=None):
    cfg = D.CHAINS[chain]
    rpc = rpc or D.Rpc(chain, cfg, deadline=time.time() + 300)
    block = rpc.head() - cfg["confirm"]
    market = D.read_market(rpc, cfg, block)
    R, assets = market["reserves"], market["assets"]
    calls = []
    for a in assets:
        calls += [(R[a]["aToken"], bytes.fromhex("18160ddd")), (a, D.sel("balanceOf") + D.enc_addr(R[a]["aToken"])),
                  (cfg["pool"], D.sel("getReserveData") + D.enc_addr(a))]
    res = rpc.aggregate3(calls, block)
    sup, av, sa, ba = {}, {}, {}, {}
    for j, a in enumerate(assets):
        (o1, b1), (o2, b2), (o3, b3) = res[3 * j:3 * j + 3]
        if o1 and o2:
            sup[a], av[a] = D.word(b1), D.word(b2)
        if o3:
            sa[a], ba[a] = D.word(b3, 2) / 1e27, D.word(b3, 4) / 1e27
    return {"schema": "q26-terminal/exit/1", "chain": chain, "block": block, "readAt": D.iso(int(time.time())),
            "kind": "measured", "rows": exit_rows(market, sup, av, sa, ba),
            "notes": ["withdrawable = underlying held by the aToken now; a supplier larger than it waits for repayments "
                      "or liquidations"]}


# =====================================================================================================================
# rate headroom (Aave V3 DefaultReserveInterestRateStrategyV2)
# =====================================================================================================================
def borrow_rate(u, opt, base, s1, s2):
    return base + s1 * min(u, opt) / opt + (s2 * (u - opt) / (1 - opt) if u > opt else 0.0)


def util_for_rate(target, opt, base, s1, s2):
    """Smallest utilization whose borrow rate reaches target (None if never)."""
    if target <= base:
        return 0.0
    if target <= base + s1:
        return opt * (target - base) / s1
    if s2 <= 0:
        return None
    u = opt + (target - base - s1) * (1 - opt) / s2
    return u if u <= 1 else None


def rate_headroom(debt, rate_now, params, target):
    """Pure. debt in asset units; rate_now the live variable borrow rate; params (opt, base, s1, s2) as fractions;
    target the borrow rate to reach. Utilization now is implied from the rate (Aave uses virtual balances).
    -> utilization now / at target, and the withdrawals or new borrows (asset units) that move it there."""
    opt, base, s1, s2 = params
    u_now = util_for_rate(rate_now, *params)
    u_t = util_for_rate(target, *params)
    if not u_now or u_t is None:
        return {"utilNow": u_now, "utilAtTarget": u_t}
    total = debt / u_now
    return {"utilNow": round(u_now, 5), "utilAtTarget": round(u_t, 5),
            "withdrawalsToTarget": round(max(0.0, total - debt / u_t), 2) if u_t > 0 else None,
            "newBorrowsToTarget": round(max(0.0, u_t * total - debt), 2),
            "rateAt95": round(borrow_rate(0.95, *params), 5)}


def read_rate_params(rpc, cfg, market, block, asset):
    rd = rpc.aggregate3([(cfg["pool"], D.sel("getReserveData") + D.enc_addr(asset))], block)[0][1]
    strat, rate = D.as_addr(D.word(rd, 11)), D.word(rd, 4) / 1e27
    r = rpc.aggregate3([(strat, bytes.fromhex("131e889c") + D.enc_addr(asset)),       # getInterestRateData(address)
                        (market["reserves"][asset]["vDebt"], bytes.fromhex("18160ddd"))], block)
    if not r[0][0]:
        return None
    opt, base, s1, s2 = (D.word(r[0][1], i) / 1e27 for i in range(4))
    return {"params": (opt, base, s1, s2), "rate": rate, "debt": D.word(r[1][1]) / 10 ** int(market["reserves"][asset]["dec"])}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("liqmap")
    a.add_argument("hourly_dir")
    a.add_argument("--arm", default="oracle")
    a.add_argument("--top", type=int, default=8)
    c = sub.add_parser("layers")
    c.add_argument("datasets_root")
    c.add_argument("chain", choices=sorted(D.CHAINS))
    o = sub.add_parser("oracles")
    o.add_argument("chain", choices=sorted(D.CHAINS))
    e = sub.add_parser("exit")
    e.add_argument("chain", choices=sorted(D.CHAINS))
    b = sub.add_parser("xray")
    b.add_argument("chain", choices=sorted(D.CHAINS))
    b.add_argument("address")
    b.add_argument("--hourly-dir")
    args = ap.parse_args(argv)
    if args.cmd == "liqmap":
        print(json.dumps(liqmap(load_rows(args.hourly_dir), args.arm, args.top), indent=1))
    elif args.cmd == "oracles":
        print(json.dumps(oracle_table(args.chain), indent=1))
    elif args.cmd == "exit":
        print(json.dumps(exit_table(args.chain), indent=1))
    elif args.cmd == "layers":
        print(json.dumps(scan_chain(args.datasets_root, args.chain), indent=1))
    else:
        lm = liqmap(load_rows(args.hourly_dir)) if args.hourly_dir else None
        print(json.dumps(xray(args.chain, args.address, lm), indent=1))


if __name__ == "__main__":
    main()
