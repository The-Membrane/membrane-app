import React from 'react'
import {it} from 'node:test'
import assert from 'node:assert/strict'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChakraProvider} from '@chakra-ui/react'
import theme from '../../theme'
import {ExitPressureCard,type ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import {issueForeignConditionalFinalExit} from '@/lib/carry/foreignFinalExitIssuer.server'
import {retainForeignFinalExit} from '@/lib/carry/foreignFinalExitReceipt'
import {foreignFinalExitFixture} from './fixtures/foreignFinalExitFixture'
import type {HolderExitAssessmentRequest} from '@/lib/carry/holderExitAssessment'
const now=Date.parse('2026-10-12T12:00:00.000Z')
const render=(p:ExitPressureCardProps)=>renderToStaticMarkup(<ChakraProvider theme={theme}><ExitPressureCard {...p}/></ChakraProvider>)
function fixture(twyne:boolean):ExitPressureCardProps{
 const {a,q}=foreignFinalExitFixture(twyne)
 a.forecast={status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false}
 const first={host:'one.example',assessment:structuredClone(a)},second={host:'two.example',assessment:structuredClone(a)}
 first.assessment.source.originValidation='single_provider';second.assessment.source.originValidation='single_provider'
 const probes={primeSharesRaw:twyne?null:a.pyusdStakingCondition!.requestedPrimeSharesRaw,ptRaw:twyne?a.twyneCondition!.requestedPtRaw:null,collateralVault:twyne?a.twyneCondition!.collateralVault:null}
 const input={...q,horizonHours:48,...(twyne?{ptRaw:probes.ptRaw,collateralVault:probes.collateralVault}:{primeSharesRaw:probes.primeSharesRaw})} as unknown as HolderExitAssessmentRequest
 const original=issueForeignConditionalFinalExit(input,first,second,now,(x,y)=>x===first&&y===second)!
 assert.ok(original)
 // Actual server issuer → serialized own response → private browser receipt → Card.
 // Current native executor values are explicitly synthetic; no live RPC claim.
 const model=JSON.parse(JSON.stringify(original)),question={routeKey:q.routeKey,destination:q.destinationAddress,owner:q.owner,requestedRaw:q.assetsRaw,payoutAsset:q.assetAddress,horizonHours:48,asOfMs:now,...probes}
 const issue=retainForeignFinalExit(model,200,a,question)
 assert.ok(issue)
 return{routeKey:q.routeKey,destination:q.destinationAddress,requestedAmount:'1',requestedRaw:q.assetsRaw,requestedAssetSymbol:twyne?'USDe':'PYUSD',requestedAssetAddress:q.assetAddress,requestedAssetDecimals:twyne?18:6,horizonHours:48,asOfMs:now,requestedHolderAddress:q.owner,...probes,currentCash:null,prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,expectedEventEnrollment:null,eventContext:null,historicalOutlook:null,holderAssessment:{...a,foreignConditionalFinalExit:model,foreignConditionalFinalExitIssue:issue}}
}
for(const twyne of [false,true]){
 it(`actual Card preserves ${twyne?'Twyne':'Hastra'} source identity when object property order changes`,()=>{
  const p=fixture(twyne),assessment={...p.holderAssessment!,source:Object.fromEntries(Object.entries(p.holderAssessment!.source).reverse()) as NonNullable<ExitPressureCardProps['holderAssessment']>['source']}
  assert.match(render({...p,holderAssessment:assessment}),/Conditional final exit/)
 })
 it(`actual Card renders retained ${twyne?'Twyne':'Hastra'} final-asset mechanism without invented parity or final payment`,()=>{
  const html=render(fixture(twyne))
  assert.match(html,/Conditional final exit/)
  if(twyne){assert.match(html,/PT → USDe/);assert.match(html,/PT simulated/);assert.match(html,/Release and conversion timing unknown/)}
  else{assert.match(html,/wYLDS → USDC → PYUSD/);assert.match(html,/2\.499999 wYLDS simulated/);assert.match(html,/Administrator timing unknown/)}
  assert.doesNotMatch(html,/Final payout confirmed|Mined final payout|guaranteed payout/i)
 })
 it(`actual Card removes ${twyne?'Twyne':'Hastra'} scenario for changed owner, Q, H, asset, source or independent native probe`,()=>{
  const p=fixture(twyne)
  const changes:Partial<ExitPressureCardProps>[]=[{requestedHolderAddress:'0x'+'2'.repeat(40)},{requestedRaw:'2'},{horizonHours:24},{requestedAssetAddress:'0x'+'3'.repeat(40)},{asOfMs:now+1800001},{scenarioMode:'initial_deposit'}]
  if(twyne)changes.push({ptRaw:'1'},{collateralVault:'0x'+'4'.repeat(40)})
  else changes.push({primeSharesRaw:'1'})
  for(const change of changes)assert.doesNotMatch(render({...p,...change}),/Conditional final exit/)
  // Preserve the real private receipt while changing the separately current source.
  const changed={...p.holderAssessment!,source:{...p.holderAssessment!.source,blockNumber:p.holderAssessment!.source.blockNumber+1}}
  assert.doesNotMatch(render({...p,holderAssessment:changed}),/Conditional final exit/)
  assert.doesNotMatch(render({...p,holderAssessment:{...p.holderAssessment!,foreignConditionalFinalExitIssue:{...p.holderAssessment!.foreignConditionalFinalExitIssue!}}}),/Conditional final exit/)
 })
}
