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
import type{CompoundInitialDepositFacts}from'@/lib/carry/compoundInitialDeposit'
import {loadPinnedAudit} from '../../scripts/research/conditional-cash-time-holdout.mjs'
const now=Date.parse('2026-10-12T12:00:00.000Z'),at=new Date(now).toISOString(),owner='0x0000000000000000000000000000000000000001'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const render=(p:ExitPressureCardProps)=>renderToStaticMarkup(<ChakraProvider theme={theme}><ExitPressureCard {...p}/></ChakraProvider>)
function fixture(depositAmount:string,missingAccount=false){
 const history=Object.values(loadPinnedAudit().histories).find((h:any)=>h.identity.routeKey==='USDC → supply on Compound v3') as ConditionalSampledCashHistory
 const s={...history.identity,chainId:1 as const,cashRaw:'100000000',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at,sourceKind:'live_read_only_two_origin_finalized' as const}
 const q=initialDepositQuestion('initial_deposit',s.routeKey,s.destination,depositAmount,'1',48,owner)!
 const daily=buildConditionalSampledCashPathProjection({history,currentSource:s,request:{requestedRaw:q.plannedExitAssetsRaw,asOf:at}},hash)
 // Actual Card/rebuild with genuine history and explicitly synthetic receiver native facts.
 const facts:CompoundInitialDepositFacts={comet:s.destination,asset:s.asset,assetDecimals:6,baseSupplyIndexRaw:'1000000000000000',supplyPaused:false,receiver:owner,
 accountStatus:missingAccount?'unavailable':'quoted',receiverPrincipalRaw:missingAccount?null:'-10000000',baseBorrowIndexRaw:missingAccount?null:'1000000000000000'}
 const nativeAgreement={status:'agreed_compound_initial_deposit_facts',currentSource:s,readAt:at,origins:[{originHostSha256:'a'.repeat(64),facts},{originHostSha256:'b'.repeat(64),facts:structuredClone(facts)}]}
 const projection=buildInitialDepositCapacityProjection({currentSource:s,dailyProjection:daily,depositAssetsRaw:q.depositAssetsRaw,plannedExitAssetsRaw:q.plannedExitAssetsRaw,horizonHours:48,asOfMs:now,receiver:owner,nativeAgreement},hash)
 assert.equal(projection.status,'conditional_initial_deposit_projection')
 const issue=initialDepositIssueFromResponse({routeKey:s.routeKey,destination:s.destination,initialDepositProjection:projection,conditionalSampledCashPathProjection:daily},q,now,now)
 assert.ok(issue)
 const props:ExitPressureCardProps={routeKey:s.routeKey,destination:s.destination,requestedAmount:'1',requestedRaw:'1000000',requestedAssetSymbol:'USDC',requestedAssetAddress:s.asset,requestedAssetDecimals:6,horizonHours:48,asOfMs:now,requestedHolderAddress:owner,
 scenarioMode:'initial_deposit',depositAmount,initialDepositIssue:issue,
 currentCash:{routeKey:s.routeKey,destination:s.destination,cashRaw:s.cashRaw,assetAddress:s.asset,assetDecimals:6,assetSymbol:'USDC',observedAt:at,block:s.block,blockHash:s.blockHash,freshness:'fresh',label:'Comet cash',readAtUtc:at,sourceKind:s.sourceKind},
 prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,holderAssessment:null,expectedEventEnrollment:null,eventContext:null,historicalOutlook:null}
 return props
}
it('actual Card shows debt repayment before new credit, preserving receiver/Q/D/source binding',()=>{
 for(const [d,credit]of[['9','0'],['10','0'],['11','1']]){
 const p=fixture(d),html=render(p)
 assert.match(html,new RegExp(`Hypothetical receipt ${credit} USDC`))
 assert.match(html,/Projected exit headroom/);assert.match(html,/Admission unknown/)
 assert.doesNotMatch(html,new RegExp(`Hypothetical receipt ${d} USDC`))
 }
 const p=fixture('11')
 for(const patch of[{requestedHolderAddress:'0x'+'2'.repeat(40)},{depositAmount:'12'},{requestedAmount:'2',requestedRaw:'2000000'},{horizonHours:24}]){
 const html=render({...p,...patch});assert.match(html,/Deposit outlook unassessed/);assert.doesNotMatch(html,/Hypothetical receipt 1 USDC/)
 }
 const changed={...p,currentCash:{...p.currentCash!,block:'26200001'}}
 assert.doesNotMatch(render(changed),/Hypothetical receipt 1 USDC/)
})
it('actual Card keeps aggregate cash projection while withholding unknown receiver credit',()=>{
 const html=render(fixture('11',true))
 assert.match(html,/Receipt unassessed · cash only/);assert.match(html,/Projected cash headroom/)
 assert.match(html,/Admission unknown/);assert.doesNotMatch(html,/Hypothetical receipt|Projected exit headroom/)
})
