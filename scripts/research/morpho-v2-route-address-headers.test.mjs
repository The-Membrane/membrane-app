import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  classifyAddressChanges, collect, decodeHeader, seal, STUDY, ROUTE_SHA,
  validateCheckpoint,
} from './morpho-v2-route-address-headers.mjs'

const a = `0x${'a'.repeat(40)}`
const b = `0x${'b'.repeat(40)}`
const x = `0x${'1'.repeat(40)}`
const y = `0x${'2'.repeat(40)}`
const z = `0x${'3'.repeat(40)}`
const hash = (character) => `0x${character.repeat(64)}`
const event = (vault, block, logIndex, adapter, blockHash) => ({
  vault, block, logIndex, transactionIndex: 0, txHash: hash('a'),
  adapter, blockHash, dataTopicHash: hash('b'),
})
const route = { status: 'complete', events: [
  event(a, 10, 0, x, hash('1')),
  event(a, 11, 0, x, hash('2')), // same ADDRESS, even if adapter data changed
  event(b, 12, 0, x, hash('3')), // first route in this vault
  event(a, 13, 0, y, hash('4')),
  event(b, 13, 1, z, hash('4')), // same block, distinct vault; one header
  event(a, 14, 0, x, hash('5')),
] }

test('classifies only consecutive per-vault adapter address changes', () => {
  const { changes, blocks } = classifyAddressChanges(route)
  assert.deepEqual(blocks, [13, 14])
  assert.equal(changes.length, 3)
  assert.deepEqual(changes.map((item) => [item.vault, item.fromAdapter, item.toAdapter]), [
    [a, x, y], [b, x, z], [a, y, x],
  ])
})

test('rejects conflicting hashes at a shared event block and mismatched RPC headers', () => {
  const altered = structuredClone(route)
  altered.events[4].blockHash = hash('f')
  assert.throws(() => classifyAddressChanges(altered), /Conflicting/)
  assert.deepEqual(decodeHeader({ number: '0xd', hash: hash('4'), timestamp: '0x64' },
    13, hash('4')), { block: 13, hash: hash('4'), timestamp: 100 })
  assert.throws(() => decodeHeader({ number: '0xd', hash: hash('f'), timestamp: '0x64' },
    13, hash('4')), /does not match/)
})

test('resumes in block order and detects tampered, nonmatching, or reordered headers offline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'morpho-route-headers-'))
  const out = join(directory, 'checkpoint.json')
  const calls = []
  const client = { getChainId: async () => 1 }
  const rpcRead = async (method, params) => {
    assert.equal(method, 'eth_getBlockByNumber')
    const block = Number(BigInt(params[0]))
    calls.push(block)
    return { number: params[0], hash: block === 13 ? hash('4') : hash('5'),
      timestamp: block === 13 ? '0x64' : '0x65' }
  }
  try {
    const first = await collect({ route, out, client, rpcRead, maxHeaders: 1 })
    assert.equal(first.status, 'partial')
    assert.deepEqual(calls, [13])
    const final = await collect({ route, out, client, rpcRead })
    assert.equal(final.status, 'complete')
    assert.deepEqual(calls, [13, 14])
    assert.equal(final.study, STUDY)
    assert.equal(final.routeArtifactSha256, ROUTE_SHA)
    assert.equal(validateCheckpoint(JSON.parse(readFileSync(out)), route).headers.length, 2)
    assert.throws(() => validateCheckpoint(seal({ ...final,
      headers: [{ ...final.headers[0], hash: hash('f') }, final.headers[1]] }), route),
    /header\/order/)
    assert.throws(() => validateCheckpoint(seal({ ...final,
      headers: [final.headers[1], final.headers[0]] }), route), /header\/order/)
    assert.throws(() => validateCheckpoint({ ...final, nextHeader: 1 }, route), /integrity/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('rejects wrong chain before reading headers', async () => {
  await assert.rejects(collect({ route, out: '/unused',
    client: { getChainId: async () => 10 } }), /Wrong chain/)
})
