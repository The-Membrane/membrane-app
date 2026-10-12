import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import identities from '@/lib/carry/morpho-v2-asset-identities.json'
import {registeredConditionalSampledCashIdentity} from '@/lib/carry/conditionalSampledCashPathProjection'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
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
const NOW=Date.parse('2026-10-12T12:00:00.000Z'),owner='0x0000000000000000000000000000000000000001'
const subjects=identities.entries.map(({vault,asset})=>({identity:['AUSD','EURCV','LINK','PYUSD','RLUSD','USDC','USDT'].map(symbol=>registeredConditionalSampledCashIdentity(`${symbol} → VaultV2 [${symbol}]`,vault)).find(identity=>identity?.asset===asset)!}))
type Subject=ConditionalSampledCashHistory['identity']
async function nativeAssessment(subject:Subject,horizonHours=48,cashFault:'none'|'disagree'|'mutate_source'|'unavailable'='none'){
 const {routeKey,asset,assetDecimals,destination}=subject
 const body={routeKey,destinationAddress:destination,owner,assetsRaw:String(10n**BigInt(assetDecimals)),horizonHours}
 const word=(n:bigint)=>`0x${n.toString(16).padStart(64,'0')}`
 const client={request:async({params}:any)=>{
  const {to,data}=params[0]
  if(data==='0x38d52e0f')return word(BigInt(asset))
  if(data==='0x313ce567')return word(to===asset?BigInt(assetDecimals):18n)
  if(data.startsWith('0x70a08231')){
   if(to===asset){
    if(cashFault==='unavailable')throw Error('synthetic_cash_unavailable')
    if(cashFault==='mutate_source')params[1].blockHash=`0x${'b'.repeat(64)}`
    return word((cashFault==='disagree'?2n:1n)*10n**BigInt(assetDecimals))
   }
   return word(1000000000n)
  }
  if(data.startsWith('0x4cdad506'))return word(9n*10n**BigInt(assetDecimals))
  throw Error('unexpected_synthetic_rpc')
 }}
 const source={chainId:1 as const,blockNumber:26200000,blockHash:`0x${'a'.repeat(64)}` as `0x${string}`,blockTime:new Date(NOW-60000).toISOString(),finalized:true as const}
 const read=await readMorphoV2NativeHolderAtSource(client,{routeKey,destination,owner,source},()=>NOW-3)
 const a:HolderExitAssessment={status:'assessed',routeKey,destinationAddress:destination,owner,
  request:{assetsRaw:body.assetsRaw,assetAddress:asset,horizonHours},source:{...source,originValidation:'single_provider'},
  stages:[{name:'withdrawal',status:'reverted',relatedToRequest:true,assetAddress:asset,amountRaw:body.assetsRaw}],
  finalPayout:{status:'unassessed',assetAddress:asset,amountRaw:null},
  forecast:{status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false},
  morphoHolderPositionObservation:completeMorphoV2NativeHolderObservation(read,NOW-4,NOW-1)!}
 a.capacityQuote=buildHolderExitCapacityQuote(a,{entitlementRaw:read.fullEaRaw,quotedMaxWithdrawRaw:null,quotedMaxWithdrawStatus:'not_read',effectiveLimitRaw:null,
  withdrawalsPaused:null,sourceHolderPosition:{sharesRaw:read.sharesRaw,shareDecimals:18,method:'balance_of_owner_at_source'}},NOW)!
 return {assessment:bindMorphoV2NativeHolderAssessment(a),client,body}
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);vi.mocked(createPublicClient).mockReset();vi.mocked(readHolderExitAssessment).mockReset()})
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();global.gc?.()})
async function issue(subject:Subject,horizonHours=48,fault:'none'|'disagree'|'mutate_source'|'unavailable'='none'){
 const first=await nativeAssessment(subject,horizonHours),second=await nativeAssessment(subject,horizonHours,fault)
 vi.mocked(createPublicClient).mockReturnValueOnce(first.client as never).mockReturnValueOnce(second.client as never)
 vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(first.assessment).mockResolvedValueOnce(second.assessment)
 let result:any,status=0
 const response={setHeader:vi.fn(),status(n:number){status=n;return this},json(v:unknown){result=v;return this}}
 await handler({method:'POST',body:first.body,headers:{},socket:{remoteAddress:'127.0.0.1'}} as never,response as never)
 return {result,status}
}
it('keeps the exact frozen 49-subject Morpho roster',()=>expect(subjects).toHaveLength(49))
// Synthetic RPC responses, authentic sealed histories, real server issuer and actual handler. No live qualification follows.
it.each(subjects.map(h=>h.identity))('issues native cash for $routeKey / $destination independent of rich profiles',async subject=>{
 const {status,result}=await issue(subject)
 expect(status).toBe(200);expect(result.nativeCashHolderOutlook).not.toBeNull()
 expect(result.nativeCashHolderOutlook.owner).toBe(owner)
 const recovery=result.nativeCashHolderOutlook.historicalRecovery
 expect(recovery.question.owner).toBe(owner)
 expect(recovery.question.identity).toEqual(result.nativeCashHolderOutlook.identity)
 expect(recovery.question.currentSource).toEqual(result.nativeCashHolderOutlook.currentSource)
 expect(recovery.question.requestedRaw).toBe(result.nativeCashHolderOutlook.requestedRaw)
 expect(recovery.question.fullEntitlementRaw).toBe(result.nativeCashHolderOutlook.fullEntitlementRaw)
 expect(recovery.question.additionalCompetitionRaw).toBe('0')
 expect(recovery.question.horizonHours).toBe(result.nativeCashHolderOutlook.horizonHours)
 expect(recovery.question.issuedAtUtc).toBe(result.nativeCashHolderOutlook.issuedAtUtc)
 expect(recovery.result?.status).toBe('not_below')
 expect(recovery.forecastValidated).toBe(false)
 expect(result.nativeCashHolderOutlook.identity).toEqual(subject)
 expect(result.nativeCashHolderOutlook.horizonHours).toBe(48)
 expect(result.nativeCashHolderOutlook.fullEntitlementRaw).toBe(String(9n*10n**BigInt(subject.assetDecimals)))
 expect(result.nativeCashHolderOutlook.holderExecutableExit).toBe(false)
 expect(result.nativeCashHolderOutlook.forecastValidated).toBe(false)
 expect(result.morphoHolderPositionObservation).toBeUndefined()
})
it.each([1,168])('retains user-selected %s-hour horizons',async horizon=>{
 const {status,result}=await issue(subjects[0].identity,horizon)
 expect(status).toBe(200);expect(result.nativeCashHolderOutlook.horizonHours).toBe(horizon)
})
it.each(['disagree','mutate_source','unavailable'] as const)('keeps the current holder assessment but refuses optional cash issuance on %s',async fault=>{
 const {status,result}=await issue(subjects[0].identity,48,fault)
 expect(status).toBe(200);expect(result.nativeCashHolderOutlook).toBeNull()
 expect(result.source.originValidation).toBe('two_provider')
 expect(result.forecast.prospectiveValidated).toBe(false)
})
