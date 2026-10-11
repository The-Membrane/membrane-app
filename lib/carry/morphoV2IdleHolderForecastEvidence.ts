/** Browser-safe native replay. Local identity never asserts RPC authentication or execution. */
import { keccak256, sha256, stringToHex } from 'viem'
import {
  isAppOwnedMorphoV2IdleTrustedProfile, MORPHO_V2_IDLE_CLAIMS,
  type MorphoV2IdleTrustedProfile,
} from './morphoV2IdleTrustedProfiles'
import type {
  MorphoV2IdleHistoricalPoint, MorphoV2IdleIdentity, MorphoV2IdleNativeSource, MorphoV2IdleRegime,
} from './morphoV2IdleJointStockProjection'

export const MORPHO_V2_IDLE_BROWSER_LIMITS = Object.freeze({ capsuleBytes: 64 * 1024, envelopeBytes: 256 * 1024, nodes: 20000, depth: 32, readSpanMs: 120000, sourceAgeMs: 1800000 })
export const MORPHO_V2_IDLE_PINNED_CAPSULE_SHA256 = '880b5424feaf11b8301bdbd560fde261999a31696acac7dccb039fbccc5ddfc6'
export const MORPHO_V2_IDLE_BROWSER_HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const)
const MAX_UINT = (1n << 256n) - 1n
const UINT = /^(0|[1-9][0-9]{0,77})$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const HEX_UINT = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const WORD = /^0x[0-9a-f]{64}$/
const POINT_KEYS = ['chain', 'header_before', 'vault_code', 'asset_code', 'owner_code', 'asset', 'share_decimals', 'asset_decimals', 'liquidity_adapter', 'liquidity_data', 'idle_cash', 'total_assets', 'total_supply', 'actual_owner_shares', 'fixed_stock_preview', 'header_after'] as const
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const size = (s: string) => new TextEncoder().encode(s).length
function check(ok: unknown): asserts ok { if (!ok) throw new Error('morpho_idle_browser_evidence_invalid') }
function freeze<T>(x: T): T { if (x !== null && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }
/** Reject accessors, exotic prototypes, sparse arrays and cyclic or unbounded inputs before reading fields. */
export function morphoV2IdleBrowserDataTree(x: unknown, seen = new WeakSet<object>(), depth = 0, count = { n: 0, chars: 0, bytes: 0 }): boolean {
  if (++count.n > MORPHO_V2_IDLE_BROWSER_LIMITS.nodes || depth > MORPHO_V2_IDLE_BROWSER_LIMITS.depth) return false
  if (typeof x === 'string') {
    count.chars += x.length
    if (count.chars > MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes) return false
    count.bytes += size(x); return count.bytes <= MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes
  }
  if (x === null || typeof x === 'boolean') return true
  if (typeof x === 'number') return Number.isFinite(x)
  if (!x || typeof x !== 'object' || seen.has(x)) return false
  const array = Array.isArray(x), p = Object.getPrototypeOf(x), ds = Object.getOwnPropertyDescriptors(x)
  if ((array ? p !== Array.prototype : p !== Object.prototype && p !== null) || Object.getOwnPropertySymbols(x).length || Object.values(ds).some((d) => !Object.hasOwn(d, 'value'))) return false
  if (array && Object.keys(ds).length !== x.length + 1) return false
  seen.add(x)
  try { return Object.entries(ds).every(([k, d]) => {
    if (array && k === 'length') return true
    count.chars += k.length
    if (count.chars > MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes) return false
    count.bytes += size(k)
    return count.bytes <= MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes && d.enumerable && morphoV2IdleBrowserDataTree(d.value, seen, depth + 1, count)
  }) }
  finally { seen.delete(x) }
}
function exact(x: unknown, keys: readonly string[]): asserts x is Record<string, unknown> {
  check(x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k)))
}
function uint(x: unknown, positive = false): x is string { return typeof x === 'string' && UINT.test(x) && BigInt(x) <= MAX_UINT && (!positive || BigInt(x) > 0n) }
function utc(x: unknown): x is string { return typeof x === 'string' && Number.isSafeInteger(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x }
function source(x: unknown): asserts x is MorphoV2IdleNativeSource {
  exact(x, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'])
  check(x.chainId === 1 && x.finalized === true && uint(x.blockNumber, true) && typeof x.blockHash === 'string' && HASH.test(x.blockHash) && utc(x.blockTime) && x.blockTime.endsWith('.000Z'))
}
export function sameMorphoV2IdleBrowserSource(a: MorphoV2IdleNativeSource, b: MorphoV2IdleNativeSource): boolean {
  return a.chainId === b.chainId && a.blockNumber === b.blockNumber && a.blockHash === b.blockHash && a.blockTime === b.blockTime && a.finalized === b.finalized
}

export type MorphoV2IdleNativeBrowserTrace = {
  host: string; key: string; physicalId: number
  request: { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }
  envelope: { jsonrpc: '2.0'; id: number; result: unknown }
}
export type MorphoV2IdleCurrentBrowserObservation = {
  label: 'current'; source: MorphoV2IdleNativeSource; owner: string; probeSharesRaw: string
  traces: MorphoV2IdleNativeBrowserTrace[]; startedAtUtc: string; readAtUtc: string
}
export type MorphoV2IdleHistoricalPreviewSupplement = {
  sharesRaw: string; startedAtUtc: string; readAtUtc: string; traces: MorphoV2IdleNativeBrowserTrace[]
}
export type MorphoV2IdleHolderForecastEvidenceWire = {
  schema: 'morpho_v2_idle_holder_forecast_evidence_v1'; capsuleText: string
  current: MorphoV2IdleCurrentBrowserObservation
  historicalPreviewSupplement: MorphoV2IdleHistoricalPreviewSupplement | null
}
export type MorphoV2IdlePinnedHistoricalCapsule = {
  schemaVersion: 1; kind: 'morpho_v2_idle_pinned_historical_capsule_v1'; profileId: string
  identity: MorphoV2IdleIdentity; captureSharesRaw: string; captureOwner: string
  anchors: [MorphoV2IdleHistoricalPoint, MorphoV2IdleHistoricalPoint]
  provenance: { nativeTerminalFileSha256: string; nativeReportFileSha256: string; sourceCompanionManifestSha256: string; verifiedReplayCompletedAtUtc: string | null; historyAvailableAtUtc?: string; captureAvailableAtUtc?: string; rootNormalizationCompletedAtUtc?: string; independentReplayCompletedAtUtc?: null }
  claims: typeof MORPHO_V2_IDLE_CLAIMS
}
function capsule(text: unknown, profile: MorphoV2IdleTrustedProfile): MorphoV2IdlePinnedHistoricalCapsule {
  check(typeof text === 'string' && text.length <= MORPHO_V2_IDLE_BROWSER_LIMITS.capsuleBytes && size(text) <= MORPHO_V2_IDLE_BROWSER_LIMITS.capsuleBytes && size(text) === profile.history.capsule.bytes && sha256(stringToHex(text)).slice(2) === profile.history.capsule.sha256)
  const x = JSON.parse(text) as MorphoV2IdlePinnedHistoricalCapsule
  check(morphoV2IdleBrowserDataTree(x))
  exact(x, ['schemaVersion', 'kind', 'profileId', 'identity', 'captureSharesRaw', 'captureOwner', 'anchors', 'provenance', 'claims'])
  exact(x.provenance, ['nativeTerminalFileSha256', 'nativeReportFileSha256', 'sourceCompanionManifestSha256', 'verifiedReplayCompletedAtUtc',
    ...(profile.history.kind === 'rlusd_acceptance_v1' ? ['historyAvailableAtUtc', 'captureAvailableAtUtc', 'rootNormalizationCompletedAtUtc', 'independentReplayCompletedAtUtc'] : [])])
  if (profile.history.kind === 'rlusd_acceptance_v1') check(x.provenance.historyAvailableAtUtc === profile.history.historyAvailableAtUtc &&
    x.provenance.captureAvailableAtUtc === profile.history.captureAvailableAtUtc && x.provenance.rootNormalizationCompletedAtUtc === profile.history.rootNormalizationCompletedAtUtc && x.provenance.independentReplayCompletedAtUtc === null)
  check(x.schemaVersion === 1 && x.kind === 'morpho_v2_idle_pinned_historical_capsule_v1' && x.profileId === profile.id && same(x.identity, profile.identity) && x.captureSharesRaw === profile.history.captureSharesRaw && x.captureOwner === profile.history.captureOwner && same(x.claims, MORPHO_V2_IDLE_CLAIMS) && x.provenance.nativeTerminalFileSha256 === profile.history.terminalFileSha256 && x.provenance.nativeReportFileSha256 === profile.history.reportFileSha256 && x.provenance.sourceCompanionManifestSha256 === profile.history.companionManifestSha256 && x.provenance.verifiedReplayCompletedAtUtc === profile.history.verifiedReplayCompletedAtUtc && Array.isArray(x.anchors) && x.anchors.length === 2)
  for (const [i, p] of x.anchors.entries()) {
    exact(p, ['identity', 'owner', 'source', 'regime', 'idleCashRaw', 'historicalOwnerSharesRaw', 'fixedCurrentStockConversion'])
    exact(p.regime, ['kind', 'liquidityAdapter', 'liquidityData', 'vaultRuntimeCodeHash', 'assetRuntimeCodeHash'])
    exact(p.fixedCurrentStockConversion, ['method', 'source', 'probeSharesRaw', 'asset', 'assetDecimals', 'shareDecimals', 'assetsRaw'])
    source(p.source); source(p.fixedCurrentStockConversion.source)
    check(same(p.identity, profile.identity) && p.owner === x.captureOwner && sameMorphoV2IdleBrowserSource(p.source, profile.history.anchors[i]) && sameMorphoV2IdleBrowserSource(p.source, p.fixedCurrentStockConversion.source) && p.regime.kind === 'zero_adapter_idle' && p.regime.liquidityAdapter === profile.configured.liquidityAdapter && p.regime.liquidityData === '0x' && p.regime.vaultRuntimeCodeHash === profile.runtimes.vault.codeHash && p.regime.assetRuntimeCodeHash === profile.runtimes.asset.codeHash && uint(p.idleCashRaw) && (profile.history.kind === 'rlusd_acceptance_v1' ? p.historicalOwnerSharesRaw === null : uint(p.historicalOwnerSharesRaw)) && p.fixedCurrentStockConversion.method === 'native_preview_redeem_fixed_current_shares' && p.fixedCurrentStockConversion.probeSharesRaw === x.captureSharesRaw && p.fixedCurrentStockConversion.asset === profile.identity.asset && p.fixedCurrentStockConversion.assetDecimals === profile.identity.assetDecimals && p.fixedCurrentStockConversion.shareDecimals === profile.identity.shareDecimals && uint(p.fixedCurrentStockConversion.assetsRaw))
  }
  return freeze(x)
}
function shape(x: unknown): asserts x is MorphoV2IdleHolderForecastEvidenceWire {
  check(morphoV2IdleBrowserDataTree(x)); exact(x, ['schema', 'capsuleText', 'current', 'historicalPreviewSupplement'])
  check(x.schema === 'morpho_v2_idle_holder_forecast_evidence_v1' && typeof x.capsuleText === 'string' && x.capsuleText.length <= MORPHO_V2_IDLE_BROWSER_LIMITS.capsuleBytes && size(x.capsuleText) <= MORPHO_V2_IDLE_BROWSER_LIMITS.capsuleBytes)
  exact(x.current, ['label', 'source', 'owner', 'probeSharesRaw', 'traces', 'startedAtUtc', 'readAtUtc'])
  check(x.current.label === 'current' && typeof x.current.owner === 'string' && ADDRESS.test(x.current.owner) && uint(x.current.probeSharesRaw, true) && Array.isArray(x.current.traces) && x.current.traces.length === 32 && utc(x.current.startedAtUtc) && utc(x.current.readAtUtc)); source(x.current.source)
  if (x.historicalPreviewSupplement !== null) {
    exact(x.historicalPreviewSupplement, ['sharesRaw', 'startedAtUtc', 'readAtUtc', 'traces'])
    check(uint(x.historicalPreviewSupplement.sharesRaw, true) && utc(x.historicalPreviewSupplement.startedAtUtc) && utc(x.historicalPreviewSupplement.readAtUtc) && Array.isArray(x.historicalPreviewSupplement.traces) && x.historicalPreviewSupplement.traces.length === 12)
  }
}
/** Canonical JSON prevents duplicate decoded keys from disappearing during parsing. */
export function decodeMorphoV2IdleHolderForecastEvidence(text: unknown): MorphoV2IdleHolderForecastEvidenceWire | null {
  try {
    check(typeof text === 'string' && text.length <= MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes && size(text) <= MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes)
    const x: unknown = JSON.parse(text); check(JSON.stringify(x) === text); shape(x)
    return freeze(x)
  } catch { return null }
}
export function encodeMorphoV2IdleHolderForecastEvidence(x: unknown): string | null {
  try { shape(x); const text = JSON.stringify(x); return decodeMorphoV2IdleHolderForecastEvidence(text) ? text : null } catch { return null }
}
export type MorphoV2IdleHolderForecastEvidenceExpectation = {
  profile: MorphoV2IdleTrustedProfile; owner: string; source: MorphoV2IdleNativeSource
  sharesRaw: string; fullEaRaw: string; asOfMs: number
}
declare const originalIdleEvidence: unique symbol
export type ApprovedMorphoV2IdleHolderForecastEvidence = Readonly<{
  identity: MorphoV2IdleIdentity; owner: string; source: MorphoV2IdleNativeSource; regime: MorphoV2IdleRegime
  currentSharesRaw: string; currentIdleCashRaw: string; currentFullEaRaw: string
  totalAssetsDiagnosticRaw: string; totalSupplyDiagnosticSharesRaw: string
  anchors: readonly [MorphoV2IdleHistoricalPoint, MorphoV2IdleHistoricalPoint]
  historicalOwnedEntitlementAssetRaw: null; competingMRaw: null
  capsuleSha256: string; verifiedHistoryAvailableAtUtc: string; readAtUtc: string
  claims: typeof MORPHO_V2_IDLE_CLAIMS; readonly [originalIdleEvidence]: true
}>
type Original = { key: string; approvedAtMs: number; sourceAtMs: number; readAtMs: number; availableAtMs: number }
const originals = new WeakMap<object, Original>()
function expectation(x: MorphoV2IdleHolderForecastEvidenceExpectation): string {
  check(morphoV2IdleBrowserDataTree(x)); exact(x, ['profile', 'owner', 'source', 'sharesRaw', 'fullEaRaw', 'asOfMs'])
  check(isAppOwnedMorphoV2IdleTrustedProfile(x.profile) && ADDRESS.test(x.owner) && uint(x.sharesRaw, true) && uint(x.fullEaRaw) && Number.isSafeInteger(x.asOfMs)); source(x.source)
  return JSON.stringify([x.profile.id, x.owner, x.source.chainId, x.source.blockNumber, x.source.blockHash, x.source.blockTime, x.source.finalized, x.sharesRaw, x.fullEaRaw])
}
function timing(start: string, end: string, issueMs: number, lowerMs: number): number {
  check(utc(start) && utc(end)); const a = Date.parse(start), b = Date.parse(end)
  check(a >= lowerMs && b >= a && b - a <= MORPHO_V2_IDLE_BROWSER_LIMITS.readSpanMs && b <= issueMs); return b
}
function header(result: unknown, s: MorphoV2IdleNativeSource) {
  check(result !== null && typeof result === 'object' && !Array.isArray(result))
  const x = result as Record<string, unknown>
  check(x.hash === s.blockHash && typeof x.number === 'string' && HEX_UINT.test(x.number) && BigInt(x.number) === BigInt(s.blockNumber) && typeof x.timestamp === 'string' && HEX_UINT.test(x.timestamp) && BigInt(x.timestamp) * 1000n === BigInt(Date.parse(s.blockTime)))
}
export function morphoV2IdleBrowserPreviewRedeemCalldata(shares: string): `0x${string}` {
  check(uint(shares, true)); return ('0x4cdad506' + BigInt(shares).toString(16).padStart(64, '0')) as `0x${string}`
}
function pair(
  traces: MorphoV2IdleNativeBrowserTrace[], index: number, key: string, method: string, params: unknown[],
  s: MorphoV2IdleNativeSource, ids: Set<number>, requests: Set<number>, prior: number[],
): unknown {
  const two = traces.slice(index * 2, index * 2 + 2); check(two.length === 2)
  for (const [origin, t] of two.entries()) {
    exact(t, ['host', 'key', 'physicalId', 'request', 'envelope']); exact(t.request, ['jsonrpc', 'id', 'method', 'params']); exact(t.envelope, ['jsonrpc', 'id', 'result'])
    check(t.host === MORPHO_V2_IDLE_BROWSER_HOSTS[origin] && t.key === key && Number.isSafeInteger(t.physicalId) && t.physicalId > 0 && t.physicalId <= 100 && !ids.has(t.physicalId) && t.physicalId > prior[origin] && t.request.jsonrpc === '2.0' && Number.isSafeInteger(t.request.id) && t.request.id > 0 && !requests.has(t.request.id) && t.request.method === method && same(t.request.params, params) && t.envelope.jsonrpc === '2.0' && t.envelope.id === t.request.id)
    ids.add(t.physicalId); requests.add(t.request.id); prior[origin] = t.physicalId
    if (key.endsWith(':header_before') || key.endsWith(':header_after')) header(t.envelope.result, s)
  }
  if (!key.endsWith(':header_before') && !key.endsWith(':header_after')) check(same(two[0].envelope.result, two[1].envelope.result))
  return two[0].envelope.result
}
function currentPoint(w: MorphoV2IdleCurrentBrowserObservation, p: MorphoV2IdleTrustedProfile, ids: Set<number>, requests: Set<number>, prior: number[]) {
  const s = w.source, block = { blockHash: s.blockHash, requireCanonical: true }, identity = p.identity
  const expected: Record<string, [string, unknown[]]> = {
    chain: ['eth_chainId', []], header_before: ['eth_getBlockByNumber', ['0x' + BigInt(s.blockNumber).toString(16), false]], header_after: ['eth_getBlockByNumber', ['0x' + BigInt(s.blockNumber).toString(16), false]],
    vault_code: ['eth_getCode', [identity.destination, block]], asset_code: ['eth_getCode', [identity.asset, block]], owner_code: ['eth_getCode', [w.owner, block]],
  }
  const calls: Record<string, [string, string]> = {
    asset: [identity.destination, '0x38d52e0f'], share_decimals: [identity.destination, '0x313ce567'], asset_decimals: [identity.asset, '0x313ce567'], liquidity_adapter: [identity.destination, '0xad468d11'], liquidity_data: [identity.destination, '0x2e029228'], idle_cash: [identity.asset, '0x70a08231' + identity.destination.slice(2).padStart(64, '0')], total_assets: [identity.destination, '0x01e1d114'], total_supply: [identity.destination, '0x18160ddd'], actual_owner_shares: [identity.destination, '0x70a08231' + w.owner.slice(2).padStart(64, '0')], fixed_stock_preview: [identity.destination, morphoV2IdleBrowserPreviewRedeemCalldata(w.probeSharesRaw)],
  }
  for (const [k, [to, data]] of Object.entries(calls)) expected[k] = ['eth_call', [{ to, data }, block]]
  const values: Record<string, unknown> = {}
  POINT_KEYS.forEach((key, i) => { const [method, params] = expected[key]; values[key] = pair(w.traces, i, 'current:' + key, method, params, s, ids, requests, prior) })
  check(values.chain === '0x1' && values.owner_code === '0x')
  for (const key of ['vault', 'asset'] as const) {
    const code = values[key + '_code']; check(typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(code) && (code.length - 2) / 2 === p.runtimes[key].bytes && keccak256(code as `0x${string}`) === p.runtimes[key].codeHash)
  }
  const word = (key: string) => { const x = values[key]; check(typeof x === 'string' && WORD.test(x)); return BigInt(x) }
  check(word('asset') === BigInt(identity.asset) && word('share_decimals') === BigInt(identity.shareDecimals) && word('asset_decimals') === BigInt(identity.assetDecimals) && word('liquidity_adapter') === 0n && values.liquidity_data === '0x' + '20'.padStart(64, '0') + '0'.repeat(64) && word('actual_owner_shares').toString() === w.probeSharesRaw)
  return { idleCashRaw: word('idle_cash').toString(), fullEaRaw: word('fixed_stock_preview').toString(), totalAssetsRaw: word('total_assets').toString(), totalSupplyRaw: word('total_supply').toString() }
}
/** Unbranded native-current decoder shared by versioned evidence. It issues no model or receipt. */
export function approveMorphoV2IdleCurrentBrowserObservation(value: unknown, expected: MorphoV2IdleHolderForecastEvidenceExpectation): ReturnType<typeof currentPoint> | null {
  try {
    expectation(expected); check(morphoV2IdleBrowserDataTree(value)); exact(value, ['label', 'source', 'owner', 'probeSharesRaw', 'traces', 'startedAtUtc', 'readAtUtc'])
    const w = value as unknown as MorphoV2IdleCurrentBrowserObservation
    source(w.source); check(w.label === 'current' && w.owner === expected.owner && w.probeSharesRaw === expected.sharesRaw && sameMorphoV2IdleBrowserSource(w.source, expected.source) && Array.isArray(w.traces) && w.traces.length === 32)
    const sourceAt = Date.parse(w.source.blockTime)
    check(expected.asOfMs >= sourceAt && expected.asOfMs - sourceAt <= MORPHO_V2_IDLE_BROWSER_LIMITS.sourceAgeMs)
    timing(w.startedAtUtc, w.readAtUtc, expected.asOfMs, sourceAt)
    const result = currentPoint(w, expected.profile, new Set<number>(), new Set<number>(), [0, 0])
    check(result.fullEaRaw === expected.fullEaRaw && BigInt(result.totalSupplyRaw) >= BigInt(expected.sharesRaw)); return freeze(result)
  } catch { return null }
}
export function approveMorphoV2IdleHolderForecastEvidence(value: unknown, expected: MorphoV2IdleHolderForecastEvidenceExpectation): ApprovedMorphoV2IdleHolderForecastEvidence | null {
  try {
    const key = expectation(expected), decoded = typeof value === 'string' ? decodeMorphoV2IdleHolderForecastEvidence(value) : decodeMorphoV2IdleHolderForecastEvidence(encodeMorphoV2IdleHolderForecastEvidence(value))
    check(decoded); const w = decoded, p = expected.profile, c = capsule(w.capsuleText, p), sourceAt = Date.parse(w.current.source.blockTime), availableAt = Date.parse(c.provenance.historyAvailableAtUtc ?? c.provenance.verifiedReplayCompletedAtUtc ?? '')
    check(w.current.owner === expected.owner && w.current.probeSharesRaw === expected.sharesRaw && sameMorphoV2IdleBrowserSource(w.current.source, expected.source) && availableAt <= expected.asOfMs && expected.asOfMs >= sourceAt && expected.asOfMs - sourceAt <= MORPHO_V2_IDLE_BROWSER_LIMITS.sourceAgeMs)
    const readAt = timing(w.current.startedAtUtc, w.current.readAtUtc, expected.asOfMs, sourceAt), ids = new Set<number>(), requests = new Set<number>(), prior = [0, 0]
    const current = currentPoint(w.current, p, ids, requests, prior); check(current.fullEaRaw === expected.fullEaRaw)
    const anchors = structuredClone(c.anchors)
    for (const point of anchors) {
      check(Date.parse(point.source.blockTime) <= sourceAt && BigInt(point.source.blockNumber) <= BigInt(w.current.source.blockNumber))
      point.owner = expected.owner; point.historicalOwnerSharesRaw = expected.owner === c.captureOwner ? point.historicalOwnerSharesRaw : null
    }
    if (expected.sharesRaw === c.captureSharesRaw) check(w.historicalPreviewSupplement === null)
    else {
      const h = w.historicalPreviewSupplement; check(h && h.sharesRaw === expected.sharesRaw)
      timing(h.startedAtUtc, h.readAtUtc, expected.asOfMs, Math.max(availableAt, Date.parse(w.current.readAtUtc)))
      for (const [anchor, point] of anchors.entries()) {
        const s = point.source, block = { blockHash: s.blockHash, requireCanonical: true }, label = 'historical_' + anchor
        const roles = ['header_before', 'fixed_stock_preview', 'header_after'] as const
        for (const [i, role] of roles.entries()) {
          const method = role === 'fixed_stock_preview' ? 'eth_call' : 'eth_getBlockByNumber'
          const params = role === 'fixed_stock_preview' ? [{ to: p.identity.destination, data: morphoV2IdleBrowserPreviewRedeemCalldata(expected.sharesRaw) }, block] : ['0x' + BigInt(s.blockNumber).toString(16), false]
          const raw = pair(h.traces, anchor * 3 + i, label + ':' + role, method, params, s, ids, requests, prior)
          if (role === 'fixed_stock_preview') { check(typeof raw === 'string' && WORD.test(raw)); point.fixedCurrentStockConversion.probeSharesRaw = expected.sharesRaw; point.fixedCurrentStockConversion.assetsRaw = BigInt(raw).toString() }
        }
      }
    }
    const regime: MorphoV2IdleRegime = { kind: 'zero_adapter_idle', liquidityAdapter: p.configured.liquidityAdapter, liquidityData: '0x', vaultRuntimeCodeHash: p.runtimes.vault.codeHash, assetRuntimeCodeHash: p.runtimes.asset.codeHash }
    const result = freeze({ identity: structuredClone(p.identity), owner: expected.owner, source: structuredClone(w.current.source), regime, currentSharesRaw: expected.sharesRaw, currentIdleCashRaw: current.idleCashRaw, currentFullEaRaw: current.fullEaRaw, totalAssetsDiagnosticRaw: current.totalAssetsRaw, totalSupplyDiagnosticSharesRaw: current.totalSupplyRaw, anchors, historicalOwnedEntitlementAssetRaw: null, competingMRaw: null, capsuleSha256: p.history.capsule.sha256, verifiedHistoryAvailableAtUtc: c.provenance.historyAvailableAtUtc ?? c.provenance.verifiedReplayCompletedAtUtc!, readAtUtc: w.current.readAtUtc, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as ApprovedMorphoV2IdleHolderForecastEvidence
    originals.set(result, { key, approvedAtMs: expected.asOfMs, sourceAtMs: sourceAt, readAtMs: readAt, availableAtMs: availableAt }); return result
  } catch { return null }
}
export function selectedMorphoV2IdleHolderForecastEvidence(value: unknown, expected: MorphoV2IdleHolderForecastEvidenceExpectation): ApprovedMorphoV2IdleHolderForecastEvidence | null {
  try {
    check(value !== null && typeof value === 'object'); const original = originals.get(value), key = expectation(expected)
    check(original && original.key === key && expected.asOfMs >= original.approvedAtMs && expected.asOfMs >= original.readAtMs && expected.asOfMs >= original.availableAtMs && expected.asOfMs - original.sourceAtMs <= MORPHO_V2_IDLE_BROWSER_LIMITS.sourceAgeMs)
    return value as ApprovedMorphoV2IdleHolderForecastEvidence
  } catch { return null }
}
