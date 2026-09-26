import { describe, expect, it } from 'vitest'

import {
  CAPACITY_PRESETS_PCT,
  capacityAt,
  combineMarkets,
  isMonotone,
  presetReadings,
  costAtSize,
  costToSlider,
  sliderToCost,
  SLIDER_STEPS,
  CAPACITY_SLIDER_MIN_PCT,
  CAPACITY_SLIDER_MAX_PCT,
  type CurvePoint,
} from '@/lib/venueCapacity/capacityCurve'
// The recorder's pure math — same code that writes the rows.
import { buildCurve, capacityAtCost, costPct, flatFeeCurve, COST_LEVELS_PCT, MAX_QUOTES_PER_LEVEL } from '@/scripts/lib/depthCurve.mjs'

const pts = (xs: Array<[number, number | null]>): CurvePoint[] => xs.map(([costPct, capacityUsd]) => ({ costPct, capacityUsd }))

describe('combineMarkets — sum across independent pools', () => {
  it('sums capacities level by level', () => {
    const a = { market: 'A', points: pts([[0.5, 10], [1, 20], [5, 30]]) }
    const b = { market: 'B', points: pts([[0.5, 1], [1, 2], [5, 3]]) }
    expect(combineMarkets([a, b])).toEqual(pts([[0.5, 11], [1, 22], [5, 33]]))
  })
  it('a null in any market makes that venue level null, not a partial sum', () => {
    const a = { market: 'A', points: pts([[0.5, 10], [1, null]]) }
    const b = { market: 'B', points: pts([[0.5, 1], [1, 2]]) }
    expect(combineMarkets([a, b])).toEqual(pts([[0.5, 11], [1, null]]))
  })
  it('a level one market did not quote is null', () => {
    const a = { market: 'A', points: pts([[0.5, 10], [1, 20]]) }
    const b = { market: 'B', points: pts([[0.5, 1]]) }
    expect(combineMarkets([a, b])[1]).toEqual({ costPct: 1, capacityUsd: null })
  })
  it('no markets, no curve', () => expect(combineMarkets([])).toEqual([]))
  it('a sum of monotone curves is monotone', () => {
    const a = { market: 'A', points: pts([[0.1, 1], [1, 5], [10, 9]]) }
    const b = { market: 'B', points: pts([[0.1, 0], [1, 3], [10, 3]]) }
    expect(isMonotone(combineMarkets([a, b]))).toBe(true)
  })
})

describe('isMonotone', () => {
  it('skips nulls, rejects a fall', () => {
    expect(isMonotone(pts([[0.1, 1], [0.5, null], [1, 2]]))).toBe(true)
    expect(isMonotone(pts([[0.1, 3], [1, 2]]))).toBe(false)
  })
})

describe('capacityAt — quoted, interpolated, never extrapolated', () => {
  const c = pts([[0.1, 100], [0.5, 200], [1, 400], [5, null], [10, 900]])
  it('on a level: quoted', () => expect(capacityAt(c, 1)).toEqual({ kind: 'quoted', costPct: 1, capacityUsd: 400 }))
  it('between levels: linear in cost, flagged, with the bracket', () => {
    const r = capacityAt(c, 0.75)
    expect(r.kind).toBe('interpolated')
    if (r.kind !== 'interpolated') return
    expect(r.capacityUsd).toBeCloseTo(300)
    expect([r.lowerUsd, r.upperUsd, r.fromPct, r.toPct]).toEqual([200, 400, 0.5, 1])
  })
  it('below the first or past the last quoted level: null', () => {
    expect(capacityAt(c, 0.05)).toEqual({ kind: 'below-range', costPct: 0.05, capacityUsd: null })
    expect(capacityAt(c, 12)).toEqual({ kind: 'beyond-range', costPct: 12, capacityUsd: null })
  })
  it('next to a null level: unavailable, never 0', () => {
    expect(capacityAt(c, 5).capacityUsd).toBeNull()
    expect(capacityAt(c, 3)).toEqual({ kind: 'unavailable', costPct: 3, capacityUsd: null })
    expect(capacityAt(c, 7).kind).toBe('unavailable')
  })
  it('the interpolated value stays inside its bracket', () => {
    for (let x = 0.1; x <= 1; x += 0.01) {
      const r = capacityAt(c, x)
      if (r.kind === 'interpolated') {
        expect(r.capacityUsd).toBeGreaterThanOrEqual(r.lowerUsd)
        expect(r.capacityUsd).toBeLessThanOrEqual(r.upperUsd)
      }
    }
  })
  it('empty curve: unavailable', () => expect(capacityAt([], 1).kind).toBe('unavailable'))
  it('presets are 0.5 / 1 / 5 and read the curve', () => {
    expect([...CAPACITY_PRESETS_PCT]).toEqual([0.5, 1, 5])
    expect(presetReadings(c).map((r) => r.capacityUsd)).toEqual([200, 400, null])
  })
})

describe('depthCurve.mjs — bisection on quotes', () => {
  // A toy pool: cost% grows linearly with size — 0.1% per $1M.
  const linear = async (s: number) => (s / 1e6) * 0.1

  it('costPct = 1 - received/given, null on a bad read', () => {
    expect(costPct(100, 99)).toBeCloseTo(1)
    expect(costPct(100, 101)).toBeCloseTo(-1)
    expect(costPct(0, 1)).toBeNull()
    expect(costPct(100, NaN)).toBeNull()
  })

  it('finds the largest feasible size within tolerance, never above it, in ≤ the quote budget', async () => {
    const r = await capacityAtCost(linear, { targetPct: 1, hi: 50e6 })
    expect(r.quotes).toBeLessThanOrEqual(MAX_QUOTES_PER_LEVEL)
    expect(r.capacityUsd!).toBeLessThanOrEqual(10e6)
    expect(10e6 - r.capacityUsd!).toBeLessThan(50e6 / 2 ** (MAX_QUOTES_PER_LEVEL - 1) + 1)
  })

  it('whole reserve feasible: capacity = hi in one quote', async () => {
    const r = await capacityAtCost(async () => 0, { targetPct: 1, hi: 5e6 })
    expect(r).toEqual({ capacityUsd: 5e6, quotes: 1 })
  })

  it('a reverting quote makes the level null, never 0', async () => {
    const r = await capacityAtCost(async (s: number) => (s > 3e6 ? null : 0.5), { targetPct: 0.1, hi: 50e6 })
    expect(r.capacityUsd).toBeNull()
  })

  it('buildCurve is monotone by construction and restarts after a null level', async () => {
    let calls = 0
    const flaky = async (s: number) => {
      calls++
      return calls === 1 ? null : linear(s)
    }
    const c = await buildCurve(flaky, 50e6)
    expect(c.points.map((p: CurvePoint) => p.costPct)).toEqual([...COST_LEVELS_PCT])
    expect(c.points[0].capacityUsd).toBeNull()
    expect(c.points.slice(1).every((p: CurvePoint) => p.capacityUsd !== null)).toBe(true)
    expect(isMonotone(c.points)).toBe(true)
  })

  it('a PSM buffer is flat at the fee up to the buffer, then nothing', () => {
    expect(flatFeeCurve(0, 4e9, [0.1, 1])).toEqual(pts([[0.1, 4e9], [1, 4e9]]))
    expect(flatFeeCurve(0.5, 4e9, [0.1, 1])).toEqual(pts([[0.1, 0], [1, 4e9]]))
    expect(flatFeeCurve(NaN, 4e9, [1])).toEqual(pts([[1, null]]))
  })
})

describe('costAtSize — cost of exiting a given size, never extrapolated', () => {
  const c = pts([[0.1, 100], [0.5, 200], [1, 400], [10, 900]])
  it('within the first level: cost at most that level', () => {
    expect(costAtSize(c, 50)).toEqual({ kind: 'within-first', sizeUsd: 50, costPct: 0.1, atMostPct: 0.1 })
    expect(costAtSize(c, 0).kind).toBe('within-first')
  })
  it('exactly on a quoted capacity', () => expect(costAtSize(c, 400)).toEqual({ kind: 'quoted', sizeUsd: 400, costPct: 1 }))
  it('between capacities: linear in capacity, bracketed', () => {
    const r = costAtSize(c, 300)
    expect(r.kind).toBe('interpolated')
    if (r.kind !== 'interpolated') return
    expect(r.costPct).toBeCloseTo(0.75)
    expect([r.fromPct, r.toPct]).toEqual([0.5, 1])
  })
  it('past the last quoted capacity: "beyond quoted depth", no number', () => {
    expect(costAtSize(c, 901)).toEqual({ kind: 'beyond-quoted-depth', sizeUsd: 901, costPct: null, lastQuotedUsd: 900, lastQuotedPct: 10 })
  })
  it('a null on the way: unavailable', () => {
    expect(costAtSize(pts([[0.1, 100], [0.5, null], [1, 400]]), 300).kind).toBe('unavailable')
    expect(costAtSize(pts([[0.1, null]]), 1).kind).toBe('unavailable')
    expect(costAtSize([], 1).kind).toBe('unavailable')
    expect(costAtSize(c, NaN).kind).toBe('unavailable')
  })
  it('a flat PSM curve: any size up to the buffer is within the first level', () => {
    const flat = pts([[0.1, 4e9], [0.5, 4e9], [10, 4e9]])
    expect(costAtSize(flat, 51_000).kind).toBe('within-first')
    expect(costAtSize(flat, 5e9).kind).toBe('beyond-quoted-depth')
  })
  it('round-trips with capacityAt on quoted points', () => {
    for (const p of c) {
      const r = costAtSize(c, p.capacityUsd!)
      expect(r.costPct).toBe(p.costPct)
    }
  })
})

describe('slider — log scale over 0.1%..10%', () => {
  it('ends map to the range ends', () => {
    expect(sliderToCost(0)).toBeCloseTo(CAPACITY_SLIDER_MIN_PCT)
    expect(sliderToCost(SLIDER_STEPS)).toBeCloseTo(CAPACITY_SLIDER_MAX_PCT)
  })
  it('snaps onto a quoted level when close, and round-trips', () => {
    expect(sliderToCost(costToSlider(1), [0.5, 1, 5])).toBe(1)
    expect(sliderToCost(costToSlider(5) + 1, [0.5, 1, 5])).toBe(5)
    expect(sliderToCost(costToSlider(2.5), [0.5, 1, 5])).toBeCloseTo(2.5, 1)
  })
})
