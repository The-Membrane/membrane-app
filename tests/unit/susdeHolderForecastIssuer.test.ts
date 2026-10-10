import { describe, expect, it } from 'vitest'

import {
  issueSusdeCurrentProtocolCapacityEvidence,
  readSusdeCurrentProtocolOrigin,
} from '@/lib/carry/susdeCurrentProtocolCapacity'
import {
  issueSusdeHolderForecastEnvelope,
  issueSusdeHolderForecastFromNativeOrigins,
} from '@/lib/carry/server/susdeHolderForecastIssuer'
import { SUSDE_HOLDER_FORECAST_HORIZONS } from '@/lib/carry/susdeHolderForecastEnvelope'
import { susdePinnedJointHistory } from '@/lib/carry/susdeJointHistoryPins'
import {
  syntheticSusdeClient,
  syntheticSusdeExpected,
  SUSDE_SYNTHETIC_NOW as NOW,
} from '../fixtures/susdeCurrentProtocolCapacity'

async function nativePair(expected = syntheticSusdeExpected()) {
  const a = syntheticSusdeClient(expected),
    b = syntheticSusdeClient(expected),
    first = await readSusdeCurrentProtocolOrigin(a, expected, { now: () => NOW }),
    second = await readSusdeCurrentProtocolOrigin(b, expected, { now: () => NOW + 10 })
  return {
    a,
    b,
    expected,
    origins: [
      { origin: 'first.example', observation: first! },
      { origin: 'second.example', observation: second! },
    ],
    names: ['first.example', 'second.example'],
  }
}

describe('server native sUSDe holder forecast issuance, synthetic states only', () => {
  it('issues every existing horizon at one source, original Q and fixed issuance without more reads', async () => {
    const p = await nativePair(),
      issued = issueSusdeHolderForecastFromNativeOrigins(p.origins, p.expected, NOW + 20)!
    expect(issued).not.toBeNull()
    expect(p.a.request).toHaveBeenCalledTimes(12)
    expect(p.b.request).toHaveBeenCalledTimes(12)
    const e = issued.envelope
    expect(e.supportedHorizonHours).toEqual([1, 24, 48, 168])
    expect(e.issueAtUtc).toBe(new Date(NOW + 20).toISOString())
    expect(e.sourceProofValidUntil).toBe(
      new Date(Date.parse(p.expected.source.blockTime) + 1800000).toISOString(),
    )
    expect(e.source).toEqual(p.expected.source)
    expect(e.inputCommon.current.readAtUtc).toBe(new Date(NOW + 10).toISOString())
    expect(e.inputCommon.current.evidence).toEqual(issued.evidence)
    expect(e.inputCommon.current.captureReceiptSha256).toBe(e.currentReceiptSha256)
    expect(e.inputCommon.history).toEqual(susdePinnedJointHistory())
    expect(e.historyCaptureSha256).toBe(susdePinnedJointHistory().captureFileSha256)
    for (const h of SUSDE_HOLDER_FORECAST_HORIZONS) {
      const m = e.modelsByHorizonHours[h]
      expect(m).not.toHaveProperty('input')
      expect(m.issueAtUtc).toBe(e.issueAtUtc)
      expect(m.targetAtUtc).toBe(new Date(NOW + 20 + h * 3600000).toISOString())
      expect(m.originalRequestedRaw).toBe(p.expected.requestedRaw)
      expect(m.owner).toBe(p.expected.owner)
      expect(m.active.fullActiveEntitlementRaw).toBe(p.expected.activeEntitlementRaw)
      expect(m.active.funding.horizonHours).toBe(h)
      expect(m.active.funding.input.current.provenanceRef).toBe(e.currentReceiptSha256)
      expect(m.pending.effectiveWholePayoutRaw).toBe(p.expected.pendingAssetsRaw)
      expect(m.newCooldown?.postInitiation).toMatchObject({
        vaultCashRaw: '8000000',
        siloCashRaw: '4000000',
        activeEntitlementRaw: null,
        activeEntitlementUpperBoundRaw: '4500000',
        pendingAssetsRaw: '3500000',
        storedCooldownEndUtc: new Date(Date.parse(e.source.blockTime) + 86400000).toISOString(),
      })
      expect(m).toMatchObject({
        executable: false,
        fullHolderAbility: false,
        forecastValidated: false,
        prospectiveValidated: false,
        metadata: { calibratedProbability: false, sampledEpisodesAreFundingOnly: true },
      })
    }
    expect(e).toMatchObject({
      executable: false,
      fullHolderAbility: false,
      forecastValidated: false,
      prospectiveValidated: false,
      calibratedProbability: false,
    })
    expect(Object.isFrozen(e)).toBe(true)
    expect(Object.isFrozen(e.inputCommon.current.evidence)).toBe(true)
    expect(Object.isFrozen(e.modelsByHorizonHours[168].active.funding.scenarios[0].points)).toBe(
      true,
    )
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
  })

  it('denies replayed copies and success flags, even with the correct self hash', async () => {
    const p = await nativePair(),
      issued = issueSusdeHolderForecastFromNativeOrigins(p.origins, p.expected, NOW + 20)!
    expect(
      issueSusdeHolderForecastEnvelope(
        structuredClone(issued.evidence),
        p.expected,
        p.names,
        NOW + 20,
      ),
    ).toBeNull()
    expect(
      issueSusdeHolderForecastEnvelope(
        { ...issued.evidence, approved: true },
        p.expected,
        p.names,
        NOW + 20,
      ),
    ).toBeNull()
    const separatelyIssued = issueSusdeCurrentProtocolCapacityEvidence(
      p.origins,
      p.expected,
      NOW + 20,
    )
    expect(
      issueSusdeHolderForecastEnvelope(separatelyIssued, p.expected, p.names, NOW + 20),
    ).toBeNull()
    const fakeOrigins = structuredClone(p.origins)
    expect(issueSusdeHolderForecastFromNativeOrigins(fakeOrigins, p.expected, NOW + 20)).toBeNull()
  })

  it.each([
    'owner',
    'requestedRaw',
    'activeSharesRaw',
    'activeEntitlementRaw',
    'pendingAssetsRaw',
  ] as const)(
    'binds exact original %s rather than approving a changed whole current object',
    async (key) => {
      const p = await nativePair(),
        issued = issueSusdeHolderForecastFromNativeOrigins(p.origins, p.expected, NOW + 20)!,
        changed = { ...p.expected, [key]: key === 'owner' ? '0x' + 'b'.repeat(40) : '42' }
      expect(
        issueSusdeHolderForecastEnvelope(issued.evidence, changed, p.names, NOW + 20),
      ).toBeNull()
    },
  )

  it('binds source, origin identity, acquisition and issuance clocks', async () => {
    const p = await nativePair(),
      issued = issueSusdeHolderForecastFromNativeOrigins(p.origins, p.expected, NOW + 20)!
    expect(
      issueSusdeHolderForecastEnvelope(issued.evidence, p.expected, p.names, NOW + 20),
    ).toEqual(issued.envelope)
    for (const at of [NOW + 19, NOW + 21, NOW + 1800001, NaN])
      expect(issueSusdeHolderForecastEnvelope(issued.evidence, p.expected, p.names, at)).toBeNull()
    expect(
      issueSusdeHolderForecastEnvelope(
        issued.evidence,
        p.expected,
        ['second.example', 'first.example'],
        NOW + 20,
      ),
    ).toBeNull()
    expect(
      issueSusdeHolderForecastEnvelope(
        issued.evidence,
        { ...p.expected, source: { ...p.expected.source, blockHash: '0x' + 'c'.repeat(64) } },
        p.names,
        NOW + 20,
      ),
    ).toBeNull()
  })

  it('does not issue from expired sources, same-client origins, or available-before-read clocks', async () => {
    const p = await nativePair()
    expect(
      issueSusdeHolderForecastFromNativeOrigins(p.origins, p.expected, NOW + 1800001),
    ).toBeNull()
    expect(issueSusdeHolderForecastFromNativeOrigins(p.origins, p.expected, NOW + 9)).toBeNull()
    expect(
      issueSusdeHolderForecastFromNativeOrigins(
        [p.origins[0], { origin: 'second.example', observation: p.origins[0].observation }],
        p.expected,
        NOW + 20,
      ),
    ).toBeNull()
  })

  it('separates independent Ea, whole-M pending funding and current exact-Q initiation success', async () => {
    const expected = { ...syntheticSusdeExpected(), initiationStatus: 'evm_revert' as const },
      p = await nativePair(expected),
      issued = issueSusdeHolderForecastFromNativeOrigins(p.origins, expected, NOW + 20)!
    for (const h of SUSDE_HOLDER_FORECAST_HORIZONS) {
      const m = issued.envelope.modelsByHorizonHours[h]
      expect(m.active.fullActiveEntitlementRaw).toBe('5500000')
      expect(m.pending.effectiveWholePayoutRaw).toBe('2500000')
      expect(m.newCooldown).toBeNull()
      for (const scenario of m.pending.funding!.scenarios)
        for (const point of scenario.points) expect(['0', '2500000']).toContain(point.capacityRaw)
    }
  })
})
