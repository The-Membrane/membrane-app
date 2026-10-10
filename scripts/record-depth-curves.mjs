// Depth-curve recorder: for every enabled venue's enabled depth market, build
// the capacity-vs-cost curve from ON-CHAIN quotes (Curve get_dy / LitePSM tout,
// scripts/lib/depthCurve.mjs), seal a compact local pass, and optionally INSERT
// venue_depth_curves rows. All reads
// for a pass are pinned to ONE block. Read-only on chain (eth_call only).
//
//   node scripts/record-depth-curves.mjs
//   node scripts/record-depth-curves.mjs --local (native hourly job; no database)
//
// Env (.env.local): RECORDER_RPC_URL (mainnet, comma list ok), DATABASE_URL(_UNPOOLED).
// A failed market/endpoint writes no pass; the prior reading keeps its true age.

import { neon } from '@neondatabase/serverless'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnv, loadConfig, makeClient } from './lib/venue-reads.mjs'
import { COST_LEVELS_PCT, readVenueNav, readMarketCurve } from './lib/depthCurve.mjs'
import { depthRouteIdentity } from './lib/depth-identity.mjs'
import {
  appendLocalVenueCurvePass,
  validateLocalVenueCurvePass,
} from './lib/localVenueCurveStore.mjs'

const fmt = (v) => (v === null ? 'null' : `$${Math.round(v).toLocaleString('en-US')}`)

export async function readPass(
  client,
  { venues = loadConfig(), readNav = readVenueNav, readCurve = readMarketCurve } = {},
) {
  if ((await client.getChainId()) !== 1) throw new Error('depth_recorder_mainnet_required')
  const sourceBlock = await client.getBlock({ blockTag: 'finalized' })
  if (!sourceBlock?.number || !sourceBlock?.hash || !sourceBlock?.timestamp)
    throw new Error('depth_recorder_finalized_block_unavailable')
  const block = sourceBlock.number
  const sourceBlockTime = new Date(Number(sourceBlock.timestamp) * 1000).toISOString()
  const rows = []
  for (const venue of venues.filter((v) => v.enabled)) {
    const markets = (venue.depthMarkets ?? []).filter((m) => m.enabled)
    if (markets.length === 0) continue
    const nav = await readNav(client, venue, block)
    for (const m of markets) {
      let result
      try {
        result = await readCurve(client, venue, m, block, nav)
      } catch {
        result = { error: 'quote_read_failed' }
      }
      // A failed/incomplete endpoint does not publish a partial pass. Try the
      // next entire endpoint, never splice quote legs from two RPC hosts.
      if (
        result.error ||
        !Array.isArray(result.points) ||
        result.points.length !== COST_LEVELS_PCT.length ||
        result.points.some(
          (point, index) =>
            !point ||
            point.costPct !== COST_LEVELS_PCT[index] ||
            !Number.isFinite(point.capacityUsd) ||
            point.capacityUsd < 0,
        ) ||
        result.points.some(
          (point, index) => index > 0 && point.capacityUsd < result.points[index - 1].capacityUsd,
        )
      ) {
        const failure = new Error('depth_recorder_incomplete_quote')
        failure.market = `${venue.name}/${m.name}`
        failure.reason = result.error || 'invalid_points'
        throw failure
      }
      const points = result.points
      const meta = {
        ...result.meta,
        configIdentity: depthRouteIdentity(venue, m),
        sourceBlockTime,
        sourceBlockHash: sourceBlock.hash.toLowerCase(),
      }
      rows.push({ venue: venue.name, market: m.name, points, meta })
    }
  }
  // The selected endpoint must still agree with the header that labels every
  // quote before *any* row is persisted. Inconsistent or unavailable -> no pass.
  const confirmation = await client.getBlock({ blockNumber: block })
  if (confirmation?.hash?.toLowerCase() !== sourceBlock.hash.toLowerCase())
    throw new Error('depth_recorder_source_hash_changed')
  return { block, rows }
}

/** Seal the complete local venue pass before any optional database write. */
export async function persistDepthCurvePass(
  pass,
  {
    venues = loadConfig(),
    append = appendLocalVenueCurvePass,
    sql = null,
    now = () => new Date(),
  } = {},
) {
  const observedAtUtc = now().toISOString()
  const results = []
  const inputs = []
  for (const venue of venues.filter((venue) => venue.enabled)) {
    const configured = (venue.depthMarkets ?? []).filter((market) => market.enabled)
    if (!configured.length) continue
    const rows = pass.rows.filter((row) => row.venue === venue.name)
    const source = rows[0]?.meta ?? {}
    if (
      !rows.length ||
      rows.some(
        (row) =>
          row.meta?.error != null ||
          row.meta?.sourceBlockHash !== source.sourceBlockHash ||
          row.meta?.sourceBlockTime !== source.sourceBlockTime,
      )
    )
      throw Error('depth_recorder_incomplete_quote')
    inputs.push(
      validateLocalVenueCurvePass({
        venue: venue.name,
        chainId: 1,
        block: String(pass.block),
        sourceBlockHash: source.sourceBlockHash,
        sourceBlockTime: source.sourceBlockTime,
        observedAtUtc,
        finalized: true,
        pinned: true,
        expectedIdentities: Object.fromEntries(
          configured.map((market) => [market.name, depthRouteIdentity(venue, market)]),
        ),
        markets: rows.map((row) => ({
          market: row.market,
          configIdentity: row.meta.configIdentity,
          points: row.points,
        })),
      }),
    )
  }
  for (const input of inputs) {
    const result = await append(input)
    if (result.status === 'unavailable') throw Error(result.reason)
    results.push({ venue: input.venue, status: result.status })
  }
  if (sql)
    for (const row of pass.rows)
      await sql`INSERT INTO venue_depth_curves (venue, market, block, points, meta)
      VALUES (${row.venue}, ${row.market}, ${pass.block.toString()}, ${JSON.stringify(row.points)}::jsonb, ${JSON.stringify(row.meta)}::jsonb)`
  return { status: 'local_curves_recorded', venues: results, databaseUsed: sql !== null }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--local'))
    throw Error('depth_recorder_usage')
  const localOnly = args[0] === '--local'
  const { get } = readEnv()
  const rpcUrls =
    process.env.RECORDER_RPC_URLS ||
    get('RECORDER_RPC_URLS') ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URL')
  if (!rpcUrls) throw new Error('depth_recorder_rpc_unset')
  const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
  if (!localOnly && !dbUrl) throw new Error('depth_recorder_database_unset')
  // Every attempt uses one RPC host for all reads. Only a complete pass is
  // eligible for storage; failover restarts the entire pinned-block reading.
  const candidates = String(rpcUrls)
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const sql = localOnly ? null : neon(dbUrl)
  const result = await collectDepthCurveVenues({ candidates, sql })
  for (const pass of result.passes)
    for (const row of pass.rows) {
      console.log(`depth curves [${row.venue}] @ finalized block ${pass.block}`)
      console.log(`[${row.venue}] ${row.market}${row.meta.error ? ` ERROR ${row.meta.error}` : ''}`)
      console.log(
        `  ${row.points.map((p) => `${p.costPct}% ${fmt(p.capacityUsd)}`).join(' · ')}  | raw reserve ${fmt(row.meta.reserveUsd ?? null)}`,
      )
    }
  console.log(JSON.stringify({ status: result.status, venues: result.venues }))
  if (result.status !== 'complete') process.exitCode = 1
}

/** Each venue retries an entire pass; a broken route never blocks other venues. */
export async function collectDepthCurveVenues({
  venues = loadConfig(),
  candidates,
  sql = null,
  clientFor = makeClient,
  read = readPass,
  persist = persistDepthCurvePass,
} = {}) {
  const passes = []
  const outcomes = []
  for (const venue of venues.filter(
    (venue) => venue.enabled && (venue.depthMarkets ?? []).some((market) => market.enabled),
  )) {
    let pass = null
    const attempts = []
    for (const [index, candidate] of candidates.entries()) {
      try {
        pass = await read(clientFor(candidate), { venues: [venue] })
        break
      } catch (error) {
        // Transport exceptions may include secrets. Only retain allowlisted codes.
        const reason = /^depth_recorder_[a-z0-9_]+$/.test(String(error?.message))
          ? error.message
          : 'depth_recorder_provider_failure'
        attempts.push({ configuredSource: index + 1, reason })
      }
    }
    if (!pass) {
      outcomes.push({
        venue: venue.name,
        status: 'unavailable',
        reason: 'depth_recorder_no_complete_single_host_pass',
        attempts,
      })
      continue
    }
    try {
      await persist(pass, { venues: [venue], sql })
      passes.push(pass)
      outcomes.push({ venue: venue.name, status: 'recorded', block: String(pass.block) })
    } catch (error) {
      const reason = /^(depth_recorder|local_curve)_[a-z0-9_]+$/.test(String(error?.message))
        ? error.message
        : 'depth_recorder_storage_failure'
      outcomes.push({ venue: venue.name, status: 'unavailable', reason })
    }
  }
  return {
    status: outcomes.every((venue) => venue.status === 'recorded')
      ? 'complete'
      : passes.length
        ? 'partial'
        : 'unavailable',
    venues: outcomes,
    passes,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // Transport exceptions can contain credential-bearing endpoint URLs.
    const safeCode = /^(depth_recorder|local_curve)_[a-z0-9_]+$/.test(String(error?.message))
      ? error.message
      : 'depth_recorder_provider_or_storage_failure'
    console.error(safeCode)
    process.exitCode = 1
  })
