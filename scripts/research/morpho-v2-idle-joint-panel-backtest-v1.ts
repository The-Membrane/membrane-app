/** Offline research replay. This imports mathematics, never a live issuer or native authority. */
import { createHash } from 'node:crypto'
import {
  buildMorphoV2IdleJointStockProjection,
  type MorphoV2IdleHistoricalPoint,
  type MorphoV2IdleIdentity,
  type MorphoV2IdleNativeSource,
  type MorphoV2IdleRegime,
} from '../../lib/carry/morphoV2IdleJointStockProjection'

export const MORPHO_V2_IDLE_JOINT_PANEL_POLICY = Object.freeze({
  endpoints: 120, pairs: 60, pairsPerPartition: 20, horizonMs: 86_400_000,
  sharesRaw: '352805058661206444', requestedRaw: '500000', competingMRaw: null,
  maximumInputBytes: 1024 * 1024, maximumOutputBytes: 2 * 1024 * 1024,
  maximumNodes: 30000, maximumDepth: 24,
} as const)
export const MORPHO_V2_IDLE_JOINT_PANEL_IDENTITY: Readonly<MorphoV2IdleIdentity> = Object.freeze({
  profileId: 'morpho_v2_pyusd_b576_observed_idle_history', routeKey: 'PYUSD → VaultV2 [PYUSD]',
  destination: '0xb576765fb15505433af24fee2c0325895c559fb2',
  asset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8', assetDecimals: 6, shareDecimals: 18,
})
const OWNER = '0xf181e2cc93a47cb4903ac71c23ecb873726dc668'
export const MORPHO_V2_IDLE_JOINT_PANEL_CATALOG_SHA256 = '88333133c895b7bba37a83677cb91388e9fc12b3462599f480d537f5d6ed517f'
const REGIME: Readonly<MorphoV2IdleRegime> = Object.freeze({ kind: 'zero_adapter_idle',
  liquidityAdapter: '0x0000000000000000000000000000000000000000', liquidityData: '0x',
  vaultRuntimeCodeHash: '0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd',
  assetRuntimeCodeHash: '0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1',
})
export const MORPHO_V2_IDLE_JOINT_PANEL_DISCLOSURE = Object.freeze({
  researchOnly: true, retrospectivelyAcquiredFacts: true,
  all120CashEndpointsPreviouslyInspected: true, oldOctober1And2JointEndpointsPreviouslyInspected: true,
  partitionNames: 'fit/calibration/holdout are predeclared chronological labels only',
  partitionDeclarationIsRetrospective: true, parameterFittingPerformed: false,
  calibrated: false, calibratedProbability: false, untouchedHoldout: false, prospectiveValidation: false,
  historicalOwnership: false, historicalOwnedEntitlementMeasured: false,
  authenticated: false, originalAuthority: false, profileApproval: false, currentWalletControl: false,
  sourceImplementationEquivalence: false, holderExecutableExit: false, executionAuthority: false,
  forecastAuthority: false, coveragePromotion: false, nativeByteReplayPerformed: false,
  parentMustReplayNativeOriginals: true,
  stockBasis: 'hypothetical_frozen_current_stock_not_historical_owned_entitlement',
  availabilityBasis: 'simulated_at_native_block_time_not_a_historical_live_issue',
  competingMRaw: null, historicalCashDeltaIncludesNetCompetingFlow: true,
  additionalCompetingFlowSubtraction: false,
  observedEndpointsPerCompletePair: 2, dailyEndpointsCertifyContinuousDuration: false,
  modelledCheckpointMaximumPerScenario: 65, modelledCheckpointsAreNativeOutcomes: false,
} as const)

export type MorphoV2IdleJointPanelCatalogPoint = readonly [
  index: number, blockNumber: string, blockHash: string, blockTime: string, cashRaw: string,
]
export type MorphoV2IdleJointPanelEndpoint = Readonly<{
  index: number; point: unknown | null; censorReason: string | null; provenanceRef: string
}>
export type MorphoV2IdleJointPanelInput = Readonly<{
  catalog: readonly MorphoV2IdleJointPanelCatalogPoint[]
  endpoints: readonly MorphoV2IdleJointPanelEndpoint[]
}>
export type MorphoV2IdleJointPanelOriginalAuditReferences = Readonly<{
  kind: 'retained_original_native_inspector_references'
  cohorts: readonly Readonly<{ pairIndex: number; directory: string; reportFileSha256: string;
    terminalFileSha256: string; inspectorProofSha256: string;
    sourceCompanionDirectory: string; sourceCompanionManifestSha256: string }>[]
}>
export type MorphoV2IdleJointPanelCensor =
  | 'missing_native_endpoint' | 'duplicate_native_endpoint' | 'native_join_unqualified'
  | 'malformed_native_endpoint' | 'source_mismatch' | 'cash_mismatch' | 'stock_mismatch'
  | 'identity_or_units_mismatch' | 'configuration_or_runtime_mismatch'
  | 'zero_total_supply' | 'stock_exceeds_native_total_supply' | 'non_exact_h24_pair'
  | 'cold_start_no_strictly_prior_usable_donor' | 'projector_rejected_input'
  | 'projected_stock_uint256_overflow' | 'projector_without_complete_headline'
type Endpoint = {
  status: 'measured'; index: number; provenanceRef: string
  point: MorphoV2IdleHistoricalPoint; totalSupplySharesRaw: string
  measuredZeroCash: boolean; measuredZeroEntitlement: boolean
} | { status: 'censored'; index: number; provenanceRef: string | null; reason: MorphoV2IdleJointPanelCensor }
type NativePair = { status: 'measured'; start: Extract<Endpoint, { status: 'measured' }>; end: Extract<Endpoint, { status: 'measured' }> }
  | { status: 'censored'; reason: MorphoV2IdleJointPanelCensor }
type Measurement = { availableRaw: string; headroomRaw: string; shortfallRaw: string; signedMarginRaw: string }
type Errors = { availableSignedErrorRaw: string; availableAbsoluteErrorRaw: string;
  shortfallSignedErrorRaw: string; shortfallAbsoluteErrorRaw: string;
  predictedEndpointInsufficient: boolean; observedEndpointInsufficient: boolean }
type Comparison = { prediction: Measurement; observed: Measurement; errors: Errors }
type DonorChoice = { pairIndex: number; status: 'eligible' | 'used' | 'censored'; reason: MorphoV2IdleJointPanelCensor | null }
type Partition = 'fit' | 'calibration' | 'holdout'
export type MorphoV2IdleJointPanelPairResult = {
  pairIndex: number; partition: Partition; issueIndex: number; outcomeIndex: number
  simulatedIssueAtUtc: string; exactTargetAtUtc: string; horizonMs: 86400000
  status: 'scored' | 'censored'; censorReason: MorphoV2IdleJointPanelCensor | null
  predictionStatus: 'produced' | 'censored'; predictionCensorReason: MorphoV2IdleJointPanelCensor | null
  endpointStatuses: [Endpoint['status'], Endpoint['status']]
  issueEndpointCensor: MorphoV2IdleJointPanelCensor | null; outcomeEndpointCensor: MorphoV2IdleJointPanelCensor | null
  priorPlannedDonorPairs: number; donorChoices: DonorChoice[]; nativeEligibleDonorPairs: number; usedDonorPairs: number
  nativeObservedEndpointCount: number; observed: Measurement | null
  persistence: Comparison | null
  projection: null | { measurement: Measurement; availableMinimumRaw: string; availableMaximumRaw: string;
    shortfallMinimumRaw: string; shortfallMaximumRaw: string; sourceAgeMs: 0;
    projectionElapsedMs: 86400000; competingMRaw: null; sampledCheckpointsAreNativeOutcomes: false }
  jointComparison: Comparison | null
  observedEndpointTransition: 'insufficient_at_both' | 'sufficient_at_both' | 'sufficient_to_insufficient' | 'insufficient_to_sufficient' | null
  continuousDurationProven: false; firstLossTimeEstimated: false
}
const UINT = /^(0|[1-9][0-9]{0,77})$/, HASH = /^0x[0-9a-f]{64}$/
const MAX_UINT = (1n << 256n) - 1n
function check(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error('idle_joint_panel_' + reason) }
function record(x: unknown): x is Record<string, unknown> { return x !== null && typeof x === 'object' && !Array.isArray(x) }
function uint(x: unknown): x is string { return typeof x === 'string' && UINT.test(x) && BigInt(x) <= MAX_UINT }
function utc(x: unknown): x is string { return typeof x === 'string' && Number.isSafeInteger(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x }
function tree(x: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > MORPHO_V2_IDLE_JOINT_PANEL_POLICY.maximumNodes || depth > MORPHO_V2_IDLE_JOINT_PANEL_POLICY.maximumDepth) return false
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return true
  if (typeof x === 'number') return Number.isFinite(x)
  if (typeof x !== 'object' || Object.getOwnPropertySymbols(x).length) return false
  if (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype && Object.getPrototypeOf(x) !== null) return false
  const props = Object.getOwnPropertyDescriptors(x)
  return Object.entries(props).every(([key, d]) => Array.isArray(x) && key === 'length' ||
    (d.enumerable && Object.hasOwn(d, 'value') && tree(d.value, depth + 1, budget)))
}
function freeze<T>(x: T): T { if (x !== null && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x) }; return x }
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).byteLength
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function nativeSource(p: MorphoV2IdleJointPanelCatalogPoint): MorphoV2IdleNativeSource {
  return { chainId: 1, blockNumber: p[1], blockHash: p[2], blockTime: p[3], finalized: true }
}
function catalog(value: unknown): readonly MorphoV2IdleJointPanelCatalogPoint[] {
  check(Array.isArray(value) && value.length === 120, 'catalog_count')
  const heights = new Set<string>(), hashes = new Set<string>()
  value.forEach((p, index) => {
    check(Array.isArray(p) && p.length === 5 && p[0] === index && uint(p[1]) && BigInt(p[1]) > 0n &&
      typeof p[2] === 'string' && HASH.test(p[2]) && utc(p[3]) && uint(p[4]), 'catalog_point')
    check(!heights.has(p[1]) && !hashes.has(p[2]), 'catalog_duplicate')
    heights.add(p[1]); hashes.add(p[2])
    if (index) check(BigInt(p[1]) > BigInt(value[index - 1][1]) && Date.parse(p[3]) > Date.parse(value[index - 1][3]), 'catalog_chronology')
  })
  return value as MorphoV2IdleJointPanelCatalogPoint[]
}
function decodeEndpoint(p: MorphoV2IdleJointPanelCatalogPoint, values: readonly MorphoV2IdleJointPanelEndpoint[]): Endpoint {
  const index = p[0], matches = values.filter(x => x.index === index)
  const denied = (reason: MorphoV2IdleJointPanelCensor): Endpoint => ({ status: 'censored', index,
    provenanceRef: matches.length === 1 ? matches[0].provenanceRef : null, reason })
  if (!matches.length) return denied('missing_native_endpoint')
  if (matches.length !== 1) return denied('duplicate_native_endpoint')
  const entry = matches[0], x = entry.point
  if (x === null) return denied(entry.censorReason === 'missing_native_endpoint' ? 'missing_native_endpoint' : 'native_join_unqualified')
  if (!record(x)) return denied('malformed_native_endpoint')
  if (!same(x.source, nativeSource(p))) return denied('source_mismatch')
  if (x.id !== 'PYUSD_B576' || x.vault !== MORPHO_V2_IDLE_JOINT_PANEL_IDENTITY.destination ||
    x.asset !== MORPHO_V2_IDLE_JOINT_PANEL_IDENTITY.asset || x.nativeAsset !== MORPHO_V2_IDLE_JOINT_PANEL_IDENTITY.asset ||
    x.assetDecimals !== 6 || x.shareDecimals !== 18 || x.nativeAssetDecimals !== 6 || x.nativeShareDecimals !== 18 ||
    x.probeEaAssetDecimals !== 6 || x.probeShareDecimals !== 18 || x.cashAssetDecimals !== 6 ||
    x.totalSupplyShareDecimals !== 18 || x.owner !== OWNER || x.historicalOwnedEntitlementAssetRaw !== null ||
    x.historicalOwnedEntitlementMeasured !== false || x.CMeaning !== 'asset.balanceOf(exact_vault)_only' ||
    x.cashIsTotalAssets !== false || x.cashIsOwnedEntitlement !== false ||
    x.conversionBasis !== 'hypothetical_fixed_current_stock_conversion') return denied('identity_or_units_mismatch')
  if (x.liquidityAdapter !== REGIME.liquidityAdapter || x.liquidityData !== '0x' ||
    x.regimeKind !== 'zero_liquidity_adapter_empty_data' || !record(x.runtimes) ||
    !record(x.runtimes.vault) || !record(x.runtimes.asset) ||
    x.runtimes.vault.runtimeByteLength !== 21808 || x.runtimes.asset.runtimeByteLength !== 1506 ||
    x.runtimes.vault.runtimeKeccak256 !== REGIME.vaultRuntimeCodeHash ||
    x.runtimes.asset.runtimeKeccak256 !== REGIME.assetRuntimeCodeHash) return denied('configuration_or_runtime_mismatch')
  if (!uint(x.CAssetRaw) || !uint(x.probeEaAssetRaw) || !uint(x.totalSupplySharesRaw) ||
    (x.actualHistoricalOwnerSharesRaw !== null && !uint(x.actualHistoricalOwnerSharesRaw))) return denied('malformed_native_endpoint')
  if (x.probeSharesRaw !== MORPHO_V2_IDLE_JOINT_PANEL_POLICY.sharesRaw) return denied('stock_mismatch')
  if (x.CAssetRaw !== p[4]) return denied('cash_mismatch')
  if (x.totalSupplySharesRaw === '0') return denied('zero_total_supply')
  if (BigInt(x.probeSharesRaw) > BigInt(x.totalSupplySharesRaw)) return denied('stock_exceeds_native_total_supply')
  if (entry.censorReason !== null || x.qualifiedNativeJoin !== true) return denied('native_join_unqualified')
  const source = nativeSource(p)
  return { status: 'measured', index, provenanceRef: entry.provenanceRef,
    totalSupplySharesRaw: x.totalSupplySharesRaw, measuredZeroCash: x.CAssetRaw === '0', measuredZeroEntitlement: x.probeEaAssetRaw === '0',
    point: { identity: { ...MORPHO_V2_IDLE_JOINT_PANEL_IDENTITY }, owner: OWNER, source, regime: { ...REGIME },
      idleCashRaw: x.CAssetRaw, historicalOwnerSharesRaw: x.actualHistoricalOwnerSharesRaw,
      fixedCurrentStockConversion: { method: 'native_preview_redeem_fixed_current_shares', source: { ...source },
        probeSharesRaw: x.probeSharesRaw, asset: MORPHO_V2_IDLE_JOINT_PANEL_IDENTITY.asset,
        assetDecimals: 6, shareDecimals: 18, assetsRaw: x.probeEaAssetRaw } } }
}
function measurement(cash: string, ea: string): Measurement {
  const c = BigInt(cash), e = BigInt(ea), q = BigInt(MORPHO_V2_IDLE_JOINT_PANEL_POLICY.requestedRaw), a = c < e ? c : e
  return { availableRaw: String(a), headroomRaw: String(a > q ? a - q : 0n),
    shortfallRaw: String(a < q ? q - a : 0n), signedMarginRaw: String(a - q) }
}
function compare(prediction: Measurement, observed: Measurement): Comparison {
  const available = BigInt(prediction.availableRaw) - BigInt(observed.availableRaw)
  const shortfall = BigInt(prediction.shortfallRaw) - BigInt(observed.shortfallRaw)
  return { prediction, observed, errors: { availableSignedErrorRaw: String(available),
    availableAbsoluteErrorRaw: String(available < 0n ? -available : available), shortfallSignedErrorRaw: String(shortfall),
    shortfallAbsoluteErrorRaw: String(shortfall < 0n ? -shortfall : shortfall),
    predictedEndpointInsufficient: BigInt(prediction.availableRaw) < BigInt(MORPHO_V2_IDLE_JOINT_PANEL_POLICY.requestedRaw),
    observedEndpointInsufficient: BigInt(observed.availableRaw) < BigInt(MORPHO_V2_IDLE_JOINT_PANEL_POLICY.requestedRaw) } }
}
function pair(endpoints: Endpoint[], points: readonly MorphoV2IdleJointPanelCatalogPoint[], index: number): NativePair {
  const a = endpoints[index * 2], b = endpoints[index * 2 + 1]
  if (a.status === 'censored') return { status: 'censored', reason: a.reason }
  if (b.status === 'censored') return { status: 'censored', reason: b.reason }
  if (Date.parse(points[index * 2 + 1][3]) - Date.parse(points[index * 2][3]) !== 86400000) return { status: 'censored', reason: 'non_exact_h24_pair' }
  return { status: 'measured', start: a, end: b }
}
function partition(index: number): Partition { return index < 20 ? 'fit' : index < 40 ? 'calibration' : 'holdout' }
function totalErrors(values: MorphoV2IdleJointPanelPairResult[], channel: 'jointComparison' | 'persistence') {
  const scored = values.map(x => x[channel]).filter((x): x is Comparison => x !== null)
  const sum = (key: 'availableAbsoluteErrorRaw' | 'shortfallAbsoluteErrorRaw') => String(scored.reduce((n, x) => n + BigInt(x.errors[key]), 0n))
  return { scoredPairs: scored.length, availableAbsoluteErrorSumRaw: sum('availableAbsoluteErrorRaw'),
    shortfallAbsoluteErrorSumRaw: sum('shortfallAbsoluteErrorRaw'),
    endpointInsufficiencyClassificationMatches: scored.filter(x => x.errors.predictedEndpointInsufficient === x.errors.observedEndpointInsufficient).length }
}
/** Missing or censored facts remain in their original planned slots; no endpoint is renumbered. */
export function runMorphoV2IdleJointPanelBacktest(supplied: MorphoV2IdleJointPanelInput) {
  check(tree(supplied) && bytes(supplied) <= MORPHO_V2_IDLE_JOINT_PANEL_POLICY.maximumInputBytes &&
    record(supplied) && Object.keys(supplied).length === 2, 'input_bound')
  const points = catalog(supplied.catalog)
  check(Array.isArray(supplied.endpoints) && supplied.endpoints.length <= 120 && supplied.endpoints.every(x =>
    record(x) && Object.keys(x).length === 4 && Number.isSafeInteger(x.index) && x.index >= 0 && x.index < 120 &&
    (x.censorReason === null || typeof x.censorReason === 'string') && typeof x.provenanceRef === 'string' &&
    x.provenanceRef.length > 0 && x.provenanceRef.length <= 256 && Object.hasOwn(x, 'point')), 'endpoint_interface')
  const endpoints = points.map(p => decodeEndpoint(p, supplied.endpoints))
  const nativePairs = Array.from({ length: 60 }, (_, i) => pair(endpoints, points, i))
  const results: MorphoV2IdleJointPanelPairResult[] = nativePairs.map((native, pairIndex) => {
    const a = endpoints[pairIndex * 2], b = endpoints[pairIndex * 2 + 1], issueAt = Date.parse(points[pairIndex * 2][3])
    const donorChoices: DonorChoice[] = [], donors: { id: string; start: MorphoV2IdleHistoricalPoint; end: MorphoV2IdleHistoricalPoint }[] = []
    for (let prior = 0; prior < pairIndex; prior++) {
      const candidate = nativePairs[prior]
      if (candidate.status === 'censored') { donorChoices.push({ pairIndex: prior, status: 'censored', reason: candidate.reason }); continue }
      check(Date.parse(candidate.end.point.source.blockTime) < issueAt, 'strict_prior_donor')
      donors.push({ id: 'planned_pair_' + prior, start: candidate.start.point, end: candidate.end.point })
      donorChoices.push({ pairIndex: prior, status: 'eligible', reason: null })
    }
    const result: MorphoV2IdleJointPanelPairResult = { pairIndex, partition: partition(pairIndex), issueIndex: pairIndex * 2,
      outcomeIndex: pairIndex * 2 + 1, simulatedIssueAtUtc: points[pairIndex * 2][3],
      exactTargetAtUtc: new Date(issueAt + 86400000).toISOString(), horizonMs: 86400000,
      status: 'censored', censorReason: native.status === 'censored' ? native.reason : 'cold_start_no_strictly_prior_usable_donor',
      predictionStatus: 'censored', predictionCensorReason: a.status === 'censored' ? a.reason : 'cold_start_no_strictly_prior_usable_donor',
      endpointStatuses: [a.status, b.status], issueEndpointCensor: a.status === 'censored' ? a.reason : null,
      outcomeEndpointCensor: b.status === 'censored' ? b.reason : null, priorPlannedDonorPairs: pairIndex,
      donorChoices, nativeEligibleDonorPairs: donors.length, usedDonorPairs: 0,
      nativeObservedEndpointCount: Number(a.status === 'measured') + Number(b.status === 'measured'),
      observed: null, persistence: null, projection: null, jointComparison: null, observedEndpointTransition: null,
      continuousDurationProven: false, firstLossTimeEstimated: false }
    if (native.status === 'measured') {
      const start = native.start.point, end = native.end.point
      const observed = measurement(end.idleCashRaw, end.fixedCurrentStockConversion.assetsRaw)
      const persistence = measurement(start.idleCashRaw, start.fixedCurrentStockConversion.assetsRaw)
      result.observed = observed; result.persistence = compare(persistence, observed)
      result.observedEndpointTransition = BigInt(persistence.shortfallRaw) > 0n ?
        (BigInt(observed.shortfallRaw) > 0n ? 'insufficient_at_both' : 'insufficient_to_sufficient') :
        (BigInt(observed.shortfallRaw) > 0n ? 'sufficient_to_insufficient' : 'sufficient_at_both')
    }
    // Forecast eligibility uses only the issue and strictly prior donors, never target availability or target values.
    if (a.status === 'censored') return result
    const start = a.point
    if (!donors.length) return result
    const model = buildMorphoV2IdleJointStockProjection({ identity: start.identity, owner: OWNER,
      currentSource: start.source, currentRegime: start.regime, currentSharesRaw: MORPHO_V2_IDLE_JOINT_PANEL_POLICY.sharesRaw,
      currentIdleCashRaw: start.idleCashRaw, currentFullEaRaw: start.fixedCurrentStockConversion.assetsRaw,
      asOfMs: issueAt, horizonMs: 86400000, requestedRaw: MORPHO_V2_IDLE_JOINT_PANEL_POLICY.requestedRaw,
      competingMRaw: null, donors })
    const predictionDenied = (reason: MorphoV2IdleJointPanelCensor) => {
      result.predictionCensorReason = reason
      if (native.status === 'measured') result.censorReason = reason
      return result
    }
    if (!model) return predictionDenied('projector_rejected_input')
    for (const scenario of model.scenarios) {
      const prior = Number(scenario.id.slice('planned_pair_'.length)), choice = result.donorChoices.find(x => x.pairIndex === prior)
      if (choice) { choice.status = scenario.status === 'usable' ? 'used' : 'censored';
        choice.reason = scenario.status === 'usable' ? null : 'projected_stock_uint256_overflow' }
    }
    result.usedDonorPairs = model.usableDonorCount
    if (model.censoredDonorCount) return predictionDenied('projected_stock_uint256_overflow')
    const h = model.descriptive.headline
    if (!h) return predictionDenied('projector_without_complete_headline')
    check(model.sourceAgeMs === 0 && model.projectionElapsedMs === 86400000 && model.competingMRaw === null &&
      model.historicalCashDeltaIncludesNetCompetingFlow && model.reserveTiming === 'full_additional_reserve_applied_once_at_each_measurement', 'projection_semantics')
    const predicted: Measurement = { availableRaw: h.available.empiricalMeanFloorRaw, headroomRaw: h.headroom.empiricalMeanFloorRaw,
      shortfallRaw: h.shortfall.empiricalMeanFloorRaw, signedMarginRaw: h.signedMargin.empiricalMeanFloorRaw }
    result.predictionStatus = 'produced'; result.predictionCensorReason = null
    if (native.status === 'measured') { result.status = 'scored'; result.censorReason = null; result.jointComparison = compare(predicted, result.observed!) }
    result.projection = { measurement: predicted, availableMinimumRaw: h.available.minimumRaw, availableMaximumRaw: h.available.maximumRaw,
      shortfallMinimumRaw: h.shortfall.minimumRaw, shortfallMaximumRaw: h.shortfall.maximumRaw,
      sourceAgeMs: 0, projectionElapsedMs: 86400000, competingMRaw: null, sampledCheckpointsAreNativeOutcomes: false }
    return result
  })
  const summaries = (['fit', 'calibration', 'holdout'] as const).map(name => {
    const rows = results.filter(x => x.partition === name)
    return { partition: name, plannedPairs: 20, plannedEndpoints: 40, scoredPairs: rows.filter(x => x.status === 'scored').length,
      forecastProducedPairs: rows.filter(x => x.predictionStatus === 'produced').length,
      censoredPairs: rows.filter(x => x.status === 'censored').length,
      censorReasons: Object.fromEntries([...new Set(rows.map(x => x.censorReason).filter(x => x !== null))].map(reason => [reason, rows.filter(x => x.censorReason === reason).length])),
      joint: totalErrors(rows, 'jointComparison'), persistence: totalErrors(rows, 'persistence'),
      matchedPersistence: totalErrors(rows.filter(x => x.jointComparison !== null), 'persistence') }
  })
  const catalogSha256 = createHash('sha256').update(JSON.stringify(points)).digest('hex')
  const catalogMatchesPredeclaredCashSeries = catalogSha256 === MORPHO_V2_IDLE_JOINT_PANEL_CATALOG_SHA256
  const report = { schema: 'morpho_v2_idle_joint_panel_backtest_v1', identity: { ...MORPHO_V2_IDLE_JOINT_PANEL_IDENTITY },
    policy: MORPHO_V2_IDLE_JOINT_PANEL_POLICY, catalogSha256, catalogMatchesPredeclaredCashSeries,
    scoreDefinitions: { endpointClassification: 'mean_available_capacity_less_than_requested_amount',
      projectedShortfallRisk: 'mean_of_scenario_shortfalls_separate_from_point_capacity_classification',
      matchedPersistence: 'exact_pairs_with_non_null_joint_comparison', allNativePersistenceRetained: true },
    disclosure: { ...MORPHO_V2_IDLE_JOINT_PANEL_DISCLOSURE, all120CashEndpointsPreviouslyInspected: catalogMatchesPredeclaredCashSeries },
    plannedEndpoints: 120, measuredEndpoints: endpoints.filter(x => x.status === 'measured').length,
    censoredEndpoints: endpoints.filter(x => x.status === 'censored').length, plannedPairs: 60,
    scoredPairs: results.filter(x => x.status === 'scored').length, censoredPairs: results.filter(x => x.status === 'censored').length,
    forecastProducedPairs: results.filter(x => x.predictionStatus === 'produced').length,
    endpoints, partitions: summaries, joint: totalErrors(results, 'jointComparison'), persistence: totalErrors(results, 'persistence'),
    matchedPersistence: totalErrors(results.filter(x => x.jointComparison !== null), 'persistence'), pairs: results }
  check(bytes(report) <= MORPHO_V2_IDLE_JOINT_PANEL_POLICY.maximumOutputBytes, 'output_bound')
  return freeze(report)
}

/** Actual corpus entry: the complete120-slot calendar/cash catalog must match its predeclared byte digest. */
export function runPinnedMorphoV2IdleJointPanelBacktest(
  supplied: MorphoV2IdleJointPanelInput,
  originalAuditReferences: MorphoV2IdleJointPanelOriginalAuditReferences,
) {
  check(tree(supplied) && bytes(supplied) <= MORPHO_V2_IDLE_JOINT_PANEL_POLICY.maximumInputBytes && record(supplied), 'input_bound')
  check(createHash('sha256').update(JSON.stringify(supplied.catalog)).digest('hex') === MORPHO_V2_IDLE_JOINT_PANEL_CATALOG_SHA256, 'catalog_pin')
  check(tree(originalAuditReferences) && record(originalAuditReferences) && Object.keys(originalAuditReferences).length === 2 &&
    originalAuditReferences.kind === 'retained_original_native_inspector_references' &&
    Array.isArray(originalAuditReferences.cohorts) && originalAuditReferences.cohorts.length <= 60, 'audit_reference_interface')
  const byIndex = new Map<number, string>(), directories = new Set<string>()
  const path = /^data\/research\/venue-signals\/[A-Za-z0-9._-]+$/
  for (const c of originalAuditReferences.cohorts) {
    check(record(c) && Object.keys(c).length === 7 && Number.isSafeInteger(c.pairIndex) && c.pairIndex >= 0 && c.pairIndex < 60 &&
      typeof c.directory === 'string' && path.test(c.directory) && !directories.has(c.directory) &&
      typeof c.sourceCompanionDirectory === 'string' && path.test(c.sourceCompanionDirectory) &&
      [c.reportFileSha256, c.terminalFileSha256, c.inspectorProofSha256, c.sourceCompanionManifestSha256].every(x =>
        typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) && !byIndex.has(c.pairIndex * 2), 'audit_reference_cohort')
    directories.add(c.directory)
    byIndex.set(c.pairIndex * 2, 'report_sha256:' + c.reportFileSha256)
    byIndex.set(c.pairIndex * 2 + 1, 'report_sha256:' + c.reportFileSha256)
  }
  check(Array.isArray(supplied.endpoints) && supplied.endpoints.every(x => byIndex.get(x.index) === x.provenanceRef) &&
    [...byIndex.keys()].every(index => supplied.endpoints.some(x => x.index === index)), 'audit_reference_endpoint_binding')
  const report = { ...runMorphoV2IdleJointPanelBacktest(supplied), originalAuditReferences: structuredClone(originalAuditReferences) }
  check(bytes(report) <= MORPHO_V2_IDLE_JOINT_PANEL_POLICY.maximumOutputBytes, 'output_bound')
  // These closed references retain parent evidence; this mathematical module does not reread or authenticate files.
  return freeze(report)
}

/** Pure data adapter only. Parent must independently replay the original native row/control byte proofs. */
export function morphoV2IdleJointPanelEndpointsFromReport(
  report: unknown, indices: readonly [number, number], provenanceRef: string,
): readonly MorphoV2IdleJointPanelEndpoint[] {
  check(tree(report) && bytes(report) <= MORPHO_V2_IDLE_JOINT_PANEL_POLICY.maximumInputBytes && record(report), 'report_bound')
  check(report.schema === 'morpho_v2_idle_history_panel_native_join_report_v1' ||
    report.schema === 'pyusd_b576_idle_history_native_join_report_v2', 'report_schema')
  check(Array.isArray(indices) && indices.length === 2 && Number.isSafeInteger(indices[0]) && indices[0] >= 0 &&
    indices[0] % 2 === 0 && indices[1] === indices[0] + 1 && indices[1] < 120 &&
    typeof provenanceRef === 'string' && provenanceRef.length > 0 && provenanceRef.length <= 256 && Array.isArray(report.points), 'report_interface')
  if (report.schema === 'morpho_v2_idle_history_panel_native_join_report_v1') check(same(report.panelPointIndices, indices) &&
    report.frozenProbeSharesRaw === MORPHO_V2_IDLE_JOINT_PANEL_POLICY.sharesRaw && report.QAssetRaw === '500000' &&
    report.horizonMs === 86400000 && Array.isArray(report.pointStatuses), 'report_plan_binding')
  const points = report.points as unknown[]
  return freeze(indices.map((index, i) => {
    const label = 'anchor_' + i, matches = points.filter(x => record(x) && x.label === label)
    check(matches.length <= 1, 'report_duplicate_label')
    if (report.schema === 'morpho_v2_idle_history_panel_native_join_report_v1') {
      const statuses = (report.pointStatuses as unknown[]).filter(x => record(x) && x.label === label && x.panelIndex === index)
      check(statuses.length === 1, 'report_status_slot')
      const status = statuses[0] as Record<string, unknown>
      if (status.nativeJoinMeasured !== true)
        return { index, point: matches[0] ?? null, censorReason: 'native_join_unqualified', provenanceRef }
      if (status.eligibleFixedStockEndpoint !== true)
        return { index, point: matches[0] ?? null, censorReason: 'native_join_unqualified', provenanceRef }
    }
    return { index, point: matches[0] ?? null, censorReason: matches.length ? null : 'missing_native_endpoint', provenanceRef }
  }))
}
