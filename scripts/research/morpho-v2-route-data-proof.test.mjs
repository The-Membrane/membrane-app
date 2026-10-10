import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keccak256 } from 'viem'
import { compareRouteDataBytes } from './morpho-v2-route-data-proof.mjs'

const VAULT = '0x1111111111111111111111111111111111111111'
const FROM = '0x2222222222222222222222222222222222222222'
const TO = '0x3333333333333333333333333333333333333333'
const B_HASH = `0x${'ab'.repeat(32)}`
const PRE_HASH = `0x${'cd'.repeat(32)}`
const CODE_HASH = keccak256('0x6000')
const anchor = {
  block: 100,
  blockHash: B_HASH,
  vault: VAULT,
  fromAdapter: FROM,
  toAdapter: TO,
  fromDataTopicHash: keccak256('0x01'),
  toDataTopicHash: keccak256('0x0203'),
  eventKey: '100:1:2',
  transactionIndex: 1,
  logIndex: 2,
  txHash: `0x${'ef'.repeat(32)}`,
}
const read = (block, blockHash, adapter, liquidityData) => ({
  block,
  blockHash,
  vault: VAULT,
  adapter,
  liquidityData,
  runtimeCodeHash: CODE_HASH,
  sourceAttestation: { status: 'deployed-verified', runtimeCodeHash: CODE_HASH },
})
const pair = () => ({
  anchor,
  manifestPhysicalSha256: '12'.repeat(32),
  previousBlockHash: PRE_HASH,
  beforeB: read(99, PRE_HASH, FROM, '0x01'),
  atB: read(100, B_HASH, TO, '0x0203'),
})

test('exact raw bytes and pinned identities match both topic hashes', () => {
  const result = compareRouteDataBytes(pair())
  assert.equal(result.status, 'matched')
  assert.equal(result.before.getterHash, anchor.fromDataTopicHash)
  assert.equal(result.after.getterHash, anchor.toDataTopicHash)
  assert.match(result.caveat, /end-of-block/)
})

test('different raw bytes mismatch the indexed topic', () => {
  const args = pair()
  args.atB.liquidityData = '0x04'
  assert.equal(compareRouteDataBytes(args).after.reason, 'indexed-byte-hash-mismatch')
  assert.equal(compareRouteDataBytes(args).status, 'mismatched')
})

test('wrong B or hash cannot match even with matching bytes', () => {
  const wrongBlock = pair()
  wrongBlock.atB.block = 101
  assert.equal(compareRouteDataBytes(wrongBlock).after.reason, 'block-or-hash-mismatch')
  const wrongHash = pair()
  wrongHash.beforeB.blockHash = B_HASH
  assert.equal(compareRouteDataBytes(wrongHash).before.reason, 'block-or-hash-mismatch')
})

test('missing deployed-source attestation is unavailable, not a proof', () => {
  const args = pair()
  args.atB.sourceAttestation = { status: 'github-main-only' }
  const result = compareRouteDataBytes(args)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.after.getterHash, null)
})

test('same-block later write can mismatch B without disproving event-time bytes', () => {
  const args = pair()
  args.atB.liquidityData = '0xffff'
  const result = compareRouteDataBytes(args)
  assert.equal(result.status, 'mismatched')
  assert.match(result.caveat, /same-block later write/)
})

test('malformed or unproven anchor shape fails closed before byte comparison', () => {
  const invalid = [
    { fromAdapter: TO },
    { fromAdapter: `0x${'0'.repeat(40)}` },
    { toAdapter: `0x${'0'.repeat(40)}` },
    { eventKey: '100:1:3' },
    { transactionIndex: -1 },
    { txHash: '0x01' },
  ]
  for (const patch of invalid)
    assert.throws(() => compareRouteDataBytes({ ...pair(), anchor: { ...anchor, ...patch } }))
  assert.throws(() => compareRouteDataBytes({ ...pair(), manifestPhysicalSha256: null }))
  const result = compareRouteDataBytes(pair())
  assert.match(result.assurance, /membership-unverified/)
  assert.match(result.caveat, /Caller-reported manifest SHA/)
})
