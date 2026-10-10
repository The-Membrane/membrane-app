// Additive, immutable receipt evidence for the 49-vault Morpho flow ledger.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_morpho_v2_withdraw_reconciliation (
    vault text NOT NULL,
    transaction_hash text NOT NULL,
    log_index integer NOT NULL,
    attempt_slot bigint NOT NULL CHECK (attempt_slot > 0),
    status text NOT NULL CHECK (status IN (
      'reconciled_external_supplier', 'internal_vault_receiver',
      'internal_force_deallocate', 'unreconciled', 'ambiguous', 'unavailable')),
    reason text NOT NULL,
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (vault, transaction_hash, log_index, attempt_slot),
    FOREIGN KEY (vault, transaction_hash, log_index)
      REFERENCES carry_morpho_v2_flow_events(vault, transaction_hash, log_index)
  )`
  await sql`CREATE INDEX IF NOT EXISTS carry_morpho_v2_withdraw_reconciliation_latest_idx
    ON carry_morpho_v2_withdraw_reconciliation
    (vault, transaction_hash, log_index, attempt_slot DESC)`
  await sql`CREATE OR REPLACE FUNCTION carry_morpho_v2_record_withdraw_reconciliation(p jsonb)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE e carry_morpho_v2_flow_events%ROWTYPE;
      prior carry_morpho_v2_withdraw_reconciliation%ROWTYPE;
    BEGIN
      SELECT * INTO e FROM carry_morpho_v2_flow_events
        WHERE vault = p->>'vault' AND transaction_hash = p->>'transactionHash'
          AND log_index = (p->>'logIndex')::integer FOR UPDATE;
      IF NOT FOUND OR e.event_kind <> 'withdraw'
        OR (p->>'status') NOT IN ('reconciled_external_supplier',
          'internal_vault_receiver', 'internal_force_deallocate',
          'unreconciled', 'ambiguous', 'unavailable')
        OR (p->>'sourceSha256') !~ '^[0-9a-f]{64}$'
        OR (p->>'evidenceSha256') !~ '^[0-9a-f]{64}$'
        OR jsonb_typeof(p->'evidence') IS DISTINCT FROM 'object'
        OR (p->>'attemptSlot')::bigint <= 0
        OR length(p->>'reason') NOT BETWEEN 1 AND 100
        OR p->'evidence'->>'vault' IS DISTINCT FROM e.vault
        OR p->'evidence'->>'transactionHash' IS DISTINCT FROM e.transaction_hash
        OR (p->'evidence'->>'logIndex')::integer IS DISTINCT FROM e.log_index
        OR p->'evidence'->>'blockHash' IS DISTINCT FROM e.block_hash
        OR p->'evidence'->>'block' IS DISTINCT FROM e.block::text
      THEN RAISE EXCEPTION 'invalid Morpho reconciliation evidence'; END IF;
      SELECT * INTO prior FROM carry_morpho_v2_withdraw_reconciliation
        WHERE vault = e.vault AND transaction_hash = e.transaction_hash
          AND log_index = e.log_index
        ORDER BY attempt_slot DESC LIMIT 1;
      IF FOUND THEN
        IF prior.attempt_slot > (p->>'attemptSlot')::bigint
        THEN RAISE EXCEPTION 'Morpho reconciliation attempt out of order'; END IF;
        IF prior.attempt_slot = (p->>'attemptSlot')::bigint
          OR prior.status <> 'unavailable' THEN
          IF prior.status IS DISTINCT FROM p->>'status'
            OR prior.reason IS DISTINCT FROM p->>'reason'
            OR prior.source_sha256 IS DISTINCT FROM p->>'sourceSha256'
            OR prior.evidence IS DISTINCT FROM p->'evidence'
            OR prior.evidence_sha256 IS DISTINCT FROM p->>'evidenceSha256'
          THEN RAISE EXCEPTION 'Morpho reconciliation replay disagreement'; END IF;
          RETURN false;
        END IF;
      END IF;
      INSERT INTO carry_morpho_v2_withdraw_reconciliation
        (vault, transaction_hash, log_index, attempt_slot, status, reason,
         source_sha256, evidence, evidence_sha256)
      VALUES (e.vault, e.transaction_hash, e.log_index,
        (p->>'attemptSlot')::bigint, p->>'status', p->>'reason',
        p->>'sourceSha256', p->'evidence', p->>'evidenceSha256');
      RETURN true;
    END $$`
  await sql`CREATE OR REPLACE FUNCTION reject_carry_morpho_v2_reconciliation_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Morpho reconciliation evidence is append only'; END $$`
  await sql.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'carry_morpho_v2_withdraw_reconciliation_immutable') THEN CREATE TRIGGER carry_morpho_v2_withdraw_reconciliation_immutable BEFORE UPDATE OR DELETE ON carry_morpho_v2_withdraw_reconciliation FOR EACH ROW EXECUTE FUNCTION reject_carry_morpho_v2_reconciliation_mutation(); END IF; END $$`,
  )
  await sql.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'carry_morpho_v2_withdraw_reconciliation_truncate') THEN CREATE TRIGGER carry_morpho_v2_withdraw_reconciliation_truncate BEFORE TRUNCATE ON carry_morpho_v2_withdraw_reconciliation FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_morpho_v2_reconciliation_mutation(); END IF; END $$`,
  )
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
    .then(() => process.stdout.write('morpho_withdraw_reconciliation ready\n'))
    .catch(() => {
      process.stderr.write('morpho_withdraw_reconciliation_ddl_failed\n')
      process.exitCode = 1
    })
}
