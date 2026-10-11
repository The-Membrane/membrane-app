import type { LocalHistoricalCashScenario } from '@/lib/carry/localHistoricalCashScenario'
import {
  selectedHistoricalCompetingFlowEstimate,
  type ExpectedCompetingFlow,
} from '@/lib/carry/historicalCompetingFlowEstimate'
import {
  projectHistoricalCash,
  type HistoricalCashPair,
  type HistoricalCashProjectionReason,
} from '@/lib/carry/historicalCashProjection'

export type ExitImpactIdentity = {
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
}

export type ExitImpactEvidenceGap =
  | {
      status: 'unavailable'
      reason: 'prospective_holder_outcomes_missing'
    }
  | {
      status: 'unavailable'
      reason: 'endpoint_history_has_no_crossing_or_recovery_time'
    }
  | {
      status: 'unavailable'
      reason: 'already_embedded_in_net_cash_endpoints'
    }
  | {
      status: 'unavailable'
      reason: 'no_causal_news_event_model'
    }

export type ExitImpactDuration =
  | {
      status: 'unavailable'
      reason:
        | 'endpoint_history_has_no_crossing_or_recovery_time'
        | 'verified_daily_duration_timeline_unavailable'
        | 'no_completed_sampled_below_q_runs'
    }
  | {
      status: 'historical_interval_outlook'
      claim: 'aggregate_endpoint_cash_proxy_only'
      intervalCensored: true
      prospectiveValidated: false
      holderExecutableExit: false
      requestedRaw: string
      observations: number
      observedBelowQSamples: number
      timelineSegments: number
      verifiedTimelineCoverageSeconds: number
      samplingCadenceSeconds: 86_400
      samplingToleranceSeconds: 5_400
      interpretation: 'completed_sampled_below_q_runs_with_censored_observed_spans'
      sampledRuns: number
      completedSampledRuns: number
      leftCensoredRuns: number
      rightCensoredRuns: number
      bothBoundaryCensoredRuns: number
      completedSampledRunDurationSeconds: {
        median: { low: number; high: number }
        p90: { low: number; high: number }
        longest: { low: number; high: number }
      } | null
      censoredRunObservedSpanLowerBoundSeconds: {
        leftLongest: number | null
        rightLongest: number | null
      }
    }

export type AbsoluteQBacktestReason =
  | 'invalid_question'
  | 'subject_mismatch'
  | 'malformed_history'
  | 'overlapping_history'
  | 'insufficient_history'

export type AbsoluteQSignalReason =
  | 'insufficient_outcome_support'
  | 'unstable_calibration'
  | 'no_skill_over_persistence'

type CountFraction = { numerator: number; denominator: number }
type BrierScore = { numerator: string; denominator: number }
type BacktestCounts = { total: number; fit: number; calibration: number; holdout: number }

export type AbsoluteQEndpointBacktest =
  | {
      status: 'unavailable'
      reason: AbsoluteQBacktestReason
      counts: BacktestCounts
    }
  | {
      status: 'historical_backtest'
      reason: null
      claim: 'aggregate_endpoint_cash_proxy_only'
      historicalBacktestOnly: true
      prospectiveValidated: false
      holderExecutableExit: false
      requestedRaw: string
      counts: BacktestCounts
      outcomes: {
        fitBelowQ: CountFraction
        calibrationBelowQ: CountFraction
        holdoutBelowQ: CountFraction
      }
      scoring: {
        method: 'fit_absolute_q_breach_frequency'
        calibrationBrier: BrierScore
        calibrationPersistenceBrier: BrierScore
        holdoutBrier: BrierScore
        holdoutPersistenceBrier: BrierScore
        calibrationStable: boolean
        calibrationBeatsPersistence: boolean
        holdoutBeatsPersistence: boolean
      }
      retrospectiveSignal:
        | { status: 'supported'; reason: null }
        | { status: 'unavailable'; reason: AbsoluteQSignalReason }
    }

export type ExitImpactCashBand =
  | {
      status: 'unavailable'
      reason: HistoricalCashProjectionReason | 'invalid_scenario'
    }
  | {
      status: 'available'
      evidence: 'retrospective_backtest' | 'historical_conditional_projection'
      modelKind: 'endpoint_net_cash_band'
      flowTreatment: 'all_aggregate_flow_already_included'
      method: 'learned_delta' | 'persistence_band'
      targetAt: string
      capacityRaw: { low: string; point: string; high: string }
      expectedNetFlowRaw: { low: string; point: string; high: string }
      marginAfterQRaw: { low: string; point: string; high: string }
      projectedState: 'band_covers_q' | 'band_crosses_q' | 'band_below_q'
      direction: 'shrinking' | 'flat' | 'growing' | 'unassessed'
      holdout: {
        fit: number
        calibration: number
        selection: number
        selectionCovered: number
        holdout: number
        covered: number
        coveragePassed: boolean
        pointBeatsPersistence: boolean | null
        modelMae: { numeratorRaw: string; denominator: number } | null
        persistenceMae: { numeratorRaw: string; denominator: number } | null
      }
    }

type ExitImpactCommon = {
  schemaVersion: 1
  identity: ExitImpactIdentity
  question: { requestedRaw: string; horizonHours: 1 | 24 }
  claimClass: 'route_proxy'
  holderExecutableExit: false
  prospectiveValidated: false
  forecastValidated: false
  probabilityQExecutable: {
    status: 'unavailable'
    reason: 'prospective_holder_outcomes_missing'
  }
  duration: ExitImpactDuration
  expectedCompetingFlow: ExpectedCompetingFlow
  newsImpact: {
    status: 'unavailable'
    reason: 'no_causal_news_event_model'
  }
}

export type ExitImpactForecast =
  | (ExitImpactCommon & {
      status: 'unavailable'
      analysisKind: 'retrospective_backtest' | 'conditional_live_projection'
      reason:
        | 'invalid_identity'
        | 'invalid_question'
        | 'source_unavailable'
        | AbsoluteQBacktestReason
      sourceReason?: string
    })
  | (ExitImpactCommon & {
      status: 'historical_backtest'
      analysisKind: 'retrospective_backtest'
      reference: {
        basis: 'historical_tail_endpoint'
        at: string
        cashRaw: string
        marginAfterQRaw: string
        state: 'cash_covers_q' | 'cash_below_q'
      }
      absoluteQBacktest: Extract<AbsoluteQEndpointBacktest, { status: 'historical_backtest' }>
      cashBand: ExitImpactCashBand
      alert: { status: 'unavailable'; reason: 'retrospective_only' }
    })
  | (ExitImpactCommon & {
      status: 'research_projection'
      analysisKind: 'conditional_live_projection'
      reference: {
        basis: 'scenario_current_endpoint'
        at: string
        cashRaw: string
        marginAfterQRaw: string
        state: 'cash_covers_q' | 'cash_below_q'
      }
      absoluteQBacktest: null
      cashBand: Extract<ExitImpactCashBand, { status: 'available' }>
      alert:
        | { status: 'estimated'; kind: 'projected_shrink' }
        | {
            status: 'unavailable'
            reason: 'threshold_not_crossed_by_shrinking_band' | 'untouched_test_not_qualified'
          }
    })

export type ExitImpactForecastInput =
  | {
      kind: 'retrospective_backtest'
      identity: ExitImpactIdentity
      requestedRaw: string
      horizonHours: 1 | 24
      pairs: readonly HistoricalCashPair[]
      dailyTimeline?: readonly HistoricalCashTimelineObservation[]
    }
  | {
      kind: 'conditional_projection'
      identity: ExitImpactIdentity
      requestedRaw: string
      horizonHours: 1 | 24
      scenario: LocalHistoricalCashScenario
    }

/** Attach historical flow context independently of cash-model qualification; never change its arithmetic. */
export function withHistoricalCompetingFlow(
  forecast: ExitImpactForecast | null,
  estimate: ExpectedCompetingFlow,
  hash: (serialized: string) => string,
): ExitImpactForecast | null {
  if (!forecast) return null
  const selected = selectedHistoricalCompetingFlowEstimate(estimate, forecast.identity, hash)
  return selected ? { ...forecast, expectedCompetingFlow: selected } : forecast
}

const RAW = /^(0|[1-9][0-9]*)$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_RAW = (1n << 256n) - 1n
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const DAILY_TOLERANCE_MS = 90 * 60_000

export type HistoricalCashTimelineObservation = {
  subjectKey: string
  at: string
  cashRaw: string
}

function raw(value: unknown): bigint | null {
  if (typeof value !== 'string' || !RAW.test(value) || value.length > 78) return null
  const parsed = BigInt(value)
  return parsed <= MAX_RAW ? parsed : null
}

function at(value: unknown): number | null {
  if (typeof value !== 'string' || !UTC.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value ? parsed : null
}

function validIdentity(identity: ExitImpactIdentity): boolean {
  return (
    typeof identity?.routeKey === 'string' &&
    Boolean(identity.routeKey.trim()) &&
    identity.routeKey.length <= 512 &&
    typeof identity.destination === 'string' &&
    Boolean(identity.destination.trim()) &&
    identity.destination.length <= 512 &&
    typeof identity.asset === 'string' &&
    Boolean(identity.asset.trim()) &&
    identity.asset.length <= 512 &&
    Number.isSafeInteger(identity.assetDecimals) &&
    identity.assetDecimals >= 0 &&
    identity.assetDecimals <= 255
  )
}

function subjectKey(identity: ExitImpactIdentity): string {
  return `${identity.routeKey}\0${identity.destination}\0${identity.asset}`
}

function counts(total: number): BacktestCounts {
  const fit = Math.floor(total / 3)
  const calibration = Math.floor(total / 3)
  return { total, fit, calibration, holdout: total - fit - calibration }
}

function brier(events: readonly boolean[], numerator: number, denominator: number): BrierScore {
  let error = 0n
  for (const event of events) {
    const difference = BigInt(event ? denominator - numerator : numerator)
    error += difference * difference
  }
  return { numerator: error.toString(), denominator: events.length * denominator * denominator }
}

function persistenceBrier(
  outcomes: readonly boolean[],
  sourceStates: readonly boolean[],
  scale: number,
): BrierScore {
  let misses = 0
  for (let index = 0; index < outcomes.length; index++) {
    if (outcomes[index] !== sourceStates[index]) misses++
  }
  return {
    numerator: (BigInt(misses) * BigInt(scale) ** 2n).toString(),
    denominator: outcomes.length * scale * scale,
  }
}

function enoughOutcomes(events: readonly boolean[]): boolean {
  const below = events.filter(Boolean).length
  return below >= 5 && events.length - below >= 5
}

function nearestRank(values: readonly number[], numerator: number, denominator: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((sorted.length * numerator) / denominator) - 1)]
}

function historicalQDuration(
  pairs: readonly HistoricalCashPair[],
  timeline: readonly HistoricalCashTimelineObservation[] | undefined,
  requested: bigint,
): ExitImpactDuration {
  // These brackets describe spans of consecutive sampled below-Q states.
  // Cash may recover and fall again between samples; neither bracket is a
  // continuous cash-impairment or holder-exit restriction duration.
  if (!Array.isArray(timeline) || timeline.length !== pairs.length * 2)
    return { status: 'unavailable', reason: 'verified_daily_duration_timeline_unavailable' }
  const observations: { at: number; below: boolean }[] = []
  for (let index = 0; index < timeline.length; index++) {
    const observation = timeline[index]
    const pair = pairs[Math.floor(index / 2)]
    const observedAt = at(observation?.at)
    const observedCash = raw(observation?.cashRaw)
    if (
      observedAt === null ||
      observedCash === null ||
      observation?.subjectKey !== pair.subjectKey ||
      observation.at !== (index % 2 === 0 ? pair.sourceAt : pair.targetAt) ||
      observation.cashRaw !== (index % 2 === 0 ? pair.sourceCashRaw : pair.targetCashRaw) ||
      (index > 0 && observedAt <= observations[index - 1].at)
    )
      return { status: 'unavailable', reason: 'verified_daily_duration_timeline_unavailable' }
    observations.push({ at: observedAt, below: observedCash < requested })
  }
  const completedRuns: { low: number; high: number }[] = []
  const leftCensoredObservedSpans: number[] = []
  const rightCensoredObservedSpans: number[] = []
  let previousAboveAt: number | null = null
  let open: { priorAboveAt: number | null; firstBelowAt: number; lastBelowAt: number } | null = null
  let timelineSegments = 1
  let verifiedTimelineCoverageSeconds = 0
  let bothBoundaryCensoredRuns = 0
  const observedSpanSeconds = (run: { firstBelowAt: number; lastBelowAt: number }) =>
    Math.max(0, Math.floor((run.lastBelowAt - run.firstBelowAt) / 1_000))
  for (let index = 0; index < observations.length; index++) {
    const observation = observations[index]
    if (index > 0) {
      const elapsed = observation.at - observations[index - 1].at
      if (elapsed < DAY_MS - DAILY_TOLERANCE_MS)
        return { status: 'unavailable', reason: 'verified_daily_duration_timeline_unavailable' }
      if (elapsed > DAY_MS + DAILY_TOLERANCE_MS) {
        if (open) {
          const span = observedSpanSeconds(open)
          if (open.priorAboveAt === null) {
            leftCensoredObservedSpans.push(span)
            bothBoundaryCensoredRuns++
          }
          rightCensoredObservedSpans.push(span)
        }
        open = null
        previousAboveAt = null
        timelineSegments++
      } else verifiedTimelineCoverageSeconds += Math.floor(elapsed / 1_000)
    }
    if (observation.below) {
      if (!open)
        open = {
          priorAboveAt: previousAboveAt,
          firstBelowAt: observation.at,
          lastBelowAt: observation.at,
        }
      else open.lastBelowAt = observation.at
      continue
    }
    if (open) {
      if (open.priorAboveAt === null) leftCensoredObservedSpans.push(observedSpanSeconds(open))
      else
        completedRuns.push({
          low: Math.max(0, Math.floor((open.lastBelowAt - open.firstBelowAt) / 1_000)),
          high: Math.max(0, Math.ceil((observation.at - open.priorAboveAt) / 1_000)),
        })
      open = null
    }
    previousAboveAt = observation.at
  }
  if (open) {
    const span = observedSpanSeconds(open)
    if (open.priorAboveAt === null) {
      leftCensoredObservedSpans.push(span)
      bothBoundaryCensoredRuns++
    }
    rightCensoredObservedSpans.push(span)
  }
  const sampledRuns =
    completedRuns.length +
    leftCensoredObservedSpans.length +
    rightCensoredObservedSpans.length -
    bothBoundaryCensoredRuns
  if (!sampledRuns) return { status: 'unavailable', reason: 'no_completed_sampled_below_q_runs' }
  const lows = completedRuns.map((run) => run.low)
  const highs = completedRuns.map((run) => run.high)
  const longest = (values: readonly number[]) => (values.length ? Math.max(...values) : null)
  return {
    status: 'historical_interval_outlook',
    claim: 'aggregate_endpoint_cash_proxy_only',
    intervalCensored: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
    requestedRaw: requested.toString(),
    observations: observations.length,
    observedBelowQSamples: observations.filter((observation) => observation.below).length,
    timelineSegments,
    verifiedTimelineCoverageSeconds,
    samplingCadenceSeconds: 86_400,
    samplingToleranceSeconds: 5_400,
    interpretation: 'completed_sampled_below_q_runs_with_censored_observed_spans',
    sampledRuns,
    completedSampledRuns: completedRuns.length,
    leftCensoredRuns: leftCensoredObservedSpans.length,
    rightCensoredRuns: rightCensoredObservedSpans.length,
    bothBoundaryCensoredRuns,
    completedSampledRunDurationSeconds: completedRuns.length
      ? {
          median: { low: nearestRank(lows, 1, 2), high: nearestRank(highs, 1, 2) },
          p90: { low: nearestRank(lows, 9, 10), high: nearestRank(highs, 9, 10) },
          longest: { low: Math.max(...lows), high: Math.max(...highs) },
        }
      : null,
    censoredRunObservedSpanLowerBoundSeconds: {
      leftLongest: longest(leftCensoredObservedSpans),
      rightLongest: longest(rightCensoredObservedSpans),
    },
  }
}

/**
 * Retrospective absolute-Q check. Each event asks whether the historical endpoint
 * net cash was below the user's exact Q. No current read or Q/current scaling is
 * used, so stale live data cannot suppress this evidence.
 */
export function backtestAbsoluteQEndpointCash(input: {
  subjectKey: string
  requestedRaw: string
  horizonHours: 1 | 24
  pairs: readonly HistoricalCashPair[]
}): AbsoluteQEndpointBacktest {
  const pairs = Array.isArray(input.pairs) ? input.pairs : []
  const emptyCounts = counts(pairs.length)
  const unavailable = (reason: AbsoluteQBacktestReason): AbsoluteQEndpointBacktest => ({
    status: 'unavailable',
    reason,
    counts: emptyCounts,
  })
  const requested = raw(input.requestedRaw)
  if (
    typeof input.subjectKey !== 'string' ||
    !input.subjectKey.trim() ||
    input.subjectKey.length > 1_600 ||
    requested === null ||
    requested === 0n ||
    (input.horizonHours !== 1 && input.horizonHours !== 24) ||
    !Array.isArray(input.pairs)
  )
    return unavailable('invalid_question')

  const horizonMs = input.horizonHours * HOUR_MS
  const toleranceMs = input.horizonHours === 1 ? 15 * 60_000 : HOUR_MS
  const endpointBelowQ: boolean[] = []
  const sourceBelowQ: boolean[] = []
  let previousTargetAt = -Infinity
  for (const pair of pairs) {
    if (pair?.subjectKey !== input.subjectKey) return unavailable('subject_mismatch')
    const sourceAt = at(pair.sourceAt)
    const targetAt = at(pair.targetAt)
    const sourceCash = raw(pair.sourceCashRaw)
    const targetCash = raw(pair.targetCashRaw)
    if (
      sourceAt === null ||
      targetAt === null ||
      sourceCash === null ||
      targetCash === null ||
      targetAt <= sourceAt ||
      Math.abs(targetAt - sourceAt - horizonMs) > toleranceMs
    )
      return unavailable('malformed_history')
    if (sourceAt <= previousTargetAt) return unavailable('overlapping_history')
    sourceBelowQ.push(sourceCash < requested)
    endpointBelowQ.push(targetCash < requested)
    previousTargetAt = targetAt
  }

  const split = counts(endpointBelowQ.length)
  if (Math.min(split.fit, split.calibration, split.holdout) < 20)
    return unavailable('insufficient_history')
  const fit = endpointBelowQ.slice(0, split.fit)
  const calibration = endpointBelowQ.slice(split.fit, split.fit + split.calibration)
  const holdout = endpointBelowQ.slice(split.fit + split.calibration)
  const calibrationSources = sourceBelowQ.slice(split.fit, split.fit + split.calibration)
  const holdoutSources = sourceBelowQ.slice(split.fit + split.calibration)
  const fitBelow = fit.filter(Boolean).length
  const calibrationBelow = calibration.filter(Boolean).length
  const holdoutBelow = holdout.filter(Boolean).length
  const calibrationBrier = brier(calibration, fitBelow, fit.length)
  const holdoutBrier = brier(holdout, fitBelow, fit.length)
  const calibrationPersistenceBrier = persistenceBrier(calibration, calibrationSources, fit.length)
  const holdoutPersistenceBrier = persistenceBrier(holdout, holdoutSources, fit.length)
  const calibrationStable =
    Math.abs(fitBelow * calibration.length - calibrationBelow * fit.length) * 5 <=
    fit.length * calibration.length
  const calibrationBeatsPersistence =
    BigInt(calibrationBrier.numerator) * 10n <= BigInt(calibrationPersistenceBrier.numerator) * 9n
  const holdoutBeatsPersistence =
    BigInt(holdoutBrier.numerator) * 10n <= BigInt(holdoutPersistenceBrier.numerator) * 9n
  const retrospectiveSignal: Extract<
    AbsoluteQEndpointBacktest,
    { status: 'historical_backtest' }
  >['retrospectiveSignal'] = ![fit, calibration, holdout].every(enoughOutcomes)
    ? { status: 'unavailable', reason: 'insufficient_outcome_support' }
    : !calibrationStable
      ? { status: 'unavailable', reason: 'unstable_calibration' }
      : !calibrationBeatsPersistence || !holdoutBeatsPersistence
        ? { status: 'unavailable', reason: 'no_skill_over_persistence' }
        : { status: 'supported', reason: null }

  return {
    status: 'historical_backtest',
    reason: null,
    claim: 'aggregate_endpoint_cash_proxy_only',
    historicalBacktestOnly: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
    requestedRaw: requested.toString(),
    counts: split,
    outcomes: {
      fitBelowQ: { numerator: fitBelow, denominator: fit.length },
      calibrationBelowQ: { numerator: calibrationBelow, denominator: calibration.length },
      holdoutBelowQ: { numerator: holdoutBelow, denominator: holdout.length },
    },
    scoring: {
      method: 'fit_absolute_q_breach_frequency',
      calibrationBrier,
      calibrationPersistenceBrier,
      holdoutBrier,
      holdoutPersistenceBrier,
      calibrationStable,
      calibrationBeatsPersistence,
      holdoutBeatsPersistence,
    },
    retrospectiveSignal,
  }
}

function gaps(): Pick<
  ExitImpactCommon,
  'probabilityQExecutable' | 'duration' | 'expectedCompetingFlow' | 'newsImpact'
> {
  return {
    probabilityQExecutable: {
      status: 'unavailable',
      reason: 'prospective_holder_outcomes_missing',
    },
    duration: {
      status: 'unavailable',
      reason: 'endpoint_history_has_no_crossing_or_recovery_time',
    },
    expectedCompetingFlow: {
      status: 'unavailable',
      reason: 'already_embedded_in_net_cash_endpoints',
    },
    newsImpact: { status: 'unavailable', reason: 'no_causal_news_event_model' },
  }
}

function common(
  identity: ExitImpactIdentity,
  requestedRaw: string,
  horizonHours: 1 | 24,
): ExitImpactCommon {
  return {
    schemaVersion: 1,
    identity,
    question: { requestedRaw, horizonHours },
    claimClass: 'route_proxy',
    holderExecutableExit: false,
    prospectiveValidated: false,
    forecastValidated: false,
    ...gaps(),
  }
}

function bandState(low: bigint, high: bigint, requested: bigint) {
  return low >= requested
    ? ('band_covers_q' as const)
    : high < requested
      ? ('band_below_q' as const)
      : ('band_crosses_q' as const)
}

function direction(
  method: 'learned_delta' | 'persistence_band',
  current: bigint,
  point: bigint,
  low: bigint,
  high: bigint,
) {
  if (method === 'learned_delta')
    return point < current
      ? ('shrinking' as const)
      : point > current
        ? ('growing' as const)
        : ('flat' as const)
  return high < current
    ? ('shrinking' as const)
    : low > current
      ? ('growing' as const)
      : low === current && high === current
        ? ('flat' as const)
        : ('unassessed' as const)
}

function availableBand(input: {
  evidence: 'retrospective_backtest' | 'historical_conditional_projection'
  method: 'learned_delta' | 'persistence_band'
  targetAt: string
  currentRaw: bigint
  requestedRaw: bigint
  lowRaw: bigint
  pointRaw: bigint
  highRaw: bigint
  holdout: Extract<ExitImpactCashBand, { status: 'available' }>['holdout']
}): Extract<ExitImpactCashBand, { status: 'available' }> {
  return {
    status: 'available',
    evidence: input.evidence,
    modelKind: 'endpoint_net_cash_band',
    flowTreatment: 'all_aggregate_flow_already_included',
    method: input.method,
    targetAt: input.targetAt,
    capacityRaw: {
      low: input.lowRaw.toString(),
      point: input.pointRaw.toString(),
      high: input.highRaw.toString(),
    },
    expectedNetFlowRaw: {
      low: (input.lowRaw - input.currentRaw).toString(),
      point: (input.pointRaw - input.currentRaw).toString(),
      high: (input.highRaw - input.currentRaw).toString(),
    },
    marginAfterQRaw: {
      low: (input.lowRaw - input.requestedRaw).toString(),
      point: (input.pointRaw - input.requestedRaw).toString(),
      high: (input.highRaw - input.requestedRaw).toString(),
    },
    projectedState: bandState(input.lowRaw, input.highRaw, input.requestedRaw),
    direction: direction(
      input.method,
      input.currentRaw,
      input.pointRaw,
      input.lowRaw,
      input.highRaw,
    ),
    holdout: input.holdout,
  }
}

function unavailable(
  input: ExitImpactForecastInput,
  reason: Extract<ExitImpactForecast, { status: 'unavailable' }>['reason'],
  sourceReason?: string,
): Extract<ExitImpactForecast, { status: 'unavailable' }> {
  return {
    ...common(input.identity, input.requestedRaw, input.horizonHours),
    status: 'unavailable',
    analysisKind:
      input.kind === 'retrospective_backtest'
        ? 'retrospective_backtest'
        : 'conditional_live_projection',
    reason,
    ...(sourceReason ? { sourceReason } : {}),
  }
}

/**
 * Shared exit-impact boundary for historical evidence and conditional live
 * scenarios. Endpoint cash is already net of aggregate inflow and outflow;
 * callers must not subtract gross historical flow from the returned band.
 */
export function buildExitImpactForecast(input: ExitImpactForecastInput): ExitImpactForecast {
  if (!validIdentity(input.identity)) return unavailable(input, 'invalid_identity')
  const requested = raw(input.requestedRaw)
  if (requested === null || requested === 0n) return unavailable(input, 'invalid_question')
  const base = common(input.identity, requested.toString(), input.horizonHours)

  if (input.kind === 'retrospective_backtest') {
    const exactQ = backtestAbsoluteQEndpointCash({
      subjectKey: subjectKey(input.identity),
      requestedRaw: requested.toString(),
      horizonHours: input.horizonHours,
      pairs: input.pairs,
    })
    if (exactQ.status === 'unavailable') return unavailable(input, exactQ.reason)
    const tail = input.pairs[input.pairs.length - 1]
    const referenceCash = raw(tail?.targetCashRaw)
    const referenceAt = at(tail?.targetAt)
    if (referenceCash === null || referenceAt === null)
      return unavailable(input, 'malformed_history')
    const projected = projectHistoricalCash({
      subjectKey: subjectKey(input.identity),
      horizonHours: input.horizonHours,
      currentAt: tail.targetAt,
      currentCashRaw: tail.targetCashRaw,
      pairs: input.pairs,
    })
    const learned = projected.status === 'historical_projection' ? projected.projection : null
    const baseline = projected.baselineBand?.selectionCoveragePassed ? projected.baselineBand : null
    const selected = learned ?? baseline
    let cashBand: ExitImpactCashBand = {
      status: 'unavailable',
      reason: projected.reason ?? 'no_skill_over_persistence',
    }
    if (selected) {
      const low = raw(selected.bandLowRaw)
      const point = raw(selected.pointRaw)
      const high = raw(selected.bandHighRaw)
      if (low !== null && point !== null && high !== null && low <= high) {
        const selectedHoldout = learned ? projected.holdout : null
        cashBand = availableBand({
          evidence: 'retrospective_backtest',
          method: learned ? 'learned_delta' : 'persistence_band',
          targetAt:
            learned?.targetAt ?? new Date(referenceAt + input.horizonHours * HOUR_MS).toISOString(),
          currentRaw: referenceCash,
          requestedRaw: requested,
          lowRaw: low,
          pointRaw: point,
          highRaw: high,
          holdout: {
            fit: projected.counts.fit,
            calibration: projected.counts.calibration,
            selection: projected.counts.selection,
            selectionCovered: learned
              ? projected.selection!.covered
              : projected.baselineBand!.selectionCovered,
            holdout: projected.counts.holdout,
            covered: learned ? selectedHoldout!.covered : projected.baselineBand!.holdoutCovered,
            coveragePassed: learned
              ? selectedHoldout!.coveragePassed
              : projected.baselineBand!.coveragePassed,
            pointBeatsPersistence: learned ? selectedHoldout!.pointBeatsPersistence : null,
            modelMae: learned ? selectedHoldout!.modelMae : null,
            persistenceMae: learned ? selectedHoldout!.persistenceMae : null,
          },
        })
      }
    }
    return {
      ...base,
      status: 'historical_backtest',
      analysisKind: 'retrospective_backtest',
      reference: {
        basis: 'historical_tail_endpoint',
        at: tail.targetAt,
        cashRaw: referenceCash.toString(),
        marginAfterQRaw: (referenceCash - requested).toString(),
        state: referenceCash >= requested ? 'cash_covers_q' : 'cash_below_q',
      },
      absoluteQBacktest: exactQ,
      duration: historicalQDuration(input.pairs, input.dailyTimeline, requested),
      cashBand,
      alert: { status: 'unavailable', reason: 'retrospective_only' },
    }
  }

  if (input.scenario.status === 'unavailable')
    return unavailable(input, 'source_unavailable', input.scenario.reason)
  const scenario = input.scenario
  const current = raw(scenario.currentCashRaw)
  const low = raw(scenario.bandLowRaw)
  const point = raw(scenario.pointRaw)
  const high = raw(scenario.bandHighRaw)
  const currentAt = at(scenario.currentBlockAt)
  const targetAt = at(scenario.targetAt)
  const testMaeValid = (mae: { numeratorRaw: string; denominator: number } | null): boolean =>
    mae !== null &&
    typeof mae.numeratorRaw === 'string' &&
    RAW.test(mae.numeratorRaw) &&
    Number.isSafeInteger(mae.denominator) &&
    mae.denominator === scenario.holdout
  if (
    current === null ||
    low === null ||
    point === null ||
    high === null ||
    low > high ||
    currentAt === null ||
    targetAt === null ||
    targetAt - currentAt !== input.horizonHours * HOUR_MS ||
    scenario.assetDecimals !== input.identity.assetDecimals ||
    !Number.isSafeInteger(scenario.fit) ||
    !Number.isSafeInteger(scenario.calibration) ||
    !Number.isSafeInteger(scenario.selection) ||
    !Number.isSafeInteger(scenario.selectionCovered) ||
    !Number.isSafeInteger(scenario.holdout) ||
    !Number.isSafeInteger(scenario.holdoutCovered) ||
    scenario.fit < 0 ||
    scenario.calibration < 0 ||
    scenario.selection <= 0 ||
    scenario.selectionCovered < 0 ||
    scenario.selectionCovered > scenario.selection ||
    scenario.holdout <= 0 ||
    scenario.holdoutCovered < 0 ||
    scenario.holdoutCovered > scenario.holdout ||
    (scenario.method === 'learned_delta' &&
      (typeof scenario.holdoutPointBeatsPersistence !== 'boolean' ||
        !testMaeValid(scenario.holdoutModelMae) ||
        !testMaeValid(scenario.holdoutPersistenceMae) ||
        scenario.holdoutPointBeatsPersistence !==
          BigInt(scenario.holdoutModelMae!.numeratorRaw) <
            BigInt(scenario.holdoutPersistenceMae!.numeratorRaw))) ||
    (scenario.method === 'persistence_band' &&
      (scenario.holdoutPointBeatsPersistence !== null ||
        scenario.holdoutModelMae !== null ||
        scenario.holdoutPersistenceMae !== null))
  )
    return unavailable(input, 'source_unavailable', 'invalid_scenario')
  const holdoutCoveragePassed = scenario.holdoutCovered * 100 >= scenario.holdout * 80
  if (
    !holdoutCoveragePassed ||
    (scenario.method === 'learned_delta' && scenario.holdoutPointBeatsPersistence !== true)
  )
    return unavailable(input, 'source_unavailable', 'untouched_test_not_qualified')
  const cashBand = availableBand({
    evidence: 'historical_conditional_projection',
    method: scenario.method,
    targetAt: scenario.targetAt,
    currentRaw: current,
    requestedRaw: requested,
    lowRaw: low,
    pointRaw: point,
    highRaw: high,
    holdout: {
      fit: scenario.fit,
      calibration: scenario.calibration,
      selection: scenario.selection,
      selectionCovered: scenario.selectionCovered,
      holdout: scenario.holdout,
      covered: scenario.holdoutCovered,
      coveragePassed: holdoutCoveragePassed,
      pointBeatsPersistence: scenario.holdoutPointBeatsPersistence,
      modelMae: scenario.holdoutModelMae,
      persistenceMae: scenario.holdoutPersistenceMae,
    },
  })
  const shrinkThresholdCrossed =
    current >= requested &&
    cashBand.direction === 'shrinking' &&
    cashBand.projectedState !== 'band_covers_q'
  return {
    ...base,
    status: 'research_projection',
    analysisKind: 'conditional_live_projection',
    reference: {
      basis: 'scenario_current_endpoint',
      at: scenario.currentBlockAt,
      cashRaw: current.toString(),
      marginAfterQRaw: (current - requested).toString(),
      state: current >= requested ? 'cash_covers_q' : 'cash_below_q',
    },
    absoluteQBacktest: null,
    cashBand,
    alert: !shrinkThresholdCrossed
      ? { status: 'unavailable', reason: 'threshold_not_crossed_by_shrinking_band' }
      : { status: 'estimated', kind: 'projected_shrink' },
  }
}
