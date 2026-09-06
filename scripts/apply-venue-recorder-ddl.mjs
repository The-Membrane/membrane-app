// One-shot, additive DDL for the venue withdrawal-ability recorder (owner-
// approved). Four tables mirroring the drizzle definitions in db/schema.ts:
//   venue_snapshots  — insert-only point-in-time readings of a venue's state
//   venue_events     — insert-only "news tracker": state CHANGES between snapshots
//   venue_predictions — insert once, then exactly one scoring UPDATE per row
//   venue_flows      — insert-only REALIZED deposit/withdraw volumes from logs
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

// venue_flows — insert-only REALIZED deposit/withdraw volumes, decoded from
// on-chain event logs (scripts/record-venue-flows.mjs). Snapshots record
// CAPACITY (what COULD exit); flows record transacted DEMAND (what DID move).
// Together they enable the owner's saturation method: realized outflow ≈
// available capacity ⇒ demand was likely censored (unserved withdrawers).
//
// NOTE ON PROVENANCE — there is deliberately no observed/backfilled split here
// (unlike venue_snapshots). Event logs ARE the on-chain record of past process;
// fetching old logs is legitimate history, not a reconstruction of state that
// was never observed. Every row is an actual emitted event.
//
// assets_raw is the underlying amount in BASE UNITS (raw uint256, unscaled) —
// USD is derived downstream at $1/stable. UNIQUE(venue, tx_hash, log_index)
// makes re-fetch over an already-scanned range idempotent (INSERT ... ON
// CONFLICT DO NOTHING); the recorder's cursor = max(block)+1 per venue.
await sql`CREATE TABLE IF NOT EXISTS venue_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  block bigint NOT NULL,
  block_time timestamptz NOT NULL,
  direction text NOT NULL,
  assets_raw numeric NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_flows_venue_tx_log_idx ON venue_flows (venue, tx_hash, log_index)`
await sql`CREATE INDEX IF NOT EXISTS venue_flows_venue_block_idx ON venue_flows (venue, block)`

// strat_watches — Carry Radar STRAT WATCHES. One row per tracked address with a
// point-in-time snapshot of its radar positions at watch time (entry baseline
// for the POST-EVENT RECAP). UPSERT on UNIQUE(address). Mirrors the drizzle
// definition in db/schema.ts (stratWatches) — keep them in lockstep.
await sql`CREATE TABLE IF NOT EXISTS strat_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  label text,
  entry_positions jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS strat_watches_address_idx ON strat_watches (address)`

// Cached CURRENT positions for the Carry Strats board (additive columns).
// scripts/refresh-strat-positions.mjs writes these in one batched chain-read pass
// so /api/strats serves stored values (no per-request live reads). Mirrors the
// stratWatches drizzle definition — keep them in lockstep.
await sql`ALTER TABLE strat_watches ADD COLUMN IF NOT EXISTS last_scanned jsonb`
await sql`ALTER TABLE strat_watches ADD COLUMN IF NOT EXISTS last_scanned_at timestamptz`

// venue_news — the VENUE NEWS feed. Raw external headlines per venue, fetched
// from Google News RSS by scripts/fetch-venue-news.mjs. INFORMATION not
// endorsement: title/source/url/dates stored VERBATIM, no summarization or
// sentiment. INSERT-ONLY; UNIQUE(venue, url) makes re-fetch idempotent
// (INSERT ... ON CONFLICT DO NOTHING). published_at nullable (article pubDate);
// fetched_at = when we pulled it. Mirrors venueNews in db/schema.ts.
await sql`CREATE TABLE IF NOT EXISTS venue_news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  title text NOT NULL,
  source text NOT NULL,
  url text NOT NULL,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_news_venue_url_idx ON venue_news (venue, url)`
await sql`CREATE INDEX IF NOT EXISTS venue_news_venue_published_idx ON venue_news (venue, published_at)`

// venue_alarms — the VENUE FAILURE-PATTERN ALARM. One row per fired condition,
// matched to a past-carry-failure genre (docs/research/worst-carry-venues.md).
// Written by scripts/check-venue-alarms.mjs from EXISTING corpus data only (no
// chain reads). An alarm is OPEN while cleared_at IS NULL; the checker CLEARS it
// (sets cleared_at) when the condition stops holding. severity is 'watch' or
// 'alarm'; evidence is the numbers that fired it. The partial unique index
// enforces the dedupe-while-open rule at the DB level: at most one OPEN row per
// (venue, kind). The only permitted UPDATEs are cleared_at and notified.
await sql`CREATE TABLE IF NOT EXISTS venue_alarms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL,
  evidence jsonb NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  notified boolean NOT NULL DEFAULT false
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_open_unique_idx ON venue_alarms (venue, kind) WHERE cleared_at IS NULL`
await sql`CREATE INDEX IF NOT EXISTS venue_alarms_venue_fired_idx ON venue_alarms (venue, fired_at)`

const [{ s }] = await sql`SELECT count(*)::int AS s FROM venue_snapshots`
const [{ e }] = await sql`SELECT count(*)::int AS e FROM venue_events`
const [{ p }] = await sql`SELECT count(*)::int AS p FROM venue_predictions`
const [{ f }] = await sql`SELECT count(*)::int AS f FROM venue_flows`
const [{ w }] = await sql`SELECT count(*)::int AS w FROM strat_watches`
const [{ n }] = await sql`SELECT count(*)::int AS n FROM venue_news`
const [{ a }] = await sql`SELECT count(*)::int AS a FROM venue_alarms`
console.log(`venue recorder tables ready — snapshots: ${s}, events: ${e}, predictions: ${p}, flows: ${f}, watches: ${w}, news: ${n}, alarms: ${a}`)
