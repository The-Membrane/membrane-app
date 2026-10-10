/** Browser-safe compact panel and fresh native-current replay; approval is local identity only. */
import { sha256, stringToHex } from 'viem'
import {
  MORPHO_V2_IDLE_COMPACT120_SCHEMA, MORPHO_V2_IDLE_COMPACT120_MAX_BYTES,
  expandMorphoV2IdleCompactEndpoint, type MorphoV2IdleCompact120Panel,
} from './morphoV2IdleCompact120Panel'
import { MORPHO_V2_IDLE_COMPACT_PANEL_PIN } from './morphoV2IdleCompactPanelPin'
import {
  morphoV2IdleBrowserDataTree, MORPHO_V2_IDLE_BROWSER_LIMITS,
  approveMorphoV2IdleCurrentBrowserObservation, sameMorphoV2IdleBrowserSource,
  type MorphoV2IdleCurrentBrowserObservation, type MorphoV2IdleHolderForecastEvidenceExpectation,
} from './morphoV2IdleHolderForecastEvidence'
import {
  isAppOwnedMorphoV2IdleTrustedProfile, MORPHO_V2_IDLE_CLAIMS, type MorphoV2IdleTrustedProfile,
} from './morphoV2IdleTrustedProfiles'
import type { MorphoV2IdleIdentity, MorphoV2IdleNativeSource, MorphoV2IdleRegime } from './morphoV2IdleJointStockProjection'

const HASH = /^[0-9a-f]{64}$/, CODE_HASH = /^0x[0-9a-f]{64}$/, ZERO = '0x' + '0'.repeat(40)
const EMPTY_CODE = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
const bytes = (text: string) => new TextEncoder().encode(text).length
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function check(ok: unknown): asserts ok { if (!ok) throw Error('idle_compact_panel_invalid') }
function own(x: unknown, keys: readonly string[]): asserts x is Record<string, unknown> {
  check(x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k)))
}
function uint(x: unknown, positive = false): x is string {
  return typeof x === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(x) && BigInt(x) < 1n << 256n && (!positive || BigInt(x) > 0n)
}
function utc(x: unknown): x is string { return typeof x === 'string' && Number.isSafeInteger(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x }
function basename(x: unknown): x is string { return typeof x === 'string' && x.length > 0 && x.length <= 200 && /^[a-zA-Z0-9._:-]+$/.test(x) && !x.includes('..') }
function hash(x: unknown): x is string { return typeof x === 'string' && HASH.test(x) }
function freeze<T>(x: T): T { if (x !== null && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }

/** Semantic decoding is unbranded. Callers must not treat it as original approved evidence. */
export function decodeMorphoV2IdleCompactPanel(text: unknown, profile: MorphoV2IdleTrustedProfile): MorphoV2IdleCompact120Panel | null {
  try {
    check(isAppOwnedMorphoV2IdleTrustedProfile(profile) && typeof text === 'string' && text.length <= MORPHO_V2_IDLE_COMPACT120_MAX_BYTES && bytes(text) <= MORPHO_V2_IDLE_COMPACT120_MAX_BYTES)
    const value: unknown = JSON.parse(text); check(JSON.stringify(value) === text && morphoV2IdleBrowserDataTree(value))
    own(value, ['schema', 'identity', 'recordedProbe', 'actualAvailabilityAtUtc', 'sourceCommitments', 'sourceArchives', 'endpoints', 'cohorts', 'pairs', 'regimes', 'censorReasons', 'counts', 'retrospectiveScores', 'disclosure', 'claims'])
    const x = value as unknown as MorphoV2IdleCompact120Panel
    check(x.schema === MORPHO_V2_IDLE_COMPACT120_SCHEMA && same(x.identity, profile.identity))
    own(x.recordedProbe, ['owner', 'sharesRaw', 'quoteKind', 'historicalOwnedEntitlement'])
    check(x.recordedProbe.owner === profile.history.captureOwner && x.recordedProbe.sharesRaw === profile.history.captureSharesRaw && x.recordedProbe.quoteKind === 'native_preview_redeem_recorded_probe_stock' && x.recordedProbe.historicalOwnedEntitlement === null && utc(x.actualAvailabilityAtUtc))
    own(x.sourceCommitments, ['retentionDirectoryBasename', 'retentionManifestFileSha256', 'replayTerminalFileSha256', 'rootReplayProofFileSha256', 'referencesFileSha256', 'selectedScoreFileSha256', 'headerReplayFileSha256', 'catalogSha256', 'headerExecutionAcceptance'])
    check(x.sourceCommitments.retentionDirectoryBasename === 'morpho-v2-idle-header-replaced60-parent-backtest-2026-10-10-60391e52-2a76-4aae-b234-9cbaaf62cd77' && x.sourceCommitments.retentionManifestFileSha256 === '519b89e907ea5b33ca9d0d057c842e0d20908aae73321775afd3334383659e2d' && x.sourceCommitments.replayTerminalFileSha256 === 'aa0c2c6bbbd44ca947828fc1d3fcfdd61d0732fb9344194f187b659f920dbd7e' && x.sourceCommitments.referencesFileSha256 === 'fa90684008871b81e6f8cec698ccfd74a4ee2de4fa323ea3c3075091f37371e7' && x.sourceCommitments.selectedScoreFileSha256 === '7cf9af59b9f37020dce9b5d6bda1d499adfa2b7014998d22cd9613176bf25603' && x.sourceCommitments.headerReplayFileSha256 === '89f1415f6d7e65f701370143178acf143701e6a1639f40e85c7f95b99e082fca' && x.sourceCommitments.catalogSha256 === '88333133c895b7bba37a83677cb91388e9fc12b3462599f480d537f5d6ed517f' && hash(x.sourceCommitments.rootReplayProofFileSha256))
    own(x.sourceCommitments.headerExecutionAcceptance, ['path', 'bytes', 'fileSha256'])
    check(x.sourceCommitments.headerExecutionAcceptance.path === '/Users/EBmic/membrane-app/data/research/venue-signals/morpho-v2-idle-header-backfill-parent-acceptance-2026-10-10-015a13f5-aa80-4647-9087-2f0a4f402495/manifest.json' && x.sourceCommitments.headerExecutionAcceptance.bytes === 162182 && x.sourceCommitments.headerExecutionAcceptance.fileSha256 === '6ec086dd2da69195cb4511ff16c3f30d1645e927aaba9411e08ad3c134f0bcaa')
    check(Array.isArray(x.sourceArchives) && x.sourceArchives.length >= 3 && x.sourceArchives.length <= 8)
    for (const archive of x.sourceArchives) { own(archive, ['directoryBasename', 'manifestFileSha256']); check(basename(archive.directoryBasename) && hash(archive.manifestFileSha256)) }
    check(new Set(x.sourceArchives.map(a => a.directoryBasename)).size === x.sourceArchives.length)
    check(Array.isArray(x.regimes) && x.regimes.length === 2 && Array.isArray(x.censorReasons) && x.censorReasons.length === 2)
    for (const reasons of x.censorReasons) check(Array.isArray(reasons) && (reasons.length === 0 || same(reasons, ['idle_regime_differed', 'configuration_or_runtime_mismatch'])))
    check(new Set(x.censorReasons.map(a => JSON.stringify(a))).size === 2)
    for (const r of x.regimes) {
      own(r, ['nativeRegimeKind', 'liquidityAdapter', 'liquidityData', 'vaultRuntime', 'assetRuntime', 'ownerRuntime'])
      check(r.liquidityData === '0x' && (r.liquidityAdapter === ZERO && r.nativeRegimeKind === 'zero_liquidity_adapter_empty_data' || r.liquidityAdapter === '0x80126555b170957dfed67a3bfbb7893e20fe4fc0' && r.nativeRegimeKind === 'other_native_configuration'))
      for (const role of ['vault', 'asset', 'owner'] as const) {
        const runtime = r[`${role}Runtime`]; own(runtime, ['bytes', 'keccak256'])
        check(Number.isSafeInteger(runtime.bytes) && runtime.bytes === (role === 'owner' ? 0 : profile.runtimes[role].bytes) && typeof runtime.keccak256 === 'string' && CODE_HASH.test(runtime.keccak256) && runtime.keccak256 === (role === 'owner' ? EMPTY_CODE : profile.runtimes[role].codeHash))
      }
    }
    check(new Set(x.regimes.map(r => r.liquidityAdapter)).size === 2 && Array.isArray(x.endpoints) && x.endpoints.length === 120 && Array.isArray(x.cohorts) && x.cohorts.length === 60 && Array.isArray(x.pairs) && x.pairs.length === 60)
    let priorTime = -Infinity, priorBlock = 0n, usable = 0
    const hashes = new Set<string>(), directories = new Set<string>()
    for (const c of x.cohorts) {
      check(Array.isArray(c) && c.length === 8 && basename(c[0]) && !directories.has(c[0])); directories.add(c[0])
      check(c.slice(1, 6).every(hash) && Array.isArray(c[6]) && c[6].length > 0 && c[6].length <= x.sourceArchives.length && c[6].every(i => Number.isSafeInteger(i) && i >= 0 && i < x.sourceArchives.length) && new Set(c[6]).size === c[6].length && (c[7] === null || utc(c[7]) && Date.parse(c[7]) <= Date.parse(x.actualAvailabilityAtUtc)))
    }
    for (const [i, p] of x.endpoints.entries()) {
      check(Array.isArray(p) && p.length === 10 && uint(p[0], true) && typeof p[1] === 'string' && CODE_HASH.test(p[1]) && !hashes.has(p[1]) && utc(p[2]) && p[2].endsWith('.000Z'))
      hashes.add(p[1]); const t = Date.parse(p[2]); check(t > priorTime && BigInt(p[0]) > priorBlock && t <= Date.parse(x.actualAvailabilityAtUtc)); priorTime = t; priorBlock = BigInt(p[0])
      check(p.slice(3, 7).every(v => uint(v)) && BigInt(p[6]) >= BigInt(x.recordedProbe.sharesRaw) && (p[7] === null || uint(p[7])) && Number.isSafeInteger(p[8]) && p[8] >= 0 && p[8] < x.regimes.length && Number.isSafeInteger(p[9]) && p[9] >= 0 && p[9] < x.censorReasons.length)
      const idle = x.regimes[p[8]].liquidityAdapter === ZERO, uncensored = x.censorReasons[p[9]].length === 0
      check(idle === uncensored && idle === (i >= 12)); if (idle) usable++
    }
    for (const [i, p] of x.pairs.entries()) {
      check(Array.isArray(p) && p.length === 4 && Number.isSafeInteger(p[2]) && Number.isSafeInteger(p[3]) && p[2] >= 0 && p[2] <= i && p[3] >= 0 && p[3] <= p[2])
      check(i < 6 ? p[0] === 'censored' && p[1] === 'configuration_or_runtime_mismatch' : i === 6 ? p[0] === 'censored' && p[1] === 'cold_start_no_strictly_prior_usable_donor' : p[0] === 'scored' && p[1] === null)
    }
    own(x.counts, ['plannedEndpoints', 'usableEndpoints', 'censoredEndpoints', 'plannedPairs', 'nativeEndpointPairs', 'jointComparisons', 'censoredJointPairs'])
    check(usable === 108 && same(x.counts, { plannedEndpoints: 120, usableEndpoints: 108, censoredEndpoints: 12, plannedPairs: 60, nativeEndpointPairs: 54, jointComparisons: 53, censoredJointPairs: 7 }))
    own(x.retrospectiveScores, ['joint', 'matchedPersistence', 'allNativePersistence', 'availableErrorImproved', 'shortfallErrorImproved'])
    const score = (s: unknown, n: number, available: string, shortfall: string, matched: number) => { own(s, ['comparisons', 'availableAbsoluteErrorSumRaw', 'shortfallAbsoluteErrorSumRaw', 'endpointInsufficiencyClassificationMatches']); check(s.comparisons === n && s.availableAbsoluteErrorSumRaw === available && s.shortfallAbsoluteErrorSumRaw === shortfall && s.endpointInsufficiencyClassificationMatches === matched) }
    score(x.retrospectiveScores.joint, 53, '727336', '509433', 52); score(x.retrospectiveScores.matchedPersistence, 53, '715779', '500000', 52); score(x.retrospectiveScores.allNativePersistence, 54, '715813', '500000', 53)
    check(x.retrospectiveScores.availableErrorImproved === false && x.retrospectiveScores.shortfallErrorImproved === false)
    own(x.disclosure, ['horizonMs', 'requestedRaw', 'competingMRaw', 'retrospectivePartitionLabels', 'pairsPerPartition', 'allCashEndpointsPreviouslyInspected', 'oldOctoberJointEndpointsPreviouslyInspected', 'netCashDeltaAlreadyIncludesCompetingFlow', 'additionalCompetingFlowSubtraction', 'observedEndpointsPerPair', 'dailyEndpointsCertifyContinuousDuration', 'modeledSamplesAreNativeOutcomes', 'donorEndMustPrecedeIssue'])
    check(same(x.disclosure, { horizonMs: 86400000, requestedRaw: '500000', competingMRaw: null, retrospectivePartitionLabels: ['fit', 'calibration', 'holdout'], pairsPerPartition: 20, allCashEndpointsPreviouslyInspected: true, oldOctoberJointEndpointsPreviouslyInspected: true, netCashDeltaAlreadyIncludesCompetingFlow: true, additionalCompetingFlowSubtraction: false, observedEndpointsPerPair: 2, dailyEndpointsCertifyContinuousDuration: false, modeledSamplesAreNativeOutcomes: false, donorEndMustPrecedeIssue: true }))
    own(x.claims, ['nativeReplayPerformedByBuilder', 'originalAuthority', 'profileApproval', 'live', 'historicalOwnership', 'historicalOwnedEntitlementMeasured', 'currentWalletControl', 'sourceImplementationEquivalence', 'arbitrarySharesNativeRepricing', 'executionVerified', 'authenticated', 'calibrated', 'calibratedProbability', 'untouchedHoldout', 'prospectiveValidation', 'accuracyImprovementClaim', 'coveragePromotion'])
    check(Object.values(x.claims).every(v => v === false)); return freeze(x)
  } catch { return null }
}
export function pinnedMorphoV2IdleCompactPanel(text: unknown, profile: MorphoV2IdleTrustedProfile): MorphoV2IdleCompact120Panel | null {
  const p = MORPHO_V2_IDLE_COMPACT_PANEL_PIN
  if (typeof text !== 'string' || !hash(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes === null || p.bytes <= 0 || p.bytes > MORPHO_V2_IDLE_COMPACT120_MAX_BYTES || bytes(text) !== p.bytes || sha256(stringToHex(text)).slice(2) !== p.sha256) return null
  return decodeMorphoV2IdleCompactPanel(text, profile)
}
export type MorphoV2IdlePanelHolderForecastEvidenceWire = {
  schema: 'morpho_v2_idle_holder_forecast_evidence_v2'; panelText: string; current: MorphoV2IdleCurrentBrowserObservation
}
export function decodeMorphoV2IdlePanelHolderForecastEvidence(text: unknown): MorphoV2IdlePanelHolderForecastEvidenceWire | null {
  try {
    check(typeof text === 'string' && text.length <= MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes && bytes(text) <= MORPHO_V2_IDLE_BROWSER_LIMITS.envelopeBytes)
    const x: unknown = JSON.parse(text); check(JSON.stringify(x) === text && morphoV2IdleBrowserDataTree(x)); own(x, ['schema', 'panelText', 'current'])
    check(x.schema === 'morpho_v2_idle_holder_forecast_evidence_v2' && typeof x.panelText === 'string' && bytes(x.panelText) <= MORPHO_V2_IDLE_COMPACT120_MAX_BYTES)
    return freeze(x) as unknown as MorphoV2IdlePanelHolderForecastEvidenceWire
  } catch { return null }
}
export function encodeMorphoV2IdlePanelHolderForecastEvidence(x: unknown): string | null {
  try { check(morphoV2IdleBrowserDataTree(x)); const text = JSON.stringify(x); return decodeMorphoV2IdlePanelHolderForecastEvidence(text) ? text : null } catch { return null }
}
declare const approvedPanelEvidence: unique symbol
export type ApprovedMorphoV2IdlePanelHolderForecastEvidence = Readonly<{
  identity: MorphoV2IdleIdentity; owner: string; source: MorphoV2IdleNativeSource; regime: MorphoV2IdleRegime
  currentSharesRaw: string; currentIdleCashRaw: string; currentFullEaRaw: string
  totalAssetsDiagnosticRaw: string; totalSupplyDiagnosticSharesRaw: string
  panel: MorphoV2IdleCompact120Panel; panelSha256: string; verifiedHistoryAvailableAtUtc: string; readAtUtc: string
  entitlementBasis: 'native_same_stock' | 'conditional_quote_rate_interval'
  historicalOwnedEntitlementAssetRaw: null; competingMRaw: null; claims: typeof MORPHO_V2_IDLE_CLAIMS
  readonly [approvedPanelEvidence]: true
}>
const originals = new WeakMap<object, { key: string; approvedAtMs: number; sourceAtMs: number; readAtMs: number; availableAtMs: number }>()
function expectationKey(x: MorphoV2IdleHolderForecastEvidenceExpectation) {
  check(isAppOwnedMorphoV2IdleTrustedProfile(x.profile) && typeof x.owner === 'string' && /^0x[0-9a-f]{40}$/.test(x.owner) && uint(x.sharesRaw, true) && uint(x.fullEaRaw) && Number.isSafeInteger(x.asOfMs))
  return JSON.stringify([x.profile.id, x.owner, x.source, x.sharesRaw, x.fullEaRaw])
}
export function approveMorphoV2IdlePanelHolderForecastEvidence(value: unknown, expected: MorphoV2IdleHolderForecastEvidenceExpectation): ApprovedMorphoV2IdlePanelHolderForecastEvidence | null {
  try {
    check(morphoV2IdleBrowserDataTree(expected)); own(expected, ['profile', 'owner', 'source', 'sharesRaw', 'fullEaRaw', 'asOfMs']); const key = expectationKey(expected)
    const w = decodeMorphoV2IdlePanelHolderForecastEvidence(typeof value === 'string' ? value : encodeMorphoV2IdlePanelHolderForecastEvidence(value)); check(w)
    const panel = pinnedMorphoV2IdleCompactPanel(w.panelText, expected.profile); check(panel)
    const availableAt = Date.parse(panel.actualAvailabilityAtUtc), sourceAt = Date.parse(expected.source.blockTime)
    check(availableAt <= expected.asOfMs && Date.parse(w.current.startedAtUtc) >= availableAt && sameMorphoV2IdleBrowserSource(w.current.source, expected.source))
    const current = approveMorphoV2IdleCurrentBrowserObservation(w.current, expected); check(current)
    for (let i = 0; i < 120; i++) { const p = expandMorphoV2IdleCompactEndpoint(panel, i); check(p && Date.parse(p.source.blockTime) <= sourceAt && BigInt(p.source.blockNumber) <= BigInt(expected.source.blockNumber)) }
    const p = expected.profile, regime: MorphoV2IdleRegime = { kind: 'zero_adapter_idle', liquidityAdapter: p.configured.liquidityAdapter, liquidityData: '0x', vaultRuntimeCodeHash: p.runtimes.vault.codeHash, assetRuntimeCodeHash: p.runtimes.asset.codeHash }
    const result = freeze({ identity: structuredClone(p.identity), owner: expected.owner, source: structuredClone(expected.source), regime, currentSharesRaw: expected.sharesRaw, currentIdleCashRaw: current.idleCashRaw, currentFullEaRaw: current.fullEaRaw, totalAssetsDiagnosticRaw: current.totalAssetsRaw, totalSupplyDiagnosticSharesRaw: current.totalSupplyRaw, panel, panelSha256: MORPHO_V2_IDLE_COMPACT_PANEL_PIN.sha256!, verifiedHistoryAvailableAtUtc: panel.actualAvailabilityAtUtc, readAtUtc: w.current.readAtUtc, entitlementBasis: expected.sharesRaw === panel.recordedProbe.sharesRaw ? 'native_same_stock' as const : 'conditional_quote_rate_interval' as const, historicalOwnedEntitlementAssetRaw: null, competingMRaw: null, claims: MORPHO_V2_IDLE_CLAIMS }) as unknown as ApprovedMorphoV2IdlePanelHolderForecastEvidence
    originals.set(result, { key, approvedAtMs: expected.asOfMs, sourceAtMs: sourceAt, readAtMs: Date.parse(w.current.readAtUtc), availableAtMs: availableAt }); return result
  } catch { return null }
}
export function selectedMorphoV2IdlePanelHolderForecastEvidence(value: unknown, expected: MorphoV2IdleHolderForecastEvidenceExpectation): ApprovedMorphoV2IdlePanelHolderForecastEvidence | null {
  try {
    check(value !== null && typeof value === 'object' && morphoV2IdleBrowserDataTree(expected)); own(expected, ['profile', 'owner', 'source', 'sharesRaw', 'fullEaRaw', 'asOfMs'])
    const original = originals.get(value); check(original && original.key === expectationKey(expected) && expected.asOfMs >= original.approvedAtMs && expected.asOfMs >= original.readAtMs && expected.asOfMs >= original.availableAtMs && expected.asOfMs >= original.sourceAtMs && expected.asOfMs - original.sourceAtMs <= MORPHO_V2_IDLE_BROWSER_LIMITS.sourceAgeMs)
    return value as ApprovedMorphoV2IdlePanelHolderForecastEvidence
  } catch { return null }
}
