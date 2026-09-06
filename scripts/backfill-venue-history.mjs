// backfill-venue-history.mjs — reconstruct a venue's withdrawal state at
// historical blocks and insert them as venue_snapshots rows with
// source='backfilled'. Uses the SAME reads as the live recorder
// (scripts/lib/venue-reads), just at old blocks — so RECORDER_RPC_URL MUST be
// an ARCHIVE node.
//
//   node scripts/backfill-venue-history.mjs --venue sUSDe \
//        --from-block 20000000 --to-block 20100000 --step 5000
//
// Backfill inserts NO venue_events and NO venue_predictions: reconstructed
// state must not masquerade as observed process. (Events are diffs of what we
// actually watched change; predictions are only credible when they precede a
// realized outcome — a historical snapshot can do neither honestly.)
//
// Env: RECORDER_RPC_URL (mainnet archive RPC) + DATABASE_URL(_UNPOOLED), both
// from .env.local. tsx/node get no Next env injection.

import { neon } from '@neondatabase/serverless'
import { readEnv, loadConfig, makeClient, readVenueState, readDepthMarkets } from './lib/venue-reads.mjs'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const venueName = arg('venue')
const fromBlock = arg('from-block')
const toBlock = arg('to-block')
const step = arg('step')
if (!venueName || fromBlock === undefined || toBlock === undefined || step === undefined) {
  console.error('Usage: node scripts/backfill-venue-history.mjs --venue <name> --from-block <n> --to-block <n> --step <n>')
  process.exit(1)
}

const { get } = readEnv()
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error(
    'RECORDER_RPC_URL is unset. Set it in .env.local to a MAINNET ARCHIVE Ethereum RPC ' +
      '(historical reads need an archive node), then re-run.',
  )
  process.exit(1)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const venue = loadConfig().find((v) => v.name === venueName)
if (!venue) {
  console.error(`Unknown venue '${venueName}' — not in tools/venue-recorder.config.json`)
  process.exit(1)
}

const sql = neon(dbUrl)
const client = makeClient(rpcUrl)

const from = BigInt(fromBlock)
const to = BigInt(toBlock)
const by = BigInt(step)
if (by <= 0n) {
  console.error('--step must be > 0')
  process.exit(1)
}

let count = 0
for (let b = from; b <= to; b += by) {
  const { params, instantUsd, coolingUsd, strandedUsd } = await readVenueState(client, venue, b)
  // Depth-market extension at the SAME historical block (memo P4).
  const depth = await readDepthMarkets(client, venue, b)
  if (depth) Object.assign(params, depth)
  // observed_at = the block's own timestamp, so backfilled history sorts
  // chronologically alongside observed rows.
  const blk = await client.getBlock({ blockNumber: b })
  const observedAt = new Date(Number(blk.timestamp) * 1000).toISOString()
  await sql`
    INSERT INTO venue_snapshots (venue, chain, block, observed_at, instant_usd, cooling_usd, stranded_usd, params, source)
    VALUES (${venue.name}, ${venue.chain ?? 'ethereum'}, ${b.toString()}, ${observedAt},
            ${instantUsd}, ${coolingUsd}, ${strandedUsd}, ${JSON.stringify(params)}::jsonb, 'backfilled')`
  count++
  console.log(`  block ${b} (${observedAt}) — instant_usd=${instantUsd ?? 'null'}`)
}

console.log(`\nbackfilled ${count} snapshot(s) for ${venue.name} (source='backfilled', no events, no predictions)`)
