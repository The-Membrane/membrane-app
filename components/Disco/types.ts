/**
 * Types for the LTV-designated Disco slot system.
 * Slots are at 1% LTV intervals between min_ltv and max_ltv per asset queue.
 * Higher LTV = riskiest (first to absorb bad debt, earns most revenue)
 * Lower LTV = safest (last to absorb bad debt, earns least revenue)
 */

/** A single slot in an asset queue, keyed by max_ltv */
export interface DiscoSlot {
  max_ltv: string // Decimal, e.g. "0.80" for 80%
  total_deposit_tokens: string // Uint128
  total_vault_tokens: string // Uint128
  bad_debt: string // Uint128
}

/** Asset queue containing LTV-designated slots */
export interface AssetQueue {
  slots: DiscoSlot[]
  current_deposit_id: string // Uint128
  min_ltv: string // Decimal, e.g. "0.50"
  max_ltv: string // Decimal, e.g. "0.90"
}

/** Individual backing deposit within a slot */
export interface BackingDeposit {
  user: string
  vault_tokens: string // Uint128
  last_claimed: number // u64 timestamp
  start_time: number // u64 timestamp
  deposit_time?: number // u64 timestamp
  compound_claims: boolean
  manager?: string
  depositor?: string
  withdrawals_enabled: boolean
  revenue_destination?: string
}

/** User deposit information from get_all_user_deposits */
export interface UserDepositInfo {
  asset: string
  slot: number // LTV percentage (e.g. 80 for 80%)
  deposit_id: string // Uint128
  deposit: BackingDeposit
  deposit_tokens: string // Uint128 (converted from vault tokens)
}

/** Pending unstake request */
export interface UnstakeRequest {
  user: string
  asset: string
  slot: number // LTV percentage (e.g. 80 for 80%)
  deposit_id: string // Uint128
  vault_tokens: string // Uint128
  request_time: number // u64 timestamp
  unlock_time: number // u64 timestamp
}

/** Pending claim for a specific deposit */
export interface PendingClaim {
  slot: number // LTV percentage (e.g. 80 for 80%)
  deposit_id: string // Uint128
  pending_amount: string // Uint128
}

/** Slot weight from get_slot_weights query */
export interface SlotWeight {
  slot: number // LTV percentage (e.g. 80 for 80%)
  weight: string // Decimal
}

/** Revenue tracking entry */
export interface RevenueTrackingEntry {
  timestamp: number // u64
  total_revenue: string // Uint128
}

/** TVL tracking entry */
export interface TVLEntry {
  timestamp: number // u64
  total_deposit_tokens: string // Uint128
}

/** Daily deposit tracking entry per asset */
export interface DepositEntry {
  timestamp: number // u64
  deposit_tokens: string // Uint128
}

/** User lifetime revenue entry */
export interface UserLifetimeRevenueEntry {
  timestamp: number // u64
  total_claimed: string // Uint128
}

/** Manager performance tracking entry (cumulative snapshots) */
export interface ManagerPerformanceEntry {
  timestamp: number // u64
  total_fees_earned: string // Uint128, cumulative CDT fees
  total_bad_debt_absorbed: string // Uint128, cumulative deposit-token losses
  total_capital_managed: string // Uint128, point-in-time snapshot
  assets_managed: [string, string][] // [asset_denom, deposit_tokens][]
}

/** Response from GetManagerPerformance query */
export interface ManagerPerformanceResponse {
  manager: string
  entries: ManagerPerformanceEntry[]
}

/** Slot data for UI components */
export interface SlotData {
  slot: number // LTV percentage (e.g. 80 for 80%)
  ltvLabel: string // Display string, e.g. "80%"
  tvl: number // total deposit tokens (raw, in base units)
  apr?: string | null
  weight?: string // revenue weight
  badDebt?: string
  vaultTokens?: string
}

/** Get display label for a slot by its LTV percentage */
export function getSlotLabel(slot: number): string {
  return `${slot}%`
}
