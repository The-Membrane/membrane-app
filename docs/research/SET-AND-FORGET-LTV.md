# Set-and-forget LTV: which start LTV survives being left alone

Owner ask (2026-10-04): "what LTV per asset will be profitable to set and forget with our recall mech". **This replay answers only the survival half: the start LTV at which collateral is never sold. It does not answer "profitable"** — see [Not answered: profitable](#not-answered-profitable). Generated 2026-10-06 by `scripts/position-sim/set-and-forget-sim.ts`; data in `public/data/price-history/set-and-forget-ltv.json`. **Historical replay — not a forecast, not a probability.**

## Headline

Start LTV (%) at which a position opened in a historical hour and left untouched has collateral sold in **none / ≤1% / ≤5%** of start hours. Delayed class (4% band, 8h window). "cap" = no sale even at the borrow cap (line − 3pp). $100k of collateral, so **the carry rows are for large positions**: under $4,000 of debt the debt floor turns the first recall into a whole-loan close and a collateral sale ([Copy claims](#copy-claims-measured-per-position-size)).

| Asset · line | Shape | 30d | 90d | 365d |
|---|---|---|---|---|
| ETH · 80% | levered long | 26.1 / 33.8 / 49.2 | 20.8 / 24.3 / 36.2 | 15.2 / 16.9 / 21.4 |
| | carry ×0.1 | 29.0 / 37.6 / 54.7 | 23.1 / 27.1 / 40.2 | 16.9 / 18.8 / 23.7 |
| | carry ×0.5 | 52.2 / 67.7 / cap | 41.6 / 48.7 / 72.5 | 30.5 / 33.9 / 42.8 |
| BTC · 75% | levered long | 30.6 / 37.2 / 52.2 | 28.6 / 32.2 / 38.4 | 17.6 / 20.9 / 26.6 |
| | carry ×0.1 | 34.0 / 41.3 / 58.0 | 31.8 / 35.8 / 42.7 | 19.5 / 23.3 / 29.6 |
| | carry ×0.5 | 61.2 / cap / cap | 57.4 / 64.4 / cap | 35.1 / 41.9 / 53.3 |
| wstETH · 78% | levered long | 32.8 / 39.7 / 48.7 | 20.4 / 23.5 / 36.4 | 15.2 / 16.5 / 19.7 |
| | carry ×0.1 | 36.5 / 44.1 / 54.1 | 22.7 / 26.1 / 40.5 | 16.9 / 18.4 / 21.9 |
| | carry ×0.5 | 65.7 / cap / cap | 40.9 / 47.0 / 72.9 | 30.5 / 33.2 / 39.4 |
| weETH · 75%† | levered long | 40.4 / 43.9 / 50.5 | 29.4 / 33.1 / 39.4 | 24.2 / 25.8 / 27.4 |
| | carry ×0.1 | 44.9 / 48.8 / 56.1 | 32.6 / 36.8 / 43.8 | 26.9 / 28.7 / 30.5 |
| | carry ×0.5 | cap / cap / cap | 58.8 / 66.2 / cap | 48.5 / 51.6 / 54.9 |

"Carry ×k": the whole debt is deployed and the venue returns k of it on recall (×0.1 "kelp-lock", ×0.5 "stressed"). **Carry ×1** ("optimistic", never a default) is "cap" in every cell; **×0** ("frozen") equals levered long in all 24 cells. † weETH is **not** wstETH: it is ether.fi's wrapped eETH, a liquid *restaking* token (ETH staked through ether.fi and restaked on EigenLayer), where wstETH is Lido's wrapped staked ETH. It is in the table only because the sim carries a modelled 75% line for it (`MEMBRANE_ASSET_LTV`, lib/position-sim/membrane.ts:200); it is priced as ETH × its on-chain `getRate()`, and its data starts 2023-11-10 — no 2020–2022 crash, so its row is not comparable.

- **Levered long** (debt swapped back into the asset, nothing to recall): a year untouched on ETH was never sold only at **≤15.2% LTV** (≈1.18x looped); 21.4% was sold in 5% of start hours.
- **Carry is decided by the venue.** ×1: no sale up to the cap, but at the cap recall fired in 70–93% of start hours (the carry was partly unwound). ×0.5: ETH never sold at 52% (30d) falling to 30.5% (365d). ×0.1: only 1.7–4.5pp above levered long.

## What the 8h window adds

Never-sold start LTV with the delay vs instant liquidation at the same line:

| | 30d | 90d | 365d |
|---|---|---|---|
| ETH levered long | 26.1 vs 25.1 | 20.8 vs 20.0 | 15.2 vs 14.7 |
| BTC levered long | 30.6 vs 29.4 | 28.6 vs 27.6 | 17.6 vs 17.1 |
| wstETH levered long | 32.8 vs 31.6 | 20.4 vs 19.6 | 15.2 vs 14.7 |
| ETH carry ×0.5 | 52.2 vs 50.2 | 41.6 vs 40.0 | 30.5 vs 29.3 |

**The window is worth at most the 4% band — by construction.** A trough more than 4% (in LTV) past the line sells immediately, timer or not, so with nothing to recall the delayed edge cannot exceed 1.04 × the instant edge. The worst windows are multi-week declines that reach that ceiling: measured ×1.029–1.040 (weETH 90d ×1.010; carry also ≤ ×1.040). The window saves wicks that stay inside the band and recover within 8h, which only trims the sold share at a fixed LTV (ETH at HF 2 over 90 days: 8.5% → 7.3%).

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

The A1 claim, measured directly rather than read off the table: ETH, delayed class, start LTV 40% (HF 2 at the 80% line), the share of start hours with collateral sold. One engine run per start hour at that LTV, no bisection.

| Shape · collateral (debt) | 90d sold | 365d sold |
|---|---|---|
| carry ×0.5 · $5,000 ($2,000) | 8.5% (all `floor`) | 34.0% (all `floor`) |
| carry ×0.5 · $9,999 ($3,999.60) | 8.5% (all `floor`) | 34.0% (all `floor`) |
| carry ×0.5 · $10,000 ($4,000) | 0 | 4.2% |
| carry ×0.5 · $20,000 ($8,000) | 0 | 4.2% |
| carry ×0.5 · $100,000 ($40,000) | 0 | 4.2% |
| levered long · every size above | 7.3% | 32.6% |

The line is 2 × `liqDebtMinimum` = $4,000 of debt. Under it, carry ×0.5 was sold *more* often than a levered long at the same LTV, because the first recall closes the whole loan (Caveats, Debt floor). Recall fired in 8.5% (90d) and 34.0% (365d) of start hours at every size. At $100k it drew a median 17.2% (90d) and 30.0% (365d) of the deployed debt, p95 50% — the venue's whole share. Under $4,000 of debt every recall drew the whole 50%. Counts: 4,871 / 57,122 and 17,166 / 50,522 (`floor`); 2,113 / 50,522 (band 1,875, expiry 238); levered long 4,197 / 57,122 and 16,482 / 50,522.

## Worst windows (levered long; carry rows share them)

| | 30d | 90d | 365d |
|---|---|---|---|
| ETH | 2020-02-15 → 03-13, −68.6% | 2022-04-03 → 06-18, −75.0% | 2021-11-10 → 2022-06-18, −81.6% |
| BTC | 2020-02-13 → 03-13, −60.7% | 2022-03-28 → 06-18, −63.2% | 2021-11-09 → 2022-11-09, −76.6% |
| wstETH | 2021-05-12 → 05-23, −59.4% | 2022-04-03 → 06-18, −74.8% | 2021-11-10 → 2022-06-18, −81.1% |
| weETH | 2026-01-15 → 02-06, −48.1% | 2025-01-07 → 04-07, −61.2% | 2025-08-24 → 2026-06-06, −68.8% |

## Method

- **Start hours:** every hour whose whole window is in the data (stride 1h — no skipping). ETH and BTC: 2020-01-01 → 2026-10-06, ≈58.6k / 57.1k / 50.5k starts for 30 / 90 / 365d; wstETH from 2021-02-20; weETH from 2023-11-10.
- **Data rebuild:** the price history was rebuilt on 2026-10-06 with the Chainlink phase-handover round. At a proxy phase switch the hourly oracle columns had carried the old aggregator's last value until the new aggregator's first in-phase round: up to ~3 h, under 0.2% (refuter finding; `lib/position-sim/oracleRounds.ts`, each handover checked against the proxy's own `latestRoundData` at the switch block). Every cell was re-run on the rebuilt data, and all 168 rows came out identical: edges, quantiles, worst windows, sold shares and engine-run counts.
- **Path:** each hour is two 30-minute steps — its oracle low, then its close — relative to the entry close. Lows are rounds the oracle printed (a keeper could act on them); highs are left out (they could clear a timer and flatter the window).
- **Engine:** every "sold?" is one stressGrid `runStress` replay — delayed class, recall before sale, 3pp borrow gap, $2,000 `liqDebtMinimum`, the owner's intended rules (recall asks loan − B × collateral; no sub-minimum dust). $100k collateral. Carry deploys the whole debt at a named `EXIT_CAPACITY_PRESETS` level; levered long has no recall.
- **Solve:** per start hour, frontier.ts `bisectEdge` on start LTV to 0.02pp, between line × the window's lowest ratio (below it nothing crosses the line) and the cap. Starts are visited in order of that bound and the walk stops once no unvisited start can enter the lowest 5%, so the tail is exact. "≤ f" = the ⌊f·n⌋-th smallest edge, rounded down to 0.1pp. 7.8M engine runs, ≈250 CPU-minutes.
- **Copy claims:** a claim quoted at one LTV is measured directly, not read off the ℓ\* table — one `runStress` per start hour at that LTV (`tallyAtLtv`, driver `--claims`), at several position sizes, with no bisection and so no monotonicity assumed. They also record how often recall fired and how much of the deployed debt it unwound (`claims` in the JSON).
- **Checks:** the 10 worst windows of every cell probed at each whole % between the bound and the solved edge — 0 sales in 22,000 probes; 0 bound violations; 34 unit tests (`tests/unit/setAndForget.test.ts`), including a brute-force engine scan and a plain-run check of `tallyAtLtv`.

## Assumptions

- **Lines:** ETH 80% is master's `WETH_MAX_LTV` (DeployFullSystem.s.sol:212, "placeholder; re-derive per risk model"); 90% is its delayed-class listing cap, not the line. BTC 75% (WBTC entry), wstETH 78% and weETH 75% are **modelled** `MEMBRANE_ASSET_LTV` entries, not protocol state. All four list in the delayed class; no-delay is for stables. Levered-long edges scale with the line (ℓ*/line is line-free, tested): at a 90% ETH line multiply by 1.125.
- **LSTs:** ETH/USD × exchange rate (`stEthPerToken`, `getRate`) — no market depeg.
- **Exit capacity:** ×1 / ×0.5 / ×0.1 / ×0 are named scenarios, not measurements.

## Sensitivities (levered long: never / ≤1% / ≤5%)

| Path | 30d | 90d | 365d |
|---|---|---|---|
| ETH, oracle only (from 2020-04-08, no Mar-2020) | 33.6 / 41.0 / 51.5 | 20.8 / 24.3 / 38.1 | 15.2 / 16.9 / 21.1 |
| ETH, Coinbase market path | 26.1 / 33.7 / 48.7 | 20.6 / 24.0 / 35.9 | 15.0 / 16.7 / 21.1 |
| BTC, Coinbase market path | 28.7 / 34.9 / 51.3 | 28.5 / 30.8 / 37.8 | 17.3 / 20.9 / 26.6 |
| ETH, hourly closes only | 28.6 / 36.7 / 50.1 | 20.9 / 24.5 / 36.9 | 15.3 / 17.0 / 21.5 |
| wstETH rate-priced, from 2021-08-25 | 34.9 / 40.4 / 49.6 | 20.4 / 23.4 / 36.1 | 15.2 / 16.4 / 19.3 |
| wstETH × stETH/ETH market, same span | 33.2 / 38.7 / 49.0 | 19.1 / 21.8 / 35.2 | 14.3 / 15.5 / 18.1 |

The ETH 30-day edge is set by March 2020 (Coinbase data; the oracle was silent) — without it, 33.6%. Market wicks cost 0–2pp (worst: BTC, Mar-2020). Pricing the stETH depeg in costs ≈1–2pp for levered long and 1.7–3.4pp for carry ×0.5 (365d: 30.5 → 28.8%).

## Caveats

- **Past windows ≠ future ones.** Starts overlap: the 365-day tail rests on ≈6 years and one bear market (Nov-2021 → Jun-2022).
- **Not modelled:** keeper/protocol fees, gas, slippage, MEV; interest accrual (pushes LTV up over long holds); venue yield; the stale-timer amnesty.
- **Horizon end:** a timer armed near the end resolves on the held last price and counts (BTC 365d, weETH 90d: sold 7.5h after the horizon) — conservative by at most the band.
- **Never sold ≠ untouched:** in carry, recall drew down the deployed capital (see ×1).
- **Debt floor (size):** at $100k of collateral the $2,000 `liqDebtMinimum` never decides whether a sale happens. Under 2 × the floor ($4,000 of debt at the call) it does: a recall that would leave less than $2,000 of debt asks for the whole loan, the venue returns only its share, and the rest is closed by selling collateral at the first line crossing, with no window (sale reason `floor`). Measured directly at HF 2 (40% LTV), ETH carry ×0.5: with $5,000 or $9,999 of collateral it was sold in **8.5%** of start hours over 90 days and **34.0%** over a year, every one a `floor` sale. That is more than a levered long at the same LTV (7.3% / 32.6%). With $10,000 and up it was sold in none over 90 days and 4.2% over a year ([Copy claims](#copy-claims-measured-per-position-size)). Small positions also break the bisection's monotonicity: at $10,000 of collateral the 30-day solve found 140 sold probes under its solved edge, and the 90-day edge fell to 20.0%. **The ℓ\* tables hold for large positions only.**

## Not answered: profitable

The owner asked which LTV is **profitable** to set and forget. Every number in this doc answers only "was collateral sold". No income or cost enters it, so none of it shows a position made money. Missing:

- **Income:** venue yield on the deployed debt, less Membrane's curator-set share of it. Not modelled.
- **The fee on a recall cure:** on master, a recall-only cure is still billed the ordinary liquidation fee on the restore target (`LiquidationEngine.sol` STEP 2.5, ~1623–1658), and it is paid from collateral. The engine omits it (`stressGrid.ts` header, OMITTED). So a carry position that is "never sold" still loses some collateral each time recall fires.
- **Unwound carry:** recall fires often. For ETH carry ×0.5 at HF 2 it fired in 8.5% of start hours over 90 days and 34.0% over a year. At $100k it drew a median 17.2% (90d) and 30.0% (365d) of the deployed debt, p95 50% — the venue's whole share. Capital that is drawn stops earning.
- **Interest** on a levered long (see Caveats). Deployed carry debt is charged through the venue, not as interest.

The table answers "survives", not "profits". A profitability model needs the measured inputs (how often recall fires and how much it unwinds); they are in `claims` in the JSON.

## What this means for copy

- **A1 ("Set it and forget it") — a survival claim only, above a size floor, and conditional on the venue returning capital. Not a profit claim.** Measured ([Copy claims](#copy-claims-measured-per-position-size)): an ETH carry position at 40% LTV (HF 2) with half its deployed debt recallable, and **$4,000 of debt or more**, was never sold in any 2020–2026 start hour over 90 days, and was sold in 4.2% of start hours over a year. **Under $4,000 of debt** it was sold in 8.5% (90 days) and 34.0% (a year) — more often than a levered long at the same LTV — so the claim must state the size floor. It shows the position was not sold, not that it paid ([Not answered: profitable](#not-answered-profitable)): recall fired in 8.5% (90 days) to 34.0% (a year) of start hours, unwound up to the venue's whole share, and each recall cure is billed a fee from collateral. Copy may say "not sold", never "profitable". Say how: recall repays debt from the deployed position before collateral is sold, and that position shrinks. Never promise positive carry or free borrowing; never "0%".
- **A10 ("Leverage you can sleep on") — not supported as written.** With nothing to recall the window adds at most 4% relative LTV (0.3–1.6pp), and HF ≈ 2 is a one-month posture (ETH: sold in 1.9% of start hours over 30 days, 32.6% over a year). Reframe: "the window absorbs wicks inside 4%; recall absorbs drawdowns" and route the claim to carry **only for debt of $4,000 or more** (under it, carry ×0.5 was sold more often than the levered long it would replace) — or show each user the historical sold share at their own LTV and size instead of promising sleep.
