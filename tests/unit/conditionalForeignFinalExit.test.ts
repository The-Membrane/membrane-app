import {it,expect} from 'vitest'
import type {HolderExitAssessment} from '@/lib/carry/holderExitAssessment'
import type {HolderExitMechanicalRequest} from '@/lib/carry/holderExitMechanicalProjection'
import {buildHastraConditionalFinalExit} from '@/lib/carry/hastraConditionalFinalExit'
import {buildTwyneConditionalFinalExit} from '@/lib/carry/twyneConditionalFinalExit'
import type {ConditionalMultilegConversion} from '@/lib/carry/conditionalMultilegConversion'
import {issueForeignConditionalFinalExit} from '@/lib/carry/foreignFinalExitIssuer.server'
import {retainForeignFinalExit,selectedForeignFinalExit} from '@/lib/carry/foreignFinalExitReceipt'
import type {HolderExitAssessmentRequest} from '@/lib/carry/holderExitAssessment'
const now=Date.parse('2026-10-12T12:00:00.000Z'),owner='0x0000000000000000000000000000000000000001'
function fixture(twyne=false){
 const route=twyne?'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]':'PYUSD → StakingVault [wYLDS]',destination=twyne?'0x0af56afbddcb140323445bd7211ba90e54e5fd1c':'0x19ebb35279a16207ec4ba82799cc64715065f7f6',asset=twyne?'0x4c9edd5852cd905f086c759e8383e09bff1e68b3':'0x6c3ea9036406852006290770bedfcaba0e23a0e8'
 const q={routeKey:route,destinationAddress:destination,owner,assetAddress:asset,assetsRaw:twyne?'1000000000000000000':'1000000',nowMs:now,horizonSeconds:48*3600} as HolderExitMechanicalRequest
 const a={status:'partial',routeKey:route,destinationAddress:destination,owner,request:{assetsRaw:q.assetsRaw,assetAddress:asset,horizonHours:48},source:{chainId:1,blockNumber:26200000,blockHash:'0x'+'a'.repeat(64),blockTime:new Date(now-60000).toISOString(),originValidation:'two_provider'},finalPayout:{assetAddress:asset,status:'unassessed',amountRaw:null},stages:twyne?[{name:'pt_redemption',assetAddress:'0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',status:'simulated',amountRaw:'2000000000000000000',relatedToRequest:false}]:[{name:'prime_redemption',assetAddress:destination,status:'simulated',amountRaw:'3000000',relatedToRequest:false}],...(twyne?{twyneCondition:{collateralVault:'0x'+'b'.repeat(40),requestedPtRaw:'2000000000000000000',status:'observed',reason:null,simulatedReturnedPtRaw:'2000000000000000001'}}:{pyusdStakingCondition:{requestedPrimeSharesRaw:'3000000',holderPrimeSharesRaw:'4000000',maxRedeemRaw:'4000000',previewWyldsRaw:'2500000',simulatedWyldsRaw:'2499999',stakingPaused:false,holderFrozen:false,reason:'prime_to_wylds_callable'},pyusdYieldQueueCondition:{holder:owner,existingWyldsSharesRaw:'900000',pendingSharesRaw:'800000',pendingUsdcRaw:'700000',pendingSinceUnix:String(now/1000-3600),yieldPaused:false,yieldFrozen:false,redeemVault:'0x'+'c'.repeat(40),requestAssessed:false,completion:'admin_gated_unassessed',usdcPayout:'not_attested'}})} as unknown as HolderExitAssessment
 return{a,q}
}
function conversion(a:HolderExitAssessment,inputAsset:string,inputDecimals:number,inputRaw:string,outputAsset:string,outputDecimals:number,min:string,max=min):ConditionalMultilegConversion{return{inputAsset,inputDecimals,inputRaw,outputAsset,outputDecimals,minimumOutputRaw:min,maximumOutputRaw:max,basis:'declared_user_scenario',reference:'explicit synthetic user scenario for test',availableAtUtc:new Date(now).toISOString(),currentSource:null}}
it('Hastra keeps independent new PRIME and existing queue lineages without an invented settlement or parity',()=>{
 const {a,q}=fixture(),r=buildHastraConditionalFinalExit(a,q,(v,w)=>v===a&&w===q)!
 expect(r.firstLeg?.simulatedWyldsRaw).toBe('2499999');expect(r.firstLeg?.inputDecimals).toBe(6)
 expect(r.existingQueue?.pendingUsdcRaw).toBe('700000');expect(r.existingQueue?.scope).toBe('preexisting_holder_queue_not_new_PRIME_probe')
 expect(r.scenarios[1].finalPyusdRange).toBeNull();expect(r.scenarios[1].unresolvedLegs).toHaveLength(2)
 expect(r.holderExecutableExit).toBe(false);expect(r.futureSettlementAtUtc).toBeNull()
})
it('Hastra chains only independently approved exact-sized settlement and conversion, Q once',()=>{
 const {a,q}=fixture(),w='0x6ad038ca6c04e885630851278ca0a856ad9a66cc',u='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
 const settlement=conversion(a,w,6,'2499999',u,6,'2000000'),payout=conversion(a,u,6,'2000000',q.assetAddress,6,'1800000','1900000')
 const opts={wyldsSettlement:settlement,usdcToPyusd:payout,qualify:(c:ConditionalMultilegConversion)=>c===settlement||c===payout}
 const r=buildHastraConditionalFinalExit(a,q,()=>true,opts)!
 expect(r.scenarios[1].requestedHeadroom).toEqual({minimumRaw:'800000',maximumRaw:'900000'})
 const bad={...payout,inputRaw:'700000'};expect(buildHastraConditionalFinalExit(a,q,()=>true,{...opts,usdcToPyusd:bad,qualify:()=>true})!.conditionalFinalConversion).toBeNull()
 settlement.maximumOutputRaw='2000001';expect(buildHastraConditionalFinalExit(a,q,()=>true,opts)!.conditionalFinalConversion).toBeNull()
})
it('Twyne uses actual returned PT and explicit haircut range without treating PT or expiry as USDe',()=>{
 const {a,q}=fixture(true),pt='0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34'
 const c=conversion(a,pt,18,'2000000000000000001',q.assetAddress,18,'1500000000000000000','1700000000000000000')
 const r=buildTwyneConditionalFinalExit(a,q,()=>true,{conversion:c,qualifyConversion:v=>v===c})!
 expect(r.firstLeg.simulatedReturnedPtRaw).toBe('2000000000000000001')
 expect(r.scenarios[1].requestedHeadroom).toEqual({minimumRaw:'500000000000000000',maximumRaw:'700000000000000000'})
 expect(r.maturityAtSource).toBe('not_retained_in_holder_assessment');expect(r.expiryAloneProvesUsdePayout).toBe(false)
 const m={currentSource:a.source,pt,ptDecimals:18 as const,expiryUnix:1792627200,sy:'0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e',yt:'0xfe6040719cca36aeb85e352f48fe956057728814',availableAtUtc:new Date(now).toISOString()}
 const maturity=buildTwyneConditionalFinalExit(a,q,()=>true,{maturity:m,qualifyMaturity:v=>v===m})!
 expect(maturity.maturityAtSource).toBe('before_expiry');expect(maturity.maturityWithinHorizon).toBe(false);expect(maturity.conditionalFinalConversion).toBeNull()
})
it('rejects copies before qualification, wrong holder/Q/source, future quotes and unit substitution',()=>{
 for(const twyne of [false,true]){
 const {a,q}=fixture(twyne),build=twyne?buildTwyneConditionalFinalExit:buildHastraConditionalFinalExit
 expect(build(structuredClone(a),q,(v,w)=>v===a&&w===q)).toBeNull()
 for(const patch of [{owner:'0x'+'2'.repeat(40)},{assetsRaw:'2'},{nowMs:now+1800001},{horizonSeconds:0}])expect(build(a,{...q,...patch},()=>true)).toBeNull()
 const single=structuredClone(a);single.source.originValidation='single_provider';expect(build(single,q,()=>true)).toBeNull()
 }
 const {a,q}=fixture(true),c=conversion(a,'0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',6,'2000000000000000001',q.assetAddress,18,'1')
 expect(buildTwyneConditionalFinalExit(a,q,()=>true,{conversion:c,qualifyConversion:()=>true})!.conditionalFinalConversion).toBeNull()
 c.inputDecimals=18;c.availableAtUtc=new Date(now+1).toISOString();expect(buildTwyneConditionalFinalExit(a,q,()=>true,{conversion:c,qualifyConversion:()=>true})!.conditionalFinalConversion).toBeNull()
 c.availableAtUtc=new Date(now).toISOString();c.basis='qualified_current_exact_size_quote';c.currentSource={...a.source,blockNumber:26200001};expect(buildTwyneConditionalFinalExit(a,q,()=>true,{conversion:c,qualifyConversion:()=>true})!.conditionalFinalConversion).toBeNull()
})
it('issues only from original agreeing entire source/queue/first-leg bodies and exact separate share probes',()=>{
 for(const twyne of [false,true]){
 const {a,q}=fixture(twyne),b=structuredClone(a);a.source.originValidation='single_provider';b.source.originValidation='single_provider'
 const first={host:'one.example',assessment:a},second={host:'two.example',assessment:b},input={...q,horizonHours:48,...(twyne?{ptRaw:a.twyneCondition!.requestedPtRaw,collateralVault:a.twyneCondition!.collateralVault}:{primeSharesRaw:a.pyusdStakingCondition!.requestedPrimeSharesRaw})} as unknown as HolderExitAssessmentRequest
 const qualify=(x:typeof first,y:typeof second)=>x===first&&y===second
 expect(issueForeignConditionalFinalExit(input,first,second,now,qualify)).not.toBeNull()
 expect(a.source.originValidation).toBe('single_provider')
 expect(issueForeignConditionalFinalExit(input,{...first},second,now,qualify)).toBeNull()
 expect(issueForeignConditionalFinalExit({...input,...(twyne?{ptRaw:'1'}:{primeSharesRaw:'1'})},first,second,now,qualify)).toBeNull()
 if(twyne)b.twyneCondition!.simulatedReturnedPtRaw='1';else b.pyusdYieldQueueCondition!.pendingUsdcRaw='1'
 expect(issueForeignConditionalFinalExit(input,first,second,now,qualify)).toBeNull()
 }
})
it('retains successful own transport and rejects copied receipt, changed probe/source and selected model mutation',()=>{
 for(const twyne of [false,true]){
 const {a,q}=fixture(twyne),model=twyne?buildTwyneConditionalFinalExit(a,q,()=>true)!:buildHastraConditionalFinalExit(a,q,()=>true)!
 const question={routeKey:q.routeKey,destination:q.destinationAddress,owner:q.owner,requestedRaw:q.assetsRaw,payoutAsset:q.assetAddress,horizonHours:48,asOfMs:now,primeSharesRaw:twyne?null:a.pyusdStakingCondition!.requestedPrimeSharesRaw,ptRaw:twyne?a.twyneCondition!.requestedPtRaw:null,collateralVault:twyne?a.twyneCondition!.collateralVault:null}
 const issue=retainForeignFinalExit(model,200,a,question)!
 expect(issue).not.toBeNull();expect(retainForeignFinalExit(model,500,a,question)).toBeNull()
 expect(selectedForeignFinalExit({...issue},a,question)).toBeNull()
 expect(selectedForeignFinalExit(issue,a,{...question,requestedRaw:'2'})).toBeNull()
 expect(selectedForeignFinalExit(issue,a,{...question,...(twyne?{ptRaw:'2'}:{primeSharesRaw:'2'})})).toBeNull()
 const changed=structuredClone(a);changed.source.blockNumber++;expect(selectedForeignFinalExit(issue,changed,question)).toBeNull()
 const selected=selectedForeignFinalExit(issue,a,question)!;selected.scenarios[0].requestedHeadroomRaw='0'
 expect(selectedForeignFinalExit(issue,a,question)).toBeNull()
 }
})
