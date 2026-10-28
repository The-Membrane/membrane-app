import { describe, expect, it } from 'vitest'

import {
  CONTEXT_ODDS_FEED,
  HISTORY_LEVELS,
  HISTORY_SOURCE,
  carryCost,
  contextOddsLevel,
  distancePercentFloor,
  gradedLevel,
  historyCount,
  liquidationDistance,
  liquidationPrice,
  stressLines,
  underlyingFor,
} from '@/components/Borrow/drawdownHistory'
import history from '@/components/Borrow/data/drawdownHistory.json'

describe('liquidation distance and price', () => {
  it('d = 1 − LTV / line', () => {
    // wstETH fixture: cap 63%, line 75% -> 16% below spot (S1: "16-18% below spot" at the cap)
    expect(liquidationDistance(63, 0.75)).toBeCloseTo(0.16, 10)
    expect(liquidationDistance(40, 0.75)).toBeCloseTo(1 - 0.4 / 0.75, 10)
  })
  it('clamps to [0, 1] and survives a zero line', () => {
    expect(liquidationDistance(80, 0.75)).toBe(0)
    expect(liquidationDistance(0, 0.75)).toBe(1)
    expect(liquidationDistance(50, 0)).toBe(0)
  })
  it('price = px × (1 − d)', () => {
    expect(liquidationPrice(4000, 63, 0.75)).toBeCloseTo(3360, 6)
  })
  it('whole-percent distance rounds down, and exact integers stay put', () => {
    expect(distancePercentFloor(0.169)).toBe(16)
    expect(distancePercentFloor(0.16)).toBe(16)
    expect(distancePercentFloor(1 - 0.6 / 0.75)).toBe(20) // 0.19999999999999996 in floats
  })
})

describe('gradedLevel rounds DOWN to the counted grid', () => {
  it('grid is the reviewed nonchain grid', () => {
    expect(HISTORY_LEVELS).toEqual([15, 20, 25, 30, 40])
  })
  it.each([
    [0.149, null],
    [0.15, 15],
    [0.16, 15],
    [0.1999, 15],
    [1 - 0.6 / 0.75, 20], // float 0.19999… is still the 20% level
    [0.2, 20],
    [0.29, 25],
    [0.39, 30],
    [0.4, 40],
    [0.9, 40],
  ])('distance %s -> level %s', (d, lvl) => {
    expect(gradedLevel(d)).toBe(lvl)
  })
  it('never quotes a level deeper than the distance', () => {
    for (let d = 0.15; d <= 1; d += 0.0037)
      expect(gradedLevel(d)! / 100).toBeLessThanOrEqual(d + 1e-9)
  })
})

describe('historyCount', () => {
  it('reads the non-overlapping counts the review quotes', () => {
    // S1 README (review-corrected): ETH 7 d ≥20%: 67; ETH 30 d ≥20%: 59; BTC 7 d ≥20%: 40
    expect(historyCount('ETH', 7, 0.2).windows).toBe(67)
    expect(historyCount('ETH', 30, 0.22).windows).toBe(59)
    expect(historyCount('BTC', 7, 0.24).windows).toBe(40)
  })
  it('quotes the count at the rounded-down level', () => {
    const c = historyCount('ETH', 7, 0.16)
    expect(c).toEqual({
      underlying: 'ETH',
      horizonDays: 7,
      levelPct: 15,
      windows: 124,
      lineCloserThanGrid: false,
    })
  })
  it('a line closer than 15% is quoted at 15% and flagged', () => {
    const c = historyCount('BTC', 1, 0.12)
    expect(c.levelPct).toBe(15)
    expect(c.windows).toBe(31)
    expect(c.lineCloserThanGrid).toBe(true)
  })
  it('counts fall as the level deepens', () => {
    for (const u of ['ETH', 'BTC'] as const)
      for (const h of [1, 7, 30] as const) {
        const ws = HISTORY_LEVELS.map((l) => historyCount(u, h, l / 100).windows)
        for (let i = 1; i < ws.length; i++) expect(ws[i]).toBeLessThanOrEqual(ws[i - 1])
      }
  })
})

describe('stressLines', () => {
  it('names Mar 2020, Aug 2024 and Oct 2025 with the README drops', () => {
    expect(stressLines('ETH', 7, 0.5).map((s) => [s.label, s.dropPct])).toEqual([
      ['Mar 2020', 65],
      ['Aug 2024', 36],
      ['Oct 2025', 27],
    ])
  })
  it('reachesLine compares the unrounded drop to the distance', () => {
    const at = (d: number) =>
      stressLines('ETH', 7, d)
        .filter((s) => s.reachesLine)
        .map((s) => s.id)
    expect(at(0.16)).toEqual(['mar-2020', 'aug-2024', 'oct-2025'])
    expect(at(0.3)).toEqual(['mar-2020', 'aug-2024'])
    expect(at(0.6488)).toEqual(['mar-2020'])
    expect(at(0.6489)).toEqual([]) // displayed as −65% but measured 64.88%
  })
})

describe('underlyingFor', () => {
  it('maps wrappers to their underlying with a basis note', () => {
    expect(underlyingFor('wstETH')?.underlying).toBe('ETH')
    expect(underlyingFor('wstETH')?.wrapper).toBe(true)
    expect(underlyingFor('wstETH')?.basis).toMatch(/ETH price at the same % drop/)
    expect(underlyingFor('WBTC')?.underlying).toBe('BTC')
  })
  it('has no history for a vault share like sUSDS', () => {
    expect(underlyingFor('sUSDS')).toBeNull()
  })
})

describe('context odds seam', () => {
  it('7 d levels round down to 10/15/20 with the map labels', () => {
    expect(contextOddsLevel(0.09)).toBeNull()
    expect(contextOddsLevel(0.12)?.levelPct).toBe(10)
    expect(contextOddsLevel(0.16)).toMatchObject({
      levelPct: 15,
      label: 'calibrated, not proven better than alternatives',
    })
    expect(contextOddsLevel(0.46)).toMatchObject({ levelPct: 20, label: 'context · not a warning' })
  })
  it('ships no feed (no fake numbers)', () => {
    expect(CONTEXT_ODDS_FEED).toBeNull()
  })
})

describe('carryCost', () => {
  it('simple accrual over the horizon', () => {
    expect(carryCost(1000, 4.2, 7)).toBeCloseTo((1000 * 0.042 * 7) / 365, 10)
    expect(carryCost(0, 4.2, 30)).toBe(0)
  })
})

describe('generated data', () => {
  it('records its source', () => {
    expect(HISTORY_SOURCE.datasetsCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(HISTORY_SOURCE.countsSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(HISTORY_SOURCE.span).toBe('Sep 2017 – Oct 2026')
    expect(history.horizons).toEqual([1, 7, 30])
  })
})
