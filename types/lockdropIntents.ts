/**
 * Type definitions for MBRN claim intents in transmuter lockdrop
 * These match the Rust structs in packages/membrane/src/transmuter_lockdrop.rs
 */

export interface Locked {
  /** Lock expiration timestamp (Unix seconds) */
  locked_until: string
  /** Perpetual lock duration in days (if set, lock refreshes on each execute) */
  perpetual_lock?: string | null
  /** Intended lock duration in days when lock was created */
  intended_lock_days?: string | null
}

export type MbrnIntentType =
  | { stake: {} }
  | {
      deposit_via_mars_mirror: {
        /** Asset to deposit (must be valid Disco asset) */
        asset: string
        /** LTV to target (optional, can be auto-selected by mirror) */
        target_ltv?: string | null
        /** Max borrow LTV to target (optional, can be auto-selected by mirror) */
        target_max_borrow_ltv?: string | null
      }
    }
  | {
      send_to_address: {
        /** Address to receive the MBRN */
        address: string
      }
    }

export interface MbrnIntentOption {
  /** Intent type */
  intent_type: MbrnIntentType
  /** Ratio of claimed MBRN to allocate (0.0 to 1.0, as Decimal string) */
  ratio: string
  /** Optional lock information if intent supports locking */
  lock?: Locked | null
}

export interface MbrnClaimIntent {
  /** Whether to apply intent for this claim */
  apply_now: boolean
  /** Whether to set this as ongoing intent for future claims */
  set_ongoing: boolean
  /** Intent distribution ratios (must sum to 1.0) */
  intents: MbrnIntentOption[]
}

export interface UserIntentsResponse {
  intents: MbrnIntentOption[] | null
}

export interface IntentBoostsResponse {
  boosts: string[] // Array of Decimal strings representing boost percentages
}





















