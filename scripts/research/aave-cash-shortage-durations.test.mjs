import test from 'node:test'
import assert from 'node:assert/strict'
import { readCheckpoint, snapshot } from './aave-stable-expansion.mjs'
import { SOURCE } from './aave-cash-horizon-labels.mjs'
import {
  analyzeMarketSeries,
  evaluateShortageDurations,
  summarizeMarket,
  summarizeTotal,
} from './aave-cash-shortage-durations.mjs'

const H = 3600
const BASE = 2_000_000_000
const Q = 1_000_000
const row = (n, cashUsdAssumingPeg, overrides = {}) => ({
  market: 'DAI',
  block: n,
  at: BASE + n * 6 * H,
  kind: 'observed',
  cashUsdAssumingPeg,
  ...overrides,
})
const analyze = (rows) => analyzeMarketSeries(rows, { amountUsd: Q })

test('fully bracketed run records observation spans, brackets, and sample fraction', () => {
  const rows = [row(0, Q), row(1, Q - 1), row(2, Q - 2), row(3, Q)]
  const before = structuredClone(rows)
  const a = analyze(rows)
  assert.deepEqual(rows, before)
  assert.equal(a.runs.length, 1)
  assert.deepEqual(
    {
      count: a.runs[0].belowSampleCount,
      span: a.runs[0].sampledSpanHours,
      left: a.runs[0].leftBracketWidthHours,
      right: a.runs[0].rightBracketWidthHours,
      toRecovery: a.runs[0].firstBelowToRecoveryHours,
      full: a.runs[0].fullyBracketed,
    },
    { count: 2, span: 6, left: 6, right: 6, toRecovery: 12, full: true },
  )
  assert.equal(summarizeMarket(a).fractionOfObservedSamplesBelow, 0.5)
  assert.deepEqual(summarizeMarket(a).fullyBracketedFirstBelowToRecoveryHours, {
    min: 12,
    median: 12,
    p90: 12,
    max: 12,
  })
})

test('edge censoring keeps runs but excludes them from fully bracketed spans', () => {
  const a = analyze([row(0, Q - 1), row(1, Q), row(2, Q - 1)])
  assert.deepEqual(
    a.runs.map((r) => [r.leftCensorReason, r.rightCensorReason, r.fullyBracketed]),
    [
      ['series_edge', null, false],
      [null, 'series_edge', false],
    ],
  )
  assert.equal(summarizeMarket(a).fullyBracketedFirstBelowToRecoveryHours, null)
  assert.equal(summarizeMarket(a).leftCensoredRunCount, 1)
  assert.equal(summarizeMarket(a).rightCensoredRunCount, 1)
})

test('gap splits sampled below rows and censors both sides', () => {
  const a = analyze([row(0, Q), row(1, Q - 1), row(3, Q - 1), row(4, Q)])
  assert.equal(a.runs.length, 2)
  assert.deepEqual(
    a.runs.map((r) => [r.leftCensorReason, r.rightCensorReason]),
    [
      [null, 'gap'],
      ['gap', null],
    ],
  )
  assert.equal(a.runs[1].firstBelowToRecoveryHours, 6)
  assert.equal(a.runs[1].fullyBracketed, false)
})

test('non-observed rows censor adjacent sampled runs', () => {
  const a = analyze([
    row(0, Q),
    row(1, Q - 1),
    row(2, undefined, { kind: 'ineligible' }),
    row(3, Q - 1),
    row(4, Q),
  ])
  assert.deepEqual(
    a.runs.map((r) => [r.leftCensorReason, r.rightCensorReason]),
    [
      [null, 'ineligible_sample'],
      ['ineligible_sample', null],
    ],
  )
  assert.equal(a.observedSamples, 4)
  assert.equal(a.belowSamples, 2)
})

test('zero runs and zero observed samples have explicit null descriptive fields', () => {
  const noShortage = summarizeMarket(analyze([row(0, Q), row(1, Q + 1)]))
  assert.equal(noShortage.runCount, 0)
  assert.equal(noShortage.maxSampledRunSpanHours, null)
  assert.equal(noShortage.fractionOfObservedSamplesBelow, 0)
  const noObservation = summarizeMarket(analyze([row(0, undefined, { kind: 'ineligible' })]))
  assert.equal(noObservation.fractionOfObservedSamplesBelow, null)
})

test('quantiles use only fully bracketed runs with nearest-rank p90', () => {
  const spans = [6, 12, 18, 24, 30]
  const analysis = {
    runs: spans.map((hours) => ({
      fullyBracketed: true,
      leftBracketed: true,
      rightBracketed: true,
      firstBelowToRecoveryHours: hours,
      sampledSpanHours: hours - 6,
    })),
    observedSamples: 10,
    belowSamples: 5,
  }
  assert.deepEqual(summarizeMarket(analysis).fullyBracketedFirstBelowToRecoveryHours, {
    min: 6,
    median: 18,
    p90: 30,
    max: 30,
  })
})

test('pooled totals omit duration statistics even with a long censored run', () => {
  const recovered = analyze([row(0, Q), row(1, Q - 1), row(2, Q)])
  const censored = analyze([
    row(0, Q - 1),
    row(1, Q - 1, { at: BASE + 6 * H }),
    row(2, Q - 1, { at: BASE + 12 * H }),
  ])
  const aggregate = {
    runs: [...recovered.runs, ...censored.runs],
    observedSamples: recovered.observedSamples + censored.observedSamples,
    belowSamples: recovered.belowSamples + censored.belowSamples,
  }
  assert.equal(summarizeMarket(recovered).fullyBracketedFirstBelowToRecoveryHours.median, 6)
  assert.equal(summarizeMarket(censored).maxSampledRunSpanHours, 12)
  assert.equal(summarizeMarket(censored).belowSamplesInCensoredRuns, 3)
  assert.equal(summarizeMarket(censored).fractionOfBelowSamplesInCensoredRuns, 1)
  const total = summarizeTotal(aggregate)
  assert.deepEqual(
    {
      runs: total.runCount,
      full: total.fullyBracketedRunCount,
      leftCensored: total.leftCensoredRunCount,
      rightCensored: total.rightCensoredRunCount,
    },
    { runs: 2, full: 1, leftCensored: 1, rightCensored: 1 },
  )
  assert.equal('fullyBracketedFirstBelowToRecoveryHours' in total, false)
  assert.equal('maxSampledRunSpanHours' in total, false)
  assert.equal(total.belowSamplesInCensoredRuns, 3)
  assert.equal(total.fractionOfBelowSamplesInCensoredRuns, 0.75)
})

test('a structurally valid but altered source cohort is rejected', () => {
  const original = readCheckpoint(SOURCE)
  assert.ok(original)
  const observedIndex = original.entries.findIndex((entry) => entry.kind === 'observed')
  assert.ok(observedIndex >= 0)
  const entries = original.entries.map((entry, index) =>
    index === observedIndex
      ? { ...entry, cashUsdAssumingPeg: entry.cashUsdAssumingPeg + 1 }
      : entry,
  )
  const altered = snapshot(entries, [])
  assert.notEqual(altered.entriesSha256, original.entriesSha256)
  assert.throws(
    () => evaluateShortageDurations(altered, { amountUsd: Q }),
    /digest differs from frozen local source/,
  )
})

test('invalid amount, ordering, row cash, and incomplete checkpoint fail closed', () => {
  for (const amountUsd of [0, -1, NaN, Infinity])
    assert.throws(() => analyzeMarketSeries([], { amountUsd }), /amountUsd/)
  assert.throws(() => analyze([row(1, Q), row(0, Q)]), /time-ordered/)
  assert.throws(() => analyze([row(0, -1)]), /Observed cash/)
  assert.throws(() => analyze([row(0, NaN)]), /Observed cash/)
  assert.throws(
    () =>
      evaluateShortageDurations({ status: 'partial', entries: [], failures: [] }, { amountUsd: Q }),
    /Checkpoint/,
  )
})
