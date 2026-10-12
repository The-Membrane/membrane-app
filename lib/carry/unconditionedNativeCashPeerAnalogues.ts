import {registeredConditionalSampledCashIdentity} from './conditionalSampledCashPathProjection'
import registrations from './morpho-v2-asset-identities.json'
import type { NativeCashGraphQuestion } from './nativeCashPeerIntervals'
import type { ConditionalSampledCashHistory } from './conditionalSampledCashPathProjection'
const MAX=(1n<<256n)-1n
export type PeerIncidentReview={targetIncidentIds:readonly string[];byDestination:Readonly<Record<string,readonly string[]>>}
/** Separate unconditioned analogue branch: never blend donor NET with target historical NET. */
export function unconditionedNativeCashPeerAnalogues(q:NativeCashGraphQuestion,
 histories:readonly ConditionalSampledCashHistory[],hash:(text:string)=>string,incidents?:PeerIncidentReview){
 const s=q.currentSource,issue=Date.parse(q.issuedAtUtc),source=Date.parse(s.blockTime)
 const known=(h:ConditionalSampledCashHistory)=>registrations.chainId===s.chainId&&registrations.entries.some(e=>
  e.vault===h.identity.destination&&e.asset===h.identity.asset)&&
  registeredConditionalSampledCashIdentity(h.identity.routeKey,h.identity.destination)?.assetDecimals===h.identity.assetDecimals
 const targetKnown=known(q.history)
 const candidates=targetKnown?histories.filter(h=>h.identity.destination!==s.destination&&known(h)&&
  h.identity.asset===s.asset&&h.identity.assetDecimals===s.assetDecimals).sort((a,b)=>a.identity.destination.localeCompare(b.identity.destination)):[]
 const elapsed=BigInt(issue-source+q.horizonHours*3600000),E=BigInt(q.fullEntitlementRaw),M=BigInt(q.additionalCompetitionRaw),Q=BigInt(q.requestedRaw)
 const scenarios:{peerIdentity:ConditionalSampledCashHistory['identity'];historyEvidence:ConditionalSampledCashHistory['witness'];
  sourceIndex:number;targetIndex:number;sourceAtUtc:string;targetAtUtc:string;sourcePointSha256:string;targetPointSha256:string;
  capacityRaw:string|null;headroomRaw:string|null;censored:boolean;incidentLabels:'unknown'|'reviewed_no_shared_label'}[]=[]
 const excluded:{destination:string;sourceIndex:number|null;targetIndex:number|null;reason:string}[]=[]
 let omittedHistoricalIntervals=0
 for(const peer of candidates){
  const labels=incidents?.byDestination[peer.identity.destination]
  if(labels?.some(id=>incidents!.targetIncidentIds.includes(id))){excluded.push({destination:peer.identity.destination,sourceIndex:null,targetIndex:null,reason:'known_shared_incident'});continue}
  // Fixed newest two source intervals per subject before validity/arithmetic checks: no survivor selection.
  const points=peer.points.slice(-3);omittedHistoricalIntervals+=Math.max(0,peer.points.length-3)
  for(let i=1;i<points.length;i++){
   const a=points[i-1],b=points[i],dt=Date.parse(b[3])-Date.parse(a[3])
   if(!Number.isSafeInteger(dt)||dt<=0||dt>91800000||Date.parse(b[3])>=source||Date.parse(peer.witness.availableAt)>issue||Date.parse(peer.witness.availableAt)<Date.parse(b[3])){
    excluded.push({destination:peer.identity.destination,sourceIndex:a[0],targetIndex:b[0],reason:'gap_or_not_available_before_issue_source'});continue
   }
   if(BigInt(a[4])===0n){excluded.push({destination:peer.identity.destination,sourceIndex:a[0],targetIndex:b[0],reason:'zero_peer_start_cash_relative_rate_undefined'});continue}
   const evidence={peerIdentity:peer.identity,historyEvidence:peer.witness,sourceIndex:a[0],targetIndex:b[0],sourceAtUtc:a[3],targetAtUtc:b[3],
    sourcePointSha256:hash(JSON.stringify(a)),targetPointSha256:hash(JSON.stringify(b)),
    incidentLabels:labels&&incidents?'reviewed_no_shared_label' as const:'unknown' as const}
   if(!/^[a-f0-9]{64}$/.test(evidence.sourcePointSha256)||!/^[a-f0-9]{64}$/.test(evidence.targetPointSha256))throw Error('peer_point_digest_invalid')
   try{
    const start=BigInt(a[4]),delta=BigInt(b[4])-start,cash=BigInt(s.cashRaw)
    const product=cash*delta*elapsed,denominator=start*BigInt(dt)
    if(product < -MAX||product>MAX||denominator>MAX)throw Error('native_intermediate_overflow')
    const transfer=product>=0n?product/denominator:-((-product)/denominator+((-product)%denominator===0n?0n:1n))
    const candidate=cash+transfer;if(candidate>MAX)throw Error('native_capacity_overflow')
    const capacity=candidate<0n?0n:candidate,afterM=capacity>M?capacity-M:0n
    scenarios.push({...evidence,capacityRaw:String(capacity),headroomRaw:String((afterM<E?afterM:E)-Q),censored:false})
   }catch{scenarios.push({...evidence,capacityRaw:null,headroomRaw:null,censored:true})}
  }
 }
 const values=scenarios.filter(p=>p.headroomRaw!==null).map(p=>BigInt(p.headroomRaw!)).sort((a,b)=>a<b?-1:a>b?1:0)
 return {schema:'unconditioned_native_cash_peer_analogues_v1' as const,
  scope:'unconditioned_relative_NET_peer_analogues' as const,compatibility:'registered_chain1_MorphoV2_cash_inventory_same_underlying_address_and_decimals' as const,
  status:!targetKnown?'unsupported_target_cash_inventory_class' as const:!scenarios.length?'no_eligible_peer_intervals' as const:'conditional_peer_analogues' as const,
  targetAtUtc:new Date(issue+q.horizonHours*3600000).toISOString(),scenarios,excluded,
  summary:values.length?{minimumHeadroomRaw:String(values[0]),maximumHeadroomRaw:String(values.at(-1)),p10HeadroomRaw:String(values[Math.floor((values.length-1)*.1)]),p90HeadroomRaw:String(values[Math.floor((values.length-1)*.9)])}:null,
  candidatePeerSubjects:candidates.length,matchedPeerSubjects:new Set(scenarios.map(p=>p.peerIdentity.destination)).size,
  usableIntervals:values.length,censoredIntervals:scenarios.length-values.length,omittedHistoricalIntervals,
  selection:'newest_two_retained_intervals_per_peer_before_validity_and_arithmetic_checks' as const,
  sizing:'target_source_cash_times_peer_NET_change_over_peer_start_cash_times_interval_ms_then_times_source_age_plus_H_floor' as const,
  assumption:'relative_peer_NET_rate_transfers_to_target_cash_inventory_fixed_Ea_unchanged_authority_and_regime' as const,
  incidentConditioned:false as const,unknownIncidentLabelsPermittedForUnconditionedAnalogues:true as const,
  accounting:'peer_NET_already_includes_other_users_no_own_NET_blend_additional_M_separate_Q_once' as const,
  executionLimits:['cash_inventory_only_not_executable_graph','relative_transfer_is_unvalidated_size_regime_assumption','no_adapter_pullability_pause_fees_or_claim_conversion_model'],
  calibratedProbability:false as const,forecastValidated:false as const,holderExecutableExit:false as const}
}
