import type { buildForeignInitialDepositProjection, ForeignInitialDepositQuestion } from './foreignInitialDepositProjection'
import { foreignInitialDepositMechanism } from './foreignInitialDepositProjection'
type Model = NonNullable<ReturnType<typeof buildForeignInitialDepositProjection>>
export type ForeignInitialDepositProjectionIssue = Readonly<{ kind: 'foreign_initial_deposit_projection_receipt' }>
const receipts = new WeakMap<object,{model:Model;seal:string}>()
function sameQuestion(a:ForeignInitialDepositQuestion,b:ForeignInitialDepositQuestion) {
  const {source:as,...aq}=a,{source:bs,...bq}=b
  const order=(v:object)=>JSON.stringify(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)))
  return order(aq)===order(bq)&&order(as)===order(bs)
}
function matching(model:Model,q:ForeignInitialDepositQuestion,now:number) {
  const issue=Date.parse(q.issuedAtUtc),source=Date.parse(q.source.blockTime),target=issue+q.horizonHours*3600000
  const mechanism=foreignInitialDepositMechanism(q.routeKey,q.destination)
  return !!mechanism&&q.nativeDecimals===mechanism.nativeDecimals&&q.finalDecimals===mechanism.finalDecimals&&
    model.schema==='foreign_initial_deposit_projection_v1'&&sameQuestion(model.question,q)&&
    model.mechanism.routeKey===q.routeKey&&model.mechanism.destination===q.destination&&
    model.firstLeg.nativeAsset===mechanism.nativeAsset&&model.firstLeg.nativeDecimals===q.nativeDecimals&&model.firstLeg.depositRaw===q.nativeDepositRaw&&
    model.firstLeg.earliestSourceAt===q.source.blockTime&&model.finalAsset.asset===mechanism.finalAsset&&
    model.finalAsset.decimals===q.finalDecimals&&model.finalAsset.requestedRaw===q.plannedFinalExitRaw&&
    (!model.nativeReceipt||sameQuestion(model.nativeReceipt.question,q))&&
    model.nativeDeployedMethodsQualified===!!model.nativeReceipt&&
    model.firstLeg.receiptStatus===(model.nativeReceipt?'source_preview_qualified':'required_native_preview_pending')&&
    model.holderExecutableExit===false&&model.forecastValidated===false&&model.calibratedProbability===false&&
    model.depositAdmitted===false&&model.depositExecuted===false&&model.originalAssetAcquisitionQualified===false&&
    model.allIntermediateLegsExecutable===false&&model.firstLeg.observedPostDeposit===false&&
    Number.isSafeInteger(now)&&now>=issue&&now<target&&now-source<=1800000
}
/** Bind the original successful API response to the independently requested question.
 * This browser identity guard does not authenticate serialized contract evidence;
 * deployed-method/read qualification belongs to the server enrollment boundary. */
export function retainForeignInitialDepositProjection(value:unknown,status:number,q:ForeignInitialDepositQuestion,now:number):ForeignInitialDepositProjectionIssue|null {
  try {
    if(status!==200||!value||typeof value!=='object'||!matching(value as Model,q,now))return null
    const model=structuredClone(value) as Model,issue=Object.freeze({kind:'foreign_initial_deposit_projection_receipt' as const})
    receipts.set(issue,{model,seal:JSON.stringify(model)});return issue
  }catch{return null}
}
export function selectedForeignInitialDepositProjection(issue:unknown,q:ForeignInitialDepositQuestion,now:number):Model|null {
  try {
    if(!issue||typeof issue!=='object')return null
    const saved=receipts.get(issue)
    return saved&&JSON.stringify(saved.model)===saved.seal&&matching(saved.model,q,now)?saved.model:null
  }catch{return null}
}
