import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outcomeProtocol } from './scrvusd-exit-forecast-issue.mjs'
import { WITNESSED_SCHEMA_V2 } from './scrvusd-bound-prospective-exit-labels.mjs'
import { buildV2FlowEvidenceMatrix, SCHEMA } from './scrvusd-v2-flow-evidence-matrix.mjs'

const base = Date.parse('2026-09-01T00:00:00.000Z')
const at = (seconds) => new Date(base + seconds * 1000).toISOString()
const sha = (letter) => letter.repeat(64)
const route = 'direct_erc4626_withdraw_crvusd_from_scrvusd'
const window = (kind, period, seconds, start, raw) => ({
  status: 'observed',
  horizon: period,
  seconds,
  startUtc: at(start),
  endExclusiveUtc: at(start + seconds),
  [kind === 'gross' ? 'grossWithdrawalsRaw' : 'netDepletionRaw']: raw,
})

function flow() {
  return {
    evidenceCutoffUtc: at(700_000),
    coverage: { fromUtc: at(0), endExclusiveUtc: at(700_000) },
    completeToFirstLive: false,
    maximumObservedCompleteWindow: {
      '24h': window('gross', '24h', 86_400, 500_000, '900'),
      '7d': window('gross', '7d', 604_800, 0, '2300'),
    },
    maximumObservedCompleteWindowNetDepletion: {
      '24h': window('net', '24h', 86_400, 510_000, '-25'),
      '7d': window('net', '7d', 604_800, 0, '100'),
    },
  }
}

function row({
  slot = 'a',
  issued = 700_100,
  horizon = 3600,
  block = 100,
  flowContext = flow(),
  status = 'matured_unscored',
} = {}) {
  const protocol = outcomeProtocol(at(issued), horizon)
  const scored = status === 'observed'
  return {
    arm: { manifestSha256: sha('c'), slotId: slot, horizonSeconds: horizon },
    issue: {
      filename: `${slot}-${horizon}.json`,
      logicalSha256: sha('a'),
      physicalSha256: sha('b'),
    },
    issuedAtUtc: at(issued),
    targetUtc: protocol.targetUtc,
    captureDeadlineUtc: protocol.checkpointSelection.captureDeadlineUtc,
    anchorBlock: { number: block, hash: `0x${block.toString(16).padStart(64, '0')}` },
    holder: `0x${'1'.repeat(40)}`,
    qAssetsRaw: '1000',
    route,
    baseline: { status: 'sampled_success' },
    historicalFlowStatus: flowContext ? 'as_of_context' : 'unavailable',
    historicalFlowContext: flowContext,
    runVisibleAtUtc: at(issued + 50),
    certifiedMinimumPublicationLeadSeconds: horizon - 50,
    baselineSampleAgeSecondsAtWitness: 60,
    currentAtDecision: 'unverified',
    score: {
      status,
      ref: scored
        ? {
            filename: `score-${slot}-${horizon}.json`,
            logicalSha256: sha('d'),
            physicalSha256: sha('e'),
          }
        : null,
      scoredAtUtc: scored ? at(issued + horizon + 5401) : null,
      pointOutcome: scored ? { status: 'success' } : null,
      trajectory: null,
      sampledCodeIdentity: null,
      scoreVisibleAtUtc: scored ? at(issued + horizon + 5402) : null,
    },
  }
}

function labels(rows) {
  return {
    schema: WITNESSED_SCHEMA_V2,
    cohort: 'scheduled_bound_v2_witnessed_only',
    asOfUtc: at(720_000),
    asOfSemantics: 'retained_receipt_asof_reconstruction',
    historicalAvailabilityCertified: false,
    retainedReceiptVisibilityCertified: true,
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

test('preserves distinct gross and signed maxima, exact H, identity and dependent episodes', () => {
  const input = labels([
    row({ slot: 'a' }),
    row({ slot: 'b', block: 100, horizon: 7200, issued: 700_200 }),
  ])
  const result = buildV2FlowEvidenceMatrix({ labels: input, horizons: [3500, 7100, 8000] })
  assert.equal(result.schema, SCHEMA)
  assert.equal(result.armDenominators.total, 8)
  assert.deepEqual(
    result.byHorizon.map((group) => group.eligibleIssued),
    [1, 1, 0],
  )
  assert.equal(result.byHorizon[0].dependencyComponentCount, 1)
  const candidate = result.byHorizon[0].rows[0]
  assert.equal(candidate.arm.slotId, 'a')
  assert.equal(candidate.holder, input.rows[0].holder)
  assert.equal(candidate.anchorBlock.hash, input.rows[0].anchorBlock.hash)
  assert.equal(candidate.runVisibleAtUtc, input.rows[0].runVisibleAtUtc)
  assert.equal(candidate.certifiedMinimumPublicationLeadSeconds, 3550)
  assert.equal(candidate.baselineSampleAgeSecondsAtWitness, 60)
  assert.equal(candidate.currentAtDecision, 'unverified')
  assert.equal(candidate.firstLossIntervalFromWitness, null)
  assert.equal(candidate.flowFeatures['24h'].grossWithdrawals.valueRaw, '900')
  assert.equal(candidate.flowFeatures['24h'].signedNetDepletion.valueRaw, '-25')
  assert.notEqual(
    candidate.flowFeatures['24h'].grossWithdrawals.window.startUtc,
    candidate.flowFeatures['24h'].signedNetDepletion.window.startUtc,
  )
  assert.equal(result.byHorizon[0].featureMissingness.completeFourFeatureRows, 1)
  assert.equal(result.byHorizon[2].featureMissingness.completeFourFeatureRows, 0)
  assert.equal(result.forecast.probability, null)
  assert.equal(result.forecast.likelyDurationSeconds, null)
  assert.equal(result.alert.status, 'unavailable')
  assert.equal(result.byHorizon[0].independentEpisodeCount, null)
})

test('missing windows stay unavailable with separate per-feature reasons and H denominators', () => {
  const partial = flow()
  partial.maximumObservedCompleteWindow['7d'] = {
    status: 'unavailable',
    reason: 'less_than_one_complete_window',
    horizon: '7d',
    seconds: 604_800,
  }
  partial.maximumObservedCompleteWindowNetDepletion['7d'] = {
    status: 'unavailable',
    reason: 'less_than_one_complete_window',
    horizon: '7d',
    seconds: 604_800,
  }
  const result = buildV2FlowEvidenceMatrix({
    labels: labels([
      row({ slot: 'a', flowContext: partial }),
      row({ slot: 'b', block: 101, flowContext: null }),
    ]),
    horizons: [3500],
  })
  const group = result.byHorizon[0]
  assert.equal(group.eligibleIssued, 2)
  assert.equal(group.featureMissingness['24h'].grossWithdrawals.observed, 1)
  assert.equal(group.featureMissingness['7d'].grossWithdrawals.unavailable, 2)
  assert.deepEqual(group.featureMissingness['7d'].grossWithdrawals.unavailableReasons, {
    less_than_one_complete_window: 1,
    no_issue_time_flow_context: 1,
  })
  assert.equal(group.featureMissingness.completeFourFeatureRows, 0)
  assert.equal(group.outcomes.maturedUnscored, 2)
})

test('keeps a witnessed point success separate from historical flow and continuous ability', () => {
  const result = buildV2FlowEvidenceMatrix({
    labels: labels([row({ status: 'observed' })]),
    horizons: [3500],
  })
  const candidate = result.byHorizon[0].rows[0]
  assert.equal(candidate.scoreStatus, 'observed')
  assert.equal(candidate.pointStatus, 'success')
  assert.equal(candidate.score.filename, 'score-a-3600.json')
  assert.equal(result.byHorizon[0].outcomes.observed, 1)
  assert.equal(result.alert.status, 'unavailable')
})

test('rejects retrospective input, post-issue evidence, future coverage and invalid signed windows', () => {
  const baseRow = row()
  assert.throws(
    () =>
      buildV2FlowEvidenceMatrix({
        labels: { ...labels([baseRow]), schema: 'scrvusd-bound-prospective-exit-labels-v2' },
        horizons: [3500],
      }),
    /witnessed v2/,
  )
  const late = structuredClone(baseRow)
  late.historicalFlowContext.evidenceCutoffUtc = at(700_101)
  assert.throws(
    () => buildV2FlowEvidenceMatrix({ labels: labels([late]), horizons: [3500] }),
    /not available by issue/,
  )
  const future = structuredClone(baseRow)
  future.historicalFlowContext.coverage.endExclusiveUtc = at(700_001)
  assert.throws(
    () => buildV2FlowEvidenceMatrix({ labels: labels([future]), horizons: [3500] }),
    /coverage extends past/,
  )
  const bad = structuredClone(baseRow)
  bad.historicalFlowContext.maximumObservedCompleteWindowNetDepletion['24h'].netDepletionRaw = 'nan'
  assert.throws(
    () => buildV2FlowEvidenceMatrix({ labels: labels([bad]), horizons: [3500] }),
    /complete-window evidence/,
  )
})
