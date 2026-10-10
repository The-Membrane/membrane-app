import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const WRAPPER = resolve('scripts/carry-local-cash-tick.sh')
const PLIST = resolve('scripts/launchd/com.membrane.carry-local-cash.plist')
const LEGACY_ORDER = [
  'scripts/record-carry-cash-local.mjs --current',
  'scripts/lib/carryLocalCashTickGate.mjs',
  'scripts/record-supplemental-aave-usde-cash-local.mjs --current',
  'scripts/record-carry-cash-local-model.mjs --register',
  'scripts/record-carry-cash-local-issues.mjs --issue',
  'scripts/record-carry-cash-local-model.mjs --issue',
  'scripts/record-carry-cash-local-issues.mjs --score',
  'scripts/record-carry-cash-local-model.mjs --score',
]
const V2_SCORES = [
  'scripts/record-carry-cash-prospective-v2.mjs --score',
  'scripts/record-carry-cash-vault5-v2.mjs --score',
]
const V2_ORDER = [
  ...V2_SCORES,
  'scripts/record-carry-cash-prospective-v2.mjs --tick',
  'scripts/record-carry-cash-vault5-v2.mjs --tick',
]
const ORDER = [...LEGACY_ORDER, ...V2_ORDER]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'carry-cash-tick-test-'))
  const node = join(root, 'node')
  const timeout = join(root, 'timeout')
  const trace = join(root, 'trace')
  writeFileSync(
    node,
    `#!/bin/sh
script=''
mode=''
for arg in "$@"; do
  case "$arg" in scripts/*) script=$arg;; --register|--current|--tick|--issue|--score) mode=$arg;; esac
done
printf 'N %s %s\\n' "$script" "$mode" >> "$CARRY_TEST_TRACE"
if [ "$script $mode" = "$CARRY_TEST_FAIL" ]; then exit 1; fi
if [ "$script" = scripts/record-carry-cash-local.mjs ]; then printf '{"status":"recorded"}\\n'; fi
exit 0
`,
  )
  writeFileSync(
    timeout,
    `#!/bin/sh
printf 'T %s\\n' "$3" >> "$CARRY_TEST_TRACE"
shift 3
exec "$@"
`,
  )
  chmodSync(node, 0o700)
  chmodSync(timeout, 0o700)
  return { root, node, timeout, trace }
}

function run(f, failure = '', { enableV2 = true, enableExitV2 = false } = {}) {
  let status = 0
  let output = ''
  const env = {
    ...process.env,
    CARRY_CASH_NODE_BIN: f.node,
    CARRY_CASH_TIMEOUT_BIN: f.timeout,
    CARRY_TEST_TRACE: f.trace,
    CARRY_TEST_FAIL: failure,
    TMPDIR: f.root,
  }
  delete env.CARRY_CASH_EXIT_V2_ENABLED
  if (enableExitV2) env.CARRY_CASH_EXIT_V2_ENABLED = '1'
  delete env.CARRY_CASH_V2_ENABLED
  if (enableV2) env.CARRY_CASH_V2_ENABLED = '1'
  try {
    output = execFileSync('/bin/sh', [WRAPPER, '--locked'], {
      cwd: resolve('.'),
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    })
  } catch (error) {
    status = error.status
    output = `${error.stdout || ''}${error.stderr || ''}`
  }
  const calls = readFileSync(f.trace, 'utf8').trim().split('\n')
  return {
    status,
    output,
    nodes: calls.filter((row) => row.startsWith('N ')).map((row) => row.slice(2).trim()),
    timeouts: calls.filter((row) => row.startsWith('T ')).map((row) => row.slice(2)),
  }
}

test('native cash tick uses the exact ordered command sequence', () => {
  const f = fixture()
  try {
    const result = run(f)
    assert.equal(result.status, 0)
    assert.deepEqual(result.nodes, ORDER)
    assert.equal(result.timeouts.length, ORDER.length - 1)
    assert.deepEqual(result.timeouts.slice(-V2_ORDER.length), ['120s', '120s', '120s', '120s'])
    const finalLegacyModelScore = result.nodes.indexOf(
      'scripts/record-carry-cash-local-model.mjs --score',
    )
    assert.equal(finalLegacyModelScore, LEGACY_ORDER.length - 1)
    assert.equal(
      result.nodes
        .slice(0, finalLegacyModelScore + 1)
        .some((command) => command.includes('-v2.mjs')),
      false,
    )
    assert.equal(
      result.nodes.includes('scripts/record-carry-cash-prospective-v2.mjs --issue'),
      false,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('v2 stages default off while the exact legacy chain continues', () => {
  const f = fixture()
  try {
    const result = run(f, '', { enableV2: false })
    assert.equal(result.status, 0)
    assert.deepEqual(result.nodes, LEGACY_ORDER)
    assert.equal(result.timeouts.length, LEGACY_ORDER.length - 1)
    assert.equal(
      result.nodes.some((command) => command.includes('-v2.mjs')),
      false,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('launchd permits added stages while staying below the 30-minute cadence', () => {
  const plist = readFileSync(PLIST, 'utf8')
  assert.match(plist, /<string>1750s<\/string>/)
  assert.doesNotMatch(plist, /<string>390s<\/string>/)
  assert.match(plist, /<key>CARRY_CASH_V2_ENABLED<\/key>\s*<string>1<\/string>/)
  assert.match(plist, /<key>Minute<\/key><integer>15<\/integer>/)
  assert.match(plist, /<key>Minute<\/key><integer>45<\/integer>/)
})

test('two-subject score failure follows the legacy chain and preserves later v2 stages', () => {
  const f = fixture()
  try {
    const result = run(f, 'scripts/record-carry-cash-prospective-v2.mjs --score')
    assert.equal(result.status, 1)
    assert.equal(result.nodes.includes('scripts/record-carry-cash-vault5-v2.mjs --score'), true)
    assert.equal(result.nodes.includes('scripts/record-carry-cash-prospective-v2.mjs --tick'), true)
    assert.equal(result.nodes.includes('scripts/record-carry-cash-vault5-v2.mjs --tick'), true)
    assert.deepEqual(result.nodes.slice(0, LEGACY_ORDER.length), LEGACY_ORDER)
    assert.deepEqual(result.nodes, ORDER)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('two-subject tick failure follows the legacy chain and preserves the Vault5 tick', () => {
  const f = fixture()
  try {
    const result = run(f, 'scripts/record-carry-cash-prospective-v2.mjs --tick')
    assert.equal(result.status, 1)
    assert.equal(result.nodes.includes('scripts/record-carry-cash-vault5-v2.mjs --tick'), true)
    assert.deepEqual(result.nodes.slice(0, LEGACY_ORDER.length), LEGACY_ORDER)
    assert.deepEqual(result.nodes, ORDER)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('model registration failure completes remaining legacy work before the v2 tail', () => {
  const f = fixture()
  try {
    const result = run(f, 'scripts/record-carry-cash-local-model.mjs --register')
    assert.equal(result.status, 1)
    assert.deepEqual(
      result.nodes,
      ORDER.filter(
        (command) =>
          command !== 'scripts/record-carry-cash-local-issues.mjs --issue' &&
          command !== 'scripts/record-carry-cash-local-model.mjs --issue' &&
          command !== 'scripts/record-carry-cash-local-model.mjs --score',
      ),
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('supplemental capture failure completes the legacy chain before the v2 tail', () => {
  const f = fixture()
  try {
    const result = run(f, 'scripts/record-supplemental-aave-usde-cash-local.mjs --current')
    assert.equal(result.status, 1)
    assert.equal(result.nodes.includes('scripts/record-carry-cash-local-issues.mjs --issue'), true)
    assert.deepEqual(result.nodes.slice(0, LEGACY_ORDER.length), LEGACY_ORDER)
    assert.deepEqual(result.nodes, ORDER)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('frozen capture failure completes legacy scoring before reaching v2', () => {
  const f = fixture()
  try {
    const result = run(f, 'scripts/record-carry-cash-local.mjs --current')
    assert.equal(result.status, 1)
    assert.equal(result.nodes.includes('scripts/record-carry-cash-local-issues.mjs --issue'), false)
    assert.deepEqual(
      result.nodes,
      ORDER.filter(
        (command) =>
          command !== 'scripts/lib/carryLocalCashTickGate.mjs' &&
          command !== 'scripts/record-carry-cash-local-issues.mjs --issue',
      ),
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

const EXIT_ORDER = [
  'scripts/research/carry-local-exit-v2-no-neon-issue.mjs --tick',
  'scripts/research/carry-local-exit-v2-tick.mjs --tick',
]

test('exit v2 defaults off and runs issuer then scorer before capture when enabled', () => {
  const f = fixture()
  try {
    const result = run(f, '', { enableExitV2: true })
    assert.equal(result.status, 0)
    assert.deepEqual(result.nodes, [...EXIT_ORDER, ...ORDER])
    assert.deepEqual(result.timeouts.slice(0, 2), ['90s', '120s'])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

for (const [index, command] of EXIT_ORDER.entries()) {
  test(`exit v2 stage ${index + 1} failure emits marker and continues every later stage`, () => {
    const f = fixture()
    try {
      const result = run(f, command, { enableExitV2: true })
      assert.equal(result.status, 1)
      assert.deepEqual(result.nodes, [...EXIT_ORDER, ...ORDER])
      assert.ok(
        result.output.includes(
          `carry-local-cash:exit-v2-${index === 0 ? 'issue' : 'score'}-failed`,
        ),
      )
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
}

test('same launchd job retains cadence and accommodates all stage budgets and grace', () => {
  const plist = readFileSync(PLIST, 'utf8')
  const wrapper = readFileSync(WRAPPER, 'utf8')
  assert.equal((plist.match(/<key>Label<\/key>/g) || []).length, 1)
  assert.match(plist, /<string>com.membrane.carry-local-cash<\/string>/)
  assert.match(plist, /<key>CARRY_CASH_EXIT_V2_ENABLED<\/key>\s*<string>1<\/string>/)
  const outer = Number(plist.match(/<string>(\d+)s<\/string>\s*<string>\/bin\/sh<\/string>/)[1])
  const budgets = [...wrapper.matchAll(/if run_stage (\d+)s /g)].map((match) => Number(match[1]))
  assert.ok(budgets.reduce((sum, seconds) => sum + seconds + 5, 0) < outer)
  assert.ok(outer + 5 < 1800)
  assert.match(wrapper, /1024 \* 1024 \* 1024/)
})

test('held nonblocking lock rejects invocation before any stage', () => {
  const f = fixture()
  try {
    const output = execFileSync(
      '/usr/bin/python3',
      [
        '-c',
        `
import fcntl, os, subprocess, sys
fd = os.open(os.path.join(sys.argv[2], 'membrane-carry-local-cash-tick.lock'), os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
result = subprocess.run(['/bin/sh', sys.argv[1]], capture_output=True, text=True)
assert result.returncode == 1, result
assert 'carry-local-cash:tick-lock-busy' in result.stderr, result
print('lock-rejected')
`,
        WRAPPER,
        f.root,
      ],
      { env: { ...process.env, TMPDIR: f.root }, encoding: 'utf8' },
    )
    assert.match(output, /lock-rejected/)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
