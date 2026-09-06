// refresh-strat-positions.mjs — CURRENT-position refresher for the Carry Strats
// board (owner-approved). Re-reads every watched address's live positions in ONE
// batched chain-read pass and caches them on the strat_watches row, so
// /api/strats can serve stored values instead of doing N addresses × 4 venues of
// live reads per request (which would make the shareable dashboard too slow).
//
//   node scripts/refresh-strat-positions.mjs [--venue-filter <name>]
//
// It writes last_scanned = { at, total_usd, usdByVenue: {venue: usd} } and
// last_scanned_at = now() per row, using the SAME reader the live radar uses
// (scripts/lib/position-reads.mjs — one source of truth). It does NOT touch
// entry_positions or label (those are the recap's entry baseline). Run it after
// discovery and on a schedule; the API surfaces last_scanned_at as the board's
// freshness stamp. Verdicts are NOT computed here — the API reuses computeRadar
// against the address-independent recorded corpus, which it fetches once.
//
// Env: RECORDER_RPC_URL (MAINNET) + DATABASE_URL(_UNPOOLED) from .env.local.

import { neon } from '@neondatabase/serverless'
import { getAddress } from 'viem'
import { readEnv, loadConfig, makeClient } from './lib/venue-reads.mjs'
import { readUsdByVenue } from './lib/position-reads.mjs'

const { get } = readEnv()
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error('RECORDER_RPC_URL is unset (see .env.local — a MAINNET RPC, not anvil).')
  process.exit(1)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(dbUrl)
const client = makeClient(rpcUrl)
const venues = loadConfig().filter((v) => v.enabled)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function withRetry(fn, label, tries = 4) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const backoff = 400 * 2 ** i
      console.log(`    retry ${label} (${i + 1}/${tries}) after ${backoff}ms — ${String(e).split('\n')[0].slice(0, 110)}`)
      await sleep(backoff)
    }
  }
  throw lastErr
}

const rows = await sql`SELECT address FROM strat_watches ORDER BY created_at ASC`
console.log(`refreshing ${rows.length} watched strats across ${venues.length} venues…\n`)

let refreshed = 0
let failed = 0
let grandTotal = 0
const POOL = 8
for (let i = 0; i < rows.length; i += POOL) {
  const batch = rows.slice(i, i + POOL)
  const results = await Promise.all(
    batch.map(async (row) => {
      const address = getAddress(row.address)
      try {
        const usdByVenue = await withRetry(() => readUsdByVenue(client, venues, address), `positions ${address.slice(0, 8)}`, 3)
        const obj = {}
        let total = 0
        for (const v of venues) {
          const usd = usdByVenue.get(v.name) ?? 0
          obj[v.name] = usd
          total += usd
        }
        return { address, total, usdByVenue: obj }
      } catch (e) {
        console.log(`  ${address.slice(0, 10)}… read failed (${String(e).split('\n')[0].slice(0, 80)}) — left stale`)
        return null
      }
    }),
  )
  for (const r of results) {
    if (!r) {
      failed++
      continue
    }
    const lastScanned = JSON.stringify({ at: new Date().toISOString(), total_usd: r.total, usdByVenue: r.usdByVenue })
    await sql`
      UPDATE strat_watches
      SET last_scanned = ${lastScanned}::jsonb, last_scanned_at = now()
      WHERE address = ${r.address}`
    refreshed++
    grandTotal += r.total
    console.log(`  ✓ ${r.address} — $${Math.round(r.total).toLocaleString()}`)
  }
}

console.log('\n=== refresh summary ===')
console.log(`refreshed:            ${refreshed}`)
console.log(`failed (left stale):  ${failed}`)
console.log(`total USD (refreshed) $${Math.round(grandTotal).toLocaleString()}`)
