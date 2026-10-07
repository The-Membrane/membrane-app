/**
 * setAndForget — the helpers behind the set-and-forget LTV sim. Paths and quantiles are
 * checked by hand and against brute force; every threshold is checked against a plain
 * whole-grid scan of the SAME engine (stressGrid runStress), so the bisection and the pruning
 * are tested, not the mechanics.
 *
 * Analytic anchors (levered_long, delayed, line M, band 4%, start LTV ℓ), from
 * tests/unit/frontier.test.ts: a persistent −d drop sells for ℓ > M(1 − d); a −d dip that
 * recovers inside the 8h window sells only past the band, ℓ > 1.04 M(1 − d).
 */
import { describe, expect, it } from 'vitest'

import type { PriceGrid } from '@/lib/position-sim/drawdowns'
import {
  SET_AND_FORGET_COLLATERAL_USD,
  SUB_STEP_SECONDS,
  caseBorrowCap,
  casePosition,
  dailyToHourly,
  LOWER_BOUND_SLACK,
  floorTo,
  healthFactor,
  hourlyPathFromGrid,
  isSold,
  loopLeverage,
  multiplyPath,
  noBreachBound,
  pathCoverage,
  runCase,
  solveLowTail,
  solveStartLtv,
  tallyAtLtv,
  tailK,
  tailQuantile,
  windowMinRatios,
  windowReplay,
  windowTrough,
  type HourlyPath,
  type SetAndForgetCase,
} from '@/lib/position-sim/setAndForget'
import type { PriceShape } from '@/lib/position-sim/stressGrid'

// ------------------------------------------------------------------ fixtures

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A random hourly path: closes on a log random walk, lows a random dip under min(open, close). */
function randomPath(seed: number, n: number, vol = 0.03, gaps = 0): HourlyPath {
  const rnd = mulberry32(seed)
  const close = new Float64Array(n)
  const low = new Float64Array(n)
  let px = 100
  for (let i = 0; i < n; i++) {
    const prev = px
    px *= Math.exp((rnd() - 0.5) * 2 * vol)
    close[i] = px
    low[i] = Math.min(prev, px) * (1 - rnd() * vol)
    if (gaps > 0 && i > 0 && rnd() < gaps) {
      close[i] = NaN
      low[i] = NaN
    }
  }
  return { id: `rnd-${seed}`, startTs: 0, close, low }
}

/** A path from explicit closes (lows = closes unless given). */
function pathOf(closes: number[], lows?: number[]): HourlyPath {
  return {
    id: 'fixed',
    startTs: 0,
    close: Float64Array.from(closes),
    low: Float64Array.from(lows ?? closes),
  }
}

const LL: SetAndForgetCase = { line: 0.8, membraneClass: 'delayed', tradeShape: 'levered_long' }

/** The first start LTV on a 0.001 grid that sells — plain scan, no bisection. */
function scanEdge(c: SetAndForgetCase, shape: PriceShape): number | null {
  const cap = caseBorrowCap(c)
  for (let m = 1; m <= Math.round(cap * 1000); m++) {
    if (isSold(runCase(c, shape, m / 1000))) return m / 1000
  }
  return null
}

// ------------------------------------------------------------------ paths

describe('hourlyPathFromGrid', () => {
  it('maps missing to NaN and a missing low to the close', () => {
    const g: PriceGrid = {
      startTs: 1000,
      stepSeconds: 3600,
      close: [10, null, 12, 13],
      low: [9, 8, null, 0],
    }
    const p = hourlyPathFromGrid('t', g)
    expect([...p.close]).toEqual([10, NaN, 12, 13])
    expect([...p.low]).toEqual([9, NaN, 12, 13])
    expect(p.startTs).toBe(1000)
  })

  it('refuses a non-hourly grid', () => {
    expect(() => hourlyPathFromGrid('t', { startTs: 0, stepSeconds: 60, close: [1, 2] })).toThrow()
  })
})

describe('dailyToHourly', () => {
  it('spreads each day over its 24 hours, carries a missing day, never back-fills', () => {
    const daily = [null, 1.1, null, 1.3]
    const h = dailyToHourly(daily, 0, 0, 24 * 4 + 2)
    expect(Number.isNaN(h[0])).toBe(true)
    expect(Number.isNaN(h[23])).toBe(true)
    expect(h[24]).toBe(1.1)
    expect(h[47]).toBe(1.1)
    expect(h[48]).toBe(1.1) // day 2 missing: carried
    expect(h[72]).toBe(1.3)
    expect(h[97]).toBe(1.3) // past the last day: carried
  })

  it('aligns an hourly grid that starts mid-day', () => {
    const h = dailyToHourly([2, 3], 0, 20 * 3600, 6)
    expect([...h]).toEqual([2, 2, 2, 2, 3, 3])
  })
})

describe('multiplyPath', () => {
  it('multiplies closes, and lows by the factor low when given', () => {
    const base = pathOf([100, 200], [90, 180])
    const p = multiplyPath('x', base, { close: [1.1, 1.2], low: [1.0, NaN] })
    expect(p.close[0]).toBeCloseTo(110, 10)
    expect(p.close[1]).toBeCloseTo(240, 10)
    expect(p.low[0]).toBeCloseTo(90, 10)
    expect(p.low[1]).toBeCloseTo(180 * 1.2, 10) // NaN factor low → factor close
  })

  it('propagates a missing factor as NaN', () => {
    const p = multiplyPath('x', pathOf([100, 200]), { close: [NaN, 2] })
    expect(Number.isNaN(p.close[0])).toBe(true)
    expect(p.close[1]).toBe(400)
  })
})

describe('pathCoverage', () => {
  it('finds the first and last observed close', () => {
    expect(pathCoverage(pathOf([NaN, 1, NaN, 2, NaN]))).toEqual({ fromIndex: 1, toIndex: 3 })
    expect(pathCoverage(pathOf([NaN, NaN]))).toBeNull()
  })
})

describe('windowReplay', () => {
  const p = pathOf([100, 110, 90, 95], [99, 105, 80, 92])

  it("'low-close' interleaves each later hour's low then close at 1800 s, relative to the entry close", () => {
    const s = windowReplay(p, 0, 3)!
    expect(s.kind).toBe('replay')
    if (s.kind !== 'replay') return
    expect(s.stepSeconds).toBe(SUB_STEP_SECONDS)
    expect(s.ratios).toEqual([1, 1.05, 1.1, 0.8, 0.9, 0.92, 0.95])
  })

  it("'close' walks closes at 3600 s", () => {
    const s = windowReplay(p, 1, 2, 'close')!
    if (s.kind !== 'replay') throw new Error('not a replay')
    expect(s.stepSeconds).toBe(3600)
    expect(s.ratios).toEqual([1, 90 / 110, 95 / 110])
  })

  it('is null past the end or without an entry / exit close; inner gaps stay null', () => {
    expect(windowReplay(p, 1, 3)).toBeNull()
    expect(windowReplay(pathOf([NaN, 1, 2]), 0, 2)).toBeNull()
    expect(windowReplay(pathOf([1, 2, NaN]), 0, 2)).toBeNull()
    const s = windowReplay(pathOf([1, NaN, 2]), 0, 2)!
    if (s.kind !== 'replay') throw new Error('not a replay')
    expect(s.ratios).toEqual([1, null, null, 2, 2])
  })
})

describe('windowMinRatios', () => {
  it('matches the minimum of every replay, on random paths with gaps (both resolutions)', () => {
    for (const seed of [1, 2, 3]) {
      const p = randomPath(seed, 400, 0.04, 0.05)
      for (const res of ['low-close', 'close'] as const) {
        for (const hours of [1, 7, 48]) {
          const m = windowMinRatios(p, hours, res)
          for (let s = 0; s < p.close.length; s++) {
            const shape = windowReplay(p, s, hours, res)
            if (!shape || shape.kind !== 'replay') {
              expect(Number.isNaN(m[s])).toBe(true)
              continue
            }
            let mn = 1
            for (const r of shape.ratios) if (r != null && r < mn) mn = r
            expect(m[s]).toBeCloseTo(mn, 12)
          }
        }
      }
    }
  })

  it('caps at 1 when the window only rises', () => {
    const m = windowMinRatios(pathOf([100, 101, 102, 103]), 2)
    expect(m[0]).toBe(1)
    expect(m[1]).toBe(1)
    expect(Number.isNaN(m[2])).toBe(true)
  })
})

describe('windowTrough', () => {
  it('finds the lowest walked point and its ratio', () => {
    const p = pathOf([100, 110, 90, 95], [99, 105, 80, 92])
    expect(windowTrough(p, 0, 3)).toEqual({ index: 2, ratio: 0.8 })
    expect(windowTrough(p, 0, 3, 'close')).toEqual({ index: 2, ratio: 0.9 })
  })
})

// ------------------------------------------------------------------ case + solve

describe('casePosition', () => {
  // UPDATED 2026-10-06: 'stressed' (×0.5, named) → the measured 'aave-usdc-typical'; a
  // custom multiple (a mechanics fixture) now passes through too.
  it('deploys the whole debt for carry and names its exit capacity', () => {
    const pos = casePosition(
      {
        line: 0.8,
        membraneClass: 'delayed',
        tradeShape: 'carry',
        exitCapacityPreset: 'aave-usdc-typical',
      },
      0.5,
    )
    expect(pos.collateralUsd).toBe(SET_AND_FORGET_COLLATERAL_USD)
    expect(pos.debtUsd).toBe(50_000)
    expect(pos.deployedUsd).toBe(50_000)
    expect(pos.exitCapacityPreset).toBe('aave-usdc-typical')
    expect(pos.exitCapacityMult).toBeUndefined()
    const custom = casePosition(
      { line: 0.8, membraneClass: 'delayed', tradeShape: 'carry', exitCapacityMult: 0.5 },
      0.5,
    )
    expect(custom.exitCapacityMult).toBe(0.5)
    expect(custom.exitCapacityPreset).toBeUndefined()
    expect(casePosition({ ...LL, exitCapacityMult: 0.5 }, 0.5).exitCapacityMult).toBeUndefined()
  })

  it('deploys nothing for levered_long and keeps the engine floor unless given', () => {
    const pos = casePosition(LL, 0.4)
    expect(pos.deployedUsd).toBeUndefined()
    expect(pos.exitCapacityPreset).toBeUndefined()
    expect(pos.debtMinimumUsd).toBeUndefined()
    expect(casePosition({ ...LL, debtMinimumUsd: 100 }, 0.4).debtMinimumUsd).toBe(100)
  })

  it('caps the start LTV at the borrow cap, line − 3pp', () => {
    expect(caseBorrowCap(LL)).toBeCloseTo(0.77, 12)
  })
})

describe('solveStartLtv', () => {
  /** Entry 100, then `holdHours` at 100(1 − d), then back to 100 (or held when recover=false). */
  function dip(d: number, holdHours: number, recover: boolean): HourlyPath {
    const closes = [100, ...new Array<number>(holdHours).fill(100 * (1 - d))]
    for (let i = 0; i < 30; i++) closes.push(recover ? 100 : 100 * (1 - d))
    return pathOf(closes)
  }

  it('a persistent −30% drop: the edge is the line, M(1 − d) = 56%', () => {
    const p = dip(0.3, 40, false)
    const shape = windowReplay(p, 0, 60)!
    const sol = solveStartLtv(LL, shape)
    expect(sol.status).toBe('found')
    expect(sol.safe).toBeLessThanOrEqual(0.56 + 1e-9)
    expect(sol.triggersAt!).toBeGreaterThan(0.56)
    expect(sol.triggersAt! - sol.safe).toBeLessThanOrEqual(2e-4 + 1e-12)
    expect(sol.at?.saleReason).toBe('expiry')
  })

  it('a −30% dip that recovers inside 8h: the window holds it to the band, 1.04 M(1 − d)', () => {
    const p = dip(0.3, 4, true)
    const shape = windowReplay(p, 0, 30)!
    const sol = solveStartLtv(LL, shape)
    expect(sol.safe).toBeGreaterThan(0.56)
    expect(sol.safe).toBeLessThanOrEqual(0.5824 + 1e-9)
    expect(sol.triggersAt!).toBeGreaterThan(0.5824)
    expect(sol.at?.saleReason).toBe('band')
    // Without the window the same dip sells at the line.
    const nd = solveStartLtv({ ...LL, membraneClass: 'no-delay' }, shape)
    expect(nd.triggersAt!).toBeGreaterThan(0.56)
    expect(nd.safe).toBeLessThanOrEqual(0.56 + 1e-9)
  })

  it('agrees with a whole-grid engine scan on random windows (delayed, no-delay, carry)', () => {
    const cases: SetAndForgetCase[] = [
      LL,
      { ...LL, membraneClass: 'no-delay' },
      // UPDATED 2026-10-06: the named 'stressed' (×0.5) / 'kelp-lock' (×0.1) cases became a
      // custom ×0.5 (same walk as before), the measured Aave USDC typical (×0.1119) and a
      // measured LOCKED analog (Spark DAI worst: ×0.0068 behind a 78 h lock — the lock path).
      { line: 0.8, membraneClass: 'delayed', tradeShape: 'carry', exitCapacityMult: 0.5 },
      {
        line: 0.8,
        membraneClass: 'delayed',
        tradeShape: 'carry',
        exitCapacityPreset: 'aave-usdc-typical',
      },
      {
        line: 0.8,
        membraneClass: 'delayed',
        tradeShape: 'carry',
        exitCapacityPreset: 'spark-dai-worst',
      },
    ]
    for (const seed of [11, 12, 13, 14]) {
      const p = randomPath(seed, 120, 0.05)
      const shape = windowReplay(p, 0, 96)!
      const lb = noBreachBound(0.8, windowMinRatios(p, 96)[0])
      for (const c of cases) {
        const sol = solveStartLtv(c, shape, { lowerBound: lb })
        const edge = scanEdge(c, shape)
        expect(sol.boundViolated).toBe(false)
        expect(sol.safe).toBeGreaterThanOrEqual(lb)
        if (edge === null) {
          expect(sol.status).toBe('cap')
        } else {
          // The scan's first selling grid point lies in (safe, safe + tol + grid step].
          expect(sol.status).toBe('found')
          expect(edge).toBeGreaterThan(sol.safe)
          expect(edge).toBeLessThanOrEqual(sol.triggersAt! + 0.001 + 1e-12)
        }
      }
    }
  })

  it('the window never lowers the edge: delayed ≥ no-delay on random windows', () => {
    for (let seed = 20; seed < 32; seed++) {
      const p = randomPath(seed, 200, 0.04)
      const shape = windowReplay(p, 0, 180)!
      const d = solveStartLtv(LL, shape)
      const n = solveStartLtv({ ...LL, membraneClass: 'no-delay' }, shape)
      expect(d.safe).toBeGreaterThanOrEqual(n.safe - 2e-4)
    }
  })

  it('carry at the optimistic preset recalls whatever it needs: cap-bound on every window', () => {
    const c: SetAndForgetCase = {
      line: 0.8,
      membraneClass: 'delayed',
      tradeShape: 'carry',
      exitCapacityPreset: 'optimistic',
    }
    for (const seed of [40, 41, 42]) {
      const p = randomPath(seed, 200, 0.06)
      const sol = solveStartLtv(c, windowReplay(p, 0, 180)!)
      expect(sol.status).toBe('cap')
      expect(sol.safe).toBeCloseTo(0.77, 12)
    }
  })

  it('carry with a frozen venue is the levered_long answer (nothing to recall)', () => {
    const frozen: SetAndForgetCase = {
      line: 0.8,
      membraneClass: 'delayed',
      tradeShape: 'carry',
      exitCapacityPreset: 'frozen',
    }
    for (const seed of [50, 51, 52]) {
      const p = randomPath(seed, 200, 0.05)
      const shape = windowReplay(p, 0, 180)!
      expect(solveStartLtv(frozen, shape).safe).toBe(solveStartLtv(LL, shape).safe)
    }
  })

  it('levered_long scales with the line: ℓ*/line does not depend on the line', () => {
    for (const seed of [60, 61]) {
      const p = randomPath(seed, 200, 0.05)
      const shape = windowReplay(p, 0, 180)!
      const a = solveStartLtv(LL, shape, { tol: 1e-6 })
      const b = solveStartLtv({ ...LL, line: 0.72 }, shape, { tol: 1e-6 })
      if (a.status === 'found' && b.status === 'found') {
        expect(a.safe / 0.8).toBeCloseTo(b.safe / 0.72, 4)
      }
    }
  })

  it('a wrong upper hint costs runs, never the answer', () => {
    const p = randomPath(70, 200, 0.05)
    const shape = windowReplay(p, 0, 180)!
    const plain = solveStartLtv(LL, shape)
    const hinted = solveStartLtv(LL, shape, { upperHint: 0.01 })
    expect(Math.abs(hinted.safe - plain.safe)).toBeLessThanOrEqual(2e-4)
  })
})

describe('noBreachBound', () => {
  it('is line × min ratio shaved by the slack, and the engine never sells there', () => {
    expect(noBreachBound(0.8, 0.5)).toBeCloseTo(0.4 * (1 - LOWER_BOUND_SLACK), 15)
    // No-delay sells on any crossing, so it is the strict test of the bound; flat forward-
    // filled troughs (gaps) are where the rounding used to bite.
    for (let seed = 80; seed < 100; seed++) {
      const p = randomPath(seed, 200, 0.05, 0.1)
      const m = windowMinRatios(p, 180)
      for (const s of [0, 5, 10]) {
        const shape = windowReplay(p, s, 180)
        if (!shape) continue
        const lb = noBreachBound(0.8, m[s])
        for (const membraneClass of ['delayed', 'no-delay'] as const) {
          const r = runCase({ ...LL, membraneClass }, shape, lb)
          expect(r.outcome).toBe('no_breach')
        }
      }
    }
  })
})

// ------------------------------------------------------------------ tail

describe('solveLowTail', () => {
  it('returns exactly the k smallest values while solving fewer than all', () => {
    const rnd = mulberry32(99)
    const n = 2000
    const keys = Array.from({ length: n }, (_, i) => i)
    const value = keys.map(() => rnd())
    // A valid lower bound: at most the value, loosely correlated with it.
    const bound = value.map((v) => v * (0.5 + 0.5 * rnd()))
    const k = tailK(n)
    let solves = 0
    const t = solveLowTail(
      keys,
      (key) => bound[key],
      k,
      (key) => {
        solves++
        return { safe: value[key], result: key }
      },
    )
    const brute = value
      .slice()
      .sort((a, b) => a - b)
      .slice(0, k)
    expect(t.lowest).toEqual(brute)
    expect(t.solvedCount).toBe(solves)
    expect(solves).toBeLessThan(n)
  })

  it('k = n solves everything', () => {
    const t = solveLowTail(
      [0, 1, 2],
      () => 0,
      3,
      (key) => ({ safe: 3 - key, result: key }),
    )
    expect(t.lowest).toEqual([1, 2, 3])
    expect(t.solvedCount).toBe(3)
  })
})

describe('tailQuantile / tailK', () => {
  it('reads the ⌊f·n⌋-th smallest: at most ⌊f·n⌋ starts sit strictly under it', () => {
    const n = 250
    const lowest = Array.from({ length: tailK(n) }, (_, i) => 0.2 + i / 1000)
    expect(tailK(n)).toBe(13) // ⌊0.05 × 250⌋ + 1
    expect(tailQuantile(lowest, n, 0)).toBe(0.2)
    expect(tailQuantile(lowest, n, 0.01)).toBeCloseTo(0.202, 12) // ⌊2.5⌋ = 2
    expect(tailQuantile(lowest, n, 0.05)).toBeCloseTo(0.212, 12) // ⌊12.5⌋ = 12
    const q = tailQuantile(lowest, n, 0.05)
    expect(lowest.filter((v) => v < q).length).toBeLessThanOrEqual(Math.floor(0.05 * n))
  })

  it('refuses to read past what was solved', () => {
    expect(() => tailQuantile([0.1], 1000, 0.05)).toThrow()
  })
})

describe('small helpers', () => {
  it('floorTo rounds toward risk without flooring an exact grid value', () => {
    expect(floorTo(0.26139, 3)).toBe(0.261)
    expect(floorTo(0.77, 2)).toBe(0.77)
    expect(floorTo(0.29, 2)).toBe(0.29) // 0.29 × 100 = 28.999999999999996 in floats
  })

  it('leverage and health factor', () => {
    expect(loopLeverage(0.5)).toBe(2)
    expect(healthFactor(0.8, 0.4)).toBe(2)
  })
})

describe('tallyAtLtv — one start LTV, every start (copy-claim check)', () => {
  /**
   * The debt floor at small sizes (refuter finding 2026-10-06). Entry 100, a 3-hour wick to 49
   * (LTV 40% → 81.6%: over the 80% line, inside the 4% band) and back. A levered long is
   * saved by the window. A carry position recalls; with the venue returning ×0.5 (a custom
   * multiple — a mechanics fixture; UPDATED 2026-10-06 from the retired 'stressed' preset,
   * the same node):
   *   $10,000 collateral, debt $4,000: the ask lifts to the $2,000 floor and the venue's
   *     $2,000 covers it — cured, the $2,000 left stands (not under the floor);
   *   $9,999 collateral, debt $3,999.60: loan − floor < floor, so the ask is the WHOLE loan
   *     (LE:2726-2727); the venue returns $1,999.80, which would strand $1,999.80 < $2,000 —
   *     so the call repays all and collateral sells the rest (saleReason 'floor').
   */
  const wick = pathOf([100, 49, 49, 49, ...new Array<number>(30).fill(100)])
  const carry = (collateralUsd: number): SetAndForgetCase => ({
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'carry',
    exitCapacityMult: 0.5,
    collateralUsd,
  })

  it('debt under 2 × the $2,000 floor turns a curable recall into a sale; at $4,000 it cures', () => {
    const shape = windowReplay(wick, 0, 33)!
    const small = runCase(carry(9_999), shape, 0.4)
    expect(isSold(small)).toBe(true)
    expect(small.saleReason).toBe('floor')
    expect(small.recallDrawnUsd).toBeCloseTo(1999.8, 6)
    const edge = runCase(carry(10_000), shape, 0.4)
    expect(isSold(edge)).toBe(false)
    expect(edge.outcome).toBe('recall_cured')
    expect(edge.recallDrawnUsd).toBeCloseTo(2000, 6)
    // The same wick never sells a levered long of either size: the window holds it.
    for (const collateralUsd of [9_999, 10_000]) {
      expect(isSold(runCase({ ...LL, collateralUsd }, shape, 0.4))).toBe(false)
    }
  })

  it('tallies the floor sale by reason, and the recall that cured', () => {
    const minr = windowMinRatios(wick, 30)
    const t = tallyAtLtv(carry(9_999), wick, [0], 30, 0.4, 'low-close', minr)
    expect(t).toMatchObject({ n: 1, breached: 1, recalled: 1, sold: 1, runs: 1 })
    expect(t.bySaleReason).toEqual({ floor: 1 })
    // The venue returned half the deployed debt ($1,999.80 of $3,999.60).
    expect(t.recallDrawnShareOfDebt!.median).toBeCloseTo(0.5, 9)
    expect(t.recallDrawnShareOfDebt!.max).toBeCloseTo(0.5, 9)
    const big = tallyAtLtv(carry(10_000), wick, [0], 30, 0.4)
    expect(big).toMatchObject({ n: 1, breached: 1, recalled: 1, sold: 0 })
    expect(big.recallDrawnShareOfDebt!.p95).toBeCloseTo(0.5, 9) // $2,000 of $4,000, cured
    // Under the proven bound nothing crosses the line: counted clean, no run.
    const low = tallyAtLtv(carry(9_999), wick, [0], 30, 0.39)
    expect(low).toMatchObject({ breached: 0, sold: 0, runs: 0, recallDrawnShareOfDebt: null })
  })

  it('agrees with a plain run of every start on random paths, at small and large sizes', () => {
    const p = randomPath(21, 400, 0.06)
    const hours = 72
    const minr = windowMinRatios(p, hours)
    const starts: number[] = []
    for (let s = 0; s + hours < 400; s++) if (Number.isFinite(minr[s])) starts.push(s)
    const reasons: Record<string, number> = {}
    // $5,000 of collateral keeps the debt under $4,000 at every LTV here: every recall closes.
    for (const c of [carry(5_000), carry(100_000), { ...LL, collateralUsd: 5_000 }]) {
      for (const ltv of [0.45, 0.6, 0.7]) {
        const t = tallyAtLtv(c, p, starts, hours, ltv, 'low-close', minr)
        let sold = 0
        let breached = 0
        let recalled = 0
        const shares: number[] = []
        for (const s of starts) {
          const r = runCase(c, windowReplay(p, s, hours)!, ltv)
          if (isSold(r)) sold++
          if (r.timeToBreachSeconds !== null) breached++
          if ((r.recallDrawnUsd ?? 0) > 0) {
            recalled++
            shares.push(r.recallDrawnUsd! / (ltv * c.collateralUsd!))
          }
        }
        expect(t.n).toBe(starts.length)
        expect(t.sold).toBe(sold)
        expect(t.breached).toBe(breached)
        expect(t.recalled).toBe(recalled)
        if (!shares.length) expect(t.recallDrawnShareOfDebt).toBeNull()
        else {
          shares.sort((a, b) => a - b)
          expect(t.recallDrawnShareOfDebt!.max).toBeCloseTo(shares[shares.length - 1], 12)
          expect(t.recallDrawnShareOfDebt!.median).toBeCloseTo(
            shares[Math.floor(0.5 * (shares.length - 1))],
            12,
          )
          // A recall never draws more than the deployed debt.
          expect(t.recallDrawnShareOfDebt!.max).toBeLessThanOrEqual(1 + 1e-12)
        }
        expect(Object.values(t.bySaleReason).reduce((a, b) => a + b, 0)).toBe(sold)
        for (const [k, v] of Object.entries(t.bySaleReason)) reasons[k] = (reasons[k] ?? 0) + v
      }
    }
    // Not vacuous: the small carry position sold on the floor, the levered long past the band.
    expect(reasons.floor).toBeGreaterThan(0)
    expect(reasons.band).toBeGreaterThan(0)
  })
})
