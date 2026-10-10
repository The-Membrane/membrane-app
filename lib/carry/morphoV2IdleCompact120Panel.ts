/** Plain historical data only. Expansion grants no evidence brand or authority. */
export const MORPHO_V2_IDLE_COMPACT120_SCHEMA = 'morpho_v2_idle_compact_fixed_probe_panel_v1' as const
export const MORPHO_V2_IDLE_COMPACT120_MAX_BYTES = 64 * 1024
export type MorphoV2IdleCompactEndpointTuple = readonly [
  blockNumber: string, blockHash: string, blockTime: string, cashRaw: string,
  recordedProbeQuoteAssetsRaw: string, totalAssetsRaw: string, totalSupplySharesRaw: string,
  historicalOwnerSharesRaw: string | null, regimeIndex: number, censorIndex: number,
]
export type MorphoV2IdleCompactCohortTuple = readonly [
  directoryBasename: string, reportFileSha256: string, reportBodySha256: string,
  terminalFileSha256: string, terminalBodySha256: string, replayCopyFileSha256: string,
  sourceArchiveIndices: readonly number[], nativeAcquisitionCompletedAtUtc: string | null,
]
export type MorphoV2IdleCompactPairTuple = readonly [
  status: 'scored' | 'censored', reason: string | null,
  nativeEligibleDonorPairs: number, usedDonorPairs: number,
]
export type MorphoV2IdleCompactRuntime = Readonly<{ bytes: number; keccak256: string }>
export type MorphoV2IdleCompactRegime = Readonly<{
  nativeRegimeKind: string
  liquidityAdapter: string
  liquidityData: string
  vaultRuntime: MorphoV2IdleCompactRuntime
  assetRuntime: MorphoV2IdleCompactRuntime
  ownerRuntime: MorphoV2IdleCompactRuntime
}>
export type MorphoV2IdleCompactScore = Readonly<{
  comparisons: number
  availableAbsoluteErrorSumRaw: string
  shortfallAbsoluteErrorSumRaw: string
  endpointInsufficiencyClassificationMatches: number
}>
export type MorphoV2IdleCompact120Panel = Readonly<{
  schema: typeof MORPHO_V2_IDLE_COMPACT120_SCHEMA
  identity: Readonly<{
    profileId: 'morpho_v2_pyusd_b576_observed_idle_history'
    routeKey: 'PYUSD → VaultV2 [PYUSD]'
    destination: '0xb576765fb15505433af24fee2c0325895c559fb2'
    asset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8'
    assetDecimals: 6
    shareDecimals: 18
  }>
  recordedProbe: Readonly<{
    owner: '0xf181e2cc93a47cb4903ac71c23ecb873726dc668'
    sharesRaw: '352805058661206444'
    quoteKind: 'native_preview_redeem_recorded_probe_stock'
    historicalOwnedEntitlement: null
  }>
  // Facts availability inherits the accepted root replay's completed readback.
  // It is neither historical issuance nor the later compact artifact's fsync time.
  actualAvailabilityAtUtc: string
  sourceCommitments: Readonly<{
    retentionDirectoryBasename: string
    retentionManifestFileSha256: string
    replayTerminalFileSha256: string
    rootReplayProofFileSha256: string
    referencesFileSha256: string
    selectedScoreFileSha256: string
    headerReplayFileSha256: string
    catalogSha256: string
    headerExecutionAcceptance: Readonly<{ path: string; bytes: number; fileSha256: string }>
  }>
  sourceArchives: readonly Readonly<{ directoryBasename: string; manifestFileSha256: string }>[]
  // Endpoint index implies pair=floor(index/2); chronological partitions have 20 pairs each.
  endpoints: readonly MorphoV2IdleCompactEndpointTuple[]
  cohorts: readonly MorphoV2IdleCompactCohortTuple[]
  pairs: readonly MorphoV2IdleCompactPairTuple[]
  regimes: readonly MorphoV2IdleCompactRegime[]
  censorReasons: readonly (readonly string[])[]
  counts: Readonly<{
    plannedEndpoints: 120; usableEndpoints: 108; censoredEndpoints: 12
    plannedPairs: 60; nativeEndpointPairs: 54; jointComparisons: 53; censoredJointPairs: 7
  }>
  retrospectiveScores: Readonly<{
    joint: MorphoV2IdleCompactScore
    matchedPersistence: MorphoV2IdleCompactScore
    allNativePersistence: MorphoV2IdleCompactScore
    availableErrorImproved: false
    shortfallErrorImproved: false
  }>
  disclosure: Readonly<{
    horizonMs: 86400000
    requestedRaw: '500000'
    competingMRaw: null
    retrospectivePartitionLabels: readonly ['fit', 'calibration', 'holdout']
    pairsPerPartition: 20
    allCashEndpointsPreviouslyInspected: true
    oldOctoberJointEndpointsPreviouslyInspected: true
    netCashDeltaAlreadyIncludesCompetingFlow: true
    additionalCompetingFlowSubtraction: false
    observedEndpointsPerPair: 2
    dailyEndpointsCertifyContinuousDuration: false
    modeledSamplesAreNativeOutcomes: false
    donorEndMustPrecedeIssue: true
  }>
  claims: Readonly<{
    nativeReplayPerformedByBuilder: false; originalAuthority: false; profileApproval: false
    live: false; historicalOwnership: false; historicalOwnedEntitlementMeasured: false
    currentWalletControl: false; sourceImplementationEquivalence: false
    arbitrarySharesNativeRepricing: false; executionVerified: false; authenticated: false
    calibrated: false; calibratedProbability: false; untouchedHoldout: false
    prospectiveValidation: false; accuracyImprovementClaim: false; coveragePromotion: false
  }>
}>

/** Caller must first bind the panel's exact pinned bytes. This only expands tuples. */
export function expandMorphoV2IdleCompactEndpoint(panel: MorphoV2IdleCompact120Panel, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= panel.endpoints.length) return null
  const p = panel.endpoints[index]
  const pairIndex = Math.floor(index / 2)
  return {
    index, pairIndex,
    retrospectivePartition: panel.disclosure.retrospectivePartitionLabels[Math.floor(pairIndex / 20)],
    source: { chainId: 1 as const, blockNumber: p[0], blockHash: p[1], blockTime: p[2], finalized: true as const },
    idleCashRaw: p[3], recordedProbeQuoteAssetsRaw: p[4],
    totalAssetsRaw: p[5], totalSupplySharesRaw: p[6], historicalOwnerSharesRaw: p[7],
    regime: panel.regimes[p[8]], censorReasons: panel.censorReasons[p[9]],
    nativeAcquisitionCompletedAtUtc: panel.cohorts[pairIndex][7],
  }
}
