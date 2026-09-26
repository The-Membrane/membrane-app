import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters } from 'viem'
import {
  ACCEPT,
  CHUNK_BLOCKS,
  FACTORY_SHA,
  FROM_BLOCK,
  PINNED_HEAD_HASH,
  RESERVE_BYTES,
  REVOKE,
  SUBMIT_SHA,
  TO_BLOCK,
  TOPICS,
  collect,
  decodeLifecycle,
  eventKey,
  ranges,
  readSources,
  replay,
  seal,
  validateCheckpoint,
} from './morpho-v2-cap-lifecycle-census.mjs'

const blockHash = PINNED_HEAD_HASH
const txHash = `0x${'1'.repeat(64)}`
const vault = `0x${'2'.repeat(40)}`
const sender = `0x${'3'.repeat(40)}`
const calldata = '0x12345678'
const selectorTopic = `0x12345678${'0'.repeat(56)}`
const senderTopic = `0x${'0'.repeat(24)}${sender.slice(2)}`
const data = encodeAbiParameters([{ type: 'bytes' }], [calldata])
const logs = (kind, overrides = {}) => ({
  address: vault,
  topics:
    kind === 'accept'
      ? [TOPICS.accept, selectorTopic]
      : [TOPICS.revoke, senderTopic, selectorTopic],
  data,
  blockNumber: `0x${(FROM_BLOCK + 1).toString(16)}`,
  blockHash,
  transactionHash: txHash,
  transactionIndex: '0x0',
  logIndex: '0x1',
  ...overrides,
})
const submits = [
  {
    vault,
    selector: '0x12345678',
    data: calldata,
    block: FROM_BLOCK,
    txHash: `0x${'4'.repeat(64)}`,
    logIndex: 0,
  },
]
const source = () => {
  const vaults = new Map([[vault, FROM_BLOCK]])
  for (let i = 0; i < 756; i++)
    vaults.set(`0x${(i + 10).toString(16).padStart(40, '0')}`, FROM_BLOCK)
  return { vaults, submits }
}
const ample = () => ({ bavail: 5_000_000_000, bsize: 1 })
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const partialCheckpoint = (events, sources = source()) => {
  const range = ranges()[0]
  const submitKeys = new Set(sources.submits.map(eventKey))
  return seal({
    study: 'morpho-v2-cap-lifecycle-census-v1',
    chainId: 1,
    factoryArtifactSha256: FACTORY_SHA,
    submitArtifactSha256: SUBMIT_SHA,
    pinnedHeadHash: PINNED_HEAD_HASH,
    from: FROM_BLOCK,
    to: TO_BLOCK,
    chunkBlocks: CHUNK_BLOCKS,
    topics: TOPICS,
    nextChunk: 1,
    status: 'partial',
    chunks: [
      {
        ...range,
        fromHash: blockHash,
        toHash: blockHash,
        matchedLogs: events.length,
        eventCount: events.length,
        nonCohortLogs: events.filter((x) => !sources.vaults.has(x.vault)).length,
        unmatchedLogs: events.filter((x) => !submitKeys.has(eventKey(x))).length,
        eventsSha256: sha(events),
      },
    ],
    events,
    nonCohortLogs: events.filter((x) => !sources.vaults.has(x.vault)).length,
    unmatchedLogs: events.filter((x) => !submitKeys.has(eventKey(x))).length,
    coverage: {
      fromBlock: FROM_BLOCK,
      throughBlock: range.toBlock,
      chunksComplete: 1,
      chunksExpected: ranges().length,
      complete: false,
    },
  })
}

test('ABI topics match focused VaultV2 scripts, selector and sender positions decode', () => {
  assert.equal(TOPICS.accept, '0x29aa42fc192ff77ef42105abba283197ac841341e196e417a7fc2784cdc4e5fb')
  assert.equal(TOPICS.revoke, '0x70521cf6a7c2458c5ad406081ad7b3bc4afd31b01b586a157a9780fcee6a77cb')
  assert.equal(ACCEPT.name, 'Accept')
  assert.equal(REVOKE.name, 'Revoke')
  const accept = decodeLifecycle(logs('accept'))
  const revoke = decodeLifecycle(logs('revoke', { logIndex: '0x2' }))
  assert.equal(accept.selector, '0x12345678')
  assert.equal(accept.data, calldata)
  assert.equal(accept.sender, null)
  assert.equal(revoke.sender, sender)
  assert.equal(eventKey(accept), eventKey(submits[0]))
})

test('malformed topic, calldata, coordinates, and hashes fail closed', () => {
  assert.throws(() =>
    decodeLifecycle(logs('accept', { topics: [TOPICS.accept, senderTopic, selectorTopic] })),
  )
  assert.throws(() =>
    decodeLifecycle(logs('revoke', { topics: [TOPICS.revoke, selectorTopic, senderTopic] })),
  )
  assert.throws(() => decodeLifecycle(logs('accept', { data: '0x1234' })))
  assert.throws(() => decodeLifecycle(logs('accept', { blockHash: '0x1' })))
  assert.throws(() => decodeLifecycle(logs('accept', { logIndex: '-0x1' })))
})

test('full-key replay retains duplicate-open and orphan settlement ambiguity', () => {
  const accept = decodeLifecycle(
    logs('accept', { blockNumber: `0x${(FROM_BLOCK + 2).toString(16)}` }),
  )
  const first = replay(source(), partialCheckpoint([accept]), FROM_BLOCK + 2)
  assert.equal(first.state.get(eventKey(submits[0])).pending, false)
  const repeat = { ...submits[0], block: FROM_BLOCK + 1, logIndex: 4 }
  const repeatedSource = { ...source(), submits: [...submits, repeat] }
  assert.deepEqual(
    replay(repeatedSource, partialCheckpoint([accept], repeatedSource), FROM_BLOCK + 2).issues.map(
      (x) => x.kind,
    ),
    ['duplicate-open'],
  )
  const orphan = { ...accept, data: '0x87654321', selector: '0x87654321' }
  assert.deepEqual(
    replay(source(), partialCheckpoint([orphan]), FROM_BLOCK + 2).issues.map((x) => x.kind),
    ['settle-without-open'],
  )
  assert.equal(replay(source(), partialCheckpoint([]), FROM_BLOCK - 1).state.size, 0)
})

test('replay refuses unscanned prefixes, absent as-of block, and tampered checkpoint', () => {
  const saved = partialCheckpoint([])
  const unscanned = seal({
    ...saved,
    nextChunk: 0,
    chunks: [],
    events: [],
    coverage: {
      fromBlock: FROM_BLOCK,
      throughBlock: FROM_BLOCK - 1,
      chunksComplete: 0,
      chunksExpected: ranges().length,
      complete: false,
    },
  })
  assert.throws(() => replay(source(), unscanned, FROM_BLOCK), /complete scanned prefix/)
  assert.equal(
    replay(source(), saved, ranges()[0].toBlock).state.get(eventKey(submits[0])).pending,
    true,
  )
  assert.throws(() => replay(source(), saved, ranges()[0].toBlock + 1), /complete scanned prefix/)
  assert.throws(() => replay(source(), saved), /complete scanned prefix/)
  assert.throws(
    () => replay(source(), { ...saved, nextChunk: 0 }, FROM_BLOCK),
    /integrity mismatch/,
  )
  assert.throws(() => replay(submits, [], FROM_BLOCK), /integrity mismatch/)
})

test('range covers fixed 335 contiguous chunks and exact end', () => {
  const all = ranges()
  assert.equal(all.length, 335)
  assert.equal(all[0].fromBlock, FROM_BLOCK)
  assert.equal(all[0].toBlock, FROM_BLOCK + CHUNK_BLOCKS - 1)
  assert.equal(all.at(-1).toBlock, TO_BLOCK)
  for (let i = 1; i < all.length; i++) assert.equal(all[i].fromBlock, all[i - 1].toBlock + 1)
})

test('physical source SHA gate rejects tampering before metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-life-source-'))
  try {
    const factory = join(dir, 'factory.json'),
      submit = join(dir, 'submit.json')
    writeFileSync(factory, '{}')
    writeFileSync(submit, '{}')
    assert.throws(() => readSources(factory, submit), /SHA mismatch/)
    assert.equal(FACTORY_SHA.length, 64)
    assert.equal(SUBMIT_SHA.length, 64)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one-chunk capture seals, verifies, and resumes without rescanning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-life-run-'))
  try {
    const out = join(dir, 'checkpoint.json'),
      requests = []
    const client = { getChainId: async () => 1, getBlock: async () => ({ hash: PINNED_HEAD_HASH }) }
    const rpcRead = async (method, params) => {
      requests.push([method, params[0].topics[0]])
      return params[0].topics[0] === TOPICS.accept ? [logs('accept')] : []
    }
    const first = await collect({
      client,
      sources: source(),
      out,
      maxChunks: 1,
      rpcRead,
      stat: ample,
      retries: 0,
    })
    assert.equal(first.nextChunk, 1)
    assert.equal(first.events.length, 1)
    assert.equal(first.unmatchedLogs, 0)
    assert.equal(first.nonCohortLogs, 0)
    assert.equal(requests.length, 2)
    validateCheckpoint(JSON.parse(readFileSync(out, 'utf8')), source())
    const resumed = await collect({
      client,
      sources: source(),
      out,
      maxChunks: 0,
      rpcRead,
      stat: ample,
      retries: 0,
    })
    assert.equal(resumed.nextChunk, 1)
    assert.equal(requests.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('duplicate coordinates and malformed logs cannot seal a chunk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-life-bad-'))
  try {
    const client = { getChainId: async () => 1, getBlock: async () => ({ hash: PINNED_HEAD_HASH }) }
    for (const response of [
      [logs('accept'), logs('accept')],
      [logs('accept', { blockHash: '0x1' })],
    ]) {
      const out = join(dir, `bad-${response[0].blockHash.slice(2, 5)}-${response.length}.json`)
      await assert.rejects(
        collect({
          client,
          sources: source(),
          out,
          maxChunks: 1,
          rpcRead: async (_method, params) =>
            params[0].topics[0] === TOPICS.accept ? response : [],
          stat: ample,
          retries: 0,
        }),
      )
      const saved = JSON.parse(readFileSync(out, 'utf8'))
      assert.equal(saved.nextChunk, 0)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disk reserve stops before first RPC and preserves threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-life-disk-'))
  try {
    let called = false
    await assert.rejects(
      collect({
        client: {
          getChainId: async () => {
            called = true
            return 1
          },
        },
        sources: source(),
        out: join(dir, 'checkpoint.json'),
        maxChunks: 1,
        stat: () => ({ bavail: RESERVE_BYTES - 1, bsize: 1 }),
        retries: 0,
      }),
      /disk reserve/,
    )
    assert.equal(called, false)
    assert.equal(RESERVE_BYTES, 2_500_000_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disk reserve rechecks before a retried RPC, rather than retrying through a full disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-life-retry-disk-'))
  try {
    let attempts = 0,
      checks = 0
    await assert.rejects(
      collect({
        client: {
          getChainId: async () => {
            attempts++
            throw new Error('transient')
          },
        },
        sources: source(),
        out: join(dir, 'checkpoint.json'),
        maxChunks: 1,
        stat: () => ({ bavail: ++checks === 1 ? RESERVE_BYTES + 1 : RESERVE_BYTES - 1, bsize: 1 }),
        retries: 1,
        pause: async () => {},
      }),
      /disk reserve/,
    )
    assert.equal(attempts, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
