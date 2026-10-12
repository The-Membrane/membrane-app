import {retainForeignInitialDepositProjection,selectedForeignInitialDepositProjection} from '@/lib/carry/foreignInitialDepositProjectionReceipt'
import {enrollForeignInitialDepositNativeReceipt,type ForeignInitialDepositMethodOrigin} from '@/lib/carry/foreignInitialDepositNativeEnrollment'
import{it,expect}from'vitest'
import{FOREIGN_INITIAL_DEPOSIT_MECHANISMS,buildForeignInitialDepositProjection,foreignInitialDepositRateScenario,type ForeignInitialDepositQuestion,type ForeignInitialDepositNativeReceipt,type ForeignInitialDepositAcquisition}from'@/lib/carry/foreignInitialDepositProjection'
const at='2026-10-12T12:00:00.000Z'
function input(m:typeof FOREIGN_INITIAL_DEPOSIT_MECHANISMS[number]=FOREIGN_INITIAL_DEPOSIT_MECHANISMS[0]){
 const question:ForeignInitialDepositQuestion={routeKey:m.routeKey,destination:m.destination,originalDeposit:{asset:m.finalAsset,decimals:m.finalDecimals,raw:'3333000'},nativeDepositRaw:'1000000000000000000',nativeDecimals:m.nativeDecimals,plannedFinalExitRaw:'900000',finalDecimals:m.finalDecimals,receiver:null,horizonHours:48,issuedAtUtc:at,source:{chainId:1,block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at}}
 const nativeReceipt:ForeignInitialDepositNativeReceipt={question,nativeAsset:m.nativeAsset,mintedSharesRaw:'1000000000000000000',shareDecimals:m.shareDecimals,fullNativeEntitlementRaw:'1000000000000000000',maxDepositRaw:null,maxDepositStatus:'not_requested',acquiredAtUtc:at,origins:['a'.repeat(64),'b'.repeat(64)],method:'previewDeposit_D_then_previewRedeem_full_minted_S',evidenceRefs:['synthetic_two_origin_receipt_not_live_contract_support']}
 const facts=(host:string):ForeignInitialDepositMethodOrigin=>({hostSha256:host.repeat(64),source:question.source,deploymentReceiptSha256:'c'.repeat(64),runtimeCodeHash:'0x'+'d'.repeat(64),vault:m.destination,asset:m.nativeAsset,assetDecimals:m.nativeDecimals,shareDecimals:m.shareDecimals,previewDeposit:{inputRaw:question.nativeDepositRaw,outputSharesRaw:nativeReceipt.mintedSharesRaw,receiptSha256:'e'.repeat(64)},previewRedeem:{inputSharesRaw:nativeReceipt.mintedSharesRaw,outputAssetsRaw:nativeReceipt.fullNativeEntitlementRaw,receiptSha256:'f'.repeat(64)},maxDeposit:{receiver:null,outputRaw:null,status:'not_requested',receiptSha256:null}})
 const origins=[facts('a'),facts('b')] as const
 const enrolled=enrollForeignInitialDepositNativeReceipt(question,origins,at,(q,o)=>q===question&&o===origins)!
 const conversion=foreignInitialDepositRateScenario(enrolled,m.finalAsset,{numeratorFinalRaw:'1000000',denominatorNativeRaw:'1000000000000000000',feeFinalRaw:'10000',provenanceRef:'explicit_test_rate_scenario_not_venue_quote',assumptions:['all_original_asset_acquisition_and_settlement_legs_conditionally_complete']})
 const nativeAcquisition:ForeignInitialDepositAcquisition={kind:'declared_original_to_native_funding_scenario',inputAsset:m.finalAsset,inputDecimals:m.finalDecimals,inputRaw:question.originalDeposit.raw,outputAsset:m.nativeAsset,outputDecimals:m.nativeDecimals,outputRaw:question.nativeDepositRaw,source:question.source,availableAtUtc:at,provenanceRef:'explicit_research_test_funding_assumption_not_acquisition_quote',declaredBy:'research',assumptions:['original_to_native_acquisition_and_funding_not_executed']}
 return{question,nativeAcquisition,nativeReceipt:enrolled,conversion,origins}
}
it('preserves four foreign native/final dimensions and computes only explicitly declared conditional conversion',()=>{
 expect(FOREIGN_INITIAL_DEPOSIT_MECHANISMS).toHaveLength(4)
 for(const m of FOREIGN_INITIAL_DEPOSIT_MECHANISMS){const i=input(m),r=buildForeignInitialDepositProjection(i,v=>v===i)!
 expect(r.firstLeg.nativeAsset).not.toBe(r.finalAsset.asset)
 expect(r.firstLeg.depositRaw).toBe('1000000000000000000');expect(r.finalAsset.conditionalOutputRaw).toBe('990000')
 expect(r.finalAsset.conditionalHeadroomRaw).toBe('90000');expect(r.finalAsset.basis).toBe('explicit_conditional_rate_fee_scenario')
 expect(r.originalLabelDepositAcquisition).toBe('declared_funding_scenario_only');expect(r.depositAdmitted).toBe(false)
 expect(r.holderExecutableExit).toBe(false);expect(r.duration.mechanicalEarliestAt).toBeNull()
 }} )
it('requires original qualification and separate exact quote approval; never rescales a sized quote',()=>{
 const i=input();expect(buildForeignInitialDepositProjection(i,()=>false)).toBeNull()
 const c={...i.conversion!,kind:'exact_source_quote' as const}
 i.conversion=c
 expect(buildForeignInitialDepositProjection(i,()=>true)).toBeNull()
 expect(buildForeignInitialDepositProjection(i,()=>true,v=>v===c)).not.toBeNull()
 c.inputRaw='999999999999999999'
 expect(buildForeignInitialDepositProjection(i,()=>true,()=>true)).toBeNull()
})
it('does not create native receipts, queue states or numeric final capacity when first leg remains pending',()=>{
 const i=input(),r=buildForeignInitialDepositProjection({...i,nativeAcquisition:null,nativeReceipt:null,conversion:null},()=>true)!
 expect(r.firstLeg.receiptStatus).toBe('required_native_preview_pending')
 expect(r.finalAsset.conditionalOutputRaw).toBeNull();expect(r.firstLeg.admission).toBe('unknown')
 expect(r.mechanism.legs).toContain('operator_processing_and_USDat_claim')
})
it('rejects future receipts, different block/units/question binding and duplicate origin qualification',()=>{
 const i=input();i.nativeReceipt.acquiredAtUtc='2026-10-12T12:00:01.000Z'
 expect(buildForeignInitialDepositProjection(i,()=>true)).toBeNull()
 const j=input();j.nativeReceipt.origins[1]=j.nativeReceipt.origins[0]
 expect(buildForeignInitialDepositProjection(j,()=>true)).toBeNull()
 const k=input();k.conversion!.source={...k.question.source,block:'26200001'}
 expect(buildForeignInitialDepositProjection(k,()=>true)).toBeNull()
 const l=input();l.nativeReceipt.question={...l.question,nativeDecimals:6}
 expect(buildForeignInitialDepositProjection(l,()=>true)).toBeNull()
})

it('rejects serialized native receipts and unqualified or mismatched deployed-method enrollment',()=>{
 const i=input()
 expect(buildForeignInitialDepositProjection({...i,nativeReceipt:structuredClone(i.nativeReceipt)},()=>true)).toBeNull()
 expect(enrollForeignInitialDepositNativeReceipt(i.question,i.origins,at,()=>false)).toBeNull()
 for(const mutate of [
  (o:ForeignInitialDepositMethodOrigin)=>{o.previewDeposit.inputRaw='1'},
  (o:ForeignInitialDepositMethodOrigin)=>{o.previewRedeem.inputSharesRaw='1'},
  (o:ForeignInitialDepositMethodOrigin)=>{o.previewRedeem.outputAssetsRaw='1'},
  (o:ForeignInitialDepositMethodOrigin)=>{o.runtimeCodeHash='0x'+'e'.repeat(64)},
  (o:ForeignInitialDepositMethodOrigin)=>{o.source={...o.source,block:'26200001'}},
 ]) {const origins=structuredClone(i.origins) as [ForeignInitialDepositMethodOrigin,ForeignInitialDepositMethodOrigin];mutate(origins[1]);expect(enrollForeignInitialDepositNativeReceipt(i.question,origins,at,()=>true)).toBeNull()}
})
it('rejects protocol units and never infers current deposit admission from native preview methods',()=>{
 const i=input(),wrong={...i.question,nativeDecimals:18}
 expect(buildForeignInitialDepositProjection({...i,question:wrong},()=>true)).toBeNull()
 const receiver='0x'+'1'.repeat(40),question={...i.question,receiver}
 const origins=structuredClone(i.origins) as [ForeignInitialDepositMethodOrigin,ForeignInitialDepositMethodOrigin]
 for(const o of origins)o.maxDeposit={receiver,outputRaw:'1',status:'quoted',receiptSha256:'a'.repeat(64)}
 const nativeReceipt=enrollForeignInitialDepositNativeReceipt(question,origins,at,()=>true)!
 const model=buildForeignInitialDepositProjection({question,nativeAcquisition:i.nativeAcquisition,nativeReceipt,conversion:null},()=>true)!
 expect(model.firstLeg.admission).toBe('source_receiver_cap_blocks')
 expect(model.depositAdmitted).toBe(false);expect(model.allIntermediateLegsExecutable).toBe(false)
})

it('retains successful transport against exact native D/final Q/source/H and rejects copy, change or expiry',()=>{
 const i=input(),model=buildForeignInitialDepositProjection(i,()=>true)!,now=Date.parse(at)
 const issue=retainForeignInitialDepositProjection(model,200,i.question,now)!
 expect(issue).not.toBeNull();expect(retainForeignInitialDepositProjection(model,503,i.question,now)).toBeNull()
 expect(selectedForeignInitialDepositProjection({...issue},i.question,now)).toBeNull()
 const reordered={...i.question,source:Object.fromEntries(Object.entries(i.question.source).reverse()) as typeof i.question.source}
 expect(selectedForeignInitialDepositProjection(issue,reordered,now)).not.toBeNull()
 for(const patch of [{originalDeposit:{...i.question.originalDeposit,raw:'1'}},{nativeDepositRaw:'1'},{plannedFinalExitRaw:'1'},{horizonHours:24},{receiver:'0x'+'1'.repeat(40)},{source:{...i.question.source,block:'26200001'}}])
 expect(selectedForeignInitialDepositProjection(issue,{...i.question,...patch},now)).toBeNull()
 expect(selectedForeignInitialDepositProjection(issue,i.question,now+1800001)).toBeNull()
 const selected=selectedForeignInitialDepositProjection(issue,i.question,now)!
 selected.finalAsset.conditionalOutputRaw='1'
 expect(selectedForeignInitialDepositProjection(issue,i.question,now)).toBeNull()
 const rebound=structuredClone(model);rebound.firstLeg.depositRaw='1'
 expect(retainForeignInitialDepositProjection(rebound,200,i.question,now)).toBeNull()
})

it('binds original UI D and native D independently and forbids reverse or unqualified acquisition quotes',()=>{
 const i=input(FOREIGN_INITIAL_DEPOSIT_MECHANISMS[3]),model=buildForeignInitialDepositProjection(i,()=>true)!
 expect(model.question.originalDeposit.asset).toBe(i.question.originalDeposit.asset)
 expect(model.question.originalDeposit.raw).toBe('3333000')
 expect(model.firstLeg.depositRaw).toBe('1000000000000000000')
 expect(model.nativeAcquisition.direction).toBe('original_route_asset_to_native_deposit_asset')
 expect(model.originalAssetAcquisitionQualified).toBe(false)
 for(const patch of [
  {inputRaw:i.question.nativeDepositRaw},
  {outputRaw:i.question.originalDeposit.raw},
  {inputAsset:i.nativeAcquisition.outputAsset,outputAsset:i.nativeAcquisition.inputAsset},
  {inputDecimals:18},{outputDecimals:18},
  {source:{...i.question.source,block:'26200001'}},
  {availableAtUtc:'2026-10-12T12:00:01.000Z'},
  {provenanceRef:''},{declaredBy:null},
 ]) expect(buildForeignInitialDepositProjection({...i,nativeAcquisition:{...i.nativeAcquisition,...patch} as ForeignInitialDepositAcquisition},()=>true)).toBeNull()
 expect(buildForeignInitialDepositProjection({...i,nativeAcquisition:null},()=>true)).toBeNull()
 const quote={...i.nativeAcquisition,kind:'exact_original_to_native_source_quote' as const,declaredBy:null}
 expect(buildForeignInitialDepositProjection({...i,nativeAcquisition:quote},()=>true)).toBeNull()
 const qualified=buildForeignInitialDepositProjection({...i,nativeAcquisition:quote},()=>true,()=>false,v=>v===quote)!
 expect(qualified.originalAssetAcquisitionQualified).toBe(true)
 expect(qualified.depositExecuted).toBe(false)
 const wrongQuestion={...i.question,originalDeposit:{...i.question.originalDeposit,decimals:18}}
 expect(buildForeignInitialDepositProjection({...i,question:wrongQuestion},()=>true)).toBeNull()
})
