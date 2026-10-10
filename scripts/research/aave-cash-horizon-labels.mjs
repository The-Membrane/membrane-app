// Offline labels for sampled Aave V3 reserve cash. No wallet execution inference.
// node scripts/research/aave-cash-horizon-labels.mjs --amount-usd 1000000 --horizon-hours 24
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  COUNT,
  GRID,
  MARKETS,
  readCheckpoint,
  validateCheckpoint,
} from './aave-stable-expansion.mjs'

export const SOURCE = resolve('data/research/venue-signals/aave-stable-expansion-v2.json')
export const MAX_GAP_SECONDS = 8 * 3600
export const MIN_HORIZON_SECONDS = MAX_GAP_SECONDS
export const MAX_HORIZON_SECONDS = 30 * 86400
export const PURGE_SECONDS = 86400
export const BOUNDARY_BLOCK = GRID.first + Math.floor(COUNT * 0.7) * GRID.step

function validateOptions({ amountUsd, horizonSeconds, asOfAt }) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('amountUsd must be > 0')
  if (
    !Number.isSafeInteger(horizonSeconds) ||
    horizonSeconds < MIN_HORIZON_SECONDS ||
    horizonSeconds > MAX_HORIZON_SECONDS
  )
    throw new Error('horizonSeconds must be an integer from 8h through 30d')
  if (asOfAt !== undefined && (!Number.isSafeInteger(asOfAt) || asOfAt <= 0))
    throw new Error('asOfAt must be a positive Unix second')
}

// Input rows are already verified by readCheckpoint/validateCheckpoint. This
// pure function is also testable with a short synthetic market series.
export function labelMarketSeries(rows, { amountUsd, horizonSeconds, boundaryAt, asOfAt }) {
  validateOptions({ amountUsd, horizonSeconds, asOfAt })
  if (!Number.isSafeInteger(boundaryAt) || boundaryAt <= 0)
    throw new Error('Missing frozen boundary timestamp')
  const source = rows.filter((row) => asOfAt === undefined || row.at <= asOfAt)
  for (let i = 1; i < source.length; i++)
    if (source[i].at <= source[i - 1].at) throw new Error('Market rows must be time-ordered')
  const labels = []
  for (let i = 0; i < source.length; i++) {
    const anchor = source[i]
    if (
      anchor.kind !== 'observed' ||
      !anchor.active ||
      anchor.withdrawPaused ||
      anchor.cashUsdAssumingPeg < amountUsd
    )
      continue
    const targetAt = anchor.at + horizonSeconds
    const windowEnd = targetAt + MAX_GAP_SECONDS
    // The entire label window, including allowed observation lag, belongs to
    // one split and must avoid the boundary's 24h purge on both sides.
    if (anchor.at <= boundaryAt + PURGE_SECONDS && windowEnd >= boundaryAt - PURGE_SECONDS) continue
    const split = windowEnd < boundaryAt - PURGE_SECONDS ? 'train' : 'holdout'
    let cashBelow = false
    let pauseObserved = false
    let targetObservedAt = null
    let previousAt = anchor.at
    let censorReason = null
    for (let j = i + 1; j < source.length; j++) {
      const row = source[j]
      if (row.at - previousAt > MAX_GAP_SECONDS) {
        censorReason = 'gap'
        break
      }
      if (row.kind !== 'observed') {
        censorReason = 'ineligible_future_sample'
        break
      }
      if (row.cashUsdAssumingPeg < amountUsd) cashBelow = true
      if (row.withdrawPaused) pauseObserved = true
      previousAt = row.at
      if (row.at >= targetAt) {
        targetObservedAt = row.at
        break
      }
    }
    if (targetObservedAt === null && censorReason === null)
      censorReason = asOfAt === undefined ? 'near_end' : 'pending_as_of'
    labels.push({
      market: anchor.market,
      anchorBlock: anchor.block,
      anchorAt: anchor.at,
      anchorCashUsd: anchor.cashUsdAssumingPeg,
      split,
      status: censorReason === null ? 'observed' : 'censored',
      censorReason,
      sampledCashBelowAmount: censorReason === null ? cashBelow : null,
      pauseObserved: censorReason === null ? pauseObserved : null,
      targetAt,
      targetObservedAt,
      targetObservationLagSeconds: targetObservedAt === null ? null : targetObservedAt - targetAt,
    })
  }
  return labels
}

function counts(labels) {
  const out = {
    eligible: labels.length,
    observed: 0,
    sampledCashBelow: 0,
    pauseObserved: 0,
    quiet: 0,
    censored: 0,
    censoredReasons: {},
  }
  for (const row of labels) {
    if (row.status === 'censored') {
      out.censored++
      out.censoredReasons[row.censorReason] = (out.censoredReasons[row.censorReason] || 0) + 1
    } else {
      out.observed++
      if (row.sampledCashBelowAmount) out.sampledCashBelow++
      if (row.pauseObserved) out.pauseObserved++
      if (!row.sampledCashBelowAmount && !row.pauseObserved) out.quiet++
    }
  }
  return out
}

export function evaluateHorizon(checkpoint, options) {
  validateOptions(options)
  validateCheckpoint(checkpoint)
  if (
    checkpoint?.status !== 'complete' ||
    checkpoint.entries?.length !== COUNT * MARKETS.length ||
    checkpoint.failures?.length !== 0
  )
    throw new Error('Complete 1569-sample grid for all eight markets required')
  const entries = checkpoint.entries
  const boundaryRows = entries.filter((row) => row.block === BOUNDARY_BLOCK)
  if (
    boundaryRows.length !== MARKETS.length ||
    new Set(boundaryRows.map((row) => row.at)).size !== 1
  )
    throw new Error('Missing or contradictory frozen boundary')
  const boundaryAt = boundaryRows[0].at
  const markets = {}
  let maxTargetObservationLagSeconds = 0
  for (const market of MARKETS) {
    const rows = entries
      .filter((row) => row.market === market.name)
      .sort((a, b) => a.block - b.block)
    if (rows.length !== COUNT) throw new Error(`Incomplete ${market.name} grid`)
    for (let i = 0; i < rows.length; i++)
      if (rows[i].block !== GRID.first + i * GRID.step)
        throw new Error(`Incomplete ${market.name} grid`)
    const labels = labelMarketSeries(rows, { ...options, boundaryAt })
    for (const label of labels)
      if (label.targetObservationLagSeconds !== null)
        maxTargetObservationLagSeconds = Math.max(
          maxTargetObservationLagSeconds,
          label.targetObservationLagSeconds,
        )
    markets[market.name] = {
      train: counts(labels.filter((x) => x.split === 'train')),
      holdout: counts(labels.filter((x) => x.split === 'holdout')),
    }
  }
  return {
    study: 'aave-v3-sampled-cash-horizon-labels-v1',
    source: SOURCE,
    sourceEntriesSha256: checkpoint.entriesSha256,
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    asOfAt: options.asOfAt ?? null,
    boundaryBlock: BOUNDARY_BLOCK,
    boundaryAt,
    purgeSeconds: PURGE_SECONDS,
    maxGapSeconds: MAX_GAP_SECONDS,
    maxTargetObservationLagSeconds,
    markets,
    caveats: [
      'Overlapping anchor windows are dependent; counts are not independent episodes.',
      'Historical sampled reserve cash is a proxy, not a same-holder executable withdrawal or continuous exit outcome.',
      'The original 70/30 holdout has already been seen; this is exploratory historical evaluation, not blind validation.',
      'No forecast, probability, exit duration, or alert is produced.',
    ],
  }
}

function cli(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!['--amount-usd', '--horizon-hours', '--as-of'].includes(key) || argv[i + 1] === undefined)
      throw new Error(`Unknown or incomplete argument ${key}`)
    opts[key] = argv[++i]
  }
  if (opts['--amount-usd'] === undefined || opts['--horizon-hours'] === undefined)
    throw new Error('Usage: --amount-usd Q --horizon-hours H [--as-of UnixSeconds]')
  const amountUsd = Number(opts['--amount-usd'])
  const horizonSeconds = Number(opts['--horizon-hours']) * 3600
  const asOfAt = opts['--as-of'] === undefined ? undefined : Number(opts['--as-of'])
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  return evaluateHorizon(checkpoint, { amountUsd, horizonSeconds, asOfAt })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(cli(process.argv.slice(2))))
