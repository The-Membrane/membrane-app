import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyze,
  assertSeries,
  candidateAlerts,
  completeHorizon,
  crossingEpisodes,
  evaluateAlerts,
  features,
  HOUR,
  DAY,
} from './aave-cash-leading-logic.mjs'

function rows(cashes, start = 1_700_000_000, step = HOUR) {
  return cashes.map((cash, i) => ({
    block: i + 1,
    at: start + i * step,
    cash,
    debt: 200_000_000 + i * 1000,
    liquidityRatePct: 2,
    borrowRatePct: 4,
    active: true,
    paused: false,
    frozen: false,
  }))
}

test('a crossing requires 24h recovery and 48h separation before next episode', () => {
  const cashes = Array(160).fill(150_000_000)
  cashes[30] = 90_000_000
  cashes[31] = 150_000_000
  cashes[35] = 90_000_000
  cashes[36] = 150_000_000 // not recovered 24h
  cashes[90] = 90_000_000
  cashes[91] = 150_000_000
  assert.deepEqual(
    crossingEpisodes(rows(cashes), 100_000_000).map((e) => e.index),
    [30, 90],
  )
})

test('alert counted only with 6–24h lead, not post hoc', () => {
  const at = 1_700_000_000
  const episodes = [{ at: at + 20 * HOUR }]
  const result = evaluateAlerts([{ at }, { at: at + 16 * HOUR }, { at: at + 23 * HOUR }], episodes)
  assert.equal(result.trueAlerts, 1)
  assert.equal(result.falseAlerts, 2)
  assert.equal(result.hitEpisodes, 1)
})

test('features are past-only and missing history stays null', () => {
  const series = rows(Array(27).fill(150_000_000))
  assert.equal(features(series, 0).debtRise6h, null)
  assert.equal(features(series, 5).debtRise6h, null)
  assert.ok(features(series, 25).debtRise24h > 0)
})

test('series rejects broken chronology and missing pinned numeric fields', () => {
  const series = rows([1, 2, 3])
  series[1].at = series[0].at
  assert.throws(() => assertSeries(series))
})

test('analysis reports zero episodes honestly', () => {
  const series = rows(Array(100).fill(150_000_000), 1_700_000_000, 3 * HOUR)
  const result = analyze(series)
  assert.equal(result.results[100_000_000].episodes, 0)
  assert.ok(result.results[100_000_000].controls.train > 0)
  assert.ok(result.split.boundaryAt > series[0].at + DAY)
})

test('alerts require cash still available, active unpaused reserve, and full follow-up', () => {
  const series = rows(Array(30).fill(150_000_000), 1_700_000_000, 3 * HOUR)
  series[2].cash = 5_000_000
  series[3].paused = true
  series[4].active = false
  const alerts = candidateAlerts(series, 10_000_000, 'utilization', 0, 0, series.length)
  assert.ok(alerts.length > 0)
  assert.ok(
    alerts.every(
      (a) =>
        series[a.index].cash >= 10_000_000 && series[a.index].active && !series[a.index].paused,
    ),
  )
  assert.ok(alerts.every((a) => completeHorizon(series, a.index)))
})

test('wide sample gap cannot manufacture a crossing episode or complete follow-up', () => {
  const series = rows(Array(30).fill(150_000_000), 1_700_000_000, 3 * HOUR)
  series[10].at += 6 * HOUR
  for (let i = 11; i < series.length; i++) series[i].at += 6 * HOUR
  series[10].cash = 1_000_000
  assert.equal(crossingEpisodes(series, 10_000_000).length, 0)
  assert.equal(completeHorizon(series, 8), false)
  assert.equal(features(series, 11).debtRise6h, null)
})
