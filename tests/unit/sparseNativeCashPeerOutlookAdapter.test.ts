import {it,expect} from 'vitest'
import {loadPinnedAudit} from '@/scripts/research/conditional-cash-time-holdout.mjs'
import {issueSparseNativeCashPeerOutlook} from '@/lib/carry/sparseNativeCashPeerOutlook.server'
import type {NativeCashGraphQuestion} from '@/lib/carry/nativeCashPeerIntervals'
import type {ConditionalSampledCashHistory} from '@/lib/carry/conditionalSampledCashPathProjection'
it('reuses authentic original audit histories and rejects cloned question, history and array',()=>{
 const audit=loadPinnedAudit(),histories=Object.values(audit.histories) as ConditionalSampledCashHistory[]
 const history=histories.find(h=>h.identity.routeKey.includes('VaultV2'))!
 const question:NativeCashGraphQuestion={owner:`0x${'1'.repeat(40)}`,history,
  currentSource:{...history.identity,chainId:1,cashRaw:history.points.at(-1)![4],block:'26200000',
   blockHash:`0x${'a'.repeat(64)}`,blockTime:'2026-10-12T12:00:00.000Z',readAt:'2026-10-12T12:00:00.000Z',
   sourceKind:'live_read_only_two_origin_finalized'},fullEntitlementRaw:'1000000',requestedRaw:'100',
  additionalCompetitionRaw:'0',horizonHours:24,issuedAtUtc:'2026-10-12T12:00:00.000Z'}
 const qualifier=(q:NativeCashGraphQuestion,hs:readonly ConditionalSampledCashHistory[])=>
  q===question && hs===histories && audit.histories[Object.keys(audit.histories).find(k=>audit.histories[k]===history)!]===history
 const result=issueSparseNativeCashPeerOutlook(question,qualifier,histories)
 expect(result).not.toBeNull();expect(result!.usableIntervals).toBeGreaterThan(0)
 expect(result!.historyEvidence).toEqual(history.witness)
 expect(issueSparseNativeCashPeerOutlook(structuredClone(question),qualifier,histories)).toBeNull()
 expect(issueSparseNativeCashPeerOutlook(question,qualifier,[...histories])).toBeNull()
 const copied={...question,history:structuredClone(history)}
 expect(issueSparseNativeCashPeerOutlook(copied,(q,hs)=>q===copied&&hs===histories,histories)).toBeNull()
})
