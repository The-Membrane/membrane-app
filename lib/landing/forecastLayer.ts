/**
 * THE FORECAST LAYER ON THE LANDING (lane Q41). Three uses of the engine
 * (lib/forecast, branch feat/forecast-engine), coded against its interface:
 *
 *   (a) delay   inside the replay's armed 8h window, what the model would have said at
 *               each hourly step about the price reaching the break line (the line × 1.04
 *               point where the sale stops waiting), at every horizon the registry offers;
 *   (b) history the address's own liquidations, the model's reading before each one
 *               against what followed;
 *   (c) reach   forward from today: for each displayable horizon, whether the position's
 *               line sits inside the range the model may speak about.
 *
 * NOTHING HERE DECIDES WHAT MAY BE SHOWN. The engine's registry does, per cell: a
 * probability only where `display === 'probability'` (with the cell's label and caveat),
 * a count where `display === 'count'` (never a percentage), nothing where `'none'`.
 * Horizons are whatever the registry lists; nothing is tied to the 8h delay.
 *
 * Until the engine ships its implementation and a price-series loader, every slot comes
 * back `pending` with the engine's own reason, and the page shows "model pending" and no
 * numbers.
 */

import { defaultRegistry, reach, resolveAsset, touchProbability, whatCanWeSay } from '@/lib/forecast'
import type { HistoryCount, PriceSeries, ReachResult, TouchResult } from '@/lib/forecast'
import type { Comparison, ProtocolPosition } from '@/lib/position-sim'
import { MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'
import type { HistoryEpisode } from '@/lib/position-sim/history'

import type { ArmedWindow } from './verdict'

/**
 * The hourly series the engine reads, per app symbol. The engine owns the loader; this
 * is the one place the landing asks for it. Returns null until a loader exists, which
 * the engine answers with display 'none' and a reason.
 */
export type SeriesLoader = (symbol: string) => Promise<PriceSeries | null>
export const noSeries: SeriesLoader = async () => null

/** The engine series an app symbol reads, or null (the engine then says why it shows nothing). */
export function seriesIdFor(symbol: string): string | null {
  return resolveAsset(defaultRegistry(), symbol)?.series ?? null
}

/** What the UI may print for one engine result. Pure: the engine's gate, rendered. */
export type Shown =
  | { kind: 'probability'; text: string; label: string; caveat: string | null; horizonH: number; levelPct: number }
  | { kind: 'count'; text: string; label: string; horizonH: number }
  | { kind: 'none'; reason: string | null }

export const fmtHorizon = (h: number): string => (h % 24 === 0 ? `${h / 24}d` : `${h}h`)

export function countText(c: HistoryCount): string {
  return `fell ${Math.abs(c.levelPct)}% within ${fmtHorizon(c.horizonH)} ${c.k} time${c.k === 1 ? '' : 's'} since ${c.since}`
}

export function shown(r: TouchResult | null | undefined): Shown {
  if (!r) return { kind: 'none', reason: null }
  const h = r.cell?.horizonH ?? 0
  if (r.display === 'probability' && r.p !== null && Number.isFinite(r.p)) {
    const pct = r.p * 100
    // Never print 0% or 100%: the model says "under 1%" / "over 99%", not certainty.
    const text = pct < 1 ? 'under 1%' : pct > 99 ? 'over 99%' : `${Math.round(pct)}%`
    return { kind: 'probability', text, label: r.label, caveat: r.cell?.caveat ?? null, horizonH: h, levelPct: r.cell?.levelPct ?? 0 }
  }
  if (r.display === 'count' && r.count) {
    return { kind: 'count', text: countText(r.count), label: r.label, horizonH: h }
  }
  return { kind: 'none', reason: r.reason }
}

export type Slot<T> = { status: 'pending'; reason: string } | { status: 'ready'; value: T }

/** Distance from spot to a line, as the engine wants it: negative percent of spot. */
export function lineDistancePct(position: ProtocolPosition): number {
  return fallToPct(position.ltv, position.liquidationLtv)
}

/** The collateral leg that carries the position, for the engine's asset argument. */
export function anchorAsset(position: ProtocolPosition): string | null {
  // The largest leg the engine has a series for; else the largest leg, so the engine
  // can say in its own words why it shows nothing.
  const legs = [...position.collateral].sort((a, b) => b.valueUsd - a.valueUsd)
  return (legs.find((l) => seriesIdFor(l.symbol) !== null) ?? legs[0])?.symbol ?? null
}

// ------------------------------------------------------------- (a) delay

export interface DelayStep {
  minute: number
  ts: number
  /** Distance from that minute's spot to the break line, negative percent. */
  toBreakPct: number
  /** The engine's reach at that origin: one row per horizon the registry offers. */
  reach: ReachResult
}

/** Fall that takes an LTV to `line`, collateral moving as one: (ltv / line − 1) × 100. */
export const fallToPct = (ltv: number, line: number): number => (line > 0 ? (ltv / line - 1) * 100 : 0)

/**
 * One reading per hour inside each armed window: the engine's reach to the break line
 * (line × (1 + band), the point where the sale stops waiting) from that minute's spot.
 */
export function delayReadings(
  cmp: Comparison,
  windows: ArmedWindow[],
  pathStartTs: number,
  stepSeconds: number,
  series: PriceSeries | null,
): Slot<DelayStep[]> {
  const asset = anchorAsset(cmp.position)
  const breach = cmp.membrane.events.find((e) => e.kind === 'breach')
  if (!asset || !breach || windows.length === 0) return { status: 'pending', reason: 'no armed window on this replay' }
  const breakLine = breach.line * (1 + MAX_THRESHOLD_TO_DELAY)
  const perHour = Math.max(1, Math.round(3600 / stepSeconds))
  const steps: DelayStep[] = []
  for (const w of windows) {
    for (let m = w.start; m < w.end; m += perHour) {
      const ltv = cmp.membrane.ltvSeries[m]
      if (ltv === null || ltv === undefined) continue
      const toBreakPct = fallToPct(ltv, breakLine)
      const ts = pathStartTs + m * stepSeconds
      steps.push({ minute: m, ts, toBreakPct, reach: reach(asset, ts, toBreakPct, series, { purpose: 'line' }) })
    }
  }
  const anyShown = steps.some((s) => s.reach.rows.some((r) => shown(r.result).kind !== 'none' || !!r.count))
  if (!anyShown) return { status: 'pending', reason: steps[0]?.reach.reason ?? 'no displayable cell for this asset inside the window' }
  return { status: 'ready', value: steps }
}

/** The shortest-horizon displayable row of a reach, for a chart tick. */
export function firstShown(r: ReachResult): { horizonH: number; shown: Shown; upperBound: boolean } | null {
  for (const row of r.rows) {
    const sh = shown(row.result)
    if (sh.kind !== 'none') return { horizonH: row.horizonH, shown: sh, upperBound: row.isUpperBound }
    if (row.count) return { horizonH: row.horizonH, shown: { kind: 'count', text: countText(row.count), label: '', horizonH: row.horizonH }, upperBound: false }
  }
  return null
}

// ----------------------------------------------------------- (b) history

export interface HistoryReading {
  episodeStartTs: number
  collateral: string
  results: Shown[]
}

export function historyReadings(episodes: HistoryEpisode[], series: (symbol: string) => PriceSeries | null): Slot<HistoryReading[]> {
  if (episodes.length === 0) return { status: 'pending', reason: 'no liquidations on record for this address' }
  let reason: string | null = null
  const out: HistoryReading[] = episodes.slice(0, 6).map((ep) => {
    const s = series(ep.collateral)
    const said = whatCanWeSay(ep.collateral, ep.startTs, s, { purpose: 'price' })
    if (said.length === 0) reason = reason ?? touchProbability(ep.collateral, ep.startTs, 1, -1, s).reason
    return { episodeStartTs: ep.startTs, collateral: ep.collateral, results: said.map(shown) }
  })
  if (!out.some((h) => h.results.some((r) => r.kind !== 'none'))) return { status: 'pending', reason: reason ?? 'no displayable cell' }
  return { status: 'ready', value: out }
}

// ------------------------------------------------------------- (c) reach

export function forwardReach(position: ProtocolPosition, nowTs: number, series: PriceSeries | null): Slot<ReachResult> {
  const asset = anchorAsset(position)
  if (!asset) return { status: 'pending', reason: 'no collateral to forecast' }
  const r = reach(asset, nowTs, lineDistancePct(position), series, { purpose: 'line' })
  if (r.throughLine) return { status: 'ready', value: r }
  if (r.rows.length === 0 || r.rows.every((row) => shown(row.result).kind === 'none' && !row.count && row.status !== 'beyond')) {
    return { status: 'pending', reason: r.reason ?? 'no displayable horizon for this asset' }
  }
  return { status: 'ready', value: r }
}
