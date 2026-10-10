// One-shot, additive DDL for the venue withdrawal-ability recorder (owner-
// approved). Four tables mirroring the drizzle definitions in db/schema.ts:
//   venue_snapshots  — insert-only point-in-time readings of a venue's state
//   venue_events     — insert-only "news tracker": state CHANGES between snapshots
//   venue_predictions — insert once, then exactly one scoring UPDATE per row
//   venue_flows      — insert-only REALIZED deposit/withdraw volumes from logs
//
//   node scripts/apply-venue-recorder-ddl.mjs        (from the membrane-app root)
//
// Applied manually (pet_wraps / indexer_cursor precedent) instead of
// `drizzle-kit push` so a schema drift elsewhere can't turn this into a
// destructive diff. Reads DATABASE_URL_UNPOOLED (falls back to DATABASE_URL)
// from .env.local. Safe to re-run: everything is IF NOT EXISTS.
//
// tsx/node get NO Next env injection — .env.local is parsed by hand below.

import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(join(root, '.env.local'), 'utf8')
const get = (k) =>
  (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '')
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(url)

await sql`CREATE TABLE IF NOT EXISTS venue_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  chain text NOT NULL DEFAULT 'ethereum',
  block bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  instant_usd numeric,
  cooling_usd numeric,
  stranded_usd numeric,
  params jsonb NOT NULL,
  source text NOT NULL DEFAULT 'observed',
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE INDEX IF NOT EXISTS venue_snapshots_venue_observed_idx ON venue_snapshots (venue, observed_at)`
// The prospective USDe ledger reads this provenance flag. NULL remains the
// truthful value for legacy snapshots; the atomic recorder has its own cutover.
await sql`ALTER TABLE venue_snapshots ADD COLUMN IF NOT EXISTS recorder_atomic_v1 boolean`

await sql`CREATE TABLE IF NOT EXISTS venue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  kind text NOT NULL,
  prev jsonb,
  next jsonb,
  note text,
  snapshot_id uuid,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE INDEX IF NOT EXISTS venue_events_venue_observed_idx ON venue_events (venue, observed_at)`

await sql`CREATE TABLE IF NOT EXISTS venue_event_drivers (
  event_id uuid PRIMARY KEY,
  venue text NOT NULL,
  status text NOT NULL,
  evidence jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE INDEX IF NOT EXISTS venue_event_drivers_venue_computed_idx ON venue_event_drivers (venue, computed_at)`

await sql`CREATE TABLE IF NOT EXISTS venue_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  metric text NOT NULL,
  made_at timestamptz NOT NULL DEFAULT now(),
  horizon_hours integer NOT NULL,
  band_low numeric NOT NULL,
  band_high numeric NOT NULL,
  model text NOT NULL,
  realized numeric,
  scored_at timestamptz,
  hit boolean
)`
await sql`CREATE INDEX IF NOT EXISTS venue_predictions_venue_made_idx ON venue_predictions (venue, made_at)`
// Partial index over unscored predictions: the recorder scans these every pass
// to find rows whose horizon has elapsed and score them.
await sql`CREATE INDEX IF NOT EXISTS venue_predictions_unscored_idx ON venue_predictions (venue, made_at) WHERE scored_at IS NULL`

// venue_flows — insert-only REALIZED deposit/withdraw volumes, decoded from
// on-chain event logs (scripts/record-venue-flows.mjs). Snapshots record
// CAPACITY (what COULD exit); flows record transacted DEMAND (what DID move).
// Together they enable the owner's saturation method: realized outflow ≈
// available capacity ⇒ demand was likely censored (unserved withdrawers).
//
// NOTE ON PROVENANCE — there is deliberately no observed/backfilled split here
// (unlike venue_snapshots). Event logs ARE the on-chain record of past process;
// fetching old logs is legitimate history, not a reconstruction of state that
// was never observed. Every row is an actual emitted event.
//
// assets_raw is the underlying amount in BASE UNITS (raw uint256, unscaled) —
// USD is derived downstream at $1/stable. UNIQUE(venue, tx_hash, log_index)
// makes re-fetch over an already-scanned range idempotent (INSERT ... ON
// CONFLICT DO NOTHING). Legacy rows without sealed range receipts are not
// evidence that a quiet window was scanned, and are never promoted as such.
await sql`CREATE TABLE IF NOT EXISTS venue_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  block bigint NOT NULL,
  block_time timestamptz NOT NULL,
  direction text NOT NULL,
  assets_raw numeric NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_flows_venue_tx_log_idx ON venue_flows (venue, tx_hash, log_index)`
await sql`CREATE INDEX IF NOT EXISTS venue_flows_venue_block_idx ON venue_flows (venue, block)`

// Sealed, finalized getLogs coverage. A receipt is inserted only after both
// configured streams and all idempotent event inserts succeeded. A zero-log
// window still gets a receipt. Never backfill receipts for legacy flow rows.
await sql`CREATE TABLE IF NOT EXISTS venue_flow_range_receipts (
  venue text NOT NULL,
  from_block bigint NOT NULL,
  to_block bigint NOT NULL,
  from_hash text NOT NULL,
  to_hash text NOT NULL,
  finalized_head_block bigint NOT NULL,
  finalized_head_hash text NOT NULL,
  streamset_hash text NOT NULL,
  streams jsonb NOT NULL,
  event_set_hash text,
  receipt_hash text NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue, from_block),
  CONSTRAINT venue_flow_range_order_check CHECK (from_block >= 0 AND to_block >= from_block),
  CONSTRAINT venue_flow_range_finality_check CHECK (finalized_head_block >= to_block)
)`
// Earlier experimental receipts without this field remain invalid to the
// recorder; do not infer their event set or backfill it from mutable rows.
await sql`ALTER TABLE venue_flow_range_receipts ADD COLUMN IF NOT EXISTS event_set_hash text`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_flow_range_to_unique_idx ON venue_flow_range_receipts (venue, to_block)`

// Research-only prospective USDe sampled-cash ledger. Issuance and scoring
// are separate INSERTs so the original claim survives outcome collection.
// TEXT preserves the exact JSON.stringify byte order used by receipt hashes;
// jsonb would reorder object keys and break SHA verification on reload.
await sql`CREATE TABLE IF NOT EXISTS aave_usde_cash_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study text NOT NULL,
  anchor_id uuid NOT NULL REFERENCES venue_snapshots(id),
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  horizon_seconds integer NOT NULL CHECK (horizon_seconds > 0),
  issued_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL,
  target_at timestamptz NOT NULL,
  payload text NOT NULL,
  payload_sha256 text NOT NULL,
  source_row_ids jsonb NOT NULL,
  source_row_set_sha256 text NOT NULL,
  publisher_xid bigint,
  CONSTRAINT aave_usde_cash_issues_clock_check CHECK (
    persisted_at >= issued_at AND
    persisted_at <= issued_at + interval '60 seconds' AND
    persisted_at < target_at
  )
)`
await sql`ALTER TABLE public.aave_usde_cash_issues ADD COLUMN IF NOT EXISTS publisher_xid bigint`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS aave_usde_cash_issues_key_idx ON aave_usde_cash_issues (study, anchor_id, amount_usd, horizon_seconds)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS aave_usde_cash_issues_payload_sha_idx ON aave_usde_cash_issues (payload_sha256)`
await sql`CREATE INDEX IF NOT EXISTS aave_usde_cash_issues_target_idx ON aave_usde_cash_issues (target_at, id)`

await sql`CREATE TABLE IF NOT EXISTS aave_usde_cash_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES aave_usde_cash_issues(id),
  scored_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL,
  payload text NOT NULL,
  payload_sha256 text NOT NULL,
  source_row_ids jsonb NOT NULL,
  source_row_set_sha256 text NOT NULL,
  CONSTRAINT aave_usde_cash_scores_clock_check CHECK (
    persisted_at >= scored_at AND
    persisted_at <= scored_at + interval '60 seconds'
  )
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS aave_usde_cash_scores_issue_idx ON aave_usde_cash_scores (issue_id)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS aave_usde_cash_scores_payload_sha_idx ON aave_usde_cash_scores (payload_sha256)`

// The future expected-slot manifest is immutable. Its publisher function
// verifies exact JSON bytes, slot grid, and database statement-time lead.
// GiST exclusion is the hard overlap invariant even under an old SSI snapshot;
// the advisory lock in the publisher is an early, clearer conflict check.
await sql`CREATE TABLE IF NOT EXISTS public.aave_usde_cash_schedules (
  manifest_sha256 text PRIMARY KEY CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  payload text NOT NULL,
  planned_at timestamptz NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  cadence_seconds integer NOT NULL CHECK (cadence_seconds = 3600),
  persisted_at timestamptz NOT NULL,
  publisher_xid bigint NOT NULL,
  CONSTRAINT aave_usde_cash_schedules_time_check CHECK (
    planned_at <= persisted_at AND persisted_at <= planned_at + interval '60 seconds'
    AND start_at >= persisted_at + interval '2 hours'
    AND end_at > start_at AND end_at <= start_at + interval '366 days'
  ),
  CONSTRAINT aave_usde_cash_schedules_no_overlap
    EXCLUDE USING gist (tstzrange(start_at, end_at, '[)') WITH &&)
)`
await sql`ALTER TABLE public.aave_usde_cash_schedules ADD COLUMN IF NOT EXISTS publisher_xid bigint`
await sql`ALTER TABLE public.aave_usde_cash_schedules ALTER COLUMN publisher_xid SET NOT NULL`
await sql`DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.aave_usde_cash_schedules'::regclass
      AND conname='aave_usde_cash_schedules_no_overlap'
  ) THEN
    ALTER TABLE public.aave_usde_cash_schedules ADD CONSTRAINT aave_usde_cash_schedules_no_overlap
      EXCLUDE USING gist (tstzrange(start_at, end_at, '[)') WITH &&);
  END IF;
END $$`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS aave_usde_cash_schedules_start_idx ON public.aave_usde_cash_schedules (start_at)`

// A second transaction can see the manifest only after its publisher commits.
// Its distinct txid and early DB clock bound the manifest COMMIT before slot.
await sql`CREATE TABLE IF NOT EXISTS public.aave_usde_cash_schedule_confirmations (
  manifest_sha256 text PRIMARY KEY REFERENCES public.aave_usde_cash_schedules(manifest_sha256),
  confirmed_at timestamptz NOT NULL,
  confirmer_xid bigint NOT NULL,
  CONSTRAINT aave_usde_cash_schedule_confirmations_xid_check CHECK (confirmer_xid > 0)
)`

await sql`CREATE TABLE IF NOT EXISTS public.aave_usde_cash_issue_run_confirmations (
  run_id uuid PRIMARY KEY,
  manifest_sha256 text NOT NULL REFERENCES public.aave_usde_cash_schedules(manifest_sha256),
  slot_id text NOT NULL CHECK (slot_id ~ '^[0-9a-f]{64}$'),
  confirmed_at timestamptz NOT NULL,
  confirmer_xid bigint NOT NULL,
  result_xid bigint NOT NULL,
  CONSTRAINT aave_usde_cash_issue_run_confirmations_xid_check CHECK (confirmer_xid <> result_xid)
)`
await sql`CREATE INDEX IF NOT EXISTS aave_usde_cash_issue_run_confirmations_manifest_idx
  ON public.aave_usde_cash_issue_run_confirmations (manifest_sha256, slot_id)`

// Each run first commits nine scheduled arms. A missing result event after a
// crash is visible in the study denominator; issued/duplicate/abstained/failed
// results are separate immutable rows.
await sql`CREATE TABLE IF NOT EXISTS aave_usde_cash_issue_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL,
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  horizon_seconds integer NOT NULL CHECK (horizon_seconds > 0),
  phase text NOT NULL CHECK (phase IN ('start', 'result')),
  status text NOT NULL CHECK (status IN ('scheduled', 'issued', 'duplicate', 'abstained', 'failed')),
  reason text,
  issue_id uuid REFERENCES aave_usde_cash_issues(id),
  manifest_sha256 text,
  slot_id text,
  publisher_xid bigint,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aave_usde_cash_issue_attempts_manifest_fkey
    FOREIGN KEY (manifest_sha256) REFERENCES public.aave_usde_cash_schedules(manifest_sha256),
  CONSTRAINT aave_usde_cash_issue_attempts_binding_check CHECK (
    (manifest_sha256 IS NULL AND slot_id IS NULL) OR
    (manifest_sha256 IS NOT NULL AND slot_id ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT aave_usde_cash_issue_attempts_phase_check CHECK (
    (phase='start' AND status='scheduled' AND reason IS NULL AND issue_id IS NULL) OR
    (phase='result' AND status IN ('issued', 'duplicate', 'abstained', 'failed') AND
      ((status IN ('issued', 'duplicate') AND issue_id IS NOT NULL AND reason IS NULL) OR
       (status IN ('abstained', 'failed') AND issue_id IS NULL AND reason IS NOT NULL)))
  )
)`
await sql`ALTER TABLE public.aave_usde_cash_issue_attempts ADD COLUMN IF NOT EXISTS manifest_sha256 text`
await sql`ALTER TABLE public.aave_usde_cash_issue_attempts ADD COLUMN IF NOT EXISTS slot_id text`
await sql`ALTER TABLE public.aave_usde_cash_issue_attempts ADD COLUMN IF NOT EXISTS publisher_xid bigint`
await sql`DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.aave_usde_cash_issue_attempts'::regclass
      AND conname='aave_usde_cash_issue_attempts_manifest_fkey'
  ) THEN
    ALTER TABLE public.aave_usde_cash_issue_attempts ADD CONSTRAINT aave_usde_cash_issue_attempts_manifest_fkey
      FOREIGN KEY (manifest_sha256) REFERENCES public.aave_usde_cash_schedules(manifest_sha256);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.aave_usde_cash_issue_attempts'::regclass
      AND conname='aave_usde_cash_issue_attempts_binding_check'
  ) THEN
    ALTER TABLE public.aave_usde_cash_issue_attempts ADD CONSTRAINT aave_usde_cash_issue_attempts_binding_check
      CHECK ((manifest_sha256 IS NULL AND slot_id IS NULL) OR
             (manifest_sha256 IS NOT NULL AND slot_id ~ '^[0-9a-f]{64}$'));
  END IF;
END $$`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS aave_usde_cash_issue_attempts_arm_phase_idx ON aave_usde_cash_issue_attempts (run_id, amount_usd, horizon_seconds, phase)`
await sql`CREATE INDEX IF NOT EXISTS aave_usde_cash_issue_attempts_manifest_idx ON public.aave_usde_cash_issue_attempts (manifest_sha256, slot_id, recorded_at)`

// Failed score transactions are retried, but their durable attempt IDs move
// them behind previously unattempted due issues. This prevents a corrupt old
// batch from indefinitely starving later valid issues.
await sql`CREATE TABLE IF NOT EXISTS aave_usde_cash_score_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES aave_usde_cash_issues(id),
  status text NOT NULL CHECK (status IN ('scored', 'already_scored', 'pending', 'failed')),
  reason text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aave_usde_cash_score_attempts_reason_check CHECK (
    (status='failed' AND reason IS NOT NULL) OR (status<>'failed' AND reason IS NULL)
  )
)`
await sql`CREATE INDEX IF NOT EXISTS aave_usde_cash_score_attempts_issue_id_idx ON aave_usde_cash_score_attempts (issue_id, id DESC)`

// A collector with UPDATE/DELETE privileges still cannot rewrite a receipt.
await sql`CREATE OR REPLACE FUNCTION public.reject_aave_usde_cash_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'prospective cash receipts are append-only';
END;
$$`
await sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.aave_usde_cash_issues'::regclass AND tgname = 'aave_usde_cash_issues_append_only') THEN
    CREATE TRIGGER aave_usde_cash_issues_append_only
      BEFORE UPDATE OR DELETE ON public.aave_usde_cash_issues
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_cash_receipt_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.aave_usde_cash_scores'::regclass AND tgname = 'aave_usde_cash_scores_append_only') THEN
    CREATE TRIGGER aave_usde_cash_scores_append_only
      BEFORE UPDATE OR DELETE ON public.aave_usde_cash_scores
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_cash_receipt_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.aave_usde_cash_issue_attempts'::regclass AND tgname = 'aave_usde_cash_issue_attempts_append_only') THEN
    CREATE TRIGGER aave_usde_cash_issue_attempts_append_only
      BEFORE UPDATE OR DELETE ON public.aave_usde_cash_issue_attempts
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_cash_receipt_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.aave_usde_cash_schedules'::regclass AND tgname = 'aave_usde_cash_schedules_append_only') THEN
    CREATE TRIGGER aave_usde_cash_schedules_append_only
      BEFORE UPDATE OR DELETE ON public.aave_usde_cash_schedules
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_cash_receipt_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.aave_usde_cash_schedule_confirmations'::regclass AND tgname = 'aave_usde_cash_schedule_confirmations_append_only') THEN
    CREATE TRIGGER aave_usde_cash_schedule_confirmations_append_only
      BEFORE UPDATE OR DELETE ON public.aave_usde_cash_schedule_confirmations
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_cash_receipt_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.aave_usde_cash_issue_run_confirmations'::regclass AND tgname = 'aave_usde_cash_issue_run_confirmations_append_only') THEN
    CREATE TRIGGER aave_usde_cash_issue_run_confirmations_append_only
      BEFORE UPDATE OR DELETE ON public.aave_usde_cash_issue_run_confirmations
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_cash_receipt_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.aave_usde_cash_score_attempts'::regclass AND tgname = 'aave_usde_cash_score_attempts_append_only') THEN
    CREATE TRIGGER aave_usde_cash_score_attempts_append_only
      BEFORE UPDATE OR DELETE ON public.aave_usde_cash_score_attempts
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_cash_receipt_mutation();
  END IF;
END $$`

// Preserve the observed source rows named by future issue receipts. The
// legacy hourly recorder only INSERTs snapshots; corrections require an
// explicit migration and must not silently rewrite already-issued evidence.
await sql`CREATE OR REPLACE FUNCTION public.reject_aave_usde_observed_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.venue = 'aave-v3-usde' AND OLD.source = 'observed') OR
       (NEW.venue = 'aave-v3-usde' AND NEW.source = 'observed') THEN
      RAISE EXCEPTION 'prospective USDe source snapshots are append-only';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.venue = 'aave-v3-usde' AND OLD.source = 'observed' THEN
    RAISE EXCEPTION 'prospective USDe source snapshots are append-only';
  END IF;
  RETURN OLD;
END;
$$`
await sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.venue_snapshots'::regclass AND tgname = 'aave_usde_observed_snapshot_append_only') THEN
    CREATE TRIGGER aave_usde_observed_snapshot_append_only
      BEFORE UPDATE OR DELETE ON public.venue_snapshots
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_observed_snapshot_mutation();
  END IF;
END $$`
// An observed row is a local first-seen reading, not a historical backfill.
// Reject new USDe observations whose caller supplied timestamps predate the
// database clock. Backfilled history must carry source='backfilled'.
await sql`CREATE OR REPLACE FUNCTION public.check_aave_usde_observed_snapshot_time()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NEW.venue = 'aave-v3-usde' AND NEW.source = 'observed' AND (
    NEW.observed_at < v_now - interval '60 seconds' OR
    NEW.created_at < v_now - interval '60 seconds' OR
    NEW.observed_at > v_now + interval '5 seconds' OR
    NEW.created_at > v_now + interval '5 seconds'
  ) THEN
    RAISE EXCEPTION 'USDe observed snapshot requires current database time';
  END IF;
  RETURN NEW;
END;
$$`
await sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.venue_snapshots'::regclass AND tgname = 'aave_usde_observed_snapshot_time') THEN
    CREATE TRIGGER aave_usde_observed_snapshot_time
      BEFORE INSERT ON public.venue_snapshots
      FOR EACH ROW EXECUTE FUNCTION public.check_aave_usde_observed_snapshot_time();
  END IF;
END $$`

// strat_watches — Carry Radar STRAT WATCHES. One row per tracked address with a
// point-in-time snapshot of its radar positions at watch time (entry baseline
// for the POST-EVENT RECAP). UPSERT on UNIQUE(address). Mirrors the drizzle
// definition in db/schema.ts (stratWatches) — keep them in lockstep.
await sql`CREATE TABLE IF NOT EXISTS strat_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  label text,
  entry_positions jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS strat_watches_address_idx ON strat_watches (address)`

// Cached CURRENT positions for the Carry Strats board (additive columns).
// scripts/refresh-strat-positions.mjs writes these in one batched chain-read pass
// so /api/strats serves stored values (no per-request live reads). Mirrors the
// stratWatches drizzle definition — keep them in lockstep.
await sql`ALTER TABLE strat_watches ADD COLUMN IF NOT EXISTS last_scanned jsonb`
await sql`ALTER TABLE strat_watches ADD COLUMN IF NOT EXISTS last_scanned_at timestamptz`

// Watch-epoch-scoped performance substrate. Re-watch changes created_at and
// starts fresh rows; prior append-only observations remain audit-able.
await sql`CREATE TABLE IF NOT EXISTS strat_return_cursors (
  address text NOT NULL,
  venue text NOT NULL,
  watch_epoch timestamptz NOT NULL,
  start_block bigint NOT NULL,
  last_complete_block bigint NOT NULL,
  start_at timestamptz NOT NULL,
  start_nav_usd numeric,
  last_error text
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS strat_return_cursors_key_idx ON strat_return_cursors (address, venue, watch_epoch)`
await sql`CREATE TABLE IF NOT EXISTS strat_return_flows (
  address text NOT NULL,
  venue text NOT NULL,
  watch_epoch timestamptz NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  from_address text NOT NULL,
  to_address text NOT NULL,
  shares_raw text NOT NULL,
  flow_usd numeric,
  pricing_status text NOT NULL
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS strat_return_flows_event_idx ON strat_return_flows (address, venue, watch_epoch, tx_hash, log_index)`
await sql`CREATE INDEX IF NOT EXISTS strat_return_flows_window_idx ON strat_return_flows (address, venue, watch_epoch, block)`
await sql`CREATE TABLE IF NOT EXISTS strat_return_snapshots (
  address text NOT NULL,
  venue text NOT NULL,
  watch_epoch timestamptz NOT NULL,
  block bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  nav_usd numeric,
  pnl_usd numeric,
  return_pct numeric,
  capital_base_usd numeric,
  flow_count integer NOT NULL DEFAULT 0,
  unpriced_count integer NOT NULL DEFAULT 0,
  status text NOT NULL
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS strat_return_snapshots_key_idx ON strat_return_snapshots (address, venue, watch_epoch, block)`
await sql`ALTER TABLE strat_return_snapshots ADD COLUMN IF NOT EXISTS capital_base_usd numeric`

// sim_reads — Position-simulator READ LOG (the launch instrument: "did the
// address come back?"). One row per pasted address; first_seen is kept on
// conflict, last_seen moves, read_count increments. Address only — no IP, no
// UA, no cookie. Written by pages/api/sim/reads.ts. Mirrors simReads in
// db/schema.ts — keep them in lockstep.
await sql`CREATE TABLE IF NOT EXISTS sim_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  protocols jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  read_count integer NOT NULL DEFAULT 1
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS sim_reads_address_idx ON sim_reads (address)`
await sql`CREATE INDEX IF NOT EXISTS sim_reads_last_seen_idx ON sim_reads (last_seen)`

// sim_history — Position-simulator LIQUIDATION-HISTORY CACHE (the SECONDARY PROOF:
// "how many liquidations would the delay infra have saved this wallet from"). One
// row per address holding the wallet's real Aave V3 LiquidationCall events already
// replayed against the 8h cure window / 4% break band, plus rolled-up totals and the
// method string. Rescanned when older than 24h; a FAILED scan is never written.
// Written by pages/api/sim/history/[address].ts. Mirrors simHistory in db/schema.ts
// — keep them in lockstep.
await sql`CREATE TABLE IF NOT EXISTS sim_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  to_block bigint,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS sim_history_address_idx ON sim_history (address)`
await sql`CREATE INDEX IF NOT EXISTS sim_history_scanned_at_idx ON sim_history (scanned_at)`

// venue_news — the VENUE NEWS feed. Raw external headlines per venue, fetched
// from Google News RSS by scripts/fetch-venue-news.mjs. INFORMATION not
// endorsement: title/source/url/dates stored VERBATIM, no summarization or
// sentiment. INSERT-ONLY; UNIQUE(venue, url) makes re-fetch idempotent
// (INSERT ... ON CONFLICT DO NOTHING). published_at nullable (article pubDate);
// fetched_at = when we pulled it. Mirrors venueNews in db/schema.ts.
await sql`CREATE TABLE IF NOT EXISTS venue_news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  title text NOT NULL,
  source text NOT NULL,
  url text NOT NULL,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_news_venue_url_idx ON venue_news (venue, url)`
await sql`CREATE INDEX IF NOT EXISTS venue_news_venue_published_idx ON venue_news (venue, published_at)`

// venue_alarms — the VENUE FAILURE-PATTERN ALARM. One row per fired condition,
// matched to a past-carry-failure genre (docs/research/worst-carry-venues.md).
// Written by scripts/check-venue-alarms.mjs from EXISTING corpus data only (no
// chain reads). An alarm is OPEN while cleared_at IS NULL; the checker CLEARS it
// (sets cleared_at) when the condition stops holding. severity is 'notice',
// 'watch', or 'alarm'; evidence records the observations that fired it. The
// Condition alarms dedupe while open by (venue,kind). Each terms-page notice
// instead binds one immutable venue_events.id, across its entire lifetime.
await sql`CREATE TABLE IF NOT EXISTS venue_alarms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL,
  evidence jsonb NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  notified boolean NOT NULL DEFAULT false,
  source_event_id uuid,
  delivery_claim_token uuid,
  delivery_claim_until timestamptz
)`
await sql`ALTER TABLE venue_alarms ADD COLUMN IF NOT EXISTS source_event_id uuid`
await sql`ALTER TABLE venue_alarms ADD COLUMN IF NOT EXISTS delivery_claim_token uuid`
await sql`ALTER TABLE venue_alarms ADD COLUMN IF NOT EXISTS delivery_claim_until timestamptz`
// Legacy rows have aggregate evidence without a reliable event id. Preserve
// them, including pending delivery, and record a fixed boundary: post-migration
// per-event notices start after this instant. Earlier unseen edits remain an
// explicit coverage gap rather than being silently mapped or double-notified.
await sql`CREATE TABLE IF NOT EXISTS venue_alarm_terms_migration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  boundary_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'legacy_aggregate_unmapped_pre_boundary'
)`
// Capture the boundary before index migration. A page edit observed while the
// DDL runs must remain eligible for the first event-keyed checker pass.
// Rollout still requires the old checker to be stopped before this point and
// the new checker to start only after this script completes.
await sql`INSERT INTO venue_alarm_terms_migration (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`
// Build the replacement first: concurrent checkers always have an enforcing
// index, including between these separate Neon HTTP statements and on rerun.
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_condition_open_unique_idx ON venue_alarms (venue, kind) WHERE cleared_at IS NULL AND kind <> 'terms_page_notice'`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_source_event_unique_idx ON venue_alarms (source_event_id) WHERE source_event_id IS NOT NULL`
await sql`DROP INDEX IF EXISTS venue_alarms_open_unique_idx`
await sql`CREATE INDEX IF NOT EXISTS venue_alarms_venue_fired_idx ON venue_alarms (venue, fired_at)`

// venue_terms — the TERMS-PAGE HASH WATCHER corpus. One row per OBSERVED hash of
// a venue's official redemption/terms page (scripts/watch-venue-terms.mjs).
// INSERT-ONLY and append-only: a new row is written ONLY when the normalized
// visible-text sha256 differs from the (venue, url)'s latest stored hash — so the
// table is a change log, not a per-tick dump. content_len is the normalized text
// length (a cheap corroborating signal alongside the hash). On a change (a prior
// hash existed and differs) the watcher ALSO inserts a venue_events row of kind
// 'terms_page_changed', which the separate terms_page_notice rule reports as a
// factual page-text notice; exit impact remains unclassified.
// First-ever observation of a (venue, url) is a BASELINE: it is stored but emits
// NO event. Applied by this manual DDL (IF NOT EXISTS); the drizzle mirror lives
// in db/schema.ts (venueTerms) — keep them in lockstep.
await sql`CREATE TABLE IF NOT EXISTS venue_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  url text NOT NULL,
  content_hash text NOT NULL,
  content_len integer NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE INDEX IF NOT EXISTS venue_terms_venue_url_fetched_idx ON venue_terms (venue, url, fetched_at)`

// ---------------------------------------------------------------- CORPUS
// aave_liquidations — the EVENT-LEVEL multi-year corpus behind the scale line
// ("4% sounds small. It would have kept $X of collateral over the last N
// years."). One row per Aave V3 mainnet LiquidationCall from the Pool's deploy
// block (16,291,127) to head, NO user filter, written by
// scripts/scan-aave-liquidations.mjs. Amounts are stored RAW (token base units,
// numeric because a uint256 does not fit a bigint) — never pre-priced, so a
// pricing change re-derives from the same rows instead of re-scanning 7.5M
// blocks. PRIMARY KEY (tx_hash, log_index) makes a resumed or overlapping
// chunk idempotent: the scanner re-runs a chunk after a crash and inserts
// ON CONFLICT DO NOTHING. "user" is quoted everywhere — it is a reserved word.
await sql`CREATE TABLE IF NOT EXISTS aave_liquidations (
  block bigint NOT NULL,
  block_time timestamptz NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  "user" text NOT NULL,
  collateral_asset text NOT NULL,
  debt_asset text NOT NULL,
  debt_to_cover numeric NOT NULL,
  liquidated_collateral_amount numeric NOT NULL,
  liquidator text NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
)`
await sql`CREATE INDEX IF NOT EXISTS aave_liquidations_user_block_idx ON aave_liquidations ("user", block, log_index)`
await sql`CREATE INDEX IF NOT EXISTS aave_liquidations_block_idx ON aave_liquidations (block)`
await sql`CREATE INDEX IF NOT EXISTS aave_liquidations_time_idx ON aave_liquidations (block_time)`

// aave_liquidation_episodes — one row per EPISODE (events within 24h of each
// other on one account are ONE episode: one crash, one position), each replayed
// through the 4%/8h window by lib/position-sim/history.ts replayEpisode — the
// same engine and the same Chainlink pricing the per-wallet scanner uses.
// unpriced = nothing in the episode could be priced; such a row is stored (so
// the count is printable) and excluded from every dollar figure.
await sql`CREATE TABLE IF NOT EXISTS aave_liquidation_episodes (
  "user" text NOT NULL,
  start_ts bigint NOT NULL,
  end_ts bigint NOT NULL,
  collateral text NOT NULL,
  actual_seized_usd numeric NOT NULL DEFAULT 0,
  actual_repaid_usd numeric NOT NULL DEFAULT 0,
  membrane_seized_usd numeric NOT NULL DEFAULT 0,
  membrane_liquidations integer NOT NULL DEFAULT 0,
  verdict text NOT NULL,
  unpriced boolean NOT NULL DEFAULT false,
  event_count integer NOT NULL DEFAULT 0,
  unpriced_events integer NOT NULL DEFAULT 0,
  why text,
  anchor_collateral_asset text,
  collateral_count integer NOT NULL DEFAULT 0,
  replayed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user", start_ts)
)`
// CREATE TABLE IF NOT EXISTS does not add columns to a live table. Keep every later
// episode field here too so applying this DDL upgrades both fresh and existing DBs.
await sql`ALTER TABLE aave_liquidation_episodes ADD COLUMN IF NOT EXISTS why text`
await sql`ALTER TABLE aave_liquidation_episodes ADD COLUMN IF NOT EXISTS anchor_collateral_asset text`
await sql`ALTER TABLE aave_liquidation_episodes ADD COLUMN IF NOT EXISTS collateral_count integer NOT NULL DEFAULT 0`
await sql`CREATE INDEX IF NOT EXISTS aave_liq_episodes_start_idx ON aave_liquidation_episodes (start_ts)`
await sql`CREATE INDEX IF NOT EXISTS aave_liq_episodes_verdict_idx ON aave_liquidation_episodes (verdict)`

// aave_scan_cursor — the resume points. 'logs' = the next block the log scan
// must read; 'logs_head' = the head block FROZEN at the first run so a resumed
// scan keeps one stable toBlock (and therefore one stable denominator);
// 'logs_done'/'episodes_done' = phase completion flags; 'episodes' = the last
// account (lexicographic) whose episodes are committed. A crash loses at most
// one chunk / one account.
await sql`CREATE TABLE IF NOT EXISTS aave_scan_cursor (
  name text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`

const [{ s }] = await sql`SELECT count(*)::int AS s FROM venue_snapshots`
const [{ e }] = await sql`SELECT count(*)::int AS e FROM venue_events`
const [{ p }] = await sql`SELECT count(*)::int AS p FROM venue_predictions`
const [{ f }] = await sql`SELECT count(*)::int AS f FROM venue_flows`
const [{ w }] = await sql`SELECT count(*)::int AS w FROM strat_watches`
const [{ n }] = await sql`SELECT count(*)::int AS n FROM venue_news`
const [{ a }] = await sql`SELECT count(*)::int AS a FROM venue_alarms`
const [{ t }] = await sql`SELECT count(*)::int AS t FROM venue_terms`
const [{ al }] = await sql`SELECT count(*)::int AS al FROM aave_liquidations`
const [{ ae }] = await sql`SELECT count(*)::int AS ae FROM aave_liquidation_episodes`
console.log(
  `venue recorder tables ready — snapshots: ${s}, events: ${e}, predictions: ${p}, flows: ${f}, watches: ${w}, news: ${n}, alarms: ${a}, terms: ${t}, aave_liquidations: ${al}, aave_liquidation_episodes: ${ae}`,
)
