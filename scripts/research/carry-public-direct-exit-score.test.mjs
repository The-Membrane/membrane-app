import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freezeDirectQLadder } from '../lib/carry-exit-v2-direct-issuer-prep.mjs'
import {
  appendPublicDirectIssue,
  buildPublicDirectIssue,
  DIRECT_MARKETS,
} from './carry-public-direct-exit-issue.mjs'
import {
  appendPublicDirectScore,
  buildPublicDirectScore,
  classifyPublicDirectExitOutcome,
  publicScoreUrlsForIssue,
  scorePublicDirectExit,
  selectMatchingPublicDirectTarget,
  verifyPublicDirectScores,
} from './carry-public-direct-exit-score.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const HASH = `0x${'a'.repeat(64)}`
const HOLDER = `0x${'b'.repeat(40)}`
const ISSUED = '2026-09-30T06:15:00.000Z'

test('manual scoring uses the origins sealed in the issue, not config order', () => {
  const issue = fixture()
  const urls = [
    'https://unrelated.example/key',
    'https://origin-two.example/key',
    'https://origin-one.example/key',
  ]
  assert.deepEqual(publicScoreUrlsForIssue(issue, urls), [urls[2], urls[1]])
  assert.throws(
    () => publicScoreUrlsForIssue(issue, urls.slice(0, 2)),
    /score_issue_origins_unconfigured/,
  )
})

function fixture() {
  const route = DIRECT_MARKETS.aaveV3Usdc
  const baseline = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    kind: route.kind,
    targetBlock: '26080000',
    targetHash: HASH,
    targetParentHash: `0x${'c'.repeat(64)}`,
    targetBlockAt: '2026-09-30T06:05:00.000Z',
    targetObservedAt: '2026-09-30T06:10:00.000Z',
    marketSupplyRaw: '1000000',
    assetDecimals: 6,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      provider: 'https://origin-one.example',
      observedAt: '2026-09-30T06:10:00.000Z',
      targetHeader: { number: '26080000', hash: HASH },
    },
  }
  const ladder = freezeDirectQLadder({
    marketSupplyRaw: baseline.marketSupplyRaw,
    selectedAssetBalanceRaw: '500',
  })
  const candidate = {
    holder: HOLDER,
    evidenceDoc: {
      schema: 'carry_exit_v2_direct_candidate_v1',
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      baselineBlock: baseline.targetBlock,
      baselineHash: HASH,
      parentHash: baseline.targetParentHash,
      baselineState: {
        marketSupplyRaw: baseline.marketSupplyRaw,
        assetDecimals: baseline.assetDecimals,
      },
      selectedHolderCommitment: sha(`${route.destination}:${HOLDER}`),
      selectedAssetBalanceRaw: '500',
      ladder,
    },
  }
  const baselineWitness = {
    provider: 'https://origin-two.example',
    block: baseline.targetBlock,
    hash: HASH,
    marketSupplyRaw: baseline.marketSupplyRaw,
    assetDecimals: 6,
    underlying: route.asset,
    observedAtUtc: '2026-09-30T06:12:00.000Z',
  }
  return buildPublicDirectIssue({
    marketKey: 'aaveV3Usdc',
    baseline,
    baselineWitness,
    candidate,
    measurements: {},
    issuedAtUtc: ISSUED,
    sequence: 1,
    previousSha256: null,
  })
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'public-direct-score-'))
  const issueOut = join(root, 'issues')
  const out = join(root, 'scores')
  const issue = fixture()
  await appendPublicDirectIssue(issue, issueOut, () => ({ bavail: 1_000_000, bsize: 4096 }))
  return { root, issueOut, out, issue }
}

const clients = [
  { provider: 'https://origin-one.example', request: async () => {}, send: async () => {} },
  { provider: 'https://origin-two.example', request: async () => {}, send: async () => {} },
]

test('does not inspect or publish an outcome before the frozen future target', async () => {
  const { root, issueOut, out } = await setup()
  try {
    let selectCalls = 0
    const result = await scorePublicDirectExit({
      issueSequence: 1,
      horizonHours: 1,
      clients,
      issueOut,
      out,
      now: () => new Date('2026-09-30T07:14:59.000Z'),
      select: async () => {
        selectCalls++
        throw Error('should_not_select')
      },
    })
    assert.equal(result.status, 'not_due')
    assert.equal(selectCalls, 0)
    assert.deepEqual(await verifyPublicDirectScores(out, issueOut), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two origins disagreeing on exact first future block fail closed', async () => {
  const issue = fixture()
  let calls = 0
  await assert.rejects(
    selectMatchingPublicDirectTarget({
      issue,
      plan: issue.targets[0],
      clients,
      select: async () => ({
        targetBlock: '26080300',
        targetHash: `0x${String(++calls).padStart(64, '0')}`,
        targetBlockAt: '2026-09-30T07:15:00.000Z',
        targetParentHash: HASH,
        targetParentBlockAt: '2026-09-30T07:14:48.000Z',
      }),
    }),
    /score_target_disagreement/,
  )
})

test('an issue with no positive baseline never emits success, negative, or a score', async () => {
  const { root, issueOut, out } = await setup()
  try {
    const result = await scorePublicDirectExit({
      issueSequence: 1,
      horizonHours: 1,
      clients,
      issueOut,
      out,
      now: () => new Date('2026-09-30T07:30:00.000Z'),
      select: async () => {
        throw Error('should_not_select')
      },
    })
    assert.equal(result.status, 'no_eligible_baseline')
    assert.deepEqual(await verifyPublicDirectScores(out, issueOut), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a run after deadline does not retrospectively inspect RPC and seals a censored row', async () => {
  const issue = fixture()
  issue.cases[0] = {
    ...issue.cases[0],
    status: 'measured',
    reason: null,
    measurement: { status: 'success' },
  }
  let rpcCalls = 0
  let saved
  const result = await scorePublicDirectExit({
    issueSequence: 1,
    horizonHours: 1,
    clients,
    now: () => new Date('2026-09-30T09:16:00.000Z'),
    loadIssues: async () => [issue],
    loadScores: async () => [],
    select: async () => {
      rpcCalls++
      throw Error('late_rpc_forbidden')
    },
    capture: async () => {
      rpcCalls++
      throw Error('late_rpc_forbidden')
    },
    append: async (score) => {
      saved = score
      return { sequence: score.sequence }
    },
  })
  assert.equal(result.status, 'scored')
  assert.equal(rpcCalls, 0)
  assert.equal(saved.target, null)
  assert.equal(saved.onTime, false)
  assert.equal(saved.cases[0].status, 'unavailable')
  assert.equal(saved.cases[0].reason, 'capture_window_missed')
  assert.equal(saved.cases[0].outcome, null)
})

test('a capture crossing the deadline is discarded and cannot become a measured outcome', async () => {
  const issue = fixture()
  issue.cases[0] = {
    ...issue.cases[0],
    status: 'measured',
    reason: null,
    measurement: { status: 'success' },
  }
  let clockCalls = 0
  const now = () =>
    new Date(++clockCalls < 3 ? '2026-09-30T07:30:00.000Z' : '2026-09-30T09:16:00.000Z')
  let selected = 0
  let captured = 0
  let saved
  await scorePublicDirectExit({
    issueSequence: 1,
    horizonHours: 1,
    clients,
    now,
    loadIssues: async () => [issue],
    loadScores: async () => [],
    select: async () => {
      selected++
      return {
        targetBlock: '26080300',
        targetHash: HASH,
        targetBlockAt: '2026-09-30T07:15:00.000Z',
        targetParentHash: HASH,
        targetParentBlockAt: '2026-09-30T07:14:48.000Z',
      }
    },
    capture: async () => {
      captured++
      return { simulationStatus: 'success' }
    },
    append: async (score) => {
      saved = score
      return { sequence: score.sequence }
    },
  })
  assert.equal(selected, 2)
  assert.equal(captured, 0)
  assert.equal(saved.target, null)
  assert.equal(saved.cases[0].status, 'unavailable')
  assert.throws(
    () =>
      buildPublicDirectScore({
        issue,
        issues: [issue],
        horizonHours: 1,
        target: {},
        measurements: { [issue.cases[0].label]: { simulationStatus: 'success' } },
        scoredAtUtc: '2026-09-30T09:16:00.000Z',
        sequence: 1,
        previousSha256: null,
      }),
    /score_late_measurement_invalid/,
  )
})

test('covered revert is cause unknown, not attributed to a venue', () => {
  assert.equal(
    classifyPublicDirectExitOutcome({ simulationStatus: 'evm_revert', coveredRevert: true }),
    'exit_revert_cause_unknown',
  )
  assert.equal(
    classifyPublicDirectExitOutcome({ simulationStatus: 'evm_revert', coveredRevert: false }),
    'holder_attrition',
  )
  assert.equal(
    classifyPublicDirectExitOutcome({ simulationStatus: 'success', coveredRevert: false }),
    'exit_success',
  )
})

test('late unavailable record publishes atomically; failed link and stale stage do not poison continuation', async () => {
  const { root, issueOut, out, issue } = await setup()
  try {
    const score = buildPublicDirectScore({
      issue,
      issues: [issue],
      horizonHours: 1,
      target: null,
      measurements: {},
      scoredAtUtc: '2026-09-30T09:16:00.000Z',
      sequence: 1,
      previousSha256: null,
    })
    await assert.rejects(
      appendPublicDirectScore(score, out, issueOut, () => ({ bavail: 1_000_000, bsize: 4096 }), {
        linkFile: async () => {
          throw Error('interrupted_before_publish')
        },
      }),
      /interrupted_before_publish/,
    )
    assert.deepEqual(await verifyPublicDirectScores(out, issueOut), [])
    assert.equal(
      (await readdir(out)).some((name) => name.endsWith('.json')),
      false,
    )
    await writeFile(join(out, '.score-interrupted.tmp'), 'partial')
    await appendPublicDirectScore(score, out, issueOut, () => ({ bavail: 1_000_000, bsize: 4096 }))
    const verified = await verifyPublicDirectScores(out, issueOut)
    assert.equal(verified.length, 1)
    assert.equal(verified[0].onTime, false)
    assert.ok(verified[0].cases.every((row) => row.status === 'ineligible'))
    const path = join(out, '00000001.json')
    const tampered = JSON.parse(await readFile(path, 'utf8'))
    tampered.onTime = true
    const { sha256: _prior, ...body } = tampered
    tampered.sha256 = sha(JSON.stringify(body))
    await writeFile(path, `${JSON.stringify(tampered)}\n`)
    await assert.rejects(verifyPublicDirectScores(out, issueOut), /score_clock_invalid/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('forged measured evidence with a correct local hash is rejected', () => {
  const issue = fixture()
  issue.cases[0] = {
    ...issue.cases[0],
    status: 'measured',
    reason: null,
    measurement: { status: 'success' },
  }
  const target = {
    targetBlock: '26080300',
    targetHash: HASH,
    targetBlockAt: '2026-09-30T07:15:00.000Z',
    targetParentBlock: '26080299',
    targetParentHash: `0x${'c'.repeat(64)}`,
    targetParentBlockAt: '2026-09-30T07:14:48.000Z',
    targetObservedAt: '2026-09-30T07:30:00.000Z',
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      chainId: '1',
      finalityTag: 'finalized',
      targetAt: '2026-09-30T07:15:00.000Z',
      observedAt: '2026-09-30T07:30:00.000Z',
      targetHeader: {
        number: '26080300',
        hash: HASH,
        parentHash: `0x${'c'.repeat(64)}`,
        timestamp: '2026-09-30T07:15:00.000Z',
      },
      parentHeader: {
        number: '26080299',
        hash: `0x${'c'.repeat(64)}`,
        timestamp: '2026-09-30T07:14:48.000Z',
      },
    },
  }
  const fakeEvidence = {
    verificationStatus: 'verified',
    identityEvidence: {
      holder: HOLDER,
      asset: issue.originalAsset,
      destination: issue.destination,
      blockNumber: target.targetBlock,
      blockHash: target.targetHash,
    },
    replayEvidenceDoc: { blockNumber: target.targetBlock, blockHash: target.targetHash },
  }
  const measurements = {
    [issue.cases[0].label]: {
      simulationStatus: 'success',
      holderCoverageRaw: '500',
      actualConsumedRaw: null,
      coveredRevert: false,
      evidence: fakeEvidence,
      evidenceSha256: sha(JSON.stringify(fakeEvidence)),
    },
  }
  assert.throws(() =>
    buildPublicDirectScore({
      issue,
      issues: [issue],
      horizonHours: 1,
      target,
      measurements,
      scoredAtUtc: '2026-09-30T07:30:00.000Z',
      sequence: 1,
      previousSha256: null,
    }),
  )
})
