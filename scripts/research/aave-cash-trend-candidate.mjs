// Frozen offline sampled-cash candidate. Historical proxy study only.
// node scripts/research/aave-cash-trend-candidate.mjs --amount-usd 1000000 --horizon-hours 24
import { pathToFileURL } from 'node:url'
import {
  MAX_GAP_SECONDS,
  SOURCE,
  evaluateHorizon,
  labelMarketSeries,
} from './aave-cash-horizon-labels.mjs'
import { MARKETS, readCheckpoint } from './aave-stable-expansion.mjs'

export const MIN_TRAIL_SECONDS = 18 * 3600
export const MAX_TRAIL_SECONDS = 30 * 3600
export const TARGET_TRAIL_SECONDS = 24 * 3600

export function trailingDecline(rows, anchorIndex) {
  const anchor = rows[anchorIndex]
  if (!anchor || anchor.kind !== 'observed') return null
  let best = null
  let previous = anchor
  for (let j = anchorIndex - 1; j >= 0; j--) {
    const prior = rows[j]
    const elapsed = anchor.at - prior.at
    if (previous.at - prior.at > MAX_GAP_SECONDS || prior.kind !== 'observed') break
    if (elapsed > MAX_TRAIL_SECONDS) break
    if (elapsed >= MIN_TRAIL_SECONDS) {
      const distance = Math.abs(elapsed - TARGET_TRAIL_SECONDS)
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && elapsed < best.elapsed)
      )
        best = {
          priorAt: prior.at,
          elapsed,
          distance,
          declineRate: Math.max(0, prior.cashUsdAssumingPeg - anchor.cashUsdAssumingPeg) / elapsed,
        }
    }
    previous = prior
  }
  return (
    best && {
      priorAt: best.priorAt,
      elapsedSeconds: best.elapsed,
      declineRateUsdPerSecond: best.declineRate,
    }
  )
}

export function predictAnchor(rows, anchorIndex, amountUsd, horizonSeconds) {
  const trail = trailingDecline(rows, anchorIndex)
  if (!trail) return null
  return (
    rows[anchorIndex].cashUsdAssumingPeg - trail.declineRateUsdPerSecond * horizonSeconds <
    amountUsd
  )
}

const emptyScore = () => ({
  tp: 0,
  fp: 0,
  tn: 0,
  fn: 0,
  abstainedObserved: 0,
  abstainedCensored: 0,
  censored: 0,
  censoredWarnings: 0,
  falseWarningAnchors: 0,
  warningRuns: { total: 0, supported: 0, unsupported: 0, maxSampledAnchorSpanHours: 0 },
  events: { total: 0, captured: 0, missed: 0, leadToFirstSampledBelowQHours: [] },
})

function firstDowncrossing(rows, anchorIndex, targetObservedAt, amountUsd) {
  for (let j = anchorIndex + 1; j < rows.length && rows[j].at <= targetObservedAt; j++)
    if (rows[j].cashUsdAssumingPeg < amountUsd) return rows[j].at
  return null
}

export function evaluateMarketSeries(rows, options) {
  const labels = labelMarketSeries(rows, options)
  const indexByBlock = new Map(rows.map((row, index) => [row.block, index]))
  const periods = { train: [], holdout: [] }
  for (const label of labels) {
    const index = indexByBlock.get(label.anchorBlock)
    if (index === undefined) throw new Error('Label anchor absent from market series')
    const currentCash = rows[index].cashUsdAssumingPeg
    const predictions = {
      trend: predictAnchor(rows, index, options.amountUsd, options.horizonSeconds),
      alwaysNoCrossing: false,
      cashRatioBelowTwo: currentCash / options.amountUsd < 2,
    }
    const eventAt =
      label.status === 'observed' && label.sampledCashBelowAmount
        ? firstDowncrossing(rows, index, label.targetObservedAt, options.amountUsd)
        : null
    if (label.sampledCashBelowAmount && eventAt === null)
      throw new Error('Positive label lacks a below-q future sample')
    periods[label.split].push({ label, predictions, eventAt })
  }
  return periods
}

function score(records, arm) {
  const result = emptyScore()
  const eventMap = new Map()
  let run = null
  const closeRun = () => {
    if (!run) return
    result.warningRuns.total++
    result.warningRuns[run.supported ? 'supported' : 'unsupported']++
    result.warningRuns.maxSampledAnchorSpanHours = Math.max(
      result.warningRuns.maxSampledAnchorSpanHours,
      (run.lastAt - run.firstAt) / 3600,
    )
    run = null
  }
  for (const record of [...records].sort(
    (a, b) => a.label.market.localeCompare(b.label.market) || a.label.anchorAt - b.label.anchorAt,
  )) {
    const { label, eventAt } = record
    const warning = record.predictions[arm]
    if (label.status === 'observed' && warning === true) {
      if (!run || run.market !== label.market || label.anchorAt - run.lastAt > MAX_GAP_SECONDS) {
        closeRun()
        run = {
          market: label.market,
          firstAt: label.anchorAt,
          lastAt: label.anchorAt,
          supported: false,
        }
      }
      run.lastAt = label.anchorAt
      if (label.sampledCashBelowAmount) run.supported = true
    } else closeRun()
    if (label.status === 'censored') {
      result.censored++
      if (warning === true) result.censoredWarnings++
      if (warning === null) result.abstainedCensored++
      continue
    }
    if (eventAt !== null) {
      const eventKey = `${label.market}:${eventAt}`
      const event = eventMap.get(eventKey) ?? { at: eventAt, captured: false, firstWarningAt: null }
      if (warning === true) {
        event.captured = true
        event.firstWarningAt = Math.min(event.firstWarningAt ?? label.anchorAt, label.anchorAt)
      }
      eventMap.set(eventKey, event)
    }
    if (warning === null) {
      result.abstainedObserved++
      continue
    }
    if (warning) {
      if (label.sampledCashBelowAmount) result.tp++
      else result.fp++
    } else if (label.sampledCashBelowAmount) result.fn++
    else result.tn++
  }
  closeRun()
  result.falseWarningAnchors = result.fp
  result.events.total = eventMap.size
  for (const event of eventMap.values()) {
    if (event.captured) {
      result.events.captured++
      result.events.leadToFirstSampledBelowQHours.push((event.at - event.firstWarningAt) / 3600)
    } else result.events.missed++
  }
  result.events.leadToFirstSampledBelowQHours.sort((a, b) => a - b)
  return result
}

export function scoreMarketPeriods(periods) {
  return Object.fromEntries(
    ['train', 'holdout'].map((split) => [
      split,
      {
        labels: {
          eligible: periods[split].length,
          observed: periods[split].filter((record) => record.label.status === 'observed').length,
          censored: periods[split].filter((record) => record.label.status === 'censored').length,
          observedPause: periods[split].filter(
            (record) => record.label.status === 'observed' && record.label.pauseObserved,
          ).length,
        },
        ...Object.fromEntries(
          ['trend', 'alwaysNoCrossing', 'cashRatioBelowTwo'].map((arm) => [
            arm,
            score(periods[split], arm),
          ]),
        ),
      },
    ]),
  )
}

export function evaluateCandidate(checkpoint, options) {
  const provenance = evaluateHorizon(checkpoint, options)
  const records = { train: [], holdout: [] }
  const markets = {}
  for (const market of MARKETS) {
    const rows = checkpoint.entries
      .filter((row) => row.market === market.name)
      .sort((a, b) => a.block - b.block)
    const periods = evaluateMarketSeries(rows, { ...options, boundaryAt: provenance.boundaryAt })
    markets[market.name] = scoreMarketPeriods(periods)
    for (const split of ['train', 'holdout']) records[split].push(...periods[split])
  }
  return {
    study: 'aave-v3-sampled-cash-frozen-trend-candidate-v1',
    exploratory: true,
    source: provenance.source,
    sourceEntriesSha256: provenance.sourceEntriesSha256,
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    boundaryAt: provenance.boundaryAt,
    purgeSeconds: provenance.purgeSeconds,
    maxGapSeconds: provenance.maxGapSeconds,
    maxTargetObservationLagSeconds: provenance.maxTargetObservationLagSeconds,
    trailingSeconds: {
      min: MIN_TRAIL_SECONDS,
      target: TARGET_TRAIL_SECONDS,
      max: MAX_TRAIL_SECONDS,
    },
    total: scoreMarketPeriods(records),
    markets,
    caveats: [
      'Historical sampled reserve cash is a proxy, not a same-holder executable withdrawal or continuous exit outcome.',
      'The original holdout outcomes were known before this rule was frozen; this is exploratory historical backtesting, not blind validation.',
      'Overlapping anchor labels are dependent; event counts deduplicate by the first observed future below-q sample within each reserve and split.',
      'Warning runs are descriptive groups of consecutive observed warned anchors, not independent events or real notifications.',
      'Lead is measured to the first sampled below-q observation, not the unobserved crossing time; adjacent samples can be up to 8h apart and the horizon target sample can lag up to 8h.',
      'Pause is reported separately by source labels and never counted as a cash breach.',
      'No forecast, probability, exit duration, or alert is produced.',
    ],
  }
}

function cli(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!['--amount-usd', '--horizon-hours'].includes(key) || argv[i + 1] === undefined)
      throw new Error(`Unknown or incomplete argument ${key}`)
    opts[key] = argv[++i]
  }
  if (opts['--amount-usd'] === undefined || opts['--horizon-hours'] === undefined)
    throw new Error('Usage: --amount-usd Q --horizon-hours H')
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  return evaluateCandidate(checkpoint, {
    amountUsd: Number(opts['--amount-usd']),
    horizonSeconds: Number(opts['--horizon-hours']) * 3600,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(cli(process.argv.slice(2))))
