import {it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {loadPinnedAudit} from '@/scripts/research/conditional-cash-time-holdout.mjs'
import {unconditionedNativeCashPeerAnalogues} from '@/lib/carry/unconditionedNativeCashPeerAnalogues'
import {nativeCashGraphIntervalOutlook,type NativeCashGraphQuestion} from '@/lib/carry/nativeCashPeerIntervals'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
function originals(){
 const histories=Object.values(loadPinnedAudit().histories) as ConditionalSampledCashHistory[]
 const history=histories.find(h=>h.identity.routeKey==='USDC → VaultV2 [USDC]')!
 const question:NativeCashGraphQuestion={owner:`0x${'1'.repeat(40)}`,history,
  currentSource:{...history.identity,chainId:1,cashRaw:'1000',block:'26200000',blockHash:`0x${'a'.repeat(64)}`,
   blockTime:'2026-10-12T12:00:00.000Z',readAt:'2026-10-12T12:00:00.000Z',sourceKind:'live_read_only_two_origin_finalized'},
  fullEntitlementRaw:'1000',requestedRaw:'400',additionalCompetitionRaw:'100',horizonHours:24,issuedAtUtc:'2026-10-12T12:00:00.000Z'}
 return {histories,question}
}
it('connects authentic compatible peers as separate unconditioned scenarios without incident labels or own-NET blending',()=>{
 const {question:q,histories}=originals(),result=nativeCashGraphIntervalOutlook(q,histories,(v,h)=>v===q&&h===histories,hash)!
 const peer=result.peerAnalogScenarios!
 expect(peer.matchedPeerSubjects).toBeGreaterThan(0);expect(peer.usableIntervals).toBeGreaterThan(0)
 expect(peer.incidentConditioned).toBe(false);expect(peer.forecastValidated).toBe(false)
 expect(peer.holderExecutableExit).toBe(false);expect(peer.calibratedProbability).toBe(false)
 expect(peer.scenarios.every(p=>p.peerIdentity.destination!==q.history.identity.destination&&p.peerIdentity.asset===q.history.identity.asset&&p.incidentLabels==='unknown')).toBe(true)
 expect(peer.scenarios.length).toBeLessThanOrEqual(96)
 expect(peer.scenarios[0].sourcePointSha256).toMatch(/^[a-f0-9]{64}$/)
 expect(result.peerGate.selectedPeers).toBe(0)
 expect(nativeCashGraphIntervalOutlook({...q},histories,(v,h)=>v===q&&h===histories,hash)).toBeNull()
})
it('scales relative donor NET to target source cash, clamps E after M, subtracts Q once and never adds own NET',()=>{
 const {question:q,histories}=originals()
 const peer=structuredClone(histories.find(h=>h.identity.destination!==q.history.identity.destination&&h.identity.routeKey===q.history.identity.routeKey)!)
 // Synthetic arithmetic points on a registered identity; not promoted as authenticated history.
 peer.points=[[0,'1',`0x${'a'.repeat(64)}`,'2026-10-01T00:00:00.000Z','200'],[1,'2',`0x${'b'.repeat(64)}`,'2026-10-02T00:00:00.000Z','160']]
 peer.witness.availableAt='2026-10-10T00:00:00.000Z'
 const result=unconditionedNativeCashPeerAnalogues(q,[peer],hash)
 expect(result.scenarios[0].capacityRaw).toBe('800');expect(result.scenarios[0].headroomRaw).toBe('300')
 q.fullEntitlementRaw='200';expect(unconditionedNativeCashPeerAnalogues(q,[peer],hash).scenarios[0].headroomRaw).toBe('-200')
})
it('excludes unsupported class, units, self, zero start, shared known incident and unavailable future observations',()=>{
 const {question:q,histories}=originals(),originalPeer=histories.find(h=>h.identity.destination!==q.history.identity.destination&&h.identity.routeKey===q.history.identity.routeKey)!
 const mismatched={...originalPeer,identity:{...originalPeer.identity,assetDecimals:18}}
 expect(unconditionedNativeCashPeerAnalogues(q,[q.history,mismatched],hash).candidatePeerSubjects).toBe(0)
 const shared=unconditionedNativeCashPeerAnalogues(q,[originalPeer],hash,{targetIncidentIds:['known'],byDestination:{[originalPeer.identity.destination]:['known']}})
 expect(shared.scenarios).toHaveLength(0);expect(shared.excluded[0].reason).toBe('known_shared_incident')
 const future=structuredClone(originalPeer);future.witness.availableAt='2026-10-13T00:00:00.000Z'
 expect(unconditionedNativeCashPeerAnalogues(q,[future],hash).scenarios).toHaveLength(0)
 const zero=structuredClone(originalPeer);zero.points.at(-2)![4]='0'
 expect(unconditionedNativeCashPeerAnalogues(q,[zero],hash).excluded.some(e=>e.reason==='zero_peer_start_cash_relative_rate_undefined')).toBe(true)
 const aave=histories.find(h=>h.identity.routeKey==='USDC → supply on Aave V3')!
 const foreign={...q,history:aave,currentSource:{...q.currentSource,...aave.identity}}
 expect(unconditionedNativeCashPeerAnalogues(foreign,histories,hash).status).toBe('unsupported_target_cash_inventory_class')
})
it('retains selected arithmetic censorship instead of swapping in older donor survivors',()=>{
 const {question:q,histories}=originals(),peer=structuredClone(histories.find(h=>h.identity.destination!==q.history.identity.destination&&h.identity.routeKey===q.history.identity.routeKey)!)
 q.currentSource.cashRaw=String((1n<<256n)-1n)
 peer.points.at(-2)![4]='1';peer.points.at(-1)![4]=String((1n<<256n)-1n)
 const result=unconditionedNativeCashPeerAnalogues(q,[peer],hash)
 expect(result.scenarios).toHaveLength(2);expect(result.censoredIntervals).toBeGreaterThan(0)
 expect(result.scenarios.at(-1)!.censored).toBe(true)
 expect(result.scenarios.at(-1)!.capacityRaw).toBeNull()
 expect(result.omittedHistoricalIntervals).toBeGreaterThan(0)
})

it('future appended anchors cannot displace known donors or change the actual issued graph model',()=>{
 const {question:q,histories}=originals(),peer=histories.find(h=>h.identity.destination!==q.history.identity.destination&&h.identity.routeKey===q.history.identity.routeKey)!
 const originalHistories=[q.history,peer]
 const baseline=nativeCashGraphIntervalOutlook(q,originalHistories,(v,h)=>v===q&&h===originalHistories,hash)!
 assertPositive(baseline.peerAnalogScenarios?.matchedPeerSubjects)
 const extended=structuredClone(peer),last=extended.points.at(-1)!
 // Counterfactual future anchors are not promoted as authenticated captures. The genuine retained
 // prefix and uniform original receipt clock remain identical; even invalid future cash stays unread.
 for(let i=1;i<=4;i++)extended.points.push([last[0]+i,String(BigInt(last[1])+BigInt(i)),`0x${'f'.repeat(64)}`,
  new Date(Date.parse(q.issuedAtUtc)+i*86400000).toISOString(),'not_native_cash'])
 const extendedHistories=[q.history,extended]
 const withFuture=nativeCashGraphIntervalOutlook(q,extendedHistories,(v,h)=>v===q&&h===extendedHistories,hash)!
 expect(withFuture).toEqual(baseline)
 // Keeping only the original eligible prefix is an independent counterfactual, not a rebuilt selector.
 expect(withFuture.peerAnalogScenarios!.scenarios.map(p=>p.targetPointSha256)).toEqual(baseline.peerAnalogScenarios!.scenarios.map(p=>p.targetPointSha256))
})
function assertPositive(value:number|undefined){expect(value).toBeGreaterThan(0)}
it('a donor history unavailable at issue supplies no intervals despite older source times',()=>{
 const {question:q,histories}=originals(),peer=structuredClone(histories.find(h=>h.identity.destination!==q.history.identity.destination&&h.identity.routeKey===q.history.identity.routeKey)!)
 peer.witness.availableAt=new Date(Date.parse(q.issuedAtUtc)+1).toISOString()
 const result=unconditionedNativeCashPeerAnalogues(q,[peer],hash)
 expect(result.scenarios).toHaveLength(0);expect(result.usableIntervals).toBe(0);expect(result.omittedHistoricalIntervals).toBe(0)
})
