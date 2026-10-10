/** Manual actual-handler observer. Default/check is offline; capture requires explicit approval. */
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
  statfsSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { boundedReceiptBudget, readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const pick = (m, key) => m[key] ?? m.default?.[key]
const fail = (code) => {
  throw Object.assign(Error(code), { safeCode: code })
}
const requireFact = (fact, code) => {
  if (!fact) fail(code)
}
const utc = (ms) => new Date(ms).toISOString()
const primitiveUtc = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  utc(Date.parse(value)) === value
const raw = (value) =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n
export const LIMITS = Object.freeze({
  requests: 80,
  deadlineMs: 60000,
  rpcMs: 8000,
  cleanupMs: 250,
  responseBytes: 131072,
  artifactBytes: 2097152,
  reserveBytes: 1073741824,
  spacingMs: 50,
})
const LOCATORS = Object.freeze({
  susds: Object.freeze({
    file: 'carry-public-susds-exit-issues/00000001.json',
    seal: '7f787e6913f8dd9afcaf6161f2f52dc9ef60a29d04bd07f26d1530769deac171',
    owner: '0x688cc76d3b009d805ab6b4d0a1cbd228131b5cbf',
    routeKey: 'USDS → SUsds [USDS]',
    destination: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    decimals: 18,
    symbol: 'USDS',
  }),
  comet: Object.freeze({
    file: 'carry-local-compound-holder-issues/00000001.json',
    seal: '57a268ea0d17303b8e23e3484ff8c6b123c26fff087a3f934ed71640e9bb96c1',
    owner: '0x7904ca17b51b1aded2a5fdd8271711dc3e92e1fb',
    routeKey: 'USDC → supply on Compound v3',
    destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    symbol: 'USDC',
  }),
  stusds: Object.freeze({
    file: 'carry-public-stusds-exit-issues/00000001.json',
    seal: '9ca7a448fe845c7302698bcef0a76478b8154eae4e9442a5b755e865a759150c',
    owner: '0x912dbf3e58232de54f3d108dbb05d87b47c2fb61',
    routeKey: 'USDS → StUsds [USDS]',
    destination: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    decimals: 18,
    symbol: 'USDS',
  }),
})
export function loadSubjects(name) {
  requireFact(name === undefined || Object.hasOwn(LOCATORS, name), 'unknown_subject')
  const budget = boundedReceiptBudget({ maxRecords: 3, maxTotalBytes: 3 * 2097152 }, 3, 2097152)
  return (name ? [name] : ['susds', 'comet']).map((kind) => {
    const seed = LOCATORS[kind],
      bytes = readBoundedReceiptFile(ROOT + 'data/research/venue-signals/' + seed.file, budget),
      value = JSON.parse(bytes)
    const { sha256, ...body } = value
    requireFact(
      sha256 === seed.seal &&
        sha(JSON.stringify(body)) === seed.seal &&
        value.sequence === 1 &&
        value.previousSha256 === null &&
        value.candidate?.holder === seed.owner,
      'locator_seal_or_owner',
    )
    return Object.freeze({
      ...seed,
      kind,
      requestedRaw: String(10n ** BigInt(seed.decimals)),
      locatorFileSha256: sha(bytes),
      locatorIsCurrentAuthority: false,
    })
  })
}
export function safeFailureFacts(error, stage) {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'])
  const frames =
    typeof error?.stack === 'string'
      ? error.stack
          .split('\n')
          .slice(1, 9)
          .flatMap((line) => {
            const match = line.match(
              /\/Users\/EBmic\/membrane-app\/(scripts|pages|components|lib)\/([A-Za-z0-9_./-]+):([0-9]+):([0-9]+)/,
            )
            return match
              ? [
                  {
                    file: match[1] + '/' + match[2],
                    line: Number(match[3]),
                    column: Number(match[4]),
                  },
                ]
              : []
          })
          .slice(0, 3)
      : []
  return {
    stage: typeof stage === 'string' && /^[a-z_]{1,40}$/.test(stage) ? stage : null,
    errorName: names.has(error?.name) ? error.name : 'Error',
    frames,
  }
}
function safeCause(error) {
  for (let i = 0; error && i < 6; i++, error = error.cause)
    if (
      [
        'EAI_AGAIN',
        'ENOTFOUND',
        'EPERM',
        'EACCES',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ECONNRESET',
        'ENETUNREACH',
        'UND_ERR_CONNECT_TIMEOUT',
      ].includes(error.code)
    )
      return error.code
  return 'transport_failure'
}
const METHODS = new Set([
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_call',
  'eth_getCode',
  'eth_getStorageAt',
])
function publicRpc(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0')
    fail('rpc_response_shape')
  if (value.error) {
    requireFact(Number.isSafeInteger(value.error.code), 'rpc_error_code')
    const error = { code: value.error.code }
    if (typeof value.error.data === 'string' && /^0x[0-9a-f]*$/i.test(value.error.data))
      error.data = value.error.data
    return { jsonrpc: '2.0', id: value.id, error }
  }
  requireFact(Object.hasOwn(value, 'result'), 'rpc_result_missing')
  // Public state can contain only addresses, hex, headers and integers, never endpoint strings.
  requireFact(
    !/https?:\/\/|api[_-]?key|authorization/i.test(JSON.stringify(value.result)),
    'rpc_result_secret_shape',
  )
  return { jsonrpc: '2.0', id: value.id, result: value.result }
}
/** Wrap before imports. Original bounded reply bytes are returned unchanged to the real SDK. */
export function createObservedFetch(
  originUrls,
  { fetcher = globalThis.fetch, now = Date.now, limits = LIMITS } = {},
) {
  const urls = structuredClone(originUrls)
  requireFact(
    Array.isArray(urls) &&
      urls.length === 2 &&
      urls.every((u) => typeof u === 'string' && new URL(u).protocol === 'https:'),
    'approved_origins',
  )
  const hosts = urls.map((u) => new URL(u).hostname.toLowerCase().replace(/\.+$/, ''))
  requireFact(
    new Set(hosts).size === 2 &&
      hosts.includes('eth-mainnet.g.alchemy.com') &&
      hosts.includes('rpc.ankr.com'),
    'approved_hosts',
  )
  const started = now(),
    deadline = started + limits.deadlineMs,
    overall = new AbortController(),
    traces = [],
    queues = [Promise.resolve(), Promise.resolve()],
    last = [0, 0]
  let starts = 0,
    stopped = null,
    closed = false,
    proofBytes = 0
  const close = (code) => {
    stopped ??= code
    closed = true
    overall.abort()
  }
  const deadlineTimer = setTimeout(() => close('network_deadline'), limits.deadlineMs)
  deadlineTimer.unref?.()
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function observed(url, init = {}) {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : null,
      hostIndex = urls.indexOf(stringUrl)
    if (hostIndex < 0) {
      close('unapproved_endpoint')
      fail('unapproved_endpoint')
    }
    const snapshot = structuredClone({ body: init.body, method: init.method ?? 'POST' })
    requireFact(
      snapshot.method === 'POST' &&
        typeof snapshot.body === 'string' &&
        Buffer.byteLength(snapshot.body) <= 32768,
      'rpc_request_body',
    )
    const request = JSON.parse(snapshot.body)
    requireFact(
      request &&
        !Array.isArray(request) &&
        request.jsonrpc === '2.0' &&
        METHODS.has(request.method) &&
        (Array.isArray(request.params) ||
          (request.method === 'eth_chainId' && !Object.hasOwn(request, 'params'))) &&
        (request.method !== 'eth_chainId' ||
          request.params === undefined ||
          request.params.length === 0) &&
        !/https?:\/\//i.test(JSON.stringify(request.params)),
      'readonly_rpc_request',
    )
    // Freeze public params before queuing; caller mutations cannot change an approved request.
    const pinnedRequest = structuredClone(request),
      incoming = init.signal
    const job = queues[hostIndex]
      .catch(() => {})
      .then(async () => {
        if (last[hostIndex]) await delay(Math.max(0, last[hostIndex] + limits.spacingMs - now()))
        if (closed || now() >= deadline || incoming?.aborted) fail(stopped ?? 'network_closed')
        if (starts >= limits.requests) {
          close('physical_request_limit')
          fail('physical_request_limit')
        }
        const startMs = now(),
          trace = {
            physicalRequest: ++starts,
            host: hosts[hostIndex],
            startedAtUtc: utc(startMs),
            request: pinnedRequest,
            requestBodySha256: sha(snapshot.body),
          }
        traces.push(trace)
        const controller = new AbortController(),
          abort = () => controller.abort(),
          signals = [overall.signal, incoming].filter(Boolean)
        signals.forEach((signal) => signal.addEventListener('abort', abort, { once: true }))
        let settled = false,
          timer
        const work = (async () => {
          const response = await fetcher(stringUrl, {
            ...init,
            body: snapshot.body,
            redirect: 'error',
            signal: controller.signal,
          })
          requireFact(response.status >= 200 && response.status < 300, 'rpc_http_failure')
          requireFact(
            response.body && typeof response.body.getReader === 'function',
            'rpc_stream_missing',
          )
          const reader = response.body.getReader(),
            chunks = []
          let length = 0
          try {
            for (;;) {
              const part = await reader.read()
              if (part.done) break
              length += part.value.byteLength
              if (length > limits.responseBytes) {
                trace.localFailure = 'rpc_response_limit'
                controller.abort()
                void reader.cancel().catch(() => {})
                fail('rpc_response_limit')
              }
              chunks.push(Buffer.from(part.value))
            }
          } finally {
            reader.releaseLock()
          }
          const bytes = Buffer.concat(chunks),
            text = bytes.toString('utf8')
          requireFact(Buffer.from(text).equals(bytes), 'rpc_utf8')
          const parsed = JSON.parse(text)
          requireFact(parsed.id === pinnedRequest.id, 'rpc_id_mismatch')
          trace.response = publicRpc(parsed)
          trace.httpStatus = response.status
          trace.responseBytes = bytes.length
          proofBytes += Buffer.byteLength(JSON.stringify(trace))
          requireFact(proofBytes <= limits.artifactBytes - 262144, 'wire_artifact_limit')
          // EVM reverts are genuine stage observations. Provider/transport errors close the run.
          if (
            parsed.error &&
            !(
              parsed.error.code === 3 ||
              ([-32000, -32015].includes(parsed.error.code) &&
                /execution reverted|revert opcode/i.test(
                  typeof parsed.error.message === 'string' ? parsed.error.message : '',
                ))
            )
          )
            fail('rpc_provider_error')
          return new Response(bytes, {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          })
        })().finally(() => {
          settled = true
        })
        work.catch(() => {})
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort()
              reject(Object.assign(Error('rpc_timeout'), { safeCode: 'rpc_timeout' }))
            },
            Math.min(limits.rpcMs, Math.max(1, deadline - now())),
          )
        })
        const aborted = new Promise((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(Object.assign(Error('rpc_aborted'), { safeCode: 'rpc_aborted' })),
            { once: true },
          ),
        )
        try {
          return await Promise.race([work, timeout, aborted])
        } catch (error) {
          controller.abort()
          await Promise.race([work.catch(() => {}), delay(limits.cleanupMs)])
          trace.failure = settled
            ? (trace.localFailure ?? error.safeCode ?? safeCause(error))
            : 'rpc_abort_unsettled'
          trace.settled = settled
          close(trace.failure)
          fail(trace.failure)
        } finally {
          clearTimeout(timer)
          signals.forEach((signal) => signal.removeEventListener('abort', abort))
          trace.completedAtUtc = utc(now())
          trace.elapsedMs = now() - startMs
          trace.settled ??= settled
          last[hostIndex] = now()
        }
      })
    queues[hostIndex] = job.then(
      () => {},
      () => {},
    )
    return job
  }
  return {
    fetch: observed,
    traces,
    async finish() {
      closed = true
      clearTimeout(deadlineTimer)
      overall.abort()
      await Promise.all(queues)
      return {
        physicalStarts: starts,
        networkingMs: now() - started,
        stopReason: stopped,
        allSettled: traces.every((t) => t.settled === true),
      }
    },
  }
}

async function invoke(handler, req) {
  let body,
    status = 200
  const headers = {}
  await handler(req, {
    setHeader(k, v) {
      headers[k.toLowerCase()] = v
      return this
    },
    status(n) {
      status = n
      return this
    },
    json(v) {
      body = v
      return this
    },
  })
  requireFact(body !== undefined, 'api_no_response')
  const bytes = JSON.stringify(body)
  requireFact(Buffer.byteLength(bytes) <= LIMITS.artifactBytes / 2, 'api_body_limit')
  return { status, cacheControl: headers['cache-control'], body, bodySha256: sha(bytes) }
}
export function safeHttpFacts(response) {
  const errors = new Set([
    'invalid_forecast_question',
    'unknown_route_destination',
    'local_cash_subject_unverified',
    'local_cash_evidence_unavailable',
    'route_forecast_evidence_unavailable',
    'forecast_series_truncated',
    'holder_exit_assessment_unavailable',
    'invalid_holder_exit_request',
  ])
  const tokens =
    typeof response?.cacheControl === 'string'
      ? response.cacheControl
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter(
            (s) =>
              ['no-store', 'no-cache', 'private', 'public', 'must-revalidate'].includes(s) ||
              /^max-age=[0-9]{1,10}$/.test(s),
          )
      : []
  return {
    httpStatus:
      Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
        ? response.status
        : null,
    cacheControlTokens: tokens,
    errorCode: errors.has(response?.body?.error) ? response.body.error : null,
  }
}
function fresh(current, at) {
  requireFact(
    typeof current?.block === 'string' &&
      /^[1-9][0-9]*$/.test(current.block) &&
      Number.isSafeInteger(Number(current.block)) &&
      typeof current.blockHash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(current.blockHash) &&
      primitiveUtc(current.observedAt),
    'source_shape',
  )
  const readAt = current.readAtUtc ?? current.firstLocalReceiptAt
  requireFact(
    primitiveUtc(readAt) &&
      Date.parse(readAt) >= Date.parse(current.observedAt) &&
      Date.parse(readAt) <= at,
    'source_read_clock',
  )
  requireFact(
    at >= Date.parse(current.observedAt) && at - Date.parse(current.observedAt) <= 1800000,
    'source_expired_or_future',
  )
}
export async function loadRuntimeModules() {
  const [forecast, holder, wb, card, cap, viem] = await Promise.all([
    import('../../pages/api/carry/forecast.ts'),
    import('../../pages/api/carry/holder-exit-assessment.ts'),
    import('../../components/Carry/ForecastWorkbench.tsx'),
    import('../../components/Carry/ExitPressureCard.tsx'),
    import('../../lib/carry/holderExitCapacity.ts'),
    import('viem'),
  ])
  const result = {
    forecast: pick(forecast, 'carryForecastRequest'),
    holder: typeof holder.default === 'function' ? holder.default : holder.default?.default,
    wb: Object.fromEntries(
      [
        'withBoundSampledCashCurrentMetadata',
        'matchingHolderForecastSourceReference',
        'holderCapacityAgreementFromResponse',
        'holderTimeProcessIssueFromResponse',
      ].map((key) => [key, pick(wb, key)]),
    ),
    card: Object.fromEntries(
      ['ExitPressureCard', 'issuedCashHolderTimeInputForCard', 'selectedSusdsCashForCard'].map(
        (key) => [key, pick(card, key)],
      ),
    ),
    cap: { selectedHolderExitCapacity: pick(cap, 'selectedHolderExitCapacity') },
    viem,
  }
  requireFact(
    typeof result.forecast === 'function' &&
      typeof result.holder === 'function' &&
      [
        ...Object.values(result.wb),
        ...Object.values(result.card),
        ...Object.values(result.cap),
      ].every((value) => typeof value === 'function'),
    'runtime_export_missing',
  )
  return result
}
export async function preflight(name, { importHandlers = true } = {}) {
  requireFact(process.env.NODE_ENV === 'development', 'next_development_mode_required')
  const subjects = loadSubjects(name)
  const { configuredProviders, readProviderPolicy } =
    await import('./carry-depth-quote-archive.mjs')
  const policy = readProviderPolicy()
  requireFact(
    policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
    'active_provider_policy_required',
  )
  const providers = configuredProviders(null, policy),
    urls = providers.map((p) => p.url)
  await createObservedFetch(urls).finish() // Validate immutable exact configured pair; no physical requests.
  if (importHandlers) {
    const previous = globalThis.fetch
    globalThis.fetch = async () => fail('preflight_network_forbidden')
    try {
      await loadRuntimeModules()
    } finally {
      globalThis.fetch = previous
    }
  }
  return { subjects, policyId: policy.policyId, hosts: providers.map((p) => p.host), urls }
}
/** Evidence must carry real start order and an exact numeric-header enclosure. */
export function requireWireEnclosure(
  traces,
  host,
  source,
  states,
  { numericCashPin = false } = {},
) {
  requireFact(Array.isArray(traces) && states.length > 0, 'wire_enclosure_missing')
  let previous = 0
  for (const t of traces) {
    requireFact(
      Number.isSafeInteger(t.physicalRequest) &&
        t.physicalRequest > previous &&
        primitiveUtc(t.startedAtUtc) &&
        primitiveUtc(t.completedAtUtc) &&
        Date.parse(t.completedAtUtc) >= Date.parse(t.startedAtUtc) &&
        Date.parse(t.completedAtUtc) - Date.parse(t.startedAtUtc) <=
          LIMITS.rpcMs + LIMITS.cleanupMs,
      'wire_trace_chronology',
    )
    previous = t.physicalRequest
  }
  const relevant = states.map((t) => {
    requireFact(
      traces.includes(t) && t.host === host && t.settled === true,
      'wire_state_membership',
    )
    const tag = t.request.params.at(-1)
    requireFact(
      (tag?.blockHash === source.blockHash && tag.requireCanonical === true) ||
        (numericCashPin &&
          typeof tag === 'string' &&
          /^0x[0-9a-f]+$/.test(tag) &&
          BigInt(tag) === BigInt(source.block)),
      'wire_state_pin',
    )
    return t
  })
  const headers = traces
    .filter(
      (t) =>
        t.host === host &&
        t.request.method === 'eth_getBlockByNumber' &&
        typeof t.request.params[0] === 'string' &&
        /^0x[0-9a-f]+$/.test(t.request.params[0]) &&
        BigInt(t.request.params[0]) === BigInt(source.block) &&
        t.response?.result?.hash === source.blockHash,
    )
    .filter((t) => {
      const h = t.response.result
      return (
        typeof h.number === 'string' &&
        /^0x[0-9a-f]+$/.test(h.number) &&
        BigInt(h.number) === BigInt(source.block) &&
        typeof h.timestamp === 'string' &&
        /^0x[0-9a-f]+$/.test(h.timestamp) &&
        BigInt(h.timestamp) <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) &&
        utc(Number(BigInt(h.timestamp)) * 1000) === source.observedAt &&
        t.settled === true
      )
    })
  const before = headers.find((h) =>
    relevant.every(
      (t) =>
        h.physicalRequest < t.physicalRequest &&
        Date.parse(h.completedAtUtc) <= Date.parse(t.startedAtUtc),
    ),
  )
  const after = headers.find((h) =>
    relevant.every(
      (t) =>
        h.physicalRequest > t.physicalRequest &&
        Date.parse(h.startedAtUtc) >= Date.parse(t.completedAtUtc),
    ),
  )
  requireFact(
    before && after && before.physicalRequest < after.physicalRequest,
    'wire_header_not_enclosed',
  )
  return {
    beforePhysicalRequest: before.physicalRequest,
    afterPhysicalRequest: after.physicalRequest,
  }
}
async function independentCashWitness(seed, current, traces, hosts, viem) {
  if (current.sourceKind === 'manifest_bound_ledger') {
    const [{ buildSubjectManifest }, store] = await Promise.all([
      import('../record-carry-cash-issues.mjs'),
      import('../lib/localCarryCashStore.mjs'),
    ])
    const manifest = await buildSubjectManifest(),
      verified = store.verifyLocalCarryCash(manifest, store.LOCAL_CARRY_CASH_ROOT, {
        maxRecords: 512,
        maxTotalBytes: 100663296,
      })
    const receipt = verified.records.find(
      (r) =>
        r.sha256 === current.receiptSha256 &&
        r.manifestSha256 === current.manifestSha256 &&
        r.block === current.block &&
        r.blockHash === current.blockHash &&
        r.blockAt === current.observedAt &&
        r.firstLocalReceiptAt === current.firstLocalReceiptAt,
    )
    requireFact(
      receipt?.rows.some(
        (r) =>
          r.routeKey === seed.routeKey &&
          r.destination === seed.destination &&
          r.asset === seed.asset &&
          r.assetDecimals === seed.decimals &&
          r.state === 'observed' &&
          r.cashRaw === current.cashRaw,
      ),
      'sealed_cash_receipt_binding',
    )
    return {
      kind: 'sha_chain_verified_local_receipt',
      receiptSha256: receipt.sha256,
      manifestSha256: receipt.manifestSha256,
      ledgerCount: verified.count,
      ledgerHead: verified.last.sha256,
    }
  }
  requireFact(
    current.sourceKind === 'live_read_only_two_origin_finalized' && primitiveUtc(current.readAtUtc),
    'live_cash_receipt_missing',
  )
  const abi = viem.parseAbi(['function balanceOf(address owner) view returns (uint256)'])
  for (const host of hosts) {
    const rows = traces.filter((t) => t.host === host && t.response?.result !== undefined)
    const cash = rows
      .filter(
        (t) =>
          t.request.method === 'eth_call' &&
          t.request.params[0]?.to?.toLowerCase() === seed.asset &&
          t.request.params[0]?.data?.slice(0, 10) === '0x70a08231',
      )
      .find((t) => {
        try {
          const d = viem.decodeFunctionData({ abi, data: t.request.params[0].data })
          const tag = t.request.params[1]
          return (
            d.args[0].toLowerCase() === seed.destination &&
            ((tag?.blockHash === current.blockHash && tag.requireCanonical === true) ||
              (typeof tag === 'string' && BigInt(tag) === BigInt(current.block))) &&
            String(
              viem.decodeFunctionResult({
                abi,
                functionName: 'balanceOf',
                data: t.response.result,
              }),
            ) === current.cashRaw
          )
        } catch {
          return false
        }
      })
    requireFact(cash, 'live_cash_balance_binding')
    requireWireEnclosure(traces, host, current, [cash], { numericCashPin: true })
  }
  return { kind: 'two_origin_actual_balance_and_header', hosts, readAtUtc: current.readAtUtc }
}
export function nativeWireProof(seed, source, traces, viem, hosts, selectedCapacity) {
  const abi = viem.parseAbi([
    'function withdraw(uint256 assets,address receiver,address owner) returns (uint256 shares)',
    'function withdraw(address asset,uint256 amount)',
    'function balanceOf(address owner) view returns (uint256)',
    'function previewRedeem(uint256 shares) view returns (uint256)',
    'function isWithdrawPaused() view returns (bool)',
    'function asset() view returns (address)',
    'function baseToken() view returns (address)',
    'function decimals() view returns (uint8)',
  ])
  return hosts.map((host) => {
    const state = traces.filter(
      (t) =>
        t.host === host &&
        ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(t.request.method) &&
        t.request.params[0] &&
        t.response !== undefined,
    )
    const pinned = state.filter(
      (t) =>
        t.request.params.at(-1)?.blockHash === source.blockHash &&
        t.request.params.at(-1)?.requireCanonical === true,
    )
    requireFact(state.length > 0 && state.length === pinned.length, 'native_state_pin_mismatch')
    const withdraw = pinned
      .filter(
        (t) =>
          t.request.method === 'eth_call' &&
          t.request.params[0].to?.toLowerCase() === seed.destination,
      )
      .flatMap((t) => {
        try {
          const d = viem.decodeFunctionData({ abi, data: t.request.params[0].data })
          return d.functionName === 'withdraw' ? [{ t, d }] : []
        } catch {
          return []
        }
      })
    requireFact(withdraw.length === 1, 'native_withdraw_wire_missing')
    const { t, d } = withdraw[0],
      args = d.args
    requireFact(
      t.request.params[0].from?.toLowerCase() === seed.owner &&
        (seed.kind === 'comet'
          ? args[0].toLowerCase() === seed.asset && String(args[1]) === seed.requestedRaw
          : String(args[0]) === seed.requestedRaw &&
            args[1].toLowerCase() === seed.owner &&
            args[2].toLowerCase() === seed.owner),
      'native_withdraw_args',
    )
    const decodedCalls = pinned
      .filter(
        (t) =>
          t.request.method === 'eth_call' &&
          t.request.params[0].to?.toLowerCase() === seed.destination &&
          t.response?.result !== undefined,
      )
      .flatMap((t) => {
        try {
          return [{ t, decoded: viem.decodeFunctionData({ abi, data: t.request.params[0].data }) }]
        } catch {
          return []
        }
      })
    const balanceCall = decodedCalls.find(
      (c) =>
        c.decoded.functionName === 'balanceOf' && c.decoded.args[0].toLowerCase() === seed.owner,
    )
    requireFact(balanceCall, 'native_holder_balance_wire_missing')
    const holderBalanceRaw = String(
      viem.decodeFunctionResult({
        abi,
        functionName: 'balanceOf',
        data: balanceCall.t.response.result,
      }),
    )
    requireFact(raw(holderBalanceRaw), 'native_holder_balance_raw')
    let fullEntitlementRaw = holderBalanceRaw
    if (seed.kind !== 'comet') {
      const preview = decodedCalls.find(
        (c) =>
          c.decoded.functionName === 'previewRedeem' &&
          String(c.decoded.args[0]) === holderBalanceRaw,
      )
      requireFact(preview, 'native_full_position_preview_missing')
      fullEntitlementRaw = String(
        viem.decodeFunctionResult({
          abi,
          functionName: 'previewRedeem',
          data: preview.t.response.result,
        }),
      )
    }
    requireFact(
      raw(fullEntitlementRaw) && fullEntitlementRaw === selectedCapacity?.quote?.entitlementRaw,
      'native_full_entitlement_mismatch',
    )
    const pause = decodedCalls.find((c) => c.decoded.functionName === 'isWithdrawPaused')
    const withdrawalsPaused = pause
      ? viem.decodeFunctionResult({
          abi,
          functionName: 'isWithdrawPaused',
          data: pause.t.response.result,
        })
      : null
    const identityCalls = pinned
      .filter((t) => t.request.method === 'eth_call' && t.response?.result !== undefined)
      .flatMap((t) => {
        try {
          return [{ t, d: viem.decodeFunctionData({ abi, data: t.request.params[0].data }) }]
        } catch {
          return []
        }
      })
    const assetGetter = identityCalls.find(
      (c) =>
        c.t.request.params[0].to?.toLowerCase() === seed.destination &&
        ['asset', 'baseToken'].includes(c.d.functionName),
    )
    if (assetGetter)
      requireFact(
        viem
          .decodeFunctionResult({
            abi,
            functionName: assetGetter.d.functionName,
            data: assetGetter.t.response.result,
          })
          .toLowerCase() === seed.asset,
        'native_asset_identity_mismatch',
      )
    const assetDecimals = identityCalls.find(
      (c) =>
        c.t.request.params[0].to?.toLowerCase() === seed.asset && c.d.functionName === 'decimals',
    )
    if (assetDecimals)
      requireFact(
        Number(
          viem.decodeFunctionResult({
            abi,
            functionName: 'decimals',
            data: assetDecimals.t.response.result,
          }),
        ) === seed.decimals,
        'native_asset_decimals_mismatch',
      )
    const runtimeHashes = pinned
      .filter(
        (t) =>
          t.request.method === 'eth_getCode' &&
          typeof t.response?.result === 'string' &&
          /^0x[0-9a-f]*$/i.test(t.response.result),
      )
      .map((t) => ({
        address: t.request.params[0],
        observedCodeHash: viem.keccak256(t.response.result),
      }))
    const enclosure = requireWireEnclosure(traces, host, source, state)
    return {
      host,
      withdrawal: {
        from: t.request.params[0].from,
        to: t.request.params[0].to,
        data: t.request.params[0].data,
        decodedArgs: args.map(String),
        result: t.response.result ?? null,
        error: t.response.error ?? null,
      },
      enclosure,
      nativeAssetAuthority: assetGetter
        ? 'actual_wire_getter'
        : 'accepted_native_api_and_fixed_registry',
      nativeDecimalsAuthority: assetDecimals
        ? 'actual_wire_getter'
        : 'accepted_native_api_and_fixed_registry',
      runtimeHashes,
      runtimeConfigurationAuthority: 'accepted_native_api_not_independently_mapped',
      sourceImplementationEquivalence: false,
      holderBalanceRaw,
      fullEntitlementRaw,
      withdrawalsPaused,
      pinnedStateRequests: pinned.length,
    }
  })
}
export async function captureRuntime(name) {
  const space = statfsSync(ROOT + 'data/research/venue-signals', { bigint: true })
  requireFact(
    space.bavail * space.bsize >= BigInt(LIMITS.reserveBytes + LIMITS.artifactBytes),
    'capture_disk_reserve',
  )
  const prepared = await preflight(name, { importHandlers: false }),
    originalFetch = globalThis.fetch
  const observer = createObservedFetch(prepared.urls, { fetcher: originalFetch }),
    outcomes = []
  globalThis.fetch = observer.fetch
  let modules, network
  try {
    modules = await loadRuntimeModules()
    for (const seed of prepared.subjects) {
      const start = observer.traces.length
      let forecastHttp = null,
        holderHttp = null,
        stage = 'forecast'
      try {
        const f = await invoke(modules.forecast, {
          method: 'GET',
          query: {
            routeKey: seed.routeKey,
            destination: seed.destination,
            amountUnits: '1',
            horizonHours: '24',
            includeLiveCurrent: '1',
          },
          headers: {},
          socket: { remoteAddress: '127.0.0.1' },
        })
        forecastHttp = safeHttpFacts(f)
        requireFact(
          f.status === 200 && forecastHttp.cacheControlTokens.includes('no-store'),
          'forecast_http_contract',
        )
        stage = 'current_metadata'
        const c = f.body.sampledCashPaths?.current
        requireFact(
          c &&
            raw(c.cashRaw) &&
            c.asset?.toLowerCase() === seed.asset &&
            c.assetDecimals === seed.decimals,
          'forecast_native_current_missing',
        )
        let current = {
          routeKey: seed.routeKey,
          destination: seed.destination,
          assetAddress: seed.asset,
          assetDecimals: seed.decimals,
          assetSymbol: seed.symbol,
          cashRaw: c.cashRaw,
          block: c.block,
          blockHash: c.blockHash,
          observedAt: c.blockAt,
          freshness: 'fresh',
          label: 'Pool cash',
        }
        current = modules.wb.withBoundSampledCashCurrentMetadata(current, c)
        fresh(current, Date.now())
        stage = 'cash_witness'
        const cashWitness = await independentCashWitness(
          seed,
          current,
          observer.traces.slice(start),
          prepared.hosts,
          modules.viem,
        )
        const question = {
          routeKey: seed.routeKey,
          destination: seed.destination,
          requestedRaw: seed.requestedRaw,
          requestedAssetAddress: seed.asset,
          requestedAssetDecimals: seed.decimals,
          requestedHolderAddress: seed.owner,
          horizonHours: 24,
          asOfMs: Date.now(),
        }
        stage = 'workbench_source'
        const ref = modules.wb.matchingHolderForecastSourceReference(
          f.body.conditionalGrossFlowHeadroom,
          question,
          current,
          f.body.conditionalSampledCashPathProjection,
        )
        requireFact(ref, 'workbench_source_not_accepted')
        const nativeStart = observer.traces.length
        stage = 'holder_request'
        const h = await invoke(modules.holder, {
          method: 'POST',
          body: {
            routeKey: seed.routeKey,
            destinationAddress: seed.destination,
            owner: seed.owner,
            assetsRaw: seed.requestedRaw,
            horizonHours: 24,
            forecastSourceReference: ref,
          },
          headers: {},
          socket: { remoteAddress: '127.0.0.1' },
        })
        holderHttp = safeHttpFacts(h)
        const apiReceivedAtMs = Date.now()
        const receivedAtMs = apiReceivedAtMs
        fresh(current, receivedAtMs)
        const agreement = modules.wb.holderCapacityAgreementFromResponse(h.body, h.status)
        requireFact(agreement, 'holder_capacity_not_accepted')
        const source = {
          chainId: 1,
          blockNumber: Number(current.block),
          blockHash: current.blockHash,
          blockTime: current.observedAt,
          finalized: true,
        }
        const selected = modules.cap.selectedHolderExitCapacity(agreement, {
          routeKey: seed.routeKey,
          destination: seed.destination,
          owner: seed.owner,
          requestedRaw: seed.requestedRaw,
          asset: seed.asset,
          assetDecimals: seed.decimals,
          currentSource: source,
          asOfMs: receivedAtMs,
          executionAgreement: h.body.executionAgreement,
        })
        requireFact(selected, 'native_capacity_binding_failed')
        // The assessment's final EOA code check can follow its reader's closing header.
        // Observe one additional exact-number header per origin after ALL API state reads.
        for (let i = 0; i < prepared.urls.length; i++) {
          const result = await observer.fetch(prepared.urls[i], {
            method: 'POST',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: `observer-post-${seed.kind}-${i}`,
              method: 'eth_getBlockByNumber',
              params: ['0x' + BigInt(current.block).toString(16), false],
            }),
          })
          const reply = await result.json(),
            header = reply.result
          requireFact(
            header &&
              typeof header.number === 'string' &&
              /^0x[0-9a-f]+$/.test(header.number) &&
              BigInt(header.number) === BigInt(current.block) &&
              header.hash === current.blockHash &&
              typeof header.timestamp === 'string' &&
              /^0x[0-9a-f]+$/.test(header.timestamp) &&
              BigInt(header.timestamp) <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) &&
              utc(Number(BigInt(header.timestamp)) * 1000) === current.observedAt,
            'observer_postheader_mismatch',
          )
        }
        const observerValidatedAtMs = Date.now()
        fresh(current, observerValidatedAtMs)
        const wire = nativeWireProof(
          seed,
          current,
          observer.traces.slice(nativeStart),
          modules.viem,
          prepared.hosts,
          selected,
        )
        const forecastFacts = Object.fromEntries(
          [
            'sampledCashPaths',
            'conditionalSampledCashPathProjection',
            'susdsHistoricalCapacityEvidence',
            'stusdsHistoricalCapacityEvidence',
            'conditionalGrossFlowHeadroom',
          ]
            .filter((k) => f.body[k] !== undefined)
            .map((k) => [k, f.body[k]]),
        )
        outcomes.push({
          status: 'captured_pending_offline_render',
          seed,
          current,
          forecast: { ...f, body: forecastFacts, retainedFieldsOnly: true },
          holder: h,
          apiReceivedAtUtc: utc(apiReceivedAtMs),
          receivedAtUtc: utc(receivedAtMs),
          observerValidatedAtUtc: utc(observerValidatedAtMs),
          observerAddedPostHeaders: 2,
          selectedCapacity: selected,
          cashWitness,
          nativeWire: wire,
        })
      } catch (error) {
        outcomes.push({
          status: 'observed_failure',
          subject: seed.kind,
          code: error.safeCode ?? 'handler_failure',
          causeCode: safeCause(error),
          failure: safeFailureFacts(error, stage),
          forecastHttp,
          holderHttp,
        })
      }
    }
  } finally {
    network = await observer.finish()
    // This is a one-shot observer. Deferred SDK retries must hit the closed guard, never raw fetch.
    globalThis.fetch = observer.fetch
  }
  // All rendering is offline. No import or render may escape into a new network call.
  const trap = globalThis.fetch
  globalThis.fetch = async () => fail('offline_render_network_forbidden')
  try {
    const React = (await import('react')).default,
      { ChakraProvider } = await import('@chakra-ui/react'),
      { renderToStaticMarkup } = await import('react-dom/server')
    for (const o of outcomes.filter((o) => o.status === 'captured_pending_offline_render')) {
      try {
        const s = o.seed,
          f = o.forecast.body,
          h = o.holder.body,
          issueMs = Date.parse(o.receivedAtUtc),
          renderAtMs = Date.now()
        const props = {
          routeKey: s.routeKey,
          destination: s.destination,
          requestedAmount: '1',
          requestedRaw: s.requestedRaw,
          requestedAssetSymbol: s.symbol,
          requestedAssetAddress: s.asset,
          requestedAssetDecimals: s.decimals,
          requestedHolderAddress: s.owner,
          horizonHours: 24,
          asOfMs: renderAtMs,
          currentCash: o.current,
          conditionalSampledCashPathProjection: f.conditionalSampledCashPathProjection,
          sampledCashPaths: f.sampledCashPaths,
          holderCapacityAgreement: h.capacityAgreement,
          holderCometFactsAgreement: h.cometFactsAgreement,
          holderStusdsProtocolCapacityEvidence: h.stusdsCurrentProtocolCapacityEvidence,
          holderAssessment: o.holder.status === 200 ? h : null,
          prospectiveCashModel: null,
          historicalScenario: null,
          grossWithdrawals: null,
          grossInflows: null,
          historicalGrossFlow: null,
          morphoPayout: null,
          expectedEventEnrollment: null,
          eventContext: null,
          historicalOutlook: null,
        }
        const issuedQuestion = { ...props, asOfMs: issueMs }
        props.holderTimeProcessIssue = modules.wb.holderTimeProcessIssueFromResponse(
          h,
          o.holder.status,
          issuedQuestion,
          o.current,
          f.conditionalSampledCashPathProjection,
        )
        const render = (p) =>
          renderToStaticMarkup(
            React.createElement(
              ChakraProvider,
              null,
              React.createElement(modules.card.ExitPressureCard, p),
            ),
          )
        const html = render(props),
          later = render({ ...props, asOfMs: renderAtMs + 1000 })
        const issuedInput = modules.card.issuedCashHolderTimeInputForCard(
          f.conditionalSampledCashPathProjection,
          h.capacityAgreement,
          h.cometFactsAgreement,
          h.executionAgreement,
          issuedQuestion,
          o.current,
        )
        let selectedTime = null
        if (issuedInput) {
          const t = await import('../../lib/carry/conditionalCashHolderTimeProcess.ts'),
            model = t.default ?? t
          const built = model.buildConditionalCashHolderTimeProcess(issuedInput, sha)
          selectedTime = model.selectedConditionalCashHolderTimeProcess(
            built,
            { input: issuedInput, asOfMs: renderAtMs + 1000 },
            sha,
          )
          requireFact(
            selectedTime &&
              selectedTime.process.targetAtUtc === utc(issueMs + 86400000) &&
              later.includes(selectedTime.process.targetAtUtc.slice(5, 16).replace('T', ' ')),
            'fixed_issue_target_counter',
          )
        }
        requireFact(
          html.includes('aria-label="Projected exit headroom"'),
          'holder_row_not_rendered',
        )
        if (props.holderTimeProcessIssue)
          requireFact(
            JSON.stringify(props.holderTimeProcessIssue) ===
              JSON.stringify(
                modules.wb.holderTimeProcessIssueFromResponse(
                  h,
                  o.holder.status,
                  issuedQuestion,
                  o.current,
                  f.conditionalSampledCashPathProjection,
                ),
              ),
            'issue_stamp_changed',
          )
        let susdsAnalogTarget = null
        if (s.kind === 'susds') {
          const sm = await import('../../lib/carry/susdsHistoricalHolderCapacityProjection.ts'),
            model = sm.default ?? sm
          const cash = modules.card.selectedSusdsCashForCard(
            f.conditionalSampledCashPathProjection,
            props,
            o.current,
          )
          requireFact(cash, 'susds_cash_source_not_selected')
          const binding = {
            routeKey: s.routeKey,
            destination: s.destination,
            owner: s.owner,
            requestedRaw: s.requestedRaw,
            asset: s.asset,
            assetDecimals: s.decimals,
            currentSource: {
              chainId: 1,
              blockNumber: Number(o.current.block),
              blockHash: o.current.blockHash,
              blockTime: o.current.observedAt,
              finalized: true,
            },
            asOfMs: renderAtMs,
            executionAgreement: h.executionAgreement,
          }
          const input = {
            history: model.susdsPinnedIndexHistory(),
            capacityAgreement: h.capacityAgreement,
            binding,
            currentSource: binding.currentSource,
            currentReadAtUtc: cash.currentSource.readAt,
            horizonHours: 24,
            asOfMs: renderAtMs,
          }
          const built = model.buildSusdsHistoricalHolderCapacityProjection(input, sha)
          const selected = model.selectedSusdsHistoricalHolderCapacityProjection(built, input, sha)
          const group = selected?.view.groups[0]
          requireFact(
            group && html.includes(group.targetAt.slice(5, 19).replace('T', ' ')),
            'susds_actual_analog_target_not_rendered',
          )
          susdsAnalogTarget = group.targetAt
        }
        const wrongOwner = render({ ...props, requestedHolderAddress: '0x' + '1'.repeat(40) })
        requireFact(
          !wrongOwner.includes('aria-label="Projected exit headroom"'),
          'owner_counter_not_rejected',
        )
        const wrongQ = render({ ...props, requestedRaw: String(BigInt(s.requestedRaw) + 1n) })
        requireFact(
          !wrongQ.includes('aria-label="Projected exit headroom"'),
          'Q_counter_not_rejected',
        )
        const wrongSource = render({
          ...props,
          currentCash: { ...o.current, blockHash: '0x' + '0'.repeat(64) },
        })
        requireFact(
          !wrongSource.includes('aria-label="Projected exit headroom"'),
          'source_counter_not_rejected',
        )
        const expired = render({ ...props, asOfMs: Date.parse(o.current.observedAt) + 1800001 })
        requireFact(
          !expired.includes('aria-label="Projected exit headroom"'),
          'expiry_counter_not_rejected',
        )
        o.ssr = {
          sha256: sha(html),
          bytes: Buffer.byteLength(html),
          laterClockSha256: sha(later),
          issuedAtUtc: o.receivedAtUtc,
          renderedAtUtc: utc(renderAtMs),
          observerValidatedAtUtc: o.observerValidatedAtUtc,
          laterClockControl: 'offline_synthetic_render_plus_1_second_original_issue_retained',
          expiryControl: 'offline_synthetic_source_expiry_plus_1_millisecond',
          genuineIssue: props.holderTimeProcessIssue,
          selectedTimeTarget: selectedTime?.process.targetAtUtc ?? null,
          susdsAnalogTarget,
          modelClock: selectedTime
            ? 'genuine_issue_plus_selected_H'
            : s.kind === 'susds'
              ? 'historical_index_analog_actual_elapsed_target'
              : 'historical_analog_actual_elapsed_target',
          selectedHTimeVerified: selectedTime !== null,
          wrongOwnerRejected: true,
          wrongQRejected: true,
          wrongSourceRejected: true,
          expiredRejected: true,
          browserVerified: false,
        }
        o.status = 'verified_actual_handlers_and_offline_ssr'
      } catch (error) {
        o.status = 'captured_offline_replay_failed'
        o.replayFailure = error.safeCode ?? 'offline_render_failure'
      }
    }
  } finally {
    globalThis.fetch = trap
  }
  return {
    schema: 'native_holder_forecast_runtime_v1',
    clock: 'real_wall_clock',
    capturedAtUtc: utc(Date.now()),
    policy: { id: prepared.policyId, hosts: prepared.hosts },
    network,
    outcomes,
    traces: observer.traces,
    forecastValidated: false,
    prospectiveValidated: false,
    futureExecutionVerified: false,
    browserVerified: false,
  }
}
export function writeRuntimeArtifact(
  value,
  {
    directory = ROOT + 'data/research/venue-signals',
    fs = { openSync, closeSync, fstatSync, lstatSync, unlinkSync, writeFileSync, statfsSync },
  } = {},
) {
  const bytes = JSON.stringify(value, null, 2) + '\n'
  requireFact(
    Buffer.byteLength(bytes) <= LIMITS.artifactBytes &&
      !/https?:\/\/|authorization|api[_-]?key/i.test(bytes),
    'artifact_size_or_privacy',
  )
  const space = fs.statfsSync(directory, { bigint: true })
  requireFact(
    space.bavail * space.bsize >= BigInt(LIMITS.reserveBytes + Buffer.byteLength(bytes)),
    'artifact_disk_reserve',
  )
  const path = `${directory}/native-holder-forecast-runtime-${utc(Date.now()).replace(/[:.]/g, '-')}-${randomUUID()}.json`
  let fd, identity
  try {
    fd = fs.openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    identity = fs.fstatSync(fd)
    fs.writeFileSync(fd, bytes)
    fs.closeSync(fd)
    fd = undefined
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    if (identity) {
      try {
        const current = fs.lstatSync(path)
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === identity.dev &&
          current.ino === identity.ino
        )
          fs.unlinkSync(path)
      } catch {}
    }
    throw error
  }
  return { path, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }
}
async function main() {
  const args = process.argv.slice(2),
    name = args.find((a) => a.startsWith('--subject='))?.slice(10)
  requireFact(
    args.every(
      (a) =>
        ['--check-only', '--capture'].includes(a) || /^--subject=(susds|comet|stusds)$/.test(a),
    ) && !(args.includes('--check-only') && args.includes('--capture')),
    'cli_arguments',
  )
  if (!args.includes('--capture')) {
    const p = await preflight(name)
    console.log(
      JSON.stringify({
        status: 'offline_preflight',
        subjects: p.subjects.map((s) => ({
          kind: s.kind,
          owner: s.owner,
          decimals: s.decimals,
          requestedRaw: s.requestedRaw,
          locatorSeal: s.seal,
        })),
        policyId: p.policyId,
        hosts: p.hosts,
        limits: LIMITS,
      }),
    )
    return
  }
  const result = await captureRuntime(name)
  console.log(JSON.stringify(writeRuntimeArtifact(result)))
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error) => {
    console.error(
      JSON.stringify({
        status: 'failed',
        code: error.safeCode ?? 'offline_or_capture_failure',
        causeCode: safeCause(error),
      }),
    )
    process.exitCode = 1
  })
