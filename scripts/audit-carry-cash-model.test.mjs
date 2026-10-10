import test from 'node:test'
import assert from 'node:assert/strict'

import { replayLegacyV3 } from './audit-carry-cash-model.mjs'

function pairs(delta = () => 10n) {
  return Array.from({ length: 60 }, (_, index) => ({
    sourceCashRaw: '1000',
    targetCashRaw: (1000n + delta(index)).toString(),
  }))
}

test('replays immutable v3 artifacts with their original 20/20/20 split', () => {
  const replay = replayLegacyV3(pairs())
  assert.equal(replay.status, 'historical_projection')
  assert.deepEqual(replay.counts, {
    total: 60,
    fit: 20,
    calibration: 20,
    holdout: 20,
  })
  assert.equal(replay.holdout.covered, 20)
  assert.equal(replay.holdout.pointBeatsPersistence, true)
  assert.equal(replay.projection.fitMedianDeltaRaw, '10')
})

test('keeps the v3 persistence decision tied to its historical holdout', () => {
  const replay = replayLegacyV3(pairs(() => 0n))
  assert.equal(replay.status, 'unavailable')
  assert.equal(replay.reason, 'no_skill_over_persistence')
  assert.equal(replay.holdout.pointBeatsPersistence, false)
  assert.equal(replay.baselineBand.coveragePassed, true)
  assert.throws(
    () => replayLegacyV3([{ sourceCashRaw: '1e3', targetCashRaw: '1000' }]),
    /model_legacy_pairs_invalid/,
  )
})
