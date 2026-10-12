import React from 'react'
import {it} from 'node:test'
import assert from 'node:assert/strict'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChakraProvider} from '@chakra-ui/react'
import {createHash} from 'node:crypto'
import theme from '../../theme'
import {ExitPressureCard,type ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import {loadPinnedAudit} from '../../scripts/research/conditional-cash-time-holdout.mjs'
import {buildFixedEntitlementCashOutlook} from '@/lib/carry/fixedEntitlementCashOutlook'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
const now=Date.parse('2026-10-12T12:00:00.000Z'),owner='0x0000000000000000000000000000000000000001'
function fixture():ExitPressureCardProps {
 const history=Object.values(loadPinnedAudit().histories).find((h:any)=>h.identity.destination==='0x069662d2588fcac24b5c209456db965d151556f0') as ConditionalSampledCashHistory
 const currentSource={...history.identity,chainId:1 as const,cashRaw:'1000000',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:new Date(now-60000).toISOString(),readAt:new Date(now).toISOString(),sourceKind:'live_read_only_two_origin_finalized' as const}
 // Authentic histories, explicitly synthetic current source and transport view. Native branding has its own API tests.
 const input={history,currentSource,fullEntitlementRaw:'9000000000',requestedRaw:'1000000',additionalCompetitionRaw:'0',horizonHours:48,issuedAtUtc:new Date(now).toISOString()}
 const outlook=buildFixedEntitlementCashOutlook(input,v=>v===input,s=>createHash('sha256').update(s).digest('hex'))!
 return {routeKey:history.identity.routeKey,destination:history.identity.destination,requestedAmount:'1',requestedRaw:'1000000',requestedAssetSymbol:'USDC',requestedAssetAddress:history.identity.asset,requestedAssetDecimals:6,horizonHours:48,asOfMs:now,requestedHolderAddress:owner,
  currentCash:{routeKey:history.identity.routeKey,destination:history.identity.destination,cashRaw:currentSource.cashRaw,assetAddress:history.identity.asset,assetDecimals:6,assetSymbol:'USDC',observedAt:currentSource.blockTime,block:currentSource.block,blockHash:currentSource.blockHash,freshness:'fresh',label:'Vault cash',readAtUtc:currentSource.readAt,sourceKind:currentSource.sourceKind},
  prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,expectedEventEnrollment:null,eventContext:null,historicalOutlook:null,
  holderAssessment:{status:'assessed',routeKey:history.identity.routeKey,destinationAddress:history.identity.destination,owner,request:{assetsRaw:'1000000',assetAddress:history.identity.asset,horizonHours:48},source:{chainId:1,blockNumber:26200000,blockHash:currentSource.blockHash as `0x${string}`,blockTime:currentSource.blockTime,finalized:true,originValidation:'two_provider'},stages:[],finalPayout:{status:'unassessed',assetAddress:history.identity.asset,amountRaw:null},forecast:{status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false},nativeCashHolderOutlook:{...outlook,owner,nativeSharesRaw:'1000000000'}}}
}
const render=(p:ExitPressureCardProps)=>renderToStaticMarkup(<ChakraProvider theme={theme}><ExitPressureCard {...p}/></ChakraProvider>)
it('renders actual existing-card cash impact, sampled duration and adverse-flow metrics',()=>{
 const p=fixture(),html=render(p)
 assert.match(html,/Conditional cash exit headroom/)
 assert.match(html,/Cash change since historical sample/)
 assert.match(html,/SHORTFALL/)
 assert.match(html,/Adverse flow headroom/)
 assert.match(html,/CONDITIONAL HOLDER OUTLOOK/)
})
it('removes the native outlook after owner, Q, horizon, source or scenario changes',()=>{
 for(const patch of [{requestedHolderAddress:'0x0000000000000000000000000000000000000002'},{requestedRaw:'1000001'},{horizonHours:24},{scenarioMode:'initial_deposit' as const},{asOfMs:now+1800001}]){
  assert.doesNotMatch(render({...fixture(),...patch}),/Conditional cash exit headroom/)
 }
 for(const patch of [{block:'26200001'},{cashRaw:'1000001'},{assetDecimals:18}]) {
  const p=fixture();Object.assign(p.currentCash!,patch)
  assert.doesNotMatch(render(p),/Conditional cash exit headroom/)
 }
})
