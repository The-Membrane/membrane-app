"""Write membrane-datasets pair-loop/PROVENANCE.md with sha256 of every file (Q26-PL)."""
import hashlib, os, sys, datetime as dt, json
d = sys.argv[1]
rows = []
for f in sorted(os.listdir(d)):
    if f == "PROVENANCE.md": continue
    p = os.path.join(d, f); h = hashlib.sha256(open(p, "rb").read()).hexdigest(); rows.append((f, os.path.getsize(p), h))
hourly = os.path.join(d, "hourly.jsonl.gz"); n = err = 0; t0 = t1 = None
import gzip
if os.path.exists(hourly):
    for l in gzip.open(hourly, "rt"):
        r = json.loads(l); n += 1; err += "err" in r; t0 = r["t"] if t0 is None else min(t0, r["t"]); t1 = r["t"] if t1 is None else max(t1, r["t"])
iso = lambda t: dt.datetime.fromtimestamp(t, dt.UTC).strftime("%Y-%m-%dT%H:%MZ") if t else "-"
txt = f"""# pair-loop — provenance

- **Source:** keyless archive `eth_call` (Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` `aggregate3`) on `https://eth.drpc.org` and
  `https://rpc.mevblocker.io`; Aave V3 Ethereum Pool `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`, AaveOracle `0x54586bE62E3c3580375aE3723C145253060Ca0C2`,
  each reserve's interest-rate strategy, aToken and variableDebtToken. No key, no paid data.
- **Builder:** `The-Membrane/membrane-app` branch `research/pair-loop`, `scripts/research/history-forecasts/pair_loop/acquire_hourly.py`
  (hourly: `getReserveData` for WETH, WBTC, wstETH, weETH, rsETH, osETH, cbETH, rETH, ETHx, LBTC, cbBTC, eBTC, tBTC and `getAssetPrice` for each, plus
  Multicall3 `getCurrentBlockTimestamp`) and `acquire_strategy_daily.py` (daily: strategy address and curve parameters, aToken/variableDebt totals, for WETH and WBTC).
- **Registration:** `membrane-board design/Q26_PAIR_LOOP_PREREG.md` (board commit 01a8466, 2026-11-04). The acquisition started after that commit.
  The builder computes no label, outcome or score.
- **Hourly grid:** every UTC hour from 2023-01-27 00:00Z; block = the `venue-stress/history.json` block where that archive has the hour, else linear
  interpolation between `depositor-balances/blocks.csv` daily anchors (12 s slots); the actual block timestamp is stored per row (`ts`, `dt` = ts − t).
- **Rows:** {n} hourly ({iso(t0)} → {iso(t1)}), {err} error rows (retried on resume; remaining errors are listed inside the file).
- **Units:** indexes and rates are ray (÷ 1e27; rates × 100 = APR %); oracle prices are the AaveOracle base-currency units (USD × 1e8).
- **Imported:** {dt.datetime.now(dt.UTC).strftime("%Y-%m-%d")}. **Status:** canonical, frozen for the Q26-PL score. The forward log (PL.4) appends after the registered score.

| file | bytes | sha256 |
|---|---:|---|
""" + "\n".join(f"| `{f}` | {s} | `{h}` |" for f, s, h in rows) + "\n"
open(os.path.join(d, "PROVENANCE.md"), "w").write(txt); print(txt[:400])
