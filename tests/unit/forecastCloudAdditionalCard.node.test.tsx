import React from 'react'
import {it} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChakraProvider} from '@chakra-ui/react'
import theme from '../../theme'
import {ExitPressureCard,type ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import {initialDepositQuestion,initialDepositIssueFromResponse} from '@/components/Carry/initialDepositScenario'
import {buildInitialDepositCapacityProjection} from '@/lib/carry/initialDepositCapacityProjection'
import {buildConditionalSampledCashPathProjection,type ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
import {loadPinnedAudit} from '../../scripts/research/conditional-cash-time-holdout.mjs'
import {readAavePrimaryEventFacts} from '@/lib/carry/aavePrimaryEventFacts.server'
import {buildRouteEventContext} from '@/lib/carry/routeEventContext'
import {resolveRouteNewsSource} from '@/lib/carry/routeNewsSources'
const now=Date.parse('2026-10-12T12:00:00.000Z'),at=new Date(now).toISOString(),owner='0x0000000000000000000000000000000000000001'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const render=(p:ExitPressureCardProps)=>renderToStaticMarkup(<ChakraProvider theme={theme}><ExitPressureCard {...p}/></ChakraProvider>)
function base(routeKey:string,destination:string,asset:string):ExitPressureCardProps {
 return {routeKey,destination,requestedAmount:'1',requestedRaw:'1000000',requestedAssetSymbol:'USDC',requestedAssetAddress:asset,requestedAssetDecimals:6,horizonHours:48,asOfMs:now,requestedHolderAddress:owner,currentCash:null,prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,holderAssessment:null,expectedEventEnrollment:null,eventContext:null,historicalOutlook:null}
}
it('actual Card renders full minted entitlement independent of planned exit and receiver-specific blocked admission',()=>{
 const history=Object.values(loadPinnedAudit().histories).find((h:any)=>h.identity.destination==='0x069662d2588fcac24b5c209456db965d151556f0') as ConditionalSampledCashHistory
 const s={...history.identity,chainId:1 as const,cashRaw:'100000000',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at,sourceKind:'live_read_only_two_origin_finalized' as const}
 const q=initialDepositQuestion('initial_deposit',s.routeKey,s.destination,'10','1',48,owner)!
 const daily=buildConditionalSampledCashPathProjection({history,currentSource:s,request:{requestedRaw:q.plannedExitAssetsRaw,asOf:at}},hash)!
 // Synthetic native preview transport with genuine sealed historical cash; no live-read claim.
 const facts={vault:s.destination,asset:s.asset,assetDecimals:6,shareDecimals:18,depositAssetsRaw:'10000000',mintedSharesRaw:'123456789000000000000',entitlementRaw:'9000000',receiver:owner,maxDepositRaw:'9999999',maxDepositStatus:'quoted' as const}
 const native={status:'agreed_erc4626_initial_deposit_facts',currentSource:s,readAt:at,origins:[{originHostSha256:'a'.repeat(64),facts},{originHostSha256:'b'.repeat(64),facts:structuredClone(facts)}]}
 const projection=buildInitialDepositCapacityProjection({currentSource:s,dailyProjection:daily,depositAssetsRaw:q.depositAssetsRaw,plannedExitAssetsRaw:q.plannedExitAssetsRaw,horizonHours:48,asOfMs:now,receiver:owner,nativeAgreement:native},hash)
 assert.equal(projection.status,'conditional_initial_deposit_projection')
 const issue=initialDepositIssueFromResponse({routeKey:s.routeKey,destination:s.destination,initialDepositProjection:projection,conditionalSampledCashPathProjection:daily},q,now,now)
 assert.ok(issue)
 const p={...base(s.routeKey,s.destination,s.asset),scenarioMode:'initial_deposit' as const,depositAmount:'10',initialDepositIssue:issue,currentCash:{routeKey:s.routeKey,destination:s.destination,cashRaw:s.cashRaw,assetAddress:s.asset,assetDecimals:6,assetSymbol:'USDC',observedAt:at,block:s.block,blockHash:s.blockHash,freshness:'fresh' as const,label:'Vault cash',readAtUtc:at,sourceKind:s.sourceKind}}
 const html=render(p)
 assert.match(html,/Hypothetical receipt 9 USDC/)
 assert.match(html,/Admission blocked under reference rules/)
 assert.doesNotMatch(html,/Hypothetical receipt 1 USDC/)
 for(const patch of [{requestedHolderAddress:'0x'+'2'.repeat(40)},{depositAmount:'11'},{requestedRaw:'2000000',requestedAmount:'2'},{horizonHours:24}]) {
  const changed=render({...p,...patch})
  assert.match(changed,/Deposit outlook unassessed/)
  assert.doesNotMatch(changed,/Hypothetical receipt 9 USDC/)
 }
})
it('actual Card consumes genuine latest primary collateral rule with historic-state qualification and exact-question selection',()=>{
 const q={routeKey:'USDC → supply on Aave V3',destination:'0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',payoutAsset:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',assetDecimals:6,requestedRaw:'1000000',horizonHours:48}
 const source=resolveRouteNewsSource(q.routeKey,q.destination)!
 const sources={event:{status:'unavailable' as const,reason:'source_unavailable' as const},news:{status:'unavailable' as const,reason:'source_unavailable' as const},capacity:{status:'unavailable' as const,reason:'source_unavailable' as const}}
 const context={...buildRouteEventContext(q,null,sources,now,source.id),primaryEvents:readAavePrimaryEventFacts(q,now)}
 const p={...base(q.routeKey,q.destination,q.payoutAsset),expectedEventEnrollment:{status:'not_enrolled' as const},eventContext:context}
 const html=render(p)
 assert.match(html,/Primary protocol rule/)
 assert.match(html,/Collateral threshold 78%/)
 assert.match(html,/current state unknown/)
 assert.doesNotMatch(html,/Pause on|Freeze on/)
 for(const patch of [{requestedRaw:'2000000'},{horizonHours:24},{requestedAssetAddress:'0x'+'2'.repeat(40)}])assert.doesNotMatch(render({...p,...patch}),/Primary protocol rule|Collateral threshold 78%/)
 const earlier=Date.parse('2026-10-11T12:00:00.000Z')
 assert.doesNotMatch(render({...p,asOfMs:earlier,eventContext:{...context,primaryEvents:readAavePrimaryEventFacts(q,earlier)}}),/Primary protocol rule|Collateral threshold 78%/)
})
