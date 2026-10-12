/**
 * exitQueueAxis — the exit-queue axis of Risk Frontier (docs/RISK_FRONTIER_DESIGN.md, v2
 * item 1: "LST exit-queue ledger (Lido first): the exit-queue axis"). It resolves a position
 * token to its venue's MEASURED withdrawal-queue time, and runs the stress engine
 * (stressGrid.ts) with what such a venue can actually pay inside a liquidation: its buffer.
 *
 * CORRECTED 2026-10-12 (owner): "no matter how long the queue is, whatever is liquid at the
 * time the window is over or breached is what will be used." The first version ran the queue
 * time as a venue freeze (recall filed at the first breach, paid after the wait). Nothing
 * files such a request. The liquidation engine recalls synchronously inside the call
 * (membrane-solidity LiquidationEngine step 1.5: `retrievableCdt` → `repayUserDebt`), bounded
 * by `idle + CDT buffer + _venueLiquid()` (DeploymentVaultBase `_liquidCdt`). A queue venue's
 * `_venueLiquid()` is 0 (DeploymentVaultUSDe.sol:14: "under cooldown the venue reads as
 * ILLIQUID"), and `repayUserDebt` starts no unstake. So the queue time never changes the
 * outcome. It says how long the rest stays locked after the sale.
 *
 * Input: the exit-queue ledger's per-venue `ExitTimeInput` (lib/exitQueue/riskFrontier.ts,
 * `exitTimeInput(metrics, 30)`; the `riskFrontier` array of GET /api/venues/exit-queues).
 * The single number is `exitTime(input, 'p90')`: the largest of the measured request →
 * claimable quantile (or its lower bound when not reached), the beacon schedule floor and
 * the advertised cooldown.
 *
 * Labels: the time is a measured fact (umbrella class measured_change). Its basis says
 * which: "measured history, not a forecast" for request outcomes and for past beacon
 * schedule readings, "read on-chain at the anchor block" for a cooldown, and "beacon-chain
 * schedule at the anchor, not a forecast" only for the anchor's own beacon schedule. The
 * stress run built on it is a stress scenario (STRESS_LABEL). Both travel with every
 * result; the time is never shown without its label.
 *
 * ---------------------------------------------------------------------------
 * RULES (each has a test in tests/unit/exitQueueAxis.test.ts)
 * ---------------------------------------------------------------------------
 *  1. ONE KEY. The position's venue token resolves to the ledger's VenueKey through
 *     `venueKeyForAsset` (the ledger's `aliases.assets`: wstETH → lido-steth, sUSDe →
 *     sUSDe). A token no ledger venue covers is `unknown` 'unmapped_venue'.
 *  2. UNKNOWN IS NOT ZERO. A covered venue with no input is 'no_ledger'; an input with no
 *     exit time (exitTime() null) is 'no_exit_time'; two inputs for one venue is
 *     'invalid_input'. An unknown axis runs NO stress: the bridge returns null results.
 *  3. FRESHNESS. The input's anchor must be 'recent' under the ledger's own rule
 *     (lib/exitQueue/feed.ts `observationStatus`: 0 ≤ age ≤ 30 h at `nowMs`), else
 *     'stale', and a stale venue runs nothing: the ledger is what says the venue still
 *     queues (sUSDe is liquid again if Ethena sets its cooldown to 0). `nowMs` is a
 *     parameter; the clock is never read.
 *  4. ONLY THE BUFFER IS LIQUID. A queue venue pays nothing from the queue inside the call,
 *     whatever its length, so the run replaces the position's exit capacity with the vault
 *     buffer: `exitCapacityUsd = deployed × share`. It sets no freeze. Two runs bracket the
 *     buffer: at its target (QUEUE_BUFFER_TARGET_SHARE, `bufferBps` 500 = 5%) and drained
 *     (0: other withdrawals emptied it, and a queue venue cannot refill it). Both assume the
 *     whole book recalls at once, like the cash-vs-book levels. `range` orders the two by
 *     stressRank; neither is "best" (the floor close makes the outcome non-monotone in the
 *     stock). The queue time is in none of the runs.
 *  5. LABEL TRAVELS. `runExitQueueStress` returns { axis, atBufferTarget, bufferDrained,
 *     range }; a result never leaves without the exit time and its label. `atLeast` (print
 *     "≥") is kept. A lower bound under 1 s says nothing about the wait and is 'no_exit_time'.
 *  6. A STALL STAYS VISIBLE. `oldestOpenAgeS` (the oldest open request's wait) travels with
 *     the axis and is named in the provenance when it exceeds the exit time. It does not bound
 *     a new request's wait.
 */

import { observationStatus } from '../exitQueue/feed'
import { exitTime, type ExitTime, type ExitTimeInput } from '../exitQueue/riskFrontier'
import type { VenueKey } from '../exitQueue/types'
import { venueByKey, venueKeyForAsset } from '../exitQueue/venues'

import {
  DEFAULT_PRICE_SHAPES,
  runStress,
  STRESS_LABEL,
  stressRank,
  type PriceShape,
  type StressPosition,
  type StressResult,
  type StressRunOptions,
} from './stressGrid'

export type ExitQueueUnknownReason =
  | 'unmapped_venue'
  | 'no_ledger'
  | 'no_exit_time'
  | 'stale'
  | 'invalid_input'

export interface ExitQueueAxisOptions {
  /** Ages the anchor. A parameter, never the clock. */
  nowMs: number
  /** Default 'p90' (the conservative single number). */
  q?: 'p50' | 'p90'
}

export interface ExitQueueMeasured {
  status: 'measured'
  /** The position's venue token, as given. */
  asset: string
  venue: VenueKey
  /** Seconds, source, atLeast, label, anchor, n, coverage: show them together. */
  exitTime: ExitTime
  /** The oldest open request's wait at the anchor (shown; it enters no run). */
  oldestOpenAgeS: number | null
  anchorAgeHours: number
  stressLabel: typeof STRESS_LABEL
  /** Names the value by its window and anchor block, never "now". */
  provenance: string
}

export interface ExitQueueUnknown {
  status: 'unknown'
  asset: string
  venue: VenueKey | null
  reason: ExitQueueUnknownReason
  detail: string
  stressLabel: typeof STRESS_LABEL
}

export type ExitQueueAxis = ExitQueueMeasured | ExitQueueUnknown

const fmtHours = (s: number) =>
  s < 3600
    ? `${(s / 60).toFixed(1)} min`
    : s < 72 * 3600
      ? `${(s / 3600).toFixed(1)} h`
      : `${(s / 86_400).toFixed(1)} d`

/** Resolve one position venue token to its measured exit time, or say why it is unknown. */
export function exitQueueAxis(
  asset: string,
  inputs: readonly ExitTimeInput[],
  opts: ExitQueueAxisOptions,
): ExitQueueAxis {
  const unknown = (
    reason: ExitQueueUnknownReason,
    detail: string,
    venue: VenueKey | null = null,
  ): ExitQueueUnknown => ({
    status: 'unknown',
    asset,
    venue,
    reason,
    detail,
    stressLabel: STRESS_LABEL,
  })

  const venue = venueKeyForAsset(asset)
  if (!venue)
    return unknown('unmapped_venue', `no exit-queue ledger covers ${JSON.stringify(asset)}`)
  const matches = inputs.filter((i) => i.venue === venue)
  if (!matches.length) return unknown('no_ledger', `no ledger input for ${venue}`, venue)
  if (matches.length > 1)
    return unknown('invalid_input', `${matches.length} inputs for ${venue}`, venue)
  const input = matches[0]

  if (!Number.isFinite(opts.nowMs)) return unknown('invalid_input', 'nowMs is not finite', venue)
  if (observationStatus(input.anchor.ts, opts.nowMs) !== 'recent') {
    return unknown(
      'stale',
      `anchor block ${input.anchor.block} is ${((opts.nowMs / 1000 - input.anchor.ts) / 3600).toFixed(1)} h old`,
      venue,
    )
  }

  const r = input.requestToExit
  const durations = [
    r.p50S,
    r.p90S,
    r.atLeastS,
    input.advertisedCooldownS,
    input.scheduleFloorS,
    input.oldestOpenAgeS,
  ]
  if (!durations.every((x) => x == null || (Number.isFinite(x) && x >= 0))) {
    return unknown('invalid_input', `${venue}: an exit-time input is not a duration`, venue)
  }

  const q = opts.q ?? 'p90'
  const t = exitTime(input, q)
  if (!t)
    return unknown('no_exit_time', `${venue}: nothing measured and no binding cooldown`, venue)
  if (!(Number.isFinite(t.seconds) && t.seconds >= 0)) {
    return unknown('invalid_input', `${venue}: exit time ${t.seconds} is not a duration`, venue)
  }
  if (t.atLeast && t.seconds < 1) {
    // "≥ 0 s" would run as an instant exit at one end of the range.
    return unknown(
      'no_exit_time',
      `${venue}: a lower bound under 1 s says nothing about the wait`,
      venue,
    )
  }

  const name = venueByKey(venue)?.label ?? venue
  const what =
    t.source === 'measured_quantile' && venue === 'beacon-exit'
      ? `${q} of beacon schedule readings over ${t.windowDays} d + withdrawability delay (sweep excluded)`
      : t.source === 'measured_quantile'
        ? `${q} request → claimable over ${t.windowDays} d (n=${t.n}, ${t.coverage} window)`
        : t.source === 'measured_at_least'
          ? `${q} not reached over ${t.windowDays} d; the oldest open request has waited this long (n=${t.n})`
          : t.source === 'advertised_cooldown'
            ? 'on-chain cooldown'
            : 'beacon exit schedule + withdrawability delay (sweep excluded)'
  const oldest = input.oldestOpenAgeS
  const stall =
    oldest != null && oldest > t.seconds
      ? `; the oldest open request has waited ${fmtHours(oldest)}`
      : ''
  return {
    status: 'measured',
    asset,
    venue,
    exitTime: t,
    oldestOpenAgeS: oldest,
    anchorAgeHours: (opts.nowMs / 1000 - t.anchor.ts) / 3600,
    stressLabel: STRESS_LABEL,
    provenance: `${name}: ${t.atLeast ? '≥ ' : ''}${fmtHours(t.seconds)}, ${what}, at block ${t.anchor.block}${stall} — ${t.label.text}`,
  }
}

/**
 * The vault buffer at its target, as a share of the vault: membrane-solidity
 * DeploymentVaultBase.sol:254 `bufferBps = 500`. Governance can set 200–2500 bps (:79-80).
 */
export const QUEUE_BUFFER_TARGET_SHARE = 0.05

/**
 * The position as a queue venue holds it at the liquidation call: its exit capacity is the
 * buffer share of what it deployed, with no preset, multiple or lock. A levered long has no
 * recall and is returned unchanged (the engine refuses it).
 */
export function queueVenuePosition(p: StressPosition, bufferShare: number): StressPosition {
  if (p.tradeShape !== 'carry') return p
  const share = Number.isFinite(bufferShare) ? Math.min(1, Math.max(0, bufferShare)) : 0
  return {
    ...p,
    exitCapacityUsd: (p.deployedUsd ?? 0) * share,
    exitCapacityPreset: undefined,
    exitCapacityMult: undefined,
  }
}

export interface ExitQueueStress {
  /** Carries the exit time and its label (or why it is unknown). */
  axis: ExitQueueAxis
  /** Recall = the buffer at its 5% target. Null when the axis is unknown: nothing was run. */
  atBufferTarget: StressResult | null
  /** Recall = nothing: the buffer drained. Null when the axis is unknown. */
  bufferDrained: StressResult | null
  /** The two runs ordered by stressRank (neither is "best"). Null if either is not modelled. */
  range: { mildest: StressResult; severest: StressResult } | null
}

/** Run one price shape with the venue's liquid part only: the buffer, at target and drained. */
export function runExitQueueStress(
  position: StressPosition,
  price: PriceShape,
  axis: ExitQueueAxis,
  opts: StressRunOptions = {},
): ExitQueueStress {
  if (axis.status !== 'measured')
    return { axis, atBufferTarget: null, bufferDrained: null, range: null }
  // A levered long has nothing deployed, so no queue applies: a venue condition draws the
  // engine's own refusal ('no_recall_levered_long') instead of a plain price run.
  const run = (share: number) =>
    position.tradeShape === 'carry'
      ? runStress(queueVenuePosition(position, share), { price }, opts)
      : runStress(position, { price, venue: { capacityMult: share } }, opts)
  const atBufferTarget = run(QUEUE_BUFFER_TARGET_SHARE)
  const bufferDrained = run(0)
  const range =
    atBufferTarget.outcome !== 'not_modelled' && bufferDrained.outcome !== 'not_modelled'
      ? stressRank(bufferDrained) >= stressRank(atBufferTarget)
        ? { mildest: atBufferTarget, severest: bufferDrained }
        : { mildest: bufferDrained, severest: atBufferTarget }
      : null
  return { axis, atBufferTarget, bufferDrained, range }
}

/** The exit-queue row of the grid: one node per price shape (default: the week-1 shapes). */
export function runExitQueueGrid(
  position: StressPosition,
  axis: ExitQueueAxis,
  opts: StressRunOptions & { shapes?: readonly PriceShape[] } = {},
): ExitQueueStress[] {
  return (opts.shapes ?? DEFAULT_PRICE_SHAPES).map((price) =>
    runExitQueueStress(position, price, axis, opts),
  )
}
