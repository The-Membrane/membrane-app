import { buildSaturnOwnedTicketConditionalMechanism, type SaturnOwnedTicketConditionalMechanism } from './saturnOwnedTicketConditionalMechanism'
import type { HolderExitAssessmentView, HolderExitViewQuestion } from './holderExitMechanicalOutlookView'
export type SaturnTicketMechanismIssue = Readonly<{kind:'saturn_ticket_mechanism_receipt'}>
export type SaturnTicketViewQuestion = HolderExitViewQuestion & { ticketId: string | null }
const retained = new WeakMap<object,{model:SaturnOwnedTicketConditionalMechanism;seal:string}>()
function match(model:SaturnOwnedTicketConditionalMechanism,a:HolderExitAssessmentView,q:SaturnTicketViewQuestion) {
  const m=model.question, issue=Date.parse(m.issuedAtUtc)
  if(m.ticketId!==q.ticketId||m.owner!==q.owner?.toLowerCase()||m.routeKey!==q.routeKey||m.destination!==q.destination.toLowerCase()||
    m.requestedRaw!==q.requestedRaw||m.asset!==q.payoutAsset?.toLowerCase()||m.horizonSeconds!==q.horizonHours*3600||
    !Number.isSafeInteger(q.asOfMs)||q.asOfMs<issue||q.asOfMs>Date.parse(model.sourceProofValidUntil)||q.asOfMs>=Date.parse(m.targetAtUtc))return false
  const rebuilt=buildSaturnOwnedTicketConditionalMechanism(a,{routeKey:q.routeKey,destinationAddress:m.destination as `0x${string}`,
    owner:m.owner as `0x${string}`,assetAddress:m.asset as `0x${string}`,assetsRaw:m.requestedRaw,nowMs:issue,horizonSeconds:m.horizonSeconds},()=>true)
  return rebuilt!==null&&JSON.stringify(rebuilt)===JSON.stringify(model)
}
/** Browser identity retention is downstream of original server receipt qualification. */
export function retainSaturnTicketMechanism(value:unknown,status:number,a:HolderExitAssessmentView,q:SaturnTicketViewQuestion):SaturnTicketMechanismIssue|null {
  try {if(status!==200||!value||typeof value!=='object'||!match(value as SaturnOwnedTicketConditionalMechanism,a,q))return null
    const model=structuredClone(value) as SaturnOwnedTicketConditionalMechanism,issue=Object.freeze({kind:'saturn_ticket_mechanism_receipt' as const})
    retained.set(issue,{model,seal:JSON.stringify(model)});return issue
  }catch{return null}
}
export function selectedSaturnTicketMechanism(issue:unknown,a:HolderExitAssessmentView,q:SaturnTicketViewQuestion):SaturnOwnedTicketConditionalMechanism|null{
  try {if(!issue||typeof issue!=='object')return null;const r=retained.get(issue)
    return r&&r.seal===JSON.stringify(r.model)&&match(r.model,a,q)?r.model:null
  }catch{return null}
}
