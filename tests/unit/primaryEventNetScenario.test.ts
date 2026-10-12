import { describe, it, expect } from 'vitest'
import { buildPrimaryEventNetScenario, matchingPrimaryEventNetScenario } from '@/lib/carry/primaryEventNetScenario'
const identity = { routeKey: 'USDC → supply on Aave V3', destination: '0x' + 'a'.repeat(40), asset: '0x' + 'b'.repeat(40), assetDecimals: 6 }
const issue = '2026-10-12T12:00:00.000Z'
function input(): Parameters<typeof buildPrimaryEventNetScenario>[0] {
  return { outlook: { identity, owner: '0x' + 'c'.repeat(40), requestedRaw: '10', fullEntitlementRaw: '80',
    additionalCompetitionRaw: '20', issuedAtUtc: issue, horizonHours: 24,
    currentSource: { ...identity, cashRaw: '100', block: '123', blockHash: '0x' + 'd'.repeat(64), blockTime: issue, readAt: issue,
      chainId: 1, sourceKind: 'live_read_only_two_origin_finalized' } } as any,
    version: 'aave_v3_ethereum_core', event: { eventId: 'primary-1', title: 'ReserveFactorChanged',
      affected: { ...identity, version: 'aave_v3_ethereum_core' }, primarySource: { kind: 'native_log',
        url: 'https://etherscan.io/tx/0x' + 'e'.repeat(64), contentSha256: 'f'.repeat(64), reviewRef: 'review:1' },
      occurredAtUtc: '2026-10-11T00:00:00.000Z', publishedAtUtc: null,
      fetchedAtUtc: issue, availableAtUtc: issue }, assumption: { eventId: 'primary-1', netDeltaRaw: '-10',
        denominatorMs: 86400000, reviewRef: 'declared:1', interpretation: 'conditional_assumption_not_estimated_news_effect' } }
}
describe('reviewed primary event declared NET scenario', () => {
  it('replaces NET, subtracts additional M separately and Q exactly once', () => {
    const i = input(), r = buildPrimaryEventNetScenario(i, v => v === i)!
    expect(r.targetCashRaw).toBe('90'); expect(r.targetCapacityProxyRaw).toBe('70'); expect(r.targetHeadroomRaw).toBe('60')
    expect(r.causalNewsEffect).toBe(false); expect(r.holderExecutableExit).toBe(false)
    expect(matchingPrimaryEventNetScenario(r, i.outlook, i.version)).toBe(r)
    expect(matchingPrimaryEventNetScenario(r, { ...i.outlook, owner: '0x' + '1'.repeat(40) }, i.version)).toBeNull()
    expect(matchingPrimaryEventNetScenario({ ...r, targetHeadroomRaw: '61' }, i.outlook, i.version)).toBeNull()
  })
  it('rejects copied authority, future availability, wrong version and out-of-range cash', () => {
    const i = input(); expect(buildPrimaryEventNetScenario(structuredClone(i), v => v === i)).toBeNull()
    for (const change of [(x: typeof i) => x.event.availableAtUtc = '2026-10-13T00:00:00.000Z',
      (x: typeof i) => x.event.affected.version = 'morpho_v2', (x: typeof i) => x.event.affected.asset = '0x' + '1'.repeat(40),
      (x: typeof i) => x.assumption.netDeltaRaw = '-1000', (x: typeof i) => x.event.primarySource.url = 'http://example.com']) {
      const bad = input(); change(bad); expect(buildPrimaryEventNetScenario(bad, () => true)).toBeNull()
    }
  })
})
