import { resolve } from 'node:path'
import { readBoundedReceiptFile } from '../../scripts/lib/boundedLocalReceiptFile.mjs'
import { FORECAST_ARTIFACT_PINS, installPinnedForecastArtifact } from './pinnedForecastArtifacts'
/** Canonical datasets only. Missing or mismatched bytes never become a replacement fixture. */
export function readAvailablePinnedForecastArtifacts() {
  const root=resolve(process.env.MEMBRANE_DATASETS_DIR || resolve(process.cwd(),'../membrane-datasets'))
  const budget = {maxFileBytes:2*1024*1024,maxTotalBytes:4*1024*1024,totalBytes:0}
  const available: { name:keyof typeof FORECAST_ARTIFACT_PINS; text:string }[]=[]
  for (const name of Object.keys(FORECAST_ARTIFACT_PINS) as (keyof typeof FORECAST_ARTIFACT_PINS)[]) {
    for (const directory of ['forecasting-cloud/data/research/venue-signals','carry-exit-history/research/venue-signals']) {
      try {
        const text=readBoundedReceiptFile(resolve(root,directory,name),budget)
        if (installPinnedForecastArtifact(name,text)) {available.push({name,text});break}
      } catch { /* Missing optional evidence cannot qualify rich history. */ }
    }
  }
  return available
}
