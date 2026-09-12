import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, getAddress } from 'viem'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

// Position-simulator READ LOG — the launch instrument.
//
// The conversion question is "do addresses that ran the sim come back?", and
// nothing else answers it: impressions and page views say nothing about
// retention. This records every real-address read (never the worked example),
// keyed on the address the visitor pasted.
//
//  POST {address, protocols?: string[]} — UPSERT sim_reads: first_seen is kept,
//    last_seen moves, read_count increments, protocols (the ones that held a
//    position on this read) are overwritten with the latest.
//  GET — the funnel numbers: addresses, with_positions, returned (read again
//    ≥1 hour after the first read — a reload is not a return).
//
// Address only. No IP, no user agent, no cookie. The AddressBar copy discloses it.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getSummary(res)
  if (req.method === 'POST') return postRead(req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}

async function getSummary(res: NextApiResponse) {
  const rows = (
    await db.execute(sql`
      SELECT
        count(*)::int AS addresses,
        count(*) FILTER (WHERE jsonb_array_length(protocols) > 0)::int AS with_positions,
        count(*) FILTER (WHERE read_count > 1 AND last_seen > first_seen + interval '1 hour')::int AS returned,
        max(last_seen) AS last_read_at
      FROM sim_reads`)
  ).rows as Array<Record<string, unknown>>
  const r = rows[0] ?? {}
  res.setHeader('Cache-Control', 'private, max-age=60')
  return res.status(200).json({
    addresses: Number(r.addresses ?? 0),
    with_positions: Number(r.with_positions ?? 0),
    returned: Number(r.returned ?? 0),
    last_read_at: r.last_read_at ? new Date(r.last_read_at as string).toISOString() : null,
  })
}

async function postRead(req: NextApiRequest, res: NextApiResponse) {
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body ?? {}
  const addrStr = body?.address
  if (!addrStr || typeof addrStr !== 'string' || !isAddress(addrStr)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const address = getAddress(addrStr)

  const protocols: string[] = Array.isArray(body.protocols)
    ? body.protocols.filter((p: unknown) => typeof p === 'string').map((p: string) => p.slice(0, 40)).slice(0, 16)
    : []
  const protocolsJson = JSON.stringify(protocols)

  const rows = (
    await db.execute(sql`
      INSERT INTO sim_reads (address, protocols, first_seen, last_seen, read_count)
      VALUES (${address}, ${protocolsJson}::jsonb, now(), now(), 1)
      ON CONFLICT (address) DO UPDATE
        SET last_seen = now(),
            read_count = sim_reads.read_count + 1,
            protocols = EXCLUDED.protocols
      RETURNING read_count, first_seen`)
  ).rows as Array<Record<string, unknown>>
  const row = rows[0]

  return res.status(200).json({
    address,
    read_count: Number(row?.read_count ?? 1),
    first_seen: row ? new Date(row.first_seen as string).toISOString() : null,
  })
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
