/**
 * One entry point over the four IRMs: the rate at a size, the rate at a utilization,
 * and where each curve's kink sits. Everything returns a `RatePoint` (fraction per
 * year, plus exact WAD) so the breakdown and the rate path never branch on protocol.
 */

import { percentMul, PERCENTAGE_FACTOR, rayMul, SECONDS_PER_YEAR, toFloat, WAD } from '../fixedPoint'
import type { RatePoint, SizeDelta, VenueSnapshot } from '../types'
import { aaveBorrowRateAtUsage, aaveCurve, aaveV2Rates, sparkVariableBorrowRates } from './aave'
import { EULER_CONFIG_SCALE, eulerUtilization, linearKinkRateAtUtilization, UINT32_MAX } from './euler'
import {
  ADJUSTMENT_SPEED,
  curve,
  errorWad,
  morphoSupplyRate,
  newRateAtTarget,
  rateAtTargetAt,
  TARGET_UTILIZATION,
  utilizationWad,
} from './morpho'

export * from './aave'
export * from './euler'
export * from './morpho'

const RAY_TO_WAD = 10n ** 9n

function point(utilization: bigint, borrowApr: bigint, grossSupplyApr: bigint, supplyApr: bigint): RatePoint {
  const f = (v: bigint) => toFloat(v, WAD)
  return {
    utilization: f(utilization),
    borrowApr: f(borrowApr),
    supplyApr: f(supplyApr),
    grossSupplyApr: f(grossSupplyApr),
    venueFeeApr: f(grossSupplyApr - supplyApr),
    wad: { utilization, borrowApr, supplyApr, grossSupplyApr },
  }
}

export class SizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SizeError'
  }
}

/**
 * The rates the venue would show RIGHT AFTER the user's action, at the anchor block.
 *
 * Aave / Spark / Euler: the strategy evaluated on post-action balances — exactly what
 * the pool stores. Morpho: the market first accrues (rateAtTarget adapts over the time
 * since its last update, at the pre-action utilization), then the curve is read at the
 * post-action utilization with no further adaptation — the instantaneous rate the user
 * starts at. What happens after that is the rate path's job.
 */
export function ratesAtSize(s: VenueSnapshot, delta: SizeDelta): RatePoint {
  if (delta.supply < 0n || delta.borrow < 0n) throw new SizeError('size must be non-negative')
  const { irm, state } = s

  if (irm.model === 'aave-rate-strategy-v2' && state.kind === 'aave-virtual') {
    if (delta.borrow > state.virtualUnderlyingBalance + delta.supply) {
      throw new SizeError('borrow exceeds the pool’s available liquidity')
    }
    const r = aaveV2Rates(irm, {
      unbacked: state.unbacked,
      liquidityAdded: delta.supply,
      liquidityTaken: delta.borrow,
      totalDebt: state.totalDebt + delta.borrow,
      reserveFactor: state.reserveFactorBps,
      virtualUnderlyingBalance: state.virtualUnderlyingBalance,
    })
    const gross = rayMul(r.variableBorrowRate, r.supplyUsageRatio)
    return point(r.borrowUsageRatio / RAY_TO_WAD, r.variableBorrowRate / RAY_TO_WAD, gross / RAY_TO_WAD, r.liquidityRate / RAY_TO_WAD)
  }

  if (irm.model === 'spark-variable-borrow' && state.kind === 'spark') {
    if (delta.borrow > state.availableLiquidity + delta.supply) {
      throw new SizeError('borrow exceeds the pool’s available liquidity')
    }
    const r = sparkVariableBorrowRates(irm, {
      unbacked: state.unbacked,
      liquidityAdded: delta.supply,
      liquidityTaken: delta.borrow,
      totalVariableDebt: state.totalVariableDebt + delta.borrow,
      reserveFactor: state.reserveFactorBps,
      availableLiquidityBalance: state.availableLiquidity,
    })
    const gross = rayMul(r.variableBorrowRate, r.supplyUsageRatio)
    return point(r.borrowUsageRatio / RAY_TO_WAD, r.variableBorrowRate / RAY_TO_WAD, gross / RAY_TO_WAD, r.liquidityRate / RAY_TO_WAD)
  }

  if (irm.model === 'morpho-adaptive-curve' && state.kind === 'morpho-market') {
    const supply = state.totalSupplyAssets + delta.supply
    const borrow = state.totalBorrowAssets + delta.borrow
    if (borrow > supply) throw new SizeError('borrow exceeds the market’s supplied liquidity')
    const rat = rateAtTargetAt(irm, state, s.anchor.blockTimestamp)
    const u = utilizationWad({ totalSupplyAssets: supply, totalBorrowAssets: borrow })
    const rate = curve(rat, errorWad(u))
    const borrowApr = rate * SECONDS_PER_YEAR
    const gross = (borrowApr * u) / WAD
    return point(u, borrowApr, gross, morphoSupplyRate(borrowApr, u, state.fee))
  }

  if (irm.model === 'euler-linear-kink' && state.kind === 'euler-vault') {
    if (delta.borrow > state.cash + delta.supply) throw new SizeError('borrow exceeds the vault’s cash')
    const cash = state.cash + delta.supply - delta.borrow
    const borrows = state.totalBorrows + delta.borrow
    const u32 = eulerUtilization(cash, borrows)
    return eulerPoint(s, u32, linearKinkRateAtUtilization(irm, u32), cash, borrows)
  }

  throw new Error(`netApy: ${s.venueKey} pairs irm '${irm.model}' with state '${state.kind}'`)
}

function eulerPoint(s: VenueSnapshot, u32: bigint, spy: bigint, cash?: bigint, borrows?: bigint): RatePoint {
  if (s.state.kind !== 'euler-vault') throw new Error('eulerPoint: not an Euler vault')
  const borrowApr = (spy * SECONDS_PER_YEAR) / RAY_TO_WAD
  // Interest is paid on borrows and spread over cash + borrows; use the exact balances
  // when we have them, the quantised utilization otherwise.
  const u =
    cash !== undefined && borrows !== undefined
      ? cash + borrows === 0n
        ? 0n
        : (borrows * WAD) / (cash + borrows)
      : (u32 * WAD) / UINT32_MAX
  const gross = (borrowApr * u) / WAD
  const supply = (gross * (EULER_CONFIG_SCALE - s.state.interestFee)) / EULER_CONFIG_SCALE
  return point(u, borrowApr, gross, supply)
}

/** Utilization (WAD) at which the curve kinks: Aave's optimal ratio, Morpho's 90%
 *  target, Euler's kink. Above it, the borrow rate steepens. */
export function kinkUtilization(s: VenueSnapshot): bigint {
  const { irm } = s
  if (irm.model === 'aave-rate-strategy-v2' || irm.model === 'spark-variable-borrow') return aaveCurve(irm).optimal / RAY_TO_WAD
  if (irm.model === 'morpho-adaptive-curve') return TARGET_UTILIZATION
  return (irm.kink * WAD) / UINT32_MAX
}

/**
 * Rates if utilization were `u` (WAD), held for `t` seconds after the anchor. A
 * what-if with no real balances behind it: Aave/Spark ignore `unbacked` here (it is
 * zero on every covered reserve), Euler uses the quantised utilization, Morpho starts
 * from the rateAtTarget in force at the anchor and adapts for `t` seconds at `u`.
 * Static curves ignore `t`.
 */
export function ratesAtUtilization(s: VenueSnapshot, u: bigint, t: bigint = 0n): RatePoint {
  if (u < 0n || u > WAD) throw new SizeError('utilization must be within [0, 1]')
  const { irm, state } = s
  if (irm.model === 'aave-rate-strategy-v2' || irm.model === 'spark-variable-borrow') {
    if (state.kind !== 'aave-virtual' && state.kind !== 'spark') throw new Error('aave irm without aave state')
    const usageRay = u * RAY_TO_WAD
    const borrow = aaveBorrowRateAtUsage(irm, usageRay)
    const gross = rayMul(borrow, usageRay)
    const supply = percentMul(gross, PERCENTAGE_FACTOR - state.reserveFactorBps)
    return point(u, borrow / RAY_TO_WAD, gross / RAY_TO_WAD, supply / RAY_TO_WAD)
  }
  if (irm.model === 'morpho-adaptive-curve' && state.kind === 'morpho-market') {
    const err = errorWad(u)
    let rat = rateAtTargetAt(irm, state, s.anchor.blockTimestamp)
    const adaptation = ((ADJUSTMENT_SPEED * err) / WAD) * t
    if (adaptation !== 0n) rat = newRateAtTarget(rat, adaptation)
    const borrowApr = curve(rat, err) * SECONDS_PER_YEAR
    const gross = (borrowApr * u) / WAD
    return point(u, borrowApr, gross, morphoSupplyRate(borrowApr, u, state.fee))
  }
  if (irm.model === 'euler-linear-kink') {
    const u32 = (u * UINT32_MAX) / WAD
    return eulerPoint(s, u32, linearKinkRateAtUtilization(irm, u32))
  }
  throw new Error(`netApy: unsupported irm for ${s.venueKey}`)
}

/** Current state, no size: the reconstructed rate at the anchor. */
export const ratesNow = (s: VenueSnapshot): RatePoint => ratesAtSize(s, { supply: 0n, borrow: 0n })

/**
 * Stored-vs-reconstructed drift in basis points of APR, for the venues that store a
 * rate. The stored rate was computed at the venue's last update; balances have accrued
 * since, so a small drift is expected and a large one means the model is wrong.
 */
export function storedRateDriftBps(s: VenueSnapshot): number | null {
  const now = ratesNow(s)
  const st = s.state
  let stored: bigint | null = null
  if (st.kind === 'aave-virtual' || st.kind === 'spark') stored = st.storedVariableBorrowRateRay / RAY_TO_WAD
  if (st.kind === 'euler-vault') stored = (st.storedInterestRateSpy * SECONDS_PER_YEAR) / RAY_TO_WAD
  if (stored === null) return null
  return (toFloat(now.wad.borrowApr, WAD) - toFloat(stored, WAD)) * 10_000
}
