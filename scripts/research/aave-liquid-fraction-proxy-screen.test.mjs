import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkpoint,
  evaluate,
  fractionAt,
  lowerFractionWin,
  matchedSummary,
  verifyCheckpoint,
} from './aave-liquid-fraction-proxy-screen.mjs'

const Q = 1_000_000

function fixture(count, options = {}) {
  const rows = []
  const records = []
  for (let i = 0; i < count; i++) {
    const market = `reserve-${i}`
    const anchorBlock = 200_000 + i * 100_000
    const controlBlock = anchorBlock - 50_400
    const eventWins = options.eventWins?.[i] ?? true
    rows.push({
      market,
      block: anchorBlock,
      kind: 'observed',
      cashUsdAssumingPeg: 2 * Q,
      supplyUsdAssumingPeg: eventWins ? 4 * Q : 2 * Q,
    })
    rows.push({
      market,
      block: controlBlock,
      kind: 'observed',
      cashUsdAssumingPeg: 2 * Q,
      supplyUsdAssumingPeg: eventWins ? 2 * Q : 4 * Q,
    })
    records.push({
      market,
      block: anchorBlock + 3600,
      cause: 'cash',
      split: 'holdout',
      calendarGroup: i % 5,
      anchorBlock,
      controlBlock,
      eligible: true,
      reason: null,
      wins: {
        runway: 0,
        headroom: options.headroomWins?.[i] ?? 0,
        cashDrop: options.cashDropWins?.[i] ?? 0,
      },
    })
  }
  const base = {
    frozen: { q: Q, eventLagBlocks: 3600, controlLagBlocks: 50_400 },
    denominator: { cashOnsets: count, pauseExcluded: 4, eligiblePairs: count },
    pauseExcluded: [],
    records,
    groupSummaries: Array.from({ length: 5 }, (_, group) => ({ group })),
    marketSummaries: Object.fromEntries(records.map((row) => [row.market, {}])),
    holdoutPairWinRates: { headroom: 0, cashDrop: 0 },
  }
  return { base, sources: { five: { rows }, expansion: { entries: [] } }, rows }
}

test('same-market same-block join computes cash/supply; lower event fraction wins', () => {
  const { base, sources } = fixture(1)
  const result = evaluate(base, sources)
  assert.equal(result.records[0].liquidFraction.event.value, 0.5)
  assert.equal(result.records[0].liquidFraction.control.value, 1)
  assert.equal(result.records[0].wins.liquidFraction, 1)
  assert.equal(result.records[0].wins.headroom, 0)
  assert.equal(result.records[0].controlBlock, base.records[0].controlBlock)
  assert.equal(result.records[0].calendarGroup, base.records[0].calendarGroup)
  const index = new Map([['other:123', { market: 'reserve', block: 123 }]])
  assert.equal(fractionAt(index, 'reserve', 123, 'event').reason, 'event-missing-row')
  assert.equal(lowerFractionWin(0.75, 0.75), 0.5)
  assert.equal(lowerFractionWin(0.9, 0.8), 0)
})

test('invalid denominator keeps onset and original baseline wins but excludes pair', () => {
  const { base, sources, rows } = fixture(2)
  const second = base.records[1]
  rows.find(
    (row) => row.market === second.market && row.block === second.controlBlock,
  ).supplyUsdAssumingPeg = 0
  const result = evaluate(base, sources)
  assert.equal(result.records.length, 2)
  assert.equal(result.denominator.cashOnsets, 2)
  assert.equal(result.denominator.pauseExcluded, 4)
  assert.equal(result.denominator.baseEligiblePairs, 2)
  assert.equal(result.denominator.eligiblePairs, 1)
  assert.equal(result.denominator.ineligiblePairs, 1)
  assert.equal(result.records[1].reason, 'control-invalid-supply')
  assert.equal(result.records[1].wins.headroom, 0)
  assert.equal(result.records[1].wins.liquidFraction, null)
  assert.equal(result.holdoutMatchedPairWinRates.liquidFraction, 1)
  assert.equal(result.matchedMarketSummaries[second.market].all.eligiblePairs, 0)
  assert.deepEqual(result.originalBaselineMarketSummaries[second.market], {})
  assert.equal(result.gate, 'inconclusive-too-few-eligible-holdout-groups')
})

test('nonfinite or nonpositive cash and supply cannot enter a pair', () => {
  const { base, sources, rows } = fixture(1)
  const event = rows.find((row) => row.block === base.records[0].anchorBlock)
  for (const [field, value, reason] of [
    ['cashUsdAssumingPeg', 0, 'event-invalid-cash'],
    ['cashUsdAssumingPeg', Infinity, 'event-invalid-cash'],
    ['supplyUsdAssumingPeg', -1, 'event-invalid-supply'],
    ['supplyUsdAssumingPeg', NaN, 'event-invalid-supply'],
  ]) {
    const original = event[field]
    event[field] = value
    assert.equal(evaluate(base, sources).records[0].reason, reason)
    event[field] = original
  }
})

test('base-ineligible pair is not rescued by a priceable ratio or replacement control', () => {
  const { base, sources } = fixture(1)
  base.records[0].eligible = false
  base.records[0].reason = 'control-insufficient-cash'
  base.records[0].wins = null
  base.denominator.eligiblePairs = 0
  const result = evaluate(base, sources)
  assert.equal(result.records[0].eligible, false)
  assert.equal(result.records[0].reason, 'control-insufficient-cash')
  assert.equal(result.records[0].liquidFraction, null)
  assert.equal(result.denominator.cashOnsets, 1)
  assert.equal(result.denominator.eligiblePairs, 0)
})

test('five-group 60% and 10-point baseline gate is exact and untuned', () => {
  const { base, sources } = fixture(10, {
    eventWins: [true, true, true, true, true, true, false, false, false, false],
    headroomWins: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    cashDropWins: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  })
  let result = evaluate(base, sources)
  assert.equal(result.denominator.eligibleHoldoutCalendarGroups, 5)
  assert.equal(result.holdoutMatchedPairWinRates.liquidFraction, 0.6)
  assert.equal(result.holdoutMatchedPairWinRates.headroom, 0.5)
  assert.equal(result.gate, 'proxy-triage-pass-only')
  base.records[5].wins.headroom = 1
  result = evaluate(base, sources)
  assert.equal(result.gate, 'liquid-fraction-retired')
  base.records[5].wins.headroom = 0
  base.records[5].calendarGroup = 0
  base.records[6].calendarGroup = 0
  base.records[7].calendarGroup = 0
  base.records[8].calendarGroup = 0
  base.records[9].calendarGroup = 0
  result = evaluate(base, sources)
  assert.equal(result.denominator.eligibleHoldoutCalendarGroups, 5)
  assert.equal(result.holdoutEqualWeightGroupSensitivityOnly, true)
  assert.ok(Math.abs(result.holdoutEqualWeightGroupWinRates.liquidFraction - 13 / 15) < 1e-12)
  assert.equal(result.holdoutMatchedPairWinRates.liquidFraction, 0.6)
})

test('matched pair summary uses only eligible records and counts ties as half', () => {
  assert.deepEqual(
    matchedSummary([
      { eligible: true, wins: { liquidFraction: 0.5, headroom: 1, cashDrop: 0 } },
      { eligible: true, wins: { liquidFraction: 1, headroom: 0, cashDrop: 0.5 } },
      { eligible: false, wins: { liquidFraction: null, headroom: 1, cashDrop: 1 } },
    ]),
    {
      eligiblePairs: 2,
      totals: { liquidFraction: 1.5, headroom: 1, cashDrop: 0.5 },
      rates: { liquidFraction: 0.75, headroom: 0.5, cashDrop: 0.25 },
    },
  )
})

test('checkpoint rejects a synthetic resealed-looking identity or altered payload', () => {
  const { base, sources } = fixture(31)
  const result = evaluate(base, sources)
  result.pauseExcluded = Array.from({ length: 4 }, (_, i) => ({ block: i, cause: 'pause' }))
  const saved = checkpoint(result)
  assert.deepEqual(verifyCheckpoint(saved), saved)
  const altered = structuredClone(saved)
  altered.records[0].wins.liquidFraction = 0
  assert.throws(() => verifyCheckpoint(altered), /corruption/)
  const wrongSource = structuredClone(saved)
  wrongSource.sourceByteSha256.five = '0'.repeat(64)
  assert.throws(() => verifyCheckpoint(wrongSource), /corruption/)
})
