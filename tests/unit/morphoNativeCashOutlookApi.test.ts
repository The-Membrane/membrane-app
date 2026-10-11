import {it,expect,vi} from 'vitest'
import {createPublicClient} from 'viem'
import {readHolderExitAssessment,type HolderExitAssessment} from '@/lib/carry/holderExitAssessment'
import {buildHolderExitCapacityQuote} from '@/lib/carry/holderExitCapacity'
import {readMorphoV2NativeHolderAtSource,completeMorphoV2NativeHolderObservation,bindMorphoV2NativeHolderAssessment} from '@/lib/carry/morphoV2NativeHolderIdentity.server'
import handler from '@/pages/api/carry/holder-exit-assessment'
vi.mock('viem/chains',()=>({mainnet:{id:1}}))
vi.mock('viem',async original=>({...await original<typeof import('viem')>(),createPublicClient:vi.fn(),http:vi.fn()}))
vi.mock('@/lib/carry/holderExitAssessment',async original=>({...await original<typeof import('@/lib/carry/holderExitAssessment')>(),readHolderExitAssessment:vi.fn()}))
vi.mock('@/lib/game/rateLimit',()=>({checkRateLimit:async()=>({allowed:true}),getClientIp:()=> '127.0.0.1'}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs',()=>({readProviderPolicy:()=>({status:'active'}),configuredProviders:()=>[{url:'https://one.example'},{url:'https://two.example'}]}))
const NOW=Date.parse('2026-10-11T12:00:00.000Z'),asset='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',destination='0x069662d2588fcac24b5c209456db965d151556f0',owner='0x0000000000000000000000000000000000000001'
const body={routeKey:'USDC → VaultV2 [USDC]',destinationAddress:destination,owner,assetsRaw:'1000000',horizonHours:48}
async function nativeAssessment(){
 const word=(n:bigint)=>`0x${n.toString(16).padStart(64,'0')}`
 const client={request:async({params}:any)=>{
  const {to,data}=params[0]
  if(data==='0x38d52e0f')return word(BigInt(asset))
  if(data==='0x313ce567')return word(to===asset?6n:18n)
  if(data.startsWith('0x70a08231'))return word(1000000000n)
  if(data.startsWith('0x4cdad506'))return word(9000000000n)
  throw Error('unexpected_synthetic_rpc')
 }}
 const source={chainId:1 as const,blockNumber:26200000,blockHash:`0x${'a'.repeat(64)}` as `0x${string}`,blockTime:new Date(NOW-60000).toISOString(),finalized:true as const}
 const read=await readMorphoV2NativeHolderAtSource(client,{routeKey:body.routeKey,destination,owner,source},()=>NOW-3)
 const a:HolderExitAssessment={status:'assessed',routeKey:body.routeKey,destinationAddress:destination,owner,
  request:{assetsRaw:body.assetsRaw,assetAddress:asset,horizonHours:48},source:{...source,originValidation:'single_provider'},
  stages:[{name:'withdrawal',status:'reverted',relatedToRequest:true,assetAddress:asset,amountRaw:body.assetsRaw}],
  finalPayout:{status:'unassessed',assetAddress:asset,amountRaw:null},
  forecast:{status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false},
  morphoHolderPositionObservation:completeMorphoV2NativeHolderObservation(read,NOW-4,NOW-1)!}
 a.capacityQuote=buildHolderExitCapacityQuote(a,{entitlementRaw:read.fullEaRaw,quotedMaxWithdrawRaw:null,quotedMaxWithdrawStatus:'not_read',effectiveLimitRaw:null,
  withdrawalsPaused:null,sourceHolderPosition:{sharesRaw:read.sharesRaw,shareDecimals:18,method:'balance_of_owner_at_source'}},NOW)!
 return {assessment:bindMorphoV2NativeHolderAssessment(a),client}
}
it('propagates original server native cash issuance through the existing API without a rich profile or live promotion',async()=>{
 vi.useFakeTimers();vi.setSystemTime(NOW)
 try{
  const first=await nativeAssessment(),second=await nativeAssessment()
  vi.mocked(createPublicClient).mockReturnValueOnce(first.client as never).mockReturnValueOnce(second.client as never)
  vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(first.assessment).mockResolvedValueOnce(second.assessment)
  let result:any,status=0
  const response={setHeader:vi.fn(),status(n:number){status=n;return this},json(v:unknown){result=v;return this}}
  await handler({method:'POST',body,headers:{},socket:{remoteAddress:'127.0.0.1'}} as never,response as never)
  expect(status).toBe(200);expect(result.nativeCashHolderOutlook).not.toBeNull()
  expect(result.nativeCashHolderOutlook.owner).toBe(owner)
  expect(result.nativeCashHolderOutlook.horizonHours).toBe(48)
  expect(result.nativeCashHolderOutlook.holderExecutableExit).toBe(false)
  expect(result.nativeCashHolderOutlook.forecastValidated).toBe(false)
  expect(result.morphoHolderPositionObservation).toBeUndefined()
 }finally{vi.useRealTimers()}
})
