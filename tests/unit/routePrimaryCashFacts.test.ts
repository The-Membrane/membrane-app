import { describe, it, expect } from 'vitest'
import { loadPinnedAudit } from '../../scripts/research/conditional-cash-time-holdout.mjs'
import { PRIMARY_MEASURED_ROUTE_LINKS, primaryMeasuredSourceLink } from '@/lib/carry/primaryMeasuredSourceLinks'
import { readRoutePrimaryCashFacts } from '@/lib/carry/routePrimaryCashFacts.server'
import { buildNativePrimaryEventImpact } from '@/lib/carry/nativePrimaryEventImpact'
import type { ConditionalSampledCashHistory } from '@/lib/carry/conditionalSampledCashPathProjection'
const audit = loadPinnedAudit(), histories = Object.values(audit.histories) as ConditionalSampledCashHistory[]
const issue = '2026-10-12T12:00:00.000Z', ms = Date.parse(issue)
const question = (h: ConditionalSampledCashHistory) => ({ routeKey: h.identity.routeKey,
  destination: h.identity.destination, payoutAsset: h.identity.asset, assetDecimals: h.identity.assetDecimals,
  requestedRaw: '10000', horizonHours: 48 })
const absent = { status: 'unavailable' as const, reason: 'source_unavailable' as const }
describe('primary measured cash facts exact frozen source linkage', () => {
  it('links all25 frozen groups/all67 destinations, all49 Morpho and separates supplemental USDe', () => {
    expect(PRIMARY_MEASURED_ROUTE_LINKS.filter(r => !r.supplemental)).toHaveLength(25)
    let native = 0, morpho = 0
    for (const h of histories) {
      const link = primaryMeasuredSourceLink(h.identity.routeKey, h.identity.destination)!
      expect(link).not.toBeNull(); expect(link.lane).toBe('native_cash')
      expect(link.versionEvidence).toBe('route_mechanism_label_not_verified_deployed_code_version')
      if (!link.supplemental) native++
      if (link.mechanism === 'morpho_v2') morpho++
    }
    expect(native).toBe(63); expect(morpho).toBe(49)
    for (const e of audit.exclusions) {
      const link = primaryMeasuredSourceLink(e.routeKey, e.destination)!
      expect(link.lane).toBe('foreign_intermediate'); expect(link.conversionRequirements).toHaveLength(3)
      expect(link.holderHeadroomFromIntermediateRawAllowed).toBe(false)
    }
    expect(native + audit.exclusions.length).toBe(67)
    expect(primaryMeasuredSourceLink(histories[0].identity.routeKey, '0x' + '1'.repeat(40))).toBeNull()
  })
  it('serves genuine historical measurements without claiming a current holder quote', () => {
    const h = histories.find(h => h.identity.routeKey === 'USDC → supply on Aave V3')!, q = question(h)
    const r = readRoutePrimaryCashFacts(q, absent, ms)
    expect(r.status).toBe('historical_primary_facts_only'); expect(r.facts).toHaveLength(2)
    expect(r.holderHeadroom).toBeNull(); expect(r.ownerAndFullEntitlementQualified).toBe(false)
    expect(r.conditionalNetScenario?.rate.numeratorRaw).toMatch(/^-/)
    expect(r.conditionalNetScenario?.conditionalCashProxyRaw).toBeNull()
    expect(readRoutePrimaryCashFacts(q, absent, Date.parse('2026-10-02T00:00:00.000Z')).facts).toEqual([])
    expect(readRoutePrimaryCashFacts({ ...q, payoutAsset: '0x' + '1'.repeat(40) }, absent, ms).facts).toEqual([])
  })
  it('keeps contextual aggregate stress distinct from owner/Ea and foreign conversions', () => {
    const h = histories.find(h => h.identity.routeKey === 'USDT → supply on Spark')!, q = question(h)
    const current = { status: 'available' as const, value: { ...q, metric: 'aggregate_cash_raw' as const,
      meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity' as const,
      verification: 'local_hash_chain_replay' as const,
      observations: [{ raw: '1000000000000', block: '27000000', blockHash: '0x' + 'a'.repeat(64), blockTime: issue, sourceId: 'test:synthetic_current' }] } }
    const r = readRoutePrimaryCashFacts(q, current, ms)
    expect(r.status).toBe('historical_and_recorded_aggregate_facts')
    expect(r.conditionalNetScenario?.noQOrAdditionalMDeductedHere).toBe(true)
    expect(r.holderHeadroom).toBeNull()
    const excluded = audit.exclusions[0]
    const foreign = readRoutePrimaryCashFacts({ ...q, routeKey: excluded.routeKey, destination: excluded.destination }, current, ms)
    expect(foreign.status).toBe('foreign_units_require_joint_conversion'); expect(foreign.conditionalNetScenario).toBeNull()
  })
  it('generic original-qualified envelope uses genuine histories and never calls a route family a code proof', () => {
    for (const route of ['USDC → supply on Aave V3', 'USDT → supply on Spark', 'USDC → VaultV2 [USDC]']) {
      const h = histories.find(h => h.identity.routeKey === route)!
      const o = { identity: h.identity, owner: '0x' + 'b'.repeat(40), requestedRaw: '10000', fullEntitlementRaw: '20000',
        additionalCompetitionRaw: '0', horizonHours: 48, issuedAtUtc: issue,
        currentSource: { ...h.identity, sourceKind: 'manifest_bound_ledger', blockTime: issue, readAt: issue,
          block: '27000000', blockHash: '0x' + 'a'.repeat(64), cashRaw: '30000' }, adverseHolderHeadroom: null } as any
      const r = buildNativePrimaryEventImpact(o, (v, history) => v === o && history === h, h)!
      expect(r).not.toBeNull(); expect(r.sourceLinkage.versionEvidence).toBe('route_mechanism_label_not_verified_deployed_code_version')
      expect(r.question.owner).toBe(o.owner); expect(r.facts[1].provenance).toBe('original_manifest_bound_ledger')
      expect(r.holderImpact.currentCapacityProxyRaw).toBe('20000')
      expect(r.holderImpact.currentHeadroomRaw).toBe('10000')
      expect(r.holderImpact.executableCapacity).toBe(false)
      expect(buildNativePrimaryEventImpact(structuredClone(o), v => v === o, h)).toBeNull()
    }
  })
})
