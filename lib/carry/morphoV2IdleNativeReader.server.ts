/** Explicit supplemental reads only. No startup, cache, provider selection or raw-file retention. */
import { parseUsd3HypotheticalJson } from '../../scripts/research/usd3-hypothetical-history-capture.mjs'
import { agreeHolderExitCapacityQuotes, selectedHolderExitCapacity, type HolderExitCapacityAgreement, type HolderExitCapacityQuote } from './holderExitCapacity'
import {
  decodeMorphoV2IdleNativePoint, isOriginalMorphoV2IdleNativeHistory,
  morphoV2IdleHistoricalPreviewDescriptors, selectMorphoV2IdleHistoryForStock,
  type MorphoV2IdleNativeHistory, type MorphoV2IdleNativeTrace,
  type MorphoV2IdleDecodedPoint, type MorphoV2IdleHistoricalPoint,
} from './morphoV2IdleNativeEvidence'
import {
  isAppOwnedMorphoV2IdleTrustedProfile, MORPHO_V2_IDLE_CLAIMS,
  type MorphoV2IdleTrustedProfile, type MorphoV2IdleSource,
} from './morphoV2IdleTrustedProfiles'
import { isOriginalMorphoV2IdleCompactPanel, type OriginalMorphoV2IdleCompactPanel } from './morphoV2IdleCompactPanel.server'

export const MORPHO_V2_IDLE_NATIVE_READ_POLICY = Object.freeze({
  outerDeadlineMs: 60_000, stageDeadlineMs: 12_000, callTimeoutMs: 8_000,
  hostSpacingMs: 250, maxStarts: 44, maxSourceAgeMs: 1_800_000,
  maxResultBytes: 64 * 1024, maxEvidenceBytes: 256 * 1024, retries: 0, workers: 1,
} as const)
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
export type MorphoV2IdleHolderRequest = Readonly<{
  routeKey: string; destination: string; owner: string; requestedRaw: string
  asset: string; assetDecimals: number; source: HolderExitCapacityQuote['source']
}>
/** API-selected HTTPS URL remains in the private closure. No credentials are loaded here. */
export type MorphoV2IdleBoundedOrigin = Readonly<{
  host: string
  execute(input: { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }, deadlineAt: number):
    Promise<{ jsonrpc: '2.0'; id: number; result: unknown }>
}>
const nativeOrigins = new WeakSet<object>()
/** Explicit fetch dependency permits abort-aware controls; production uses native fetch.
 * No RPC runs until execute. Native fetch must settle on AbortSignal, including body reads. */
export function createMorphoV2IdleNativeOrigin(selectedUrl: string, fetcher: typeof fetch = fetch): MorphoV2IdleBoundedOrigin {
  check(typeof selectedUrl === 'string' && selectedUrl.length <= 8192)
  const url = new URL(selectedUrl)
  check(url.protocol === 'https:' && HOSTS.some(host => host === url.hostname) && !url.username && !url.password && !url.hash &&
    (url.port === '' || url.port === '443') && typeof fetcher === 'function')
  const host = url.hostname
  let busy = false
  const origin: MorphoV2IdleBoundedOrigin = Object.freeze({ host,
    async execute(input: { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }, deadlineAt: number): Promise<{ jsonrpc: '2.0'; id: number; result: unknown }> {
      check(plain(input) && !busy && Number.isFinite(deadlineAt) && deadlineAt > performance.now() && Number.isSafeInteger(input.id) && input.id > 0 &&
        ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(input.method))
      busy = true
      const controller = new AbortController(), remaining = Math.min(8000, deadlineAt - performance.now())
      let timer: ReturnType<typeof setTimeout> | undefined, bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined, cancellation: Promise<void> | undefined
      const abortBody = () => { if (bodyReader) cancellation = bodyReader.cancel().catch(() => undefined) }
      controller.signal.addEventListener('abort', abortBody, { once: true })
      try {
        check(remaining > 0)
        timer = setTimeout(() => controller.abort(), remaining)
        const response = await fetcher(selectedUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input), signal: controller.signal, redirect: 'error' })
        check(!controller.signal.aborted && performance.now() < deadlineAt && response.ok && response.body)
        const declared = response.headers.get('content-length')
        check(declared === null || /^[0-9]+$/.test(declared) && Number(declared) <= 65536)
        bodyReader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        for (;;) {
          const chunk = await bodyReader.read()
          check(!controller.signal.aborted && performance.now() < deadlineAt)
          if (chunk.done) break
          bytes += chunk.value.byteLength
          check(bytes <= 65536)
          chunks.push(chunk.value)
        }
        const data = Buffer.concat(chunks, bytes), text = new TextDecoder('utf-8', { fatal: true }).decode(data)
        const value = parseUsd3HypotheticalJson(text)
        check(plain(value) && value && typeof value === 'object' && !Array.isArray(value))
        const envelope = value as Record<string, unknown>
        check(Object.keys(envelope).sort().join(',') === 'id,jsonrpc,result' && envelope.jsonrpc === '2.0' && envelope.id === input.id &&
          !controller.signal.aborted && performance.now() < deadlineAt)
        return { jsonrpc: '2.0', id: input.id, result: envelope.result }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        controller.abort()
        if (cancellation) await cancellation
        if (bodyReader) { try { await bodyReader.cancel() } catch { /* cancellation carries no qualified evidence */ } }
        controller.signal.removeEventListener('abort', abortBody)
        busy = false
      }
    },
  })
  nativeOrigins.add(origin)
  return origin
}
export type MorphoV2IdleCurrentObservation = Readonly<{
  label: 'current'; source: MorphoV2IdleSource; owner: string; probeSharesRaw: string
  traces: readonly MorphoV2IdleNativeTrace[]; startedAtUtc: string; readAtUtc: string
}>
export type MorphoV2IdleHistoricalSupplement = Readonly<{
  sharesRaw: string; startedAtUtc: string; readAtUtc: string; traces: readonly MorphoV2IdleNativeTrace[]
}>
declare const freshReadBrand: unique symbol
export type MorphoV2IdleNativeRead = Readonly<{
  current: MorphoV2IdleCurrentObservation; decodedCurrent: MorphoV2IdleDecodedPoint
  historicalPreviewSupplement: MorphoV2IdleHistoricalSupplement | null
  historicalPoints: readonly MorphoV2IdleHistoricalPoint[]
  supplementalStarts: number; sdkPhysicalStarts: null; completedAtMs: number
  claims: typeof MORPHO_V2_IDLE_CLAIMS; readonly [freshReadBrand]: true
}>
export type MorphoV2IdleNativeReadExpectation = {
  profile: MorphoV2IdleTrustedProfile; history: MorphoV2IdleNativeHistory
  request: MorphoV2IdleHolderRequest; capacityAgreement: unknown; executionAgreement?: unknown; asOfMs: number
}
const originals = new WeakMap<object, { profile: MorphoV2IdleTrustedProfile; history: MorphoV2IdleNativeHistory; request: MorphoV2IdleHolderRequest; quote: HolderExitCapacityQuote }>()
declare const freshPanelReadBrand: unique symbol
export type MorphoV2IdleNativePanelRead = Readonly<{
  mode: 'compact_panel_current'; current: MorphoV2IdleCurrentObservation; decodedCurrent: MorphoV2IdleDecodedPoint
  supplementalStarts: 32; sdkPhysicalStarts: null; completedAtMs: number
  claims: typeof MORPHO_V2_IDLE_CLAIMS; readonly [freshPanelReadBrand]: true
}>
export type MorphoV2IdleNativePanelReadExpectation = {
  profile: MorphoV2IdleTrustedProfile; panel: OriginalMorphoV2IdleCompactPanel
  request: MorphoV2IdleHolderRequest; capacityAgreement: unknown; executionAgreement?: unknown; asOfMs: number
}
const panelOriginals = new WeakMap<object, { profile: MorphoV2IdleTrustedProfile; panel: OriginalMorphoV2IdleCompactPanel; request: MorphoV2IdleHolderRequest; quote: HolderExitCapacityQuote }>()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function check(ok: unknown): asserts ok { if (!ok) throw new Error('morpho_idle_native_read_invalid') }
function dataProperties(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return required.every(key => descriptors[key] && Object.hasOwn(descriptors[key], 'value')) &&
    optional.every(key => !descriptors[key] || Object.hasOwn(descriptors[key], 'value'))
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function plain(value: unknown, seen = new WeakSet<object>(), depth = 0, count = { n: 0, bytes: 0 }): boolean {
  if (++count.n > 12000 || depth > 24) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') { count.bytes += Buffer.byteLength(value); return count.bytes <= MORPHO_V2_IDLE_NATIVE_READ_POLICY.maxEvidenceBytes }
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || seen.has(value) || Object.getOwnPropertySymbols(value).length) return false
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if ((array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) return false
  if (array && Object.keys(descriptors).length !== value.length + 1) return false
  seen.add(value)
  try { return Object.entries(descriptors).every(([key, d]) => array && key === 'length' || d.enumerable && plain(d.value, seen, depth + 1, count)) }
  finally { seen.delete(value) }
}
function fresh(source: HolderExitCapacityQuote['source'], at: number) {
  return Number.isSafeInteger(at) && at >= Date.parse(source.blockTime) && at - Date.parse(source.blockTime) <= MORPHO_V2_IDLE_NATIVE_READ_POLICY.maxSourceAgeMs
}
/** Rebuild the generic agreement and bind full S/Ea independently of the supplemental bytes. */
export function requiredMorphoV2IdleHolderQuote(profile: MorphoV2IdleTrustedProfile, request: MorphoV2IdleHolderRequest, value: unknown, asOfMs: number, executionAgreement?: unknown): HolderExitCapacityAgreement | null {
  try {
    if (!isAppOwnedMorphoV2IdleTrustedProfile(profile) || !plain(request) || !plain(value) || executionAgreement !== undefined && !plain(executionAgreement)) return null
    const agreement = value as HolderExitCapacityAgreement, identity = profile.identity
    if (!agreement || Object.keys(agreement).sort().join(',') !== 'origins,quote,status') return null
    if (Object.keys(request).sort().join(',') !== 'asset,assetDecimals,destination,owner,requestedRaw,routeKey,source' ||
      request.routeKey !== identity.routeKey || request.destination !== identity.destination || request.asset !== identity.asset || request.assetDecimals !== identity.assetDecimals ||
      !/^0x[0-9a-f]{40}$/.test(request.owner) || !/^[1-9][0-9]{0,77}$/.test(request.requestedRaw) || BigInt(request.requestedRaw) >= 1n << 256n ||
      !Array.isArray(agreement.origins) || agreement.origins.length !== 2 ||
      !HOSTS.every(host => agreement.origins.filter(origin => origin && Object.keys(origin).sort().join(',') === 'host,quote' && origin.host === host).length === 1)) return null
    const rebuilt = agreeHolderExitCapacityQuotes(agreement.origins[0], agreement.origins[1], asOfMs)
    if (!rebuilt || !same(rebuilt, agreement)) return null
    const q = rebuilt.quote, position = q.sourceHolderPosition
    if (q.routeKey !== request.routeKey || q.destination !== request.destination || q.owner !== request.owner || q.requestedRaw !== request.requestedRaw ||
      q.asset !== request.asset || q.assetDecimals !== request.assetDecimals || !same(q.source, request.source) || !fresh(q.source, asOfMs) ||
      q.entitlementMethod !== 'preview_redeem_full_position' || q.entitlementRaw === null || !position || position.shareDecimals !== identity.shareDecimals ||
      position.method !== 'balance_of_owner_at_source' || BigInt(position.sharesRaw) <= 0n) return null
    return selectedHolderExitCapacity(agreement, { routeKey: request.routeKey, destination: request.destination, owner: request.owner,
      requestedRaw: request.requestedRaw, asset: request.asset, assetDecimals: request.assetDecimals, currentSource: request.source, asOfMs, executionAgreement })
  } catch { return null }
}
/** Only a completed reader call can mint this identity. A captured/decoded point or JSON clone cannot. */
export function selectedMorphoV2IdleNativeRead(value: unknown, expected: MorphoV2IdleNativeReadExpectation): MorphoV2IdleNativeRead | null {
  try {
    if (!value || typeof value !== 'object' || !dataProperties(expected, ['profile', 'history', 'request', 'capacityAgreement', 'asOfMs'], ['executionAgreement'])) return null
    const original = originals.get(value), result = value as MorphoV2IdleNativeRead
    if (!original || original.profile !== expected.profile || original.history !== expected.history ||
      !isOriginalMorphoV2IdleNativeHistory(expected.history, expected.profile) || !plain(expected.request) || !same(original.request, expected.request) ||
      !Number.isSafeInteger(expected.asOfMs) || expected.asOfMs < result.completedAtMs) return null
    const agreement = requiredMorphoV2IdleHolderQuote(expected.profile, expected.request, expected.capacityAgreement, expected.asOfMs, expected.executionAgreement)
    if (!agreement || !same(original.quote, agreement.quote)) return null
    return result
  } catch { return null }
}
export function selectedMorphoV2IdleNativePanelRead(value: unknown, expected: MorphoV2IdleNativePanelReadExpectation): MorphoV2IdleNativePanelRead | null {
  try {
    if (!value || typeof value !== 'object' || !dataProperties(expected, ['profile', 'panel', 'request', 'capacityAgreement', 'asOfMs'], ['executionAgreement'])) return null
    const original = panelOriginals.get(value), result = value as MorphoV2IdleNativePanelRead
    if (!original || original.profile !== expected.profile || original.panel !== expected.panel || !isOriginalMorphoV2IdleCompactPanel(expected.panel, expected.profile) || !plain(expected.request) || !same(original.request, expected.request) || !Number.isSafeInteger(expected.asOfMs) || expected.asOfMs < result.completedAtMs || expected.asOfMs < Date.parse(expected.panel.panel.actualAvailabilityAtUtc)) return null
    const agreement = requiredMorphoV2IdleHolderQuote(expected.profile, expected.request, expected.capacityAgreement, expected.asOfMs, expected.executionAgreement)
    return agreement && same(original.quote, agreement.quote) ? result : null
  } catch { return null }
}
function compactHeader(result: unknown): unknown {
  check(plain(result) && result !== null && typeof result === 'object' && !Array.isArray(result))
  const h = result as Record<string, unknown>
  check(typeof h.hash === 'string' && typeof h.number === 'string' && typeof h.timestamp === 'string')
  return { hash: h.hash, number: h.number, timestamp: h.timestamp }
}
function checkHeader(result: unknown, source: MorphoV2IdleSource) {
  const h = result as { hash: string; number: string; timestamp: string }
  check(h.hash === source.blockHash && /^0x[0-9a-f]+$/.test(h.number) && BigInt(h.number).toString() === source.blockNumber &&
    /^0x[0-9a-f]+$/.test(h.timestamp) && BigInt(h.timestamp) <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) &&
    new Date(Number(BigInt(h.timestamp)) * 1000).toISOString() === source.blockTime)
}
/** No fallback, retries, background dispatch or persistence. Failure returns no qualified observation. */
async function readNativeHolder(input: {
  profile: MorphoV2IdleTrustedProfile; history?: MorphoV2IdleNativeHistory; panel?: OriginalMorphoV2IdleCompactPanel; request: MorphoV2IdleHolderRequest
  capacityAgreement: unknown; executionAgreement?: unknown; origins: readonly [MorphoV2IdleBoundedOrigin, MorphoV2IdleBoundedOrigin]
}): Promise<MorphoV2IdleNativeRead | MorphoV2IdleNativePanelRead | null> {
  try {
    check(dataProperties(input, ['profile', 'request', 'capacityAgreement', 'origins'], ['executionAgreement', 'history', 'panel']) && Boolean(input.history) !== Boolean(input.panel))
    const startedAtMs = Date.now(), monotonicStarted = performance.now(), profile = input.profile, history = input.history, panel = input.panel
    check(isAppOwnedMorphoV2IdleTrustedProfile(profile) && (panel ? isOriginalMorphoV2IdleCompactPanel(panel, profile) && startedAtMs >= Date.parse(panel.panel.actualAvailabilityAtUtc) : history && isOriginalMorphoV2IdleNativeHistory(history, profile) && startedAtMs >= Date.parse(history.provenance.historyAvailableAtUtc ?? history.provenance.verifiedReplayCompletedAtUtc ?? '')))
    const agreement = requiredMorphoV2IdleHolderQuote(profile, input.request, input.capacityAgreement, startedAtMs, input.executionAgreement)
    check(agreement && Array.isArray(input.origins) && input.origins.length === 2 && input.origins.every(origin => origin && typeof origin === 'object' && nativeOrigins.has(origin)))
    const executionAgreement = input.executionAgreement === undefined ? undefined : structuredClone(input.executionAgreement)
    const request = structuredClone(input.request), quote = structuredClone(agreement.quote), identity = profile.identity
    const origins = HOSTS.map(host => {
      const matches = input.origins.filter(origin => origin.host === host)
      check(matches.length === 1 && nativeOrigins.has(matches[0]))
      const origin = matches[0]
      return { host, execute: origin.execute.bind(origin) }
    })
    const source: MorphoV2IdleSource = { ...request.source, blockNumber: String(request.source.blockNumber) }
    const sharesRaw = quote.sourceHolderPosition!.sharesRaw, block = { blockHash: source.blockHash, requireCanonical: true }
    const headerParams = ['0x' + BigInt(source.blockNumber).toString(16), false]
    const calls: [string, string, unknown[]][] = [
      ['chain', 'eth_chainId', []], ['header_before', 'eth_getBlockByNumber', headerParams],
      ['vault_code', 'eth_getCode', [identity.destination, block]], ['asset_code', 'eth_getCode', [identity.asset, block]],
      ['owner_code', 'eth_getCode', [request.owner, block]],
      ...([
        ['asset', identity.destination, '0x38d52e0f'], ['share_decimals', identity.destination, '0x313ce567'],
        ['asset_decimals', identity.asset, '0x313ce567'], ['liquidity_adapter', identity.destination, '0xad468d11'],
        ['liquidity_data', identity.destination, '0x2e029228'], ['idle_cash', identity.asset, '0x70a08231' + identity.destination.slice(2).padStart(64, '0')],
        ['total_assets', identity.destination, '0x01e1d114'], ['total_supply', identity.destination, '0x18160ddd'],
        ['actual_owner_shares', identity.destination, '0x70a08231' + request.owner.slice(2).padStart(64, '0')],
        ['fixed_stock_preview', identity.destination, '0x4cdad506' + BigInt(sharesRaw).toString(16).padStart(64, '0')],
      ] as [string, string, string][]).map(([key, to, data]): [string, string, unknown[]] => [key, 'eth_call', [{ to, data }, block]]),
      ['header_after', 'eth_getBlockByNumber', headerParams],
    ]
    const lastStarts = [-Infinity, -Infinity], allTraces: MorphoV2IdleNativeTrace[] = []
    let previousAtMs = startedAtMs, stageStarted = performance.now()
    const elapsed = () => performance.now() - monotonicStarted
    const assertClock = () => {
      const now = Date.now()
      check(Number.isSafeInteger(now) && now >= previousAtMs && now - startedAtMs <= 60_000 && elapsed() <= 60_000 && fresh(request.source, now))
      previousAtMs = now
      return now
    }
    const call = async (key: string, method: string, params: unknown[], originIndex: number) => {
      assertClock()
      for (;;) {
        assertClock()
        const now = performance.now(), delay = 250 - (now - lastStarts[originIndex])
        if (delay <= 0) break
        const remaining = Math.min(stageStarted + 12000 - now, monotonicStarted + 60000 - now, startedAtMs + 60000 - Date.now())
        // Recheck actual elapsed spacing after each wake, within the original deadlines.
        const wait = Math.min(Math.ceil(delay), Math.floor(remaining))
        check(wait >= 1)
        await new Promise<void>(resolve => setTimeout(resolve, wait))
      }
      assertClock()
      check(elapsed() < 60_000 && Date.now() - startedAtMs < 60_000 && performance.now() - stageStarted < 12_000 && allTraces.length < 44)
      const id = allTraces.length + 1, started = performance.now()
      lastStarts[originIndex] = started
      const nativeRequest = { jsonrpc: '2.0' as const, id, method, params: structuredClone(params) }
      // Abort native fetch/body at the earliest absolute call, stage or outer cutoff.
      // Await settlement and cleanup before any next dispatch.
      const envelope = await origins[originIndex].execute(nativeRequest, Math.min(started + 8000, stageStarted + 12000, monotonicStarted + 60000))
      const rawResult = envelope.result
      assertClock()
      check(performance.now() - started <= 8000 && performance.now() - stageStarted <= 12_000 && plain(rawResult))
      const rawText = JSON.stringify(rawResult)
      check(typeof rawText === 'string' && Buffer.byteLength(rawText) <= MORPHO_V2_IDLE_NATIVE_READ_POLICY.maxResultBytes)
      const result = method === 'eth_getBlockByNumber' ? compactHeader(rawResult) : structuredClone(rawResult)
      allTraces.push({ host: origins[originIndex].host, key, physicalId: id,
        request: nativeRequest, envelope: { ...envelope, result } })
      check(Buffer.byteLength(JSON.stringify(allTraces)) <= MORPHO_V2_IDLE_NATIVE_READ_POLICY.maxEvidenceBytes)
    }
    for (const [key, method, params] of calls) for (let origin = 0; origin < 2; origin++) await call('current:' + key, method, params, origin)
    const current: MorphoV2IdleCurrentObservation = { label: 'current', source, owner: request.owner, probeSharesRaw: sharesRaw,
      traces: allTraces.slice(), startedAtUtc: new Date(startedAtMs).toISOString(), readAtUtc: new Date(assertClock()).toISOString() }
    const decodedCurrent = decodeMorphoV2IdleNativePoint(profile, { ...current, currentCaptureReference: true })
    check(decodedCurrent.actualOwnerSharesRaw === sharesRaw && decodedCurrent.historicalPoint.fixedCurrentStockConversion.assetsRaw === quote.entitlementRaw)
    if (panel) {
      const completedAtMs = assertClock()
      check(allTraces.length === 32 && BigInt(decodedCurrent.totalSupplySharesRaw) >= BigInt(sharesRaw) && requiredMorphoV2IdleHolderQuote(profile, request, agreement, completedAtMs, executionAgreement))
      const result = freeze({ mode: 'compact_panel_current', current, decodedCurrent, supplementalStarts: 32,
        sdkPhysicalStarts: null, completedAtMs, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as MorphoV2IdleNativePanelRead
      panelOriginals.set(result, { profile, panel, request: freeze(request), quote: freeze(quote) }); return result
    }
    check(history)
    const historical = selectMorphoV2IdleHistoryForStock(history, request.owner, sharesRaw)
    let historicalPreviewSupplement: MorphoV2IdleHistoricalSupplement | null = null
    let historicalPoints: readonly MorphoV2IdleHistoricalPoint[]
    if (historical.status === 'matched') historicalPoints = historical.points
    else {
      const supplementStarted = assertClock(), firstIndex = allTraces.length
      const descriptors = morphoV2IdleHistoricalPreviewDescriptors(history, sharesRaw), points: MorphoV2IdleHistoricalPoint[] = []
      for (const [anchorIndex, descriptor] of descriptors.entries()) {
        stageStarted = performance.now()
        const params = ['0x' + BigInt(descriptor.source.blockNumber).toString(16), false]
        for (const [role, method, args] of [
          ['header_before', 'eth_getBlockByNumber', params], ['fixed_stock_preview', 'eth_call', [...descriptor.params]],
          ['header_after', 'eth_getBlockByNumber', params],
        ] as [string, string, unknown[]][]) {
          for (let origin = 0; origin < 2; origin++) await call('historical_' + anchorIndex + ':' + role, method, args, origin)
        }
        const pair = allTraces.slice(-6)
        for (const offset of [0, 4]) for (const trace of pair.slice(offset, offset + 2)) checkHeader(trace.envelope.result, descriptor.source)
        const a = pair[2].envelope.result, b = pair[3].envelope.result
        check(a === b && typeof a === 'string' && /^0x[0-9a-f]{64}$/.test(a))
        const old = history.anchors[anchorIndex]
        points.push({ ...old, owner: request.owner, historicalOwnerSharesRaw: request.owner === history.captureOwner ? old.historicalOwnerSharesRaw : null,
          fixedCurrentStockConversion: { ...old.fixedCurrentStockConversion, probeSharesRaw: sharesRaw, assetsRaw: BigInt(a).toString() } })
      }
      historicalPoints = points
      historicalPreviewSupplement = { sharesRaw, startedAtUtc: new Date(supplementStarted).toISOString(), readAtUtc: new Date(assertClock()).toISOString(), traces: allTraces.slice(firstIndex) }
    }
    const completedAtMs = assertClock()
    check(requiredMorphoV2IdleHolderQuote(profile, request, agreement, completedAtMs, executionAgreement))
    const result = freeze({ current, decodedCurrent, historicalPreviewSupplement, historicalPoints,
      supplementalStarts: allTraces.length, sdkPhysicalStarts: null, completedAtMs, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as MorphoV2IdleNativeRead
    originals.set(result, { profile, history, request: freeze(request), quote: freeze(quote) })
    return result
  } catch { return null }
}
/** Existing two-anchor acquisition remains unchanged, including changed-stock native supplements. */
export async function readMorphoV2IdleNativeHolder(input: {
  profile: MorphoV2IdleTrustedProfile; history: MorphoV2IdleNativeHistory; request: MorphoV2IdleHolderRequest
  capacityAgreement: unknown; executionAgreement?: unknown; origins: readonly [MorphoV2IdleBoundedOrigin, MorphoV2IdleBoundedOrigin]
}): Promise<MorphoV2IdleNativeRead | null> {
  const result = await readNativeHolder(input)
  return result && !('mode' in result) ? result : null
}
/** Panel mode always reads actual full current S/Ea and does not reprice old native quotes. */
export async function readMorphoV2IdleNativePanelHolder(input: {
  profile: MorphoV2IdleTrustedProfile; panel: OriginalMorphoV2IdleCompactPanel; request: MorphoV2IdleHolderRequest
  capacityAgreement: unknown; executionAgreement?: unknown; origins: readonly [MorphoV2IdleBoundedOrigin, MorphoV2IdleBoundedOrigin]
}): Promise<MorphoV2IdleNativePanelRead | null> {
  const result = await readNativeHolder(input)
  return result && 'mode' in result ? result : null
}
