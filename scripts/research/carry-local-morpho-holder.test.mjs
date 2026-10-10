import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { appendChain, readChain } from './carry-local-morpho-holder-store.mjs'
import {
  HORIZONS,
  ROUTES,
  SCORE_STUDY,
  classify,
  originIdentity,
  replayHeaderMatches,
  scoreDue,
  validateAttempt,
  validateScore,
  validateTarget,
} from './carry-local-morpho-holder.mjs'

test('frozen Morpho roster covers route keys across exact vaults', () => {
  assert.equal(ROUTES.length, 68)
  assert.equal(new Set(ROUTES.map((row) => row.destination)).size, 49)
  assert.deepEqual(HORIZONS, [1, 24])
})

test('local ledger is canonical, linked, append-only, and detects edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'morpho-holder-test-'))
  const check = (record) => assert.equal(record.kind, 'test')
  try {
    const first = await appendChain(dir, { kind: 'test', value: 1 }, check)
    const second = await appendChain(dir, { kind: 'test', value: 2 }, check)
    assert.equal(second.previousSha256, first.sha256)
    assert.equal((await readChain(dir, check)).length, 2)
    const file = join(dir, '00000001.json')
    const bytes = await readFile(file, 'utf8')
    await writeFile(file, bytes.replace('"value":1', '"value":3'))
    await assert.rejects(readChain(dir, check), /morpho_holder_chain_invalid/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('future Morpho simulations remain distinct from mined delivery', () => {
  assert.equal(
    classify({ routeKind: 'morpho', simulationStatus: 'success' }),
    'simulated_withdraw_success',
  )
  assert.equal(
    classify({
      routeKind: 'morpho',
      simulationStatus: 'evm_revert',
      holderCoverageRaw: '10',
      requiredCoverageRaw: '50',
      requiredAssetsRaw: '30',
      coveredRevert: true,
    }),
    'covered_revert_cause_unknown',
  )
  assert.equal(
    classify({
      routeKind: 'morpho',
      simulationStatus: 'evm_revert',
      holderCoverageRaw: '0',
      requiredCoverageRaw: '0',
      requiredAssetsRaw: '30',
      coveredRevert: false,
    }),
    'holder_attrition',
  )
})

test('replay header compares numeric block identity across hex and decimal forms', () => {
  const digest = `0x${'a'.repeat(64)}`
  const blockAt = '2026-09-30T00:00:00.000Z'
  const timestamp = Date.parse(blockAt) / 1000
  assert.equal(
    replayHeaderMatches(
      { number: '0x64', hash: digest, timestamp: `0x${timestamp.toString(16)}` },
      '100',
      digest,
      blockAt,
    ),
    true,
  )
  assert.equal(
    replayHeaderMatches(
      { number: '0x65', hash: digest, timestamp: `0x${timestamp.toString(16)}` },
      '100',
      digest,
      blockAt,
    ),
    false,
  )
})

test('loopback aliases cannot masquerade as independent origins', () => {
  assert.equal(originIdentity('http://localhost:8545'), originIdentity('http://127.0.0.1:8545'))
  assert.equal(originIdentity('http://[::1]:8545'), 'loopback')
  assert.notEqual(originIdentity('https://one.example'), originIdentity('https://two.example'))
  assert.equal(originIdentity('https://one.example/rpc/key?network=mainnet'), 'one.example')
  assert.throws(
    () => originIdentity('https://user:secret@one.example/path'),
    /holder_origin_invalid/,
  )
})

test('empty due lane produces no synthetic outcomes', async () => {
  const pair = {
    provider: 'https://one.example',
    request: async () => {
      throw Error('unexpected_rpc')
    },
  }
  const other = { provider: 'https://two.example', request: pair.request }
  const result = await scoreDue({ pairs: [{ primary: pair, secondary: other }] })
  assert.deepEqual(result, {
    scanned: 0,
    counts: { measured: 0, censored: 0, retry: 0 },
    forecastValidated: false,
  })
})

test('due scorer retries a second independent origin pair before censoring', async () => {
  const route = ROUTES[0]
  const issue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    status: 'issued',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder: `0x${'1'.repeat(40)}`,
    case: { assetsRaw: '100' },
    baseline: { targetBlock: '10', targetHash: `0x${'a'.repeat(64)}` },
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
  let recorded
  const result = await scoreDue({
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
      return { targetBlock: '11', targetHash: `0x${'b'.repeat(64)}` }
    },
    measure: async () => ({ status: 'verified', callEvidenceDoc: { stub: true } }),
    decode: () => ({ routeKind: 'morpho', simulationStatus: 'success' }),
    append: async (_dir, row) => {
      recorded = row
    },
  })
  assert.equal(attempts, 3)
  assert.equal(result.counts.measured, 1)
  assert.equal(result.counts.censored, 0)
  assert.equal(recorded.outcome, 'simulated_withdraw_success')
})

test('missing target is censored only after its fixed capture deadline', () => {
  const route = ROUTES[0]
  const issue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    status: 'issued',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder: '0x' + '1'.repeat(40),
    case: { assetsRaw: '100' },
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
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder: issue.holder,
    assetsRaw: '100',
    horizonHours: 1,
    targetAtUtc: issue.targets[0].targetAtUtc,
    captureDeadlineUtc: issue.targets[0].captureDeadlineUtc,
    scoredAtUtc: '2026-09-30T03:00:00.001Z',
    outcome: 'censored_capture_window_missed',
    target: null,
    targetWitness: null,
    evidence: null,
  }
  assert.equal(validateScore(score, [issue]), score)
  assert.throws(
    () => validateScore({ ...score, scoredAtUtc: '2026-09-30T03:00:00.000Z' }, [issue]),
    /holder_score_censor_invalid/,
  )
  assert.throws(
    () => validateScore({ ...score, issueSha256: 'b'.repeat(64) }, [issue]),
    /holder_score_issue_binding_invalid/,
  )
})

test('offline target proof binds adjacent parent and finalized boundary', () => {
  const a = `0x${'a'.repeat(64)}`
  const b = `0x${'b'.repeat(64)}`
  const at = '2026-09-30T01:00:00.000Z'
  const parentAt = '2026-09-30T00:59:48.000Z'
  const observed = '2026-09-30T01:02:00.000Z'
  const issue = {
    baseline: { targetBlock: '10', targetHash: a, targetBlockAt: '2026-09-30T00:00:00.000Z' },
  }
  const plan = { targetAtUtc: at, captureDeadlineUtc: '2026-09-30T03:00:00.000Z' }
  const target = {
    targetBlock: '11',
    targetHash: b,
    targetParentBlock: '10',
    targetParentHash: a,
    parentHeaderHash: a,
    targetParentBlockAt: parentAt,
    targetBlockAt: at,
    targetObservedAt: observed,
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      chainId: '1',
      finalityTag: 'finalized',
      source: SCORE_STUDY,
      targetAt: at,
      observedAt: observed,
      baselineHeader: { number: '10', hash: a, timestamp: issue.baseline.targetBlockAt },
      targetHeader: { number: '11', hash: b, parentHash: a, timestamp: at },
      parentHeader: { number: '10', hash: a, timestamp: parentAt },
      finalizedHead: { number: '12', timestamp: '2026-09-30T01:00:12.000Z' },
    },
  }
  assert.equal(validateTarget(target, issue, plan, observed, SCORE_STUDY), undefined)
  assert.throws(
    () => validateTarget({ ...target, targetParentHash: b }, issue, plan, observed, SCORE_STUDY),
    /holder_score_target_boundary_invalid/,
  )
  assert.throws(
    () =>
      validateTarget(
        {
          ...target,
          canonicalityEvidenceDoc: {
            ...target.canonicalityEvidenceDoc,
            finalizedHead: { number: '10', timestamp: '2026-09-30T01:00:12.000Z' },
          },
        },
        issue,
        plan,
        observed,
        SCORE_STUDY,
      ),
    /holder_score_target_boundary_invalid/,
  )
})

test('attempt receipt binds route, slot, clock, and sanitized origin failures', () => {
  const route = ROUTES[0]
  const startedAtUtc = '2026-09-30T00:14:00.000Z'
  const attempt = {
    study: 'carry_local_morpho_holder_attempt_v1',
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    slot: Math.floor(Date.parse(startedAtUtc) / (15 * 60_000)),
    startedAtUtc,
    finishedAtUtc: '2026-09-30T00:15:00.000Z',
    status: 'origin_unavailable',
    issueSha256: null,
    originFailures: { candidate_logs_unavailable: 2 },
  }
  assert.equal(validateAttempt(attempt), attempt)
  assert.throws(
    () => validateAttempt({ ...attempt, slot: attempt.slot + 1 }),
    /holder_attempt_invalid/,
  )
  assert.throws(
    () => validateAttempt({ ...attempt, originFailures: { 'https://secret.example': 1 } }),
    /holder_attempt_invalid/,
  )
})
