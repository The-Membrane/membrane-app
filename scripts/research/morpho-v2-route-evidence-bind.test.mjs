import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { keccak256 } from 'viem'
import {
  bindSealedRouteEvidence,
  selectUniqueRouteAnchor,
} from './morpho-v2-route-evidence-bind.mjs'
import { readSealedRouteRiskManifest } from './morpho-v2-route-risk-manifest.mjs'

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const cache = fileURLToPath(new URL('../../data/research/venue-signals/', import.meta.url))
const paths = {
  factoryPath: join(cache, '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa.json'),
  routePath: join(cache, 'morpho-v2-route-census.json'),
  headerPath: join(cache, 'morpho-v2-route-address-headers.json'),
}
const identity = (row) => ({
  eventKey: row.eventKey,
  vault: row.vault,
  asset: row.asset,
  factoryCreationBlock: row.factoryCreationBlock,
  block: row.block,
  blockHash: row.blockHash,
  transactionIndex: row.transactionIndex,
  txHash: row.txHash,
  logIndex: row.logIndex,
  fromAdapter: row.fromAdapter,
  toAdapter: row.toAdapter,
  fromDataTopicHash: row.fromDataTopicHash,
  toDataTopicHash: row.toDataTopicHash,
})
const syntheticRow = (n) => ({
  eventKey: `${100 + n}:0:${n}`,
  vault: address(1000 + n),
  asset: address(2),
  factoryCreationBlock: 1,
  block: 100 + n,
  blockHash: hash(100 + n),
  transactionIndex: 0,
  txHash: hash(1000 + n),
  logIndex: n,
  fromAdapter: address(3),
  toAdapter: address(4),
  fromDataTopicHash: keccak256('0x01'),
  toDataTopicHash: keccak256('0x02'),
  header: { block: 100 + n, hash: hash(100 + n), timestamp: n },
})
const synthetic = () => ({
  study: 'morpho-v2-route-risk-manifest-v1',
  transitionCount: 116,
  transitions: Array.from({ length: 116 }, (_, index) => syntheticRow(index)),
})

test('pure selector derives the full trusted row and rejects absent, duplicate, and modified identities', () => {
  const manifest = synthetic()
  const claim = identity(manifest.transitions[0])
  assert.equal(selectUniqueRouteAnchor(manifest, claim), manifest.transitions[0])
  for (const field of Object.keys(claim)) {
    const mutated = {
      ...claim,
      [field]: typeof claim[field] === 'number' ? claim[field] + 1 : 'wrong',
    }
    assert.throws(() => selectUniqueRouteAnchor(manifest, mutated), /anchor/)
    const omitted = { ...claim }
    delete omitted[field]
    assert.throws(() => selectUniqueRouteAnchor(manifest, omitted))
  }
  assert.throws(
    () => selectUniqueRouteAnchor(manifest, { ...claim, eventKey: '999:0:0' }),
    /absent/,
  )
  manifest.transitions[1].eventKey = claim.eventKey
  assert.throws(() => selectUniqueRouteAnchor(manifest, claim), /Duplicate/)
})

test('real sealed 116-event source binds one exact event and physical input file SHAs', () => {
  const manifest = readSealedRouteRiskManifest({ ...paths })
  const row = manifest.transitions[0]
  const result = bindSealedRouteEvidence({
    ...paths,
    claimedAnchor: identity(row),
    previousBlockHash: hash(999),
  })
  assert.equal(result.eventKey, row.eventKey)
  assert.deepEqual(result.anchor, identity(row))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.before.reason, 'getter-unavailable')
  assert.equal(result.after.reason, 'getter-unavailable')
  assert.deepEqual(result.sourcePhysicalSha256, {
    factory: sha(readFileSync(paths.factoryPath)),
    route: sha(readFileSync(paths.routePath)),
    headers: sha(readFileSync(paths.headerPath)),
  })
  assert.equal(result.reconstructedManifestSha256, sha(JSON.stringify(manifest)))
  assert.match(result.assurance, /getter-reads-caller-supplied/)
  assert.match(result.caveat, /not the SHA of a stored manifest file/)
})

test('matching caller getter bytes retain a narrow assurance despite asserted source attestation', () => {
  const row = readSealedRouteRiskManifest({ ...paths }).transitions[0]
  assert.equal(row.fromDataTopicHash, keccak256('0x'))
  assert.equal(row.toDataTopicHash, keccak256('0x'))
  const previousBlockHash = hash(999)
  const runtimeCodeHash = keccak256('0x6000')
  const read = (block, blockHash, adapter) => ({
    block,
    blockHash,
    vault: row.vault,
    adapter,
    liquidityData: '0x',
    runtimeCodeHash,
    sourceAttestation: { status: 'deployed-verified', runtimeCodeHash },
  })
  const result = bindSealedRouteEvidence({
    ...paths,
    claimedAnchor: identity(row),
    previousBlockHash,
    beforeB: read(row.block - 1, previousBlockHash, row.fromAdapter),
    atB: read(row.block, row.blockHash, row.toAdapter),
  })
  assert.equal(result.status, 'matched')
  assert.equal(result.before.reason, 'indexed-byte-hash-equality')
  assert.equal(result.after.reason, 'indexed-byte-hash-equality')
  assert.equal(result.assurance, 'sealed-source-anchor-membership;getter-reads-caller-supplied')
  assert.match(result.caveat, /Caller-supplied getter bytes and source-attestation fields/)
  assert.match(result.caveat, /do not prove RPC provenance/)
  assert.match(result.caveat, /executable withdrawal/)
})

test('sealed wrapper rejects tampered row and physically altered source', () => {
  const row = readSealedRouteRiskManifest({ ...paths }).transitions[0]
  assert.throws(
    () =>
      bindSealedRouteEvidence({
        ...paths,
        claimedAnchor: { ...identity(row), toDataTopicHash: hash(7) },
        previousBlockHash: hash(999),
      }),
    /toDataTopicHash/,
  )
  const temp = mkdtempSync(join(tmpdir(), 'morpho-route-bind-'))
  try {
    const changedHeaderPath = join(temp, 'headers.json')
    const bytes = readFileSync(paths.headerPath)
    writeFileSync(changedHeaderPath, Buffer.concat([bytes, Buffer.from(' ')]))
    assert.throws(
      () =>
        bindSealedRouteEvidence({
          ...paths,
          headerPath: changedHeaderPath,
          claimedAnchor: identity(row),
          previousBlockHash: hash(999),
        }),
      /physical SHA mismatch/,
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('later same-block data differs without rejecting source membership or claiming event-time state', () => {
  const row = readSealedRouteRiskManifest({ ...paths }).transitions[0]
  const runtimeCodeHash = keccak256('0x6000')
  const result = bindSealedRouteEvidence({
    ...paths,
    claimedAnchor: identity(row),
    previousBlockHash: hash(999),
    atB: {
      block: row.block,
      blockHash: row.blockHash,
      vault: row.vault,
      adapter: row.toAdapter,
      liquidityData: '0xffff',
      runtimeCodeHash,
      sourceAttestation: { status: 'deployed-verified', runtimeCodeHash },
    },
  })
  assert.equal(result.status, 'mismatched')
  assert.equal(result.after.reason, 'indexed-byte-hash-mismatch')
  assert.match(result.caveat, /later same-block write/)
  assert.match(result.caveat, /Caller-supplied getter bytes/)
})
