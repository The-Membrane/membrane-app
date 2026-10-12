/**
 * The anomaly detector. It scans the `windowHours` that end at the evaluation time, so the
 * wire is a dated feed, not a snapshot of one hour. Bands come from the subject's own history
 * BEFORE the window (causal: a replay of any past hour gives the answer the wire gave then).
 *
 * A LEVEL story fires at a reading when ALL of these hold:
 *
 *   1. TAIL      the judged value is at or beyond the p5 (low) / p95 (high) band; at p1 / p99
 *                it is 'extreme'; beyond every prior reading it is a 'record'.
 *   2. PERSISTS  the judged value is the least extreme of the last `persistReadings` readings,
 *                so a one-hour transient (the Aave USDC 00:00 UTC drain) never makes a story.
 *   3. MATERIAL  it sits at least the metric's floor away from the median, so a tail that is
 *                tiny in absolute terms (USDC at $0.9998) is not news.
 *   4. SINCE     "lowest since <date>" reaches back at least `minSinceDays`. A record always
 *                qualifies. Per series and tail the window keeps the reading whose "since"
 *                reaches back furthest (the deepest point), the later one on a tie.
 *
 * A RUN story fires at the evaluation time when the value has stayed in its tail band for at
 * least `minRunHours` and no earlier run that long ended within `minSinceDays` ("idle cash low
 * for 12 days, longest run since May"). It covers a stress that set its low before the window.
 *
 * A STATE story fires when a venue status flag (paused, frozen) switched inside the window.
 * Pure: frames in, findings out.
 */

import { baselineAt, baselineFor, priorBands, recentAt } from './baseline'
import { indexAt, type VenueFrame, type WireFrames } from './series'
import type {
  Anomaly,
  Bands,
  Baseline,
  Finding,
  MetricKey,
  Series,
  Since,
  StateChange,
  Tail,
  Uncovered,
} from './types'

export const WIRE_THRESHOLDS = {
  /** Tail band, % of the own-history distribution on each side (5 → p5 / p95). */
  tailPct: 5,
  /** Extreme band (1 → p1 / p99). */
  extremePct: 1,
  /** "Lowest since" must reach back at least this far to be news. */
  minSinceDays: 30,
  /** Prior history a baseline needs. */
  minHistoryDays: 90,
  /** Readings judged together (drops one-hour transients). */
  persistReadings: 2,
  /** A sustained tail is news from this many hours on. */
  minRunHours: 72,
  /** The feed covers this many hours before the evaluation time. */
  windowHours: 168,
  /** Newest reading older than this: the series gives no current verdict and is listed stale. */
  staleHours: 6,
}
export type WireThresholds = typeof WIRE_THRESHOLDS

export interface MetricRule {
  /** Which ends of the history are news for the reader. */
  tails: Tail[]
  /** Material floor: |value − median| at least this, in the series unit… */
  minGap: number
  /** …and at least this fraction of |median| (for token-unit series). */
  minRelGap: number
  /** A sustained tail is meaningful for this metric (not for a 24 h change). */
  runs: boolean
}

/**
 * Idle cash and utilisation are one number seen from two sides (idle = 100 − util), so each
 * side reports one tail only: idle cash low (exits shrink), utilisation low (yield falls).
 */
export const METRIC_RULES: Record<MetricKey, MetricRule> = {
  idleCashPct: { tails: ['low'], minGap: 2, minRelGap: 0, runs: true },
  exitCapacity: { tails: ['low'], minGap: 0, minRelGap: 0.25, runs: true },
  utilisationPct: { tails: ['low'], minGap: 5, minRelGap: 0, runs: true },
  borrowAprPct: { tails: ['high', 'low'], minGap: 1, minRelGap: 0, runs: true },
  navDiscountBps: { tails: ['high'], minGap: 25, minRelGap: 0, runs: true },
  depegBps: { tails: ['high'], minGap: 25, minRelGap: 0, runs: true },
  oracleDeviationBps: { tails: ['high'], minGap: 40, minRelGap: 0, runs: true },
  priceMove24hPct: { tails: ['low'], minGap: 5, minRelGap: 0, runs: false },
}

const EDGE: Record<number, { low: keyof Bands; high: keyof Bands }> = {
  1: { low: 'p1', high: 'p99' },
  5: { low: 'p5', high: 'p95' },
  10: { low: 'p10', high: 'p90' },
}

/** The band value at `pct` on the given side (5, low → p5). */
export function bandEdge(b: Bands, pct: number, tail: Tail): number {
  const e = EDGE[pct]
  if (!e) throw new Error(`venueWire: band ${pct} is not computed (use 1, 5 or 10)`)
  return b[e[tail]]
}

const beyond = (x: number, edge: number, tail: Tail) => (tail === 'low' ? x <= edge : x >= edge)

/** Tail and material checks of a judged value. */
export function inTail(
  x: number,
  b: Bands,
  metric: MetricKey,
  tail: Tail,
  th: WireThresholds,
): boolean {
  const rule = METRIC_RULES[metric]
  return (
    beyond(x, bandEdge(b, th.tailPct, tail), tail) &&
    Math.abs(x - b.p50) >= Math.max(rule.minGap, rule.minRelGap * Math.abs(b.p50))
  )
}

/** Level anomalies of one baseline (one reading). */
export function detectLevel(base: Baseline, th: WireThresholds = WIRE_THRESHOLDS): Anomaly[] {
  const out: Anomaly[] = []
  for (const tail of METRIC_RULES[base.metric].tails) {
    const x = base.guard[tail]
    if (!inTail(x, base.bands, base.metric, tail, th)) continue
    const since: Since = tail === 'low' ? base.lowestSince : base.highestSince
    const record = since.ts === null
    if (!record && since.days < th.minSinceDays) continue
    const severity = record
      ? 'record'
      : beyond(x, bandEdge(base.bands, th.extremePct, tail), tail)
        ? 'extreme'
        : 'tail'
    out.push({ kind: 'level', baseline: base, tail, severity, since })
  }
  return out
}

const reach = (s: Since) => (s.ts === null ? Infinity : s.days)

/** Level anomalies inside the window: the deepest qualifying reading per tail. */
export function scanLevels(
  s: Series,
  asOf: number,
  bands: Bands,
  th: WireThresholds = WIRE_THRESHOLDS,
): Anomaly[] {
  const last = indexAt(s.t, asOf)
  const from = asOf - th.windowHours * 3600
  const best = new Map<Tail, Anomaly>()
  for (let i = last; i >= 0 && s.t[i] > from; i--) {
    if (s.v[i] === null || s.v[i] === undefined) continue
    const recent = recentAt(s, i, th.persistReadings)
    if (recent.values.length < th.persistReadings) continue
    const tails = METRIC_RULES[s.metric].tails
    // Cheap pre-check before the "since" scans.
    const lo = Math.max(...recent.values)
    const hi = Math.min(...recent.values)
    if (!tails.some((t) => inTail(t === 'low' ? lo : hi, bands, s.metric, t, th))) continue
    for (const a of detectLevel(baselineFor(s, i, recent, bands), th)) {
      const cur = best.get(a.tail)
      // Scanning newest first: a later reading wins a tie.
      if (!cur || reach(a.since) > reach(cur.since)) best.set(a.tail, a)
    }
  }
  return [...best.values()]
}

/** The run story at the evaluation baseline, if its tail run is long and rare enough. */
export function scanRun(
  s: Series,
  base: Baseline,
  bands: Bands,
  th: WireThresholds = WIRE_THRESHOLDS,
): Anomaly[] {
  const rule = METRIC_RULES[s.metric]
  if (!rule.runs) return []
  const last = indexAt(s.t, base.at)
  const out: Anomaly[] = []
  for (const tail of rule.tails) {
    if (!inTail(base.guard[tail], bands, s.metric, tail, th)) continue
    const edge = bandEdge(bands, th.tailPct, tail)
    const isIn = (j: number) => beyond(s.v[j] as number, edge, tail)
    let start = last
    let j = last
    for (; j >= 0; j--) {
      if (s.v[j] === null || s.v[j] === undefined) continue
      if (!isIn(j)) break
      start = j
    }
    const hours = (s.t[last] - s.t[start]) / 3600
    if (hours < th.minRunHours) continue
    // Earlier runs, newest first: the first one at least as long gives "since". A run still
    // open where the record starts is judged too.
    let since: Since = { ts: null, days: (base.at - bands.fromTs) / 86_400 }
    let runEnd: number | null = null
    let runStart: number | null = null
    const longEnough = () =>
      runEnd !== null && runStart !== null && (s.t[runEnd] - s.t[runStart]) / 3600 >= hours
    for (; j >= 0 && s.t[j] >= s.fromTs; j--) {
      if (s.v[j] === null || s.v[j] === undefined) continue
      if (isIn(j)) {
        if (runEnd === null) runEnd = j
        runStart = j
        continue
      }
      if (longEnough()) break
      runEnd = null
      runStart = null
    }
    if (longEnough())
      since = { ts: s.t[runEnd as number], days: (base.at - s.t[runEnd as number]) / 86_400 }
    if (since.ts !== null && since.days < th.minSinceDays) continue
    out.push({
      kind: 'run',
      baseline: { ...base, bands },
      tail,
      severity: 'run',
      since,
      run: { from: s.t[start], hours, edge },
    })
  }
  return out
}

const FLAG_BITS: Record<StateChange['flag'], number> = { frozen: 2, paused: 4 }

/** Status flag switches of one venue inside the window ending at `at`. */
export function detectState(
  f: VenueFrame,
  at: number,
  th: WireThresholds = WIRE_THRESHOLDS,
): StateChange[] {
  const i = indexAt(f.t, at)
  if (i < 0 || f.flags[i] === null || at - f.t[i] > th.staleHours * 3600) return []
  const windowFrom = at - th.windowHours * 3600
  let recordFrom = f.t[i]
  for (let j = 0; j <= i; j++)
    if (f.flags[j] !== null) {
      recordFrom = f.t[j]
      break
    }
  const out: StateChange[] = []
  for (const flag of ['paused', 'frozen'] as const) {
    const bit = FLAG_BITS[flag]
    const isOn = (j: number) => ((f.flags[j] ?? 0) & bit) !== 0
    const on = isOn(i)
    // Start of the current run (readings with a null flag do not break it).
    let k = i
    let earlier = false
    for (let j = i - 1; j >= 0; j--) {
      if (f.flags[j] === null) continue
      if (isOn(j) !== on) {
        earlier = true
        break
      }
      k = j
    }
    if (!earlier || f.t[k] < windowFrom) continue
    let previous: number | null = null
    let runFrom: number | null = null
    if (on) {
      for (let j = k - 1; j >= 0; j--)
        if (f.flags[j] !== null && isOn(j)) {
          previous = f.t[j]
          break
        }
    } else {
      for (let j = k - 1; j >= 0; j--) {
        if (f.flags[j] === null) continue
        if (!isOn(j)) break
        runFrom = f.t[j]
      }
    }
    out.push({
      kind: 'state',
      subject: f.subject,
      flag,
      on,
      at: f.t[k],
      block: f.block?.[k] ?? null,
      previous,
      runFrom,
      recordFromTs: recordFrom,
      source: f.source,
    })
  }
  return out
}

export interface Detection {
  at: number
  findings: Finding[]
  /** Each series judged at the evaluation time (the instrument panel). */
  baselines: Baseline[]
  uncovered: Uncovered[]
  /** Newest reading time per subject and metric, for the staleness of each story. */
  newest: Map<string, number>
}

export const seriesKey = (subject: string, metric: string) => `${subject}|${metric}`

/** Every baseline, anomaly and state switch in the window that ends at `at`. */
export function detect(
  frames: WireFrames,
  at: number,
  th: WireThresholds = WIRE_THRESHOLDS,
): Detection {
  const findings: Finding[] = []
  const baselines: Baseline[] = []
  const uncovered: Uncovered[] = []
  const newest = new Map<string, number>()
  for (const s of frames.series) {
    const last = indexAt(s.t, at)
    const lastRecent = last >= 0 ? recentAt(s, last, 1).idx[0] : undefined
    if (lastRecent !== undefined) newest.set(seriesKey(s.subject.id, s.metric), s.t[lastRecent])
    const r = baselineAt(s, at, th)
    if (r.ok) baselines.push(r.baseline)
    else uncovered.push(r.uncovered)
    // Window bands: every reading before the window's first judged reading.
    const first = indexAt(s.t, at - th.windowHours * 3600) + 1
    const cut = recentAt(s, Math.max(0, first), th.persistReadings).idx.at(-1) ?? first
    const bands = priorBands(s, cut)
    if (!bands || (s.t[Math.min(cut, s.t.length - 1)] - bands.fromTs) / 86_400 < th.minHistoryDays)
      continue
    findings.push(...scanLevels(s, at, bands, th))
    if (r.ok) findings.push(...scanRun(s, r.baseline, bands, th))
  }
  for (const f of frames.venues.values()) {
    const i = indexAt(f.t, at)
    if (i < 0 || at - f.t[i] > th.staleHours * 3600) {
      uncovered.push({
        subject: f.subject.id,
        metric: 'state',
        reason: 'stale',
        detail: 'no status flags read near this time',
      })
      continue
    }
    newest.set(seriesKey(f.subject.id, 'state'), f.t[i])
    findings.push(...detectState(f, at, th))
  }
  return { at, findings, baselines, uncovered, newest }
}
