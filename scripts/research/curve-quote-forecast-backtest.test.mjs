import assert from 'node:assert/strict'
import test from 'node:test'
import {
  forecastAt,
  joinFlowRows,
  nonOverlappingAnchorIndexes,
  prepareSeries,
  runBacktest,
} from './curve-quote-forecast-backtest.mjs'

const H = 3600
const start = 1_700_000_000
const rows = (n, step = 3) =>
  Array.from({ length: n }, (_, i) => ({
    at: start + i * step * H,
    block: i + 1,
    quote: 0.99 + i * 0.00001,
  }))
const flows = (source) =>
  source.map((row, i) => ({
    block: row.block,
    at: row.at,
    netCrvUsdFlow6h: { total: i * 1000 },
    netCrvUsdFlow24h: { total: -i * 5000 },
  }))

test('future outcomes never enter the analog set before their endpoint', () => {
  const source = rows(40)
  const initial = forecastAt(prepareSeries(source, 24), 20, { minAnalogs: 1 })
  const altered = source.map((row) => ({ ...row }))
  for (let i = 21; i < altered.length; i++) altered[i].quote = 0.8
  const replay = forecastAt(prepareSeries(altered, 24), 20, { minAnalogs: 1 })
  assert.deepEqual(replay, initial)
  assert.ok(initial.latestSelectedOutcomeAt <= source[20].at)
})

test('missing and gapped horizon endpoints are unavailable', () => {
  const missing = rows(8)
  assert.equal(prepareSeries(missing, 24).outcomes[0], null)
  const gapped = rows(20)
  for (let i = 9; i < gapped.length; i++) gapped[i].at += 9 * H
  assert.equal(prepareSeries(gapped, 24).outcomes[7], null)
  assert.equal(forecastAt(prepareSeries(gapped, 24), 9).status, 'unavailable')
})

test('measured zero quote is an unavailable anchor but a valid future outcome', () => {
  const source = rows(50)
  source[30].quote = 0
  const series = prepareSeries(source, 24)
  assert.equal(forecastAt(series, 30, { minAnalogs: 1 }).reason, 'zero_quote')
  assert.equal(series.outcomes[22].quote, 0)
  assert.equal(series.outcomes[22].delta, -source[22].quote)
  assert.throws(() => prepareSeries([{ ...source[0], quote: -1 }], 24), /Invalid/)
})

test('small histories expose insufficient sample, never a fabricated forecast', () => {
  const series = prepareSeries(rows(20), 24)
  const forecast = forecastAt(series, 12)
  assert.equal(forecast.status, 'insufficient_sample')
  assert.ok(forecast.availableAnalogs < forecast.requiredAnalogs)
  const holdout = runBacktest(rows(20), 24)
  assert.equal(holdout.holdout.evaluated, 0)
  assert.equal(holdout.holdout.analog.mae, null)
})

test('non-overlapping sensitivity strides by timestamps before outcome inspection', () => {
  const source = rows(132)
  assert.deepEqual(nonOverlappingAnchorIndexes(source, 99, 24), [99, 108, 117, 126])
  const regular = runBacktest(source, 24).holdout
  assert.equal(regular.anchors, 33)
  assert.equal(regular.nonOverlapping.anchors, 4)
  assert.equal(regular.nonOverlapping.evaluated, 3)
  assert.equal(regular.nonOverlapping.exclusions.incomplete_outcome, 1)

  const shifted = rows(132)
  for (let i = 105; i < shifted.length; i++) shifted[i].at += 18 * H
  assert.deepEqual(nonOverlappingAnchorIndexes(shifted, 99, 24), [99, 105, 114, 123])
  const irregular = runBacktest(shifted, 24).holdout
  assert.equal(irregular.nonOverlapping.anchors, 4)
  assert.equal(irregular.anchors, 33)
})

test('flow join fails closed on count, block, timestamp and nonfinite values', () => {
  const source = rows(3)
  const valid = flows(source)
  assert.equal(joinFlowRows(source, valid)[2].flow6h, 2000)
  assert.throws(() => joinFlowRows(source, valid.slice(1)), /count mismatch/)
  assert.throws(
    () =>
      joinFlowRows(
        source,
        valid.map((v, i) => (i === 1 ? { ...v, block: 99 } : v)),
      ),
    /identity/,
  )
  assert.throws(
    () =>
      joinFlowRows(
        source,
        valid.map((v, i) => (i === 1 ? { ...v, at: v.at + 1 } : v)),
      ),
    /identity/,
  )
  assert.throws(
    () =>
      joinFlowRows(
        source,
        valid.map((v, i) => (i === 1 ? { ...v, netCrvUsdFlow6h: { total: NaN } } : v)),
      ),
    /value/,
  )
})

test('future flow values cannot affect an as-of flow-aware forecast', () => {
  const source = rows(50)
  const initialFlows = flows(source)
  const first = forecastAt(prepareSeries(source, 24, initialFlows), 30, {
    minAnalogs: 1,
    variant: 'flow',
  })
  const alteredFlows = initialFlows.map((flow, i) =>
    i <= 30
      ? flow
      : {
          ...flow,
          netCrvUsdFlow6h: { total: 1e12 },
          netCrvUsdFlow24h: { total: -1e12 },
        },
  )
  const second = forecastAt(prepareSeries(source, 24, alteredFlows), 30, {
    minAnalogs: 1,
    variant: 'flow',
  })
  assert.deepEqual(second, first)
  assert.ok(first.latestSelectedOutcomeAt <= source[30].at)
})

test('latest flow context labels the sampled signed minimum without changing an anchor forecast', () => {
  const source = rows(120)
  const flowRows = flows(source)
  const result = runBacktest(source, 24, { flowRows })
  assert.equal(
    result.latestFlowAware.historicalMostNegativeObserved24hSwapNet.signedCrvUsdSoldIntoPools,
    -595_000,
  )
  assert.equal(
    result.latestFlowAware.historicalMostNegativeObserved24hSwapNet.asOf,
    source.at(-1).at,
  )
  assert.match(
    result.latestFlowAware.historicalMostNegativeObserved24hSwapNet.meaning,
    /not gross or maximum vault flow/,
  )
  assert.equal(
    forecastAt(prepareSeries(source, 24, flowRows), 119, { variant: 'flow' })
      .historicalMostNegativeObserved24hSwapNet,
    undefined,
  )
})
