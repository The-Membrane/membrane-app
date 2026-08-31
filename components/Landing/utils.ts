import { BORROW_RATE, BTC_PX, MAX_LTV, ROUTE_BAR_MAX, ROUTE_BAR_ZERO, VENUES } from './fixtures'
import { CarryVariant, LandingCalc, LandingState, RecallRow, Route } from './types'

/** `$1,234` — rounded whole-dollar formatter. */
export const usd = (n: number): string => '$' + Math.round(n).toLocaleString('en-US')

/** `-$1,234` — signed whole-dollar formatter (leading minus outside the $). */
export const usdc = (n: number): string =>
  (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US')

/** `1.00 BTC`. */
export const btcs = (n: number): string => n.toFixed(2) + ' BTC'

/** Percent formatter with fixed digits, no sign. */
export const pct = (n: number, digits = 1): string => n.toFixed(digits) + '%'

/**
 * Core position math, ported 1:1 from the proto's `calc()`.
 */
export const calc = (st: LandingState): LandingCalc => {
  const coll = st.btc * BTC_PX
  const debt = coll * st.ltv
  const v = VENUES[st.venue]
  const earn = debt * v.apr
  const cost = debt * BORROW_RATE
  const net = earn - cost
  // Price at which the grace clock starts (LTV crosses max).
  const trigger = BTC_PX * (st.ltv / MAX_LTV)
  const dropPct = (1 - trigger / BTC_PX) * 100
  return { coll, debt, v, earn, cost, net, trigger, dropPct }
}

/** Carry-box variant selection, mirroring the proto's cascading conditions. */
export const carryVariant = (c: LandingCalc): CarryVariant => {
  if (c.net < 0) return 'neg'
  if (c.dropPct < 10) return 'neg'
  if (c.dropPct < 25) return 'warn'
  return 'default'
}

/** Foot copy under the carry line, matching the proto branch-for-branch. */
export const carryFoot = (st: LandingState, c: LandingCalc): string => {
  if (c.net < 0) {
    return 'At this venue rate the loan does not pay for itself. Lower the amount or pick a higher-earning venue.'
  }
  if (c.dropPct < 10) {
    return `It earns ${usd(c.net)}/yr. Bitcoin moves that much in a bad afternoon — this is a size problem, not a yield problem.`
  }
  if (c.dropPct < 25) {
    return `You still own ${btcs(st.btc)}. Bitcoin has moved ${c.dropPct.toFixed(0)}% in a week before.`
  }
  return `You still own ${btcs(st.btc)}. Nothing was sold, and Bitcoin has ${c.dropPct.toFixed(0)}% to fall before the clock starts.`
}

/** Yield-covers-interest multiple. */
export const coverMultiple = (c: LandingCalc): number => (c.cost > 0 ? c.earn / c.cost : 0)

/**
 * Venue-recall trajectory rows, ported from `renderRecall`. At liquidation the
 * engine pulls what is liquid from each deployed venue and applies it to debt
 * before collateral is touched; the mix the user picked sets that number.
 */
export const recallRows = (c: LandingCalc): RecallRow[] => {
  const v = c.v
  const live = c.debt * v.liquid
  const cold = c.debt * v.cooled
  return [
    { w: 'deployed', d: c.debt, n: 'all of what you borrowed', now: true },
    { w: 'recallable now', d: live, n: `${(v.liquid * 100).toFixed(0)}% of the debt` },
    { w: 'if a venue is locked', d: cold, n: `${(v.cooled * 100).toFixed(0)}% of the debt`, warn: true },
    { w: 'worst case from BTC', d: c.debt - cold, n: 'the rest comes from collateral', warn: true },
  ]
}

/** Recallable-now dollars, for the recall footnote. */
export const recallLive = (c: LandingCalc): number => c.debt * c.v.liquid

/**
 * Counterfactual: BTC that a sale would have cost, and what's left after.
 */
export const counterfactual = (st: LandingState, c: LandingCalc) => {
  const btcSold = c.debt / BTC_PX
  const kept = st.btc - btcSold
  return { btcSold, kept }
}

/** Geometry for a diverging route bar: {@link fillPct} width, {@link left} offset (%). */
export const routeBar = (r: Route) => {
  const frac = Math.min(1, Math.abs(r.net) / ROUTE_BAR_MAX) * 50
  const positive = r.net >= 0
  return {
    positive,
    fillPct: frac,
    left: positive ? ROUTE_BAR_ZERO : ROUTE_BAR_ZERO - frac,
    zero: ROUTE_BAR_ZERO,
  }
}
