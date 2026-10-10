// Manual historical eth_call simulations and exact-size quotes; no transaction is sent.
import { createHash } from 'node:crypto'
import { openSync, closeSync, writeFileSync, statfsSync, constants } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionData,
  encodeFunctionResult,
  decodeFunctionResult,
} from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import {
  ABI as QUOTE_ABI,
  CONTRACTS,
  HOSTS,
  replayFluidUsdtConversionHistory,
} from './fluid-usdt-historical-conversion-capture.mjs'
import {
  prepareFluidFullPositionHistoryPlan,
  replayFluidFullPositionHistory,
} from './fluid-usdt-full-position-history-capture.mjs'

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const check = (ok, code) => {
  if (!ok) throw Error('fluid_whole_position_' + code)
}
const sha = (text) => createHash('sha256').update(text).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected) =>
  record(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key))
const utc = (value) =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
const HEX = /^0x(?:[0-9a-f]{2})*$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const approvedPlans = new WeakSet()
const WITHDRAW_ABI = freeze(
  parseAbi([
    'function withdraw(uint256 assets,address receiver,address owner) returns(uint256 shares)',
    'function redeem(uint256 shares,address receiver,address owner) returns(uint256 assets)',
  ]),
)
const INPUTS = freeze([
  {
    path: 'data/research/venue-signals/fluid-usdt-full-position-history-2026-10-07T19-10.json',
    bytes: 13976,
    fileSha256: '6a1526fdcb4ee3d85ccaa5a6d72e4d23ec32d5cffb73c36cec909ac35160ee52',
    bodySha256: 'f66d39903d7352e6c839efcbc8ef5ce59d0e0289a61483b3bb98fc594c4e1ecb',
  },
  {
    path: 'data/research/venue-signals/fluid-usdt-historical-conversion-2026-10-07T14-14.json',
    bytes: 714020,
    fileSha256: '071b8036b38110ea382264e70d30d88dc242fb94e297777add40912814282b41',
    bodySha256: '6c3078bab4cffe3000dfedfb3e38f91c1cb293840cb6628a81f7689ed2fb1584',
  },
])
export const FLUID_WHOLE_POSITION_PATH_POLICY = freeze({
  maxRequests: 24,
  maxInFlightPerHost: 1,
  rpcTimeoutMs: 8000,
  retries: 0,
  maxResponseBytes: 65536,
  maxArtifactBytes: 65536,
  reserveBytes: 128 * 1024 * 1024,
})
function pinned(root, spec) {
  const text = readBoundedReceiptFile(resolve(root, spec.path), {
    maxFileBytes: spec.bytes,
    maxTotalBytes: spec.bytes,
    totalBytes: 0,
  })
  check(
    Buffer.byteLength(text) === spec.bytes && sha(text) === spec.fileSha256,
    'external_file_pin',
  )
  const value = JSON.parse(text)
  const { sha256, ...body } = value
  check(
    sha256 === spec.bodySha256 && sha(JSON.stringify(body)) === spec.bodySha256,
    'external_body_pin',
  )
  return value
}
function checkedPlan(plan) {
  check(approvedPlans.has(plan), 'independently_prepared_plan_required')
  return freeze(structuredClone(plan))
}

/** Replays fixed saved raw evidence before deriving any new calldata; no RPC is launched. */
export function prepareFluidWholePositionPathPlan({ root = process.cwd() } = {}) {
  const fullPlan = prepareFluidFullPositionHistoryPlan({ root })
  const fullRaw = pinned(root, INPUTS[0])
  const conversionRaw = pinned(root, INPUTS[1])
  const full = replayFluidFullPositionHistory(fullRaw, fullPlan)
  const conversion = replayFluidUsdtConversionHistory(conversionRaw, conversionRaw.plan)
  check(
    full.points.length === 2 &&
      conversion.history.points.length === 2 &&
      conversion.owner === fullPlan.subject.owner &&
      conversion.input.asset === fullPlan.subject.asset &&
      conversion.input.decimals === 6 &&
      conversion.output.asset === CONTRACTS.usdt &&
      conversion.output.decimals === 6,
    'independent_identity',
  )
  const anchors = full.points.map((point, index) => {
    check(
      same(point.source, conversion.history.points[index].source) &&
        conversion.history.points[index].identityVerified &&
        conversion.history.points[index].status === 'conditional_quote' &&
        point.owner === fullPlan.subject.owner &&
        point.asset === CONTRACTS.usdc &&
        point.assetDecimals === 6,
      'historical_source_join',
    )
    const templates = HOSTS.map((host) => {
      const traceIndex = conversionRaw.traces.findIndex(
        (trace) =>
          trace.origin === host &&
          trace.key === 'usdtQuotedRaw' &&
          same(trace.request?.params?.[1], {
            blockHash: point.source.blockHash,
            requireCanonical: true,
          }),
      )
      const trace = conversionRaw.traces[traceIndex]
      check(
        trace?.request?.method === 'eth_call' &&
          keys(trace.request.params[0], ['to', 'data']) &&
          trace.request.params[0].to === CONTRACTS.quoter &&
          trace.response?.result,
        'saved_quote_template',
      )
      const decoded = decodeFunctionData({ abi: QUOTE_ABI, data: trace.request.params[0].data })
      check(
        decoded.functionName === 'quoteExactInputSingle' &&
          decoded.args.length === 1 &&
          decoded.args[0].amountIn === 10145n &&
          decoded.args[0].tokenIn.toLowerCase() === CONTRACTS.usdc &&
          decoded.args[0].tokenOut.toLowerCase() === CONTRACTS.usdt &&
          decoded.args[0].fee === 100 &&
          decoded.args[0].sqrtPriceLimitX96 === 0n &&
          encodeFunctionData({
            abi: QUOTE_ABI,
            functionName: decoded.functionName,
            args: decoded.args,
          }) === trace.request.params[0].data,
        'native_template_roundtrip',
      )
      return {
        host,
        traceIndex,
        template: trace.request.params[0],
        wholePositionCall: {
          ...trace.request.params[0],
          data: encodeFunctionData({
            abi: QUOTE_ABI,
            functionName: decoded.functionName,
            args: [{ ...decoded.args[0], amountIn: BigInt(point.fullPositionEntitlementRaw) }],
          }),
        },
      }
    })
    check(
      same(templates[0].template, templates[1].template) &&
        same(templates[0].wholePositionCall, templates[1].wholePositionCall),
      'two_origin_template_agreement',
    )
    return {
      source: point.source,
      holderSharesRaw: point.holderSharesRaw,
      fullPositionEntitlementRaw: point.fullPositionEntitlementRaw,
      smallWithdrawalInputRaw: '10145',
      quoteCall: templates[0].wholePositionCall,
      originalQuoteInputRaw: '10145',
      quoteTemplateEvidence: templates.map(({ host, traceIndex }) => ({ host, traceIndex })),
    }
  })
  const plan = freeze({
    schema: 'fluid_usdt_whole_position_path_plan_v1',
    subject: fullPlan.subject,
    inputEvidence: INPUTS,
    originalIssueAnchors: fullPlan.anchors,
    priorEvidenceAvailableAtUtc: full.availableAtUtc,
    originHosts: [...HOSTS],
    anchors,
    policy: FLUID_WHOLE_POSITION_PATH_POLICY,
    historicalOnly: true,
    headerRetention: 'native_number_hash_timestamp_only',
    newlyObservedFinalizedHead: false,
    simulationState: 'independent_eth_call_no_state_override',
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
  })
  approvedPlans.add(plan)
  return plan
}
function readPlan(plan, anchor) {
  const pin = { blockHash: anchor.source.blockHash, requireCanonical: true }
  const header = {
    method: 'eth_getBlockByNumber',
    params: ['0x' + BigInt(anchor.source.blockNumber).toString(16), false],
  }
  const withdraw = (key, amountRaw) => ({
    key,
    method: 'eth_call',
    params: [
      {
        to: plan.subject.destination,
        from: plan.subject.owner,
        data: encodeFunctionData({
          abi: WITHDRAW_ABI,
          functionName: 'withdraw',
          args: [BigInt(amountRaw), plan.subject.owner, plan.subject.owner],
        }),
      },
      pin,
    ],
  })
  return freeze([
    { key: 'header_before', ...header },
    withdraw('withdraw_exact_small', anchor.smallWithdrawalInputRaw),
    withdraw('withdraw_full_position', anchor.fullPositionEntitlementRaw),
    {
      key: 'redeem_full_position',
      method: 'eth_call',
      params: [
        {
          to: plan.subject.destination,
          from: plan.subject.owner,
          data: encodeFunctionData({
            abi: WITHDRAW_ABI,
            functionName: 'redeem',
            args: [BigInt(anchor.holderSharesRaw), plan.subject.owner, plan.subject.owner],
          }),
        },
        pin,
      ],
    },
    { key: 'quote_exact_full_position', method: 'eth_call', params: [anchor.quoteCall, pin] },
    { key: 'header_after', ...header },
  ])
}
export function fluidWholePositionPathReadPlan(plan, anchorIndex) {
  const privatePlan = checkedPlan(plan)
  check(Number.isInteger(anchorIndex) && anchorIndex >= 0 && anchorIndex < 2, 'anchor_index')
  return readPlan(privatePlan, privatePlan.anchors[anchorIndex])
}
function header(raw, source) {
  check(
    record(raw) &&
      QUANTITY.test(raw.number) &&
      QUANTITY.test(raw.timestamp) &&
      raw.number === '0x' + BigInt(source.blockNumber).toString(16) &&
      raw.hash === source.blockHash &&
      BigInt(raw.timestamp) * 1000n === BigInt(Date.parse(source.blockTime)),
    'canonical_source_header',
  )
  return { number: raw.number, hash: raw.hash, timestamp: raw.timestamp }
}
function canonicalResult(key, result) {
  check(typeof result === 'string' && HEX.test(result), 'native_result_hex')
  const quote = key === 'quote_exact_full_position'
  const abi = quote ? QUOTE_ABI : WITHDRAW_ABI
  const redeem = key === 'redeem_full_position'
  const functionName = quote ? 'quoteExactInputSingle' : redeem ? 'redeem' : 'withdraw'
  const decoded = decodeFunctionResult({ abi, functionName, data: result })
  check(
    encodeFunctionResult({ abi, functionName, result: decoded }) === result,
    'native_result_roundtrip',
  )
  if (!quote && !redeem) check(decoded > 0n, 'positive_shares_burned')
  return quote
    ? {
        quotedUsdtOutRaw: decoded[0].toString(),
        sqrtPriceX96AfterRaw: decoded[1].toString(),
        initializedTicksCrossed: decoded[2],
        gasEstimateRaw: decoded[3].toString(),
      }
    : redeem
      ? { returnedAssetsRaw: decoded.toString() }
      : { sharesBurnedRaw: decoded.toString() }
}
function isEvmRevert(error) {
  return (
    record(error) &&
    [3, -32000].includes(error.code) &&
    typeof error.data === 'string' &&
    HEX.test(error.data) &&
    error.data.length <= 4098 &&
    (error.message === 'execution reverted' ||
      error.message === 'execution reverted.' ||
      error.message === 'execution reverted: ' + error.data)
  )
}
function validateResponse(spec, response, requestId, source) {
  check(
    record(response) && response.jsonrpc === '2.0' && response.id === requestId,
    'rpc_response_identity',
  )
  if (Object.hasOwn(response, 'error')) {
    check(
      !spec.key.startsWith('header_') &&
        keys(response, ['jsonrpc', 'id', 'error']) &&
        keys(response.error, ['code', 'message', 'data']) &&
        isEvmRevert(response.error),
      'qualified_evm_revert_required',
    )
    return { status: 'evm_revert', revertData: response.error.data }
  }
  check(keys(response, ['jsonrpc', 'id', 'result']), 'rpc_response_shape')
  if (spec.key.startsWith('header_')) {
    check(
      keys(response.result, ['number', 'hash', 'timestamp']) &&
        same(header(response.result, source), response.result),
      'retained_header',
    )
    return { status: 'success' }
  }
  return { status: 'success', ...canonicalResult(spec.key, response.result) }
}

/** Decoding is historical simulation evidence, never payment or current/forecast approval. */
export function replayFluidWholePositionPath(value, expectedPlan) {
  const plan = checkedPlan(expectedPlan)
  const candidate = structuredClone(value)
  const { sha256, ...body } = candidate
  check(
    keys(candidate, [
      'schema',
      'plan',
      'planSha256',
      'startedAtUtc',
      'availableAtUtc',
      'physicalStarts',
      'origins',
      'historicalOnly',
      'execution',
      'minedPayout',
      'sourceImplementationEquivalence',
      'sha256',
    ]) &&
      candidate.schema === 'fluid_usdt_whole_position_path_capture_v1' &&
      same(candidate.plan, plan) &&
      candidate.planSha256 === sha(JSON.stringify(plan)) &&
      sha256 === sha(JSON.stringify(body)) &&
      candidate.historicalOnly === true &&
      candidate.execution === 'unassessed' &&
      candidate.minedPayout === false &&
      candidate.sourceImplementationEquivalence === false &&
      candidate.physicalStarts === 24 &&
      Buffer.byteLength(JSON.stringify(candidate)) + 1 <= 65536 &&
      !/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(JSON.stringify(candidate)) &&
      utc(candidate.startedAtUtc) &&
      utc(candidate.availableAtUtc) &&
      Date.parse(candidate.startedAtUtc) > Date.parse(plan.priorEvidenceAvailableAtUtc) &&
      Date.parse(candidate.availableAtUtc) >= Date.parse(candidate.startedAtUtc) &&
      Array.isArray(candidate.origins) &&
      candidate.origins.length === 2 &&
      same(
        candidate.origins.map((origin) => origin.host),
        plan.originHosts,
      ),
    'capture_integrity',
  )
  const ids = new Set()
  const origins = candidate.origins.map((origin) => {
    check(
      keys(origin, ['host', 'observations']) &&
        Array.isArray(origin.observations) &&
        origin.observations.length === 2,
      'origin_shape',
    )
    let prior = Date.parse(candidate.startedAtUtc)
    return origin.observations.map((observation, index) => {
      const anchor = plan.anchors[index]
      const specs = readPlan(plan, anchor)
      check(
        keys(observation, ['source', 'traces']) &&
          same(observation.source, anchor.source) &&
          Array.isArray(observation.traces) &&
          observation.traces.length === 6,
        'source_enclosure',
      )
      const outcomes = observation.traces.map((trace, step) => {
        const spec = specs[step]
        check(
          keys(trace, ['key', 'request', 'response', 'startedAtUtc', 'completedAtUtc']) &&
            trace.key === spec.key &&
            keys(trace.request, ['jsonrpc', 'id', 'method', 'params']) &&
            trace.request.jsonrpc === '2.0' &&
            Number.isSafeInteger(trace.request.id) &&
            trace.request.id >= 1 &&
            trace.request.id <= 24 &&
            !ids.has(trace.request.id) &&
            trace.request.method === spec.method &&
            same(trace.request.params, spec.params) &&
            utc(trace.startedAtUtc) &&
            utc(trace.completedAtUtc) &&
            Date.parse(trace.startedAtUtc) >= prior &&
            Date.parse(trace.completedAtUtc) >= Date.parse(trace.startedAtUtc) &&
            Date.parse(trace.completedAtUtc) - Date.parse(trace.startedAtUtc) <= 8000 &&
            Date.parse(trace.completedAtUtc) <= Date.parse(candidate.availableAtUtc),
          'ordered_native_trace',
        )
        ids.add(trace.request.id)
        prior = Date.parse(trace.completedAtUtc)
        const outcome = validateResponse(spec, trace.response, trace.request.id, anchor.source)
        if (step === 1 || step === 2) {
          check(
            outcome.status !== 'success' ||
              BigInt(outcome.sharesBurnedRaw) <= BigInt(anchor.holderSharesRaw),
            'holder_share_bound',
          )
        }
        return outcome
      })
      return {
        source: anchor.source,
        small: outcomes[1],
        whole: outcomes[2],
        redeem: outcomes[3],
        quote: outcomes[4],
      }
    })
  })
  check(ids.size === 24, 'twenty_four_distinct_calls')
  const points = plan.anchors.map((anchor, index) => {
    const pair = (key) => {
      const a = origins[0][index][key],
        b = origins[1][index][key]
      if (!same(a, b)) return { status: 'two_origin_disagreement', twoOriginAgreement: false }
      return {
        ...a,
        status: a.status === 'success' ? 'two_origin_simulation_success' : 'two_origin_evm_revert',
        twoOriginAgreement: true,
      }
    }
    const quote = pair('quote')
    const redeem = pair('redeem')
    const redemptionMatches =
      redeem.status === 'two_origin_simulation_success'
        ? redeem.returnedAssetsRaw === anchor.fullPositionEntitlementRaw
        : null
    return {
      source: anchor.source,
      owner: plan.subject.owner,
      holderSharesRaw: anchor.holderSharesRaw,
      fullPositionEntitlementRaw: anchor.fullPositionEntitlementRaw,
      nativeAsset: plan.subject.asset,
      nativeAssetDecimals: 6,
      exactSmallWithdrawal: { inputRaw: '10145', ...pair('small') },
      wholePositionWithdrawal: { inputRaw: anchor.fullPositionEntitlementRaw, ...pair('whole') },
      wholePositionRedemption: {
        inputSharesRaw: anchor.holderSharesRaw,
        ...redeem,
        entitlementMatchesPinnedFullPosition: redemptionMatches,
        status:
          redemptionMatches === false
            ? 'returned_assets_do_not_match_pinned_entitlement'
            : redeem.status,
      },
      wholePositionConversion: {
        inputRaw: anchor.fullPositionEntitlementRaw,
        ...quote,
        status:
          quote.status === 'two_origin_simulation_success'
            ? 'conditional_exact_size_quote'
            : quote.status,
        outputAsset: CONTRACTS.usdt,
        outputDecimals: 6,
        feeUnits: 100,
        feeDenominator: 1000000,
      },
      nativeRecipientDelivery: 'unassessed_simulation_only',
      finalSwapExecution: 'unassessed',
      minedUsdtPayment: 'unassessed',
    }
  })
  return freeze({
    historicalOnly: true,
    availableAtUtc: candidate.availableAtUtc,
    points,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
  })
}
function safeOrigins(providers) {
  check(Array.isArray(providers) && providers.length === 2, 'configured_pair')
  const values = providers.map((provider) => {
    const url = new URL(provider.url)
    check(
      url.protocol === 'https:' && !url.username && !url.password && HOSTS.includes(url.hostname),
      'approved_https_origin',
    )
    return { host: url.hostname, url: url.href }
  })
  check(new Set(values.map((value) => value.host)).size === 2, 'distinct_origins')
  return freeze(HOSTS.map((host) => values.find((value) => value.host === host)))
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
          reject(Error('fluid_whole_position_rpc_timeout'))
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
        check(response.ok && response.body, 'rpc_http')
        const reader = response.body.getReader(),
          chunks = []
        let size = 0
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            check(size <= 65536, 'rpc_response_bound')
            chunks.push(Buffer.from(next.value))
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        check(
          record(raw) &&
            raw.jsonrpc === '2.0' &&
            raw.id === request.id &&
            Object.hasOwn(raw, 'result') !== Object.hasOwn(raw, 'error'),
          'rpc_envelope',
        )
        if (Object.hasOwn(raw, 'error')) {
          check(isEvmRevert(raw.error), 'rpc_error_not_qualified_revert')
          return {
            jsonrpc: raw.jsonrpc,
            id: raw.id,
            error: { code: raw.error.code, message: raw.error.message, data: raw.error.data },
          }
        }
        return { jsonrpc: raw.jsonrpc, id: raw.id, result: raw.result }
      })(),
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
    controllers.delete(controller)
  }
}

/** Explicit finite manual capture. Transport failures abort all launches; no incomplete proof is sealed. */
export async function captureFluidWholePositionPath(
  plan,
  providers,
  { fetchImpl = fetch, now = () => Date.now() } = {},
) {
  const privatePlan = checkedPlan(plan)
  const origins = safeOrigins(structuredClone(providers))
  const startedAtUtc = new Date(now()).toISOString()
  check(
    Date.parse(startedAtUtc) > Date.parse(privatePlan.priorEvidenceAvailableAtUtc),
    'new_acquisition_clock',
  )
  const controllers = new Set()
  let physicalStarts = 0,
    closed = false
  try {
    const captured = await Promise.all(
      origins.map(async (origin) => {
        const observations = []
        for (const anchor of privatePlan.anchors) {
          const traces = []
          for (const spec of readPlan(privatePlan, anchor)) {
            check(!closed && physicalStarts < 24, 'physical_start_bound')
            const request = freeze({
              jsonrpc: '2.0',
              id: ++physicalStarts,
              method: spec.method,
              params: structuredClone(spec.params),
            })
            const started = now()
            const response = await boundedRpc(origin.url, request, fetchImpl, controllers)
            const completed = now()
            check(!closed && completed >= started && completed - started <= 8000, 'read_clock')
            if (spec.key.startsWith('header_') && Object.hasOwn(response, 'result'))
              response.result = header(response.result, anchor.source)
            validateResponse(spec, response, request.id, anchor.source)
            traces.push({
              key: spec.key,
              request,
              response,
              startedAtUtc: new Date(started).toISOString(),
              completedAtUtc: new Date(completed).toISOString(),
            })
          }
          observations.push({ source: anchor.source, traces })
        }
        return { host: origin.host, observations }
      }),
    )
    closed = true
    const body = {
      schema: 'fluid_usdt_whole_position_path_capture_v1',
      plan: privatePlan,
      planSha256: sha(JSON.stringify(privatePlan)),
      startedAtUtc,
      availableAtUtc: new Date(now()).toISOString(),
      physicalStarts,
      origins: captured,
      historicalOnly: true,
      execution: 'unassessed',
      minedPayout: false,
      sourceImplementationEquivalence: false,
    }
    const value = freeze({ ...body, sha256: sha(JSON.stringify(body)) })
    replayFluidWholePositionPath(value, plan)
    return value
  } catch {
    closed = true
    for (const controller of controllers) controller.abort()
    throw Error('fluid_whole_position_capture_failed')
  }
}
export function writeFluidWholePositionPath(path, value, plan) {
  replayFluidWholePositionPath(value, plan)
  const text = JSON.stringify(value) + '\n'
  check(Buffer.byteLength(text) <= 65536, 'artifact_bound')
  const disk = statfsSync(dirname(resolve(path)), { bigint: true })
  check(
    disk.bavail * disk.bsize - BigInt(Buffer.byteLength(text)) >=
      BigInt(FLUID_WHOLE_POSITION_PATH_POLICY.reserveBytes),
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
    const mode = process.argv[2] ?? '--plan'
    const plan = prepareFluidWholePositionPathPlan()
    if (mode === '--plan')
      console.log(
        JSON.stringify({
          status: 'prepared_no_rpc',
          plan,
          planSha256: sha(JSON.stringify(plan)),
          maximumPhysicalStarts: 24,
        }),
      )
    else if (mode === '--replay') {
      const file = process.argv.find((arg) => arg.startsWith('--file='))?.slice(7)
      check(typeof file === 'string' && file.length > 0, 'input_file')
      const raw = readBoundedReceiptFile(file, {
        maxFileBytes: 65536,
        maxTotalBytes: 65536,
        totalBytes: 0,
      })
      console.log(JSON.stringify(replayFluidWholePositionPath(JSON.parse(raw), plan)))
    } else if (mode === '--capture') {
      const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6)
      check(typeof out === 'string' && out.length > 0, 'output_file')
      const disk = statfsSync(dirname(resolve(out)), { bigint: true })
      check(
        disk.bavail * disk.bsize - 65536n >= BigInt(FLUID_WHOLE_POSITION_PATH_POLICY.reserveBytes),
        'preflight_reserve',
      )
      const { readProviderPolicy, configuredProviders } =
        await import('./carry-depth-quote-archive.mjs')
      const policy = readProviderPolicy()
      check(
        policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
        'provider_policy',
      )
      const value = await captureFluidWholePositionPath(plan, configuredProviders(null, policy))
      writeFluidWholePositionPath(out, value, plan)
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
    console.error('fluid_whole_position_capture_failed')
    process.exitCode = 1
  }
}
