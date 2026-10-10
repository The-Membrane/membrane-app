import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateMarketSeries,
  predictAnchor,
  scoreMarketPeriods,
  trailingDecline,
} from './aave-cash-trend-candidate.mjs'

const HOUR = 3600
const Q = 1_000_000
const BOUNDARY = 2_000_000_000
const START = BOUNDARY - 100 * 86400
const row = (n, cash = 2_000_000, overrides = {}) => ({
  market: 'USDC',
  block: n,
  at: START + n * 6 * HOUR,
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  cashUsdAssumingPeg: cash,
  ...overrides,
})
const options = { amountUsd: Q, horizonSeconds: 24 * HOUR, boundaryAt: BOUNDARY }

test('trailing gap or non-observed sample forces abstention', () => {
  const rows = [
    row(0, 2_000_000),
    row(1, 1_900_000),
    row(2, 1_800_000),
    row(3, 1_700_000),
    row(4, 1_600_000),
  ]
  assert.notEqual(trailingDecline(rows, 4), null)
  assert.equal(trailingDecline([rows[0], rows[1], rows[4]], 2), null)
  assert.equal(
    trailingDecline(
      rows.map((item, i) => (i === 2 ? { ...item, kind: 'failed' } : item)),
      4,
    ),
    null,
  )
  assert.equal(trailingDecline(rows.slice(2), 2), null)
})

test('rising cash clips decline to zero and never warns', () => {
  const rows = [
    row(0, 1_100_000),
    row(1, 1_200_000),
    row(2, 1_300_000),
    row(3, 1_400_000),
    row(4, 1_500_000),
  ]
  assert.equal(trailingDecline(rows, 4).declineRateUsdPerSecond, 0)
  assert.equal(predictAnchor(rows, 4, Q, 24 * HOUR), false)
})

test('falling cash warns strictly below q, without reading future samples', () => {
  const rows = [
    row(0, 2_000_000),
    row(1, 1_800_000),
    row(2, 1_600_000),
    row(3, 1_400_000),
    row(4, 1_200_000),
  ]
  assert.equal(predictAnchor(rows, 4, Q, 24 * HOUR), true)
  rows.push(row(5, 3_000_000))
  assert.equal(predictAnchor(rows, 4, Q, 24 * HOUR), true)
  const exact = [
    row(0, 1_500_000),
    row(1, 1_375_000),
    row(2, 1_250_000),
    row(3, 1_125_000),
    row(4, 1_000_000),
  ]
  assert.equal(predictAnchor(exact, 4, 500_000, 24 * HOUR), false)
})

test('source split and 24h purge prevent boundary leakage', () => {
  const base = BOUNDARY - 57 * HOUR
  const rows = Array.from({ length: 24 }, (_, i) => row(i, 1_500_000, { at: base + i * 6 * HOUR }))
  const periods = evaluateMarketSeries(rows, options)
  assert.equal(
    periods.train.some((record) => record.label.anchorBlock === 0),
    true,
  )
  assert.equal(
    periods.train.some((record) => record.label.anchorBlock === 1),
    false,
  )
  assert.equal(
    periods.holdout.every((record) => record.label.anchorAt > BOUNDARY + 24 * HOUR),
    true,
  )
})

test('overlapping anchors deduplicate to one actual downcrossing event', () => {
  const cash = [
    2_000_000, 1_900_000, 1_800_000, 1_700_000, 1_600_000, 1_450_000, 1_300_000, 1_100_000, 900_000,
    800_000, 800_000, 800_000,
  ]
  const rows = cash.map((value, i) => row(i, value))
  const scored = scoreMarketPeriods(evaluateMarketSeries(rows, options)).train
  assert.equal(scored.trend.events.total, 1)
  assert.equal(scored.trend.events.captured, 1)
  assert.equal(scored.trend.events.missed, 0)
  assert.ok(scored.trend.tp > 1)
  assert.equal(scored.alwaysNoCrossing.events.missed, 1)
  assert.equal(scored.trend.events.leadToFirstSampledBelowQHours.length, 1)
})

test('warning runs group adjacent observed warnings and separate unsupported burden', () => {
  const record = (n, warning, positive = false, overrides = {}) => ({
    label: {
      market: 'USDC',
      anchorAt: START + n * 6 * HOUR,
      status: 'observed',
      sampledCashBelowAmount: positive,
      ...overrides,
    },
    predictions: { trend: warning, alwaysNoCrossing: false, cashRatioBelowTwo: false },
    eventAt: positive ? START + 10 * 6 * HOUR : null,
  })
  const train = [
    record(0, true),
    record(1, true), // unsupported, 6h sampled span
    record(2, false), // observed no-warning breaks run
    record(3, true, true),
    record(4, true, true), // supported, 6h span
    record(5, null), // abstention breaks run
    record(6, true),
    record(7, true, false, { status: 'censored' }), // censor breaks run
    record(8, true),
    record(10, true), // 12h gap breaks run
    record(10, true, false, { market: 'DAI' }), // market boundary breaks run
  ]
  const scored = scoreMarketPeriods({ train, holdout: [] }).train.trend
  assert.deepEqual(scored.warningRuns, {
    total: 6,
    supported: 1,
    unsupported: 5,
    maxSampledAnchorSpanHours: 6,
  })
  assert.equal(scored.fp, 6)
  assert.equal(scored.censoredWarnings, 1)
  assert.equal(scored.events.captured, 1)
  assert.deepEqual(scored.events.leadToFirstSampledBelowQHours, [42])
})

test('pause is independent of sampled cash crossing', () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    row(i, 1_500_000, i === 2 ? { withdrawPaused: true } : {}),
  )
  const periods = evaluateMarketSeries(rows, options)
  assert.equal(periods.train[0].label.pauseObserved, true)
  assert.equal(periods.train[0].eventAt, null)
  const scored = scoreMarketPeriods(periods).train
  assert.equal(scored.trend.events.total, 0)
  assert.equal(scored.cashRatioBelowTwo.events.total, 0)
})
