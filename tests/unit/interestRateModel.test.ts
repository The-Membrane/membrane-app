import { describe, it, expect } from 'vitest'
import {
  calculateCurrentInterestRate,
  getInterestRateModelPoints,
} from '@/components/ManagedMarkets/interestRateModel'

/**
 * The kinked interest-rate curve. Rates drive what borrowers actually pay, so
 * the branch boundaries (at/below/above the kink) and the degenerate inputs that
 * come back from chain data (nulls, non-numeric strings) are what matter here.
 */

const model = (over: Record<string, unknown> = {}) =>
  ({
    baseRate: 5,
    rateMax: 50,
    kinkPoint: 0.8,
    kinkMultiplier: 1,
    currentRatio: 0,
    ...over,
  }) as never

describe('calculateCurrentInterestRate', () => {
  it('scales linearly from 0 up to the base rate below the kink', () => {
    // Half way to the kink is half the base rate.
    expect(calculateCurrentInterestRate(model({ currentRatio: 0.4 }))).toBeCloseTo(2.5, 10)
    expect(calculateCurrentInterestRate(model({ currentRatio: 0 }))).toBe(0)
  })

  it('reaches exactly the base rate at the kink', () => {
    expect(calculateCurrentInterestRate(model({ currentRatio: 0.8 }))).toBeCloseTo(5, 10)
  })

  it('climbs from base toward max above the kink', () => {
    // Half way from kink(0.8) to 1.0 => base + (50-5)*0.5 = 27.5
    expect(calculateCurrentInterestRate(model({ currentRatio: 0.9 }))).toBeCloseTo(27.5, 10)
  })

  it('clamps at the max rate rather than exceeding it', () => {
    // A multiplier this large would blow past rateMax without the clamp.
    const rate = calculateCurrentInterestRate(model({ currentRatio: 0.99, kinkMultiplier: 100 }))
    expect(rate).toBe(50)
  })

  it('treats a full ratio as the max rate', () => {
    expect(calculateCurrentInterestRate(model({ currentRatio: 1 }))).toBeCloseTo(50, 10)
  })

  it('returns a flat base rate when there is no kink', () => {
    // parseFloat(undefined) is NaN, which the implementation reads as "no kink".
    expect(calculateCurrentInterestRate(model({ kinkPoint: undefined }))).toBe(5)
    expect(calculateCurrentInterestRate(model({ kinkPoint: undefined, currentRatio: 1 }))).toBe(5)
  })

  it('avoids dividing by a zero kink', () => {
    // ratio <= kink only when ratio is 0 here; the guard must not produce NaN.
    expect(calculateCurrentInterestRate(model({ kinkPoint: 0, currentRatio: 0 }))).toBe(0)
  })

  it('defaults a non-numeric multiplier to 1 rather than NaN', () => {
    expect(
      calculateCurrentInterestRate(model({ currentRatio: 0.9, kinkMultiplier: 'oops' })),
    ).toBeCloseTo(27.5, 10)
  })

  it('accepts numeric strings for the rates, as chain data supplies them', () => {
    expect(
      calculateCurrentInterestRate(model({ baseRate: '5', rateMax: '50', currentRatio: 0.4 })),
    ).toBeCloseTo(2.5, 10)
  })

  it('never returns NaN, even when every input is junk', () => {
    // Regression guard: the `kink === null` path used to return `base` before
    // the isNaN check ran, so a non-numeric baseRate leaked NaN into the UI and
    // rendered as "NaN%".
    expect(calculateCurrentInterestRate(model({ baseRate: 'abc', kinkPoint: undefined }))).toBe(0)
    expect(
      calculateCurrentInterestRate(model({ baseRate: 'abc', rateMax: 'def', currentRatio: 0.9 })),
    ).toBe(0)
  })

  it('defaults a missing ratio to zero', () => {
    expect(calculateCurrentInterestRate(model({ currentRatio: undefined }))).toBe(0)
  })
})

describe('getInterestRateModelPoints', () => {
  it('samples 51 evenly spaced points across the full utilisation range', () => {
    const { points } = getInterestRateModelPoints(model())
    expect(points).toHaveLength(51)
    expect(points[0].ratio).toBe(0)
    expect(points[50].ratio).toBe(1)
    expect(points[25].ratio).toBeCloseTo(0.5, 10)
  })

  it('reports whether the curve has a kink', () => {
    expect(getInterestRateModelPoints(model()).hasKink).toBe(true)
    expect(getInterestRateModelPoints(model({ kinkPoint: undefined })).hasKink).toBe(false)
  })

  it('produces a monotonically non-decreasing curve', () => {
    // A rate that dips as utilisation rises would be an economic bug.
    const { points } = getInterestRateModelPoints(model())
    for (let i = 1; i < points.length; i++) {
      expect(points[i].rate).toBeGreaterThanOrEqual(points[i - 1].rate)
    }
  })

  it('keeps every sampled rate within [0, max]', () => {
    const { points, max } = getInterestRateModelPoints(model({ kinkMultiplier: 100 }))
    for (const p of points) {
      expect(p.rate).toBeGreaterThanOrEqual(0)
      expect(p.rate).toBeLessThanOrEqual(max)
    }
  })

  it('is flat at the base rate when there is no kink', () => {
    const { points } = getInterestRateModelPoints(model({ kinkPoint: undefined }))
    expect(points.every((p) => p.rate === 5)).toBe(true)
  })
})
