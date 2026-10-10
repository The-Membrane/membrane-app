import assert from 'node:assert/strict'
import test from 'node:test'
import { episodeSummary, stressEpisodes } from './curve-size-aware-logic.mjs'

const H = 3600
function series(quotes, start = 1_700_000_000) {
  return quotes.map((quote, i) => ({ at: start + i * 3 * H, block: i + 1, quote }))
}

test('stress requires a measured 0.25pp fall from prior 24h near-par peak', () => {
  assert.equal(stressEpisodes(series([0.999, 0.998, 0.997, 0.9966]), 'quote').length, 0)
  const found = stressEpisodes(series([0.999, 0.998, 0.9964]), 'quote')
  assert.equal(found.length, 1)
  assert.equal(found[0].opportunityCount, 1)
  assert.equal(found[0].latestOpportunityQuote, 0.999)
})

test('below-par baseline does not create an actionable near-par alert', () => {
  assert.equal(stressEpisodes(series([0.994, 0.991]), 'quote').length, 0)
})

test('long drawdown is one episode until sustained recovery, not repeated 48h crossings', () => {
  const rows = series([
    0.999, 0.999, 0.995, 0.994, 0.993, 0.992, 0.991, 0.99, 0.989, 0.988, 0.987, 0.986, 0.985, 0.984,
    0.983, 0.982, 0.981,
  ])
  const found = stressEpisodes(rows, 'quote')
  assert.equal(found.length, 1)
  assert.equal(found[0].minQuote, 0.981)
  assert.equal(found[0].recoveredAt, null)
})

test('a second episode needs 24h continuously within 0.10pp of pre-stress peak', () => {
  const rows = series([
    0.999, 0.999, 0.996, 0.994, 0.9982, 0.9982, 0.9982, 0.9982, 0.9982, 0.9982, 0.9982, 0.9982,
    0.9982, 0.9982, 0.9982, 0.999, 0.996, 0.994,
  ])
  assert.equal(stressEpisodes(rows, 'quote').length, 2)
})

test('recovery cannot bridge a missing observation gap', () => {
  const rows = series([0.999, 0.999, 0.996, 0.994, 0.9982, 0.9982])
  rows.push({ at: rows.at(-1).at + 30 * H, block: 100, quote: 0.9982 })
  rows.push({ at: rows.at(-1).at + 3 * H, block: 101, quote: 0.994 })
  assert.equal(stressEpisodes(rows, 'quote').length, 1)
})

test('summary reports independent day controls and recovery sensitivity', () => {
  const rows = series(Array(30).fill(0.999))
  const result = episodeSummary(rows, 'quote')
  assert.equal(result.episodes, 0)
  assert.ok(result.independentControls >= 3)
  assert.deepEqual(result.recoverySensitivity, { 12: 0, 24: 0, 48: 0 })
})
