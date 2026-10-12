import {createHash} from 'node:crypto'
import {loadPinnedAudit} from './conditional-cash-time-holdout.mjs'
import {buildFixedEntitlementCashOutlook} from '@/lib/carry/fixedEntitlementCashOutlook'
import {nativeCashGraphIntervalOutlook} from '@/lib/carry/nativeCashPeerIntervals'
import {buildNativePrimaryEventImpact} from '@/lib/carry/nativePrimaryEventImpact'
import {retainNativeCashHolderOutlook} from '@/lib/carry/nativeCashHolderOutlookReceipt'
import type {ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
import assert from 'node:assert/strict'
let now=Date.now();const owner='0x0000000000000000000000000000000000000001'
export function buildCloudHolderFixture(cashRaw="1000000"):ExitPressureCardProps {
 now=Date.now()
 const history=Object.values(loadPinnedAudit().histories).find((h:any)=>h.identity.destination==='0x069662d2588fcac24b5c209456db965d151556f0') as ConditionalSampledCashHistory
 const currentSource={...history.identity,chainId:1 as const,cashRaw,block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:new Date(now-60000).toISOString(),readAt:new Date(now).toISOString(),sourceKind:'live_read_only_two_origin_finalized' as const}
 // Authentic histories, explicitly synthetic current source and transport view. Native branding has its own API tests.
 const input={history,currentSource,fullEntitlementRaw:'9000000000',requestedRaw:'1000000',additionalCompetitionRaw:'0',horizonHours:48,issuedAtUtc:new Date(now).toISOString()}
 const outlook=buildFixedEntitlementCashOutlook(input,v=>v===input,s=>createHash('sha256').update(s).digest('hex'))!
 outlook.historicalRecovery.question.owner=owner
 const originalModel={...outlook,owner,nativeSharesRaw:'1000000000'}, graphQuestion={...input,owner}
 const graph=nativeCashGraphIntervalOutlook(graphQuestion,[history],q=>q===graphQuestion)
 const model={...originalModel,sparsePeerOutlook:graph,primaryEventImpact:buildNativePrimaryEventImpact(originalModel,(v,h)=>v===originalModel && h===history,history)}
 const issue=retainNativeCashHolderOutlook(model,200,{routeKey:history.identity.routeKey,destination:history.identity.destination,owner,requestedRaw:input.requestedRaw,asset:history.identity.asset,assetDecimals:6,horizonHours:48,source:{blockNumber:26200000,blockHash:currentSource.blockHash,blockTime:currentSource.blockTime},asOfMs:now})!
 assert.ok(issue)
 return {routeKey:history.identity.routeKey,destination:history.identity.destination,requestedAmount:'1',requestedRaw:'1000000',requestedAssetSymbol:'USDC',requestedAssetAddress:history.identity.asset,requestedAssetDecimals:6,horizonHours:48,asOfMs:now,requestedHolderAddress:owner,
  currentCash:{routeKey:history.identity.routeKey,destination:history.identity.destination,cashRaw:currentSource.cashRaw,assetAddress:history.identity.asset,assetDecimals:6,assetSymbol:'USDC',observedAt:currentSource.blockTime,block:currentSource.block,blockHash:currentSource.blockHash,freshness:'fresh',label:'Vault cash',readAtUtc:currentSource.readAt,sourceKind:currentSource.sourceKind},
  prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,expectedEventEnrollment:null,eventContext:null,historicalOutlook:null,
  holderAssessment:{status:'assessed',routeKey:history.identity.routeKey,destinationAddress:history.identity.destination,owner,request:{assetsRaw:'1000000',assetAddress:history.identity.asset,horizonHours:48},source:{chainId:1,blockNumber:26200000,blockHash:currentSource.blockHash as `0x${string}`,blockTime:currentSource.blockTime,finalized:true,originValidation:'two_provider'},stages:[],finalPayout:{status:'unassessed',assetAddress:history.identity.asset,amountRaw:null},forecast:{status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false},nativeCashHolderOutlook:model,nativeCashHolderOutlookIssue:issue}}
}
