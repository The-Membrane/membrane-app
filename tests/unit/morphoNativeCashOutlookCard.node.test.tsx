import { retainNativeCashHolderOutlook, selectedNativeCashHolderOutlook } from '@/lib/carry/nativeCashHolderOutlookReceipt'
import React from 'react'
import {it} from 'node:test'
import assert from 'node:assert/strict'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChakraProvider} from '@chakra-ui/react'
import {createHash} from 'node:crypto'
import theme from '../../theme'
import {cashHolderDurationDetail,ExitPressureCard,type ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import {loadPinnedAudit} from '../../scripts/research/conditional-cash-time-holdout.mjs'
import {buildFixedEntitlementCashOutlook} from '@/lib/carry/fixedEntitlementCashOutlook'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
const now=Date.parse('2026-10-12T12:00:00.000Z'),owner='0x0000000000000000000000000000000000000001'
function fixture(cashRaw="1000000"):ExitPressureCardProps {
 const history=Object.values(loadPinnedAudit().histories).find((h:any)=>h.identity.destination==='0x069662d2588fcac24b5c209456db965d151556f0') as ConditionalSampledCashHistory
 const currentSource={...history.identity,chainId:1 as const,cashRaw,block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:new Date(now-60000).toISOString(),readAt:new Date(now).toISOString(),sourceKind:'live_read_only_two_origin_finalized' as const}
 // Authentic histories, explicitly synthetic current source and transport view. Native branding has its own API tests.
 const input={history,currentSource,fullEntitlementRaw:'9000000000',requestedRaw:'1000000',additionalCompetitionRaw:'0',horizonHours:48,issuedAtUtc:new Date(now).toISOString()}
 const outlook=buildFixedEntitlementCashOutlook(input,v=>v===input,s=>createHash('sha256').update(s).digest('hex'))!
 outlook.historicalRecovery.question.owner=owner
 const model={...outlook,owner,nativeSharesRaw:'1000000000'}
 const issue=retainNativeCashHolderOutlook(model,200,{routeKey:history.identity.routeKey,destination:history.identity.destination,owner,requestedRaw:input.requestedRaw,asset:history.identity.asset,assetDecimals:6,horizonHours:48,source:{blockNumber:26200000,blockHash:currentSource.blockHash,blockTime:currentSource.blockTime},asOfMs:now})!
 assert.ok(issue)
 return {routeKey:history.identity.routeKey,destination:history.identity.destination,requestedAmount:'1',requestedRaw:'1000000',requestedAssetSymbol:'USDC',requestedAssetAddress:history.identity.asset,requestedAssetDecimals:6,horizonHours:48,asOfMs:now,requestedHolderAddress:owner,
  currentCash:{routeKey:history.identity.routeKey,destination:history.identity.destination,cashRaw:currentSource.cashRaw,assetAddress:history.identity.asset,assetDecimals:6,assetSymbol:'USDC',observedAt:currentSource.blockTime,block:currentSource.block,blockHash:currentSource.blockHash,freshness:'fresh',label:'Vault cash',readAtUtc:currentSource.readAt,sourceKind:currentSource.sourceKind},
  prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,expectedEventEnrollment:null,eventContext:null,historicalOutlook:null,
  holderAssessment:{status:'assessed',routeKey:history.identity.routeKey,destinationAddress:history.identity.destination,owner,request:{assetsRaw:'1000000',assetAddress:history.identity.asset,horizonHours:48},source:{chainId:1,blockNumber:26200000,blockHash:currentSource.blockHash as `0x${string}`,blockTime:currentSource.blockTime,finalized:true,originValidation:'two_provider'},stages:[],finalPayout:{status:'unassessed',assetAddress:history.identity.asset,amountRaw:null},forecast:{status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false},nativeCashHolderOutlook:model,nativeCashHolderOutlookIssue:issue}}
}
const render=(p:ExitPressureCardProps)=>renderToStaticMarkup(<ChakraProvider theme={theme}><ExitPressureCard {...p}/></ChakraProvider>)
it('renders actual existing-card cash impact, sampled duration and adverse-flow metrics',()=>{
 const p=fixture(),html=render(p)
 assert.match(html,/Conditional cash exit headroom/)
 assert.match(html,/Cash change since historical sample/)
 assert.match(html,/Matched historical recovery/)
 assert.match(html,/NOT BELOW Q/)
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

it('duration distinguishes adequate sampled paths from fully and partly censored paths',()=>{
 const p=fixture(), process=structuredClone(p.holderAssessment!.nativeCashHolderOutlook!.process)
 for(const s of process.scenarios) {s.sampledShortfalls=[];s.status='conditional_path';s.targetHeadroomRaw='1'}
 assert.equal(cashHolderDurationDetail({process}),' · NO SAMPLED SHORTFALL')
 process.scenarios[0].status='censored_path';process.scenarios[0].targetHeadroomRaw=null
 assert.match(cashHolderDurationDetail({process}),/PARTIAL/)
 for(const s of process.scenarios) {s.status='censored_path';s.targetHeadroomRaw=null}
 assert.equal(cashHolderDurationDetail({process}),' · DURATION CENSORED')
})
it('rejects copied receipts, mismatched nested recovery questions and post-selection mutation',()=>{
 const p=fixture(), a=p.holderAssessment!, m=a.nativeCashHolderOutlook!, issue=a.nativeCashHolderOutlookIssue!
 const q={routeKey:p.routeKey,destination:p.destination,owner,requestedRaw:p.requestedRaw!,asset:p.requestedAssetAddress!,assetDecimals:6,horizonHours:48,source:a.source,asOfMs:now}
 assert.equal(selectedNativeCashHolderOutlook({...issue},q),null)
 for(const field of ['owner','requestedRaw','horizonHours','currentSource'] as const) {
  const bad=structuredClone(m); (bad.historicalRecovery.question as any)[field]=field==='horizonHours'?24:field==='currentSource'?{...m.currentSource,cashRaw:'2'}:'bad'
  assert.equal(retainNativeCashHolderOutlook(bad,200,q),null)
 }
 const selected=selectedNativeCashHolderOutlook(issue,q)!
 selected.historicalRecovery.result!.counts.matchedDonors++
 assert.equal(selectedNativeCashHolderOutlook(issue,q),null)
 assert.doesNotMatch(render(p),/Matched historical recovery/)
})

it('renders genuine history-matched sparse/censored recovery evidence for a below-Q cash proxy',()=>{
 const p=fixture('200000'), m=p.holderAssessment!.nativeCashHolderOutlook!, result=m.historicalRecovery.result!
 assert.equal(result.status,'sparse_history')
 assert.equal(result.matching.ageStratum,'unknown_left_censored')
 assert.equal(result.centralHours,null)
 const html=render(p)
 assert.match(html,/Matched historical recovery/)
 assert.match(html,new RegExp(`${result.counts.matchedDonors} matched`))
 assert.match(html,/onset unknown/)
 assert.match(html,/sampled analogue/)
})

it('does not extend a truncated shortfall through the horizon and renders the censored state',()=>{
 const p=fixture('200000'), a=p.holderAssessment!, m=a.nativeCashHolderOutlook!
 for(const s of m.process.scenarios) {s.status='censored_path';s.targetHeadroomRaw=null;s.points=s.points.slice(0,2);s.sampledShortfalls=[{onset:{after:null,by:m.process.issueAtUtc},recovery:null,leftCensored:true,rightCensored:true}] as any}
 m.process.targetSummary=null
 assert.equal(cashHolderDurationDetail(m),' · DURATION CENSORED')
 a.nativeCashHolderOutlookIssue=retainNativeCashHolderOutlook(m,200,{routeKey:p.routeKey,destination:p.destination,owner,requestedRaw:p.requestedRaw!,asset:p.requestedAssetAddress!,assetDecimals:6,horizonHours:48,source:a.source,asOfMs:now})!
 const html=render(p)
 assert.match(html,/DURATION CENSORED/)
 assert.match(html,/Matched historical recovery/)
 assert.doesNotMatch(html,/SHORTFALL ≥48/)
})
it('rejects nested result clocks, question identity and amount substitutions before retention',()=>{
 const p=fixture(), m=p.holderAssessment!.nativeCashHolderOutlook!, q={routeKey:p.routeKey,destination:p.destination,owner,requestedRaw:p.requestedRaw!,asset:p.requestedAssetAddress!,assetDecimals:6,horizonHours:48,source:p.holderAssessment!.source,asOfMs:now}
 for(const patch of [{amount:2},{routeKey:'other'},{horizonHours:24},{asOf:'2026-10-11T12:00:00.000Z'},{issueClockBasis:'source_clock_retrospective'},{regimeBasis:'verified_tag'}]) {
  const bad=structuredClone(m);Object.assign(bad.historicalRecovery.result!,patch)
  assert.equal(retainNativeCashHolderOutlook(bad,200,q),null)
 }
 for(const patch of [{fullEntitlementRaw:'1'},{additionalCompetitionRaw:'1'},{issuedAtUtc:'2026-10-11T12:00:00.000Z'},{identity:{...m.identity,asset:'0x'+ 'b'.repeat(40)}}]) {
  const bad=structuredClone(m);Object.assign(bad.historicalRecovery.question,patch)
  assert.equal(retainNativeCashHolderOutlook(bad,200,q),null)
 }
})
