// Historical Aave PT reserve cash reconstruction. Never a live receipt.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS twyne_pt_reserve_backfill (
    anchor_at timestamptz NOT NULL,
    capture_kind text NOT NULL DEFAULT 'backfilled' CHECK (capture_kind = 'backfilled'),
    chain_id smallint NOT NULL CHECK (chain_id = 1),
    wrapper text NOT NULL CHECK (wrapper = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'),
    pt text NOT NULL CHECK (pt = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'),
    atoken text NOT NULL CHECK (atoken = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545'),
    pool text NOT NULL CHECK (pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'),
    block bigint NOT NULL CHECK (block > 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL,
    pt_decimals smallint NOT NULL CHECK (pt_decimals BETWEEN 0 AND 36),
    aave_pt_reserve_cash_raw numeric(78,0) NOT NULL CHECK (aave_pt_reserve_cash_raw >= 0),
    payload_bytes text NOT NULL,
    first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (anchor_at, wrapper),
    CHECK (observed_at <= anchor_at AND anchor_at - observed_at <= interval '15 minutes')
  )`
  await sql`CREATE INDEX IF NOT EXISTS twyne_pt_reserve_backfill_anchor_idx
    ON twyne_pt_reserve_backfill (anchor_at DESC)`
  await sql`CREATE OR REPLACE FUNCTION guard_twyne_pt_reserve_backfill()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE p jsonb;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.first_local_receipt_at := clock_timestamp();
        IF NEW.anchor_at >= NEW.first_local_receipt_at - interval '1 hour'
          THEN RAISE EXCEPTION 'twyne backfill anchor is not historical'; END IF;
        p := NEW.payload_bytes::jsonb;
        IF jsonb_typeof(p) IS DISTINCT FROM 'object'
          OR (p->>'anchorAt')::timestamptz IS DISTINCT FROM NEW.anchor_at
          OR p->>'captureKind' IS DISTINCT FROM NEW.capture_kind
          OR (p->>'chainId')::smallint IS DISTINCT FROM NEW.chain_id
          OR p->>'wrapper' IS DISTINCT FROM NEW.wrapper
          OR p->>'pt' IS DISTINCT FROM NEW.pt
          OR p->>'aToken' IS DISTINCT FROM NEW.atoken
          OR p->>'pool' IS DISTINCT FROM NEW.pool
          OR (p->>'block')::bigint IS DISTINCT FROM NEW.block
          OR p->>'blockHash' IS DISTINCT FROM NEW.block_hash
          OR (p->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
          OR (p->>'ptDecimals')::smallint IS DISTINCT FROM NEW.pt_decimals
          OR (p->>'aavePtReserveCashRaw')::numeric IS DISTINCT FROM NEW.aave_pt_reserve_cash_raw
        THEN RAISE EXCEPTION 'twyne backfill payload mismatch'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'twyne backfill immutable';
    END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'twyne_pt_backfill_guard'
      AND tgrelid = 'twyne_pt_reserve_backfill'::regclass
  ) THEN CREATE TRIGGER twyne_pt_backfill_guard
    BEFORE INSERT OR UPDATE OR DELETE ON twyne_pt_reserve_backfill
    FOR EACH ROW EXECUTE FUNCTION guard_twyne_pt_reserve_backfill(); END IF; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'twyne_pt_backfill_no_truncate'
      AND tgrelid = 'twyne_pt_reserve_backfill'::regclass
  ) THEN CREATE TRIGGER twyne_pt_backfill_no_truncate
    BEFORE TRUNCATE ON twyne_pt_reserve_backfill
    FOR EACH STATEMENT EXECUTE FUNCTION guard_twyne_pt_reserve_backfill(); END IF; END $$`
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
  process.stdout.write('twyne_pt_reserve_backfill ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Twyne PT reserve backfill schema failed closed.\n')
    process.exitCode = 1
  })
}
