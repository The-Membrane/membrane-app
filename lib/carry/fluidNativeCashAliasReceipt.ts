import type {FluidNativeCashAliasOutlook} from './fluidNativeCashAliasOutlook.server'
export type FluidCashAliasQuestion={routeKey:string;destination:string;owner:string;requestedFinalRaw:string;finalAsset:string;finalDecimals:number;nativeAsset:string;nativeDecimals:number;horizonHours:number;currentSource:FluidNativeCashAliasOutlook['question']['currentSource'];asOfMs:number}
export type FluidCashAliasIssue=Readonly<{kind:'fluid_native_cash_alias_receipt'}>
const retained=new WeakMap<object,{model:FluidNativeCashAliasOutlook;seal:string}>()
const canonical=(v:unknown):unknown=>Array.isArray(v)?['array',v.map(canonical)]:v!==null&&typeof v==='object'?['object',Object.keys(v).sort().map(k=>[k,canonical((v as Record<string,unknown>)[k])])]:[v===null?'null':typeof v,v]
function matches(m:FluidNativeCashAliasOutlook,q:FluidCashAliasQuestion){
 const p=m.question,issue=Date.parse(p.issuedAtUtc)
 return m.schema==='fluid_native_cash_alias_outlook_v1'&&['routeKey','destination','owner','requestedFinalRaw','finalAsset','finalDecimals','nativeAsset','nativeDecimals','horizonHours'].every(k=>(p as any)[k]===(q as any)[k])&&
 JSON.stringify(canonical(p.currentSource))===JSON.stringify(canonical(q.currentSource))&&Number.isSafeInteger(q.asOfMs)&&q.asOfMs>=issue&&q.asOfMs<=Date.parse(m.sourceProofValidUntil)&&q.asOfMs<Date.parse(p.targetAtUtc)&&
 m.holderExecutableExit===false&&m.forecastValidated===false&&m.calibratedProbability===false&&m.fullRouteDeliveryCensored===true&&m.conditionalJointProcess===null&&m.futureRecovery===null&&m.cashAlias.meaningsMayNotBeSubstituted===true
}
/** Own successful API transport selection; server original receipt qualification is
 * independent. The retained identity/seal rejects copies and later mutations. */
export function retainFluidCashAlias(value:unknown,status:number,q:FluidCashAliasQuestion):FluidCashAliasIssue|null{
 try{if(status!==200||!value||typeof value!=='object'||!matches(value as FluidNativeCashAliasOutlook,q))return null
 const model=structuredClone(value) as FluidNativeCashAliasOutlook,issue=Object.freeze({kind:'fluid_native_cash_alias_receipt' as const});retained.set(issue,{model,seal:JSON.stringify(model)});return issue}catch{return null}
}
export function selectedFluidCashAlias(issue:unknown,q:FluidCashAliasQuestion):FluidNativeCashAliasOutlook|null{
 try{if(!issue||typeof issue!=='object')return null;const r=retained.get(issue);return r&&r.seal===JSON.stringify(r.model)&&matches(r.model,q)?r.model:null}catch{return null}
}
