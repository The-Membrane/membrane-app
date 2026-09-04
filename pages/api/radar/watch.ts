import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, getAddress, type Address } from 'viem'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { getRadarPayload } from '@/pages/api/_lib/radarReads'

// Carry Radar STRAT WATCHES (owner-approved).
//
//  POST {address, label?} — snapshot the address's CURRENT radar positions (via
//    the shared read path getRadarPayload, so there is no logic drift from the
//    live radar) and UPSERT strat_watches. The snapshot is the entry baseline
//    the POST-EVENT RECAP tells the "entered $X → now $Y" story against.
//  GET — list tracked addresses (address, label, created_at, entry total USD).
//
// The entry snapshot is chain-read at watch time; nothing is modelled.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getWatches(res)
  if (req.method === 'POST') return postWatch(req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}

async function getWatches(res: NextApiResponse) {
  const rows = (
    await db.execute(sql`
      SELECT address, label, entry_positions, created_at
      FROM strat_watches
      ORDER BY created_at DESC`)
  ).rows as Array<Record<string, unknown>>

  const watches = rows.map((r) => {
    const ep = r.entry_positions as Array<{ usd?: number }> | null
    const entryTotalUsd = Array.isArray(ep) ? ep.reduce((s, p) => s + (Number(p.usd) || 0), 0) : null
    return {
      address: r.address as string,
      label: (r.label as string | null) ?? null,
      created_at: new Date(r.created_at as string).toISOString(),
      entry_total_usd: entryTotalUsd,
      entry_venue_count: Array.isArray(ep) ? ep.length : 0,
    }
  })

  res.setHeader('Cache-Control', 'private, max-age=60')
  return res.status(200).json({ watches })
}

async function postWatch(req: NextApiRequest, res: NextApiResponse) {
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body ?? {}
  const addrStr = body?.address
  if (!addrStr || typeof addrStr !== 'string' || !isAddress(addrStr)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = getAddress(addrStr) as Address

  let label: string | null = null
  if (body.label != null) {
    if (typeof body.label !== 'string') return res.status(400).json({ error: 'label must be a string' })
    const trimmed = body.label.trim().slice(0, 120)
    label = trimmed.length > 0 ? trimmed : null
  }

  // Snapshot current positions via the SAME read path the live radar uses.
  const payload = await getRadarPayload(address)
  const entryPositions = JSON.stringify(payload.positions)

  // UPSERT on UNIQUE(address): re-watching refreshes label + entry snapshot +
  // created_at (a re-watch re-anchors the story to now).
  const inserted = (
    await db.execute(sql`
      INSERT INTO strat_watches (address, label, entry_positions, created_at)
      VALUES (${address}, ${label}, ${entryPositions}::jsonb, now())
      ON CONFLICT (address) DO UPDATE
        SET label = EXCLUDED.label,
            entry_positions = EXCLUDED.entry_positions,
            created_at = now()
      RETURNING address, label, created_at`)
  ).rows as Array<Record<string, unknown>>
  const row = inserted[0]

  return res.status(200).json({
    address,
    label: (row?.label as string | null) ?? null,
    watched_since: row ? new Date(row.created_at as string).toISOString() : new Date().toISOString(),
    entry_total_usd: payload.total_usd,
    entry_venue_count: payload.positions.length,
  })
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
