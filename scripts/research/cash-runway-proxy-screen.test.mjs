import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  INPUTS,
  DEFAULT_OUT,
  calendarGroups,
  checkpoint,
  deriveCohort,
  evaluate,
  features,
  pairWin,
  pairWinSummary,
  readSources,
  replayCheckpoint,
  verifyCheckpoint,
} from './cash-runway-proxy-screen.mjs'

const Q = 1_000_000
const row = (block, at, cash, extra = {}) => ({
  block,
  at,
  market: 'fixture',
  kind: 'observed',
  active: true,
  withdrawPaused: false,
  supplyUsdAssumingPeg: 2 * Q,
  cashUsdAssumingPeg: cash,
  ...extra,
})

test('feature reads stop at t+one timestamp, and future cash cannot alter rank', () => {
  const t = 100_000
  const rows = new Map([
    [t - 7200, row(t - 7200, 1000, 2_000_000)],
    [t, row(t, 1000 + 24 * 3600, 1_500_000)],
    [t + 1800, row(t + 1800, 1000 + 30 * 3600, 900_000)],
  ])
  const reads = []
  const source = {
    get(block) {
      reads.push(block)
      return rows.get(block)
    },
  }
  const first = features(source, t)
  assert.deepEqual(reads, [t, t - 7200, t + 1800])
  rows.get(t + 1800).cashUsdAssumingPeg = 100_000_000
  rows.get(t + 1800).active = false
  assert.deepEqual(features(source, t), first)
  assert.equal(first.leadSeconds, 6 * 3600)
  assert.equal(first.outflow24, 500_000 / 24)
})

test('fixed missing control is an exclusion, not a replacement', () => {
  const rows = new Map([[10_000, row(10_000, 90_000, 1_400_000)]])
  assert.equal(features(rows, 10_000 - 50_400, 'control').reason, 'control-missing-row')
  rows.set(10_000 - 50_400, row(10_000 - 50_400, 1000, 900_000))
  assert.equal(features(rows, 10_000 - 50_400, 'control').reason, 'control-insufficient-cash')
})

test('ties count half for each frozen rank direction', () => {
  const same = { runwayHours: 'Infinity', cashHeadroom: 1.5, cashDrop24: 0 }
  for (const key of ['runwayHours', 'cashHeadroom', 'cashDrop24'])
    assert.equal(pairWin(same, same, key), 0.5)
  assert.equal(pairWin({ runwayHours: 2 }, { runwayHours: 3 }, 'runwayHours'), 1)
  assert.equal(pairWin({ cashDrop24: 0.2 }, { cashDrop24: 0.1 }, 'cashDrop24'), 1)
})

test('cluster totals retain pair counts while equal group weighting is separate', () => {
  const fixtures = [
    { eligible: true, wins: { runway: 1, headroom: 0, cashDrop: 0.5 } },
    { eligible: true, wins: { runway: 0, headroom: 1, cashDrop: 0.5 } },
    { eligible: false, wins: null },
  ]
  assert.deepEqual(pairWinSummary(fixtures), {
    eligiblePairs: 2,
    totals: { runway: 1, headroom: 1, cashDrop: 1 },
    rates: { runway: 0.5, headroom: 0.5, cashDrop: 0.5 },
  })
})

test('rolling 48-hour calendar grouping links adjacent markets and pauses', () => {
  const events = [
    { market: 'A', block: 1, at: 0, cause: 'cash' },
    { market: 'B', block: 2, at: 47 * 3600, cause: 'pause' },
    { market: 'A', block: 3, at: 94 * 3600, cause: 'cash' },
    { market: 'C', block: 4, at: 143 * 3600, cause: 'cash' },
  ]
  const groups = calendarGroups(events)
  assert.deepEqual([...groups.values()], [0, 0, 0, 1])
})

test('frozen byte hashes, scorer cohort, pause separation, and checkpoint replay', () => {
  const { five, expansion } = readSources()
  assert.equal(five.status, 'complete')
  assert.equal(expansion.status, 'complete')
  const cohort = deriveCohort(five, expansion)
  assert.equal(cohort.cash.length, 31)
  assert.equal(cohort.pause.length, 4)
  const score = evaluate(five, expansion)
  assert.equal(score.records.length, 31)
  assert.equal(score.denominator.cashOnsets, 31)
  assert.equal(score.denominator.pauseExcluded, 4)
  assert.equal(score.denominator.eligibleHoldoutCalendarGroups, 7)
  assert.equal(score.gate, 'formula-retired')
  assert.equal(
    score.records.every((r) => !('controlCrossover' in r)),
    true,
  )
  assert.equal(
    score.records.every((r) => 'controlFutureGridRowAdverseState' in r),
    true,
  )
  assert.equal(score.groupSummaries.length, 26)
  assert.equal(
    score.groupSummaries.reduce((sum, g) => sum + g.pairWins.all.eligiblePairs, 0),
    score.denominator.eligiblePairs,
  )
  assert.equal(
    Object.values(score.marketSummaries).reduce(
      (sum, m) => sum + m.pairWins.holdout.eligiblePairs,
      0,
    ),
    score.denominator.eligibleHoldoutPairs,
  )
  const eligibleGroups = score.groupSummaries.filter((g) => g.pairWins.holdout.eligiblePairs)
  for (const key of ['runway', 'headroom', 'cashDrop'])
    assert.equal(
      score.holdoutEqualWeightGroupWinRates[key],
      eligibleGroups.reduce((sum, g) => sum + g.pairWins.holdout.rates[key], 0) /
        eligibleGroups.length,
    )
  assert.equal(new Set([...calendarGroups(cohort.all).values()]).size, 26)
  const saved = JSON.parse(readFileSync(DEFAULT_OUT, 'utf8'))
  assert.deepEqual(saved, checkpoint(score))
  assert.deepEqual(replayCheckpoint(saved), saved)
  assert.equal(saved.sourceByteSha256.five, INPUTS.five.sha256)
})

test('tampering with output or source digest is rejected', () => {
  const saved = JSON.parse(readFileSync(DEFAULT_OUT, 'utf8'))
  const changed = structuredClone(saved)
  changed.records[0].wins = { runway: 1, headroom: 1, cashDrop: 1 }
  assert.throws(() => verifyCheckpoint(changed), /corruption/)
  const sourceChanged = checkpoint(
    { ...saved, sourceByteSha256: undefined },
    { five: '0'.repeat(64), expansion: INPUTS.expansion.sha256 },
  )
  assert.throws(() => verifyCheckpoint(sourceChanged), /frozen identity/)
})
