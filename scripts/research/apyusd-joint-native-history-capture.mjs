// Protected on-demand APY native acquisition. Import never performs reads or writes.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionResult } from 'viem'
import {
  configuredUsd3HypotheticalOrigins,
  createUsd3HypotheticalCaptureControl,
  parseUsd3HypotheticalJson,
} from './usd3-hypothetical-history-capture.mjs'
import * as codec from '../../lib/carry/apyUsdJointNativeEvidence.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const nativeFetch = globalThis.fetch,
  nativeNow = Date.now,
  NativeDate = Date
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
const plans = new WeakSet(),
  started = new WeakSet(),
  originals = new WeakMap()
const pick = (key) => codec[key] ?? codec.default?.[key]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const check = (v, code) => {
  if (!v) throw Error('apy_native_capture_' + code)
}
const canonical = (v) =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v)
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const seal = (v) => freeze({ ...v, sha256: sha(canonical(v)) })
function unchanged() {
  check(
    globalThis.fetch === nativeFetch && Date.now === nativeNow && Date === NativeDate,
    'native_changed',
  )
}
function reserve() {
  const s = statfsSync(ROOT)
  check(Number(s.bavail) * Number(s.bsize) >= 256 * 1024 * 1024, 'disk_reserve')
}
function own(value) {
  let count = 0,
    chars = 0
  const ancestors = new WeakSet()
  const copy = (v, depth) => {
    check(++count <= 2000 && depth <= 10, 'input_bound')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v) && v >= 0, 'input_number')
      return v
    }
    if (typeof v === 'string') {
      chars += v.length
      check(v.length <= 128 && chars <= 16384, 'input_string')
      return v
    }
    check(
      v &&
        typeof v === 'object' &&
        !ancestors.has(v) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),
      'input_plain',
    )
    ancestors.add(v)
    const ds = Object.getOwnPropertyDescriptors(v)
    check(
      Object.values(ds).every((d) => Object.hasOwn(d, 'value')),
      'input_accessor',
    )
    let out
    if (Array.isArray(v)) {
      check(v.length <= 64 && Object.getOwnPropertyNames(v).length === v.length + 1, 'input_dense')
      out = Array.from({ length: v.length }, (_, i) => {
        check(ds[i]?.enumerable, 'input_dense')
        return copy(ds[i].value, depth + 1)
      })
    } else {
      out = {}
      for (const [k, d] of Object.entries(ds)) {
        check(d.enumerable && !['__proto__', 'constructor', 'prototype'].includes(k), 'input_key')
        out[k] = copy(d.value, depth + 1)
      }
    }
    ancestors.delete(v)
    return out
  }
  return copy(value, 0)
}
function secretTokens(origins) {
  const tokens = new Set(),
    generic = new Set(['', 'v1', 'v2', 'v3', 'eth', 'ethereum', 'mainnet', 'rpc'])
  for (const o of origins) {
    const u = new URL(o.url)
    tokens.add(o.url)
    tokens.add(u.href)
    for (const x of u.pathname.split('/'))
      if (!generic.has(x.toLowerCase())) {
        tokens.add(x)
        try {
          tokens.add(decodeURIComponent(x))
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
/** Inspection-only privacy predicate; no plan or original authority is granted. */
export function apyUsdNativeCaptureContainsSecret(bytes, tokens) {
  check(
    Buffer.isBuffer(bytes) &&
      bytes.length <= 8 * 1024 * 1024 &&
      Array.isArray(tokens) &&
      tokens.length <= 128,
    'privacy_bound',
  )
  const text = bytes.toString('utf8'),
    forms = [text]
  let parsed
  try {
    parsed = parseUsd3HypotheticalJson(text)
  } catch {
    if (text.includes('\\')) return true
  }
  let nodes = 0
  const scan = (v, depth) => {
    check(++nodes <= 50000 && depth <= 20, 'privacy_tree_bound')
    if (typeof v === 'string') forms.push(v)
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        scan(k, depth + 1)
        scan(x, depth + 1)
      }
  }
  scan(parsed, 0)
  for (let pass = 0; pass < 3; pass++)
    for (const x of forms.slice()) {
      try {
        const decoded = decodeURIComponent(x)
        if (decoded !== x) forms.push(decoded)
      } catch {}
    }
  return forms.some((x) =>
    tokens.some((token) => typeof token === 'string' && token && x.includes(token)),
  )
}
function safeReceipt(receipt, tokens) {
  check(Buffer.byteLength(JSON.stringify(receipt)) <= 8 * 1024 * 1024, 'receipt_bound')
  for (const r of receipt.ledger)
    if (r.rawBodyBase64 !== null) {
      const b = Buffer.from(r.rawBodyBase64, 'base64')
      check(
        b.toString('base64') === r.rawBodyBase64 &&
          b.length <= 65536 &&
          !apyUsdNativeCaptureContainsSecret(b, tokens),
        'privacy_rejected',
      )
    }
  check(
    !apyUsdNativeCaptureContainsSecret(Buffer.from(JSON.stringify(receipt)), tokens),
    'privacy_rejected',
  )
  return receipt
}
function header(raw) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'header')
  const h = { number: raw.number, hash: raw.hash, timestamp: raw.timestamp }
  check(
    /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(h.number) &&
      /^0x[0-9a-f]{64}$/.test(h.hash) &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(h.timestamp),
    'header',
  )
  return h
}
function nativeData(error) {
  const candidates = []
  const visit = (v, depth) => {
    if (depth > 3) return
    if (typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v) && v.length <= 8194)
      candidates.push(v.toLowerCase())
    else if (v && typeof v === 'object')
      for (const k of ['data', 'originalError', 'cause'])
        if (Object.hasOwn(v, k)) visit(v[k], depth + 1)
  }
  visit(error.data, 0)
  return candidates.length && new Set(candidates).size === 1 ? candidates[0] : undefined
}
function decode(trace, name) {
  check(Object.hasOwn(trace, 'result') && typeof trace.result === 'string', 'dispatch_result')
  const abi = pick('APY_USD_JOINT_NATIVE_ABI')
  const value = decodeFunctionResult({ abi, functionName: name, data: trace.result })
  check(
    encodeFunctionResult({ abi, functionName: name, result: value }) === trace.result,
    'dispatch_canonical',
  )
  return value
}
/** Inspection-only peer comparison. Exact ERC721 selector/id is validated by the native codec. */
export function apyUsdNativeCandidateErrorsAgree(a, b) {
  return (
    !!a &&
    !!b &&
    [3, -32000, -32015].includes(a.code) &&
    [3, -32000, -32015].includes(b.code) &&
    typeof a.data === 'string' &&
    /^0x(?:[0-9a-f]{2})+$/.test(a.data) &&
    a.data.length <= 8194 &&
    a.data === b.data
  )
}
export function prepareApyUsdJointNativeCurrentCapturePlan(supplied) {
  unchanged()
  const binding = own(supplied),
    preparedAtUtc = new NativeDate(nativeNow()).toISOString()
  binding.acquiredAtUtc = preparedAtUtc
  // The browser-safe plan validator pins subject, source, candidates, units and bounds.
  pick('apyUsdJointNativeCurrentReadPlan')(binding, { stage: 'base' })
  const plan = seal({
    schema: 'apyusd_joint_native_current_capture_plan_v1',
    captureId: randomUUID(),
    binding,
    preparedAtUtc,
    maxControls: 6,
    maxPhysicalStarts: 828,
    originalAuthority: false,
    authenticated: false,
  })
  plans.add(plan)
  return plan
}
export function prepareApyUsdJointNativeHistoryCapturePlan(supplied) {
  unchanged()
  const input = own(supplied)
  check(
    Object.keys(input).sort().join(',') ===
      'batchIndex,fullSharesRaw,currentSource,currentRuntimeRegime,vestingAddress,vaultUnlockingFeeWad'
        .split(',')
        .sort()
        .join(',') &&
      Number.isInteger(input.batchIndex) &&
      input.batchIndex >= 0 &&
      input.batchIndex < 4,
    'history_input',
  )
  const preparedAtUtc = new NativeDate(nativeNow()).toISOString()
  const anchors = pick('APY_USD_JOINT_NATIVE_ANCHORS')
    .slice(input.batchIndex * 2, input.batchIndex * 2 + 2)
    .map((a) => {
      const binding = {
        cashIndex: a.cashIndex,
        source: a.source,
        currentSource: input.currentSource,
        fullSharesRaw: input.fullSharesRaw,
        currentRuntimeRegime: input.currentRuntimeRegime,
        vestingAddress: input.vestingAddress,
        vaultUnlockingFeeWad: input.vaultUnlockingFeeWad,
        owner: null,
        acquiredAtUtc: preparedAtUtc,
      }
      const requests = pick('apyUsdJointNativeHistoryReadPlan')(binding)
      check(requests.length <= 27, 'history_read_budget')
      return { binding, requests }
    })
  check(anchors.length === 2, 'history_anchors')
  const plan = seal({
    schema: 'apyusd_joint_native_history_capture_plan_v1',
    captureId: randomUUID(),
    batchIndex: input.batchIndex,
    preparedAtUtc,
    anchors,
    maxPhysicalStarts: 110,
    owner: null,
    historicalOwnership: false,
    sourceClass: 'captured_identical_runtimes_only',
    originalAuthority: false,
    authenticated: false,
  })
  plans.add(plan)
  return plan
}
async function originsFor(plan) {
  unchanged()
  reserve()
  check(plans.has(plan) && !started.has(plan), 'original_plan')
  started.add(plan)
  const origins = await configuredUsd3HypotheticalOrigins()
  unchanged()
  check(origins.length === 2 && origins.every((o, i) => o.host === HOSTS[i]), 'configured_origins')
  return origins
}
function session(origins, parent, phaseIndex) {
  unchanged()
  reserve()
  const control = createUsd3HypotheticalCaptureControl(origins)
  const requests = [],
    observations = [],
    phasePlan = seal({
      schema: 'apyusd_joint_native_phase_plan_v1',
      parentPlanSha256: parent.sha256,
      phaseIndex,
      sourceBinding: parent.binding ?? parent.anchors.map((a) => a.binding),
      maxPhysicalStarts: parent.binding ? 128 : 110,
      originalAuthority: false,
      authenticated: false,
    })
  let id = 0
  const rpc = async (originIndex, spec) => {
    unchanged()
    reserve()
    check(id < phasePlan.maxPhysicalStarts, 'physical_cap')
    const request = { jsonrpc: '2.0', id: ++id, ...spec.request },
      body = JSON.stringify(request)
    const originalRequest = {
      rpcId: id,
      physicalId: null,
      host: HOSTS[originIndex],
      key: spec.key,
      requestBodyBase64: Buffer.from(body).toString('base64'),
      requestBodySha256: sha(body),
    }
    requests.push(originalRequest)
    const response = await control.fetcher(origins[originIndex].url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const physicalId = Number(response.headers.get('x-usd3-physical-id'))
    check(
      Number.isSafeInteger(physicalId) &&
        physicalId > 0 &&
        physicalId <= phasePlan.maxPhysicalStarts,
      'physical_identity',
    )
    originalRequest.physicalId = physicalId
    const envelope = parseUsd3HypotheticalJson(await response.text())
    check(envelope.id === request.id && envelope.jsonrpc === '2.0', 'response_identity')
    const trace = { key: spec.key, request: structuredClone(spec.request) }
    if (Object.hasOwn(envelope, 'result')) trace.result = envelope.result
    else {
      check(envelope.error && Number.isSafeInteger(envelope.error.code), 'native_error')
      const data = nativeData(envelope.error)
      trace.error = {
        code: envelope.error.code,
        message: 'native_error',
        ...(data === undefined ? {} : { data }),
      }
    }
    observations.push({ physicalId, originIndex, trace })
    return { physicalId, trace }
  }
  const pair = (spec) => Promise.all(origins.map((_o, i) => rpc(i, spec)))
  const finish = async () => {
    const terminal = await control.finish()
    for (const r of requests)
      if (r.physicalId === null)
        r.physicalId = terminal.ledger.find((row) => row.request.id === r.rpcId)?.physicalId ?? null
    return {
      plan: phasePlan,
      receipt: seal({
        ...terminal,
        requests,
        parentPlanSha256: parent.sha256,
        settlements: structuredClone(control.settlementReceipts),
      }),
      observations,
    }
  }
  return { control, pair, finish }
}
function verify(batch) {
  const receipt = batch.receipt
  check(
    receipt.pendingSettlements === 0 &&
      receipt.failure === null &&
      receipt.physicalStarts <= batch.plan.maxPhysicalStarts &&
      receipt.ledger.length === receipt.physicalStarts &&
      receipt.requests.length === receipt.physicalStarts &&
      receipt.terminalCommitments.length === receipt.physicalStarts &&
      batch.observations.length === receipt.physicalStarts,
    'physical_terminal',
  )
  const rows = new Map(receipt.ledger.map((r) => [r.physicalId, r]))
  const commits = new Map(receipt.terminalCommitments.map((r) => [r.physicalId, r.rowSha256]))
  const joins = new Map(receipt.requests.map((r) => [r.physicalId, r]))
  check(
    rows.size === receipt.physicalStarts && commits.size === rows.size && joins.size === rows.size,
    'physical_duplicate',
  )
  for (const observed of batch.observations) {
    const row = rows.get(observed.physicalId),
      req = joins.get(observed.physicalId)
    check(
      row &&
        req &&
        row.host === HOSTS[observed.originIndex] &&
        req.host === row.host &&
        row.accepted === true &&
        row.status === 'success' &&
        row.httpStatus === 200 &&
        commits.get(row.physicalId) === sha(JSON.stringify(row)),
      'physical_commitment',
    )
    const requestBytes = Buffer.from(req.requestBodyBase64, 'base64'),
      responseBytes = Buffer.from(row.rawBodyBase64, 'base64')
    check(
      requestBytes.toString('base64') === req.requestBodyBase64 &&
        sha(requestBytes) === req.requestBodySha256 &&
        canonical(parseUsd3HypotheticalJson(requestBytes.toString())) === canonical(row.request) &&
        canonical(observed.trace.request) ===
          canonical({ method: row.request.method, params: row.request.params }),
      'request_proof',
    )
    check(
      responseBytes.toString('base64') === row.rawBodyBase64 &&
        responseBytes.length <= 65536 &&
        responseBytes.length === row.bodyBytes &&
        sha(responseBytes) === row.bodySha256,
      'response_proof',
    )
    const envelope = parseUsd3HypotheticalJson(
      new TextDecoder('utf8', { fatal: true }).decode(responseBytes),
    )
    check(
      envelope.jsonrpc === '2.0' &&
        envelope.id === row.request.id &&
        (Object.hasOwn(envelope, 'result')
          ? canonical(envelope.result) === canonical(observed.trace.result)
          : observed.trace.error?.code === envelope.error?.code &&
            observed.trace.error?.data === nativeData(envelope.error)),
      'response_join',
    )
    check(
      new NativeDate(row.startedAtUtc).toISOString() === row.startedAtUtc &&
        new NativeDate(row.completedAtUtc).toISOString() === row.completedAtUtc &&
        Date.parse(row.completedAtUtc) >= Date.parse(row.startedAtUtc) &&
        row.completedElapsedMs >= row.startedElapsedMs,
      'physical_clock',
    )
  }
  check(
    receipt.settlements.length === receipt.physicalStarts &&
      new Set(receipt.settlements.map((s) => s.physicalId)).size === rows.size,
    'physical_settlements',
  )
  for (const s of receipt.settlements) {
    const { sha256, ...body } = s
    check(
      sha256 === sha(JSON.stringify(body)) &&
        canonical(s.observation) === canonical(rows.get(s.physicalId)),
      'settlement_seal',
    )
  }
}
function projected(batch, observed) {
  const row = batch.receipt.ledger.find((r) => r.physicalId === observed.physicalId)
  const request = batch.receipt.requests.find((r) => r.physicalId === observed.physicalId)
  const trace = structuredClone(observed.trace)
  if (trace.request.method === 'eth_getBlockByNumber' && Object.hasOwn(trace, 'result'))
    trace.result = header(trace.result)
  return {
    ...trace,
    startedAtUtc: row.startedAtUtc,
    completedAtUtc: row.completedAtUtc,
    requestBodySha256: request.requestBodySha256,
    responseBodySha256: row.bodySha256,
  }
}
function publish(plan, batches, wire, tokens, accepted) {
  let privacyRejected = false
  const publicBatches = batches.map((b) => {
    try {
      safeReceipt(b.receipt, tokens)
      return freeze({ plan: b.plan, receipt: b.receipt })
    } catch {
      privacyRejected = true
      return freeze({
        plan: b.plan,
        receipt: seal({
          schema: 'apyusd_privacy_rejected_receipt_v1',
          physicalStarts: b.receipt.physicalStarts,
          failure: 'privacy_rejected',
          rawBodiesRetained: false,
          bodyDigests: b.receipt.ledger.map((r) => ({
            physicalId: r.physicalId,
            bodyBytes: r.bodyBytes,
            bodySha256: r.bodySha256,
          })),
          originalAuthority: false,
          authenticated: false,
        }),
      })
    }
  })
  const value = freeze({
    schema: 'apyusd_joint_native_original_capture_v1',
    accepted: accepted && !privacyRejected,
    privacyRejected,
    planSha256: plan.sha256,
    batches: publicBatches,
    wire: privacyRejected ? null : wire,
    originalAuthority: false,
    authenticated: false,
    historicalOwnership: false,
  })
  originals.set(value, { plan, batches, tokens, value })
  return value
}
/** Default controls only: at most six controls/828 starts; no caller controller/client/clock. */
export async function captureApyUsdJointNativeCurrent(plan) {
  const origins = await originsFor(plan),
    tokens = secretTokens(origins),
    batches = [],
    phaseRefs = [],
    logical = []
  let active,
    refs,
    count = 0,
    accepted = false,
    wire = null
  const source = plan.binding.source
  const headSpec = (key) => ({
    key,
    request: {
      method: 'eth_getBlockByNumber',
      params: ['0x' + source.blockNumber.toString(16), false],
    },
  })
  const close = async () => {
    if (!active) return
    active.control.beginStage('current_phase_end')
    refs.after = await active.pair(headSpec('phase_header_after'))
    const batch = await active.finish()
    batches.push(batch)
    phaseRefs.push(refs)
    active = null
  }
  const startPhase = async () => {
    check(batches.length < 6, 'current_control_budget')
    active = session(origins, plan, batches.length)
    refs = {}
    count = 0
    active.control.beginStage('current_phase_witnesses')
    refs.chain = await active.pair({ key: 'chain', request: { method: 'eth_chainId', params: [] } })
    refs.finalized = await active.pair({
      key: 'finalized',
      request: { method: 'eth_getBlockByNumber', params: ['finalized', false] },
    })
    refs.before = await active.pair(headSpec('phase_header_before'))
  }
  const run = async (specs) => {
    const results = []
    for (const spec of specs) {
      if (!active) await startPhase()
      if (count === 60) {
        await close()
        await startPhase()
      }
      if (count % 8 === 0) active.control.beginStage('current_group_' + Math.floor(count / 8))
      const pair = await active.pair(spec)
      logical.push({ phaseIndex: batches.length, pair })
      results.push(pair.map((x) => x.trace))
      count++
    }
    return results
  }
  try {
    const base = await run(
      pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, { stage: 'base' }),
    )
    const baseKeys = pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, { stage: 'base' }).map(
      (x) => x.key,
    )
    const lookup = (key) => base[baseKeys.indexOf(key)]
    const S = lookup('full_shares').map((t) => decode(t, 'balanceOf').toString())
    check(S[0] === S[1], 'shares_disagreement')
    const vesting = lookup('vesting_address').map((t) => decode(t, 'vesting').toLowerCase())
    check(vesting[0] === vesting[1], 'vesting_disagreement')
    const owners = await run(
      pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, { stage: 'candidate_owners' }),
    )
    const owned = []
    owners.forEach((pair, i) => {
      const states = pair.map((t) =>
        Object.hasOwn(t, 'result') ? decode(t, 'ownerOf').toLowerCase() : null,
      )
      check(
        states[0] === states[1] &&
          (states[0] !== null || apyUsdNativeCandidateErrorsAgree(pair[0].error, pair[1].error)),
        'ownership_disagreement',
      )
      if (states[0] === plan.binding.owner) owned.push(plan.binding.candidateReceiptIds[i])
    })
    await run(
      pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, {
        stage: 'owned_receipts',
        ownedReceiptIds: owned,
      }),
    )
    const quotes = await run(
      pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, {
        stage: 'share_quote',
        fullSharesRaw: S[0],
      }),
    )
    const Ea = quotes[0].map((t) => decode(t, 'previewRedeem').toString())
    check(Ea[0] === Ea[1], 'entitlement_disagreement')
    await run(
      pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, {
        stage: 'initiation_simulation',
        fullEscrowEaRaw: Ea[0],
      }),
    )
    await run(
      pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, {
        stage: 'vesting',
        vestingAddress: vesting[0],
      }),
    )
    await run(pick('apyUsdJointNativeCurrentReadPlan')(plan.binding, { stage: 'end' }))
    await close()
    batches.forEach(verify)
    wire = {
      origins: HOSTS.map((host, origin) => {
        const phases = phaseRefs.map((r, phase) => {
          const batch = batches[phase]
          const out = {
            chainIdTrace: projected(batch, r.chain[origin]),
            finalizedTrace: projected(batch, r.finalized[origin]),
            headerBeforeTrace: projected(batch, r.before[origin]),
            headerAfterTrace: projected(batch, r.after[origin]),
          }
          return {
            ...out,
            acquiredAtUtc: new NativeDate(
              Math.max(...Object.values(out).map((t) => Date.parse(t.completedAtUtc))),
            ).toISOString(),
          }
        })
        const traces = logical.map((r) => projected(batches[r.phaseIndex], r.pair[origin]))
        return {
          host,
          phases,
          traces,
          acquiredAtUtc: new NativeDate(
            Math.max(
              ...traces.map((t) => Date.parse(t.completedAtUtc)),
              ...phases.map((p) => Date.parse(p.acquiredAtUtc)),
            ),
          ).toISOString(),
        }
      }),
    }
    accepted = true
  } catch {
    if (active) {
      active.control.stop('capture_rejected')
      batches.push(await active.finish())
      active = null
    }
  }
  return publish(plan, batches, wire, tokens, accepted)
}
/** Exactly two fixed anchors, at most110 starts, one unchanged default138 controller. */
export async function captureApyUsdJointNativeHistoryBatch(plan) {
  const origins = await originsFor(plan),
    tokens = secretTokens(origins),
    active = session(origins, plan, 0)
  const refs = [],
    chains = [],
    batches = []
  let accepted = false,
    wire = null
  try {
    active.control.beginStage('history_chain')
    chains.push(
      ...(await active.pair({ key: 'chain', request: { method: 'eth_chainId', params: [] } })),
    )
    for (const anchor of plan.anchors) {
      const rows = []
      for (let i = 0; i < anchor.requests.length; i++) {
        if (i % 8 === 0)
          active.control.beginStage(
            'history_' + anchor.binding.cashIndex + '_group_' + Math.floor(i / 8),
          )
        rows.push(await active.pair(anchor.requests[i]))
      }
      refs.push(rows)
    }
    batches.push(await active.finish())
    verify(batches[0])
    wire = plan.anchors.map((anchor, n) => ({
      binding: anchor.binding,
      wire: {
        origins: HOSTS.map((host, o) => {
          const traces = refs[n].map((row) => projected(batches[0], row[o])),
            chainIdTrace = projected(batches[0], chains[o])
          return {
            host,
            traces,
            chainIdTrace,
            acquiredAtUtc: new NativeDate(
              Math.max(...traces.map((t) => Date.parse(t.completedAtUtc))),
            ).toISOString(),
          }
        }),
      },
    }))
    accepted = true
  } catch {
    active.control.stop('capture_rejected')
    if (!batches.length) batches.push(await active.finish())
  }
  return publish(plan, batches, wire, tokens, accepted)
}
/** Only the exact native private plan/object selects; cloned/serialized receipts cannot. */
export function selectedOriginalApyUsdJointNativeCapture(value, plan) {
  try {
    unchanged()
    const original = originals.get(value)
    check(
      original && original.plan === plan && value.accepted && !value.privacyRejected,
      'original_capture',
    )
    original.batches.forEach((b) => {
      safeReceipt(b.receipt, original.tokens)
      verify(b)
    })
    return value
  } catch {
    return null
  }
}
/** Retention gate grants privacy permission only, never replay or execution authority. */
export function selectedOriginalApyUsdJointNativeReceiptsForRetention(value) {
  try {
    unchanged()
    const original = originals.get(value)
    check(original, 'original_retention')
    if (!value.privacyRejected)
      original.batches.forEach((b) => safeReceipt(b.receipt, original.tokens))
    return value.batches
  } catch {
    return null
  }
}
