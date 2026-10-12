import type { VenueExitMetrics, WindowMetrics } from './metrics'
import { label, type BlockAnchor, type Label, type VenueKey } from './types'

/**
 * Per-venue exit-time input for Risk Frontier's exit-queue axis (v2 item 1).
 *
 * This file only SHAPES the ledger's output; it does not touch the stress engine
 * (lib/position-sim/stressGrid.ts on feat/risk-frontier-stress-grid). The engine
 * reads `exitTime(input, 'p90')` as "seconds before a position in this venue can be
 * claimable", and must keep its `label` (and `atLeast`) with any number it shows: it is
 * measured history (or, for the beacon queue, the chain's schedule), never a forecast.
 */

export interface ExitTimeInput {
  venue: VenueKey
  anchor: BlockAnchor
  /** Label of `requestToExit`: measured_history (for the beacon, the history of schedule readings). */
  label: Label
  windowDays: number
  coverage: WindowMetrics['coverage']
  /**
   * Request → claimable. For ERC-7540 (no fulfilment event) this is request → claim. For
   * the beacon queue: schedule readings taken in the window + the withdrawability delay, so
   * the unit matches `scheduleFloorS`. `atLeastS`: when a quantile is not reached, the
   * oldest open request's wait (a Kaplan–Meier lower bound on that quantile).
   */
  requestToExit: { p50S: number | null; p90S: number | null; atLeastS: number | null; n: number }
  /** The on-chain advertised wait at the anchor, if the venue has one. */
  advertisedCooldownS: number | null
  /**
   * True when the contract makes a request claimable exactly when the cooldown ends
   * (sUSDe). False when the parameter is only a floor: Kelp's reads 0 while requests wait
   * a median 16.6 days, so it can never stand in for a measurement.
   */
  advertisedSetsWait: boolean
  /** Beacon only: the schedule floor for a new exit plus the withdrawability delay. */
  scheduleFloorS: number | null
  queueDepth: { amount: string | null; count: number | null; symbol: string; decimals: number }
  /**
   * How long the oldest still-open request has waited at the anchor. A current stall that
   * holds fewer than 10% of the cohort does not move the p90, so show this next to it. It
   * is NOT a lower bound on a new request's wait (the head may clear a minute later), so it
   * never enters the single number.
   */
  oldestOpenAgeS: number | null
  lastParamChangeTs: number | null
}

const WITHDRAWABILITY_DELAY_S = 256 * 32 * 12

const plusDelay = (s: number | null) => (s == null ? null : s + WITHDRAWABILITY_DELAY_S)

export function exitTimeInput(m: VenueExitMetrics, windowDays = 30): ExitTimeInput | null {
  if (!m.anchor) return null
  const w = m.windows.find((x) => x.windowDays === windowDays)
  if (!w) return null
  const useClaim = m.venue.startsWith('erc7540:')
  const d = useClaim ? w.requestToClaim : w.requestToFinalize
  const isBeacon = m.venue === 'beacon-exit'
  return {
    venue: m.venue,
    anchor: m.anchor,
    label: label('measured_history'),
    windowDays,
    coverage: w.coverage,
    requestToExit: isBeacon
      ? { p50S: plusDelay(d.p50S), p90S: plusDelay(d.p90S), atLeastS: null, n: d.n }
      : { p50S: d.p50S, p90S: d.p90S, atLeastS: d.atLeastS, n: d.n },
    advertisedCooldownS: m.advertisedCooldownS,
    advertisedSetsWait: m.advertisedCooldownSetsWait,
    scheduleFloorS: isBeacon ? plusDelay(m.scheduleWaitS) : null,
    queueDepth: {
      amount: m.queueNow.amount,
      count: m.queueNow.count,
      symbol: m.unit.symbol,
      decimals: m.unit.decimals,
    },
    oldestOpenAgeS: m.open.oldestAgeS,
    lastParamChangeTs: m.lastChange?.ts ?? null,
  }
}

/**
 * What set the single number:
 *  measured_quantile    the window's request → claimable quantile (beacon: of the schedule
 *                       readings taken in the window, each a floor because the sweep is out)
 *  measured_at_least    the quantile was not reached; the oldest open request's wait
 *  advertised_cooldown  the on-chain cooldown at the anchor
 *  chain_schedule       the beacon chain's assigned exit epochs (+ withdrawability delay)
 */
export type ExitTimeSource =
  | 'measured_quantile'
  | 'measured_at_least'
  | 'advertised_cooldown'
  | 'chain_schedule'

/** The conservative single number, with what it rests on. */
export interface ExitTime {
  venue: VenueKey
  anchor: BlockAnchor
  q: 'p50' | 'p90'
  seconds: number
  source: ExitTimeSource
  /** A lower bound: print it as "≥". The beacon schedule omits the sweep, so it is one. */
  atLeast: boolean
  /** Carry it with the number wherever the number is shown. */
  label: Label
  windowDays: number
  coverage: WindowMetrics['coverage']
  /** Requests in the window behind the measured part (beacon: schedule readings). */
  n: number
}

type Part = { seconds: number; source: ExitTimeSource; atLeast: boolean; label: Label }

const isDuration = (x: number | null) => x == null || (Number.isFinite(x) && x >= 0)

/**
 * The largest of the measured quantile (or its lower bound when not reached), the beacon
 * schedule floor and the advertised cooldown. Null when nothing is known, or when an input
 * is not a duration (a hand-built or corrupted payload): the engine must treat null as
 * "unknown", never as zero. A cooldown that is only a floor raises the number but never
 * stands alone (Kelp's parameter reads 0).
 */
export function exitTime(input: ExitTimeInput, q: 'p50' | 'p90' = 'p90'): ExitTime | null {
  const r = input.requestToExit
  if (
    ![r.p50S, r.p90S, r.atLeastS, input.advertisedCooldownS, input.scheduleFloorS].every(isDuration)
  )
    return null
  const beacon = input.venue === 'beacon-exit'
  const quantile = q === 'p50' ? r.p50S : r.p90S
  const measured: Part | null =
    quantile != null
      ? { seconds: quantile, source: 'measured_quantile', atLeast: beacon, label: input.label }
      : r.atLeastS != null
        ? {
            seconds: r.atLeastS,
            source: 'measured_at_least',
            atLeast: true,
            label: input.label,
          }
        : null
  const schedule: Part | null =
    input.scheduleFloorS != null
      ? {
          seconds: input.scheduleFloorS,
          source: 'chain_schedule',
          atLeast: true,
          label: label('chain_schedule'),
        }
      : null
  const advertised: Part | null =
    input.advertisedCooldownS != null
      ? {
          seconds: input.advertisedCooldownS,
          source: 'advertised_cooldown',
          atLeast: !input.advertisedSetsWait,
          label: label('onchain_state'),
        }
      : null
  if (!measured && !schedule && !(advertised && input.advertisedSetsWait)) return null
  // Ties keep the earlier part: measured history first.
  const best = [measured, schedule, advertised].reduce<Part | null>(
    (a, p) => (p && (!a || p.seconds > a.seconds) ? p : a),
    null,
  )!
  return {
    venue: input.venue,
    anchor: input.anchor,
    q,
    seconds: best.seconds,
    source: best.source,
    atLeast: best.atLeast,
    label: best.label,
    windowDays: input.windowDays,
    coverage: input.coverage,
    n: r.n,
  }
}

/** The single number alone (`exitTime(...).seconds`); null = unknown, never 0. */
export function exitTimeS(input: ExitTimeInput, q: 'p50' | 'p90' = 'p90'): number | null {
  return exitTime(input, q)?.seconds ?? null
}
