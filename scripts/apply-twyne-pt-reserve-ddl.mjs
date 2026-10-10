// Separate prospective Aave PT reserve cash ledger for the tracked Twyne route.
// The measured asset is PT held by its Aave aToken contract, not wrapper cash.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS twyne_pt_reserve_observations (
    chain_id smallint NOT NULL CHECK (chain_id = 1),
    route_key text NOT NULL CHECK (route_key = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'),
    wrapper text NOT NULL CHECK (wrapper = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'),
    pt text NOT NULL CHECK (pt = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'),
    atoken text NOT NULL CHECK (atoken = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545'),
    pool text NOT NULL CHECK (pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'),
    block bigint NOT NULL CHECK (block > 0),
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL,
    pt_decimals smallint NOT NULL CHECK (pt_decimals BETWEEN 0 AND 36),
    aave_pt_reserve_cash_raw numeric(78,0) NOT NULL
      CHECK (aave_pt_reserve_cash_raw BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935),
    first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (wrapper, block),
    CHECK (observed_at <= first_local_receipt_at + interval '2 minutes'),
    CHECK (first_local_receipt_at - observed_at <= interval '1 hour')
  )`
  await sql`CREATE INDEX IF NOT EXISTS twyne_pt_reserve_latest_idx
    ON twyne_pt_reserve_observations (observed_at DESC, block DESC)`
  // A caller cannot fabricate an earlier local receipt to admit historical
  // data to this prospective table. Backfills use a separate ledger.
  await sql`CREATE OR REPLACE FUNCTION twyne_pt_reserve_stamp_receipt()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.first_local_receipt_at := clock_timestamp();
      IF NEW.observed_at < NEW.first_local_receipt_at - interval '1 hour'
        OR NEW.observed_at > NEW.first_local_receipt_at + interval '2 minutes'
      THEN RAISE EXCEPTION 'Twyne PT reserve source is not fresh'; END IF;
      RETURN NEW;
    END $$`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_reserve_stamp_insert ON twyne_pt_reserve_observations`
  await sql`CREATE TRIGGER twyne_pt_reserve_stamp_insert
    BEFORE INSERT ON twyne_pt_reserve_observations
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_reserve_stamp_receipt()`
  await sql`CREATE OR REPLACE FUNCTION twyne_pt_reserve_forbid_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Twyne PT reserve observations are append-only';
    END $$`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_reserve_no_update_delete ON twyne_pt_reserve_observations`
  await sql`CREATE TRIGGER twyne_pt_reserve_no_update_delete
    BEFORE UPDATE OR DELETE ON twyne_pt_reserve_observations
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_reserve_forbid_mutation()`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_reserve_no_truncate ON twyne_pt_reserve_observations`
  await sql`CREATE TRIGGER twyne_pt_reserve_no_truncate
    BEFORE TRUNCATE ON twyne_pt_reserve_observations
    FOR EACH STATEMENT EXECUTE FUNCTION twyne_pt_reserve_forbid_mutation()`
  await sql`CREATE OR REPLACE FUNCTION twyne_pt_reserve_record(p jsonb)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE old twyne_pt_reserve_observations%ROWTYPE;
      inserted_count integer;
    BEGIN
      IF jsonb_typeof(p) IS DISTINCT FROM 'object'
        OR p->>'routeKey' IS DISTINCT FROM 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'
        OR p->>'wrapper' IS DISTINCT FROM '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
        OR p->>'pt' IS DISTINCT FROM '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'
        OR p->>'aToken' IS DISTINCT FROM '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545'
        OR p->>'pool' IS DISTINCT FROM '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
        OR p->>'chainId' IS DISTINCT FROM '1'
        OR p->>'block' !~ '^[1-9][0-9]*$'
        OR p->>'blockHash' !~ '^0x[0-9a-f]{64}$'
        OR p->>'aavePtReserveCashRaw' !~ '^(0|[1-9][0-9]*)$'
        OR p->>'ptDecimals' !~ '^(0|[1-9][0-9]*)$'
        OR p->>'observedAt' IS NULL
      THEN RAISE EXCEPTION 'invalid Twyne PT reserve receipt'; END IF;
      INSERT INTO twyne_pt_reserve_observations
        (chain_id, route_key, wrapper, pt, atoken, pool, block,
         block_hash, observed_at, pt_decimals, aave_pt_reserve_cash_raw)
      VALUES ((p->>'chainId')::smallint, p->>'routeKey', p->>'wrapper', p->>'pt',
        p->>'aToken', p->>'pool', (p->>'block')::bigint, p->>'blockHash',
        (p->>'observedAt')::timestamptz, (p->>'ptDecimals')::smallint,
        (p->>'aavePtReserveCashRaw')::numeric)
      ON CONFLICT (wrapper, block) DO NOTHING;
      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      SELECT * INTO old FROM twyne_pt_reserve_observations
        WHERE wrapper = p->>'wrapper' AND block = (p->>'block')::bigint FOR SHARE;
      IF NOT FOUND
        OR old.chain_id IS DISTINCT FROM (p->>'chainId')::smallint
        OR old.route_key IS DISTINCT FROM p->>'routeKey'
        OR old.pt IS DISTINCT FROM p->>'pt'
        OR old.atoken IS DISTINCT FROM p->>'aToken'
        OR old.pool IS DISTINCT FROM p->>'pool'
        OR old.block_hash IS DISTINCT FROM p->>'blockHash'
        OR old.observed_at IS DISTINCT FROM (p->>'observedAt')::timestamptz
        OR old.pt_decimals IS DISTINCT FROM (p->>'ptDecimals')::smallint
        OR old.aave_pt_reserve_cash_raw IS DISTINCT FROM (p->>'aavePtReserveCashRaw')::numeric
      THEN RAISE EXCEPTION 'Twyne PT reserve replay disagreement'; END IF;
      RETURN inserted_count = 1;
    END $$`
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('twyne_pt_database_url_required')
  await apply(neon(url))
  process.stdout.write('twyne_pt_reserve_observations ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Twyne PT reserve schema update failed closed.\n')
    process.exitCode = 1
  })
}
