/** Browser-local v2 models/receipts. Native fixed-stock history and conditional other-stock math stay distinct. */
import { agreeHolderExitCapacityQuotes, selectedHolderExitCapacity, type HolderExitCapacityAgreement, type HolderExitCapacityBinding } from './holderExitCapacity'
import {
  approveMorphoV2IdlePanelHolderForecastEvidence, selectedMorphoV2IdlePanelHolderForecastEvidence,
  type ApprovedMorphoV2IdlePanelHolderForecastEvidence,
} from './morphoV2IdleCompactPanelEvidence'
import { expandMorphoV2IdleCompactEndpoint, type MorphoV2IdleCompact120Panel } from './morphoV2IdleCompact120Panel'
import { morphoV2IdleBrowserDataTree, MORPHO_V2_IDLE_BROWSER_HOSTS, type MorphoV2IdleHolderForecastEvidenceExpectation } from './morphoV2IdleHolderForecastEvidence'
import {
  buildMorphoV2IdleJointStockProjection, MORPHO_V2_IDLE_JOINT_STOCK_POLICY,
  type MorphoV2IdleHistoricalPoint, type MorphoV2IdleJointStockProjection, type MorphoV2IdleNativeSource,
} from './morphoV2IdleJointStockProjection'
import { buildMorphoV2IdleJointIntervalProjection, type MorphoV2IdleConditionalHistoricalPoint, type MorphoV2IdleJointIntervalProjection } from './morphoV2IdleJointIntervalProjection'
import { resolveMorphoV2IdleTrustedProfile, type MorphoV2IdleTrustedProfile } from './morphoV2IdleTrustedProfiles'
import type { MorphoV2IdleJointHolderForecastQuestion } from './morphoV2IdleJointHolderForecastBinding'
import { buildSampledShortageRuns, type SampledShortageRuns } from './sampledShortageRuns'
import { buildModeledShortageWindows, type ModeledShortageWindows } from './modeledShortageWindows'

const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/
function uint(x: unknown, positive = false): x is string { return typeof x === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(x) && BigInt(x) < 1n << 256n && (!positive || BigInt(x) > 0n) }
function record(x: unknown): x is Record<string, unknown> { return x !== null && typeof x === 'object' && !Array.isArray(x) }
function own(x: Record<string, unknown>, required: string[], optional: string[] = []) { return required.every(k => Object.hasOwn(x, k)) && Object.keys(x).every(k => required.includes(k) || optional.includes(k)) }
function freeze<T>(x: T): T { if (x !== null && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }
function question(value: unknown): { q: MorphoV2IdleJointHolderForecastQuestion; profile: MorphoV2IdleTrustedProfile } | null {
  if (!morphoV2IdleBrowserDataTree(value) || !record(value) || !own(value, ['routeKey', 'destination', 'requestedRaw', 'requestedAssetAddress', 'requestedAssetDecimals', 'requestedHolderAddress', 'horizonHours', 'asOfMs'], ['independentSource'])) return null
  if (typeof value.destination !== 'string' || typeof value.requestedAssetAddress !== 'string' || typeof value.requestedHolderAddress !== 'string') return null
  const destination = value.destination.toLowerCase(), asset = value.requestedAssetAddress.toLowerCase(), owner = value.requestedHolderAddress.toLowerCase()
  if (!ADDRESS.test(destination) || !ADDRESS.test(asset) || !ADDRESS.test(owner) || !uint(value.requestedRaw, true) || !Number.isSafeInteger(value.asOfMs) || !Number.isSafeInteger(value.horizonHours) || Number(value.horizonHours) <= 0 || Number(value.horizonHours) * 3600000 > MORPHO_V2_IDLE_JOINT_STOCK_POLICY.maximumHorizonMs) return null
  const profile = resolveMorphoV2IdleTrustedProfile(value.routeKey, destination, asset)
  if (!profile || value.requestedAssetDecimals !== profile.identity.assetDecimals) return null
  let independentSource: MorphoV2IdleJointHolderForecastQuestion['independentSource']
  if (Object.hasOwn(value, 'independentSource')) {
    const s = value.independentSource
    if (!record(s) || !own(s, ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']) || s.chainId !== 1 || s.finalized !== true || !Number.isSafeInteger(s.blockNumber) || Number(s.blockNumber) <= 0 || typeof s.blockHash !== 'string' || !HASH.test(s.blockHash) || typeof s.blockTime !== 'string' || !Number.isSafeInteger(Date.parse(s.blockTime)) || new Date(Date.parse(s.blockTime)).toISOString() !== s.blockTime) return null
    independentSource = structuredClone(s) as MorphoV2IdleJointHolderForecastQuestion['independentSource']
  }
  return { profile, q: freeze({ routeKey: profile.identity.routeKey, destination, requestedRaw: value.requestedRaw, requestedAssetAddress: asset, requestedAssetDecimals: profile.identity.assetDecimals, requestedHolderAddress: owner, horizonHours: Number(value.horizonHours), asOfMs: Number(value.asOfMs), ...(independentSource ? { independentSource } : {}) }) }
}
export type MorphoV2IdlePanelCapacityInterval = Readonly<{
  lowerAvailableRaw: string; upperAvailableRaw: string; lowerHeadroomRaw: string; upperHeadroomRaw: string
  lowerShortfallRaw: string; upperShortfallRaw: string; basis: 'empirical_donor_integer_envelope_not_confidence'
  empiricalMean: { lowerAvailableRaw: string; upperAvailableRaw: string; lowerHeadroomRaw: string; upperHeadroomRaw: string; lowerShortfallRaw: string; upperShortfallRaw: string }
}>
export type MorphoV2IdlePanelSampledIntervalSummary = Readonly<{
  firstSampledPossibleInsufficiencyMs: number | null; firstSampledDefiniteInsufficiencyMs: number | null
  latestAffectedSampledInsufficiencyMs: number | null
  maxCheckpointGapMs: number; relevantScenarioCount: number; neverInsufficientScenarioCount: number; censoredScenarioCount: number
  basis: 'full_donor_sample_band_conditional_not_guaranteed'; unknownBetweenCheckpoints: true; continuousProof: false
}>
export type MorphoV2IdlePanelSampledShortageSummary = Readonly<{
  possible: { earliestFirstSampledShortageMs: number | null; latestBoundedRecoveryMs: number | null; rightCensoredScenarioCount: number; anyRightCensored: boolean; leftCensoredScenarioCount: number; neverShortageScenarioCount: number }
  definite: { earliestFirstSampledShortageMs: number | null; latestBoundedRecoveryMs: number | null; rightCensoredScenarioCount: number; anyRightCensored: boolean; leftCensoredScenarioCount: number; neverShortageScenarioCount: number }
  relevantScenarioCount: number; censoredScenarioCount: number
  modeled: true; continuousProof: false; measuredHistoryDuration: false; unknownBetweenCheckpoints: true; guaranteedDurationMs: null
}>
export type MorphoV2IdlePanelModeledShortageLaneSummary = Readonly<{
  episodeCount: number; neverShortageScenarioCount: number
  leftCensoredScenarioCount: number; rightCensoredScenarioCount: number
  anyLeftCensored: boolean; anyRightCensored: boolean
  earliestOnsetMs: number | null; latestBoundedRecoveryMs: number | null
  modeledWindowDurationRangeMs: { lowerMs: number; upperMs: number } | null
  fullEpisodeDurationRangeMs: { lowerMs: number; upperMs: number | null } | null
}>
export type MorphoV2IdlePanelModeledShortageSummary = Readonly<{
  possible: MorphoV2IdlePanelModeledShortageLaneSummary; definite: MorphoV2IdlePanelModeledShortageLaneSummary
  relevantScenarioCount: number; censoredScenarioCount: number
  basis: 'individual_analytical_model_windows_not_sample_spans'
  modeled: true; actualHistoricalContinuousDuration: false; measuredHistoryDuration: false
  calibrated: false; continuousProof: false; guaranteedDurationMs: null
}>
type Original = { questionKey: string; q: MorphoV2IdleJointHolderForecastQuestion; capacity: HolderExitCapacityAgreement; capacityBinding: HolderExitCapacityBinding; evidence: ApprovedMorphoV2IdlePanelHolderForecastEvidence; expectation: MorphoV2IdleHolderForecastEvidenceExpectation }
const models = new WeakMap<object, Original>()
declare const originalPanelForecast: unique symbol
export type MorphoV2IdleJointHolderForecastV2 = Readonly<{
  status: 'conditional_morpho_v2_idle_panel_holder_forecast'; profileId: string
  question: MorphoV2IdleJointHolderForecastQuestion; issuedAtMs: number; targetAtUtc: string
  source: MorphoV2IdleNativeSource; sourceProofValidUntil: string; owner: string
  currentSharesRaw: string; currentFullEaRaw: string; currentIdleCashRaw: string
  capsuleSha256: string; verifiedHistoryAvailableAtUtc: string
  entitlementBasis: 'native_same_stock' | 'conditional_quote_rate_interval'
  process: MorphoV2IdleJointStockProjection | MorphoV2IdleJointIntervalProjection
  capacityInterval: MorphoV2IdlePanelCapacityInterval; sampledIntervalSummary: MorphoV2IdlePanelSampledIntervalSummary
  sampledShortageRuns: readonly (SampledShortageRuns & { scenarioId: string })[]
  sampledShortageSummary: MorphoV2IdlePanelSampledShortageSummary
  modeledShortageWindows: readonly { scenarioId: string; possible: ModeledShortageWindows; definite: ModeledShortageWindows }[]
  modeledShortageSummary: MorphoV2IdlePanelModeledShortageSummary
  panelInspection: { counts: MorphoV2IdleCompact120Panel['counts']; retrospectiveScores: MorphoV2IdleCompact120Panel['retrospectiveScores']; disclosure: MorphoV2IdleCompact120Panel['disclosure']; configurationCensoredPairs: number; causalUsablePairs: number; historicalOwnership: false; accuracyImprovementClaim: false }
  claims: MorphoV2IdleJointStockProjection['claims']; readonly [originalPanelForecast]: true
}>
function project(e: ApprovedMorphoV2IdlePanelHolderForecastEvidence, q: MorphoV2IdleJointHolderForecastQuestion) {
  const donors: { id: string; start: MorphoV2IdleConditionalHistoricalPoint; end: MorphoV2IdleConditionalHistoricalPoint }[] = []
  let configurationCensoredPairs = 0
  for (let pair = 0; pair < 60; pair++) {
    const a = expandMorphoV2IdleCompactEndpoint(e.panel, pair * 2)!, b = expandMorphoV2IdleCompactEndpoint(e.panel, pair * 2 + 1)!
    if (a.censorReasons.length || b.censorReasons.length) { configurationCensoredPairs++; continue }
    if (Date.parse(b.source.blockTime) >= Date.parse(e.source.blockTime) || Date.parse(b.source.blockTime) >= q.asOfMs || BigInt(b.source.blockNumber) >= BigInt(e.source.blockNumber)) continue
    const point = (p: typeof a): MorphoV2IdleConditionalHistoricalPoint => ({ identity: structuredClone(e.identity), source: structuredClone(p.source), regime: structuredClone(e.regime), idleCashRaw: p.idleCashRaw, recordedProbeSharesRaw: e.panel.recordedProbe.sharesRaw, recordedQuoteAssetsRaw: p.recordedProbeQuoteAssetsRaw, totalSupplySharesRaw: p.totalSupplySharesRaw, historicalOwnerSharesRaw: e.owner === e.panel.recordedProbe.owner ? p.historicalOwnerSharesRaw : null })
    donors.push({ id: 'native_panel_pair_' + pair, start: point(a), end: point(b) })
  }
  const common = { identity: structuredClone(e.identity), owner: e.owner, currentSource: structuredClone(e.source), currentRegime: structuredClone(e.regime), currentSharesRaw: e.currentSharesRaw, currentIdleCashRaw: e.currentIdleCashRaw, currentFullEaRaw: e.currentFullEaRaw, asOfMs: q.asOfMs, horizonMs: q.horizonHours * 3600000, requestedRaw: q.requestedRaw, competingMRaw: null }
  let process: MorphoV2IdleJointStockProjection | MorphoV2IdleJointIntervalProjection | null
  if (e.entitlementBasis === 'native_same_stock') {
    const nativePoint = (p: MorphoV2IdleConditionalHistoricalPoint): MorphoV2IdleHistoricalPoint => ({ identity: p.identity, owner: e.owner, source: p.source, regime: p.regime, idleCashRaw: p.idleCashRaw, historicalOwnerSharesRaw: p.historicalOwnerSharesRaw, fixedCurrentStockConversion: { method: 'native_preview_redeem_fixed_current_shares', source: structuredClone(p.source), probeSharesRaw: p.recordedProbeSharesRaw, asset: e.identity.asset, assetDecimals: e.identity.assetDecimals, shareDecimals: e.identity.shareDecimals, assetsRaw: p.recordedQuoteAssetsRaw } })
    process = buildMorphoV2IdleJointStockProjection({ ...common, donors: donors.map(d => ({ id: d.id, start: nativePoint(d.start), end: nativePoint(d.end) })) })
  } else process = buildMorphoV2IdleJointIntervalProjection({ ...common, recordedProbeSharesRaw: e.panel.recordedProbe.sharesRaw, donors })
  if (!process?.descriptive.headline || process.usableDonorCount !== donors.length || process.censoredDonorCount !== 0) return null
  const lower = process.descriptive.headline, upper = process.status === 'conditional_morpho_v2_idle_joint_entitlement_interval_projection' ? process.entitlementIntervals.headline?.upper : lower
  if (!upper) return null
  const capacityInterval: MorphoV2IdlePanelCapacityInterval = { lowerAvailableRaw: lower.available.minimumRaw, upperAvailableRaw: upper.available.maximumRaw, lowerHeadroomRaw: lower.headroom.minimumRaw, upperHeadroomRaw: upper.headroom.maximumRaw, lowerShortfallRaw: upper.shortfall.minimumRaw, upperShortfallRaw: lower.shortfall.maximumRaw, basis: 'empirical_donor_integer_envelope_not_confidence', empiricalMean: { lowerAvailableRaw: lower.available.empiricalMeanFloorRaw, upperAvailableRaw: upper.available.empiricalMeanFloorRaw, lowerHeadroomRaw: lower.headroom.empiricalMeanFloorRaw, upperHeadroomRaw: upper.headroom.empiricalMeanFloorRaw, lowerShortfallRaw: upper.shortfall.empiricalMeanFloorRaw, upperShortfallRaw: lower.shortfall.empiricalMeanFloorRaw } }
  const possible: (number | null)[] = [], gaps: number[] = []
  for (const s of process.scenarios) {
    if (s.status !== 'usable') continue
    possible.push(s.sampledTimeline.firstSampledInsufficiencyMs); gaps.push(s.sampledTimeline.maxCheckpointGapMs)
  }
  const possibleTimes = possible.filter((x): x is number => x !== null)
  const usable = process.scenarios.filter(s => s.status === 'usable')
  let firstCommonInsufficiency: number | null = null
  if (usable.length === process.scenarios.length && usable.length) {
    for (let i = 0; i < usable[0].sampledTimeline.checkpoints.length; i++) {
      if (usable.every(s => BigInt('sampledIntervalTimeline' in s ? s.sampledIntervalTimeline.checkpoints[i].availableUpperRaw : s.sampledTimeline.checkpoints[i].availableRaw) < BigInt(q.requestedRaw))) { firstCommonInsufficiency = usable[0].sampledTimeline.checkpoints[i].elapsedMs; break }
    }
  }
  const sampledIntervalSummary: MorphoV2IdlePanelSampledIntervalSummary = { firstSampledPossibleInsufficiencyMs: possibleTimes.length ? Math.min(...possibleTimes) : null, firstSampledDefiniteInsufficiencyMs: firstCommonInsufficiency, latestAffectedSampledInsufficiencyMs: possibleTimes.length ? Math.max(...possibleTimes) : null, maxCheckpointGapMs: Math.max(...gaps), relevantScenarioCount: process.scenarios.length, neverInsufficientScenarioCount: possible.filter(t => t === null).length, censoredScenarioCount: process.censoredDonorCount, basis: 'full_donor_sample_band_conditional_not_guaranteed', unknownBetweenCheckpoints: true, continuousProof: false }
  const sampledShortageRuns: (SampledShortageRuns & { scenarioId: string })[] = []
  for (const s of usable) {
    const checkpoints = 'sampledIntervalTimeline' in s ? s.sampledIntervalTimeline.checkpoints.map(p => ({ elapsedMs: p.elapsedMs, possibleInsufficiency: p.possibleInsufficiency, definiteInsufficiency: p.definiteInsufficiency })) : s.sampledTimeline.checkpoints.map(p => ({ elapsedMs: p.elapsedMs, possibleInsufficiency: BigInt(p.shortfallRaw) > 0n, definiteInsufficiency: BigInt(p.shortfallRaw) > 0n }))
    const runs = buildSampledShortageRuns({ horizonMs: process.horizonMs, checkpoints })
    if (!runs) return null
    sampledShortageRuns.push({ scenarioId: s.id, ...runs })
  }
  const summarize = (key: 'possible' | 'definite') => {
    const lanes = sampledShortageRuns.map(s => s[key]), first = lanes.flatMap(l => l.runs.length ? [l.runs[0].firstSampledInsufficiencyMs] : []), recoveries = lanes.flatMap(l => l.runs.flatMap(r => r.recoveryBracket ? [r.recoveryBracket.latestElapsedMs] : []))
    return { earliestFirstSampledShortageMs: first.length ? Math.min(...first) : null, latestBoundedRecoveryMs: recoveries.length ? Math.max(...recoveries) : null,
      rightCensoredScenarioCount: lanes.filter(l => l.runs.some(r => r.rightCensored)).length, anyRightCensored: lanes.some(l => l.runs.some(r => r.rightCensored)), leftCensoredScenarioCount: lanes.filter(l => l.runs.some(r => r.leftCensored)).length, neverShortageScenarioCount: lanes.filter(l => l.neverSampledInsufficient).length }
  }
  const sampledShortageSummary: MorphoV2IdlePanelSampledShortageSummary = { possible: summarize('possible'), definite: summarize('definite'), relevantScenarioCount: process.scenarios.length, censoredScenarioCount: process.censoredDonorCount,
    modeled: true, continuousProof: false, measuredHistoryDuration: false, unknownBetweenCheckpoints: true, guaranteedDurationMs: null }
  const modeledShortageWindows: { scenarioId: string; possible: ModeledShortageWindows; definite: ModeledShortageWindows }[] = []
  for (const s of usable) {
    // Raw source stocks anchor the same age + elapsed projection; do not age an issue measurement twice.
    const commonWindows = { currentIdleCashRaw: process.currentObservedMeasurement.projectedIdleCashRaw,
      currentFullEaRaw: process.currentObservedMeasurement.projectedFullEaRaw, idleCashDeltaRaw: s.idleCashDeltaRaw,
      sourceAgeMs: process.sourceAgeMs, periodMs: s.periodMs, horizonMs: process.horizonMs,
      requestedRaw: process.requestedRaw, competingMRaw: process.competingMRaw }
    const delta = 'entitlementDeltaInterval' in s ? s.entitlementDeltaInterval : { lowerRaw: s.fixedShareEaDeltaRaw, upperRaw: s.fixedShareEaDeltaRaw }
    const possibleWindows = buildModeledShortageWindows({ ...commonWindows, entitlementDeltaRaw: delta.lowerRaw })
    const definiteWindows = buildModeledShortageWindows({ ...commonWindows, entitlementDeltaRaw: delta.upperRaw })
    if (possibleWindows?.status !== 'modeled' || definiteWindows?.status !== 'modeled') return null
    modeledShortageWindows.push({ scenarioId: s.id, possible: possibleWindows, definite: definiteWindows })
  }
  const summarizeWindows = (key: 'possible' | 'definite'): MorphoV2IdlePanelModeledShortageLaneSummary => {
    const lanes = modeledShortageWindows.map(s => s[key]), windows = lanes.flatMap(l => l.windows)
    const left = lanes.filter(l => l.windows.some(w => w.leftCensored)).length, right = lanes.filter(l => l.windows.some(w => w.rightCensored)).length
    const recoveries = windows.filter(w => !w.rightCensored).map(w => w.endElapsedMs.upperMs)
    const durationRange = windows.length ? { lowerMs: Math.min(...windows.map(w => w.modeledDurationMs.lowerMs)), upperMs: Math.max(...windows.map(w => w.modeledDurationMs.upperMs)) } : null
    return { episodeCount: windows.length, neverShortageScenarioCount: lanes.filter(l => l.neverInsufficient).length,
      leftCensoredScenarioCount: left, rightCensoredScenarioCount: right, anyLeftCensored: left > 0, anyRightCensored: right > 0,
      earliestOnsetMs: windows.length ? Math.min(...windows.map(w => w.startElapsedMs.lowerMs)) : null,
      latestBoundedRecoveryMs: recoveries.length ? Math.max(...recoveries) : null,
      modeledWindowDurationRangeMs: durationRange,
      fullEpisodeDurationRangeMs: durationRange ? { lowerMs: durationRange.lowerMs, upperMs: left || right ? null : durationRange.upperMs } : null }
  }
  const modeledShortageSummary: MorphoV2IdlePanelModeledShortageSummary = { possible: summarizeWindows('possible'), definite: summarizeWindows('definite'),
    relevantScenarioCount: process.scenarios.length, censoredScenarioCount: process.censoredDonorCount,
    basis: 'individual_analytical_model_windows_not_sample_spans', modeled: true,
    actualHistoricalContinuousDuration: false, measuredHistoryDuration: false, calibrated: false, continuousProof: false, guaranteedDurationMs: null }
  return { process, capacityInterval, sampledIntervalSummary, sampledShortageRuns, sampledShortageSummary, modeledShortageWindows, modeledShortageSummary, configurationCensoredPairs, causalUsablePairs: donors.length }
}
export function issuedMorphoV2IdleJointHolderForecastV2(capacityAgreement: unknown, idleEvidence: unknown, suppliedQuestion: unknown, executionAgreement?: unknown): MorphoV2IdleJointHolderForecastV2 | null {
  try {
    const selection = question(suppliedQuestion)
    if (!selection || !morphoV2IdleBrowserDataTree(capacityAgreement) || !record(capacityAgreement) || !Array.isArray(capacityAgreement.origins) || capacityAgreement.origins.length !== 2 || executionAgreement !== undefined && !morphoV2IdleBrowserDataTree(executionAgreement)) return null
    const { q, profile } = selection, origins = capacityAgreement.origins
    if (!origins.every(x => record(x) && typeof x.host === 'string' && MORPHO_V2_IDLE_BROWSER_HOSTS.includes(x.host as typeof MORPHO_V2_IDLE_BROWSER_HOSTS[number]))) return null
    const rebuilt = agreeHolderExitCapacityQuotes(origins[0] as { host: string; quote: unknown }, origins[1] as { host: string; quote: unknown }, q.asOfMs)
    if (!rebuilt) return null
    const native = rebuilt.quote.source
    if (q.independentSource && (q.independentSource.chainId !== native.chainId || q.independentSource.blockNumber !== native.blockNumber || q.independentSource.blockHash !== native.blockHash || q.independentSource.blockTime !== native.blockTime || q.independentSource.finalized !== native.finalized)) return null
    const capacityBinding: HolderExitCapacityBinding = { routeKey: q.routeKey, destination: q.destination, owner: q.requestedHolderAddress, requestedRaw: q.requestedRaw, asset: q.requestedAssetAddress, assetDecimals: q.requestedAssetDecimals, currentSource: structuredClone(native), asOfMs: q.asOfMs, ...(executionAgreement === undefined ? {} : { executionAgreement }) }
    const capacity = selectedHolderExitCapacity(capacityAgreement, capacityBinding), position = capacity?.quote.sourceHolderPosition
    if (!capacity || !position || position.shareDecimals !== profile.identity.shareDecimals || position.method !== 'balance_of_owner_at_source' || !uint(position.sharesRaw, true) || !uint(capacity.quote.entitlementRaw) || capacity.quote.entitlementMethod !== 'preview_redeem_full_position' || capacity.quote.fullPositionEntitlementRaw !== undefined && capacity.quote.fullPositionEntitlementRaw !== capacity.quote.entitlementRaw) return null
    const source: MorphoV2IdleNativeSource = { chainId: 1, blockNumber: String(native.blockNumber), blockHash: native.blockHash, blockTime: native.blockTime, finalized: true }
    const expectation: MorphoV2IdleHolderForecastEvidenceExpectation = { profile, owner: q.requestedHolderAddress, source, sharesRaw: position.sharesRaw, fullEaRaw: capacity.quote.entitlementRaw, asOfMs: q.asOfMs }
    const evidence = approveMorphoV2IdlePanelHolderForecastEvidence(idleEvidence, expectation)
    if (!evidence) return null
    const projected = project(evidence, q)
    if (!projected) return null
    const result = freeze({ status: 'conditional_morpho_v2_idle_panel_holder_forecast', profileId: profile.id, question: q, issuedAtMs: q.asOfMs, targetAtUtc: projected.process.targetAtUtc, source, sourceProofValidUntil: new Date(Date.parse(source.blockTime) + 1800000).toISOString(), owner: evidence.owner, currentSharesRaw: evidence.currentSharesRaw, currentFullEaRaw: evidence.currentFullEaRaw, currentIdleCashRaw: evidence.currentIdleCashRaw, capsuleSha256: evidence.panelSha256, verifiedHistoryAvailableAtUtc: evidence.verifiedHistoryAvailableAtUtc, entitlementBasis: evidence.entitlementBasis, process: projected.process, capacityInterval: projected.capacityInterval, sampledIntervalSummary: projected.sampledIntervalSummary, sampledShortageRuns: projected.sampledShortageRuns, sampledShortageSummary: projected.sampledShortageSummary, modeledShortageWindows: projected.modeledShortageWindows, modeledShortageSummary: projected.modeledShortageSummary, panelInspection: { counts: evidence.panel.counts, retrospectiveScores: evidence.panel.retrospectiveScores, disclosure: evidence.panel.disclosure, configurationCensoredPairs: projected.configurationCensoredPairs, causalUsablePairs: projected.causalUsablePairs, historicalOwnership: false, accuracyImprovementClaim: false }, claims: projected.process.claims }) as unknown as MorphoV2IdleJointHolderForecastV2
    if (new TextEncoder().encode(JSON.stringify(result)).length > MORPHO_V2_IDLE_JOINT_STOCK_POLICY.maximumSerializedBytes) return null
    models.set(result, { q, questionKey: JSON.stringify(q), capacity: freeze(rebuilt), capacityBinding: freeze(structuredClone(capacityBinding)), evidence, expectation }); return result
  } catch { return null }
}
export function selectedMorphoV2IdleJointHolderForecastV2(value: unknown, suppliedQuestion: unknown, renderAtMs: number): MorphoV2IdleJointHolderForecastV2 | null {
  try {
    const selection = question(suppliedQuestion)
    if (!selection || !record(value) || !Number.isSafeInteger(renderAtMs)) return null
    const original = models.get(value)
    if (!original || original.questionKey !== JSON.stringify(selection.q) || renderAtMs < original.q.asOfMs || renderAtMs >= original.q.asOfMs + original.q.horizonHours * 3600000) return null
    if (!selectedHolderExitCapacity(original.capacity, { ...original.capacityBinding, asOfMs: renderAtMs }) || !selectedMorphoV2IdlePanelHolderForecastEvidence(original.evidence, { ...original.expectation, asOfMs: renderAtMs })) return null
    return value as unknown as MorphoV2IdleJointHolderForecastV2
  } catch { return null }
}
declare const originalPanelReceipt: unique symbol
export type MorphoV2IdleJointHolderForecastV2Issue = Readonly<{
  kind: 'morpho_v2_idle_joint_holder_forecast_issue_v2'; profileId: string; issuedAtMs: number; horizonHours: number
  owner: string; requestedRaw: string; sharesRaw: string; fullEntitlementRaw: string; asset: string; assetDecimals: number; shareDecimals: number
  block: string; blockHash: string; source: MorphoV2IdleNativeSource; independentSource?: MorphoV2IdleJointHolderForecastQuestion['independentSource']
  readonly [originalPanelReceipt]: true
}>
const receipts = new WeakMap<object, MorphoV2IdleJointHolderForecastV2>()
export function morphoV2IdleJointHolderForecastV2Issue(model: unknown): MorphoV2IdleJointHolderForecastV2Issue | null {
  if (!record(model) || !models.has(model)) return null
  const m = model as unknown as MorphoV2IdleJointHolderForecastV2, q = m.question
  const issue = freeze({ kind: 'morpho_v2_idle_joint_holder_forecast_issue_v2', profileId: m.profileId, issuedAtMs: q.asOfMs, horizonHours: q.horizonHours, owner: m.owner, requestedRaw: q.requestedRaw, sharesRaw: m.currentSharesRaw, fullEntitlementRaw: m.currentFullEaRaw, asset: q.requestedAssetAddress, assetDecimals: q.requestedAssetDecimals, shareDecimals: m.process.identity.shareDecimals, block: m.source.blockNumber, blockHash: m.source.blockHash, source: structuredClone(m.source), ...(q.independentSource ? { independentSource: structuredClone(q.independentSource) } : {}) }) as unknown as MorphoV2IdleJointHolderForecastV2Issue
  receipts.set(issue, m); return issue
}
export function selectedMorphoV2IdleJointHolderForecastV2FromIssue(issue: unknown, suppliedQuestion: unknown, renderAtMs: number): MorphoV2IdleJointHolderForecastV2 | null {
  if (!record(issue)) return null
  const model = receipts.get(issue); return model ? selectedMorphoV2IdleJointHolderForecastV2(model, suppliedQuestion, renderAtMs) : null
}
export function morphoV2IdleJointHolderForecastV2FromResponse(value: unknown, status: number, suppliedQuestion: unknown): MorphoV2IdleJointHolderForecastV2 | null {
  try {
    if (!morphoV2IdleBrowserDataTree(value) || !record(value) || status !== 200 && !(status === 503 && value.error === 'holder_exit_assessment_unavailable') || typeof value.morphoV2IdleHolderForecastEvidence !== 'string') return null
    return issuedMorphoV2IdleJointHolderForecastV2(value.capacityAgreement, value.morphoV2IdleHolderForecastEvidence, suppliedQuestion, value.executionAgreement)
  } catch { return null }
}
export function morphoV2IdleJointHolderForecastV2IssueFromResponse(value: unknown, status: number, suppliedQuestion: unknown): MorphoV2IdleJointHolderForecastV2Issue | null {
  const model = morphoV2IdleJointHolderForecastV2FromResponse(value, status, suppliedQuestion); return model ? morphoV2IdleJointHolderForecastV2Issue(model) : null
}
