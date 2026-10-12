import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import {createPublicClient} from 'viem'
import {readHolderExitAssessment} from '@/lib/carry/holderExitAssessment'
import handler from '@/pages/api/carry/holder-exit-assessment'
import {foreignFinalExitFixture} from './fixtures/foreignFinalExitFixture'
vi.mock('viem/chains',()=>({mainnet:{id:1}}))
vi.mock('viem',async original=>({...await original<typeof import('viem')>(),createPublicClient:vi.fn(),http:vi.fn()}))
vi.mock('@/lib/carry/holderExitAssessment',async original=>({...await original<typeof import('@/lib/carry/holderExitAssessment')>(),readHolderExitAssessment:vi.fn()}))
vi.mock('@/lib/game/rateLimit',()=>({checkRateLimit:async()=>({allowed:true}),getClientIp:()=> '127.0.0.1'}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs',()=>({readProviderPolicy:()=>({status:'active'}),configuredProviders:()=>[{url:'https://one.example'},{url:'https://two.example'}]}))
const now=Date.parse('2026-10-12T12:00:00.000Z')
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.mocked(createPublicClient).mockReset();vi.mocked(readHolderExitAssessment).mockReset()})
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();global.gc?.()})
async function issue(twyne:boolean,wrongProbe=false){
 const {a,q}=foreignFinalExitFixture(twyne);a.source.originValidation='single_provider'
 const body={routeKey:q.routeKey,destinationAddress:q.destinationAddress,owner:q.owner,assetsRaw:q.assetsRaw,horizonHours:48,...(twyne?{ptRaw:wrongProbe?'1':a.twyneCondition!.requestedPtRaw,collateralVault:a.twyneCondition!.collateralVault}:{primeSharesRaw:wrongProbe?'1':a.pyusdStakingCondition!.requestedPrimeSharesRaw})}
 vi.mocked(createPublicClient).mockReturnValue({} as never)
 vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(a).mockResolvedValueOnce(structuredClone(a))
 let result:any,status=0;const res={setHeader:vi.fn(),status(n:number){status=n;return this},json(v:unknown){result=v;return this}}
 await handler({method:'POST',body,headers:{},socket:{remoteAddress:'127.0.0.1'}} as never,res as never)
 return{result,status,a,body}
}
it.each([false,true])('actual handler issues bound symbolic final-asset scenarios from agreeing current first-leg facts, Twyne=%s',async twyne=>{
 const {result,status,a,body}=await issue(twyne)
 expect(status).toBe(200)
 const m=result.foreignConditionalFinalExit;expect(m).not.toBeNull()
 expect(m.question.owner).toBe(body.owner);expect(m.question.requestedRaw).toBe(body.assetsRaw)
 expect(m.question.horizonSeconds).toBe(48*3600);expect(m.question.currentSource).toEqual(result.source)
 expect(m.holderExecutableExit).toBe(false);expect(m.forecastValidated).toBe(false)
 expect(m.scenarios[1].requestedHeadroom).toBeNull();expect(m.scenarios[1].unresolvedLegs.length).toBeGreaterThan(0)
 if(twyne)expect(m.firstLeg.simulatedReturnedPtRaw).toBe(a.twyneCondition!.simulatedReturnedPtRaw)
 else {expect(m.firstLeg.inputPrimeRaw).toBe(body.primeSharesRaw);expect(m.existingQueue.pendingUsdcRaw).toBe('700000')}
})
it.each([false,true])('actual handler withholds mechanism if mocked native probe is rebound to another requested amount, Twyne=%s',async twyne=>{
 const {result,status}=await issue(twyne,true)
 expect(status).toBe(200);expect(result.foreignConditionalFinalExit).toBeNull()
})
