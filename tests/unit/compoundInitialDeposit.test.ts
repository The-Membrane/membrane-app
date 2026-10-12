import {it,expect} from 'vitest'
import {compoundInitialDepositReceipt,compoundReceiverInitialDepositReceipt,selectedCompoundInitialDepositAgreement,type CompoundInitialDepositFacts} from '@/lib/carry/compoundInitialDeposit'
import {initialDepositQuestion} from '@/components/Carry/initialDepositScenario'
import {DIRECT_SUPPLY_MARKETS} from '@/lib/carry/directSupplyMarketConstants'
import {readInitialDepositNativeFacts} from '@/scripts/research/carry-initial-deposit-native-facts.mjs'
import {createHash} from 'node:crypto'
import {loadPinnedAudit} from '@/scripts/research/conditional-cash-time-holdout.mjs'
import {buildInitialDepositCapacityProjection} from '@/lib/carry/initialDepositCapacityProjection'
import {buildConditionalSampledCashPathProjection,type ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
it('uses floor principal then floor entitlement for a new debt-free Comet account',()=>{
 expect(compoundInitialDepositReceipt('1000001','1500000000000000')).toEqual({principalMintRaw:'666667',entitlementRaw:'1000000'})
 expect(compoundInitialDepositReceipt('1','2000000000000000')).toBeNull()
 expect(compoundInitialDepositReceipt(String(1n<<255n),'1')).toBeNull()
 const m=DIRECT_SUPPLY_MARKETS.compoundV3Usdc
 expect(initialDepositQuestion('initial_deposit',m.routeKey,m.destination,'1.000001','1',48)?.depositAssetsRaw).toBe('1000001')
})
it('keeps aggregate cash plus deposit while clipping only new receiver credit after debt repayment',()=>{
 const m=DIRECT_SUPPLY_MARKETS.compoundV3Usdc,at='2026-10-12T12:00:00.000Z',receiver='0x0000000000000000000000000000000000000001',hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 const history=(Object.values(loadPinnedAudit().histories) as ConditionalSampledCashHistory[]).find(h=>h.identity.routeKey===m.routeKey)!
 const s={...history.identity,chainId:1 as const,cashRaw:'10000',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at,sourceKind:'live_read_only_two_origin_finalized' as const}
 const facts:CompoundInitialDepositFacts={comet:s.destination,asset:s.asset,assetDecimals:6,baseSupplyIndexRaw:'1000000000000000',supplyPaused:false,receiver,accountStatus:'quoted',receiverPrincipalRaw:'-1000',baseBorrowIndexRaw:'1000000000000000'}
 const nativeAgreement={status:'agreed_compound_initial_deposit_facts',currentSource:s,readAt:at,origins:[{originHostSha256:'a'.repeat(64),facts},{originHostSha256:'b'.repeat(64),facts:{...facts}}]}
 const dailyProjection=buildConditionalSampledCashPathProjection({history,currentSource:s,request:{requestedRaw:'100',asOf:at}},hash)
 const run=(depositAssetsRaw:string)=>buildInitialDepositCapacityProjection({currentSource:s,dailyProjection,depositAssetsRaw,plannedExitAssetsRaw:'100',horizonHours:48,asOfMs:Date.parse(at),nativeAgreement,receiver},hash)
 for(const d of ['900','1000','1100']){const r=run(d);expect(r.status).toBe('conditional_initial_deposit_projection')
 if(r.status!=='conditional_initial_deposit_projection')throw Error(r.reason)
 expect(r.hypotheticalPostDepositCashRaw).toBe(String(10000n+BigInt(d)))
 expect(r.process?.scenarios[0].points[0].headroomRaw).toBe(d==='1100'?'0':'-100')
 expect(r.cashOnlyProcess.scenarios[0].points[0].headroomRaw).toBe(String(9900n+BigInt(d)))
 expect(r.admission.newAccountWithoutDebtAssumed).toBe(false)
 }
 for(const o of nativeAgreement.origins){o.facts={...o.facts,accountStatus:'unavailable',receiverPrincipalRaw:null,baseBorrowIndexRaw:null}}
 const missing=run('900');expect(missing.status).toBe('conditional_initial_deposit_projection')
 if(missing.status!=='conditional_initial_deposit_projection')throw Error(missing.reason)
 expect(missing.process).toBeNull();expect(missing.hypotheticalReceipt).toEqual({status:'unavailable',reason:'receiver_account_or_borrow_index_unavailable'})
 expect(missing.cashOnlyProcess).not.toBeNull();expect(missing.admission.status).toBe('unknown')
})
it('reads both Comet origins at the same source and accrues the reference supply index before hypothetical mint',async()=>{
 const m=DIRECT_SUPPLY_MARKETS.compoundV3Usdc,at='2026-10-12T12:00:00.000Z',now=Date.parse(at)
 const s={routeKey:m.routeKey,destination:m.destination.toLowerCase(),asset:m.underlying,assetDecimals:6 as const,chainId:1 as const,cashRaw:'10',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at,sourceKind:'live_read_only_two_origin_finalized' as const}
 let requests=0
 const client={getBlock:async({blockNumber}:any)=>{requests++;expect(blockNumber).toBe(26200000n);return{number:blockNumber,hash:s.blockHash,timestamp:BigInt(now/1000)}},readContract:async({functionName,blockNumber}:any)=>{
 requests++;expect(blockNumber).toBe(26200000n)
 const responses:Record<string,unknown>={baseToken:s.asset,decimals:6,isSupplyPaused:false,totalsBasic:[10n**15n,10n**15n,0n,0n,1n,0n,BigInt(now/1000)-10n,0],getUtilization:0n,getSupplyRate:10n**12n}
 return responses[functionName]
 }}
 const a=await readInitialDepositNativeFacts(s,{clock:()=>now,origins:[{url:'https://one.example',client},{url:'https://two.example',client}]})
 expect(a.status).toBe('agreed_compound_initial_deposit_facts')
 expect(a.origins[0].facts.baseSupplyIndexRaw).toBe('1000010000000000')
 expect(requests).toBe(16)
})
it('requires two agreed independent native identities and exact current source',()=>{
 const m=DIRECT_SUPPLY_MARKETS.compoundV3Usdc,at='2026-10-12T12:00:00.000Z'
 const s={routeKey:m.routeKey,destination:m.destination.toLowerCase(),asset:m.underlying,assetDecimals:6 as const,chainId:1 as const,cashRaw:'10',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at,sourceKind:'live_read_only_two_origin_finalized' as const}
 const facts={comet:s.destination,asset:s.asset,assetDecimals:6,baseSupplyIndexRaw:'1500000000000000',supplyPaused:false,receiver:null,accountStatus:'anonymous_reference' as const,receiverPrincipalRaw:null,baseBorrowIndexRaw:null}
 const a={status:'agreed_compound_initial_deposit_facts' as const,currentSource:s,readAt:at,origins:[{originHostSha256:'a'.repeat(64),facts},{originHostSha256:'b'.repeat(64),facts:{...facts}}]}
 expect(selectedCompoundInitialDepositAgreement(a,s,Date.parse(at))).not.toBeNull()
 a.origins[1].facts.baseSupplyIndexRaw='1500000000000001'
 expect(selectedCompoundInitialDepositAgreement(a,s,Date.parse(at))).toBeNull()
 a.origins[1].facts={...facts};a.origins[1].originHostSha256=a.origins[0].originHostSha256
 expect(selectedCompoundInitialDepositAgreement(a,s,Date.parse(at))).toBeNull()
})
it('nets receiver debt before incremental withdrawable credit, preserving prior supply separately',()=>{
 const f:CompoundInitialDepositFacts={comet:DIRECT_SUPPLY_MARKETS.compoundV3Usdc.destination.toLowerCase(),asset:DIRECT_SUPPLY_MARKETS.compoundV3Usdc.underlying,assetDecimals:6,baseSupplyIndexRaw:'1000000000000000',supplyPaused:false,receiver:'0x0000000000000000000000000000000000000001',accountStatus:'quoted',receiverPrincipalRaw:'-1000',baseBorrowIndexRaw:'1000000000000000'}
 const under=compoundReceiverInitialDepositReceipt('900',f)!
 expect(under.entitlementRaw).toBe('0');expect(under.principalMintRaw).toBe('0');expect(under.postBorrowDebtRaw).toBe('100')
 const exact=compoundReceiverInitialDepositReceipt('1000',f)!
 expect(exact.entitlementRaw).toBe('0');expect(exact.postPrincipalRaw).toBe('0')
 const above=compoundReceiverInitialDepositReceipt('1100',f)!
 expect(above.entitlementRaw).toBe('100');expect(above.depositAppliedToDebtRaw).toBe('1000')
 f.receiverPrincipalRaw='1000'
 const supply=compoundReceiverInitialDepositReceipt('100',f)!
 expect(supply.priorSupplyEntitlementRaw).toBe('1000');expect(supply.postSupplyEntitlementRaw).toBe('1100');expect(supply.entitlementRaw).toBe('100')
 f.accountStatus='unavailable';f.receiverPrincipalRaw=null;f.baseBorrowIndexRaw=null
 expect(compoundReceiverInitialDepositReceipt('100',f)).toBeNull()
})
it('uses borrow principal ceiling and present-value floor, including debt crossing rounding',()=>{
 const f:CompoundInitialDepositFacts={comet:DIRECT_SUPPLY_MARKETS.compoundV3Usdc.destination.toLowerCase(),asset:DIRECT_SUPPLY_MARKETS.compoundV3Usdc.underlying,assetDecimals:6,baseSupplyIndexRaw:'1500000000000000',supplyPaused:false,receiver:'0x0000000000000000000000000000000000000001',accountStatus:'quoted',receiverPrincipalRaw:'-3',baseBorrowIndexRaw:'1500000000000000'}
 const r=compoundReceiverInitialDepositReceipt('1',f)!
 expect(r.priorBorrowDebtRaw).toBe('4');expect(r.postPrincipalRaw).toBe('-2');expect(r.postBorrowDebtRaw).toBe('3');expect(r.entitlementRaw).toBe('0')
 expect(compoundReceiverInitialDepositReceipt('5',f)!.entitlementRaw).toBe('0')
 expect(compoundReceiverInitialDepositReceipt('7',f)!.entitlementRaw).toBe('3')
})
it('acquires actual receiver principal and accrued borrow index at the same block on both origins',async()=>{
 const m=DIRECT_SUPPLY_MARKETS.compoundV3Usdc,at='2026-10-12T12:00:00.000Z',now=Date.parse(at),receiver='0x0000000000000000000000000000000000000001'
 const s={routeKey:m.routeKey,destination:m.destination.toLowerCase(),asset:m.underlying,assetDecimals:6 as const,chainId:1 as const,cashRaw:'10',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,blockTime:at,readAt:at,sourceKind:'live_read_only_two_origin_finalized' as const}
 let requests=0
 const client={getBlock:async({blockNumber}:any)=>{requests++;return{number:blockNumber,hash:s.blockHash,timestamp:BigInt(now/1000)}},readContract:async({functionName,blockNumber,args}:any)=>{
 requests++;expect(blockNumber).toBe(BigInt(s.block));if(functionName==='userBasic')expect(args).toEqual([receiver])
 const responses:Record<string,unknown>={baseToken:s.asset,decimals:6,isSupplyPaused:false,totalsBasic:[10n**15n,10n**15n,0n,0n,1n,0n,BigInt(now/1000)-10n,0],getUtilization:0n,getSupplyRate:10n**12n,getBorrowRate:2n*10n**12n,userBasic:[-1000n,0n,0n,0,0]}
 return responses[functionName]
 }}
 const a=await readInitialDepositNativeFacts(s,{clock:()=>now,receiver,origins:[{url:'https://one.example',client},{url:'https://two.example',client}]})
 expect(requests).toBe(20);expect(a.status).toBe('agreed_compound_initial_deposit_facts')
 expect(a.origins[0].facts.receiverPrincipalRaw).toBe('-1000');expect(a.origins[0].facts.baseBorrowIndexRaw).toBe('1000020000000000')
 expect(selectedCompoundInitialDepositAgreement(a,s,now,receiver)).not.toBeNull()
 expect(selectedCompoundInitialDepositAgreement(a,s,now,null)).toBeNull()
 expect(selectedCompoundInitialDepositAgreement(a,s,now,'0x0000000000000000000000000000000000000002')).toBeNull()
 a.origins[1].facts.receiverPrincipalRaw='0'
 expect(selectedCompoundInitialDepositAgreement(a,s,now,receiver)).toBeNull()
})
