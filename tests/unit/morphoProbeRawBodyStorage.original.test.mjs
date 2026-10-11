import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  MORPHO_PROBE_ROW_STORAGE_SCHEMA, MORPHO_PROBE_ROW_STORAGE_POLICY,
  MORPHO_NATIVE_HEADER_RESPONSE_POLICY, morphoProbeResponseByteLimit,
  encodeMorphoProbeNativeRow, decodeMorphoProbeNativeRow,
  encodedMorphoProbeRowOverheadBytes, morphoProbeEncodedRawResponseBytes,
  serializeMorphoProbeStorageValue,
} from '../../scripts/research/morpho-probe-raw-body-storage.mjs'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const clone = (value) => JSON.parse(JSON.stringify(value))
const source = { chainId: 1, blockNumber: '10240', blockHash: '0x' + '11'.repeat(32),
  blockTime: '2026-10-09T08:00:00.000Z', finalized: true }
const flags = { researchOnly: true, authenticated: false, originalAuthority: false,
  historicalOwnership: false, currentWalletControl: false, profileApproval: false,
  sourceImplementationEquivalence: false, holderExecutableExit: false,
  forecastEligibility: false, calibrated: false, coveragePromotion: false, competingMRaw: null }
function fixture({ padding = 0, pending = false, failed = false, sourceValue = source } = {}) {
  const namespace = 'historical-owner-native-codec-fixture'
  const rpc = { jsonrpc: '2.0', id: 9, method: 'eth_chainId', params: [] }
  const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, result: '0x1' }) + ' '.repeat(padding))
  const observation = {
    physicalId: 1, host: 'eth-mainnet.g.alchemy.com', stage: 'fixture', request: rpc,
    startedAtUtc: '2026-10-09T08:20:00.000Z', startedElapsedMs: 0,
    completedAtUtc: pending ? null : '2026-10-09T08:20:00.001Z', completedElapsedMs: pending ? null : 1,
    status: pending ? 'pending' : failed ? 'failed' : 'success', httpStatus: pending ? null : 200,
    bodyBytes: pending ? null : raw.length, bodySha256: pending ? null : sha(raw),
    rawBodyBase64: pending ? null : raw.toString('base64'),
    safeCode: failed ? 'provider_unavailable' : null, accepted: !pending && !failed,
  }
  const body = { schema: 'usd3_hypothetical_physical_settlement_v1', physicalId: 1,
    captureAcceptance: false, observation: clone(observation) }
  const settlement = pending ? null : { ...body, sha256: sha(JSON.stringify(body)) }
  const requestBytes = Buffer.from(JSON.stringify(rpc))
  const original = { namespace, physicalId: 1, request: {
    controlNamespace: namespace, physicalId: 1, rpcId: 9, key: 'chain', host: observation.host,
    requestBodyBase64: requestBytes.toString('base64'), requestBodySha256: sha(requestBytes),
  }, observation, settlement, ...flags }
  const context = { namespace, physicalId: 1, source: sourceValue,
    rowJsonSha256: sha(JSON.stringify(original)), observationJsonSha256: sha(JSON.stringify(observation)),
    settlementJsonSha256: sha(JSON.stringify(settlement)) }
  return { original, context, raw }
}
function reseal(encoded) {
  const { sha256, ...body } = encoded
  return { ...body, sha256: sha(JSON.stringify(body)) }
}
test('the explicit v1 storage schema stores each raw Base64 response once and restores exact JSON key order', () => {
  const f = fixture({ padding: 12345 }), original = JSON.stringify(f.original)
  const encoded = encodeMorphoProbeNativeRow(f.original, f.context)
  assert.equal(encoded.schema, MORPHO_PROBE_ROW_STORAGE_SCHEMA)
  assert.equal(encoded.row.observation.rawBodyBase64, f.original.observation.rawBodyBase64)
  assert.equal(typeof encoded.row.settlement.observation.rawBodyBase64, 'object')
  assert.equal(JSON.stringify(encoded).split(f.original.observation.rawBodyBase64).length - 1, 1)
  const restored = decodeMorphoProbeNativeRow(encoded, f.context)
  assert.equal(JSON.stringify(restored), original)
  assert.equal(sha(JSON.stringify(restored.observation)), f.context.observationJsonSha256)
  assert.equal(sha(JSON.stringify(restored.settlement)), f.context.settlementJsonSha256)
  assert.deepEqual(Object.keys(restored.observation), Object.keys(f.original.observation))
  assert.equal(JSON.stringify(f.original), original)
})
test('failed bodies and pending null raw-body/settlement fields remain lossless', () => {
  for (const options of [{ failed: true }, { pending: true, sourceValue: null }]) {
    const f = fixture(options), encoded = encodeMorphoProbeNativeRow(f.original, f.context)
    assert.equal(JSON.stringify(decodeMorphoProbeNativeRow(encoded, f.context)), JSON.stringify(f.original))
  }
})
test('oversized rejection preserves the controller body-count/hash metadata without inventing absent raw bytes', () => {
  const f = fixture({ failed: true })
  f.original.observation.rawBodyBase64 = null
  f.original.observation.bodyBytes = 65537
  f.original.observation.bodySha256 = 'ab'.repeat(32)
  f.original.settlement.observation = clone(f.original.observation)
  const { sha256, ...body } = f.original.settlement
  f.original.settlement.sha256 = sha(JSON.stringify(body))
  f.context.rowJsonSha256 = sha(JSON.stringify(f.original))
  f.context.observationJsonSha256 = sha(JSON.stringify(f.original.observation))
  f.context.settlementJsonSha256 = sha(JSON.stringify(f.original.settlement))
  const encoded = encodeMorphoProbeNativeRow(f.original, f.context)
  assert.equal(morphoProbeEncodedRawResponseBytes(encoded), 0)
  assert.equal(encodedMorphoProbeRowOverheadBytes(encoded), serializeMorphoProbeStorageValue(encoded).length)
  assert.equal(JSON.stringify(decodeMorphoProbeNativeRow(encoded, f.context)), JSON.stringify(f.original))
})
test('Base64 padding and overhead are measured from the actual encoded serializer', () => {
  for (const padding of [0, 1, 2, 3, 65000]) {
    const f = fixture({ padding }), encoded = encodeMorphoProbeNativeRow(f.original, f.context)
    const blank = clone(encoded); blank.row.observation.rawBodyBase64 = ''
    assert.equal(encodedMorphoProbeRowOverheadBytes(encoded), serializeMorphoProbeStorageValue(blank).length)
    assert.equal(serializeMorphoProbeStorageValue(encoded).length,
      serializeMorphoProbeStorageValue(blank).length + 4 * Math.ceil(f.raw.length / 3))
    assert.equal(morphoProbeEncodedRawResponseBytes(encoded), f.raw.length)
    assert.ok(encodedMorphoProbeRowOverheadBytes(encoded) <= 8192)
  }
})
test('per-response 64 KiB cap refuses excess native raw bytes instead of truncating', () => {
  const f = fixture({ padding: 65536 })
  assert.throws(() => encodeMorphoProbeNativeRow(f.original, f.context), /raw_body/)
  assert.equal(MORPHO_PROBE_ROW_STORAGE_POLICY.maximumRetainedAggregateRawResponseBytes, 5505024)
})
test('reference substitution requires exact observation equality and valid original settlement seal', () => {
  const f = fixture(), changed = clone(f.original)
  changed.settlement.observation.rawBodyBase64 = Buffer.from('different').toString('base64')
  assert.throws(() => encodeMorphoProbeNativeRow(changed, f.context), /settlement_observation_equality/)
  const seal = clone(f.original); seal.settlement.sha256 = '0'.repeat(64)
  assert.throws(() => encodeMorphoProbeNativeRow(seal, f.context), /settlement_seal/)
})
test('raw-body corruption is rejected even when the storage envelope is resealed', () => {
  const f = fixture(), encoded = encodeMorphoProbeNativeRow(f.original, f.context)
  encoded.row.observation.rawBodyBase64 = Buffer.from('corrupted').toString('base64')
  assert.throws(() => decodeMorphoProbeNativeRow(reseal(encoded), f.context), /raw_body/)
})
test('reference namespace, physical id, source hash, body hash and missing target are independently bound', () => {
  for (const change of [
    (r) => { r.namespace += '-foreign' }, (r) => { r.physicalId = 2 },
    (r) => { r.sourceSha256 = '0'.repeat(64) }, (r) => { r.rawBodySha256 = '0'.repeat(64) },
    (r) => { r.storageReference = 'missing.rawBodyBase64' },
  ]) {
    const f = fixture(), encoded = encodeMorphoProbeNativeRow(f.original, f.context)
    change(encoded.row.settlement.observation.rawBodyBase64)
    assert.throws(() => decodeMorphoProbeNativeRow(reseal(encoded), f.context), /raw_reference/)
  }
})
test('external expected namespace/id/source and original JSON commitments cannot be rebound', () => {
  for (const change of [
    (c) => { c.namespace += '-foreign' }, (c) => { c.physicalId = 2 },
    (c) => { c.source.blockHash = '0x' + '22'.repeat(32) },
    (c) => { c.observationJsonSha256 = '0'.repeat(64) },
    (c) => { c.settlementJsonSha256 = '0'.repeat(64) },
    (c) => { c.rowJsonSha256 = '0'.repeat(64) },
  ]) {
    const f = fixture(), encoded = encodeMorphoProbeNativeRow(f.original, f.context), context = clone(f.context)
    change(context)
    assert.throws(() => decodeMorphoProbeNativeRow(encoded, context))
  }
})
test('missing raw data, missing reference and tampered original hashes cannot decode', () => {
  for (const change of [
    (e) => { delete e.row.observation.rawBodyBase64 },
    (e) => { delete e.row.settlement.observation.rawBodyBase64 },
    (e) => { e.originalObservationJsonSha256 = '0'.repeat(64) },
    (e) => { e.sha256 = '0'.repeat(64) },
  ]) {
    const f = fixture(), encoded = encodeMorphoProbeNativeRow(f.original, f.context)
    change(encoded)
    assert.throws(() => decodeMorphoProbeNativeRow(encoded, f.context))
  }
})
test('opaque zero/positive amounts and contract code stay typed while authority flags remain false', () => {
  for (const S of ['0', '1234567890123456789']) {
    const f = fixture()
    f.original.observation.math = { sharesRaw: S, fullEaRaw: S === '0' ? null : '987654321', rawCode: '0x6000' }
    f.original.settlement.observation = clone(f.original.observation)
    const { sha256, ...body } = f.original.settlement
    f.original.settlement.sha256 = sha(JSON.stringify(body))
    f.context.rowJsonSha256 = sha(JSON.stringify(f.original))
    f.context.observationJsonSha256 = sha(JSON.stringify(f.original.observation))
    f.context.settlementJsonSha256 = sha(JSON.stringify(f.original.settlement))
    const encoded = encodeMorphoProbeNativeRow(f.original, f.context)
    const restored = decodeMorphoProbeNativeRow(encoded, f.context)
    assert.deepEqual(restored.observation.math, f.original.observation.math)
    for (const [key, value] of Object.entries(flags)) assert.equal(restored[key], value)
  }
})
test('descriptor getters, cycles and authority promotion reject without source mutation', () => {
  const f = fixture()
  let calls = 0
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { calls++; return 'secret' } })
  assert.throws(() => encodeMorphoProbeNativeRow(getter, f.context), /json_descriptor/)
  assert.equal(calls, 0)
  const cycle = {}; cycle.x = cycle
  assert.throws(() => encodeMorphoProbeNativeRow(cycle, f.context), /json_value/)
  const promoted = clone(f.original); promoted.authenticated = true
  assert.throws(() => encodeMorphoProbeNativeRow(promoted, f.context), /row_binding/)
})


test('closed named-header policy rejects forged key, method, role, params and widening', () => {
  const policy = MORPHO_NATIVE_HEADER_RESPONSE_POLICY
  const request = { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', false] }
  const role = { key: 'fresh_finalized', method: request.method, role: 'native_header' }
  assert.equal(morphoProbeResponseByteLimit(), 65536)
  assert.equal(morphoProbeResponseByteLimit(policy, request, null, role.key), 65536)
  assert.equal(morphoProbeResponseByteLimit(policy, request, role, role.key), 262144)
  for (const [p, r, h, key] of [
    [null, request, role, role.key], [policy, request, role, 'current:chain'],
    [policy, { ...request, method: 'eth_call' }, role, role.key],
    [policy, { ...request, params: ['finalized', true] }, role, role.key],
    [policy, request, { ...role, role: 'call' }, role.key],
    [policy, request, { ...role, key: 'forged_header' }, 'forged_header'],
    [{ ...policy, headerResponseBytes: 262145 }, request, role, role.key],
    [{ ...policy, unplanned: true }, request, role, role.key],
  ]) assert.throws(() => morphoProbeResponseByteLimit(p, r, h, key), /header_(policy|role_binding)/)
})
test('256 KiB opted-in header codec roundtrip is byte exact; unopted and byte 262145 are refused', () => {
  const make = (length) => {
    const f = fixture()
    const rpc = { jsonrpc: '2.0', id: 9, method: 'eth_getBlockByNumber', params: ['finalized', false] }
    const requestBytes = Buffer.from(JSON.stringify(rpc)), raw = Buffer.from(' '.repeat(length))
    Object.assign(f.original.request, { key: 'fresh_finalized', requestBodyBase64: requestBytes.toString('base64'),
      requestBodySha256: sha(requestBytes) })
    Object.assign(f.original.observation, { request: rpc, nativeHeaderRole: {
      key: 'fresh_finalized', method: rpc.method, role: 'native_header' },
      rawBodyBase64: raw.toString('base64'), bodyBytes: raw.length, bodySha256: sha(raw) })
    f.original.settlement.observation = clone(f.original.observation)
    const { sha256, ...body } = f.original.settlement; f.original.settlement.sha256 = sha(JSON.stringify(body))
    Object.assign(f.context, { headerResponsePolicy: MORPHO_NATIVE_HEADER_RESPONSE_POLICY,
      rowJsonSha256: sha(JSON.stringify(f.original)), observationJsonSha256: sha(JSON.stringify(f.original.observation)),
      settlementJsonSha256: sha(JSON.stringify(f.original.settlement)) })
    return f
  }
  const f = make(262144), encoded = encodeMorphoProbeNativeRow(f.original, f.context)
  assert.equal(JSON.stringify(decodeMorphoProbeNativeRow(encoded, f.context)), JSON.stringify(f.original))
  assert.equal(morphoProbeEncodedRawResponseBytes(encoded, MORPHO_NATIVE_HEADER_RESPONSE_POLICY), 262144)
  const { headerResponsePolicy, ...legacy } = f.context
  assert.throws(() => encodeMorphoProbeNativeRow(f.original, legacy), /header_role_binding/)
  assert.throws(() => encodeMorphoProbeNativeRow(make(262145).original, f.context), /raw_body/)
  const mismatch = clone(f.original); mismatch.request.key = 'current:header_before'
  assert.throws(() => encodeMorphoProbeNativeRow(mismatch, f.context), /header_role_binding/)
})
