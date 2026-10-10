import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_PAIR_ATTEMPTS,
  fairPublicDirectScorePlans,
  pendingPublicDirectScorePlans,
  rankedPublicOriginPairs,
  runPublicDirectScoreSweep,
} from './record-carry-public-direct-exit-scores.mjs'

const urls = [
  'https://first.example/secret',
  'https://second.example/secret',
  'https://third.example/secret',
]
const issue = (
  sequence,
  { eligible = true, target = '2026-09-30T06:00:00.000Z', horizonHours = 1 } = {},
) => ({
  sequence,
  baseline: { canonicalityEvidenceDoc: { provider: 'https://third.example' } },
  baselineWitness: { provider: 'https://first.example' },
  cases: eligible
    ? [{ status: 'measured', measurement: { status: 'success' } }]
    : [{ status: 'unavailable' }],
  targets: [
    {
      horizonHours,
      targetAtUtc: target,
      captureDeadlineUtc: new Date(Date.parse(target) + 2 * 3_600_000).toISOString(),
    },
  ],
})

test('due sweep excludes unmeasured issues and completed horizons', () => {
  const rows = pendingPublicDirectScorePlans(
    [issue(1, { eligible: false }), issue(2), issue(3)],
    [{ issueSequence: 3, horizonHours: 1 }],
    '2026-09-30T06:01:00.000Z',
  )
  assert.deepEqual(
    rows.map((row) => row.issueSequence),
    [2],
  )
})

test('live capture windows precede expired backlog; earliest deadline first', () => {
  const rows = pendingPublicDirectScorePlans(
    [
      issue(1, { target: '2026-09-29T00:00:00.000Z' }),
      issue(2, { target: '2026-09-30T05:00:00.000Z' }),
      issue(3, { target: '2026-09-30T06:00:00.000Z' }),
    ],
    [],
    '2026-09-30T06:01:00.000Z',
  )
  assert.deepEqual(
    rows.map((row) => row.issueSequence),
    [2, 3, 1],
  )
  assert.deepEqual(
    rows.map((row) => row.active),
    [true, true, false],
  )
})

test('tries the issue-recorded origin pair first and never pairs one host', () => {
  const pairs = rankedPublicOriginPairs(urls, issue(3))
  assert.deepEqual(pairs[0], [urls[2], urls[0]])
  assert.notEqual(pairs[1][0], urls[2])
  assert.equal(pairs.length, MAX_PAIR_ATTEMPTS)
  for (const [a, b] of pairs) assert.notEqual(new URL(a).hostname, new URL(b).hostname)
  assert.doesNotThrow(() =>
    rankedPublicOriginPairs(['https://one.example/a', 'https://one.example/b', urls[2]], issue(3)),
  )
})

test('retry is not a negative outcome; alternate public pair may score', async () => {
  const attempts = []
  const summary = await runPublicDirectScoreSweep({
    issues: [issue(1, { eligible: false }), issue(2)],
    scores: [],
    urls,
    now: () => new Date('2026-09-30T06:01:00.000Z'),
    clientsFor: (pair) => pair,
    score: async ({ issueSequence, horizonHours, clients }) => {
      attempts.push([issueSequence, horizonHours, clients])
      return { status: attempts.length === 1 ? 'retry_target_unavailable' : 'scored' }
    },
  })
  assert.equal(summary.skippedNoBaseline, 1)
  assert.equal(summary.attempted, 1)
  assert.equal(summary.scored, 1)
  assert.equal(summary.retries, 0)
  assert.equal(attempts.length, 2)
})

test('all retry statuses remain unscored and fixed per-tick plan bound holds', async () => {
  const issues = Array.from({ length: 10 }, (_, index) => issue(index + 1))
  let attempts = 0
  const summary = await runPublicDirectScoreSweep({
    issues,
    scores: [],
    urls,
    now: () => new Date('2026-09-30T06:01:00.000Z'),
    clientsFor: (pair) => pair,
    score: async () => {
      attempts++
      return { status: 'retry_replay_unavailable' }
    },
  })
  assert.equal(summary.attempted, 6)
  assert.equal(summary.retries, 6)
  assert.equal(summary.scored, 0)
  assert.equal(attempts, 6 * MAX_PAIR_ATTEMPTS)
})

test('new H1 gets an attempt despite more than six older retries; rotation reaches old plans', async () => {
  const issues = [
    ...Array.from({ length: 8 }, (_, index) =>
      issue(index + 1, { target: '2026-09-30T05:00:00.000Z' }),
    ),
    issue(9, { target: '2026-09-30T06:00:00.000Z' }),
    issue(10, { target: '2026-09-30T05:00:00.000Z', horizonHours: 4 }),
    issue(11, { target: '2026-09-29T00:00:00.000Z' }),
  ]
  const firstAt = '2026-09-30T06:01:00.000Z'
  const raw = pendingPublicDirectScorePlans(issues, [], firstAt)
  assert.equal(
    raw.slice(0, 6).some((row) => row.issueSequence === 9),
    false,
  )
  const first = fairPublicDirectScorePlans(raw, firstAt)
  assert.equal(first.length, 6)
  assert.equal(first[0].issueSequence, 9)
  assert.ok(first.some((row) => row.issueSequence === 10))
  assert.equal(
    first.some((row) => row.issueSequence === 11),
    false,
  )
  const second = fairPublicDirectScorePlans(
    pendingPublicDirectScorePlans(issues, [], '2026-09-30T06:11:00.000Z'),
    '2026-09-30T06:11:00.000Z',
  )
  const attemptedOld = new Set(
    [...first, ...second].filter((row) => row.issueSequence <= 8).map((row) => row.issueSequence),
  )
  assert.equal(attemptedOld.size, 8)
  let sawH1 = false
  await runPublicDirectScoreSweep({
    issues,
    scores: [],
    urls,
    now: () => new Date(firstAt),
    clientsFor: (pair) => pair,
    score: async ({ issueSequence }) => {
      if (issueSequence === 9) sawH1 = true
      return { status: 'retry_target_unavailable' }
    },
  })
  assert.equal(sawH1, true)
})

test('new sweep has no private database or agent scheduler import', () => {
  const source = readFileSync(
    join(import.meta.dirname, 'record-carry-public-direct-exit-scores.mjs'),
    'utf8',
  )
  assert.doesNotMatch(source, /@neondatabase|DATABASE_URL|PRIVATE_DB|codex.*automation/i)
})
