/** Conditional onboarding model. Every graph edge is in the same native payout asset. */
export type VenueFlowDefinition = {
  id:string; mechanismFamily:string; version:string; cashMeaning:string; assetRisk:string
  asset:string; decimals:number; nodes:string[]; source:string; sink:string
  edges:{id:string;from:string;to:string;capacityRaw:string}[]
}
export type PeerFlowInterval = {
  subjectId:string; incidentIds:string[]; mechanismFamily:string;version:string;cashMeaning:string;assetRisk:string
  asset:string;decimals:number;sourceAtUtc:string;targetAtUtc:string;availableAtUtc:string
  netChangeByEdge:Record<string,string>
}
export type SparseVenueFlowInput = {
  definition:VenueFlowDefinition; currentSourceAtUtc:string;readAtUtc:string;issuedAtUtc:string;horizonHours:number
  requestedRaw:string;fullEntitlementRaw:string;additionalCompetitionRaw:string
  subjectId:string;incidentIds:string[];donors:PeerFlowInterval[]
}
const MAX=(1n<<256n)-1n
const raw=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<=MAX
const signed=(v:unknown):v is string=>typeof v==='string'&&/^-?(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)>=-MAX&&BigInt(v)<=MAX
const utc=(v:unknown):v is string=>typeof v==='string'&&Number.isSafeInteger(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v
const text=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=128
const checked=(n:bigint)=>{if(n < -MAX || n>MAX)throw Error('native_overflow');return n}
/** Bounded Edmonds–Karp. Shared bottlenecks constrain all parallel routes together. */
export function nativeVenueMaxFlow(definition:VenueFlowDefinition):string|null {
  try {
    const d=structuredClone(definition),ids=d.nodes
    if(ids.length<2||ids.length>32||new Set(ids).size!==ids.length||ids.some(n=>!text(n))||
      !ids.includes(d.source)||!ids.includes(d.sink)||d.source===d.sink||d.edges.length<1||d.edges.length>128||
      new Set(d.edges.map(e=>e.id)).size!==d.edges.length)return null
    const n=ids.length,residual=Array.from({length:n},()=>Array<bigint>(n).fill(0n))
    for(const e of d.edges){if(!text(e.id)||!raw(e.capacityRaw)||!ids.includes(e.from)||!ids.includes(e.to)||e.from===e.to)return null
      const a=ids.indexOf(e.from),b=ids.indexOf(e.to);residual[a][b]=checked(residual[a][b]+BigInt(e.capacityRaw))}
    const source=ids.indexOf(d.source),sink=ids.indexOf(d.sink);let flow=0n,steps=0
    while(true){
      const parents=Array<number>(n).fill(-1),queue=[source];parents[source]=source
      for(let q=0;q<queue.length&&parents[sink]<0;q++)for(let b=0;b<n;b++){
        if(parents[b]<0&&residual[queue[q]][b]>0n){parents[b]=queue[q];queue.push(b)}}
      if(parents[sink]<0)return String(flow)
      if(++steps>4096)return null
      let add=MAX
      for(let b=sink;b!==source;b=parents[b])if(residual[parents[b]][b]<add)add=residual[parents[b]][b]
      for(let b=sink;b!==source;b=parents[b]){const a=parents[b];residual[a][b]-=add;residual[b][a]=checked(residual[b][a]+add)}
      flow=checked(flow+add)
    }
  }catch{return null}
}
/** The receipt qualifier is mandatory. Compatible peers stay conditional and uncalibrated. */
export function buildSparseVenueFlowOutlook(input:SparseVenueFlowInput,qualifyOriginal:(v:SparseVenueFlowInput)=>boolean){
  try{
    if(!input||!qualifyOriginal(input))return null
    input=structuredClone(input);const d=input.definition
    if(![d.id,d.mechanismFamily,d.version,d.cashMeaning,d.assetRisk,input.subjectId].every(text)||
      !/^0x[0-9a-f]{40}$/.test(d.asset)||!Number.isInteger(d.decimals)||d.decimals<0||d.decimals>36||
      ![input.requestedRaw,input.fullEntitlementRaw,input.additionalCompetitionRaw].every(raw)||input.requestedRaw==='0'||
      ![input.currentSourceAtUtc,input.readAtUtc,input.issuedAtUtc].every(utc)||
      !Number.isFinite(input.horizonHours)||input.horizonHours<=0||input.horizonHours>8760||
      !Number.isSafeInteger(input.horizonHours*3600000)||input.donors.length>128||
      input.incidentIds.length>64||input.incidentIds.some(i=>!text(i)))return null
    const current=Date.parse(input.currentSourceAtUtc),read=Date.parse(input.readAtUtc),issue=Date.parse(input.issuedAtUtc)
    if(current>read||read>issue||issue-current>1800000)return null
    const baseline=nativeVenueMaxFlow(d);if(baseline===null)return null
    const E=BigInt(input.fullEntitlementRaw),M=BigInt(input.additionalCompetitionRaw),Q=BigInt(input.requestedRaw)
    const head=(flow:string)=>{const f=BigInt(flow),after=f>M?f-M:0n;return String((after<E?after:E)-Q)}
    const excluded:{index:number;reason:string}[]=[],scenarios:{index:number;capacityRaw:string|null;headroomRaw:string|null;censored:boolean}[]=[]
    const elapsed=BigInt(issue-current+input.horizonHours*3600000)
    input.donors.forEach((p,index)=>{
      const clocks=[p.sourceAtUtc,p.targetAtUtc,p.availableAtUtc]
      const dt=Date.parse(p.targetAtUtc)-Date.parse(p.sourceAtUtc)
      let reason=p.subjectId===input.subjectId?'target_subject_excluded':
        p.incidentIds?.some(id=>input.incidentIds.includes(id))?'shared_incident_excluded':
        ['mechanismFamily','version','cashMeaning','assetRisk','asset','decimals'].some(k=>p[k as keyof PeerFlowInterval]!==d[k as keyof VenueFlowDefinition])?'incompatible_peer':
        clocks.some(t=>!utc(t))||!Number.isSafeInteger(dt)||dt<=0||dt>91800000?'historical_gap_or_clock':
        Date.parse(p.availableAtUtc)<Date.parse(p.targetAtUtc)||Date.parse(p.availableAtUtc)>issue||Date.parse(p.targetAtUtc)>=current?'not_known_strictly_before_source':null
      if(reason){excluded.push({index,reason});return}
      try{
        if(Object.keys(p.netChangeByEdge).length!==d.edges.length||d.edges.some(e=>!signed(p.netChangeByEdge[e.id])))throw Error('channels')
        const edges=d.edges.map(e=>{const product=checked(BigInt(p.netChangeByEdge[e.id])*elapsed),den=BigInt(dt)
          const delta=product>=0n?product/den:-((-product+den-1n)/den)
          const cap=checked(BigInt(e.capacityRaw)+delta);return {...e,capacityRaw:String(cap<0n?0n:cap)}})
        const capacity=nativeVenueMaxFlow({...d,edges});if(capacity===null)throw Error('capacity')
        scenarios.push({index,capacityRaw:capacity,headroomRaw:head(capacity),censored:false})
      }catch{scenarios.push({index,capacityRaw:null,headroomRaw:null,censored:true})}
    })
    if(!scenarios.length)return null
    return {schema:'sparse_venue_flow_outlook_v1' as const,definitionId:d.id,asset:d.asset,decimals:d.decimals,
      targetAtUtc:new Date(issue+input.horizonHours*3600000).toISOString(),baselineCapacityRaw:baseline,baselineHeadroomRaw:head(baseline),
      scenarios,excluded,complete:scenarios.every(s=>!s.censored),
      accounting:'shared_graph_bottlenecks_NET_already_includes_competition_additional_M_separate_Q_once' as const,
      assumption:'compatible_peer_edge_NET_changes_fixed_entitlement_unchanged_graph_and_regime' as const,
      calibratedProbability:false as const,holderExecutableExit:false as const,forecastValidated:false as const}
  }catch{return null}
}
