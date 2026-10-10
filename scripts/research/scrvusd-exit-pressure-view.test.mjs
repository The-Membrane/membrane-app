import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildExitPressureView,
  computeTrendAt,
  readExitPressureView,
} from './scrvusd-exit-pressure-view.mjs'
import { STUDY as TREND_STUDY } from './scrvusd-holder-exit-trend.mjs'
import { SCHEMA as EVALUATION_SCHEMA } from './scrvusd-exit-duration-evaluation.mjs'

const asOfUtc = '2026-09-28T04:00:00.000Z'
const holder = `0x${'a'.repeat(40)}`
const current = {
  block: 101,
  blockHash: `0x${'b'.repeat(64)}`,
  blockUtc: '2026-09-28T03:45:00.000Z',
  captureEndUtc: '2026-09-28T03:49:00.000Z',
}
const trend = {
  study: TREND_STUDY,
  status: 'measured_pair',
  direction: 'shrinking',
  holder,
  rawCrvUsd: '1000',
  previous: { block: 100, blockHash: `0x${'a'.repeat(64)}` },
  current,
  currentHeadroomAssetsRaw: '2000',
  signedHeadroomChangeAssetsRaw: '-1000',
}
const emptyEvaluation = {
  schema: EVALUATION_SCHEMA,
  asOfUtc,
  rows: [],
  requestedHorizonsSeconds: [],
  dependentClusters: [],
  denominators: { allIssued: 0 },
}
const build = (overrides = {}) =>
  buildExitPressureView({ asOfUtc, trend, evaluation: emptyEvaluation, ...overrides })

test('comparable sampled decline is an observed candidate with unavailable future forecast', () => {
  const view = build()
  assert.equal(view.observedShrinkingAlertCandidate.status, 'observed_shrinking_candidate')
  assert.equal(view.observedShrinkingAlertCandidate.userAlertReady, false)
  assert.equal(view.issueTimeFlow.reason, 'no_matching_prospective_issue')
  assert.deepEqual(view.forecast, {
    probability: null,
    likelyDurationSeconds: null,
    status: 'unavailable',
  })
  assert.equal(view.prospectiveOutcomeReadiness.promotion.alert, 'unavailable')
})

test('stale, incomplete, flat, and growing trends do not create shrinking candidates', () => {
  for (const state of [
    { status: 'unavailable', reason: 'stale_or_future_capture' },
    { status: 'sampled_transition', transition: 'success_to_structured_evm_revert' },
    { status: 'measured_pair', direction: 'flat' },
    { status: 'measured_pair', direction: 'growing' },
  ]) {
    const view = build({ trend: { ...trend, ...state } })
    assert.equal(view.observedShrinkingAlertCandidate.status, 'unavailable')
    assert.equal(view.forecast.likelyDurationSeconds, null)
  }
})

test('issue-time flow keeps gross and signed net maxima and separate windows', () => {
  const row = {
    issue: { filename: 'issue.json' },
    issuedAtUtc: '2026-09-28T03:50:00.000Z',
    anchorBlock: { number: current.block, hash: current.blockHash },
    holder,
    qAssetsRaw: '1000',
    route: 'direct_erc4626_withdraw_crvusd_from_scrvusd',
    historicalFlowStatus: 'as_of_context',
    historicalFlowContext: {
      evidenceCutoffUtc: '2026-09-28T03:49:00.000Z',
      completeToFirstLive: false,
      coverage: { throughBlock: 99 },
      maximumObservedCompleteWindow: {
        '24h': {
          status: 'observed',
          startUtc: '2026-09-20T00:00:00.000Z',
          grossWithdrawalsRaw: '800',
        },
        '7d': { status: 'unavailable', reason: 'less_than_one_complete_window' },
      },
      maximumObservedCompleteWindowNetDepletion: {
        '24h': { status: 'observed', startUtc: '2026-09-21T00:00:00.000Z', netDepletionRaw: '300' },
        '7d': { status: 'unavailable', reason: 'less_than_one_complete_window' },
      },
    },
  }
  const view = build({ evaluation: { ...emptyEvaluation, rows: [row] } })
  assert.equal(view.issueTimeFlow.status, 'issue_time_context')
  assert.equal(view.issueTimeFlow.completeToFirstLive, false)
  assert.equal(
    view.issueTimeFlow.maximumObservedCompleteWindowGrossWithdrawal['24h'].grossWithdrawalsRaw,
    '800',
  )
  assert.equal(
    view.issueTimeFlow.maximumObservedCompleteWindowSignedNetDepletion['24h'].netDepletionRaw,
    '300',
  )
  assert.notEqual(
    view.issueTimeFlow.maximumObservedCompleteWindowGrossWithdrawal['24h'].startUtc,
    view.issueTimeFlow.maximumObservedCompleteWindowSignedNetDepletion['24h'].startUtc,
  )
})

test('unmatched holder, unavailable flow, and future cutoff remain unavailable', () => {
  const row = {
    anchorBlock: { number: current.block, hash: current.blockHash },
    holder: `0x${'c'.repeat(40)}`,
    qAssetsRaw: '1000',
    route: 'direct_erc4626_withdraw_crvusd_from_scrvusd',
  }
  assert.equal(
    build({ evaluation: { ...emptyEvaluation, rows: [row] } }).issueTimeFlow.reason,
    'no_matching_prospective_issue',
  )
  const matching = {
    ...row,
    holder,
    issuedAtUtc: '2026-09-28T03:50:00.000Z',
    historicalFlowStatus: 'unavailable',
  }
  assert.equal(
    build({ evaluation: { ...emptyEvaluation, rows: [matching] } }).issueTimeFlow.reason,
    'issue_has_no_flow_context',
  )
  const invalid = {
    ...matching,
    issuedAtUtc: asOfUtc,
    historicalFlowStatus: 'as_of_context',
    historicalFlowContext: { evidenceCutoffUtc: '2026-09-28T05:00:00.000Z' },
  }
  assert.equal(
    build({ evaluation: { ...emptyEvaluation, rows: [invalid] } }).issueTimeFlow.reason,
    'issue_flow_cutoff_mismatch',
  )
  for (const issuedAtUtc of ['2026-09-28T03:48:00.000Z', '2026-09-28T04:01:00.000Z', 'invalid']) {
    const outOfWindow = {
      ...invalid,
      issuedAtUtc,
      historicalFlowContext: { evidenceCutoffUtc: '2026-09-28T03:40:00.000Z' },
    }
    assert.equal(
      build({ evaluation: { ...emptyEvaluation, rows: [outOfWindow] } }).issueTimeFlow.reason,
      'issue_outside_verified_as_of_window',
    )
  }
})

test('historical cutoff ignores a later saved holder issue and quote after full verification', () => {
  const plan = {
    holder,
    rawCrvUsd: '1000',
    sha256: 'plan-sha',
    createdUtc: '2026-09-28T00:00:00.000Z',
  }
  const selection = { status: 'verified', capturedUtc: '2026-09-28T00:01:00.000Z' }
  const checkpoint = (number, minute) => ({
    checkpoint: {
      block: {
        number,
        hash: `0x${String(number).padStart(64, '0')}`,
        timestamp: Date.parse(`2026-09-28T00:${String(minute).padStart(2, '0')}:00.000Z`) / 1000,
      },
      captureEndUtc: `2026-09-28T00:${String(minute + 1).padStart(2, '0')}:00.000Z`,
    },
  })
  const checkpoints = [checkpoint(100, 2), checkpoint(101, 12), checkpoint(102, 22)]
  const issue = (row, max) => ({
    checkpoint: row.checkpoint,
    captureEndUtc: row.checkpoint.captureEndUtc,
    result: {
      status: 'success',
      balanceSharesRaw: '2000',
      previewSharesRaw: '100',
      maxWithdrawAssetsRaw: max,
    },
  })
  const issues = [
    issue(checkpoints[0], '5000'),
    issue(checkpoints[1], '3000'),
    issue(checkpoints[2], '6000'),
  ]
  const earlier = computeTrendAt({
    asOfUtc: '2026-09-28T00:20:00.000Z',
    plan,
    selection,
    issues,
    checkpoints,
  })
  assert.equal(earlier.status, 'measured_pair')
  assert.equal(earlier.direction, 'shrinking')
  assert.equal(earlier.current.block, 101)
  assert.equal(earlier.observationCount, 2)
  assert.equal(earlier.quoteCount, 2)
  const later = computeTrendAt({
    asOfUtc: '2026-09-28T00:30:00.000Z',
    plan,
    selection,
    issues,
    checkpoints,
  })
  assert.equal(later.current.block, 102)
  assert.equal(later.direction, 'growing')
  const beforeSelection = computeTrendAt({
    asOfUtc: '2026-09-28T00:00:30.000Z',
    plan,
    selection,
    issues,
    checkpoints,
  })
  assert.equal(beforeSelection.reason, 'selection_not_yet_available')
})

test('real verified local corpus replays before its latest saved holder issue when present', () => {
  const output = 'data/research/venue-signals/scrvusd-fixed-holder-exit/issues'
  // This research corpus is gitignored. The pure regression above remains
  // deterministic when a checkout does not carry the local evidence files.
  if (!existsSync(output)) return
  const rows = readdirSync(output)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(output, name), 'utf8')))
  if (rows.length < 2) return
  const previous = rows.at(-2)
  const earlier = readExitPressureView({ asOfUtc: previous.captureEndUtc })
  assert.equal(earlier.trend.current.block, previous.checkpoint.block.number)
  assert.equal(earlier.trend.observationCount, rows.length - 1)
})
