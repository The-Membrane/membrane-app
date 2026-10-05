/**
 * Exit-queue ledger — shared types (Layer: DATA).
 *
 * The contract this layer keeps with its consumers (the venue card, the Recall
 * Coverage Dataset `venue_state` rows, and Risk Frontier's exit-time axis):
 *   - every row is keyed by a stable VenueKey;
 *   - every derived number carries the BlockAnchor it was computed at;
 *   - every derived number carries a LabelClass that says what kind of fact it is.
 * Amounts stay raw integer strings (the venue's own unit and decimals) until the UI
 * formats them, so no float rounding enters the ledger.
 */

export type VenueKey =
  | 'lido-steth'
  | 'beacon-exit'
  | 'etherfi-weeth'
  | 'kelp-rseth'
  | 'ethena-susde'
  | 'maple-syrupusdc'
  | `erc7540:${string}`

/**
 * What kind of fact a number is. The UI prints LABEL_TEXT next to it.
 *  onchain_state     read from the contract at the anchor block
 *  measured_history  observed request outcomes over a trailing window; never a forecast
 *  chain_schedule    the beacon chain's own exit schedule at the anchor (assigned exit
 *                    epochs); a floor for a new exit, not a forecast
 *  change_log        a recorded parameter change (event or read-diff)
 */
export type LabelClass = 'onchain_state' | 'measured_history' | 'chain_schedule' | 'change_log'

export const LABEL_TEXT: Record<LabelClass, string> = {
  onchain_state: 'read on-chain at the anchor block',
  measured_history: 'measured history, not a forecast',
  chain_schedule: 'beacon-chain schedule at the anchor, not a forecast',
  change_log: 'recorded parameter change',
}

/** A block the numbers were computed at. `ts` is UTC seconds. */
export interface BlockAnchor {
  block: number
  ts: number
  hash?: string
}

/** One withdrawal request as the ledger knows it. */
export interface QueueRequest {
  /** Venue-local id: Lido/ether.fi/Maple request id, Kelp `${asset}:${nonce}`, sUSDe/7540 `${tx}:${logIndex}`. */
  id: string
  owner: string
  /** Kelp: the asset the user will receive; ERC-7540: the controller. */
  asset?: string
  /** Raw integer amount in the venue unit (decimal string). */
  amount: string
  requestedBlock: number
  requestedTs: number
  /** Claimable from here on. sUSDe: cooldown maturity (contract rule), which can lie after the anchor. */
  finalizedBlock: number | null
  finalizedTs: number | null
  claimedBlock: number | null
  claimedTs: number | null
  /** Withdrawn by the user, removed or invalidated before it completed. */
  cancelledTs?: number | null
  /**
   * How finalizedTs was obtained. `bracket` = located only to a block range, `claim` = no
   * finalization was seen before the claim, so the claim time stands in. Both are upper bounds.
   */
  finalizedVia?: 'event' | 'read_at_event' | 'bisect' | 'bracket' | 'claim' | 'contract_rule'
  /** Log id (`tx:logIndex`) of the claim, so the same claim log is never applied twice. */
  claimLog?: string
  /** Maple: processed shares went to a manual-withdrawal balance; claim is not observable. */
  manual?: boolean
}

export type ParamValue = string | number | boolean | null

/** A parameter value sample read at an anchor. */
export interface ParamSample {
  block: number
  ts: number
  values: Record<string, ParamValue>
}

export interface ParamChange {
  param: string
  from: ParamValue
  to: ParamValue
  block: number
  ts: number
  /** `event` = the contract emitted it; `state_diff` = two reads disagreed (silent change). */
  source: 'event' | 'state_diff'
  /** For state_diff: the change happened in (sinceBlock, block]. */
  sinceBlock?: number
  txHash?: string
}

/** Queue depth read on-chain (or summed from the ledger) at one anchor. */
export interface QueueSnapshot {
  block: number
  ts: number
  /** Raw integer amount in the venue unit, or null when the venue has no on-chain total. */
  depthAmount: string | null
  depthCount: number | null
  depthSource: 'onchain' | 'ledger' | 'beacon_api'
  /** Beacon only: seconds until the last scheduled exit epoch. */
  scheduleWaitS?: number | null
  extra?: Record<string, ParamValue>
}

/** The persisted per-venue ledger (one JSON file per venue under data/exit-queue/). */
export interface VenueLedger {
  schema: 1
  venue: VenueKey
  /** Contiguous block span whose logs are fully applied. */
  coverage: { fromBlock: number; fromTs: number; throughBlock: number; throughTs: number } | null
  requests: Record<string, QueueRequest>
  params: ParamSample[]
  changes: ParamChange[]
  snapshots: QueueSnapshot[]
  /** Venue-specific monotone frontiers (ether.fi lastFinalizedRequestId, Kelp nextLockedNonce per asset). */
  cursors: Record<string, string>
  /** Claims seen whose request could not be identified (sUSDe amount match failed, or the request predates coverage). */
  unmatchedClaims: number
  /** Logs that matched a topic but did not decode (ABI drift or a malformed log). */
  undecodedLogs: number
  /** Historical reads that came back out of order or failed and forced a bracket. */
  readAnomalies?: number
  /** Request ids still missing from a sequential-id venue after re-fetching (missed logs). */
  idGaps?: number
}

/** A log as the recorder hands it to the decoders. */
export interface RawLog {
  address: string
  topics: readonly string[]
  data: string
  blockNumber: number
  logIndex: number
  transactionHash: string
  /** UTC seconds. */
  blockTimestamp: number
}

export type LedgerEvent =
  | {
      kind: 'request'
      id: string
      owner: string
      asset?: string
      amount: bigint
      block: number
      ts: number
      logIndex: number
    }
  | {
      kind: 'finalize_range'
      fromId: bigint
      toId: bigint
      block: number
      ts: number
      logIndex: number
    }
  | {
      kind: 'finalize_through'
      /** Ids <= throughId (or, with `asset`, nonces < throughId) become finalized. */
      throughId: bigint
      asset?: string
      exclusive?: boolean
      block: number
      ts: number
      logIndex: number
      via: 'read_at_event' | 'bisect' | 'bracket'
    }
  | { kind: 'claim'; id: string; block: number; ts: number; logIndex: number; logId: string }
  | {
      kind: 'claim_fifo'
      owner: string
      asset: string
      /** When set, the oldest open request must have exactly this amount (Kelp). */
      amount?: bigint
      block: number
      ts: number
      logIndex: number
      logId: string
    }
  | {
      kind: 'claim_amount'
      receiver: string
      amount: bigint
      block: number
      ts: number
      logIndex: number
      logId: string
    }
  | { kind: 'process'; id: string; block: number; ts: number; logIndex: number; txHash: string }
  | { kind: 'remove'; id: string; block: number; ts: number; logIndex: number; txHash: string }
  | { kind: 'manual'; id: string; block: number; ts: number; logIndex: number }
  | {
      kind: 'param'
      param: string
      from?: ParamValue
      to: ParamValue
      block: number
      ts: number
      logIndex: number
      txHash: string
    }
  | { kind: 'unlock_hint'; asset: string; block: number; ts: number; logIndex: number }
