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
 *     (master per-call order: recall first; classify and size the sale on the
 *     POST-recall LTV — see runMembrane)
 *   - Membrane's collateral CLASS: a delayed basket gets the 4% band + 8h window, a
 *     no-delay basket (listing cap > 90%) is liquidated the moment it crosses its line
 *     (membrane.ts MEMBRANE_CLASS_PARAMS; master Collateral.sol:363-365, LE:1572)
 * INTENDED RULES, NOT MASTER (owner rulings 2026-10-04; master gaps have fix lanes):
 *   - the recall ASK restores the position to borrowable LTV (`membraneRecallTarget`),
 *     not the full debt master asks for (LE:1320, :1452-1453)
 *   - the debt floor's remainder guard: no liquidation leaves 0 < debt < $2,000
 *     (`applyDebtMinimum`; master LE:2718-2729 has no guard) — on what a call ACTUALLY
 *     repays too: a short recall that would strand dust sells the remainder from
 *     collateral (`debtFloorRemainder`; master's recall-only lane has no floor)
 * WHAT IS MODELLED:
 *   - Membrane's per-asset max LTV      no deployment exists (see membrane.ts)
 *   - Membrane's liquidation fee        capped by the real MAX_LIQ_FEE = 10%
 *   - the venue recall rate             a user input; the dominant variable. Each keeper
 *                                       call can get back at most `recallRate` × the
 *                                       capital still deployed (master's per-call
 *                                       `retrievable`), and asks only for the restore
 *                                       amount. There is no second "fast" rate (removed
 *                                       2026-10-04, owner ruling): a call's recall is
 *                                       synchronous (LE:1453).
 *   - Membrane's keeper fee             NOT charged on a recall-only cure (master takes
 *                                       it from collateral there, LE:1134-1137, :1647-1655)
 */

import { DelayTimer } from './curePath'
import {
  applyDebtMinimum,
  applyRecall,
  debtFloorRemainder,
  fullRepayValue,
  membraneBorrowLtv,
  membraneRecallTarget,
  membraneRepayValue,
  weightedMembraneLine,
  LIQ_DEBT_MINIMUM_USD,
  MEMBRANE_CLASS_PARAMS,
  MEMBRANE_CONSTANTS_PROVENANCE,
  type MembraneClass,
  type VenueRecall,
} from './membrane'
import { priceAt } from './scenario'
import { stamp, type Comparison, type PricePath, type ProtocolPosition, type SimEvent, type SimRun } from './types'

/** 10% ceiling — real: lib/Constants.sol:64 MAX_LIQ_FEE = 1e17 (master 10626e40). */
export const MAX_LIQ_FEE = 0.1

export interface CompareOptions {
  /** Override the modelled Membrane liquidation line. */
  membraneMaxLtv?: number
  /**
   * Override the delay class derived from the basket's listings
   * (`weightedMembraneLine(...).class`). 'no-delay' models a 96%-cap segment: band 0,
   * no window, sold the moment LTV crosses the line. 'delayed' forces the 4%/8h class.
   * Omitted: the derived class; a 'mixed' basket (which master refuses to hold in one
   * position) runs on its value-weighted band and says so in the caveats.
   */
  membraneClass?: MembraneClass
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

/**
 * Membrane's engine: partial repay back to the borrow cap, recall from deployment
 * venues before touching collateral, and — for the DELAYED class only — an 8-hour
 * cure window inside the 4% band. A NO-DELAY basket runs the same walk with band 0,
 * which never arms the timer: crossing the line is the sale (instant mode, LE:1572).
 */
function runMembrane(position: ProtocolPosition, path: PricePath, opts: CompareOptions): SimRun {
  const coll = makeLegs(position.collateral)
  const debt = makeLegs(position.debt)
  const fallbackC = Object.fromEntries(position.collateral.map((c) => [c.symbol, c.priceUsd]))
  const fallbackD = Object.fromEntries(position.debt.map((d) => [d.symbol, d.priceUsd]))

  const derived = weightedMembraneLine(position.collateral)
  const line = opts.membraneMaxLtv ?? derived.maxLtv
  const cap = membraneBorrowLtv(line)
  const fee = Math.max(0, Math.min(MAX_LIQ_FEE, opts.membraneLiqFee))
  const dMin = opts.debtMinimumUsd ?? LIQ_DEBT_MINIMUM_USD
  /**
   * The delay class. An explicit override wins; otherwise the basket's own class. A
   * 'mixed' basket keeps its value-weighted band (master would refuse it — caveat
   * below) and the delayed window, since that band is > 0 and arms a timer.
   */
  const cls: MembraneClass =
    opts.membraneClass ?? (derived.class === 'no-delay' ? 'no-delay' : 'delayed')
  const classParams = MEMBRANE_CLASS_PARAMS[cls]
  const band = opts.membraneClass ? classParams.band : derived.band
  const noDelay = band === 0
  const windowSeconds = noDelay ? 0 : MEMBRANE_CLASS_PARAMS.delayed.windowSeconds
  const windowHours = windowSeconds / 3600
  const cureMinutes = Math.round(windowSeconds / path.stepSeconds)
  /** Above this the window is BROKEN: no cure, immediate sale (BrokeWindow). For the
   *  no-delay class band = 0, so this IS the line: every breach is `Immediate`. */
  const breakLine = line * (1 + band)

  /**
   * THE SHARED WALK. This is the same `DelayTimer` the Oct-10 census runs through
   * `cureWalk` (lib/position-sim/curePath.ts) — not a second copy of the rules. The
   * timer decides WHEN; recall, the fee and the multi-leg pricing are layered on top
   * here and are the only differences. scripts/tests/position-sim.test.ts replays two
   * real census accounts through this engine and asserts the same outcome and the
   * same closed USD.
   */
  const timer = new DelayTimer({ line, band, delaySteps: cureMinutes })

  const events: SimEvent[] = []
  const equitySeries: (number | null)[] = []
  const ltvSeries: (number | null)[] = []
  let penaltyPaid = 0
  let peakLtv = 0
  let startEquity = 0
  let sales = 0
  /** Venue capital already spent — a venue cannot answer the same dollar twice. */
  let venueDrawn = 0
  /** Capital still in venues. Falls as capital is recalled; equity counts it. */
  const deployedStart = opts.venue?.deployedUsd ?? 0

  for (let i = 0; i < path.count; i++) {
    let c = valueOf(coll, path, i, fallbackC)
    let d = valueOf(debt, path, i, fallbackD)
    if (i === 0) startEquity = c + deployedStart - d

    let ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
    if (Number.isFinite(ltv)) peakLtv = Math.max(peakLtv, ltv)

    // One keeper call per minute while the position is over its line, in MASTER's
    // per-call order (the same order stressGrid.ts walks):
    //   1. Step 1.5 recalls venue capital FIRST (LE:1106-1107). The ASK is the amount that
    //      restores the position to its borrow LTV (`membraneRecallTarget`) — OWNER RULING
    //      2026-10-04: "only attempt to liquidate and therefore recall from LLTV to
    //      borrowable LTV". Master asks for the FULL debt (`repayTarget = totalDebt`,
    //      LE:1320; each venue sends min(retrievable, target − repaid), LE:1453); that is
    //      a master divergence with a fix lane. What arrives is still capped by the venue:
    //      `recallRate` × the capital still deployed.
    //   2. Step 2 re-reads the LTV AFTER the recall (Cdp.sol:5055-5056). At or under
    //      the line: the recall-only lane cures — commits, clears any timer, never arms
    //      (LE:1623-1657).
    //   3. Otherwise the call is classified on the POST-recall LTV: TimerStarted commits
    //      its recall; TimerActive reverts and rolls it back (LE:1690); Immediate /
    //      BrokeWindow / DelayExpired sell, the target sized on the PRE-recall debt at
    //      the POST-recall LTV (LE:1759 → `_getRepayQuantities`, LE:2663-2729), and
    //      collateral covers `target − recalled`. That stale-debt sizing is master's and
    //      is KEPT: it is a separate Low defect with its own fix lane ("Fix
    //      LiquidationEngine partial-recall sale sizing"), not one of the 2026-10-04 rulings.
    //   4. DEBT FLOOR on what a call COMMITS (owner ruling 2026-10-04): a recall that would
    //      commit (recall-only cure, TimerStarted) and strand 0 < debt < dMin makes the
    //      call repay ALL — collateral sells the remainder (`debtFloorRemainder`). A sale
    //      call repays at least its recall, with the remainder guard on the total. Master's
    //      recall lanes have no floor (LE:1623-1658); fix lane "Fix LE debt-floor dust and
    //      recall sizing".
    if (d > 0 && ltv <= line) {
      // Not liquidatable (CdpInternal.insolvent is `ratio > line`): a running timer is
      // cleared (SavedByDelay); otherwise nothing happens.
      timer.step(i, ltv)
    } else if (d > 0) {
      const remainingVenue = opts.venue
        ? { ...opts.venue, deployedUsd: Math.max(0, opts.venue.deployedUsd - venueDrawn) }
        : null
      const recallAsk = membraneRecallTarget(d, c, cap, dMin)
      const recalled = applyRecall(recallAsk, remainingVenue).recalledUsd
      const ltvPost = c > 0 ? (d - recalled) / c : d - recalled > 0 ? Infinity : 0
      const wasArmed = timer.armed

      /** Commits a call's recall plus any collateral repay against the debt legs. */
      const commit = (repaid: number) => {
        const share = d > 0 ? Math.min(1, repaid / d) : 0
        for (const leg of debt) leg.amount *= 1 - share
        c = valueOf(coll, path, i, fallbackC)
        d = valueOf(debt, path, i, fallbackD)
        ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
      }

      /**
       * OWNER RULING 2026-10-04 (DEBT FLOOR) on the ARRIVAL. The ask already carries the
       * remainder guard, but a venue that answers SHORT of an ask escalated to the whole
       * loan can strand 0 < debt < dMin. A call that would commit that recall repays ALL
       * instead; the venue is already short, so collateral sells the remainder.
       * Master's recall-only lane (LE:1623-1658) has no floor — see `debtFloorRemainder`.
       */
      const floorRest = recalled > 0 ? debtFloorRemainder(d, recalled, dMin) : 0
      /** The closing sale that call becomes. `armedNow`: the arm lane just armed it. */
      const closeOnFloor = (armedNow: boolean) => {
        const want = floorRest * (1 + fee)
        const got = seizeProRata(coll, want, path, i, fallbackC)
        const fromColl = got / (1 + fee)
        const penalty = got - fromColl
        penaltyPaid += penalty
        venueDrawn += recalled
        commit(recalled + fromColl)
        if (got > 0) sales++
        timer.clearAfterSale()
        events.push({
          minute: i,
          ts: path.startTs + i * path.stepSeconds,
          kind: got > 0 ? 'liquidation' : 'recall',
          ltv,
          line,
          repaidUsd: recalled + fromColl,
          seizedUsd: got,
          recalledUsd: recalled,
          penaltyUsd: penalty,
          why:
            `Venues returned ${fmt(recalled)} of the ${fmt(recalled + floorRest)} owed${armedNow || ltvPost > line ? '' : ' — enough to get back under the line'}, but that would leave ${fmt(floorRest)}, under the ${fmt(dMin)} debt floor. ` +
            `A liquidation never leaves debt under the floor, so the call repays all of it: ${fmt(got)} of collateral covered the ${fmt(floorRest)} remainder and closed the loan. ` +
            'This is the intended rule (owner ruling 2026-10-04); the current contract would leave the remainder standing.',
        })
      }

      if (recalled > 0 && ltvPost <= line && floorRest > 0) {
        closeOnFloor(false)
      } else if (recalled > 0 && ltvPost <= line) {
        // Recall-only lane: the venue alone brought the position back to its line.
        venueDrawn += recalled
        commit(recalled)
        timer.clearAfterSale()
        events.push({
          minute: i,
          ts: path.startTs + i * path.stepSeconds,
          kind: 'cure',
          ltv,
          line,
          repaidUsd: recalled,
          seizedUsd: 0,
          recalledUsd: recalled,
          penaltyUsd: 0,
          why:
            `${wasArmed ? `Cured inside the ${windowHours}-hour window` : `Cured on the call that crossed the ${(line * 100).toFixed(1)}% line`} — venues returned ${fmt(recalled)} first, enough to bring the position back to its line, so no collateral was sold. ` +
            'Master still charges the keeper fee on this call, taken from collateral (a ramp that starts at the line); that fee is not modelled here.',
        })
      } else {
        const act = timer.step(i, ltvPost)
        if (act.kind === 'arm' && floorRest > 0) {
          // TimerStarted would COMMIT a recall that strands sub-floor debt: ruling 1 makes
          // the call repay all, so it closes the loan instead of opening a window.
          closeOnFloor(true)
        } else if (act.kind === 'arm') {
          // TimerStarted: the timer-only exit returns normally, so the recall COMMITS.
          if (recalled > 0) {
            venueDrawn += recalled
            commit(recalled)
          }
          events.push({
            minute: i,
            ts: path.startTs + i * path.stepSeconds,
            kind: 'breach',
            ltv,
            line,
            repaidUsd: recalled,
            seizedUsd: 0,
            recalledUsd: recalled,
            penaltyUsd: 0,
            why:
              `LTV crossed the ${(line * 100).toFixed(1)}% line and opened the ` +
              `${windowHours}-hour window` +
              (recalled > 0
                ? ` — venues returned ${fmt(recalled)} first, not enough to get back to the line`
                : '') +
              `. The window delays a sale while the position stays under ` +
              `${(breakLine * 100).toFixed(1)}% — the price coming back, or venue capital ` +
              `arriving, can end it with nothing sold. It is not a promise of no sale: ` +
              `a liquidation can still happen inside it, e.g. one that closes a loan ` +
              `rather than leave it under the debt minimum.`,
          })
        } else if (act.kind === 'sell' && sales < MAX_SALES) {
          // Immediate / BrokeWindow / DelayExpired. ('hold' is TimerActive: the call
          // reverts and its recall is rolled back — nothing to do.)
          const brokeWindow = act.reason === 'band'
          // Ruling 1 on the whole call: a recall past the formula target still repays at
          // least that target, and a call that would strand sub-floor debt repays all.
          const formula = membraneRepayValue(d, ltvPost > 0 ? d / ltvPost : 0, cap, dMin)
          const needed = applyDebtMinimum(Math.max(formula, recalled), d, dMin)
          const shortfall = Math.max(0, needed - recalled)
          venueDrawn += recalled
          let repaid = recalled
          let seized = 0
          let penalty = 0
          if (shortfall > 0) {
            const want = shortfall * (1 + fee)
            const got = seizeProRata(coll, want, path, i, fallbackC)
            const fromColl = got / (1 + fee)
            penalty = got - fromColl
            penaltyPaid += penalty
            repaid += fromColl
            seized = got
          }
          commit(repaid)
          if (repaid > 0) sales++
          // The sale deletes the timer (LE:1724-1727); the position is live afterwards
          // and a later breach opens a FULL fresh delay.
          timer.clearAfterSale()

          events.push({
            minute: i,
            ts: path.startTs + i * path.stepSeconds,
            kind: recalled > 0 && seized === 0 ? 'recall' : 'liquidation',
            ltv,
            line,
            repaidUsd: repaid,
            seizedUsd: seized,
            recalledUsd: recalled,
            penaltyUsd: penalty,
            why:
              brokeWindow && seized > 0 && noDelay
                ? `Crossed the ${(line * 100).toFixed(1)}% line — this is a no-delay collateral class, so there is no window and the sale is immediate. ${recalled > 0 ? `Venues returned ${fmt(recalled)} first; ` : ''}${fmt(seized)} of collateral covered the rest, restoring the ${(cap * 100).toFixed(1)}% borrow cap, not zero.`
                : brokeWindow && seized > 0
                  ? `Broke the ${(band * 100).toFixed(0)}% window — LTV ${(ltvPost * 100).toFixed(1)}%${recalled > 0 ? ' after the recall' : ''} is past ${(breakLine * 100).toFixed(1)}%, so the cure clock no longer applies and the sale is immediate. ${recalled > 0 ? `Venues returned ${fmt(recalled)} first; ` : ''}${fmt(seized)} of collateral covered the rest, restoring the ${(cap * 100).toFixed(1)}% borrow cap, not zero.`
                  : recalled > 0 && seized === 0
                    ? `Venues returned ${fmt(recalled)}, which covered the whole ${fmt(formula)} sale — no collateral was sold, though the position is still over its line.`
                    : recalled > 0
                      ? `Venues returned ${fmt(recalled)} of the ${fmt(needed)} call; only the ${fmt(shortfall)} shortfall came out of collateral. The repay restores the position to the ${(cap * 100).toFixed(1)}% borrow cap, not to zero.`
                      : `Partial liquidation repaid ${fmt(repaid)} — enough to restore the ${(cap * 100).toFixed(1)}% borrow cap, not the whole loan.`,
          })
        }
      }
    }

    // Recalled capital has LEFT the venues and gone into the debt, so it is counted
    // once, on the liability side. Equity is collateral + what is still deployed − debt.
    equitySeries.push(c + Math.max(0, deployedStart - venueDrawn) - d)
    ltvSeries.push(Number.isFinite(ltv) ? ltv : null)
  }

  const endColl = valueOf(coll, path, path.count - 1, fallbackC)
  const endDebt = valueOf(debt, path, path.count - 1, fallbackD)
  const endDeployed = Math.max(0, deployedStart - venueDrawn)

  const caveats = [
    'Membrane has no Ethereum mainnet deployment. The per-asset max LTV used here is our assumption, not a protocol parameter — change it and the result changes.',
    ...(noDelay
      ? [
          `This collateral is in the no-delay class (a listing cap above 90%, up to 96%). It has no cure window: the moment LTV crosses the ${(line * 100).toFixed(1)}% line the position is liquidatable, venue capital is recalled first and only the shortfall is sold. A sale restores the ${(cap * 100).toFixed(1)}% borrow cap rather than closing the loan, so the position stays live; at most ${MAX_SALES} sales are modelled.`,
        ]
      : [
          `The cure window is conditional: it holds only while the position stays within ${(band * 100).toFixed(derived.mixed && !opts.membraneClass ? 2 : 0)}% above the liquidation line. Past that the sale is immediate — the model applies this break. 4% is the value the deploy script sets on every delayed-class asset; a position holding several assets uses their value-weighted average.`,
          `Inside the window the engine delays sales: the price coming back or venue capital arriving can rescue the position with nothing sold. The window is not a promise of no sale — breaking the band liquidates immediately, and a liquidation that would leave less than the debt minimum closes the whole loan, inside the window too (owner ruling 2026-10-04). A return under the line clears the timer, so a later breach gets a full fresh ${windowHours} hours. This is the same walk the Oct 10 census runs — literally the same DelayTimer state machine from lib/position-sim/curePath.ts, driven here with per-leg prices, venue recall and a fee on top — so a pasted address matches its census row. A sale restores the borrow cap rather than closing the loan, so the position stays live and a later breach opens a full fresh window; at most ${MAX_SALES} sales are modelled.`,
        ]),
    'The venue recall rate is an input, and it is the variable that moves this result most. A venue that pays out in a calm market is not the same venue during a 40-minute crash.',
    // Owner rulings 2026-10-04: the run models the INTENDED rules; say where the contract
    // on master still differs, so nobody reads the simulator as the deployed behaviour.
    `This run follows Membrane's intended liquidation rules, which the current contract does not fully apply yet: each call asks venues only for what brings the position back to its ${(cap * 100).toFixed(1)}% borrow limit (the contract asks for the whole debt)` +
      (dMin > 0
        ? `, and no liquidation leaves less than the ${fmt(dMin)} debt minimum behind — it closes the loan instead.`
        : '.') +
      ' A fix for the contract is tracked.',
  ]
  if (derived.mixed && !opts.membraneClass) {
    caveats.push(
      `This basket mixes delayed and no-delay collateral. Membrane refuses that in one position (MixedDelayClassCollateral): it would have to be split in two. This run treats it as one position on the value-weighted ${(band * 100).toFixed(2)}% band, which is an approximation of a position that cannot exist.`,
    )
  }
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
    startEquityUsd: startEquity,
    endEquityUsd: endColl + endDeployed - endDebt,
    penaltyPaidUsd: penaltyPaid,
    peakLtv,
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
