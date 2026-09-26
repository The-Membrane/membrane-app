// Depth-curve recorder: for every enabled venue's enabled depth market, build
// the capacity-vs-cost curve from ON-CHAIN quotes (Curve get_dy / LitePSM tout,
// scripts/lib/depthCurve.mjs) and INSERT one venue_depth_curves row. All reads
// for a pass are pinned to ONE block. Read-only on chain (eth_call only).
//
//   node scripts/record-depth-curves.mjs
//
// Env (.env.local): RECORDER_RPC_URL (mainnet, comma list ok), DATABASE_URL(_UNPOOLED).
// A market whose reads fail still gets a row: points null at every level and
// meta.error — a failed read is never recorded as zero capacity.

import { neon } from '@neondatabase/serverless'
import { readEnv, loadConfig, makeClient } from './lib/venue-reads.mjs'
import { COST_LEVELS_PCT, readVenueNav, readMarketCurve } from './lib/depthCurve.mjs'

const { get } = readEnv()
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error('RECORDER_RPC_URL is unset (mainnet RPC, .env.local).')
  process.exit(1)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)
const client = makeClient(rpcUrl)

const block = await client.getBlockNumber()
console.log(`depth curves @ block ${block}`)
const fmt = (v) => (v === null ? 'null' : `$${Math.round(v).toLocaleString('en-US')}`)

let wrote = 0
for (const venue of loadConfig().filter((v) => v.enabled)) {
  const markets = (venue.depthMarkets ?? []).filter((m) => m.enabled)
  if (markets.length === 0) continue
  const nav = await readVenueNav(client, venue, block)
  for (const m of markets) {
    let r
    try {
      r = await readMarketCurve(client, venue, m, block, nav)
    } catch (e) {
      r = { error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) }
    }
    const points = r.error ? COST_LEVELS_PCT.map((costPct) => ({ costPct, capacityUsd: null })) : r.points
    const meta = r.error ? { error: r.error, navUsd: nav?.navUsd ?? null, route: null } : r.meta
    await sql`INSERT INTO venue_depth_curves (venue, market, block, points, meta)
      VALUES (${venue.name}, ${m.name}, ${block.toString()}, ${JSON.stringify(points)}::jsonb, ${JSON.stringify(meta)}::jsonb)`
    wrote++
    console.log(`[${venue.name}] ${m.name}${r.error ? ` ERROR ${r.error}` : ''}`)
    console.log(`  ${points.map((p) => `${p.costPct}% ${fmt(p.capacityUsd)}`).join(' · ')}  | raw reserve ${fmt(meta.reserveUsd ?? null)}`)
  }
}
console.log(`wrote ${wrote} curve row(s)`)
