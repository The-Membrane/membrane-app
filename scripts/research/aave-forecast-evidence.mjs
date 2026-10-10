// Offline, retrospective Aave sampled-cash evidence. No RPC or notifications.
// node scripts/research/aave-forecast-evidence.mjs --market DAI --amount-usd 1000000 --horizon-hours 24
import { pathToFileURL } from 'node:url'
import {
  COUNT,
  GRID,
  MARKETS,
  readCheckpoint,
  validateCheckpoint,
} from './aave-stable-expansion.mjs'
import {
  MAX_GAP_SECONDS,
  MAX_HORIZON_SECONDS,
  MIN_HORIZON_SECONDS,
  SOURCE,
} from './aave-cash-horizon-labels.mjs'
import {
  EXPECTED_SOURCE_ENTRIES_SHA256,
  analyzeMarketSeries,
  summarizeMarket,
} from './aave-cash-shortage-durations.mjs'
import { trailingDecline } from './aave-cash-trend-candidate.mjs'
import {
  MIN_TRAIN_ENDPOINTS,
  evaluateEndpointCheckpoint,
} from './aave-cash-projection-backtest.mjs'
import { evaluateRecoveryCheckpoint } from './aave-cash-recovery-backtest.mjs'

const LEG_STATUS = Object.freeze({
  holderExecutable: 'unverified',
  vaultFlowMax: 'unavailable',
  routeQuote: 'not_joined',
})

function validateOptions({ market, amountUsd, horizonSeconds, asOfAt }) {
  if (!MARKETS.some((item) => item.name === market)) throw new Error('Unknown Aave market')
  if (!Number.isFinite(amountUsd) || amountUsd <= 0)
    throw new Error('amountUsd must be a finite number > 0')
  if (
    !Number.isSafeInteger(horizonSeconds) ||
    horizonSeconds < MIN_HORIZON_SECONDS ||
    horizonSeconds > MAX_HORIZON_SECONDS
  )
    throw new Error('horizonSeconds must be an integer from 8h through 30d')
  if (!Number.isSafeInteger(asOfAt) || asOfAt <= 0)
    throw new Error('asOfAt must be a positive Unix second')
}

// Pure replay seam. The caller validates checkpoint provenance and grid first.
export function assembleMarketEvidence(rows, { market, amountUsd, horizonSeconds, asOfAt }) {
  validateOptions({ market, amountUsd, horizonSeconds, asOfAt })
  if (!Array.isArray(rows)) throw new Error('Market rows must be an array')
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.market !== market) throw new Error('Market row identity mismatch')
    if (!Number.isSafeInteger(rows[i].at) || rows[i].at <= 0)
      throw new Error('Market timestamps must be positive Unix seconds')
    if (i && rows[i].at <= rows[i - 1].at) throw new Error('Market rows must be time-ordered')
  }
  const past = rows.filter((row) => row.at <= asOfAt)
  const analysis = analyzeMarketSeries(past, { amountUsd })
  const anchor = past.at(-1)
  const anchorAgeSeconds = anchor ? asOfAt - anchor.at : null
  let status = 'retrospective_only'
  let reason = null
  let trail = null
  if (!anchor) {
    status = 'unavailable'
    reason = 'no_sample_as_of'
  } else if (anchorAgeSeconds > MAX_GAP_SECONDS) {
    status = 'stale'
    reason = 'anchor_older_than_8h'
  } else if (anchor.kind !== 'observed') {
    status = 'unavailable'
    reason = 'latest_sample_ineligible'
  } else if (!anchor.active) {
    status = 'unavailable'
    reason = 'reserve_inactive'
  } else if (anchor.withdrawPaused) {
    status = 'unavailable'
    reason = 'withdraw_paused'
  } else if (anchor.cashUsdAssumingPeg < amountUsd) {
    status = 'unavailable'
    reason = 'cash_already_below_amount'
  } else {
    trail = trailingDecline(past, past.length - 1)
    if (!trail) {
      status = 'unavailable'
      reason = 'incomplete_trailing_18_to_30h_interval'
    }
  }
  const projectedCashUsdAssumingPeg =
    status === 'retrospective_only'
      ? Math.max(0, anchor.cashUsdAssumingPeg - trail.declineRateUsdPerSecond * horizonSeconds)
      : null
  return {
    market,
    amountUsd,
    horizonSeconds,
    asOfAt,
    prospectiveEligible: false,
    anchor: anchor
      ? {
          block: anchor.block ?? null,
          at: anchor.at,
          ageSeconds: anchorAgeSeconds,
          kind: anchor.kind,
        }
      : null,
    asOfSampledReserveCashUsdAssumingPeg:
      anchor?.kind === 'observed' ? anchor.cashUsdAssumingPeg : null,
    scenario: {
      status,
      reason,
      prospectiveEligible: false,
      projectionMethod: 'nonnegative_clipped_linear_decline',
      projectedCashUsdAssumingPeg,
      projectedCashBelowAmount:
        projectedCashUsdAssumingPeg === null ? null : projectedCashUsdAssumingPeg < amountUsd,
      trailingIntervalSeconds: trail?.elapsedSeconds ?? null,
      trailingDeclineUsdPerSecond: trail?.declineRateUsdPerSecond ?? null,
      interpretation:
        'Retrospective sampled reserve-cash scenario only; linear decline is clipped at zero and no prospective first-local-observation receipt exists.',
    },
    historicalSampledCashShortages: {
      asOfAt,
      summary: summarizeMarket(analysis),
      runs: analysis.runs,
      interpretation:
        'Past sampled-cash runs and censoring are descriptive; observed recovery spans are not likely future exit durations.',
    },
    evidenceLegs: { ...LEG_STATUS },
  }
}

// Attach only summary statistics from a backtest truncated to this exact as-of.
// The pure seam is useful for checking identity and leakage without a full grid.
// It is not an authenticator for caller-supplied backtest summaries; production
// readers must enter through evaluateForecastEvidence's verified checkpoint.
export function attachEndpointCashInterval(evidence, backtest) {
  if (
    !evidence ||
    !backtest ||
    evidence.market !== backtest.market ||
    evidence.amountUsd !== backtest.amountUsd ||
    evidence.horizonSeconds !== backtest.horizonSeconds ||
    evidence.asOfAt !== backtest.asOfAt ||
    (evidence.sourceEntriesSha256 && evidence.sourceEntriesSha256 !== backtest.sourceEntriesSha256)
  )
    throw new Error('Endpoint backtest identity or as-of mismatch')
  if (backtest.study !== 'aave-v3-retrospective-endpoint-cash-backtest-v1')
    throw new Error('Unexpected endpoint backtest study')

  const interval = backtest.empiricalResidualInterval
  const support = backtest.trainSupport?.completedWithProjection
  const point = evidence.scenario?.projectedCashUsdAssumingPeg
  const scenarioAvailable =
    evidence.scenario?.status === 'retrospective_only' && Number.isFinite(point)
  const sufficient =
    Number.isSafeInteger(support) &&
    support >= MIN_TRAIN_ENDPOINTS &&
    interval?.trainSupport === support &&
    Number.isFinite(interval.lowerResidualUsd) &&
    Number.isFinite(interval.upperResidualUsd) &&
    interval.lowerResidualUsd <= interval.upperResidualUsd
  const status = scenarioAvailable && sufficient ? 'retrospective_only' : 'unavailable'
  const reason = !scenarioAvailable
    ? `scenario_${evidence.scenario?.reason ?? 'unavailable'}`
    : !sufficient
      ? 'insufficient_or_invalid_completed_train_endpoints'
      : null
  const lowerCashUsdAssumingPeg =
    status === 'retrospective_only' ? Math.max(0, point + interval.lowerResidualUsd) : null
  const upperCashUsdAssumingPeg =
    status === 'retrospective_only'
      ? Math.max(lowerCashUsdAssumingPeg, point + interval.upperResidualUsd)
      : null
  const holdout = backtest.holdout ?? {}
  return {
    ...evidence,
    endpointCashInterval: {
      status,
      reason,
      prospectiveEligible: false,
      lowerCashUsdAssumingPeg,
      upperCashUsdAssumingPeg,
      trainCompletedWithProjection: Number.isSafeInteger(support) ? support : null,
      historicalHoldout: {
        pointScored: holdout.pointScored ?? null,
        meanAbsoluteErrorUsd: holdout.meanAbsoluteErrorUsd ?? null,
        intervalScored: holdout.intervalScored ?? null,
        intervalCoverage: holdout.intervalCoverage ?? null,
        meanIntervalWidthUsd: holdout.meanIntervalWidthUsd ?? null,
      },
      interpretation:
        'Exploratory train-residual interval around sampled endpoint reserve cash. Historical holdout was already inspected; this is not executable exit, likely duration, calibrated probability, or an alert.',
    },
  }
}

// This pure seam checks matching identity and strips episode records. It does
// not authenticate caller-supplied study results; only evaluateForecastEvidence
// verifies the frozen checkpoint before calling the recovery evaluator.
export function attachRecoveryLandmarkEvidence(evidence, recovery) {
  if (
    !evidence ||
    !recovery ||
    evidence.market !== recovery.market ||
    evidence.amountUsd !== recovery.amountUsd ||
    evidence.horizonSeconds !== recovery.horizonSeconds ||
    evidence.asOfAt !== recovery.asOfAt ||
    typeof evidence.sourceEntriesSha256 !== 'string' ||
    !evidence.sourceEntriesSha256 ||
    evidence.sourceEntriesSha256 !== recovery.sourceEntriesSha256
  )
    throw new Error('Recovery landmark identity, as-of, or source mismatch')
  if (recovery.study !== 'aave-v3-sampled-cash-episode-recovery-landmark-v1')
    throw new Error('Unexpected recovery landmark study')
  if (recovery.elapsedSeconds !== 0) throw new Error('Unexpected recovery landmark elapsed time')

  const compactSupport = (split) => ({
    episodeCount: split?.episodeCount ?? null,
    scoredEpisodes: split?.scoredEpisodes ?? null,
    recovered: split?.recovered ?? null,
    notRecovered: split?.notRecovered ?? null,
    statuses: { ...(split?.statuses ?? {}) },
    eligible: split?.eligible === true,
    reasons: [...(split?.reasons ?? [])],
  })
  const train = compactSupport(recovery.support?.train)
  const holdout = compactSupport(recovery.support?.holdout)
  const status =
    recovery.eligible === true && train.eligible && holdout.eligible
      ? 'retrospective_only'
      : 'unavailable'
  return {
    ...evidence,
    sampledCashRecoveryLandmark: {
      status,
      reason: status === 'unavailable' ? 'insufficient_distinct_episode_support' : null,
      prospectiveEligible: false,
      elapsedSeconds: 0,
      trainSupport: train,
      holdoutSupport: holdout,
      excludedBoundaryStatuses: { ...(recovery.support?.excludedBoundary ?? {}) },
      likelyDurationSeconds: null,
      alertEligible: false,
      interpretation:
        'Retrospective sampled reserve-cash recovery episode support and censoring only. This does not estimate holder exit duration or authorize an alert.',
    },
  }
}

export function evaluateForecastEvidence(checkpoint, options) {
  validateOptions(options)
  validateCheckpoint(checkpoint)
  if (checkpoint.entriesSha256 !== EXPECTED_SOURCE_ENTRIES_SHA256)
    throw new Error('Aave cash source cohort digest differs from frozen local source')
  if (
    checkpoint.status !== 'complete' ||
    checkpoint.entries.length !== COUNT * MARKETS.length ||
    checkpoint.failures.length
  )
    throw new Error('Complete 1569-sample grid for all eight markets required')
  // Validate the full frozen grid, including chronology, before any as-of slice.
  const rows = checkpoint.entries
    .filter((row) => row.market === options.market)
    .sort((a, b) => a.block - b.block)
  if (rows.length !== COUNT) throw new Error(`Incomplete ${options.market} grid`)
  for (let i = 0; i < rows.length; i++)
    if (rows[i].block !== GRID.first + i * GRID.step)
      throw new Error(`Incomplete ${options.market} grid`)
  const evidence = {
    study: 'aave-v3-forecast-evidence-assembler-v1',
    source: SOURCE,
    sourceEntriesSha256: checkpoint.entriesSha256,
    sourceAttestation: 'local hash verified, not independently chain attested',
    ...assembleMarketEvidence(rows, options),
  }
  const backtest = evaluateEndpointCheckpoint(checkpoint, {
    market: options.market,
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    asOfAt: options.asOfAt,
  })
  const recovery = evaluateRecoveryCheckpoint(checkpoint, {
    market: options.market,
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    elapsedSeconds: 0,
    asOfAt: options.asOfAt,
  })
  return attachRecoveryLandmarkEvidence(attachEndpointCashInterval(evidence, backtest), recovery)
}

export function parseArgs(argv, nowSeconds = Math.floor(Date.now() / 1000)) {
  const values = {}
  const valid = new Set(['--market', '--amount-usd', '--horizon-hours', '--as-of-unix'])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!valid.has(flag) || values[flag] !== undefined || argv[i + 1] === undefined)
      throw new Error(`Unknown, repeated, or incomplete argument ${flag}`)
    values[flag] = argv[++i]
  }
  if (
    values['--market'] === undefined ||
    values['--amount-usd'] === undefined ||
    values['--horizon-hours'] === undefined
  )
    throw new Error(
      'Usage: --market MARKET --amount-usd Q --horizon-hours H [--as-of-unix UnixSeconds]',
    )
  const options = {
    market: values['--market'],
    amountUsd: Number(values['--amount-usd']),
    horizonSeconds: Number(values['--horizon-hours']) * 3600,
    asOfAt: values['--as-of-unix'] === undefined ? nowSeconds : Number(values['--as-of-unix']),
  }
  validateOptions(options)
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  console.log(
    JSON.stringify(evaluateForecastEvidence(checkpoint, parseArgs(process.argv.slice(2)))),
  )
}
