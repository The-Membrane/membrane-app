import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DIRECT_MARKETS,
  configuredPublicRpcUrls,
  HORIZONS_HOURS,
  publicRpcClients,
} from './carry-local-compound-holder-issue.mjs'
import {
  classifyPublicDirectExitOutcome,
  hasSuppliedBaseline,
  selectMatchingPublicDirectTarget,
  STUDY as SCORE_STUDY,
  validateScore,
} from './carry-local-compound-holder-score.mjs'
import {
  appendCompoundAttempt,
  auditCompoundAttemptLinkage,
  verifyCompoundAttempts,
} from './carry-local-compound-holder-attempt.mjs'

test('the lane binds only the frozen Compound III USDC route', () => {
  assert.equal(DIRECT_MARKETS.compoundV3Usdc.kind, 'comet')
  assert.equal(DIRECT_MARKETS.compoundV3Usdc.routeKey, 'USDC → supply on Compound v3')
  assert.deepEqual(HORIZONS_HOURS, [1, 4, 24, 48, 168])
})

test('Compound successful withdraw below supplied Q is debt, not holder exit', () => {
  assert.equal(
    classifyPublicDirectExitOutcome(
      { simulationStatus: 'success', holderCoverageRaw: '999' },
      '1000',
    ),
    'holder_attrition',
  )
  assert.equal(
    classifyPublicDirectExitOutcome(
      { simulationStatus: 'success', holderCoverageRaw: '1000' },
      '1000',
    ),
    'exit_success',
  )
  assert.equal(
    classifyPublicDirectExitOutcome(
      { simulationStatus: 'evm_revert', holderCoverageRaw: '1000', coveredRevert: true },
      '1000',
    ),
    'exit_revert_cause_unknown',
  )
})

test('only a supplied and baseline executable amount enters a score denominator', () => {
  const entry = {
    status: 'measured',
    assetsRaw: '1000',
    measurement: { status: 'success', holderCoverageRaw: '999' },
  }
  assert.equal(hasSuppliedBaseline(entry), false)
  entry.measurement.holderCoverageRaw = '1000'
  assert.equal(hasSuppliedBaseline(entry), true)
  entry.measurement.status = 'evm_revert'
  assert.equal(hasSuppliedBaseline(entry), false)
})

test('measured score validates against its bound original Q and classifies a borrow', () => {
  const route = DIRECT_MARKETS.compoundV3Usdc
  const holder = `0x${'a'.repeat(40)}`
  const hash = `0x${'b'.repeat(64)}`
  const parentHash = `0x${'c'.repeat(64)}`
  const targetAtUtc = '2026-10-01T01:00:00.000Z'
  const targetBlockAt = '2026-10-01T01:00:12.000Z'
  const observedAt = '2026-10-01T01:01:00.000Z'
  const deadline = '2026-10-01T03:00:00.000Z'
  const header = { hash, parentHash, timestamp: '0x68dc866c' }
  // Numeric timestamp is what the replay header carries.
  header.timestamp = `0x${Math.floor(Date.parse(targetBlockAt) / 1000).toString(16)}`
  const target = {
    targetBlock: '101',
    targetHash: hash,
    targetBlockAt,
    targetParentBlock: '100',
    targetParentHash: parentHash,
    targetParentBlockAt: '2026-10-01T00:59:48.000Z',
    targetObservedAt: observedAt,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      chainId: '1',
      finalityTag: 'finalized',
      provider: 'https://one.example',
      targetAt: targetAtUtc,
      observedAt,
      targetHeader: { number: '101', hash, parentHash, timestamp: targetBlockAt },
      parentHeader: {
        number: '100',
        hash: parentHash,
        timestamp: '2026-10-01T00:59:48.000Z',
      },
      baselineHeader: { number: '99', hash: `0x${'d'.repeat(64)}` },
      finalizedHead: { number: '101', hash },
    },
  }
  target.secondOriginTarget = {
    targetBlock: target.targetBlock,
    targetHash: target.targetHash,
    targetBlockAt: target.targetBlockAt,
    targetParentBlock: target.targetParentBlock,
    targetParentHash: target.targetParentHash,
    targetParentBlockAt: target.targetParentBlockAt,
    targetObservedAt: observedAt,
    canonicalityEvidenceDoc: {
      ...target.canonicalityEvidenceDoc,
      provider: 'https://two.example',
    },
  }
  const original = {
    label: 'holder_q',
    assetsRaw: '1000',
    status: 'measured',
    measurement: { status: 'success', holderCoverageRaw: '2000' },
  }
  const issue = {
    sequence: 1,
    sha256: 'e'.repeat(64),
    marketKey: 'compoundV3Usdc',
    routeKey: route.routeKey,
    destination: route.destination,
    originalAsset: route.asset,
    candidate: { holder },
    baseline: { targetBlock: '99', targetHash: `0x${'d'.repeat(64)}` },
    targets: [{ horizonHours: 1, targetAtUtc, captureDeadlineUtc: deadline }],
    cases: [original],
  }
  const evidence = {
    identityEvidence: { provider: 'https://one.example', source: SCORE_STUDY },
    replayEvidenceDoc: {
      observedAt,
      origins: { primary: 'https://one.example', secondary: 'https://two.example' },
      headers: {
        primary: { before: { target: header }, after: { target: header } },
        secondary: { before: { target: header }, after: { target: header } },
      },
    },
  }
  const score = {
    study: SCORE_STUDY,
    sequence: 1,
    previousSha256: null,
    issueSequence: 1,
    issueSha256: issue.sha256,
    marketKey: issue.marketKey,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.originalAsset,
    holder,
    horizonHours: 1,
    targetAtUtc,
    captureDeadlineUtc: deadline,
    scoredAtUtc: observedAt,
    onTime: true,
    target,
    cases: [
      {
        label: original.label,
        assetsRaw: original.assetsRaw,
        status: 'measured',
        reason: null,
        outcome: 'holder_attrition',
        measurement: { evidence },
      },
    ],
  }
  assert.equal(
    validateScore(score, [issue], (_issue, boundOriginal) => {
      assert.equal(boundOriginal, original)
      return { simulationStatus: 'success', holderCoverageRaw: '999' }
    }),
    score,
  )
  const forged = structuredClone(score)
  forged.target.secondOriginTarget.canonicalityEvidenceDoc.targetHeader.hash = parentHash
  assert.throws(
    () =>
      validateScore(forged, [issue], () => ({
        simulationStatus: 'success',
        holderCoverageRaw: '999',
      })),
    /score_target_invalid/,
  )
  const sameHost = structuredClone(score)
  sameHost.target.secondOriginTarget.canonicalityEvidenceDoc.provider = 'http://one.example'
  assert.throws(
    () =>
      validateScore(sameHost, [issue], () => ({
        simulationStatus: 'success',
        holderCoverageRaw: '999',
      })),
    /score_target_invalid/,
  )
})

test('first finalized target preserves both independent origin selections', async () => {
  const clients = [
    { provider: 'https://one.example', request: async () => {} },
    { provider: 'https://two.example', request: async () => {} },
  ]
  const plan = { targetAtUtc: '2026-10-01T01:00:00.000Z' }
  const selected = await selectMatchingPublicDirectTarget({
    issue: { baseline: { targetBlock: '99', targetHash: `0x${'a'.repeat(64)}` } },
    plan,
    clients,
    select: async ({ provider }) => ({
      targetBlock: '101',
      targetHash: `0x${'b'.repeat(64)}`,
      targetBlockAt: '2026-10-01T01:00:12.000Z',
      targetParentHash: `0x${'c'.repeat(64)}`,
      targetParentBlockAt: '2026-10-01T00:59:48.000Z',
      canonicalityEvidenceDoc: { provider },
    }),
  })
  assert.equal(selected.canonicalityEvidenceDoc.provider, 'https://one.example')
  assert.equal(selected.secondOriginTarget.canonicalityEvidenceDoc.provider, 'https://two.example')
  assert.equal(selected.secondOriginTarget.targetHash, selected.targetHash)
})

test('same-host URLs do not count as independent public origins', () => {
  assert.throws(
    () =>
      configuredPublicRpcUrls(
        { get: () => undefined },
        { RECORDER_RPC_URLS: 'https://example.org/a,https://example.org/b' },
      ),
    /independent_public_origins_required/,
  )
  const urls = ['https://one.example/a', 'https://one.example/b', 'https://two.example/c']
  const configured = configuredPublicRpcUrls(
    { get: () => undefined },
    { RECORDER_RPC_URLS: urls.join(',') },
  )
  assert.deepEqual(configured, [urls[0], urls[2], urls[1]])
  assert.deepEqual(
    publicRpcClients(urls).map((client) => client.url),
    configured,
  )
})

test('attempt receipts form a canonical sealed chain and detect tampering', async () => {
  const out = await mkdtemp(join(tmpdir(), 'compound-holder-attempt-'))
  const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })
  const entry = {
    mode: 'score',
    slot: 2,
    startedAtUtc: '1970-01-01T00:30:01.000Z',
    finishedAtUtc: '1970-01-01T00:30:02.000Z',
    status: 'scored_sweep',
    issueSequence: null,
    issueSha256: null,
    scoreSummary: { due: 0, attempted: 0, scored: 0, retries: 0 },
  }
  try {
    await appendCompoundAttempt(entry, out, stat)
    await appendCompoundAttempt({ ...entry, finishedAtUtc: '1970-01-01T00:30:03.000Z' }, out, stat)
    assert.equal((await verifyCompoundAttempts(out)).length, 2)
    const path = join(out, '00000002.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.status = 'failed'
    await writeFile(path, `${JSON.stringify(saved)}\n`)
    await assert.rejects(verifyCompoundAttempts(out), /compound_attempt_invalid/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('attempt audit reports manual orphan issues and rejects a false issue link', () => {
  const issues = [
    { sequence: 1, sha256: 'a'.repeat(64), slot: 1, issuedAtUtc: '1970-01-01T00:15:01.000Z' },
    { sequence: 2, sha256: 'b'.repeat(64), slot: 2, issuedAtUtc: '1970-01-01T00:30:02.000Z' },
  ]
  const attempt = {
    sequence: 1,
    status: 'issued',
    issueSequence: 2,
    issueSha256: issues[1].sha256,
    slot: 2,
    startedAtUtc: '1970-01-01T00:30:01.000Z',
    finishedAtUtc: '1970-01-01T00:30:03.000Z',
  }
  assert.deepEqual(auditCompoundAttemptLinkage(issues, [attempt]), {
    linkedIssues: 1,
    orphanIssueSequences: [1],
    invalidAttemptSequences: [],
  })
  assert.deepEqual(
    auditCompoundAttemptLinkage(issues, [{ ...attempt, issueSha256: issues[0].sha256 }])
      .invalidAttemptSequences,
    [1],
  )
})
