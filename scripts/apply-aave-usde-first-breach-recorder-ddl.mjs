// Additive, dormant v2 recorder ledger. No live SQL runs without --apply and
// a dedicated migration credential. The running v1 recorder is unchanged.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

export const V2_RECORDER_DDL = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `DO $$ BEGIN
     IF to_regprocedure('public.digest(bytea,text)') IS NULL
       OR to_regprocedure('public.ingest_venue_snapshot_atomic_v1(text,text,bigint,numeric,numeric,numeric,jsonb,uuid)') IS NULL
       OR to_regclass('public.venue_snapshots') IS NULL
       OR to_regclass('public.venue_events') IS NULL THEN
       RAISE EXCEPTION 'v2 recorder requires public pgcrypto digest and atomic venue recorder';
     END IF;
   END; $$`,
  // Runs before aave_usde_observed_snapshot_time alphabetically. This keeps
  // both first-seen clocks equal without violating the USDe append-only UPDATE
  // guard; atomic v1 sets observed_at=clock_timestamp() but the column default
  // for created_at is now() at transaction start.
  `CREATE OR REPLACE FUNCTION public.set_aave_usde_v2_observed_created_at()
   RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
   BEGIN NEW.created_at:=NEW.observed_at; RETURN NEW; END; $$`,
  `CREATE TRIGGER aave_usde_00_v2_created_at
   BEFORE INSERT ON public.venue_snapshots FOR EACH ROW
   WHEN (NEW.venue='aave-v3-usde' AND NEW.source='observed'
     AND NEW.recorder_atomic_v1 IS TRUE)
   EXECUTE FUNCTION public.set_aave_usde_v2_observed_created_at()`,
  `CREATE TABLE public.aave_usde_v2_issue_schedules (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    payload text NOT NULL, planned_at timestamptz NOT NULL,
    start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
    persisted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    publisher_xid bigint NOT NULL,
    CHECK (planned_at < start_at AND end_at > start_at
      AND end_at <= start_at + interval '23 days 16 hours'),
    CONSTRAINT aave_usde_v2_schedule_no_overlap EXCLUDE USING gist
      (tstzrange(start_at,end_at,'[)') WITH &&)
  )`,
  `CREATE TABLE public.aave_usde_v2_schedule_confirmations (
    sha256 text PRIMARY KEY REFERENCES public.aave_usde_v2_issue_schedules(sha256),
    confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    confirmer_xid bigint NOT NULL
  )`,
  `CREATE TABLE public.aave_usde_v2_coverage_manifests (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    schedule_sha256 text NOT NULL REFERENCES public.aave_usde_v2_issue_schedules(sha256),
    payload text NOT NULL, declared_at timestamptz NOT NULL,
    start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
    persisted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    publisher_xid bigint NOT NULL,
    UNIQUE (sha256,schedule_sha256),
    CHECK (declared_at < start_at AND end_at > start_at
      AND end_at <= start_at + interval '31 days')
  )`,
  `CREATE TABLE public.aave_usde_v2_coverage_confirmations (
    sha256 text PRIMARY KEY REFERENCES public.aave_usde_v2_coverage_manifests(sha256),
    confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    confirmer_xid bigint NOT NULL
  )`,
  `CREATE TABLE public.aave_usde_v2_coverage_slots (
    manifest_sha256 text NOT NULL REFERENCES public.aave_usde_v2_coverage_manifests(sha256),
    slot_id text NOT NULL, slot_at timestamptz NOT NULL,
    PRIMARY KEY (manifest_sha256,slot_id), UNIQUE (manifest_sha256,slot_at),
    CHECK (slot_id ~ '^aave-v3-usde:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00[.]000Z$')
  )`,
  `CREATE TABLE public.aave_usde_v2_recorder_starts (
    manifest_sha256 text NOT NULL, slot_id text PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    starter_xid bigint NOT NULL,
    FOREIGN KEY (manifest_sha256,slot_id)
      REFERENCES public.aave_usde_v2_coverage_slots(manifest_sha256,slot_id)
  )`,
  `CREATE TABLE public.aave_usde_v2_recorder_terminals (
    slot_id text PRIMARY KEY,
    status text NOT NULL CHECK (status IN
      ('success','skipped_fresh','skipped_unchanged','read_failure','insert_failure','missed')),
    reason text, snapshot_id uuid UNIQUE REFERENCES public.venue_snapshots(id),
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    terminal_xid bigint NOT NULL,
    FOREIGN KEY (slot_id)
      REFERENCES public.aave_usde_v2_recorder_starts(slot_id),
    CHECK ((status='success' AND snapshot_id IS NOT NULL AND reason IS NULL)
      OR (status<>'success' AND snapshot_id IS NULL AND reason IS NOT NULL AND length(reason)>0)),
    CHECK (status<>'success' OR completed_at IS NOT NULL)
  )`,
  // No writer gets direct DML; these triggers also protect against accidental
  // owner-side UPDATE/DELETE. TRUNCATE is excluded by ACL, not row triggers.
  `CREATE OR REPLACE FUNCTION public.reject_aave_usde_v2_ledger_mutation()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN RAISE EXCEPTION 'v2 ledger is append only'; END; $$`,
  ...[
    'aave_usde_v2_issue_schedules',
    'aave_usde_v2_schedule_confirmations',
    'aave_usde_v2_coverage_manifests',
    'aave_usde_v2_coverage_confirmations',
    'aave_usde_v2_coverage_slots',
    'aave_usde_v2_recorder_starts',
    'aave_usde_v2_recorder_terminals',
  ].map(
    (table) => `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON public.${table}
    FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_v2_ledger_mutation()`,
  ),
]

export const V2_RECORDER_FUNCTIONS = [
  `CREATE OR REPLACE FUNCTION public.publish_aave_usde_v2_issue_schedule(p_text text)
   RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE j jsonb; v_start timestamptz; v_end timestamptz; v_plan timestamptz;
     v_now timestamptz := clock_timestamp(); v_sha text; v_count integer;
     v_slots text := ''; v_slot text; v_at text; v_close text; v_expected text;
     v_study constant text := 'aave-v3-usde-first-sampled-cash-breach-by-h-v2';
     v_arms constant text := '[{"amountUsd":1000000,"horizonSeconds":28800},{"amountUsd":1000000,"horizonSeconds":86400},{"amountUsd":1000000,"horizonSeconds":604800},{"amountUsd":10000000,"horizonSeconds":28800},{"amountUsd":10000000,"horizonSeconds":86400},{"amountUsd":10000000,"horizonSeconds":604800},{"amountUsd":50000000,"horizonSeconds":28800},{"amountUsd":50000000,"horizonSeconds":86400},{"amountUsd":50000000,"horizonSeconds":604800}]';
   BEGIN
     j := p_text::jsonb;
     IF j->>'schema' IS DISTINCT FROM 'aave-usde-first-breach-issue-schedule-v1'
       OR j->>'study' IS DISTINCT FROM v_study OR (j->>'cadenceSeconds')::integer <> 3600
       OR j->'amountsUsd' IS DISTINCT FROM '[1000000,10000000,50000000]'::jsonb
       OR j->'horizonsSeconds' IS DISTINCT FROM '[28800,86400,604800]'::jsonb THEN
       RAISE EXCEPTION 'invalid v2 issue schedule'; END IF;
     v_plan := (j->>'plannedAt')::timestamptz;
     v_start := (j->>'startAt')::timestamptz;
     v_end := (j->>'endExclusiveAt')::timestamptz;
     v_count := extract(epoch FROM v_end-v_start)::integer/3600;
     IF v_plan IS NULL OR v_start IS NULL OR v_end IS NULL OR v_plan > v_now
       OR v_now >= v_start OR v_plan >= v_start OR v_count NOT BETWEEN 1 AND 568
       OR j->>'plannedAt' IS DISTINCT FROM to_char(v_plan AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR j->>'startAt' IS DISTINCT FROM to_char(v_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR j->>'endExclusiveAt' IS DISTINCT FROM to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR v_end <> v_start + v_count*interval '1 hour'
       OR extract(epoch FROM v_start)::bigint % 3600 <> 0
       OR extract(epoch FROM v_end)::bigint % 3600 <> 0 THEN
       RAISE EXCEPTION 'invalid v2 schedule time'; END IF;
     FOR i IN 0..v_count-1 LOOP
       v_at := to_char((v_start+i*interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
       v_close := to_char((v_start+(i+1)*interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
       v_slot := encode(public.digest(convert_to(format('{"study":"%s","plannedAt":"%s","startAt":"%s","endExclusiveAt":"%s","scheduledAt":"%s","closesAt":"%s"}',
         v_study,j->>'plannedAt',j->>'startAt',j->>'endExclusiveAt',v_at,v_close),'UTF8'),'sha256'),'hex');
       IF i>0 THEN v_slots := v_slots || ','; END IF;
       v_slots := v_slots || format('{"slotId":"%s","scheduledAt":"%s","closesAt":"%s","arms":%s}',v_slot,v_at,v_close,v_arms);
     END LOOP;
     v_expected := format('{"schema":"aave-usde-first-breach-issue-schedule-v1","study":"%s","plannedAt":"%s","startAt":"%s","endExclusiveAt":"%s","cadenceSeconds":3600,"amountsUsd":[1000000,10000000,50000000],"horizonsSeconds":[28800,86400,604800],"slots":[%s]}',
       v_study,j->>'plannedAt',j->>'startAt',j->>'endExclusiveAt',v_slots);
     IF p_text IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'noncanonical schedule bytes'; END IF;
     v_sha := encode(public.digest(convert_to(p_text,'UTF8'),'sha256'),'hex');
     INSERT INTO public.aave_usde_v2_issue_schedules
       (sha256,payload,planned_at,start_at,end_at,persisted_at,publisher_xid)
       VALUES (v_sha,p_text,v_plan,v_start,v_end,v_now,txid_current());
     RETURN v_sha;
   END; $$`,
  `CREATE OR REPLACE FUNCTION public.confirm_aave_usde_v2_issue_schedule(p_sha text)
   RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE s public.aave_usde_v2_issue_schedules%ROWTYPE; v_now timestamptz := clock_timestamp();
   BEGIN
     SELECT * INTO s FROM public.aave_usde_v2_issue_schedules WHERE sha256=p_sha;
     IF NOT FOUND OR s.publisher_xid=txid_current() OR v_now<=s.persisted_at
       OR v_now>=s.start_at THEN RAISE EXCEPTION 'schedule not separately confirmed before start'; END IF;
     INSERT INTO public.aave_usde_v2_schedule_confirmations(sha256,confirmed_at,confirmer_xid)
       VALUES(p_sha,v_now,txid_current());
     RETURN v_now;
   END; $$`,
  `CREATE OR REPLACE FUNCTION public.publish_aave_usde_v2_coverage_manifest(p_text text)
   RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE j jsonb; s public.aave_usde_v2_issue_schedules%ROWTYPE;
     v_start timestamptz; v_end timestamptz; v_declared timestamptz;
     v_now timestamptz := clock_timestamp(); v_sha text; v_count integer;
     v_slots text := ''; v_at text; v_expected text;
   BEGIN
     j := p_text::jsonb;
     IF j->>'study' IS DISTINCT FROM 'aave-usde-first-breach-hourly-coverage-v1'
       OR j->>'venue' IS DISTINCT FROM 'aave-v3-usde' THEN
       RAISE EXCEPTION 'invalid coverage identity'; END IF;
     SELECT * INTO s FROM public.aave_usde_v2_issue_schedules
       WHERE sha256=j->>'issueSchedulePhysicalSha256';
     IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.aave_usde_v2_schedule_confirmations c
         WHERE c.sha256=s.sha256 AND c.confirmer_xid<>txid_current()) THEN
       RAISE EXCEPTION 'unconfirmed issue schedule'; END IF;
     v_declared := (j->>'declaredAt')::timestamptz;
     v_start := (j->>'startAt')::timestamptz;
     v_end := (j->>'endExclusiveAt')::timestamptz;
     v_count := extract(epoch FROM v_end-v_start)::integer/3600;
     IF v_declared IS NULL OR v_start IS NULL OR v_end IS NULL
       OR v_declared>v_now OR v_now>=v_start OR v_declared>=v_start
       OR v_count NOT BETWEEN 1 AND 744 OR v_end<>v_start+v_count*interval '1 hour'
       OR j->>'declaredAt' IS DISTINCT FROM to_char(v_declared AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR j->>'startAt' IS DISTINCT FROM to_char(v_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR j->>'endExclusiveAt' IS DISTINCT FROM to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR v_start>s.start_at OR v_end<s.end_at+interval '7 days 8 hours'
       OR extract(epoch FROM v_start)::bigint % 3600 <> 0
       OR extract(epoch FROM v_end)::bigint % 3600 <> 0 THEN
       RAISE EXCEPTION 'invalid coverage window'; END IF;
     FOR i IN 0..v_count-1 LOOP
       v_at := to_char((v_start+i*interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
       IF i>0 THEN v_slots:=v_slots||','; END IF;
       v_slots:=v_slots||format('{"id":"aave-v3-usde:%s","at":"%s"}',v_at,v_at);
     END LOOP;
     v_expected:=format('{"study":"aave-usde-first-breach-hourly-coverage-v1","venue":"aave-v3-usde","startAt":"%s","endExclusiveAt":"%s","declaredAt":"%s","issueSchedulePhysicalSha256":"%s","slots":[%s]}',
       j->>'startAt',j->>'endExclusiveAt',j->>'declaredAt',s.sha256,v_slots);
     IF p_text IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'noncanonical coverage bytes'; END IF;
     v_sha:=encode(public.digest(convert_to(p_text,'UTF8'),'sha256'),'hex');
     INSERT INTO public.aave_usde_v2_coverage_manifests
       (sha256,schedule_sha256,payload,declared_at,start_at,end_at,persisted_at,publisher_xid)
       VALUES(v_sha,s.sha256,p_text,v_declared,v_start,v_end,v_now,txid_current());
     FOR i IN 0..v_count-1 LOOP
       v_at:=to_char((v_start+i*interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
       INSERT INTO public.aave_usde_v2_coverage_slots(manifest_sha256,slot_id,slot_at)
         VALUES(v_sha,'aave-v3-usde:'||v_at,v_start+i*interval '1 hour');
     END LOOP;
     RETURN v_sha;
   END; $$`,
  `CREATE OR REPLACE FUNCTION public.confirm_aave_usde_v2_coverage_manifest(p_sha text)
   RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE m public.aave_usde_v2_coverage_manifests%ROWTYPE; v_now timestamptz:=clock_timestamp();
   BEGIN
     SELECT * INTO m FROM public.aave_usde_v2_coverage_manifests WHERE sha256=p_sha;
     IF NOT FOUND OR m.publisher_xid=txid_current() OR v_now<=m.persisted_at
       OR v_now>=m.start_at THEN RAISE EXCEPTION 'coverage not separately confirmed before start'; END IF;
     INSERT INTO public.aave_usde_v2_coverage_confirmations(sha256,confirmed_at,confirmer_xid)
       VALUES(p_sha,v_now,txid_current());
     RETURN v_now;
   END; $$`,
  `CREATE OR REPLACE FUNCTION public.start_aave_usde_v2_recorder(p_manifest text,p_slot text)
   RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE v_at timestamptz; v_now timestamptz:=clock_timestamp();
   BEGIN
     SELECT slot_at INTO v_at FROM public.aave_usde_v2_coverage_slots
       WHERE manifest_sha256=p_manifest AND slot_id=p_slot;
     IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.aave_usde_v2_coverage_confirmations c
       WHERE c.sha256=p_manifest AND c.confirmer_xid<>txid_current())
       OR v_now<v_at OR v_now>=v_at+interval '1 hour' THEN
       RAISE EXCEPTION 'unconfirmed or closed recorder slot'; END IF;
     INSERT INTO public.aave_usde_v2_recorder_starts
       (manifest_sha256,slot_id,started_at,starter_xid)
       VALUES(p_manifest,p_slot,v_now,txid_current());
     RETURN v_now;
   END; $$`,
  `CREATE OR REPLACE FUNCTION public.aave_usde_v2_atomic_predecessor()
   RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
     SELECT s.id FROM public.venue_snapshots s
       WHERE s.venue='aave-v3-usde' AND s.chain='ethereum'
         AND s.source='observed' AND s.recorder_atomic_v1 IS TRUE
       ORDER BY s.block DESC LIMIT 1
   $$`,
  `CREATE OR REPLACE FUNCTION public.finish_aave_usde_v2_recorder(
     p_manifest text,p_slot text,p_status text,p_reason text)
   RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE st public.aave_usde_v2_recorder_starts%ROWTYPE; v_at timestamptz;
     v_now timestamptz:=clock_timestamp();
   BEGIN
     SELECT * INTO st FROM public.aave_usde_v2_recorder_starts WHERE slot_id=p_slot;
     SELECT slot_at INTO v_at FROM public.aave_usde_v2_coverage_slots
       WHERE manifest_sha256=p_manifest AND slot_id=p_slot;
     IF NOT FOUND OR st.slot_id IS NULL OR st.manifest_sha256 IS DISTINCT FROM p_manifest
       OR st.starter_xid=txid_current() OR v_now<=st.started_at
       OR p_status NOT IN ('skipped_fresh','skipped_unchanged','read_failure','insert_failure','missed')
       OR p_reason IS NULL OR length(p_reason)=0 THEN
       RAISE EXCEPTION 'invalid recorder terminal'; END IF;
     INSERT INTO public.aave_usde_v2_recorder_terminals
       (slot_id,status,reason,completed_at,terminal_xid)
       VALUES(p_slot,p_status,p_reason,v_now,txid_current());
     RETURN v_now;
   END; $$`,
  // This function itself is one PostgreSQL statement/transaction. The atomic
  // ingest function must return inserted; every other status becomes a hard
  // failure and rolls back all writes. Start was committed in a prior XID.
  `CREATE OR REPLACE FUNCTION public.ingest_aave_usde_v2_recorder_success(
     p_manifest text,p_slot text,p_block bigint,p_instant numeric,p_cooling numeric,
     p_stranded numeric,p_params jsonb,p_predecessor uuid)
   RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE st public.aave_usde_v2_recorder_starts%ROWTYPE; v_at timestamptz;
     v_now timestamptz:=clock_timestamp(); v_result jsonb; v_id uuid;
   BEGIN
     SELECT * INTO st FROM public.aave_usde_v2_recorder_starts WHERE slot_id=p_slot;
     SELECT slot_at INTO v_at FROM public.aave_usde_v2_coverage_slots
       WHERE manifest_sha256=p_manifest AND slot_id=p_slot;
     IF NOT FOUND OR st.slot_id IS NULL OR st.manifest_sha256 IS DISTINCT FROM p_manifest
       OR st.starter_xid=txid_current() OR v_now<=st.started_at
       OR v_now<v_at OR v_now>=v_at+interval '1 hour'
       OR EXISTS(SELECT 1 FROM public.aave_usde_v2_recorder_terminals t
         WHERE t.slot_id=p_slot) THEN
       RAISE EXCEPTION 'invalid success attempt'; END IF;
     v_result:=public.ingest_venue_snapshot_atomic_v1('aave-v3-usde','ethereum',p_block,
       p_instant,p_cooling,p_stranded,p_params,p_predecessor);
     IF v_result->>'status' IS DISTINCT FROM 'inserted'
       OR COALESCE(v_result->>'snapshot_id','')='' THEN
       RAISE EXCEPTION 'atomic snapshot was not inserted: %',v_result->>'status'; END IF;
     v_id:=(v_result->>'snapshot_id')::uuid;
     IF NOT EXISTS(SELECT 1 FROM public.venue_snapshots s WHERE s.id=v_id
       AND s.venue='aave-v3-usde' AND s.source='observed'
       AND s.recorder_atomic_v1 IS TRUE AND s.observed_at>=v_at
       AND s.observed_at<v_at+interval '1 hour') THEN
       RAISE EXCEPTION 'inserted snapshot identity/time mismatch'; END IF;
     INSERT INTO public.aave_usde_v2_recorder_terminals
       (slot_id,status,snapshot_id,completed_at,terminal_xid)
       VALUES(p_slot,'success',v_id,clock_timestamp(),txid_current());
     RETURN v_id;
   END; $$`,
]

export const V2_RECORDER_ACL = [
  ...[
    'aave_usde_v2_issue_schedules',
    'aave_usde_v2_schedule_confirmations',
    'aave_usde_v2_coverage_manifests',
    'aave_usde_v2_coverage_confirmations',
    'aave_usde_v2_coverage_slots',
    'aave_usde_v2_recorder_starts',
    'aave_usde_v2_recorder_terminals',
  ].map((table) => `REVOKE ALL ON TABLE public.${table} FROM PUBLIC`),
  `REVOKE ALL ON FUNCTION public.reject_aave_usde_v2_ledger_mutation() FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.set_aave_usde_v2_observed_created_at() FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_v2_issue_schedule(text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.confirm_aave_usde_v2_issue_schedule(text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.publish_aave_usde_v2_coverage_manifest(text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.confirm_aave_usde_v2_coverage_manifest(text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.start_aave_usde_v2_recorder(text,text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.aave_usde_v2_atomic_predecessor() FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.finish_aave_usde_v2_recorder(text,text,text,text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.ingest_aave_usde_v2_recorder_success(text,text,bigint,numeric,numeric,numeric,jsonb,uuid) FROM PUBLIC`,
]

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply')
    throw new Error('Usage: apply-aave-usde-first-breach-recorder-ddl.mjs --apply')
  const url = process.env.AAVE_USDE_V2_RECORDER_MIGRATION_DATABASE_URL
  if (!url) throw new Error('Dedicated migration database URL required')
  const sql = neon(url)
  await sql.transaction(
    [...V2_RECORDER_DDL, ...V2_RECORDER_FUNCTIONS, ...V2_RECORDER_ACL].map((s) => sql.query(s)),
  )
  console.log('Aave USDe v2 recorder ledger installed; runtime grants and cutover remain separate')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
