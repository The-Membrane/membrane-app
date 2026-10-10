// Narrow, additive repair for the finalized flow recorder. Legacy event rows
// remain uncertified; only new getLogs passes can insert sealed range receipts.
// Usage: node scripts/apply-venue-flow-receipts-ddl.mjs
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

const { get } = readEnv()
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) throw new Error('venue_flow_database_url_unset')
const sql = neon(url)

await sql`CREATE TABLE IF NOT EXISTS venue_flow_range_receipts (
  venue text NOT NULL,
  from_block bigint NOT NULL,
  to_block bigint NOT NULL,
  from_hash text NOT NULL,
  to_hash text NOT NULL,
  finalized_head_block bigint NOT NULL,
  finalized_head_hash text NOT NULL,
  streamset_hash text NOT NULL,
  streams jsonb NOT NULL,
  event_set_hash text,
  receipt_hash text NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue, from_block),
  CONSTRAINT venue_flow_range_order_check CHECK (from_block >= 0 AND to_block >= from_block),
  CONSTRAINT venue_flow_range_finality_check CHECK (finalized_head_block >= to_block)
)`
await sql`ALTER TABLE venue_flow_range_receipts ADD COLUMN IF NOT EXISTS event_set_hash text`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_flow_range_to_unique_idx
  ON venue_flow_range_receipts (venue, to_block)`

console.log('venue_flow_range_receipts ready; no legacy flow rows were certified')
