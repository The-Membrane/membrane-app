/** Lossless original-controller fields; raw bytes are stored once WHEN PRESENT.
 * A null rawBodyBase64 preserves the controller's missing capture, including oversized-body rejection.
 * This codec grants no native evidence or execution authority. */
import { createHash } from 'node:crypto'

export const MORPHO_PROBE_ROW_STORAGE_SCHEMA = 'morpho_probe_lossless_native_row_storage_v1'
export const MORPHO_PROBE_ROW_STORAGE_POLICY = Object.freeze({
  rawResponseBytes: 65536, aggregateRawResponseBytes: 5 * 1024 * 1024,
  maximumRetainedAggregateRawResponseBytes: 5 * 1024 * 1024 + 262144,
  encodedRowOverheadBytes: 8192,
})
const sha = (value) => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Error('morpho_probe_storage_' + code) }
const HASH = /^[0-9a-f]{64}$/
const FLAGS = Object.freeze({
  researchOnly: true, authenticated: false, originalAuthority: false,
  historicalOwnership: false, currentWalletControl: false, profileApproval: false,
  sourceImplementationEquivalence: false, holderExecutableExit: false,
  forecastEligibility: false, calibrated: false, coveragePromotion: false, competingMRaw: null,
})
/** Descriptor validation precedes copying; string and object insertion order are retained. */
function copyJson(value) {
  const ancestors = new WeakSet()
  let nodes = 0
  const visit = (v, depth = 0) => {
    check(++nodes <= 10000 && depth <= 32, 'json_bounds')
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number') { check(Number.isFinite(v), 'json_number'); return v }
    check(v && typeof v === 'object' && !ancestors.has(v), 'json_value')
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    check((array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null) &&
      Object.getOwnPropertySymbols(v).length === 0 &&
      Object.values(descriptors).every((d) => Object.hasOwn(d, 'value')), 'json_descriptor')
    ancestors.add(v)
    const out = array ? [] : {}
    try {
      if (array) {
        check(Object.keys(descriptors).length === v.length + 1, 'json_array')
        for (let i = 0; i < v.length; i++) {
          check(descriptors[i]?.enumerable, 'json_array')
          out.push(visit(descriptors[i].value, depth + 1))
        }
      } else for (const [key, descriptor] of Object.entries(descriptors)) {
        check(descriptor.enumerable, 'json_enumerable')
        // defineProperty retains a literal __proto__ JSON key without changing the prototype.
        Object.defineProperty(out, key, { value: visit(descriptor.value, depth + 1),
          enumerable: true, writable: true, configurable: true })
      }
      return out
    } finally { ancestors.delete(v) }
  }
  return visit(value)
}
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every((k) => Object.hasOwn(value, k))
const jsonSha = (value) => sha(JSON.stringify(value))
/** Closed opt-in applies only to the collector's named native block-header roles. */
export const MORPHO_NATIVE_HEADER_RESPONSE_POLICY = Object.freeze({
  schema: 'morpho_native_header_response_policy_v1', headerResponseBytes: 262144,
  headerKeys: Object.freeze(['fresh_finalized', 'current:header_before', 'current:header_after',
    'anchor_0:header_before', 'anchor_0:header_after', 'anchor_1:header_before', 'anchor_1:header_after']),
})
/** @param {typeof MORPHO_NATIVE_HEADER_RESPONSE_POLICY | null} [policy=null] */
export function morphoProbeResponseByteLimit(policy = null, request = null, role = null, requestKey = undefined) {
  const supplied = policy === null ? null : copyJson(policy)
  check(supplied === null || JSON.stringify(supplied) === JSON.stringify(MORPHO_NATIVE_HEADER_RESPONSE_POLICY),
    'header_policy')
  if (role === null) return MORPHO_PROBE_ROW_STORAGE_POLICY.rawResponseBytes
  const boundRole = copyJson(role), boundRequest = copyJson(request)
  check(supplied !== null && keys(boundRole, ['key', 'method', 'role']) &&
    boundRole.role === 'native_header' && boundRole.method === 'eth_getBlockByNumber' &&
    supplied.headerKeys.includes(boundRole.key) && boundRole.key === (requestKey === undefined ? boundRole.key : requestKey) &&
    boundRequest?.method === boundRole.method && Array.isArray(boundRequest.params) &&
    boundRequest.params.length === 2 && boundRequest.params[1] === false &&
    (boundRole.key === 'fresh_finalized' ? boundRequest.params[0] === 'finalized'
      : /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(boundRequest.params[0])),
    'header_role_binding')
  return supplied.headerResponseBytes
}
export function serializeMorphoProbeStorageValue(value) {
  return Buffer.from(JSON.stringify(value) + '\n')
}
function bindingFor(context) {
  check(context && typeof context.namespace === 'string' &&
    /^historical-owner-native-[a-zA-Z0-9-]{1,80}$/.test(context.namespace) &&
    Number.isSafeInteger(context.physicalId) && context.physicalId > 0 && context.physicalId <= 100 &&
    Object.hasOwn(context, 'source'), 'binding')
  const source = copyJson(context.source)
  check(source === null || (source.chainId === 1 && /^0x[0-9a-f]{64}$/.test(source.blockHash)), 'source')
  return { namespace: context.namespace, physicalId: context.physicalId, sourceSha256: jsonSha(source) }
}
function rawBytes(observation, policy = null, requestKey = null) {
  const maximum = morphoProbeResponseByteLimit(policy, observation?.request, observation?.nativeHeaderRole ?? null, requestKey)
  check(observation && Object.hasOwn(observation, 'rawBodyBase64'), 'missing_raw_field')
  const raw = observation.rawBodyBase64
  if (raw === null) return 0
  check(typeof raw === 'string', 'raw_type')
  check(raw.length <= 4 * Math.ceil(maximum / 3), 'raw_body')
  const bytes = Buffer.from(raw, 'base64')
  check(bytes.toString('base64') === raw && bytes.length <= maximum &&
    raw.length === 4 * Math.ceil(bytes.length / 3) &&
    bytes.length === observation.bodyBytes && sha(bytes) === observation.bodySha256, 'raw_body')
  return bytes.length
}
function validateRow(row, binding, policy = null) {
  check(row && row.namespace === binding.namespace && row.physicalId === binding.physicalId &&
    row.observation?.physicalId === binding.physicalId && Object.hasOwn(row, 'request') &&
    Object.hasOwn(row, 'settlement') && Object.entries(FLAGS).every(([key, value]) => row[key] === value), 'row_binding')
  rawBytes(row.observation, policy, row.request?.key ?? null)
  if (row.observation.nativeHeaderRole) {
    check(row.request !== null, 'header_request_required')
    const rawRequest = Buffer.from(row.request.requestBodyBase64, 'base64')
    check(rawRequest.toString('base64') === row.request.requestBodyBase64 &&
      sha(rawRequest) === row.request.requestBodySha256 &&
      rawRequest.toString('utf8') === JSON.stringify(row.observation.request), 'header_request_commitment')
  }
  if (row.request !== null)
    check(row.request.controlNamespace === binding.namespace && row.request.physicalId === binding.physicalId,
      'request_binding')
  if (row.settlement !== null) {
    check(row.settlement.physicalId === binding.physicalId && row.settlement.captureAcceptance === false &&
      JSON.stringify(row.settlement.observation) === JSON.stringify(row.observation), 'settlement_observation_equality')
    const { sha256, ...body } = row.settlement
    check(HASH.test(sha256) && jsonSha(body) === sha256, 'settlement_seal')
  }
}
const rawReference = (binding, observation) => ({
  storageReference: 'row.observation.rawBodyBase64', ...binding,
  rawBodySha256: observation.bodySha256,
})
export function encodedMorphoProbeRowOverheadBytes(encoded) {
  const blank = copyJson(encoded)
  check(blank.row?.observation && Object.hasOwn(blank.row.observation, 'rawBodyBase64'), 'missing_raw_field')
  const raw = blank.row.observation.rawBodyBase64
  check(typeof raw === 'string' || raw === null, 'raw_type')
  // A missing controller capture is literal null metadata, so its bytes belong to overhead.
  if (typeof raw === 'string') blank.row.observation.rawBodyBase64 = ''
  return serializeMorphoProbeStorageValue(blank).length
}
export function encodeMorphoProbeNativeRow(original, context) {
  const row = copyJson(original), binding = bindingFor(context)
  validateRow(row, binding, context.headerResponsePolicy ?? null)
  const originalRowJsonSha256 = jsonSha(row), originalObservationJsonSha256 = jsonSha(row.observation)
  const originalSettlementJsonSha256 = jsonSha(row.settlement)
  if (row.settlement !== null) {
    // Equality was proved above. Replacing this existing key preserves its exact insertion position.
    row.settlement.observation.rawBodyBase64 = rawReference(binding, row.observation)
  }
  const body = {
    schema: MORPHO_PROBE_ROW_STORAGE_SCHEMA, binding,
    originalRowJsonSha256, originalObservationJsonSha256, originalSettlementJsonSha256, row,
  }
  const encoded = { ...body, sha256: jsonSha(body) }
  check(encodedMorphoProbeRowOverheadBytes(encoded) <= MORPHO_PROBE_ROW_STORAGE_POLICY.encodedRowOverheadBytes,
    'encoded_overhead')
  return encoded
}
/** Expected commitments come from the original control/settlements, never from the stored row itself. */
export function decodeMorphoProbeNativeRow(supplied, expected) {
  const encoded = copyJson(supplied), binding = bindingFor(expected)
  check(keys(encoded, ['schema', 'binding', 'originalRowJsonSha256', 'originalObservationJsonSha256',
    'originalSettlementJsonSha256', 'row', 'sha256']) && encoded.schema === MORPHO_PROBE_ROW_STORAGE_SCHEMA &&
    JSON.stringify(encoded.binding) === JSON.stringify(binding), 'schema_or_binding')
  const { sha256, ...body } = encoded
  check(HASH.test(sha256) && jsonSha(body) === sha256 &&
    HASH.test(expected.rowJsonSha256) && HASH.test(expected.observationJsonSha256) && HASH.test(expected.settlementJsonSha256) &&
    encoded.originalRowJsonSha256 === expected.rowJsonSha256 &&
    encoded.originalObservationJsonSha256 === expected.observationJsonSha256 &&
    encoded.originalSettlementJsonSha256 === expected.settlementJsonSha256, 'storage_or_expected_commitment')
  const row = encoded.row
  if (row.settlement !== null) {
    check(JSON.stringify(row.settlement?.observation?.rawBodyBase64) ===
      JSON.stringify(rawReference(binding, row.observation)), 'raw_reference')
    row.settlement.observation.rawBodyBase64 = row.observation.rawBodyBase64
  }
  validateRow(row, binding, expected.headerResponsePolicy ?? null)
  check(jsonSha(row) === encoded.originalRowJsonSha256 &&
    jsonSha(row.observation) === encoded.originalObservationJsonSha256 &&
    jsonSha(row.settlement) === encoded.originalSettlementJsonSha256, 'restored_commitment')
  check(encodedMorphoProbeRowOverheadBytes(supplied) <= MORPHO_PROBE_ROW_STORAGE_POLICY.encodedRowOverheadBytes,
    'encoded_overhead')
  return row
}
export function morphoProbeEncodedRawResponseBytes(encoded, headerResponsePolicy = null) {
  const row = copyJson(encoded.row)
  return rawBytes(row?.observation, headerResponsePolicy, row?.request?.key ?? null)
}
