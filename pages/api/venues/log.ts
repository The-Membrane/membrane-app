import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

// PUBLIC. The venue state-change log ("news tracker") — consequences, never
// headlines. Two provenances, both labeled:
//  - 'observed'      → venue_events rows written live by the hourly recorder
//    (discrete param changes + >20% liquidity shifts; drift is filtered at
//    the source, scripts/record-venue-liquidity.mjs).
//  - 'reconstructed' → discrete-param changes DERIVED at read time from
//    backfilled archive snapshots (e.g. Ethena's cooldown cut). These are
//    real on-chain state transitions, but the recorder wasn't running when
//    they happened, so they are never written into venue_events — the events
//    table stays a log of what the recorder itself witnessed.
// Cached: s-maxage 300 (the audit's no-live-requery rule — UI reads cache).

export type VenueLogEntry = {
  venue: string
  kind: string
  /** ISO timestamp of the change (observed) or of the snapshot that first shows it (reconstructed). */
  at: string
  prev: Record<string, unknown> | null
  next: Record<string, unknown> | null
  provenance: 'observed' | 'reconstructed'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const observed = await db.execute(sql`
    SELECT venue, kind, observed_at AS at, prev, next
    FROM venue_events
    ORDER BY observed_at DESC
    LIMIT 50`)

  // Discrete-param transitions reconstructed from snapshot history. Only
  // cooldownDuration today — the one discrete field the archive backfill
  // covers. LAG over observed+backfilled rows ordered by chain time.
  const reconstructed = await db.execute(sql`
    WITH ordered AS (
      SELECT venue, observed_at, source,
             (params ->> 'cooldownDuration')::bigint AS cd,
             LAG((params ->> 'cooldownDuration')::bigint)
               OVER (PARTITION BY venue ORDER BY observed_at) AS prev_cd
      FROM venue_snapshots
      WHERE params ? 'cooldownDuration'
    )
    SELECT venue, observed_at AS at, prev_cd, cd
    FROM ordered
    WHERE prev_cd IS NOT NULL AND cd IS DISTINCT FROM prev_cd
      AND source = 'backfilled'
    ORDER BY observed_at DESC
    LIMIT 50`)

  const entries: VenueLogEntry[] = [
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
  ].sort((a, b) => (a.at < b.at ? 1 : -1))

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return res.status(200).json({ entries })
}
