import {it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {ERC4626_INITIAL_DEPOSIT_MARKETS,selectedErc4626InitialDepositAgreement,initialDepositPreviewMechanism} from '@/lib/carry/erc4626InitialDeposit'
import {readInitialDepositNativeFacts} from '@/scripts/research/carry-initial-deposit-native-facts.mjs'
import {buildInitialDepositCapacityProjection} from '@/lib/carry/initialDepositCapacityProjection'
import {buildConditionalSampledCashPathProjection,type ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
import {loadPinnedAudit} from '@/scripts/research/conditional-cash-time-holdout.mjs'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const at='2026-10-12T12:00:00.000Z',now=Date.parse(at),receiver='0x0000000000000000000000000000000000000001'
function setup(m:typeof ERC4626_INITIAL_DEPOSIT_MARKETS[number],withReceiver=false){
 const scale=10n**BigInt(m.decimals),d=String(10n*scale),q=String(scale),minted=123456789000000000000n,ea=9n*scale
 const s={routeKey:m.routeKey,destination:m.destination.toLowerCase(),asset:m.underlying,assetDecimals:m.decimals,chainId:1 as const,cashRaw:String(100n*scale),block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at,sourceKind:'live_read_only_two_origin_finalized' as const}
 let requests=0
 const client={getBlock:async({blockNumber}:any)=>{requests++;return{number:blockNumber,hash:s.blockHash,timestamp:BigInt(now/1000)}},readContract:async({functionName,args,address,blockNumber}:any)=>{
 requests++;expect(blockNumber).toBe(BigInt(s.block))
 if(functionName==='asset')return s.asset
 if(functionName==='decimals')return address===s.asset?m.decimals:18
 if(functionName==='previewDeposit'){expect(args).toEqual([BigInt(d)]);return minted}
 if(functionName==='previewRedeem'){expect(args).toEqual([minted]);return ea}
 if(functionName==='maxDeposit'){expect(args).toEqual([receiver]);return BigInt(d)-1n}
 throw Error('unexpected_native_preview')
 }}
 return{s,d,q,minted,ea,requests:()=>requests,options:{clock:()=>now,depositAssetsRaw:d,receiver:withReceiver?receiver:null,origins:[{url:'https://one.example',client},{url:'https://two.example',client}]}}
}
it('qualifies source receipt proxy plumbing for all60native vault subjects with genuine history, without claiming admission or exit mechanisms',async()=>{
 expect(ERC4626_INITIAL_DEPOSIT_MARKETS).toHaveLength(60)
 expect(ERC4626_INITIAL_DEPOSIT_MARKETS.filter(m=>/VaultV2/.test(m.routeKey))).toHaveLength(49)
 const histories=Object.values(loadPinnedAudit().histories) as ConditionalSampledCashHistory[]
 for(const m of ERC4626_INITIAL_DEPOSIT_MARKETS){
 const t=setup(m),a=await readInitialDepositNativeFacts(t.s,t.options)
 expect(a.status,m.destination).toBe('agreed_erc4626_initial_deposit_facts')
 expect(a.origins[0].facts.mintedSharesRaw).toBe(String(t.minted));expect(a.origins[0].facts.entitlementRaw).toBe(String(t.ea))
 expect(a.origins[0].facts.maxDepositRaw).toBeNull();expect(t.requests()).toBe(14)
 const history=histories.find(h=>h.identity.routeKey===m.routeKey&&h.identity.destination===m.destination)!
 expect(history).toBeDefined()
 const dailyProjection=buildConditionalSampledCashPathProjection({history,currentSource:t.s,request:{requestedRaw:t.q,asOf:at}},hash)
 const projection=buildInitialDepositCapacityProjection({currentSource:t.s,dailyProjection,depositAssetsRaw:t.d,plannedExitAssetsRaw:t.q,horizonHours:48,asOfMs:now,nativeAgreement:a},hash)
 expect(projection.status,m.destination).toBe('conditional_initial_deposit_projection')
 if(projection.status!=='conditional_initial_deposit_projection')throw Error(projection.reason)
 expect(projection.hypotheticalPostDepositCashRaw).toBe(String(BigInt(t.s.cashRaw)+BigInt(t.d)))
 expect(projection.hypotheticalReceipt.status).toBe('conditional_source_erc4626_preview_receipt')
 expect(projection.process?.scenarios[0].points[0].headroomRaw).toBe(String(t.ea-BigInt(t.q)))
 expect(projection.admission.status).toBe('unknown');expect(projection.admission.receiverMaxDepositRaw).toBeNull()
 expect(projection.holderExecutableExit).toBe(false);expect(projection.depositAdmitted).toBe(false)
 expect(projection.receiptMechanism?.nativeMethodSupport).toBe('requires_actual_two_origin_source_reads')
 expect(projection.receiptMechanism?.receiptIsRouteExitCapacity).toBe(false)
 }
})
it('preserves source receipt while refusing to invent an unsupported receiver cap, and abstains on absent mint preview',async()=>{
 const t=setup(ERC4626_INITIAL_DEPOSIT_MARKETS[0],true)
 const base=t.options.origins[0].client.readContract
 for(const o of t.options.origins)o.client={...o.client,readContract:async(args:any)=>{
   if(args.functionName==='maxDeposit')throw Error('unsupported_method')
   return base(args)
 }}
 const a=await readInitialDepositNativeFacts(t.s,t.options)
 expect(a.status).toBe('agreed_erc4626_initial_deposit_facts')
 expect(a.origins[0].facts.maxDepositRaw).toBeNull();expect(a.origins[0].facts.maxDepositStatus).toBe('unavailable')
 expect(selectedErc4626InitialDepositAgreement(a,t.s,t.d,receiver,now)).not.toBeNull()
 expect(selectedErc4626InitialDepositAgreement(a,Object.fromEntries(Object.entries(t.s).reverse()) as typeof t.s,t.d,receiver,now)).not.toBeNull()
 for(const o of t.options.origins)o.client={...o.client,readContract:async(args:any)=>{
   if(args.functionName==='previewDeposit')throw Error('unsupported_method')
   return base(args)
 }}
 expect((await readInitialDepositNativeFacts(t.s,t.options)).status).toBe('unavailable')
})
it('keeps all9mechanism limitations explicit rather than labeling source previews as qualified route exits',()=>{
 const expected:Record<string,string>={
 'apxUSD → ApyUSD [apxUSD]':'apy_deposit_preview_candidate','GHO → sGho [GHO]':'sgho_source_preview_candidate',
 'GHO → UmbrellaStakeToken [GHO]':'umbrella_source_preview_candidate','USDC → USD3 [USDC]':'usd3_strategy_preview_candidate',
 'USDe → Staked USDe [USDe]':'ethena_source_preview','USDC → Fluid USD Coin [USDC]':'fluid_ftoken_preview_candidate',
 'USDT → fToken [USDT]':'fluid_ftoken_preview_candidate','GHO → fToken [GHO]':'fluid_ftoken_preview_candidate',
 'USDC → FluidBridgeAggregatorProxy [USDC]':'fluid_bridge_preview_candidate'}
 for(const [routeKey,kind]of Object.entries(expected)){
 expect(ERC4626_INITIAL_DEPOSIT_MARKETS.some(m=>m.routeKey===routeKey)).toBe(true)
 const mechanism=initialDepositPreviewMechanism(routeKey)
 expect(mechanism.kind).toBe(kind);expect(mechanism.executable).toBe(false);expect(mechanism.limits.length).toBeGreaterThan(0)
 }
})
it('binds explicit receiver cap and D independently and rejects origin disagreements',async()=>{
 const t=setup(ERC4626_INITIAL_DEPOSIT_MARKETS[0],true),a=await readInitialDepositNativeFacts(t.s,t.options)
 expect(a.status).toBe('agreed_erc4626_initial_deposit_facts');expect(t.requests()).toBe(16)
 expect(selectedErc4626InitialDepositAgreement(a,t.s,t.d,receiver,now)).not.toBeNull()
 expect(selectedErc4626InitialDepositAgreement(a,t.s,t.d,null,now)).toBeNull()
 expect(selectedErc4626InitialDepositAgreement(a,t.s,String(BigInt(t.d)+1n),receiver,now)).toBeNull()
 a.origins[1].facts.entitlementRaw='1'
 expect(selectedErc4626InitialDepositAgreement(a,t.s,t.d,receiver,now)).toBeNull()
})
