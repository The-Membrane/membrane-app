import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  pendingSghoScorePlans,
  runSghoScoreSweep,
} from './record-carry-public-sgho-exit-scores.mjs'

const ORIGINS = ['https://one.example/', 'https://two.example/', 'https://three.example/']
const at = (hour) => new Date(Date.UTC(2026, 8, 30, hour)).toISOString()

function issue(sequence, { measured = true, targetHour = 1 } = {}) {
  return {
    sequence,
    baseline: { canonicalityEvidenceDoc: { provider: ORIGINS[0] } },
    baselineWitness: { provider: ORIGINS[1] },
    cases: [
      measured
        ? { status: 'measured', measurement: { baselineStatus: 'success' } }
        : { status: 'unavailable' },
    ],
    targets: [
      { horizonHours: 1, targetAtUtc: at(targetHour), captureDeadlineUtc: at(targetHour + 2) },
    ],
  }
}

test('only due positive-baseline plans without a sealed score are scheduled', () => {
  const issues = [issue(1), issue(2, { measured: false }), issue(3, { targetHour: 4 })]
  assert.deepEqual(
    pendingSghoScorePlans(issues, [{ issueSequence: 1, horizonHours: 1 }], at(2)),
    [],
  )
  assert.deepEqual(
    pendingSghoScorePlans(issues, [], at(2)).map((row) => row.issueSequence),
    [1],
  )
})

test('new H1 is attempted before old retries and a second origin pair can recover', async () => {
  const issues = Array.from({ length: 8 }, (_, index) => issue(index + 1))
  issues.push(issue(9, { targetHour: 2 }))
  const calls = []
  const result = await runSghoScoreSweep({
    issues,
    scores: [],
    urls: ORIGINS,
    now: () => new Date(at(2)),
    clientsFor: (pair) => pair,
    score: async ({ issueSequence, clients }) => {
      calls.push({ issueSequence, clients })
      return clients[0] === ORIGINS[0]
        ? { status: 'retry_target_unavailable' }
        : { status: 'scored' }
    },
  })
  assert.equal(calls[0].issueSequence, 9)
  assert.deepEqual(calls[0].clients, [ORIGINS[0], ORIGINS[1]])
  assert.ok(calls.some((call) => call.issueSequence === 9 && call.clients[0] !== ORIGINS[0]))
  assert.equal(result.scored, 6)
  assert.equal(result.due, 9)
})

test('unavailable pair attempts remain retriable and expose no source data in summary', async () => {
  const result = await runSghoScoreSweep({
    issues: [issue(1)],
    scores: [],
    urls: ORIGINS,
    now: () => new Date(at(2)),
    clientsFor: (pair) => pair,
    score: async () => ({ status: 'retry_replay_unavailable' }),
  })
  assert.deepEqual(result, {
    due: 1,
    attempted: 1,
    scored: 0,
    retries: 1,
    skippedNoBaseline: 0,
  })
  assert.ok(!JSON.stringify(result).includes('example'))
})
