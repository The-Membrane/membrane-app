/**
 * TIME TO TOUCH: the chance a line L% away is touched BY time t, for t from 1 hour to 7
 * days, as one curve with its band (owner, 2026-10-17: "within 7 days it's 14% but it's low
 * chance in 1 day or the next 12 hours … combine the ranges into one visual").
 *
 * SAME MODEL. Every point is the forecast table's own outcome (touchHistory.ts: share of
 * daily origins whose window touched the line, 90% block-bootstrap band), counted at more
 * window lengths by scripts/position/build-touch-time.mjs. Nothing is fitted or
 * interpolated: the curve is drawn through the grid points.
 *
 * CHECKED vs MODEL-ONLY. At 1, 3 and 7 days the point IS the table's cell (the figure the
 * page quotes, with its preliminary confidence from the realized 2024–26 outcomes). Every
 * other point has no realized-outcome check and is flagged `checked: false`.
 *
 * MONOTONE. A touch by t is a touch by any later t, so the curve is non-decreasing. The
 * table's 1/3/7-day cells are fixed; a model-only point is held between the highest earlier
 * point and the next checked point (origin sets differ slightly by window length, so a raw
 * point can stray by a count or two). The same holds for each band edge.
 */

import raw from './touchTime.generated.json'
import { confidenceOf, formatChance, touchAtLevel, type ForecastConfidence } from './touch'
import type { Direction, HistoryAsset, HorizonId, TouchTable } from './touchHistory'

export interface TouchTimeCell {
  n: number
  /** touched[L − levels.min], and the band's ends, as counts of n. */
  touched: number[]
  lo: number[]
  hi: number[]
}

export interface TouchTimeGrid {
  schema: 1
  method: string
  levels: { min: number; max: number; step: number }
  /** Window lengths, hours, ascending. */
  hours: number[]
  /** The lengths validation/t1 scores (24, 72, 168). */
  checkedHours: number[]
  source: { repo: string; commit: string }
  assets: Record<HistoryAsset, Record<Direction, Record<string, TouchTimeCell>>>
}

/** Structural check, so a bad regeneration fails a unit test rather than drawing a wrong curve. */
export function assertTouchTimeGrid(g: unknown): asserts g is TouchTimeGrid {
  const bad = (what: string): never => {
    throw new Error(`touch time grid: ${what}`)
  }
  const o = g as TouchTimeGrid
  if (!o || o.schema !== 1) bad('schema')
  if (!Array.isArray(o.hours) || o.hours.some((h, i) => i > 0 && !(h > o.hours[i - 1]))) bad('hours')
  const width = o.levels.max - o.levels.min + 1
  for (const a of ['ETH', 'BTC'] as const)
    for (const d of ['fall', 'rise'] as const)
      for (const h of o.hours) {
        const c = o.assets?.[a]?.[d]?.[String(h)]
        if (!c || !(c.n > 0)) bad(`${a}.${d}.${h}`)
        if (c.touched.length !== width || c.lo.length !== width || c.hi.length !== width) bad(`${a}.${d}.${h} width`)
      }
}

const parsed: unknown = raw
assertTouchTimeGrid(parsed)
export const TOUCH_TIME_GRID: TouchTimeGrid = parsed

/** The table horizons the grid's checked lengths are. 14d / 30d lie past the 7-day axis. */
export const CHECKED_HORIZON: Record<number, HorizonId> = { 24: '1d', 72: '3d', 168: '7d' }

/** The axis: 1 hour (the hourly series' resolution) to 7 days. */
export const TIME_AXIS = { fromHours: 1, toHours: 168 } as const

export interface TimePoint {
  hours: number
  /** Percent, unrounded. */
  pct: number
  loPct: number
  hiPct: number
  n: number
  /** True only at a table horizon: a realized-outcome check stands behind it. */
  checked: boolean
  /** The table horizon at a checked point. */
  horizon: HorizonId | null
  confidence: ForecastConfidence | null
}

export interface TimeReading {
  hours: number
  /** "by 12 h" / "by day 2" */
  label: string
  /** formatChance of the point: "<1%", "3%". */
  chance: string
  checked: boolean
}

export interface TimeToTouch {
  asset: HistoryAsset
  direction: Direction
  level: number
  points: TimePoint[]
  /** The curve read at 12 h, day 2 and day 7, for the line under the chart. */
  readings: TimeReading[]
}

/** "1 h", "12 h", "day 2", "day 7". */
export function timeLabel(hours: number): string {
  if (hours < 24) return `${hours} h`
  const d = hours / 24
  return Number.isInteger(d) ? `day ${d}` : `${Math.round(hours)} h`
}

/** The hours the reading line quotes. */
export const READ_AT_HOURS = [12, 48, 168] as const

/**
 * The time-to-touch curve at a whole-percent level. Null when the level is outside the
 * table (the line is under 1% away, or past 60%): there is no row to draw.
 */
export function timeToTouch(
  t: TouchTable,
  g: TouchTimeGrid,
  asset: HistoryAsset,
  direction: Direction,
  level: number,
): TimeToTouch | null {
  if (!Number.isInteger(level) || level < g.levels.min || level > g.levels.max) return null
  if (level < t.levels.min || level > t.levels.max) return null
  const i = level - g.levels.min
  const hours = g.hours.filter((h) => h >= TIME_AXIS.fromHours && h <= TIME_AXIS.toHours)

  // Raw points: the table's cell at a checked length, the grid's elsewhere.
  const rawPts: TimePoint[] = hours.map((h) => {
    const horizon = CHECKED_HORIZON[h] ?? null
    if (horizon) {
      const f = touchAtLevel(t, asset, direction, horizon, level)
      if (!f) throw new Error(`timeToTouch: no table cell at ${horizon} ${level}%`)
      return {
        hours: h,
        pct: f.pct,
        loPct: f.loPct,
        hiPct: f.hiPct,
        n: f.n,
        checked: true,
        horizon,
        confidence: confidenceOf(t, asset, direction, horizon),
      }
    }
    const c = g.assets[asset][direction][String(h)]
    return {
      hours: h,
      pct: (c.touched[i] / c.n) * 100,
      loPct: (c.lo[i] / c.n) * 100,
      hiPct: (c.hi[i] / c.n) * 100,
      n: c.n,
      checked: false,
      horizon: null,
      confidence: null,
    }
  })

  // Hold each series between the highest earlier value and the next checked value.
  const keys = ['pct', 'loPct', 'hiPct'] as const
  const pts = rawPts.map((p) => ({ ...p }))
  for (const k of keys) {
    let floor = 0
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j]
      if (!p.checked) {
        const nextChecked = pts.slice(j + 1).filter((q) => q.checked)
        const ceil = nextChecked.length ? Math.min(...nextChecked.map((q) => q[k])) : Infinity
        p[k] = Math.min(Math.max(p[k], floor), Math.max(floor, ceil))
      }
      floor = Math.max(floor, p[k])
    }
  }
  for (const p of pts) {
    p.loPct = Math.min(p.loPct, p.pct)
    p.hiPct = Math.max(p.hiPct, p.pct)
  }

  const readings = READ_AT_HOURS.map((h) => {
    const p = pts.find((q) => q.hours === h)
    if (!p) throw new Error(`timeToTouch: no grid point at ${h} h`)
    // formatChance takes counts; percent × n / 100 reproduces the point's count.
    return { hours: h, label: timeLabel(h), chance: formatChance((p.pct * p.n) / 100, p.n), checked: p.checked }
  })
  return { asset, direction, level, points: pts, readings }
}

/** "Under 1% by 12 h · 3% by day 2 · 14% by day 7" — the curve read at three times. */
export function readingLine(tt: TimeToTouch): string {
  return tt.readings
    .map((r, k) => {
      const chance = r.chance === '<1%' ? (k === 0 ? 'Under 1%' : 'under 1%') : r.chance
      return `${chance} by ${r.label}`
    })
    .join(' · ')
}
