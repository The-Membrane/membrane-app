import type { ConditionalSampledCashCurrentSource } from './conditionalSampledCashPathProjection'
const MAX=(1n<<256n)-1n, INDEX=10n**15n
const raw=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<=MAX
export type CompoundInitialDepositFacts={comet:string;asset:string;assetDecimals:number;baseSupplyIndexRaw:string;supplyPaused:boolean}
export type CompoundInitialDepositAgreement={status:'agreed_compound_initial_deposit_facts';currentSource:ConditionalSampledCashCurrentSource;readAt:string;origins:{originHostSha256:string;facts:CompoundInitialDepositFacts}[]}
export function compoundInitialDepositReceipt(depositRaw:string,indexRaw:string){
 if(!raw(depositRaw)||!raw(indexRaw))return null
 const d=BigInt(depositRaw),i=BigInt(indexRaw)
 if(!d||!i||d>MAX/INDEX)return null
 const principal=d*INDEX/i
 // Comet's positive principal is int104, before present-value uint256 multiplication.
 if(!principal||principal>((1n<<103n)-1n)||principal>MAX/i)return null
 return{principalMintRaw:String(principal),entitlementRaw:String(principal*i/INDEX)}
}
export function selectedCompoundInitialDepositAgreement(v:unknown,s:ConditionalSampledCashCurrentSource,now:number):CompoundInitialDepositAgreement|null{
 try{
 const a=v as CompoundInitialDepositAgreement
 if(s.routeKey!=='USDC → supply on Compound v3'||s.destination!=='0xc3d688b66703497daa19211eedff47f25384cdc3'||s.asset!=='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'||s.assetDecimals!==6||
 !a||a.status!=='agreed_compound_initial_deposit_facts'||!Array.isArray(a.origins)||a.origins.length!==2||
 JSON.stringify(Object.entries(a.currentSource).sort(([a],[b])=>a.localeCompare(b)))!==JSON.stringify(Object.entries(s).sort(([a],[b])=>a.localeCompare(b)))||!Number.isSafeInteger(now)||s.chainId!==1||
 !['manifest_bound_ledger','live_read_only_two_origin_finalized'].includes(s.sourceKind)||
 !raw(s.cashRaw)||!/^[1-9][0-9]*$/.test(s.block)||!/^0x[a-f0-9]{64}$/.test(s.blockHash)||
 !Number.isFinite(Date.parse(s.blockTime))||!Number.isFinite(Date.parse(s.readAt))||Date.parse(s.blockTime)>Date.parse(s.readAt)||Date.parse(s.readAt)>now||
 !Number.isFinite(Date.parse(a.readAt))||Date.parse(a.readAt)<Date.parse(s.readAt)||Date.parse(a.readAt)>now||now-Date.parse(s.blockTime)>1800000)return null
 const seen=new Set<string>()
 for(const o of a.origins){const f=o.facts
 if(!/^[a-f0-9]{64}$/.test(o.originHostSha256)||seen.has(o.originHostSha256)||!f||f.comet!==s.destination||f.asset!==s.asset||f.assetDecimals!==6||!raw(f.baseSupplyIndexRaw)||BigInt(f.baseSupplyIndexRaw)===0n||BigInt(f.baseSupplyIndexRaw)>=(1n<<64n)||typeof f.supplyPaused!=='boolean')return null
 seen.add(o.originHostSha256)}
 return JSON.stringify(a.origins[0].facts)===JSON.stringify(a.origins[1].facts)?structuredClone(a):null
 }catch{return null}
}
