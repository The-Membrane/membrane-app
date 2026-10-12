import { describe,it,expect } from 'vitest'
import { buildForeignNativePayoutJointScenario,FOREIGN_JOINT_NATIVE_REQUIREMENTS,
  type ForeignNativePayoutJointInput } from '@/lib/carry/foreignNativePayoutJointScenario'
// Synthetic original objects test model mechanics, never real receipt enrollment.
function input(index=3):ForeignNativePayoutJointInput {
  const m=FOREIGN_JOINT_NATIVE_REQUIREMENTS[index],issue='2026-10-12T00:00:00.000Z'
  const source={chainId:1 as const,block:'27000000',blockHash:'0x'+'a'.repeat(64),blockTime:issue,readAt:issue}
  const provenance={datasetSha256:'b'.repeat(64),receiptSha256:'c'.repeat(64),contractAddress:m.destination,
    method:'synthetic_full_owner_native_entitlement_and_cash',reviewRef:'synthetic_test_only'}
  const channel={key:'cash',assetAddress:m.nativeAsset,decimals:m.nativeDecimals,
    unit:'native_intermediate_cash',negativeHandling:'clamp_zero' as const}
  return {question:{...m,owner:'0x'+'d'.repeat(40),requestedFinalRaw:'100',issuedAtUtc:issue,horizonHours:2},
    native:{source,cashRaw:'50',fullEntitlementRaw:'100',fullOwnedSharesRaw:'1000',
      additionalCompetitionNativeRaw:'20',regime:'synthetic_unchanged_joint_regime',provenance,
      history:['100','0','100'].map((cash,i)=>({sourceAtUtc:`2026-10-10T0${i}:00:00.000Z`,availableAtUtc:issue,
        regime:'synthetic_unchanged_joint_regime',channels:[channel],valuesByChannel:{cash},provenanceRef:'synthetic_observation_'+i}))},
    conversion:{kind:'declared_linear_native_to_final_scenario',nativeAsset:m.nativeAsset,nativeDecimals:m.nativeDecimals,
      finalAsset:m.finalAsset,finalDecimals:m.finalDecimals,source,availableAtUtc:issue,provenance,
      mechanismAssumptions:['all_intermediate_queue_gate_fee_and_conversion_terms_assumed_unchanged_not_observed'],
      numeratorFinalRaw:'2',denominatorNativeRaw:'1',feeFinalRaw:'10',declarationRef:'explicit_synthetic_rate_assumption'} }
}
describe('foreign native to final joint conditional mechanics; actual enrollment remains open',()=>{
 it('couples native NET/M/Ea and final conversion/Q once with recovery and shrinking across allfour routes',()=>{
  for(let i=0;i<4;i++){
   const v=input(i),r=buildForeignNativePayoutJointScenario(v,x=>x===v)!
   expect(r).not.toBeNull();expect(r.currentHeadroomRaw).toBe('-50') // min(Ea,50-20)*2-10-100.
   expect(r.process.targetSummary?.minimumHeadroomRaw).toBe('-100')
   expect(r.process.targetSummary?.maximumHeadroomRaw).toBe('90')
   expect(r.process.scenarios.some(s=>s.sampledShortfalls.some(run=>run.recovery!==null))).toBe(true)
   expect(r.shrinking.shrinkingScenarios).toBe(1);expect(r.shrinking.censoredScenarios).toBe(0)
   expect(r.holderExecutableExit).toBe(false);expect(r.forecastValidated).toBe(false)
   expect(r.actualApiEnrollment).toBe('required_original_native_history_and_conversion_receipts_not_enrolled')
  }
 })
 it('never scales an exact sized quote and censors smaller native cash paths',()=>{
  const v=input();v.native.cashRaw='80'
  const common=v.conversion
  v.conversion={nativeAsset:common.nativeAsset,nativeDecimals:common.nativeDecimals,finalAsset:common.finalAsset,
   finalDecimals:common.finalDecimals,source:common.source,availableAtUtc:common.availableAtUtc,
   provenance:common.provenance,mechanismAssumptions:common.mechanismAssumptions,
   kind:'original_exact_size_quote',nativeInputRaw:'60',finalOutputRaw:'110'}
  expect(buildForeignNativePayoutJointScenario(v,x=>x===v)).toBeNull()
  const quote=v.conversion,r=buildForeignNativePayoutJointScenario(v,x=>x===v,c=>c===quote)!
  expect(r.scope).toBe('fixed_exact_sized_action_only_no_partial_quote')
  expect(r.currentHeadroomRaw).toBe('10');expect(r.process.targetSummary).toBeNull()
  const usable=r.process.scenarios.filter(s=>s.targetHeadroomRaw!==null)
  expect(usable.map(s=>s.targetHeadroomRaw)).toEqual(['10'])
  expect(r.shrinking.censoredScenarios).toBe(1)
 })
 it('rejects copied originals, future terms/history availability, changedsource, foreignunits and oversizedquotes',()=>{
  const v=input();expect(buildForeignNativePayoutJointScenario(structuredClone(v),x=>x===v)).toBeNull()
  for(const mutate of [(x:typeof v)=>x.conversion.availableAtUtc='2026-10-13T00:00:00.000Z',
    (x:typeof v)=>x.conversion.source={...x.conversion.source,blockHash:'0x'+'e'.repeat(64)},
    (x:typeof v)=>x.question.nativeDecimals=18,(x:typeof v)=>x.question.finalAsset=x.question.nativeAsset]){
   const bad=input();mutate(bad);expect(buildForeignNativePayoutJointScenario(bad,()=>true)).toBeNull()
  }
  const future=input();future.native.history.forEach(o=>o.availableAtUtc='2026-10-13T00:00:00.000Z')
  expect(buildForeignNativePayoutJointScenario(future,()=>true)).toBeNull()
 })
 it('retains native censorship/overflow rather than promoting a fabricated final capacity',()=>{
  const v=input();if(v.conversion.kind!=='declared_linear_native_to_final_scenario')throw Error('fixture')
  v.conversion.numeratorFinalRaw=String((1n<<256n)-1n)
  const r=buildForeignNativePayoutJointScenario(v,x=>x===v)!
  expect(r.currentHeadroomRaw).toBeNull();expect(r.process.targetSummary).toBeNull()
  expect(r.shrinking.censoredScenarios).toBe(r.process.scenarios.length)
 })
})
