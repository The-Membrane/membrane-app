/**
 * THE UNTESTED BASELINE behind a forward region (owner's "Venue outlook · personal" design,
 * Q27 round 6): expected = today's level; the ranges and the thin "possible paths" come from
 * the real 1–7-day moves of the SAME series over the last 12 months. Pure: no I/O.
 *
 * It is model-only. No chance figure is derived from it, and the page labels it "model-only ·
 * untested baseline · not a forecast we stand behind yet" (DESIGN_RULES §4: a likelihood
 * appears only with a realized-outcome record; this has none). When the series does not
 * cover 12 months the region stays "model pending" and says why.
 *
 * Moves:
 *   'ratio'  v(d+h) / v(d), applied to today's level (a level that scales: free liquidity)
 *   'diff'   v(d+h) − v(d), added to today's level (a level that crosses zero: a spread)
 * One point per UTC day (the newest of the day); a move needs both of its days observed.
 */

export interface SeriesPoint {
  t: number
  v: number
}

export type MoveKind = 'ratio' | 'diff'

/** The look-back the baseline is built from, days. */
export const BASELINE_LOOKBACK_D = 365
/** The baseline's horizons, days: 1 to 7. */
export const BASELINE_HORIZONS_D = [1, 2, 3, 4, 5, 6, 7] as const
/** The series must span this many days of the look-back… */
export const BASELINE_MIN_SPAN_D = 330
/** …with at least this many observed days… */
export const BASELINE_MIN_DAYS = 300
/** …and every horizon at least this many observed moves. */
export const BASELINE_MIN_MOVES = 200
/** Thin "possible paths": real 7-day stretches of the year, evenly spaced, re-based to today. */
export const BASELINE_PATHS = 12

export interface FanStep {
  /** Days ahead (0 = now). */
  h: number
  p05: number
  p25: number
  p75: number
  p95: number
  /** Moves behind this step. */
  n: number
}

export type Baseline =
  | {
      ok: true
      kind: MoveKind
      /** Today's level: the expected line. */
      level: number
      /** h = 0 (all at the level) then h = 1…7. */
      steps: FanStep[]
      /** Each path: values at h = 0…7. */
      paths: number[][]
      /** First and last observed day used (unix s), and how many days were observed. */
      from: number
      to: number
      days: number
    }
  | { ok: false; reason: string }

const DAY = 86_400

/** The newest point of each UTC day within [from, to]. */
export function byDay(series: SeriesPoint[], from: number, to: number): Map<number, number> {
  const best = new Map<number, { t: number; v: number }>()
  for (const p of series) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v) || p.t < from || p.t > to) continue
    const d = Math.floor(p.t / DAY)
    const prev = best.get(d)
    if (!prev || p.t > prev.t) best.set(d, p)
  }
  return new Map([...best.entries()].map(([d, p]) => [d, p.v]))
}

/** Linear-interpolated quantile of a sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

const move = (kind: MoveKind, a: number, b: number): number | null => {
  if (kind === 'diff') return b - a
  return a > 0 && b >= 0 ? b / a : null
}
const apply = (kind: MoveKind, level: number, m: number): number => (kind === 'diff' ? level + m : level * m)

/**
 * The baseline for `level` (today's value) from `series`, the look-back ending at `nowS`.
 * Returns why not when the series is too short or the level cannot move in proportion.
 */
export function baselineFan(series: SeriesPoint[], level: number | null, nowS: number, kind: MoveKind): Baseline {
  if (level === null || !Number.isFinite(level)) return { ok: false, reason: 'no reading now' }
  if (kind === 'ratio' && !(level > 0)) return { ok: false, reason: 'the level is 0 now, so moves in proportion cannot leave it' }
  const days = byDay(series, nowS - BASELINE_LOOKBACK_D * DAY, nowS + DAY)
  const keys = [...days.keys()].sort((a, b) => a - b)
  const span = keys.length > 0 ? keys[keys.length - 1] - keys[0] : 0
  if (keys.length < BASELINE_MIN_DAYS || span < BASELINE_MIN_SPAN_D) {
    return { ok: false, reason: `${keys.length} days of this series (needs 12 months)` }
  }
  const steps: FanStep[] = [{ h: 0, p05: level, p25: level, p75: level, p95: level, n: 0 }]
  for (const h of BASELINE_HORIZONS_D) {
    const ms: number[] = []
    for (const d of keys) {
      const b = days.get(d + h)
      if (b === undefined) continue
      const m = move(kind, days.get(d) as number, b)
      if (m !== null && Number.isFinite(m)) ms.push(m)
    }
    if (ms.length < BASELINE_MIN_MOVES) return { ok: false, reason: `${ms.length} observed ${h}-day moves (needs ${BASELINE_MIN_MOVES})` }
    ms.sort((a, b) => a - b)
    steps.push({
      h,
      p05: apply(kind, level, quantile(ms, 0.05)),
      p25: apply(kind, level, quantile(ms, 0.25)),
      p75: apply(kind, level, quantile(ms, 0.75)),
      p95: apply(kind, level, quantile(ms, 0.95)),
      n: ms.length,
    })
  }
  const H = BASELINE_HORIZONS_D[BASELINE_HORIZONS_D.length - 1]
  const starts = keys.filter((d) => {
    for (let h = 0; h <= H; h++) if (!days.has(d + h)) return false
    return move(kind, days.get(d) as number, days.get(d + H) as number) !== null
  })
  const paths: number[][] = []
  const k = Math.min(BASELINE_PATHS, starts.length)
  for (let j = 0; j < k; j++) {
    const d = starts[Math.floor(((j + 0.5) * starts.length) / k)]
    const a = days.get(d) as number
    const path: number[] = []
    for (let h = 0; h <= H; h++) path.push(apply(kind, level, move(kind, a, days.get(d + h) as number) as number))
    paths.push(path)
  }
  return { ok: true, kind, level, steps, paths, from: keys[0] * DAY, to: keys[keys.length - 1] * DAY, days: keys.length }
}

/** The region's label: one rule for every surface that draws a baseline. */
export const BASELINE_LABEL = ['model-only · untested baseline', 'not a forecast we stand behind yet'] as const
