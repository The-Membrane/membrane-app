import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, padHex } from 'viem'
import { FACTORY_SHA, SUBMIT_SHA, PINNED_HEAD_HASH, readSources } from './morpho-v2-cap-lifecycle-census.mjs'
import { ALLOCATE_TOPIC, DEALLOCATE_TOPIC } from './morpho-v2-cap-prospective-watch.mjs'
import { CHUNK_BLOCKS, FIRST_BLOCK_HASH, FROM_BLOCK, RESERVE_BYTES,
  collect, decodeAllocation, seal, verify } from './morpho-v2-historical-allocation-census.mjs'

const sources = readSources(
  resolve(`data/research/venue-signals/${FACTORY_SHA}.json`),
  resolve(`data/research/venue-signals/${SUBMIT_SHA}.json`),
)
const vault = [...sources.vaults].find(([, block]) => block === FROM_BLOCK)[0]
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const first = FROM_BLOCK, second = FROM_BLOCK + CHUNK_BLOCKS
const blockHash = (n) => n === first ? FIRST_BLOCK_HASH : hash(n)
const stat = () => ({ bavail: Math.ceil((RESERVE_BYTES + 10_000_000) / 4096), bsize: 4096 })
function log(kind = 'allocate', block = first + 4, override = {}) {
  return {
    address: vault,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: blockHash(block),
    transactionIndex: '0x2', transactionHash: hash(block * 100), logIndex: '0x3',
    topics: [kind === 'allocate' ? ALLOCATE_TOPIC : DEALLOCATE_TOPIC,
      padHex(address(4)), padHex(address(5))],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32[]' }, { type: 'int256' }],
      [100n, [hash(7), hash(8)], kind === 'allocate' ? 12n : -12n]),
    ...override,
  }
}
function fixture({ logs = [], tamperHeader = () => false } = {}) {
  const calls = []
  return {
    calls,
    rpcRead: async (method, params) => {
      calls.push([method, params])
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(params[0]))
        const canonical = blockHash(n)
        return { number: `0x${n.toString(16)}`,
          hash: tamperHeader(n, calls) ? hash(999) : n === 26_052_740 ? PINNED_HEAD_HASH : canonical,
          parentHash: n === second ? blockHash(second - 1) : blockHash(n - 1) }
      }
      if (method === 'eth_getLogs') {
        const filter = params[0]
        return logs.filter((x) => x.topics[0] === filter.topics[0] &&
          Number(BigInt(x.blockNumber)) >= Number(BigInt(filter.fromBlock)) &&
          Number(BigInt(x.blockNumber)) <= Number(BigInt(filter.toBlock)))
      }
      throw new Error('Unexpected method')
    },
  }
}
function directory() { return mkdtempSync(join(tmpdir(), 'morpho-history-')) }

test('dry state and quiet segments cover the whole scanned range; resume is append-only', async () => {
  const out = directory(), f = fixture()
  assert.deepEqual(verify({ out, sources }).throughBlock, FROM_BLOCK - 1)
  const firstRun = await collect({ out, sources, rpcRead: f.rpcRead, stat, maxChunks: 1 })
  assert.equal(firstRun.throughBlock, first + CHUNK_BLOCKS - 1)
  assert.equal(firstRun.eventCount, 0)
  const files = readdirSync(out)
  assert.equal(files.length, 1)
  const saved = JSON.parse(readFileSync(join(out, files[0])))
  assert.deepEqual(saved.scans.map((x) => [x.kind, x.rawCount, x.eventCount]),
    [['allocate', 0, 0], ['deallocate', 0, 0]])
  const originalBytes = readFileSync(join(out, files[0]), 'utf8')
  const secondRun = await collect({ out, sources, rpcRead: f.rpcRead, stat, maxChunks: 1 })
  assert.equal(secondRun.throughBlock, second + CHUNK_BLOCKS - 1)
  assert.equal(readFileSync(join(out, files[0]), 'utf8'), originalBytes)
  assert.equal(verify({ out, sources }).segmentCount, 2)
})

test('multi-ID assets remain event-level and signed change applies to each ID', async () => {
  const raw = log()
  const detail = decodeAllocation('allocate', {
    ...raw, address: raw.address.toLowerCase(), topics: raw.topics.map((x) => x.toLowerCase()),
    data: raw.data.toLowerCase(),
  })
  assert.equal(detail.assets, '100')
  assert.deepEqual(detail.ids, [hash(7), hash(8)])
  assert.equal(detail.change, '12')
  const out = directory(), f = fixture({ logs: [raw, log('deallocate', first + 5)] })
  await collect({ out, sources, rpcRead: f.rpcRead, stat })
  const saved = JSON.parse(readFileSync(join(out, readdirSync(out)[0])))
  assert.deepEqual(saved.events.map((x) => x.detail.change), ['12', '-12'])
  assert.equal(verify({ out, sources }).eventCount, 2)
})

test('malformed matching-vault log and oversized IDs stop before append', async () => {
  for (const bad of [log('allocate', first + 4, { data: '0x00' }),
    log('allocate', first + 4, { data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bytes32[]' }, { type: 'int256' }],
      [100n, Array(257).fill(hash(7)), 12n]) })]) {
    const out = directory(), f = fixture({ logs: [bad] })
    await assert.rejects(collect({ out, sources, rpcRead: f.rpcRead, stat }))
    assert.equal(verify({ out, sources }).segmentCount, 0)
  }
})

test('duplicate coordinate and orphan interior block fail closed', async () => {
  const event = log()
  const duplicated = fixture({ logs: [event, event] })
  await assert.rejects(collect({ out: directory(), sources, rpcRead: duplicated.rpcRead, stat }), /Duplicate/)
  const orphan = fixture({ logs: [event], tamperHeader: (n) => n === first + 4 })
  await assert.rejects(collect({ out: directory(), sources, rpcRead: orphan.rpcRead, stat }), /Orphan/)
})

test('offline verifier rejects missing quiet segment, re-sealed altered event and partial coverage', async () => {
  const out = directory(), f = fixture({ logs: [log()] })
  await collect({ out, sources, rpcRead: f.rpcRead, stat, maxChunks: 2 })
  let [name] = readdirSync(out)
  let path = join(out, name), saved = JSON.parse(readFileSync(path))
  saved.events[0].detail.change = '77'
  writeFileSync(path, JSON.stringify(seal(saved)))
  assert.throws(() => verify({ out, sources }), /Invalid census event/)
  const out2 = directory(), quiet = fixture()
  await collect({ out: out2, sources, rpcRead: quiet.rpcRead, stat, maxChunks: 2 })
  const [firstName, secondName] = readdirSync(out2)
  const secondBytes = readFileSync(join(out2, secondName))
  const hole = directory()
  writeFileSync(join(hole, secondName), secondBytes)
  assert.throws(() => verify({ out: hole, sources }), /continuity/)
  assert.equal(verify({ out: out2, sources }).complete, false)
  assert.ok(firstName)
})

test('1GiB reserve stops before any RPC or append', async () => {
  const out = directory(), f = fixture()
  await assert.rejects(collect({ out, sources, rpcRead: f.rpcRead,
    stat: () => ({ bavail: 1, bsize: 4096 }) }), /reserve/)
  assert.equal(f.calls.length, 0)
  assert.equal(verify({ out, sources }).segmentCount, 0)
})
