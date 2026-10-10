import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BOARD_ROUTES,
  SUPPLEMENTAL_ROUTES,
  SCORE_STUDY,
  freezeQCases,
  formatV2ScoreTickSummary,
  issueV2,
  parseMorphoV2CliArgs,
  readV2Issues,
  reconcileV2Attempts,
  scoreRetryErrorCode,
  scoreV2Due,
  scoreTransition,
  selectDueV2ScoreCells,
  selectMissingMorphoApiSubject,
  validateV2Attempt,
  validateV2NoHolderCandidate,
  validateV2Issue,
  validateV2Score,
} from './carry-local-morpho-holder-v2.mjs'

test('v2 scorer selects an open holder window before older missed windows', () => {
  const cases = [{ label: 'holder_small_sentinel', baselineStatus: 'simulated_withdraw_success' }]
  const issues = [
    {
      sequence: 1,
      status: 'issued',
      cases,
      targets: [
        {
          horizonHours: 24,
          targetAtUtc: '2026-10-02T01:00:00.000Z',
          captureDeadlineUtc: '2026-10-02T03:00:00.000Z',
        },
      ],
    },
    {
      sequence: 2,
      status: 'issued',
      cases,
      targets: [
        {
          horizonHours: 24,
          targetAtUtc: '2026-10-03T05:00:00.000Z',
          captureDeadlineUtc: '2026-10-03T07:00:00.000Z',
        },
      ],
    },
  ]
  const now = Date.parse('2026-10-03T06:00:00.000Z')
  assert.equal(selectDueV2ScoreCells(issues, [], now, 1)[0].issue.sequence, 2)
  assert.equal(
    selectDueV2ScoreCells(
      issues,
      [{ issueSequence: 2, caseLabel: 'holder_small_sentinel', horizonHours: 24 }],
      now,
      1,
    )[0].issue.sequence,
    1,
  )
})

const missingSubject = (index) => ({
  routeKey: BOARD_ROUTES[index].routeKey,
  destination: BOARD_ROUTES[index].destination,
  originalAsset: BOARD_ROUTES[index].asset,
  scope: 'frozen_25_67',
  reasons: ['no_verified_direct_issue'],
})
const sha = (value) => createHash('sha256').update(value).digest('hex')

test('missing API selector prioritizes never attempted, then rotates no_holder by sealed attempts', () => {
  const eligibleSubjects = [
    missingSubject(0),
    missingSubject(1),
    missingSubject(2),
    missingSubject(3),
  ]
  const issue = (index, status) => ({ ...BOARD_ROUTES[index], status })
  const attempt = (index, sequence) => ({
    ...BOARD_ROUTES[index],
    sequence,
    finishedAtUtc: '2026-09-01T00:00:00.000Z',
  })
  const base = {
    eligibleSubjects,
    issues: [issue(0, 'no_holder'), issue(1, 'no_holder'), issue(2, 'no_holder')],
    attempts: [attempt(0, 1), attempt(0, 2), attempt(1, 3), attempt(2, 4)],
  }
  assert.deepEqual(selectMissingMorphoApiSubject(base), {
    status: 'selected',
    routeIndex: 3,
    apiPageSkip: 0,
    category: 'never_attempted',
    attemptCount: 0,
    lastAttemptSequence: 0,
    apiAttemptCount: 0,
    lastApiAttemptSequence: 0,
  })
  const tried = { ...base, attempts: [...base.attempts, attempt(3, 5)] }
  assert.equal(selectMissingMorphoApiSubject(tried).routeIndex, 1)
  const rotated = {
    ...tried,
    attempts: [...tried.attempts, { ...attempt(1, 6), candidateSource: 'morpho-api' }],
  }
  assert.equal(selectMissingMorphoApiSubject(rotated).routeIndex, 2)
  const withMeasured = { ...rotated, issues: [...rotated.issues, issue(2, 'issued')] }
  assert.equal(selectMissingMorphoApiSubject(withMeasured).routeIndex, 0)
  assert.deepEqual(
    selectMissingMorphoApiSubject({ ...withMeasured, eligibleSubjects: [missingSubject(2)] }),
    { status: 'no_missing_morpho_subject' },
  )
})

test('missing API selector restarts after a fully checked scan and retries transient origin failures', () => {
  const api = (index, sequence) => ({
    ...BOARD_ROUTES[index],
    status: 'no_holder',
    sha256: sha(String(sequence)),
    issuedAtUtc: '2026-09-01T00:00:00.000Z',
    candidate: {
      evidenceDoc: {
        schema: 'carry_exit_v2_morpho_api_candidate_v1',
        discovery: { attempted: 1, pageInfo: { countTotal: 1 } },
        screenedCandidates: [{ status: 'no_pinned_shares' }],
      },
    },
  })
  const eligibleSubjects = [missingSubject(0), missingSubject(1)]
  const issues = [api(0, 1)]
  const attempts = [
    {
      ...BOARD_ROUTES[0],
      sequence: 1,
      issueSha256: issues[0].sha256,
      finishedAtUtc: '2026-09-01T00:00:00.000Z',
    },
    {
      ...BOARD_ROUTES[1],
      sequence: 2,
      status: 'origin_unavailable',
      candidateSource: 'morpho-api',
      finishedAtUtc: '2026-09-01T00:00:00.000Z',
    },
  ]
  assert.deepEqual(
    selectMissingMorphoApiSubject({
      eligibleSubjects,
      issues,
      attempts,
      nowMs: Date.parse('2026-09-01T01:00:00.000Z'),
    }),
    {
      status: 'selected',
      routeIndex: 1,
      apiPageSkip: 0,
      category: 'attempted_unavailable',
      attemptCount: 1,
      lastAttemptSequence: 2,
      apiAttemptCount: 1,
      lastApiAttemptSequence: 2,
    },
  )
  const cooling = selectMissingMorphoApiSubject({
    eligibleSubjects,
    issues: [...issues, api(1, 3)],
    attempts,
    nowMs: Date.parse('2026-09-01T01:00:00.000Z'),
  })
  assert.deepEqual(cooling, {
    status: 'retry_backoff',
    retryAtUtc: '2026-09-02T00:00:00.000Z',
  })
})

test('conclusive pages cover the first-page tail before restarting the live scan', () => {
  const start = Date.parse('2026-09-01T00:00:00.000Z')
  const subject = missingSubject(0)
  const first = {
    ...BOARD_ROUTES[0],
    status: 'no_holder',
    issuedAtUtc: new Date(start).toISOString(),
    candidate: {
      evidenceDoc: {
        schema: 'carry_exit_v2_morpho_api_candidate_v1',
        discovery: { attempted: 8, pageInfo: { countTotal: 10 } },
        screenedCandidates: Array.from({ length: 8 }, () => ({ status: 'no_pinned_claim' })),
      },
    },
  }
  const second = {
    ...first,
    issuedAtUtc: new Date(start + 60 * 60_000).toISOString(),
    candidate: {
      evidenceDoc: {
        schema: 'carry_exit_v2_morpho_api_candidate_page_v2',
        discovery: { pageSkip: 8, attempted: 2, pageInfo: { countTotal: 10 } },
        screenedCandidates: Array.from({ length: 2 }, () => ({ status: 'no_pinned_claim' })),
      },
    },
  }
  const args = { eligibleSubjects: [subject], attempts: [] }
  assert.equal(
    selectMissingMorphoApiSubject({ ...args, issues: [first], nowMs: start + 31 * 60_000 })
      .apiPageSkip,
    8,
  )
  assert.deepEqual(
    selectMissingMorphoApiSubject({
      ...args,
      issues: [first, second],
      nowMs: start + 2 * 60 * 60_000,
    }),
    { status: 'retry_backoff', retryAtUtc: new Date(start + 25 * 60 * 60_000).toISOString() },
  )
  assert.equal(
    selectMissingMorphoApiSubject({
      ...args,
      issues: [first, second],
      nowMs: start + 25 * 60 * 60_000,
    }).apiPageSkip,
    0,
  )
  const shrunk = {
    ...second,
    candidate: {
      evidenceDoc: {
        ...second.candidate.evidenceDoc,
        discovery: {
          ...second.candidate.evidenceDoc.discovery,
          attempted: 0,
          pageInfo: { countTotal: 5 },
        },
        screenedCandidates: [],
      },
    },
  }
  assert.deepEqual(
    selectMissingMorphoApiSubject({
      ...args,
      issues: [first, shrunk],
      nowMs: start + 2 * 60 * 60_000,
    }),
    { status: 'retry_backoff', retryAtUtc: new Date(start + 25 * 60 * 60_000).toISOString() },
  )
})

test('transient API candidate or Q failure backs off and remains retryable', () => {
  const at = Date.parse('2026-09-01T00:00:00.000Z')
  const subject = { ...missingSubject(0), reasons: ['no_measured_exact_holder_q_baseline'] }
  const issue = {
    ...BOARD_ROUTES[0],
    status: 'no_holder',
    sha256: sha('transient'),
    issuedAtUtc: new Date(at).toISOString(),
    cases: [],
    candidate: {
      evidenceDoc: {
        schema: 'carry_exit_v2_morpho_api_candidate_v1',
        discovery: { attempted: 1 },
        screenedCandidates: [{ status: 'rpc_unavailable' }],
      },
    },
  }
  const attempt = {
    ...BOARD_ROUTES[0],
    sequence: 1,
    issueSha256: issue.sha256,
    finishedAtUtc: new Date(at).toISOString(),
  }
  const args = { eligibleSubjects: [subject], issues: [issue], attempts: [attempt] }
  assert.deepEqual(selectMissingMorphoApiSubject({ ...args, nowMs: at + 10 * 60_000 }), {
    status: 'retry_backoff',
    retryAtUtc: new Date(at + 30 * 60_000).toISOString(),
  })
  assert.equal(selectMissingMorphoApiSubject({ ...args, nowMs: at + 30 * 60_000 }).routeIndex, 0)
  const measurementUnavailable = {
    ...issue,
    status: 'baseline_unavailable',
    cases: [{ baselineStatus: 'unavailable' }],
    candidate: {
      evidenceDoc: {
        ...issue.candidate.evidenceDoc,
        screenedCandidates: [{ status: 'eligible_holder' }],
      },
    },
  }
  assert.equal(
    selectMissingMorphoApiSubject({
      ...args,
      issues: [measurementUnavailable],
      nowMs: at + 31 * 60_000,
    }).routeIndex,
    0,
  )
  const fiveAttempts = Array.from({ length: 5 }, (_, sequence) => ({
    ...attempt,
    sequence: sequence + 1,
    candidateSource: 'morpho-api',
  }))
  assert.deepEqual(
    selectMissingMorphoApiSubject({ ...args, attempts: fiveAttempts, nowMs: at + 2 * 60 * 60_000 }),
    { status: 'retry_backoff', retryAtUtc: new Date(at + 6 * 60 * 60_000).toISOString() },
  )
})

test('missing API selector rejects non-frozen or duplicate identities', () => {
  const base = { issues: [], attempts: [] }
  for (const eligibleSubjects of [
    [missingSubject(0), missingSubject(0)],
    [{ ...missingSubject(0), scope: 'outside_frozen_25_67' }],
    [{ ...missingSubject(0), reasons: [] }],
    [{ ...missingSubject(0), destination: '0x0000000000000000000000000000000000000000' }],
  ])
    assert.throws(
      () => selectMissingMorphoApiSubject({ ...base, eligibleSubjects }),
      /holder_v2_missing_api_selection_invalid/,
    )
})

test('missing API CLI accepts only the bounded no-index mode', () => {
  assert.deepEqual(parseMorphoV2CliArgs(['--issue-missing-api']), { mode: '--issue-missing-api' })
  for (const args of [
    ['--issue-missing-api', '13'],
    ['--issue-missing-api', '--candidate-source', 'frozen-seed'],
    ['--issue-missing-api', '--lookback-blocks', '4096'],
  ])
    assert.throws(() => parseMorphoV2CliArgs(args), /usage:/)
})

test('API candidate proof stays bound to issue block, parent and both witness hosts', async (t) => {
  const source = (await readV2Issues()).find(
    (issue) =>
      issue.candidate?.evidenceDoc?.schema === 'carry_exit_v2_morpho_api_candidate_v1' &&
      issue.candidate.evidenceDoc.screenedCandidates.some((row) => row.pinnedProof),
  )
  if (!source) return t.skip('no verified local API issue')
  const rewrite = (mutate) => {
    const issue = structuredClone(source)
    mutate(issue.candidate.evidenceDoc)
    issue.candidate.digest = sha(JSON.stringify(issue.candidate.evidenceDoc))
    return issue
  }
  assert.throws(
    () =>
      validateV2Issue(
        rewrite((doc) => {
          doc.baselineBlock += 1
        }),
      ),
    /holder_v2_candidate_baseline_state_invalid/,
  )
  assert.throws(
    () =>
      validateV2Issue(
        rewrite((doc) => {
          doc.parentHash = `0x${'11'.repeat(32)}`
        }),
      ),
    /holder_v2_candidate_baseline_state_invalid/,
  )
  assert.throws(
    () =>
      validateV2Issue(
        rewrite((doc) => {
          const row = doc.screenedCandidates.find((entry) => entry.pinnedProof)
          row.pinnedProof.hostCommitments = [sha('forged-one'), sha('forged-two')]
          row.pinnedProofSha256 = sha(JSON.stringify(row.pinnedProof))
        }),
      ),
    /holder_v2_candidate_baseline_state_invalid/,
  )
})

test('Morpho issue CLI keeps 4096 default and accepts an explicit bounded window', () => {
  assert.deepEqual(parseMorphoV2CliArgs(['--issue', '13']), {
    mode: '--issue',
    routeIndex: 13,
    lookbackBlocks: 4_096,
  })
  assert.deepEqual(parseMorphoV2CliArgs(['--issue', '13', '--lookback-blocks', '512']), {
    mode: '--issue',
    routeIndex: 13,
    lookbackBlocks: 512,
  })
  assert.equal(
    parseMorphoV2CliArgs(['--issue', '13', '--lookback-blocks', '32']).lookbackBlocks,
    32,
  )
  assert.equal(
    parseMorphoV2CliArgs(['--issue', '13', '--lookback-blocks', '4096']).lookbackBlocks,
    4_096,
  )
})

test('Morpho issue CLI rejects malformed or out-of-range lookback without RPC', () => {
  for (const value of ['0', '31', '4097', '32.5', '-32', '1e2', 'NaN', '999999999999999999']) {
    assert.throws(
      () => parseMorphoV2CliArgs(['--issue', '13', '--lookback-blocks', value]),
      /holder_v2_lookback_blocks_invalid/,
    )
  }
  assert.throws(
    () => parseMorphoV2CliArgs(['--issue', '13', '--lookback-blocks']),
    /holder_v2_lookback_blocks_invalid/,
  )
  assert.throws(() => parseMorphoV2CliArgs(['--score', '--lookback-blocks', '512']), /usage:/)
})

test('Morpho API candidate source is explicit; transfer logs remain the default', () => {
  assert.deepEqual(parseMorphoV2CliArgs(['--issue', '13', '--candidate-source', 'morpho-api']), {
    mode: '--issue',
    routeIndex: 13,
    lookbackBlocks: 4_096,
    candidateSource: 'morpho-api',
  })
  assert.equal(parseMorphoV2CliArgs(['--issue', '13']).candidateSource, undefined)
  for (const args of [
    ['--issue', '13', '--candidate-source', 'other'],
    ['--issue', '13', '--candidate-source'],
    ['--score', '--candidate-source', 'morpho-api'],
    ['--issue', '13', '--candidate-source', 'morpho-api', '--lookback-blocks', '512'],
  ])
    assert.throws(() => parseMorphoV2CliArgs(args))
})

test('explicit Morpho API page capture binds a bounded offset and source', () => {
  assert.deepEqual(parseMorphoV2CliArgs(['--issue-api-page', '24', '8']), {
    mode: '--issue-api-page',
    routeIndex: 24,
    lookbackBlocks: 4_096,
    candidateSource: 'morpho-api-page',
    apiPageSkip: 8,
  })
  for (const args of [
    ['--issue-api-page', '24'],
    ['--issue-api-page', '24', '9'],
    ['--issue-api-page', '49', '8'],
    ['--issue-api-page', '24', '-8'],
    ['--issue-api-page', '24', '8', 'extra'],
  ])
    assert.throws(() => parseMorphoV2CliArgs(args))
})

test('historical Transfer blocks are explicit, ordered, and bounded before RPC', () => {
  assert.deepEqual(parseMorphoV2CliArgs(['--issue', '38', '--historical-blocks', '25846411']), {
    mode: '--issue',
    routeIndex: 38,
    lookbackBlocks: 4_096,
    candidateSource: 'historical-transfer',
    historicalBlocks: ['25846411'],
  })
  for (const blocks of ['0', '1,1', '2,1', '-1', '1e3', '01', Array(9).fill('1').join(',')])
    assert.throws(
      () => parseMorphoV2CliArgs(['--issue', '38', '--historical-blocks', blocks]),
      /holder_v2_historical_blocks_invalid/,
    )
  assert.throws(() => parseMorphoV2CliArgs(['--issue', '38', '--historical-blocks']), /usage:/)
})

test('frozen seed candidate source is explicit and bound to AUSD index 35 before RPC', async () => {
  assert.deepEqual(parseMorphoV2CliArgs(['--issue', '35', '--candidate-source', 'frozen-seed']), {
    mode: '--issue',
    routeIndex: 35,
    lookbackBlocks: 4_096,
    candidateSource: 'frozen-seed',
  })
  for (const route of [BOARD_ROUTES[7], BOARD_ROUTES[34], BOARD_ROUTES[13]]) {
    let calls = 0
    const request = async () => {
      calls++
      throw Error('unexpected_rpc')
    }
    await assert.rejects(
      () =>
        issueV2({
          route,
          primary: { provider: 'https://one.example', request },
          secondary: { provider: 'https://two.example', request },
          candidateSource: 'frozen-seed',
          capture: async () => {
            calls++
            throw Error('unexpected_capture')
          },
        }),
      /holder_v2_seed_route_invalid/,
    )
    assert.equal(calls, 0)
  }
  assert.throws(() =>
    parseMorphoV2CliArgs([
      '--issue',
      '35',
      '--candidate-source',
      'frozen-seed',
      '--lookback-blocks',
      '512',
    ]),
  )
})

test('native implicit rotation uses seed only for exact AUSD index 35', () => {
  const slot = 15 * 60_000
  assert.equal(BOARD_ROUTES[35].destination, '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589')
  for (const index of [35, 35 + BOARD_ROUTES.length]) {
    assert.deepEqual(parseMorphoV2CliArgs(['--issue'], index * slot), {
      mode: '--issue',
      routeIndex: 35,
      lookbackBlocks: 4_096,
      candidateSource: 'frozen-seed',
    })
  }
  for (const index of [34, 36])
    assert.equal(parseMorphoV2CliArgs(['--issue'], index * slot).candidateSource, undefined)
  assert.equal(parseMorphoV2CliArgs(['--issue', '35'], 35 * slot).candidateSource, undefined)
  assert.equal(
    parseMorphoV2CliArgs(['--issue', '--lookback-blocks', '512'], 35 * slot).candidateSource,
    undefined,
  )
  assert.equal(
    parseMorphoV2CliArgs(['--issue', '35', '--candidate-source', 'morpho-api'], 35 * slot)
      .candidateSource,
    'morpho-api',
  )
  assert.equal(
    parseMorphoV2CliArgs(['--issue', '22', '--candidate-source', 'local-payout'], 35 * slot)
      .candidateSource,
    'local-payout',
  )
})

test('no_holder issue cannot hide a selected candidate in its evidence document', () => {
  const issue = {
    holder: null,
    cases: [],
    candidate: {
      evidenceDoc: {
        selectedHolderCommitment: null,
        selectedSharesRaw: null,
        selectedClaimRaw: null,
        ladder: { selectedClaimRaw: null },
      },
    },
  }
  assert.equal(validateV2NoHolderCandidate(issue), issue)
  for (const field of ['selectedHolderCommitment', 'selectedSharesRaw', 'selectedClaimRaw']) {
    const forged = structuredClone(issue)
    forged.candidate.evidenceDoc[field] = 'forged'
    assert.throws(() => validateV2NoHolderCandidate(forged), /holder_v2_no_holder_invalid/)
  }
  const forgedLadder = structuredClone(issue)
  forgedLadder.candidate.evidenceDoc.ladder.selectedClaimRaw = '1'
  assert.throws(() => validateV2NoHolderCandidate(forgedLadder), /holder_v2_no_holder_invalid/)
})

test('direct Morpho issue rejects invalid lookback before capture or RPC', async () => {
  let captures = 0
  let requests = 0
  let discoveries = 0
  const primary = {
    provider: 'https://primary.example',
    request: async () => {
      requests++
      throw Error('unexpected_rpc')
    },
  }
  const secondary = { provider: 'https://secondary.example', request: primary.request }
  for (const lookbackBlocks of [31, 4_097, 32.5, '512']) {
    await assert.rejects(
      () =>
        issueV2({
          route: BOARD_ROUTES[0],
          primary,
          secondary,
          lookbackBlocks,
          capture: async () => {
            captures++
            throw Error('unexpected_capture')
          },
          discover: async () => {
            discoveries++
            throw Error('unexpected_discovery')
          },
        }),
      /holder_v2_lookback_blocks_invalid/,
    )
  }
  assert.equal(captures, 0)
  assert.equal(requests, 0)
  assert.equal(discoveries, 0)
})

test('default v2 Morpho scope is the exact 49 board assays', () => {
  assert.equal(BOARD_ROUTES.length, 49)
  assert.equal(new Set(BOARD_ROUTES.map((row) => row.destination)).size, 49)
  assert.equal(SUPPLEMENTAL_ROUTES.length, 19)
  assert.ok(
    SUPPLEMENTAL_ROUTES.every(
      (row) =>
        !BOARD_ROUTES.some(
          (board) => board.routeKey === row.routeKey && board.destination === row.destination,
        ),
    ),
  )
})

test('v2 freezes near-claim Q and a holder-eligible vault tier separately', () => {
  const candidate = {
    holder: `0x${'1'.repeat(40)}`,
    evidenceDoc: {
      ladder: {
        selectedClaimRaw: '1000000',
        labels: [
          { label: 'holder_half_claim_capped_vault_0p001pct', assetsRaw: '100' },
          { label: 'vault_0p001pct', assetsRaw: '100' },
          { label: 'vault_0p01pct', assetsRaw: '1000' },
          { label: 'vault_0p1pct', assetsRaw: '10000' },
        ],
      },
    },
  }
  const cases = freezeQCases(candidate)
  assert.deepEqual(
    cases.map((row) => row.assetsRaw),
    ['100', '900000', '10000'],
  )
  assert.ok(cases.every((row) => BigInt(row.assetsRaw) <= 1000000n))
})

test('v2 preserves duplicate near-boundary Q as an omitted denominator', () => {
  const candidate = {
    holder: `0x${'1'.repeat(40)}`,
    evidenceDoc: {
      ladder: {
        selectedClaimRaw: '1',
        labels: [
          { label: 'holder_half_claim_capped_vault_0p001pct', assetsRaw: '1' },
          { label: 'vault_0p001pct', assetsRaw: '1' },
        ],
      },
    },
  }
  const cases = freezeQCases(candidate)
  assert.equal(cases[1].omittedReason, 'duplicate_q')
  assert.equal(cases[2].omittedReason, 'duplicate_q')
})

test('v2 score cannot relabel an amount or censor before deadline', () => {
  const route = BOARD_ROUTES[0]
  const issue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder: `0x${'1'.repeat(40)}`,
    cases: [
      {
        label: 'holder_near_claim_90pct',
        assetsRaw: '900',
        evidenceSha256: 'b'.repeat(64),
        baselineStatus: 'simulated_withdraw_success',
      },
    ],
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-09-30T01:00:00.000Z',
        captureDeadlineUtc: '2026-09-30T03:00:00.000Z',
      },
    ],
  }
  const score = {
    study: SCORE_STUDY,
    issueSequence: 1,
    issueSha256: issue.sha256,
    caseLabel: 'holder_near_claim_90pct',
    baselineStatus: 'simulated_withdraw_success',
    caseEvidenceSha256: 'b'.repeat(64),
    routeKey: issue.routeKey,
    destination: issue.destination,
    asset: issue.asset,
    holder: issue.holder,
    assetsRaw: '900',
    horizonHours: 1,
    targetAtUtc: issue.targets[0].targetAtUtc,
    captureDeadlineUtc: issue.targets[0].captureDeadlineUtc,
    scoredAtUtc: '2026-09-30T03:00:00.001Z',
    outcome: 'censored_capture_window_missed',
    transition: 'censored',
    target: null,
    targetWitness: null,
    evidence: null,
  }
  assert.equal(validateV2Score(score, [issue]), score)
  assert.throws(
    () => validateV2Score({ ...score, assetsRaw: '901' }, [issue]),
    /holder_v2_score_case_invalid/,
  )
  assert.throws(
    () => validateV2Score({ ...score, scoredAtUtc: '2026-09-30T03:00:00.000Z' }, [issue]),
    /holder_v2_censor_invalid/,
  )
  const revertedIssue = {
    ...issue,
    status: 'baseline_unavailable',
    cases: [{ ...issue.cases[0], baselineStatus: 'baseline_revert' }],
  }
  const revertedScore = { ...score, baselineStatus: 'baseline_revert' }
  assert.equal(validateV2Score(revertedScore, [revertedIssue]), revertedScore)
  assert.throws(
    () => validateV2Score({ ...revertedScore, transition: 'simulated_recovery' }, [revertedIssue]),
    /holder_v2_score_case_invalid/,
  )
  assert.throws(
    () =>
      validateV2Score(revertedScore, [
        { ...revertedIssue, cases: [{ ...revertedIssue.cases[0], baselineStatus: 'unavailable' }] },
      ]),
    /holder_v2_score_case_invalid/,
  )
})

test('v2 due scorer retries provider pair while retaining the frozen near-claim Q', async () => {
  const route = BOARD_ROUTES[0]
  const issue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    status: 'issued',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder: `0x${'1'.repeat(40)}`,
    baseline: { targetBlock: '10', targetHash: `0x${'a'.repeat(64)}` },
    cases: [
      {
        label: 'holder_near_claim_90pct',
        assetsRaw: '900',
        evidenceSha256: 'b'.repeat(64),
        baselineStatus: 'simulated_withdraw_success',
      },
    ],
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-09-30T01:00:00.000Z',
        captureDeadlineUtc: '2026-09-30T03:00:00.000Z',
      },
    ],
  }
  const client = (provider) => ({
    provider,
    url: provider,
    request: async () => {
      throw Error('unexpected_rpc')
    },
    send: async () => {
      throw Error('unexpected_rpc')
    },
  })
  const bad = client('https://bad.example')
  const good = client('https://good.example')
  const witness = client('https://witness.example')
  let attempts = 0
  let saved
  const result = await scoreV2Due({
    pairs: [
      { primary: bad, secondary: witness },
      { primary: good, secondary: witness },
    ],
    now: () => new Date('2026-09-30T01:30:00.000Z'),
    readIssueRows: async () => [issue],
    readScoreRows: async () => [],
    choose: async ({ provider }) => {
      attempts++
      if (provider === bad.provider) throw Error('rpc_unavailable')
      return { targetBlock: '11', targetHash: `0x${'c'.repeat(64)}` }
    },
    measure: async () => ({ status: 'verified', callEvidenceDoc: { stub: true } }),
    decode: () => ({ routeKind: 'morpho', simulationStatus: 'success' }),
    append: async (_dir, row) => {
      saved = row
    },
  })
  assert.equal(attempts, 3)
  assert.equal(result.counts.measured, 1)
  assert.equal(result.counts.pairAttempts, 2)
  assert.equal(result.counts.retryByStage.target_primary, 1)
  assert.equal(result.counts.retryByError.rpc_unavailable, 1)
  assert.equal(saved.caseLabel, 'holder_near_claim_90pct')
  assert.equal(saved.baselineStatus, 'simulated_withdraw_success')
  assert.equal(saved.transition, 'simulated_continuity')
  assert.equal(saved.assetsRaw, '900')
})

test('v2 score diagnostics reduce raw provider failures to bounded enums', () => {
  assert.equal(scoreRetryErrorCode(Error('target_not_finalized')), 'target_not_finalized')
  assert.equal(
    scoreRetryErrorCode(new Error('rpc_unavailable', { cause: Error('rpc_http_429 secret') })),
    'rate_limited',
  )
  assert.equal(scoreRetryErrorCode(Error('HTTP 429 at https://secret.example/key')), 'rate_limited')
  assert.equal(scoreRetryErrorCode(Error('request timed out https://secret.example')), 'timeout')
  assert.equal(scoreRetryErrorCode(Error('holder_v2_target_disagreement')), 'target_disagreement')
  assert.equal(scoreRetryErrorCode(Error('private-holder 0x123456')), 'unclassified')
  const summary = formatV2ScoreTickSummary({
    scanned: 2,
    forecastValidated: false,
    counts: {
      measured: 0,
      censored: 0,
      retry: 2,
      pairAttempts: 2,
      retryByStage: {
        target_primary: 1,
        target_witness: 1,
        target_consensus: 0,
        measurement: 0,
        proof_decode: 0,
      },
      retryByError: {
        target_not_finalized: 0,
        baseline_not_canonical: 0,
        target_precedes_baseline: 0,
        rpc_unavailable: 0,
        invalid_rpc_header: 0,
        wrong_chain: 0,
        noncanonical_target_boundary: 0,
        audit_input_invalid: 0,
        audit_clock_invalid: 0,
        target_disagreement: 0,
        replay_unavailable: 0,
        rate_limited: 1,
        timeout: 1,
        transport: 0,
        proof_invalid: 0,
        unclassified: 0,
      },
    },
  })
  assert.match(summary, /^carry-local-morpho-holder:v2score ok scanned=2 measured=0/)
  assert.doesNotMatch(summary, /secret|0x123456/)
  assert.throws(() => formatV2ScoreTickSummary({ extra: 'https://secret.example' }))
})

test('v2 score tick wrapper suppresses unexpected child output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-v2-tick-test-'))
  try {
    const fakeTimeout = join(dir, 'timeout')
    writeFileSync(fakeTimeout, '#!/bin/sh\necho "https://secret.example holder 0x123456"\n', {
      mode: 0o700,
    })
    const result = spawnSync(
      '/bin/sh',
      ['scripts/carry-local-morpho-holder-tick.sh', 'v2score', '--locked'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MORPHO_HOLDER_TIMEOUT_BIN: fakeTimeout,
          MORPHO_HOLDER_NODE_BIN: process.execPath,
        },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /v2score failed \(summary_invalid\)/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret\.example|0x123456/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing API wrapper skips below 3 GiB and dispatches at most one bounded CLI above reserve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-missing-api-tick-test-'))
  try {
    const fakeTimeout = join(dir, 'timeout')
    const called = join(dir, 'called')
    writeFileSync(fakeTimeout, '#!/bin/sh\nprintf "%s\\n" "$*" > "$MORPHO_TEST_CALLED"\n', {
      mode: 0o700,
    })
    const disk = statfsSync(process.cwd())
    const low = Number(disk.bavail) * Number(disk.bsize) < 3 * 1024 ** 3
    const result = spawnSync(
      '/bin/sh',
      ['scripts/carry-local-morpho-holder-tick.sh', 'issue-missing-api', '--locked'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MORPHO_HOLDER_TIMEOUT_BIN: fakeTimeout,
          MORPHO_HOLDER_NODE_BIN: process.execPath,
          MORPHO_TEST_CALLED: called,
        },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0)
    if (low) {
      assert.match(result.stdout, /issue-missing-api disk-reserve-skip/)
      assert.equal(existsSync(called), false)
    } else {
      assert.match(result.stdout, /issue-missing-api ok/)
      assert.equal(existsSync(called), true)
      const argv = readFileSync(called, 'utf8')
      assert.match(argv, /-k 10s 510s/)
      assert.match(argv, /--max-old-space-size=384 --import tsx/)
      assert.match(argv, /carry-local-morpho-holder-v2\.mjs --issue-missing-api/)
    }
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret|0x123456/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('measured baseline revert remains eligible at frozen H1 and distinguishes recovery', async () => {
  const route = BOARD_ROUTES[0]
  const issue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    status: 'baseline_unavailable',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder: `0x${'1'.repeat(40)}`,
    baseline: { targetBlock: '10', targetHash: `0x${'a'.repeat(64)}` },
    cases: [
      {
        label: 'holder_near_claim_90pct',
        assetsRaw: '900',
        evidenceSha256: 'b'.repeat(64),
        baselineStatus: 'baseline_revert',
      },
      {
        label: 'largest_vault_tier_within_claim',
        assetsRaw: '800',
        evidenceSha256: null,
        baselineStatus: 'unavailable',
      },
    ],
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: '2026-09-30T01:00:00.000Z',
        captureDeadlineUtc: '2026-09-30T03:00:00.000Z',
      },
    ],
  }
  const client = (provider) => ({
    provider,
    url: provider,
    request: async () => {},
    send: async () => {},
  })
  const saved = []
  const result = await scoreV2Due({
    pairs: [{ primary: client('https://one.example'), secondary: client('https://two.example') }],
    now: () => new Date('2026-09-30T01:30:00.000Z'),
    readIssueRows: async () => [issue],
    readScoreRows: async () => [],
    choose: async () => ({ targetBlock: '11', targetHash: `0x${'c'.repeat(64)}` }),
    measure: async () => ({ status: 'verified', callEvidenceDoc: { stub: true } }),
    decode: () => ({ routeKind: 'morpho', simulationStatus: 'success' }),
    append: async (_dir, row) => saved.push(row),
  })
  assert.equal(result.scanned, 1)
  assert.equal(result.counts.measured, 1)
  assert.equal(saved[0].baselineStatus, 'baseline_revert')
  assert.equal(saved[0].caseEvidenceSha256, 'b'.repeat(64))
  assert.equal(saved[0].transition, 'simulated_recovery')
  assert.equal(
    scoreTransition('baseline_revert', 'covered_revert_cause_unknown'),
    'still_reverting',
  )
  const stillReverting = []
  await scoreV2Due({
    pairs: [{ primary: client('https://one.example'), secondary: client('https://two.example') }],
    now: () => new Date('2026-09-30T01:30:00.000Z'),
    readIssueRows: async () => [issue],
    readScoreRows: async () => [],
    choose: async () => ({ targetBlock: '11', targetHash: `0x${'c'.repeat(64)}` }),
    measure: async () => ({ status: 'verified', callEvidenceDoc: { stub: true } }),
    decode: () => ({
      routeKind: 'morpho',
      simulationStatus: 'evm_revert',
      holderCoverageRaw: '900',
      requiredCoverageRaw: '900',
      requiredAssetsRaw: '900',
      coveredRevert: true,
    }),
    append: async (_dir, row) => stillReverting.push(row),
  })
  assert.equal(stillReverting[0].outcome, 'covered_revert_cause_unknown')
  assert.equal(stillReverting[0].transition, 'still_reverting')
  assert.equal(scoreTransition('baseline_revert', 'holder_attrition'), 'holder_attrition')
  assert.equal(scoreTransition('baseline_revert', 'inconclusive_revert'), 'inconclusive_revert')
  assert.equal(
    scoreTransition('simulated_withdraw_success', 'holder_attrition'),
    'holder_attrition',
  )
  assert.equal(
    scoreTransition('simulated_withdraw_success', 'inconclusive_revert'),
    'inconclusive_revert',
  )
  assert.equal(scoreTransition('baseline_revert', 'preview_gap'), 'still_reverting')
  assert.equal(scoreTransition('simulated_withdraw_success', 'preview_gap'), 'new_revert')
  assert.throws(
    () => validateV2Score({ ...saved[0], baselineStatus: 'simulated_withdraw_success' }, [issue]),
    /holder_v2_score_case_invalid/,
  )
})

test('v2 attempt receipt rejects non-board route and unsafe reason text', () => {
  const route = BOARD_ROUTES[0]
  const attempt = {
    study: 'carry_local_morpho_holder_v2_attempt_v1',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    startedAtUtc: '2026-09-30T00:00:00.000Z',
    finishedAtUtc: '2026-09-30T00:01:00.000Z',
    status: 'issued',
    issueSha256: 'a'.repeat(64),
    originFailures: { candidate_logs_unavailable: 1 },
  }
  assert.equal(validateV2Attempt(attempt), attempt)
  assert.throws(
    () => validateV2Attempt({ ...attempt, routeKey: 'unknown' }),
    /holder_v2_attempt_invalid/,
  )
  assert.throws(
    () => validateV2Attempt({ ...attempt, originFailures: { 'https://secret.example': 1 } }),
    /holder_v2_attempt_invalid/,
  )
  assert.throws(
    () => validateV2Attempt({ ...attempt, issueSha256: null }),
    /holder_v2_attempt_invalid/,
  )
  assert.throws(
    () => validateV2Attempt({ ...attempt, status: 'origin_unavailable' }),
    /holder_v2_attempt_invalid/,
  )
  assert.equal(
    validateV2Attempt({ ...attempt, status: 'origin_unavailable', issueSha256: null }).status,
    'origin_unavailable',
  )
  assert.equal(
    validateV2Attempt({
      ...attempt,
      candidateSource: 'historical-transfer',
      historicalBlocks: ['25846411'],
    }).candidateSource,
    'historical-transfer',
  )
  assert.equal(
    validateV2Attempt({ ...attempt, candidateSource: 'morpho-api-page', apiPageSkip: 8 })
      .apiPageSkip,
    8,
  )
  assert.throws(
    () => validateV2Attempt({ ...attempt, candidateSource: 'morpho-api-page' }),
    /holder_v2_attempt_invalid/,
  )
  assert.throws(
    () => validateV2Attempt({ ...attempt, candidateSource: 'historical-transfer' }),
    /holder_v2_attempt_invalid/,
  )
})

test('v2 verifier reconciles linked attempts and exposes issue append orphans', () => {
  const route = BOARD_ROUTES[0]
  const issue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    status: 'issued',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    issuedAtUtc: '2026-09-30T00:00:30.000Z',
  }
  const attempt = {
    sequence: 1,
    study: 'carry_local_morpho_holder_v2_attempt_v1',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    startedAtUtc: '2026-09-30T00:00:00.000Z',
    finishedAtUtc: '2026-09-30T00:01:00.000Z',
    status: 'issued',
    issueSha256: issue.sha256,
    originFailures: {},
  }
  assert.deepEqual(reconcileV2Attempts([issue], [attempt]), {
    linkedIssues: 1,
    reconstructedIssues: 0,
    unissuedAttempts: [],
    orphanIssues: [],
  })
  assert.deepEqual(reconcileV2Attempts([issue], []), {
    linkedIssues: 0,
    reconstructedIssues: 0,
    unissuedAttempts: [],
    orphanIssues: [
      {
        issueSequence: 1,
        issueSha256: issue.sha256,
        status: 'orphan_issue_without_attempt',
      },
    ],
  })
  assert.throws(
    () => reconcileV2Attempts([issue], [{ ...attempt, status: 'no_holder' }]),
    /holder_v2_attempt_issue_mismatch/,
  )
  assert.throws(
    () => reconcileV2Attempts([issue], [attempt, { ...attempt, sequence: 2 }]),
    /holder_v2_attempt_issue_mismatch/,
  )
  assert.throws(() => reconcileV2Attempts([], [attempt]), /holder_v2_attempt_issue_mismatch/)
})

test('v2 verifier distinguishes a reconstructed attempt from an original capture receipt', () => {
  const route = BOARD_ROUTES[0]
  const issue = {
    sequence: 1,
    sha256: 'b'.repeat(64),
    status: 'issued',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    issuedAtUtc: '2026-09-30T00:00:30.000Z',
    baseline: { targetObservedAt: '2026-09-30T00:00:20.000Z' },
    candidate: {
      evidenceDoc: {
        schema: 'carry_exit_v2_morpho_api_candidate_page_v2',
        discovery: { pageSkip: 0 },
      },
    },
  }
  const attempt = {
    sequence: 1,
    study: 'carry_local_morpho_holder_v2_attempt_v1',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    startedAtUtc: issue.baseline.targetObservedAt,
    finishedAtUtc: issue.issuedAtUtc,
    status: 'issued',
    issueSha256: issue.sha256,
    candidateSource: 'morpho-api',
    apiPageSkip: 0,
    originFailures: {},
    reconstructedFromSealedIssue: true,
    reconciledAtUtc: '2026-09-30T00:02:00.000Z',
  }
  assert.equal(validateV2Attempt(attempt), attempt)
  assert.equal(reconcileV2Attempts([issue], [attempt]).orphanIssues.length, 0)
  assert.equal(reconcileV2Attempts([issue], [attempt]).reconstructedIssues, 1)
  assert.throws(
    () => reconcileV2Attempts([issue], [{ ...attempt, startedAtUtc: '2026-09-30T00:00:19.000Z' }]),
    /holder_v2_attempt_issue_mismatch/,
  )
  assert.throws(
    () => validateV2Attempt({ ...attempt, reconstructedFromSealedIssue: false }),
    /holder_v2_attempt_invalid/,
  )
})
