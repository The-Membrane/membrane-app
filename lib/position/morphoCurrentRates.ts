/**
 * Qualified present-time rates for Morpho Blue, not a forecast.
 * The source IRM view is an interval average used for balance accrual. Keep it intact,
 * reconcile its exact integer replay, then evaluate the adapted target on accrued state.
 */
import { accrueMarket } from '@/lib/curatorFeed/exposure'
import { SECONDS_PER_YEAR, WAD } from '@/lib/netApy/fixedPoint'
import {
  adaptiveCurveBorrowRate,
  curve,
  errorWad,
  MAX_RATE_AT_TARGET,
  MIN_RATE_AT_TARGET,
  morphoSupplyRate,
  utilizationWad,
} from '@/lib/netApy/irm/morpho'
import { MORPHO_ADAPTIVE_CURVE_IRM } from '@/lib/netApy/venues'

export interface MorphoCurrentRateInput {
  irm: string
  storedMarket: readonly bigint[]
  blockTimestamp: bigint | null
  averageRatePerSecond: bigint | null
  rateAtTarget: bigint | null
}

export interface MorphoCurrentRates {
  borrowApr: number | null
  supplyApr: number | null
  reason: string | null
  /** Zero means bit-for-bit equality with the actual source borrowRateView call. */
  replayToleranceWad: 0
}

const unavailable = (reason: string): MorphoCurrentRates => ({
  borrowApr: null,
  supplyApr: null,
  reason,
  replayToleranceWad: 0,
})
const MAX_MARKET_WORD = (1n << 128n) - 1n
const validState = (w: readonly bigint[]) =>
  w.length === 6 &&
  w.every((word) => typeof word === 'bigint' && word >= 0n && word <= MAX_MARKET_WORD) &&
  w[5] <= WAD &&
  w[2] <= w[0]

export function qualifyMorphoCurrentRates(input: MorphoCurrentRateInput): MorphoCurrentRates {
  const {
    irm,
    storedMarket: stored,
    blockTimestamp: now,
    averageRatePerSecond: average,
    rateAtTarget,
  } = input
  if (!validState(stored)) return unavailable('Market state or fee could not be verified')
  if (now === null || !Number.isSafeInteger(Number(now)) || now < stored[4])
    return unavailable('Market observation timestamp unavailable')
  if (/^0x0{40}$/i.test(irm)) {
    return { borrowApr: 0, supplyApr: 0, reason: null, replayToleranceWad: 0 }
  }
  if (irm.toLowerCase() !== MORPHO_ADAPTIVE_CURVE_IRM.toLowerCase())
    return unavailable('Current rate is not qualified for this IRM')
  if (
    average === null ||
    average < 0n ||
    rateAtTarget === null ||
    rateAtTarget < 0n ||
    rateAtTarget > MAX_RATE_AT_TARGET ||
    (rateAtTarget !== 0n && rateAtTarget < MIN_RATE_AT_TARGET)
  )
    return unavailable('Adaptive rate state unavailable')
  try {
    const replay = adaptiveCurveBorrowRate(
      rateAtTarget,
      {
        totalSupplyAssets: stored[0],
        totalBorrowAssets: stored[2],
        lastUpdate: stored[4],
      },
      now,
    )
    // No floating-point fit or tolerance: a mismatch cannot qualify a current number.
    if (replay.avgRate !== average) return unavailable('Source average rate failed exact replay')
    const accrued = accrueMarket([...stored], average, Number(now))
    if (!validState(accrued)) return unavailable('Accrued market state could not be verified')
    const utilization = utilizationWad({
      totalSupplyAssets: accrued[0],
      totalBorrowAssets: accrued[2],
    })
    const currentBorrow = curve(replay.endRateAtTarget, errorWad(utilization))
    const currentSupply = morphoSupplyRate(currentBorrow, utilization, accrued[5])
    const borrowApr = Number(currentBorrow * SECONDS_PER_YEAR) / Number(WAD)
    const supplyApr = Number(currentSupply * SECONDS_PER_YEAR) / Number(WAD)
    return Number.isFinite(borrowApr) &&
      Number.isFinite(supplyApr) &&
      borrowApr >= 0 &&
      supplyApr >= 0
      ? { borrowApr, supplyApr, reason: null, replayToleranceWad: 0 }
      : unavailable('Current rate could not be represented')
  } catch {
    return unavailable('Current rate replay unavailable')
  }
}
