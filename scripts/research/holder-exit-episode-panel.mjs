// Offline, exact-subject holder episode panel. No provider calls or ledger writes.
// Aave outcomes here are eth_call observations, never mined holder payouts.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { buildMorphoV2Episodes, morphoBoardSubjects } from './holder-exit-morpho-v2-episodes.mjs'
import {
  buildDirectSupplierEpisodes,
  directSupplierBoardSubjects,
} from './holder-exit-direct-supplier-episodes.mjs'
import {
  buildFluidFTokenEpisodes,
  fluidFTokenBoardSubjects,
} from './holder-exit-fluid-ftoken-episodes.mjs'
import {
  buildDirectVaultEpisodes,
  directVaultBoardSubjects,
} from './holder-exit-direct-vault-episodes.mjs'
import { buildSghoEpisodes, sghoBoardSubjects } from './holder-exit-sgho-episodes.mjs'
import { buildUmbrellaEpisodes, umbrellaBoardSubjects } from './holder-exit-umbrella-episodes.mjs'
import { apyUsdBoardSubjects, buildApyUsdEpisodes } from './holder-exit-apyusd-episodes.mjs'
import {
  buildStakedUsdatEpisodes,
  stakedUsdatBoardSubjects,
} from './holder-exit-staked-usdat-episodes.mjs'
import {
  FLUID_BRIDGE_SUBJECTS,
  buildFluidBridgeEpisodes,
  fluidBridgeBoardSubjects,
} from './holder-exit-fluid-bridge-episodes.mjs'
import {
  buildPyUsdStakingEpisodes,
  pyUsdStakingBoardSubjects,
} from './holder-exit-pyusd-staking-episodes.mjs'
import { buildTwynePtEpisodes, twynePtBoardSubjects } from './holder-exit-twyne-pt-episodes.mjs'
import {
  buildSusdePendingEpisodes,
  susdePendingBoardSubjects,
} from './holder-exit-susde-pending-episodes.mjs'
import {
  buildSusdePayoutEvidence,
  readVerifiedSusdePayoutEvidence,
} from './holder-exit-susde-payout-evidence.mjs'
import { issueFlowAncestryMarker } from './holder-exit-direct-flow-issue-ancestry.mjs'
import { applyHolderExitClockProofOverlay } from './holder-exit-clock-proof-overlay.mjs'
import {
  Q_ASSETS_RAW as MORPHO_LEDGER_Q_RAW,
  ROUTE_KEY as MORPHO_FIXED_10K_ROUTE,
  STUDY as MORPHO_FIXED_10K_STUDY,
  readSavedLedger as readSavedMorphoFixed10kLedger,
} from './morpho-v2-usdc-10k-holder-risk-ledger.mjs'

const AAVE_ROUTE = 'USDC → supply on Aave V3'
const AAVE_MARKET = 'aaveV3Usdc'
const MAX_ISSUES_PER_LANE = 2_000
const MAX_FEATURES = 10_000
const MAX_PANEL_FEATURES = 200_000
const MAX_ROWS = 20_000
export const MAX_CURRENT_CASH_AGE_MS = 2 * 60 * 60 * 1_000
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/i
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fail = (condition, reason) => {
  if (!condition) throw Error(`holder_episode_panel_${reason}`)
}
const identity = (routeKey, destination, asset) =>
  `${routeKey}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`

const MORPHO_RETROSPECTIVE_HORIZONS = Object.freeze([1, 4, 24, 48, 168])
const MORPHO_FIXED_10K_Q_RAW = '10000000000'
const MORPHO_RETROSPECTIVE_OUTCOMES = new Set([
  'success',
  'evm_revert',
  'holder_attrition',
  'identity_changed',
  'holder_type_changed',
  'rpc_unavailable',
  'gas_error',
  'not_read_identity',
  'head_censored',
])

function morphoRetrospectiveState(outcome) {
  if (outcome === 'success') return { status: 'simulated_callable', reason: null }
  if (outcome === 'evm_revert') return { status: 'simulated_impaired', reason: null }
  return { status: 'censored', reason: outcome }
}

function deriveMorphoRetrospectiveIntervals(states) {
  let lastSuccess = 0
  let lastComparable = 0
  let firstLoss = null
  let lastLoss = null
  let recovery = null
  let censoring = null
  for (const state of states) {
    if (
      ['holder_attrition', 'identity_changed', 'holder_type_changed'].includes(state.rawOutcome)
    ) {
      censoring ??= {
        afterHours: lastComparable,
        atHours: state.horizonHours,
        class: state.rawOutcome,
      }
      continue
    }
    if (censoring) continue
    if (state.rawOutcome === 'success') {
      if (firstLoss && !recovery) recovery = { after: lastLoss, through: state.horizonHours }
      if (!firstLoss) lastSuccess = state.horizonHours
      lastComparable = state.horizonHours
    } else if (state.rawOutcome === 'evm_revert') {
      firstLoss ??= { after: lastSuccess, through: state.horizonHours }
      lastLoss = state.horizonHours
      lastComparable = state.horizonHours
    }
  }
  return { firstLoss, recovery }
}

function validateMorphoRetrospectiveInterval(interval, expected, kind, states) {
  fail((interval == null) === (expected == null), 'morpho_fixed_10k_first_transition_invalid')
  if (interval == null) return null
  fail(
    Number.isSafeInteger(interval.after) &&
      interval.after >= 0 &&
      Number.isSafeInteger(interval.through) &&
      interval.through > interval.after &&
      typeof interval.hasMissingInterveningSample === 'boolean',
    'morpho_fixed_10k_interval_invalid',
  )
  fail(
    interval.after === expected.after && interval.through === expected.through,
    'morpho_fixed_10k_first_transition_invalid',
  )
  const before =
    interval.after === 0
      ? 'success'
      : states.find((row) => row.horizonHours === interval.after)?.rawOutcome
  const after = states.find((row) => row.horizonHours === interval.through)?.rawOutcome
  fail(
    kind === 'lost_exitability'
      ? before === 'success' && after === 'evm_revert'
      : before === 'evm_revert' && after === 'success',
    'morpho_fixed_10k_interval_state_invalid',
  )
  const missing = states.some(
    (row) =>
      row.horizonHours > interval.after &&
      row.horizonHours < interval.through &&
      !['success', 'evm_revert'].includes(row.rawOutcome),
  )
  fail(missing === interval.hasMissingInterveningSample, 'morpho_fixed_10k_interval_gap_invalid')
  return {
    transition: kind,
    afterHours: interval.after,
    throughHours: interval.through,
    intervalNotation: `(${interval.after},${interval.through}]`,
    hasMissingInterveningSample: interval.hasMissingInterveningSample,
  }
}

/**
 * Bind the separately sealed Morpho fixed-$10k history to exact frozen subjects.
 * These episodes remain a retrospective transition sidecar: the saved study has
 * no independently witnessed label-availability clock, so it must not enter the
 * common walk-forward row set.
 */
export function buildMorphoFixed10kTransitionStudy({ manifest, ledger }) {
  fail(ledger && typeof ledger === 'object' && !Array.isArray(ledger), 'morpho_fixed_10k_invalid')
  const board = morphoBoardSubjects(manifest)
  fail(
    ledger.schemaVersion === 1 &&
      ledger.study === MORPHO_FIXED_10K_STUDY &&
      ledger.routeKey === MORPHO_FIXED_10K_ROUTE &&
      ADDRESS.test(ledger.asset ?? '') &&
      MORPHO_LEDGER_Q_RAW === MORPHO_FIXED_10K_Q_RAW &&
      ledger.qAssetsRaw === MORPHO_FIXED_10K_Q_RAW &&
      SHA.test(ledger.planSha256 ?? '') &&
      Number.isSafeInteger(ledger.reservedHoldoutAnchor) &&
      [
        'saved_retrospective_cells_disk_integrity_only',
        'caller_supplied_frozen_plan_and_validated_cells',
      ].includes(ledger.source) &&
      Array.isArray(ledger.episodes) &&
      ledger.episodes.length <= 132 &&
      ledger.limits?.forecastValidated === false &&
      ledger.limits?.likelyExitDurationAvailable === false &&
      ledger.limits?.independentObservations === false,
    'morpho_fixed_10k_invalid',
  )
  const seenCells = new Set()
  const seenLogicalEpisodes = new Set()
  const episodes = ledger.episodes.map((episode) => {
    fail(
      ['development', 'reservedHoldout'].includes(episode?.split) &&
        Number.isSafeInteger(episode.anchorBlock) &&
        ADDRESS.test(episode.vault ?? '') &&
        ADDRESS.test(episode.holder ?? '') &&
        episode.holderVaultCluster === `${episode.vault}:${episode.holder}` &&
        SHA.test(episode.cellSha256 ?? '') &&
        !seenCells.has(episode.cellSha256) &&
        Array.isArray(episode.horizonClasses) &&
        episode.horizonClasses.length === MORPHO_RETROSPECTIVE_HORIZONS.length,
      'morpho_fixed_10k_episode_invalid',
    )
    seenCells.add(episode.cellSha256)
    fail(
      episode.split ===
        (episode.anchorBlock === ledger.reservedHoldoutAnchor ? 'reservedHoldout' : 'development'),
      'morpho_fixed_10k_split_invalid',
    )
    const subject = identity(ledger.routeKey, episode.vault, ledger.asset)
    fail(board.has(subject), 'morpho_fixed_10k_subject_invalid')
    const logicalEpisode = JSON.stringify([subject, episode.anchorBlock])
    fail(!seenLogicalEpisodes.has(logicalEpisode), 'morpho_fixed_10k_episode_duplicate')
    seenLogicalEpisodes.add(logicalEpisode)
    const horizonStates = episode.horizonClasses.map((row, index) => {
      fail(
        row?.hours === MORPHO_RETROSPECTIVE_HORIZONS[index] &&
          MORPHO_RETROSPECTIVE_OUTCOMES.has(row.outcome),
        'morpho_fixed_10k_horizon_invalid',
      )
      return {
        horizonHours: row.hours,
        rawOutcome: row.outcome,
        outcome: morphoRetrospectiveState(row.outcome),
      }
    })
    const derivedIntervals = deriveMorphoRetrospectiveIntervals(horizonStates)
    const transitionEvents = [
      validateMorphoRetrospectiveInterval(
        episode.firstObservedLossIntervalHours,
        derivedIntervals.firstLoss,
        'lost_exitability',
        horizonStates,
      ),
      validateMorphoRetrospectiveInterval(
        episode.observedRecoveryIntervalHours,
        derivedIntervals.recovery,
        'recovered_exitability',
        horizonStates,
      ),
    ].filter(Boolean)
    fail(
      transitionEvents.every((event, index) =>
        index === 0 ? true : event.afterHours >= transitionEvents[index - 1].throughHours,
      ) &&
        (episode.observedRecoveryIntervalHours == null ||
          episode.firstObservedLossIntervalHours != null) &&
        Number.isSafeInteger(episode.missingHorizonSamples) &&
        episode.missingHorizonSamples >= 0,
      'morpho_fixed_10k_transition_invalid',
    )
    const correlationLabel = `${episode.vault.toLowerCase()}:${episode.holder.toLowerCase()}`
    return {
      subject,
      routeKey: ledger.routeKey,
      destination: episode.vault.toLowerCase(),
      asset: ledger.asset.toLowerCase(),
      stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
      split: episode.split,
      anchorBlock: episode.anchorBlock,
      cellSha256: episode.cellSha256,
      holder: episode.holder.toLowerCase(),
      holderCommitment: sha(correlationLabel),
      holderVaultCorrelationSha256: sha(correlationLabel),
      holderBindingScheme: 'sha256(lowercase_vault_colon_lowercase_holder)',
      correlationUnit: 'holder_vault',
      observationsAreIndependent: false,
      qRaw: ledger.qAssetsRaw,
      qUnit: 'asset_raw',
      baseline: 'simulated_callable',
      horizonStates,
      transitionEvents: transitionEvents.map((event) => ({
        ...event,
        cellSha256: episode.cellSha256,
        holderVaultCorrelationSha256: sha(correlationLabel),
      })),
      firstLossRightCensoredAtHours: episode.firstLossRightCensoredAtHours,
      recoveryRightCensoredAtHours: episode.recoveryRightCensoredAtHours,
      censoring: episode.censoring,
      missingHorizonSamples: episode.missingHorizonSamples,
    }
  })
  const splitSummary = (split) => {
    const selected = episodes.filter((episode) => episode.split === split)
    const events = selected.flatMap((episode) => episode.transitionEvents)
    return {
      episodes: selected.length,
      holderVaultCorrelationClusters: new Set(
        selected.map((episode) => episode.holderVaultCorrelationSha256),
      ).size,
      transitionEvents: events.length,
      lostExitabilityEvents: events.filter((event) => event.transition === 'lost_exitability')
        .length,
      recoveredExitabilityEvents: events.filter(
        (event) => event.transition === 'recovered_exitability',
      ).length,
    }
  }
  const development = splitSummary('development')
  const reservedHoldout = splitSummary('reservedHoldout')
  const events = episodes.flatMap((episode) => episode.transitionEvents)
  fail(
    ledger.counts?.development?.baselineSuccessEpisodes === development.episodes &&
      ledger.counts?.development?.observedFirstLossEpisodes === development.lostExitabilityEvents &&
      ledger.counts?.development?.observedRecoveryEpisodes ===
        development.recoveredExitabilityEvents &&
      ledger.counts?.reservedHoldout?.baselineSuccessEpisodes === reservedHoldout.episodes &&
      ledger.counts?.reservedHoldout?.observedFirstLossEpisodes ===
        reservedHoldout.lostExitabilityEvents &&
      ledger.counts?.reservedHoldout?.observedRecoveryEpisodes ===
        reservedHoldout.recoveredExitabilityEvents &&
      ledger.counts?.all?.baselineSuccessEpisodes === episodes.length &&
      ledger.counts?.all?.observedFirstLossEpisodes ===
        events.filter((event) => event.transition === 'lost_exitability').length &&
      ledger.counts?.all?.observedRecoveryEpisodes ===
        events.filter((event) => event.transition === 'recovered_exitability').length,
    'morpho_fixed_10k_counts_invalid',
  )
  const developmentClusters = new Set(
    episodes
      .filter((episode) => episode.split === 'development')
      .map((episode) => episode.holderVaultCorrelationSha256),
  )
  const sharedClusters = new Set(
    episodes
      .filter(
        (episode) =>
          episode.split === 'reservedHoldout' &&
          developmentClusters.has(episode.holderVaultCorrelationSha256),
      )
      .map((episode) => episode.holderVaultCorrelationSha256),
  ).size
  fail(
    ledger.counts?.sharedHolderVaultClustersAcrossSplits === sharedClusters,
    'morpho_fixed_10k_correlation_invalid',
  )
  return {
    study: ledger.study,
    sourceVerification: ledger.source,
    planSha256: ledger.planSha256,
    routeKey: ledger.routeKey,
    asset: ledger.asset.toLowerCase(),
    qRaw: ledger.qAssetsRaw,
    qUnit: 'asset_raw',
    stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
    reservedHoldoutAnchor: ledger.reservedHoldoutAnchor,
    episodes,
    bySplit: { development, reservedHoldout },
    sharedHolderVaultCorrelationClustersAcrossSplits: sharedClusters,
    walkForwardEligible: false,
    labelAvailabilityClockIndependentlyWitnessed: false,
    forecastValidated: false,
    calibratedDuration: false,
    probabilitiesEstimated: false,
  }
}

export function holderExitPrimaryCellKey(row) {
  return JSON.stringify([
    row.issueClusterSha256,
    row.analysisCellKey ?? 'shared',
    row.holderCommitment,
    row.qRaw,
    row.plannedHorizonHours,
    row.qUnit == null ? ['missing'] : ['present', row.qUnit],
  ])
}

function utcMs(value) {
  const ms = Date.parse(value)
  fail(Number.isSafeInteger(ms) && new Date(ms).toISOString() === value, 'clock_invalid')
  return ms
}

function blockNumber(value) {
  fail(typeof value === 'string' && /^\d+$/.test(value), 'block_invalid')
  return BigInt(value)
}

function validateManifest(manifest) {
  fail(
    Array.isArray(manifest?.subjects) &&
      manifest.subjects.length === 67 &&
      new Set(manifest.subjects.map((s) => s.route_key)).size === 25 &&
      SHA.test(manifest.sha256 ?? '') &&
      sha(JSON.stringify(manifest.subjects)) === manifest.sha256,
    'manifest_invalid',
  )
  const keys = new Set()
  for (const subject of manifest.subjects) {
    fail(
      typeof subject.route_key === 'string' &&
        typeof subject.destination === 'string' &&
        typeof subject.asset === 'string',
      'subject_invalid',
    )
    const key = identity(subject.route_key, subject.destination, subject.asset)
    fail(!keys.has(key), 'subject_duplicate')
    keys.add(key)
  }
  const aave = manifest.subjects.filter((s) => s.route_key === AAVE_ROUTE)
  fail(aave.length === 1, 'aave_subject_invalid')
  return aave[0]
}

function baselineState(lane, entry) {
  if (entry.assetsRaw == null) return 'unavailable'
  fail(/^\d+$/.test(entry.assetsRaw), 'amount_invalid')
  if (lane === 'v2') {
    fail(['success', 'covered_revert'].includes(entry.baselineStatus), 'baseline_invalid')
    return entry.baselineStatus === 'success' ? 'simulated_callable' : 'simulated_impaired'
  }
  if (lane === 'v3') {
    if (entry.status === 'unavailable') return 'unavailable'
    if (entry.status === 'inconclusive') return 'inconclusive'
    fail(entry.status === 'measured', 'baseline_invalid')
    const status = entry.measurement?.baselineStatus
    fail(['success', 'covered_revert'].includes(status), 'baseline_invalid')
    return status === 'success' ? 'simulated_callable' : 'simulated_impaired'
  }
  if (entry.status !== 'measured') return 'unavailable'
  const measurement = entry.measurement
  if (!measurement || BigInt(measurement.holderCoverageRaw ?? 0) < BigInt(entry.assetsRaw))
    return 'unavailable'
  if (measurement.status === 'success') return 'simulated_callable'
  if (measurement.status === 'evm_revert' && measurement.coveredRevert === true)
    return 'simulated_impaired'
  return 'inconclusive'
}

function outcomeState(lane, baseline, score, caseScore, deadlineMs, nowMs) {
  if (baseline === 'unavailable' || baseline === 'inconclusive')
    return { status: 'not_at_risk', reason: `baseline_${baseline}` }
  if (lane === 'v1' && baseline === 'simulated_impaired')
    return { status: 'not_assayed', reason: 'v1_impaired_baseline_unscored_by_design' }
  if (!score)
    return nowMs <= deadlineMs
      ? { status: 'pending', reason: null }
      : { status: 'missing', reason: 'no_verified_score_after_deadline' }
  if (lane === 'v1') {
    if (caseScore?.status === 'unavailable' && caseScore.reason === 'capture_window_missed')
      return { status: 'censored', reason: 'capture_window_missed' }
    if (caseScore?.status === 'ineligible')
      return { status: 'not_assayed', reason: 'baseline_not_success' }
    fail(caseScore?.status === 'measured', 'score_case_invalid')
    if (caseScore.outcome === 'exit_success') return { status: 'simulated_callable', reason: null }
    if (caseScore.outcome === 'holder_attrition')
      return { status: 'censored', reason: 'holder_attrition' }
    if (caseScore.outcome === 'exit_revert_cause_unknown')
      return { status: 'inconclusive', reason: 'revert_cause_unknown' }
  } else {
    if (score.status === 'censored') return { status: 'censored', reason: 'capture_window_missed' }
    fail(score.status === 'measured' && caseScore?.status === 'measured', 'score_case_invalid')
    if (caseScore.transition === 'holder_attrition')
      return { status: 'censored', reason: 'holder_attrition' }
    if (['remained_exitable', 'simulated_recovery'].includes(caseScore.transition))
      return { status: 'simulated_callable', reason: null }
    if (['lost_exitability', 'still_reverting'].includes(caseScore.transition))
      return { status: 'simulated_impaired', reason: null }
  }
  throw Error('holder_episode_panel_score_outcome_invalid')
}

/** Select only features knowable at issue time; every excluded source stays an abstention. */
export function selectAsOfFeatures(features, subject, issue, parent) {
  fail(Array.isArray(features) && features.length <= MAX_FEATURES, 'features_invalid')
  const cutoffMs = utcMs(issue.issuedAtUtc)
  const baselineBlock = blockNumber(parent.baseline?.targetBlock)
  fail(/^0x[0-9a-f]{64}$/i.test(parent.baseline?.targetHash ?? ''), 'baseline_hash_invalid')
  const baselineMs = utcMs(parent.baseline?.targetBlockAt)
  const selected = new Map()
  const abstentions = {}
  for (const feature of features) {
    fail(
      typeof feature?.routeKey === 'string' &&
        typeof feature.destination === 'string' &&
        typeof feature.asset === 'string',
      'feature_invalid',
    )
    if (
      identity(feature.routeKey, feature.destination, feature.asset) !==
      identity(subject.route_key, subject.destination, subject.asset)
    )
      continue
    fail(
      typeof feature.kind === 'string' &&
        SHA.test(feature.receiptSha256 ?? '') &&
        /^0x[0-9a-f]{64}$/.test(feature.sourceBlockHash ?? ''),
      'feature_invalid',
    )
    const sourceBlock = blockNumber(feature.sourceBlock)
    const sourceMs = utcMs(feature.sourceAt)
    const firstSeenMs = utcMs(feature.firstLocalReceiptAt)
    const completedMs = feature.completedAtUtc == null ? firstSeenMs : utcMs(feature.completedAtUtc)
    let reason = null
    if (feature.collectionMode === 'retrospective') reason = 'reconstructed_not_issue_time_current'
    else if (
      !['current', 'prospective_complete', 'historical_preissue'].includes(feature.collectionMode)
    )
      reason = 'source_mode_unverified'
    else if (feature.coverageComplete !== true) reason = 'coverage_incomplete'
    else if (sourceBlock > baselineBlock || sourceMs > baselineMs) reason = 'future_source'
    else if (
      sourceBlock === baselineBlock &&
      feature.sourceBlockHash.toLowerCase() !== parent.baseline.targetHash.toLowerCase()
    )
      reason = 'source_fork_mismatch'
    else if (firstSeenMs > cutoffMs) reason = 'late_first_local_receipt'
    else if (completedMs > cutoffMs) reason = 'late_completion'
    else if (sourceMs > cutoffMs) reason = 'future_source_clock'
    else if (
      feature.kind === 'aggregate_cash' &&
      ['current', 'prospective_complete'].includes(feature.collectionMode) &&
      cutoffMs - sourceMs > MAX_CURRENT_CASH_AGE_MS
    )
      reason = 'stale_current_cash'
    if (reason) {
      abstentions[reason] = (abstentions[reason] ?? 0) + 1
      continue
    }
    const previous = selected.get(feature.kind)
    if (!previous || sourceBlock > blockNumber(previous.sourceBlock))
      selected.set(feature.kind, {
        kind: feature.kind,
        receiptSha256: feature.receiptSha256,
        sourceBlock: feature.sourceBlock,
        sourceBlockHash: feature.sourceBlockHash,
        sourceAt: feature.sourceAt,
        firstLocalReceiptAt: feature.firstLocalReceiptAt,
        completedAtUtc: feature.completedAtUtc ?? feature.firstLocalReceiptAt,
        valueRaw: feature.valueRaw ?? null,
        clockBasis: feature.clockBasis ?? null,
        sourceBaselineAncestry: feature.sourceBaselineAncestry ?? null,
      })
  }
  return {
    featureRefs: [...selected.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
    featureAbstentions: abstentions,
  }
}

/** Pure projection of caller-supplied records. Use readVerifiedHolderExitEpisodePanel for verified files. */
export function buildHolderExitEpisodePanel({
  manifest,
  v1Issues = [],
  v1Scores = [],
  v2Issues = [],
  v2Scores = [],
  v3Issues = [],
  v3Scores = [],
  morphoIssues = [],
  morphoScores = [],
  morphoFixed10kLedger = null,
  compoundIssues = [],
  compoundScores = [],
  fluidRouteLedgers = [0, 1, 2].map((routeIndex) => ({ routeIndex, issues: [], scores: [] })),
  directVaultLedgers = ['usd3', 'stusds', 'susds'].map((lane) => ({
    lane,
    issues: [],
    scores: [],
  })),
  sghoLedger = { v1Issues: [], v1Scores: [], v2Issues: [], v2Scores: [] },
  umbrellaLedger = { issues: [], scores: [], attempts: [], orphanIssues: [], orphanScores: [] },
  apyUsdIssues = [],
  apyUsdScores = [],
  stakedUsdatLedger = { issues: [], scores: [], attempts: [] },
  fluidBridgeRouteLedgers = ['usdc', 'usdt'].map((lane) => ({
    lane,
    ledger: { issues: [], scores: [], attempts: [] },
  })),
  pyUsdStakingLedger = { issues: [], scores: [], attempts: [] },
  twynePtLedger = { issues: [], scores: [], attempts: [] },
  susdePendingIssues = [],
  susdePendingScores = [],
  susdePayoutRecords = [],
  features = [],
  issueFlowFeaturesBySha = new Map(),
  nowMs = Date.now(),
}) {
  const aave = validateManifest(manifest)
  morphoBoardSubjects(manifest)
  directSupplierBoardSubjects(manifest)
  fluidFTokenBoardSubjects(manifest)
  directVaultBoardSubjects(manifest)
  sghoBoardSubjects(manifest)
  umbrellaBoardSubjects(manifest)
  apyUsdBoardSubjects(manifest)
  stakedUsdatBoardSubjects(manifest)
  fluidBridgeBoardSubjects(manifest)
  pyUsdStakingBoardSubjects(manifest)
  twynePtBoardSubjects(manifest)
  susdePendingBoardSubjects(manifest)
  fail(Number.isSafeInteger(nowMs) && nowMs >= 0, 'now_invalid')
  for (const ledger of [
    v1Issues,
    v1Scores,
    v2Issues,
    v2Scores,
    v3Issues,
    v3Scores,
    morphoIssues,
    compoundIssues,
    compoundScores,
    apyUsdIssues,
    apyUsdScores,
    susdePendingIssues,
    susdePendingScores,
  ])
    fail(Array.isArray(ledger) && ledger.length <= MAX_ISSUES_PER_LANE * 5, 'ledger_limit')
  fail(Array.isArray(morphoScores) && morphoScores.length <= 50_000, 'ledger_limit')
  fail(Array.isArray(features) && features.length <= MAX_PANEL_FEATURES, 'features_invalid')
  fail(issueFlowFeaturesBySha instanceof Map, 'issue_flow_features_invalid')
  const morphoFixed10kStudy =
    morphoFixed10kLedger == null
      ? null
      : buildMorphoFixed10kTransitionStudy({ manifest, ledger: morphoFixed10kLedger })
  for (const [issueSha, boundFeatures] of issueFlowFeaturesBySha)
    fail(
      SHA.test(issueSha) && Array.isArray(boundFeatures) && boundFeatures.length <= 2,
      'issue_flow_features_invalid',
    )
  const featuresBySubject = new Map()
  for (const feature of features) {
    fail(
      typeof feature?.routeKey === 'string' &&
        typeof feature.destination === 'string' &&
        typeof feature.asset === 'string',
      'feature_invalid',
    )
    const subjectKey = identity(feature.routeKey, feature.destination, feature.asset)
    const subjectFeatures = featuresBySubject.get(subjectKey) ?? []
    subjectFeatures.push(feature)
    fail(subjectFeatures.length <= MAX_FEATURES, 'features_invalid')
    featuresBySubject.set(subjectKey, subjectFeatures)
  }
  const parentBySequence = new Map(v1Issues.map((issue) => [issue.sequence, issue]))
  fail(parentBySequence.size === v1Issues.length, 'parent_duplicate')
  const lanes = [
    {
      name: 'v1',
      issues: v1Issues.filter((issue) => issue.marketKey === AAVE_MARKET),
      scores: v1Scores,
    },
    { name: 'v2', issues: v2Issues, scores: v2Scores },
    { name: 'v3', issues: v3Issues, scores: v3Scores },
  ]
  const episodes = []
  const featureCache = new Map()
  for (const lane of lanes) {
    fail(lane.issues.length <= MAX_ISSUES_PER_LANE, 'issue_limit')
    const issueBySequence = new Map(lane.issues.map((issue) => [issue.sequence, issue]))
    fail(issueBySequence.size === lane.issues.length, 'issue_duplicate')
    const scores = new Map()
    for (const score of lane.scores) {
      if (lane.name === 'v1' && score.marketKey !== AAVE_MARKET) continue
      const key = `${score.issueSequence}:${score.horizonHours}`
      fail(!scores.has(key), 'score_duplicate')
      const scoredAtMs = utcMs(score.scoredAtUtc)
      const scoreIssue = issueBySequence.get(score.issueSequence)
      const target = scoreIssue?.targets?.find((row) => row.horizonHours === score.horizonHours)
      fail(scoreIssue && target && score.issueSha256 === scoreIssue.sha256, 'score_binding_invalid')
      fail(scoredAtMs >= utcMs(target.targetAtUtc), 'score_clock_invalid')
      scores.set(key, { row: score, scoredAtMs })
    }
    for (const issue of lane.issues) {
      const parent = lane.name === 'v1' ? issue : parentBySequence.get(issue.v1IssueSequence)
      fail(
        parent &&
          (lane.name === 'v1' || issue.v1IssueSha256 === parent.sha256) &&
          issue.routeKey === aave.route_key &&
          issue.destination.toLowerCase() === aave.destination.toLowerCase() &&
          issue.originalAsset.toLowerCase() === aave.asset.toLowerCase() &&
          issue.marketKey === AAVE_MARKET &&
          SHA.test(issue.sha256 ?? '') &&
          SHA.test(parent.sha256 ?? '') &&
          Array.isArray(issue.cases) &&
          issue.cases.length <= 8 &&
          Array.isArray(issue.targets) &&
          issue.targets.length <= 8,
        'issue_identity_invalid',
      )
      const holder = lane.name === 'v1' ? issue.candidate?.holder : issue.holder
      fail(
        holder == null
          ? lane.name === 'v1' && issue.cases.every((entry) => entry.status !== 'measured')
          : /^0x[0-9a-f]{40}$/i.test(holder),
        'holder_invalid',
      )
      const holderCommitment = holder
        ? sha(`${aave.destination.toLowerCase()}:${holder.toLowerCase()}`)
        : null
      if (lane.name === 'v3')
        fail(issue.selectedHolderCommitment === holderCommitment, 'holder_commitment_invalid')
      const issueClusterSha256 = parent.sha256
      const baselineBlock = blockNumber(parent.baseline?.targetBlock)
      const issueAtMs = utcMs(issue.issuedAtUtc)
      const parentIssueAtMs = utcMs(parent.issuedAtUtc)
      fail(utcMs(parent.baseline?.targetBlockAt) <= issueAtMs, 'issue_before_baseline')
      const seenAmounts = new Set()
      for (const entry of issue.cases) {
        if (entry.assetsRaw == null) continue
        fail(!seenAmounts.has(entry.assetsRaw), 'issue_amount_duplicate')
        seenAmounts.add(entry.assetsRaw)
        const baseline = baselineState(lane.name, entry)
        for (const target of issue.targets) {
          const targetMs = utcMs(target.targetAtUtc)
          const deadlineMs = utcMs(target.captureDeadlineUtc)
          fail(
            Number.isSafeInteger(target.horizonHours) &&
              target.horizonHours > 0 &&
              targetMs > utcMs(parent.baseline.targetBlockAt) &&
              targetMs > issueAtMs &&
              deadlineMs > targetMs,
            'target_invalid',
          )
          const scoreRecord = scores.get(`${issue.sequence}:${target.horizonHours}`)
          if (issueAtMs > nowMs || parentIssueAtMs > nowMs) continue
          const featureJoin =
            featureCache.get(issue.sha256) ??
            selectAsOfFeatures(
              [
                ...(featuresBySubject.get(identity(aave.route_key, aave.destination, aave.asset)) ??
                  []),
                ...(issueFlowFeaturesBySha.get(parent.sha256) ?? []),
              ],
              aave,
              issue,
              parent,
            )
          featureCache.set(issue.sha256, featureJoin)
          const score = scoreRecord?.scoredAtMs <= nowMs ? scoreRecord.row : null
          const caseScore = score?.cases?.find((row) => row.label === entry.label)
          const outcome = outcomeState(lane.name, baseline, score, caseScore, deadlineMs, nowMs)
          episodes.push({
            subject: identity(aave.route_key, aave.destination, aave.asset),
            stageScope: 'direct_aave_withdraw_eth_call',
            fullRoutePaidProofSha256: null,
            lane: lane.name,
            issueClusterSha256,
            issueSha256: issue.sha256,
            scoreSha256: score?.sha256 ?? null,
            holderCommitment,
            qRaw: entry.assetsRaw,
            qUnit: 'asset_raw',
            plannedHorizonHours: target.horizonHours,
            leadAtIssueMinutes: (targetMs - issueAtMs) / 60_000,
            targetClockBasis: 'parent_baseline_plan',
            issueAtUtc: issue.issuedAtUtc,
            issueClock: 'local_operator_clock_unwitnessed',
            featureAvailabilityClock: 'local_operator_clock_unwitnessed',
            baselineBlock: baselineBlock.toString(),
            baselineBlockHash: parent.baseline.targetHash,
            baselineAtUtc: parent.baseline.targetBlockAt,
            targetAtUtc: target.targetAtUtc,
            deadlineAtUtc: target.captureDeadlineUtc,
            observedAtUtc: score?.target?.targetBlockAt ?? null,
            labelAvailableAtUtc: score?.scoredAtUtc ?? null,
            baseline,
            outcome,
            ...featureJoin,
            analysisPrimaryForCell: false,
            forecastEligible: false,
          })
          fail(episodes.length <= MAX_ROWS, 'row_limit')
        }
      }
    }
  }
  const morpho = buildMorphoV2Episodes({
    manifest,
    issues: morphoIssues,
    scores: morphoScores,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...morpho.episodes)
  const supplier = buildDirectSupplierEpisodes({
    manifest,
    sparkIssues: v1Issues,
    sparkScores: v1Scores,
    compoundIssues,
    compoundScores,
    featuresBySubject,
    issueFlowFeaturesBySha,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...supplier.episodes)
  const fluid = buildFluidFTokenEpisodes({
    manifest,
    routeLedgers: fluidRouteLedgers,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...fluid.episodes)
  const directVault = buildDirectVaultEpisodes({
    manifest,
    routeLedgers: directVaultLedgers,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...directVault.episodes)
  const sgho = buildSghoEpisodes({
    manifest,
    ...sghoLedger,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...sgho.episodes)
  const umbrella = buildUmbrellaEpisodes({
    manifest,
    ledger: umbrellaLedger,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...umbrella.episodes)
  const apyUsd = buildApyUsdEpisodes({
    manifest,
    issues: apyUsdIssues,
    scores: apyUsdScores,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...apyUsd.episodes)
  const stakedUsdat = buildStakedUsdatEpisodes({
    manifest,
    ledger: stakedUsdatLedger,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...stakedUsdat.episodes)
  const fluidBridge = buildFluidBridgeEpisodes({
    manifest,
    routeLedgers: fluidBridgeRouteLedgers,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...fluidBridge.episodes)
  const pyUsdStaking = buildPyUsdStakingEpisodes({
    manifest,
    ledger: pyUsdStakingLedger,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...pyUsdStaking.episodes)
  const twynePt = buildTwynePtEpisodes({
    manifest,
    ledger: twynePtLedger,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...twynePt.episodes)
  const susdePending = buildSusdePendingEpisodes({
    manifest,
    issues: susdePendingIssues,
    scores: susdePendingScores,
    featuresBySubject,
    selectAsOfFeatures,
    nowMs,
  })
  episodes.push(...susdePending.episodes)
  const susdePayout = buildSusdePayoutEvidence({
    issues: susdePendingIssues,
    records: susdePayoutRecords,
    asOfMs: nowMs,
  })
  fail(episodes.length <= MAX_ROWS, 'row_limit')
  // V2/V3 sidecars often replay the same parent, holder, Q and horizon.
  const primary = new Map()
  const evidenceRank = (row) =>
    ['simulated_callable', 'simulated_impaired'].includes(row.baseline)
      ? 2
      : row.baseline === 'inconclusive'
        ? 1
        : 0
  const outcomeRank = (row) => {
    if (['simulated_callable', 'simulated_impaired'].includes(row.outcome.status)) return 4
    if (['censored', 'inconclusive'].includes(row.outcome.status)) return 3
    if (row.outcome.status === 'pending') return 2
    if (row.outcome.status === 'missing') return 1
    return 0
  }
  for (const row of episodes) {
    fail(row.analysisCellKey == null || SHA.test(row.analysisCellKey), 'analysis_cell_key_invalid')
    const key = holderExitPrimaryCellKey(row)
    const prior = primary.get(key)
    if (
      !prior ||
      evidenceRank(row) > evidenceRank(prior) ||
      (evidenceRank(row) === evidenceRank(prior) &&
        (outcomeRank(row) > outcomeRank(prior) ||
          (outcomeRank(row) === outcomeRank(prior) &&
            Number(row.lane.slice(1)) > Number(prior.lane.slice(1)))))
    )
      primary.set(key, row)
  }
  for (const row of primary.values()) row.analysisPrimaryForCell = true
  const primaryRows = [...primary.values()]
  const measuredBaselineRows = primaryRows.filter((row) =>
    ['simulated_callable', 'simulated_impaired'].includes(row.baseline),
  )
  const issueClusters = new Set(
    primaryRows.filter((row) => row.holderCommitment).map((row) => row.issueClusterSha256),
  )
  const onsetClusters = new Set(
    primaryRows
      .filter(
        (row) =>
          row.baseline === 'simulated_callable' && row.outcome.status === 'simulated_impaired',
      )
      .map((row) => row.issueClusterSha256),
  )
  const controls = new Set(
    primaryRows
      .filter(
        (row) =>
          row.baseline === 'simulated_callable' && row.outcome.status === 'simulated_callable',
      )
      .map((row) => row.issueClusterSha256),
  )
  const recoveries = new Set(
    primaryRows
      .filter(
        (row) =>
          row.baseline === 'simulated_impaired' && row.outcome.status === 'simulated_callable',
      )
      .map((row) => row.issueClusterSha256),
  )
  const baselineImpaired = new Set(
    primaryRows
      .filter((row) => row.baseline === 'simulated_impaired')
      .map((row) => row.issueClusterSha256),
  )
  const censored = new Set(
    primaryRows
      .filter((row) => row.outcome.status === 'censored')
      .map((row) => row.issueClusterSha256),
  )
  const pendingOrMissing = new Set(
    primaryRows
      .filter((row) => ['pending', 'missing'].includes(row.outcome.status))
      .map((row) => row.issueClusterSha256),
  )
  const subjects = manifest.subjects.map((subject) => {
    const isAave =
      subject.route_key === aave.route_key &&
      subject.destination.toLowerCase() === aave.destination.toLowerCase()
    const subjectIdentity = identity(subject.route_key, subject.destination, subject.asset)
    const isMorpho = morpho.board.has(subjectIdentity)
    const isFluid = fluid.board.has(subjectIdentity)
    const isDirectVault = directVault.board.has(subjectIdentity)
    const isSgho = sgho.board.has(subjectIdentity)
    const isUmbrella = umbrella.board.has(subjectIdentity)
    const isApyUsd = apyUsd.board.has(subjectIdentity)
    const isStakedUsdat = stakedUsdat.board.has(subjectIdentity)
    const isFluidBridge = fluidBridge.board.has(subjectIdentity)
    const isPyUsdStaking = pyUsdStaking.board.has(subjectIdentity)
    const isTwynePt = twynePt.board.has(subjectIdentity)
    const isSusdePending = susdePending.board.has(subjectIdentity)
    const supplierMarket = [...supplier.board.entries()].find(
      ([, item]) => identity(item.route_key, item.destination, item.asset) === subjectIdentity,
    )?.[0]
    const subjectEpisodes = episodes.filter((row) => row.subject === subjectIdentity)
    const retrospectiveEpisodes =
      morphoFixed10kStudy?.episodes.filter((row) => row.subject === subjectIdentity) ?? []
    return {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      stageScope: isAave
        ? 'direct_aave_withdraw_eth_call'
        : isMorpho
          ? 'direct_morpho_vaultv2_withdraw_eth_call'
          : supplierMarket === 'sparkLendUsdt'
            ? 'direct_spark_withdraw_eth_call'
            : supplierMarket === 'compoundV3Usdc'
              ? 'direct_compound_v3_withdraw_eth_call'
              : isFluid
                ? 'direct_fluid_ftoken_withdraw_eth_call'
                : isDirectVault
                  ? `direct_${subject.route_key.includes('USD3') ? 'usd3' : subject.route_key.includes('StUsds') ? 'stusds' : 'susds'}_withdraw_eth_call`
                  : isSgho
                    ? 'direct_sgho_withdraw_eth_call'
                    : isUmbrella
                      ? 'direct_umbrella_redeem_eth_call'
                      : isApyUsd
                        ? 'apyusd_withdraw_initiation_eth_call'
                        : isStakedUsdat
                          ? 'staked_usdat_redeem_eth_call'
                          : isFluidBridge
                            ? subject.route_key === FLUID_BRIDGE_SUBJECTS[1].route_key
                              ? 'fluid_bridge_usdt_first_leg_eth_call'
                              : 'fluid_bridge_usdc_first_leg_eth_call'
                            : isPyUsdStaking
                              ? 'pyusd_staking_first_stage_eth_call'
                              : isTwynePt
                                ? 'twyne_pt_borrower_first_leg_eth_call'
                                : isSusdePending
                                  ? 'susde_pending_unstake_eth_call'
                                  : 'not_adapted',
      episodes: subjectEpisodes,
      retrospectiveEpisodes,
      issueClusters: new Set(
        subjectEpisodes.filter((row) => row.holderCommitment).map((row) => row.issueClusterSha256),
      ).size,
      ...(isMorpho ? { morphoIssueDiagnostics: morpho.diagnostics.get(subjectIdentity) } : {}),
      ...(isFluid ? { fluidIssueDiagnostics: fluid.diagnostics.get(subjectIdentity) } : {}),
      ...(isDirectVault
        ? { directVaultIssueDiagnostics: directVault.diagnostics.get(subjectIdentity) }
        : {}),
      ...(isSgho ? { sghoIssueDiagnostics: sgho.diagnostics.get(subjectIdentity) } : {}),
      ...(isUmbrella
        ? { umbrellaIssueDiagnostics: umbrella.diagnostics.get(subjectIdentity) }
        : {}),
      ...(isApyUsd ? { apyUsdIssueDiagnostics: apyUsd.diagnostics.get(subjectIdentity) } : {}),
      ...(isStakedUsdat
        ? { stakedUsdatIssueDiagnostics: stakedUsdat.diagnostics.get(subjectIdentity) }
        : {}),
      ...(isFluidBridge
        ? { fluidBridgeIssueDiagnostics: fluidBridge.diagnostics.get(subjectIdentity) }
        : {}),
      ...(isPyUsdStaking
        ? { pyUsdStakingIssueDiagnostics: pyUsdStaking.diagnostics.get(subjectIdentity) }
        : {}),
      ...(isTwynePt ? { twynePtIssueDiagnostics: twynePt.diagnostics.get(subjectIdentity) } : {}),
      ...(isSusdePending
        ? { susdePendingIssueDiagnostics: susdePending.diagnostics.get(subjectIdentity) }
        : {}),
      ...(isSusdePending ? { observedPayouts: susdePayout.facts } : {}),
    }
  })
  return {
    scope: 'offline_frozen_25_67_holder_episode_panel',
    manifestSha256: manifest.sha256,
    sourceVerification: 'caller_supplied',
    holderExecutableExit: false,
    forecastValidated: false,
    statisticalIndependenceValidated: false,
    summary: {
      routeGroups: 25,
      exactSubjects: 67,
      subjectsWithEpisodes: subjects.filter((subject) => subject.episodes.length > 0).length,
      subjectsWithMeasuredBaseline: subjects.filter((subject) =>
        subject.episodes.some(
          (row) =>
            row.analysisPrimaryForCell &&
            ['simulated_callable', 'simulated_impaired'].includes(row.baseline),
        ),
      ).length,
      morphoFrozenSubjects: morpho.board.size,
      directSupplierFrozenSubjects: supplier.board.size,
      fluidFTokenFrozenSubjects: fluid.board.size,
      directVaultFrozenSubjects: directVault.board.size,
      sghoFrozenSubjects: sgho.board.size,
      umbrellaFrozenSubjects: umbrella.board.size,
      apyUsdFrozenSubjects: apyUsd.board.size,
      stakedUsdatFrozenSubjects: stakedUsdat.board.size,
      fluidBridgeFrozenSubjects: fluidBridge.board.size,
      pyUsdStakingFrozenSubjects: pyUsdStaking.board.size,
      twynePtFrozenSubjects: twynePt.board.size,
      susdePendingFrozenSubjects: susdePending.board.size,
      susdePendingSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'susde_pending_unstake_eth_call' && subject.episodes.length > 0,
      ).length,
      twynePtSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'twyne_pt_borrower_first_leg_eth_call' &&
          subject.episodes.length > 0,
      ).length,
      fluidBridgeSubjectsWithEpisodes: subjects.filter(
        (subject) => subject.stageScope.startsWith('fluid_bridge_') && subject.episodes.length > 0,
      ).length,
      pyUsdStakingSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'pyusd_staking_first_stage_eth_call' &&
          subject.episodes.length > 0,
      ).length,
      apyUsdSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'apyusd_withdraw_initiation_eth_call' &&
          subject.episodes.length > 0,
      ).length,
      stakedUsdatSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'staked_usdat_redeem_eth_call' && subject.episodes.length > 0,
      ).length,
      sghoSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'direct_sgho_withdraw_eth_call' && subject.episodes.length > 0,
      ).length,
      umbrellaSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'direct_umbrella_redeem_eth_call' && subject.episodes.length > 0,
      ).length,
      directVaultSubjectsWithEpisodes: subjects
        .filter(
          (subject) =>
            subject.stageScope.startsWith('direct_usd3_') ||
            subject.stageScope.startsWith('direct_stusds_') ||
            subject.stageScope.startsWith('direct_susds_'),
        )
        .filter((subject) => subject.episodes.length > 0).length,
      fluidFTokenSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'direct_fluid_ftoken_withdraw_eth_call' &&
          subject.episodes.length > 0,
      ).length,
      directSupplierSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          ['direct_spark_withdraw_eth_call', 'direct_compound_v3_withdraw_eth_call'].includes(
            subject.stageScope,
          ) && subject.episodes.length > 0,
      ).length,
      morphoSubjectsWithEpisodes: subjects.filter(
        (subject) =>
          subject.stageScope === 'direct_morpho_vaultv2_withdraw_eth_call' &&
          subject.episodes.length > 0,
      ).length,
      morphoSubjectsWithMeasuredBaseline: subjects.filter(
        (subject) =>
          subject.stageScope === 'direct_morpho_vaultv2_withdraw_eth_call' &&
          subject.episodes.some(
            (row) =>
              row.analysisPrimaryForCell &&
              ['simulated_callable', 'simulated_impaired'].includes(row.baseline),
          ),
      ).length,
      morphoNoHolderIssues: [...morpho.diagnostics.values()].reduce(
        (sum, row) => sum + row.noHolderIssues,
        0,
      ),
      morphoBaselineUnavailableIssues: [...morpho.diagnostics.values()].reduce(
        (sum, row) => sum + row.baselineUnavailableIssues,
        0,
      ),
      rawQHRows: episodes.length,
      analysisPrimaryQHRows: primaryRows.length,
      issueClusters: issueClusters.size,
      measuredBaselineIssueClusters: new Set(
        measuredBaselineRows.map((row) => row.issueClusterSha256),
      ).size,
      baselineImpairedIssueClusters: baselineImpaired.size,
      simulatedOnsetIssueClusters: onsetClusters.size,
      clustersWithObservedCallableAndNoObservedOnset: [...controls].filter(
        (key) => !onsetClusters.has(key),
      ).length,
      simulatedRecoveryIssueClusters: recoveries.size,
      censoredIssueClusters: censored.size,
      pendingOrMissingIssueClusters: pendingOrMissing.size,
      minedFinalAssetPayouts: susdePayout.facts.length,
      calibratedDurationEpisodes: 0,
      retrospectiveTransitionStudies: morphoFixed10kStudy ? 1 : 0,
      retrospectiveTransitionEpisodes: morphoFixed10kStudy?.episodes.length ?? 0,
      retrospectiveTransitionEvents:
        morphoFixed10kStudy?.episodes.reduce(
          (sum, episode) => sum + episode.transitionEvents.length,
          0,
        ) ?? 0,
      retrospectiveDevelopmentEpisodes: morphoFixed10kStudy?.bySplit.development.episodes ?? 0,
      retrospectiveReservedHoldoutEpisodes:
        morphoFixed10kStudy?.bySplit.reservedHoldout.episodes ?? 0,
    },
    retrospectiveTransitionStudies: morphoFixed10kStudy ? [morphoFixed10kStudy] : [],
    subjects,
  }
}

export function cashFeaturesFromVerifiedRecords(records, subject) {
  fail(Array.isArray(records) && records.length <= MAX_FEATURES, 'cash_records_invalid')
  return records.flatMap((receipt) => {
    const row = receipt.rows.find(
      (item) =>
        typeof item.routeKey === 'string' &&
        typeof item.destination === 'string' &&
        typeof item.asset === 'string' &&
        identity(item.routeKey, item.destination, item.asset) ===
          identity(subject.route_key, subject.destination, subject.asset),
    )
    return row?.state === 'observed'
      ? [
          {
            kind: 'aggregate_cash',
            routeKey: subject.route_key,
            destination: subject.destination,
            asset: subject.asset,
            receiptSha256: receipt.sha256,
            collectionMode: receipt.collectionMode,
            sourceBlock: receipt.block,
            sourceBlockHash: receipt.blockHash,
            sourceAt: receipt.blockAt,
            firstLocalReceiptAt: receipt.firstLocalReceiptAt,
            coverageComplete: true,
            valueRaw: row.cashRaw,
          },
        ]
      : []
  })
}

/** Every default loader is a local sealed verifier; no provider or app API is imported. */
export async function readVerifiedHolderExitEpisodePanel(options = {}) {
  const {
    nowMs = Date.now(),
    manifestLoader = async () =>
      (await import('../record-carry-cash-issues.mjs')).buildSubjectManifest(),
    v1IssueLoader = async () =>
      (await import('./carry-public-direct-exit-issue.mjs')).verifyPublicDirectIssues(),
    v1ScoreLoader = async () =>
      (await import('./carry-public-direct-exit-score.mjs')).verifyPublicDirectScores(),
    v2IssueLoader = async () =>
      (await import('./carry-public-aave-usdc-fixed-q-v2-issue.mjs')).verifyAaveFrozenQIssues(),
    v2ScoreLoader = async () =>
      (await import('./carry-public-aave-usdc-fixed-q-v2-score.mjs')).verifyAaveFrozenQScores(),
    v3IssueLoader = async () =>
      (await import('./carry-public-aave-usdc-common-q-v3-issue.mjs')).verifyAaveCommonIssues(),
    v3ScoreLoader = async () =>
      (await import('./carry-public-aave-usdc-common-q-v3-score.mjs')).verifyAaveCommonQScores(),
    morphoIssueLoader = async () =>
      (await import('./carry-local-morpho-holder-v2.mjs')).readV2Issues(),
    morphoScoreLoader = async (issues) =>
      (await import('./carry-local-morpho-holder-v2.mjs')).readV2Scores(issues),
    morphoFixed10kLedgerLoader = async () =>
      readSavedMorphoFixed10kLedger(
        resolve(process.cwd(), 'lib/carry/research/morpho-stable-exit-history-v1'),
      ),
    compoundIssueLoader = async () =>
      (await import('./carry-local-compound-holder-issue.mjs')).verifyPublicDirectIssues(),
    compoundScoreLoader = async () =>
      (await import('./carry-local-compound-holder-score.mjs')).verifyPublicDirectScores(),
    fluidLedgerLoader = async () => {
      const { verifyIssues, verifyScores } = await import('./carry-fluid-ftoken-holder.mjs')
      return [0, 1, 2].map((routeIndex) => {
        const issues = verifyIssues(routeIndex)
        return { routeIndex, issues, scores: verifyScores(routeIndex, issues) }
      })
    },
    usd3IssueLoader = async () =>
      (await import('./carry-public-usd3-exit-issue.mjs')).verifyUsd3Issues(),
    usd3ScoreLoader = async () =>
      (await import('./carry-public-usd3-exit-score.mjs')).verifyUsd3Scores(),
    stusdsIssueLoader = async () =>
      (await import('./carry-public-stusds-exit-issue.mjs')).verifyStusdsIssues(),
    stusdsScoreLoader = async () =>
      (await import('./carry-public-stusds-exit-score.mjs')).verifyStusdsScores(),
    susdsIssueLoader = async () =>
      (await import('./carry-public-susds-exit-issue.mjs')).verifySusdsIssues(),
    susdsScoreLoader = async () =>
      (await import('./carry-public-susds-exit-score.mjs')).verifySusdsScores(),
    sghoLedgerLoader = async () => {
      const v1Issues = await (await import('./carry-public-sgho-exit-issue.mjs')).verifySghoIssues()
      const v1Scores = await (await import('./carry-public-sgho-exit-score.mjs')).verifySghoScores()
      const v2Issues = await (
        await import('./carry-public-sgho-fixed-q-v2-issue.mjs')
      ).verifySghoFixedQIssues()
      const v2Scores = await (
        await import('./carry-public-sgho-fixed-q-v2-score.mjs')
      ).verifySghoFixedQScores()
      return { v1Issues, v1Scores, v2Issues, v2Scores }
    },
    umbrellaLedgerLoader = async () =>
      (await import('./carry-local-umbrella-gho-holder.mjs')).verifyAll(false),
    apyUsdIssueLoader = async () =>
      (await import('./carry-public-apyusd-exit-issue.mjs')).verifyApyUsdIssues(),
    apyUsdScoreLoader = async () =>
      (await import('./carry-public-apyusd-exit-score.mjs')).verifyApyUsdScores(),
    stakedUsdatLedgerLoader = async () =>
      (await import('./carry-local-staked-usdat-holder.mjs')).verifyAll(false),
    fluidBridgeUsdcLedgerLoader = async () =>
      (await import('./carry-fluid-bridge-usdc-holder.mjs')).verifyLedgers(),
    fluidBridgeUsdtLedgerLoader = async () =>
      (await import('./carry-fluid-bridge-usdt-holder.mjs')).verifyLedgers(),
    pyUsdStakingLedgerLoader = async () =>
      (await import('./pyusd-staking-prospective.mjs')).verifyEvidence(),
    twynePtLedgerLoader = async () =>
      (await import('./carry-twyne-borrower-pt.mjs')).verifyLedgers(),
    susdePendingIssueLoader = async () =>
      (await import('./susde-public-pending-exit-issue.mjs')).verifyIssues(),
    susdePendingScoreLoader = async () =>
      (await import('./susde-public-pending-exit-score.mjs')).verifyScores(),
    susdePayoutLoader = readVerifiedSusdePayoutEvidence,
    cashLoader = async (manifest) =>
      (await import('../lib/localCarryCashStore.mjs')).verifyLocalCarryCash(manifest).records,
    issueFlowReplayLoader = async (issue) =>
      (
        await import('./holder-exit-direct-flow-snapshot-replay.mjs')
      ).readVerifiedIssueDirectFlowFeatures(issue),
    clockProofsLoader = async () => [],
  } = options
  const manifest = await manifestLoader()
  const subject = validateManifest(manifest)
  const morphoSubjects = [...morphoBoardSubjects(manifest).values()]
  const supplierSubjects = [...directSupplierBoardSubjects(manifest).values()]
  const fluidSubjects = [...fluidFTokenBoardSubjects(manifest).values()]
  const directVaultSubjects = [...directVaultBoardSubjects(manifest).values()]
  const sghoSubjects = [...sghoBoardSubjects(manifest).values()]
  const umbrellaSubjects = [...umbrellaBoardSubjects(manifest).values()]
  const apyUsdSubjects = [...apyUsdBoardSubjects(manifest).values()]
  const stakedUsdatSubjects = [...stakedUsdatBoardSubjects(manifest).values()]
  const fluidBridgeSubjects = [...fluidBridgeBoardSubjects(manifest).values()]
  const pyUsdStakingSubjects = [...pyUsdStakingBoardSubjects(manifest).values()]
  const twynePtSubjects = [...twynePtBoardSubjects(manifest).values()]
  const susdePendingSubjects = [...susdePendingBoardSubjects(manifest).values()]
  const v1Issues = await v1IssueLoader()
  const v1Scores = await v1ScoreLoader()
  const v2Issues = await v2IssueLoader()
  const v2Scores = await v2ScoreLoader()
  const v3Issues = await v3IssueLoader()
  const v3Scores = await v3ScoreLoader()
  const morphoIssues = await morphoIssueLoader()
  const morphoScores = await morphoScoreLoader(morphoIssues)
  const morphoFixed10kLedger = await morphoFixed10kLedgerLoader()
  const compoundIssues = await compoundIssueLoader()
  const compoundScores = await compoundScoreLoader()
  const fluidRouteLedgers = await fluidLedgerLoader()
  const directVaultLedgers = [
    { lane: 'usd3', issues: await usd3IssueLoader(), scores: await usd3ScoreLoader() },
    { lane: 'stusds', issues: await stusdsIssueLoader(), scores: await stusdsScoreLoader() },
    { lane: 'susds', issues: await susdsIssueLoader(), scores: await susdsScoreLoader() },
  ]
  const sghoLedger = await sghoLedgerLoader()
  const umbrellaLedger = await umbrellaLedgerLoader()
  const apyUsdIssues = await apyUsdIssueLoader()
  const apyUsdScores = await apyUsdScoreLoader()
  const stakedUsdatLedger = await stakedUsdatLedgerLoader()
  const fluidBridgeRouteLedgers = [
    { lane: 'usdc', ledger: await fluidBridgeUsdcLedgerLoader() },
    { lane: 'usdt', ledger: await fluidBridgeUsdtLedgerLoader() },
  ]
  const pyUsdStakingLedger = await pyUsdStakingLedgerLoader()
  const twynePtLedger = await twynePtLedgerLoader()
  const susdePendingIssues = await susdePendingIssueLoader()
  const susdePendingScores = await susdePendingScoreLoader()
  const susdePayoutRecords = await susdePayoutLoader()
  const cashRecords = await cashLoader(manifest)
  const injectedLoaders = Object.keys(options).some((key) => key.endsWith('Loader'))
  // An archive suffix is a rolling view: as new segments arrive, older windows
  // fall outside its bound. Use only an explicit stable feature loader until
  // issue-time flow snapshots can be retained immutably.
  const directFlowFeatures = options.directFlowFeatureLoader
    ? (await options.directFlowFeatureLoader(manifest)).features
    : []
  const issueFlowFeaturesBySha = new Map()
  const directFlowReplay = {
    issuesWithSnapshot: 0,
    verifiedIssues: 0,
    unavailableByReason: {},
    joinedFeatures: 0,
  }
  for (const issue of [...v1Issues, ...compoundIssues]) {
    // Aave USDe is a supplemental issue lane outside the frozen 67-subject panel.
    if (
      !['aaveV3Usdc', 'sparkLendUsdt', 'compoundV3Usdc'].includes(issue.marketKey) ||
      !Object.hasOwn(issue, 'flowSnapshot')
    )
      continue
    directFlowReplay.issuesWithSnapshot += 1
    const replay = await issueFlowReplayLoader(issue)
    fail(
      replay &&
        ['verified', 'unavailable'].includes(replay.status) &&
        Array.isArray(replay.features) &&
        replay.features.length <= 2 &&
        (replay.status === 'verified'
          ? replay.reason === null && replay.features.length > 0
          : typeof replay.reason === 'string' && replay.features.length === 0),
      'issue_flow_replay_invalid',
    )
    if (replay.status === 'verified') {
      fail(
        SHA.test(issue.sha256) && !issueFlowFeaturesBySha.has(issue.sha256),
        'issue_flow_duplicate',
      )
      issueFlowFeaturesBySha.set(
        issue.sha256,
        replay.features.map((feature) => ({
          ...feature,
          sourceBaselineAncestry: issueFlowAncestryMarker(
            issue,
            feature.kind === 'gross_supplier_supply_24h' ? 'supply' : 'withdraw',
          ),
        })),
      )
      directFlowReplay.verifiedIssues += 1
      directFlowReplay.joinedFeatures += replay.features.length
    } else
      directFlowReplay.unavailableByReason[replay.reason] =
        (directFlowReplay.unavailableByReason[replay.reason] ?? 0) + 1
  }
  const features = [
    subject,
    ...morphoSubjects,
    ...supplierSubjects,
    ...fluidSubjects,
    ...directVaultSubjects,
    ...sghoSubjects,
    ...umbrellaSubjects,
    ...apyUsdSubjects,
    ...stakedUsdatSubjects,
    ...fluidBridgeSubjects,
    ...pyUsdStakingSubjects,
    ...twynePtSubjects,
    ...susdePendingSubjects,
  ].flatMap((item) => cashFeaturesFromVerifiedRecords(cashRecords, item))
  features.push(...directFlowFeatures)
  const panel = buildHolderExitEpisodePanel({
    manifest,
    v1Issues,
    v1Scores,
    v2Issues,
    v2Scores,
    v3Issues,
    v3Scores,
    morphoIssues,
    morphoScores,
    morphoFixed10kLedger,
    compoundIssues,
    compoundScores,
    fluidRouteLedgers,
    directVaultLedgers,
    sghoLedger,
    umbrellaLedger,
    apyUsdIssues,
    apyUsdScores,
    stakedUsdatLedger,
    fluidBridgeRouteLedgers,
    pyUsdStakingLedger,
    twynePtLedger,
    susdePendingIssues,
    susdePendingScores,
    susdePayoutRecords,
    features,
    issueFlowFeaturesBySha,
    nowMs,
  })
  const withClockProofs = await applyHolderExitClockProofOverlay(panel, await clockProofsLoader(), {
    nowMs,
  })
  return {
    ...withClockProofs,
    directFlowReplay,
    sourceVerification: injectedLoaders ? 'caller_supplied' : 'offline_sealed_replay',
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2] ?? '--aggregate'
  if (!['--aggregate', '--json-rows'].includes(mode) || process.argv.length > 3)
    throw Error('holder_episode_panel_usage')
  const panel = await readVerifiedHolderExitEpisodePanel()
  const output =
    mode === '--json-rows'
      ? panel
      : {
          ...panel,
          subjects: panel.subjects.map(
            ({ episodes, retrospectiveEpisodes, sghoIssueDiagnostics, ...subject }) => {
              const compactSgho = sghoIssueDiagnostics && { ...sghoIssueDiagnostics }
              if (compactSgho) delete compactSgho.linkedV2Children
              return {
                ...subject,
                ...(compactSgho ? { sghoIssueDiagnostics: compactSgho } : {}),
                episodeRows: episodes.length,
                retrospectiveEpisodeRows: retrospectiveEpisodes.length,
              }
            },
          ),
        }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}
