import { describe, expect, it } from 'vitest'
import {
  buildConditionalRouteProngOutlook as build,
  selectedConditionalRouteProngOutlook as select,
  type ConditionalRouteProng,
  type ConditionalRouteProngOutlookInput,
} from '@/lib/carry/conditionalRouteProngOutlook'
const A = { assetAddress: '0x' + 'a'.repeat(40), decimals: 6 }
const B = { assetAddress: '0x' + 'b'.repeat(40), decimals: 18 }
const issueAtUtc = '2026-10-10T12:00:00.000Z'
const source = { sourceAtUtc: '2026-10-10T11:50:00.000Z', readAtUtc: issueAtUtc, provenanceRef: 'current:block' }
function prong(key = 'cash', kind: ConditionalRouteProng['kind'] = 'cash', value = '200'): ConditionalRouteProng {
  const unit = kind === 'cash' ? 'native_underlying_cash' : kind === 'entitlement' ? 'qualified_holder_entitlement' : 'qualified_ticket_funding'
  const channel = { key, assetAddress: A.assetAddress, decimals: A.decimals, unit, negativeHandling: 'clamp_zero' as const }
  return {
    key, kind, evidence: 'observed', asset: A, unit, source, provenance: ['qualified:capacity'],
    assumptions: ['unchanged authority'], exclusions: [], capacityRaw: value,
    unchangedRegimeAssumption: null, jointHistoryProvenanceRef: 'qualified:joint-bundle',
    transformation: { outputAsset: A, outputUnit: 'final_asset_capacity', numeratorRaw: '1', denominatorRaw: '1',
      provenanceRef: 'native:identity', assumptions: ['unchanged conversion'] },
    timeProcessInput: {
      channels: [channel], observations: [
        { sourceAtUtc: '2026-10-10T09:00:00.000Z', availableAtUtc: '2026-10-10T11:00:00.000Z', regime: 'route', channels: [channel], valuesByChannel: { [key]: '300' }, provenanceRef: 'actual:1' },
        { sourceAtUtc: '2026-10-10T10:00:00.000Z', availableAtUtc: '2026-10-10T11:00:00.000Z', regime: 'route', channels: [channel], valuesByChannel: { [key]: '240' }, provenanceRef: 'actual:2' },
      ], outputAsset: A, measurementRule: 'qualified_native_capacity',
      current: { ...source, regime: 'route', valuesByChannel: { [key]: value } },
      issueAtUtc, requestedRaw: '100', horizonHours: 1, maxHistoricalGapSeconds: 7200,
    },
  }
}
function input(prongs = [prong()]): ConditionalRouteProngOutlookInput {
  return { routeKey: 'all-venue-adapter-test', destination: 'qualified:destination', issueAtUtc,
    requestedRaw: '100', horizonHours: 1, outputAsset: A, holderEntitlementRaw: null,
    requiredProngKeys: prongs.map((p) => p.key), prongs,
    competition: { netHistoryIncludesCompetingFlow: true, additionalGrossReserveRaw: '0', reserveBasis: 'none', provenanceRef: 'net:flow' } }
}
const qualified = () => true // Production qualifier must bind actual evidence, ownership and transformations.
describe('private conditional route prong outlook composition', () => {
  it('uses two real points, source age, weakest prong, Q once and additional reserve once', () => {
    const x = input([prong(), prong('funding', 'queue_funding', '150')])
    x.competition = { ...x.competition, additionalGrossReserveRaw: '10', reserveBasis: 'additional_competition_excluded_from_net_history' }
    const result = build(x, qualified)!
    const cash = result.prongs[0].process!
    expect(cash.scenarios).toHaveLength(1)
    expect(cash.scenarios[0].points.find((p) => p.atUtc === issueAtUtc)!.capacityRaw).toBe('190')
    expect(result.route.currentCapacityRaw).toBe('140')
    // Funding 150 - 70 of net shrinkage (source age + 1h), then additional reserve 10, then Q 100.
    expect(result.route.process!.scenarios[0].targetHeadroomRaw).toBe('-30')
    expect(result.route.process!.scenarios[0].sampledShortfalls[0].rightCensored).toBe(true)
    expect(result.route.process!.continuousPathKnown).toBe(false)
    expect(result.holderEntitlementRaw).toBeNull()
    expect(result.holderExecutableExit).toBe(false)
    expect(result.calibratedProbability).toBe(false)
  })
  it('retains cash outlook when entitlement and ticket funding are unknown', () => {
    const missing = prong('ticket', 'queue_funding')
    Object.assign(missing, { evidence: 'unknown', capacityRaw: null, timeProcessInput: null })
    const x = input([prong(), missing])
    x.requiredProngKeys.push('entitlement')
    const result = build(x, qualified)!
    expect(result.prongs[0].process).not.toBeNull()
    expect(result.prongs[1].capacityRaw).toBeNull()
    expect(result.route.blockers).toEqual(['ticket', 'entitlement'])
    expect(result.route.process).toBeNull()
    expect(result.route.currentCapacityRaw).toBeNull()
  })
  it('does not join different final assets or different raw unit decimals', () => {
    const incompatible = prong('other')
    incompatible.transformation!.outputAsset = B
    const r = build(input([prong(), incompatible]), qualified)!
    expect(r.prongs[0].process).not.toBeNull()
    expect(r.prongs[1].outlookStatus).toBe('unjoined_native_capacity')
    expect(r.route.currentCapacityRaw).toBeNull()
    incompatible.transformation!.outputAsset = { ...A, decimals: 18 }
    expect(build(input([prong(), incompatible]), qualified)!.route.currentCapacityRaw).toBeNull()
  })
  it('requires a qualified leg transformation and rejects raw debt balance as capacity', () => {
    const x = input()
    x.prongs[0].transformation = null
    expect(build(x, qualified)!.route.currentCapacityRaw).toBeNull()
    const wrong = input()
    wrong.prongs[0].kind = 'debt_headroom'
    expect(build(wrong, qualified)).toBeNull()
    expect(build(input(), () => false)).toBeNull()
  })
  it('preserves unknown additional M versus zero, keeping individual forecasts', () => {
    const x = input()
    x.competition.reserveBasis = 'additional_competition_excluded_from_net_history'
    x.competition.additionalGrossReserveRaw = null
    const unknown = build(x, qualified)!
    expect(unknown.prongs[0].process).not.toBeNull()
    expect(unknown.route.currentCapacityRaw).toBeNull()
    expect(unknown.route.blockers).toContain('additional_competition_unknown')
    x.competition.additionalGrossReserveRaw = '0'
    expect(build(x, qualified)!.route.currentCapacityRaw).toBe('200')
    x.competition.additionalGrossReserveRaw = '10'
    x.competition.reserveBasis = 'none'
    expect(build(x, qualified)).toBeNull()
  })
  it('allows explicit new venue mechanics without fabricating donor rows or bands', () => {
    const p = prong()
    p.timeProcessInput = null
    expect(build(input([p]), qualified)!.prongs[0].mechanical).toBeNull()
    p.evidence = 'assumed'
    p.unchangedRegimeAssumption = 'Capacity remains unchanged over this horizon; no net-flow history exists.'
    const r = build(input([p]), qualified)!
    expect(r.prongs[0].timeProcessInput).toBeNull()
    expect(r.prongs[0].mechanical!.actualHistoricalObservationCount).toBe(0)
    expect(r.route.mechanical!.headroomRaw).toBe('100')
    expect(r.route.process).toBeNull()
    expect(r.route.mechanical!.continuousPathKnown).toBe(false)
  })
  it('does not invent joint provenance or correlations from matching timestamps', () => {
    const p = prong('second')
    p.jointHistoryProvenanceRef = 'different:joint-bundle'
    const r = build(input([prong(), p]), qualified)!
    expect(r.prongs.every((p) => p.process !== null)).toBe(true)
    expect(r.route.process).toBeNull()
    expect(r.route.currentCapacityRaw).toBe('200')
    p.jointHistoryProvenanceRef = 'qualified:joint-bundle'
    p.timeProcessInput!.current.sourceAtUtc = '2026-10-10T11:51:00.000Z'
    p.source = { ...source, sourceAtUtc: p.timeProcessInput!.current.sourceAtUtc }
    const unaligned = build(input([prong(), p]), qualified)!
    expect(unaligned.prongs.every((p) => p.process !== null)).toBe(true)
    expect(unaligned.route.process).toBeNull()
  })
  it('rebuilds JSON-safe inputs and rejects edited results or expired source evidence', () => {
    const x = input(), value = build(x, qualified)!
    const serialized = JSON.parse(JSON.stringify(value))
    expect(select(serialized, { input: x, asOfMs: Date.parse(issueAtUtc) }, qualified)).toEqual(value)
    serialized.prongs[0].process.scenarios[0].points[0].capacityRaw = '999999'
    expect(select(serialized, { input: x, asOfMs: Date.parse(issueAtUtc) }, qualified)).toBeNull()
    expect(select(value, { input: x, asOfMs: Date.parse(issueAtUtc) + 21 * 60000 }, qualified)).toBeNull()
  })
})
