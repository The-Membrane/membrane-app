// One-shot, additive DDL for venue_depth_curves — the SLIPPAGE-BOUNDED exit
// capacity curve per venue depth market (scripts/record-depth-curves.mjs,
// scripts/lib/depthCurve.mjs). Mirrors venueDepthCurves in db/schema.ts.
//
//   node scripts/apply-depth-curves-ddl.mjs        (from the membrane-app root)
//
// Applied manually (apply-venue-recorder-ddl.mjs precedent), not by
// `drizzle-kit push`. Safe to re-run: everything is IF NOT EXISTS.

import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

const { get } = readEnv()
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(url)

// INSERT-ONLY: one row per (venue, market) per recorder pass.
//   points = [{costPct, capacityUsd}] — capacityUsd null = the quote reverted (never 0)
//   meta   = {navUsd, feeBps | poolFee, reserveUsd, route, source, ...}
await sql`CREATE TABLE IF NOT EXISTS venue_depth_curves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  market text NOT NULL,
  block bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  points jsonb NOT NULL,
  meta jsonb NOT NULL
)`
await sql`CREATE INDEX IF NOT EXISTS venue_depth_curves_venue_observed_idx ON venue_depth_curves (venue, observed_at)`

console.log('venue_depth_curves: OK (IF NOT EXISTS)')
