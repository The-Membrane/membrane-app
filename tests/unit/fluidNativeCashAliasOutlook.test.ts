import{it,expect,vi}from'vitest'
import{issueFluidNativeCashAliasOutlook}from'@/lib/carry/fluidNativeCashAliasOutlook.server'
import{retainFluidCashAlias,selectedFluidCashAlias}from'@/lib/carry/fluidNativeCashAliasReceipt'
const authority=vi.hoisted(()=>({original:null as any,binding:null as any}))
vi.mock('@/lib/carry/fluidUsdtBridgeNativeCapacity.server',()=>({selectedOriginalFluidUsdtBridgeNativeCapacity:(v:any,b:any)=>v===authority.original&&JSON.stringify(b)===JSON.stringify(authority.binding)?v.fact:null}))
const now=Date.parse('2026-10-12T12:00:00.000Z')
function fixture(){
 const binding={owner:'0x'+'1'.repeat(40),requestedFinalUsdtRaw:'1000000',asOfMs:now,source:{chainId:1 as const,blockNumber:26200000,blockHash:'0x'+'a'.repeat(64),blockTime:new Date(now-60000).toISOString(),finalized:true as const}}
 const original={fact:{routeKey:'USDT → FluidBridgeAggregatorProxy [USDC]',destination:'0x273da948aca9261043fbdb2a857bc255ecc29012',owner:binding.owner,source:binding.source,requestedFinalUsdtRaw:binding.requestedFinalUsdtRaw,sharesRaw:'123456789000000000000',fullNetEaRaw:'9000000',requiredNetUsdcRaw:'1000100',roundtripUsdtRaw:'1000001',withdrawalFeeBps:100,paused:false,nativeProngs:{bridgeFunding:'2000000',bankCash:'3000000',bankSupply:'4000000',bankWithdrawableUntilLimit:'5000000',bankResolverWithdrawable:'6000000'}}}
 authority.original=original;authority.binding=binding
 return{original,binding}
}
it('uses genuine pinned alias candidate but keeps its wallet meaning separate from native funding/prongs',()=>{
 const{original,binding}=fixture(),r=issueFluidNativeCashAliasOutlook(original,binding,48)!
 expect(r.historyCandidate?.pointCount).toBe(120);expect(r.historyCandidate?.witness.manifestSha256).toBe('9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3')
 expect(r.historyCandidate?.meaningAgreementQualified).toBe(false)
 expect(r.current.conditionalNetNativeFundingRaw).toBe('1980000');expect(r.current.conditionalNativeFundingHeadroomRaw).toBe('979900')
 expect(r.conditionalJointProcess).toBeNull();expect(r.fullRouteDeliveryCensored).toBe(true)
 expect(r.missingInputs).toContain('original_two_origin_USDC_balanceOf_bridge_at_exact_current_source')
 original.fact.paused=true;expect(issueFluidNativeCashAliasOutlook(original,binding,48)!.current.conditionalNativeFundingHeadroomRaw).toBe('-1000100')
})
it('requires original selector and binds current shares/net-entitlement/fee without copied native authority',()=>{
 const{original,binding}=fixture()
 expect(issueFluidNativeCashAliasOutlook({...original},binding,48)).toBeNull()
 expect(issueFluidNativeCashAliasOutlook(original,{...binding,requestedFinalUsdtRaw:'1'},48)).toBeNull()
 original.fact.fullNetEaRaw='500000';expect(issueFluidNativeCashAliasOutlook(original,binding,48)!.current.conditionalNetNativeFundingRaw).toBe('500000')
 expect(issueFluidNativeCashAliasOutlook(original,binding,0)).toBeNull()
})
it('retains own transport and rejects current-question substitutions, copies and mutations',()=>{
 const{original,binding}=fixture(),model=issueFluidNativeCashAliasOutlook(original,binding,48)!,q={...model.question,asOfMs:now}
 const issue=retainFluidCashAlias(model,200,q)!
 expect(issue).not.toBeNull();expect(selectedFluidCashAlias({...issue},q)).toBeNull()
 for(const patch of [{owner:'0x'+'2'.repeat(40)},{requestedFinalRaw:'2'},{horizonHours:24},{currentSource:{...q.currentSource,blockNumber:26200001}}])expect(selectedFluidCashAlias(issue,{...q,...patch})).toBeNull()
 selectedFluidCashAlias(issue,q)!.current.conditionalNativeFundingHeadroomRaw='0'
 expect(selectedFluidCashAlias(issue,q)).toBeNull()
})
