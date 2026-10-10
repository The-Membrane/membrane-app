// Additive, prospective aggregate-cash persistence-baseline issue/score ledger.
// An issue is a DB-clock claim about one exact route/contract, not a holder exit quote.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_cash_issue_slots (
    slot_at timestamptz PRIMARY KEY,
    started_at timestamptz NOT NULL,
    subject_manifest_sha256 text NOT NULL CHECK (subject_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    subject_manifest jsonb NOT NULL CHECK (jsonb_typeof(subject_manifest) = 'array'),
    subject_count smallint NOT NULL CHECK (subject_count = 67),
    attempt_count smallint NOT NULL CHECK (attempt_count = 134),
    CHECK (slot_at = date_bin('15 minutes', started_at,
      '1970-01-01 00:00:00+00'::timestamptz))
  )`
  // Preserve old issue-time hourly slots whose capture began later in the hour.
  await sql`ALTER TABLE carry_cash_issue_slots
    DROP CONSTRAINT IF EXISTS carry_cash_issue_slots_check,
    DROP CONSTRAINT IF EXISTS carry_cash_issue_slots_utc_hour_check,
    DROP CONSTRAINT IF EXISTS carry_cash_issue_slots_utc_quarter_check,
    ADD CONSTRAINT carry_cash_issue_slots_utc_quarter_check
      CHECK (slot_at = date_bin('15 minutes', started_at,
        '1970-01-01 00:00:00+00'::timestamptz)
        OR (started_at < '2026-09-29 10:00:00+00'::timestamptz
          AND slot_at = date_trunc('hour', started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))`

  await sql`CREATE TABLE IF NOT EXISTS carry_cash_issue_attempts (
    slot_at timestamptz NOT NULL REFERENCES carry_cash_issue_slots(slot_at),
    route_key text NOT NULL,
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    source_kind text NOT NULL CHECK (source_kind IN ('vault', 'market')),
    source_venue_kind text CHECK (source_venue_kind IN ('aave_v3_atoken', 'compound_v3_comet', 'spark_lend_atoken')),
    horizon_hours smallint NOT NULL CHECK (horizon_hours IN (1, 24)),
    status text NOT NULL CHECK (status IN ('issued', 'source_unavailable', 'source_invalid', 'unassessed')),
    issued_at timestamptz NOT NULL,
    target_at timestamptz NOT NULL,
    target_low_at timestamptz NOT NULL,
    target_high_at timestamptz NOT NULL,
    score_after_at timestamptz NOT NULL,
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    asset_decimals smallint CHECK (asset_decimals BETWEEN 0 AND 36),
    source_block bigint CHECK (source_block > 0),
    source_block_hash text CHECK (source_block_hash ~ '^0x[0-9a-f]{64}$'),
    source_observed_at timestamptz,
    source_first_local_receipt_at timestamptz,
    source_cash_raw numeric(78,0) CHECK (source_cash_raw >= 0),
    forecast_cash_raw numeric(78,0) CHECK (forecast_cash_raw >= 0),
    cohort_id text,
    seed_source_sha256 text CHECK (seed_source_sha256 ~ '^[0-9a-f]{64}$'),
    seed_sha256 text CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),
    board_sha256 text CHECK (board_sha256 ~ '^[0-9a-f]{64}$'),
    displayed_routes_sha256 text CHECK (displayed_routes_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (slot_at, route_key, destination, horizon_hours),
    CHECK (target_at = issued_at + make_interval(hours => horizon_hours)),
    CHECK (target_low_at = target_at - CASE horizon_hours WHEN 1 THEN interval '15 minutes' ELSE interval '1 hour' END),
    CHECK (target_high_at = target_at + CASE horizon_hours WHEN 1 THEN interval '15 minutes' ELSE interval '1 hour' END),
    CHECK (score_after_at = target_high_at + interval '1 hour'),
    CHECK ((source_kind = 'vault' AND source_venue_kind IS NULL)
      OR (source_kind = 'market' AND source_venue_kind IS NOT NULL)),
    CHECK ((status = 'issued' AND asset_decimals IS NOT NULL AND source_block IS NOT NULL
      AND source_block_hash IS NOT NULL AND source_observed_at IS NOT NULL
      AND source_first_local_receipt_at IS NOT NULL AND source_cash_raw IS NOT NULL
      AND forecast_cash_raw = source_cash_raw AND source_first_local_receipt_at <= issued_at
      AND source_observed_at <= source_first_local_receipt_at)
      OR (status <> 'issued' AND forecast_cash_raw IS NULL))
  )`

  await sql`CREATE INDEX IF NOT EXISTS carry_cash_issue_due_idx
    ON carry_cash_issue_attempts (score_after_at, slot_at) WHERE status = 'issued'`
  await sql`CREATE INDEX IF NOT EXISTS carry_cash_issue_subject_idx
    ON carry_cash_issue_attempts (route_key, destination, horizon_hours, slot_at)`

  await sql`CREATE TABLE IF NOT EXISTS carry_cash_issue_scores (
    slot_at timestamptz NOT NULL,
    route_key text NOT NULL,
    destination text NOT NULL,
    horizon_hours smallint NOT NULL,
    status text NOT NULL CHECK (status IN ('observed', 'censored_missing')),
    scored_at timestamptz NOT NULL,
    outcome_block bigint CHECK (outcome_block > 0),
    outcome_block_hash text CHECK (outcome_block_hash ~ '^0x[0-9a-f]{64}$'),
    outcome_observed_at timestamptz,
    outcome_first_local_receipt_at timestamptz,
    outcome_cash_raw numeric(78,0) CHECK (outcome_cash_raw >= 0),
    absolute_error_raw numeric(78,0) CHECK (absolute_error_raw >= 0),
    PRIMARY KEY (slot_at, route_key, destination, horizon_hours),
    FOREIGN KEY (slot_at, route_key, destination, horizon_hours)
      REFERENCES carry_cash_issue_attempts (slot_at, route_key, destination, horizon_hours),
    CHECK ((status = 'observed' AND outcome_block IS NOT NULL AND outcome_block_hash IS NOT NULL
      AND outcome_observed_at IS NOT NULL AND outcome_first_local_receipt_at IS NOT NULL
      AND outcome_cash_raw IS NOT NULL AND absolute_error_raw IS NOT NULL)
      OR (status = 'censored_missing' AND outcome_block IS NULL AND outcome_block_hash IS NULL
      AND outcome_observed_at IS NULL AND outcome_first_local_receipt_at IS NULL
      AND outcome_cash_raw IS NULL AND absolute_error_raw IS NULL))
  )`

  await sql`CREATE OR REPLACE FUNCTION reject_carry_cash_issue_ledger_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'carry cash issue ledger is append only'; END; $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_issue_slots_immutable'
  ) THEN CREATE TRIGGER carry_cash_issue_slots_immutable
    BEFORE UPDATE OR DELETE ON carry_cash_issue_slots
    FOR EACH ROW EXECUTE FUNCTION reject_carry_cash_issue_ledger_mutation(); END IF; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_issue_attempts_immutable'
  ) THEN CREATE TRIGGER carry_cash_issue_attempts_immutable
    BEFORE UPDATE OR DELETE ON carry_cash_issue_attempts
    FOR EACH ROW EXECUTE FUNCTION reject_carry_cash_issue_ledger_mutation(); END IF; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_issue_scores_immutable'
  ) THEN CREATE TRIGGER carry_cash_issue_scores_immutable
    BEFORE UPDATE OR DELETE ON carry_cash_issue_scores
    FOR EACH ROW EXECUTE FUNCTION reject_carry_cash_issue_ledger_mutation(); END IF; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_issue_slots_immutable_truncate'
  ) THEN CREATE TRIGGER carry_cash_issue_slots_immutable_truncate
    BEFORE TRUNCATE ON carry_cash_issue_slots
    FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_cash_issue_ledger_mutation(); END IF; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_issue_attempts_immutable_truncate'
  ) THEN CREATE TRIGGER carry_cash_issue_attempts_immutable_truncate
    BEFORE TRUNCATE ON carry_cash_issue_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_cash_issue_ledger_mutation(); END IF; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_issue_scores_immutable_truncate'
  ) THEN CREATE TRIGGER carry_cash_issue_scores_immutable_truncate
    BEFORE TRUNCATE ON carry_cash_issue_scores
    FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_cash_issue_ledger_mutation(); END IF; END $$`
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
  process.stdout.write('carry_cash_issue_ledger ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Carry cash issue schema update failed closed.\n')
    process.exitCode = 1
  })
}
