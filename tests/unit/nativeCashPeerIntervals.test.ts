import {it,expect} from 'vitest'
import {nativeCashGraphIntervalOutlook,type NativeCashGraphQuestion} from '@/lib/carry/nativeCashPeerIntervals'
const asset=`0x${'1'.repeat(40)}`,destination=`0x${'2'.repeat(40)}`
function question():NativeCashGraphQuestion {
 const identity={routeKey:'USDC → VaultV2 [USDC]',destination,asset,assetDecimals:6}
 return {owner:`0x${'3'.repeat(40)}`,history:{identity,coverage:{} as never,
  witness:{manifestSha256:'a'.repeat(64),lastDailyReceiptSha256:'b'.repeat(64),availableAt:'2026-10-10T00:00:00.000Z'},
  points:[[0,'1',`0x${'a'.repeat(64)}`,'2026-10-01T00:00:00.000Z','100'],
   [1,'2',`0x${'b'.repeat(64)}`,'2026-10-02T00:00:00.000Z','80']]},
 currentSource:{...identity,chainId:1,cashRaw:'100',block:'3',blockHash:`0x${'c'.repeat(64)}`,
  blockTime:'2026-10-12T12:00:00.000Z',readAt:'2026-10-12T12:00:00.000Z',sourceKind:'live_read_only_two_origin_finalized'},
 fullEntitlementRaw:'100',requestedRaw:'40',additionalCompetitionRaw:'10',horizonHours:24,issuedAtUtc:'2026-10-12T12:00:00.000Z'}
}
it('requires original native and original authenticated history qualification before graph construction',()=>{
 const q=question(),histories=[q.history],qualify=(v:NativeCashGraphQuestion,h:typeof histories)=>v===q&&h===histories
 expect(nativeCashGraphIntervalOutlook(q,histories,()=>false)).toBeNull()
 expect(nativeCashGraphIntervalOutlook(structuredClone(q),histories,qualify)).toBeNull()
 expect(nativeCashGraphIntervalOutlook(q,[...histories],qualify)).toBeNull()
 const result=nativeCashGraphIntervalOutlook(q,histories,qualify)!
 expect(result.currentGraphHeadroomRaw).toBe('50')
 expect(result.summary?.minimumHeadroomRaw).toBe('30')
 expect(result.question.currentSource).toEqual(q.currentSource)
 expect(result.question.owner).toBe(q.owner)
 expect(result.forecastValidated).toBe(false);expect(result.holderExecutableExit).toBe(false)
})
it('never invents incident absence or executes same-asset peer transfer',()=>{
 const q=question(),peer={...q.history,identity:{...q.history.identity,destination:`0x${'4'.repeat(40)}`}}
 const wrongUnits={...peer,identity:{...peer.identity,destination:`0x${'5'.repeat(40)}`,assetDecimals:18}}
 const result=nativeCashGraphIntervalOutlook(q,[q.history,peer,wrongUnits],()=>true)!
 expect(result.peerGate.candidateSameRouteAssetUnitsHistories).toBe(1)
 expect(result.peerGate.selectedPeers).toBe(0)
 expect(result.peerGate.reason).toContain('incident_metadata')
 expect(result.intervalScope).toBe('own_authenticated_native_cash_intervals_not_peer_transfer')
})
it('retains own arithmetic censorship, future availability and long-gap exclusions',()=>{
 const q=question();q.history.points[1][4]=String((1n<<256n)-1n)
 const overflow=nativeCashGraphIntervalOutlook(q,[q.history],()=>true)!
 expect(overflow.censoredIntervals).toBe(1);expect(overflow.summary).toBeNull()
 expect(overflow.scenarios[0].censored).toBe(true)
 q.history.witness.availableAt='2026-10-13T00:00:00.000Z'
 const future=nativeCashGraphIntervalOutlook(q,[q.history],()=>true)!
 expect(future.usableIntervals).toBe(0);expect(future.excluded).toHaveLength(1)
 q.history.witness.availableAt='2026-10-10T00:00:00.000Z';q.history.points[1][3]='2026-10-05T00:00:00.000Z'
 const gap=nativeCashGraphIntervalOutlook(q,[q.history],()=>true)!
 expect(gap.scenarios).toHaveLength(0);expect(gap.excluded).toHaveLength(1)
})
it('clips by full native entitlement before subtracting Q and separately deducts additional M',()=>{
 const q=question();q.fullEntitlementRaw='20'
 const result=nativeCashGraphIntervalOutlook(q,[q.history],()=>true)!
 expect(result.currentGraphHeadroomRaw).toBe('-20');expect(result.summary?.maximumHeadroomRaw).toBe('-20')
 q.currentSource.readAt='2026-10-12T12:01:00.000Z'
 expect(nativeCashGraphIntervalOutlook(q,[q.history],()=>true)).toBeNull()
})
