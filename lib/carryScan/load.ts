/**
 * How the app reads the weekly scan on Vercel — no rebuild, no bot pushes to evm-migration.
 *
 * The scan lives on the orphan `data` branch of the public repo. The page fetches
 * latest.json and status.json from raw.githubusercontent.com in getServerSideProps
 * (Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400) and checks
 * `schemaVersion`. Any failure — network, HTTP, JSON, schema — falls back to the committed
 * snapshot public/data/carry-scan-fallback.json, labelled "fallback snapshot, <week>".
 *
 * SCHEMAS. Version 2 (2026-10-11) adds the averaged venue APY and its sources per row. A
 * version-1 file (the data branch until the first version-2 scan, or an old fallback) is
 * still served: `upgradeFile` gives each row a `venueApy` built from what the file holds —
 * DeFiLlama's two figures, which priced the row, and the on-chain 7-day figure listed but
 * not averaged — and a `venueApyRule` that says the snapshot predates averaging.
 *
 * Banner (docs/CARRY_SCOUT.md §5): when status.ok is false ("Last scan failed <date>:
 * <reason>; showing <week>"), when the result is held for churn review, or when the data
 * is more than 8 days old.
 */

import {
  CARRY_SCAN_SCHEMA_VERSION,
  READABLE_SCHEMA_VERSIONS,
  THRESHOLDS,
  type ApySource,
  type CarryScanFile,
  type CarryScanStatus,
  type ScoutRow,
  type VenueApy,
} from './types'
import { etherscanUrl, llamaPoolUrl } from './venueApy'

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

/** A file in any schema the app reads (version 1 or 2). Use `upgradeFile` before rendering. */
export function isReadableCarryScanFile(x: unknown): x is CarryScanFile {
  const f = x as { schemaVersion?: unknown; week?: unknown; rows?: unknown; asOf?: unknown } | null
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.schemaVersion === 'number' &&
    READABLE_SCHEMA_VERSIONS.includes(f.schemaVersion) &&
    typeof f.week === 'string' &&
    Array.isArray(f.rows) &&
    typeof f.asOf === 'number'
  )
}

/** A file in the current schema. */
export function isCarryScanFile(x: unknown): x is CarryScanFile {
  return isReadableCarryScanFile(x) && x.schemaVersion === CARRY_SCAN_SCHEMA_VERSION
}

export const LEGACY_VENUE_APY_RULE =
  'This snapshot predates averaging (schema 1): every venue APY is DeFiLlama’s, and the on-chain 7-day figure is listed but not averaged in.'

/** A version-1 row's venue APY, from the fields it has. Figures unchanged: DeFiLlama's. */
export function legacyVenueApy(
  r: Pick<ScoutRow, 'apy' | 'apyBase' | 'apyReward' | 'aliases' | 'address' | 'verification'>,
  fetchedAt: number,
  anchorTs: number | null,
): VenueApy {
  const uuid = r.aliases.find((a) => a.startsWith('llama:'))?.slice('llama:'.length) ?? null
  const url = uuid ? llamaPoolUrl(uuid) : null
  const base =
    r.apyBase !== null && r.apyBase !== undefined
      ? r.apyBase
      : Math.max(0, r.apy - Math.max(0, r.apyReward ?? 0))
  const sources: ApySource[] = [
    {
      source: 'defillama',
      label: 'DeFiLlama apyBase',
      basis: 'base',
      value: base,
      status: 'ok',
      asOf: fetchedAt,
      url,
      averaged: true,
    },
    {
      source: 'defillama',
      label: 'DeFiLlama apy',
      basis: 'with-rewards',
      value: r.apy,
      status: 'ok',
      asOf: fetchedAt,
      url,
      averaged: true,
    },
  ]
  const t = r.verification?.trailing7dApy
  if (typeof t === 'number' && Number.isFinite(t))
    sources.push({
      source: 'onchain-7d',
      label: 'On-chain 7-day share-price growth',
      basis: 'base',
      value: t,
      status: 'ok',
      asOf: anchorTs,
      url: r.address ? etherscanUrl(r.address) : null,
      averaged: false,
      note: 'not averaged: this snapshot predates averaging',
    })
  return {
    method: 'defillama',
    base,
    withRewards: r.apy,
    spread: { base: null, withRewards: null },
    sources,
  }
}

/** Any readable file → the current schema. A version-2 file is returned as is. */
export function upgradeFile(f: CarryScanFile): CarryScanFile {
  if (f.schemaVersion === CARRY_SCAN_SCHEMA_VERSION) return f
  const anchorTs = f.anchor?.blockTimestamp ? Number(f.anchor.blockTimestamp) : null
  return {
    ...f,
    schemaVersion: CARRY_SCAN_SCHEMA_VERSION,
    counts: { ...f.counts, alsoBehindRoute: f.counts?.alsoBehindRoute ?? 0 },
    venueApyRule: f.venueApyRule ?? LEGACY_VENUE_APY_RULE,
    rows: f.rows.map((r) => ({
      ...r,
      venueApy: r.venueApy ?? legacyVenueApy(r, f.asOf, anchorTs),
      alsoBehindRoutes: r.alsoBehindRoutes ?? [],
    })),
  }
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
  if (isReadableCarryScanFile(latest)) {
    const file = upgradeFile(latest)
    return { file, source: 'live', status: st, ...bannerFor(file, 'live', st, nowMs) }
  }
  const fb = await opts.fallback()
  if (!isReadableCarryScanFile(fb))
    throw new Error('carry-scan fallback snapshot is missing or has the wrong schemaVersion')
  const file = upgradeFile(fb)
  return { file, source: 'fallback', status: st, ...bannerFor(file, 'fallback', st, nowMs) }
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
