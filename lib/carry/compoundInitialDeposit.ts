import type { ConditionalSampledCashCurrentSource } from './conditionalSampledCashPathProjection'
const MAX=(1n<<256n)-1n, INDEX=10n**15n
const raw=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<=MAX
export type CompoundInitialDepositFacts={comet:string;asset:string;assetDecimals:number;baseSupplyIndexRaw:string;supplyPaused:boolean;
 receiver:string|null;accountStatus:'quoted'|'unavailable'|'anonymous_reference';receiverPrincipalRaw:string|null;baseBorrowIndexRaw:string|null}
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
const signedPrincipal=(v:unknown):v is string=>typeof v==='string'&&/^(0|-?[1-9][0-9]{0,31})$/.test(v)&&BigInt(v)>=-(1n<<103n)&&BigInt(v)<(1n<<103n)
/** CometCore presentValue floors both signs; principalValue floors supply and ceils borrow. */
export function compoundReceiverInitialDepositReceipt(depositRaw:string,f:CompoundInitialDepositFacts){
 try{
 if(f.receiver===null){if(f.accountStatus!=='anonymous_reference'||f.receiverPrincipalRaw!==null||f.baseBorrowIndexRaw!==null)return null
 const r=compoundInitialDepositReceipt(depositRaw,f.baseSupplyIndexRaw);return r?{...r,
   receiver:null,accountBasis:'anonymous_new_account_without_debt_assumption' as const,
   priorSupplyEntitlementRaw:'0',priorBorrowDebtRaw:'0',postSupplyEntitlementRaw:r.entitlementRaw,
   postBorrowDebtRaw:'0',postPrincipalRaw:r.principalMintRaw,depositAppliedToDebtRaw:'0'}:null}
 if(f.accountStatus!=='quoted'||!signedPrincipal(f.receiverPrincipalRaw)||!raw(f.baseBorrowIndexRaw)||!raw(f.baseSupplyIndexRaw)||!raw(depositRaw)||depositRaw==='0')return null
 const p=BigInt(f.receiverPrincipalRaw),si=BigInt(f.baseSupplyIndexRaw),bi=BigInt(f.baseBorrowIndexRaw),d=BigInt(depositRaw)
 if(!si||!bi||d>MAX/INDEX)return null
 const priorSupply=p>=0n?p*si/INDEX:0n,priorDebt=p<0n?(-p)*bi/INDEX:0n
 const net=priorSupply-priorDebt+d
 if((net<0n?-net:net)>MAX/INDEX)return null
 const postPrincipal=net>=0n?net*INDEX/si:-((-net*INDEX+bi-1n)/bi)
 if(postPrincipal<-(1n<<103n)||postPrincipal>=(1n<<103n))return null
 const postSupply=postPrincipal>=0n?postPrincipal*si/INDEX:0n,postDebt=postPrincipal<0n?(-postPrincipal)*bi/INDEX:0n
 const incremental=postSupply>priorSupply?postSupply-priorSupply:0n
 const positivePrior=p>0n?p:0n,positivePost=postPrincipal>0n?postPrincipal:0n
 return{principalMintRaw:String(positivePost>positivePrior?positivePost-positivePrior:0n),entitlementRaw:String(incremental),receiver:f.receiver,
   accountBasis:'source_receiver_principal_and_accrued_indexes' as const,priorSupplyEntitlementRaw:String(priorSupply),
   priorBorrowDebtRaw:String(priorDebt),postSupplyEntitlementRaw:String(postSupply),postBorrowDebtRaw:String(postDebt),
   postPrincipalRaw:String(postPrincipal),depositAppliedToDebtRaw:String(d<priorDebt?d:priorDebt)}
 }catch{return null}
}
export function selectedCompoundInitialDepositAgreement(v:unknown,s:ConditionalSampledCashCurrentSource,now:number,receiver:string|null=null):CompoundInitialDepositAgreement|null{
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
 if(!/^[a-f0-9]{64}$/.test(o.originHostSha256)||seen.has(o.originHostSha256)||!f||f.comet!==s.destination||f.asset!==s.asset||f.assetDecimals!==6||!raw(f.baseSupplyIndexRaw)||BigInt(f.baseSupplyIndexRaw)===0n||BigInt(f.baseSupplyIndexRaw)>=(1n<<64n)||typeof f.supplyPaused!=='boolean'||f.receiver!==receiver||
 (receiver===null?(f.accountStatus!=='anonymous_reference'||f.receiverPrincipalRaw!==null||f.baseBorrowIndexRaw!==null):
 !/^0x[0-9a-f]{40}$/.test(receiver)||(f.accountStatus==='quoted'?(!signedPrincipal(f.receiverPrincipalRaw)||!raw(f.baseBorrowIndexRaw)||BigInt(f.baseBorrowIndexRaw)===0n||BigInt(f.baseBorrowIndexRaw)>=(1n<<64n)):
 f.accountStatus!=='unavailable'||f.receiverPrincipalRaw!==null||f.baseBorrowIndexRaw!==null)))return null
 seen.add(o.originHostSha256)}
 return JSON.stringify(a.origins[0].facts)===JSON.stringify(a.origins[1].facts)?structuredClone(a):null
 }catch{return null}
}
