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
    expect(r.conditionalScenarios.length).toBeGreaterThan(0)
    expect(new Set(r.conditionalScenarios.map(s => s.parameter)).size).toBe(r.conditionalScenarios.length)
    for (const s of r.conditionalScenarios) {
      expect(s.sourceEvent.affected.asset).toBe(q.payoutAsset)
      expect(s.sourceEvent.originalArgs[s.parameter === 'liquidationThresholdBps' ? 'liquidationThreshold' : s.parameter]).toBe(s.value)
      expect(s.currentConfigurationKnown).toBe(false)
      expect(s.targetAtUtc).toBe('2026-10-14T12:00:00.000Z')
      expect(s.initialDepositUpperBoundRaw).toBe(s.parameter !== 'liquidationThresholdBps' && s.value ? '0' : null)
      expect(s.holderExitUpperBoundRaw).toBe(s.parameter === 'paused' && s.value ? '0' : null)
      const displayedSameParameter = r.facts.filter(f => f.title === s.sourceEvent.title)
      for (const f of displayedSameParameter) expect(BigInt(f.block)).toBeLessThanOrEqual(BigInt(s.sourceEvent.block))
    }
    const threshold = r.conditionalScenarios.find(s => s.parameter === 'liquidationThresholdBps')!
    expect(threshold.value).toBe('7800')
    expect(threshold.parameter).toBe('liquidationThresholdBps')
    if (threshold.parameter === 'liquidationThresholdBps') {
      expect(threshold.collateralValueRule.denominatorBps).toBe('7800')
      expect(threshold.collateralValueRule.valueUnit).toBe('same_quote_currency_value_not_asset_raw')
      expect(threshold.borrowerStateKnown).toBe(false); expect(threshold.eModeKnown).toBe(false)
    }
    expect(r.conditionalScenarios.some(s => s.parameter === 'paused' || s.parameter === 'frozen')).toBe(false)
  })
  it('uses the actual latest USDe threshold without substituting its zero LTV', () => {
    const usde = { ...q, routeKey: 'USDe → supply on Aave V3', destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
      payoutAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', assetDecimals: 18 }
    const r = readAavePrimaryEventFacts(usde, Date.parse('2026-10-12T12:00:00Z'))
    const rule = r.conditionalScenarios.find(s => s.parameter === 'liquidationThresholdBps')!
    expect(rule.value).toBe('7500'); expect(rule.sourceEvent.originalArgs.ltv).toBe('0')
    expect(rule.holderExitUpperBoundRaw).toBeNull(); expect(rule.initialDepositUpperBoundRaw).toBeNull()
  })
  it('does not use a future collection or cross-bind another asset, version or contract', () => {
    expect(readAavePrimaryEventFacts(q, Date.parse('2026-10-11T12:00:00Z')).facts).toEqual([])
    expect(readAavePrimaryEventFacts(q, Date.parse('2026-10-11T12:00:00Z')).conditionalScenarios).toEqual([])
    for (const bad of [{ ...q, payoutAsset: '0x' + '1'.repeat(40) }, { ...q, destination: '0x' + '2'.repeat(40) },
      { ...q, routeKey: 'USDC → MorphoVaultV2' }, { ...q, assetDecimals: 18 }])
      expect(readAavePrimaryEventFacts(bad, Date.parse('2026-10-12T12:00:00Z')).status).toBe('subject_not_enrolled')
  })
})
