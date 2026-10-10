import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  assertModelGuards,
  MODEL_GUARD_EXPECTATIONS,
  MODEL_GUARD_FUNCTION_MARKERS,
} from './apply-carry-cash-model-ddl.mjs'

function installedGuardRows() {
  return MODEL_GUARD_EXPECTATIONS.map((expected) => ({
    table_name: expected.table,
    tgname: expected.trigger,
    enabled: 'O',
    function_name: expected.functionName,
    definition: `CREATE TRIGGER ${expected.trigger} BEFORE ${expected.events.join(
      ' OR ',
    )} ON public.${expected.table} FOR EACH ${expected.level} EXECUTE FUNCTION public.${expected.functionName}()`,
    function_definition: `CREATE FUNCTION ${expected.functionName}() RETURNS trigger AS '${(
      MODEL_GUARD_FUNCTION_MARKERS[expected.functionName] ?? []
    ).join(' ')}'`,
  }))
}

function sqlFixture() {
  const queries = []
  const sql = async (strings) => {
    const query = strings.join('?')
    queries.push(query)
    if (query.includes('FROM pg_trigger t')) return installedGuardRows()
    if (query.includes('SELECT activated_at FROM carry_cash_model_v4_epoch'))
      return [{ activated_at: '2026-10-05T00:00:00.000Z' }]
    return []
  }
  sql.query = async (query) => {
    queries.push(query)
    return []
  }
  return { sql, queries }
}

test('installs v4-only registration and issuance guards before sealing the epoch', async () => {
  const { sql, queries } = sqlFixture()
  await apply(sql)
  const joined = queries.join('\n')
  const preflight = queries.findIndex((query) => query.includes('FROM pg_trigger t'))
  const epochInsert = queries.findIndex((query) =>
    query.includes('INSERT INTO carry_cash_model_v4_epoch'),
  )
  assert.ok(preflight >= 0)
  assert.ok(epochInsert > preflight)
  assert.match(joined, /NEW\.model_version !~ '\^h\(delta\|band\)4-/)
  assert.match(joined, /NEW\.model_version ~ '\^hdelta4-'/)
  assert.match(joined, /historical_cash_delta_model_v1/)
  assert.match(joined, /NEW\.model_version ~ '\^hband4-'/)
  assert.match(joined, /historical_cash_persistence_band_v1/)
  assert.match(joined, /modelMae'.*numeratorRaw/s)
  assert.match(joined, /pointBeatsPersistence/s)
  assert.match(joined, /a\.model_version !~ '\^h\(delta\|band\)4-/)
  assert.match(joined, /b\.issued_at < \(SELECT activated_at FROM carry_cash_model_v4_epoch/)
  assert.match(joined, /a\.last_archive_anchor_at >= b\.source_observed_at/)
  const scoreGuard = queries.find((query) =>
    query.includes('CREATE OR REPLACE FUNCTION guard_carry_cash_model_score()'),
  )
  assert.ok(scoreGuard)
  assert.doesNotMatch(scoreGuard, /model_version|carry_cash_model_v4_epoch/)
})

test('guard preflight rejects disabled, wrong-function, and missing baseline immutability', async () => {
  for (const mutate of [
    (rows) => {
      rows[0].enabled = 'D'
    },
    (rows) => {
      rows[0].function_name = 'wrong_function'
    },
    (rows) => {
      rows[0].function_definition = 'CREATE FUNCTION noop() RETURNS trigger'
    },
    (rows) => {
      const index = rows.findIndex((row) => row.tgname === 'carry_cash_issue_attempts_immutable')
      rows.splice(index, 1)
    },
  ]) {
    const rows = installedGuardRows()
    mutate(rows)
    const sql = async () => rows
    await assert.rejects(() => assertModelGuards(sql), /cash_model_guards_missing/)
  }
})
