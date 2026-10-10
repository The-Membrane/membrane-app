import assert from 'node:assert/strict'
import test from 'node:test'
import { readHistorical } from './curve-prospective-level-forecast.mjs'
import { endpointAt, forecastAt } from './curve-quote-level-backtest.mjs'
import {
  runStrictWindowSensitivity,
  strictWindowForecastAt,
} from './curve-quote-strict-window-sensitivity.mjs'

const HOUR = 3600
const start = 1_790_000_000
const rows = Array.from({ length: 560 }, (_, i) => ({
  at: start + i * HOUR,
  block: 1000 + i,
  quote: 0.999 + (i % 17) * 0.00001 + (i % 11) * 0.000001,
}))
const outcomes = (input, horizon) => input.map((_, i) => endpointAt(input, i, horizon))

test('strict selection excludes open windows and admits exact closure', () => {
  const halfHourly = Array.from({ length: 56 }, (_, i) => ({
    at: start + i * 1800,
    block: 1000 + i,
    quote: 1 + i * 0.000001,
  }))
  const values = outcomes(halfHourly, 24)
  const before = strictWindowForecastAt(halfHourly, values, 50, 24)
  const exact = strictWindowForecastAt(halfHourly, values, 51, 24)
  assert.ok(!before.selectedIndexes.includes(0))
  assert.ok(exact.selectedIndexes.includes(0))
  assert.equal(exact.availableAnalogs, 1)
})

test('strict forecast cannot consume any future row or future outcome revision', () => {
  const index = 300
  const original = strictWindowForecastAt(rows, outcomes(rows, 24), index, 24)
  const changed = rows.map((row, i) => ({ ...row, quote: i > index ? row.quote + 0.1 : row.quote }))
  assert.deepEqual(strictWindowForecastAt(changed, outcomes(changed, 24), index, 24), original)
  for (const j of original.selectedIndexes)
    assert.ok(rows[j].at + 24 * HOUR + 90 * 60 <= rows[index].at)
})

test('closed-window candidate preserves exact v2 ordering and endpoints once all windows close', () => {
  const input = [...rows.slice(0, 500), { ...rows[500], at: rows[499].at + 26 * HOUR }]
  const index = input.length - 1
  const values = outcomes(input, 24)
  const strict = strictWindowForecastAt(input, values, index, 24)
  const v2 = forecastAt(input, values, index, 24)
  assert.equal(strict.status, 'research_forecast')
  assert.equal(strict.availableAnalogs, v2.availableAnalogs)
  assert.equal(strict.selectedIndexes.length, 40)
  assert.deepEqual(strict.selectedIndexes, v2.selectedIndexes)
  assert.equal(strict.projectedQuote, v2.projectedQuote)
  assert.deepEqual(strict.empiricalAnalogInterval, v2.empiricalAnalogInterval)
  for (const j of strict.selectedIndexes) assert.equal(values[j].status, 'observed')
})

test('paired denominators and abstentions reconcile on both horizons', () => {
  for (const horizon of [24, 168]) {
    const result = runStrictWindowSensitivity(rows, horizon)
    for (const group of [
      result.rolling,
      result.nonOverlapping,
      result.finalQuarterLowerQuoteRegime,
    ]) {
      assert.equal(
        group.anchors,
        group.pendingWindow + group.missingTarget + group.censoredGap + group.observedOutcome,
      )
      assert.ok(group.matched <= group.strictAvailable)
      assert.ok(group.matched <= group.v2Available)
      assert.equal(group.strictAbstainWithV2Available, group.v2Available - group.matched)
    }
    assert.equal(result.rolling.anchors, rows.length - Math.floor(rows.length * 0.75))
    assert.ok(result.nonOverlapping.anchors <= result.rolling.anchors)
  }
})

test('real SHA-validated archive replays with paired scored anchors', () => {
  const historical = readHistorical()
  assert.equal(historical.length, 3184)
  for (const horizon of [24, 168]) {
    const result = runStrictWindowSensitivity(historical, horizon)
    assert.equal(result.sourceRows, 3184)
    assert.ok(result.rolling.matched > 0)
    assert.ok(result.rolling.v2Mae !== null)
    assert.ok(result.rolling.strictMae !== null)
    assert.ok(result.rolling.v2ProvisionalSelectedSlots >= 0)
    assert.equal(result.nonOverlapping.anchors, result.nonOverlappingAnchorIndexes.length)
  }
})

test('invalid source and unsupported horizon fail closed', () => {
  assert.throws(
    () => runStrictWindowSensitivity([rows[0], rows[1], { ...rows[1] }, rows[3]], 24),
    /nonmonotonic/,
  )
  assert.throws(() => runStrictWindowSensitivity(rows, 72), /Unsupported/)
})
