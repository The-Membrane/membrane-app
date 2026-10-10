import assert from 'node:assert/strict'
import test from 'node:test'

import {
  firstLane,
  morphoEarliestLiveDeadline,
  morphoHasWork,
  runFirstHandledInDeadlineOrder,
  runInDeadlineOrder,
} from './holder-exit-targets-tick.mjs'

const request = {
  routeKey: 'sample',
  destinationAddress: '0x1111111111111111111111111111111111111111',
  owner: '0x2222222222222222222222222222222222222222',
  assetsRaw: '100',
}
const targetAtUtc = '2026-10-03T08:00:00.000Z'
const deadlineUtc = '2026-10-03T10:00:00.000Z'
const issue = {
  issueId: 'issue1',
  request,
  targets: [{ horizonHours: 1, targetAtUtc, deadlineUtc }],
}
const queued = [{ id: 'queue1', request }]
const at = Date.parse(targetAtUtc)

test('Morpho requested watch wakes for queued intake and due targets only', () => {
  assert.equal(morphoHasWork(queued, { issues: [], scores: [], attempts: [] }, at - 1), true)
  assert.equal(
    morphoHasWork(
      queued,
      { issues: [], scores: [], attempts: [] },
      at,
      new Map([['queue1', [{ nextAttemptAtMs: at + 1 }]]]),
    ),
    false,
  )
  assert.equal(
    morphoHasWork(
      queued,
      { issues: [], scores: [], attempts: [] },
      at,
      new Map([['queue1', [{ nextAttemptAtMs: null }]]]),
    ),
    false,
  )
  assert.equal(morphoHasWork(queued, { issues: [issue], scores: [], attempts: [] }, at - 1), false)
  assert.equal(morphoHasWork(queued, { issues: [issue], scores: [], attempts: [] }, at), true)
  assert.equal(
    morphoHasWork(
      queued,
      {
        issues: [issue],
        scores: [{ issueId: issue.issueId, horizonHours: 1 }],
        attempts: [],
      },
      at,
    ),
    false,
  )
  const once = {
    issues: [issue],
    scores: [],
    attempts: [{ issueId: 'issue1', horizonHours: 1, attemptedAtUtc: targetAtUtc }],
  }
  assert.equal(morphoHasWork(queued, once, at + 15 * 60_000), false)
  assert.equal(morphoHasWork(queued, once, at + 30 * 60_000), true)
  const twice = {
    ...once,
    attempts: [
      ...once.attempts,
      { ...once.attempts[0], attemptedAtUtc: '2026-10-03T08:30:00.000Z' },
    ],
  }
  assert.equal(morphoHasWork(queued, twice, at + 60 * 60_000), false)
  assert.equal(morphoHasWork(queued, twice, Date.parse(deadlineUtc) + 1), true)
  assert.equal(morphoHasWork([], { issues: [], scores: [], attempts: [] }, at), false)
  assert.throws(() => morphoHasWork([], { issues: [], scores: [], attempts: [] }, -1))
})

test('nearer live Morpho deadline runs before a long scrvUSD capture', () => {
  const now = Date.parse(deadlineUtc) - 10 * 60_000
  assert.equal(
    morphoEarliestLiveDeadline({ issues: [issue], scores: [], attempts: [] }, now),
    Date.parse(deadlineUtc),
  )
  assert.equal(firstLane(now + 40 * 60_000, Date.parse(deadlineUtc)), 'morpho')
  assert.equal(firstLane(now + 5 * 60_000, Date.parse(deadlineUtc)), 'scrvusd')
  assert.equal(firstLane(null, Date.parse(deadlineUtc)), 'morpho')
  assert.equal(firstLane(null, null), 'scrvusd')
  assert.equal(
    morphoEarliestLiveDeadline(
      { issues: [issue], scores: [{ issueId: 'issue1', horizonHours: 1 }], attempts: [] },
      now,
    ),
    null,
  )
})

test('dispatcher invokes the earlier-deadline lane first', async () => {
  const calls = []
  const scrvusd = async () => calls.push('scrvusd')
  const morpho = async () => calls.push('morpho')
  const now = Date.parse(deadlineUtc) - 10 * 60_000
  await runInDeadlineOrder(now + 40 * 60_000, Date.parse(deadlineUtc), scrvusd, morpho)
  assert.deepEqual(calls, ['morpho', 'scrvusd'])
  calls.length = 0
  await runInDeadlineOrder(now + 5 * 60_000, Date.parse(deadlineUtc), scrvusd, morpho)
  assert.deepEqual(calls, ['scrvusd', 'morpho'])
})

test('single-lane dispatcher stops after the first lane that performs work', async () => {
  const calls = []
  const scrvusd = async () => {
    calls.push('scrvusd')
    return { status: 'ran' }
  }
  const morpho = async () => {
    calls.push('morpho')
    return { status: 'ran' }
  }
  const now = Date.parse(deadlineUtc) - 10 * 60_000
  assert.deepEqual(
    await runFirstHandledInDeadlineOrder(
      now + 40 * 60_000,
      Date.parse(deadlineUtc),
      scrvusd,
      morpho,
    ),
    { status: 'ran' },
  )
  assert.deepEqual(calls, ['morpho'])
})

test('single-lane dispatcher falls through a quiet earlier lane', async () => {
  const calls = []
  const scrvusd = async () => {
    calls.push('scrvusd')
    return null
  }
  const morpho = async () => {
    calls.push('morpho')
    return { status: 'ran' }
  }
  assert.deepEqual(await runFirstHandledInDeadlineOrder(null, null, scrvusd, morpho), {
    status: 'ran',
  })
  assert.deepEqual(calls, ['scrvusd', 'morpho'])
})

test('an attempt-exhausted Morpho target cannot outrank a live scrvUSD window', () => {
  const now = Date.parse('2026-10-03T09:00:00.000Z')
  const blocked = {
    issueId: 'blocked',
    targets: [
      { horizonHours: 1, targetAtUtc: targetAtUtc, deadlineUtc: '2026-10-03T09:01:00.000Z' },
    ],
  }
  const eligible = {
    issueId: 'eligible',
    targets: [
      { horizonHours: 24, targetAtUtc: targetAtUtc, deadlineUtc: '2026-10-03T09:30:00.000Z' },
    ],
  }
  const study = {
    issues: [blocked, eligible],
    scores: [],
    attempts: [
      { issueId: 'blocked', horizonHours: 1, attemptedAtUtc: targetAtUtc },
      { issueId: 'blocked', horizonHours: 1, attemptedAtUtc: '2026-10-03T08:30:00.000Z' },
    ],
  }
  assert.equal(morphoHasWork([], study, now), true)
  assert.equal(morphoEarliestLiveDeadline(study, now), Date.parse('2026-10-03T09:30:00.000Z'))
  assert.equal(firstLane(now + 5 * 60_000, morphoEarliestLiveDeadline(study, now)), 'scrvusd')
})
