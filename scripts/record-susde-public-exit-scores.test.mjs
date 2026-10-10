import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { pendingSusdePlans } from './lib/susde-public-due-sweep.mjs'
import {
  rankedSusdeInitiationPairs,
  runSusdeInitiationScoreSweep,
} from './record-susde-public-initiation-scores.mjs'
import { runSusdePendingScoreSweep } from './record-susde-public-pending-exit-scores.mjs'

const at = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 30, hour, minute)).toISOString()
const tick = join(import.meta.dirname, 'susde-public-exit-tick.sh')
const plist = (lane, mode) =>
  readFileSync(
    join(
      import.meta.dirname,
      'launchd',
      `com.membrane.susde-public-${lane === 'pending' ? 'pending-exit' : lane}-${mode}.plist`,
    ),
    'utf8',
  )
const pairs = [
  [{ provider: 'https://one.test' }, { provider: 'https://two.test' }],
  [{ provider: 'https://three.test' }, { provider: 'https://two.test' }],
  [{ provider: 'https://one.test' }, { provider: 'https://three.test' }],
]

function issue(sequence, { horizonHours = 1, targetHour = 1, eligible = true } = {}) {
  return {
    sequence,
    pendingAssetsRaw: '100',
    baseline: { witnesses: [{ provider: 'https://one.test' }, { provider: 'https://two.test' }] },
    cases: eligible ? [{ measurement: { status: 'simulated_initiation_success' } }] : [],
    targets: [
      {
        horizonHours,
        targetAtUtc: at(targetHour),
        captureDeadlineUtc: at(targetHour + 2),
      },
    ],
  }
}

test('only due unscored targets are selected; invalid clock is rejected', () => {
  const issues = [issue(1), issue(2, { targetHour: 4 })]
  assert.deepEqual(
    pendingSusdePlans(issues, [], at(0), () => true),
    [],
  )
  assert.deepEqual(
    pendingSusdePlans(issues, [{ issueSequence: 1, horizonHours: 1 }], at(2), () => true),
    [],
  )
  assert.deepEqual(
    pendingSusdePlans(issues, [], at(2), () => true).map((p) => p.issueSequence),
    [1],
  )
  assert.throws(() => pendingSusdePlans([], [], 'bad', () => true), /asof_invalid/)
})

test('fresh H1 and active non-H1 survive stale backlog in both lanes', async () => {
  const issues = Array.from({ length: 8 }, (_, i) => issue(i + 1))
  issues.push(issue(9, { targetHour: 2 }), issue(10, { targetHour: 2, horizonHours: 4 }))
  const pendingCalls = []
  const pending = await runSusdePendingScoreSweep({
    issues,
    scores: [],
    urls: ['one', 'two'],
    now: () => new Date(at(2)),
    score: async (plan) => {
      pendingCalls.push(plan.issueSequence)
      throw Error('susde_score_rpc_unavailable')
    },
  })
  assert.equal(pending.attempted, 6)
  assert.equal(pendingCalls[0], 9)
  assert.ok(pendingCalls.includes(10))
  assert.equal(pending.retries, 6)

  const initiationCalls = []
  const initiation = await runSusdeInitiationScoreSweep({
    issues,
    scores: [],
    urls: ['one', 'two'],
    now: () => new Date(at(2)),
    pairsFor: () => pairs,
    score: async (plan) => {
      initiationCalls.push(plan.issueSequence)
      return { status: 'retry_target_or_replay_unavailable' }
    },
  })
  assert.equal(initiation.attempted, 6)
  assert.equal(initiationCalls[0], 9)
  assert.ok(initiationCalls.includes(10))
})

test('pending late score is counted as a censored record, while unexpected failures propagate', async () => {
  const late = await runSusdePendingScoreSweep({
    issues: [issue(1)],
    scores: [],
    urls: ['one', 'two'],
    now: () => new Date(at(4)),
    score: async () => ({ sequence: 1, outcome: 'capture_window_missed' }),
  })
  assert.deepEqual(late, { due: 1, attempted: 1, scored: 1, retries: 0 })
  await assert.rejects(
    runSusdePendingScoreSweep({
      issues: [issue(1)],
      scores: [],
      urls: ['one', 'two'],
      now: () => new Date(at(2)),
      score: async () => {
        throw Error('susde_ledger_invalid')
      },
    }),
    /ledger_invalid/,
  )
})

test('pending sweep retries an unfinalized first target without sealing a score', async () => {
  const result = await runSusdePendingScoreSweep({
    issues: [issue(1)],
    scores: [],
    urls: ['one', 'two'],
    now: () => new Date(at(2)),
    score: async () => {
      throw Error('susde_score_target_not_finalized')
    },
  })
  assert.deepEqual(result, { due: 1, attempted: 1, scored: 0, retries: 1 })
})

test('initiation skips missing baseline and uses preferred plus alternate origins', async () => {
  const selected = rankedSusdeInitiationPairs([...pairs].reverse(), issue(1))
  assert.equal(selected[0][0].provider, 'https://one.test')
  assert.equal(selected[0][1].provider, 'https://two.test')
  assert.notEqual(selected[1][0].provider, 'https://one.test')
  const result = await runSusdeInitiationScoreSweep({
    issues: [issue(1, { eligible: false })],
    scores: [],
    urls: ['one', 'two'],
    now: () => new Date(at(2)),
    score: async () => {
      throw Error('must_not_score')
    },
  })
  assert.deepEqual(result, {
    due: 0,
    attempted: 0,
    scored: 0,
    retries: 0,
    skippedNoBaseline: 1,
  })
})

test('native slots are distinct and child logs contain only fixed status codes', () => {
  const slots = {
    pendingIssue: [14],
    pendingScore: [6, 16, 26, 36, 46, 56],
    initiationIssue: [44],
    initiationScore: [9, 19, 29, 39, 49, 59],
  }
  for (const lane of ['pending', 'initiation'])
    for (const mode of ['issue', 'score']) {
      const body = plist(lane, mode)
      assert.deepEqual(
        [...body.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => Number(m[1])),
        slots[`${lane}${mode[0].toUpperCase()}${mode.slice(1)}`],
      )
      assert.match(body, /<key>RunAtLoad<\/key><false\/>/)
      assert.doesNotMatch(body, /codex|DATABASE_URL|RECORDER_RPC_URL/i)
    }
  const dir = mkdtempSync(join(tmpdir(), 'susde-native-tick-'))
  const fakeTimeout = join(dir, 'timeout')
  const fakeDate = join(dir, 'date')
  const capture = join(dir, 'capture')
  writeFileSync(
    fakeTimeout,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SUSDE_PUBLIC_TEST_CAPTURE"\necho "secret holder URL"\necho "credential URL" >&2\nexit "${SUSDE_PUBLIC_TEST_EXIT:-0}"\n',
    { mode: 0o700 },
  )
  writeFileSync(fakeDate, '#!/bin/sh\necho "${SUSDE_PUBLIC_TEST_MINUTE:-29}"\n', { mode: 0o700 })
  const env = {
    ...process.env,
    SUSDE_PUBLIC_TIMEOUT_BIN: fakeTimeout,
    SUSDE_PUBLIC_DATE_BIN: fakeDate,
    SUSDE_PUBLIC_NODE_BIN: '/bin/true',
    SUSDE_PUBLIC_TEST_CAPTURE: capture,
  }
  try {
    for (const [lane, minute] of [
      ['pending', '16'],
      ['initiation', '49'],
    ]) {
      const deferred = spawnSync('/bin/sh', [tick, lane, 'score', '--locked'], {
        env: { ...env, SUSDE_PUBLIC_TEST_MINUTE: minute },
        encoding: 'utf8',
      })
      assert.equal(deferred.status, 0)
      assert.match(deferred.stdout, /deferred/)
      assert.equal(existsSync(capture), false)
    }
    for (const lane of ['pending', 'initiation'])
      for (const mode of ['issue', 'score']) {
        const good = spawnSync('/bin/sh', [tick, lane, mode, '--locked'], { env, encoding: 'utf8' })
        assert.equal(good.status, 0)
        assert.equal(good.stdout.trim(), `susde-public-exit:${lane}:${mode}:ok`)
        assert.equal(good.stderr.trim(), '')
      }
    const args = readFileSync(capture, 'utf8').trim().split('\n')
    assert.match(args[0], /540s .*susde-public-pending-exit-issue\.mjs --issue/)
    assert.match(args[1], /330s .*record-susde-public-pending-exit-scores\.mjs --sweep/)
    assert.match(args[2], /540s .*susde-public-initiation-issue\.mjs --issue/)
    assert.match(args[3], /330s .*record-susde-public-initiation-scores\.mjs --sweep/)
    const failed = spawnSync('/bin/sh', [tick, 'pending', 'score', '--locked'], {
      env: { ...env, SUSDE_PUBLIC_TEST_EXIT: '42' },
      encoding: 'utf8',
    })
    assert.equal(failed.status, 1)
    assert.equal(failed.stderr.trim(), 'susde-public-exit:pending:score:failed')
    assert.doesNotMatch(failed.stdout + failed.stderr, /secret|credential|holder|URL/i)
    writeFileSync(
      fakeTimeout,
      '#!/bin/sh\necho "secret holder URL" >&2\necho susde_evidence_invalid >&2\necho "credential URL" >&2\nexit 42\n',
      { mode: 0o700 },
    )
    const classified = spawnSync('/bin/sh', [tick, 'pending', 'issue', '--locked'], {
      env,
      encoding: 'utf8',
    })
    assert.equal(classified.status, 1)
    assert.equal(
      classified.stderr.trim(),
      'susde-public-exit:pending:issue:failed:reason=susde_evidence_invalid',
    )
    assert.doesNotMatch(classified.stdout + classified.stderr, /secret|credential|holder|URL/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one lane lock excludes overlapping issue and score without blocking other lane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'susde-native-lock-'))
  const fakeTimeout = join(dir, 'timeout')
  const fakeDate = join(dir, 'date')
  const started = join(dir, 'started')
  writeFileSync(fakeTimeout, '#!/bin/sh\necho invoked >> "$SUSDE_PUBLIC_TEST_STARTED"\nsleep 1\n', {
    mode: 0o700,
  })
  writeFileSync(fakeDate, '#!/bin/sh\necho 29\n', { mode: 0o700 })
  const env = {
    ...process.env,
    TMPDIR: dir,
    SUSDE_PUBLIC_TIMEOUT_BIN: fakeTimeout,
    SUSDE_PUBLIC_DATE_BIN: fakeDate,
    SUSDE_PUBLIC_NODE_BIN: '/bin/true',
    SUSDE_PUBLIC_TEST_STARTED: started,
  }
  const first = spawn('/bin/sh', [tick, 'pending', 'issue'], { env, stdio: 'ignore' })
  try {
    for (let i = 0; i < 100 && !existsSync(started); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(existsSync(started), true)
    const second = spawnSync('/bin/sh', [tick, 'pending', 'score'], { env, encoding: 'utf8' })
    assert.equal(second.status, 0)
    assert.equal(second.stdout.trim(), 'susde-public-exit:pending:busy')
    const separate = spawnSync('/bin/sh', [tick, 'initiation', 'score'], { env, encoding: 'utf8' })
    assert.equal(separate.status, 0)
    if (first.exitCode === null) await new Promise((resolve) => first.once('exit', resolve))
  } finally {
    if (first.exitCode === null) first.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
