// THE ANTI-DRIFT GATE for the Oct-10 stakes line.
//
// OCT10_TOTALS is hard-coded so the hero never waits on a 2,350-row fetch. That is only
// safe if the constant cannot silently diverge from the evidence file it claims to
// summarise — so every field is re-derived here from the JSON itself, to the dollar.

import { describe, expect, it } from 'vitest'

import evidence from '@/public/data/oct10-2025/evidence.json'
import { OCT10_STAKES_LINE, OCT10_TOTALS } from '@/lib/position-sim/oct10Totals'

const cohort = evidence.cohort as Array<{
  chain: string
  collateralUsd: number
  aaveClosedUsd: number
}>

const sum = (f: (r: (typeof cohort)[number]) => number) => cohort.reduce((a, r) => a + f(r), 0)

describe('OCT10_TOTALS', () => {
  it('matches the account count in the evidence cohort', () => {
    expect(OCT10_TOTALS.accounts).toBe(cohort.length)
  })

  it('matches the source event count in the evidence meta', () => {
    expect(OCT10_TOTALS.events).toBe(evidence.meta.sourceEvents)
  })

  it('recomputes the closed-loan total to within $1', () => {
    expect(Math.abs(OCT10_TOTALS.aaveClosedUsd - sum((r) => r.aaveClosedUsd))).toBeLessThan(1)
  })

  it('recomputes the collateral at risk to within $1', () => {
    expect(Math.abs(OCT10_TOTALS.collateralAtRiskUsd - sum((r) => r.collateralUsd))).toBeLessThan(1)
  })

  it('lists exactly the chains the cohort spans', () => {
    const seen = Array.from(new Set(cohort.map((r) => r.chain)))
    expect([...OCT10_TOTALS.chains].sort()).toEqual(seen.sort())
  })

  it('names the file it was summed from', () => {
    expect(OCT10_TOTALS.source).toContain('public/data/oct10-2025/evidence.json')
  })
})

describe('OCT10_STAKES_LINE', () => {
  it('states the size, the date and the count, and nothing else', () => {
    expect(OCT10_STAKES_LINE).toBe('$144M of loans liquidated on Aave · 10 Oct 2025 · 2,350 accounts')
  })
})
