import type { HistoricalCashPair } from '@/lib/carry/historicalCashProjection'

type Counts = { total: number; fit: number; calibration: number; holdout: number }
type Fraction = { numerator: number; denominator: number }
type BrierScore = { numerator: string; denominator: number }

export type AggregateCashQHoldoutInput = {
  subjectKey: string
  currentAt: string
  asOfAt: string
  currentCashRaw: string
  requestedAssetsRaw: string
  pairs: readonly HistoricalCashPair[]
}

export type AggregateCashQHoldoutReason =
  | 'invalid_question'
  | 'stale_current'
  | 'subject_mismatch'
  | 'malformed_history'
  | 'zero_historical_source'
  | 'overlapping_history'
  | 'future_outcome'
  | 'insufficient_history'
  | 'insufficient_breach_support'
  | 'unstable_calibration'
  | 'no_skill_over_persistence'

type Evidence = {
  method: 'fit_frequency_baseline'
  persistenceBaseline: 'current_cash_covers_q'
  requestedFraction: { numeratorRaw: string; denominatorRaw: string }
  fitBreaches: Fraction
  calibrationBreaches: Fraction
  holdoutBreaches: Fraction
  calibrationBrier: BrierScore
  calibrationPersistenceBrier: BrierScore
  holdoutBrier: BrierScore
  holdoutPersistenceBrier: BrierScore
  calibrationStable: boolean
  calibrationBeatsPersistence: boolean
  holdoutBeatsPersistence: boolean
}

export type AggregateCashQHoldoutResult = {
  subjectKey: string
  currentAt: string
  claim: 'aggregate_cash_proxy_only'
  historicalBacktestOnly: true
  prospectiveValidated: false
  holderExecutableExit: false
  counts: Counts
  evidence: Evidence | null
} & (
  | { status: 'unavailable'; reason: AggregateCashQHoldoutReason }
  | { status: 'historical_backtest'; reason: null }
)

const DAY_MS = 86_400_000
const MAX_RAW = (1n << 256n) - 1n
const RAW = /^(0|[1-9][0-9]*)$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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

function brier(events: readonly boolean[], numerator: number, denominator: number): BrierScore {
  let error = 0n
  for (const event of events) {
    const difference = BigInt(event ? denominator - numerator : numerator)
    error += difference * difference
  }
  return { numerator: error.toString(), denominator: events.length * denominator * denominator }
}

function persistenceBrier(events: readonly boolean[], denominator: number): BrierScore {
  const breaches = events.filter(Boolean).length
  return {
    numerator: (BigInt(breaches) * BigInt(denominator) ** 2n).toString(),
    denominator: events.length * denominator * denominator,
  }
}

function supported(events: readonly boolean[]): boolean {
  const breaches = events.filter(Boolean).length
  return breaches >= 5 && events.length - breaches >= 5
}

/**
 * Exact-ratio retrospective check of aggregate cash only. The fitted historical
 * frequency is never a calibrated future probability, executable exit, or alert.
 * Pairs must already come from verified receipts; this rechecks their shape.
 */
export function backtestAggregateCashQ(
  input: AggregateCashQHoldoutInput,
): AggregateCashQHoldoutResult {
  const pairs = Array.isArray(input.pairs) ? input.pairs : []
  const base = {
    subjectKey: input.subjectKey,
    currentAt: input.currentAt,
    claim: 'aggregate_cash_proxy_only' as const,
    historicalBacktestOnly: true as const,
    prospectiveValidated: false as const,
    holderExecutableExit: false as const,
  }
  const emptyCounts: Counts = { total: pairs.length, fit: 0, calibration: 0, holdout: 0 }
  const unavailable = (
    reason: AggregateCashQHoldoutReason,
    counts = emptyCounts,
    evidence: Evidence | null = null,
  ): AggregateCashQHoldoutResult => ({
    ...base,
    status: 'unavailable',
    reason,
    counts,
    evidence,
  })

  const currentAt = at(input.currentAt)
  const asOfAt = at(input.asOfAt)
  const currentCash = raw(input.currentCashRaw)
  const q = raw(input.requestedAssetsRaw)
  if (
    typeof input.subjectKey !== 'string' ||
    !input.subjectKey.trim() ||
    input.subjectKey.length > 512 ||
    currentAt === null ||
    asOfAt === null ||
    currentCash === null ||
    q === null ||
    currentCash === 0n ||
    q === 0n ||
    q > currentCash ||
    !Array.isArray(input.pairs)
  )
    return unavailable('invalid_question')
  if (asOfAt < currentAt || asOfAt - currentAt > 2 * 3_600_000) return unavailable('stale_current')

  const events: boolean[] = []
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
      Math.abs(targetAt - sourceAt - DAY_MS) > 3_600_000
    )
      return unavailable('malformed_history')
    if (sourceCash === 0n) return unavailable('zero_historical_source')
    if (sourceAt <= previousTargetAt) return unavailable('overlapping_history')
    if (targetAt > currentAt) return unavailable('future_outcome')
    // target/source < Q/current, with no floating point or rounded fractions.
    events.push(targetCash * currentCash < sourceCash * q)
    previousTargetAt = targetAt
  }

  if (events.length < 60) return unavailable('insufficient_history')
  const fitCount = Math.floor(events.length / 3)
  const calibrationCount = Math.floor(events.length / 3)
  const counts: Counts = {
    total: events.length,
    fit: fitCount,
    calibration: calibrationCount,
    holdout: events.length - fitCount - calibrationCount,
  }
  if (Math.min(counts.fit, counts.calibration, counts.holdout) < 20)
    return unavailable('insufficient_history', counts)

  const fit = events.slice(0, fitCount)
  const calibration = events.slice(fitCount, fitCount + calibrationCount)
  const holdout = events.slice(fitCount + calibrationCount)
  const fitBreaches = fit.filter(Boolean).length
  const calibrationBreaches = calibration.filter(Boolean).length
  const holdoutBreaches = holdout.filter(Boolean).length
  const calibrationBrier = brier(calibration, fitBreaches, fit.length)
  const calibrationPersistenceBrier = persistenceBrier(calibration, fit.length)
  const holdoutBrier = brier(holdout, fitBreaches, fit.length)
  const holdoutPersistenceBrier = persistenceBrier(holdout, fit.length)
  const stable =
    Math.abs(fitBreaches * calibration.length - calibrationBreaches * fit.length) * 5 <=
    fit.length * calibration.length
  // At least 10% lower Brier loss than persistence in both untouched stages.
  const calibrationBeats =
    BigInt(calibrationBrier.numerator) * 10n <= BigInt(calibrationPersistenceBrier.numerator) * 9n
  const holdoutBeats =
    BigInt(holdoutBrier.numerator) * 10n <= BigInt(holdoutPersistenceBrier.numerator) * 9n
  const evidence: Evidence = {
    method: 'fit_frequency_baseline',
    persistenceBaseline: 'current_cash_covers_q',
    requestedFraction: {
      numeratorRaw: q.toString(),
      denominatorRaw: currentCash.toString(),
    },
    fitBreaches: { numerator: fitBreaches, denominator: fit.length },
    calibrationBreaches: { numerator: calibrationBreaches, denominator: calibration.length },
    holdoutBreaches: { numerator: holdoutBreaches, denominator: holdout.length },
    calibrationBrier,
    calibrationPersistenceBrier,
    holdoutBrier,
    holdoutPersistenceBrier,
    calibrationStable: stable,
    calibrationBeatsPersistence: calibrationBeats,
    holdoutBeatsPersistence: holdoutBeats,
  }
  if (![fit, calibration, holdout].every(supported))
    return unavailable('insufficient_breach_support', counts, evidence)
  if (!stable) return unavailable('unstable_calibration', counts, evidence)
  if (!calibrationBeats || !holdoutBeats)
    return unavailable('no_skill_over_persistence', counts, evidence)
  return { ...base, status: 'historical_backtest', reason: null, counts, evidence }
}
