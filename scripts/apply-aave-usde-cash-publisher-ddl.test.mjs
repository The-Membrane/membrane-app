import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  CASH_PUBLISHER_AUDIT_SQL,
  CASH_PUBLISHER_MIGRATION_SQL,
  publisherAclGuardSql,
  publisherAuditPass,
} from './apply-aave-usde-cash-publisher-ddl.mjs'

const joined = CASH_PUBLISHER_MIGRATION_SQL.join('\n')

test('publisher migration is one ordered atomic batch with no role creation or grant', () => {
  assert.equal(CASH_PUBLISHER_MIGRATION_SQL.length, 22)
  assert.match(joined, /CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public/)
  assert.match(joined, /SECURITY DEFINER SET search_path = pg_catalog/g)
  assert.match(
    joined,
    /REVOKE ALL ON FUNCTION public\.publish_aave_usde_cash_issue\(jsonb, text, text\) FROM PUBLIC/,
  )
  assert.match(
    joined,
    /REVOKE ALL ON FUNCTION public\.publish_aave_usde_cash_score\(jsonb, text, text\) FROM PUBLIC/,
  )
  assert.match(joined, /REVOKE ALL ON FUNCTION public\.publish_aave_usde_cash_issue_start/)
  assert.match(joined, /REVOKE ALL ON FUNCTION public\.publish_aave_usde_cash_issue_result/)
  assert.match(joined, /REVOKE ALL ON FUNCTION public\.publish_aave_usde_cash_score_attempt/)
  assert.doesNotMatch(joined, /\bCREATE ROLE\b|\bGRANT\b|\bDATABASE_URL\b/)
})

test('issue function binds exact unsigned bytes, semantic body and DB clock', () => {
  const issue = CASH_PUBLISHER_MIGRATION_SQL[2]
  assert.match(
    issue,
    /public\.digest\(pg_catalog\.convert_to\(p_unsigned_text, 'UTF8'\), 'sha256'\)/,
  )
  assert.match(issue, /v_unsigned <> \(v_body - 'sha256'\)/)
  assert.match(issue, /v_body->>'sha256' IS DISTINCT FROM v_sha/)
  assert.match(issue, /p_payload_text, v_sha/)
  assert.match(issue, /v_now timestamptz := pg_catalog\.clock_timestamp\(\)/)
  assert.match(
    issue,
    /v_target IS DISTINCT FROM v_issued \+ pg_catalog\.make_interval\(secs => v_horizon\)/,
  )
  assert.match(issue, /v_now > v_issued \+ interval '60 seconds'/)
  assert.match(issue, /ON CONFLICT \(study, anchor_id, amount_usd, horizon_seconds\) DO NOTHING/)
  assert.match(issue, /corrupt prior USDe cash issue receipt/)
  assert.match(issue, /public\.venue_snapshots s/)
})

test('score function references persisted issue and seals exactly one outcome', () => {
  const score = CASH_PUBLISHER_MIGRATION_SQL[3]
  assert.match(score, /v_body->>'issueSha256' IS DISTINCT FROM v_issue\.payload_sha256/)
  assert.match(score, /v_scored < v_issue\.target_at/)
  assert.match(score, /v_issue\.persisted_at >= v_issue\.target_at/)
  assert.match(score, /v_now > v_scored \+ interval '60 seconds'/)
  assert.match(score, /ON CONFLICT \(issue_id\) DO NOTHING/)
  assert.match(score, /corrupt prior USDe cash score receipt/)
  assert.match(score, /'observed', 'censored'/)
})

test('same anchor may be reissued later without overwriting its first receipt', () => {
  const issue = CASH_PUBLISHER_MIGRATION_SQL[2]
  const priorIndex = issue.indexOf('SELECT * INTO v_prior FROM public.aave_usde_cash_issues i')
  const clockIndex = issue.indexOf('IF v_issued > v_now OR v_now > v_issued')
  assert.ok(priorIndex > 0 && clockIndex > priorIndex)
  assert.match(
    issue,
    /receipt_id := v_prior\.id;\s*inserted := false;\s*persisted_at := v_prior\.persisted_at;/,
  )
  assert.doesNotMatch(issue, /v_prior\.payload IS DISTINCT FROM p_payload_text/)
  const score = CASH_PUBLISHER_MIGRATION_SQL[3]
  assert.match(
    score,
    /receipt_id := v_prior\.id;\s*inserted := false;\s*persisted_at := v_prior\.persisted_at;/,
  )
  assert.doesNotMatch(score, /v_prior\.scored_at IS DISTINCT FROM v_scored/)
})

test('attempt functions limit fixed arms, terminal statuses and direct writes', () => {
  const [start, result, score] = CASH_PUBLISHER_MIGRATION_SQL.slice(4, 7)
  assert.match(start, /p_amount_usd NOT IN \(1000000, 10000000, 50000000\)/)
  assert.match(start, /p_horizon_seconds NOT IN \(28800, 86400, 604800\)/)
  assert.match(result, /p_status NOT IN \('issued','duplicate','abstained','failed'\)/)
  assert.match(result, /a\.phase='start' AND a\.status='scheduled'/)
  assert.match(result, /conflicting issue result receipt/)
  assert.match(score, /p_status NOT IN \('scored','already_scored','pending','failed'\)/)
  assert.match(score, /p_status IN \('scored','already_scored'\) AND NOT EXISTS/)
})

test('durable manifest validates exact payload, future slots and overlap under a lock', () => {
  const manifest = CASH_PUBLISHER_MIGRATION_SQL[7]
  assert.match(manifest, /v_unsigned <> \(v_body - 'sha256'\)/)
  assert.match(manifest, /public\.digest\(pg_catalog\.convert_to\(p_unsigned_text, 'UTF8'\)/)
  assert.match(manifest, /v_start < v_now \+ interval '2 hours'/)
  assert.match(manifest, /v_count < 1 OR v_count > 8760/)
  assert.match(manifest, /v_slot->'arms' IS DISTINCT FROM v_arms/)
  assert.match(manifest, /pg_catalog\.pg_advisory_xact_lock\(917641029::bigint\)/)
  assert.ok(
    manifest.indexOf('v_now := pg_catalog.clock_timestamp();') >
      manifest.indexOf('pg_catalog.pg_advisory_xact_lock(917641029::bigint)'),
  )
  assert.match(manifest, /s\.start_at < v_end AND s\.end_at > v_start/)
  assert.match(manifest, /manifest SHA collision with different exact bytes/)
  const baseDdl = readFileSync(new URL('./apply-venue-recorder-ddl.mjs', import.meta.url), 'utf8')
  assert.match(baseDdl, /aave_usde_cash_schedules_no_overlap/)
  assert.match(baseDdl, /EXCLUDE USING gist \(tstzrange\(start_at, end_at, '\[\)'\) WITH &&\)/)
})

test('scheduled attempt overloads bind manifest and slot at DB statement time', () => {
  const start = CASH_PUBLISHER_MIGRATION_SQL[8]
  const result = CASH_PUBLISHER_MIGRATION_SQL[9]
  for (const statement of [start, result]) {
    assert.match(statement, /p_manifest_sha256 text, p_slot_id text/)
    assert.match(statement, /v_manifest\.persisted_at >= v_manifest\.start_at/)
    assert.match(statement, /v_now < \(v_slot->>'scheduledAt'\)::timestamptz/)
    assert.match(statement, /v_now >= \(v_slot->>'closesAt'\)::timestamptz/)
    assert.match(statement, /manifest_sha256, slot_id, recorded_at/)
  }
  assert.match(result, /a\.manifest_sha256=p_manifest_sha256 AND a\.slot_id=p_slot_id/)
  assert.match(result, /v_issue_issued_at < v_start_at OR v_issue_at < v_start_at/)
  assert.match(result, /v_issue_xid IS DISTINCT FROM pg_catalog\.txid_current\(\)/)
})

test('post-commit confirmations require distinct transaction IDs and timely readback', () => {
  const manifest = CASH_PUBLISHER_MIGRATION_SQL[10]
  const run = CASH_PUBLISHER_MIGRATION_SQL[11]
  assert.match(manifest, /v_manifest\.publisher_xid=v_xid/)
  assert.match(manifest, /v_now > v_manifest\.start_at - interval '2 hours'/)
  assert.match(manifest, /public\.aave_usde_cash_schedule_confirmations/)
  assert.match(run, /v_count <> 18 OR v_start_count <> 9 OR v_result_count <> 9/)
  assert.match(run, /v_result_xid=v_xid/)
  assert.match(run, /i\.publisher_xid IS DISTINCT FROM v_result_xid/)
  assert.match(run, /v_now > v_latest_result \+ interval '60 seconds'/)
  assert.match(run, /public\.aave_usde_cash_issue_run_confirmations/)
})

test('first installation rejects preexisting untrusted rows; complete rerun permits rows', () => {
  const first = publisherAclGuardSql('cash_publisher')
  assert.match(first, /expected USDe publisher role is not provisioned/)
  const rerun = publisherAclGuardSql('cash_publisher', { requireInstalled: true })
  assert.match(first, /v_count NOT IN \(0, 5, 8, 10\)/)
  assert.match(
    first,
    /v_count IN \(0,5\) AND EXISTS \(SELECT 1 FROM public\.aave_usde_cash_schedules\)/,
  )
  assert.match(first, /v_count = 0 AND \(/)
  for (const table of [
    'aave_usde_cash_issues',
    'aave_usde_cash_scores',
    'aave_usde_cash_issue_attempts',
    'aave_usde_cash_score_attempts',
  ])
    assert.match(first, new RegExp(`EXISTS \\(SELECT 1 FROM public\\.${table}\\)`))
  assert.match(rerun, /v_count <> 10/)
  assert.doesNotMatch(rerun, /first install requires empty/)
  assert.match(first, /pg_catalog\.aclexplode/)
  assert.match(first, /unexpected USDe publisher function EXECUTE grant/)
  assert.match(first, /v_expected oid := pg_catalog\.to_regrole\('cash_publisher'\)/)
  assert.throws(() => publisherAclGuardSql("publisher'; DROP TABLE x; --"))
})

test('read-only audit requires distinct unprivileged runtime role', () => {
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /has_table_privilege\(current_user, rel, 'INSERT'\)/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /has_any_column_privilege\(current_user, rel, 'INSERT'\)/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /has_any_column_privilege\(current_user, rel, 'UPDATE'\)/)
  assert.match(
    CASH_PUBLISHER_AUDIT_SQL,
    /has_any_column_privilege\(current_user, rel, 'REFERENCES'\)/,
  )
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /session_user = current_user AS direct_login_role/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /pg_catalog\.aclexplode/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /pg_has_role\(current_user, c\.relowner, 'MEMBER'\)/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /pg_has_role\(current_user, p\.proowner, 'MEMBER'\)/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /'public\.venue_snapshots'::regclass/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /'public\.aave_usde_cash_schedules'::regclass/)
  assert.match(
    CASH_PUBLISHER_AUDIT_SQL,
    /'public\.aave_usde_cash_schedule_confirmations'::regclass/,
  )
  assert.match(
    CASH_PUBLISHER_AUDIT_SQL,
    /'public\.aave_usde_cash_issue_run_confirmations'::regclass/,
  )
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /has_table_privilege\(current_user, rel, 'SELECT'\)/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /has_function_privilege\(current_user,/)
  assert.match(CASH_PUBLISHER_AUDIT_SQL, /has_schema_privilege\(current_user, 'public', 'CREATE'\)/)
  const good = {
    direct_login_role: true,
    ordinary_role: true,
    no_create: true,
    schema_usage: true,
    no_direct_protected_write: true,
    can_read_evidence: true,
    not_table_owner_member: true,
    not_function_owner_member: true,
    exclusive_function_acl: true,
    can_issue: true,
    can_score: true,
    can_start: true,
    can_finish: true,
    can_record_score_attempt: true,
    can_publish_manifest: true,
    can_start_bound: true,
    can_finish_bound: true,
    can_confirm_manifest: true,
    can_confirm_issue_run: true,
  }
  assert.equal(publisherAuditPass(good), true)
  for (const key of Object.keys(good))
    assert.equal(publisherAuditPass({ ...good, [key]: false }), false)
  assert.equal(publisherAuditPass(null), false)
})

test('CLI refuses apply and audit without their dedicated credentials', () => {
  const script = new URL('./apply-aave-usde-cash-publisher-ddl.mjs', import.meta.url).pathname
  for (const mode of ['--apply', '--audit-publisher']) {
    const env = { ...process.env }
    delete env.CASH_PUBLISHER_MIGRATION_DATABASE_URL
    delete env.CASH_PUBLISHER_DATABASE_URL
    env.DATABASE_URL = 'postgres://should-not-be-used:secret@example.invalid/db'
    const run = spawnSync(process.execPath, [script, mode], { env, encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /CASH_PUBLISHER_(MIGRATION_)?DATABASE_URL is required/)
    assert.doesNotMatch(run.stderr + run.stdout, /should-not-be-used|secret/)
  }
})
