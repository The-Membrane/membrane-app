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
 ...[
 ['apxUSD → ApyUSD [apxUSD]','0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'],
 ['GHO → sGho [GHO]','0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'],
 ['GHO → UmbrellaStakeToken [GHO]','0x4f827a63755855cdf3e8f3bcd20265c833f15033'],
 ['USDC → USD3 [USDC]','0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'],
 ['USDe → Staked USDe [USDe]','0x9d39a5de30e57443bff2a8307a4256c8797a3497'],
 ['USDC → Fluid USD Coin [USDC]','0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'],
 ['USDT → fToken [USDT]','0x5c20b550819128074fd538edf79791733ccedd18'],
 ['GHO → fToken [GHO]','0x6a29a46e21c730dca1d8b23d637c101cec605c5b'],
 ['USDC → FluidBridgeAggregatorProxy [USDC]','0x273da948aca9261043fbdb2a857bc255ecc29012'],
 ].flatMap(([routeKey,destination])=>{
 const identity=registeredConditionalSampledCashIdentity(routeKey,destination)
 return identity&&[6,18].includes(identity.assetDecimals)?[{routeKey,destination,underlying:identity.asset,decimals:identity.assetDecimals as 6|18,pool:destination}]:[]
 }),
]
export const erc4626InitialDepositMarket=(routeKey:string,destination:string)=>ERC4626_INITIAL_DEPOSIT_MARKETS.find(m=>m.routeKey===routeKey&&m.destination===destination)
/** Enrollment is a required native read plan, not evidence that a candidate implements ERC4626. */
export function initialDepositPreviewMechanism(routeKey:string) {
 const common={receiptMethod:'previewDeposit_D_then_previewRedeem_full_minted_S' as const,
   nativeMethodSupport:'requires_actual_two_origin_source_reads' as const,
   sourcePreviewHeldConstant:true as const, cashRetainedAfterDeposit:'assumed_not_observed' as const,
   receiptIsRouteExitCapacity:false as const, executable:false as const}
 if(/VaultV2/.test(routeKey))return{...common,kind:'morpho_v2_source_preview',limits:['allocation_and_adapter_pullability_unmodeled','future_gates_and_fees_unmodeled']}
 if(routeKey==='apxUSD → ApyUSD [apxUSD]')return{...common,kind:'apy_deposit_preview_candidate',limits:['withdrawal_receipt_not_created','receipt_fee_curve_and_maturity_unmodeled','pause_and_claim_permissions_unmodeled']}
 if(routeKey==='USDe → Staked USDe [USDe]')return{...common,kind:'ethena_source_preview',limits:['cooldown_not_initiated','silo_claim_maturity_unmodeled','future_cooldown_and_permissions_unmodeled']}
 if(routeKey==='GHO → UmbrellaStakeToken [GHO]')return{...common,kind:'umbrella_source_preview_candidate',limits:['staker_cooldown_not_initiated','withdrawal_window_unmodeled','penalty_and_slashing_unmodeled']}
 if(routeKey==='USDC → USD3 [USDC]')return{...common,kind:'usd3_strategy_preview_candidate',limits:['liquid_strategy_limit_and_shutdown_unmodeled','strategy_and_future_receiver_admission_unmodeled']}
 if(routeKey==='GHO → sGho [GHO]')return{...common,kind:'sgho_source_preview_candidate',limits:['convertToAssets_is_not_substituted_for_previewRedeem','future_rate_and_withdrawal_admission_unmodeled']}
 if(routeKey==='USDC → FluidBridgeAggregatorProxy [USDC]')return{...common,kind:'fluid_bridge_preview_candidate',limits:['deposit_method_support_unverified_until_native_read','indexed_bridge_conversion_and_withdrawal_fee_unmodeled','liquidity_and_adapter_pullability_unmodeled']}
 if(/fToken|Fluid USD Coin/.test(routeKey))return{...common,kind:'fluid_ftoken_preview_candidate',limits:['previewDeposit_support_unverified_until_native_read','indexed_liquidity_and_exchange_price_future_path_unmodeled','native_liquidity_limits_unmodeled']}
 return{...common,kind:'sky_savings_source_preview',limits:['savings_income_and_future_gates_unmodeled','deposit_retention_in_cash_channel_unverified']}
}
export type Erc4626InitialDepositFacts={vault:string;asset:string;assetDecimals:number;shareDecimals:number;depositAssetsRaw:string;mintedSharesRaw:string;entitlementRaw:string;receiver:string|null;maxDepositRaw:string|null;maxDepositStatus:'quoted'|'unavailable'|'not_requested'}
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
 f.depositAssetsRaw!==d||!raw(f.mintedSharesRaw)||f.mintedSharesRaw==='0'||!raw(f.entitlementRaw)||f.entitlementRaw==='0'||f.receiver!==receiver||
 (receiver===null?(f.maxDepositRaw!==null||f.maxDepositStatus!=='not_requested'):
 f.maxDepositStatus==='quoted'?!raw(f.maxDepositRaw):f.maxDepositStatus!=='unavailable'||f.maxDepositRaw!==null))return null
 seen.add(o.originHostSha256)}
 return JSON.stringify(a.origins[0].facts)===JSON.stringify(a.origins[1].facts)?structuredClone(a):null
 }catch{return null}
}
