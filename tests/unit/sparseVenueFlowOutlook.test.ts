import {it,expect} from 'vitest'
import {nativeVenueMaxFlow,buildSparseVenueFlowOutlook,type SparseVenueFlowInput,type VenueFlowDefinition} from '@/lib/carry/sparseVenueFlowOutlook'
const definition:VenueFlowDefinition={id:'new-venue',mechanismFamily:'atomic_cash',version:'1',cashMeaning:'underlying_idle',assetRisk:'stable_usdc',
 asset:`0x${'1'.repeat(40)}`,decimals:6,nodes:['inventory','shared','left','right','holder'],source:'inventory',sink:'holder',
 edges:[{id:'shared',from:'inventory',to:'shared',capacityRaw:'100'},{id:'left',from:'shared',to:'left',capacityRaw:'80'},
 {id:'right',from:'shared',to:'right',capacityRaw:'80'},{id:'left_exit',from:'left',to:'holder',capacityRaw:'80'},
 {id:'right_exit',from:'right',to:'holder',capacityRaw:'80'}]}
function input():SparseVenueFlowInput{return{definition,subjectId:'new',incidentIds:['own'],currentSourceAtUtc:'2026-10-11T12:00:00.000Z',
 readAtUtc:'2026-10-11T12:00:00.000Z',issuedAtUtc:'2026-10-11T12:00:00.000Z',horizonHours:24,requestedRaw:'40',fullEntitlementRaw:'100',additionalCompetitionRaw:'10',
 donors:[{subjectId:'peer',incidentIds:['different'],mechanismFamily:'atomic_cash',version:'1',cashMeaning:'underlying_idle',assetRisk:'stable_usdc',asset:definition.asset,decimals:6,
 sourceAtUtc:'2026-10-01T00:00:00.000Z',targetAtUtc:'2026-10-02T00:00:00.000Z',availableAtUtc:'2026-10-03T00:00:00.000Z',
 netChangeByEdge:{shared:'-20',left:'0',right:'0',left_exit:'0',right_exit:'0'}}]}}
it('uses one shared bottleneck for parallel exits rather than adding their capacity',()=>{expect(nativeVenueMaxFlow(definition)).toBe('100')})
it('applies NET, explicit additional M and Q once, under required original qualification',()=>{
 const q=input();expect(buildSparseVenueFlowOutlook(q,()=>false)).toBeNull()
 const r=buildSparseVenueFlowOutlook(q,v=>v===q)!
 expect(r.baselineHeadroomRaw).toBe('50');expect(r.scenarios[0].capacityRaw).toBe('80');expect(r.scenarios[0].headroomRaw).toBe('30')
 expect(r.forecastValidated).toBe(false)
})
it('excludes target subjects, shared incidents, future knowledge and incompatible mechanisms before peer selection',()=>{
 for(const patch of [{subjectId:'new'},{subjectId:undefined},{incidentIds:undefined},{incidentIds:['own']},{availableAtUtc:'2026-10-12T00:00:00.000Z'},{version:'2'},{decimals:18}]){
  const q=input();Object.assign(q.donors[0],patch);expect(buildSparseVenueFlowOutlook(q,()=>true)).toBeNull()
 }
})
it('retains censored arithmetic scenarios instead of selecting only survivors',()=>{
 const q=input();q.donors.push({...q.donors[0],netChangeByEdge:{...q.donors[0].netChangeByEdge,shared:String((1n<<256n)-1n)}})
 const r=buildSparseVenueFlowOutlook(q,()=>true)!
 expect(r.scenarios).toHaveLength(2);expect(r.complete).toBe(false);expect(r.scenarios[1].censored).toBe(true)
})
it('rejects graph cycles with invalid identity, overflowed inventory, duplicate edges and invalid clocks',()=>{
 const q=input();q.readAtUtc='2026-10-12T12:00:00.000Z';expect(buildSparseVenueFlowOutlook(q,()=>true)).toBeNull()
 expect(nativeVenueMaxFlow({...definition,edges:[...definition.edges,definition.edges[0]]})).toBeNull()
 expect(nativeVenueMaxFlow({...definition,source:definition.sink})).toBeNull()
})
