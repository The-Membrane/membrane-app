/** Bounded hypothetical fixed-stock history panel. Importing starts no reads. Frozen predecessors remain unchanged. */
import { createHash, randomUUID } from 'node:crypto'
import {
  constants, openSync, closeSync, readSync, writeSync, fsyncSync,
  fstatSync, lstatSync, statfsSync, mkdirSync, readdirSync,
} from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { encodeFunctionData, decodeFunctionResult, encodeFunctionResult, parseAbi, keccak256 } from 'viem'
import {
  configuredUsd3HypotheticalOrigins, parseUsd3HypotheticalJson,
} from './usd3-hypothetical-history-capture.mjs'
import {
  additionalHistoricalOwnerCredentialVariants,
} from './morpho-additional-historical-owner-funded-probe.mjs'
import { MORPHO_PROBE_ROW_STORAGE_SCHEMA as LEGACY_ROW_STORAGE_SCHEMA,
  decodeMorphoProbeNativeRow as decodeLegacyNativeRow } from './morpho-probe-raw-body-storage.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const MORPHO_V2_IDLE_HEADER_BACKFILL_PLAN_PATH = 'scripts/research/morpho-v2-idle-history-header-backfill-v1.plan.json'
export const MORPHO_V2_IDLE_HEADER_BACKFILL_PLAN_SHA = '880f8295dc562ff106dbf4e8307af0f78c0ad8729ed8b8262e2112f62dd26a9f'
const SELF = 'scripts/research/morpho-v2-idle-history-header-backfill-v1.mjs'
const FROZEN_V1_REFERENCES = freeze([
  { path: 'scripts/research/pyusd-b576-idle-history-capture.mjs', bytes: 47873,
    fileSha256: 'e199ff97ba55446413cb0ed311bc182c24060de2574863006a54e9a1e3f4858b' },
  { path: 'scripts/research/pyusd-b576-idle-history-capture.plan.json', bytes: 16261,
    fileSha256: '0f5f7a3cd147f601ed3f458b69432b72b594cfc28f41a9401be8f79f09f1c5bf' },
  { path: 'tests/unit/pyusdB576IdleHistoryCapture.original.test.mjs', bytes: 15724,
    fileSha256: 'aeacdb55970fdde5471f2830e46e6a3fafcc32aa12aa0174f3577b6144082ba6' },
])
const RETAINED_SOURCE_PATHS = Object.freeze([
  'scripts/research/usd3-hypothetical-history-capture.mjs',
  'scripts/research/carry-depth-quote-archive.mjs',
  'scripts/research/record-carry-morpho-v2-block-archive.mjs',
  'scripts/lib/boundedLocalReceiptFile.mjs',
  'scripts/research/morpho-observed-funded-holder-probe.mjs',
  'scripts/research/morpho-additional-historical-owner-funded-probe.mjs',
  'scripts/research/morpho-probe-raw-body-storage.mjs',
  'lib/carry/holderOriginCode.ts',
  'tests/unit/morphoV2IdleHistoryPanel.original.test.mjs',
  'scripts/research/morpho-v2-idle-history-panel-v1.mjs',
  'scripts/research/morpho-v2-idle-history-panel-v1.plan.json',
  'tests/unit/morphoV2IdleHistoryHeaderBackfill.original.test.mjs',
])
const MB = 1024 * 1024, ZERO = '0x' + '0'.repeat(40)
const HASH = /^0x[0-9a-f]{64}$/, HEX = /^0x(?:[0-9a-f]{2})*$/
const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const SUBJECT = Object.freeze({
  id: 'PYUSD_B576', vault: '0xb576765fb15505433af24fee2c0325895c559fb2',
  asset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
  owner: '0xf181e2cc93a47cb4903ac71c23ecb873726dc668', assetDecimals: 6, shareDecimals: 18,
})
const DEFAULT_ANCHORS = Object.freeze([
  Object.freeze({ chainId: 1, blockNumber: '26086569',
    blockHash: '0x47f2ef87e05d0a9f6d4f9cc1c47cfa504b8dc94bb1a52a8b8f778a409328c250',
    blockTime: '2026-09-29T23:59:59.000Z', finalized: true }),
  Object.freeze({ chainId: 1, blockNumber: '26093737',
    blockHash: '0xcd26204e996dceb606ccf0bc6f5bf8ea6747a471df8be73b5855f01624d5d743',
    blockTime: '2026-09-30T23:59:59.000Z', finalized: true }),
])
export const MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK = '352805058661206444'
export const MORPHO_V2_IDLE_HEADER_BACKFILL_Q = '500000'
export const MORPHO_V2_IDLE_HEADER_BACKFILL_HORIZON_MS = 86400000
const panelAnchor = (row) => ({ panelIndex: row[0], source: { chainId: 1, blockNumber: row[1],
  blockHash: row[2], blockTime: row[3], finalized: true }, expectedCashRaw: row[4],
  receiptPath: row[5], receiptPin: { path: row[5], bytes: row[6], fileSha256: row[7] },
  receiptBodySha256: row[8] })

function validateMorphoV2IdleHeaderBackfillCalendar(plan) {
  check(plan.panelPoints.length === 120 && plan.frozenProbeSharesRaw === MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK &&
    plan.QAssetRaw === MORPHO_V2_IDLE_HEADER_BACKFILL_Q && plan.horizonMs === MORPHO_V2_IDLE_HEADER_BACKFILL_HORIZON_MS &&
    plan.priorInspection.cashCatalogInspected === true && plan.priorInspection.october1And2EaInspected === true &&
    plan.priorInspection.untouchedHoldoutClaim === false && plan.strictDonorEndBeforeIssue === true &&
    plan.exactHorizonTimestampOnly === true && plan.interpolation === false, 'panel_semantics')
  let previous = -Infinity, previousBlock = 0n
  for (const [i, row] of plan.panelPoints.entries()) {
    const at = Date.parse(row[3])
    check(row.length === 9 && row[0] === i && /^[1-9][0-9]*$/.test(row[1]) && HASH.test(row[2]) &&
      Number.isSafeInteger(at) && utc(at) === row[3] && at > previous && BigInt(row[1]) > previousBlock &&
      /^(?:0|[1-9][0-9]*)$/.test(row[4]) && Number.isSafeInteger(row[6]) && row[6] > 0 &&
      /^[0-9a-f]{64}$/.test(row[7]) && /^[0-9a-f]{64}$/.test(row[8]), 'panel_calendar')
    fixedPath(row[5]); previous = at; previousBlock = BigInt(row[1])
  }
  check(same(plan.collectionOrder, [58, ...Array.from({ length: 58 }, (_, i) => i)]) &&
    plan.newJobCount === 59 && plan.allPairCount === 60 && plan.existingNativePairIndex === 59 &&
    same(plan.splits, ['fit', 'calibration', 'holdout'].map((label, i) => ({ label,
      firstIndex: i * 40, lastIndex: i * 40 + 39, endpoints: 40, pairs: 20,
      fromAt: plan.panelPoints[i * 40][3], toAt: plan.panelPoints[i * 40 + 39][3] }))), 'panel_splits')
}


/** Widening is keyed by the original RPC method AND closed native role, never by response contents. */
export function morphoV2IdleHeaderBackfillResponseCap(request, role) {
  check(request && typeof role === 'string' && Array.isArray(request.params), 'role_request')
  const header = role === 'fresh_finalized' || /^(?:current|anchor_[01]):header_(?:before|after)$/.test(role)
  if (header) {
    check(request.method === 'eth_getBlockByNumber' && request.params.length === 2 && request.params[1] === false &&
      (role === 'fresh_finalized' ? request.params[0] === 'finalized' : /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(request.params[0])), 'header_role_method')
    return P.headerResponse
  }
  const match = /^(?:current|anchor_[01]):(chain|vault_code|asset_code|owner_code|asset|share_decimals|asset_decimals|liquidity_adapter|liquidity_data|idle_cash|total_assets|total_supply|actual_owner_shares|fixed_stock_preview)$/.exec(role)
  const method = match?.[1] === 'chain' ? 'eth_chainId' : /_code$/.test(match?.[1] ?? '') ? 'eth_getCode' : 'eth_call'
  check(match && request.method === method, 'nonheader_role_method')
  return P.response
}
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key))
const dense = (value, length) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
  value.length === length && Object.keys(value).length === length && value.every((_, i) => Object.hasOwn(value, i))

export function createMorphoV2IdleHeaderBackfillControl(
  origins,
  {
    fetcher = globalThis.fetch,
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
    deadline = start + P.deadline
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
  const timer = setTimer(() => stop('global_deadline'), P.deadline)
  const physicalFetch = async (url, options) => {
    const o = origins.find((o) => o.url === url)
    check(o && !closed && !options.signal?.aborted, 'closed_or_origin_or_aborted')
    const entered = monotonic()
    if (!windows.has(o.host)) windows.set(o.host, entered + 12000)
    while (true) {
      const clock = monotonic(),
        limit = Math.min(deadline, windows.get(o.host))
      if (closed || clock >= limit || ledger.length >= P.starts) {
        stop('start_budget')
        throw Error('morpho_v2_idle_header_backfill_start_budget')
      }
      if (options.signal?.aborted) {
        stop('upstream_aborted')
        throw Error('morpho_v2_idle_header_backfill_upstream_aborted')
      }
      const wait = (lastStart.get(o.host) ?? -Infinity) + 250 - clock
      if (wait <= 0) break
      await pace(Math.ceil(wait))
      // Early wakeups must recheck the monotonic spacing; a stalled injected clock cannot spin.
      check(monotonic() > clock, 'pacing_clock_unavailable')
    }
    const at = monotonic(),
      limit = Math.min(deadline, windows.get(o.host))
    if (closed || at >= limit || ledger.length >= P.starts) {
      stop('start_budget')
      throw Error('morpho_v2_idle_header_backfill_start_budget')
    }
    if (options.signal?.aborted) {
      stop('upstream_aborted')
      throw Error('morpho_v2_idle_header_backfill_upstream_aborted')
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
    const responseCap = morphoV2IdleHeaderBackfillResponseCap(request, options.nativeRole)
    const controller = new AbortController(),
      id = ledger.length + 1
    const row = {
      physicalId: id,
      host: o.host,
      stage,
      request,
      nativeRole: options.nativeRole,
      stageDeadlineElapsedMs: limit - start,
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
            check(length <= responseCap, 'response_cap')
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
        check(totalBytes <= P.rawAggregate, 'ledger_cap')
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
        throw Error('morpho_v2_idle_header_backfill_provider_unavailable')
      } finally {
        controllers.delete(controller)
        options.signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', cancelStream)
        // Separate append-only, individually sealed evidence; never mutates a sealed capture.
        settlementReceipts.push(
          freeze(
            seal({
              schema: 'morpho_v2_idle_header_backfill_physical_settlement_v1',
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
              reject(Error('morpho_v2_idle_header_backfill_read_timeout'))
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
    if (closed) return Promise.reject(Error('morpho_v2_idle_header_backfill_closed'))
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

export function verifyMorphoV2IdleHeaderBackfillControl(receipt, requests, settlements, namespace) {
  check(
    receipt.pendingSettlements === 0 &&
      receipt.failure === null &&
      receipt.physicalStarts === receipt.ledger.length &&
      receipt.ledger.length === requests.length &&
      settlements.length === requests.length,
    'control_complete',
  )
  const utc = (value) =>
    typeof value === 'string' &&
    Number.isSafeInteger(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  check(
    utc(receipt.startedAtUtc) &&
      utc(receipt.availableAtUtc) &&
      Date.parse(receipt.startedAtUtc) <= Date.parse(receipt.availableAtUtc) &&
      Number.isFinite(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0 &&
      receipt.elapsedMs <= P.deadline,
    'control_clock',
  )
  const priorStarts = new Map(), stageFirstStarts = new Map()
  let previousCompleted = -Infinity
  check(receipt.ledger.length <= P.plannedStarts && new Set(requests.map((x) => x.rpcId)).size === requests.length, 'control_dispatch_count')
  for (const [index, row] of receipt.ledger.entries()) {
    const stageKey = row.stage + '\0' + row.host
    if (!stageFirstStarts.has(stageKey)) stageFirstStarts.set(stageKey, row.startedElapsedMs)
    check(HOSTS.includes(row.host) && row.physicalId === index + 1 && row.startedElapsedMs >= previousCompleted &&
      Number.isFinite(row.stageDeadlineElapsedMs) && row.completedElapsedMs < row.stageDeadlineElapsedMs &&
      row.stageDeadlineElapsedMs <= stageFirstStarts.get(stageKey) + P.stage &&
      row.completedElapsedMs - stageFirstStarts.get(stageKey) <= P.stage, 'control_stage_or_serial_clock')
    previousCompleted = row.completedElapsedMs
    check(
      utc(row.startedAtUtc) &&
        utc(row.completedAtUtc) &&
        row.startedAtUtc >= receipt.startedAtUtc &&
        row.startedAtUtc <= row.completedAtUtc &&
        row.completedAtUtc <= receipt.availableAtUtc &&
        Number.isFinite(row.startedElapsedMs) &&
        Number.isFinite(row.completedElapsedMs) &&
        row.startedElapsedMs >= 0 &&
        row.completedElapsedMs >= row.startedElapsedMs &&
        row.completedElapsedMs - row.startedElapsedMs <= 8000 &&
        row.completedElapsedMs <= receipt.elapsedMs &&
        row.startedElapsedMs - (priorStarts.get(row.host) ?? -Infinity) >= 250,
      'native_row_clock',
    )
    priorStarts.set(row.host, row.startedElapsedMs)
    const req = requests.find(
        (x) => x.physicalId === row.physicalId && x.controlNamespace === namespace,
      ),
      commitment = receipt.terminalCommitments.filter((x) => x.physicalId === row.physicalId),
      settlement = settlements.filter((x) => x.physicalId === row.physicalId)
    check(
      req && req.key === row.nativeRole && req.host === row.host &&
        commitment.length === 1 &&
        settlement.length === 1 &&
        commitment[0].rowSha256 === sha(JSON.stringify(row)),
      'raw_row_join',
    )
    const { sha256, ...body } = settlement[0]
    check(
      sha(JSON.stringify(body)) === sha256 && same(settlement[0].observation, row),
      'settlement_join',
    )
    const request = Buffer.from(req.requestBodyBase64, 'base64'),
      response = Buffer.from(row.rawBodyBase64 ?? '', 'base64')
    check(
      request.toString('base64') === req.requestBodyBase64 &&
        response.toString('base64') === row.rawBodyBase64 &&
        sha(request) === req.requestBodySha256 &&
        same(parseUsd3HypotheticalJson(request.toString()), row.request) &&
        response.length === row.bodyBytes &&
        response.length <= morphoV2IdleHeaderBackfillResponseCap(row.request, row.nativeRole) &&
        sha(response) === row.bodySha256 &&
        row.accepted === true &&
        row.status === 'success',
      'native_raw_join',
    )
    const envelope = parseUsd3HypotheticalJson(response.toString('utf8'))
    check(
      envelope.jsonrpc === '2.0' &&
        envelope.id === row.request.id &&
        !Object.hasOwn(envelope, 'error'),
      'native_envelope',
    )
  }
  return true
}

export function assertMorphoV2IdleHeaderBackfillRawPrivacy(value, secrets) {
  check(
    Array.isArray(secrets) &&
      Object.getPrototypeOf(secrets) === Array.prototype &&
      secrets.length <= 128 &&
      Object.getOwnPropertySymbols(secrets).length === 0,
    'privacy_tokens',
  )
  const tokenDescriptors = Object.getOwnPropertyDescriptors(secrets)
  check(
    Object.keys(tokenDescriptors).length === secrets.length + 1 &&
      Object.values(tokenDescriptors).every((d) => Object.hasOwn(d, 'value')),
    'privacy_tokens',
  )
  secrets = Array.from({ length: secrets.length }, (_, i) => {
    const d = tokenDescriptors[i]
    check(
      d?.enumerable &&
        typeof d.value === 'string' &&
        d.value.length > 0 &&
        Buffer.byteLength(d.value) <= 65536,
      'privacy_token',
    )
    return d.value
  })
  let nodes = 0,
    bytes = 0
  const ancestors = new WeakSet()
  const scan = (s) => {
    bytes += Buffer.byteLength(s)
    check(bytes <= 32 * MB && !secrets.some((x) => s.includes(x)), 'credential_echo')
  }
  const visit = (v, key = '', depth = 0) => {
    check(++nodes <= 100000 && depth <= 32, 'privacy_bounds')
    if (v === null || typeof v === 'boolean') return
    if (typeof v === 'number') {
      check(Number.isFinite(v), 'privacy_number')
      return
    }
    if (typeof v === 'string') {
      scan(v)
      if (/base64$/i.test(key)) {
        const b = Buffer.from(v, 'base64')
        check(b.length <= P.headerResponse && b.toString('base64') === v, 'privacy_raw')
        const s = b.toString('utf8')
        check(Buffer.from(s).equals(b), 'privacy_utf8')
        scan(s)
        let parsed
        try {
          parsed = JSON.parse(s)
        } catch {
          check(!s.includes('\\'), 'privacy_escaped_malformed')
          return
        }
        visit(parsed, '', depth + 1)
      }
      return
    }
    check(v && typeof v === 'object' && !ancestors.has(v), 'privacy_object')
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v),
      ds = Object.getOwnPropertyDescriptors(v)
    check(
      (array ? proto === Array.prototype : proto === Object.prototype || proto === null) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.values(ds).every((d) => Object.hasOwn(d, 'value')),
      'privacy_descriptor',
    )
    ancestors.add(v)
    try {
      if (array) {
        check(Object.keys(ds).length === v.length + 1, 'privacy_array')
        for (let i = 0; i < v.length; i++) visit(ds[i].value, '', depth + 1)
      } else
        for (const [k, d] of Object.entries(ds)) {
          check(d.enumerable, 'privacy_enumerable')
          scan(k)
          visit(d.value, k, depth + 1)
        }
    } finally {
      ancestors.delete(v)
    }
  }
  visit(value)
  scan(JSON.stringify(value))
  return true
}

export function assertMorphoV2IdleHeaderBackfillPrivacy(value, secrets) {
  // The shared descriptor walk checks raw body Base64 and parses JSON before examining escaped keys.
  assertMorphoV2IdleHeaderBackfillRawPrivacy(value, secrets)
  let count = 0
  const visit = (input, depth = 0, key = '') => {
    check(++count <= 100000 && depth <= 32, 'privacy_bounds')
    if (typeof input === 'string') {
      // Revisit the decoded original body with the same escape walk; the raw scan alone is insufficient.
      if (/base64$/i.test(key)) {
        const body = Buffer.from(input, 'base64')
        check(body.length <= P.headerResponse && body.toString('base64') === input, 'privacy_raw')
        const text = body.toString('utf8')
        check(Buffer.from(text).equals(body), 'privacy_utf8')
        visit(text, depth + 1)
      }
      // Inspect textual source escapes without executing source or invoking its descriptors.
      const decoded = input.replace(/\\+(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2}))/gi,
        (_match, wide, unicode, byte) => {
          const point = Number.parseInt(wide ?? unicode ?? byte, 16)
          return point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'
        })
      if (decoded !== input) assertMorphoV2IdleHeaderBackfillRawPrivacy(decoded, secrets)
      if (input.includes('\\')) {
        let parsed
        try { parsed = parseUsd3HypotheticalJson(input) } catch { return }
        assertMorphoV2IdleHeaderBackfillRawPrivacy(parsed, secrets)
        visit(parsed, depth + 1)
      }
    } else if (input && typeof input === 'object')
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input)))
        if (Object.hasOwn(descriptor, 'value')) visit(descriptor.value, depth + 1, name)
  }
  visit(value)
  return true
}

/** Lossless original-controller fields; raw bytes are stored once WHEN PRESENT.
 * A null rawBodyBase64 preserves the controller's missing capture, including oversized-body rejection.
 * This codec grants no native evidence or execution authority. */
export const HEADER_BACKFILL_ROW_STORAGE_SCHEMA = 'morpho_v2_idle_header_backfill_lossless_row_v1'
export const HEADER_BACKFILL_ROW_STORAGE_POLICY = Object.freeze({
  rawResponseBytes: 65536, headerResponseBytes: 262144, aggregateRawResponseBytes: 3 * 1024 * 1024,
  maximumRetainedAggregateRawResponseBytes: 3 * 1024 * 1024 + 262144,
  encodedRowOverheadBytes: 8192,
})
const storageSha = (value) => createHash('sha256').update(value).digest('hex')
const storageCheck = (ok, code) => { if (!ok) throw Error('morpho_v2_idle_header_backfill_storage_' + code) }
const STORAGE_HASH = /^[0-9a-f]{64}$/
const ROW_FLAGS = Object.freeze({
  researchOnly: true, authenticated: false, originalAuthority: false,
  historicalOwnership: false, currentWalletControl: false, profileApproval: false,
  sourceImplementationEquivalence: false, holderExecutableExit: false,
  forecastEligibility: false, calibrated: false, coveragePromotion: false, competingMRaw: null,
})
/** Descriptor validation precedes copying; string and object insertion order are retained. */
function storageCopyJson(value) {
  const ancestors = new WeakSet()
  let nodes = 0
  const visit = (v, depth = 0) => {
    storageCheck(++nodes <= 10000 && depth <= 32, 'json_bounds')
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
    if (typeof v === 'number') { storageCheck(Number.isFinite(v), 'json_number'); return v }
    storageCheck(v && typeof v === 'object' && !ancestors.has(v), 'json_value')
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    storageCheck((array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null) &&
      Object.getOwnPropertySymbols(v).length === 0 &&
      Object.values(descriptors).every((d) => Object.hasOwn(d, 'value')), 'json_descriptor')
    ancestors.add(v)
    const out = array ? [] : {}
    try {
      if (array) {
        storageCheck(Object.keys(descriptors).length === v.length + 1, 'json_array')
        for (let i = 0; i < v.length; i++) {
          storageCheck(descriptors[i]?.enumerable, 'json_array')
          out.push(visit(descriptors[i].value, depth + 1))
        }
      } else for (const [key, descriptor] of Object.entries(descriptors)) {
        storageCheck(descriptor.enumerable, 'json_enumerable')
        // defineProperty retains a literal __proto__ JSON key without changing the prototype.
        Object.defineProperty(out, key, { value: visit(descriptor.value, depth + 1),
          enumerable: true, writable: true, configurable: true })
      }
      return out
    } finally { ancestors.delete(v) }
  }
  return visit(value)
}
const storageKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every((k) => Object.hasOwn(value, k))
const storageJsonSha = (value) => storageSha(JSON.stringify(value))
export function serializeHeaderBackfillStorageValue(value) {
  return Buffer.from(JSON.stringify(value) + '\n')
}
function storageBindingFor(context) {
  storageCheck(context && typeof context.namespace === 'string' &&
    /^historical-owner-native-[a-zA-Z0-9-]{1,80}$/.test(context.namespace) &&
    Number.isSafeInteger(context.physicalId) && context.physicalId > 0 && context.physicalId <= 100 &&
    Object.hasOwn(context, 'source'), 'binding')
  const source = storageCopyJson(context.source)
  storageCheck(source === null || (source.chainId === 1 && /^0x[0-9a-f]{64}$/.test(source.blockHash)), 'source')
  return { namespace: context.namespace, physicalId: context.physicalId, sourceSha256: storageJsonSha(source) }
}
function storageRawBytes(observation) {
  storageCheck(observation && Object.hasOwn(observation, 'rawBodyBase64'), 'missing_raw_field')
  const raw = observation.rawBodyBase64
  const cap = morphoV2IdleHeaderBackfillResponseCap(observation.request, observation.nativeRole)
  if (raw === null) return 0
  storageCheck(typeof raw === 'string', 'raw_type')
  const bytes = Buffer.from(raw, 'base64')
  storageCheck(bytes.toString('base64') === raw && bytes.length <= cap &&
    raw.length === 4 * Math.ceil(bytes.length / 3) &&
    bytes.length === observation.bodyBytes && storageSha(bytes) === observation.bodySha256, 'raw_body')
  return bytes.length
}
function storageValidateRow(row, binding) {
  storageCheck(row && row.namespace === binding.namespace && row.physicalId === binding.physicalId &&
    row.observation?.physicalId === binding.physicalId && Object.hasOwn(row, 'request') &&
    Object.hasOwn(row, 'settlement') && Object.entries(ROW_FLAGS).every(([key, value]) => row[key] === value), 'row_binding')
  storageRawBytes(row.observation)
  if (row.request !== null)
    storageCheck(row.request.controlNamespace === binding.namespace && row.request.physicalId === binding.physicalId && row.request.key === row.observation.nativeRole,
      'request_binding')
  if (row.settlement !== null) {
    storageCheck(row.settlement.physicalId === binding.physicalId && row.settlement.captureAcceptance === false &&
      JSON.stringify(row.settlement.observation) === JSON.stringify(row.observation), 'settlement_observation_equality')
    const { sha256, ...body } = row.settlement
    storageCheck(STORAGE_HASH.test(sha256) && storageJsonSha(body) === sha256, 'settlement_seal')
  }
}
const storageRawReference = (binding, observation) => ({
  storageReference: 'row.observation.rawBodyBase64', ...binding,
  rawBodySha256: observation.bodySha256,
})
export function headerBackfillEncodedRowOverheadBytes(encoded) {
  const blank = storageCopyJson(encoded)
  storageCheck(blank.row?.observation && Object.hasOwn(blank.row.observation, 'rawBodyBase64'), 'missing_raw_field')
  const raw = blank.row.observation.rawBodyBase64
  storageCheck(typeof raw === 'string' || raw === null, 'raw_type')
  // A missing controller capture is literal null metadata, so its bytes belong to overhead.
  if (typeof raw === 'string') blank.row.observation.rawBodyBase64 = ''
  return serializeHeaderBackfillStorageValue(blank).length
}
export function encodeHeaderBackfillNativeRow(original, context) {
  const row = storageCopyJson(original), binding = storageBindingFor(context)
  storageValidateRow(row, binding)
  const originalRowJsonSha256 = storageJsonSha(row), originalObservationJsonSha256 = storageJsonSha(row.observation)
  const originalSettlementJsonSha256 = storageJsonSha(row.settlement)
  if (row.settlement !== null) {
    // Equality was proved above. Replacing this existing key preserves its exact insertion position.
    row.settlement.observation.rawBodyBase64 = storageRawReference(binding, row.observation)
  }
  const body = {
    schema: HEADER_BACKFILL_ROW_STORAGE_SCHEMA, binding,
    originalRowJsonSha256, originalObservationJsonSha256, originalSettlementJsonSha256, row,
  }
  const encoded = { ...body, sha256: storageJsonSha(body) }
  storageCheck(headerBackfillEncodedRowOverheadBytes(encoded) <= HEADER_BACKFILL_ROW_STORAGE_POLICY.encodedRowOverheadBytes,
    'encoded_overhead')
  return encoded
}
/** Expected commitments come from the original control/settlements, never from the stored row itself. */
export function decodeHeaderBackfillNativeRow(supplied, expected) {
  const encoded = storageCopyJson(supplied), binding = storageBindingFor(expected)
  storageCheck(storageKeys(encoded, ['schema', 'binding', 'originalRowJsonSha256', 'originalObservationJsonSha256',
    'originalSettlementJsonSha256', 'row', 'sha256']) && encoded.schema === HEADER_BACKFILL_ROW_STORAGE_SCHEMA &&
    JSON.stringify(encoded.binding) === JSON.stringify(binding), 'schema_or_binding')
  const { sha256, ...body } = encoded
  storageCheck(STORAGE_HASH.test(sha256) && storageJsonSha(body) === sha256 &&
    STORAGE_HASH.test(expected.rowJsonSha256) && STORAGE_HASH.test(expected.observationJsonSha256) && STORAGE_HASH.test(expected.settlementJsonSha256) &&
    encoded.originalRowJsonSha256 === expected.rowJsonSha256 &&
    encoded.originalObservationJsonSha256 === expected.observationJsonSha256 &&
    encoded.originalSettlementJsonSha256 === expected.settlementJsonSha256, 'storage_or_expected_commitment')
  const row = encoded.row
  if (row.settlement !== null) {
    storageCheck(JSON.stringify(row.settlement?.observation?.rawBodyBase64) ===
      JSON.stringify(storageRawReference(binding, row.observation)), 'raw_reference')
    row.settlement.observation.rawBodyBase64 = row.observation.rawBodyBase64
  }
  storageValidateRow(row, binding)
  storageCheck(storageJsonSha(row) === encoded.originalRowJsonSha256 &&
    storageJsonSha(row.observation) === encoded.originalObservationJsonSha256 &&
    storageJsonSha(row.settlement) === encoded.originalSettlementJsonSha256, 'restored_commitment')
  storageCheck(headerBackfillEncodedRowOverheadBytes(supplied) <= HEADER_BACKFILL_ROW_STORAGE_POLICY.encodedRowOverheadBytes,
    'encoded_overhead')
  return row
}
export function headerBackfillEncodedRawResponseBytes(encoded) {
  return storageRawBytes(encoded.row?.observation)
}

/** A transport lifecycle remains pending until native body cancellation has settled. */
export function createMorphoV2IdleHeaderBackfillNativeTransport(origins, { fetcher = globalThis.fetch,
  clock = () => performance.now(), deadline } = {}) {
  check(typeof fetcher === 'function' && Number.isFinite(deadline), 'transport_options')
  const active = new Set(), ledger = []
  let stopped = false
  const stop = () => { stopped = true; for (const entry of active) entry.controller.abort() }
  const wrappedFetch = async (input, options) => {
    const origin = origins.find((x) => x.url === input)
    check(origin && !stopped && clock() < deadline && !options.signal?.aborted && ledger.length < P.starts && active.size === 0,
      'transport_dispatch_bound')
    const request = parseUsd3HypotheticalJson(options.body), responseCap = morphoV2IdleHeaderBackfillResponseCap(request, options.nativeRole)
    const { nativeRole, ...nativeOptions } = options
    const controller = new AbortController(), signal = options.signal
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    let resolveSettled
    const settled = new Promise((r) => { resolveSettled = r })
    const row = { physicalStart: ledger.length + 1, host: origin.host, startedAtMs: clock(),
      completedAtMs: null, responseRedirected: null, bodyBytes: 0, status: 'pending' }
    const entry = { controller, settled }; active.add(entry); ledger.push(row)
    let reader, responseBody = null, cancellationPromise, completionPromise
    const cancelBody = () => {
      if (cancellationPromise) return cancellationPromise
      // An abort before HTTP response arrival must not mark a future body already canceled.
      if (!reader && !responseBody) return undefined
      const retainedReader = reader, retainedBody = responseBody
      cancellationPromise = Promise.resolve().then(() => retainedReader ? retainedReader.cancel() : retainedBody.cancel())
        .then(() => undefined, () => undefined)
      return cancellationPromise
    }
    const complete = () => {
      if (completionPromise) return completionPromise
      completionPromise = (async () => {
        controller.abort(); await cancelBody()
        signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', cancelBody)
        if (reader) { try { reader.releaseLock() } catch {} }
        row.completedAtMs = clock(); active.delete(entry); resolveSettled()
      })()
      return completionPromise
    }
    controller.signal.addEventListener('abort', cancelBody, { once: true })
    try {
      const response = await fetcher(input, { ...nativeOptions, signal: controller.signal })
      responseBody = response.body; row.responseRedirected = response.redirected
      check(response.redirected === false && (!response.url || new URL(response.url).hostname === origin.host),
        'transport_redirect_or_host')
      check(!controller.signal.aborted && !stopped && clock() < deadline && responseBody, 'transport_response_deadline')
      const length = response.headers.get('content-length')
      check(length === null || /^\d+$/.test(length) && Number(length) <= responseCap, 'transport_declared_body_bound')
      reader = responseBody.getReader()
      const body = new ReadableStream({
        async pull(destination) {
          try {
            const chunk = await reader.read()
            check(!controller.signal.aborted && !stopped && clock() < deadline, 'transport_body_deadline')
            if (chunk.done) { row.status = 'body_drained'; await complete(); destination.close(); return }
            row.bodyBytes += chunk.value.byteLength
            check(row.bodyBytes <= responseCap, 'transport_body_bound')
            destination.enqueue(chunk.value)
          } catch (error) { row.status = 'failed'; await complete(); destination.error(error) }
        },
        async cancel() { row.status = row.status === 'body_drained' ? row.status : 'body_canceled'; await complete() },
      }, { highWaterMark: 0 })
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected },
        type: { value: response.type } })
      return wrapped
    } catch (error) { row.status = 'failed'; await complete(); throw error }
  }
  return { fetcher: wrappedFetch, stop, settle: async () => { await Promise.all([...active].map((x) => x.settled)) },
    summary: () => freeze({ physicalStarts: ledger.length, pendingBodies: active.size,
      maximumLiveBodies: 1, cancellationAwaited: true,
      responseRedirected: ledger.map((x) => x.responseRedirected),
      failedPhysicalStarts: ledger.filter((x) => x.status === 'failed').map((x) => x.physicalStart),
      allNativeBodiesSettled: ledger.every((x) => x.completedAtMs !== null),
      nativeBodyBytes: ledger.reduce((n, x) => n + x.bodyBytes, 0) }) }
}

/** Missing roles remain censored; individually paired observations are retained without granting a join. */
export function morphoV2IdleHeaderBackfillPointStatuses(prepared, traces, points, currentSource, failure) {
  return ['current', 'anchor_0', 'anchor_1'].map((label, index) => {
    const anchor = index === 0 ? null : prepared.plan.anchors[index - 1]
    const source = index === 0 ? currentSource : anchor.source
    const observed = points.find((x) => x.label === label)
    const specs = source ? morphoV2IdleHeaderBackfillPointReadPlan(label, source, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK) : []
    const roles = specs.map((spec) => {
      const rows = HOSTS.map((host) => traces.find((x) => x.host === host && x.key === spec.key))
      let pairedValue = null
      if (rows.every(Boolean)) try {
        const raw = spec.method === 'eth_getBlockByNumber' ? pairedHeader(traces, spec) : paired(traces, spec)
        pairedValue = spec.method === 'eth_call' ? decodeMorphoV2IdleHeaderBackfillResult(spec.name, raw)
          : spec.method === 'eth_getCode' ? runtime(raw) : raw
      } catch {}
      return { key: spec.key, physicalIds: rows.filter(Boolean).map((x) => x.physicalId),
        pairedObservationRetained: pairedValue !== null, pairedValue }
    })
    const reason = failure ?? 'morpho_v2_idle_header_backfill_native_point_unavailable'
    return { label, panelIndex: anchor?.panelIndex ?? null, source, expectedCashRaw: anchor?.expectedCashRaw ?? null,
      status: observed ? observed.qualifiedNativeJoin ? observed.panelOutcome : 'censored_native_configuration_or_stock'
        : 'censored_native_read_unavailable',
      censorReasons: observed ? observed.qualificationReasons : [reason],
      nativeJoinMeasured: Boolean(observed), eligibleFixedStockEndpoint: Boolean(observed?.qualifiedNativeJoin),
      roles, frozenProbeSharesRaw: MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK, historicalOwnedEntitlementAssetRaw: null, ...FLAGS }
  })
}

/** Job-local planning only: exact endpoint timestamps, strictly earlier donors, no continuous-duration claim. */
export function morphoV2IdleHeaderBackfillChronologicalRows(prepared, points) {
  const observed = new Map(prepared.plan.anchors.map((anchor, i) => [anchor.panelIndex,
    points.find((x) => x.label === 'anchor_' + i)]))
  return prepared.plan.anchors.map((anchor) => {
    const issueAt = Date.parse(anchor.source.blockTime), targetAt = issueAt + MORPHO_V2_IDLE_HEADER_BACKFILL_HORIZON_MS
    const targetIndex = prepared.plan.panelPoints.findIndex((row) => Date.parse(row[3]) === targetAt)
    const issue = observed.get(anchor.panelIndex), target = observed.get(targetIndex)
    const donors = prepared.plan.anchors.filter((x) => Date.parse(x.source.blockTime) < issueAt &&
      observed.get(x.panelIndex)?.qualifiedNativeJoin).map((x) => x.panelIndex)
    // A donor needs both endpoints. One prior native point is a cold start, never a rate.
    const strictlyEarlierDonorIntervals = donors.slice(1).map((index, i) => [donors[i], index])
    return { panelIndex: anchor.panelIndex, issueAtUtc: anchor.source.blockTime, targetAtUtc: utc(targetAt),
      targetPanelIndex: targetIndex < 0 ? null : targetIndex,
      actualTargetDeltaMs: targetIndex < 0 ? null : Date.parse(prepared.plan.panelPoints[targetIndex][3]) - issueAt,
      issueStatus: issue?.qualifiedNativeJoin ? 'native_endpoint_observed' : 'native_endpoint_censored',
      labelStatus: targetIndex < 0 ? 'exact_H24_target_not_in_catalog'
        : target?.qualifiedNativeJoin ? 'exact_H24_native_endpoint_observed' : 'exact_H24_native_endpoint_unavailable',
      strictlyEarlierDonorIntervals, coldStart: strictlyEarlierDonorIntervals.length === 0,
      endpointCapacityAssetRaw: target?.qualifiedNativeJoin
        ? String(BigInt(target.CAssetRaw) < BigInt(target.probeEaAssetRaw) ? BigInt(target.CAssetRaw) : BigInt(target.probeEaAssetRaw)) : null,
      measuredOutcomesAreEndpointOnly: true, continuousDurationMeasured: false, interpolation: false, ...FLAGS }
  })
}

const preparedInstances = new WeakSet()
export const MORPHO_V2_IDLE_HEADER_BACKFILL_POLICY = Object.freeze({
  starts: 100, plannedStarts: 98, deadline: 60000, acquisitionDeadline: 55000, retentionReserve: 5000,
  stage: 12000, timeout: 8000,
  spacing: 250, workers: 1, retries: 0, response: 65536, headerResponse: 262144, file: MB,
  cohort: 6 * MB, source: 6 * MB, report: 32768, terminal: 65536,
  rawAggregate: 3 * MB, retainedRawAggregate: 3 * MB + 262144,
  rowOverhead: 8192, fixedStorage: 256 * 1024, controlSummary: 65536,
  files: 131, allocationUnit: 4096, fileAllocationMargin: 8192,
  allocationSlack: 3 * MB, directoryAllocationMargin: 8192,
  pre: 265 * MB, reserve: 256 * MB,
})
export const MORPHO_V2_IDLE_HEADER_BACKFILL_FLAGS = Object.freeze({
  researchOnly: true, authenticated: false, originalAuthority: false,
  historicalOwnership: false, currentWalletControl: false, profileApproval: false,
  sourceImplementationEquivalence: false, holderExecutableExit: false,
  forecastEligibility: false, calibrated: false, coveragePromotion: false, competingMRaw: null,
  executionAuthority: false, forecastAuthority: false, calibratedProbability: false, MRaw: null,
})
// The lossless immutable codec has its own narrower flags; extra flags remain on reports and facts.
const STORAGE_FLAGS = Object.freeze(Object.fromEntries(Object.entries(MORPHO_V2_IDLE_HEADER_BACKFILL_FLAGS).slice(0, 12)))
export const MORPHO_V2_IDLE_HEADER_BACKFILL_ABI = freeze(parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
]))
const P = MORPHO_V2_IDLE_HEADER_BACKFILL_POLICY, FLAGS = MORPHO_V2_IDLE_HEADER_BACKFILL_FLAGS
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const check = (ok, reason) => { if (!ok) throw Error('morpho_v2_idle_header_backfill_' + reason) }
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const utc = (time) => new Date(time).toISOString()
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function fixedPath(relative) {
  check(typeof relative === 'string' && !relative.startsWith('/') && !relative.includes('..') &&
    !relative.includes('\\') && !relative.includes('://'), 'fixed_path')
  const path = resolve(ROOT, relative)
  let parent = dirname(path)
  while (parent !== ROOT) {
    const s = lstatSync(parent)
    check(parent.startsWith(ROOT + '/') && s.isDirectory() && !s.isSymbolicLink(), 'parent_identity')
    parent = dirname(parent)
  }
  return path
}
function backfillInputPath(path) {
  if (typeof path === 'string' && path.startsWith(ROOT + '/data/research/venue-signals/')) return fixedPath(path.slice(ROOT.length + 1))
  if (typeof path === 'string' && path.startsWith('/private/tmp/')) {
    check(/^\/private\/tmp\/morpho-v2-idle-parent-payloads-[a-f0-9-]{36}\/failed-slots\.json$/.test(path) ||
      /^\/private\/tmp\/morpho-v2-idle-panel-pair(?:[0-9]|[1-5][0-9])-native-parent-oct10-[a-f0-9-]{36}-proof\.json$/.test(path), 'private_input_path')
    let parent = dirname(path)
    while (parent !== '/private') {
      const before = lstatSync(parent)
      check(before.isDirectory() && !before.isSymbolicLink(), 'private_input_parent')
      parent = dirname(parent)
    }
    return path
  }
  return fixedPath(path)
}
function readBytes(path, cap, budget = { bytes: 0, maximum: P.cohort }, privateFile = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    check(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(cap) &&
      budget.bytes + Number(before.size) <= budget.maximum &&
      (!privateFile || (before.mode & 0o777n) === 0o600n), 'read_size_mode_link')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let used = 0
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null)
      if (!n) break
      used += n; check(used <= cap, 'read_cap')
    }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true })
    check(named.isFile() && !named.isSymbolicLink() && after.nlink === 1n && named.nlink === 1n &&
      BigInt(used) === after.size && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) =>
        before[key] === after[key] && after[key] === named[key]) &&
      (!privateFile || (named.mode & 0o777n) === 0o600n), 'read_identity')
    budget.bytes += used
    return bytes.subarray(0, used)
  } finally { closeSync(fd) }
}
function readPin(pin, budget) {
  check(pin && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && /^[0-9a-f]{64}$/.test(pin.fileSha256), 'pin')
  const bytes = readBytes(backfillInputPath(pin.path), Math.min(pin.bytes, P.file), budget, pin.private === true || pin.path.startsWith('/private/tmp/') || pin.path.startsWith(ROOT + '/data/research/venue-signals/'))
  check(bytes.length === pin.bytes && sha(bytes) === pin.fileSha256, 'file_pin')
  return bytes
}
function sealedJson(bytes) {
  const value = parseUsd3HypotheticalJson(bytes.toString('utf8')), { sha256, ...body } = value
  check(typeof sha256 === 'string' && sha(JSON.stringify(body)) === sha256, 'body_seal')
  return value
}
function freeBytes() {
  const disk = statfsSync(ROOT, { bigint: true })
  check(disk.bsize > 0n && disk.bsize <= BigInt(P.allocationUnit) &&
    BigInt(P.allocationUnit) % disk.bsize === 0n, 'disk_allocation_unit')
  return disk.bavail * disk.bsize
}
const rounded = (n) => Math.ceil(n / P.allocationUnit) * P.allocationUnit
export function assertMorphoV2IdleHeaderBackfillDiskCapacity(free, bytes = 0, terminal = false, preflight = false) {
  check(typeof free === 'bigint' && free >= 0n && Number.isSafeInteger(bytes) && bytes >= 0, 'disk_shape')
  if (preflight) check(free >= BigInt(P.pre), 'disk_preflight')
  check(free >= BigInt(P.reserve + rounded(bytes) + P.fileAllocationMargin +
    (terminal ? 0 : rounded(P.terminal) + P.fileAllocationMargin)), 'disk_reserve')
  return true
}
function guard(bytes = 0, terminal = false, preflight = false) {
  return assertMorphoV2IdleHeaderBackfillDiskCapacity(freeBytes(), bytes, terminal, preflight)
}
function header(value) {
  check(value && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value.number) && HASH.test(value.hash) &&
    /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value.timestamp), 'header')
  return { chainId: 1, blockNumber: String(BigInt(value.number)), blockHash: value.hash,
    blockTime: utc(Number(BigInt(value.timestamp)) * 1000), finalized: true }
}
function paired(traces, spec) {
  const rows = HOSTS.map((host) => traces.filter((t) => t.host === host && t.key === spec.key))
  check(rows.every((xs) => xs.length === 1 && same(xs[0].request, spec) && xs[0].envelope &&
    !Object.hasOwn(xs[0].envelope, 'error') && Object.hasOwn(xs[0].envelope, 'result')), 'paired_request')
  check(same(rows[0][0].envelope.result, rows[1][0].envelope.result), 'paired_result')
  return rows[0][0].envelope.result
}
function pairedHeader(traces, spec) {
  const values = HOSTS.map((host) => {
    const rows = traces.filter((t) => t.host === host && t.key === spec.key)
    check(rows.length === 1 && same(rows[0].request, spec) && !rows[0].envelope.error, 'paired_header_request')
    return header(rows[0].envelope.result)
  })
  check(same(values[0], values[1]), 'paired_header')
  return values[0]
}
export function decodeMorphoV2IdleHeaderBackfillResult(name, raw) {
  check(typeof raw === 'string' && HEX.test(raw), 'ABI_bytes')
  const value = decodeFunctionResult({ abi: MORPHO_V2_IDLE_HEADER_BACKFILL_ABI, functionName: name, data: raw })
  check(encodeFunctionResult({ abi: MORPHO_V2_IDLE_HEADER_BACKFILL_ABI, functionName: name, result: value }) === raw, 'ABI_canonical')
  return typeof value === 'string' ? value.toLowerCase() : String(value)
}
const blockHeader = (key, block) => ({ key, method: 'eth_getBlockByNumber', params: [block, false] })
/** Sixteen reads per point, including both brackets and the actual historical owner balance. */
export function morphoV2IdleHeaderBackfillPointReadPlan(label, source, probeSharesRaw) {
  check(['current', 'anchor_0', 'anchor_1'].includes(label) && HASH.test(source?.blockHash) &&
    /^[1-9][0-9]*$/.test(source.blockNumber) && /^(?:0|[1-9][0-9]*)$/.test(probeSharesRaw) &&
    BigInt(probeSharesRaw) < (1n << 256n), 'point_plan')
  const pin = { blockHash: source.blockHash, requireCanonical: true }, key = (k) => label + ':' + k
  const code = (k, to) => ({ key: key(k), method: 'eth_getCode', params: [to, pin] })
  const call = (k, to, name, args = []) => ({ key: key(k), name, method: 'eth_call', params: [
    { to, data: encodeFunctionData({ abi: MORPHO_V2_IDLE_HEADER_BACKFILL_ABI, functionName: name, args }) }, pin,
  ] })
  const number = '0x' + BigInt(source.blockNumber).toString(16)
  return [
    { key: key('chain'), method: 'eth_chainId', params: [] }, blockHeader(key('header_before'), number),
    code('vault_code', SUBJECT.vault), code('asset_code', SUBJECT.asset), code('owner_code', SUBJECT.owner),
    call('asset', SUBJECT.vault, 'asset'), call('share_decimals', SUBJECT.vault, 'decimals'),
    call('asset_decimals', SUBJECT.asset, 'decimals'),
    call('liquidity_adapter', SUBJECT.vault, 'liquidityAdapter'), call('liquidity_data', SUBJECT.vault, 'liquidityData'),
    call('idle_cash', SUBJECT.asset, 'balanceOf', [SUBJECT.vault]),
    call('total_assets', SUBJECT.vault, 'totalAssets'), call('total_supply', SUBJECT.vault, 'totalSupply'),
    call('actual_owner_shares', SUBJECT.vault, 'balanceOf', [SUBJECT.owner]),
    call('fixed_stock_preview', SUBJECT.vault, 'previewRedeem', [BigInt(probeSharesRaw)]),
    blockHeader(key('header_after'), number),
  ]
}
function runtime(code) {
  check(typeof code === 'string' && HEX.test(code), 'runtime_bytes')
  return { runtimeByteLength: (code.length - 2) / 2, runtimeKeccak256: keccak256(code) }
}
/** Historical preview always remains a hypothetical fixed-current-stock conversion. */
export function deriveMorphoV2IdleHeaderBackfillPoint(traces, label, source, probeSharesRaw, expectedRuntimes, expectedCashRaw = null) {
  const specs = morphoV2IdleHeaderBackfillPointReadPlan(label, source, probeSharesRaw)
  const spec = (key) => specs.find((x) => x.key === label + ':' + key)
  const get = (key) => paired(traces, spec(key))
  check(get('chain') === '0x1' && same(pairedHeader(traces, spec('header_before')), source) &&
    same(pairedHeader(traces, spec('header_after')), source), 'point_chain_and_brackets')
  const decoded = (key) => decodeMorphoV2IdleHeaderBackfillResult(spec(key).name, get(key))
  const values = Object.fromEntries(specs.filter((x) => x.method === 'eth_call').map((x) =>
    [x.key.slice(label.length + 1), decodeMorphoV2IdleHeaderBackfillResult(x.name, paired(traces, x))]))
  const codes = { vault: get('vault_code'), asset: get('asset_code'), owner: get('owner_code') }
  const runtimes = Object.fromEntries(Object.entries(codes).map(([key, code]) => [key, runtime(code)]))
  const current = label === 'current', reasons = []
  if (values.asset !== SUBJECT.asset || values.asset_decimals !== '6' || values.share_decimals !== '18')
    reasons.push('native_identity_or_units_differ')
  if (values.liquidity_adapter !== ZERO || values.liquidity_data !== '0x') reasons.push('idle_regime_differed')
  if (['vault', 'asset'].some((key) => !same(runtimes[key], expectedRuntimes[key])))
    reasons.push('runtime_identity_differed')
  if (current && codes.owner !== '0x') reasons.push('fresh_owner_no_code_condition_differed')
  if (BigInt(probeSharesRaw) === 0n) reasons.push('zero_probe_stock')
  if (BigInt(probeSharesRaw) > BigInt(values.total_supply)) reasons.push('probe_stock_exceeds_native_supply')
  if (current && values.actual_owner_shares !== probeSharesRaw) reasons.push('fresh_stock_binding_differed')
  if (expectedCashRaw !== null && values.idle_cash !== expectedCashRaw) reasons.push('own_cash_anchor_differed')
  return freeze({
    label, ...SUBJECT, source, qualifiedNativeJoin: reasons.length === 0, qualificationReasons: reasons,
    nativeAsset: values.asset, nativeAssetDecimals: Number(values.asset_decimals),
    nativeShareDecimals: Number(values.share_decimals), liquidityAdapter: values.liquidity_adapter,
    liquidityData: values.liquidity_data,
    configurationRegimeId: sha(JSON.stringify({ adapter: values.liquidity_adapter, data: values.liquidity_data })),
    regimeKind: values.liquidity_adapter === ZERO && values.liquidity_data === '0x'
      ? 'zero_liquidity_adapter_empty_data' : 'other_native_configuration',
    LLTV: null, LLTVStatus: values.liquidity_adapter === ZERO && values.liquidity_data === '0x'
      ? 'inapplicable_idle_no_adapter' : 'unmeasured', allocation: null,
    CAssetRaw: values.idle_cash, cashAssetDecimals: Number(values.asset_decimals),
    CMeaning: 'asset.balanceOf(exact_vault)_only', cashIsTotalAssets: false, cashIsOwnedEntitlement: false,
    totalAssetsRaw: values.total_assets, totalAssetsAssetDecimals: Number(values.asset_decimals),
    totalSupplySharesRaw: values.total_supply, totalSupplyShareDecimals: Number(values.share_decimals),
    actualOwnerSharesRaw: values.actual_owner_shares, actualOwnerShareDecimals: Number(values.share_decimals),
    actualHistoricalOwnerSharesRaw: current ? null : values.actual_owner_shares,
    probeSharesRaw, probeShareDecimals: Number(values.share_decimals),
    probeEaAssetRaw: values.fixed_stock_preview, probeEaAssetDecimals: Number(values.asset_decimals),
    conversionBasis: current && values.actual_owner_shares === probeSharesRaw
      ? 'fresh_current_owner_full_stock' : 'hypothetical_fixed_current_stock_conversion',
    freshCurrentFullEaAssetRaw: current && values.actual_owner_shares === probeSharesRaw ? decoded('fixed_stock_preview') : null,
    measuredZeroCash: values.idle_cash === '0', measuredZeroEntitlement: values.fixed_stock_preview === '0',
    stockFeasibleWithinNativeSupply: BigInt(probeSharesRaw) <= BigInt(values.total_supply),
    panelOutcome: reasons.length ? 'censored_native_configuration_or_stock'
      : values.idle_cash === '0' ? 'measured_zero_cash'
      : values.fixed_stock_preview === '0' ? 'measured_zero_entitlement' : 'measured_positive_capacity',
    historicalOwnedEntitlementAssetRaw: null,
    historicalOwnedEntitlementMeasured: false,
    historicalOwnerStockEqualsProbeStock: current ? null : values.actual_owner_shares === probeSharesRaw,
    ownerCodeStatus: codes.owner === '0x' ? 'no_code' : 'code_present',
    ownerCodeRawIfEmpty: codes.owner === '0x' ? '0x' : null,
    runtimes, sourceImplementationEquivalence: false, expectedCashRaw,
    nativeReferences: specs.map((x) => ({ key: x.key, physicalIds: HOSTS.map((host) =>
      traces.find((t) => t.host === host && t.key === x.key).physicalId) })),
    ...FLAGS,
  })
}

/** Descriptors select already retained failed originals; they grant no native evidence or retries. */
export function validateMorphoV2IdleHeaderBackfillDescriptor(value, pairIndex) {
  check(keys(value, ['schema', 'ready', 'slots']) && value.schema === 'morpho_v2_idle_header_failed_slots_parent_v1' &&
    value.ready === true && Array.isArray(value.slots) && value.slots.length > 0 && value.slots.length <= 59 &&
    new Set(value.slots.map((x) => x.pairIndex)).size === value.slots.length, 'descriptor_ready')
  for (const slot of value.slots) {
    check(keys(slot, ['pairIndex', 'directory', 'files', 'proofPath']) &&
      Number.isInteger(slot.pairIndex) && slot.pairIndex >= 0 && slot.pairIndex < 59 &&
      typeof slot.directory === 'string' && dirname(slot.directory) === resolve(ROOT, 'data/research/venue-signals') &&
      /^morpho-v2-idle-history-panel-v1-[A-Za-z0-9.-]+$/.test(basename(slot.directory)) &&
      slot.files && Object.getPrototypeOf(slot.files) === Object.prototype, 'descriptor_slot')
    const rowNames = Object.keys(slot.files).filter((x) => /^native-row-(?:00[1-9]|0[1-9][0-9])\.json$/.test(x))
    check(rowNames.length === 1 && keys(slot.files, ['report.json', 'terminal.json', 'parentProof', rowNames[0]]), 'descriptor_files')
    for (const [name, pin] of Object.entries(slot.files)) {
      const expected = name === 'parentProof' ? slot.proofPath : resolve(slot.directory, name)
      check(keys(pin, ['path', 'bytes', 'sha256']) && pin.path === expected && Number.isSafeInteger(pin.bytes) &&
        pin.bytes > 0 && pin.bytes <= 1048576 && /^[0-9a-f]{64}$/.test(pin.sha256), 'descriptor_pin')
      backfillInputPath(pin.path)
    }
  }
  const selected = value.slots.find((x) => x.pairIndex === pairIndex)
  check(selected, 'descriptor_slot_missing')
  return selected
}
function loadMorphoV2IdleHeaderBackfillDescriptor(pin, pairIndex, plan, budget) {
  check(pin && keys(pin, ['path', 'bytes', 'fileSha256']) && pin.bytes > 0 && pin.bytes <= 65536 &&
    /^[0-9a-f]{64}$/.test(pin.fileSha256), 'descriptor_required')
  backfillInputPath(pin.path)
  const bytes = readPin(pin, budget), descriptor = parseUsd3HypotheticalJson(bytes.toString('utf8'))
  const entry = validateMorphoV2IdleHeaderBackfillDescriptor(descriptor, pairIndex)
  const rowName = Object.keys(entry.files).find((x) => x.startsWith('native-row-'))
  const physicalId = Number(rowName.slice(11, 14))
  const convertPin = (p) => ({ path: p.path, bytes: p.bytes, fileSha256: p.sha256 })
  const reportPin = convertPin(entry.files['report.json']), terminalPin = convertPin(entry.files['terminal.json'])
  const rowPin = convertPin(entry.files[rowName]), proofPin = convertPin(entry.files.parentProof)
  const report = sealedJson(readPin(reportPin, budget)), terminal = sealedJson(readPin(terminalPin, budget))
  const originalSummaryRefs = terminal.files.filter((x) => x.file === 'control-summary.json')
  check(originalSummaryRefs.length === 1, 'failed_summary_reference')
  const summaryPin = { path: resolve(entry.directory, 'control-summary.json'), bytes: originalSummaryRefs[0].bytes,
    fileSha256: originalSummaryRefs[0].fileSha256 }
  const summary = sealedJson(readPin(summaryPin, budget)), encoded = sealedJson(readPin(rowPin, budget))
  const proof = parseUsd3HypotheticalJson(readPin(proofPin, budget).toString('utf8'))
  check(proof.exitCode === 0 && Array.isArray(proof.pinDrift) && proof.pinDrift.length === 0 &&
    proof.result?.status === 'partial_capture_retained' && proof.result.directory === entry.directory &&
    proof.result.physicalStarts === physicalId && proof.result.qualifiedNativeJoin === false &&
    proof.result.SDKphysicalStarts === null, 'failed_parent_capture_reference')
  check(report.schema === 'morpho_v2_idle_history_panel_native_join_report_v1' && terminal.schema === 'morpho_v2_idle_history_panel_terminal_v1' &&
    summary.schema === 'morpho_v2_idle_history_panel_original_control_v1' && report.pairIndex === pairIndex && terminal.pairIndex === pairIndex &&
    same(report.panelPointIndices, [pairIndex * 2, pairIndex * 2 + 1]) &&
    report.completeNativeAcquisition === false && terminal.completeNativeAcquisition === false &&
    report.qualifiedNativeJoin === false && terminal.qualifiedNativeJoin === false && terminal.reportSha256 === report.sha256 &&
    report.physicalStarts === physicalId && terminal.physicalStarts === physicalId &&
    terminal.pendingSettlements === 0 && summary.receipt.pendingSettlements === 0 &&
    report.nativeTransport.pendingBodies === 0 && report.nativeTransport.allNativeBodiesSettled === true, 'failed_original_partial')
  const originalPins = [reportPin, terminalPin, summaryPin, rowPin, proofPin]
  for (const originalPin of [reportPin, summaryPin, rowPin]) {
    const refs = terminal.files.filter((x) => x.file === basename(originalPin.path))
    check(refs.length === 1 && refs[0].bytes === originalPin.bytes && refs[0].fileSha256 === originalPin.fileSha256, 'failed_terminal_file_join')
  }
  const summaries = summary.rows.filter((x) => x.commitments.physicalId === physicalId)
  check(summaries.length === 1 && summaries[0].file === rowName, 'failed_row_original_join')
  const row = decodeLegacyNativeRow(encoded, { namespace: summary.namespace, source: summary.source, ...summaries[0].commitments })
  const observation = row.observation, request = row.request
  check(request && /^(?:anchor_[01]):header_(?:before|after)$/.test(request.key), 'failed_header_role')
  const source = panelAnchor(plan.panelPoints[pairIndex * 2 + Number(request.key.split(':')[0].slice(-1))]).source
  check(physicalId <= 98 && terminal.acquisitionDeadlineElapsedMs === 55000 && terminal.retentionReserveMs === 5000, 'failed_original_policy')
  check(request.host === observation.host && request.physicalId === physicalId && observation.accepted === false && observation.status === 'failed' &&
    observation.httpStatus === 200 && observation.rawBodyBase64 === null && observation.bodyBytes === 65536 &&
    observation.safeCode === 'provider_unavailable' && observation.request.method === 'eth_getBlockByNumber' &&
    same(observation.request.params, ['0x' + BigInt(source.blockNumber).toString(16), false]) &&
    sha(Buffer.from(request.requestBodyBase64, 'base64')) === request.requestBodySha256 &&
    same(parseUsd3HypotheticalJson(Buffer.from(request.requestBodyBase64, 'base64').toString('utf8')), observation.request), 'failed_header_cap_observation')
  const companion = parseUsd3HypotheticalJson(readPin(plan.sharedCompanionManifestPin, budget).toString('utf8'))
  check(companion.schema === 'morpho_v2_idle_panel_shared_source_companion_v1' &&
    companion.planFileSha256 === plan.basePlanPin.fileSha256 && companion.producerFileSha256 === plan.baseProducerPin.fileSha256 &&
    companion.perJobSourceCopies === false && companion.beforeFirstPanelRpc === true, 'shared_companion_join')
  for (const sourcePin of [...plan.sourcePins.filter((x) => !plan.derivativeSourcePaths.includes(x.path)), ...plan.inputPins, ...plan.panelPoints.slice(pairIndex * 2, pairIndex * 2 + 2).map((row) => panelAnchor(row).receiptPin)]) {
    const originals = companion.files.filter((x) => x.originalPath === sourcePin.path)
    check(originals.length === 1 && originals[0].bytes === sourcePin.bytes && originals[0].fileSha256 === sourcePin.fileSha256, 'shared_source_commitment')
  }
  return { pins: [pin, ...originalPins, plan.sharedCompanionManifestPin], commitment: {
    descriptorPin: pin, pairIndex, directory: entry.directory, originalPins, failedPhysicalId: physicalId,
    failedRole: request.key, previousObservation: 'HTTP_200_at_64KiB_with_no_retained_raw_body',
    originalThrownReasonRetained: false, underlyingProviderCauseConfirmed: false, automaticRetry: false,
    sharedCompanionManifestPin: plan.sharedCompanionManifestPin } }
}
export function prepareMorphoV2IdleHeaderBackfillIdleHistory(pairIndex = 10, descriptorPin = null) {
  const budget = { bytes: 0, maximum: P.cohort }
  const planBytes = readBytes(fixedPath(MORPHO_V2_IDLE_HEADER_BACKFILL_PLAN_PATH), 131072, budget)
  check(sha(planBytes) === MORPHO_V2_IDLE_HEADER_BACKFILL_PLAN_SHA, 'plan_pin')
  const plan = parseUsd3HypotheticalJson(planBytes.toString('utf8'))
  check(plan.schema === 'morpho_v2_idle_history_header_backfill_plan_v1' && plan.revision === 1 &&
    same(plan.subject, SUBJECT) && same(plan.origins, HOSTS) && same(plan.policy, P) &&
    same(plan.anchors.map((x) => x.source), DEFAULT_ANCHORS) &&
    same(plan.anchors.map((x) => x.expectedCashRaw), ['27925379416535', '0']) &&
    plan.storage.schema === HEADER_BACKFILL_ROW_STORAGE_SCHEMA &&
    same(plan.retainedSourcePaths, RETAINED_SOURCE_PATHS) &&
    same(plan.frozenV1References, FROZEN_V1_REFERENCES) &&
    plan.historicalProbeBasis === 'hypothetical_fixed_current_stock_conversion' &&
    plan.currentPoint === 'fresh_paired_finalized_header' && plan.stationaryRegimePooling === false &&
    same(plan.responseBytePolicy, { header: P.headerResponse, other: P.response, binding: 'original_RPC_method_and_native_role' }) &&
    plan.structuralBackfill === true && plan.automaticRetry === false &&
    same(plan.backfillCollectionOrder, [10, 15, 24, 33, 34]) &&
    Object.entries(FLAGS).every(([key, value]) => plan[key] === value), 'closed_plan')
  check(Number.isInteger(pairIndex) && plan.backfillCollectionOrder.includes(pairIndex), 'failed_pair_index')
  validateMorphoV2IdleHeaderBackfillCalendar(plan)
  const descriptor = loadMorphoV2IdleHeaderBackfillDescriptor(descriptorPin, pairIndex, plan, budget)
  const selectedAnchors = plan.panelPoints.slice(pairIndex * 2, pairIndex * 2 + 2).map(panelAnchor)
  plan.anchors = selectedAnchors; plan.pairIndex = pairIndex
  const sources = plan.sourcePins.map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  check(RETAINED_SOURCE_PATHS.every((path) => sources.some((x) => x.pin.path === path)) &&
    FROZEN_V1_REFERENCES.every((pin) => sources.some((x) => same(x.pin, pin))) &&
    new Set(sources.map((x) => x.pin.path)).size === sources.length, 'source_set')
  const ownBytes = readBytes(fixedPath(SELF), P.source, budget)
  sources.push({ pin: { path: SELF, bytes: ownBytes.length, fileSha256: sha(ownBytes) }, bytes: ownBytes })
  check(sources.reduce((n, x) => n + x.bytes.length, 0) <= P.source, 'source_cap')
  const inputs = [...plan.inputPins, ...selectedAnchors.map((x) => x.receiptPin), ...descriptor.pins].map((pin) => ({ pin, bytes: readPin(pin, budget) }))
  const input = (path) => { const found = inputs.find((x) => x.pin.path === path); check(found, 'input_reference'); return found }
  const audit = sealedJson(input(plan.cashAuditPin.path).bytes)
  const series = audit.histories[plan.cashSeriesKey]
  check(series && same(series.points, plan.panelPoints.map((x) => x.slice(0, 5))) &&
    series.witness.manifestSha256 === plan.cashManifestSha256, 'catalog_native_cash_join')
  const discovery = sealedJson(input(plan.discoveryPath).bytes)
  check(discovery.schema === 'morpho49_configuration_discovery_capture_v1' && discovery.ordinal === 27 &&
    discovery.subject.vault === SUBJECT.vault && discovery.subject.asset === SUBJECT.asset &&
    discovery.facts.nativeVaultAsset === SUBJECT.asset && discovery.facts.nativeAdapter === ZERO &&
    discovery.facts.liquidityData === '0x' && discovery.facts.vaultDecimals === '18' &&
    same(discovery.facts.runtime, plan.expectedRuntimes), 'discovery_subject')
  const lead = sealedJson(input(plan.ownerLeadPath).bytes)
  const outputs = lead.outputs.filter((x) => x.subjectId === SUBJECT.id)
  check(outputs.length === 1 && outputs[0].vault === SUBJECT.vault && outputs[0].asset === SUBJECT.asset &&
    outputs[0].owner === SUBJECT.owner && outputs[0].shareDecimals === 18 && outputs[0].assetDecimals === 6 &&
    outputs[0].sharesRaw === plan.historicalLeadOnly.sharesRaw && outputs[0].fullEaRaw === plan.historicalLeadOnly.fullEaRaw &&
    outputs[0].ownerCodeStatus === 'no_code' && outputs[0].currentWalletControl === false &&
    same(outputs[0].ownerCodeRawReferences.map((x) => x.physicalId), [17, 18]), 'historical_lead_hint')
  for (const [index, path] of plan.ownerCodeHintPaths.entries()) {
    const row = sealedJson(input(path).bytes)
    check(row.schema === LEGACY_ROW_STORAGE_SCHEMA && row.binding.physicalId === 17 + index &&
      row.row.observation.physicalId === 17 + index && row.row.observation.host === HOSTS[index], 'owner_hint_row')
    const raw = Buffer.from(row.row.observation.rawBodyBase64, 'base64')
    const envelope = parseUsd3HypotheticalJson(raw.toString('utf8'))
    const request = Buffer.from(row.row.request.requestBodyBase64, 'base64')
    const requested = parseUsd3HypotheticalJson(request.toString('utf8'))
    check(raw.toString('base64') === row.row.observation.rawBodyBase64 &&
      sha(raw) === row.row.observation.bodySha256 && raw.length === row.row.observation.bodyBytes &&
      sha(request) === row.row.request.requestBodySha256 && same(requested, row.row.observation.request) &&
      requested.method === 'eth_getCode' && requested.params[0] === SUBJECT.owner &&
      requested.params[1].blockHash === lead.source.blockHash && requested.params[1].requireCanonical === true &&
      envelope.id === requested.id && envelope.result === '0x', 'owner_hint_raw_body')
  }
  for (const anchor of plan.anchors) {
    const receipt = sealedJson(input(anchor.receiptPath).bytes)
    const rows = receipt.rows.filter((x) => x.destination === SUBJECT.vault)
    check(receipt.sha256 === anchor.receiptBodySha256 && receipt.chainId === 1 && receipt.block === anchor.source.blockNumber &&
      receipt.blockHash === anchor.source.blockHash && receipt.blockAt === anchor.source.blockTime &&
      rows.length === 1 && rows[0].asset === SUBJECT.asset && rows[0].assetDecimals === 6 &&
      rows[0].shareDecimals === 18 && rows[0].cashRaw === anchor.expectedCashRaw &&
      rows[0].blockHash === anchor.source.blockHash && rows[0].block === anchor.source.blockNumber,
      'exact_own_cash_anchor')
  }
  const immutableEntries = (xs) => Object.freeze(xs.map((x) => Object.freeze({ pin: freeze(x.pin), bytes: x.bytes })))
  // Buffers stay readable; every use rechecks them against the immutable, independently read file pins.
  const prepared = Object.freeze({ plan: freeze(plan), planBytes, sources: immutableEntries(sources),
    inputs: immutableEntries(inputs), descriptor: freeze(descriptor.commitment), expectedRuntimes: freeze(plan.expectedRuntimes) })
  preparedInstances.add(prepared)
  morphoV2IdleHeaderBackfillStorageBudgetProof(prepared)
  return prepared
}
function verifyPrepared(prepared) {
  check(preparedInstances.has(prepared), 'prepared_original')
  const budget = { bytes: 0, maximum: P.cohort }
  check(readBytes(fixedPath(MORPHO_V2_IDLE_HEADER_BACKFILL_PLAN_PATH), 131072, budget).equals(prepared.planBytes), 'plan_recheck')
  for (const x of [...prepared.sources, ...prepared.inputs]) check(readPin(x.pin, budget).equals(x.bytes), 'source_recheck')
  morphoV2IdleHeaderBackfillStorageBudgetProof(prepared)
}
export function morphoV2IdleHeaderBackfillFixedArtifacts(prepared) {
  check(preparedInstances.has(prepared), 'prepared_original')
  return [
    { name: 'plan.json', value: seal({ rawText: prepared.planBytes.toString('utf8'), fileSha256: MORPHO_V2_IDLE_HEADER_BACKFILL_PLAN_SHA,
      pairIndex: prepared.plan.pairIndex, failedOriginal: prepared.descriptor, ...FLAGS }) },
    { name: 'provenance.json', value: seal({ sourcePins: prepared.sources.map((x) => x.pin),
      inputPins: prepared.inputs.map((x) => x.pin), sharedCompanionManifestPin: prepared.plan.sharedCompanionManifestPin,
      derivativeSourcePaths: prepared.plan.derivativeSourcePaths, sourcesRetainedByReference: true,
      duplicatedSourceCompanions: false, ...FLAGS }) },
  ]
}
export function morphoV2IdleHeaderBackfillStorageBudgetProof(prepared) {
  const fixed = morphoV2IdleHeaderBackfillFixedArtifacts(prepared)
  const fixedSerializedBytes = fixed.reduce((n, x) => n + serializeHeaderBackfillStorageValue(x.value).length, 0)
  const maximumBase64Bytes = 4 * Math.ceil(P.retainedRawAggregate / 3) + 4 * (P.starts - 1)
  const maximumFiles = fixed.length + P.starts + 3
  const maximumLogicalBytes = fixedSerializedBytes + maximumBase64Bytes + P.starts * P.rowOverhead +
    P.controlSummary + P.report + P.terminal
  const maximumAllocationExtra = maximumFiles * (P.allocationUnit - 1 + P.fileAllocationMargin) + P.directoryAllocationMargin
  check(fixedSerializedBytes <= P.fixedStorage && maximumLogicalBytes <= P.cohort &&
    maximumFiles <= P.files && maximumAllocationExtra <= P.allocationSlack &&
    P.pre === P.reserve + P.cohort + P.allocationSlack &&
    P.deadline === P.acquisitionDeadline + P.retentionReserve, 'storage_budget_proof')
  const pointReadCount = morphoV2IdleHeaderBackfillPointReadPlan('current', prepared.plan.anchors[0].source, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK).length
  const derivedWorstStarts = 2 + 3 * pointReadCount * HOSTS.length
  check(pointReadCount === 16 && derivedWorstStarts === P.plannedStarts && derivedWorstStarts <= P.starts, 'physical_budget_proof')
  return freeze({ fixedSerializedBytes, fixedFiles: fixed.length, maximumAcceptedRawResponseBytes: P.rawAggregate,
    maximumRetainedRawResponseBytes: P.retainedRawAggregate, maximumBase64Bytes,
    maximumRowOverheadBytes: P.starts * P.rowOverhead, maximumLogicalBytes, maximumFiles, maximumAllocationExtra,
    derivedWorstStarts, startsFormula: '2 + (3 points * 16 reads * 2 origins) = 98',
    logicalCohortCap: P.cohort, allocationSlack: P.allocationSlack })
}
export async function captureMorphoV2IdleHeaderBackfillIdleHistory(prepared, origins, options = {}) {
  guard(0, false, true); verifyPrepared(prepared)
  check(Array.isArray(origins) && same(origins.map((x) => x.host), HOSTS) && origins.every((x) => {
    const u = new URL(x.url)
    return u.protocol === 'https:' && u.hostname === x.host && !u.username && !u.password && !u.hash
  }), 'origins')
  const now = options.now ?? Date.now, clock = options.monotonic ?? (() => performance.now())
  const started = options.started ?? clock(), startedAtUtc = utc(now())
  check(Number.isFinite(started) && Number.isFinite(clock()) && started <= clock(), 'monotonic_start')
  const absoluteAcquisitionDeadline = started + P.acquisitionDeadline
  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout
  const transport = createMorphoV2IdleHeaderBackfillNativeTransport(origins, { fetcher: options.fetcher ?? globalThis.fetch,
    clock, deadline: absoluteAcquisitionDeadline })
  const control = createMorphoV2IdleHeaderBackfillControl(origins, {
    fetcher: transport.fetcher, now, monotonic: clock,
    ...(options.pace ? { pace: options.pace } : {}),
    setTimer, clearTimer,
  })
  let controllerConstructedAt, acquisitionExpired = false, cutoffTimer, cutoffTimerArmed = false,
    cutoffTimerCleared = false, receipt, settlements
  const stopAtMorphoV2IdleHeaderBackfillAcquisitionDeadline = () => {
    acquisitionExpired = true
    control.stop('morpho_v2_idle_header_backfill_acquisition_deadline'); transport.stop()
  }
  const acquisitionRemaining = () => absoluteAcquisitionDeadline - clock()
  const deadline = () => {
    if (acquisitionRemaining() <= 0) stopAtMorphoV2IdleHeaderBackfillAcquisitionDeadline()
    check(!acquisitionExpired && acquisitionRemaining() > 0, 'acquisition_deadline')
    check(clock() - started < P.deadline, 'overall_deadline'); guard()
  }
  const namespace = 'historical-owner-native-' + randomUUID(), requests = [], traces = [], points = []
  let currentSource = null, currentS = null, scheduled = 0, failure = null
  const dispatch = async (origin, spec) => {
    deadline(); check(scheduled < P.plannedStarts && scheduled < P.starts && spec.method !== 'eth_getLogs', 'start_budget')
    const request = { jsonrpc: '2.0', id: ++scheduled, method: spec.method, params: spec.params }
    const body = JSON.stringify(request)
    check(Buffer.byteLength(body) <= 2048, 'request_bound')
    const record = { controlNamespace: namespace, physicalId: null, rpcId: request.id, key: spec.key,
      host: origin.host, requestBodyBase64: Buffer.from(body).toString('base64'), requestBodySha256: sha(body) }
    requests.push(record)
    deadline()
    const response = await control.fetcher(origin.url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body, nativeRole: spec.key })
    deadline()
    record.physicalId = Number(response.headers.get('x-usd3-physical-id'))
    check(Number.isSafeInteger(record.physicalId) && record.physicalId > 0 && record.physicalId <= P.starts, 'physical_id')
    const text = await response.text(); deadline()
    const envelope = parseUsd3HypotheticalJson(text)
    check(envelope.jsonrpc === '2.0' && envelope.id === request.id && !Object.hasOwn(envelope, 'error'), 'native_envelope')
    traces.push({ host: origin.host, key: spec.key, request: spec, envelope, physicalId: record.physicalId })
  }
  const group = async (label, specs) => {
    for (let i = 0; i < specs.length; i += 3) {
      const began = clock(); deadline(); control.beginStage(label + '_' + i)
      for (const spec of specs.slice(i, i + 3)) for (const origin of origins) {
        check(clock() - began < P.stage, 'stage_window'); await dispatch(origin, spec)
      }
      check(clock() - began <= P.stage, 'stage_window')
    }
  }
  try {
    controllerConstructedAt = clock()
    // Preparation and fixed writes consume this same CLI clock; construction never resets the cutoff.
    cutoffTimer = setTimer(stopAtMorphoV2IdleHeaderBackfillAcquisitionDeadline, Math.max(0, acquisitionRemaining()))
    cutoffTimerArmed = true
    deadline()
    const finalized = blockHeader('fresh_finalized', 'finalized')
    await group('finalized', [finalized]); currentSource = pairedHeader(traces, finalized)
    check(now() - Date.parse(currentSource.blockTime) >= 0 && now() - Date.parse(currentSource.blockTime) <= 1800000 &&
      prepared.plan.anchors.every((x) => BigInt(x.source.blockNumber) < BigInt(currentSource.blockNumber)), 'fresh_finalized_age')
    const current = morphoV2IdleHeaderBackfillPointReadPlan('current', currentSource, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK)
    await group('current_native', current)
    currentS = decodeMorphoV2IdleHeaderBackfillResult('balanceOf', paired(traces, current[13]))
    points.push(deriveMorphoV2IdleHeaderBackfillPoint(traces, 'current', currentSource,
      MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK, prepared.expectedRuntimes))
    check(currentS === MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK, 'frozen_current_stock_changed')
    for (const [index, anchor] of prepared.plan.anchors.entries()) {
      const label = 'anchor_' + index
      await group(label, morphoV2IdleHeaderBackfillPointReadPlan(label, anchor.source, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK))
      points.push(deriveMorphoV2IdleHeaderBackfillPoint(traces, label, anchor.source, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK, prepared.expectedRuntimes, anchor.expectedCashRaw))
    }
    deadline(); verifyPrepared(prepared)
  } catch (error) {
    failure = acquisitionExpired || acquisitionRemaining() <= 0 ? 'morpho_v2_idle_header_backfill_acquisition_deadline'
      : error instanceof Error && /^morpho_v2_idle_header_backfill_[a-zA-Z0-9_]+$/.test(error.message)
        ? error.message : 'morpho_v2_idle_header_backfill_native_unavailable'
    control.stop('morpho_v2_idle_header_backfill_native_failed')
  } finally {
    // Keep the absolute abort armed until finish has aborted and settled the original controller.
    try { transport.stop(); await transport.settle(); receipt = await control.finish();
      settlements = structuredClone(control.settlementReceipts) }
    finally { if (cutoffTimerArmed) clearTimer(cutoffTimer); cutoffTimerCleared = true }
  }
  for (const request of requests) if (request.physicalId === null) {
    const row = receipt.ledger.find((x) => x.host === request.host && x.request.id === request.rpcId)
    if (row) request.physicalId = row.physicalId
  }
  if (!failure) try {
    check(receipt.physicalStarts === scheduled && scheduled === P.plannedStarts && points.length === 3 &&
      !acquisitionExpired && clock() < absoluteAcquisitionDeadline &&
      receipt.ledger.every((row) => row.accepted === true &&
        Number.isFinite(row.completedElapsedMs) &&
        row.completedElapsedMs + controllerConstructedAt < absoluteAcquisitionDeadline) &&
      clock() - started <= P.deadline && now() - Date.parse(currentSource.blockTime) <= 1800000, 'final_bounds')
    verifyMorphoV2IdleHeaderBackfillControl(receipt, requests, settlements, namespace)
  } catch { failure = 'morpho_v2_idle_header_backfill_original_control_join_failed' }
  const pointStatuses = morphoV2IdleHeaderBackfillPointStatuses(prepared, traces, points, currentSource, failure)
  return { namespace, receipt, requests, settlements, traces, points, pointStatuses, currentSource,
    nativeTransport: transport.summary(), frozenProbeSharesRaw: MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK,
    freshCurrentSharesRaw: currentS, physicalStarts: receipt.physicalStarts, scheduledReads: scheduled,
    completeNativeAcquisition: failure === null, qualifiedNativeJoin: failure === null && points.every((x) => x.qualifiedNativeJoin),
    failure, startedAtUtc, nativeAcquisitionCompletedAtUtc: utc(now()), elapsedMs: clock() - started,
    acquisitionDeadlineElapsedMs: P.acquisitionDeadline, retentionReserveMs: P.retentionReserve,
    acquisitionExpired, cutoffTimerCleared, ...FLAGS }
}
function nativeRecord(capture, observation) {
  return { namespace: capture.namespace, physicalId: observation.physicalId,
    request: capture.requests.find((x) => x.physicalId === observation.physicalId) ?? null,
    observation, settlement: capture.settlements.find((x) => x.physicalId === observation.physicalId) ?? null,
    ...STORAGE_FLAGS }
}
function storageContext(record, source) {
  return { namespace: record.namespace, physicalId: record.physicalId, source,
    rowJsonSha256: sha(JSON.stringify(record)), observationJsonSha256: sha(JSON.stringify(record.observation)),
    settlementJsonSha256: sha(JSON.stringify(record.settlement)) }
}
export function morphoV2IdleHeaderBackfillEncodedOriginals(capture) {
  check(capture.receipt.ledger.length <= P.starts, 'row_count')
  let rawBytes = 0
  const rows = capture.receipt.ledger.map((observation, index) => {
    const record = nativeRecord(capture, observation), context = storageContext(record, capture.currentSource)
    const value = encodeHeaderBackfillNativeRow(record, context), before = rawBytes
    rawBytes += headerBackfillEncodedRawResponseBytes(value)
    check(rawBytes <= P.rawAggregate || (before <= P.rawAggregate && rawBytes <= P.retainedRawAggregate &&
      index === capture.receipt.ledger.length - 1 && capture.receipt.failure !== null &&
      observation.accepted === false && observation.status === 'failed'), 'aggregate_raw_bound')
    check(same(decodeHeaderBackfillNativeRow(value, context), record), 'lossless_original_row')
    return { name: 'native-row-' + String(observation.physicalId).padStart(3, '0') + '.json', value, context }
  })
  const { ledger, ...receipt } = capture.receipt
  const unmatchedRequests = capture.requests.filter((x) => !ledger.some((r) => r.physicalId === x.physicalId))
  check(unmatchedRequests.length <= 1 && capture.settlements.every((x) => ledger.some((r) => r.physicalId === x.physicalId)),
    'unmatched_channels')
  const summary = seal({ schema: 'morpho_v2_idle_history_header_backfill_original_control_v1', namespace: capture.namespace,
    source: capture.currentSource, receipt, receiptKeyOrder: Object.keys(capture.receipt),
    requestOrder: capture.requests.map((x) => x.rpcId), unmatchedRequests,
    rows: rows.map((x) => { const { namespace, source, ...commitments } = x.context
      return { file: x.name, commitments } }), ...FLAGS })
  check(serializeHeaderBackfillStorageValue(summary).length <= P.controlSummary, 'control_summary_bound')
  return { rows, summary, rawBytes }
}
/** Reconstruction retains every original field and verifies the immutable physical controller. */
export function reconstructMorphoV2IdleHeaderBackfillOriginalControl(summary, encodedRows, requireComplete = true) {
  check(summary.schema === 'morpho_v2_idle_history_header_backfill_original_control_v1' && summary.rows.length <= P.starts &&
    encodedRows.length === summary.rows.length && Object.entries(FLAGS).every(([key, value]) => summary[key] === value), 'original_summary')
  const ledger = [], requests = [], settlements = []
  let replayRawBytes = 0
  for (const [index, entry] of summary.rows.entries()) {
    const context = { namespace: summary.namespace, source: summary.source, ...entry.commitments }
    const restored = decodeHeaderBackfillNativeRow(encodedRows[index], context), previousRaw = replayRawBytes
    replayRawBytes += headerBackfillEncodedRawResponseBytes(encodedRows[index])
    check(replayRawBytes <= P.rawAggregate || (!requireComplete && previousRaw <= P.rawAggregate &&
      replayRawBytes <= P.retainedRawAggregate && index === encodedRows.length - 1 &&
      restored.observation.status === 'failed' && restored.observation.accepted === false), 'replay_raw_aggregate')
    ledger.push(restored.observation)
    if (restored.request !== null) requests.push(restored.request)
    if (restored.settlement !== null) settlements.push(restored.settlement)
  }
  requests.push(...structuredClone(summary.unmatchedRequests))
  requests.sort((a, b) => summary.requestOrder.indexOf(a.rpcId) - summary.requestOrder.indexOf(b.rpcId))
  check(Array.isArray(summary.receiptKeyOrder) && new Set(summary.receiptKeyOrder).size === summary.receiptKeyOrder.length &&
    same([...summary.receiptKeyOrder].sort(), [...Object.keys(summary.receipt), 'ledger'].sort()), 'receipt_field_order')
  const receipt = Object.fromEntries(summary.receiptKeyOrder.map((key) =>
    [key, key === 'ledger' ? ledger : summary.receipt[key]]))
  check(receipt.physicalStarts === ledger.length && ledger.length <= P.starts, 'restored_count')
  if (requireComplete) verifyMorphoV2IdleHeaderBackfillControl(receipt, requests, settlements, summary.namespace)
  return { namespace: summary.namespace, receipt, requests, settlements }
}
export function createMorphoV2IdleHeaderBackfillWriter(out, secrets, { clock = () => performance.now(), started = clock() } = {}) {
  const parent = fixedPath('data/research/venue-signals')
  check(dirname(out) === parent && /^morpho-v2-idle-history-header-backfill-v1-[A-Za-z0-9.-]+$/.test(basename(out)), 'output_root')
  guard(); const parentBefore = lstatSync(parent)
  mkdirSync(out, { mode: 0o700 })
  const made = lstatSync(out)
  check(made.isDirectory() && !made.isSymbolicLink() && (made.mode & 0o777) === 0o700, 'output_directory')
  const syncDirectory = (path) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  syncDirectory(parent)
  const identity = () => {
    const p = lstatSync(parent), d = lstatSync(out)
    check(p.isDirectory() && !p.isSymbolicLink() && p.dev === parentBefore.dev && p.ino === parentBefore.ino &&
      d.isDirectory() && !d.isSymbolicLink() && d.dev === made.dev && d.ino === made.ino &&
      (d.mode & 0o777) === 0o700, 'writer_directory_identity')
  }
  const deadline = () => check(clock() - started <= P.deadline, 'retention_deadline')
  let bytes = 0, attemptedFiles = 0, fixedBytes = 0, rawBytes = 0
  const refs = []
  const verifyRetained = () => {
    identity()
    for (const ref of refs) {
      const path = resolve(out, ref.file), s = lstatSync(path)
      check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o777) === 0o600 &&
        s.dev === ref.dev && s.ino === ref.ino, 'retained_identity')
      check(sha(readBytes(path, ref.bytes, { bytes: 0, maximum: ref.bytes }, true)) === ref.fileSha256, 'retained_readback')
    }
    deadline()
  }
  return { refs, used: () => bytes, verifyRetained,
    write(name, value, terminal = false) {
      deadline(); identity(); check(/^[a-z0-9_.-]{1,80}$/.test(name), 'artifact_name')
      assertMorphoV2IdleHeaderBackfillPrivacy(value, secrets)
      const data = serializeHeaderBackfillStorageValue(value), fixed = /^(?:plan|provenance)\.json$/.test(name)
      check(data.length <= P.file && (!terminal || data.length <= P.terminal) &&
        bytes + data.length <= P.cohort - (terminal ? 0 : P.terminal) &&
        attemptedFiles + 1 <= P.files - (terminal ? 0 : 1) && (!fixed || fixedBytes + data.length <= P.fixedStorage), 'write_cap')
      if (name === 'control-summary.json') check(data.length <= P.controlSummary, 'summary_cap')
      if (name === 'report.json') check(data.length <= P.report, 'report_cap')
      let extraRaw = 0
      if (/^native-row-[0-9]{3}\.json$/.test(name)) {
        check(value.schema === HEADER_BACKFILL_ROW_STORAGE_SCHEMA && headerBackfillEncodedRowOverheadBytes(value) <= P.rowOverhead, 'row_overhead')
        extraRaw = headerBackfillEncodedRawResponseBytes(value)
        check(rawBytes + extraRaw <= P.rawAggregate || (rawBytes <= P.rawAggregate && rawBytes + extraRaw <= P.retainedRawAggregate &&
          value.row.observation.accepted === false && value.row.observation.status === 'failed'), 'raw_cap')
      }
      guard(data.length, terminal)
      const path = resolve(out, name), fd = openSync(path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      bytes += data.length; attemptedFiles++; if (fixed) fixedBytes += data.length; rawBytes += extraRaw
      let after
      try {
        let used = 0
        while (used < data.length) { const n = writeSync(fd, data, used, data.length - used); check(n > 0, 'short_write'); used += n }
        fsyncSync(fd); syncDirectory(out); after = fstatSync(fd)
        const named = lstatSync(path)
        check(after.isFile() && named.isFile() && !named.isSymbolicLink() && after.nlink === 1 && named.nlink === 1 &&
          after.dev === named.dev && after.ino === named.ino && after.size === data.length && named.size === data.length &&
          (after.mode & 0o777) === 0o600 && (named.mode & 0o777) === 0o600, 'postfsync_identity')
      } finally { closeSync(fd) }
      check(readBytes(path, data.length, { bytes: 0, maximum: data.length }, true).equals(data), 'write_readback')
      identity(); deadline()
      const ref = { file: name, bytes: data.length, fileSha256: sha(data), dev: after.dev, ino: after.ino }
      refs.push(ref); return ref
    },
  }
}
export function morphoV2IdleHeaderBackfillReport(capture, prepared) {
  return seal({ schema: 'morpho_v2_idle_history_header_backfill_native_join_report_v1',
    responseBytePolicy: { header: P.headerResponse, other: P.response },
    failedOriginal: prepared.descriptor, structuralBackfill: true, automaticRetry: false, subject: prepared.plan.subject,
    status: !capture.completeNativeAcquisition ? 'partial_native_capture'
      : capture.qualifiedNativeJoin ? 'native_join_observed_retention_pending' : 'native_regime_qualification_declined',
    completeNativeAcquisition: capture.completeNativeAcquisition, qualifiedNativeJoin: capture.qualifiedNativeJoin,
    failure: capture.failure, currentSource: capture.currentSource, freshCurrentSharesRaw: capture.freshCurrentSharesRaw,
    points: capture.points, pointStatuses: capture.pointStatuses, nativeTransport: capture.nativeTransport,
    pairIndex: prepared.plan.pairIndex, panelPointIndices: prepared.plan.anchors.map((x) => x.panelIndex),
    frozenProbeSharesRaw: MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK, QAssetRaw: MORPHO_V2_IDLE_HEADER_BACKFILL_Q, horizonMs: MORPHO_V2_IDLE_HEADER_BACKFILL_HORIZON_MS,
    panelRows: morphoV2IdleHeaderBackfillChronologicalRows(prepared, capture.points), physicalStarts: capture.physicalStarts, scheduledReads: capture.scheduledReads,
    maximumPhysicalStarts: P.starts, maximumPlannedPhysicalStarts: P.plannedStarts, logStarts: 0,
    historicalProbeBasis: 'hypothetical_fixed_current_stock_conversion', historicalOwnedEntitlementMeasured: false,
    stationaryRegimePooling: false, unknownCompetingMRaw: null, suggestedFutureQAssetRaw: MORPHO_V2_IDLE_HEADER_BACKFILL_Q,
    futureQNeedsFreshStockAndExactNativePath: true, nativeAcquisitionCompletedAtUtc: capture.nativeAcquisitionCompletedAtUtc,
    nativeAcquisitionElapsedMs: capture.elapsedMs, acquisitionDeadlineElapsedMs: P.acquisitionDeadline,
    retentionReserveMs: P.retentionReserve, acquisitionExpired: capture.acquisitionExpired,
    cutoffTimerCleared: capture.cutoffTimerCleared,
    sourcePinsReference: 'provenance.json', sourcePinCount: prepared.sources.length,
    inputPinCount: prepared.inputs.length, ...FLAGS })
}
/** Bounded zero-RPC replay of freshly retained originals; it grants no forecast or execution authority. */
export function inspectMorphoV2IdleHeaderBackfillRetainedHistory(directory) {
  const parent = fixedPath('data/research/venue-signals')
  check(dirname(directory) === parent && /^morpho-v2-idle-history-header-backfill-v1-[A-Za-z0-9.-]+$/.test(basename(directory)), 'inspect_root')
  const d = lstatSync(directory)
  check(d.isDirectory() && !d.isSymbolicLink() && (d.mode & 0o777) === 0o700, 'inspect_directory')
  const budget = { bytes: 0, maximum: P.cohort }
  const terminalBytes = readBytes(resolve(directory, 'terminal.json'), P.terminal, budget, true)
  const terminal = sealedJson(terminalBytes)
  const descriptorPin = terminal.descriptorPin
  const p = prepareMorphoV2IdleHeaderBackfillIdleHistory(terminal.pairIndex, descriptorPin)
  check(terminal.schema === 'morpho_v2_idle_history_header_backfill_terminal_v1' && terminal.files.length < P.files &&
    new Set(terminal.files.map((x) => x.file)).size === terminal.files.length &&
    Object.entries(FLAGS).every(([key, value]) => terminal[key] === value), 'terminal')
  check(same(readdirSync(directory).sort(), [...terminal.files.map((x) => x.file), 'terminal.json'].sort()), 'retained_closed_inventory')
  const retained = new Map()
  for (const ref of terminal.files) {
    check(/^[a-z0-9_.-]{1,80}$/.test(ref.file) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= P.file,
      'retained_reference')
    const bytes = readBytes(resolve(directory, ref.file), ref.bytes, budget, true)
    check(bytes.length === ref.bytes && sha(bytes) === ref.fileSha256, 'retained_pin')
    retained.set(ref.file, sealedJson(bytes))
  }
  for (const fixed of morphoV2IdleHeaderBackfillFixedArtifacts(p)) check(same(retained.get(fixed.name), fixed.value), 'retained_fixed_original')
  const summary = retained.get('control-summary.json'), report = retained.get('report.json')
  check(summary && report && report.sha256 === terminal.reportSha256 &&
    report.completeNativeAcquisition === terminal.completeNativeAcquisition &&
    report.qualifiedNativeJoin === terminal.qualifiedNativeJoin && same(report.subject, SUBJECT) &&
    report.acquisitionDeadlineElapsedMs === P.acquisitionDeadline && report.retentionReserveMs === P.retentionReserve &&
    report.cutoffTimerCleared === true && same(report.responseBytePolicy, { header: P.headerResponse, other: P.response }) &&
    report.structuralBackfill === true && report.automaticRetry === false && same(report.failedOriginal, p.descriptor) &&
    Number.isFinite(report.nativeAcquisitionElapsedMs) &&
    report.nativeAcquisitionElapsedMs <= P.deadline && Number.isFinite(terminal.elapsedMs) &&
    terminal.elapsedMs <= P.deadline, 'retained_report_join')
  const restored = reconstructMorphoV2IdleHeaderBackfillOriginalControl(summary, summary.rows.map((x) => {
    const row = retained.get(x.file); check(row, 'retained_row'); return row
  }), report.completeNativeAcquisition)
  check(restored.receipt.physicalStarts === terminal.physicalStarts &&
    restored.receipt.pendingSettlements === terminal.pendingSettlements, 'retained_accounting')
  if (report.completeNativeAcquisition) {
    check(report.acquisitionExpired === false && report.nativeAcquisitionElapsedMs < P.acquisitionDeadline,
      'retained_absolute_acquisition_clock')
    check(restored.receipt.physicalStarts === P.plannedStarts && report.physicalStarts === P.plannedStarts, 'complete_starts')
    const names = { asset: 'asset', share_decimals: 'decimals', asset_decimals: 'decimals',
      liquidity_adapter: 'liquidityAdapter', liquidity_data: 'liquidityData', idle_cash: 'balanceOf',
      total_assets: 'totalAssets', total_supply: 'totalSupply', actual_owner_shares: 'balanceOf', fixed_stock_preview: 'previewRedeem' }
    const traces = restored.receipt.ledger.map((row) => {
      const r = restored.requests.find((x) => x.physicalId === row.physicalId)
      check(r, 'retained_request')
      const name = names[r.key.split(':')[1]]
      const spec = { key: r.key, ...(name ? { name } : {}), method: row.request.method, params: row.request.params }
      return { host: row.host, key: r.key, request: spec, physicalId: row.physicalId,
        envelope: parseUsd3HypotheticalJson(Buffer.from(row.rawBodyBase64, 'base64').toString('utf8')) }
    })
    const currentSource = pairedHeader(traces, blockHeader('fresh_finalized', 'finalized'))
    const currentS = decodeMorphoV2IdleHeaderBackfillResult('balanceOf', paired(traces,
      morphoV2IdleHeaderBackfillPointReadPlan('current', currentSource, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK)[13]))
    const points = [deriveMorphoV2IdleHeaderBackfillPoint(traces, 'current', currentSource, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK, p.expectedRuntimes),
      ...p.plan.anchors.map((anchor, i) => deriveMorphoV2IdleHeaderBackfillPoint(traces, 'anchor_' + i,
        anchor.source, MORPHO_V2_IDLE_HEADER_BACKFILL_STOCK, p.expectedRuntimes, anchor.expectedCashRaw))]
    check(same(points, report.points) && same(morphoV2IdleHeaderBackfillPointStatuses(p, traces, points, currentSource, null), report.pointStatuses) &&
      same(morphoV2IdleHeaderBackfillChronologicalRows(p, points), report.panelRows) &&
      report.nativeTransport.pendingBodies === 0 && report.nativeTransport.physicalStarts === P.plannedStarts && same(currentSource, report.currentSource) && same(currentSource, summary.source) &&
      currentS === report.freshCurrentSharesRaw && report.qualifiedNativeJoin === points.every((x) => x.qualifiedNativeJoin), 'retained_native_fact_join')
  } else check(report.qualifiedNativeJoin === false && terminal.qualifiedNativeJoin === false, 'partial_no_qualification')
  verifyPrepared(p)
  return { status: report.completeNativeAcquisition ? 'retained_native_control_verified' : 'retained_partial_control_only',
    report, terminal, reportFileSha256: terminal.files.find((x) => x.file === 'report.json').fileSha256,
    terminalFileSha256: sha(terminalBytes), physicalStarts: restored.receipt.physicalStarts, originalControlVerified: report.completeNativeAcquisition,
    qualifiedNativeJoin: report.qualifiedNativeJoin, retainedBytes: budget.bytes, ...FLAGS }
}
/** The final acceptance clock is sampled only after terminal and source readbacks. */
export function finalizeMorphoV2IdleHeaderBackfillRetention(writer, prepared, capture, {
  clock = () => performance.now(), now = Date.now, started = 0,
} = {}) {
  writer.verifyRetained(); verifyPrepared(prepared)
  const reserveAfterReadback = freeBytes(), completedAtMs = now(), elapsedMs = clock() - started
  const sourceAgeMs = capture.currentSource === null ? null : completedAtMs - Date.parse(capture.currentSource.blockTime)
  check(Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= P.deadline &&
    reserveAfterReadback >= BigInt(P.reserve), 'final_retention_deadline_or_reserve')
  check(!capture.completeNativeAcquisition || Number.isFinite(sourceAgeMs) && sourceAgeMs >= 0 &&
    sourceAgeMs <= 1800000, 'final_retention_source_age')
  return { postRetentionCompletedAtUtc: utc(completedAtMs), postRetentionElapsedMs: elapsedMs,
    postRetentionSourceAgeMs: sourceAgeMs, retentionCompletionClockStage: 'after_terminal_readback_and_source_pin_checks' }
}
export async function runMorphoV2IdleHeaderBackfillIdleHistory(argv = process.argv.slice(2)) {
  check(argv.length === 4 && ['--verify', '--dry-plan', '--capture'].includes(argv[0]) &&
    /^--pair=(?:[0-9]|[1-5][0-9])$/.test(argv[1]) && argv[2].startsWith('--descriptor=') &&
    /^--descriptor-sha=[0-9a-f]{64}$/.test(argv[3]), 'closed_CLI')
  const pairIndex = Number(argv[1].slice(7)), descriptorPath = argv[2].slice(13)
  const stat = lstatSync(backfillInputPath(descriptorPath))
  const descriptorPin = { path: descriptorPath, bytes: stat.size, fileSha256: argv[3].slice(17) }
  if (argv[0] !== '--capture') {
    const p = prepareMorphoV2IdleHeaderBackfillIdleHistory(pairIndex, descriptorPin), proof = morphoV2IdleHeaderBackfillStorageBudgetProof(p)
    return { status: argv[0] === '--dry-plan' ? 'closed_plan_no_RPC' : 'verified_no_RPC', subject: p.plan.subject,
      planSha256: MORPHO_V2_IDLE_HEADER_BACKFILL_PLAN_SHA, producerSha256: p.sources.at(-1).pin.fileSha256,
      anchors: p.plan.anchors, pairIndex, collectionOrder: p.plan.backfillCollectionOrder, historicalPanelCollectionOrder: p.plan.collectionOrder, splits: p.plan.splits, proof, policy: P, ...FLAGS }
  }
  guard(0, false, true)
  const started = 0, p = prepareMorphoV2IdleHeaderBackfillIdleHistory(pairIndex, descriptorPin) // Process monotonic origin includes imports and preparation.
  const origins = await configuredUsd3HypotheticalOrigins(), secrets = additionalHistoricalOwnerCredentialVariants(origins)
  const directory = resolve(ROOT, 'data/research/venue-signals/morpho-v2-idle-history-header-backfill-v1-' +
    new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID())
  const writer = createMorphoV2IdleHeaderBackfillWriter(directory, secrets, { started })
  for (const artifact of morphoV2IdleHeaderBackfillFixedArtifacts(p)) writer.write(artifact.name, artifact.value)
  const capture = await captureMorphoV2IdleHeaderBackfillIdleHistory(p, origins, { started })
  const originals = morphoV2IdleHeaderBackfillEncodedOriginals(capture)
  for (const row of originals.rows) writer.write(row.name, row.value)
  writer.write('control-summary.json', originals.summary)
  const restored = reconstructMorphoV2IdleHeaderBackfillOriginalControl(originals.summary, originals.rows.map((x) => x.value), capture.completeNativeAcquisition)
  check(same(restored.receipt, capture.receipt) && same(restored.requests, capture.requests) &&
    same(restored.settlements, capture.settlements), 'retained_original_control_equality')
  const report = morphoV2IdleHeaderBackfillReport(capture, p); writer.write('report.json', report)
  writer.verifyRetained(); verifyPrepared(p)
  const preTerminalRetentionCheckedAtUtc = utc(Date.now())
  check(performance.now() - started <= P.deadline && freeBytes() >= BigInt(P.reserve) &&
    (!capture.completeNativeAcquisition || Date.parse(preTerminalRetentionCheckedAtUtc) - Date.parse(capture.currentSource.blockTime) <= 1800000),
    'post_retention_deadline_reserve_age')
  const terminal = seal({ schema: 'morpho_v2_idle_history_header_backfill_terminal_v1', reportSha256: report.sha256,
    descriptorPin: p.descriptor.descriptorPin,
    completeNativeAcquisition: capture.completeNativeAcquisition, qualifiedNativeJoin: capture.qualifiedNativeJoin,
    failure: capture.failure, currentSource: capture.currentSource, physicalStarts: capture.physicalStarts,
    pendingSettlements: capture.receipt.pendingSettlements, pairIndex, retainedRows: originals.rows.length,
    preTerminalRetentionCheckedAtUtc, retentionClockStage: 'before_terminal_write', elapsedMs: performance.now() - started,
    acquisitionDeadlineElapsedMs: P.acquisitionDeadline, retentionReserveMs: P.retentionReserve,
    files: writer.refs.map(({ dev, ino, ...ref }) => ref), ...FLAGS })
  writer.write('terminal.json', terminal, true)
  const finalRetention = finalizeMorphoV2IdleHeaderBackfillRetention(writer, p, capture, { started })
  return { directory, status: capture.completeNativeAcquisition ? 'native_capture_retained' : 'partial_capture_retained',
    qualifiedNativeJoin: capture.qualifiedNativeJoin, failure: capture.failure, physicalStarts: capture.physicalStarts,
    retainedFiles: writer.refs.length, retainedBytes: writer.used(), terminalSha256: terminal.sha256,
    SDKphysicalStarts: null, ...finalRetention, ...FLAGS }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMorphoV2IdleHeaderBackfillIdleHistory().then((value) => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => {
    process.stderr.write('morpho_v2_idle_header_backfill_closed_capture_unavailable\n'); process.exitCode = 1
  })
}
