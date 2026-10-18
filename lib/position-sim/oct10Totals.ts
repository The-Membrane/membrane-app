import corpus from '@/public/data/liquidation-corpus.json'
import census from '@/public/data/oct10-2025/evidence-census-headline.json'

// THE SIZE OF THE DAY.
//
// Owner ruling 2026-09-12: the Oct-10 hero must state HOW BIG that day was and that it
// WAS Oct 10 — a counterfactual verdict about one wallet means nothing without the
// stakes of the window it is measured in.
//
// MOVED 2026-10-16 (owner decision): these figures are the FULL on-chain census of 10-11 Oct
// 2025 — every Aave V3 pool and Morpho Blue market on Ethereum, Arbitrum, Optimism and Base,
// 3,197 positions, each priced by its protocol's own oracle read on chain — and they are
// IMPORTED from public/data/oct10-2025/evidence-census-headline.json (scripts/
// build-evidence-census.ts), not typed here, so the hero never blocks on the 1 MB fetch and
// can never drift from the data. tests/unit/oct10Totals.test.ts re-derives every field from
// the rows of evidence-census.json, to the cent. The old figures ($144M closed by Aave on
// 2,347 accounts, $67M kept) came from the old evidence.json, which no page reads any more.

const fmtM0 = (usd: number) => `$${Math.round(Math.abs(usd) / 1_000_000)}M`
/** 'less' when Membrane closes a smaller share than the protocols (gap >= 0), else 'more'. */
const dirOf = (gap: number) => (gap >= 0 ? 'less' : 'more')

/**
 * THE SIZE OF THE DAY — the REAL side only, over EVERY position of the census (3,197), whether or
 * not Membrane can be compared on it. It is the stakes line's figure and nothing else; the
 * comparison below is over its own, smaller set and says so.
 */
export const OCT10_DAY = {
  positions: census.day.positions,
  events: census.day.events,
  realClosedUsd: census.day.realRepaidUsd,
} as const

/**
 * Measured Oct 10-11 2025 figures over the COMPARED positions (owner rulings 2026-10-18):
 * Membrane walked at its OWN line with the debt sized to that line (debt x memLine /
 * protocolLine†), liquidity-capped sales (0.98x capacity†), and only positions where every
 * collateral leg has a Membrane line and liquidity. The two sides carry different debt, so
 * the comparison is the SHARE of each side's own t0 debt closed, never dollars. Re-derived
 * from the rows by the unit test.
 */
export const OCT10_TOTALS = {
  /** Compared positions (both sides). The census holds `censusPositions`. */
  positions: census.positions,
  censusPositions: census.censusPositions,
  /** Left out of both sides: no Membrane line, some collateral without one, no liquidity. */
  excluded: census.excluded,
  /** Liquidation events of the compared positions. */
  events: census.events,
  /** Real repaid USD on the compared positions: the size of the day there, not a comparison. */
  realClosedUsd: census.all.realRepaidUsd,
  /** Share of the real t0 debt the protocols closed (debt-weighted). */
  realShare: census.all.realShare,
  /** Share of ITS OWN (line-sized) t0 debt Membrane would close. MODELLED (†). */
  membraneShare: census.all.memShare,
  /** realShare − membraneShare, percentage points: positive = Membrane closes a smaller share. */
  gapPp: census.all.gapPp,
  /** The same per protocol. A blended figure never stands without this split. */
  byProtocol: {
    aave: {
      positions: census.aave.positions,
      realShare: census.aave.realShare,
      membraneShare: census.aave.memShare,
      gapPp: census.aave.gapPp,
    },
    morpho: {
      positions: census.morpho.positions,
      realShare: census.morpho.realShare,
      membraneShare: census.morpho.memShare,
      gapPp: census.morpho.gapPp,
    },
  },
  /** The chains the census spans, in first-seen order. */
  chains: census.chains,
  /** '10–11 Oct 2025'. */
  window: census.window,
  source: 'public/data/oct10-2025/evidence-census.json (via evidence-census-headline.json)',
} as const

const pp = (x: number) => `${Math.abs(x).toFixed(1)} pp`
const shr = (x: number) => `${(x * 100).toFixed(1)}%`

/** "Aave 13.9 pp less · Morpho 50.3 pp less": the split that rides with every blended figure. */
export const OCT10_SPLIT_LINE =
  `Aave ${pp(OCT10_TOTALS.byProtocol.aave.gapPp)} ${dirOf(OCT10_TOTALS.byProtocol.aave.gapPp)}` +
  ` · Morpho ${pp(OCT10_TOTALS.byProtocol.morpho.gapPp)} ${dirOf(OCT10_TOTALS.byProtocol.morpho.gapPp)}`

/**
 * THE STAKES LINE, per owner 2026-09-12: the size, the date, the count, and no other words.
 * It sits directly above the verdict; the verdict stays the headline. The day's real side only.
 */
export const OCT10_STAKES_LINE =
  `${fmtM0(OCT10_DAY.realClosedUsd)} of loans force-closed on Aave and Morpho` +
  ` · ${OCT10_TOTALS.window} · ${OCT10_DAY.positions.toLocaleString('en-US')} positions`

const NET_DIR = dirOf(OCT10_TOTALS.gapPp)

/**
 * THE OCT 10-11 CENSUS LINE. A NET figure in SHARE OF DEBT (percentage points), DIRECTION-AWARE,
 * and a DIFFERENT MEASURE from the corpus line below, so it says all of that:
 *   - net: Membrane closes a smaller share on `less` positions and a larger one on `more`;
 *     gapPp is the difference, never "protected" debt, and its word is computed from its sign;
 *   - its own scope: the compared Aave V3 and Morpho Blue liquidations of the window, four
 *     chains, Membrane at its own line with the debt sized to it and liquidity-capped sales.
 *     The corpus is collateral seized on Aave V3 Ethereum over years; neither figure is a part
 *     of the other, and no sentence here says "alone" (oct10Totals.test.ts asserts it).
 * All MODELLED (†). Never a number from outside this file.
 */
export const OCT10_SCALE_LINE = {
  figure: pp(OCT10_TOTALS.gapPp),
  direction: NET_DIR,
  /** The census scope, named in full wherever the figure appears. */
  scope:
    `share of debt closed on ${OCT10_TOTALS.positions.toLocaleString('en-US')} of the ${OCT10_TOTALS.censusPositions.toLocaleString('en-US')} Aave V3 and Morpho Blue liquidations of ${OCT10_TOTALS.window}, Ethereum, Arbitrum, Optimism and Base, ` +
    `at Membrane’s own lines with the debt sized to them and liquidity-capped sales†`,
  result: `${pp(OCT10_TOTALS.gapPp)} ${NET_DIR} of the debt force-closed, net† (${shr(OCT10_TOTALS.realShare)} → ${shr(OCT10_TOTALS.membraneShare)}†)`,
  split: OCT10_SPLIT_LINE,
  /** What the net is made of: positions and both shares each way. */
  gross:
    `a smaller share on ${census.all.less.toLocaleString('en-US')} positions (${shr(census.all.lessSet.realShare)} vs ${shr(census.all.lessSet.memShare)}†), ` +
    `a larger one on ${census.all.more.toLocaleString('en-US')} (${shr(census.all.moreSet.realShare)} vs ${shr(census.all.moreSet.memShare)}†)`,
  line:
    NET_DIR === 'less'
      ? `4% sounds small. The protocols force-closed ${shr(OCT10_TOTALS.realShare)} of the debt; at Membrane’s own lines a borrower would have lost ${shr(OCT10_TOTALS.membraneShare)}† of theirs — ${pp(OCT10_TOTALS.gapPp)} less, net†, across ${OCT10_TOTALS.positions.toLocaleString('en-US')} of the ${OCT10_TOTALS.censusPositions.toLocaleString('en-US')} Aave and Morpho liquidations of ${OCT10_TOTALS.window}.`
      : `The protocols force-closed ${shr(OCT10_TOTALS.realShare)} of the debt; at Membrane’s own lines a borrower would have lost ${shr(OCT10_TOTALS.membraneShare)}† of theirs — ${pp(OCT10_TOTALS.gapPp)} more, net†, across ${OCT10_TOTALS.positions.toLocaleString('en-US')} of the ${OCT10_TOTALS.censusPositions.toLocaleString('en-US')} Aave and Morpho liquidations of ${OCT10_TOTALS.window}.`,
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
