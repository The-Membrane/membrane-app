import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  SCRVUSD_SCHEDULE_AUDIT_SQL,
  SCRVUSD_SCHEDULE_MIGRATION_SQL,
  SCRVUSD_SCHEDULE_ATTEMPT_MIGRATION_SQL,
  SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL,
  SCRVUSD_SCHEDULE_ASOF_AUDIT_SQL,
  SCRVUSD_SCHEDULE_ASOF_MIGRATION_SQL,
  scheduleAuditPass,
  scheduleAttemptAuditPass,
  scheduleAsOfAuditPass,
  schedulePreflightSql,
  scheduleAttemptPreflightSql,
  scheduleAsOfPreflightSql,
} from './apply-scrvusd-now-schedule-ddl.mjs'

const joined = SCRVUSD_SCHEDULE_MIGRATION_SQL.join('\n')

test('first install is an additive atomic batch with independent overlap constraint', () => {
  assert.match(joined, /CREATE TABLE public\.scrvusd_now_manifests/)
  assert.match(joined, /EXCLUDE USING gist\s+\(tstzrange\(start_at,end_at,'\[\)'\) WITH &&\)/)
  assert.match(joined, /scrvusd_now_manifest_confirmations/)
  assert.match(joined, /CREATE TABLE public\.scrvusd_now_manifest_visibility/)
  assert.match(joined, /SECURITY DEFINER SET search_path = pg_catalog/g)
  assert.match(joined, /REVOKE ALL ON FUNCTION public\.publish_scrvusd_now_manifest/)
  assert.match(joined, /REVOKE ALL ON FUNCTION public\.confirm_scrvusd_now_manifest/)
  assert.match(joined, /REVOKE ALL ON FUNCTION public\.witness_scrvusd_now_manifest/)
  assert.doesNotMatch(joined, /\bCREATE ROLE\b|\bGRANT\b/)
  assert.match(schedulePreflightSql('scrvusd_schedule_publisher'), /to_regrole/)
  assert.match(
    schedulePreflightSql('scrvusd_schedule_publisher'),
    /migration login must differ from scrvUSD publisher role/,
  )
  assert.match(schedulePreflightSql('scrvusd_schedule_publisher'), /inbound members/)
  assert.match(
    schedulePreflightSql('scrvusd_schedule_publisher'),
    /pg_catalog\.count\(\*\).*pg_catalog\.pg_auth_members/s,
  )
  assert.match(
    schedulePreflightSql('scrvusd_schedule_publisher'),
    /am\.member<>pg_catalog\.to_regrole\(current_user\)::oid/,
  )
  assert.match(
    schedulePreflightSql('scrvusd_schedule_publisher'),
    /NOT am\.admin_option OR am\.inherit_option OR am\.set_option/,
  )
  assert.throws(() => schedulePreflightSql("role'; DROP TABLE x; --"))
})

test('manifest publisher checks exact SHA bytes, fixed scope, server clock and overlap', () => {
  const sql = SCRVUSD_SCHEDULE_MIGRATION_SQL.find((statement) =>
    statement.startsWith('CREATE FUNCTION public.publish_scrvusd_now_manifest'),
  )
  assert.match(sql, /public\.digest\(pg_catalog\.convert_to\(p_unsigned_text,'UTF8'\),'sha256'\)/)
  assert.match(sql, /p_payload_text IS DISTINCT FROM/)
  assert.match(sql, /v_unsigned IS DISTINCT FROM \(v_body - 'sha256'\)/)
  assert.match(sql, /qAssetsRaw/)
  assert.match(sql, /\[3600,7200,86400,604800\]/)
  assert.match(sql, /pg_catalog\.clock_timestamp\(\)/)
  assert.match(sql, /v_start < v_now \+ interval '2 hours'/)
  assert.match(sql, /v_count > 336/)
  assert.match(sql, /v_body->>'plannedAtUtc' IS DISTINCT FROM/)
  assert.match(sql, /v_body->>'startAtUtc' IS DISTINCT FROM/)
  assert.match(sql, /v_body->>'endAtUtc' IS DISTINCT FROM/)
  assert.match(sql, /v_canonical_slots := v_canonical_slots/)
  assert.match(sql, /"slotId":"%s","scheduledAtUtc":"%s","closesAtUtc":"%s"/)
  assert.match(sql, /v_canonical_unsigned := pg_catalog\.format/)
  assert.match(sql, /p_unsigned_text IS DISTINCT FROM v_canonical_unsigned/)
  assert.match(sql, /pg_catalog\.pg_advisory_xact_lock/)
  assert.match(sql, /duplicate or overlapping scrvUSD schedule/)
  assert.match(sql, /pg_catalog\.txid_current\(\)/)
})

test('confirmation requires visible committed manifest, distinct XID and lead time', () => {
  const sql = SCRVUSD_SCHEDULE_MIGRATION_SQL.find((statement) =>
    statement.startsWith('CREATE FUNCTION public.confirm_scrvusd_now_manifest'),
  )
  assert.match(sql, /FROM public\.scrvusd_now_manifests m/)
  assert.match(sql, /v_xid = v_manifest\.publisher_xid/)
  assert.match(sql, /v_now > v_manifest\.start_at - interval '2 hours'/)
  assert.match(sql, /ON CONFLICT \(manifest_sha256\) DO NOTHING/)
})

test('manifest witness requires committed confirmation, separate XID and two-hour lead; replay is exact', () => {
  const sql = SCRVUSD_SCHEDULE_MIGRATION_SQL.find((statement) =>
    statement.startsWith('CREATE FUNCTION public.witness_scrvusd_now_manifest'),
  )
  assert.match(sql, /FROM public\.scrvusd_now_manifests m/)
  assert.match(sql, /FROM public\.scrvusd_now_manifest_confirmations c/)
  assert.match(sql, /v_xid IN \(v_manifest\.publisher_xid,v_confirm\.confirmer_xid\)/)
  assert.match(sql, /v_now>v_manifest\.start_at-interval '2 hours'/)
  assert.match(sql, /SELECT \* INTO v_prior FROM public\.scrvusd_now_manifest_visibility/)
  assert.match(sql, /IF FOUND THEN[\s\S]*RETURN NEXT; RETURN;/)
  assert.match(sql, /INSERT INTO public\.scrvusd_now_manifest_visibility/)
  assert.match(sql, /conflicting manifest visibility witness/)
})

test('publisher audit rejects write privileges, ownership and broad function access', () => {
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /has_any_column_privilege\(current_user,rel,'INSERT'\)/)
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /pg_catalog\.pg_has_role/)
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /pg_catalog\.aclexplode/)
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /pg_catalog\.pg_auth_members am/)
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /session_user=current_user/)
  const keys = [
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
  ]
  const good = Object.fromEntries(keys.map((key) => [key, true]))
  assert.equal(scheduleAuditPass(good), true)
  for (const key of keys) assert.equal(scheduleAuditPass({ ...good, [key]: false }), false)
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /object_count IN \(6,16,24\) AND owner_count=1/)
  assert.match(
    SCRVUSD_SCHEDULE_AUDIT_SQL,
    /member_count=0 OR \(member_count=1 AND exact_creator_membership\)/,
  )
  assert.match(
    SCRVUSD_SCHEDULE_AUDIT_SQL,
    /am\.admin_option AND NOT am\.inherit_option AND NOT am\.set_option/,
  )
})

test('base audit includes installed attempt objects in write and function-grant checks', () => {
  const targets = SCRVUSD_SCHEDULE_AUDIT_SQL.slice(
    SCRVUSD_SCHEDULE_AUDIT_SQL.indexOf('protected AS ('),
    SCRVUSD_SCHEDULE_AUDIT_SQL.indexOf('owner_objects AS ('),
  )
  for (const name of [
    'scrvusd_now_manifests',
    'scrvusd_now_manifest_confirmations',
    'scrvusd_now_manifest_visibility',
    'scrvusd_now_arm_starts',
    'scrvusd_now_start_confirmations',
    'scrvusd_now_capture_floors',
    'scrvusd_now_arm_results',
    'scrvusd_now_run_confirmations',
  ])
    assert.match(targets, new RegExp(`to_regclass\\('public\\.${name}'\\)`))
  for (const name of [
    'publish_scrvusd_now_manifest',
    'confirm_scrvusd_now_manifest',
    'witness_scrvusd_now_manifest',
    'start_scrvusd_now_arm',
    'confirm_scrvusd_now_starts',
    'mark_scrvusd_now_capture_floor',
    'result_scrvusd_now_arm',
    'confirm_scrvusd_now_run',
  ])
    assert.match(targets, new RegExp(`to_regprocedure\\('public\\.${name}\\(`))
  assert.match(targets, /WHERE x\.rel IS NOT NULL/)
  assert.match(targets, /WHERE x\.signature IS NOT NULL/)
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /FROM protected\) AS no_direct_write/)
  assert.match(
    SCRVUSD_SCHEDULE_AUDIT_SQL,
    /p\.oid IN \(SELECT oid FROM funcs\).*exclusive_function_acl/s,
  )
})

test('CLI cannot connect without dedicated credentials', () => {
  const path = new URL('./apply-scrvusd-now-schedule-ddl.mjs', import.meta.url).pathname
  for (const mode of [
    '--apply',
    '--apply-attempts',
    '--apply-asof',
    '--audit-publisher',
    '--audit-attempts',
    '--audit-asof',
  ]) {
    const env = { ...process.env }
    delete env.SCRVUSD_SCHEDULE_MIGRATION_DATABASE_URL
    delete env.SCRVUSD_SCHEDULE_PUBLISHER_DATABASE_URL
    const run = spawnSync(process.execPath, [path, mode], { env, encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /is required/)
  }
})

test('additive attempt migration is guarded and records full exact start and issue bytes', () => {
  const sql = SCRVUSD_SCHEDULE_ATTEMPT_MIGRATION_SQL.join('\n')
  assert.match(
    scheduleAttemptPreflightSql('scrvusd_schedule_publisher'),
    /base scrvUSD schedule boundary absent/,
  )
  assert.match(
    scheduleAttemptPreflightSql('scrvusd_schedule_publisher'),
    /already or partially installed/,
  )
  assert.match(
    scheduleAttemptPreflightSql('scrvusd_schedule_publisher'),
    /base scrvUSD schedule owner differs from attempt migration login/,
  )
  assert.match(
    scheduleAttemptPreflightSql('scrvusd_schedule_publisher'),
    /am\.member<>pg_catalog\.to_regrole\(current_user\)::oid/,
  )
  assert.match(
    scheduleAttemptPreflightSql('scrvusd_schedule_publisher'),
    /NOT am\.admin_option OR am\.inherit_option OR am\.set_option/,
  )
  assert.throws(() => scheduleAttemptPreflightSql("x'; DROP TABLE t;--"))
  for (const name of [
    'scrvusd_now_arm_starts',
    'scrvusd_now_start_confirmations',
    'scrvusd_now_capture_floors',
    'scrvusd_now_arm_results',
    'scrvusd_now_run_confirmations',
  ])
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${name}`))
  assert.match(sql, /start_payload text NOT NULL/)
  assert.match(sql, /pre-slot committed manifest visibility witness absent/)
  assert.match(sql, /pg_catalog\.txid_current\(\)=v_visibility\.witness_xid/)
  assert.match(sql, /issue_payload text/)
  assert.match(sql, /start payload bytes or logical\/physical SHA invalid/)
  assert.match(sql, /issued v2 payload bytes or exact start binding invalid/)
  assert.match(sql, /four committed arm starts not visible within slot/)
  assert.match(sql, /capture floor needs separate visible transaction inside slot/)
  assert.match(sql, /pg_catalog\.txid_current\(\)=v_floor\.visibility_xid/)
  assert.match(sql, /start\/capture-floor transaction not committed/)
  assert.match(
    sql,
    /IF p_status='issued' THEN\s+SELECT s\.source_start_at,s\.source_start_xid INTO v_source_started_at,v_source_xid\s+FROM public\.scrvusd_now_source_starts s/,
  )
  assert.match(sql, /v_source_started_at>p_local_issued_at/)
  assert.match(sql, /v_source_xid=pg_catalog\.txid_current\(\)/)
  assert.match(sql, /issued result needs committed source start before local issue/)
  assert.match(sql, /four committed arm results not visible within slot/)
  assert.match(sql, /v_first_issued_target/)
  assert.match(sql, /PRIMARY KEY\(manifest_sha256,slot_id,horizon_seconds\)/)
  assert.match(sql, /issue_logical_sha256 text UNIQUE/)
  assert.doesNotMatch(sql, /\bDROP\b|\bGRANT\b|\bCREATE ROLE\b/)
})

test('attempt role audit covers every new function and rejects direct writes', () => {
  const keys = [
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
  ]
  const good = Object.fromEntries(keys.map((key) => [key, true]))
  assert.equal(scheduleAttemptAuditPass(good), true)
  for (const key of keys) assert.equal(scheduleAttemptAuditPass({ ...good, [key]: false }), false)
  for (const name of [
    'start_scrvusd_now_arm',
    'confirm_scrvusd_now_starts',
    'mark_scrvusd_now_capture_floor',
    'result_scrvusd_now_arm',
    'confirm_scrvusd_now_run',
  ])
    assert.match(SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL, new RegExp(name))
  assert.match(
    SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL,
    /has_any_column_privilege\(current_user,rel,'UPDATE'\)/,
  )
  assert.match(SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL, /object_count IN \(16,24\) AND owner_count=1/)
  assert.match(
    SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL,
    /member_count=0 OR \(member_count=1 AND exact_creator_membership\)/,
  )
})

test('as-of migration is additive, gated, fixed-scope and keeps distinct witnesses', () => {
  const preflight = scheduleAsOfPreflightSql('scrvusd_schedule_publisher')
  const sql = SCRVUSD_SCHEDULE_ASOF_MIGRATION_SQL.join('\n')
  assert.match(preflight, /scrvUSD attempt boundary absent/)
  assert.match(preflight, /as-of boundary already or partially installed/)
  assert.match(preflight, /existing boundary owner differs from as-of migration login/)
  assert.match(preflight, /NOT am\.admin_option OR am\.inherit_option OR am\.set_option/)
  assert.throws(() => scheduleAsOfPreflightSql("x'; DROP TABLE t;--"))
  for (const table of [
    'scrvusd_now_source_starts',
    'scrvusd_now_run_visibility',
    'scrvusd_now_scores',
    'scrvusd_now_score_visibility',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`))
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC`))
  }
  for (const func of [
    'start_scrvusd_now_source',
    'witness_scrvusd_now_run',
    'record_scrvusd_now_score',
    'witness_scrvusd_now_score',
  ]) {
    assert.match(sql, new RegExp(`CREATE FUNCTION public\\.${func}`))
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${func}`))
  }
  assert.match(
    sql,
    /pg_catalog\.txid_current\(\) IN \(v_floor\.visibility_xid,v_starts\.confirmer_xid\)/,
  )
  assert.match(sql, /v_first_target IS NOT NULL AND v_now >= v_first_target/)
  assert.match(sql, /p_score_payload NOT LIKE/)
  assert.match(sql, /v_now < v_deadline/)
  assert.match(sql, /v_body->>'scoredAtUtc' IS NULL/)
  assert.match(sql, /v_body->>'scoredAtUtc' IS DISTINCT FROM pg_catalog\.to_char/)
  assert.match(sql, /v_body->'pointOutcome'->>'status' NOT IN/)
  assert.match(sql, /scoredAtUtc'\)::timestamptz < v_deadline/)
  assert.match(sql, /v_body->>'targetUtc' IS DISTINCT FROM v_issue->>'targetUtc'/)
  assert.match(sql, /v_body->>'evidenceCutoffUtc' IS DISTINCT FROM/)
  for (const field of ['holder', 'qAssetsRaw', 'route'])
    assert.match(sql, new RegExp(`v_body->'pointOutcome'->>'${field}' IS DISTINCT FROM`))
  assert.match(sql, /conflicting score retry/)
  assert.match(sql, /pg_catalog\.txid_current\(\)=v_score\.score_xid/)
  assert.doesNotMatch(sql, /\bDROP\b|\bGRANT\b|\bCREATE ROLE\b/)
})

test('all publisher audits include installed as-of objects and fail closed on role drift', () => {
  const keys = [
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
  ]
  const good = Object.fromEntries(keys.map((key) => [key, true]))
  assert.equal(scheduleAsOfAuditPass(good), true)
  for (const key of keys) assert.equal(scheduleAsOfAuditPass({ ...good, [key]: false }), false)
  assert.match(SCRVUSD_SCHEDULE_ASOF_AUDIT_SQL, /object_count=24 AND owner_count=1/)
  assert.match(
    SCRVUSD_SCHEDULE_ASOF_AUDIT_SQL,
    /am\.admin_option AND NOT am\.inherit_option AND NOT am\.set_option/,
  )
  for (const statement of [SCRVUSD_SCHEDULE_AUDIT_SQL, SCRVUSD_SCHEDULE_ATTEMPT_AUDIT_SQL]) {
    assert.match(statement, /to_regclass\('public\.scrvusd_now_scores'\)/)
    assert.match(statement, /to_regprocedure\('public\.record_scrvusd_now_score/)
  }
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /can_witness_manifest/)
  assert.match(
    SCRVUSD_SCHEDULE_AUDIT_SQL,
    /to_regclass\('public\.scrvusd_now_manifest_visibility'\)/,
  )
  assert.match(SCRVUSD_SCHEDULE_AUDIT_SQL, /to_regprocedure\('public\.witness_scrvusd_now_manifest/)
})
