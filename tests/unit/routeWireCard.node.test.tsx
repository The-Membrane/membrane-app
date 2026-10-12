import React from 'react'
import {it} from 'node:test'
import assert from 'node:assert/strict'
import {renderToStaticMarkup} from 'react-dom/server'
import {ChakraProvider} from '@chakra-ui/react'
import theme from '../../theme'
import {ExitPressureCard,type ExitPressureCardProps} from '@/components/Carry/ExitPressureCard'
import {buildFrames,type WireInputs} from '@/lib/venueWire/series'
import {buildWire,type WireResponse} from '@/lib/venueWire/service'
import {readRouteWireContext} from '@/lib/carry/routeWireContext.server'
import {ROUTE_WIRE_SUBJECTS,type RouteWireContext} from '@/lib/carry/routeWireBinding'
import {buildRouteEventContext,type RouteEventQuestion} from '@/lib/carry/routeEventContext'
import {resolveRouteNewsSource} from '@/lib/carry/routeNewsSources'
const now=Date.parse('2026-10-12T12:00:00.000Z'),at=now/1000,hour=3600
const render=(p:ExitPressureCardProps)=>renderToStaticMarkup(<ChakraProvider theme={theme}><ExitPressureCard {...p}/></ChakraProvider>)
const escape=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;')
function inputs(last=at,assets=false):WireInputs{
 const n=100*24,t=Array.from({length:n},(_,i)=>last-(n-1-i)*hour)
 // A real service-generated historical anomaly, recovered by the newest reading.
 const v=()=>({cash:t.map((_,i)=>i>=n-5&&i<=n-4?1000000:15000000+(i%10)*100000),supply:t.map(()=>100000000),debt:t.map(()=>85000000),util:t.map((_,i)=>i>=n-5&&i<=n-4?0.99:0.85),flags:t.map(()=>1),apr:t.map(()=>3)})
 return{venueStress:{history:{schema:'venue-stress-history/v1',timeline:{t},venues:{'aave-core-usdc':v(),'spark-usdt':v(),'morpho-steakhouse-usdc':{...v(),liquid:t.map((_,i)=>i>=n-5&&i<=n-4?1000000:15000000)}}},summary:{schema:'venue-stress-summary/v1',venues:{'aave-core-usdc':{protocol:'Aave',symbol:'USDC'},'spark-usdt':{protocol:'Spark',symbol:'USDT'},'morpho-steakhouse-usdc':{protocol:'MetaMorpho',symbol:'USDC',name:'Steakhouse USDC'}},coverage:{}}},
 ...(assets?{ethUsd:{asset:'ETH',startTs:t[0],stepSeconds:hour,count:n,columns:{oracle:t.map((_,i)=>i>=n-24?1800:3000)}},depeg:{source:'explicit_synthetic_fixture',series:{usdc:t.map((stamp,i)=>[stamp,i>=n-2?0.95:1] as[number,number])}}}:{})}
}
function fixture(i=0,last=at,assets=false){
 const m=ROUTE_WIRE_SUBJECTS[i],q:RouteEventQuestion={routeKey:m.routeKey,destination:m.destination,payoutAsset:m.asset,assetDecimals:6,requestedRaw:'1000000',horizonHours:48}
 const frames=buildFrames(inputs(last,assets)),wire=readRouteWireContext(q,now,()=>frames)
 const sources={event:{status:'unavailable' as const,reason:'source_unavailable' as const},news:{status:'unavailable' as const,reason:'source_unavailable' as const},capacity:{status:'unavailable' as const,reason:'source_unavailable' as const}}
 const context=buildRouteEventContext(q,null,sources,now,resolveRouteNewsSource(q.routeKey,q.destination)!.id,wire)
 const props:ExitPressureCardProps={routeKey:q.routeKey,destination:q.destination,requestedAmount:'1',requestedRaw:q.requestedRaw,requestedAssetSymbol:i===0?'USDC':'USDT',requestedAssetAddress:q.payoutAsset,requestedAssetDecimals:6,horizonHours:48,asOfMs:now,
 currentCash:null,prospectiveCashModel:null,historicalScenario:null,grossWithdrawals:null,grossInflows:null,historicalGrossFlow:null,morphoPayout:null,holderAssessment:null,expectedEventEnrollment:{status:'not_enrolled'},eventContext:context,historicalOutlook:null}
 return{q,frames,wire,props}
}
it('actual Card consumes genuine Wire service/bridge/context outputs for exact AaveUSDC and SparkUSDT, preserving occurrence and reading clocks',()=>{
 for(const i of[0,1]){const f=fixture(i),story=f.wire.stories.find(s=>s.displayHeadline)!
 assert.ok(story);assert.ok(story.story.at<at);assert.equal(story.sourceReadingAtUtc,new Date(now).toISOString())
 const html=render(f.props)
 assert.match(html,/Measured story†/);assert.ok(html.includes(escape(story.displayHeadline!)))
 const clock=new Date(story.story.at*1000).toISOString().slice(5,16).replace('T',' ')
 assert.ok(html.includes(clock));assert.match(html,/reading 10-12 12:00 UTC/);assert.match(html,/venue history/)
 assert.doesNotMatch(html,/Primary protocol rule|causal NET|Forecast validated/)
 }
})
it('actual Card suppresses stale and future-source Wire headlines and rejects changed Q/H/route/asset units',()=>{
 const stale=fixture(0,at-7*hour)
 assert.equal(stale.wire.status,'stale');assert.doesNotMatch(render(stale.props),/Measured story†/)
 const f=fixture()
 for(const patch of[{requestedRaw:'2000000',requestedAmount:'2'},{horizonHours:24},{routeKey:ROUTE_WIRE_SUBJECTS[1].routeKey,destination:ROUTE_WIRE_SUBJECTS[1].destination},{requestedAssetDecimals:18},{requestedAssetAddress:ROUTE_WIRE_SUBJECTS[1].asset},{asOfMs:now+1800001}])assert.doesNotMatch(render({...f.props,...patch}),/Measured story†/)
 const future=structuredClone(f.props.eventContext!)
 future.wireStories!.stories[0].sourceReadingAtUtc=new Date(now+1000).toISOString()
 assert.doesNotMatch(render({...f.props,eventContext:future}),/Measured story†/)
})
it('actual Card keeps asset price associations distinct and blocks USDC asset and SteakhouseV1 stories at mismatched subjects',()=>{
 const a=fixture(0,at,true),s=fixture(1,at,true)
 for(const [f,id,label]of[[a,'usdc','asset price context'],[s,'eth','collateral price context']] as const){
 const entry=f.wire.stories.find(s=>s.story.subject.id===id)!
 assert.ok(entry)
 const context={...f.props.eventContext!,wireStories:{...f.wire,stories:[entry]}}
 const html=render({...f.props,eventContext:context});assert.match(html,/Measured story†/);assert.ok(html.includes(label))
 }
 const usdc=a.wire.stories.find(s=>s.story.subject.id==='usdc')!
 const wrongAsset:RouteWireContext={...s.wire,stories:[{...usdc,story:{...usdc.story,affects:[...usdc.story.affects,'spark-usdt']}}]}
 assert.doesNotMatch(render({...s.props,eventContext:{...s.props.eventContext!,wireStories:wrongAsset}}),/Measured story†/)
 const original=buildWire(a.frames,{view:'stories',venue:'morpho-steakhouse-usdc',asOf:at,limit:100},{now:at}) as WireResponse
 const v1=original.stories.find(s=>s.subject.id==='morpho-steakhouse-usdc')!
 assert.ok(v1)
 const wrongVenue:RouteWireContext={...a.wire,stories:[{...a.wire.stories[0],story:v1}]}
 assert.doesNotMatch(render({...a.props,eventContext:{...a.props.eventContext!,wireStories:wrongVenue}}),/Measured story†/)
 const v2q={...a.q,routeKey:'USDC → VaultV2 [USDC]',destination:'0x069662d2588fcac24b5c209456db965d151556f0'}
 assert.equal(readRouteWireContext(v2q,now,()=>a.frames).status,'not_enrolled')
 assert.doesNotMatch(render({...a.props,routeKey:v2q.routeKey,destination:v2q.destination}),/Measured story†/)
})
