/**
 * stressGrid — deterministic stress nodes through Membrane's master mechanics.
 *
 * Every analytic expectation below is derived by hand from the master rules cited in
 * lib/position-sim/stressGrid.ts (recall first, asking only the restore-to-borrow-LTV
 * amount — owner ruling 2026-10-04, master asks the full debt; recall-only lane;
 * TimerActive rollback; sale sized on PRE-recall debt at POST-recall LTV) and the
 * task-#1 class table in lib/position-sim/membrane.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { cureWalk } from '@/lib/position-sim/curePath'
import { withStartLtv } from '@/lib/position-sim/frontier'
import { membraneRepayValue, CURE_WINDOW_SECONDS } from '@/lib/position-sim/membrane'
import type { Oct10Series } from '@/lib/position-sim/scenario'
import {
  DEFAULT_CAPACITY_MULTS,
  DEFAULT_PRICE_SHAPES,
  EXIT_CAPACITY_DEFAULT_CUTS,
  EXIT_CAPACITY_DEFAULT_PRESET,
  EXIT_CAPACITY_PRESETS,
  EXIT_CAPACITY_PRESET_ORDER,
  EXIT_CAPACITY_VENUES,
  exitCapacityFloorOf,
  exitCapacityFromPreset,
  STRESS_CODE_VERSION,
  STRESS_LABEL,
  STRESS_SEVERITY,
  oct10ReplayShape,
  runStress,
  runStressGrid,
  stressCellCanonical,
  stressGridScenarios,
  stressPositionFromProtocol,
  stressRank,
  type PriceShape,
  type StressModelled,
  type StressPosition,
  type StressResult,
  type StressScenario,
  type VenueStress,
} from '@/lib/position-sim/stressGrid'
import { stamp, type ProtocolPosition } from '@/lib/position-sim/types'

// ------------------------------------------------------------------ fixtures

const C = 100_000
const B = 0.77 // borrow cap at a 0.80 line (3pp gap)
const D_MIN = 2000

function pos(o: Partial<StressPosition> = {}): StressPosition {
  return {
    collateralUsd: C,
    debtUsd: 61_300, // LTV 0.613
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'levered_long',
    debtMinimumUsd: D_MIN,
    // Ruling 5 (owner 2026-10-04): exit capacity is never defaulted. Every position here
    // states it — the 'optimistic' preset (×1 of deployed) unless a test overrides it.
    // A levered_long position ignores it (no recall).
    exitCapacityPreset: 'optimistic',
    ...o,
  }
}

const carry = (o: Partial<StressPosition> = {}) => pos({ tradeShape: 'carry', ...o })

function m(r: StressResult): StressModelled {
  if (r.outcome === 'not_modelled') throw new Error(`not modelled: ${r.reason}`)
  return r
}

const step = (drop: number): PriceShape => ({ kind: 'step', drop })
const run = (p: StressPosition, price: PriceShape, venue?: VenueStress) =>
  m(runStress(p, { price, venue }))

/** Deterministic PRNG (mulberry32) so the sweeps are reproducible. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const EXPIRY_S = 60 + CURE_WINDOW_SECONDS // breach at step 1 (60 s), sale 480 steps later

// ------------------------------------------------------------- outcome classes

describe('stress node — delayed class, levered_long (window only)', () => {
  it('no_breach when the shock stays under the line', () => {
    const r = run(pos(), step(0.2)) // 0.613 / 0.8 = 0.766
    expect(r.outcome).toBe('no_breach')
    expect(r.armed).toBe(false)
    expect(r.timeToBreachSeconds).toBeNull()
    expect(r.exposedUsd).toBe(0)
    expect(r.landingLtv).toBeCloseTo(0.613 / 0.8, 10)
  })

  it('a step inside the band arms at the shock and sells at expiry (8h only buys time)', () => {
    const r = run(pos(), step(0.25)) // 0.613 / 0.75 = 0.8173 in (0.80, 0.832]
    expect(r.outcome).toBe('sold')
    expect(r.armed).toBe(true)
    expect(r.timeToArmSeconds).toBe(60)
    expect(r.timeToSaleSeconds).toBe(EXPIRY_S)
    expect(r.saleReason).toBe('expiry')
    expect(r.exposedUsd).toBeCloseTo(membraneRepayValue(61_300, 75_000, B, D_MIN), 6)
    expect(r.landingLtv).toBeCloseTo(B, 9) // restore-to-borrow-cap, no fee
  })

  it('a step past the band sells at the shock without arming (Immediate)', () => {
    const r = run(pos(), step(0.3)) // 0.876 > 0.832
    expect(r.outcome).toBe('sold')
    expect(r.armed).toBe(false)
    expect(r.timeToArmSeconds).toBeNull()
    expect(r.timeToSaleSeconds).toBe(60)
    expect(r.saleReason).toBe('band')
  })

  it('a wick inside the band that recovers inside the window is armed_cured', () => {
    const r = run(pos(), { kind: 'wick', drop: 0.25, hours: 4 })
    expect(r.outcome).toBe('armed_cured')
    expect(r.timeToArmSeconds).toBe(60)
    expect(r.timeToSaleSeconds).toBeNull()
    expect(r.exposedUsd).toBe(0)
    expect(r.soldShare).toBe(0)
  })

  it('the same wick held past the window sells at expiry', () => {
    const r = run(pos(), { kind: 'wick', drop: 0.25, hours: 10 })
    expect(r.outcome).toBe('sold')
    expect(r.saleReason).toBe('expiry')
    expect(r.timeToSaleSeconds).toBe(EXPIRY_S)
  })

  it('every armed timer resolves inside the horizon (flat tail of one window + a step)', () => {
    const r = run(pos(), step(0.25))
    expect(r.horizonSeconds).toBe(60 + CURE_WINDOW_SECONDS + 60)
  })
})

describe('stress node — carry (recall first, sized to restore borrowable LTV)', () => {
  it('recall cures in the breach call: recall_cured, no timer, draws only the restore amount', () => {
    const r = run(carry({ deployedUsd: 10_000 }), step(0.25))
    expect(r.outcome).toBe('recall_cured')
    expect(r.armed).toBe(false)
    expect(r.timeToArmSeconds).toBeNull()
    // Only 1,300 was needed to get back to the line.
    expect(r.recallNeededUsd).toBeCloseTo(61_300 - 0.8 * 75_000, 6)
    expect(r.recallAvailableUsd).toBe(10_000)
    // UPDATED 2026-10-04 (owner ruling 2, recall from LLTV to borrowable LTV): was 10,000
    // (master asks the FULL debt and drew the whole stock, landing at 51.3k / 75k). The ask
    // is now loan − B × collateral = 61,300 − 0.77 × 75,000 = 3,550, which lands EXACTLY at
    // the borrow LTV and leaves 6,450 deployed.
    expect(r.recallDrawnUsd).toBeCloseTo(61_300 - B * 75_000, 6)
    expect(r.landingLtv).toBeCloseTo(B, 10)
  })

  it('an underwater position is recalled back to its borrow LTV, not closed', () => {
    // UPDATED 2026-10-04 (ruling 2): was 'fully deployed debt is recalled in full' —
    // drawn 61,300, closed 61,300, landing 0. At −60% (40k of collateral, L = 1.53) the
    // ask is 61,300 − 0.77 × 40,000 = 30,500: the position is restored to B, and the other
    // 30,800 stays deployed.
    const r = run(carry({ deployedUsd: 61_300 }), step(0.6))
    expect(r.outcome).toBe('recall_cured')
    expect(r.recallDrawnUsd).toBeCloseTo(30_500, 6)
    expect(r.closedUsd).toBeCloseTo(30_500, 6)
    expect(r.landingLtv).toBeCloseTo(B, 10)
  })

  it('a partial recall that leaves the LTV in the band arms the timer and COMMITS', () => {
    const r = run(carry({ deployedUsd: 1000 }), step(0.25)) // 60.3k / 75k = 0.804
    expect(r.outcome).toBe('sold')
    expect(r.armed).toBe(true)
    expect(r.timeToArmSeconds).toBe(60)
    expect(r.recallDrawnUsd).toBe(1000)
    // The expiry sale is sized on the debt the committed recall already reduced.
    expect(r.exposedUsd).toBeCloseTo(membraneRepayValue(60_300, 75_000, B, D_MIN), 6)
  })

  it('a non-curing recall during a running window is ROLLED BACK (TimerActive revert)', () => {
    // Frozen at the breach → arms with no recall. The venue opens after 4h, but 1,000
    // cannot cure (0.804 > 0.80), so each in-window call reverts and the recall happens
    // only in the expiry call — where the sale is sized on the PRE-recall debt.
    const r = run(carry({ deployedUsd: 1000 }), step(0.25), { freezeHours: 4 })
    expect(r.outcome).toBe('sold')
    expect(r.recallOpensAtSeconds).toBe(60 + 4 * 3600)
    expect(r.timeToSaleSeconds).toBe(EXPIRY_S)
    expect(r.recallDrawnUsd).toBe(1000)
    const ltvPost = 60_300 / 75_000
    const expected = membraneRepayValue(61_300, 61_300 / ltvPost, B, D_MIN) - 1000
    expect(r.exposedUsd).toBeCloseTo(expected, 6)
    // ...which differs from the committed-at-arm case above.
    const committed = run(carry({ deployedUsd: 1000 }), step(0.25))
    expect(Math.abs(r.exposedUsd - committed.exposedUsd)).toBeGreaterThan(100)
  })

  it('a freeze shorter than the window: recall lands inside it → armed_cured', () => {
    const r = run(carry({ deployedUsd: 10_000 }), step(0.25), { freezeHours: 4 })
    expect(r.outcome).toBe('armed_cured')
    expect(r.timeToArmSeconds).toBe(60)
    // UPDATED 2026-10-04 (ruling 2): was 10,000 (the whole stock). The ask is the restore
    // amount, 61,300 − 0.77 × 75,000 = 3,550.
    expect(r.recallDrawnUsd).toBeCloseTo(61_300 - B * 75_000, 6)
    expect(r.exposedUsd).toBe(0)
  })

  it('a freeze longer than the window: recall misses it → sold at expiry, nothing drawn', () => {
    const r = run(carry({ deployedUsd: 10_000 }), step(0.25), { freezeHours: 24 })
    expect(r.outcome).toBe('sold')
    expect(r.recallDrawnUsd).toBe(0)
    expect(r.exposedUsd).toBeCloseTo(membraneRepayValue(61_300, 75_000, B, D_MIN), 6)
  })

  it('a same-call recall + sale is sized on the PRE-recall debt (LE:1311 / :1759)', () => {
    const r = run(carry({ deployedUsd: 2000 }), step(0.3)) // L' = 59.3k / 70k = 0.847 > 0.832
    expect(r.saleReason).toBe('band')
    const ltvPost = 59_300 / 70_000
    const target = membraneRepayValue(61_300, 61_300 / ltvPost, B, D_MIN)
    expect(r.exposedUsd).toBeCloseTo(target - 2000, 6)
    // It therefore lands ABOVE the borrow cap, not on it.
    expect(r.landingLtv as number).toBeGreaterThan(B + 0.004)
  })

  it('exit capacity caps the stock; the multiplier scales it', () => {
    const p = carry({ deployedUsd: 50_000, exitCapacityUsd: 8000 })
    expect(run(p, step(0.25)).recallAvailableUsd).toBe(8000)
    expect(run(p, step(0.25), { capacityMult: 0.5 }).recallAvailableUsd).toBe(4000)
    expect(
      run(carry({ deployedUsd: 6000 }), step(0.25), { capacityMult: 0.1 }).recallAvailableUsd,
    ).toBe(600)
  })
})

// --------------------------------------------------------------- no-delay class

describe('stress node — no-delay class (instant mode)', () => {
  const nd = (o: Partial<StressPosition> = {}) =>
    pos({ membraneClass: 'no-delay', line: 0.88, debtUsd: 70_000, ...o })

  it('crossing the line is the sale: no timer, sold at the shock', () => {
    const r = run(nd(), step(0.25)) // 0.7 / 0.75 = 0.933 > 0.88
    expect(r.outcome).toBe('sold')
    expect(r.armed).toBe(false)
    expect(r.timeToArmSeconds).toBeNull()
    expect(r.timeToSaleSeconds).toBe(60)
    expect(r.saleReason).toBe('band')
    expect(r.breakLine).toBe(0.88)
  })

  it('recall still runs first and can cure', () => {
    const r = run(nd({ tradeShape: 'carry', deployedUsd: 10_000 }), step(0.25))
    expect(r.outcome).toBe('recall_cured')
  })

  it('never arms across a 600-cell random sweep', () => {
    const rnd = prng(0xc0ffee)
    const shapes: ((d: number) => PriceShape)[] = [
      (d) => ({ kind: 'step', drop: d }),
      (d) => ({ kind: 'linear', drop: d, hours: 1 + rnd() * 30 }),
      (d) => ({ kind: 'wick', drop: d, hours: 0.1 + rnd() * 20, recover: rnd() }),
    ]
    let breached = 0
    for (let k = 0; k < 600; k++) {
      const line = 0.86 + rnd() * 0.1
      const p = nd({
        line,
        debtUsd: C * line * (0.3 + rnd() * 0.75),
        tradeShape: rnd() < 0.5 ? 'carry' : 'levered_long',
        deployedUsd: rnd() * 40_000,
      })
      const venue =
        p.tradeShape === 'carry'
          ? rnd() < 0.5
            ? { capacityMult: rnd() }
            : { freezeHours: rnd() * 24 }
          : undefined
      const r = run(p, shapes[k % 3](rnd() * 0.9), venue)
      if (r.timeToBreachSeconds !== null) breached++
      expect(r.outcome).not.toBe('armed_cured')
      expect(r.armed).toBe(false)
      expect(r.timeToArmSeconds).toBeNull()
    }
    expect(breached).toBeGreaterThan(200) // the sweep actually exercises breaches
  })
})

// ---------------------------------------------------------- levered_long: no recall

describe('levered_long has no recall rows', () => {
  it('every recall field is null', () => {
    for (const price of DEFAULT_PRICE_SHAPES) {
      const r = run(pos({ debtUsd: 75_000 }), price)
      expect(r.recallNeededUsd).toBeNull()
      expect(r.recallAvailableUsd).toBeNull()
      expect(r.recallDrawnUsd).toBeNull()
      expect(r.recallOpensAtSeconds).toBeNull()
      expect(r.outcome).not.toBe('recall_cured')
    }
  })

  it('deployedUsd is ignored: same key, same outputs', () => {
    const a = runStress(pos(), { price: step(0.3) })
    const b = runStress(pos({ deployedUsd: 50_000, exitCapacityUsd: 9e9 }), { price: step(0.3) })
    expect(b).toEqual(a)
  })

  it('a venue stress is not modelled; the ×1 baseline is', () => {
    expect(runStress(pos(), { price: step(0.3), venue: { capacityMult: 0.5 } })).toMatchObject({
      outcome: 'not_modelled',
      reason: 'no_recall_levered_long',
    })
    expect(runStress(pos(), { price: step(0.3), venue: { freezeHours: 4 } }).outcome).toBe(
      'not_modelled',
    )
    expect(runStress(pos(), { price: step(0.3), venue: { capacityMult: 1 } }).outcome).toBe('sold')
  })

  it('its grid has the baseline row only', () => {
    const cells = runStressGrid(pos())
    expect(cells).toHaveLength(DEFAULT_PRICE_SHAPES.length)
    expect(cells.every((c) => c.scenario.venue === undefined)).toBe(true)
  })
})

// ------------------------------------------------------------------- the grid

describe('runStressGrid', () => {
  // UPDATED 2026-10-07: the capacity rows were the named ×0.5 / ×0.1; they are now MEASURED
  // cuts of the default preset (EXIT_CAPACITY_DEFAULT_CUTS): Aave USDC's bad event at the $50M
  // book (×0.9032 of its typical ×1) and its everyone-exits floor (×0.1119).
  it('carry: every shape × (×1, the measured cuts, freeze 4/8/24h), single-axis', () => {
    expect(DEFAULT_CAPACITY_MULTS).toEqual([1, 0.9032, 0.1119])
    const cells = runStressGrid(carry({ deployedUsd: 20_000 }))
    expect(cells).toHaveLength(DEFAULT_PRICE_SHAPES.length * 6)
    expect(cells.slice(0, 6).map((c) => c.result.scenarioId)).toEqual([
      'step-10',
      'step-10@cap-x0.9032',
      'step-10@cap-x0.1119',
      'step-10@freeze-4h',
      'step-10@freeze-8h',
      'step-10@freeze-24h',
    ])
    const keys = new Set(cells.map((c) => c.result.cellKey))
    expect(keys.size).toBe(cells.length)
    for (const c of cells) {
      expect(c.result.label).toBe('stress scenario — not a probability')
      expect(c.result.codeVersion).toBe(STRESS_CODE_VERSION)
    }
  })

  it('the ×1 row IS the baseline cell (same key)', () => {
    const p = carry({ deployedUsd: 20_000 })
    expect(runStress(p, { price: step(0.25), venue: { capacityMult: 1 } }).cellKey).toBe(
      runStress(p, { price: step(0.25) }).cellKey,
    )
  })

  it('scenario lists are data: levered_long gets one row per shape', () => {
    expect(stressGridScenarios('levered_long', { shapes: [step(0.4)] })).toEqual([
      { price: step(0.4) },
    ])
  })
})

// ------------------------------------------------------------- reproducibility

describe('reproducibility — cellKey', () => {
  const p = carry({ deployedUsd: 12_345.67, exitCapacityUsd: 40_000 })
  const sc: StressScenario = {
    price: { kind: 'wick', drop: 0.31, hours: 6, recover: 0.8 },
    venue: { freezeHours: 3 },
  }

  it('same inputs ⇒ same key and identical outputs', () => {
    expect(runStress(p, sc)).toEqual(runStress(p, sc))
    expect(runStress({ ...p }, { ...sc })).toEqual(runStress(p, sc))
  })

  it('property order does not matter', () => {
    const reordered: StressPosition = {
      exitCapacityUsd: 40_000,
      deployedUsd: 12_345.67,
      debtMinimumUsd: D_MIN,
      tradeShape: 'carry',
      membraneClass: 'delayed',
      line: 0.8,
      debtUsd: 61_300,
      collateralUsd: C,
    }
    expect(runStress(reordered, sc).cellKey).toBe(runStress(p, sc).cellKey)
  })

  it('inputs that normalize equal share a key AND outputs (the walk runs on the normalized inputs)', () => {
    const a = runStress(p, { price: step(0.25) })
    const b = runStress({ ...p, collateralUsd: C + 0.001 }, { price: step(0.2500000001) })
    expect(b).toEqual(a)
  })

  it('any material change moves the key', () => {
    const base = runStress(p, sc).cellKey
    const variants: [StressPosition, StressScenario][] = [
      [{ ...p, line: 0.801 }, sc],
      [{ ...p, membraneClass: 'no-delay' }, sc],
      [{ ...p, tradeShape: 'levered_long' }, { price: sc.price }],
      [{ ...p, debtUsd: 61_301 }, sc],
      [{ ...p, deployedUsd: 12_000 }, sc],
      [{ ...p, debtMinimumUsd: 100 }, sc],
      [p, { ...sc, venue: { freezeHours: 4 } }],
      [p, { ...sc, price: { kind: 'wick', drop: 0.32, hours: 6, recover: 0.8 } }],
    ]
    const keys = new Set([base, ...variants.map(([vp, vs]) => runStress(vp, vs).cellKey)])
    expect(keys.size).toBe(variants.length + 1)
    expect(runStress(p, sc, { stepSeconds: 300 }).cellKey).not.toBe(base)
  })

  it('the key covers the code version', () => {
    expect(stressCellCanonical(p, sc)).toContain(STRESS_CODE_VERSION)
    expect(runStress(p, sc).cellKey).toMatch(/^sg-[0-9a-f]{16}$/)
  })

  it('a replay is keyed by its ratios, not by array identity', () => {
    const ratios = [1, 0.95, 0.9, null, 0.85, 0.9]
    const a = runStress(p, { price: { kind: 'replay', id: 'x', stepSeconds: 60, ratios } })
    const b = runStress(p, {
      price: { kind: 'replay', id: 'x', stepSeconds: 60, ratios: [...ratios] },
    })
    const c = runStress(p, {
      price: { kind: 'replay', id: 'x', stepSeconds: 60, ratios: [1, 0.95, 0.9, null, 0.84, 0.9] },
    })
    expect(b.cellKey).toBe(a.cellKey)
    expect(c.cellKey).not.toBe(a.cellKey)
  })
})

// ------------------------------------------------------------------ monotonicity

describe('monotonicity — a larger shock is never better', () => {
  const families: [string, (d: number) => PriceShape][] = [
    ['step', (d) => ({ kind: 'step', drop: d })],
    ['linear-24h', (d) => ({ kind: 'linear', drop: d, hours: 24 })],
    ['linear-2h', (d) => ({ kind: 'linear', drop: d, hours: 2 })],
    ['wick-4h', (d) => ({ kind: 'wick', drop: d, hours: 4 })],
    ['wick-12h', (d) => ({ kind: 'wick', drop: d, hours: 12 })],
    ['wick-4h-half', (d) => ({ kind: 'wick', drop: d, hours: 4, recover: 0.5 })],
    // One grid step down, then back: the shape where a SALE call's recall can cover the
    // whole repay target and leave the position over the line (frontier review, bug 1).
    ['wick-1step', (d) => ({ kind: 'wick', drop: d, hours: 1 / 60 })],
  ]
  const singleEvent = new Set(['step', 'wick-4h', 'wick-12h', 'wick-4h-half', 'wick-1step'])

  const positions: StressPosition[] = []
  for (const cls of ['delayed', 'no-delay'] as const) {
    const line = cls === 'delayed' ? 0.8 : 0.9
    for (const ltv of [0.3, 0.613, 0.77, 0.85]) {
      positions.push(pos({ membraneClass: cls, line, debtUsd: ltv * C }))
      for (const share of [0.1, 0.3, 0.9, 1]) {
        positions.push(
          carry({ membraneClass: cls, line, debtUsd: ltv * C, deployedUsd: share * ltv * C }),
        )
      }
    }
  }
  const noRecall = (p: StressPosition) => p.tradeShape === 'levered_long' || !p.deployedUsd

  /** Assert a ladder of nodes (ordered from mild to severe) never improves. */
  function assertLadder(label: string, nodes: StressModelled[], checkShare: boolean) {
    for (let k = 1; k < nodes.length; k++) {
      const [a, b] = [nodes[k - 1], nodes[k]]
      const where = `${label} rung ${k}: ${a.scenarioId} → ${b.scenarioId}`
      expect(stressRank(b), where).toBeGreaterThanOrEqual(stressRank(a))
      if (a.timeToSaleSeconds !== null) {
        expect(b.timeToSaleSeconds, where).not.toBeNull()
        expect(b.timeToSaleSeconds as number, where).toBeLessThanOrEqual(a.timeToSaleSeconds)
      }
      if (checkShare) expect(b.soldShare, where).toBeGreaterThanOrEqual(a.soldShare - 1e-12)
    }
  }

  it('price depth: rank and time-to-sale on every family; sold share where no recall', () => {
    const drops = Array.from({ length: 50 }, (_, k) => k / 50)
    for (const p of positions) {
      for (const [name, f] of families) {
        const nodes = drops.map((d) => run(p, f(d)))
        assertLadder(
          `${p.membraneClass}/${p.tradeShape}/${p.debtUsd}/${name}`,
          nodes,
          noRecall(p) && singleEvent.has(name),
        )
      }
    }
  })

  it('price depth, one-step wick, dense (0.25% rungs): the narrow recall-covers-target band', () => {
    const drops = Array.from({ length: 397 }, (_, k) => k / 400)
    const f = families.find(([name]) => name === 'wick-1step')![1]
    for (const p of positions) {
      const nodes = drops.map((d) => run(p, f(d)))
      assertLadder(
        `${p.membraneClass}/${p.tradeShape}/${p.debtUsd}/${p.deployedUsd ?? 0}/wick-1step dense`,
        nodes,
        noRecall(p),
      )
    }
  })

  it('venue exit capacity: less is never better', () => {
    const mults = Array.from({ length: 21 }, (_, k) => 1 - k / 20)
    for (const p of positions.filter((x) => x.tradeShape === 'carry')) {
      for (const [name, f] of families) {
        for (const d of [0.2, 0.3, 0.45]) {
          const nodes = mults.map((mult) => run(p, f(d), { capacityMult: mult }))
          assertLadder(`cap ${name} ${d}`, nodes, false)
        }
      }
    }
  })

  it('venue freeze: longer is never better', () => {
    const hours = Array.from({ length: 31 }, (_, k) => k)
    for (const p of positions.filter((x) => x.tradeShape === 'carry')) {
      for (const [name, f] of families) {
        for (const d of [0.2, 0.3, 0.45]) {
          const nodes = hours.map((h) => run(p, f(d), { freezeHours: h }))
          assertLadder(`freeze ${name} ${d}`, nodes, false)
        }
      }
    }
  })

  it('starting LTV: higher is never better', () => {
    const ltvs = Array.from({ length: 40 }, (_, k) => k / 50)
    for (const p of positions) {
      for (const [name, f] of families) {
        for (const d of [0.5, 0.6]) {
          const nodes = ltvs.map((x) => run(withStartLtv(p, x), f(d)))
          assertLadder(`ltv ${name} ${d}`, nodes, noRecall(p) && singleEvent.has(name))
        }
      }
    }
  })

  it('PINNED: with recall, less capacity can sell LESS — but sooner (master same-call sizing)', () => {
    // 70k debt, 100k collateral, 7k deployed, −20% step: L_pre = 0.875 (past the band).
    // ×0.5: 3,500 recalled → 0.83125, inside the band → arms; expiry sale sized on the
    //       reduced debt → lands on the 0.77 borrow cap.
    // ×0.475: 3,325 recalled → 0.8334, past the band → immediate sale sized on the
    //       PRE-recall debt → under-sized by recall × (1 − f), lands above the cap.
    // If master changes `_getRepayQuantities` to use the post-recall debt, this pin must move.
    const p = carry({ debtUsd: 70_000, deployedUsd: 7000 })
    const more = run(p, step(0.2), { capacityMult: 0.5 })
    const less = run(p, step(0.2), { capacityMult: 0.475 })
    expect([more.outcome, less.outcome]).toEqual(['sold', 'sold'])
    expect(less.timeToSaleSeconds as number).toBeLessThan(more.timeToSaleSeconds as number)
    expect(less.soldShare).toBeLessThan(more.soldShare)
    expect(more.landingLtv).toBeCloseTo(B, 9)
    expect(less.landingLtv as number).toBeGreaterThan(B + 0.005)
  })
})

// ----------------------------------------- regressions (frontier review 2026-10-04)

describe('a SALE call whose recall covers the whole repay target', () => {
  // 61.3k debt, 55,170 deployed (90%). A one-step wick: the keeper calls once at the
  // trough, the price is back one step later. The target is sized on the PRE-recall debt
  // at the POST-recall LTV, while the recall draws up to its restore-to-borrow-LTV ask
  // (ruling 2; here 61,300 − 0.77 × 7,000 = 55,910, past the 55,170 stock, so the whole
  // stock comes back — as under master's full-debt ask, LE:1320), so the recall can exceed
  // the target (LE:1311, :1759): nothing is sold, the call commits, and
  // the position is left OVER the line with its timer cleared (Cdp.sol STEP 6 only
  // requires the LTV not to rise).
  const p = carry({ deployedUsd: 55_170 })
  const wick1 = (d: number): PriceShape => ({ kind: 'wick', drop: d, hours: 1 / 60 })

  it('is recall_liquidated, never recall_cured', () => {
    // −93%: 7,000 collateral; post-recall LTV 6,130 / 7,000 = 0.8757 > 0.832 → Immediate.
    expect(membraneRepayValue(61_300, 70_000, B, D_MIN)).toBeLessThan(55_170)
    const r = run(p, wick1(0.93))
    expect(r.outcome).toBe('recall_liquidated')
    expect(r.armed).toBe(false)
    expect(r.timeToArmSeconds).toBeNull()
    expect(r.sales).toBe(0)
    expect(r.exposedUsd).toBe(0)
    expect(r.timeToSaleSeconds).toBeNull()
    expect(r.recallDrawnUsd).toBe(55_170)
    expect(r.closedUsd).toBe(55_170)
  })

  it('ranks between armed_cured and sold, so a deeper wick is never better', () => {
    // −90%: recall alone gets to 0.613 (recall_cured). −92.5%: 0.8173, in the band (arms,
    // recall commits, price recovers). −93%: past the band, recall covers the target.
    // −93.7%: past the band, the target exceeds the recall by ~$430 → collateral sold.
    const ladder = [0.9, 0.925, 0.93, 0.937].map((d) => run(p, wick1(d)))
    expect(ladder.map((r) => r.outcome)).toEqual([
      'recall_cured',
      'armed_cured',
      'recall_liquidated',
      'sold',
    ])
    for (let k = 1; k < ladder.length; k++) {
      expect(stressRank(ladder[k])).toBeGreaterThan(stressRank(ladder[k - 1]))
    }
  })

  it('no-delay class: same outcome, still never armed', () => {
    // line 0.88, 70k debt, 63k deployed. −90%: 7,000 left, LTV over the line after recall.
    const nd = carry({
      membraneClass: 'no-delay',
      line: 0.88,
      debtUsd: 70_000,
      deployedUsd: 63_000,
    })
    const r = run(nd, wick1(0.9)) // post-recall 7,000 / 10,000 = 0.70: recall cures
    expect(r.outcome).toBe('recall_cured')
    const s = run(nd, wick1(0.91)) // post-recall 7,000 / 9,000 = 0.778: still cures
    expect(s.outcome).toBe('recall_cured')
    const t = run(nd, wick1(0.925)) // post-recall 7,000 / 7,500 = 0.933 > 0.88: sale call
    expect(membraneRepayValue(70_000, 75_000, 0.85, D_MIN)).toBeLessThan(63_000)
    expect(t.outcome).toBe('recall_liquidated')
    expect(t.armed).toBe(false)
    expect(t.timeToArmSeconds).toBeNull()
  })
})

// ----------------------------------------- regressions (frontier review, round 2)

describe('soldShare is not monotone in the shock — ordering lives in the rank', () => {
  it('crossing the band break: an expiry sale on the reduced debt → an immediate sale on the pre-recall debt', () => {
    // 70k / 100k, 3.5k deployed. −20%: recall → 0.83125, inside the band, arms and
    // commits; the expiry sale is sized on 66.5k. −20.1%: past the band, immediate, sized
    // on the PRE-recall 70k at the post-recall LTV with the recall netted off.
    const p = carry({ debtUsd: 70_000, deployedUsd: 3_500 })
    const [a, b] = [run(p, step(0.2)), run(p, step(0.201))]
    expect([a.outcome, b.outcome]).toEqual(['sold', 'sold'])
    expect([a.saleReason, b.saleReason]).toEqual(['expiry', 'band'])
    expect(a.soldShare).toBeCloseTo(0.2663, 4)
    expect(b.soldShare).toBeCloseTo(0.2413, 4)
    expect(b.soldShare).toBeLessThan(a.soldShare)
  })

  it('debt-floor band, levered long: the remainder guard closes the whole loan on both sides of the old edge', () => {
    // 3,000 debt on 4,000. −17.5%: L = 0.909, partial target 1,995 < 2,000 → the floor
    // makes it the WHOLE 3,000 loan (3,000 − 2,000 < 2,000; LE:2726-2727). −17.6%: the
    // partial target passes 2,000.
    // UPDATED 2026-10-04 (owner ruling 1): under master's no-guard floor that 2,000+ target
    // stood (b.soldShare 0.6095, below a's 0.9091). With the remainder guard it would leave
    // 3,000 − 2,0xx < 2,000, so it too becomes the whole loan: b closes 3,000 and, at a
    // slightly lower price, sells slightly MORE collateral than a.
    const p = pos({ collateralUsd: 4_000, debtUsd: 3_000 })
    const [a, b] = [run(p, step(0.175)), run(p, step(0.176))]
    expect([a.outcome, b.outcome]).toEqual(['sold', 'sold'])
    expect(a.closedUsd).toBeCloseTo(3_000, 9)
    expect(b.closedUsd).toBeCloseTo(3_000, 9)
    expect(a.soldShare).toBeCloseTo(0.9091, 4)
    expect(b.soldShare).toBeCloseTo(0.9102, 4)
  })
})

describe('debt-floor band — the sale-path entry stays monotone; the ruled guard closes the island', () => {
  // Debt in [dMin, 2·dMin) with a recall of dMin or more: under master's no-guard floor a
  // deeper shock could turn a sale into recall_liquidated and back (frontier.test.ts pins
  // the frontier side). What must hold is that "rank >= recall_liquidated" never falls —
  // frontier.ts bisects on it.
  const salePath = (r: StressModelled) => stressRank(r) >= STRESS_SEVERITY.recall_liquidated
  const rnd = prng(20261004)
  const band: StressPosition[] = []
  for (let k = 0; k < 24; k++) {
    const noDelay = k % 2 === 1
    const line = noDelay ? 0.86 + 0.1 * rnd() : 0.7 + 0.2 * rnd()
    const debtUsd = D_MIN + (D_MIN - 1) * rnd()
    const collateralUsd = debtUsd / (0.4 + (line - 0.42) * rnd())
    band.push(
      carry({
        membraneClass: noDelay ? 'no-delay' : 'delayed',
        line,
        debtUsd,
        collateralUsd,
        deployedUsd: D_MIN + (debtUsd - D_MIN) * rnd(),
      }),
    )
  }

  it('dense one-step wick and step: the entry never falls, and sold no longer falls in the band', () => {
    const drops = Array.from({ length: 991 }, (_, k) => k / 1000)
    let soldFell = 0
    for (const p of band) {
      for (const f of [
        (d: number): PriceShape => ({ kind: 'wick', drop: d, hours: 1 / 60 }),
        step,
      ]) {
        let entered = false
        let wasSold = false
        for (const d of drops) {
          const r = run(p, f(d))
          const onPath = salePath(r)
          if (entered)
            expect(onPath, `${p.debtUsd.toFixed(2)}/${p.deployedUsd?.toFixed(2)} at ${d}`).toBe(
              true,
            )
          entered = onPath
          if (wasSold && r.outcome !== 'sold') soldFell++
          wasSold = r.outcome === 'sold'
        }
      }
    }
    // UPDATED 2026-10-04 (owner ruling 1): was `> 0` — the island was real under master's
    // no-guard floor. With the remainder guard every sale target in [dMin, 2·dMin) is the
    // whole loan (a sub-dMin one lifts to it, a dMin+ one would strand < dMin), so a sale
    // call always sells the loan net of the recall and "sold" cannot fall here any more.
    expect(soldFell).toBe(0)
  })

  it('levered long in the band: no recall, so the rank itself stays monotone', () => {
    const drops = Array.from({ length: 199 }, (_, k) => k / 200)
    for (const p of band.map((b) => ({
      ...b,
      tradeShape: 'levered_long' as const,
      deployedUsd: undefined,
    }))) {
      const nodes = drops.map((d) => run(p, step(d)))
      for (let k = 1; k < nodes.length; k++) {
        expect(stressRank(nodes[k])).toBeGreaterThanOrEqual(stressRank(nodes[k - 1]))
      }
    }
  })
})

describe('debt floor on the ARRIVAL — a short recall never strands sub-floor debt (owner ruling 2026-10-04)', () => {
  // The finding's input: $3,000 debt on $3,300 (LTV 90.9%) at a 90% line, delayed class,
  // flat price. The restore ask ($129) lifts to the whole loan (loan < 2 × dMin); the venue
  // holds $2,500. The recall alone lands at LTV 15.2% — under the line — but leaves $500.
  const short = (o: Partial<StressPosition> = {}) =>
    carry({
      collateralUsd: 3_300,
      debtUsd: 3_000,
      line: 0.9,
      deployedUsd: 3_000,
      exitCapacityPreset: undefined,
      exitCapacityUsd: 2_500,
      ...o,
    })

  it('recall-only lane: the call repays ALL — the remainder sells, the loan closes', () => {
    const r = run(short(), step(0))
    // Before: 'recall_cured', closedUsd 2,500, $500 owed at landing LTV 0.1515.
    expect(r.outcome).toBe('sold')
    expect(r.saleReason).toBe('floor')
    expect(r.recallDrawnUsd).toBeCloseTo(2_500, 9)
    expect(r.exposedUsd).toBeCloseTo(500, 9)
    expect(r.closedUsd).toBeCloseTo(3_000, 9)
    expect(r.landingLtv).toBe(0)
    expect(r.badDebtUsd).toBe(0)
    expect(r.armed).toBe(false)
    expect(r.timeToSaleSeconds).toBe(0)
  })

  it('a remainder of exactly dMin stands, and enough venue capital is a clean cure', () => {
    // $1,000 from the venue leaves exactly $2,000: the floor is strict (LE:2721), so the
    // recall-only cure stands. A venue holding the whole loan repays it with nothing sold.
    const exact = run(short({ exitCapacityUsd: 1_000 }), step(0))
    expect(exact.outcome).toBe('recall_cured')
    expect(exact.closedUsd).toBeCloseTo(1_000, 9)
    expect(exact.landingLtv).toBeCloseTo(2_000 / 3_300, 9)
    const whole = run(short({ exitCapacityUsd: 3_000 }), step(0))
    expect(whole.outcome).toBe('recall_cured')
    expect(whole.exposedUsd).toBe(0)
    expect(whole.landingLtv).toBe(0)
  })

  it('TimerStarted lane: a recall that would commit dust closes the loan instead of arming', () => {
    // $3,000 on $1,100: the ask is the whole loan, the venue's $2,000 leaves $1,000 at LTV
    // 90.9% — inside the 4% band, so master's TimerStarted would COMMIT the recall and
    // open the window with $1,000 owed. Before: armed, then sold at the 8h expiry.
    const r = run(short({ collateralUsd: 1_100, exitCapacityUsd: 2_000 }), step(0))
    expect(r.outcome).toBe('sold')
    expect(r.saleReason).toBe('floor')
    expect(r.armed).toBe(false)
    expect(r.timeToArmSeconds).toBeNull()
    expect(r.exposedUsd).toBeCloseTo(1_000, 9)
    expect(r.closedUsd).toBeCloseTo(3_000, 9)
  })

  it('sale lane: a recall past the formula target still repays all when it would leave dust', () => {
    // No-delay class, 0.95 line: $10,000 on $2,000. The ask is the whole loan (B × coll =
    // $1,840 < dMin); the venue's $8,080 leaves $1,920 at LTV 96% — over the line, so the
    // call SELLS. Its formula target (pre-recall debt at the post-recall LTV) is $5,208, and
    // the recall is past it. Before: that call sold nothing and left $1,920 owed; the NEXT
    // call (loan now under dMin, LE:2722-2723) sold it — so the dust stood for one call.
    const r = run(
      short({
        membraneClass: 'no-delay',
        line: 0.95,
        collateralUsd: 2_000,
        debtUsd: 10_000,
        deployedUsd: 10_000,
        exitCapacityUsd: 8_080,
      }),
      step(0),
    )
    expect(r.outcome).toBe('sold')
    expect(r.saleReason).toBe('band')
    expect(r.recallDrawnUsd).toBeCloseTo(8_080, 9)
    expect(r.exposedUsd).toBeCloseTo(1_920, 9)
    expect(r.closedUsd).toBeCloseTo(10_000, 9)
    expect(r.landingLtv).toBe(0)
    expect(r.sales).toBe(1)
    expect(r.timeToSaleSeconds).toBe(0) // on the call itself, not the one after
  })
})

describe('exit capacity is explicit — no optimistic default (owner ruling 2026-10-04)', () => {
  it('a carry position with capital deployed and no capacity is not modelled', () => {
    const r = runStress(carry({ deployedUsd: 10_000, exitCapacityPreset: undefined }), {
      price: step(0.25),
    })
    expect(r.outcome).toBe('not_modelled')
    expect(r.outcome === 'not_modelled' && r.reason).toBe('no_exit_capacity')
  })

  // UPDATED 2026-10-06 (owner instruction: measured venue analogs replace the named ×0.5 /
  // ×0.1 levels): the preset this pinned was 'stressed' (×0.5); it is now the measured
  // 'aave-usdc-floor-typical' (×0.1119). A LOCKED preset is not the same node as its multiple.
  it('a custom multiple resolves like an unlocked preset; USD wins, then the preset, then the multiple', () => {
    const dep = { deployedUsd: 10_000, exitCapacityPreset: undefined }
    const at = (o: Partial<StressPosition>) =>
      runStress(carry({ ...dep, ...o }), { price: step(0.25) })
    const stock = (o: Partial<StressPosition>) => {
      const r = at(o)
      return r.outcome === 'not_modelled' ? r.reason : r.recallAvailableUsd
    }
    expect(stock({ exitCapacityMult: 0.5 })).toBe(5_000)
    const typical = EXIT_CAPACITY_PRESETS['aave-usdc-floor-typical']
    expect(typical.freezeHours).toBe(0)
    expect(at({ exitCapacityMult: typical.mult }).cellKey).toBe(
      at({ exitCapacityPreset: 'aave-usdc-floor-typical' }).cellKey,
    )
    // The Kelp lock is part of the node: ×0 with a 45 h lock is not custom ×0.
    expect(at({ exitCapacityMult: 0 }).cellKey).not.toBe(
      at({ exitCapacityPreset: 'aave-usdc-floor-worst' }).cellKey,
    )
    expect(stock({ exitCapacityMult: 0.5, exitCapacityPreset: 'aave-usdc-floor-bad' })).toBeCloseTo(
      10_000 * EXIT_CAPACITY_PRESETS['aave-usdc-floor-bad'].mult,
      6,
    )
    expect(stock({ exitCapacityMult: 0.5, exitCapacityUsd: 2_500 })).toBe(2_500)
    expect(stock({ exitCapacityMult: NaN })).toBe('invalid_position')
    expect(stock({ exitCapacityMult: -0.1 })).toBe('invalid_position')
  })

  it('nothing deployed needs no capacity; levered long never does', () => {
    const none = runStress(carry({ deployedUsd: undefined, exitCapacityPreset: undefined }), {
      price: step(0.25),
    })
    expect(none.outcome).not.toBe('not_modelled')
    const lev = runStress(pos({ exitCapacityPreset: undefined }), { price: step(0.25) })
    expect(lev.outcome).not.toBe('not_modelled')
  })

  // UPDATED 2026-10-07 (owner ruling: cash vs book is the headline, pro-rata the floor): per
  // venue the three levels at each book ($10M, $50M, $250M), then its everyone-exits floor; then
  // the two bounds, upper bound last. Was: one pro-rata set per venue (now the floor).
  it('measured analogs per venue (books, then the floor), then frozen, then the upper bound', () => {
    expect(EXIT_CAPACITY_PRESET_ORDER).toHaveLength(EXIT_CAPACITY_VENUES.length * 12 + 2)
    expect(EXIT_CAPACITY_PRESET_ORDER.slice(0, 12)).toEqual([
      'aave-usdc-10m-typical',
      'aave-usdc-10m-bad',
      'aave-usdc-10m-worst',
      'aave-usdc-50m-typical',
      'aave-usdc-50m-bad',
      'aave-usdc-50m-worst',
      'aave-usdc-250m-typical',
      'aave-usdc-250m-bad',
      'aave-usdc-250m-worst',
      'aave-usdc-floor-typical',
      'aave-usdc-floor-bad',
      'aave-usdc-floor-worst',
    ])
    expect(EXIT_CAPACITY_PRESET_ORDER.slice(-2)).toEqual(['frozen', 'optimistic'])
    expect(new Set(EXIT_CAPACITY_PRESET_ORDER).size).toBe(EXIT_CAPACITY_PRESET_ORDER.length)
    expect(Object.keys(EXIT_CAPACITY_PRESETS).sort()).toEqual(
      [...EXIT_CAPACITY_PRESET_ORDER].sort(),
    )
    // Owner ruling 2026-10-07: the default is typical Aave USDC stress at a $50M book.
    expect(EXIT_CAPACITY_DEFAULT_PRESET).toBe('aave-usdc-50m-typical')
    for (const id of EXIT_CAPACITY_PRESET_ORDER) {
      const x = EXIT_CAPACITY_PRESETS[id]
      expect(x.id).toBe(id)
      expect(x.mult).toBeGreaterThanOrEqual(0)
      expect(x.mult).toBeLessThanOrEqual(1)
      expect(x.provenance.length).toBeGreaterThan(20)
      // Copy rules: never "0%" or "free".
      expect(x.provenance).not.toMatch(/\b0%|free/i)
      expect(x.label).not.toMatch(/\b0%|free/i)
      // A ×1 is never silent: the label says so whenever the level resolves to ×1.
      expect(/×1\b/.test(x.label), id).toBe(x.mult >= 1)
      if (x.kind !== 'measured') {
        expect(x.source).toBeNull()
        expect(x.model).toBeNull()
        continue
      }
      const src = x.source!
      expect(x.model).toBe(src.model)
      if (src.model === 'cash-vs-book') {
        expect(id).toBe(`${src.slug}-${src.book}-${src.level}`)
        expect(x.bookUsd).toBe(src.bookUsd)
        expect(src.provenance).toContain('Cash vs book')
      } else {
        expect(id).toBe(`${src.slug}-floor-${src.level}`)
        expect(x.bookUsd).toBeNull()
        expect(src.provenance).toContain('Floor: every depositor exits at once')
      }
      expect(x.mult).toBe(src.mult)
      // The lock reaches the engine only for a locked event, and then it is the measured lock.
      expect(x.freezeHours).toBe(src.locked ? src.lockH : 0)
      if (src.locked) expect(src.mult).toBeLessThanOrEqual(0.01)
      else expect(src.mult).toBeGreaterThanOrEqual(0.01)
      expect(src.n).toBeGreaterThan(0)
      expect(src.windows).toContain(src.windowId)
      expect(src.from <= src.onset && src.onset <= src.to).toBe(true)
    }
    for (const v of EXIT_CAPACITY_VENUES) {
      for (const ids of [...Object.values(v.books), v.floor]) {
        const [t, b, w] = ids.map((id) => EXIT_CAPACITY_PRESETS[id].source!)
        if (!b.locked) expect(t.mult).toBeGreaterThanOrEqual(b.mult)
        expect(w.rank).toBe(1)
        expect(b.rank).toBeLessThanOrEqual(t.rank)
        if (!b.locked) expect(b.mult).toBeGreaterThanOrEqual(w.mult)
      }
    }
    // The owner's benchmark venue, pinned. Floor: typical ≈ 11% of deposits over the 8 h
    // window; worst = Kelp Apr-2026, under 0.01% and locked 45 h.
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-floor-typical'].mult).toBe(0.1119)
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-floor-worst']).toMatchObject({
      mult: 0,
      freezeHours: 45,
    })
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-floor-worst'].source!.event).toBe('Kelp Apr-2026')
    // Cash vs book: the idle cash covered a $10M and a $50M book in the typical event (×1),
    // 81.25% of a $250M one; the bad event ($45.2M) 90.32% of $50M; Kelp is locked at every
    // book, longer the larger the book.
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-10m-typical'].mult).toBe(1)
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-50m-typical'].mult).toBe(1)
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-250m-typical'].mult).toBe(0.8125)
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-50m-bad'].mult).toBe(0.9032)
    expect(EXIT_CAPACITY_PRESETS['aave-usdc-250m-bad'].mult).toBe(0.1806)
    const kelp = (['10m', '50m', '250m'] as const).map(
      (b) => EXIT_CAPACITY_PRESETS[`aave-usdc-${b}-worst`],
    )
    expect(kelp.map((k) => k.source!.event)).toEqual(Array(3).fill('Kelp Apr-2026'))
    expect(kelp.map((k) => k.freezeHours)).toEqual([11, 16, 45])
    expect(EXIT_CAPACITY_PRESETS.frozen).toMatchObject({
      kind: 'theoretical-bound',
      mult: 0,
      freezeHours: 0,
    })
    expect(EXIT_CAPACITY_PRESETS.optimistic).toMatchObject({ kind: 'upper-bound', mult: 1 })
    expect(EXIT_CAPACITY_PRESETS.optimistic.provenance).toMatch(/upper bound only, never a default/)
  })

  // Review 2026-10-07: no arbitrary multiplier default is left; the cuts are measured.
  it('the default capacity cuts are measured from the default preset', () => {
    const d = EXIT_CAPACITY_PRESETS[EXIT_CAPACITY_DEFAULT_PRESET]
    expect(EXIT_CAPACITY_DEFAULT_CUTS.map((c) => [c.id, c.from])).toEqual([
      ['bad', 'aave-usdc-50m-bad'],
      ['floor', 'aave-usdc-floor-typical'],
    ])
    for (const c of EXIT_CAPACITY_DEFAULT_CUTS) {
      expect(c.mult).toBeCloseTo(EXIT_CAPACITY_PRESETS[c.from].mult / d.mult, 4)
      expect(EXIT_CAPACITY_PRESETS[c.from].kind).toBe('measured')
    }
    expect(DEFAULT_CAPACITY_MULTS[0]).toBe(1)
    expect(DEFAULT_CAPACITY_MULTS.slice(1)).toEqual(
      EXIT_CAPACITY_DEFAULT_CUTS.map((c) => c.mult).filter((m) => m < 1),
    )
    for (const m of DEFAULT_CAPACITY_MULTS) expect([0.5, 0.1]).not.toContain(m)
  })

  // UPDATED 2026-10-06: the ladder pinned optimistic/stressed cure, kelp-lock/frozen sell. The
  // rule is unchanged — 61,300 on 75,000 needs 1,300 to reach the line — and is now checked
  // on every preset, including when a measured lock opens the venue.
  it('a preset resolves against the deployed amount; the stock and its lock follow it', () => {
    for (const id of EXIT_CAPACITY_PRESET_ORDER) {
      const x = EXIT_CAPACITY_PRESETS[id]
      const r = run(carry({ deployedUsd: 10_000, exitCapacityPreset: id }), step(0.25))
      expect(r.recallAvailableUsd).toBeCloseTo(exitCapacityFromPreset(10_000, id), 6)
      // The lock runs from the first breach (the step lands one grid step in).
      expect(r.recallOpensAtSeconds, id).toBe(r.timeToBreachSeconds! + x.freezeHours * 3600)
      const stockOk = r.recallAvailableUsd! >= 1_300
      const expected = !stockOk
        ? 'sold'
        : x.freezeHours === 0
          ? 'recall_cured'
          : x.freezeHours * 3600 < CURE_WINDOW_SECONDS
            ? 'armed_cured'
            : 'sold'
      expect(r.outcome, id).toBe(expected)
    }
    const outcome = (id: (typeof EXIT_CAPACITY_PRESET_ORDER)[number]) =>
      run(carry({ deployedUsd: 10_000, exitCapacityPreset: id }), step(0.25)).outcome
    expect(outcome('optimistic')).toBe('recall_cured')
    // UPDATED 2026-10-07: Steakhouse typical is ×0.1057 on the pro-rata basis (was ×0.2183,
    // first in line), so it no longer covers $1,300; Aave USDe typical does.
    expect(outcome('aave-usde-floor-typical')).toBe('recall_cured') // ×0.2302: $2,302
    expect(outcome('steakhouse-usdc-floor-typical')).toBe('sold') // ×0.1057: $1,057 < $1,300
    expect(outcome('aave-usdc-floor-typical')).toBe('sold') // ×0.1119: $1,119 < $1,300
    // Cash vs book (2026-10-07): the default ($50M book, ×1) cures; Steakhouse at $50M (×0.3002)
    // covers $1,300 too; Kelp at $50M (×0.0001 behind a 16 h lock) does not.
    expect(outcome('aave-usdc-50m-typical')).toBe('recall_cured')
    expect(outcome('steakhouse-usdc-50m-typical')).toBe('recall_cured') // $3,002
    expect(outcome('aave-usdc-50m-worst')).toBe('sold')
    expect(outcome('frozen')).toBe('sold')
    // Frozen is the no-recall walk exactly.
    const frozen = run(carry({ deployedUsd: 10_000, exitCapacityPreset: 'frozen' }), step(0.25))
    const lev = run(pos(), step(0.25))
    expect(frozen.exposedUsd).toBeCloseTo(lev.exposedUsd, 9)
    expect(frozen.recallDrawnUsd).toBe(0)
  })

  it('a locked preset gives no recall for its measured lock from the first breach', () => {
    // Spark DAI worst (Dec-2024; UPDATED 2026-10-07, was Nov-2023 ×0.0068 / 78 h: the lock is
    // now the one its 8 h window runs into): ×0.0005 and a 17 h lock. On $75,000 the debt sits
    // half the $5 stock over the $60,000 line — the stock covers it, but only after the lock,
    // past the 8 h window.
    const x = EXIT_CAPACITY_PRESETS['spark-dai-floor-worst']
    expect(x.mult).toBeGreaterThan(0)
    expect(x.freezeHours).toBeGreaterThan(CURE_WINDOW_SECONDS / 3600)
    const stock = 10_000 * x.mult
    const base = carry({
      debtUsd: 60_000 + stock / 2,
      deployedUsd: 10_000,
      exitCapacityPreset: undefined,
    })
    const custom = run({ ...base, exitCapacityMult: x.mult }, step(0.25))
    expect(custom.outcome).toBe('recall_cured')
    const locked = run({ ...base, exitCapacityPreset: 'spark-dai-floor-worst' }, step(0.25))
    expect(locked.outcome).toBe('sold')
    expect(locked.saleReason).toBe('expiry')
    expect(locked.recallDrawnUsd).toBe(0)
    expect(locked.recallOpensAtSeconds).toBe(locked.timeToBreachSeconds! + x.freezeHours * 3600)
    // The lock is a freeze from the first breach: the same walk as custom ×mult frozen as long.
    const asFreeze = run({ ...base, exitCapacityMult: x.mult }, step(0.25), {
      freezeHours: x.freezeHours,
    })
    const strip = (r: StressModelled) => ({ ...r, cellKey: '', scenarioId: '' })
    expect(strip(locked)).toEqual(strip(asFreeze))
    // A scenario freeze and the lock overlap: the venue answers once both are over.
    const shorter = run({ ...base, exitCapacityPreset: 'spark-dai-floor-worst' }, step(0.25), {
      freezeHours: 4,
    })
    expect(shorter.recallOpensAtSeconds).toBe(locked.recallOpensAtSeconds)
    const longer = run({ ...base, exitCapacityPreset: 'spark-dai-floor-worst' }, step(0.25), {
      freezeHours: 100,
    })
    expect(longer.recallOpensAtSeconds).toBe(locked.timeToBreachSeconds! + 100 * 3600)
  })

  it('an explicit USD capacity wins over a preset — and drops its lock; an unknown preset is invalid', () => {
    const r = run(
      carry({ deployedUsd: 10_000, exitCapacityUsd: 2_500, exitCapacityPreset: 'frozen' }),
      step(0.25),
    )
    expect(r.recallAvailableUsd).toBe(2_500)
    const kelp = run(
      carry({
        deployedUsd: 10_000,
        exitCapacityUsd: 2_500,
        exitCapacityPreset: 'aave-usdc-floor-worst',
      }),
      step(0.25),
    )
    expect(kelp.recallAvailableUsd).toBe(2_500)
    expect(kelp.recallOpensAtSeconds).toBe(kelp.timeToBreachSeconds)
    const bad = runStress(carry({ deployedUsd: 10_000, exitCapacityPreset: 'bogus' as never }), {
      price: step(0.25),
    })
    expect(bad.outcome === 'not_modelled' && bad.reason).toBe('invalid_position')
    // The retired named levels are unknown ids now (no URL or store encoded them).
    for (const old of ['stressed', 'kelp-lock']) {
      const o = runStress(carry({ deployedUsd: 10_000, exitCapacityPreset: old as never }), {
        price: step(0.25),
      })
      expect(o.outcome === 'not_modelled' && o.reason).toBe('invalid_position')
    }
  })

  it('stressPositionFromProtocol carries the preset through', () => {
    const p = {
      protocol: 'aave-v3',
      label: 'x',
      collateral: [
        {
          symbol: 'WETH',
          address: '0x0',
          decimals: 18,
          amount: 1,
          priceUsd: 100_000,
          valueUsd: 100_000,
          liquidationThreshold: 0.83,
          maxLtv: 0.8,
          liquidationBonus: 0.05,
        },
      ],
      debt: [
        {
          symbol: 'USDC',
          address: '0x0',
          decimals: 6,
          amount: 60_000,
          priceUsd: 1,
          valueUsd: 60_000,
          borrowApr: null,
        },
      ],
      totalCollateralUsd: 100_000,
      totalDebtUsd: 60_000,
      ltv: 0.6,
      liquidationLtv: 0.83,
      healthFactor: 1.38,
      provenance: stamp('mock', 'test', 'synthetic'),
    } as ProtocolPosition
    const out = stressPositionFromProtocol(p, {
      tradeShape: 'carry',
      deployedUsd: 8_000,
      exitCapacityPreset: 'aave-usdc-floor-typical', // UPDATED 2026-10-06: was 'stressed' (×0.5)
    })
    expect(out.ok && out.position.exitCapacityPreset).toBe('aave-usdc-floor-typical')
    if (out.ok) expect(run(out.position, step(0.25)).recallAvailableUsd).toBeCloseTo(895.2, 6)
  })
})

describe('an ABSOLUTE venue level — VenueStress.exitCapacityPreset (review 2026-10-07)', () => {
  // The tree's everyone-exits lane used to be a ×0.1119 CUT of whatever the position chose, so
  // under Aave USDC $50M worst (×0.0001) it ran ×0.0000112 and still read "everyone exits".
  // A venue level REPLACES the chosen capacity and lock instead.
  const strip = (r: StressModelled) => ({ ...r, cellKey: '', scenarioId: '' })
  const chosen = carry({ deployedUsd: 10_000, exitCapacityPreset: 'aave-usdc-50m-worst' })

  it('replaces the chosen capacity and lock — the same walk as choosing the level itself', () => {
    const floor = run(chosen, step(0.25), { exitCapacityPreset: 'aave-usdc-floor-typical' })
    expect(floor.recallAvailableUsd).toBeCloseTo(
      exitCapacityFromPreset(10_000, 'aave-usdc-floor-typical'),
      6,
    ) // ×0.1119 of $10,000, not ×0.1119 of the chosen $1
    expect(floor.recallAvailableUsd).toBeCloseTo(1_119, 6)
    expect(floor.recallOpensAtSeconds).toBe(floor.timeToBreachSeconds) // the 16 h lock is gone
    const direct = run({ ...chosen, exitCapacityPreset: 'aave-usdc-floor-typical' }, step(0.25))
    expect(strip(floor)).toEqual(strip(direct))
    // Its own lock replaces the position's: Aave USDC worst floor (×0, 45 h) over the ×1 bound.
    const x = EXIT_CAPACITY_PRESETS['aave-usdc-floor-worst']
    expect(x.freezeHours).toBeGreaterThan(0)
    const kelp = run(carry({ deployedUsd: 10_000 }), step(0.25), {
      exitCapacityPreset: 'aave-usdc-floor-worst',
    })
    expect(kelp.recallOpensAtSeconds).toBe(kelp.timeToBreachSeconds! + x.freezeHours * 3600)
    expect(kelp.recallDrawnUsd).toBe(0)
  })

  it('wins over an explicit USD capacity and a custom multiple; cuts and freezes still apply on top', () => {
    const want = exitCapacityFromPreset(10_000, 'aave-usdc-floor-typical')
    const venue = { exitCapacityPreset: 'aave-usdc-floor-typical' } as const
    const usd = carry({
      deployedUsd: 10_000,
      exitCapacityUsd: 2_500,
      exitCapacityPreset: undefined,
    })
    expect(run(usd, step(0.25), venue).recallAvailableUsd).toBeCloseTo(want, 6)
    const mult = carry({
      deployedUsd: 10_000,
      exitCapacityMult: 0.9,
      exitCapacityPreset: undefined,
    })
    expect(run(mult, step(0.25), venue).recallAvailableUsd).toBeCloseTo(want, 6)
    // No capacity chosen at all: the venue level supplies it.
    const none = carry({ deployedUsd: 10_000, exitCapacityPreset: undefined })
    expect(run(none, step(0.25), venue).recallAvailableUsd).toBeCloseTo(want, 6)
    const half = run(chosen, step(0.25), { ...venue, capacityMult: 0.5 })
    expect(half.recallAvailableUsd).toBeCloseTo(want * 0.5, 6)
    const frozen = run(chosen, step(0.25), { ...venue, freezeHours: 4 })
    expect(frozen.recallOpensAtSeconds).toBe(frozen.timeToBreachSeconds! + 4 * 3600)
  })

  it('is named and keyed; absent, the canonical inputs carry no trace of it', () => {
    const s: StressScenario = {
      price: step(0.25),
      venue: { exitCapacityPreset: 'aave-usdc-floor-typical' },
    }
    const r = runStress(chosen, s)
    expect(r.scenarioId).toBe('step-25@exit-aave-usdc-floor-typical')
    expect(stressCellCanonical(chosen, s)).toContain('"exit":"aave-usdc-floor-typical"')
    for (const venue of [undefined, { capacityMult: 0.5 }, { freezeHours: 8 }]) {
      expect(stressCellCanonical(chosen, { price: step(0.25), venue })).not.toContain('"exit"')
    }
  })

  it('levered long is not modelled under it; an unknown id is an invalid venue', () => {
    const lev = runStress(pos(), {
      price: step(0.25),
      venue: { exitCapacityPreset: 'aave-usdc-floor-typical' },
    })
    expect(lev.outcome === 'not_modelled' && lev.reason).toBe('no_recall_levered_long')
    const bad = runStress(chosen, {
      price: step(0.25),
      venue: { exitCapacityPreset: 'bogus' as never },
    })
    expect(bad.outcome === 'not_modelled' && bad.reason).toBe('invalid_venue')
  })

  it('exitCapacityFloorOf: a measured level maps to its own venue and level; a bound to none', () => {
    expect(exitCapacityFloorOf('aave-usdc-50m-worst')).toBe('aave-usdc-floor-worst')
    expect(exitCapacityFloorOf('steakhouse-usdc-250m-typical')).toBe(
      'steakhouse-usdc-floor-typical',
    )
    expect(exitCapacityFloorOf('spark-dai-floor-bad')).toBe('spark-dai-floor-bad')
    expect(exitCapacityFloorOf('frozen')).toBeNull()
    expect(exitCapacityFloorOf('optimistic')).toBeNull()
    expect(exitCapacityFloorOf('bogus' as never)).toBeNull()
    for (const id of EXIT_CAPACITY_PRESET_ORDER) {
      const f = exitCapacityFloorOf(id)
      const src = EXIT_CAPACITY_PRESETS[id].source
      if (!src) continue
      expect(EXIT_CAPACITY_PRESETS[f!].source).toMatchObject({
        model: 'pro-rata',
        slug: src.slug,
        level: src.level,
      })
    }
  })
})

describe('collateral that goes to zero', () => {
  // A replay ratio that rounds to 0 at 8 dp: the collateral is worth nothing at step 2.
  const toZero: PriceShape = {
    kind: 'replay',
    id: 'zero',
    stepSeconds: 60,
    ratios: [1, 1, 1e-9, 1e-9],
  }
  const big = { collateralUsd: 1e6, debtUsd: 5e5 }

  it('a total wipe-out is a breach and a sale, never no_breach', () => {
    // Was: the walk broke out before the breach check — outcome no_breach, rank 0, with
    // $500k of bad debt and no breach time: the worst node on the grid ranked best.
    const r = run(pos(big), toZero)
    expect(r.outcome).toBe('sold')
    expect(r.timeToBreachSeconds).toBe(120)
    expect(r.timeToSaleSeconds).toBe(120)
    expect(r.saleReason).toBe('band')
    expect(r.soldShare).toBe(1)
    expect(r.badDebtUsd).toBe(5e5)
    expect(r.landingLtv).toBeNull()
    // A near-zero price (collateral $0.02) ranks the same: no cliff at exactly zero.
    const near = run(pos(big), { ...toZero, id: 'near', ratios: [1, 1, 2e-8, 2e-8] })
    expect(near.outcome).toBe('sold')
    expect(stressRank(r)).toBeGreaterThanOrEqual(stressRank(near))
  })

  it('recall still comes first: it shrinks the bad debt, or repays the whole loan', () => {
    const part = run(carry({ ...big, deployedUsd: 1e5 }), toZero)
    expect(part.outcome).toBe('sold')
    expect(part.recallDrawnUsd).toBe(1e5)
    expect(part.badDebtUsd).toBe(4e5)
    const whole = run(carry({ ...big, deployedUsd: 5e5 }), toZero)
    expect(whole.outcome).toBe('recall_cured')
    expect(whole.badDebtUsd).toBe(0)
    expect(whole.timeToBreachSeconds).toBe(120)
  })

  it('the wipe-out step sets the peak LTV — a deeper replay never reports a lower one', () => {
    // Review repro: the wipe-out branch skipped the peak update, so [1, 1e-10] (normalized
    // to 0, below the dust line) reported the t0 LTV while [1, 1e-5] reported 61,300.
    const replay = (r: number): PriceShape => ({
      kind: 'replay',
      id: `to-${r}`,
      stepSeconds: 60,
      ratios: [1, r],
    })
    const shallow = run(pos(), replay(1e-5)) // $1 of collateral left: 61,300 / 1
    const deep = run(pos(), replay(1e-10)) // $0 left: unbounded
    expect(shallow.peakLtv).toBeCloseTo(61_300, 6)
    expect(deep.peakLtv).toBe(Infinity)
    expect(deep.peakLtv).toBeGreaterThanOrEqual(shallow.peakLtv)
    // A near-dust collateral (> 0, <= $1e-6) is finite and enormous, never the t0 LTV.
    const dust = run(pos({ collateralUsd: 50, debtUsd: 30 }), replay(1e-8)) // $5e-7 left
    expect(dust.peakLtv).toBeCloseTo(30 / 5e-7, 0)
  })
})

describe('wick hold length rounds UP to the grid', () => {
  it('a wick held 25 s past the 8h window is sold at expiry, on a 60 s grid as on a 5 s one', () => {
    const price: PriceShape = { kind: 'wick', drop: 0.25, hours: 8 + 25 / 3600 }
    const fine = m(runStress(pos(), { price }, { stepSeconds: 5 }))
    expect(fine.outcome).toBe('sold')
    expect(fine.saleReason).toBe('expiry')
    const grid = run(pos(), price) // was armed_cured: the hold was rounded DOWN to 480 steps
    expect(grid.outcome).toBe('sold')
    expect(grid.saleReason).toBe('expiry')
  })

  it('a wick of exactly N steps stays N steps (the 1e-4 h key rounding never adds one)', () => {
    // Path = [1, N × trough, recovery] + a flat tail of 480 + 1 steps.
    const horizon = (hours: number) => run(pos(), { kind: 'wick', drop: 0.1, hours }).horizonSeconds
    expect(horizon(1 / 60)).toBe((1 + 482) * 60)
    expect(horizon(4)).toBe((240 + 482) * 60)
    expect(horizon(8)).toBe((480 + 482) * 60)
  })
})

describe('long paths', () => {
  it('a 150k-point replay runs (no spread-argument stack overflow)', () => {
    const N = 150_000
    const ratios = Array.from({ length: N }, (_, i) => 1 - (0.3 * i) / N)
    const r = run(carry({ deployedUsd: 1000 }), {
      kind: 'replay',
      id: 'long',
      stepSeconds: 1,
      ratios,
    })
    const minRatio = 1 - (0.3 * (N - 1)) / N
    expect(r.recallNeededUsd as number).toBeCloseTo(61_300 - 0.8 * C * minRatio, 2)
  })
})

// -------------------------------------------------------- parity with cureWalk

/** An independent rebuild of the walk's ratio path (shape + one window + one step, flat). */
function ratioPath(price: PriceShape, tailSteps: number): number[] {
  const steps = (h: number) => Math.max(1, Math.round((h * 3600) / 60))
  let out: number[]
  if (price.kind === 'step') out = [1, 1 - price.drop]
  else if (price.kind === 'linear') {
    const n = steps(price.hours)
    out = Array.from({ length: n + 1 }, (_, i) => 1 - (price.drop * i) / n)
  } else if (price.kind === 'wick') {
    const n = steps(price.hours)
    out = [
      1,
      ...new Array<number>(n).fill(1 - price.drop),
      1 - price.drop * (1 - (price.recover ?? 1)),
    ]
  } else throw new Error('replay not rebuilt here')
  return [...out, ...new Array<number>(tailSteps).fill(out[out.length - 1])]
}

describe('parity with cureWalk when there is no recall', () => {
  const cases: [string, StressPosition, PriceShape, number][] = [
    ['delayed step in band', pos(), step(0.25), 1],
    ['delayed wick past window', pos(), { kind: 'wick', drop: 0.25, hours: 10 }, 1],
    ['delayed linear, several sales', pos(), { kind: 'linear', drop: 0.3, hours: 24 }, 2],
    ['delayed linear, fast', pos({ debtUsd: 50_000 }), { kind: 'linear', drop: 0.45, hours: 2 }, 2],
    [
      'no-delay step',
      pos({ membraneClass: 'no-delay', line: 0.88, debtUsd: 70_000 }),
      step(0.25),
      1,
    ],
  ]

  for (const [name, p, price, minSales] of cases) {
    it(name, () => {
      const r = run(p, price)
      expect(r.sales).toBeGreaterThanOrEqual(minSales)
      const tail = (p.membraneClass === 'delayed' ? 480 : 0) + 1
      const ratios = ratioPath(price, tail)
      const k = ratios.findIndex((x) => p.debtUsd / (p.collateralUsd * x) > p.line)
      expect(k).toBeGreaterThan(0)
      const cw = cureWalk({
        debtUsd: p.debtUsd,
        collateralUsd: p.collateralUsd * ratios[k],
        line: p.line,
        band: p.membraneClass === 'delayed' ? 0.04 : 0,
        delaySeconds: CURE_WINDOW_SECONDS,
        stepSeconds: 60,
        gap: 0.03,
        ratios: ratios.slice(k).map((x) => x / ratios[k]),
        debtMinimumUsd: D_MIN,
      })
      expect(r.closedUsd).toBeCloseTo(cw.closedUsd, 6)
      expect(r.sales).toBe(cw.sales)
      expect(r.timeToBreachSeconds).toBe(k * 60)
      expect(r.timeToSaleSeconds).toBe((k + (cw.closedAtIndex as number)) * 60)
    })
  }
})

// --------------------------------------------------------------- Oct-10 replay

describe('Oct-10-2025 relative replay', () => {
  const series = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../public/data/oct10-2025/prices-1m.json'), 'utf8'),
  ) as Oct10Series

  it('builds the ETH oracle shape relative to its first observation', () => {
    const shape = oct10ReplayShape(series, 'WETH')
    expect(shape).not.toBeNull()
    if (!shape || shape.kind !== 'replay') throw new Error('expected a replay')
    expect(shape.id).toBe('oct10-2025:ethOracle:0-2879')
    expect(shape.stepSeconds).toBe(60)
    expect(shape.ratios).toHaveLength(series.count)
  })

  it('has no shape for a symbol without a measured series (never silently flat)', () => {
    expect(oct10ReplayShape(series, 'USDC')).toBeNull()
    expect(oct10ReplayShape(series, 'sUSDS')).toBeNull()
    expect(oct10ReplayShape(series, 'WETH', { fromIndex: 5, toIndex: 5 })).toBeNull()
  })

  it('runs through the mechanics; recall needed is priced at the measured trough', () => {
    const shape = oct10ReplayShape(series, 'WETH') as PriceShape
    const col = series.columns.ethOracle as number[]
    const trough = Math.min(...col) / col[0]
    const r = run(carry({ debtUsd: 70_000, deployedUsd: 5000 }), shape)
    expect(r.recallNeededUsd as number).toBeCloseTo(70_000 - 0.8 * C * trough, 2)
    expect(r.horizonSeconds).toBe((series.count - 1 + 481) * 60)
    expect(runStress(pos(), { price: shape }).cellKey).toBe(
      runStress(pos(), { price: shape }).cellKey,
    )
  })

  it('a no-recall replay matches cureWalk from the first breach', () => {
    const shape = oct10ReplayShape(series, 'WETH') as PriceShape & { kind: 'replay' }
    const p = pos({ debtUsd: 66_000 })
    const r = run(p, shape)
    const first = shape.ratios[0] as number
    const ratios = [...(shape.ratios as number[]).map((x) => x / first)]
    ratios.push(...new Array<number>(481).fill(ratios[ratios.length - 1]))
    const k = ratios.findIndex((x) => p.debtUsd / (C * x) > p.line)
    expect(k).toBeGreaterThan(0)
    const cw = cureWalk({
      debtUsd: p.debtUsd,
      collateralUsd: C * ratios[k],
      line: 0.8,
      band: 0.04,
      delaySeconds: CURE_WINDOW_SECONDS,
      stepSeconds: 60,
      gap: 0.03,
      ratios: ratios.slice(k).map((x) => x / ratios[k]),
      debtMinimumUsd: D_MIN,
    })
    expect(r.closedUsd).toBeCloseTo(cw.closedUsd, 2)
    expect(r.sales).toBe(cw.sales)
  })
})

// ------------------------------------------------------------ inputs and refusals

describe('inputs that cannot be modelled are refused, keyed and labelled', () => {
  const cases: [string, StressPosition, PriceShape, string][] = [
    ['delayed line above 90%', pos({ line: 0.95 }), step(0.2), 'line_out_of_class_range'],
    [
      'no-delay line above 96%',
      pos({ membraneClass: 'no-delay', line: 0.97 }),
      step(0.2),
      'line_out_of_class_range',
    ],
    ['zero line', pos({ line: 0 }), step(0.2), 'line_out_of_class_range'],
    ['no collateral', pos({ collateralUsd: 0 }), step(0.2), 'invalid_position'],
    ['NaN debt', pos({ debtUsd: NaN }), step(0.2), 'invalid_position'],
    ['drop of 100%', pos(), step(1), 'invalid_shape'],
    ['negative drop', pos(), step(-0.1), 'invalid_shape'],
    ['zero-hour linear', pos(), { kind: 'linear', drop: 0.2, hours: 0 }, 'invalid_shape'],
    [
      'empty replay',
      pos(),
      { kind: 'replay', id: 'x', stepSeconds: 60, ratios: [null, null] },
      'invalid_shape',
    ],
  ]
  for (const [name, p, price, reason] of cases) {
    it(name, () => {
      const r = runStress(p, { price })
      expect(r).toMatchObject({ outcome: 'not_modelled', reason, label: STRESS_LABEL })
      expect(r.cellKey).toMatch(/^sg-[0-9a-f]{16}$/)
    })
  }

  it('a no-delay line up to 96% is modelled', () => {
    expect(
      runStress(pos({ membraneClass: 'no-delay', line: 0.96 }), { price: step(0.2) }).outcome,
    ).not.toBe('not_modelled')
  })

  it('a negative capacity multiplier is refused', () => {
    expect(runStress(carry(), { price: step(0.2), venue: { capacityMult: -1 } })).toMatchObject({
      outcome: 'not_modelled',
      reason: 'invalid_venue',
    })
  })
})

describe('stressPositionFromProtocol — task #1 classes', () => {
  const PROV = stamp('mock', 'stressGrid test', 'synthetic')
  function protocolPosition(
    legs: { symbol: string; usd: number }[],
    debtUsd: number,
  ): ProtocolPosition {
    const total = legs.reduce((a, l) => a + l.usd, 0)
    return {
      protocol: 'aave-v3',
      label: 'Synthetic',
      collateral: legs.map((l) => ({
        symbol: l.symbol,
        address: '0x0',
        decimals: 18,
        amount: l.usd,
        priceUsd: 1,
        valueUsd: l.usd,
        liquidationThreshold: 0.85,
        maxLtv: 0.8,
        liquidationBonus: 0.05,
      })),
      debt: [
        {
          symbol: 'USDC',
          address: '0x0',
          decimals: 6,
          amount: debtUsd,
          priceUsd: 1,
          valueUsd: debtUsd,
          borrowApr: null,
        },
      ],
      totalCollateralUsd: total,
      totalDebtUsd: debtUsd,
      ltv: debtUsd / total,
      liquidationLtv: 0.85,
      healthFactor: (0.85 * total) / debtUsd,
      provenance: PROV,
    }
  }

  it('WETH is delayed at its own line; sUSDS is no-delay', () => {
    const weth = stressPositionFromProtocol(
      protocolPosition([{ symbol: 'WETH', usd: C }], 50_000),
      {
        tradeShape: 'levered_long',
      },
    )
    expect(weth).toMatchObject({
      ok: true,
      position: { membraneClass: 'delayed', line: 0.8, debtUsd: 50_000 },
    })
    const susds = stressPositionFromProtocol(
      protocolPosition([{ symbol: 'sUSDS', usd: C }], 50_000),
      {
        tradeShape: 'carry',
        deployedUsd: 50_000,
      },
    )
    expect(susds).toMatchObject({ ok: true, position: { membraneClass: 'no-delay', line: 0.88 } })
  })

  it('refuses a mixed-class basket (MixedDelayClassCollateral) and an unknown leg', () => {
    const mixed = protocolPosition(
      [
        { symbol: 'WETH', usd: 50_000 },
        { symbol: 'sUSDS', usd: 50_000 },
      ],
      40_000,
    )
    expect(stressPositionFromProtocol(mixed, { tradeShape: 'levered_long' })).toMatchObject({
      ok: false,
      reason: 'mixed_class',
    })
    const unknown = protocolPosition([{ symbol: 'FOO', usd: C }], 40_000)
    expect(stressPositionFromProtocol(unknown, { tradeShape: 'levered_long' })).toEqual({
      ok: false,
      reason: 'no_line',
      symbols: ['FOO'],
    })
    expect(
      stressPositionFromProtocol(unknown, { tradeShape: 'levered_long', line: 0.7 }),
    ).toMatchObject({
      ok: true,
      position: { line: 0.7, membraneClass: 'delayed' },
    })
  })
})
