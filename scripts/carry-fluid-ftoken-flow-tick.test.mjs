import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./carry-fluid-ftoken-flow-tick.sh', import.meta.url))
const plist = fileURLToPath(
  new URL('./launchd/com.membrane.carry-fluid-ftoken-flows.plist', import.meta.url),
)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fluid-flow-tick-'))
  const trace = join(dir, 'trace')
  const node = join(dir, 'node')
  const timeout = join(dir, 'timeout')
  await writeFile(
    node,
    '#!/bin/sh\necho "$*" >> "$FLUID_FLOW_TEST_TRACE"\nif [ "${FLUID_FLOW_TEST_SLEEP-}" = 1 ]; then /bin/sleep 1; fi\nexit "${FLUID_FLOW_TEST_EXIT-0}"\n',
    { mode: 0o755 },
  )
  await writeFile(
    timeout,
    '#!/bin/sh\necho "$1 $2 $3" >> "$FLUID_FLOW_TEST_TRACE"\nshift 3\nexec "$@"\n',
    { mode: 0o755 },
  )
  return {
    dir,
    trace,
    env: {
      ...process.env,
      TMPDIR: dir,
      FLUID_FLOW_NODE_BIN: node,
      FLUID_FLOW_TIMEOUT_BIN: timeout,
      FLUID_FLOW_TEST_TRACE: trace,
    },
  }
}

test('launchd job stays unloaded at creation and runs every six minutes', () => {
  assert.equal(spawnSync('/bin/sh', ['-n', script]).status, 0)
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plist]).status, 0)
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
    encoding: 'utf8',
  })
  assert.equal(parsed.status, 0)
  const job = JSON.parse(parsed.stdout)
  assert.equal(job.Label, 'com.membrane.carry-fluid-ftoken-flows')
  assert.equal(job.RunAtLoad, false)
  assert.equal(job.StartInterval, 360)
  assert.deepEqual(job.ProgramArguments, ['/bin/sh', script])
})

test('tick uses the bounded heap, timeout, and exact capture command', async () => {
  const { dir, trace, env } = await fixture()
  try {
    const result = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /carry-fluid-ftoken-flow:ok/)
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), [
      '-k 5s 250s',
      '--max-old-space-size=384 scripts/research/fluid-ftoken-gross-flow.mjs --capture-next',
    ])
    const failure = spawnSync('/bin/sh', [script], {
      env: { ...env, FLUID_FLOW_TEST_EXIT: '7' },
      encoding: 'utf8',
    })
    assert.equal(failure.status, 7)
    assert.match(failure.stderr, /failed \(exit 7\)/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('advisory lock skips an overlapping tick and releases on completion', async () => {
  const { dir, trace, env } = await fixture()
  const first = spawn('/bin/sh', [script], {
    env: { ...env, FLUID_FLOW_TEST_SLEEP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    let started = false
    for (let i = 0; i < 100; i++) {
      try {
        started = (await readFile(trace, 'utf8')).length > 0
        if (started) break
      } catch {
        // The first tick has not invoked timeout yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(started, true)
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
