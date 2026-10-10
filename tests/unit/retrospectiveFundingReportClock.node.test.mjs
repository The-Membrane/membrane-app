import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildRetrospectiveFundingReport } from '../../scripts/research/retrospective-native-funding-backtest.mjs'
const acquiredAt = '2026-10-08T00:35:29.410Z'
const saved =
  'data/research/venue-signals/retrospective-native-funding-backtest-2026-10-08T02-34-33-final.json'
const savedPin = 'b3d1bd6359b521d4bf2d144bc703ea8b3834df92ce6ffa7203e3c26bdf5543be'
const hash = (text) => createHash('sha256').update(text).digest('hex')
test('exported builder rejects future and malformed analysis clocks before loading evidence', () => {
  assert.throws(
    () => buildRetrospectiveFundingReport(new Date(Date.now() + 3600000).toISOString()),
    /analysis_clock_in_future/,
  )
  assert.throws(() => buildRetrospectiveFundingReport('malformed'), /invalid_analysis_clock/)
})
test('pinned Apy evidence remains acquisition-censored one millisecond before availability', () => {
  const before = new Date(Date.parse(acquiredAt) - 1).toISOString()
  const report = buildRetrospectiveFundingReport(before)
  assert.equal(report.apyJoint.reason, 'history_not_acquired_at_analysis')
  assert.equal(report.apyJoint.acquisitionAtUtc, acquiredAt)
  assert.equal(report.apyJoint.status, 'censored')
  assert.equal(report.apyJoint.probability, null)
  assert.equal(hash(readFileSync(saved)), savedPin)
})
test('at exact Apy availability the remaining censor is insufficient joint train and holdout', () => {
  const report = buildRetrospectiveFundingReport(acquiredAt)
  assert.equal(report.apyJoint.reason, 'insufficient_joint_train_and_holdout')
  assert.equal(report.apyJoint.acquisitionAtUtc, acquiredAt)
  assert.equal(report.apyJoint.pairedAnchors, 2)
  assert.equal(report.apyJoint.probability, null)
  assert.equal(hash(readFileSync(saved)), savedPin)
})
