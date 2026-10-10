// Immutable H1 model ledger for Aave PT reserve cash, separate from Twyne
// wrapper idle cash and any holder-executable withdrawal evidence.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS twyne_pt_model_artifacts (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    model_version text NOT NULL UNIQUE CHECK (model_version ~ '^hband1-[0-9]+-[0-9]+$'),
    metric text NOT NULL CHECK (metric = 'aave_pt_reserve_cash_raw'),
    route_key text NOT NULL CHECK (route_key = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'),
    wrapper text NOT NULL CHECK (wrapper = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'),
    pt text NOT NULL CHECK (pt = '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'),
    atoken text NOT NULL CHECK (atoken = '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545'),
    pool text NOT NULL CHECK (pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'),
    asset_decimals smallint NOT NULL CHECK (asset_decimals BETWEEN 0 AND 36),
    horizon_hours smallint NOT NULL CHECK (horizon_hours = 1),
    first_archive_anchor_at timestamptz NOT NULL,
    last_archive_anchor_at timestamptz NOT NULL,
    archive_anchors smallint NOT NULL CHECK (archive_anchors BETWEEN 120 AND 720),
    fit_pairs smallint NOT NULL CHECK (fit_pairs >= 20),
    calibration_pairs smallint NOT NULL CHECK (calibration_pairs >= 20),
    holdout_pairs smallint NOT NULL CHECK (holdout_pairs >= 20),
    holdout_covered smallint NOT NULL,
    calibration_change_p05_raw numeric(79,0) NOT NULL,
    calibration_change_p95_raw numeric(79,0) NOT NULL,
    payload_bytes text NOT NULL,
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (sha256 = encode(sha256(convert_to(payload_bytes, 'UTF8')), 'hex')),
    CHECK (first_archive_anchor_at < last_archive_anchor_at),
    CHECK (fit_pairs + calibration_pairs + holdout_pairs = archive_anchors / 2),
    CHECK (holdout_covered BETWEEN 0 AND holdout_pairs),
    CHECK (holdout_covered * 100 >= holdout_pairs * 80),
    CHECK (calibration_change_p05_raw <= calibration_change_p95_raw)
  )`
  await sql`CREATE OR REPLACE FUNCTION twyne_pt_model_artifact_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE p jsonb;
    BEGIN
      NEW.registered_at := clock_timestamp();
      p := NEW.payload_bytes::jsonb;
      IF jsonb_typeof(p) IS DISTINCT FROM 'object'
        OR p->>'kind' IS DISTINCT FROM 'historical_aave_pt_reserve_persistence_band_v1'
        OR p->>'metric' IS DISTINCT FROM NEW.metric
        OR p->>'routeKey' IS DISTINCT FROM NEW.route_key
        OR p->>'wrapper' IS DISTINCT FROM NEW.wrapper
        OR p->>'pt' IS DISTINCT FROM NEW.pt
        OR p->>'aToken' IS DISTINCT FROM NEW.atoken
        OR p->>'pool' IS DISTINCT FROM NEW.pool
        OR (p->>'assetDecimals')::smallint IS DISTINCT FROM NEW.asset_decimals
        OR (p->>'horizonHours')::smallint IS DISTINCT FROM NEW.horizon_hours
        OR (p->>'firstArchiveAnchorAt')::timestamptz IS DISTINCT FROM NEW.first_archive_anchor_at
        OR (p->>'lastArchiveAnchorAt')::timestamptz IS DISTINCT FROM NEW.last_archive_anchor_at
        OR (p->>'archiveAnchors')::smallint IS DISTINCT FROM NEW.archive_anchors
        OR (p->'counts'->>'fit')::smallint IS DISTINCT FROM NEW.fit_pairs
        OR (p->'counts'->>'calibration')::smallint IS DISTINCT FROM NEW.calibration_pairs
        OR (p->'counts'->>'holdout')::smallint IS DISTINCT FROM NEW.holdout_pairs
        OR (p->'baselineBand'->>'holdoutCovered')::smallint IS DISTINCT FROM NEW.holdout_covered
        OR (p->'baselineBand'->>'holdoutTotal')::smallint IS DISTINCT FROM NEW.holdout_pairs
        OR p->'baselineBand'->>'coveragePassed' IS DISTINCT FROM 'true'
        OR p->>'fitMedianDeltaRaw' IS DISTINCT FROM '0'
        OR (p->>'calibrationResidualP05Raw')::numeric IS DISTINCT FROM NEW.calibration_change_p05_raw
        OR (p->>'calibrationResidualP95Raw')::numeric IS DISTINCT FROM NEW.calibration_change_p95_raw
        OR (p->'baselineBand'->>'calibrationChangeP05Raw')::numeric IS DISTINCT FROM NEW.calibration_change_p05_raw
        OR (p->'baselineBand'->>'calibrationChangeP95Raw')::numeric IS DISTINCT FROM NEW.calibration_change_p95_raw
        OR p->>'historicalBacktestOnly' IS DISTINCT FROM 'true'
        OR p->>'prospectiveValidated' IS DISTINCT FROM 'false'
        OR p->>'holderExecutableExit' IS DISTINCT FROM 'false'
        OR jsonb_typeof(p->'pairs') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p->'pairs') IS DISTINCT FROM NEW.fit_pairs + NEW.calibration_pairs + NEW.holdout_pairs
        OR jsonb_typeof(p->'anchors') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p->'anchors') IS DISTINCT FROM NEW.archive_anchors
        OR (SELECT count(*) FROM twyne_pt_reserve_backfill b
          WHERE b.wrapper = NEW.wrapper AND b.anchor_at BETWEEN
            NEW.first_archive_anchor_at AND NEW.last_archive_anchor_at) <> NEW.archive_anchors
        OR (SELECT count(DISTINCT x."anchorAt") FROM jsonb_to_recordset(p->'anchors') AS x(
            "anchorAt" timestamptz, block bigint, "blockHash" text,
            "observedAt" timestamptz, "ptDecimals" smallint,
            "aavePtReserveCashRaw" numeric, "backfillPayloadSha256" text)
          JOIN twyne_pt_reserve_backfill b ON b.wrapper = NEW.wrapper
            AND b.anchor_at = x."anchorAt" AND b.block = x.block
            AND b.block_hash = x."blockHash"
            AND b.observed_at = x."observedAt"
            AND b.pt_decimals = x."ptDecimals"
            AND b.aave_pt_reserve_cash_raw = x."aavePtReserveCashRaw"
            AND encode(sha256(convert_to(b.payload_bytes, 'UTF8')), 'hex') = x."backfillPayloadSha256"
          WHERE b.anchor_at BETWEEN NEW.first_archive_anchor_at AND NEW.last_archive_anchor_at)
          <> NEW.archive_anchors
        OR NEW.last_archive_anchor_at >= NEW.registered_at
      THEN RAISE EXCEPTION 'Twyne PT model artifact invalid'; END IF;
      RETURN NEW;
    END $$`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_artifact_insert ON twyne_pt_model_artifacts`
  await sql`CREATE TRIGGER twyne_pt_model_artifact_insert
    BEFORE INSERT ON twyne_pt_model_artifacts
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_model_artifact_guard()`

  await sql`CREATE TABLE IF NOT EXISTS twyne_pt_model_issues (
    slot_at timestamptz PRIMARY KEY,
    metric text NOT NULL CHECK (metric = 'aave_pt_reserve_cash_raw'),
    route_key text NOT NULL CHECK (route_key = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'),
    wrapper text NOT NULL CHECK (wrapper = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'),
    horizon_hours smallint NOT NULL CHECK (horizon_hours = 1),
    status text NOT NULL CHECK (status IN ('issued', 'artifact_unavailable', 'source_missing')),
    reason text,
    artifact_sha256 text REFERENCES twyne_pt_model_artifacts(sha256),
    source_block bigint,
    source_block_hash text,
    source_observed_at timestamptz,
    source_first_local_receipt_at timestamptz,
    source_asset_decimals smallint,
    source_cash_raw numeric(78,0),
    forecast_point_raw numeric(78,0),
    forecast_low_raw numeric(78,0),
    forecast_high_raw numeric(78,0),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    target_at timestamptz,
    target_low_at timestamptz,
    target_high_at timestamptz,
    score_after_at timestamptz,
    FOREIGN KEY (wrapper, source_block)
      REFERENCES twyne_pt_reserve_observations(wrapper, block),
    CHECK (slot_at = date_bin('15 minutes', slot_at,
      '1970-01-01 00:00:00+00'::timestamptz)),
    CHECK (status <> 'issued' OR (artifact_sha256 IS NOT NULL AND source_block IS NOT NULL
      AND source_block_hash IS NOT NULL AND source_observed_at IS NOT NULL
      AND source_first_local_receipt_at IS NOT NULL AND source_asset_decimals IS NOT NULL
      AND source_cash_raw IS NOT NULL AND forecast_point_raw IS NOT NULL
      AND forecast_low_raw IS NOT NULL AND forecast_high_raw IS NOT NULL
      AND forecast_low_raw <= forecast_high_raw AND reason IS NULL)),
    CHECK (status = 'issued' OR (artifact_sha256 IS NULL AND source_block IS NULL
      AND source_block_hash IS NULL AND source_observed_at IS NULL
      AND source_first_local_receipt_at IS NULL AND source_asset_decimals IS NULL
      AND source_cash_raw IS NULL AND forecast_point_raw IS NULL
      AND forecast_low_raw IS NULL AND forecast_high_raw IS NULL AND reason IS NOT NULL))
  )`
  await sql`ALTER TABLE twyne_pt_model_issues
    DROP CONSTRAINT IF EXISTS twyne_pt_model_issues_slot_at_check`
  await sql`ALTER TABLE twyne_pt_model_issues
    DROP CONSTRAINT IF EXISTS twyne_pt_model_issues_slot_15m_check`
  await sql`ALTER TABLE twyne_pt_model_issues
    ADD CONSTRAINT twyne_pt_model_issues_slot_15m_check
    CHECK (slot_at = date_bin('15 minutes', slot_at,
      '1970-01-01 00:00:00+00'::timestamptz))`
  await sql`CREATE INDEX IF NOT EXISTS twyne_pt_model_issues_due_idx
    ON twyne_pt_model_issues(score_after_at, slot_at) WHERE status = 'issued'`
  await sql`CREATE OR REPLACE FUNCTION twyne_pt_model_issue_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE a twyne_pt_model_artifacts%ROWTYPE;
      s twyne_pt_reserve_observations%ROWTYPE;
      cap numeric := power(2::numeric, 256) - 1;
      stamp timestamptz;
    BEGIN
      stamp := clock_timestamp();
      NEW.issued_at := stamp;
      NEW.slot_at := date_bin('15 minutes', stamp,
        '1970-01-01 00:00:00+00'::timestamptz);
      IF NEW.status = 'issued' THEN
        SELECT * INTO a FROM twyne_pt_model_artifacts WHERE sha256 = NEW.artifact_sha256;
        SELECT * INTO s FROM twyne_pt_reserve_observations
          WHERE wrapper = NEW.wrapper AND block = NEW.source_block;
        -- JS Date loses PostgreSQL microseconds; bind the exact stored receipt.
        NEW.source_first_local_receipt_at := s.first_local_receipt_at;
        NEW.target_at := s.observed_at + interval '1 hour';
        NEW.target_low_at := NEW.target_at - interval '15 minutes';
        NEW.target_high_at := NEW.target_at + interval '15 minutes';
        NEW.score_after_at := NEW.target_at + interval '1 hour';
        IF a.sha256 IS NULL OR s.block IS NULL
          THEN RAISE EXCEPTION 'Twyne PT model issue source missing'; END IF;
        IF a.registered_at > stamp OR a.last_archive_anchor_at >= s.observed_at
          OR s.first_local_receipt_at > stamp
          OR s.first_local_receipt_at < stamp - interval '5 minutes'
          OR s.observed_at > stamp OR s.observed_at < stamp - interval '30 minutes'
          OR NEW.target_low_at <= stamp
          THEN RAISE EXCEPTION 'Twyne PT model issue source clock invalid'; END IF;
        IF s.pt_decimals <> a.asset_decimals
          OR s.block_hash IS DISTINCT FROM NEW.source_block_hash
          OR s.observed_at IS DISTINCT FROM NEW.source_observed_at
          OR s.pt_decimals IS DISTINCT FROM NEW.source_asset_decimals
          OR s.aave_pt_reserve_cash_raw IS DISTINCT FROM NEW.source_cash_raw
          THEN RAISE EXCEPTION 'Twyne PT model issue source identity invalid'; END IF;
        IF NEW.forecast_point_raw IS DISTINCT FROM s.aave_pt_reserve_cash_raw
          OR NEW.forecast_low_raw IS DISTINCT FROM greatest(0, least(cap,
            s.aave_pt_reserve_cash_raw + a.calibration_change_p05_raw))
          OR NEW.forecast_high_raw IS DISTINCT FROM greatest(0, least(cap,
            s.aave_pt_reserve_cash_raw + a.calibration_change_p95_raw))
          THEN RAISE EXCEPTION 'Twyne PT model issue arithmetic invalid'; END IF;
      ELSE
        NEW.target_at := stamp + interval '1 hour';
        NEW.target_low_at := NEW.target_at - interval '15 minutes';
        NEW.target_high_at := NEW.target_at + interval '15 minutes';
        NEW.score_after_at := NEW.target_at + interval '1 hour';
      END IF;
      RETURN NEW;
    END $$`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_issue_insert ON twyne_pt_model_issues`
  await sql`CREATE TRIGGER twyne_pt_model_issue_insert
    BEFORE INSERT ON twyne_pt_model_issues
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_model_issue_guard()`

  await sql`CREATE TABLE IF NOT EXISTS twyne_pt_model_scores (
    slot_at timestamptz PRIMARY KEY REFERENCES twyne_pt_model_issues(slot_at),
    wrapper text NOT NULL CHECK (wrapper = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'),
    status text NOT NULL CHECK (status IN ('observed', 'censored_missing')),
    candidate_block bigint,
    candidate_block_hash text,
    candidate_observed_at timestamptz,
    candidate_first_local_receipt_at timestamptz,
    outcome_cash_raw numeric(78,0),
    point_absolute_error_raw numeric(78,0),
    persistence_absolute_error_raw numeric(78,0),
    band_covered boolean,
    scored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (wrapper, candidate_block)
      REFERENCES twyne_pt_reserve_observations(wrapper, block),
    CHECK ((status = 'observed' AND candidate_block IS NOT NULL
      AND candidate_block_hash IS NOT NULL AND candidate_observed_at IS NOT NULL
      AND candidate_first_local_receipt_at IS NOT NULL AND outcome_cash_raw IS NOT NULL
      AND point_absolute_error_raw IS NOT NULL AND persistence_absolute_error_raw IS NOT NULL
      AND band_covered IS NOT NULL)
      OR (status = 'censored_missing' AND candidate_block IS NULL
        AND candidate_block_hash IS NULL AND candidate_observed_at IS NULL
        AND candidate_first_local_receipt_at IS NULL AND outcome_cash_raw IS NULL
        AND point_absolute_error_raw IS NULL AND persistence_absolute_error_raw IS NULL
        AND band_covered IS NULL))
  )`
  await sql`CREATE OR REPLACE FUNCTION twyne_pt_model_score_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE i twyne_pt_model_issues%ROWTYPE;
      c twyne_pt_reserve_observations%ROWTYPE;
    BEGIN
      NEW.scored_at := clock_timestamp();
      SELECT * INTO i FROM twyne_pt_model_issues WHERE slot_at = NEW.slot_at;
      IF i.status IS DISTINCT FROM 'issued' OR NEW.wrapper IS DISTINCT FROM i.wrapper
        OR NEW.scored_at < i.score_after_at
        THEN RAISE EXCEPTION 'Twyne PT model score not due'; END IF;
      SELECT * INTO c FROM twyne_pt_reserve_observations o
        WHERE o.wrapper = i.wrapper
          AND o.block > i.source_block
          AND o.observed_at BETWEEN i.target_low_at AND i.target_high_at
          AND o.first_local_receipt_at > i.issued_at
          AND o.first_local_receipt_at <= i.score_after_at
          AND o.pt_decimals = i.source_asset_decimals
        ORDER BY abs(extract(epoch FROM (o.observed_at - i.target_at))),
          o.observed_at, o.block
        LIMIT 1;
      IF c.block IS NULL THEN
        IF NEW.status <> 'censored_missing' OR NEW.candidate_block IS NOT NULL
          OR NEW.outcome_cash_raw IS NOT NULL
        THEN RAISE EXCEPTION 'Twyne PT model missing outcome mismatch'; END IF;
      ELSIF NEW.status <> 'observed'
        OR NEW.candidate_block IS DISTINCT FROM c.block
        OR NEW.candidate_block_hash IS DISTINCT FROM c.block_hash
        OR NEW.candidate_observed_at IS DISTINCT FROM c.observed_at
        OR NEW.candidate_first_local_receipt_at IS DISTINCT FROM c.first_local_receipt_at
        OR NEW.outcome_cash_raw IS DISTINCT FROM c.aave_pt_reserve_cash_raw
        OR NEW.point_absolute_error_raw IS DISTINCT FROM abs(c.aave_pt_reserve_cash_raw - i.forecast_point_raw)
        OR NEW.persistence_absolute_error_raw IS DISTINCT FROM abs(c.aave_pt_reserve_cash_raw - i.source_cash_raw)
        OR NEW.band_covered IS DISTINCT FROM (c.aave_pt_reserve_cash_raw BETWEEN i.forecast_low_raw AND i.forecast_high_raw)
      THEN RAISE EXCEPTION 'Twyne PT model score outcome mismatch'; END IF;
      RETURN NEW;
    END $$`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_score_insert ON twyne_pt_model_scores`
  await sql`CREATE TRIGGER twyne_pt_model_score_insert
    BEFORE INSERT ON twyne_pt_model_scores
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_model_score_guard()`

  await sql`CREATE OR REPLACE FUNCTION twyne_pt_model_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Twyne PT model ledger is immutable'; END $$`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_artifact_immutable ON twyne_pt_model_artifacts`
  await sql`CREATE TRIGGER twyne_pt_model_artifact_immutable
    BEFORE UPDATE OR DELETE ON twyne_pt_model_artifacts
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_model_immutable()`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_issue_immutable ON twyne_pt_model_issues`
  await sql`CREATE TRIGGER twyne_pt_model_issue_immutable
    BEFORE UPDATE OR DELETE ON twyne_pt_model_issues
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_model_immutable()`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_score_immutable ON twyne_pt_model_scores`
  await sql`CREATE TRIGGER twyne_pt_model_score_immutable
    BEFORE UPDATE OR DELETE ON twyne_pt_model_scores
    FOR EACH ROW EXECUTE FUNCTION twyne_pt_model_immutable()`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_artifact_no_truncate ON twyne_pt_model_artifacts`
  await sql`CREATE TRIGGER twyne_pt_model_artifact_no_truncate
    BEFORE TRUNCATE ON twyne_pt_model_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION twyne_pt_model_immutable()`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_issue_no_truncate ON twyne_pt_model_issues`
  await sql`CREATE TRIGGER twyne_pt_model_issue_no_truncate
    BEFORE TRUNCATE ON twyne_pt_model_issues
    FOR EACH STATEMENT EXECUTE FUNCTION twyne_pt_model_immutable()`
  await sql`DROP TRIGGER IF EXISTS twyne_pt_model_score_no_truncate ON twyne_pt_model_scores`
  await sql`CREATE TRIGGER twyne_pt_model_score_no_truncate
    BEFORE TRUNCATE ON twyne_pt_model_scores
    FOR EACH STATEMENT EXECUTE FUNCTION twyne_pt_model_immutable()`
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
  process.stdout.write('twyne_pt_model ledger ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Twyne PT model schema failed closed.\n')
    process.exitCode = 1
  })
}
