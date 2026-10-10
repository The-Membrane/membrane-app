// Append-only storage for finalized Aave/Compound/Spark direct-supply cash.
// first_local_receipt_at is the database insert clock, not an independently
// witnessed publication or a holder-specific executable exit observation.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_direct_supply_observations (
    route_key text NOT NULL,
    venue_kind text NOT NULL CHECK (venue_kind IN ('aave_v3_atoken', 'compound_v3_comet', 'spark_lend_atoken')),
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    underlying text NOT NULL CHECK (underlying ~ '^0x[0-9a-f]{40}$'),
    underlying_decimals smallint NOT NULL CHECK (underlying_decimals = 6),
    chain_id smallint NOT NULL CHECK (chain_id = 1),
    block bigint NOT NULL CHECK (block > 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL,
    first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    cash_raw numeric(78,0) NOT NULL CHECK (cash_raw >= 0),
    total_supply_raw numeric(78,0) NOT NULL CHECK (total_supply_raw >= 0),
    PRIMARY KEY (route_key, destination, block)
  )`
  // Existing tables have the original two-market CHECK. Replace it in one
  // statement so Spark inserts never require an unconstrained interval.
  await sql`ALTER TABLE carry_direct_supply_observations
    DROP CONSTRAINT IF EXISTS carry_direct_supply_observations_venue_kind_check,
    ADD CONSTRAINT carry_direct_supply_observations_venue_kind_check
      CHECK (venue_kind IN ('aave_v3_atoken', 'compound_v3_comet', 'spark_lend_atoken'))`
  await sql`CREATE INDEX IF NOT EXISTS carry_direct_supply_latest_idx
    ON carry_direct_supply_observations (route_key, destination, observed_at DESC)`
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('DATABASE_URL_UNPOOLED_or_DATABASE_URL_required')
  await apply(neon(url))
  process.stdout.write('carry_direct_supply_observations ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Connection exceptions can include credential-bearing database URLs.
    process.stderr.write('Carry direct-supply schema update failed closed.\n')
    process.exitCode = 1
  })
}
