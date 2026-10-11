/**
 * A bounded, rate-only one-year illustration for equal GHO borrowed and held.
 * It is not a forecast, leveraged-equity return, or executable exit quote.
 */
export interface RateWorksheetInput {
  sizeGho: number
  borrowApy: number
  yieldApy: number
  /** Additive shock to the borrow APY, in percentage points (not decimals). */
  borrowShockPp?: number
}

export interface RateWorksheetResult {
  currentAnnualNetGho: number
  shockedAnnualNetGho: number
  currentSpreadPp: number
  shockedSpreadPp: number
  /** Maximum borrow APY that would make this equal-principal rate spread zero. */
  breakEvenBorrowApy: number
  /** How many percentage points borrow APY can rise before the spread reaches zero. */
  breakEvenHeadroomPp: number
}

export const MAX_WORKSHEET_SIZE_GHO = 1_000_000_000_000
export const MAX_WORKSHEET_APY = 10
export const MIN_WORKSHEET_YIELD_APY = -1

/** Vault-side bound, never a wallet maxWithdraw quote. Keep fractional GHO for size comparisons. */
export function vaultSideRedeemCeiling(input: {
  vaultCashGho: number
  totalAssetsGho: number
  withdrawalsPaused: boolean
}): number | null {
  if (
    !Number.isFinite(input.vaultCashGho) ||
    input.vaultCashGho < 0 ||
    !Number.isFinite(input.totalAssetsGho) ||
    input.totalAssetsGho < 0 ||
    typeof input.withdrawalsPaused !== 'boolean'
  )
    return null
  return input.withdrawalsPaused ? 0 : Math.min(input.vaultCashGho, input.totalAssetsGho)
}

export function calculateRateWorksheet({
  sizeGho,
  borrowApy,
  yieldApy,
  borrowShockPp = 0,
}: RateWorksheetInput): RateWorksheetResult | null {
  if (
    !Number.isFinite(sizeGho) ||
    sizeGho <= 0 ||
    sizeGho > MAX_WORKSHEET_SIZE_GHO ||
    !Number.isFinite(borrowApy) ||
    borrowApy < 0 ||
    borrowApy > MAX_WORKSHEET_APY ||
    !Number.isFinite(yieldApy) ||
    yieldApy <= MIN_WORKSHEET_YIELD_APY ||
    yieldApy > MAX_WORKSHEET_APY ||
    ![0, 1, 2].includes(borrowShockPp)
  ) {
    return null
  }

  const currentSpread = yieldApy - borrowApy
  const shockedSpread = currentSpread - borrowShockPp / 100

  return {
    currentAnnualNetGho: sizeGho * currentSpread,
    shockedAnnualNetGho: sizeGho * shockedSpread,
    currentSpreadPp: currentSpread * 100,
    shockedSpreadPp: shockedSpread * 100,
    breakEvenBorrowApy: yieldApy,
    breakEvenHeadroomPp: currentSpread * 100,
  }
}
