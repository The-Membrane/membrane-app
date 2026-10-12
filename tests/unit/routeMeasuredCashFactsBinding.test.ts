import {describe, it, expect} from 'vitest'
import {loadPinnedAudit} from '../../scripts/research/conditional-cash-time-holdout.mjs'
import {readRoutePrimaryCashFacts} from '@/lib/carry/routePrimaryCashFacts.server'
import {selectedRouteMeasuredCashFacts} from '@/lib/carry/routeMeasuredCashFactsBinding'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
import type {RouteEventQuestion, RouteEventContextSources} from '@/lib/carry/routeEventContext'
const audit = loadPinnedAudit(), histories = Object.values(audit.histories) as ConditionalSampledCashHistory[]
const now = Date.parse('2026-10-12T12:00:00.000Z'), at = new Date(now).toISOString()
const absent = {status: 'unavailable' as const, reason: 'source_unavailable' as const}
const question = (h: ConditionalSampledCashHistory): RouteEventQuestion => ({routeKey:h.identity.routeKey,
 destination:h.identity.destination, payoutAsset:h.identity.asset, assetDecimals:h.identity.assetDecimals,
 requestedRaw:'10000', horizonHours:48})
function fixture(cashRaw='10000000000000000000000000000000000000000000000000000000000000000000000') {
 const h=histories.find(h=>h.identity.routeKey==='USDT → supply on Spark')!, q=question(h)
 const capacity:RouteEventContextSources['capacity']={status:'available',value:{...q,
  metric:'aggregate_cash_raw',meaning:'aggregate_route_liquidity_proxy_not_holder_executable_capacity',
  verification:'local_hash_chain_replay',observations:[{raw:cashRaw,block:'27000000',
   blockHash:'0x'+'a'.repeat(64),blockTime:at,sourceId:'test:synthetic_current'}]}}
 const model=readRoutePrimaryCashFacts(q,capacity,now)
 return {q,capacity,model}
}
describe('measured cash transport selection, independent question and aggregate source binding',()=>{
 it('selects genuine historical facts for all64 histories, including supplemental USDe separately',()=>{
  let morpho=0
  for(const h of histories){const q=question(h), model=readRoutePrimaryCashFacts(q,absent,now)
   const selected=selectedRouteMeasuredCashFacts(model,q,absent,now)!
   expect(selected).not.toBeNull();expect(selected.measuredHistoricalCashChangeRaw).toBe(model.status==='historical_primary_facts_only'?model.measuredHistoricalCashChangeRaw:null)
   expect(selected.conditionalCashProxyRaw).toBeNull();expect(selected.meaning).toBe('aggregate_cash_proxy_not_owner_headroom_or_causal_news_effect')
   if(h.identity.routeKey.includes('VaultV2'))morpho++
  }
  expect(morpho).toBe(49);expect(histories).toHaveLength(64)
 })
 it('checks the real API arithmetic against independently supplied aggregate source without deducting Q or M',()=>{
  const {q,capacity,model}=fixture(), selected=selectedRouteMeasuredCashFacts(model,q,capacity,now)!
  expect(selected).not.toBeNull();expect(selected.conditionalCashProxyRaw).not.toBeNull()
  expect(selected.conditionalCashDeltaRaw?.startsWith('-')).toBe(true)
  expect(model.conditionalNetScenario?.noQOrAdditionalMDeductedHere).toBe(true)
  expect(model.holderHeadroom).toBeNull();expect(model.ownerAndFullEntitlementQualified).toBe(false)
  expect(selectedRouteMeasuredCashFacts(model,q,absent,now)).toBeNull()
 })
 it('keeps a negative modeled endpoint censored, never clamps it to apparent final-asset capacity',()=>{
  const {q,capacity,model}=fixture('1'), selected=selectedRouteMeasuredCashFacts(model,q,capacity,now)!
  expect(selected).not.toBeNull();expect(selected.endpointCensored).toBe(true);expect(selected.conditionalCashProxyRaw).toBeNull()
 })
 it('rejects question changes, unknown destinations, future and expired issuance',()=>{
  const {q,capacity,model}=fixture()
  for(const patch of [{routeKey:'unknown'},{destination:'0x'+'f'.repeat(40)},{payoutAsset:'0x'+'b'.repeat(40)},
   {assetDecimals:18},{requestedRaw:'10001'},{horizonHours:24}])
   expect(selectedRouteMeasuredCashFacts(model,{...q,...patch},capacity,now)).toBeNull()
  expect(selectedRouteMeasuredCashFacts(model,q,capacity,now-1)).toBeNull()
  expect(selectedRouteMeasuredCashFacts(model,q,capacity,now+1800001)).toBeNull()
 })
 it('rejects changed source cash, block, hash, clock, units and meaning',()=>{
  const {q,capacity,model}=fixture()
  if(capacity.status!=='available')throw Error('fixture')
  for(const patch of [{raw:'2'},{block:'27000001'},{blockHash:'0x'+'b'.repeat(64)},{blockTime:'2026-10-12T11:59:00.000Z'}]){
   const c=structuredClone(capacity);Object.assign(c.value.observations[0],patch)
   expect(selectedRouteMeasuredCashFacts(model,q,c,now)).toBeNull()
  }
  const wrongUnits=structuredClone(capacity);wrongUnits.value.assetDecimals=18
  expect(selectedRouteMeasuredCashFacts(model,q,wrongUnits,now)).toBeNull()
 })
 it('binds modeled amounts to the independently displayed Card cash witness without constructing it from the response',()=>{
  const {q,capacity,model}=fixture()
  if(capacity.status!=='available')throw Error('fixture')
  const original=capacity.value.observations[0]
  const witness={routeKey:q.routeKey,destination:q.destination,assetAddress:q.payoutAsset,assetDecimals:q.assetDecimals,
   cashRaw:original.raw,block:original.block,blockHash:original.blockHash,observedAt:original.blockTime}
  expect(selectedRouteMeasuredCashFacts(model,q,witness,now)?.conditionalCashProxyRaw).not.toBeNull()
  for(const patch of [{cashRaw:'2'},{block:'27000001'},{blockHash:'0x'+'b'.repeat(64)},
   {observedAt:'2026-10-12T11:59:00.000Z'},{assetDecimals:18}])
   expect(selectedRouteMeasuredCashFacts(model,q,{...witness,...patch},now)).toBeNull()
  expect(selectedRouteMeasuredCashFacts(model,q,null,now)).toBeNull()
 })
 it('rejects future history availability, mismatched historical deltas, target and rate arithmetic',()=>{
  const {q,capacity,model}=fixture()
  if(!('historyWitness' in model))throw Error('fixture')
  const mutations=[(m:typeof model)=>{m.historyWitness.availableAt='2026-10-13T12:00:00.000Z'},
   (m:typeof model)=>{m.measuredHistoricalCashChangeRaw='1'},
   (m:typeof model)=>{m.facts[0].cashRaw='-1'},
   (m:typeof model)=>{m.facts[0].receiptSha256='0'.repeat(64)},
   (m:typeof model)=>{m.conditionalNetScenario!.targetAtUtc='2026-10-14T13:00:00.000Z'},
   (m:typeof model)=>{m.conditionalNetScenario!.conditionalCashDeltaRaw='-1'},
   (m:typeof model)=>{m.conditionalNetScenario!.rate.denominatorMs++},
   (m:typeof model)=>{m.conditionalNetScenario!.currentSource!.cashRaw='1'}]
  for(const mutate of mutations){const bad=structuredClone(model);mutate(bad);expect(selectedRouteMeasuredCashFacts(bad,q,capacity,now)).toBeNull()}
 })
 it('selects four foreign lanes only as explicit conversion gaps, rejecting numerical substitution',()=>{
  const base=question(histories[0])
  for(const e of audit.exclusions){const q={...base,routeKey:e.routeKey,destination:e.destination}
   const model=readRoutePrimaryCashFacts(q,absent,now), selected=selectedRouteMeasuredCashFacts(model,q,absent,now)!
   expect(selected).not.toBeNull();expect(selected.conditionalCashProxyRaw).toBeNull();expect(selected.measuredHistoricalCashChangeRaw).toBeNull()
   const bad=structuredClone(model);(bad as any).conditionalNetScenario={conditionalCashProxyRaw:'100'}
   expect(selectedRouteMeasuredCashFacts(bad,q,absent,now)).toBeNull()
  }
 })
})
