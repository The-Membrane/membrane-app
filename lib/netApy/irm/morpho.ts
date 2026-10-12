/**
 * Morpho Blue AdaptiveCurveIrm, reproduced exactly.
 * Source: morpho-org/morpho-blue-irm src/adaptive-curve-irm/AdaptiveCurveIrm.sol
 * (`_borrowRate`, `_curve`, `_newRateAtTarget`) with ExpLib.wExp and MathLib.
 *
 * TWO THINGS MOVE THE RATE, AND SIZE IS ONLY ONE OF THEM:
 *   1. the curve: at 90% target utilization the borrow rate is `rateAtTarget`; at 0%
 *      it is 1/4 of that, at 100% it is 4x. A deposit or borrow moves utilization along
 *      the curve instantly.
 *   2. the adaptation: away from target, `rateAtTarget` itself drifts at
 *      50/yr x the normalised error. At 100% utilization that doubles the rate in
 *      ln2/50 years, about 5.1 days, up to a 200%/yr rateAtTarget ceiling (an 800%/yr
 *      borrow rate). This is why a Morpho rate spike is a PATH, not a number — see
 *      ratePath.ts.
 */

import { bound, SECONDS_PER_YEAR, WAD, wDivDown, wDivToZero, wExp, wMulToZero } from '../fixedPoint'
import type { MorphoAdaptiveCurveIrm, MorphoMarketState } from '../types'

const YEAR = SECONDS_PER_YEAR
export const CURVE_STEEPNESS = 4n * WAD
export const ADJUSTMENT_SPEED = (50n * WAD) / YEAR
export const TARGET_UTILIZATION = (9n * WAD) / 10n
export const INITIAL_RATE_AT_TARGET = (4n * WAD) / 100n / YEAR
export const MIN_RATE_AT_TARGET = WAD / 1000n / YEAR
export const MAX_RATE_AT_TARGET = (2n * WAD) / YEAR

/** The market fields `borrowRateView` reads. */
export interface MorphoMarketForRate {
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
  lastUpdate: bigint
}

export function utilizationWad(m: Pick<MorphoMarketForRate, 'totalSupplyAssets' | 'totalBorrowAssets'>): bigint {
  return m.totalSupplyAssets > 0n ? wDivDown(m.totalBorrowAssets, m.totalSupplyAssets) : 0n
}

/** Normalised distance from target, in [-1, 1] WAD. */
export function errorWad(utilization: bigint): bigint {
  const errNormFactor = utilization > TARGET_UTILIZATION ? WAD - TARGET_UTILIZATION : TARGET_UTILIZATION
  return wDivToZero(utilization - TARGET_UTILIZATION, errNormFactor)
}

export function curve(rateAtTarget: bigint, err: bigint): bigint {
  const coeff = err < 0n ? WAD - wDivToZero(WAD, CURVE_STEEPNESS) : CURVE_STEEPNESS - WAD
  return wMulToZero(wMulToZero(coeff, err) + WAD, rateAtTarget)
}

export function newRateAtTarget(start: bigint, linearAdaptation: bigint): bigint {
  return bound(wMulToZero(start, wExp(linearAdaptation)), MIN_RATE_AT_TARGET, MAX_RATE_AT_TARGET)
}

/**
 * `_borrowRate(id, market)` evaluated at `now` (block.timestamp). Returns the per-second
 * average borrow rate the IRM hands Morpho, and the rateAtTarget it would store.
 */
export function adaptiveCurveBorrowRate(
  startRateAtTarget: bigint,
  market: MorphoMarketForRate,
  now: bigint,
): { avgRate: bigint; endRateAtTarget: bigint; utilization: bigint } {
  const utilization = utilizationWad(market)
  const err = errorWad(utilization)
  let avgRateAtTarget: bigint
  let endRateAtTarget: bigint
  if (startRateAtTarget === 0n) {
    avgRateAtTarget = INITIAL_RATE_AT_TARGET
    endRateAtTarget = INITIAL_RATE_AT_TARGET
  } else {
    const speed = wMulToZero(ADJUSTMENT_SPEED, err)
    const elapsed = now - market.lastUpdate
    const linearAdaptation = speed * elapsed
    if (linearAdaptation === 0n) {
      avgRateAtTarget = startRateAtTarget
      endRateAtTarget = startRateAtTarget
    } else {
      endRateAtTarget = newRateAtTarget(startRateAtTarget, linearAdaptation)
      const midRateAtTarget = newRateAtTarget(startRateAtTarget, linearAdaptation / 2n)
      avgRateAtTarget = (startRateAtTarget + endRateAtTarget + 2n * midRateAtTarget) / 4n
    }
  }
  return { avgRate: curve(avgRateAtTarget, err), endRateAtTarget, utilization }
}

/**
 * The rateAtTarget in force at `now` if the market were touched then: the stored value
 * adapted over (now - lastUpdate) at the CURRENT utilization. This is the starting
 * point for any what-if that begins at the anchor.
 */
export function rateAtTargetAt(irm: MorphoAdaptiveCurveIrm, state: MorphoMarketState, now: bigint): bigint {
  return adaptiveCurveBorrowRate(irm.rateAtTarget, state, now).endRateAtTarget
}

/** Supply rate per second: borrowRate × utilization × (1 − fee), as Morpho accrues it
 *  (interest = borrow × rate; feeAmount = interest × fee; the rest to suppliers). */
export function morphoSupplyRate(borrowRate: bigint, utilization: bigint, fee: bigint): bigint {
  return (((borrowRate * utilization) / WAD) * (WAD - fee)) / WAD
}
