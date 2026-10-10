// Offline, read-only walk-forward research on the sealed $1m two-pool nominal quote.
// Usage: node scripts/research/curve-quote-forecast-backtest.mjs [--horizons 24,168]
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { artifactPath } from './local-artifacts.mjs'

const NAME = 'scrvusd-size-aware-400d'
const SHA = 'ad1ef837f8050fec53dadd220553168510a8227e83e0520b57185b122a16224a'
const FLOW_NAME = 'scrvusd-upstream-400d'
const FLOW_SHA = '417451d6200bfadf4fe66ef4763dc8efce230f52d13f41fcf822b5ae5630cf52'
const HOUR = 3600
const GAP = 4 * HOUR
const TOLERANCE = 90 * 60
const MIN_ANALOGS = 30
const K = 40

function quantile(sorted, p) {
  if (!sorted.length) return null
  const place = (sorted.length - 1) * p
  const lo = Math.floor(place)
  return sorted[lo] + (sorted[Math.ceil(place)] - sorted[lo]) * (place - lo)
}

function nearest(rows, target, direction) {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (rows[mid].at < target) lo = mid + 1
    else hi = mid
  }
  const choices = [lo - 1, lo]
    .filter((i) => i >= 0 && i < rows.length)
    .filter((i) =>
      direction === 'past' ? rows[i].at < target + TOLERANCE : rows[i].at > target - TOLERANCE,
    )
  choices.sort((a, b) => Math.abs(rows[a].at - target) - Math.abs(rows[b].at - target))
  return choices[0] ?? -1
}

function complete(rows, start, end) {
  for (let i = start + 1; i <= end; i++) if (rows[i].at - rows[i - 1].at > GAP) return false
  return true
}

export function joinFlowRows(input, upstreamRows) {
  if (!Array.isArray(upstreamRows) || upstreamRows.length !== input.length)
    throw new Error('Upstream flow row count mismatch')
  return input.map((row, i) => {
    const flow = upstreamRows[i]
    const flow6h = flow?.netCrvUsdFlow6h?.total
    const flow24h = flow?.netCrvUsdFlow24h?.total
    if (
      row.block !== flow?.block ||
      row.at !== flow?.at ||
      !Number.isFinite(flow6h) ||
      !Number.isFinite(flow24h)
    )
      throw new Error(`Upstream flow identity/value mismatch at row ${i}`)
    return { ...row, flow6h, flow24h }
  })
}

export function prepareSeries(input, horizonHours, upstreamRows = null) {
  if (!Number.isSafeInteger(horizonHours) || horizonHours < 3 || horizonHours > 24 * 30)
    throw new Error('Horizon must be an integer from 3 to 720 hours')
  const joined = upstreamRows ? joinFlowRows(input, upstreamRows) : input
  const rows = joined.map((row) => ({
    at: row.at,
    block: row.block,
    quote: row.quote ?? row.routes?.[1000000]?.bestQuote,
    flow6h: row.flow6h,
    flow24h: row.flow24h,
  }))
  for (let i = 0; i < rows.length; i++) {
    if (
      !Number.isSafeInteger(rows[i].at) ||
      !Number.isFinite(rows[i].quote) ||
      rows[i].quote < 0 ||
      (i && rows[i].at <= rows[i - 1].at)
    )
      throw new Error(`Invalid/nonmonotonic row ${i}`)
  }
  const features = rows.map((row, i) => {
    const previous = nearest(rows, row.at - 24 * HOUR, 'past')
    return previous >= 0 &&
      previous < i &&
      Math.abs(rows[previous].at - (row.at - 24 * HOUR)) <= TOLERANCE &&
      complete(rows, previous, i)
      ? { trend24h: row.quote - rows[previous].quote }
      : null
  })
  const outcomes = rows.map((row, i) => {
    const end = nearest(rows, row.at + horizonHours * HOUR, 'future')
    return end > i &&
      Math.abs(rows[end].at - (row.at + horizonHours * HOUR)) <= TOLERANCE &&
      complete(rows, i, end)
      ? { end, at: rows[end].at, quote: rows[end].quote, delta: rows[end].quote - row.quote }
      : null
  })
  return { rows, features, outcomes, horizonHours }
}

export function forecastAt(series, index, { minAnalogs = MIN_ANALOGS, variant = 'quote' } = {}) {
  const { rows, features, outcomes, horizonHours } = series
  if (!['quote', 'flow'].includes(variant)) throw new Error('Unknown analog variant')
  if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length)
    throw new Error('Invalid anchor')
  const anchor = rows[index]
  if (anchor.quote === 0)
    return { status: 'unavailable', reason: 'zero_quote', anchorAt: anchor.at }
  if (!features[index])
    return { status: 'unavailable', reason: 'incomplete_24h_history', anchorAt: anchor.at }
  if (variant === 'flow' && (!Number.isFinite(anchor.flow6h) || !Number.isFinite(anchor.flow24h)))
    return { status: 'unavailable', reason: 'missing_flow', anchorAt: anchor.at }
  const candidates = []
  for (let j = 0; j < index; j++) {
    // A historical outcome is eligible only after its endpoint was observed at the anchor.
    if (
      rows[j].quote === 0 ||
      !features[j] ||
      !outcomes[j] ||
      outcomes[j].at > anchor.at ||
      (variant === 'flow' &&
        (!Number.isFinite(rows[j].flow6h) || !Number.isFinite(rows[j].flow24h)))
    )
      continue
    const quoteDistance = Math.abs(rows[j].quote - anchor.quote) / 0.002
    const trendDistance = Math.abs(features[j].trend24h - features[index].trend24h) / 0.002
    candidates.push({ j, distance: quoteDistance + trendDistance, delta: outcomes[j].delta })
  }
  if (candidates.length < minAnalogs)
    return {
      status: 'insufficient_sample',
      anchorAt: anchor.at,
      availableAnalogs: candidates.length,
      requiredAnalogs: minAnalogs,
    }
  if (variant === 'flow') {
    // Scales use only candidates whose complete outcomes were known at this anchor.
    for (const key of ['flow6h', 'flow24h']) {
      const values = candidates.map((item) => rows[item.j][key]).sort((a, b) => a - b)
      const scale = Math.max(quantile(values, 0.75) - quantile(values, 0.25), 1)
      for (const item of candidates)
        item.distance += Math.abs(rows[item.j][key] - anchor[key]) / scale
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || b.j - a.j)
  const selected = candidates.slice(0, K)
  const deltas = selected.map((item) => item.delta).sort((a, b) => a - b)
  const median = quantile(deltas, 0.5)
  return {
    status: 'research_forecast',
    variant,
    anchorAt: anchor.at,
    block: anchor.block,
    horizonHours,
    currentQuote: anchor.quote,
    projectedQuote: anchor.quote + median,
    empiricalAnalogInterval: [
      anchor.quote + quantile(deltas, 0.1),
      anchor.quote + quantile(deltas, 0.9),
    ],
    availableAnalogs: candidates.length,
    selectedAnalogs: selected.length,
    latestSelectedOutcomeAt: Math.max(...selected.map((item) => outcomes[item.j].at)),
    ...(variant === 'flow'
      ? { observedNetCrvUsdSold6h: anchor.flow6h, observedNetCrvUsdSold24h: anchor.flow24h }
      : {}),
    persistence: anchor.quote,
    recentTrend: anchor.quote + (features[index].trend24h * horizonHours) / 24,
  }
}

function metrics(errors) {
  return errors.length
    ? { n: errors.length, mae: errors.reduce((s, x) => s + Math.abs(x), 0) / errors.length }
    : { n: 0, mae: null }
}

function emptyEvaluation() {
  return {
    anchors: 0,
    evaluated: 0,
    exclusions: { unavailable: 0, insufficient_sample: 0, incomplete_outcome: 0 },
    errors: { analog: [], persistence: [], recentTrend: [], flowAnalog: [] },
    intervalCovered: 0,
    flowIntervalCovered: 0,
  }
}

function addEvaluation(evaluation, actual, forecast, flowForecast = null) {
  evaluation.anchors++
  if (!actual) {
    evaluation.exclusions.incomplete_outcome++
    return
  }
  if (forecast.status !== 'research_forecast') {
    evaluation.exclusions[forecast.status]++
    return
  }
  evaluation.evaluated++
  evaluation.errors.analog.push(forecast.projectedQuote - actual.quote)
  evaluation.errors.persistence.push(forecast.persistence - actual.quote)
  evaluation.errors.recentTrend.push(forecast.recentTrend - actual.quote)
  if (flowForecast) {
    if (flowForecast.status !== 'research_forecast')
      throw new Error('Flow variant unavailable on a quote-evaluable anchor')
    evaluation.errors.flowAnalog.push(flowForecast.projectedQuote - actual.quote)
    if (
      actual.quote >= flowForecast.empiricalAnalogInterval[0] &&
      actual.quote <= flowForecast.empiricalAnalogInterval[1]
    )
      evaluation.flowIntervalCovered++
  }
  if (
    actual.quote >= forecast.empiricalAnalogInterval[0] &&
    actual.quote <= forecast.empiricalAnalogInterval[1]
  )
    evaluation.intervalCovered++
}

function summarizeEvaluation(evaluation) {
  return {
    anchors: evaluation.anchors,
    evaluated: evaluation.evaluated,
    exclusions: evaluation.exclusions,
    analog: metrics(evaluation.errors.analog),
    persistence: metrics(evaluation.errors.persistence),
    recentTrend: metrics(evaluation.errors.recentTrend),
    flowAnalog: evaluation.errors.flowAnalog.length ? metrics(evaluation.errors.flowAnalog) : null,
    empiricalIntervalCoverage: evaluation.evaluated
      ? evaluation.intervalCovered / evaluation.evaluated
      : null,
    intervalCovered: evaluation.intervalCovered,
    flowEmpiricalIntervalCoverage: evaluation.errors.flowAnalog.length
      ? evaluation.flowIntervalCovered / evaluation.errors.flowAnalog.length
      : null,
    flowIntervalCovered: evaluation.errors.flowAnalog.length
      ? evaluation.flowIntervalCovered
      : null,
  }
}

export function nonOverlappingAnchorIndexes(rows, split, horizonHours) {
  const indexes = []
  let nextAt = -Infinity
  for (let i = split; i < rows.length; i++) {
    if (rows[i].at < nextAt) continue
    indexes.push(i)
    // The actual endpoint can arrive up to 90 minutes after the nominal target.
    nextAt = rows[i].at + horizonHours * HOUR + TOLERANCE
  }
  return indexes
}

export function runBacktest(input, horizonHours, options = {}) {
  const series = prepareSeries(input, horizonHours, options.flowRows)
  const split = Math.floor(series.rows.length * 0.75)
  const rolling = emptyEvaluation()
  const nonOverlapping = emptyEvaluation()
  const spacedIndexes = new Set(nonOverlappingAnchorIndexes(series.rows, split, horizonHours))
  for (let i = split; i < series.rows.length; i++) {
    const selected = spacedIndexes.has(i)
    const actual = series.outcomes[i]
    const forecast = actual ? forecastAt(series, i, { ...options, variant: 'quote' }) : null
    const flowForecast =
      actual && options.flowRows ? forecastAt(series, i, { ...options, variant: 'flow' }) : null
    addEvaluation(rolling, actual, forecast, flowForecast)
    if (selected) addEvaluation(nonOverlapping, actual, forecast, flowForecast)
  }
  const holdout = {
    splitAt: series.rows[split]?.at ?? null,
    evaluation: 'rolling final quarter of previously explored corpus; not untouched validation',
    ...summarizeEvaluation(rolling),
    nonOverlapping: {
      rule: 'first anchor, then earliest subsequent anchor at least horizon plus 90-minute endpoint tolerance later by timestamp; selected before outcome inspection',
      ...summarizeEvaluation(nonOverlapping),
    },
    promotion: 'research_only_no_alert',
  }
  const latestFlowAware = options.flowRows
    ? forecastAt(series, series.rows.length - 1, { ...options, variant: 'flow' })
    : null
  if (latestFlowAware?.status === 'research_forecast') {
    let minimum = series.rows[0]
    for (const row of series.rows) if (row.flow24h < minimum.flow24h) minimum = row
    latestFlowAware.historicalMostNegativeObserved24hSwapNet = {
      signedCrvUsdSoldIntoPools: minimum.flow24h,
      at: minimum.at,
      block: minimum.block,
      asOf: series.rows.at(-1).at,
      meaning: 'minimum of sampled past-24h signed Curve swap net; not gross or maximum vault flow',
    }
  }
  return {
    horizonHours,
    holdout,
    latest: forecastAt(series, series.rows.length - 1, { ...options, variant: 'quote' }),
    latestFlowAware,
  }
}

function cli() {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--horizons'))
    throw new Error('Usage: curve-quote-forecast-backtest.mjs [--horizons 24,168]')
  const horizons = args.length ? args[1].split(',').map(Number) : [24, 168]
  if (!horizons.length || new Set(horizons).size !== horizons.length)
    throw new Error('Duplicate/empty horizons')
  const path = artifactPath({ name: NAME }) // catalog verification includes exact file hash and row schema
  if (!path.endsWith(`/${SHA}.json`)) throw new Error('Unexpected source SHA')
  const flowPath = artifactPath({ name: FLOW_NAME })
  if (!flowPath.endsWith(`/${FLOW_SHA}.json`)) throw new Error('Unexpected upstream source SHA')
  const source = JSON.parse(readFileSync(path, 'utf8'))
  const flowSource = JSON.parse(readFileSync(flowPath, 'utf8'))
  if (source.rows.length !== 3184 || flowSource.features?.length !== 3184)
    throw new Error('Expected complete 3,184-row sealed artifacts')
  joinFlowRows(source.rows, flowSource.features) // fail before any horizon evaluation
  const results = horizons.map((h) =>
    runBacktest(source.rows, h, { flowRows: flowSource.features }),
  )
  console.log(
    JSON.stringify({
      study: 'exploratory $1m two-pool nominal quote forecast',
      source: {
        name: NAME,
        sha256: SHA,
        flowName: FLOW_NAME,
        flowSha256: FLOW_SHA,
        samples: source.rows.length,
      },
      method: {
        training:
          'walk-forward past-complete outcomes; nearest 40 analogs by current quote and 24h change',
        flowVariant:
          'same candidates and anchors; adds signed net crvUSD sold into pools over past 6h/24h, scaled by as-of candidate IQR',
        holdout:
          'chronological final 25% rolling evaluation of previously explored corpus; timestamp-strided sensitivity',
        interval: 'empirical analog delta p10-p90; uncalibrated',
      },
      results,
      caveats: [
        'Nominal pinned get_dy quote, not vault withdrawal, executable fill, or price prediction.',
        'USDT and USDC valued at $1; gas, MEV, depeg, fees and route execution omitted.',
        'Rolling anchors overlap; timestamp-strided sensitivity is smaller and neither view establishes calibrated probabilities or alert validity.',
        'Signed net flow is neither gross outflow nor maximum possible flow; it cannot establish an exit runway.',
        'Latest forecast is historical as of the sealed artifact endpoint, not live market state.',
      ],
    }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
