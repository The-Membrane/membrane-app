/**
 * How the app reads the weekly scan on Vercel — no rebuild, no bot pushes to evm-migration.
 *
 * The scan lives on the orphan `data` branch of the public repo. The page fetches
 * latest.json and status.json from raw.githubusercontent.com in getServerSideProps
 * (Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400) and checks
 * `schemaVersion`. Any failure — network, HTTP, JSON, schema — falls back to the committed
 * snapshot public/data/carry-scan-fallback.json, labelled "fallback snapshot, <week>".
 *
 * Banner (docs/CARRY_SCOUT.md §5): when status.ok is false ("Last scan failed <date>:
 * <reason>; showing <week>"), when the result is held for churn review, or when the data
 * is more than 8 days old.
 */

import {
  CARRY_SCAN_SCHEMA_VERSION,
  THRESHOLDS,
  type CarryScanFile,
  type CarryScanStatus,
} from './types'

export const CARRY_SCAN_RAW_BASE =
  'https://raw.githubusercontent.com/The-Membrane/membrane-app/data/carry-scan'
export const CARRY_SCAN_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400'

export interface CarryScanView {
  file: CarryScanFile
  source: 'live' | 'fallback'
  status: CarryScanStatus | null
  stale: boolean
  banner: string | null
}

export function isCarryScanFile(x: unknown): x is CarryScanFile {
  const f = x as CarryScanFile | null
  return (
    !!f &&
    typeof f === 'object' &&
    f.schemaVersion === CARRY_SCAN_SCHEMA_VERSION &&
    typeof f.week === 'string' &&
    Array.isArray(f.rows) &&
    typeof f.asOf === 'number'
  )
}

const day = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10)

export function bannerFor(
  file: CarryScanFile,
  source: 'live' | 'fallback',
  status: CarryScanStatus | null,
  nowMs: number,
): { stale: boolean; banner: string | null } {
  const ageDays = (nowMs / 1000 - file.asOf) / 86_400
  const stale = ageDays > THRESHOLDS.staleDays
  const parts: string[] = []
  if (status && !status.ok) {
    parts.push(
      status.held
        ? `Last scan held for review ${day(status.lastAttempt)}: ${status.reason ?? 'churn check'}; showing ${file.week}`
        : `Last scan failed ${day(status.lastAttempt)}: ${status.reason ?? 'unknown reason'}; showing ${file.week}`,
    )
  }
  if (stale) parts.push(`This data is ${Math.floor(ageDays)} days old (scan ${file.week})`)
  if (source === 'fallback') parts.push(`fallback snapshot, ${file.week}`)
  return { stale, banner: parts.length ? parts.join(' · ') : null }
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

export async function loadCarryScan(opts: {
  fallback: () => Promise<unknown> | unknown
  fetchImpl?: typeof fetch
  nowMs?: number
  timeoutMs?: number
  base?: string
}): Promise<CarryScanView> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = opts.base ?? CARRY_SCAN_RAW_BASE
  const nowMs = opts.nowMs ?? Date.now()
  const timeoutMs = opts.timeoutMs ?? 4000
  const [latest, status] = await Promise.all([
    getJson(fetchImpl, `${base}/latest.json`, timeoutMs).catch(() => null),
    getJson(fetchImpl, `${base}/status.json`, timeoutMs).catch(() => null),
  ])
  const st =
    status && typeof status === 'object' && typeof (status as CarryScanStatus).ok === 'boolean'
      ? (status as CarryScanStatus)
      : null
  if (isCarryScanFile(latest)) {
    return { file: latest, source: 'live', status: st, ...bannerFor(latest, 'live', st, nowMs) }
  }
  const fb = await opts.fallback()
  if (!isCarryScanFile(fb))
    throw new Error('carry-scan fallback snapshot is missing or has the wrong schemaVersion')
  return { file: fb, source: 'fallback', status: st, ...bannerFor(fb, 'fallback', st, nowMs) }
}

/** The committed snapshot, bundled with the server code. */
export const loadFallbackSnapshot = async (): Promise<unknown> =>
  (await import('../../public/data/carry-scan-fallback.json')).default

/**
 * The page props: the view without the per-stable benchmark candidate lists, which the page
 * does not render (they stay in the weekly file and borrow-benchmarks/). Keeps __NEXT_DATA__ small.
 */
export function leanView(view: CarryScanView): CarryScanView {
  const benchmarks: CarryScanFile['benchmarks'] = {}
  for (const [s, t] of Object.entries(view.file.benchmarks ?? {})) {
    benchmarks[s] = { bySize: t.bySize, candidates: [] }
  }
  return { ...view, file: { ...view.file, benchmarks } }
}
