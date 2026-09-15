// THE SIZE OF THE DAY.
//
// Owner ruling 2026-09-12: the Oct-10 hero must state HOW BIG that day was and that it
// WAS Oct 10 — a counterfactual verdict about one wallet means nothing without the
// stakes of the window it is measured in.
//
// Every figure here is a sum over the cohort in public/data/oct10-2025/evidence.json,
// hard-coded so the landing hero never blocks on a 2,350-row fetch. The constant can
// therefore DRIFT from the data, which is exactly what tests/unit/oct10Totals.test.ts
// exists to prevent: it re-derives all five fields from the JSON and fails on a dollar.
// Change the evidence file, change these numbers.
//
// LAST MOVED 2026-09-14: wstETH stopped being priced through the STETH/ETH MARKET feed
// and is now ETH/USD x the MEASURED wrap rate 1.215989, which is what Aave demonstrably
// used. Both figures are sums over the WHOLE cohort (excluded rows included), so only the
// wstETH legs' repriced dollars moved: +$18.5k closed, +$1.52M collateral at risk. The
// headline $144M / 2,350 accounts is unchanged to the nearest million.

/** Measured Oct 10-11 2025 totals. Recomputed from the evidence JSON by the unit test. */
export const OCT10_TOTALS = {
  /** Distinct liquidated accounts in the cohort. `cohort.length`. */
  accounts: 2350,
  /** Liquidation events in the source window, before the unpriced drop. `meta.sourceEvents`. */
  events: 3111,
  /** Σ aaveClosedUsd over the cohort — what the venues actually closed, in USD. */
  aaveClosedUsd: 144_239_544,
  /** Σ collateralUsd over the cohort — the pre-liquidation collateral standing behind it. */
  collateralAtRiskUsd: 637_388_334,
  /** The chains the cohort spans, in first-seen order. */
  chains: ['mainnet', 'arbitrum', 'base', 'optimism'],
  source: 'public/data/oct10-2025/evidence.json (Σ aaveClosedUsd over the cohort)',
} as const

/**
 * THE STAKES LINE, verbatim per owner 2026-09-12: the size, the date, the count, and no
 * other words. It sits directly above the verdict; the verdict stays the headline.
 */
export const OCT10_STAKES_LINE =
  `$${Math.round(OCT10_TOTALS.aaveClosedUsd / 1_000_000)}M of loans liquidated on Aave` +
  ` · 10 Oct 2025 · ${OCT10_TOTALS.accounts.toLocaleString('en-US')} accounts`
