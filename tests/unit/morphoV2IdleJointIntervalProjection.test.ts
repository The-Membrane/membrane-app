import { describe, expect, it } from 'vitest'
import { buildMorphoV2IdleJointIntervalProjection, type MorphoV2IdleJointIntervalProjectionInput } from '../../lib/carry/morphoV2IdleJointIntervalProjection'
import { buildMorphoV2IdleJointStockProjection } from '../../lib/carry/morphoV2IdleJointStockProjection'

const H = 3600000, T = Date.parse('2026-10-10T12:00:00.000Z')
function fixture(): MorphoV2IdleJointIntervalProjectionInput {
  const identity = { profileId: 'test_idle', routeKey: 'TEST', destination: '0x' + '1'.repeat(40), asset: '0x' + '2'.repeat(40), assetDecimals: 6, shareDecimals: 18 }
  const regime = { kind: 'zero_adapter_idle' as const, liquidityAdapter: '0x' + '0'.repeat(40), liquidityData: '0x' as const, vaultRuntimeCodeHash: '0x' + '3'.repeat(64), assetRuntimeCodeHash: '0x' + '4'.repeat(64) }
  const source = (i: number, t: number) => ({ chainId: 1 as const, blockNumber: String(i), blockHash: '0x' + String(i).padStart(64, '0'), blockTime: new Date(t).toISOString(), finalized: true as const })
  const point = (i: number, time: number, cash: string, ea: string) => ({ identity: structuredClone(identity), source: source(i, time), regime: structuredClone(regime), idleCashRaw: cash, recordedProbeSharesRaw: '10', recordedQuoteAssetsRaw: ea, totalSupplySharesRaw: '1000', historicalOwnerSharesRaw: '777' })
  return { identity, owner: '0x' + '5'.repeat(40), currentSource: source(100, T), currentRegime: regime, currentSharesRaw: '20', recordedProbeSharesRaw: '10', currentIdleCashRaw: '1000', currentFullEaRaw: '100', requestedRaw: '50', competingMRaw: null, asOfMs: T, horizonMs: H, donors: [{ id: 'a', start: point(1, T - 3 * H, '1000', '10'), end: point(2, T - 2 * H, '1000', '12') }] }
}
function usable(x: MorphoV2IdleJointIntervalProjectionInput) { const p = buildMorphoV2IdleJointIntervalProjection(x)!; expect(p).not.toBeNull(); const s = p.scenarios[0]; expect(s.status).toBe('usable'); if (s.status !== 'usable') throw Error('expected usable'); return { p, s } }
describe('conditional joint projection from independently bound raw units and fresh actual stock', () => {
  it('uses tight endpoint intervals and fresh actual Ea, not a scaled current quote', () => {
    const { p, s } = usable(fixture())
    expect(s.entitlementDeltaInterval).toEqual({ lowerRaw: '3', upperRaw: '5' })
    expect(s.measurementInterval).toMatchObject({ entitlementLowerRaw: '103', entitlementUpperRaw: '105', availableLowerRaw: '103', availableUpperRaw: '105' })
    expect(p).toMatchObject({ recordedProbeSharesRaw: '10', currentSharesRaw: '20', competingMRaw: null, claims: { exactNativeRepricing: false, calibrated: false, executionAuthority: false } })
  })
  it('takes the cash prong before applying Q once', () => {
    const f = fixture(); f.currentIdleCashRaw = '200'; f.donors[0].start.idleCashRaw = '200'; f.donors[0].end.idleCashRaw = '100'
    const { s } = usable(f)
    expect(s.measurementInterval).toMatchObject({ availableLowerRaw: '100', availableUpperRaw: '100' })
    expect(s.measurement).toMatchObject({ headroomRaw: '50', shortfallRaw: '0', bindingProng: 'idle_cash' })
  })
  it('retains real zero capacity and visible shortfall', () => {
    const f = fixture(); f.currentIdleCashRaw = '0'; f.donors[0].start.idleCashRaw = '0'; f.donors[0].end.idleCashRaw = '0'
    const { s } = usable(f)
    expect(s.measurementInterval).toMatchObject({ availableLowerRaw: '0', availableUpperRaw: '0', possibleInsufficiency: true, definiteInsufficiency: true })
    expect(s.measurement.shortfallRaw).toBe('50')
  })
  it('propagates negative integer changes with signed floor, never truncation', () => {
    const f = fixture(); f.currentSharesRaw = '15'; f.horizonMs = H / 2; f.donors[0].end.recordedQuoteAssetsRaw = '9'
    const { s } = usable(f)
    expect(s.entitlementDeltaInterval).toEqual({ lowerRaw: '-3', upperRaw: '-1' })
    expect(s.measurementInterval).toMatchObject({ entitlementLowerRaw: '98', entitlementUpperRaw: '99' })
  })
  it('projects source age plus horizon once and stamps the issue target', () => {
    const f = fixture(); f.asOfMs += H / 2
    const { p, s } = usable(f)
    expect(p.sourceAgeMs).toBe(H / 2); expect(p.projectionElapsedMs).toBe(H * 1.5)
    expect(p.targetAtUtc).toBe(new Date(T + H * 1.5).toISOString())
    expect(s.measurementInterval).toMatchObject({ entitlementLowerRaw: '104', entitlementUpperRaw: '107' })
  })
  it('preserves exact native same-S floor-projection parity', () => {
    const f = fixture(); f.currentSharesRaw = '10'; f.asOfMs += H / 2
    const { s } = usable(f), d = f.donors[0]
    const nativePoint = (p: typeof d.start) => ({ identity: p.identity, owner: f.owner, source: p.source, regime: p.regime, idleCashRaw: p.idleCashRaw, historicalOwnerSharesRaw: p.historicalOwnerSharesRaw, fixedCurrentStockConversion: { method: 'native_preview_redeem_fixed_current_shares' as const, source: p.source, probeSharesRaw: '10', asset: f.identity.asset, assetDecimals: 6, shareDecimals: 18, assetsRaw: p.recordedQuoteAssetsRaw } })
    const { recordedProbeSharesRaw: _probe, donors: _donors, ...common } = f
    const native = buildMorphoV2IdleJointStockProjection({ ...common, donors: [{ id: d.id, start: nativePoint(d.start), end: nativePoint(d.end) }] })!
    const n = native.scenarios[0]; expect(n.status).toBe('usable')
    if (n.status === 'usable') { expect(s.measurementInterval.lower).toEqual(n.measurement); expect(s.measurementInterval.upper).toEqual(n.measurement) }
  })
  it('keeps unknown M null and applies only an independent additional reserve once', () => {
    const f = fixture(); f.currentIdleCashRaw = '200'; f.currentFullEaRaw = '1000'; f.donors[0].start.idleCashRaw = '200'; f.donors[0].end.idleCashRaw = '100'
    expect(usable(f).s.measurement.availableRaw).toBe('100')
    f.competingMRaw = '10'; const { p, s } = usable(f)
    expect(s.measurement).toMatchObject({ availableRaw: '90', headroomRaw: '40' })
    expect(p.historicalCashDeltaIncludesNetCompetingFlow).toBe(true)
  })
  it('never substitutes diagnostic historical owner stock for the recorded conversion probe', () => {
    const f = fixture(), a = usable(f).s.measurementInterval
    f.donors[0].start.historicalOwnerSharesRaw = '0'; f.donors[0].end.historicalOwnerSharesRaw = null
    const b = usable(f).s; expect(b.measurementInterval).toEqual(a)
    expect(b.historicalOwnerSharesRaw).toEqual({ start: '0', end: null })
    expect(b.historicalOwnedEntitlementAssetRaw).toBeNull()
  })
  it('retains supply extrapolation as a conditional flag rather than a native quote', () => {
    const f = fixture(); f.donors[0].start.totalSupplySharesRaw = '15'
    const { s } = usable(f); expect(s.extrapolatesBeyondHistoricalSupply).toBe(true)
  })
  it.each(['0', '9'])('rejects historical supply %s that cannot support the recorded native probe', supply => { const f = fixture(); f.donors[0].start.totalSupplySharesRaw = supply; expect(buildMorphoV2IdleJointIntervalProjection(f)).toBeNull() })
  it('keeps mean positive shortfall separate from shortfall of mean capacity', () => {
    const f = fixture(); f.currentSharesRaw = '10'; f.currentIdleCashRaw = '200'; f.currentFullEaRaw = '200'; f.requestedRaw = '100'
    f.donors[0].start.recordedQuoteAssetsRaw = '10'; f.donors[0].end.recordedQuoteAssetsRaw = '10'
    const b = structuredClone(f.donors[0]); b.id = 'b'; b.start.source = { ...b.start.source, blockNumber: '10', blockHash: '0x' + 'a'.repeat(64), blockTime: new Date(T - H * 1.5).toISOString() }; b.end.source = { ...b.end.source, blockNumber: '11', blockHash: '0x' + 'b'.repeat(64), blockTime: new Date(T - H * 0.5).toISOString() }; b.start.idleCashRaw = '300'; b.end.idleCashRaw = '100'; f.donors = [f.donors[0], b]
    const p = buildMorphoV2IdleJointIntervalProjection(f)!
    expect(p.descriptive.headline!.available.empiricalMeanFloorRaw).toBe('100')
    expect(p.descriptive.headline!.shortfall.empiricalMeanFloorRaw).toBe('50')
    expect(p.scenarios.map(s => s.status === 'usable' ? s.measurement.availableRaw : null)).toEqual(['200', '0'])
  })
  it('keeps 65 modeled checkpoints and sampled crossing, never continuous duration', () => {
    const f = fixture(); f.currentIdleCashRaw = '100'; f.donors[0].start.idleCashRaw = '100'; f.donors[0].end.idleCashRaw = '0'
    const { s } = usable(f)
    expect(s.sampledTimeline.checkpoints).toHaveLength(65)
    expect(s.sampledTimeline.firstSampledCrossing).toEqual({ earliestElapsedMs: H / 2, latestElapsedMs: H * 33 / 64 })
    expect(s.sampledIntervalTimeline).toMatchObject({ unknownBetweenCheckpoints: true, continuousProof: false, guaranteedDurationMs: null })
  })
  it('detects a declining last sampled prong after equal issue/horizon capacity', () => {
    const f = fixture(); f.currentSharesRaw = '10'; f.currentIdleCashRaw = '200'; f.currentFullEaRaw = '100'; f.donors[0].start.idleCashRaw = '200'; f.donors[0].end.idleCashRaw = '100'; f.donors[0].start.recordedQuoteAssetsRaw = '100'; f.donors[0].end.recordedQuoteAssetsRaw = '200'
    const { s } = usable(f)
    expect(s.sampledTimeline.issueToHorizonAvailableChangeRaw).toBe('0')
    expect(s.sampledIntervalTimeline.lowerShrinkingAtHorizon).toBe(true)
  })
  it('supports seven days while bounding samples and rejecting a longer horizon', () => {
    const f = fixture(); f.horizonMs = 7 * 86400000
    expect(usable(f).s.sampledTimeline.checkpoints).toHaveLength(65)
    f.horizonMs++; expect(buildMorphoV2IdleJointIntervalProjection(f)).toBeNull()
  })
  it.each(['asset', 'decimals', 'share decimals', 'runtime', 'adapter', 'data', 'probe', 'future', 'equal end', 'nonchronological', 'malformed uint', 'extra property'])('rejects %s mismatch instead of relabeling conditional inputs', kind => {
    const f = fixture(), p = f.donors[0].start
    if (kind === 'asset') p.identity.asset = '0x' + '6'.repeat(40)
    if (kind === 'decimals') p.identity.assetDecimals = 18
    if (kind === 'share decimals') p.identity.shareDecimals = 6
    if (kind === 'runtime') p.regime.vaultRuntimeCodeHash = '0x' + '6'.repeat(64)
    if (kind === 'adapter') p.regime.liquidityAdapter = '0x' + '7'.repeat(40)
    if (kind === 'data') (p.regime as { liquidityData: string }).liquidityData = '0x01'
    if (kind === 'probe') p.recordedProbeSharesRaw = '11'
    if (kind === 'future') f.donors[0].end.source.blockTime = new Date(T + H).toISOString()
    if (kind === 'equal end') f.donors[0].end.source.blockTime = new Date(T).toISOString()
    if (kind === 'nonchronological') f.donors[0].end.source.blockTime = p.source.blockTime
    if (kind === 'malformed uint') p.recordedQuoteAssetsRaw = '01'
    if (kind === 'extra property') Object.assign(p, { nativeAuthority: true })
    expect(buildMorphoV2IdleJointIntervalProjection(f)).toBeNull()
  })
  it.each([-1, 1800001])('rejects current source age %s', age => { const f = fixture(); f.asOfMs = T + age; expect(buildMorphoV2IdleJointIntervalProjection(f)).toBeNull() })
  it('retains arithmetic censors and withholds the complete headline', () => {
    const f = fixture(); f.recordedProbeSharesRaw = '1'; f.donors[0].start.recordedProbeSharesRaw = '1'; f.donors[0].end.recordedProbeSharesRaw = '1'; f.donors[0].start.recordedQuoteAssetsRaw = ((1n << 256n) - 1n).toString(); f.donors[0].end.recordedQuoteAssetsRaw = f.donors[0].start.recordedQuoteAssetsRaw
    const p = buildMorphoV2IdleJointIntervalProjection(f)!
    expect(p.scenarios[0]).toMatchObject({ status: 'censored', arithmeticCensorStage: 'historical_endpoint_bounds', fixedShareEaDeltaRaw: null, entitlementDeltaInterval: null }); expect(p.censoredDonorCount).toBe(1); expect(p.descriptive.headline).toBeNull()
  })
  it('retains unknown endpoint delta rather than fabricating unchanged stock after an asymmetric overflow', () => {
    const f = fixture(); f.currentSharesRaw = '2'; f.recordedProbeSharesRaw = '1'
    f.donors[0].start.recordedProbeSharesRaw = '1'; f.donors[0].end.recordedProbeSharesRaw = '1'
    f.donors[0].start.recordedQuoteAssetsRaw = ((1n << 256n) - 1n).toString(); f.donors[0].end.recordedQuoteAssetsRaw = '0'
    const p = buildMorphoV2IdleJointIntervalProjection(f)!
    expect(p.scenarios[0]).toMatchObject({ status: 'censored', arithmeticCensorStage: 'historical_endpoint_bounds', fixedShareEaDeltaRaw: null, entitlementDeltaInterval: null })
    expect(p.descriptive.headline).toBeNull(); expect(p.entitlementIntervals.headline).toBeNull()
  })
  it('preserves known historical delta when only the future projected entitlement overflows', () => {
    const f = fixture(); f.currentSharesRaw = '10'; f.currentFullEaRaw = ((1n << 256n) - 1n).toString()
    const p = buildMorphoV2IdleJointIntervalProjection(f)!
    expect(p.scenarios[0]).toMatchObject({ status: 'censored', arithmeticCensorStage: 'future_projection', fixedShareEaDeltaRaw: '2', entitlementDeltaInterval: { lowerRaw: '2', upperRaw: '2' } })
    expect(p.descriptive.headline).toBeNull()
  })
  it('keeps empty-history persistence without fabricating a donor', () => { const f = fixture(); f.donors = []; const p = buildMorphoV2IdleJointIntervalProjection(f)!; expect(p.donorCount).toBe(0); expect(p.descriptive.headline).toBeNull(); expect(p.persistenceBaseline.measurement.availableRaw).toBe('100') })
  it('rejects getters without running them', () => { const f = fixture(); let called = false; Object.defineProperty(f, 'currentFullEaRaw', { enumerable: true, get() { called = true; return '100' } }); expect(buildMorphoV2IdleJointIntervalProjection(f)).toBeNull(); expect(called).toBe(false) })
})
