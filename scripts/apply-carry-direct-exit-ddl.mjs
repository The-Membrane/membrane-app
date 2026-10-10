// Prospective exact-holder direct-market exit labels. Additive; no claims are issued here.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_direct_exit_attempts (
    id bigserial PRIMARY KEY,
    tick_slot bigint NOT NULL CHECK (tick_slot > 0),
    market_kind text NOT NULL CHECK (market_kind IN
      ('aaveV3Usdc','sparkLendUsdt','compoundV3Usdc')),
    route_key text,
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    status text NOT NULL CHECK (status IN ('issued','unavailable')),
    unavailable_reason text CHECK (unavailable_reason IN
      ('no_recent_event_candidate','sampled_candidate_exhausted','quote_unavailable')),
    candidate_event text CHECK (candidate_event IN ('atoken_transfer_recipient','comet_supply')),
    candidate_event_block bigint CHECK (candidate_event_block > 0),
    holder text CHECK (holder ~ '^0x[0-9a-f]{40}$'),
    assets_raw numeric(78,0) CHECK (assets_raw > 0),
    holder_balance_raw numeric(78,0) CHECK (holder_balance_raw >= 0),
    source_block bigint CHECK (source_block > 0),
    source_hash text CHECK (source_hash ~ '^0x[0-9a-f]{64}$'),
    source_block_at timestamptz,
    source_observed_at timestamptz,
    issue_simulation text CHECK (issue_simulation IN ('success','evm_revert')),
    caller_checksum_sha256 text NOT NULL CHECK (caller_checksum_sha256 ~ '^[0-9a-f]{64}$'),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    target_at timestamptz,
    UNIQUE (tick_slot, market_kind),
    CHECK ((status = 'unavailable' AND unavailable_reason IS NOT NULL
      AND route_key IS NULL AND candidate_event IS NULL AND candidate_event_block IS NULL AND holder IS NULL
      AND assets_raw IS NULL AND holder_balance_raw IS NULL AND source_block IS NULL
      AND source_hash IS NULL AND source_block_at IS NULL AND source_observed_at IS NULL
      AND issue_simulation IS NULL AND target_at IS NULL)
      OR (status = 'issued' AND unavailable_reason IS NULL AND route_key IS NOT NULL
      AND candidate_event IS NOT NULL AND candidate_event_block IS NOT NULL
      AND holder IS NOT NULL AND assets_raw IS NOT NULL
      AND holder_balance_raw >= assets_raw AND source_block IS NOT NULL
      AND source_hash IS NOT NULL AND source_block_at IS NOT NULL
      AND source_observed_at IS NOT NULL AND issue_simulation IS NOT NULL
      AND target_at IS NOT NULL))
  )`
  await sql`CREATE INDEX IF NOT EXISTS carry_direct_exit_due_idx
    ON carry_direct_exit_attempts(target_at) WHERE status='issued'`
  await sql`CREATE TABLE IF NOT EXISTS carry_direct_exit_outcomes (
    issue_id bigint PRIMARY KEY REFERENCES carry_direct_exit_attempts(id),
    tick_slot bigint NOT NULL CHECK (tick_slot > 0),
    market_kind text NOT NULL,
    route_key text NOT NULL,
    destination text NOT NULL,
    holder text NOT NULL,
    assets_raw numeric(78,0) NOT NULL,
    status text NOT NULL CHECK (status IN
      ('success','evm_revert','position_insufficient','missing')),
    missing_reason text CHECK (missing_reason IN
      ('target_window_missed','target_block_outside_window','quote_unavailable')),
    holder_balance_raw numeric(78,0),
    source_block bigint,
    source_hash text CHECK (source_hash ~ '^0x[0-9a-f]{64}$'),
    source_block_at timestamptz,
    source_observed_at timestamptz,
    caller_checksum_sha256 text NOT NULL CHECK (caller_checksum_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((status = 'missing' AND missing_reason IS NOT NULL
      AND holder_balance_raw IS NULL AND source_block IS NULL AND source_hash IS NULL
      AND source_block_at IS NULL AND source_observed_at IS NULL)
      OR (status <> 'missing' AND missing_reason IS NULL
      AND holder_balance_raw IS NOT NULL AND source_block IS NOT NULL
      AND source_hash IS NOT NULL AND source_block_at IS NOT NULL
      AND source_observed_at IS NOT NULL)),
    CHECK ((status IN ('success','evm_revert') AND holder_balance_raw >= assets_raw)
      OR (status='position_insufficient' AND holder_balance_raw < assets_raw)
      OR status='missing')
  )`
  await sql`CREATE OR REPLACE FUNCTION guard_carry_direct_exit_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n timestamptz := clock_timestamp();
      slot bigint := floor(extract(epoch FROM n)/900)::bigint;
      issue carry_direct_exit_attempts%ROWTYPE;
      want_route text; want_dest text;
    BEGIN
      PERFORM pg_advisory_xact_lock(720050, (slot % 2147483647)::integer);
      IF NEW.tick_slot <> slot OR floor(extract(epoch FROM clock_timestamp())/900)::bigint <> slot
      THEN RAISE EXCEPTION 'direct_exit_slot_invalid'; END IF;
      IF TG_TABLE_NAME = 'carry_direct_exit_attempts' THEN
        CASE NEW.market_kind
          WHEN 'aaveV3Usdc' THEN want_route := 'USDC → supply on Aave V3';
            want_dest := '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
          WHEN 'sparkLendUsdt' THEN want_route := 'USDT → supply on Spark';
            want_dest := '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f';
          WHEN 'compoundV3Usdc' THEN want_route := 'USDC → supply on Compound v3';
            want_dest := '0xc3d688b66703497daa19211eedff47f25384cdc3';
          ELSE RAISE EXCEPTION 'direct_exit_market_unknown';
        END CASE;
        IF NEW.destination <> want_dest OR
          (NEW.status='issued' AND NEW.route_key <> want_route) OR
          NEW.issued_at < n - interval '1 minute' OR NEW.issued_at > n + interval '1 second' OR
          (SELECT count(*) FROM carry_direct_exit_attempts WHERE tick_slot=slot) >= 3
        THEN RAISE EXCEPTION 'direct_exit_issue_invalid'; END IF;
        IF NEW.status='issued' THEN
          IF NEW.source_block_at > NEW.issued_at OR
             NEW.source_block_at < NEW.issued_at - interval '25 minutes' OR
             NEW.candidate_event_block > NEW.source_block OR
             (NEW.market_kind='compoundV3Usdc' AND NEW.candidate_event <> 'comet_supply') OR
             (NEW.market_kind<>'compoundV3Usdc' AND NEW.candidate_event <> 'atoken_transfer_recipient') OR
             NEW.source_observed_at < NEW.source_block_at OR
             NEW.source_observed_at > n + interval '1 minute' OR
             NEW.target_at <> NEW.source_block_at + interval '1 hour'
          THEN RAISE EXCEPTION 'direct_exit_issue_source_invalid'; END IF;
        END IF;
      ELSE
        SELECT * INTO issue FROM carry_direct_exit_attempts WHERE id=NEW.issue_id;
        IF NOT FOUND OR issue.status <> 'issued' OR
          NEW.market_kind IS DISTINCT FROM issue.market_kind OR
          NEW.route_key IS DISTINCT FROM issue.route_key OR
          NEW.destination IS DISTINCT FROM issue.destination OR
          NEW.holder IS DISTINCT FROM issue.holder OR
          NEW.assets_raw IS DISTINCT FROM issue.assets_raw OR
          NEW.recorded_at < n - interval '1 minute' OR
          NEW.recorded_at > n + interval '1 second' OR
          (SELECT count(*) FROM carry_direct_exit_outcomes WHERE tick_slot=slot) >= 6
        THEN RAISE EXCEPTION 'direct_exit_score_invalid'; END IF;
        IF NEW.status='missing' THEN
          IF n <= issue.target_at + interval '15 minutes'
          THEN RAISE EXCEPTION 'direct_exit_missing_early'; END IF;
        ELSE
          IF n < issue.target_at - interval '15 minutes' OR
             n > issue.target_at + interval '15 minutes' OR
             NEW.source_block <= issue.source_block OR
             NEW.source_block_at < issue.target_at - interval '15 minutes' OR
             NEW.source_block_at > issue.target_at + interval '15 minutes' OR
             NEW.source_observed_at < NEW.source_block_at OR
             NEW.source_observed_at > n + interval '1 minute'
          THEN RAISE EXCEPTION 'direct_exit_score_source_invalid'; END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$`
  await sql`CREATE OR REPLACE FUNCTION reject_carry_direct_exit_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'direct_exit_ledger_append_only'; END $$`
  for (const table of ['carry_direct_exit_attempts', 'carry_direct_exit_outcomes']) {
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${table}'::regclass AND tgname='${table}_insert_guard') THEN CREATE TRIGGER ${table}_insert_guard BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION guard_carry_direct_exit_insert(); END IF; END $$`,
    )
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${table}'::regclass AND tgname='${table}_immutable') THEN CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_carry_direct_exit_mutation(); END IF; END $$`,
    )
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${table}'::regclass AND tgname='${table}_truncate') THEN CREATE TRIGGER ${table}_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_direct_exit_mutation(); END IF; END $$`,
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  apply(neon(url))
    .then(() => process.stdout.write('carry_direct_exit ready\n'))
    .catch(() => {
      process.stderr.write('carry_direct_exit_ddl_failed\n')
      process.exitCode = 1
    })
}
