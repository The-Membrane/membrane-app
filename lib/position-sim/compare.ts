/**
 * The comparison engine: one position, one measured price path, two liquidation
 * engines.
 *
 * The price move is IDENTICAL in both runs. That is the point — the only thing that
 * differs is what each engine does when the line is crossed, so the gap between the
 * two end-equities is attributable to engine design and nothing else.
 *
 * WHAT IS REAL:
 *   - the price path                    measured, public/data/oct10-2025
 *   - the source protocol's LT/bonus    read on-chain by the adapter
 *   - the source protocol's repay size  MEASURED from Oct 10 liquidation events
 *   - Membrane's repay formula, cure window, LTV gap, recall ordering — contract source
 *   - the no-delay class: no window, sold the minute it is over its line
 *                                       LiquidationEngine.sol:1572-1576 (curePath.ts vii)
 *   - mixed delay classes refused in one position             Cdp.sol:1650-1651
 *   - the paid recall-only lane: a recall that alone cures still pays the keeper's fee
 *     from collateral                   LiquidationEngine.sol:1603-1658
 * WHAT IS MODELLED:
 *   - Membrane's per-asset max LTV      no deployment exists (see membrane.ts)
 *   - which collateral is no-delay      stable => no-delay listing (collateralClass.ts);
 *                                       the contracts carry no stable label, the class
 *                                       follows the immutable LTV cap
 *   - a mixed position's split          two isolated positions, debt pro-rata to value
 *   - Membrane's liquidation fee        capped by the real MAX_LIQ_FEE = 10%
 *   - the venue recall + fast rates     user inputs; the dominant variable
 */

import {
  MAX_LTV_HARD_CAP,
  NO_DELAY_LTV_HARD_CAP,
  delayClassOf,
  isNoDelayCollateral,
} from './collateralClass'
import { DelayTimer } from './curePath'
import {
  fullRepayValue,
  membraneBorrowLtv,
  membraneRepayValue,
  weightedMembraneLine,
  CURE_WINDOW_HOURS,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
  MEMBRANE_CONSTANTS_PROVENANCE,
  type VenueRecall,
} from './membrane'
import { priceAt } from './scenario'
import { stamp, type Comparison, type PricePath, type ProtocolPosition, type SimEvent, type SimRun } from './types'

/** 10% ceiling — real: lib/Constants.sol:57 MAX_LIQ_FEE = 1e17. */
export const MAX_LIQ_FEE = 0.1

export interface CompareOptions {
  /** Override the modelled Membrane liquidation line. */
  membraneMaxLtv?: number
  /** Membrane's liquidation fee, 0–MAX_LIQ_FEE. Modelled. */
  membraneLiqFee: number
  /** Deployment-venue recall, or null when the debt is not detectably deployed. */
  venue: VenueRecall | null
  /**
   * The share of the loan the SOURCE protocol repays per liquidation. This is measured
   * from Oct 10, not assumed: Aave's median was 0.578 (close factor visible as a spike
   * at 0.50); Morpho's median was 1.00 (no close factor — 65.5% were full).
   */
  sourceRepayFraction: number
  sourceRepayFractionLabel: string
  scenarioLabel: string
  /** `liqDebtMinimum` in USD. Defaults to the deployed $2,000. 0 disables the floor. */
  debtMinimumUsd?: number
}

interface Leg {
  symbol: string
  amount: number
  /** Scratch: value at the current minute. */
  value: number
}

/** A single episode may not run more than this many sales. Mirrors cureWalk. */
const MAX_SALES = 20

/** The SOURCE engine's own throttle: one liquidation per minute at most. */
const MIN_SOURCE_EVENT_GAP_MINUTES = 1

function valueOf(legs: Leg[], path: PricePath, i: number, fallback: Record<string, number>): number {
  let total = 0
  for (const leg of legs) {
    const p = priceAt(path, leg.symbol, i) ?? fallback[leg.symbol] ?? 0
    leg.value = leg.amount * p
    total += leg.value
  }
  return total
}

/** Removes `usd` of value pro-rata across the collateral legs, returning what it
 *  could actually take (less than asked when the collateral runs out). */
function seizeProRata(legs: Leg[], usd: number, path: PricePath, i: number, fallback: Record<string, number>): number {
  const total = valueOf(legs, path, i, fallback)
  if (total <= 0 || usd <= 0) return 0
  const take = Math.min(usd, total)
  const share = take / total
  for (const leg of legs) {
    leg.amount *= 1 - share
  }
  return take
}

function makeLegs(src: { symbol: string; amount: number }[]): Leg[] {
  return src.map((l) => ({ symbol: l.symbol, amount: l.amount, value: 0 }))
}

/**
 * The SOURCE protocol's engine: a close-factor share of the loan is repaid and the
 * liquidator seizes that value plus the liquidation bonus. Repeats while the position
 * stays unhealthy. No cure window, no recall — those do not exist here.
 */
function runSource(position: ProtocolPosition, path: PricePath, opts: CompareOptions): SimRun {
  const coll = makeLegs(position.collateral)
  const debt = makeLegs(position.debt)
  const fallbackC = Object.fromEntries(position.collateral.map((c) => [c.symbol, c.priceUsd]))
  const fallbackD = Object.fromEntries(position.debt.map((d) => [d.symbol, d.priceUsd]))

  // Collateral-weighted liquidation bonus, read on-chain by the adapter. Legs that
  // do not expose one are excluded from the weighting rather than defaulted, and the
  // run records that it happened.
  const priced = position.collateral.filter((c) => c.liquidationBonus !== null)
  const pricedValue = priced.reduce((a, c) => a + c.valueUsd, 0)
  const bonus =
    pricedValue > 0 ? priced.reduce((a, c) => a + (c.liquidationBonus as number) * c.valueUsd, 0) / pricedValue : 0
  const unpricedBonus = position.collateral.filter((c) => c.liquidationBonus === null).map((c) => c.symbol)
  const line = position.liquidationLtv

  // The borrower's deployed capital is still their asset. The source protocol has no
  // recall mechanism, so it simply sits there — but it must be on the balance sheet in
  // BOTH runs or the comparison is rigged in Membrane's favour.
  const deployed = opts.venue?.deployedUsd ?? 0

  const events: SimEvent[] = []
  const equitySeries: (number | null)[] = []
  const ltvSeries: (number | null)[] = []
  let penaltyPaid = 0
  let peakLtv = 0
  let lastEvent = -999
  let startEquity = 0

  for (let i = 0; i < path.count; i++) {
    let c = valueOf(coll, path, i, fallbackC)
    let d = valueOf(debt, path, i, fallbackD)
    if (i === 0) startEquity = c + deployed - d

    let ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
    if (Number.isFinite(ltv)) peakLtv = Math.max(peakLtv, ltv)

    if (ltv > line && d > 0 && i - lastEvent > MIN_SOURCE_EVENT_GAP_MINUTES) {
      const repay = Math.min(d, fullRepayValue(d, opts.sourceRepayFraction))
      const wantSeize = repay * (1 + bonus)
      const got = seizeProRata(coll, wantSeize, path, i, fallbackC)
      // The liquidator only repays what the seized collateral actually covered.
      const effectiveRepay = bonus > -1 ? got / (1 + bonus) : got
      const penalty = got - effectiveRepay
      penaltyPaid += penalty

      const share = d > 0 ? effectiveRepay / d : 0
      for (const leg of debt) leg.amount *= 1 - share

      c = valueOf(coll, path, i, fallbackC)
      d = valueOf(debt, path, i, fallbackD)
      ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
      lastEvent = i

      events.push({
        minute: i,
        ts: path.startTs + i * path.stepSeconds,
        kind: 'liquidation',
        ltv,
        line,
        repaidUsd: effectiveRepay,
        seizedUsd: got,
        recalledUsd: 0,
        penaltyUsd: penalty,
        why:
          `LTV crossed the ${(line * 100).toFixed(1)}% liquidation threshold. ` +
          `${opts.sourceRepayFractionLabel} of the loan was repaid and the liquidator ` +
          `took ${(bonus * 100).toFixed(1)}% on top as the bonus.`,
      })
    }

    equitySeries.push(c + deployed - d)
    ltvSeries.push(Number.isFinite(ltv) ? ltv : null)
  }

  const endColl = valueOf(coll, path, path.count - 1, fallbackC)
  const endDebt = valueOf(debt, path, path.count - 1, fallbackD)

  return {
    engine: 'source',
    label: position.label,
    events,
    endCollateralUsd: endColl,
    endDebtUsd: endDebt,
    endDeployedUsd: deployed,
    startEquityUsd: startEquity,
    endEquityUsd: endColl + deployed - endDebt,
    penaltyPaidUsd: penaltyPaid,
    peakLtv,
    wiped: endColl <= 0.01 * Math.max(1, position.totalCollateralUsd),
    equitySeries,
    ltvSeries,
    provenance: stamp(
      'modelled',
      `${position.label} engine · modelled`,
      'Liquidation threshold and bonus read on-chain. Repay size taken from measured Oct 10 liquidation events, not from the documented close factor.',
    ),
    caveats: [
      'Liquidations are modelled as firing at the first minute the oracle prints above the threshold. A real liquidation needs a profitable liquidator to show up in that minute; in practice some fire late, and a few never fire.',
      'Gas, MEV competition and slippage on the seized collateral are not modelled. All three make the real outcome worse than this run, not better.',
      ...(unpricedBonus.length
        ? [`No liquidation bonus is exposed for ${unpricedBonus.join(', ')}, so ${unpricedBonus.length > 1 ? 'those legs were' : 'that leg was'} left out of the weighted bonus rather than given an assumed one.`]
        : []),
    ],
  }
}

/** One isolated Membrane position: what `walkMembrane` runs. */
export interface MembraneSub {
  /** null for the whole position; a short label for each half of a split mixed position. */
  label: string | null
  collateral: { symbol: string; amount: number; priceUsd: number }[]
  debt: { symbol: string; amount: number; priceUsd: number }[]
  /** The liquidation line (max LTV) this position is judged against. */
  line: number
  /** The no-delay class (curePath.ts clause vii): no window, sold the minute it is over. */
  noDelay: boolean
  venue: VenueRecall | null
  /**
   * Split halves only: no leg of this half has a modelled max LTV, so it runs at the whole
   * position's (scaled) line instead of a line of its own. Stated in the run's caveats.
   */
  lineFromWhole?: boolean
}

/** One position walked over the path, before it is assembled into a SimRun. */
interface MembraneSubRun {
  events: SimEvent[]
  equitySeries: (number | null)[]
  ltvSeries: (number | null)[]
  /** Collateral and debt value after each minute's events — to recombine a split. */
  collSeries: number[]
  debtSeries: number[]
  startEquity: number
  endColl: number
  endDebt: number
  endDeployed: number
  penaltyPaid: number
  peakLtv: number
}

/**
 * Walks ONE isolated Membrane position: partial repay back to the borrow cap, recall from
 * deployment venues before touching collateral, and — in the delayed class — an 8-hour
 * cure window. A position in the no-delay class has no window: it is sold the minute it
 * is over its line.
 */
function walkMembrane(sub: MembraneSub, path: PricePath, opts: CompareOptions): MembraneSubRun {
  const coll = makeLegs(sub.collateral)
  const debt = makeLegs(sub.debt)
  const fallbackC = Object.fromEntries(sub.collateral.map((c) => [c.symbol, c.priceUsd]))
  const fallbackD = Object.fromEntries(sub.debt.map((d) => [d.symbol, d.priceUsd]))

  const line = sub.line
  const cap = membraneBorrowLtv(line)
  const fee = Math.max(0, Math.min(MAX_LIQ_FEE, opts.membraneLiqFee))
  const dMin = opts.debtMinimumUsd ?? LIQ_DEBT_MINIMUM_USD
  const cureMinutes = Math.round(CURE_WINDOW_SECONDS / path.stepSeconds)
  /** Above this the window is BROKEN: no cure, immediate sale (BrokeWindow). */
  const breakLine = line * (1 + MAX_THRESHOLD_TO_DELAY)
  /** Prefix for the event log when a mixed position was split in two. */
  const who = sub.label ? `${sub.label}: ` : ''

  /**
   * THE SHARED WALK. This is the same `DelayTimer` the Oct-10 census runs through
   * `cureWalk` (lib/position-sim/curePath.ts) — not a second copy of the rules. The
   * timer decides WHEN; recall, the fee and the multi-leg pricing are layered on top
   * here and are the only differences. scripts/tests/position-sim.test.ts replays two
   * real census accounts through this engine and asserts the same outcome and the
   * same closed USD. `noDelay` is the census's no-delay class too (clause vii).
   */
  const timer = new DelayTimer({
    line,
    band: MAX_THRESHOLD_TO_DELAY,
    delaySteps: cureMinutes,
    noDelay: sub.noDelay,
  })

  const events: SimEvent[] = []
  const equitySeries: (number | null)[] = []
  const ltvSeries: (number | null)[] = []
  const collSeries: number[] = []
  const debtSeries: number[] = []
  let penaltyPaid = 0
  let peakLtv = 0
  let startEquity = 0
  let sales = 0
  /** Venue capital already spent — a venue cannot answer the same dollar twice. */
  let venueDrawn = 0
  /** Capital still in venues. Falls as capital is recalled; equity counts it. */
  const deployedStart = sub.venue?.deployedUsd ?? 0
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
  /** Cumulative ceilings on what the venue can return: synchronously, and inside 8h. */
  const recallRate = clamp01(sub.venue?.recallRate ?? 0)
  const fastRate = clamp01(sub.venue?.fastRate ?? 0)

  for (let i = 0; i < path.count; i++) {
    let c = valueOf(coll, path, i, fallbackC)
    let d = valueOf(debt, path, i, fallbackD)
    if (i === 0) startEquity = c + deployedStart - d

    let ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
    if (Number.isFinite(ltv)) peakLtv = Math.max(peakLtv, ltv)

    /** A window was running coming into this minute: a sale now ENDS a window. */
    const windowRan = timer.armed
    const act = d > 0 ? timer.step(i, ltv) : ({ kind: 'none' } as const)
    const ts = path.startTs + i * path.stepSeconds

    /**
     * A KEEPER CALL happens when the timer arms (the breach call that starts it), when it
     * says sell (band break, expiry, or a no-window position over its line), and during the
     * window only when venue capital not yet drawn has arrived. Every call runs Step 1.5
     * first: it recalls venue capital toward the WHOLE debt — `repayTarget = totalDebt`
     * (LiquidationEngine.sol:1319), sending `min(retrievable, repayTarget - totalRepaid)`
     * (:1450-1453) — before anything is classified.
     *
     * WHAT IS RETRIEVABLE, mapped onto the two inputs (conservative, and it keeps both
     * meaningful; the page clamps fastRate <= recallRate, Controls.tsx:301-313):
     *   - a call at the breach (arm), inside the window (hold), or at a sale with no window
     *     (instant, or Immediate past the band with no timer) can recall only what is there
     *     NOW or inside the 8h: up to `fastRate` of the deployed capital, cumulative;
     *   - a sale that ENDS a window (band break or expiry after the timer armed) can draw up
     *     to `recallRate` of it, cumulative — the slower capital has had the window to come.
     * A dollar drawn once is gone. A venue with a cooldown (sUSDe: recall 0.3, fast 0)
     * therefore returns nothing at the breach and only at the end of a window.
     */
    if (act.kind === 'arm' || act.kind === 'hold' || act.kind === 'sell') {
      const brokeWindow = act.kind === 'sell' && act.reason === 'band'
      /** No window for this position: instant mode (LiquidationEngine.sol:1572). */
      const instant = act.kind === 'sell' && act.reason === 'instant'
      const ceiling = act.kind === 'sell' && windowRan ? Math.max(recallRate, fastRate) : fastRate
      const available = Math.max(0, deployedStart * ceiling - venueDrawn)
      const recalled = Math.min(available, d)
      const dPost = d - recalled
      const ltvPost = c > 0 ? dPost / c : dPost > 0 ? Infinity : 0
      /** What an ordinary liquidation of THIS breach would repay, on the PRE-recall state. */
      const targetPre = membraneRepayValue(d, c, cap, dMin)

      /** Commits a recall: the debt falls by `usd`, the venue by the same. */
      const commitRecall = (usd: number) => {
        venueDrawn += usd
        const share = d > 0 ? Math.min(1, usd / d) : 0
        for (const leg of debt) leg.amount *= 1 - share
      }

      if (recalled > 0 && ltvPost <= line) {
        // STEP 2.5, THE PAID RECALL-ONLY LANE (LiquidationEngine.sol:1603-1658): the
        // recall alone brought the position to or under its line (:1623). It fires before
        // any classification — at the breach, during the window, or at a sale. Any timer is
        // deleted, nothing is sold (:1137-1141), and the call is paid the ordinary fee from
        // collateral on min(restore-to-cap target at the pre-recall state, recalled)
        // (:1653-1654). One event, one fee.
        commitRecall(recalled)
        const feeUsd = seizeProRata(coll, fee * Math.min(targetPre, recalled), path, i, fallbackC)
        penaltyPaid += feeUsd
        c = valueOf(coll, path, i, fallbackC)
        d = valueOf(debt, path, i, fallbackD)
        ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
        timer.clearAfterSale()
        events.push({
          minute: i,
          ts,
          kind: act.kind === 'hold' ? 'cure' : 'recall',
          ltv,
          line,
          repaidUsd: recalled,
          seizedUsd: feeUsd,
          recalledUsd: recalled,
          penaltyUsd: feeUsd,
          why:
            who +
            (act.kind === 'hold'
              ? `Venue capital arrived inside the ${CURE_WINDOW_HOURS}-hour window: ${fmt(recalled)} brought the position back under its ${(line * 100).toFixed(1)}% line, so nothing was sold. `
              : `Venues returned ${fmt(recalled)}, which brought the position back under its ${(line * 100).toFixed(1)}% line, so nothing was sold. `) +
            `The call still pays the liquidation fee from collateral: ${fmt(feeUsd)}.`,
        })
      } else if (act.kind === 'hold') {
        // Still over the line even with the new capital: the call would revert TimerActive
        // (Step 1.5/2.5 run first, then :1690), so the recall rolls back and nothing
        // changes. Inside the band and inside the window, the engine sells nothing. (Under
        // the mapping above the breach call already drew the fast share, so a call in the
        // window finds nothing new; the branch stays so the call rule mirrors the contract.)
      } else if (act.kind === 'arm') {
        // The breach call. Its recall commits (the timer-start lane pays no fee) and, still
        // over the line, the timer stays armed with the reduced debt.
        if (recalled > 0) {
          commitRecall(recalled)
          c = valueOf(coll, path, i, fallbackC)
          d = valueOf(debt, path, i, fallbackD)
          ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
          events.push({
            minute: i,
            ts,
            kind: 'recall',
            ltv,
            line,
            repaidUsd: recalled,
            seizedUsd: 0,
            recalledUsd: recalled,
            penaltyUsd: 0,
            why: `${who}Venues returned ${fmt(recalled)}. The position is still over its ${(line * 100).toFixed(1)}% line, so the ${CURE_WINDOW_HOURS}-hour window opens with that debt repaid.`,
          })
        }
        events.push({
          minute: i,
          ts,
          kind: 'breach',
          ltv,
          line,
          repaidUsd: 0,
          seizedUsd: 0,
          recalledUsd: 0,
          penaltyUsd: 0,
          why:
            who +
            `LTV crossed the ${(line * 100).toFixed(1)}% line and opened the ` +
            `${CURE_WINDOW_HOURS}-hour window. Nothing is sold while the position stays ` +
            `under ${(breakLine * 100).toFixed(1)}% — the price coming back, or venue capital ` +
            `arriving, ends it with no liquidation at all.`,
        })
      } else if (sales < MAX_SALES) {
        // A SALE (band break, expiry, or no window). The recall commits first; only the
        // shortfall to the borrow cap, sized on the POST-recall state, comes out of
        // collateral, with the fee on top.
        if (recalled > 0) commitRecall(recalled)
        const cNow = valueOf(coll, path, i, fallbackC)
        const dNow = valueOf(debt, path, i, fallbackD)
        const needed = membraneRepayValue(dNow, cNow, cap, dMin)
        let repaid = recalled
        let seized = 0
        let penalty = 0
        if (needed > 0) {
          const got = seizeProRata(coll, needed * (1 + fee), path, i, fallbackC)
          const fromColl = got / (1 + fee)
          penalty = got - fromColl
          penaltyPaid += penalty
          seized = got
          repaid += fromColl
          const share = dNow > 0 ? Math.min(1, fromColl / dNow) : 0
          for (const leg of debt) leg.amount *= 1 - share
        }
        c = valueOf(coll, path, i, fallbackC)
        d = valueOf(debt, path, i, fallbackD)
        ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
        if (repaid > 0) sales++
        // The sale deletes the timer (:1421-1423); the position is live afterwards
        // and a later breach opens a FULL fresh delay.
        timer.clearAfterSale()

        const capPct = `${(cap * 100).toFixed(1)}%`
        const detail =
          recalled > 0
            ? `Venues returned ${fmt(recalled)} first; ${fmt(seized)} of collateral covered the rest, restoring the ${capPct} borrow cap, not zero.`
            : `Partial liquidation repaid ${fmt(repaid)} — enough to restore the ${capPct} borrow cap, not the whole loan.`
        events.push({
          minute: i,
          ts,
          kind: seized > 0 ? 'liquidation' : 'recall',
          ltv,
          line,
          repaidUsd: repaid,
          seizedUsd: seized,
          recalledUsd: recalled,
          penaltyUsd: penalty,
          why:
            who +
            (instant
              ? `No ${CURE_WINDOW_HOURS}-hour window for this collateral — sold the minute LTV crossed the ${(line * 100).toFixed(1)}% line. ${detail}`
              : brokeWindow
                ? `Broke the ${(MAX_THRESHOLD_TO_DELAY * 100).toFixed(0)}% window — LTV is past ${(breakLine * 100).toFixed(1)}%, so the cure clock no longer applies and the sale is immediate. ${detail}`
                : detail),
        })
      }
    }

    // Recalled capital has LEFT the venues and gone into the debt, so it is counted
    // once, on the liability side. Equity is collateral + what is still deployed − debt.
    equitySeries.push(c + Math.max(0, deployedStart - venueDrawn) - d)
    ltvSeries.push(Number.isFinite(ltv) ? ltv : null)
    collSeries.push(c)
    debtSeries.push(d)
  }

  return {
    events,
    equitySeries,
    ltvSeries,
    collSeries,
    debtSeries,
    startEquity,
    endColl: valueOf(coll, path, path.count - 1, fallbackC),
    endDebt: valueOf(debt, path, path.count - 1, fallbackD),
    endDeployed: Math.max(0, deployedStart - venueDrawn),
    penaltyPaid,
    peakLtv,
  }
}

/**
 * A MIXED position — stable and volatile collateral together — cannot exist on Membrane:
 * the CDP reverts `MixedDelayClassCollateral` when the second class enters
 * (Cdp.sol:1650-1651, Collateral.sol:789-793). The borrower would hold TWO isolated
 * positions, so that is what is modelled: the stable legs and the other legs each become
 * a position, the debt (and any deployed venue capital) is split pro-rata to collateral
 * VALUE at minute 0 — so both start at this position's own LTV, the neutral split — and
 * each runs in its own class against its own line.
 *
 * EACH HALF'S LINE. The page always passes a line override — the blended whole-position
 * line by default (components/Simulator/Simulator.tsx defaults, scripts/select-demo-
 * borrower.ts) — so taking the override as-is would run both halves at the BLEND. Instead
 * each half keeps its OWN modelled line, scaled by override / whole-position line: at the
 * default the scale is 1 and each half runs at exactly its own line, and a user edit moves
 * both halves by the same factor. Each is clamped to its class's hard cap (96% stable, 90%
 * otherwise). A half with no modelled LTV on any leg (e.g. GHO) has no line of its own: it
 * runs at the whole position's scaled line, and the run says so.
 */
export function splitByDelayClass(
  position: ProtocolPosition,
  path: PricePath,
  opts: CompareOptions,
): { subs: MembraneSub[]; shares: number[] } {
  const value0 = (sym: string, amount: number, fallback: number) =>
    amount * (priceAt(path, sym, 0) ?? fallback)
  const halves = [
    { stable: true, legs: position.collateral.filter((c) => isNoDelayCollateral(c.symbol)) },
    { stable: false, legs: position.collateral.filter((c) => !isNoDelayCollateral(c.symbol)) },
  ]
  const values = halves.map((h) =>
    h.legs.reduce((a, c) => a + value0(c.symbol, c.amount, c.priceUsd), 0),
  )
  const total = values[0] + values[1]
  const shares = values.map((v) => (total > 0 ? v / total : 0.5))
  const whole = weightedMembraneLine(position.collateral).maxLtv
  const scale = opts.membraneMaxLtv !== undefined && whole > 0 ? opts.membraneMaxLtv / whole : 1
  const wholeLine = opts.membraneMaxLtv ?? whole
  const subs = halves.map((h, k): MembraneSub => {
    const own = weightedMembraneLine(h.legs).maxLtv
    const lineFromWhole = !(own > 0)
    const raw = lineFromWhole ? wholeLine : own * scale
    const line = Math.min(raw, h.stable ? NO_DELAY_LTV_HARD_CAP : MAX_LTV_HARD_CAP)
    const symbols = h.legs.map((c) => c.symbol)
    // The half's class is COMPUTED from its own symbols and line, and labels it.
    const noDelay = delayClassOf(symbols, line) === 'no-delay'
    return {
      label: `${symbols.join(' + ')} (${noDelay ? 'no 8-hour window' : `8-hour window within ${(MAX_THRESHOLD_TO_DELAY * 100).toFixed(0)}%`})`,
      collateral: h.legs,
      debt: position.debt.map((d) => ({ ...d, amount: d.amount * shares[k] })),
      line,
      noDelay,
      venue: opts.venue ? { ...opts.venue, deployedUsd: opts.venue.deployedUsd * shares[k] } : null,
      lineFromWhole,
    }
  })
  return { subs, shares }
}

/**
 * Membrane's engine on a whole position: decide its delay class, walk it (or, when its
 * collateral mixes the classes, walk the two positions Membrane would hold instead), and
 * assemble ONE run with its caveats.
 */
function runMembrane(position: ProtocolPosition, path: PricePath, opts: CompareOptions): SimRun {
  const derived = weightedMembraneLine(position.collateral)
  const line = opts.membraneMaxLtv ?? derived.maxLtv
  const delayClass = delayClassOf(
    position.collateral.map((c) => c.symbol),
    line,
  )

  let subs: MembraneSub[]
  let shares: number[] = [1]
  if (delayClass === 'mixed') {
    ;({ subs, shares } = splitByDelayClass(position, path, opts))
  } else {
    subs = [
      {
        label: null,
        collateral: position.collateral,
        debt: position.debt,
        line,
        noDelay: delayClass === 'no-delay',
        venue: opts.venue,
      },
    ]
  }
  const runs = subs.map((s) => walkMembrane(s, path, opts))

  // ONE run. A single position passes straight through; a split is summed minute by minute.
  const one = runs.length === 1 ? runs[0] : null
  const events = one
    ? one.events
    : runs.flatMap((r) => r.events).sort((a, b) => a.minute - b.minute)
  const equitySeries = one
    ? one.equitySeries
    : runs[0].equitySeries.map((_, i) => runs.reduce((a, r) => a + (r.equitySeries[i] ?? 0), 0))
  const ltvSeries = one
    ? one.ltvSeries
    : runs[0].collSeries.map((_, i) => {
        const c = runs.reduce((a, r) => a + r.collSeries[i], 0)
        const d = runs.reduce((a, r) => a + r.debtSeries[i], 0)
        return c > 0 ? d / c : null
      })
  const endColl = runs.reduce((a, r) => a + r.endColl, 0)
  const endDebt = runs.reduce((a, r) => a + r.endDebt, 0)
  const endDeployed = runs.reduce((a, r) => a + r.endDeployed, 0)

  const hasWindow = subs.some((s) => !s.noDelay)
  const caveats = [
    'Membrane has no Ethereum mainnet deployment. The per-asset max LTV used here is our assumption, not a protocol parameter — change it and the result changes.',
  ]
  if (subs.some((s) => s.noDelay)) {
    caveats.push(
      // The no-delay class: instant mode (LiquidationEngine.sol:1572-1576, :1708-1710). That
      // stables are listed in it is modelled: the class follows each listing's immutable LTV
      // cap (Collateral.sol:424-426), and the deploy lists its stables at the 96% cap.
      'Stablecoin collateral: no 8-hour window — sold at the line, every time. The same holds for any line above 90%. Modelled: Membrane lists its launch stablecoins this way; the contract gives such a listing no window.',
    )
  }
  if (hasWindow) {
    caveats.push(
      `The cure window is conditional: it holds only while the position stays within ${(MAX_THRESHOLD_TO_DELAY * 100).toFixed(0)}% above the liquidation line. Past that the sale is immediate — the model applies this break. 4% is the value the deploy script sets on every launch asset; a position holding several assets uses their value-weighted average.`,
      `Inside the window the engine sells nothing, whether the position is rescued by the price coming back or by venue capital arriving. A return under the line clears the timer, so a later breach gets a full fresh ${CURE_WINDOW_SECONDS / 3600} hours. This is the same walk the Oct 10 census runs — literally the same DelayTimer state machine from lib/position-sim/curePath.ts, driven here with per-leg prices, venue recall and a fee on top — so a pasted address matches its census row. A sale restores the borrow cap rather than closing the loan, so the position stays live and a later breach opens a full fresh window; at most ${MAX_SALES} sales are modelled.`,
    )
  }
  if (delayClass === 'mixed') {
    caveats.push(
      `Two positions (modelled): stablecoins and other collateral cannot share one Membrane position, so this runs as the two you would hold. ${subs.map((s, k) => `${s.label}: ${(s.line * 100).toFixed(1)}% line, ${(shares[k] * 100).toFixed(1)}% of the debt`).join('. ')}. The debt${opts.venue ? ' and the venue capital are' : ' is'} split by collateral value at the start, so both open at this position’s LTV. You could split it differently; each part then stands alone.`,
    )
    for (const s of subs.filter((x) => x.lineFromWhole)) {
      caveats.push(
        `No modelled max LTV exists for ${s.collateral.map((c) => c.symbol).join(', ')}, so that part runs at the whole position’s ${(s.line * 100).toFixed(1)}% line.`,
      )
    }
  }
  caveats.push(
    'The venue recall rate is an input, and it is the variable that moves this result most. A venue that pays out in a calm market is not the same venue during a 40-minute crash.',
  )
  if (opts.venue) {
    caveats.push(
      `Every call recalls venue capital first, toward the whole debt. At the breach, and at a sale with no ${CURE_WINDOW_HOURS}-hour window, only the fast share is there to recall; a sale that ends a window can draw up to the recall rate. If the recall alone brings the position back under its line, nothing is sold, but the call still pays the liquidation fee from collateral, on at most what a normal liquidation would have repaid. If not, the recall stays and only the rest is sold.`,
    )
  }
  caveats.push(
    // Cdp.sol:2494-2498 reverts LiquidationRaisedLtv. Not modelled: the flat fee is a
    // stand-in for the contract's fee ramp, so a revert computed from it would be an artefact.
    'Not modelled: on-chain, a liquidation that would leave LTV higher than before it does not go through. The fee here is a flat stand-in, so that check is left out rather than faked.',
  )
  if (derived.unknown.length) {
    caveats.push(
      `No modelled Membrane LTV exists for ${derived.unknown.join(', ')}; ${derived.unknown.length > 1 ? 'those assets were' : 'that asset was'} left out of the weighted line rather than assigned a guess.`,
    )
  }
  if (!opts.venue) {
    caveats.push('No deployment venue was detected for this position, so the recall step returned nothing. Membrane sold collateral for the whole call here.')
  }

  return {
    engine: 'membrane',
    label: 'Membrane',
    events,
    endCollateralUsd: endColl,
    endDebtUsd: endDebt,
    endDeployedUsd: endDeployed,
    startEquityUsd: runs.reduce((a, r) => a + r.startEquity, 0),
    endEquityUsd: endColl + endDeployed - endDebt,
    penaltyPaidUsd: runs.reduce((a, r) => a + r.penaltyPaid, 0),
    // For a split, the higher of the two positions' peaks: the riskier one is the one
    // that decides whether either of them is sold.
    peakLtv: Math.max(...runs.map((r) => r.peakLtv)),
    wiped: endColl <= 0.01 * Math.max(1, position.totalCollateralUsd),
    equitySeries,
    ltvSeries,
    provenance: MEMBRANE_CONSTANTS_PROVENANCE,
    caveats,
  }
}

const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

export function runComparison(
  position: ProtocolPosition,
  path: PricePath,
  unpricedSymbols: string[],
  opts: CompareOptions,
): Comparison {
  const source = runSource(position, path, opts)
  const membrane = runMembrane(position, path, opts)
  return {
    position,
    source,
    membrane,
    equityDeltaUsd: membrane.endEquityUsd - source.endEquityUsd,
    unpricedSymbols,
    scenarioLabel: opts.scenarioLabel,
  }
}

/** Measured repay fractions from the Oct 10 dataset, per protocol. */
export function measuredRepayFraction(
  protocol: string,
  measured: {
    aaveV3?: { medianRepayFraction?: number; events?: number }
    morphoBlue?: { medianRepayFraction?: number; events?: number }
  } | null,
): { fraction: number; label: string } {
  const aave = measured?.aaveV3
  const morpho = measured?.morphoBlue
  if ((protocol === 'aave-v3' || protocol === 'spark' || protocol === 'compound-v3') && aave?.medianRepayFraction) {
    return {
      fraction: aave.medianRepayFraction,
      label: `${(aave.medianRepayFraction * 100).toFixed(0)}% (the median of ${aave.events?.toLocaleString('en-US')} measured Oct 10 liquidations)`,
    }
  }
  if (protocol === 'morpho-blue' && morpho?.medianRepayFraction) {
    return {
      fraction: morpho.medianRepayFraction,
      label: `${(morpho.medianRepayFraction * 100).toFixed(0)}% (the median of ${morpho.events?.toLocaleString('en-US')} measured Oct 10 liquidations — Morpho has no close factor)`,
    }
  }
  return { fraction: 0.5, label: '50% (the documented close factor — no measured events for this protocol)' }
}
