// Focused, one-shot venue alarm migration. The broad venue recorder DDL also
// changes unrelated tables; this statement touches only the alarm objects.
// The legacy checker must be stopped before --apply and must remain stopped
// until the new checker starts after this statement commits.
//
// node scripts/migrate-venue-alarm-terms.mjs
// node scripts/migrate-venue-alarm-terms.mjs --apply --checker-stopped

import { neon } from '@neondatabase/serverless'
import { pathToFileURL } from 'node:url'
import { readEnv } from './lib/venue-reads.mjs'

// Last failed checker tick, before the two observed 23:02:59 terms changes.
// The checker uses observed_at > boundary_at. Never replace this with now().
export const TERMS_BOUNDARY_AT = '2026-10-04T22:59:27Z'

// A DO statement is one PostgreSQL transaction in Neon HTTP autocommit mode.
// Any failed guard, index build, or DDL operation rolls back the entire change.
export const VENUE_ALARM_TERMS_MIGRATION_SQL = `DO $alarm_migration$
DECLARE
  boundary timestamptz := '${TERMS_BOUNDARY_AT}'::timestamptz;
  prior_count integer;
  prior_boundary timestamptz;
  prior_status text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(784160201::bigint);
  IF pg_catalog.to_regclass('public.venue_alarms') IS NULL
     OR pg_catalog.to_regclass('public.venue_events') IS NULL THEN
    RAISE EXCEPTION 'venue alarm migration dependencies missing';
  END IF;
  -- Keep alarm writes from interleaving the index replacement. The checker
  -- must also be stopped operationally; its old code has no migration lock.
  LOCK TABLE public.venue_alarms IN ACCESS EXCLUSIVE MODE;
  IF pg_catalog.to_regclass('public.venue_alarm_terms_migration') IS NULL THEN
    IF pg_catalog.to_regclass('public.venue_alarms_open_unique_idx') IS NULL
       OR pg_catalog.to_regclass('public.venue_alarms_condition_open_unique_idx') IS NOT NULL
       OR pg_catalog.to_regclass('public.venue_alarms_source_event_unique_idx') IS NOT NULL THEN
      RAISE EXCEPTION 'venue alarm schema is neither expected legacy nor complete migration';
    END IF;
  END IF;

  ALTER TABLE public.venue_alarms ADD COLUMN IF NOT EXISTS source_event_id uuid;
  ALTER TABLE public.venue_alarms ADD COLUMN IF NOT EXISTS delivery_claim_token uuid;
  ALTER TABLE public.venue_alarms ADD COLUMN IF NOT EXISTS delivery_claim_until timestamptz;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.venue_alarms'::regclass
      AND a.attname = 'source_event_id' AND a.atttypid = 'uuid'::regtype
      AND NOT a.attnotnull AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.venue_alarms'::regclass
      AND a.attname = 'delivery_claim_token' AND a.atttypid = 'uuid'::regtype
      AND NOT a.attnotnull AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.venue_alarms'::regclass
      AND a.attname = 'delivery_claim_until' AND a.atttypid = 'timestamptz'::regtype
      AND NOT a.attnotnull AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'venue alarm migration column definition mismatch';
  END IF;
  CREATE TABLE IF NOT EXISTS public.venue_alarm_terms_migration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    boundary_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'legacy_aggregate_unmapped_pre_boundary'
  );
  -- Preserve the exact historic boundary even if this DDL runs hours later.
  INSERT INTO public.venue_alarm_terms_migration (singleton, boundary_at, status)
    VALUES (true, boundary, 'legacy_aggregate_unmapped_pre_boundary')
    ON CONFLICT (singleton) DO NOTHING;
  SELECT count(*)::integer, min(boundary_at), min(status)
    INTO prior_count, prior_boundary, prior_status
    FROM public.venue_alarm_terms_migration;
  IF prior_count <> 1 OR prior_boundary IS DISTINCT FROM boundary
     OR prior_status IS DISTINCT FROM 'legacy_aggregate_unmapped_pre_boundary' THEN
    RAISE EXCEPTION 'venue alarm migration boundary or status conflicts with prior rollout';
  END IF;

  -- Build both replacement arbiters before removing the old open-row index.
  CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_condition_open_unique_idx
    ON public.venue_alarms (venue, kind)
    WHERE cleared_at IS NULL AND kind <> 'terms_page_notice';
  CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_source_event_unique_idx
    ON public.venue_alarms (source_event_id) WHERE source_event_id IS NOT NULL;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = 'public.venue_alarms_condition_open_unique_idx'::regclass
      AND i.indrelid = 'public.venue_alarms'::regclass
      AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 2
      AND pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'venue'
      AND pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) = 'kind'
      AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
        '((cleared_at IS NULL) AND (kind <> ''terms_page_notice''::text))'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = 'public.venue_alarms_source_event_unique_idx'::regclass
      AND i.indrelid = 'public.venue_alarms'::regclass
      AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 1
      AND pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'source_event_id'
      AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) = '(source_event_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'venue alarm replacement index definition mismatch';
  END IF;
  DROP INDEX IF EXISTS public.venue_alarms_open_unique_idx;
  CREATE INDEX IF NOT EXISTS venue_alarms_venue_fired_idx
    ON public.venue_alarms (venue, fired_at);
END $alarm_migration$`

export async function applyVenueAlarmTermsMigration(sql) {
  await sql.query(VENUE_ALARM_TERMS_MIGRATION_SQL)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const usage = 'Usage: node scripts/migrate-venue-alarm-terms.mjs [--apply --checker-stopped]'
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    console.log(`${usage}\nBoundary: ${TERMS_BOUNDARY_AT}. No SQL executed.`)
  } else if (
    args.length !== 2 ||
    !args.includes('--apply') ||
    !args.includes('--checker-stopped')
  ) {
    console.error(usage)
    process.exitCode = 2
  } else {
    try {
      const { get } = readEnv()
      const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
      if (!url) throw new Error('database URL missing')
      await applyVenueAlarmTermsMigration(neon(url))
      console.log(`Venue alarm migration committed. Boundary: ${TERMS_BOUNDARY_AT}.`)
    } catch {
      // Never print connection strings or server error payloads.
      console.error('Venue alarm migration failed or commit status unknown; inspect before retry.')
      process.exitCode = 1
    }
  }
}
