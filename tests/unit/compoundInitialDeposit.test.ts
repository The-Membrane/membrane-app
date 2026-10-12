import {it,expect} from 'vitest'
import {compoundInitialDepositReceipt,selectedCompoundInitialDepositAgreement} from '@/lib/carry/compoundInitialDeposit'
import {initialDepositQuestion} from '@/components/Carry/initialDepositScenario'
import {DIRECT_SUPPLY_MARKETS} from '@/lib/carry/directSupplyMarketConstants'
import {readInitialDepositNativeFacts} from '@/scripts/research/carry-initial-deposit-native-facts.mjs'
it('uses floor principal then floor entitlement for a new debt-free Comet account',()=>{
 expect(compoundInitialDepositReceipt('1000001','1500000000000000')).toEqual({principalMintRaw:'666667',entitlementRaw:'1000000'})
 expect(compoundInitialDepositReceipt('1','2000000000000000')).toBeNull()
 expect(compoundInitialDepositReceipt(String(1n<<255n),'1')).toBeNull()
 const m=DIRECT_SUPPLY_MARKETS.compoundV3Usdc
 expect(initialDepositQuestion('initial_deposit',m.routeKey,m.destination,'1.000001','1',48)?.depositAssetsRaw).toBe('1000001')
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
 const facts={comet:s.destination,asset:s.asset,assetDecimals:6,baseSupplyIndexRaw:'1500000000000000',supplyPaused:false}
 const a={status:'agreed_compound_initial_deposit_facts' as const,currentSource:s,readAt:at,origins:[{originHostSha256:'a'.repeat(64),facts},{originHostSha256:'b'.repeat(64),facts:{...facts}}]}
 expect(selectedCompoundInitialDepositAgreement(a,s,Date.parse(at))).not.toBeNull()
 a.origins[1].facts.baseSupplyIndexRaw='1500000000000001'
 expect(selectedCompoundInitialDepositAgreement(a,s,Date.parse(at))).toBeNull()
 a.origins[1].facts={...facts};a.origins[1].originHostSha256=a.origins[0].originHostSha256
 expect(selectedCompoundInitialDepositAgreement(a,s,Date.parse(at))).toBeNull()
})
