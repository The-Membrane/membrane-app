import assert from 'node:assert/strict'
import test from 'node:test'

import {
  eligibleAaveParent,
  followedAaveCases,
  issueAaveFrozenQ,
  validateAaveFrozenQIssue,
} from './carry-public-aave-usdc-fixed-q-v2-issue.mjs'
import {
  classifyAaveFrozenQOutcome,
  classifyAaveFrozenQTransition,
  scoreAaveFrozenQ,
  validateAaveFrozenQScore,
  verifyAaveFrozenQMeasurement,
} from './carry-public-aave-usdc-fixed-q-v2-score.mjs'
import {
  MAX_PAIRS_PER_PLAN,
  fairAaveFrozenQPlans,
  pendingAaveFrozenQPlans,
  runAaveFrozenQSweep,
  selectAaveFrozenQPairs,
} from '../record-carry-public-aave-usdc-fixed-q-v2-scores.mjs'
import { sha } from './carry-public-sgho-exit-common.mjs'

const H = `0x${'1'.repeat(40)}`
const parent = {
  sequence: 1,
  sha256: 'a'.repeat(64),
  marketKey: 'aaveV3Usdc',
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  originalAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  candidate: { holder: H },
  issuedAtUtc: '2026-10-01T00:10:00.000Z',
  baseline: { targetBlockAt: '2026-10-01T00:00:00.000Z' },
  targets: [
    {
      horizonHours: 1,
      targetAtUtc: '2026-10-01T01:10:00.000Z',
      captureDeadlineUtc: '2026-10-01T03:10:00.000Z',
    },
    {
      horizonHours: 4,
      targetAtUtc: '2026-10-01T04:10:00.000Z',
      captureDeadlineUtc: '2026-10-01T06:10:00.000Z',
    },
  ],
  cases: [
    {
      label: 'small',
      assetsRaw: '1000000',
      status: 'measured',
      measurement: { status: 'success', holderCoverageRaw: '5000000', coveredRevert: false },
    },
    {
      label: 'impaired',
      assetsRaw: '3000000',
      status: 'measured',
      measurement: { status: 'evm_revert', holderCoverageRaw: '5000000', coveredRevert: true },
    },
    {
      label: 'attrited',
      assetsRaw: '8000000',
      status: 'measured',
      measurement: { status: 'evm_revert', holderCoverageRaw: '5000000', coveredRevert: false },
    },
  ],
}

test('follows exact V1 success and genuinely covered revert amounts, excluding insufficient coverage', () => {
  assert.deepEqual(followedAaveCases(parent), [
    { label: 'small', assetsRaw: '1000000', baselineStatus: 'success' },
    { label: 'impaired', assetsRaw: '3000000', baselineStatus: 'covered_revert' },
  ])
  assert.equal(eligibleAaveParent(parent, '2026-10-01T00:20:00.000Z'), true)
  assert.equal(eligibleAaveParent(parent, '2026-10-01T00:46:00.000Z'), false)
  assert.equal(eligibleAaveParent(parent, '2026-10-01T01:10:00.000Z'), false)
})

test('issue binds original parent, all eligible exact Q cases and original horizon clock', async () => {
  const issued = await issueAaveFrozenQ({
    now: () => new Date('2026-10-01T00:20:00.000Z'),
    loadParents: async () => [parent],
    load: async () => [],
    append: async (row) => {
      assert.equal(validateAaveFrozenQIssue(row, [parent]), row)
      assert.equal(row.cases.length, 2)
      assert.deepEqual(row.targets, parent.targets)
      assert.throws(
        () => validateAaveFrozenQIssue({ ...row, cases: row.cases.slice(0, 1) }, [parent]),
        /binding_invalid/,
      )
      assert.throws(
        () => validateAaveFrozenQIssue({ ...row, holder: `0x${'2'.repeat(40)}` }, [parent]),
        /binding_invalid/,
      )
      return { sequence: row.sequence }
    },
  })
  assert.equal(issued.status, 'issued')
  assert.equal(issued.sequence, 1)
})

test('outcomes separate recovery, continued exit, restricted exit and holder attrition', () => {
  const success = { routeKind: 'aave', simulationStatus: 'success' }
  const revert = {
    routeKind: 'aave',
    simulationStatus: 'evm_revert',
    holderCoverageRaw: '3000000',
    coveredRevert: true,
  }
  const depleted = { ...revert, holderCoverageRaw: '2999999', coveredRevert: false }
  assert.equal(
    classifyAaveFrozenQTransition('covered_revert', classifyAaveFrozenQOutcome(success, '3000000')),
    'simulated_recovery',
  )
  assert.equal(
    classifyAaveFrozenQTransition('covered_revert', classifyAaveFrozenQOutcome(revert, '3000000')),
    'still_reverting',
  )
  assert.equal(
    classifyAaveFrozenQTransition('success', classifyAaveFrozenQOutcome(revert, '3000000')),
    'lost_exitability',
  )
  assert.equal(
    classifyAaveFrozenQTransition('success', classifyAaveFrozenQOutcome(depleted, '3000000')),
    'holder_attrition',
  )
})

test('covered baseline revert receives all due targets and no read before horizon', async () => {
  const issue = { sequence: 1, v1IssueSequence: 1, targets: parent.targets }
  assert.deepEqual(
    pendingAaveFrozenQPlans([issue], [], '2026-10-01T04:20:00.000Z').map((x) => x.horizonHours),
    [4, 1],
  )
  const result = await scoreAaveFrozenQ({
    issueSequence: 1,
    horizonHours: 1,
    originPairs: [],
    now: () => new Date('2026-10-01T00:50:00.000Z'),
    loadIssues: async () => [issue],
    loadParents: async () => [parent],
    loadScores: async () => [],
    select: async () => {
      throw Error('future_read')
    },
  })
  assert.equal(result.status, 'not_due')
})

test('due replay retry reports a bounded target failure category', async () => {
  const issue = { sequence: 1, v1IssueSequence: 1, targets: parent.targets, cases: [] }
  const result = await scoreAaveFrozenQ({
    issueSequence: 1,
    horizonHours: 1,
    originPairs: [
      [
        { provider: 'one', request() {} },
        { provider: 'two', request() {} },
      ],
    ],
    now: () => new Date('2026-10-01T01:20:00.000Z'),
    loadIssues: async () => [issue],
    loadParents: async () => [parent],
    loadScores: async () => [],
    select: async () => {
      throw Object.assign(Error('endpoint detail stays out of the result'), {
        code: 'target_not_finalized',
      })
    },
  })
  assert.deepEqual(result, {
    status: 'retry_replay_unavailable',
    causes: ['target_not_finalized'],
  })
})

test('late score is censored only with an independent finalized deadline witness', () => {
  const issue = {
    sequence: 1,
    sha256: 'b'.repeat(64),
    v1IssueSequence: 1,
    marketKey: 'aaveV3Usdc',
    routeKey: parent.routeKey,
    destination: parent.destination,
    originalAsset: parent.originalAsset,
    holder: H,
    targets: parent.targets,
    cases: followedAaveCases(parent),
  }
  const witness = {
    number: '10',
    hash: `0x${'a'.repeat(64)}`,
    atUtc: '2026-10-01T03:10:12.000Z',
    providers: ['https://one.example', 'https://two.example'],
    finalizedHeads: [
      { number: '11', hash: `0x${'b'.repeat(64)}` },
      { number: '11', hash: `0x${'b'.repeat(64)}` },
    ],
  }
  const score = {
    study: 'carry_public_aave_usdc_frozen_q_score_v2',
    sequence: 1,
    previousSha256: null,
    issueSequence: 1,
    issueSha256: issue.sha256,
    marketKey: issue.marketKey,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.originalAsset,
    holder: H,
    horizonHours: 1,
    targetAtUtc: parent.targets[0].targetAtUtc,
    captureDeadlineUtc: parent.targets[0].captureDeadlineUtc,
    scoredAtUtc: '2026-10-01T03:11:00.000Z',
    status: 'censored',
    target: null,
    deadlineWitness: witness,
    cases: issue.cases.map((entry) => ({
      label: entry.label,
      assetsRaw: entry.assetsRaw,
      status: 'censored',
      measurement: null,
      outcome: null,
      transition: 'censored',
    })),
  }
  assert.equal(validateAaveFrozenQScore(score, [issue], [parent]), score)
  assert.throws(
    () => validateAaveFrozenQScore({ ...score, deadlineWitness: null }, [issue], [parent]),
    /censor_invalid/,
  )
  assert.throws(
    () =>
      validateAaveFrozenQScore(
        { ...score, cases: [{ ...score.cases[0], assetsRaw: '2' }, score.cases[1]] },
        [issue],
        [parent],
      ),
    /censor_invalid/,
  )
  assert.throws(
    () =>
      validateAaveFrozenQScore(
        { ...score, scoredAtUtc: '2026-10-01T02:10:00.000Z' },
        [issue],
        [parent],
      ),
    /censor_invalid/,
  )
})

test('future evidence with wrong holder or missing two-origin replay fails closed', () => {
  const issue = { holder: H }
  const entry = { assetsRaw: '1000000' }
  const target = {
    targetBlock: '10',
    targetHash: `0x${'b'.repeat(64)}`,
    targetBlockAt: '2026-10-01T01:10:00.000Z',
    canonicalityEvidenceDoc: { provider: 'https://one.example' },
  }
  const measurement = {
    evidence: {
      verificationStatus: 'verified',
      identityEvidence: { holder: `0x${'2'.repeat(40)}` },
      replayEvidenceDoc: {},
    },
    evidenceSha256: '0'.repeat(64),
  }
  assert.throws(
    () =>
      verifyAaveFrozenQMeasurement({
        issue,
        entry,
        target,
        measurement,
        scoredAtUtc: '2026-10-01T01:20:00.000Z',
      }),
    /identity_invalid/,
  )
  const matched = {
    verificationStatus: 'verified',
    identityEvidence: {
      holder: H,
      asset: parent.originalAsset,
      destination: parent.destination,
      source: 'carry_public_aave_usdc_frozen_q_score_v2',
      provider: 'https://one.example',
      blockNumber: target.targetBlock,
      blockHash: target.targetHash,
    },
    replayEvidenceDoc: {
      blockNumber: target.targetBlock,
      blockHash: target.targetHash,
      observedAt: '2026-10-01T01:15:00.000Z',
      origins: { primary: 'https://one.example', secondary: 'https://two.example' },
      headers: {
        primary: {
          before: {
            target: {
              hash: target.targetHash,
              parentHash: `0x${'c'.repeat(64)}`,
              number: target.targetBlock,
              timestamp: String(Date.parse(target.targetBlockAt) / 1000),
            },
          },
          after: {
            target: {
              hash: target.targetHash,
              parentHash: `0x${'c'.repeat(64)}`,
              number: target.targetBlock,
              timestamp: String(Date.parse(target.targetBlockAt) / 1000),
            },
          },
        },
        secondary: {},
      },
    },
  }
  const missingSecondary = {
    evidence: matched,
    evidenceSha256: sha(JSON.stringify(matched)),
  }
  assert.throws(
    () =>
      verifyAaveFrozenQMeasurement({
        issue,
        entry,
        target: {
          ...target,
          targetParentHash: `0x${'c'.repeat(64)}`,
          secondOriginCanonicalityEvidenceDoc: { provider: 'https://two.example' },
        },
        measurement: missingSecondary,
        scoredAtUtc: '2026-10-01T01:20:00.000Z',
      }),
    /header_invalid/,
  )
})

test('sweep prioritizes active capture deadlines ahead of already missed ones', () => {
  const older = {
    sequence: 1,
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-10-01T01:00:00.000Z',
        captureDeadlineUtc: '2026-10-01T03:00:00.000Z',
      },
    ],
  }
  const active = {
    sequence: 2,
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-10-01T04:00:00.000Z',
        captureDeadlineUtc: '2026-10-01T06:00:00.000Z',
      },
    ],
  }
  assert.deepEqual(
    pendingAaveFrozenQPlans([older, active], [], '2026-10-01T04:30:00.000Z').map(
      (row) => row.issueSequence,
    ),
    [2, 1],
  )
})

test('persistent early replay retry cannot starve later active targets', async () => {
  const start = Date.parse('2026-10-01T00:10:00.000Z')
  const issues = Array.from({ length: 6 }, (_, index) => ({
    sequence: index + 1,
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-10-01T00:00:00.000Z',
        captureDeadlineUtc: '2026-10-01T02:00:00.000Z',
      },
    ],
  }))
  const pairs = Array.from({ length: 8 }, (_, index) => [{ id: index }])
  const attempted = new Set()
  for (let tick = 0; tick < 6; tick++) {
    let clock = start + tick * 600_000
    const summary = await runAaveFrozenQSweep({
      issues,
      scores: [], // The earlier targets keep retrying across every tick.
      urls: [],
      now: () => new Date(clock),
      makePairs: () => pairs,
      score: async ({ issueSequence, originPairs }) => {
        assert.ok(originPairs.length <= MAX_PAIRS_PER_PLAN)
        attempted.add(issueSequence)
        if (issueSequence === 1) clock += 110_000 // One replay consumes a whole sweep budget.
        return { status: 'retry_replay_unavailable' }
      },
    })
    assert.ok(summary.attempted <= 4)
  }
  assert.ok(attempted.has(5))
  assert.ok(attempted.has(6))
})

test('pair attempts rotate by ten-minute bucket and stay bounded', () => {
  const pairs = Array.from({ length: 8 }, (_, index) => [{ id: index }])
  const plan = { issueSequence: 1, horizonHours: 1 }
  const first = selectAaveFrozenQPairs(pairs, plan, '2026-10-01T00:10:00.000Z')
  const second = selectAaveFrozenQPairs(pairs, plan, '2026-10-01T00:20:00.000Z')
  assert.equal(first.length, 2)
  assert.equal(second.length, 2)
  assert.notEqual(first[0][0].id, second[0][0].id)
  const due = Array.from({ length: 6 }, (_, index) => ({
    issueSequence: index + 1,
    deadlineMs: Date.parse('2026-10-01T02:00:00.000Z'),
  }))
  assert.notDeepEqual(
    fairAaveFrozenQPlans(due, '2026-10-01T00:10:00.000Z').map((x) => x.issueSequence),
    fairAaveFrozenQPlans(due, '2026-10-01T00:20:00.000Z').map((x) => x.issueSequence),
  )
})
