import type { Verdict } from '@/components/Radar/radarLogic'
import { worstVerdict } from '@/components/Strats/stratsLogic'

// Share surfaces (MOAT_TRACKER steps 4-5): radar permalinks and the per-result,
// per-venue, per-finding OG cards. PURE — imported by an edge route
// (pages/api/og/[kind].tsx), a server page and a client component, so nothing
// here may touch the DB, fs, or viem.

export type OgKind = 'radar' | 'venue' | 'finding'
export const OG_KINDS: readonly OgKind[] = ['radar', 'venue', 'finding']

type Param = string | string[] | null | undefined
const first = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined))

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
/** Venue names come from tools/venue-recorder.config.json (sUSDe, aave-usde…). */
const VENUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
/** Largest dollar figure a card will print. Anything above is treated as a bad read. */
export const USD_CAP = 1e13

export function isAddress(s: string | null | undefined): s is string {
  return typeof s === 'string' && ADDRESS_RE.test(s.trim())
}

/** One canonical form per address, so a permalink has one URL (lower-case hex). */
export function normalizeAddress(v: Param): string | null {
  const s = first(v)?.trim()
  return isAddress(s) ? s.toLowerCase() : null
}

export function parseOgKind(v: Param): OgKind | null {
  const s = first(v)
  return s && (OG_KINDS as readonly string[]).includes(s) ? (s as OgKind) : null
}

export function parseVenueParam(v: Param): string | null {
  const s = first(v)?.trim()
  return s && VENUE_RE.test(s) ? s : null
}

export function radarPermalinkPath(chain: string, address: string): string | null {
  const a = normalizeAddress(address)
  return a ? `/${chain}/radar/${a}` : null
}

export function radarOgImagePath(address: string): string | null {
  const a = normalizeAddress(address)
  return a ? `/api/og/radar?address=${a}` : null
}

export function venueOgImagePath(venue: string): string | null {
  const v = parseVenueParam(venue)
  return v ? `/api/og/venue?venue=${encodeURIComponent(v)}` : null
}

export const FINDING_OG_IMAGE_PATH = '/api/og/finding'

/**
 * Indexing rule (owner default, MOAT_TRACKER): a radar permalink is indexable ONLY
 * when the address is already public on the Strats board (strat_watches). Any other
 * address — and any failed lookup — stays noindex.
 */
export type WatchLookup = 'watched' | 'not-watched' | 'error'
export function radarSeoClass(lookup: WatchLookup): 'indexable' | 'app' {
  return lookup === 'watched' ? 'indexable' : 'app'
}

/** A finite, non-negative dollar figure at or below USD_CAP, else null (never invented). */
export function clampUsd(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > USD_CAP) return null
  return n
}

/** A non-negative integer count at or below `max`, else null. */
export function clampCount(v: unknown, max = 1000): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) return null
  return v
}

/** $1.2B / $340M / $12.4M / $940k / $12 — card-sized. */
export function fmtUsdShort(usd: number): string {
  const v = Math.max(0, usd)
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e7) return `$${Math.round(v / 1e6)}M`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`
  return `$${Math.round(v)}`
}

export function shortAddr(a: string): string {
  return isAddress(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

const VERDICTS: readonly Verdict[] = ['clear', 'caution', 'exposed']
const isVerdict = (v: unknown): v is Verdict =>
  typeof v === 'string' && (VERDICTS as readonly string[]).includes(v)

export type RadarCardSummary = {
  address: string
  totalUsd: number
  heldCount: number
  /** Weakest prong across held positions; null when nothing is held. */
  worst: Verdict | null
}

/** Reads the /api/radar/<address> response. Any malformed field ⇒ null (plain card). */
export function radarCardSummary(json: unknown): RadarCardSummary | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  const address = normalizeAddress(j.address as string)
  const totalUsd = clampUsd(j.total_usd)
  const heldCount = clampCount(j.held_count, 100)
  if (!address || totalUsd == null || heldCount == null || !Array.isArray(j.positions)) return null
  const verdicts = (j.positions as Array<Record<string, unknown>>).map((p) => p?.verdict)
  if (!verdicts.every(isVerdict)) return null
  return {
    address,
    totalUsd,
    heldCount,
    worst: verdicts.length ? worstVerdict(verdicts as Verdict[]) : null,
  }
}

export type VenueCardSummary = {
  label: string
  tvlUsd: number | null
  worst1dUsd: number | null
  worst7dUsd: number | null
  openFlags: number | null
  observedAt: string | null
}

/** Reads the venue summary. Aave's supplied TVL carries its own observation time. */
export function venueCardSummary(json: unknown): VenueCardSummary | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, any>
  const label = typeof j.label === 'string' ? j.label.slice(0, 40) : null
  if (!label) return null
  const obs = j.observed && typeof j.observed === 'object' ? j.observed : null
  const totalAssets = obs?.params?.totalAssets
  const fromAssets = totalAssets != null ? clampUsd(Number(totalAssets) / 1e18) : null
  const isAToken = j.kind === 'atoken-liquidity'
  // Exit liquidity is not supplied TVL for any venue. A missing total-assets
  // reading remains unknown on the share card, just as it does on the page.
  const tvlUsd = isAToken ? clampUsd(j.suppliedTvl?.usd) : fromAssets
  const open = j.alarms?.open
  const tvlSourceTime = isAToken && tvlUsd != null ? j.suppliedTvl?.observedAt : obs?.observedAt
  const observedAt = typeof tvlSourceTime === 'string' ? tvlSourceTime.slice(0, 10) : null
  return {
    label,
    tvlUsd,
    worst1dUsd: clampUsd(j.worstOutflows?.d1?.usd),
    worst7dUsd: clampUsd(j.worstOutflows?.d7?.usd),
    openFlags: Array.isArray(open) ? clampCount(open.length, 1000) : null,
    observedAt,
  }
}
