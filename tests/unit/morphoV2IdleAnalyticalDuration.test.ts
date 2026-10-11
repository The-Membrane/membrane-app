import { describe, expect, it } from 'vitest'
import { buildMorphoV2IdleJointStockProjection, type MorphoV2IdleJointStockProjectionInput } from '@/lib/carry/morphoV2IdleJointStockProjection'
import { morphoIdleAnalyticalConditionMetrics } from '@/components/Carry/ExitPressureCard'
import type { MorphoV2IdleJointHolderForecast } from '@/lib/carry/morphoV2IdleJointHolderForecastBinding'
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const zero = '0x' + '0'.repeat(40)
const identity = { profileId: 'rlusd-vault-v2-idle', routeKey: 'RLUSD → VaultV2 [RLUSD]', destination: '0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf', asset: '0x8292bb45bf1ee4d140127049757c2e0ff06317ed', assetDecimals: 18, shareDecimals: 18 }
const owner = '0xe837770fc477522360cf620bc15ba34cb9e4a6d0'
const regime = { kind: 'zero_adapter_idle' as const, liquidityAdapter: zero, liquidityData: '0x' as const, vaultRuntimeCodeHash: '0x' + '1'.repeat(64), assetRuntimeCodeHash: '0x' + '2'.repeat(64) }
const source = (ms: number, block: number) => ({ chainId: 1 as const, blockNumber: String(block), blockHash: '0x' + BigInt(block).toString(16).padStart(64, '0'), blockTime: new Date(ms).toISOString(), finalized: true as const })
function fixture(): MorphoV2IdleJointStockProjectionInput {
  const point = (ms: number, block: number, cash: string, ea: string) => { const s = source(ms, block); return { identity, owner, source: s, regime, idleCashRaw: cash, historicalOwnerSharesRaw: null, fixedCurrentStockConversion: { method: 'native_preview_redeem_fixed_current_shares' as const, source: s, probeSharesRaw: '300', asset: identity.asset, assetDecimals: 18, shareDecimals: 18, assetsRaw: ea } } }
  return { identity, owner, currentSource: source(NOW, 1000), currentRegime: regime, currentSharesRaw: '300', currentIdleCashRaw: '0', currentFullEaRaw: '260', asOfMs: NOW, horizonMs: 64000, requestedRaw: '129', competingMRaw: null, donors: [{ id: 'original-pair', start: point(NOW - 2000, 100, '0', '260'), end: point(NOW - 1000, 200, '4', '256') }] }
}
const usable = (input: MorphoV2IdleJointStockProjectionInput) => { const process = buildMorphoV2IdleJointStockProjection(input); expect(process).not.toBeNull(); const donor = process!.scenarios[0]; expect(donor.status).toBe('usable'); if (donor.status !== 'usable') throw Error('fixture'); return { process: process!, donor } }
describe('v1 analytical donor duration integration', () => {
  it('retains a hidden reopening and two episodes that the 65-checkpoint path misses', () => {
    const { process, donor } = usable(fixture()), a = donor.modeledShortageWindows!
    expect(donor.sampledTimeline.checkpoints.every(p => BigInt(p.shortfallRaw) > 0n)).toBe(true)
    expect(a.adequacyWindow).toEqual({ firstIntegerAdequateMs: 32250, lastIntegerAdequateMs: 32750 })
    expect(a.windows.map(w => w.modeledDurationMs)).toEqual([{ lowerMs: 32250, upperMs: 32250 }, { lowerMs: 31250, upperMs: 31250 }])
    expect(a.windows.map(w => [w.leftCensored, w.rightCensored])).toEqual([[true, false], [false, true]])
    expect(donor.historicalOwnedEntitlementAssetRaw).toBeNull(); expect(process.competingMRaw).toBeNull()
    expect(a.guaranteedDurationMs).toBeNull(); expect(a.actualHistoricalContinuousDuration).toBe(false)
    // Presentation-only fixture: this object issues no original receipt or app authority.
    const view = morphoIdleAnalyticalConditionMetrics({ issuedAtMs: NOW, process } as MorphoV2IdleJointHolderForecast)!
    expect(view.conditionWindow).toBe('2026-10-10 12:00:32.250 UTC → 2026-10-10 12:00:32.750 UTC')
    expect(view.episodes).toHaveLength(2)
    expect(view.episodes[0]).toMatchObject({ onset: 'Open start · at issue', duration: '≥32s · open', withinHorizon: '32–33s within horizon' })
    expect(view.episodes[1]).toMatchObject({ recovery: 'Open recovery · at horizon', duration: '≥31s · open', withinHorizon: '31–32s within horizon' })
  })
  it('keeps non-minute issue clocks and fractional reopenings distinct from adequate instants', () => {
    const input = fixture(); input.asOfMs = NOW + 123
    // Native block time stays second-granular. With one raw unit/ms, source age is 123ms;
    // Q and source Ea put the issue-relative adequate window at 32250..32750ms.
    input.currentFullEaRaw = '65246'; input.requestedRaw = '32373'
    input.donors[0].end.idleCashRaw = '1000'
    input.donors[0].start.fixedCurrentStockConversion.assetsRaw = '66000'
    input.donors[0].end.fixedCurrentStockConversion.assetsRaw = '65000'
    const { process } = usable(input)
    expect(process.sourceAgeMs).toBe(123)
    const scenario = process.scenarios[0]
    if (scenario.status !== 'usable') throw Error('fixture')
    expect(scenario.modeledShortageWindows?.adequacyWindow).toEqual({ firstIntegerAdequateMs: 32250, lastIntegerAdequateMs: 32750 })
    expect(morphoIdleAnalyticalConditionMetrics({ issuedAtMs: input.asOfMs, process } as MorphoV2IdleJointHolderForecast)?.conditionWindow).toBe('2026-10-10 12:00:32.373 UTC → 2026-10-10 12:00:32.873 UTC')
    const modeled = process.scenarios[0]
    if (modeled.status !== 'usable' || !modeled.modeledShortageWindows) throw Error('fixture')
    // Formatter controls keep the original rational model fields intact; they mint no receipt.
    const analytical = modeled.modeledShortageWindows
    const fraction = (n: string, d = '1') => ({ numerator: n, denominator: d })
    const withExact = (start: ReturnType<typeof fraction>, end: ReturnType<typeof fraction>, integer: typeof analytical.adequacyWindow) => ({ issuedAtMs: input.asOfMs, process: { ...process, scenarios: [{ ...modeled, modeledShortageWindows: { ...analytical, exactAdequacyWindow: { start, end }, adequacyWindow: integer } }] } } as MorphoV2IdleJointHolderForecast)
    const fractional = morphoIdleAnalyticalConditionMetrics(withExact(fraction('1', '3'), fraction('2', '3'), null))!
    expect(fractional.conditionWindow).toBe('<1 ms window · location bound 2026-10-10 12:00:00.123 UTC–2026-10-10 12:00:00.124 UTC')
    expect(fractional.conditionWindow).not.toContain('No adequate interval')
    const instant = morphoIdleAnalyticalConditionMetrics(withExact(fraction('1'), fraction('1'), { firstIntegerAdequateMs: 1, lastIntegerAdequateMs: 1 }))!
    expect(instant.conditionWindow).toBe('Adequate instant · 2026-10-10 12:00:00.124 UTC')
    expect(instant.conditionWindow).not.toContain('→')
  })
  it('uses raw source stocks with age and reserve once, without subtracting Q from both prongs', () => {
    const input = fixture(); input.currentIdleCashRaw = '10'; input.currentFullEaRaw = '100'; input.requestedRaw = '8'; input.competingMRaw = '1'; input.asOfMs = NOW + 1000; input.horizonMs = 8000
    input.donors[0].start.source = source(NOW - 6000, 100); input.donors[0].start.fixedCurrentStockConversion.source = input.donors[0].start.source
    input.donors[0].end.source = source(NOW - 3000, 200); input.donors[0].end.fixedCurrentStockConversion.source = input.donors[0].end.source
    input.donors[0].start.idleCashRaw = '10'; input.donors[0].end.idleCashRaw = '9'
    input.donors[0].start.fixedCurrentStockConversion.assetsRaw = '100'; input.donors[0].end.fixedCurrentStockConversion.assetsRaw = '100'
    const { donor } = usable(input), a = donor.modeledShortageWindows!
    expect(a.adequacyWindow).toEqual({ firstIntegerAdequateMs: 0, lastIntegerAdequateMs: 2000 })
    expect(a.windows[0].exactStart).toEqual({ numerator: '2000', denominator: '1' })
    expect(a.windows[0].modeledDurationMs).toEqual({ lowerMs: 6000, upperMs: 6000 })
  })
  it('retains an all-adequate horizon without inventing a shortage episode', () => {
    const input = fixture(); input.currentIdleCashRaw = '200'; input.currentFullEaRaw = '200'
    input.donors[0].end.idleCashRaw = input.donors[0].start.idleCashRaw
    input.donors[0].end.fixedCurrentStockConversion.assetsRaw = input.donors[0].start.fixedCurrentStockConversion.assetsRaw
    const { process, donor } = usable(input)
    expect(donor.modeledShortageWindows).toMatchObject({ neverInsufficient: true, windows: [], adequacyWindow: { firstIntegerAdequateMs: 0, lastIntegerAdequateMs: 64000 } })
    expect(morphoIdleAnalyticalConditionMetrics({ issuedAtMs: NOW, process } as MorphoV2IdleJointHolderForecast)?.episodes).toEqual([])
  })
  it('keeps zero-Q math compatible and overflowing positive-Q projections censored', () => {
    const input = fixture(); input.requestedRaw = '0'; expect(usable(input).donor.modeledShortageWindows).toBeNull()
    input.requestedRaw = '129'; input.currentFullEaRaw = ((1n << 256n) - 1n).toString(); input.donors[0].end.fixedCurrentStockConversion.assetsRaw = '264'
    const p = buildMorphoV2IdleJointStockProjection(input)!
    expect(p.scenarios[0]).toEqual(expect.objectContaining({ status: 'censored', reason: 'projected_stock_uint256_overflow' }))
    expect(p.descriptive.headline).toBeNull()
  })
})
