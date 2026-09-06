// One-shot, additive DDL for CALLED-IT RECEIPTS (owner-approved). Mirrors the
// `userReceipts` drizzle definition in db/schema.ts.
//
//   node scripts/apply-user-receipts-ddl.mjs        (from the membrane-app root)
//
// Applied manually (pet_wraps / venue_* precedent) instead of `drizzle-kit push`
// so a schema drift elsewhere can't turn this into a destructive diff. Reads
// DATABASE_URL_UNPOOLED (falls back to DATABASE_URL) from .env.local. Safe to
// re-run: everything is IF NOT EXISTS.
//
// tsx/node get NO Next env injection — .env.local is parsed by hand below.

import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(join(root, '.env.local'), 'utf8')
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '')
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(url)

// user_receipts — one row per wallet-bound probability call on a venue outcome.
// Inserted with (realized, scored_at, hit) NULL; exactly ONE scoring UPDATE fills
// them once the horizon elapses (scripts/score-user-receipts.mjs). No partial
// unique index on made_at::date — spam is capped in the API (max 5 UNSCORED per
// address). market_ref is a NULLABLE placeholder for a future Trueo bridge.
await sql`CREATE TABLE IF NOT EXISTS user_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  venue text NOT NULL,
  metric text NOT NULL,
  statement text NOT NULL,
  band_low numeric NOT NULL,
  band_high numeric NOT NULL,
  probability_pct integer NOT NULL,
  horizon_hours integer NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now(),
  signature text NOT NULL,
  market_ref text,
  realized numeric,
  scored_at timestamptz,
  hit boolean,
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE INDEX IF NOT EXISTS user_receipts_address_made_idx ON user_receipts (address, made_at)`
// Partial index over unscored receipts: the API counts these to enforce the
// per-address cap; the scorer scans them for elapsed horizons.
await sql`CREATE INDEX IF NOT EXISTS user_receipts_unscored_idx ON user_receipts (address) WHERE scored_at IS NULL`

const [{ r }] = await sql`SELECT count(*)::int AS r FROM user_receipts`
const [{ o }] = await sql`SELECT count(*)::int AS o FROM user_receipts WHERE scored_at IS NULL`
console.log(`user_receipts ready — total: ${r}, open (unscored): ${o}`)
