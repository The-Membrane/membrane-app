/**
 * Euler v2 IRMLinearKink, reproduced exactly.
 * Source: euler-xyz/euler-vault-kit src/InterestRateModels/IRMLinearKink.sol
 * `computeInterestRateInternal`. Output is a per-second rate in ray (SPY).
 *
 * Utilization is quantised to uint32 (type(uint32).max = 100%), and the slopes are
 * per uint32 step — that quantisation is part of the on-chain answer, so it is kept.
 */

import type { EulerLinearKinkIrm } from '../types'

export const UINT32_MAX = 2n ** 32n - 1n
/** EVK CONFIG_SCALE: interestFee 1e4 = 100%. */
export const EULER_CONFIG_SCALE = 10_000n

export function eulerUtilization(cash: bigint, borrows: bigint): bigint {
  const totalAssets = cash + borrows
  return totalAssets === 0n ? 0n : (borrows * UINT32_MAX) / totalAssets
}

export function linearKinkRateAtUtilization(irm: EulerLinearKinkIrm, utilization: bigint): bigint {
  let ir = irm.baseRate
  if (utilization <= irm.kink) ir += utilization * irm.slope1
  else ir += irm.kink * irm.slope1 + irm.slope2 * (utilization - irm.kink)
  return ir
}

export function linearKinkRate(irm: EulerLinearKinkIrm, cash: bigint, borrows: bigint): bigint {
  return linearKinkRateAtUtilization(irm, eulerUtilization(cash, borrows))
}
