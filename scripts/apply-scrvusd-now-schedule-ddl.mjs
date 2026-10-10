// First-install migration for the research-only scrvUSD NOW schedule.
// Requires a pre-provisioned, distinct SCRVUSD_SCHEDULE_PUBLISHER_ROLE.
// Creates no role or grant. Run only with a migration credential.
import { neon } from '@neondatabase/serverless'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FUNCTION_SIGNATURES = Object.freeze([
  'public.publish_scrvusd_now_manifest(text,text)',
  'public.confirm_scrvusd_now_manifest(text)',
  'public.witness_scrvusd_now_manifest(text)',
  'public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)',
  'public.confirm_scrvusd_now_starts(text,text)',
  'public.mark_scrvusd_now_capture_floor(text,text)',
  'public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)',
  'public.confirm_scrvusd_now_run(text,text)',
  'public.start_scrvusd_now_source(text,text,text)',
  'public.witness_scrvusd_now_run(text,text)',
  'public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text)',
  'public.witness_scrvusd_now_score(text,text,integer)',
])

export function schedulePreflightSql(role) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role ?? ''))
    throw new Error('SCRVUSD_SCHEDULE_PUBLISHER_ROLE must name an existing lowercase role')
  return `DO $$
BEGIN
  IF pg_catalog.to_regrole('${role}') IS NULL THEN
    RAISE EXCEPTION 'dedicated scrvUSD schedule role absent';
  END IF;
  IF pg_catalog.to_regrole('${role}')::oid =
     pg_catalog.to_regrole(current_user)::oid THEN
    RAISE EXCEPTION 'migration login must differ from scrvUSD publisher role';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members am
      WHERE am.roleid=pg_catalog.to_regrole('${role}')::oid) > 1
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid=pg_catalog.to_regrole('${role}')::oid
         AND (am.member<>pg_catalog.to_regrole(current_user)::oid
              OR NOT am.admin_option OR am.inherit_option OR am.set_option)
     ) THEN RAISE EXCEPTION 'scrvUSD publisher role has unsafe inbound members'; END IF;
  IF pg_catalog.to_regclass('public.scrvusd_now_manifests') IS NOT NULL
     OR pg_catalog.to_regclass('public.scrvusd_now_manifest_confirmations') IS NOT NULL
     OR pg_catalog.to_regclass('public.scrvusd_now_manifest_visibility') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.publish_scrvusd_now_manifest(text,text)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.confirm_scrvusd_now_manifest(text)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.witness_scrvusd_now_manifest(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'scrvUSD schedule boundary already installed; inspect before migration';
  END IF;
END $$`
}

const publishSql = `CREATE FUNCTION public.publish_scrvusd_now_manifest(
  p_payload_text text, p_unsigned_text text
) RETURNS TABLE (manifest_sha256 text, inserted boolean, persisted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_body jsonb;
  v_unsigned jsonb;
  v_sha text;
  v_now timestamptz;
  v_planned timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_count integer;
  v_index integer;
  v_slot jsonb;
  v_expected timestamptz;
  v_canonical_slots text := '';
  v_canonical_unsigned text;
BEGIN
  IF p_payload_text IS NULL OR p_unsigned_text IS NULL THEN
    RAISE EXCEPTION 'manifest payload required';
  END IF;
  v_body := p_payload_text::jsonb;
  v_unsigned := p_unsigned_text::jsonb;
  v_sha := pg_catalog.encode(public.digest(pg_catalog.convert_to(p_unsigned_text,'UTF8'),'sha256'),'hex');
  IF pg_catalog.jsonb_typeof(v_body) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_unsigned) IS DISTINCT FROM 'object'
     OR p_payload_text IS DISTINCT FROM
       pg_catalog.substr(p_unsigned_text,1,pg_catalog.length(p_unsigned_text)-1)
         || ',"sha256":"' || v_sha || '"}'
     OR v_unsigned IS DISTINCT FROM (v_body - 'sha256')
     OR v_body->>'sha256' IS DISTINCT FROM v_sha
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_body)) <> 11
     OR v_body->>'schema' IS DISTINCT FROM 'scrvusd-now-origin-expected-slots-v1'
     OR v_body->>'study' IS DISTINCT FROM 'scrvusd-now-origin-expected-slots-v1'
     OR v_body->'scope' IS DISTINCT FROM
       '{"holder":"0xcbe72c8dc34af0dc8e7a70df4c1da0ef23feca8e","qAssetsRaw":"1000000000000000000000","route":"direct_erc4626_withdraw_crvusd_from_scrvusd"}'::jsonb
     OR v_body->'horizonsSeconds' IS DISTINCT FROM '[3600,7200,86400,604800]'::jsonb
     OR (v_body->>'cadenceSeconds')::integer IS DISTINCT FROM 3600
     OR v_body->>'evidenceClass' IS DISTINCT FROM 'local_research_plan_only'
     OR pg_catalog.jsonb_typeof(v_body->'slots') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'manifest fixed scope or SHA invalid';
  END IF;
  v_planned := (v_body->>'plannedAtUtc')::timestamptz;
  v_start := (v_body->>'startAtUtc')::timestamptz;
  v_end := (v_body->>'endAtUtc')::timestamptz;
  v_count := pg_catalog.jsonb_array_length(v_body->'slots');
  v_now := pg_catalog.clock_timestamp();
  IF v_planned IS NULL OR v_start IS NULL OR v_end IS NULL
     OR v_planned > v_now OR v_now > v_planned + interval '60 seconds'
     OR v_start < v_now + interval '2 hours'
     OR v_end <= v_start OR v_end > v_start + interval '14 days'
     OR v_count < 1 OR v_count > 336
     OR v_body->>'plannedAtUtc' IS DISTINCT FROM
       pg_catalog.to_char(v_planned AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR v_body->>'startAtUtc' IS DISTINCT FROM
       pg_catalog.to_char(v_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR v_body->>'endAtUtc' IS DISTINCT FROM
       pg_catalog.to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR extract(epoch FROM v_start) % 3600 <> 0
     OR extract(epoch FROM v_end) % 3600 <> 0
     OR extract(epoch FROM (v_end-v_start)) <> v_count * 3600 THEN
    RAISE EXCEPTION 'manifest clock, horizon or slot count invalid';
  END IF;
  FOR v_index IN 0..v_count-1 LOOP
    v_slot := v_body->'slots'->v_index;
    v_expected := v_start + v_index * interval '1 hour';
    IF pg_catalog.jsonb_typeof(v_slot) IS DISTINCT FROM 'object'
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_slot)) <> 3
       OR v_slot->>'scheduledAtUtc' IS DISTINCT FROM
         pg_catalog.to_char(v_expected AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR v_slot->>'closesAtUtc' IS DISTINCT FROM
         pg_catalog.to_char((v_expected + interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       OR v_slot->>'slotId' IS DISTINCT FROM pg_catalog.encode(public.digest(
         pg_catalog.convert_to(pg_catalog.format(
           '{"study":"scrvusd-now-origin-expected-slots-v1","scheduledAtUtc":"%s"}',
           v_slot->>'scheduledAtUtc'
       ),'UTF8'),'sha256'),'hex') THEN
      RAISE EXCEPTION 'manifest slot invalid';
    END IF;
    v_canonical_slots := v_canonical_slots
      || CASE WHEN v_index = 0 THEN '' ELSE ',' END
      || pg_catalog.format(
        '{"slotId":"%s","scheduledAtUtc":"%s","closesAtUtc":"%s"}',
        v_slot->>'slotId',v_slot->>'scheduledAtUtc',v_slot->>'closesAtUtc'
      );
  END LOOP;
  v_canonical_unsigned := pg_catalog.format(
    '{"schema":"scrvusd-now-origin-expected-slots-v1",'
    || '"study":"scrvusd-now-origin-expected-slots-v1",'
    || '"scope":{"holder":"0xcbe72c8dc34af0dc8e7a70df4c1da0ef23feca8e",'
    || '"qAssetsRaw":"1000000000000000000000",'
    || '"route":"direct_erc4626_withdraw_crvusd_from_scrvusd"},'
    || '"plannedAtUtc":"%s","startAtUtc":"%s","endAtUtc":"%s",'
    || '"cadenceSeconds":3600,"horizonsSeconds":[3600,7200,86400,604800],'
    || '"slots":[%s],"evidenceClass":"local_research_plan_only"}',
    v_body->>'plannedAtUtc',v_body->>'startAtUtc',v_body->>'endAtUtc',
    v_canonical_slots
  );
  IF p_unsigned_text IS DISTINCT FROM v_canonical_unsigned THEN
    RAISE EXCEPTION 'manifest unsigned bytes are not canonical';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(584377201::bigint);
  -- Recheck after a possibly long advisory wait. Exclusion constraint below
  -- remains the invariant even under a stale SERIALIZABLE snapshot.
  v_now := pg_catalog.clock_timestamp();
  IF v_now > v_planned + interval '60 seconds'
     OR v_start < v_now + interval '2 hours' THEN
    RAISE EXCEPTION 'manifest publication window expired';
  END IF;
  IF EXISTS (SELECT 1 FROM public.scrvusd_now_manifests m WHERE m.manifest_sha256=v_sha)
     OR EXISTS (SELECT 1 FROM public.scrvusd_now_manifests m
                WHERE m.start_at < v_end AND m.end_at > v_start) THEN
    RAISE EXCEPTION 'duplicate or overlapping scrvUSD schedule';
  END IF;
  INSERT INTO public.scrvusd_now_manifests
    (manifest_sha256,payload,planned_at,start_at,end_at,persisted_at,publisher_xid)
  VALUES (v_sha,p_payload_text,v_planned,v_start,v_end,v_now,pg_catalog.txid_current())
  RETURNING public.scrvusd_now_manifests.manifest_sha256, true,
            public.scrvusd_now_manifests.persisted_at
       INTO manifest_sha256,inserted,persisted_at;
  RETURN NEXT;
END $$`

const confirmSql = `CREATE FUNCTION public.confirm_scrvusd_now_manifest(p_manifest_sha256 text)
RETURNS TABLE (manifest_sha256 text, confirmed_at timestamptz, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_manifest public.scrvusd_now_manifests%ROWTYPE;
  v_now timestamptz;
  v_xid bigint;
BEGIN
  IF p_manifest_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'manifest SHA invalid';
  END IF;
  SELECT * INTO v_manifest FROM public.scrvusd_now_manifests m
    WHERE m.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed manifest absent'; END IF;
  v_now := pg_catalog.clock_timestamp();
  v_xid := pg_catalog.txid_current();
  IF v_xid = v_manifest.publisher_xid OR v_now < v_manifest.persisted_at
     OR v_now > v_manifest.start_at - interval '2 hours' THEN
    RAISE EXCEPTION 'manifest post-commit confirmation late or same transaction';
  END IF;
  INSERT INTO public.scrvusd_now_manifest_confirmations
    (manifest_sha256,confirmed_at,confirmer_xid)
  VALUES (p_manifest_sha256,v_now,v_xid)
  ON CONFLICT (manifest_sha256) DO NOTHING
  RETURNING public.scrvusd_now_manifest_confirmations.manifest_sha256,
            public.scrvusd_now_manifest_confirmations.confirmed_at,true
    INTO manifest_sha256,confirmed_at,inserted;
  IF inserted THEN RETURN NEXT; RETURN; END IF;
  SELECT c.manifest_sha256,c.confirmed_at,false
    INTO manifest_sha256,confirmed_at,inserted
    FROM public.scrvusd_now_manifest_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'confirmation conflict'; END IF;
  RETURN NEXT;
END $$`

const witnessManifestSql = `CREATE FUNCTION public.witness_scrvusd_now_manifest(p_manifest_sha256 text)
RETURNS TABLE (manifest_visible_at timestamptz,witness_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_manifest public.scrvusd_now_manifests%ROWTYPE;
        v_confirm public.scrvusd_now_manifest_confirmations%ROWTYPE;
        v_prior public.scrvusd_now_manifest_visibility%ROWTYPE;
        v_now timestamptz; v_xid bigint;
BEGIN
  IF p_manifest_sha256 IS NULL OR p_manifest_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'manifest SHA invalid';
  END IF;
  SELECT * INTO v_manifest FROM public.scrvusd_now_manifests m
   WHERE m.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed manifest absent'; END IF;
  SELECT * INTO v_confirm FROM public.scrvusd_now_manifest_confirmations c
   WHERE c.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed manifest confirmation absent'; END IF;
  v_now := pg_catalog.clock_timestamp();
  v_xid := pg_catalog.txid_current();
  IF v_xid IN (v_manifest.publisher_xid,v_confirm.confirmer_xid)
     OR v_manifest.publisher_xid=v_confirm.confirmer_xid
     OR v_manifest.persisted_at>v_confirm.confirmed_at
     OR v_confirm.confirmed_at>v_now
     OR v_confirm.confirmed_at>v_manifest.start_at-interval '2 hours' THEN
    RAISE EXCEPTION 'manifest and confirmation must be committed before witness';
  END IF;
  SELECT * INTO v_prior FROM public.scrvusd_now_manifest_visibility w
   WHERE w.manifest_sha256=p_manifest_sha256;
  IF FOUND THEN
    IF v_prior.manifest_visible_at<v_confirm.confirmed_at
       OR v_prior.manifest_visible_at>v_manifest.start_at-interval '2 hours'
       OR v_prior.witness_xid IN (v_manifest.publisher_xid,v_confirm.confirmer_xid) THEN
      RAISE EXCEPTION 'conflicting manifest visibility witness';
    END IF;
    manifest_visible_at := v_prior.manifest_visible_at;
    witness_xid := v_prior.witness_xid;
    RETURN NEXT; RETURN;
  END IF;
  IF v_now>v_manifest.start_at-interval '2 hours' THEN
    RAISE EXCEPTION 'manifest visibility witness after lead deadline';
  END IF;
  INSERT INTO public.scrvusd_now_manifest_visibility
    (manifest_sha256,manifest_visible_at,witness_xid)
  VALUES (p_manifest_sha256,v_now,v_xid)
  RETURNING public.scrvusd_now_manifest_visibility.manifest_visible_at,
            public.scrvusd_now_manifest_visibility.witness_xid
    INTO manifest_visible_at,witness_xid;
  RETURN NEXT;
END $$`

export const SCRVUSD_SCHEDULE_MIGRATION_SQL = Object.freeze([
  'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public',
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e
                    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
                    WHERE e.extname='pgcrypto' AND n.nspname='public') THEN
       RAISE EXCEPTION 'pgcrypto must be installed in public';
     END IF;
   END $$`,
  `CREATE TABLE public.scrvusd_now_manifests (
     manifest_sha256 text PRIMARY KEY CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
     payload text NOT NULL, planned_at timestamptz NOT NULL,
     start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
     persisted_at timestamptz NOT NULL, publisher_xid bigint NOT NULL,
     CONSTRAINT scrvusd_now_manifest_window CHECK (end_at > start_at),
     CONSTRAINT scrvusd_now_manifest_no_overlap EXCLUDE USING gist
       (tstzrange(start_at,end_at,'[)') WITH &&)
   )`,
  `CREATE TABLE public.scrvusd_now_manifest_confirmations (
     manifest_sha256 text PRIMARY KEY REFERENCES public.scrvusd_now_manifests(manifest_sha256),
     confirmed_at timestamptz NOT NULL, confirmer_xid bigint NOT NULL
   )`,
  `CREATE TABLE public.scrvusd_now_manifest_visibility (
     manifest_sha256 text PRIMARY KEY REFERENCES public.scrvusd_now_manifest_confirmations(manifest_sha256),
     manifest_visible_at timestamptz NOT NULL,witness_xid bigint NOT NULL
   )`,
  publishSql,
  confirmSql,
  witnessManifestSql,
  'REVOKE ALL ON TABLE public.scrvusd_now_manifests FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_manifest_confirmations FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_manifest_visibility FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.publish_scrvusd_now_manifest(text,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.confirm_scrvusd_now_manifest(text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.witness_scrvusd_now_manifest(text) FROM PUBLIC',
])

// Additive second migration. The first-install manifest boundary may already
// hold live plans; never drop, recreate, or replace it to add attempt evidence.
export function scheduleAttemptPreflightSql(role) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role ?? ''))
    throw new Error('SCRVUSD_SCHEDULE_PUBLISHER_ROLE must name an existing lowercase role')
  return `DO $$ BEGIN
    IF pg_catalog.to_regrole('${role}') IS NULL
       OR pg_catalog.to_regrole('${role}')::oid=pg_catalog.to_regrole(current_user)::oid
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members am
           WHERE am.roleid=pg_catalog.to_regrole('${role}')::oid) > 1
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
                  WHERE am.roleid=pg_catalog.to_regrole('${role}')::oid
                    AND (am.member<>pg_catalog.to_regrole(current_user)::oid
                         OR NOT am.admin_option OR am.inherit_option OR am.set_option)) THEN
      RAISE EXCEPTION 'dedicated scrvUSD publisher role absent or unsafe';
    END IF;
    IF pg_catalog.to_regclass('public.scrvusd_now_manifests') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_manifest_confirmations') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_manifest_visibility') IS NULL
       OR pg_catalog.to_regprocedure('public.publish_scrvusd_now_manifest(text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.confirm_scrvusd_now_manifest(text)') IS NULL
       OR pg_catalog.to_regprocedure('public.witness_scrvusd_now_manifest(text)') IS NULL THEN
      RAISE EXCEPTION 'base scrvUSD schedule boundary absent';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
               WHERE c.oid IN (
                 pg_catalog.to_regclass('public.scrvusd_now_manifests')::oid,
                 pg_catalog.to_regclass('public.scrvusd_now_manifest_confirmations')::oid,
                 pg_catalog.to_regclass('public.scrvusd_now_manifest_visibility')::oid)
                 AND c.relowner<>pg_catalog.to_regrole(current_user)::oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid IN (
                    pg_catalog.to_regprocedure('public.publish_scrvusd_now_manifest(text,text)')::oid,
                    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_manifest(text)')::oid,
                    pg_catalog.to_regprocedure('public.witness_scrvusd_now_manifest(text)')::oid)
                    AND p.proowner<>pg_catalog.to_regrole(current_user)::oid) THEN
      RAISE EXCEPTION 'base scrvUSD schedule owner differs from attempt migration login';
    END IF;
    IF pg_catalog.to_regclass('public.scrvusd_now_arm_starts') IS NOT NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_arm_results') IS NOT NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_run_confirmations') IS NOT NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_start_confirmations') IS NOT NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_capture_floors') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.confirm_scrvusd_now_starts(text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.mark_scrvusd_now_capture_floor(text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.confirm_scrvusd_now_run(text,text)') IS NOT NULL THEN
      RAISE EXCEPTION 'scrvUSD attempt boundary already or partially installed';
    END IF;
  END $$`
}

const startArmSql = `CREATE FUNCTION public.start_scrvusd_now_arm(
  p_manifest_sha256 text,p_slot_id text,p_horizon_seconds integer,
  p_start_logical_sha256 text,p_start_physical_sha256 text,p_local_recorded_at timestamptz,
  p_start_payload text
) RETURNS TABLE (started_at timestamptz,start_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_manifest public.scrvusd_now_manifests%ROWTYPE;
        v_confirm public.scrvusd_now_manifest_confirmations%ROWTYPE;
        v_visibility public.scrvusd_now_manifest_visibility%ROWTYPE;
        v_slot jsonb; v_now timestamptz; v_open timestamptz; v_close timestamptz;
        v_body jsonb; v_unsigned text;
BEGIN
  IF p_manifest_sha256 IS NULL OR p_slot_id IS NULL
     OR p_start_logical_sha256 IS NULL OR p_start_physical_sha256 IS NULL
     OR p_start_payload IS NULL OR p_horizon_seconds IS NULL
     OR pg_catalog.octet_length(p_start_payload)>2048
     OR p_manifest_sha256 !~ '^[0-9a-f]{64}$' OR p_slot_id !~ '^[0-9a-f]{64}$'
     OR p_start_logical_sha256 !~ '^[0-9a-f]{64}$'
     OR p_start_physical_sha256 !~ '^[0-9a-f]{64}$'
     OR p_horizon_seconds NOT IN (3600,7200,86400,604800)
     OR p_local_recorded_at IS NULL THEN
    RAISE EXCEPTION 'invalid fixed arm or exact start references';
  END IF;
  SELECT * INTO v_manifest FROM public.scrvusd_now_manifests m
    WHERE m.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'manifest absent'; END IF;
  SELECT * INTO v_confirm FROM public.scrvusd_now_manifest_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND OR v_confirm.confirmer_xid=v_manifest.publisher_xid
     OR v_confirm.confirmed_at > v_manifest.start_at-interval '2 hours' THEN
    RAISE EXCEPTION 'pre-slot manifest confirmation absent';
  END IF;
  SELECT * INTO v_visibility FROM public.scrvusd_now_manifest_visibility w
    WHERE w.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND OR v_visibility.witness_xid IN
       (v_manifest.publisher_xid,v_confirm.confirmer_xid)
     OR v_visibility.manifest_visible_at<v_confirm.confirmed_at
     OR v_visibility.manifest_visible_at>v_manifest.start_at-interval '2 hours'
     OR pg_catalog.txid_current()=v_visibility.witness_xid THEN
    RAISE EXCEPTION 'pre-slot committed manifest visibility witness absent';
  END IF;
  SELECT s.value INTO v_slot FROM pg_catalog.jsonb_array_elements(v_manifest.payload::jsonb->'slots') s(value)
    WHERE s.value->>'slotId'=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot absent from exact manifest'; END IF;
  v_open := (v_slot->>'scheduledAtUtc')::timestamptz;
  v_close := (v_slot->>'closesAtUtc')::timestamptz;
  v_now := pg_catalog.clock_timestamp();
  IF v_now < v_open OR v_now >= v_close OR p_local_recorded_at < v_open
     OR p_local_recorded_at > v_now OR v_now > p_local_recorded_at + interval '60 seconds' THEN
    RAISE EXCEPTION 'start outside current half-open slot or stale local receipt';
  END IF;
  v_body := p_start_payload::jsonb;
  v_unsigned := pg_catalog.format(
    '{"study":"scrvusd-now-origin-attempt-start-v1","kind":"scheduled-arm-start",'
    || '"manifestSha256":"%s","slotId":"%s","horizonSeconds":%s,'
    || '"holder":"0xcbe72c8dc34af0dc8e7a70df4c1da0ef23feca8e",'
    || '"qAssetsRaw":"1000000000000000000000",'
    || '"route":"direct_erc4626_withdraw_crvusd_from_scrvusd",'
    || '"recordedAtUtc":"%s","evidenceClass":"local_research_only"}',
    p_manifest_sha256,p_slot_id,p_horizon_seconds,
    pg_catalog.to_char(p_local_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF p_start_payload IS DISTINCT FROM pg_catalog.substr(v_unsigned,1,pg_catalog.length(v_unsigned)-1)
       || ',"sha256":"' || p_start_logical_sha256 || '"}'
     OR v_body->>'sha256' IS DISTINCT FROM p_start_logical_sha256
     OR p_start_logical_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(
          pg_catalog.convert_to(v_unsigned,'UTF8'),'sha256'),'hex')
     OR p_start_physical_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(
          pg_catalog.convert_to(p_start_payload || E'\\n','UTF8'),'sha256'),'hex') THEN
    RAISE EXCEPTION 'start payload bytes or logical/physical SHA invalid';
  END IF;
  INSERT INTO public.scrvusd_now_arm_starts
    (manifest_sha256,slot_id,horizon_seconds,start_logical_sha256,start_physical_sha256,
     start_payload,local_recorded_at,started_at,start_xid)
  VALUES (p_manifest_sha256,p_slot_id,p_horizon_seconds,p_start_logical_sha256,
          p_start_physical_sha256,p_start_payload,p_local_recorded_at,v_now,pg_catalog.txid_current());
  started_at := v_now; start_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

const resultArmSql = `CREATE FUNCTION public.result_scrvusd_now_arm(
  p_manifest_sha256 text,p_slot_id text,p_horizon_seconds integer,
  p_status text,p_reason text,p_issue_logical_sha256 text,
  p_issue_physical_sha256 text,p_local_issued_at timestamptz,p_issue_payload text
) RETURNS TABLE (result_at timestamptz,result_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_start public.scrvusd_now_arm_starts%ROWTYPE;
        v_start_confirm public.scrvusd_now_start_confirmations%ROWTYPE;
        v_slot jsonb; v_close timestamptz; v_now timestamptz;
        v_floor public.scrvusd_now_capture_floors%ROWTYPE;
        v_source_started_at timestamptz; v_source_xid bigint;
        v_issue jsonb; v_unsigned text;
BEGIN
  SELECT * INTO v_start FROM public.scrvusd_now_arm_starts a
    WHERE a.manifest_sha256=p_manifest_sha256 AND a.slot_id=p_slot_id
      AND a.horizon_seconds=p_horizon_seconds;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed exact arm start absent'; END IF;
  SELECT * INTO v_start_confirm FROM public.scrvusd_now_start_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256 AND c.slot_id=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'four committed starts not confirmed before result'; END IF;
  SELECT * INTO v_floor FROM public.scrvusd_now_capture_floors f
    WHERE f.manifest_sha256=p_manifest_sha256 AND f.slot_id=p_slot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-confirm capture floor absent';
  END IF;
  SELECT s.value INTO v_slot FROM public.scrvusd_now_manifests m
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(m.payload::jsonb->'slots') s(value)
    WHERE m.manifest_sha256=p_manifest_sha256 AND s.value->>'slotId'=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot absent'; END IF;
  v_close := (v_slot->>'closesAtUtc')::timestamptz;
  v_now := pg_catalog.clock_timestamp();
  IF v_now < v_start.started_at OR v_now >= v_close
     OR pg_catalog.txid_current()=v_start.start_xid
     OR pg_catalog.txid_current()=v_floor.visibility_xid THEN
    RAISE EXCEPTION 'result outside slot or start/capture-floor transaction not committed';
  END IF;
  IF p_status IS NULL OR p_reason IS NULL
     OR p_status NOT IN ('issued','abstained','failed','unknown')
     OR p_reason NOT IN ('issued','source_unavailable','rpc_failure','disk_reserve',
                        'verification_failure','clock_or_slot_failure','process_failure','other')
     OR (p_status='issued' AND (p_reason<>'issued'
       OR p_issue_logical_sha256 IS NULL OR p_issue_physical_sha256 IS NULL
       OR p_issue_logical_sha256 !~ '^[0-9a-f]{64}$'
       OR p_issue_physical_sha256 !~ '^[0-9a-f]{64}$'
       OR p_local_issued_at IS NULL OR p_local_issued_at < v_floor.visible_at
       OR p_local_issued_at >= v_close OR p_local_issued_at > v_now
       OR p_issue_payload IS NULL OR pg_catalog.octet_length(p_issue_payload)>262144))
     OR (p_status<>'issued' AND (p_reason='issued' OR p_issue_logical_sha256 IS NOT NULL
       OR p_issue_physical_sha256 IS NOT NULL OR p_local_issued_at IS NOT NULL
       OR p_issue_payload IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid result status, reason, or exact issue references';
  END IF;
  IF p_status='issued' THEN
    SELECT s.source_start_at,s.source_start_xid INTO v_source_started_at,v_source_xid
      FROM public.scrvusd_now_source_starts s
     WHERE s.manifest_sha256=p_manifest_sha256 AND s.slot_id=p_slot_id;
    IF NOT FOUND OR v_source_started_at<v_floor.visible_at
       OR v_source_started_at>p_local_issued_at
       OR v_source_xid=pg_catalog.txid_current()
       OR v_source_xid=v_floor.visibility_xid THEN
      RAISE EXCEPTION 'issued result needs committed source start before local issue';
    END IF;
    v_issue := p_issue_payload::jsonb;
    v_unsigned := pg_catalog.substr(p_issue_payload,1,
      pg_catalog.length(p_issue_payload)-pg_catalog.length(',"sha256":"' || p_issue_logical_sha256 || '"}')) || '}';
    IF p_issue_payload NOT LIKE '%,' || '"sha256":"' || p_issue_logical_sha256 || '"}'
       OR pg_catalog.encode(public.digest(pg_catalog.convert_to(v_unsigned,'UTF8'),'sha256'),'hex')
          IS DISTINCT FROM p_issue_logical_sha256
       OR pg_catalog.encode(public.digest(pg_catalog.convert_to(p_issue_payload || E'\\n','UTF8'),'sha256'),'hex')
          IS DISTINCT FROM p_issue_physical_sha256
       OR v_issue->>'study' IS DISTINCT FROM 'scrvusd-now-origin-exit-forecast-issue-v2'
       OR v_issue->>'holder' IS DISTINCT FROM '0xcbe72c8dc34af0dc8e7a70df4c1da0ef23feca8e'
       OR v_issue->>'qAssetsRaw' IS DISTINCT FROM '1000000000000000000000'
       OR v_issue->>'route' IS DISTINCT FROM 'direct_erc4626_withdraw_crvusd_from_scrvusd'
       OR v_issue->>'sha256' IS DISTINCT FROM p_issue_logical_sha256
       OR v_issue->'scheduleBinding'->>'manifestSha256' IS DISTINCT FROM p_manifest_sha256
       OR v_issue->'scheduleBinding'->>'slotId' IS DISTINCT FROM p_slot_id
       OR (v_issue->>'horizonSeconds')::integer IS DISTINCT FROM p_horizon_seconds
       OR (v_issue->'scheduleBinding'->>'horizonSeconds')::integer IS DISTINCT FROM p_horizon_seconds
       OR (v_issue->>'issuedAtUtc')::timestamptz IS DISTINCT FROM p_local_issued_at
       OR v_issue->'scheduleBinding'->'attemptStart'->>'logicalSha256'
          IS DISTINCT FROM v_start.start_logical_sha256
       OR v_issue->'scheduleBinding'->'attemptStart'->>'physicalSha256'
          IS DISTINCT FROM v_start.start_physical_sha256 THEN
      RAISE EXCEPTION 'issued v2 payload bytes or exact start binding invalid';
    END IF;
  END IF;
  INSERT INTO public.scrvusd_now_arm_results
    (manifest_sha256,slot_id,horizon_seconds,status,reason,issue_logical_sha256,
     issue_physical_sha256,issue_payload,local_issued_at,result_at,result_xid)
  VALUES (p_manifest_sha256,p_slot_id,p_horizon_seconds,p_status,p_reason,
          p_issue_logical_sha256,p_issue_physical_sha256,p_issue_payload,p_local_issued_at,
          v_now,pg_catalog.txid_current());
  result_at := v_now; result_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

const confirmStartsSql = `CREATE FUNCTION public.confirm_scrvusd_now_starts(
  p_manifest_sha256 text,p_slot_id text
) RETURNS TABLE (confirmed_at timestamptz,confirmer_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_manifest public.scrvusd_now_manifests%ROWTYPE;
        v_slot jsonb; v_close timestamptz; v_now timestamptz;
        v_count integer; v_max_start timestamptz; v_same_xid boolean;
BEGIN
  SELECT * INTO v_manifest FROM public.scrvusd_now_manifests m
    WHERE m.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'manifest absent'; END IF;
  SELECT s.value INTO v_slot FROM pg_catalog.jsonb_array_elements(v_manifest.payload::jsonb->'slots') s(value)
    WHERE s.value->>'slotId'=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot absent'; END IF;
  v_close := (v_slot->>'closesAtUtc')::timestamptz;
  SELECT pg_catalog.count(*),pg_catalog.max(a.started_at),
         pg_catalog.bool_or(a.start_xid=pg_catalog.txid_current())
    INTO v_count,v_max_start,v_same_xid FROM public.scrvusd_now_arm_starts a
    WHERE a.manifest_sha256=p_manifest_sha256 AND a.slot_id=p_slot_id;
  v_now := pg_catalog.clock_timestamp();
  IF v_count<>4 OR v_same_xid OR v_now < v_max_start OR v_now >= v_close THEN
    RAISE EXCEPTION 'four committed arm starts not visible within slot';
  END IF;
  INSERT INTO public.scrvusd_now_start_confirmations
    (manifest_sha256,slot_id,confirmed_at,confirmer_xid)
  VALUES (p_manifest_sha256,p_slot_id,v_now,pg_catalog.txid_current());
  confirmed_at := v_now; confirmer_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

const captureFloorSql = `CREATE FUNCTION public.mark_scrvusd_now_capture_floor(
  p_manifest_sha256 text,p_slot_id text
) RETURNS TABLE (visible_at timestamptz,visibility_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_confirm public.scrvusd_now_start_confirmations%ROWTYPE;
        v_manifest public.scrvusd_now_manifests%ROWTYPE;
        v_slot jsonb; v_close timestamptz; v_now timestamptz;
BEGIN
  SELECT * INTO v_confirm FROM public.scrvusd_now_start_confirmations c
    WHERE c.manifest_sha256=p_manifest_sha256 AND c.slot_id=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed four-start confirmation absent'; END IF;
  SELECT * INTO v_manifest FROM public.scrvusd_now_manifests m
    WHERE m.manifest_sha256=p_manifest_sha256;
  SELECT s.value INTO v_slot FROM pg_catalog.jsonb_array_elements(v_manifest.payload::jsonb->'slots') s(value)
    WHERE s.value->>'slotId'=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot absent'; END IF;
  v_close := (v_slot->>'closesAtUtc')::timestamptz;
  v_now := pg_catalog.clock_timestamp();
  IF pg_catalog.txid_current()=v_confirm.confirmer_xid
     OR v_now < v_confirm.confirmed_at OR v_now >= v_close THEN
    RAISE EXCEPTION 'capture floor needs separate visible transaction inside slot';
  END IF;
  INSERT INTO public.scrvusd_now_capture_floors
    (manifest_sha256,slot_id,visible_at,visibility_xid)
  VALUES (p_manifest_sha256,p_slot_id,v_now,pg_catalog.txid_current());
  visible_at := v_now; visibility_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

const confirmRunSql = `CREATE FUNCTION public.confirm_scrvusd_now_run(
  p_manifest_sha256 text,p_slot_id text
) RETURNS TABLE (confirmed_at timestamptz,confirmer_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_manifest public.scrvusd_now_manifests%ROWTYPE;
        v_slot jsonb; v_close timestamptz; v_now timestamptz;
        v_count integer; v_max_result timestamptz; v_same_xid boolean;
        v_first_issued_target timestamptz;
BEGIN
  SELECT * INTO v_manifest FROM public.scrvusd_now_manifests m
    WHERE m.manifest_sha256=p_manifest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'manifest absent'; END IF;
  SELECT s.value INTO v_slot FROM pg_catalog.jsonb_array_elements(v_manifest.payload::jsonb->'slots') s(value)
    WHERE s.value->>'slotId'=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot absent'; END IF;
  v_close := (v_slot->>'closesAtUtc')::timestamptz;
  SELECT pg_catalog.count(*),pg_catalog.max(r.result_at),
         pg_catalog.bool_or(r.result_xid=pg_catalog.txid_current()),
         pg_catalog.min(CASE WHEN r.status='issued' THEN
           r.local_issued_at + r.horizon_seconds * interval '1 second' END)
    INTO v_count,v_max_result,v_same_xid,v_first_issued_target
    FROM public.scrvusd_now_arm_results r
    WHERE r.manifest_sha256=p_manifest_sha256 AND r.slot_id=p_slot_id;
  v_now := pg_catalog.clock_timestamp();
  IF v_count<>4 OR v_same_xid OR v_now < v_max_result OR v_now >= v_close
     OR (v_first_issued_target IS NOT NULL AND v_now >= v_first_issued_target) THEN
    RAISE EXCEPTION 'four committed arm results not visible within slot';
  END IF;
  INSERT INTO public.scrvusd_now_run_confirmations
    (manifest_sha256,slot_id,confirmed_at,confirmer_xid)
  VALUES (p_manifest_sha256,p_slot_id,v_now,pg_catalog.txid_current());
  confirmed_at := v_now; confirmer_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

export const SCRVUSD_SCHEDULE_ATTEMPT_MIGRATION_SQL = Object.freeze([
  `CREATE TABLE public.scrvusd_now_arm_starts (
    manifest_sha256 text NOT NULL REFERENCES public.scrvusd_now_manifests(manifest_sha256),
    slot_id text NOT NULL CHECK (slot_id ~ '^[0-9a-f]{64}$'),
    horizon_seconds integer NOT NULL CHECK (horizon_seconds IN (3600,7200,86400,604800)),
    start_logical_sha256 text NOT NULL UNIQUE CHECK (start_logical_sha256 ~ '^[0-9a-f]{64}$'),
    start_physical_sha256 text NOT NULL UNIQUE CHECK (start_physical_sha256 ~ '^[0-9a-f]{64}$'),
    start_payload text NOT NULL,local_recorded_at timestamptz NOT NULL,
    started_at timestamptz NOT NULL,
    start_xid bigint NOT NULL, PRIMARY KEY(manifest_sha256,slot_id,horizon_seconds)
  )`,
  `CREATE TABLE public.scrvusd_now_start_confirmations (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,
    confirmed_at timestamptz NOT NULL,confirmer_xid bigint NOT NULL,
    PRIMARY KEY(manifest_sha256,slot_id)
  )`,
  `CREATE TABLE public.scrvusd_now_capture_floors (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,
    visible_at timestamptz NOT NULL,visibility_xid bigint NOT NULL,
    PRIMARY KEY(manifest_sha256,slot_id)
  )`,
  `CREATE TABLE public.scrvusd_now_arm_results (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,horizon_seconds integer NOT NULL,
    status text NOT NULL CHECK(status IN ('issued','abstained','failed','unknown')),
    reason text NOT NULL,issue_logical_sha256 text UNIQUE,
    issue_physical_sha256 text UNIQUE,issue_payload text,local_issued_at timestamptz,
    result_at timestamptz NOT NULL,result_xid bigint NOT NULL,
    PRIMARY KEY(manifest_sha256,slot_id,horizon_seconds),
    FOREIGN KEY(manifest_sha256,slot_id,horizon_seconds) REFERENCES
      public.scrvusd_now_arm_starts(manifest_sha256,slot_id,horizon_seconds)
  )`,
  `CREATE TABLE public.scrvusd_now_run_confirmations (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,
    confirmed_at timestamptz NOT NULL,confirmer_xid bigint NOT NULL,
    PRIMARY KEY(manifest_sha256,slot_id)
  )`,
  startArmSql,
  confirmStartsSql,
  captureFloorSql,
  resultArmSql,
  confirmRunSql,
  'REVOKE ALL ON TABLE public.scrvusd_now_arm_starts FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_start_confirmations FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_capture_floors FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_arm_results FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_run_confirmations FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.confirm_scrvusd_now_starts(text,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.mark_scrvusd_now_capture_floor(text,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.confirm_scrvusd_now_run(text,text) FROM PUBLIC',
])

// Third, additive migration. Existing run rows are not assigned a historical
// witness retroactively; only future distinct-transaction readbacks qualify.
export function scheduleAsOfPreflightSql(role) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role ?? ''))
    throw new Error('SCRVUSD_SCHEDULE_PUBLISHER_ROLE must name an existing lowercase role')
  return `DO $$ BEGIN
    IF pg_catalog.to_regrole('${role}') IS NULL
       OR pg_catalog.to_regrole('${role}')::oid=pg_catalog.to_regrole(current_user)::oid
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members am
           WHERE am.roleid=pg_catalog.to_regrole('${role}')::oid) > 1
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
                  WHERE am.roleid=pg_catalog.to_regrole('${role}')::oid
                    AND (am.member<>pg_catalog.to_regrole(current_user)::oid
                         OR NOT am.admin_option OR am.inherit_option OR am.set_option)) THEN
      RAISE EXCEPTION 'dedicated scrvUSD publisher role absent or unsafe';
    END IF;
    IF pg_catalog.to_regclass('public.scrvusd_now_manifests') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_manifest_confirmations') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_manifest_visibility') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_arm_starts') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_start_confirmations') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_run_confirmations') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_arm_results') IS NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_capture_floors') IS NULL
       OR pg_catalog.to_regprocedure('public.publish_scrvusd_now_manifest(text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.confirm_scrvusd_now_manifest(text)') IS NULL
       OR pg_catalog.to_regprocedure('public.witness_scrvusd_now_manifest(text)') IS NULL
       OR pg_catalog.to_regprocedure('public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.confirm_scrvusd_now_starts(text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.mark_scrvusd_now_capture_floor(text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.confirm_scrvusd_now_run(text,text)') IS NULL THEN
      RAISE EXCEPTION 'scrvUSD attempt boundary absent';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
               WHERE c.oid IN (pg_catalog.to_regclass('public.scrvusd_now_manifests')::oid,
                  pg_catalog.to_regclass('public.scrvusd_now_manifest_confirmations')::oid,
                  pg_catalog.to_regclass('public.scrvusd_now_manifest_visibility')::oid,
                  pg_catalog.to_regclass('public.scrvusd_now_arm_starts')::oid,
                  pg_catalog.to_regclass('public.scrvusd_now_start_confirmations')::oid,
                  pg_catalog.to_regclass('public.scrvusd_now_capture_floors')::oid,
                  pg_catalog.to_regclass('public.scrvusd_now_arm_results')::oid,
                  pg_catalog.to_regclass('public.scrvusd_now_run_confirmations')::oid)
                 AND c.relowner<>pg_catalog.to_regrole(current_user)::oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid IN (
                    pg_catalog.to_regprocedure('public.publish_scrvusd_now_manifest(text,text)')::oid,
                    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_manifest(text)')::oid,
                    pg_catalog.to_regprocedure('public.witness_scrvusd_now_manifest(text)')::oid,
                    pg_catalog.to_regprocedure('public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)')::oid,
                    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_starts(text,text)')::oid,
                    pg_catalog.to_regprocedure('public.mark_scrvusd_now_capture_floor(text,text)')::oid,
                    pg_catalog.to_regprocedure('public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)')::oid,
                    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_run(text,text)')::oid)
                    AND p.proowner<>pg_catalog.to_regrole(current_user)::oid) THEN
      RAISE EXCEPTION 'scrvUSD existing boundary owner differs from as-of migration login';
    END IF;
    IF pg_catalog.to_regclass('public.scrvusd_now_source_starts') IS NOT NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_run_visibility') IS NOT NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_scores') IS NOT NULL
       OR pg_catalog.to_regclass('public.scrvusd_now_score_visibility') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.start_scrvusd_now_source(text,text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.witness_scrvusd_now_run(text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.witness_scrvusd_now_score(text,text,integer)') IS NOT NULL THEN
      RAISE EXCEPTION 'scrvUSD as-of boundary already or partially installed';
    END IF;
  END $$`
}

const startSourceSql = `CREATE FUNCTION public.start_scrvusd_now_source(
  p_manifest_sha256 text,p_slot_id text,p_nonce_sha256 text
) RETURNS TABLE (source_start_at timestamptz,source_start_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_floor public.scrvusd_now_capture_floors%ROWTYPE;
        v_starts public.scrvusd_now_start_confirmations%ROWTYPE;
        v_slot jsonb; v_close timestamptz; v_now timestamptz;
BEGIN
  SELECT * INTO v_floor FROM public.scrvusd_now_capture_floors f
   WHERE f.manifest_sha256=p_manifest_sha256 AND f.slot_id=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed capture floor absent'; END IF;
  SELECT * INTO v_starts FROM public.scrvusd_now_start_confirmations s
   WHERE s.manifest_sha256=p_manifest_sha256 AND s.slot_id=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed four-start confirmation absent'; END IF;
  SELECT s.value INTO v_slot FROM public.scrvusd_now_manifests m
   CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(m.payload::jsonb->'slots') s(value)
   WHERE m.manifest_sha256=p_manifest_sha256 AND s.value->>'slotId'=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'slot absent'; END IF;
  v_close := (v_slot->>'closesAtUtc')::timestamptz;
  v_now := pg_catalog.clock_timestamp();
  IF p_nonce_sha256 IS NULL OR p_nonce_sha256 !~ '^[0-9a-f]{64}$'
     OR pg_catalog.txid_current() IN (v_floor.visibility_xid,v_starts.confirmer_xid)
     OR v_now < v_floor.visible_at OR v_now >= v_close THEN
    RAISE EXCEPTION 'source start needs committed floor and in-slot DB clock';
  END IF;
  INSERT INTO public.scrvusd_now_source_starts
    (manifest_sha256,slot_id,floor_xid,source_start_at,source_start_xid,nonce_sha256)
  VALUES (p_manifest_sha256,p_slot_id,v_floor.visibility_xid,v_now,
          pg_catalog.txid_current(),p_nonce_sha256);
  source_start_at := v_now; source_start_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

const witnessRunSql = `CREATE FUNCTION public.witness_scrvusd_now_run(
  p_manifest_sha256 text,p_slot_id text
) RETURNS TABLE (run_visible_at timestamptz,witness_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_run public.scrvusd_now_run_confirmations%ROWTYPE;
        v_source public.scrvusd_now_source_starts%ROWTYPE;
        v_count integer; v_first_target timestamptz; v_latest timestamptz;
        v_first_result timestamptz; v_source_result_same_xid boolean;
        v_now timestamptz;
BEGIN
  SELECT * INTO v_run FROM public.scrvusd_now_run_confirmations c
   WHERE c.manifest_sha256=p_manifest_sha256 AND c.slot_id=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed run confirmation absent'; END IF;
  SELECT * INTO v_source FROM public.scrvusd_now_source_starts s
   WHERE s.manifest_sha256=p_manifest_sha256 AND s.slot_id=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed source start absent'; END IF;
  SELECT pg_catalog.count(*),pg_catalog.max(r.result_at),pg_catalog.min(r.result_at),
         pg_catalog.bool_or(r.result_xid=v_source.source_start_xid),
         pg_catalog.min(CASE WHEN r.status='issued' THEN
            r.local_issued_at + r.horizon_seconds * interval '1 second' END)
    INTO v_count,v_latest,v_first_result,v_source_result_same_xid,v_first_target
    FROM public.scrvusd_now_arm_results r
   WHERE r.manifest_sha256=p_manifest_sha256 AND r.slot_id=p_slot_id;
  v_now := pg_catalog.clock_timestamp();
  IF v_count<>4 OR v_latest>v_run.confirmed_at
     OR v_source.source_start_at>v_first_result OR v_source_result_same_xid
     OR pg_catalog.txid_current() IN (v_run.confirmer_xid,v_source.source_start_xid)
     OR v_now < v_run.confirmed_at
     OR (v_first_target IS NOT NULL AND v_now >= v_first_target) THEN
    RAISE EXCEPTION 'run visibility witness needs committed four-arm run before first target';
  END IF;
  INSERT INTO public.scrvusd_now_run_visibility
    (manifest_sha256,slot_id,run_visible_at,witness_xid)
  VALUES (p_manifest_sha256,p_slot_id,v_now,pg_catalog.txid_current());
  run_visible_at := v_now; witness_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

const recordScoreSql = `CREATE FUNCTION public.record_scrvusd_now_score(
  p_manifest_sha256 text,p_slot_id text,p_horizon_seconds integer,
  p_issue_logical_sha256 text,p_issue_physical_sha256 text,p_score_filename text,
  p_score_logical_sha256 text,p_score_physical_sha256 text,p_score_payload text
) RETURNS TABLE (score_recorded_at timestamptz,score_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_arm public.scrvusd_now_arm_results%ROWTYPE;
        v_run public.scrvusd_now_run_visibility%ROWTYPE;
        v_prior public.scrvusd_now_scores%ROWTYPE;
        v_body jsonb; v_issue jsonb; v_unsigned text; v_expected_filename text;
        v_target timestamptz; v_deadline timestamptz; v_now timestamptz;
BEGIN
  SELECT * INTO v_arm FROM public.scrvusd_now_arm_results r
   WHERE r.manifest_sha256=p_manifest_sha256 AND r.slot_id=p_slot_id
     AND r.horizon_seconds=p_horizon_seconds AND r.status='issued';
  IF NOT FOUND THEN RAISE EXCEPTION 'committed issued arm absent'; END IF;
  v_issue := v_arm.issue_payload::jsonb;
  v_target := v_arm.local_issued_at + p_horizon_seconds * interval '1 second';
  v_deadline := v_target + 5400 * interval '1 second';
  v_expected_filename :=
    pg_catalog.lpad((v_arm.issue_payload::jsonb->'anchorBlock'->>'number'),12,'0') || '-' ||
    pg_catalog.substr((v_arm.issue_payload::jsonb->'anchorBlock'->>'hash'),3) || '-' ||
    p_horizon_seconds::text || 's-' ||
    (v_arm.issue_payload::jsonb->'scheduleBinding'->'attemptStart'->>'logicalSha256') || '-' ||
    v_arm.issue_logical_sha256 || '.json';
  SELECT * INTO v_run FROM public.scrvusd_now_run_visibility v
   WHERE v.manifest_sha256=p_manifest_sha256 AND v.slot_id=p_slot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed run visibility witness absent'; END IF;
  v_now := pg_catalog.clock_timestamp();
  IF pg_catalog.txid_current()=v_run.witness_xid OR v_now<v_run.run_visible_at
     OR p_issue_logical_sha256 IS DISTINCT FROM v_arm.issue_logical_sha256
     OR p_issue_physical_sha256 IS DISTINCT FROM v_arm.issue_physical_sha256
     OR p_score_filename IS NULL OR p_score_filename IS DISTINCT FROM v_expected_filename
     OR pg_catalog.length(p_score_filename)>512
     OR p_score_filename !~ '^[0-9a-z-]+\\.json$'
     OR p_score_logical_sha256 !~ '^[0-9a-f]{64}$'
     OR p_score_physical_sha256 !~ '^[0-9a-f]{64}$'
     OR v_issue->>'targetUtc' IS NULL
     OR (v_issue->>'targetUtc')::timestamptz IS DISTINCT FROM v_target
     OR v_issue->'outcomeProtocol'->>'targetUtc' IS NULL
     OR (v_issue->'outcomeProtocol'->>'targetUtc')::timestamptz IS DISTINCT FROM v_target
     OR v_issue->'outcomeProtocol'->'checkpointSelection'->>'captureDeadlineUtc' IS NULL
     OR (v_issue->'outcomeProtocol'->'checkpointSelection'->>'captureDeadlineUtc')::timestamptz IS DISTINCT FROM v_deadline
     OR v_now < v_deadline
     OR p_score_payload IS NULL OR pg_catalog.octet_length(p_score_payload)>262144 THEN
    RAISE EXCEPTION 'score recording lacks exact issued arm or valid payload';
  END IF;
  v_body := p_score_payload::jsonb;
  v_unsigned := pg_catalog.substr(p_score_payload,1,
    pg_catalog.length(p_score_payload)-pg_catalog.length(',"sha256":"' || p_score_logical_sha256 || '"}')) || '}';
  IF p_score_payload NOT LIKE '%,' || '"sha256":"' || p_score_logical_sha256 || '"}'
     OR pg_catalog.encode(public.digest(pg_catalog.convert_to(v_unsigned,'UTF8'),'sha256'),'hex')
       IS DISTINCT FROM p_score_logical_sha256
     OR pg_catalog.encode(public.digest(pg_catalog.convert_to(p_score_payload || E'\\n','UTF8'),'sha256'),'hex')
       IS DISTINCT FROM p_score_physical_sha256
     OR v_body->>'study' IS DISTINCT FROM 'scrvusd-now-origin-exit-forecast-score-v2'
     OR v_body->>'sha256' IS DISTINCT FROM p_score_logical_sha256
     OR v_body->'issue'->>'filename' IS DISTINCT FROM p_score_filename
     OR v_body->'issue'->>'logicalSha256' IS DISTINCT FROM p_issue_logical_sha256
     OR v_body->'issue'->>'physicalSha256' IS DISTINCT FROM p_issue_physical_sha256
     OR (v_body->>'horizonSeconds')::integer IS DISTINCT FROM p_horizon_seconds
     OR v_body->>'targetUtc' IS DISTINCT FROM v_issue->>'targetUtc'
     OR v_body->>'evidenceCutoffUtc' IS DISTINCT FROM
        v_issue->'outcomeProtocol'->'checkpointSelection'->>'captureDeadlineUtc'
     OR v_body->'pointOutcome'->>'holder' IS DISTINCT FROM v_issue->>'holder'
     OR v_body->'pointOutcome'->>'qAssetsRaw' IS DISTINCT FROM v_issue->>'qAssetsRaw'
     OR v_body->'pointOutcome'->>'route' IS DISTINCT FROM v_issue->>'route'
     OR v_body->'pointOutcome'->>'status' IS NULL
     OR v_body->'pointOutcome'->>'status' NOT IN
        ('success','revert','provider_ambiguity','missing','missing_quote_checkpoint')
     OR v_body->>'scoredAtUtc' IS NULL
     OR v_body->>'scoredAtUtc' IS DISTINCT FROM pg_catalog.to_char(
        (v_body->>'scoredAtUtc')::timestamptz AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR (v_body->>'scoredAtUtc')::timestamptz < v_deadline
     OR (v_body->>'scoredAtUtc')::timestamptz > v_now THEN
    RAISE EXCEPTION 'score payload bytes or exact issue reference invalid';
  END IF;
  SELECT * INTO v_prior FROM public.scrvusd_now_scores s
   WHERE s.manifest_sha256=p_manifest_sha256 AND s.slot_id=p_slot_id
     AND s.horizon_seconds=p_horizon_seconds;
  IF FOUND THEN
    IF v_prior.issue_logical_sha256 IS DISTINCT FROM p_issue_logical_sha256
       OR v_prior.issue_physical_sha256 IS DISTINCT FROM p_issue_physical_sha256
       OR v_prior.score_filename IS DISTINCT FROM p_score_filename
       OR v_prior.score_logical_sha256 IS DISTINCT FROM p_score_logical_sha256
       OR v_prior.score_physical_sha256 IS DISTINCT FROM p_score_physical_sha256
       OR v_prior.score_payload IS DISTINCT FROM p_score_payload THEN
      RAISE EXCEPTION 'conflicting score retry';
    END IF;
    score_recorded_at := v_prior.score_recorded_at;
    score_xid := v_prior.score_xid; RETURN NEXT; RETURN;
  END IF;
  INSERT INTO public.scrvusd_now_scores
    (manifest_sha256,slot_id,horizon_seconds,issue_logical_sha256,issue_physical_sha256,
     score_filename,score_logical_sha256,score_physical_sha256,score_payload,
     score_recorded_at,score_xid)
  VALUES (p_manifest_sha256,p_slot_id,p_horizon_seconds,p_issue_logical_sha256,
          p_issue_physical_sha256,p_score_filename,p_score_logical_sha256,
          p_score_physical_sha256,p_score_payload,v_now,pg_catalog.txid_current());
  score_recorded_at := v_now; score_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

const witnessScoreSql = `CREATE FUNCTION public.witness_scrvusd_now_score(
  p_manifest_sha256 text,p_slot_id text,p_horizon_seconds integer
) RETURNS TABLE (score_visible_at timestamptz,witness_xid bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_score public.scrvusd_now_scores%ROWTYPE;
        v_now timestamptz;
BEGIN
  SELECT * INTO v_score FROM public.scrvusd_now_scores s
   WHERE s.manifest_sha256=p_manifest_sha256 AND s.slot_id=p_slot_id
     AND s.horizon_seconds=p_horizon_seconds;
  IF NOT FOUND THEN RAISE EXCEPTION 'committed exact score absent'; END IF;
  v_now := pg_catalog.clock_timestamp();
  IF pg_catalog.txid_current()=v_score.score_xid OR v_now<v_score.score_recorded_at
     OR pg_catalog.encode(public.digest(pg_catalog.convert_to(v_score.score_payload || E'\\n','UTF8'),'sha256'),'hex')
       IS DISTINCT FROM v_score.score_physical_sha256 THEN
    RAISE EXCEPTION 'score visibility witness needs separately committed exact score';
  END IF;
  INSERT INTO public.scrvusd_now_score_visibility
    (manifest_sha256,slot_id,horizon_seconds,score_visible_at,witness_xid)
  VALUES (p_manifest_sha256,p_slot_id,p_horizon_seconds,v_now,pg_catalog.txid_current());
  score_visible_at := v_now; witness_xid := pg_catalog.txid_current(); RETURN NEXT;
END $$`

export const SCRVUSD_SCHEDULE_ASOF_MIGRATION_SQL = Object.freeze([
  `CREATE TABLE public.scrvusd_now_source_starts (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,
    floor_xid bigint NOT NULL,source_start_at timestamptz NOT NULL,
    source_start_xid bigint NOT NULL,nonce_sha256 text NOT NULL
      CHECK(nonce_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY(manifest_sha256,slot_id),
    FOREIGN KEY(manifest_sha256,slot_id) REFERENCES
      public.scrvusd_now_capture_floors(manifest_sha256,slot_id)
  )`,
  `CREATE TABLE public.scrvusd_now_run_visibility (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,
    run_visible_at timestamptz NOT NULL,witness_xid bigint NOT NULL,
    PRIMARY KEY(manifest_sha256,slot_id),
    FOREIGN KEY(manifest_sha256,slot_id) REFERENCES
      public.scrvusd_now_run_confirmations(manifest_sha256,slot_id)
  )`,
  `CREATE TABLE public.scrvusd_now_scores (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,
    horizon_seconds integer NOT NULL CHECK(horizon_seconds IN (3600,7200,86400,604800)),
    issue_logical_sha256 text NOT NULL,issue_physical_sha256 text NOT NULL,
    score_filename text NOT NULL,score_logical_sha256 text NOT NULL UNIQUE,
    score_physical_sha256 text NOT NULL UNIQUE,score_payload text NOT NULL,
    score_recorded_at timestamptz NOT NULL,score_xid bigint NOT NULL,
    PRIMARY KEY(manifest_sha256,slot_id,horizon_seconds),
    FOREIGN KEY(manifest_sha256,slot_id,horizon_seconds) REFERENCES
      public.scrvusd_now_arm_results(manifest_sha256,slot_id,horizon_seconds)
  )`,
  `CREATE TABLE public.scrvusd_now_score_visibility (
    manifest_sha256 text NOT NULL,slot_id text NOT NULL,horizon_seconds integer NOT NULL,
    score_visible_at timestamptz NOT NULL,witness_xid bigint NOT NULL,
    PRIMARY KEY(manifest_sha256,slot_id,horizon_seconds),
    FOREIGN KEY(manifest_sha256,slot_id,horizon_seconds) REFERENCES
      public.scrvusd_now_scores(manifest_sha256,slot_id,horizon_seconds)
  )`,
  startSourceSql,
  witnessRunSql,
  recordScoreSql,
  witnessScoreSql,
  'REVOKE ALL ON TABLE public.scrvusd_now_source_starts FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_run_visibility FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_scores FROM PUBLIC',
  'REVOKE ALL ON TABLE public.scrvusd_now_score_visibility FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.start_scrvusd_now_source(text,text,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.witness_scrvusd_now_run(text,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text) FROM PUBLIC',
  'REVOKE ALL ON FUNCTION public.witness_scrvusd_now_score(text,text,integer) FROM PUBLIC',
])

// Both runtime audits inspect the same ownership universe. Before the attempt
// migration there are six base objects; after attempts sixteen, after as-of
// witness installation twenty-four.
// A partial installation or a second owner must never make an inbound creator
// membership appear safe.
const OWNER_AND_MEMBERSHIP_CTES = `owner_objects AS (
  SELECT c.relowner AS owner_oid FROM pg_catalog.pg_class c
  WHERE c.oid = ANY(ARRAY[
    pg_catalog.to_regclass('public.scrvusd_now_manifests')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_manifest_confirmations')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_manifest_visibility')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_arm_starts')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_start_confirmations')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_capture_floors')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_arm_results')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_run_confirmations')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_source_starts')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_run_visibility')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_scores')::oid,
    pg_catalog.to_regclass('public.scrvusd_now_score_visibility')::oid
  ])
  UNION ALL
  SELECT p.proowner AS owner_oid FROM pg_catalog.pg_proc p
  WHERE p.oid = ANY(ARRAY[
    pg_catalog.to_regprocedure('public.publish_scrvusd_now_manifest(text,text)')::oid,
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_manifest(text)')::oid,
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_manifest(text)')::oid,
    pg_catalog.to_regprocedure('public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)')::oid,
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_starts(text,text)')::oid,
    pg_catalog.to_regprocedure('public.mark_scrvusd_now_capture_floor(text,text)')::oid,
    pg_catalog.to_regprocedure('public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)')::oid,
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_run(text,text)')::oid,
    pg_catalog.to_regprocedure('public.start_scrvusd_now_source(text,text,text)')::oid,
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_run(text,text)')::oid,
    pg_catalog.to_regprocedure('public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text)')::oid,
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_score(text,text,integer)')::oid
  ])
), owner_state AS (
  SELECT pg_catalog.count(*) AS object_count,
         pg_catalog.count(DISTINCT owner_oid) AS owner_count,
         pg_catalog.min(owner_oid::bigint)::oid AS owner_oid
  FROM owner_objects
), inbound_state AS (
  SELECT pg_catalog.count(*) AS member_count,
         coalesce(pg_catalog.bool_and(
           am.member=(SELECT owner_oid FROM owner_state)
           AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option
         ),false) AS exact_creator_membership
  FROM pg_catalog.pg_auth_members am
  WHERE am.roleid=(SELECT oid FROM role_state)
)`

export const SCRVUSD_SCHEDULE_AUDIT_SQL = `WITH role_state AS (
  SELECT r.oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user
), protected AS (
  SELECT x.rel AS rel FROM pg_catalog.unnest(ARRAY[
    pg_catalog.to_regclass('public.scrvusd_now_manifests'),
    pg_catalog.to_regclass('public.scrvusd_now_manifest_confirmations'),
    pg_catalog.to_regclass('public.scrvusd_now_manifest_visibility'),
    pg_catalog.to_regclass('public.scrvusd_now_arm_starts'),
    pg_catalog.to_regclass('public.scrvusd_now_start_confirmations'),
    pg_catalog.to_regclass('public.scrvusd_now_capture_floors'),
    pg_catalog.to_regclass('public.scrvusd_now_arm_results'),
    pg_catalog.to_regclass('public.scrvusd_now_run_confirmations'),
    pg_catalog.to_regclass('public.scrvusd_now_source_starts'),
    pg_catalog.to_regclass('public.scrvusd_now_run_visibility'),
    pg_catalog.to_regclass('public.scrvusd_now_scores'),
    pg_catalog.to_regclass('public.scrvusd_now_score_visibility')
  ]) AS x(rel) WHERE x.rel IS NOT NULL
), funcs AS (
  SELECT x.signature AS oid FROM pg_catalog.unnest(ARRAY[
    pg_catalog.to_regprocedure('public.publish_scrvusd_now_manifest(text,text)'),
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_manifest(text)'),
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_manifest(text)'),
    pg_catalog.to_regprocedure('public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)'),
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_starts(text,text)'),
    pg_catalog.to_regprocedure('public.mark_scrvusd_now_capture_floor(text,text)'),
    pg_catalog.to_regprocedure('public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)'),
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_run(text,text)'),
    pg_catalog.to_regprocedure('public.start_scrvusd_now_source(text,text,text)'),
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_run(text,text)'),
    pg_catalog.to_regprocedure('public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text)'),
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_score(text,text,integer)')
  ]) AS x(signature) WHERE x.signature IS NOT NULL
), ${OWNER_AND_MEMBERSHIP_CTES}
SELECT current_user AS role_name,
  session_user=current_user AS direct_login_role,
  (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
   FROM role_state) AS ordinary_role,
  NOT pg_catalog.has_schema_privilege(current_user,'public','CREATE')
    AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') AS no_create,
  pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
  (SELECT pg_catalog.bool_and(
    NOT pg_catalog.has_table_privilege(current_user,rel,'INSERT')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'INSERT')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'UPDATE')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'UPDATE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'DELETE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'REFERENCES')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'REFERENCES')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'TRIGGER')
  ) FROM protected) AS no_direct_write,
  (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(current_user,rel,'SELECT'))
   FROM protected) AS can_read,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER'))
   FROM pg_catalog.pg_class c WHERE c.oid IN (SELECT rel FROM protected)) AS no_table_owner_membership,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER'))
   FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT oid FROM funcs)) AS no_function_owner_membership,
  (SELECT object_count IN (6,16,24) AND owner_count=1 FROM owner_state) AS common_protected_owner,
  (SELECT member_count=0 OR (member_count=1 AND exact_creator_membership)
   FROM inbound_state) AS restricted_inbound_role_membership,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid IN (SELECT oid FROM funcs) AND a.privilege_type='EXECUTE'
      AND a.grantee <> p.proowner AND a.grantee <> (SELECT oid FROM role_state)
  ) AS exclusive_function_acl,
  pg_catalog.has_function_privilege(current_user,
    'public.publish_scrvusd_now_manifest(text,text)','EXECUTE') AS can_publish,
  pg_catalog.has_function_privilege(current_user,
    'public.confirm_scrvusd_now_manifest(text)','EXECUTE') AS can_confirm,
  pg_catalog.has_function_privilege(current_user,
    'public.witness_scrvusd_now_manifest(text)','EXECUTE') AS can_witness_manifest`

export function scheduleAuditPass(row) {
  return Boolean(
    row &&
    [
      'direct_login_role',
      'ordinary_role',
      'no_create',
      'schema_usage',
      'no_direct_write',
      'can_read',
      'no_table_owner_membership',
      'no_function_owner_membership',
      'common_protected_owner',
      'restricted_inbound_role_membership',
      'exclusive_function_acl',
      'can_publish',
      'can_confirm',
      'can_witness_manifest',
    ].every((key) => row[key] === true),
  )
}

export const SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL = `WITH role_state AS (
  SELECT r.oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user
), protected AS (
  SELECT x.rel AS rel FROM pg_catalog.unnest(ARRAY[
    pg_catalog.to_regclass('public.scrvusd_now_arm_starts'),
    pg_catalog.to_regclass('public.scrvusd_now_start_confirmations'),
    pg_catalog.to_regclass('public.scrvusd_now_capture_floors'),
    pg_catalog.to_regclass('public.scrvusd_now_arm_results'),
    pg_catalog.to_regclass('public.scrvusd_now_run_confirmations'),
    pg_catalog.to_regclass('public.scrvusd_now_source_starts'),
    pg_catalog.to_regclass('public.scrvusd_now_run_visibility'),
    pg_catalog.to_regclass('public.scrvusd_now_scores'),
    pg_catalog.to_regclass('public.scrvusd_now_score_visibility')
  ]) x(rel) WHERE x.rel IS NOT NULL
), funcs AS (
  SELECT x.signature AS oid FROM pg_catalog.unnest(ARRAY[
    pg_catalog.to_regprocedure('public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)'),
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_starts(text,text)'),
    pg_catalog.to_regprocedure('public.mark_scrvusd_now_capture_floor(text,text)'),
    pg_catalog.to_regprocedure('public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)'),
    pg_catalog.to_regprocedure('public.confirm_scrvusd_now_run(text,text)'),
    pg_catalog.to_regprocedure('public.start_scrvusd_now_source(text,text,text)'),
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_run(text,text)'),
    pg_catalog.to_regprocedure('public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text)'),
    pg_catalog.to_regprocedure('public.witness_scrvusd_now_score(text,text,integer)')
  ]) x(signature) WHERE x.signature IS NOT NULL
), ${OWNER_AND_MEMBERSHIP_CTES}
SELECT current_user AS role_name,
  session_user=current_user AS direct_attempt_login_role,
  (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
   FROM role_state) AS ordinary_attempt_role,
  NOT pg_catalog.has_schema_privilege(current_user,'public','CREATE')
    AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') AS no_attempt_create,
  (SELECT pg_catalog.bool_and(
    NOT pg_catalog.has_table_privilege(current_user,rel,'INSERT')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'INSERT')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'UPDATE')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'UPDATE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'DELETE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'REFERENCES')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'REFERENCES')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'TRIGGER')
  ) FROM protected) AS no_attempt_direct_write,
  (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(current_user,rel,'SELECT'))
   FROM protected) AS can_read_attempts,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER'))
   FROM pg_catalog.pg_class c WHERE c.oid IN (SELECT rel FROM protected)) AS no_attempt_owner_membership,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER'))
   FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT oid FROM funcs)) AS no_attempt_function_owner_membership,
  (SELECT object_count IN (16,24) AND owner_count=1 FROM owner_state) AS common_attempt_protected_owner,
  (SELECT member_count=0 OR (member_count=1 AND exact_creator_membership)
   FROM inbound_state) AS restricted_attempt_inbound_membership,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid IN (SELECT oid FROM funcs) AND a.privilege_type='EXECUTE'
      AND a.grantee <> p.proowner
      AND a.grantee <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
  ) AS exclusive_attempt_function_acl,
  pg_catalog.has_function_privilege(current_user,
    'public.start_scrvusd_now_arm(text,text,integer,text,text,timestamptz,text)','EXECUTE') AS can_start,
  pg_catalog.has_function_privilege(current_user,
    'public.confirm_scrvusd_now_starts(text,text)','EXECUTE') AS can_confirm_starts,
  pg_catalog.has_function_privilege(current_user,
    'public.mark_scrvusd_now_capture_floor(text,text)','EXECUTE') AS can_mark_floor,
  pg_catalog.has_function_privilege(current_user,
    'public.result_scrvusd_now_arm(text,text,integer,text,text,text,text,timestamptz,text)','EXECUTE') AS can_result,
  pg_catalog.has_function_privilege(current_user,
    'public.confirm_scrvusd_now_run(text,text)','EXECUTE') AS can_confirm_run`

export function scheduleAttemptAuditPass(row) {
  return Boolean(
    row &&
    [
      'direct_attempt_login_role',
      'ordinary_attempt_role',
      'no_attempt_create',
      'no_attempt_direct_write',
      'can_read_attempts',
      'no_attempt_owner_membership',
      'no_attempt_function_owner_membership',
      'common_attempt_protected_owner',
      'restricted_attempt_inbound_membership',
      'exclusive_attempt_function_acl',
      'can_start',
      'can_confirm_starts',
      'can_mark_floor',
      'can_result',
      'can_confirm_run',
    ].every((key) => row[key] === true),
  )
}

export const SCRVUSD_SCHEDULE_ASOF_AUDIT_SQL = `WITH role_state AS (
  SELECT r.oid,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user
), protected AS (
  SELECT x.rel::regclass AS rel FROM pg_catalog.unnest(ARRAY[
    'public.scrvusd_now_source_starts'::regclass,
    'public.scrvusd_now_run_visibility'::regclass,
    'public.scrvusd_now_scores'::regclass,
    'public.scrvusd_now_score_visibility'::regclass
  ]) x(rel)
), funcs AS (
  SELECT x.signature::regprocedure AS oid FROM pg_catalog.unnest(ARRAY[
    'public.start_scrvusd_now_source(text,text,text)',
    'public.witness_scrvusd_now_run(text,text)',
    'public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text)',
    'public.witness_scrvusd_now_score(text,text,integer)'
  ]) x(signature)
), ${OWNER_AND_MEMBERSHIP_CTES}
SELECT current_user AS role_name,
  session_user=current_user AS direct_asof_login_role,
  (SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
   FROM role_state) AS ordinary_asof_role,
  NOT pg_catalog.has_schema_privilege(current_user,'public','CREATE')
    AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') AS no_asof_create,
  (SELECT pg_catalog.bool_and(
    NOT pg_catalog.has_table_privilege(current_user,rel,'INSERT')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'INSERT')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'UPDATE')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'UPDATE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'DELETE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'REFERENCES')
    AND NOT pg_catalog.has_any_column_privilege(current_user,rel,'REFERENCES')
    AND NOT pg_catalog.has_table_privilege(current_user,rel,'TRIGGER')
  ) FROM protected) AS no_asof_direct_write,
  (SELECT pg_catalog.bool_and(pg_catalog.has_table_privilege(current_user,rel,'SELECT'))
   FROM protected) AS can_read_asof,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER'))
   FROM pg_catalog.pg_class c WHERE c.oid IN (SELECT rel FROM protected)) AS no_asof_table_owner_membership,
  (SELECT pg_catalog.bool_and(NOT pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER'))
   FROM pg_catalog.pg_proc p WHERE p.oid IN (SELECT oid FROM funcs)) AS no_asof_function_owner_membership,
  (SELECT object_count=24 AND owner_count=1 FROM owner_state) AS common_asof_protected_owner,
  (SELECT member_count=0 OR (member_count=1 AND exact_creator_membership)
   FROM inbound_state) AS restricted_asof_inbound_membership,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid IN (SELECT oid FROM funcs) AND a.privilege_type='EXECUTE'
      AND a.grantee <> p.proowner
      AND a.grantee <> (SELECT oid FROM role_state)
  ) AS exclusive_asof_function_acl,
  pg_catalog.has_function_privilege(current_user,
    'public.start_scrvusd_now_source(text,text,text)','EXECUTE') AS can_start_source,
  pg_catalog.has_function_privilege(current_user,
    'public.witness_scrvusd_now_run(text,text)','EXECUTE') AS can_witness_run,
  pg_catalog.has_function_privilege(current_user,
    'public.record_scrvusd_now_score(text,text,integer,text,text,text,text,text,text)','EXECUTE') AS can_record_score,
  pg_catalog.has_function_privilege(current_user,
    'public.witness_scrvusd_now_score(text,text,integer)','EXECUTE') AS can_witness_score`

export function scheduleAsOfAuditPass(row) {
  return Boolean(
    row &&
    [
      'direct_asof_login_role',
      'ordinary_asof_role',
      'no_asof_create',
      'no_asof_direct_write',
      'can_read_asof',
      'no_asof_table_owner_membership',
      'no_asof_function_owner_membership',
      'common_asof_protected_owner',
      'restricted_asof_inbound_membership',
      'exclusive_asof_function_acl',
      'can_start_source',
      'can_witness_run',
      'can_record_score',
      'can_witness_score',
    ].every((key) => row[key] === true),
  )
}

async function main() {
  const mode = process.argv[2]
  if (
    ![
      '--apply',
      '--apply-attempts',
      '--apply-asof',
      '--audit-publisher',
      '--audit-attempts',
      '--audit-asof',
    ].includes(mode) ||
    process.argv.length !== 3
  )
    throw new Error(
      'Usage: apply-scrvusd-now-schedule-ddl.mjs --apply|--apply-attempts|--apply-asof|--audit-publisher|--audit-attempts|--audit-asof',
    )
  const key = mode.startsWith('--apply')
    ? 'SCRVUSD_SCHEDULE_MIGRATION_DATABASE_URL'
    : 'SCRVUSD_SCHEDULE_PUBLISHER_DATABASE_URL'
  const url = process.env[key]
  if (!url) throw new Error(`${key} is required`)
  const sql = neon(url)
  if (mode.startsWith('--apply')) {
    const guard =
      mode === '--apply'
        ? schedulePreflightSql(process.env.SCRVUSD_SCHEDULE_PUBLISHER_ROLE)
        : mode === '--apply-attempts'
          ? scheduleAttemptPreflightSql(process.env.SCRVUSD_SCHEDULE_PUBLISHER_ROLE)
          : scheduleAsOfPreflightSql(process.env.SCRVUSD_SCHEDULE_PUBLISHER_ROLE)
    await sql.transaction([
      sql.query(guard),
      ...(mode === '--apply'
        ? SCRVUSD_SCHEDULE_MIGRATION_SQL
        : mode === '--apply-attempts'
          ? SCRVUSD_SCHEDULE_ATTEMPT_MIGRATION_SQL
          : SCRVUSD_SCHEDULE_ASOF_MIGRATION_SQL
      ).map((s) => sql.query(s)),
    ])
    console.log(
      'scrvUSD schedule boundary installed; provision explicit SELECT and function EXECUTE grants',
    )
    return
  }
  const rows = await sql.query(
    mode === '--audit-publisher'
      ? SCRVUSD_SCHEDULE_AUDIT_SQL
      : mode === '--audit-attempts'
        ? SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL
        : SCRVUSD_SCHEDULE_ASOF_AUDIT_SQL,
  )
  const passed =
    mode === '--audit-publisher'
      ? scheduleAuditPass(rows[0])
      : mode === '--audit-attempts'
        ? scheduleAttemptAuditPass(rows[0])
        : scheduleAsOfAuditPass(rows[0])
  console.log(JSON.stringify({ role: rows[0]?.role_name ?? null, passed }))
  if (!passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      error.message?.endsWith('is required')
        ? error.message
        : 'scrvUSD schedule migration/audit failed',
    )
    process.exitCode = 1
  })
