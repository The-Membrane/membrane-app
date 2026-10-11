import { expect, it } from 'vitest'
import { loadPinnedAudit, AUDIT_SHA } from '../../scripts/research/conditional-cash-time-holdout.mjs'
import { normalizeNativeRecoveryHistory, sampledRecoveryOutlook } from '@/lib/venueForecast/sampledRecoveryOutlook'
// Researcher-selected exact subjects and Q, not selected by recovered outcomes.
const SUBJECTS = [
  ['AUSD','0x32401b9fb79065bc15949de0bd43927492f02f0c'],
  ['USDC','0x093272c07700d3ca5301c3bf9b3a392624179e2f'],
  ['sGHO','0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'],
] as const
it('reports three authenticated conditional historical scenarios with genuine receipt availability', () => {
  const audit=loadPinnedAudit(), reports=[]
  for (const [label,destination] of SUBJECTS) {
    const matches=Object.values(audit.histories).filter((h:any)=>h.identity.destination===destination) as any[]
    expect(matches).toHaveLength(1)
    const history=matches[0], snapshots=normalizeNativeRecoveryHistory(history,10000)
    expect(snapshots).not.toBeNull()
    expect(snapshots!.every(s=>s.firstAvailableAt===history.witness.availableAt)).toBe(true)
    const issue=history.witness.availableAt, scenario='2026-10-02T23:59:59.000Z'
    expect(Date.parse(issue)).toBeGreaterThanOrEqual(Date.parse('2026-10-05T10:57:37.472Z'))
    const common={routeKey:history.identity.routeKey,metric:'cash_units' as const,amount:10000,asOf:issue,
      snapshots:snapshots!,maxGapHours:25,maxObservationAgeHours:25}
    const actualIssue=sampledRecoveryOutlook({...common,horizonHours:24})
    const scenarios=[24,48,168].map(horizonHours=>{
      const r=sampledRecoveryOutlook({...common,horizonHours,scenarioAt:scenario})
      return {horizonHours,status:r.status,reason:r.reason,matching:r.matching,counts:r.counts,
        currentAgeHours:r.currentAgeHours,orderStatisticsHours:r.orderStatisticsHours,centralHours:r.centralHours,
        supportGate:r.supportGate,assumptions:r.assumptions,forecastValidated:r.forecastValidated,
        holderExecutable:r.holderExecutable,continuousPathKnown:r.continuousPathKnown}
    })
    reports.push({label,destination,amountNativeUnits:10000,assetDecimals:history.identity.assetDecimals,
      realIssueAt:issue,scenarioAt:scenario,scenarioClock:'source_clock_retrospective',
      historicalAppIssuanceKnown:false,actualIssue:{status:actualIssue.status,reason:actualIssue.reason},scenarios})
  }
  console.log(JSON.stringify({schema:'sampled-recovery-three-history-research-v1',auditSha256:AUDIT_SHA,
    claim:'conditional_research_scenarios_not_backtest_accuracy',reports}))
})
