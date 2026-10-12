/**
 * stressEventCash — per stress EVENT, what a recall at the onset faced over the 8 h delay
 * window, in the venue's own token units: the engine's events (venueStressAnalogs.ts
 * `venueStressEvents`: same windows, same 72 h merge, same 'held' basis with the 1 h retry),
 * read for CASH as well as for f. ENGINE ONLY: numbers, no I/O.
 *
 * Per event:
 *   cash8     lowest held idle cash over [onset, onset + 8 h], at the member window where it is
 *             lowest (the worst member under cash, as cash-vs-book counts an event at its worst
 *             member under m = min(1, cash / B)).
 *   f8        lowest held f over the same 8 h, at the worst member under f (the floor's view).
 *   supply    the venue's supply at that cash member's onset reading.
 *
 * Token units: a stablecoin is its own unit (held at $1 elsewhere); WETH stays in ETH so a
 * caller can price it at the time it needs (exitReadout.ts prices it with the live round).
 *
 * `eventLevel` picks the engine's nearest ranks (venueStressAnalogs `nearestRankIndex`) on one
 * quantity: 'typical' the median event, 'bad' the 10th percentile, 'worst' the lowest.
 */

import {
  VENUE_ANALOG_PERCENTILES,
  nearestRankIndex,
  venueStressEvents,
  type StressWindow,
  type VenueSeries,
} from './venueStressAnalogs'

export interface StressEventCash {
  /** 'Aave USDC, Kelp Apr-2026'. */
  name: string
  /** The cash member's onset, unix s. */
  onsetSec: number
  onsetIso: string
  cash8: number
  f8: number
  supply: number
}

export type StressEventLevel = 'typical' | 'bad' | 'worst'

export const STRESS_EVENT_LEVELS: readonly StressEventLevel[] = ['typical', 'bad', 'worst']

/** The venue's events, onset order, each read for held cash and f over the 8 h window. */
export function stressEventCash(
  s: VenueSeries,
  windows: readonly StressWindow[],
): StressEventCash[] {
  // priceUsd 1: cashUsd is then token units for a non-stable symbol (WETH stays in ETH).
  const { events } = venueStressEvents(s, windows, { basis: 'held', priceUsd: () => 1 })
  const out: StressEventCash[] = []
  for (const e of events) {
    const withCash = e.members.filter((m) => m.minCashUsdHeld.h8 !== null)
    if (withCash.length === 0) continue
    const c = withCash.reduce((a, b) =>
      (b.minCashUsdHeld.h8 as number) < (a.minCashUsdHeld.h8 as number) ? b : a,
    )
    const i = s.t.indexOf(c.onsetReadingSec)
    const supply = i >= 0 ? s.supply[i] : null
    if (supply === null || supply === undefined || !(supply > 0)) continue
    out.push({
      name: e.name,
      onsetSec: c.onsetSec,
      onsetIso: c.onsetIso,
      cash8: c.minCashUsdHeld.h8 as number,
      f8: Math.min(...e.members.map((m) => m.minFHeld.h8)),
      supply,
    })
  }
  return out.sort((a, b) => a.onsetSec - b.onsetSec)
}

/** The event at a level, ranked on one quantity, lowest first. Null for no events. */
export function eventLevel<T>(
  rows: readonly T[],
  level: StressEventLevel,
  value: (r: T) => number,
): T | null {
  if (rows.length === 0) return null
  const sorted = rows.slice().sort((a, b) => value(a) - value(b))
  if (level === 'worst') return sorted[0]
  const p =
    level === 'typical'
      ? VENUE_ANALOG_PERCENTILES['typical-stress']
      : VENUE_ANALOG_PERCENTILES['bad-stress']
  return sorted[nearestRankIndex(p, sorted.length)]
}

// ------------------------------------------------- the exit readout's levels

/** One readout level: the event at that rank of held 8 h cash, token units. */
export interface ExitReadoutCashLevel {
  readonly cash: number
  /** The venue's supply at that event's onset, token units: a deposit larger than it is one
   *  the event is no analog for. */
  readonly supply: number
  /** 'Aave USDC, Kelp Apr-2026'. */
  readonly event: string
  readonly onset: string
}

/** A venue's readout levels, written into exitReadout.ts between its generated markers. */
export interface ExitReadoutCashRow {
  /** history.json venue id. */
  readonly venue: string
  readonly symbol: string
  /** Stress events ranked (the engine's n for the venue). */
  readonly events: number
  readonly cash8: Readonly<Record<StressEventLevel, ExitReadoutCashLevel>>
}

/** Token units as stored: whole units for a stablecoin, 0.001 for WETH. */
function roundUnits(x: number, symbol: string): number {
  return symbol === 'WETH' ? Math.round(x * 1000) / 1000 : Math.round(x)
}

/** Every venue's typical, bad and worst event by held 8 h cash, in `venues` order. */
export function exitReadoutCashRows(
  series: readonly VenueSeries[],
  windows: readonly StressWindow[],
  venues: readonly { venue: string }[],
): ExitReadoutCashRow[] {
  return venues.map(({ venue }) => {
    const s = series.find((x) => x.venue === venue)
    if (!s) throw new Error(`stressEventCash: no series for ${venue}`)
    const events = stressEventCash(s, windows)
    if (events.length === 0) throw new Error(`stressEventCash: no events for ${venue}`)
    const at = (level: StressEventLevel): ExitReadoutCashLevel => {
      const e = eventLevel(events, level, (x) => x.cash8) as StressEventCash
      return {
        cash: roundUnits(e.cash8, s.symbol),
        supply: roundUnits(e.supply, s.symbol),
        event: e.name,
        onset: e.onsetIso,
      }
    }
    return {
      venue,
      symbol: s.symbol,
      events: events.length,
      cash8: { typical: at('typical'), bad: at('bad'), worst: at('worst') },
    }
  })
}
