// Historical reconstruction only. This table is deliberately separate from
// prospective observations and cannot certify a live forecast issue.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_cash_backfill (
    anchor_at timestamptz NOT NULL,
    route_key text NOT NULL,
    subject_kind text NOT NULL CHECK (subject_kind IN ('vault', 'direct')),
    venue_kind text NOT NULL,
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    capture_kind text NOT NULL DEFAULT 'backfilled' CHECK (capture_kind = 'backfilled'),
    chain_id smallint NOT NULL CHECK (chain_id = 1),
    block bigint NOT NULL CHECK (block > 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    block_at timestamptz NOT NULL,
    asset text CHECK (asset IS NULL OR asset ~ '^0x[0-9a-f]{40}$'),
    share_decimals smallint CHECK (share_decimals IS NULL OR share_decimals BETWEEN 0 AND 255),
    asset_decimals smallint CHECK (asset_decimals IS NULL OR asset_decimals BETWEEN 0 AND 255),
    cash_raw numeric(78,0) CHECK (cash_raw IS NULL OR cash_raw >= 0),
    state text NOT NULL CHECK (state IN
      ('observed', 'no_code', 'read_unavailable', 'identity_mismatch', 'unassessed')),
    reason text,
    cohort_id text,
    subject_manifest_sha256 text NOT NULL CHECK (subject_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    seed_source_sha256 text CHECK (seed_source_sha256 IS NULL OR seed_source_sha256 ~ '^[0-9a-f]{64}$'),
    seed_sha256 text CHECK (seed_sha256 IS NULL OR seed_sha256 ~ '^[0-9a-f]{64}$'),
    board_sha256 text CHECK (board_sha256 IS NULL OR board_sha256 ~ '^[0-9a-f]{64}$'),
    displayed_routes_sha256 text CHECK
      (displayed_routes_sha256 IS NULL OR displayed_routes_sha256 ~ '^[0-9a-f]{64}$'),
    payload_bytes text NOT NULL,
    first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (anchor_at, route_key, destination),
    CHECK ((state = 'observed' AND asset IS NOT NULL AND share_decimals IS NOT NULL
      AND asset_decimals IS NOT NULL
      AND cash_raw IS NOT NULL AND reason IS NULL)
      OR (state <> 'observed' AND asset IS NULL AND share_decimals IS NULL
        AND asset_decimals IS NULL AND cash_raw IS NULL AND reason IS NOT NULL))
  )`
  await sql`CREATE INDEX IF NOT EXISTS carry_cash_backfill_subject_time_idx
    ON carry_cash_backfill (route_key, destination, anchor_at DESC)`
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  await apply(neon(url))
  process.stdout.write('carry_cash_backfill ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Carry cash backfill schema update failed closed.\n')
    process.exitCode = 1
  })
}
