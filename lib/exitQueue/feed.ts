import { venueMetrics, type VenueExitMetrics } from './metrics'
import { exitTimeInput, type ExitTimeInput } from './riskFrontier'
import { LABEL_TEXT, type VenueLedger } from './types'
import type { VenueDef } from './venues'

/**
 * The /api/venues/exit-queues payload, built from already-loaded ledgers. Pure (no
 * fs), so the card can import the type and the tests can build a feed in memory.
 */

export type ExitQueueFeed = {
  status: 'ok' | 'no_local_ledger'
  observationStatus: 'recent' | 'paused' | null
  labels: typeof LABEL_TEXT
  venues: VenueExitMetrics[]
  /** Risk Frontier exit-time inputs (30-day window), one per venue with data. */
  riskFrontier: ExitTimeInput[]
}

const MAX_ANCHOR_AGE_S = 30 * 60 * 60

export function observationStatus(
  anchorTs: number | null,
  nowMs = Date.now(),
): 'recent' | 'paused' | null {
  if (anchorTs == null) return null
  const age = nowMs / 1000 - anchorTs
  return age >= 0 && age <= MAX_ANCHOR_AGE_S ? 'recent' : 'paused'
}

export function buildExitQueueFeed(
  entries: Array<{ def: VenueDef; ledger: VenueLedger }>,
  nowMs = Date.now(),
): ExitQueueFeed {
  const venues = [...entries]
    .sort((a, b) => a.def.priority - b.def.priority)
    .map(({ def, ledger }) => venueMetrics(def, ledger))
  const anchors = venues.map((v) => v.anchor?.ts).filter((t): t is number => t != null)
  return {
    status: anchors.length ? 'ok' : 'no_local_ledger',
    // The OLDEST venue anchor decides: one stale venue makes the whole card historical.
    observationStatus: observationStatus(anchors.length ? Math.min(...anchors) : null, nowMs),
    labels: LABEL_TEXT,
    venues,
    riskFrontier: venues.map((v) => exitTimeInput(v)).filter((x): x is ExitTimeInput => x != null),
  }
}
