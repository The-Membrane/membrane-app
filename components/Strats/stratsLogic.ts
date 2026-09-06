// Carry Strats — pure board logic. JSX-free so the unit suite (tests/unit, node
// environment) exercises it directly, mirroring components/Radar/radarLogic.ts.
//
// HONESTY RULES (owner, docs/BRAND_CHARTS.md §4), same discipline as the radar:
//  - Never invent a number. entry/current totals are chain-read snapshots handed
//    in by the caller (entry_positions at watch time, last_scanned now); the
//    delta is arithmetic between them, nothing modelled.
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
  /** current − entry; null when there is no entry baseline. */
  delta_usd: number | null
  delta_dir: DeltaDir | null
  held: StratHeld[]
  /** Weakest held-venue verdict (composite). 'clear' when nothing is held. */
  verdict: Verdict
  /** Label of the venue that set the composite verdict; null when nothing held. */
  weakest_venue: string | null
  /** ISO of the last position refresh; null when never scanned. */
  last_scanned_at: string | null
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
  return verdicts.reduce<Verdict>((worst, v) => (SEVERITY[v] > SEVERITY[worst] ? v : worst), 'clear')
}

/** entry→current delta. null entry ⇒ no baseline, so no delta (never a fake 0). */
export function deltaOf(entry: number | null, current: number): { delta: number | null; dir: DeltaDir | null } {
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
export function totalOfPositions(positions: Array<{ usd?: number }> | null | undefined): number | null {
  if (!Array.isArray(positions)) return null
  return positions.reduce((s, p) => s + (Number(p.usd) || 0), 0)
}
