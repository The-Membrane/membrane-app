import { describe, expect, it } from 'vitest'
import {
  buildMorphoV2IdleJointStockProjection,
  MORPHO_V2_IDLE_JOINT_STOCK_POLICY,
  type MorphoV2IdleHistoricalPoint,
  type MorphoV2IdleJointStockProjection,
  type MorphoV2IdleJointStockProjectionInput,
  type MorphoV2IdleNativeSource,
} from '@/lib/carry/morphoV2IdleJointStockProjection'

const HOUR = 3600000
const CURRENT_MS = Date.parse('2026-10-10T05:10:47.000Z')
const MAX = (1n << 256n) - 1n
const ZERO = '0x' + '0'.repeat(40)
const IDENTITY = {
  profileId: 'morpho_v2_pyusd_b576_observed_idle_history',
  routeKey: 'PYUSD → VaultV2 [PYUSD]',
  destination: '0xb576765fb15505433af24fee2c0325895c559fb2',
  asset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
  assetDecimals: 6,
  shareDecimals: 18,
}
const OWNER = '0xf181e2cc93a47cb4903ac71c23ecb873726dc668'
const REGIME = {
  kind: 'zero_adapter_idle' as const,
  liquidityAdapter: ZERO,
  liquidityData: '0x' as const,
  vaultRuntimeCodeHash: '0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd',
  assetRuntimeCodeHash: '0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1',
}
function source(ms: number, block: number): MorphoV2IdleNativeSource {
  return { chainId: 1, blockNumber: String(block),
    blockHash: '0x' + BigInt(block).toString(16).padStart(64, '0'),
    blockTime: new Date(ms).toISOString(), finalized: true }
}
function point(
  s: MorphoV2IdleNativeSource, cash: string, ea: string, shares = '300',
): MorphoV2IdleHistoricalPoint {
  return { identity: { ...IDENTITY }, owner: OWNER, source: { ...s }, regime: { ...REGIME },
    idleCashRaw: cash, historicalOwnerSharesRaw: shares,
    fixedCurrentStockConversion: {
      method: 'native_preview_redeem_fixed_current_shares', source: { ...s },
      probeSharesRaw: shares, asset: IDENTITY.asset, assetDecimals: 6, shareDecimals: 18, assetsRaw: ea,
    } }
}
function fixture(): MorphoV2IdleJointStockProjectionInput {
  return { identity: { ...IDENTITY }, owner: OWNER, currentSource: source(CURRENT_MS, 10000),
    currentRegime: { ...REGIME }, currentSharesRaw: '300', currentIdleCashRaw: '100',
    currentFullEaRaw: '60', asOfMs: CURRENT_MS, horizonMs: HOUR, requestedRaw: '20',
    competingMRaw: null, donors: [{ id: 'paired-hour',
      start: point(source(CURRENT_MS - 2 * HOUR, 100), '100', '100'),
      end: point(source(CURRENT_MS - HOUR, 200), '60', '120'),
    }] }
}
function built(input = fixture()): MorphoV2IdleJointStockProjection {
  const result = buildMorphoV2IdleJointStockProjection(input)
  expect(result).not.toBeNull()
  return result!
}
function usable(input = fixture()) {
  const result = built(input), scenario = result.scenarios[0]
  expect(scenario.status).toBe('usable')
  if (scenario.status !== 'usable') throw Error('expected usable fixture')
  return { result, scenario }
}
function shortDonor(input: MorphoV2IdleJointStockProjectionInput, c0: string, c1: string, e0: string, e1: string) {
  input.donors = [{ id: 'three-seconds',
    start: point(source(CURRENT_MS - 6000, 100), c0, e0),
    end: point(source(CURRENT_MS - 3000, 200), c1, e1),
  }]
  input.horizonMs = 1000
  input.currentFullEaRaw = '100'
}
function nativeFixture(): MorphoV2IdleJointStockProjectionInput {
  // Facts from the parent-verified V2 report (SHA256 09f5619b3f07d62a22bf56fb6732a6b4f0a7c6dc91f0781452372ed8d5cbc136).
  // Actual retained readback availability is 05:30:32.512, later than acquisition/terminal timestamps.
  const shares = '352805058661206444'
  const first: MorphoV2IdleNativeSource = {
    chainId: 1, blockNumber: '26100913',
    blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
    blockTime: '2026-10-01T23:59:59.000Z', finalized: true,
  }
  const second: MorphoV2IdleNativeSource = {
    chainId: 1, blockNumber: '26108081',
    blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
    blockTime: '2026-10-02T23:59:59.000Z', finalized: true,
  }
  return { ...fixture(), currentSource: {
    chainId: 1, blockNumber: '26159852',
    blockHash: '0x7f8cc0baca2b0642d22acbc87176d10aabaa69a8b31e84b82662a5ea3e5d0a1c',
    blockTime: '2026-10-10T05:10:47.000Z', finalized: true,
  }, currentSharesRaw: shares, currentIdleCashRaw: '39678091697943', currentFullEaRaw: '714000',
  asOfMs: Date.parse('2026-10-10T05:30:32.512Z'), requestedRaw: '500000',
  donors: [{ id: 'native-oct1-oct2',
    start: point(first, '20919825104652', '713612', shares),
    end: point(second, '24375516077801', '713661', shares),
  }] }
}

describe('Morpho V2 idle joint stock mathematics', () => {
  it('projects both channels and exposes cash-limited nonnegative headroom', () => {
    const { result, scenario } = usable()
    expect(scenario.measurement).toEqual({
      projectedIdleCashRaw: '60', projectedFullEaRaw: '80', availableRaw: '60',
      headroomRaw: '40', shortfallRaw: '0', signedMarginRaw: '40', bindingProng: 'idle_cash',
    })
    expect(result.persistenceBaseline.measurement.projectedFullEaRaw).toBe('60')
    expect(result.descriptive.headline?.available).toEqual({
      sampleCount: 1, minimumRaw: '60', maximumRaw: '60', empiricalMeanFloorRaw: '60', confidenceInterval: false,
    })
    expect([result.donorCount, result.usableDonorCount, result.censoredDonorCount]).toEqual([1, 1, 0])
  })

  it('keeps a shrinking full entitlement as the binding prong', () => {
    const input = fixture()
    input.donors[0].end.idleCashRaw = '150'
    input.donors[0].end.fixedCurrentStockConversion.assetsRaw = '90'
    const { scenario } = usable(input)
    expect(scenario.measurement).toMatchObject({
      projectedIdleCashRaw: '150', projectedFullEaRaw: '50',
      availableRaw: '50', headroomRaw: '30', bindingProng: 'full_entitlement',
    })
  })

  it.each([
    ['100', '101', '100', '99', '100', '99'],
    ['100', '99', '100', '101', '99', '100'],
  ])('floors positive and negative fractional rates conservatively (%s→%s; %s→%s)', (c0, c1, e0, e1, c, e) => {
    const input = fixture()
    shortDonor(input, c0, c1, e0, e1)
    const { scenario } = usable(input)
    expect(scenario.measurement.projectedIdleCashRaw).toBe(c)
    expect(scenario.measurement.projectedFullEaRaw).toBe(e)
  })

  it('counts source age once and anchors targets to issue time', () => {
    const input = fixture()
    shortDonor(input, '100', '103', '100', '106')
    input.asOfMs += 1000
    const { result, scenario } = usable(input)
    expect(result.sourceAgeMs).toBe(1000)
    expect(result.projectionElapsedMs).toBe(2000)
    expect(result.targetAtUtc).toBe('2026-10-10T05:10:49.000Z')
    expect(scenario.issueMeasurement.availableRaw).toBe('101')
    expect(scenario.measurement).toMatchObject({
      projectedIdleCashRaw: '102', projectedFullEaRaw: '104', availableRaw: '102', signedMarginRaw: '82',
    })
    expect(scenario.sampledTimeline.checkpoints.at(-1)?.atUtc).toBe(result.targetAtUtc)
  })

  it('subtracts Q once after the joint minimum, independently of the two stock projections', () => {
    const a = fixture(), b = fixture()
    b.requestedRaw = '70'
    const first = usable(a).scenario.measurement, second = usable(b).scenario.measurement
    expect(second.availableRaw).toBe(first.availableRaw)
    expect(second.projectedFullEaRaw).toBe(first.projectedFullEaRaw)
    expect(second).toMatchObject({ availableRaw: '60', headroomRaw: '0', shortfallRaw: '10', signedMarginRaw: '-10' })
    expect(BigInt(first.signedMarginRaw) - BigInt(second.signedMarginRaw)).toBe(50n)
  })

  it('preserves unknown M and applies only an independent additional future reserve', () => {
    const input = fixture()
    input.currentFullEaRaw = '100'
    input.donors[0].end.idleCashRaw = '90'
    input.donors[0].end.fixedCurrentStockConversion.assetsRaw = '100'
    const unknown = usable(input)
    expect(unknown.result.competingMRaw).toBeNull()
    expect(unknown.result.competingFlowHandling).toBe('unknown_M_no_additional_reserve_assumed')
    expect(unknown.scenario.measurement.availableRaw).toBe('90')
    input.competingMRaw = '10'
    const reserved = usable(input)
    expect(reserved.result.currentObservedMeasurement.availableRaw).toBe('100')
    expect(reserved.result.competingMRaw).toBe('10')
    expect(reserved.scenario.measurement).toMatchObject({ projectedIdleCashRaw: '90', availableRaw: '80', signedMarginRaw: '60' })
    expect(reserved.result.historicalCashDeltaIncludesNetCompetingFlow).toBe(true)
    expect(reserved.result.reserveTiming).toBe('full_additional_reserve_applied_once_at_each_measurement')
  })

  it('keeps historical actual owner stock diagnostic, including unknown past stock', () => {
    const input = fixture()
    input.donors[0].start.historicalOwnerSharesRaw = '1'
    input.donors[0].end.historicalOwnerSharesRaw = null
    const { scenario, result } = usable(input)
    expect(scenario.historicalOwnerSharesRaw).toEqual({ start: '1', end: null })
    expect(scenario.historicalOwnedEntitlementAssetRaw).toBeNull()
    expect(result.historicalConversionSemantics).toBe('hypothetical_fixed_current_stock_not_past_owned_entitlement')
    expect(result.claims.historicalOwnershipProven).toBe(false)
    input.donors[0].start.fixedCurrentStockConversion.probeSharesRaw = '1'
    expect(buildMorphoV2IdleJointStockProjection(input)).toBeNull()
  })

  it('supports an asset18 idle identity without share/asset supply conflation', () => {
    const input = fixture()
    input.identity = { ...input.identity, profileId: 'synthetic_asset18_idle', routeKey: 'Synthetic asset18 idle',
      destination: '0x' + 'a'.repeat(40), asset: '0x' + 'b'.repeat(40), assetDecimals: 18 }
    for (const end of [input.donors[0].start, input.donors[0].end]) {
      end.identity = { ...input.identity }
      end.fixedCurrentStockConversion.asset = input.identity.asset
      end.fixedCurrentStockConversion.assetDecimals = 18
    }
    const { result, scenario } = usable(input)
    expect(result.identity.assetDecimals).toBe(18)
    expect(result.currentSharesRaw).toBe('300')
    expect(scenario.measurement.availableRaw).toBe('60')
  })

  it('aggregates already-joint minima instead of averaging the two limiting channels', () => {
    const input = fixture()
    input.currentFullEaRaw = '100'; input.requestedRaw = '10'
    input.donors = [
      { id: 'cash-up-ea-down', start: point(source(CURRENT_MS - 4 * HOUR, 100), '100', '100'),
        end: point(source(CURRENT_MS - 3 * HOUR, 200), '200', '0') },
      { id: 'cash-down-ea-up', start: point(source(CURRENT_MS - 2 * HOUR, 300), '100', '100'),
        end: point(source(CURRENT_MS - HOUR, 400), '0', '200') },
    ]
    const result = built(input)
    expect(result.descriptive.headline?.available).toMatchObject({
      sampleCount: 2, minimumRaw: '0', maximumRaw: '0', empiricalMeanFloorRaw: '0',
    })
    expect(result.descriptive.headline?.signedMargin.empiricalMeanFloorRaw).toBe('-10')
  })

  it('bounds sampling at 65 points and reports decreasing ability and a sampled Q crossing', () => {
    const input = fixture()
    input.currentFullEaRaw = '100'; input.requestedRaw = '70'; input.horizonMs = 64000
    input.donors = [{ id: 'depletion',
      start: point(source(CURRENT_MS - 128000, 100), '100', '100'),
      end: point(source(CURRENT_MS - 64000, 200), '36', '100'),
    }]
    const timeline = usable(input).scenario.sampledTimeline
    expect(timeline.checkpoints).toHaveLength(65)
    expect(timeline.maxCheckpointGapMs).toBe(1000)
    expect(timeline.firstObservedDecreaseMs).toBe(1000)
    expect(timeline.firstSampledInsufficiencyMs).toBe(31000)
    expect(timeline.firstSampledCrossing).toEqual({ earliestElapsedMs: 30000, latestElapsedMs: 31000 })
    expect(timeline).toMatchObject({
      insufficientAtIssue: false, shrinkingAtHorizon: true, horizonTrendBasis: 'last_sampled_interval',
      issueToHorizonAvailableChangeRaw: '-64',
      minimumSampledAvailableRaw: '36', unknownBetweenCheckpoints: true,
      trueFirstLossClaim: false, continuousProof: false, guaranteedDurationMs: null,
    })
  })

  it.each([
    ['zero net change', '200', '100', '0', '150'],
    ['positive net change', '250', '150', '50', '175'],
  ])('reports final-interval shrinking after a binding-prong switch with %s', (_label, currentCash, finalAvailable, netChange, peakAvailable) => {
    const input = fixture()
    input.currentIdleCashRaw = currentCash
    input.currentFullEaRaw = '100'
    input.donors = [{ id: 'switching-prongs',
      start: point(source(CURRENT_MS - 2 * HOUR, 100), '200', '100'),
      end: point(source(CURRENT_MS - HOUR, 200), '100', '200'),
    }]
    const { scenario } = usable(input), timeline = scenario.sampledTimeline
    expect(scenario.issueMeasurement.bindingProng).toBe('full_entitlement')
    expect(scenario.measurement.bindingProng).toBe('idle_cash')
    expect(timeline.checkpoints[0].availableRaw).toBe('100')
    expect(timeline.checkpoints.at(-1)?.availableRaw).toBe(finalAvailable)
    expect(timeline.checkpoints.some((x) => x.availableRaw === peakAvailable)).toBe(true)
    expect(BigInt(timeline.checkpoints.at(-1)!.availableRaw)).toBeLessThan(BigInt(timeline.checkpoints.at(-2)!.availableRaw))
    expect(timeline.firstObservedDecreaseMs).not.toBeNull()
    expect(timeline).toMatchObject({
      shrinkingAtHorizon: true, horizonTrendBasis: 'last_sampled_interval',
      issueToHorizonAvailableChangeRaw: netChange,
      unknownBetweenCheckpoints: true, continuousProof: false, guaranteedDurationMs: null,
    })
  })

  it('keeps issue-time insufficiency visible without inventing a crossing before the first sample', () => {
    const input = fixture()
    input.requestedRaw = '1000'
    const timeline = usable(input).scenario.sampledTimeline
    expect(timeline.insufficientAtIssue).toBe(true)
    expect(timeline.firstSampledInsufficiencyMs).toBe(0)
    expect(timeline.firstSampledCrossing).toBeNull()
  })

  it('allows multi-day horizons and includes both endpoints in a bounded timeline', () => {
    const input = fixture()
    input.horizonMs = 7 * 86400000
    const timeline = usable(input).scenario.sampledTimeline
    expect(timeline.checkpoints).toHaveLength(65)
    expect(timeline.checkpoints[0].elapsedMs).toBe(0)
    expect(timeline.checkpoints.at(-1)?.elapsedMs).toBe(input.horizonMs)
    expect(timeline.maxCheckpointGapMs).toBe(9450000)
    input.horizonMs += 1000
    expect(buildMorphoV2IdleJointStockProjection(input)).toBeNull()
  })

  it('returns only a labeled persistence baseline when no paired history exists', () => {
    const input = fixture()
    input.donors = []
    const result = built(input)
    expect(result.historyStatus).toBe('no_usable_paired_intervals')
    expect(result.donorCount).toBe(0)
    expect(result.scenarios).toEqual([])
    expect(result.descriptive.headline).toBeNull()
    expect(result.descriptive.usableOnlyDiagnostic).toBeNull()
    expect(result.persistenceBaseline.measurement.availableRaw).toBe('60')
    expect(result.persistenceBaseline.sampledTimeline.guaranteedDurationMs).toBeNull()
  })

  it('retains numerical overflow as a censored donor and suppresses a complete headline', () => {
    const input = fixture()
    input.currentIdleCashRaw = String(MAX)
    input.donors[0].end.idleCashRaw = '101'
    const result = built(input)
    expect(result.scenarios[0]).toMatchObject({ status: 'censored', reason: 'projected_stock_uint256_overflow' })
    expect(result.usableDonorCount).toBe(0)
    expect(result.censoredDonorCount).toBe(1)
    expect(result.descriptive.headline).toBeNull()
    expect(result.persistenceBaseline.measurement.availableRaw).toBe('60')
  })

  it.each([
    ['one-hour', HOUR, '714002', '214002'],
    ['four-hour', 4 * HOUR, '714008', '214008'],
    ['one-day', 24 * HOUR, '714049', '214049'],
  ])('replays the verified B576 %s corpus with its actual retained availability', (_label, horizon, ea, headroom) => {
    const input = nativeFixture()
    input.horizonMs = Number(horizon)
    const { result, scenario } = usable(input)
    expect(result.sourceAgeMs).toBe(1185512)
    expect(result.targetAtUtc).toBe(new Date(input.asOfMs + Number(horizon)).toISOString())
    expect(scenario.measurement.projectedFullEaRaw).toBe(ea)
    expect(scenario.measurement.headroomRaw).toBe(headroom)
    expect(scenario.measurement.bindingProng).toBe('full_entitlement')
    expect(result.persistenceBaseline.measurement.headroomRaw).toBe('214000')
    expect(result.claims).toMatchObject({
      authenticated: false, originalAuthority: false, profileApproval: false,
      historicalOwnershipProven: false, currentWalletControl: false,
      sourceImplementationEquivalence: false, holderExecutableExit: false,
      executionValidated: false, guaranteedExecution: false, prospectiveValidation: false,
      forecastValidated: false, calibrated: false, calibratedProbability: false, coveragePromotion: false,
    })
  })

  it.each(['', '01', '-1', '+1', '1.5', '1e6', String(MAX + 1n)])('rejects malformed native scalar %s', (raw) => {
    const input = fixture()
    input.currentIdleCashRaw = raw
    expect(buildMorphoV2IdleJointStockProjection(input)).toBeNull()
  })

  it.each([
    ['asset units', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.fixedCurrentStockConversion.assetDecimals = 18 }],
    ['share units', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.identity.shareDecimals = 6 }],
    ['asset identity', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.fixedCurrentStockConversion.asset = '0x' + 'b'.repeat(40) }],
    ['owner identity', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.owner = '0x' + 'b'.repeat(40) }],
    ['profile identity', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.identity.profileId = 'different_profile' }],
    ['source hash join', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.fixedCurrentStockConversion.source.blockHash = '0x' + 'f'.repeat(64) }],
    ['chain', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.source.chainId = 2 as 1 }],
    ['runtime', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.regime.vaultRuntimeCodeHash = '0x' + 'f'.repeat(64) }],
    ['adapter', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.regime.liquidityAdapter = '0x' + 'b'.repeat(40) }],
    ['empty data', (x: MorphoV2IdleJointStockProjectionInput) => { x.donors[0].end.regime.liquidityData = '0x00' as '0x' }],
    ['missing conversion', (x: MorphoV2IdleJointStockProjectionInput) => { delete (x.donors[0].end as Partial<MorphoV2IdleHistoricalPoint>).fixedCurrentStockConversion }],
  ] as const)('rejects mismatched %s rather than quietly excluding that donor', (_label, mutate) => {
    const input = fixture()
    mutate(input)
    expect(buildMorphoV2IdleJointStockProjection(input)).toBeNull()
  })

  it('rejects stale, future, nonfinalized, noncanonical and reversed sources', () => {
    const stale = fixture(); stale.asOfMs += 30 * 60000 + 1
    expect(buildMorphoV2IdleJointStockProjection(stale)).toBeNull()
    const freshEdge = fixture(); freshEdge.asOfMs += 30 * 60000
    expect(buildMorphoV2IdleJointStockProjection(freshEdge)).not.toBeNull()
    const future = fixture()
    future.asOfMs += 2000
    const s = source(CURRENT_MS + 1000, 10001)
    future.donors[0].end.source = s; future.donors[0].end.fixedCurrentStockConversion.source = { ...s }
    expect(buildMorphoV2IdleJointStockProjection(future)).toBeNull()
    const reversed = fixture()
    reversed.donors[0] = { ...reversed.donors[0], start: reversed.donors[0].end, end: reversed.donors[0].start }
    expect(buildMorphoV2IdleJointStockProjection(reversed)).toBeNull()
    const nonfinal = fixture(); nonfinal.currentSource.finalized = false as true
    expect(buildMorphoV2IdleJointStockProjection(nonfinal)).toBeNull()
    const noncanonical = fixture(); noncanonical.currentSource.blockTime = '2026-10-10T05:10:47Z'
    expect(buildMorphoV2IdleJointStockProjection(noncanonical)).toBeNull()
  })

  it('rejects contradictory repeated native facts and duplicate donor intervals', () => {
    const duplicate = fixture()
    duplicate.donors = [...duplicate.donors, { ...duplicate.donors[0], id: 'second-name' }]
    expect(buildMorphoV2IdleJointStockProjection(duplicate)).toBeNull()
    const conflict = fixture(), shared = structuredClone(conflict.donors[0].end)
    shared.idleCashRaw = '61'
    conflict.donors = [...conflict.donors, { id: 'shared-endpoint',
      start: shared, end: point(source(CURRENT_MS - HOUR / 2, 300), '62', '121') }]
    expect(buildMorphoV2IdleJointStockProjection(conflict)).toBeNull()
    const atCurrent = fixture()
    atCurrent.donors[0].end = point({ ...atCurrent.currentSource }, '101', '60')
    expect(buildMorphoV2IdleJointStockProjection(atCurrent)).toBeNull()
  })

  it('rejects sparse donors, missing M, invalid units and accessor-supplied facts without calling getters', () => {
    const sparse = fixture(); sparse.donors = new Array(1)
    expect(buildMorphoV2IdleJointStockProjection(sparse)).toBeNull()
    const missing = fixture(); delete (missing as Partial<MorphoV2IdleJointStockProjectionInput>).competingMRaw
    expect(buildMorphoV2IdleJointStockProjection(missing)).toBeNull()
    const units = fixture(); units.identity.assetDecimals = 37
    expect(buildMorphoV2IdleJointStockProjection(units)).toBeNull()
    const getter = fixture()
    let called = 0
    Object.defineProperty(getter, 'currentFullEaRaw', { enumerable: true, get() { called++; return '60' } })
    expect(buildMorphoV2IdleJointStockProjection(getter)).toBeNull()
    expect(called).toBe(0)
  })

  it('bounds donor count, timeline allocation and serialized output at the largest accepted cohort', () => {
    const input = fixture()
    const large = String(MAX / 2n)
    input.currentIdleCashRaw = large; input.currentFullEaRaw = large
    input.donors = Array.from({ length: 128 }, (_, i) => ({
      id: 'interval-' + i,
      start: point(source(CURRENT_MS - (300 - i * 2) * 1000, 1000 + i * 2), large, large),
      end: point(source(CURRENT_MS - (299 - i * 2) * 1000, 1001 + i * 2), large, large),
    }))
    const result = built(input)
    expect(result.usableDonorCount).toBe(128)
    expect(result.scenarios.every((s) => s.status === 'usable' && s.sampledTimeline.checkpoints.length === 65)).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MORPHO_V2_IDLE_JOINT_STOCK_POLICY.maximumSerializedBytes,
    )
    input.donors = [...input.donors, { ...input.donors[0], id: 'over-limit' }]
    expect(buildMorphoV2IdleJointStockProjection(input)).toBeNull()
  })

  it('returns copied frozen mathematical results without freezing or retaining caller objects', () => {
    const input = fixture(), result = built(input)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.scenarios)).toBe(true)
    input.currentSource.blockHash = '0x' + 'f'.repeat(64)
    expect(result.currentSource.blockHash).not.toBe(input.currentSource.blockHash)
    expect(result.claims.authenticated).toBe(false)
  })
})
