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
 * WHAT IS MODELLED:
 *   - Membrane's per-asset max LTV      no deployment exists (see membrane.ts)
 *   - Membrane's liquidation fee        capped by the real MAX_LIQ_FEE = 10%
 *   - the venue recall + fast rates     user inputs; the dominant variable
 */

import {
  applyRecall,
  fullRepayValue,
  membraneBorrowLtv,
  membraneRepayValue,
  weightedMembraneLine,
  CURE_WINDOW_SECONDS,
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
}

interface Leg {
  symbol: string
  amount: number
  /** Scratch: value at the current minute. */
  value: number
}

const MIN_EVENT_GAP_MINUTES = 1

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

    if (ltv > line && d > 0 && i - lastEvent > MIN_EVENT_GAP_MINUTES) {
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
 * venues before touching collateral, and an 8-hour cure window.
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
  const cureMinutes = Math.round(CURE_WINDOW_SECONDS / path.stepSeconds)

  const events: SimEvent[] = []
  const equitySeries: (number | null)[] = []
  const ltvSeries: (number | null)[] = []
  let penaltyPaid = 0
  let peakLtv = 0
  let lastEvent = -999
  let startEquity = 0
  /** Minute the current unbroken breach began, or null when healthy. */
  let breachStart: number | null = null
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

    if (ltv > line && d > 0) {
      if (breachStart === null) breachStart = i
      const inCureWindow = i - breachStart < cureMinutes

      if (i - lastEvent > MIN_EVENT_GAP_MINUTES) {
        const needed = membraneRepayValue(d, c, cap)
        const remainingVenue = opts.venue
          ? { ...opts.venue, deployedUsd: Math.max(0, opts.venue.deployedUsd - venueDrawn) }
          : null
        const recall = applyRecall(needed, remainingVenue)

        if (recall.cured && inCureWindow) {
          // Fast capital covered the whole call inside the 8h window: nothing sold.
          venueDrawn += needed
          const share = d > 0 ? needed / d : 0
          for (const leg of debt) leg.amount *= 1 - share
          c = valueOf(coll, path, i, fallbackC)
          d = valueOf(debt, path, i, fallbackD)
          ltv = c > 0 ? d / c : 0
          lastEvent = i
          breachStart = null
          events.push({
            minute: i,
            ts: path.startTs + i * path.stepSeconds,
            kind: 'cure',
            ltv,
            line,
            repaidUsd: needed,
            seizedUsd: 0,
            recalledUsd: needed,
            penaltyUsd: 0,
            why: `Cured inside the ${CURE_WINDOW_SECONDS / 3600}-hour window — enough venue capital arrived in time, so no collateral was sold and no fee was paid.`,
          })
        } else {
          venueDrawn += recall.recalledUsd
          let repaid = recall.recalledUsd
          let seized = 0
          let penalty = 0
          if (recall.shortfallUsd > 0) {
            const want = recall.shortfallUsd * (1 + fee)
            const got = seizeProRata(coll, want, path, i, fallbackC)
            const fromColl = got / (1 + fee)
            penalty = got - fromColl
            penaltyPaid += penalty
            repaid += fromColl
            seized = got
          }
          const share = d > 0 ? Math.min(1, repaid / d) : 0
          for (const leg of debt) leg.amount *= 1 - share
          c = valueOf(coll, path, i, fallbackC)
          d = valueOf(debt, path, i, fallbackD)
          ltv = c > 0 ? d / c : d > 0 ? Infinity : 0
          lastEvent = i
          if (ltv <= line) breachStart = null

          events.push({
            minute: i,
            ts: path.startTs + i * path.stepSeconds,
            kind: recall.recalledUsd > 0 && seized === 0 ? 'recall' : 'liquidation',
            ltv,
            line,
            repaidUsd: repaid,
            seizedUsd: seized,
            recalledUsd: recall.recalledUsd,
            penaltyUsd: penalty,
            why:
              recall.recalledUsd > 0 && seized === 0
                ? `Venues answered the whole ${fmt(needed)} call — the debt came down without selling collateral.`
                : recall.recalledUsd > 0
                  ? `Venues returned ${fmt(recall.recalledUsd)} of the ${fmt(needed)} call; only the ${fmt(recall.shortfallUsd)} shortfall came out of collateral. The repay restores the position to the ${(cap * 100).toFixed(1)}% borrow cap, not to zero.`
                  : `Partial liquidation repaid ${fmt(repaid)} — enough to restore the ${(cap * 100).toFixed(1)}% borrow cap, not the whole loan.`,
          })
        }
      }
    } else {
      breachStart = null
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
    'The venue recall rate is an input, and it is the variable that moves this result most. A venue that pays out in a calm market is not the same venue during a 40-minute crash.',
  ]
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
