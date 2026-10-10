// Manual historical eth_call quotes for a new fixed final-USDT research target.
// The original issue question was USDC first-leg only; no final-USDT question binding is claimed.
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, writeFileSync, statfsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAbi, encodeFunctionData, decodeFunctionResult, encodeFunctionResult } from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import {
  CONTRACTS,
  HOSTS,
  replayFluidUsdtConversionHistory,
} from './fluid-usdt-historical-conversion-capture.mjs'
import {
  prepareFluidFullPositionHistoryPlan,
  replayFluidFullPositionHistory,
} from './fluid-usdt-full-position-history-capture.mjs'
import {
  prepareFluidWholePositionPathPlan,
  replayFluidWholePositionPath,
} from './fluid-usdt-whole-position-path-capture.mjs'
import {
  prepareFluidBridgeCapacityHistoryPlan,
  replayFluidBridgeCapacityHistory,
} from './fluid-usdt-bridge-capacity-history-capture.mjs'

const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const sha = (v) => createHash('sha256').update(v).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (ok, code) => {
  if (!ok) throw Error('fluid_fixed_output_' + code)
}
const exactKeys = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k))
const utc = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const prepared = new WeakSet()
export const FLUID_FIXED_OUTPUT_HISTORY_POLICY = freeze({
  maxRequests: 12,
  maxInFlightPerHost: 1,
  retries: 0,
  rpcTimeoutMs: 8000,
  maxResponseBytes: 65536,
  maxArtifactBytes: 1536 * 1024,
  reserveBytes: 128 * 1024 * 1024,
})
export const FLUID_FIXED_OUTPUT_ABI_REFERENCE = freeze({
  url: 'https://raw.githubusercontent.com/Uniswap/v3-periphery/main/contracts/interfaces/IQuoterV2.sol',
  path: '/private/tmp/fluid-usdt-fixed-output-review-20261007/IQuoterV2.exa.json',
  bytes: 4790,
  sha256: '0d808579516a20e6cb65573e2d08651b38501c712900986b6084ceda6f77433b',
  format: 'exa_primary_interface_response',
  deployedSourceEquivalence: false,
})
// IQuoterV2 names this uint256 field `amount` (the desired amountOut), unlike exact-input amountIn.
export const FLUID_FIXED_OUTPUT_ABI = freeze(
  parseAbi([
    'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  ]),
)
const ROOT = 'data/research/venue-signals/'
export const FLUID_FIXED_OUTPUT_INPUT_PINS = freeze([
  {
    path: ROOT + 'carry-fluid-bridge-usdt-holder-v1/issues/00000001.json',
    bytes: 7022,
    fileSha256: 'ed9879f7bd271fac0b39fc140bf87839dc04995374ea97e034f022952fa71356',
    bodySha256: '388c7a3c3ea53d4c343249bc813ae659053f895afdf9738f3e1c29f7c002ad14',
  },
  {
    path: ROOT + 'carry-fluid-bridge-usdt-holder-v1/issues/00000002.json',
    bytes: 7083,
    fileSha256: 'e7cb0e58d3849202387856279b774e5026349e5f46f8fecbffe55bdbbeb64dbc',
    bodySha256: 'db3db5ff1af80bb1d29bb122e75dab810e134e76e07855cd31a48687c8304e16',
  },
  {
    path: ROOT + 'fluid-usdt-historical-conversion-2026-10-07T14-14.json',
    bytes: 714020,
    fileSha256: '071b8036b38110ea382264e70d30d88dc242fb94e297777add40912814282b41',
    bodySha256: '6c3078bab4cffe3000dfedfb3e38f91c1cb293840cb6628a81f7689ed2fb1584',
  },
  {
    path: ROOT + 'fluid-usdt-full-position-history-2026-10-07T19-10.json',
    bytes: 13976,
    fileSha256: '6a1526fdcb4ee3d85ccaa5a6d72e4d23ec32d5cffb73c36cec909ac35160ee52',
    bodySha256: 'f66d39903d7352e6c839efcbc8ef5ce59d0e0289a61483b3bb98fc594c4e1ecb',
  },
  {
    path: ROOT + 'fluid-usdt-whole-position-path-2026-10-07T19-44.json',
    bytes: 20935,
    fileSha256: 'ae7d24e26a5303b638bfdc23f961333ded0c2521f5c4da7af1e394c3138bcb6b',
    bodySha256: '3e734bb58d1e9c2fe1267e4358d9405bc63801bfa34fe3e88a1aab9c022b0eff',
  },
  {
    path: ROOT + 'fluid-usdt-bridge-capacity-history-2026-10-07T20-30.json',
    bytes: 666979,
    fileSha256: 'bb5c04193d08e833542ca638a5a73944ff740758120faff1fe88238ae181d11b',
    bodySha256: 'ded702880804cbf6dddfa886af5dd7a12df28a89d999c4d9c0d693d0fdb0e5dc',
  },
])
export const FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE = freeze({
  fixedFinalUsdtOutputRaw: '10145',
  researchTargetSelection:
    'new_research_selected_numeric_reuse_of_original_first_leg_usdc_request_not_conversion',
  originalFirstLegUsdcRequestedRaw: '10145',
  originalFirstLegRequestAssetUnit: 'USDC',
  originalFinalUsdtRequestedRaw: null,
  originalPayoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
  questionBinding: 'unassessed',
})
export const FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN = freeze({
  path: 'data/research/venue-signals/fluid-usdt-fixed-output-history-2026-10-07T21-35.json',
  bytes: 297606,
  fileSha256: 'f4cd88b1586f5ddc6a7488ca25c756427c92e4cd4ad2ad21bde4a5c1b2989dd8',
  bodySha256: '686aaa1d380e89b74764d85f8e9c2cef4acccdb55981ee376f57613dff36f8a2',
})
function readPinned(root, pin) {
  const text = readBoundedReceiptFile(resolve(root, pin.path), {
    maxFileBytes: pin.bytes,
    maxTotalBytes: pin.bytes,
    totalBytes: 0,
  })
  check(Buffer.byteLength(text) === pin.bytes && sha(text) === pin.fileSha256, 'input_file_pin')
  const value = JSON.parse(text),
    { sha256, ...body } = value
  check(sha256 === pin.bodySha256 && sha(JSON.stringify(body)) === pin.bodySha256, 'input_body_pin')
  return value
}
export function prepareFluidFixedOutputHistoryPlan({ root = process.cwd() } = {}) {
  const ref = readBoundedReceiptFile(FLUID_FIXED_OUTPUT_ABI_REFERENCE.path, {
    maxFileBytes: 4790,
    maxTotalBytes: 4790,
    totalBytes: 0,
  })
  check(
    sha(ref) === FLUID_FIXED_OUTPUT_ABI_REFERENCE.sha256 && Buffer.byteLength(ref) === 4790,
    'official_abi_reference',
  )
  const inputs = FLUID_FIXED_OUTPUT_INPUT_PINS.map((p) => readPinned(root, p))
  const original = prepareFluidFullPositionHistoryPlan({ root })
  const full = replayFluidFullPositionHistory(inputs[3], original)
  const wholePlan = prepareFluidWholePositionPathPlan({ root })
  const whole = replayFluidWholePositionPath(inputs[4], wholePlan)
  const native = replayFluidBridgeCapacityHistory(
    inputs[5],
    prepareFluidBridgeCapacityHistoryPlan({ root }),
  )
  const conversion = replayFluidUsdtConversionHistory(inputs[2], inputs[2].plan)
  const anchors = original.anchors.map((anchor, i) => {
    const quote = conversion.history.points[i]
    check(
      [full.points[i], whole.points[i], native.points[i], quote].every((p) =>
        same(p.source, anchor.source),
      ),
      'original_source_join',
    )
    check(
      inputs[i].baseline.cases.some(
        (c) =>
          c.qRaw === '10145' &&
          c.measurement.request.assetsRaw === '10145' &&
          c.measurement.request.assetUnit === 'USDC' &&
          c.measurement.routeLeg.usdcToUsdtConversion === 'unassessed' &&
          c.measurement.routeLeg.usdtReceipt === 'unassessed',
      ) &&
        inputs[i].payoutAssessment === 'usdc_first_leg_only_usdt_unassessed' &&
        quote.identityVerified &&
        quote.pool === '0x3416cf6c708da44db2624d63ea0aaef7113527c6',
      'q_identity_join',
    )
    check(native.points[i].holderSharesRaw === anchor.originalHolderSharesRaw, 'holder_join')
    return {
      ...anchor,
      ...FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE,
      nativeFullPositionEntitlementRaw: whole.points[i].fullPositionEntitlementRaw,
      reusedQuoteIdentity: { pool: quote.pool, runtimeCodeHashes: quote.runtimeCodeHashes },
      nativeCapacityBodySha256: inputs[5].sha256,
    }
  })
  const plan = freeze({
    schema: 'fluid_usdt_fixed_output_history_plan_v2',
    subject: original.subject,
    ...FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE,
    input: { asset: CONTRACTS.usdc, decimals: 6 },
    output: { asset: CONTRACTS.usdt, decimals: 6 },
    quoter: CONTRACTS.quoter,
    fee: 100,
    sqrtPriceLimitX96: '0',
    anchors,
    originHosts: HOSTS,
    inputPins: FLUID_FIXED_OUTPUT_INPUT_PINS,
    abiReference: FLUID_FIXED_OUTPUT_ABI_REFERENCE,
    policy: FLUID_FIXED_OUTPUT_HISTORY_POLICY,
    physicalStarts: 12,
    priorEvidenceAvailableAtUtc: native.availableAtUtc,
    historicalOnly: true,
    sourceImplementationEquivalence: false,
    execution: 'unassessed',
    minedPayout: false,
    forecastValidated: false,
  })
  prepared.add(plan)
  return plan
}
function trusted(plan) {
  check(prepared.has(plan), 'unprepared_plan')
  return plan
}
export function fluidFixedOutputHistoryRequests(plan, index) {
  trusted(plan)
  const source = plan.anchors[index]?.source
  check(source, 'source_index')
  const tag = '0x' + BigInt(source.blockNumber).toString(16)
  const data = encodeFunctionData({
    abi: FLUID_FIXED_OUTPUT_ABI,
    functionName: 'quoteExactOutputSingle',
    args: [
      {
        tokenIn: plan.input.asset,
        tokenOut: plan.output.asset,
        amount: 10145n,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  return freeze([
    { key: 'header_before', method: 'eth_getBlockByNumber', params: [tag, false] },
    {
      key: 'quote_exact_output',
      method: 'eth_call',
      params: [
        { to: plan.quoter, data },
        { blockHash: source.blockHash, requireCanonical: true },
      ],
    },
    { key: 'header_after', method: 'eth_getBlockByNumber', params: [tag, false] },
  ])
}
function validHeader(raw, source) {
  check(
    raw &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(raw.number) &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(raw.timestamp),
    'header_quantity',
  )
  check(
    BigInt(raw.number).toString() === source.blockNumber &&
      raw.hash === source.blockHash &&
      new Date(Number(BigInt(raw.timestamp)) * 1000).toISOString() === source.blockTime,
    'source_header',
  )
}
function validResult(spec, response, id, source) {
  check(
    exactKeys(response, ['jsonrpc', 'id', 'result']) &&
      response.jsonrpc === '2.0' &&
      response.id === id,
    'rpc_envelope',
  )
  if (spec.method === 'eth_getBlockByNumber') {
    validHeader(response.result, source)
    return null
  }
  check(
    typeof response.result === 'string' && /^0x[0-9a-f]{256}$/.test(response.result),
    'quote_encoding',
  )
  const result = decodeFunctionResult({
    abi: FLUID_FIXED_OUTPUT_ABI,
    functionName: 'quoteExactOutputSingle',
    data: response.result,
  })
  check(
    encodeFunctionResult({
      abi: FLUID_FIXED_OUTPUT_ABI,
      functionName: 'quoteExactOutputSingle',
      result,
    }) === response.result &&
      result[0] > 0n &&
      result[1] > 0n,
    'canonical_quote',
  )
  return {
    requiredUsdcRaw: result[0].toString(),
    sqrtPriceX96After: result[1].toString(),
    initializedTicksCrossed: result[2].toString(),
    gasEstimate: result[3].toString(),
  }
}
const conservative = {
  historicalOnly: true,
  sourceImplementationEquivalence: false,
  execution: 'unassessed',
  minedPayout: false,
  forecastValidated: false,
}
function replayCheckedFixedOutputCapture(value, plan, legacy = false) {
  trusted(plan)
  const expectedPlan = legacy ? legacyPlanFromCorrected(plan) : plan
  const v = structuredClone(value),
    { sha256, ...body } = v
  check(
    exactKeys(v, [
      'schema',
      'plan',
      'planSha256',
      'startedAtUtc',
      'availableAtUtc',
      'physicalStarts',
      'traces',
      'historicalOnly',
      'sourceImplementationEquivalence',
      'execution',
      'minedPayout',
      'forecastValidated',
      'sha256',
    ]) &&
      sha(JSON.stringify(body)) === sha256 &&
      same(v.plan, expectedPlan) &&
      v.planSha256 === sha(JSON.stringify(expectedPlan)),
    'capture_integrity',
  )
  check(
    v.schema ===
      (legacy
        ? 'fluid_usdt_fixed_output_history_capture_v1'
        : 'fluid_usdt_fixed_output_history_capture_v2') &&
      Object.keys(conservative).every((k) => v[k] === conservative[k]),
    'qualification',
  )
  check(
    utc(v.startedAtUtc) &&
      utc(v.availableAtUtc) &&
      Date.parse(v.availableAtUtc) >= Date.parse(v.startedAtUtc) &&
      Date.parse(v.startedAtUtc) >= Date.parse(plan.priorEvidenceAvailableAtUtc) &&
      v.physicalStarts === 12 &&
      v.traces.length === 12,
    'capture_bounds',
  )
  check(
    Buffer.byteLength(JSON.stringify(v)) + 1 <= FLUID_FIXED_OUTPUT_HISTORY_POLICY.maxArtifactBytes,
    'artifact_bound',
  )
  const points = plan.anchors.map((a) => ({
    source: a.source,
    ...FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE,
    inputAsset: CONTRACTS.usdc,
    inputDecimals: 6,
    outputAsset: CONTRACTS.usdt,
    outputDecimals: 6,
    owner: plan.subject.owner,
    holderSharesRaw: a.originalHolderSharesRaw,
    nativeFullPositionEntitlementRaw: a.nativeFullPositionEntitlementRaw,
    reusedQuoteIdentity: a.reusedQuoteIdentity,
    originQuotes: [],
  }))
  let previous = null
  for (let i = 0; i < 12; i++) {
    const t = v.traces[i],
      oi = Math.floor(i / 6),
      ai = Math.floor((i % 6) / 3),
      si = i % 3,
      spec = fluidFixedOutputHistoryRequests(plan, ai)[si],
      source = plan.anchors[ai].source
    check(
      exactKeys(t, [
        'origin',
        'anchor',
        'key',
        'request',
        'response',
        'responseText',
        'responseBytes',
        'responseSha256',
        'startedAtUtc',
        'completedAtUtc',
        'startedMonotonicMs',
        'completedMonotonicMs',
        'workSettled',
      ]) &&
        t.origin === HOSTS[oi] &&
        t.anchor === ai &&
        t.key === spec.key &&
        same(t.request, { jsonrpc: '2.0', id: i + 1, method: spec.method, params: spec.params }),
      'trace_request',
    )
    check(
      utc(t.startedAtUtc) &&
        utc(t.completedAtUtc) &&
        Date.parse(t.startedAtUtc) >= Date.parse(v.startedAtUtc) &&
        Date.parse(t.completedAtUtc) <= Date.parse(v.availableAtUtc) &&
        Date.parse(t.completedAtUtc) >= Date.parse(t.startedAtUtc) &&
        Date.parse(t.completedAtUtc) - Date.parse(t.startedAtUtc) <= 8000,
      'trace_clock',
    )
    check(
      Number.isFinite(t.startedMonotonicMs) &&
        Number.isFinite(t.completedMonotonicMs) &&
        t.startedMonotonicMs >= 0 &&
        t.completedMonotonicMs >= t.startedMonotonicMs &&
        t.completedMonotonicMs - t.startedMonotonicMs <= 8000 &&
        t.workSettled === true,
      'monotonic_clock',
    )
    if (previous)
      check(
        Date.parse(t.startedAtUtc) >= Date.parse(previous.completedAtUtc) &&
          t.startedMonotonicMs >= previous.completedMonotonicMs,
        'nonoverlap',
      )
    check(
      typeof t.responseText === 'string' &&
        !/https?:\/\//i.test(t.responseText) &&
        !/https?:\/\//i.test(JSON.stringify(t.response)) &&
        Buffer.byteLength(t.responseText) === t.responseBytes &&
        t.responseBytes <= 65536 &&
        sha(t.responseText) === t.responseSha256 &&
        same(JSON.parse(t.responseText), t.response),
      'raw_response_bound',
    )
    const quote = validResult(spec, t.response, i + 1, source)
    if (quote) points[ai].originQuotes.push({ origin: t.origin, ...quote })
    previous = t
  }
  for (const point of points) {
    const [a, b] = point.originQuotes
    const { origin: originA, ...quoteA } = a,
      { origin: originB, ...quoteB } = b
    check(originA === HOSTS[0] && originB === HOSTS[1], 'origin_pair')
    point.requiredUsdcRaw = same(quoteA, quoteB) ? a.requiredUsdcRaw : null
    point.status = point.requiredUsdcRaw
      ? 'conditional_exact_output_quote'
      : 'unknown_origin_disagreement'
    point.nativeUnitsComparedOnly = point.requiredUsdcRaw !== null
  }
  return freeze({
    status: 'replayed_fixed_final_usdt_research_target',
    ...FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE,
    availableAtUtc: v.availableAtUtc,
    physicalStarts: 12,
    points,
    ...conservative,
  })
}
// Reconstruct the exact obsolete envelope only for checking the externally pinned raw artifact.
// Its incorrect question label is never promoted into the corrected return view.
function legacyPlanFromCorrected(plan) {
  const translate = (value) => {
    const result = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'fixedFinalUsdtOutputRaw') result.originalUsdtRequestedRaw = entry
      else if (Object.hasOwn(FLUID_FIXED_OUTPUT_QUESTION_PROVENANCE, key)) continue
      else if (key === 'schema') result.schema = 'fluid_usdt_fixed_output_history_plan_v1'
      else if (key === 'anchors') result.anchors = entry.map(translate)
      else result[key] = entry
    }
    return result
  }
  return translate(plan)
}
export function replayFluidFixedOutputHistory(value, plan) {
  return replayCheckedFixedOutputCapture(value, plan)
}
/** Import only the immutable actual v1 bytes; this is an offline provenance correction, not a recapture. */
export function replayPinnedLegacyFluidFixedOutputHistory(text, plan) {
  trusted(plan)
  const pin = FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN
  check(
    typeof text === 'string' &&
      Buffer.byteLength(text) === pin.bytes &&
      sha(text) === pin.fileSha256,
    'legacy_file_pin',
  )
  const value = JSON.parse(text)
  check(value.sha256 === pin.bodySha256, 'legacy_body_pin')
  const corrected = replayCheckedFixedOutputCapture(value, plan, true)
  return freeze({
    ...corrected,
    legacyCapture: pin,
    provenanceCorrection: {
      status: 'corrected_legacy_question_unit_label',
      originalIssueQuestion: 'USDC_first_leg_only',
      finalUsdtTarget: 'new_research_selected_target_numeric_reuse_not_conversion',
      originalFinalUsdtRequestedRaw: null,
      questionBinding: 'unassessed',
      rawArtifactImmutable: true,
    },
  })
}
export function importPinnedLegacyFluidFixedOutputHistory(plan, { root = process.cwd() } = {}) {
  const pin = FLUID_FIXED_OUTPUT_LEGACY_CAPTURE_PIN
  const text = readBoundedReceiptFile(resolve(root, pin.path), {
    maxFileBytes: pin.bytes,
    maxTotalBytes: pin.bytes,
    totalBytes: 0,
  })
  return replayPinnedLegacyFluidFixedOutputHistory(text, plan)
}
function safeOrigins(providers) {
  check(Array.isArray(providers) && providers.length === 2, 'configured_pair')
  const origins = providers.map((p) => {
    let u
    try {
      u = new URL(p.url)
    } catch {
      check(false, 'configured_origin')
    }
    check(
      u.protocol === 'https:' &&
        HOSTS.includes(u.hostname) &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.port,
      'configured_origin',
    )
    return { host: u.hostname, url: u.href }
  })
  check(new Set(origins.map((o) => o.host)).size === 2, 'distinct_origins')
  return HOSTS.map((h) => origins.find((o) => o.host === h))
}
async function rpc(url, request, fetchImpl) {
  const controller = new AbortController()
  let timer
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Error('fluid_fixed_output_timeout'))
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
          void reader.cancel().catch(() => {})
        }
        const buffer = Buffer.concat(chunks),
          text = buffer.toString('utf8')
        check(Buffer.from(text).equals(buffer), 'response_utf8')
        const parsedResponse = JSON.parse(text)
        check(
          !/https?:\/\//i.test(text) && !/https?:\/\//i.test(JSON.stringify(parsedResponse)),
          'response_privacy',
        )
        return {
          response: parsedResponse,
          responseText: text,
          responseBytes: size,
          responseSha256: sha(text),
        }
      })(),
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
export async function captureFluidFixedOutputHistory(
  plan,
  providers,
  {
    fetchImpl = fetch,
    now = () => new Date().toISOString(),
    monotonic = () => performance.now(),
  } = {},
) {
  trusted(plan)
  const origins = safeOrigins(providers),
    startedAtUtc = now(),
    base = monotonic(),
    traces = []
  check(utc(startedAtUtc), 'start_clock')
  for (const origin of origins)
    for (let ai = 0; ai < 2; ai++)
      for (const spec of fluidFixedOutputHistoryRequests(plan, ai)) {
        check(traces.length < 12, 'physical_start_cap')
        const request = {
            jsonrpc: '2.0',
            id: traces.length + 1,
            method: spec.method,
            params: spec.params,
          },
          start = now(),
          sm = monotonic() - base
        let raw
        try {
          raw = await rpc(origin.url, request, fetchImpl)
        } catch {
          throw Error('fluid_fixed_output_rpc_stopped')
        }
        const end = now(),
          em = monotonic() - base
        // Invalid headers and unknown quotes stop all dependent calls, with no retry or saved partial proof.
        validResult(spec, raw.response, request.id, plan.anchors[ai].source)
        traces.push({
          origin: origin.host,
          anchor: ai,
          key: spec.key,
          request,
          ...raw,
          startedAtUtc: start,
          completedAtUtc: end,
          startedMonotonicMs: sm,
          completedMonotonicMs: em,
          workSettled: true,
        })
      }
  const body = {
      schema: 'fluid_usdt_fixed_output_history_capture_v2',
      plan,
      planSha256: sha(JSON.stringify(plan)),
      startedAtUtc,
      availableAtUtc: now(),
      physicalStarts: traces.length,
      traces,
      ...conservative,
    },
    value = { ...body, sha256: sha(JSON.stringify(body)) }
  replayFluidFixedOutputHistory(value, plan)
  return freeze(value)
}
function reserve(path, size) {
  const disk = statfsSync(dirname(resolve(path)), { bigint: true })
  check(
    disk.bavail * disk.bsize - BigInt(size) >=
      BigInt(FLUID_FIXED_OUTPUT_HISTORY_POLICY.reserveBytes),
    'post_output_reserve',
  )
}
export function writeFluidFixedOutputHistory(path, value, plan) {
  replayFluidFixedOutputHistory(value, plan)
  const text = JSON.stringify(value) + '\n'
  check(
    Buffer.byteLength(text) <= FLUID_FIXED_OUTPUT_HISTORY_POLICY.maxArtifactBytes,
    'artifact_bound',
  )
  reserve(path, Buffer.byteLength(text))
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
      plan = prepareFluidFixedOutputHistoryPlan()
    if (mode === '--plan')
      console.log(
        JSON.stringify({
          status: 'prepared_no_rpc',
          plan,
          planSha256: sha(JSON.stringify(plan)),
          requests: plan.anchors.map((_, i) => fluidFixedOutputHistoryRequests(plan, i)),
          physicalStarts: 0,
          expectedStarts: 12,
        }),
      )
    else if (mode === '--replay') {
      const path = process.argv[3]
      check(typeof path === 'string', 'replay_path')
      console.log(
        JSON.stringify(
          replayFluidFixedOutputHistory(
            JSON.parse(
              readBoundedReceiptFile(path, {
                maxFileBytes: 1536 * 1024,
                maxTotalBytes: 1536 * 1024,
                totalBytes: 0,
              }),
            ),
            plan,
          ),
        ),
      )
    } else if (mode === '--replay-legacy') {
      console.log(JSON.stringify(importPinnedLegacyFluidFixedOutputHistory(plan)))
    } else if (mode === '--capture') {
      const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6)
      check(out, 'output_file')
      reserve(out, 1536 * 1024)
      const { readProviderPolicy, configuredProviders } =
        await import('./carry-depth-quote-archive.mjs')
      const policy = readProviderPolicy()
      check(
        policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
        'provider_policy',
      )
      const value = await captureFluidFixedOutputHistory(plan, configuredProviders(null, policy))
      writeFluidFixedOutputHistory(out, value, plan)
      console.log(
        JSON.stringify({
          sha256: value.sha256,
          physicalStarts: value.physicalStarts,
          artifactBytes: Buffer.byteLength(JSON.stringify(value)) + 1,
        }),
      )
    } else check(false, 'mode')
  } catch {
    console.error('fluid_fixed_output_capture_failed')
    process.exitCode = 1
  }
}
