import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyTargetWindows,
  earliestActiveDeadline,
  preflight,
  shouldRetryScore,
  shouldScoreDuringTick,
  targetActionPlan,
} from './scrvusd-target-window-tick.mjs'

const issue = (target, name = 'issue.json') => ({
  name,
  issue: {
    targetUtc: new Date(target).toISOString(),
    outcomeProtocol: {
      checkpointSelection: { captureDeadlineUtc: new Date(target + 90 * 60_000).toISOString() },
    },
  },
})

test('preflight only opens the fixed observation window and then marks an unscored issue due', () => {
  const target = Date.parse('2026-10-05T07:48:12.705Z')
  const row = issue(target)
  assert.deepEqual(classifyTargetWindows([row], [], target - 30 * 60_000 - 1), {
    active: 0,
    due: 0,
  })
  assert.deepEqual(classifyTargetWindows([row], [], target + 20 * 60_000), {
    active: 1,
    due: 0,
  })
  assert.deepEqual(classifyTargetWindows([row], [], target + 90 * 60_000 + 1), {
    active: 0,
    due: 1,
  })
  assert.deepEqual(classifyTargetWindows([row], ['issue.json'], target + 90 * 60_000 + 1), {
    active: 0,
    due: 0,
  })
  assert.equal(earliestActiveDeadline([row], target - 30 * 60_000 - 1), null)
  assert.equal(earliestActiveDeadline([row], target), target + 90 * 60_000)
  assert.equal(earliestActiveDeadline([row], target + 90 * 60_000 + 1), null)
})

test('real sealed pending roster has a quiet preflight before its next fixed target', async () => {
  const result = await preflight(Date.parse('2026-10-03T08:55:31.000Z'))
  assert.ok(result.pending > 0)
  assert.equal(result.active, 0)
  assert.equal(result.due, 0)
  assert.equal(result.earliestActiveDeadlineMs, null)
})

test('failed scoring backs off until new due evidence or six hours pass', () => {
  const now = Date.parse('2026-10-05T10:00:00Z')
  const failure = { atMs: now, dueCount: 2 }
  assert.equal(shouldRetryScore(failure, 2, now + 15 * 60_000), false)
  assert.equal(shouldRetryScore(failure, 3, now + 15 * 60_000), true)
  assert.equal(shouldRetryScore(failure, 2, now + 6 * 60 * 60_000), true)
})

test('old scores remain serviceable during capture unless a live Morpho target needs the tick', () => {
  assert.equal(shouldScoreDuringTick({ active: 1, due: 2 }, false), true)
  assert.equal(shouldScoreDuringTick({ active: 1, due: 2 }, true), false)
  assert.equal(shouldScoreDuringTick({ active: 0, due: 2 }, true), true)
})

test('campaign mode performs capture or score, never both in one target action', () => {
  assert.deepEqual(targetActionPlan({ active: 1, scoreAllowed: true, singleAction: true }), {
    capture: true,
    score: false,
  })
  assert.deepEqual(targetActionPlan({ active: 0, scoreAllowed: true, singleAction: true }), {
    capture: false,
    score: true,
  })
  assert.deepEqual(targetActionPlan({ active: 1, scoreAllowed: true, singleAction: false }), {
    capture: true,
    score: true,
  })
})
