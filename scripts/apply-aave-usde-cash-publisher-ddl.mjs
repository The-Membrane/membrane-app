// One-shot, atomic security boundary for the research-only Aave USDe cash ledger.
// CASH_PUBLISHER_MIGRATION_DATABASE_URL=... node scripts/apply-aave-usde-cash-publisher-ddl.mjs --apply
// CASH_PUBLISHER_DATABASE_URL=... node scripts/apply-aave-usde-cash-publisher-ddl.mjs --audit-publisher
// Apply the base tables/triggers in apply-venue-recorder-ddl.mjs first. Use a
// distinct non-owner publisher role at runtime. Grant it USAGE on public and
// EXECUTE on all ten functions explicitly, outside this migration. It also
// needs SELECT on venue_snapshots and the six cash tables. Never grant direct
// DML on those tables or CREATE on the schema/database to that role.
// The migration intentionally creates no role and grants no privilege.
//
// A server function bounds pre-insert clock freshness, not transaction COMMIT
// time: a stalled outer transaction can commit later. Publication still needs
// operational commit-lag monitoring. These functions verify receipt seals and
// metadata, but cannot independently recompute the entire chain source set or
// prove that a privileged publisher's model calculation was honest.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

const issueSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_issue(
  p jsonb, p_payload_text text, p_unsigned_text text
) RETURNS TABLE (receipt_id uuid, inserted boolean, persisted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_body jsonb;
  v_unsigned jsonb;
  v_sha text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_anchor uuid;
  v_amount numeric;
  v_horizon integer;
  v_issued timestamptz;
  v_target timestamptz;
  v_prior public.aave_usde_cash_issues%ROWTYPE;
BEGIN
  IF p IS NULL OR p_payload_text IS NULL OR p_unsigned_text IS NULL THEN
    RAISE EXCEPTION 'issue receipt inputs required';
  END IF;
  v_body := p_payload_text::jsonb;
  v_unsigned := p_unsigned_text::jsonb;
  v_sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(p_unsigned_text, 'UTF8'), 'sha256'), 'hex');
  IF jsonb_typeof(v_body) <> 'object' OR jsonb_typeof(v_unsigned) <> 'object'
     OR v_unsigned <> (v_body - 'sha256')
     OR v_body->>'sha256' IS DISTINCT FROM v_sha
     OR p->>'payloadSha256' IS DISTINCT FROM v_sha
     OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'issue payload seal mismatch';
  END IF;
  v_anchor := (p->>'anchorId')::uuid;
  v_amount := (p->>'amountUsd')::numeric;
  v_horizon := (p->>'horizonSeconds')::integer;
  v_issued := (p->>'issuedAt')::timestamptz;
  v_target := (p->>'targetAt')::timestamptz;
  IF NOT p ?& ARRAY['study','anchorId','amountUsd','horizonSeconds','issuedAt','targetAt',
                    'payloadSha256','sourceRowIds','sourceRowSetSha256']
     OR NOT v_body ?& ARRAY['study','status','anchor','amountUsd','horizonSeconds',
                            'issuedAt','targetAt','sha256']
     OR v_anchor IS NULL OR v_amount IS NULL OR v_horizon IS NULL
     OR v_issued IS NULL OR v_target IS NULL
     OR p->>'study' IS DISTINCT FROM 'aave-v3-usde-prospective-sampled-cash-v1'
     OR v_body->>'study' IS DISTINCT FROM p->>'study'
     OR v_body->>'status' IS DISTINCT FROM 'issued'
     OR (v_body->'anchor'->>'id')::uuid IS DISTINCT FROM v_anchor
     OR (v_body->>'amountUsd')::numeric IS DISTINCT FROM v_amount
     OR (v_body->>'horizonSeconds')::integer IS DISTINCT FROM v_horizon
     OR (v_body->>'issuedAt')::timestamptz IS DISTINCT FROM v_issued
     OR (v_body->>'targetAt')::timestamptz IS DISTINCT FROM v_target
     OR v_amount NOT IN (1000000, 10000000, 50000000)
     OR v_horizon NOT IN (28800, 86400, 604800)
     OR v_target IS DISTINCT FROM v_issued + pg_catalog.make_interval(secs => v_horizon)
     OR coalesce(p->>'sourceRowSetSha256', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(jsonb_typeof(p->'sourceRowIds'), '') <> 'array'
     OR jsonb_array_length(p->'sourceRowIds') = 0
     OR NOT EXISTS (
       SELECT 1 FROM public.venue_snapshots s
       WHERE s.id = v_anchor AND s.venue = 'aave-v3-usde'
         AND s.source = 'observed' AND s.observed_at <= v_issued
         AND s.created_at <= v_issued
     ) THEN
    RAISE EXCEPTION 'issue metadata or server clock invalid';
  END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_issues i
    WHERE i.study = p->>'study' AND i.anchor_id = v_anchor
      AND i.amount_usd = v_amount AND i.horizon_seconds = v_horizon;
  IF FOUND THEN
    IF (v_prior.payload::jsonb)->>'sha256' IS DISTINCT FROM v_prior.payload_sha256
       OR (v_prior.payload::jsonb)->>'study' IS DISTINCT FROM v_prior.study
       OR ((v_prior.payload::jsonb)->'anchor'->>'id')::uuid IS DISTINCT FROM v_prior.anchor_id
       OR ((v_prior.payload::jsonb)->>'amountUsd')::numeric IS DISTINCT FROM v_prior.amount_usd
       OR ((v_prior.payload::jsonb)->>'horizonSeconds')::integer IS DISTINCT FROM v_prior.horizon_seconds
       OR ((v_prior.payload::jsonb)->>'issuedAt')::timestamptz IS DISTINCT FROM v_prior.issued_at
       OR ((v_prior.payload::jsonb)->>'targetAt')::timestamptz IS DISTINCT FROM v_prior.target_at
       OR v_prior.target_at IS DISTINCT FROM v_prior.issued_at + pg_catalog.make_interval(secs => v_prior.horizon_seconds)
       OR v_prior.persisted_at >= v_prior.target_at THEN
      RAISE EXCEPTION 'corrupt prior USDe cash issue receipt';
    END IF;
    receipt_id := v_prior.id;
    inserted := false;
    persisted_at := v_prior.persisted_at;
    RETURN NEXT; RETURN;
  END IF;
  IF v_issued > v_now OR v_now > v_issued + interval '60 seconds' OR v_now >= v_target THEN
    RAISE EXCEPTION 'issue server clock freshness invalid';
  END IF;
  INSERT INTO public.aave_usde_cash_issues (
    study, anchor_id, amount_usd, horizon_seconds, issued_at,
    persisted_at, target_at, payload, payload_sha256,
    source_row_ids, source_row_set_sha256, publisher_xid
  ) VALUES (
    p->>'study', v_anchor, v_amount, v_horizon, v_issued,
    v_now, v_target, p_payload_text, v_sha,
    p->'sourceRowIds', p->>'sourceRowSetSha256', pg_catalog.txid_current()
  ) ON CONFLICT (study, anchor_id, amount_usd, horizon_seconds) DO NOTHING
    RETURNING id, true, public.aave_usde_cash_issues.persisted_at
      INTO receipt_id, inserted, persisted_at;
  IF inserted THEN RETURN NEXT; RETURN; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_issues i
    WHERE i.study = p->>'study' AND i.anchor_id = v_anchor
      AND i.amount_usd = v_amount AND i.horizon_seconds = v_horizon;
  IF NOT FOUND OR (v_prior.payload::jsonb)->>'sha256' IS DISTINCT FROM v_prior.payload_sha256
     OR (v_prior.payload::jsonb)->>'study' IS DISTINCT FROM v_prior.study
     OR ((v_prior.payload::jsonb)->'anchor'->>'id')::uuid IS DISTINCT FROM v_prior.anchor_id
     OR ((v_prior.payload::jsonb)->>'amountUsd')::numeric IS DISTINCT FROM v_prior.amount_usd
     OR ((v_prior.payload::jsonb)->>'horizonSeconds')::integer IS DISTINCT FROM v_prior.horizon_seconds
     OR ((v_prior.payload::jsonb)->>'issuedAt')::timestamptz IS DISTINCT FROM v_prior.issued_at
     OR ((v_prior.payload::jsonb)->>'targetAt')::timestamptz IS DISTINCT FROM v_prior.target_at
     OR v_prior.target_at IS DISTINCT FROM v_prior.issued_at + pg_catalog.make_interval(secs => v_prior.horizon_seconds)
     OR v_prior.persisted_at >= v_prior.target_at THEN
    RAISE EXCEPTION 'corrupt prior USDe cash issue receipt';
  END IF;
  receipt_id := v_prior.id;
  inserted := false;
  persisted_at := v_prior.persisted_at;
  RETURN NEXT;
END; $$`

const scoreSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_score(
  p jsonb, p_payload_text text, p_unsigned_text text
) RETURNS TABLE (receipt_id uuid, inserted boolean, persisted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_body jsonb;
  v_unsigned jsonb;
  v_sha text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_issue_id uuid;
  v_scored timestamptz;
  v_issue public.aave_usde_cash_issues%ROWTYPE;
  v_prior public.aave_usde_cash_scores%ROWTYPE;
BEGIN
  IF p IS NULL OR p_payload_text IS NULL OR p_unsigned_text IS NULL THEN
    RAISE EXCEPTION 'score receipt inputs required';
  END IF;
  v_body := p_payload_text::jsonb;
  v_unsigned := p_unsigned_text::jsonb;
  v_sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(p_unsigned_text, 'UTF8'), 'sha256'), 'hex');
  IF jsonb_typeof(v_body) <> 'object' OR jsonb_typeof(v_unsigned) <> 'object'
     OR v_unsigned <> (v_body - 'sha256')
     OR v_body->>'sha256' IS DISTINCT FROM v_sha
     OR p->>'payloadSha256' IS DISTINCT FROM v_sha
     OR v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'score payload seal mismatch';
  END IF;
  v_issue_id := (p->>'issueId')::uuid;
  v_scored := (p->>'scoredAt')::timestamptz;
  SELECT * INTO v_issue FROM public.aave_usde_cash_issues i WHERE i.id = v_issue_id;
  IF NOT p ?& ARRAY['issueId','scoredAt','payloadSha256','sourceRowIds','sourceRowSetSha256']
     OR NOT v_body ?& ARRAY['study','issueSha256','scoredAt','status','sha256']
     OR v_issue_id IS NULL OR v_scored IS NULL
     OR NOT FOUND OR v_issue.study IS DISTINCT FROM 'aave-v3-usde-prospective-sampled-cash-v1'
     OR v_body->>'study' IS DISTINCT FROM v_issue.study
     OR v_body->>'issueSha256' IS DISTINCT FROM v_issue.payload_sha256
     OR coalesce(v_body->>'status', '') NOT IN ('observed', 'censored')
     OR (v_body->>'scoredAt')::timestamptz IS DISTINCT FROM v_scored
     OR v_scored < v_issue.target_at
     OR v_issue.persisted_at >= v_issue.target_at
     OR coalesce(p->>'sourceRowSetSha256', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(jsonb_typeof(p->'sourceRowIds'), '') <> 'array' THEN
    RAISE EXCEPTION 'score metadata or server clock invalid';
  END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_scores s WHERE s.issue_id = v_issue_id;
  IF FOUND THEN
    IF (v_prior.payload::jsonb)->>'sha256' IS DISTINCT FROM v_prior.payload_sha256
       OR (v_prior.payload::jsonb)->>'issueSha256' IS DISTINCT FROM v_issue.payload_sha256
       OR ((v_prior.payload::jsonb)->>'scoredAt')::timestamptz IS DISTINCT FROM v_prior.scored_at
       OR v_prior.scored_at < v_issue.target_at THEN
      RAISE EXCEPTION 'corrupt prior USDe cash score receipt';
    END IF;
    receipt_id := v_prior.id;
    inserted := false;
    persisted_at := v_prior.persisted_at;
    RETURN NEXT; RETURN;
  END IF;
  IF v_scored > v_now OR v_now > v_scored + interval '60 seconds' THEN
    RAISE EXCEPTION 'score server clock freshness invalid';
  END IF;
  INSERT INTO public.aave_usde_cash_scores (
    issue_id, scored_at, persisted_at, payload, payload_sha256,
    source_row_ids, source_row_set_sha256
  ) VALUES (
    v_issue_id, v_scored, v_now, p_payload_text, v_sha,
    p->'sourceRowIds', p->>'sourceRowSetSha256'
  ) ON CONFLICT (issue_id) DO NOTHING
    RETURNING id, true, public.aave_usde_cash_scores.persisted_at
      INTO receipt_id, inserted, persisted_at;
  IF inserted THEN RETURN NEXT; RETURN; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_scores s WHERE s.issue_id = v_issue_id;
  IF NOT FOUND OR (v_prior.payload::jsonb)->>'sha256' IS DISTINCT FROM v_prior.payload_sha256
     OR (v_prior.payload::jsonb)->>'issueSha256' IS DISTINCT FROM v_issue.payload_sha256
     OR ((v_prior.payload::jsonb)->>'scoredAt')::timestamptz IS DISTINCT FROM v_prior.scored_at
     OR v_prior.scored_at < v_issue.target_at THEN
    RAISE EXCEPTION 'corrupt prior USDe cash score receipt';
  END IF;
  receipt_id := v_prior.id;
  inserted := false;
  persisted_at := v_prior.persisted_at;
  RETURN NEXT;
END; $$`

const startAttemptSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_issue_start(
  p_run_id uuid, p_amount_usd numeric, p_horizon_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_inserted boolean;
BEGIN
  IF p_run_id IS NULL OR p_amount_usd NOT IN (1000000, 10000000, 50000000)
     OR p_horizon_seconds NOT IN (28800, 86400, 604800) THEN
    RAISE EXCEPTION 'invalid issue run arm';
  END IF;
  INSERT INTO public.aave_usde_cash_issue_attempts
    (run_id, amount_usd, horizon_seconds, phase, status, recorded_at)
  VALUES (p_run_id, p_amount_usd, p_horizon_seconds, 'start', 'scheduled', pg_catalog.clock_timestamp())
  ON CONFLICT (run_id, amount_usd, horizon_seconds, phase) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN RETURN true; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.aave_usde_cash_issue_attempts a
    WHERE a.run_id=p_run_id AND a.amount_usd=p_amount_usd
      AND a.horizon_seconds=p_horizon_seconds AND a.phase='start' AND a.status='scheduled'
  ) THEN RAISE EXCEPTION 'conflicting issue start receipt'; END IF;
  RETURN false;
END; $$`

const resultAttemptSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_issue_result(
  p_run_id uuid, p_amount_usd numeric, p_horizon_seconds integer,
  p_status text, p_reason text, p_issue_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_inserted boolean;
DECLARE v_prior public.aave_usde_cash_issue_attempts%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_amount_usd NOT IN (1000000, 10000000, 50000000)
     OR p_horizon_seconds NOT IN (28800, 86400, 604800)
     OR p_status NOT IN ('issued','duplicate','abstained','failed')
     OR NOT (
       (p_status IN ('issued','duplicate') AND p_issue_id IS NOT NULL AND p_reason IS NULL)
       OR (p_status IN ('abstained','failed') AND p_issue_id IS NULL AND p_reason IS NOT NULL)
     ) OR NOT EXISTS (
       SELECT 1 FROM public.aave_usde_cash_issue_attempts a
       WHERE a.run_id=p_run_id AND a.amount_usd=p_amount_usd
         AND a.horizon_seconds=p_horizon_seconds AND a.phase='start' AND a.status='scheduled'
     ) OR (p_issue_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.aave_usde_cash_issues i
       WHERE i.id=p_issue_id AND i.amount_usd=p_amount_usd AND i.horizon_seconds=p_horizon_seconds
     )) THEN RAISE EXCEPTION 'invalid issue result arm'; END IF;
  INSERT INTO public.aave_usde_cash_issue_attempts
    (run_id, amount_usd, horizon_seconds, phase, status, reason, issue_id, recorded_at)
  VALUES (p_run_id, p_amount_usd, p_horizon_seconds, 'result', p_status, p_reason,
          p_issue_id, pg_catalog.clock_timestamp())
  ON CONFLICT (run_id, amount_usd, horizon_seconds, phase) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN RETURN true; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_issue_attempts a
    WHERE a.run_id=p_run_id AND a.amount_usd=p_amount_usd
      AND a.horizon_seconds=p_horizon_seconds AND a.phase='result';
  IF NOT FOUND OR v_prior.status IS DISTINCT FROM p_status
     OR v_prior.reason IS DISTINCT FROM p_reason
     OR v_prior.issue_id IS DISTINCT FROM p_issue_id THEN
    RAISE EXCEPTION 'conflicting issue result receipt';
  END IF;
  RETURN false;
END; $$`

const scoreAttemptSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_score_attempt(
  p_issue_id uuid, p_status text, p_reason text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_id bigint;
BEGIN
  IF p_issue_id IS NULL OR p_status NOT IN ('scored','already_scored','pending','failed')
     OR NOT ((p_status='failed' AND p_reason IS NOT NULL)
             OR (p_status<>'failed' AND p_reason IS NULL))
     OR NOT EXISTS (SELECT 1 FROM public.aave_usde_cash_issues i WHERE i.id=p_issue_id)
     OR (p_status IN ('scored','already_scored') AND NOT EXISTS (
       SELECT 1 FROM public.aave_usde_cash_scores s WHERE s.issue_id=p_issue_id
     )) THEN RAISE EXCEPTION 'invalid score attempt'; END IF;
  INSERT INTO public.aave_usde_cash_score_attempts (issue_id, status, reason, recorded_at)
  VALUES (p_issue_id, p_status, p_reason, pg_catalog.clock_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$`

const manifestSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_manifest(
  p_payload_text text, p_unsigned_text text
) RETURNS TABLE (manifest_sha256 text, inserted boolean, persisted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_body jsonb;
  v_unsigned jsonb;
  v_sha text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_planned timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_count integer;
  v_index integer;
  v_slot jsonb;
  v_scheduled timestamptz;
  v_close timestamptz;
  v_prior public.aave_usde_cash_schedules%ROWTYPE;
  v_arms jsonb := '[{"amountUsd":1000000,"horizonSeconds":28800},{"amountUsd":1000000,"horizonSeconds":86400},{"amountUsd":1000000,"horizonSeconds":604800},{"amountUsd":10000000,"horizonSeconds":28800},{"amountUsd":10000000,"horizonSeconds":86400},{"amountUsd":10000000,"horizonSeconds":604800},{"amountUsd":50000000,"horizonSeconds":28800},{"amountUsd":50000000,"horizonSeconds":86400},{"amountUsd":50000000,"horizonSeconds":604800}]'::jsonb;
BEGIN
  IF p_payload_text IS NULL OR p_unsigned_text IS NULL THEN
    RAISE EXCEPTION 'schedule payload required';
  END IF;
  v_body := p_payload_text::jsonb;
  v_unsigned := p_unsigned_text::jsonb;
  v_sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(p_unsigned_text, 'UTF8'), 'sha256'), 'hex');
  IF coalesce(jsonb_typeof(v_body), '') <> 'object'
     OR coalesce(jsonb_typeof(v_unsigned), '') <> 'object'
     OR v_unsigned <> (v_body - 'sha256')
     OR v_body->>'sha256' IS DISTINCT FROM v_sha
     OR v_body->>'schema' IS DISTINCT FROM 'aave-usde-cash-schedule-v1'
     OR v_body->>'study' IS DISTINCT FROM 'aave-v3-usde-prospective-sampled-cash-v1'
     OR (SELECT count(*) FROM jsonb_object_keys(v_body)) <> 10
     OR v_body->'amountsUsd' IS DISTINCT FROM '[1000000,10000000,50000000]'::jsonb
     OR v_body->'horizonsSeconds' IS DISTINCT FROM '[28800,86400,604800]'::jsonb
     OR coalesce(jsonb_typeof(v_body->'slots'), '') <> 'array'
     OR (v_body->>'cadenceSeconds')::integer IS DISTINCT FROM 3600 THEN
    RAISE EXCEPTION 'schedule seal or fixed grid invalid';
  END IF;
  v_planned := (v_body->>'plannedAt')::timestamptz;
  v_start := (v_body->>'startAt')::timestamptz;
  v_end := (v_body->>'endAt')::timestamptz;
  v_count := jsonb_array_length(v_body->'slots');
  IF v_planned IS NULL OR v_start IS NULL OR v_end IS NULL
     OR v_count < 1 OR v_count > 8760
     OR v_planned > v_now OR v_now > v_planned + interval '60 seconds'
     OR v_start < v_now + interval '2 hours'
     OR v_end <= v_start
     OR extract(epoch FROM (v_end - v_start)) <> v_count * 3600 THEN
    RAISE EXCEPTION 'schedule clock or slot count invalid';
  END IF;
  FOR v_index IN 0..v_count-1 LOOP
    v_slot := v_body->'slots'->v_index;
    v_scheduled := v_start + v_index * interval '1 hour';
    v_close := v_scheduled + interval '1 hour';
    IF coalesce(jsonb_typeof(v_slot), '') <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_slot)) <> 4
       OR v_slot->>'scheduledAt' IS DISTINCT FROM pg_catalog.to_char(v_scheduled AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR v_slot->>'closesAt' IS DISTINCT FROM pg_catalog.to_char(v_close AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR v_slot->'arms' IS DISTINCT FROM v_arms
       OR v_slot->>'slotId' IS DISTINCT FROM pg_catalog.encode(public.digest(
         pg_catalog.convert_to(pg_catalog.format(
           '{"study":"aave-v3-usde-prospective-sampled-cash-v1","scheduledAt":"%s","cadenceSeconds":3600}',
           v_slot->>'scheduledAt'
         ), 'UTF8'), 'sha256'
       ), 'hex') THEN
      RAISE EXCEPTION 'schedule slot or arm grid invalid';
    END IF;
  END LOOP;
  -- Serialize for a readable conflict; the table GiST exclusion constraint
  -- remains the overlap invariant under a stale SERIALIZABLE snapshot.
  PERFORM pg_catalog.pg_advisory_xact_lock(917641029::bigint);
  SELECT * INTO v_prior FROM public.aave_usde_cash_schedules s WHERE s.manifest_sha256=v_sha;
  IF FOUND THEN
    IF v_prior.payload IS DISTINCT FROM p_payload_text THEN
      RAISE EXCEPTION 'manifest SHA collision with different exact bytes';
    END IF;
    manifest_sha256 := v_prior.manifest_sha256;
    inserted := false;
    persisted_at := v_prior.persisted_at;
    RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.aave_usde_cash_schedules s
    WHERE s.start_at < v_end AND s.end_at > v_start
  ) THEN RAISE EXCEPTION 'overlapping USDe cash schedule'; END IF;
  -- v_now above predates the advisory wait. Recheck immediately before INSERT.
  v_now := pg_catalog.clock_timestamp();
  IF v_planned > v_now OR v_now > v_planned + interval '60 seconds'
     OR v_start < v_now + interval '2 hours' THEN
    RAISE EXCEPTION 'schedule clock expired before INSERT';
  END IF;
  INSERT INTO public.aave_usde_cash_schedules
    (manifest_sha256, payload, planned_at, start_at, end_at, cadence_seconds, persisted_at, publisher_xid)
  VALUES (v_sha, p_payload_text, v_planned, v_start, v_end, 3600, v_now, pg_catalog.txid_current())
  RETURNING public.aave_usde_cash_schedules.manifest_sha256, true,
            public.aave_usde_cash_schedules.persisted_at
    INTO manifest_sha256, inserted, persisted_at;
  RETURN NEXT;
END; $$`

const boundStartSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_issue_start(
  p_run_id uuid, p_amount_usd numeric, p_horizon_seconds integer,
  p_manifest_sha256 text, p_slot_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_manifest public.aave_usde_cash_schedules%ROWTYPE;
  v_slot jsonb;
  v_inserted boolean;
  v_prior public.aave_usde_cash_issue_attempts%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_amount_usd NOT IN (1000000,10000000,50000000)
     OR p_horizon_seconds NOT IN (28800,86400,604800)
     OR p_manifest_sha256 IS NULL OR p_slot_id IS NULL THEN
    RAISE EXCEPTION 'invalid bound issue start';
  END IF;
  SELECT * INTO v_manifest FROM public.aave_usde_cash_schedules s
    WHERE s.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND OR v_manifest.persisted_at >= v_manifest.start_at OR NOT EXISTS (
    SELECT 1 FROM public.aave_usde_cash_schedule_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256 AND c.confirmed_at <= v_manifest.start_at - interval '2 hours'
      AND c.confirmer_xid <> v_manifest.publisher_xid
  ) THEN
    RAISE EXCEPTION 'bound issue manifest absent or late';
  END IF;
  SELECT e.value INTO v_slot FROM jsonb_array_elements(v_manifest.payload::jsonb->'slots') AS e(value)
    WHERE e.value->>'slotId'=p_slot_id;
  v_now := pg_catalog.clock_timestamp();
  IF v_slot IS NULL OR v_now < (v_slot->>'scheduledAt')::timestamptz
     OR v_now >= (v_slot->>'closesAt')::timestamptz THEN
    RAISE EXCEPTION 'bound issue start outside slot';
  END IF;
  INSERT INTO public.aave_usde_cash_issue_attempts
    (run_id, amount_usd, horizon_seconds, phase, status, manifest_sha256, slot_id, recorded_at, publisher_xid)
  VALUES (p_run_id,p_amount_usd,p_horizon_seconds,'start','scheduled',p_manifest_sha256,p_slot_id,v_now,pg_catalog.txid_current())
  ON CONFLICT (run_id,amount_usd,horizon_seconds,phase) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN RETURN true; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_issue_attempts a
    WHERE a.run_id=p_run_id AND a.amount_usd=p_amount_usd
      AND a.horizon_seconds=p_horizon_seconds AND a.phase='start';
  IF NOT FOUND OR v_prior.status IS DISTINCT FROM 'scheduled'
     OR v_prior.manifest_sha256 IS DISTINCT FROM p_manifest_sha256
     OR v_prior.slot_id IS DISTINCT FROM p_slot_id THEN
    RAISE EXCEPTION 'conflicting bound issue start';
  END IF;
  RETURN false;
END; $$`

const boundResultSql = `CREATE OR REPLACE FUNCTION public.publish_aave_usde_cash_issue_result(
  p_run_id uuid, p_amount_usd numeric, p_horizon_seconds integer,
  p_status text, p_reason text, p_issue_id uuid,
  p_manifest_sha256 text, p_slot_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_manifest public.aave_usde_cash_schedules%ROWTYPE;
  v_slot jsonb;
  v_inserted boolean;
  v_prior public.aave_usde_cash_issue_attempts%ROWTYPE;
  v_start_at timestamptz;
  v_issue_issued_at timestamptz;
  v_issue_at timestamptz;
  v_issue_xid bigint;
BEGIN
  IF p_run_id IS NULL OR p_amount_usd NOT IN (1000000,10000000,50000000)
     OR p_horizon_seconds NOT IN (28800,86400,604800)
     OR p_manifest_sha256 IS NULL OR p_slot_id IS NULL
     OR p_status NOT IN ('issued','duplicate','abstained','failed')
     OR NOT ((p_status IN ('issued','duplicate') AND p_issue_id IS NOT NULL AND p_reason IS NULL)
       OR (p_status IN ('abstained','failed') AND p_issue_id IS NULL AND p_reason IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid bound issue result';
  END IF;
  SELECT * INTO v_manifest FROM public.aave_usde_cash_schedules s
    WHERE s.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND OR v_manifest.persisted_at >= v_manifest.start_at OR NOT EXISTS (
    SELECT 1 FROM public.aave_usde_cash_schedule_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256 AND c.confirmed_at <= v_manifest.start_at - interval '2 hours'
      AND c.confirmer_xid <> v_manifest.publisher_xid
  ) THEN
    RAISE EXCEPTION 'bound issue manifest absent or late';
  END IF;
  SELECT e.value INTO v_slot FROM jsonb_array_elements(v_manifest.payload::jsonb->'slots') AS e(value)
    WHERE e.value->>'slotId'=p_slot_id;
  v_now := pg_catalog.clock_timestamp();
  IF v_slot IS NULL OR v_now < (v_slot->>'scheduledAt')::timestamptz
     OR v_now >= (v_slot->>'closesAt')::timestamptz THEN
    RAISE EXCEPTION 'bound issue result outside slot';
  END IF;
  SELECT a.recorded_at INTO v_start_at FROM public.aave_usde_cash_issue_attempts a
    WHERE a.run_id=p_run_id AND a.amount_usd=p_amount_usd
      AND a.horizon_seconds=p_horizon_seconds AND a.phase='start'
      AND a.status='scheduled' AND a.manifest_sha256=p_manifest_sha256 AND a.slot_id=p_slot_id;
  IF p_issue_id IS NOT NULL THEN
    SELECT i.issued_at, i.persisted_at, i.publisher_xid
      INTO v_issue_issued_at, v_issue_at, v_issue_xid FROM public.aave_usde_cash_issues i
    WHERE i.id=p_issue_id AND i.amount_usd=p_amount_usd AND i.horizon_seconds=p_horizon_seconds
      AND i.study='aave-v3-usde-prospective-sampled-cash-v1';
  END IF;
  v_now := pg_catalog.clock_timestamp();
  IF v_now < (v_slot->>'scheduledAt')::timestamptz
     OR v_now >= (v_slot->>'closesAt')::timestamptz
     OR v_start_at IS NULL OR (p_issue_id IS NOT NULL AND v_issue_at IS NULL)
     OR (p_status='issued' AND (
       v_issue_issued_at < v_start_at OR v_issue_at < v_start_at OR v_issue_at > v_now
       OR v_issue_xid IS DISTINCT FROM pg_catalog.txid_current()
     )) THEN
    RAISE EXCEPTION 'bound result lacks matching start or timely issued receipt';
  END IF;
  INSERT INTO public.aave_usde_cash_issue_attempts
    (run_id, amount_usd, horizon_seconds, phase, status, reason, issue_id,
     manifest_sha256, slot_id, recorded_at, publisher_xid)
  VALUES (p_run_id,p_amount_usd,p_horizon_seconds,'result',p_status,p_reason,p_issue_id,
          p_manifest_sha256,p_slot_id,v_now,pg_catalog.txid_current())
  ON CONFLICT (run_id,amount_usd,horizon_seconds,phase) DO NOTHING
  RETURNING true INTO v_inserted;
  IF v_inserted THEN RETURN true; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_issue_attempts a
    WHERE a.run_id=p_run_id AND a.amount_usd=p_amount_usd
      AND a.horizon_seconds=p_horizon_seconds AND a.phase='result';
  IF NOT FOUND OR v_prior.status IS DISTINCT FROM p_status
     OR v_prior.reason IS DISTINCT FROM p_reason
     OR v_prior.issue_id IS DISTINCT FROM p_issue_id
     OR v_prior.manifest_sha256 IS DISTINCT FROM p_manifest_sha256
     OR v_prior.slot_id IS DISTINCT FROM p_slot_id THEN
    RAISE EXCEPTION 'conflicting bound issue result';
  END IF;
  RETURN false;
END; $$`

const confirmManifestSql = `CREATE OR REPLACE FUNCTION public.confirm_aave_usde_cash_manifest(
  p_manifest_sha256 text
) RETURNS TABLE (manifest_sha256 text, confirmed_at timestamptz, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_manifest public.aave_usde_cash_schedules%ROWTYPE;
  v_prior public.aave_usde_cash_schedule_confirmations%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_xid bigint := pg_catalog.txid_current();
BEGIN
  SELECT * INTO v_manifest FROM public.aave_usde_cash_schedules s
    WHERE s.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND OR v_manifest.publisher_xid IS NULL OR v_manifest.publisher_xid=v_xid THEN
    RAISE EXCEPTION 'manifest must commit before confirmation transaction';
  END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_schedule_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256;
  IF FOUND THEN
    IF v_prior.confirmer_xid=v_manifest.publisher_xid
       OR v_prior.confirmed_at > v_manifest.start_at - interval '2 hours' THEN
      RAISE EXCEPTION 'invalid prior schedule confirmation';
    END IF;
    manifest_sha256 := v_prior.manifest_sha256;
    confirmed_at := v_prior.confirmed_at;
    inserted := false;
    RETURN NEXT; RETURN;
  END IF;
  v_now := pg_catalog.clock_timestamp();
  IF v_now > v_manifest.start_at - interval '2 hours'
     OR v_now < v_manifest.persisted_at THEN
    RAISE EXCEPTION 'manifest confirmation missed future lead';
  END IF;
  INSERT INTO public.aave_usde_cash_schedule_confirmations
    (manifest_sha256, confirmed_at, confirmer_xid)
  VALUES (p_manifest_sha256, v_now, v_xid)
  ON CONFLICT (manifest_sha256) DO NOTHING
  RETURNING public.aave_usde_cash_schedule_confirmations.manifest_sha256,
            public.aave_usde_cash_schedule_confirmations.confirmed_at, true
    INTO manifest_sha256, confirmed_at, inserted;
  IF inserted THEN RETURN NEXT; RETURN; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_schedule_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND OR v_prior.confirmer_xid=v_manifest.publisher_xid
     OR v_prior.confirmed_at > v_manifest.start_at - interval '2 hours' THEN
    RAISE EXCEPTION 'invalid concurrent schedule confirmation';
  END IF;
  manifest_sha256 := v_prior.manifest_sha256;
  confirmed_at := v_prior.confirmed_at;
  inserted := false;
  RETURN NEXT;
END; $$`

const confirmIssueRunSql = `CREATE OR REPLACE FUNCTION public.confirm_aave_usde_cash_issue_run(
  p_run_id uuid, p_manifest_sha256 text, p_slot_id text
) RETURNS TABLE (run_id uuid, confirmed_at timestamptz, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_xid bigint := pg_catalog.txid_current();
  v_result_xid bigint;
  v_latest_result timestamptz;
  v_count integer;
  v_start_count integer;
  v_result_count integer;
  v_prior public.aave_usde_cash_issue_run_confirmations%ROWTYPE;
BEGIN
  IF p_run_id IS NULL OR p_manifest_sha256 IS NULL OR p_slot_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.aave_usde_cash_schedule_confirmations c
       JOIN public.aave_usde_cash_schedules m ON m.manifest_sha256=c.manifest_sha256
       WHERE c.manifest_sha256=p_manifest_sha256 AND c.confirmer_xid<>m.publisher_xid
         AND c.confirmed_at <= m.start_at - interval '2 hours'
     ) THEN RAISE EXCEPTION 'confirmed manifest required for issue run'; END IF;
  SELECT count(*), count(*) FILTER (WHERE phase='start'),
         count(*) FILTER (WHERE phase='result'),
         max(recorded_at) FILTER (WHERE phase='result'),
         max(publisher_xid) FILTER (WHERE phase='result')
    INTO v_count, v_start_count, v_result_count, v_latest_result, v_result_xid
  FROM public.aave_usde_cash_issue_attempts a WHERE a.run_id=p_run_id
    AND a.manifest_sha256=p_manifest_sha256 AND a.slot_id=p_slot_id;
  IF v_count <> 18 OR v_start_count <> 9 OR v_result_count <> 9
     OR v_result_xid IS NULL OR v_result_xid=v_xid
     OR EXISTS (
       SELECT 1 FROM public.aave_usde_cash_issue_attempts a WHERE a.run_id=p_run_id
         AND (a.manifest_sha256 IS DISTINCT FROM p_manifest_sha256
              OR a.slot_id IS DISTINCT FROM p_slot_id)
     ) OR EXISTS (
       SELECT 1 FROM public.aave_usde_cash_issue_attempts a
       WHERE a.run_id=p_run_id AND a.phase='result'
         AND a.publisher_xid IS DISTINCT FROM v_result_xid
     ) THEN RAISE EXCEPTION 'issue run must be complete and committed before confirmation'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.aave_usde_cash_issue_attempts a
    JOIN public.aave_usde_cash_issues i ON i.id=a.issue_id
    JOIN public.aave_usde_cash_issue_attempts s
      ON s.run_id=a.run_id AND s.amount_usd=a.amount_usd
       AND s.horizon_seconds=a.horizon_seconds AND s.phase='start'
    WHERE a.run_id=p_run_id AND a.phase='result' AND a.status='issued'
      AND (i.publisher_xid IS DISTINCT FROM v_result_xid
           OR i.issued_at < s.recorded_at OR i.persisted_at < s.recorded_at
           OR i.persisted_at > a.recorded_at)
  ) THEN RAISE EXCEPTION 'issue run has uncommitted or late issued arm'; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_issue_run_confirmations c
    WHERE c.run_id=p_run_id;
  IF FOUND THEN
    IF v_prior.manifest_sha256 IS DISTINCT FROM p_manifest_sha256
       OR v_prior.slot_id IS DISTINCT FROM p_slot_id
       OR v_prior.result_xid IS DISTINCT FROM v_result_xid
       OR v_prior.confirmer_xid=v_result_xid THEN
      RAISE EXCEPTION 'conflicting prior issue run confirmation';
    END IF;
    run_id := v_prior.run_id;
    confirmed_at := v_prior.confirmed_at;
    inserted := false;
    RETURN NEXT; RETURN;
  END IF;
  v_now := pg_catalog.clock_timestamp();
  IF v_now < v_latest_result OR v_now > v_latest_result + interval '60 seconds'
     OR EXISTS (
       SELECT 1 FROM public.aave_usde_cash_issue_attempts a
       JOIN public.aave_usde_cash_issues i ON i.id=a.issue_id
       WHERE a.run_id=p_run_id AND a.phase='result' AND a.status='issued'
         AND i.target_at <= v_now
     ) THEN RAISE EXCEPTION 'issue run confirmation missed future target'; END IF;
  INSERT INTO public.aave_usde_cash_issue_run_confirmations
    (run_id,manifest_sha256,slot_id,confirmed_at,confirmer_xid,result_xid)
  VALUES (p_run_id,p_manifest_sha256,p_slot_id,v_now,v_xid,v_result_xid)
  ON CONFLICT (run_id) DO NOTHING
  RETURNING public.aave_usde_cash_issue_run_confirmations.run_id,
            public.aave_usde_cash_issue_run_confirmations.confirmed_at, true
    INTO run_id, confirmed_at, inserted;
  IF inserted THEN RETURN NEXT; RETURN; END IF;
  SELECT * INTO v_prior FROM public.aave_usde_cash_issue_run_confirmations c WHERE c.run_id=p_run_id;
  IF NOT FOUND OR v_prior.manifest_sha256 IS DISTINCT FROM p_manifest_sha256
     OR v_prior.slot_id IS DISTINCT FROM p_slot_id
     OR v_prior.result_xid IS DISTINCT FROM v_result_xid
     OR v_prior.confirmer_xid=v_result_xid THEN
    RAISE EXCEPTION 'conflicting concurrent issue run confirmation';
  END IF;
  run_id := v_prior.run_id;
  confirmed_at := v_prior.confirmed_at;
  inserted := false;
  RETURN NEXT;
END; $$`

const publisherFunctionSignatures = Object.freeze([
  'public.publish_aave_usde_cash_issue(jsonb,text,text)',
  'public.publish_aave_usde_cash_score(jsonb,text,text)',
  'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer)',
  'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid)',
  'public.publish_aave_usde_cash_score_attempt(uuid,text,text)',
  'public.publish_aave_usde_cash_manifest(text,text)',
  'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer,text,text)',
  'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid,text,text)',
  'public.confirm_aave_usde_cash_manifest(text)',
  'public.confirm_aave_usde_cash_issue_run(uuid,text,text)',
])

// Role names are deliberately restricted to unquoted identifiers. This value
// is an explicit expected grantee, never a request to create or grant a role.
export function publisherAclGuardSql(expectedRole, { requireInstalled = false } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(expectedRole ?? ''))
    throw new Error('CASH_PUBLISHER_ROLE must be a lowercase PostgreSQL role name')
  const signatures = publisherFunctionSignatures.map((s) => `'${s}'`).join(', ')
  return `DO $$
DECLARE v_count integer;
DECLARE v_expected oid := pg_catalog.to_regrole('${expectedRole}')::oid;
BEGIN
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'expected USDe publisher role is not provisioned';
  END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM pg_catalog.unnest(ARRAY[${signatures}]) AS x(signature)
    WHERE pg_catalog.to_regprocedure(x.signature) IS NOT NULL;
  IF ${requireInstalled ? 'v_count <> 10' : 'v_count NOT IN (0, 5, 8, 10)'} THEN
    RAISE EXCEPTION 'incomplete USDe publisher function installation';
  END IF;
  ${
    requireInstalled
      ? ''
      : `IF v_count IN (0,5,8) AND (
    EXISTS (SELECT 1 FROM public.aave_usde_cash_schedule_confirmations)
    OR EXISTS (SELECT 1 FROM public.aave_usde_cash_issue_run_confirmations)
  ) THEN RAISE EXCEPTION 'confirmation publisher first install requires empty confirmation tables'; END IF;
  IF v_count IN (0,5) AND EXISTS (SELECT 1 FROM public.aave_usde_cash_schedules)
    THEN RAISE EXCEPTION 'schedule publisher first install requires empty manifest table'; END IF;
  IF v_count = 0 AND (
    EXISTS (SELECT 1 FROM public.aave_usde_cash_issues)
    OR EXISTS (SELECT 1 FROM public.aave_usde_cash_scores)
    OR EXISTS (SELECT 1 FROM public.aave_usde_cash_issue_attempts)
    OR EXISTS (SELECT 1 FROM public.aave_usde_cash_score_attempts)
  ) THEN RAISE EXCEPTION 'cash publisher first install requires empty receipt tables'; END IF;`
  }
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
    WHERE p.oid IN (
      SELECT pg_catalog.to_regprocedure(x.signature)
      FROM pg_catalog.unnest(ARRAY[${signatures}]) AS x(signature)
    ) AND a.privilege_type = 'EXECUTE'
      AND a.grantee <> p.proowner
      AND (a.grantee = 0 OR v_expected IS NULL OR a.grantee <> v_expected)
  ) THEN RAISE EXCEPTION 'unexpected USDe publisher function EXECUTE grant'; END IF;
END $$`
}

export const CASH_PUBLISHER_MIGRATION_SQL = Object.freeze([
  `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
       WHERE e.extname='pgcrypto' AND n.nspname='public'
     ) THEN RAISE EXCEPTION 'pgcrypto must be installed in public schema'; END IF;
   END $$`,
  issueSql,
  scoreSql,
  startAttemptSql,
  resultAttemptSql,
  scoreAttemptSql,
  manifestSql,
  boundStartSql,
  boundResultSql,
  confirmManifestSql,
  confirmIssueRunSql,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_issue(jsonb, text, text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_score(jsonb, text, text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_issue_start(uuid, numeric, integer) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_issue_result(uuid, numeric, integer, text, text, uuid) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_score_attempt(uuid, text, text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_manifest(text, text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_issue_start(uuid, numeric, integer, text, text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_cash_issue_result(uuid, numeric, integer, text, text, uuid, text, text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.confirm_aave_usde_cash_manifest(text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.confirm_aave_usde_cash_issue_run(uuid, text, text) FROM PUBLIC`,
])

export const CASH_PUBLISHER_AUDIT_SQL = `WITH role_state AS (
  SELECT r.oid AS role_oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
), protected_tables AS (
  SELECT x.rel::regclass AS rel FROM pg_catalog.unnest(ARRAY[
    'public.aave_usde_cash_issues'::regclass,
    'public.aave_usde_cash_scores'::regclass,
    'public.aave_usde_cash_issue_attempts'::regclass,
    'public.aave_usde_cash_score_attempts'::regclass,
    'public.aave_usde_cash_schedules'::regclass,
    'public.aave_usde_cash_schedule_confirmations'::regclass,
    'public.aave_usde_cash_issue_run_confirmations'::regclass,
    'public.venue_snapshots'::regclass
  ]) AS x(rel)
)
SELECT current_user AS role_name,
  session_user = current_user AS direct_login_role,
  (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
   FROM role_state) AS ordinary_role,
  NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
    AND NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS no_create,
  pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
  (SELECT pg_catalog.bool_and(
    NOT pg_catalog.has_table_privilege(current_user, rel, 'INSERT')
    AND NOT pg_catalog.has_any_column_privilege(current_user, rel, 'INSERT')
    AND NOT pg_catalog.has_table_privilege(current_user, rel, 'UPDATE')
    AND NOT pg_catalog.has_any_column_privilege(current_user, rel, 'UPDATE')
    AND NOT pg_catalog.has_table_privilege(current_user, rel, 'DELETE')
    AND NOT pg_catalog.has_table_privilege(current_user, rel, 'TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(current_user, rel, 'REFERENCES')
    AND NOT pg_catalog.has_any_column_privilege(current_user, rel, 'REFERENCES')
    AND NOT pg_catalog.has_table_privilege(current_user, rel, 'TRIGGER')
  ) FROM protected_tables) AS no_direct_protected_write,
  (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(current_user, rel, 'SELECT'))
   FROM protected_tables) AS can_read_evidence,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER'))
   FROM pg_catalog.pg_class c WHERE c.oid IN (SELECT rel FROM protected_tables)) AS not_table_owner_member,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER'))
   FROM pg_catalog.pg_proc p WHERE p.oid IN (
     'public.publish_aave_usde_cash_issue(jsonb,text,text)'::regprocedure,
     'public.publish_aave_usde_cash_score(jsonb,text,text)'::regprocedure,
     'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer)'::regprocedure,
     'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid)'::regprocedure,
     'public.publish_aave_usde_cash_score_attempt(uuid,text,text)'::regprocedure,
     'public.publish_aave_usde_cash_manifest(text,text)'::regprocedure,
     'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer,text,text)'::regprocedure,
     'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid,text,text)'::regprocedure,
     'public.confirm_aave_usde_cash_manifest(text)'::regprocedure,
     'public.confirm_aave_usde_cash_issue_run(uuid,text,text)'::regprocedure
   )) AS not_function_owner_member,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
    WHERE p.oid IN (
      'public.publish_aave_usde_cash_issue(jsonb,text,text)'::regprocedure,
      'public.publish_aave_usde_cash_score(jsonb,text,text)'::regprocedure,
      'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer)'::regprocedure,
      'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid)'::regprocedure,
      'public.publish_aave_usde_cash_score_attempt(uuid,text,text)'::regprocedure,
      'public.publish_aave_usde_cash_manifest(text,text)'::regprocedure,
      'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer,text,text)'::regprocedure,
      'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid,text,text)'::regprocedure,
      'public.confirm_aave_usde_cash_manifest(text)'::regprocedure,
      'public.confirm_aave_usde_cash_issue_run(uuid,text,text)'::regprocedure
    ) AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
      AND a.grantee <> (SELECT role_oid FROM role_state)
  ) AS exclusive_function_acl,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_issue(jsonb,text,text)', 'EXECUTE') AS can_issue,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_score(jsonb,text,text)', 'EXECUTE') AS can_score,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer)', 'EXECUTE') AS can_start,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid)', 'EXECUTE') AS can_finish,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_score_attempt(uuid,text,text)', 'EXECUTE') AS can_record_score_attempt,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_manifest(text,text)', 'EXECUTE') AS can_publish_manifest,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_issue_start(uuid,numeric,integer,text,text)', 'EXECUTE') AS can_start_bound,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_aave_usde_cash_issue_result(uuid,numeric,integer,text,text,uuid,text,text)', 'EXECUTE') AS can_finish_bound,
  pg_catalog.has_function_privilege(current_user,
    'public.confirm_aave_usde_cash_manifest(text)', 'EXECUTE') AS can_confirm_manifest,
  pg_catalog.has_function_privilege(current_user,
    'public.confirm_aave_usde_cash_issue_run(uuid,text,text)', 'EXECUTE') AS can_confirm_issue_run`

export function publisherAuditPass(row) {
  return Boolean(
    row &&
    row.direct_login_role === true &&
    row.ordinary_role === true &&
    row.no_create === true &&
    row.schema_usage === true &&
    row.no_direct_protected_write === true &&
    row.can_read_evidence === true &&
    row.not_table_owner_member === true &&
    row.not_function_owner_member === true &&
    row.exclusive_function_acl === true &&
    row.can_issue === true &&
    row.can_score === true &&
    row.can_start === true &&
    row.can_finish === true &&
    row.can_record_score_attempt === true &&
    row.can_publish_manifest === true &&
    row.can_start_bound === true &&
    row.can_finish_bound === true &&
    row.can_confirm_manifest === true &&
    row.can_confirm_issue_run === true,
  )
}

async function main() {
  const mode = process.argv[2]
  if (!['--apply', '--audit-publisher'].includes(mode) || process.argv.length !== 3)
    throw new Error('Usage: apply-aave-usde-cash-publisher-ddl.mjs --apply|--audit-publisher')
  const envName =
    mode === '--apply' ? 'CASH_PUBLISHER_MIGRATION_DATABASE_URL' : 'CASH_PUBLISHER_DATABASE_URL'
  const url = process.env[envName]
  if (!url) throw new Error(`${envName} is required`)
  const sql = neon(url)
  if (mode === '--apply') {
    const expectedRole = process.env.CASH_PUBLISHER_ROLE
    const preflight = publisherAclGuardSql(expectedRole)
    const postflight = publisherAclGuardSql(expectedRole, { requireInstalled: true })
    await sql.transaction([
      sql.query(preflight),
      ...CASH_PUBLISHER_MIGRATION_SQL.map((statement) => sql.query(statement)),
      sql.query(postflight),
    ])
    console.log(
      'USDe cash publisher functions applied; provision distinct role and explicit grants',
    )
    return
  }
  const rows = await sql.query(CASH_PUBLISHER_AUDIT_SQL)
  const row = rows[0]
  const passed = publisherAuditPass(row)
  console.log(
    JSON.stringify({
      role: row?.role_name ?? null,
      passed,
      checks: {
        ordinaryRole: row?.ordinary_role === true,
        directLoginRole: row?.direct_login_role === true,
        noCreate: row?.no_create === true,
        schemaUsage: row?.schema_usage === true,
        noDirectProtectedWrite: row?.no_direct_protected_write === true,
        canReadEvidence: row?.can_read_evidence === true,
        notTableOwnerMember: row?.not_table_owner_member === true,
        notFunctionOwnerMember: row?.not_function_owner_member === true,
        exclusiveFunctionAcl: row?.exclusive_function_acl === true,
        canIssue: row?.can_issue === true,
        canScore: row?.can_score === true,
        canStart: row?.can_start === true,
        canFinish: row?.can_finish === true,
        canRecordScoreAttempt: row?.can_record_score_attempt === true,
        canPublishManifest: row?.can_publish_manifest === true,
        canStartBound: row?.can_start_bound === true,
        canFinishBound: row?.can_finish_bound === true,
        canConfirmManifest: row?.can_confirm_manifest === true,
        canConfirmIssueRun: row?.can_confirm_issue_run === true,
      },
    }),
  )
  if (!passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never echo a connection URL, query text, or driver error (which can
    // contain credentials). Keep only a bounded failure class.
    console.error(
      error.message?.endsWith('is required') ? error.message : 'Publisher migration/audit failed',
    )
    process.exitCode = 1
  })
}
