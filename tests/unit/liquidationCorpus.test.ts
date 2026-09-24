// THE ANTI-DRIFT GATE for the multi-year corpus line.
//
// CORPUS_SCALE_LINE prints a dollar figure the landing page will put in a sentence, so
// the arithmetic behind it has to be re-derived here rather than trusted: keptUsd must
// be actualSeizedUsd − membraneSeizedUsd over PRICED episodes, to the dollar, and the
// sentence must actually render the figure and the window it claims.
//
// It also pins the HONESTY RULES the corpus encodes — unpriced episodes excluded from
// every dollar figure, 'worse' episodes counted rather than netted away, no deployment
// assumed on Membrane's side — because those are the claims that make the number
// believable, and a scan that quietly stopped encoding one of them would otherwise
// still produce a plausible-looking headline.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import corpus from '@/public/data/liquidation-corpus.json'
import {
  CORPUS_COVERAGE_LINE,
  CORPUS_SCALE_LINE,
  CORPUS_WORSE_CONTEXT_LINE,
  corpusCoverageLine,
  corpusWorseContextLine,
} from '@/lib/position-sim/oct10Totals'
import type { WorseByAnchorCollateralRow } from '@/lib/position-sim/oct10Totals'

// The JSON is REWRITTEN by the scan (every 2,000 episodes, and at the end), so its
// inferred type changes with its contents — an empty `byYear` infers `never[]` and the
// whole test file stops compiling. The shapes are pinned here, exactly as the Oct-10
// test pins `evidence.cohort`, so the gate survives a partial corpus.
type YearRow = {
  year: number
  events: number
  actualSeizedUsd: number
  membraneSeizedUsd: number
  keptUsd: number
}
type CollateralRow = {
  collateral: string
  episodes: number
  actualSeizedUsd: number
  membraneSeizedUsd: number
  keptUsd: number
}
const byYear = corpus.byYear as YearRow[]
const byCollateral = corpus.byCollateral as CollateralRow[]
const worseByAnchorCollateral = (
  corpus as typeof corpus & { worseByAnchorCollateral?: WorseByAnchorCollateralRow[] }
).worseByAnchorCollateral
const scannerSource = readFileSync('scripts/scan-aave-liquidations.mjs', 'utf8')

describe('liquidation corpus summary', () => {
  it('reports the Aave V3 mainnet corpus', () => {
    expect(corpus.protocol).toBe('Aave V3 mainnet')
    expect(corpus.fromBlock).toBe(16_291_127)
    expect(corpus.toBlock).toBeGreaterThanOrEqual(corpus.fromBlock)
  })

  it('recomputes keptUsd as actual − membrane over priced episodes, to within $1', () => {
    expect(
      Math.abs(corpus.keptUsd - (corpus.actualSeizedUsd - corpus.membraneSeizedUsd)),
    ).toBeLessThan(1)
  })

  it('splits every episode into priced or unpriced and nothing else', () => {
    expect(corpus.pricedEpisodes + corpus.unpricedEpisodes).toBe(corpus.episodes)
  })

  it('accounts for every priced episode in exactly one verdict bucket', () => {
    const verdicts = corpus.savedCount + corpus.partialCount + corpus.brokeCount + corpus.worseCount
    expect(verdicts).toBe(corpus.pricedEpisodes)
  })

  it('never nets a worse episode away — membraneSeizedUsd is charged at full weight', () => {
    // A corpus that hid its losses would show membrane >= actual nowhere. This asserts
    // only the reporting contract: the count exists and the dollars are non-negative
    // sums, so a 'worse' episode can and does push membraneSeizedUsd up.
    expect(corpus.worseCount).toBeGreaterThanOrEqual(0)
    expect(corpus.membraneSeizedUsd).toBeGreaterThanOrEqual(0)
    expect(corpus.actualSeizedUsd).toBeGreaterThanOrEqual(0)
  })

  it('counts unpricedEvents only as omitted legs inside otherwise-priced episodes', () => {
    expect(scannerSource).toContain('sum(unpriced_events) FILTER (WHERE NOT unpriced)')
    expect(corpus.method).toContain(
      `${corpus.unpricedEvents.toLocaleString('en-US')} individual events inside otherwise-priced episodes`,
    )
  })

  it('reconciles every worse episode into one exclusive replay-anchor bucket', () => {
    expect(worseByAnchorCollateral).toBeDefined()
    const rows = worseByAnchorCollateral ?? []
    expect(rows.reduce((sum, row) => sum + row.episodes, 0)).toBe(corpus.worseCount)
    expect(new Set(rows.map((row) => row.anchorCollateralAsset)).size).toBe(rows.length)

    for (const row of rows) {
      expect(row.anchorCollateral).not.toBe('')
      expect(row.anchorCollateralAsset).toMatch(/^0x[0-9a-f]{40}$/)
      expect(row.episodes).toBeGreaterThan(0)
      expect(row.pricedAnchorEpisodes).toBeGreaterThanOrEqual(row.episodes)
      expect(row.worseRate).toBeCloseTo(row.episodes / row.pricedAnchorEpisodes, 10)
      expect(row.multiCollateralEpisodes).toBeGreaterThanOrEqual(0)
      expect(row.multiCollateralEpisodes).toBeLessThanOrEqual(row.episodes)
      expect(
        Math.abs(row.excessSeizedUsd - (row.membraneSeizedUsd - row.actualSeizedUsd)),
      ).toBeLessThan(0.02)
      expect(row.excessSeizedUsd).toBeGreaterThanOrEqual(0)
      expect(row.maxMembraneToActualRatio).toBeGreaterThanOrEqual(1)
    }
  })

  it('reconciles byYear against the corpus totals, to within $1 a year', () => {
    const sumActual = byYear.reduce((a, y) => a + y.actualSeizedUsd, 0)
    const sumMembrane = byYear.reduce((a, y) => a + y.membraneSeizedUsd, 0)
    const sumEvents = byYear.reduce((a, y) => a + y.events, 0)
    expect(Math.abs(sumActual - corpus.actualSeizedUsd)).toBeLessThan(byYear.length + 1)
    expect(Math.abs(sumMembrane - corpus.membraneSeizedUsd)).toBeLessThan(byYear.length + 1)
    expect(sumEvents).toBe(corpus.events)
    for (const y of byYear) {
      expect(Math.abs(y.keptUsd - (y.actualSeizedUsd - y.membraneSeizedUsd))).toBeLessThan(1)
    }
  })

  it('keeps byCollateral to the top 8 and inside the priced totals', () => {
    expect(byCollateral.length).toBeLessThanOrEqual(8)
    const sum = byCollateral.reduce((a, c) => a + c.actualSeizedUsd, 0)
    expect(sum).toBeLessThanOrEqual(corpus.actualSeizedUsd + 1)
  })

  it('states every approximation in the method paragraph', () => {
    const m = corpus.method
    expect(m).toContain('liquidationBonus')
    expect(m).toContain('recall = 0')
    expect(m).toContain('APPROXIMATED')
    expect(m).toContain('UNPRICED')
    expect(m).toContain("'worse'")
    expect(m).toContain('NOT COVERED')
  })
})

describe('liquidation corpus resume accounting', () => {
  it('checkpoints current-parameter fallbacks atomically with each account', () => {
    const commitStart = scannerSource.indexOf('async function commitEpisodeAccount')
    const phaseStart = scannerSource.indexOf('async function phaseEpisodes')
    const commitSource = scannerSource.slice(commitStart, phaseStart)

    expect(commitStart).toBeGreaterThan(-1)
    expect(commitSource).toContain('await sql.transaction([')
    expect(commitSource).toContain("cursorUpsertQuery('episodes', userCursor)")
    expect(commitSource).toContain(
      'cursorUpsertQuery(EPISODE_FALLBACK_CURSOR, currentParamFallbacks)',
    )
  })

  it('uses the durable fallback cursor for summaries and clears it on rebuild', () => {
    const summaryStart = scannerSource.indexOf('async function writeSummary')
    const mainStart = scannerSource.indexOf(
      '// -------------------------------------------------------------------- main',
    )
    const summarySource = scannerSource.slice(summaryStart, mainStart)

    expect(scannerSource).toContain(
      "const EPISODE_FALLBACK_CURSOR = 'episodes_current_param_fallbacks'",
    )
    expect(summarySource).toContain('Number((await getCursor(EPISODE_FALLBACK_CURSOR)) ?? 0)')
    expect(scannerSource).toContain(
      "WHERE name IN ('episodes', 'episodes_done', ${EPISODE_FALLBACK_CURSOR})",
    )
  })

  it('fails closed when a legacy resume has no durable fallback total', () => {
    const phaseStart = scannerSource.indexOf('async function phaseEpisodes')
    const summaryStart = scannerSource.indexOf(
      '// ---------------------------------------------------------------- summary',
    )
    const phaseSource = scannerSource.slice(phaseStart, summaryStart)

    expect(phaseSource).toContain('if (fallbackCursor === null)')
    expect(phaseSource).toContain('if (episodeCursor !== null)')
    expect(phaseSource).toContain('seed the verified fallback total or rebuild episodes.')
    expect(phaseSource).toContain('process.exit(1)')
  })
})

describe('CORPUS_SCALE_LINE', () => {
  it('renders the sentence with its own figure and window', () => {
    expect(CORPUS_SCALE_LINE.line).toBe(
      `4% sounds small. It would have kept ${CORPUS_SCALE_LINE.figure} of collateral ${CORPUS_SCALE_LINE.window}.`,
    )
    expect(CORPUS_SCALE_LINE.line.startsWith('4% sounds small.')).toBe(true)
    expect(CORPUS_SCALE_LINE.line).toContain(CORPUS_SCALE_LINE.figure)
    expect(CORPUS_SCALE_LINE.line).toContain(CORPUS_SCALE_LINE.window)
  })

  it('formats the figure at the largest unit it honestly fills', () => {
    const kept = corpus.keptUsd
    const expected =
      kept >= 1e9
        ? `$${(kept / 1e9).toFixed(1)}B`
        : kept >= 1e6
          ? `$${Math.round(kept / 1e6)}M`
          : kept >= 1e3
            ? `$${Math.round(kept / 1e3)}k`
            : `$${Math.round(kept)}`
    expect(CORPUS_SCALE_LINE.figure).toBe(expected)
  })

  it('states the window in years, to one decimal, from the observed event span', () => {
    const ms = Date.parse(corpus.toDate) - Date.parse(corpus.fromDate)
    const years = Math.round((ms / (365.2425 * 24 * 3600 * 1000)) * 10) / 10
    expect(CORPUS_SCALE_LINE.years).toBe(years)
    expect(CORPUS_SCALE_LINE.window).toBe(`over ${years} years of Aave V3`)
  })

  it('carries the partial flag through from the corpus, never hard-coded false', () => {
    expect(CORPUS_SCALE_LINE.partial).toBe(corpus.partial === true)
  })

  it('does not silently diverge from the corpus keptUsd', () => {
    expect(CORPUS_SCALE_LINE.keptUsd).toBe(corpus.keptUsd)
  })

  it('moves priced and unpriced coverage into the disclosure line', () => {
    expect(CORPUS_COVERAGE_LINE).toBe(
      `${corpus.pricedEpisodes.toLocaleString('en-US')} of ${corpus.episodes.toLocaleString('en-US')} episodes were priced. ` +
        `${corpus.unpricedEpisodes.toLocaleString('en-US')} unpriced episodes are excluded from every dollar figure.`,
    )
  })

  it('does not present a partial scan as finished coverage', () => {
    expect(corpusCoverageLine({ ...corpus, partial: true })).toBeNull()
  })

  it('puts replay-anchor context in FinePrint without assigning causality', () => {
    expect(CORPUS_WORSE_CONTEXT_LINE).toContain(
      `${corpus.worseCount.toLocaleString('en-US')} ‘worse’ replay episodes by anchor`,
    )
    expect(CORPUS_WORSE_CONTEXT_LINE).toContain('not the asset responsible')
  })

  it('suppresses worse-episode context for partial corpora', () => {
    expect(
      corpusWorseContextLine({
        partial: true,
        worseCount: 1,
        worseByAnchorCollateral: [
          {
            anchorCollateral: 'LINK',
            anchorCollateralAsset: '0x514910771af9ca656af840dff83e8264ecf986ca',
            episodes: 1,
            pricedAnchorEpisodes: 10,
            worseRate: 0.1,
            multiCollateralEpisodes: 0,
            actualSeizedUsd: 100,
            membraneSeizedUsd: 110,
            excessSeizedUsd: 10,
            maxMembraneToActualRatio: 1.1,
          },
        ],
      }),
    ).toBeNull()
  })

  it('names the replay anchor and mixed episodes without claiming causality', () => {
    const line = corpusWorseContextLine({
      partial: false,
      worseCount: 2,
      worseByAnchorCollateral: [
        {
          anchorCollateral: 'LINK',
          anchorCollateralAsset: '0x514910771af9ca656af840dff83e8264ecf986ca',
          episodes: 2,
          pricedAnchorEpisodes: 20,
          worseRate: 0.1,
          multiCollateralEpisodes: 1,
          actualSeizedUsd: 100,
          membraneSeizedUsd: 110,
          excessSeizedUsd: 10,
          maxMembraneToActualRatio: 1.1,
        },
      ],
    })
    expect(line).toContain('LINK 2/20 (10.0% worse; max 1.10× Aave)')
    expect(line).toContain('1 included more than one collateral asset')
    expect(line).toContain('not the asset responsible')
  })
})
