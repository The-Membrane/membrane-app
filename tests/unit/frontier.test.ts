/**
 * frontier — distance to danger by bisection, rounded toward risk, plus the reverse solve.
 *
 * Analytic edges (levered_long, delayed, line M = 0.80, band 4%, LTV ℓ):
 *   a step crosses the line         at drop 1 − ℓ / M
 *   a sale at the shock (band)      at drop 1 − ℓ / (1.04 M)
 *   no sale at a persistent −d step up to ℓ = M (1 − d)
 *   no sale at a −d wick that recovers inside the window up to ℓ = 1.04 M (1 − d)
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_VENUE_REFERENCE,
  FRACTION_TOL,
  HOURS_TOL,
  LTV_TOL,
  bisectEdge,
  capacityFrontier,
  distanceToDanger,
  freezeFrontier,
  priceFrontier,
  reverseSolveLtv,
  shapeWithDrop,
  withStartLtv,
  type FrontierEdge,
  type ShapeFamily,
} from '@/lib/position-sim/frontier'
import {
  STRESS_CODE_VERSION,
  STRESS_LABEL,
  STRESS_SEVERITY,
  runStress,
  stressRank,
  type PriceShape,
  type StressPosition,
} from '@/lib/position-sim/stressGrid'

const C = 100_000

function pos(o: Partial<StressPosition> = {}): StressPosition {
  return {
    collateralUsd: C,
    debtUsd: 61_300,
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'levered_long',
    debtMinimumUsd: 2000,
    // Ruling 5 (owner 2026-10-04): exit capacity is never defaulted. Every position here
    // states it — the 'optimistic' preset (×1 of deployed) unless a test overrides it.
    // A levered_long position ignores it (no recall).
    exitCapacityPreset: 'optimistic',
    ...o,
  }
}
const carry = (o: Partial<StressPosition> = {}) => pos({ tradeShape: 'carry', ...o })
const noDelay = (o: Partial<StressPosition> = {}) =>
  pos({ membraneClass: 'no-delay', line: 0.88, debtUsd: 70_000, ...o })

type Found = Extract<FrontierEdge, { status: 'found' }>
function found(e: FrontierEdge): Found {
  if (e.status !== 'found') throw new Error(`expected a found edge, got ${JSON.stringify(e)}`)
  return e
}

const sold = (p: StressPosition, price: PriceShape) => runStress(p, { price }).outcome === 'sold'

// ------------------------------------------------------------------- bisection

describe('bisectEdge', () => {
  it('converges within tolerance and brackets the edge', () => {
    const t = Math.PI / 10
    const r = bisectEdge((x) => x >= t, 0, 1, 1e-7)
    if (r.status !== 'found') throw new Error('expected found')
    expect(r.triggersAt - r.safeBelow).toBeLessThanOrEqual(1e-7)
    expect(r.safeBelow).toBeLessThan(t)
    expect(r.triggersAt).toBeGreaterThanOrEqual(t)
    expect(r.iterations).toBeLessThanOrEqual(Math.ceil(Math.log2(1 / 1e-7)))
  })

  it('reports an edge at zero and an edge beyond the range', () => {
    expect(bisectEdge(() => true, 0, 1, 1e-6)).toEqual({ status: 'already' })
    expect(bisectEdge(() => false, 0, 1, 1e-6)).toEqual({ status: 'beyond_range' })
  })

  it('every found frontier edge is bracketed to its tolerance', () => {
    // −25% reference: 10k needed, 12k deployed ⇒ cured at full capacity, sold when cut.
    const d = distanceToDanger(carry({ debtUsd: 70_000, deployedUsd: 12_000 }))
    const edges: [FrontierEdge, number][] = [
      [d.price.breach, FRACTION_TOL],
      [d.price.arm, FRACTION_TOL],
      [d.price.sale, FRACTION_TOL],
      [d.saleAtShock, FRACTION_TOL],
      [d.capacity.sale, FRACTION_TOL],
      [d.freeze.sale, HOURS_TOL],
      [d.reverse.at50, LTV_TOL],
      [d.reverse.at60, LTV_TOL],
    ]
    for (const [e, tol] of edges) {
      const f = found(e)
      expect(f.triggersAt - f.safeBelow).toBeLessThanOrEqual(tol)
      expect(f.at.outcome).not.toBe('not_modelled')
    }
  })
})

// ------------------------------------------------------------------ price axis

describe('priceFrontier — analytic edges', () => {
  it('levered_long delayed: the step crosses, arms and (persisting) sells at 1 − ℓ/M', () => {
    const a = priceFrontier(pos())
    const edge = 1 - 0.613 / 0.8 // 0.23375
    for (const e of [a.breach, a.arm, a.sale]) {
      const f = found(e)
      expect(Math.abs(f.triggersAt - edge)).toBeLessThanOrEqual(2 * FRACTION_TOL)
      expect(f.display).toBe(23)
    }
    expect(found(a.sale).at.outcome).toBe('sold')
  })

  it('saleAtShock is the band break: 1 − ℓ / (1.04 M)', () => {
    const f = found(distanceToDanger(pos()).saleAtShock)
    expect(Math.abs(f.triggersAt - (1 - 0.613 / 0.832))).toBeLessThanOrEqual(2 * FRACTION_TOL)
    expect(f.display).toBe(26)
  })

  it('a wick that recovers inside the window only sells past the band', () => {
    const a = priceFrontier(pos(), { family: { kind: 'wick', hours: 4 } })
    expect(found(a.arm).display).toBe(23)
    expect(found(a.sale).display).toBe(26)
    expect(found(a.arm).at.outcome).toBe('armed_cured')
  })

  it('carry: recall moves the arm edge out to where the stock stops curing', () => {
    // Recall 9k of 61.3k cures while 61.3k − 9k <= 0.8 × C(1 − d) ⇔ d <= 1 − 52.3/80.
    const a = priceFrontier(carry({ deployedUsd: 9000 }))
    expect(found(a.breach).display).toBe(23)
    expect(found(a.breach).at.outcome).toBe('recall_cured')
    const armEdge = 1 - 52_300 / 80_000
    expect(Math.abs(found(a.arm).triggersAt - armEdge)).toBeLessThanOrEqual(2 * FRACTION_TOL)
  })

  it('one-step wick: the arm edge is the first ARM, not where the outcome stops dipping', () => {
    // 61.3k debt, 55,170 deployed. Arms once 6,130 / (C (1 − d)) > 0.8 ⇔ d > 0.923375.
    // At −93% the sale call's recall covers its whole target (recall_liquidated); that
    // used to read as recall_cured, dropping the rank and pushing the edge out to 93.
    const p = carry({ deployedUsd: 55_170 })
    const a = priceFrontier(p, { family: { kind: 'wick', hours: 1 / 60 } })
    const arm = found(a.arm)
    expect(Math.abs(arm.triggersAt - 0.923375)).toBeLessThanOrEqual(2 * FRACTION_TOL)
    expect(arm.display).toBe(92)
    expect(arm.at.outcome).toBe('armed_cured')
  })

  it('dense scan: no whole % at or below display triggers (one-step wick)', () => {
    // A random-sweep counterexample from the review: arm display was 77 while 76 armed.
    const p = carry({ line: 0.5506, debtUsd: 18_261.51, deployedUsd: 4_840.92 })
    const family: ShapeFamily = { kind: 'wick', hours: 1 / 60 }
    const a = priceFrontier(p, { family })
    const at = (pct: number) =>
      stressRank(runStress(p, { price: shapeWithDrop(family, pct / 100) }))
    for (const [e, rank] of [
      [a.breach, STRESS_SEVERITY.recall_cured],
      [a.arm, STRESS_SEVERITY.armed_cured],
      [a.sale, STRESS_SEVERITY.sold],
    ] as [FrontierEdge, number][]) {
      const f = found(e)
      for (let pct = 0; pct <= f.display; pct++) expect(at(pct), `${pct}%`).toBeLessThan(rank)
      expect(at(f.display + 1)).toBeGreaterThanOrEqual(rank)
    }
  })

  it('a position already over its line is "already" on the price axis', () => {
    expect(priceFrontier(pos({ debtUsd: 81_000 })).breach.status).toBe('already')
  })

  it('a fully recallable carry position never sells on the price axis', () => {
    expect(priceFrontier(carry({ deployedUsd: 61_300 })).sale).toEqual({
      status: 'beyond_range',
      unit: 'pct',
      max: 0.99,
    })
  })
})

// ---------------------------------------------------------- debt-floor band
//
// Master's floor (LE:2721-2728) lifts a sub-$2,000 target to the WHOLE loan when the loan
// is under $4,000, but a target that has reached $2,000 stands. With the debt at the sale
// call in [$2,000, $4,000) and a recall of $2,000+, a deeper shock SHRINKS the target:
// sold → recall_liquidated → sold — that island is what repros A, B and $3,999 pinned.
// UPDATED 2026-10-04 (owner ruling 1, the remainder guard in `applyDebtMinimum`): a target
// >= $2,000 that leaves less than $2,000 also becomes the whole loan, so in that band EVERY
// sale target is the whole loan and the island is gone.
// UPDATED 2026-10-04 (owner ruling 1 on the ARRIVAL, `debtFloorRemainder`): every repro
// here is a loan under $4,000 whose venue holds less than the loan, so the FIRST call — the
// breach — asks for the whole loan (the restore ask lifts to it), the venue answers short,
// and the recall alone would strand 0 < debt < $2,000. That call now repays all: the
// remainder sells (saleReason 'floor'). Under the old recall-only cure it "cured" leaving
// the dust, and the first sale waited for the band break / the window. So the sale edge
// moves to the breach in all four repros — still the FIRST sale, which is what they pin.
// Every ladder above has debt of $30k+, so none of them reaches this band.

describe('debt-floor band: the sale edge is the first sale (floor close at the breach under 2·dMin)', () => {
  const oneStep: ShapeFamily = { kind: 'wick', hours: 1 / 60 }
  const small = (o: Partial<StressPosition>) =>
    pos({ tradeShape: 'carry', collateralUsd: 4_500, debtUsd: 3_500, ...o })
  const nodeAt = (p: StressPosition, drop: number) =>
    runStress(p, { price: shapeWithDrop(oneStep, drop) })
  const outcomeAt = (p: StressPosition, drop: number) => nodeAt(p, drop).outcome

  /** No sale anywhere in [0, safeBelow] on a 0.01% scan, and the sale-path entry never falls. */
  function scanBelow(
    p: StressPosition,
    e: Found,
    price: (x: number) => PriceShape,
    mk: (x: number) => StressPosition = () => p,
  ) {
    let onPath = false
    for (let k = 0; k * 1e-4 <= e.safeBelow; k++) {
      const r = runStress(mk(k * 1e-4), { price: price(k * 1e-4) })
      expect(r.outcome, `${k / 100}%`).not.toBe('sold')
      const path = stressRank(r) >= STRESS_SEVERITY.recall_liquidated
      if (onPath) expect(path, `sale-path entry fell at ${k / 100}%`).toBe(true)
      onPath = path
    }
  }

  /** The node at the edge is the floor close: the whole loan repaid, the remainder sold. */
  function expectFloorClose(e: Found, debt: number, deployed: number) {
    const at = e.at
    if (at.outcome === 'not_modelled') throw new Error('not modelled')
    expect(at.outcome).toBe('sold')
    expect(at.saleReason).toBe('floor')
    expect(at.closedUsd).toBeCloseTo(debt, 6)
    expect(at.exposedUsd).toBeCloseTo(debt - deployed, 6)
    expect(at.landingLtv).toBe(0)
  }

  it('delayed carry, one-step wick: the sale edge is the breach (review repro A)', () => {
    const p = small({ deployedUsd: 2_100 })
    // The breach is at 1 − 3,500 / (0.8 × 4,500) = 2.78%. UPDATED 2026-10-04 (ruling 1 on
    // the arrival): 3%–62% read 'recall_cured' (leaving $1,400 owed) / 'armed_cured' and the
    // first sale was at the band break, 62.6%.
    expect([0.02, 0.03, 0.62, 0.63, 0.64, 0.65, 0.66].map((d) => outcomeAt(p, d))).toEqual([
      'no_breach',
      'sold',
      'sold',
      'sold',
      'sold',
      'sold',
      'sold',
    ])
    const e = found(distanceToDanger(p).saleAtShock)
    expect(e.display).toBe(2)
    expect(e.triggersAt).toBeCloseTo(1 - 3_500 / 3_600, 5) // to the 1e-6 drop grid
    expectFloorClose(e, 3_500, 2_100)
    scanBelow(p, e, (x) => shapeWithDrop(oneStep, x))
  })

  it('the review repro on $3,999 of debt: the breach sells, so the edge is not 81 (or 62 → 60)', () => {
    const base = small({ collateralUsd: 5_713, debtUsd: 3_999 })
    const p3000 = { ...base, deployedUsd: 3_000 }
    // UPDATED 2026-10-04 (ruling 1 on the arrival): the edges were 78 (deployed $3,000)
    // and 60 (deployed $2,100) — the sale path. The breach is at 1 − 3,999 / (0.8 × 5,713)
    // = 12.50%, and there the venue leaves $999 / $1,899 owed: the call repays all.
    expect([0.12, 0.13, 0.79, 0.8, 0.81, 0.82].map((d) => outcomeAt(p3000, d))).toEqual([
      'no_breach',
      'sold',
      'sold',
      'sold',
      'sold',
      'sold',
    ])
    const e3000 = found(distanceToDanger(p3000).saleAtShock)
    expect(e3000.display).toBe(12)
    expectFloorClose(e3000, 3_999, 3_000)
    const e2100 = found(distanceToDanger({ ...base, deployedUsd: 2_100 }).saleAtShock)
    expect(e2100.display).toBe(12)
    expectFloorClose(e2100, 3_999, 2_100)
  })

  it('no-delay carry: display never walks past triggersAt (repro B)', () => {
    const p = small({
      membraneClass: 'no-delay',
      line: 0.9,
      collateralUsd: 4_000,
      debtUsd: 3_000,
      deployedUsd: 2_500,
    })
    const e = found(distanceToDanger(p).saleAtShock)
    // UPDATED 2026-10-04 (ruling 1 on the arrival): the edge was 86.11% (display 86), the
    // sale path. It is now the breach, 1 − 3,000 / (0.9 × 4,000) = 16.67%: the venue's
    // $2,500 would leave $500 owed, so that call sells the $500 and closes the loan.
    expect(e.triggersAt).toBeCloseTo(1 - 3_000 / 3_600, 5)
    expect(outcomeAt(p, 0.87)).toBe('sold')
    expect(e.display).toBe(16)
    expect(e.display / 100).toBeLessThan(e.triggersAt)
    expectFloorClose(e, 3_000, 2_500)
    scanBelow(p, e, (x) => shapeWithDrop(oneStep, x))
  })

  it('reverse solve: the floor close opens at the breach in LTV too (repro C)', () => {
    const p = small({ collateralUsd: 6_000, debtUsd: 3_000, deployedUsd: 1_500 })
    const at = (ltv: number) =>
      runStress(withStartLtv(p, ltv), { price: shapeWithDrop(oneStep, 0.6) }).outcome
    // UPDATED 2026-10-04 (ruling 1 on the arrival): the edge was 66 — the sale-path island
    // at $4,000 of debt. The breach is at start LTV 0.8 × 0.4 = 32%; from there to $4,000
    // of debt (66.7%) the half-deployed venue leaves under $2,000 owed, so every call sells.
    // Past $4,000 the old sale-path island is still there (sold → recall_liquidated).
    expect([0.32, 0.33, 0.5, 0.666, 0.67, 0.68, 0.69, 0.7].map(at)).toEqual([
      'no_breach',
      'sold',
      'sold',
      'sold',
      'recall_liquidated',
      'recall_liquidated',
      'recall_liquidated',
      'sold',
    ])
    const e = found(reverseSolveLtv(p, 0.6, { family: oneStep }))
    expect(e.display).toBe(32)
    expect(e.at.outcome).toBe('sold')
    expect(e.at.outcome === 'sold' && e.at.saleReason).toBe('floor')
    scanBelow(
      p,
      e,
      () => shapeWithDrop(oneStep, 0.6),
      (ltv) => withStartLtv(p, ltv),
    )
  })
})

// ------------------------------------------------- floor close: frontier guards
//
// The floor close (ruling 1 on the arrival) sells only while the debt at the call is small,
// so on the reverse solve's LTV axis and the capacity axis "sold" can START and then STOP.
// Bisection trusted structure and read past it; these pin the two guards (frontier.ts
// header, THE FLOOR CLOSE BREAKS THAT STRUCTURE).

describe('floor close: the frontier finds a sale run that stops', () => {
  /** Every point on a fine grid in [0, display] is clear; one in (display, display + 1] sells. */
  function fineScan(run: (x: number) => ReturnType<typeof runStress>, e: Found, hi: number) {
    for (let k = 0; k <= e.display * 10; k++) {
      expect(run(Math.min(hi, k / 1000)).outcome, `${k / 10}%`).not.toBe('sold')
    }
    expect(run(e.triggersAt).outcome).toBe('sold')
  }

  it('whole-unit guard: a run that sells for start LTV 41–69% and cures at the line', () => {
    // $3,999 on $5,713, 75% deployed. At a held −50% the collateral is $2,856: the loan
    // breaches past 40% start LTV, and under $4,000 of debt the ask is the whole loan and
    // the venue leaves a quarter of it, < $2,000 — floor close. From $4,000 the ask is the
    // $2,000-floored restore, which the venue covers: recall_cured, up to the line.
    // Bisection checked the line first and reported 'beyond_range' — "no sale at any start
    // LTV up to the line" — over a 29-point run of sales.
    const p = carry({ collateralUsd: 5_713, debtUsd: 3_999, deployedUsd: 3_000 })
    const at = (ltv: number) =>
      runStress(withStartLtv(p, ltv), { price: { kind: 'step', drop: 0.5 } })
    expect([0.4, 0.41, 0.69, 0.71, 0.8].map((l) => at(l).outcome)).toEqual([
      'no_breach',
      'sold',
      'sold',
      'recall_cured',
      'recall_cured',
    ])
    const e = found(reverseSolveLtv(p, 0.5))
    expect(e.display).toBe(40)
    expect(e.at.outcome === 'sold' && e.at.saleReason).toBe('floor')
    fineScan(at, e, p.line)
  })

  it('breach-entry guard: a run narrower than one whole unit, opening at the breach', () => {
    // Found by fuzzing: $5,332 on $9,412, line 84.2%, 51% deployed. At a held −50% it sells
    // only for start LTV 42.11%–42.50% (the debt is under $4,000 and the venue leaves
    // $1,946); from $4,000 the floored $2,000 ask is covered. No whole unit sells.
    const p = carry({
      collateralUsd: 9_412.43926435709,
      debtUsd: 5_331.5948245843665,
      line: 0.8420916164293886,
      deployedUsd: 2_715.6476262559013,
    })
    const at = (ltv: number) =>
      runStress(withStartLtv(p, ltv), { price: { kind: 'step', drop: 0.5 } })
    expect([0.42, 0.422, 0.43, 0.84].map((l) => at(l).outcome)).toEqual([
      'no_breach',
      'sold',
      'recall_cured',
      'recall_cured',
    ])
    const e = found(reverseSolveLtv(p, 0.5))
    expect(e.display).toBe(42)
    expect(e.at.outcome === 'sold' && e.at.saleReason).toBe('floor')
    fineScan(at, e, p.line)
  })

  it('capacity axis: a full venue cures, a slightly cut one closes on the floor', () => {
    // $3,000 on $4,500, all of it deployed, optimistic capacity. At the −25% reference the
    // loan breaches; the ask is the whole loan. Uncut, the venue repays it all; cut by x,
    // it leaves 3,000 × x — under $2,000 for any cut below 66.7%, so the call sells it.
    const p = carry({ collateralUsd: 4_500, debtUsd: 3_000, deployedUsd: 3_000 })
    const run = (cut: number) =>
      runStress(p, { price: DEFAULT_VENUE_REFERENCE, venue: { capacityMult: 1 - cut } })
    expect([0, 0.005, 0.5, 0.7].map((x) => run(x).outcome)).toEqual([
      'recall_cured',
      'sold',
      'sold',
      'recall_cured',
    ])
    const e = found(capacityFrontier(p).sale)
    expect(e.display).toBe(0)
    expect(e.at.outcome === 'sold' && e.at.saleReason).toBe('floor')
  })
})

// --------------------------------------------------------------- no-delay class

describe('no-delay class has no armed state', () => {
  it('arm edges are not applicable on every axis; breach and sale coincide', () => {
    const lev = priceFrontier(noDelay())
    expect(lev.arm).toEqual({ status: 'not_applicable', reason: 'no_delay_class' })
    expect(found(lev.breach).display).toBe(found(lev.sale).display)
    expect(Math.abs(found(lev.sale).triggersAt - (1 - 0.7 / 0.88))).toBeLessThanOrEqual(
      2 * FRACTION_TOL,
    )

    const c = noDelay({ tradeShape: 'carry', deployedUsd: 5000 })
    expect(capacityFrontier(c).arm.status).toBe('not_applicable')
    expect(freezeFrontier(c).arm.status).toBe('not_applicable')
  })

  it('any freeze sells a breached no-delay carry position — there is no window to wait in', () => {
    const c = noDelay({ tradeShape: 'carry', deployedUsd: 20_000 })
    const f = found(freezeFrontier(c, { kind: 'step', drop: 0.25 }).sale)
    expect(f.display).toBe(0)
    expect(f.triggersAt).toBeLessThanOrEqual(2 * HOURS_TOL)
  })
})

// ------------------------------------------------------------------ venue axes

describe('venue axes (carry only, at a named reference shock)', () => {
  it('levered_long has no recall rows', () => {
    const d = distanceToDanger(pos())
    for (const e of [d.capacity.arm, d.capacity.sale, d.freeze.arm, d.freeze.sale]) {
      expect(e).toEqual({ status: 'not_applicable', reason: 'levered_long_no_recall' })
    }
    expect(d.capacity.reference).toEqual(DEFAULT_VENUE_REFERENCE)
  })

  it('capacity: recall stops curing below the needed amount (cut* = 1 − needed / deployed)', () => {
    // −25% step: needed = 61.3k − 0.8 × 75k = 1.3k; 20k deployed ⇒ cut* = 0.935.
    const a = capacityFrontier(carry({ deployedUsd: 20_000 }), { kind: 'step', drop: 0.25 })
    for (const e of [a.arm, a.sale]) {
      const f = found(e)
      expect(Math.abs(f.triggersAt - 0.935)).toBeLessThanOrEqual(2 * FRACTION_TOL)
      expect(f.display).toBe(93)
    }
  })

  it('freeze: any freeze arms; a freeze longer than the 8h window sells', () => {
    const a = freezeFrontier(carry({ deployedUsd: 20_000 }), { kind: 'step', drop: 0.25 })
    const arm = found(a.arm)
    expect(arm.display).toBe(0)
    expect(arm.at.outcome).toBe('armed_cured')
    const sale = found(a.sale)
    expect(sale.display).toBe(8)
    expect(Math.abs(sale.safeBelow - 8)).toBeLessThanOrEqual(2 * HOURS_TOL)
    expect(sale.at.outcome).toBe('sold')
  })

  it('a reference shock that never breaches puts both venue axes beyond range', () => {
    const p = carry({ debtUsd: 40_000, deployedUsd: 10_000 })
    expect(capacityFrontier(p).sale.status).toBe('beyond_range')
    expect(freezeFrontier(p).sale.status).toBe('beyond_range')
  })
})

// ----------------------------------------------------------- rounding toward risk

describe('rounding is toward risk', () => {
  const families: ShapeFamily[] = [
    { kind: 'step' },
    { kind: 'linear', hours: 12 },
    { kind: 'wick', hours: 4 },
  ]
  const positions = [
    pos(),
    pos({ debtUsd: 47_777 }),
    noDelay(),
    carry({ debtUsd: 70_000, deployedUsd: 9000 }),
    noDelay({ tradeShape: 'carry', deployedUsd: 4000, debtUsd: 66_666 }),
  ]

  it('price: display is a whole % that does not trigger, and display + 1 does', () => {
    let checked = 0
    for (const p of positions) {
      for (const family of families) {
        const a = priceFrontier(p, { family })
        const edges: [FrontierEdge, number][] = [
          [a.breach, STRESS_SEVERITY.recall_cured],
          [a.arm, STRESS_SEVERITY.armed_cured],
          [a.sale, STRESS_SEVERITY.sold],
        ]
        for (const [e, rank] of edges) {
          if (e.status !== 'found') continue
          checked++
          expect(Number.isInteger(e.display)).toBe(true)
          expect(e.display / 100).toBeLessThan(e.triggersAt) // never beyond the true edge
          const at = (pct: number) =>
            stressRank(runStress(p, { price: shapeWithDrop(family, pct / 100) }))
          expect(at(e.display)).toBeLessThan(rank)
          expect(at(e.display + 1)).toBeGreaterThanOrEqual(rank)
        }
      }
    }
    expect(checked).toBeGreaterThan(25)
  })

  it('venue axes: whole % cut / whole hours, verified on both sides', () => {
    // −30% reference: 14k needed, 16k deployed.
    const p = carry({ debtUsd: 70_000, deployedUsd: 16_000 })
    const ref: PriceShape = { kind: 'step', drop: 0.3 }
    const cap = found(capacityFrontier(p, ref).sale)
    const runCut = (pct: number) =>
      runStress(p, { price: ref, venue: { capacityMult: 1 - pct / 100 } }).outcome
    expect(runCut(cap.display)).not.toBe('sold')
    expect(runCut(cap.display + 1)).toBe('sold')

    const fr = found(freezeFrontier(p, { kind: 'linear', drop: 0.25, hours: 24 }).sale)
    const runFreeze = (h: number) =>
      runStress(p, { price: { kind: 'linear', drop: 0.25, hours: 24 }, venue: { freezeHours: h } })
        .outcome
    expect(Number.isInteger(fr.display)).toBe(true)
    // Breach at minute 721, band break at minute 914: the venue must open by then.
    expect(fr.display).toBe(3)
    expect(runFreeze(fr.display)).not.toBe('sold')
    expect(runFreeze(fr.display + 1)).toBe('sold')
  })
})

// ---------------------------------------------------------------- reverse solve

describe('reverseSolveLtv', () => {
  it('levered_long delayed, persistent step: ℓ* = M (1 − d)', () => {
    expect(found(reverseSolveLtv(pos(), 0.5)).display).toBe(40)
    expect(found(reverseSolveLtv(pos(), 0.6)).display).toBe(32)
  })

  it('a wick that recovers inside the window: ℓ* = 1.04 M (1 − d)', () => {
    const e = found(reverseSolveLtv(pos(), 0.5, { family: { kind: 'wick', hours: 4 } }))
    expect(Math.abs(e.safeBelow - 0.416)).toBeLessThanOrEqual(2 * LTV_TOL)
    expect(e.display).toBe(41)
  })

  it('no-delay: no sale up to ℓ* = M (1 − d)', () => {
    const e = found(reverseSolveLtv(noDelay(), 0.5))
    expect(Math.abs(e.safeBelow - 0.44)).toBeLessThanOrEqual(2 * LTV_TOL)
    expect(e.display).toBe(44)
  })

  it('consistency: the solution has no sale and solution + 1pp has a sale', () => {
    const positions = [
      pos(),
      pos({ debtUsd: 30_000 }),
      noDelay(),
      carry({ debtUsd: 70_000, deployedUsd: 9000 }),
      carry({ debtUsd: 50_000, deployedUsd: 20_000, exitCapacityUsd: 6000 }),
      noDelay({ tradeShape: 'carry', deployedUsd: 7000 }),
    ]
    const families: ShapeFamily[] = [
      { kind: 'step' },
      { kind: 'linear', hours: 24 },
      { kind: 'wick', hours: 4 },
    ]
    let checked = 0
    for (const p of positions) {
      for (const family of families) {
        for (const drop of [0.5, 0.6]) {
          const e = reverseSolveLtv(p, drop, { family })
          if (e.status !== 'found') continue
          checked++
          const price = shapeWithDrop(family, drop)
          expect(sold(withStartLtv(p, e.display / 100), price)).toBe(false)
          if (e.display + 1 <= Math.floor(p.line * 100)) {
            expect(sold(withStartLtv(p, (e.display + 1) / 100), price)).toBe(true)
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(25)
  })

  it('a fully recallable carry position has no sale at any LTV up to the line', () => {
    expect(reverseSolveLtv(carry({ deployedUsd: 61_300 }), 0.6)).toEqual({
      status: 'beyond_range',
      unit: 'pct',
      max: 0.8,
    })
  })

  it('withStartLtv keeps the deployed share and an explicit venue capacity', () => {
    const p = carry({ debtUsd: 60_000, deployedUsd: 15_000, exitCapacityUsd: 7000 })
    const q = withStartLtv(p, 0.3)
    expect(q.debtUsd).toBeCloseTo(30_000, 9)
    expect(q.deployedUsd).toBeCloseTo(7500, 9)
    expect(q.exitCapacityUsd).toBe(7000)
    expect(withStartLtv(pos(), 0.3).deployedUsd).toBeUndefined()
  })
})

// ---------------------------------------------------------------- the summary

describe('distanceToDanger', () => {
  it('is reproducible: same inputs, identical report', () => {
    const p = carry({ debtUsd: 66_000, deployedUsd: 12_000, exitCapacityUsd: 30_000 })
    expect(distanceToDanger(p)).toEqual(distanceToDanger({ ...p }))
  })

  it('carries the code version and the label', () => {
    const d = distanceToDanger(pos())
    expect(d.codeVersion).toBe(STRESS_CODE_VERSION)
    expect(d.label).toBe(STRESS_LABEL)
    expect(d.reverse.family).toEqual({ kind: 'step' })
  })

  it('an invalid position yields not_applicable on the reverse solve too, never numbers', () => {
    // The reverse solve REPLACES the debt (withStartLtv), so it used to solve a NaN or
    // negative-debt position as if it had no recall and return 'found' edges.
    for (const debtUsd of [Number.NaN, -5]) {
      const p = carry({ debtUsd, deployedUsd: 10_000 })
      const d = distanceToDanger(p)
      for (const e of [d.price.breach, d.capacity.sale, d.reverse.at50, d.reverse.at60]) {
        expect(e).toEqual({ status: 'not_applicable', reason: 'not_modelled' })
      }
      expect(reverseSolveLtv(p, 0.5)).toEqual({ status: 'not_applicable', reason: 'not_modelled' })
    }
  })

  it('a position that cannot be modelled yields not_applicable edges, never numbers', () => {
    const d = distanceToDanger(carry({ line: 0.95 }))
    for (const e of [
      d.price.breach,
      d.price.sale,
      d.capacity.sale,
      d.freeze.sale,
      d.reverse.at50,
    ]) {
      expect(e).toEqual({ status: 'not_applicable', reason: 'not_modelled' })
    }
  })
})
