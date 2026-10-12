/**
 * The rate-spike axis of the stress engine: a borrow-rate shape and its duration
 * (stressGrid.ts header: RATE), its frontier distances (frontier.ts header: RATE AXES) and
 * the adapter from `rateSpikeAxis()` (lib/position-sim/rateSpike.ts).
 *
 * Real numbers: tests/unit/fixtures/rate-spike-axis.json holds the real `rateSpikeAxis()`
 * run on the irm_params recorded at block 26,120,000 (scripts/position-sim/
 * build-rate-spike-fixture.mjs). The first block below checks those paths against the
 * curve laws by hand, from the raw params, so the fixture is not trusted blind.
 *
 * Every analytic expectation is derived by hand: with the price held, the debt grows as
 * d·exp(∫APR dt / year), so the LTV crosses a line L from L0 when ∫APR dt = ln(L / L0) years.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DAYS_TOL,
  DEFAULT_RATE_LEVEL_HOURS,
  RATE_MAX_APR,
  distanceToDanger,
  rateDurationFrontier,
  rateLevelFrontier,
  rateShapeMaxDays,
} from '@/lib/position-sim/frontier'
import {
  rateSpikeShapeId,
  rateSpikeShapes,
  rateSpikeStresses,
  type RateSpikeAxisInput,
  type RateSpikeLevelInput,
} from '@/lib/position-sim/rateSpike'
import {
  EXIT_CAPACITY_DEFAULT_PRESET,
  MAX_RATE_HOURS,
  STRESS_SEVERITY,
  runStress,
  runStressGrid,
  stressCellCanonical,
  stressRank,
  stressScenarioId,
  type RateShape,
  type RateStress,
  type StressModelled,
  type StressPosition,
  type StressResult,
  type StressScenario,
} from '@/lib/position-sim/stressGrid'

// ------------------------------------------------------------------ fixtures

const YEAR = 365 * 86_400
const DAY = 86_400
const FLAT: StressScenario['price'] = { kind: 'step', drop: 0 }

interface FixtureLevel {
  name: 'now' | 'at-size' | 'kink' | 'stress'
  utilization: number
  borrowAprNow: number
  t: number[]
  borrowApr: number[]
  supplyApr: number[]
}
interface FixtureAxis {
  venueKey: string
  anchor: { blockNumber: bigint }
  label: string
  claim: 'stress-scenario'
  horizonSeconds: number
  assumption: string
  levels: FixtureLevel[]
  irm: Record<string, unknown>
  kinkUtilizationWad: bigint
}

/** The net-APY lane's bigint encoding ('26120000n'). */
const reviver = (_k: string, v: unknown) =>
  typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'rate-spike-axis.json'), 'utf8'),
  reviver,
) as { source: { horizonSeconds: number; steps: number }; axes: FixtureAxis[] }

type FixtureAxisInput = Omit<RateSpikeAxisInput, 'levels'> & {
  irm: Record<string, unknown>
  levels: (FixtureLevel & RateSpikeLevelInput)[]
}

/** A fixture axis in the shape `rateSpikeAxis()` returns (path rebuilt from its columns). */
function axisOf(venueKey: string): FixtureAxisInput {
  const a = fixture.axes.find((x) => x.venueKey === venueKey)
  if (!a) throw new Error(`fixture has no ${venueKey}`)
  return {
    ...a,
    levels: a.levels.map((l) => ({
      ...l,
      path: l.t.map((t, i) => ({
        t,
        utilization: l.utilization,
        borrowApr: l.borrowApr[i],
        supplyApr: l.supplyApr[i],
      })),
    })),
  }
}

function levelOf(venueKey: string, name: FixtureLevel['name'], utilization?: number) {
  const a = axisOf(venueKey)
  const l = a.levels.find(
    (x) => x.name === name && (utilization === undefined || x.utilization === utilization),
  )
  if (!l) throw new Error(`${venueKey} has no ${name} ${utilization ?? ''}`)
  return l
}

function shapeOf(venueKey: string, name: FixtureLevel['name'], utilization?: number): RateShape {
  const a = axisOf(venueKey)
  const s = rateSpikeShapes(a).find(
    (x) => x.level === name && (utilization === undefined || x.utilization === utilization),
  )
  if (!s) throw new Error(`${venueKey} has no ${name}`)
  return s.shape
}

/** Morpho's wExp vs the exact exponential, relative (see the fixture block). */
const MORPHO_WEXP_REL = 0.01

const C = 100_000

function pos(o: Partial<StressPosition> = {}): StressPosition {
  return {
    collateralUsd: C,
    debtUsd: 79_000,
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'levered_long',
    ...o,
  }
}

const hold = (borrowApr: number, supplyApr?: number): RateShape =>
  supplyApr === undefined ? { kind: 'hold', borrowApr } : { kind: 'hold', borrowApr, supplyApr }

function modelled(r: StressResult): StressModelled {
  if (r.outcome === 'not_modelled') throw new Error(`not modelled: ${r.reason}`)
  return r
}

const run = (p: StressPosition, rate: RateStress | undefined, opts = { stepSeconds: 600 }) =>
  runStress(p, { price: FLAT, ...(rate ? { rate } : {}) }, opts)

// ------------------------------------------------- the fixture vs the curve laws

describe('fixture — the real rateSpikeAxis() at block 26,120,000, checked against the curve laws', () => {
  it('pins the block, the claim class and the stated assumption on every axis', () => {
    expect(fixture.axes.map((a) => a.venueKey)).toEqual([
      'aave-v3-usdc',
      'morpho-blue-cbbtc-usdc-86',
      'euler-v2-eusdc-2',
    ])
    for (const a of fixture.axes) {
      expect(a.anchor.blockNumber).toBe(26_120_000n)
      expect(a.label).toBe('projected')
      expect(a.claim).toBe('stress-scenario')
      expect(a.assumption).toMatch(/held fixed/)
      expect(a.horizonSeconds).toBe(30 * DAY)
      for (const l of a.levels) {
        expect(l.t[0]).toBe(0)
        expect(l.t[l.t.length - 1]).toBe(30 * DAY)
        expect(l.t.length).toBe(fixture.source.steps + 1)
      }
    }
  })

  it('Aave v3 USDC: a static kinked curve — flat paths; base + slope1 at the kink, + slope2 at 100%', () => {
    const irm = axisOf('aave-v3-usdc').irm as Record<string, bigint>
    const bps = (x: bigint) => Number(x) / 1e4
    const base = bps(irm.baseVariableBorrowRateBps)
    const s1 = bps(irm.variableRateSlope1Bps)
    const s2 = bps(irm.variableRateSlope2Bps)
    for (const l of axisOf('aave-v3-usdc').levels) {
      expect(new Set(l.borrowApr).size).toBe(1)
      expect(new Set(l.supplyApr).size).toBe(1)
    }
    expect(levelOf('aave-v3-usdc', 'kink').borrowAprNow).toBeCloseTo(base + s1, 9)
    expect(levelOf('aave-v3-usdc', 'stress', 1).borrowAprNow).toBeCloseTo(base + s1 + s2, 9)
  })

  it('Morpho cbBTC/USDC at 100%: the rate grows as exp(50·t/yr) and stops at 800% (4 × the 200% rateAtTarget cap)', () => {
    const l = levelOf('morpho-blue-cbbtc-usdc-86', 'stress', 1)
    const r0 = l.borrowApr[0]
    for (let i = 0; i < l.t.length; i++) {
      const law = Math.min(RATE_MAX_APR, r0 * Math.exp((50 * l.t[i]) / YEAR))
      // Within 1%: the IRM's own wExp is a second-order Taylor step on [−ln2/2, ln2/2]
      // (measured: at most 0.86% off the exact exponential on this path).
      expect(Math.abs(l.borrowApr[i] / law - 1)).toBeLessThan(MORPHO_WEXP_REL)
    }
    // Board, UMBRELLA "Net APY at size" lane, item 8: 18.7% at once, 48.6% after 7 days held.
    expect(r0).toBeCloseTo(0.187, 3)
    const at7d = l.borrowApr[l.t.indexOf(7 * DAY)]
    expect(at7d).toBeCloseTo(0.486, 3)
    expect(Math.max(...l.borrowApr)).toBe(RATE_MAX_APR)
    // Below the 90% target the same law runs backwards: the 'now' level decays.
    const now = levelOf('morpho-blue-cbbtc-usdc-86', 'now')
    expect(now.utilization).toBeLessThan(0.9)
    for (let i = 1; i < now.t.length; i++)
      expect(now.borrowApr[i]).toBeLessThanOrEqual(now.borrowApr[i - 1])
  })

  it('Euler eUSDC-2: a linear kink from per-second ray rates', () => {
    const irm = axisOf('euler-v2-eusdc-2').irm as Record<string, bigint>
    const MAX = 2 ** 32 - 1
    const apr = (perSecondRay: number) => (perSecondRay * YEAR) / 1e27
    const kink = Number(irm.kink)
    const atKink = Number(irm.baseRate) + Number(irm.slope1) * kink
    const atFull = atKink + Number(irm.slope2) * (MAX - kink)
    expect(levelOf('euler-v2-eusdc-2', 'kink').borrowAprNow / apr(atKink)).toBeCloseTo(1, 6)
    expect(levelOf('euler-v2-eusdc-2', 'stress', 1).borrowAprNow / apr(atFull)).toBeCloseTo(1, 6)
  })
})

// ----------------------------------------------------------------- the walk

describe('rate stress — interest accrual moves the LTV toward the line', () => {
  it('no rate: interest and yield given up are null (omitted, not 0)', () => {
    const r = modelled(
      run(
        pos({ tradeShape: 'carry', deployedUsd: 50_000, exitCapacityPreset: 'optimistic' }),
        undefined,
      ),
    )
    expect(r.interestUsd).toBeNull()
    expect(r.yieldGivenUpUsd).toBeNull()
  })

  it('a held APR compounds the debt: interest = d·(exp(apr·T/yr) − 1), and the LTV lands there', () => {
    const p = pos({ debtUsd: 50_000 })
    const r = modelled(run(p, { shape: hold(0.1), hours: 30 * 24 }))
    const growth = Math.exp((0.1 * 30 * DAY) / YEAR)
    expect(r.interestUsd).toBeCloseTo(50_000 * (growth - 1), 6)
    expect(r.landingLtv).toBeCloseTo((50_000 * growth) / C, 10)
    expect(r.peakLtv).toBeCloseTo((50_000 * growth) / C, 10)
    expect(r.outcome).toBe('no_breach')
    expect(r.startLtv).toBe(0.5)
  })

  it('accrual stops at the spike end, even mid-step (a 630 s spike on a 600 s grid)', () => {
    const p = pos({ debtUsd: 50_000 })
    const r = modelled(run(p, { shape: hold(2), hours: 630 / 3600 }))
    expect(r.interestUsd).toBeCloseTo(50_000 * Math.expm1((2 * 630) / YEAR), 9)
    expect(r.horizonSeconds).toBeGreaterThanOrEqual(630)
  })

  it('a 0% APR changes nothing but the key', () => {
    const p = pos()
    const base = modelled(run(p, undefined))
    const zero = modelled(run(p, { shape: hold(0), hours: 24 }))
    expect(zero.interestUsd).toBe(0)
    expect(zero.outcome).toBe(base.outcome)
    expect(zero.peakLtv).toBe(base.peakLtv)
    expect(zero.cellKey).not.toBe(base.cellKey)
  })

  it('interest alone crosses the line at ln(L/L0)/apr years: a levered long arms, then sells at expiry', () => {
    const p = pos() // LTV 0.79, line 0.80
    const apr = 0.5
    const r = modelled(run(p, { shape: hold(apr), hours: 30 * 24 }, { stepSeconds: 60 }))
    const tCross = (Math.log(0.8 / 0.79) / apr) * YEAR
    expect(r.timeToBreachSeconds).not.toBeNull()
    expect(Math.abs(r.timeToBreachSeconds! - tCross)).toBeLessThanOrEqual(60)
    expect(r.armed).toBe(true)
    expect(r.outcome).toBe('sold')
    expect(r.saleReason).toBe('expiry')
    expect(r.timeToSaleSeconds! - r.timeToArmSeconds!).toBe(8 * 3600)
  })

  it('only UNDEPLOYED debt accrues: deployed debt pays 0% (Cdp STEP 1b), the rest the avoidance rate', () => {
    const half = pos({
      debtUsd: 50_000,
      tradeShape: 'carry',
      deployedUsd: 20_000,
      exitCapacityPreset: 'optimistic',
    })
    const r = modelled(run(half, { shape: hold(0.5), hours: 30 * 24 }))
    expect(r.interestUsd).toBeCloseTo(30_000 * Math.expm1((0.5 * 30 * DAY) / YEAR), 6)
    // All of it deployed: the highest APR any path carries, for a month, moves nothing.
    const full = pos({ tradeShape: 'carry', deployedUsd: 79_000, exitCapacityPreset: 'optimistic' })
    const none = modelled(run(full, { shape: hold(RATE_MAX_APR), hours: 30 * 24 }))
    expect(none.interestUsd).toBe(0)
    expect(none.outcome).toBe('no_breach')
    // A levered long deploys nothing: all of its debt accrues.
    const ll = modelled(run(pos({ debtUsd: 50_000 }), { shape: hold(0.5), hours: 30 * 24 }))
    expect(ll.interestUsd).toBeCloseTo(50_000 * Math.expm1((0.5 * 30 * DAY) / YEAR), 6)
  })

  it('recall needed reads the ACCRUED debt: d + u·(G − 1) − L·c at the spike end, with the price held', () => {
    const p = pos({
      tradeShape: 'carry',
      deployedUsd: 40_000,
      exitCapacityPreset: 'optimistic',
    })
    const r = modelled(run(p, { shape: hold(0.5), hours: 30 * 24 }))
    const g = Math.exp((0.5 * 30 * DAY) / YEAR)
    expect(r.recallNeededUsd).toBeCloseTo(79_000 + 39_000 * (g - 1) - 0.8 * C, 6)
    // Without a rate the old formula stands: nothing over the line, nothing needed.
    expect(modelled(run(p, undefined)).recallNeededUsd).toBe(0)
  })

  it('a carry recall cures a rate-driven breach; the recalled capital gives up the supply APR to the spike end', () => {
    // $39,500 undeployed at 50%: the line is crossed after ~9.2 days. The recall restores the
    // borrow LTV (0.77) with deployed principal, so $40,000 stays undeployed. Back to 0.80
    // would take ~27 days more, so one recall inside 12 days.
    const p = pos({
      debtUsd: 79_500,
      tradeShape: 'carry',
      deployedUsd: 40_000,
      exitCapacityPreset: 'optimistic',
    })
    const hours = 12 * 24
    const r = modelled(run(p, { shape: hold(0.5, 0.4), hours }, { stepSeconds: 60 }))
    expect(r.outcome).toBe('recall_cured')
    expect(r.recallDrawnUsd).toBeGreaterThan(0)
    const tRecall = r.timeToBreachSeconds!
    const expected = r.recallDrawnUsd! * Math.expm1((0.4 * (hours * 3600 - tRecall)) / YEAR)
    expect(r.yieldGivenUpUsd).toBeCloseTo(expected, 6)
    // The recall repaid deployed debt with deployed principal: the undeployed $39,500 kept
    // accruing through it, so the interest is the whole spike on that amount.
    expect(r.interestUsd).toBeCloseTo(39_500 * Math.expm1((0.5 * hours * 3600) / YEAR), 6)
    // The same spike with no supply APR prices no yield given up.
    expect(
      modelled(run(p, { shape: hold(0.5), hours }, { stepSeconds: 60 })).yieldGivenUpUsd,
    ).toBeNull()
  })

  it('no recall during the spike: yield given up is 0; a levered long has none to give (null)', () => {
    const carry = pos({
      debtUsd: 50_000,
      tradeShape: 'carry',
      deployedUsd: 50_000,
      exitCapacityPreset: 'optimistic',
    })
    expect(modelled(run(carry, { shape: hold(0.1, 0.08), hours: 24 })).yieldGivenUpUsd).toBe(0)
    const ll = modelled(run(pos({ debtUsd: 50_000 }), { shape: hold(0.1, 0.08), hours: 24 }))
    expect(ll.yieldGivenUpUsd).toBeNull()
    expect(ll.interestUsd).toBeGreaterThan(0)
  })

  it('a rate stress combines with a price shock: the shock arms, the interest decides the window', () => {
    // −1% step: LTV 0.79/0.99 = 0.798 — under the line. With 200% APR for 2 days the debt
    // crosses it inside the spike; without the rate nothing happens.
    const p = pos()
    const price = { kind: 'step', drop: 0.01 } as const
    const without = modelled(runStress(p, { price }, { stepSeconds: 600 }))
    const withRate = modelled(
      runStress(p, { price, rate: { shape: hold(2), hours: 48 } }, { stepSeconds: 600 }),
    )
    expect(without.outcome).toBe('no_breach')
    expect(stressRank(withRate)).toBeGreaterThan(stressRank(without))
  })
})

// ----------------------------------------------------------- path sampling

describe('rate stress — a projected path is sampled toward risk and never extrapolated', () => {
  const rising: RateShape = {
    kind: 'path',
    id: 'test-rising',
    points: [
      { t: 0, borrowApr: 0.1, supplyApr: 0.08 },
      { t: DAY, borrowApr: 0.2, supplyApr: 0.16 },
    ],
  }

  it('between two points the APR is the higher one: interest at 20% over the day, above the linear truth', () => {
    const r = modelled(run(pos({ debtUsd: 50_000 }), { shape: rising, hours: 24 }))
    expect(r.interestUsd).toBeCloseTo(50_000 * Math.expm1(0.2 / 365), 9)
    expect(r.interestUsd!).toBeGreaterThan(50_000 * Math.expm1(0.15 / 365))
  })

  it('a spike as long as the path is valid; one second longer is not modelled', () => {
    expect(run(pos(), { shape: rising, hours: 24 }).outcome).not.toBe('not_modelled')
    const past = run(pos(), { shape: rising, hours: 24 + 1 / 3600 })
    expect(past.outcome === 'not_modelled' && past.reason).toBe('invalid_shape')
  })

  it('invalid rate inputs are not modelled (invalid_shape)', () => {
    const bad: RateStress[] = [
      { shape: hold(-0.01), hours: 24 },
      { shape: hold(Number.NaN), hours: 24 },
      { shape: hold(Infinity), hours: 24 },
      { shape: hold(0.1, -0.1), hours: 24 },
      { shape: hold(0.1), hours: -1 },
      { shape: hold(0.1), hours: Number.NaN },
      { shape: hold(0.1), hours: MAX_RATE_HOURS + 1 },
      {
        shape: { kind: 'path', id: 'one', points: [{ t: 0, borrowApr: 0.1, supplyApr: 0 }] },
        hours: 0,
      },
      {
        shape: {
          kind: 'path',
          id: 'late-start',
          points: [
            { t: 60, borrowApr: 0.1, supplyApr: 0 },
            { t: 120, borrowApr: 0.1, supplyApr: 0 },
          ],
        },
        hours: 0.01,
      },
      {
        shape: {
          kind: 'path',
          id: 'not-increasing',
          points: [
            { t: 0, borrowApr: 0.1, supplyApr: 0 },
            { t: 0, borrowApr: 0.1, supplyApr: 0 },
          ],
        },
        hours: 0,
      },
      {
        shape: {
          kind: 'path',
          id: 'negative',
          points: [
            { t: 0, borrowApr: 0.1, supplyApr: 0 },
            { t: 3600, borrowApr: -0.1, supplyApr: 0 },
          ],
        },
        hours: 1,
      },
    ]
    for (const rate of bad) {
      const r = run(pos(), rate)
      expect(r.outcome === 'not_modelled' && r.reason, JSON.stringify(rate)).toBe('invalid_shape')
    }
  })

  it('MAX_RATE_HOURS itself is walked (one year, at a coarse grid)', () => {
    const r = modelled(
      run(
        pos({ debtUsd: 10_000 }),
        { shape: hold(0.05), hours: MAX_RATE_HOURS },
        { stepSeconds: 3600 },
      ),
    )
    expect(r.interestUsd).toBeCloseTo(10_000 * Math.expm1(0.05), 6)
  })
})

// --------------------------------------------------------------- the key

describe('rate stress — cell key and scenario id', () => {
  const p = pos()

  it('absent (or undefined), the canonical inputs carry no trace of it: every old key stands', () => {
    const a = stressCellCanonical(p, { price: FLAT })
    const b = stressCellCanonical(p, { price: FLAT, rate: undefined })
    expect(b).toBe(a)
    expect(a).not.toMatch(/"rate"/)
  })

  it('keyed by its normalized inputs: APR, duration and path content, not array identity', () => {
    const k = (rate: RateStress) => stressCellCanonical(p, { price: FLAT, rate })
    expect(k({ shape: hold(0.1), hours: 24 })).toBe(
      k({ shape: hold(0.1000000001), hours: 24.00000001 }),
    )
    expect(k({ shape: hold(0.1), hours: 24 })).not.toBe(k({ shape: hold(0.11), hours: 24 }))
    expect(k({ shape: hold(0.1), hours: 24 })).not.toBe(k({ shape: hold(0.1), hours: 25 }))
    expect(k({ shape: hold(0.1), hours: 24 })).not.toBe(k({ shape: hold(0.1, 0.05), hours: 24 }))
    const shape = shapeOf('morpho-blue-cbbtc-usdc-86', 'stress', 1)
    const copy = JSON.parse(JSON.stringify(shape)) as RateShape
    expect(k({ shape, hours: 168 })).toBe(k({ shape: copy, hours: 168 }))
    const bumped = JSON.parse(JSON.stringify(shape)) as Extract<RateShape, { kind: 'path' }>
    ;(bumped.points[5] as { borrowApr: number }).borrowApr += 1e-6
    expect(k({ shape, hours: 168 })).not.toBe(k({ shape: bumped, hours: 168 }))
  })

  it('names the rate in the scenario id', () => {
    expect(stressScenarioId({ price: FLAT, rate: { shape: hold(0.486), hours: 168 } })).toBe(
      'step-0@rate-48.6-168h',
    )
    expect(
      stressScenarioId({
        price: { kind: 'step', drop: 0.25 },
        rate: { shape: shapeOf('morpho-blue-cbbtc-usdc-86', 'stress', 1), hours: 168 },
      }),
    ).toBe('step-25@rate-morpho-blue-cbbtc-usdc-86@26120000:stress-u100-168h')
  })

  it('same inputs ⇒ same key and identical outputs', () => {
    const rate = { shape: shapeOf('euler-v2-eusdc-2', 'stress', 1), hours: 72 }
    expect(run(p, rate)).toEqual(run(p, rate))
  })
})

// ---------------------------------------------------------- monotonicity

describe('rate stress — a longer or higher spike is never better', () => {
  const positions: StressPosition[] = [
    pos(),
    pos({ membraneClass: 'no-delay', line: 0.95, debtUsd: 94_000 }),
    pos({
      tradeShape: 'carry',
      deployedUsd: 79_000,
      exitCapacityPreset: EXIT_CAPACITY_DEFAULT_PRESET,
    }),
    pos({ tradeShape: 'carry', deployedUsd: 40_000, exitCapacityMult: 0.25, debtUsd: 78_000 }),
  ]
  const morpho = shapeOf('morpho-blue-cbbtc-usdc-86', 'stress', 1)

  /**
   * The sale-path entry never falls, and the line is never crossed later. Peak LTV is only
   * compared while nothing acts: once a recall or a sale runs, the peak is the overshoot at
   * the crossing STEP, which moves with the grid phase (~1e-5 either way), not the stress.
   */
  function expectNeverBetter(r: StressModelled, prev: StressModelled, what: string) {
    expect(stressRank(r), what).toBeGreaterThanOrEqual(
      Math.min(stressRank(prev), STRESS_SEVERITY.recall_liquidated),
    )
    if (prev.timeToBreachSeconds !== null) {
      expect(r.timeToBreachSeconds, what).not.toBeNull()
      expect(r.timeToBreachSeconds!, what).toBeLessThanOrEqual(prev.timeToBreachSeconds)
    }
    if (r.outcome === 'no_breach') expect(r.peakLtv, what).toBeGreaterThanOrEqual(prev.peakLtv)
  }

  it('duration: the rank never falls and the line is never crossed later', () => {
    for (const [k, p] of positions.entries()) {
      let prev: StressModelled | null = null
      for (let days = 0.5; days <= 30; days += 0.5) {
        const r = modelled(run(p, { shape: morpho, hours: days * 24 }, { stepSeconds: 1800 }))
        if (prev) expectNeverBetter(r, prev, `position ${k}, ${days} days`)
        prev = r
      }
    }
  })

  it('held APR: the rank never falls and the line is never crossed later', () => {
    for (const [k, p] of positions.entries()) {
      let prev: StressModelled | null = null
      for (let apr = 0; apr <= 4; apr += 0.1) {
        const r = modelled(run(p, { shape: hold(apr), hours: 7 * 24 }, { stepSeconds: 1800 }))
        if (prev) expectNeverBetter(r, prev, `position ${k}, APR ${apr}`)
        prev = r
      }
    }
  })
})

// ------------------------------------------------------------ the frontier

describe('rate frontier — duration axis', () => {
  it('a held APR on a levered long: breach, arm and sale at ln(L/L0)/apr years; display floors toward risk', () => {
    const p = pos() // 0.79 → 0.80
    const apr = 0.5
    const edgeDays = (Math.log(0.8 / 0.79) / apr) * 365 // ≈ 9.18
    const ax = rateDurationFrontier(p, hold(apr), { stepSeconds: 600 })
    for (const e of [ax.breach, ax.arm, ax.sale]) {
      expect(e.status).toBe('found')
      if (e.status !== 'found') continue
      expect(e.unit).toBe('days')
      expect(e.display).toBe(Math.floor(edgeDays))
      expect(e.safeBelow).toBeLessThanOrEqual(edgeDays + DAYS_TOL)
      expect(e.triggersAt).toBeGreaterThanOrEqual(edgeDays - DAYS_TOL)
      expect(e.triggersAt - e.safeBelow).toBeLessThanOrEqual(DAYS_TOL)
    }
    expect(ax.reference).toEqual(FLAT)
  })

  it('with the price held, the edge does not depend on the grid: the 600 s default matches 60 s', () => {
    const p = pos()
    const coarse = rateDurationFrontier(p, hold(0.5)).breach
    const fine = rateDurationFrontier(p, hold(0.5), { stepSeconds: 60 }).breach
    if (coarse.status !== 'found' || fine.status !== 'found') throw new Error('edges')
    expect(Math.abs(coarse.triggersAt - fine.triggersAt)).toBeLessThanOrEqual(2 * DAYS_TOL)
    expect(coarse.display).toBe(fine.display)
    expect(coarse.at.cellKey).not.toBe(fine.at.cellKey) // the step is in the key
  })

  it('ample recall on a carry: the line is crossed, but nothing arms or sells inside 30 days', () => {
    // $39,000 undeployed at 200%: crossed after ~9 days; each recall restores the borrow LTV.
    const p = pos({ tradeShape: 'carry', deployedUsd: 40_000, exitCapacityPreset: 'optimistic' })
    const ax = rateDurationFrontier(p, hold(2), { stepSeconds: 1800 })
    expect(ax.breach.status).toBe('found')
    expect(ax.arm).toEqual({ status: 'beyond_range', unit: 'days', max: 30 })
    expect(ax.sale).toEqual({ status: 'beyond_range', unit: 'days', max: 30 })
  })

  it('a carry with all of its debt deployed has no rate edge on either axis', () => {
    const p = pos({ tradeShape: 'carry', deployedUsd: 79_000, exitCapacityPreset: 'optimistic' })
    const beyond = { status: 'beyond_range', unit: 'days', max: 30 }
    const d = rateDurationFrontier(p, hold(RATE_MAX_APR), { stepSeconds: 3600 })
    expect([d.breach, d.arm, d.sale]).toEqual([beyond, beyond, beyond])
    const l = rateLevelFrontier(p, { stepSeconds: 3600 })
    expect(l.breach).toEqual({ status: 'beyond_range', unit: 'pct', max: RATE_MAX_APR })
  })

  it('no-delay class: no arm edge; already over the line: already', () => {
    const nd = rateDurationFrontier(
      pos({ membraneClass: 'no-delay', line: 0.95, debtUsd: 94_000 }),
      hold(0.5),
      {
        stepSeconds: 1800,
      },
    )
    expect(nd.arm).toEqual({ status: 'not_applicable', reason: 'no_delay_class' })
    const over = rateDurationFrontier(pos({ debtUsd: 81_000 }), hold(0.5), { stepSeconds: 1800 })
    expect(over.breach.status).toBe('already')
  })

  it('real Morpho cbBTC/USDC at 100%: the line is crossed where the curve law says, a little early (toward risk)', () => {
    // A levered long (all debt undeployed), Morpho LLTV 86% line, start LTV 80%. The shape is
    // the supply APR (rateSpike.ts). At 100% utilization and a 0 fee it equals the borrow
    // APR, so the law holds: r(t) = r0·exp(50t/yr) until 800%, and
    // ∫r dt = r0·(yr/50)·(exp(50T/yr) − 1) = ln(0.86/0.80) at T ≈ 22 days (before the cap).
    const shape = shapeOf('morpho-blue-cbbtc-usdc-86', 'stress', 1)
    const l = levelOf('morpho-blue-cbbtc-usdc-86', 'stress', 1)
    expect(l.supplyApr).toEqual(l.borrowApr)
    const r0 = l.supplyApr[0]
    const truthDays = (Math.log(1 + (Math.log(0.86 / 0.8) * 50) / r0) * 365) / 50
    expect(truthDays).toBeGreaterThan(21)
    expect(truthDays).toBeLessThan(23)
    const p = pos({ debtUsd: 80_000, line: 0.86 })
    const ax = rateDurationFrontier(p, shape, { stepSeconds: 1800 })
    expect(ax.breach.status).toBe('found')
    if (ax.breach.status !== 'found') return
    // Sampled at the higher of two 6-hourly points: at most ~6 h before the law. It can be a
    // little after it only by the wExp error (1% of the integral ≈ 0.07 day at this rate).
    expect(ax.breach.triggersAt).toBeLessThan(truthDays + 0.07)
    expect(ax.breach.triggersAt).toBeGreaterThan(truthDays - 0.3)
    expect(ax.breach.display).toBe(Math.floor(ax.breach.triggersAt - 1e-9))
    // Aave USDC at 100% supplies a flat ~13%: ~0.56 years to the line, beyond the 30-day path.
    const aave = rateDurationFrontier(p, shapeOf('aave-v3-usdc', 'stress', 1), {
      stepSeconds: 1800,
    })
    expect(aave.breach).toEqual({ status: 'beyond_range', unit: 'days', max: 30 })
  })

  it('a path is searched only up to its last point', () => {
    expect(rateShapeMaxDays(shapeOf('euler-v2-eusdc-2', 'kink'))).toBe(30)
    expect(rateShapeMaxDays(hold(0.1))).toBe(30)
    const short: RateShape = {
      kind: 'path',
      id: 'two-days',
      points: [
        { t: 0, borrowApr: 0.1, supplyApr: 0 },
        { t: 2 * DAY, borrowApr: 0.1, supplyApr: 0 },
      ],
    }
    const ax = rateDurationFrontier(pos(), short, { stepSeconds: 1800 })
    expect(ax.breach).toEqual({ status: 'beyond_range', unit: 'days', max: 2 })
  })
})

describe('rate frontier — level axis (worst-case rate held for 7 days)', () => {
  it('the lowest held APR that crosses the line: ln(L/L0)·yr/T, floored to a whole %', () => {
    const p = pos({ debtUsd: 78_000 })
    const edgeApr = (Math.log(0.8 / 0.78) * YEAR) / (DEFAULT_RATE_LEVEL_HOURS * 3600) // ≈ 1.32
    const ax = rateLevelFrontier(p, { stepSeconds: 600 })
    expect(ax.hours).toBe(168)
    for (const e of [ax.breach, ax.arm, ax.sale]) {
      expect(e.status).toBe('found')
      if (e.status !== 'found') continue
      expect(e.unit).toBe('pct')
      expect(e.display).toBe(Math.floor(edgeApr * 100))
      expect(Math.abs(e.triggersAt - edgeApr)).toBeLessThanOrEqual(1e-4)
    }
  })

  it('a position far from the line survives every APR up to 800% for 7 days', () => {
    const ax = rateLevelFrontier(pos({ debtUsd: 50_000 }), { stepSeconds: 1800 })
    expect(ax.breach).toEqual({ status: 'beyond_range', unit: 'pct', max: RATE_MAX_APR })
  })

  it('a price reference moves the edge in: −1% step at LTV 0.78', () => {
    const p = pos({ debtUsd: 78_000 })
    const flat = rateLevelFrontier(p, { stepSeconds: 600 })
    const shocked = rateLevelFrontier(p, {
      stepSeconds: 600,
      reference: { kind: 'step', drop: 0.01 },
    })
    if (flat.breach.status !== 'found' || shocked.breach.status !== 'found')
      throw new Error('edges')
    expect(shocked.breach.triggersAt).toBeLessThan(flat.breach.triggersAt)
    expect(shocked.reference).toEqual({ kind: 'step', drop: 0.01 })
  })
})

describe('distanceToDanger — the rate axes are opt-in', () => {
  it('absent unless asked; with a shape, both axes', () => {
    const p = pos({ debtUsd: 70_000 })
    const plain = distanceToDanger(p, { stepSeconds: 3600 })
    expect('rate' in plain).toBe(false)
    const shape = shapeOf('morpho-blue-cbbtc-usdc-86', 'stress', 1)
    const d = distanceToDanger(p, { stepSeconds: 3600, rate: { shape } })
    expect(d.rate?.level.hours).toBe(168)
    expect(d.rate?.duration?.shape).toBe(shape)
    expect(d.rate?.duration?.breach.status).toBe('found')
    expect(distanceToDanger(p, { stepSeconds: 3600, rate: {} }).rate?.duration).toBeNull()
  })
})

// ------------------------------------------------------------- the grid

describe('runStressGrid — rate rows', () => {
  it('none by default; with rates, one row per shape each, single-axis; a levered long gets them too', () => {
    const rates = rateSpikeStresses(axisOf('aave-v3-usdc'), 168)
    const ll = pos()
    const plain = runStressGrid(ll, { stepSeconds: 3600 })
    const withRates = runStressGrid(ll, { stepSeconds: 3600, rates })
    expect(withRates.length).toBe(plain.length + plain.length * rates.length)
    const rateRows = withRates.filter((c) => c.scenario.rate)
    expect(rateRows.length).toBe(plain.length * rates.length)
    for (const c of rateRows) {
      expect(c.scenario.venue).toBeUndefined()
      expect(c.result.outcome).not.toBe('not_modelled')
    }
    const carry = pos({
      tradeShape: 'carry',
      deployedUsd: 79_000,
      exitCapacityPreset: EXIT_CAPACITY_DEFAULT_PRESET,
    })
    const carryPlain = runStressGrid(carry, { stepSeconds: 3600 })
    expect(runStressGrid(carry, { stepSeconds: 3600, rates }).length).toBe(
      carryPlain.length + 5 * rates.length,
    )
  })
})

// ---------------------------------------------------------- the adapter

describe('rateSpike adapter — rateSpikeAxis() levels as rate shapes', () => {
  it('one path per level, named by venue, block, level and utilization; the assumption travels with it', () => {
    const a = axisOf('morpho-blue-cbbtc-usdc-86')
    const shapes = rateSpikeShapes(a)
    expect(shapes.map((s) => s.shape.id)).toEqual([
      'morpho-blue-cbbtc-usdc-86@26120000:now-u89.35',
      'morpho-blue-cbbtc-usdc-86@26120000:kink-u90',
      'morpho-blue-cbbtc-usdc-86@26120000:stress-u95',
      'morpho-blue-cbbtc-usdc-86@26120000:stress-u100',
    ])
    for (const [i, s] of shapes.entries()) {
      expect(s.assumption).toBe(a.assumption)
      expect(s.shape.points.length).toBe(a.levels[i].path.length)
      // The rate on undeployed debt is the venue's SUPPLY APR (the avoidance rate's upper
      // bound), never its borrow APR.
      expect(s.shape.points[3]).toEqual({
        t: a.levels[i].path[3].t,
        borrowApr: a.levels[i].path[3].supplyApr,
        supplyApr: a.levels[i].path[3].supplyApr,
      })
      expect(rateSpikeShapeId(a, a.levels[i])).toBe(s.shape.id)
    }
  })

  it('stresses last the whole horizon by default; every one walks', () => {
    for (const a of fixture.axes) {
      const rates = rateSpikeStresses(axisOf(a.venueKey))
      expect(rates.every((r) => r.hours === 720)).toBe(true)
      for (const rate of rates)
        expect(run(pos({ debtUsd: 50_000 }), rate).outcome).not.toBe('not_modelled')
    }
  })

  it('real numbers: Morpho cbBTC/USDC pinned at 100% for 7 days on $80k of carry debt, half deployed', () => {
    const p = pos({
      debtUsd: 80_000,
      line: 0.86,
      tradeShape: 'carry',
      deployedUsd: 40_000,
      exitCapacityPreset: EXIT_CAPACITY_DEFAULT_PRESET,
    })
    const l = levelOf('morpho-blue-cbbtc-usdc-86', 'stress', 1)
    const r = modelled(
      run(
        p,
        { shape: shapeOf('morpho-blue-cbbtc-usdc-86', 'stress', 1), hours: 168 },
        { stepSeconds: 600 },
      ),
    )
    // Only the $40k undeployed accrues. Bounds from the law: ∫r dt / yr from 0 to T, for
    // r(t) = r0·exp(50t/yr) (no cap inside 7 days). The engine reads the higher of two
    // 6-hourly points, so its rate at t is at most r(t + 6 h).
    const integral = (T: number) => (l.supplyApr[0] / 50) * Math.expm1((50 * T) / YEAR)
    const lead = 6 * 3600
    const lower = 40_000 * Math.expm1((1 - MORPHO_WEXP_REL) * integral(7 * DAY))
    const upper =
      40_000 * Math.expm1((1 + MORPHO_WEXP_REL) * (integral(7 * DAY + lead) - integral(lead)))
    expect(r.interestUsd!).toBeGreaterThanOrEqual(lower)
    expect(r.interestUsd!).toBeLessThanOrEqual(upper)
    expect(r.outcome).toBe('no_breach')
    expect(r.yieldGivenUpUsd).toBe(0)
  })
})
