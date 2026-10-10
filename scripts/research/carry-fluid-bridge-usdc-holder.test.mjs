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
  USDC,
  VAULT,
  append,
  assayPair,
  commonFinalized,
  discoverHolder,
  publicCounts,
  qLadder,
  readChain,
  score,
  verifyLedgers,
} from './carry-fluid-bridge-usdc-holder.mjs'

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
const valueData = `0x${'0'.repeat(63)}1`
const temp = () => mkdtempSync(join(tmpdir(), 'fluid-bridge-holder-'))
const writeSealed = (path, row) => {
  const { sha256: _old, ...body } = row
  const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, `${JSON.stringify({ ...body, sha256 })}\n`)
}

function proofLog(blockNumber = 99) {
  return {
    address: VAULT,
    blockNumber,
    blockHash: hash,
    transactionHash: hash,
    logIndex: 0,
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: valueData,
  }
}

function sourceProof(log = proofLog()) {
  return {
    range: { fromBlock: 37, toBlock: 100 },
    primary: { origin: ORIGINS[0], method: 'eth_getLogs', log },
    secondary: { origin: ORIGINS[1], method: 'eth_getLogs', log: { ...log }, receipt: null },
  }
}

function measurement(qRaw, blockNumber = 100) {
  return {
    blockNumber,
    blockHash: hash,
    assayOwner: holder,
    routeKey: ROUTE,
    vault: {
      address: VAULT,
      assetAddress: USDC,
      assetDecimals: 6,
      implementationSourceAttested: false,
    },
    position: { holderSharesRaw: '1000', maxWithdrawAssetsRaw: '1000', previewSharesRaw: qRaw },
    request: { assetsRaw: qRaw, assetUnit: 'USDC' },
    simulation: { status: 'success', sharesBurnedRaw: qRaw },
  }
}

function issueBody(atMs) {
  const issuedAtUtc = new Date(atMs).toISOString()
  const qRaw = qLadder('1000')
  return {
    slot: Math.floor(atMs / (30 * 60_000)),
    issuedAtUtc,
    routeKey: ROUTE,
    destination: VAULT,
    asset: USDC,
    holder,
    candidate: {
      holder,
      sharesRaw: '1000',
      maxWithdrawRaw: '1000',
      sourceTx: hash,
      sourceBlock: 99,
      sourceAttestation: 'two_origin_log_query',
      sourceProof: sourceProof(),
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
    payoutAssessment: 'first_leg_simulation_only',
  }
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

test('two-origin share Transfer scan yields one EOA entitlement', async () => {
  const log = {
    address: VAULT,
    blockNumber: '0x65',
    blockHash: hash,
    transactionHash: hash,
    logIndex: '0x0',
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: valueData,
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
})

test('secondary receipt attests candidate when its older log range is unavailable', async () => {
  const log = {
    address: VAULT,
    blockNumber: '0x65',
    blockHash: hash,
    transactionHash: hash,
    logIndex: '0x0',
    topics: [transferTopic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${holder.slice(2)}`],
    data: valueData,
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

test('Transfer requires canonical nonzero uint256 data and replayable source binding', async () => {
  const malformed = { ...proofLog(101), blockNumber: '0x65', logIndex: '0x0', data: '0x' }
  const client = { request: async () => [malformed] }
  await assert.rejects(
    discoverHolder([client, client], { number: 101, hash }),
    /candidate_log_invalid/,
  )
  const root = temp()
  try {
    const atMs = Date.parse('2026-10-01T00:00:00.000Z')
    const saved = append('issues', issueBody(atMs), root)
    assert.equal(verifyLedgers(root).issues.length, 1)
    const path = join(root, 'issues', '00000001.json')
    const forged = JSON.parse(readFileSync(path, 'utf8'))
    forged.candidate.sourceProof.secondary.log.data = `0x${'0'.repeat(63)}2`
    const { sha256: _old, ...body } = forged
    forged.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    writeFileSync(path, `${JSON.stringify(forged)}\n`)
    assert.equal(readChain('issues', root).length, 1)
    assert.throws(() => verifyLedgers(root), /candidate_source_proof/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fallback receipt hash and selected log are replayed by offline verification', () => {
  const root = temp()
  try {
    const body = issueBody(Date.parse('2026-10-01T00:00:00.000Z'))
    body.candidate.sourceAttestation = 'primary_log_secondary_receipt'
    body.candidate.sourceProof.secondary.method = 'eth_getTransactionReceipt'
    body.candidate.sourceProof.secondary.receipt = { transactionHash: hash, blockHash: hash }
    append('issues', body, root)
    assert.equal(verifyLedgers(root).issues.length, 1)
    const path = join(root, 'issues', '00000001.json')
    const forged = JSON.parse(readFileSync(path, 'utf8'))
    forged.candidate.sourceProof.secondary.receipt.blockHash = `0x${'b'.repeat(64)}`
    const { sha256: _old, ...unsealed } = forged
    forged.sha256 = createHash('sha256').update(JSON.stringify(unsealed)).digest('hex')
    writeFileSync(path, `${JSON.stringify(forged)}\n`)
    assert.throws(() => verifyLedgers(root), /candidate_source_proof/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
