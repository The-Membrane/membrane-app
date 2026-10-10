import { sql } from 'drizzle-orm'
import { isIP } from 'node:net'

import { db } from '@/db'
import { isUnreadDepthAlarm, scrubUnreadDepthEvent } from '@/components/Radar/alertLogic'

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
  /** ISO time of the previous observed snapshot — the start of the window `prev → next`
   *  was measured over. Observed entries only. */
  since?: string | null
  provenance: 'observed' | 'reconstructed' | 'alarm'
  /** Only for provenance 'alarm': 'watch' | 'alarm', and whether the alarm has been cleared. */
  severity?: 'watch' | 'alarm' | 'notice'
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

// Older terms events may have been persisted before the watcher redacted its
// public JSON. Keep only known fields here so a legacy URL (or freeform note)
// cannot escape through the public venue log or Radar recap.
function publicTermsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    // Removing these pieces could point at a different document. Withhold the
    // link instead of presenting it as the page that was actually observed.
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
    const hostname = parsed.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '')
    if (
      isIP(hostname) ||
      !hostname.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|onion|arpa)$/i.test(hostname) ||
      !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
    )
      return null
    return parsed.toString()
  } catch {
    return null
  }
}

function safeTermsSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  if (
    typeof source.content_hash === 'string' &&
    /^(?:v\d+:)?[a-f0-9]{64}$/i.test(source.content_hash)
  )
    safe.content_hash = source.content_hash
  if (
    typeof source.content_len === 'number' &&
    Number.isSafeInteger(source.content_len) &&
    source.content_len >= 0
  )
    safe.content_len = source.content_len
  for (const key of ['source_url', 'final_url'] as const) {
    const url = publicTermsUrl(source[key])
    if (url) safe[key] = url
  }
  return safe
}

export function scrubLegacyTermsPageEvent(entry: VenueLogEntry): VenueLogEntry {
  if (entry.kind !== 'terms_page_changed' || entry.provenance !== 'observed') return entry
  return {
    ...entry,
    prev: safeTermsSnapshot(entry.prev),
    next: safeTermsSnapshot(entry.next),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function containsTermsEvent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTermsEvent)
  if (!isRecord(value)) return false
  if (value.kind === 'terms_page_changed') return true
  return Object.values(value).some(containsTermsEvent)
}

function scrubAlarmData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubAlarmData)
  if (!isRecord(value)) return value
  if (value.kind === 'terms_page_changed') {
    const event: Record<string, unknown> = { kind: 'terms_page_changed' }
    if (typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at))) event.at = value.at
    event.prev = safeTermsSnapshot(value.prev)
    event.next = safeTermsSnapshot(value.next)
    return event
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      // Legacy evidence could copy an event's freeform note or URL alongside
      // measured data. Notes cannot be reliably redacted, so omit them.
      if (key === 'note') return []
      if (/url$/i.test(key)) {
        const safe = publicTermsUrl(child)
        return safe ? [[key, safe]] : []
      }
      return [[key, scrubAlarmData(child)]]
    }),
  )
}

export function scrubTermsAlarmEvidence(
  kind: string,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  if (kind !== 'terms_page_notice' && !containsTermsEvent(value)) return value
  const safe: Record<string, unknown> = {}
  if (typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0)
    safe.count = value.count
  if (isRecord(value.latest)) safe.latest = scrubAlarmData(value.latest)
  if (Array.isArray(value.events)) safe.events = value.events.map(scrubAlarmData)
  const sourceUrl = publicTermsUrl(value.sourceUrl)
  if (sourceUrl) safe.sourceUrl = sourceUrl
  for (const key of ['sourceUrlStatus', 'migrationStatus', 'exitImpact'] as const) {
    if (typeof value[key] === 'string' && /^[a-z_]+$/.test(value[key])) safe[key] = value[key]
  }
  if (typeof value.firstObservedAt === 'string' && !Number.isNaN(Date.parse(value.firstObservedAt)))
    safe.firstObservedAt = value.firstObservedAt
  return safe
}

/**
 * Read venue state-change entries (observed + reconstructed), newest first,
 * optionally bounded to a [sinceISO, untilISO] window and/or a single venue.
 */
export async function fetchVenueLogEntries(filter: VenueLogFilter = {}): Promise<VenueLogEntry[]> {
  const { sinceISO, untilISO, venue, limit = 50 } = filter

  const observed = await db.execute(sql`
    SELECT e.venue, e.kind, e.observed_at AS at, e.prev, e.next,
      -- the window: this change was measured against the venue's PREVIOUS observed
      -- snapshot, so "since" is that snapshot's time. A delta with no window is noise.
      -- The event is stamped seconds AFTER the tick's own snapshot, so "before the event"
      -- must exclude that snapshot: key off snapshot_id when the recorder set it, else
      -- step back a minute (ticks are hourly; the terms watcher sets no snapshot_id).
      (SELECT max(s.observed_at) FROM venue_snapshots s
        WHERE s.venue = e.venue AND s.source = 'observed'
          AND s.observed_at < COALESCE(
            (SELECT own.observed_at FROM venue_snapshots own WHERE own.id = e.snapshot_id),
            e.observed_at - interval '1 minute')) AS since
    FROM venue_events e
    WHERE TRUE
      ${sinceISO ? sql`AND e.observed_at >= ${sinceISO}` : sql``}
      ${untilISO ? sql`AND e.observed_at <= ${untilISO}` : sql``}
      ${venue ? sql`AND e.venue = ${venue}` : sql``}
    ORDER BY e.observed_at DESC
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

  const mapAlarm = (r: any): VenueLogEntry => {
    const evidence = scrubTermsAlarmEvidence(r.kind as string, r.evidence)
    return {
      venue: r.venue as string,
      kind: r.kind as string,
      at: new Date(r.at as string).toISOString(),
      prev: null,
      next: evidence,
      provenance: 'alarm' as const,
      severity: r.severity as 'watch' | 'alarm' | 'notice',
      evidence,
      cleared: !!r.cleared,
    }
  }

  return [
    // Pre-guard unread depth zeros are dropped at read time (alertLogic.ts
    // DEPTH_GUARD_LIVE): they are failed reads, not drains, in insert-only history.
    ...(observed.rows as any[])
      .map((r) =>
        scrubUnreadDepthEvent(
          scrubLegacyTermsPageEvent({
            venue: r.venue as string,
            kind: r.kind as string,
            at: new Date(r.at as string).toISOString(),
            prev: r.prev ?? null,
            next: r.next ?? null,
            since: r.since ? new Date(r.since as string).toISOString() : null,
            provenance: 'observed' as const,
          }),
        ),
      )
      .filter((e): e is NonNullable<typeof e> => e !== null),
    ...(reconstructed.rows as any[]).map((r) => ({
      venue: r.venue as string,
      kind: 'cooldown_duration_changed',
      at: new Date(r.at as string).toISOString(),
      prev: { cooldownDuration: Number(r.prev_cd) },
      next: { cooldownDuration: Number(r.cd) },
      provenance: 'reconstructed' as const,
    })),
    ...(openAlarms.rows as any[]).map(mapAlarm).filter((a) => !isUnreadDepthAlarm(a)),
    ...(clearedAlarms.rows as any[]).map(mapAlarm).filter((a) => !isUnreadDepthAlarm(a)),
  ].sort((a, b) => (a.at < b.at ? 1 : -1))
}
