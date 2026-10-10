import { describe, expect, it } from 'vitest'
import {
  retrospectiveFundingFold,
  type RetrospectiveFundingInput,
} from '@/lib/venueForecast/retrospectiveFundingBacktest'
const start = Date.parse('2026-09-01T00:00:00.000Z')
const iso = (h: number) => new Date(start + h * 3600000).toISOString()
function fixture(): RetrospectiveFundingInput {
  return {
    analysisAtUtc: iso(100),
    simulatedIssueAtUtc: iso(48),
    horizonHours: 24,
    outcomeToleranceSeconds: 0,
    maxGapSeconds: 91800,
    channels: [
      { key: 'vault', assetAddress: '0x' + 'a'.repeat(40), decimals: 18 },
      { key: 'silo', assetAddress: '0x' + 'a'.repeat(40), decimals: 18 },
    ],
    history: [
      [100, 80],
      [130, 50],
      [200, 100],
      [250, 70],
    ].map(([vault, silo], anchor) => ({
      anchor,
      sourceAtUtc: iso(anchor * 24),
      availableAtUtc: iso(90),
      provenanceRef: `immutable:${anchor}`,
      valuesByChannel: { vault: String(vault), silo: String(silo) },
    })),
    sourceIndex: 2,
    outcomeIndex: 3,
    thresholdsByChannel: { vault: ['0', '240'] },
  }
}
const run = (f = fixture()) => retrospectiveFundingFold(f, () => true)
describe('offline retrospective funding reconstruction', () => {
  it('scores actual independent held-out truth and persistence using strictly earlier donors', () => {
    const r = run()
    expect(r.status).toBe('scored')
    if (r.status !== 'scored') return
    expect(r.scenarios).toEqual([
      {
        donorStartAnchor: 0,
        donorEndAnchor: 1,
        donorEndAtUtc: iso(24),
        predictionByChannel: { vault: '230', silo: '70' },
      },
    ])
    expect(r.comparisonByChannel.vault).toMatchObject({
      actualRaw: '250',
      signedErrorRaw: '-20',
      persistenceSignedErrorRaw: '-50',
      absoluteErrorRaw: '20',
      persistenceAbsoluteErrorRaw: '50',
    })
    const changed = fixture()
    changed.history[3].valuesByChannel = { vault: '900', silo: '1' }
    const later = run(changed)
    expect(later.status).toBe('scored')
    if (later.status === 'scored') expect(later.scenarios).toEqual(r.scenarios)
    expect(r.comparisonByChannel.vault.thresholdCoverage[0]).toMatchObject({
      diagnosticThresholdRaw: '0',
      holderQ: false,
      actualCovers: true,
    })
    expect(r.scope).toBe('funding_only')
    expect(r.holderFacts).toBe('holder_facts_unavailable')
  })
  it('separates acquisition at analysis from the simulated issue without rewriting clocks', () => {
    const r = run()
    expect(r.status).toBe('scored')
    if (r.status === 'scored')
      expect(r.acquisitionClocks.every((x) => x.availableAtUtc === iso(90))).toBe(true)
    const f = fixture()
    f.analysisAtUtc = iso(80)
    expect(run(f)).toMatchObject({ status: 'censored', reason: 'history_not_acquired_at_analysis' })
  })
  it('includes source age exactly once and requires outcome at issue plus H', () => {
    const f = fixture()
    f.simulatedIssueAtUtc = iso(49)
    f.horizonHours = 23
    const r = run(f)
    expect(r.status).toBe('scored')
    if (r.status === 'scored') {
      expect(r.sourceAgeSeconds).toBe(3600)
      expect(r.targetAtUtc).toBe(iso(72))
      expect(r.scenarios[0].predictionByChannel.vault).toBe('230')
    }
    f.horizonHours = 24
    expect(run(f)).toMatchObject({ status: 'censored', reason: 'outcome_outside_tolerance' })
    f.outcomeToleranceSeconds = 3600
    expect(run(f).status).toBe('scored')
  })
  it('rejects chronology leaks, missing native provenance, and altered pin authentication', () => {
    const f = fixture()
    f.history[1].sourceAtUtc = iso(49)
    expect(run(f)).toMatchObject({ status: 'censored', reason: 'chronological_leak_or_order' })
    const missing = fixture()
    missing.history[0].provenanceRef = ''
    expect(run(missing)).toMatchObject({ status: 'censored', reason: 'invalid_history' })
    expect(retrospectiveFundingFold(fixture(), () => false)).toMatchObject({
      reason: 'history_authentication_failed',
    })
    const original = fixture()
    const result = retrospectiveFundingFold(original, (input) => {
      input.history[3].valuesByChannel.vault = '0'
      return true
    })
    expect(result.status).toBe('scored')
    if (result.status === 'scored') expect(result.comparisonByChannel.vault.actualRaw).toBe('250')
    expect(original.history[3].valuesByChannel.vault).toBe('250')
  })
  it('censors donor and outcome gaps rather than silently improving the donor cohort', () => {
    const f = fixture()
    f.history[1].anchor = 2
    f.history[2].anchor = 3
    f.history[3].anchor = 4
    expect(run(f)).toMatchObject({ reason: 'donor_gap' })
    const g = fixture()
    g.history[3].anchor = 4
    expect(run(g)).toMatchObject({ reason: 'outcome_gap' })
  })
  it('uses signed native floor and physical zero across paired channels and censors overflow', () => {
    const f = fixture()
    f.history[0].valuesByChannel.silo = '1000'
    const r = run(f)
    expect(r.status).toBe('scored')
    if (r.status === 'scored') expect(r.scenarios[0].predictionByChannel.silo).toBe('0')
    const g = fixture()
    g.history[1].valuesByChannel.vault = String((1n << 256n) - 1n)
    expect(run(g)).toMatchObject({ reason: 'native_intermediate_overflow' })
  })
  it('never upgrades unauthenticated holder owner/amount claims into Ea, Q or a holder forecast', () => {
    const f = Object.assign(fixture(), {
      holderFacts: {
        owner: '0x' + 'b'.repeat(40),
        entitlementRaw: '200',
        requestedRaw: '20',
        pendingRaw: '0',
        authenticated: true,
        provenanceRef: 'caller_claim',
      },
    })
    const r = run(f)
    expect(r.status).toBe('scored')
    expect(r.scope).toBe('funding_only')
    expect(r.holderFacts).toBe('holder_facts_unavailable')
    expect(r.probability).toBeNull()
    expect(r).not.toHaveProperty('entitlementRaw')
    expect(r).not.toHaveProperty('requestedRaw')
  })
  it('floors negative fractional native deltas and rejects nonlatest sources', () => {
    const f = fixture()
    f.simulatedIssueAtUtc = iso(48)
    f.horizonHours = 12
    f.history[3].sourceAtUtc = iso(60)
    f.history[0].valuesByChannel.vault = '100'
    f.history[1].valuesByChannel.vault = '99'
    const r = run(f)
    expect(r.status).toBe('scored')
    if (r.status === 'scored') expect(r.scenarios[0].predictionByChannel.vault).toBe('199')
    const later = fixture()
    later.simulatedIssueAtUtc = iso(72)
    expect(run(later)).toMatchObject({ reason: 'source_not_latest_at_issue' })
  })
})
