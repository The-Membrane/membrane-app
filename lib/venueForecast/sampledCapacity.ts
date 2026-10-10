/**
 * Research projection for a sampled aggregate capacity proxy. The number is
 * never a holder's executable max withdrawal or a promised future exit.
 * No I/O: callers must verify route identity and source receipts separately.
 */

export type CapacityMetric = 'instant_usd' | 'depth_usd' | 'cash_units'

export type CapacitySnapshot = {
  block?: number | null
  observedAt: string
  /** First local receipt, not the chain timestamp. Required for as-of use. */
  firstAvailableAt?: string | null
  capacityUsd: number | null
  /** Physical receipt/hash when available; missing identity is reported. */
  sourceId?: string | null
  coverage?: 'complete' | 'partial' | 'unverified'
}

export type MeasuredCapacityPersistenceInput = {
  venue: string
  routeKey: string
  /** null denotes direct cash; secondary exits require an exact recorded level. */
  costCapPct: number | null
  amountUsd: number
  asOf: string
  cadenceHours: number
  snapshots: readonly CapacitySnapshot[]
}

export type MeasuredCapacityRun = {
  firstObservedAt: string
  lastObservedAt: string
  /** Span between samples, never an assertion about the unsampled path. */
  sampledSpanHours: number
  startCrossing: { after: string; atOrBefore: string } | null
  endCrossing: { after: string; atOrBefore: string } | null
  leftCensored: boolean
  rightCensored: boolean
  leftCensorReason: 'series_start' | 'incomplete_sample' | 'excessive_gap' | null
  /** Crossing bracket for the sampled run; the unsampled path is unknown. */
  sampledRunCrossingBoundsHours: { lower: number; upper: number | null }
}

export type MeasuredCapacityPersistenceResult = {
  status: 'measured_history' | 'unavailable'
  reason: 'invalid_question' | 'invalid_snapshot' | 'no_samples' | null
  claim: 'sampled_capacity_persistence_only'
  forwardForecast: false
  holderExecutable: false
  venue: string
  routeKey: string
  costCapPct: number | null
  amountUsd: number
  asOf: string
  cadenceHours: number
  freshnessHours: number
  currentStatus: 'at_or_above' | 'below' | 'censored' | 'unavailable'
  currentCensorReason:
    | 'incomplete_sample'
    | 'latest_sample_stale'
    | 'latest_capture_failed'
    | 'latest_capture_in_progress'
    | null
  currentRun: MeasuredCapacityRun | null
  longestCompletedRun: MeasuredCapacityRun | null
  sampleShare: { atOrAboveQ: number; complete: number; fraction: number | null }
  coverage: {
    recordedSamples: number
    completeSamples: number
    incompleteSamples: number
    expectedSamples: number
    missingExpectedSamples: number
    completeExpectedSamples: number
    completeFraction: number | null
    excessiveGaps: number
    completedRuns: number
    leftCensoredEndedRuns: number
    gapCensoredRuns: number
    incompleteCensoredRuns: number
    firstObservedAt: string | null
    lastObservedAt: string | null
    sampledSpanHours: number | null
  }
  /** Chronological samples of this exact venue/route/cost-cap series. */
  series: Array<{
    observedAt: string
    firstAvailableAt: string | null
    sourceId: string | null
    capacityUsd: number | null
    complete: boolean
    atOrAboveQ: boolean | null
  }>
}

export type CapacityForecastInput = {
  routeKey: string
  metric: CapacityMetric
  amountUsd: number
  horizonHours: number
  asOf: string
  /** Predeclared chronological development/holdout boundary. */
  splitAt?: string
  snapshots: readonly CapacitySnapshot[]
  maxGapHours?: number
  maxTargetOffsetHours?: number
  maxObservationAgeHours?: number
}

export type CapacityForecastReason =
  | 'invalid_question'
  | 'invalid_snapshot'
  | 'duplicate_observation'
  | 'source_clock_missing'
  | 'source_identity_missing'
  | 'no_current_observation'
  | 'current_observation_stale'
  | 'insufficient_fit'
  | 'insufficient_calibration'
  | 'insufficient_holdout'
  | 'inadequate_holdout_coverage'
  | 'no_holdout_lift_over_persistence'

export type CapacitySourceSpan = {
  firstObservedAt: string | null
  lastObservedAt: string | null
  completeSnapshots: number
  incompleteSnapshots: number
  firstSourceId: string | null
  lastSourceId: string | null
}

export type CapacityBacktest = {
  splitAt: string
  embargoHours: number
  fit: {
    eligible: number
    censored: number
    firstIssuedAt: string | null
    lastIssuedAt: string | null
  }
  calibration: {
    eligible: number
    censored: number
    firstIssuedAt: string | null
    lastIssuedAt: string | null
  }
  holdout: {
    eligible: number
    censored: number
    firstIssuedAt: string | null
    lastIssuedAt: string | null
    bandCoverage: number | null
    modelMaeUsd: number | null
    persistenceMaeUsd: number | null
    belowAmountEvents: number
    atOrAboveAmountControls: number
  }
}

export type CapacityForecastResult = {
  status: 'research_projection' | 'abstain'
  reason: CapacityForecastReason | null
  /** This model measures a proxy and cannot validate a holder exit or alert. */
  claim: 'sampled_capacity_proxy_only'
  holderExecutable: false
  predictiveAlertEligible: false
  routeKey: string
  metric: CapacityMetric
  amountUsd: number
  horizonHours: number
  asOf: string
  current: {
    capacityUsd: number
    observedAt: string
    firstAvailableAt: string
    sourceId: string
  } | null
  projection: {
    targetAt: string
    method: 'historical_delta' | 'persistence'
    capacityUsd: number
    bandLowUsd: number
    bandHighUsd: number
    bandLevel: 0.9
    persistenceUsd: number
    /** Classification of the whole band at the requested amount, not an exit assertion. */
    relativeToAmount: 'below' | 'at_or_above' | 'uncertain'
  } | null
  sourceSpan: CapacitySourceSpan
  backtest: CapacityBacktest
  duration: {
    observedEpisodes: number
    completed: number
    leftCensored: number
    rightCensored: number
    gapCensored: number
    maxCompletedObservedSpanHours: number | null
    durationForecast: { status: 'unavailable'; reason: 'recovery_validation_missing' }
  }
}

type Row = CapacitySnapshot & { t: number; a: number; value: number | null; source: string }
type ValidRow = Row & { value: number }
type Pair = { issue: ValidRow; outcome: ValidRow; delta: number }
type Bucket = { eligible: Pair[]; censoredAt: number[] }

const HOUR = 3_600_000
const MIN_SAMPLES = 20

const validTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}
const iso = (t: number): string => new Date(t).toISOString()
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * q
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}
const describe = (pairs: readonly Pair[], censored: number) => ({
  eligible: pairs.length,
  censored,
  firstIssuedAt: pairs.length ? iso(pairs[0].issue.a) : null,
  lastIssuedAt: pairs.length ? iso(pairs[pairs.length - 1].issue.a) : null,
})

/** Retrospective sampled runs at >= Q. This never estimates a future lifetime. */
export function measureSampledCapacityPersistence(
  input: MeasuredCapacityPersistenceInput,
): MeasuredCapacityPersistenceResult {
  const result: MeasuredCapacityPersistenceResult = {
    status: 'unavailable',
    reason: 'invalid_question',
    claim: 'sampled_capacity_persistence_only',
    forwardForecast: false,
    holderExecutable: false,
    venue: input.venue,
    routeKey: input.routeKey,
    costCapPct: input.costCapPct,
    amountUsd: input.amountUsd,
    asOf: input.asOf,
    cadenceHours: input.cadenceHours,
    freshnessHours: 2 * input.cadenceHours,
    currentStatus: 'unavailable',
    currentCensorReason: null,
    currentRun: null,
    longestCompletedRun: null,
    sampleShare: { atOrAboveQ: 0, complete: 0, fraction: null },
    coverage: {
      recordedSamples: 0,
      completeSamples: 0,
      incompleteSamples: 0,
      expectedSamples: 0,
      missingExpectedSamples: 0,
      completeExpectedSamples: 0,
      completeFraction: null,
      excessiveGaps: 0,
      completedRuns: 0,
      leftCensoredEndedRuns: 0,
      gapCensoredRuns: 0,
      incompleteCensoredRuns: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      sampledSpanHours: null,
    },
    series: [],
  }
  const asOfMs = validTime(input.asOf)
  if (
    !input.venue ||
    !input.routeKey ||
    asOfMs === null ||
    !Number.isFinite(input.amountUsd) ||
    input.amountUsd <= 0 ||
    !Number.isFinite(input.cadenceHours) ||
    input.cadenceHours <= 0 ||
    (input.costCapPct !== null && (!Number.isFinite(input.costCapPct) || input.costCapPct < 0))
  )
    return result
  const cadenceMs = input.cadenceHours * HOUR
  const maxGapMs = 2 * cadenceMs
  const rows = input.snapshots.map((snapshot) => ({
    snapshot,
    t: validTime(snapshot.observedAt),
    a: validTime(snapshot.firstAvailableAt),
  }))
  // An unplaceable recorded failure cannot be discarded across a current run.
  if (rows.some((row) => row.t === null)) return { ...result, reason: 'invalid_snapshot' }
  const known = rows
    .filter((row) => row.t! <= asOfMs && (row.a === null || row.a <= asOfMs))
    .sort((a, b) => a.t! - b.t!)
  if (!known.length) return { ...result, reason: 'no_samples' }
  const timeCounts = new Map<number, number>()
  const sourceCounts = new Map<string, number>()
  for (const row of known) {
    timeCounts.set(row.t!, (timeCounts.get(row.t!) ?? 0) + 1)
    if (row.snapshot.sourceId)
      sourceCounts.set(row.snapshot.sourceId, (sourceCounts.get(row.snapshot.sourceId) ?? 0) + 1)
  }
  result.status = 'measured_history'
  result.reason = null
  result.series = known.map(({ snapshot, t, a }) => {
    const complete =
      snapshot.coverage === 'complete' &&
      typeof snapshot.capacityUsd === 'number' &&
      Number.isFinite(snapshot.capacityUsd) &&
      snapshot.capacityUsd >= 0 &&
      a !== null &&
      a >= t! &&
      a - t! <= maxGapMs &&
      !!snapshot.sourceId &&
      sourceCounts.get(snapshot.sourceId) === 1 &&
      timeCounts.get(t!) === 1
    return {
      observedAt: iso(t!),
      firstAvailableAt: a === null ? null : iso(a),
      sourceId: snapshot.sourceId ?? null,
      capacityUsd: complete ? snapshot.capacityUsd : null,
      complete,
      atOrAboveQ: complete ? snapshot.capacityUsd! >= input.amountUsd : null,
    }
  })
  const firstMs = known[0].t!
  const lastMs = known[known.length - 1].t!
  // The hourly job has a half-cadence total runtime budget. Align samples to
  // their nearest declared slot so stage timing drift does not invent gaps.
  const cadenceSlot = (at: number) => Math.round((at - firstMs) / cadenceMs)
  const recordedSlots = new Set<number>()
  const completeSlots = new Set<number>()
  for (const sample of result.series) {
    // The declared cadence grid starts at the first returned physical sample.
    // Empty slots (including overdue latest slots) remain in the denominator.
    const slot = cadenceSlot(Date.parse(sample.observedAt))
    recordedSlots.add(slot)
    if (sample.complete) completeSlots.add(slot)
  }
  const expectedSamples =
    Math.max(cadenceSlot(lastMs), Math.floor((asOfMs - firstMs) / cadenceMs)) + 1
  const completeSamples = result.series.filter((sample) => sample.complete).length
  const atOrAboveQ = result.series.filter((sample) => sample.atOrAboveQ === true).length
  result.sampleShare = {
    atOrAboveQ,
    complete: completeSamples,
    fraction: completeSamples ? atOrAboveQ / completeSamples : null,
  }
  Object.assign(result.coverage, {
    recordedSamples: result.series.length,
    completeSamples,
    incompleteSamples: result.series.length - completeSamples,
    expectedSamples,
    missingExpectedSamples: expectedSamples - recordedSlots.size,
    completeExpectedSamples: completeSlots.size,
    completeFraction: completeSlots.size / expectedSamples,
    firstObservedAt: iso(firstMs),
    lastObservedAt: iso(lastMs),
    sampledSpanHours: (lastMs - firstMs) / HOUR,
  })
  let run: MeasuredCapacityRun | null = null
  let prior: MeasuredCapacityPersistenceResult['series'][number] | null = null
  for (const sample of result.series) {
    const gap =
      prior &&
      (Date.parse(sample.observedAt) - Date.parse(prior.observedAt) >= maxGapMs ||
        cadenceSlot(Date.parse(sample.observedAt)) - cadenceSlot(Date.parse(prior.observedAt)) > 1)
    if (gap) {
      result.coverage.excessiveGaps++
      if (run) result.coverage.gapCensoredRuns++
      run = null
    }
    if (!sample.complete) {
      if (run) result.coverage.incompleteCensoredRuns++
      run = null
    } else if (sample.atOrAboveQ) {
      if (!run) {
        const boundedStart = prior?.complete && prior.atOrAboveQ === false && !gap
        run = {
          firstObservedAt: sample.observedAt,
          lastObservedAt: sample.observedAt,
          sampledSpanHours: 0,
          startCrossing: boundedStart
            ? { after: prior.observedAt, atOrBefore: sample.observedAt }
            : null,
          endCrossing: null,
          leftCensored: !boundedStart,
          rightCensored: true,
          leftCensorReason: boundedStart
            ? null
            : gap
              ? 'excessive_gap'
              : prior
                ? 'incomplete_sample'
                : 'series_start',
          sampledRunCrossingBoundsHours: { lower: 0, upper: null },
        }
      } else {
        run.lastObservedAt = sample.observedAt
        run.sampledSpanHours =
          (Date.parse(sample.observedAt) - Date.parse(run.firstObservedAt)) / HOUR
        run.sampledRunCrossingBoundsHours.lower = run.sampledSpanHours
      }
    } else if (run) {
      run.rightCensored = false
      run.endCrossing = { after: run.lastObservedAt, atOrBefore: sample.observedAt }
      run.sampledRunCrossingBoundsHours.upper = run.startCrossing
        ? (Date.parse(sample.observedAt) - Date.parse(run.startCrossing.after)) / HOUR
        : null
      if (run.leftCensored) result.coverage.leftCensoredEndedRuns++
      else {
        result.coverage.completedRuns++
        if (
          !result.longestCompletedRun ||
          run.sampledSpanHours > result.longestCompletedRun.sampledSpanHours
        )
          result.longestCompletedRun = run
      }
      run = null
    }
    prior = sample
  }
  const latest = result.series[result.series.length - 1]
  if (!latest.complete) {
    result.currentStatus = 'censored'
    result.currentCensorReason = 'incomplete_sample'
  } else if (asOfMs - lastMs > maxGapMs) {
    result.currentStatus = 'censored'
    result.currentCensorReason = 'latest_sample_stale'
  } else {
    result.currentStatus = latest.atOrAboveQ ? 'at_or_above' : 'below'
    result.currentRun = run
  }
  return result
}

function pairsFor(
  rows: readonly Row[],
  from: number,
  through: number,
  horizonMs: number,
  maxGapMs: number,
  maxTargetOffsetMs: number,
  maxAgeMs: number,
  outcomeAvailableBy: number,
): Bucket {
  const eligible: Pair[] = []
  const censoredAt: number[] = []
  let nextIssue = from
  for (let i = 0; i < rows.length; i++) {
    const issue = rows[i]
    if (
      issue.coverage !== 'complete' ||
      issue.value === null ||
      issue.a < nextIssue ||
      issue.a > through ||
      issue.a - issue.t > maxAgeMs
    )
      continue
    // One target window per independent sampled interval, including censored
    // windows. Repeated snapshots inside H do not create new controls.
    nextIssue = issue.a + horizonMs
    // The measured value belongs to the finalized block at issue.t. Receipt
    // time gates availability, but must not shift the physical change interval.
    const target = issue.t + horizonMs
    let best: Row | null = null
    let bestIndex = -1
    for (let j = i + 1; j < rows.length && rows[j].t <= target + maxTargetOffsetMs; j++) {
      const row = rows[j]
      if (row.t <= issue.a) continue
      if (row.a > outcomeAvailableBy) continue
      if (
        Math.abs(row.t - target) <= maxTargetOffsetMs &&
        (!best || Math.abs(row.t - target) < Math.abs(best.t - target))
      ) {
        best = row
        bestIndex = j
      }
    }
    if (!best || best.coverage !== 'complete' || best.value === null) {
      censoredAt.push(issue.a)
      continue
    }
    let prior = issue.t
    let pathComplete = true
    for (let j = i + 1; j <= bestIndex; j++) {
      const row = rows[j]
      if (row.t <= issue.a) continue
      const okay =
        row.coverage === 'complete' &&
        row.value !== null &&
        row.a <= outcomeAvailableBy &&
        row.a - row.t <= maxAgeMs &&
        row.t - prior <= maxGapMs
      prior = row.t
      if (!okay) {
        pathComplete = false
        break
      }
    }
    if (!pathComplete || best.t - prior > maxGapMs) {
      censoredAt.push(issue.a)
      continue
    }
    eligible.push({
      issue: issue as ValidRow,
      outcome: best as ValidRow,
      delta: best.value - issue.value,
    })
  }
  return { eligible, censoredAt }
}

function observedDurations(
  rows: readonly Row[],
  amountUsd: number,
  maxGapMs: number,
): CapacityForecastResult['duration'] {
  let observedEpisodes = 0
  let completed = 0
  let leftCensored = 0
  let rightCensored = 0
  let gapCensored = 0
  let maxCompletedObservedSpanHours: number | null = null
  let firstBad: number | null = null
  let previous: Row | null = null
  let left = false
  for (const row of rows) {
    if (
      row.coverage !== 'complete' ||
      row.value === null ||
      (previous && row.t - previous.t > maxGapMs)
    ) {
      if (firstBad !== null) {
        gapCensored++
        firstBad = null
      }
      previous = null
      if (row.coverage !== 'complete' || row.value === null) continue
    }
    if (row.value === null) continue
    if (row.value < amountUsd) {
      if (firstBad === null) {
        observedEpisodes++
        firstBad = row.t
        left = previous === null
        if (left) leftCensored++
      }
    } else if (firstBad !== null) {
      if (!left) {
        completed++
        const span = (previous!.t - firstBad) / HOUR
        maxCompletedObservedSpanHours = Math.max(maxCompletedObservedSpanHours ?? 0, span)
      }
      firstBad = null
    }
    previous = row
  }
  if (firstBad !== null) rightCensored++
  return {
    observedEpisodes,
    completed,
    leftCensored,
    rightCensored,
    gapCensored,
    maxCompletedObservedSpanHours,
    durationForecast: { status: 'unavailable', reason: 'recovery_validation_missing' },
  }
}

/** Fixed historical-delta model with train-only empirical 90% residual band. */
export function forecastSampledCapacity(input: CapacityForecastInput): CapacityForecastResult {
  const asOf = validTime(input.asOf)
  const validSnapshotTimes = input.snapshots
    .filter((row) => {
      const available = validTime(row.firstAvailableAt)
      return asOf !== null && available !== null && available <= asOf
    })
    .map((row) => validTime(row.observedAt))
    .filter((t): t is number => t !== null && asOf !== null && t <= asOf)
    .sort((a, b) => a - b)
  const split =
    input.splitAt === undefined
      ? validSnapshotTimes.length >= 2
        ? validSnapshotTimes[0] +
          (validSnapshotTimes[validSnapshotTimes.length - 1] - validSnapshotTimes[0]) * 0.7
        : null
      : validTime(input.splitAt)
  const H = input.horizonHours * HOUR
  // A one-hour question can use complete hourly samples. Coarser sources
  // still censor because their observed gap exceeds the requested horizon.
  const maxGap = (input.maxGapHours ?? Math.min(6, input.horizonHours)) * HOUR
  const targetOffset = (input.maxTargetOffsetHours ?? Math.min(3, input.horizonHours / 4)) * HOUR
  const maxAge = (input.maxObservationAgeHours ?? maxGap / HOUR) * HOUR
  const emptySpan: CapacitySourceSpan = {
    firstObservedAt: null,
    lastObservedAt: null,
    completeSnapshots: 0,
    incompleteSnapshots: 0,
    firstSourceId: null,
    lastSourceId: null,
  }
  const emptyBacktest: CapacityBacktest = {
    splitAt: split === null ? 'unavailable' : iso(split),
    embargoHours: input.horizonHours,
    fit: describe([], 0),
    calibration: describe([], 0),
    holdout: {
      ...describe([], 0),
      bandCoverage: null,
      modelMaeUsd: null,
      persistenceMaeUsd: null,
      belowAmountEvents: 0,
      atOrAboveAmountControls: 0,
    },
  }
  const base: CapacityForecastResult = {
    status: 'abstain',
    reason: null,
    claim: 'sampled_capacity_proxy_only',
    holderExecutable: false,
    predictiveAlertEligible: false,
    routeKey: input.routeKey,
    metric: input.metric,
    amountUsd: input.amountUsd,
    horizonHours: input.horizonHours,
    asOf: input.asOf,
    current: null,
    projection: null,
    sourceSpan: emptySpan,
    backtest: emptyBacktest,
    duration: {
      observedEpisodes: 0,
      completed: 0,
      leftCensored: 0,
      rightCensored: 0,
      gapCensored: 0,
      maxCompletedObservedSpanHours: null,
      durationForecast: { status: 'unavailable', reason: 'recovery_validation_missing' },
    },
  }
  const fail = (reason: CapacityForecastReason): CapacityForecastResult => ({ ...base, reason })
  if (
    !input.routeKey ||
    !['instant_usd', 'depth_usd', 'cash_units'].includes(input.metric) ||
    !Number.isFinite(input.amountUsd) ||
    input.amountUsd <= 0 ||
    !Number.isFinite(input.horizonHours) ||
    input.horizonHours < 1 ||
    input.horizonHours > 720 ||
    asOf === null ||
    !Number.isFinite(maxGap) ||
    maxGap <= 0 ||
    !Number.isFinite(targetOffset) ||
    targetOffset < 0 ||
    !Number.isFinite(maxAge) ||
    maxAge < 0
  )
    return fail('invalid_question')

  const rows: Row[] = []
  for (const snapshot of input.snapshots) {
    const t = validTime(snapshot.observedAt)
    if (
      t === null ||
      (snapshot.capacityUsd !== null &&
        (typeof snapshot.capacityUsd !== 'number' ||
          !Number.isFinite(snapshot.capacityUsd) ||
          snapshot.capacityUsd < 0)) ||
      (snapshot.block != null && (!Number.isSafeInteger(snapshot.block) || snapshot.block <= 0))
    )
      return fail('invalid_snapshot')
    const a = validTime(snapshot.firstAvailableAt)
    if (a === null) return fail('source_clock_missing')
    if (a < t) return fail('invalid_snapshot')
    if (!snapshot.sourceId) return fail('source_identity_missing')
    if (!['complete', 'partial', 'unverified'].includes(snapshot.coverage ?? 'unverified'))
      return fail('invalid_snapshot')
    if (a <= asOf)
      rows.push({ ...snapshot, t, a, value: snapshot.capacityUsd, source: snapshot.sourceId })
  }
  rows.sort((a, b) => a.t - b.t || a.a - b.a)
  if (rows.some((row, i) => i > 0 && row.t === rows[i - 1].t)) return fail('duplicate_observation')
  const complete = rows.filter((row) => row.coverage === 'complete' && row.value !== null)
  base.duration = observedDurations(rows, input.amountUsd, maxGap)
  base.sourceSpan = {
    firstObservedAt: rows.length ? iso(rows[0].t) : null,
    lastObservedAt: rows.length ? iso(rows[rows.length - 1].t) : null,
    completeSnapshots: complete.length,
    incompleteSnapshots: rows.length - complete.length,
    firstSourceId: rows.length ? rows[0].source : null,
    lastSourceId: rows.length ? rows[rows.length - 1].source : null,
  }
  const newest = rows.filter((row) => row.t <= asOf).at(-1)
  const current = newest?.coverage === 'complete' && newest.value !== null ? newest : null
  if (!current) return { ...base, reason: 'no_current_observation' }
  const currentValue = current.value as number
  base.current = {
    capacityUsd: currentValue,
    observedAt: iso(current.t),
    firstAvailableAt: iso(current.a),
    sourceId: current.source,
  }
  if (asOf - current.t > maxAge) return { ...base, reason: 'current_observation_stale' }
  // A newly enrolled route has a valid current reading but no chronological
  // development/holdout boundary yet. Keep the reading and abstain on history.
  if (split === null) return { ...base, reason: 'insufficient_fit' }
  // The user's horizon starts at asOf, while the newest source can be older.
  // Train and score the full source-to-target interval rather than applying an
  // H-hour historical change to an older source and labeling it asOf + H.
  const sourceToTarget = H + (asOf - current.t)

  const cleanRows = rows.filter((row) => row.a <= asOf)
  const dev = pairsFor(
    cleanRows,
    -Infinity,
    split - sourceToTarget,
    sourceToTarget,
    maxGap,
    targetOffset,
    maxAge,
    split,
  )
  const fitCount = Math.floor(dev.eligible.length * 0.7)
  const fit = dev.eligible.slice(0, fitCount)
  const calibration = dev.eligible.slice(fitCount)
  const fitBoundary = fit.at(-1)?.issue.a ?? -Infinity
  const holdout = pairsFor(
    cleanRows,
    split + sourceToTarget,
    asOf - sourceToTarget - targetOffset,
    sourceToTarget,
    maxGap,
    targetOffset,
    maxAge,
    asOf,
  )
  base.backtest = {
    splitAt: iso(split),
    embargoHours: sourceToTarget / HOUR,
    fit: describe(fit, dev.censoredAt.filter((t) => t <= fitBoundary).length),
    calibration: describe(calibration, dev.censoredAt.filter((t) => t > fitBoundary).length),
    holdout: {
      ...describe(holdout.eligible, holdout.censoredAt.length),
      bandCoverage: null,
      modelMaeUsd: null,
      persistenceMaeUsd: null,
      belowAmountEvents: holdout.eligible.filter((pair) => pair.outcome.value < input.amountUsd)
        .length,
      atOrAboveAmountControls: holdout.eligible.filter(
        (pair) => pair.outcome.value >= input.amountUsd,
      ).length,
    },
  }
  if (fit.length < MIN_SAMPLES) return { ...base, reason: 'insufficient_fit' }
  if (calibration.length < MIN_SAMPLES) return { ...base, reason: 'insufficient_calibration' }
  const candidateDelta = median(fit.map((pair) => pair.delta))
  const candidateCalibrationMae = calibration.reduce(
    (sum, pair) => sum + Math.abs(pair.delta - candidateDelta),
    0,
  )
  const persistenceCalibrationMae = calibration.reduce((sum, pair) => sum + Math.abs(pair.delta), 0)
  const method =
    candidateCalibrationMae < persistenceCalibrationMae ? 'historical_delta' : 'persistence'
  const learnedDelta = method === 'historical_delta' ? candidateDelta : 0
  const residuals = calibration.map((pair) => pair.delta - learnedDelta)
  const lowResidual = quantile(residuals, 0.05)
  const highResidual = quantile(residuals, 0.95)
  if (holdout.eligible.length < MIN_SAMPLES) return { ...base, reason: 'insufficient_holdout' }
  const holdoutCoverage =
    holdout.eligible.filter(
      (pair) =>
        pair.delta - learnedDelta >= lowResidual && pair.delta - learnedDelta <= highResidual,
    ).length / holdout.eligible.length
  const modelMae =
    holdout.eligible.reduce((sum, pair) => sum + Math.abs(pair.delta - learnedDelta), 0) /
    holdout.eligible.length
  const baselineMae =
    holdout.eligible.reduce((sum, pair) => sum + Math.abs(pair.delta), 0) / holdout.eligible.length
  base.backtest.holdout.bandCoverage = holdoutCoverage
  base.backtest.holdout.modelMaeUsd = modelMae
  base.backtest.holdout.persistenceMaeUsd = baselineMae
  if (holdoutCoverage < 0.8) return { ...base, reason: 'inadequate_holdout_coverage' }
  if (method === 'historical_delta' && modelMae >= baselineMae)
    return { ...base, reason: 'no_holdout_lift_over_persistence' }
  const capacity = Math.max(0, currentValue + learnedDelta)
  const low = Math.max(0, currentValue + learnedDelta + lowResidual)
  const high = Math.max(low, currentValue + learnedDelta + highResidual)
  return {
    ...base,
    status: 'research_projection',
    reason: null,
    projection: {
      targetAt: iso(asOf + H),
      method,
      capacityUsd: capacity,
      bandLowUsd: low,
      bandHighUsd: high,
      bandLevel: 0.9,
      persistenceUsd: currentValue,
      relativeToAmount:
        high < input.amountUsd ? 'below' : low >= input.amountUsd ? 'at_or_above' : 'uncertain',
    },
  }
}
