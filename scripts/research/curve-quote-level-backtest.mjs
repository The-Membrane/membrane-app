// Offline exploratory replay of the exact level-only v2 nominal $1m quote rule.
// The final quarter was examined in an earlier v1 study: this is NOT an untouched holdout.
import { pathToFileURL } from 'node:url'
import { readHistorical } from './curve-prospective-level-forecast.mjs'

const HOUR = 3600
const GAP = 4 * HOUR
const TOLERANCE = 90 * 60
const K = 40
const MIN = 30
export const HORIZONS = [24, 168]

function quantile(sorted, p) {
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at)
  return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo)
}

function checkRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Rows required')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (
      !Number.isSafeInteger(row.at) ||
      !Number.isSafeInteger(row.block) ||
      !Number.isFinite(row.quote) ||
      row.quote < 0 ||
      (i && (row.at <= rows[i - 1].at || row.block <= rows[i - 1].block))
    )
      throw new Error(`Invalid or nonmonotonic quote row ${i}`)
  }
}

// This reproduces v2 outcome(): nearest endpoint within ±90m, tie to earlier
// row; every intervening observation must be at most four hours apart.
export function endpointAt(rows, index, horizonHours, maxObservedAt = Infinity) {
  const target = rows[index].at + horizonHours * HOUR
  let best = -1
  for (let j = index + 1; j < rows.length && rows[j].at <= maxObservedAt; j++) {
    if (rows[j].at > target + TOLERANCE) break
    if (
      Math.abs(rows[j].at - target) <= TOLERANCE &&
      (best < 0 || Math.abs(rows[j].at - target) < Math.abs(rows[best].at - target))
    )
      best = j
  }
  if (best < 0) return { status: 'missing_target', target }
  for (let j = index + 1; j <= best; j++)
    if (rows[j].at - rows[j - 1].at > GAP) return { status: 'censored_gap', target, endpoint: best }
  return { status: 'observed', target, endpoint: best, quote: rows[best].quote }
}

export function forecastAt(rows, outcomes, index, horizonHours) {
  const anchor = rows[index]
  const candidates = []
  for (let j = 0; j < index; j++) {
    // The nearest endpoint can change inside the ±90m window. Re-evaluate
    // that narrow boundary as-of the issue, as the prospective issuer does.
    const end =
      outcomes[j].target + TOLERANCE > anchor.at
        ? endpointAt(rows, j, horizonHours, anchor.at)
        : outcomes[j]
    // Endpoint must already have happened at the simulated issue block. A
    // complete future outcome in the archive is NOT knowledge at this anchor.
    if (rows[j].quote === 0 || end.status !== 'observed' || rows[end.endpoint].at > anchor.at)
      continue
    candidates.push({
      index: j,
      distance: Math.abs(rows[j].quote - anchor.quote),
      delta: end.quote - rows[j].quote,
    })
  }
  candidates.sort((a, b) => a.distance - b.distance || b.index - a.index)
  const selected = candidates.slice(0, K)
  const available = anchor.quote > 0 && candidates.length >= MIN
  const deltas = selected.map((candidate) => candidate.delta).sort((a, b) => a - b)
  return {
    status: available ? 'research_forecast' : 'insufficient_sample',
    availableAnalogs: candidates.length,
    selectedAnalogs: selected.length,
    selectedIndexes: selected.map((candidate) => candidate.index),
    projectedQuote: available ? anchor.quote + quantile(deltas, 0.5) : null,
    empiricalAnalogInterval: available
      ? [anchor.quote + quantile(deltas, 0.1), anchor.quote + quantile(deltas, 0.9)]
      : null,
    persistenceQuote: anchor.quote,
  }
}

function empty() {
  return {
    anchors: 0,
    eligible: 0,
    pendingWindow: 0,
    missingTarget: 0,
    censoredGap: 0,
    insufficientSample: 0,
    analogAbsError: 0,
    persistenceAbsError: 0,
    intervalCovered: 0,
    intervalWidth: 0,
  }
}

function add(acc, forecast, outcome) {
  acc.anchors++
  if (outcome.status === 'pending_window') acc.pendingWindow++
  else if (outcome.status === 'missing_target') acc.missingTarget++
  else if (outcome.status === 'censored_gap') acc.censoredGap++
  else if (forecast.status !== 'research_forecast') acc.insufficientSample++
  else {
    acc.eligible++
    acc.analogAbsError += Math.abs(forecast.projectedQuote - outcome.quote)
    acc.persistenceAbsError += Math.abs(forecast.persistenceQuote - outcome.quote)
    acc.intervalWidth += forecast.empiricalAnalogInterval[1] - forecast.empiricalAnalogInterval[0]
    if (
      outcome.quote >= forecast.empiricalAnalogInterval[0] &&
      outcome.quote <= forecast.empiricalAnalogInterval[1]
    )
      acc.intervalCovered++
  }
}

function summarize(acc) {
  return {
    anchors: acc.anchors,
    eligible: acc.eligible,
    pendingWindow: acc.pendingWindow,
    missingTarget: acc.missingTarget,
    censoredGap: acc.censoredGap,
    insufficientSample: acc.insufficientSample,
    analogMae: acc.eligible ? acc.analogAbsError / acc.eligible : null,
    persistenceMae: acc.eligible ? acc.persistenceAbsError / acc.eligible : null,
    analogMinusPersistenceMae: acc.eligible
      ? (acc.analogAbsError - acc.persistenceAbsError) / acc.eligible
      : null,
    intervalCovered: acc.intervalCovered,
    empiricalIntervalCoverage: acc.eligible ? acc.intervalCovered / acc.eligible : null,
    meanIntervalWidth: acc.eligible ? acc.intervalWidth / acc.eligible : null,
  }
}

export function runBacktest(rows, horizonHours) {
  checkRows(rows)
  if (!HORIZONS.includes(horizonHours)) throw new Error('Unsupported v2 horizon')
  const outcomes = rows.map((_, i) => endpointAt(rows, i, horizonHours))
  const scoredOutcomes = outcomes.map((value, i) =>
    rows.at(-1).at < value.target + TOLERANCE ? { status: 'pending_window' } : value,
  )
  const split = Math.floor(rows.length * 0.75)
  // Regime boundaries are fixed before evaluation from the first 75% only.
  const developmentLevels = rows
    .slice(0, split)
    .map((row) => row.quote)
    .sort((a, b) => a - b)
  const cutLow = quantile(developmentLevels, 0.25)
  const cutHigh = quantile(developmentLevels, 0.75)
  const rolling = empty()
  const nonOverlapping = empty()
  const temporal = Array.from({ length: 4 }, empty)
  const regimes = { lower: empty(), middle: empty(), upper: empty() }
  let nextNonOverlapAt = -Infinity
  for (let i = 0; i < rows.length; i++) {
    const forecast = forecastAt(rows, outcomes, i, horizonHours)
    const actual = scoredOutcomes[i]
    const quarter =
      i < Math.floor(rows.length * 0.25)
        ? 0
        : i < Math.floor(rows.length * 0.5)
          ? 1
          : i < split
            ? 2
            : 3
    add(temporal[quarter], forecast, actual)
    if (i < split) continue
    add(rolling, forecast, actual)
    const regime = rows[i].quote < cutLow ? 'lower' : rows[i].quote > cutHigh ? 'upper' : 'middle'
    add(regimes[regime], forecast, actual)
    if (rows[i].at >= nextNonOverlapAt) {
      add(nonOverlapping, forecast, actual)
      // Selection is fixed by timestamp, before seeing the anchor outcome.
      nextNonOverlapAt = rows[i].at + horizonHours * HOUR + TOLERANCE
    }
  }
  return {
    horizonHours,
    sourceRows: rows.length,
    evaluation:
      'exploratory rolling final quarter of previously explored corpus; not untouched holdout',
    method: {
      feature: 'current_quote_level_only',
      k: K,
      minimum: MIN,
      endpointToleranceSeconds: TOLERANCE,
      maximumGapSeconds: GAP,
      nonOverlapSpacingSeconds: horizonHours * HOUR + TOLERANCE,
      interval: 'selected-analog delta p10-p90; uncalibrated',
    },
    rolling: summarize(rolling),
    nonOverlapping: summarize(nonOverlapping),
    temporalQuartiles: temporal.map((acc, i) => ({
      quarter: i + 1,
      exploredFinalQuarter: i === 3,
      ...summarize(acc),
    })),
    finalQuarterQuoteRegimes: {
      boundariesFromFirstThreeQuarters: { lowerThan: cutLow, upperThan: cutHigh },
      lower: summarize(regimes.lower),
      middle: summarize(regimes.middle),
      upper: summarize(regimes.upper),
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length) throw new Error('Usage: node scripts/research/curve-quote-level-backtest.mjs')
  const rows = readHistorical() // catalog + exact physical SHA + 3,184-row check
  console.log(
    JSON.stringify({
      study: 'exploratory v2 level-only nominal $1m Curve quote backtest',
      source: {
        name: 'scrvusd-size-aware-400d',
        physicalSha256: 'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a',
        rows: rows.length,
      },
      caveats: [
        'Archive replay uses block timestamp as simulated issue time; historical acquisition was retrospective.',
        'Final quarter was explored in v1 and is not untouched validation.',
        'Nominal get_dy quote is not a vault withdrawal, executable fill, or exit probability.',
        'Dense analogs and rolling outcomes overlap; intervals are not calibrated.',
      ],
      horizons: HORIZONS.map((horizonHours) => runBacktest(rows, horizonHours)),
    }),
  )
}
