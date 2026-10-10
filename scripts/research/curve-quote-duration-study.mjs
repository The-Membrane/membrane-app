// Offline exploratory duration study of a nominal $1m two-pool crvUSD quote.
// This does not measure vault redemption or an executable fill.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { artifactPath } from './local-artifacts.mjs'

export const THRESHOLD = 0.999 // Predeclared: 10 bp below a nominal $1 peg.
export const HORIZONS = [24, 72, 168]
const HOUR = 3600
const MAX_GAP = 4 * HOUR
const TREND_TOLERANCE = 90 * 60
const MAX_HORIZON = 168 * HOUR + TREND_TOLERANCE
const K = 80
const MIN_RISK_SET = 30
const MIN_EVENTS = 5
const NAME = 'scrvusd-size-aware-400d'
const SHA = 'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a'

export function prepareRows(input) {
  if (!Array.isArray(input)) throw new Error('Rows required')
  return input.map((row, i) => {
    const quote = row.quote ?? row.routes?.[1000000]?.bestQuote
    if (
      !Number.isSafeInteger(row.at) ||
      !Number.isFinite(quote) ||
      quote < 0 ||
      (i && row.at <= input[i - 1].at)
    )
      throw new Error(`Invalid or nonmonotonic quote row ${i}`)
    return { at: row.at, block: row.block, quote }
  })
}

export function pastTrend(rows, index) {
  const target = rows[index].at - 24 * HOUR
  let best = -1
  for (let j = index - 1; j >= 0 && rows[j].at >= target - TREND_TOLERANCE; j--) {
    if (
      Math.abs(rows[j].at - target) <= TREND_TOLERANCE &&
      (best < 0 || Math.abs(rows[j].at - target) < Math.abs(rows[best].at - target))
    )
      best = j
  }
  if (best < 0) return null
  for (let j = best + 1; j <= index; j++) if (rows[j].at - rows[j - 1].at > MAX_GAP) return null
  return rows[index].quote - rows[best].quote
}

export function firstBreach(rows, anchorIndex, observedThroughIndex = rows.length - 1) {
  if (
    !Number.isSafeInteger(anchorIndex) ||
    anchorIndex < 0 ||
    anchorIndex >= rows.length ||
    !Number.isSafeInteger(observedThroughIndex) ||
    observedThroughIndex < anchorIndex ||
    observedThroughIndex >= rows.length
  )
    throw new Error('Invalid observation indexes')
  const anchor = rows[anchorIndex]
  if (anchor.quote <= THRESHOLD) return { status: 'ineligible_anchor' }
  const limitAt = anchor.at + MAX_HORIZON
  let prior = anchorIndex
  for (let j = anchorIndex + 1; j <= observedThroughIndex; j++) {
    if (rows[j].at > limitAt) break
    if (rows[j].at - rows[prior].at > MAX_GAP)
      return {
        status: 'censored_gap',
        lastNotBelowAt: rows[prior].at,
        durationHours: (rows[prior].at - anchor.at) / HOUR,
      }
    if (rows[j].quote < THRESHOLD)
      return {
        status: 'breach',
        interval: [rows[prior].at, rows[j].at],
        durationHours: (rows[j].at - anchor.at) / HOUR,
        previousNotBelowHours: (rows[prior].at - anchor.at) / HOUR,
      }
    prior = j
  }
  const endAt = Math.min(rows[prior].at, limitAt)
  return {
    status: prior === observedThroughIndex ? 'censored_end' : 'censored_horizon',
    lastNotBelowAt: endAt,
    durationHours: (endAt - anchor.at) / HOUR,
  }
}

// An interval crossing a horizon is unresolved: the breach may have occurred on either side.
export function observedAtHorizon(outcome, horizonHours) {
  if (outcome.status === 'breach') {
    if (outcome.durationHours <= horizonHours) return 0
    if (outcome.previousNotBelowHours >= horizonHours) return 1
    return null
  }
  return outcome.durationHours >= horizonHours ? 1 : null
}

function wilson(successes, n) {
  const z = 1.96
  const p = successes / n
  const d = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / d
  const span = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / d
  return [Math.max(0, center - span), Math.min(1, center + span)]
}

// Complete-horizon empirical estimate; censored or interval-ambiguous cases are reported, not imputed.
// This is descriptive uncertainty for sampled rows, not independent-event calibration.
export function survivalAt(
  outcomes,
  horizonHours,
  { minRisk = MIN_RISK_SET, minEvents = MIN_EVENTS } = {},
) {
  if (!HORIZONS.includes(horizonHours)) throw new Error('Unsupported horizon')
  let survived = 0,
    breaches = 0,
    censored = 0,
    intervalAmbiguous = 0
  for (const outcome of outcomes) {
    const value = observedAtHorizon(outcome, horizonHours)
    if (value === 1) survived++
    else if (value === 0) breaches++
    else if (outcome.status === 'breach') intervalAmbiguous++
    else censored++
  }
  const riskSet = survived + breaches
  const sufficient = riskSet >= minRisk && breaches >= minEvents
  return {
    riskSet,
    observedBreaches: breaches,
    observedAtOrAbove: survived,
    censored,
    intervalAmbiguous,
    status: sufficient ? 'exploratory_estimate' : 'abstain_insufficient_risk_or_events',
    noBelowThresholdBreachFraction: sufficient ? survived / riskSet : null,
    descriptiveWilson95: sufficient ? wilson(survived, riskSet) : null,
  }
}

export function forecastAt(rows, index, horizonHours, options = {}) {
  if (!HORIZONS.includes(horizonHours)) throw new Error('Unsupported horizon')
  if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length)
    throw new Error('Invalid anchor')
  if (rows[index].quote <= THRESHOLD) return { status: 'ineligible_anchor' }
  const trend = pastTrend(rows, index)
  if (trend === null) return { status: 'incomplete_24h_history' }
  const candidates = []
  for (let j = 0; j < index; j++) {
    if (rows[j].quote <= THRESHOLD) continue
    const candidateTrend = pastTrend(rows, j)
    if (candidateTrend === null) continue
    // Every candidate outcome stops at the target anchor. No future observation is used.
    const outcome = firstBreach(rows, j, index)
    const distance =
      Math.abs(rows[j].quote - rows[index].quote) / 0.002 + Math.abs(candidateTrend - trend) / 0.002
    candidates.push({ j, distance, outcome })
  }
  const eligible = candidates.filter(({ outcome }) => outcome.durationHours > 0)
  eligible.sort((a, b) => a.distance - b.distance || b.j - a.j)
  const selected = eligible.slice(0, options.k ?? K)
  return {
    status: 'research_only',
    anchorAt: rows[index].at,
    horizonHours,
    currentQuote: rows[index].quote,
    threshold: THRESHOLD,
    availablePastAnchors: eligible.length,
    selectedAnalogs: selected.length,
    analog: survivalAt(
      selected.map((item) => item.outcome),
      horizonHours,
      options,
    ),
    unconditional: survivalAt(
      eligible.map((item) => item.outcome),
      horizonHours,
      options,
    ),
  }
}

export function nonOverlappingIndexes(rows, split, horizonHours) {
  const selected = []
  let next = -Infinity
  for (let i = split; i < rows.length; i++) {
    if (rows[i].at < next) continue
    selected.push(i) // selected by timestamp, before outcome inspection
    next = rows[i].at + horizonHours * HOUR + MAX_GAP
  }
  return selected
}

function evaluateIndexes(rows, indexes, horizonHours) {
  const result = {
    anchors: indexes.length,
    eligibleAnchors: 0,
    resolvedOutcomes: 0,
    scoredAnalog: 0,
    scoredUnconditional: 0,
    analogBrier: null,
    unconditionalBrier: null,
    unconditionalOnAnalogAnchorsBrier: null,
    exclusions: {
      ineligible_anchor: 0,
      incomplete_24h_history: 0,
      unresolved_outcome: 0,
      abstain_analog: 0,
      abstain_unconditional: 0,
    },
  }
  let analogSum = 0,
    baselineSum = 0,
    pairedBaselineSum = 0,
    pairedBaselineCount = 0
  for (const i of indexes) {
    const forecast = forecastAt(rows, i, horizonHours)
    if (forecast.status !== 'research_only') {
      result.exclusions[forecast.status]++
      continue
    }
    result.eligibleAnchors++
    const actual = observedAtHorizon(firstBreach(rows, i), horizonHours)
    if (actual === null) {
      result.exclusions.unresolved_outcome++
      continue
    }
    result.resolvedOutcomes++
    if (
      forecast.analog.status === 'exploratory_estimate' &&
      forecast.unconditional.status === 'exploratory_estimate'
    ) {
      pairedBaselineSum += (forecast.unconditional.noBelowThresholdBreachFraction - actual) ** 2
      pairedBaselineCount++
    }
    for (const [key, countKey] of [
      ['analog', 'scoredAnalog'],
      ['unconditional', 'scoredUnconditional'],
    ]) {
      const estimate = forecast[key]
      if (estimate.status !== 'exploratory_estimate') {
        result.exclusions[`abstain_${key}`]++
        continue
      }
      const error = (estimate.noBelowThresholdBreachFraction - actual) ** 2
      if (key === 'analog') analogSum += error
      else baselineSum += error
      result[countKey]++
    }
  }
  result.analogBrier = result.scoredAnalog ? analogSum / result.scoredAnalog : null
  result.unconditionalBrier = result.scoredUnconditional
    ? baselineSum / result.scoredUnconditional
    : null
  result.unconditionalOnAnalogAnchorsBrier = pairedBaselineCount
    ? pairedBaselineSum / pairedBaselineCount
    : null
  return result
}

export function runStudy(input) {
  const rows = prepareRows(input)
  const split = Math.floor(rows.length * 0.75)
  const eligible = rows
    .map((row, i) => (row.quote > THRESHOLD ? firstBreach(rows, i) : null))
    .filter(Boolean)
  return {
    threshold: THRESHOLD,
    sourceRows: rows.length,
    sourceRange: [rows[0]?.at ?? null, rows.at(-1)?.at ?? null],
    allAnchors: {
      eligible: eligible.length,
      observedBreaches: eligible.filter((x) => x.status === 'breach').length,
      censoredGap: eligible.filter((x) => x.status === 'censored_gap').length,
      censoredEnd: eligible.filter((x) => x.status === 'censored_end').length,
      noBelowThresholdBreach: Object.fromEntries(HORIZONS.map((h) => [h, survivalAt(eligible, h)])),
    },
    finalQuarter: HORIZONS.map((h) => ({
      horizonHours: h,
      rolling: evaluateIndexes(
        rows,
        Array.from({ length: rows.length - split }, (_, k) => split + k),
        h,
      ),
      strictNonoverlap: evaluateIndexes(rows, nonOverlappingIndexes(rows, split, h), h),
    })),
  }
}

export function assertSealedSourcePath(path) {
  if (!path.endsWith(`/${SHA}.json`)) throw new Error('Unexpected source SHA')
  return path
}

function cli() {
  if (process.argv.length !== 2) throw new Error('Usage: curve-quote-duration-study.mjs')
  const path = assertSealedSourcePath(artifactPath({ name: NAME }))
  const source = JSON.parse(readFileSync(path, 'utf8'))
  if (source.rows?.length !== 3184) throw new Error('Expected complete 3,184-row sealed source')
  console.log(
    JSON.stringify({
      study: 'exploratory $1m two-pool nominal quote first-breach duration',
      source: { name: NAME, sha256: SHA },
      method: {
        threshold: 'first observed quote below 0.999 after quote above 0.999',
        breachTime: 'interval between preceding sampled quote and first below-threshold quote',
        censoring: 'first observation gap over 4h, data end, or 7d administrative horizon',
        analog:
          'nearest 80 past anchors by quote and past 24h quote change; candidate observations cut at forecast anchor',
        baseline: 'all eligible past anchors, cut at forecast anchor',
        holdout:
          'rolling final quarter of explored corpus plus pre-outcome timestamp-spaced sensitivity',
        uncertainty:
          'Wilson interval on resolved sampled-anchor outcomes; dependent windows prevent calibration claim',
      },
      ...runStudy(source.rows),
      caveats: [
        'Nominal pinned get_dy quote, not vault redemption or executable fill.',
        'USDT and USDC valued at $1; gas, MEV, depeg and fill omitted.',
        'Previously explored corpus and overlapping windows; no product probability or alert.',
        'Incomplete observation intervals and gaps are never assumed to have avoided a below-threshold breach.',
      ],
    }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
