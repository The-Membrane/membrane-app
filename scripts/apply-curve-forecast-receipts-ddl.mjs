// Explicit, one-shot DDL. This file never runs from the recorder or the API.
// node scripts/apply-curve-forecast-receipts-ddl.mjs --apply
// Requires a dedicated migration credential. Provision distinct publisher and
// API read roles, and grant only the minimum privileges separately before use.
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

if (process.argv.slice(2).join(' ') !== '--apply')
  throw new Error('Usage: apply-curve-forecast-receipts-ddl.mjs --apply')

const url =
  process.env.FORECAST_MIGRATION_DATABASE_URL || readEnv().get('FORECAST_MIGRATION_DATABASE_URL')
if (!url) throw new Error('FORECAST_MIGRATION_DATABASE_URL is required')
const sql = neon(url)

// PostgreSQL DDL is transactional. Keep table, index, trigger replacement and
// publisher function in one Neon HTTP transaction so an interrupted migration
// cannot leave the append-only trigger absent.
await sql.transaction([
  sql`CREATE TABLE IF NOT EXISTS public.curve_forecast_receipts (
  receipt_key text PRIMARY KEY,
  study text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('point_issue', 'point_score', 'duration_issue', 'duration_score')),
  status text NOT NULL,
  horizon_hours integer NOT NULL CHECK (horizon_hours > 0),
  source_block bigint NOT NULL,
  source_block_hash text NOT NULL,
  source_block_at timestamptz NOT NULL,
  capture_start_at timestamptz NOT NULL,
  capture_end_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  source_checkpoint_sha256 text NOT NULL,
  source_checkpoint_physical_sha256 text NOT NULL,
  artifact_sha256 text NOT NULL,
  artifact_physical_sha256 text NOT NULL,
  payload jsonb NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_block_hash ~ '^0x[0-9a-f]{64}$'),
  CHECK (source_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (source_checkpoint_physical_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (artifact_physical_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (capture_start_at <= capture_end_at AND capture_end_at <= issued_at)
)`,
  sql`CREATE INDEX IF NOT EXISTS curve_forecast_receipts_source_idx
  ON public.curve_forecast_receipts (kind, source_block DESC, horizon_hours)`,

  sql`CREATE OR REPLACE FUNCTION public.reject_curve_forecast_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'curve_forecast_receipts is append-only'; END; $$`,
  sql`DROP TRIGGER IF EXISTS curve_forecast_receipts_immutable ON public.curve_forecast_receipts`,
  sql`CREATE TRIGGER curve_forecast_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.curve_forecast_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_curve_forecast_receipt_mutation()`,

  // One PostgreSQL statement per receipt: insert-only, exact equality on conflict,
  // and an exception if the same identity ever resolves to different content.
  sql`CREATE OR REPLACE FUNCTION public.publish_curve_forecast_receipt(p jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  existing_row public.curve_forecast_receipts%ROWTYPE;
  inserted boolean := false;
BEGIN
  INSERT INTO public.curve_forecast_receipts (
    receipt_key, study, kind, status, horizon_hours, source_block,
    source_block_hash, source_block_at, capture_start_at, capture_end_at,
    issued_at, source_checkpoint_sha256, source_checkpoint_physical_sha256,
    artifact_sha256, artifact_physical_sha256, payload
  ) VALUES (
    p->>'receiptKey', p->>'study', p->>'kind', p->>'status', (p->>'horizonHours')::integer,
    (p->>'sourceBlock')::bigint, p->>'sourceBlockHash', (p->>'sourceBlockAt')::timestamptz,
    (p->>'captureStartAt')::timestamptz, (p->>'captureEndAt')::timestamptz,
    (p->>'issuedAt')::timestamptz, p->>'sourceCheckpointSha256',
    p->>'sourceCheckpointPhysicalSha256', p->>'artifactSha256',
    p->>'artifactPhysicalSha256', p->'payload'
  ) ON CONFLICT (receipt_key) DO NOTHING RETURNING true INTO inserted;
  IF inserted THEN RETURN true; END IF;

  SELECT * INTO existing_row FROM public.curve_forecast_receipts WHERE receipt_key = p->>'receiptKey';
  IF NOT FOUND OR existing_row.study IS DISTINCT FROM p->>'study'
    OR existing_row.kind IS DISTINCT FROM p->>'kind'
    OR existing_row.status IS DISTINCT FROM p->>'status'
    OR existing_row.horizon_hours IS DISTINCT FROM (p->>'horizonHours')::integer
    OR existing_row.source_block IS DISTINCT FROM (p->>'sourceBlock')::bigint
    OR existing_row.source_block_hash IS DISTINCT FROM p->>'sourceBlockHash'
    OR existing_row.source_block_at IS DISTINCT FROM (p->>'sourceBlockAt')::timestamptz
    OR existing_row.capture_start_at IS DISTINCT FROM (p->>'captureStartAt')::timestamptz
    OR existing_row.capture_end_at IS DISTINCT FROM (p->>'captureEndAt')::timestamptz
    OR existing_row.issued_at IS DISTINCT FROM (p->>'issuedAt')::timestamptz
    OR existing_row.source_checkpoint_sha256 IS DISTINCT FROM p->>'sourceCheckpointSha256'
    OR existing_row.source_checkpoint_physical_sha256 IS DISTINCT FROM p->>'sourceCheckpointPhysicalSha256'
    OR existing_row.artifact_sha256 IS DISTINCT FROM p->>'artifactSha256'
    OR existing_row.artifact_physical_sha256 IS DISTINCT FROM p->>'artifactPhysicalSha256'
    OR existing_row.payload IS DISTINCT FROM p->'payload'
  THEN RAISE EXCEPTION 'Conflicting curve forecast receipt: %', p->>'receiptKey'; END IF;
  RETURN false;
END; $$`,
  // No implicit PostgreSQL PUBLIC function EXECUTE. A separately provisioned
  // publisher role needs an explicit EXECUTE grant; an API role needs only
  // SELECT on the table. This migration intentionally creates neither role.
  sql`REVOKE ALL ON FUNCTION public.publish_curve_forecast_receipt(jsonb) FROM PUBLIC`,
])

console.log('curve_forecast_receipts: DDL applied')
