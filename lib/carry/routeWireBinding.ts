import type {RouteEventQuestion} from './routeEventContext'
import type {WireStory} from '../venueWire/types'
export const FORECAST_WIRE_UPSTREAM='7c9112d319a9ebf9b4e63119d81eaf3cee929f6b'
/** Exact frozen contract+asset associations; Steakhouse V1 is none of the 49 V2 subjects. */
export const ROUTE_WIRE_SUBJECTS=[
 {routeKey:'USDC → supply on Aave V3',destination:'0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',asset:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',decimals:6,subjectId:'aave-core-usdc',assetStories:[{id:'usdc',association:'same_payout_asset_price_context'},{id:'eth',association:'protocol_collateral_price_context_not_holder_exposure'}]},
 {routeKey:'USDT → supply on Spark',destination:'0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',asset:'0xdac17f958d2ee523a2206206994597c13d831ec7',decimals:6,subjectId:'spark-usdt',assetStories:[{id:'eth',association:'protocol_collateral_price_context_not_holder_exposure'}]},
] as const
export const routeWireSubject=(q:RouteEventQuestion)=>ROUTE_WIRE_SUBJECTS.find(m=>m.routeKey===q.routeKey&&m.destination===q.destination&&m.asset===q.payoutAsset&&m.decimals===q.assetDecimals)
export type RouteWireStory={story:WireStory;association:string;sourceReadingAtUtc:string|null;sourceAgeHours:number|null;stale:boolean;displayHeadline:string|null}
export type RouteWireContext={schema:'forecast_route_wire_v1';question:RouteEventQuestion;status:'observed'|'none'|'stale'|'not_enrolled'|'source_unavailable';
 upstreamCommit:typeof FORECAST_WIRE_UPSTREAM;subjectId:string|null;readAtUtc:string;asOfUtc:string;stories:RouteWireStory[];
 newestVenueReadingAtUtc:string|null;uncovered:{subject:string;metric:string;reason:string;detail:string}[];
 inputFileAvailability:'loaded_at_issue_original_first_availability_unknown';association:'measured_anomalies_not_causal_primary_events_or_NET';
 noStoryIsNotAllClear:true;forecastValidated:false;holderExecutableExit:false}
const same=(a:RouteEventQuestion,b:RouteEventQuestion)=>a.routeKey===b.routeKey&&a.destination===b.destination&&a.requestedRaw===b.requestedRaw&&a.payoutAsset===b.payoutAsset&&a.assetDecimals===b.assetDecimals&&a.horizonHours===b.horizonHours
export function selectedRouteWireContext(v:RouteWireContext|undefined,q:RouteEventQuestion,nowMs:number):RouteWireContext|null{
 try{
 if(!v||v.schema!=='forecast_route_wire_v1'||!same(v.question,q)||v.upstreamCommit!==FORECAST_WIRE_UPSTREAM||!Number.isSafeInteger(nowMs)||Date.parse(v.readAtUtc)>nowMs||!Number.isFinite(Date.parse(v.readAtUtc))||v.asOfUtc!==v.readAtUtc||nowMs-Date.parse(v.readAtUtc)>1800000||v.forecastValidated!==false||v.holderExecutableExit!==false||v.association!=='measured_anomalies_not_causal_primary_events_or_NET')return null
 const m=routeWireSubject(q)
 if(v.subjectId!==(m?.subjectId??null)||(!m&&v.status!=='not_enrolled')||v.stories.length>4)return null
 for(const e of v.stories){const s=e.story,a=s.subject.kind==='asset'?m?.assetStories.find(a=>a.id===s.subject.id):null
 if(!m||!s.affects.includes(m.subjectId)||(s.subject.kind==='venue'?s.subject.id!==m.subjectId:!a)||!Number.isSafeInteger(s.at)||s.at*1000>Date.parse(v.asOfUtc)||e.association!==(a?.association??'same_native_venue_measured_change'))return null
 const t=e.sourceReadingAtUtc===null?NaN:Date.parse(e.sourceReadingAtUtc)
 const issueAge=Number.isFinite(t)?(Date.parse(v.readAtUtc)-t)/3600000:null
 if(e.sourceAgeHours!==issueAge||(Number.isFinite(t)&&t>Date.parse(v.readAtUtc)))return null
 const stale=!Number.isFinite(t)||nowMs<t||nowMs-t>21600000
 if(e.stale!==stale||(stale?e.displayHeadline!==null:e.displayHeadline!==s.headline))return null
 }
 return v
 }catch{return null}
}
