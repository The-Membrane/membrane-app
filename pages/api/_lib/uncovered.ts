import { readFileSync } from 'fs'
import { join } from 'path'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
// The ONE source of the blind-spot list (a .mjs import compiles here; precedent:
// pages/api/venues/[venue]/summary.ts). No TS copy exists to drift.
import { coverageFor, uncoveredFooter } from '@/scripts/lib/alarmRules.mjs'

export type UncoveredSignal = { id: string; label: string; memo: string }
export type UncoveredByVenue = Record<string, UncoveredSignal[]>

type CoverageConfig = {
  name: string
  enabled: boolean
  termsUrl?: string
  depthCoveredByInstant?: boolean
  depthMarkets?: Array<{ enabled: boolean }>
}

const loadCoverageConfig = (): CoverageConfig[] =>
  (
    JSON.parse(readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8'))
      .venues as CoverageConfig[]
  ).filter((v) => v.enabled)

/**
 * Per-venue blind spots for every enabled venue (or just `only`), from the venue
 * config plus the latest observed snapshot's instant_usd. Same inputs the hourly
 * checker uses, so every surface prints what the checker actually cannot see.
 */
export async function uncoveredByVenue(only?: string[]): Promise<UncoveredByVenue> {
  const want = only ? new Set(only) : null
  const venues = loadCoverageConfig().filter((v) => !want || want.has(v.name))
  if (venues.length === 0) return {}
  const latest = await db.execute(sql`
    SELECT DISTINCT ON (venue) venue, instant_usd
    FROM venue_snapshots WHERE source = 'observed'
    ORDER BY venue, observed_at DESC`)
  const hasInstant = new Map(
    (latest.rows as any[]).map((r) => [r.venue as string, r.instant_usd !== null && r.instant_usd !== undefined]),
  )
  const out: UncoveredByVenue = {}
  for (const v of venues) {
    out[v.name] = coverageFor(v, { hasInstant: hasInstant.get(v.name) ?? false }) as UncoveredSignal[]
  }
  return out
}

/** One footer line for a set of venues. */
export const footerFor = (byVenue: UncoveredByVenue): string => uncoveredFooter(byVenue) as string
