import identities from './morpho-v2-asset-identities.json'
import {registeredConditionalSampledCashIdentity,type ConditionalSampledCashCurrentSource} from './conditionalSampledCashPathProjection'
const MAX=(1n<<256n)-1n
const raw=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<=MAX
export const ERC4626_INITIAL_DEPOSIT_MARKETS = [
 ...identities.entries.flatMap(({vault,asset})=>['AUSD','EURCV','LINK','PYUSD','RLUSD','USDC','USDT'].flatMap(symbol=>{
 const routeKey=`${symbol} → VaultV2 [${symbol}]`,identity=registeredConditionalSampledCashIdentity(routeKey,vault)
 return identity?.asset===asset&&[6,18].includes(identity.assetDecimals)?[{routeKey,destination:vault,underlying:asset,decimals:identity.assetDecimals as 6|18,pool:vault}]:[]
 })),
 {routeKey:'USDS → SUsds [USDS]',destination:'0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',underlying:'0xdc035d45d973e3ec169d2276ddab16f1e407384f',decimals:18 as const,pool:'0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'},
 {routeKey:'USDS → StUsds [USDS]',destination:'0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',underlying:'0xdc035d45d973e3ec169d2276ddab16f1e407384f',decimals:18 as const,pool:'0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'},
]
export const erc4626InitialDepositMarket=(routeKey:string,destination:string)=>ERC4626_INITIAL_DEPOSIT_MARKETS.find(m=>m.routeKey===routeKey&&m.destination===destination)
export type Erc4626InitialDepositFacts={vault:string;asset:string;assetDecimals:number;shareDecimals:number;depositAssetsRaw:string;mintedSharesRaw:string;entitlementRaw:string;receiver:string|null;maxDepositRaw:string|null}
export type Erc4626InitialDepositAgreement={status:'agreed_erc4626_initial_deposit_facts';currentSource:ConditionalSampledCashCurrentSource;readAt:string;origins:{originHostSha256:string;facts:Erc4626InitialDepositFacts}[]}
export function selectedErc4626InitialDepositAgreement(v:unknown,s:ConditionalSampledCashCurrentSource,d:string,receiver:string|null,now:number):Erc4626InitialDepositAgreement|null{
 try{
 const m=erc4626InitialDepositMarket(s.routeKey,s.destination),a=v as Erc4626InitialDepositAgreement
 if(!m||s.asset!==m.underlying||s.assetDecimals!==m.decimals||!raw(d)||d==='0'||
 (receiver!==null&&!/^0x[0-9a-f]{40}$/.test(receiver))||!a||a.status!=='agreed_erc4626_initial_deposit_facts'||JSON.stringify(a.currentSource)!==JSON.stringify(s)||
 !Number.isSafeInteger(now)||s.chainId!==1||!['manifest_bound_ledger','live_read_only_two_origin_finalized'].includes(s.sourceKind)||
 !raw(s.cashRaw)||!/^[1-9][0-9]*$/.test(s.block)||!/^0x[a-f0-9]{64}$/.test(s.blockHash)||
 !Number.isFinite(Date.parse(s.blockTime))||!Number.isFinite(Date.parse(s.readAt))||Date.parse(s.blockTime)>Date.parse(s.readAt)||Date.parse(s.readAt)>now||now-Date.parse(s.blockTime)>1800000||
 !Number.isFinite(Date.parse(a.readAt))||Date.parse(a.readAt)<Date.parse(s.readAt)||Date.parse(a.readAt)>now||!Array.isArray(a.origins)||a.origins.length!==2)return null
 const seen=new Set<string>()
 for(const o of a.origins){const f=o.facts
 if(!/^[a-f0-9]{64}$/.test(o.originHostSha256)||seen.has(o.originHostSha256)||!f||f.vault!==s.destination||f.asset!==s.asset||f.assetDecimals!==s.assetDecimals||!Number.isInteger(f.shareDecimals)||f.shareDecimals<0||f.shareDecimals>36||
 f.depositAssetsRaw!==d||!raw(f.mintedSharesRaw)||f.mintedSharesRaw==='0'||!raw(f.entitlementRaw)||f.entitlementRaw==='0'||f.receiver!==receiver||(receiver===null?f.maxDepositRaw!==null:!raw(f.maxDepositRaw)))return null
 seen.add(o.originHostSha256)}
 return JSON.stringify(a.origins[0].facts)===JSON.stringify(a.origins[1].facts)?structuredClone(a):null
 }catch{return null}
}
