// score-user-receipts.mjs — the CALLED-IT RECEIPTS scorer (owner-approved).
//
// One pass over every DUE, UNSCORED receipt (made_at + horizon_hours <= now):
//   1. Read the venue's CURRENT metric value from its latest OBSERVED snapshot
//      (same primaryMetric semantics as the recorder — instant_usd where the
//      venue has it, else totalAssets — but expressed in USD, because a human
//      call is stated in dollars: instant_usd is already USD; total_assets is
//      the raw uint256 / 10^decimals valued at $1/stable, the same honesty
//      assumption scripts/lib/venue-reads.mjs uses for the atoken venues).
//   2. realized = that value; hit = band_low <= realized <= band_high.
//   3. Exactly ONE UPDATE per row (realized/scored_at/hit set once, from a
//      REALIZED outcome — the venue_predictions discipline, BADASS §7/§9.3).
//
//   node scripts/score-user-receipts.mjs        (from the membrane-app root)
//
// Reads DATABASE_URL_UNPOOLED (falls back to DATABASE_URL) from .env.local. This
// scorer does NO chain reads — it scores against snapshots the recorder already
// wrote, so it is safe to run as a non-fatal tail of the hourly recorder tick.
// tsx/node get NO Next env injection — .env.local is parsed via the shared lib.

import { neon } from '@neondatabase/serverless'
import { readEnv, loadConfig } from './lib/venue-reads.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(dbUrl)

// venue name -> underlying decimals (for the total_assets USD scaling). Config
// carries `decimals` per venue; default 18 if absent.
const decimalsByVenue = new Map(loadConfig().map((v) => [v.name, v.decimals ?? 18]))

// The venue's current metric value in USD, from its latest observed snapshot.
// Returns null when the metric is not honestly readable (left unscored, never
// fabricated).
async function realizedUsd(venue, metric) {
  const [snap] = await sql`
    SELECT instant_usd, params FROM venue_snapshots
    WHERE venue = ${venue} AND source = 'observed'
    ORDER BY observed_at DESC LIMIT 1`
  if (!snap) return null
  if (metric === 'instant_usd') {
    return snap.instant_usd === null || snap.instant_usd === undefined ? null : Number(snap.instant_usd)
  }
  // total_assets: raw uint256 base units -> USD at $1/stable.
  const ta = snap.params?.totalAssets
  if (ta === undefined || ta === null) return null
  const decimals = decimalsByVenue.get(venue) ?? 18
  const usd = Number(ta) / 10 ** decimals
  return Number.isFinite(usd) ? usd : null
}

const due = await sql`
  SELECT id, venue, metric, band_low, band_high FROM user_receipts
  WHERE scored_at IS NULL
    AND made_at + (horizon_hours || ' hours')::interval <= now()
  ORDER BY made_at ASC`

if (due.length === 0) {
  console.log('no due, unscored receipts')
  process.exit(0)
}

let scored = 0
for (const r of due) {
  const realized = await realizedUsd(r.venue, r.metric)
  if (realized === null) {
    console.log(`  receipt ${r.id} due but metric '${r.metric}' unreadable for ${r.venue} — left unscored`)
    continue
  }
  const hit = realized >= Number(r.band_low) && realized <= Number(r.band_high)
  await sql`
    UPDATE user_receipts
    SET realized = ${realized}, scored_at = now(), hit = ${hit}
    WHERE id = ${r.id} AND scored_at IS NULL`
  scored += 1
  console.log(`  scored receipt ${r.id} (${r.venue}/${r.metric}): realized=${realized} hit=${hit}`)
}

console.log(`receipt scorer complete — ${scored}/${due.length} scored`)
