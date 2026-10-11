/**
 * Writes a scan outcome to the data-branch checkout (`--out <dir>`, i.e. data/carry-scan/):
 *
 *   carry-scan/
 *   ├─ latest.json                    the live file the app reads
 *   ├─ status.json                    lastAttempt, ok, reason, lastGoodWeek
 *   ├─ weeks/2026-W41.json            immutable weekly file; git history is the audit trail
 *   └─ borrow-benchmarks/2026-W41.json
 *
 * FAIL CLOSED: a failed or held run writes ONLY status.json. latest.json and the weekly
 * files are untouched, so the last good scan stays live and the page shows the banner.
 * Every write goes to a temp file first and is renamed into place.
 *
 * Exit codes: 0 published · 1 failed · 2 held for churn review.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { ScanOutcome } from './scan'
import {
  CARRY_SCAN_SCHEMA_VERSION,
  THRESHOLDS,
  type CarryScanFile,
  type CarryScanStatus,
  type PastWeek,
} from './types'

function writeAtomic(path: string, body: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(body, null, 1) + '\n')
  renameSync(tmp, path)
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function readStatus(outDir: string): CarryScanStatus | null {
  return readJson<CarryScanStatus>(join(outDir, 'status.json'))
}

export function readLatest(outDir: string): CarryScanFile | null {
  const f = readJson<CarryScanFile>(join(outDir, 'latest.json'))
  return f && f.schemaVersion === CARRY_SCAN_SCHEMA_VERSION ? f : null
}

/** The last `statusWindowWeeks + 1` weekly files, oldest first, trimmed to what status needs. */
export function readPastWeeks(outDir: string): PastWeek[] {
  const dir = join(outDir, 'weeks')
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
    .filter((n) => /^\d{4}-W\d{2}\.json$/.test(n))
    .sort()
    .slice(-(THRESHOLDS.statusWindowWeeks + 1))
  const out: PastWeek[] = []
  for (const n of names) {
    const f = readJson<CarryScanFile>(join(dir, n))
    if (!f || !Array.isArray(f.rows)) continue
    out.push({
      week: f.week,
      counts: { ranked: f.counts?.ranked, ethStablePools: f.counts?.ethStablePools },
      rows: f.rows.map((r) => ({
        key: r.key,
        list: r.list,
        carryA: r.carryA,
        label: r.label,
        protocol: r.protocol,
        stable: r.stable,
        aliases: r.aliases,
      })),
    })
  }
  return out
}

export function writeOutcome(
  outDir: string,
  outcome: ScanOutcome,
  nowMs: number,
  weekIfFailed: string,
): { code: 0 | 1 | 2; status: CarryScanStatus } {
  mkdirSync(outDir, { recursive: true })
  const prev = readStatus(outDir)
  const lastAttempt = Math.floor(nowMs / 1000)
  if (outcome.kind === 'published') {
    const { file, benchmarks } = outcome
    mkdirSync(join(outDir, 'weeks'), { recursive: true })
    mkdirSync(join(outDir, 'borrow-benchmarks'), { recursive: true })
    writeAtomic(join(outDir, 'weeks', `${file.week}.json`), file)
    writeAtomic(join(outDir, 'borrow-benchmarks', `${file.week}.json`), benchmarks)
    writeAtomic(join(outDir, 'latest.json'), file)
    const status: CarryScanStatus = {
      lastAttempt,
      week: file.week,
      ok: true,
      reason: outcome.note,
      lastGoodWeek: file.week,
    }
    writeAtomic(join(outDir, 'status.json'), status)
    return { code: 0, status }
  }
  const status: CarryScanStatus = {
    lastAttempt,
    week: outcome.kind === 'held' ? outcome.file.week : weekIfFailed,
    ok: false,
    ...(outcome.kind === 'held' ? { held: true } : {}),
    reason: outcome.reason,
    lastGoodWeek: prev?.lastGoodWeek ?? readLatest(outDir)?.week ?? null,
  }
  writeAtomic(join(outDir, 'status.json'), status)
  return { code: outcome.kind === 'held' ? 2 : 1, status }
}
