// Manual historical native observations. Importing this module launches no reads or jobs.
import { createHash } from 'node:crypto'
import {
  constants,
  statfsSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { encodeFunctionData, keccak256 } from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import * as cashModule from './conditional-cash-time-holdout.mjs'
import { morphoProbeResponseByteLimit } from './morpho-probe-raw-body-storage.mjs'

const pick = (m, k) => m[k] ?? m.default?.[k]
const sha = (v) => createHash('sha256').update(v).digest('hex')
const check = (ok, code) => {
  if (!ok) throw Error('usd3_hypothetical_' + code)
}
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const prepared = new WeakSet()
const configuredOriginPairs = new WeakSet()
const originalCaptures = new WeakMap()
const nativeFetch = globalThis.fetch
// Only independently verified originals may enter this literal inventory.
// Never accept caller-supplied digests as native evidence authority.
const OFFLINE_INVENTORY_PINS = freeze([
  {
    bodySha256: '5a60236ecbc570c51a35768d3f7ea4bc57b726393d0946f36a670d93a878427b',
    planSha256: '5d5ecf4b5b5d8a70fa356154eab23fb512ace6503877b259da95fe281257f60b',
    fileSha256: 'f19192d5e296a2e7c8c7e363e37e94b4754f745d5fb6b0817df09d739151d62a',
  },
  // Parent verified all physical responses, settlement seals and bound calldata.
  // These are getter-reference reconstructions, never historical owner evidence.
  {
    bodySha256: '8ea47999dbcc2fcc6df23922f77d93f9b41104a772036c52e77420f34e292e8f',
    planSha256: '18794fdbb229df9ad8177e32f4fb715c746e8a99ceeba9053b06ab75de2ee5bb',
    fileSha256: '4832af2fb50c3c49b1b9376620e210b2cad49370f271b27c9885d7e323786ae6',
  },
  {
    bodySha256: '70edda797499335eb0d23893ffeb3e1c138201e82845497a8a85bc0b0a7b6a95',
    planSha256: '63d763688214667749c873de9f87f0cfe1b884dd310ab36b293daee19d6b392e',
    fileSha256: '2d2555cdcf78ee102d37c5210bad91c5fa78c93665beb674530062b05d7b023a',
  },
  // Independently verified current-runtime batches 112-115 and 116-119.
  // Same hypothetical getter reference; no historical ownership is established.
  {
    bodySha256: '854b0f86648b5c65440e7c2adf91c511c9c833bdf749c16b45e30764d94d59c1',
    planSha256: '2e92b17778dc92bde5e8c278c3512b31983b083f23d38359dfc8f7e72f07dd46',
    fileSha256: 'fc679c1e855bd95bfd5c8f883546dcf96c5cc2690e906055f33c0a9df0e9d5d3',
  },
  {
    bodySha256: '6b7de36102a2aec64a83db1a5525fdab3b8d03ed1ea7d620020e44083947eb53',
    planSha256: '2d711d90e30170b8e3fcaba281cbc6fa6c841124b33ab75d572bdc5087248047',
    fileSha256: '5c8da10f82abf7f7130bca42ea7c056d1af75059d28f848218fe259385ada277',
  },
])
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const USD3 = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const IMPL = '0xd1f1c3f485063712873285bf4ef25ab068f13893'
const DELEGATE = '0xd377919fa87120584b21279a491f82d5265a139c'
const ZERO = '0x0000000000000000000000000000000000000000'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:[0-9a-f]{2})+$/
const UINT = /^(0|[1-9][0-9]{0,77})$/
const MAX = (1n << 256n) - 1n
const raw = (v) => typeof v === 'string' && UINT.test(v) && BigInt(v) <= MAX
const utc = (v) =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const keys = (v, list) =>
  v &&
  Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).length === list.length &&
  list.every((k) => Object.hasOwn(v, k))
const dense = (v, n) =>
  Array.isArray(v) &&
  Object.getPrototypeOf(v) === Array.prototype &&
  v.length === n &&
  Object.getOwnPropertyNames(v).length === n + 1 &&
  Array.from({ length: n }, (_, j) => Object.hasOwn(v, j)).every(Boolean)
// Validate data properties before touching caller values; copying also defeats later mutations.
function plainCopy(v, depth = 0) {
  check(depth <= 32, 'plain_depth')
  if (v === null || ['string', 'boolean'].includes(typeof v)) return v
  if (typeof v === 'number') {
    check(Number.isFinite(v), 'plain_number')
    return v
  }
  check(v && typeof v === 'object' && Object.getOwnPropertySymbols(v).length === 0, 'plain_value')
  const ds = Object.getOwnPropertyDescriptors(v),
    array = Array.isArray(v)
  check(
    Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype) &&
      Object.values(ds).every((d) => Object.hasOwn(d, 'value')),
    'plain_accessors_or_prototype',
  )
  if (array) {
    check(dense(v, ds.length.value), 'plain_sparse')
    return Array.from({ length: ds.length.value }, (_, n) => plainCopy(ds[n].value, depth + 1))
  }
  const out = {}
  for (const [k, d] of Object.entries(ds)) {
    check(d.enumerable, 'plain_hidden')
    Object.defineProperty(out, k, {
      value: plainCopy(d.value, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}
/** JSON.parse accepts duplicate keys; this scanner rejects them at every object depth. */
export function parseUsd3HypotheticalJson(text) {
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
    throw Error('usd3_hypothetical_json_string')
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
export const USD3_HYPOTHETICAL_POLICY = freeze({
  maxRequests: 138,
  requestsPerAnchorPerOrigin: 17,
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
export const USD3_HYPOTHETICAL_ABI = freeze([
  ...['tokenizedStrategyAddress', 'asset'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  })),
  ...['decimals', 'nav', 'totalAssets'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: name === 'decimals' ? 'uint8' : 'uint256' }],
  })),
  {
    type: 'function',
    name: 'isShutdown',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  ...[
    ['previewRedeem', 'uint256'],
    ['availableWithdrawLimit', 'address'],
    ['balanceOf', 'address'],
  ].map(([name, type]) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [{ name: 'subject', type }],
    outputs: [{ type: 'uint256' }],
  })),
])
export async function configuredUsd3HypotheticalOrigins() {
  const m = await import('./carry-depth-quote-archive.mjs'),
    policy = pick(m, 'readProviderPolicy')()
  check(policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1', 'provider_policy')
  const pool = pick(m, 'configuredProviders')(null, policy),
    origins = HOSTS.map((host) => pool.find((o) => o.host === host))
  check(pool.length === 2 && origins.every(Boolean), 'configured_origins')
  const registered = freeze(origins.map((origin) => ({ ...origin })))
  configuredOriginPairs.add(registered)
  return registered
}
export function prepareUsd3HypotheticalHistoryPlan(options = {}) {
  const copy = plainCopy(options)
  check(
    keys(copy, Object.keys(copy)) &&
      Object.keys(copy).every((k) =>
        ['root', 'cashIndices', 'sharesRaw', 'withdrawalLimitSubject'].includes(k),
      ),
    'selection_options',
  )
  const root = copy.root ?? process.cwd(),
    indices = copy.cashIndices ?? [115, 116, 117, 118],
    sharesRaw = copy.sharesRaw ?? '1000000',
    withdrawalLimitSubject = Object.hasOwn(copy, 'withdrawalLimitSubject')
      ? copy.withdrawalLimitSubject
      : ZERO
  check(
    typeof root === 'string' &&
      root.length > 0 &&
      dense(indices, 4) &&
      indices.every(
        (n, j) =>
          Number.isSafeInteger(n) && n >= 0 && n < 120 && (j === 0 || n === indices[j - 1] + 1),
      ),
    'anchor_selection',
  )
  check(raw(sharesRaw) && BigInt(sharesRaw) > 0n, 'shares')
  check(
    typeof withdrawalLimitSubject === 'string' &&
      /^0x[0-9a-f]{40}$/.test(withdrawalLimitSubject) &&
      (!Object.hasOwn(copy, 'withdrawalLimitSubject') || withdrawalLimitSubject !== ZERO),
    'withdrawal_limit_subject',
  )
  const budget = { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024, totalBytes: 0 }
  const read = (p) => readBoundedReceiptFile(resolve(root, p), budget)
  const audit = pick(cashModule, 'authenticateArtifacts')(
    read('data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json'),
    read('data/research/venue-signals/conditional-sampled-cash-history-v1.pins.json'),
  )
  const subject = {
    routeKey: 'USDC → USD3 [USDC]',
    destination: USD3,
    asset: USDC,
    assetDecimals: 6,
    shareDecimals: 6,
    sharesRaw,
  }
  const matches = Object.values(audit.histories).filter(
    (h) =>
      h.identity.routeKey === subject.routeKey &&
      h.identity.destination === USD3 &&
      h.identity.asset === USDC &&
      h.identity.assetDecimals === 6,
  )
  check(matches.length === 1, 'cash_identity')
  const h = matches[0]
  check(
    sha(JSON.stringify(h)) === '2942d212217408f7bbe401abef40d9adbeed0ae5fe35d088f8a1f22f7b5ea89d' &&
      h.witness.manifestSha256 ===
        '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
    'usd3_cash_pin',
  )
  const anchors = indices.map((cashIndex) => {
    const rows = h.points.filter((p) => p[0] === cashIndex)
    check(rows.length === 1, 'cash_anchor')
    const p = rows[0]
    return {
      cashIndex,
      source: {
        chainId: 1,
        blockNumber: Number(p[1]),
        blockHash: p[2],
        blockTime: p[3],
        finalized: true,
      },
      authenticatedIdleUsdcRaw: p[4],
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
        raw(a.authenticatedIdleUsdcRaw) &&
        (n === 0 ||
          (a.source.blockNumber > anchors[n - 1].source.blockNumber &&
            Date.parse(a.source.blockTime) > Date.parse(anchors[n - 1].source.blockTime) &&
            a.source.blockHash !== anchors[n - 1].source.blockHash)),
    ),
    'cash_chronology',
  )
  const plan = freeze({
    schema: 'usd3_hypothetical_history_plan_v1',
    subject,
    anchors,
    originHosts: [...HOSTS],
    providerPolicyId: 'configured-c1-c3-v1',
    policy: USD3_HYPOTHETICAL_POLICY,
    runtimePins: {
      proxy: USD3,
      implementation: IMPL,
      delegate: DELEGATE,
      asset: USDC,
      implementationSlot: SLOT,
    },
    cashWitness: plainCopy(h.witness),
    cashCompactSha256: sha(JSON.stringify(h)),
    positionKind: 'hypothetical_fixed_shares_not_owner',
    owner: null,
    historicalOwnership: false,
    withdrawalLimitSubject,
    conditionalReferenceAddressQuote: true,
    ownerCommitmentQualification: false,
    sourceImplementationEquivalence: false,
    execution: 'unassessed',
    minedPayout: false,
  })
  prepared.add(plan)
  return plan
}
const ensurePlan = (p) =>
  check(prepared.has(p) && Object.isFrozen(p), 'private_prepared_plan_required')

/** Physical starts are recorded before fetch; paced invocations are tracked until drained. */
export function createUsd3HypotheticalCaptureControl(
  origins,
  {
    fetcher = nativeFetch,
    now = Date.now,
    monotonic = () => performance.now(),
    pace = (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    headerResponsePolicy = null,
  } = {},
) {
  morphoProbeResponseByteLimit(headerResponsePolicy)
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
    totalBytes = 0,
    finished = null
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
      if (closed || clock >= limit || ledger.length >= 138) {
        stop('start_budget')
        throw Error('usd3_hypothetical_start_budget')
      }
      if (options.signal?.aborted) {
        stop('upstream_aborted')
        throw Error('usd3_hypothetical_upstream_aborted')
      }
      const wait = (lastStart.get(o.host) ?? -Infinity) + 250 - clock
      if (wait <= 0) break
      await pace(Math.ceil(wait))
      // Early wakeups must recheck the monotonic spacing; a stalled injected clock cannot spin.
      check(monotonic() > clock, 'pacing_clock_unavailable')
    }
    const at = monotonic(),
      limit = Math.min(deadline, windows.get(o.host))
    if (closed || at >= limit || ledger.length >= 138) {
      stop('start_budget')
      throw Error('usd3_hypothetical_start_budget')
    }
    if (options.signal?.aborted) {
      stop('upstream_aborted')
      throw Error('usd3_hypothetical_upstream_aborted')
    }
    const request = parseUsd3HypotheticalJson(options.body)
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
    const nativeHeaderRole = options.nativeHeaderRole ?? null
    const responseLimit = morphoProbeResponseByteLimit(headerResponsePolicy, request, nativeHeaderRole)
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
      ...(nativeHeaderRole === null ? {} : { nativeHeaderRole: plainCopy(nativeHeaderRole) }),
    }
    ledger.push(row)
    lastStart.set(o.host, at)
    controllers.add(controller)
    const timeout = Math.min(8000, limit - at)
    let expired = false,
      timeoutTimer,
      streamReader
    const cancelStream = () => {
      if (streamReader) void streamReader.cancel().catch(() => {})
    }
    controller.signal.addEventListener('abort', cancelStream, { once: true })
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
        streamReader = reader
        check(reader, 'stream_required')
        if (controller.signal.aborted) {
          cancelStream()
          streamReader = null
          reader.releaseLock()
          throw Error('aborted_response')
        }
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
            check(length <= responseLimit, 'response_cap')
            chunks.push(Buffer.from(value))
          }
        } catch (error) {
          cancelStream()
          throw error
        } finally {
          streamReader = null
          reader.releaseLock()
        }
        const bytes = Buffer.concat(chunks),
          text = bytes.toString('utf8')
        row.rawBodyBase64 = bytes.toString('base64')
        row.bodyBytes = bytes.length
        row.bodySha256 = sha(bytes)
        totalBytes += bytes.length
        check(totalBytes <= 5 * 1024 * 1024, 'ledger_cap')
        check(Buffer.from(text, 'utf8').equals(bytes), 'response_utf8')
        const envelope = parseUsd3HypotheticalJson(text)
        check(
          response.ok &&
            !response.redirected &&
            (!response.url || new URL(response.url).hostname === o.host) &&
            (keys(envelope, ['jsonrpc', 'id', 'result']) ||
              keys(envelope, ['jsonrpc', 'id', 'error'])) &&
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
        return new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-usd3-physical-id': String(id) },
        })
      } catch {
        row.completedAtUtc ??= new Date(now()).toISOString()
        row.completedElapsedMs ??= monotonic() - start
        if (row.status !== 'late_success') {
          row.status = 'failed'
          row.safeCode = expired ? 'read_timeout' : 'provider_unavailable'
        }
        row.accepted = false
        stop(row.safeCode)
        throw Error('usd3_hypothetical_provider_unavailable')
      } finally {
        controllers.delete(controller)
        options.signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', cancelStream)
        // Separate append-only, individually sealed evidence; never mutates a sealed capture.
        settlementReceipts.push(
          freeze(
            seal({
              schema: 'usd3_hypothetical_physical_settlement_v1',
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
              reject(Error('usd3_hypothetical_read_timeout'))
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
    if (closed) return Promise.reject(Error('usd3_hypothetical_closed'))
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
    if (finished) return finished
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
    finished = freeze({
      ...result,
      terminalCommitments: result.ledger.map((row) => ({
        physicalId: row.physicalId,
        rowSha256: sha(JSON.stringify(row)),
      })),
    })
    return finished
  }
  return { fetcher: trackedFetch, beginStage, finish, stop, remaining, settlementReceipts }
}

const call = (to, name, args, source) => ({
  method: 'eth_call',
  params: [
    { to, data: encodeFunctionData({ abi: USD3_HYPOTHETICAL_ABI, functionName: name, args }) },
    { blockHash: source.blockHash, requireCanonical: true },
  ],
})
export function usd3HypotheticalRequests(plan, source) {
  ensurePlan(plan)
  check(
    plan.anchors.some((a) => isDeepStrictEqual(a.source, source)),
    'source_not_in_plan',
  )
  const pin = { blockHash: source.blockHash, requireCanonical: true },
    head = {
      method: 'eth_getBlockByNumber',
      params: ['0x' + source.blockNumber.toString(16), false],
    }
  return [
    { key: 'header_before', ...head },
    { key: 'proxy_code', method: 'eth_getCode', params: [USD3, pin] },
    { key: 'implementation_slot', method: 'eth_getStorageAt', params: [USD3, SLOT, pin] },
    { key: 'implementation_code', method: 'eth_getCode', params: [IMPL, pin] },
    { key: 'delegate', ...call(USD3, 'tokenizedStrategyAddress', [], source) },
    { key: 'delegate_code', method: 'eth_getCode', params: [DELEGATE, pin] },
    { key: 'asset_code', method: 'eth_getCode', params: [USDC, pin] },
    { key: 'asset', ...call(USD3, 'asset', [], source) },
    { key: 'share_decimals', ...call(USD3, 'decimals', [], source) },
    { key: 'asset_decimals', ...call(USDC, 'decimals', [], source) },
    { key: 'native_ea', ...call(USD3, 'previewRedeem', [BigInt(plan.subject.sharesRaw)], source) },
    {
      key: 'withdrawal_limit',
      ...call(USD3, 'availableWithdrawLimit', [plan.withdrawalLimitSubject], source),
    },
    { key: 'shutdown', ...call(USD3, 'isShutdown', [], source) },
    { key: 'nav', ...call(USD3, 'nav', [], source) },
    { key: 'total_assets', ...call(USD3, 'totalAssets', [], source) },
    { key: 'idle_usdc_diagnostic', ...call(USDC, 'balanceOf', [USD3], source) },
    { key: 'header_after', ...head },
  ]
}
function decodeObservation(spec, response, source) {
  if (Object.hasOwn(response, 'error')) {
    check(
      spec.key === 'withdrawal_limit' &&
        response.error &&
        Number.isSafeInteger(response.error.code) &&
        typeof response.error.message === 'string',
      'essential_getter_error',
    )
    return { censored: true, safeCode: 'native_withdrawal_limit_unavailable' }
  }
  const result = response.result
  if (spec.key.startsWith('header')) {
    check(
      result &&
        result.number === '0x' + source.blockNumber.toString(16) &&
        result.hash === source.blockHash &&
        HASH.test(result.hash) &&
        result.timestamp === '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
      'header',
    )
    return { number: result.number, hash: result.hash, timestamp: result.timestamp }
  }
  if (spec.method === 'eth_getCode') {
    check(typeof result === 'string' && HEX.test(result), 'runtime')
    return result
  }
  check(typeof result === 'string' && HASH.test(result), 'canonical_word')
  if (spec.key === 'implementation_slot') {
    check(result === '0x' + '0'.repeat(24) + IMPL.slice(2), 'implementation_slot')
    return IMPL
  }
  if (spec.key === 'delegate' || spec.key === 'asset') {
    check(result.slice(2, 26) === '0'.repeat(24), 'canonical_address')
    const addr = '0x' + result.slice(26)
    check(addr === (spec.key === 'delegate' ? DELEGATE : USDC), 'address_pin')
    return addr
  }
  const v = BigInt(result)
  if (spec.key === 'shutdown') {
    check(v === 0n || v === 1n, 'canonical_bool')
    return v === 1n
  }
  if (spec.key.endsWith('decimals')) check(v === 6n, 'decimals_pin')
  return v.toString()
}
const ROW_KEYS = [
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
]
/** Recompute body joins and native points from the original private receipt. */
export function inspectUsd3HypotheticalHistory(input, plan) {
  ensurePlan(plan)
  const value = plainCopy(input)
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
      'terminalCommitments',
      'origins',
      'sha256',
    ]),
    'schema',
  )
  const { sha256, ...body } = value
  check(
    value.schema === 'usd3_hypothetical_history_capture_v1' &&
      isDeepStrictEqual(value.plan, plan) &&
      value.planSha256 === sha(JSON.stringify(plan)) &&
      sha256 === sha(JSON.stringify(body)),
    'seal_or_plan',
  )
  check(
    utc(value.startedAtUtc) &&
      utc(value.availableAtUtc) &&
      Date.parse(value.startedAtUtc) >= Date.parse(plan.cashWitness.availableAt) &&
      Date.parse(value.availableAtUtc) >= Date.parse(value.startedAtUtc) &&
      Number.isFinite(value.elapsedMs) &&
      value.elapsedMs >= 0 &&
      value.elapsedMs <= 120000 &&
      value.physicalStarts === 138 &&
      value.pendingSettlements === 0 &&
      value.failure === null &&
      dense(value.ledger, 138) &&
      dense(value.terminalCommitments, 138) &&
      dense(value.origins, 2) &&
      Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024,
    'integrity_lifecycle',
  )
  const ledger = new Map(),
    terminals = new Map(),
    envelopes = new Map(),
    last = new Map(),
    stageStarts = new Map()
  for (const c of value.terminalCommitments) {
    check(
      keys(c, ['physicalId', 'rowSha256']) &&
        Number.isSafeInteger(c.physicalId) &&
        !terminals.has(c.physicalId),
      'terminal_duplicate',
    )
    terminals.set(c.physicalId, c.rowSha256)
  }
  const sorted = [...value.ledger].sort((a, b) => a.physicalId - b.physicalId)
  for (const [n, row] of sorted.entries()) {
    check(
      keys(row, ROW_KEYS) &&
        row.physicalId === n + 1 &&
        HOSTS.includes(row.host) &&
        row.accepted === true &&
        row.status === 'success' &&
        row.httpStatus === 200 &&
        row.safeCode === null &&
        utc(row.startedAtUtc) &&
        utc(row.completedAtUtc) &&
        Date.parse(row.startedAtUtc) >= Date.parse(value.startedAtUtc) &&
        Date.parse(row.completedAtUtc) >= Date.parse(row.startedAtUtc) &&
        Date.parse(row.completedAtUtc) <= Date.parse(value.availableAtUtc) &&
        Number.isFinite(row.startedElapsedMs) &&
        row.startedElapsedMs >= 0 &&
        row.startedElapsedMs < 120000 &&
        Number.isFinite(row.completedElapsedMs) &&
        row.completedElapsedMs >= row.startedElapsedMs &&
        row.completedElapsedMs - row.startedElapsedMs <= 8000 &&
        row.completedElapsedMs <= value.elapsedMs &&
        row.startedElapsedMs - (last.get(row.host) ?? -Infinity) >= 250 &&
        typeof row.rawBodyBase64 === 'string' &&
        terminals.get(row.physicalId) === sha(JSON.stringify(row)),
      'ledger_lifecycle',
    )
    last.set(row.host, row.startedElapsedMs)
    const stageKey = row.host + ':' + row.stage
    if (!stageStarts.has(stageKey)) stageStarts.set(stageKey, row.startedElapsedMs)
    check(row.completedElapsedMs - stageStarts.get(stageKey) <= 12000, 'origin_window')
    const bytes = Buffer.from(row.rawBodyBase64, 'base64'),
      text = bytes.toString('utf8')
    check(
      bytes.toString('base64') === row.rawBodyBase64 &&
        Buffer.from(text, 'utf8').equals(bytes) &&
        bytes.length === row.bodyBytes &&
        bytes.length <= 65536 &&
        sha(bytes) === row.bodySha256,
      'raw_body_seal',
    )
    const response = parseUsd3HypotheticalJson(text)
    check(
      keys(row.request, ['jsonrpc', 'id', 'method', 'params']) &&
        row.request.jsonrpc === '2.0' &&
        Number.isSafeInteger(row.request.id) &&
        row.request.id > 0 &&
        (keys(response, ['jsonrpc', 'id', 'result']) ||
          keys(response, ['jsonrpc', 'id', 'error'])) &&
        response.jsonrpc === '2.0' &&
        response.id === row.request.id,
      'envelope',
    )
    ledger.set(row.physicalId, row)
    envelopes.set(row.physicalId, response)
  }
  const used = new Set()
  const join = (trace, host, stage, spec, id) => {
    check(
      keys(trace, ['physicalId', 'key']) && trace.key === spec.key && !used.has(trace.physicalId),
      'trace_duplicate',
    )
    const row = ledger.get(trace.physicalId)
    check(
      row &&
        row.host === host &&
        row.stage === stage &&
        isDeepStrictEqual(row.request, {
          jsonrpc: '2.0',
          id,
          method: spec.method,
          params: spec.params,
        }),
      'trace_join',
    )
    used.add(trace.physicalId)
    return envelopes.get(trace.physicalId)
  }
  const decoded = value.origins.map((o, j) => {
    check(
      keys(o, ['host', 'chain', 'anchors']) && o.host === HOSTS[j] && dense(o.anchors, 4),
      'origins',
    )
    const chain = join(
      o.chain,
      o.host,
      'chain',
      { key: 'chain_id', method: 'eth_chainId', params: [] },
      1,
    )
    check(chain.result === '0x1', 'chain_id')
    return o.anchors.map((traces, n) => {
      check(dense(traces, 17), 'anchor_requests')
      const a = plan.anchors[n],
        specs = usd3HypotheticalRequests(plan, a.source),
        d = {}
      for (const [k, spec] of specs.entries())
        d[spec.key] = decodeObservation(
          spec,
          join(traces[k], o.host, 'anchor_' + n, spec, k + 2),
          a.source,
        )
      check(d.idle_usdc_diagnostic === a.authenticatedIdleUsdcRaw, 'cash_join')
      return d
    })
  })
  check(used.size === 138, 'ledger_unjoined')
  const points = plan.anchors.map((a, n) => {
    const d = decoded[0][n]
    check(isDeepStrictEqual(d, decoded[1][n]), 'cross_origin_drift')
    const unavailable = typeof d.withdrawal_limit === 'object'
    return {
      source: a.source,
      acquiredAtUtc: value.availableAtUtc,
      hypotheticalSharesRaw: plan.subject.sharesRaw,
      shareDecimals: 6,
      asset: USDC,
      assetDecimals: 6,
      nativeEaRaw: d.native_ea,
      availableWithdrawLimitRaw: unavailable ? null : d.withdrawal_limit,
      nativeQuoteStatus: unavailable
        ? 'censored_native_withdrawal_limit_unavailable'
        : 'conditional_reference_address_quote',
      withdrawalLimitSubject: plan.withdrawalLimitSubject,
      conditionalReferenceAddressQuote: true,
      ownerCommitmentQualification: false,
      shutdown: d.shutdown,
      navRaw: d.nav,
      totalAssetsRaw: d.total_assets,
      idleUsdcDiagnosticRaw: d.idle_usdc_diagnostic,
      idleUsdcIsTotalFundingUpperBound: false,
      sourceClass: 'captured_identical_runtimes_only',
      runtimeIdentities: [
        ['proxy', USD3],
        ['implementation', IMPL],
        ['delegate', DELEGATE],
        ['asset', USDC],
      ].map(([key, address]) => ({ address, runtimeKeccak256: keccak256(d[key + '_code']) })),
      sourceImplementationEquivalence: false,
    }
  })
  return freeze({
    schema: 'replayed_usd3_hypothetical_history_v1',
    authoritativeNativeCapture: false,
    availableAtUtc: value.availableAtUtc,
    points,
    positionKind: plan.positionKind,
    owner: null,
    historicalOwnership: false,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
    rawCaptureSha256: value.sha256,
  })
}
/** Structural agreement alone cannot authorize a native capture. */
export function replayUsd3HypotheticalHistory(input, plan) {
  ensurePlan(plan)
  const value = plainCopy(input)
  const replay = inspectUsd3HypotheticalHistory(value, plan)
  const planSha256 = sha(JSON.stringify(plan))
  const liveOriginal = originalCaptures.get(plan)?.has(value.sha256) === true
  const inventoriedOriginal = OFFLINE_INVENTORY_PINS.some(
    (pin) => pin.bodySha256 === value.sha256 && pin.planSha256 === planSha256,
  )
  check(liveOriginal || inventoriedOriginal, 'original_capture_authority_required')
  return freeze({ ...replay, authoritativeNativeCapture: true })
}
export async function captureUsd3HypotheticalHistory(plan, origins, options = {}) {
  ensurePlan(plan)
  const supplied = Object.getOwnPropertyDescriptors(options)
  const allowed = [
    'root',
    'fetcher',
    'now',
    'monotonic',
    'pace',
    'setTimer',
    'clearTimer',
    'freeBytes',
  ]
  check(
    Object.getOwnPropertySymbols(options).length === 0 &&
      Object.keys(supplied).every(
        (key) =>
          allowed.includes(key) &&
          supplied[key].enumerable &&
          Object.hasOwn(supplied[key], 'value'),
      ),
    'capture_option_properties',
  )
  const authoritativeMode =
    configuredOriginPairs.has(origins) &&
    Object.getPrototypeOf(options) === Object.prototype &&
    Object.keys(supplied).every((key) => key === 'root')
  const snapshot = Object.create(null)
  for (const [key, descriptor] of Object.entries(supplied)) snapshot[key] = descriptor.value
  options = Object.freeze(snapshot)
  const root = options.root ?? process.cwd(),
    freeBytes =
      options.freeBytes ??
      (() => {
        const d = statfsSync(root)
        return Number(d.bavail) * Number(d.bsize)
      })
  check(
    freeBytes() >=
      USD3_HYPOTHETICAL_POLICY.reserveBytes + USD3_HYPOTHETICAL_POLICY.maxArtifactBytes,
    'reserve',
  )
  const c = createUsd3HypotheticalCaptureControl(origins, options),
    traces = HOSTS.map((host) => ({ host, chain: null, anchors: [] }))
  const send = async (j, stage, spec, id) => {
    const origin = origins.find((o) => o.host === HOSTS[j]),
      request = { jsonrpc: '2.0', id, method: spec.method, params: spec.params }
    const response = await c.fetcher(origin.url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    // The controller returns a bounded body; its physical ID links directly to the original ledger.
    parseUsd3HypotheticalJson(await response.text())
    return { physicalId: Number(response.headers.get('x-usd3-physical-id')), key: spec.key }
  }
  try {
    c.beginStage('chain')
    await Promise.all(
      HOSTS.map(async (_, j) => {
        traces[j].chain = await send(
          j,
          'chain',
          { key: 'chain_id', method: 'eth_chainId', params: [] },
          1,
        )
      }),
    )
    for (const [n, a] of plan.anchors.entries()) {
      c.beginStage('anchor_' + n)
      await Promise.all(
        HOSTS.map(async (_, j) => {
          const anchor = []
          traces[j].anchors.push(anchor)
          for (const [k, spec] of usd3HypotheticalRequests(plan, a.source).entries())
            anchor.push(await send(j, 'anchor_' + n, spec, k + 2))
        }),
      )
    }
  } catch {
    c.stop('capture_unavailable')
  }
  const lifecycle = await c.finish(),
    receipt = freeze(
      seal({
        schema: 'usd3_hypothetical_history_capture_v1',
        plan,
        planSha256: sha(JSON.stringify(plan)),
        ...lifecycle,
        origins: traces,
      }),
    )
  check(
    Buffer.byteLength(JSON.stringify(receipt)) <= USD3_HYPOTHETICAL_POLICY.maxArtifactBytes,
    'artifact_cap',
  )
  let replay = null,
    structuralReplay = null
  try {
    structuralReplay = inspectUsd3HypotheticalHistory(receipt, plan)
    if (authoritativeMode) {
      const originals = originalCaptures.get(plan) ?? new Set()
      originals.add(receipt.sha256)
      originalCaptures.set(plan, originals)
      replay = replayUsd3HypotheticalHistory(receipt, plan)
    }
  } catch {
    /* Rejected evidence remains private and unaccepted. */
  }
  return {
    receipt,
    replay,
    accepted: replay !== null,
    structuralReplay,
    structurallyAccepted: structuralReplay !== null,
    fileBodySha256: receipt.sha256,
    compactBodySha256: replay ? sha(JSON.stringify(replay)) : null,
    settlementReceipts: c.settlementReceipts,
  }
}
/** Immutable private artifacts: no overwrite, symlink, hardlink or partially authorized path. */
export function writeUsd3HypotheticalArtifact(path, value) {
  const body = Buffer.from(JSON.stringify(plainCopy(value)) + '\n')
  check(body.length <= USD3_HYPOTHETICAL_POLICY.maxArtifactBytes, 'artifact_cap')
  const disk = statfsSync(dirname(resolve(path)))
  check(
    Number(disk.bavail) * Number(disk.bsize) >= USD3_HYPOTHETICAL_POLICY.reserveBytes + body.length,
    'reserve',
  )
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, 'artifact_file')
    let written = 0
    while (written < body.length) {
      const n = writeSync(fd, body, written, body.length - written)
      check(n > 0, 'artifact_write')
      written += n
    }
    fsyncSync(fd)
    const after = fstatSync(fd),
      named = lstatSync(path)
    check(
      after.nlink === 1 &&
        named.nlink === 1 &&
        named.isFile() &&
        after.ino === named.ino &&
        after.dev === named.dev &&
        after.size === body.length &&
        (after.mode & 0o777) === 0o600,
      'artifact_changed',
    )
  } finally {
    closeSync(fd)
  }
  const dir = openSync(dirname(resolve(path)), constants.O_RDONLY)
  try {
    fsyncSync(dir)
  } finally {
    closeSync(dir)
  }
  return { bytes: body.length, fileSha256: sha(body) }
}
export function main(args = process.argv.slice(2)) {
  check(args.length === 1 && args[0] === '--plan', 'cli_mode')
  return prepareUsd3HypotheticalHistoryPlan()
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(main()) + '\n')
  } catch {
    process.stderr.write('usd3_hypothetical_unavailable\n')
    process.exitCode = 1
  }
}
