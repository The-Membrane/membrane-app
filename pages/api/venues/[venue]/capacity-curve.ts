import type { NextApiRequest, NextApiResponse } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { combineMarkets, selectRecentCompleteCurvePass, type CapacityCurveResponse, type CurvePoint, type StoredCurvePassRow } from '@/lib/venueCapacity/capacityCurve'
import { depthRouteIdentity } from '@/scripts/lib/depth-identity.mjs'

// PUBLIC. The venue's latest SLIPPAGE-BOUNDED exit capacity curve: what exits
// within each cost level incl. fees, from on-chain quotes (Curve get_dy / Sky
// LitePSM tout) pinned to one block — written by scripts/record-depth-curves.mjs
// into venue_depth_curves. Venue curve = markets summed per level (independent
// pools; lib/venueCapacity/capacityCurve.ts). Read from the DB only; no chain
// reads. Cached s-maxage 300.

type DepthMarketConfig = {
  name: string
  enabled: boolean
  kind: string
  address: string
  exitFrom: string
  token0?: string
  token1?: string
  buffer?: string
  bufferToken?: string
}
type VenueConfig = {
  name: string
  enabled: boolean
  kind: string
  address: string
  underlying: string
  decimals: number
  depthMarkets?: DepthMarketConfig[]
}

function enabledVenues(): VenueConfig[] {
  const raw = readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8')
  return (JSON.parse(raw).venues as VenueConfig[]).filter((v) => v.enabled)
}

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v))
const MAX_RECENT_PASSES = 20

export default async function handler(req: NextApiRequest, res: NextApiResponse<CapacityCurveResponse | { error: string; validVenues?: string[] }>) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const raw = req.query.venue
  const venue = Array.isArray(raw) ? raw[0] : raw
  const configs = enabledVenues()
  const names = configs.map((v) => v.name)
  if (!venue || !names.includes(venue)) return res.status(404).json({ error: 'unknown venue', validVenues: names })
  const venueConfig = configs.find((v) => v.name === venue)!
  const configuredMarkets = (venueConfig.depthMarkets ?? []).filter((m) => m.enabled)
  const depthMarkets = configuredMarkets.map((m) => m.name)

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  if (depthMarkets.length === 0) return res.status(200).json({ venue, curve: null, unavailableReason: 'not-configured' })

  // Search at most 20 distinct recorded blocks and a capped row count. A
  // partially returned block cannot pass: block_row_count carries its true
  // row count, so a truncated group is never misread as a complete pass.
  const maxRows = MAX_RECENT_PASSES * (depthMarkets.length + 1)
  const r = await db.execute(sql`
    WITH recent_blocks AS (
      SELECT DISTINCT block FROM venue_depth_curves
      WHERE venue = ${venue}
      ORDER BY block DESC LIMIT ${MAX_RECENT_PASSES}
    ), candidate_rows AS (
      SELECT c.market, c.block, c.observed_at, c.points, c.meta,
        COUNT(*) OVER (PARTITION BY c.block) AS block_row_count
      FROM venue_depth_curves c
      JOIN recent_blocks b ON c.block = b.block
      WHERE c.venue = ${venue}
    )
    SELECT market, block, observed_at, points, meta, block_row_count
    FROM candidate_rows ORDER BY block DESC, market LIMIT ${maxRows}`)
  type DbCurveRow = StoredCurvePassRow & { market: string; block: string | number; observed_at: string; points: CurvePoint[]; meta: Record<string, unknown> }
  const candidates = r.rows as DbCurveRow[]

  if (candidates.length === 0) return res.status(200).json({ venue, curve: null, unavailableReason: 'no-recording' })
  const expectedIdentities = Object.fromEntries(
    configuredMarkets.map((market) => [market.name, depthRouteIdentity(venueConfig, market)]),
  )
  const selected = selectRecentCompleteCurvePass(candidates, depthMarkets, expectedIdentities)
  if (!selected) {
    return res.status(200).json({ venue, curve: null, unavailableReason: 'incomplete-latest' })
  }
  const rows = selected.rows as DbCurveRow[]

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
  const sourceBlockTime = (rows[0].meta as Record<string, unknown>).sourceBlockTime as string
  return res.status(200).json({
    venue,
    ...(selected.latestPassIncomplete ? { latestPassIncomplete: true } : {}),
    curve: {
      block: Number(rows[0].block),
      observedAt,
      sourceBlockTime,
      points: combineMarkets(markets),
      markets,
      reserveUsd: reserves.every((x) => x !== null) ? (reserves as number[]).reduce((a, b) => a + b, 0) : null,
    },
  })
}
