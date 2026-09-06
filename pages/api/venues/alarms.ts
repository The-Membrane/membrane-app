import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

// PUBLIC. The VENUE FAILURE-PATTERN ALARM feed. Three parts:
//   open      — currently-open alarms (cleared_at IS NULL), newest first.
//   cleared   — recently-cleared alarms, capped at 10 (history / audit trail).
//   uncovered — per venue, the memo signals the alarm system CANNOT evaluate yet
//               (docs/research/worst-carry-venues.md §3). Silence is NOT
//               all-clear; this list makes the blind spots explicit for any
//               surface that reads the feed.
// Written by scripts/check-venue-alarms.mjs (corpus-only, no chain reads). The
// alarm ROWS are also unioned into /api/venues/log via venueLogQuery; this route
// exists so future surfaces get the structured open/cleared/uncovered split.

type AlarmRow = {
  venue: string
  kind: string
  severity: 'watch' | 'alarm'
  evidence: Record<string, unknown> | null
  firedAt: string
  clearedAt: string | null
}

type UncoveredSignal = { id: string; label: string; memo: string }

// Mirror of scripts/lib/alarmRules.mjs UNCOVERED_SIGNALS / uncoveredFor() — kept
// in TS here so this route stays tsc-clean (no .mjs type import). Keep in lockstep.
const UNCOVERED_SIGNALS: UncoveredSignal[] = [
  { id: 'depth_vs_book', label: 'depth-vs-book', memo: 'P4 — needs the oracle-market depth extension' },
  { id: 'yield_flatness', label: 'yield flatness', memo: 'P7 — we do not record APY' },
  { id: 'terms_page_changes', label: 'terms changes', memo: 'needs the terms-page hash watcher' },
]
function uncoveredFor(hasInstant: boolean): UncoveredSignal[] {
  const list = [...UNCOVERED_SIGNALS]
  if (!hasInstant) {
    list.push({
      id: 'headroom_instant_liquidity',
      label: 'instant-exit headroom',
      memo: 'no instant_usd read for this venue kind',
    })
  }
  return list
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const openRes = await db.execute(sql`
    SELECT venue, kind, severity, evidence, fired_at AS "firedAt", cleared_at AS "clearedAt"
    FROM venue_alarms WHERE cleared_at IS NULL
    ORDER BY fired_at DESC`)

  const clearedRes = await db.execute(sql`
    SELECT venue, kind, severity, evidence, fired_at AS "firedAt", cleared_at AS "clearedAt"
    FROM venue_alarms WHERE cleared_at IS NOT NULL
    ORDER BY cleared_at DESC LIMIT 10`)

  // Latest observed snapshot per venue → hasInstant → per-venue uncovered list.
  const latestRes = await db.execute(sql`
    SELECT DISTINCT ON (venue) venue, instant_usd
    FROM venue_snapshots WHERE source = 'observed'
    ORDER BY venue, observed_at DESC`)

  const uncovered = (latestRes.rows as any[]).map((r) => ({
    venue: r.venue as string,
    signals: uncoveredFor(r.instant_usd !== null && r.instant_usd !== undefined),
  }))

  const norm = (r: any): AlarmRow => ({
    venue: r.venue,
    kind: r.kind,
    severity: r.severity,
    evidence: r.evidence ?? null,
    firedAt: new Date(r.firedAt).toISOString(),
    clearedAt: r.clearedAt ? new Date(r.clearedAt).toISOString() : null,
  })

  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
  return res.status(200).json({
    open: (openRes.rows as any[]).map(norm),
    cleared: (clearedRes.rows as any[]).map(norm),
    uncovered,
  })
}
