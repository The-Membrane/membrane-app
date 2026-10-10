/** Server-only byte replay. Browser consumers must import profile metadata or types only. */
import { createHash } from 'node:crypto'
import { decodeMorphoV2RlusdOriginalResearch } from './morphoV2RlusdOriginalResearch'
import { keccak256 } from 'viem'
import { decodeMorphoProbeNativeRow, MORPHO_NATIVE_HEADER_RESPONSE_POLICY, morphoProbeResponseByteLimit } from '../../scripts/research/morpho-probe-raw-body-storage.mjs'
import { verifyProbeControl } from '../../scripts/research/morpho-observed-funded-holder-probe.mjs'
import { parseUsd3HypotheticalJson } from '../../scripts/research/usd3-hypothetical-history-capture.mjs'
import {
  isAppOwnedMorphoV2IdleTrustedProfile, MORPHO_V2_IDLE_CLAIMS,
  type MorphoV2IdleTrustedProfile, type MorphoV2IdleSource, type MorphoV2IdleIdentity,
} from './morphoV2IdleTrustedProfiles'

export const MORPHO_V2_IDLE_HISTORY_LIMITS = Object.freeze({ fileBytes: 6 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, files: 200 })
const HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
const MAX_UINT = (1n << 256n) - 1n
const UINT = /^(0|[1-9][0-9]*)$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error('morpho_idle_history_' + reason)
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function uint(value: unknown, positive = false): value is string {
  return typeof value === 'string' && value.length <= 78 && UINT.test(value) && BigInt(value) <= MAX_UINT && (!positive || BigInt(value) > 0n)
}
function utc(value: unknown): value is string {
  return typeof value === 'string' && Number.isSafeInteger(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
}
function source(value: any): value is MorphoV2IdleSource {
  return value !== null && typeof value === 'object' && value.chainId === 1 && uint(value.blockNumber, true) && HASH.test(value.blockHash) && utc(value.blockTime) && value.finalized === true
}
function dataTree(value: unknown, seen = new WeakSet<object>(), depth = 0, count = { n: 0 }): boolean {
  if (++count.n > 20000 || depth > 32) return false
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') <= MORPHO_V2_IDLE_HISTORY_LIMITS.fileBytes
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value'))) return false
  if (array && Object.keys(descriptors).length !== value.length + 1) return false
  seen.add(value)
  try { return Object.entries(descriptors).every(([key, d]) => array && key === 'length' || d.enumerable && dataTree(d.value, seen, depth + 1, count)) }
  finally { seen.delete(value) }
}
function parse(text: unknown, expectedSha?: string): any {
  check(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MORPHO_V2_IDLE_HISTORY_LIMITS.fileBytes, 'file_size')
  if (expectedSha !== undefined) check(digest(text) === expectedSha, 'file_hash')
  const value = parseUsd3HypotheticalJson(text)
  check(value && typeof value === 'object' && !Array.isArray(value), 'json_object')
  return value
}
function sealed(text: string, expectedSha?: string): any {
  const value = parse(text, expectedSha), { sha256, ...body } = value
  check(typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) && digest(JSON.stringify(body)) === sha256, 'seal')
  return value
}
const falseCaptureFlags = [
  'authenticated', 'originalAuthority', 'historicalOwnership', 'currentWalletControl', 'profileApproval',
  'sourceImplementationEquivalence', 'holderExecutableExit', 'forecastEligibility', 'calibrated',
  'coveragePromotion', 'executionAuthority', 'forecastAuthority', 'calibratedProbability',
] as const
function captureClaims(value: any) {
  check(value.researchOnly === true && falseCaptureFlags.every((key) => value[key] === false) && value.competingMRaw === null && value.MRaw === null, 'authority_flags')
}
export type MorphoV2IdleRegime = Readonly<{
  kind: 'zero_adapter_idle'; liquidityAdapter: string; liquidityData: '0x'
  vaultRuntimeCodeHash: string; assetRuntimeCodeHash: string
}>
export type MorphoV2IdleHistoricalPoint = Readonly<{
  identity: MorphoV2IdleIdentity; owner: string; source: MorphoV2IdleSource; regime: MorphoV2IdleRegime
  idleCashRaw: string; historicalOwnerSharesRaw: string | null
  fixedCurrentStockConversion: Readonly<{
    method: 'native_preview_redeem_fixed_current_shares'; source: MorphoV2IdleSource
    probeSharesRaw: string; asset: string; assetDecimals: number; shareDecimals: number; assetsRaw: string
  }>
}>
export type MorphoV2IdleDecodedPoint = Readonly<{
  historicalPoint: MorphoV2IdleHistoricalPoint; actualOwnerSharesRaw: string; totalAssetsRaw: string
  totalSupplySharesRaw: string; ownerCodeRaw: '0x'; historicalOwnedEntitlementAssetRaw: null
  claims: typeof MORPHO_V2_IDLE_CLAIMS
}>
export type MorphoV2IdleNativeTrace = {
  host: string; key: string; physicalId: number
  request: { jsonrpc: string; id: number; method: string; params: unknown[] }
  envelope: { jsonrpc: string; id: number; result?: unknown; error?: unknown }
}
function header(result: any, expected: MorphoV2IdleSource) {
  check(result && typeof result === 'object' && result.hash === expected.blockHash &&
    typeof result.number === 'string' && /^0x[0-9a-f]+$/.test(result.number) && BigInt(result.number).toString() === expected.blockNumber &&
    typeof result.timestamp === 'string' && /^0x[0-9a-f]+$/.test(result.timestamp) &&
    BigInt(result.timestamp) <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)), 'header')
  check(new Date(Number(BigInt(result.timestamp)) * 1000).toISOString() === expected.blockTime, 'header_time')
}
const POINT_KEYS = ['chain', 'header_before', 'vault_code', 'asset_code', 'owner_code', 'asset', 'share_decimals',
  'asset_decimals', 'liquidity_adapter', 'liquidity_data', 'idle_cash', 'total_assets', 'total_supply',
  'actual_owner_shares', 'fixed_stock_preview', 'header_after'] as const
/** Semantic decoder only. Its plain result is not an original branded history or execution receipt. */
export function decodeMorphoV2IdleNativePoint(profile: MorphoV2IdleTrustedProfile, input: {
  label: string; source: MorphoV2IdleSource; owner: string; probeSharesRaw: string
  traces: readonly MorphoV2IdleNativeTrace[]; currentCaptureReference: boolean
}): MorphoV2IdleDecodedPoint {
  check(isAppOwnedMorphoV2IdleTrustedProfile(profile), 'profile_identity')
  check(dataTree(input) && source(input.source) && ADDRESS.test(input.owner) && uint(input.probeSharesRaw, true) &&
    /^[a-zA-Z0-9_]{1,64}$/.test(input.label) && typeof input.currentCaptureReference === 'boolean' && input.traces.length === 32, 'point_input')
  const block = { blockHash: input.source.blockHash, requireCanonical: true }, identity = profile.identity
  const expected: Record<string, { method: string; params: unknown[] }> = {
    chain: { method: 'eth_chainId', params: [] },
    header_before: { method: 'eth_getBlockByNumber', params: ['0x' + BigInt(input.source.blockNumber).toString(16), false] },
    header_after: { method: 'eth_getBlockByNumber', params: ['0x' + BigInt(input.source.blockNumber).toString(16), false] },
    vault_code: { method: 'eth_getCode', params: [identity.destination, block] },
    asset_code: { method: 'eth_getCode', params: [identity.asset, block] },
    owner_code: { method: 'eth_getCode', params: [input.owner, block] },
  }
  const calls: Record<string, [string, string]> = {
    asset: [identity.destination, '0x38d52e0f'], share_decimals: [identity.destination, '0x313ce567'],
    asset_decimals: [identity.asset, '0x313ce567'], liquidity_adapter: [identity.destination, '0xad468d11'],
    liquidity_data: [identity.destination, '0x2e029228'], idle_cash: [identity.asset, '0x70a08231' + identity.destination.slice(2).padStart(64, '0')],
    total_assets: [identity.destination, '0x01e1d114'], total_supply: [identity.destination, '0x18160ddd'],
    actual_owner_shares: [identity.destination, '0x70a08231' + input.owner.slice(2).padStart(64, '0')],
    fixed_stock_preview: [identity.destination, morphoV2IdlePreviewRedeemCalldata(input.probeSharesRaw)],
  }
  for (const [key, [to, data]] of Object.entries(calls)) expected[key] = { method: 'eth_call', params: [{ to, data }, block] }
  const values: Record<string, any> = {}
  for (const [index, key] of POINT_KEYS.entries()) {
    const pair = input.traces.slice(index * 2, index * 2 + 2)
    for (const [origin, trace] of pair.entries()) {
      check(trace.host === HOSTS[origin] && trace.key === input.label + ':' + key &&
        Number.isSafeInteger(trace.physicalId) && trace.physicalId > 0 && trace.physicalId <= 100 &&
        trace.request.jsonrpc === '2.0' && Number.isSafeInteger(trace.request.id) && trace.request.id > 0 &&
        trace.request.method === expected[key].method && same(trace.request.params, expected[key].params) &&
        trace.envelope.jsonrpc === '2.0' && trace.envelope.id === trace.request.id &&
        Object.hasOwn(trace.envelope, 'result') && !Object.hasOwn(trace.envelope, 'error'), 'point_request')
      if (index > 0) check(trace.physicalId > input.traces[(index - 1) * 2 + origin].physicalId, 'point_order')
    }
    if (key === 'header_before' || key === 'header_after') pair.forEach((trace) => header(trace.envelope.result, input.source))
    else check(same(pair[0].envelope.result, pair[1].envelope.result), 'provider_disagreement')
    values[key] = pair[0].envelope.result
  }
  check(values.chain === '0x1', 'chain')
  for (const key of ['vault', 'asset'] as const) {
    const code = values[key + '_code']
    check(typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(code) && (code.length - 2) / 2 === profile.runtimes[key].bytes &&
      keccak256(code as `0x${string}`) === profile.runtimes[key].codeHash, 'runtime')
  }
  check(values.owner_code === '0x', 'owner_code')
  const word = (key: string) => { check(typeof values[key] === 'string' && /^0x[0-9a-f]{64}$/.test(values[key]), 'abi_word'); return BigInt(values[key]) }
  check(word('asset') === BigInt(identity.asset) && word('share_decimals') === BigInt(identity.shareDecimals) &&
    word('asset_decimals') === BigInt(identity.assetDecimals), 'units_asset')
  check(word('liquidity_adapter') === 0n && values.liquidity_data === '0x' + '20'.padStart(64, '0') + '0'.repeat(64), 'idle_regime')
  const actualOwnerSharesRaw = word('actual_owner_shares').toString()
  if (input.currentCaptureReference) check(actualOwnerSharesRaw === input.probeSharesRaw, 'current_stock')
  const regime: MorphoV2IdleRegime = { kind: 'zero_adapter_idle', liquidityAdapter: profile.configured.liquidityAdapter,
    liquidityData: '0x', vaultRuntimeCodeHash: profile.runtimes.vault.codeHash, assetRuntimeCodeHash: profile.runtimes.asset.codeHash }
  return freeze({ historicalPoint: { identity, owner: input.owner, source: { ...input.source }, regime,
    idleCashRaw: word('idle_cash').toString(), historicalOwnerSharesRaw: input.currentCaptureReference ? null : actualOwnerSharesRaw,
    fixedCurrentStockConversion: { method: 'native_preview_redeem_fixed_current_shares', source: { ...input.source },
      probeSharesRaw: input.probeSharesRaw, asset: identity.asset, assetDecimals: identity.assetDecimals,
      shareDecimals: identity.shareDecimals, assetsRaw: word('fixed_stock_preview').toString() } },
    actualOwnerSharesRaw, totalAssetsRaw: word('total_assets').toString(), totalSupplySharesRaw: word('total_supply').toString(),
    ownerCodeRaw: '0x', historicalOwnedEntitlementAssetRaw: null, claims: MORPHO_V2_IDLE_CLAIMS } as const)
}
export function morphoV2IdlePreviewRedeemCalldata(sharesRaw: unknown): `0x${string}` {
  check(uint(sharesRaw, true), 'shares')
  return ('0x4cdad506' + BigInt(sharesRaw).toString(16).padStart(64, '0')) as `0x${string}`
}
export type MorphoV2IdleArchiveTexts = {
  nativeFiles: Readonly<Record<string, string>>; companionManifestText: string
  companionFiles: Readonly<Record<string, string>>
  normalizationTexts?: Readonly<{ manifestText: string; factsText: string; rootReadbackText: string }>
}
export function inspectMorphoV2IdleArchiveManifests(profile: MorphoV2IdleTrustedProfile, terminalText: string, companionManifestText: string) {
  check(isAppOwnedMorphoV2IdleTrustedProfile(profile), 'profile_identity')
  if (profile.history.kind === 'rlusd_acceptance_v1') return inspectRlusdArchive(profile, terminalText, companionManifestText)
  const terminal = sealed(terminalText, profile.history.terminalFileSha256)
  const companion = parse(companionManifestText, profile.history.companionManifestSha256)
  check(terminal.schema === 'pyusd_b576_idle_history_terminal_v2' && Array.isArray(terminal.files) && terminal.files.length === 108, 'terminal_manifest')
  const nativeNames = ['terminal.json', 'report.json', 'control-summary.json', 'plan.json', 'source-0.json',
    ...Array.from({ length: 6 }, (_, i) => 'input-' + i + '.json'), ...Array.from({ length: 98 }, (_, i) => 'native-row-' + String(i + 1).padStart(3, '0') + '.json')]
  const names = terminal.files.map((x: any) => x.file)
  check(names.every((x: unknown) => typeof x === 'string' && BASENAME.test(x)) && new Set(names).size === 108 &&
    same([...names, 'terminal.json'].sort(), [...nativeNames].sort()), 'native_closed_set')
  check(companion.schema === 'pyusd_b576_native_original_source_companion_v1' && companion.nativeDirectory === profile.history.nativeDirectory &&
    companion.nativeTerminalFileSha256 === profile.history.terminalFileSha256 && companion.nativeReportFileSha256 === profile.history.reportFileSha256 &&
    companion.fileCount === 62 && Array.isArray(companion.files) && companion.files.length === 62 &&
    companion.nativePhysicalStarts === 98 && companion.nativeFiles === 109 && companion.nativeBytes === profile.history.nativeBytes &&
    companion.verifiedReplayCompletedAtUtc === profile.history.verifiedReplayCompletedAtUtc &&
    companion.MRaw === null && companion.profileApproval === false && companion.forecastEligibility === false &&
    companion.executionQualified === false && companion.calibrated === false && companion.coveragePromotion === false, 'companion_manifest')
  const companionNames = companion.files.map((x: any) => x.name)
  check(companionNames.every((x: unknown) => typeof x === 'string' && BASENAME.test(x)) && new Set(companionNames).size === 62 &&
    companionNames.filter((x: string) => /^original-[0-9]{2}-/.test(x)).length === 54 &&
    Array.from({ length: 54 }, (_, i) => 'original-' + String(i).padStart(2, '0') + '-').every((prefix) => companionNames.filter((x: string) => x.startsWith(prefix)).length === 1) &&
    Array.from({ length: 4 }, (_, i) => ['parent-' + i + '-proof.json', 'parent-' + i + '-output.log']).flat().every((name) => companionNames.includes(name)), 'companion_closed_set')
  return { terminal, companion, nativeNames, companionNames }
}
declare const historyBrand: unique symbol
export type MorphoV2IdleNativeHistory = Readonly<{
  identity: MorphoV2IdleIdentity; captureOwner: string; captureSharesRaw: string
  anchors: readonly [MorphoV2IdleHistoricalPoint, MorphoV2IdleHistoricalPoint]
  capturedCurrent: Readonly<{ historicalReferenceOnly: true; observation: MorphoV2IdleDecodedPoint }>
  provenance: Readonly<{ nativeDirectory: string; nativeFiles: number; nativeBytes: number; physicalStarts: 98
    reportedAvailableAtUtc: string; verifiedReplayCompletedAtUtc: string | null
    historyAvailableAtUtc?: string; captureAvailableAtUtc?: string; rootNormalizationCompletedAtUtc?: string; independentReplayCompletedAtUtc?: null; sourcePins: number; inputPins: number }>
  claims: typeof MORPHO_V2_IDLE_CLAIMS
  readonly [historyBrand]: true
}>
const historyInstances = new WeakMap<object, MorphoV2IdleTrustedProfile>()
export function isOriginalMorphoV2IdleNativeHistory(value: unknown, profile?: MorphoV2IdleTrustedProfile): value is MorphoV2IdleNativeHistory {
  if (!value || typeof value !== 'object') return false
  const originalProfile = historyInstances.get(value)
  return originalProfile !== undefined && (profile === undefined || originalProfile === profile)
}
/** Only the entire pinned byte proof can mint identity; approval booleans and summary clones cannot. */
export function replayMorphoV2IdleNativeHistory(profile: MorphoV2IdleTrustedProfile, archive: MorphoV2IdleArchiveTexts): MorphoV2IdleNativeHistory {
  check(isAppOwnedMorphoV2IdleTrustedProfile(profile), 'profile_identity')
  check(dataTree(archive), 'archive_data')
  if (profile.history.kind === 'rlusd_acceptance_v1') return replayRlusdArchive(profile, archive)
  const manifest = inspectMorphoV2IdleArchiveManifests(profile, archive.nativeFiles['terminal.json'], archive.companionManifestText)
  check(same(Object.keys(archive.nativeFiles).sort(), [...manifest.nativeNames].sort()) &&
    same(Object.keys(archive.companionFiles).sort(), [...manifest.companionNames].sort()), 'archive_closed_set')
  const allTexts = [...Object.values(archive.nativeFiles), archive.companionManifestText, ...Object.values(archive.companionFiles)]
  check(allTexts.length <= MORPHO_V2_IDLE_HISTORY_LIMITS.files && allTexts.every((text) => typeof text === 'string' && Buffer.byteLength(text) <= MORPHO_V2_IDLE_HISTORY_LIMITS.fileBytes) &&
    allTexts.reduce((n, text) => n + Buffer.byteLength(text), 0) <= MORPHO_V2_IDLE_HISTORY_LIMITS.totalBytes, 'archive_budget')
  const native: Record<string, any> = {}
  for (const entry of manifest.terminal.files) {
    check(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes === Buffer.byteLength(archive.nativeFiles[entry.file]) &&
      digest(archive.nativeFiles[entry.file]) === entry.fileSha256, 'native_file_pin')
    native[entry.file] = sealed(archive.nativeFiles[entry.file])
  }
  const nativeBytes = Object.values(archive.nativeFiles).reduce((n, text) => n + Buffer.byteLength(text), 0)
  check(nativeBytes === profile.history.nativeBytes && digest(archive.nativeFiles['report.json']) === profile.history.reportFileSha256, 'native_totals')
  const originals = new Map<string, { text: string; bytes: number; sha256: string }>()
  let companionBytes = 0
  for (const entry of manifest.companion.files) {
    const text = archive.companionFiles[entry.name], bytes = Buffer.byteLength(text); companionBytes += bytes
    check(bytes === entry.bytes && digest(text) === entry.sha256 && entry.originalIdentity?.sha256 === entry.sha256 &&
      entry.copyIdentity?.sha256 === entry.sha256 && entry.originalIdentity?.bytes === bytes && entry.copyIdentity?.bytes === bytes, 'archived_original_pin')
    if (entry.name.startsWith('original-')) {
      const prefix = '/Users/EBmic/membrane-app/'
      check(typeof entry.originalPath === 'string' && entry.originalPath.startsWith(prefix), 'original_relative_path')
      const path = entry.originalPath.slice(prefix.length)
      check(!originals.has(path), 'original_duplicate')
      originals.set(path, { text, bytes, sha256: entry.sha256 })
    }
  }
  check(companionBytes === manifest.companion.totalBytes && originals.size === 54, 'companion_totals')
  const plan = parse(native['plan.json'].rawText, native['plan.json'].fileSha256)
  const selfPath = 'scripts/research/pyusd-b576-idle-history-capture-v2.mjs'
  const planPath = 'scripts/research/pyusd-b576-idle-history-capture-v2.plan.json'
  check(originals.get(planPath)?.text === native['plan.json'].rawText && plan.schema === 'pyusd_b576_idle_history_native_join_plan_v2' &&
    plan.revision === 2 && plan.subject.vault === profile.identity.destination && plan.subject.asset === profile.identity.asset &&
    plan.subject.owner === profile.history.captureOwner && plan.subject.assetDecimals === profile.identity.assetDecimals &&
    plan.subject.shareDecimals === profile.identity.shareDecimals && same(plan.origins, HOSTS) &&
    plan.sourcePins.length === 46 && plan.inputPins.length === 6 && same(plan.anchors.map((x: any) => x.source), profile.history.anchors), 'archive_plan')
  captureClaims(plan)
  for (const pin of [...plan.sourcePins, ...plan.inputPins]) {
    const preserved = originals.get(pin.path)
    check(preserved && preserved.bytes === pin.bytes && preserved.sha256 === pin.fileSha256, 'archived_source_or_input')
  }
  for (const [index, pin] of plan.inputPins.entries()) {
    const input = native['input-' + index + '.json']
    check(same(input.pin, pin) && input.rawText === originals.get(pin.path)?.text, 'input_byte_proof')
    captureClaims(input)
  }
  const sourceEntries = native['source-0.json'].sources
  const expectedSources = [...plan.retainedSourcePaths, selfPath]
  check(sourceEntries.length === expectedSources.length && new Set(sourceEntries.map((x: any) => x.pin.path)).size === expectedSources.length &&
    same(sourceEntries.map((x: any) => x.pin.path).sort(), [...expectedSources].sort()), 'operational_source_set')
  for (const entry of sourceEntries) {
    const original = originals.get(entry.pin.path)
    check(original && original.text === entry.sourceText && original.bytes === entry.pin.bytes && original.sha256 === entry.pin.fileSha256, 'source_byte_proof')
  }
  const report = native['report.json'], terminal = manifest.terminal, control = native['control-summary.json']
  for (const value of [report, terminal, control, native['source-0.json'], native['plan.json']]) captureClaims(value)
  check(report.schema === 'pyusd_b576_idle_history_native_join_report_v2' && report.completeNativeAcquisition === true && report.qualifiedNativeJoin === true &&
    report.failure === null && report.physicalStarts === 98 && report.scheduledReads === 98 && report.maximumPhysicalStarts === 100 &&
    report.maximumPlannedPhysicalStarts === 98 && report.logStarts === 0 && report.freshCurrentSharesRaw === profile.history.captureSharesRaw &&
    report.historicalProbeBasis === 'hypothetical_fixed_current_stock_conversion' && report.historicalOwnedEntitlementMeasured === false &&
    report.stationaryRegimePooling === false && report.unknownCompetingMRaw === null && report.cutoffTimerCleared === true && report.acquisitionExpired === false &&
    report.acquisitionDeadlineElapsedMs === 115000 && report.retentionReserveMs === 5000 && Number.isFinite(report.nativeAcquisitionElapsedMs) &&
    report.nativeAcquisitionElapsedMs >= 0 && report.nativeAcquisitionElapsedMs < 115000 && source(report.currentSource) &&
    utc(report.nativeAcquisitionCompletedAtUtc) && Date.parse(report.nativeAcquisitionCompletedAtUtc) >= Date.parse(report.currentSource.blockTime) &&
    Date.parse(report.nativeAcquisitionCompletedAtUtc) - Date.parse(report.currentSource.blockTime) <= 1800000, 'report')
  check(terminal.reportSha256 === report.sha256 && terminal.completeNativeAcquisition === true && terminal.qualifiedNativeJoin === true &&
    terminal.failure === null && terminal.physicalStarts === 98 && terminal.pendingSettlements === 0 && terminal.retainedRows === 98 &&
    terminal.acquisitionDeadlineElapsedMs === 115000 && terminal.retentionReserveMs === 5000 && Number.isFinite(terminal.elapsedMs) &&
    terminal.elapsedMs >= report.nativeAcquisitionElapsedMs && terminal.elapsedMs < 120000 && same(terminal.currentSource, report.currentSource), 'terminal')
  check(control.schema === 'pyusd_b576_idle_history_original_control_v2' && same(control.source, report.currentSource) &&
    control.unmatchedRequests.length === 0 && same(control.requestOrder, Array.from({ length: 98 }, (_, i) => i + 1)) &&
    control.rows.length === 98 && same(control.receiptKeyOrder, ['startedAtUtc', 'availableAtUtc', 'elapsedMs', 'physicalStarts', 'pendingSettlements', 'failure', 'ledger', 'terminalCommitments']), 'control_summary')
  const restored: any[] = []
  for (const [index, rowPin] of control.rows.entries()) {
    check(rowPin.file === 'native-row-' + String(index + 1).padStart(3, '0') + '.json' && rowPin.commitments.physicalId === index + 1, 'row_order')
    restored.push(decodeMorphoProbeNativeRow(native[rowPin.file], { namespace: control.namespace, physicalId: index + 1, source: control.source, ...rowPin.commitments }))
  }
  const receipt = Object.fromEntries(control.receiptKeyOrder.map((key: string) => [key, key === 'ledger' ? restored.map((x) => x.observation) : control.receipt[key]]))
  verifyProbeControl(receipt, restored.map((x) => x.request), restored.map((x) => x.settlement), control.namespace)
  const traces: MorphoV2IdleNativeTrace[] = restored.map((row) => {
    const raw = Buffer.from(row.observation.rawBodyBase64, 'base64'), envelope = parse(raw.toString('utf8'))
    check(row.observation.host === HOSTS[(row.physicalId - 1) % 2] && row.request.rpcId === row.physicalId &&
      row.observation.httpStatus === 200 && row.observation.safeCode === null && raw.length <= 65536 &&
      row.observation.completedElapsedMs < 115000, 'physical_row')
    return { host: row.observation.host, key: row.request.key, physicalId: row.physicalId, request: row.observation.request, envelope }
  })
  const finalized = traces.slice(0, 2)
  finalized.forEach((trace) => {
    check(trace.key === 'fresh_finalized' && trace.request.method === 'eth_getBlockByNumber' && same(trace.request.params, ['finalized', false]) &&
      trace.envelope.id === trace.request.id && trace.envelope.jsonrpc === '2.0' && !Object.hasOwn(trace.envelope, 'error'), 'finalized_request')
    header(trace.envelope.result, report.currentSource)
  })
  check(report.points.length === 3, 'points')
  const points = ['current', 'anchor_0', 'anchor_1'].map((label, index) => {
    const nativeSource = index === 0 ? report.currentSource : profile.history.anchors[index - 1]
    const point = decodeMorphoV2IdleNativePoint(profile, { label, source: nativeSource, owner: profile.history.captureOwner,
      probeSharesRaw: report.freshCurrentSharesRaw, traces: traces.slice(2 + index * 32, 34 + index * 32), currentCaptureReference: index === 0 })
    const supplied = report.points[index]; captureClaims(supplied)
    check(same(supplied.nativeReferences, POINT_KEYS.map((key, offset) => ({ key: label + ':' + key,
      physicalIds: traces.slice(2 + index * 32 + offset * 2, 4 + index * 32 + offset * 2).map((trace) => trace.physicalId) }))), 'reported_native_references')
    check(supplied.label === label && supplied.qualifiedNativeJoin === true && supplied.qualificationReasons.length === 0 &&
      same(supplied.source, nativeSource) && supplied.vault === profile.identity.destination && supplied.asset === profile.identity.asset &&
      supplied.owner === profile.history.captureOwner && supplied.assetDecimals === profile.identity.assetDecimals && supplied.shareDecimals === profile.identity.shareDecimals &&
      supplied.nativeAsset === profile.identity.asset && supplied.nativeAssetDecimals === profile.identity.assetDecimals && supplied.nativeShareDecimals === profile.identity.shareDecimals &&
      supplied.cashAssetDecimals === profile.identity.assetDecimals && supplied.totalAssetsAssetDecimals === profile.identity.assetDecimals &&
      supplied.totalSupplyShareDecimals === profile.identity.shareDecimals && supplied.actualOwnerShareDecimals === profile.identity.shareDecimals &&
      supplied.probeShareDecimals === profile.identity.shareDecimals && supplied.probeEaAssetDecimals === profile.identity.assetDecimals &&
      supplied.regimeKind === 'zero_liquidity_adapter_empty_data' &&
      supplied.CAssetRaw === point.historicalPoint.idleCashRaw && supplied.totalAssetsRaw === point.totalAssetsRaw &&
      supplied.totalSupplySharesRaw === point.totalSupplySharesRaw && supplied.actualOwnerSharesRaw === point.actualOwnerSharesRaw &&
      supplied.probeSharesRaw === report.freshCurrentSharesRaw && supplied.probeEaAssetRaw === point.historicalPoint.fixedCurrentStockConversion.assetsRaw &&
      supplied.liquidityAdapter === profile.configured.liquidityAdapter && supplied.liquidityData === '0x' && supplied.LLTV === null && supplied.allocation === null &&
      supplied.LLTVStatus === 'inapplicable_idle_no_adapter' && supplied.CMeaning === 'asset.balanceOf(exact_vault)_only' &&
      supplied.cashIsTotalAssets === false && supplied.cashIsOwnedEntitlement === false && supplied.historicalOwnedEntitlementAssetRaw === null &&
      supplied.historicalOwnedEntitlementMeasured === false && supplied.ownerCodeStatus === 'no_code' && supplied.ownerCodeRawIfEmpty === '0x', 'reported_point')
    for (const key of ['vault', 'asset'] as const) check(supplied.runtimes[key].runtimeByteLength === profile.runtimes[key].bytes &&
      supplied.runtimes[key].runtimeKeccak256 === profile.runtimes[key].codeHash, 'reported_runtime')
    if (index === 0) check(supplied.conversionBasis === 'fresh_current_owner_full_stock' && supplied.freshCurrentFullEaAssetRaw === supplied.probeEaAssetRaw && supplied.actualHistoricalOwnerSharesRaw === null, 'capture_reference')
    else check(supplied.conversionBasis === 'hypothetical_fixed_current_stock_conversion' && supplied.freshCurrentFullEaAssetRaw === null &&
      supplied.actualHistoricalOwnerSharesRaw === point.actualOwnerSharesRaw && supplied.expectedCashRaw === plan.anchors[index - 1].expectedCashRaw &&
      supplied.CAssetRaw === plan.anchors[index - 1].expectedCashRaw, 'historical_reference')
    return point
  })
  const self = originals.get(selfPath)
  check(self && same(report.sourcePins, [...plan.sourcePins, { path: selfPath, bytes: self.bytes, fileSha256: self.sha256 }]) && same(report.inputPins, plan.inputPins), 'report_source_pins')
  for (let i = 0; i < 4; i++) {
    const proof = parse(archive.companionFiles['parent-' + i + '-proof.json']), output = archive.companionFiles['parent-' + i + '-output.log']
    check(proof.exitCode === 0 && proof.stopReason === null && proof.heapMiB === 384 && same(proof.pinDrift, []) &&
      proof.logBytes === Buffer.byteLength(output) && proof.logSha256 === digest(output), 'parent_proof')
  }
  const replay = parse(archive.companionFiles['parent-3-proof.json']).result
  check(replay.originalControlVerified === true && replay.fetchStarts === 0 && replay.physicalStarts === 98 && replay.retainedBytes === nativeBytes &&
    same(replay.currentSource, report.currentSource) && same(replay.points, report.points) && replay.reportedAvailableAtUtc === terminal.postRetentionAvailableAtUtc &&
    replay.completedReadbackAtUtc === profile.history.verifiedReplayCompletedAtUtc && utc(replay.completedReadbackAtUtc) && utc(terminal.postRetentionAvailableAtUtc) &&
    Date.parse(replay.completedReadbackAtUtc) >= Date.parse(terminal.postRetentionAvailableAtUtc), 'post_retention_readback')
  const history = freeze({ identity: profile.identity, captureOwner: profile.history.captureOwner, captureSharesRaw: report.freshCurrentSharesRaw,
    anchors: [points[1].historicalPoint, points[2].historicalPoint], capturedCurrent: { historicalReferenceOnly: true, observation: points[0] },
    provenance: { nativeDirectory: profile.history.nativeDirectory, nativeFiles: 109, nativeBytes: 2335675, physicalStarts: 98,
      reportedAvailableAtUtc: terminal.postRetentionAvailableAtUtc, verifiedReplayCompletedAtUtc: replay.completedReadbackAtUtc,
      sourcePins: plan.sourcePins.length, inputPins: plan.inputPins.length }, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as MorphoV2IdleNativeHistory
  historyInstances.set(history, profile)
  return history
}
/** RLUSD archive format is independent of PYUSD's flat companion format. */
function inspectRlusdArchive(profile: MorphoV2IdleTrustedProfile, terminalText: string, companionText: string) {
  const terminal = sealed(terminalText, profile.history.terminalFileSha256)
  const companion = sealed(companionText, profile.history.companionManifestSha256)
  check(terminal.schema === 'morpho_v2_rlusd_idle_holder_terminal_v1' && terminal.files.length === 102, 'rlusd_terminal')
  const nativeNames = ['terminal.json', ...terminal.files.map((entry: any) => entry.file)]
  check(nativeNames.length === profile.history.nativeFiles && new Set(nativeNames).size === nativeNames.length && nativeNames.every((name: string) => BASENAME.test(name)), 'rlusd_native_names')
  check(companion.schema === 'rlusd_parent_acceptance_archive_v1' && companion.inventoryFiles === 79 && companion.inventory.length === 79 && companion.inventoryBytes === 4963894, 'rlusd_acceptance')
  const companionNames = companion.inventory.map((entry: any) => entry.file)
  check(new Set(companionNames).size === 79 && companionNames.every(morphoV2IdleSafeArchivePath) && !companionNames.includes('manifest.json'), 'rlusd_acceptance_names')
  return { terminal, companion, nativeNames, companionNames: [...companionNames, 'manifest.sha256'] }
}
/** Paths name retained copies only; they never resolve a current implementation pin. */
export function morphoV2IdleSafeArchivePath(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 1024 && name.split('/').length <= 32 && name.split('/').every(part => /^[A-Za-z0-9._@+-]{1,255}$/.test(part) && part !== '.' && part !== '..')
}
function replayRlusdArchive(profile: MorphoV2IdleTrustedProfile, archive: MorphoV2IdleArchiveTexts): MorphoV2IdleNativeHistory {
  const manifest = inspectRlusdArchive(profile, archive.nativeFiles['terminal.json'], archive.companionManifestText)
  check(same(Object.keys(archive.nativeFiles).sort(), [...manifest.nativeNames].sort()) && same(Object.keys(archive.companionFiles).sort(), [...manifest.companionNames].sort()), 'rlusd_closed_set')
  check(archive.companionFiles['manifest.sha256'] === profile.history.companionManifestSha256 + '  manifest.json\n', 'rlusd_manifest_checksum')
  const allTexts = [...Object.values(archive.nativeFiles), archive.companionManifestText, ...Object.values(archive.companionFiles), ...Object.values(archive.normalizationTexts ?? {})]
  check(allTexts.length <= MORPHO_V2_IDLE_HISTORY_LIMITS.files && allTexts.every(text => typeof text === 'string' && Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= MORPHO_V2_IDLE_HISTORY_LIMITS.fileBytes) && allTexts.reduce((n, text) => n + Buffer.byteLength(text), 0) <= MORPHO_V2_IDLE_HISTORY_LIMITS.totalBytes, 'rlusd_budget')
  let acceptanceBytes = 0
  for (const entry of manifest.companion.inventory) {
    const text = archive.companionFiles[entry.file]
    check(Buffer.byteLength(text) === entry.bytes && digest(text) === entry.fileSha256, 'rlusd_acceptance_pin')
    acceptanceBytes += entry.bytes
  }
  check(acceptanceBytes === manifest.companion.inventoryBytes, 'rlusd_acceptance_total')
  const native: Record<string, any> = Object.create(null)
  for (const entry of manifest.terminal.files) {
    const text = archive.nativeFiles[entry.file]
    check(Buffer.byteLength(text) === entry.bytes && digest(text) === entry.fileSha256, 'rlusd_native_pin')
    native[entry.file] = sealed(text)
  }
  const nativeBytes = Object.values(archive.nativeFiles).reduce((n, text) => n + Buffer.byteLength(text), 0)
  check(nativeBytes === profile.history.nativeBytes && digest(archive.nativeFiles['report.json']) === profile.history.reportFileSha256, 'rlusd_native_total')
  const provenance = native['provenance.json']
  check(provenance.sourcePins.length === 51 && provenance.inputPins.length === 4, 'rlusd_pin_counts')
  const pinnedPaths = [...provenance.sourcePins, ...provenance.inputPins]
  check(new Set(pinnedPaths.map((pin: any) => pin.path)).size === 55, 'rlusd_unique_closure')
  for (const pin of pinnedPaths) {
    check(morphoV2IdleSafeArchivePath(pin.path), 'rlusd_closure_path')
    const original = archive.companionFiles['closure/' + pin.path]
    check(typeof original === 'string' && Buffer.byteLength(original) === pin.bytes && digest(original) === pin.fileSha256, 'rlusd_original_closure_pin')
  }
  const originalPlanPath = 'closure/scripts/research/morpho-v2-rlusd-idle-holder-capture-v1.plan.json'
  const originalPlanText = archive.companionFiles[originalPlanPath]
  check(typeof originalPlanText === 'string' && Buffer.byteLength(originalPlanText) === 17153 && digest(originalPlanText) === 'a6f9cbc7dee07add9f905428d76250d52d8dfb97bc4f59f5a8e49118d0d831ee' &&
    native['plan.json'].rawText === originalPlanText && native['plan.json'].fileSha256 === digest(originalPlanText), 'rlusd_separate_original_plan')
  check(same(manifest.companionNames.filter((name: string) => name.startsWith('closure/')).sort(), [...pinnedPaths.map((pin: any) => 'closure/' + pin.path), originalPlanPath].sort()), 'rlusd_exact_closure')
  const report = native['report.json'], control = native['control-summary.json']
  captureClaims(report); captureClaims(manifest.terminal); captureClaims(control); captureClaims(provenance)
  check(report.subject.id === 'RLUSD_CANDIDATE16' && report.subject.vault === profile.identity.destination && report.subject.asset === profile.identity.asset && report.subject.owner === profile.history.captureOwner && report.freshCurrentSharesRaw === profile.history.captureSharesRaw && report.points.length === 3, 'rlusd_capture_tuple')
  const restored: any[] = []
  check(control.rows.length === 98, 'rlusd_control_rows')
  for (const [index, rowPin] of control.rows.entries()) {
    check(rowPin.file === 'native-row-' + String(index + 1).padStart(3, '0') + '.json' && rowPin.commitments.physicalId === index + 1, 'rlusd_row_order')
    restored.push(decodeMorphoProbeNativeRow(native[rowPin.file], { namespace: control.namespace, physicalId: index + 1, source: control.source, ...rowPin.commitments, headerResponsePolicy: MORPHO_NATIVE_HEADER_RESPONSE_POLICY }))
  }
  const receipt = Object.fromEntries(control.receiptKeyOrder.map((key: string) => [key, key === 'ledger' ? restored.map(row => row.observation) : control.receipt[key]]))
  verifyProbeControl(receipt, restored.map(row => row.request), restored.map(row => row.settlement), control.namespace, MORPHO_NATIVE_HEADER_RESPONSE_POLICY)
  const traces: MorphoV2IdleNativeTrace[] = restored.map(row => {
    const raw = Buffer.from(row.observation.rawBodyBase64, 'base64')
    const responseLimit = morphoProbeResponseByteLimit(MORPHO_NATIVE_HEADER_RESPONSE_POLICY, row.observation.request, row.observation.nativeHeaderRole ?? null, row.request.key)
    check(row.observation.host === HOSTS[(row.physicalId - 1) % 2] && row.request.rpcId === row.physicalId && row.observation.httpStatus === 200 && row.observation.safeCode === null && raw.length <= responseLimit, 'rlusd_physical_row')
    return { host: row.observation.host, key: row.request.key, physicalId: row.physicalId, request: row.observation.request, envelope: parse(raw.toString('utf8')) }
  })
  traces.slice(0, 2).forEach(trace => {
    check(trace.key === 'fresh_finalized' && trace.request.method === 'eth_getBlockByNumber' && same(trace.request.params, ['finalized', false]) && trace.envelope.id === trace.request.id && trace.envelope.jsonrpc === '2.0' && !Object.hasOwn(trace.envelope, 'error'), 'rlusd_finalized')
    header(trace.envelope.result, report.currentSource)
  })
  const points = ['current', 'anchor_0', 'anchor_1'].map((label, index) => decodeMorphoV2IdleNativePoint(profile, {
    label, source: index === 0 ? report.currentSource : profile.history.anchors[index - 1], owner: profile.history.captureOwner,
    probeSharesRaw: profile.history.captureSharesRaw, traces: traces.slice(2 + index * 32, 34 + index * 32), currentCaptureReference: index === 0,
  }))
  const facts = decodeMorphoV2RlusdOriginalResearch(archive.nativeFiles['report.json'])
  const normalization = profile.history.normalization, normalized = archive.normalizationTexts
  check(normalization && normalized, 'rlusd_normalization_required')
  const normalizationManifest = parse(normalized.manifestText, normalization.manifestSha256)
  const retainedFacts = parse(normalized.factsText, normalization.factsSha256)
  const rootReadback = parse(normalized.rootReadbackText, normalization.rootReadbackSha256)
  check(normalizationManifest.schema === 'rlusd_original_normalization_parent_acceptance_static_retention_v1' && same(retainedFacts, facts) &&
    rootReadback.schema === 'rlusd_original_root_normalization_v1' && rootReadback.status === 'original_bytes_closure_and_normalized_facts_readback_verified' &&
    rootReadback.completedAtUtc === profile.history.rootNormalizationCompletedAtUtc && rootReadback.bytes === Buffer.byteLength(normalized.factsText) && rootReadback.sha256 === normalization.factsSha256 &&
    rootReadback.newNativeReplay === false && rootReadback.appProfileRegistered === false && rootReadback.liveForecastConnected === false, 'rlusd_normalization_readback')
  const anchors = points.slice(1).map(point => ({ ...point.historicalPoint, historicalOwnerSharesRaw: null })) as [MorphoV2IdleHistoricalPoint, MorphoV2IdleHistoricalPoint]
  check(same(anchors, facts.anchors) && same(facts.captureCurrentReference, report.currentSource), 'rlusd_replayed_projection')
  for (const [index, point] of points.entries()) check(report.points[index].actualOwnerSharesRaw === point.actualOwnerSharesRaw && report.points[index].CAssetRaw === point.historicalPoint.idleCashRaw && report.points[index].probeEaAssetRaw === point.historicalPoint.fixedCurrentStockConversion.assetsRaw, 'rlusd_replayed_values')
  const accepted = manifest.companionNames.filter((name: string) => name.startsWith('accepted/') && name.endsWith('-proof.json'))
  check(accepted.length === 4, 'rlusd_parent_proofs')
  for (const name of accepted) {
    const proof = parse(archive.companionFiles[name]), output = archive.companionFiles[name.replace('-proof.json', '-output.log')]
    check(proof.exitCode === 0 && proof.stopReason === null && proof.heapMiB === 384 && same(proof.pinDrift, []) && proof.logBytes === Buffer.byteLength(output) && proof.logSha256 === digest(output), 'rlusd_parent_proof')
  }
  const capture = parse(archive.companionFiles[accepted.find((name: string) => name.includes('native-holder-capture'))!]).result
  const replay = parse(archive.companionFiles[accepted.find((name: string) => name.includes('native-independent-replay'))!]).result
  check(capture.postRetentionCompletedAtUtc === profile.history.captureAvailableAtUtc && replay.originalControlVerified === true && replay.fetchCalls === 0 && replay.physicalStarts === 98 && replay.retainedBytes === nativeBytes && !Object.hasOwn(replay, 'completedReadbackAtUtc'), 'rlusd_capture_replay_clocks')
  check(profile.history.historyAvailableAtUtc === profile.history.rootNormalizationCompletedAtUtc && utc(profile.history.historyAvailableAtUtc) && utc(profile.history.captureAvailableAtUtc) && Date.parse(profile.history.historyAvailableAtUtc) >= Date.parse(profile.history.captureAvailableAtUtc), 'rlusd_history_availability')
  const history = freeze({ identity: profile.identity, captureOwner: profile.history.captureOwner, captureSharesRaw: profile.history.captureSharesRaw,
    anchors, capturedCurrent: { historicalReferenceOnly: true, observation: points[0] },
    provenance: { nativeDirectory: profile.history.nativeDirectory, nativeFiles: profile.history.nativeFiles, nativeBytes, physicalStarts: 98,
      reportedAvailableAtUtc: capture.postRetentionCompletedAtUtc, verifiedReplayCompletedAtUtc: null, historyAvailableAtUtc: profile.history.historyAvailableAtUtc,
      captureAvailableAtUtc: capture.postRetentionCompletedAtUtc, rootNormalizationCompletedAtUtc: profile.history.rootNormalizationCompletedAtUtc, independentReplayCompletedAtUtc: null,
      sourcePins: provenance.sourcePins.length, inputPins: provenance.inputPins.length }, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as MorphoV2IdleNativeHistory
  historyInstances.set(history, profile)
  return history
}

export type MorphoV2IdleHistoricalPreviewDescriptor = Readonly<{
  source: MorphoV2IdleSource; method: 'eth_call'; sharesRaw: string
  params: readonly [{ readonly to: string; readonly data: `0x${string}` }, { readonly blockHash: string; readonly requireCanonical: true }]
}>
export function morphoV2IdleHistoricalPreviewDescriptors(history: MorphoV2IdleNativeHistory, sharesRaw: unknown): readonly MorphoV2IdleHistoricalPreviewDescriptor[] {
  check(isOriginalMorphoV2IdleNativeHistory(history), 'history_identity')
  const data = morphoV2IdlePreviewRedeemCalldata(sharesRaw)
  return freeze(history.anchors.map((point) => ({ source: point.source, method: 'eth_call', sharesRaw: sharesRaw as string,
    params: [{ to: history.identity.destination, data }, { blockHash: point.source.blockHash, requireCanonical: true }] }))) as readonly MorphoV2IdleHistoricalPreviewDescriptor[]
}
/** Shares valuation is owner-independent; old ownership diagnostics are never assigned to a different wallet. */
export function selectMorphoV2IdleHistoryForStock(history: MorphoV2IdleNativeHistory, freshOwner: unknown, freshSharesRaw: unknown):
  | Readonly<{ status: 'matched'; points: readonly MorphoV2IdleHistoricalPoint[]; descriptors: readonly MorphoV2IdleHistoricalPreviewDescriptor[] }>
  | Readonly<{ status: 'stock_mismatch'; points: null; descriptors: readonly MorphoV2IdleHistoricalPreviewDescriptor[] }> {
  check(isOriginalMorphoV2IdleNativeHistory(history) && typeof freshOwner === 'string' && ADDRESS.test(freshOwner), 'history_owner')
  const descriptors = morphoV2IdleHistoricalPreviewDescriptors(history, freshSharesRaw)
  if (freshSharesRaw !== history.captureSharesRaw) return freeze({ status: 'stock_mismatch', points: null, descriptors } as const)
  return freeze({ status: 'matched', descriptors, points: history.anchors.map((point) => ({ ...point, owner: freshOwner,
    historicalOwnerSharesRaw: freshOwner === history.captureOwner ? point.historicalOwnerSharesRaw : null })) } as const)
}
