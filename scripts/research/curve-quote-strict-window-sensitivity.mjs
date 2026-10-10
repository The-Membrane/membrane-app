// Offline sensitivity: require each historical analog's entire endpoint-choice
// window to have closed by the simulated issue. This does not alter v2 issues.
import { pathToFileURL } from 'node:url'
import { readHistorical } from './curve-prospective-level-forecast.mjs'
import { endpointAt, forecastAt, HORIZONS } from './curve-quote-level-backtest.mjs'

const HOUR = 3600
const TOLERANCE = 90 * 60
const K = 40
const MIN = 30

function quantile(sorted, p) {
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at)
  return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo)
}

function checkRows(rows) {
  if (!Array.isArray(rows) || rows.length < 4) throw new Error('At least four rows required')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (
      !Number.isSafeInteger(row.at) ||
      !Number.isSafeInteger(row.block) ||
      !Number.isFinite(row.quote) ||
      row.quote < 0 ||
      (i > 0 && (row.at <= rows[i - 1].at || row.block <= rows[i - 1].block))
    )
      throw new Error(`Invalid or nonmonotonic quote row ${i}`)
  }
}

export function strictWindowForecastAt(rows, outcomes, index, horizonHours) {
  const anchor = rows[index]
  const candidates = []
  for (let j = 0; j < index; j++) {
    // At exact closure the nearest eligible endpoint cannot be revised.
    if (rows[j].at + horizonHours * HOUR + TOLERANCE > anchor.at) continue
    const end = outcomes[j]
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
    status: available ? 'research_forecast' : 'insufficient_closed_windows',
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
    pendingWindow: 0,
    missingTarget: 0,
    censoredGap: 0,
    observedOutcome: 0,
    v2Available: 0,
    strictAvailable: 0,
    strictAbstainWithV2Available: 0,
    matched: 0,
    v2Error: 0,
    strictError: 0,
    persistenceError: 0,
    v2Covered: 0,
    strictCovered: 0,
    v2Width: 0,
    strictWidth: 0,
    v2ProvisionalSelectedSlots: 0,
    anchorsWithV2ProvisionalSelection: 0,
  }
}

function add(acc, rows, index, horizonHours, v2, strict, outcome) {
  acc.anchors++
  const provisional = v2.selectedIndexes.filter(
    (j) => rows[j].at + horizonHours * HOUR + TOLERANCE > rows[index].at,
  ).length
  acc.v2ProvisionalSelectedSlots += provisional
  if (provisional) acc.anchorsWithV2ProvisionalSelection++
  if (outcome.status === 'pending_window') return void acc.pendingWindow++
  if (outcome.status === 'missing_target') return void acc.missingTarget++
  if (outcome.status === 'censored_gap') return void acc.censoredGap++
  acc.observedOutcome++
  const v2Ok = v2.status === 'research_forecast'
  const strictOk = strict.status === 'research_forecast'
  if (v2Ok) acc.v2Available++
  if (strictOk) acc.strictAvailable++
  if (v2Ok && !strictOk) acc.strictAbstainWithV2Available++
  if (!v2Ok || !strictOk) return
  acc.matched++
  acc.v2Error += Math.abs(v2.projectedQuote - outcome.quote)
  acc.strictError += Math.abs(strict.projectedQuote - outcome.quote)
  acc.persistenceError += Math.abs(v2.persistenceQuote - outcome.quote)
  acc.v2Width += v2.empiricalAnalogInterval[1] - v2.empiricalAnalogInterval[0]
  acc.strictWidth += strict.empiricalAnalogInterval[1] - strict.empiricalAnalogInterval[0]
  if (
    outcome.quote >= v2.empiricalAnalogInterval[0] &&
    outcome.quote <= v2.empiricalAnalogInterval[1]
  )
    acc.v2Covered++
  if (
    outcome.quote >= strict.empiricalAnalogInterval[0] &&
    outcome.quote <= strict.empiricalAnalogInterval[1]
  )
    acc.strictCovered++
}

function summary(acc) {
  const n = acc.matched
  return {
    anchors: acc.anchors,
    pendingWindow: acc.pendingWindow,
    missingTarget: acc.missingTarget,
    censoredGap: acc.censoredGap,
    observedOutcome: acc.observedOutcome,
    v2Available: acc.v2Available,
    strictAvailable: acc.strictAvailable,
    strictAbstainWithV2Available: acc.strictAbstainWithV2Available,
    matched: n,
    v2Mae: n ? acc.v2Error / n : null,
    strictMae: n ? acc.strictError / n : null,
    persistenceMae: n ? acc.persistenceError / n : null,
    v2IntervalCoverage: n ? acc.v2Covered / n : null,
    strictIntervalCoverage: n ? acc.strictCovered / n : null,
    v2MeanIntervalWidth: n ? acc.v2Width / n : null,
    strictMeanIntervalWidth: n ? acc.strictWidth / n : null,
    v2ProvisionalSelectedSlots: acc.v2ProvisionalSelectedSlots,
    anchorsWithV2ProvisionalSelection: acc.anchorsWithV2ProvisionalSelection,
  }
}

export function runStrictWindowSensitivity(rows, horizonHours) {
  checkRows(rows)
  if (!HORIZONS.includes(horizonHours)) throw new Error('Unsupported v2 horizon')
  const outcomes = rows.map((_, i) => endpointAt(rows, i, horizonHours))
  const split = Math.floor(rows.length * 0.75)
  const development = rows
    .slice(0, split)
    .map((row) => row.quote)
    .sort((a, b) => a - b)
  const cutLow = quantile(development, 0.25)
  const cutHigh = quantile(development, 0.75)
  const rolling = empty()
  const nonOverlapping = empty()
  const lower = empty()
  const nonOverlappingAnchorIndexes = []
  let nextNonOverlapAt = -Infinity
  for (let i = split; i < rows.length; i++) {
    const v2 = forecastAt(rows, outcomes, i, horizonHours)
    const strict = strictWindowForecastAt(rows, outcomes, i, horizonHours)
    const value = outcomes[i]
    const outcome = rows.at(-1).at < value.target + TOLERANCE ? { status: 'pending_window' } : value
    add(rolling, rows, i, horizonHours, v2, strict, outcome)
    if (rows[i].quote < cutLow) add(lower, rows, i, horizonHours, v2, strict, outcome)
    if (rows[i].at > nextNonOverlapAt) {
      add(nonOverlapping, rows, i, horizonHours, v2, strict, outcome)
      nonOverlappingAnchorIndexes.push(i)
      nextNonOverlapAt = rows[i].at + horizonHours * HOUR + TOLERANCE
    }
  }
  return {
    horizonHours,
    sourceRows: rows.length,
    evaluation: 'exploratory final quarter previously explored in v1; not untouched holdout',
    method: {
      feature: 'current_quote_level_only',
      k: K,
      minimum: MIN,
      strictRule: 'analog target + 90m <= simulated issue time',
      endpoint: 'same nearest ±90m observed endpoint and four-hour gap rule as v2',
      nearestOrder: 'absolute quote-level distance asc, source index desc',
      nonOverlapBoundary: 'closed evaluation windows; next start strictly after previous end',
      interval: 'selected-analog delta p10-p90; uncalibrated',
      denominator: 'v2, strict and persistence metrics use identical matched observed anchors',
    },
    rolling: summary(rolling),
    nonOverlapping: summary(nonOverlapping),
    nonOverlappingAnchorIndexes,
    finalQuarterLowerQuoteRegime: {
      lowerThan: cutLow,
      upperThan: cutHigh,
      ...summary(lower),
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2)
    throw new Error('Usage: node scripts/research/curve-quote-strict-window-sensitivity.mjs')
  const rows = readHistorical()
  console.log(
    JSON.stringify({
      study: 'exploratory strict analog-window closure sensitivity versus exact v2',
      source: {
        name: 'scrvusd-size-aware-400d',
        physicalSha256: 'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a',
        rows: rows.length,
      },
      caveats: [
        'Retrospective archive replay uses block timestamp as simulated issue time.',
        'Final quarter was previously explored and is not an untouched holdout.',
        'Nominal get_dy quote is not executable vault exit, fill, or exit probability.',
        'Empirical intervals are not calibrated and overlapping rolling anchors are dependent.',
      ],
      horizons: HORIZONS.map((h) => runStrictWindowSensitivity(rows, h)),
    }),
  )
}
