import { nativeVenueMaxFlow, type VenueFlowDefinition } from './sparseVenueFlowOutlook'
import type { FixedEntitlementCashInput } from './fixedEntitlementCashOutlook'
import type { ConditionalSampledCashHistory } from './conditionalSampledCashPathProjection'

const MAX = (1n << 256n) - 1n
export type NativeCashGraphQuestion = FixedEntitlementCashInput & { owner: string }
/** Single inventory edge, never a fabricated executable vault withdrawal graph. */
export function nativeCashGraphIntervalOutlook(
  original: NativeCashGraphQuestion,
  histories: readonly ConditionalSampledCashHistory[],
  qualifyOriginal: (question: NativeCashGraphQuestion, histories: readonly ConditionalSampledCashHistory[]) => boolean,
) {
  try {
    if (!qualifyOriginal(original, histories)) return null
    const q = structuredClone(original), own = q.history, s = q.currentSource
    const issue = Date.parse(q.issuedAtUtc), source = Date.parse(s.blockTime), read = Date.parse(s.readAt)
    const unsigned = (v: string) => /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
    if (![q.requestedRaw,q.fullEntitlementRaw,q.additionalCompetitionRaw,s.cashRaw].every(unsigned) ||
        q.requestedRaw === '0' || !/^0x[0-9a-f]{40}$/.test(q.owner) ||
        ![issue,source,read].every(Number.isSafeInteger) || source > read || read > issue || issue-source > 1800000 ||
        !Number.isSafeInteger(q.horizonHours*3600000) || q.horizonHours<=0 || q.horizonHours>8760 ||
        ['routeKey','destination','asset','assetDecimals'].some(k=>own.identity[k as keyof typeof own.identity]!==s[k as keyof typeof s])) return null
    const definition: VenueFlowDefinition = {
      id: `cash:${s.destination}`, mechanismFamily: 'cash_inventory_proxy', version: 'native_cash_v1',
      cashMeaning: 'aggregate_underlying_balance_not_maxWithdraw', assetRisk: `underlying:${s.asset}`,
      asset: s.asset, decimals: s.assetDecimals, nodes: ['native_cash','capacity_proxy'],
      source: 'native_cash', sink: 'capacity_proxy',
      edges: [{id:'cash',from:'native_cash',to:'capacity_proxy',capacityRaw:s.cashRaw}],
    }
    const currentGraphCapacityRaw = nativeVenueMaxFlow(definition)
    if (currentGraphCapacityRaw === null) return null
    const E=BigInt(q.fullEntitlementRaw), M=BigInt(q.additionalCompetitionRaw), Q=BigInt(q.requestedRaw)
    const head = (cash: bigint) => { const net=cash>M?cash-M:0n; return String((net<E?net:E)-Q) }
    const elapsed=BigInt(issue-source+q.horizonHours*3600000)
    const scenarios: {originIndex:number;targetIndex:number;sourceAtUtc:string;targetAtUtc:string;
      capacityRaw:string|null;headroomRaw:string|null;censored:boolean}[]=[]
    const excluded: {originIndex:number;targetIndex:number;reason:string}[]=[]
    for(let i=1;i<own.points.length;i++) {
      const a=own.points[i-1],b=own.points[i],dt=Date.parse(b[3])-Date.parse(a[3])
      if(!Number.isSafeInteger(dt)||dt<=0||dt>91800000||Date.parse(b[3])>=source||Date.parse(own.witness.availableAt)>issue){
        excluded.push({originIndex:a[0],targetIndex:b[0],reason:'gap_or_not_available_before_issue_source'});continue
      }
      try {
        const product=(BigInt(b[4])-BigInt(a[4]))*elapsed
        if(product < -MAX || product > MAX) throw Error('overflow')
        const divisor=BigInt(dt),delta=product>=0n?product/divisor:-((-product+divisor-1n)/divisor)
        const candidate=BigInt(s.cashRaw)+delta
        if(candidate>MAX)throw Error('overflow')
        const cash=candidate<0n?0n:candidate
        scenarios.push({originIndex:a[0],targetIndex:b[0],sourceAtUtc:a[3],targetAtUtc:b[3],
          capacityRaw:String(cash),headroomRaw:head(cash),censored:false})
      } catch {
        scenarios.push({originIndex:a[0],targetIndex:b[0],sourceAtUtc:a[3],targetAtUtc:b[3],
          capacityRaw:null,headroomRaw:null,censored:true})
      }
    }
    const peers=histories.filter(h=>h.identity.destination!==s.destination &&
      h.identity.routeKey===s.routeKey && h.identity.asset===s.asset && h.identity.assetDecimals===s.assetDecimals)
    const values=scenarios.filter(v=>v.headroomRaw!==null).map(v=>BigInt(v.headroomRaw!)).sort((a,b)=>a<b?-1:a>b?1:0)
    return {
      schema:'native_cash_graph_interval_outlook_v1' as const,
      question:{owner:q.owner,identity:own.identity,currentSource:s,requestedRaw:q.requestedRaw,
        fullEntitlementRaw:q.fullEntitlementRaw,additionalCompetitionRaw:q.additionalCompetitionRaw,
        issuedAtUtc:q.issuedAtUtc,horizonHours:q.horizonHours},
      definition,currentGraphCapacityRaw,currentGraphHeadroomRaw:head(BigInt(currentGraphCapacityRaw)),
      historyEvidence:own.witness,
      intervalScope:'own_authenticated_native_cash_intervals_not_peer_transfer' as const,
      scenarios,excluded,
      summary:values.length?{minimumHeadroomRaw:String(values[0]),maximumHeadroomRaw:String(values.at(-1)),
        p10HeadroomRaw:String(values[Math.floor((values.length-1)*.1)]),p90HeadroomRaw:String(values[Math.floor((values.length-1)*.9)])}:null,
      usableIntervals:values.length,censoredIntervals:scenarios.length-values.length,
      peerGate:{candidateSameRouteAssetUnitsHistories:peers.length,selectedPeers:0,
        reason:'original_reviewed_incident_metadata_and_mechanism_regime_not_available' as const},
      accounting:'NET_already_includes_other_users_additional_M_separate_Q_once' as const,
      assumption:'repeat_own_historical_interval_NET_fixed_Ea_unchanged_cash_proxy_regime' as const,
      executionLimits:['single_cash_inventory_edge_not_executable_route','adapter_pullability_pause_gates_fees_not_modeled'],
      forecastValidated:false as const,holderExecutableExit:false as const,calibratedProbability:false as const,
    }
  } catch { return null }
}
