import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const SCRIPT = resolve('scripts/carry-public-sgho-exit-tick.sh')

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sgho-score-tick-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const timeout = join(dir, 'timeout')
  const node = join(dir, 'node')
  const calls = join(dir, 'calls')
  const timeouts = join(dir, 'timeouts')
  const options = join(dir, 'options')
  const args = join(dir, 'args')
  await writeFile(
    timeout,
    '#!/bin/sh\nprintf "%s\\n" "$3" >> "$SGHO_TEST_TIMEOUTS"\nshift 3\nexec "$@"\n',
    { mode: 0o700 },
  )
  await writeFile(
    node,
    `#!/bin/sh
printf '%s\n' "$1" >> "$SGHO_TEST_CALLS"
printf '%s\n' "$NODE_OPTIONS" >> "$SGHO_TEST_OPTIONS"
printf '%s\n' "$2" >> "$SGHO_TEST_ARGS"
case "$1" in
  *sgho-exit-issue.mjs) : ;;
  *fixed-q-v2-issue.mjs)
    case "$SGHO_TEST_ISSUE" in
      retry) printf '%s\n' '{"status":"retry_baseline_replay"}' ;;
      none) printf '%s\n' '{"status":"no_eligible_fresh_v1_issue"}' ;;
      fatal) exit 1 ;;
      *) printf '%s\n' '{"status":"issued","sequence":1}' ;;
    esac ;;
  *fixed-q-v2-scores.mjs) : ;;
  *sgho-exit-scores.mjs) : ;;
  *) exit 7 ;;
esac
`,
    { mode: 0o700 },
  )
  return { dir, timeout, node, calls, timeouts, options, args }
}

function tick(env, mode = 'score', locked = true) {
  return spawnSync('/bin/sh', [SCRIPT, mode, ...(locked ? ['--locked'] : [])], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

test('10-minute score tick retries fixed-Q issue and still scores V1', async (t) => {
  const f = await fixture(t)
  const result = tick({
    PUBLIC_SGHO_NODE_BIN: f.node,
    PUBLIC_SGHO_TIMEOUT_BIN: f.timeout,
    SGHO_TEST_CALLS: f.calls,
    SGHO_TEST_TIMEOUTS: f.timeouts,
    SGHO_TEST_OPTIONS: f.options,
    SGHO_TEST_ARGS: f.args,
    SGHO_TEST_ISSUE: 'retry',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /fixed-q-issue:retry/)
  assert.match(result.stdout, /score:ok/)
  assert.deepEqual(
    (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((path) => path.split('/').at(-1)),
    [
      'carry-public-sgho-fixed-q-v2-issue.mjs',
      'record-carry-public-sgho-fixed-q-v2-scores.mjs',
      'record-carry-public-sgho-exit-scores.mjs',
    ],
  )
})

test('no eligible parent is distinct from fatal V2 issue; V1 score still runs', async (t) => {
  const f = await fixture(t)
  const base = {
    PUBLIC_SGHO_NODE_BIN: f.node,
    PUBLIC_SGHO_TIMEOUT_BIN: f.timeout,
    SGHO_TEST_CALLS: f.calls,
    SGHO_TEST_TIMEOUTS: f.timeouts,
    SGHO_TEST_OPTIONS: f.options,
    SGHO_TEST_ARGS: f.args,
  }
  const none = tick({ ...base, SGHO_TEST_ISSUE: 'none' })
  assert.equal(none.status, 0, none.stderr)
  assert.match(none.stdout, /fixed-q-issue:no-eligible/)
  const fatal = tick({ ...base, SGHO_TEST_ISSUE: 'fatal' })
  assert.equal(fatal.status, 1)
  assert.match(fatal.stderr, /fixed-q-issue:failed/)
  assert.match(fatal.stdout, /score:ok/)
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n')
  assert.equal(
    calls.filter((path) => path.endsWith('record-carry-public-sgho-exit-scores.mjs')).length,
    2,
  )
})

test('campaign modes each run only one bounded stage with a 384 MiB Node heap', async (t) => {
  const f = await fixture(t)
  const env = {
    PUBLIC_SGHO_NODE_BIN: f.node,
    PUBLIC_SGHO_TIMEOUT_BIN: f.timeout,
    SGHO_TEST_CALLS: f.calls,
    SGHO_TEST_TIMEOUTS: f.timeouts,
    SGHO_TEST_OPTIONS: f.options,
    SGHO_TEST_ARGS: f.args,
  }
  for (const [mode, script, cliMode, limit] of [
    ['issue-campaign', 'scripts/research/carry-public-sgho-exit-issue.mjs', '--issue', '540s'],
    ['score-campaign', 'scripts/record-carry-public-sgho-exit-scores.mjs', '--sweep', '330s'],
    [
      'fixed-q-issue-campaign',
      'scripts/research/carry-public-sgho-fixed-q-v2-issue.mjs',
      '--issue-due',
      '180s',
    ],
    [
      'fixed-q-score-campaign',
      'scripts/record-carry-public-sgho-fixed-q-v2-scores.mjs',
      '--sweep',
      '330s',
    ],
  ]) {
    await writeFile(f.calls, '')
    await writeFile(f.timeouts, '')
    await writeFile(f.options, '')
    await writeFile(f.args, '')
    const result = tick(env, mode)
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
    assert.deepEqual((await readFile(f.calls, 'utf8')).trim().split('\n'), [script])
    assert.equal((await readFile(f.args, 'utf8')).trim(), cliMode)
    assert.equal((await readFile(f.timeouts, 'utf8')).trim(), limit)
    assert.equal((await readFile(f.options, 'utf8')).trim(), '--max-old-space-size=384')
    if (mode === 'fixed-q-issue-campaign') assert.match(result.stdout, /fixed-q-issue:issued/)
    assert.match(result.stdout, /:ok|:issued/)
    assert.ok(!result.stdout.includes('retry'))
  }
})

test('a campaign V2 baseline replay retry is a failed tick, not a sealed issue', async (t) => {
  const f = await fixture(t)
  const result = tick(
    {
      PUBLIC_SGHO_NODE_BIN: f.node,
      PUBLIC_SGHO_TIMEOUT_BIN: f.timeout,
      SGHO_TEST_CALLS: f.calls,
      SGHO_TEST_TIMEOUTS: f.timeouts,
      SGHO_TEST_OPTIONS: f.options,
      SGHO_TEST_ARGS: f.args,
      SGHO_TEST_ISSUE: 'retry',
    },
    'fixed-q-issue-campaign',
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /fixed-q-issue:retry/)
  assert.doesNotMatch(result.stdout, /:issued|:ok/)
})

test('a busy campaign lock returns nonzero without running a recorder', async (t) => {
  const f = await fixture(t)
  const holder = `
import fcntl, os, subprocess, sys
path = os.path.join(sys.argv[1], 'membrane-public-sgho-exit.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
child = subprocess.run(['/bin/sh', sys.argv[2], 'score-campaign'], env=os.environ, capture_output=True, text=True)
print(child.stderr.strip())
sys.exit(child.returncode)
`
  const result = spawnSync('/usr/bin/python3', ['-c', holder, f.dir, SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: f.dir, SGHO_TEST_CALLS: f.calls },
  })
  assert.equal(result.status, 75)
  assert.match(result.stdout, /public-sgho-exit:busy/)
  await assert.rejects(readFile(f.calls, 'utf8'), { code: 'ENOENT' })
})
