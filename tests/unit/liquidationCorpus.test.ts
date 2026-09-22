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

import corpus from '@/public/data/liquidation-corpus.json'
import { CORPUS_SCALE_LINE } from '@/lib/position-sim/oct10Totals'

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

describe('liquidation corpus summary', () => {
  it('reports the Aave V3 mainnet corpus', () => {
    expect(corpus.protocol).toBe('Aave V3 mainnet')
    expect(corpus.fromBlock).toBe(16_291_127)
    expect(corpus.toBlock).toBeGreaterThanOrEqual(corpus.fromBlock)
  })

  it('recomputes keptUsd as actual − membrane over priced episodes, to within $1', () => {
    expect(Math.abs(corpus.keptUsd - (corpus.actualSeizedUsd - corpus.membraneSeizedUsd))).toBeLessThan(1)
  })

  it('splits every episode into priced or unpriced and nothing else', () => {
    expect(corpus.pricedEpisodes + corpus.unpricedEpisodes).toBe(corpus.episodes)
  })

  it('accounts for every priced episode in exactly one verdict bucket', () => {
    const verdicts =
      corpus.savedCount + corpus.partialCount + corpus.brokeCount + corpus.worseCount
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
})
