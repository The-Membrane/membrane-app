import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionData, padHex } from 'viem'
import { FACTORY, TOPIC0 as CREATE_TOPIC } from './morpho-v2-factory-census.mjs'
import { ABS_SELECTOR, CAP_ABI, TOPIC0 as SUBMIT_TOPIC } from './morpho-v2-cap-submit-census.mjs'
import {
  FACTORY_SHA,
  PINNED_HEAD_HASH,
  SUBMIT_SHA,
  TOPICS,
  readSources,
} from './morpho-v2-cap-lifecycle-census.mjs'
import { TOPIC0 as ROUTE_TOPIC } from './morpho-v2-route-census.mjs'
import {
  ALLOCATE_TOPIC,
  CHUNK_BLOCKS,
  DEALLOCATE_TOPIC,
  FRONTIER,
  MAX_ALLOCATION_IDS,
  MAX_RPC_CALLS,
  collect,
  seal,
  verify,
} from './morpho-v2-cap-prospective-watch.mjs'

const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const addr = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`
const topics = (selector) => padHex(selector, { size: 32, dir: 'right' })
const sources = readSources(
  resolve(`data/research/venue-signals/${FACTORY_SHA}.json`),
  resolve(`data/research/venue-signals/${SUBMIT_SHA}.json`),
)
const vault = addr(987654321),
  owner = addr(987654322),
  asset = addr(987654323)
const capData = encodeFunctionData({
  abi: CAP_ABI,
  functionName: 'increaseAbsoluteCap',
  args: ['0x1234', 10n],
})
const allocationData = (ids = [hash(17)], change = -5n) =>
  encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32[]' }, { type: 'int256' }],
    [10n, ids, change],
  )
function log(kind, block, index = 0, override = {}) {
  const basis = {
    address: vault,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: hash(block),
    transactionIndex: '0x0',
    transactionHash: hash(block * 100 + index),
    logIndex: `0x${index.toString(16)}`,
    data: '0x',
    topics: [],
  }
  if (kind === 'create')
    Object.assign(basis, {
      address: FACTORY,
      topics: [CREATE_TOPIC, padHex(owner), padHex(asset), padHex(vault)],
      data: encodeAbiParameters([{ type: 'bytes32' }], [hash(12)]),
    })
  if (kind === 'submit')
    Object.assign(basis, {
      topics: [SUBMIT_TOPIC, topics(ABS_SELECTOR)],
      data: encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'uint256' }],
        [capData, 2_000_000_000n],
      ),
    })
  if (kind === 'accept')
    Object.assign(basis, {
      topics: [TOPICS.accept, topics(ABS_SELECTOR)],
      data: encodeAbiParameters([{ type: 'bytes' }], [capData]),
    })
  if (kind === 'revoke')
    Object.assign(basis, {
      topics: [TOPICS.revoke, padHex(owner), topics(ABS_SELECTOR)],
      data: encodeAbiParameters([{ type: 'bytes' }], [capData]),
    })
  if (kind === 'route')
    Object.assign(basis, {
      topics: [ROUTE_TOPIC, padHex(owner), padHex(addr(100)), hash(3)],
      data: '0x',
    })
  if (kind === 'allocate' || kind === 'deallocate')
    Object.assign(basis, {
      topics: [
        kind === 'allocate' ? ALLOCATE_TOPIC : DEALLOCATE_TOPIC,
        padHex(owner),
        padHex(asset),
      ],
      data: allocationData(),
    })
  return { ...basis, ...override }
}
function fixture(finalized = FRONTIER + 1, logs = []) {
  const calls = []
  let fork = false
  const rpcRead = async (method, params) => {
    calls.push([method, params])
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? finalized : Number(BigInt(params[0]))
      return {
        number: `0x${n.toString(16)}`,
        hash: n === FRONTIER ? PINNED_HEAD_HASH : fork && n === finalized ? hash(88) : hash(n),
        parentHash: n === FRONTIER + 1 ? PINNED_HEAD_HASH : hash(n - 1),
        timestamp: '0x70000000',
      }
    }
    if (method === 'eth_getLogs') {
      const [{ fromBlock, toBlock, topics: requested }] = params
      return logs.filter(
        (x) =>
          Number(BigInt(x.blockNumber)) >= Number(BigInt(fromBlock)) &&
          Number(BigInt(x.blockNumber)) <= Number(BigInt(toBlock)) &&
          x.topics[0] === requested[0],
      )
    }
    throw new Error('Unexpected method')
  }
  return {
    calls,
    rpcRead,
    reorg: () => {
      fork = true
    },
  }
}
const out = () => mkdtempSync(join(tmpdir(), 'morpho-watch-test-'))
const clock = () => new Date('2026-09-26T12:00:00.000Z')
const roomy = () => ({ bavail: 10_000_000, bsize: 4096 })
const run = (rpcRead, folder, other = {}) =>
  collect({ rpcRead, sources, out: folder, now: clock, stat: roomy, ...other })

test('zero-event finalized poll writes an explicit immutable scanned interval', async () => {
  const folder = out(),
    mock = fixture()
  const result = await run(mock.rpcRead, folder)
  assert.equal(result.throughBlock, FRONTIER + 1)
  assert.equal(result.segmentCount, 1)
  const [file] = readdirSync(folder)
  const segment = JSON.parse(readFileSync(join(folder, file)))
  assert.equal(segment.events.length, 0)
  assert.deepEqual(
    segment.scans.map((x) => x.eventCount),
    [0, 0, 0, 0, 0, 0, 0],
  )
  assert.equal(verify({ out: folder, sources }).throughBlock, FRONTIER + 1)
  assert.ok(mock.calls.length <= 14)
})

test('new factory vault and cap Submit retain exact data and first acquisition time', async () => {
  const folder = out(),
    block = FRONTIER + 1
  const mock = fixture(block, [log('create', block, 0), log('submit', block, 1)])
  const result = await run(mock.rpcRead, folder)
  assert.equal(result.vaults.get(vault), block)
  const [file] = readdirSync(folder)
  const segment = JSON.parse(readFileSync(join(folder, file)))
  assert.deepEqual(
    segment.events.map((x) => x.kind),
    ['create', 'submit'],
  )
  assert.equal(segment.events[1].raw.data, log('submit', block, 1).data.toLowerCase())
  assert.equal(segment.events[1].detail.executableAt, '2000000000')
  assert.equal(segment.events[1].firstObservedAt, '2026-09-26T12:00:00.000Z')
  assert.equal(verify({ out: folder, sources }).segmentCount, 1)
})

test('non-cap Submit and non-factory shared-topic logs do not stop cap collection', async () => {
  const folder = out(),
    block = FRONTIER + 1
  const mock = fixture(block, [
    log('create', block, 0),
    log('submit', block, 1),
    log('submit', block, 2, { topics: [SUBMIT_TOPIC, topics('0x12345678')] }),
    log('route', block, 3, { address: addr(555), data: '0x12' }),
  ])
  await run(mock.rpcRead, folder)
  const segment = JSON.parse(readFileSync(join(folder, readdirSync(folder)[0])))
  assert.deepEqual(
    segment.events.map((x) => x.kind),
    ['create', 'submit'],
  )
  assert.equal(segment.scans.find((x) => x.kind === 'submit').rawCount, 2)
  assert.equal(segment.scans.find((x) => x.kind === 'submit').eventCount, 1)
  assert.equal(segment.scans.find((x) => x.kind === 'route').rawCount, 1)
  assert.equal(segment.scans.find((x) => x.kind === 'route').eventCount, 0)
  assert.equal(verify({ out: folder, sources }).segmentCount, 1)
})

test('Accept, Revoke, and immediate route switch are recorded as context', async () => {
  const folder = out(),
    block = FRONTIER + 1
  const mock = fixture(block, [
    log('create', block, 0),
    log('accept', block, 1),
    log('revoke', block, 2),
    log('route', block, 3),
  ])
  await run(mock.rpcRead, folder)
  const segment = JSON.parse(readFileSync(join(folder, readdirSync(folder)[0])))
  assert.deepEqual(
    segment.events.map((x) => x.kind),
    ['create', 'accept', 'revoke', 'route'],
  )
  assert.ok(segment.limitations.includes('route-switch-is-immediate-context'))
  assert.equal(verify({ out: folder, sources }).segmentCount, 1)
})

test('frontier reorg refuses append without touching existing segment', async () => {
  const folder = out(),
    mock = fixture(FRONTIER + 2)
  await run(mock.rpcRead, folder, { maxChunks: 1 })
  const names = readdirSync(folder)
  mock.reorg()
  await assert.rejects(run(mock.rpcRead, folder), /Previous frontier hash changed/)
  assert.deepEqual(readdirSync(folder), names)
})

test('restart does not duplicate and advances from sealed interval', async () => {
  const folder = out(),
    mock = fixture(FRONTIER + CHUNK_BLOCKS + 1)
  await run(mock.rpcRead, folder, { maxChunks: 1 })
  assert.equal(readdirSync(folder).length, 1)
  await run(mock.rpcRead, folder, { maxChunks: 1 })
  assert.equal(readdirSync(folder).length, 2)
  await run(mock.rpcRead, folder, { maxChunks: 1 })
  assert.equal(readdirSync(folder).length, 2)
  assert.equal(verify({ out: folder, sources }).throughBlock, FRONTIER + CHUNK_BLOCKS + 1)
})

test('interrupted temporary append is ignored and safely rescanned', async () => {
  const folder = out(),
    mock = fixture()
  const stale = join(
    folder,
    `${String(FRONTIER + 1).padStart(12, '0')}-${String(FRONTIER + 1).padStart(12, '0')}.json.1234-abcd.tmp`,
  )
  writeFileSync(stale, 'partial-uncommitted')
  assert.equal(verify({ out: folder, sources }).segmentCount, 0)
  await run(mock.rpcRead, folder)
  assert.equal(verify({ out: folder, sources }).segmentCount, 1)
  assert.equal(readdirSync(folder).length, 2) // stale bytes retained for forensic inspection
})

test('tip hash changing during the scan refuses append', async () => {
  const folder = out(),
    mock = fixture(),
    target = FRONTIER + 1
  let tipReads = 0
  const rpcRead = async (method, params) => {
    const response = await mock.rpcRead(method, params)
    if (
      method === 'eth_getBlockByNumber' &&
      params[0] === `0x${target.toString(16)}` &&
      ++tipReads === 3
    )
      return { ...response, hash: hash(88) }
    return response
  }
  await assert.rejects(run(rpcRead, folder), /Canonical hash changed before append/)
  assert.deepEqual(readdirSync(folder), [])
})

test('first new block must descend from the sealed frontier even when no events exist', async () => {
  const folder = out(),
    mock = fixture()
  const rpcRead = async (method, params) => {
    const response = await mock.rpcRead(method, params)
    if (method === 'eth_getBlockByNumber' && params[0] === `0x${(FRONTIER + 1).toString(16)}`)
      return { ...response, parentHash: hash(77) }
    return response
  }
  await assert.rejects(run(rpcRead, folder), /does not descend/)
  assert.deepEqual(readdirSync(folder), [])
})

test('local observation timestamp is taken after canonical and prefix checks', async () => {
  const folder = out(),
    mock = fixture()
  const now = () => {
    const targetReads = mock.calls.filter(
      ([method, params]) =>
        method === 'eth_getBlockByNumber' && params[0] === `0x${(FRONTIER + 1).toString(16)}`,
    ).length
    assert.ok(targetReads >= 3)
    return clock()
  }
  await run(mock.rpcRead, folder, { now })
  assert.equal(verify({ out: folder, sources }).segmentCount, 1)
})

test('orphaned interior event hash refuses append', async () => {
  const folder = out(),
    eventBlock = FRONTIER + 2
  const orphan = log('create', eventBlock, 0, { blockHash: hash(88) })
  const mock = fixture(FRONTIER + 3, [orphan])
  await assert.rejects(run(mock.rpcRead, folder), /Noncanonical interior event/)
  assert.deepEqual(readdirSync(folder), [])
})

test('malformed relevant log refuses append and leaves no partial interval', async () => {
  const folder = out(),
    block = FRONTIER + 1
  const bad = log('submit', block, 1, { data: '0x12' })
  const mock = fixture(block, [log('create', block, 0), bad])
  await assert.rejects(run(mock.rpcRead, folder))
  assert.deepEqual(readdirSync(folder), [])
})

test('tampered physical segment fails offline seal verification', async () => {
  const folder = out(),
    mock = fixture()
  await run(mock.rpcRead, folder)
  const [file] = readdirSync(folder),
    path = join(folder, file)
  const before = readFileSync(path)
  const corrupted = Buffer.from(before)
  corrupted[corrupted.indexOf(Buffer.from('firstObservedAt'))] = 0x58
  writeFileSync(path, corrupted)
  assert.throws(() => verify({ out: folder, sources }))
  assert.notEqual(
    createHash('sha256').update(before).digest('hex'),
    createHash('sha256').update(readFileSync(path)).digest('hex'),
  )
})

test('allocation and deallocation strictly decode IDs and retain raw coordinates', async () => {
  const folder = out(),
    block = FRONTIER + 1
  const mock = fixture(block, [
    log('create', block, 0),
    log('allocate', block, 1),
    log('deallocate', block, 2, { data: allocationData([hash(18), hash(19)], 7n) }),
  ])
  await run(mock.rpcRead, folder)
  const segment = JSON.parse(readFileSync(join(folder, readdirSync(folder)[0])))
  assert.equal(segment.schemaVersion, 2)
  assert.deepEqual(
    segment.scans.map((x) => x.kind),
    ['create', 'submit', 'accept', 'revoke', 'route', 'allocate', 'deallocate'],
  )
  assert.deepEqual(
    segment.events.map((x) => x.kind),
    ['create', 'allocate', 'deallocate'],
  )
  assert.deepEqual(segment.events[2].detail.ids, [hash(18), hash(19)])
  assert.equal(segment.events[2].detail.change, '7')
  assert.equal(segment.events[1].raw.logIndex, 1)
  assert.equal(segment.events[1].firstObservedAt, clock().toISOString())
  assert.ok(segment.limitations.some((x) => x.includes('not-cap-execution')))
  assert.equal(verify({ out: folder, sources }).segmentCount, 1)
})

test('malformed dynamic IDs and oversized IDs fail closed without writing a segment', async () => {
  const block = FRONTIER + 1
  const valid = allocationData()
  // Replace the ABI offset word (second head slot) with an out-of-bounds pointer.
  const badOffset = `0x${valid.slice(2, 66)}${'f'.repeat(64)}${valid.slice(130)}`
  for (const data of [
    badOffset,
    allocationData(Array.from({ length: MAX_ALLOCATION_IDS + 1 }, (_, i) => hash(i))),
    `${valid}00`, // noncanonical trailing bytes
  ]) {
    const folder = out()
    const mock = fixture(block, [log('create', block, 0), log('allocate', block, 1, { data })])
    await assert.rejects(run(mock.rpcRead, folder))
    assert.deepEqual(readdirSync(folder), [])
  }
})

test('new factory vault allocation in same chunk is recognized, outside vault is ignored', async () => {
  const folder = out(),
    block = FRONTIER + 1
  const mock = fixture(block, [
    log('create', block, 0),
    log('allocate', block, 1),
    log('allocate', block, 2, { address: addr(777), data: '0x12' }),
  ])
  await run(mock.rpcRead, folder)
  const segment = JSON.parse(readFileSync(join(folder, readdirSync(folder)[0])))
  assert.deepEqual(
    segment.events.map((x) => x.kind),
    ['create', 'allocate'],
  )
  assert.equal(segment.scans.find((x) => x.kind === 'allocate').rawCount, 2)
  assert.equal(verify({ out: folder, sources }).vaults.get(vault), block)
})

test('legacy five-kind segment verifies unchanged and v2 resumes without overwrite', async () => {
  const folder = out(),
    first = FRONTIER + 1,
    second = FRONTIER + 2
  const initial = fixture(first, [log('create', first)])
  await run(initial.rpcRead, folder)
  const [name] = readdirSync(folder),
    path = join(folder, name)
  const v2 = JSON.parse(readFileSync(path))
  delete v2.schemaVersion
  v2.scans = v2.scans.slice(0, 5)
  const v1 = seal(v2)
  writeFileSync(path, JSON.stringify(v1))
  const original = readFileSync(path)
  assert.equal(verify({ out: folder, sources }).segmentCount, 1)
  const continuing = fixture(second, [log('create', first), log('allocate', second)])
  await run(continuing.rpcRead, folder)
  assert.deepEqual(readFileSync(path), original)
  assert.equal(verify({ out: folder, sources }).segmentCount, 2)
  assert.equal(readdirSync(folder).length, 2)
  await run(continuing.rpcRead, folder)
  assert.deepEqual(readFileSync(path), original)
  assert.equal(readdirSync(folder).length, 2)
})

test('offline verifier rejects a schema-less downgrade after the first v2 segment', async () => {
  const folder = out(),
    mock = fixture(FRONTIER + 2)
  await run(mock.rpcRead, folder, { maxChunks: 2 })
  const names = readdirSync(folder).sort()
  assert.equal(names.length, 1) // One chunk covers both blocks.
  const next = fixture(FRONTIER + CHUNK_BLOCKS + 1)
  await run(next.rpcRead, folder, { maxChunks: 2 })
  const segments = readdirSync(folder).sort()
  assert.equal(segments.length, 2)
  const path = join(folder, segments[1])
  const downgraded = JSON.parse(readFileSync(path))
  delete downgraded.schemaVersion
  downgraded.scans = downgraded.scans.slice(0, 5)
  writeFileSync(path, JSON.stringify(seal(downgraded)))
  assert.throws(() => verify({ out: folder, sources }), /seal or continuity mismatch/)
})

test('expanded scans keep response and chunk-scaled per-run RPC limits fail-closed', async () => {
  const first = FRONTIER + 1
  const oversizedFolder = out(),
    mock = fixture(first, [log('create', first)])
  const oversizedRpc = async (method, params) => {
    if (method === 'eth_getLogs' && params[0].topics[0] === ALLOCATE_TOPIC)
      return [{ data: `0x${'00'.repeat(1_048_577)}` }]
    return mock.rpcRead(method, params)
  }
  await assert.rejects(run(oversizedRpc, oversizedFolder), /oversized log response/)
  assert.deepEqual(readdirSync(oversizedFolder), [])

  const denseLogs = [log('create', first)]
  for (let i = 2; i < 55; i++) denseLogs.push(log('allocate', first + i, 0))
  const rpcFolder = out(),
    dense = fixture(FRONTIER + 4 * CHUNK_BLOCKS, denseLogs)
  const result = await run(dense.rpcRead, rpcFolder, { maxChunks: 4 })
  assert.equal(result.segmentCount, 4)
  assert.ok(result.rpcCalls > MAX_RPC_CALLS)
  assert.ok(result.rpcCalls <= MAX_RPC_CALLS * 4)
  assert.equal(verify({ out: rpcFolder, sources }).segmentCount, 4)

  const oneChunkLogs = [log('create', first)]
  for (let i = 2; i < 110; i++) oneChunkLogs.push(log('allocate', first + i, 0))
  const oneChunkFolder = out(),
    oneChunk = fixture(FRONTIER + CHUNK_BLOCKS, oneChunkLogs)
  await assert.rejects(
    run(oneChunk.rpcRead, oneChunkFolder, { maxChunks: 1 }),
    /Watch RPC call cap reached/,
  )
  assert.ok(oneChunk.calls.length <= MAX_RPC_CALLS)
  assert.equal(verify({ out: oneChunkFolder, sources }).segmentCount, 0)

  const overBudgetLogs = [log('create', first)]
  for (let i = 2; i < 350; i++) overBudgetLogs.push(log('allocate', first + i, 0))
  const overBudgetFolder = out(),
    overBudget = fixture(FRONTIER + 4 * CHUNK_BLOCKS, overBudgetLogs)
  await assert.rejects(
    run(overBudget.rpcRead, overBudgetFolder, { maxChunks: 4 }),
    /Watch RPC call cap reached/,
  )
  assert.ok(overBudget.calls.length <= MAX_RPC_CALLS * 4)
  assert.equal(verify({ out: overBudgetFolder, sources }).segmentCount, 0)
})
