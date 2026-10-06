import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

import { emptyLedger } from './ledger'
import type { VenueKey, VenueLedger } from './types'

/**
 * Local-first storage: one JSON file per venue under data/exit-queue/ (gitignored).
 * Neon is quota-limited, and the ledger is small (finished requests are pruned after
 * the retention window), so a file per venue is enough. Writes go to a temp file
 * and are renamed into place, so a crash never leaves a half-written ledger.
 */

export const DEFAULT_DIR = join(process.cwd(), 'data', 'exit-queue')

export const ledgerFile = (venue: VenueKey, dir = DEFAULT_DIR) =>
  join(dir, `${venue.replace(/[^a-z0-9.-]/gi, '_')}.json`)

export function loadLedger(venue: VenueKey, dir = DEFAULT_DIR): VenueLedger {
  const file = ledgerFile(venue, dir)
  if (!existsSync(file)) return emptyLedger(venue)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as VenueLedger
  if (parsed.schema !== 1 || parsed.venue !== venue)
    throw new Error(`${file}: expected schema 1 for ${venue}, got ${parsed.schema}/${parsed.venue}`)
  return parsed
}

export function saveLedger(ledger: VenueLedger, dir = DEFAULT_DIR): string {
  mkdirSync(dir, { recursive: true })
  const file = ledgerFile(ledger.venue, dir)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(ledger), { mode: 0o600 })
  renameSync(temp, file)
  return file
}
