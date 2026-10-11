/**
 * Venue exit capacity, as the exit-capacity rule consumes it.
 *
 * The measured-capacity model lives on another branch
 * (lib/position-sim/measuredCapacity.ts on feat/risk-frontier-stress-grid) and is not on
 * this base. This file fixes the narrow interface the rule needs so that module can be
 * adapted in one place: anything that can answer "how many USD could leave venue V now,
 * measured when" is a CapacitySource. Until it is wired the rule reports itself
 * UNCOVERED — it never reads a missing reading as zero capacity or as plenty.
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
