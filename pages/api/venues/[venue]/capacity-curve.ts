import type { NextApiRequest, NextApiResponse } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { combineMarkets, type CapacityCurveResponse, type CurvePoint } from '@/lib/venueCapacity/capacityCurve'

// PUBLIC. The venue's latest SLIPPAGE-BOUNDED exit capacity curve: what exits
// within each cost level incl. fees, from on-chain quotes (Curve get_dy / Sky
// LitePSM tout) pinned to one block — written by scripts/record-depth-curves.mjs
// into venue_depth_curves. Venue curve = markets summed per level (independent
// pools; lib/venueCapacity/capacityCurve.ts). Read from the DB only; no chain
// reads. Cached s-maxage 300.

function enabledVenueNames(): string[] {
  const raw = readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8')
  return (JSON.parse(raw).venues as Array<{ name: string; enabled: boolean }>).filter((v) => v.enabled).map((v) => v.name)
}

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v))

export default async function handler(req: NextApiRequest, res: NextApiResponse<CapacityCurveResponse | { error: string; validVenues?: string[] }>) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const raw = req.query.venue
  const venue = Array.isArray(raw) ? raw[0] : raw
  const names = enabledVenueNames()
  if (!venue || !names.includes(venue)) return res.status(404).json({ error: 'unknown venue', validVenues: names })

  // The latest pass = every market row at the venue's max recorded block.
  const r = await db.execute(sql`
    SELECT market, block, observed_at, points, meta FROM venue_depth_curves
    WHERE venue = ${venue}
      AND block = (SELECT MAX(block) FROM venue_depth_curves WHERE venue = ${venue})
    ORDER BY market`)
  const rows = r.rows as Array<{ market: string; block: string | number; observed_at: string; points: CurvePoint[]; meta: Record<string, unknown> }>

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  if (rows.length === 0) return res.status(200).json({ venue, curve: null })

  const markets = rows.map((row) => {
    const m = row.meta ?? {}
    const points = (row.points ?? []).map((p) => ({ costPct: Number(p.costPct), capacityUsd: num(p.capacityUsd) }))
    return {
      market: row.market,
      points,
      route: typeof m.route === 'string' ? m.route : null,
      source: typeof m.source === 'string' ? m.source : null,
      navUsd: num(m.navUsd),
      feeBps: num(m.poolFeeBps ?? m.feeBps),
      reserveUsd: num(m.reserveUsd),
      error: typeof m.error === 'string' ? m.error : null,
    }
  })
  const reserves = markets.map((m) => m.reserveUsd)
  const observedAt = rows.map((x) => new Date(x.observed_at).toISOString()).sort().pop()!
  return res.status(200).json({
    venue,
    curve: {
      block: Number(rows[0].block),
      observedAt,
      points: combineMarkets(markets),
      markets,
      reserveUsd: reserves.every((x) => x !== null) ? (reserves as number[]).reduce((a, b) => a + b, 0) : null,
    },
  })
}
