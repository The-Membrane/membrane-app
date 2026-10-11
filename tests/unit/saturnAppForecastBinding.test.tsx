import React from 'react'
import {ChakraProvider} from '@chakra-ui/react'
import {renderToStaticMarkup} from 'react-dom/server'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {describe,it,expect} from 'vitest'
import {saturnNativeEvidenceDigest,saturnAppForecastFromResponse,saturnAppForecastIssue,selectedSaturnAppForecastFromIssue,type SaturnForecastEnvelope} from '@/lib/carry/saturnAppForecastEvidence'
import {SATURN_ORIGINAL_CONVERSION_PROFILE as P} from '@/lib/carry/saturnOriginalConversionProfile'
import {ExitPressureCard,saturnConditionalQuoteWindowLabel} from '@/components/Carry/ExitPressureCard'
import {holderSaturnForecastIssueFromResponse} from '@/components/Carry/ForecastWorkbench'
const bytes=readFileSync('data/research/venue-signals/saturn-historical-conversion-2026-10-07T13-47.export-v2.json')
if(createHash('sha256').update(bytes).digest('hex')!=='9da2858f4710dbfdb636b49038be8a3fbc672a26491a7d31d85af1ee65d9b08b')throw Error('fixture_original_export_pin')
const saved=JSON.parse(bytes.toString('utf8'))
const SYNTHETIC_OWNER='0x1111111111111111111111111111111111111111'
const PUBLIC_REQUEST_OWNER='0x2222222222222222222222222222222222222222'
function fixture(owned=true){
 const c=structuredClone(saved.current),h=structuredClone(saved.history),time=Date.parse(c.readAtUtc)
 // Only headers, code/units and clocks come from retained bytes. These owner/record reads are synthetic controls, not an acquisition proof.
 const t={...structuredClone(saved.current.point.ticket),owner:SYNTHETIC_OWNER,reportedOwner:SYNTHETIC_OWNER,locatorOwnerMatches:true,ticketId:'9000001',status:0}
 c.point.ticket=owned?t:null
 h.points.forEach((p:{ticket:unknown})=>{p.ticket=null});h.knowledgeCutoff=c.readAtUtc
 if(!owned){c.claimSimulation='unassessed';c.claimReturnUsdatRaw=null;c.physicalPullableUsdatRaw=null}
 for(const v of [c,h]){const {captureReceiptSha256:_,...body}=v;v.captureReceiptSha256=saturnNativeEvidenceDigest(body)}
 const question={routeKey:'AUSD → Staked USDat [USDat]',destination:'0xd166337499e176bbc38a1fbd113ab144e5bd2df7',owner:owned?SYNTHETIC_OWNER:PUBLIC_REQUEST_OWNER,ticketId:owned?t.ticketId:null,requestedRaw:'40000000',horizonHours:4,asOfMs:time}
 const row={current:c,history:h,queueFacts:{vaultCashUsdatRaw:'50000000',queueCashUsdatRaw:'99999999',change:null,source:c.point.source},ownedTicket:owned},e:SaturnForecastEnvelope={schema:'saturn_exact_size_native_quote_forecast_v1',originalCaptureSha256:P.rawCaptureSha256,issuedAtMs:time,question,origins:[{host:'eth-mainnet.g.alchemy.com',...structuredClone(row)},{host:'rpc.ankr.com',...structuredClone(row)}]}
 const response={routeKey:question.routeKey,destinationAddress:question.destination,owner:question.owner,source:{chainId:1,blockNumber:Number(c.point.source.blockNumber),blockHash:c.point.source.blockHash,blockTime:c.point.source.blockTime,originValidation:'two_provider'},request:{assetsRaw:question.requestedRaw,assetAddress:'0x00000000efe302beaa2b3e6e1b18d08d69a9012a',horizonHours:4,requestTokenId:owned?t.ticketId:undefined},stakedUsdatCondition:{existingTicketOwnership:owned?'holder':'not_found',existingTicketId:t.ticketId,existingTicketRecordedRequest:{sharesRaw18:t.sharesRaw18,usdatOwedRaw6:t.usdatOwedRaw6,requestedAtUnix:t.requestedAtUnix,minSharePriceRaw:t.minSharePriceRaw,rawStatus:t.status},existingTicketConversionQuote:{usdatInputRaw:c.input.usdatInputRaw,usdcQuotedRaw:c.point.usdcQuotedRaw,ausdQuotedRaw:c.point.ausdQuotedRaw},existingTicketClaimStatus:c.claimSimulation,existingTicketConversionBasis:'recorded_owed_if_delivered',existingTicketConversionFeeStatus:'unknown'},saturnHolderForecastEvidence:e}
 const {asOfMs:_,...q}=question;return {response,q,time}
}
function expectValidBaseline(f:ReturnType<typeof fixture>){
 const model=saturnAppForecastFromResponse(f.response,200,f.q,f.time)
 expect(model).not.toBeNull()
 expect(f.time-Date.parse(f.response.saturnHolderForecastEvidence.origins[0].current.point.source.blockTime)).toBe(1030882)
 return model!
}
describe('Saturn original API response → Workbench receipt boundary',()=>{
 it('keeps useful whole-ticket conversion with unknown funding and historical owners absent',()=>{const f=fixture(),model=expectValidBaseline(f);expect(model).not.toBeNull();expect(model.holderEntitlementEstablished).toBe(true);expect(model.funding.particularTicket).toBe('unknown');expect(model.funding.aggregateCashIsTicketFunding).toBe(false);expect(model.funding.netCompetingFlow).toBe('unknown');expect(model.holderExecutableExit).toBe(false);expect(model.targetAt).toBe(new Date(f.time+4*3600000).toISOString());expect(model.futureMarketPriceBounded).toBe(false)})
 it('admits separately labeled native exact-size public scenario with no current ticket',()=>{const f=fixture(false),model=expectValidBaseline(f);expect(model.scope).toBe('hypothetical_exact_USDat_input_public_conversion_quote');expect(model.conversion).toBeNull();expect(model.holderEntitlementEstablished).toBe(false);expect(model.conversionInputUsdatRaw).toBe('42103198')})
 it('retains only the original Workbench receipt; cloned receipts/models do not select',()=>{const f=fixture();expectValidBaseline(f);const issue=holderSaturnForecastIssueFromResponse(f.response,200,f.q,f.time)!;expect(issue).not.toBeNull();expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time)).not.toBeNull();expect(selectedSaturnAppForecastFromIssue(structuredClone(issue),f.q,f.time)).toBeNull();const model=expectValidBaseline(f);expect(saturnAppForecastIssue(structuredClone(model))).toBeNull()})
 it('rejects Q,H,owner,ticket changes, expiry and render before issue',()=>{const f=fixture(),m=expectValidBaseline(f),issue=saturnAppForecastIssue(m)!;for(const q of [{...f.q,requestedRaw:'1'},{...f.q,horizonHours:1},{...f.q,ticketId:'2'},{...f.q,owner:`0x${'a'.repeat(40)}`}])expect(selectedSaturnAppForecastFromIssue(issue,q,f.time)).toBeNull();expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time-1)).toBeNull();expect(selectedSaturnAppForecastFromIssue(issue,f.q,Date.parse(m.funding.source.blockTime)+1800001)).toBeNull()})
 it('rejects altered origin amount, runtime regime, source, proof digest and ownership flag',()=>{for(const key of ['quote','runtime','source','digest','owner'] as const){const f=fixture();expectValidBaseline(f);const r=f.response.saturnHolderForecastEvidence.origins[1];if(key==='quote')r.current.point.ausdQuotedRaw='1';if(key==='runtime')r.history.points[0].runtimeCodeHashes.curve=`0x${'0'.repeat(64)}`;if(key==='source')r.current.point.source.blockHash=`0x${'0'.repeat(64)}`;if(key==='digest')r.history.captureReceiptSha256='0'.repeat(64);if(key==='owner')r.ownedTicket=false;expect(saturnAppForecastFromResponse(f.response,200,f.q,f.time)).toBeNull()}})
 it('rejects current source B rebound and current record/fee basis mismatch',()=>{for(const field of ['source','record','fee'] as const){const f=fixture();expectValidBaseline(f);if(field==='source')f.response.source.blockNumber++;if(field==='record')f.response.stakedUsdatCondition.existingTicketRecordedRequest.sharesRaw18='1';if(field==='fee')f.response.stakedUsdatCondition.existingTicketConversionBasis='claim_return';expect(saturnAppForecastFromResponse(f.response,200,f.q,f.time)).toBeNull()}})
 it('rechecks the original model after a nested caller mutation',()=>{const f=fixture(),m=expectValidBaseline(f),issue=saturnAppForecastIssue(m)!;(m.scenarios[0] as {quotedFinalAusdRaw:string}).quotedFinalAusdRaw='1';expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time)).toBeNull()})
 it('admits failed optional original quote followed by independently acquired native exact-size quote',()=>{
   const f=fixture();expectValidBaseline(f);const condition=f.response.stakedUsdatCondition as {existingTicketConversionQuote?:unknown;existingTicketConversionBasis:string|null}
   delete condition.existingTicketConversionQuote;condition.existingTicketConversionBasis=null
   expect(saturnAppForecastFromResponse(f.response,200,f.q,f.time)).not.toBeNull()
   const mismatch=fixture();expectValidBaseline(mismatch);mismatch.response.stakedUsdatCondition.existingTicketConversionQuote.ausdQuotedRaw='1'
   expect(saturnAppForecastFromResponse(mismatch.response,200,mismatch.q,mismatch.time)).toBeNull()
   const wrongBasis=fixture();expectValidBaseline(wrongBasis);wrongBasis.response.stakedUsdatCondition.existingTicketConversionBasis='claim_return'
   expect(saturnAppForecastFromResponse(wrongBasis.response,200,wrongBasis.q,wrongBasis.time)).toBeNull()
 })
 it('never promotes a successful net claim return into physical pullable cash',()=>{
   const f=fixture();expectValidBaseline(f);const e=f.response.saturnHolderForecastEvidence
   // Synthetic native-call outputs exercise fee and cash boundaries; they are not a runtime acquisition proof.
   for(const r of e.origins){r.current.claimSimulation='success';r.current.claimReturnUsdatRaw='40000000';r.current.entitlementMethod='claim_return';r.current.physicalPullableUsdatRaw=null;r.current.input.usdatInputRaw='40000000';r.history.input.usdatInputRaw='40000000';r.current.point.usdcQuotedRaw='40000000';r.current.point.ausdQuotedRaw='39900000';r.history.points[0].usdcQuotedRaw='40000000';r.history.points[0].ausdQuotedRaw='39000000';r.history.points[1].usdcQuotedRaw='40000000';r.history.points[1].ausdQuotedRaw='39500000';for(const v of [r.current,r.history]){const {captureReceiptSha256:_,...body}=v;v.captureReceiptSha256=saturnNativeEvidenceDigest(body)}}
   const c=f.response.stakedUsdatCondition;c.existingTicketClaimStatus='success';c.existingTicketConversionBasis='claim_return';c.existingTicketConversionQuote={usdatInputRaw:'40000000',usdcQuotedRaw:'40000000',ausdQuotedRaw:'39900000'}
   const model=expectValidBaseline(f)
   expect(model).not.toBeNull();expect(model.funding.simulatedClaimReturnUsdatRaw).toBe('40000000');expect(model.funding.pullableUsdatRaw).toBeNull();expect(model.funding.aggregateCashIsTicketFunding).toBe(false)
   for(const r of e.origins){r.current.physicalPullableUsdatRaw='40000000';const {captureReceiptSha256:_,...body}=r.current;r.current.captureReceiptSha256=saturnNativeEvidenceDigest(body)}
   expect(saturnAppForecastFromResponse(f.response,200,f.q,f.time)).toBeNull()
 })
 it('renders four actual Card metrics only for the original receipt, with no other forecast props',()=>{
   const f=fixture();expectValidBaseline(f);const issue=holderSaturnForecastIssueFromResponse(f.response,200,f.q,f.time)!,model=selectedSaturnAppForecastFromIssue(issue,f.q,f.time)!
   const render=(receipt:typeof issue)=>renderToStaticMarkup(<ChakraProvider><ExitPressureCard routeKey={f.q.routeKey} destination={f.q.destination} requestedAmount="40" requestedRaw={f.q.requestedRaw} requestedAssetSymbol="AUSD" requestedAssetAddress="0x00000000efe302beaa2b3e6e1b18d08d69a9012a" requestedAssetDecimals={6} requestedHolderAddress={f.q.owner} horizonHours={f.q.horizonHours} asOfMs={f.time} currentCash={null} prospectiveCashModel={null} historicalScenario={null} grossWithdrawals={null} grossInflows={null} historicalGrossFlow={null} morphoPayout={null} holderAssessment={null} expectedEventEnrollment={null} eventContext={null} historicalOutlook={null} holderSaturnForecastIssue={receipt} saturnRequestTokenId={f.q.ticketId}/></ChakraProvider>)
   const html=render(issue);expect(html).toContain('CONDITIONAL CONVERSION');expect(html).toContain('Projected AUSD');expect(html).toContain('Adequate conversion window');expect(html).toContain('Ticket funding');expect(html).toContain(saturnConditionalQuoteWindowLabel(model).replaceAll('→','→'));expect(html).not.toContain('Aggregate vault net cash · assumed horizon')
   expect(render(structuredClone(issue))).not.toContain('CONDITIONAL CONVERSION')
 })
 it('keeps displayed short adequate intervals inside their integer millisecond boundaries',()=>{
   const f=fixture(),m=expectValidBaseline(f)
   const short={...m,issuedAtMs:Date.parse('2026-10-07T13:47:09.500Z'),conditionalQuoteWindow:{firstElapsedMs:1,lastElapsedMs:499}}
   expect(saturnConditionalQuoteWindowLabel(short)).toBe('2026-10-07 13:47:09.501 UTC → 2026-10-07 13:47:09.999 UTC')
 })

 it('rejects the original missing-owner ticket export rather than minting holder entitlement',()=>{
   const f=fixture();expectValidBaseline(f)
   const original=saved.current.point.ticket
   f.q.ticketId=original.ticketId;f.response.request.requestTokenId=original.ticketId;f.response.stakedUsdatCondition.existingTicketId=original.ticketId;f.response.stakedUsdatCondition.existingTicketRecordedRequest.rawStatus=original.status;f.response.saturnHolderForecastEvidence.question.ticketId=original.ticketId
   for(const row of f.response.saturnHolderForecastEvidence.origins){row.current.point.ticket=structuredClone(original);const {captureReceiptSha256:_,...body}=row.current;row.current.captureReceiptSha256=saturnNativeEvidenceDigest(body)}
   expect(saved.current.point.ticket.owner).toBeNull();expect(saved.current.point.ticket.status).toBe(4)
   expect(saturnAppForecastFromResponse(f.response,200,f.q,f.time)).toBeNull()
 })
 it('admits reordered question keys without accepting changed values, extra keys or cloned receipts',()=>{
   const f=fixture();expectValidBaseline(f)
   const reordered={horizonHours:f.q.horizonHours,requestedRaw:f.q.requestedRaw,ticketId:f.q.ticketId,owner:f.q.owner,destination:f.q.destination,routeKey:f.q.routeKey}
   expect(Object.keys(reordered)).not.toEqual(Object.keys(f.q))
   const model=saturnAppForecastFromResponse(f.response,200,reordered,f.time)
   expect(model).not.toBeNull()
   const issue=saturnAppForecastIssue(model!)!
   expect(issue).not.toBeNull()
   expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time)).not.toBeNull()
   expect(selectedSaturnAppForecastFromIssue(issue,reordered,f.time)).not.toBeNull()
   for(const expected of [{...reordered,requestedRaw:'1'},{...reordered,horizonHours:1},{...reordered,ticketId:'2'},{...reordered,meaningfulExtra:'changed'}])expect(selectedSaturnAppForecastFromIssue(issue,expected,f.time)).toBeNull()
   expect(selectedSaturnAppForecastFromIssue(structuredClone(issue),reordered,f.time)).toBeNull()
   // Serialized proof digests continue to bind the original property order.
   const current=f.response.saturnHolderForecastEvidence.origins[0].current
   const {captureReceiptSha256:_,...body}=current
   const entries=Object.entries(body)
   expect(saturnNativeEvidenceDigest(Object.fromEntries(entries.reverse()))).not.toBe(saturnNativeEvidenceDigest(body))
 })

 it('rejects an altered expected question with a callable toJSON without calling it',()=>{
   const f=fixture(),model=expectValidBaseline(f),issue=saturnAppForecastIssue(model)!
   expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time)).not.toBeNull()
   let called=false
   const expected={...f.q,requestedRaw:'1',toJSON(){called=true;return f.q}}
   expect(selectedSaturnAppForecastFromIssue(issue,expected,f.time)).toBeNull()
   expect(called).toBe(false)
 })
 it('rejects a mutated original model with a pristine toJSON hook without calling it',()=>{
   const f=fixture(),model=expectValidBaseline(f),issue=saturnAppForecastIssue(model)!
   expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time)).not.toBeNull()
   const scenario=model.scenarios[0] as {quotedFinalAusdRaw:string;toJSON?:()=>unknown},pristine={...scenario}
   let called=false;scenario.quotedFinalAusdRaw='1';scenario.toJSON=()=>{called=true;return pristine}
   expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time)).toBeNull()
   expect(called).toBe(false)
 })
 it('rejects non-JSON expected fields and accessors while retaining an admitted original control',()=>{
   const f=fixture(),model=expectValidBaseline(f),issue=saturnAppForecastIssue(model)!
   expect(selectedSaturnAppForecastFromIssue(issue,f.q,f.time)).not.toBeNull()
   const cycle:Record<string,unknown>={};cycle.self=cycle
   const sparse=new Array(1),custom=['x'];Object.defineProperty(custom,'extra',{value:'hidden'})
   for(const bad of [undefined,()=>0,Symbol('x'),1n,NaN,Infinity,cycle,new Date(),sparse,custom])
     expect(selectedSaturnAppForecastFromIssue(issue,{...f.q,extra:bad},f.time)).toBeNull()
   let called=false
   const accessor={...f.q};Object.defineProperty(accessor,'requestedRaw',{enumerable:true,get(){called=true;return f.q.requestedRaw}})
   expect(selectedSaturnAppForecastFromIssue(issue,accessor,f.time)).toBeNull();expect(called).toBe(false)
 })

 it('selects private pristine facts when a stored scenario Proxy lies only through get',()=>{
   const f=fixture(),model=expectValidBaseline(f),issue=saturnAppForecastIssue(model)!
   const admitted=selectedSaturnAppForecastFromIssue(issue,f.q,f.time)!
   expect(admitted).not.toBeNull()
   const pristineAmount=admitted.scenarios[0].quotedFinalAusdRaw
   const original=model.scenarios[0]
   const proxy=new Proxy(original,{get(target,key,receiver){return key==='quotedFinalAusdRaw'?'1':Reflect.get(target,key,receiver)}})
   ;(model.scenarios as {quotedFinalAusdRaw:string}[])[0]=proxy
   expect(model.scenarios[0].quotedFinalAusdRaw).toBe('1')
   const selected=selectedSaturnAppForecastFromIssue(issue,f.q,f.time)!
   expect(selected).not.toBeNull();expect(selected.scenarios[0].quotedFinalAusdRaw).toBe(pristineAmount)
   expect(selected.scenarios[0].quotedFinalAusdRaw).not.toBe('1')
   expect(saturnAppForecastIssue(selected)).toBeNull()
   expect(selectedSaturnAppForecastFromIssue(structuredClone(issue),f.q,f.time)).toBeNull()
   expect(selectedSaturnAppForecastFromIssue(issue,{...f.q,requestedRaw:'1'},f.time)).toBeNull()
 })
 it('never aliases a prior selected amount, source clock or question into private future selections',()=>{
   const f=fixture(),model=expectValidBaseline(f),issue=saturnAppForecastIssue(model)!
   const first=selectedSaturnAppForecastFromIssue(issue,f.q,f.time)!
   expect(first).not.toBeNull()
   const amount=first.scenarios[0].quotedFinalAusdRaw,sourceTime=first.funding.source.blockTime,Q=first.question.requestedRaw
   ;(first.scenarios[0] as {quotedFinalAusdRaw:string}).quotedFinalAusdRaw='1'
   first.funding.source.blockTime='2099-01-01T00:00:00.000Z';first.question.requestedRaw='1'
   const second=selectedSaturnAppForecastFromIssue(issue,f.q,f.time)!
   expect(second).not.toBeNull();expect(second).not.toBe(first)
   expect(second.scenarios[0].quotedFinalAusdRaw).toBe(amount);expect(second.funding.source.blockTime).toBe(sourceTime);expect(second.question.requestedRaw).toBe(Q)
   expect(second.scenarios[0]).not.toBe(first.scenarios[0]);expect(second.funding.source).not.toBe(first.funding.source);expect(second.question).not.toBe(first.question)
   expect(saturnAppForecastIssue(first)).toBeNull();expect(saturnAppForecastIssue(second)).toBeNull()
   expect(selectedSaturnAppForecastFromIssue(issue,f.q,Date.parse(sourceTime)+1800001)).toBeNull()
 })

})
