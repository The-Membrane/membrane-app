import type { NextApiRequest, NextApiResponse } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'

import { sql } from 'drizzle-orm'

import {
  explainCapacityMove,
  validatedTransactionEvidence,
  type DriverEvent,
  type DriverSnapshot,
  type VenueDriverConfig,
} from '@/components/Venue/capacityDriverLogic'
import { db } from '@/db'

type VenueFile = { venues: Array<VenueDriverConfig & { enabled: boolean }> }

function loadVenue(venue: string): VenueDriverConfig | null {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8'),
  ) as VenueFile
  return config.venues.find((entry) => entry.name === venue && entry.enabled) ?? null
}

const snapshot = (row: Record<string, unknown>): DriverSnapshot => ({
  id: String(row.id),
  block: Number(row.block),
  observedAt: new Date(row.observed_at as string).toISOString(),
  instantUsd: row.instant_usd == null ? null : String(row.instant_usd),
  params: (row.params ?? {}) as Record<string, unknown>,
})

// One event + its exact preceding observed snapshot. A significant recorder
// event is a *window*, not a transaction: upstream cause requires another
// evidence lane and cannot be inferred from this inventory decomposition.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const raw = req.query.venue
  const venue = Array.isArray(raw) ? raw[0] : raw
  const config = venue ? loadVenue(venue) : null
  if (!venue || !config) return res.status(404).json({ error: 'unknown venue' })

  const isAave = config.kind === 'atoken-liquidity'
  const metric = isAave ? 'instant_usd' : 'depth_usd'
  const eventKind = isAave ? 'instant_liquidity_shift' : 'param_changed'
  const eventRows = await db.execute(sql`
    SELECT e.id AS event_id, e.kind, e.prev, e.next,
           s.id, s.block, s.observed_at, s.instant_usd, s.params
    FROM venue_events e
    JOIN venue_snapshots s ON s.id = e.snapshot_id
    WHERE e.venue = ${venue} AND e.kind = ${eventKind}
      AND s.venue = ${venue} AND s.source = 'observed'
      AND e.prev ->> ${metric} IS NOT NULL
      AND e.next ->> ${metric} IS NOT NULL
    ORDER BY e.observed_at DESC, e.id DESC
    LIMIT 1`)
  const currentRow = eventRows.rows[0] as Record<string, unknown> | undefined
  if (!currentRow) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(explainCapacityMove(config, null, null, null))
  }

  const current = snapshot(currentRow)
  const previousRows = await db.execute(sql`
    SELECT id, block, observed_at, instant_usd, params
    FROM venue_snapshots
    WHERE venue = ${venue} AND source = 'observed'
      AND observed_at < ${current.observedAt}::timestamptz
    ORDER BY observed_at DESC, id DESC
    LIMIT 1`)
  const previousRow = previousRows.rows[0] as Record<string, unknown> | undefined
  const event: DriverEvent = {
    id: String(currentRow.event_id),
    kind: String(currentRow.kind),
    prev: (currentRow.prev ?? null) as DriverEvent['prev'],
    next: (currentRow.next ?? null) as DriverEvent['next'],
  }
  const result = explainCapacityMove(
    config,
    event,
    previousRow ? snapshot(previousRow) : null,
    current,
  )
  let transactionEvidence = null
  if (result.status === 'available') {
    try {
      const driverRows = await db.execute(sql`
        SELECT event_id, venue, status, evidence
        FROM venue_event_drivers
        WHERE event_id = ${result.eventId}::uuid AND venue = ${venue}
        LIMIT 1`)
      transactionEvidence = validatedTransactionEvidence(result, venue, driverRows.rows[0] ?? null)
    } catch {
      // The additive table may not exist yet (or its read may fail). In either
      // case, retain only the independently reconciled component breakdown.
      transactionEvidence = null
    }
  }
  res.setHeader('Cache-Control', 'no-store')
  return res
    .status(200)
    .json(result.status === 'available' ? { ...result, transactionEvidence } : result)
}
