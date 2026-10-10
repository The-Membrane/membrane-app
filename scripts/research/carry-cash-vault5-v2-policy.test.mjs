import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  VAULT5_SUBJECTS,
  VAULT5_V2_POLICY_SHA256,
  assessVault5Subjects,
  fitVault5Parameters,
  projectVault5Cash,
} from './carry-cash-vault5-v2-policy.mjs'

test('the exact five identities and fixed parameter rule stay stable', () => {
  assert.equal(VAULT5_SUBJECTS.length, 5)
  assert.equal(new Set(VAULT5_SUBJECTS.map((row) => row.destination)).size, 5)
  assert.match(VAULT5_V2_POLICY_SHA256, /^[0-9a-f]{64}$/)
  const parameters = fitVault5Parameters(Array(60).fill('10'))
  assert.deepEqual(parameters, {
    pointDeltaRaw: '10',
    residualLowRaw: '0',
    residualHighRaw: '0',
    baselineLowRaw: '10',
    baselineHighRaw: '10',
  })
  assert.deepEqual(projectVault5Cash('100', parameters), {
    sourceCashRaw: '100',
    pointRaw: '110',
    lowRaw: '110',
    highRaw: '110',
    baselinePointRaw: '100',
    baselineLowRaw: '110',
    baselineHighRaw: '110',
  })
})

test('cohort cannot pass from pooled n or without each subject point skill', () => {
  const summary = assessVault5Subjects([], [], [])
  assert.equal(summary.cohortPassed, false)
  assert.equal(summary.bySubject.length, 5)
  assert.equal(
    summary.bySubject.every((row) => row.passed === false),
    true,
  )
})
