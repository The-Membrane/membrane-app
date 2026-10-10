import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PRIME, ROUTE } from './pyusd-staking-economic-exit.mjs'
import {
  HORIZONS,
  appendRow,
  cliResultExitCode,
  dueTarget,
  firstFinalizedTarget,
  issue,
  readRows,
  score,
  summarizeProspective,
  verify,
  verifyEvidence,
} from './pyusd-staking-prospective.mjs'

// Fixture writes are a few KiB. Preserve the production reserve check while
// allowing this test process to run when the host has less than 1 GiB free.
const statfsSync = fs.statfsSync
fs.statfsSync = (path, ...options) => {
  const stats = statfsSync(path, ...options)
  if (!String(path).startsWith(join(tmpdir(), 'pyusd-prospective-'))) return stats
  return {
    ...stats,
    bavail: Math.max(Number(stats.bavail), Math.ceil((1_073_741_824 + 90_000) / stats.bsize)),
  }
}
syncBuiltinESMExports()

const HOLDER = `0x${'a'.repeat(40)}`
const aHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const issuedAtUtc = '2026-10-01T06:00:00.000Z'
const issueBody = (holder = HOLDER, issueClock = issuedAtUtc) => ({
  routeKey: ROUTE,
  destination: PRIME,
  holder,
  qRaw: '10',
  issuedAtUtc: issueClock,
  baseline: {
    chainId: 1,
    routeKey: ROUTE,
    destination: PRIME,
    blockNumber: '100',
    blockHash: aHash(100),
    blockTimestamp: Math.floor(Date.parse(issueClock) / 1000) - 100,
    origins: ['https://one.example', 'https://two.example'],
    assay: {
      holder,
      qRaw: '10',
      pyusdPayout: 'not_attested',
      stage: 'prime_to_wylds_callable',
      simulatedWyldsRaw: '11',
    },
    finalPayout: 'unassessed',
    pyusdConversion: 'not_attested',
  },
  targets: HORIZONS.map((horizonHours) => ({
    horizonHours,
    targetAtUtc: new Date(Date.parse(issueClock) + horizonHours * 3600_000).toISOString(),
    deadlineAtUtc: new Date(Date.parse(issueClock) + (horizonHours + 2) * 3600_000).toISOString(),
  })),
  payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
})

test('due selector takes earliest live cell before older expired censors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-due-test-'))
  try {
    const older = await appendRow('issues', issueBody(), root)
    const newer = await appendRow(
      'issues',
      issueBody(`0x${'b'.repeat(40)}`, '2026-10-01T08:00:00.000Z'),
      root,
    )
    const { issues, scores, attempts } = await verifyEvidence(root)
    assert.equal(issues.length, 2)
    assert.equal(scores.length, 0)
    assert.equal(attempts.length, 0)

    const live = dueTarget(issues, scores, '2026-10-01T09:30:00.000Z')
    assert.equal(live.issueRow.sha256, newer.sha256)
    assert.equal(live.plan.horizonHours, 1)
    const earliestOfTwoLive = dueTarget(issues, scores, '2026-10-01T10:30:00.000Z')
    assert.equal(earliestOfTwoLive.issueRow.sha256, newer.sha256)
    assert.equal(earliestOfTwoLive.plan.horizonHours, 1)
    const expiredFallback = dueTarget(
      issues,
      [{ issueSequence: newer.sequence, horizonHours: 1 }],
      '2026-10-01T09:30:00.000Z',
    )
    assert.equal(expiredFallback.issueRow.sha256, older.sha256)
    assert.equal(expiredFallback.plan.horizonHours, 1)
    const historical = dueTarget(issues, scores, '2026-10-10T00:00:00.000Z')
    assert.equal(historical.issueRow.sha256, older.sha256)
    assert.equal(historical.plan.horizonHours, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified evidence reader rejects a malformed attempts ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-evidence-test-'))
  try {
    await appendRow('issues', issueBody(), root)
    await mkdir(join(root, 'attempts'))
    await writeFile(join(root, 'attempts', 'unexpected.json'), '{}')
    await assert.rejects(verifyEvidence(root), /stray_file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sealed first-stage rows cannot assert a final PYUSD payout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-scope-test-'))
  try {
    for (const mutate of [
      (body) => (body.baseline.assay.pyusdPayout = 'paid'),
      (body) => (body.baseline.pyusdConversion = 'attested'),
      (body) => (body.baseline.finalPayout = 'paid'),
    ]) {
      const body = issueBody()
      mutate(body)
      await assert.rejects(appendRow('issues', body, root), /issue_invalid/)
    }
    const issueRow = await appendRow('issues', issueBody(), root)
    const plan = issueRow.targets[0]
    await assert.rejects(
      appendRow(
        'scores',
        {
          issueSequence: issueRow.sequence,
          issueSha256: issueRow.sha256,
          horizonHours: plan.horizonHours,
          targetAtUtc: plan.targetAtUtc,
          deadlineAtUtc: plan.deadlineAtUtc,
          scoredAtUtc: '2026-10-01T07:02:00.000Z',
          status: 'measured',
          target: {
            number: '101',
            hash: aHash(101),
            timestamp: Date.parse(plan.targetAtUtc) / 1000,
          },
          measurement: {
            blockNumber: '101',
            blockHash: aHash(101),
            origins: ['https://one.example', 'https://two.example'],
            assay: { holder: HOLDER, qRaw: '10', pyusdPayout: 'not_attested' },
            pyusdConversion: 'not_attested',
            finalPayout: 'paid',
          },
          deadlineWitness: null,
          payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
        },
        root,
      ),
      /measured_invalid/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('score evidence blocks cannot postdate the local score clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-clock-test-'))
  try {
    const issueRow = await appendRow('issues', issueBody(), root)
    const plan = issueRow.targets[0]
    const measuredAtUtc = '2026-10-01T07:02:00.000Z'
    const futureTargetTimestamp = Date.parse(measuredAtUtc) / 1_000 + 1
    await assert.rejects(
      appendRow(
        'scores',
        {
          issueSequence: issueRow.sequence,
          issueSha256: issueRow.sha256,
          horizonHours: plan.horizonHours,
          targetAtUtc: plan.targetAtUtc,
          deadlineAtUtc: plan.deadlineAtUtc,
          scoredAtUtc: measuredAtUtc,
          status: 'measured',
          target: { number: '101', hash: aHash(101), timestamp: futureTargetTimestamp },
          measurement: {
            routeKey: ROUTE,
            destination: PRIME,
            blockNumber: '101',
            blockHash: aHash(101),
            blockTimestamp: futureTargetTimestamp,
            origins: ['https://one.example', 'https://two.example'],
            assay: { holder: HOLDER, qRaw: '10', pyusdPayout: 'not_attested' },
            pyusdConversion: 'not_attested',
            finalPayout: 'unassessed',
          },
          deadlineWitness: null,
          payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
        },
        root,
      ),
      /measured_invalid/,
    )
    const missedAtUtc = '2026-10-01T09:01:00.000Z'
    const scoredSecond = Date.parse(missedAtUtc) / 1_000
    const header = (number, timestamp) => ({
      number: String(number),
      hash: aHash(number),
      parentHash: aHash(number - 1),
      timestamp,
    })
    const witness = (timestamp) => ({
      origins: ['https://one.example', 'https://two.example'],
      heads: [header(256, timestamp), header(256, timestamp)],
      commonHeaders: [header(256, timestamp), header(256, timestamp)],
    })
    const missed = (deadlineWitness) => ({
      issueSequence: issueRow.sequence,
      issueSha256: issueRow.sha256,
      horizonHours: plan.horizonHours,
      targetAtUtc: plan.targetAtUtc,
      deadlineAtUtc: plan.deadlineAtUtc,
      scoredAtUtc: missedAtUtc,
      status: 'missed_window',
      target: null,
      measurement: null,
      deadlineWitness,
      payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
    })
    await assert.rejects(
      appendRow('scores', missed(witness(scoredSecond + 1)), root),
      /censor_invalid/,
    )
    const futureHead = witness(scoredSecond)
    futureHead.heads[1] = header(257, scoredSecond + 1)
    await assert.rejects(appendRow('scores', missed(futureHead), root), /censor_invalid/)
    assert.deepEqual(await readdir(join(root, 'scores')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('campaign CLI requires an actual sealed issue or score', () => {
  assert.equal(cliResultExitCode('--issue', { status: 'no_fresh_holder' }), 0)
  assert.equal(cliResultExitCode('--score', { status: 'no_due' }), 0)
  assert.equal(cliResultExitCode('--issue-campaign', { status: 'no_fresh_holder' }), 1)
  assert.equal(cliResultExitCode('--score-campaign', { status: 'no_due' }), 1)
  assert.equal(cliResultExitCode('--issue-campaign', { status: 'retry' }), 1)
  assert.equal(cliResultExitCode('--score-campaign', { status: 'sealed' }), 1)
  assert.equal(
    cliResultExitCode('--issue-campaign', {
      status: 'sealed',
      issue: { sequence: 1 },
      attemptLogStatus: 'sealed',
    }),
    0,
  )
  assert.equal(
    cliResultExitCode('--score-campaign', {
      status: 'sealed',
      score: { sequence: 1 },
      attemptLogStatus: 'failed',
    }),
    1,
  )
})

test('campaign wrapper keeps a bounded child and reports busy lock as retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-wrapper-test-'))
  const wrapper = fileURLToPath(
    new URL('../carry-pyusd-staking-prospective-tick.sh', import.meta.url),
  )
  const timeout = join(root, 'timeout-stub')
  const capture = join(root, 'invocation.txt')
  const env = {
    ...process.env,
    TMPDIR: root,
    PUBLIC_PYUSD_PRIME_TIMEOUT_BIN: timeout,
    PYUSD_PROSPECTIVE_TEST_CAPTURE: capture,
  }
  let holder
  try {
    await writeFile(timeout, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PYUSD_PROSPECTIVE_TEST_CAPTURE"\n')
    await chmod(timeout, 0o700)
    for (const [mode, limit] of [
      ['issue', '330s'],
      ['score', '330s'],
      ['issue-campaign', '500s'],
      ['score-campaign', '450s'],
    ]) {
      const run = spawnSync('/bin/sh', [wrapper, mode], { env, encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      const recorded = (await readFile(capture, 'utf8')).trim().split('\n')
      assert.deepEqual(recorded.slice(0, 3), ['-k', '5s', limit])
      assert.ok(recorded.includes('--max-old-space-size=384'))
      assert.equal(recorded.at(-1), `--${mode}`)
    }

    holder = spawn(
      '/usr/bin/python3',
      [
        '-c',
        'import fcntl, os, time; fd = os.open(os.path.join(os.environ["TMPDIR"], "membrane-pyusd-prime-prospective.lock"), os.O_CREAT | os.O_RDWR, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print("locked", flush=True); time.sleep(10)',
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('lock_holder_start_timeout')), 3000)
      holder.stdout.once('data', () => {
        clearTimeout(timer)
        resolve()
      })
      holder.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      holder.once('exit', (code) => {
        clearTimeout(timer)
        reject(Error(`lock_holder_exited_${code}`))
      })
    })
    const busyCampaign = spawnSync('/bin/sh', [wrapper, 'score-campaign'], {
      env,
      encoding: 'utf8',
    })
    assert.equal(busyCampaign.status, 75, busyCampaign.stderr)
    const busyStandalone = spawnSync('/bin/sh', [wrapper, 'score'], { env, encoding: 'utf8' })
    assert.equal(busyStandalone.status, 0, busyStandalone.stderr)
  } finally {
    holder?.kill()
    await rm(root, { recursive: true, force: true })
  }
})

test('fixed Q, horizon clocks, same-holder binding and censor survive immutable replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-test-'))
  try {
    const issue = await appendRow('issues', issueBody(), root)
    assert.equal((await readRows('issues', root)).length, 1)
    const plan = issue.targets[0]
    const score = await appendRow(
      'scores',
      {
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        horizonHours: 1,
        targetAtUtc: plan.targetAtUtc,
        deadlineAtUtc: plan.deadlineAtUtc,
        scoredAtUtc: '2026-10-01T09:01:00.000Z',
        status: 'missed_window',
        target: null,
        measurement: null,
        deadlineWitness: {
          origins: ['https://one.example', 'https://two.example'],
          heads: [
            { number: '256', hash: aHash(256), parentHash: aHash(255), timestamp: 1790845260 },
            { number: '256', hash: aHash(256), parentHash: aHash(255), timestamp: 1790845260 },
          ],
          commonHeaders: [
            { number: '256', hash: aHash(256), parentHash: aHash(255), timestamp: 1790845260 },
            { number: '256', hash: aHash(256), parentHash: aHash(255), timestamp: 1790845260 },
          ],
        },
        payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
      },
      root,
    )
    assert.equal(score.status, 'missed_window')
    assert.deepEqual((await verify(root)).measuredScores, 0)
    assert.equal((await verify(root)).missedScores, 1)
    await assert.rejects(
      appendRow(
        'scores',
        {
          issueSequence: issue.sequence,
          issueSha256: issue.sha256,
          horizonHours: 1,
          targetAtUtc: plan.targetAtUtc,
          deadlineAtUtc: plan.deadlineAtUtc,
          scoredAtUtc: '2026-10-01T09:02:00.000Z',
          status: 'missed_window',
          target: null,
          measurement: null,
          deadlineWitness: score.deadlineWitness,
          payoutAssessment: 'first_stage_only_usdc_pyusd_unassessed',
        },
        root,
      ),
      /score_duplicate/,
    )
    assert.deepEqual(await readdir(join(root, 'scores')), ['00000001.json'])
    const publicView = summarizeProspective([issue], [score], '2026-10-01T10:00:00.000Z')
    assert.deepEqual(publicView.cells[0], {
      horizonHours: 1,
      issued: 1,
      baselineCallable: 1,
      baselineImpaired: 0,
      measured: 0,
      callable: 0,
      nonCallable: 0,
      missedWindow: 1,
      pending: 0,
      outcomeMissing: 0,
    })
    assert.equal(JSON.stringify(publicView).includes(HOLDER), false)
    assert.equal(JSON.stringify(publicView).includes('qRaw'), false)
    assert.equal(publicView.calibratedForecast, false)
    await assert.rejects(
      appendRow('issues', { ...issueBody(), holder: 'invalid' }, root),
      /issue_invalid/,
    )
    assert.deepEqual(await readdir(join(root, 'issues')), ['00000001.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('first finalized target selects boundary and requires two matching headers', async () => {
  const blocks = new Map([
    [100, { number: '0x64', hash: aHash(100), parentHash: aHash(99), timestamp: '0x64' }],
    [101, { number: '0x65', hash: aHash(101), parentHash: aHash(100), timestamp: '0x6e' }],
    [102, { number: '0x66', hash: aHash(102), parentHash: aHash(101), timestamp: '0x78' }],
    [103, { number: '0x67', hash: aHash(103), parentHash: aHash(102), timestamp: '0x82' }],
  ])
  const origin = (provider, mutate = () => null) => ({
    provider,
    request: async (method, params) => {
      if (method === 'eth_chainId') return '0x1'
      if (method !== 'eth_getBlockByNumber') throw Error('unexpected_rpc')
      const number = params[0] === 'finalized' ? 103 : Number(BigInt(params[0]))
      return mutate(number) ?? blocks.get(number)
    },
  })
  const found = await firstFinalizedTarget(
    [origin('https://one.example'), origin('https://two.example')],
    '100',
    '1970-01-01T00:02:00.000Z',
  )
  assert.equal(found.target.number, '102')
  assert.equal(found.previous.number, '101')
  await assert.rejects(
    firstFinalizedTarget(
      [
        origin('https://one.example'),
        origin('https://two.example', (n) =>
          n === 102 ? { ...blocks.get(n), hash: aHash(999) } : null,
        ),
      ],
      '100',
      '1970-01-01T00:02:00.000Z',
    ),
    /target_disagreement/,
  )
})

test('native scorer seals a missed-window censor only after both finalized heads pass deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-score-test-'))
  try {
    await appendRow('issues', issueBody(), root)
    const provider = (name, timestamp) => ({
      provider: name,
      request: async (method) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber')
          return {
            number: '0x100',
            hash: aHash(256),
            parentHash: aHash(255),
            timestamp: `0x${timestamp.toString(16)}`,
          }
        throw Error('unexpected_rpc')
      },
    })
    const onTime = [
      provider('https://one.example', 1790845260),
      provider('https://two.example', 1790845260),
    ]
    const result = await score(() => new Date('2026-10-01T09:01:00.000Z'), root, [onTime])
    assert.equal(result.status, 'sealed')
    assert.equal(result.score.status, 'missed_window')
    assert.equal((await verify(root)).scores, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('divergent finalized heads cannot publish a missed-window censor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-divergence-test-'))
  try {
    await appendRow('issues', issueBody(), root)
    const provider = (name, hash) => ({
      provider: name,
      request: async (method) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber')
          return {
            number: '0x100',
            hash,
            parentHash: aHash(255),
            timestamp: `0x${(1790845260).toString(16)}`,
          }
        throw Error('unexpected_rpc')
      },
    })
    const origins = [
      provider('https://one.example', aHash(256)),
      provider('https://two.example', aHash(999)),
    ]
    const result = await score(() => new Date('2026-10-01T09:01:00.000Z'), root, [origins])
    assert.equal(result.status, 'retry')
    assert.equal(result.reason, 'pyusd_prospective_deadline_disagreement')
    assert.equal((await readRows('scores', root)).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sealed score and issue remain terminal if attempt recording fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-prospective-attempt-test-'))
  try {
    const appendWithoutAttempts = (kind, body, directory) =>
      kind === 'attempts'
        ? Promise.reject(Error('injected_attempt_write_failure'))
        : appendRow(kind, body, directory)
    const issuePairs = [
      [{ provider: 'https://one.example' }, { provider: 'https://two.example' }],
      [{ provider: 'https://three.example' }, { provider: 'https://four.example' }],
    ]
    let captures = 0
    const issued = await issue(
      () => new Date(issuedAtUtc),
      root,
      issuePairs,
      appendWithoutAttempts,
      async () => {
        captures++
        return issueBody().baseline
      },
    )
    assert.equal(issued.status, 'sealed')
    assert.equal(issued.attemptLogStatus, 'failed')
    assert.equal(captures, 1)
    assert.equal((await readRows('issues', root)).length, 1)

    const provider = (name) => ({
      provider: name,
      request: async (method) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber')
          return {
            number: '0x100',
            hash: aHash(256),
            parentHash: aHash(255),
            timestamp: `0x${(1790845260).toString(16)}`,
          }
        throw Error('unexpected_rpc')
      },
    })
    const pairs = [
      [provider('https://one.example'), provider('https://two.example')],
      [provider('https://three.example'), provider('https://four.example')],
    ]
    const scored = await score(
      () => new Date('2026-10-01T09:01:00.000Z'),
      root,
      pairs,
      appendWithoutAttempts,
    )
    assert.equal(scored.status, 'sealed')
    assert.equal(scored.attemptLogStatus, 'failed')
    assert.equal((await readRows('scores', root)).length, 1)
    assert.equal((await readRows('attempts', root)).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
