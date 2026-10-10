// Frozen-grid retrospective sampled-cash first-breach labels. No live forecast or alert.
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
  MAX_GAP_SECONDS,
  MAX_HORIZON_SECONDS,
  MIN_HORIZON_SECONDS,
  PURGE_SECONDS,
  SOURCE,
  labelMarketSeries,
} from './aave-cash-horizon-labels.mjs'
import { EXPECTED_SOURCE_ENTRIES_SHA256 } from './aave-cash-shortage-durations.mjs'
import { SCORE_AMOUNTS_USD, SCORE_HORIZONS_SECONDS } from './aave-usde-prospective-cash.mjs'

export const STUDY = 'aave-v3-retrospective-first-sampled-cash-breach-by-h-v1'

function validateOptions({ amountUsd, horizonSeconds, boundaryAt, asOfAt }) {
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

// This is deliberately layered on the sealed v1 eligibility, purge, and
// missing-witness rules. It changes only the event boundary: a below-q target
// witness after H may complete observation but cannot be a by-H breach.
export function strictBreachSeries(rows, options) {
  validateOptions(options)
  if (!Array.isArray(rows) || rows.some((row) => row.market !== rows[0]?.market))
    throw new Error('One market series is required')
  const source = rows.filter((row) => options.asOfAt === undefined || row.at <= options.asOfAt)
  const indexByBlock = new Map(source.map((row, index) => [row.block, index]))
  if (indexByBlock.size !== source.length) throw new Error('Duplicate market block')
  return labelMarketSeries(rows, options).map((legacy) => {
    const anchorIndex = indexByBlock.get(legacy.anchorBlock)
    if (anchorIndex === undefined) throw new Error('Missing label anchor')
    const pending =
      options.asOfAt !== undefined && options.asOfAt < legacy.targetAt + MAX_GAP_SECONDS
    if (legacy.status !== 'observed' || pending)
      return {
        ...legacy,
        status: pending ? 'pending' : legacy.status,
        censorReason: pending ? 'outcome_window_open_as_of' : legacy.censorReason,
        breachedByH: null,
        firstBreachByHAt: null,
        firstBreachByHBlock: null,
        firstBelowOnlyAfterH: null,
        legacyLagInclusiveBreach: null,
        sampledCashBelowAmount: null,
      }
    const firstBelow = source
      .slice(anchorIndex + 1)
      .find(
        (row) =>
          row.at <= legacy.targetObservedAt &&
          row.kind === 'observed' &&
          row.cashUsdAssumingPeg < options.amountUsd,
      )
    // The v1 label has already verified the complete path through the first
    // target witness; all examined rows before it belong to that path.
    const breachedByH = Boolean(firstBelow && firstBelow.at <= legacy.targetAt)
    return {
      ...legacy,
      breachedByH,
      firstBreachByHAt: breachedByH ? firstBelow.at : null,
      firstBreachByHBlock: breachedByH ? firstBelow.block : null,
      firstBelowOnlyAfterH:
        !breachedByH && firstBelow ? { at: firstBelow.at, block: firstBelow.block } : null,
      legacyLagInclusiveBreach: legacy.sampledCashBelowAmount,
    }
  })
}

function summarize(labels) {
  const out = {
    eligibleAnchors: labels.length,
    observed: 0,
    breachedByH: 0,
    noSampledBreachByH: 0,
    legacyLagInclusiveBreach: 0,
    legacyPositiveStrictNegative: 0,
    censored: 0,
    pending: 0,
    censorReasons: {},
    maxTargetObservationLagSeconds: 0,
  }
  for (const row of labels) {
    if (row.status !== 'observed') {
      out[row.status]++
      out.censorReasons[row.censorReason] = (out.censorReasons[row.censorReason] || 0) + 1
      continue
    }
    out.observed++
    if (row.breachedByH) out.breachedByH++
    else out.noSampledBreachByH++
    if (row.legacyLagInclusiveBreach) out.legacyLagInclusiveBreach++
    if (row.legacyLagInclusiveBreach && !row.breachedByH) out.legacyPositiveStrictNegative++
    out.maxTargetObservationLagSeconds = Math.max(
      out.maxTargetObservationLagSeconds,
      row.targetObservationLagSeconds,
    )
  }
  return out
}

function addCounts(left, right) {
  const out = { ...left, censorReasons: { ...left.censorReasons } }
  for (const [key, value] of Object.entries(right)) {
    if (key === 'censorReasons') {
      for (const [reason, count] of Object.entries(value))
        out.censorReasons[reason] = (out.censorReasons[reason] || 0) + count
    } else if (key === 'maxTargetObservationLagSeconds') out[key] = Math.max(out[key], value)
    else out[key] += value
  }
  return out
}

export function evaluateStrictBreach(checkpoint, options) {
  validateOptions({ ...options, boundaryAt: 1 })
  validateCheckpoint(checkpoint)
  if (checkpoint.entriesSha256 !== EXPECTED_SOURCE_ENTRIES_SHA256)
    throw new Error('Aave cash source cohort digest differs from frozen local source')
  if (
    checkpoint.status !== 'complete' ||
    checkpoint.entries.length !== COUNT * MARKETS.length ||
    checkpoint.failures.length
  )
    throw new Error('Complete 1569-sample grid for all eight markets required')
  const boundaryRows = checkpoint.entries.filter((row) => row.block === BOUNDARY_BLOCK)
  if (
    boundaryRows.length !== MARKETS.length ||
    new Set(boundaryRows.map((row) => row.at)).size !== 1
  )
    throw new Error('Missing or contradictory frozen boundary')
  const boundaryAt = boundaryRows[0].at
  const markets = {}
  const total = { train: summarize([]), holdout: summarize([]) }
  for (const market of MARKETS) {
    const rows = checkpoint.entries
      .filter((row) => row.market === market.name)
      .sort((a, b) => a.block - b.block)
    if (
      rows.length !== COUNT ||
      rows.some((row, index) => row.block !== GRID.first + index * GRID.step)
    )
      throw new Error(`Incomplete ${market.name} grid`)
    const labels = strictBreachSeries(rows, { ...options, boundaryAt })
    markets[market.name] = {
      train: summarize(labels.filter((row) => row.split === 'train')),
      holdout: summarize(labels.filter((row) => row.split === 'holdout')),
    }
    total.train = addCounts(total.train, markets[market.name].train)
    total.holdout = addCounts(total.holdout, markets[market.name].holdout)
  }
  return {
    study: STUDY,
    source: SOURCE,
    sourceEntriesSha256: checkpoint.entriesSha256,
    sourceAttestation: 'locally-hash-verified-checkpoint; not independently chain-attested',
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    asOfAt: options.asOfAt ?? null,
    boundaryBlock: BOUNDARY_BLOCK,
    boundaryAt,
    purgeSeconds: PURGE_SECONDS,
    maxGapSeconds: MAX_GAP_SECONDS,
    markets,
    total,
    caveats: [
      'This retrospectively reuses v1 anchor and completed-path labels; the target event alone changes to first sampled cash below q by H.',
      'The 70/30 holdout has already been seen. Overlapping anchors are dependent; these counts are exploratory, not blind validation.',
      'Block-time samples do not establish first local observation or feed completeness at decision time. This is not a prospective v2 score.',
      'Reserve cash under a $1 display assumption is not a fixed-holder executable exit outcome or continuous cash path.',
      'No calibrated probability, likely duration, forecast warning, or alert is produced.',
    ],
  }
}

export function evaluateStrictBreachGrid(checkpoint, { asOfAt } = {}) {
  return {
    study: `${STUDY}-fixed-grid`,
    cells: SCORE_AMOUNTS_USD.flatMap((amountUsd) =>
      SCORE_HORIZONS_SECONDS.map((horizonSeconds) =>
        evaluateStrictBreach(checkpoint, { amountUsd, horizonSeconds, asOfAt }),
      ),
    ),
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
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  const asOfAt = opts['--as-of'] === undefined ? undefined : Number(opts['--as-of'])
  if (opts['--amount-usd'] === undefined && opts['--horizon-hours'] === undefined)
    return evaluateStrictBreachGrid(checkpoint, { asOfAt })
  if (opts['--amount-usd'] === undefined || opts['--horizon-hours'] === undefined)
    throw new Error('Use both --amount-usd Q and --horizon-hours H, or neither for the grid')
  return evaluateStrictBreach(checkpoint, {
    amountUsd: Number(opts['--amount-usd']),
    horizonSeconds: Number(opts['--horizon-hours']) * 3600,
    asOfAt,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(cli(process.argv.slice(2))))
