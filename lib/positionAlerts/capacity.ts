/**
 * Venue exit capacity, as the exit-capacity rule consumes it.
 *
 * Anything that can answer "how many USD could leave venue V now, measured when" is a
 * CapacitySource. venueStressCapacity adapts the hourly venue-stress history (the archive
 * series behind lib/position-sim/measuredCapacity.ts on feat/risk-frontier-stress-grid,
 * schema venue-stress-history/v1); its shape is copied structurally, not imported. With no
 * reading the rule reports itself UNCOVERED — it never reads a missing reading as zero
 * capacity or as plenty.
 */

import type { CapacityReading } from './types'

export interface CapacitySource {
  /** Latest reading for a venue, or null when there is none. */
  latest(venue: string): CapacityReading | null
}

export const UNWIRED_CAPACITY_SOURCE: CapacitySource = { latest: () => null }

/** A fixed set of readings, keyed by venue — for tests and back-test replays. */
export function staticCapacitySource(readings: CapacityReading[]): CapacitySource {
  const byVenue = new Map(readings.map((r) => [r.venue, r]))
  return { latest: (v) => byVenue.get(v) ?? null }
}

/** Readings for `venues` no older than maxAgeS at `now`. Stale readings are dropped, not trusted. */
export function freshReadings(
  src: CapacitySource,
  venues: string[],
  now: number,
  maxAgeS: number,
): CapacityReading[] {
  return venues
    .map((v) => src.latest(v))
    .filter(
      (r): r is CapacityReading =>
        r !== null && Number.isFinite(r.availableUsd) && now - r.asOf <= maxAgeS,
    )
}

/**
 * Sum of available USD across venues. Valid only for INDEPENDENT venues — one exit must
 * not consume the other's liquidity (same rule as lib/venueCapacity/capacityCurve.ts).
 */
export const totalAvailableUsd = (readings: CapacityReading[]): number =>
  readings.reduce((a, r) => a + Math.max(0, r.availableUsd), 0)

// ------------------------------------------------------------------ venue-stress history

/** The parts of a venue-stress-history/v1 file this adapter reads. */
export interface VenueStressHistoryLike {
  schema: string
  /** Target hour of each column (unix s). */
  timeline: { t: number[] }
  /** Per venue: withdrawable cash in token units and status flags, one value per column. */
  venues: Record<string, { cash: (number | null)[]; flags?: (number | null)[] }>
}

/** venue-stress flags bit 2: withdrawals PAUSED. */
export const VENUE_STRESS_PAUSED = 4

export interface TimedCapacitySource {
  /** Last reading for a venue at or before ts, or null. */
  readingAt(venue: string, ts: number): CapacityReading | null
}

/**
 * Hourly exit capacity from a venue-stress history. Cash is in token units, so each venue
 * needs a USD price per token (1 for USDC). A paused venue reads 0: nothing can leave.
 */
export function venueStressCapacity(
  history: VenueStressHistoryLike,
  usdPerToken: Record<string, number>,
  provenance = 'venue-stress-history',
): TimedCapacitySource {
  if (!history.schema.startsWith('venue-stress-history/'))
    throw new Error(`venueStressCapacity: unexpected schema ${history.schema}`)
  const t = history.timeline.t
  return {
    readingAt(venue, ts) {
      const v = history.venues[venue]
      const px = usdPerToken[venue]
      if (!v || !(px > 0) || !t.length || ts < t[0]) return null
      let lo = 0
      let hi = t.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (t[mid] <= ts) lo = mid
        else hi = mid - 1
      }
      // Walk back over unread hours: the last read value stands, with its own timestamp.
      for (let i = lo; i >= 0; i--) {
        const cash = v.cash[i]
        if (cash === null || cash === undefined || !Number.isFinite(cash)) continue
        const paused = ((v.flags?.[i] ?? 0) & VENUE_STRESS_PAUSED) !== 0
        return { venue, availableUsd: paused ? 0 : cash * px, asOf: t[i], provenance }
      }
      return null
    },
  }
}
