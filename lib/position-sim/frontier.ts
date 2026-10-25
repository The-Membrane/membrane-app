/**
 * frontier — distance to danger. For each SINGLE axis (price shock, venue exit capacity,
 * venue freeze), the smallest shock that changes a position's outcome, found by bisection
 * over stressGrid.ts nodes; plus the REVERSE SOLVE: the highest starting LTV that sees no
 * sale at a given shock. ENGINE ONLY.
 *
 * EDGES. An axis maps a severity x (bigger = worse) to a node and reads its rank
 * (STRESS_SEVERITY). Every edge is "the smallest x whose rank reaches R":
 *   breach  rank >= recall_cured  the line is crossed (recall fires; the window would open)
 *   arm     rank >= armed_cured   the delay timer arms — or worse (a sale-path call, which
 *                                 may not arm: `at` then reads recall_liquidated or sold
 *                                 with armed false). Not applicable to the no-delay class:
 *                                 it has no armed state (arm = sale).
 *   sale    rank >= sold          collateral is sold
 * A sale call whose recall covers its whole target ranks recall_liquidated, between
 * armed_cured and sold — read as recall_cured it made the rank DIP on one-step wicks and
 * pushed the arm edge out.
 *
 * MONOTONE, EXCEPT ONE PAIR. "rank >= R" is monotone in every axis for R up to
 * recall_liquidated — whether a call reaches the SALE PATH depends on the post-recall LTV
 * and the timer, never on the sale's size — so the breach and arm edges bisect directly
 * (tests/unit/stressGrid.test.ts ladders). "rank >= sold" is NOT, everywhere: the debt
 * floor (LE:2721-2728) lifts a sub-$2,000 target to the WHOLE loan when the loan is under
 * $4,000, but only to $2,000 above it. So where the debt at the sale call crosses $4,000
 * (the reverse solve's LTV axis) and the recall reaches $2,000, a deeper shock SHRINKS the
 * target: sold (whole-loan target, recall short of it) → recall_liquidated (target
 * dMin..recall) → sold (target past the recall). Under master's no-guard floor the same
 * island also opened at a FIXED debt in [dMin, 2·dMin) on the price axis (a target past
 * $2,000 stood); the remainder guard the owner ruled on 2026-10-04 closes that one, since
 * every target in that band is then the whole loan. The sold island can only open AT the sale-path entry
 * (the target grows with the shock once it stands), so the sale edge is solved in two
 * steps: bisect the monotone sale-path entry below every normalization grid; if that
 * first sale-path node sells, it IS the edge; otherwise bisect "sold" above it, where it
 * is monotone (tests/unit/frontier.test.ts, debt-floor band).
 *
 * THE FLOOR CLOSE BREAKS THAT STRUCTURE (owner ruling 2026-10-04, debt floor on what a call
 * actually repays). A recall that arrives short of an ask already escalated to the whole
 * loan, and would leave 0 < debt < dMin, makes the call repay all: collateral sells the
 * remainder (stressGrid saleReason 'floor'), ranked `sold` though no sale path was taken.
 * It sells only while the debt at the call is small (under ~2·dMin, or tiny collateral),
 * so on the reverse solve's LTV axis it sells from the breach up to that debt and then
 * STOPS, and on the capacity axis a small cut sells while a larger one cures. Every edge
 * therefore runs two guards before its bisection is trusted. BREACH ENTRY
 * (`breachEntryEdge`): the breach is monotone and nothing below it can arm or sell, so if
 * the first node past it triggers, that is the edge — this catches a floor-close run that
 * opens at the breach however narrow it is. WHOLE UNITS (`firstTriggeringUnit`): every
 * whole unit up to the axis maximum is run, and the bisection's edge stands only if it is
 * at or below the first unit that triggers — otherwise the edge is bracketed inside that
 * unit. RESIDUAL GAP (stated, not hidden): a floor-close run that opens AWAY from the
 * breach and is narrower than one unit can still be missed — on the reverse solve with an
 * explicit USD exit capacity X it starts where the debt passes X and ends at 2·dMin, so
 * it is sub-unit only when X sits within ~1% of collateral under $4,000.
 *
 * ROUNDED TOWARD RISK. `display` is the largest WHOLE unit (whole % or whole hour) with
 * no trigger anywhere in [0, display]. The true edge (the smallest x that triggers) lies
 * in (display, display + 1], so quoting `display` as the distance never overstates it.
 * display + 1 itself triggers wherever the outcome is monotone; inside the debt-floor
 * band it can sit in the recall_liquidated gap past a narrow sold island, so it is NOT
 * re-checked. `safeBelow` / `triggersAt` bracket the edge to `tol` in native units
 * (fractions, or hours). `at` is the keyed node at `triggersAt`, so every edge links to a
 * reproducible cell.
 *
 * NO COMBINED ROUTE. Venue axes are solved at an explicit, named reference price shock —
 * never folded into one "cheapest route to red" (RISK_FRONTIER_DESIGN.md §2): that would
 * hide an exchange rate between the price axis and the venue axis.
 */

import {
  STRESS_CODE_VERSION,
  STRESS_DEFAULT_STEP_SECONDS,
  STRESS_LABEL,
  STRESS_SEVERITY,
  runStress,
  stressRank,
  type PriceShape,
  type StressPosition,
  type StressResult,
  type StressRunOptions,
  type VenueStress,
} from './stressGrid'

// ---------------------------------------------------------------- constants

/** Price axis searched up to a 99% drop. */
export const PRICE_MAX_DROP = 0.99
/** Bisection tolerance on fractions (drop, capacity reduction): 0.001%. */
export const FRACTION_TOL = 1e-5
/** Bisection tolerance on starting LTV for the reverse solve. */
export const LTV_TOL = 1e-6
/** Freeze axis searched up to 72 h. */
export const DEFAULT_MAX_FREEZE_HOURS = 72
/** Bisection tolerance on hours: 0.36 s, well under one grid step. */
export const HOURS_TOL = 1e-4
/** Venue axes are solved at this named grid scenario unless the caller names another. */
export const DEFAULT_VENUE_REFERENCE: PriceShape = { kind: 'step', drop: 0.25 }
/** The reverse solve's two shocks (RISK_FRONTIER_DESIGN.md §2, "Additions"). */
export const REVERSE_SOLVE_DROPS = [0.5, 0.6] as const

// -------------------------------------------------------------------- types

/** A price shape with its depth left open. */
export type ShapeFamily =
  | { kind: 'step' }
  | { kind: 'linear'; hours: number }
  | { kind: 'wick'; hours: number; recover?: number }

export const STEP_FAMILY: ShapeFamily = { kind: 'step' }

export type FrontierUnit = 'pct' | 'hours'

export type NotApplicableReason = 'no_delay_class' | 'levered_long_no_recall' | 'not_modelled'

export type FrontierEdge =
  | {
      status: 'found'
      unit: FrontierUnit
      /** Largest whole unit with no trigger in [0, display]; the edge is in (display, display + 1]. */
      display: number
      /** Nothing in [0, safeBelow] triggers (native units). */
      safeBelow: number
      /** Smallest bisection value that triggered (native units). */
      triggersAt: number
      iterations: number
      /** The node at `triggersAt`. */
      at: StressResult
    }
  /** Triggers with no shock at all. */
  | { status: 'already'; unit: FrontierUnit; at: StressResult }
  /** Never triggers inside the searched range [0, max]. */
  | { status: 'beyond_range'; unit: FrontierUnit; max: number }
  | { status: 'not_applicable'; reason: NotApplicableReason }

export type BisectResult =
  | { status: 'already' }
  | { status: 'beyond_range' }
  | { status: 'found'; safeBelow: number; triggersAt: number; iterations: number }

// --------------------------------------------------------------- bisection

/**
 * Smallest x in [lo, hi] for which a MONOTONE predicate holds, bracketed to `tol`:
 * triggers(safeBelow) is false, triggers(triggersAt) is true, triggersAt − safeBelow <= tol.
 */
export function bisectEdge(
  triggers: (x: number) => boolean,
  lo: number,
  hi: number,
  tol: number,
  maxIterations = 64,
): BisectResult {
  if (triggers(lo)) return { status: 'already' }
  if (!triggers(hi)) return { status: 'beyond_range' }
  let a = lo
  let b = hi
  let iterations = 0
  while (b - a > tol && iterations < maxIterations) {
    const m = (a + b) / 2
    if (triggers(m)) b = m
    else a = m
    iterations++
  }
  return { status: 'found', safeBelow: a, triggersAt: b, iterations }
}

interface AxisSpec {
  run: (x: number) => StressResult
  hi: number
  tol: number
  unit: FrontierUnit
  /** Display units per native unit: 100 for a fraction shown in %, 1 for hours. */
  scale: number
}

/**
 * Snap to the whole-unit grid, toward risk. Every unit at or below floor(safeBelow) is
 * safe by construction. The ONE unit inside the bracket (safeBelow, triggersAt), if any,
 * is checked: where it does not trigger it is still below the edge (the bracket is a
 * monotone stretch, or narrower than every normalization grid), so it is safe too. Never
 * walks past `triggersAt`: stepping up "while display + 1 does not trigger" ran straight
 * over a narrow sold island into the recall_liquidated gap behind it (87 for an edge at
 * 86.11%).
 */
function snapTowardRisk(
  safeBelow: number,
  triggersAt: number,
  spec: AxisSpec,
  triggers: (x: number) => boolean,
): number {
  let d = Math.max(0, Math.floor(safeBelow * spec.scale))
  if (d > 0 && d / spec.scale > safeBelow) d-- // float guard: d must sit at or below safeBelow
  while (d > 0 && triggers(d / spec.scale)) d-- // unreachable on a sound bracket; kept as a guard
  const next = (d + 1) / spec.scale
  if (next > safeBelow && next < triggersAt && !triggers(next)) d++
  return d
}

/**
 * Bracket an edge below every normalization grid stressGrid keys on (fractions 1e-6,
 * USD cents, hours 1e-4): `triggersAt` then normalizes to the FIRST node that triggers.
 */
const ENTRY_TOL_REL = 1e-12

/**
 * The sale edge: the smallest x that SELLS, where "sold" is not monotone (the debt-floor
 * band, see the header). The sale-path entry ("rank >= recall_liquidated") is monotone;
 * the floor's sold island can only open at it.
 */
function bisectSale(spec: AxisSpec): BisectResult {
  const rankAt = (x: number) => stressRank(spec.run(x))
  const sells = (x: number) => rankAt(x) >= STRESS_SEVERITY.sold
  const onSalePath = (x: number) => rankAt(x) >= STRESS_SEVERITY.recall_liquidated
  const entry = bisectEdge(onSalePath, 0, spec.hi, spec.hi * ENTRY_TOL_REL)
  if (entry.status === 'beyond_range') return { status: 'beyond_range' }
  let lo = 0
  let spent = 0
  if (entry.status === 'found') {
    // The first sale-path node sells: the floor lifted its target to the whole loan (or
    // the recall was short of it). Nothing below the entry reached the sale path.
    if (sells(entry.triggersAt)) return entry
    lo = entry.triggersAt
    spent = entry.iterations
  }
  // Past an entry that did not sell, the target only grows with the shock: monotone.
  // (sells(lo) is false here unless lo = 0, so 'already' means "sells at no shock".)
  const b = bisectEdge(sells, lo, spec.hi, spec.tol)
  return b.status === 'found' ? { ...b, iterations: b.iterations + spent } : b
}

/**
 * WHOLE-UNIT GUARD. The smallest whole unit k in (0, hi] (x = k / scale, the last one
 * clamped to hi) whose node triggers, or null. One run per unit: about 100 runs (~2 ms) an
 * edge. Bisection alone trusts the axis's structure, and the FLOOR CLOSE breaks it (owner
 * ruling 2026-10-04: a recall that would strand 0 < debt < dMin makes the call repay all,
 * stressGrid saleReason 'floor'). That sale opens wherever the debt at the call is small
 * enough that the ask is the whole loan and the venue is short of it — on the reverse
 * solve's LTV axis it SELLS from the breach up to ~2·dMin of debt and then stops (debt
 * $3,999 on $5,713 at 75% deployed: sold for start LTV 41%–69%, recall_cured at the line,
 * so bisection read 'beyond_range'); on the capacity axis it sells for a small cut and
 * stops for a larger one. The scan finds the first whole unit that triggers; the
 * bisection's own edge is kept only when it lies at or below that unit.
 */
function firstTriggeringUnit(spec: AxisSpec, triggers: (x: number) => boolean): number | null {
  const units = Math.ceil(spec.hi * spec.scale - 1e-9)
  for (let k = 1; k <= units; k++) {
    if (triggers(Math.min(spec.hi, k / spec.scale))) return k
  }
  return null
}

/**
 * BREACH-ENTRY CHECK. Nothing below the first breach can arm or sell (no breach ranks 0),
 * and "rank >= recall_cured" is monotone on every axis — a breach depends on the price
 * path and the line, never on the venue. The floor close opens AT that entry wherever the
 * debt at the first call is already small (it can be narrower than one whole unit: debt
 * $5,332 on $9,412 at a 84.2% line, 51% deployed, sells for start LTV 42.11%–42.50% at a
 * 50% step and cures above). So when the first node past the breach triggers, that node
 * IS the edge.
 */
function breachEntryEdge(
  spec: AxisSpec,
  minRank: number,
  triggers: (x: number) => boolean,
): BisectResult | null {
  if (minRank <= STRESS_SEVERITY.recall_cured) return null
  const breach = bisectEdge(
    (x) => stressRank(spec.run(x)) >= STRESS_SEVERITY.recall_cured,
    0,
    spec.hi,
    spec.hi * ENTRY_TOL_REL,
  )
  return breach.status === 'found' && triggers(breach.triggersAt) ? breach : null
}

function solveEdge(spec: AxisSpec, minRank: number): FrontierEdge {
  const triggers = (x: number) => stressRank(spec.run(x)) >= minRank
  if (triggers(0)) return { status: 'already', unit: spec.unit, at: spec.run(0) }
  const atBreach = breachEntryEdge(spec, minRank, triggers)
  let b: BisectResult =
    atBreach ??
    (minRank === STRESS_SEVERITY.sold
      ? bisectSale(spec)
      : bisectEdge(triggers, 0, spec.hi, spec.tol))
  const k = atBreach ? null : firstTriggeringUnit(spec, triggers)
  if (k !== null) {
    const unitHi = Math.min(spec.hi, k / spec.scale)
    if (b.status !== 'found' || b.triggersAt > unitHi) {
      // The bisection missed an earlier stretch that triggers. Unit k − 1 (or 0) does not
      // trigger and unit k does: bracket the edge inside that one unit.
      b = bisectEdge(triggers, (k - 1) / spec.scale, unitHi, spec.tol)
    }
  }
  if (b.status === 'already') return { status: 'already', unit: spec.unit, at: spec.run(0) }
  if (b.status === 'beyond_range') return { status: 'beyond_range', unit: spec.unit, max: spec.hi }
  return {
    status: 'found',
    unit: spec.unit,
    display: snapTowardRisk(b.safeBelow, b.triggersAt, spec, triggers),
    safeBelow: b.safeBelow,
    triggersAt: b.triggersAt,
    iterations: b.iterations,
    at: spec.run(b.triggersAt),
  }
}

const notApplicable = (reason: NotApplicableReason): FrontierEdge => ({
  status: 'not_applicable',
  reason,
})

// ------------------------------------------------------------- price axis

export function shapeWithDrop(family: ShapeFamily, drop: number): PriceShape {
  switch (family.kind) {
    case 'step':
      return { kind: 'step', drop }
    case 'linear':
      return { kind: 'linear', drop, hours: family.hours }
    case 'wick':
      return { kind: 'wick', drop, hours: family.hours, recover: family.recover }
  }
}

export interface PriceAxis {
  family: ShapeFamily
  breach: FrontierEdge
  arm: FrontierEdge
  sale: FrontierEdge
}

export interface PriceFrontierOptions extends StressRunOptions {
  /** Default: a step. */
  family?: ShapeFamily
  /** Venue condition held fixed while the price shock grows. Default: baseline. */
  venue?: VenueStress
}

/** Smallest price shock (whole % drop) that breaches, arms, and sells. */
export function priceFrontier(
  position: StressPosition,
  opts: PriceFrontierOptions = {},
): PriceAxis {
  const family = opts.family ?? STEP_FAMILY
  const run = (drop: number) =>
    runStress(position, { price: shapeWithDrop(family, drop), venue: opts.venue }, opts)
  const spec: AxisSpec = { run, hi: PRICE_MAX_DROP, tol: FRACTION_TOL, unit: 'pct', scale: 100 }
  if (run(0).outcome === 'not_modelled') {
    const na = notApplicable('not_modelled')
    return { family, breach: na, arm: na, sale: na }
  }
  return {
    family,
    breach: solveEdge(spec, STRESS_SEVERITY.recall_cured),
    arm:
      position.membraneClass === 'no-delay'
        ? notApplicable('no_delay_class')
        : solveEdge(spec, STRESS_SEVERITY.armed_cured),
    sale: solveEdge(spec, STRESS_SEVERITY.sold),
  }
}

// ------------------------------------------------------------- venue axes

export interface VenueAxis {
  /** The named price shock the venue axis is solved at. */
  reference: PriceShape
  arm: FrontierEdge
  sale: FrontierEdge
}

function venueAxis(position: StressPosition, reference: PriceShape, spec: AxisSpec): VenueAxis {
  if (position.tradeShape === 'levered_long') {
    const na = notApplicable('levered_long_no_recall')
    return { reference, arm: na, sale: na }
  }
  if (spec.run(0).outcome === 'not_modelled') {
    const na = notApplicable('not_modelled')
    return { reference, arm: na, sale: na }
  }
  return {
    reference,
    arm:
      position.membraneClass === 'no-delay'
        ? notApplicable('no_delay_class')
        : solveEdge(spec, STRESS_SEVERITY.armed_cured),
    sale: solveEdge(spec, STRESS_SEVERITY.sold),
  }
}

/**
 * Smallest cut in venue exit capacity (whole %, "capacity −62%") that arms / sells at the
 * reference shock. Severity x is the reduction: capacity multiplier = 1 − x.
 */
export function capacityFrontier(
  position: StressPosition,
  reference: PriceShape = DEFAULT_VENUE_REFERENCE,
  opts: StressRunOptions = {},
): VenueAxis {
  const run = (cut: number) =>
    runStress(position, { price: reference, venue: { capacityMult: 1 - cut } }, opts)
  return venueAxis(position, reference, { run, hi: 1, tol: FRACTION_TOL, unit: 'pct', scale: 100 })
}

/**
 * Shortest venue freeze (whole hours, counted from the first breach) that arms / sells at
 * the reference shock.
 */
export function freezeFrontier(
  position: StressPosition,
  reference: PriceShape = DEFAULT_VENUE_REFERENCE,
  opts: StressRunOptions & { maxHours?: number } = {},
): VenueAxis {
  const run = (hours: number) =>
    runStress(position, { price: reference, venue: { freezeHours: hours } }, opts)
  const hi = opts.maxHours ?? DEFAULT_MAX_FREEZE_HOURS
  return venueAxis(position, reference, { run, hi, tol: HOURS_TOL, unit: 'hours', scale: 1 })
}

// ----------------------------------------------------------- reverse solve

/**
 * The same position at another starting LTV: collateral fixed, debt = ltv × collateral.
 * A carry position keeps its deployed SHARE of the debt; an explicit exit capacity in USD
 * (a venue-wide figure) is kept as given, while a named `exitCapacityPreset` or a custom
 * `exitCapacityMult` re-resolves against the scaled deployed amount.
 */
export function withStartLtv(position: StressPosition, ltv: number): StressPosition {
  const debtUsd = ltv * position.collateralUsd
  const share = position.debtUsd > 0 ? (position.deployedUsd ?? 0) / position.debtUsd : 0
  return {
    ...position,
    debtUsd,
    deployedUsd: position.deployedUsd === undefined ? undefined : share * debtUsd,
  }
}

export interface ReverseSolveOptions extends StressRunOptions {
  family?: ShapeFamily
  venue?: VenueStress
}

/**
 * The highest starting LTV (whole %, toward risk) that sees NO sale at a `drop` shock of
 * the given shape. Searched over [0, line] — any LTV up to the line is a live position.
 * 'beyond_range' = no sale at any starting LTV up to the line.
 */
export function reverseSolveLtv(
  position: StressPosition,
  drop: number,
  opts: ReverseSolveOptions = {},
): FrontierEdge {
  const price = shapeWithDrop(opts.family ?? STEP_FAMILY, drop)
  // The position AS GIVEN first: withStartLtv replaces the debt (and zeroes the deployed
  // share of a NaN or non-positive debt), so run(0) alone would solve an invalid position
  // as a valid no-recall one and return numbers.
  if (runStress(position, { price, venue: opts.venue }, opts).outcome === 'not_modelled') {
    return notApplicable('not_modelled')
  }
  const run = (ltv: number) =>
    runStress(withStartLtv(position, ltv), { price, venue: opts.venue }, opts)
  if (run(0).outcome === 'not_modelled') return notApplicable('not_modelled')
  return solveEdge(
    { run, hi: position.line, tol: LTV_TOL, unit: 'pct', scale: 100 },
    STRESS_SEVERITY.sold,
  )
}

// ----------------------------------------------------------------- summary

export interface DistanceToDanger {
  codeVersion: string
  label: string
  /** The price axis on the chosen family (default: step). */
  price: PriceAxis
  /**
   * Smallest drop that sells AT the shock even if the price recovers one step later: the
   * band break for the delayed class, the line for the no-delay class (after any recall).
   */
  saleAtShock: FrontierEdge
  capacity: VenueAxis
  freeze: VenueAxis
  reverse: { family: ShapeFamily; at50: FrontierEdge; at60: FrontierEdge }
}

export interface DistanceToDangerOptions extends StressRunOptions {
  family?: ShapeFamily
  venueReference?: PriceShape
  reverseFamily?: ShapeFamily
  maxFreezeHours?: number
}

/** Every axis for one position. Several hundred stressGrid runs; pure and deterministic. */
export function distanceToDanger(
  position: StressPosition,
  opts: DistanceToDangerOptions = {},
): DistanceToDanger {
  const step = opts.stepSeconds ?? STRESS_DEFAULT_STEP_SECONDS
  const reference = opts.venueReference ?? DEFAULT_VENUE_REFERENCE
  const reverseFamily = opts.reverseFamily ?? STEP_FAMILY
  const oneStepWick: ShapeFamily = { kind: 'wick', hours: step / 3600 }
  const [d50, d60] = REVERSE_SOLVE_DROPS
  return {
    codeVersion: STRESS_CODE_VERSION,
    label: STRESS_LABEL,
    price: priceFrontier(position, { ...opts, family: opts.family }),
    saleAtShock: priceFrontier(position, { ...opts, family: oneStepWick }).sale,
    capacity: capacityFrontier(position, reference, opts),
    freeze: freezeFrontier(position, reference, { ...opts, maxHours: opts.maxFreezeHours }),
    reverse: {
      family: reverseFamily,
      at50: reverseSolveLtv(position, d50, { ...opts, family: reverseFamily }),
      at60: reverseSolveLtv(position, d60, { ...opts, family: reverseFamily }),
    },
  }
}
