import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const tick = join(import.meta.dirname, 'carry-public-direct-exit-tick.sh')
const plistDir = join(import.meta.dirname, 'launchd')

test('launchd schedules hourly staggered issues and ten-minute due sweeps', () => {
  const aave = readFileSync(
    join(plistDir, 'com.membrane.carry-public-direct-exit-aave-issue.plist'),
    'utf8',
  )
  const spark = readFileSync(
    join(plistDir, 'com.membrane.carry-public-direct-exit-spark-issue.plist'),
    'utf8',
  )
  const usde = readFileSync(
    join(plistDir, 'com.membrane.carry-public-direct-exit-aave-usde-issue.plist'),
    'utf8',
  )
  const score = readFileSync(
    join(plistDir, 'com.membrane.carry-public-direct-exit-score.plist'),
    'utf8',
  )
  assert.match(aave, /<key>Minute<\/key><integer>18<\/integer>/)
  assert.match(spark, /<key>Minute<\/key><integer>48<\/integer>/)
  assert.match(usde, /<key>Minute<\/key><integer>58<\/integer>/)
  assert.match(usde, /issue-aave-usde/)
  assert.deepEqual(
    [...score.matchAll(/<key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((match) =>
      Number(match[1]),
    ),
    [1, 11, 21, 31, 41, 51],
  )
  for (const plist of [aave, spark, usde, score]) {
    assert.match(plist, /<key>RunAtLoad<\/key><false\/>/)
    assert.match(plist, /carry-public-direct-exit-tick\.sh/)
    assert.doesNotMatch(plist, /neon|codex|DATABASE_URL/i)
  }
})

test('shell invokes only fixed public commands and suppresses child output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-direct-scheduler-'))
  const fakeTimeout = join(dir, 'timeout')
  const fakeDate = join(dir, 'date')
  const capture = join(dir, 'args')
  writeFileSync(
    fakeTimeout,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PUBLIC_DIRECT_TEST_CAPTURE"\ncase "$*" in\n  *carry-public-aave-usdc-fixed-q-v2-issue.mjs*) printf '{"status":"issued"}\\n' ;;\nesac\nexit 0\n`,
    { mode: 0o700 },
  )
  writeFileSync(
    fakeDate,
    '#!/bin/sh\nif [ "$1" = "+%M" ]; then echo "${PUBLIC_DIRECT_TEST_MINUTE:-11}"; else echo 00; fi\n',
    {
      mode: 0o700,
    },
  )
  const env = {
    ...process.env,
    PUBLIC_DIRECT_TIMEOUT_BIN: fakeTimeout,
    PUBLIC_DIRECT_DATE_BIN: fakeDate,
    PUBLIC_DIRECT_NODE_BIN: '/bin/true',
    PUBLIC_DIRECT_TEST_CAPTURE: capture,
  }
  try {
    for (const mode of ['issue-aave', 'issue-aave-usde', 'issue-spark', 'score']) {
      const run = spawnSync('/bin/sh', [tick, mode, '--locked'], { env, encoding: 'utf8' })
      assert.equal(run.status, 0)
      assert.match(run.stdout, new RegExp(`public-direct-exit:${mode}:ok`))
      assert.doesNotMatch(run.stdout + run.stderr, /secret|holder|0x[0-9a-f]{40}/i)
    }
    const args = readFileSync(capture, 'utf8').trim().split('\n')
    assert.match(args[0], /--issue aaveV3Usdc/)
    assert.match(args[1], /carry-public-aave-usdc-fixed-q-v2-issue\.mjs --issue-latest/)
    assert.match(args[2], /--issue aaveV3Usde/)
    assert.match(args[3], /--issue sparkLendUsdt/)
    assert.match(args.at(-1), /record-carry-public-direct-exit-scores\.mjs --sweep/)
    const beforeUsde = spawnSync('/bin/sh', [tick, 'score', '--locked'], {
      env: { ...env, PUBLIC_DIRECT_TEST_MINUTE: '51' },
      encoding: 'utf8',
    })
    assert.equal(beforeUsde.status, 0)
    assert.match(beforeUsde.stdout, /public-direct-exit:score:ok/)
    assert.match(readFileSync(capture, 'utf8').trim().split('\n').at(-1), /^-k 5s 195s /)
    const beforeBoundary = spawnSync('/bin/sh', [tick, 'score', '--locked'], {
      env: { ...env, PUBLIC_DIRECT_TEST_MINUTE: '57' },
      encoding: 'utf8',
    })
    assert.equal(beforeBoundary.status, 0)
    assert.equal(beforeBoundary.stdout.trim(), 'public-direct-exit:score:deferred')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shell never emits child credentials or holder data on failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-direct-redaction-'))
  const fakeTimeout = join(dir, 'timeout')
  writeFileSync(
    fakeTimeout,
    '#!/bin/sh\necho "secret-key holder 0x123"\necho "vendor URL" >&2\nexit 42\n',
    { mode: 0o700 },
  )
  try {
    const run = spawnSync('/bin/sh', [tick, 'issue-aave', '--locked'], {
      env: {
        ...process.env,
        PUBLIC_DIRECT_TIMEOUT_BIN: fakeTimeout,
        PUBLIC_DIRECT_NODE_BIN: '/bin/true',
      },
      encoding: 'utf8',
    })
    assert.equal(run.status, 1)
    assert.equal(run.stderr.trim(), 'public-direct-exit:issue-aave:failed')
    assert.doesNotMatch(run.stdout + run.stderr, /secret|vendor|holder|0x123/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one inherited local lock prevents overlapping issue and score processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-direct-lock-'))
  const fakeTimeout = join(dir, 'timeout')
  const started = join(dir, 'started')
  writeFileSync(
    fakeTimeout,
    '#!/bin/sh\necho invoked >> "$PUBLIC_DIRECT_TEST_STARTED"\nsleep 1\nexit 0\n',
    { mode: 0o700 },
  )
  const env = {
    ...process.env,
    TMPDIR: dir,
    PUBLIC_DIRECT_TIMEOUT_BIN: fakeTimeout,
    PUBLIC_DIRECT_NODE_BIN: '/bin/true',
    PUBLIC_DIRECT_TEST_STARTED: started,
  }
  const first = spawn('/bin/sh', [tick, 'issue-aave'], { env, stdio: 'ignore' })
  try {
    for (let tries = 0; tries < 100 && !existsSync(started); tries++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(existsSync(started), true)
    const second = spawnSync('/bin/sh', [tick, 'score'], { env, encoding: 'utf8' })
    assert.equal(second.status, 0)
    assert.equal(second.stdout.trim(), 'public-direct-exit:busy')
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
