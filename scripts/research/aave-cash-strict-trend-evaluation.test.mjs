import test from 'node:test'
import assert from 'node:assert/strict'
import { readCheckpoint } from './aave-stable-expansion.mjs'
import { SOURCE } from './aave-cash-horizon-labels.mjs'
import {
  evaluateStrictMarketSeries,
  evaluateStrictTrend,
  nonoverlapRecords,
  scoreStrictRecords,
} from './aave-cash-strict-trend-evaluation.mjs'

const H = 3600
const START = 1_900_000_000
const row = (n, changes = {}) => ({
  market: 'USDC',
  block: n,
  at: START + n * 6 * H,
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  cashUsdAssumingPeg: 2_000_000,
  ...changes,
})
const options = {
  amountUsd: 1_000_000,
  horizonSeconds: 24 * H,
  boundaryAt: START + 100 * 86400,
}

test('strict scoring ignores first below-q sample after H', () => {
  const rows = [
    row(0),
    row(1),
    row(2),
    row(3),
    row(4, { at: row(4).at + H, cashUsdAssumingPeg: 500_000 }),
  ]
  const record = evaluateStrictMarketSeries(rows, options)[0]
  assert.equal(record.label.status, 'observed')
  assert.equal(record.label.legacyLagInclusiveBreach, true)
  assert.equal(record.label.breachedByH, false)
  const scored = scoreStrictRecords([record])
  assert.equal(scored.labels.noSampledBreachByH, 1)
  assert.equal(scored.alwaysNoBreach.tn, 1)
})

test('positive strict event and trailing trend only use previous samples', () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    row(i, { cashUsdAssumingPeg: i < 4 ? 2_000_000 : i < 7 ? 1_200_000 : 500_000 }),
  )
  const records = evaluateStrictMarketSeries(rows, options)
  assert.equal(records[0].predictions.trend, null)
  const anchor = records.find((record) => record.label.anchorBlock === 4)
  assert.equal(anchor.label.breachedByH, true)
  assert.equal(anchor.predictions.trend, true)
  assert.equal(scoreStrictRecords([anchor]).trend.tp, 1)
})

test('censor and pending remain separate from confusion denominators', () => {
  const labels = [
    {
      market: 'USDC',
      split: 'train',
      anchorAt: 0,
      targetAt: 24,
      status: 'observed',
      breachedByH: true,
    },
    {
      market: 'USDC',
      split: 'train',
      anchorAt: 1,
      targetAt: 25,
      status: 'censored',
      breachedByH: null,
    },
    {
      market: 'USDC',
      split: 'train',
      anchorAt: 2,
      targetAt: 26,
      status: 'pending',
      breachedByH: null,
    },
  ]
  const records = labels.map((label, i) => ({
    label,
    predictions: { trend: i === 0 ? null : true, alwaysNoBreach: false, cashRatioBelowTwo: false },
  }))
  const scored = scoreStrictRecords(records)
  assert.deepEqual(
    [scored.labels.observed, scored.labels.censored, scored.labels.pending],
    [1, 1, 1],
  )
  assert.equal(scored.trend.abstainedObserved, 1)
  assert.equal(scored.trend.warningsOnCensored, 1)
  assert.equal(scored.trend.warningsOnPending, 1)
  assert.equal(scored.trend.tp + scored.trend.fp + scored.trend.tn + scored.trend.fn, 0)
})

test('nonoverlap uses fixed full window per market and split', () => {
  const record = (market, split, anchorAt, targetAt) => ({
    label: { market, split, anchorAt, targetAt },
  })
  const records = [
    record('USDC', 'train', 10, 30),
    record('USDC', 'train', 30, 50),
    record('USDC', 'train', 31 + 8 * H, 50 + 8 * H),
    record('DAI', 'train', 11, 31),
    record('USDC', 'holdout', 12, 32),
  ]
  const selected = nonoverlapRecords(records)
  assert.deepEqual(
    selected.map(({ label }) => [label.market, label.split, label.anchorAt]),
    [
      ['DAI', 'train', 11],
      ['USDC', 'train', 10],
      ['USDC', 'holdout', 12],
      ['USDC', 'train', 31 + 8 * H],
    ],
  )
})

test('frozen evaluation preserves denominators and keeps predictive gate closed', () => {
  const checkpoint = readCheckpoint(SOURCE)
  const report = evaluateStrictTrend(checkpoint, { amountUsd: 1_000_000, horizonSeconds: 24 * H })
  assert.equal(report.sourceEntriesSha256, checkpoint.entriesSha256)
  assert.equal(report.predictiveGatePassed, false)
  for (const split of ['train', 'holdout'])
    for (const key of ['allAnchors', 'nonoverlap']) {
      const { labels, trend, alwaysNoBreach } = report.total[split][key]
      assert.equal(labels.eligible, labels.observed + labels.censored + labels.pending)
      assert.equal(labels.observed, labels.breachedByH + labels.noSampledBreachByH)
      assert.equal(
        labels.observed,
        trend.tp + trend.fp + trend.tn + trend.fn + trend.abstainedObserved,
      )
      assert.equal(alwaysNoBreach.tp + alwaysNoBreach.fp, 0)
    }
  assert.ok(
    report.total.train.nonoverlap.labels.eligible < report.total.train.allAnchors.labels.eligible,
  )
})
