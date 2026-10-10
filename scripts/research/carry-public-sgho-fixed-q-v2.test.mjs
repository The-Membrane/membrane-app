import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FIXED_Q_RAW,
  eligibleSghoV1Issue,
  issueSghoFixedQ,
  pendingSghoFixedQParentPlans,
  validateSghoFixedQIssue,
} from './carry-public-sgho-fixed-q-v2-issue.mjs'
import {
  classifySghoFixedQOutcome,
  classifySghoFixedQTransition,
  scoreSghoFixedQ,
  validateSghoFixedQScore,
} from './carry-public-sgho-fixed-q-v2-score.mjs'
import { pendingSghoFixedQPlans } from '../record-carry-public-sgho-fixed-q-v2-scores.mjs'

const V1 = {
  sequence: 1,
  sha256: 'a'.repeat(64),
  issuedAtUtc: '2026-10-01T00:10:00.000Z',
  baseline: { targetBlockAt: '2026-10-01T00:00:00.000Z' },
  candidate: {
    holder: `0x${'1'.repeat(40)}`,
    evidenceDoc: { selectedClaimRaw: '2000000000000000000' },
  },
}

test('requires a recent receipt-backed parent claim of at least exactly 1 GHO', () => {
  assert.equal(FIXED_Q_RAW, '1000000000000000000')
  assert.equal(eligibleSghoV1Issue(V1, '2026-10-01T00:15:00.000Z'), true)
  assert.equal(
    eligibleSghoV1Issue(
      {
        ...V1,
        candidate: { ...V1.candidate, evidenceDoc: { selectedClaimRaw: '999999999999999999' } },
      },
      '2026-10-01T00:15:00.000Z',
    ),
    false,
  )
  assert.equal(eligibleSghoV1Issue(V1, '2026-10-01T00:46:00.000Z'), false)
})

test('fixed-Q campaign plans only unused fresh parents, oldest baseline deadline first', () => {
  const newer = {
    ...V1,
    sequence: 2,
    sha256: 'b'.repeat(64),
    issuedAtUtc: '2026-10-01T00:20:00.000Z',
    baseline: { targetBlockAt: '2026-10-01T00:15:00.000Z' },
  }
  const at = '2026-10-01T00:25:00.000Z'
  const pending = pendingSghoFixedQParentPlans([newer, V1], [], at)
  assert.deepEqual(
    pending.map(({ parent, issueDeadlineUtc }) => [parent.sequence, issueDeadlineUtc]),
    [
      [1, '2026-10-01T00:45:00.000Z'],
      [2, '2026-10-01T01:00:00.000Z'],
    ],
  )
  assert.deepEqual(
    pendingSghoFixedQParentPlans([V1, newer], [{ v1IssueSequence: 1 }], at).map(
      ({ parent }) => parent.sequence,
    ),
    [2],
  )
  assert.deepEqual(pendingSghoFixedQParentPlans([V1, newer], [], '2026-10-01T01:01:00.000Z'), [])
})

test('rejects another amount before accepting a score or measurement', () => {
  const row = {
    study: 'carry_public_sgho_fixed_q_issue_v2',
    sequence: 1,
    previousSha256: null,
    v1IssueSequence: 1,
    v1IssueSha256: V1.sha256,
    routeKey: 'GHO → sGho [GHO]',
    destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    originalAsset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    holder: V1.candidate.holder,
    assetsRaw: '2',
    issuedAtUtc: '2026-10-01T00:15:00.000Z',
    horizonsHours: [],
    targets: [],
  }
  assert.throws(() => validateSghoFixedQIssue(row, [V1]), /binding_invalid/)
})

test('separates success, recovery, still reverting and holder attrition', () => {
  const success = { routeKind: 'sgho', simulationStatus: 'success', actualConsumedRaw: '1' }
  const revert = {
    routeKind: 'sgho',
    simulationStatus: 'evm_revert',
    coveredRevert: true,
    holderCoverageRaw: '10',
    requiredCoverageRaw: '5',
  }
  const zero = { ...revert, coveredRevert: false, holderCoverageRaw: '0' }
  const depleted = { ...revert, holderCoverageRaw: '4' }
  assert.equal(
    classifySghoFixedQTransition('covered_revert', classifySghoFixedQOutcome(success)),
    'simulated_recovery',
  )
  assert.equal(
    classifySghoFixedQTransition('covered_revert', classifySghoFixedQOutcome(revert)),
    'still_reverting',
  )
  assert.equal(
    classifySghoFixedQTransition('covered_revert', classifySghoFixedQOutcome(zero)),
    'holder_attrition',
  )
  assert.equal(classifySghoFixedQOutcome(depleted), 'preview_share_gap')
  assert.equal(
    classifySghoFixedQTransition('covered_revert', classifySghoFixedQOutcome(depleted)),
    'holder_attrition',
  )
  assert.equal(
    classifySghoFixedQTransition('success', classifySghoFixedQOutcome(depleted)),
    'holder_attrition',
  )
  assert.equal(
    classifySghoFixedQTransition('success', classifySghoFixedQOutcome(revert)),
    'lost_exitability',
  )
})

test('plans every exact-Q horizon including covered-revert baseline issues', () => {
  const issue = {
    sequence: 1,
    baselineStatus: 'covered_revert',
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-10-01T01:00:00.000Z',
        captureDeadlineUtc: '2026-10-01T03:00:00.000Z',
      },
      {
        horizonHours: 4,
        targetAtUtc: '2026-10-01T04:00:00.000Z',
        captureDeadlineUtc: '2026-10-01T06:00:00.000Z',
      },
    ],
  }
  assert.deepEqual(
    pendingSghoFixedQPlans([issue], [], '2026-10-01T04:30:00.000Z').map(
      (entry) => entry.horizonHours,
    ),
    [4, 1],
  )
  assert.deepEqual(
    pendingSghoFixedQPlans(
      [issue],
      [{ issueSequence: 1, horizonHours: 4 }],
      '2026-10-01T04:30:00.000Z',
    ).map((entry) => entry.horizonHours),
    [1],
  )
})

test('late censor needs a two-origin finalized deadline witness and retains exact Q', () => {
  const issue = {
    sequence: 1,
    sha256: 'b'.repeat(64),
    v1IssueSequence: 1,
    holder: V1.candidate.holder,
    baselineStatus: 'covered_revert',
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-10-01T01:00:00.000Z',
        captureDeadlineUtc: '2026-10-01T03:00:00.000Z',
      },
    ],
  }
  const witness = {
    number: '10',
    hash: `0x${'a'.repeat(64)}`,
    atUtc: '2026-10-01T03:00:12.000Z',
    providers: ['https://one.example', 'https://two.example'],
    finalizedHeads: [
      { number: '11', hash: `0x${'b'.repeat(64)}` },
      { number: '11', hash: `0x${'b'.repeat(64)}` },
    ],
  }
  const row = {
    study: 'carry_public_sgho_fixed_q_score_v2',
    sequence: 1,
    previousSha256: null,
    issueSequence: 1,
    issueSha256: issue.sha256,
    routeKey: 'GHO → sGho [GHO]',
    destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    originalAsset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    holder: issue.holder,
    assetsRaw: FIXED_Q_RAW,
    horizonHours: 1,
    targetAtUtc: issue.targets[0].targetAtUtc,
    captureDeadlineUtc: issue.targets[0].captureDeadlineUtc,
    scoredAtUtc: '2026-10-01T03:01:00.000Z',
    status: 'censored',
    target: null,
    measurement: null,
    outcome: null,
    transition: 'censored',
    deadlineWitness: witness,
  }
  assert.equal(validateSghoFixedQScore(row, [issue], [V1]), row)
  assert.throws(
    () => validateSghoFixedQScore({ ...row, assetsRaw: '2' }, [issue], [V1]),
    /binding_invalid/,
  )
  assert.throws(
    () => validateSghoFixedQScore({ ...row, deadlineWitness: null }, [issue], [V1]),
    /censor_invalid/,
  )
})

test('issuer never writes an unverified fixed-Q baseline', async () => {
  const parent = {
    ...V1,
    baseline: {
      ...V1.baseline,
      canonicalityEvidenceDoc: { provider: 'https://one.example' },
    },
    baselineWitness: { provider: 'https://two.example' },
  }
  let attempts = 0
  const result = await issueSghoFixedQ({
    originPairs: [
      [
        { provider: 'https://one.example', url: 'https://one.example', send: async () => {} },
        { provider: 'https://two.example', url: 'https://two.example', send: async () => {} },
      ],
    ],
    now: () => new Date('2026-10-01T00:15:00.000Z'),
    loadParents: async () => [parent],
    load: async () => [],
    measure: async (args) => {
      attempts++
      assert.equal(args.holder, V1.candidate.holder)
      assert.equal(args.assetsRaw, FIXED_Q_RAW)
      return { status: 'unavailable' }
    },
    append: async () => {
      throw Error('must_not_append')
    },
  })
  assert.equal(result.status, 'retry_baseline_replay')
  assert.equal(attempts, 1)
})

test('fixed-Q campaign issuer retries the earliest expiring eligible parent first', async () => {
  const older = {
    ...V1,
    baseline: {
      ...V1.baseline,
      canonicalityEvidenceDoc: { provider: 'https://one.example' },
    },
    baselineWitness: { provider: 'https://two.example' },
  }
  const newer = {
    ...older,
    sequence: 2,
    sha256: 'b'.repeat(64),
    issuedAtUtc: '2026-10-01T00:20:00.000Z',
    baseline: { ...older.baseline, targetBlockAt: '2026-10-01T00:15:00.000Z' },
    candidate: { ...older.candidate, holder: `0x${'2'.repeat(40)}` },
  }
  const selected = []
  const result = await issueSghoFixedQ({
    originPairs: [
      [
        { provider: 'https://one.example', url: 'https://one.example', send: async () => {} },
        { provider: 'https://two.example', url: 'https://two.example', send: async () => {} },
      ],
    ],
    oldestDeadlineFirst: true,
    now: () => new Date('2026-10-01T00:25:00.000Z'),
    loadParents: async () => [older, newer],
    load: async () => [],
    measure: async ({ holder }) => {
      selected.push(holder)
      return { status: 'unavailable' }
    },
    append: async () => {
      throw Error('must_not_append')
    },
  })
  assert.equal(result.status, 'retry_baseline_replay')
  assert.deepEqual(selected, [older.candidate.holder, newer.candidate.holder])
})

test('an unavailable oldest origin pair does not block a newer fresh fixed-Q parent', async () => {
  const older = {
    ...V1,
    baseline: {
      ...V1.baseline,
      canonicalityEvidenceDoc: { provider: 'https://one.example' },
    },
    baselineWitness: { provider: 'https://two.example' },
  }
  const newer = {
    ...older,
    sequence: 2,
    sha256: 'b'.repeat(64),
    issuedAtUtc: '2026-10-01T00:20:00.000Z',
    baseline: {
      ...older.baseline,
      targetBlockAt: '2026-10-01T00:15:00.000Z',
      canonicalityEvidenceDoc: { provider: 'https://three.example' },
    },
    baselineWitness: { provider: 'https://four.example' },
    candidate: { ...older.candidate, holder: `0x${'2'.repeat(40)}` },
  }
  const selected = []
  const result = await issueSghoFixedQ({
    originPairs: [
      [
        { provider: 'https://three.example', url: 'https://three.example', send: async () => {} },
        { provider: 'https://four.example', url: 'https://four.example', send: async () => {} },
      ],
    ],
    oldestDeadlineFirst: true,
    now: () => new Date('2026-10-01T00:25:00.000Z'),
    loadParents: async () => [older, newer],
    load: async () => [],
    measure: async ({ holder }) => {
      selected.push(holder)
      return { status: 'unavailable' }
    },
    append: async () => {
      throw Error('must_not_append')
    },
  })
  assert.equal(result.status, 'retry_baseline_replay')
  assert.deepEqual(selected, [newer.candidate.holder])
})

test('score does not read future blocks before the fixed horizon', async () => {
  const issue = {
    sequence: 1,
    v1IssueSequence: 1,
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-10-01T01:15:00.000Z',
        captureDeadlineUtc: '2026-10-01T03:15:00.000Z',
      },
    ],
  }
  const result = await scoreSghoFixedQ({
    issueSequence: 1,
    horizonHours: 1,
    now: () => new Date('2026-10-01T00:45:00.000Z'),
    loadIssues: async () => [issue],
    loadParents: async () => [V1],
    loadScores: async () => [],
    originPairs: [],
    select: async () => {
      throw Error('future_read')
    },
  })
  assert.equal(result.status, 'not_due')
})
