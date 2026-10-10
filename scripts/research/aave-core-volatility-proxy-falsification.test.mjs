import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VOL_THRESHOLD_PCT,
  evaluateProxy,
  incidents,
  loadInputs,
  pastVolAt,
} from './aave-core-volatility-proxy-falsification.mjs'

test('oracle volatility is strictly as-of and ignores a future price shock', () => {
  const prices = Array.from({ length: 10 }, (_, i) => ({
    at: i * 3 * 3600,
    oracleUpdatedAt: i * 3 * 3600,
    price: i === 9 ? 200 : 100 + i,
    roundId: String(i + 1),
    answeredInRound: String(i + 1),
  }))
  const at = 8 * 3 * 3600
  const before = pastVolAt(prices, at)
  const withoutFuture = pastVolAt(prices.slice(0, 9), at)
  assert.equal(before.value, withoutFuture.value)
  assert.equal(before.latestOracleUpdatedAt, at)
  assert.equal(before.returns, 8)
  assert.equal(pastVolAt(prices, 9 * 3 * 3600 + 5 * 3600).reason, 'stale-or-invalid-asof-price')
})

test('alert cooldown is per market and never borrows another market’s alert', () => {
  const rows = [
    { market: 'aave-usdc', at: 100000, volPct: 8 },
    { market: 'USDT', at: 100100, volPct: 8 },
    { market: 'aave-usdc', at: 101000, volPct: 8 },
    { market: 'aave-usdc', at: 190000, volPct: 8 },
  ]
  assert.deepEqual(
    incidents(rows, (row) => row.volPct >= VOL_THRESHOLD_PCT).map((row) => [row.market, row.at]),
    [
      ['aave-usdc', 100000],
      ['USDT', 100100],
      ['aave-usdc', 190000],
    ],
  )
})

test('pinned Aave Core screen retains every grid row and does not promote a sparse holdout', () => {
  const result = evaluateProxy(loadInputs())
  assert.equal(result.denominator.gridRows, 3138)
  assert.equal(result.denominator.cashOnsets, 3)
  assert.equal(result.denominator.holdoutEvents, 1)
  assert.equal(result.denominator.holdoutEventGroups, 1)
  assert.equal(result.holdoutVol.alerts, 12)
  assert.equal(result.holdoutVol.hits, 0)
  assert.equal(result.gate, 'broad-eth-volatility-not-retained')
  assert.equal(result.feasibility, 'underpowered-one-holdout-proxy-episode')
  assert.equal(result.ledger.length, result.denominator.gridRows)
  assert.equal(result.caveat.includes('not holder-executable'), true)
})
