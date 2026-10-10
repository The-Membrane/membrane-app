import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readVerifiedApyUsdTimingDiagnostic,
  scorePaymentHorizon,
} from './apyusd-receipt-timing-backtest.mjs'

const DAY = 86_400

test('as-of scoring censors future payment knowledge and resolves matured negatives', () => {
  const rows = [
    { issuedAt: DAY, paidAt: 3 * DAY },
    { issuedAt: DAY, paidAt: 10 * DAY },
    { issuedAt: DAY, paidAt: null },
  ]
  assert.deepEqual(scorePaymentHorizon(rows, 2 * DAY, 7), {
    days: 7,
    paid: 0,
    notPaid: 0,
    censored: 3,
    evaluable: 0,
  })
  assert.deepEqual(scorePaymentHorizon(rows, 8 * DAY, 7), {
    days: 7,
    paid: 1,
    notPaid: 2,
    censored: 0,
    evaluable: 3,
  })
})

test('verified cohort has only three knowable seven-day training outcomes at chronological split', async () => {
  const diagnostic = await readVerifiedApyUsdTimingDiagnostic()
  assert.equal(diagnostic.cohort, 96)
  assert.equal(diagnostic.splitAtUtc, '2026-08-27T16:49:35.000Z')
  assert.equal(diagnostic.train.requests, 48)
  assert.equal(diagnostic.train.knownPayoutsAtSplit, 3)
  assert.deepEqual(
    diagnostic.train.horizons.find((row) => row.days === 7),
    {
      days: 7,
      paid: 3,
      notPaid: 0,
      censored: 45,
      evaluable: 3,
    },
  )
  assert.deepEqual(
    diagnostic.holdout.horizons.find((row) => row.days === 7),
    {
      days: 7,
      paid: 9,
      notPaid: 39,
      censored: 0,
      evaluable: 48,
    },
  )
  assert.equal(diagnostic.holdout.holdersAlsoInTrain, 3)
  assert.equal(diagnostic.forecastValidated, false)
})
