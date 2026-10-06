/**
 * exitQueueAxis — the exit-queue axis of Risk Frontier (docs/RISK_FRONTIER_DESIGN.md, v2
 * item 1: "LST exit-queue ledger (Lido first): the exit-queue axis"). It lets a venue's
 * MEASURED withdrawal-queue time drive the stress engine (stressGrid.ts) as a venue freeze:
 * recall asked for at the first breach arrives that long after it.
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
 *     'invalid_input'. An unknown axis builds NO scenario and runs NO stress: the bridge
 *     returns null, never `freezeHours: 0` (which would read as an instant exit).
 *  3. FRESHNESS. The input's anchor must be 'recent' under the ledger's own rule
 *     (lib/exitQueue/feed.ts `observationStatus`: 0 ≤ age ≤ 30 h at `nowMs`), else
 *     'stale'. `nowMs` is a parameter; the clock is never read.
 *  4. A FREEZE, NOT A CAPACITY. The scenario is `{ price, venue: { freezeHours } }` with
 *     freezeHours = seconds / 3600. It sets no capacityMult and does not touch the
 *     position: its exit capacity stays whatever the caller gave (explicit, never assumed;
 *     owner ruling 2026-10-04). One venue condition per scenario: the axis is never
 *     combined with another (RISK_FRONTIER_DESIGN.md: no combined axes).
 *  5. LABEL TRAVELS. `runExitQueueStress` returns { axis, scenario, result }; the result
 *     never leaves without the exit time and its label. `atLeast` (print "≥") is kept.
 *  6. A LOWER BOUND IS TWO RUNS, NOT A POINT. When the exit time is only a lower bound
 *     (p90 not reached, the beacon floor, a floor-only cooldown), the real freeze is anywhere
 *     from the bound to never. The run returns `exitTimeIs: 'lower_bound'`, the run at the
 *     bound, `resultIfNeverPaid` (a freeze that outlasts the horizon) and `range`, the two
 *     ordered by stressRank. Neither end is "best": the outcome is NOT monotone in the freeze
 *     (a late recall that falls short of an ask escalated to the whole loan triggers the
 *     floor close and sells, where no recall lets a wick recover). The two runs bracket the
 *     freeze, not necessarily every outcome in between. A lower bound under 1 s says nothing
 *     about the wait and is 'no_exit_time'.
 *  7. A STALL STAYS VISIBLE. `oldestOpenAgeS` (the oldest open request's wait) travels with
 *     the axis and is named in the provenance when it exceeds the exit time. It never enters
 *     the freeze: it does not bound a new request's wait.
 *
 * MODELLED, NOT MASTER: master recalls synchronously (lib/position-sim/venues.ts, LE:1453).
 * A queue venue cannot pay inside the call, so the freeze is a stand-in for "the request
 * is filed at the first breach and paid after the measured wait"; the whole stock then
 * opens at once (stressGrid's freeze gate). A freeze longer than the horizon never opens.
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
  type StressScenario,
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
  /** exitTime.seconds / 3600, the engine's unit. */
  freezeHours: number
  /** The oldest open request's wait at the anchor (shown, never folded into freezeHours). */
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
    freezeHours: t.seconds / 3600,
    oldestOpenAgeS: oldest,
    anchorAgeHours: (opts.nowMs / 1000 - t.anchor.ts) / 3600,
    stressLabel: STRESS_LABEL,
    provenance: `${name}: ${t.atLeast ? '≥ ' : ''}${fmtHours(t.seconds)}, ${what}, at block ${t.anchor.block}${stall} — ${t.label.text}`,
  }
}

/** The stress scenario for one price shape, or null when the axis is unknown (never a 0 h freeze). */
export function exitQueueScenario(price: PriceShape, axis: ExitQueueAxis): StressScenario | null {
  if (axis.status !== 'measured') return null
  return { price, venue: { freezeHours: axis.freezeHours } }
}

export interface ExitQueueStress {
  /** Carries the exit time and its label (or why it is unknown). */
  axis: ExitQueueAxis
  scenario: StressScenario | null
  /** Null when the axis is unknown: nothing was run. */
  result: StressResult | null
  /** 'lower_bound': `result` is the run AT the bound; show it with `resultIfNeverPaid`. Null if unknown. */
  exitTimeIs: 'estimate' | 'lower_bound' | null
  /**
   * Lower bound only: the same shock with a freeze that outlasts the horizon (recall never
   * arrives). Null otherwise, or when that run is not modelled.
   */
  resultIfNeverPaid: StressResult | null
  /** Lower bound only: the two runs ordered by stressRank (neither is "best"). */
  range: { mildest: StressResult; severest: StressResult } | null
}

/** Run one price shape with the venue's measured exit time as the freeze. */
export function runExitQueueStress(
  position: StressPosition,
  price: PriceShape,
  axis: ExitQueueAxis,
  opts: StressRunOptions = {},
): ExitQueueStress {
  const scenario = exitQueueScenario(price, axis)
  if (!scenario || axis.status !== 'measured') {
    return { axis, scenario, result: null, exitTimeIs: null, resultIfNeverPaid: null, range: null }
  }
  const result = runStress(position, scenario, opts)
  if (!axis.exitTime.atLeast) {
    return { axis, scenario, result, exitTimeIs: 'estimate', resultIfNeverPaid: null, range: null }
  }
  // A freeze one hour past the horizon never opens: recall never arrives in the run.
  const run =
    result.outcome === 'not_modelled'
      ? null
      : runStress(
          position,
          { price, venue: { freezeHours: result.horizonSeconds / 3600 + 1 } },
          opts,
        )
  const neverPaid = run && run.outcome !== 'not_modelled' ? run : null
  const range =
    neverPaid && result.outcome !== 'not_modelled'
      ? stressRank(neverPaid) >= stressRank(result)
        ? { mildest: result, severest: neverPaid }
        : { mildest: neverPaid, severest: result }
      : null
  return { axis, scenario, result, exitTimeIs: 'lower_bound', resultIfNeverPaid: neverPaid, range }
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
