/**
 * Every sentence and figure string on the wavefront page, as pure functions of the frame and
 * the stream's state (DESIGN_RULES §3: short, figures over prose, each fact once; §4: the 8h
 * window is conditional, modelled claims carry †, stale data withholds the headline).
 */

import {
  CURE_WINDOW_HOURS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '@/lib/position-sim/membrane'

import { fmtClock, fmtInt, fmtPctFloor, fmtWindow } from './format'
import type { MarkKind } from './marks'
import type { WavefrontFrame } from './model'

export const NBSP = ' '

/** Names the engine once, with its premises (the canvas's wording, the app's constants). */
export const ENGINE_LINE =
  `Membrane side†: the position simulator replaying cureWalk — ${CURE_WINDOW_HOURS}h window ` +
  `within ${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}% of the line (none for stablecoins), ` +
  `repay to cap, $${LIQ_DEBT_MINIMUM_USD.toLocaleString('en-US')} floor — on each ` +
  `protocol's own oracle, with no user action.`

export interface KickerInput {
  mode: 'replay' | 'live'
  status: 'loading' | 'ready' | 'error' | 'unavailable'
  frame: Pick<WavefrontFrame, 'coverage'> | null
  windowRange: { startTs: number; endTs: number } | null
  updatedAt: number | null
  stale: boolean
  staleSince: number | null
  /** Live was asked for and did not answer: the replay is shown instead. */
  liveUnavailable: boolean
}

/**
 * The kicker. "Live" only when the owner's go-live condition holds: live data, fresh, and the
 * simulator on every liquidated position (coverage walked == total).
 */
export function kickerText(i: KickerInput): string {
  if (i.mode === 'live' && i.status === 'ready') {
    if (i.stale) {
      const since = i.staleSince ?? i.updatedAt
      return since ? `Stale since ${fmtClock(since)}` : 'Stale'
    }
    const updated = i.updatedAt ? `updated ${fmtClock(i.updatedAt)}` : 'updating'
    const everyOne = i.frame && i.frame.coverage.walked === i.frame.coverage.total
    return everyOne ? `Live · ${updated}` : `Streaming · ${updated}`
  }
  const w = i.windowRange ? fmtWindow(i.windowRange.startTs, i.windowRange.endTs) : '…'
  return i.liveUnavailable ? `Live unavailable — showing the ${w} replay` : `Replay · ${w}`
}

/** The headline's number: withheld while live data is stale (§4). */
export function headlineCount(frame: Pick<WavefrontFrame, 'coverage'> | null, stale: boolean) {
  return frame && !stale ? fmtInt(frame.coverage.total) : '—'
}

/**
 * Coverage as n of total (DESIGN_RULES, Real vs Membrane comparisons: "state coverage (n of
 * total) on the page") — the positions shown on both sides out of every liquidated one.
 */
export function coverageText(frame: Pick<WavefrontFrame, 'coverage'> | null): string {
  if (!frame || frame.coverage.total === 0) return NBSP
  const { walked, total } = frame.coverage
  return `Same ${fmtInt(walked)} of ${fmtInt(total)} on both sides (${fmtPctFloor(walked, total)})`
}

export interface LegendDatum {
  kind: MarkKind
  count: number
  label: string
}

/** Membrane states, a partition of the walked positions (reducer counts). */
export function memStates(
  f: Pick<WavefrontFrame, 'totals' | 'gridEnd' | 'pending'>,
): LegendDatum[] {
  const m = f.totals.mem
  const out: LegendDatum[] = [
    { kind: 'sold', count: m.positionsSold - f.gridEnd, label: 'sold' },
    { kind: 'armed', count: m.positionsArmed, label: 'in 8h window' },
  ]
  if (f.gridEnd > 0)
    out.push({ kind: 'gridEnd', count: f.gridEnd, label: 'window open at data end†' })
  out.push({ kind: 'kept', count: m.positionsKept, label: 'kept' })
  if (f.pending > 0) out.push({ kind: 'pending', count: f.pending, label: 'pending' })
  return out
}

export const scaleNote = (perHex: number) =>
  perHex === 1 ? '1 hex = 1 position' : `1 hex = ${perHex} positions`

/** "$ skips sales with no USD price: 13 real, 11 simulated" (reducer counts), or ''. */
export function unpricedText(f: Pick<WavefrontFrame, 'totals'> | null): string {
  const r = f?.totals.real.unpricedEvents ?? 0
  const m = f?.totals.mem.unpricedSales ?? 0
  return r || m ? `$ skips sales with no USD price: ${fmtInt(r)} real, ${fmtInt(m)} simulated` : ''
}

/** The grid-end caveat for the Membrane $, once, or '' when there is none at t. */
export function gridEndText(
  f: Pick<WavefrontFrame, 'gridEnd'> | null,
  windowRange: { endTs: number } | null,
): string {
  if (!f || f.gridEnd === 0) return ''
  const at = windowRange ? fmtClock(windowRange.endTs) : 'the data end'
  return `Membrane $ counts them as sold at ${at}†`
}
