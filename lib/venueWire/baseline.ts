/**
 * Baselines against a subject's own history: percentile bands and "lowest / highest since".
 * Pure and causal: a baseline at time T reads only readings at or before T, so a replay of
 * any past hour gives the answer the wire would have given then.
 */

import { indexAt } from './series'
import type { Bands, Baseline, Series, Since, Uncovered } from './types'

export interface BaselineOptions {
  /** The last N readings are judged together: the least extreme of them must be in the tail. */
  persistReadings: number
  /** Prior history needed before a baseline means anything. */
  minHistoryDays: number
  /** A newest reading older than this at the evaluation time is stale. */
  staleHours: number
}

const DAY = 86_400

/** Quantile of an ascending array, linear interpolation between closest ranks. */
export function quantileSorted(a: readonly number[], q: number): number {
  if (a.length === 0) return NaN
  const k = (a.length - 1) * Math.min(1, Math.max(0, q))
  const f = Math.floor(k)
  const c = Math.min(f + 1, a.length - 1)
  return a[f] + (a[c] - a[f]) * (k - f)
}

export function bandsOf(values: readonly number[], fromTs: number, toTs: number): Bands {
  const a = [...values].sort((x, y) => x - y)
  const q = (p: number) => quantileSorted(a, p)
  return {
    n: a.length,
    fromTs,
    toTs,
    min: a[0],
    p1: q(0.01),
    p5: q(0.05),
    p10: q(0.1),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: a[a.length - 1],
  }
}

const isNum = (x: number | null | undefined): x is number =>
  x !== null && x !== undefined && Number.isFinite(x)

/**
 * The last reading before index `before` (exclusive) at or beyond `value` in the given
 * direction, scanning back no further than `fromTs`. ts null = beyond every prior reading.
 */
export function sinceOf(
  s: Pick<Series, 't' | 'v'>,
  before: number,
  value: number,
  dir: 'low' | 'high',
  fromTs: number,
  atTs: number,
  firstTs: number,
): Since {
  for (let j = before - 1; j >= 0 && s.t[j] >= fromTs; j--) {
    const x = s.v[j]
    if (!isNum(x)) continue
    if (dir === 'low' ? x <= value : x >= value) return { ts: s.t[j], days: (atTs - s.t[j]) / DAY }
  }
  return { ts: null, days: (atTs - firstTs) / DAY }
}

export type BaselineResult = { ok: true; baseline: Baseline } | { ok: false; uncovered: Uncovered }

const miss = (s: Series, reason: Uncovered['reason'], detail: string): BaselineResult => ({
  ok: false,
  uncovered: { subject: s.subject.id, metric: s.metric, reason, detail },
})

/** The last `n` readings at or before index `i`, newest first, with their indices. */
export function recentAt(
  s: Pick<Series, 'v'>,
  i: number,
  n: number,
): { values: number[]; idx: number[] } {
  const values: number[] = []
  const idx: number[] = []
  for (let j = i; j >= 0 && values.length < n; j--) {
    const x = s.v[j]
    if (!isNum(x)) continue
    values.push(x)
    idx.push(j)
  }
  return { values, idx }
}

/** Bands of the readings before index `cut` (from `fromTs` on), or null when there are none. */
export function priorBands(s: Series, cut: number): Bands | null {
  const prior: number[] = []
  let firstTs = Infinity
  let lastTs = -Infinity
  for (let j = 0; j < cut; j++) {
    const x = s.v[j]
    if (s.t[j] < s.fromTs || !isNum(x)) continue
    prior.push(x)
    if (s.t[j] < firstTs) firstTs = s.t[j]
    lastTs = s.t[j]
  }
  return prior.length ? bandsOf(prior, firstTs, lastTs) : null
}

export const guardOf = (values: readonly number[]) => ({
  low: Math.max(...values),
  high: Math.min(...values),
})

/** A baseline for the reading at index `i`, judged against `bands`. */
export function baselineFor(
  s: Series,
  i: number,
  recent: { values: number[]; idx: number[] },
  bands: Bands,
): Baseline {
  const guard = guardOf(recent.values)
  const start = recent.idx[recent.idx.length - 1]
  const at = s.t[i]
  return {
    subject: s.subject,
    metric: s.metric,
    unit: s.unit,
    source: s.source,
    at,
    latest: recent.values[0],
    guard,
    bands,
    lowestSince: sinceOf(s, start, guard.low, 'low', s.fromTs, at, bands.fromTs),
    highestSince: sinceOf(s, start, guard.high, 'high', s.fromTs, at, bands.fromTs),
  }
}

/** Evaluate one series at time `at` (unix s): bands over every reading before the judged ones. */
export function baselineAt(s: Series, at: number, opts: BaselineOptions): BaselineResult {
  const last = indexAt(s.t, at)
  const recent = recentAt(s, last, opts.persistReadings)
  if (recent.values.length === 0) return miss(s, 'no-data', 'no reading at or before this time')
  const newest = recent.idx[0]
  const ageH = (at - s.t[newest]) / 3600
  if (ageH > opts.staleHours)
    return miss(
      s,
      'stale',
      `newest reading is ${Math.round(ageH)} h older than the evaluation time`,
    )
  if (recent.values.length < opts.persistReadings)
    return miss(s, 'short-history', 'too few readings')
  const bands = priorBands(s, recent.idx[recent.idx.length - 1])
  const spanDays = bands ? (s.t[newest] - bands.fromTs) / DAY : 0
  if (!bands || spanDays < opts.minHistoryDays)
    return miss(
      s,
      'short-history',
      `${Math.floor(spanDays)} days of prior history, ${opts.minHistoryDays} needed`,
    )
  return { ok: true, baseline: baselineFor(s, newest, recent, bands) }
}
