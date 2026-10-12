import{it,expect}from'vitest'
import{buildFrames,type WireInputs}from'@/lib/venueWire/series'
import{readRouteWireContext}from'@/lib/carry/routeWireContext.server'
import{ROUTE_WIRE_SUBJECTS,selectedRouteWireContext}from'@/lib/carry/routeWireBinding'
import{buildRouteEventContext,type RouteEventQuestion}from'@/lib/carry/routeEventContext'
const now=Date.parse('2026-10-12T12:00:00.000Z'),hour=3600,asOf=now/1000
const q=(i=0):RouteEventQuestion=>({routeKey:ROUTE_WIRE_SUBJECTS[i].routeKey,destination:ROUTE_WIRE_SUBJECTS[i].destination,payoutAsset:ROUTE_WIRE_SUBJECTS[i].asset,assetDecimals:6,requestedRaw:'1000000',horizonHours:48})
function inputs(last=asOf):WireInputs{
 const n=100*24,t=Array.from({length:n},(_,i)=>last-(n-1-i)*hour)
 const venue=(tail:boolean)=>({cash:t.map((_,i)=>tail&&i>=n-2?1000000:15000000+(i%10)*100000),supply:t.map(()=>100000000),debt:t.map(()=>85000000),util:t.map((_,i)=>tail&&i>=n-2?0.99:0.85),flags:t.map(()=>1),apr:t.map(()=>3)})
 return{venueStress:{history:{schema:'venue-stress-history/v1',timeline:{t},venues:{'aave-core-usdc':venue(true),'spark-usdt':venue(true),'morpho-steakhouse-usdc':{...venue(true),liquid:t.map(()=>1000000)}}},summary:{schema:'venue-stress-summary/v1',venues:{'aave-core-usdc':{protocol:'Aave',symbol:'USDC'},'spark-usdt':{protocol:'Spark',symbol:'USDT'},'morpho-steakhouse-usdc':{protocol:'MetaMorpho',symbol:'USDC',name:'Steakhouse USDC'}},coverage:{}}},
 ethUsd:{asset:'ETH',startTs:t[0],stepSeconds:hour,count:n,columns:{oracle:t.map((_,i)=>i>=n-24?1800:3000),coinbase:t.map((_,i)=>i>=n-24?1800:3000)}},
 depeg:{source:'explicit_synthetic_price_fixture',series:{usdc:t.map((at,i)=>[at,i>=n-2?0.95:1] as[number,number])}}}
}
it('reuses real Wire detection/service for exact AaveUSDC and SparkUSDT measured stories',()=>{
 for(const i of[0,1]){const r=readRouteWireContext(q(i),now,()=>buildFrames(inputs()))
 expect(r.status).toBe('observed');expect(r.subjectId).toBe(ROUTE_WIRE_SUBJECTS[i].subjectId)
 expect(r.stories.length).toBeGreaterThan(0);expect(r.stories.every(s=>s.story.affects.includes(r.subjectId!))).toBe(true)
 expect(r.stories.some(s=>s.story.subject.kind==='venue'&&s.association==='same_native_venue_measured_change')).toBe(true)
 expect(r.inputFileAvailability).toBe('loaded_at_issue_original_first_availability_unknown')
 expect(r.association).toBe('measured_anomalies_not_causal_primary_events_or_NET')
 expect(selectedRouteWireContext(r,q(i),now)).toBe(r)
 }} )
it('keeps explicit asset associations and never attaches USDC or SteakhouseV1 venue stories to SparkUSDT',()=>{
 const a=readRouteWireContext(q(),now,()=>buildFrames(inputs())),s=readRouteWireContext(q(1),now,()=>buildFrames(inputs()))
 expect(a.stories.some(s=>s.story.subject.id==='usdc'&&s.association==='same_payout_asset_price_context')).toBe(true)
 expect(s.stories.some(s=>s.story.subject.id==='eth'&&s.association==='protocol_collateral_price_context_not_holder_exposure')).toBe(true)
 expect(s.stories.some(s=>['usdc','morpho-steakhouse-usdc'].includes(s.story.subject.id))).toBe(false)
})
it('never treats any49MorphoV2 vault as the Wire SteakhouseV1 venue, even if the payout asset is USDC',()=>{
 let called=false
 const r=readRouteWireContext({...q(),routeKey:'USDC → VaultV2 [USDC]',destination:'0x069662d2588fcac24b5c209456db965d151556f0'},now,()=>{called=true;return buildFrames(inputs())})
 expect(r.status).toBe('not_enrolled');expect(r.stories).toEqual([]);expect(called).toBe(false)
 expect(readRouteWireContext({...q(),payoutAsset:q(1).payoutAsset},now,()=>buildFrames(inputs())).status).toBe('not_enrolled')
})
it('withholds stale headlines and cannot use a future latest input to freshen old as-of evidence',()=>{
 const old=inputs(asOf-7*hour),r=readRouteWireContext(q(),now,()=>buildFrames(old))
 expect(r.status).toBe('stale');expect(r.stories.every(s=>s.displayHeadline===null)).toBe(true)
 old.venueStress!.history.timeline.t.push(asOf+hour)
 for(const v of Object.values(old.venueStress!.history.venues))for(const col of Object.values(v))if(col)col.push(1)
 const future=readRouteWireContext(q(),now,()=>buildFrames(old))
 expect(future.status).toBe('stale');expect(future.stories.every(s=>s.story.at<=asOf&&s.displayHeadline===null)).toBe(true)
})
it('binds Q/H/asset and prevents changed associations, future story timestamps and expired context replay',()=>{
 const r=readRouteWireContext(q(),now,()=>buildFrames(inputs()))
 for(const patch of[{requestedRaw:'2000000'},{horizonHours:24},{payoutAsset:q(1).payoutAsset}])expect(selectedRouteWireContext(r,{...q(),...patch},now)).toBeNull()
 const bad=structuredClone(r);bad.stories[0].association='causal_NET_driver';expect(selectedRouteWireContext(bad,q(),now)).toBeNull()
 const future=structuredClone(r);future.stories[0].story.at=asOf+1;expect(selectedRouteWireContext(future,q(),now)).toBeNull()
 expect(selectedRouteWireContext(r,q(),now+1800001)).toBeNull()
})
it('attaches a separate Wire field while preserving RSS and primary-event namespaces and unavailable input status',()=>{
 const wire=readRouteWireContext(q(),now,()=>buildFrames(inputs()))
 const sources={event:{status:'unavailable' as const,reason:'source_unavailable' as const},news:{status:'unavailable' as const,reason:'source_unavailable' as const},capacity:{status:'unavailable' as const,reason:'source_unavailable' as const}}
 const c=buildRouteEventContext(q(),null,sources,now,'aave',wire)
 expect(c.wireStories).toBe(wire);expect(c.news.status).toBe('source_unavailable');expect(c.primaryEvents).toBeUndefined()
 expect(c.newsImpact).toEqual({status:'unavailable',reason:'no_causal_model'})
 expect(readRouteWireContext(q(),now,()=>{throw Error('missing_dataset')}).status).toBe('source_unavailable')
})
