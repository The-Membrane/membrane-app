import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  V2_ISSUE_SCORE_ACL,
  V2_ISSUE_SCORE_DDL,
  V2_ISSUE_SCORE_FUNCTIONS,
} from './apply-aave-usde-v2-issue-score-ddl.mjs'

const schema = V2_ISSUE_SCORE_DDL.join('\n')
const functions = V2_ISSUE_SCORE_FUNCTIONS.join('\n')
const acl = V2_ISSUE_SCORE_ACL.join('\n')
const named = (name) =>
  V2_ISSUE_SCORE_FUNCTIONS.find((sql) => sql.includes(`FUNCTION public.${name}`))

test('additive v2 ledger depends on confirmed schedule without changing v1', () => {
  assert.match(schema, /to_regclass\('public\.aave_usde_v2_issue_schedules'\)/)
  assert.match(schema, /to_regclass\('public\.aave_usde_v2_schedule_confirmations'\)/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_issue_starts/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_issue_terminals/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_issue_collisions/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_score_receipts/)
  assert.doesNotMatch(schema, /ALTER TABLE|DROP TABLE|TRUNCATE|aave_usde_cash_/)
})

test('one current confirmed slot starts nine arms in a single function', () => {
  const start = named('start_aave_usde_v2_issue_slot')
  assert.match(start, /aave_usde_v2_schedule_confirmations/)
  assert.match(start, /confirmer_xid<>txid_current\(\)/)
  assert.match(start, /v_now<\(v_slot->>'scheduledAt'\)::timestamptz/)
  assert.match(start, /v_now>=\(v_slot->>'closesAt'\)::timestamptz/)
  assert.match(start, /INSERT INTO public\.aave_usde_v2_issue_starts/)
  assert.match(start, /jsonb_array_elements\(v_slot->'arms'\)/)
  assert.match(start, /v_count<>9/)
  assert.match(schema, /PRIMARY KEY \(schedule_sha256,slot_id,amount_usd,horizon_seconds\)/)
})

test('terminal requires prior transaction and only issued payload gets physical hash', () => {
  const finish = named('finish_aave_usde_v2_issue_cell')
  assert.match(finish, /st\.starter_xid=txid_current\(\)/)
  assert.match(finish, /v_issue_at<date_trunc\('milliseconds',st\.started_at\)/)
  assert.match(finish, /p_status NOT IN \('issued','abstained','failed'\)/)
  assert.match(finish, /v_issue_at>=\(v_slot->>'closesAt'\)::timestamptz/)
  assert.match(finish, /v_timely:=v_now>=\(v_slot->>'scheduledAt'\)::timestamptz/)
  assert.match(finish, /v_now<\(v_slot->>'closesAt'\)::timestamptz/)
  assert.match(finish, /OR NOT v_timely/)
  assert.match(schema, /timely boolean NOT NULL/)
  assert.match(finish, /v_issue_at>v_now/)
  assert.match(finish, /v_issue_at\+p_horizon\*interval '1 second'/)
  assert.match(finish, /public\.digest\(convert_to\(p_payload,'UTF8'\),'sha256'\)/)
  assert.match(finish, /issue logical seal does not match payload/)
  assert.match(finish, /issue payload lacks canonical trailing seal/)
  assert.match(schema, /issue_sha256 text UNIQUE/)
  assert.match(schema, /physical_sha256 text UNIQUE/)
  assert.match(schema, /anchor_id uuid REFERENCES public\.venue_snapshots\(id\)/)
  assert.match(finish, /SELECT \* INTO a FROM public\.venue_snapshots WHERE id=v_anchor/)
  assert.match(finish, /a\.recorder_atomic_v1 IS DISTINCT FROM TRUE/)
  assert.match(finish, /a\.params->>'underlyingBalance' IS DISTINCT FROM j->'anchor'->>'cashRaw'/)
  assert.match(finish, /floor\(extract\(epoch FROM a\.observed_at\)\*1000\)\/1000/)
  assert.match(finish, /anchorAgeAtIssueSeconds'\)::numeric/)
  assert.match(finish, /underlyingBalance'\)::numeric < p_amount\*1000000000000000000::numeric/)
  assert.match(finish, /issue anchor is not latest locally available observation/)
  assert.match(schema, /status<>'issued' AND reason IS NOT NULL/)
})

test('duplicate execution is an append-only collision against an existing issued cell', () => {
  const collision = named('record_aave_usde_v2_issue_collision')
  assert.match(schema, /issue_sha256 text NOT NULL REFERENCES public\.aave_usde_v2_issue_terminals/)
  assert.match(collision, /status='issued' AND issue_sha256=p_issue/)
  assert.match(collision, /t\.terminal_xid=txid_current\(\)/)
  assert.match(collision, /v_now<\(v_slot->>'closesAt'\)::timestamptz/)
  assert.match(
    schema,
    /CREATE TABLE public\.aave_usde_v2_issue_collisions[\s\S]*timely boolean NOT NULL/,
  )
  assert.doesNotMatch(named('finish_aave_usde_v2_issue_cell'), /p_status NOT IN \([^)]*duplicate/)
})

test('final score is insert once after immutable target cutoff, never pending', () => {
  const score = named('insert_aave_usde_v2_score')
  assert.match(score, /i\.terminal_xid=txid_current\(\)/)
  assert.match(score, /v_cutoff:=v_target\+interval '8 hours 120 seconds'/)
  assert.match(score, /v_now<v_cutoff/)
  assert.match(score, /j->>'status' NOT IN \('observed','censored'\)/)
  assert.match(score, /j->>'sourceCompleteness' IS DISTINCT FROM 'caller_unverified'/)
  assert.match(score, /INSERT INTO public\.aave_usde_v2_score_receipts/)
  assert.match(score, /score logical seal does not match payload/)
  assert.match(score, /score payload lacks canonical trailing seal/)
  assert.match(
    schema,
    /issue_sha256 text PRIMARY KEY REFERENCES public\.aave_usde_v2_issue_terminals/,
  )
  assert.match(schema, /status text NOT NULL CHECK \(status IN \('observed','censored'\)\)/)
  assert.doesNotMatch(score, /ON CONFLICT|UPDATE public/)
})

test('append-only and runtime privilege grants are separate', () => {
  assert.equal((schema.match(/BEFORE UPDATE OR DELETE/g) ?? []).length, 4)
  assert.equal((acl.match(/REVOKE ALL ON TABLE/g) ?? []).length, 4)
  assert.equal((acl.match(/REVOKE ALL ON FUNCTION/g) ?? []).length, 4)
  assert.doesNotMatch(acl, /\bGRANT\b/)
  for (const sql of V2_ISSUE_SCORE_FUNCTIONS) {
    assert.match(sql, /SECURITY DEFINER SET search_path=pg_catalog/)
    assert.match(sql, /END; \$\$$/)
  }
})

test('dry CLI requires explicit apply and dedicated database URL', () => {
  const run = spawnSync(process.execPath, ['scripts/apply-aave-usde-v2-issue-score-ddl.mjs'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /Usage:/)
  assert.match(functions, /aave-v3-usde-first-sampled-cash-breach-by-h-v2/)
})
