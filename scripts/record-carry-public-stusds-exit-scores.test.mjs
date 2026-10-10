import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  pendingStusdsScorePlans,
  runStusdsScoreSweep,
} from './record-carry-public-stusds-exit-scores.mjs'

const ORIGINS = ['https://one.example/', 'https://two.example/', 'https://three.example/']
const tick = join(import.meta.dirname, 'carry-public-stusds-exit-tick.sh')
const plistDir = join(import.meta.dirname, 'launchd')
const at = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 30, hour, minute)).toISOString()

function issue(sequence, { positive = true, targetHour = 1, horizonHours = 1 } = {}) {
  return {
    sequence,
    baseline: { canonicalityEvidenceDoc: { provider: ORIGINS[0] } },
    baselineWitness: { provider: ORIGINS[1] },
    cases: [
      positive
        ? { status: 'measured', measurement: { baselineStatus: 'success' } }
        : { status: 'measured', measurement: { baselineStatus: 'covered_revert' } },
    ],
    targets: [
      {
        horizonHours,
        targetAtUtc: at(targetHour),
        captureDeadlineUtc: at(targetHour + 2),
      },
    ],
  }
}

test('due baseline-success and covered-revert recovery plans are both scheduled', async () => {
  const issues = [issue(1), issue(2, { positive: false }), issue(3, { targetHour: 4 })]
  assert.deepEqual(pendingStusdsScorePlans(issues, [], at(0)), [])
  assert.deepEqual(
    pendingStusdsScorePlans(issues, [{ issueSequence: 1, horizonHours: 1 }], at(2)).map(
      (row) => row.issueSequence,
    ),
    [2],
  )
  assert.deepEqual(
    pendingStusdsScorePlans(issues, [], at(2)).map((row) => row.issueSequence),
    [1, 2],
  )
  assert.deepEqual(
    await runStusdsScoreSweep({
      issues: [issue(2, { positive: false })],
      scores: [],
      urls: ORIGINS,
      now: () => new Date(at(2)),
      score: async () => ({ status: 'retry_target_unavailable' }),
    }),
    { due: 1, attempted: 1, scored: 0, retries: 1, skippedNoBaseline: 0 },
  )
})

test('fresh H1 and active H4 get attempts despite eight old failing H1 plans', async () => {
  const issues = Array.from({ length: 8 }, (_, index) => issue(index + 1))
  issues.push(issue(9, { targetHour: 2 }))
  issues.push(issue(10, { targetHour: 2, horizonHours: 4 }))
  const calls = []
  const result = await runStusdsScoreSweep({
    issues,
    scores: [],
    urls: ORIGINS,
    now: () => new Date(at(2)),
    clientsFor: (pair) => pair,
    score: async ({ issueSequence, clients }) => {
      calls.push({ issueSequence, clients })
      return { status: 'retry_target_unavailable' }
    },
  })
  assert.equal(result.due, 10)
  assert.equal(result.attempted, 6)
  assert.equal(calls[0].issueSequence, 9)
  assert.ok(calls.some((call) => call.issueSequence === 10))
  assert.deepEqual(calls[0].clients, [ORIGINS[0], ORIGINS[1]])
})

test('ranked origin fallback can recover and summary contains no holder or URL', async () => {
  const seen = []
  const result = await runStusdsScoreSweep({
    issues: [issue(1)],
    scores: [],
    urls: ORIGINS,
    now: () => new Date(at(2)),
    clientsFor: (pair) => pair,
    score: async ({ clients }) => {
      seen.push(clients)
      return clients[0] === ORIGINS[0]
        ? { status: 'retry_replay_unavailable' }
        : { status: 'scored' }
    },
  })
  assert.deepEqual(seen[0], [ORIGINS[0], ORIGINS[1]])
  assert.ok(seen.some(([primary]) => primary !== ORIGINS[0]))
  assert.deepEqual(result, {
    due: 1,
    attempted: 1,
    scored: 1,
    retries: 0,
    skippedNoBaseline: 0,
  })
  assert.doesNotMatch(JSON.stringify(result), /example|holder|0x[0-9a-f]{40}/i)
})

test('unexpected scorer results fail closed and invalid as-of clocks are rejected', async () => {
  assert.throws(() => pendingStusdsScorePlans([], [], 'not-an-iso-date'), /asof_invalid/)
  await assert.rejects(
    runStusdsScoreSweep({
      issues: [issue(1)],
      scores: [],
      urls: ORIGINS,
      now: () => new Date(at(2)),
      clientsFor: (pair) => pair,
      score: async () => ({ status: 'unexpected_success' }),
    }),
    /result_invalid/,
  )
})

test('launchd stages issue at :31 and score every ten minutes with :36 deferred', () => {
  const issuePlist = readFileSync(
    join(plistDir, 'com.membrane.carry-public-stusds-exit-issue.plist'),
    'utf8',
  )
  const scorePlist = readFileSync(
    join(plistDir, 'com.membrane.carry-public-stusds-exit-score.plist'),
    'utf8',
  )
  assert.match(issuePlist, /<key>Minute<\/key><integer>31<\/integer>/)
  assert.deepEqual(
    [...scorePlist.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((match) =>
      Number(match[1]),
    ),
    [6, 16, 26, 36, 46, 56],
  )
  for (const plist of [issuePlist, scorePlist]) {
    assert.match(plist, /<key>RunAtLoad<\/key><false\/>/)
    assert.match(plist, /carry-public-stusds-exit-tick\.sh/)
    assert.doesNotMatch(plist, /neon|codex|DATABASE_URL/i)
  }
})

test('shell defers :36 score and suppresses child output on success and failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-stusds-schedule-'))
  const fakeTimeout = join(dir, 'timeout')
  const fakeDate = join(dir, 'date')
  const capture = join(dir, 'capture')
  writeFileSync(
    fakeTimeout,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PUBLIC_STUSDS_TEST_CAPTURE"\necho "secret holder URL"\necho "credential URL" >&2\nexit "${PUBLIC_STUSDS_TEST_EXIT:-0}"\n',
    { mode: 0o700 },
  )
  writeFileSync(fakeDate, '#!/bin/sh\necho "${PUBLIC_STUSDS_TEST_MINUTE:-15}"\n', {
    mode: 0o700,
  })
  const env = {
    ...process.env,
    PUBLIC_STUSDS_TIMEOUT_BIN: fakeTimeout,
    PUBLIC_STUSDS_DATE_BIN: fakeDate,
    PUBLIC_STUSDS_NODE_BIN: '/bin/true',
    PUBLIC_STUSDS_TEST_CAPTURE: capture,
  }
  try {
    const deferred = spawnSync('/bin/sh', [tick, 'score', '--locked'], {
      env: { ...env, PUBLIC_STUSDS_TEST_MINUTE: '36' },
      encoding: 'utf8',
    })
    assert.equal(deferred.status, 0)
    assert.equal(deferred.stdout.trim(), 'public-stusds-exit:score:deferred')
    assert.equal(existsSync(capture), false)
    for (const mode of ['issue', 'score']) {
      const good = spawnSync('/bin/sh', [tick, mode, '--locked'], { env, encoding: 'utf8' })
      assert.equal(good.status, 0)
      assert.equal(good.stdout.trim(), `public-stusds-exit:${mode}:ok`)
      assert.equal(good.stderr.trim(), '')
    }
    const args = readFileSync(capture, 'utf8').trim().split('\n')
    assert.match(args[0], /540s .*carry-public-stusds-exit-attempt\.mjs --issue/)
    assert.match(args[1], /330s .*carry-public-stusds-exit-attempt\.mjs --score/)
    const failed = spawnSync('/bin/sh', [tick, 'score', '--locked'], {
      env: { ...env, PUBLIC_STUSDS_TEST_EXIT: '42' },
      encoding: 'utf8',
    })
    assert.equal(failed.status, 1)
    assert.equal(failed.stderr.trim(), 'public-stusds-exit:score:failed')
    assert.doesNotMatch(failed.stdout + failed.stderr, /secret|credential|holder|URL/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one inherited lock keeps overlapping issue and score ticks apart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-stusds-lock-'))
  const fakeTimeout = join(dir, 'timeout')
  const fakeDate = join(dir, 'date')
  const started = join(dir, 'started')
  writeFileSync(
    fakeTimeout,
    '#!/bin/sh\necho invoked >> "$PUBLIC_STUSDS_TEST_STARTED"\nsleep 1\nexit 0\n',
    { mode: 0o700 },
  )
  writeFileSync(fakeDate, '#!/bin/sh\necho 15\n', { mode: 0o700 })
  const env = {
    ...process.env,
    TMPDIR: dir,
    PUBLIC_STUSDS_TIMEOUT_BIN: fakeTimeout,
    PUBLIC_STUSDS_DATE_BIN: fakeDate,
    PUBLIC_STUSDS_NODE_BIN: '/bin/true',
    PUBLIC_STUSDS_TEST_STARTED: started,
  }
  const first = spawn('/bin/sh', [tick, 'issue'], { env, stdio: 'ignore' })
  try {
    for (let tries = 0; tries < 100 && !existsSync(started); tries++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(existsSync(started), true)
    const second = spawnSync('/bin/sh', [tick, 'score'], { env, encoding: 'utf8' })
    assert.equal(second.status, 0)
    assert.equal(second.stdout.trim(), 'public-stusds-exit:busy')
    assert.equal(readFileSync(started, 'utf8').trim(), 'invoked')
    if (first.exitCode === null)
      await new Promise((resolve, reject) => {
        first.once('error', reject)
        first.once('exit', resolve)
      })
  } finally {
    if (first.exitCode === null) first.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
