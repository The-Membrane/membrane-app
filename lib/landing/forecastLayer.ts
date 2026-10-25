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

import { defaultRegistry, HOUR, originOf, reach, resolveAsset, touchProbability, whatCanWeSay } from '@/lib/forecast'
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
  | { kind: 'probability'; text: string; label: string; caveat: string | null; horizonH: number; levelPct: number; cls: string | null; trigger: boolean }
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
    return { kind: 'probability', text, label: r.label, caveat: r.cell?.caveat ?? null, horizonH: h, levelPct: r.cell?.levelPct ?? 0, cls: r.cell?.class ?? null, trigger: r.cell?.trigger === true }
  }
  if (r.display === 'count' && r.count) {
    return { kind: 'count', text: countText(r.count), label: r.label, horizonH: h }
  }
  return { kind: 'none', reason: r.reason }
}

/**
 * The shortest on-page form of a class label (copy budget). The engine's full label goes
 * in the element's tooltip; nothing is decided here, the class comes from the result.
 */
export const SHORT_CLASS: Record<string, string> = {
  SKILL: 'tested',
  CALIBRATED_WARN: 'calibrated · not proven better',
  CALIBRATED: 'context only',
  HISTORY_COUNT: 'count',
}
export const shortClass = (cls: string | null, full: string): string => (cls && SHORT_CLASS[cls]) || full

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
  /** The engine's spot at its floored origin (Binance hourly close), or null. */
  spot: number | null
  /** The price at which this position reaches the break line (oracle units). */
  breakPrice: number | null
  /** breakPrice / spot − 1, in percent: the fall the ENGINE's spot needs. */
  toBreakPct: number | null
  /** Price was already at or past the break point at the reading: no probability. */
  alreadyPast: boolean
  /** The engine's reach at that origin, or null when already past / no spot. */
  reach: ReachResult | null
}

/** Fall that takes an LTV to `line`, collateral moving as one: (ltv / line − 1) × 100. */
export const fallToPct = (ltv: number, line: number): number => (line > 0 ? (ltv / line - 1) * 100 : 0)

/**
 * The engine's spot at an origin: the close of the hour ending at the floored origin,
 * exactly as lib/forecast/engine.ts spotAt reads it (it is not exported). Null when the
 * asset has no engine series or the series does not reach that hour.
 */
export function engineSpot(asset: string, ts: number, series: PriceSeries | null): number | null {
  if (!series || seriesIdFor(asset) === null) return null
  const j = (originOf(ts) - series.startTs) / HOUR - 1
  const v = j >= 0 && j < series.close.length ? series.close[j] : null
  return v !== null && v !== undefined && Number.isFinite(v) ? v : null
}

/**
 * One reading per hour inside each armed window (refuting review D2). The break point is
 * where LTV reaches line × (1 + band): with one asset moving, price × ltv / breakLine.
 * The distance is measured from the ENGINE's spot at its floored origin, not from the
 * minute's oracle print, so the level the engine scores is the level the page names.
 * If the engine's spot is already at or past the break point, the step says so and
 * carries no probability.
 */
export function delayReadings(
  cmp: Comparison,
  windows: ArmedWindow[],
  pathStartTs: number,
  stepSeconds: number,
  series: PriceSeries | null,
  priceAtMinute: (minute: number) => number | null,
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
      const p = priceAtMinute(m)
      const ts = pathStartTs + m * stepSeconds
      if (ltv === null || ltv === undefined || p === null || !(breakLine > 0)) continue
      const breakPrice = (p * ltv) / breakLine
      const spot = engineSpot(asset, ts, series)
      if (spot === null || !(spot > 0)) {
        steps.push({ minute: m, ts, spot: null, breakPrice, toBreakPct: null, alreadyPast: false, reach: null })
        continue
      }
      const toBreakPct = (breakPrice / spot - 1) * 100
      const alreadyPast = toBreakPct >= 0
      steps.push({
        minute: m,
        ts,
        spot,
        breakPrice,
        toBreakPct,
        alreadyPast,
        reach: alreadyPast ? null : reach(asset, ts, toBreakPct, series, { purpose: 'line' }),
      })
    }
  }
  const anyShown = steps.some((s) => s.alreadyPast || (s.reach?.rows ?? []).some((r) => shown(r.result).kind !== 'none' || !!r.count))
  if (!anyShown) {
    const reason = steps.find((s) => s.reach)?.reach?.reason ?? touchProbability(asset, pathStartTs + breach.minute * stepSeconds, 1, -1, series).reason
    return { status: 'pending', reason: reason ?? 'no displayable cell for this asset inside the window' }
  }
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

export interface ForwardReach {
  /** The engine's latest spot for the anchor asset. */
  spot: number | null
  /** The anchor price at which the position reaches its venue line, today's amounts. */
  linePrice: number | null
  /** linePrice / spot − 1, in percent. Negative = the line is below spot. */
  distancePct: number | null
  reach: ReachResult
}

/**
 * Forward reach from today (refuting review D3). The distance is computed at the
 * engine's latest spot from the position's AMOUNTS — collateral × spot against debt —
 * never from an LTV read at another time (the demo's Oct 2025 LTV would be stale). Other
 * collateral legs and the debt are held at their read value. If spot is at or past the
 * line, the engine returns throughLine and the page says "act now" with no probability.
 */
export function forwardReach(position: ProtocolPosition, nowTs: number, series: PriceSeries | null): Slot<ForwardReach> {
  const asset = anchorAsset(position)
  if (!asset) return { status: 'pending', reason: 'no collateral to forecast' }
  const leg = position.collateral.find((c) => c.symbol === asset)
  const spot = engineSpot(asset, nowTs, series)
  if (!leg || !(leg.amount > 0) || spot === null || !(spot > 0) || !(position.liquidationLtv > 0)) {
    const r = reach(asset, nowTs, lineDistancePct(position), series, { purpose: 'line' })
    return { status: 'pending', reason: r.reason ?? 'no spot for this asset' }
  }
  const others = position.collateral.filter((c) => c !== leg).reduce((a, c) => a + c.valueUsd, 0)
  const linePrice = (position.totalDebtUsd / position.liquidationLtv - others) / leg.amount
  const distancePct = (linePrice / spot - 1) * 100
  const r = reach(asset, nowTs, distancePct, series, { purpose: 'line' })
  if (!r.throughLine && (r.rows.length === 0 || r.rows.every((row) => shown(row.result).kind === 'none' && !row.count && row.status !== 'beyond'))) {
    return { status: 'pending', reason: r.reason ?? 'no displayable horizon for this asset' }
  }
  return { status: 'ready', value: { spot, linePrice, distancePct, reach: r } }
}
