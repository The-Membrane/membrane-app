// Offline episode-level recovery landmark study of sampled Aave reserve cash.
// It does not estimate holder exit duration or enable a user-facing alert.
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
} from './aave-cash-horizon-labels.mjs'
import {
  EXPECTED_SOURCE_ENTRIES_SHA256,
  analyzeMarketSeries,
} from './aave-cash-shortage-durations.mjs'

export const MIN_TRAIN_EPISODES = 30
export const MIN_HOLDOUT_EPISODES = 20
export const MIN_EACH_OUTCOME = 5

function validateOptions({
  market,
  amountUsd,
  horizonSeconds,
  elapsedSeconds = 0,
  boundaryAt,
  asOfAt,
}) {
  if (!MARKETS.some((x) => x.name === market)) throw new Error('Unknown Aave market')
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('amountUsd must be > 0')
  if (
    !Number.isSafeInteger(horizonSeconds) ||
    horizonSeconds < MIN_HORIZON_SECONDS ||
    horizonSeconds > MAX_HORIZON_SECONDS
  )
    throw new Error('horizonSeconds must be an integer from 8h through 30d')
  if (
    !Number.isSafeInteger(elapsedSeconds) ||
    elapsedSeconds < 0 ||
    elapsedSeconds > MAX_HORIZON_SECONDS
  )
    throw new Error('elapsedSeconds must be an integer from 0 through 30d')
  if (!Number.isSafeInteger(boundaryAt) || boundaryAt <= 0)
    throw new Error('Missing frozen boundary')
  if (asOfAt !== undefined && (!Number.isSafeInteger(asOfAt) || asOfAt <= 0))
    throw new Error('asOfAt must be a positive Unix second')
}

function countBy(records, field) {
  const result = {}
  for (const record of records) {
    const key = record[field]
    result[key] = (result[key] || 0) + 1
  }
  return result
}

function support(records, minimum) {
  const scored = records.filter((r) => r.outcome !== null)
  const yes = scored.filter((r) => r.outcome === true).length
  const no = scored.length - yes
  const reasons = []
  if (scored.length < minimum) reasons.push('too_few_distinct_episodes')
  if (yes < MIN_EACH_OUTCOME) reasons.push('too_few_recovered_episodes')
  if (no < MIN_EACH_OUTCOME) reasons.push('too_few_unrecovered_episodes')
  return {
    episodeCount: records.length,
    scoredEpisodes: scored.length,
    recovered: yes,
    notRecovered: no,
    statuses: countBy(records, 'status'),
    eligible: reasons.length === 0,
    reasons,
  }
}

// One episode yields at most one landmark record. Rows are a pure replay seam;
// only evaluateRecoveryCheckpoint authenticates their frozen provenance.
export function evaluateRecoverySeries(rows, options) {
  validateOptions(options)
  if (!Array.isArray(rows) || rows.some((r) => r.market !== options.market))
    throw new Error('Market rows must share selected identity')
  const visible = rows.filter((r) => options.asOfAt === undefined || r.at <= options.asOfAt)
  const runs = analyzeMarketSeries(visible, { amountUsd: options.amountUsd }).runs
  const trainCutoffAt = options.boundaryAt - PURGE_SECONDS
  const trainRuns = new Map(
    analyzeMarketSeries(
      visible.filter((r) => r.at <= trainCutoffAt),
      {
        amountUsd: options.amountUsd,
      },
    ).runs.map((run) => [run.firstBelowAt, run]),
  )
  const records = { train: [], holdout: [], excludedBoundary: [] }
  for (const run of runs) {
    const firstIndex = visible.findIndex((r) => r.at === run.firstBelowAt)
    const fullLastIndex = visible.findIndex((r) => r.at === run.lastBelowAt)
    const landmarkTarget = run.firstBelowAt + (options.elapsedSeconds ?? 0)
    let landmarkIndex = -1
    for (let i = firstIndex; i <= fullLastIndex; i++)
      if (visible[i].at >= landmarkTarget) {
        landmarkIndex = i
        break
      }
    const landmarkAt = landmarkIndex < 0 ? null : visible[landmarkIndex].at
    const targetAt = landmarkAt === null ? null : landmarkAt + options.horizonSeconds
    const split =
      landmarkAt === null
        ? 'excludedBoundary'
        : targetAt + MAX_GAP_SECONDS < options.boundaryAt - PURGE_SECONDS
          ? 'train'
          : run.firstBelowAt > options.boundaryAt + PURGE_SECONDS
            ? 'holdout'
            : 'excludedBoundary'
    const evidenceRun = split === 'train' ? trainRuns.get(run.firstBelowAt) : run
    if (!evidenceRun) throw new Error('Training episode missing from pre-boundary source')
    const lastIndex = visible.findIndex((r) => r.at === evidenceRun.lastBelowAt)
    const rightBracketed = evidenceRun.rightBracketed
    const rightCensorReason =
      split === 'train' &&
      evidenceRun.rightCensorReason === 'series_edge' &&
      (options.asOfAt === undefined || options.asOfAt > trainCutoffAt)
        ? 'split_boundary'
        : evidenceRun.rightCensorReason
    const record = {
      market: options.market,
      firstBelowAt: run.firstBelowAt,
      firstBelowBlock: run.firstBelowBlock,
      leftBracketed: run.leftBracketed,
      leftCensorReason: run.leftCensorReason,
      rightBracketed,
      rightCensorReason,
      landmarkAt,
      observedElapsedSeconds: landmarkAt === null ? null : landmarkAt - run.firstBelowAt,
      targetAt,
      recoveryBracket: rightBracketed
        ? { afterAt: evidenceRun.lastBelowAt, byAt: evidenceRun.recoveryObservedAt }
        : null,
      status: null,
      outcome: null,
    }
    if (split === 'excludedBoundary')
      record.status = landmarkAt === null ? 'censored_before_landmark' : 'boundary_purge'
    else if (!run.leftBracketed)
      record.status = `left_censored_${run.leftCensorReason ?? 'prior_below'}`
    else if (options.asOfAt !== undefined && targetAt + MAX_GAP_SECONDS > options.asOfAt)
      record.status = 'pending_as_of'
    else {
      const horizonBelowIndex = visible.findIndex(
        (r, i) =>
          i >= landmarkIndex &&
          i <= lastIndex &&
          r.at >= targetAt &&
          r.at <= targetAt + MAX_GAP_SECONDS,
      )
      const stopIndex =
        rightBracketed && evidenceRun.recoveryObservedAt <= targetAt
          ? lastIndex + 1
          : horizonBelowIndex >= 0
            ? horizonBelowIndex
            : rightBracketed
              ? lastIndex + 1
              : lastIndex
      const unsafe = visible
        .slice(firstIndex, stopIndex + 1)
        .find((r) => !r.active || r.withdrawPaused)
      if (unsafe) record.status = 'ineligible_or_paused_window'
      else if (rightBracketed && evidenceRun.recoveryObservedAt <= targetAt) {
        record.status = 'recovered_by_horizon'
        record.outcome = true
      } else if (horizonBelowIndex >= 0) {
        record.status = 'still_below_at_horizon_sample'
        record.outcome = false
      } else if (
        rightBracketed &&
        visible[lastIndex].at < targetAt &&
        evidenceRun.recoveryObservedAt > targetAt
      ) {
        record.status = 'recovery_bracket_straddles_target'
      } else record.status = `right_censored_${rightCensorReason ?? 'series_edge'}`
    }
    records[split].push(record)
  }
  const train = support(records.train, MIN_TRAIN_EPISODES)
  const holdout = support(records.holdout, MIN_HOLDOUT_EPISODES)
  const eligible = train.eligible && holdout.eligible
  const trainRate = eligible ? train.recovered / train.scoredEpisodes : null
  const holdoutRate = eligible ? holdout.recovered / holdout.scoredEpisodes : null
  return {
    study: 'aave-v3-sampled-cash-episode-recovery-landmark-v1',
    market: options.market,
    amountUsd: options.amountUsd,
    horizonSeconds: options.horizonSeconds,
    elapsedSeconds: options.elapsedSeconds ?? 0,
    boundaryAt: options.boundaryAt,
    purgeSeconds: PURGE_SECONDS,
    asOfAt: options.asOfAt ?? null,
    support: { train, holdout, excludedBoundary: countBy(records.excludedBoundary, 'status') },
    eligible,
    empiricalTrainRecoveryFraction: trainRate,
    exploratoryHoldout: eligible
      ? {
          recoveryFraction: holdoutRate,
          brierAgainstTrainFraction:
            holdoutRate * (1 - trainRate) ** 2 + (1 - holdoutRate) * trainRate ** 2,
          absoluteCalibrationGap: Math.abs(holdoutRate - trainRate),
          scoredEpisodes: holdout.scoredEpisodes,
        }
      : null,
    records,
    claims: {
      prospective: false,
      calibrated: false,
      holderExitDuration: null,
      likelyDuration: null,
      alertEligible: false,
    },
    caveats: [
      'Each record represents one sampled below-threshold episode, not overlapping sample anchors.',
      'Distinct episodes within one market may still be serially correlated; support counts are not independence certificates.',
      'Recovery is bracketed between the last below sample and first above sample; a bracket straddling H is unresolved.',
      'Left-censored episodes and incomplete or paused windows remain visible but are not fit or scored.',
      'Complete-case rates can be biased by informative censoring, even when support thresholds pass.',
      'The original frozen holdout was already examined; any metrics are exploratory, not prospective calibration.',
      'Reserve cash is not executable holder exit ability. No likely duration, holder-exit probability, or alert follows.',
    ],
  }
}

export function evaluateRecoveryCheckpoint(checkpoint, options) {
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
  for (const market of MARKETS) {
    const marketRows = checkpoint.entries
      .filter((r) => r.market === market.name)
      .sort((a, b) => a.block - b.block)
    if (
      marketRows.length !== COUNT ||
      marketRows.some((r, i) => r.block !== GRID.first + i * GRID.step)
    )
      throw new Error(`Incomplete ${market.name} grid`)
  }
  const rows = checkpoint.entries
    .filter((r) => r.market === options.market)
    .sort((a, b) => a.block - b.block)
  return {
    source: SOURCE,
    sourceEntriesSha256: checkpoint.entriesSha256,
    sourceAttestation: 'locally hash verified; not independently chain attested',
    ...evaluateRecoverySeries(rows, { ...options, boundaryAt: boundaryRows[0].at }),
  }
}

function cli(argv) {
  const values = {}
  const flags = new Set([
    '--market',
    '--amount-usd',
    '--horizon-hours',
    '--elapsed-hours',
    '--as-of-unix',
  ])
  for (let i = 0; i < argv.length; i++) {
    if (!flags.has(argv[i]) || values[argv[i]] !== undefined || argv[i + 1] === undefined)
      throw new Error(`Unknown, repeated, or incomplete argument ${argv[i]}`)
    values[argv[i]] = argv[++i]
  }
  if (!values['--market'] || !values['--amount-usd'] || !values['--horizon-hours'])
    throw new Error(
      'Usage: --market MARKET --amount-usd Q --horizon-hours H [--elapsed-hours E] [--as-of-unix T]',
    )
  const checkpoint = readCheckpoint(SOURCE)
  if (!checkpoint) throw new Error(`Missing verified source ${SOURCE}`)
  return evaluateRecoveryCheckpoint(checkpoint, {
    market: values['--market'],
    amountUsd: Number(values['--amount-usd']),
    horizonSeconds: Number(values['--horizon-hours']) * 3600,
    elapsedSeconds: Number(values['--elapsed-hours'] ?? 0) * 3600,
    asOfAt: values['--as-of-unix'] === undefined ? undefined : Number(values['--as-of-unix']),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(cli(process.argv.slice(2))))
