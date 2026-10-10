import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { buildIssue } from './curve-prospective-level-forecast.mjs'
import { endpointAt, forecastAt, runBacktest } from './curve-quote-level-backtest.mjs'

const HOUR = 3600
const start = 1_790_000_000
const sha = (s) => createHash('sha256').update(s).digest('hex')
const rows = Array.from({ length: 560 }, (_, i) => ({
  at: start + i * HOUR,
  block: 1000 + i,
  quote: 0.999 + (i % 17) * 0.00001 + (i % 11) * 0.000001,
}))

function replay(input, index, horizonHours) {
  const outcomes = input.map((_, j) => endpointAt(input, j, horizonHours))
  return forecastAt(input, outcomes, index, horizonHours)
}

function prospectiveAt(input, index, horizonHours) {
  const row = input[index]
  const hash = `0x${sha(`block-${index}`)}`
  const checkpoint = {
    filename: `${String(row.block).padStart(12, '0')}-${hash.slice(2)}.json`,
    physicalSha256: sha(`physical-${index}`),
    checkpoint: {
      sha256: sha(`logical-${index}`),
      source: { identitySha256: sha('source') },
      block: { number: row.block, hash, timestamp: row.at },
      captureEndUtc: new Date((row.at + 30) * 1000).toISOString(),
      routes: { 1000000: { bestQuote: row.quote } },
    },
  }
  return buildIssue({
    history: input.slice(0, index),
    checkpoints: [checkpoint],
    horizonHours,
    issuedAtUtc: new Date((row.at + 60) * 1000).toISOString(),
  })
}

test('offline replay agrees with the actual v2 issuer at 24h and 168h', () => {
  for (const horizonHours of [24, 168]) {
    for (const index of [300, 400, 500]) {
      const actual = prospectiveAt(rows, index, horizonHours)
      const simulated = replay(rows, index, horizonHours)
      assert.equal(simulated.status, actual.status)
      assert.equal(simulated.availableAnalogs, actual.availableAnalogs)
      assert.equal(simulated.selectedAnalogs, actual.selectedAnalogs)
      assert.equal(simulated.projectedQuote, actual.projectedQuote)
      assert.deepEqual(simulated.empiricalAnalogInterval, actual.empiricalAnalogInterval)
      assert.equal(simulated.persistenceQuote, actual.persistenceQuote)
    }
  }
})

test('future quote and endpoint changes cannot change an earlier forecast', () => {
  const index = 300
  const original = replay(rows, index, 24)
  const changed = rows.map((row, i) => ({
    ...row,
    quote: i > index ? row.quote + 0.1 : row.quote,
  }))
  assert.deepEqual(replay(changed, index, 24), original)
})

test('outcome is unavailable until an eligible target observation and censors gaps', () => {
  const sample = [
    { at: start, block: 1, quote: 1 },
    { at: start + 23 * HOUR, block: 2, quote: 0.99 },
    { at: start + 24 * HOUR, block: 3, quote: 0.98 },
  ]
  assert.equal(endpointAt(sample, 0, 24, start + 22 * HOUR).status, 'missing_target')
  assert.equal(endpointAt(sample, 0, 24, Infinity).status, 'censored_gap')
  const regular = Array.from({ length: 30 }, (_, i) => ({
    at: start + i * HOUR,
    block: i + 1,
    quote: 1 - i * 0.0001,
  }))
  assert.equal(endpointAt(regular, 0, 24, Infinity).status, 'observed')
})

test('denominators reconcile and timestamp-spaced subset is no larger than rolling', () => {
  for (const horizonHours of [24, 168]) {
    const result = runBacktest(rows, horizonHours)
    for (const group of [
      result.rolling,
      result.nonOverlapping,
      ...result.temporalQuartiles,
      result.finalQuarterQuoteRegimes.lower,
      result.finalQuarterQuoteRegimes.middle,
      result.finalQuarterQuoteRegimes.upper,
    ])
      assert.equal(
        group.anchors,
        group.eligible +
          group.pendingWindow +
          group.missingTarget +
          group.censoredGap +
          group.insufficientSample,
      )
    assert.ok(result.nonOverlapping.anchors <= result.rolling.anchors)
    assert.equal(result.rolling.anchors, rows.length - Math.floor(rows.length * 0.75))
    assert.match(result.evaluation, /not untouched holdout/)
  }
})

test('last temporal quarter matches rolling evaluation for uneven row counts', () => {
  const uneven = rows.slice(0, 557)
  const result = runBacktest(uneven, 24)
  assert.equal(result.temporalQuartiles[3].anchors, result.rolling.anchors)
  assert.deepEqual(
    { ...result.temporalQuartiles[3], quarter: undefined, exploredFinalQuarter: undefined },
    { ...result.rolling, quarter: undefined, exploredFinalQuarter: undefined },
  )
})

test('an observed endpoint remains pending until the full ±90m score window closes', () => {
  const input = rows.slice(0, 400)
  const result = runBacktest(input, 24)
  assert.ok(result.rolling.pendingWindow >= 1)
  assert.equal(result.rolling.anchors, 100)
})

test('nonmonotonic and future-valued source rows fail closed', () => {
  assert.throws(() => runBacktest([{ ...rows[0] }, { ...rows[0] }], 24), /nonmonotonic/)
  assert.throws(
    () => runBacktest([{ ...rows[0] }, { ...rows[1], quote: Number.NaN }], 24),
    /Invalid/,
  )
})
