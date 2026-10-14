/**
 * History frequency at a distance: "ETH fell 27% or more within 7 days on 3% of days".
 *
 * TOWARD RISK. A distance is floored to a whole percent before the lookup, and the table
 * is monotone non-increasing in the level, so the floor can only pick the LARGER (riskier)
 * frequency. A displayed frequency is rounded UP for the same reason (formatFrequency).
 *
 * The `confidence` slot is typed for the Q26 labels but is always null today: those labels
 * are not published for app use. The UI renders nothing for null.
 */

import {
  HORIZON_IDS,
  type Direction,
  type HistoryAsset,
  type HorizonId,
  type TouchTable,
} from './touchHistory'

/** Q26 confidence labels. Not published for app use yet — every value today is null. */
export type HistoryConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'insufficient' | 'STALE'

export interface TouchFrequency {
  asset: HistoryAsset
  direction: Direction
  horizon: HorizonId
  /** The whole-percent table level looked up (the floored distance). */
  level: number
  touched: number
  n: number
  /** touched / n × 100, unrounded. */
  pct: number
  period: { from: string; to: string }
  confidence: HistoryConfidence | null
}

/**
 * A fraction as a whole percent, floored (toward risk for a distance). The epsilon only
 * absorbs float noise such as 0.29 × 100 = 28.999999999999996; it never moves a real
 * value across a whole percent.
 */
export const floorPct = (fraction: number): number => Math.floor(fraction * 100 + 1e-9)

export type TouchLookup =
  | { kind: 'row'; row: TouchFrequency }
  /** Distance under the table's first level (1%): the line is closer than any row. */
  | { kind: 'within'; minLevel: number }
  /** Distance past the table's last level (60%): no row to quote. */
  | { kind: 'beyond'; maxLevel: number }

/** Frequency at a whole-percent level. Null when the level is outside the table. */
export function touchAtLevel(
  t: TouchTable,
  asset: HistoryAsset,
  direction: Direction,
  horizon: HorizonId,
  level: number,
): TouchFrequency | null {
  if (!Number.isInteger(level) || level < t.levels.min || level > t.levels.max) return null
  const r = t.assets[asset][direction][horizon]
  const touched = r.touched[level - t.levels.min]
  return {
    asset,
    direction,
    horizon,
    level,
    touched,
    n: r.n,
    pct: (touched / r.n) * 100,
    period: { from: r.from, to: r.to },
    confidence: null,
  }
}

/**
 * Frequency at a distance (a fraction, 0.27 = 27%). The level is floor(distance%).
 * Returns why there is no row when the distance is outside 1%–60%.
 */
export function lookupTouch(
  t: TouchTable,
  asset: HistoryAsset,
  direction: Direction,
  horizon: HorizonId,
  distance: number,
): TouchLookup {
  const level = floorPct(distance)
  if (level < t.levels.min) return { kind: 'within', minLevel: t.levels.min }
  if (level > t.levels.max) return { kind: 'beyond', maxLevel: t.levels.max }
  const row = touchAtLevel(t, asset, direction, horizon, level)
  return row ? { kind: 'row', row } : { kind: 'beyond', maxLevel: t.levels.max }
}

/** The lookup as the brief states it: the row, or null when outside the table. */
export function touchAt(
  t: TouchTable,
  asset: HistoryAsset,
  direction: Direction,
  horizon: HorizonId,
  distance: number,
): TouchFrequency | null {
  const l = lookupTouch(t, asset, direction, horizon, distance)
  return l.kind === 'row' ? l.row : null
}

/** One row per horizon, in horizon order. Null entries are outside the table. */
export function touchByHorizon(
  t: TouchTable,
  asset: HistoryAsset,
  direction: Direction,
  distance: number,
): TouchFrequency[] {
  return HORIZON_IDS.map((h) => touchAt(t, asset, direction, h, distance)).filter(
    (r): r is TouchFrequency => r !== null,
  )
}

/**
 * A frequency for display, rounded toward risk: up to a whole percent. A frequency above
 * 0 but under 1% reads "<1%", and none at all reads "0%"; neither is rounded to a figure
 * the history does not contain.
 */
export function formatFrequency(touched: number, n: number): string {
  if (!(n > 0)) throw new Error('formatFrequency: n must be positive')
  if (touched <= 0) return '0%'
  const pct = (touched / n) * 100
  if (pct < 1) return '<1%'
  return `${Math.ceil(pct - 1e-9)}%`
}

/** The 7d, 5% etc. target test in integers: touched / n ≤ pct / 100. */
export const atOrBelow = (touched: number, n: number, pct: number): boolean => touched * 100 <= pct * n
