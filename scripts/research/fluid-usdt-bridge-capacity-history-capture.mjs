// Finite, manual historical getters. No transaction or withdrawal simulation is launched.
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, writeFileSync, statfsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  keccak256,
} from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import { prepareFluidFullPositionHistoryPlan } from './fluid-usdt-full-position-history-capture.mjs'
import {
  prepareFluidWholePositionPathPlan,
  replayFluidWholePositionPath,
} from './fluid-usdt-whole-position-path-capture.mjs'
import {
  captureFluidCapacityProngs,
  replayFluidCapacityProngs,
  FLUID_CAPACITY_ABI,
} from './carry-fluid-capacity-prongs.mjs'

const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const check = (ok, code) => {
  if (!ok) throw Error('fluid_bridge_capacity_' + code)
}
const sha = (v) => createHash('sha256').update(v).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const keys = (v, wanted) =>
  record(v) && Object.keys(v).length === wanted.length && wanted.every((k) => Object.hasOwn(v, k))
const utc = (v) =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const HEX = /^0x(?:[0-9a-f]{2})*$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const ZERO = '0x' + '0'.repeat(40)
const prepared = new WeakSet()
const HOSTS = freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const LITE_IMPLEMENTATION = '0xe16ccc91a8134d428e7b6240177f9e2b227b9743'
const FUSDC = '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'
const BANK = '0x52aa899454998be5b000ad077a46bbe360f4e497'
const RESOLVER = '0xca13a15de31235a37134b4717021c35a3cf25c60'
const INPUT = freeze({
  path: 'data/research/venue-signals/fluid-usdt-whole-position-path-2026-10-07T19-44.json',
  bytes: 20935,
  fileSha256: 'ae7d24e26a5303b638bfdc23f961333ded0c2521f5c4da7af1e394c3138bcb6b',
  bodySha256: '3e734bb58d1e9c2fe1267e4358d9405bc63801bfa34fe3e88a1aab9c022b0eff',
})
const REFERENCE = freeze({
  implementation: LITE_IMPLEMENTATION,
  expectedFUSDC: FUSDC,
  runtimeKeccak256: '0x2156d45a268d405a90e3b7ae68fb2a5e8635b2e767da5307f90883118cad06ef',
  runtimeHexSha256: '58c2f22b1a690e9f2b7ad367da9ba6293ad14bce7393bab16a4fdb39184e03f2',
  runtimeBytes: 14009,
  runtimeReference: {
    url:
      'https://sourcify.dev/server/v2/contract/1/' +
      LITE_IMPLEMENTATION +
      '?fields=runtimeBytecode',
    responseBytes: 98551,
    responseSha256: '693d824a2385808e853cfb1e983759b1db6d9fb0dd1eb4cea3fcc57ae9c9eee4',
    reportedRuntimeMatch: 'exact_match',
  },
  sourceReference: {
    url:
      'https://sourcify.dev/server/v2/contract/1/' +
      LITE_IMPLEMENTATION +
      '?fields=sources,compilation',
    responseBytes: 353307,
    responseSha256: '4becb15a055e02bea0f41e8c14cfc4f58d4733fabfdaa8eb09d20fb5ada53d5a',
    mainSolSha256: '35b48826b3d14368e888d6090e8c0e0e426b5324c7ca4522bd2ac489665327fe',
  },
  proxyRuntimeReference: {
    url: 'https://sourcify.dev/server/v2/contract/1/0x273da948aca9261043fbdb2a857bc255ecc29012?fields=sources,compilation,runtimeBytecode',
    responseBytes: 33247,
    responseSha256: '40eafd1e4c9bdaa5cf4c3ec77c91153451ea0f86c7ae77c66a508ae3190a0cb6',
    runtimeBytes: 163,
    runtimeHexSha256: 'e8ccf9bf82d7b9c0fce7f3c6042988515901a0d81aeb7f0d83e34113c1afec08',
    runtimeKeccak256: '0xe271f71213f15998e1d3d3a5bec2ae0ca9d0e217a9b4467b3aa0d3b386e2394b',
    proxySolSha256: '5467eb595cda81062c643f6842d48b23a7b6117132e654ef084f6169c2d326f9',
    reportedRuntimeMatch: 'exact_match',
  },
  underlyingSourceEquivalence: 'unverified_at_captured_runtime',
})
export const FLUID_BRIDGE_CAPACITY_HISTORY_POLICY = freeze({
  maxRequests: 112,
  wrapperMaxRequests: 56,
  protocolMaxRequestsPerSource: 28,
  maxInFlightPerHost: 1,
  rpcTimeoutMs: 8000,
  retries: 0,
  maxResponseBytes: 65536,
  maxArtifactBytes: 1536 * 1024,
  reserveBytes: 128 * 1024 * 1024,
})
export const FLUID_BRIDGE_CAPACITY_ABI = freeze(
  parseAbi([
    'function getFUSDC() view returns(address)',
    'function getWithdrawalFeeBPS() view returns(uint256)',
    'function isWithdrawalsPaused() view returns(bool)',
    'function getIdleBalance() view returns(uint256)',
    'function balanceOf(address) view returns(uint256)',
    'function maxWithdraw(address) view returns(uint256)',
    'function previewRedeem(uint256) view returns(uint256)',
  ]),
)

/** Original issues, full E and full path are externally fixed raw evidence; this is zero RPC. */
export function prepareFluidBridgeCapacityHistoryPlan({ root = process.cwd() } = {}) {
  const original = prepareFluidFullPositionHistoryPlan({ root })
  const pathPlan = prepareFluidWholePositionPathPlan({ root })
  const text = readBoundedReceiptFile(resolve(root, INPUT.path), {
    maxFileBytes: INPUT.bytes,
    maxTotalBytes: INPUT.bytes,
    totalBytes: 0,
  })
  check(
    Buffer.byteLength(text) === INPUT.bytes && sha(text) === INPUT.fileSha256,
    'external_path_file_pin',
  )
  const raw = JSON.parse(text),
    { sha256, ...body } = raw
  check(
    sha256 === INPUT.bodySha256 && sha(JSON.stringify(body)) === INPUT.bodySha256,
    'external_path_body_pin',
  )
  const path = replayFluidWholePositionPath(raw, pathPlan)
  const plan = freeze({
    schema: 'fluid_usdt_bridge_capacity_history_plan_v1',
    subject: original.subject,
    originalIssueAnchors: original.anchors,
    fullPathInput: INPUT,
    priorInputEvidence: pathPlan.inputEvidence,
    priorEvidenceAvailableAtUtc: path.availableAtUtc,
    anchors: path.points.map((point, i) => {
      check(
        same(point.source, original.anchors[i].source) &&
          point.owner === original.subject.owner &&
          point.holderSharesRaw === original.anchors[i].originalHolderSharesRaw,
        'old_source_join',
      )
      return {
        source: point.source,
        holderSharesRaw: point.holderSharesRaw,
        fullPositionEntitlementRaw: point.fullPositionEntitlementRaw,
      }
    }),
    originHosts: HOSTS,
    policy: FLUID_BRIDGE_CAPACITY_HISTORY_POLICY,
    mechanismReference: REFERENCE,
    implementationSlot: SLOT,
    wrapperReadRolesPerSourceAndOrigin: [
      'header_before',
      'bridge_proxy_code',
      'implementation_slot_fixed_block_number',
      'implementation_code_from_native_slot_if_address_encoded',
      'get_fusdc',
      'fusdc_code_from_native_getter_if_nonzero_address',
      'withdrawal_fee_bps',
      'withdrawals_paused',
      'idle_fusdc_claim',
      'holder_balance',
      'lite_max_withdraw_incomplete',
      'full_preview_redeem_net_fee',
      'fusdc_max_withdraw_bridge_if_nonzero_native_fusdc',
      'header_after',
    ],
    protocolReadRolesPerSourceAndOrigin: [
      'chain',
      'finalized_required_by_existing_verifier',
      'header_before',
      'fusdc_code',
      'usdc_code',
      'bank_code',
      'resolver_code',
      'fusdc_asset',
      'usdc_decimals',
      'fusdc_getData',
      'resolver_LIQUIDITY',
      'resolver_getUserSupplyData_fusdc_usdc',
      'usdc_balanceOf_bank',
      'header_after',
    ],
    protocolSubject: {
      routeKey: 'USDC → Fluid USD Coin [USDC]',
      destination: FUSDC,
      asset: original.subject.asset,
      assetDecimals: 6,
    },
    protocolBank: BANK,
    protocolResolver: RESOLVER,
    protocolStage:
      'existing_raw_collector_and_verifier_28_reads_per_source_including_required_chain_finalized_handshake',
    headerRetention: 'native_number_hash_timestamp_only',
    storagePin: 'fixed_block_number_enclosed_by_exact_old_headers',
    historicalOnly: true,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
  })
  prepared.add(plan)
  return plan
}
function snapshotPlan(plan) {
  check(prepared.has(plan), 'independently_prepared_plan_required')
  return freeze(structuredClone(plan))
}
function header(raw, source) {
  check(
    record(raw) && QUANTITY.test(raw.number) && QUANTITY.test(raw.timestamp) && HASH.test(raw.hash),
    'header_shape',
  )
  if (source)
    check(
      BigInt(raw.number).toString() === source.blockNumber &&
        raw.hash === source.blockHash &&
        BigInt(raw.timestamp) * 1000n === BigInt(Date.parse(source.blockTime)),
      'fixed_old_header',
    )
  return { number: raw.number, hash: raw.hash, timestamp: raw.timestamp }
}
function decodeCall(spec, data) {
  check(typeof data === 'string' && HEX.test(data), 'native_call_hex')
  try {
    const decoded = decodeFunctionResult({
      abi: spec.abi ?? FLUID_BRIDGE_CAPACITY_ABI,
      functionName: spec.functionName,
      data,
    })
    check(
      encodeFunctionResult({
        abi: spec.abi ?? FLUID_BRIDGE_CAPACITY_ABI,
        functionName: spec.functionName,
        result: decoded,
      }).toLowerCase() === data,
      'canonical_call_roundtrip',
    )
    return { status: 'canonical_abi_observation', value: decoded }
  } catch {
    return { status: 'unknown_historical_abi', value: null }
  }
}
function qualifiedRevert(error) {
  return (
    keys(error, ['code', 'message', 'data']) &&
    [3, -32000].includes(error.code) &&
    typeof error.data === 'string' &&
    HEX.test(error.data) &&
    error.data.length <= 4098 &&
    ['execution reverted', 'execution reverted.', 'execution reverted: ' + error.data].includes(
      error.message,
    )
  )
}
function validateResponse(spec, response, id, source) {
  check(record(response) && response.jsonrpc === '2.0' && response.id === id, 'rpc_identity')
  if (Object.hasOwn(response, 'error')) {
    check(
      spec.method === 'eth_call' &&
        keys(response, ['jsonrpc', 'id', 'error']) &&
        qualifiedRevert(response.error),
      'qualified_revert_required',
    )
    return { status: 'getter_reverted', value: null }
  }
  check(keys(response, ['jsonrpc', 'id', 'result']), 'rpc_response_keys')
  if (spec.method === 'eth_getBlockByNumber') {
    check(same(response.result, header(response.result, source)), 'retained_header')
    return { status: 'canonical_header', value: response.result }
  }
  check(typeof response.result === 'string' && HEX.test(response.result), 'native_hex')
  if (spec.method === 'eth_getCode') {
    check(response.result.length <= 49154, 'deployed_code_bound')
    return { status: 'native_code', value: response.result }
  }
  if (spec.method === 'eth_getStorageAt') {
    check(/^0x[0-9a-f]{64}$/.test(response.result), 'native_storage_word')
    return { status: 'native_storage', value: response.result }
  }
  return decodeCall(spec, response.result)
}
function callSpec(key, to, functionName, args, pin) {
  return {
    key,
    method: 'eth_call',
    functionName,
    params: [
      { to, data: encodeFunctionData({ abi: FLUID_BRIDGE_CAPACITY_ABI, functionName, args }) },
      pin,
    ],
  }
}
function* wrapperReadPlan(plan, anchor) {
  const source = anchor.source,
    tag = '0x' + BigInt(source.blockNumber).toString(16)
  const pin = { blockHash: source.blockHash, requireCanonical: true }
  const head = { method: 'eth_getBlockByNumber', params: [tag, false] }
  yield { key: 'header_before', ...head }
  yield { key: 'bridge_proxy_code', method: 'eth_getCode', params: [plan.subject.destination, pin] }
  const slot = yield {
    key: 'implementation_slot',
    method: 'eth_getStorageAt',
    params: [plan.subject.destination, SLOT, tag],
  }
  const implementation =
    slot?.value && /^0x0{24}[0-9a-f]{40}$/.test(slot.value) ? '0x' + slot.value.slice(26) : null
  if (implementation)
    yield { key: 'implementation_code', method: 'eth_getCode', params: [implementation, pin] }
  const fusdc = yield callSpec('get_fusdc', plan.subject.destination, 'getFUSDC', [], pin)
  const token =
    fusdc?.status === 'canonical_abi_observation' &&
    ADDRESS.test(fusdc.value.toLowerCase()) &&
    fusdc.value.toLowerCase() !== ZERO
      ? fusdc.value.toLowerCase()
      : null
  if (token) yield { key: 'fusdc_code', method: 'eth_getCode', params: [token, pin] }
  for (const [key, name, args] of [
    ['withdrawal_fee_bps', 'getWithdrawalFeeBPS', []],
    ['withdrawals_paused', 'isWithdrawalsPaused', []],
    ['idle_fusdc_claim', 'getIdleBalance', []],
    ['holder_balance', 'balanceOf', [plan.subject.owner]],
    ['lite_max_withdraw_incomplete', 'maxWithdraw', [plan.subject.owner]],
    ['full_preview_redeem_net_fee', 'previewRedeem', [BigInt(anchor.holderSharesRaw)]],
  ])
    yield callSpec(key, plan.subject.destination, name, args, pin)
  if (token)
    yield callSpec(
      'fusdc_max_withdraw_bridge',
      token,
      'maxWithdraw',
      [plan.subject.destination],
      pin,
    )
  yield { key: 'header_after', ...head }
}
function wrapperFacts(plan, anchor, observations) {
  const at = (key) => observations.find((row) => row.key === key)
  const value = (key) => at(key)?.decoded.value
  const slot = value('implementation_slot')
  const implementation = slot && /^0x0{24}[0-9a-f]{40}$/.test(slot) ? '0x' + slot.slice(26) : null
  const code = value('implementation_code')
  const fusdc = value('get_fusdc')?.toLowerCase()
  const proxyCode = value('bridge_proxy_code'),
    fusdcCode = value('fusdc_code')
  const proxyBound =
    proxyCode &&
    keccak256(proxyCode) === REFERENCE.proxyRuntimeReference.runtimeKeccak256 &&
    sha(proxyCode) === REFERENCE.proxyRuntimeReference.runtimeHexSha256
  const bound =
    proxyBound &&
    implementation === REFERENCE.implementation &&
    code &&
    keccak256(code) === REFERENCE.runtimeKeccak256 &&
    sha(code) === REFERENCE.runtimeHexSha256 &&
    fusdc === FUSDC
  const getterKeys = [
    'withdrawal_fee_bps',
    'withdrawals_paused',
    'idle_fusdc_claim',
    'holder_balance',
    'lite_max_withdraw_incomplete',
    'full_preview_redeem_net_fee',
    'fusdc_max_withdraw_bridge',
  ]
  const gettersBound = getterKeys.every(
    (key) => at(key)?.decoded.status === 'canonical_abi_observation',
  )
  if (bound) {
    check(
      gettersBound &&
        value('holder_balance').toString() === anchor.holderSharesRaw &&
        value('full_preview_redeem_net_fee').toString() === anchor.fullPositionEntitlementRaw &&
        value('withdrawal_fee_bps') < 10000n &&
        value('bridge_proxy_code') !== '0x' &&
        value('fusdc_code') !== '0x',
      'bound_native_facts',
    )
  }
  const raw = (key) =>
    typeof value(key) === 'bigint' ? value(key).toString() : (value(key) ?? null)
  return {
    source: anchor.source,
    implementation,
    proxyCodeKeccak256: proxyCode ? keccak256(proxyCode) : null,
    implementationCodeKeccak256: code ? keccak256(code) : null,
    fusdcCodeKeccak256: fusdcCode ? keccak256(fusdcCode) : null,
    observedFUSDC: fusdc ?? null,
    wrapperSourceBinding:
      bound && gettersBound ? 'reviewed_lite_runtime_bound' : 'unknown_historical_implementation',
    proxySourceEquivalence: proxyBound
      ? 'reviewed_proxy_runtime_bound'
      : 'unknown_historical_proxy',
    feeBpsRaw: raw('withdrawal_fee_bps'),
    withdrawalsPaused: raw('withdrawals_paused'),
    idleFUSDCClaimRaw: raw('idle_fusdc_claim'),
    holderSharesRaw: raw('holder_balance'),
    liteMaxWithdrawIncompleteRaw: raw('lite_max_withdraw_incomplete'),
    fullPreviewRedeemNetFeeRaw: raw('full_preview_redeem_net_fee'),
    fusdcMaxWithdrawBridgeRaw: raw('fusdc_max_withdraw_bridge'),
    abiStatuses: Object.fromEntries(
      getterKeys.map((key) => [key, at(key)?.decoded.status ?? 'not_read']),
    ),
  }
}
function protocolSource(source) {
  return { ...source, blockNumber: Number(source.blockNumber), finalized: true }
}
function verifyProtocol(receipt, plan, anchor, start, available) {
  const source = protocolSource(anchor.source)
  check(
    keys(receipt, [
      'schema',
      'subject',
      'mode',
      'source',
      'capturedAt',
      'startedAt',
      'origins',
      'budget',
      'traces',
      'sourceEvidence',
      'prongs',
      'sha256',
    ]) &&
      keys(receipt.sourceEvidence, [
        'candidateSourceReferences',
        'resolverAbiSha256',
        'runtimeSourceEquivalenceVerified',
      ]),
    'protocol_closed_shape',
  )
  const replay = replayFluidCapacityProngs(receipt, plan.protocolSubject, source)
  check(
    receipt.mode === 'historical_exact_header' &&
      receipt.budget.maxRequests === 28 &&
      receipt.budget.physicalRequestStarts === 28 &&
      receipt.traces.length === 28 &&
      same(receipt.origins, HOSTS) &&
      Date.parse(receipt.startedAt) >= start &&
      Date.parse(receipt.capturedAt) <= available,
    'protocol_stage_binding',
  )
  const prior = new Map()
  for (const trace of receipt.traces) {
    check(
      keys(trace, [
        'host',
        'phase',
        'request',
        'startedAt',
        'completedAt',
        'response',
        'transport',
      ]) &&
        keys(trace.request, ['jsonrpc', 'id', 'method', 'params']) &&
        keys(trace.response, ['jsonrpc', 'id', 'result']) &&
        Date.parse(trace.completedAt) - Date.parse(trace.startedAt) <= 8000 &&
        Date.parse(trace.startedAt) >= (prior.get(trace.host) ?? start),
      'protocol_strict_trace',
    )
    prior.set(trace.host, Date.parse(trace.completedAt))
    if (trace.request.method === 'eth_getBlockByNumber')
      check(
        same(
          trace.response.result,
          header(
            trace.response.result,
            trace.phase.startsWith('header_') ? anchor.source : undefined,
          ),
        ),
        'protocol_header_retention',
      )
    else if (trace.request.method === 'eth_getCode')
      check(
        typeof trace.response.result === 'string' &&
          HEX.test(trace.response.result) &&
          trace.response.result.length > 2 &&
          trace.response.result.length <= 49154,
        'protocol_code',
      )
    else if (trace.request.method === 'eth_call') {
      const entry = FLUID_CAPACITY_ABI.find(
        (e) =>
          e.type === 'function' &&
          encodeFunctionData({
            abi: [e],
            functionName: e.name,
            args:
              e.inputs.length === 0
                ? []
                : e.name === 'balanceOf'
                  ? [BANK]
                  : [FUSDC, plan.subject.asset],
          }).slice(0, 10) === trace.request.params[0].data.slice(0, 10),
      )
      check(
        entry &&
          decodeCall({ abi: FLUID_CAPACITY_ABI, functionName: entry.name }, trace.response.result)
            .status === 'canonical_abi_observation',
        'protocol_native_roundtrip',
      )
    }
  }
  return replay
}

/** Checksums preserve bytes; only fixed inputs, exact requests and runtime binding qualify facts. */
export function replayFluidBridgeCapacityHistory(value, plan) {
  const expected = snapshotPlan(plan),
    v = structuredClone(value)
  const { sha256, ...body } = v
  check(
    keys(v, [
      'schema',
      'plan',
      'planSha256',
      'startedAtUtc',
      'availableAtUtc',
      'physicalStarts',
      'wrapperOrigins',
      'protocolCaptures',
      'historicalOnly',
      'execution',
      'minedPayout',
      'sourceImplementationEquivalence',
      'sha256',
    ]) &&
      v.schema === 'fluid_usdt_bridge_capacity_history_capture_v1' &&
      same(v.plan, expected) &&
      v.planSha256 === sha(JSON.stringify(expected)) &&
      sha256 === sha(JSON.stringify(body)),
    'capture_integrity',
  )
  check(
    v.historicalOnly === true &&
      v.execution === 'unassessed' &&
      v.minedPayout === false &&
      v.sourceImplementationEquivalence === false &&
      utc(v.startedAtUtc) &&
      utc(v.availableAtUtc) &&
      Date.parse(v.startedAtUtc) > Date.parse(expected.priorEvidenceAvailableAtUtc) &&
      Date.parse(v.availableAtUtc) >= Date.parse(v.startedAtUtc) &&
      Buffer.byteLength(JSON.stringify(v)) + 1 <= expected.policy.maxArtifactBytes &&
      Array.isArray(v.wrapperOrigins) &&
      v.wrapperOrigins.length === 2 &&
      same(
        v.wrapperOrigins.map((o) => o.host),
        HOSTS,
      ),
    'capture_shape',
  )
  const ids = new Set()
  const facts = v.wrapperOrigins.map((origin) => {
    check(
      keys(origin, ['host', 'observations']) && origin.observations.length === 2,
      'wrapper_origins',
    )
    let previous = Date.parse(v.startedAtUtc)
    return origin.observations.map((observation, index) => {
      const anchor = expected.anchors[index],
        decoded = []
      check(
        keys(observation, ['source', 'traces']) &&
          same(observation.source, anchor.source) &&
          Array.isArray(observation.traces),
        'wrapper_source',
      )
      const generator = wrapperReadPlan(expected, anchor)
      let step = generator.next()
      for (const trace of observation.traces) {
        const spec = step.value
        check(
          !step.done &&
            keys(trace, ['key', 'request', 'response', 'startedAtUtc', 'completedAtUtc']) &&
            keys(trace.request, ['jsonrpc', 'id', 'method', 'params']) &&
            trace.key === spec.key &&
            trace.request.jsonrpc === '2.0' &&
            Number.isSafeInteger(trace.request.id) &&
            trace.request.id > 0 &&
            trace.request.id <= 56 &&
            !ids.has(trace.request.id) &&
            trace.request.method === spec.method &&
            same(trace.request.params, spec.params) &&
            utc(trace.startedAtUtc) &&
            utc(trace.completedAtUtc) &&
            Date.parse(trace.startedAtUtc) >= previous &&
            Date.parse(trace.completedAtUtc) >= Date.parse(trace.startedAtUtc) &&
            Date.parse(trace.completedAtUtc) - Date.parse(trace.startedAtUtc) <= 8000 &&
            Date.parse(trace.completedAtUtc) <= Date.parse(v.availableAtUtc),
          'wrapper_trace',
        )
        ids.add(trace.request.id)
        previous = Date.parse(trace.completedAtUtc)
        const result = validateResponse(spec, trace.response, trace.request.id, anchor.source)
        decoded.push({ key: trace.key, decoded: result })
        step = generator.next(result)
      }
      check(step.done, 'wrapper_trace_complete')
      return wrapperFacts(expected, anchor, decoded)
    })
  })
  const nativeVector = (origin) =>
    origin.observations.map((observation) =>
      observation.traces.map((trace) => ({
        key: trace.key,
        native: Object.hasOwn(trace.response, 'result')
          ? { result: trace.response.result }
          : { error: trace.response.error },
      })),
    )
  check(
    ids.size <= 56 &&
      [...ids].sort((a, b) => a - b).every((id, index) => id === index + 1) &&
      same(facts[0], facts[1]) &&
      same(nativeVector(v.wrapperOrigins[0]), nativeVector(v.wrapperOrigins[1])),
    'two_origin_wrapper_agreement',
  )
  const qualified = facts[0].every(
    (point) => point.wrapperSourceBinding === 'reviewed_lite_runtime_bound',
  )
  check(
    Array.isArray(v.protocolCaptures) && v.protocolCaptures.length === (qualified ? 2 : 0),
    'conditional_protocol_stage',
  )
  let previous = Math.max(
    ...v.wrapperOrigins.map((o) => Date.parse(o.observations.at(-1).traces.at(-1).completedAtUtc)),
  )
  const protocol = v.protocolCaptures.map((receipt, index) => {
    const result = verifyProtocol(
      receipt,
      expected,
      expected.anchors[index],
      previous,
      Date.parse(v.availableAtUtc),
    )
    check(
      result.origins.every(
        (origin) => origin.identities[0].codeHash === facts[0][index].fusdcCodeKeccak256,
      ),
      'same_anchor_fusdc_runtime_join',
    )
    previous = Date.parse(receipt.capturedAt)
    return result
  })
  check(
    v.physicalStarts ===
      ids.size + v.protocolCaptures.reduce((n, r) => n + r.budget.physicalRequestStarts, 0) &&
      v.physicalStarts <= 112,
    'global_start_count',
  )
  return freeze({
    historicalOnly: true,
    availableAtUtc: v.availableAtUtc,
    physicalStarts: v.physicalStarts,
    points: facts[0].map((point, index) => ({
      ...point,
      underlyingProtocolProngs: protocol[index]?.prongs ?? null,
      underlyingSourceEquivalence:
        protocol[index]?.sourceEquivalence ?? 'not_acquired_unknown_wrapper',
      mechanismQualification: qualified
        ? 'reviewed_wrapper_bound_native_underlying_prongs_source_equivalence_unverified'
        : 'unknown_historical_implementation',
      idleMeaning: 'fUSDC_claim_not_immediate_bank_cash',
      liteMaxWithdrawMeaning: 'incomplete_view_omits_underlying_bank_cash_and_limit',
    })),
    sourceImplementationEquivalence: false,
    execution: 'unassessed',
    minedPayout: false,
    forecastValidated: false,
    globalCapacityRaw: null,
  })
}
function safeOrigins(providers) {
  check(Array.isArray(providers) && providers.length === 2, 'configured_pair')
  const values = providers.map((provider) => {
    const url = new URL(provider.url)
    check(
      url.protocol === 'https:' &&
        HOSTS.includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.hash,
      'configured_origin',
    )
    return { host: url.hostname, url: url.href }
  })
  check(new Set(values.map((o) => o.host)).size === 2, 'distinct_origins')
  return freeze(HOSTS.map((host) => values.find((o) => o.host === host)))
}
async function boundedRpc(url, request, fetchImpl, controllers) {
  const controller = new AbortController()
  controllers.add(controller)
  let timer
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Error('fluid_bridge_capacity_timeout'))
        }, 8000)
      }),
      (async () => {
        const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        })
        check(
          response.ok &&
            response.body &&
            !response.redirected &&
            (!response.url || new URL(response.url).hostname === new URL(url).hostname),
          'rpc_http',
        )
        const reader = response.body.getReader(),
          chunks = []
        let size = 0
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            check(size <= 65536, 'response_bound')
            chunks.push(Buffer.from(next.value))
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        const buffer = Buffer.concat(chunks),
          text = buffer.toString('utf8')
        check(Buffer.from(text, 'utf8').equals(buffer), 'response_utf8')
        const raw = JSON.parse(text)
        check(
          record(raw) &&
            raw.jsonrpc === '2.0' &&
            raw.id === request.id &&
            (keys(raw, ['jsonrpc', 'id', 'result']) || keys(raw, ['jsonrpc', 'id', 'error'])),
          'rpc_envelope',
        )
        if (Object.hasOwn(raw, 'error')) check(qualifiedRevert(raw.error), 'rpc_qualified_error')
        return raw
      })(),
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
    controllers.delete(controller)
  }
}

/** Unknown historical implementations are retained; the dependent protocol stage stays closed. */
export async function captureFluidBridgeCapacityHistory(
  plan,
  providers,
  { fetchImpl = fetch, now = Date.now } = {},
) {
  const p = snapshotPlan(plan),
    origins = safeOrigins(structuredClone(providers)),
    controllers = new Set()
  const startedAtUtc = new Date(now()).toISOString()
  check(
    Date.parse(startedAtUtc) > Date.parse(p.priorEvidenceAvailableAtUtc),
    'new_acquisition_clock',
  )
  let wrapperStarts = 0,
    protocolStarts = 0,
    closed = false
  const inFlight = new Set()
  const launch = async (origin, request) => {
    check(!closed && !inFlight.has(origin.host), 'origin_single_flight')
    inFlight.add(origin.host)
    try {
      return await boundedRpc(origin.url, request, fetchImpl, controllers)
    } finally {
      inFlight.delete(origin.host)
    }
  }
  try {
    const wrapperOrigins = await Promise.all(
      origins
        .map(async (origin) => {
          const observations = []
          for (const anchor of p.anchors) {
            const traces = [],
              decoded = [],
              generator = wrapperReadPlan(p, anchor)
            let step = generator.next()
            while (!step.done) {
              check(!closed && wrapperStarts < 56, 'wrapper_request_bound')
              const spec = step.value
              const request = freeze({
                jsonrpc: '2.0',
                id: ++wrapperStarts,
                method: spec.method,
                params: structuredClone(spec.params),
              })
              const started = now(),
                response = await launch(origin, request),
                completed = now()
              check(!closed && completed >= started && completed - started <= 8000, 'wrapper_clock')
              if (spec.method === 'eth_getBlockByNumber' && Object.hasOwn(response, 'result'))
                response.result = header(response.result, anchor.source)
              const result = validateResponse(spec, response, request.id, anchor.source)
              traces.push({
                key: spec.key,
                request,
                response,
                startedAtUtc: new Date(started).toISOString(),
                completedAtUtc: new Date(completed).toISOString(),
              })
              decoded.push({ key: spec.key, decoded: result })
              step = generator.next(result)
            }
            wrapperFacts(p, anchor, decoded)
            observations.push({ source: anchor.source, traces })
          }
          return { host: origin.host, observations }
        })
        .map((promise) =>
          promise.catch((error) => {
            closed = true
            for (const controller of controllers) controller.abort()
            throw error
          }),
        ),
    )
    const facts = wrapperOrigins.map((origin) =>
      origin.observations.map((observation, i) => {
        const generator = wrapperReadPlan(p, p.anchors[i]),
          decoded = []
        let step = generator.next()
        for (const trace of observation.traces) {
          const result = validateResponse(
            step.value,
            trace.response,
            trace.request.id,
            p.anchors[i].source,
          )
          decoded.push({ key: trace.key, decoded: result })
          step = generator.next(result)
        }
        return wrapperFacts(p, p.anchors[i], decoded)
      }),
    )
    const nativeVector = (origin) =>
      origin.observations.map((observation) =>
        observation.traces.map((trace) => ({
          key: trace.key,
          native: Object.hasOwn(trace.response, 'result')
            ? { result: trace.response.result }
            : { error: trace.response.error },
        })),
      )
    check(
      same(facts[0], facts[1]) &&
        same(nativeVector(wrapperOrigins[0]), nativeVector(wrapperOrigins[1])),
      'two_origin_wrapper_agreement',
    )
    const protocolCaptures = []
    if (facts[0].every((point) => point.wrapperSourceBinding === 'reviewed_lite_runtime_bound')) {
      for (const anchor of p.anchors) {
        let stageStarts = 0
        const fetcher = async (url, options) => {
          const origin = origins.find((o) => o.url === url)
          check(
            origin &&
              !closed &&
              stageStarts < 28 &&
              protocolStarts < 56 &&
              wrapperStarts + protocolStarts < 112 &&
              options.redirect === 'error',
            'protocol_launch_bound',
          )
          const request = JSON.parse(options.body)
          check(
            ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(
              request.method,
            ),
            'protocol_read_only',
          )
          stageStarts += 1
          protocolStarts += 1
          const response = await launch(origin, request)
          if (Object.hasOwn(response, 'result') && request.method === 'eth_getBlockByNumber')
            response.result = header(
              response.result,
              QUANTITY.test(request.params[0]) ? anchor.source : undefined,
            )
          return new Response(JSON.stringify(response), { status: 200 })
        }
        const receipt = await captureFluidCapacityProngs(p.protocolSubject, origins, {
          source: protocolSource(anchor.source),
          fetcher,
          now,
          maxRequests: 28,
          deadlineMs: 60000,
        })
        check(stageStarts === 28, 'protocol_exact_start_count')
        protocolCaptures.push(receipt)
      }
    }
    closed = true
    const body = {
      schema: 'fluid_usdt_bridge_capacity_history_capture_v1',
      plan: p,
      planSha256: sha(JSON.stringify(p)),
      startedAtUtc,
      availableAtUtc: new Date(now()).toISOString(),
      physicalStarts: wrapperStarts + protocolStarts,
      wrapperOrigins,
      protocolCaptures,
      historicalOnly: true,
      execution: 'unassessed',
      minedPayout: false,
      sourceImplementationEquivalence: false,
    }
    const value = freeze({ ...body, sha256: sha(JSON.stringify(body)) })
    replayFluidBridgeCapacityHistory(value, plan)
    return value
  } catch {
    closed = true
    for (const controller of controllers) controller.abort()
    throw Error('fluid_bridge_capacity_capture_failed')
  }
}
export function writeFluidBridgeCapacityHistory(path, value, plan) {
  replayFluidBridgeCapacityHistory(value, plan)
  const text = JSON.stringify(value) + '\n',
    size = Buffer.byteLength(text)
  check(size <= FLUID_BRIDGE_CAPACITY_HISTORY_POLICY.maxArtifactBytes, 'artifact_bound')
  const disk = statfsSync(dirname(resolve(path)), { bigint: true })
  check(
    disk.bavail * disk.bsize - BigInt(size) >=
      BigInt(FLUID_BRIDGE_CAPACITY_HISTORY_POLICY.reserveBytes),
    'post_output_reserve',
  )
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--plan',
      plan = prepareFluidBridgeCapacityHistoryPlan()
    if (mode === '--plan')
      console.log(
        JSON.stringify({
          status: 'prepared_no_rpc',
          plan,
          planSha256: sha(JSON.stringify(plan)),
          maximumPhysicalStarts: 112,
        }),
      )
    else if (mode === '--replay') {
      const file = process.argv.find((arg) => arg.startsWith('--file='))?.slice(7)
      check(typeof file === 'string' && file.length > 0, 'input_file')
      console.log(
        JSON.stringify(
          replayFluidBridgeCapacityHistory(
            JSON.parse(
              readBoundedReceiptFile(file, {
                maxFileBytes: FLUID_BRIDGE_CAPACITY_HISTORY_POLICY.maxArtifactBytes,
                maxTotalBytes: FLUID_BRIDGE_CAPACITY_HISTORY_POLICY.maxArtifactBytes,
                totalBytes: 0,
              }),
            ),
            plan,
          ),
        ),
      )
    } else if (mode === '--capture') {
      const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6)
      check(typeof out === 'string' && out.length > 0, 'output_file')
      const disk = statfsSync(dirname(resolve(out)), { bigint: true })
      check(
        disk.bavail * disk.bsize - BigInt(FLUID_BRIDGE_CAPACITY_HISTORY_POLICY.maxArtifactBytes) >=
          BigInt(FLUID_BRIDGE_CAPACITY_HISTORY_POLICY.reserveBytes),
        'preflight_reserve',
      )
      const { readProviderPolicy, configuredProviders } =
        await import('./carry-depth-quote-archive.mjs')
      const policy = readProviderPolicy()
      check(
        policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
        'provider_policy',
      )
      const value = await captureFluidBridgeCapacityHistory(plan, configuredProviders(null, policy))
      writeFluidBridgeCapacityHistory(out, value, plan)
      console.log(
        JSON.stringify({
          sha256: value.sha256,
          physicalStarts: value.physicalStarts,
          availableAtUtc: value.availableAtUtc,
          artifactBytes: Buffer.byteLength(JSON.stringify(value)) + 1,
        }),
      )
    } else check(false, 'mode')
  } catch {
    console.error('fluid_bridge_capacity_capture_failed')
    process.exitCode = 1
  }
}
