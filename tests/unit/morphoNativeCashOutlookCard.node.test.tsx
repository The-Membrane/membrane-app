import {nativeCashGraphIntervalOutlook} from '@/lib/carry/nativeCashPeerIntervals'
import {buildNativePrimaryEventImpact} from '@/lib/carry/nativePrimaryEventImpact'
import {buildSaturnOwnedTicketConditionalMechanism} from '@/lib/carry/saturnOwnedTicketConditionalMechanism'
import {retainSaturnTicketMechanism} from '@/lib/carry/saturnTicketMechanismReceipt'
import {saturnTicketFixture} from './fixtures/saturnTicketMechanismFixture'
import { retainNativeCashHolderOutlook, selectedNativeCashHolderOutlook } from '@/lib/carry/nativeCashHolderOutlookReceipt'
import React from 'react'
import {it} from 'node:test'
import assert from 'node:assert/strict'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChakraProvider} from '@chakra-ui/react'
import {createHash} from 'node:crypto'
import theme from '../../theme'
import {cashHolderDurationDetail,nativeInventoryAnalogueRows,ExitPressureCard,type ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import {loadPinnedAudit} from '../../scripts/research/conditional-cash-time-holdout.mjs'
import {buildFixedEntitlementCashOutlook} from '@/lib/carry/fixedEntitlementCashOutlook'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
const now=Date.parse('2026-10-12T12:00:00.000Z'),owner='0x0000000000000000000000000000000000000001'
function fixture(cashRaw="1000000"):ExitPressureCardProps {
 const histories=Object.values(loadPinnedAudit().histories) as ConditionalSampledCashHistory[]
 const history=histories.find(h=>h.identity.destination==='0x069662d2588fcac24b5c209456db965d151556f0')!
 const currentSource={...history.identity,chainId:1 as const,cashRaw,block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:new Date(now-60000).toISOString(),readAt:new Date(now).toISOString(),sourceKind:'live_read_only_two_origin_finalized' as const}
 // Authentic histories, explicitly synthetic current source and transport view. Native branding has its own API tests.
 const input={history,currentSource,fullEntitlementRaw:'9000000000',requestedRaw:'1000000',additionalCompetitionRaw:'0',horizonHours:48,issuedAtUtc:new Date(now).toISOString()}
 const outlook=buildFixedEntitlementCashOutlook(input,v=>v===input,s=>createHash('sha256').update(s).digest('hex'))!
 outlook.historicalRecovery.question.owner=owner
 const originalModel={...outlook,owner,nativeSharesRaw:'1000000000'}, graphQuestion={...input,owner}
 const graph=nativeCashGraphIntervalOutlook(graphQuestion,histories,(q,h)=>q===graphQuestion&&h===histories,s=>createHash('sha256').update(s).digest('hex'))
 const model={...originalModel,sparsePeerOutlook:graph,primaryEventImpact:buildNativePrimaryEventImpact(originalModel,(v,h)=>v===originalModel && h===history,history)}
 const issue=retainNativeCashHolderOutlook(model,200,{routeKey:history.identity.routeKey,destination:history.identity.destination,owner,requestedRaw:input.requestedRaw,asset:history.identity.asset,assetDecimals:6,horizonHours:48,source:{blockNumber:26200000,blockHash:currentSource.blockHash,blockTime:currentSource.blockTime},asOfMs:now})!
 assert.ok(issue)
 return {routeKey:history.identity.routeKey,destination:history.identity.destination,requestedAmount:'1',requestedRaw:'1000000',requestedAssetSymbol:'USDC',requestedAssetAddress:history.identity.asset,requestedAssetDecimals:6,horizonHours:48,asOfMs:now,requestedHolderAddress:owner,
  currentCash:{routeKey:history.identity.routeKey,destination:history.identity.destination,cashRaw:currentSource.cashRaw,assetAddress:history.identity.asset,assetDecimals:6,assetSymbol:'USDC',observedAt:currentSource.blockTime,block:currentSource.block,blockHash:currentSource.blockHash,freshness:'fresh',label:'Vault cash',readAtUtc:currentSource.readAt,sourceKind:currentSource.sourceKind},
  prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,expectedEventEnrollment:null,eventContext:null,historicalOutlook:null,
  holderAssessment:{status:'assessed',routeKey:history.identity.routeKey,destinationAddress:history.identity.destination,owner,request:{assetsRaw:'1000000',assetAddress:history.identity.asset,horizonHours:48},source:{chainId:1,blockNumber:26200000,blockHash:currentSource.blockHash as `0x${string}`,blockTime:currentSource.blockTime,finalized:true,originValidation:'two_provider'},stages:[],finalPayout:{status:'unassessed',assetAddress:history.identity.asset,amountRaw:null},forecast:{status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false},nativeCashHolderOutlook:model,nativeCashHolderOutlookIssue:issue}}
}
const render=(p:ExitPressureCardProps)=>renderToStaticMarkup(<ChakraProvider theme={theme}><ExitPressureCard {...p}/></ChakraProvider>)
const withoutStyles=(html:string)=>html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g,'')
const visibleText=(html:string)=>withoutStyles(html).replace(/<[^>]*>/g,' ').replace(/&#x27;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,' ').trim()
it('renders actual existing-card cash impact, sampled duration and adverse-flow metrics',()=>{
 const p=fixture(),html=withoutStyles(render(p))
 assert.match(html,/Conditional cash exit headroom/)
 assert.match(html,/Cash change since historical sample/)
 assert.match(html,/Matched historical recovery/)
 assert.match(html,/REQUESTED EXIT COVERED/)
 assert.match(html,/SHORTFALL/)
 assert.match(html,/Adverse flow headroom/)
 assert.match(html,/Inventory graph headroom/)
 assert.match(html,/48h own NET/)
 assert.match(visibleText(html),new RegExp(`${p.holderAssessment!.nativeCashHolderOutlook!.sparsePeerOutlook!.usableIntervals} intervals`))
 assert.match(html,/measured capacity change/)
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
 m.shrinkingAlert.shrinkingScenarios=0
 m.shrinkingAlert.usableScenarios=0
 m.shrinkingAlert.censoredScenarios=m.process.scenarios.length
 assert.ok(m.capacityChange.currentHeadroomRaw.startsWith('-'))
 assert.equal(cashHolderDurationDetail(m),' · DURATION CENSORED')
 a.nativeCashHolderOutlookIssue=retainNativeCashHolderOutlook(m,200,{routeKey:p.routeKey,destination:p.destination,owner,requestedRaw:p.requestedRaw!,asset:p.requestedAssetAddress!,assetDecimals:6,horizonHours:48,source:a.source,asOfMs:now})!
 const html=render(p)
 assert.match(html,/DURATION CENSORED/)
 assert.match(html,/data-adverse="true"/)
 assert.match(html,/var\(--m-danger\)/)
 assert.match(html,/aria-label="Adverse outlook"/)
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

it('renders retained exact owned-ticket conditional amounts and drops mismatched owner/amount/horizon',()=>{
 const {assessment:a,request:q}=saturnTicketFixture();a.forecast={status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false}
 const model=buildSaturnOwnedTicketConditionalMechanism(a,q,(original,request)=>original===a&&request===q)!
 const question={routeKey:q.routeKey,destination:q.destinationAddress,owner:q.owner,requestedRaw:q.assetsRaw,payoutAsset:q.assetAddress,horizonHours:48,asOfMs:now,ticketId:'7'}
 const p={...fixture(),routeKey:q.routeKey,destination:q.destinationAddress,requestedRaw:q.assetsRaw,requestedAssetAddress:q.assetAddress,requestedAssetSymbol:'AUSD',saturnRequestTokenId:'7',currentCash:null,holderAssessment:{...a,saturnTicketMechanism:model,saturnTicketMechanismIssue:retainSaturnTicketMechanism(model,200,a,question)}} as ExitPressureCardProps
 assert.match(render(p),/Owned ticket scenario/);assert.match(render(p),/claim fee unknown/)
 for(const patch of [{requestedHolderAddress:'0x'+'2'.repeat(40)},{requestedRaw:'2'},{horizonHours:24},{saturnRequestTokenId:'8'}])assert.doesNotMatch(render({...p,...patch}),/Owned ticket scenario/)
})

it('renders distinct own and authenticated peer alternatives with retained counts, exact elapsed and separate pace/inventory units',()=>{
 const p=fixture(),model=p.holderAssessment!.nativeCashHolderOutlook!,graph=model.sparsePeerOutlook!,peer=graph.peerAnalogScenarios!
 assert.ok(peer.matchedPeerSubjects>0);assert.ok(peer.usableIntervals>0)
 const rows=nativeInventoryAnalogueRows(model,6,'USDC'),text=visibleText(render(p))
 const ownStart=text.indexOf('Inventory graph headroom'),peerStart=text.indexOf('Peer NET analogue headroom')
 const paceStart=text.indexOf('Observed maximum NET outflow pace'),inventoryStart=text.indexOf('Whole-inventory depletion bound')
 assert.ok(ownStart>=0&&peerStart>ownStart&&paceStart>peerStart&&inventoryStart>paceStart)
 const ownText=text.slice(ownStart,peerStart),peerText=text.slice(peerStart,paceStart)
 assert.ok(ownText.includes(rows.ownDetail));assert.ok(peerText.includes(rows.peerValue));assert.ok(peerText.includes(rows.peerDetail))
 assert.ok(peerText.includes(`${peer.matchedPeerSubjects} peers`));assert.ok(peerText.includes(`${peer.usableIntervals} intervals`))
 assert.ok(peerText.includes('172860s elapsed'));assert.ok(peerText.includes('unconditioned'))
 assert.doesNotMatch(peerText,/own NET/)
 const paceText=text.slice(paceStart,inventoryStart),inventoryText=text.slice(inventoryStart)
 assert.ok(paceText.includes(rows.observedPaceValue));assert.ok(paceText.includes('USDC/h'));assert.ok(paceText.includes('Sampled own NET'))
 assert.ok(inventoryText.includes(rows.theoreticalInventoryValue));assert.ok(inventoryText.includes('Theoretical cash-only bound'))
 assert.ok(inventoryText.includes('no time guarantee'));assert.doesNotMatch(inventoryText.split('Cash change since historical sample')[0],/USDC\/h/)
})
it('refuses mismatched peer clocks, asset units, self donors and probability claims while retaining independent own evidence',()=>{
 const p=fixture(),m=p.holderAssessment!.nativeCashHolderOutlook!,q={routeKey:p.routeKey,destination:p.destination,owner,requestedRaw:p.requestedRaw!,asset:p.requestedAssetAddress!,assetDecimals:6,horizonHours:48,source:p.holderAssessment!.source,asOfMs:now}
 for(const mutate of [
  (v:typeof m)=>{v.sparsePeerOutlook!.peerAnalogScenarios!.targetAtUtc='2026-10-13T12:00:00.000Z'},
  (v:typeof m)=>{v.sparsePeerOutlook!.peerAnalogScenarios!.scenarios[0].peerIdentity.assetDecimals=18},
  (v:typeof m)=>{v.sparsePeerOutlook!.peerAnalogScenarios!.scenarios[0].peerIdentity.destination=v.identity.destination},
  (v:typeof m)=>{v.sparsePeerOutlook!.peerAnalogScenarios!.scenarios[0].historyEvidence.availableAt='2026-10-13T12:00:00.000Z'},
  (v:typeof m)=>{(v.sparsePeerOutlook!.peerAnalogScenarios as any).calibratedProbability=true},
 ]){const bad=structuredClone(m);mutate(bad);assert.equal(retainNativeCashHolderOutlook(bad,200,q),null)}
 const ownOnly=structuredClone(m);ownOnly.sparsePeerOutlook!.peerAnalogScenarios=null
 const issue=retainNativeCashHolderOutlook(ownOnly,200,q);assert.ok(issue)
 const html=visibleText(render({...p,holderAssessment:{...p.holderAssessment!,nativeCashHolderOutlook:ownOnly,nativeCashHolderOutlookIssue:issue}}))
 assert.match(html,/Inventory graph headroom/);assert.match(html,/48h own NET/)
 assert.doesNotMatch(html,/Peer NET analogue headroom/)
})
