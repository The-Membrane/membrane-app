// Exploratory offline test of episode diversity for nominal $1m quote analogs.
// The final quarter was previously explored and is not an untouched holdout.
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

// Same v2 feature and observed-as-of endpoint rule; only analog selection changes.
// An observed endpoint may still be provisional until its ±90m window closes.
export function diverseForecastAt(rows, outcomes, index, horizonHours) {
  const anchor = rows[index]
  const episodeSeconds = horizonHours * HOUR + TOLERANCE
  const candidates = []
  for (let j = 0; j < index; j++) {
    const end =
      outcomes[j].target + TOLERANCE > anchor.at
        ? endpointAt(rows, j, horizonHours, anchor.at)
        : outcomes[j]
    if (rows[j].quote === 0 || end.status !== 'observed' || rows[end.endpoint].at > anchor.at)
      continue
    candidates.push({
      index: j,
      distance: Math.abs(rows[j].quote - anchor.quote),
      delta: end.quote - rows[j].quote,
      provisional: outcomes[j].target + TOLERANCE > anchor.at,
    })
  }
  candidates.sort((a, b) => a.distance - b.distance || b.index - a.index)
  const selected = []
  for (const candidate of candidates) {
    const start = rows[candidate.index].at
    if (selected.every((prior) => Math.abs(start - rows[prior.index].at) > episodeSeconds))
      selected.push(candidate)
    if (selected.length === K) break
  }
  const available = anchor.quote > 0 && selected.length >= MIN
  const deltas = selected.map((candidate) => candidate.delta).sort((a, b) => a - b)
  return {
    status: available ? 'research_forecast' : 'insufficient_distinct_episodes',
    availableAnalogs: candidates.length,
    selectedEpisodes: selected.length,
    provisionalSelectedEpisodes: selected.filter((candidate) => candidate.provisional).length,
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
    diverseAvailable: 0,
    diverseAbstainWithV2Available: 0,
    matched: 0,
    v2Error: 0,
    diverseError: 0,
    persistenceError: 0,
    v2Covered: 0,
    diverseCovered: 0,
    v2Width: 0,
    diverseWidth: 0,
    provisionalSelectedEpisodeSlots: 0,
    anchorsWithProvisionalSelection: 0,
  }
}

function add(acc, v2, diverse, outcome) {
  acc.anchors++
  acc.provisionalSelectedEpisodeSlots += diverse.provisionalSelectedEpisodes
  if (diverse.provisionalSelectedEpisodes) acc.anchorsWithProvisionalSelection++
  if (outcome.status === 'pending_window') return void acc.pendingWindow++
  if (outcome.status === 'missing_target') return void acc.missingTarget++
  if (outcome.status === 'censored_gap') return void acc.censoredGap++
  acc.observedOutcome++
  const v2Ok = v2.status === 'research_forecast'
  const diverseOk = diverse.status === 'research_forecast'
  if (v2Ok) acc.v2Available++
  if (diverseOk) acc.diverseAvailable++
  if (v2Ok && !diverseOk) acc.diverseAbstainWithV2Available++
  if (!v2Ok || !diverseOk) return
  acc.matched++
  acc.v2Error += Math.abs(v2.projectedQuote - outcome.quote)
  acc.diverseError += Math.abs(diverse.projectedQuote - outcome.quote)
  acc.persistenceError += Math.abs(v2.persistenceQuote - outcome.quote)
  acc.v2Width += v2.empiricalAnalogInterval[1] - v2.empiricalAnalogInterval[0]
  acc.diverseWidth += diverse.empiricalAnalogInterval[1] - diverse.empiricalAnalogInterval[0]
  if (
    outcome.quote >= v2.empiricalAnalogInterval[0] &&
    outcome.quote <= v2.empiricalAnalogInterval[1]
  )
    acc.v2Covered++
  if (
    outcome.quote >= diverse.empiricalAnalogInterval[0] &&
    outcome.quote <= diverse.empiricalAnalogInterval[1]
  )
    acc.diverseCovered++
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
    diverseAvailable: acc.diverseAvailable,
    diverseAbstainWithV2Available: acc.diverseAbstainWithV2Available,
    matched: n,
    v2Mae: n ? acc.v2Error / n : null,
    diverseMae: n ? acc.diverseError / n : null,
    persistenceMae: n ? acc.persistenceError / n : null,
    v2IntervalCoverage: n ? acc.v2Covered / n : null,
    diverseIntervalCoverage: n ? acc.diverseCovered / n : null,
    v2MeanIntervalWidth: n ? acc.v2Width / n : null,
    diverseMeanIntervalWidth: n ? acc.diverseWidth / n : null,
    provisionalSelectedEpisodeSlots: acc.provisionalSelectedEpisodeSlots,
    anchorsWithProvisionalSelection: acc.anchorsWithProvisionalSelection,
  }
}

export function runDiverseBacktest(rows, horizonHours) {
  checkRows(rows)
  if (!HORIZONS.includes(horizonHours)) throw new Error('Unsupported horizon')
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
  const quarters = Array.from({ length: 4 }, empty)
  const nonOverlappingAnchorIndexes = []
  let nextNonOverlapAt = -Infinity
  for (let i = 0; i < rows.length; i++) {
    const v2 = forecastAt(rows, outcomes, i, horizonHours)
    const diverse = diverseForecastAt(rows, outcomes, i, horizonHours)
    const value = outcomes[i]
    const outcome = rows.at(-1).at < value.target + TOLERANCE ? { status: 'pending_window' } : value
    const quarter =
      i < Math.floor(rows.length * 0.25)
        ? 0
        : i < Math.floor(rows.length * 0.5)
          ? 1
          : i < split
            ? 2
            : 3
    add(quarters[quarter], v2, diverse, outcome)
    if (i < split) continue
    add(rolling, v2, diverse, outcome)
    if (rows[i].quote < cutLow) add(lower, v2, diverse, outcome)
    if (rows[i].at > nextNonOverlapAt) {
      add(nonOverlapping, v2, diverse, outcome)
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
      minimumDistinctEpisodes: MIN,
      episodeInterval: 'closed [start.at, start.at + horizon + 90 minutes]',
      nearestOrder: 'absolute quote-level distance asc, source index desc',
      nonOverlapSpacingSeconds: horizonHours * HOUR + TOLERANCE,
      nonOverlapBoundary: 'closed evaluation windows; next start strictly after previous end',
      provisionalRule: 'observed endpoint may be selected before its target ±90m window closes',
      interval: 'selected-analog delta p10-p90; uncalibrated',
      denominator: 'v2, diverse and persistence metrics use identical matched observed anchors',
    },
    rolling: summary(rolling),
    nonOverlapping: summary(nonOverlapping),
    nonOverlappingAnchorIndexes,
    temporalQuartiles: quarters.map((acc, i) => ({ quarter: i + 1, ...summary(acc) })),
    finalQuarterLowerQuoteRegime: {
      lowerThan: cutLow,
      upperThan: cutHigh,
      ...summary(lower),
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2)
    throw new Error('Usage: node scripts/research/curve-quote-diverse-backtest.mjs')
  const rows = readHistorical()
  console.log(
    JSON.stringify({
      study: 'exploratory diverse-episode quote analog candidate versus v2 and persistence',
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
      horizons: HORIZONS.map((h) => runDiverseBacktest(rows, h)),
    }),
  )
}
