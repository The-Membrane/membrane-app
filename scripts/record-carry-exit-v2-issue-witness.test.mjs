import test from 'node:test'
import assert from 'node:assert/strict'

import {
  committedWitnessStatus,
  observeCommittedIssues,
  readCommittedWitness,
  readUnwitnessedBatches,
  writeCommittedWitness,
} from './record-carry-exit-v2-issue-witness.mjs'

const complete = (id, extras = {}) => ({
  batch_id: String(id),
  route_key: `route-${id}`,
  before_h1: true,
  expected_cases: 2,
  actual_cases: 2,
  actual_plans: 10,
  ...extras,
})
const witness = (id, extras = {}) => ({
  batch_id: String(id),
  plan_matches: true,
  cases_match: true,
  plans_match: true,
  persisted_cases_match: true,
  persisted_plans_match: true,
  witnessed_before_h1: true,
  read_before_h1: true,
  ...extras,
})

test('complete committed issue is written once and independently read before H1', async () => {
  const calls = []
  const result = await observeCommittedIssues({
    readPending: async (limit) => {
      assert.equal(limit, 65)
      calls.push('read_pending')
      return [complete(1)]
    },
    writeWitness: async (id) => calls.push(`write_${id}`),
    readWitness: async (id) => {
      calls.push(`fresh_read_${id}`)
      return witness(id)
    },
  })
  assert.deepEqual(calls, ['read_pending', 'write_1', 'fresh_read_1'])
  assert.deepEqual(result.counts, { witnessed: 1 })
  assert.deepEqual(result.routes, [{ routeKey: 'route-1', status: 'witnessed' }])
  assert.equal(result.futureExitForecast, false)
})

test('late and incomplete batches never receive a witness write', async () => {
  let writes = 0
  const result = await observeCommittedIssues({
    readPending: async () => [
      complete(1, { before_h1: false }),
      complete(2, { actual_plans: 5 }),
      complete(3, { actual_cases: 1 }),
    ],
    writeWitness: async () => writes++,
    readWitness: async () => {
      throw Error('should_not_read')
    },
  })
  assert.equal(writes, 0)
  assert.deepEqual(result.counts, { issue_late_unwitnessed: 1, issue_incomplete: 2 })
})

test('ambiguous write response still reads a committed witness', async () => {
  const result = await observeCommittedIssues({
    readPending: async () => [complete(1)],
    writeWitness: async () => {
      throw Error('timeout after commit')
    },
    readWitness: async () => witness(1),
  })
  assert.equal(result.routes[0].status, 'witnessed')
})

test('ambiguous write without a readable witness stays uncertain', async () => {
  const result = await observeCommittedIssues({
    readPending: async () => [complete(1)],
    writeWitness: async () => {
      throw Error('timeout')
    },
    readWitness: async () => null,
  })
  assert.equal(result.routes[0].status, 'witness_write_uncertain')
})

test('read after H1, mismatched plan, and read failure cannot be admitted', async () => {
  const result = await observeCommittedIssues({
    readPending: async () => [complete(1), complete(2), complete(3)],
    writeWitness: async () => {},
    readWitness: async (id) => {
      if (id === '1') return witness(id, { read_before_h1: false })
      if (id === '2') return witness(id, { plan_matches: false })
      throw Error('read_failed')
    },
  })
  assert.deepEqual(result.counts, {
    witness_read_late: 1,
    witness_mismatch: 1,
    witness_read_uncertain: 1,
  })
})

test('scan and output remain bounded', async () => {
  const result = await observeCommittedIssues({
    maxBatches: 2,
    readPending: async () => [
      complete(1, { before_h1: false }),
      complete(2, { before_h1: false }),
      complete(3),
    ],
    writeWitness: async () => {
      throw Error('should_not_write')
    },
    readWitness: async () => {
      throw Error('should_not_read')
    },
  })
  assert.equal(result.scanned, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.routes.length, 2)
})

test('database adapters use separate tagged requests and reject unsafe IDs', async () => {
  const queries = []
  const sql = (strings, ...values) => {
    queries.push({ query: strings.join('?'), values })
    if (queries.length === 1) return [{ batch_id: '1' }]
    if (queries.length === 2) return [{ observed_at: '2026-09-30T01:00:00Z' }]
    return [witness(1)]
  }
  await readUnwitnessedBatches(sql, 3)
  await writeCommittedWitness(sql, '1')
  await readCommittedWitness(sql, '1')
  assert.equal(queries.length, 3)
  assert.deepEqual(
    queries.map(({ values }) => values),
    [[3], ['1'], ['1']],
  )
  await assert.rejects(
    () => writeCommittedWitness(sql, '1;DROP TABLE x'),
    /witness_batch_id_invalid/,
  )
})

test('a witness with any missing persisted proof is not admitted', () => {
  assert.equal(
    committedWitnessStatus(witness(1, { persisted_plans_match: false }), '1'),
    'witness_mismatch',
  )
  assert.equal(
    committedWitnessStatus(witness(1, { witnessed_before_h1: false }), '1'),
    'witness_late',
  )
  assert.equal(committedWitnessStatus(witness(2), '1'), 'witness_mismatch')
})
