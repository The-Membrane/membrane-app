// Persist bounded transaction-class evidence for observed Curve depth events.
// Run after the capacity tick. Idempotent by venue_event.id; never turns a
// failed RPC query into an empty/reconciled explanation.
// node scripts/record-venue-event-drivers.mjs [--limit 8]

import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { neon } from '@neondatabase/serverless'
import { readEnv, loadConfig } from './lib/venue-reads.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { get } = readEnv()
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) throw new Error('DATABASE_URL_UNPOOLED / DATABASE_URL is required')
const sql = neon(url)
const arg = process.argv.indexOf('--limit')
const limit = arg >= 0 ? Number(process.argv[arg + 1]) : 8
if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('--limit must be 1–25')
const curveVenues = loadConfig()
  // This reconciler understands Curve pools only. A mixed market set must not
  // pass while silently omitting a PSM or a different AMM from the total.
  .filter((venue) => {
    if (!venue.enabled) return false
    const enabledMarkets = (venue.depthMarkets ?? []).filter((market) => market.enabled)
    return (
      enabledMarkets.length > 0 &&
      enabledMarkets.every((market) => market.kind === 'curve-stableswap')
    )
  })
  .map((venue) => venue.name)
if (!curveVenues.length) process.exit(0)

const events = await sql`
  SELECT e.id, e.venue FROM venue_events e
  LEFT JOIN venue_event_drivers d ON d.event_id = e.id
  WHERE e.kind = 'param_changed' AND e.next ? 'depth_usd'
    AND e.venue = ANY(${curveVenues}::text[]) AND d.event_id IS NULL
  ORDER BY e.observed_at DESC LIMIT ${limit}`

let reconciled = 0
let incomplete = 0
let failed = 0
for (const event of events) {
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(root, 'scripts/research/curve-depth-attribution.mjs'),
        '--venue',
        event.venue,
        '--event-id',
        event.id,
      ],
      { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 512 * 1024 },
    )
    const evidence = JSON.parse(output)
    if (evidence.eventId !== event.id || evidence.venue !== event.venue)
      throw new Error('event identity mismatch')
    const status =
      evidence.results?.length > 0 &&
      evidence.results.every((row) => row.attributionGate95Pct === true)
        ? 'reconciled'
        : 'incomplete'
    await sql`
      INSERT INTO venue_event_drivers (event_id, venue, status, evidence)
      VALUES (${event.id}::uuid, ${event.venue}, ${status}, ${JSON.stringify(evidence)}::jsonb)
      ON CONFLICT (event_id) DO NOTHING`
    if (status === 'reconciled') reconciled++
    else incomplete++
    console.log(`${event.venue} ${event.id}: ${status}`)
  } catch (error) {
    // Retriable: leave the event absent. No stale or fabricated driver rows.
    failed++
    console.warn(
      `${event.venue} ${event.id}: attribution unavailable (${String(error).split('\n')[0].slice(0, 140)})`,
    )
  }
}
console.log(
  `venue driver pass: ${reconciled} reconciled, ${incomplete} incomplete, ${failed} retryable failures`,
)
