/** Retrospective aggregate-cash model. Inputs are one exact subject, never holder exit. */
export type HistoricalCashPair = {
  subjectKey: string
  sourceAt: string
  targetAt: string
  sourceCashRaw: string
  targetCashRaw: string
}

export type HistoricalCashProjectionInput = {
  subjectKey: string
  horizonHours: 1 | 24
  currentAt: string
  currentCashRaw: string
  pairs: readonly HistoricalCashPair[]
}

export type HistoricalCashProjectionReason =
  | 'invalid_question'
  | 'subject_mismatch'
  | 'malformed_history'
  | 'overlapping_history'
  | 'future_outcome'
  | 'insufficient_history'
  | 'no_skill_over_persistence'

type Counts = {
  total: number
  fit: number
  calibration: number
  selection: number
  holdout: number
}

export type HistoricalCashHoldout = {
  covered: number
  total: number
  coveragePassed: boolean
  pointBeatsPersistence: boolean
  modelMae: { numeratorRaw: string; denominator: number }
  persistenceMae: { numeratorRaw: string; denominator: number }
}

export type HistoricalCashBaselineBand = {
  pointRaw: string
  bandLowRaw: string
  bandHighRaw: string
  calibrationChangeP05Raw: string
  calibrationChangeP95Raw: string
  selectionCovered: number
  selectionTotal: number
  selectionCoveragePassed: boolean
  holdoutCovered: number
  holdoutTotal: number
  coveragePassed: boolean
}

type Common = {
  subjectKey: string
  horizonHours: number
  currentAt: string
  claim: 'aggregate_cash_proxy_only'
  historicalBacktestOnly: true
  prospectiveValidated: false
  holderExecutableExit: false
  counts: Counts
  selection: HistoricalCashHoldout | null
  holdout: HistoricalCashHoldout | null
  baselineBand: HistoricalCashBaselineBand | null
}

export type HistoricalCashProjectionResult = Common &
  (
    | {
        status: 'unavailable'
        reason: HistoricalCashProjectionReason
        projection: null
      }
    | {
        status: 'historical_projection'
        reason: null
        projection: {
          targetAt: string
          pointRaw: string
          bandLowRaw: string
          bandHighRaw: string
          fitMedianDeltaRaw: string
          calibrationResidualP05Raw: string
          calibrationResidualP95Raw: string
          empiricalBand: 'calibration_residual_p05_p95'
        }
      }
  )

const HOUR_MS = 3_600_000
const MAX_RAW = (1n << 256n) - 1n
const RAW = /^(0|[1-9][0-9]*)$/

function parsedRaw(value: unknown): bigint | null {
  if (typeof value !== 'string' || !RAW.test(value) || value.length > 78) return null
  const raw = BigInt(value)
  return raw <= MAX_RAW ? raw : null
}

function parsedAt(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return null
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value ? ms : null
}

function clampRaw(value: bigint): bigint {
  return value < 0n ? 0n : value > MAX_RAW ? MAX_RAW : value
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

function sorted(values: readonly bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Even samples use the lower median, preserving an exact integer raw delta. */
function lowerMedian(values: readonly bigint[]): bigint {
  const ordered = sorted(values)
  return ordered[Math.floor((ordered.length - 1) / 2)]
}

/** Empirical nearest-rank percentile, with no floating-point cash arithmetic. */
function percentile(values: readonly bigint[], percent: 5 | 95): bigint {
  const ordered = sorted(values)
  return ordered[Math.ceil((percent * ordered.length) / 100) - 1]
}

/**
 * Pure historical research only. The caller must supply one pinned subject's
 * physically validated pairs; this function rechecks identity, duration,
 * ordering, disjointness, raw range, and that outcomes precede the question.
 */
export function projectHistoricalCash(
  input: HistoricalCashProjectionInput,
): HistoricalCashProjectionResult {
  const pairs = Array.isArray(input.pairs) ? input.pairs : []
  const base = {
    subjectKey: input.subjectKey,
    horizonHours: input.horizonHours,
    currentAt: input.currentAt,
    claim: 'aggregate_cash_proxy_only' as const,
    historicalBacktestOnly: true as const,
    prospectiveValidated: false as const,
    holderExecutableExit: false as const,
  }
  const emptyCounts: Counts = {
    total: pairs.length,
    fit: 0,
    calibration: 0,
    selection: 0,
    holdout: 0,
  }
  const unavailable = (
    reason: HistoricalCashProjectionReason,
    counts = emptyCounts,
    selection: HistoricalCashHoldout | null = null,
    holdout: HistoricalCashHoldout | null = null,
    baselineBand: HistoricalCashBaselineBand | null = null,
  ): HistoricalCashProjectionResult => ({
    ...base,
    status: 'unavailable',
    reason,
    counts,
    selection,
    holdout,
    baselineBand,
    projection: null,
  })

  const currentAt = parsedAt(input.currentAt)
  const currentRaw = parsedRaw(input.currentCashRaw)
  if (
    typeof input.subjectKey !== 'string' ||
    !input.subjectKey.trim() ||
    input.subjectKey.length > 512 ||
    (input.horizonHours !== 1 && input.horizonHours !== 24) ||
    currentAt === null ||
    currentRaw === null ||
    !Array.isArray(input.pairs)
  )
    return unavailable('invalid_question')

  const targetAt = currentAt + input.horizonHours * HOUR_MS
  if (!Number.isSafeInteger(targetAt)) return unavailable('invalid_question')

  const horizonMs = input.horizonHours * HOUR_MS
  const toleranceMs = input.horizonHours === 1 ? 15 * 60_000 : HOUR_MS
  const checked: Array<{ sourceCash: bigint; targetCash: bigint; delta: bigint }> = []
  let previousTargetAt = -Infinity
  for (const pair of pairs) {
    if (pair?.subjectKey !== input.subjectKey) return unavailable('subject_mismatch')
    const sourceAt = parsedAt(pair.sourceAt)
    const pairTargetAt = parsedAt(pair.targetAt)
    const sourceCash = parsedRaw(pair.sourceCashRaw)
    const targetCash = parsedRaw(pair.targetCashRaw)
    if (
      sourceAt === null ||
      pairTargetAt === null ||
      sourceCash === null ||
      targetCash === null ||
      pairTargetAt <= sourceAt ||
      Math.abs(pairTargetAt - sourceAt - horizonMs) > toleranceMs
    )
      return unavailable('malformed_history')
    if (sourceAt <= previousTargetAt) return unavailable('overlapping_history')
    if (pairTargetAt > currentAt) return unavailable('future_outcome')
    checked.push({ sourceCash, targetCash, delta: targetCash - sourceCash })
    previousTargetAt = pairTargetAt
  }

  if (checked.length < 60) return unavailable('insufficient_history')
  const fitCount = Math.floor(checked.length / 3)
  const calibrationCount = Math.floor(checked.length / 3)
  const remainingCount = checked.length - fitCount - calibrationCount
  const selectionCount = Math.floor(remainingCount / 2)
  const holdoutCount = remainingCount - selectionCount
  const counts: Counts = {
    total: checked.length,
    fit: fitCount,
    calibration: calibrationCount,
    selection: selectionCount,
    holdout: holdoutCount,
  }
  if (fitCount < 20 || calibrationCount < 20 || selectionCount < 10 || holdoutCount < 10)
    return unavailable('insufficient_history', counts)

  const fitMedianDelta = lowerMedian(checked.slice(0, fitCount).map((pair) => pair.delta))
  const calibrationResiduals = checked
    .slice(fitCount, fitCount + calibrationCount)
    .map((pair) => pair.delta - fitMedianDelta)
  const residualP05 = percentile(calibrationResiduals, 5)
  const residualP95 = percentile(calibrationResiduals, 95)
  const calibrationChanges = checked
    .slice(fitCount, fitCount + calibrationCount)
    .map((pair) => pair.delta)
  const changeP05 = percentile(calibrationChanges, 5)
  const changeP95 = percentile(calibrationChanges, 95)

  const assess = (slice: readonly (typeof checked)[number][]) => {
    let covered = 0
    let baselineCovered = 0
    let modelErrorTotal = 0n
    let persistenceErrorTotal = 0n
    for (const pair of slice) {
      const point = clampRaw(pair.sourceCash + fitMedianDelta)
      const low = clampRaw(pair.sourceCash + fitMedianDelta + residualP05)
      const high = clampRaw(pair.sourceCash + fitMedianDelta + residualP95)
      if (pair.targetCash >= low && pair.targetCash <= high) covered++
      if (
        pair.targetCash >= clampRaw(pair.sourceCash + changeP05) &&
        pair.targetCash <= clampRaw(pair.sourceCash + changeP95)
      )
        baselineCovered++
      modelErrorTotal += absolute(pair.targetCash - point)
      persistenceErrorTotal += absolute(pair.targetCash - pair.sourceCash)
    }
    const total = slice.length
    const learned: HistoricalCashHoldout = {
      covered,
      total,
      coveragePassed: covered * 100 >= 80 * total,
      pointBeatsPersistence: modelErrorTotal < persistenceErrorTotal,
      modelMae: { numeratorRaw: modelErrorTotal.toString(), denominator: total },
      persistenceMae: {
        numeratorRaw: persistenceErrorTotal.toString(),
        denominator: total,
      },
    }
    return { learned, baselineCovered }
  }
  const selectionAssessment = assess(
    checked.slice(fitCount + calibrationCount, fitCount + calibrationCount + selectionCount),
  )
  const holdoutAssessment = assess(checked.slice(fitCount + calibrationCount + selectionCount))
  const selection = selectionAssessment.learned
  const holdout = holdoutAssessment.learned
  const baselineBand: HistoricalCashBaselineBand = {
    pointRaw: currentRaw.toString(),
    bandLowRaw: clampRaw(currentRaw + changeP05).toString(),
    bandHighRaw: clampRaw(currentRaw + changeP95).toString(),
    calibrationChangeP05Raw: changeP05.toString(),
    calibrationChangeP95Raw: changeP95.toString(),
    selectionCovered: selectionAssessment.baselineCovered,
    selectionTotal: selectionCount,
    selectionCoveragePassed: selectionAssessment.baselineCovered * 100 >= 80 * selectionCount,
    holdoutCovered: holdoutAssessment.baselineCovered,
    holdoutTotal: holdoutCount,
    coveragePassed: holdoutAssessment.baselineCovered * 100 >= 80 * holdoutCount,
  }
  if (!selection.coveragePassed || !selection.pointBeatsPersistence)
    return unavailable('no_skill_over_persistence', counts, selection, holdout, baselineBand)

  return {
    ...base,
    status: 'historical_projection',
    reason: null,
    counts,
    selection,
    holdout,
    baselineBand,
    projection: {
      targetAt: new Date(targetAt).toISOString(),
      pointRaw: clampRaw(currentRaw + fitMedianDelta).toString(),
      bandLowRaw: clampRaw(currentRaw + fitMedianDelta + residualP05).toString(),
      bandHighRaw: clampRaw(currentRaw + fitMedianDelta + residualP95).toString(),
      fitMedianDeltaRaw: fitMedianDelta.toString(),
      calibrationResidualP05Raw: residualP05.toString(),
      calibrationResidualP95Raw: residualP95.toString(),
      empiricalBand: 'calibration_residual_p05_p95',
    },
  }
}
