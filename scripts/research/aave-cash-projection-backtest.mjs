// Retrospective endpoint reserve-cash backtest. No executable-exit inference.
import { pathToFileURL } from 'node:url'
import {
  COUNT,
  GRID,
  MARKETS,
  readCheckpoint,
  validateCheckpoint,
} from './aave-stable-expansion.mjs'
import {
  BOUNDARY_BLOCK,
  MAX_HORIZON_SECONDS,
  MIN_HORIZON_SECONDS,
  SOURCE,
  labelMarketSeries,
} from './aave-cash-horizon-labels.mjs'
import { EXPECTED_SOURCE_ENTRIES_SHA256 } from './aave-cash-shortage-durations.mjs'
import { trailingDecline } from './aave-cash-trend-candidate.mjs'

export const MIN_TRAIN_ENDPOINTS = 30
export const MIN_NONOVERLAP_ENDPOINTS = 20
export const INTERVAL_TAIL_FRACTION = 0.1

function optionsValid({ market, amountUsd, horizonSeconds, boundaryAt, asOfAt }) {
  if (!MARKETS.some((x) => x.name === market)) throw new Error('Unknown Aave market')
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('amountUsd must be positive')
  if (
    !Number.isSafeInteger(horizonSeconds) ||
    horizonSeconds < MIN_HORIZON_SECONDS ||
    horizonSeconds > MAX_HORIZON_SECONDS
  )
    throw new Error('horizonSeconds must be an integer from 8h through 30d')
  if (!Number.isSafeInteger(boundaryAt) || boundaryAt <= 0)
    throw new Error('Missing frozen boundary')
  if (asOfAt !== undefined && (!Number.isSafeInteger(asOfAt) || asOfAt <= 0))
    throw new Error('asOfAt must be a positive Unix second')
}

function quantile(values, p) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)]
}

function intervalFrom(records, minSupport) {
  if (records.length < minSupport) return null
  const residuals = records.map((r) => r.endpointCashUsd - r.projectedCashUsd)
  return {
    lowerResidualUsd: quantile(residuals, INTERVAL_TAIL_FRACTION),
    upperResidualUsd: quantile(residuals, 1 - INTERVAL_TAIL_FRACTION),
    trainSupport: records.length,
  }
}

function nonoverlap(records) {
  const selected = []
  let lastTargetAt = -Infinity
  for (const record of records) {
    if (record.anchorAt < lastTargetAt) continue
    selected.push(record)
    lastTargetAt = record.targetObservedAt
  }
  return selected
}

function countReasons(records) {
  const counts = {}
  for (const record of records)
    if (record.status !== 'completed') counts[record.status] = (counts[record.status] || 0) + 1
  return counts
}

function metrics(records, interval) {
  const completed = records.filter((r) => r.status === 'completed')
  const predicted = completed.filter((r) => r.projectedCashUsd !== null)
  const errors = predicted.map((r) => r.projectedCashUsd - r.endpointCashUsd)
  let covered = 0
  let totalWidth = 0
  if (interval)
    for (const r of predicted) {
      const lower = Math.max(0, r.projectedCashUsd + interval.lowerResidualUsd)
      const upper = Math.max(lower, r.projectedCashUsd + interval.upperResidualUsd)
      if (r.endpointCashUsd >= lower && r.endpointCashUsd <= upper) covered++
      totalWidth += upper - lower
    }
  return {
    eligibleAnchors: records.length,
    completedEndpoints: completed.length,
    pointScored: predicted.length,
    pointAbstained: completed.length - predicted.length,
    excludedReasons: countReasons(records),
    meanAbsoluteErrorUsd: errors.length
      ? errors.reduce((s, x) => s + Math.abs(x), 0) / errors.length
      : null,
    biasPredictedMinusActualUsd: errors.length
      ? errors.reduce((s, x) => s + x, 0) / errors.length
      : null,
    intervalScored: interval ? predicted.length : 0,
    intervalCoverage: interval && predicted.length ? covered / predicted.length : null,
    meanIntervalWidthUsd: interval && predicted.length ? totalWidth / predicted.length : null,
  }
}

// Pure replay seam. Authentication and full-grid checks belong to the adapter below.
export function evaluateEndpointSeries(rows, options) {
  optionsValid(options)
  if (!Array.isArray(rows) || rows.some((r) => r.market !== options.market))
    throw new Error('Market rows must share the selected identity')
  const labels = labelMarketSeries(rows, options)
  const byBlock = new Map(rows.map((r, i) => [r.block, i]))
  const records = { train: [], holdout: [] }
  for (const label of labels) {
    const i = byBlock.get(label.anchorBlock)
    if (i === undefined) throw new Error('Missing anchor row')
    const anchor = rows[i]
    const trail = trailingDecline(
      rows.filter((r) => options.asOfAt === undefined || r.at <= options.asOfAt),
      i,
    )
    const projectedCashUsd = trail
      ? Math.max(
          0,
          anchor.cashUsdAssumingPeg - trail.declineRateUsdPerSecond * options.horizonSeconds,
        )
      : null
    const targetIndex =
      label.targetObservedAt === null
        ? -1
        : rows.findIndex((r, j) => j > i && r.at === label.targetObservedAt)
    if (label.status === 'observed' && targetIndex < 0) throw new Error('Observed endpoint missing')
    const between = targetIndex < 0 ? [] : rows.slice(i + 1, targetIndex + 1)
    const inactiveObserved = between.some((r) => !r.active)
    const status =
      label.status === 'censored'
        ? `censored_${label.censorReason}`
        : label.pauseObserved
          ? 'paused_window'
          : inactiveObserved
            ? 'inactive_window'
            : 'completed'
    records[label.split].push({
      market: options.market,
      anchorBlock: label.anchorBlock,
      anchorAt: label.anchorAt,
      targetAt: label.targetAt,
      targetObservedAt: label.targetObservedAt,
      targetObservationLagSeconds: label.targetObservationLagSeconds,
      status,
      anchorCashUsd: anchor.cashUsdAssumingPeg,
      projectedCashUsd,
      endpointCashUsd: targetIndex < 0 ? null : rows[targetIndex].cashUsdAssumingPeg,
      endpointCashBelowAmount:
        targetIndex < 0 ? null : rows[targetIndex].cashUsdAssumingPeg < options.amountUsd,
      anyWithinHorizonCashBelowAmount: label.sampledCashBelowAmount,
      pauseObserved: label.pauseObserved,
      inactiveObserved,
      trailingIntervalSeconds: trail?.elapsedSeconds ?? null,
    })
  }
  const trainCompleted = records.train.filter(
    (r) => r.status === 'completed' && r.projectedCashUsd !== null,
  )
  const trainNonoverlap = nonoverlap(trainCompleted)
  const holdoutNonoverlap = nonoverlap(
    records.holdout.filter((r) => r.status === 'completed' && r.projectedCashUsd !== null),
  )
  const interval = intervalFrom(trainCompleted, MIN_TRAIN_ENDPOINTS)
  const sensitivityInterval = intervalFrom(trainNonoverlap, MIN_NONOVERLAP_ENDPOINTS)
  return {
    study: 'aave-v3-retrospective-endpoint-cash-backtest-v1',
    market: options.market,
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    boundaryAt: options.boundaryAt,
    asOfAt: options.asOfAt ?? null,
    split: 'frozen 70/30 boundary and 24h purge from labelMarketSeries',
    endpoint: 'first complete observed sample at or after anchor + H, no more than 8h late',
    trainSupport: {
      completedWithProjection: trainCompleted.length,
      nonoverlap: trainNonoverlap.length,
      holdoutNonoverlapScored: holdoutNonoverlap.length,
    },
    empiricalResidualInterval: interval,
    nonoverlapSensitivityInterval: sensitivityInterval,
    train: metrics(records.train, interval),
    holdout: metrics(records.holdout, interval),
    holdoutNonoverlapSensitivity: metrics(holdoutNonoverlap, sensitivityInterval),
    records,
    caveats: [
      'The original holdout was known before this method; results are exploratory and descriptive, not blind validation.',
      'Overlapping windows are dependent; the main residual interval is fitted from train endpoints only, and nonoverlap sensitivity is reported separately.',
      'Endpoint reserve cash is distinct from any-within-H cash-below and from executable holder withdrawal; pause/inactive windows are excluded from fit and scoring.',
      'No likely duration, probability, alert, or prospective eligibility is established.',
    ],
  }
}

export function evaluateEndpointCheckpoint(checkpoint, options) {
  validateCheckpoint(checkpoint)
  if (
    checkpoint.entriesSha256 !== EXPECTED_SOURCE_ENTRIES_SHA256 ||
    checkpoint.status !== 'complete' ||
    checkpoint.entries.length !== COUNT * MARKETS.length ||
    checkpoint.failures.length
  )
    throw new Error('Frozen complete Aave checkpoint required')
  const boundaryRows = checkpoint.entries.filter((r) => r.block === BOUNDARY_BLOCK)
  if (boundaryRows.length !== MARKETS.length || new Set(boundaryRows.map((r) => r.at)).size !== 1)
    throw new Error('Frozen boundary missing or contradictory')
  const rows = checkpoint.entries
    .filter((r) => r.market === options.market)
    .sort((a, b) => a.block - b.block)
  if (rows.length !== COUNT || rows.some((r, i) => r.block !== GRID.first + i * GRID.step))
    throw new Error('Selected market grid incomplete')
  return {
    source: SOURCE,
    sourceEntriesSha256: checkpoint.entriesSha256,
    sourceAttestation: 'locally hash verified; not independently chain attested',
    ...evaluateEndpointSeries(rows, { ...options, boundaryAt: boundaryRows[0].at }),
  }
}

function cli(argv) {
  const values = {}
  const flags = new Set(['--market', '--amount-usd', '--horizon-hours', '--as-of-unix'])
  for (let i = 0; i < argv.length; i++) {
    if (!flags.has(argv[i]) || values[argv[i]] !== undefined || argv[i + 1] === undefined)
      throw new Error(`Unknown, repeated, or incomplete argument ${argv[i]}`)
    values[argv[i]] = argv[++i]
  }
  if (!values['--market'] || !values['--amount-usd'] || !values['--horizon-hours'])
    throw new Error(
      'Usage: --market MARKET --amount-usd Q --horizon-hours H [--as-of-unix UnixSeconds]',
    )
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  return evaluateEndpointCheckpoint(checkpoint, {
    market: values['--market'],
    amountUsd: Number(values['--amount-usd']),
    horizonSeconds: Number(values['--horizon-hours']) * 3600,
    asOfAt: values['--as-of-unix'] === undefined ? undefined : Number(values['--as-of-unix']),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(cli(process.argv.slice(2))))
