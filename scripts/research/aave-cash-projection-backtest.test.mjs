import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateEndpointSeries,
  evaluateEndpointCheckpoint,
} from './aave-cash-projection-backtest.mjs'
import { BOUNDARY_BLOCK, SOURCE } from './aave-cash-horizon-labels.mjs'
import { readCheckpoint } from './aave-stable-expansion.mjs'

const HOUR = 3600
const STEP = 6 * HOUR
const BOUNDARY = 2_000_000_000
const START = BOUNDARY - 70 * STEP
const row = (i, changes = {}) => ({
  market: 'DAI',
  block: i,
  at: START + i * STEP,
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  cashUsdAssumingPeg: 10_000,
  ...changes,
})
const series = (n = 100) => Array.from({ length: n }, (_, i) => row(i))
const options = { market: 'DAI', amountUsd: 1_000, horizonSeconds: 12 * HOUR, boundaryAt: BOUNDARY }
const byAnchor = (result, block) =>
  [...result.records.train, ...result.records.holdout].find((r) => r.anchorBlock === block)

test('endpoint cash differs from any-within-H label and retains target lag', () => {
  const rows = series()
  rows[5].cashUsdAssumingPeg = 500
  rows[6].at += HOUR
  const result = evaluateEndpointSeries(rows, options)
  const record = byAnchor(result, 4)
  assert.equal(record.status, 'completed')
  assert.equal(record.anyWithinHorizonCashBelowAmount, true)
  assert.equal(record.endpointCashBelowAmount, false)
  assert.equal(record.endpointCashUsd, 10_000)
  assert.equal(record.targetObservationLagSeconds, HOUR)
})

test('pause and inactive future windows retain measured cash but do not fit or score', () => {
  const rows = series()
  rows[10].withdrawPaused = true
  rows[20].active = false
  const result = evaluateEndpointSeries(rows, options)
  assert.equal(byAnchor(result, 9).status, 'paused_window')
  assert.equal(byAnchor(result, 9).endpointCashUsd, 10_000)
  assert.equal(byAnchor(result, 19).status, 'inactive_window')
  assert.equal(byAnchor(result, 19).endpointCashUsd, 10_000)
  assert.ok(result.train.excludedReasons.paused_window > 0)
  assert.ok(result.train.excludedReasons.inactive_window > 0)
})

test('gaps and ineligible samples censor endpoints; as-of does not read future cash', () => {
  const rows = series()
  rows[11].kind = 'ineligible'
  const ineligible = evaluateEndpointSeries(rows, options)
  assert.equal(byAnchor(ineligible, 9).status, 'censored_ineligible_future_sample')
  assert.equal(byAnchor(ineligible, 9).endpointCashUsd, null)
  const pending = evaluateEndpointSeries(series(), { ...options, asOfAt: row(20).at })
  assert.equal(byAnchor(pending, 19).status, 'censored_pending_as_of')
  assert.equal(byAnchor(pending, 19).endpointCashUsd, null)
  const gapped = series()
  gapped[11].at += 9 * HOUR
  for (let i = 12; i < gapped.length; i++) gapped[i].at += 9 * HOUR
  const gapResult = evaluateEndpointSeries(gapped, options)
  assert.equal(byAnchor(gapResult, 9).status, 'censored_gap')
})

test('residual interval fits train only; holdout errors and nonoverlap support are explicit', () => {
  const rows = series()
  for (let i = 72; i < rows.length; i++) rows[i].cashUsdAssumingPeg = 5_000
  const result = evaluateEndpointSeries(rows, options)
  assert.ok(result.trainSupport.completedWithProjection >= 30)
  assert.ok(result.empiricalResidualInterval)
  assert.equal(result.empiricalResidualInterval.lowerResidualUsd, 0)
  assert.equal(result.empiricalResidualInterval.upperResidualUsd, 0)
  assert.ok(result.holdout.meanAbsoluteErrorUsd > 0)
  assert.ok(result.holdout.intervalCoverage < 1)
  assert.ok(result.trainSupport.nonoverlap >= 20)
  assert.ok(result.nonoverlapSensitivityInterval)
  assert.ok(result.holdoutNonoverlapSensitivity.pointScored < result.holdout.pointScored)
  assert.equal(
    result.holdoutNonoverlapSensitivity.pointScored,
    result.trainSupport.holdoutNonoverlapScored,
  )
  assert.ok(result.records.train.every((r) => r.targetAt < BOUNDARY - 24 * HOUR))
  assert.ok(result.records.holdout.every((r) => r.anchorAt > BOUNDARY + 24 * HOUR))
})

test('long horizon with inadequate train support abstains from interval', () => {
  const result = evaluateEndpointSeries(series(), { ...options, horizonSeconds: 30 * 86400 })
  assert.equal(result.empiricalResidualInterval, null)
  assert.equal(result.holdout.intervalCoverage, null)
  assert.equal(result.holdout.intervalScored, 0)
})

test('authenticated adapter rejects modified source and uses frozen boundary', () => {
  const checkpoint = readCheckpoint(SOURCE)
  assert.ok(checkpoint)
  const result = evaluateEndpointCheckpoint(checkpoint, {
    market: 'DAI',
    amountUsd: 1_000_000,
    horizonSeconds: 24 * HOUR,
  })
  assert.equal(result.sourceEntriesSha256, checkpoint.entriesSha256)
  assert.equal(result.boundaryAt, checkpoint.entries.find((r) => r.block === BOUNDARY_BLOCK).at)
  assert.throws(
    () => evaluateEndpointCheckpoint({ ...checkpoint, entriesSha256: 'bad' }, options),
    /SHA|digest|checksum|frozen|corruption/i,
  )
})
