// Additive, append-only prospective sUSDS measurement ledger. No forecast table.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_susds_exit_attempts (
    id bigserial PRIMARY KEY,
    vault text NOT NULL DEFAULT '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd' CHECK (vault = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'),
    tick_slot bigint NOT NULL CHECK (tick_slot > 0),
    status text NOT NULL CHECK (status IN ('issued', 'unavailable')),
    unavailable_reason text CHECK (unavailable_reason IN
      ('no_transfer_candidate', 'sampled_candidate_exhausted',
       'candidate_check_unavailable', 'discovery_unavailable')),
    route_key text CHECK (route_key = 'USDS → SUsds [USDS]'),
    holder text CHECK (holder ~ '^0x[0-9a-f]{40}$'),
    assets_raw numeric(78,0) CHECK (assets_raw > 0),
    holder_claim_raw numeric(78,0) CHECK (holder_claim_raw >= 0),
    source_block bigint CHECK (source_block > 0),
    source_hash text CHECK (source_hash ~ '^0x[0-9a-f]{64}$'),
    source_block_at timestamptz,
    source_observed_at timestamptz,
    issue_simulation text CHECK (issue_simulation IN ('success', 'evm_revert')),
    transfer_tx_hash text CHECK (transfer_tx_hash ~ '^0x[0-9a-f]{64}$'),
    transfer_log_index integer CHECK (transfer_log_index >= 0),
    transfer_block bigint CHECK (transfer_block > 0),
    transfer_block_hash text CHECK (transfer_block_hash ~ '^0x[0-9a-f]{64}$'),
    caller_checksum_sha256 text NOT NULL CHECK (caller_checksum_sha256 ~ '^[0-9a-f]{64}$'),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    target_at timestamptz NOT NULL,
    UNIQUE (vault, tick_slot),
    CHECK ((status = 'unavailable' AND unavailable_reason IS NOT NULL
      AND route_key IS NULL AND holder IS NULL AND assets_raw IS NULL
      AND holder_claim_raw IS NULL AND source_block IS NULL AND source_hash IS NULL
      AND source_block_at IS NULL AND source_observed_at IS NULL
      AND issue_simulation IS NULL AND transfer_tx_hash IS NULL
      AND transfer_log_index IS NULL AND transfer_block IS NULL
      AND transfer_block_hash IS NULL)
      OR (status = 'issued' AND unavailable_reason IS NULL
      AND route_key IS NOT NULL AND holder IS NOT NULL AND assets_raw IS NOT NULL
      AND holder_claim_raw >= assets_raw AND source_block IS NOT NULL
      AND source_hash IS NOT NULL AND source_block_at IS NOT NULL
      AND source_observed_at IS NOT NULL AND issue_simulation IS NOT NULL
      AND transfer_tx_hash IS NOT NULL AND transfer_log_index IS NOT NULL
      AND transfer_block IS NOT NULL AND transfer_block <= source_block
      AND transfer_block_hash IS NOT NULL))
  )`
  await sql`ALTER TABLE carry_susds_exit_attempts
    DROP CONSTRAINT IF EXISTS carry_susds_exit_attempts_issued_claim_check,
    ADD CONSTRAINT carry_susds_exit_attempts_issued_claim_check CHECK
      (status <> 'issued' OR holder_claim_raw IS NOT NULL)`
  await sql`CREATE INDEX IF NOT EXISTS carry_susds_exit_attempts_due_idx
    ON carry_susds_exit_attempts(target_at) WHERE status = 'issued'`
  await sql`CREATE TABLE IF NOT EXISTS carry_susds_exit_outcomes (
    issue_id bigint PRIMARY KEY REFERENCES carry_susds_exit_attempts(id),
    tick_slot bigint NOT NULL CHECK (tick_slot > 0),
    status text NOT NULL CHECK (status IN
      ('success', 'evm_revert', 'position_insufficient', 'missing')),
    missing_reason text CHECK (missing_reason IN
      ('target_window_missed', 'target_block_outside_window', 'quote_unavailable')),
    route_key text NOT NULL CHECK (route_key = 'USDS → SUsds [USDS]'),
    vault text NOT NULL CHECK (vault = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'),
    holder text NOT NULL CHECK (holder ~ '^0x[0-9a-f]{40}$'),
    assets_raw numeric(78,0) NOT NULL CHECK (assets_raw > 0),
    holder_claim_raw numeric(78,0),
    holder_shares_raw numeric(78,0),
    preview_shares_raw numeric(78,0),
    shares_burned_raw numeric(78,0),
    source_block bigint,
    source_hash text CHECK (source_hash ~ '^0x[0-9a-f]{64}$'),
    source_block_at timestamptz,
    source_observed_at timestamptz,
    caller_checksum_sha256 text NOT NULL CHECK (caller_checksum_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  await sql`ALTER TABLE carry_susds_exit_outcomes
    ADD COLUMN IF NOT EXISTS holder_shares_raw numeric(78,0),
    ADD COLUMN IF NOT EXISTS preview_shares_raw numeric(78,0),
    ADD COLUMN IF NOT EXISTS shares_burned_raw numeric(78,0)`
  // Replace the first deployed maxWithdraw-based outcome check. Actual share
  // coverage, not maxWithdraw, distinguishes holder attrition from exit failure.
  await sql`ALTER TABLE carry_susds_exit_outcomes
    DROP CONSTRAINT IF EXISTS carry_susds_exit_outcomes_check,
    DROP CONSTRAINT IF EXISTS carry_susds_exit_outcomes_check1,
    DROP CONSTRAINT IF EXISTS carry_susds_exit_outcomes_evidence_check,
    DROP CONSTRAINT IF EXISTS carry_susds_exit_outcomes_share_status_check,
    ADD CONSTRAINT carry_susds_exit_outcomes_evidence_check CHECK
      ((status = 'missing' AND missing_reason IS NOT NULL
        AND holder_claim_raw IS NULL AND holder_shares_raw IS NULL
        AND preview_shares_raw IS NULL AND shares_burned_raw IS NULL
        AND source_block IS NULL
        AND source_hash IS NULL AND source_block_at IS NULL
        AND source_observed_at IS NULL)
       OR (status <> 'missing' AND missing_reason IS NULL
        AND holder_claim_raw IS NOT NULL AND holder_shares_raw IS NOT NULL
        AND preview_shares_raw IS NOT NULL AND preview_shares_raw > 0
        AND source_block IS NOT NULL
        AND source_hash IS NOT NULL AND source_block_at IS NOT NULL
        AND source_observed_at IS NOT NULL)),
    ADD CONSTRAINT carry_susds_exit_outcomes_share_status_check CHECK
      ((status = 'success' AND shares_burned_raw IS NOT NULL
        AND shares_burned_raw > 0
        AND shares_burned_raw <= holder_shares_raw)
       OR (status = 'evm_revert' AND shares_burned_raw IS NULL
        AND holder_shares_raw >= preview_shares_raw)
       OR (status = 'position_insufficient' AND shares_burned_raw IS NULL
        AND holder_shares_raw < preview_shares_raw)
       OR status = 'missing')`
  await sql`CREATE OR REPLACE FUNCTION carry_susds_exit_issue(p jsonb)
    RETURNS bigint LANGUAGE plpgsql AS $$
    DECLARE n timestamptz := clock_timestamp();
      slot bigint := floor(extract(epoch FROM n) / 900)::bigint;
      old carry_susds_exit_attempts%ROWTYPE; result_id bigint;
    BEGIN
      PERFORM pg_advisory_xact_lock(720101, (slot % 2147483647)::integer);
      IF floor(extract(epoch FROM clock_timestamp()) / 900)::bigint <> slot
      THEN RAISE EXCEPTION 'susds_exit_issue_slot_elapsed'; END IF;
      SELECT * INTO old FROM carry_susds_exit_attempts
        WHERE vault = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd' AND tick_slot = slot;
      IF FOUND THEN
        IF old.caller_checksum_sha256 <> p->>'callerChecksumSha256'
        THEN RAISE EXCEPTION 'susds_exit_issue_replay_mismatch'; END IF;
        RETURN old.id;
      END IF;
      IF (p->>'tickSlot')::bigint <> slot OR p->>'vault' <> '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'
        OR (SELECT count(*) FROM carry_susds_exit_attempts WHERE tick_slot = slot) >= 1
        OR (SELECT count(*) FROM carry_susds_exit_attempts WHERE tick_slot = slot)
          + (SELECT count(*) FROM carry_susds_exit_outcomes WHERE tick_slot = slot) >= 3
      THEN RAISE EXCEPTION 'susds_exit_issue_slot_or_quota'; END IF;
      IF p->>'status' = 'issued' THEN
        IF p->>'routeKey' <> 'USDS → SUsds [USDS]'
          OR (p->>'sourceBlockAt')::timestamptz > n
          OR (p->>'sourceBlockAt')::timestamptz < n - interval '30 minutes'
          OR (p->>'sourceObservedAt')::timestamptz > n + interval '1 minute'
          OR (p->>'sourceObservedAt')::timestamptz < (p->>'sourceBlockAt')::timestamptz
          OR (p->>'transferBlock')::bigint > (p->>'sourceBlock')::bigint
        THEN RAISE EXCEPTION 'susds_exit_issue_source_invalid'; END IF;
      END IF;
      INSERT INTO carry_susds_exit_attempts
        (vault,tick_slot,status,unavailable_reason,route_key,holder,assets_raw,
         holder_claim_raw,source_block,source_hash,source_block_at,source_observed_at,
         issue_simulation,transfer_tx_hash,transfer_log_index,transfer_block,
         transfer_block_hash,caller_checksum_sha256,issued_at,target_at)
      VALUES ('0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',slot,p->>'status',p->>'unavailableReason',p->>'routeKey',
        p->>'holder',nullif(p->>'assetsRaw','')::numeric,
        nullif(p->>'holderClaimRaw','')::numeric,
        nullif(p->>'sourceBlock','')::bigint,p->>'sourceHash',
        nullif(p->>'sourceBlockAt','')::timestamptz,
        nullif(p->>'sourceObservedAt','')::timestamptz,p->>'issueSimulation',
        p->>'transferTxHash',nullif(p->>'transferLogIndex','')::integer,
        nullif(p->>'transferBlock','')::bigint,p->>'transferBlockHash',
        p->>'callerChecksumSha256',n,n + interval '1 hour') RETURNING id INTO result_id;
      RETURN result_id;
    END $$`
  await sql`CREATE OR REPLACE FUNCTION carry_susds_exit_score(p jsonb)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE n timestamptz := clock_timestamp();
      slot bigint := floor(extract(epoch FROM n) / 900)::bigint;
      issue carry_susds_exit_attempts%ROWTYPE;
      old carry_susds_exit_outcomes%ROWTYPE;
    BEGIN
      PERFORM pg_advisory_xact_lock(720101, (slot % 2147483647)::integer);
      IF floor(extract(epoch FROM clock_timestamp()) / 900)::bigint <> slot
      THEN RAISE EXCEPTION 'susds_exit_score_slot_elapsed'; END IF;
      SELECT * INTO issue FROM carry_susds_exit_attempts
        WHERE id = (p->>'issueId')::bigint;
      IF NOT FOUND OR issue.status <> 'issued'
      THEN RAISE EXCEPTION 'susds_exit_issue_unknown'; END IF;
      SELECT * INTO old FROM carry_susds_exit_outcomes WHERE issue_id = issue.id;
      IF FOUND THEN
        IF old.caller_checksum_sha256 <> p->>'callerChecksumSha256'
        THEN RAISE EXCEPTION 'susds_exit_score_replay_mismatch'; END IF;
        RETURN false;
      END IF;
      IF (p->>'tickSlot')::bigint <> slot
        OR (SELECT count(*) FROM carry_susds_exit_outcomes WHERE tick_slot = slot) >= 2
        OR (SELECT count(*) FROM carry_susds_exit_attempts WHERE tick_slot = slot)
          + (SELECT count(*) FROM carry_susds_exit_outcomes WHERE tick_slot = slot) >= 3
        OR p->>'routeKey' <> issue.route_key OR p->>'vault' <> issue.vault
        OR p->>'holder' <> issue.holder
        OR (p->>'assetsRaw')::numeric <> issue.assets_raw
      THEN RAISE EXCEPTION 'susds_exit_score_identity_or_quota'; END IF;
      IF n < issue.target_at - interval '15 minutes'
      THEN RAISE EXCEPTION 'susds_exit_score_early'; END IF;
      IF p->>'status' = 'missing' THEN
        IF n <= issue.target_at + interval '15 minutes'
        THEN RAISE EXCEPTION 'susds_exit_missing_before_close'; END IF;
      ELSE
        IF n > issue.target_at + interval '15 minutes'
          OR (p->>'sourceBlockAt')::timestamptz NOT BETWEEN
            issue.target_at - interval '15 minutes' AND
            issue.target_at + interval '15 minutes'
          OR (p->>'sourceObservedAt')::timestamptz > n + interval '1 minute'
          OR (p->>'sourceObservedAt')::timestamptz < (p->>'sourceBlockAt')::timestamptz
          OR (p->>'sourceBlock')::bigint <= issue.source_block
        THEN RAISE EXCEPTION 'susds_exit_score_not_prospective'; END IF;
      END IF;
      INSERT INTO carry_susds_exit_outcomes
        (issue_id,tick_slot,status,missing_reason,route_key,vault,holder,assets_raw,
         holder_claim_raw,holder_shares_raw,preview_shares_raw,shares_burned_raw,
         source_block,source_hash,source_block_at,source_observed_at,
         caller_checksum_sha256,recorded_at)
      VALUES (issue.id,slot,p->>'status',p->>'missingReason',p->>'routeKey',p->>'vault',
        p->>'holder',(p->>'assetsRaw')::numeric,nullif(p->>'holderClaimRaw','')::numeric,
        nullif(p->>'holderSharesRaw','')::numeric,
        nullif(p->>'previewSharesRaw','')::numeric,
        nullif(p->>'sharesBurnedRaw','')::numeric,
        nullif(p->>'sourceBlock','')::bigint,p->>'sourceHash',
        nullif(p->>'sourceBlockAt','')::timestamptz,
        nullif(p->>'sourceObservedAt','')::timestamptz,p->>'callerChecksumSha256',n);
      RETURN true;
    END $$`
  // Direct inserts receive the same time, route, amount and quota enforcement.
  await sql`CREATE OR REPLACE FUNCTION guard_carry_susds_exit_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE n timestamptz := clock_timestamp();
      slot bigint := floor(extract(epoch FROM n) / 900)::bigint;
      issue carry_susds_exit_attempts%ROWTYPE;
    BEGIN
      PERFORM pg_advisory_xact_lock(720101, (slot % 2147483647)::integer);
      IF NEW.tick_slot <> slot OR
        floor(extract(epoch FROM clock_timestamp()) / 900)::bigint <> slot
      THEN RAISE EXCEPTION 'susds_exit_direct_insert_slot_invalid'; END IF;
      IF TG_TABLE_NAME = 'carry_susds_exit_attempts' THEN
        IF NEW.vault <> '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd' OR
          NEW.issued_at < n - interval '1 minute' OR
          NEW.issued_at > n + interval '1 second' OR
          NEW.target_at <> NEW.issued_at + interval '1 hour' OR
          (SELECT count(*) FROM carry_susds_exit_attempts WHERE tick_slot = slot) >= 1 OR
          (SELECT count(*) FROM carry_susds_exit_attempts WHERE tick_slot = slot)
            + (SELECT count(*) FROM carry_susds_exit_outcomes WHERE tick_slot = slot) >= 3
        THEN RAISE EXCEPTION 'susds_exit_issue_direct_insert_invalid'; END IF;
        IF NEW.status = 'issued' AND (NEW.route_key <> 'USDS → SUsds [USDS]' OR
          NEW.source_block_at > NEW.issued_at OR
          NEW.source_block_at < NEW.issued_at - interval '30 minutes' OR
          NEW.source_observed_at < NEW.source_block_at OR
          NEW.source_observed_at > n + interval '1 minute' OR
          NEW.transfer_block > NEW.source_block)
        THEN RAISE EXCEPTION 'susds_exit_issue_source_invalid'; END IF;
      ELSE
        SELECT * INTO issue FROM carry_susds_exit_attempts WHERE id = NEW.issue_id;
        IF NOT FOUND OR issue.status <> 'issued' OR
          NEW.route_key IS DISTINCT FROM issue.route_key OR
          NEW.vault IS DISTINCT FROM issue.vault OR
          NEW.holder IS DISTINCT FROM issue.holder OR
          NEW.assets_raw IS DISTINCT FROM issue.assets_raw OR
          NEW.recorded_at < n - interval '1 minute' OR
          NEW.recorded_at > n + interval '1 second' OR
          (SELECT count(*) FROM carry_susds_exit_outcomes WHERE tick_slot = slot) >= 2 OR
          (SELECT count(*) FROM carry_susds_exit_attempts WHERE tick_slot = slot)
            + (SELECT count(*) FROM carry_susds_exit_outcomes WHERE tick_slot = slot) >= 3
        THEN RAISE EXCEPTION 'susds_exit_score_direct_insert_invalid'; END IF;
        IF NEW.status = 'missing' THEN
          IF n <= issue.target_at + interval '15 minutes'
          THEN RAISE EXCEPTION 'susds_exit_missing_before_close'; END IF;
        ELSE
          IF n < issue.target_at - interval '15 minutes' OR
            n > issue.target_at + interval '15 minutes' OR
            NEW.source_block <= issue.source_block OR
            NEW.source_block_at NOT BETWEEN issue.target_at - interval '15 minutes'
              AND issue.target_at + interval '15 minutes' OR
            NEW.source_observed_at < NEW.source_block_at OR
            NEW.source_observed_at > n + interval '1 minute'
          THEN RAISE EXCEPTION 'susds_exit_score_source_invalid'; END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$`
  await sql`CREATE OR REPLACE FUNCTION reject_carry_susds_exit_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'susds_exit_ledger_append_only';
    END $$`
  for (const table of ['carry_susds_exit_attempts', 'carry_susds_exit_outcomes']) {
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND tgname = '${table}_insert_guard') THEN CREATE TRIGGER ${table}_insert_guard BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION guard_carry_susds_exit_insert(); END IF; END $$`,
    )
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND tgname = '${table}_immutable') THEN CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_carry_susds_exit_mutation(); END IF; END $$`,
    )
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND tgname = '${table}_truncate') THEN CREATE TRIGGER ${table}_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_susds_exit_mutation(); END IF; END $$`,
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
    .then(() => process.stdout.write('carry_susds_exit ready\n'))
    .catch(() => {
      process.stderr.write('carry_susds_exit_ddl_failed\n')
      process.exitCode = 1
    })
}
