import assert from 'node:assert/strict'
import test from 'node:test'

import {
  baselineStatusForScorableCase,
  buildAaveCommonQScore,
  classifyAaveCommonQOutcome,
  classifyAaveCommonQTransition,
  scoreAaveCommonQ,
  validateAaveCommonQScore,
} from './carry-public-aave-usdc-common-q-v3-score.mjs'
import {
  pendingAaveCommonQPlans,
  runAaveCommonQSweep,
  selectAaveCommonQPairs,
} from '../record-carry-public-aave-usdc-common-q-v3-scores.mjs'

const holder = `0x${'1'.repeat(40)}`
const parent = { baseline: { targetBlock: '10', targetHash: `0x${'a'.repeat(64)}` } }
const targetAtUtc = '2026-10-01T01:10:00.000Z'
const captureDeadlineUtc = '2026-10-01T03:10:00.000Z'
const issue = {
  sequence: 1,
  sha256: 'b'.repeat(64),
  v1IssueSequence: 1,
  marketKey: 'aaveV3Usdc',
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  originalAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  holder,
  targets: [{ horizonHours: 1, targetAtUtc, captureDeadlineUtc }],
  cases: [
    {
      label: 'fixed_1_usdc',
      assetsRaw: '1000000',
      status: 'measured',
      measurement: { baselineStatus: 'success' },
    },
    {
      label: 'fixed_1000_usdc',
      assetsRaw: '1000000000',
      status: 'measured',
      measurement: { baselineStatus: 'covered_revert' },
    },
    {
      label: 'fixed_100000_usdc',
      assetsRaw: '100000000000',
      status: 'inconclusive',
      measurement: { baselineStatus: 'inconclusive_covered_revert' },
    },
  ],
}

test('V3 target classification separates restriction, recovery, attrition and continued failure', () => {
  assert.equal(baselineStatusForScorableCase(issue.cases[0]), 'success')
  assert.equal(baselineStatusForScorableCase(issue.cases[1]), 'covered_revert')
  assert.throws(() => baselineStatusForScorableCase(issue.cases[2]), /baseline_invalid/)
  const success = { routeKind: 'aave', simulationStatus: 'success', holderCoverageRaw: '2000000' }
  const revert = {
    routeKind: 'aave',
    simulationStatus: 'evm_revert',
    holderCoverageRaw: '2000000',
    coveredRevert: true,
  }
  assert.equal(
    classifyAaveCommonQTransition('success', classifyAaveCommonQOutcome(revert, '1000000')),
    'lost_exitability',
  )
  assert.equal(
    classifyAaveCommonQTransition('covered_revert', classifyAaveCommonQOutcome(success, '1000000')),
    'simulated_recovery',
  )
  assert.equal(
    classifyAaveCommonQTransition('covered_revert', classifyAaveCommonQOutcome(revert, '1000000')),
    'still_reverting',
  )
  assert.equal(
    classifyAaveCommonQOutcome({ ...success, holderCoverageRaw: '999999' }, '1000000'),
    'simulated_withdraw_success',
  )
  assert.equal(
    classifyAaveCommonQOutcome({ ...revert, holderCoverageRaw: '999999' }, '1000000'),
    'holder_attrition',
  )
})

test('censor binds only measured baseline Q and requires two-origin deadline witness', () => {
  const deadlineWitness = {
    number: '12',
    hash: `0x${'c'.repeat(64)}`,
    atUtc: '2026-10-01T03:10:12.000Z',
    providers: ['https://one.example', 'https://two.example'],
    finalizedHeads: [
      { number: '13', hash: `0x${'d'.repeat(64)}` },
      { number: '13', hash: `0x${'d'.repeat(64)}` },
    ],
  }
  const score = buildAaveCommonQScore({
    issue,
    issues: [issue],
    parents: [parent],
    horizonHours: 1,
    target: null,
    measurements: null,
    deadlineWitness,
    scoredAtUtc: '2026-10-01T03:11:00.000Z',
    sequence: 1,
    previousSha256: null,
  })
  assert.equal(score.cases.length, 2)
  assert.equal(validateAaveCommonQScore(score, [issue], [parent]), score)
  assert.throws(
    () =>
      validateAaveCommonQScore(
        {
          ...score,
          cases: [
            ...score.cases,
            {
              label: 'fixed_100000_usdc',
              assetsRaw: '100000000000',
              status: 'censored',
              measurement: null,
              outcome: null,
              transition: 'censored',
            },
          ],
        },
        [issue],
        [parent],
      ),
    /binding/,
  )
  assert.throws(
    () => validateAaveCommonQScore({ ...score, deadlineWitness: null }, [issue], [parent]),
    /censor/,
  )
})

test('no future read before H1 and an all-inconclusive issue has no score plan', async () => {
  const args = {
    issueSequence: 1,
    horizonHours: 1,
    originPairs: [],
    loadIssues: async () => [issue],
    loadParents: async () => [parent],
    loadScores: async () => [],
    now: () => new Date('2026-10-01T00:30:00.000Z'),
    select: async () => {
      throw Error('future_read')
    },
  }
  assert.equal((await scoreAaveCommonQ(args)).status, 'not_due')
  const empty = {
    ...issue,
    cases: issue.cases.map((entry) => ({ ...entry, status: 'inconclusive' })),
  }
  assert.equal(
    (await scoreAaveCommonQ({ ...args, loadIssues: async () => [empty] })).status,
    'no_measured_baseline',
  )
})

test('bounded replay retry reports only a safe reason code', async () => {
  const result = await scoreAaveCommonQ({
    issueSequence: 1,
    horizonHours: 1,
    originPairs: [
      [
        { provider: 'one', request: async () => null },
        { provider: 'two', request: async () => null },
      ],
    ],
    loadIssues: async () => [issue],
    loadParents: async () => [parent],
    loadScores: async () => [],
    now: () => new Date('2026-10-01T01:30:00.000Z'),
    select: async () => {
      throw Error('finalized_target_unavailable')
    },
  })
  assert.deepEqual(result, {
    status: 'retry_replay_unavailable',
    retryReasons: ['finalized_target_unavailable'],
  })
})

test('score plan prefers the two origins that verified its frozen baseline', () => {
  const pairs = [
    [{ provider: 'infura' }, { provider: 'quicknode' }],
    [{ provider: 'alchemy' }, { provider: 'ankr' }],
  ]
  const selected = selectAaveCommonQPairs(
    pairs,
    { issueSequence: 1, horizonHours: 1 },
    '2026-10-02T01:40:00.000Z',
    ['ankr', 'alchemy'],
  )
  assert.deepEqual(selected, [pairs[1]])
})

test('bounded sweep omits issues with no measured baseline and rotates due plans', async () => {
  const dueIssue = {
    ...issue,
    targets: [{ ...issue.targets[0], targetAtUtc: '2026-10-01T00:00:00.000Z' }],
  }
  const excluded = {
    ...issue,
    sequence: 2,
    cases: issue.cases.map((entry) => ({ ...entry, status: 'inconclusive' })),
  }
  const plans = pendingAaveCommonQPlans([dueIssue, excluded], [], '2026-10-01T00:30:00.000Z')
  assert.deepEqual(
    plans.map((x) => x.issueSequence),
    [1],
  )
  const attempted = []
  const summary = await runAaveCommonQSweep({
    issues: [dueIssue, excluded],
    scores: [],
    urls: ['one', 'two'],
    now: () => new Date('2026-10-01T00:30:00.000Z'),
    makePairs: () => [[{ provider: 'one' }, { provider: 'two' }]],
    score: async ({ issueSequence, originPairs }) => {
      attempted.push(issueSequence)
      assert.equal(originPairs.length, 1)
      return { status: 'retry_replay_unavailable' }
    },
  })
  assert.deepEqual(attempted, [1])
  assert.equal(summary.retries, 1)
})
