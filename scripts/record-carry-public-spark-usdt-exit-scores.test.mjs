import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DIRECT_MARKETS } from './research/carry-public-direct-exit-issue.mjs'
import {
  runSparkPublicDirectScoreSweep,
  selectSparkPublicDirectEvidence,
  sparkPublicDirectIssueScorable,
} from './record-carry-public-spark-usdt-exit-scores.mjs'

const wrapper = join(import.meta.dirname, 'carry-public-direct-exit-tick.sh')
const route = DIRECT_MARKETS.sparkLendUsdt
const urls = [
  'https://first.example/key',
  'https://second.example/key',
  'https://third.example/key',
]

function issue(
  sequence,
  { marketKey = 'sparkLendUsdt', targetAtUtc = '2026-10-04T06:00:00.000Z', eligible = true } = {},
) {
  const identity = marketKey === 'sparkLendUsdt' ? route : DIRECT_MARKETS.aaveV3Usdc
  return {
    sequence,
    marketKey,
    routeKey: identity.routeKey,
    destination: identity.destination,
    originalAsset: identity.asset,
    baseline: { canonicalityEvidenceDoc: { provider: 'https://third.example' } },
    baselineWitness: { provider: 'https://first.example' },
    cases: eligible
      ? [{ status: 'measured', measurement: { status: 'success' } }]
      : [{ status: 'unavailable' }],
    targets: [
      {
        horizonHours: 1,
        targetAtUtc,
        captureDeadlineUtc: new Date(Date.parse(targetAtUtc) + 2 * 3_600_000).toISOString(),
      },
    ],
  }
}

test('Spark selector isolates the exact frozen USDT market and its scored targets', () => {
  const selected = selectSparkPublicDirectEvidence(
    [issue(1, { marketKey: 'aaveV3Usdc' }), issue(2), issue(3)],
    [
      { issueSequence: 1, horizonHours: 1, marketKey: 'aaveV3Usdc' },
      { issueSequence: 2, horizonHours: 1, marketKey: 'sparkLendUsdt', routeKey: route.routeKey },
    ],
  )
  assert.deepEqual(
    selected.issues.map((row) => row.sequence),
    [2, 3],
  )
  assert.deepEqual(
    selected.scores.map((row) => row.issueSequence),
    [2],
  )
  assert.throws(
    () =>
      selectSparkPublicDirectEvidence(
        [{ ...issue(2), originalAsset: DIRECT_MARKETS.aaveV3Usdc.asset }],
        [],
      ),
    /spark_public_issue_identity_invalid/,
  )
  assert.throws(
    () =>
      selectSparkPublicDirectEvidence([issue(2)], [{ issueSequence: 2, marketKey: 'aaveV3Usdc' }]),
    /spark_public_score_identity_invalid/,
  )
})

test('Spark sweep attempts live eligible USDT cells before expired censors and never scores Aave', async () => {
  const selected = []
  const baselineRevert = issue(5)
  baselineRevert.cases = [{ status: 'measured', measurement: { status: 'revert' } }]
  assert.equal(sparkPublicDirectIssueScorable(baselineRevert), false)
  assert.equal(sparkPublicDirectIssueScorable(issue(3)), true)
  const summary = await runSparkPublicDirectScoreSweep({
    issues: [
      issue(1, { marketKey: 'aaveV3Usdc' }),
      issue(2, { targetAtUtc: '2026-10-03T00:00:00.000Z' }),
      issue(3, { targetAtUtc: '2026-10-04T06:00:00.000Z' }),
      issue(4, { targetAtUtc: '2026-10-04T06:00:00.000Z', eligible: false }),
      baselineRevert,
    ],
    scores: [],
    urls,
    now: () => new Date('2026-10-04T06:01:00.000Z'),
    clientsFor: (pair) => pair,
    score: async ({ issueSequence }) => {
      selected.push(issueSequence)
      return { status: 'scored' }
    },
  })
  assert.deepEqual(selected, [3, 2])
  assert.equal(summary.attempted, 2)
  assert.equal(summary.scored, 2)
  assert.equal(summary.skippedNoBaseline, 2)
})

test('Spark campaign wrapper runs only Spark issuer/scorer with bounded timeout and heap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-campaign-wrapper-'))
  const timeout = join(dir, 'timeout')
  const calls = join(dir, 'calls')
  writeFileSync(
    timeout,
    '#!/bin/sh\nprintf "%s\\n" "$*|$NODE_OPTIONS" >> "$SPARK_TEST_CALLS"\nexit 0\n',
    { mode: 0o700 },
  )
  const env = {
    ...process.env,
    TMPDIR: dir,
    PUBLIC_DIRECT_TIMEOUT_BIN: timeout,
    PUBLIC_DIRECT_NODE_BIN: '/bin/true',
    SPARK_TEST_CALLS: calls,
  }
  try {
    for (const mode of ['issue-spark-campaign', 'score-spark-campaign']) {
      const result = spawnSync('/bin/sh', [wrapper, mode, '--locked'], { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), `public-direct-exit:${mode}:ok`)
    }
    const [issued, scored] = readFileSync(calls, 'utf8').trim().split('\n')
    assert.match(
      issued,
      /-k 5s 540s .*carry-public-direct-exit-issue\.mjs --issue sparkLendUsdt\|--max-old-space-size=384$/,
    )
    assert.match(
      scored,
      /-k 5s 360s .*record-carry-public-spark-usdt-exit-scores\.mjs --sweep\|--max-old-space-size=384$/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('campaign Spark issue and score lock contention report failure rather than successful work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spark-campaign-busy-'))
  const lock = join(dir, 'membrane-public-direct-exit.lock')
  const python = [
    'import fcntl, os, subprocess, sys',
    'fd=os.open(sys.argv[1], os.O_CREAT|os.O_RDWR, 0o600)',
    'fcntl.flock(fd, fcntl.LOCK_EX)',
    'child=subprocess.run(["/bin/sh", sys.argv[2], sys.argv[3]], env=os.environ, capture_output=True, text=True)',
    'print(child.stdout.strip())',
    'print(child.stderr.strip(), file=sys.stderr)',
    'sys.exit(child.returncode)',
  ].join('; ')
  try {
    for (const mode of ['issue-spark-campaign', 'score-spark-campaign']) {
      const result = spawnSync('/usr/bin/python3', ['-c', python, lock, wrapper, mode], {
        env: { ...process.env, TMPDIR: dir },
        encoding: 'utf8',
      })
      assert.equal(result.status, 75, result.stderr)
      assert.equal(result.stderr.trim(), 'public-direct-exit:busy')
      assert.equal(result.stdout.trim(), '')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
