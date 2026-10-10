import test from 'node:test'
import assert from 'node:assert/strict'
import {
  labelMarketSeries,
  evaluateHorizon,
  MIN_HORIZON_SECONDS,
} from './aave-cash-horizon-labels.mjs'

const H = 3600
const BOUNDARY = 2_000_000_000
const START = BOUNDARY - 100 * 86400
const row = (n, overrides = {}) => ({
  market: 'USDC',
  block: n,
  at: START + n * 6 * H,
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  cashUsdAssumingPeg: 2_000_000,
  ...overrides,
})
const options = { amountUsd: 1_000_000, horizonSeconds: 24 * H, boundaryAt: BOUNDARY }
const at = (rows, block) =>
  labelMarketSeries(rows, options).find((label) => label.anchorBlock === block)

test('quiet complete window records actual target sample and zero lag', () => {
  const labels = labelMarketSeries(
    Array.from({ length: 6 }, (_, i) => row(i)),
    options,
  )
  assert.equal(labels[0].status, 'observed')
  assert.equal(labels[0].sampledCashBelowAmount, false)
  assert.equal(labels[0].pauseObserved, false)
  assert.equal(labels[0].targetObservedAt, row(4).at)
  assert.equal(labels[0].targetObservationLagSeconds, 0)
})

test('the first sample after target records actual observation lag', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i))
  rows[4].at += H
  assert.equal(at(rows, 0).targetObservationLagSeconds, H)
})

test('a target observation later than eight hours is censored as a gap', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i))
  rows[4].at += 9 * H
  rows[5].at += 9 * H
  const label = at(rows, 0)
  assert.equal(label.status, 'censored')
  assert.equal(label.censorReason, 'gap')
  assert.equal(label.targetObservedAt, null)
})

test('gaps censor the entire outcome even if an earlier cash shortfall is seen', () => {
  const rows = [row(0), row(1, { cashUsdAssumingPeg: 500_000 }), row(3), row(4)]
  assert.deepEqual([at(rows, 0).status, at(rows, 0).censorReason], ['censored', 'gap'])
  assert.equal(at(rows, 0).sampledCashBelowAmount, null)
})

test('preexisting shortfall excludes anchor; later crossing is sampled cash outcome', () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    row(i, i === 0 || i === 2 ? { cashUsdAssumingPeg: 500_000 } : {}),
  )
  assert.equal(at(rows, 0), undefined)
  assert.equal(at(rows, 1).sampledCashBelowAmount, true)
})

test('pause is separate from sampled cash loss', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i, i === 2 ? { withdrawPaused: true } : {}))
  assert.equal(at(rows, 0).pauseObserved, true)
  assert.equal(at(rows, 0).sampledCashBelowAmount, false)
  assert.equal(at(rows, 2), undefined)
  const inactive = Array.from({ length: 6 }, (_, i) => row(i, i === 2 ? { active: false } : {}))
  assert.equal(at(inactive, 0).pauseObserved, false)
})

test('as-of cutoff never reads later samples into outcomes or anchor features', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    row(i, i === 4 ? { cashUsdAssumingPeg: 500_000 } : {}),
  )
  const labels = labelMarketSeries(rows, { ...options, asOfAt: row(3).at })
  assert.equal(labels.length, 4)
  assert.deepEqual(
    [labels[0].status, labels[0].censorReason, labels[0].sampledCashBelowAmount],
    ['censored', 'pending_as_of', null],
  )
})

test('window touching boundary plus or minus 24h is purged from both splits', () => {
  const base = BOUNDARY - 57 * H
  const rows = Array.from({ length: 24 }, (_, i) => row(i, { at: base + i * 6 * H }))
  const labels = labelMarketSeries(rows, { ...options, boundaryAt: BOUNDARY })
  assert.equal(
    labels.some((x) => x.anchorBlock === 0),
    true,
  ) // ends just before purge
  assert.equal(
    labels.some((x) => x.anchorBlock === 1),
    false,
  ) // window touches purge
  assert.equal(
    labels.some((x) => x.anchorAt <= BOUNDARY + 24 * H && x.split === 'holdout'),
    false,
  )
})

test('horizon below the eight-hour sampling resolution is rejected', () => {
  assert.throws(
    () => labelMarketSeries([row(0)], { ...options, horizonSeconds: MIN_HORIZON_SECONDS - 1 }),
    /8h through 30d/,
  )
})

test('near-end anchors remain in denominator as censored', () => {
  const labels = labelMarketSeries([row(0), row(1)], options)
  assert.equal(labels.length, 2)
  assert.deepEqual(
    labels.map((x) => x.censorReason),
    ['near_end', 'near_end'],
  )
})

test('evaluation refuses incomplete source even when synthetic entries are provided', () => {
  assert.throws(
    () => evaluateHorizon({ status: 'partial', entries: [], failures: [] }, options),
    /Checkpoint/,
  )
})
