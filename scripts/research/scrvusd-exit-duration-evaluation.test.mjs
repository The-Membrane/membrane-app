import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outcomeProtocol } from './scrvusd-exit-forecast-issue.mjs'
import { SCHEMA as LABEL_SCHEMA } from './scrvusd-prospective-exit-labels.mjs'
import { evaluateLabels, readEvaluation } from './scrvusd-exit-duration-evaluation.mjs'

const start = Date.parse('2026-09-28T00:00:00.000Z')
const at = (seconds) => new Date(start + seconds * 1000).toISOString()
const holder = `0x${'1'.repeat(40)}`
const block = (number, timestamp = number) => ({
  number,
  hash: `0x${number.toString(16).padStart(64, '0')}`,
  timestamp: start / 1000 + timestamp,
})
const issue = (number, horizonSeconds = 7200, issuedSecond = 200) => ({
  issue: { filename: `${number}-${horizonSeconds}s.json`, logicalSha256: 'a', physicalSha256: 'b' },
  issuedAtUtc: at(issuedSecond),
  targetUtc: at(issuedSecond + horizonSeconds),
  anchorBlock: block(number, issuedSecond - 50),
  holder,
  qAssetsRaw: '1000',
  route: 'direct_erc4626_withdraw_crvusd_from_scrvusd',
  horizonOrigin: 'issue_time',
  horizonSeconds,
  baseline: { status: 'sampled_success', capturedAtUtc: at(issuedSecond - 20) },
  baselineCodeIdentity: { status: 'unverified' },
  historicalFlowStatus: 'as_of_context',
  historicalFlowContext: { maxGrossOutflowRaw: '9000', maxSignedNetOutflowRaw: '1000' },
  score: {
    status: 'pending',
    scoredAtUtc: null,
    evidenceCutoffUtc: null,
    pointOutcome: null,
    trajectory: null,
    sampledCodeIdentity: null,
  },
})
const labels = (asOfSecond, rows) => ({ schema: LABEL_SCHEMA, asOfUtc: at(asOfSecond), rows })
const scored = (
  row,
  { pointStatus = 'success', trajectory = null, scoredSecond = 10000 } = {},
) => ({
  ...row,
  score: {
    status: 'observed',
    scoredAtUtc: at(scoredSecond),
    evidenceCutoffUtc: outcomeProtocol(row.issuedAtUtc, row.horizonSeconds).checkpointSelection
      .captureDeadlineUtc,
    pointOutcome: { status: pointStatus },
    trajectory,
    sampledCodeIdentity: { status: 'unknown' },
  },
})

test('all issued rows remain denominator; requested horizons are caller chosen', () => {
  const a = issue(100, 3600)
  const b = issue(101, 7200)
  const result = evaluateLabels({
    labels: labels(300, [a, b]),
    horizons: [7200, 3600, 7200, 86400],
  })
  assert.deepEqual(result.requestedHorizonsSeconds, [3600, 7200, 86400])
  assert.deepEqual(
    result.byHorizon.map((item) => item.issued),
    [1, 1, 0],
  )
  assert.equal(result.denominators.allIssued, 2)
  assert.equal(result.denominators.requestedIssued, 2)
  assert.equal(result.denominators.independentEpisodeCount, null)
  assert.deepEqual(result.rows[0].historicalFlowContext, a.historicalFlowContext)
  assert.equal(result.rows[0].historicalFlowStatus, 'as_of_context')
  assert.equal(result.rows[0].baselineCapturedAtUtc, a.baseline.capturedAtUtc)
  assert.equal(result.forecast.status, 'unavailable')
  assert.equal(result.alert.status, 'unavailable')
})

test('unscored issue distinguishes not due, open capture, and matured without score', () => {
  const row = issue(100, 7200)
  const deadline = Date.parse(
    outcomeProtocol(row.issuedAtUtc, row.horizonSeconds).checkpointSelection.captureDeadlineUtc,
  )
  assert.equal(evaluateLabels({ labels: labels(300, [row]) }).rows[0].evidenceClass, 'not_yet_due')
  assert.equal(
    evaluateLabels({ labels: labels(7400, [row]) }).rows[0].evidenceClass,
    'capture_window_open',
  )
  assert.equal(
    evaluateLabels({ labels: { ...labels(0, [row]), asOfUtc: new Date(deadline).toISOString() } })
      .rows[0].evidenceClass,
    'matured_unscored',
  )
})

test('missing and provider ambiguity are distinct from right censor and point revert', () => {
  const base = issue(100)
  const cases = [
    [
      scored(base, {
        pointStatus: 'missing_quote_checkpoint',
        trajectory: { status: 'unavailable_missing_capture' },
      }),
      'missing',
    ],
    [
      scored(base, {
        pointStatus: 'provider_ambiguity',
        trajectory: {
          status: 'right_censored_ambiguous',
          censor: { reason: 'provider_ambiguity' },
        },
      }),
      'provider_ambiguous',
    ],
    [
      scored(base, {
        pointStatus: 'success',
        trajectory: {
          status: 'right_censored_at_last_sampled_success',
          latestCleanSampledSuccessBlock: block(150, 1000),
        },
      }),
      'right_censored',
    ],
    [
      scored(base, {
        pointStatus: 'revert',
        trajectory: {
          status: 'right_censored_ambiguous',
          censor: { reason: 'quote_sampling_gap' },
        },
      }),
      'right_censored_ambiguous',
    ],
    [scored(base, { pointStatus: 'revert' }), 'point_revert_unattributed'],
  ]
  for (const [row, expected] of cases)
    assert.equal(evaluateLabels({ labels: labels(11000, [row]) }).rows[0].evidenceClass, expected)
  const clean = evaluateLabels({ labels: labels(11000, [cases[2][0]]) }).rows[0]
  assert.equal(clean.latestCleanSampledSuccessOffsetSeconds, 800)
  assert.equal(clean.preFirstLossLastCleanSampleOffsetSeconds, null)
})

test('pre-issue first-loss start stays signed; later sampled recovery does not erase loss', () => {
  const base = issue(100)
  const loss = {
    intervalStartUtc: at(150),
    intervalEndUtc: at(400),
    intervalStartKind: 'pre_issue_anchor_sample',
    secondsFromIssueAtStart: -50,
    secondsFromIssueAtEnd: 200,
  }
  const row = scored(base, {
    pointStatus: 'success',
    trajectory: {
      status: 'first_loss_with_later_sampled_recovery',
      firstLoss: loss,
      recovery: { block: block(500, 500), sampledAtUtc: at(500) },
      preFirstLossLastCleanSuccessBlock: block(100, 150),
      latestCleanSampledSuccessBlock: block(500, 500),
      latestComparableStatus: 'sampled_success',
    },
  })
  const result = evaluateLabels({ labels: labels(11000, [row]) }).rows[0]
  assert.equal(result.evidenceClass, 'first_loss_interval')
  assert.equal(result.firstLossInterval.signedSecondsFromIssueAtStart, -50)
  assert.equal(result.firstLossInterval.positiveSampledLowerBoundSeconds, null)
  assert.equal(result.preFirstLossLastCleanSampleOffsetSeconds, -50)
  assert.equal(result.latestCleanSampledSuccessOffsetSeconds, 300)
  assert.equal(result.latestComparableStatus, 'sampled_success')
  assert.ok(result.laterSampledRecovery)
  const unverified = scored(base, {
    pointStatus: 'success',
    trajectory: {
      status: 'first_loss_with_later_unverified_success',
      firstLoss: loss,
      laterSampledSuccess: { block: block(500, 500), sampledAtUtc: at(500) },
      postLossCensor: { reason: 'quote_sampling_gap', atBlock: block(450, 450) },
    },
  })
  const unverifiedResult = evaluateLabels({ labels: labels(11000, [unverified]) }).rows[0]
  assert.equal(unverifiedResult.evidenceClass, 'first_loss_interval')
  assert.equal(unverifiedResult.laterSampledRecovery, null)
  assert.ok(unverifiedResult.laterUnverifiedSuccess)
  assert.equal(unverifiedResult.postLossCensor.reason, 'quote_sampling_gap')
  const relapse = scored(base, {
    pointStatus: 'revert',
    trajectory: {
      status: 'first_loss_with_later_sampled_recovery_and_relapse',
      firstLoss: loss,
      recovery: { block: block(500, 500), sampledAtUtc: at(500) },
      preFirstLossLastCleanSuccessBlock: block(100, 150),
      latestCleanSampledSuccessBlock: block(500, 500),
      relapses: [
        {
          ...loss,
          intervalStartKind: 'post_issue_clean_success_sample',
          secondsFromIssueAtStart: 300,
        },
      ],
      subsequentRecoveries: [],
      latestComparableStatus: 'sampled_revert',
    },
  })
  const relapseResult = evaluateLabels({ labels: labels(11000, [relapse]) }).rows[0]
  assert.equal(relapseResult.evidenceClass, 'first_loss_interval')
  assert.equal(relapseResult.firstLossInterval.signedSecondsFromIssueAtStart, -50)
  assert.equal(relapseResult.relapses.length, 1)
  assert.equal(relapseResult.latestComparableStatus, 'sampled_revert')
  const censoredRecovery = scored(base, {
    pointStatus: 'success',
    trajectory: {
      status: 'first_loss_with_recovery_followup_censored',
      firstLoss: loss,
      recovery: { block: block(500, 500), sampledAtUtc: at(500) },
      postRecoveryCensor: {
        reason: 'provider_ambiguity',
        atBlock: block(600, 600),
        lastCleanSuccessBlock: block(500, 500),
        observedStatus: 'provider_ambiguity',
      },
    },
  })
  const censoredRecoveryResult = evaluateLabels({ labels: labels(11000, [censoredRecovery]) })
    .rows[0]
  assert.equal(censoredRecoveryResult.evidenceClass, 'first_loss_interval')
  assert.equal(censoredRecoveryResult.postRecoveryCensor.reason, 'provider_ambiguity')
  const positive = scored(base, {
    trajectory: {
      status: 'first_loss_interval',
      firstLoss: {
        ...loss,
        intervalStartKind: 'post_issue_clean_success_sample',
        secondsFromIssueAtStart: 60,
      },
    },
  })
  assert.equal(
    evaluateLabels({ labels: labels(11000, [positive]) }).rows[0].firstLossInterval
      .positiveSampledLowerBoundSeconds,
    60,
  )
})

test('same anchor horizons and overlapping vault windows are dependent', () => {
  const a = issue(100, 3600, 200)
  const b = issue(100, 7200, 200)
  const c = issue(101, 3600, 300)
  const d = issue(102, 3600, 50000)
  const result = evaluateLabels({ labels: labels(60000, [a, b, c, d]) })
  assert.deepEqual(
    result.dependentClusters.map((cluster) => cluster.issueCount),
    [3, 1],
  )
  assert.equal(result.denominators.independentEpisodeCount, null)
})

test('one-second issue reports its coarse target window and actual sampled offset', () => {
  const row = issue(100, 1)
  const sampledBlock = block(190, 1800)
  const observed = scored(row, {
    pointStatus: 'success',
    trajectory: {
      status: 'right_censored_at_last_sampled_success',
      latestCleanSampledSuccessBlock: sampledBlock,
    },
  })
  observed.score.pointOutcome = {
    status: 'success',
    sampledAtUtc: at(1800),
    block: sampledBlock,
    targetOffsetSeconds: 1599,
    holderCaptureEndUtc: at(1810),
  }
  const result = evaluateLabels({ labels: labels(11000, [observed]), horizons: [1] }).rows[0]
  assert.equal(result.horizonSeconds, 1)
  assert.equal(result.horizonResolution, 'below_one_hour_sampling_resolution')
  assert.equal(result.targetWindowSeconds, 1800)
  assert.equal(result.pointTargetOffsetSeconds, 1599)
  assert.equal(result.pointSampledAtUtc, at(1800))
  assert.deepEqual(result.pointBlock, sampledBlock)
  assert.equal(result.pointHolderCaptureEndUtc, at(1810))
  assert.equal(result.evidenceClass, 'right_censored')
})

test('real empty ledger read remains unavailable', () => {
  const result = readEvaluation({ asOfUtc: new Date().toISOString(), horizons: [3600, 86400] })
  assert.equal(result.denominators.allIssued, 0)
  assert.equal(result.forecast.status, 'unavailable')
  assert.equal(result.alert.status, 'unavailable')
})

test('evaluation rejects issue or score that arrives after requested as-of', () => {
  const row = issue(100)
  assert.throws(
    () => evaluateLabels({ labels: labels(199, [row]) }),
    /Invalid prospective issue label/,
  )
  assert.throws(
    () => evaluateLabels({ labels: labels(9999, [scored(row)]) }),
    /Invalid prospective issue label/,
  )
})
