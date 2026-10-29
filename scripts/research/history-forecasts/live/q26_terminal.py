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
    out.update({"chain": chain, "block": block, "readAt": D.iso(int(time.time())), "source": SOURCE,
                "volSource": f"Binance {sym} 1d closes, {VOL_DAYS}d, EWMA {EWMA_LAMBDA}" if vol else None})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("liqmap")
    a.add_argument("hourly_dir")
    a.add_argument("--arm", default="oracle")
    a.add_argument("--top", type=int, default=8)
    b = sub.add_parser("xray")
    b.add_argument("chain", choices=sorted(D.CHAINS))
    b.add_argument("address")
    b.add_argument("--hourly-dir")
    args = ap.parse_args(argv)
    if args.cmd == "liqmap":
        print(json.dumps(liqmap(load_rows(args.hourly_dir), args.arm, args.top), indent=1))
    else:
        lm = liqmap(load_rows(args.hourly_dir)) if args.hourly_dir else None
        print(json.dumps(xray(args.chain, args.address, lm), indent=1))


if __name__ == "__main__":
    main()
