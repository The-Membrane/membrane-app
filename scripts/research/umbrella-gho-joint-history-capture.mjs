// Manual/protected native history primitive. Import does not run; no caller fetch/clock/provider hooks.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  configuredUsd3HypotheticalOrigins,
  parseUsd3HypotheticalJson,
} from './usd3-hypothetical-history-capture.mjs'
import * as nativeHistory from '../../lib/carry/umbrellaGhoJointNativeHistory.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const nativeFetch = globalThis.fetch,
  nativeNow = Date.now,
  NativeDate = Date
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const plans = new WeakSet(),
  startedPlans = new WeakSet(),
  originals = new WeakMap()
const pick = (m, key) => m[key] ?? m.default?.[key]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const check = (value, code) => {
  if (!value) throw Error('umbrella_history_' + code)
}
const dense = (v, n) =>
  Array.isArray(v) &&
  v.length === n &&
  Object.keys(v).length === n &&
  Array.from({ length: n }, (_, i) => Object.hasOwn(v, i)).every(Boolean)
const keys = (v, expected) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...expected].sort().join(',')
function freeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) freeze(x)
    Object.freeze(v)
  }
  return v
}
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(v)
}
const seal = (body) => ({ ...body, sha256: sha(canonical(body)) })
const parseNativeJson = parseUsd3HypotheticalJson
function snapshot(v) {
  let count = 0,
    chars = 0
  const seen = new Set()
  const cp = (x, depth) => {
    check(++count <= 1000 && depth <= 8, 'input_bound')
    if (x === null || typeof x === 'boolean') return x
    if (typeof x === 'number') {
      check(Number.isSafeInteger(x) && x >= 0, 'input_number')
      return x
    }
    if (typeof x === 'string') {
      chars += x.length
      check(x.length <= 128 && chars <= 8192, 'input_string')
      return x
    }
    check(
      x &&
        typeof x === 'object' &&
        !Array.isArray(x) &&
        Object.getPrototypeOf(x) === Object.prototype &&
        Object.getOwnPropertySymbols(x).length === 0 &&
        !seen.has(x),
      'input_plain',
    )
    seen.add(x)
    const out = {}
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(x))) {
      check(
        d.enumerable &&
          Object.hasOwn(d, 'value') &&
          !['__proto__', 'constructor', 'prototype'].includes(k),
        'input_accessor',
      )
      out[k] = cp(d.value, depth + 1)
    }
    seen.delete(x)
    return out
  }
  return cp(v, 0)
}
function nativeUnchanged() {
  check(
    globalThis.fetch === nativeFetch && Date.now === nativeNow && Date === NativeDate,
    'native_changed',
  )
}
function reserve() {
  const s = statfsSync(ROOT)
  check(Number(s.bavail) * Number(s.bsize) >= 256 * 1024 * 1024, 'disk_reserve')
}
function secretTokens(origins) {
  const tokens = new Set(),
    generic = new Set(['', 'v1', 'v2', 'v3', 'eth', 'ethereum', 'mainnet', 'rpc'])
  for (const o of origins) {
    const u = new URL(o.url)
    tokens.add(o.url)
    tokens.add(u.href)
    for (const p of u.pathname.split('/'))
      if (!generic.has(p.toLowerCase())) {
        tokens.add(p)
        try {
          tokens.add(decodeURIComponent(p))
        } catch {}
      }
    for (const [k, v] of u.searchParams) {
      if (k) tokens.add(k)
      if (v) tokens.add(v)
    }
    if (u.search) tokens.add(u.search)
  }
  return [...tokens].filter(Boolean)
}
function containsSecret(bytes, tokens) {
  const text = bytes.toString('utf8'),
    forms = [text]
  try {
    JSON.parse(text)
  } catch {
    if (text.includes('\\')) return true
  }
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try {
      const v = JSON.parse(match[0])
      if (typeof v === 'string') forms.push(v)
    } catch {}
  }
  for (let pass = 0; pass < 3; pass++) {
    const count = forms.length
    for (let i = 0; i < count; i++) {
      try {
        const v = decodeURIComponent(forms[i])
        if (v !== forms[i]) forms.push(v)
      } catch {}
    }
  }
  return forms.some((v) => tokens.some((token) => v.includes(token)))
}
export function prepareUmbrellaGhoJointHistoryCapturePlan(options) {
  nativeUnchanged()
  const own = snapshot(options)
  check(
    keys(own, ['batchIndex', 'fullSharesRaw', 'cooldownSharesRaw', 'currentSource']) &&
      (own.batchIndex === 0 || own.batchIndex === 1),
    'plan_options',
  )
  check(
    /^[1-9][0-9]*$/.test(own.fullSharesRaw) &&
      BigInt(own.fullSharesRaw) < 1n << 256n &&
      /^(0|[1-9][0-9]*)$/.test(own.cooldownSharesRaw) &&
      BigInt(own.cooldownSharesRaw) < 1n << 192n,
    'shares',
  )
  const preparedAtUtc = new NativeDate(nativeNow()).toISOString()
  const anchors = pick(nativeHistory, 'UMBRELLA_GHO_JOINT_NATIVE_HISTORY_ANCHORS')
    .slice(own.batchIndex * 4, own.batchIndex * 4 + 4)
    .map((a) => {
      const binding = {
        cashIndex: a.cashIndex,
        source: a.source,
        currentSource: own.currentSource,
        fullSharesRaw: own.fullSharesRaw,
        cooldownSharesRaw: own.cooldownSharesRaw,
        acquiredAtUtc: preparedAtUtc,
      }
      const requests = pick(nativeHistory, 'umbrellaGhoJointNativeHistoryReadPlan')(binding)
      check(dense(requests, 18), 'read_plan')
      return { cashIndex: a.cashIndex, source: a.source, cashRaw: a.cashRaw, requests }
    })
  const body = {
    schema: 'umbrella_gho_joint_native_history_capture_plan_v1',
    captureId: randomUUID(),
    batchIndex: own.batchIndex,
    fullSharesRaw: own.fullSharesRaw,
    cooldownSharesRaw: own.cooldownSharesRaw,
    currentSource: own.currentSource,
    preparedAtUtc,
    anchors,
    owner: null,
    historicalOwnership: false,
    sourceClass: 'captured_identical_runtimes_only',
  }
  const plan = freeze({ ...body, planSha256: sha(canonical(body)) })
  plans.add(plan)
  return plan
}

function makeControl(origins, secrets) {
  const fetcher = nativeFetch,
    now = nativeNow,
    monotonic = () => performance.now(),
    pace = (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer = setTimeout,
    clearTimer = clearTimeout
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
      if (closed || clock >= limit || ledger.length >= 146) {
        stop('start_budget')
        throw Error('umbrella_history_start_budget')
      }
      if (options.signal?.aborted) {
        stop('upstream_aborted')
        throw Error('umbrella_history_upstream_aborted')
      }
      const wait = (lastStart.get(o.host) ?? -Infinity) + 250 - clock
      if (wait <= 0) break
      await pace(Math.ceil(wait))
      // Early wakeups must recheck the monotonic spacing; a stalled injected clock cannot spin.
      check(monotonic() > clock, 'pacing_clock_unavailable')
    }
    let at = monotonic(),
      limit = Math.min(deadline, windows.get(o.host))
    if (closed || at >= limit || ledger.length >= 146) {
      stop('start_budget')
      throw Error('umbrella_history_start_budget')
    }
    if (options.signal?.aborted) {
      stop('upstream_aborted')
      throw Error('umbrella_history_upstream_aborted')
    }
    check(
      typeof options.body === 'string' && Buffer.byteLength(options.body) <= 65536,
      'request_cap',
    )
    const requestBytes = Buffer.from(options.body, 'utf8')
    check(!containsSecret(requestBytes, secrets), 'request_secret')
    const request = parseNativeJson(options.body)
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
      requestBodyBase64: requestBytes.toString('base64'),
      requestBodySha256: sha(requestBytes),
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
    reserve()
    nativeUnchanged()
    at = monotonic()
    check(
      !closed &&
        at < limit &&
        ledger.length < 146 &&
        !options.signal?.aborted &&
        at - (lastStart.get(o.host) ?? -Infinity) >= 250,
      'dispatch_bound',
    )
    row.startedAtUtc = new Date(now()).toISOString()
    row.startedElapsedMs = at - start
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
        const response = await fetcher(url, {
          ...options,
          redirect: 'error',
          signal: controller.signal,
        })
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
            check(length <= 65536, 'response_cap')
            chunks.push(Buffer.from(value))
          }
        } catch (error) {
          cancelStream()
          throw error
        } finally {
          streamReader = null
          reader.releaseLock()
        }
        const bytes = Buffer.concat(chunks)
        row.bodyBytes = bytes.length
        row.bodySha256 = sha(bytes)
        if (containsSecret(bytes, secrets)) {
          row.safeCode = 'configured_secret_rejected'
          throw Error('umbrella_history_response_secret')
        }
        // Exact permitted bytes enter the sealed ledger before UTF8/envelope/ABI acceptance.
        row.rawBodyBase64 = bytes.toString('base64')
        row.bodyBytes = bytes.length
        row.bodySha256 = sha(bytes)
        totalBytes += bytes.length
        check(totalBytes <= 2 * 1024 * 1024, 'ledger_cap')
        const text = bytes.toString('utf8')
        check(Buffer.from(text, 'utf8').equals(bytes), 'response_utf8')
        const envelope = parseNativeJson(text)
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
          headers: { 'content-type': 'application/json', 'x-umbrella-physical-id': String(id) },
        })
      } catch {
        row.completedAtUtc ??= new Date(now()).toISOString()
        row.completedElapsedMs ??= monotonic() - start
        if (row.status !== 'late_success') {
          row.status = 'failed'
          row.safeCode ??= expired ? 'read_timeout' : 'provider_unavailable'
        }
        row.accepted = false
        stop(row.safeCode)
        throw Error('umbrella_history_provider_unavailable')
      } finally {
        controllers.delete(controller)
        options.signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', cancelStream)
        // Separate append-only, individually sealed evidence; never mutates a sealed capture.
        settlementReceipts.push(
          freeze(
            seal({
              schema: 'umbrella_history_physical_settlement_v1',
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
              reject(Error('umbrella_history_read_timeout'))
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
    if (closed) return Promise.reject(Error('umbrella_history_closed'))
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
        rowSha256: sha(canonical(row)),
      })),
    })
    return finished
  }
  return { fetcher: trackedFetch, beginStage, finish, stop, remaining, settlementReceipts }
}

/** Reauthentication is structural; only the exact private original object can select. */
function verifyPhysical(value, plan) {
  const r = value.receipt
  check(
    r.planSha256 === plan.planSha256 && canonical(r.settlements) === canonical(value.settlements),
    'plan_and_settlements',
  )
  check(
    r.physicalStarts === 146 &&
      r.pendingSettlements === 0 &&
      r.failure === null &&
      dense(r.ledger, 146) &&
      dense(r.terminalCommitments, 146),
    'terminal',
  )
  const rows = new Map(r.ledger.map((row) => [row.physicalId, row])),
    commits = new Map(r.terminalCommitments.map((row) => [row.physicalId, row.rowSha256]))
  check(rows.size === 146 && commits.size === 146, 'physical_duplicates')
  const expected = []
  for (const host of HOSTS)
    expected.push({ host, stage: 'chain', method: 'eth_chainId', params: [] })
  for (const a of plan.anchors)
    for (const host of HOSTS)
      for (const spec of a.requests)
        expected.push({ host, stage: 'anchor_' + a.cashIndex, ...spec.request })
  for (let i = 0; i < 146; i++) {
    const row = rows.get(i + 1),
      request = {
        jsonrpc: '2.0',
        id: i + 1,
        method: expected[i].method,
        params: expected[i].params,
      }
    check(
      row &&
        row.host === expected[i].host &&
        row.stage === expected[i].stage &&
        canonical(row.request) === canonical(request) &&
        commits.get(i + 1) === sha(canonical(row)),
      'physical_request',
    )
    check(
      row.accepted === true &&
        row.status === 'success' &&
        row.httpStatus === 200 &&
        Number.isFinite(row.startedElapsedMs) &&
        row.startedElapsedMs >= 0 &&
        row.completedElapsedMs >= row.startedElapsedMs,
      'physical_complete',
    )
    const requestBytes = Buffer.from(row.requestBodyBase64, 'base64'),
      bytes = Buffer.from(row.rawBodyBase64, 'base64')
    check(
      requestBytes.toString('base64') === row.requestBodyBase64 &&
        sha(requestBytes) === row.requestBodySha256 &&
        canonical(parseNativeJson(requestBytes.toString())) === canonical(request),
      'request_bytes',
    )
    check(
      bytes.toString('base64') === row.rawBodyBase64 &&
        bytes.length === row.bodyBytes &&
        bytes.length <= 65536 &&
        sha(bytes) === row.bodySha256,
      'response_bytes',
    )
    const envelope = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    check(
      keys(envelope, ['jsonrpc', 'id', 'result']) &&
        envelope.jsonrpc === '2.0' &&
        envelope.id === i + 1,
      'native_result',
    )
    if (i < 2) check(envelope.result === '0x1', 'chain')
    check(
      new NativeDate(row.startedAtUtc).toISOString() === row.startedAtUtc &&
        new NativeDate(row.completedAtUtc).toISOString() === row.completedAtUtc &&
        Date.parse(row.completedAtUtc) >= Date.parse(row.startedAtUtc),
      'physical_clock',
    )
  }
  check(dense(value.settlements, 146), 'settlements')
  const seen = new Set()
  for (const settled of value.settlements) {
    const { sha256, ...body } = settled
    check(
      !seen.has(settled.physicalId) &&
        sha256 === sha(canonical(body)) &&
        canonical(settled.observation) === canonical(rows.get(settled.physicalId)),
      'settlement_seal',
    )
    seen.add(settled.physicalId)
  }
  check(Buffer.byteLength(JSON.stringify(r)) <= 8 * 1024 * 1024, 'receipt_cap')
}
/** Fixed native pair and private plan, no request/provider/controller/clock override. */
export async function captureUmbrellaGhoJointHistoryBatch(plan) {
  nativeUnchanged()
  check(plans.has(plan) && !startedPlans.has(plan), 'original_plan')
  startedPlans.add(plan)
  reserve()
  const origins = await configuredUsd3HypotheticalOrigins()
  nativeUnchanged()
  check(dense(origins, 2) && origins.every((o, i) => o.host === HOSTS[i]), 'configured_pair')
  const tokens = secretTokens(origins),
    control = makeControl(origins, tokens)
  let accepted = false,
    receipt
  try {
    let id = 0
    const rpc = async (o, request) =>
      control.fetcher(o.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, ...request }),
      })
    control.beginStage('chain')
    for (const o of origins) await rpc(o, { method: 'eth_chainId', params: [] })
    for (const a of plan.anchors) {
      control.beginStage('anchor_' + a.cashIndex)
      for (const o of origins) for (const spec of a.requests) await rpc(o, spec.request)
    }
    accepted = true
  } catch {
    accepted = false
  } finally {
    const terminal = await control.finish()
    receipt = freeze({
      ...terminal,
      planSha256: plan.planSha256,
      settlements: structuredClone(control.settlementReceipts),
    })
  }
  const value = freeze({
    schema: 'umbrella_gho_joint_native_history_original_batch_v1',
    accepted,
    planSha256: plan.planSha256,
    receipt,
    settlements: receipt.settlements,
    originalAuthority: false,
    authenticated: false,
    historicalOwnership: false,
  })
  originals.set(value, { plan, value, tokens })
  return value
}
export function selectedOriginalUmbrellaGhoJointHistoryBatch(value, plan) {
  try {
    nativeUnchanged()
    const original = originals.get(value)
    check(
      original && original.plan === plan && value.planSha256 === plan.planSha256 && value.accepted,
      'original_batch',
    )
    verifyPhysical(value, plan)
    return original.value
  } catch {
    return null
  }
}

/** Privacy gate for raw retention, not native qualification. Tokens never leave this module. */
export function selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention(value) {
  try {
    nativeUnchanged()
    const original = originals.get(value)
    check(original, 'original_retention')
    const receipt = original.value.receipt,
      tokens = original.tokens
    check(!containsSecret(Buffer.from(JSON.stringify(receipt)), tokens), 'retention_privacy')
    for (const row of receipt.ledger)
      for (const field of ['requestBodyBase64', 'rawBodyBase64']) {
        if (row[field] === null) continue
        check(typeof row[field] === 'string', 'retention_body')
        const bytes = Buffer.from(row[field], 'base64')
        check(
          bytes.toString('base64') === row[field] && !containsSecret(bytes, tokens),
          'retention_privacy',
        )
      }
    return receipt
  } catch {
    return null
  }
}
