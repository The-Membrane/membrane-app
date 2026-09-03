/**
 * Success-toast copy built ONLY from values that are real on the EVM path today:
 * debt (vault summary) and the user's own input amounts. LTV/collateral-value
 * deltas are deliberately excluded until the Collateral service lands —
 * currentPosition.collateralValue is an honest-empty stub (see useDepositModal.ts),
 * and rendering an LTV from it would teach a fabricated number.
 */
export const fmtUsd = (v: number): string =>
  `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`

export const debtDeltaMessage = (before: number, after: number): string =>
  `Debt ${fmtUsd(before)} → ${fmtUsd(after)}`
