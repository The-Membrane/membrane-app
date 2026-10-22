import { describe, expect, it } from 'vitest'

import { BASELINE_PATHS, baselineFan, byDay, quantile, type SeriesPoint } from '@/lib/position/baselineFan'

const DAY = 86_400
const NOW = 1_800_000_000
/** One point a day for `n` days ending at NOW, value f(i) (i = 0 oldest). */
const daily = (n: number, f: (i: number) => number): SeriesPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: NOW - (n - 1 - i) * DAY, v: f(i) }))

describe('baselineFan', () => {
  it('is pending, with the day count, when the series does not cover 12 months', () => {
    const b = baselineFan(daily(91, () => 1), 1, NOW, 'diff')
    expect(b).toEqual({ ok: false, reason: '91 days of this series (needs 12 months)' })
  })

  it('is pending for proportional moves from a level of 0', () => {
    expect(baselineFan(daily(365, () => 1), 0, NOW, 'ratio').ok).toBe(false)
    expect(baselineFan(daily(365, () => 1), null, NOW, 'ratio').ok).toBe(false)
  })

  it('a flat series gives a fan collapsed on today’s level, the expected line', () => {
    const b = baselineFan(daily(365, () => 7), 3, NOW, 'diff')
    if (!b.ok) throw new Error(b.reason)
    expect(b.steps).toHaveLength(8)
    for (const s of b.steps) expect([s.p05, s.p25, s.p75, s.p95]).toEqual([3, 3, 3, 3])
    expect(b.paths).toHaveLength(BASELINE_PATHS)
    for (const p of b.paths) expect(p).toEqual([3, 3, 3, 3, 3, 3, 3, 3])
  })

  it('diff: ranges are today’s level plus the real h-day moves', () => {
    // +1 a day: every h-day move is +h.
    const b = baselineFan(daily(365, (i) => i), 10, NOW, 'diff')
    if (!b.ok) throw new Error(b.reason)
    expect(b.steps[3]).toMatchObject({ h: 3, p05: 13, p95: 13, n: 362 })
    expect(b.paths[0]).toEqual([10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('ratio: ranges are today’s level times the real h-day ratios, and widen with h', () => {
    // Alternating 100 / 110: one-day ratios are 1.1 or 1/1.1; two-day ratios are 1.
    const b = baselineFan(daily(365, (i) => (i % 2 ? 110 : 100)), 50, NOW, 'ratio')
    if (!b.ok) throw new Error(b.reason)
    expect(b.steps[1].p95).toBeCloseTo(55, 6)
    expect(b.steps[1].p05).toBeCloseTo(50 / 1.1, 6)
    expect(b.steps[2].p05).toBeCloseTo(50, 6)
    expect(b.steps[2].p95).toBeCloseTo(50, 6)
  })

  it('skips moves from a zero day in proportion, and needs enough moves per horizon', () => {
    const b = baselineFan(daily(365, (i) => (i % 3 ? 5 : 0)), 5, NOW, 'ratio')
    expect(b.ok).toBe(true)
    const sparse = baselineFan(daily(365, (i) => (i < 200 ? 0 : 5)), 5, NOW, 'ratio')
    expect(sparse).toMatchObject({ ok: false, reason: expect.stringMatching(/1-day moves/) })
  })
})

describe('helpers', () => {
  it('byDay keeps the newest point of each UTC day inside the window', () => {
    const d = byDay(
      [
        { t: 10 * DAY + 1, v: 1 },
        { t: 10 * DAY + 5, v: 2 },
        { t: 11 * DAY, v: 3 },
        { t: 30 * DAY, v: 9 },
      ],
      0,
      20 * DAY,
    )
    expect([...d.entries()]).toEqual([
      [10, 2],
      [11, 3],
    ])
  })
  it('quantile interpolates', () => {
    expect(quantile([0, 10], 0.25)).toBe(2.5)
    expect(Number.isNaN(quantile([], 0.5))).toBe(true)
  })
})
