import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./carry-morpho-flow-tick.sh', import.meta.url))
const plist = fileURLToPath(
  new URL('./launchd/com.membrane.carry-morpho-flows.plist', import.meta.url),
)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'morpho-flow-tick-'))
  const trace = join(dir, 'trace')
  const budgetTrace = join(dir, 'budgets')
  const node = join(dir, 'node')
  const timeout = join(dir, 'timeout')
  await writeFile(
    node,
    `#!/bin/sh
echo "$*" >> "$MORPHO_TEST_TRACE"
if [ "$MORPHO_TEST_SLEEP" = 1 ]; then /bin/sleep 1; fi
if [ "$MORPHO_TEST_FAIL_CAPTURE" = 1 ] && [ "$1" = scripts/record-carry-morpho-v2-flows-local.mjs ]; then exit 7; fi
`,
    { mode: 0o755 },
  )
  await writeFile(
    timeout,
    '#!/bin/sh\necho "$1 $2 $3" >> "$MORPHO_TEST_BUDGET_TRACE"\nshift 3\nexec "$@"\n',
    { mode: 0o755 },
  )
  const env = {
    ...process.env,
    TMPDIR: dir,
    MORPHO_NODE_BIN: node,
    MORPHO_TIMEOUT_BIN: timeout,
    MORPHO_TEST_TRACE: trace,
    MORPHO_TEST_BUDGET_TRACE: budgetTrace,
  }
  return { dir, trace, budgetTrace, env }
}

test('separate launchd job is valid and offset from the H1 quarter-hour tick', () => {
  assert.equal(spawnSync('/bin/sh', ['-n', script]).status, 0)
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist]).status, 0)
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
    encoding: 'utf8',
  })
  assert.equal(parsed.status, 0)
  const job = JSON.parse(parsed.stdout)
  assert.equal(job.Label, 'com.membrane.carry-morpho-flows')
  assert.deepEqual(
    job.StartCalendarInterval.map((row) => row.Minute),
    [2, 32],
  )
  assert.equal(job.RunAtLoad, false)
  assert.equal(job.ProgramArguments[1], script)
})

test('tick runs bounded capture then reconciliation; capture failure still attempts backlog', async () => {
  const { dir, trace, budgetTrace, env } = await fixture()
  try {
    const success = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' })
    assert.equal(success.status, 0, success.stderr)
    assert.match(success.stdout, /carry-morpho-flow:tick ok/)
    const first = (await readFile(trace, 'utf8')).trim().split('\n')
    assert.deepEqual(first, [
      'scripts/record-carry-morpho-v2-flows-local.mjs --capture',
      'scripts/reconcile-carry-morpho-v2-withdrawals-local.mjs --run',
    ])
    assert.deepEqual((await readFile(budgetTrace, 'utf8')).trim().split('\n'), [
      '-k 10s 250s',
      '-k 10s 205s',
    ])
    const failure = spawnSync('/bin/sh', [script], {
      env: { ...env, MORPHO_TEST_FAIL_CAPTURE: '1' },
      encoding: 'utf8',
    })
    assert.equal(failure.status, 1)
    assert.match(failure.stderr, /capture failed \(exit 7\)/)
    assert.match(failure.stdout, /reconcile ok/)
    const second = (await readFile(trace, 'utf8')).trim().split('\n')
    assert.equal(second.length, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('advisory lock skips a duplicate and releases after the original tick', async () => {
  const { dir, trace, env } = await fixture()
  const first = spawn('/bin/sh', [script], {
    env: { ...env, MORPHO_TEST_SLEEP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    let observed = false
    for (let i = 0; i < 100; i++) {
      try {
        observed = (await readFile(trace, 'utf8')).length > 0
        if (observed) break
      } catch {
        /* first process has not reached capture */
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(observed, true)
    const duplicate = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' })
    assert.equal(duplicate.status, 0)
    assert.match(duplicate.stdout, /already-running/)
    assert.equal(await new Promise((resolve) => first.on('exit', resolve)), 0)
    const after = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' })
    assert.equal(after.status, 0)
  } finally {
    if (first.exitCode === null) first.kill('SIGTERM')
    await rm(dir, { recursive: true, force: true })
  }
})
