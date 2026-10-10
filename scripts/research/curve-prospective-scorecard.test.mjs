import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildScorecard, runScorecard } from './curve-prospective-scorecard.mjs'

const HOUR = 3600
const START = Math.floor(Date.parse('2026-09-28T00:00:00.000Z') / 1000)
const empty = { issues: [], scores: [] }

function issue(lane, i, horizonHours = 24, overrides = {}) {
  const timestamp = START + i * 26 * HOUR
  const filename = `${lane}-${i}-${horizonHours}.json`
  return {
    filename,
    sha256: `${lane}-sha-${i}-${horizonHours}`,
    issuedAtUtc: new Date((timestamp + 60) * 1000).toISOString(),
    block: { number: i + 1, hash: `0x${String(i).padStart(64, '0')}`, timestamp },
    horizonHours,
    currentQuote: 1,
    ...(['quote', 'levelQuote'].includes(lane)
      ? {
          status: 'research_forecast',
          projectedQuote: 0.99,
          empiricalAnalogInterval: [0.98, 1.01],
        }
      : {
          status: 'research_only',
          analog: { status: 'exploratory_estimate', noBelowThresholdBreachFraction: 0.8 },
        }),
    ...overrides,
  }
}

function score(lane, row, actual = 1) {
  return {
    issueFilename: row.filename,
    issueSha256: row.sha256,
    horizonHours: row.horizonHours,
    targetAt: row.block.timestamp + row.horizonHours * HOUR,
    ...(['quote', 'levelQuote'].includes(lane)
      ? {
          status: 'observed',
          actualQuote: actual,
          ...(lane === 'levelQuote'
            ? {
                scoredAtUtc: new Date(
                  (row.block.timestamp + row.horizonHours * HOUR + 2 * HOUR) * 1000,
                ).toISOString(),
              }
            : {}),
        }
      : {
          stateAtHorizon:
            actual === 1 ? 'no_below_threshold_breach_observed' : 'first_breach_observed',
        }),
  }
}

test('rejects future issue, post-target issuance, and score identity leakage', () => {
  const row = issue('quote', 0)
  assert.throws(
    () =>
      buildScorecard({
        quote: { issues: [row], scores: [] },
        duration: empty,
        asOfSeconds: START + 30,
      }),
    /cutoff/,
  )
  assert.throws(
    () =>
      buildScorecard({
        quote: { issues: [row], scores: [] },
        duration: empty,
        asOfSeconds: START - 1,
      }),
    /cutoff/,
  )
  assert.throws(
    () =>
      buildScorecard({
        quote: {
          issues: [
            issue('quote', 0, 24, {
              issuedAtUtc: new Date((START + 24 * HOUR) * 1000).toISOString(),
            }),
          ],
          scores: [],
        },
        duration: empty,
        asOfSeconds: START + 24 * HOUR,
      }),
    /non-prospective/,
  )
  assert.throws(
    () =>
      buildScorecard({
        quote: {
          issues: [row],
          scores: [{ ...score('quote', row), issueSha256: 'future-rewrite' }],
        },
        duration: empty,
        asOfSeconds: START + 26 * HOUR,
      }),
    /Unmatched/,
  )
  assert.throws(
    () =>
      buildScorecard({
        quote: { issues: [row], scores: [score('quote', row)] },
        duration: empty,
        asOfSeconds: START + 23 * HOUR,
      }),
    /endpoint window/,
  )
})

test('one episode across lanes; overlapping hourly issues cannot inflate selected denominator', () => {
  const firstQuote = issue('quote', 0)
  const firstDuration = issue('duration', 0)
  const nextQuote = issue('quote', 1, 24, {
    block: { number: 2, hash: '0xnext', timestamp: START + HOUR },
    issuedAtUtc: new Date((START + HOUR + 60) * 1000).toISOString(),
  })
  const card = buildScorecard({
    quote: {
      issues: [firstQuote, nextQuote],
      scores: [score('quote', firstQuote, 0.99), score('quote', nextQuote, 0.99)],
    },
    duration: { issues: [firstDuration], scores: [score('duration', firstDuration, 1)] },
    asOfSeconds: START + 48 * HOUR,
  })
  assert.equal(card.byPeriod.development.quote[24].selectedEpisodes, 1)
  assert.equal(card.byPeriod.development.quote[24].overlapExcluded, 1)
  assert.equal(card.byPeriod.development.duration[24].selectedEpisodes, 1)
  assert.equal(card.byPeriod.development.quote[24].modelMae, null)
})

test('an earlier v1 issue cannot exclude v2 first issue at a distinct start', () => {
  const firstQuote = issue('quote', 0)
  const levelFirst = issue('levelQuote', 1, 24, {
    block: { number: 2, hash: '0xlevel-first', timestamp: START + HOUR },
    issuedAtUtc: new Date((START + HOUR + 60) * 1000).toISOString(),
  })
  const levelOverlap = issue('levelQuote', 2, 24, {
    block: { number: 3, hash: '0xlevel-second', timestamp: START + 2 * HOUR },
    issuedAtUtc: new Date((START + 2 * HOUR + 60) * 1000).toISOString(),
  })
  const card = buildScorecard({
    quote: { issues: [firstQuote], scores: [] },
    levelQuote: { issues: [levelFirst, levelOverlap], scores: [] },
    duration: empty,
    asOfSeconds: START + 3 * HOUR,
  })
  const v2 = card.byPeriod.development.levelQuote[24]
  assert.equal(card.byPeriod.development.quote[24].selectedEpisodes, 1)
  assert.equal(v2.issued, 2)
  assert.equal(v2.selectedEpisodes, 1)
  assert.equal(v2.overlapExcluded, 1)
  assert.equal(v2.pending, 1)
  assert.equal(v2.pendingAllIssued, 2)
  assert.equal(
    v2.issued,
    v2.pendingAllIssued +
      v2.missingMaturedScoreAllIssued +
      v2.censoredOrUnresolvedAllIssued +
      v2.resolvedAllIssued,
  )
})

test('pending, missing matured, censored and model abstentions have separate denominators', () => {
  const rows = [
    issue('quote', 0, 168),
    issue('quote', 1, 24, {
      status: 'unavailable',
      projectedQuote: null,
      empiricalAnalogInterval: null,
    }),
    issue('quote', 2, 24),
  ]
  const card = buildScorecard({
    quote: {
      issues: rows,
      scores: [{ ...score('quote', rows[2]), status: 'censored_gap', actualQuote: null }],
    },
    duration: empty,
    asOfSeconds: rows[2].block.timestamp + 26 * HOUR,
  })
  const q24 = card.byPeriod.development.quote[24]
  assert.equal(card.byPeriod.development.quote[168].pending, 1)
  assert.equal(q24.missingMaturedScore, 1)
  assert.equal(q24.censoredOrUnresolved, 1)
  assert.equal(q24.modelAbstained, 1)
  assert.equal(q24.pairedScored, 0)
})

test('fixed periods are assigned by issue time with no transfer of metrics across splits', () => {
  const rows = Array.from({ length: 30 }, (_, i) => issue('quote', i))
  const periods = [
    {
      name: 'development',
      startUtc: '2026-09-27T00:00:00.000Z',
      endUtc: '2026-10-27T00:00:00.000Z',
    },
    { name: 'calibration', startUtc: '2026-10-27T00:00:00.000Z', endUtc: null },
  ]
  const card = buildScorecard({
    quote: { issues: rows, scores: rows.map((r) => score('quote', r, 0.99)) },
    duration: empty,
    asOfSeconds: rows.at(-1).block.timestamp + 26 * HOUR,
    periods,
  })
  const q = card.byPeriod.development.quote[24]
  assert.equal(q.pairedScored, 27) // Last three issue times cross into October 27 calibration.
  assert.equal(q.modelMae, null)
  assert.equal(card.byPeriod.calibration.quote[24].pairedScored, 3)
  assert.equal(card.byPeriod.calibration.quote[24].modelMae, null)
})

test('synthetic 30 nonoverlapping quote outcomes compare immutable predictions to persistence', () => {
  const rows = Array.from({ length: 30 }, (_, i) => issue('quote', i))
  const period = [{ name: 'evaluation', startUtc: '2026-09-27T00:00:00.000Z', endUtc: null }]
  const card = buildScorecard({
    quote: { issues: rows, scores: rows.map((r) => score('quote', r, 0.99)) },
    duration: empty,
    asOfSeconds: rows.at(-1).block.timestamp + 26 * HOUR,
    periods: period,
  })
  const q = card.byPeriod.evaluation.quote[24]
  assert.equal(q.pairedScored, 30)
  assert.equal(q.modelMae, 0)
  assert.ok(Math.abs(q.persistenceMae - 0.01) < 1e-12)
  assert.equal(q.empiricalIntervalCoverage, 1)
  assert.equal(card.forecastReady, false)
})

test('level quote gets separate nonoverlapping accuracy and an exploratory interval only', () => {
  const rows = Array.from({ length: 30 }, (_, i) => issue('levelQuote', i))
  const period = [{ name: 'evaluation', startUtc: '2026-09-27T00:00:00.000Z', endUtc: null }]
  const card = buildScorecard({
    quote: empty,
    levelQuote: { issues: rows, scores: rows.map((r) => score('levelQuote', r, 0.99)) },
    duration: empty,
    asOfSeconds: rows.at(-1).block.timestamp + 27 * HOUR,
    periods: period,
  })
  const level = card.byPeriod.evaluation.levelQuote[24]
  assert.equal(level.pairedScored, 30)
  assert.equal(level.modelMae, 0)
  assert.ok(Math.abs(level.persistenceMae - 0.01) < 1e-12)
  assert.equal(level.empiricalIntervalCoverage, 1)
  assert.equal(level.verdict, 'research_evaluation_only')
  assert.equal(card.byPeriod.evaluation.quote[24].pairedScored, 0)
  assert.equal(card.forecastReady, false)
  assert.match(card.caveat, /exploratory, not calibrated/)
})

test('v1 and v2 cases never pool into a 30-episode accuracy sample', () => {
  const q = Array.from({ length: 15 }, (_, i) => issue('quote', i))
  const level = Array.from({ length: 15 }, (_, i) => issue('levelQuote', i))
  const card = buildScorecard({
    quote: { issues: q, scores: q.map((r) => score('quote', r, 0.99)) },
    levelQuote: { issues: level, scores: level.map((r) => score('levelQuote', r, 0.99)) },
    duration: empty,
    asOfSeconds: level.at(-1).block.timestamp + 27 * HOUR,
  })
  assert.equal(card.byPeriod.development.quote[24].pairedScored, 15)
  assert.equal(card.byPeriod.development.levelQuote[24].pairedScored, 15)
  assert.equal(card.byPeriod.development.quote[24].modelMae, null)
  assert.equal(card.byPeriod.development.levelQuote[24].modelMae, null)
})

test('level score time and pending, matured, censored denominators are explicit', () => {
  const rows = [issue('levelQuote', 0, 168), issue('levelQuote', 1, 24), issue('levelQuote', 2, 24)]
  const censored = { ...score('levelQuote', rows[2]), status: 'censored_gap', actualQuote: null }
  const asOfSeconds = rows[2].block.timestamp + 27 * HOUR
  const input = {
    quote: empty,
    levelQuote: { issues: rows, scores: [censored] },
    duration: empty,
    asOfSeconds,
  }
  const card = buildScorecard(input)
  assert.equal(card.byPeriod.development.levelQuote[168].pending, 1)
  const lane = card.byPeriod.development.levelQuote[24]
  assert.equal(lane.missingMaturedScore, 1)
  assert.equal(lane.missingMaturedScoreAllIssued, 1)
  assert.equal(lane.censoredOrUnresolved, 1)
  assert.equal(lane.censoredOrUnresolvedAllIssued, 1)
  assert.equal(
    lane.issued,
    lane.pendingAllIssued +
      lane.missingMaturedScoreAllIssued +
      lane.censoredOrUnresolvedAllIssued +
      lane.resolvedAllIssued,
  )
  assert.equal(lane.pairedScored, 0)
  assert.throws(
    () =>
      buildScorecard({
        ...input,
        levelQuote: {
          issues: rows,
          scores: [{ ...censored, scoredAtUtc: new Date((asOfSeconds + 1) * 1000).toISOString() }],
        },
      }),
    /outside evidence cutoff/,
  )
})

test('resolved cases from two horizons cannot be pooled to pass the sample threshold', () => {
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => issue('quote', i, 24)),
    ...Array.from({ length: 15 }, (_, i) => issue('quote', i, 168)),
  ]
  const card = buildScorecard({
    quote: { issues: rows, scores: rows.map((r) => score('quote', r, 0.99)) },
    duration: empty,
    asOfSeconds: rows.at(-1).block.timestamp + 170 * HOUR,
  })
  assert.equal(card.byPeriod.development.quote[24].pairedScored, 15)
  assert.equal(card.byPeriod.development.quote[168].modelMae, null)
  assert.equal(card.byPeriod.development.quote[24].modelMae, null)
})

test('duration Brier stays withheld until enough nonoverlapping breach events', () => {
  const rows = Array.from({ length: 30 }, (_, i) => issue('duration', i))
  const period = [{ name: 'evaluation', startUtc: '2026-09-27T00:00:00.000Z', endUtc: null }]
  const make = (breaches) =>
    buildScorecard({
      quote: empty,
      duration: {
        issues: rows,
        scores: rows.map((r, i) => score('duration', r, i < breaches ? 0 : 1)),
      },
      asOfSeconds: rows.at(-1).block.timestamp + 26 * HOUR,
      periods: period,
    })
  assert.equal(make(4).byPeriod.evaluation.duration[24].modelBrier, null)
  const d = make(5).byPeriod.evaluation.duration[24]
  assert.equal(d.pairedScored, 30)
  assert.ok(d.modelBrier < d.persistenceBrier)
  assert.equal(d.verdict, 'research_evaluation_only')
})

test(
  'local sealed corpus verifies and remains an abstention',
  { skip: !process.env.SCORECARD_LOCAL_CORPUS },
  () => {
    const card = runScorecard()
    assert.equal(card.forecastReady, false)
    assert.equal(card.byPeriod.development.quote[24].modelMae, null)
    assert.equal(card.byPeriod.development.levelQuote[24].issued, 1)
    assert.equal(card.byPeriod.development.levelQuote[168].issued, 1)
    assert.equal(card.byPeriod.development.levelQuote[24].pendingAllIssued, 1)
    assert.equal(card.byPeriod.development.levelQuote[168].pendingAllIssued, 1)
    assert.equal(card.byPeriod.development.levelQuote[24].overlapExcluded, 0)
    assert.equal(card.byPeriod.development.levelQuote[168].overlapExcluded, 0)
    assert.equal(card.byPeriod.development.levelQuote[24].pending, 1)
    assert.equal(card.byPeriod.development.levelQuote[168].pending, 1)
    assert.equal(card.byPeriod.development.levelQuote[24].pairedScored, 0)
    assert.equal(card.byPeriod.development.duration[24].modelBrier, null)
  },
)
