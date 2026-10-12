import { describe, it, expect } from 'vitest'
import { readAavePrimaryEventFacts } from '@/lib/carry/aavePrimaryEventFacts.server'
const q = { routeKey: 'USDC → supply on Aave V3', destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  payoutAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', assetDecimals: 6, requestedRaw: '10000', horizonHours: 48 }
describe('genuine pinned Aave primary governance facts', () => {
  it('retains occurrence and collection clocks, exact affected identity and primary URLs', () => {
    const r = readAavePrimaryEventFacts(q, Date.parse('2026-10-12T12:00:00Z'))
    expect(r.status).toBe('recorded_primary_facts'); expect(r.facts.length).toBeGreaterThan(0)
    for (const f of r.facts) {
      expect(f.affected.asset).toBe(q.payoutAsset); expect(f.affected.destination).toBe(q.destination)
      expect(f.affected.version).toBe('aave_v3_ethereum_core')
      expect(f.primarySource.url).toMatch(/^https:\/\/etherscan.io\/tx\/0x[0-9a-f]{64}#eventlog$/)
      expect(Date.parse(f.occurredAtUtc)).toBeLessThanOrEqual(Date.parse(f.availableAtUtc))
      expect(f.publishedAtUtc).toBeNull()
    }
    expect(r.scenario).toBeNull(); expect(r.currentConfigurationKnown).toBe(false)
  })
  it('does not use a future collection or cross-bind another asset, version or contract', () => {
    expect(readAavePrimaryEventFacts(q, Date.parse('2026-10-11T12:00:00Z')).facts).toEqual([])
    for (const bad of [{ ...q, payoutAsset: '0x' + '1'.repeat(40) }, { ...q, destination: '0x' + '2'.repeat(40) },
      { ...q, routeKey: 'USDC → MorphoVaultV2' }, { ...q, assetDecimals: 18 }])
      expect(readAavePrimaryEventFacts(bad, Date.parse('2026-10-12T12:00:00Z')).status).toBe('subject_not_enrolled')
  })
})
