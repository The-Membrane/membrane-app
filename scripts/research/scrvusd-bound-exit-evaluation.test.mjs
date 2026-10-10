import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outcomeProtocol } from './scrvusd-exit-forecast-issue.mjs'
import {
  SCHEMA_V2 as LABEL_SCHEMA_V2,
  WITNESSED_SCHEMA_V2 as WITNESSED_LABEL_SCHEMA_V2,
} from './scrvusd-bound-prospective-exit-labels.mjs'
import {
  evaluateBoundLabelsV2,
  evaluateWitnessedBoundLabelsV2,
  readBoundEvaluationWithPgV2,
  readWitnessedBoundEvaluationWithPgV2,
} from './scrvusd-bound-exit-evaluation.mjs'

const base = Date.parse('2026-09-28T00:00:00.000Z')
const at = (seconds) => new Date(base + seconds * 1000).toISOString()
const ref = (name) => ({
  filename: name,
  logicalSha256: 'a'.repeat(64),
  physicalSha256: 'b'.repeat(64),
})

function label({
  issued = 100,
  horizon = 3600,
  slot = 'slot-1',
  block = 100,
  status = 'pending',
  pointStatus = 'success',
  trajectory = null,
} = {}) {
  const protocol = outcomeProtocol(at(issued), horizon)
  const scored = ['observed', 'missing', 'ambiguous'].includes(status)
  return {
    arm: { manifestSha256: 'm', slotId: slot, horizonSeconds: horizon },
    issue: ref(`${slot}-${horizon}.json`),
    issuedAtUtc: at(issued),
    targetUtc: protocol.targetUtc,
    captureDeadlineUtc: protocol.checkpointSelection.captureDeadlineUtc,
    anchorBlock: { number: block, hash: `0x${block.toString(16).padStart(64, '0')}` },
    holder: `0x${'1'.repeat(40)}`,
    qAssetsRaw: '1000',
    route: 'direct_erc4626_withdraw_crvusd_from_scrvusd',
    baseline: { status: 'sampled_success' },
    historicalFlowStatus: 'unavailable',
    score: {
      status,
      ref: scored ? ref(`score-${slot}-${horizon}.json`) : null,
      scoredAtUtc: scored ? at(issued + horizon + 5401) : null,
      pointOutcome: scored ? { status: pointStatus } : null,
      trajectory,
      sampledCodeIdentity: null,
    },
  }
}

function labels(rows, asOf = 12000) {
  return {
    schema: LABEL_SCHEMA_V2,
    cohort: 'scheduled_bound_v2_only',
    asOfUtc: at(asOf),
    asOfSemantics: 'retrospective_reconstruction_from_current_verified_ledger',
    historicalAvailabilityCertified: false,
    chronologicalBacktestEligible: false,
    rows,
  }
}

test('v2 evaluation separates pre-target, open capture, matured unscored, and scored missing', () => {
  assert.equal(
    evaluateBoundLabelsV2({ labels: labels([label()], 200) }).rows[0].evidenceClass,
    'not_yet_due',
  )
  assert.equal(
    evaluateBoundLabelsV2({ labels: labels([label()], 3800) }).rows[0].evidenceClass,
    'capture_window_open',
  )
  const rows = [
    label({ status: 'matured_unscored' }),
    label({ status: 'missing', slot: 'slot-2', pointStatus: 'missing_quote_checkpoint' }),
    label({ status: 'ambiguous', slot: 'slot-3', pointStatus: 'provider_ambiguity' }),
  ]
  const result = evaluateBoundLabelsV2({ labels: labels(rows) })
  assert.deepEqual(
    result.rows.map((row) => row.evidenceClass),
    ['matured_unscored', 'scored_missing', 'scored_ambiguous'],
  )
  assert.equal(result.denominators.maturedUnscored, 1)
  assert.equal(result.forecast.probability, null)
  assert.equal(result.forecast.likelyDurationSeconds, null)
  assert.equal(result.chronologicalBacktestEligible, false)
})

test('v2 signed first-loss interval and right censor retain distinct meaning', () => {
  const interval = {
    intervalStartUtc: at(50),
    intervalEndUtc: at(500),
    intervalStartKind: 'pre_issue_anchor_sample',
    secondsFromIssueAtStart: -50,
    secondsFromIssueAtEnd: 400,
  }
  const firstLoss = label({
    status: 'observed',
    trajectory: { status: 'first_loss', firstLoss: interval },
  })
  const censored = label({
    status: 'observed',
    slot: 'slot-2',
    block: 101,
    trajectory: { status: 'right_censored_at_last_sampled_success' },
  })
  const result = evaluateBoundLabelsV2({ labels: labels([firstLoss, censored]) })
  assert.deepEqual(
    result.rows.map((row) => row.evidenceClass),
    ['first_loss_interval', 'right_censored_at_sampled_success'],
  )
  assert.equal(result.rows[0].firstLossInterval.signedSecondsFromIssueAtStart, -50)
  assert.equal(result.rows[0].firstLossInterval.positiveSampledLowerBoundSeconds, null)
  const corrupt = structuredClone(firstLoss)
  corrupt.score.trajectory.firstLoss.secondsFromIssueAtEnd = 999
  assert.throws(() => evaluateBoundLabelsV2({ labels: labels([corrupt]) }), /offsets differ/)
  const fractional = structuredClone(firstLoss)
  fractional.score.trajectory.firstLoss.intervalEndUtc = new Date(
    Date.parse(fractional.score.trajectory.firstLoss.intervalEndUtc) + 250,
  ).toISOString()
  fractional.score.trajectory.firstLoss.secondsFromIssueAtEnd = 400.25
  assert.equal(
    evaluateBoundLabelsV2({ labels: labels([fractional]) }).rows[0].firstLossInterval
      .signedSecondsFromIssueAtEnd,
    400.25,
  )
})

test('same-anchor and overlapping v2 windows form descriptive components, never independent episodes', () => {
  const rows = [
    label({ slot: 'a', block: 100, horizon: 3600, status: 'matured_unscored' }),
    label({ slot: 'b', block: 100, horizon: 7200, status: 'matured_unscored' }),
    label({ slot: 'c', block: 102, issued: 1000, status: 'matured_unscored' }),
    label({ slot: 'd', block: 103, issued: 20000, status: 'matured_unscored' }),
  ]
  const result = evaluateBoundLabelsV2({ labels: labels(rows, 30000), horizons: [3600, 7200] })
  assert.deepEqual(
    result.dependentClusters.map((cluster) => cluster.issueCount),
    [3, 1],
  )
  assert.equal(result.denominators.dependencyComponentCount, 2)
  assert.equal(result.denominators.independentEpisodeCount, null)
  assert.equal(result.byHorizon[0].issued, 3)
  assert.equal(result.byHorizon[1].issued, 1)
})

test('v1 labels and absent PostgreSQL cannot enter v2 evaluation', async () => {
  assert.throws(
    () => evaluateBoundLabelsV2({ labels: { ...labels([]), schema: 'v1' } }),
    /verified retrospective bound labels/,
  )
  await assert.rejects(
    readBoundEvaluationWithPgV2({ asOfUtc: at(100) }),
    /PostgreSQL pool required/,
  )
})

test('selected horizon counts and target ambiguity remain visible beside a prior loss', () => {
  const loss = {
    intervalStartUtc: at(50),
    intervalEndUtc: at(500),
    intervalStartKind: 'pre_issue_anchor_sample',
    secondsFromIssueAtStart: -50,
    secondsFromIssueAtEnd: 400,
  }
  const rows = [
    label({
      status: 'ambiguous',
      pointStatus: 'provider_ambiguity',
      trajectory: { status: 'first_loss', firstLoss: loss },
    }),
    label({ horizon: 7200, slot: 'other', status: 'pending' }),
  ]
  const result = evaluateBoundLabelsV2({ labels: labels(rows, 12000), horizons: [3600] })
  assert.equal(result.denominators.allIssued, 2)
  assert.equal(result.denominators.requestedIssued, 1)
  assert.equal(result.denominators.scored, 1)
  assert.equal(result.denominators.pending, 0)
  assert.equal(result.rows.length, 1)
  assert.equal(result.byHorizon[0].evidenceClasses.first_loss_interval, 1)
  assert.equal(result.byHorizon[0].pointStatuses.provider_ambiguity, 1)
  assert.throws(
    () =>
      evaluateBoundLabelsV2({
        labels: { ...labels(rows), asOfSemantics: 'historical_certified' },
      }),
    /verified retrospective bound labels/,
  )
})

function witnessedRow(options = {}) {
  const source = label(options)
  const witnessSeconds = (options.issued ?? 100) + 50
  return {
    ...source,
    runVisibleAtUtc: at(witnessSeconds),
    certifiedMinimumPublicationLeadSeconds:
      (Date.parse(source.targetUtc) - Date.parse(at(witnessSeconds))) / 1000,
    baselineSampleAgeSecondsAtWitness: 60,
    currentAtDecision: 'unverified',
    score: {
      ...source.score,
      scoreVisibleAtUtc: source.score.ref
        ? at((options.issued ?? 100) + (options.horizon ?? 3600) + 5402)
        : null,
    },
  }
}

function witnessedLabels(rows, asOf = 12000) {
  return {
    schema: WITNESSED_LABEL_SCHEMA_V2,
    cohort: 'scheduled_bound_v2_witnessed_only',
    asOfUtc: at(asOf),
    asOfSemantics: 'retained_receipt_asof_reconstruction',
    historicalAvailabilityCertified: false,
    witnessedRunCohortComplete: true,
    scheduledSlotCohortComplete: false,
    fullCohortComplete: false,
    chronologicalBacktestEligible: false,
    armDenominators: {
      runs: rows.length,
      total: rows.length * 4,
      issued: rows.length,
      abstained: rows.length * 3,
      failed: 0,
      unknown: 0,
    },
    rows,
  }
}

test('witnessed H requires target at or after witness plus H within fixed tolerance', () => {
  const source = witnessedRow({ status: 'matured_unscored' })
  const input = witnessedLabels([source])
  const result = evaluateWitnessedBoundLabelsV2({
    labels: input,
    horizons: [3500, 3600, 3200, 3250],
  })
  assert.deepEqual(
    result.byHorizon.map((row) => row.eligibleIssued),
    [0, 1, 1, 0],
  )
  assert.deepEqual(
    result.byHorizon.map((row) => row.abstainedNoExactTarget),
    [1, 0, 0, 1],
  )
  assert.equal(result.byHorizon[1].exactTargetToleranceSeconds, 300)
  assert.equal(result.denominators.witnessedRunArms, 4)
  assert.equal(result.denominators.allIssuedRiskSet, 1)
  assert.equal(result.denominators.requestedEligibleIssued, 1)
  assert.equal(result.armDenominators.abstained, 3)
  assert.equal(result.rows[0].certifiedMinimumPublicationLeadSeconds, 3550)
  assert.equal(result.rows[0].baselineSampleAgeSecondsAtWitness, 60)
  assert.equal(result.rows[0].currentAtDecision, 'unverified')
  assert.equal(result.forecast.probability, null)
  assert.equal(result.forecast.likelyDurationSeconds, null)
  assert.equal(result.alert.status, 'unavailable')
  assert.equal(result.denominators.independentEpisodeCount, null)
})

test('witnessed evaluation separates point ambiguity from prior interval-censored first loss', () => {
  const loss = {
    intervalStartUtc: at(50),
    intervalEndUtc: at(500),
    intervalStartKind: 'pre_issue_anchor_sample',
    secondsFromIssueAtStart: -50,
    secondsFromIssueAtEnd: 400,
  }
  const rows = [
    witnessedRow({
      slot: 'a',
      status: 'ambiguous',
      pointStatus: 'provider_ambiguity',
      trajectory: { status: 'first_loss', firstLoss: loss },
    }),
    witnessedRow({
      slot: 'b',
      block: 101,
      status: 'missing',
      pointStatus: 'missing_quote_checkpoint',
    }),
    witnessedRow({ slot: 'c', block: 102, status: 'matured_unscored' }),
  ]
  const result = evaluateWitnessedBoundLabelsV2({ labels: witnessedLabels(rows), horizons: [3500] })
  assert.equal(result.byHorizon[0].eligibleIssued, 3)
  assert.equal(result.byHorizon[0].ambiguous, 1)
  assert.equal(result.byHorizon[0].missing, 1)
  assert.equal(result.byHorizon[0].maturedUnscored, 1)
  assert.equal(result.byHorizon[0].pointStatuses.provider_ambiguity, 1)
  assert.equal(result.byHorizon[0].firstLossIntervalCount, 1)
  assert.equal(result.rows[0].firstLossIntervalFromWitness.signedSecondsAtStart, -100)
  assert.equal(result.rows[0].firstLossIntervalFromWitness.signedSecondsAtEnd, 350)
  assert.equal(result.dependentClusters.length, 1)
  assert.equal(result.denominators.independentEpisodeCount, null)
})

test('witnessed evaluation rejects retrospective labels and missing user horizon', async () => {
  const input = witnessedLabels([witnessedRow()])
  assert.throws(
    () => evaluateWitnessedBoundLabelsV2({ labels: input, horizons: [] }),
    /user-selected horizon/,
  )
  assert.throws(
    () => evaluateWitnessedBoundLabelsV2({ labels: labels([label()]), horizons: [3500] }),
    /reconciled DB four-arm labels/,
  )
  assert.throws(
    () =>
      evaluateWitnessedBoundLabelsV2({
        labels: { ...input, witnessedRunCohortComplete: false },
        horizons: [3500],
      }),
    /reconciled DB four-arm labels/,
  )
  await assert.rejects(
    readWitnessedBoundEvaluationWithPgV2({ asOfUtc: at(12000), horizons: [3500] }),
    /PostgreSQL pool required/,
  )
})
