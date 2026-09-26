// Carry Strats — pure board logic. JSX-free so the unit suite (tests/unit, node
// environment) exercises it directly, mirroring components/Radar/radarLogic.ts.
//
// HONESTY RULES (owner, docs/BRAND_CHARTS.md §4), same discipline as the radar:
//  - Never invent a number. entry/current totals are chain-read snapshots handed
//    in by the caller (entry_positions at watch time, last_scanned now); the
//    delta is arithmetic between them, nothing modelled. It is not P&L because
//    deposits and withdrawals change it too.
//  - A strat's composite verdict is the WEAKEST of its held venues' verdicts,
//    never an average — the same rule computeRadar uses per venue.
//  - Missing data is OMITTED, not defaulted: an unwatched-baseline / never-scanned
//    strat has a null entry/delta, never a fabricated 0.

import type { Verdict } from '@/components/Radar/radarLogic'

export type StratHeld = {
  venue: string
  label: string
  usd: number
  verdict: Verdict
}

export type StratRow = {
  address: string
  short_address: string
  label: string | null
  watched_since: string
  /** Total USD at watch time (entry baseline); null when no baseline snapshot. */
  entry_total_usd: number | null
  /** Total USD at last refresh (cached chain read). */
  current_total_usd: number
  /** Raw current − entry size change, NOT profit; includes deposits/withdrawals. */
  delta_usd: number | null
  delta_dir: DeltaDir | null
  held: StratHeld[]
  /** Weakest held-venue verdict (composite). 'clear' when nothing is held. */
  verdict: Verdict
  /** Label of the venue that set the composite verdict; null when nothing held. */
  weakest_venue: string | null
  /** ISO of the last position refresh; null when never scanned. */
  last_scanned_at: string | null
  /** Tracked venue holdings only. Null until a complete, priced watch epoch exists. */
  return_metrics?: TrackedReturn | null
}

export type TrackedReturn = {
  pnl_usd: number | null
  return_pct: number | null
  start_at: string | null
  end_at: string | null
  flow_count: number
  unpriced_count: number
  status: 'complete' | 'collecting' | 'incomplete'
  note: string
}

export type VenueReturnSnapshot = {
  venue: string
  start_at: string
  observed_at: string
  block: number
  last_complete_block: number
  pnl_usd: number | null
  capital_base_usd: number | null
  flow_count: number
  unpriced_count: number
  status: string
  last_error?: string | null
}

/** A single board return requires all configured venues over the SAME window. */
export function aggregateTrackedReturn(
  rows: VenueReturnSnapshot[],
  requiredVenues: string[],
  nowMs = Date.now(),
): TrackedReturn {
  const note =
    'Tracked-venue, $1/stable-proxy, cash-flow-adjusted return; excludes borrowing cost and positions outside these venues.'
  if (!requiredVenues.length || rows.length < requiredVenues.length)
    return {
      pnl_usd: null,
      return_pct: null,
      start_at: null,
      end_at: null,
      flow_count: 0,
      unpriced_count: 0,
      status: 'collecting',
      note,
    }
  const byVenue = new Map(rows.map((row) => [row.venue, row]))
  const selected = requiredVenues.map((venue) => byVenue.get(venue))
  if (selected.some((row) => !row))
    return {
      pnl_usd: null,
      return_pct: null,
      start_at: null,
      end_at: null,
      flow_count: 0,
      unpriced_count: 0,
      status: 'collecting',
      note,
    }
  const valid = selected as VenueReturnSnapshot[]
  const first = valid[0]
  const sameWindow = valid.every(
    (row) =>
      row.start_at === first.start_at &&
      row.observed_at === first.observed_at &&
      row.block === first.block &&
      row.last_complete_block === row.block,
  )
  const ageMs = nowMs - new Date(first.observed_at).getTime()
  const fresh = Number.isFinite(ageMs) && ageMs >= -5 * 60_000 && ageMs <= 2 * 60 * 60_000
  const priced = valid.every(
    (row) =>
      !row.last_error &&
      ((row.status === 'complete' &&
        row.pnl_usd != null &&
        row.capital_base_usd != null &&
        row.capital_base_usd > 0) ||
        (row.status === 'empty' && row.pnl_usd === 0 && row.capital_base_usd === 0)),
  )
  const flowCount = valid.reduce((sum, row) => sum + row.flow_count, 0)
  const unpricedCount = valid.reduce((sum, row) => sum + row.unpriced_count, 0)
  if (!sameWindow || !priced || !fresh)
    return {
      pnl_usd: null,
      return_pct: null,
      start_at: first.start_at,
      end_at: first.observed_at,
      flow_count: flowCount,
      unpriced_count: unpricedCount,
      status: 'incomplete',
      note,
    }
  const pnl = valid.reduce((sum, row) => sum + row.pnl_usd!, 0)
  const base = valid.reduce((sum, row) => sum + row.capital_base_usd!, 0)
  return {
    pnl_usd: pnl,
    return_pct: base > 0 ? (pnl / base) * 100 : null,
    start_at: first.start_at,
    end_at: first.observed_at,
    flow_count: flowCount,
    unpriced_count: 0,
    status: 'complete',
    note,
  }
}

export type DeltaDir = 'up' | 'down' | 'flat'

// Verdict severity — must match components/Radar/radarLogic.ts. Kept local rather
// than exported from there so the frozen radar honesty module is not edited.
const SEVERITY: Record<Verdict, number> = { clear: 0, caution: 1, exposed: 2 }

/** Anonymized short form: 0x1234…abcd. The full address ships alongside (public chain data). */
export function shortAddress(addr: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** The weakest (most severe) verdict across a strat's held venues. Empty → 'clear'. */
export function worstVerdict(verdicts: Verdict[]): Verdict {
  return verdicts.reduce<Verdict>(
    (worst, v) => (SEVERITY[v] > SEVERITY[worst] ? v : worst),
    'clear',
  )
}

/** entry→current delta. null entry ⇒ no baseline, so no delta (never a fake 0). */
export function deltaOf(
  entry: number | null,
  current: number,
): { delta: number | null; dir: DeltaDir | null } {
  if (entry == null) return { delta: null, dir: null }
  const delta = current - entry
  const dir: DeltaDir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  return { delta, dir }
}

/** Board order: largest current position first. Stable (does not mutate input). */
export function sortByCurrentDesc<T extends { current_total_usd: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.current_total_usd - a.current_total_usd)
}

/** Sum a positions array's .usd (the entry-baseline total). null/empty ⇒ null. */
export function totalOfPositions(
  positions: Array<{ usd?: number }> | null | undefined,
): number | null {
  if (!Array.isArray(positions)) return null
  return positions.reduce((s, p) => s + (Number(p.usd) || 0), 0)
}

/** Current allocation across the tracked books, not transfers between venues. */
export function venueFlows(
  rows: StratRow[],
): Array<{ venue: string; label: string; usd: number; books: number }> {
  const byVenue = new Map<string, { venue: string; label: string; usd: number; books: number }>()
  for (const row of rows) {
    for (const held of row.held) {
      if (!Number.isFinite(held.usd) || held.usd <= 0) continue
      const current = byVenue.get(held.venue) ?? {
        venue: held.venue,
        label: held.label,
        usd: 0,
        books: 0,
      }
      current.usd += held.usd
      current.books += 1
      byVenue.set(held.venue, current)
    }
  }
  return [...byVenue.values()].sort((a, b) => b.usd - a.usd || a.venue.localeCompare(b.venue))
}

export function filterStrats(
  rows: StratRow[],
  query: string,
  venue: string,
  verdict: string,
): StratRow[] {
  const needle = query.trim().toLowerCase()
  return rows.filter(
    (row) =>
      (!needle ||
        row.address.toLowerCase().includes(needle) ||
        row.label?.toLowerCase().includes(needle)) &&
      (!venue || row.held.some((held) => held.venue === venue)) &&
      (!verdict || row.verdict === verdict),
  )
}
