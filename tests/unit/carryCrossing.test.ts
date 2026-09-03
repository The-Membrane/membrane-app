import { describe, expect, it } from 'vitest'

import { EXIT_MODEL } from '@/components/Carry/fixtures'
import { buildCrossingSeries, crossingSizeUsd, exitCostPctRange, twoSigFigs } from '@/components/Carry/utils'

describe('crossing chart math', () => {
  it('exit cost is ~instant-only at small size and rises through the tiers', () => {
    const small = exitCostPctRange(EXIT_MODEL.alt, 50_000)
    const huge = exitCostPctRange(EXIT_MODEL.alt, 50_000_000)
    expect(small[1]).toBeLessThan(0.5) // small size never leaves the cheap tiers
    expect(huge[0]).toBeGreaterThan(small[1]) // big size is strictly costlier, even lo vs hi
    expect(huge[1]).toBeLessThanOrEqual(EXIT_MODEL.alt.strandedCostPct[1]) // bounded by the stranded cap
  })

  it('cost lo never exceeds hi, at any size', () => {
    for (const size of [1, 1000, 150_000, 450_000, 590_000, 5_000_000, 100_000_000]) {
      for (const v of [EXIT_MODEL.chosen, EXIT_MODEL.alt]) {
        const [lo, hi] = exitCostPctRange(v, size)
        expect(lo).toBeLessThanOrEqual(hi)
        expect(lo).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('the ranking inverts with size: alt wins small, chosen wins big (90d, mid-model)', () => {
    const at = (size: number, v: typeof EXIT_MODEL.alt) => {
      const grow = (v.aprPct * 90) / 365
      const [lo, hi] = exitCostPctRange(v, size)
      return grow - (lo + hi) / 2
    }
    expect(at(10_000, EXIT_MODEL.alt)).toBeGreaterThan(at(10_000, EXIT_MODEL.chosen))
    expect(at(10_000_000, EXIT_MODEL.alt)).toBeLessThan(at(10_000_000, EXIT_MODEL.chosen))
  })

  it('crossingSizeUsd finds the inversion and it is consistent with the model', () => {
    const x = crossingSizeUsd(EXIT_MODEL.chosen, EXIT_MODEL.alt, 90)
    expect(x).not.toBeNull()
    // The mid-model net values are equal (within tolerance) at the crossing.
    const net = (v: typeof EXIT_MODEL.alt) => {
      const [lo, hi] = exitCostPctRange(v, x!)
      return (v.aprPct * 90) / 365 - (lo + hi) / 2
    }
    expect(Math.abs(net(EXIT_MODEL.alt) - net(EXIT_MODEL.chosen))).toBeLessThan(1e-6)
  })

  it('series bands always bracket their midline, for every venue and tier', () => {
    const points = buildCrossingSeries(EXIT_MODEL.chosen, EXIT_MODEL.alt, 10_000, 90)
    expect(points.length).toBeGreaterThan(10)
    for (const p of points) {
      for (const mult of [1, 10, 100]) {
        for (const side of ['chosen', 'alt']) {
          const mid = p[`${side}${mult}`] as number
          const [lo, hi] = p[`${side}Band${mult}`] as [number, number]
          expect(lo).toBeLessThanOrEqual(mid)
          expect(mid).toBeLessThanOrEqual(hi)
        }
      }
    }
  })

  it('twoSigFigs rounds headline numbers honestly', () => {
    expect(twoSigFigs(587_432)).toBe(590_000)
    expect(twoSigFigs(1_234)).toBe(1_200)
    expect(twoSigFigs(0)).toBe(0)
  })
})
