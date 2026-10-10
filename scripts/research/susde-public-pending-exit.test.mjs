import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  SILO,
  USDE,
  VAULT,
  WITHDRAW_TOPIC,
  appendLedger,
  finalizedAnchor,
  measureTwoOrigins,
  publicOriginPairs,
  readLedger,
  seal,
} from './susde-public-pending-exit-common.mjs'
import {
  buildIssue,
  findPendingCandidate,
  issuePending,
  validateIssue,
  verifyIssues,
} from './susde-public-pending-exit-issue.mjs'
import {
  assertSecondaryFinalizedTarget,
  buildScore,
  classifyPendingOutcome,
  scorePending,
  validateScore,
} from './susde-public-pending-exit-score.mjs'

const abi = parseAbi([
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function decimals() view returns (uint8)',
  'function cooldownDuration() view returns (uint24)',
  'function cooldowns(address) view returns (uint104,uint256)',
  'function unstake(address)',
])
const tokenAbi = parseAbi(['function decimals() view returns (uint8)'])
const HOLDER = '0x1111111111111111111111111111111111111111'
const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`
const TX = `0x${'c'.repeat(64)}`
const parent = `0x${'d'.repeat(64)}`
const baseAt = '2026-09-30T00:00:00.000Z'
const issuedAt = '2026-09-30T00:01:00.000Z'
const endAt = '2026-09-30T00:30:00.000Z'
const q = 10n ** 18n
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const data = `0x${q.toString(16).padStart(64, '0')}${q.toString(16).padStart(64, '0')}`
const discovery = {
  address: VAULT,
  topics: [WITHDRAW_TOPIC, topic(HOLDER), topic(SILO), topic(HOLDER)],
  data,
  blockNumber: '0x1',
  blockHash: HASH_B,
  transactionHash: TX,
  logIndex: '0x0',
  removed: false,
}
const receipt = {
  status: '0x1',
  transactionHash: TX,
  blockHash: HASH_B,
  blockNumber: '0x1',
  logs: [discovery],
}

function mock(provider, opts = {}) {
  const pending = opts.pending ?? q
  const end = opts.end ?? BigInt(Date.parse(endAt) / 1000)
  const blockNumber = opts.blockNumber ?? '0x2'
  const blockHash = opts.blockHash ?? HASH_A
  const timestamp = opts.timestamp ?? `0x${Math.floor(Date.parse(baseAt) / 1000).toString(16)}`
  const header = {
    number: blockNumber,
    hash: blockHash,
    parentHash: parent,
    timestamp,
    ...(opts.transactions ? { transactions: opts.transactions } : {}),
  }
  const request = async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === '0x1')
        return {
          number: '0x1',
          hash: HASH_B,
          timestamp: `0x${(Math.floor(Date.parse(baseAt) / 1000) - 12).toString(16)}`,
        }
      return header
    }
    if (method === 'eth_getCode') return params[0] === HOLDER ? '0x' : (opts.codeHex ?? '0x1234')
    if (method === 'eth_getLogs') return opts.logs ?? [discovery]
    if (method === 'eth_getTransactionReceipt')
      return opts.badReceipt ? { ...receipt, status: '0x0' } : receipt
    if (method !== 'eth_call') throw Error('unexpected_mock_method')
    const call = params[0]
    if (params[1]?.blockHash !== blockHash || params[1].requireCanonical !== true)
      throw Error('missing_eip1898_pin')
    if (call.data === encodeFunctionData({ abi, functionName: 'asset' }))
      return encodeFunctionResult({ abi, functionName: 'asset', result: USDE })
    if (call.data === encodeFunctionData({ abi, functionName: 'silo' }))
      return encodeFunctionResult({ abi, functionName: 'silo', result: SILO })
    if (
      call.data === encodeFunctionData({ abi, functionName: 'decimals' }) ||
      call.data === encodeFunctionData({ abi: tokenAbi, functionName: 'decimals' })
    )
      return encodeFunctionResult({ abi, functionName: 'decimals', result: 18 })
    if (call.data === encodeFunctionData({ abi, functionName: 'cooldownDuration' }))
      return encodeFunctionResult({ abi, functionName: 'cooldownDuration', result: 86400 })
    if (call.data === encodeFunctionData({ abi, functionName: 'cooldowns', args: [HOLDER] }))
      return encodeFunctionResult({ abi, functionName: 'cooldowns', result: [end, pending] })
    if (call.data === encodeFunctionData({ abi, functionName: 'unstake', args: [HOLDER] })) {
      if (call.from !== HOLDER) throw Error('wrong_claim_sender')
      if (opts.genericCode3) {
        const error = Error('public_rpc_unavailable')
        error.code = 3
        throw error
      }
      if (opts.revert) {
        const error = Error('execution reverted')
        error.code = 3
        throw error
      }
      return '0x'
    }
    throw Error('unexpected_mock_call')
  }
  const send = async (envelope) => {
    try {
      return {
        jsonrpc: '2.0',
        id: envelope.id,
        result: await request(envelope.method, envelope.params),
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: envelope.id,
        error: {
          code: error.code ?? -32000,
          message: /revert/i.test(error.message) ? 'execution reverted' : 'public rpc error',
        },
      }
    }
  }
  return { provider, request, send }
}
const anchor = {
  blockNumber: '2',
  blockHash: HASH_A,
  blockAtUtc: baseAt,
  observedAtUtc: baseAt,
  primaryProvider: 'https://a.example',
  secondaryProvider: 'https://b.example',
}

test('receipt-screened public EOA with a pinned pending claim issues fixed future horizons', async () => {
  const a = mock(anchor.primaryProvider)
  const b = mock(anchor.secondaryProvider)
  const candidate = await findPendingCandidate(a, b, anchor)
  assert.equal(candidate.holder, HOLDER)
  assert.equal(candidate.measurement.pendingAssetsRaw, q.toString())
  assert.equal(candidate.measurement.claim, 'not_yet_eligible')
  const issue = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  assert.equal(issue.targets[0].targetAtUtc, '2026-09-30T01:01:00.000Z')
  assert.equal(issue.targets.at(-1).captureDeadlineUtc, '2026-10-07T02:01:00.000Z')
  assert.equal(issue.minedDeliveryProven, false)
  assert.equal(validateIssue(issue), issue)
  assert.throws(() => validateIssue({ ...issue, pendingAssetsRaw: '2' }), /susde_issue_invalid/)
  const forged = structuredClone(issue)
  forged.screened[0].receiptProof.receiptLog.topics[2] = topic(HOLDER)
  assert.throws(() => validateIssue(forged), /susde_issue_invalid/)
})

test('invalid receipt cannot admit candidate; mismatched origin state fails closed', async () => {
  const absent = await findPendingCandidate(
    mock('https://a.example', { badReceipt: true }),
    mock('https://b.example'),
    anchor,
  )
  assert.equal(absent.holder, null)
  await assert.rejects(
    () =>
      measureTwoOrigins(
        mock('https://a.example'),
        mock('https://b.example', { pending: q * 2n }),
        anchor,
        HOLDER,
      ),
    /susde_origin_state_disagreement/,
  )
})

test('issuer distinguishes a completed empty screen from sanitized provider failure', async () => {
  const urls = [anchor.primaryProvider, anchor.secondaryProvider]
  const now = () => new Date(baseAt)
  const emptyOut = await mkdtemp(join(tmpdir(), 'susde-empty-'))
  await assert.rejects(
    () =>
      issuePending({
        urls,
        out: emptyOut,
        now,
        clients: (origins) => origins.map((provider) => mock(provider, { logs: [] })),
      }),
    (error) => {
      assert.equal(error.message, 'susde_no_screened_pending_candidate')
      assert.equal(error.diagnostic.completedNoCandidateScans, 2)
      assert.deepEqual(error.diagnostic.failures, {})
      return true
    },
  )
  const failedOut = await mkdtemp(join(tmpdir(), 'susde-provider-failed-'))
  await assert.rejects(
    () =>
      issuePending({
        urls,
        out: failedOut,
        now,
        clients: (origins) =>
          origins.map((provider) => {
            const client = mock(provider)
            return {
              ...client,
              request: async (method, params) => {
                if (method === 'eth_getLogs') throw Error('private provider detail')
                return client.request(method, params)
              },
            }
          }),
      }),
    (error) => {
      assert.equal(error.message, 'susde_public_issue_unavailable')
      assert.equal(error.diagnostic.completedNoCandidateScans, 0)
      assert.equal(error.diagnostic.failures.rpc_or_provider_unavailable, 2)
      assert.equal(JSON.stringify(error.diagnostic).includes('private provider detail'), false)
      return true
    },
  )
})

test('eligible call is simulation; queue reset and disappearance are distinct from payout', async () => {
  const future = {
    ...anchor,
    blockNumber: '3',
    blockHash: HASH_B,
    blockAtUtc: '2026-09-30T01:01:00.000Z',
  }
  const measured = await measureTwoOrigins(
    mock('https://a.example', {
      blockNumber: '0x3',
      blockHash: HASH_B,
      timestamp: `0x${Math.floor(Date.parse(future.blockAtUtc) / 1000).toString(16)}`,
    }),
    mock('https://b.example', {
      blockNumber: '0x3',
      blockHash: HASH_B,
      timestamp: `0x${Math.floor(Date.parse(future.blockAtUtc) / 1000).toString(16)}`,
    }),
    future,
    HOLDER,
  )
  // Mock header time is independent of the outcome assertion; the pinned block
  // guard itself is exercised above and in the prospective issue test.
  assert.equal(measured.minedDeliveryProven, false)
  assert.equal(measured.claim, 'simulated_unstake_success')
  const issue = { holder: HOLDER, anchor, pendingAssetsRaw: q.toString(), cooldownEndUtc: endAt }
  assert.equal(
    classifyPendingOutcome(issue, {
      ...measured,
      blockNumber: '3',
      claim: 'simulated_unstake_success',
    }),
    'simulated_whole_queue_unstake_success',
  )
  assert.equal(
    classifyPendingOutcome(issue, {
      ...measured,
      blockNumber: '3',
      cooldownEndUtc: '2026-09-30T02:00:00.000Z',
    }),
    'queue_reset_or_replaced',
  )
  assert.equal(
    classifyPendingOutcome(issue, { ...measured, blockNumber: '3', pendingAssetsRaw: '0' }),
    'queue_absent_cause_unknown',
  )
})

test('pending score retries an unfinalized target without masking an origin disagreement', async () => {
  const candidate = await findPendingCandidate(
    mock(anchor.primaryProvider),
    mock(anchor.secondaryProvider),
    anchor,
  )
  const issue = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  const issueOut = await mkdtemp(join(tmpdir(), 'susde-score-issue-'))
  const out = await mkdtemp(join(tmpdir(), 'susde-score-out-'))
  await writeFile(join(issueOut, '00000001.json'), `${JSON.stringify(issue)}\n`)
  const args = {
    issueSequence: 1,
    horizonHours: 1,
    urls: [anchor.primaryProvider, anchor.secondaryProvider],
    out,
    issueOut,
    now: () => new Date('2026-09-30T01:10:00.000Z'),
    clients: (origins) => origins.map((provider) => mock(provider)),
  }
  await assert.rejects(
    scorePending({
      ...args,
      select: async () => {
        throw Error('target_not_finalized')
      },
    }),
    /susde_score_target_not_finalized/,
  )
  let mixedCalls = 0
  await assert.rejects(
    scorePending({
      ...args,
      select: async () => {
        if (++mixedCalls === 1) throw Error('target_not_finalized')
        throw Error('rpc_http_503')
      },
    }),
    /susde_score_target_not_finalized/,
  )
  let calls = 0
  await assert.rejects(
    scorePending({
      ...args,
      select: async () => {
        if (++calls === 1) throw Error('susde_score_origin_target_disagreement')
        throw Error('target_not_finalized')
      },
    }),
    /susde_score_origin_target_disagreement/,
  )
  assert.throws(
    () =>
      assertSecondaryFinalizedTarget(
        { targetBlock: '3', targetHash: HASH_A, targetParentHash: parent },
        { hash: HASH_A, parentHash: parent },
        { number: '0x2', hash: HASH_B },
      ),
    /susde_score_target_not_finalized/,
  )
  assert.throws(
    () =>
      assertSecondaryFinalizedTarget(
        { targetBlock: '3', targetHash: HASH_A, targetParentHash: parent },
        { hash: HASH_B, parentHash: parent },
        { number: '0x2', hash: HASH_B },
      ),
    /susde_score_origin_target_disagreement/,
  )
})

test('generic JSON-RPC code 3 cannot be labeled an EVM revert', async () => {
  const future = {
    blockNumber: '3',
    blockHash: HASH_B,
    blockAtUtc: '2026-09-30T01:01:00.000Z',
  }
  const opts = {
    blockNumber: '0x3',
    blockHash: HASH_B,
    timestamp: `0x${Math.floor(Date.parse(future.blockAtUtc) / 1000).toString(16)}`,
  }
  await assert.rejects(
    () =>
      measureTwoOrigins(
        mock(anchor.primaryProvider, { ...opts, genericCode3: true }),
        mock(anchor.secondaryProvider, { ...opts, genericCode3: true }),
        future,
        HOLDER,
      ),
    /susde_rpc_unstake_unavailable/,
  )
  const reverted = await measureTwoOrigins(
    mock(anchor.primaryProvider, { ...opts, revert: true }),
    mock(anchor.secondaryProvider, { ...opts, revert: true }),
    future,
    HOLDER,
  )
  assert.equal(reverted.claim, 'unstake_revert_cause_unknown')
  assert.equal(reverted.evidence[0].calls.unstake.error.message, 'execution reverted')
})

test('rotated public origins retain sanitized send envelopes and the run budget', async () => {
  const future = {
    blockNumber: '3',
    blockHash: HASH_B,
    blockAtUtc: '2026-09-30T01:01:00.000Z',
  }
  const opts = {
    blockNumber: '0x3',
    blockHash: HASH_B,
    timestamp: `0x${Math.floor(Date.parse(future.blockAtUtc) / 1000).toString(16)}`,
  }
  const urls = [anchor.primaryProvider, anchor.secondaryProvider]
  const pair = (extra, now = () => 0) =>
    publicOriginPairs(
      urls,
      (origins) => origins.map((provider) => mock(provider, { ...opts, ...extra })),
      now,
    )[0]
  await assert.rejects(
    () => measureTwoOrigins(...pair({ genericCode3: true }), future, HOLDER),
    /susde_rpc_unstake_unavailable/,
  )
  const reverted = await measureTwoOrigins(...pair({ revert: true }), future, HOLDER)
  assert.equal(reverted.claim, 'unstake_revert_cause_unknown')
  let clock = 0
  const expired = pair({ revert: true }, () => clock)
  clock = 8 * 60_000
  await assert.rejects(
    () => expired[0].send({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }),
    /susde_rpc_budget_exhausted/,
  )
})

test('maximum-size contract bytecode is fingerprinted while pinned cooldown and unstake stay replayable', async () => {
  const codeHex = `0x${'12'.repeat(24_576)}`
  const candidate = await findPendingCandidate(
    mock(anchor.primaryProvider, { codeHex }),
    mock(anchor.secondaryProvider, { codeHex }),
    anchor,
  )
  const issue = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  assert.ok(Buffer.byteLength(JSON.stringify(issue)) < 256 * 1024)
  assert.equal(issue.measurement.evidence[0].calls.vaultCode.result.byteLength, 24_576)
  assert.equal(issue.measurement.evidence[0].calls.ownerCode.result, '0x')
  assert.equal(issue.measurement.evidence[0].calls.cooldown.result.length, 130)
  assert.equal(issue.measurement.evidence[0].calls.unstake, null)
  assert.equal(validateIssue(issue), issue)
  const forged = structuredClone(issue)
  forged.measurement.evidence[1].calls.vaultCode.result.sha256 = 'f'.repeat(64)
  delete forged.sha256
  assert.throws(() => validateIssue(seal(forged)), /susde_origin_code_disagreement/)
  await assert.rejects(
    () =>
      measureTwoOrigins(
        mock(anchor.primaryProvider, { codeHex }),
        mock(anchor.secondaryProvider, { codeHex: '0x5678' }),
        anchor,
        HOLDER,
      ),
    /susde_origin_code_disagreement/,
  )
})

test('large transaction lists are omitted from pinned header evidence and resealed changes fail', async () => {
  const transactions = Array.from(
    { length: 5_000 },
    (_, index) => `0x${index.toString(16).padStart(64, '0')}`,
  )
  const candidate = await findPendingCandidate(
    mock(anchor.primaryProvider, { transactions }),
    mock(anchor.secondaryProvider, { transactions }),
    anchor,
  )
  const issue = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  assert.ok(Buffer.byteLength(JSON.stringify(issue.measurement.evidence)) < 64 * 1024)
  assert.deepEqual(Object.keys(issue.measurement.evidence[0].calls.header.result), [
    'number',
    'hash',
    'parentHash',
    'timestamp',
  ])
  assert.equal(validateIssue(issue), issue)
  const forged = structuredClone(issue)
  forged.measurement.evidence[1].calls.header.result.parentHash = HASH_B
  forged.measurement.evidence[1].calls.again.result.parentHash = HASH_B
  delete forged.sha256
  assert.throws(() => validateIssue(seal(forged)), /susde_origin_header_disagreement/)
  const changedBetweenReads = structuredClone(issue)
  changedBetweenReads.measurement.evidence[0].calls.again.result.parentHash = HASH_B
  delete changedBetweenReads.sha256
  assert.throws(() => validateIssue(seal(changedBetweenReads)), /susde_evidence_block_changed/)
})

test('offline verifier rejects resealed baseline summaries that contradict raw pinned responses', async () => {
  const candidate = await findPendingCandidate(
    mock(anchor.primaryProvider),
    mock(anchor.secondaryProvider),
    anchor,
  )
  const issued = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  const forgedClaim = structuredClone(issued)
  forgedClaim.measurement.claim = 'simulated_unstake_success'
  delete forgedClaim.sha256
  assert.throws(() => validateIssue(seal(forgedClaim)), /susde_measurement_summary_invalid/)
  const forgedRaw = structuredClone(issued)
  forgedRaw.measurement.evidence[0].calls.cooldown.result = encodeFunctionResult({
    abi,
    functionName: 'cooldowns',
    result: [0n, 0n],
  })
  delete forgedRaw.sha256
  assert.throws(() => validateIssue(seal(forgedRaw)), /susde_measurement_summary_invalid/)
  const forgedPin = structuredClone(issued)
  forgedPin.measurement.evidence[1].calls.cooldown.request.params[1].blockHash = HASH_B
  delete forgedPin.sha256
  assert.throws(() => validateIssue(seal(forgedPin)), /susde_evidence_invalid/)
})

test('late scores are censored and cannot carry retrospective measurements', async () => {
  const candidate = await findPendingCandidate(
    mock(anchor.primaryProvider),
    mock(anchor.secondaryProvider),
    anchor,
  )
  const issue = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  const score = buildScore({
    issue,
    issues: [issue],
    horizonHours: 1,
    target: null,
    measurement: null,
    scoredAtUtc: '2026-09-30T03:02:00.000Z',
    sequence: 1,
    previousSha256: null,
  })
  assert.equal(score.outcome, 'capture_window_missed')
  assert.equal(validateScore(score, [issue]), score)
  assert.throws(
    () =>
      buildScore({
        issue,
        issues: [issue],
        horizonHours: 1,
        target: { targetBlock: '3' },
        measurement: candidate.measurement,
        scoredAtUtc: '2026-09-30T03:02:00.000Z',
        sequence: 1,
        previousSha256: null,
      }),
    /susde_score_late_measurement_forbidden/,
  )
})

test('on-time score binds the first finalized boundary and same pending owner', async () => {
  const candidate = await findPendingCandidate(
    mock(anchor.primaryProvider),
    mock(anchor.secondaryProvider),
    anchor,
  )
  const issue = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  const targetBlockAt = issue.targets[0].targetAtUtc
  const measured = await measureTwoOrigins(
    mock(anchor.primaryProvider, {
      blockNumber: '0x3',
      blockHash: HASH_B,
      timestamp: `0x${Math.floor(Date.parse(targetBlockAt) / 1000).toString(16)}`,
    }),
    mock(anchor.secondaryProvider, {
      blockNumber: '0x3',
      blockHash: HASH_B,
      timestamp: `0x${Math.floor(Date.parse(targetBlockAt) / 1000).toString(16)}`,
    }),
    { blockNumber: '3', blockHash: HASH_B, blockAtUtc: targetBlockAt },
    HOLDER,
  )
  const target = {
    targetBlock: '3',
    targetHash: HASH_B,
    targetBlockAt,
    targetParentBlock: '2',
    targetParentHash: HASH_A,
    targetParentBlockAt: baseAt,
    targetObservedAt: '2026-09-30T01:02:00.000Z',
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      chainId: '1',
      finalityTag: 'finalized',
      provider: anchor.primaryProvider,
      targetAt: targetBlockAt,
      observedAt: '2026-09-30T01:02:00.000Z',
      baselineHeader: { number: '2', hash: HASH_A },
      targetHeader: { number: '3', hash: HASH_B, parentHash: HASH_A, timestamp: targetBlockAt },
      parentHeader: { number: '2', hash: HASH_A, timestamp: baseAt },
    },
  }
  const score = buildScore({
    issue,
    issues: [issue],
    horizonHours: 1,
    target,
    measurement: measured,
    scoredAtUtc: '2026-09-30T01:03:00.000Z',
    sequence: 1,
    previousSha256: null,
  })
  assert.equal(score.outcome, 'simulated_whole_queue_unstake_success')
  assert.equal(score.minedDeliveryProven, false)
  const observedBeforeBlock = new Date(Date.parse(targetBlockAt) - 1_000).toISOString()
  const negativeLag = structuredClone(score)
  negativeLag.target.targetObservedAt = observedBeforeBlock
  negativeLag.target.canonicalityEvidenceDoc.observedAt = observedBeforeBlock
  delete negativeLag.sha256
  assert.throws(() => validateScore(seal(negativeLag), [issue]), /susde_score_target_invalid/)
  assert.throws(
    () =>
      validateScore({ ...score, target: { ...target, targetParentBlockAt: targetBlockAt } }, [
        issue,
      ]),
    /susde_score_target_invalid/,
  )
  assert.throws(
    () => validateScore({ ...score, measurement: { ...measured, holder: SILO } }, [issue]),
    /susde_score_measurement_invalid/,
  )
  const forged = structuredClone(score)
  forged.measurement.evidence[0].calls.unstake = {
    ...forged.measurement.evidence[0].calls.unstake,
    error: { code: 3, message: 'execution reverted' },
  }
  delete forged.measurement.evidence[0].calls.unstake.result
  delete forged.sha256
  assert.throws(() => validateScore(seal(forged), [issue]), /susde_measurement_summary_invalid/)
})

test('atomic numbered ledger detects a modified record and refuses a second sequence', async () => {
  const out = await mkdtemp(join(tmpdir(), 'susde-ledger-'))
  const candidate = await findPendingCandidate(
    mock(anchor.primaryProvider),
    mock(anchor.secondaryProvider),
    anchor,
  )
  const issue = buildIssue({
    anchor,
    candidate,
    issuedAtUtc: issuedAt,
    sequence: 1,
    previousSha256: null,
  })
  const sufficientDisk = () => ({ bavail: 2_000_000, bsize: 4096 })
  await appendLedger(out, issue, verifyIssues, sufficientDisk)
  assert.equal((await verifyIssues(out)).length, 1)
  await assert.rejects(
    () => appendLedger(out, issue, verifyIssues, sufficientDisk),
    /susde_ledger_changed/,
  )
  const bytes = await readFile(join(out, '00000001.json'), 'utf8')
  assert.equal(JSON.parse(bytes).sha256, issue.sha256)
  assert.equal((await readLedger(out)).length, 1)
  assert.equal(seal({ x: 1 }).sha256.length, 64)
})

test('baseline anchor requires two matching finalized headers', async () => {
  const now = () => new Date(baseAt)
  const a = mock('https://a.example')
  const b = mock('https://b.example')
  const result = await finalizedAnchor(a, b, now)
  assert.equal(result.blockHash, HASH_A)
  await assert.rejects(
    () => finalizedAnchor(a, mock('https://b.example', { blockHash: HASH_B }), now),
    /susde_anchor_disagreement/,
  )
})
