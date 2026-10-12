// When a consensus median stops being current at the reader's clock. One rule, shared by the
// page's headline and cards (components/OracleRegistry/viewModel consensusStaleAt) and by the
// index's asset tabs (view.ts buildIndex → AssetSummary.consensus.freshWindow), so the tab strip
// and the panel under it can never disagree. Types only: it runs on the server and in the browser.
//
// (review/S5, 2026-10-12: the headline went stale only once fewer than minMembers members were
// inside their limits, so a median over members already past their own limit printed in full
// ink for hours; and ageAt clamped a reader clock behind the read to age 0, so a TWAP member
// counted as fresh.) DESIGN_RULES §4, stale data: "Suppress the headline while inputs are
// stale." Read as: while ANY input that formed the median is past its own limit — the more
// conservative reading of "inputs".

import type { AssetConsensus, Freshness } from './types'

/**
 * Seconds past the read for which a member with no update clock (a TWAP, a view over live
 * state) still vouches for its value: none. Its reading is the chain's state AT the read block,
 * and nothing says how far the market has moved since.
 */
export const LIVE_READ_TOLERANCE_S = 0

/** Reader clocks (unix s, both ends inclusive) at which every member of the median is fresh. */
export type FreshWindow = { from: number; until: number }

export type FreshWindowInput = {
  consensus: Pick<AssetConsensus, 'status' | 'minMembers'>
  cards: readonly { countedInConsensus: boolean; freshness: Freshness }[]
  /** The read the members were judged at (the snapshot's block time). */
  readTs: number | null | undefined
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)

/**
 * The window of reader clocks at which EVERY member that formed the median is still inside its
 * own limit, or null when no clock can vouch for it. "Limit" is the member's own, as the catalog
 * staleness policy sets it (limitSeconds on its Freshness):
 *   clocked — heartbeat + grace, a pull feed's 3,600 s, a Chronicle-style 90,000 s age-only
 *             bound, or a view's binding leg (assessFreshness reports the leg with the least
 *             slack, and adding the same elapsed time to every leg keeps it the binding one):
 *             fresh while ageAtRead + (now − read) ≤ limit, so until = read + limit − ageAtRead;
 *   live    — no update clock (TWAP, view over live state): only at the read itself
 *             (+ LIVE_READ_TOLERANCE_S);
 *   other   — any counted member with an unknown age or limit, or a state other than
 *             fresh / live: null (fail closed — it never keeps the median current).
 * null too when the consensus is not ok, the read time is unknown, or fewer than
 * max(1, minMembers) members were counted. `from` is the read: a reader clock behind it is an
 * unknown age, not a fresh one.
 */
export function consensusFreshWindow(v: FreshWindowInput): FreshWindow | null {
  if (v.consensus.status !== 'ok' || !finite(v.readTs)) return null
  const read = v.readTs
  let until = Infinity
  let counted = 0
  for (const c of v.cards) {
    if (!c.countedInConsensus) continue
    counted++
    const { state, ageSeconds: age, limitSeconds: limit } = c.freshness
    if (state === 'fresh' && finite(age) && finite(limit) && age >= 0 && age <= limit)
      until = Math.min(until, read + limit - age)
    else if (state === 'live' && age == null) until = Math.min(until, read + LIVE_READ_TOLERANCE_S)
    else return null
  }
  if (counted < Math.max(1, v.consensus.minMembers) || !Number.isFinite(until)) return null
  return { from: read, until }
}

/**
 * Stale at `now` unless the clock is known and inside the window. Fail closed: no window, no
 * clock (a render with no clock passed), or a clock behind the read are all stale.
 */
export function staleAt(
  w: FreshWindow | null | undefined,
  now: number | null | undefined,
): boolean {
  if (!w || !finite(now)) return true
  return now < w.from || now > w.until
}
