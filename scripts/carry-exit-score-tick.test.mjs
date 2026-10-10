import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./carry-exit-score-tick.sh', import.meta.url))
const mainScript = fileURLToPath(new URL('./carry-cash-observation-tick.sh', import.meta.url))
const plist = fileURLToPath(
  new URL('./launchd/com.membrane.carry-exit-score.plist', import.meta.url),
)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'carry-exit-score-tick-'))
  const trace = join(dir, 'trace')
  const launchctl = join(dir, 'launchctl')
  const node = join(dir, 'node')
  const timeout = join(dir, 'timeout')
  await writeFile(
    launchctl,
    '#!/bin/sh\nif [ "$CARRY_SCORE_TEST_MAIN_MISSING" = 1 ]; then exit 1; fi\nprintf "state = %s\\n" "${CARRY_SCORE_TEST_MAIN_STATE:-not running}"\n',
    { mode: 0o755 },
  )
  await writeFile(
    node,
    '#!/bin/sh\necho "$*" >> "$CARRY_SCORE_TEST_TRACE"\nif [ "$CARRY_SCORE_TEST_SLEEP_MORPHO" = 1 ] && [ "$3" = scripts/record-carry-morpho-exit-outcomes.mjs ]; then /bin/sleep 2; fi\nif [ "$CARRY_SCORE_TEST_FAIL_DIRECT" = 1 ] && [ "$3" = scripts/record-carry-direct-exit-outcomes.mjs ]; then exit 7; fi\n',
    { mode: 0o755 },
  )
  await writeFile(timeout, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 })
  const env = {
    ...process.env,
    TMPDIR: dir,
    CARRY_EXIT_SCORE_LAUNCHCTL_BIN: launchctl,
    CARRY_EXIT_SCORE_NODE_BIN: node,
    CARRY_EXIT_SCORE_TIMEOUT_BIN: timeout,
    CARRY_SCORE_TEST_TRACE: trace,
  }
  return { dir, trace, env }
}

test('launchd schedules score-only work between full ticks with a hard deadline', () => {
  assert.equal(spawnSync('/bin/sh', ['-n', script]).status, 0)
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist]).status, 0)
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
    encoding: 'utf8',
  })
  assert.equal(parsed.status, 0)
  const job = JSON.parse(parsed.stdout)
  assert.equal(job.Label, 'com.membrane.carry-exit-score')
  assert.deepEqual(
    job.StartCalendarInterval.map((row) => row.Minute),
    [0, 5, 15, 20, 30, 35, 45, 50],
  )
  assert.deepEqual(job.ProgramArguments.slice(0, 5), [
    '/opt/homebrew/bin/timeout',
    '-k',
    '5s',
    '240s',
    '/bin/sh',
  ])
  assert.equal(job.ProgramArguments[5], script)
  assert.equal(job.RunAtLoad, false)
})

test('runs exactly four score stages and reports a failed stage', async () => {
  const { dir, trace, env } = await fixture()
  try {
    const success = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' })
    assert.equal(success.status, 0, success.stderr)
    assert.match(success.stdout, /carry-exit-score:tick ok/)
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), [
      '--import tsx scripts/record-carry-morpho-exit-outcomes.mjs --score',
      '--import tsx scripts/record-carry-direct-exit-outcomes.mjs --score',
      '--import tsx scripts/record-carry-susds-exit-outcomes.mjs --score',
      '--import tsx scripts/record-carry-usd3-exit-outcomes.mjs --score',
    ])
    const failure = spawnSync('/bin/sh', [script], {
      env: { ...env, CARRY_SCORE_TEST_FAIL_DIRECT: '1' },
      encoding: 'utf8',
    })
    assert.equal(failure.status, 1)
    assert.match(failure.stderr, /direct failed \(exit 7\)/)
    assert.match(failure.stdout, /usd3 ok/)
    assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 8)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('skips an active main tick and fails closed when main state is unavailable', async () => {
  const { dir, trace, env } = await fixture()
  try {
    const busy = spawnSync('/bin/sh', [script], {
      env: { ...env, CARRY_SCORE_TEST_MAIN_STATE: 'running' },
      encoding: 'utf8',
    })
    assert.equal(busy.status, 0)
    assert.match(busy.stdout, /main-tick-running; skip/)
    const missing = spawnSync('/bin/sh', [script], {
      env: { ...env, CARRY_SCORE_TEST_MAIN_MISSING: '1' },
      encoding: 'utf8',
    })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /cannot verify main tick state/)
    await assert.rejects(readFile(trace, 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('main and score-only ticks share an atomic lock', async () => {
  const { dir, trace, env } = await fixture()
  const holder = spawn(
    '/usr/bin/python3',
    [
      '-c',
      `import fcntl, os, time
fd = os.open(os.path.join(os.environ['TMPDIR'], 'membrane-carry-exit-ledgers.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print('locked', flush=True)
time.sleep(10)`,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', (data) => {
        if (data.toString().includes('locked')) resolve()
        else reject(new Error(`unexpected holder output: ${data}`))
      })
      holder.once('error', reject)
      holder.once('exit', (code) => reject(new Error(`lock holder exited ${code}`)))
    })
    const score = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' })
    assert.equal(score.status, 0)
    assert.match(score.stdout, /already-running/)
    const main = spawnSync('/bin/sh', [mainScript], { env, encoding: 'utf8' })
    assert.equal(main.status, 1)
    assert.match(main.stderr, /exit-ledger-lock-busy/)
    await assert.rejects(readFile(trace, 'utf8'), { code: 'ENOENT' })
  } finally {
    holder.kill('SIGTERM')
    await rm(dir, { recursive: true, force: true })
  }
})

test('score-only keeps the shared lock after exec while a stage is running', async () => {
  const { dir, trace, env } = await fixture()
  const score = spawn('/bin/sh', [script], {
    env: { ...env, CARRY_SCORE_TEST_SLEEP_MORPHO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    let stageStarted = false
    for (let i = 0; i < 100; i++) {
      try {
        stageStarted = (await readFile(trace, 'utf8')).includes(
          'scripts/record-carry-morpho-exit-outcomes.mjs --score',
        )
        if (stageStarted) break
      } catch {
        /* score process has not started its first stage yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(stageStarted, true)
    assert.equal(score.exitCode, null)
    const main = spawnSync('/bin/sh', [mainScript], { env, encoding: 'utf8' })
    assert.equal(main.status, 1)
    assert.match(main.stderr, /exit-ledger-lock-busy/)
    assert.equal(await new Promise((resolve) => score.once('exit', resolve)), 0)
    assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 4)
  } finally {
    if (score.exitCode === null) score.kill('SIGTERM')
    await rm(dir, { recursive: true, force: true })
  }
})
