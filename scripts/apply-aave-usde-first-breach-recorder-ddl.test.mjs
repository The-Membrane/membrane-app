import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  V2_RECORDER_ACL,
  V2_RECORDER_DDL,
  V2_RECORDER_FUNCTIONS,
} from './apply-aave-usde-first-breach-recorder-ddl.mjs'

const schema = V2_RECORDER_DDL.join('\n')
const functions = V2_RECORDER_FUNCTIONS.join('\n')
const acl = V2_RECORDER_ACL.join('\n')
const named = (prefix) =>
  V2_RECORDER_FUNCTIONS.find((sql) => sql.includes(`FUNCTION public.${prefix}`))

test('v2 ledger is additive and separate from v1 publisher', () => {
  assert.match(schema, /to_regprocedure\('public\.digest\(bytea,text\)'\)/)
  assert.match(schema, /to_regprocedure\('public\.ingest_venue_snapshot_atomic_v1/)
  assert.match(schema, /CREATE TRIGGER aave_usde_00_v2_created_at/)
  assert.match(schema, /NEW\.created_at:=NEW\.observed_at/)
  assert.match(schema, /NEW\.recorder_atomic_v1 IS TRUE/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_issue_schedules/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_coverage_manifests/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_recorder_starts/)
  assert.match(schema, /CREATE TABLE public\.aave_usde_v2_recorder_terminals/)
  assert.doesNotMatch(schema, /ALTER TABLE public\.aave_usde_cash_|DROP TABLE|TRUNCATE/)
  assert.match(schema, /aave_usde_v2_schedule_no_overlap EXCLUDE USING gist/)
  assert.doesNotMatch(schema, /aave_usde_v2_coverage_no_overlap EXCLUDE USING gist/)
  assert.match(schema, /UNIQUE \(manifest_sha256,slot_at\)/)
  assert.match(schema, /slot_id text PRIMARY KEY/)
  assert.match(schema, /snapshot_id uuid UNIQUE REFERENCES public\.venue_snapshots\(id\)/)
})

test('canonical publication derives all slots in SQL before storing physical bytes', () => {
  const issue = named('publish_aave_usde_v2_issue_schedule')
  const coverage = named('publish_aave_usde_v2_coverage_manifest')
  for (const sql of [issue, coverage]) {
    assert.match(sql, /v_expected/)
    assert.match(sql, /p_text IS DISTINCT FROM v_expected/)
    assert.match(sql, /public\.digest\(convert_to\(p_text,'UTF8'\),'sha256'\)/)
    assert.match(sql, /publisher_xid/)
  }
  assert.match(issue, /v_count NOT BETWEEN 1 AND 568/)
  assert.match(coverage, /v_count NOT BETWEEN 1 AND 744/)
  assert.match(coverage, /v_end<s\.end_at\+interval '7 days 8 hours'/)
  assert.match(issue, /v_slot := encode\(public\.digest\(convert_to\(format/)
  assert.match(issue, /horizonsSeconds/)
  assert.match(coverage, /issueSchedulePhysicalSha256/)
  assert.match(coverage, /aave-v3-usde:%s/)
  assert.match(coverage, /aave_usde_v2_coverage_slots\(manifest_sha256,slot_id,slot_at\)/)
})

test('confirmation and start cross committed transaction boundaries', () => {
  for (const prefix of [
    'confirm_aave_usde_v2_issue_schedule',
    'confirm_aave_usde_v2_coverage_manifest',
  ]) {
    assert.match(named(prefix), /publisher_xid=txid_current\(\)/)
  }
  const start = named('start_aave_usde_v2_recorder')
  assert.match(start, /aave_usde_v2_coverage_confirmations/)
  assert.match(start, /confirmer_xid<>txid_current\(\)/)
  assert.match(start, /v_now<v_at OR v_now>=v_at\+interval '1 hour'/)
  assert.match(start, /starter_xid/)
  assert.match(start, /VALUES\(p_manifest,p_slot,v_now,txid_current\(\)\)/)
})

test('success invokes atomic insert and terminal write in one function', () => {
  const success = named('ingest_aave_usde_v2_recorder_success')
  const predecessor = named('aave_usde_v2_atomic_predecessor')
  assert.match(predecessor, /SECURITY DEFINER SET search_path=pg_catalog/)
  assert.match(predecessor, /s\.recorder_atomic_v1 IS TRUE/)
  assert.match(
    acl,
    /REVOKE ALL ON FUNCTION public\.aave_usde_v2_atomic_predecessor\(\) FROM PUBLIC/,
  )
  assert.match(success, /st\.starter_xid=txid_current\(\)/)
  assert.match(success, /st\.manifest_sha256 IS DISTINCT FROM p_manifest/)
  assert.match(success, /public\.ingest_venue_snapshot_atomic_v1\('aave-v3-usde','ethereum'/)
  assert.match(success, /v_result->>'status' IS DISTINCT FROM 'inserted'/)
  assert.match(success, /v_id:=\(v_result->>'snapshot_id'\)::uuid/)
  assert.match(success, /s\.recorder_atomic_v1 IS TRUE/)
  assert.doesNotMatch(success, /UPDATE public\.venue_snapshots/)
  assert.match(success, /SET search_path=pg_catalog,public,pg_temp/)
  assert.match(success, /VALUES\(p_slot,'success',v_id,clock_timestamp\(\),txid_current\(\)\)/)
  assert.match(success, /WHERE t.slot_id=p_slot/)
  assert.doesNotMatch(named('finish_aave_usde_v2_recorder'), /'success'/)
})

test('adjacent issue schedules share physical hourly receipts across overlapping coverage', () => {
  assert.match(schema, /aave_usde_v2_schedule_no_overlap EXCLUDE USING gist/)
  assert.doesNotMatch(schema, /aave_usde_v2_coverage_no_overlap/)
  assert.match(
    schema,
    /CREATE TABLE public\.aave_usde_v2_coverage_slots[\s\S]*PRIMARY KEY \(manifest_sha256,slot_id\)/,
  )
  assert.match(
    schema,
    /CREATE TABLE public\.aave_usde_v2_recorder_starts[\s\S]*slot_id text PRIMARY KEY/,
  )
  assert.match(
    schema,
    /CREATE TABLE public\.aave_usde_v2_recorder_terminals[\s\S]*slot_id text PRIMARY KEY/,
  )
  assert.match(named('finish_aave_usde_v2_recorder'), /WHERE slot_id=p_slot/)
  assert.match(
    named('finish_aave_usde_v2_recorder'),
    /st\.manifest_sha256 IS DISTINCT FROM p_manifest/,
  )
})

test('immutable rows and explicit public privilege withdrawal', () => {
  assert.match(schema, /BEFORE UPDATE OR DELETE/)
  assert.match(schema, /v2 ledger is append only/)
  assert.match(acl, /REVOKE ALL ON FUNCTION public\.ingest_aave_usde_v2_recorder_success/)
  assert.match(acl, /REVOKE ALL ON FUNCTION public\.set_aave_usde_v2_observed_created_at\(\)/)
  assert.match(acl, /REVOKE ALL ON TABLE public\.aave_usde_v2_recorder_terminals FROM PUBLIC/)
  assert.doesNotMatch(acl, /\bGRANT\b/)
  assert.match(functions, /SECURITY DEFINER SET search_path=pg_catalog/g)
  for (const sql of V2_RECORDER_FUNCTIONS.filter((statement) => /LANGUAGE plpgsql/.test(statement)))
    assert.match(sql, /END; \$\$$/)
})

test('migration is dry without explicit dedicated credential', () => {
  const run = spawnSync(
    process.execPath,
    ['scripts/apply-aave-usde-first-breach-recorder-ddl.mjs'],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    },
  )
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /Usage:/)
})
