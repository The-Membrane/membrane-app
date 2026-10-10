import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const SCRIPT = resolve('scripts/carry-public-direct-exit-tick.sh')

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aave-frozen-q-tick-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const timeout = join(dir, 'timeout')
  const node = join(dir, 'node')
  const date = join(dir, 'date')
  const calls = join(dir, 'calls')
  await writeFile(timeout, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 })
  await writeFile(
    date,
    '#!/bin/sh\ncase "$1" in +%M) echo "${DIRECT_TEST_MINUTE:-20}" ;; +%S) echo 00 ;; esac\n',
    {
      mode: 0o700,
    },
  )
  await writeFile(
    node,
    `#!/bin/sh
printf '%s\n' "$1" >> "$DIRECT_TEST_CALLS"
case "$1" in
  *aave-usdc-fixed-q-v2-issue.mjs) printf '%s\n' '{"status":"no_eligible_fresh_v1_issue"}' ;;
  *aave-usdc-common-q-v3-issue.mjs) printf '%s\n' '{"status":"no_eligible_fresh_v1_issue"}' ;;
  *aave-usdc-common-q-v3-scores.mjs|*aave-usdc-fixed-q-v2-scores.mjs|*direct-exit-scores.mjs|*direct-exit-issue.mjs) : ;;
  *) exit 7 ;;
esac
`,
    { mode: 0o700 },
  )
  return { timeout, node, date, calls }
}

function tick(mode, env) {
  return spawnSync('/bin/sh', [SCRIPT, mode, '--locked'], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

test('score tick retries Aave frozen-Q issue and runs V2 before V1 under one lock', async (t) => {
  const f = await fixture(t)
  const result = tick('score', {
    PUBLIC_DIRECT_NODE_BIN: f.node,
    PUBLIC_DIRECT_TIMEOUT_BIN: f.timeout,
    PUBLIC_DIRECT_DATE_BIN: f.date,
    DIRECT_TEST_CALLS: f.calls,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /aave-frozen-q-issue:no-eligible/)
  assert.match(result.stdout, /score:ok/)
  assert.deepEqual(
    (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((path) => path.split('/').at(-1)),
    [
      'carry-public-aave-usdc-fixed-q-v2-issue.mjs',
      'record-carry-public-aave-usdc-fixed-q-v2-scores.mjs',
      'record-carry-public-direct-exit-scores.mjs',
    ],
  )
})

test('Aave issue tick creates the parent before attempting V2', async (t) => {
  const f = await fixture(t)
  const result = tick('issue-aave', {
    PUBLIC_DIRECT_NODE_BIN: f.node,
    PUBLIC_DIRECT_TIMEOUT_BIN: f.timeout,
    DIRECT_TEST_CALLS: f.calls,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((path) => path.split('/').at(-1)),
    ['carry-public-direct-exit-issue.mjs', 'carry-public-aave-usdc-fixed-q-v2-issue.mjs'],
  )
})

test('campaign Aave issue skips frozen Q and direct campaign score uses only V1 sweep', async (t) => {
  const f = await fixture(t)
  const env = {
    PUBLIC_DIRECT_NODE_BIN: f.node,
    PUBLIC_DIRECT_TIMEOUT_BIN: f.timeout,
    DIRECT_TEST_CALLS: f.calls,
  }
  const issued = tick('issue-aave-campaign', env)
  assert.equal(issued.status, 0, issued.stderr)
  const scored = tick('score-direct-campaign', env)
  assert.equal(scored.status, 0, scored.stderr)
  assert.deepEqual(
    (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((path) => path.split('/').at(-1)),
    ['carry-public-direct-exit-issue.mjs', 'record-carry-public-direct-exit-scores.mjs'],
  )
})

test('short score window preserves V1 sweep instead of deferring all scoring', async (t) => {
  const f = await fixture(t)
  const result = tick('score', {
    PUBLIC_DIRECT_NODE_BIN: f.node,
    PUBLIC_DIRECT_TIMEOUT_BIN: f.timeout,
    PUBLIC_DIRECT_DATE_BIN: f.date,
    DIRECT_TEST_MINUTE: '16',
    DIRECT_TEST_CALLS: f.calls,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((path) => path.split('/').at(-1)),
    ['record-carry-public-direct-exit-scores.mjs'],
  )
})

test('V3 remains dormant by default and enabled sweep follows V1/V2 without replacing them', async (t) => {
  const f = await fixture(t)
  const dormant = tick('issue-aave-common', {
    PUBLIC_DIRECT_NODE_BIN: f.node,
    PUBLIC_DIRECT_TIMEOUT_BIN: f.timeout,
    DIRECT_TEST_CALLS: f.calls,
  })
  assert.equal(dormant.status, 0, dormant.stderr)
  assert.match(dormant.stdout, /disabled/)
  const enabled = tick('score', {
    PUBLIC_AAVE_COMMON_Q_V3_ENABLED: '1',
    PUBLIC_DIRECT_NODE_BIN: f.node,
    PUBLIC_DIRECT_TIMEOUT_BIN: f.timeout,
    PUBLIC_DIRECT_DATE_BIN: f.date,
    DIRECT_TEST_MINUTE: '31',
    DIRECT_TEST_CALLS: f.calls,
  })
  assert.equal(enabled.status, 0, enabled.stderr)
  assert.deepEqual(
    (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((x) => x.split('/').at(-1)),
    [
      'carry-public-aave-usdc-fixed-q-v2-issue.mjs',
      'record-carry-public-aave-usdc-fixed-q-v2-scores.mjs',
      'record-carry-public-direct-exit-scores.mjs',
      'record-carry-public-aave-usdc-common-q-v3-scores.mjs',
    ],
  )
})

test('opt-in V3 issue mode uses the shared direct lock and bounded issuer', async (t) => {
  const f = await fixture(t)
  const result = tick('issue-aave-common', {
    PUBLIC_AAVE_COMMON_Q_V3_ENABLED: '1',
    PUBLIC_DIRECT_NODE_BIN: f.node,
    PUBLIC_DIRECT_TIMEOUT_BIN: f.timeout,
    DIRECT_TEST_CALLS: f.calls,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /aave-common-q-issue:no-eligible/)
  assert.equal(
    (await readFile(f.calls, 'utf8')).trim().split('/').at(-1),
    'carry-public-aave-usdc-common-q-v3-issue.mjs',
  )
})
