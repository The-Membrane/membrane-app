import type {HolderExitAssessment} from './holderExitAssessment'
import type {HolderExitMechanicalRequest} from './holderExitMechanicalProjection'
import {multilegQuestion,multilegUint,selectedMultilegConversion,conversionHeadroom,type ConditionalMultilegConversion} from './conditionalMultilegConversion'
const ROUTE='PYUSD → StakingVault [wYLDS]',PRIME='0x19ebb35279a16207ec4ba82799cc64715065f7f6',WYLDS='0x6ad038ca6c04e885630851278ca0a856ad9a66cc',USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',PYUSD='0x6c3ea9036406852006290770bedfcaba0e23a0e8'
/** Existing queue and newly simulated PRIME redemption remain separate lineages. */
export function buildHastraConditionalFinalExit(a:HolderExitAssessment,q:HolderExitMechanicalRequest,qualifyOriginal:(a:HolderExitAssessment,q:HolderExitMechanicalRequest)=>boolean,conversion?:{
 wyldsSettlement?:ConditionalMultilegConversion;usdcToPyusd?:ConditionalMultilegConversion
 qualify:(c:ConditionalMultilegConversion)=>boolean
}){
 try{
 if(!qualifyOriginal(a,q))return null
 const question=multilegQuestion(a,q,ROUTE,PRIME,PYUSD);if(!question)return null
 const first=a.pyusdStakingCondition,queue=a.pyusdYieldQueueCondition
 if(!first&&!queue)return null
 if(first&&(![first.requestedPrimeSharesRaw,first.holderPrimeSharesRaw,first.maxRedeemRaw].every(multilegUint)||first.requestedPrimeSharesRaw==='0'||
 (first.previewWyldsRaw!==null&&!multilegUint(first.previewWyldsRaw))||(first.simulatedWyldsRaw!==null&&!multilegUint(first.simulatedWyldsRaw))))return null
 if(queue&&(queue.holder.toLowerCase()!==question.owner||![queue.existingWyldsSharesRaw,queue.pendingSharesRaw,queue.pendingUsdcRaw,queue.pendingSinceUnix].every(multilegUint)||
 BigInt(queue.pendingSinceUnix)*1000n>BigInt(Date.parse(a.source.blockTime))||queue.completion!=='admin_gated_unassessed'||queue.requestAssessed!==false||queue.usdcPayout!=='not_attested'))return null
 const stage=a.stages.find(s=>s.name==='prime_redemption')
 const delivered=first?.reason==='prime_to_wylds_callable'&&stage?.status==='simulated'&&stage.assetAddress.toLowerCase()===PRIME&&stage.amountRaw===first.requestedPrimeSharesRaw&&
 !first.stakingPaused&&!first.holderFrozen&&BigInt(first.holderPrimeSharesRaw)>=BigInt(first.requestedPrimeSharesRaw)&&BigInt(first.maxRedeemRaw)>=BigInt(first.requestedPrimeSharesRaw)&&first.simulatedWyldsRaw!==null&&first.simulatedWyldsRaw!=='0'?first.simulatedWyldsRaw:null
 const settlement=delivered?selectedMultilegConversion(conversion?.wyldsSettlement,a,q.nowMs,WYLDS,6,delivered,USDC,6,conversion?.qualify??(()=>false)):null
 // A settlement range cannot be chained into an exact-size quote implicitly.
 const settlementExact=settlement&&settlement.minimumOutputRaw===settlement.maximumOutputRaw?settlement.minimumOutputRaw:null
 const payout=settlementExact?selectedMultilegConversion(conversion?.usdcToPyusd,a,q.nowMs,USDC,6,settlementExact,PYUSD,6,conversion?.qualify??(()=>false)):null
 return{schema:'hastra_conditional_final_exit_v1' as const,question,sourceProofValidUntil:new Date(Date.parse(a.source.blockTime)+1800000).toISOString(),
 firstLeg:first?{scope:'new_independent_PRIME_share_probe' as const,inputPrimeRaw:first.requestedPrimeSharesRaw,inputDecimals:6,simulatedWyldsRaw:delivered,outputDecimals:6,simulationIsFutureDelivery:false as const}:null,
 existingQueue:queue?{scope:'preexisting_holder_queue_not_new_PRIME_probe' as const,...structuredClone(queue),recordedUsdcDecimals:6,administrativeSettlementAtUtc:null,claimFeeKnown:false as const}:null,
 conditionalSettlement:settlement,conditionalFinalConversion:payout,
 scenarios:[{state:'not_released_or_not_administratively_settled' as const,finalPyusdRaw:'0',requestedHeadroomRaw:String(-BigInt(q.assetsRaw))},
 {state:'if_new_PRIME_delivered_admin_settlement_and_exact_conversion_assumptions_hold' as const,finalPyusdRange:payout?{minimumRaw:payout.minimumOutputRaw,maximumRaw:payout.maximumOutputRaw}:null,requestedHeadroom:conversionHeadroom(payout,q.assetsRaw),
 symbolicFinalAmount:'PYUSD_from_USDC(admin_settlement(wYLDS_from_PRIME))',unresolvedLegs:[...(!delivered?['new_PRIME_delivery']:[]),...(!settlement?['administrator_wYLDS_to_USDC_amount_and_fee']:[]),...(!payout?['USDC_to_PYUSD_exact_size_conversion']:[])]}],
 assumptions:['new_PRIME_redemption_repeats_current_simulation','administrator_authorizes_and_funds_exact_settlement_amount','declared_settlement_amount_is_after_assumed_administrator_fee','exact_size_USDC_to_PYUSD_scenario_unchanged'],
 settlementFeeKnown:false as const,futureSettlementAtUtc:null,duration:'administrator_release_time_censored' as const,futureConversionHeldConditional:true as const,
 calibratedProbability:false as const,holderExecutableExit:false as const,minedFinalPayout:false as const,forecastValidated:false as const,scenarioRangeIsCapacityBound:false as const}
 }catch{return null}
}
