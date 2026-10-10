import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  LIQUIDATION_INGEST_DDL,
  LIQUIDATION_INGEST_MIGRATION,
  LIQUIDATION_INGEST_REVOKE,
  applyLiquidationIngestDdl,
} from './apply-liquidation-ingest-ddl.mjs'

test('migration emits one fail-closed security-definer function with replay and Telegram-only gates', async () => {
  const statements = []
  await applyLiquidationIngestDdl({ query: async (statement) => statements.push(statement) })
  assert.deepEqual(statements, [LIQUIDATION_INGEST_MIGRATION])
  assert.match(
    LIQUIDATION_INGEST_MIGRATION,
    /^DO \$migration\$ BEGIN\s+IF pg_catalog\.to_regclass\('public\.user_alert_chain_events'\)/,
  )
  assert.match(LIQUIDATION_INGEST_MIGRATION, /to_regclass\('public\.user_alert_preferences'\)/)
  assert.match(
    LIQUIDATION_INGEST_MIGRATION,
    /to_regprocedure\('public\.enqueue_user_alert_chain_event\(bigint,text,text\)'\)/,
  )
  assert.match(
    LIQUIDATION_INGEST_MIGRATION,
    /RAISE EXCEPTION 'public liquidation ingest dependencies are missing'/,
  )
  assert.ok(
    LIQUIDATION_INGEST_MIGRATION.indexOf('public liquidation ingest dependencies are missing') <
      LIQUIDATION_INGEST_MIGRATION.indexOf('EXECUTE $definition$'),
  )
  assert.match(LIQUIDATION_INGEST_MIGRATION, /FROM PUBLIC;\s+IF EXISTS/)
  assert.match(LIQUIDATION_INGEST_MIGRATION, /permission\.privilege_type = 'EXECUTE'/)
  assert.match(LIQUIDATION_INGEST_MIGRATION, /permission\.grantee <> function_row\.proowner/)
  assert.match(
    LIQUIDATION_INGEST_MIGRATION,
    /RAISE EXCEPTION 'liquidation ingest function has non-owner EXECUTE grant'/,
  )
  assert.match(LIQUIDATION_INGEST_MIGRATION, /END; \$migration\$$/)
  assert.match(
    LIQUIDATION_INGEST_DDL,
    /^CREATE FUNCTION public\.ingest_verified_liquidation_event\(/,
  )
  assert.doesNotMatch(LIQUIDATION_INGEST_DDL, /CREATE OR REPLACE|SECURITY INVOKER/)
  assert.match(LIQUIDATION_INGEST_DDL, /SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/)
  assert.match(LIQUIDATION_INGEST_DDL, /DECLARE v_prior public\.user_alert_chain_events%ROWTYPE/)
  assert.match(LIQUIDATION_INGEST_DDL, /INSERT INTO public\.user_alert_chain_events/)
  assert.match(LIQUIDATION_INGEST_DDL, /FROM public\.user_alert_chain_events/)
  assert.match(
    LIQUIDATION_INGEST_DDL,
    /ON CONFLICT \(chain_id, emitter_address, transaction_hash, log_index\) DO NOTHING/,
  )
  assert.match(LIQUIDATION_INGEST_DDL, /source_attestation IS DISTINCT FROM p_attestation/)
  assert.match(LIQUIDATION_INGEST_DDL, /'conflicting_replay'/)
  assert.match(LIQUIDATION_INGEST_DDL, /'duplicate'/)
  assert.match(
    LIQUIDATION_INGEST_DDL,
    /PERFORM 1 FROM public\.user_alert_preferences\s+WHERE pg_catalog\.lower\(address\) = p_subject FOR UPDATE;/,
  )
  assert.match(
    LIQUIDATION_INGEST_DDL,
    /public\.enqueue_user_alert_chain_event\(v_event_id, p_subject, 'telegram'\)/,
  )
  assert.match(LIQUIDATION_INGEST_DDL, /'no_pre_event_consent'/)
  assert.match(LIQUIDATION_INGEST_DDL, /'queued'/)
  assert.match(
    LIQUIDATION_INGEST_DDL,
    /NOT COALESCE\(\(p_attestation->>'runtimeCodeHash'\) ~ '\^0x\[0-9a-f\]\{64\}\$', false\)/,
  )
  assert.match(LIQUIDATION_INGEST_DDL, /NOT COALESCE\(\(p_attestation->>'positionId'\) ~/)
  assert.match(LIQUIDATION_INGEST_DDL, /NOT COALESCE\(\(p_attestation->>'startTime'\) ~/)
  assert.match(
    LIQUIDATION_INGEST_REVOKE,
    /^REVOKE ALL ON FUNCTION public\.ingest_verified_liquidation_event\(.+\) FROM PUBLIC$/,
  )
})

test('dry-run and absent migration credential never connect or expose secret', () => {
  const script = new URL('./apply-liquidation-ingest-ddl.mjs', import.meta.url).pathname
  const env = { ...process.env }
  delete env.USER_ALERT_MIGRATION_DATABASE_URL
  const dry = spawnSync(process.execPath, [script, '--dry-run'], { env, encoding: 'utf8' })
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /No SQL executed/)
  const run = spawnSync(process.execPath, [script, '--run'], { env, encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /USER_ALERT_MIGRATION_DATABASE_URL is required/)
})
