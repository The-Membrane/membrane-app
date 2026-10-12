import type {HolderExitAssessment} from './holderExitAssessment'
import type {HolderExitViewQuestion} from './holderExitMechanicalOutlookView'
import type {ForeignConditionalFinalExit} from './foreignFinalExitIssuer.server'
import {buildHastraConditionalFinalExit} from './hastraConditionalFinalExit'
import {buildTwyneConditionalFinalExit} from './twyneConditionalFinalExit'
export type ForeignFinalExitQuestion=HolderExitViewQuestion&{primeSharesRaw:string|null;ptRaw:string|null;collateralVault:string|null}
export type ForeignFinalExitIssue=Readonly<{kind:'foreign_conditional_final_exit_receipt'}>
const retained=new WeakMap<object,{model:ForeignConditionalFinalExit;seal:string}>()
function matches(m:ForeignConditionalFinalExit,a:HolderExitAssessment,q:ForeignFinalExitQuestion){
 const p=m.question,issue=Date.parse(p.issuedAtUtc)
 if(p.owner!==q.owner?.toLowerCase()||p.routeKey!==q.routeKey||p.destination!==q.destination.toLowerCase()||p.requestedRaw!==q.requestedRaw||p.asset!==q.payoutAsset?.toLowerCase()||p.horizonSeconds!==q.horizonHours*3600||
 !Number.isSafeInteger(q.asOfMs)||q.asOfMs<issue||q.asOfMs>Date.parse(m.sourceProofValidUntil)||q.asOfMs>=Date.parse(p.targetAtUtc)||JSON.stringify(p.currentSource)!==JSON.stringify(a.source))return false
 if(m.schema==='hastra_conditional_final_exit_v1'&&m.firstLeg?.inputPrimeRaw!==undefined&&m.firstLeg.inputPrimeRaw!==q.primeSharesRaw)return false
 if(m.schema==='twyne_conditional_final_exit_v1'&&(m.firstLeg.requestedPtRaw!==q.ptRaw||m.firstLeg.collateralVault.toLowerCase()!==q.collateralVault?.toLowerCase()))return false
 const request={routeKey:q.routeKey,destinationAddress:p.destination as `0x${string}`,owner:p.owner as `0x${string}`,assetAddress:p.asset as `0x${string}`,assetsRaw:p.requestedRaw,nowMs:issue,horizonSeconds:p.horizonSeconds}
 // Current API issues symbolic missing-conversion states only. A future numeric
 // conversion enrollment needs its own original quote agreement and receipt path.
 const rebuilt=m.schema==='hastra_conditional_final_exit_v1'?buildHastraConditionalFinalExit(a,request,()=>true):buildTwyneConditionalFinalExit(a,request,()=>true)
 return rebuilt!==null&&JSON.stringify(rebuilt)===JSON.stringify(m)
}
/** Selection and post-retention identity/mutation binding for the Workbench's own
 * successful API response; this is not arbitrary JSON authenticity. */
export function retainForeignFinalExit(value:unknown,status:number,a:HolderExitAssessment,q:ForeignFinalExitQuestion):ForeignFinalExitIssue|null{
 try{if(status!==200||!value||typeof value!=='object'||!matches(value as ForeignConditionalFinalExit,a,q))return null
 const model=structuredClone(value) as ForeignConditionalFinalExit,issue=Object.freeze({kind:'foreign_conditional_final_exit_receipt' as const});retained.set(issue,{model,seal:JSON.stringify(model)});return issue
 }catch{return null}
}
export function selectedForeignFinalExit(issue:unknown,a:HolderExitAssessment,q:ForeignFinalExitQuestion):ForeignConditionalFinalExit|null{
 try{if(!issue||typeof issue!=='object')return null;const r=retained.get(issue);return r&&r.seal===JSON.stringify(r.model)&&matches(r.model,a,q)?r.model:null}catch{return null}
}
