// App-owned, manual native getters only. Importing launches no reads, jobs or providers.
import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { encodeFunctionData, decodeFunctionResult, encodeFunctionResult, keccak256 } from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import * as cashModule from './conditional-cash-time-holdout.mjs'
import * as capacityModule from './carry-fluid-capacity-prongs.mjs'
import * as bridgeModule from './fluid-usdt-bridge-capacity-history-capture.mjs'
const pick = (m, k) => m[k] ?? m.default?.[k]
const authenticateArtifacts = pick(cashModule, 'authenticateArtifacts')
const captureProtocol = pick(capacityModule, 'captureFluidCapacityProngs')
const replayProtocol = pick(capacityModule, 'replayFluidCapacityProngs')
const protocolAbi = pick(capacityModule, 'FLUID_CAPACITY_ABI')
const wrapperAbi = pick(bridgeModule, 'FLUID_BRIDGE_CAPACITY_ABI')
const oldPrepare = pick(bridgeModule, 'prepareFluidBridgeCapacityHistoryPlan')
const oldReplay = pick(bridgeModule, 'replayFluidBridgeCapacityHistory')
const sha = (v) => createHash('sha256').update(v).digest('hex')
const check = (ok, code) => {
  if (!ok) throw Error('fluid_usdc_hypothetical_' + code)
}
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const prepared = new WeakSet()
const configuredPairs = new WeakSet()
const originalCaptures = new WeakMap()
const nativeFetch = globalThis.fetch
const offlinePins = Object.freeze([
  {
    body: 'f39e070e3d031d3ae1e2f872ca9293f942e79a5d3441350f3d9959a475677bc5',
    plan: '50002549ac061fb8c268be34c597c56fdb3b4791f71c086828116adbe54be328',
  },
  {
    body: 'e071af5cfcae89c5eef4c0d7e7d44f04a2e3edb365ff638320d9b241e2a292cf',
    plan: '7679e574c97a9cbcd2cd9dc41a08e89fcabc9b30e995ef84d5f00e228a430879',
  },
])
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const BRIDGE = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const FUSDC = '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'
const IMPL = '0xe16ccc91a8134d428e7b6240177f9e2b227b9743'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const SHARES = '967573479322309282'
const HEX = /^0x(?:[0-9a-f]{2})*$/
const HASH = /^0x[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]{0,77})$/
const MAX = (1n << 256n) - 1n
const keys = (v, list) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === list.length &&
  list.every((k) => Object.hasOwn(v, k))
const dense = (v, n) =>
  Array.isArray(v) &&
  v.length === n &&
  Object.keys(v).length === n &&
  Array.from({ length: n }, (_, j) => Object.hasOwn(v, j)).every(Boolean)
const utc = (v) =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const nativePin = freeze({
  path: 'data/research/venue-signals/fluid-usdt-bridge-capacity-history-2026-10-07T20-30.json',
  bytes: 666979,
  sha256: 'bb5c04193d08e833542ca638a5a73944ff740758120faff1fe88238ae181d11b',
  bodySha256: 'ded702880804cbf6dddfa886af5dd7a12df28a89d999c4d9c0d693d0fdb0e5dc',
})
export const FLUID_USDC_HYPOTHETICAL_POLICY = freeze({
  maxRequests: 208,
  requestsPerAnchor: 52,
  wrapperPerOrigin: 12,
  protocolPerOrigin: 14,
  deadlineMs: 120000,
  originWindowMs: 12000,
  rpcTimeoutMs: 8000,
  pacingMs: 250,
  cleanupGraceMs: 250,
  maxResponseBytes: 65536,
  maxArtifactBytes: 8 * 1024 * 1024,
  reserveBytes: 256 * 1024 * 1024,
  retries: 0,
})

/** Uses the existing active policy; credentials remain confined to the returned in-memory origins. */
export async function configuredFluidBridgeUsdcHypotheticalOrigins() {
  const m = await import('./carry-depth-quote-archive.mjs')
  const policy = pick(m, 'readProviderPolicy')()
  check(policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1', 'provider_policy')
  const pool = pick(m, 'configuredProviders')(null, policy)
  const origins = HOSTS.map((host) => pool.find((o) => o.host === host))
  check(origins.every(Boolean) && pool.length === 2, 'configured_origins')
  const pair = freeze(origins.map((o) => ({ ...o })))
  configuredPairs.add(pair)
  return pair
}

function validatedAnchorSelection(options) {
  try {
    check(
      options &&
        Object.getPrototypeOf(options) === Object.prototype &&
        Object.getOwnPropertySymbols(options).length === 0 &&
        Object.getOwnPropertyNames(options).every((k) =>
          ['root', 'cashIndices', 'sharesRaw'].includes(k),
        ),
      'selection_options',
    )
    const descriptors = Object.getOwnPropertyDescriptors(options)
    check(
      Object.values(descriptors).every((d) => Object.hasOwn(d, 'value')),
      'selection_accessors',
    )
    const root = descriptors.root?.value === undefined ? process.cwd() : descriptors.root.value
    check(typeof root === 'string' && root.length > 0, 'selection_root')
    const supplied = descriptors.cashIndices ? descriptors.cashIndices.value : [115, 116, 117, 118]
    check(
      Array.isArray(supplied) &&
        Object.getPrototypeOf(supplied) === Array.prototype &&
        Object.getOwnPropertySymbols(supplied).length === 0 &&
        supplied.length === 4 &&
        Object.getOwnPropertyNames(supplied).length === 5,
      'selection_dense_array',
    )
    const indices = [0, 1, 2, 3].map((n) => {
      const d = Object.getOwnPropertyDescriptor(supplied, String(n))
      check(
        d &&
          Object.hasOwn(d, 'value') &&
          Number.isSafeInteger(d.value) &&
          d.value >= 0 &&
          d.value < 120,
        'selection_index',
      )
      return d.value
    })
    check(
      indices.every((v, n) => n === 0 || v === indices[n - 1] + 1),
      'selection_consecutive',
    )
    const sharesRaw =
      descriptors.sharesRaw?.value === undefined ? SHARES : descriptors.sharesRaw.value
    check(
      typeof sharesRaw === 'string' &&
        UINT.test(sharesRaw) &&
        BigInt(sharesRaw) > 0n &&
        BigInt(sharesRaw) <= MAX,
      'selection_shares',
    )
    return { root, indices, sharesRaw }
  } catch {
    throw Error('fluid_usdc_hypothetical_anchor_selection_invalid')
  }
}

/** Offline authentication uses the existing cash authenticator and retained native replay realm. */
export function prepareFluidBridgeUsdcHypotheticalHistoryPlan(options = {}) {
  const { root, indices, sharesRaw } = validatedAnchorSelection(options)
  const budget = { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024, totalBytes: 0 }
  const read = (path) => readBoundedReceiptFile(resolve(root, path), budget)
  const audit = authenticateArtifacts(
    read('data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json'),
    read('data/research/venue-signals/conditional-sampled-cash-history-v1.pins.json'),
  )
  const matches = Object.values(audit.histories).filter(
    (h) =>
      h.identity.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]' &&
      h.identity.destination === BRIDGE &&
      h.identity.asset === USDC &&
      h.identity.assetDecimals === 6,
  )
  check(matches.length === 1, 'cash_identity')
  const anchors = indices.map((index) => {
    const rows = matches[0].points.filter((p) => p[0] === index)
    check(rows.length === 1, 'cash_anchor')
    const p = rows[0]
    return {
      source: {
        chainId: 1,
        blockNumber: Number(p[1]),
        blockHash: p[2],
        blockTime: p[3],
        finalized: true,
      },
      cashIndex: index,
      authenticatedBridgeCashRaw: p[4],
    }
  })
  check(
    anchors.every(
      (a, n) =>
        Number.isSafeInteger(a.source.blockNumber) &&
        a.source.blockNumber > 0 &&
        HASH.test(a.source.blockHash) &&
        utc(a.source.blockTime) &&
        Date.parse(a.source.blockTime) % 1000 === 0 &&
        (n === 0 ||
          (a.source.blockNumber > anchors[n - 1].source.blockNumber &&
            Date.parse(a.source.blockTime) > Date.parse(anchors[n - 1].source.blockTime) &&
            a.source.blockHash !== anchors[n - 1].source.blockHash)),
    ),
    'cash_chronology',
  )
  if (isDeepStrictEqual(indices, [115, 116, 117, 118]))
    check(
      isDeepStrictEqual(
        anchors.map((a) => a.source.blockNumber),
        [26079396, 26086569, 26093737, 26100913],
      ),
      'cash_grid',
    )
  const rawText = read(nativePin.path)
  check(
    Buffer.byteLength(rawText) === nativePin.bytes && sha(rawText) === nativePin.sha256,
    'retained_file_pin',
  )
  const retained = JSON.parse(rawText),
    { sha256, ...body } = retained
  check(
    sha256 === nativePin.bodySha256 && sha(JSON.stringify(body)) === sha256,
    'retained_body_pin',
  )
  const oldPlan = oldPrepare({ root })
  oldReplay(retained, oldPlan)
  const subject = {
    routeKey: 'USDC → Fluid USD Coin [USDC]',
    destination: FUSDC,
    asset: USDC,
    assetDecimals: 6,
  }
  const identities = retained.protocolCaptures.map((r) =>
    replayProtocol(r, subject, r.source).origins.map((o) => o.identities),
  )
  check(
    identities.length > 0 && identities.flat().every((v) => isDeepStrictEqual(v, identities[0][0])),
    'retained_runtime_join',
  )
  const plan = freeze({
    schema: 'fluid_bridge_usdc_hypothetical_history_plan_v1',
    subject: {
      routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
      destination: BRIDGE,
      asset: USDC,
      assetDecimals: 6,
      sharesRaw,
      shareDecimals: 18,
      positionKind: 'hypothetical_fixed_shares_not_owner',
    },
    protocolSubject: subject,
    anchors,
    originHosts: HOSTS,
    policy: FLUID_USDC_HYPOTHETICAL_POLICY,
    implementationSlot: SLOT,
    runtimePins: {
      implementation: IMPL,
      implementationKeccak256: '0x2156d45a268d405a90e3b7ae68fb2a5e8635b2e767da5307f90883118cad06ef',
      proxyKeccak256: '0xe271f71213f15998e1d3d3a5bec2ae0ca9d0e217a9b4467b3aa0d3b386e2394b',
      underlyingIdentities: identities[0][0],
    },
    retainedNativeProvenance: {
      input: nativePin,
      schema: retained.schema,
      availableAtUtc: retained.availableAtUtc,
      originalSubject: retained.plan.subject,
      originalIssueAnchors: retained.plan.originalIssueAnchors,
    },
    cashWitness: matches[0].witness,
    originalTransportRetagged: false,
    execution: 'unassessed',
    owner: null,
  })
  prepared.add(plan)
  return plan
}
const ensurePlan = (p) =>
  check(prepared.has(p) && Object.isFrozen(p), 'private_prepared_plan_required')

/** Dedicated whole-batch lifecycle. The physical ledger is appended BEFORE fetch starts. */
export function createFluidUsdcHypotheticalCaptureControl(
  origins,
  {
    fetcher = fetch,
    now = Date.now,
    monotonic = () => performance.now(),
    pace = (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  check(
    dense(origins, 2) &&
      new Set(origins.map((o) => o.host)).size === 2 &&
      origins.every((o) => {
        try {
          const u = new URL(o.url)
          return (
            HOSTS.includes(o.host) &&
            u.hostname === o.host &&
            u.protocol === 'https:' &&
            !u.username &&
            !u.password
          )
        } catch {
          return false
        }
      }),
    'origins',
  )
  const start = monotonic(),
    startedAtUtc = new Date(now()).toISOString(),
    deadline = start + 120000
  const ledger = [],
    settlementReceipts = [],
    lastStart = new Map(),
    windows = new Map(),
    controllers = new Set(),
    pending = new Set(),
    scheduled = new Set()
  let closed = false,
    failure = null,
    stage = 'unset',
    totalBytes = 0
  const remaining = () => deadline - monotonic()
  const beginStage = (name) => {
    check(!closed && pending.size === 0 && scheduled.size === 0, 'stage_pending')
    stage = name
    windows.clear()
  }
  const stop = (code) => {
    failure ??= code
    closed = true
    for (const c of controllers) c.abort()
  }
  const timer = setTimer(() => stop('global_deadline'), 120000)
  const physicalFetch = async (url, options) => {
    const o = origins.find((o) => o.url === url)
    check(o && !closed && !options.signal?.aborted, 'closed_or_origin_or_aborted')
    const entered = monotonic()
    if (!windows.has(o.host)) windows.set(o.host, entered + 12000)
    while (true) {
      const clock = monotonic(),
        limit = Math.min(deadline, windows.get(o.host))
      if (closed || clock >= limit || ledger.length >= 208) {
        stop('start_budget')
        throw Error('fluid_usdc_hypothetical_start_budget')
      }
      if (options.signal?.aborted) {
        stop('upstream_aborted')
        throw Error('fluid_usdc_hypothetical_upstream_aborted')
      }
      const wait = (lastStart.get(o.host) ?? -Infinity) + 250 - clock
      if (wait <= 0) break
      await pace(Math.ceil(wait))
      // Early wakeups must recheck the monotonic spacing; a stalled injected clock cannot spin.
      check(monotonic() > clock, 'pacing_clock_unavailable')
    }
    const at = monotonic(),
      limit = Math.min(deadline, windows.get(o.host))
    if (closed || at >= limit || ledger.length >= 208) {
      stop('start_budget')
      throw Error('fluid_usdc_hypothetical_start_budget')
    }
    if (options.signal?.aborted) {
      stop('upstream_aborted')
      throw Error('fluid_usdc_hypothetical_upstream_aborted')
    }
    const request = JSON.parse(options.body)
    check(
      keys(request, ['jsonrpc', 'id', 'method', 'params']) &&
        request.jsonrpc === '2.0' &&
        Number.isSafeInteger(request.id) &&
        [
          'eth_chainId',
          'eth_getBlockByNumber',
          'eth_getCode',
          'eth_getStorageAt',
          'eth_call',
        ].includes(request.method),
      'request',
    )
    const controller = new AbortController(),
      id = ledger.length + 1
    const row = {
      physicalId: id,
      host: o.host,
      stage,
      request,
      startedAtUtc: new Date(now()).toISOString(),
      startedElapsedMs: at - start,
      completedAtUtc: null,
      completedElapsedMs: null,
      status: 'pending',
      httpStatus: null,
      bodyBytes: null,
      bodySha256: null,
      rawBodyBase64: null,
      safeCode: null,
      accepted: false,
    }
    ledger.push(row)
    lastStart.set(o.host, at)
    controllers.add(controller)
    const timeout = Math.min(8000, limit - at)
    let expired = false,
      timeoutTimer
    const abort = () => {
      stop('upstream_aborted')
      controller.abort()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const operation = (async () => {
      try {
        const response = await fetcher(url, { ...options, signal: controller.signal })
        row.httpStatus = Number.isInteger(response.status) ? response.status : null
        const reader = response.body?.getReader()
        check(reader, 'stream_required')
        const chunks = [],
          bodyHash = createHash('sha256')
        let length = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.byteLength
            bodyHash.update(value)
            row.bodyBytes = length
            row.bodySha256 = bodyHash.copy().digest('hex')
            check(length <= 65536, 'response_cap')
            chunks.push(Buffer.from(value))
          }
        } finally {
          reader.releaseLock()
        }
        const bytes = Buffer.concat(chunks),
          text = bytes.toString('utf8')
        row.bodyBytes = bytes.length
        row.bodySha256 = sha(bytes)
        totalBytes += bytes.length
        check(totalBytes <= 5 * 1024 * 1024, 'ledger_cap')
        const envelope = JSON.parse(text)
        check(
          response.ok &&
            !response.redirected &&
            (!response.url || new URL(response.url).hostname === o.host) &&
            keys(envelope, ['jsonrpc', 'id', 'result']) &&
            envelope.jsonrpc === '2.0' &&
            envelope.id === request.id,
          'provider_response',
        )
        row.rawBodyBase64 = bytes.toString('base64')
        row.completedAtUtc = new Date(now()).toISOString()
        row.completedElapsedMs = monotonic() - start
        row.accepted =
          !expired &&
          !closed &&
          !options.signal?.aborted &&
          monotonic() < limit &&
          monotonic() - at <= timeout
        row.status = row.accepted ? 'success' : 'late_success'
        row.safeCode = row.accepted ? null : 'late_settlement'
        if (!row.accepted) throw Error('late_settlement')
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } })
      } catch {
        row.completedAtUtc ??= new Date(now()).toISOString()
        row.completedElapsedMs ??= monotonic() - start
        if (row.status !== 'late_success') {
          row.status = 'failed'
          row.rawBodyBase64 = null
          row.safeCode = expired ? 'read_timeout' : 'provider_unavailable'
        }
        row.accepted = false
        stop(row.safeCode)
        throw Error('fluid_usdc_hypothetical_provider_unavailable')
      } finally {
        controllers.delete(controller)
        options.signal?.removeEventListener('abort', abort)
        // Separate append-only, individually sealed evidence; never mutates a sealed capture.
        settlementReceipts.push(
          freeze(
            seal({
              schema: 'fluid_usdc_hypothetical_physical_settlement_v1',
              physicalId: row.physicalId,
              captureAcceptance: false,
              observation: structuredClone(row),
            }),
          ),
        )
      }
    })()
    pending.add(operation)
    operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    )
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timeoutTimer = setTimer(
            () => {
              expired = true
              controller.abort()
              stop('read_timeout')
              reject(Error('fluid_usdc_hypothetical_read_timeout'))
            },
            Math.max(1, timeout),
          )
        }),
      ])
    } finally {
      clearTimer(timeoutTimer)
    }
  }
  const trackedFetch = (url, options) => {
    // Register before calling the async wrapper, including every awaited pacing interval.
    const entry = { promise: null }
    scheduled.add(entry)
    entry.promise = physicalFetch(url, options)
    entry.promise.then(
      () => scheduled.delete(entry),
      () => scheduled.delete(entry),
    )
    return entry.promise
  }
  const finish = async () => {
    closed = true
    clearTimer(timer)
    for (const c of controllers) c.abort()
    const waiting = [...pending, ...Array.from(scheduled, (entry) => entry.promise)]
    if (waiting.length) {
      let grace
      await Promise.race([
        Promise.allSettled(waiting),
        new Promise((r) => {
          grace = setTimer(r, 250)
        }),
      ])
      clearTimer(grace)
    }
    const result = {
      startedAtUtc,
      availableAtUtc: new Date(now()).toISOString(),
      elapsedMs: monotonic() - start,
      physicalStarts: ledger.length,
      pendingSettlements: pending.size + scheduled.size,
      failure,
      ledger: structuredClone(ledger),
    }
    return result
  }
  return { fetcher: trackedFetch, beginStage, finish, stop, remaining, settlementReceipts }
}

function header(result, source) {
  check(
    result &&
      result.number === '0x' + source.blockNumber.toString(16) &&
      result.hash === source.blockHash &&
      result.timestamp === '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
    'header',
  )
  return { number: result.number, hash: result.hash, timestamp: result.timestamp }
}
const call = (to, name, args, source, abi = wrapperAbi) => ({
  method: 'eth_call',
  params: [
    { to, data: encodeFunctionData({ abi, functionName: name, args }) },
    { blockHash: source.blockHash, requireCanonical: true },
  ],
})
export function fluidUsdcHypotheticalWrapperRequests(plan, source) {
  ensurePlan(plan)
  const pin = { blockHash: source.blockHash, requireCanonical: true },
    head = {
      method: 'eth_getBlockByNumber',
      params: ['0x' + source.blockNumber.toString(16), false],
    }
  return [
    { key: 'header_before', ...head },
    { key: 'bridge_code', method: 'eth_getCode', params: [BRIDGE, pin] },
    { key: 'implementation_slot', method: 'eth_getStorageAt', params: [BRIDGE, SLOT, pin] },
    { key: 'implementation_code', method: 'eth_getCode', params: [IMPL, pin] },
    { key: 'get_fusdc', ...call(BRIDGE, 'getFUSDC', [], source) },
    { key: 'fusdc_code', method: 'eth_getCode', params: [FUSDC, pin] },
    { key: 'fee', ...call(BRIDGE, 'getWithdrawalFeeBPS', [], source) },
    { key: 'pause', ...call(BRIDGE, 'isWithdrawalsPaused', [], source) },
    { key: 'idle_fusdc_claim', ...call(BRIDGE, 'getIdleBalance', [], source) },
    {
      key: 'full_net_ea',
      ...call(BRIDGE, 'previewRedeem', [BigInt(plan.subject.sharesRaw)], source),
    },
    { key: 'bridge_funding', ...call(FUSDC, 'maxWithdraw', [BRIDGE], source, wrapperAbi) },
    { key: 'header_after', ...head },
  ]
}
function replayWrapper(plan, source, traces) {
  check(dense(traces, 12), 'wrapper_count')
  const requests = fluidUsdcHypotheticalWrapperRequests(plan, source),
    decoded = {}
  for (let n = 0; n < 12; n++) {
    const t = traces[n],
      spec = requests[n]
    check(
      keys(t, ['key', 'request', 'response']) &&
        t.key === spec.key &&
        keys(t.request, ['jsonrpc', 'id', 'method', 'params']) &&
        t.request.jsonrpc === '2.0' &&
        Number.isSafeInteger(t.request.id) &&
        t.request.id > 0 &&
        t.request.method === spec.method &&
        isDeepStrictEqual(t.request.params, spec.params) &&
        keys(t.response, ['jsonrpc', 'id', 'result']) &&
        t.response.jsonrpc === '2.0' &&
        t.response.id === t.request.id,
      'wrapper_request',
    )
    const result = t.response.result
    if (spec.key.startsWith('header')) {
      decoded[spec.key] = header(result, source)
      continue
    }
    if (spec.method === 'eth_getCode') {
      check(HEX.test(result) && result !== '0x', 'runtime')
      decoded[spec.key] = keccak256(result)
      continue
    }
    if (spec.method === 'eth_getStorageAt') {
      check(result === '0x' + '0'.repeat(24) + IMPL.slice(2), 'implementation_slot')
      continue
    }
    const names = {
        get_fusdc: 'getFUSDC',
        fee: 'getWithdrawalFeeBPS',
        pause: 'isWithdrawalsPaused',
        idle_fusdc_claim: 'getIdleBalance',
        full_net_ea: 'previewRedeem',
        bridge_funding: 'maxWithdraw',
      },
      abi = wrapperAbi
    check(HEX.test(result), 'abi_hex')
    const value = decodeFunctionResult({ abi, functionName: names[spec.key], data: result })
    check(
      encodeFunctionResult({ abi, functionName: names[spec.key], result: value }).toLowerCase() ===
        result,
      'canonical_abi',
    )
    decoded[spec.key] = typeof value === 'bigint' ? value.toString() : value
  }
  check(
    decoded.bridge_code === plan.runtimePins.proxyKeccak256 &&
      decoded.implementation_code === plan.runtimePins.implementationKeccak256 &&
      decoded.fusdc_code ===
        plan.runtimePins.underlyingIdentities.find((i) => i.address === FUSDC)?.codeHash &&
      decoded.get_fusdc.toLowerCase() === FUSDC &&
      decoded.fee === '5' &&
      decoded.pause === false &&
      UINT.test(decoded.full_net_ea) &&
      BigInt(decoded.full_net_ea) <= MAX &&
      UINT.test(decoded.bridge_funding) &&
      BigInt(decoded.bridge_funding) <= MAX,
    'wrapper_pins_fee_pause',
  )
  return decoded
}
function protocolReplay(plan, receipt, source) {
  const p = replayProtocol(receipt, plan.protocolSubject, source)
  check(
    receipt.mode === 'historical_exact_header' &&
      receipt.budget.physicalRequestStarts === 28 &&
      receipt.budget.maxRequests === 28 &&
      dense(receipt.traces, 28) &&
      p.origins.every((o) =>
        isDeepStrictEqual(o.identities, plan.runtimePins.underlyingIdentities),
      ),
    'protocol_runtime',
  )
  return p
}
export function parseFluidUsdcHypotheticalJson(text) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= 8 * 1024 * 1024, 'json_size')
  let i = 0
  const ws = () => {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++
  }
  const string = () => {
    const start = i++
    check(text[start] === '"', 'json_string')
    while (i < text.length) {
      const c = text[i++]
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') return JSON.parse(text.slice(start, i))
    }
    throw Error('fluid_usdc_hypothetical_json_string')
  }
  const value = (depth) => {
    check(depth <= 32, 'json_depth')
    ws()
    if (text[i] === '"') {
      string()
      return
    }
    if (text[i] === '{') {
      i++
      ws()
      const seen = new Set()
      if (text[i] === '}') {
        i++
        return
      }
      while (true) {
        ws()
        const k = string()
        check(!seen.has(k), 'duplicate_json_key')
        seen.add(k)
        ws()
        check(text[i++] === ':', 'json_colon')
        value(depth + 1)
        ws()
        const c = text[i++]
        if (c === '}') return
        check(c === ',', 'json_object')
      }
    }
    if (text[i] === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      while (true) {
        value(depth + 1)
        ws()
        const c = text[i++]
        if (c === ']') return
        check(c === ',', 'json_array')
      }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    check(m, 'json_atom')
    i += m[0].length
  }
  value(0)
  ws()
  check(i === text.length, 'json_trailing')
  return JSON.parse(text)
}

/** Acceptance requires complete native replay, ledger/body join, lifecycle and exact private plan. */
export function inspectFluidBridgeUsdcHypotheticalHistory(value, plan) {
  ensurePlan(plan)
  check(
    keys(value, [
      'schema',
      'plan',
      'planSha256',
      'startedAtUtc',
      'availableAtUtc',
      'elapsedMs',
      'physicalStarts',
      'pendingSettlements',
      'failure',
      'ledger',
      'protocolCaptures',
      'wrapperOrigins',
      'positionKind',
      'owner',
      'historicalOwnership',
      'execution',
      'minedPayout',
      'sha256',
    ]),
    'schema',
  )
  const { sha256, ...body } = value
  check(
    value.schema === 'fluid_bridge_usdc_hypothetical_history_capture_v1' &&
      isDeepStrictEqual(value.plan, plan) &&
      value.planSha256 === sha(JSON.stringify(plan)) &&
      sha256 === sha(JSON.stringify(body)) &&
      value.positionKind === 'hypothetical_fixed_shares_not_owner' &&
      value.owner === null &&
      value.historicalOwnership === false &&
      value.execution === 'unassessed' &&
      value.minedPayout === false &&
      utc(value.startedAtUtc) &&
      utc(value.availableAtUtc) &&
      Date.parse(value.availableAtUtc) >= Date.parse(value.startedAtUtc) &&
      Date.parse(value.startedAtUtc) >= Date.parse(plan.cashWitness.availableAt) &&
      Date.parse(value.startedAtUtc) >= Date.parse(plan.retainedNativeProvenance.availableAtUtc) &&
      value.elapsedMs >= 0 &&
      value.elapsedMs <= 120000 &&
      value.physicalStarts === 208 &&
      value.pendingSettlements === 0 &&
      value.failure === null &&
      dense(value.ledger, 208) &&
      dense(value.protocolCaptures, 4) &&
      dense(value.wrapperOrigins, 2) &&
      Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024,
    'integrity_lifecycle',
  )
  const seen = new Set(),
    last = new Map(),
    stageStarts = new Map()
  for (const [n, row] of value.ledger.entries()) {
    check(
      keys(row, [
        'physicalId',
        'host',
        'stage',
        'request',
        'startedAtUtc',
        'startedElapsedMs',
        'completedAtUtc',
        'completedElapsedMs',
        'status',
        'httpStatus',
        'bodyBytes',
        'bodySha256',
        'rawBodyBase64',
        'safeCode',
        'accepted',
      ]) &&
        row.physicalId === n + 1 &&
        HOSTS.includes(row.host) &&
        row.accepted === true &&
        row.status === 'success' &&
        row.httpStatus === 200 &&
        row.safeCode === null &&
        utc(row.startedAtUtc) &&
        utc(row.completedAtUtc) &&
        row.startedElapsedMs >= 0 &&
        row.startedElapsedMs < 120000 &&
        row.completedElapsedMs >= row.startedElapsedMs &&
        row.completedElapsedMs - row.startedElapsedMs <= 8000 &&
        row.completedElapsedMs <= value.elapsedMs &&
        row.startedElapsedMs - (last.get(row.host) ?? -Infinity) >= 250 &&
        typeof row.rawBodyBase64 === 'string',
      'ledger_lifecycle',
    )
    last.set(row.host, row.startedElapsedMs)
    const stageKey = row.host + ':' + row.stage
    if (!stageStarts.has(stageKey)) stageStarts.set(stageKey, row.startedElapsedMs)
    check(row.completedElapsedMs - stageStarts.get(stageKey) <= 12000, 'origin_window')
    const bytes = Buffer.from(row.rawBodyBase64, 'base64')
    check(
      bytes.toString('base64') === row.rawBodyBase64 &&
        bytes.length === row.bodyBytes &&
        bytes.length <= 65536 &&
        sha(bytes) === row.bodySha256,
      'raw_body_seal',
    )
    seen.add(row.physicalId)
  }
  const join = (host, stage, request, response) => {
    const rows = value.ledger.filter(
      (r) => r.host === host && r.stage === stage && isDeepStrictEqual(r.request, request),
    )
    check(
      rows.length === 1 &&
        isDeepStrictEqual(
          parseFluidUsdcHypotheticalJson(
            Buffer.from(rows[0].rawBodyBase64, 'base64').toString('utf8'),
          ),
          response,
        ),
      'ledger_native_join',
    )
    check(seen.delete(rows[0].physicalId), 'ledger_reuse')
  }
  const points = plan.anchors.map((a, n) => {
    const receipt = value.protocolCaptures[n],
      p = protocolReplay(plan, receipt, a.source)
    for (const t of receipt.traces) join(t.host, 'protocol_' + n, t.request, t.response)
    const wrappers = value.wrapperOrigins.map((o, j) => {
      check(
        keys(o, ['host', 'anchors']) && o.host === HOSTS[j] && dense(o.anchors, 4),
        'wrapper_origins',
      )
      const traces = o.anchors[n]
      const d = replayWrapper(plan, a.source, traces)
      for (const t of traces) join(o.host, 'wrapper_' + n, t.request, t.response)
      return d
    })
    check(isDeepStrictEqual(wrappers[0], wrappers[1]), 'wrapper_agreement')
    const w = wrappers[0],
      q = p.prongs
    return {
      source: a.source,
      hypotheticalSharesRaw: plan.subject.sharesRaw,
      shareDecimals: 18,
      asset: USDC,
      assetDecimals: 6,
      fullNetEaRaw: w.full_net_ea,
      feeBps: 5,
      paused: false,
      idleFUSDCClaimRaw: w.idle_fusdc_claim,
      nativeProngs: {
        bridgeFunding: w.bridge_funding,
        bankCash: q.sharedLiquidityCashRaw,
        bankSupply: q.fTokenReportedSupplyRaw,
        bankWithdrawableUntilLimit: q.withdrawableUntilLimitRaw,
        bankResolverWithdrawable: q.resolverReportedWithdrawableRaw,
      },
      runtimeIdentities: p.origins[0].identities,
      authenticatedBridgeCashRaw: a.authenticatedBridgeCashRaw,
    }
  })
  check(seen.size === 0, 'ledger_unjoined')
  return freeze({
    schema: 'replayed_fluid_bridge_usdc_hypothetical_history_v1',
    availableAtUtc: value.availableAtUtc,
    points,
    positionKind: 'hypothetical_fixed_shares_not_owner',
    owner: null,
    historicalOwnership: false,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
    originalTransportRetagged: false,
    rawCaptureSha256: sha256,
  })
}
function privateReceiptCopy(input) {
  let nodes = 0,
    bytes = 0
  const seen = new WeakSet()
  const copy = (v, depth) => {
    check(++nodes <= 40000 && depth <= 32, 'receipt_tree')
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v)
      check(bytes <= 8 * 1024 * 1024, 'receipt_size')
      return v
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v
    check(
      v &&
        typeof v === 'object' &&
        !seen.has(v) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
      'receipt_plain_data',
    )
    seen.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    check(
      Object.values(ds).every((d) => Object.hasOwn(d, 'value')),
      'receipt_accessor',
    )
    let result
    if (Array.isArray(v)) {
      check(v.length <= 2000 && Object.keys(ds).length === v.length + 1, 'receipt_dense')
      result = Array.from({ length: v.length }, (_, n) => {
        check(ds[n]?.enumerable, 'receipt_dense')
        return copy(ds[n].value, depth + 1)
      })
    } else {
      result = {}
      for (const [k, d] of Object.entries(ds)) {
        check(d.enumerable && !['__proto__', 'constructor', 'prototype'].includes(k), 'receipt_key')
        bytes += Buffer.byteLength(k)
        check(bytes <= 8 * 1024 * 1024, 'receipt_size')
        result[k] = copy(d.value, depth + 1)
      }
    }
    seen.delete(v)
    return result
  }
  return copy(input, 0)
}
// Authority is app-owned native acquisition or an exact inventoried original body.
export function replayFluidBridgeUsdcHypotheticalHistory(input, plan) {
  ensurePlan(plan)
  const value = privateReceiptCopy(input)
  const replay = inspectFluidBridgeUsdcHypotheticalHistory(value, plan)
  check(
    originalCaptures.get(plan)?.has(value.sha256) ||
      offlinePins.some((p) => p.body === value.sha256 && p.plan === value.planSha256),
    'original_capture_authority_required',
  )
  return freeze({ ...replay, authoritativeNativeCapture: true })
}
export async function captureFluidBridgeUsdcHypotheticalHistory(plan, origins, options = {}) {
  ensurePlan(plan)
  check(
    options &&
      Object.getPrototypeOf(options) === Object.prototype &&
      Object.getOwnPropertySymbols(options).length === 0,
    'capture_options',
  )
  const descriptors = Object.getOwnPropertyDescriptors(options)
  check(
    Object.values(descriptors).every((d) => Object.hasOwn(d, 'value')),
    'capture_accessors',
  )
  options = Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]))
  const originalEligible =
    configuredPairs.has(origins) &&
    globalThis.fetch === nativeFetch &&
    Object.keys(options).every((k) => k === 'root')
  const root = options.root ?? process.cwd(),
    freeBytes =
      options.freeBytes ??
      (() => {
        const d = statfsSync(root)
        return Number(d.bavail) * Number(d.bsize)
      })
  check(freeBytes() >= 256 * 1024 * 1024 + 8 * 1024 * 1024, 'reserve')
  const c = createFluidUsdcHypotheticalCaptureControl(origins, options),
    protocolCaptures = [],
    wrapperOrigins = HOSTS.map((host) => ({ host, anchors: [] }))
  const now = options.now ?? Date.now
  try {
    for (const [n, a] of plan.anchors.entries()) {
      c.beginStage('protocol_' + n)
      const deadlineMs = Math.min(60000, Math.floor(c.remaining()))
      check(deadlineMs >= 1000, 'global_remaining')
      const receipt = await captureProtocol(plan.protocolSubject, origins, {
        source: a.source,
        fetcher: c.fetcher,
        now,
        maxRequests: 28,
        deadlineMs,
      })
      protocolReplay(plan, receipt, a.source)
      protocolCaptures.push(receipt)
      c.beginStage('wrapper_' + n)
      await Promise.all(
        HOSTS.map(async (host, j) => {
          const o = origins.find((o) => o.host === host),
            traces = []
          for (const [index, spec] of fluidUsdcHypotheticalWrapperRequests(
            plan,
            a.source,
          ).entries()) {
            const request = {
              jsonrpc: '2.0',
              id: index + 1,
              method: spec.method,
              params: spec.params,
            }
            const response = await c.fetcher(o.url, {
              method: 'POST',
              redirect: 'error',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(request),
            })
            traces.push({
              key: spec.key,
              request,
              response: parseFluidUsdcHypotheticalJson(await response.text()),
            })
          }
          replayWrapper(plan, a.source, traces)
          wrapperOrigins[j].anchors.push(traces)
        }),
      )
    }
  } catch {
    c.stop('capture_unavailable')
  }
  const lifecycle = await c.finish()
  const value = freeze(
    seal({
      schema: 'fluid_bridge_usdc_hypothetical_history_capture_v1',
      plan,
      planSha256: sha(JSON.stringify(plan)),
      ...lifecycle,
      protocolCaptures,
      wrapperOrigins,
      positionKind: 'hypothetical_fixed_shares_not_owner',
      owner: null,
      historicalOwnership: false,
      execution: 'unassessed',
      minedPayout: false,
    }),
  )
  check(Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024, 'artifact_cap')
  let replay = null,
    inspection = null
  try {
    inspection = inspectFluidBridgeUsdcHypotheticalHistory(value, plan)
    if (originalEligible) {
      const originals = originalCaptures.get(plan) ?? new Set()
      originals.add(value.sha256)
      originalCaptures.set(plan, originals)
      replay = replayFluidBridgeUsdcHypotheticalHistory(value, plan)
    }
  } catch {
    /* Failed/late attempts are retained, never accepted. */
  }
  return {
    receipt: value,
    replay,
    inspection,
    accepted: replay !== null,
    fileBodySha256: value.sha256,
    compactBodySha256: replay ? sha(JSON.stringify(replay)) : null,
    settlementReceipts: c.settlementReceipts,
  }
}
// Deliberately no capture CLI: root supplies configured origins to the exported manual function.
export function main(args = process.argv.slice(2)) {
  check(args.length === 1 && args[0] === '--plan', 'cli_mode')
  return prepareFluidBridgeUsdcHypotheticalHistoryPlan()
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(main()) + '\n')
  } catch {
    process.stderr.write('fluid_usdc_hypothetical_unavailable\n')
    process.exitCode = 1
  }
}
