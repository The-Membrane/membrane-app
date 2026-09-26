import corpus from '@/public/data/liquidation-corpus.json'

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
  /** Σ membraneClosedUsd over the cohort — what the 4%/8h window + repay-to-cap would
   *  have closed on the same accounts, same prices, no deployment assumed. */
  membraneClosedUsd: 77_064_039,
  /** aaveClosedUsd − membraneClosedUsd. The day's "4% would have saved" figure. */
  keptUsd: 67_175_505,
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

/**
 * THE SCALE LINE (owner 2026-09-22): "4% sounds small, but it would've saved $X in the
 * last N years". Today the only measured corpus is Oct 10 2025, so N is one day and X
 * is keptUsd. When the multi-year scan lands, replace the window and the figure here —
 * the sentence's shape does not change. Never a number from outside this file.
 */
export const OCT10_SCALE_LINE = {
  figure: `$${(OCT10_TOTALS.keptUsd / 1e6).toFixed(0)}M`,
  window: 'on 10 Oct 2025 alone',
  result: `$${(OCT10_TOTALS.keptUsd / 1e6).toFixed(0)}M of debt protected from forced closure`,
  line: `4% sounds small. $${(OCT10_TOTALS.keptUsd / 1e6).toFixed(0)}M of debt protected from forced closure on 10 Oct 2025 alone.`,
} as const

// ---------------------------------------------------------------------------
// THE MULTI-YEAR CORPUS LINE
// ---------------------------------------------------------------------------

/**
 * THE SCALE LINE AT CORPUS SCALE (owner 2026-09-22: "the real figure").
 *
 * Same sentence as OCT10_SCALE_LINE, one day replaced by the whole measured history:
 * every Aave V3 mainnet liquidation from the Pool's deploy block to head, clustered
 * into 24h episodes and replayed through the 4%/8h window by the SAME engine
 * (lib/position-sim/history.ts) that the per-wallet scanner runs. The corpus itself is
 * built by scripts/scan-aave-liquidations.mjs; this file only reads its summary.
 *
 * WHY A STATIC IMPORT AND NOT A FETCH: the hero must not block on a network read, and a
 * hard-coded copy of the figure is exactly the drift OCT10_TOTALS' unit test exists to
 * prevent — so the number is imported from the artefact instead of transcribed from it.
 *
 * `partial` IS LOAD-BEARING. The scan takes hours and writes its summary every 2,000
 * episodes, so the JSON on disk is routinely a PARTIAL corpus. A caller that prints the
 * line without honouring this flag is claiming a finished measurement it does not have.
 * Every dollar here covers PRICED episodes only; unpriced episodes are excluded in both
 * directions and 'worse' episodes are charged at full weight — see `corpus.method`.
 */
const YEAR_MS = 365.2425 * 24 * 3600 * 1000

/** Years between the first and last observed liquidation, to one decimal. */
function corpusYears(): number {
  // Cast: a corpus written before the first event has `null` here, and TS would then
  // infer the literal type `null` and reject the arithmetic below on a later write.
  const from = corpus.fromDate as string | null
  const to = corpus.toDate as string | null
  if (!from || !to) return 0
  const ms = Date.parse(to) - Date.parse(from)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.round((ms / YEAR_MS) * 10) / 10
}

/** $1.2B / $340M / $12.4M / $940k — the largest unit the figure honestly fills. */
function usdFigure(usd: number): string {
  const v = Math.max(0, usd)
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${Math.round(v / 1e6)}M`
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`
  return `$${Math.round(v)}`
}

const corpusFigure = usdFigure(corpus.keptUsd)
const corpusYearCount = corpusYears()
const corpusWindow = `over ${corpusYearCount} years of Aave V3`

export const CORPUS_SCALE_LINE = {
  /** actualSeizedUsd − membraneSeizedUsd over PRICED episodes, formatted. */
  figure: corpusFigure,
  window: corpusWindow,
  result: `It would have kept ${corpusFigure} of collateral`,
  line: `4% sounds small. It would have kept ${corpusFigure} of collateral ${corpusWindow}.`,
  /** True while the scan is still running. The figure is a floor, not the total. */
  partial: corpus.partial === true,
  /** Unrounded, for anything that needs to do arithmetic rather than print. */
  keptUsd: corpus.keptUsd,
  years: corpusYearCount,
  source: 'public/data/liquidation-corpus.json (scripts/scan-aave-liquidations.mjs)',
} as const

type CorpusCoverage = Pick<
  typeof corpus,
  'partial' | 'pricedEpisodes' | 'episodes' | 'unpricedEpisodes'
>

/** A finished-corpus disclosure, or nothing while the scan is only a floor. */
export function corpusCoverageLine(summary: CorpusCoverage): string | null {
  if (summary.partial) return null
  return (
    `${summary.pricedEpisodes.toLocaleString('en-US')} of ${summary.episodes.toLocaleString('en-US')} episodes were priced. ` +
    `${summary.unpricedEpisodes.toLocaleString('en-US')} unpriced episodes are excluded from every dollar figure.`
  )
}

export const CORPUS_COVERAGE_LINE = corpusCoverageLine(corpus)

export type WorseByAnchorCollateralRow = {
  anchorCollateral: string
  anchorCollateralAsset: string
  episodes: number
  pricedAnchorEpisodes: number
  worseRate: number
  multiCollateralEpisodes: number
  actualSeizedUsd: number
  membraneSeizedUsd: number
  excessSeizedUsd: number
  maxMembraneToActualRatio: number
}

type CorpusWorseSummary = {
  partial: boolean
  worseCount: number
  worseByAnchorCollateral?: readonly WorseByAnchorCollateralRow[]
}

/**
 * A compact asset context for the small set of at-or-above-Aave replay outcomes.
 * The word "anchor" is deliberate: this is the first priced event that supplies the
 * replay path, line, and fee. It is not a claim that this asset caused the outcome.
 */
export function corpusWorseContextLine(summary: CorpusWorseSummary): string | null {
  if (summary.partial || summary.worseCount === 0) return null
  const rows = summary.worseByAnchorCollateral
  if (!rows?.length) return null

  const anchors = [...rows]
    .sort(
      (a, b) => b.worseRate - a.worseRate || a.anchorCollateral.localeCompare(b.anchorCollateral),
    )
    .map((row) => {
      const pct = row.worseRate * 100
      const rate = pct < 1 ? pct.toFixed(2) : pct.toFixed(1)
      return (
        `${row.anchorCollateral} ${row.episodes.toLocaleString('en-US')}/` +
        `${row.pricedAnchorEpisodes.toLocaleString('en-US')} ` +
        `(${rate}% worse; max ${row.maxMembraneToActualRatio.toFixed(2)}× Aave)`
      )
    })
    .join(' · ')
  const multiCollateralEpisodes = rows.reduce((sum, row) => sum + row.multiCollateralEpisodes, 0)
  const mixed =
    multiCollateralEpisodes > 0
      ? ` ${multiCollateralEpisodes.toLocaleString('en-US')} included more than one collateral asset.`
      : ''

  return (
    `${summary.worseCount.toLocaleString('en-US')} ‘worse’ replay episodes by anchor ` +
    `(worse / total priced): ${anchors}.` +
    `${mixed} The replay anchor is the first priced event used for the path, not the asset responsible.`
  )
}

export const CORPUS_WORSE_CONTEXT_LINE = corpusWorseContextLine(
  corpus as typeof corpus & CorpusWorseSummary,
)
