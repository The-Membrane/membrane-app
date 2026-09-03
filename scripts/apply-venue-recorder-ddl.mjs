// One-shot, additive DDL for the venue withdrawal-ability recorder (owner-
// approved). Three tables mirroring the drizzle definitions in db/schema.ts:
//   venue_snapshots  — insert-only point-in-time readings of a venue's state
//   venue_events     — insert-only "news tracker": state CHANGES between snapshots
//   venue_predictions — insert once, then exactly one scoring UPDATE per row
//
//   node scripts/apply-venue-recorder-ddl.mjs        (from the membrane-app root)
//
// Applied manually (pet_wraps / indexer_cursor precedent) instead of
// `drizzle-kit push` so a schema drift elsewhere can't turn this into a
// destructive diff. Reads DATABASE_URL_UNPOOLED (falls back to DATABASE_URL)
// from .env.local. Safe to re-run: everything is IF NOT EXISTS.
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

await sql`CREATE TABLE IF NOT EXISTS venue_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  chain text NOT NULL DEFAULT 'ethereum',
  block bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  instant_usd numeric,
  cooling_usd numeric,
  stranded_usd numeric,
  params jsonb NOT NULL,
  source text NOT NULL DEFAULT 'observed',
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE INDEX IF NOT EXISTS venue_snapshots_venue_observed_idx ON venue_snapshots (venue, observed_at)`

await sql`CREATE TABLE IF NOT EXISTS venue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  kind text NOT NULL,
  prev jsonb,
  next jsonb,
  note text,
  snapshot_id uuid,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE INDEX IF NOT EXISTS venue_events_venue_observed_idx ON venue_events (venue, observed_at)`

await sql`CREATE TABLE IF NOT EXISTS venue_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  metric text NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now(),
  horizon_hours integer NOT NULL,
  band_low numeric NOT NULL,
  band_high numeric NOT NULL,
  model text NOT NULL,
  realized numeric,
  scored_at timestamptz,
  hit boolean
)`
await sql`CREATE INDEX IF NOT EXISTS venue_predictions_venue_made_idx ON venue_predictions (venue, made_at)`
// Partial index over unscored predictions: the recorder scans these every pass
// to find rows whose horizon has elapsed and score them.
await sql`CREATE INDEX IF NOT EXISTS venue_predictions_unscored_idx ON venue_predictions (venue, made_at) WHERE scored_at IS NULL`

const [{ s }] = await sql`SELECT count(*)::int AS s FROM venue_snapshots`
const [{ e }] = await sql`SELECT count(*)::int AS e FROM venue_events`
const [{ p }] = await sql`SELECT count(*)::int AS p FROM venue_predictions`
console.log(`venue recorder tables ready — snapshots: ${s}, events: ${e}, predictions: ${p}`)
