// SERVER ONLY (node:fs). The census row lookup for API routes; never import in the browser.
import fs from 'node:fs'
import path from 'node:path'

import { censusRowFor, type CensusRow } from './census'

let cohort: Parameters<typeof censusRowFor>[0] | null = null

export function censusRowServer(address: string): CensusRow | null {
  if (!cohort) {
    const raw = fs.readFileSync(path.join(process.cwd(), 'public/data/oct10-2025/evidence.json'), 'utf8')
    cohort = (JSON.parse(raw) as { cohort: Parameters<typeof censusRowFor>[0] }).cohort
  }
  return censusRowFor(cohort, address)
}
