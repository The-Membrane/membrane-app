import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  buildRouteRiskManifest,
  readSealedRouteRiskManifest,
} from './morpho-v2-route-risk-manifest.mjs'

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const A = address(100), B = address(101), C = address(102)
const asset = address(200), otherAsset = address(201)
const X = address(300), Y = address(301), Z = address(302), ZERO = address(0)
const factoryEvents = [
  { vault: A, asset, block: 1 },
  { vault: B, asset, block: 2 },
  { vault: C, asset: otherAsset, block: 3 },
]
const event = (vault, block, adapter, data = 1) => ({
  vault, block, blockHash: hash(block), transactionIndex: 0,
  txHash: hash(block + 1000), logIndex: block,
  adapter, dataTopicHash: hash(data),
})
const routeEvents = [
  event(A, 10, X),
  event(A, 11, X, 2), // Data-only change updates the prior data hash, not the address cohort.
  event(A, 12, Y, 3),
  event(A, 13, ZERO, 4),
  event(A, 14, Z, 5), // Zero-to-nonzero is excluded.
  event(B, 15, X, 6),
  event(B, 16, Y, 7),
]
const headers = [
  { block: 12, hash: hash(12), timestamp: 1200 },
  { block: 16, hash: hash(16), timestamp: 1600 },
]

test('pure manifest enumerates exact nonzero address changes and pre-B same-asset set', () => {
  const result = buildRouteRiskManifest({ factoryEvents, routeEvents, headers, expectedCount: 2 })
  assert.equal(result.transitionCount, 2)
  assert.deepEqual(result.split, { development: 1, heldOut: 1, sharedVaultCount: 0, vaultDisjointPartitions: true })
  assert.deepEqual(result.transitions.map((row) => row.split), ['development', 'held-out'])
  assert.deepEqual(result.transitions.map((row) => row.eventKey), ['12:0:12', '16:0:16'])
  assert.deepEqual(result.transitions[0].sameAssetFactoryVaultsCreatedBeforeB, [A, B])
  assert.equal(result.transitions[0].fromDataTopicHash, hash(2))
  assert.equal(result.transitions[0].toDataTopicHash, hash(3))
  assert.deepEqual(result.transitions[0].header, headers[0])
  assert.equal(result.transitions[0].fundedStatus, 'UNKNOWN')
  assert.equal(result.transitions[0].holderStatus, 'UNKNOWN')
  assert.equal(result.transitions[0].exitStatus, 'UNKNOWN')
  assert.equal(result.transitions[0].outcomeCohortInclusion, 'UNKNOWN')
  assert.match(result.caveat, /No causal, predictive or exit-risk claim/)
})

test('same-block factory creation is absent from the pre-B risk set', () => {
  const result = buildRouteRiskManifest({
    factoryEvents: [...factoryEvents, { vault: address(103), asset, block: 12 }],
    routeEvents,
    headers,
  })
  assert.deepEqual(result.transitions[0].sameAssetFactoryVaultsCreatedBeforeB, [A, B])
})

test('missing or mismatched B header and incomplete expected count fail closed', () => {
  assert.throws(() => buildRouteRiskManifest({ factoryEvents, routeEvents, headers: [], expectedCount: 2 }), /B header/)
  assert.throws(() => buildRouteRiskManifest({ factoryEvents, routeEvents, headers: [{ ...headers[0], hash: hash(999) }, headers[1]] }), /B header/)
  assert.throws(() => buildRouteRiskManifest({ factoryEvents, routeEvents, headers, expectedCount: 116 }), /Expected 116/)
})

test('read-only pinned caches contain all 116 transitions and a chronological 81/35 split', () => {
  const cache = fileURLToPath(new URL('../../data/research/venue-signals/', import.meta.url))
  const result = readSealedRouteRiskManifest({
    factoryPath: join(cache, '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa.json'),
    routePath: join(cache, 'morpho-v2-route-census.json'),
    headerPath: join(cache, 'morpho-v2-route-address-headers.json'),
  })
  assert.equal(result.transitionCount, 116)
  assert.deepEqual(result.split, { development: 81, heldOut: 35, sharedVaultCount: 4, vaultDisjointPartitions: false })
  assert.equal(result.transitions.filter((row) => row.vaultAppearsAcrossSplit).length > 0, true)
  assert.equal(result.transitions[0].eventKey, '23420016:224:488')
  assert.equal(result.transitions.at(-1).eventKey, '25925605:275:577')
  assert.ok(result.transitions.every((row) =>
    row.fromAdapter !== ZERO && row.toAdapter !== ZERO &&
    row.fundedStatus === 'UNKNOWN' && row.holderStatus === 'UNKNOWN' &&
    row.exitStatus === 'UNKNOWN'))
})
