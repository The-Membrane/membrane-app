// Additive venue snapshot/event transaction boundary. NOT part of the running
// recorder until that process is deliberately switched after integration QA.
// Manual DDL mirrors db/schema.ts; never use drizzle-kit push for this change.
// Usage: node scripts/apply-venue-recorder-atomic-ddl.mjs

import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

const { get } = readEnv()
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) throw new Error('venue_atomic_database_url_unset')
const sql = neon(url)

// NULL means pre-migration/legacy. No legacy row is rewritten or marked.
await sql`ALTER TABLE venue_snapshots ADD COLUMN IF NOT EXISTS recorder_atomic_v1 boolean`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_snapshots_atomic_v1_venue_chain_block_idx
  ON venue_snapshots (venue, chain, block) WHERE recorder_atomic_v1 IS TRUE`
await sql`CREATE INDEX IF NOT EXISTS venue_snapshots_atomic_v1_predecessor_idx
  ON venue_snapshots (venue, chain, block DESC)
  WHERE recorder_atomic_v1 IS TRUE`

// A single SELECT runs this entire PL/pgSQL function in one DB transaction.
// Advisory serialization is scoped to venue+chain among v1 callers; the
// predecessor CAS protects against stale callers. Legacy recorder writes
// do not take this lock, so the future switch needs an operational cutover.
await sql`CREATE OR REPLACE FUNCTION ingest_venue_snapshot_atomic_v1(
  p_venue text,
  p_chain text,
  p_block bigint,
  p_instant_usd numeric,
  p_cooling_usd numeric,
  p_stranded_usd numeric,
  p_params jsonb,
  p_expected_predecessor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE
  v_previous venue_snapshots%ROWTYPE;
  v_snapshot_id uuid;
  v_key text;
  v_old jsonb;
  v_new jsonb;
  v_old_num numeric;
  v_new_num numeric;
  v_event_count integer := 0;
  v_now timestamptz;
  v_source_time numeric;
  v_highest_observed_block bigint;
  v_latest_observed_at timestamptz;
BEGIN
  IF p_venue IS NULL OR p_venue = '' OR p_chain IS DISTINCT FROM 'ethereum'
     OR p_block IS NULL OR p_block < 0
     OR jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'venue_atomic_invalid_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('venue-atomic-v1:' || p_venue || ':' || p_chain, 0));
  v_now := clock_timestamp();
  IF p_params->'read_block_finalized' IS DISTINCT FROM 'true'::jsonb
     OR p_params->'read_block_pinned' IS DISTINCT FROM 'true'::jsonb
     OR p_params->>'read_block_number' IS DISTINCT FROM p_block::text
     OR COALESCE(p_params->>'read_block_hash', '') !~ '^0x[0-9a-fA-F]{64}$'
     OR COALESCE(p_params->>'read_block_time', '') !~ '^[0-9]{10,12}$' THEN
    RAISE EXCEPTION 'venue_atomic_invalid_finalized_source';
  END IF;
  v_source_time := (p_params->>'read_block_time')::numeric;
  IF EXTRACT(EPOCH FROM v_now) - v_source_time NOT BETWEEN -120 AND 7200 THEN
    RETURN jsonb_build_object('status', 'stale_source');
  END IF;

  SELECT * INTO v_previous FROM venue_snapshots
    WHERE venue = p_venue AND chain = p_chain AND source = 'observed'
      AND recorder_atomic_v1 IS TRUE
    ORDER BY block DESC LIMIT 1;
  IF v_previous.id IS DISTINCT FROM p_expected_predecessor_id THEN
    RETURN jsonb_build_object('status', 'conflict', 'predecessor_id', v_previous.id);
  END IF;
  IF v_previous.id IS NOT NULL AND p_block <= v_previous.block THEN
    RETURN jsonb_build_object('status', 'skipped_block', 'predecessor_id', v_previous.id);
  END IF;

  -- Respect any legacy observed row at cutover too. Legacy does not take the
  -- advisory lock, so the running service must be stopped before v1 activation.
  SELECT max(block), max(observed_at)
    INTO v_highest_observed_block, v_latest_observed_at FROM venue_snapshots
    WHERE venue = p_venue AND chain = p_chain AND source = 'observed';
  IF v_highest_observed_block IS NOT NULL THEN
    IF p_block <= v_highest_observed_block THEN
      RETURN jsonb_build_object('status', 'skipped_block', 'predecessor_id', v_previous.id);
    END IF;
    IF v_latest_observed_at > v_now - interval '10 minutes' THEN
      RETURN jsonb_build_object('status', 'skipped_recent', 'predecessor_id', v_previous.id);
    END IF;
  END IF;

  INSERT INTO venue_snapshots
    (venue, chain, block, observed_at, instant_usd, cooling_usd, stranded_usd,
     params, source, recorder_atomic_v1)
    VALUES (p_venue, p_chain, p_block, v_now, p_instant_usd, p_cooling_usd,
            p_stranded_usd, p_params, 'observed', TRUE)
    RETURNING id INTO v_snapshot_id;

  -- The first marked row is a quiet baseline. A legacy row may have been
  -- written just before a crash and its event completeness is unknowable.
  IF v_previous.id IS NOT NULL THEN
    FOR v_key IN
      SELECT key FROM (
        SELECT jsonb_object_keys(v_previous.params) AS key
        UNION SELECT jsonb_object_keys(p_params) AS key
      ) keys ORDER BY key
    LOOP
      IF v_key = ANY (ARRAY[
        'kind', 'reads', 'instant_note', 'depthMarkets', 'depth_note',
        'depth_complete', 'read_block_pinned', 'read_block_finalized',
        'read_block_number', 'read_block_hash', 'read_block_time',
        'utilization_note', 'variableDebtToken'
      ]) THEN CONTINUE; END IF;
      v_old := v_previous.params->v_key;
      v_new := p_params->v_key;
      IF v_old IS NULL OR v_new IS NULL OR v_old = 'null'::jsonb
         OR v_new = 'null'::jsonb OR v_old = v_new THEN CONTINUE; END IF;

      IF v_key = ANY (ARRAY[
        'totalAssets', 'totalSupply', 'underlyingBalance', 'depth_usd',
        'depth_skew_pct', 'variableDebt', 'utilization_pct'
      ]) THEN
        -- Failed or nonnumeric readings do not become change events.
        BEGIN
          v_old_num := (v_old #>> '{}')::numeric;
          v_new_num := (v_new #>> '{}')::numeric;
          IF v_old_num = 0
             OR v_old_num IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
             OR v_new_num IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
             OR ABS(v_new_num - v_old_num) / ABS(v_old_num) <= 0.2 THEN
            CONTINUE;
          END IF;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          CONTINUE;
        END;
      END IF;

      v_event_count := v_event_count + 1;
      IF v_event_count > 64 THEN RAISE EXCEPTION 'venue_atomic_too_many_events'; END IF;
      INSERT INTO venue_events (venue, kind, prev, next, note, snapshot_id)
        VALUES (p_venue,
                CASE WHEN v_key = 'cooldownDuration' THEN 'cooldown_duration_changed'
                     ELSE 'param_changed' END,
                jsonb_build_object(v_key, v_old), jsonb_build_object(v_key, v_new),
                left(format('%s: %s -> %s', v_key, v_old #>> '{}', v_new #>> '{}'), 250),
                v_snapshot_id);
    END LOOP;

    IF v_previous.instant_usd IS NOT NULL AND p_instant_usd IS NOT NULL
       AND v_previous.instant_usd <> 0
       AND v_previous.instant_usd <> 'NaN'::numeric
       AND p_instant_usd <> 'NaN'::numeric
       AND v_previous.instant_usd NOT IN ('Infinity'::numeric, '-Infinity'::numeric)
       AND p_instant_usd NOT IN ('Infinity'::numeric, '-Infinity'::numeric)
       AND ABS(p_instant_usd - v_previous.instant_usd)
           / ABS(v_previous.instant_usd) > 0.2 THEN
      v_event_count := v_event_count + 1;
      IF v_event_count > 64 THEN RAISE EXCEPTION 'venue_atomic_too_many_events'; END IF;
      INSERT INTO venue_events (venue, kind, prev, next, note, snapshot_id)
        VALUES (p_venue, 'instant_liquidity_shift',
                jsonb_build_object('instant_usd', v_previous.instant_usd),
                jsonb_build_object('instant_usd', p_instant_usd),
                'instant_usd ' || round(
                  100 * (p_instant_usd - v_previous.instant_usd)
                      / ABS(v_previous.instant_usd), 1)::text || '%',
                v_snapshot_id);
    END IF;
  END IF;
  RETURN jsonb_build_object('status', 'inserted', 'snapshot_id', v_snapshot_id,
                            'predecessor_id', v_previous.id,
                            'event_count', v_event_count);
END;
$$`

console.log('venue recorder atomic-v1 DDL ready; live recorder unchanged')
