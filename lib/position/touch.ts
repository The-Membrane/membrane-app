/**
 * The forecast at a distance: "Chance ETH touches your line within 7 days: 12%, likely
 * 9–15%" (FORECAST_VISUALS.md). Each value is the share of past daily origins that touched
 * that line, with its 90% block-bootstrap band; see touchHistory.ts for the period.
 *
 * TOWARD RISK. A distance is floored to a whole percent before the lookup, and the table
 * is monotone non-increasing in the level, so the floor can only pick the LARGER (riskier)
 * chance. A displayed chance is rounded UP; a band is widened outward (low floored, high
 * ceiled). The table is at 1% steps, so no interpolation is ever needed.
 *
 * CONFIDENCE is a typed slot. Today it carries the preliminary t1 span check
 * (source 't1-span-check'); Q26's published labels replace it (source 'q26') without
 * touching any reader.
 */

import {
  HORIZON_IDS,
  type ConfidenceLabel,
  type Direction,
  type HistoryAsset,
  type HorizonId,
  type TouchTable,
} from './touchHistory'

export interface ForecastConfidence {
  label: ConfidenceLabel
  /** "held in 4 of 5 checks" / "no checks" */
  basis: string
  /** True until the Q26 test reports. */
  preliminary: boolean
  source: 't1-span-check' | 'q26'
}

export interface TouchFrequency {
  asset: HistoryAsset
  direction: Direction
  horizon: HorizonId
  /** The whole-percent table level looked up (the floored distance). */
  level: number
  touched: number
  n: number
  /** touched / n × 100, unrounded: the point forecast. */
  pct: number
  /** The 90% band, as counts out of n and as percent. */
  lo: number
  hi: number
  loPct: number
  hiPct: number
  period: { from: string; to: string }
  confidence: ForecastConfidence | null
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

/** "held in 4 of 5 checks", from the table's preliminary span check. */
export function confidenceOf(t: TouchTable, asset: HistoryAsset, direction: Direction, horizon: HorizonId): ForecastConfidence {
  const c = t.assets[asset][direction][horizon].confidence
  return {
    label: c.label,
    basis: c.checks === 0 ? 'no checks' : `held in ${c.held} of ${c.checks} checks`,
    preliminary: t.confidenceRule.preliminary,
    source: 't1-span-check',
  }
}

/** Forecast at a whole-percent level. Null when the level is outside the table. */
export function touchAtLevel(
  t: TouchTable,
  asset: HistoryAsset,
  direction: Direction,
  horizon: HorizonId,
  level: number,
): TouchFrequency | null {
  if (!Number.isInteger(level) || level < t.levels.min || level > t.levels.max) return null
  const r = t.assets[asset][direction][horizon]
  const i = level - t.levels.min
  return {
    asset,
    direction,
    horizon,
    level,
    touched: r.touched[i],
    n: r.n,
    pct: (r.touched[i] / r.n) * 100,
    lo: r.lo[i],
    hi: r.hi[i],
    loPct: (r.lo[i] / r.n) * 100,
    hiPct: (r.hi[i] / r.n) * 100,
    period: { from: r.from, to: r.to },
    confidence: confidenceOf(t, asset, direction, horizon),
  }
}

/** Every level from `from` to `to`, for a curve. Levels outside the table are skipped. */
export function touchCurve(
  t: TouchTable,
  asset: HistoryAsset,
  direction: Direction,
  horizon: HorizonId,
  from: number,
  to: number,
): TouchFrequency[] {
  const out: TouchFrequency[] = []
  for (let L = from; L <= to; L++) {
    const f = touchAtLevel(t, asset, direction, horizon, L)
    if (f) out.push(f)
  }
  return out
}

/**
 * Forecast at a distance (a fraction, 0.27 = 27%). The level is floor(distance%).
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

/** The lookup as a row, or null when outside the table. */
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

/** One row per horizon, in horizon order. Levels outside the table give no row. */
export function touchByHorizon(t: TouchTable, asset: HistoryAsset, direction: Direction, distance: number): TouchFrequency[] {
  return HORIZON_IDS.map((h) => touchAt(t, asset, direction, h, distance)).filter((r): r is TouchFrequency => r !== null)
}

/**
 * A chance for display, rounded toward risk: up to a whole percent. Anything under 1%,
 * zero touches included, reads "<1%": "0%" is never shown (DESIGN_RULES §4 — no history
 * of zero touches proves a zero chance).
 */
export function formatChance(touched: number, n: number): string {
  if (!(n > 0)) throw new Error('formatChance: n must be positive')
  const pct = (Math.max(0, touched) / n) * 100
  if (pct < 1) return '<1%'
  return `${Math.ceil(pct - 1e-9)}%`
}

/**
 * The upper end of the band in percent, rounded up. The generated table's `hi` is already
 * floored at the rule of three on independent windows, 3T/n (build-touch-history.mjs
 * floorBandTop); a zero `hi` (a hand-built table) still reads the plain 3/n, never 0.
 */
export function bandTopPct(hi: number, n: number): number {
  const top = hi > 0 ? (hi / n) * 100 : (3 / n) * 100
  return Math.max(1, Math.ceil(top - 1e-9))
}

/**
 * The band for display, widened outward: "9–15%"; when its low end rounds to 0, "up to
 * 2%"; never a "0".
 */
export function formatBand(lo: number, hi: number, n: number): string {
  if (!(n > 0)) throw new Error('formatBand: n must be positive')
  const a = Math.floor((lo / n) * 100 + 1e-9)
  const b = bandTopPct(hi, n)
  if (a < 1) return `up to ${b}%`
  return a === b ? `${a}%` : `${a}–${b}%`
}

/** "Confidence: medium · held in 4 of 5 checks · preliminary" */
export function confidenceLine(c: ForecastConfidence | null): string | null {
  if (!c) return null
  return `Confidence: ${c.label} · ${c.basis}${c.preliminary ? ' · preliminary' : ''}`
}

/** The target test in integers: touched / n ≤ pct / 100. */
export const atOrBelow = (touched: number, n: number, pct: number): boolean => touched * 100 <= pct * n
