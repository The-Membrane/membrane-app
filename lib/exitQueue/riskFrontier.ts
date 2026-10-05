import type { VenueExitMetrics, WindowMetrics } from './metrics'
import type { BlockAnchor, LabelClass, VenueKey } from './types'

/**
 * Per-venue exit-time input for Risk Frontier's exit-queue axis (v2 item 1).
 *
 * This file only SHAPES the ledger's output; it does not touch the stress engine
 * (lib/position-sim/stressGrid.ts on feat/risk-frontier-stress-grid). The engine
 * can read `exitTimeS(input, 'p90')` as "seconds before a position in this venue
 * can be claimable", and must keep `label` with any number it shows: it is measured
 * history (or, for the beacon queue, the chain's schedule), never a forecast.
 */

export interface ExitTimeInput {
  venue: VenueKey
  anchor: BlockAnchor
  label: LabelClass
  windowDays: number
  coverage: WindowMetrics['coverage']
  /** Request → claimable. For ERC-7540 (no fulfilment event) this is request → claim. */
  requestToExit: { p50S: number | null; p90S: number | null; atLeastS: number | null; n: number }
  /** The on-chain advertised wait at the anchor, if the venue has one. */
  advertisedCooldownS: number | null
  /** Beacon only: the schedule floor for a new exit plus the withdrawability delay. */
  scheduleFloorS: number | null
  queueDepth: { amount: string | null; count: number | null; symbol: string; decimals: number }
  lastParamChangeTs: number | null
}

const WITHDRAWABILITY_DELAY_S = 256 * 32 * 12

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
    label: isBeacon ? 'chain_schedule' : 'measured_history',
    windowDays,
    coverage: w.coverage,
    requestToExit: { p50S: d.p50S, p90S: d.p90S, atLeastS: d.atLeastS, n: d.n },
    advertisedCooldownS: m.advertisedCooldownS,
    scheduleFloorS:
      isBeacon && m.scheduleWaitS != null ? m.scheduleWaitS + WITHDRAWABILITY_DELAY_S : null,
    queueDepth: {
      amount: m.queueNow.amount,
      count: m.queueNow.count,
      symbol: m.unit.symbol,
      decimals: m.unit.decimals,
    },
    lastParamChangeTs: m.lastChange?.ts ?? null,
  }
}

/**
 * A conservative single number: the largest of the advertised cooldown, the beacon
 * schedule floor, and the measured quantile (or its lower bound when the quantile
 * was not reached because too many requests are still open). Null when nothing is
 * known — the engine must treat null as "unknown", not as zero.
 */
export function exitTimeS(input: ExitTimeInput, q: 'p50' | 'p90' = 'p90'): number | null {
  const measured =
    (q === 'p50' ? input.requestToExit.p50S : input.requestToExit.p90S) ??
    input.requestToExit.atLeastS
  const parts = [input.advertisedCooldownS, input.scheduleFloorS, measured].filter(
    (x): x is number => x != null,
  )
  return parts.length ? Math.max(...parts) : null
}
