import assert from 'node:assert/strict'
import test from 'node:test'
import { endpointAt } from './curve-quote-level-backtest.mjs'
import { diverseForecastAt, runDiverseBacktest } from './curve-quote-diverse-backtest.mjs'

const HOUR = 3600
const start = 1_790_000_000
const rows = Array.from({ length: 1200 }, (_, i) => ({
  at: start + i * HOUR,
  block: i + 1,
  quote: 0.999 + (i % 17) * 0.00001 + (i % 11) * 0.000001,
}))

function replay(input, index, horizonHours) {
  const outcomes = input.map((_, j) => endpointAt(input, j, horizonHours))
  return diverseForecastAt(input, outcomes, index, horizonHours)
}

test('closed episode windows cannot touch; nearest order has recent-index tie break', () => {
  const sample = rows.slice(0, 300).map((row) => ({ ...row, quote: 1 }))
  const forecast = replay(sample, 299, 24)
  assert.equal(forecast.status, 'insufficient_distinct_episodes')
  assert.deepEqual(forecast.selectedIndexes.slice(0, 3), [276, 250, 224])
  assert.equal(forecast.provisionalSelectedEpisodes, 1)
  for (let i = 1; i < forecast.selectedIndexes.length; i++)
    assert.ok(
      Math.abs(
        sample[forecast.selectedIndexes[i]].at - sample[forecast.selectedIndexes[i - 1]].at,
      ) >
        24 * HOUR + 90 * 60,
    )
})

test('exact 25.5-hour boundary intersects for a 24-hour episode', () => {
  const halfHourly = Array.from({ length: 600 }, (_, i) => ({
    at: start + (i * HOUR) / 2,
    block: i + 1,
    quote: 1,
  }))
  const forecast = replay(halfHourly, 599, 24)
  assert.equal(forecast.selectedIndexes[0] - forecast.selectedIndexes[1], 52)
  assert.equal(
    halfHourly[forecast.selectedIndexes[0]].at - halfHourly[forecast.selectedIndexes[1]].at,
    26 * HOUR,
  )
})

test('evaluation windows exclude an anchor touching the previous closed end', () => {
  const halfHourly = Array.from({ length: 1200 }, (_, i) => ({
    at: start + (i * HOUR) / 2,
    block: i + 1,
    quote: 1,
  }))
  const result = runDiverseBacktest(halfHourly, 24)
  assert.deepEqual(result.nonOverlappingAnchorIndexes.slice(0, 3), [900, 952, 1004])
  assert.equal(result.nonOverlapping.anchors, result.nonOverlappingAnchorIndexes.length)
  assert.ok(result.rolling.provisionalSelectedEpisodeSlots > 0)
})

test('candidate cannot see any quote or endpoint after its issue', () => {
  const index = 1100
  const before = replay(rows, index, 24)
  const changed = rows.map((row, i) => ({ ...row, quote: i > index ? row.quote + 0.5 : row.quote }))
  assert.deepEqual(replay(changed, index, 24), before)
  const prefix = replay(rows.slice(0, index + 1), index, 24)
  assert.deepEqual(prefix, before)
})

test('fewer than 30 disjoint episodes abstains even when raw analogs exceed 40', () => {
  const forecast = replay(rows, 800, 24)
  assert.ok(forecast.availableAnalogs >= 40)
  assert.ok(forecast.selectedEpisodes < 30)
  assert.equal(forecast.status, 'insufficient_distinct_episodes')
  assert.equal(forecast.projectedQuote, null)
})

test('matched denominators reconcile for both horizons and nonoverlap stays separate', () => {
  for (const h of [24, 168]) {
    const result = runDiverseBacktest(rows, h)
    for (const group of [
      result.rolling,
      result.nonOverlapping,
      result.finalQuarterLowerQuoteRegime,
      ...result.temporalQuartiles,
    ]) {
      assert.equal(
        group.anchors,
        group.pendingWindow + group.missingTarget + group.censoredGap + group.observedOutcome,
      )
      assert.ok(group.matched <= Math.min(group.v2Available, group.diverseAvailable))
      assert.equal(group.diverseAbstainWithV2Available, group.v2Available - group.matched)
      assert.equal(group.v2Mae === null, group.matched === 0)
      assert.equal(group.diverseMae === null, group.matched === 0)
      assert.equal(group.persistenceMae === null, group.matched === 0)
      assert.ok(group.provisionalSelectedEpisodeSlots >= group.anchorsWithProvisionalSelection)
    }
    assert.equal(result.rolling.anchors, 300)
    assert.ok(result.nonOverlapping.anchors < result.rolling.anchors)
    assert.equal(result.temporalQuartiles[3].anchors, result.rolling.anchors)
    assert.match(result.evaluation, /not untouched holdout/)
  }
})

test('uneven row count uses identical final-quarter boundaries', () => {
  const result = runDiverseBacktest(rows.slice(0, 1197), 24)
  assert.deepEqual(
    { ...result.temporalQuartiles[3], quarter: undefined },
    { ...result.rolling, quarter: undefined },
  )
  assert.equal(result.rolling.anchors, 1197 - Math.floor(1197 * 0.75))
})

test('invalid source rows and unsupported horizon fail closed', () => {
  assert.throws(() => runDiverseBacktest([rows[0], rows[0], rows[2], rows[3]], 24), /nonmonotonic/)
  assert.throws(() => runDiverseBacktest(rows.slice(0, 4), 2), /Unsupported horizon/)
})
