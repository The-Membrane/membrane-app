/**
 * measuredCapacity — the adapter that lets MEASURED venue exit capacity drive the stress
 * engine (stressGrid.ts). It turns a recorded capacity sample stream into ONE explicit
 * `exitCapacityUsd` (which wins over `exitCapacityPreset` in the engine), or refuses.
 *
 * Owner rulings it carries (2026-10-04): assuming the whole deployed amount is withdrawable
 * is the MOST optimistic case and is never assumed silently; every stress output carries
 * STRESS_LABEL ('stress scenario — not a probability'). A measured figure is descriptive
 * sampled history (MEASURED_DESCRIPTIVE_LABEL), not a forecast.
 *
 * ---------------------------------------------------------------------------
 * RULES (design critique; each has a test in tests/unit/measuredCapacity.test.ts)
 * ---------------------------------------------------------------------------
 *  1. EXECUTABLE METRIC ONLY. Only 'depth_curve' — a slippage-bounded, block-pinned quote
 *     capacity at cost <= costCapPct — may produce an exitCapacityUsd. 'aggregate_cash'
 *     (e.g. Aave aToken-held cash, sGHO vault cash: not holder-executable) and
 *     'depth_usd_raw' (a raw reserve, not an executable quote) are excluded; a stream with
 *     no depth_curve sample is not_modelled 'not_executable_metric'. A depth_curve sample
 *     without a finite costCapPct is unbounded, so it is not executable either.
 *  2. ONE SERIES. One metric + one route + one costCapPct. The cost cap is
 *     `opts.costCapPct`, else the latest depth_curve sample's; other cost caps are
 *     excluded. The route is the LIVE one (the latest sample of that stream): a route change
 *     starts a new series, so only the trailing run of samples on the latest sample's route
 *     is used — earlier samples on any route (including an earlier run on the same route)
 *     are excluded.
 *     SAME-INSTANT TIES (a recorder writes every cost cap of a block, or several routes, at
 *     one observedAtMs) never depend on input order and settle conservatively: the default
 *     cap is the SMALLEST cap at the latest depth_curve instant (the least permissive; noted);
 *     more than one route at the live instant is not_modelled 'ambiguous_route' (the adapter
 *     never picks one — pass one route's samples); an earlier instant that carries another
 *     route breaks the series, which then starts strictly after it.
 *  3. FRESHNESS. The latest KNOWN sample's age must be <= MEASURED_STALE_CADENCES (2) ×
 *     cadenceMs (default 1 h), else not_modelled 'stale' — never fed to the engine. Exactly
 *     2 × cadence is fresh. Values are named by their asOf (the sample's time and block),
 *     never 'now'; nowMs is a parameter used only to age them.
 *  4. TWO MEASURES.
 *       'latest'          the latest known sample's capacity (several known values at that
 *                         one instant: the MINIMUM).
 *       'worst-trailing'  the minimum known sample over the trailing `windowHours` (default
 *                         720 = 30 d) ending at asOf — ONLY when coverage >= 80% of the
 *                         window. Coverage is the time between consecutive known samples
 *                         whose gap is <= maxGapMs (default 6 h), clipped to the window
 *                         (a known sample just before the window start, on the same route,
 *                         covers the leading edge); a gap > maxGapMs is uncovered. The gate
 *                         compares the ratio covered / window, never a rounded threshold.
 *                         Else { status: 'insufficient_history', coverageHours, sampleCount }.
 *     sampleCount / unknownSampleCount count distinct sample INSTANTS: duplicates at one
 *     instant count once (an instant with any known value is not an unknown one).
 *     worst <= latest always (the latest known sample is inside the window).
 *  5. OPTIMISTIC EQUIVALENCE. exitCapacityUsd >= the position's deployedUsd (compared in
 *     cents, as the engine normalizes) sets equivalentToOptimistic: the measured stock
 *     equals the 'optimistic' preset for this position, and a note says so. That holds at
 *     the scenario's ×1 capacity. A scenario `capacityMult` scales the MEASURED figure
 *     (venue depth), where the preset scales the deployed amount, so under a capacity cut
 *     a measured figure above deployed leaves a LARGER stock than the 'optimistic' preset.
 *  6. OUTPUT. id, exitCapacityUsd, costCapPct, metric, routeId, asOfMs, asOfBlock,
 *     ageHours, sampleCount, coverageHours, windowHours, equivalentToOptimistic,
 *     descriptiveLabel, stressLabel, provenance (+ notes, the value's own sample time).
 *     It sets NO freezeHours and NO duration: a below-threshold run is not a freeze and an
 *     observed maximum or minimum is not a cap or a floor.
 *  7. withMeasuredCapacity(position, m) sets exitCapacityUsd and REMOVES
 *     exitCapacityPreset / exitCapacityMult. A result that is not 'measured' strips every
 *     capacity input instead, so a carry position with capital deployed runs not_modelled
 *     ('no_exit_capacity') — it never falls back to a preset. A malformed 'measured' object,
 *     or one computed against a different deployedUsd, throws.
 *  8. PURE AND DETERMINISTIC. No Date.now, no I/O; the same samples in ANY order (ties
 *     included: a canonical total order over every field settles them) and options give the
 *     same result. A time outside the Date range (|t| > 8.64e15 ms, e.g. a nanosecond stamp)
 *     is invalid_input, not a crash.
 *
 * UNKNOWN IS UNKNOWN. capacityUsd null means the quote reverted or the value is unknown. It
 * is NEVER read as 0 or as below any threshold: an unknown sample does not enter the
 * minimum, does not count as coverage (a gap is measured between KNOWN samples), and does
 * not refresh the asOf. A stream whose live route has no known sample is not_modelled
 * 'no_known_sample'.
 */

import { STRESS_LABEL, type StressPosition } from './stressGrid'

// ---------------------------------------------------------------- constants

export const MEASURED_DESCRIPTIVE_LABEL = 'sampled history, descriptive — not a forecast'

/** Expected sampling cadence. Default 1 h. */
export const MEASURED_DEFAULT_CADENCE_MS = 3_600_000
/** A value older than this many cadences is stale. */
export const MEASURED_STALE_CADENCES = 2
/** Trailing window for 'worst-trailing'. Default 720 h = 30 d. */
export const MEASURED_DEFAULT_WINDOW_HOURS = 720
/** A gap between known samples longer than this is uncovered. Default 6 h. */
export const MEASURED_DEFAULT_MAX_GAP_MS = 6 * 3_600_000
/** Share of the window that must be covered for 'worst-trailing'. */
export const MEASURED_MIN_COVERAGE = 0.8

const HOUR_MS = 3_600_000

// -------------------------------------------------------------------- types

export type CapacityMetric = 'depth_curve' | 'aggregate_cash' | 'depth_usd_raw'

const METRICS: readonly CapacityMetric[] = ['depth_curve', 'aggregate_cash', 'depth_usd_raw']

/** One recorded capacity observation. */
export interface CapacitySample {
  observedAtMs: number
  block: number | null
  metric: CapacityMetric
  routeId: string
  costCapPct: number | null
  /** null = quote reverted / unknown. NEVER treated as 0 or as below a threshold. */
  capacityUsd: number | null
}

export type MeasuredCapacityId = 'latest' | 'worst-trailing'

export interface MeasuredCapacityOptions {
  measure: MeasuredCapacityId
  /** The time the value is aged against. A parameter: this module never reads a clock. */
  nowMs: number
  /** The position's deployed amount, USD — rule 5 compares the capacity against it. */
  deployedUsd: number
  /** Cost cap of the series, percent. Default: the latest depth_curve sample's. */
  costCapPct?: number
  /** Default MEASURED_DEFAULT_CADENCE_MS (1 h). */
  cadenceMs?: number
  /** Default MEASURED_DEFAULT_WINDOW_HOURS (720). */
  windowHours?: number
  /** Default MEASURED_DEFAULT_MAX_GAP_MS (6 h). */
  maxGapMs?: number
}

export type MeasuredCapacityNotModelledReason =
  /** A sample or an option is malformed (non-finite, negative, unknown metric, after nowMs). */
  | 'invalid_input'
  /** No samples at all, or none at the requested cost cap. */
  | 'no_samples'
  /** Rule 1: no depth_curve sample with a finite cost cap — the metric is not executable. */
  | 'not_executable_metric'
  /** Every sample on the live route is unknown (null). */
  | 'no_known_sample'
  /** Rule 2: more than one route was sampled at the live (latest) instant. */
  | 'ambiguous_route'
  /** Rule 3: the latest known sample is older than MEASURED_STALE_CADENCES × cadence. */
  | 'stale'

export interface MeasuredCapacityNotModelled {
  status: 'not_modelled'
  id: MeasuredCapacityId
  reason: MeasuredCapacityNotModelledReason
  /** One line of context for logs and the UI's "why not". */
  detail: string
  /** The latest known sample's time, when there is one. */
  asOfMs: number | null
  ageHours: number | null
}

export interface MeasuredCapacityInsufficientHistory {
  status: 'insufficient_history'
  id: 'worst-trailing'
  coverageHours: number
  /** Distinct known sample instants inside the window. */
  sampleCount: number
  windowHours: number
  requiredCoverageHours: number
  routeId: string
  costCapPct: number
  asOfMs: number
  ageHours: number
}

/** A usable measured exit capacity. The only shape withMeasuredCapacity applies. */
export interface MeasuredExitCapacity {
  status: 'measured'
  id: MeasuredCapacityId
  exitCapacityUsd: number
  costCapPct: number
  metric: 'depth_curve'
  routeId: string
  /** The latest known sample on the live route: the value is named by this, not 'now'. */
  asOfMs: number
  asOfBlock: number | null
  /** (nowMs − asOfMs) in hours. */
  ageHours: number
  /** The sample the value itself came from: = asOf for 'latest'; the minimum for 'worst-trailing'. */
  valueObservedAtMs: number
  valueBlock: number | null
  /** Distinct known sample instants inside the window (duplicates count once). */
  sampleCount: number
  /** Distinct instants inside the window with only unknown (null) samples — not zero, not
   *  below anything. */
  unknownSampleCount: number
  coverageHours: number
  windowHours: number
  /** The deployed amount rule 5 compared against. */
  deployedUsd: number
  /** exitCapacityUsd >= deployedUsd: at the scenario's ×1 capacity the stock equals the
   *  'optimistic' preset for this position (rule 5; a capacity cut scales the measured
   *  figure, so it then stays at or above that preset's stock). */
  equivalentToOptimistic: boolean
  descriptiveLabel: typeof MEASURED_DESCRIPTIVE_LABEL
  stressLabel: typeof STRESS_LABEL
  provenance: string
  notes: string[]
}

export type MeasuredCapacityResult =
  | MeasuredExitCapacity
  | MeasuredCapacityNotModelled
  | MeasuredCapacityInsufficientHistory

// ------------------------------------------------------------------ helpers

const fin = Number.isFinite
/** The ECMAScript Date range: a time outside it has no ISO form (e.g. a nanosecond stamp). */
const MAX_TIME_MS = 8.64e15
const isTime = (ms: number) => fin(ms) && Math.abs(ms) <= MAX_TIME_MS
const cents = (x: number) => Math.round(x * 100)
const isKnown = (s: CapacitySample): s is CapacitySample & { capacityUsd: number } =>
  s.capacityUsd !== null
const isExecutable = (s: CapacitySample) =>
  s.metric === 'depth_curve' && s.costCapPct !== null && fin(s.costCapPct) && s.costCapPct >= 0

function sampleProblem(s: CapacitySample, nowMs: number): string | null {
  if (!s || typeof s !== 'object') return 'sample is not an object'
  if (!isTime(s.observedAtMs)) return 'observedAtMs is not a time in the Date range'
  if (s.observedAtMs > nowMs) return `sample observed after nowMs (${s.observedAtMs} > ${nowMs})`
  if (!METRICS.includes(s.metric)) return `unknown metric ${String(s.metric)}`
  if (typeof s.routeId !== 'string') return 'routeId is not a string'
  if (s.block !== null && !(fin(s.block) && s.block >= 0)) return 'block is not a block number'
  if (s.costCapPct !== null && !(fin(s.costCapPct) && s.costCapPct >= 0)) {
    return 'costCapPct is not a non-negative number'
  }
  if (s.capacityUsd !== null && !(fin(s.capacityUsd) && s.capacityUsd >= 0)) {
    return 'capacityUsd is neither null (unknown) nor a non-negative number'
  }
  return null
}

const cmpNullFirst = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** Unknown (null) first, then known capacities DESCENDING. */
const cmpCapacity = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : b - a

/**
 * Canonical total order (rule 8). Every field takes part, so the sorted stream — and every
 * choice made from it — depends on the samples alone, never on their input order. Within one
 * instant: unknown samples first, then known ones by capacity DESCENDING, so the last known
 * sample of an instant is its minimum (a same-instant conflict settles conservatively).
 */
function canonicalOrder(x: CapacitySample, y: CapacitySample): number {
  return (
    x.observedAtMs - y.observedAtMs ||
    cmpCapacity(x.capacityUsd, y.capacityUsd) ||
    cmpNullFirst(x.block, y.block) ||
    cmpStr(x.routeId, y.routeId) ||
    cmpNullFirst(x.costCapPct, y.costCapPct) ||
    cmpStr(x.metric, y.metric)
  )
}

/** Distinct observation instants. */
const instants = (xs: readonly CapacitySample[]) => new Set(xs.map((s) => s.observedAtMs))

const iso = (ms: number) => new Date(ms).toISOString()
const at = (ms: number, block: number | null) =>
  block === null ? iso(ms) : `${iso(ms)} (block ${block})`
const fmtUsd = (x: number) => `$${x.toFixed(2)}`
const fmtH = (x: number) => `${Number(x.toFixed(4))}h`

/**
 * Covered time, ms, inside [start, end]: the span between consecutive known samples whose
 * gap is <= maxGapMs, clipped to the window. `points` are known sample times, ascending,
 * on one route; a point before `start` only covers the leading edge.
 */
function coveredMs(points: readonly number[], start: number, end: number, maxGapMs: number) {
  let covered = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (b < start) continue
    if (b - a > maxGapMs) continue
    covered += Math.min(b, end) - Math.max(a, start)
  }
  return covered
}

// ------------------------------------------------------------------ adapter

/**
 * Turn a capacity sample stream into ONE measured exit capacity, or refuse (rules 1–6, 8).
 * Pure: nowMs is a parameter.
 */
export function measuredExitCapacity(
  samples: readonly CapacitySample[],
  opts: MeasuredCapacityOptions,
): MeasuredCapacityResult {
  const id = opts.measure
  const refuse = (
    reason: MeasuredCapacityNotModelledReason,
    detail: string,
    asOfMs: number | null = null,
  ): MeasuredCapacityNotModelled => ({
    status: 'not_modelled',
    id,
    reason,
    detail,
    asOfMs,
    ageHours: asOfMs === null ? null : (opts.nowMs - asOfMs) / HOUR_MS,
  })

  // -- options
  const cadenceMs = opts.cadenceMs ?? MEASURED_DEFAULT_CADENCE_MS
  const windowHours = opts.windowHours ?? MEASURED_DEFAULT_WINDOW_HOURS
  const maxGapMs = opts.maxGapMs ?? MEASURED_DEFAULT_MAX_GAP_MS
  if (id !== 'latest' && id !== 'worst-trailing') {
    return refuse('invalid_input', `unknown measure ${String(id)}`)
  }
  if (!isTime(opts.nowMs)) {
    return refuse('invalid_input', 'nowMs is not a time in the Date range (±8.64e15 ms)')
  }
  if (!(fin(opts.deployedUsd) && opts.deployedUsd >= 0)) {
    return refuse('invalid_input', 'deployedUsd is not a non-negative number')
  }
  if (!(fin(cadenceMs) && cadenceMs > 0)) return refuse('invalid_input', 'cadenceMs must be > 0')
  if (!(fin(windowHours) && windowHours > 0)) {
    return refuse('invalid_input', 'windowHours must be > 0')
  }
  if (!(fin(maxGapMs) && maxGapMs > 0)) return refuse('invalid_input', 'maxGapMs must be > 0')
  if (opts.costCapPct !== undefined && !(fin(opts.costCapPct) && opts.costCapPct >= 0)) {
    return refuse('invalid_input', 'costCapPct must be a non-negative number')
  }

  // -- samples: validate everything, then put them in the canonical order (ties included)
  for (const s of samples) {
    const problem = sampleProblem(s, opts.nowMs)
    if (problem) return refuse('invalid_input', problem)
  }
  if (samples.length === 0) return refuse('no_samples', 'no capacity samples')
  const sorted = [...samples].sort(canonicalOrder)

  // -- rule 1: executable metric only
  const executable = sorted.filter(isExecutable)
  if (executable.length === 0) {
    const metrics = Array.from(new Set(sorted.map((s) => s.metric))).join(', ')
    return refuse(
      'not_executable_metric',
      `no depth_curve sample with a finite cost cap (metrics seen: ${metrics}); aggregate cash and raw reserves are not holder-executable exit capacity`,
    )
  }
  const notes: string[] = []
  const otherMetric = sorted.length - executable.length
  if (otherMetric > 0) {
    notes.push(
      `${otherMetric} sample(s) of a non-executable metric (aggregate_cash, depth_usd_raw, or an uncapped depth_curve) excluded.`,
    )
  }

  // -- rule 2: one cost cap, one (live) route
  // Default cap: the latest depth_curve instant's; several caps there -> the smallest.
  const latestExecMs = executable[executable.length - 1].observedAtMs
  const capsAtLatest = Array.from(
    new Set(
      executable.filter((s) => s.observedAtMs === latestExecMs).map((s) => s.costCapPct as number),
    ),
  ).sort((a, b) => a - b)
  const costCapPct = opts.costCapPct ?? capsAtLatest[0]
  if (opts.costCapPct === undefined && capsAtLatest.length > 1) {
    notes.push(
      `${capsAtLatest.length} cost caps (${capsAtLatest.join('%, ')}%) sampled at the latest instant: the default is the smallest (least permissive), ${costCapPct}%.`,
    )
  }
  const atCap = executable.filter((s) => s.costCapPct === costCapPct)
  if (atCap.length === 0) {
    return refuse('no_samples', `no depth_curve sample at cost cap ${costCapPct}%`)
  }
  if (atCap.length < executable.length) {
    notes.push(
      `${executable.length - atCap.length} depth_curve sample(s) at another cost cap excluded.`,
    )
  }
  const liveMs = atCap[atCap.length - 1].observedAtMs
  const liveRoutes = Array.from(
    new Set(atCap.filter((s) => s.observedAtMs === liveMs).map((s) => s.routeId)),
  ).sort(cmpStr)
  if (liveRoutes.length > 1) {
    return refuse(
      'ambiguous_route',
      `${liveRoutes.length} routes (${liveRoutes.join(', ')}) sampled at the live instant ${iso(liveMs)} at cost cap ${costCapPct}%: the live route is ambiguous — pass one route's samples`,
    )
  }
  const routeId = liveRoutes[0]
  // The series starts strictly after the last instant that carries any other route.
  let breakMs = -Infinity
  for (const s of atCap) if (s.routeId !== routeId) breakMs = s.observedAtMs // ascending
  const segment = atCap.filter((s) => s.observedAtMs > breakMs)
  const excluded = atCap.length - segment.length
  if (excluded > 0) {
    notes.push(
      `Route changed to ${routeId} at ${iso(segment[0].observedAtMs)}: ${excluded} earlier sample(s) excluded (a route change starts a new series).`,
    )
  }

  // -- unknown is unknown: the value and its asOf come from KNOWN samples only
  const known = segment.filter(isKnown)
  if (known.length === 0) {
    return refuse(
      'no_known_sample',
      `all ${segment.length} sample(s) on route ${routeId} are unknown (quote reverted)`,
    )
  }
  const latest = known[known.length - 1]
  const asOfMs = latest.observedAtMs
  const ageMs = opts.nowMs - asOfMs
  const ageHours = ageMs / HOUR_MS
  const trailingUnknown = segment.length - 1 - segment.lastIndexOf(latest)
  if (trailingUnknown > 0) {
    notes.push(
      `The latest ${trailingUnknown} sample(s) are unknown (quote reverted) — not zero and not below anything; the value is named by the latest known sample.`,
    )
  }

  // -- rule 3: freshness
  const maxAgeMs = MEASURED_STALE_CADENCES * cadenceMs
  if (ageMs > maxAgeMs) {
    return refuse(
      'stale',
      `latest known sample is ${fmtH(ageHours)} old; the limit is ${MEASURED_STALE_CADENCES} × cadence = ${fmtH(maxAgeMs / HOUR_MS)}`,
      asOfMs,
    )
  }

  // -- window and coverage (descriptive for 'latest', the gate for 'worst-trailing')
  const windowMs = windowHours * HOUR_MS
  const windowStart = asOfMs - windowMs
  const firstIn = known.findIndex((s) => s.observedAtMs >= windowStart)
  const inWindow = known.slice(firstIn)
  const points = known.slice(Math.max(0, firstIn - 1)).map((s) => s.observedAtMs)
  const covered = coveredMs(points, windowStart, asOfMs, maxGapMs)
  const coverageHours = covered / HOUR_MS
  const sampleCount = instants(inWindow).size
  const knownInstants = instants(known)
  const unknownSampleCount = instants(
    segment.filter(
      (s) =>
        !isKnown(s) &&
        s.observedAtMs >= windowStart &&
        s.observedAtMs <= asOfMs &&
        !knownInstants.has(s.observedAtMs),
    ),
  ).size
  if (unknownSampleCount > 0) {
    notes.push(
      `${unknownSampleCount} unknown sample(s) in the window: not zero, not below any threshold, and not counted as coverage.`,
    )
  }

  // -- rule 4: the two measures
  let value = latest
  if (id === 'worst-trailing') {
    // The ratio, not a rounded threshold (which forgave up to 0.5 ms in the position's
    // favour): covered / windowMs is correctly rounded, so exactly 80% compares equal to
    // MEASURED_MIN_COVERAGE and a shortfall above float resolution compares below it.
    if (covered / windowMs < MEASURED_MIN_COVERAGE) {
      return {
        status: 'insufficient_history',
        id,
        coverageHours,
        sampleCount,
        windowHours,
        requiredCoverageHours: MEASURED_MIN_COVERAGE * windowHours,
        routeId,
        costCapPct,
        asOfMs,
        ageHours,
      }
    }
    for (const s of inWindow) if (s.capacityUsd < value.capacityUsd) value = s
  }
  const exitCapacityUsd = value.capacityUsd

  // -- rule 5: equivalence with the optimistic preset, in the engine's cents
  const equivalentToOptimistic = cents(exitCapacityUsd) >= cents(opts.deployedUsd)
  if (equivalentToOptimistic) {
    notes.push(
      `Measured exit capacity ${fmtUsd(exitCapacityUsd)} >= deployed ${fmtUsd(opts.deployedUsd)}: for this position the measured stock equals the 'optimistic' preset (everything deployed comes back) — the most optimistic case. A scenario capacity cut scales this measured figure, not the deployed amount, so it can leave more than that preset would.`,
    )
  }
  if (id === 'worst-trailing') {
    notes.push(
      'An observed minimum is not a floor and not a freeze: it carries no duration and bounds nothing ahead.',
    )
  }

  const measureText =
    id === 'latest'
      ? 'latest known sample'
      : `minimum of ${sampleCount} known sample(s) over the trailing ${fmtH(windowHours)} (observed ${at(value.observedAtMs, value.block)}; ${fmtH(coverageHours)} covered, gaps > ${fmtH(maxGapMs / HOUR_MS)} uncovered)`
  const provenance = `depth_curve quote capacity at cost <= ${costCapPct}% on route ${routeId}: ${measureText}; as of ${at(asOfMs, latest.block)}.`

  return {
    status: 'measured',
    id,
    exitCapacityUsd,
    costCapPct,
    metric: 'depth_curve',
    routeId,
    asOfMs,
    asOfBlock: latest.block,
    ageHours,
    valueObservedAtMs: value.observedAtMs,
    valueBlock: value.block,
    sampleCount,
    unknownSampleCount,
    coverageHours,
    windowHours,
    deployedUsd: opts.deployedUsd,
    equivalentToOptimistic,
    descriptiveLabel: MEASURED_DESCRIPTIVE_LABEL,
    stressLabel: STRESS_LABEL,
    provenance,
    notes,
  }
}

// ------------------------------------------------------------ engine bridge

/**
 * Apply a measured exit capacity to a stress position (rule 7). Sets `exitCapacityUsd` and
 * removes `exitCapacityPreset` / `exitCapacityMult`, so the measured figure is the only
 * capacity input. A result that is not 'measured' strips every capacity input instead: a
 * carry position with capital deployed then runs not_modelled ('no_exit_capacity'). Never
 * falls back to a preset. Throws on a malformed 'measured' object, or one computed against
 * a different deployedUsd (its equivalentToOptimistic flag would describe another position).
 * Sets no freeze and no duration.
 */
export function withMeasuredCapacity(
  position: StressPosition,
  m: MeasuredCapacityResult,
): StressPosition {
  const out: StressPosition = { ...position }
  delete out.exitCapacityPreset
  delete out.exitCapacityMult
  delete out.exitCapacityUsd
  if (m.status !== 'measured') return out
  if (m.metric !== 'depth_curve' || !(fin(m.exitCapacityUsd) && m.exitCapacityUsd >= 0)) {
    throw new Error(
      'withMeasuredCapacity: a measured capacity must be a finite, non-negative depth_curve figure',
    )
  }
  if (cents(m.deployedUsd) !== cents(Math.max(0, position.deployedUsd ?? 0))) {
    throw new Error(
      `withMeasuredCapacity: measured against deployedUsd ${m.deployedUsd}, applied to a position with ${position.deployedUsd ?? 0}`,
    )
  }
  out.exitCapacityUsd = m.exitCapacityUsd
  return out
}
