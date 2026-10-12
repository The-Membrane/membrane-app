import type {HolderExitAssessment} from './holderExitAssessment'
import type {HolderExitMechanicalRequest} from './holderExitMechanicalProjection'
import {multilegQuestion,multilegUint,selectedMultilegConversion,conversionHeadroom,type ConditionalMultilegConversion} from './conditionalMultilegConversion'
const ROUTE='USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',WRAPPER='0x0af56afbddcb140323445bd7211ba90e54e5fd1c',PT='0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',USDE='0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
export type TwyneMaturityFacts={currentSource:HolderExitAssessment['source'];pt:string;ptDecimals:18;expiryUnix:number;sy:string;yt:string;availableAtUtc:string}
/** Borrower assay delivers PT, not USDe. Maturity never supplies a USDe exchange rate. */
export function buildTwyneConditionalFinalExit(a:HolderExitAssessment,q:HolderExitMechanicalRequest,qualifyOriginal:(a:HolderExitAssessment,q:HolderExitMechanicalRequest)=>boolean,optional?:{
 maturity?:TwyneMaturityFacts;qualifyMaturity?:(m:TwyneMaturityFacts)=>boolean
 conversion?:ConditionalMultilegConversion;qualifyConversion?:(c:ConditionalMultilegConversion)=>boolean
}){
 try{
 if(!qualifyOriginal(a,q))return null
 const question=multilegQuestion(a,q,ROUTE,WRAPPER,USDE),c=a.twyneCondition
 if(!question||!c||c.status==='unsupported'||!/^0x[0-9a-f]{40}$/i.test(c.collateralVault)||!multilegUint(c.requestedPtRaw)||c.requestedPtRaw==='0'||
 (c.simulatedReturnedPtRaw!==null&&!multilegUint(c.simulatedReturnedPtRaw)))return null
 const stage=a.stages.find(s=>s.name==='pt_redemption'),delivered=c.status==='observed'&&stage?.status==='simulated'&&stage.assetAddress.toLowerCase()===PT&&stage.amountRaw===c.requestedPtRaw&&c.simulatedReturnedPtRaw!==null&&BigInt(c.simulatedReturnedPtRaw)>=BigInt(c.requestedPtRaw)?c.simulatedReturnedPtRaw:null
 const m=optional?.maturity
 const maturity=m&&optional?.qualifyMaturity?.(m)&&JSON.stringify(m.currentSource)===JSON.stringify(a.source)&&m.pt===PT&&m.ptDecimals===18&&m.expiryUnix===1792627200&&m.sy==='0xc9bfebc79a722c05dc34bd2a227ef2db19fd1b8e'&&m.yt==='0xfe6040719cca36aeb85e352f48fe956057728814'&&Number.isSafeInteger(Date.parse(m.availableAtUtc))&&Date.parse(m.availableAtUtc)<=q.nowMs?structuredClone(m):null
 const payout=delivered?selectedMultilegConversion(optional?.conversion,a,q.nowMs,PT,18,delivered,USDE,18,optional?.qualifyConversion??(()=>false)):null
 return{schema:'twyne_conditional_final_exit_v1' as const,question,sourceProofValidUntil:new Date(Date.parse(a.source.blockTime)+1800000).toISOString(),
 firstLeg:{collateralVault:c.collateralVault,requestedPtRaw:c.requestedPtRaw,simulatedReturnedPtRaw:delivered,asset:PT,decimals:18,receiver:'borrower' as const,simulationIsFutureDelivery:false as const},
 maturityFacts:maturity,maturityAtSource:maturity?(Date.parse(a.source.blockTime)>=maturity.expiryUnix*1000?'at_or_after_expiry':'before_expiry'):'not_retained_in_holder_assessment',
 maturityWithinHorizon:maturity?Date.parse(question.targetAtUtc)>=maturity.expiryUnix*1000:null,
 conditionalFinalConversion:payout,scenarios:[{state:'PT_not_released_or_not_converted' as const,finalUsdeRaw:'0',requestedHeadroomRaw:String(-BigInt(q.assetsRaw))},
 {state:'if_PT_released_and_declared_exact_size_USDe_conversion_holds' as const,finalUsdeRange:payout?{minimumRaw:payout.minimumOutputRaw,maximumRaw:payout.maximumOutputRaw}:null,requestedHeadroom:conversionHeadroom(payout,q.assetsRaw),symbolicFinalAmount:'USDe_from_PT(returned_PT)',unresolvedLegs:[...(!delivered?['borrower_PT_release']:[]),...(!payout?['PT_to_USDe_conversion_or_mature_SY_redemption']:[])]}],
 futureReleaseAtUtc:null,duration:'release_and_conversion_time_censored' as const,expiryAloneProvesUsdePayout:false as const,
 calibratedProbability:false as const,holderExecutableExit:false as const,minedFinalPayout:false as const,forecastValidated:false as const,scenarioRangeIsCapacityBound:false as const}
 }catch{return null}
}
