/**
 * Aave v3 and SparkLend rate strategies, reproduced exactly.
 *
 * Two strategies are live on the venues we cover (verified on-chain 2026-10-05):
 *   - Aave v3 core (Pool revision 11): one DefaultReserveInterestRateStrategyV2 for every
 *     reserve, params in bps per reserve. Source: aave-dao/aave-v3-origin
 *     src/contracts/misc/DefaultReserveInterestRateStrategyV2.sol `calculateInterestRates`.
 *   - SparkLend (Pool revision 4): sparklend-advanced VariableBorrowInterestRateStrategy
 *     (and its rate-target children, which only change where slope1/base come from).
 *
 * WHY SIZE MOVES THE RATE: both strategies take `liquidityAdded` / `liquidityTaken`
 * — the pool passes the user's own deposit or borrow in, and the rate the user gets
 * is computed on the utilization AFTER their action. So "the rate at your size" is the
 * strategy evaluated with your size in those slots, which is exactly what the pool
 * would store.
 */

import { bpsToRay, percentMul, PERCENTAGE_FACTOR, RAY, rayDiv, rayMul } from '../fixedPoint'
import type { AaveV2StrategyIrm, SparkVariableBorrowIrm } from '../types'

export interface AaveRates {
  liquidityRate: bigint
  variableBorrowRate: bigint
  borrowUsageRatio: bigint
  supplyUsageRatio: bigint
}

/** DataTypes.CalculateInterestRatesParams (v3.4+), minus `reserve` and the deprecated
 *  `usingVirtualBalance` flag, neither of which enters the math. */
export interface AaveV2CalcParams {
  unbacked: bigint
  liquidityAdded: bigint
  liquidityTaken: bigint
  totalDebt: bigint
  reserveFactor: bigint
  virtualUnderlyingBalance: bigint
}

export function aaveV2Rates(irm: AaveV2StrategyIrm, p: AaveV2CalcParams): AaveRates {
  const optimal = bpsToRay(irm.optimalUsageRatioBps)
  const base = bpsToRay(irm.baseVariableBorrowRateBps)
  const slope1 = bpsToRay(irm.variableRateSlope1Bps)
  const slope2 = bpsToRay(irm.variableRateSlope2Bps)

  if (p.totalDebt === 0n) {
    return { liquidityRate: 0n, variableBorrowRate: base, borrowUsageRatio: 0n, supplyUsageRatio: 0n }
  }
  const availableLiquidity = p.virtualUnderlyingBalance + p.liquidityAdded - p.liquidityTaken
  // The strategy underflows (reverts) here; a borrow larger than the pool's cash is
  // not a rate, it is a failed transaction.
  if (availableLiquidity < 0n) throw new Error('aave: liquidityTaken exceeds available liquidity')
  const plusDebt = availableLiquidity + p.totalDebt
  const borrowUsageRatio = rayDiv(p.totalDebt, plusDebt)
  const supplyUsageRatio = rayDiv(p.totalDebt, plusDebt + p.unbacked)

  let variableBorrowRate = base
  if (borrowUsageRatio > optimal) {
    const excess = rayDiv(borrowUsageRatio - optimal, RAY - optimal)
    variableBorrowRate += slope1 + rayMul(slope2, excess)
  } else {
    variableBorrowRate += rayDiv(rayMul(slope1, borrowUsageRatio), optimal)
  }
  const liquidityRate = percentMul(rayMul(variableBorrowRate, supplyUsageRatio), PERCENTAGE_FACTOR - p.reserveFactor)
  return { liquidityRate, variableBorrowRate, borrowUsageRatio, supplyUsageRatio }
}

/** The v3.0 struct fields Spark's strategy reads. `availableLiquidityBalance` stands in
 *  for its own `IERC20(reserve).balanceOf(aToken)` call. */
export interface SparkCalcParams {
  unbacked: bigint
  liquidityAdded: bigint
  liquidityTaken: bigint
  totalVariableDebt: bigint
  reserveFactor: bigint
  availableLiquidityBalance: bigint
}

export function sparkVariableBorrowRates(irm: SparkVariableBorrowIrm, p: SparkCalcParams): AaveRates {
  const optimal = irm.optimalUsageRatioRay
  let variableBorrowRate = irm.baseVariableBorrowRateRay
  let borrowUsageRatio = 0n
  let supplyUsageRatio = 0n
  if (p.totalVariableDebt !== 0n) {
    const availableLiquidity = p.availableLiquidityBalance + p.liquidityAdded - p.liquidityTaken
    if (availableLiquidity < 0n) throw new Error('spark: liquidityTaken exceeds available liquidity')
    const plusDebt = availableLiquidity + p.totalVariableDebt
    borrowUsageRatio = rayDiv(p.totalVariableDebt, plusDebt)
    supplyUsageRatio = rayDiv(p.totalVariableDebt, plusDebt + p.unbacked)
  }
  if (borrowUsageRatio > optimal) {
    // MAX_EXCESS_USAGE_RATIO = RAY - OPTIMAL_USAGE_RATIO
    const excess = rayDiv(borrowUsageRatio - optimal, RAY - optimal)
    variableBorrowRate += irm.variableRateSlope1Ray + rayMul(irm.variableRateSlope2Ray, excess)
  } else {
    variableBorrowRate += rayDiv(rayMul(irm.variableRateSlope1Ray, borrowUsageRatio), optimal)
  }
  const liquidityRate =
    p.totalVariableDebt !== 0n
      ? percentMul(rayMul(variableBorrowRate, supplyUsageRatio), PERCENTAGE_FACTOR - p.reserveFactor)
      : 0n
  return { liquidityRate, variableBorrowRate, borrowUsageRatio, supplyUsageRatio }
}

/** The four ray-scaled curve parameters, whichever strategy holds them. */
export function aaveCurve(irm: AaveV2StrategyIrm | SparkVariableBorrowIrm): {
  optimal: bigint
  base: bigint
  slope1: bigint
  slope2: bigint
} {
  return irm.model === 'aave-rate-strategy-v2'
    ? {
        optimal: bpsToRay(irm.optimalUsageRatioBps),
        base: bpsToRay(irm.baseVariableBorrowRateBps),
        slope1: bpsToRay(irm.variableRateSlope1Bps),
        slope2: bpsToRay(irm.variableRateSlope2Bps),
      }
    : {
        optimal: irm.optimalUsageRatioRay,
        base: irm.baseVariableBorrowRateRay,
        slope1: irm.variableRateSlope1Ray,
        slope2: irm.variableRateSlope2Ray,
      }
}

/** Borrow rate (ray) at a given borrow-usage ratio (ray), same branches as above.
 *  Used for the kink / full-utilization what-ifs, where there is no real balance. */
export function aaveBorrowRateAtUsage(irm: AaveV2StrategyIrm | SparkVariableBorrowIrm, usageRay: bigint): bigint {
  const { optimal, base, slope1, slope2 } = aaveCurve(irm)
  if (usageRay > optimal) return base + slope1 + rayMul(slope2, rayDiv(usageRay - optimal, RAY - optimal))
  return base + rayDiv(rayMul(slope1, usageRay), optimal)
}

// ------------------------------------------------------- reserve configuration

/**
 * ReserveConfiguration bitmap fields we need (aave-v3-origin
 * ReserveConfiguration.sol): decimals 48-55, reserve factor 64-79, borrow cap 80-115,
 * supply cap 116-151. SparkLend uses the same layout.
 */
export function decodeReserveConfig(config: bigint): {
  decimals: number
  reserveFactorBps: bigint
  borrowCapWhole: bigint
  supplyCapWhole: bigint
} {
  const bits = (from: number, width: number): bigint => (config >> BigInt(from)) & ((1n << BigInt(width)) - 1n)
  return {
    decimals: Number(bits(48, 8)),
    reserveFactorBps: bits(64, 16),
    borrowCapWhole: bits(80, 36),
    supplyCapWhole: bits(116, 36),
  }
}
