# Set-and-forget LTV: which start LTV survives being left alone

Owner ask (2026-10-04): "what LTV per asset will be profitable to set and forget with our recall mech". **This replay answers only the survival half: the start LTV at which collateral is never sold. It does not answer "profitable"** — see [Not answered: profitable](#not-answered-profitable). Generated 2026-10-06 by `scripts/position-sim/set-and-forget-sim.ts`; the venue analogs and the carry rows they move were re-run 2026-10-07 after a data review ([Method](#method)); data in `public/data/price-history/set-and-forget-ltv.json`. **Historical replay — not a forecast, not a probability.**

**Exit capacity is measured (owner instruction 2026-10-06).** Carry rows now assume what depositors could actually withdraw from Aave, Spark and Steakhouse during real stress, 2023-10 → 2026-10, starting with typical Aave USDC capacity. They no longer use the hand-picked ×0.5 / ×0.1 levels. See [Exit capacity](#exit-capacity-measured-venue-analogs). At measured capacity, recall adds only **2–5pp** of never-sold start LTV over a levered long (ETH 2.0–3.3pp). The retired ×0.5 level added 15–26pp on ETH.

## Headline

The table gives the start LTV (%) at which a position opened in a historical hour and left untouched has collateral sold in **none / ≤1% / ≤5%** of start hours.

- **Class:** delayed (4% band, 8h window).
- **"cap":** no sale even at the borrow cap (line − 3pp).
- **Size:** $100k of collateral, so **the carry rows are for large positions**. Under about $2,250 of debt, the debt floor turns the first recall into a whole-loan close and a collateral sale ([Copy claims](#copy-claims-measured-per-position-size)).
- **Carry:** the whole debt is deployed in Aave USDC, and a recall gets the share of it that Aave USDC let depositors withdraw in a real stress event.

| Asset · line | Shape | 30d | 90d | 365d |
|---|---|---|---|---|
| ETH · 80% | levered long | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| | carry, Aave USDC worst (Kelp, <0.01%, 45 h lock) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| | carry, Aave USDC bad (×0.0391) | 27.2 / 35.2 / 51.2 | 21.6 / 25.3 / 37.7 | 15.9 / 17.6 / 22.2 |
| | carry, Aave USDC typical (×0.1119) | 29.4 / 38.1 / 55.4 | 23.4 / 27.4 / 40.8 | 17.2 / 19.1 / 24.1 |
| BTC · 75% | levered long | 30.6 / 37.2 / 52.2 | 28.6 / 32.2 / 38.4 | 17.6 / 20.9 / 26.6 |
| | carry, Aave USDC worst | 30.6 / 37.2 / 52.2 | 28.6 / 32.2 / 38.4 | 17.6 / 20.9 / 26.6 |
| | carry, Aave USDC bad | 31.8 / 38.7 / 54.3 | 29.8 / 33.5 / 40.0 | 18.3 / 21.8 / 27.7 |
| | carry, Aave USDC typical | 34.5 / 41.9 / 58.8 | 32.3 / 36.2 / 43.3 | 19.8 / 23.6 / 30.0 |
| wstETH · 78% | levered long | 32.8 / 39.7 / 48.7 | 20.4 / 23.5 / 36.4 | 15.2 / 16.5 / 19.7 |
| | carry, Aave USDC worst | 32.8 / 39.7 / 48.7 | 20.4 / 23.5 / 36.4 | 15.2 / 16.5 / 19.7 |
| | carry, Aave USDC bad | 34.2 / 41.3 / 50.7 | 21.3 / 24.4 / 37.9 | 15.9 / 17.2 / 20.5 |
| | carry, Aave USDC typical | 37.0 / 44.7 / 54.8 | 23.0 / 26.4 / 41.0 | 17.2 / 18.7 / 22.2 |
| weETH · 75%† | levered long | 40.4 / 43.9 / 50.5 | 29.4 / 33.1 / 39.4 | 24.2 / 25.8 / 27.4 |
| | carry, Aave USDC worst | 40.4 / 43.9 / 50.5 | 29.4 / 33.1 / 39.4 | 24.2 / 25.8 / 27.4 |
| | carry, Aave USDC bad | 42.0 / 45.7 / 52.6 | 30.6 / 34.4 / 41.0 | 25.2 / 26.8 / 28.5 |
| | carry, Aave USDC typical | 45.5 / 49.5 / 56.9 | 33.1 / 37.3 / 44.4 | 27.3 / 29.0 / 30.9 |

The carry levels are Aave USDC's own stress events, 33 of them with onsets from 2024-01 to 2026-10:
- **Typical** (the median): ETH −13.3% on 2026-06-05. 11.19% of deposits were withdrawable across the 8 h window.
- **Bad** (the 10th percentile): the Oct-2025 liquidation cascade, at 3.91%.
- **Worst:** Kelp, April 2026. Under 0.01% was withdrawable, locked for 45 h, and the market only recovered to 5% after 148 h.

Two bounds stay alongside the measured levels:
- **Carry ×1** ("optimistic") is an **upper bound, never a default**: it is "cap" in every cell.
- **Carry ×0** ("frozen") equals levered long in all 24 cells, and so does Aave USDC worst.

† weETH is **not** wstETH: it is ether.fi's wrapped eETH, a liquid *restaking* token (ETH staked through ether.fi and restaked on EigenLayer), where wstETH is Lido's wrapped staked ETH. It is in the table only because the sim carries a modelled 75% line for it (`MEMBRANE_ASSET_LTV`, lib/position-sim/membrane.ts:200); it is priced as ETH × its on-chain `getRate()`, and its data starts 2023-11-10 — no 2020–2022 crash, so its row is not comparable.

- **Levered long** (debt swapped back into the asset, nothing to recall): a year untouched on ETH was never sold only at **≤15.2% LTV** (≈1.18x looped); 21.4% was sold in 5% of start hours.
- **At measured venue capacity, carry is close to levered long.** On ETH, typical Aave USDC stress capacity lifts the never-sold LTV by 3.3 / 2.6 / 2.0pp (30 / 90 / 365 days); bad stress by 1.1 / 0.8 / 0.7pp; the Kelp lock by nothing. The retired ×0.5 level read 52.2 / 41.6 / 30.5%, overstating what recall adds roughly eightfold. With ×1 the result is "cap" everywhere, but recall fired in 70–93% of start hours at the cap.
- **Every recall drains the venue's whole share.** At HF 2 each recall drew the full 11.2% (typical) or 3.9% (bad) of the deployed debt ([Copy claims](#copy-claims-measured-per-position-size)). The stock never refills inside a window.

## Exit capacity: measured venue analogs

Owner instruction (2026-10-06): "the venue-capacity assumptions should directly analogize existing protocols (assuming typical Aave capacity during stress over the last 3 years)". The old named levels, ×0.5 "stressed" and ×0.1 "kelp-lock", were picked by hand and are gone. Every carry row now runs at a **measured analog**: the share of deposits a real venue let depositors withdraw during one real stress event, 2023-10 → 2026-10. The data and method are in `lib/position-sim/venueStressAnalogs.ts` (reading rules shared with the builder in `lib/position-sim/venueStressRules.ts`), the engine presets in `lib/position-sim/exitCapacityAnalogs.ts`, and the readings in `public/data/venue-stress/` (archive reads of each venue's cash and supply, every hour).

- **The quantity.** Withdrawable fraction f = cash / supply: Aave/Spark `underlying.balanceOf(aToken)` / `aToken.totalSupply()`; for the Steakhouse MetaMorpho vault, its pro-rata share of each market's idle cash (vault assets × idle / market supply) over `totalAssets()`, the same race one level down. The vault first in line in every market (MetaMorpho's own `maxWithdraw` walk) is kept as the `liquid` column. A paused reserve counts as f = 0; a frozen one still allows withdrawals.
- **Pro-rata assumption.** In stress every depositor exits at once, so a recall gets f × its deposit, whatever its size. This is conservative against being first in line (f × D ≤ the venue's cash). It is not a worst case: a recall that loses the race entirely gets nothing (the ×0 bound).
- **Per event.** f is the lowest reading over the first 8 h after the onset (the delay window). A one-reading dip that the next hourly reading clears does not set the minimum. A keeper retries within the window, and a recall that cures commits. The literal single-reading minimum is also reported: on Aave USDC a 00:00 UTC one-hour drain sets it for three of the five worst events. Windows whose onsets chain within 72 h form one event, counted once at its worst trigger.
- **Levels.** For each venue: **typical** = the median event, **bad** = the 10th-percentile event (nearest rank), **worst** = the worst observed. Each level is one real event, never a blend of events.
- **Onto the engine.** exit capacity = deployed × f. For a **locked** event (f ≤ 1%), the venue also returns nothing for the measured lock, counted from the first breach. The lock is the ≤ 1% stretch the 8 h window runs into (one that starts by onset + 8 h, measured to its end), so starting it at the breach is early by at most 8 h. The recovery after a lock is not modelled: the stock never refills. An unlocked event's ≤ 1% hours (a one-reading dip, or a lock that starts after the window) are not placed at the breach.
- **Bounds kept.** ×0 "frozen" (a paused reserve, or a recall that loses the race) and ×1 "optimistic". ×1 is labelled an **upper bound, never a default**: no stress event measured it.

| Venue | events · onsets | typical (median) | bad (p10) | worst observed |
|---|---|---|---|---|
| Aave USDC | 33 · 2024-01 → 2026-10 | 11.19% · ETH -13.3% 2026-06-05 | 3.91% · Oct-2025 liquidation cascade (2025-10-10) | <0.01% · Kelp Apr-2026 (2026-04-19), locked 45 h, ≥5% after 148 h |
| Aave USDT | 40 · 2023-12 → 2026-10 | 8.52% · Oct-2025 liquidation cascade (2025-10-10) | 2.83% · util ≥95% 2026-10-06 | <0.01% · Kelp Apr-2026 (2026-04-19), locked 135 h, ≥5% after 150 h |
| Aave USDe | 14 · 2025-09 → 2026-08 | 23.02% · Oct-2025 liquidation cascade (2025-10-10) | 0.01% · Kelp Apr-2026 (2026-04-19), locked 3 h, ≥5% after 12 h | 0.01% · util ≥95% 2026-05-06, locked 6 h, ≥5% after 6 h |
| Steakhouse USDC | 26 · 2024-11 → 2026-08 | 10.57% · PT-reUSD Aug-2026 (2026-08-22) | 3.34% · util ≥95% 2024-11-29 | 2.87% · util ≥95% 2024-11-19 |
| Spark USDC | 9 · 2025-04 → 2026-02 | 15.89% · ETH -10.4% 2025-12-01 | 3.65% · util ≥95% 2025-04-16 | 3.65% · util ≥95% 2025-04-16 |
| Spark USDT | 12 · 2025-10 → 2026-08 | 8.89% · ETH -10.4% 2025-12-01 | <0.01% · util ≥99% 2026-05-20, locked 5 h, ≥5% after 5 h | <0.01% · util ≥99% 2026-05-08, locked 6 h, ≥5% after 13 h |
| Spark DAI | 42 · 2023-11 → 2026-08 | 5.59% · ETH -29.3% 2025-02-02 | <0.01% · util ≥99% 2024-11-27, locked 10 h, ≥5% after 20 h | 0.05% · util ≥99% 2024-12-29, locked 17 h, ≥5% after 30 h |
| Spark USDS | 12 · 2025-06 → 2026-08 | 27.10% · ETH -13.4% 2025-11-21 | 25.39% · ETH -11.5% 2025-06-13 | 25.15% · Oct-2025 liquidation cascade (2025-10-10) |
| Aave WETH (ETH market) | 31 · 2024-01 → 2026-08 | 13.01% · Feb-2026 ETH drawdown (2026-01-31) | 4.62% · util ≥95% 2025-07-20 | <0.01% · Kelp Apr-2026 (2026-04-18), locked 259 h, ≥5% after 457 h |
| Spark WETH (ETH market) | 29 · 2024-01 → 2026-08 | 18.25% · Feb-2026 ETH drawdown (2026-01-31) | 10.52% · ETH -11.3% 2025-06-22 | 3.52% · Kelp Apr-2026 (2026-04-18) |

f is the share withdrawable across the first 8 h. Lock = the stretch at ≤ 1% the 8 h window runs into, to its end; "≥5% after" = hours from onset until f is back at 5%. Aave WETH and Spark WETH are ETH supply markets. They are listed for capital deployed as ETH; the sim leaves them out, because carry deploys CDT debt as a stable.

**Stress windows used (91).**
- 7 named windows: 2024-08-05 yen-carry unwind; Dec-2024 leverage peak; Apr-2025 tariff crash; 2025-10-10/11 liquidation cascade; Feb-2026 ETH drawdown; Apr-2026 Kelp rsETH / Aave cross-reserve freeze; Aug-2026 PT-reUSD.
- 30 ETH drops of 10% or more against the prior 24 h max close (`eth-usd-1h.json`), 2024-01-03 → 2026-06-05.
- 54 utilisation episodes at 95% or more on the venue itself (99% for Spark DAI and Spark USDT, whose normal operating point is above 95%): Aave USDT 14, Spark DAI 13, Aave USDC 7, Steakhouse 6, Aave USDe 5 (derived from its own series by the same rule), Aave WETH 4, Spark USDT 3, Spark USDC 1, Spark WETH 1.
- Not a trigger: a **transient**, one hourly reading at the stress level that the next hourly reading clears. 233 of them (`summary.json` `transients`), 181 being Aave USDC's 00:00 UTC drain: one supplier withdraws every idle dollar for ~40 minutes and re-supplies, debt unchanged. Counted as stress, one such reading a day had held Aave USDC "in stress" for months (2024-10-23 → 12-14 and 2026-05-08 → 10-07).

Named windows and ETH drops apply to every venue. A utilisation episode counts only for its own venue.

## Carry per venue (ETH, delayed class)

The same solve with the debt deployed at each stable venue's own analogs: never / ≤1% / ≤5% of start hours sold. Mult = the share withdrawable across the window; a lock is the hours with nothing withdrawable from the first breach.

| Venue · level | ×mult (lock) | 30d | 90d | 365d |
|---|---|---|---|---|
| Aave USDC · typical | ×0.1119 | 29.4 / 38.1 / 55.4 | 23.4 / 27.4 / 40.8 | 17.2 / 19.1 / 24.1 |
| Aave USDC · bad (p10) | ×0.0391 | 27.2 / 35.2 / 51.2 | 21.6 / 25.3 / 37.7 | 15.9 / 17.6 / 22.2 |
| Aave USDC · worst seen | ×0 (45 h) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| Aave USDT · typical | ×0.0852 | 28.5 / 37.0 / 53.8 | 22.7 / 26.6 / 39.6 | 16.7 / 18.5 / 23.4 |
| Aave USDT · bad (p10) | ×0.0283 | 26.9 / 34.8 / 50.6 | 21.4 / 25.1 / 37.3 | 15.7 / 17.4 / 22.0 |
| Aave USDT · worst seen | ×0 (135 h) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| Aave USDe · typical | ×0.2302 | 33.9 / 43.9 / 63.9 | 27.0 / 31.6 / 47.0 | 19.8 / 22.0 / 27.8 |
| Aave USDe · bad (p10) | ×0.0001 (3 h) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| Aave USDe · worst seen | ×0.0001 (6 h) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| Steakhouse USDC · typical | ×0.1057 | 29.2 / 37.8 / 55.0 | 23.2 / 27.2 / 40.5 | 17.0 / 18.9 / 23.9 |
| Steakhouse USDC · bad (p10) | ×0.0334 | 27.0 / 35.0 / 50.9 | 21.5 / 25.2 / 37.5 | 15.8 / 17.5 / 22.1 |
| Steakhouse USDC · worst seen | ×0.0287 | 26.9 / 34.8 / 50.6 | 21.4 / 25.1 / 37.3 | 15.7 / 17.4 / 22.0 |
| Spark USDC · typical | ×0.1589 | 31.0 / 40.2 / 58.5 | 24.7 / 28.9 / 43.1 | 18.1 / 20.1 / 25.4 |
| Spark USDC · bad = worst | ×0.0365 | 27.1 / 35.1 / 51.0 | 21.6 / 25.3 / 37.6 | 15.8 / 17.6 / 22.2 |
| Spark USDT · typical | ×0.0889 | 28.6 / 37.1 / 54.0 | 22.8 / 26.7 / 39.7 | 16.7 / 18.6 / 23.5 |
| Spark USDT · bad / worst | ×0 (5 h / 6 h) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| Spark DAI · typical | ×0.0559 | 27.6 / 35.8 / 52.1 | 22.0 / 25.8 / 38.4 | 16.1 / 17.9 / 22.6 |
| Spark DAI · bad (p10) | ×0 (10 h) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| Spark DAI · worst seen | ×0.0005 (17 h) | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| Spark USDS · typical | ×0.271 | 35.8 / 46.4 / 67.5 | 28.5 / 33.4 / 49.7 | 20.9 / 23.2 / 29.3 |
| Spark USDS · bad (p10) | ×0.2539 | 35.0 / 45.3 / 65.9 | 27.9 / 32.6 / 48.5 | 20.4 / 22.7 / 28.7 |
| Spark USDS · worst seen | ×0.2515 | 34.9 / 45.2 / 65.7 | 27.8 / 32.5 / 48.4 | 20.4 / 22.6 / 28.6 |

Only Spark USDS kept a quarter of deposits withdrawable in every event it saw. It has the shortest record: 12 events, 2025-06 → 2026-08, none of them a utilisation lock. Every other venue's worst event is at most 1.0pp above levered long in the never-sold column, and at most 1.8pp in the ≤5% column (Spark USDC; Steakhouse 1.4pp). Rows with the same stock were solved once and copied (`aliasOf` in the JSON): ×0 whatever the lock, and Spark USDC bad = worst, which are the same event.

## What the 8h window adds

Never-sold start LTV with the delay vs instant liquidation at the same line:

| | 30d | 90d | 365d |
|---|---|---|---|
| ETH levered long | 26.1 vs 25.1 | 20.8 vs 20.0 | 15.2 vs 14.7 |
| BTC levered long | 30.6 vs 29.4 | 28.6 vs 27.6 | 17.6 vs 17.1 |
| wstETH levered long | 32.8 vs 31.6 | 20.4 vs 19.6 | 15.2 vs 14.7 |
| ETH carry, Aave USDC typical | 29.4 vs 28.3 | 23.4 vs 22.5 | 17.2 vs 16.5 |

**The window is worth at most the 4% band, by construction.** A trough more than 4% (in LTV) past the line sells immediately, timer or not. With nothing to recall, the delayed edge therefore cannot exceed 1.04 × the instant edge. The worst windows are multi-week declines that reach that ceiling: measured ×1.029–1.040 (weETH 90d ×1.010). Carry at the Aave USDC analogs is also ≤ ×1.041. The window saves wicks that stay inside the band and recover within 8h. That only trims the sold share at a fixed LTV (ETH at HF 2 over 90 days: 8.5% → 7.3%).

## The numbers A10 needs

Levered long, share of start hours sold, delayed vs instant ("sold" = first partial liquidation back to the borrow LTV, not a wipe-out):

| | 30d | 90d | 365d |
|---|---|---|---|
| ETH at 2x (LTV 50%) | 5.4% vs 6.1% | 20.1% vs 22.4% | 43.7% vs 45.2% |
| ETH at HF 2 (LTV 40%) | 1.9% vs 2.4% | 7.3% vs 8.5% | 32.6% vs 34.0% |
| BTC at 2x (LTV 50%) | 3.7% vs 4.7% | 13.4% vs 16.0% | 34.7% vs 35.2% |
| BTC at HF 2 (LTV 37.5%) | 1.0% vs 1.1% | 4.3% vs 5.3% | 18.1% vs 19.9% |
| wstETH at HF 2 (LTV 39%) | 0.9% vs 1.4% | 6.7% vs 8.0% | 37.2% vs 39.2% |

## Copy claims, measured per position size

This is the A1 claim, measured directly rather than read off the table. The case is ETH, delayed class, start LTV 40% (HF 2 at the 80% line), with the deployed debt at Aave USDC's typical or bad stress capacity. The figure is the share of start hours with collateral sold, from one engine run per start hour at that LTV, with no bisection.

| Shape · collateral (debt) | 90d sold | 365d sold |
|---|---|---|
| carry, Aave USDC typical · $5,000 ($2,000) | 8.5% (`floor` 4,819, band 52) | 34.0% (`floor` 17,114, band 52) |
| carry, Aave USDC typical · $9,999 – $100,000 ($3,999.60 – $40,000) | 4.5% | 26.2% |
| carry, Aave USDC bad · $5,000 ($2,000) | 8.5% (`floor` 4,450, band 421) | 34.0% (`floor` 16,745, band 421) |
| carry, Aave USDC bad · $9,999 – $100,000 | 6.5% | 31.1% |
| levered long · every size above | 7.3% | 32.6% |

- **Sold share.** At typical Aave capacity the carry position was sold in 4.5% of start hours over 90 days and 26.2% over a year. That is only modestly below a levered long at the same LTV (7.3% / 32.6%). The retired ×0.5 level had read 0 and 4.2%.
- **Recall share.** Recall fired in 8.5% (90d) and 34.0% (365d) of start hours at every size. Every time, it drew the venue's whole share: 11.2% (typical) or 3.9% (bad) of the deployed debt, with median = p95 = max.
- **The debt floor moved.** A recall that would leave less than $2,000 of debt asks for the whole loan. With 11.19% recallable, that happens only under $2,000 / (1 − 0.1119) ≈ $2,252 of debt. Measured on ETH over 90 days, $2,240 of debt was floor-sold in the same 8.5% of start hours, and $2,260 matched the large size (4.5%). Under that line carry was sold *more* often than a levered long (Caveats, Debt floor).

Counts (start hours): typical 2,570 / 57,122 and 13,240 / 50,522; bad 3,688 / 57,122 and 15,702 / 50,522; levered long 4,197 / 57,122 and 16,482 / 50,522.

## Worst windows (levered long; carry rows share them)

| | 30d | 90d | 365d |
|---|---|---|---|
| ETH | 2020-02-15 → 03-13, −68.6% | 2022-04-03 → 06-18, −75.0% | 2021-11-10 → 2022-06-18, −81.6% |
| BTC | 2020-02-13 → 03-13, −60.7% | 2022-03-28 → 06-18, −63.2% | 2021-11-09 → 2022-11-09, −76.6% |
| wstETH | 2021-05-12 → 05-23, −59.4% | 2022-04-03 → 06-18, −74.8% | 2021-11-10 → 2022-06-18, −81.1% |
| weETH | 2026-01-15 → 02-06, −48.1% | 2025-01-07 → 04-07, −61.2% | 2025-08-24 → 2026-06-06, −68.8% |

## Method

- **Start hours:** every hour whose whole window is in the data (stride 1h, no skipping). ETH and BTC: 2020-01-01 → 2026-10-06, ≈58.6k / 57.1k / 50.5k starts for 30 / 90 / 365d. wstETH starts 2021-02-20; weETH starts 2023-11-10.
- **Data rebuild:** the price history was rebuilt on 2026-10-06 with the Chainlink phase-handover round. At a proxy phase switch, the hourly oracle columns had carried the old aggregator's last value until the new aggregator's first in-phase round: up to ~3 h, under 0.2% (refuter finding; `lib/position-sim/oracleRounds.ts`, each handover checked against the proxy's own `latestRoundData` at the switch block). Every cell was re-run on the rebuilt data, and all 168 rows came out identical: edges, quantiles, worst windows, sold shares and engine-run counts.
- **Path:** each hour is two 30-minute steps: its oracle low, then its close, relative to the entry close. Lows are rounds the oracle printed (a keeper could act on them). Highs are left out (they could clear a timer and flatter the window).
- **Engine:** every "sold?" is one stressGrid `runStress` replay. Rules: delayed class; recall before sale; 3pp borrow gap; $2,000 `liqDebtMinimum`; the owner's intended rules (recall asks loan − B × collateral; no sub-minimum dust); $100k collateral. Carry deploys the whole debt at a named `EXIT_CAPACITY_PRESETS` level: a measured venue analog (stress-grid/5) or a bound. Levered long has no recall.
- **Solve:** per start hour, frontier.ts `bisectEdge` solves the start LTV to 0.02pp. The search runs between line × the window's lowest ratio (below it nothing crosses the line) and the cap. Starts are visited in order of that bound, and the walk stops once no unvisited start can enter the lowest 5%, so the tail is exact. "≤ f" = the ⌊f·n⌋-th smallest edge, rounded down to 0.1pp.
- **Re-run for the analogs (2026-10-06):** 141 rows newly solved, 7.8M engine runs, ≈310 CPU-minutes. That covers Aave USDC's three levels on every asset and class, every other stable venue on ETH (delayed), and the wstETH sensitivity rows.
- **Rows carried over:** levered long, ×1 and ×0 have no lock and an unchanged multiple, so the engine change cannot move them. Those 108 rows are copied from the stress-grid/4 run (`seededFrom` in the JSON). ETH delayed was re-solved in full as a check, and all 9 rows matched in every field: edges, worst windows, sold shares, engine-run counts and probe counts.
- **Data review fixes (2026-10-07).** Four defects in the venue analogs were fixed, with tests (`tests/unit/venueStressRules.test.ts`, `tests/unit/venueStressAnalogs.test.ts`):
  - **The 00:00 UTC drain.** Aave USDC's cash goes to ~0 for ~40 minutes around midnight UTC on most days of Q4-2024 and May–Oct 2026, and the 00:00 reading lands in it. One such reading a day had kept two utilisation episodes open for months (2024-10-23 → 12-14 and 2026-05-08 → 10-07) and made a third. A one-hour transient that the next hourly reading clears is no longer a trigger (the builder and the analogs share the rule, `venueStressRules.ts`).
  - **Hourly baseline.** The 6-hourly baseline stepped over 2 h spikes: Aave USDC 2024-03-13 and 2026-01-29, Aave USDT 2024-03-12 and 2026-01-20, Spark DAI 2024-02-29. Every hour is now read (13,787 more archive reads), and those five are utilisation episodes.
  - **Steakhouse pro-rata.** The vault's cash was its first-in-line walk while Aave and Spark are pro-rata. It is now its pro-rata share of each market's idle cash (all 12,002 earlier vault rows re-read at their own blocks; the first-in-line walk reproduced every stored figure). Steakhouse typical went from 21.83% to 10.57%.
  - **Lock in the window.** A locked event's lock was the longest ≤ 1% stretch anywhere in 72 h. It is now the stretch the 8 h window runs into: Spark DAI worst went from a 78 h lock that started 20 h after onset to a 17 h one (a different event, Dec-2024).
  - **Effect.** Aave USDC typical is unchanged (11.19%, the same event, rank 17 of 33). The drain's three false events left. Four came in: 2024-03-13 (missed by the 6-hourly pass), 2026-07-01 and 2026-10-05 (multi-hour stress inside the old drain episode), and 2024-12-02. The Dec-2024 named window had taken its onset (2024-12-03T21) from a one-reading Steakhouse spike on the first-in-line basis; it now starts at the 2024-12-09 ETH drop and merges with it. Aave USDC bad fell from 6.49% (Dec-2024) to 3.91% (Oct-2025). The worst (Kelp) is unchanged.
- **Re-run for the review fixes (2026-10-07):** the 45 rows whose venue stock moved were solved again — Aave USDC bad on every main path and class, and on ETH delayed Aave USDT typical, Aave USDe bad, Steakhouse's three levels and Spark DAI typical and worst. That is 2.18M engine runs, ≈75 CPU-minutes. The other 210 rows were seeded by stock from the 2026-10-06 run (`seededFrom`; 3 under another case with the same stock, `seededAs`), and two seeded cells re-solved as a probe matched exactly. In the A1 claim, Aave USDC bad was re-measured; typical and levered long were copied.
- **Copy claims:** a claim quoted at one LTV is measured directly, not read off the ℓ\* table. That is one `runStress` per start hour at that LTV (`tallyAtLtv`, driver `--claims`), at several position sizes, with no bisection and so no monotonicity assumed. These runs also record how often recall fired and how much of the deployed debt it unwound (`claims` in the JSON).
- **Checks:**
  - Across every cell, the worst windows were probed at each whole % between the bound and the solved edge: 0 sales in 16,283 probes, and 0 bound violations.
  - Unit tests in `tests/unit/setAndForget.test.ts`, including a brute-force engine scan that now covers a locked measured analog.
  - The analog rows are recomputed from the venue history and must match `exitCapacityAnalogs.ts` exactly (`tests/unit/venueStressAnalogs.test.ts`).

## Assumptions

- **Lines:**
  - ETH 80% is master's `WETH_MAX_LTV` (DeployFullSystem.s.sol:212, "placeholder; re-derive per risk model"). 90% is its delayed-class listing cap, not the line.
  - BTC 75% (WBTC entry), wstETH 78% and weETH 75% are **modelled** `MEMBRANE_ASSET_LTV` entries, not protocol state.
  - All four list in the delayed class; no-delay is for stables.
  - Levered-long edges scale with the line (ℓ*/line is line-free, tested): at a 90% ETH line, multiply by 1.125.
- **LSTs:** ETH/USD × exchange rate (`stEthPerToken`, `getRate`). No market depeg.
- **Exit capacity:** a **measured analog**, under the **pro-rata race assumption**: every depositor exits at once, so a recall gets the venue's withdrawable fraction of its deposit, whatever its size.
  - The fraction is the lowest over the first 8 h of one real stress event.
  - A locked event (≤ 1%) also gives no recall for its measured lock, from the first breach.
  - The venue's stock never refills, so a recovery after a lock is not credited.
  - ×1 is an upper bound only. ×0 is the theoretical floor (a paused reserve, or a recall that loses the race).
  - See [Exit capacity](#exit-capacity-measured-venue-analogs).

## Sensitivities (levered long: never / ≤1% / ≤5%)

| Path | 30d | 90d | 365d |
|---|---|---|---|
| ETH, oracle only (from 2020-04-08, no Mar-2020) | 33.6 / 41.0 / 51.5 | 20.8 / 24.3 / 38.1 | 15.2 / 16.9 / 21.1 |
| ETH, Coinbase market path | 26.1 / 33.7 / 48.7 | 20.6 / 24.0 / 35.9 | 15.0 / 16.7 / 21.1 |
| BTC, Coinbase market path | 28.7 / 34.9 / 51.3 | 28.5 / 30.8 / 37.8 | 17.3 / 20.9 / 26.6 |
| ETH, hourly closes only | 28.6 / 36.7 / 50.1 | 20.9 / 24.5 / 36.9 | 15.3 / 17.0 / 21.5 |
| wstETH rate-priced, from 2021-08-25 | 34.9 / 40.4 / 49.6 | 20.4 / 23.4 / 36.1 | 15.2 / 16.4 / 19.3 |
| wstETH × stETH/ETH market, same span | 33.2 / 38.7 / 49.0 | 19.1 / 21.8 / 35.2 | 14.3 / 15.5 / 18.1 |
| wstETH rate-priced, from 2021-08-25 — carry, Aave USDC typical | 39.2 / 45.5 / 55.9 | 23.0 / 26.3 / 40.6 | 17.2 / 18.5 / 21.7 |
| wstETH × stETH/ETH market — carry, Aave USDC typical | 37.4 / 43.6 / 55.2 | 21.5 / 24.6 / 39.7 | 16.2 / 17.4 / 20.4 |

- **March 2020.** The ETH 30-day edge is set by March 2020 (Coinbase data; the oracle was silent). Without it, the edge is 33.6%.
- **Market wicks** cost 0–2pp (worst: BTC, Mar-2020).
- **The stETH depeg.** Pricing it in costs ≈1–2pp for levered long, and 1.0–1.8pp for carry at typical Aave USDC capacity (365d: 17.2 → 16.2%).

## Caveats

- **Past windows ≠ future ones.** Starts overlap: the 365-day tail rests on ≈6 years and one bear market (Nov-2021 → Jun-2022).
- **The analogs describe 2023-10 → 2026-10 only.** The price windows reach back to 2020, but the venue history does not. Aave USDC's events start 2024-01. The 2020–2022 crashes are run at capacity measured in later, different stress.
  - **Thin samples.** Spark USDC, USDS and USDT and Aave USDe have 9–14 events each, so their "bad" level is rank 1–2.
  - **A level is one event,** not a distribution. Aave USDT's "bad" event (2026-10-06) runs past the data's end.
- **Pro-rata is a modelling choice.**
  - First in line, a recall could take the venue's whole cash: up to $231M across the typical Aave USDC window, and $7k at Kelp.
  - Losing the race leaves nothing (the ×0 bound).
  - The analog counts only the cash on hand. It does not count suppliers re-entering, rate-driven repayment inside the window, or the recall's own size moving the market.
- **Not modelled:**
  - keeper/protocol fees, gas, slippage, MEV;
  - interest accrual (pushes LTV up over long holds);
  - venue yield;
  - the stale-timer amnesty;
  - the venue stock refilling after a recall.
- **Horizon end:** a timer armed near the end resolves on the held last price and counts (BTC 365d, weETH 90d: sold 7.5h after the horizon). That is conservative by at most the band.
- **Never sold ≠ untouched:** in carry, recall drew down the deployed capital (see ×1, and every recall above drew the venue's whole share).
- **Debt floor (size):** at $100k of collateral the $2,000 `liqDebtMinimum` never decides whether a sale happens. Near the floor it does:
  - **The mechanism.** A recall that would leave less than $2,000 of debt asks for the whole loan. The venue returns only its share, and the rest is closed by selling collateral at the first line crossing, with no window (sale reason `floor`).
  - **Where the line falls.** With 11.19% recallable, that happens under about $2,252 of debt. Measured at HF 2 over 90 days: $2,240 of debt was floor-sold, $2,260 was not.
  - **Measured.** At $2,000 of debt (HF 2), carry was sold in 8.5% of start hours over 90 days and 34.0% over a year, nearly all `floor`. That is more than a levered long at the same LTV (7.3% / 32.6%).
  - **Monotonicity.** Small positions also break the bisection's monotonicity (the ×0.5 run found sold islands at $10,000 of collateral). **The ℓ\* tables hold for large positions only.**

## Not answered: profitable

The owner asked which LTV is **profitable** to set and forget. Every number in this doc answers only "was collateral sold". No income or cost enters it, so none of it shows a position made money. Missing:

- **Income:** venue yield on the deployed debt, less Membrane's curator-set share of it. Not modelled.
- **The fee on a recall cure:** on master, a recall-only cure is still billed the ordinary liquidation fee on the restore target (`LiquidationEngine.sol` STEP 2.5, ~1623–1658), and it is paid from collateral. The engine omits it (`stressGrid.ts` header, OMITTED). So a carry position that is "never sold" still loses some collateral each time recall fires.
- **Unwound carry:** for ETH carry at HF 2, recall fired in 8.5% of start hours over 90 days and 34.0% over a year. Each time, it drew the venue's whole share of the deployed debt (11.2% at typical Aave capacity). Capital that is drawn stops earning.
- **Interest** on a levered long (see Caveats). Deployed carry debt is charged through the venue, not as interest.

The table answers "survives", not "profits". A profitability model needs the measured inputs (how often recall fires and how much it unwinds); they are in `claims` in the JSON.

## What this means for copy

- **A1 ("Set it and forget it") is not supported at measured venue capacity.**
  - **The measurement.** ETH carry at 40% LTV (HF 2), with the deployed debt at typical Aave USDC stress capacity, was sold in **4.5%** of 2020–2026 start hours over 90 days and **26.2%** over a year ([Copy claims](#copy-claims-measured-per-position-size)). At bad-stress capacity the figures are 6.5% and 31.1%. A levered long at the same LTV: 7.3% / 32.6%.
  - **Retire the old wording.** The earlier "never sold over 90 days" came from the retired ×0.5 level, a capacity no measured stress event at Aave delivered.
  - **What can still be said.** A survival statement at a lower LTV read off the table, e.g. ETH carry at typical Aave capacity was never sold over 90 days at ≤ 23.4% LTV. State the size floor (at least ~$2,252 of debt) and that it depends on the venue returning its measured stress share.
  - **What it is not.** It is never a profit claim ([Not answered: profitable](#not-answered-profitable)). Each recall unwinds the venue's whole share and is billed a fee from collateral.
  - **Copy rules.** Copy may say "not sold", never "profitable". Say how: recall repays debt from the deployed position before collateral is sold, and that position shrinks. Never promise positive carry or free borrowing; never "0%".
- **A10 ("Leverage you can sleep on") is not supported as written.**
  - **The window.** With nothing to recall, the window adds at most 4% relative LTV (0.3–1.6pp).
  - **The posture.** HF ≈ 2 is a one-month posture: on ETH it was sold in 1.9% of start hours over 30 days and 32.6% over a year.
  - **Recall.** At measured venue capacity it adds only 2–5pp more.
  - **Reframe** as "the window absorbs wicks inside 4%; recall absorbs part of a drawdown, as much as the venue lets out". Or show each user the historical sold share at their own LTV, size and venue instead of promising sleep.
