import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  diagnoseSaturnQueueProcessing,
  readVerifiedSaturnProcessingDiagnostic,
} from './saturn-queue-processing-backtest.mjs'

const processed = (ticketId, requestTimestamp, waitSeconds) => ({
  ticketId: String(ticketId),
  requestBlock: ticketId,
  requestTimestamp,
  waitSeconds,
  waitCensored: false,
})
const pending = (ticketId, requestTimestamp, finalCutoffTimestamp) => ({
  ticketId: String(ticketId),
  requestBlock: ticketId,
  requestTimestamp,
  waitSeconds: finalCutoffTimestamp - requestTimestamp,
  waitCensored: true,
})

test('chronological diagnostic censors unknown 24h outcomes at each as-of time', () => {
  const finalCutoff = 140
  const episodes = [
    processed(1, 50, 5),
    processed(2, 60, 50), // processed after the split; 24h failure was already known
    processed(3, 95, 8), // later success is invisible at the split
    processed(4, 100, 5),
    processed(5, 110, 15),
    pending(6, 120, finalCutoff), // sufficiently followed up: failure
    pending(7, 135, finalCutoff), // right-censored before horizon
  ]
  const result = diagnoseSaturnQueueProcessing(episodes, finalCutoff, { horizonSeconds: 10 })
  assert.equal(result.split.atUtc, new Date(100_000).toISOString())
  assert.deepEqual(result.train, {
    requested: 3,
    evaluable: 2,
    processedWithinHorizon: 1,
    notProcessedWithinHorizon: 1,
    censored: 1,
    observedRate: 0.5,
  })
  assert.deepEqual(result.later, {
    requested: 4,
    evaluable: 3,
    processedWithinHorizon: 1,
    notProcessedWithinHorizon: 2,
    censored: 1,
    observedRate: 1 / 3,
  })
  assert.equal(result.comparison.expectedLaterProcessed, 1.5)
  assert.equal(result.prospectiveValidated, false)
  assert.equal(result.fullRouteExitAssessed, false)
})

test('early-censored and duplicate tickets cannot silently become 24h failures', () => {
  const episodes = [
    processed(1, 50, 5),
    processed(2, 60, 7),
    pending(3, 70, 140),
    pending(4, 100, 140),
  ]
  assert.throws(
    () =>
      diagnoseSaturnQueueProcessing(
        [...episodes.slice(0, 2), { ...episodes[2], waitSeconds: 15 }, episodes[3]],
        140,
        { horizonSeconds: 10 },
      ),
    /episode_invalid/,
  )
  assert.throws(
    () => diagnoseSaturnQueueProcessing([...episodes.slice(0, 3), episodes[0]], 140),
    /episode_invalid/,
  )
})

test('verified Saturn cohort shows large later processing-rate deterioration', async () => {
  const result = await readVerifiedSaturnProcessingDiagnostic()
  assert.equal(result.horizonSeconds, 86_400)
  assert.equal(result.train.requested, 73)
  assert.equal(result.train.evaluable, 69)
  assert.equal(result.train.processedWithinHorizon, 67)
  assert.equal(result.later.requested, 73)
  assert.equal(result.later.evaluable, 71)
  assert.equal(result.later.processedWithinHorizon, 18)
  assert.ok(result.comparison.absoluteRateError > 0.7)
  assert.equal(result.prospectiveValidated, false)
  assert.equal(result.fullRouteExitAssessed, false)
})
