/**
 * The pure THRESHOLD EVALUATOR for "Alert me at X". No I/O: given a threshold's
 * stored state and one current reading, say whether this read is a transition.
 *
 *   not crossed → crossed   when the value is AT or past the line in the stated
 *                           direction ("alert me at X" fires at X: above ⇔ v ≥ X,
 *                           below ⇔ v ≤ X).
 *   crossed → cleared       when the value is back past the line by MORE than the
 *                           hysteresis band (metrics.ts hysteresisBand): above ⇔
 *                           v < X − band, below ⇔ v > X + band.
 *
 * A stale or unavailable reading is never evaluated: no crossing, no clearing, the
 * stored state stands and the feed says the threshold was not checked. Evaluating
 * the same reading twice is a no-op the second time (the state already moved), so
 * repeated feed reads are idempotent; the store backs this with a compare-and-set.
 *
 * OUT-OF-ORDER READINGS: two server instances can hold different cached readings.
 * A reading measured BEFORE the one the threshold last moved on (`lastAsOf`) is
 * SUPERSEDED and never evaluated, so an older cache cannot clear a newer crossing
 * (or re-cross a newer clear). The store guards the same condition in SQL.
 */

import { hysteresisBand, type Direction, type Metric } from './metrics'

export type Reading =
  | { status: 'ok'; value: number; asOf: string; source: string }
  | { status: 'stale'; value: number; asOf: string; source: string; maxAgeS: number }
  | { status: 'unavailable'; source: string; reason: string }

export type ThresholdState = {
  metric: Metric
  direction: Direction
  threshold: number
  /** Start of the current crossing; null when not crossed. */
  crossedAt: string | null
  /** As-of of the reading the stored state last moved on; null before the first. */
  lastAsOf?: string | null
}

export type SkipReason = 'stale' | 'unavailable' | 'superseded'

export type Evaluation =
  | { kind: 'skipped'; reason: SkipReason; crossed: boolean }
  | { kind: 'crossed'; value: number }
  | { kind: 'cleared'; value: number }
  | { kind: 'held'; value: number; crossed: boolean }

/** At or past the line in the stated direction. Exact equality counts (the alert is "at X"). */
export const isPast = (direction: Direction, value: number, threshold: number): boolean =>
  direction === 'above' ? value >= threshold : value <= threshold

/** Back on the near side by more than the band. Exactly at the band edge is NOT back. */
export const isBack = (metric: Metric, direction: Direction, value: number, threshold: number): boolean => {
  const band = hysteresisBand(metric, threshold)
  return direction === 'above' ? value < threshold - band : value > threshold + band
}

export const evaluate = (t: ThresholdState, reading: Reading | undefined | null): Evaluation => {
  const crossed = t.crossedAt !== null
  if (!reading || reading.status === 'unavailable') return { kind: 'skipped', reason: 'unavailable', crossed }
  if (reading.status === 'stale') return { kind: 'skipped', reason: 'stale', crossed }
  const value = reading.value
  if (!Number.isFinite(value)) return { kind: 'skipped', reason: 'unavailable', crossed }
  if (t.lastAsOf && Date.parse(reading.asOf) < Date.parse(t.lastAsOf)) return { kind: 'skipped', reason: 'superseded', crossed }
  if (!crossed) return isPast(t.direction, value, t.threshold) ? { kind: 'crossed', value } : { kind: 'held', value, crossed }
  return isBack(t.metric, t.direction, value, t.threshold) ? { kind: 'cleared', value } : { kind: 'held', value, crossed }
}

/**
 * Classify a raw source value by its age. `maxAgeS` is the source's normal cadence × 2
 * (values.ts). A timestamp a little in the future (clock skew) counts as fresh.
 */
export const readingFrom = (args: {
  value: number | null | undefined
  asOfMs: number | null | undefined
  nowMs: number
  maxAgeS: number
  source: string
}): Reading => {
  const { value, asOfMs, nowMs, maxAgeS, source } = args
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { status: 'unavailable', source, reason: 'no value' }
  }
  if (asOfMs === null || asOfMs === undefined || !Number.isFinite(asOfMs)) {
    return { status: 'unavailable', source, reason: 'no timestamp' }
  }
  const asOf = new Date(asOfMs).toISOString()
  if (nowMs - asOfMs > maxAgeS * 1000) return { status: 'stale', value, asOf, source, maxAgeS }
  return { status: 'ok', value, asOf, source }
}

/** Map key for one (metric, subject) reading. */
export const readingKey = (metric: Metric, subject: string): string => `${metric}|${subject}`
