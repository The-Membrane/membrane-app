// Additive, idempotent storage for hourly exact-route observations.
// Run once before enabling record-carry-routes.mjs in the recorder tick.
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

const { get } = readEnv()
const url =
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.DATABASE_URL ||
  get('DATABASE_URL_UNPOOLED') ||
  get('DATABASE_URL')
if (!url) throw new Error('DATABASE_URL_UNPOOLED / DATABASE_URL is required')

const sql = neon(url)
await sql`CREATE TABLE IF NOT EXISTS carry_route_hourly (
  route_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('holder_stock', 'spread', 'matched_capital', 'destination_tvl', 'prospective_overlap')),
  block bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('ok', 'incomplete', 'unavailable')),
  data jsonb NOT NULL,
  PRIMARY KEY (route_key, kind, block)
)`
// CREATE IF NOT EXISTS leaves the prior two-kind CHECK unchanged. Expand it
// explicitly before the recorder writes the new, independently due readings.
await sql`ALTER TABLE carry_route_hourly
  DROP CONSTRAINT IF EXISTS carry_route_hourly_kind_check,
  ADD CONSTRAINT carry_route_hourly_kind_check
  CHECK (kind IN ('holder_stock', 'spread', 'matched_capital', 'destination_tvl', 'prospective_overlap'))`
await sql`CREATE INDEX IF NOT EXISTS carry_route_hourly_latest_idx
  ON carry_route_hourly (route_key, kind, observed_at DESC)`
console.log('carry_route_hourly ready')
