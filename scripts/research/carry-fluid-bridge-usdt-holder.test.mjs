import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseAbi, toEventSelector } from 'viem'
import {
  HORIZONS,
  ORIGINS,
  ROUTE,
  ROUTE_LEG,
  USDC,
  USDT,
  VAULT,
  append,
  assayPair,
  commonFinalized,
  configuredUrls,
  discoverFrozenSeedHolder,
  discoverHolder,
  issue,
  publicCounts,
  projection,
  qLadder,
  readChain,
  readFrozenSeedCandidates,
  score,
  verifyCandidateProof,
  verifyLedgers,
} from './carry-fluid-bridge-usdt-holder.mjs'

// Fixture writes are tiny; keep the production reserve guard outside test roots.
const statfsSync = fs.statfsSync
fs.statfsSync = (path, ...options) => {
  const stats = statfsSync(path, ...options)
  if (!String(path).startsWith(join(tmpdir(), 'fluid-bridge-holder-'))) return stats
  return {
    ...stats,
    bavail: Math.max(Number(stats.bavail), Math.ceil((1_073_741_824 + 90_000) / stats.bsize)),
  }
}
syncBuiltinESMExports()

const holder = `0x${'1'.repeat(40)}`
const hash = `0x${'a'.repeat(64)}`
const transferTopic = toEventSelector(
  parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0],
).toLowerCase()
const temp = () => mkdtempSync(join(tmpdir(), 'fluid-bridge-holder-'))
const writeSealed = (path, row) => {
  const { sha256: _old, ...body } = row
  const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, `${JSON.stringify({ ...body, sha256 })}\n`)
}
const dataWord = `0x${'0'.repeat(63)}1`
const sourceLog = () => ({
  address: VAULT,
  blockNumber: 99,
  blockHash: hash,
  transactionHash: hash,
  logIndex: 0,
  topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
  data: dataWord,
})

function measurement(qRaw, blockNumber = 100, assayOwner = holder) {
  return {
    blockNumber,
    blockHash: hash,
    assayOwner,
    routeKey: ROUTE,
    vault: {
      address: VAULT,
      assetAddress: USDC,
      assetDecimals: 6,
      implementationSourceAttested: false,
      kind: 'fluid_bridge_usdc_first_leg',
    },
    position: { holderSharesRaw: '1000', maxWithdrawAssetsRaw: '1000', previewSharesRaw: qRaw },
    request: { assetsRaw: qRaw, assetUnit: 'USDC' },
    routeLeg: ROUTE_LEG,
    simulation: { status: 'success', sharesBurnedRaw: qRaw },
  }
}

test('USDT route evidence stays bound to USDC first leg and unassessed USDT payout', () => {
  const measured = measurement('100')
  assert.equal(projection(measured).routeLeg.usdtReceipt, 'unassessed')
  assert.throws(
    () => projection({ ...measured, routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]' }),
    /assay_identity/,
  )
  assert.throws(() => projection({ ...measured, routeLeg: undefined }), /assay_identity/)
  assert.throws(
    () => projection({ ...measured, routeLeg: { ...ROUTE_LEG, usdtReceipt: 'delivered' } }),
    /assay_identity/,
  )
  assert.throws(
    () => projection({ ...measured, request: { ...measured.request, assetUnit: 'USDT' } }),
    /assay_identity/,
  )
})

function issueBody(atMs) {
  const issuedAtUtc = new Date(atMs).toISOString()
  const qRaw = qLadder('1000')
  return {
    slot: Math.floor(atMs / (30 * 60_000)),
    issuedAtUtc,
    routeKey: ROUTE,
    destination: VAULT,
    asset: USDC,
    finalAsset: USDT,
    holder,
    candidate: {
      holder,
      sharesRaw: '1000',
      maxWithdrawRaw: '1000',
      sourceTx: hash,
      sourceBlock: 99,
      sourceAttestation: 'two_origin_log_query',
      sourceProof: {
        scanRange: { fromBlock: 37, toBlock: 100 },
        primaryLog: sourceLog(),
        secondaryEvidence: { kind: 'range_log', log: sourceLog() },
      },
    },
    qRaw,
    origins: ORIGINS,
    baseline: {
      blockNumber: 100,
      blockHash: hash,
      blockTimestamp: Math.floor(atMs / 1000) - 60,
      cases: qRaw.map((q) => ({ qRaw: q, measurement: measurement(q) })),
    },
    targets: HORIZONS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(atMs + horizonHours * 3_600_000).toISOString(),
      deadlineAtUtc: new Date(atMs + (horizonHours + 2) * 3_600_000).toISOString(),
    })),
    payoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
  }
}

function seededIssueBody(atMs) {
  const body = issueBody(atMs)
  const seedStartIndex = body.slot % 15
  const owner = readFrozenSeedCandidates().owners[seedStartIndex]
  body.holder = owner
  body.candidateSource = 'frozen_seed'
  body.candidate = {
    holder: owner,
    sharesRaw: '1000',
    maxWithdrawRaw: '1000',
    sourceAttestation: 'frozen_route_borrower_seed',
    sourceProof: {
      seedPath: 'scripts/route-cohort/aug-2026-ab-vault-seed.json',
      seedSha256: readFrozenSeedCandidates().sha256,
      routeKey: ROUTE,
      vault: VAULT,
      owner,
      blockNumber: body.baseline.blockNumber,
      blockHash: body.baseline.blockHash,
      candidateScope: 'historical_route_borrower_not_signer',
      seedStartIndex,
      seedSelectionIndex: seedStartIndex,
      screenedCandidates: 1,
      readings: ORIGINS.map((origin) => ({
        origin,
        code: '0x',
        sharesRaw: '1000',
        maxWithdrawRaw: '1000',
      })),
    },
  }
  body.baseline.cases = body.qRaw.map((q) => ({ qRaw: q, measurement: measurement(q, 100, owner) }))
  return body
}

test('bounded Q ladder and two agreeing finalized headers', async () => {
  assert.deepEqual(qLadder('1000'), ['10', '100', '250', '500', '1000'])
  const client = {
    getBlock: async ({ blockTag }) =>
      blockTag === 'finalized'
        ? { number: 101n, hash, timestamp: 1000n }
        : { number: 101n, hash, timestamp: 1000n },
  }
  assert.deepEqual(await commonFinalized([client, client], 1_001_000), {
    number: 101,
    hash,
    timestamp: 1000,
  })
  await assert.rejects(
    commonFinalized(
      [
        client,
        { getBlock: async () => ({ number: 101n, hash: `0x${'b'.repeat(64)}`, timestamp: 1000n }) },
      ],
      1_001_000,
    ),
    /finalized_disagreement/,
  )
})

test('configured USDT sources select independent Ankr and Alchemy hosts', () => {
  const ankr = 'https://rpc.ankr.com/eth'
  const alchemy = 'https://eth-mainnet.g.alchemy.com/v2/example'
  const drpc = 'https://lb.drpc.live/eth'
  assert.deepEqual(ORIGINS, ['https://rpc.ankr.com', 'https://eth-mainnet.g.alchemy.com'])
  assert.deepEqual(configuredUrls(`${drpc},${alchemy},${ankr}`), [ankr, alchemy])
  assert.throws(() => configuredUrls(`${drpc},${ankr}`), /two_origins_required/)
})

test('frozen borrower seed requires the exact physical file and 15 route-vault owners', () => {
  const seed = readFrozenSeedCandidates()
  assert.equal(seed.owners.length, 15)
  assert.equal(new Set(seed.owners).size, 15)
  const root = temp()
  try {
    const changed = join(root, 'seed.json')
    writeFileSync(changed, '{}')
    assert.throws(() => readFrozenSeedCandidates(changed), /seed_integrity/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('frozen seed discovery demands two agreeing pinned raw EOA and positive claims', async () => {
  const block = { number: 101, hash }
  const pinned = { blockHash: hash, requireCanonical: true }
  let reads = 0
  const client = {
    request: async ({ method, params }) => {
      reads++
      assert.equal(method, 'eth_getCode')
      assert.deepEqual(params[1], pinned)
      return '0x'
    },
    readContract: async ({ blockHash, requireCanonical, functionName }) => {
      reads++
      assert.equal(blockHash, hash)
      assert.equal(requireCanonical, true)
      return functionName === 'balanceOf' ? 1000n : 500n
    },
  }
  const found = await discoverFrozenSeedHolder([client, client], block)
  assert.equal(found.sourceAttestation, 'frozen_route_borrower_seed')
  assert.equal(found.sourceProof.owner, readFrozenSeedCandidates().owners[0])
  assert.equal(found.sourceProof.readings.length, 2)
  assert.equal(reads, 6)
  const rotated = await discoverFrozenSeedHolder([client, client], block, Date.now, () => {}, 7)
  assert.equal(rotated.sourceProof.seedStartIndex, 7)
  assert.equal(rotated.sourceProof.seedSelectionIndex, 7)
  assert.equal(rotated.holder, readFrozenSeedCandidates().owners[7])
  const disagree = {
    ...client,
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1000n : 501n),
  }
  await assert.rejects(
    discoverFrozenSeedHolder([client, disagree], block),
    /seed_origin_disagreement/,
  )
  const noClaim = {
    ...client,
    readContract: async () => 0n,
  }
  assert.equal(await discoverFrozenSeedHolder([noClaim, noClaim], block), null)
})

test('seed proof verifier rejects fake transfer, outsider, changed pin and assay state', () => {
  const atMs = Date.parse('2026-10-02T03:00:00.000Z')
  const good = seededIssueBody(atMs)
  const variants = [
    (body) => {
      body.candidate.sourceTx = hash
    },
    (body) => {
      body.candidate.sourceProof.primaryLog = sourceLog()
    },
    (body) => {
      body.candidate.holder = holder
      body.holder = holder
      body.candidate.sourceProof.owner = holder
    },
    (body) => {
      body.candidate.sourceProof.seedSha256 = '0'.repeat(64)
    },
    (body) => {
      body.candidate.sourceProof.blockHash = `0x${'b'.repeat(64)}`
    },
    (body) => {
      body.candidate.sourceProof.readings[1].origin = ORIGINS[0]
    },
    (body) => {
      body.candidate.sourceProof.seedStartIndex =
        (body.candidate.sourceProof.seedStartIndex + 1) % 15
    },
    (body) => {
      body.baseline.cases[0].measurement.position.holderSharesRaw = '999'
    },
  ]
  const goodRoot = temp()
  try {
    append('issues', good, goodRoot)
    assert.equal(verifyLedgers(goodRoot).issues.length, 1)
  } finally {
    rmSync(goodRoot, { recursive: true, force: true })
  }
  for (const mutate of variants) {
    const root = temp()
    try {
      const body = seededIssueBody(atMs)
      mutate(body)
      append('issues', body, root)
      assert.throws(() => verifyLedgers(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function seedAssayClient(block) {
  return {
    getChainId: async () => 1,
    getBlock: async () => block,
    request: async ({ method, params }) => {
      assert.equal(method, 'eth_getCode')
      assert.equal(params[1].blockHash, hash)
      return '0x'
    },
    getCode: async () => '0x1234',
    readContract: async ({ functionName }) => {
      if (functionName === 'asset') return USDC
      if (functionName === 'decimals') return 6n
      return 1000n
    },
    call: async () => ({ data: `0x${'0'.repeat(63)}1` }),
  }
}

test('explicit seed mode can issue only a pinned USDC first-leg assay', async () => {
  const root = temp()
  try {
    const nowMs = Math.floor(Date.now() / (30 * 60_000)) * (30 * 60_000)
    const block = {
      number: 101n,
      hash,
      timestamp: BigInt(Math.floor((nowMs - 60_000) / 1000)),
    }
    const client = seedAssayClient(block)
    const result = await issue({
      clients: [client, client],
      nowMs,
      clock: () => nowMs,
      candidateSource: 'frozen_seed',
      root,
    })
    assert.equal(result.status, 'issued')
    assert.equal(result.candidateSource, 'frozen_seed')
    const saved = verifyLedgers(root).issues[0]
    assert.equal(saved.candidate.sourceAttestation, 'frozen_route_borrower_seed')
    assert.equal(saved.payoutAssessment, 'usdc_first_leg_only_usdt_unassessed')
    assert.equal(saved.baseline.cases.length, 5)
    assert.equal(publicCounts(root).candidateEvidenceScope, 'frozen_route_borrower_seed_only')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('seed issue crossing its selection slot is censored before any issue append', async () => {
  const root = temp()
  try {
    const nowMs = Math.floor(Date.now() / (30 * 60_000)) * (30 * 60_000) - 30_000
    const completedAtMs = nowMs + 60_000
    const block = {
      number: 101n,
      hash,
      timestamp: BigInt(Math.floor((nowMs - 60_000) / 1000)),
    }
    const client = seedAssayClient(block)
    const result = await issue({
      clients: [client, client],
      nowMs,
      clock: () => completedAtMs,
      candidateSource: 'frozen_seed',
      root,
    })
    assert.deepEqual(result, {
      status: 'source_unavailable',
      failureStage: 'completion_slot',
      candidateSource: 'frozen_seed',
    })
    const ledgers = verifyLedgers(root)
    assert.equal(ledgers.issues.length, 0)
    assert.equal(ledgers.attempts.length, 1)
    assert.equal(ledgers.attempts[0].failureStage, 'completion_slot')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two-origin share Transfer scan yields one EOA entitlement', async () => {
  const log = {
    address: VAULT,
    blockNumber: '0x65',
    blockHash: hash,
    transactionHash: hash,
    logIndex: '0x0',
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: dataWord,
  }
  const client = {
    request: async () => [log],
    getCode: async () => '0x',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1000n : 500n),
  }
  const found = await discoverHolder([client, client], { number: 101, hash }, 0)
  assert.equal(found.holder, holder)
  assert.equal(found.maxWithdrawRaw, '500')
  assert.equal(found.sourceAttestation, 'two_origin_log_query')
  assert.equal(verifyCandidateProof(found), true)
  assert.equal(found.sourceProof.primaryLog.data, dataWord)
})

test('secondary range retry covers the identical 64 blocks in contiguous eight-block chunks', async () => {
  const log = { ...sourceLog(), blockNumber: '0x65' }
  const chunks = []
  const state = {
    getCode: async () => '0x',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1000n : 500n),
  }
  const primary = { ...state, request: async () => [log] }
  const secondary = {
    ...state,
    request: async ({ params }) => {
      const { fromBlock, toBlock } = params[0]
      const from = Number(BigInt(fromBlock))
      const to = Number(BigInt(toBlock))
      if (to - from + 1 === 64) throw Error('range too large')
      chunks.push([from, to])
      return from <= 101 && to >= 101 ? [log] : []
    },
  }
  const found = await discoverHolder([primary, secondary], { number: 101, hash })
  assert.equal(found.sourceAttestation, 'two_origin_log_query')
  assert.equal(verifyCandidateProof(found), true)
  assert.deepEqual(chunks, [
    [38, 45],
    [46, 53],
    [54, 61],
    [62, 69],
    [70, 77],
    [78, 85],
    [86, 93],
    [94, 101],
  ])
})

test('secondary chunk union mismatch and incomplete chunk fail closed', async () => {
  const log = { ...sourceLog(), blockNumber: '0x65' }
  const primary = { request: async () => [log] }
  const missing = {
    request: async ({ params }) => {
      const { fromBlock, toBlock } = params[0]
      if (Number(BigInt(toBlock) - BigInt(fromBlock)) + 1 === 64) throw Error('range too large')
      return []
    },
  }
  await assert.rejects(
    discoverHolder([primary, missing], { number: 101, hash }),
    /candidate_origin_disagreement/,
  )
  const emptyPrimary = { request: async () => [] }
  const failedChunk = {
    request: async () => {
      throw Error('range unavailable')
    },
  }
  await assert.rejects(
    discoverHolder([emptyPrimary, failedChunk], { number: 1024, hash }),
    /candidate_quiet_unverified/,
  )
})

test('holder scan stops before exceeding its bounded RPC call budget', async () => {
  let calls = 0
  let windowLogs = []
  const primary = {
    request: async ({ params }) => {
      calls++
      const blockNumber = Number(BigInt(params[0].toBlock))
      windowLogs = Array.from({ length: 12 }, (_, index) => ({
        ...sourceLog(),
        blockNumber: `0x${blockNumber.toString(16)}`,
        logIndex: `0x${index.toString(16)}`,
        topics: [
          transferTopic,
          `0x${'0'.repeat(64)}`,
          `0x${(index + 1).toString(16).padStart(64, '0')}`,
        ],
      }))
      return windowLogs
    },
    getCode: async () => {
      calls++
      return '0x1234'
    },
    readContract: async () => {
      calls++
      return 1000n
    },
  }
  const secondary = {
    request: async ({ method }) => {
      calls++
      if (method === 'eth_getLogs') throw Error('range unavailable')
      return { transactionHash: hash, blockHash: hash, logs: windowLogs }
    },
    getCode: async () => {
      calls++
      return '0x1234'
    },
    readContract: async () => {
      calls++
      return 1000n
    },
  }
  await assert.rejects(
    discoverHolder([primary, secondary], { number: 1024, hash }),
    /discovery_call_budget/,
  )
  assert.ok(calls <= 256)
})

test('issue failures retain only a fixed stage in returns and append-only attempts', async () => {
  const nowMs = Date.parse('2026-10-02T03:00:00.000Z')
  const secret = 'https://private.rpc.invalid/key=secret holder=0x123'
  const block = { number: 101n, hash, timestamp: BigInt(Math.floor(nowMs / 1000) - 60) }
  const log = { ...sourceLog(), blockNumber: '0x65' }
  const base = {
    getBlock: async () => block,
    request: async () => [log],
    getCode: async () => '0x',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1000n : 500n),
  }
  const cases = [
    { expected: 'common_finalized', clients: [] },
    {
      expected: 'holder_primary_logs',
      clients: [
        {
          ...base,
          request: async () => {
            throw Error(secret)
          },
        },
        base,
      ],
    },
    {
      expected: 'holder_secondary_logs',
      clients: [
        { ...base, request: async () => [] },
        {
          ...base,
          request: async () => {
            throw Error(secret)
          },
        },
      ],
    },
    {
      expected: 'holder_secondary_receipt',
      clients: [
        base,
        {
          ...base,
          request: async () => {
            throw Error(secret)
          },
        },
      ],
    },
    {
      expected: 'holder_log_disagreement',
      clients: [base, { ...base, request: async () => [{ ...log, data: `0x${'0'.repeat(63)}2` }] }],
    },
    {
      expected: 'holder_pinned_state',
      clients: [
        {
          ...base,
          readContract: async () => {
            throw Error(secret)
          },
        },
        base,
      ],
    },
    {
      expected: 'withdraw_assay',
      clients: [
        {
          ...base,
          getChainId: async () => {
            throw Error(secret)
          },
        },
        {
          ...base,
          getChainId: async () => {
            throw Error(secret)
          },
        },
      ],
    },
  ]
  for (const { expected, clients } of cases) {
    const root = temp()
    try {
      const result = await issue({ clients, nowMs, clock: () => nowMs, root })
      assert.deepEqual(result, { status: 'source_unavailable', failureStage: expected })
      const attempt = verifyLedgers(root).attempts[0]
      assert.equal(attempt.failureStage, expected)
      assert.deepEqual(
        Object.keys(attempt).filter(
          (key) => !['study', 'kind', 'sequence', 'previousSha256', 'sha256'].includes(key),
        ),
        ['phase', 'reason', 'failureStage', 'atUtc'],
      )
      assert.equal(JSON.stringify({ result, attempt }).includes(secret), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('legacy attempts verify while arbitrary failure stages are rejected', () => {
  const root = temp()
  try {
    const atUtc = '2026-10-02T03:00:00.000Z'
    append('attempts', { phase: 'issue', reason: 'source_unavailable', atUtc }, root)
    assert.equal(verifyLedgers(root).attempts.length, 1)
    append(
      'attempts',
      {
        phase: 'issue',
        reason: 'source_unavailable',
        failureStage: 'https://private.rpc.invalid',
        atUtc,
      },
      root,
    )
    assert.throws(() => verifyLedgers(root), /attempt_invalid/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secondary receipt attests candidate when its older log range is unavailable', async () => {
  const log = {
    address: VAULT,
    blockNumber: '0x65',
    blockHash: hash,
    transactionHash: hash,
    logIndex: '0x0',
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: dataWord,
  }
  const state = {
    getCode: async () => '0x',
    readContract: async ({ functionName }) => (functionName === 'balanceOf' ? 1000n : 500n),
  }
  const primary = { ...state, request: async () => [log] }
  const secondary = {
    ...state,
    request: async ({ method }) => {
      if (method === 'eth_getLogs') throw Error('range unavailable')
      return { transactionHash: hash, blockHash: hash, logs: [log] }
    },
  }
  const found = await discoverHolder([primary, secondary], { number: 101, hash })
  assert.equal(found.sourceAttestation, 'primary_log_secondary_receipt')
  assert.equal(verifyCandidateProof(found), true)
  const falseSecondary = {
    ...secondary,
    request: async ({ method }) => {
      if (method === 'eth_getLogs') throw Error('range unavailable')
      return { transactionHash: hash, blockHash: hash, logs: [] }
    },
  }
  await assert.rejects(
    discoverHolder([primary, falseSecondary], { number: 101, hash }),
    /candidate_receipt_disagreement/,
  )
})

test('candidate scan rejects missing Transfer value and offline replay rejects source tampering', async () => {
  const invalidLog = { ...sourceLog(), blockNumber: '0x65', data: '0x' }
  const client = { request: async () => [invalidLog] }
  await assert.rejects(
    discoverHolder([client, client], { number: 101, hash }),
    /candidate_log_invalid/,
  )
  const candidate = issueBody(Date.parse('2026-10-01T00:00:00.000Z')).candidate
  assert.equal(verifyCandidateProof(candidate), true)
  assert.throws(
    () =>
      verifyCandidateProof({
        ...candidate,
        sourceProof: {
          ...candidate.sourceProof,
          secondaryEvidence: {
            kind: 'range_log',
            log: { ...sourceLog(), data: `0x${'0'.repeat(63)}2` },
          },
        },
      }),
    /candidate_proof_binding/,
  )
  assert.throws(
    () =>
      verifyCandidateProof({
        ...candidate,
        sourceProof: {
          ...candidate.sourceProof,
          secondaryEvidence: {
            kind: 'receipt_log',
            transactionHash: hash,
            blockHash: hash,
            log: sourceLog(),
          },
        },
      }),
    /candidate_proof_kind/,
  )
  const root = temp()
  try {
    const forgedBody = issueBody(Date.parse('2026-10-01T00:00:00.000Z'))
    forgedBody.candidate.sourceProof.secondaryEvidence.log.data = `0x${'0'.repeat(63)}2`
    append('issues', forgedBody, root)
    assert.throws(() => verifyLedgers(root), /candidate_proof_binding/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unavailable secondary range cannot establish an empty candidate window', async () => {
  const primary = { request: async () => [] }
  const secondary = {
    request: async () => {
      throw Error('range unavailable')
    },
  }
  await assert.rejects(
    discoverHolder([primary, secondary], { number: 2000, hash }),
    /candidate_quiet_unverified/,
  )
})

test('late score needs a finalized two-origin post-deadline witness', async () => {
  const root = temp()
  try {
    const atMs = Date.parse('2026-10-01T00:00:00.000Z')
    const saved = append('issues', issueBody(atMs), root)
    assert.equal(saved.sequence, 1)
    assert.equal(verifyLedgers(root).issues.length, 1)
    const lateMs = atMs + 3.5 * 3_600_000
    const unavailable = await score({ clients: [], nowMs: lateMs, clock: () => lateMs, root })
    assert.equal(unavailable.status, 'source_unavailable')
    assert.equal(verifyLedgers(root).scores.length, 0)
    const client = {
      getBlock: async () => ({ number: 101n, hash, timestamp: BigInt(lateMs / 1000) }),
    }
    const result = await score({
      clients: [client, client],
      nowMs: lateMs,
      clock: () => lateMs,
      root,
    })
    assert.equal(result.status, 'missed_window')
    const view = publicCounts(root)
    assert.equal(view.issuedEpisodes, 1)
    assert.equal(view.missedScores, 1)
    assert.equal(view.pendingTargets, 4)
    assert.equal(JSON.stringify(view).includes(holder), false)
    assert.equal(JSON.stringify(view).includes('1000'), false)
    assert.equal(view.calibratedForecast, false)
    assert.equal(view.assayAsset, 'USDC')
    assert.equal(view.finalPayoutAsset, 'USDT')
    assert.equal(view.conversionAssessment, 'unmeasured')
    assert.equal(view.firstLegSharedWithRoute, 'USDC → FluidBridgeAggregatorProxy [USDC]')
    const scorePath = join(root, 'scores', '00000001.json')
    const originalScore = JSON.parse(readFileSync(scorePath, 'utf8'))
    const futureBlockScore = structuredClone(originalScore)
    futureBlockScore.block.timestamp = Math.floor(Date.parse(originalScore.scoredAtUtc) / 1000) + 1
    writeSealed(scorePath, futureBlockScore)
    assert.throws(() => verifyLedgers(root), /score_censor/)
    writeFileSync(scorePath, `${JSON.stringify(originalScore)}\n`)
    const forgedScore = JSON.parse(readFileSync(scorePath, 'utf8'))
    forgedScore.block.timestamp = Math.floor((atMs + 3 * 3_600_000) / 1000)
    writeFileSync(scorePath, `${JSON.stringify(forgedScore)}\n`)
    assert.throws(() => readChain('scores', root), /ledger_chain/)
    const path = join(root, 'issues', '00000001.json')
    const forged = JSON.parse(readFileSync(path, 'utf8'))
    forged.qRaw[0] = '999999'
    writeFileSync(path, `${JSON.stringify(forged)}\n`)
    assert.throws(() => readChain('issues', root), /ledger_chain/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('live H1 target is scored before older expired targets, which remain censored', async () => {
  const root = temp()
  try {
    const nowMs = Date.now()
    append('issues', issueBody(nowMs - 6.5 * 3_600_000), root)
    append('issues', issueBody(nowMs - 1.5 * 3_600_000), root)
    const client = {
      getChainId: async () => 1,
      getBlock: async () => ({
        number: 101n,
        hash,
        timestamp: BigInt(Math.floor((nowMs - 60_000) / 1000)),
      }),
      getCode: async ({ address }) => (address.toLowerCase() === holder ? '0x' : '0x1234'),
      request: async ({ method, params }) => {
        assert.equal(method, 'eth_getCode')
        assert.equal(params[0].toLowerCase(), holder)
        assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
        return '0x'
      },
      readContract: async ({ functionName }) => {
        if (functionName === 'asset') return USDC
        if (functionName === 'decimals') return 6n
        return 1000n
      },
      call: async () => ({ data: `0x${'0'.repeat(63)}1` }),
    }
    await assayPair(
      [client, client],
      {
        number: 101,
        hash,
        timestamp: Math.floor((nowMs - 60_000) / 1000),
      },
      holder,
      '10',
    )
    const first = await score({ clients: [client, client], nowMs, clock: () => nowMs, root })
    assert.equal(first.status, 'measured')
    const [live] = verifyLedgers(root).scores
    assert.equal(live.issueSequence, 2)
    assert.equal(live.horizonHours, 1)
    assert.equal(live.status, 'measured')
    const scorePath = join(root, 'scores', '00000001.json')
    const futureBlockScore = structuredClone(live)
    futureBlockScore.block.timestamp = Math.floor(Date.parse(live.scoredAtUtc) / 1000) + 1
    writeSealed(scorePath, futureBlockScore)
    assert.throws(() => verifyLedgers(root), /score_measurement/)
    writeFileSync(scorePath, `${JSON.stringify(live)}\n`)

    const second = await score({ clients: [client, client], nowMs, clock: () => nowMs, root })
    assert.equal(second.status, 'missed_window')
    const expired = verifyLedgers(root).scores[1]
    assert.equal(expired.issueSequence, 1)
    assert.equal(expired.horizonHours, 1)
    assert.equal(expired.status, 'missed_window')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('assays completing after deadline are censored by later finalized witness', async () => {
  const root = temp()
  try {
    const nowMs = Date.now()
    const issuedMs = nowMs - 66 * 60_000
    const issueRow = append('issues', issueBody(issuedMs), root)
    const deadlineMs = Date.parse(issueRow.targets[0].deadlineAtUtc)
    const early = { number: 101n, hash, timestamp: BigInt(Math.floor((nowMs - 60_000) / 1000)) }
    const late = { number: 102n, hash, timestamp: BigInt(Math.floor((deadlineMs + 1_000) / 1000)) }
    let finalizedCalls = 0
    const client = {
      getChainId: async () => 1,
      getBlock: async ({ blockTag, blockNumber }) => {
        if (blockTag === 'finalized') {
          finalizedCalls++
          return finalizedCalls <= 2 ? early : late
        }
        return blockNumber === 101n ? early : late
      },
      getCode: async ({ address }) => (address.toLowerCase() === holder ? '0x' : '0x1234'),
      request: async ({ method }) => {
        assert.equal(method, 'eth_getCode')
        return '0x'
      },
      readContract: async ({ functionName }) => {
        if (functionName === 'asset') return USDC
        if (functionName === 'decimals') return 6n
        return 1000n
      },
      call: async () => ({ data: `0x${'0'.repeat(63)}1` }),
    }
    const delayedClock = () => deadlineMs + 10_000
    const result = await score({ clients: [client, client], nowMs, clock: delayedClock, root })
    assert.equal(result.status, 'missed_window')
    const saved = verifyLedgers(root).scores[0]
    assert.equal(saved.status, 'missed_window')
    assert.equal(saved.cases, null)
    assert.equal(saved.block.number, 102)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
