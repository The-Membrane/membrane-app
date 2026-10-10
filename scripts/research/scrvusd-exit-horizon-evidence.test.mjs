import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SCHEMA as EVALUATION_SCHEMA } from './scrvusd-exit-duration-evaluation.mjs'
import { buildHorizonEvidence, readHorizonEvidence } from './scrvusd-exit-horizon-evidence.mjs'

const base = Date.parse('2026-09-28T00:00:00.000Z')
const at = (seconds) => new Date(base + seconds * 1000).toISOString()
const issue = (id) => ({ filename: `${id}.json`, logicalSha256: id, physicalSha256: id })
const row = (id, evidenceClass, extra = {}) => ({
  issue: issue(id),
  issuedAtUtc: at(100),
  horizonSeconds: 3600,
  evidenceClass,
  scoreStatus: ['not_yet_due', 'capture_window_open', 'matured_unscored', 'pending_other'].includes(
    evidenceClass,
  )
    ? 'pending'
    : 'observed',
  scoredAtUtc: ['not_yet_due', 'capture_window_open', 'matured_unscored', 'pending_other'].includes(
    evidenceClass,
  )
    ? null
    : at(1100),
  firstLossInterval: null,
  latestCleanSampledSuccessOffsetSeconds: null,
  ...extra,
})
const interval = (start, end) => ({
  intervalStartUtc: at(100 + start),
  intervalEndUtc: at(100 + end),
  signedSecondsFromIssueAtStart: start,
  signedSecondsFromIssueAtEnd: end,
})
const evaluation = (rows, asOfUtc = at(1200)) => ({
  schema: EVALUATION_SCHEMA,
  asOfUtc,
  requestedHorizonsSeconds: [200],
  rows,
  dependentClusters: rows.length
    ? [{ id: 'one-overlapping-vault-window', issues: rows.map((item) => item.issue) }]
    : [],
})

test('flexible issue-time horizons classify interval boundaries without treating rows as independent', () => {
  const rows = [
    row('ended', 'first_loss_interval', { firstLossInterval: interval(-50, 200) }),
    row('straddle', 'first_loss_interval', { firstLossInterval: interval(100, 300) }),
    row('later', 'first_loss_interval', { firstLossInterval: interval(300, 500) }),
    row('early-censor', 'right_censored', { latestCleanSampledSuccessOffsetSeconds: 199 }),
    row('exact-censor', 'right_censored', { latestCleanSampledSuccessOffsetSeconds: 200 }),
  ]
  const result = buildHorizonEvidence(evaluation(rows), [300, 200, 200])
  assert.deepEqual(result.requestedHorizonsSeconds, [200, 300])
  const at200 = result.byHorizon[0]
  assert.equal(at200.counts.firstLossIntervalEndedByHorizon, 1)
  assert.equal(at200.counts.firstLossIntervalStraddlesHorizon, 1)
  assert.equal(at200.counts.firstLossIntervalStartsAfterHorizon, 1)
  assert.equal(at200.counts.rightCensoredBeforeHorizon, 1)
  assert.equal(at200.counts.rightCensoredAtOrAfterHorizon, 1)
  assert.equal(at200.dependence.dependencyComponentCount, 1)
  assert.equal(at200.dependence.multiIssueDependencyComponentCount, 1)
  assert.equal(at200.dependence.independentEpisodeCount, null)
  assert.equal(result.byHorizon[1].counts.firstLossIntervalEndedByHorizon, 2)
  assert.equal(result.byHorizon[1].counts.firstLossIntervalStraddlesHorizon, 0)
  assert.equal(result.byHorizon[1].counts.firstLossIntervalStartsAfterHorizon, 1)
  assert.equal(result.forecastEligible, false)
  assert.deepEqual(result.forecast, { probability: null, likelyDurationSeconds: null })
})

test('pending, missing, provider ambiguity and ambiguous censor do not become survival evidence', () => {
  const rows = [
    row('pending', 'not_yet_due'),
    row('window', 'capture_window_open'),
    row('matured', 'matured_unscored'),
    row('unknown-pending', 'pending_other'),
    row('missing', 'missing'),
    row('provider', 'provider_ambiguous'),
    row('ambiguous', 'right_censored_ambiguous'),
    row('point', 'point_success_only'),
    row('bad-loss', 'first_loss_interval', { firstLossInterval: interval(-100, -50) }),
  ]
  const result = buildHorizonEvidence(evaluation(rows), [3600]).byHorizon[0]
  assert.equal(result.counts.pendingNotYetDue, 1)
  assert.equal(result.counts.pendingCaptureWindowOpen, 1)
  assert.equal(result.counts.pendingMaturedUnscored, 1)
  assert.equal(result.counts.pendingUnknown, 1)
  assert.equal(result.counts.missing, 1)
  assert.equal(result.counts.providerAmbiguous, 1)
  assert.equal(result.counts.ambiguousCensor, 1)
  assert.equal(result.counts.pointOnlyOrUnclassified, 1)
  assert.equal(result.counts.invalidTemporalEvidence, 1)
})

test('pending longer follow-up crosses the requested horizon without becoming outcome evidence', () => {
  const pendingLong = row('long-pending', 'not_yet_due', { horizonSeconds: 3600 })
  const before = buildHorizonEvidence(evaluation([pendingLong], at(299)), [200]).byHorizon[0]
  const atTarget = buildHorizonEvidence(evaluation([pendingLong], at(300)), [200]).byHorizon[0]
  assert.equal(before.counts.pendingNotYetDue, 1)
  assert.equal(before.counts.pendingRequestedHorizonPassedLongerFollowUp, 0)
  assert.equal(atTarget.counts.pendingNotYetDue, 0)
  assert.equal(atTarget.counts.pendingRequestedHorizonPassedLongerFollowUp, 1)
  assert.equal(atTarget.counts.rightCensoredAtOrAfterHorizon, 0)
  assert.equal(atTarget.counts.firstLossIntervalEndedByHorizon, 0)
  assert.throws(
    () =>
      buildHorizonEvidence(
        evaluation(
          [
            row('future-score-long', 'point_success_only', {
              horizonSeconds: 3600,
              scoredAtUtc: at(301),
            }),
          ],
          at(300),
        ),
        [200],
      ),
    /Score is not available at requested as-of/,
  )
})

test('no observed losses leaves loss cells empty and no duration estimate', () => {
  const result = buildHorizonEvidence(
    evaluation([row('clean', 'right_censored', { latestCleanSampledSuccessOffsetSeconds: 500 })]),
    [200],
  )
  assert.equal(result.byHorizon[0].counts.firstLossIntervalEndedByHorizon, 0)
  assert.equal(result.byHorizon[0].counts.rightCensoredAtOrAfterHorizon, 1)
  assert.equal(result.forecast.likelyDurationSeconds, null)
})

test('an issue cannot enter a requested horizon longer than its enrolled follow-up', () => {
  const short = row('one-hour', 'first_loss_interval', {
    horizonSeconds: 3600,
    firstLossInterval: interval(1800, 5400),
  })
  const long = row('two-hour', 'right_censored', {
    horizonSeconds: 7200,
    latestCleanSampledSuccessOffsetSeconds: 7200,
  })
  const result = buildHorizonEvidence(evaluation([short, long], at(10000)), [3600, 7200])
  assert.equal(result.allIssuedObservations, 2)
  assert.equal(result.byHorizon[0].issuedObservations, 2)
  assert.equal(result.byHorizon[1].allIssuedObservations, 2)
  assert.equal(result.byHorizon[1].issuedObservations, 1)
  assert.equal(result.byHorizon[1].counts.notEnrolledForHorizon, 1)
  assert.equal(result.byHorizon[1].counts.firstLossIntervalEndedByHorizon, 0)
  assert.equal(result.byHorizon[1].counts.rightCensoredAtOrAfterHorizon, 1)
  assert.equal(result.byHorizon[1].dependence.dependencyComponentCount, 1)
  assert.equal(result.byHorizon[1].dependence.multiIssueDependencyComponentCount, 0)
})

test('requested horizon work is bounded', () => {
  assert.throws(
    () =>
      buildHorizonEvidence(
        evaluation([]),
        Array.from({ length: 65 }, (_, i) => i + 1),
      ),
    /Invalid exit duration evaluation or horizons/,
  )
})

test('future issue, future score and future interval evidence cannot enter an as-of table', () => {
  assert.throws(
    () =>
      buildHorizonEvidence(
        evaluation([row('future-issue', 'not_yet_due', { issuedAtUtc: at(1300) })]),
        [200],
      ),
    /not available at requested as-of/,
  )
  assert.throws(
    () =>
      buildHorizonEvidence(
        evaluation([row('future-score', 'point_success_only', { scoredAtUtc: at(1300) })]),
        [200],
      ),
    /not available at requested as-of/,
  )
  const futureLoss = row('future-loss', 'first_loss_interval', {
    firstLossInterval: interval(100, 1200),
  })
  assert.equal(
    buildHorizonEvidence(evaluation([futureLoss]), [200]).byHorizon[0].counts
      .invalidTemporalEvidence,
    1,
  )
  const malformed = row('bad-offset', 'first_loss_interval', {
    firstLossInterval: { ...interval(100, 200), signedSecondsFromIssueAtStart: -999 },
  })
  assert.equal(
    buildHorizonEvidence(evaluation([malformed]), [200]).byHorizon[0].counts
      .invalidTemporalEvidence,
    1,
  )
})

test('real verified read remains research-only as the prospective corpus grows', () => {
  const result = readHorizonEvidence({ asOfUtc: new Date().toISOString(), horizons: [3600, 86400] })
  for (const horizon of result.byHorizon) {
    assert.equal(horizon.allIssuedObservations, result.allIssuedObservations)
    assert.equal(
      Object.values(horizon.counts).reduce((sum, count) => sum + count, 0),
      result.allIssuedObservations,
    )
    assert.equal(
      horizon.issuedObservations + horizon.counts.notEnrolledForHorizon,
      result.allIssuedObservations,
    )
  }
  assert.equal(result.evidenceLevel, 'research_only')
  assert.equal(result.forecastEligible, false)
  assert.deepEqual(result.forecast, { probability: null, likelyDurationSeconds: null })
})
