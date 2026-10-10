/**
 * Equal-principal GHO carry stress using measured rate legs and optional vault inventory.
 * This is a what-if calculation, not a prediction, route return, or executable exit quote.
 */
export type CuratorScenarioInput = {
  principalGho: number
  horizonDays: number
  borrowApy: number
  yieldApy: number
  borrowRisePp: number
  yieldFallPp: number
  cashDrawdownPct: number
  vaultCashGho?: number
  vaultAssetsGho?: number
  withdrawalsPaused?: boolean
}

export type CuratorScenarioResult = {
  horizonDays: number
  currentSpreadPp: number
  stressedSpreadPp: number
  currentAnnualNetGho: number
  stressedAnnualNetGho: number
  changeInAnnualNetGho: number
  currentHorizonNetGho: number
  stressedHorizonNetGho: number
  changeInHorizonNetGho: number
  /** Current yield minus current borrow, in percentage points. Negative means already underwater. */
  combinedShockRoomPp: number
  inventory: null | {
    currentVaultSideGho: number
    stressedVaultSideGho: number
    currentShortfallGho: number
    stressedShortfallGho: number
    /** Percentage of current cash lost before the entered size exceeds the vault-side bound. */
    cashDrawdownRoomPct: number | null
  }
}

const MAX_PRINCIPAL_GHO = 1_000_000_000_000
const MAX_APY = 10
const allowedBorrowRises = [0, 0.5, 1, 2]
const allowedYieldFalls = [0, 0.5, 1, 2]
const allowedCashDrawdowns = [0, 25, 50, 75]

export function calculateCuratorScenario(
  input: CuratorScenarioInput,
): CuratorScenarioResult | null {
  const {
    principalGho,
    horizonDays,
    borrowApy,
    yieldApy,
    borrowRisePp,
    yieldFallPp,
    cashDrawdownPct,
    vaultCashGho,
    vaultAssetsGho,
    withdrawalsPaused,
  } = input
  if (
    !Number.isFinite(principalGho) ||
    principalGho <= 0 ||
    principalGho > MAX_PRINCIPAL_GHO ||
    !Number.isInteger(horizonDays) ||
    horizonDays < 1 ||
    horizonDays > 365 ||
    !Number.isFinite(borrowApy) ||
    borrowApy < 0 ||
    borrowApy > MAX_APY ||
    !Number.isFinite(yieldApy) ||
    yieldApy <= -1 ||
    yieldApy > MAX_APY ||
    !allowedBorrowRises.includes(borrowRisePp) ||
    !allowedYieldFalls.includes(yieldFallPp) ||
    !allowedCashDrawdowns.includes(cashDrawdownPct) ||
    yieldApy - yieldFallPp / 100 <= -1
  ) {
    return null
  }

  const hasAnyInventory =
    vaultCashGho !== undefined || vaultAssetsGho !== undefined || withdrawalsPaused !== undefined
  if (
    hasAnyInventory &&
    (!Number.isFinite(vaultCashGho) ||
      !Number.isFinite(vaultAssetsGho) ||
      (vaultCashGho ?? -1) < 0 ||
      (vaultAssetsGho ?? -1) < 0 ||
      typeof withdrawalsPaused !== 'boolean')
  ) {
    return null
  }

  const currentSpread = yieldApy - borrowApy
  const stressedSpread = currentSpread - (borrowRisePp + yieldFallPp) / 100
  const currentAnnualNetGho = principalGho * currentSpread
  const stressedAnnualNetGho = principalGho * stressedSpread
  const currentHorizonNetGho = (currentAnnualNetGho * horizonDays) / 365
  const stressedHorizonNetGho = (stressedAnnualNetGho * horizonDays) / 365
  let inventory: CuratorScenarioResult['inventory'] = null
  if (hasAnyInventory) {
    const currentCash = vaultCashGho as number
    const totalAssets = vaultAssetsGho as number
    const currentVaultSideGho = withdrawalsPaused ? 0 : Math.min(currentCash, totalAssets)
    const stressedVaultSideGho = withdrawalsPaused
      ? 0
      : Math.min(currentCash * (1 - cashDrawdownPct / 100), totalAssets)
    inventory = {
      currentVaultSideGho,
      stressedVaultSideGho,
      currentShortfallGho: Math.max(0, principalGho - currentVaultSideGho),
      stressedShortfallGho: Math.max(0, principalGho - stressedVaultSideGho),
      cashDrawdownRoomPct:
        withdrawalsPaused ||
        currentCash === 0 ||
        principalGho > totalAssets ||
        principalGho > currentCash
          ? null
          : Math.max(0, Math.min(100, (1 - principalGho / currentCash) * 100)),
    }
  }
  return {
    horizonDays,
    currentSpreadPp: currentSpread * 100,
    stressedSpreadPp: stressedSpread * 100,
    currentAnnualNetGho,
    stressedAnnualNetGho,
    changeInAnnualNetGho: stressedAnnualNetGho - currentAnnualNetGho,
    currentHorizonNetGho,
    stressedHorizonNetGho,
    changeInHorizonNetGho: stressedHorizonNetGho - currentHorizonNetGho,
    combinedShockRoomPp: currentSpread * 100,
    inventory,
  }
}

/**
 * Calendar-only Disco lower-LTV planning arithmetic. All three values are user assumptions;
 * this does not read a deployed config, position, pending intent, or effective slot move.
 * An intent requested today would be eligible from W through W + E days from now.
 */
export function calculateDiscoDecisionWindow(input: {
  daysUntilNeeded: number
  configuredWaitDays: number
  executionWindowDays: number
}): {
  earliestUsefulRequestInDays: number
  latestRequestInDays: number
  todayStatus: 'early' | 'in-window' | 'too-late'
  eligibilityStartsInDays: number
  eligibilityEndsInDays: number
} | null {
  if (
    !Number.isFinite(input.daysUntilNeeded) ||
    input.daysUntilNeeded < 0 ||
    input.daysUntilNeeded > 3650 ||
    !Number.isFinite(input.configuredWaitDays) ||
    input.configuredWaitDays < 0 ||
    input.configuredWaitDays > 3650 ||
    !Number.isFinite(input.executionWindowDays) ||
    input.executionWindowDays < 0 ||
    input.executionWindowDays > 3650
  ) {
    return null
  }
  const earliestUsefulRequestInDays =
    input.daysUntilNeeded - input.configuredWaitDays - input.executionWindowDays
  const latestRequestInDays = input.daysUntilNeeded - input.configuredWaitDays
  return {
    earliestUsefulRequestInDays,
    latestRequestInDays,
    todayStatus:
      earliestUsefulRequestInDays > 0
        ? 'early'
        : latestRequestInDays < 0
          ? 'too-late'
          : 'in-window',
    eligibilityStartsInDays: input.configuredWaitDays,
    eligibilityEndsInDays: input.configuredWaitDays + input.executionWindowDays,
  }
}
