import test from 'node:test'
import assert from 'node:assert/strict'
import {
  debtRise6h,
  evaluateWarning,
  screen,
  Q,
  DEBT_RISE_USD,
} from './usde-debt-acceleration-proxy-screen.mjs'
import { crossingEpisodes, HOUR, DAY, splitIndex } from './aave-cash-leading-logic.mjs'

function grid(count = 40, step = 3 * HOUR) {
  return Array.from({ length: count }, (_, i) => ({
    block: 1_000 + i * 900,
    at: 1_700_000_000 + i * step,
    cash: 200_000_000,
    debt: 500_000_000 + i * 15_000_000,
    liquidityRatePct: 4,
    borrowRatePct: 7,
    active: true,
    paused: false,
    frozen: false,
  }))
}

test('six-hour debt rise is in USD, nearest prior at/before, never raw token units', () => {
  const rows = grid()
  const rise = debtRise6h(rows, 2)
  assert.equal(rise.riseUsd, 30_000_000)
  assert.equal(rise.lagSeconds, 6 * HOUR)
  assert.ok(rise.riseUsd >= DEBT_RISE_USD)
  assert.equal(debtRise6h(rows, 1), null)
})

test('missing prior history or a gap over four hours fails closed', () => {
  const rows = grid(5)
  rows[2].at += 2 * HOUR
  rows[3].at += 2 * HOUR
  rows[4].at += 2 * HOUR
  assert.equal(debtRise6h(rows, 2), null)
  assert.equal(debtRise6h(rows, 3), null)
})

test('only last healthy pre-onset sample at least six hours after warning counts', () => {
  const rows = grid(25)
  rows[12].cash = Q - 1
  const episodes = crossingEpisodes(rows, Q)
  assert.equal(episodes.length, 1)
  assert.equal(evaluateWarning(rows, 8, episodes).status, 'hit')
  assert.equal(evaluateWarning(rows, 10, episodes).status, 'late')
  assert.equal(evaluateWarning(rows, 2, episodes).status, 'quiet')
  assert.equal(evaluateWarning(rows, 15, episodes).status, 'quiet')
})

test('unlabelled low is not quiet, and missing future coverage is excluded', () => {
  const rows = grid(20)
  rows[10].cash = Q - 1
  assert.equal(evaluateWarning(rows, 8, []).status, 'unlabelledLow')
  rows[9].at += 2 * HOUR
  assert.equal(evaluateWarning(rows, 8, []).status, 'missingHorizon')
})

test('every eligible quiet anchor counts; warnings use 24h cooldown and no-event warnings are nonhits', () => {
  const rows = grid(60)
  const result = screen(rows)
  assert.equal(result.episodes, 0)
  assert.ok(result.segments.train.quietAnchors > 0)
  assert.ok(result.segments.train.candidateWarnings > result.segments.train.emittedWarnings)
  assert.ok(result.segments.train.nonhits > 0)
  assert.equal(result.segments.train.hits, 0)
  const warningTimes = result.segments.train.warnings.map((warning) => warning.at)
  assert.ok(warningTimes.slice(1).every((at, i) => at - warningTimes[i] >= DAY))
})

test('chronological 70/30 split purges 24h each side; comparator threshold freezes from train', () => {
  const rows = grid(80)
  const result = screen(rows)
  const split = splitIndex(rows)
  assert.deepEqual(result.split, split)
  assert.ok(rows[split.trainEnd - 1].at <= split.boundaryAt - DAY)
  assert.ok(rows[split.holdoutStart].at >= split.boundaryAt + DAY)
  assert.equal(
    result.segments.train.comparators.headroom.threshold,
    result.segments.holdout.comparators.headroom.threshold,
  )
  assert.equal(
    result.segments.train.comparators.cashMomentum6h.threshold,
    result.segments.holdout.comparators.cashMomentum6h.threshold,
  )
  assert.ok(
    result.segments.holdout.warnings.every((warning) => warning.at >= rows[split.holdoutStart].at),
  )
})

test('holdout feature changes cannot refit either training comparator threshold', () => {
  const rows = grid(80)
  const baseline = screen(rows)
  const changed = rows.map((row) => ({ ...row }))
  for (let i = baseline.split.holdoutStart; i < changed.length; i++) {
    changed[i].cash = 110_000_000
    changed[i].debt += 500_000_000
  }
  const perturbed = screen(changed)
  for (const key of ['headroom', 'cashMomentum6h']) {
    assert.equal(
      perturbed.segments.train.comparators[key].threshold,
      baseline.segments.train.comparators[key].threshold,
    )
  }
})
