import type {HolderExitAssessment} from './holderExitAssessment'
import type {HolderExitMechanicalRequest} from './holderExitMechanicalProjection'
export const MAX_MULTILEG=(1n<<256n)-1n
export const multilegUint=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<=MAX_MULTILEG
/** Exact-size conversion scenarios are assumptions or separately qualified quotes,
 * never an inferred exchange rate between unrelated native units. */
export type ConditionalMultilegConversion={
 inputAsset:string;inputDecimals:number;inputRaw:string;outputAsset:string;outputDecimals:number
 minimumOutputRaw:string;maximumOutputRaw:string
 basis:'declared_user_scenario'|'qualified_current_exact_size_quote'
 reference:string;availableAtUtc:string
 currentSource:HolderExitAssessment['source']|null
}
export function multilegQuestion(a:HolderExitAssessment,q:HolderExitMechanicalRequest,route:string,destination:string,asset:string){
 const source=Date.parse(a.source.blockTime),target=q.nowMs+q.horizonSeconds*1000
 if(a.status==='unsupported'||a.routeKey!==route||q.routeKey!==route||a.destinationAddress.toLowerCase()!==destination||q.destinationAddress.toLowerCase()!==destination||
 a.owner.toLowerCase()!==q.owner.toLowerCase()||!/^0x[0-9a-f]{40}$/i.test(q.owner)||a.request.assetsRaw!==q.assetsRaw||a.request.assetAddress.toLowerCase()!==asset||q.assetAddress.toLowerCase()!==asset||a.finalPayout.assetAddress.toLowerCase()!==asset||
 a.request.horizonHours*3600!==q.horizonSeconds||!multilegUint(q.assetsRaw)||q.assetsRaw==='0'||!Number.isSafeInteger(q.nowMs)||!Number.isSafeInteger(source)||source>q.nowMs||q.nowMs-source>1800000||
 a.source.chainId!==1||a.source.originValidation!=='two_provider'||!Number.isSafeInteger(a.source.blockNumber)||a.source.blockNumber<=0||!/^0x[0-9a-f]{64}$/i.test(a.source.blockHash)||
 !Number.isSafeInteger(q.horizonSeconds)||q.horizonSeconds<=0||q.horizonSeconds>720*3600||!Number.isSafeInteger(target))return null
 return{routeKey:route,destination,owner:q.owner.toLowerCase(),requestedRaw:q.assetsRaw,asset,horizonSeconds:q.horizonSeconds,issuedAtUtc:new Date(q.nowMs).toISOString(),targetAtUtc:new Date(target).toISOString(),currentSource:structuredClone(a.source)}
}
export function selectedMultilegConversion(c:ConditionalMultilegConversion|null|undefined,a:HolderExitAssessment,now:number,inputAsset:string,inputDecimals:number,inputRaw:string,outputAsset:string,outputDecimals:number,qualify:(c:ConditionalMultilegConversion)=>boolean){
 if(!c)return null
 if(!qualify(c)||c.inputAsset!==inputAsset||c.inputDecimals!==inputDecimals||c.inputRaw!==inputRaw||c.outputAsset!==outputAsset||c.outputDecimals!==outputDecimals||
 ![c.inputRaw,c.minimumOutputRaw,c.maximumOutputRaw].every(multilegUint)||BigInt(c.minimumOutputRaw)>BigInt(c.maximumOutputRaw)||!c.reference||c.reference.length>512||
 !Number.isSafeInteger(Date.parse(c.availableAtUtc))||Date.parse(c.availableAtUtc)>now||
 (c.basis==='qualified_current_exact_size_quote'?JSON.stringify(c.currentSource)!==JSON.stringify(a.source):c.basis!=='declared_user_scenario'||c.currentSource!==null))return null
 return structuredClone(c)
}
export function conversionHeadroom(c:ConditionalMultilegConversion|null,q:string){return c?{minimumRaw:String(BigInt(c.minimumOutputRaw)-BigInt(q)),maximumRaw:String(BigInt(c.maximumOutputRaw)-BigInt(q))}:null}
