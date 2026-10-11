import {it,expect} from 'vitest'
import {statfsSync} from 'node:fs'
import {resolve} from 'node:path'
import {loadPinnedAudit,buildReport,writeReport} from '../../scripts/research/conditional-cash-time-holdout.mjs'
import {FORECAST_ARTIFACT_PINS,installPinnedForecastArtifact,pinnedMorphoPilotHistory} from '@/lib/carry/pinnedForecastArtifacts'
it('replays chronological holdouts for the exact frozen cohort, retains actual knowledge times and exclusion reasons',()=>{
 const audit=loadPinnedAudit(),report=buildReport(audit,new Date().toISOString())
 expect(report.destinations).toHaveLength(64)
 expect(report.destinations.filter((d:any)=>d.lane==='core')).toHaveLength(63)
 expect(report.exclusions).toHaveLength(4)
 expect(report.totals.core.groups).toBe(21)
 expect(report.historicalIssueClockUnestablished).toBe(true)
 expect(report.holderExecutableExit).toBe(false)
 expect(report.availability.donorsNotAvailableAtHistoricalOrigins).toBe(true)
 const out=resolve(process.env.MEMBRANE_DATASETS_DIR!,'forecasting-cloud/linux-recovery/chronological-holdout-'+Date.now()+'.json')
 const disk=statfsSync(resolve(process.env.MEMBRANE_DATASETS_DIR!,'forecasting-cloud/linux-recovery'))
 const receipt=writeReport(report,out,Number(disk.bavail)*Number(disk.bsize))
 console.log(JSON.stringify({reportPath:out,receipt,totals:report.totals,claim:report.claim}))
})
it('refuses missing or mismatched rich-history bytes without blocking native holder identity',()=>{
 const before=pinnedMorphoPilotHistory()
 const name=Object.keys(FORECAST_ARTIFACT_PINS)[0] as keyof typeof FORECAST_ARTIFACT_PINS
 expect(installPinnedForecastArtifact(name,'{"history":"synthetic"}')).toBe(false)
 expect(installPinnedForecastArtifact(name,'not json')).toBe(false)
 // A missing artifact is not substituted with a fixture or granted history authority.
 expect(pinnedMorphoPilotHistory()).toEqual(before)
})
