// Additive and dormant v2 issue/score ledger. Run only after the v2 recorder
// migration. This module does not grant a runtime role or touch the v1 study.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

export const V2_ISSUE_SCORE_DDL = [
  `DO $$ BEGIN
     IF to_regclass('public.aave_usde_v2_issue_schedules') IS NULL
       OR to_regclass('public.aave_usde_v2_schedule_confirmations') IS NULL
       OR to_regprocedure('public.digest(bytea,text)') IS NULL THEN
       RAISE EXCEPTION 'v2 issue/score ledger requires the v2 recorder migration';
     END IF;
   END; $$`,
  `CREATE TABLE public.aave_usde_v2_issue_starts (
     schedule_sha256 text NOT NULL REFERENCES public.aave_usde_v2_issue_schedules(sha256),
     slot_id text NOT NULL, amount_usd bigint NOT NULL,
     horizon_seconds integer NOT NULL,
     started_at timestamptz NOT NULL, starter_xid bigint NOT NULL,
     PRIMARY KEY (schedule_sha256,slot_id,amount_usd,horizon_seconds),
     CHECK (amount_usd IN (1000000,10000000,50000000)),
     CHECK (horizon_seconds IN (28800,86400,604800))
   )`,
  `CREATE TABLE public.aave_usde_v2_issue_terminals (
     schedule_sha256 text NOT NULL, slot_id text NOT NULL,
     amount_usd bigint NOT NULL, horizon_seconds integer NOT NULL,
     status text NOT NULL CHECK (status IN ('issued','abstained','failed')),
     reason text, anchor_id uuid REFERENCES public.venue_snapshots(id),
     issue_sha256 text UNIQUE,
     payload text, physical_sha256 text UNIQUE,
     recorded_at timestamptz NOT NULL, terminal_xid bigint NOT NULL,
     timely boolean NOT NULL,
     PRIMARY KEY (schedule_sha256,slot_id,amount_usd,horizon_seconds),
     FOREIGN KEY (schedule_sha256,slot_id,amount_usd,horizon_seconds)
       REFERENCES public.aave_usde_v2_issue_starts
       (schedule_sha256,slot_id,amount_usd,horizon_seconds),
     CHECK ((status='issued' AND reason IS NULL AND anchor_id IS NOT NULL AND payload IS NOT NULL
       AND issue_sha256 ~ '^[0-9a-f]{64}$' AND physical_sha256 ~ '^[0-9a-f]{64}$')
       OR (status<>'issued' AND reason IS NOT NULL AND length(reason)>0
       AND anchor_id IS NULL AND payload IS NULL
       AND issue_sha256 IS NULL AND physical_sha256 IS NULL))
   )`,
  `CREATE TABLE public.aave_usde_v2_issue_collisions (
     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     schedule_sha256 text NOT NULL, slot_id text NOT NULL,
     amount_usd bigint NOT NULL, horizon_seconds integer NOT NULL,
     issue_sha256 text NOT NULL REFERENCES public.aave_usde_v2_issue_terminals(issue_sha256),
     reason text NOT NULL CHECK (length(reason)>0),
     recorded_at timestamptz NOT NULL, recorder_xid bigint NOT NULL,
     timely boolean NOT NULL,
     FOREIGN KEY (schedule_sha256,slot_id,amount_usd,horizon_seconds)
       REFERENCES public.aave_usde_v2_issue_starts
       (schedule_sha256,slot_id,amount_usd,horizon_seconds)
   )`,
  `CREATE TABLE public.aave_usde_v2_score_receipts (
     issue_sha256 text PRIMARY KEY REFERENCES public.aave_usde_v2_issue_terminals(issue_sha256),
     status text NOT NULL CHECK (status IN ('observed','censored')),
     payload text NOT NULL, score_sha256 text NOT NULL UNIQUE
       CHECK (score_sha256 ~ '^[0-9a-f]{64}$'),
     physical_sha256 text NOT NULL UNIQUE
       CHECK (physical_sha256 ~ '^[0-9a-f]{64}$'),
     source_as_of timestamptz NOT NULL,
     scored_at timestamptz NOT NULL,
     persisted_at timestamptz NOT NULL,
     scorer_xid bigint NOT NULL
   )`,
  ...[
    'aave_usde_v2_issue_starts',
    'aave_usde_v2_issue_terminals',
    'aave_usde_v2_issue_collisions',
    'aave_usde_v2_score_receipts',
  ].map(
    (table) => `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.reject_aave_usde_v2_ledger_mutation()`,
  ),
]

export const V2_ISSUE_SCORE_FUNCTIONS = [
  // One statement precommits every fixed-grid arm. A later transaction is
  // required for each terminal, so the caller can do source work in between.
  `CREATE FUNCTION public.start_aave_usde_v2_issue_slot(p_schedule text,p_slot text)
   RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE s public.aave_usde_v2_issue_schedules%ROWTYPE;
     v_slot jsonb; v_now timestamptz:=clock_timestamp(); v_count integer;
   BEGIN
     SELECT * INTO s FROM public.aave_usde_v2_issue_schedules WHERE sha256=p_schedule;
     IF NOT FOUND OR NOT EXISTS(
       SELECT 1 FROM public.aave_usde_v2_schedule_confirmations c
       WHERE c.sha256=p_schedule AND c.confirmer_xid<>txid_current()
         AND c.confirmed_at<v_now) THEN
       RAISE EXCEPTION 'issue schedule not separately confirmed'; END IF;
     SELECT x INTO v_slot FROM jsonb_array_elements((s.payload::jsonb)->'slots') x
       WHERE x->>'slotId'=p_slot;
     IF v_slot IS NULL OR v_now<(v_slot->>'scheduledAt')::timestamptz
       OR v_now>=(v_slot->>'closesAt')::timestamptz THEN
       RAISE EXCEPTION 'issue slot not current'; END IF;
     INSERT INTO public.aave_usde_v2_issue_starts
       (schedule_sha256,slot_id,amount_usd,horizon_seconds,started_at,starter_xid)
       SELECT p_schedule,p_slot,(arm->>'amountUsd')::bigint,
         (arm->>'horizonSeconds')::integer,v_now,txid_current()
       FROM jsonb_array_elements(v_slot->'arms') arm;
     GET DIAGNOSTICS v_count=ROW_COUNT;
     IF v_count<>9 THEN RAISE EXCEPTION 'issue slot must start exactly nine arms'; END IF;
     RETURN v_count;
   END; $$`,
  `CREATE FUNCTION public.finish_aave_usde_v2_issue_cell(
     p_schedule text,p_slot text,p_amount bigint,p_horizon integer,
     p_status text,p_reason text,p_payload text)
   RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE st public.aave_usde_v2_issue_starts%ROWTYPE;
     j jsonb; v_now timestamptz:=clock_timestamp();
     v_issue text; v_physical text; v_issue_at timestamptz; v_suffix text;
     v_slot jsonb; s public.aave_usde_v2_issue_schedules%ROWTYPE;
     v_anchor uuid; a public.venue_snapshots%ROWTYPE; v_timely boolean;
   BEGIN
     SELECT * INTO st FROM public.aave_usde_v2_issue_starts
       WHERE schedule_sha256=p_schedule AND slot_id=p_slot
         AND amount_usd=p_amount AND horizon_seconds=p_horizon;
     IF NOT FOUND OR st.starter_xid=txid_current() OR v_now<=st.started_at
       OR p_status IS NULL OR p_status NOT IN ('issued','abstained','failed') THEN
       RAISE EXCEPTION 'issue cell has no separately committed start'; END IF;
     SELECT * INTO s FROM public.aave_usde_v2_issue_schedules WHERE sha256=p_schedule;
     SELECT x INTO v_slot FROM jsonb_array_elements((s.payload::jsonb)->'slots') x
       WHERE x->>'slotId'=p_slot;
     IF v_slot IS NULL THEN RAISE EXCEPTION 'issue cell absent from schedule'; END IF;
     v_timely:=v_now>=(v_slot->>'scheduledAt')::timestamptz
       AND v_now<(v_slot->>'closesAt')::timestamptz;
     IF p_status='issued' THEN
       IF p_payload IS NULL OR p_reason IS NOT NULL THEN
         RAISE EXCEPTION 'issued cell requires payload without reason'; END IF;
       j:=p_payload::jsonb;
       v_issue_at:=(j->>'issuedAt')::timestamptz;
       IF v_slot IS NULL OR j->>'sha256' IS NULL
         OR j->>'sourceIssueSha256' IS NULL OR j->>'targetAt' IS NULL
         OR j->>'anchorAgeAtIssueSeconds' IS NULL
         OR j->'anchor'->>'id' IS NULL
         OR j->'anchor'->>'cashUsdAssumingPeg' IS NULL
         OR j->>'amountUsd' IS NULL OR j->>'horizonSeconds' IS NULL
         OR j->>'study' IS DISTINCT FROM 'aave-v3-usde-first-sampled-cash-breach-by-h-v2'
         OR j->>'status' IS DISTINCT FROM 'issued'
         OR j->>'scoreClass' IS DISTINCT FROM 'fixed_grid'
         OR j->>'claim' IS DISTINCT FROM 'first_locally_sampled_reserve_cash_breach_only'
         OR j->>'sourceProtocol' IS DISTINCT FROM 'aave-v3-usde-prospective-sampled-cash-v1'
         OR (j->>'amountUsd')::bigint IS DISTINCT FROM p_amount
         OR (j->>'horizonSeconds')::integer IS DISTINCT FROM p_horizon
         OR v_issue_at IS NULL
         OR v_issue_at<date_trunc('milliseconds',st.started_at)
         OR v_issue_at<(v_slot->>'scheduledAt')::timestamptz
         OR v_issue_at>=(v_slot->>'closesAt')::timestamptz
         OR NOT v_timely
         OR v_issue_at>v_now
         OR (j->>'targetAt')::timestamptz IS DISTINCT FROM v_issue_at+p_horizon*interval '1 second'
         OR (j->>'anchorAgeAtIssueSeconds')::numeric<0
         OR (j->>'anchorAgeAtIssueSeconds')::numeric>600
         OR (j->'anchor'->>'cashUsdAssumingPeg')::numeric<p_amount
         OR j->>'sourceIssueSha256' !~ '^[0-9a-f]{64}$'
         OR j->>'sha256' !~ '^[0-9a-f]{64}$' THEN
         RAISE EXCEPTION 'invalid fixed-grid issue payload'; END IF;
       v_anchor:=(j->'anchor'->>'id')::uuid;
       SELECT * INTO a FROM public.venue_snapshots WHERE id=v_anchor;
       IF NOT FOUND OR a.venue IS DISTINCT FROM 'aave-v3-usde'
         OR a.chain IS DISTINCT FROM 'ethereum' OR a.source IS DISTINCT FROM 'observed'
         OR a.recorder_atomic_v1 IS DISTINCT FROM TRUE
         OR a.params->>'read_block_pinned' IS DISTINCT FROM 'true'
         OR a.params->>'read_block_finalized' IS DISTINCT FROM 'true'
         OR a.params->>'read_block_number' IS DISTINCT FROM a.block::text
         OR a.params->>'underlyingIdentity' IS DISTINCT FROM 'match'
         OR a.params->>'decimalsIdentity' IS DISTINCT FROM 'match'
         OR a.params->>'decimals' IS DISTINCT FROM '18'
         OR a.params->'reads'->>'underlyingBalance' IS DISTINCT FROM 'true'
         OR date_trunc('milliseconds',a.observed_at)>v_issue_at
         OR date_trunc('milliseconds',a.created_at)>v_issue_at
         OR floor(extract(epoch FROM a.observed_at)*1000)/1000 IS DISTINCT FROM
           (j->'anchor'->>'firstLocalObservedAt')::numeric
         OR abs(extract(epoch FROM v_issue_at)
           -floor(extract(epoch FROM a.observed_at)*1000)/1000
           -(j->>'anchorAgeAtIssueSeconds')::numeric)>0.001::numeric
         OR a.block IS DISTINCT FROM (j->'anchor'->>'block')::bigint
         OR lower(a.params->>'read_block_hash') IS DISTINCT FROM j->'anchor'->>'blockHash'
         OR a.params->>'underlyingBalance' IS DISTINCT FROM j->'anchor'->>'cashRaw'
         OR (a.params->>'underlyingBalance')::numeric < p_amount*1000000000000000000::numeric
         OR abs((j->'anchor'->>'cashUsdAssumingPeg')::numeric
           -(a.params->>'underlyingBalance')::numeric/1000000000000000000::numeric)
           > greatest(0.000001::numeric,
             (a.params->>'underlyingBalance')::numeric/1000000000000000000::numeric*0.000000000001::numeric)
         OR a.instant_usd IS NULL
         OR abs(a.instant_usd-(a.params->>'underlyingBalance')::numeric/1000000000000000000::numeric)
           > greatest(0.000001::numeric,
             (a.params->>'underlyingBalance')::numeric/1000000000000000000::numeric*0.000000000001::numeric)
         OR v_issue_at-a.observed_at>interval '10 minutes' THEN
         RAISE EXCEPTION 'issue anchor does not match marked observed snapshot'; END IF;
       IF EXISTS(SELECT 1 FROM public.venue_snapshots newer
         WHERE newer.venue='aave-v3-usde' AND newer.chain='ethereum'
           AND newer.source='observed'
           AND date_trunc('milliseconds',newer.created_at)<=v_issue_at
           AND date_trunc('milliseconds',newer.observed_at)<=v_issue_at
           AND newer.id<>a.id
           AND newer.observed_at>=a.observed_at) THEN
         RAISE EXCEPTION 'issue anchor is not latest locally available observation'; END IF;
       v_issue:=j->>'sha256';
       v_suffix:=',"sha256":"'||v_issue||'"}';
       IF right(p_payload,length(v_suffix)) IS DISTINCT FROM v_suffix THEN
         RAISE EXCEPTION 'issue payload lacks canonical trailing seal'; END IF;
       IF encode(public.digest(convert_to(
         left(p_payload,length(p_payload)-length(v_suffix))||'}','UTF8'),'sha256'),'hex')
         IS DISTINCT FROM v_issue THEN
         RAISE EXCEPTION 'issue logical seal does not match payload'; END IF;
       v_physical:=encode(public.digest(convert_to(p_payload,'UTF8'),'sha256'),'hex');
     ELSE
       IF p_payload IS NOT NULL OR p_reason IS NULL OR length(p_reason)=0 THEN
         RAISE EXCEPTION 'nonissued cell requires reason without payload'; END IF;
     END IF;
     INSERT INTO public.aave_usde_v2_issue_terminals
       (schedule_sha256,slot_id,amount_usd,horizon_seconds,status,reason,anchor_id,
        issue_sha256,payload,physical_sha256,recorded_at,terminal_xid,timely)
       VALUES(p_schedule,p_slot,p_amount,p_horizon,p_status,p_reason,v_anchor,
         v_issue,p_payload,v_physical,v_now,txid_current(),v_timely);
     RETURN v_issue;
   END; $$`,
  `CREATE FUNCTION public.record_aave_usde_v2_issue_collision(
     p_schedule text,p_slot text,p_amount bigint,p_horizon integer,
     p_issue text,p_reason text)
   RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE t public.aave_usde_v2_issue_terminals%ROWTYPE;
     v_now timestamptz:=clock_timestamp(); v_id bigint; v_slot jsonb;
   BEGIN
     SELECT * INTO t FROM public.aave_usde_v2_issue_terminals
       WHERE schedule_sha256=p_schedule AND slot_id=p_slot
         AND amount_usd=p_amount AND horizon_seconds=p_horizon
         AND status='issued' AND issue_sha256=p_issue;
     IF NOT FOUND OR t.terminal_xid=txid_current() OR v_now<=t.recorded_at
       OR p_reason IS NULL OR length(p_reason)=0 THEN
       RAISE EXCEPTION 'collision requires a separately committed issued cell'; END IF;
     SELECT x INTO v_slot FROM public.aave_usde_v2_issue_schedules s,
       jsonb_array_elements((s.payload::jsonb)->'slots') x
       WHERE s.sha256=p_schedule AND x->>'slotId'=p_slot;
     IF v_slot IS NULL THEN RAISE EXCEPTION 'collision slot absent from schedule'; END IF;
     INSERT INTO public.aave_usde_v2_issue_collisions
       (schedule_sha256,slot_id,amount_usd,horizon_seconds,issue_sha256,
        reason,recorded_at,recorder_xid,timely)
       VALUES(p_schedule,p_slot,p_amount,p_horizon,p_issue,p_reason,v_now,txid_current(),
         v_now<(v_slot->>'closesAt')::timestamptz)
       RETURNING id INTO v_id;
     RETURN v_id;
   END; $$`,
  `CREATE FUNCTION public.insert_aave_usde_v2_score(p_issue text,p_payload text)
   RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
   DECLARE i public.aave_usde_v2_issue_terminals%ROWTYPE;
     j jsonb; v_now timestamptz:=clock_timestamp();
     v_target timestamptz; v_cutoff timestamptz; v_score text; v_suffix text;
   BEGIN
     SELECT * INTO i FROM public.aave_usde_v2_issue_terminals
       WHERE issue_sha256=p_issue AND status='issued';
     IF NOT FOUND OR i.terminal_xid=txid_current() OR p_payload IS NULL THEN
       RAISE EXCEPTION 'score requires committed issued receipt'; END IF;
     v_target:=(i.payload::jsonb->>'targetAt')::timestamptz;
     v_cutoff:=v_target+interval '8 hours 120 seconds';
     IF v_now<v_cutoff THEN RAISE EXCEPTION 'fixed score cutoff still open'; END IF;
     j:=p_payload::jsonb;
     IF j->>'sha256' IS NULL OR j->>'sourceAsOf' IS NULL
       OR j->>'outcomeWindowClosesAt' IS NULL
       OR j->>'observationWindowClosesAt' IS NULL
       OR j->>'scoredAt' IS NULL OR j->>'targetAt' IS NULL
       OR j->>'amountUsd' IS NULL OR j->>'horizonSeconds' IS NULL
       OR j->>'study' IS DISTINCT FROM 'aave-v3-usde-first-sampled-cash-breach-by-h-v2'
       OR j->>'issueSha256' IS DISTINCT FROM p_issue
       OR j->>'sourceIssueSha256' IS DISTINCT FROM (i.payload::jsonb)->>'sourceIssueSha256'
       OR j->>'status' IS NULL OR j->>'status' NOT IN ('observed','censored')
       OR j->>'claim' IS DISTINCT FROM 'first_locally_sampled_reserve_cash_breach_only'
       OR j->>'sourceCompleteness' IS DISTINCT FROM 'caller_unverified'
       OR j->>'prospectiveEligible' IS DISTINCT FROM 'false'
       OR (j->>'amountUsd')::bigint IS DISTINCT FROM i.amount_usd
       OR (j->>'horizonSeconds')::integer IS DISTINCT FROM i.horizon_seconds
       OR (j->>'targetAt')::timestamptz IS DISTINCT FROM v_target
       OR (j->>'sourceAsOf')::timestamptz IS DISTINCT FROM v_cutoff
       OR (j->>'outcomeWindowClosesAt')::timestamptz IS DISTINCT FROM v_cutoff
       OR (j->>'observationWindowClosesAt')::timestamptz IS DISTINCT FROM v_target+interval '8 hours'
       OR (j->>'scoredAt')::timestamptz<v_cutoff
       OR (j->>'scoredAt')::timestamptz>v_now
       OR j->>'sha256' !~ '^[0-9a-f]{64}$' THEN
       RAISE EXCEPTION 'invalid final score payload'; END IF;
     v_score:=j->>'sha256';
     v_suffix:=',"sha256":"'||v_score||'"}';
     IF right(p_payload,length(v_suffix)) IS DISTINCT FROM v_suffix THEN
       RAISE EXCEPTION 'score payload lacks canonical trailing seal'; END IF;
     IF encode(public.digest(convert_to(
       left(p_payload,length(p_payload)-length(v_suffix))||'}','UTF8'),'sha256'),'hex')
       IS DISTINCT FROM v_score THEN
       RAISE EXCEPTION 'score logical seal does not match payload'; END IF;
     INSERT INTO public.aave_usde_v2_score_receipts
       (issue_sha256,status,payload,score_sha256,physical_sha256,source_as_of,
        scored_at,persisted_at,scorer_xid)
       VALUES(p_issue,j->>'status',p_payload,v_score,
         encode(public.digest(convert_to(p_payload,'UTF8'),'sha256'),'hex'),
         v_cutoff,(j->>'scoredAt')::timestamptz,v_now,txid_current());
     RETURN v_score;
   END; $$`,
]

export const V2_ISSUE_SCORE_ACL = [
  ...[
    'aave_usde_v2_issue_starts',
    'aave_usde_v2_issue_terminals',
    'aave_usde_v2_issue_collisions',
    'aave_usde_v2_score_receipts',
  ].map((table) => `REVOKE ALL ON TABLE public.${table} FROM PUBLIC`),
  `REVOKE ALL ON FUNCTION public.start_aave_usde_v2_issue_slot(text,text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.finish_aave_usde_v2_issue_cell(text,text,bigint,integer,text,text,text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.record_aave_usde_v2_issue_collision(text,text,bigint,integer,text,text) FROM PUBLIC`,
  `REVOKE ALL ON FUNCTION public.insert_aave_usde_v2_score(text,text) FROM PUBLIC`,
]

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply')
    throw new Error('Usage: apply-aave-usde-v2-issue-score-ddl.mjs --apply')
  const url = process.env.AAVE_USDE_V2_ISSUE_SCORE_MIGRATION_DATABASE_URL
  if (!url) throw new Error('Dedicated issue/score migration database URL required')
  const sql = neon(url)
  await sql.transaction(
    [...V2_ISSUE_SCORE_DDL, ...V2_ISSUE_SCORE_FUNCTIONS, ...V2_ISSUE_SCORE_ACL].map((s) =>
      sql.query(s),
    ),
  )
  console.log('Aave USDe v2 issue/score ledger installed; runtime grants remain separate')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
