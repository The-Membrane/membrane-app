import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  FIXED_RULE,
  splitAndScore,
  validateGrid,
  verifyBytes,
} from './aave-cash-full-grid-eval.mjs'
import { DAY, HOUR } from './aave-cash-event-ablation.mjs'

const base = 1_700_000_000
const rows = Array.from({ length: 100 }, (_, i) => ({
  block: 1000 + i * 900,
  at: base + i * 3 * HOUR,
  cash: 200_000_000,
  debt: 50_000_000,
  liquidityRatePct: 1,
  borrowRatePct: 2,
  active: true,
  frozen: false,
  paused: false,
}))

test('fixed rule retains the unretrained threshold and promotion gate', () => {
  assert.equal(FIXED_RULE.qUsd, 100_000_000)
  assert.equal(FIXED_RULE.baseline, 'strictly prior 14d empirical p95 of covered 6h cash drops')
  assert.equal(FIXED_RULE.eventLookbackHours, 6)
  assert.deepEqual(FIXED_RULE.promotionGate, {
    minIndependentEpisodes: 20,
    minIndependentControls: 20,
    minLeadHours: 6,
    holdoutPrecision: 0.8,
    holdoutRecall: 0.5,
    eventPrecisionLift: 0.15,
    maxRecallLoss: 0.1,
  })
})

test('grid requires all expected fixed block anchors, complete coverage, and valid ordering', () => {
  const fixture = {
    status: 'complete',
    grid: { first: 1000, last: 1000 + 99 * 900, step: 900 },
    coverage: { expected: 100, present: 100, missing: 0, complete: true, maxGapSeconds: 3 * HOUR },
    failedReadCount: 0,
    rows,
  }
  assert.equal(validateGrid(fixture, fixture.grid).length, 100)
  const missing = structuredClone(fixture)
  missing.rows.splice(50, 1)
  assert.throws(() => validateGrid(missing, fixture.grid), /row count/)
  const drift = structuredClone(fixture)
  drift.rows[50].block++
  assert.throws(() => validateGrid(drift, fixture.grid), /block grid/)
  const stale = structuredClone(fixture)
  stale.coverage.complete = false
  assert.throws(() => validateGrid(stale, fixture.grid), /coverage/)
})

test('source bytes must match the precommitted SHA-256', () => {
  const bytes = Buffer.from('source fixture')
  const hash = createHash('sha256').update(bytes).digest('hex')
  assert.equal(verifyBytes(bytes, hash), hash)
  assert.throws(() => verifyBytes(Buffer.from('different'), hash), /SHA-256/)
})

test('70/30 chronological split purges 24h on both sides and scores arms independently', () => {
  const at = (index) => rows[index].at
  const episodes = [{ at: at(48) }, { at: at(84) }]
  const cashOnly = [
    { at: at(43), targetAt: at(48), leadHours: 15 },
    { at: at(60), targetAt: null, leadHours: null },
    { at: at(68), targetAt: at(72), leadHours: 12 }, // purged, even though a raw crossing was found
    { at: at(80), targetAt: at(84), leadHours: 12 },
  ]
  const gated = [
    { at: at(43), targetAt: at(48), leadHours: 15 },
    { at: at(80), targetAt: at(84), leadHours: 12 },
  ]
  const result = splitAndScore(rows, episodes, cashOnly, gated)
  assert.equal(result.split.boundaryIndex, 70)
  assert.ok(at(result.split.trainEnd) <= at(70) - DAY + 3 * HOUR)
  assert.ok(at(result.split.holdoutStart) >= at(70) + DAY)
  assert.deepEqual(
    [result.train.cashOnly.alerts, result.train.cashOnly.hits, result.train.cashOnly.falseAlerts],
    [2, 1, 1],
  )
  assert.deepEqual(
    [
      result.holdout.cashOnly.alerts,
      result.holdout.cashOnly.hits,
      result.holdout.cashOnly.falseAlerts,
    ],
    [1, 1, 0],
  )
  assert.equal(result.train.eventGated.recall, 1)
  assert.equal(result.holdout.eventGated.precision, 1)
})

test('zero-episode holdout remains unassessable, not a perfect recall', () => {
  const result = splitAndScore(rows, [{ at: rows[48].at }], [], [])
  assert.equal(result.holdout.cashOnly.recall, null)
  assert.equal(result.holdout.eventGated.recall, null)
  assert.equal(result.promotion.status, 'unassessable')
})
