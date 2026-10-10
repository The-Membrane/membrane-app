import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { toHex } from 'viem'
import {
  baselineSize,
  collectHolderLogs,
  replayTransfers,
  selectFirstDistinct,
  TRANSFER_TOPIC,
  validateCachedResults,
} from './morpho-v2-exit-baseline-pilot.mjs'

const a = '0x1111111111111111111111111111111111111111'
const b = '0x2222222222222222222222222222222222222222'
const vault = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const hash = `0x${'3'.repeat(64)}`
const tx = `0x${'4'.repeat(64)}`
const zero = `0x${'0'.repeat(40)}`
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const log = (block, index, from, to, amount) => ({
  address: vault,
  blockNumber: toHex(block),
  blockHash: hash,
  transactionHash: tx,
  logIndex: toHex(index),
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: toHex(amount, { size: 32 }),
})
const ledgerLog = (block, index, from, to, value) => ({
  block,
  logIndex: index,
  blockHash: hash,
  txHash: tx,
  from,
  to,
  value: String(value),
})

test('chronological independent selection deduplicates vaults before the 20-vault cap', () => {
  const stage1 = {
    study: 'morpho-v2-cap-submit-stage1-v1',
    status: 'complete',
    chainId: 1,
    factoryArtifactSha256: '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa',
    coverage: { complete: true },
    summary: { independentEligibleCount: 21, independentEligibleProposalIndexes: [0, 1, 2] },
    proposals: [
      { vault: a, block: 11, txHash: tx, timestamp: 100, qualifyingLegCount: 1 },
      { vault: a, block: 20, txHash: tx, timestamp: 200, qualifyingLegCount: 1 },
      { vault: b, block: 30, txHash: tx, timestamp: 300, qualifyingLegCount: 1 },
    ],
  }
  const factory = {
    study: 'morpho-v2-factory-create-v1',
    status: 'complete',
    chainId: 1,
    events: [
      { vault: a, block: 1, txHash: tx },
      { vault: b, block: 2, txHash: tx },
    ],
  }
  assert.deepEqual(
    selectFirstDistinct(stage1, factory, 2).map((x) => x.proposalIndex),
    [0, 2],
  )
  assert.throws(() => selectFirstDistinct(stage1, factory, 21), /1..20/)
})

test('Transfer replay handles mint, move, burn and rejects underflow; q floors both caps', () => {
  const logs = [
    ledgerLog(1, 0, zero, a, 100),
    ledgerLog(2, 0, a, b, 30),
    ledgerLog(3, 0, b, zero, 10),
  ]
  assert.deepEqual(replayTransfers(logs), [
    [a, 70n],
    [b, 20n],
  ])
  assert.throws(() => replayTransfers([ledgerLog(1, 0, a, b, 1)]), /underflow/)
  assert.equal(baselineSize(100_999n, 500n), 50n)
  assert.equal(baselineSize(100_999n, 5000n), 100n)
  assert.equal(baselineSize(999n, 5000n), 0n)
})

test('bounded raw-log checkpoint resumes without rereading completed ranges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-exit-test-'))
  const rawPath = join(dir, 'raw.json')
  const anchor = { vault, block: 7, creationBlock: 1, proposalIndex: 0 }
  const calls = []
  let fail = true
  const client = {
    async request({ method, params: [filter] }) {
      assert.equal(method, 'eth_getLogs')
      const first = Number(BigInt(filter.fromBlock)),
        last = Number(BigInt(filter.toBlock))
      calls.push([first, last])
      assert.deepEqual(filter.topics, [TRANSFER_TOPIC])
      if (first === 3 && fail) throw new Error('private RPC URL')
      return first === 1 ? [log(1, 0, zero, a, 100n)] : first === 3 ? [log(4, 0, a, b, 20n)] : []
    },
  }
  try {
    await assert.rejects(
      collectHolderLogs({ client, anchor, rawPath, chunkBlocks: 2 }),
      /RPC read failed/,
    )
    const partial = JSON.parse(readFileSync(rawPath))
    assert.equal(partial.nextBlock, 3)
    fail = false
    const done = await collectHolderLogs({ client, anchor, rawPath, chunkBlocks: 2 })
    assert.equal(done.status, 'complete')
    assert.equal(done.nextBlock, 7)
    assert.deepEqual(replayTransfers(done.logs), [
      [a, 80n],
      [b, 20n],
    ])
    assert.equal(calls.filter(([first]) => first === 1).length, 1)
    const bytes = readFileSync(rawPath)
    assert.equal(createHash('sha256').update(bytes).digest('hex').length, 64)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('complete offline resume rejects a tampered raw cache before any RPC read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-exit-cache-test-'))
  const anchor = { vault, block: 7, creationBlock: 1, proposalIndex: 0 }
  const path = join(dir, `${vault}-7-pre-b-transfers.json`)
  const raw = {
    study: 'morpho-v2-pre-b-transfer-logs-v1',
    stage1ArtifactSha256: '28b4c9737df8e97f76f71ee5dc8c41d771bbd9bdcbcba01a113837ab29fa8ae9',
    vault,
    proposalIndex: 0,
    fromBlock: 1,
    throughBlock: 6,
    nextBlock: 7,
    status: 'complete',
    logs: [ledgerLog(1, 0, zero, a, 100)],
  }
  try {
    writeFileSync(path, JSON.stringify(raw))
    const saved = {
      status: 'complete',
      results: [
        {
          vault,
          proposalIndex: 0,
          preBlock: 6,
          rawLogPath: path,
          rawLogCount: 1,
          rawLogSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        },
      ],
    }
    assert.doesNotThrow(() => validateCachedResults(saved, [anchor], dir))
    writeFileSync(path, JSON.stringify({ ...raw, nextBlock: 5 }))
    assert.throws(() => validateCachedResults(saved, [anchor], dir), /SHA mismatch/)
    saved.results[0].rawLogSha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    assert.throws(() => validateCachedResults(saved, [anchor], dir), /metadata mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
