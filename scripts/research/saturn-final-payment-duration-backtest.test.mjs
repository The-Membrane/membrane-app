import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyPayouts } from './saturn-queue-claim-payouts.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import { verifyQueueEvents } from './saturn-queue-event-cohort.mjs'
import {
  buildSaturnFinalPaymentBacktest,
  readVerifiedSaturnFinalPaymentBacktest,
  scoreCensoringAwareHorizon,
} from './saturn-final-payment-duration-backtest.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'
import { verifyBoundary } from './saturn-queue-upgrade-boundary.mjs'

const verifiedSources = () =>
  Promise.all([
    verifyQueueEvents(),
    verifyEpisodes(),
    verifyPayouts(),
    verifyPending(),
    verifyBoundary(),
  ]).then(([events, episodes, payouts, pending, boundary]) => ({
    events,
    episodes,
    payouts,
    pending,
    boundary,
  }))

test('fixed-horizon bounds hide future payments and preserve both censoring kinds', () => {
  const request = (requestTimestamp, finalPayment = null) => ({
    requestTimestamp,
    finalPayment,
  })
  const payment = (blockNumber, durationLowerSeconds, durationUpperSeconds) => ({
    blockNumber,
    durationLowerSeconds,
    durationUpperSeconds,
  })
  const rows = [
    request(100, payment(10, 2_000, 3_000)), // certainly paid by 1h
    request(100, payment(11, 3_000, 4_000)), // payment time crosses 1h
    request(100, payment(12, 4_000, 4_500)), // certainly unpaid at 1h
    request(100, payment(20, 2_000, 3_000)), // future event must stay hidden
    request(4_500), // right-censored before 1h
  ]
  assert.deepEqual(
    scoreCensoringAwareHorizon(
      rows,
      { blockNumber: 15, blockRule: 'inclusive', timestamp: 5_000 },
      1,
    ),
    {
      horizonHours: 1,
      subjects: 5,
      paidByHorizonCertain: 1,
      unpaidAtHorizonCertain: 2,
      paymentTimeIntervalCensored: 1,
      rightCensoredBeforeHorizon: 1,
      historicalPaymentFractionBounds: { lower: 0.2, upper: 0.6 },
      historicalSurvivalFractionBounds: { lower: 0.4, upper: 0.8 },
    },
  )
})

test('sealed cohort produces separate processing and exact-holder payment summaries', async () => {
  const report = await readVerifiedSaturnFinalPaymentBacktest()
  assert.equal(report.study, 'saturn_final_holder_payment_duration_backtest_v1')
  assert.equal(report.cohort.requests, 146)
  assert.equal(report.cohort.verifiedFinalHolderPayments, 77)
  assert.equal(report.cohort.finalPaymentTransactions, 76)
  assert.equal(report.cohort.exactHolderMatches, 77)
  assert.equal(report.scope.routeFinalAusdPaymentAssessed, false)
  assert.equal(report.fullCohortAtCutoff.requestToProcessing.visibleCompletions, 106)
  assert.equal(report.fullCohortAtCutoff.requestToFinalHolderPayment.visibleVerifiedPayments, 77)
  assert.deepEqual(
    report.fullCohortAtCutoff.requestToFinalHolderPayment.horizons.map((row) => row.horizonHours),
    [24, 72, 168, 336, 672],
  )
  assert.deepEqual(report.fullCohortAtCutoff.requestToFinalHolderPayment.horizons[0], {
    horizonHours: 24,
    subjects: 146,
    paidByHorizonCertain: 0,
    unpaidAtHorizonCertain: 112,
    paymentTimeIntervalCensored: 32,
    rightCensoredBeforeHorizon: 2,
    historicalPaymentFractionBounds: { lower: 0, upper: 34 / 146 },
    historicalSurvivalFractionBounds: { lower: 112 / 146, upper: 1 },
  })
})

test('chronological development excludes later knowledge and retains the regime shift', async () => {
  const report = await readVerifiedSaturnFinalPaymentBacktest()
  assert.equal(report.chronologicalSplit.development.subjects, 73)
  assert.equal(report.chronologicalSplit.holdout.subjects, 73)
  assert.equal(
    report.chronologicalSplit.development.requestToFinalHolderPayment.visibleVerifiedPayments,
    28,
  )
  assert.equal(report.chronologicalSplit.development.verifiedPaymentsLearnedAfterSplitExcluded, 30)
  assert.equal(
    report.chronologicalSplit.holdout.requestToFinalHolderPayment.visibleVerifiedPayments,
    19,
  )
  assert.equal(report.chronologicalSplit.development.queueV2Requests, 0)
  assert.equal(report.chronologicalSplit.holdout.queueV2Requests, 10)
  assert.equal(report.chronologicalSplit.boundaryKnownAtDevelopmentAsOf, false)
  assert.equal(report.validation.status, 'not_validated')
  assert.equal(report.validation.forecastValidated, false)
})

test('joined subjects retain amounts, earlier-open cohort counts, and payment semantics', async () => {
  const report = await readVerifiedSaturnFinalPaymentBacktest()
  assert.equal(report.cutoffQueueContext.exactCohortPendingTickets, 40)
  assert.equal(report.cutoffQueueContext.pendingSharesRaw, '1379374617061236731341170')
  assert.equal(report.cutoffQueueContext.pendingNetUsdatQuoteRaw, '1427132427842')
  assert.equal(report.savedImplementationBoundary.requestsByRegime.queueV1, 136)
  assert.equal(report.savedImplementationBoundary.requestsByRegime.queueV2, 10)
  assert.equal(report.cohort.observedEarlierOpenCohortAtRequest.tickets.max, 50)

  const first = report.subjects.find((row) => row.ticketId === '1530')
  assert.equal(first.requestSharesRaw, '4794759748864790328667')
  assert.equal(first.observedEarlierOpenCohortAtRequest.earlierOpenCohortTickets, 0)
  assert.equal(first.processing.durationSeconds, 80_352)
  assert.equal(first.finalPayment.holder, first.finalHolder)
  assert.equal(first.finalPayment.amountRaw, first.processing.usdatOwedRaw)
  assert.equal(first.finalPayment.durationLowerSeconds, 80_352)
  assert.equal(first.finalPayment.durationUpperSeconds, 188_256)

  const paid = report.subjects.filter((row) => row.finalPayment)
  assert.equal(paid.length, 77)
  assert.ok(
    paid.every(
      (row) =>
        row.finalPayment.holder === row.finalHolder &&
        row.finalPayment.amountRaw === row.processing.usdatOwedRaw &&
        row.finalPayment.durationLowerSeconds >= row.processing.durationSeconds &&
        row.finalPayment.durationUpperSeconds >= row.finalPayment.durationLowerSeconds &&
        row.finalPayment.afterProcessingLowerSeconds >= 0,
    ),
  )

  const aggregate = report.subjects.filter(
    (row) => row.finalPayment?.settlementEvidence === 'exact_transaction_holder_aggregate_transfer',
  )
  assert.deepEqual(
    aggregate.map((row) => row.ticketId),
    ['1609', '1610'],
  )
  assert.ok(aggregate.every((row) => row.finalPayment.transactionHolderTicketCount === 2))
})

test('join fails closed on a resealed-looking holder or amount mismatch', async () => {
  const sources = await verifiedSources()
  const wrongHolder = structuredClone(sources)
  wrongHolder.payouts.transactions[0].payouts[0].to = '0x0000000000000000000000000000000000000001'
  assert.throws(() => buildSaturnFinalPaymentBacktest(wrongHolder), /holder_or_amount_mismatch/)

  const wrongAmount = structuredClone(sources)
  wrongAmount.payouts.transactions[0].payouts[0].amountRaw = (
    BigInt(wrongAmount.payouts.transactions[0].payouts[0].amountRaw) + 1n
  ).toString()
  assert.throws(() => buildSaturnFinalPaymentBacktest(wrongAmount), /holder_or_amount_mismatch/)
})
