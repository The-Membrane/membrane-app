// Server-only acquisition: reuse Q13's exact loader/service; no second feed or RSS mutation.
import {loadWireFrames} from '../venueWire/load'
import {buildWire,type WireResponse} from '../venueWire/service'
import type {WireFrames} from '../venueWire/series'
import type {WireStory} from '../venueWire/types'
import {validRouteEventQuestion,type RouteEventQuestion} from './routeEventContext'
import {FORECAST_WIRE_UPSTREAM,routeWireSubject,type RouteWireContext,type RouteWireStory} from './routeWireBinding'
const iso=(t:number)=>new Date(t*1000).toISOString()
function latestAt(times:readonly number[],values:readonly unknown[],asOf:number){
 for(let i=times.length-1;i>=0;i--)if(times[i]<=asOf&&values[i]!=null)return times[i]
 return null
}
function sourceTime(frames:WireFrames,s:WireStory,asOf:number){
 if(s.metric==='state'){const f=frames.venues.get(s.subject.id);return f?latestAt(f.t,f.flags,asOf):null}
 const series=frames.series.find(f=>f.subject.id===s.subject.id&&f.metric===s.metric)
 return series?latestAt(series.t,series.v,asOf):null
}
export function readRouteWireContext(q:RouteEventQuestion,nowMs=Date.now(),load:()=>WireFrames=loadWireFrames):RouteWireContext{
 if(!validRouteEventQuestion(q)||!Number.isSafeInteger(nowMs)||nowMs<0)throw Error('invalid_route_wire_question')
 const m=routeWireSubject(q),asOf=Math.floor(nowMs/1000),at=new Date(nowMs).toISOString()
 const base={schema:'forecast_route_wire_v1' as const,question:{...q},upstreamCommit:FORECAST_WIRE_UPSTREAM,subjectId:m?.subjectId??null,readAtUtc:at,asOfUtc:at,
 stories:[] as RouteWireStory[],newestVenueReadingAtUtc:null as string|null,uncovered:[] as RouteWireContext['uncovered'],
 inputFileAvailability:'loaded_at_issue_original_first_availability_unknown' as const,
 association:'measured_anomalies_not_causal_primary_events_or_NET' as const,noStoryIsNotAllClear:true as const,forecastValidated:false as const,holderExecutableExit:false as const}
 if(!m)return{...base,status:'not_enrolled'}
 try{
 const frames=load(),venue=frames.venues.get(m.subjectId)
 const newest=venue?latestAt(venue.t,venue.cash,asOf):null
 const result=buildWire(frames,{view:'stories',asOf,venue:m.subjectId,limit:100},{now:asOf}) as WireResponse
 const stories:RouteWireStory[]=result.stories.filter(s=>s.at<=asOf&&s.at>=asOf-604800&&s.affects.includes(m.subjectId)&&
 (s.subject.kind==='venue'?s.subject.id===m.subjectId:m.assetStories.some(a=>a.id===s.subject.id))).slice(0,4).map(story=>{
 const time=sourceTime(frames,story,asOf),age=time===null?null:(nowMs-time*1000)/3600000,stale=time===null||age!<0||age!>6
 const association=story.subject.kind==='venue'?'same_native_venue_measured_change':m.assetStories.find(a=>a.id===story.subject.id)!.association
 return{story,association,sourceReadingAtUtc:time===null?null:iso(time),sourceAgeHours:age,stale,displayHeadline:stale?null:story.headline}
 })
 const stale=newest===null||nowMs-newest*1000>21600000
 return{...base,status:stale?'stale':stories.some(s=>!s.stale)?'observed':'none',stories,newestVenueReadingAtUtc:newest===null?null:iso(newest),uncovered:result.uncovered}
 }catch{return{...base,status:'source_unavailable'}}
}
