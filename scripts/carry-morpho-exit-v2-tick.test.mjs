import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./carry-morpho-exit-v2-tick.sh', import.meta.url))
const issuePlist = fileURLToPath(
  new URL('./launchd/com.membrane.carry-morpho-exit-v2-issue.plist', import.meta.url),
)
const scorePlist = fileURLToPath(
  new URL('./launchd/com.membrane.carry-morpho-exit-v2-score.plist', import.meta.url),
)

function job(path) {
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', path]).status, 0)
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0)
  return JSON.parse(result.stdout)
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'carry-morpho-exit-v2-'))
  const trace = join(dir, 'trace')
  const budgets = join(dir, 'budgets')
  const node = join(dir, 'node')
  const timeout = join(dir, 'timeout')
  await writeFile(
    node,
    `#!/bin/sh
echo "$*" >> "$V2_TEST_TRACE"
echo 'sensitive-holder-and-Q-and-URL'
echo 'sensitive-holder-and-Q-and-URL' >&2
if [ "${'${V2_TEST_SLEEP_ISSUE:-0}'}" = 1 ] && [ "$1" = scripts/record-carry-morpho-exit-v2-issues.mjs ]; then /bin/sleep 1; fi
if [ "${'${V2_TEST_FAIL_ISSUE:-0}'}" = 1 ] && [ "$1" = scripts/record-carry-morpho-exit-v2-issues.mjs ]; then exit 7; fi
`,
    { mode: 0o755 },
  )
  await writeFile(
    timeout,
    '#!/bin/sh\necho "$1 $2 $3" >> "$V2_TEST_BUDGETS"\nshift 3\nexec "$@"\n',
    { mode: 0o755 },
  )
  return {
    dir,
    trace,
    budgets,
    env: {
      ...process.env,
      TMPDIR: dir,
      CARRY_EXIT_V2_NODE_BIN: node,
      CARRY_EXIT_V2_TIMEOUT_BIN: timeout,
      V2_TEST_TRACE: trace,
      V2_TEST_BUDGETS: budgets,
    },
  }
}

test('launchd issue/witness cadence matches native slots and scorer repeats every five minutes', () => {
  assert.equal(spawnSync('/bin/sh', ['-n', script]).status, 0)
  const issue = job(issuePlist)
  const score = job(scorePlist)
  assert.equal(issue.Label, 'com.membrane.carry-morpho-exit-v2-issue')
  assert.equal(score.Label, 'com.membrane.carry-morpho-exit-v2-score')
  assert.deepEqual(
    issue.StartCalendarInterval.map((row) => row.Minute),
    [10, 25, 40, 55],
  )
  assert.deepEqual(
    score.StartCalendarInterval.map((row) => row.Minute),
    Array.from({ length: 12 }, (_, i) => i * 5),
  )
  assert.deepEqual(issue.ProgramArguments.slice(0, 5), [
    '/opt/homebrew/bin/timeout',
    '-k',
    '5s',
    '600s',
    '/bin/sh',
  ])
  assert.deepEqual(score.ProgramArguments.slice(0, 5), [
    '/opt/homebrew/bin/timeout',
    '-k',
    '5s',
    '660s',
    '/bin/sh',
  ])
  assert.deepEqual(issue.ProgramArguments.slice(-2), [script, 'issue'])
  assert.deepEqual(score.ProgramArguments.slice(-2), [script, 'score'])
  assert.equal(issue.RunAtLoad, false)
  assert.equal(score.RunAtLoad, false)
})

test('issue job runs issuer then separate witness; scorer does only scoring', async () => {
  const { dir, trace, budgets, env } = await fixture()
  try {
    const issue = spawnSync('/bin/sh', [script, 'issue'], { env, encoding: 'utf8' })
    assert.equal(issue.status, 0, issue.stderr)
    assert.match(issue.stdout, /issue tick ok/)
    assert.doesNotMatch(issue.stdout + issue.stderr, /sensitive-holder-and-Q-and-URL/)
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), [
      'scripts/record-carry-morpho-exit-v2-issues.mjs',
      'scripts/record-carry-exit-v2-issue-witness.mjs',
    ])
    assert.deepEqual((await readFile(budgets, 'utf8')).trim().split('\n'), [
      '-k 5s 300s',
      '-k 5s 120s',
    ])
    const score = spawnSync('/bin/sh', [script, 'score'], { env, encoding: 'utf8' })
    assert.equal(score.status, 0, score.stderr)
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n').slice(-1), [
      'scripts/record-carry-morpho-exit-v2-scores.mjs',
    ])
    assert.equal((await readFile(budgets, 'utf8')).trim().split('\n').at(-1), '-k 5s 630s')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('issue failure exits nonzero while witness still checks prior committed batches', async () => {
  const { dir, trace, env } = await fixture()
  try {
    const result = spawnSync('/bin/sh', [script, 'issue'], {
      env: { ...env, V2_TEST_FAIL_ISSUE: '1' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /issue failed \(exit 7\)/)
    assert.match(result.stdout, /witness ok/)
    assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('duplicate issue process fails closed and cannot run overlapping stages', async () => {
  const { dir, trace, env } = await fixture()
  const first = spawn('/bin/sh', [script, 'issue'], {
    env: { ...env, V2_TEST_SLEEP_ISSUE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    let started = false
    for (let i = 0; i < 100; i++) {
      try {
        started = (await readFile(trace, 'utf8')).includes('record-carry-morpho-exit-v2-issues')
      } catch {
        /* first process has not begun */
      }
      if (started) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(started, true)
    const duplicate = spawnSync('/bin/sh', [script, 'issue'], { env, encoding: 'utf8' })
    assert.equal(duplicate.status, 1)
    assert.match(duplicate.stderr, /issue:already-running/)
    assert.equal(await new Promise((resolve) => first.once('exit', resolve)), 0)
  } finally {
    if (first.exitCode === null) first.kill('SIGTERM')
    await rm(dir, { recursive: true, force: true })
  }
})
