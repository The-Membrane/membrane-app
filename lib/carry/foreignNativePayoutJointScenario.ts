import { buildConditionalTimeProcess, type ConditionalTimeProcessInput } from '../venueForecast/conditionalTimeProcess'

export const FOREIGN_JOINT_NATIVE_REQUIREMENTS = [
  { routeKey:'AUSD → Staked USDat [USDat]', destination:'0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    nativeAsset:'0x23238f20b894f29041f48d88ee91131c395aaa71', nativeDecimals:6,
    finalAsset:'0x00000000efe302beaa2b3e6e1b18d08d69a9012a', finalDecimals:6,
    remainingInputs:['owned_full_share_USDat_entitlement_at_source','USDat_cash_and_same_regime_native_history',
      'owned_queue_processing_and_claim_conditions','exact_size_USDat_USDC_AUSD_conversion_or_declared_joint_terms'] },
  { routeKey:'PYUSD → StakingVault [wYLDS]', destination:'0x19ebb35279a16207ec4ba82799cc64715065f7f6',
    nativeAsset:'0x6ad038ca6c04e885630851278ca0a856ad9a66cc', nativeDecimals:6,
    finalAsset:'0x6c3ea9036406852006290770bedfcaba0e23a0e8', finalDecimals:6,
    remainingInputs:['owned_full_PRIME_wYLDS_entitlement_at_source','wYLDS_cash_and_compatible_native_history',
      'owned_redemption_and_administrator_settlement_terms','exact_size_wYLDS_USDC_PYUSD_conversion_or_declared_joint_terms'] },
  { routeKey:'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]', destination:'0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    nativeAsset:'0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34', nativeDecimals:18,
    finalAsset:'0x4c9edd5852cd905f086c759e8383e09bff1e68b3', finalDecimals:18,
    remainingInputs:['owned_full_wrapper_PT_entitlement_and_control_at_source','native_PT_cash_and_compatible_history',
      'PT_maturity_market_SY_release_and_redemption_terms','exact_size_final_USDe_conversion_or_declared_joint_terms'] },
  { routeKey:'USDT → FluidBridgeAggregatorProxy [USDC]', destination:'0x273da948aca9261043fbdb2a857bc255ecc29012',
    nativeAsset:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', nativeDecimals:6,
    finalAsset:'0xdac17f958d2ee523a2206206994597c13d831ec7', finalDecimals:6,
    remainingInputs:['owned_full_bridge_share_USDC_entitlement_at_source','indexed_USDC_native_cash_and_compatible_history',
      'bridge_pullability_fee_and_pause_terms','original_exact_size_USDC_USDT_quote_captures_or_declared_joint_terms'] },
] as const
type Source = { chainId:1; block:string; blockHash:string; blockTime:string; readAt:string }
type Provenance = { datasetSha256:string; receiptSha256:string; contractAddress:string; method:string; reviewRef:string }
type Terms = { nativeAsset:string; nativeDecimals:number; finalAsset:string; finalDecimals:number;
  source:Source; availableAtUtc:string; provenance:Provenance; mechanismAssumptions:string[] }
export type ForeignJointConversion = Terms & (
  { kind:'original_exact_size_quote'; nativeInputRaw:string; finalOutputRaw:string }
  | { kind:'declared_linear_native_to_final_scenario'; numeratorFinalRaw:string; denominatorNativeRaw:string;
      feeFinalRaw:string; declarationRef:string }
)
export type ForeignNativePayoutJointInput = {
  question:{ routeKey:string; destination:string; owner:string; nativeAsset:string; nativeDecimals:number;
    finalAsset:string; finalDecimals:number; requestedFinalRaw:string; issuedAtUtc:string; horizonHours:number }
  native:{ source:Source; cashRaw:string; fullEntitlementRaw:string; fullOwnedSharesRaw:string;
    additionalCompetitionNativeRaw:string; regime:string; provenance:Provenance;
    history:ConditionalTimeProcessInput['observations'] }
  conversion:ForeignJointConversion
}
const MAX=(1n<<256n)-1n
const raw=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<=MAX
const address=(v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{40}$/.test(v)
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const utc=(v:unknown):v is string=>typeof v==='string'&&Number.isSafeInteger(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const provenance=(v:Provenance)=>v&&sha(v.datasetSha256)&&sha(v.receiptSha256)&&address(v.contractAddress)&&
  typeof v.method==='string'&&v.method.length>0&&v.method.length<=128&&typeof v.reviewRef==='string'&&v.reviewRef.length>0&&v.reviewRef.length<=512

/** Original private native/history qualification is required before cloning.
 * Exact conversion quote qualification is separate. Declared rates have explicit
 * provenance/assumptions and never become executable venue quotes or causal news.
 * API enrollment for these required native/history/conversion inputs remains open. */
export function buildForeignNativePayoutJointScenario(original:ForeignNativePayoutJointInput,
  qualifyOriginalNativeAndHistory:(v:ForeignNativePayoutJointInput)=>boolean,
  qualifyOriginalExactQuote:(v:ForeignJointConversion)=>boolean=()=>false) {
  try {
    if(!original||qualifyOriginalNativeAndHistory(original)!==true)return null
    const exactApproved=original.conversion?.kind==='original_exact_size_quote'&&qualifyOriginalExactQuote(original.conversion)===true
    const input=structuredClone(original),q=input.question,n=input.native,c=input.conversion
    const mechanism=FOREIGN_JOINT_NATIVE_REQUIREMENTS.find(m=>m.routeKey===q.routeKey&&m.destination===q.destination)
    if(!mechanism||!address(q.owner)||!['nativeAsset','nativeDecimals','finalAsset','finalDecimals'].every(k=>(q as any)[k]===(mechanism as any)[k])||
      !raw(q.requestedFinalRaw)||q.requestedFinalRaw==='0'||!utc(q.issuedAtUtc)||!Number.isSafeInteger(q.horizonHours)||q.horizonHours<1||q.horizonHours>720||
      ![n.cashRaw,n.fullEntitlementRaw,n.fullOwnedSharesRaw,n.additionalCompetitionNativeRaw].every(raw)||n.fullOwnedSharesRaw==='0'||
      !provenance(n.provenance)||!provenance(c.provenance)||n.source.chainId!==1||!raw(n.source.block)||n.source.block==='0'||
      !/^0x[a-f0-9]{64}$/.test(n.source.blockHash)||![n.source.blockTime,n.source.readAt,c.availableAtUtc].every(utc)||
      !same(n.source,c.source)||Date.parse(c.availableAtUtc)>Date.parse(q.issuedAtUtc)||Date.parse(c.availableAtUtc)<Date.parse(n.source.blockTime)||
      !['nativeAsset','nativeDecimals','finalAsset','finalDecimals'].every(k=>(c as any)[k]===(q as any)[k])||
      !Array.isArray(c.mechanismAssumptions)||c.mechanismAssumptions.length<1||c.mechanismAssumptions.length>16||
      c.mechanismAssumptions.some(x=>typeof x!=='string'||!x||x.length>512)||
      !Array.isArray(n.history)||n.history.length<2||n.history.length>256)return null
    if(c.kind==='original_exact_size_quote') {
      if(!exactApproved||!raw(c.nativeInputRaw)||c.nativeInputRaw==='0'||!raw(c.finalOutputRaw)||BigInt(c.nativeInputRaw)>BigInt(n.fullEntitlementRaw))return null
    }else if(c.kind==='declared_linear_native_to_final_scenario'){
      if(!raw(c.numeratorFinalRaw)||!raw(c.denominatorNativeRaw)||c.denominatorNativeRaw==='0'||!raw(c.feeFinalRaw)||
        !c.declarationRef||c.declarationRef.length>512)return null
    }else return null
    const channel={key:'cash',assetAddress:q.nativeAsset,decimals:q.nativeDecimals,
      unit:'native_intermediate_cash',negativeHandling:'clamp_zero' as const}
    if(n.history.some(o=>!same(o.channels,[channel])||o.regime!==n.regime||Object.keys(o.valuesByChannel).join(',')!=='cash'))return null
    const Ea=BigInt(n.fullEntitlementRaw),M=BigInt(n.additionalCompetitionNativeRaw)
    const convert=(native:bigint)=>{
      if(c.kind==='original_exact_size_quote'){
        if(native<BigInt(c.nativeInputRaw))throw Error('exact_size_conversion_unavailable')
        return BigInt(c.finalOutputRaw) // fixed original action only, NEVER quote-rate scaling.
      }
      const product=native*BigInt(c.numeratorFinalRaw)
      if(product>MAX)throw Error('conversion_intermediate_overflow')
      const gross=product/BigInt(c.denominatorNativeRaw),fee=BigInt(c.feeFinalRaw)
      return gross>fee?gross-fee:0n
    }
    const measure=(state:Record<string,string>)=>{
      const cash=BigInt(state.cash),afterM=cash>M?cash-M:0n,capacity=afterM<Ea?afterM:Ea
      return {availableRaw:String(convert(capacity)),entitlementRaw:String(convert(Ea))}
    }
    const approved:ConditionalTimeProcessInput={channels:[channel],observations:n.history,
      outputAsset:{assetAddress:q.finalAsset,decimals:q.finalDecimals},
      measurementRule:'native_cash_clipped_Ea_then_same_source_explicit_conversion_then_final_Q_once',
      current:{sourceAtUtc:n.source.blockTime,readAtUtc:n.source.readAt,regime:n.regime,
        valuesByChannel:{cash:n.cashRaw},provenanceRef:n.source.block+':'+n.source.blockHash,fullEntitlementRaw:n.fullEntitlementRaw},
      issueAtUtc:q.issuedAtUtc,requestedRaw:q.requestedFinalRaw,horizonHours:q.horizonHours,maxHistoricalGapSeconds:91800}
    const process=buildConditionalTimeProcess(approved,candidate=>same(candidate,approved),measure)
    if(!process)return null
    let currentHeadroomRaw:string|null=null
    try {currentHeadroomRaw=String(BigInt(measure({cash:n.cashRaw}).availableRaw)-BigInt(q.requestedFinalRaw))}catch{}
    const usable=process.scenarios.filter(s=>s.targetHeadroomRaw!==null)
    const shrinking=currentHeadroomRaw===null?null:usable.filter(s=>BigInt(s.targetHeadroomRaw!)<BigInt(currentHeadroomRaw!)).length
    return {schema:'foreign_native_payout_joint_scenario_v1' as const,question:q,native:n,conversion:c,mechanism,
      basis:c.kind,scope:c.kind==='original_exact_size_quote'?'fixed_exact_sized_action_only_no_partial_quote':'declared_linear_joint_conversion_assumption',
      process,currentHeadroomRaw,shrinking:{shrinkingScenarios:shrinking,usableScenarios:usable.length,
        censoredScenarios:process.scenarios.length-usable.length},
      accounting:'historical_NET_includes_other_users_native_M_once_final_Q_once_after_conversion' as const,
      durationAndRecoveryBasis:'sampled_conditional_shortfall_onset_recovery_brackets_not_matched_historical_recovery' as const,
      actualApiEnrollment:'required_original_native_history_and_conversion_receipts_not_enrolled' as const,
      continuousCapacityKnown:false as const,calibrated:false as const,causalNewsEffect:false as const,
      holderExecutableExit:false as const,forecastValidated:false as const}
  }catch{return null}
}
