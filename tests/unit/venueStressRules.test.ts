/**
 * venueStressRules — the reading rules the venue stress-history builder and the analog module
 * share (lib/position-sim/venueStressRules.ts). Review 2026-10-07 regressions:
 *   - the Aave USDC 00:00 UTC drain (one hourly reading at ~0 cash, gone the next) kept a
 *     72 h-gap util episode open for months: a TRANSIENT is not a trigger;
 *   - the Steakhouse vault's cash was the first-in-line walk while Aave/Spark are pro-rata:
 *     `metaMorphoCash` gives both, and the published cash is the pro-rata one.
 */
import { describe, expect, it } from 'vitest'

import {
  TRANSIENT_CONFIRM_H,
  UTIL_EPISODE_GAP_H,
  metaMorphoCash,
  stressFlags,
  utilClusters,
  withdrawableFraction,
  type UtilSeries,
} from '@/lib/position-sim/venueStressRules'

const H = 3600
const T0 = Date.UTC(2026, 4, 1) / 1000 // 2026-05-01T00:00Z

/** f values, one reading every `stepH`; supply constant. */
function series(fs: readonly (number | null)[], o: { stepH?: number; minSize?: number } = {}) {
  const supply = 1_000_000
  const s: UtilSeries = {
    t: fs.map((_, i) => T0 + i * (o.stepH ?? 1) * H),
    cash: fs.map((f) => (f === null ? null : f * supply)),
    supply: fs.map((f) => (f === null ? null : supply)),
    ...(o.minSize !== undefined ? { minSize: o.minSize } : {}),
  }
  return s
}

describe('utilClusters: transients are not triggers', () => {
  it('a daily one-reading drain at 00:00 UTC makes NO episode (it made one for months)', () => {
    // 120 days hourly at f 10% (util 90%), except the 00:00 reading each day at f ≈ 0
    const f = new Array<number>(120 * 24).fill(0.1)
    for (let d = 0; d < 120; d++) f[d * 24] = 0.00003
    const r = utilClusters(series(f), 0.95)
    expect(r.clusters).toEqual([])
    expect(r.transients).toHaveLength(120)
    expect(r.transients.every((t) => new Date(t * 1000).getUTCHours() === 0)).toBe(true)
  })

  it('stress held for two hourly readings is an episode; onset = the first', () => {
    const f = new Array<number>(48).fill(0.1)
    f[10] = 0.03
    f[11] = 0.02
    const r = utilClusters(series(f), 0.95)
    expect(r.transients).toEqual([])
    expect(r.clusters).toHaveLength(1)
    expect(r.clusters[0]).toMatchObject({
      first: T0 + 10 * H,
      last: T0 + 11 * H,
      n: 2,
      peakAt: T0 + 11 * H,
    })
    expect(r.clusters[0].peak).toBeCloseTo(0.98, 12)
  })

  it("a run's last reading is not a transient (the hour before is stressed)", () => {
    const f = new Array<number>(48).fill(0.1)
    f[5] = 0.01
    f[6] = 0.02
    f[7] = 0.04 // the next reading clears it, but 06:00 was stressed
    const r = utilClusters(series(f), 0.95)
    expect(r.clusters[0]).toMatchObject({ first: T0 + 5 * H, last: T0 + 7 * H, n: 3 })
  })

  it('a stressed reading with no reading an hour later is NOT a transient (cannot be told apart)', () => {
    // a 6-hourly grid: nothing confirms or clears it
    const coarse = utilClusters(series([0.1, 0.01, 0.1, 0.1], { stepH: 6 }), 0.95)
    expect(coarse.clusters).toHaveLength(1)
    expect(coarse.transients).toEqual([])
    // the data's last reading
    const atEnd = utilClusters(series([0.1, 0.1, 0.1, 0.01]), 0.95)
    expect(atEnd.clusters).toHaveLength(1)
    // an UNKNOWN reading an hour later does not clear it either
    const unknownNext = utilClusters(series([0.1, 0.01, null, 0.1]), 0.95)
    expect(unknownNext.clusters).toHaveLength(1)
  })

  it('a transient between two real stressed readings does not bridge or extend them', () => {
    const f = new Array<number>(400).fill(0.1)
    f[10] = 0.01
    f[11] = 0.01 // episode A: 10–11
    f[60] = 0 // transient, 49 h later
    f[100] = 0.02
    f[101] = 0.02 // 89 h after A's last reading: a NEW episode (the transient does not chain them)
    const r = utilClusters(series(f), 0.95)
    expect(r.transients).toEqual([T0 + 60 * H])
    expect(r.clusters.map((c) => [c.first, c.last])).toEqual([
      [T0 + 10 * H, T0 + 11 * H],
      [T0 + 100 * H, T0 + 101 * H],
    ])
    expect(UTIL_EPISODE_GAP_H).toBe(72)
    expect(TRANSIENT_CONFIRM_H).toBe(1)
  })

  it('materiality and the level: an immaterial supply never stresses; the level is validated', () => {
    const f = new Array<number>(10).fill(0.1)
    f[3] = 0
    f[4] = 0
    expect(utilClusters(series(f, { minSize: 2_000_000 }), 0.95).clusters).toEqual([])
    expect(utilClusters(series(f), 0.95).clusters).toHaveLength(1)
    expect(() => utilClusters(series(f), 0)).toThrow(/stressUtil/)
    expect(() => stressFlags(series(f), 1.2)).toThrow(/stressUtil/)
  })

  it('exactly the level is stressed; a paused reading is util 100%', () => {
    const f = [0.1, 0.05, 0.05, 0.1]
    expect(utilClusters(series(f), 0.95).clusters).toHaveLength(1)
    const paused: UtilSeries = { ...series([0.5, 0.5, 0.5, 0.5]), flags: [1, 5, 5, 1] }
    expect(utilClusters(paused, 0.95).clusters[0]).toMatchObject({ n: 2, peak: 1 })
    expect(withdrawableFraction(10, 100, 5)).toBe(0)
  })
})

describe('metaMorphoCash: first in line vs pro-rata', () => {
  const M = (owned: bigint, supply: bigint, borrow: bigint) => ({
    owned,
    totalSupplyAssets: supply,
    totalBorrowAssets: borrow,
  })

  it('liquid = Σ min(owned, idle); proRata = Σ owned × idle / supply', () => {
    const r = metaMorphoCash([
      M(400n, 1_000n, 900n), // idle 100: first in line 100, pro-rata 40
      M(50n, 200n, 100n), // idle 100: first in line 50, pro-rata 25
    ])
    expect(r.liquid).toBe(150n)
    expect(r.proRata).toBe(65n)
  })

  it('an idle market (no borrow) is fully withdrawable both ways; an empty one gives 0', () => {
    expect(metaMorphoCash([M(300n, 300n, 0n)])).toEqual({ liquid: 300n, proRata: 300n })
    expect(metaMorphoCash([M(0n, 0n, 0n)])).toEqual({ liquid: 0n, proRata: 0n })
    expect(metaMorphoCash([M(10n, 100n, 150n)])).toEqual({ liquid: 0n, proRata: 0n }) // over-borrowed
    expect(metaMorphoCash([])).toEqual({ liquid: 0n, proRata: 0n })
  })

  it('pro-rata never exceeds first in line, and is far below it when the vault is a large supplier', () => {
    // the vault owns 90% of a 95%-utilized market: first in line takes all 50, pro-rata 45
    const big = metaMorphoCash([M(900n, 1_000n, 950n)])
    expect(big).toEqual({ liquid: 50n, proRata: 45n })
    // the vault owns 10% of the same market: first in line takes all 50 (5× its pro-rata 5)
    const small = metaMorphoCash([M(100n, 1_000n, 950n)])
    expect(small).toEqual({ liquid: 50n, proRata: 5n })
    for (const m of [M(7n, 9n, 3n), M(1n, 3n, 1n), M(12n, 12n, 11n)]) {
      const x = metaMorphoCash([m])
      expect(x.proRata <= x.liquid).toBe(true)
    }
  })
})
