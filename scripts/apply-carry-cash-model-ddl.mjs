// Additive, prospective issue/score ledger for a historically trained cash model.
// Separate from carry_cash_issue_attempts, which is a persistence baseline only.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

const MODEL_TABLES = [
  'carry_cash_model_guard_epoch',
  'carry_cash_model_v4_epoch',
  'carry_cash_model_artifacts',
  'carry_cash_model_attempts',
  'carry_cash_model_scores',
]
const BASELINE_TABLES = [
  'carry_cash_issue_slots',
  'carry_cash_issue_attempts',
  'carry_cash_issue_scores',
]
export const MODEL_GUARD_FUNCTION_MARKERS = {
  clock_carry_cash_model_epoch: ['clock_timestamp()'],
  clock_carry_cash_model_v4_epoch: ['clock_timestamp()'],
  clock_carry_cash_baseline_slot: ["date_bin('15 minutes'", 'clock_timestamp()'],
  clock_carry_cash_baseline_attempt: ['cash baseline slot absent', 'source_observed_at'],
  clock_carry_cash_baseline_score: ['clock_timestamp()'],
  clock_carry_cash_model_artifact: [
    'cash model artifact payload invalid',
    'carry_cash_model_v4_epoch',
    'historical_cash_delta_model_v1',
    'selectioncoveragepassed',
    'pointbeatspersistence',
    'modelmae',
  ],
  guard_carry_cash_model_attempt: [
    'cash model issue provenance invalid',
    'carry_cash_model_v4_epoch',
    'last_archive_anchor_at',
    'source_observed_at',
  ],
  guard_carry_cash_model_score: ['cash model score source invalid'],
  reject_carry_cash_model_mutation: ['cash model evidence is append only'],
  reject_carry_cash_issue_ledger_mutation: ['carry cash issue ledger is append only'],
}

export const MODEL_GUARD_EXPECTATIONS = [
  {
    table: 'carry_cash_model_guard_epoch',
    trigger: 'carry_cash_model_epoch_clock',
    functionName: 'clock_carry_cash_model_epoch',
    events: ['insert'],
    level: 'row',
  },
  {
    table: 'carry_cash_model_v4_epoch',
    trigger: 'carry_cash_model_v4_epoch_clock',
    functionName: 'clock_carry_cash_model_v4_epoch',
    events: ['insert'],
    level: 'row',
  },
  {
    table: 'carry_cash_issue_slots',
    trigger: 'carry_cash_baseline_slot_clock',
    functionName: 'clock_carry_cash_baseline_slot',
    events: ['insert'],
    level: 'row',
  },
  {
    table: 'carry_cash_issue_attempts',
    trigger: 'carry_cash_baseline_attempt_clock',
    functionName: 'clock_carry_cash_baseline_attempt',
    events: ['insert'],
    level: 'row',
  },
  {
    table: 'carry_cash_issue_scores',
    trigger: 'carry_cash_baseline_score_clock',
    functionName: 'clock_carry_cash_baseline_score',
    events: ['insert'],
    level: 'row',
  },
  {
    table: 'carry_cash_model_artifacts',
    trigger: 'carry_cash_model_artifact_clock',
    functionName: 'clock_carry_cash_model_artifact',
    events: ['insert'],
    level: 'row',
  },
  {
    table: 'carry_cash_model_attempts',
    trigger: 'carry_cash_model_attempt_guard',
    functionName: 'guard_carry_cash_model_attempt',
    events: ['insert'],
    level: 'row',
  },
  {
    table: 'carry_cash_model_scores',
    trigger: 'carry_cash_model_score_guard',
    functionName: 'guard_carry_cash_model_score',
    events: ['insert'],
    level: 'row',
  },
  ...MODEL_TABLES.flatMap((table) => [
    {
      table,
      trigger: `${table}_immutable`,
      functionName: 'reject_carry_cash_model_mutation',
      events: ['update', 'delete'],
      level: 'row',
    },
    {
      table,
      trigger: `${table}_truncate`,
      functionName: 'reject_carry_cash_model_mutation',
      events: ['truncate'],
      level: 'statement',
    },
  ]),
  ...BASELINE_TABLES.flatMap((table) => [
    {
      table,
      trigger: `${table}_immutable`,
      functionName: 'reject_carry_cash_issue_ledger_mutation',
      events: ['update', 'delete'],
      level: 'row',
    },
    {
      table,
      trigger: `${table}_immutable_truncate`,
      functionName: 'reject_carry_cash_issue_ledger_mutation',
      events: ['truncate'],
      level: 'statement',
    },
  ]),
]

export async function assertModelGuards(sql) {
  const triggers = await sql`SELECT c.relname AS table_name,
      t.tgname, t.tgenabled AS enabled, p.proname AS function_name,
      pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(p.oid) AS function_definition
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgrelid IN
      ('carry_cash_model_guard_epoch'::regclass,
       'carry_cash_model_v4_epoch'::regclass,
       'carry_cash_model_artifacts'::regclass,
       'carry_cash_model_attempts'::regclass,
       'carry_cash_model_scores'::regclass,
       'carry_cash_issue_slots'::regclass,
       'carry_cash_issue_attempts'::regclass,
       'carry_cash_issue_scores'::regclass)`
  const installed = new Map(triggers.map((row) => [`${row.table_name}\0${row.tgname}`, row]))
  for (const expected of MODEL_GUARD_EXPECTATIONS) {
    const row = installed.get(`${expected.table}\0${expected.trigger}`)
    const definition = String(row?.definition ?? '').toLowerCase()
    const functionDefinition = String(row?.function_definition ?? '').toLowerCase()
    const functionMarkers = MODEL_GUARD_FUNCTION_MARKERS[expected.functionName] ?? []
    if (
      !row ||
      row.enabled !== 'O' ||
      row.function_name !== expected.functionName ||
      !definition.includes('before ') ||
      !definition.includes(expected.table) ||
      !definition.includes(`for each ${expected.level}`) ||
      !expected.events.every((event) => definition.includes(event)) ||
      !functionMarkers.every((marker) => functionDefinition.includes(marker)) ||
      !new RegExp(
        `execute function (?:[a-z0-9_]+\\.)?${expected.functionName.toLowerCase()}\\(\\)`,
      ).test(definition)
    )
      throw new Error('cash_model_guards_missing')
  }
}

export async function apply(sql) {
  await sql`CREATE OR REPLACE FUNCTION reject_carry_cash_model_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'cash model evidence is append only'; END $$`
  // Future baseline slots and scores receive database clocks before model
  // attempts are allowed to reference them. Earlier baseline rows stay out.
  await sql`CREATE OR REPLACE FUNCTION clock_carry_cash_baseline_slot()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.started_at := clock_timestamp();
      NEW.slot_at := date_bin('15 minutes', NEW.started_at,
        '1970-01-01 00:00:00+00'::timestamptz);
      RETURN NEW;
    END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_baseline_slot_clock'
      AND tgrelid = 'carry_cash_issue_slots'::regclass
  ) THEN CREATE TRIGGER carry_cash_baseline_slot_clock
    BEFORE INSERT ON carry_cash_issue_slots
    FOR EACH ROW EXECUTE FUNCTION clock_carry_cash_baseline_slot(); END IF; END $$`
  await sql`CREATE OR REPLACE FUNCTION clock_carry_cash_baseline_attempt()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE stamp timestamptz;
    BEGIN
      SELECT started_at INTO stamp FROM carry_cash_issue_slots WHERE slot_at = NEW.slot_at;
      IF stamp IS NULL THEN RAISE EXCEPTION 'cash baseline slot absent'; END IF;
      NEW.issued_at := stamp;
      NEW.target_at := CASE WHEN NEW.status = 'issued' THEN NEW.source_observed_at
        ELSE stamp END + make_interval(hours => NEW.horizon_hours);
      NEW.target_low_at := NEW.target_at
        - CASE NEW.horizon_hours WHEN 1 THEN interval '15 minutes' ELSE interval '1 hour' END;
      NEW.target_high_at := NEW.target_at
        + CASE NEW.horizon_hours WHEN 1 THEN interval '15 minutes' ELSE interval '1 hour' END;
      NEW.score_after_at := NEW.target_high_at + interval '1 hour';
      RETURN NEW;
    END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_baseline_attempt_clock'
      AND tgrelid = 'carry_cash_issue_attempts'::regclass
  ) THEN CREATE TRIGGER carry_cash_baseline_attempt_clock
    BEFORE INSERT ON carry_cash_issue_attempts
    FOR EACH ROW EXECUTE FUNCTION clock_carry_cash_baseline_attempt(); END IF; END $$`
  // Older immutable issues targeted from issue time. Future issued targets are
  // measured from the physical source block, matching historical H1/H24 pairs.
  await sql`ALTER TABLE carry_cash_issue_attempts
    DROP CONSTRAINT IF EXISTS carry_cash_issue_attempts_check,
    ADD CONSTRAINT carry_cash_issue_attempts_check CHECK (
      target_at = issued_at + make_interval(hours => horizon_hours)
      OR (status = 'issued' AND source_observed_at IS NOT NULL
        AND target_at = source_observed_at + make_interval(hours => horizon_hours)))`
  await sql`CREATE OR REPLACE FUNCTION clock_carry_cash_baseline_score()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.scored_at := clock_timestamp(); RETURN NEW; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_baseline_score_clock'
      AND tgrelid = 'carry_cash_issue_scores'::regclass
  ) THEN CREATE TRIGGER carry_cash_baseline_score_clock
    BEFORE INSERT ON carry_cash_issue_scores
    FOR EACH ROW EXECUTE FUNCTION clock_carry_cash_baseline_score(); END IF; END $$`
  await sql`CREATE TABLE IF NOT EXISTS carry_cash_model_guard_epoch (
    id boolean PRIMARY KEY CHECK (id = true),
    activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  await sql`CREATE OR REPLACE FUNCTION clock_carry_cash_model_epoch()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.activated_at := clock_timestamp(); RETURN NEW; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_model_epoch_clock'
      AND tgrelid = 'carry_cash_model_guard_epoch'::regclass
  ) THEN CREATE TRIGGER carry_cash_model_epoch_clock
    BEFORE INSERT ON carry_cash_model_guard_epoch
    FOR EACH ROW EXECUTE FUNCTION clock_carry_cash_model_epoch(); END IF; END $$`
  await sql`INSERT INTO carry_cash_model_guard_epoch (id) VALUES (true)
    ON CONFLICT (id) DO NOTHING`

  // This database-clock row is the permanent migration boundary. The table
  // stays empty while guards are replaced, causing registration/issue to fail
  // closed until the v4-only rules are installed.
  await sql`CREATE TABLE IF NOT EXISTS carry_cash_model_v4_epoch (
    id boolean PRIMARY KEY CHECK (id = true),
    activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  await sql`CREATE OR REPLACE FUNCTION clock_carry_cash_model_v4_epoch()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.activated_at := clock_timestamp(); RETURN NEW; END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_model_v4_epoch_clock'
      AND tgrelid = 'carry_cash_model_v4_epoch'::regclass
  ) THEN CREATE TRIGGER carry_cash_model_v4_epoch_clock
    BEFORE INSERT ON carry_cash_model_v4_epoch
    FOR EACH ROW EXECUTE FUNCTION clock_carry_cash_model_v4_epoch(); END IF; END $$`
  await sql.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_model_v4_epoch_immutable' AND tgrelid = 'carry_cash_model_v4_epoch'::regclass) THEN CREATE TRIGGER carry_cash_model_v4_epoch_immutable BEFORE UPDATE OR DELETE ON carry_cash_model_v4_epoch FOR EACH ROW EXECUTE FUNCTION reject_carry_cash_model_mutation(); END IF; END $$`,
  )
  await sql.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_model_v4_epoch_truncate' AND tgrelid = 'carry_cash_model_v4_epoch'::regclass) THEN CREATE TRIGGER carry_cash_model_v4_epoch_truncate BEFORE TRUNCATE ON carry_cash_model_v4_epoch FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_cash_model_mutation(); END IF; END $$`,
  )

  await sql`CREATE TABLE IF NOT EXISTS carry_cash_model_artifacts (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    model_version text NOT NULL CHECK (model_version ~ '^[a-z0-9_.-]{1,80}$'),
    route_key text NOT NULL,
    destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
    horizon_hours smallint NOT NULL CHECK (horizon_hours IN (1, 24)),
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    first_archive_anchor_at timestamptz NOT NULL,
    last_archive_anchor_at timestamptz NOT NULL,
    fit_pairs smallint NOT NULL CHECK (fit_pairs >= 20),
    calibration_pairs smallint NOT NULL CHECK (calibration_pairs >= 20),
    selection_pairs smallint,
    holdout_pairs smallint NOT NULL,
    payload_bytes text NOT NULL,
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (model_version, route_key, destination, horizon_hours),
    CHECK (sha256 = encode(sha256(convert_to(payload_bytes, 'UTF8')), 'hex')),
    CHECK (jsonb_typeof(payload_bytes::jsonb) = 'object'),
    CHECK (first_archive_anchor_at < last_archive_anchor_at),
    CHECK (last_archive_anchor_at < registered_at)
  )`
  // v1-v3 artifacts are immutable three-stage studies. v4 adds a separate
  // model-selection period and leaves holdout untouched for final reporting.
  await sql`ALTER TABLE carry_cash_model_artifacts
    ADD COLUMN IF NOT EXISTS selection_pairs smallint`
  await sql`ALTER TABLE carry_cash_model_artifacts
    DROP CONSTRAINT IF EXISTS carry_cash_model_artifacts_holdout_pairs_check,
    DROP CONSTRAINT IF EXISTS carry_cash_model_artifacts_split_check,
    ADD CONSTRAINT carry_cash_model_artifacts_split_check CHECK (
      (model_version ~ '^h(delta|band)4-[0-9]+-[0-9]+$'
        AND selection_pairs >= 10 AND holdout_pairs >= 10)
      OR (model_version !~ '^h(delta|band)4-[0-9]+-[0-9]+$'
        AND selection_pairs IS NULL AND holdout_pairs >= 20))`

  await sql`CREATE TABLE IF NOT EXISTS carry_cash_model_attempts (
    slot_at timestamptz NOT NULL,
    route_key text NOT NULL,
    destination text NOT NULL,
    horizon_hours smallint NOT NULL,
    status text NOT NULL CHECK (status IN
      ('issued', 'baseline_unissued', 'unassessed', 'insufficient_history',
       'historical_backtest_failed', 'model_unavailable', 'late')),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    model_artifact_sha256 text REFERENCES carry_cash_model_artifacts(sha256),
    source_cash_raw numeric(78,0) CHECK (source_cash_raw >= 0),
    forecast_point_raw numeric(78,0) CHECK (forecast_point_raw >= 0),
    forecast_low_raw numeric(78,0) CHECK (forecast_low_raw >= 0),
    forecast_high_raw numeric(78,0) CHECK (forecast_high_raw >= 0),
    reason text,
    PRIMARY KEY (slot_at, route_key, destination, horizon_hours),
    FOREIGN KEY (slot_at, route_key, destination, horizon_hours)
      REFERENCES carry_cash_issue_attempts (slot_at, route_key, destination, horizon_hours),
    CHECK ((status = 'issued'
      AND model_artifact_sha256 IS NOT NULL AND source_cash_raw IS NOT NULL
      AND forecast_point_raw IS NOT NULL AND forecast_low_raw IS NOT NULL
      AND forecast_high_raw IS NOT NULL AND reason IS NULL
      AND forecast_low_raw <= forecast_high_raw)
      OR (status <> 'issued'
        AND model_artifact_sha256 IS NULL AND source_cash_raw IS NULL
        AND forecast_point_raw IS NULL AND forecast_low_raw IS NULL
        AND forecast_high_raw IS NULL AND reason IS NOT NULL))
  )`
  await sql`CREATE INDEX IF NOT EXISTS carry_cash_model_attempts_subject_idx
    ON carry_cash_model_attempts (route_key, destination, horizon_hours, slot_at)`

  await sql`CREATE TABLE IF NOT EXISTS carry_cash_model_scores (
    slot_at timestamptz NOT NULL,
    route_key text NOT NULL,
    destination text NOT NULL,
    horizon_hours smallint NOT NULL,
    status text NOT NULL CHECK (status IN ('observed', 'censored_missing')),
    scored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    outcome_cash_raw numeric(78,0) CHECK (outcome_cash_raw >= 0),
    point_absolute_error_raw numeric(78,0) CHECK (point_absolute_error_raw >= 0),
    persistence_absolute_error_raw numeric(78,0) CHECK (persistence_absolute_error_raw >= 0),
    band_covered boolean,
    PRIMARY KEY (slot_at, route_key, destination, horizon_hours),
    FOREIGN KEY (slot_at, route_key, destination, horizon_hours)
      REFERENCES carry_cash_model_attempts (slot_at, route_key, destination, horizon_hours),
    FOREIGN KEY (slot_at, route_key, destination, horizon_hours)
      REFERENCES carry_cash_issue_scores (slot_at, route_key, destination, horizon_hours),
    CHECK ((status = 'observed' AND outcome_cash_raw IS NOT NULL
      AND point_absolute_error_raw IS NOT NULL
      AND persistence_absolute_error_raw IS NOT NULL AND band_covered IS NOT NULL)
      OR (status = 'censored_missing' AND outcome_cash_raw IS NULL
        AND point_absolute_error_raw IS NULL
        AND persistence_absolute_error_raw IS NULL AND band_covered IS NULL))
  )`

  // The source baseline and artifact are checked at insertion, including
  // whether the model was registered and issued before any target observation.
  await sql`CREATE OR REPLACE FUNCTION clock_carry_cash_model_artifact()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE p jsonb;
    BEGIN
      NEW.registered_at := clock_timestamp();
      p := NEW.payload_bytes::jsonb;
      IF p->>'kind' NOT IN
          ('historical_cash_delta_model_v1', 'historical_cash_persistence_band_v1')
        OR p->>'routeKey' IS DISTINCT FROM NEW.route_key
        OR p->>'destination' IS DISTINCT FROM NEW.destination
        OR (p->>'horizonHours')::integer IS DISTINCT FROM NEW.horizon_hours
        OR p->>'asset' IS DISTINCT FROM NEW.asset
        OR p->>'assetDecimals' IS NULL
        OR (p->>'assetDecimals')::integer NOT BETWEEN 0 AND 36
        OR p->>'sourceManifestSha256' IS DISTINCT FROM NEW.source_manifest_sha256
        OR (p->>'firstArchiveAnchorAt')::timestamptz IS DISTINCT FROM NEW.first_archive_anchor_at
        OR (p->>'lastArchiveAnchorAt')::timestamptz IS DISTINCT FROM NEW.last_archive_anchor_at
        OR (p->'counts'->>'fit')::integer IS DISTINCT FROM NEW.fit_pairs
        OR (p->'counts'->>'calibration')::integer IS DISTINCT FROM NEW.calibration_pairs
        OR (p->'counts'->>'holdout')::integer IS DISTINCT FROM NEW.holdout_pairs
        OR jsonb_typeof(p->'pairs') IS DISTINCT FROM 'array'
        OR NOT EXISTS (SELECT 1 FROM carry_cash_model_v4_epoch WHERE id = true)
        OR NEW.model_version !~ '^h(delta|band)4-[0-9]+-[0-9]+$'
        OR (NEW.model_version ~ '^hdelta4-'
          AND p->>'kind' IS DISTINCT FROM 'historical_cash_delta_model_v1')
        OR (NEW.model_version ~ '^hband4-'
          AND p->>'kind' IS DISTINCT FROM 'historical_cash_persistence_band_v1')
        OR NEW.registered_at < (SELECT activated_at
          FROM carry_cash_model_v4_epoch WHERE id = true)
        OR (NEW.model_version ~ '^h(delta|band)4-' AND (
          (p->'counts'->>'selection')::integer IS DISTINCT FROM NEW.selection_pairs
          OR (p->'counts'->>'total')::integer IS DISTINCT FROM
            NEW.fit_pairs + NEW.calibration_pairs + NEW.selection_pairs + NEW.holdout_pairs
          OR jsonb_array_length(p->'pairs') IS DISTINCT FROM
            NEW.fit_pairs + NEW.calibration_pairs + NEW.selection_pairs + NEW.holdout_pairs
          OR (p->'selection'->>'total')::integer IS DISTINCT FROM NEW.selection_pairs
          OR (p->'holdout'->>'total')::integer IS DISTINCT FROM NEW.holdout_pairs
          OR (p->'selection'->>'covered')::integer IS NULL
          OR (p->'selection'->>'covered')::integer NOT BETWEEN 0 AND NEW.selection_pairs
          OR (p->'holdout'->>'covered')::integer IS NULL
          OR (p->'holdout'->>'covered')::integer NOT BETWEEN 0 AND NEW.holdout_pairs
          OR (p->'baselineBand'->>'selectionTotal')::integer
            IS DISTINCT FROM NEW.selection_pairs
          OR (p->'baselineBand'->>'holdoutTotal')::integer
            IS DISTINCT FROM NEW.holdout_pairs
          OR (p->'baselineBand'->>'selectionCovered')::integer
            IS NULL
          OR (p->'baselineBand'->>'selectionCovered')::integer
            NOT BETWEEN 0 AND NEW.selection_pairs
          OR (p->'baselineBand'->>'holdoutCovered')::integer
            IS NULL
          OR (p->'baselineBand'->>'holdoutCovered')::integer
            NOT BETWEEN 0 AND NEW.holdout_pairs
          OR (p->'selection'->>'coveragePassed')::boolean IS DISTINCT FROM
            ((p->'selection'->>'covered')::integer * 100 >= NEW.selection_pairs * 80)
          OR (p->'holdout'->>'coveragePassed')::boolean IS DISTINCT FROM
            ((p->'holdout'->>'covered')::integer * 100 >= NEW.holdout_pairs * 80)
          OR (p->'baselineBand'->>'selectionCoveragePassed')::boolean IS DISTINCT FROM
            ((p->'baselineBand'->>'selectionCovered')::integer * 100
              >= NEW.selection_pairs * 80)
          OR (p->'baselineBand'->>'coveragePassed')::boolean IS DISTINCT FROM
            ((p->'baselineBand'->>'holdoutCovered')::integer * 100
              >= NEW.holdout_pairs * 80)
          OR p->'selection'->'modelMae'->>'numeratorRaw' IS NULL
          OR p->'selection'->'modelMae'->>'numeratorRaw' !~ '^(0|[1-9][0-9]*)$'
          OR p->'selection'->'persistenceMae'->>'numeratorRaw' IS NULL
          OR p->'selection'->'persistenceMae'->>'numeratorRaw' !~ '^(0|[1-9][0-9]*)$'
          OR (p->'selection'->'modelMae'->>'denominator')::integer
            IS DISTINCT FROM NEW.selection_pairs
          OR (p->'selection'->'persistenceMae'->>'denominator')::integer
            IS DISTINCT FROM NEW.selection_pairs
          OR (p->'selection'->>'pointBeatsPersistence')::boolean IS DISTINCT FROM
            ((p->'selection'->'modelMae'->>'numeratorRaw')::numeric
              < (p->'selection'->'persistenceMae'->>'numeratorRaw')::numeric)
          OR p->'holdout'->'modelMae'->>'numeratorRaw' IS NULL
          OR p->'holdout'->'modelMae'->>'numeratorRaw' !~ '^(0|[1-9][0-9]*)$'
          OR p->'holdout'->'persistenceMae'->>'numeratorRaw' IS NULL
          OR p->'holdout'->'persistenceMae'->>'numeratorRaw' !~ '^(0|[1-9][0-9]*)$'
          OR (p->'holdout'->'modelMae'->>'denominator')::integer
            IS DISTINCT FROM NEW.holdout_pairs
          OR (p->'holdout'->'persistenceMae'->>'denominator')::integer
            IS DISTINCT FROM NEW.holdout_pairs
          OR (p->'holdout'->>'pointBeatsPersistence')::boolean IS DISTINCT FROM
            ((p->'holdout'->'modelMae'->>'numeratorRaw')::numeric
              < (p->'holdout'->'persistenceMae'->>'numeratorRaw')::numeric)
          OR (p->>'kind' = 'historical_cash_delta_model_v1' AND (
            p->'selection'->>'coveragePassed' IS DISTINCT FROM 'true'
            OR p->'selection'->>'pointBeatsPersistence' IS DISTINCT FROM 'true'))
          OR (p->>'kind' = 'historical_cash_persistence_band_v1' AND (
            p->>'fitMedianDeltaRaw' IS DISTINCT FROM '0'
            OR p->'baselineBand'->>'selectionCoveragePassed' IS DISTINCT FROM 'true'
            OR (p->'selection'->>'coveragePassed' = 'true'
              AND p->'selection'->>'pointBeatsPersistence' = 'true')
            OR (p->'baselineBand'->>'selectionCovered')::integer * 100
              < NEW.selection_pairs * 80))))
        OR p->>'historicalBacktestOnly' IS DISTINCT FROM 'true'
        OR p->>'prospectiveValidated' IS DISTINCT FROM 'false'
        OR p->>'holderExecutableExit' IS DISTINCT FROM 'false'
      THEN RAISE EXCEPTION 'cash model artifact payload invalid'; END IF;
      RETURN NEW;
    END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_model_artifact_clock'
      AND tgrelid = 'carry_cash_model_artifacts'::regclass
  ) THEN CREATE TRIGGER carry_cash_model_artifact_clock
    BEFORE INSERT ON carry_cash_model_artifacts
    FOR EACH ROW EXECUTE FUNCTION clock_carry_cash_model_artifact(); END IF; END $$`
  await sql`CREATE OR REPLACE FUNCTION guard_carry_cash_model_attempt()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE b carry_cash_issue_attempts%ROWTYPE;
      a carry_cash_model_artifacts%ROWTYPE;
      p jsonb;
      max_raw numeric := power(2::numeric, 256) - 1;
    BEGIN
      NEW.issued_at := clock_timestamp();
      SELECT * INTO b FROM carry_cash_issue_attempts
        WHERE slot_at = NEW.slot_at AND route_key = NEW.route_key
          AND destination = NEW.destination AND horizon_hours = NEW.horizon_hours;
      IF NOT FOUND THEN RAISE EXCEPTION 'cash model baseline absent'; END IF;
      IF NEW.issued_at >= b.target_low_at
        OR NEW.issued_at > b.issued_at + interval '5 minutes' THEN
        NEW.status := 'late';
        NEW.model_artifact_sha256 := NULL;
        NEW.source_cash_raw := NULL;
        NEW.forecast_point_raw := NULL;
        NEW.forecast_low_raw := NULL;
        NEW.forecast_high_raw := NULL;
        NEW.reason := 'late_model_issue';
      ELSIF NEW.status = 'late' THEN
        RAISE EXCEPTION 'cash model early late status invalid';
      END IF;
      IF b.issued_at < (SELECT activated_at FROM carry_cash_model_guard_epoch WHERE id = true)
        OR NOT EXISTS (SELECT 1 FROM carry_cash_model_v4_epoch WHERE id = true)
        OR b.issued_at < (SELECT activated_at FROM carry_cash_model_v4_epoch WHERE id = true)
        OR NEW.issued_at < b.issued_at
        OR (b.status = 'unassessed' AND NEW.status NOT IN ('unassessed', 'late'))
        OR (b.status NOT IN ('issued', 'unassessed')
          AND NEW.status NOT IN ('baseline_unissued', 'late'))
        OR (b.status = 'issued' AND NEW.status IN ('baseline_unissued', 'unassessed'))
      THEN RAISE EXCEPTION 'cash model attempt clock or status invalid'; END IF;
      IF NEW.status = 'issued' THEN
        SELECT * INTO a FROM carry_cash_model_artifacts
          WHERE sha256 = NEW.model_artifact_sha256;
        p := a.payload_bytes::jsonb;
        IF b.status <> 'issued' OR a.sha256 IS NULL
          OR a.model_version !~ '^h(delta|band)4-[0-9]+-[0-9]+$'
          OR a.registered_at < (SELECT activated_at
            FROM carry_cash_model_v4_epoch WHERE id = true)
          OR a.route_key <> NEW.route_key OR a.destination <> NEW.destination
          OR a.horizon_hours <> NEW.horizon_hours OR a.asset <> b.asset
          OR (p->>'assetDecimals')::integer IS DISTINCT FROM b.asset_decimals
          OR a.source_manifest_sha256 <> (SELECT subject_manifest_sha256
              FROM carry_cash_issue_slots WHERE slot_at = NEW.slot_at)
          OR a.registered_at > NEW.issued_at
          OR a.last_archive_anchor_at >= b.source_observed_at
          OR NEW.source_cash_raw <> b.source_cash_raw
          OR b.source_first_local_receipt_at > NEW.issued_at
          OR b.issued_at - b.source_observed_at > interval '30 minutes'
          OR NEW.forecast_point_raw IS DISTINCT FROM greatest(0, least(max_raw,
            NEW.source_cash_raw + (p->>'fitMedianDeltaRaw')::numeric))
          OR NEW.forecast_low_raw IS DISTINCT FROM greatest(0, least(max_raw,
            NEW.source_cash_raw + (p->>'fitMedianDeltaRaw')::numeric
              + (p->>'calibrationResidualP05Raw')::numeric))
          OR NEW.forecast_high_raw IS DISTINCT FROM greatest(0, least(max_raw,
            NEW.source_cash_raw + (p->>'fitMedianDeltaRaw')::numeric
              + (p->>'calibrationResidualP95Raw')::numeric))
        THEN RAISE EXCEPTION 'cash model issue provenance invalid'; END IF;
      END IF;
      RETURN NEW;
    END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_model_attempt_guard'
      AND tgrelid = 'carry_cash_model_attempts'::regclass
  ) THEN CREATE TRIGGER carry_cash_model_attempt_guard
    BEFORE INSERT ON carry_cash_model_attempts
    FOR EACH ROW EXECUTE FUNCTION guard_carry_cash_model_attempt(); END IF; END $$`

  await sql`CREATE OR REPLACE FUNCTION guard_carry_cash_model_score()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE b carry_cash_issue_scores%ROWTYPE;
      m carry_cash_model_attempts%ROWTYPE;
      baseline carry_cash_issue_attempts%ROWTYPE;
    BEGIN
      NEW.scored_at := clock_timestamp();
      SELECT * INTO b FROM carry_cash_issue_scores
        WHERE slot_at = NEW.slot_at AND route_key = NEW.route_key
          AND destination = NEW.destination AND horizon_hours = NEW.horizon_hours;
      SELECT * INTO m FROM carry_cash_model_attempts
        WHERE slot_at = NEW.slot_at AND route_key = NEW.route_key
          AND destination = NEW.destination AND horizon_hours = NEW.horizon_hours;
      SELECT * INTO baseline FROM carry_cash_issue_attempts
        WHERE slot_at = NEW.slot_at AND route_key = NEW.route_key
          AND destination = NEW.destination AND horizon_hours = NEW.horizon_hours;
      IF b.status IS NULL OR m.status IS DISTINCT FROM 'issued'
        OR NEW.status IS DISTINCT FROM b.status
        OR NEW.scored_at < b.scored_at
        OR NEW.scored_at < baseline.score_after_at
        OR m.issued_at >= b.scored_at
      THEN RAISE EXCEPTION 'cash model score source invalid'; END IF;
      IF NEW.status = 'observed' AND (
        NEW.outcome_cash_raw <> b.outcome_cash_raw
        OR m.issued_at >= b.outcome_first_local_receipt_at
        OR NEW.point_absolute_error_raw <> abs(b.outcome_cash_raw - m.forecast_point_raw)
        OR NEW.persistence_absolute_error_raw <> abs(b.outcome_cash_raw - baseline.source_cash_raw)
        OR NEW.band_covered <> (b.outcome_cash_raw BETWEEN m.forecast_low_raw AND m.forecast_high_raw)
      ) THEN RAISE EXCEPTION 'cash model score arithmetic invalid'; END IF;
      RETURN NEW;
    END $$`
  await sql`DO $$ BEGIN IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'carry_cash_model_score_guard'
      AND tgrelid = 'carry_cash_model_scores'::regclass
  ) THEN CREATE TRIGGER carry_cash_model_score_guard
    BEFORE INSERT ON carry_cash_model_scores
    FOR EACH ROW EXECUTE FUNCTION guard_carry_cash_model_score(); END IF; END $$`

  for (const table of [
    'carry_cash_model_guard_epoch',
    'carry_cash_model_v4_epoch',
    'carry_cash_model_artifacts',
    'carry_cash_model_attempts',
    'carry_cash_model_scores',
  ]) {
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${table}_immutable' AND tgrelid = '${table}'::regclass) THEN CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_carry_cash_model_mutation(); END IF; END $$`,
    )
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${table}_truncate' AND tgrelid = '${table}'::regclass) THEN CREATE TRIGGER ${table}_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_cash_model_mutation(); END IF; END $$`,
    )
  }
  await assertModelGuards(sql)
  await sql`INSERT INTO carry_cash_model_v4_epoch (id) VALUES (true)
    ON CONFLICT (id) DO NOTHING`
  const epoch = await sql`SELECT activated_at FROM carry_cash_model_v4_epoch WHERE id = true`
  if (epoch.length !== 1 || !Number.isFinite(Date.parse(epoch[0].activated_at)))
    throw new Error('cash_model_v4_epoch_invalid')
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
  process.stdout.write('carry_cash_model_ledger ready\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('carry_cash_model_ddl_failed\n')
    process.exitCode = 1
  })
}
