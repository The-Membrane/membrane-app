import assert from 'node:assert/strict'
import { test } from 'node:test'

import { auditCoverage, evaluateCoverage } from './audit-carry-forecast-coverage.mjs'
import {
  MODEL_GUARD_EXPECTATIONS,
  MODEL_GUARD_FUNCTION_MARKERS,
} from './apply-carry-cash-model-ddl.mjs'
import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import { TWYNE_PT_RESERVE } from './record-twyne-pt-reserve.mjs'

async function fixture() {
  const manifest = await buildSubjectManifest()
  const genericRows = manifest.subjects
    .filter((subject) => subject.route_key !== TWYNE_PT_RESERVE.routeKey)
    .map((subject) => ({
      route_key: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      source_kind: subject.source_kind,
      source_venue_kind: subject.venue_kind,
      horizon_hours: 1,
      artifact_route_key: subject.route_key,
      artifact_destination: subject.destination,
      artifact_asset: subject.asset,
      artifact_horizon_hours: 1,
    }))
  const twyneRows = [
    {
      route_key: TWYNE_PT_RESERVE.routeKey,
      wrapper: TWYNE_PT_RESERVE.wrapper,
      metric: 'aave_pt_reserve_cash_raw',
      horizon_hours: 1,
      artifact_route_key: TWYNE_PT_RESERVE.routeKey,
      artifact_wrapper: TWYNE_PT_RESERVE.wrapper,
      artifact_pt: TWYNE_PT_RESERVE.pt,
      artifact_atoken: TWYNE_PT_RESERVE.aToken,
      artifact_pool: TWYNE_PT_RESERVE.pool,
      artifact_horizon_hours: 1,
    },
  ]
  return { manifest, genericRows, twyneRows }
}

test('covers the exact 25-route, 67-subject registry', async () => {
  const { manifest, genericRows, twyneRows } = await fixture()
  assert.deepEqual(evaluateCoverage(manifest, genericRows, twyneRows), {
    valid: true,
    routeGroups: 25,
    exactSubjects: 67,
    genericFutureH1: 66,
    twynePtFutureH1: 1,
    missing: [],
  })
})

test('equal row counts cannot hide one missing exact destination', async () => {
  const { manifest, genericRows, twyneRows } = await fixture()
  genericRows[0] = { ...genericRows[0], destination: '0x0000000000000000000000000000000000000001' }
  assert.throws(
    () => evaluateCoverage(manifest, genericRows, twyneRows),
    /coverage_unknown_generic_issue:/,
  )
})

test('extra generic rows cannot hide a complete expected cohort', async () => {
  const { manifest, genericRows, twyneRows } = await fixture()
  genericRows.push({
    ...genericRows[0],
    route_key: 'UNKNOWN → VAULT',
    destination: '0x0000000000000000000000000000000000000001',
  })
  assert.throws(
    () => evaluateCoverage(manifest, genericRows, twyneRows),
    /coverage_generic_issue_count_invalid/,
  )
})

test('asset mismatch and missing Twyne proxy fail closed with identities', async () => {
  const { manifest, genericRows } = await fixture()
  const wrong = genericRows[0]
  genericRows[0] = { ...wrong, artifact_asset: '0x0000000000000000000000000000000000000001' }
  const result = evaluateCoverage(manifest, genericRows, [])
  assert.equal(result.valid, false)
  assert.equal(result.genericFutureH1, 65)
  assert.equal(result.twynePtFutureH1, 0)
  assert.ok(result.missing.includes(`${wrong.route_key} @ ${wrong.destination}`))
  assert.ok(result.missing.includes(`${TWYNE_PT_RESERVE.routeKey} @ ${TWYNE_PT_RESERVE.wrapper}`))
})

test('live gate requires issues from the latest scheduled quarter-hour slot', async () => {
  const { genericRows, twyneRows } = await fixture()
  const queries = []
  const sql = async (strings) => {
    const query = strings.join('?')
    queries.push(query)
    if (query.includes('FROM pg_trigger')) {
      return MODEL_GUARD_EXPECTATIONS.map((expected) => ({
        table_name: expected.table,
        tgname: expected.trigger,
        enabled: 'O',
        function_name: expected.functionName,
        definition: `CREATE TRIGGER ${expected.trigger} BEFORE ${expected.events.join(
          ' OR ',
        )} ON ${expected.table} FOR EACH ${expected.level} EXECUTE FUNCTION ${expected.functionName}()`,
        function_definition: (MODEL_GUARD_FUNCTION_MARKERS[expected.functionName] ?? []).join(' '),
      }))
    }
    return query.includes('FROM carry_cash_model_attempts') ? genericRows : twyneRows
  }
  const result = await auditCoverage(sql)
  assert.equal(result.valid, true)
  assert.equal(queries.length, 3)
  assert.ok(
    queries.slice(1).every((query) => query.includes("clock_timestamp() - interval '10 minutes'")),
  )
  assert.ok(queries[1].includes('a.registered_at < e.activated_at'))
  assert.ok(queries[1].includes('m.issued_at < e.activated_at'))
  assert.ok(queries[1].includes('WITH latest_slot AS'))
  assert.ok(queries[1].includes('JOIN latest_slot s USING (slot_at)'))
  assert.ok(
    queries[1].indexOf('WITH latest_slot AS') < queries[1].indexOf("WHERE m.status = 'issued'"),
  )
  assert.ok(queries[2].includes('WITH latest_twyne_issue AS MATERIALIZED'))
  assert.ok(queries[2].includes('ORDER BY slot_at DESC, issued_at DESC'))
  assert.ok(
    queries[2].indexOf('WITH latest_twyne_issue AS MATERIALIZED') <
      queries[2].indexOf("WHERE i.status = 'issued'"),
  )
  assert.ok(queries[2].indexOf('LIMIT 1') < queries[2].indexOf("WHERE i.status = 'issued'"))
})

test('a newer failed Twyne slot cannot be hidden by an older issued slot', async () => {
  const { genericRows, twyneRows } = await fixture()
  const sql = async (strings) => {
    const query = strings.join('?')
    if (query.includes('FROM pg_trigger')) {
      return MODEL_GUARD_EXPECTATIONS.map((expected) => ({
        table_name: expected.table,
        tgname: expected.trigger,
        enabled: 'O',
        function_name: expected.functionName,
        definition: `CREATE TRIGGER ${expected.trigger} BEFORE ${expected.events.join(
          ' OR ',
        )} ON ${expected.table} FOR EACH ${expected.level} EXECUTE FUNCTION ${expected.functionName}()`,
        function_definition: (MODEL_GUARD_FUNCTION_MARKERS[expected.functionName] ?? []).join(' '),
      }))
    }
    if (query.includes('FROM carry_cash_model_attempts')) return genericRows
    if (
      query.includes('WITH latest_twyne_issue AS MATERIALIZED') &&
      query.indexOf('LIMIT 1') < query.indexOf("WHERE i.status = 'issued'")
    ) {
      return []
    }
    return twyneRows
  }

  const result = await auditCoverage(sql)
  assert.equal(result.valid, false)
  assert.equal(result.genericFutureH1, 66)
  assert.equal(result.twynePtFutureH1, 0)
  assert.ok(result.missing.includes(`${TWYNE_PT_RESERVE.routeKey} @ ${TWYNE_PT_RESERVE.wrapper}`))
})
