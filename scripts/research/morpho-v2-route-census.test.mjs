import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { toHex } from 'viem'
import {
  CHUNK_BLOCKS, FACTORY_SHA, FROM_BLOCK, PINNED_HEAD_HASH, TOPIC0,
  TO_BLOCK, collect, decodeRoute, ranges, readFactory, validateCheckpoint,
} from './morpho-v2-route-census.mjs'

const factory = resolve(`data/research/venue-signals/${FACTORY_SHA}.json`)
const creationMap = readFactory(factory)
const firstVault = [...creationMap.entries()].find(([, block]) => block === FROM_BLOCK)[0]
const lateVault = [...creationMap.entries()].find(([, block]) => block > FROM_BLOCK + CHUNK_BLOCKS)[0]
const pad = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`
const hash = (x) => `0x${String(x).padStart(64, '0')}`
const nonCohort = '0x1111111111111111111111111111111111111111'
const sender = '0x2222222222222222222222222222222222222222'
const adapter = '0x3333333333333333333333333333333333333333'
function log(address, block, index = 0) {
  return { address, blockNumber: toHex(block), transactionIndex: toHex(1),
    logIndex: toHex(index), transactionHash: hash(1 + index), blockHash: hash(block),
    topics: [TOPIC0, pad(sender), pad(adapter), hash(99)], data: '0x' }
}
const client = {
  getChainId: async () => 1,
  getBlock: async ({ blockNumber }) => {
    assert.equal(Number(blockNumber), TO_BLOCK)
    return { hash: PINNED_HEAD_HASH }
  },
}
const enoughDisk = () => ({ bavail: 10_000_000, bsize: 4096 })

test('fixed range has <=8k inclusive chunks and covers pinned end', () => {
  const chunks = ranges()
  assert.equal(chunks[0].fromBlock, FROM_BLOCK)
  assert.equal(chunks.at(-1).toBlock, TO_BLOCK)
  assert.ok(chunks.every((x) => x.toBlock - x.fromBlock + 1 <= CHUNK_BLOCKS))
  assert.throws(() => ranges(FROM_BLOCK, TO_BLOCK, CHUNK_BLOCKS + 1))
})

test('factory bytes and first route decode retain adapter/data topic hash', () => {
  assert.equal(creationMap.size, 757)
  assert.equal(createHash('sha256').update(readFileSync(factory)).digest('hex'), FACTORY_SHA)
  const decoded = decodeRoute(log(firstVault, FROM_BLOCK))
  assert.equal(decoded.vault, firstVault)
  assert.equal(decoded.adapter, adapter)
  assert.equal(decoded.sender, sender)
  assert.equal(decoded.dataTopicHash, hash(99))
  assert.throws(() => decodeRoute({ ...log(firstVault, FROM_BLOCK), data: '0x01' }))
})

test('topic-only scan filters noncohort, checkpoints each chunk, resumes, and detects tampering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-route-census-'))
  const out = join(dir, 'route.json')
  const calls = []
  const rpcRead = async (method, params) => {
    assert.equal(method, 'eth_getLogs')
    const query = params[0]
    assert.deepEqual(query.topics, [TOPIC0])
    assert.ok(Number(BigInt(query.toBlock)) - Number(BigInt(query.fromBlock)) + 1 <= CHUNK_BLOCKS)
    calls.push(query)
    return calls.length === 1
      ? [log(nonCohort, FROM_BLOCK, 0), log(firstVault, FROM_BLOCK, 1)]
      : [log(firstVault, FROM_BLOCK + CHUNK_BLOCKS, 2)]
  }
  try {
    const first = await collect({ client, rpcRead, out, creations: creationMap, maxChunks: 1, diskStats: enoughDisk })
    assert.equal(first.nextChunk, 1)
    assert.equal(first.events.length, 1)
    assert.equal(first.nonCohortLogs, 1)
    assert.equal(first.chunks[0].matchedLogs, 2)
    assert.deepEqual(validateCheckpoint(JSON.parse(readFileSync(out)), creationMap), first)
    const resumed = await collect({ client, rpcRead, out, creations: creationMap, maxChunks: 1, diskStats: enoughDisk })
    assert.equal(resumed.nextChunk, 2)
    assert.equal(resumed.events.length, 2)
    assert.equal(calls.length, 2)
    const damaged = JSON.parse(readFileSync(out))
    damaged.events[0].adapter = nonCohort
    writeFileSync(out, JSON.stringify(damaged))
    await assert.rejects(() => collect({ client, rpcRead, out, creations: creationMap,
      maxChunks: 0, diskStats: enoughDisk }), /integrity mismatch/)
    assert.equal(calls.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cohort route event before factory creation fails without advancing checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-route-census-'))
  const out = join(dir, 'route.json')
  try {
    await assert.rejects(() => collect({ client, out, creations: creationMap, maxChunks: 1,
      diskStats: enoughDisk,
      rpcRead: async () => [log(lateVault, FROM_BLOCK)] }), /predates factory creation/)
    const saved = validateCheckpoint(JSON.parse(readFileSync(out)), creationMap)
    assert.equal(saved.nextChunk, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
