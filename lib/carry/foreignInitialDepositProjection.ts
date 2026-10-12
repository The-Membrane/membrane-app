import { originalQualifiedForeignNativeReceipt } from './foreignInitialDepositNativeEnrollment'
/** The four foreign-native groups are multi-leg mechanisms, not missing same-asset cash rows. */
export const FOREIGN_INITIAL_DEPOSIT_MECHANISMS = [
 {routeKey:'AUSD → Staked USDat [USDat]',destination:'0xd166337499e176bbc38a1fbd113ab144e5bd2df7',nativeDecimals:6,finalDecimals:6,shareDecimals:18,nativeAsset:'0x23238f20b894f29041f48d88ee91131c395aaa71',finalAsset:'0x00000000efe302beaa2b3e6e1b18d08d69a9012a',legs:['original_AUSD_to_USDat_acquisition','USDat_deposit_to_staked_receipt','request_owned_queue_ticket','operator_processing_and_USDat_claim','USDat_to_USDC_to_AUSD'],limits:['inbound_original_asset_acquisition_unassessed','operator_processing_time_unknown','whole_ticket_minimum_and_pause_rules_required','exact_size_conversion_not_linearly_scaled']},
 {routeKey:'PYUSD → StakingVault [wYLDS]',destination:'0x19ebb35279a16207ec4ba82799cc64715065f7f6',nativeDecimals:6,finalDecimals:6,shareDecimals:6,nativeAsset:'0x6ad038ca6c04e885630851278ca0a856ad9a66cc',finalAsset:'0x6c3ea9036406852006290770bedfcaba0e23a0e8',legs:['original_PYUSD_to_wYLDS_acquisition','wYLDS_deposit_to_PRIME_receipt','PRIME_redeem_to_wYLDS','wYLDS_queue_request_admin_settlement_to_USDC','USDC_to_PYUSD'],limits:['inbound_original_asset_acquisition_unassessed','new_deposit_does_not_create_existing_redemption_queue','administrator_settlement_time_unknown','final_PYUSD_conversion_unassessed']},
 {routeKey:'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',destination:'0x0af56afbddcb140323445bd7211ba90e54e5fd1c',nativeDecimals:18,finalDecimals:18,shareDecimals:18,nativeAsset:'0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',finalAsset:'0x4c9edd5852cd905f086c759e8383e09bff1e68b3',legs:['original_USDe_to_PT_acquisition','native_PT_deposit_to_wrapper_receipt','wrapper_release_to_PT','PT_maturity_or_market_conversion_to_SY','SY_to_USDe'],limits:['native_PT_is_not_USDe','wrapper_and_Aave_admission_unassessed','borrower_control_not_inferred','PT_SY_and_USDe_conversion_requires_separate_source_quotes']},
 {routeKey:'USDT → FluidBridgeAggregatorProxy [USDC]',destination:'0x273da948aca9261043fbdb2a857bc255ecc29012',nativeDecimals:6,finalDecimals:6,shareDecimals:18,nativeAsset:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',finalAsset:'0xdac17f958d2ee523a2206206994597c13d831ec7',legs:['original_USDT_to_USDC_acquisition','USDC_deposit_to_bridge_receipt','bridge_redeem_to_USDC','exact_size_USDC_to_USDT_conversion'],limits:['native_USDC_is_not_USDT','bridge_fee_and_indexed_liquidity_unmodeled','ten_retained_original_quote_captures_known_but_package_originals_not_present','no_quote_amount_or_source_interpolation']},
] as const
export const foreignInitialDepositMechanism=(routeKey:string,destination:string)=>FOREIGN_INITIAL_DEPOSIT_MECHANISMS.find(m=>m.routeKey===routeKey&&m.destination===destination.toLowerCase())
export type ForeignInitialDepositSource={chainId:1;block:string;blockHash:string;blockTime:string;readAt:string}
export type ForeignInitialDepositQuestion={routeKey:string;destination:string;
 /** The amount entered in the original route asset. Never reused as native raw D. */
 originalDeposit:{asset:string;decimals:number;raw:string};
 nativeDepositRaw:string;nativeDecimals:number;plannedFinalExitRaw:string;finalDecimals:number;receiver:string|null;horizonHours:number;issuedAtUtc:string;source:ForeignInitialDepositSource}
export type ForeignInitialDepositAcquisition={
 kind:'exact_original_to_native_source_quote'|'declared_original_to_native_funding_scenario';
 inputAsset:string;inputDecimals:number;inputRaw:string;outputAsset:string;outputDecimals:number;outputRaw:string;
 source:ForeignInitialDepositSource;availableAtUtc:string;provenanceRef:string;
 declaredBy:'user'|'research'|null;assumptions:string[];
}
export type ForeignInitialDepositNativeReceipt={question:ForeignInitialDepositQuestion;nativeAsset:string;mintedSharesRaw:string;shareDecimals:number;fullNativeEntitlementRaw:string;maxDepositRaw:string|null;maxDepositStatus:'quoted'|'unavailable'|'not_requested';acquiredAtUtc:string;origins:[string,string];method:'previewDeposit_D_then_previewRedeem_full_minted_S';evidenceRefs:string[]}
export type ForeignInitialDepositConversion = {
 kind:'exact_source_quote'|'explicit_conditional_rate_fee_scenario';inputAsset:string;outputAsset:string;
 inputRaw:string;outputRaw:string;source:ForeignInitialDepositSource;availableAtUtc:string;
 /** A declared scenario is user/research input, never an authenticated venue quote. */
 provenanceRef:string;assumptions:string[]
}
const MAX=(1n<<256n)-1n
const raw=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)&&BigInt(v)<=MAX
const semantic=(v:unknown):string=>JSON.stringify(v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,x&&typeof x==='object'?JSON.parse(semantic(x)):x])):v)
const utc=(v:string)=>Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v
/** Rate dimensions are final raw units / native raw units, never a reusable sized venue quote. */
export function foreignInitialDepositRateScenario(receipt:ForeignInitialDepositNativeReceipt,finalAsset:string,terms:{numeratorFinalRaw:string;denominatorNativeRaw:string;feeFinalRaw:string;provenanceRef:string;assumptions:string[]}):ForeignInitialDepositConversion|null{
 try{
 if(!raw(receipt.fullNativeEntitlementRaw)||!raw(terms.numeratorFinalRaw)||!raw(terms.denominatorNativeRaw)||terms.denominatorNativeRaw==='0'||!raw(terms.feeFinalRaw)||!terms.provenanceRef||!Array.isArray(terms.assumptions)||!terms.assumptions.length)return null
 const product=BigInt(receipt.fullNativeEntitlementRaw)*BigInt(terms.numeratorFinalRaw)
 if(product>MAX)return null
 if(!/^0x[0-9a-f]{40}$/.test(finalAsset))return null
 const gross=product/BigInt(terms.denominatorNativeRaw),fee=BigInt(terms.feeFinalRaw)
 return{kind:'explicit_conditional_rate_fee_scenario',inputAsset:receipt.nativeAsset,outputAsset:finalAsset,inputRaw:receipt.fullNativeEntitlementRaw,
 outputRaw:String(gross>fee?gross-fee:0n),source:receipt.question.source,availableAtUtc:receipt.acquiredAtUtc,
 provenanceRef:terms.provenanceRef,assumptions:[...terms.assumptions,
 `declared_rate_final_raw_per_native_raw=${terms.numeratorFinalRaw}/${terms.denominatorNativeRaw}`,
 `declared_fee_final_raw=${terms.feeFinalRaw}`,'all_intermediate_legs_and_rate_persistence_assumed_not_observed']}
 }catch{return null}
}
/** Qualify original native reads and exact quote receipts before any clone/transport. */
export function buildForeignInitialDepositProjection(input:{question:ForeignInitialDepositQuestion;nativeAcquisition:ForeignInitialDepositAcquisition|null;nativeReceipt:ForeignInitialDepositNativeReceipt|null;conversion:ForeignInitialDepositConversion|null},qualifyOriginal:(v:typeof input)=>boolean,qualifyExactQuote:(v:ForeignInitialDepositConversion)=>boolean=()=>false,qualifyAcquisitionQuote:(v:ForeignInitialDepositAcquisition)=>boolean=()=>false){
 try{
 if(!input||!qualifyOriginal(input)|| (input.nativeReceipt && !originalQualifiedForeignNativeReceipt(input.nativeReceipt)))return null
 const exactApproved=input.conversion?.kind==='exact_source_quote'&&qualifyExactQuote(input.conversion)
 const acquisitionApproved=input.nativeAcquisition?.kind==='exact_original_to_native_source_quote'&&qualifyAcquisitionQuote(input.nativeAcquisition)
 input=structuredClone(input)
 const q=input.question,m=foreignInitialDepositMechanism(q.routeKey,q.destination),s=q.source,issue=Date.parse(q.issuedAtUtc)
 if(!m||!q.originalDeposit||q.originalDeposit.asset!==m.finalAsset||q.originalDeposit.decimals!==m.finalDecimals||!raw(q.originalDeposit.raw)||q.originalDeposit.raw==='0'||!raw(q.nativeDepositRaw)||q.nativeDepositRaw==='0'||!raw(q.plannedFinalExitRaw)||q.plannedFinalExitRaw==='0'||!Number.isInteger(q.nativeDecimals)||q.nativeDecimals<0||q.nativeDecimals>36||q.nativeDecimals!==m.nativeDecimals||q.finalDecimals!==m.finalDecimals||!Number.isInteger(q.finalDecimals)||q.finalDecimals<0||q.finalDecimals>36||!Number.isFinite(q.horizonHours)||q.horizonHours<1||q.horizonHours>720||!utc(q.issuedAtUtc)||s.chainId!==1||!/^[1-9][0-9]*$/.test(s.block)||!/^0x[0-9a-f]{64}$/.test(s.blockHash)||!utc(s.blockTime)||!utc(s.readAt)||Date.parse(s.blockTime)>Date.parse(s.readAt)||Date.parse(s.readAt)>issue||issue-Date.parse(s.blockTime)>1800000||(q.receiver!==null&&!/^0x[0-9a-f]{40}$/.test(q.receiver)))return null
 const acquisition=input.nativeAcquisition
 if(acquisition&&(!['exact_original_to_native_source_quote','declared_original_to_native_funding_scenario'].includes(acquisition.kind)||
 acquisition.inputAsset!==q.originalDeposit.asset||acquisition.inputDecimals!==q.originalDeposit.decimals||acquisition.inputRaw!==q.originalDeposit.raw||
 acquisition.outputAsset!==m.nativeAsset||acquisition.outputDecimals!==q.nativeDecimals||acquisition.outputRaw!==q.nativeDepositRaw||
 semantic(acquisition.source)!==semantic(s)||!utc(acquisition.availableAtUtc)||Date.parse(acquisition.availableAtUtc)>issue||Date.parse(acquisition.availableAtUtc)<Date.parse(s.blockTime)||
 !acquisition.provenanceRef||acquisition.provenanceRef.length>512||!Array.isArray(acquisition.assumptions)||acquisition.assumptions.some(x=>typeof x!=='string'||!x||x.length>512)||
 (acquisition.kind==='exact_original_to_native_source_quote'?!acquisitionApproved||acquisition.declaredBy!==null:
 !['user','research'].includes(acquisition.declaredBy??'')||!acquisition.assumptions.length)))return null
 if(input.nativeReceipt&&!acquisition)return null
 const r=input.nativeReceipt
 if(r&&(semantic(r.question)!==semantic(q)||r.nativeAsset!==m.nativeAsset||!raw(r.mintedSharesRaw)||r.mintedSharesRaw==='0'||!raw(r.fullNativeEntitlementRaw)||!Number.isInteger(r.shareDecimals)||r.shareDecimals<0||r.shareDecimals>36||r.shareDecimals!==m.shareDecimals||!utc(r.acquiredAtUtc)||Date.parse(r.acquiredAtUtc)>issue||Date.parse(r.acquiredAtUtc)<Date.parse(s.blockTime)||r.origins.length!==2||r.origins[0]===r.origins[1]||r.origins.some(h=>!/^[a-f0-9]{64}$/.test(h))||r.method!=='previewDeposit_D_then_previewRedeem_full_minted_S'||r.evidenceRefs.length===0||r.evidenceRefs.some(x=>typeof x!=='string'||!x||x.length>512)||
 (q.receiver===null?(r.maxDepositRaw!==null||r.maxDepositStatus!=='not_requested'):r.maxDepositStatus==='quoted'?!raw(r.maxDepositRaw):r.maxDepositStatus!=='unavailable'||r.maxDepositRaw!==null)))return null
 const c=input.conversion
 if(c&&(!r||!['exact_source_quote','explicit_conditional_rate_fee_scenario'].includes(c.kind)||c.inputAsset!==m.nativeAsset||c.outputAsset!==m.finalAsset||c.inputRaw!==r.fullNativeEntitlementRaw||!raw(c.outputRaw)||semantic(c.source)!==semantic(s)||!utc(c.availableAtUtc)||Date.parse(c.availableAtUtc)>issue||Date.parse(c.availableAtUtc)<Date.parse(s.blockTime)||!c.provenanceRef||c.provenanceRef.length>512||!Array.isArray(c.assumptions)||(c.kind==='exact_source_quote'?!exactApproved:c.assumptions.length===0)))return null
 const output=c?BigInt(c.outputRaw):null
 return {schema:'foreign_initial_deposit_projection_v1' as const,status:'conditional_multi_leg_initial_deposit' as const,
 question:q,mechanism:m,nativeReceipt:r,
 nativeAcquisition:{basis:acquisition?.kind??'original_to_native_acquisition_pending',
 originalDeposit:q.originalDeposit,nativeDepositRaw:q.nativeDepositRaw,relationship:acquisition,
 sourceQuoteQualified:!!acquisitionApproved,executed:false as const,
 direction:'original_route_asset_to_native_deposit_asset' as const},
 firstLeg:{nativeAsset:m.nativeAsset,nativeDecimals:q.nativeDecimals,depositRaw:q.nativeDepositRaw,
 receiptStatus:r?'source_preview_qualified' as const:'required_native_preview_pending' as const,
 fullNativeEntitlementRaw:r?.fullNativeEntitlementRaw??null,
 admission:r?.maxDepositRaw!=null&&BigInt(q.nativeDepositRaw)>BigInt(r.maxDepositRaw)?'source_receiver_cap_blocks' as const:'unknown' as const,
 earliestSourceAt:s.blockTime,observedPostDeposit:false as const},
 finalAsset:{asset:m.finalAsset,decimals:q.finalDecimals,requestedRaw:q.plannedFinalExitRaw,
 conditionalOutputRaw:c?.outputRaw??null,conditionalHeadroomRaw:output===null?null:String(output-BigInt(q.plannedFinalExitRaw)),
 basis:c?.kind??'conversion_dimensions_pending',conversion:c},
 duration:{sourceObservationAt:s.blockTime,mechanicalEarliestAt:null,recoveryForecast:null,reason:'queue_administration_maturity_and_conversion_availability_require_separate_terms'},
 originalLabelDepositAcquisition:acquisitionApproved?'exact_source_quote_only' as const:acquisition?'declared_funding_scenario_only' as const:'unassessed' as const,depositAdmitted:false as const,depositExecuted:false as const,
 nativeDeployedMethodsQualified:!!r,originalAssetAcquisitionQualified:!!acquisitionApproved,allIntermediateLegsExecutable:false as const,
 holderExecutableExit:false as const,forecastValidated:false as const,calibratedProbability:false as const}
 }catch{return null}
}
