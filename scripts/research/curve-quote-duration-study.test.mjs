import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  THRESHOLD,
  assertSealedSourcePath,
  firstBreach,
  forecastAt,
  nonOverlappingIndexes,
  observedAtHorizon,
  pastTrend,
  prepareRows,
  survivalAt,
} from './curve-quote-duration-study.mjs'

const HOUR = 3600
const series = (quotes, spacing = 3 * HOUR) =>
  prepareRows(
    quotes.map((quote, i) => ({
      at: 1_000_000 + i * spacing,
      quote,
      block: i,
    })),
  )

test('strict below-threshold first breach retains observation interval, including zero quote', () => {
  const rows = series([1, THRESHOLD, 0.998, 0])
  const result = firstBreach(rows, 0)
  assert.equal(result.status, 'breach')
  assert.deepEqual(result.interval, [rows[1].at, rows[2].at])
  assert.equal(result.previousNotBelowHours, 3)
  assert.equal(observedAtHorizon(result, 3), 1) // equality is not strictly below 0.999
  assert.equal(result.durationHours, 6)
  assert.equal(firstBreach(rows, 1).status, 'ineligible_anchor')
  assert.equal(firstBreach(series([1, 0]), 0).status, 'breach')
})

test('an observation gap censors at the last observed not-below-threshold quote', () => {
  const rows = prepareRows([
    { at: 1000, quote: 1 },
    { at: 1000 + 3 * HOUR, quote: 1 },
    { at: 1000 + 9 * HOUR, quote: 0 },
  ])
  const result = firstBreach(rows, 0)
  assert.equal(result.status, 'censored_gap')
  assert.equal(result.durationHours, 3)
  assert.equal(observedAtHorizon(result, 24), null)
})

test('data end right-censors and interval crossing a horizon stays unresolved', () => {
  const rows = series([1, 1, 0.998])
  assert.equal(firstBreach(rows, 0, 1).status, 'censored_end')
  assert.equal(observedAtHorizon(firstBreach(rows, 0, 1), 24), null)
  const outcome = firstBreach(rows, 0)
  assert.equal(observedAtHorizon(outcome, 3), 1)
  assert.equal(observedAtHorizon(outcome, 4), null)
  assert.equal(observedAtHorizon(outcome, 6), 0)
})

test('a near-seven-day checkpoint resolves survival but a crossing breach interval does not', () => {
  const input = Array.from({ length: 57 }, (_, i) => ({
    at: 1_000_000 + (i === 56 ? 169 : i * 3) * HOUR,
    quote: 1,
  }))
  const above = prepareRows(input)
  assert.equal(observedAtHorizon(firstBreach(above, 0), 168), 1)
  const breached = prepareRows(input.map((x, i) => (i === 56 ? { ...x, quote: 0.998 } : x)))
  assert.deepEqual(firstBreach(breached, 0).interval, [above[55].at, above[56].at])
  assert.equal(observedAtHorizon(firstBreach(breached, 0), 168), null)
})

test('past trend and analog forecasts cannot see a future quote or candidate future outcome', () => {
  const quotes = Array.from({ length: 60 }, (_, i) => (i % 15 === 14 ? 0.998 : 1))
  const original = series(quotes)
  const index = 40
  const baseline = forecastAt(original, index, 24, { minRisk: 1, minEvents: 0 })
  const changedFuture = series(quotes.map((q, i) => (i > index ? 0 : q)))
  assert.deepEqual(forecastAt(changedFuture, index, 24, { minRisk: 1, minEvents: 0 }), baseline)
  assert.equal(pastTrend(original, index), pastTrend(changedFuture, index))
  assert.notEqual(firstBreach(original, 20, index).status, 'censored_end')
})

test('risk set reports censoring and abstains when event support is thin', () => {
  const rows = series([1, 1, 0.998])
  const out = [firstBreach(rows, 0), firstBreach(rows, 0, 1)]
  const result = survivalAt(out, 24)
  assert.equal(result.riskSet, 1)
  assert.equal(result.observedBreaches, 1)
  assert.equal(result.censored, 1)
  assert.equal(result.status, 'abstain_insufficient_risk_or_events')
  const supported = survivalAt(out, 24, { minRisk: 1, minEvents: 1 })
  assert.equal(supported.noBelowThresholdBreachFraction, 0)
  assert.deepEqual(
    supported.descriptiveWilson95.map((x) => Number(x.toFixed(4))),
    [0, 0.7935],
  )
})

test('strict nonoverlap selection is by timestamp before looking at outcomes', () => {
  const rows = series(Array(70).fill(1))
  const one = nonOverlappingIndexes(rows, 0, 24)
  const changed = rows.map((r, i) => ({ ...r, quote: i % 7 ? 1 : 0 }))
  assert.deepEqual(nonOverlappingIndexes(changed, 0, 24), one)
  for (let i = 1; i < one.length; i++) assert.ok(rows[one[i]].at - rows[one[i - 1]].at >= 28 * HOUR)
})

test('exact physical SHA is required in addition to artifact catalog verification', () => {
  const good = '/tmp/ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a.json'
  assert.equal(assertSealedSourcePath(good), good)
  assert.throws(() => assertSealedSourcePath('/tmp/other.json'), /Unexpected source SHA/)
  assert.throws(
    () =>
      prepareRows([
        { at: 5, quote: 1 },
        { at: 4, quote: 1 },
      ]),
    /nonmonotonic/,
  )
})
