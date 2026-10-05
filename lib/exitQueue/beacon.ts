import type { QueueSnapshot } from './types'

/**
 * Ethereum validator exit queue from the standard Beacon API.
 *
 *   GET /eth/v1/beacon/headers/head                               → head slot
 *   GET /eth/v1/beacon/states/head/validators?status=active_exiting → exiting validators
 *   GET /eth/v1/config/spec                                       → SECONDS_PER_SLOT etc.
 *
 * After Electra the exit churn is balance-based and the state keeps
 * `earliest_exit_epoch`, which the standard API does not expose. The largest
 * `exit_epoch` among active_exiting validators is the tail of the schedule: a new
 * exit cannot be assigned an earlier epoch. So `scheduleWaitS` is a FLOOR for a new
 * exit from the chain's own schedule — not a forecast, and not measured history.
 * Withdrawability adds MIN_VALIDATOR_WITHDRAWABILITY_DELAY epochs, then the sweep.
 * The validators response is ~11 MB at 24k exiting validators (2026-10-05); only
 * this summary is stored.
 */

export interface BeaconSpec {
  SECONDS_PER_SLOT: number
  SLOTS_PER_EPOCH: number
  MIN_VALIDATOR_WITHDRAWABILITY_DELAY: number
}

export const MAINNET_SPEC: BeaconSpec = {
  SECONDS_PER_SLOT: 12,
  SLOTS_PER_EPOCH: 32,
  MIN_VALIDATOR_WITHDRAWABILITY_DELAY: 256,
}

/** Beacon API returns numbers as decimal strings. */
export function parseSpec(raw: Record<string, unknown>): BeaconSpec {
  const n = (k: keyof BeaconSpec) => {
    const v = Number(raw[k])
    if (!Number.isFinite(v) || v <= 0) throw new Error(`beacon spec missing ${k}`)
    return v
  }
  return {
    SECONDS_PER_SLOT: n('SECONDS_PER_SLOT'),
    SLOTS_PER_EPOCH: n('SLOTS_PER_EPOCH'),
    MIN_VALIDATOR_WITHDRAWABILITY_DELAY: n('MIN_VALIDATOR_WITHDRAWABILITY_DELAY'),
  }
}

export interface ExitingValidator {
  status: string
  validator: { exit_epoch: string; effective_balance: string; withdrawable_epoch?: string }
}

export interface BeaconExitSummary {
  headSlot: number
  headEpoch: number
  exitingCount: number
  /** Sum of effective balances, gwei, as a decimal string. */
  exitingGwei: string
  tailExitEpoch: number | null
  scheduleWaitS: number
  withdrawabilityDelayS: number
}

const FAR_FUTURE_EPOCH = 2n ** 64n - 1n

export function summarizeExitQueue(
  headSlot: number,
  validators: ExitingValidator[],
  spec: BeaconSpec = MAINNET_SPEC,
): BeaconExitSummary {
  const headEpoch = Math.floor(headSlot / spec.SLOTS_PER_EPOCH)
  let gwei = 0n
  let tail: number | null = null
  let count = 0
  for (const v of validators) {
    if (v.status !== 'active_exiting') continue
    const exitEpoch = BigInt(v.validator.exit_epoch)
    if (exitEpoch === FAR_FUTURE_EPOCH) continue
    count += 1
    gwei += BigInt(v.validator.effective_balance)
    const e = Number(exitEpoch)
    if (tail == null || e > tail) tail = e
  }
  const epochS = spec.SECONDS_PER_SLOT * spec.SLOTS_PER_EPOCH
  return {
    headSlot,
    headEpoch,
    exitingCount: count,
    exitingGwei: gwei.toString(),
    tailExitEpoch: tail,
    scheduleWaitS: tail == null ? 0 : Math.max(0, tail - headEpoch) * epochS,
    withdrawabilityDelayS: spec.MIN_VALIDATOR_WITHDRAWABILITY_DELAY * epochS,
  }
}

/**
 * The beacon row's anchor is the head slot's execution block. Stored snapshots keep
 * the slot in `extra` so a reading can be re-derived from a historical state later.
 */
export function beaconSnapshot(
  summary: BeaconExitSummary,
  executionBlock: number,
  ts: number,
): QueueSnapshot {
  return {
    block: executionBlock,
    ts,
    depthAmount: summary.exitingGwei,
    depthCount: summary.exitingCount,
    depthSource: 'beacon_api',
    scheduleWaitS: summary.scheduleWaitS,
    extra: {
      headSlot: summary.headSlot,
      headEpoch: summary.headEpoch,
      tailExitEpoch: summary.tailExitEpoch,
      withdrawabilityDelayS: summary.withdrawabilityDelayS,
    },
  }
}
