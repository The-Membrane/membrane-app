# Position-alert back-test inputs

Built by `node scripts/research/build-position-alert-data.mjs` (keyless public sources; never
reads `.env.local`). **Do not hand-edit.** Regenerate, and the manifest records each file's
SHA-256. Consumed by `scripts/research/position-alert-backtest.ts`, which writes
`backtest-results.json` next to them. The memo is `docs/research/POSITION-ALERTS-BACKTEST.md`.

| File | Window | Contents | Source |
|---|---|---|---|
| `hourly-eth-btc.json` | 2020-01-01 → 2026-10-07 | ETH and BTC hourly close/low/high vs USDT, 59,304 bars, 32 null bars (exchange outages, never filled) | Binance spot klines via `data-api.binance.vision` |
| `e2-nov-2025.json` | Nov 2025 | ETH/BTC 1m close/low; deUSD hourly; 992 Morpho liquidations; 146 liquidated WBTC/cbBTC/wstETH positions with hourly collateral + borrow (7 days before) | Binance; DefiLlama `coingecko:elixir-deusd`; Morpho Blue API |
| `e3-apr-2026.json` | Apr 10 → 26 2026 | ETH 1m; rsETH and ETH hourly (same source, for the ratio); Aave V3 USDe cash = `USDe.balanceOf(aEthUSDe)` every 75 blocks (~15 min); 30 Morpho liquidations | Binance; DefiLlama; archive `eth_call`; Morpho API |
| `e4-aug-2026.json` | Aug 11 → 27 2026 | Morpho oracle `0x217d…51f0` `price()` (PT-reUSD-10DEC2026, USD per PT) every 300 blocks, and every 5 blocks Aug 25 01:00–07:00 UTC; 35 PT-reUSD liquidations; 22 liquidated positions with hourly collateral + borrow (14 days before) | archive `eth_call`; Morpho API |
| `depeg-history.json` | 2021-06 / 2023-01 / 2024-03 → 2026-10 | stETH/ETH ratio, USDC, USDe, ~hourly | DefiLlama `coingecko:*` |

E1 (Oct 10 2025) is `public/data/oct10-2025/`, committed with its own provenance.

**These files do not reproduce the Recall Coverage Dataset spec's events exactly** (spec §5;
memo §1). `e2-nov-2025.json` is November 2025 Morpho BTC/ETH-collateral liquidations plus deUSD.
Its `label` field says "Stream xUSD / Elixir deUSD collapse", but no xUSD-collateral position is
in it. The spec's E2 is the xUSD freeze, Nov 2–12. `e3-apr-2026.json` has Aave **USDe** cash. The
spec's E3 venue is Aave Core **USDC**. The spec's block-pinned tables live on membrane-solidity
branch `claude/laughing-pasteur-lzifki` under `research/recall-dataset/data/chain/`.

**Per-wallet rows.** `e2-nov-2025.json` and `e4-aug-2026.json` hold Morpho borrower addresses
(public on-chain data). Spec gate G2 says per-wallet rows are internal only. Whether that covers
committed research inputs is an open owner decision (memo §1). Do not surface them.

## Caveats that change conclusions

1. **Spot is not the oracle.** E2 and the hourly history price positions on Binance spot. A
   lending venue liquidates on its oracle (Chainlink), which lags spot by seconds to minutes and
   skips sub-deviation moves. Spot lows therefore liquidate a little *earlier* than the venue
   would, and a spot-driven monitor warns a little earlier than an oracle-driven one. E1 and E4
   use the venue oracle itself.
2. **USDT quote.** Binance prices are vs USDT, treated as USD.
3. **DefiLlama depeg series are aggregated market prices**, not any venue's oracle, roughly
   hourly with irregular timestamps. An exchange-rate-priced LST (Aave wstETH, CAPO feeds) never
   sees these moves; that is the point of the depeg rule's oracle-basis wording.
4. **rsETH has no redemption-rate read here.** The back-test uses the median rsETH/ETH ratio over
   Apr 10 → 17 2026 (pre-incident) as the rate proxy.
5. **Morpho position history is hourly.** Balances are held at the last hourly point in force.
   A top-up or repay inside an hour is invisible until the next point.
6. **Archive reads rotate across keyless endpoints** (`manifest.archiveRpcsUsed`). A state read
   at a pinned block is deterministic, so the endpoint does not change the value.
