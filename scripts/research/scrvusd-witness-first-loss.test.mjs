import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_HORIZON_SECONDS, outcomeProtocol } from './scrvusd-exit-forecast-issue.mjs'
import { WITNESSED_SCHEMA_V2 } from './scrvusd-bound-prospective-exit-labels.mjs'
import {
  buildWitnessedFirstLoss,
  readWitnessedFirstLossWithPgV2,
  SCHEMA,
} from './scrvusd-witness-first-loss.mjs'

const origin = Date.parse('2026-09-01T00:00:00.000Z')
const at = (seconds) => new Date(origin + seconds * 1000).toISOString()
const hash = (letter) => letter.repeat(64)
const route = 'direct_erc4626_withdraw_crvusd_from_scrvusd'
const witness = 150
const issue = 100

function loss(start, end) {
  return {
    intervalStartUtc: at(start),
    intervalEndUtc: at(end),
    intervalStartKind:
      start <= issue ? 'pre_issue_anchor_sample' : 'post_issue_clean_success_sample',
    secondsFromIssueAtStart: start - issue,
    secondsFromIssueAtEnd: end - issue,
  }
}

function row({
  slot = 'a',
  issued = issue,
  runWitness = witness,
  armHorizon = 3600,
  block = 100,
  status = 'observed',
  pointStatus = 'success',
  firstLoss = null,
  trajectoryStatus = firstLoss ? 'first_loss_interval' : 'right_censored_at_last_sampled_success',
  lastCleanSuccess = 3750,
} = {}) {
  const protocol = outcomeProtocol(at(issued), armHorizon)
  const scored = ['observed', 'missing', 'ambiguous'].includes(status)
  return {
    arm: { manifestSha256: hash('c'), slotId: slot, horizonSeconds: armHorizon },
    issue: {
      filename: `${slot}-${armHorizon}.json`,
      logicalSha256: hash('a'),
      physicalSha256: hash('b'),
    },
    issuedAtUtc: at(issued),
    targetUtc: protocol.targetUtc,
    captureDeadlineUtc: protocol.checkpointSelection.captureDeadlineUtc,
    anchorBlock: { number: block, hash: `0x${block.toString(16).padStart(64, '0')}` },
    holder: `0x${'1'.repeat(40)}`,
    qAssetsRaw: '1000',
    route,
    baseline: { status: 'sampled_success' },
    historicalFlowStatus: 'unavailable',
    runVisibleAtUtc: at(runWitness),
    certifiedMinimumPublicationLeadSeconds: issued + armHorizon - runWitness,
    baselineSampleAgeSecondsAtWitness: 60,
    currentAtDecision: 'unverified',
    score: {
      status,
      ref: scored
        ? { filename: `score-${slot}.json`, logicalSha256: hash('d'), physicalSha256: hash('e') }
        : null,
      scoredAtUtc: scored ? at(issued + armHorizon + 5401) : null,
      scoreVisibleAtUtc: scored ? at(issued + armHorizon + 5402) : null,
      pointOutcome: scored ? { status: pointStatus } : null,
      trajectory: scored
        ? {
            status: trajectoryStatus,
            firstLoss,
            latestCleanSampledSuccessBlock: {
              number: block + 10,
              timestamp: Math.floor(origin / 1000) + lastCleanSuccess,
            },
          }
        : null,
      sampledCodeIdentity: null,
    },
  }
}

function labels(rows, asOf = 12_000) {
  return {
    schema: WITNESSED_SCHEMA_V2,
    cohort: 'scheduled_bound_v2_witnessed_only',
    asOfUtc: at(asOf),
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

const study = (rows, H = 3550, asOf = 12_000) =>
  buildWitnessedFirstLoss({ labels: labels(rows, asOf), horizons: [H] })

test('first sampled loss interval is compared with witness and exact selected H boundaries', () => {
  const cases = [
    [100, 150, 'first_sampled_loss_before_witness'],
    [100, 151, 'first_loss_interval_straddles_witness'],
    [150, 3700, 'definite_post_witness_first_sampled_loss_by_H'],
    [200, 3701, 'first_loss_interval_straddles_H'],
    [3700, 3800, 'first_sampled_loss_later_than_H'],
  ]
  for (const [start, end, expected] of cases) {
    const result = study([row({ firstLoss: loss(start, end) })])
    assert.equal(result.byHorizon[0].rows[0].firstLossClass, expected)
    assert.equal(result.byHorizon[0].rows[0].selectedHorizonEndsAtUtc, at(3700))
  }
})

test('point status stays separate: ambiguous and missing are never sampled success', () => {
  const result = study([
    row({
      slot: 'a',
      status: 'missing',
      pointStatus: 'missing_quote_checkpoint',
      trajectoryStatus: 'right_censored_at_last_sampled_success',
    }),
    row({
      slot: 'b',
      status: 'ambiguous',
      pointStatus: 'provider_ambiguity',
      trajectoryStatus: 'right_censored_ambiguous',
    }),
    row({
      slot: 'c',
      status: 'ambiguous',
      pointStatus: 'provider_ambiguity',
      firstLoss: loss(200, 300),
    }),
  ])
  assert.deepEqual(
    result.byHorizon[0].rows.map((entry) => entry.firstLossClass),
    ['scored_missing', 'scored_ambiguous', 'definite_post_witness_first_sampled_loss_by_H'],
  )
  assert.equal(result.byHorizon[0].scoreStatuses.ambiguous, 2)
  assert.equal(result.byHorizon[0].scoreStatuses.missing, 1)
  assert.equal(result.byHorizon[0].dependencyComponentCount, 1)
  assert.equal(result.byHorizon[0].independentEpisodeCount, null)
})

test('right censor requires a clean sample covering H; point-at-target is unresolved', () => {
  const result = study([
    row({ slot: 'cover', lastCleanSuccess: 3700 }),
    row({ slot: 'short', lastCleanSuccess: 3699 }),
    row({ slot: 'point', trajectoryStatus: 'unclassified', pointStatus: 'revert' }),
    row({ slot: 'gap', trajectoryStatus: 'right_censored_ambiguous' }),
  ])
  assert.deepEqual(
    result.byHorizon[0].rows.map((entry) => entry.firstLossClass),
    [
      'right_censored_sampled_success_covers_H',
      'right_censored_before_H',
      'first_loss_path_unresolved',
      'right_censored_ambiguous',
    ],
  )
  assert.equal(result.forecast.probability, null)
  assert.equal(result.forecast.likelyDurationSeconds, null)
  assert.equal(result.alert.status, 'unavailable')
})

test('pending, matured and unenrolled arms preserve full four-arm denominator', () => {
  const pending = study(
    [
      row({ slot: 'pending', status: 'pending' }),
      row({ slot: 'far', armHorizon: 7200, status: 'pending' }),
      row({ slot: 'short', runWitness: 200, status: 'pending' }),
    ],
    3550,
    3700,
  )
  assert.equal(pending.armDenominators.total, 12)
  assert.equal(pending.byHorizon[0].allIssuedRiskSet, 3)
  assert.equal(pending.byHorizon[0].eligibleIssued, 2)
  assert.equal(pending.byHorizon[0].insufficientRemainingLead, 1)
  assert.equal(pending.byHorizon[0].notEnrolled[0].reason, 'insufficient_remaining_lead_for_H')
  assert.equal(pending.byHorizon[0].rows[0].firstLossClass, 'pending_H_elapsed_awaiting_score')
  const matured = study([row({ slot: 'matured', status: 'matured_unscored' })])
  assert.equal(matured.byHorizon[0].rows[0].firstLossClass, 'matured_unscored')
})

test('variable selected H changes admission; invalid H and unverified baseline cannot be presented as verified', () => {
  const source = row()
  const result = buildWitnessedFirstLoss({ labels: labels([source]), horizons: [3550, 3600, 3250] })
  assert.deepEqual(result.requestedHorizonsSeconds, [3250, 3550, 3600])
  assert.deepEqual(
    result.byHorizon.map((entry) => entry.eligibleIssued),
    [1, 1, 0],
  )
  assert.equal(result.byHorizon[2].insufficientRemainingLead, 1)
  assert.equal(result.byHorizon[2].notEnrolled[0].reason, 'insufficient_remaining_lead_for_H')
  assert.equal(result.byHorizon[1].rows[0].currentAtDecision, 'unverified')
  assert.equal(result.byHorizon[1].rows[0].sampledContinuity, 'unverified')
  assert.equal(result.schema, SCHEMA)
  assert.throws(() => study([source], MAX_HORIZON_SECONDS + 1), /selected H/)
  assert.throws(() => study([source], 0), /selected H/)
  assert.throws(
    () =>
      buildWitnessedFirstLoss({
        labels: { ...labels([source]), retainedReceiptVisibilityCertified: false },
        horizons: [3550],
      }),
    /DB-reconciled/,
  )
  assert.throws(
    () =>
      buildWitnessedFirstLoss({
        labels: { ...labels([source]), rows: [{ ...source, currentAtDecision: 'verified' }] },
        horizons: [3550],
      }),
    /visibility or lead/,
  )
})

test('a witnessed 2h arm contributes to a selected 1h path even without an exact 1h target', () => {
  const twoHour = row({ slot: 'two-hour', armHorizon: 7200, firstLoss: loss(200, 3300) })
  const result = study([twoHour], 3600, 14_000)
  assert.equal(result.byHorizon[0].eligibleIssued, 1)
  assert.equal(result.byHorizon[0].insufficientRemainingLead, 0)
  assert.equal(
    result.byHorizon[0].rows[0].firstLossClass,
    'definite_post_witness_first_sampled_loss_by_H',
  )
  assert.equal(result.byHorizon[0].rows[0].targetUtc, at(7300))
  assert.equal(result.byHorizon[0].rows[0].selectedHorizonEndsAtUtc, at(3750))
  assert.equal(result.byHorizon[0].selectionRule, 'certified_remaining_lead_at_least_H')
  assert.equal(result.armDenominators.total, 4)
})

test('a pending 2h arm distinguishes selected 1h H before and after elapsed time', () => {
  const twoHour = row({ slot: 'pending-two-hour', armHorizon: 7200, status: 'pending' })
  const before = study([twoHour], 3600, 1950)
  const after = study([twoHour], 3600, 5550)
  assert.equal(before.byHorizon[0].rows[0].firstLossClass, 'pending_before_H')
  assert.equal(after.byHorizon[0].rows[0].firstLossClass, 'pending_H_elapsed_awaiting_score')
  assert.equal(before.byHorizon[0].rows[0].scoreStatus, 'pending')
  assert.equal(after.byHorizon[0].rows[0].scoreStatus, 'pending')
  assert.equal(after.byHorizon[0].rows[0].pointStatus, null)
})

test('pure reducer rejects impossible right-censor timestamp; public path requires PostgreSQL', async () => {
  assert.throws(() => study([row({ lastCleanSuccess: 12_001 })]), /as-of block timestamp/)
  await assert.rejects(
    readWitnessedFirstLossWithPgV2({ asOfUtc: at(12_000), horizons: [3550] }),
    /PostgreSQL pool required/,
  )
})
