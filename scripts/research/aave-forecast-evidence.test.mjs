import test from 'node:test'
import assert from 'node:assert/strict'
import { readCheckpoint, snapshot } from './aave-stable-expansion.mjs'
import { SOURCE } from './aave-cash-horizon-labels.mjs'
import {
  assembleMarketEvidence,
  attachEndpointCashInterval,
  attachRecoveryLandmarkEvidence,
  evaluateForecastEvidence,
  parseArgs,
} from './aave-forecast-evidence.mjs'

const HOUR = 3600
const AT = 2_000_000_000
const Q = 1_000_000
const options = { market: 'DAI', amountUsd: Q, horizonSeconds: 24 * HOUR, asOfAt: AT + 24 * HOUR }
const rows = () =>
  [2_000_000, 1_800_000, 1_600_000, 1_400_000, 1_200_000, 5_000_000].map((cash, i) => ({
    market: 'DAI',
    block: i,
    at: AT + i * 6 * HOUR,
    kind: 'observed',
    active: true,
    withdrawPaused: false,
    cashUsdAssumingPeg: cash,
  }))

const endpointBacktest = (overrides = {}) => ({
  study: 'aave-v3-retrospective-endpoint-cash-backtest-v1',
  market: options.market,
  amountUsd: options.amountUsd,
  horizonSeconds: options.horizonSeconds,
  asOfAt: options.asOfAt,
  trainSupport: { completedWithProjection: 30 },
  empiricalResidualInterval: {
    lowerResidualUsd: -300_000,
    upperResidualUsd: 200_000,
    trainSupport: 30,
  },
  holdout: {
    pointScored: 10,
    meanAbsoluteErrorUsd: 50_000,
    intervalScored: 10,
    intervalCoverage: 0.8,
    meanIntervalWidthUsd: 500_000,
  },
  records: { train: [{ endpointCashUsd: 1 }], holdout: [{ endpointCashUsd: 2 }] },
  ...overrides,
})

const recoveryStudy = (overrides = {}) => ({
  study: 'aave-v3-sampled-cash-episode-recovery-landmark-v1',
  market: options.market,
  amountUsd: options.amountUsd,
  horizonSeconds: options.horizonSeconds,
  elapsedSeconds: 0,
  asOfAt: options.asOfAt,
  sourceEntriesSha256: 'fixture-source-sha',
  eligible: false,
  support: {
    train: {
      episodeCount: 2,
      scoredEpisodes: 1,
      recovered: 1,
      notRecovered: 0,
      statuses: { recovered_by_horizon: 1, right_censored_series_edge: 1 },
      eligible: false,
      reasons: ['too_few_distinct_episodes', 'too_few_unrecovered_episodes'],
    },
    holdout: {
      episodeCount: 1,
      scoredEpisodes: 0,
      recovered: 0,
      notRecovered: 0,
      statuses: { pending_as_of: 1 },
      eligible: false,
      reasons: ['too_few_distinct_episodes'],
    },
    excludedBoundary: { boundary_purge: 1 },
  },
  records: { train: [{ futureRecoveryAt: options.asOfAt + HOUR }] },
  empiricalTrainRecoveryFraction: null,
  claims: { likelyDuration: null, alertEligible: false },
  ...overrides,
})

test('scenario and historical runs use only samples at or before asOfAt', () => {
  const original = rows()
  const before = structuredClone(original)
  const result = assembleMarketEvidence(original, options)
  assert.deepEqual(original, before)
  assert.equal(result.anchor.block, 4)
  assert.equal(result.scenario.status, 'retrospective_only')
  assert.equal(result.prospectiveEligible, false)
  assert.equal(result.scenario.prospectiveEligible, false)
  assert.equal(result.asOfSampledReserveCashUsdAssumingPeg, 1_200_000)
  assert.equal('currentSampledReserveCashUsdAssumingPeg' in result, false)
  assert.equal(result.scenario.projectedCashBelowAmount, true)
  assert.equal(result.scenario.projectedCashUsdAssumingPeg, 400_000)
  assert.equal(result.historicalSampledCashShortages.summary.observedSamples, 5)
  assert.equal(result.historicalSampledCashShortages.summary.runCount, 0)
  const changedFuture = rows()
  changedFuture[5].cashUsdAssumingPeg = 0
  assert.deepEqual(assembleMarketEvidence(changedFuture, options), result)
  assert.deepEqual(result.evidenceLegs, {
    holderExecutable: 'unverified',
    vaultFlowMax: 'unavailable',
    routeQuote: 'not_joined',
  })
})

test('linear extrapolation clips at zero without changing the crossing decision', () => {
  const result = assembleMarketEvidence(rows(), { ...options, horizonSeconds: 7 * 24 * HOUR })
  assert.equal(result.scenario.projectionMethod, 'nonnegative_clipped_linear_decline')
  assert.equal(result.scenario.projectedCashUsdAssumingPeg, 0)
  assert.equal(result.scenario.projectedCashBelowAmount, true)
})

test('sampled shortage still visible historically, but is not forecast as executable exit', () => {
  const past = rows().map((row, i) => (i === 1 ? { ...row, cashUsdAssumingPeg: Q - 1 } : row))
  const result = assembleMarketEvidence(past, options)
  assert.equal(result.historicalSampledCashShortages.summary.runCount, 1)
  assert.equal(result.historicalSampledCashShortages.runs[0].fullyBracketed, true)
  assert.equal(result.evidenceLegs.holderExecutable, 'unverified')
})

test('post-as-of recovery cannot complete a right-censored historical shortage', () => {
  const source = rows()
  source[4] = { ...source[4], cashUsdAssumingPeg: Q - 1 }
  const result = assembleMarketEvidence(source, options)
  assert.equal(result.historicalSampledCashShortages.summary.runCount, 1)
  const run = result.historicalSampledCashShortages.runs[0]
  assert.equal(run.rightBracketed, false)
  assert.equal(run.rightCensorReason, 'series_edge')
  assert.equal(run.recoveryObservedAt, null)
  assert.equal(result.scenario.reason, 'cash_already_below_amount')
})

test('stale, missing, and incomplete trailing intervals abstain', () => {
  const missing = assembleMarketEvidence(rows(), { ...options, asOfAt: AT - 1 })
  assert.equal(missing.scenario.status, 'unavailable')
  assert.equal(missing.scenario.reason, 'no_sample_as_of')
  const stale = assembleMarketEvidence(rows(), { ...options, asOfAt: AT + 39 * HOUR })
  assert.equal(stale.scenario.status, 'stale')
  assert.equal(stale.scenario.reason, 'anchor_older_than_8h')
  assert.equal(stale.scenario.projectedCashBelowAmount, null)
  const short = assembleMarketEvidence(rows().slice(3), options)
  assert.equal(short.scenario.reason, 'incomplete_trailing_18_to_30h_interval')
  const gap = rows()
  gap[2] = { ...gap[2], kind: 'ineligible', cashUsdAssumingPeg: undefined }
  assert.equal(
    assembleMarketEvidence(gap, options).scenario.reason,
    'incomplete_trailing_18_to_30h_interval',
  )
})

test('latest ineligible, inactive, paused, or low cash abstains', () => {
  const variants = [
    [{ kind: 'ineligible', cashUsdAssumingPeg: undefined }, 'latest_sample_ineligible'],
    [{ active: false }, 'reserve_inactive'],
    [{ withdrawPaused: true }, 'withdraw_paused'],
    [{ cashUsdAssumingPeg: Q - 1 }, 'cash_already_below_amount'],
  ]
  for (const [change, reason] of variants) {
    const source = rows()
    source[4] = { ...source[4], ...change }
    const result = assembleMarketEvidence(source, options)
    assert.equal(result.scenario.status, 'unavailable')
    assert.equal(result.scenario.reason, reason)
    assert.equal(result.scenario.projectedCashUsdAssumingPeg, null)
  }
})

test('market, amount, horizon, as-of and row chronology are validated', () => {
  const bad = [
    { market: 'USDC' },
    { amountUsd: 0 },
    { amountUsd: Infinity },
    { horizonSeconds: 7 * HOUR },
    { horizonSeconds: 31 * 24 * HOUR },
    { horizonSeconds: 8 * HOUR + 1.5 },
    { asOfAt: 0 },
  ]
  for (const override of bad)
    assert.throws(() => assembleMarketEvidence(rows(), { ...options, ...override }))
  const reversed = rows()
  reversed[2] = { ...reversed[2], at: reversed[1].at }
  assert.throws(() => assembleMarketEvidence(reversed, options), /time-ordered/)
})

test('CLI parses an explicit as-of and defaults to current Unix seconds', () => {
  const base = ['--market', 'DAI', '--amount-usd', '1000000', '--horizon-hours', '24']
  assert.deepEqual(parseArgs(base, AT), { ...options, asOfAt: AT })
  assert.deepEqual(parseArgs([...base, '--as-of-unix', String(AT + 24 * HOUR)], AT), options)
  assert.throws(() => parseArgs([...base, '--market', 'USDT'], AT), /repeated/)
  assert.throws(() => parseArgs([...base, '--unknown', 'x'], AT), /Unknown/)
})

test('frozen checkpoint digest rejects structurally valid cohort alteration', () => {
  const original = readCheckpoint(SOURCE)
  assert.ok(original)
  const index = original.entries.findIndex((row) => row.kind === 'observed')
  const changed = snapshot(
    original.entries.map((row, i) =>
      i === index ? { ...row, cashUsdAssumingPeg: row.cashUsdAssumingPeg + 1 } : row,
    ),
    [],
  )
  assert.throws(() => evaluateForecastEvidence(changed, options), /digest differs/)
})

test('real frozen cohort returns a stale, retrospective-only evidence package at current time', () => {
  const original = readCheckpoint(SOURCE)
  const result = evaluateForecastEvidence(original, {
    market: 'DAI',
    amountUsd: Q,
    horizonSeconds: 24 * HOUR,
    asOfAt: Math.floor(Date.now() / 1000),
  })
  assert.equal(result.sourceEntriesSha256, original.entriesSha256)
  assert.equal(result.sourceAttestation, 'local hash verified, not independently chain attested')
  assert.equal(result.scenario.status, 'stale')
  assert.equal(result.scenario.projectedCashBelowAmount, null)
  assert.equal(result.endpointCashInterval.status, 'unavailable')
  assert.equal(result.endpointCashInterval.reason, 'scenario_anchor_older_than_8h')
  assert.equal(result.sampledCashRecoveryLandmark.status, 'unavailable')
  assert.equal(result.sampledCashRecoveryLandmark.likelyDurationSeconds, null)
  assert.equal(result.sampledCashRecoveryLandmark.alertEligible, false)
  assert.equal(result.evidenceLegs.holderExecutable, 'unverified')
})

test('recovery landmark attaches only compact support and censor status, abstaining when sparse', () => {
  const evidence = {
    ...assembleMarketEvidence(rows(), options),
    sourceEntriesSha256: 'fixture-source-sha',
  }
  const result = attachRecoveryLandmarkEvidence(evidence, recoveryStudy())
  assert.equal(result.sampledCashRecoveryLandmark.status, 'unavailable')
  assert.equal(result.sampledCashRecoveryLandmark.reason, 'insufficient_distinct_episode_support')
  assert.equal(result.sampledCashRecoveryLandmark.trainSupport.episodeCount, 2)
  assert.equal(result.sampledCashRecoveryLandmark.holdoutSupport.statuses.pending_as_of, 1)
  assert.equal(result.sampledCashRecoveryLandmark.excludedBoundaryStatuses.boundary_purge, 1)
  assert.equal(result.sampledCashRecoveryLandmark.prospectiveEligible, false)
  assert.equal(result.sampledCashRecoveryLandmark.likelyDurationSeconds, null)
  assert.equal(result.sampledCashRecoveryLandmark.alertEligible, false)
  assert.equal(JSON.stringify(result).includes('futureRecoveryAt'), false)
  assert.equal('records' in result.sampledCashRecoveryLandmark, false)
  assert.equal('empiricalTrainRecoveryFraction' in result.sampledCashRecoveryLandmark, false)
})

test('recovery landmark rejects identity, as-of, source, study and elapsed mismatch', () => {
  const evidence = {
    ...assembleMarketEvidence(rows(), options),
    sourceEntriesSha256: 'fixture-source-sha',
  }
  for (const change of [
    { market: 'USDC' },
    { amountUsd: Q + 1 },
    { horizonSeconds: 48 * HOUR },
    { asOfAt: options.asOfAt + 1 },
    { sourceEntriesSha256: 'different-source' },
  ])
    assert.throws(() => attachRecoveryLandmarkEvidence(evidence, recoveryStudy(change)), /mismatch/)
  assert.throws(
    () => attachRecoveryLandmarkEvidence(assembleMarketEvidence(rows(), options), recoveryStudy()),
    /mismatch/,
  )
  assert.throws(
    () => attachRecoveryLandmarkEvidence(evidence, recoveryStudy({ study: 'other-version' })),
    /study/,
  )
  assert.throws(
    () => attachRecoveryLandmarkEvidence(evidence, recoveryStudy({ elapsedSeconds: HOUR })),
    /elapsed/,
  )
})

test('eligible endpoint cash scenario receives compact train interval and holdout summary', () => {
  const evidence = assembleMarketEvidence(rows(), options)
  const result = attachEndpointCashInterval(evidence, endpointBacktest())
  assert.deepEqual(
    [
      result.endpointCashInterval.lowerCashUsdAssumingPeg,
      result.endpointCashInterval.upperCashUsdAssumingPeg,
    ],
    [100_000, 600_000],
  )
  assert.equal(result.endpointCashInterval.status, 'retrospective_only')
  assert.equal(result.endpointCashInterval.prospectiveEligible, false)
  assert.equal(result.endpointCashInterval.historicalHoldout.intervalCoverage, 0.8)
  assert.equal(JSON.stringify(result).includes('endpointCashUsd'), false)
  assert.equal('records' in result.endpointCashInterval, false)
})

test('endpoint interval rejects market, amount, horizon, as-of, and source identity mismatch', () => {
  const evidence = assembleMarketEvidence(rows(), options)
  for (const change of [
    { market: 'USDC' },
    { amountUsd: Q + 1 },
    { horizonSeconds: 48 * HOUR },
    { asOfAt: options.asOfAt + 1 },
  ])
    assert.throws(() => attachEndpointCashInterval(evidence, endpointBacktest(change)), /mismatch/)
  assert.throws(
    () =>
      attachEndpointCashInterval(
        { ...evidence, sourceEntriesSha256: 'same-source' },
        endpointBacktest({ sourceEntriesSha256: 'different-source' }),
      ),
    /mismatch/,
  )
})

test('stale scenario and inadequate or malformed train support abstain from a cash interval', () => {
  const available = assembleMarketEvidence(rows(), options)
  const stale = assembleMarketEvidence(rows(), { ...options, asOfAt: AT + 39 * HOUR })
  const staleResult = attachEndpointCashInterval(stale, endpointBacktest({ asOfAt: stale.asOfAt }))
  assert.equal(staleResult.endpointCashInterval.status, 'unavailable')
  assert.equal(staleResult.endpointCashInterval.lowerCashUsdAssumingPeg, null)
  for (const backtest of [
    endpointBacktest({ trainSupport: { completedWithProjection: 29 } }),
    endpointBacktest({ empiricalResidualInterval: null }),
    endpointBacktest({
      empiricalResidualInterval: {
        lowerResidualUsd: 200_000,
        upperResidualUsd: -300_000,
        trainSupport: 30,
      },
    }),
  ]) {
    const result = attachEndpointCashInterval(available, backtest)
    assert.equal(result.endpointCashInterval.status, 'unavailable')
    assert.equal(
      result.endpointCashInterval.reason,
      'insufficient_or_invalid_completed_train_endpoints',
    )
  }
})

test('authenticated historical replay uses same as-of for evidence and backtest', () => {
  const checkpoint = readCheckpoint(SOURCE)
  const past = checkpoint.entries.filter((r) => r.market === 'DAI' && r.kind === 'observed')
  const asOfAt = past[Math.floor(past.length * 0.4)].at
  const result = evaluateForecastEvidence(checkpoint, { ...options, asOfAt })
  assert.equal(result.asOfAt, asOfAt)
  assert.equal(result.endpointCashInterval.status, 'retrospective_only')
  assert.equal(result.endpointCashInterval.historicalHoldout.pointScored, 0)
  assert.equal(result.endpointCashInterval.historicalHoldout.intervalScored, 0)
  assert.equal(result.endpointCashInterval.historicalHoldout.intervalCoverage, null)
  assert.equal(result.sampledCashRecoveryLandmark.status, 'unavailable')
  assert.equal(result.sampledCashRecoveryLandmark.holdoutSupport.scoredEpisodes, 0)
  assert.equal(result.sampledCashRecoveryLandmark.likelyDurationSeconds, null)
  assert.equal(JSON.stringify(result).includes('recoveryBracket'), false)
  assert.equal('records' in result.sampledCashRecoveryLandmark, false)
  assert.equal(result.prospectiveEligible, false)
})

test('authenticated recovery support cannot see a shortage episode after historical as-of', () => {
  const checkpoint = readCheckpoint(SOURCE)
  const firstBelow = checkpoint.entries
    .filter((r) => r.market === 'DAI' && r.kind === 'observed' && r.cashUsdAssumingPeg < Q)
    .sort((a, b) => a.at - b.at)[0]
  assert.ok(firstBelow)
  const before = evaluateForecastEvidence(checkpoint, {
    ...options,
    asOfAt: firstBelow.at - 1,
  })
  assert.equal(before.sampledCashRecoveryLandmark.trainSupport.episodeCount, 0)
  assert.equal(before.sampledCashRecoveryLandmark.holdoutSupport.episodeCount, 0)
  assert.equal(before.sampledCashRecoveryLandmark.status, 'unavailable')
  assert.equal(JSON.stringify(before.sampledCashRecoveryLandmark).includes('firstBelowAt'), false)
})
