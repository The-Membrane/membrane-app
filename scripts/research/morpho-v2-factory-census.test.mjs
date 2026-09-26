import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, toEventSelector } from 'viem'
import {
  CHUNK_BLOCKS,
  EVENT,
  FACTORY,
  SKY_VAULT,
  TOPIC0,
  collect,
  decodeCreation,
  ranges,
  validateCheckpoint,
} from './morpho-v2-factory-census.mjs'

const owner = '0x1111111111111111111111111111111111111111'
const asset = '0x2222222222222222222222222222222222222222'
const txHash = `0x${'a'.repeat(64)}`
const blockHash = `0x${'b'.repeat(64)}`
const salt = `0x${'c'.repeat(64)}`
function log(block, vault = SKY_VAULT) {
  return {
    address: FACTORY,
    blockNumber: BigInt(block),
    blockHash,
    transactionIndex: 0n,
    transactionHash: txHash,
    logIndex: 0n,
    topics: encodeEventTopics({
      abi: [EVENT],
      eventName: 'CreateVaultV2',
      args: { owner, asset, newVaultV2: vault },
    }),
    data: encodeAbiParameters([{ type: 'bytes32' }], [salt]),
  }
}

test('official ABI topic and inclusive bounded pagination', () => {
  assert.equal(toEventSelector(EVENT).toLowerCase(), TOPIC0)
  assert.deepEqual(ranges(10, 20, 4), [
    { fromBlock: 10, toBlock: 13 },
    { fromBlock: 14, toBlock: 17 },
    { fromBlock: 18, toBlock: 20 },
  ])
  assert.throws(() => ranges(10, 20, CHUNK_BLOCKS + 1), /Invalid bounded/)
})

test('decodes indexed fields, salt and exact coordinates', () => {
  const decoded = decodeCreation(log(11), 1234)
  assert.deepEqual(decoded, {
    block: 11,
    blockHash,
    transactionIndex: 0,
    txHash,
    logIndex: 0,
    timestamp: 1234,
    owner,
    asset,
    vault: SKY_VAULT,
    salt,
  })
  assert.throws(
    () => decodeCreation({ ...log(11), address: owner }, 1234),
    /Factory address mismatch/,
  )
})

test('failed chunk remains retryable and complete summary checks unique known vault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-factory-test-'))
  const out = join(dir, 'factory.json')
  let fail = true
  const calls = []
  const client = {
    async getChainId() {
      return 1
    },
    async getLogs({ fromBlock, toBlock }) {
      calls.push([Number(fromBlock), Number(toBlock)])
      if (Number(fromBlock) === 12 && fail) throw new Error('secret-rpc-url')
      return Number(fromBlock) === 10 ? [log(10)] : []
    },
    async getBlock() {
      return { hash: blockHash, timestamp: 1234n }
    },
  }
  try {
    await assert.rejects(
      collect({ client, out, from: 10, to: 13, chunkBlocks: 2, retries: 0, pause: async () => {} }),
      /RPC read failed/,
    )
    let saved = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(saved.status, 'partial')
    assert.equal(saved.endBlockHash, blockHash)
    assert.equal(saved.nextChunk, 1)
    assert.equal(saved.coverage.throughBlock, 11)
    fail = false
    const finished = await collect({
      client,
      out,
      from: 10,
      to: 13,
      chunkBlocks: 2,
      retries: 0,
      pause: async () => {},
    })
    assert.deepEqual(calls, [
      [10, 11],
      [12, 13],
      [12, 13],
    ])
    assert.deepEqual(finished.summary, {
      eventCount: 1,
      uniqueVaultCount: 1,
      duplicateVaultCount: 0,
      containsSkyVault: true,
    })
    assert.equal(finished.status, 'complete')
    saved = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(saved.coverage.throughBlock, 13)
    assert.throws(
      () =>
        validateCheckpoint(
          { ...saved, summary: { ...saved.summary, eventCount: 2 } },
          { from: 10, to: 13, chunkBlocks: 2, ranges: ranges(10, 13, 2) },
        ),
      /summary verification/,
    )
    assert.throws(
      () =>
        validateCheckpoint(
          { ...saved, nextChunk: 1 },
          { from: 10, to: 13, chunkBlocks: 2, ranges: ranges(10, 13, 2) },
        ),
      /Checkpoint/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wrong chain rejects before the first log query or checkpoint write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-wrong-chain-'))
  const out = join(dir, 'factory.json')
  let queried = false
  try {
    await assert.rejects(
      collect({
        out,
        from: 10,
        to: 10,
        retries: 0,
        client: {
          getChainId: async () => 8453,
          getBlock: async () => {
            queried = true
          },
          getLogs: async () => {
            queried = true
          },
        },
      }),
      /mainnet chain ID 1/,
    )
    assert.equal(queried, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pinned end-block hash is checked on resume; legacy complete artifact remains immutable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-end-pin-'))
  const out = join(dir, 'factory.json')
  let currentHash = blockHash
  let logQueries = 0
  const client = {
    getChainId: async () => 1,
    getBlock: async () => ({ hash: currentHash, timestamp: 1234n }),
    getLogs: async () => {
      logQueries++
      return [log(10)]
    },
  }
  try {
    await collect({ client, out, from: 10, to: 10, maxChunks: 0, retries: 0 })
    currentHash = `0x${'d'.repeat(64)}`
    await assert.rejects(
      collect({ client, out, from: 10, to: 10, retries: 0 }),
      /Pinned end-block hash changed/,
    )
    assert.equal(logQueries, 0)
    currentHash = blockHash
    await collect({ client, out, from: 10, to: 10, retries: 0 })
    const complete = JSON.parse(readFileSync(out, 'utf8'))
    const legacy = { ...complete }
    delete legacy.endBlockHash
    delete legacy.endBlockTimestamp
    writeFileSync(out, JSON.stringify(legacy))
    const original = readFileSync(out, 'utf8')
    const read = await collect({ client, out, from: 10, to: 10, retries: 0 })
    assert.equal(read.pinProvenance, 'legacy-runtime-only')
    assert.equal(read.runtimeEndBlockHash, blockHash)
    assert.equal(readFileSync(out, 'utf8'), original)
    assert.equal(logQueries, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('end-block change at finish leaves a partial checkpoint for review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-finish-pin-'))
  const out = join(dir, 'factory.json')
  let endReads = 0
  const client = {
    getChainId: async () => 1,
    getBlock: async () => ({
      hash: ++endReads === 3 ? `0x${'d'.repeat(64)}` : blockHash,
      timestamp: 1234n,
    }),
    getLogs: async () => [log(10)],
  }
  try {
    await assert.rejects(
      collect({ client, out, from: 10, to: 10, retries: 0 }),
      /Pinned end-block hash changed/,
    )
    const saved = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(saved.status, 'partial')
    assert.equal(saved.nextChunk, 1)
    assert.equal(saved.endBlockHash, blockHash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
