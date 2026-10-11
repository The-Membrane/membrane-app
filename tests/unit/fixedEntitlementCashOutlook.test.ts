import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { loadPinnedAudit } from '../../scripts/research/conditional-cash-time-holdout.mjs'
import { buildFixedEntitlementCashOutlook, type FixedEntitlementCashInput } from '@/lib/carry/fixedEntitlementCashOutlook'
import type { ConditionalSampledCashHistory } from '@/lib/carry/conditionalSampledCashPathProjection'
import { initialDepositQuestion, initialDepositNativeRaw } from '@/components/Carry/initialDepositScenario'
import { initialDepositMarket, selectedInitialDepositNativeAgreement } from '@/lib/carry/initialDepositCapacityProjection'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
const hash = (s:string)=>createHash('sha256').update(s).digest('hex')
const histories = Object.values(loadPinnedAudit().histories) as ConditionalSampledCashHistory[]
function question(history=histories[0]): FixedEntitlementCashInput {
  const issuedAtUtc='2026-10-11T12:00:00.000Z'
  // Synthetic current source: this tests the kernel on authentic histories, not live qualification.
  return {history,currentSource:{...history.identity,chainId:1,cashRaw:'1000000000000000000000000',
    block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:issuedAtUtc,readAt:issuedAtUtc,
    sourceKind:'live_read_only_two_origin_finalized'},fullEntitlementRaw:'1000000000000000000000000',
    requestedRaw:'10000',additionalCompetitionRaw:'0',horizonHours:48,issuedAtUtc}
}
describe('fixed entitlement cash kernel with genuine histories and synthetic current sources',()=>{
 it('supports all 64 cash histories including 49 Morpho destinations without rich profiles',()=>{
  let morpho=0
  for (const h of histories) {
    const q=question(h), r=buildFixedEntitlementCashOutlook(q, v=>v===q,hash)
    expect(r, h.identity.routeKey+':'+h.identity.destination).not.toBeNull()
    expect(r!.holderExecutableExit).toBe(false); expect(r!.forecastValidated).toBe(false)
    expect(r!.process.targetAtUtc).toBe('2026-10-13T12:00:00.000Z')
    if (/VaultV2/.test(h.identity.routeKey)) morpho++
  }
  expect(morpho).toBe(49)
 })
 it('requires original qualification, rejects history tampering and never caps entitlement to requested Q',()=>{
  const q=question(); expect(buildFixedEntitlementCashOutlook(q,()=>false,hash)).toBeNull()
  const bad=structuredClone(q);bad.history.points[0][4]='1'
  expect(buildFixedEntitlementCashOutlook(bad,()=>true,hash)).toBeNull()
  q.fullEntitlementRaw='20000'
  const r=buildFixedEntitlementCashOutlook(q,()=>true,hash)!
  expect(r.process.targetSummary!.empiricalP90HeadroomRaw).toBe('10000')
  if (r.adverseHolderHeadroom) expect(BigInt(r.adverseHolderHeadroom.maximumRaw)).toBeLessThanOrEqual(10000n)
  q.additionalCompetitionRaw=q.currentSource.cashRaw
  const m=buildFixedEntitlementCashOutlook(q,()=>true,hash)!
  expect(BigInt(m.process.targetSummary!.maximumHeadroomRaw)).toBeLessThanOrEqual(10000n)
 })
 it('rejects stale, future-available and mismatched current sources',()=>{
  const q=question();q.currentSource.blockTime='2026-10-10T00:00:00.000Z'
  expect(buildFixedEntitlementCashOutlook(q,()=>true,hash)).toBeNull()
  const b=question();b.issuedAtUtc='2026-10-02T00:00:00.000Z';b.currentSource.blockTime=b.issuedAtUtc;b.currentSource.readAt=b.issuedAtUtc
  expect(buildFixedEntitlementCashOutlook(b,()=>true,hash)).toBeNull()
 })
 it('extends indexed initial deposit to 18-decimal Aave USDe without rescaling it as USDC',()=>{
  const m=DIRECT_SUPPLY_MARKETS.aaveV3Usde
  const q=initialDepositQuestion('initial_deposit',m.routeKey,m.destination,'1.000000000000000001','1',48)!
  expect(q.assetDecimals).toBe(18);expect(q.depositAssetsRaw).toBe('1000000000000000001')
  expect(initialDepositNativeRaw('1.0000001',6)).toBeNull()
  expect(initialDepositMarket(m.routeKey,m.destination.toLowerCase())).toBeDefined()
  const source={...question(histories.find(h=>h.identity.routeKey===m.routeKey)!).currentSource}
  const facts={pool:'0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',aToken:source.destination,
    asset:source.asset,assetDecimals:18,configurationRaw:String(18n<<48n),normalizedIncomeRaw:String(10n**27n),
    scaledTotalSupplyRaw:'1',accruedToTreasuryScaledRaw:'0'}
  const agreement={status:'agreed_initial_deposit_native_facts',currentSource:source,readAt:source.readAt,
    origins:[{originHostSha256:'a'.repeat(64),facts},{originHostSha256:'b'.repeat(64),facts}]}
  expect(selectedInitialDepositNativeAgreement(agreement,source,Date.parse(source.readAt))).not.toBeNull()
  facts.assetDecimals=6
  expect(selectedInitialDepositNativeAgreement(agreement,source,Date.parse(source.readAt))).toBeNull()
 })
})
