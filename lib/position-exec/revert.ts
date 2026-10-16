/**
 * A revert, named. The simulation (simulate.ts) and the wallet both return viem errors;
 * this pulls out the contract's own reason and, where the protocol's source gives it a
 * meaning, says that meaning in the reader's words. Anything unknown is shown verbatim.
 */

import { BaseError, ContractFunctionRevertedError } from 'viem'

/**
 * Aave V3's string error codes (aave-v3-core Errors.sol; SparkLend keeps them) and the
 * custom errors that replace them in aave-v3-origin. Only the ones a repay or a supply
 * can hit.
 */
const AAVE: Record<string, string> = {
  '26': 'Amount is zero',
  InvalidAmount: 'Amount is zero',
  '27': 'Reserve is not active',
  ReserveInactive: 'Reserve is not active',
  '28': 'Reserve is frozen',
  ReserveFrozen: 'Reserve is frozen',
  '29': 'Reserve is paused',
  ReservePaused: 'Reserve is paused',
  '33': 'Invalid interest rate mode',
  InvalidInterestRateModeSelected: 'Invalid interest rate mode',
  '39': 'No variable-rate debt to repay',
  NoDebtOfSelectedType: 'No variable-rate debt to repay',
  '51': 'Supply cap reached',
  SupplyCapExceeded: 'Supply cap reached',
}

/** Comet custom errors (CometMainInterface.sol). */
const COMET: Record<string, string> = {
  Paused: 'Supply is paused on this Comet',
  SupplyCapExceeded: 'Supply cap reached',
  BadAsset: 'Not a collateral asset of this Comet',
  TransferInFailed: 'Token transfer failed',
}

/** The contract's own reason, or the error's short message when there is none. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.reason) return reverted.reason
      if (reverted.data?.errorName) return reverted.data.errorName
      if (reverted.signature) return `error ${reverted.signature}`
    }
    return err.shortMessage || err.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** "Supply cap reached (Aave 51)", "Balance too low (ERC20: transfer amount exceeds balance)". */
export function namedRevert(reason: string, venue: 'aave' | 'compound' | 'morpho'): string {
  const r = reason.trim()
  const table = venue === 'aave' ? AAVE : venue === 'compound' ? COMET : {}
  if (table[r]) return `${table[r]} (${r})`
  if (/exceeds balance|insufficient balance|balance too low/i.test(r))
    return `Balance too low (${r})`
  if (/allowance/i.test(r)) return `Allowance too low (${r})`
  return r
}

/** A wallet's "no": EIP-1193 code 4001, however deep viem wrapped it. */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    const hit = err.walk(
      (e) =>
        (e as { code?: number }).code === 4001 || (e as Error).name === 'UserRejectedRequestError',
    )
    if (hit) return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return (
    (err as { code?: number } | null)?.code === 4001 ||
    /user rejected|user denied|rejected the request/i.test(msg)
  )
}
