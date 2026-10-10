// INERT additive migration: requires the existing preferences and outbox DDL.
// No indexer, sender, or historical backfill is enabled by this script.
import { pathToFileURL } from 'node:url'

import { neon } from '@neondatabase/serverless'

export const LIQUIDATION_INGEST_DDL = `CREATE FUNCTION public.ingest_verified_liquidation_event(
  p_chain_id integer, p_emitter text, p_tx text, p_log_index integer,
  p_block_number bigint, p_block_hash text, p_occurred_at timestamptz,
  p_first_observed_at timestamptz, p_kind text, p_subject text,
  p_attestation jsonb
) RETURNS TABLE(status text, outbox_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_event_id bigint;
DECLARE v_prior public.user_alert_chain_events%ROWTYPE;
DECLARE v_outbox_id bigint;
BEGIN
  IF p_chain_id IS DISTINCT FROM 1
    OR NOT COALESCE(p_emitter ~ '^0x[0-9a-f]{40}$', false)
    OR NOT COALESCE(p_tx ~ '^0x[0-9a-f]{64}$', false)
    OR p_log_index IS NULL OR p_log_index < 0
    OR p_block_number IS NULL OR p_block_number <= 0
    OR NOT COALESCE(p_block_hash ~ '^0x[0-9a-f]{64}$', false)
    OR NOT COALESCE(p_subject ~ '^0x[0-9a-f]{40}$', false)
    OR p_kind IS NULL OR p_kind NOT IN ('delay_started', 'position_kept')
    OR p_occurred_at IS NULL OR p_first_observed_at IS NULL
    OR p_first_observed_at < p_occurred_at
    OR p_attestation IS NULL OR pg_catalog.jsonb_typeof(p_attestation) IS DISTINCT FROM 'object'
    OR p_attestation->>'proofVersion' IS DISTINCT FROM '1'
    OR NOT COALESCE((p_attestation->>'runtimeCodeHash') ~ '^0x[0-9a-f]{64}$', false)
    OR NOT COALESCE((p_attestation->>'positionId') ~ '^(0|[1-9][0-9]*)$', false)
    OR (p_kind = 'delay_started' AND NOT COALESCE((p_attestation->>'startTime') ~ '^(0|[1-9][0-9]*)$', false))
    OR (p_kind = 'position_kept' AND p_attestation->'startTime' IS DISTINCT FROM 'null'::jsonb)
  THEN RAISE EXCEPTION 'invalid liquidation ingest input'; END IF;

  INSERT INTO public.user_alert_chain_events (
    chain_id, emitter_address, transaction_hash, log_index, block_number,
    block_hash, occurred_at, first_observed_at, kind, subject_address, source_attestation
  ) VALUES (
    p_chain_id, p_emitter, p_tx, p_log_index, p_block_number,
    p_block_hash, p_occurred_at, p_first_observed_at, p_kind, p_subject, p_attestation
  ) ON CONFLICT (chain_id, emitter_address, transaction_hash, log_index) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT * INTO v_prior FROM public.user_alert_chain_events
    WHERE chain_id = p_chain_id AND emitter_address = p_emitter
      AND transaction_hash = p_tx AND log_index = p_log_index;
    IF NOT FOUND THEN RAISE EXCEPTION 'liquidation replay row unavailable'; END IF;
    IF v_prior.block_number IS DISTINCT FROM p_block_number
      OR v_prior.block_hash IS DISTINCT FROM p_block_hash
      OR v_prior.occurred_at IS DISTINCT FROM p_occurred_at
      OR v_prior.kind IS DISTINCT FROM p_kind
      OR v_prior.subject_address IS DISTINCT FROM p_subject
      OR v_prior.source_attestation IS DISTINCT FROM p_attestation
    THEN RETURN QUERY SELECT 'conflicting_replay'::text, NULL::bigint;
    ELSE RETURN QUERY SELECT 'duplicate'::text, NULL::bigint;
    END IF;
    RETURN;
  END IF;

  -- Lock current preference through this statement's commit. A concurrent
  -- pause/replacement cannot slip between eligibility and enqueue.
  PERFORM 1 FROM public.user_alert_preferences
    WHERE pg_catalog.lower(address) = p_subject FOR UPDATE;
  v_outbox_id := public.enqueue_user_alert_chain_event(v_event_id, p_subject, 'telegram');
  IF v_outbox_id IS NULL THEN
    RETURN QUERY SELECT 'no_pre_event_consent'::text, NULL::bigint;
  ELSE
    RETURN QUERY SELECT 'queued'::text, v_outbox_id;
  END IF;
END;
$$`

export const LIQUIDATION_INGEST_REVOKE = `REVOKE ALL ON FUNCTION public.ingest_verified_liquidation_event(integer,text,text,integer,bigint,text,timestamptz,timestamptz,text,text,jsonb) FROM PUBLIC`

// One PostgreSQL statement: CREATE, REVOKE, and ACL verification commit or
// roll back together. CREATE (without OR REPLACE) rejects a preexisting ACL.
export const LIQUIDATION_INGEST_MIGRATION = `DO $migration$ BEGIN
  IF pg_catalog.to_regclass('public.user_alert_chain_events') IS NULL
    OR pg_catalog.to_regclass('public.user_alert_preferences') IS NULL
    OR pg_catalog.to_regprocedure('public.enqueue_user_alert_chain_event(bigint,text,text)') IS NULL
  THEN
    RAISE EXCEPTION 'public liquidation ingest dependencies are missing';
  END IF;
  EXECUTE $definition$${LIQUIDATION_INGEST_DDL}$definition$;
  ${LIQUIDATION_INGEST_REVOKE};
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS permission
    WHERE function_row.oid = 'public.ingest_verified_liquidation_event(integer,text,text,integer,bigint,text,timestamptz,timestamptz,text,text,jsonb)'::pg_catalog.regprocedure
      AND permission.privilege_type = 'EXECUTE'
      AND permission.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'liquidation ingest function has non-owner EXECUTE grant';
  END IF;
END; $migration$`

export async function applyLiquidationIngestDdl(sql) {
  await sql.query(LIQUIDATION_INGEST_MIGRATION)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const usage = 'Usage: node scripts/apply-liquidation-ingest-ddl.mjs [--help|--dry-run|--run]'
  const mode = process.argv.slice(2)
  if (
    mode.length > 1 ||
    (mode.length === 1 && !['--help', '--dry-run', '--run'].includes(mode[0]))
  ) {
    console.error(usage)
    process.exitCode = 2
  } else if (mode.length === 0 || mode[0] !== '--run') {
    console.log(`${usage}\nNo SQL executed. --run requires USER_ALERT_MIGRATION_DATABASE_URL.`)
  } else {
    const url = process.env.USER_ALERT_MIGRATION_DATABASE_URL?.trim()
    if (!url) {
      console.error('USER_ALERT_MIGRATION_DATABASE_URL is required; no SQL executed.')
      process.exitCode = 2
    } else {
      try {
        await applyLiquidationIngestDdl(neon(url))
        console.log('liquidation ingest function ready; no ingestion or sender enabled')
      } catch {
        console.error('Liquidation ingest migration failed; inspect the target database.')
        process.exitCode = 1
      }
    }
  }
}
