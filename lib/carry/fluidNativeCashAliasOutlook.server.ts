import {loadPinnedAudit} from '../../scripts/research/conditional-cash-time-holdout.mjs'
import {selectedOriginalFluidUsdtBridgeNativeCapacity,type FluidUsdtBridgeNativeCapacityBinding} from './fluidUsdtBridgeNativeCapacity.server'
import type {ConditionalSampledCashHistory} from './conditionalSampledCashPathProjection'
const ROUTE='USDT → FluidBridgeAggregatorProxy [USDC]',DONOR='USDC → FluidBridgeAggregatorProxy [USDC]',VAULT='0x273da948aca9261043fbdb2a857bc255ecc29012',USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',USDT='0xdac17f958d2ee523a2206206994597c13d831ec7'
const MAX=(1n<<256n)-1n
/** Retain the existing original native/quote qualification even if richer history
 * is absent. Generic bridge-wallet history cannot become fUSDC pullability history. */
export function issueFluidNativeCashAliasOutlook(original:unknown,binding:FluidUsdtBridgeNativeCapacityBinding,horizonHours:number){
 try{
 const fact=selectedOriginalFluidUsdtBridgeNativeCapacity(original,binding)
 if(!fact||fact.routeKey!==ROUTE||fact.destination!==VAULT||fact.owner!==binding.owner||fact.requestedFinalUsdtRaw!==binding.requestedFinalUsdtRaw||
 !Number.isSafeInteger(horizonHours)||horizonHours<1||horizonHours>8760)return null
 const audit=loadPinnedAudit(),history=Object.values(audit.histories).find((h:any)=>h.identity.routeKey===DONOR&&h.identity.destination===VAULT&&h.identity.asset===USDC&&h.identity.assetDecimals===6) as ConditionalSampledCashHistory|undefined
 const issue=new Date(binding.asOfMs).toISOString()
 const prongs=Object.values(fact.nativeProngs).map(BigInt),gross=prongs.reduce((a,b)=>a<b?a:b),product=gross*BigInt(10000-fact.withdrawalFeeBps)
 if(product>MAX||fact.withdrawalFeeBps<0||fact.withdrawalFeeBps>=10000)return null
 const net=fact.paused?0n:product/10000n,E=BigInt(fact.fullNetEaRaw),capacity=net<E?net:E,R=BigInt(fact.requiredNetUsdcRaw)
 if(selectedOriginalFluidUsdtBridgeNativeCapacity(original,binding)!==fact)return null
 return{schema:'fluid_native_cash_alias_outlook_v1' as const,
 question:{routeKey:ROUTE,destination:VAULT,owner:fact.owner,requestedFinalRaw:fact.requestedFinalUsdtRaw,finalAsset:USDT,finalDecimals:6,
 nativeAsset:USDC,nativeDecimals:6,horizonHours,issuedAtUtc:issue,targetAtUtc:new Date(binding.asOfMs+horizonHours*3600000).toISOString(),currentSource:fact.source},
 sourceProofValidUntil:new Date(Date.parse(fact.source.blockTime)+1800000).toISOString(),
 current:{fullOwnedSharesRaw:fact.sharesRaw,shareDecimals:18,fullNetEaRaw:fact.fullNetEaRaw,nativeProngs:fact.nativeProngs,withdrawalFeeBps:fact.withdrawalFeeBps,paused:fact.paused,
 conditionalNetNativeFundingRaw:String(capacity),requiredNetUsdcRaw:fact.requiredNetUsdcRaw,conditionalNativeFundingHeadroomRaw:String(capacity-R),
 exactSizedRoundtripUsdtRaw:fact.roundtripUsdtRaw,additionalCompetitionNativeRaw:'0',quoteScaling:false as const},
 historyCandidate:history?{identity:history.identity,witness:history.witness,pointCount:history.points.length,
 availableAtIssue:Date.parse(history.witness.availableAt)<=binding.asOfMs,
 sameContractAndNativeUnits:true as const,meaningAgreementQualified:false as const}:null,
 cashAlias:{status:'original_wallet_measurement_and_history_method_agreement_required' as const,
 genericHistoryMeaning:'underlying_balanceOf_bridge_candidate_requires_original_manifest_method_review',
 originalCurrentMeaning:'min_fUSDC_maxWithdraw_bank_cash_supply_and_resolver_limits_after_fee',
 meaningsMayNotBeSubstituted:true as const},
 conditionalJointProcess:null,futureRecovery:null,
 missingInputs:['original_two_origin_USDC_balanceOf_bridge_at_exact_current_source',
 'authenticated_historical_normalizer_and_manifest_method_agreement_for_bridge_wallet_cash',
 'same_measurement_historical_path_for_bank_supply_resolver_and_fUSDC_pullability_bottlenecks',
 'qualified_release_and_full_route_conversion_execution_timing'],
 richerHistoricalIssuerUnchanged:true as const,fullRouteDeliveryCensored:true as const,
 scope:'current_original_native_quote_funding_diagnostic_not_future_wallet_alias_forecast' as const,
 accounting:'gross_native_prongs_fee_once_clip_net_Ea_required_USDC_exact_quote_cost_once_not_final_USDT_Q_again' as const,
 holderExecutableExit:false as const,forecastValidated:false as const,calibratedProbability:false as const}
 }catch{return null}
}
export type FluidNativeCashAliasOutlook=NonNullable<ReturnType<typeof issueFluidNativeCashAliasOutlook>>
