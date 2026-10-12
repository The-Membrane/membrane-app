import type {HolderExitAssessment,HolderExitAssessmentRequest} from './holderExitAssessment'
import {buildHastraConditionalFinalExit} from './hastraConditionalFinalExit'
import {buildTwyneConditionalFinalExit} from './twyneConditionalFinalExit'
type Witness={host:string;assessment:HolderExitAssessment}
/** Called inside the handler with its original executor pair. Qualification occurs
 * before the transport copy gains two-provider status. No quote is manufactured. */
export function issueForeignConditionalFinalExit(input:HolderExitAssessmentRequest,first:Witness,second:Witness,nowMs:number,qualifyOriginal:(first:Witness,second:Witness)=>boolean){
 try{
 if(!qualifyOriginal(first,second)||first.host===second.host||!first.host||!second.host)return null
 const a=first.assessment,b=second.assessment
 const fields=['pyusdStakingCondition','pyusdYieldQueueCondition','twyneCondition','stages','request','source','finalPayout'] as const
 // Optional queue state is compared in full, separately from general agreement.
 for(const key of fields){
 const left=key==='source'?{...a.source,originValidation:null}:a[key]
 const right=key==='source'?{...b.source,originValidation:null}:b[key]
 if(JSON.stringify(left)!==JSON.stringify(right))return null
 }
 const verified=structuredClone(b);verified.source.originValidation='two_provider'
 const q={routeKey:input.routeKey,destinationAddress:input.destinationAddress,owner:input.owner,assetAddress:verified.request.assetAddress,assetsRaw:input.assetsRaw,nowMs,horizonSeconds:input.horizonHours*3600}
 if(verified.pyusdStakingCondition&&input.primeSharesRaw!==verified.pyusdStakingCondition.requestedPrimeSharesRaw)return null
 if(verified.twyneCondition&&(input.ptRaw!==verified.twyneCondition.requestedPtRaw||input.collateralVault?.toLowerCase()!==verified.twyneCondition.collateralVault.toLowerCase()))return null
 const hastra=buildHastraConditionalFinalExit(verified,q,(v,w)=>v===verified&&w===q)
 if(hastra)return hastra
 return buildTwyneConditionalFinalExit(verified,q,(v,w)=>v===verified&&w===q)
 }catch{return null}
}
export type ForeignConditionalFinalExit=NonNullable<ReturnType<typeof issueForeignConditionalFinalExit>>
