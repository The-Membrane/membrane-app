import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import {createPublicClient} from 'viem'
import {readHolderExitAssessment} from '@/lib/carry/holderExitAssessment'
import handler from '@/pages/api/carry/holder-exit-assessment'
import {saturnTicketFixture} from './fixtures/saturnTicketMechanismFixture'
vi.mock('viem/chains',()=>({mainnet:{id:1}}))
vi.mock('viem',async original=>({...await original<typeof import('viem')>(),createPublicClient:vi.fn(),http:vi.fn()}))
vi.mock('@/lib/carry/holderExitAssessment',async original=>({...await original<typeof import('@/lib/carry/holderExitAssessment')>(),readHolderExitAssessment:vi.fn()}))
vi.mock('@/lib/game/rateLimit',()=>({checkRateLimit:async()=>({allowed:true}),getClientIp:()=> '127.0.0.1'}))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs',()=>({readProviderPolicy:()=>({status:'active'}),configuredProviders:()=>[{url:'https://one.example'},{url:'https://two.example'}]}))
const now=Date.parse('2026-10-12T12:00:00.000Z')
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.mocked(createPublicClient).mockReset();vi.mocked(readHolderExitAssessment).mockReset()})
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();global.gc?.()})
async function issue(fault:'none'|'quote_disagreement'|'wrong_requested_ticket'='none') {
 const {assessment:a,request:q}=saturnTicketFixture(),b=structuredClone(a)
 for(const assessment of [a,b])assessment.forecast={status:'unvalidated',futureExit:null,exitDurationHours:null,prospectiveValidated:false}
 if(fault==='quote_disagreement')b.stakedUsdatCondition!.existingTicketConversionQuote!.ausdQuotedRaw='1999991'
 vi.mocked(createPublicClient).mockReturnValue({} as never)
 vi.mocked(readHolderExitAssessment).mockResolvedValueOnce(a).mockResolvedValueOnce(b)
 let status=0,result:any;const response={setHeader:vi.fn(),status(n:number){status=n;return this},json(v:unknown){result=v;return this}}
 await handler({method:'POST',body:{routeKey:q.routeKey,destinationAddress:q.destinationAddress,owner:q.owner,assetsRaw:q.assetsRaw,sharesRaw:'1000000000000000000',horizonHours:48,requestTokenId:fault==='wrong_requested_ticket'?'8':'7'},headers:{},socket:{remoteAddress:'127.0.0.1'}} as never,response as never)
 return{status,result}
}
// Actual handler and original two mocked reader objects, not live provider qualification.
it('issues same-source whole-ticket conditional final-AUSD states without mined history',async()=>{
 const {status,result}=await issue();expect(status).toBe(200);expect(result.saturnTicketMechanism).not.toBeNull()
 expect(result.saturnTicketMechanism.question.ticketId).toBe('7')
 expect(result.saturnTicketMechanism.currentExactSizeAusdQuoteRaw).toBe('1999990')
 expect(result.saturnTicketMechanism.holderExecutableExit).toBe(false)
})
it('requires optional quote agreement and independently requested ticket identity',async()=>{
 for(const fault of ['quote_disagreement','wrong_requested_ticket'] as const){const {status,result}=await issue(fault);expect(status).toBe(200);expect(result.saturnTicketMechanism??null).toBeNull()}
})
