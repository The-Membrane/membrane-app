import { sql } from 'drizzle-orm'

import { db } from '@/db'

// Shared venue state-change log query — the "news tracker". Two provenances,
// both labeled and BOTH derived here so /api/venues/log (the public feed) and
// /api/radar/recap (venue events during a hold window) read them IDENTICALLY:
//  - 'observed'      → venue_events rows written live by the hourly recorder.
//  - 'reconstructed' → discrete-param changes DERIVED at read time from
//    backfilled archive snapshots (only cooldownDuration today).
// See pages/api/venues/log.ts's header for the full provenance rationale.

export type VenueLogEntry = {
  venue: string
  kind: string
  /** ISO timestamp of the change (observed) or of the snapshot that first shows it (reconstructed). */
  at: string
  prev: Record<string, unknown> | null
  next: Record<string, unknown> | null
  provenance: 'observed' | 'reconstructed' | 'alarm'
  /** Only for provenance 'alarm': 'watch' | 'alarm', and whether the alarm has been cleared. */
  severity?: 'watch' | 'alarm'
  evidence?: Record<string, unknown> | null
  cleared?: boolean
}

export type VenueLogFilter = {
  /** Only entries at/after this ISO instant (inclusive). */
  sinceISO?: string
  /** Only entries at/before this ISO instant (inclusive). */
  untilISO?: string
  /** Restrict to a single venue (config name). */
  venue?: string
  limit?: number
}

/**
 * Read venue state-change entries (observed + reconstructed), newest first,
 * optionally bounded to a [sinceISO, untilISO] window and/or a single venue.
 */
export async function fetchVenueLogEntries(filter: VenueLogFilter = {}): Promise<VenueLogEntry[]> {
  const { sinceISO, untilISO, venue, limit = 50 } = filter

  const observed = await db.execute(sql`
    SELECT venue, kind, observed_at AS at, prev, next
    FROM venue_events
    WHERE TRUE
      ${sinceISO ? sql`AND observed_at >= ${sinceISO}` : sql``}
      ${untilISO ? sql`AND observed_at <= ${untilISO}` : sql``}
      ${venue ? sql`AND venue = ${venue}` : sql``}
    ORDER BY observed_at DESC
    LIMIT ${limit}`)

  // Discrete-param transitions reconstructed from snapshot history. Only
  // cooldownDuration today. LAG over observed+backfilled rows ordered by chain
  // time; the window bound is applied AFTER the LAG so a transition whose prev
  // snapshot sits just before `sinceISO` is still detected at its own instant.
  const reconstructed = await db.execute(sql`
    WITH ordered AS (
      SELECT venue, observed_at, source,
             (params ->> 'cooldownDuration')::bigint AS cd,
             LAG((params ->> 'cooldownDuration')::bigint)
               OVER (PARTITION BY venue ORDER BY observed_at) AS prev_cd
      FROM venue_snapshots
      WHERE params ? 'cooldownDuration'
        ${venue ? sql`AND venue = ${venue}` : sql``}
    )
    SELECT venue, observed_at AS at, prev_cd, cd
    FROM ordered
    WHERE prev_cd IS NOT NULL AND cd IS DISTINCT FROM prev_cd
      AND source = 'backfilled'
      ${sinceISO ? sql`AND observed_at >= ${sinceISO}` : sql``}
      ${untilISO ? sql`AND observed_at <= ${untilISO}` : sql``}
    ORDER BY observed_at DESC
    LIMIT ${limit}`)

  // Venue failure-pattern ALARMS (scripts/check-venue-alarms.mjs). Every OPEN
  // alarm (cleared_at IS NULL) is surfaced as an entry; recently-cleared alarms
  // are shown too, capped at 10, so the log reads as a live danger feed rather
  // than a silent one. Bounded to a single venue when requested, but NOT to the
  // [since, until] window — an open alarm is current regardless of when it fired.
  const openAlarms = await db.execute(sql`
    SELECT venue, kind, severity, evidence, fired_at AS at, false AS cleared
    FROM venue_alarms
    WHERE cleared_at IS NULL
      ${venue ? sql`AND venue = ${venue}` : sql``}
    ORDER BY fired_at DESC
    LIMIT ${limit}`)

  const clearedAlarms = await db.execute(sql`
    SELECT venue, kind, severity, evidence, cleared_at AS at, true AS cleared
    FROM venue_alarms
    WHERE cleared_at IS NOT NULL
      ${venue ? sql`AND venue = ${venue}` : sql``}
    ORDER BY cleared_at DESC
    LIMIT 10`)

  const mapAlarm = (r: any): VenueLogEntry => ({
    venue: r.venue as string,
    kind: r.kind as string,
    at: new Date(r.at as string).toISOString(),
    prev: null,
    next: (r.evidence as Record<string, unknown>) ?? null,
    provenance: 'alarm' as const,
    severity: r.severity as 'watch' | 'alarm',
    evidence: (r.evidence as Record<string, unknown>) ?? null,
    cleared: !!r.cleared,
  })

  return [
    ...(observed.rows as any[]).map((r) => ({
      venue: r.venue as string,
      kind: r.kind as string,
      at: new Date(r.at as string).toISOString(),
      prev: r.prev ?? null,
      next: r.next ?? null,
      provenance: 'observed' as const,
    })),
    ...(reconstructed.rows as any[]).map((r) => ({
      venue: r.venue as string,
      kind: 'cooldown_duration_changed',
      at: new Date(r.at as string).toISOString(),
      prev: { cooldownDuration: Number(r.prev_cd) },
      next: { cooldownDuration: Number(r.cd) },
      provenance: 'reconstructed' as const,
    })),
    ...(openAlarms.rows as any[]).map(mapAlarm),
    ...(clearedAlarms.rows as any[]).map(mapAlarm),
  ].sort((a, b) => (a.at < b.at ? 1 : -1))
}
