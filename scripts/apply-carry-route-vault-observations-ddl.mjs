// Additive storage for finalized aggregate destination-vault observations.
// Run explicitly before record-carry-route-vaults.mjs; this script does not
// collect, backfill, or manufacture observations.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_route_vault_observations (
  route_key text NOT NULL,
  vault text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  block bigint NOT NULL CHECK (block > 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
  vault_decimals smallint NOT NULL CHECK (vault_decimals BETWEEN 0 AND 255),
  asset_decimals smallint NOT NULL CHECK (asset_decimals BETWEEN 0 AND 255),
  total_assets_raw numeric(78,0) NOT NULL CHECK (total_assets_raw >= 0),
  total_supply_raw numeric(78,0) NOT NULL CHECK (total_supply_raw >= 0),
  cash_raw numeric(78,0) NOT NULL CHECK (cash_raw >= 0),
  cohort_id text NOT NULL,
  seed_source_sha256 text NOT NULL CHECK (seed_source_sha256 ~ '^[0-9a-f]{64}$'),
  seed_sha256 text NOT NULL CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),
  board_sha256 text NOT NULL CHECK (board_sha256 ~ '^[0-9a-f]{64}$'),
  displayed_routes_sha256 text NOT NULL CHECK (displayed_routes_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (route_key, vault, block)
)`

  await sql`CREATE INDEX IF NOT EXISTS carry_route_vault_latest_idx
  ON carry_route_vault_observations (route_key, vault, observed_at DESC)`
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
  process.stdout.write('carry_route_vault_observations ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
