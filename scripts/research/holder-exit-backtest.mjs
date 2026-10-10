// Offline retrospective replay of the frozen 25-group / 67-subject holder panel.
// This is a backtest, never prospective validation or proof of executable payout.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const HOLDER_EXIT_BACKTEST_VERSION = 1
export const DEFAULT_WALK_FORWARD_SUPPORT = Object.freeze({
  venueHorizonBaseline: 5,
  venueBaseline: 8,
  horizonBaseline: 12,
  globalBaseline: 20,
})

const PANEL_SCOPE = 'offline_frozen_25_67_holder_episode_panel'
const BACKTEST_SCOPE = 'holder_exit_historical_walk_forward_backtest_v1'
const MAX_ROWS = 20_000
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/i
const MEASURED = new Set(['simulated_callable', 'simulated_impaired'])
const MORPHO_FIXED_10K_Q_RAW = '10000000000'
const RETROSPECTIVE_HORIZONS = Object.freeze([1, 4, 24, 48, 168])
const RETROSPECTIVE_RAW_OUTCOMES = new Set([
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

const check = (condition, reason) => {
  if (!condition) throw Error(`holder_exit_backtest_${reason}`)
}
const sha = (value) => createHash('sha256').update(value).digest('hex')
const stateValue = (state) => (state === 'simulated_callable' ? 1 : 0)
const subjectKey = (subject) =>
  `${subject.routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}`
const utcMs = (value) => {
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && new Date(ms).toISOString() === value ? ms : null
}
const bump = (target, key, amount = 1) => {
  target[key] = (target[key] ?? 0) + amount
}
const countBy = (items, keyOf) => {
  const counts = {}
  for (const item of items) bump(counts, keyOf(item))
  return counts
}
const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null)
const bigintRatio = (numerator, denominator) =>
  denominator === 0n ? null : Number((numerator * 1_000_000n) / denominator) / 1_000_000

function expectedRetrospectiveTransitions(states) {
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
      if (firstLoss && !recovery)
        recovery = {
          transition: 'recovered_exitability',
          afterHours: lastLoss,
          throughHours: state.horizonHours,
        }
      if (!firstLoss) lastSuccess = state.horizonHours
      lastComparable = state.horizonHours
    } else if (state.rawOutcome === 'evm_revert') {
      firstLoss ??= {
        transition: 'lost_exitability',
        afterHours: lastSuccess,
        throughHours: state.horizonHours,
      }
      lastLoss = state.horizonHours
      lastComparable = state.horizonHours
    }
  }
  return [firstLoss, recovery].filter(Boolean).map((event) => ({
    ...event,
    intervalNotation: `(${event.afterHours},${event.throughHours}]`,
    hasMissingInterveningSample: states.some(
      (state) =>
        state.horizonHours > event.afterHours &&
        state.horizonHours < event.throughHours &&
        !['success', 'evm_revert'].includes(state.rawOutcome),
    ),
  }))
}

function mechanismEndpoint(stageScope) {
  if (/^direct_.*_(withdraw|redeem)_eth_call$/.test(stageScope))
    return {
      endpoint: 'holder_balance_backed_first_leg_eth_call',
      provesHolderExecution: false,
      provesFinalPayout: false,
    }
  if (stageScope === 'apyusd_withdraw_initiation_eth_call')
    return {
      endpoint: 'withdrawal_initiation_eth_call',
      provesHolderExecution: false,
      provesFinalPayout: false,
    }
  if (stageScope === 'staked_usdat_redeem_eth_call')
    return {
      endpoint: 'redeem_first_leg_eth_call',
      provesHolderExecution: false,
      provesFinalPayout: false,
    }
  if (stageScope.startsWith('fluid_bridge_'))
    return {
      endpoint: 'bridge_first_leg_eth_call',
      provesHolderExecution: false,
      provesFinalPayout: false,
    }
  if (stageScope === 'pyusd_staking_first_stage_eth_call')
    return {
      endpoint: 'staking_exit_first_stage_eth_call',
      provesHolderExecution: false,
      provesFinalPayout: false,
    }
  if (stageScope === 'twyne_pt_borrower_first_leg_eth_call')
    return {
      endpoint: 'borrower_exit_first_leg_eth_call',
      provesHolderExecution: false,
      provesFinalPayout: false,
    }
  if (stageScope === 'susde_pending_unstake_eth_call')
    return {
      endpoint: 'pending_unstake_initiation_eth_call',
      provesHolderExecution: false,
      provesFinalPayout: false,
    }
  return {
    endpoint: 'saved_protocol_specific_assay',
    provesHolderExecution: false,
    provesFinalPayout: false,
  }
}

function validateSupport(support) {
  check(support && typeof support === 'object' && !Array.isArray(support), 'support_invalid')
  for (const key of Object.keys(DEFAULT_WALK_FORWARD_SUPPORT))
    check(Number.isSafeInteger(support[key]) && support[key] > 0, 'support_invalid')
}

function validatePanel(panel) {
  check(panel?.scope === PANEL_SCOPE, 'panel_scope_invalid')
  check(
    ['offline_sealed_replay', 'caller_supplied'].includes(panel.sourceVerification),
    'source_verification_invalid',
  )
  check(Array.isArray(panel.subjects) && panel.subjects.length === 67, 'subjects_invalid')
  check(new Set(panel.subjects.map((subject) => subject.routeKey)).size === 25, 'groups_invalid')
  const identities = new Set()
  let rawRows = 0
  for (const subject of panel.subjects) {
    check(
      typeof subject?.routeKey === 'string' &&
        /^0x[0-9a-f]{40}$/i.test(subject.destination ?? '') &&
        /^0x[0-9a-f]{40}$/i.test(subject.asset ?? '') &&
        typeof subject.stageScope === 'string' &&
        subject.stageScope.length > 0 &&
        Array.isArray(subject.episodes),
      'subject_invalid',
    )
    const key = subjectKey(subject)
    check(!identities.has(key), 'subject_duplicate')
    identities.add(key)
    rawRows += subject.episodes.length
    check(rawRows <= MAX_ROWS, 'row_limit')
  }
  return rawRows
}

function validateRetrospectiveTransitionStudies(panel) {
  const studies = panel.retrospectiveTransitionStudies ?? []
  check(Array.isArray(studies) && studies.length <= 8, 'retrospective_studies_invalid')
  const subjects = new Map(panel.subjects.map((subject) => [subjectKey(subject), subject]))
  const commonHashes = new Set(
    panel.subjects.flatMap((subject) =>
      subject.episodes.flatMap((row) => [row.issueClusterSha256, row.issueSha256]),
    ),
  )
  const seenCells = new Set()
  const episodesByCell = new Map()
  const seenLogicalEpisodes = new Set()
  let episodeCount = 0
  for (const study of studies) {
    check(
      study?.study === 'morpho-v2-usdc-10k-holder-risk-ledger-v1' &&
        [
          'saved_retrospective_cells_disk_integrity_only',
          'caller_supplied_frozen_plan_and_validated_cells',
        ].includes(study.sourceVerification) &&
        SHA.test(study.planSha256 ?? '') &&
        typeof study.routeKey === 'string' &&
        /^0x[0-9a-f]{40}$/i.test(study.asset ?? '') &&
        study.qRaw === MORPHO_FIXED_10K_Q_RAW &&
        study.qUnit === 'asset_raw' &&
        study.stageScope === 'direct_morpho_vaultv2_withdraw_eth_call' &&
        Number.isSafeInteger(study.reservedHoldoutAnchor) &&
        Array.isArray(study.episodes) &&
        study.episodes.length <= 132 &&
        study.walkForwardEligible === false &&
        study.labelAvailabilityClockIndependentlyWitnessed === false &&
        study.forecastValidated === false &&
        study.calibratedDuration === false &&
        study.probabilitiesEstimated === false,
      'retrospective_study_invalid',
    )
    const splitCounts = {
      development: { episodes: 0, transitionEvents: 0, lost: 0, recovered: 0 },
      reservedHoldout: { episodes: 0, transitionEvents: 0, lost: 0, recovered: 0 },
    }
    for (const episode of study.episodes) {
      episodeCount++
      check(episodeCount <= 132, 'retrospective_episode_limit')
      const subject = subjects.get(episode.subject)
      check(
        subject &&
          subject.routeKey === study.routeKey &&
          subject.destination.toLowerCase() === episode.destination &&
          subject.asset.toLowerCase() === study.asset &&
          subject.stageScope === study.stageScope &&
          episode.routeKey === study.routeKey &&
          episode.asset === study.asset &&
          episode.stageScope === study.stageScope &&
          ['development', 'reservedHoldout'].includes(episode.split) &&
          episode.split ===
            (episode.anchorBlock === study.reservedHoldoutAnchor
              ? 'reservedHoldout'
              : 'development') &&
          Number.isSafeInteger(episode.anchorBlock) &&
          SHA.test(episode.cellSha256 ?? '') &&
          !seenCells.has(episode.cellSha256) &&
          !commonHashes.has(episode.cellSha256) &&
          ADDRESS.test(episode.holder ?? '') &&
          SHA.test(episode.holderCommitment ?? '') &&
          SHA.test(episode.holderVaultCorrelationSha256 ?? '') &&
          episode.holderCommitment ===
            sha(`${episode.destination}:${episode.holder.toLowerCase()}`) &&
          episode.holderCommitment === episode.holderVaultCorrelationSha256 &&
          episode.holderBindingScheme === 'sha256(lowercase_vault_colon_lowercase_holder)' &&
          episode.correlationUnit === 'holder_vault' &&
          episode.observationsAreIndependent === false &&
          episode.qRaw === study.qRaw &&
          episode.qUnit === study.qUnit &&
          episode.baseline === 'simulated_callable' &&
          Array.isArray(episode.horizonStates) &&
          episode.horizonStates.length === 5 &&
          Array.isArray(episode.transitionEvents) &&
          episode.transitionEvents.length <= 2,
        'retrospective_episode_invalid',
      )
      seenCells.add(episode.cellSha256)
      episodesByCell.set(episode.cellSha256, episode)
      const logicalEpisode = JSON.stringify([episode.subject, episode.anchorBlock])
      check(!seenLogicalEpisodes.has(logicalEpisode), 'retrospective_episode_duplicate')
      seenLogicalEpisodes.add(logicalEpisode)
      check(
        episode.horizonStates.every(
          (row, index) =>
            row.horizonHours === RETROSPECTIVE_HORIZONS[index] &&
            RETROSPECTIVE_RAW_OUTCOMES.has(row.rawOutcome) &&
            row.outcome?.status ===
              (row.rawOutcome === 'success'
                ? 'simulated_callable'
                : row.rawOutcome === 'evm_revert'
                  ? 'simulated_impaired'
                  : 'censored'),
        ),
        'retrospective_horizon_invalid',
      )
      const expectedTransitions = expectedRetrospectiveTransitions(episode.horizonStates)
      check(
        episode.transitionEvents.length === expectedTransitions.length &&
          episode.transitionEvents.every(
            (event, index) =>
              event.transition === expectedTransitions[index].transition &&
              event.afterHours === expectedTransitions[index].afterHours &&
              event.throughHours === expectedTransitions[index].throughHours &&
              event.intervalNotation === expectedTransitions[index].intervalNotation &&
              event.hasMissingInterveningSample ===
                expectedTransitions[index].hasMissingInterveningSample,
          ),
        'retrospective_first_transition_invalid',
      )
      const split = splitCounts[episode.split]
      split.episodes++
      let lastThrough = -1
      for (const event of episode.transitionEvents) {
        check(
          ['lost_exitability', 'recovered_exitability'].includes(event?.transition) &&
            Number.isSafeInteger(event.afterHours) &&
            event.afterHours >= 0 &&
            Number.isSafeInteger(event.throughHours) &&
            event.throughHours > event.afterHours &&
            event.afterHours >= lastThrough &&
            event.intervalNotation === `(${event.afterHours},${event.throughHours}]` &&
            typeof event.hasMissingInterveningSample === 'boolean' &&
            event.cellSha256 === episode.cellSha256 &&
            event.holderVaultCorrelationSha256 === episode.holderVaultCorrelationSha256,
          'retrospective_transition_invalid',
        )
        const before =
          event.afterHours === 0
            ? 'simulated_callable'
            : episode.horizonStates.find((row) => row.horizonHours === event.afterHours)?.outcome
                ?.status
        const after = episode.horizonStates.find((row) => row.horizonHours === event.throughHours)
          ?.outcome?.status
        check(
          event.transition === 'lost_exitability'
            ? before === 'simulated_callable' && after === 'simulated_impaired'
            : before === 'simulated_impaired' && after === 'simulated_callable',
          'retrospective_transition_state_invalid',
        )
        lastThrough = event.throughHours
        split.transitionEvents++
        if (event.transition === 'lost_exitability') split.lost++
        else split.recovered++
      }
    }
    for (const [split, counts] of Object.entries(splitCounts)) {
      const claimed = study.bySplit?.[split]
      check(
        claimed?.episodes === counts.episodes &&
          claimed.transitionEvents === counts.transitionEvents &&
          claimed.lostExitabilityEvents === counts.lost &&
          claimed.recoveredExitabilityEvents === counts.recovered,
        'retrospective_split_counts_invalid',
      )
    }
  }
  const attachedCells = new Set()
  for (const subject of panel.subjects) {
    const attached = subject.retrospectiveEpisodes ?? []
    check(Array.isArray(attached), 'retrospective_subject_episodes_invalid')
    for (const episode of attached) {
      check(
        episode.subject === subjectKey(subject) &&
          seenCells.has(episode.cellSha256) &&
          JSON.stringify(episode) === JSON.stringify(episodesByCell.get(episode.cellSha256)) &&
          !attachedCells.has(episode.cellSha256),
        'retrospective_subject_binding_invalid',
      )
      attachedCells.add(episode.cellSha256)
    }
  }
  check(attachedCells.size === seenCells.size, 'retrospective_subject_coverage_invalid')
  return studies
}

function summarizeRetrospectiveTransitions(studies, asOfUtc) {
  if (asOfUtc != null)
    return {
      status: 'redacted_at_historical_as_of_without_independent_label_clock',
      redacted: true,
      walkForwardEligible: false,
      includedInWalkForwardRows: false,
      developmentHoldoutPooledForCalibration: false,
      labelAvailabilityClockIndependentlyWitnessed: false,
      asOfEligibleTransitionEvents: null,
      calibratedDuration: false,
      probabilitiesEstimated: false,
      forecastValidated: false,
    }
  const episodes = studies.flatMap((study) => study.episodes.map((episode) => ({ study, episode })))
  const events = episodes.flatMap(({ study, episode }) =>
    episode.transitionEvents.map((event) => ({
      study: study.study,
      sourceVerification: study.sourceVerification,
      routeKey: study.routeKey,
      subject: episode.subject,
      stageScope: study.stageScope,
      split: episode.split,
      anchorBlock: episode.anchorBlock,
      cellSha256: episode.cellSha256,
      holderCommitment: episode.holderCommitment,
      holderVaultCorrelationSha256: episode.holderVaultCorrelationSha256,
      qRaw: episode.qRaw,
      qUnit: episode.qUnit,
      ...event,
    })),
  )
  const summarizeSplit = (split) => {
    const splitEpisodes = episodes.filter(({ episode }) => episode.split === split)
    const splitEvents = events.filter((event) => event.split === split)
    return {
      episodes: splitEpisodes.length,
      holderVaultCorrelationClusters: new Set(
        splitEpisodes.map(({ episode }) => episode.holderVaultCorrelationSha256),
      ).size,
      transitionEvents: splitEvents.length,
      transitions: countBy(splitEvents, (event) => event.transition),
    }
  }
  return {
    status: 'current_saved_evidence_only',
    redacted: false,
    sourceStudies: studies.length,
    episodes: episodes.length,
    holderVaultCorrelationClusters: new Set(
      episodes.map(({ episode }) => episode.holderVaultCorrelationSha256),
    ).size,
    transitionEvents: events.length,
    transitions: countBy(events, (event) => event.transition),
    bySplit: {
      development: summarizeSplit('development'),
      reservedHoldout: summarizeSplit('reservedHoldout'),
    },
    events,
    durationIntervals: {
      timeToImpairment: events
        .filter((event) => event.transition === 'lost_exitability')
        .map(({ transition, ...event }) => event),
      timeToRecovery: events
        .filter((event) => event.transition === 'recovered_exitability')
        .map(({ transition, ...event }) => event),
    },
    walkForwardEligible: false,
    includedInWalkForwardRows: false,
    developmentHoldoutPooledForCalibration: false,
    labelAvailabilityClockIndependentlyWitnessed: false,
    asOfEligibleTransitionEvents: events.length,
    calibratedDuration: false,
    probabilitiesEstimated: false,
    forecastValidated: false,
  }
}

function validateAndAssessRow(row, subject, asOfMs) {
  check(
    row?.subject === subjectKey(subject) &&
      row.stageScope === subject.stageScope &&
      SHA.test(row.issueClusterSha256 ?? '') &&
      SHA.test(row.issueSha256 ?? '') &&
      typeof row.qRaw === 'string' &&
      /^\d+$/.test(row.qRaw) &&
      Number.isSafeInteger(row.plannedHorizonHours) &&
      row.plannedHorizonHours > 0 &&
      typeof row.analysisPrimaryForCell === 'boolean' &&
      row.outcome &&
      typeof row.outcome.status === 'string' &&
      Array.isArray(row.featureRefs),
    'row_invalid',
  )
  const issueMs = utcMs(row.issueAtUtc)
  const targetMs = utcMs(row.targetAtUtc)
  const deadlineMs = utcMs(row.deadlineAtUtc)
  check(issueMs != null && targetMs > issueMs && deadlineMs > targetMs, 'row_clock_invalid')
  if (row.baselineAtUtc != null) {
    const baselineMs = utcMs(row.baselineAtUtc)
    check(baselineMs != null && baselineMs <= issueMs, 'baseline_clock_invalid')
  }
  let originReason = null
  if (row.analysisPrimaryForCell !== true) originReason = 'correlated_nonprimary_row'
  else if (issueMs > asOfMs) originReason = 'origin_after_as_of'
  else if (!row.holderCommitment || !SHA.test(row.holderCommitment))
    originReason = 'holder_unavailable'
  else if (!MEASURED.has(row.baseline)) originReason = `baseline_${row.baseline}`

  for (const feature of row.featureRefs) {
    check(
      typeof feature?.kind === 'string' &&
        feature.kind.length > 0 &&
        SHA.test(feature.receiptSha256 ?? '') &&
        utcMs(feature.sourceAt) != null &&
        utcMs(feature.firstLocalReceiptAt) != null &&
        utcMs(feature.completedAtUtc) != null,
      'feature_invalid',
    )
    if (
      originReason == null &&
      (utcMs(feature.sourceAt) > issueMs ||
        utcMs(feature.firstLocalReceiptAt) > issueMs ||
        utcMs(feature.completedAtUtc) > issueMs)
    )
      originReason = 'feature_available_after_origin'
  }

  let outcomeReason = originReason
  let observedMs = null
  let labelAvailableMs = null
  if (outcomeReason == null && !MEASURED.has(row.outcome.status))
    outcomeReason = `outcome_${row.outcome.status}`
  if (outcomeReason == null && !SHA.test(row.scoreSha256 ?? '')) outcomeReason = 'score_unverified'
  if (outcomeReason == null) {
    observedMs = utcMs(row.observedAtUtc)
    if (observedMs == null) outcomeReason = 'outcome_clock_missing'
    else if (observedMs < targetMs) throw Error('holder_exit_backtest_outcome_before_target')
    else if (observedMs > deadlineMs) outcomeReason = 'outcome_after_deadline'
    else if (observedMs > asOfMs) outcomeReason = 'outcome_unavailable_as_of'
  }
  if (outcomeReason == null) {
    labelAvailableMs = utcMs(row.labelAvailableAtUtc)
    if (labelAvailableMs == null) outcomeReason = 'label_availability_clock_missing'
    else if (labelAvailableMs < observedMs)
      throw Error('holder_exit_backtest_label_available_before_observation')
    else if (labelAvailableMs > asOfMs) outcomeReason = 'label_unavailable_as_of'
  }
  const transition =
    outcomeReason == null
      ? row.baseline === 'simulated_callable'
        ? row.outcome.status === 'simulated_callable'
          ? 'remained_callable'
          : 'lost_exitability'
        : row.outcome.status === 'simulated_callable'
          ? 'recovered_exitability'
          : 'remained_impaired'
      : null
  return {
    routeKey: subject.routeKey,
    subject: row.subject,
    stageScope: subject.stageScope,
    issueClusterSha256: row.issueClusterSha256,
    issueSha256: row.issueSha256,
    holderCommitment: row.holderCommitment ?? null,
    qRaw: row.qRaw,
    qUnit: row.qUnit ?? null,
    horizonHours: row.plannedHorizonHours,
    issueMs,
    targetMs,
    deadlineMs,
    observedMs,
    labelAvailableMs,
    baseline: row.baseline,
    outcome: row.outcome.status,
    originReason,
    outcomeReason,
    transition,
  }
}

function collapseTrainingClusters(rows) {
  const clusters = new Map()
  for (const row of rows) {
    const key = `${row.routeKey}\0${row.issueClusterSha256}`
    const cluster = clusters.get(key) ?? { outcomes: new Set(), rows: 0 }
    cluster.outcomes.add(row.outcome)
    cluster.rows++
    clusters.set(key, cluster)
  }
  const labels = []
  let conflictingClusters = 0
  for (const cluster of clusters.values()) {
    if (cluster.outcomes.size !== 1) {
      conflictingClusters++
      continue
    }
    labels.push(stateValue([...cluster.outcomes][0]))
  }
  return { labels, conflictingClusters }
}

function trainingTier(candidate, history, support) {
  const tiers = [
    {
      name: 'venue_horizon_baseline',
      minimum: support.venueHorizonBaseline,
      matches: (row) =>
        row.stageScope === candidate.stageScope &&
        row.routeKey === candidate.routeKey &&
        row.horizonHours === candidate.horizonHours &&
        row.baseline === candidate.baseline,
    },
    {
      name: 'venue_baseline',
      minimum: support.venueBaseline,
      matches: (row) =>
        row.stageScope === candidate.stageScope &&
        row.routeKey === candidate.routeKey &&
        row.baseline === candidate.baseline,
    },
    {
      name: 'horizon_baseline_transfer',
      minimum: support.horizonBaseline,
      matches: (row) =>
        row.stageScope === candidate.stageScope &&
        row.horizonHours === candidate.horizonHours &&
        row.baseline === candidate.baseline,
    },
    {
      name: 'global_baseline_transfer',
      minimum: support.globalBaseline,
      matches: (row) =>
        row.stageScope === candidate.stageScope && row.baseline === candidate.baseline,
    },
  ]
  for (const tier of tiers) {
    const collapsed = collapseTrainingClusters(history.filter(tier.matches))
    if (collapsed.labels.length < tier.minimum) continue
    const callable = collapsed.labels.reduce((sum, value) => sum + value, 0)
    return {
      name: tier.name,
      trainingClusters: collapsed.labels.length,
      conflictingTrainingClusters: collapsed.conflictingClusters,
      historicalAssayStateProbabilityCallable: (callable + 1) / (collapsed.labels.length + 2),
    }
  }
  return null
}

/**
 * Walk forward in issue-clock order. A prior label is visible only when its
 * saved local score clock is at or before the current origin. The target block
 * remains the event clock, but does not make a label available for training.
 * Same-cluster rows are always excluded, including already observed shorter
 * horizons.
 */
export function replayWalkForward(rows, support = DEFAULT_WALK_FORWARD_SUPPORT) {
  validateSupport(support)
  check(Array.isArray(rows) && rows.length <= MAX_ROWS, 'rows_invalid')
  const candidates = rows
    .filter((row) => row.outcomeReason == null)
    .sort((a, b) => {
      const ordinary =
        a.issueMs - b.issueMs ||
        a.routeKey.localeCompare(b.routeKey) ||
        a.issueClusterSha256.localeCompare(b.issueClusterSha256) ||
        a.horizonHours - b.horizonHours
      if (ordinary) return ordinary
      const aQ = BigInt(a.qRaw)
      const bQ = BigInt(b.qRaw)
      return aQ < bQ ? -1 : aQ > bQ ? 1 : 0
    })
  return candidates.map((candidate) => {
    const history = candidates.filter(
      (row) =>
        row.issueMs < candidate.issueMs &&
        row.labelAvailableMs <= candidate.issueMs &&
        row.targetMs <= candidate.issueMs &&
        row.issueClusterSha256 !== candidate.issueClusterSha256,
    )
    const tier = trainingTier(candidate, history, support)
    return {
      routeKey: candidate.routeKey,
      stageScope: candidate.stageScope,
      issueClusterSha256: candidate.issueClusterSha256,
      horizonHours: candidate.horizonHours,
      baseline: candidate.baseline,
      observedAssayCallable: stateValue(candidate.outcome),
      assayStatePersistenceProbabilityCallable: stateValue(candidate.baseline),
      historicalAssayStateProbabilityCallable:
        tier?.historicalAssayStateProbabilityCallable ?? null,
      trainingTier: tier?.name ?? null,
      trainingClusters: tier?.trainingClusters ?? 0,
      conflictingTrainingClusters: tier?.conflictingTrainingClusters ?? 0,
    }
  })
}

function scoreProbabilities(predictions, probabilityKey) {
  const scored = predictions.filter((row) => row[probabilityKey] != null)
  if (!scored.length)
    return {
      scoredRows: 0,
      uniqueIssueClusters: 0,
      observedCallableRows: 0,
      observedImpairedRows: 0,
      rowsAreIndependentSamples: false,
      statisticalIndependenceValidated: false,
      meanAssayStateProbabilityCallable: null,
      accuracy: null,
      brierScore: null,
      logLoss: null,
      clusterBalancedAccuracy: null,
      clusterBalancedBrierScore: null,
    }
  let correct = 0
  let brier = 0
  let logLoss = 0
  let probability = 0
  const clusters = new Map()
  for (const row of scored) {
    const p = row[probabilityKey]
    const actual = row.observedAssayCallable
    const error = p - actual
    correct += Number(p >= 0.5 === Boolean(actual))
    brier += error * error
    probability += p
    const bounded = Math.max(1e-12, Math.min(1 - 1e-12, p))
    logLoss -= actual * Math.log(bounded) + (1 - actual) * Math.log(1 - bounded)
    const key = `${row.routeKey}\0${row.issueClusterSha256}`
    const cluster = clusters.get(key) ?? { correct: 0, brier: 0, rows: 0 }
    cluster.correct += Number(p >= 0.5 === Boolean(actual))
    cluster.brier += error * error
    cluster.rows++
    clusters.set(key, cluster)
  }
  const clusterValues = [...clusters.values()]
  return {
    scoredRows: scored.length,
    uniqueIssueClusters: clusters.size,
    rowsAreIndependentSamples: false,
    statisticalIndependenceValidated: false,
    observedCallableRows: scored.reduce((sum, row) => sum + row.observedAssayCallable, 0),
    observedImpairedRows: scored.reduce((sum, row) => sum + 1 - row.observedAssayCallable, 0),
    meanAssayStateProbabilityCallable: probability / scored.length,
    accuracy: correct / scored.length,
    brierScore: brier / scored.length,
    logLoss: logLoss / scored.length,
    clusterBalancedAccuracy:
      clusterValues.reduce((sum, cluster) => sum + cluster.correct / cluster.rows, 0) /
      clusterValues.length,
    clusterBalancedBrierScore:
      clusterValues.reduce((sum, cluster) => sum + cluster.brier / cluster.rows, 0) /
      clusterValues.length,
  }
}

function pairedDeltas(historical, persistence) {
  if (!historical.scoredRows || historical.scoredRows !== persistence.scoredRows) return null
  return {
    accuracy: historical.accuracy - persistence.accuracy,
    brierScore: historical.brierScore - persistence.brierScore,
    logLoss: historical.logLoss - persistence.logLoss,
    clusterBalancedAccuracy:
      historical.clusterBalancedAccuracy - persistence.clusterBalancedAccuracy,
    clusterBalancedBrierScore:
      historical.clusterBalancedBrierScore - persistence.clusterBalancedBrierScore,
  }
}

function scoreSlice(predictions) {
  const walkForwardScored = predictions.filter(
    (row) => row.historicalAssayStateProbabilityCallable != null,
  )
  const historical = scoreProbabilities(
    walkForwardScored,
    'historicalAssayStateProbabilityCallable',
  )
  const pairedPersistence = scoreProbabilities(
    walkForwardScored,
    'assayStatePersistenceProbabilityCallable',
  )
  return {
    rows: predictions.length,
    uniqueIssueClusters: new Set(predictions.map((row) => row.issueClusterSha256)).size,
    rowsAreIndependentSamples: false,
    statisticalIndependenceValidated: false,
    transitions: countBy(predictions, (row) =>
      row.baseline === 'simulated_callable'
        ? row.observedAssayCallable
          ? 'remained_callable'
          : 'lost_exitability'
        : row.observedAssayCallable
          ? 'recovered_exitability'
          : 'remained_impaired',
    ),
    historicalAssayStateBaseline: {
      abstainedRows: predictions.length - walkForwardScored.length,
      abstentionReasons:
        predictions.length === walkForwardScored.length
          ? {}
          : { insufficient_prior_clusters: predictions.length - walkForwardScored.length },
      trainingTiers: countBy(walkForwardScored, (row) => row.trainingTier),
      ...historical,
      pairedAssayStatePersistence: pairedPersistence,
      pairedDeltasVersusPersistence: pairedDeltas(historical, pairedPersistence),
    },
  }
}

function maxExitBacktest(rows) {
  const cohorts = new Map()
  for (const row of rows.filter((entry) => entry.originReason !== 'correlated_nonprimary_row')) {
    const key = [
      row.subject,
      row.issueClusterSha256,
      row.horizonHours,
      row.issueMs,
      row.targetMs,
      row.qUnit ?? 'raw',
    ].join('\0')
    const cohort = cohorts.get(key) ?? {
      routeKey: row.routeKey,
      horizonHours: row.horizonHours,
      rows: [],
    }
    cohort.rows.push(row)
    cohorts.set(key, cohort)
  }
  const complete = []
  const abstentions = {}
  for (const cohort of cohorts.values()) {
    const qValues = new Set(cohort.rows.map((row) => row.qRaw))
    const reason =
      qValues.size < 2
        ? 'fewer_than_two_assayed_sizes'
        : cohort.rows.find((row) => row.outcomeReason)?.outcomeReason
    if (reason) {
      bump(abstentions, reason)
      continue
    }
    const maxQ = cohort.rows.reduce((max, row) => {
      const q = BigInt(row.qRaw)
      return q > max ? q : max
    }, 0n)
    const baselineMax = cohort.rows.reduce(
      (max, row) =>
        row.baseline === 'simulated_callable' && BigInt(row.qRaw) > max ? BigInt(row.qRaw) : max,
      0n,
    )
    const outcomeMax = cohort.rows.reduce(
      (max, row) =>
        row.outcome === 'simulated_callable' && BigInt(row.qRaw) > max ? BigInt(row.qRaw) : max,
      0n,
    )
    const error = baselineMax > outcomeMax ? baselineMax - outcomeMax : outcomeMax - baselineMax
    complete.push({
      routeKey: cohort.routeKey,
      horizonHours: cohort.horizonHours,
      exact: baselineMax === outcomeMax,
      direction:
        baselineMax === outcomeMax ? 'unchanged' : outcomeMax < baselineMax ? 'shrank' : 'grew',
      normalizedAbsoluteError: bigintRatio(error, maxQ),
    })
  }
  const summarize = (items) => ({
    completeCohorts: items.length,
    exactCohorts: items.filter((item) => item.exact).length,
    exactRate: ratio(items.filter((item) => item.exact).length, items.length),
    shrankCohorts: items.filter((item) => item.direction === 'shrank').length,
    grewCohorts: items.filter((item) => item.direction === 'grew').length,
    meanNormalizedAbsoluteError: items.length
      ? items.reduce((sum, item) => sum + item.normalizedAbsoluteError, 0) / items.length
      : null,
  })
  return {
    assayedCohorts: cohorts.size,
    abstainedCohorts: cohorts.size - complete.length,
    abstentions,
    ...summarize(complete),
    byHorizon: [...new Set(complete.map((item) => item.horizonHours))]
      .sort((a, b) => a - b)
      .map((horizonHours) => ({
        horizonHours,
        ...summarize(complete.filter((item) => item.horizonHours === horizonHours)),
      })),
  }
}

function durationProxy(rows) {
  const trajectories = new Map()
  for (const row of rows.filter((entry) => entry.originReason == null)) {
    const key = [row.subject, row.issueClusterSha256, row.holderCommitment, row.qRaw].join('\0')
    const trajectory = trajectories.get(key) ?? { routeKey: row.routeKey, rows: [] }
    trajectory.rows.push(row)
    trajectories.set(key, trajectory)
  }
  const observations = { timeToImpairment: [], timeToRecovery: [] }
  const abstentions = {}
  for (const trajectory of trajectories.values()) {
    const baselines = new Set(trajectory.rows.map((row) => row.baseline))
    if (baselines.size !== 1) {
      bump(abstentions, 'baseline_state_conflict')
      continue
    }
    const measured = trajectory.rows
      .filter((row) => row.outcomeReason == null)
      .sort((a, b) => a.horizonHours - b.horizonHours)
    if (!measured.length) {
      bump(abstentions, 'no_measured_horizon')
      continue
    }
    const baseline = [...baselines][0]
    const eventState =
      baseline === 'simulated_callable' ? 'simulated_impaired' : 'simulated_callable'
    const changeIndex = measured.findIndex((row) => row.outcome === eventState)
    const observation =
      changeIndex >= 0
        ? {
            routeKey: trajectory.routeKey,
            intervalCensoredChange: true,
            lastKnownUnchangedHorizonHours:
              changeIndex === 0 ? 0 : measured[changeIndex - 1].horizonHours,
            firstChangedHorizonHours: measured[changeIndex].horizonHours,
            lastObservedHorizonHours: measured.at(-1).horizonHours,
          }
        : {
            routeKey: trajectory.routeKey,
            intervalCensoredChange: false,
            lastKnownUnchangedHorizonHours: measured.at(-1).horizonHours,
            firstChangedHorizonHours: null,
            lastObservedHorizonHours: measured.at(-1).horizonHours,
          }
    observations[baseline === 'simulated_callable' ? 'timeToImpairment' : 'timeToRecovery'].push(
      observation,
    )
  }
  const summarize = (items) => {
    const changed = items.filter((item) => item.intervalCensoredChange)
    return {
      trajectories: items.length,
      intervalCensoredChanges: changed.length,
      rightCensored: items.length - changed.length,
      changeIntervals: changed.map((item) => ({
        routeKey: item.routeKey,
        lastKnownUnchangedHorizonHours: item.lastKnownUnchangedHorizonHours,
        firstChangedHorizonHours: item.firstChangedHorizonHours,
        intervalNotation: `(${item.lastKnownUnchangedHorizonHours},${item.firstChangedHorizonHours}]`,
      })),
      medianDurationHours: null,
      medianStatus: changed.length
        ? 'not_identified_from_interval_censored_changes'
        : 'not_reached_within_observed_horizons',
    }
  }
  return {
    status: 'interval_and_right_censored_assay_state_changes',
    calibratedDuration: false,
    abstentions,
    timeToImpairment: summarize(observations.timeToImpairment),
    timeToRecovery: summarize(observations.timeToRecovery),
  }
}

function groupSummary(
  subjects,
  assessed,
  predictions,
  routeKey,
  retrospectiveStudies,
  retrospectiveRedacted,
) {
  const groupSubjects = subjects.filter((subject) => subject.routeKey === routeKey)
  const groupRows = assessed.filter((row) => row.routeKey === routeKey)
  const primaryRows = groupRows.filter((row) => row.originReason !== 'correlated_nonprimary_row')
  const scorable = groupRows.filter((row) => row.outcomeReason == null)
  const retrospectiveEpisodes = retrospectiveRedacted
    ? []
    : retrospectiveStudies.flatMap((study) => (study.routeKey === routeKey ? study.episodes : []))
  const retrospectiveEvents = retrospectiveEpisodes.flatMap((episode) =>
    episode.transitionEvents.map((event) => ({ ...event, split: episode.split })),
  )
  return {
    routeKey,
    exactSubjects: groupSubjects.length,
    stageScopes: [...new Set(groupSubjects.map((subject) => subject.stageScope))].sort(),
    rawRows: groupRows.length,
    primaryRows: primaryRows.length,
    scorableRows: scorable.length,
    subjectsWithScorableRows: new Set(scorable.map((row) => row.subject)).size,
    horizonsSeen: [...new Set(primaryRows.map((row) => row.horizonHours))].sort((a, b) => a - b),
    availability:
      primaryRows.length === 0
        ? 'no_episode_rows'
        : scorable.length === 0
          ? 'no_scorable_outcomes'
          : 'retrospectively_scorable',
    abstentions: countBy(
      primaryRows.filter((row) => row.outcomeReason != null),
      (row) => row.outcomeReason,
    ),
    retrospectiveEpisodeEvidence: retrospectiveRedacted
      ? {
          status: 'redacted_at_historical_as_of_without_independent_label_clock',
          includedInWalkForwardRows: false,
          forecastValidated: false,
        }
      : {
          status: 'current_saved_evidence_only',
          episodes: retrospectiveEpisodes.length,
          transitionEvents: retrospectiveEvents.length,
          transitions: countBy(retrospectiveEvents, (event) => event.transition),
          developmentTransitionEvents: retrospectiveEvents.filter(
            (event) => event.split === 'development',
          ).length,
          reservedHoldoutTransitionEvents: retrospectiveEvents.filter(
            (event) => event.split === 'reservedHoldout',
          ).length,
          includedInWalkForwardRows: false,
          forecastValidated: false,
        },
    ...scoreSlice(predictions.filter((row) => row.routeKey === routeKey)),
  }
}

/** Build a bounded, leakage-checked retrospective report from the frozen panel. */
export function buildHolderExitHistoricalBacktest({
  panel,
  asOfUtc = null,
  support = DEFAULT_WALK_FORWARD_SUPPORT,
}) {
  const rawRows = validatePanel(panel)
  const retrospectiveStudies = validateRetrospectiveTransitionStudies(panel)
  const retrospectiveTransitions = summarizeRetrospectiveTransitions(retrospectiveStudies, asOfUtc)
  const retrospectiveRedacted = asOfUtc != null
  validateSupport(support)
  const asOfMs = asOfUtc == null ? Infinity : utcMs(asOfUtc)
  check(asOfMs != null, 'as_of_invalid')
  const assessed = panel.subjects.flatMap((subject) =>
    subject.episodes.map((row) => validateAndAssessRow(row, subject, asOfMs)),
  )
  const primary = assessed.filter((row) => row.originReason !== 'correlated_nonprimary_row')
  const scorable = assessed.filter((row) => row.outcomeReason == null)
  const predictions = replayWalkForward(scorable, support)
  const routeKeys = [...new Set(panel.subjects.map((subject) => subject.routeKey))].sort()
  const horizons = [...new Set(primary.map((row) => row.horizonHours))].sort((a, b) => a - b)
  const transitions = countBy(scorable, (row) => row.transition)
  const walkForwardObservedTransitionEvents =
    (transitions.lost_exitability ?? 0) + (transitions.recovered_exitability ?? 0)
  const hasCurrentRetrospectiveTransitions =
    !retrospectiveRedacted && retrospectiveTransitions.transitionEvents > 0
  return {
    scope: BACKTEST_SCOPE,
    version: HOLDER_EXIT_BACKTEST_VERSION,
    generatedAtUtc: new Date().toISOString(),
    asOfUtc,
    sourcePanel: panel.scope,
    sourceVerification: panel.sourceVerification,
    manifestSha256: panel.manifestSha256 ?? null,
    studyType: 'retrospective_walk_forward_backtest',
    forecastValidated: false,
    prospectiveValidation: false,
    statisticalIndependenceValidated: false,
    labelAvailabilityClockIndependentlyWitnessed: false,
    executablePayoutProven: false,
    summary: {
      routeGroups: routeKeys.length,
      exactSubjects: panel.subjects.length,
      rawRows,
      primaryRows: primary.length,
      correlatedNonprimaryRows: rawRows - primary.length,
      scorableRows: scorable.length,
      scorableIssueClusters: new Set(scorable.map((row) => row.issueClusterSha256)).size,
      groupsWithScorableRows: new Set(scorable.map((row) => row.routeKey)).size,
      subjectsWithScorableRows: new Set(scorable.map((row) => row.subject)).size,
      abstainedPrimaryRows: primary.length - scorable.length,
      abstentions: countBy(
        primary.filter((row) => row.outcomeReason != null),
        (row) => row.outcomeReason,
      ),
      transitions,
      walkForwardObservedTransitionEvents,
      retrospectiveEpisodeTransitionEvents: retrospectiveRedacted
        ? null
        : retrospectiveTransitions.transitionEvents,
      retrospectiveEpisodeTransitionEventsEligibleAtAsOf:
        retrospectiveTransitions.asOfEligibleTransitionEvents,
      rowsAreIndependentSamples: false,
      independentSampleCount: null,
      historicalAssayStateBaseline: {
        support,
        ...scoreSlice(predictions).historicalAssayStateBaseline,
      },
      interpretation:
        walkForwardObservedTransitionEvents === 0 && !hasCurrentRetrospectiveTransitions
          ? 'Assay-state persistence can be replayed, but alert discrimination and duration cannot be estimated from a panel with no observed state changes.'
          : walkForwardObservedTransitionEvents === 0
            ? 'The separate frozen retrospective episode history contains interval-censored state changes. It remains outside walk-forward scoring because its label-availability clock is not independently witnessed; alert discrimination and calibrated duration remain unavailable.'
            : 'Observed assay-state changes permit exploratory discrimination metrics; prospective validation remains separate.',
    },
    byHorizon: horizons.map((horizonHours) => ({
      horizonHours,
      ...scoreSlice(predictions.filter((row) => row.horizonHours === horizonHours)),
    })),
    byVenueGroup: routeKeys.map((routeKey) =>
      groupSummary(
        panel.subjects,
        assessed,
        predictions,
        routeKey,
        retrospectiveStudies,
        retrospectiveRedacted,
      ),
    ),
    byMechanism: [...new Set(panel.subjects.map((subject) => subject.stageScope))]
      .sort()
      .map((stageScope) => {
        const mechanismSubjects = panel.subjects.filter(
          (subject) => subject.stageScope === stageScope,
        )
        const mechanismRows = assessed.filter((row) => row.stageScope === stageScope)
        const mechanismPredictions = predictions.filter((row) => row.stageScope === stageScope)
        const primaryRows = mechanismRows.filter(
          (row) => row.originReason !== 'correlated_nonprimary_row',
        )
        return {
          stageScope,
          ...mechanismEndpoint(stageScope),
          routeGroups: new Set(mechanismSubjects.map((subject) => subject.routeKey)).size,
          exactSubjects: mechanismSubjects.length,
          primaryRows: primaryRows.length,
          scorableRows: mechanismRows.filter((row) => row.outcomeReason == null).length,
          abstentions: countBy(
            primaryRows.filter((row) => row.outcomeReason != null),
            (row) => row.outcomeReason,
          ),
          ...scoreSlice(mechanismPredictions),
        }
      }),
    maxAssayedExit: maxExitBacktest(assessed),
    durationProxy: durationProxy(assessed),
    retrospectiveEpisodeTransitions: retrospectiveTransitions,
    methodology: {
      target: 'holder-specific simulated callable versus impaired state at each saved horizon',
      assayStatePersistenceBenchmark:
        'use the issue-time assay state as the horizon assay-state baseline',
      comparisonUnit:
        'historical assay-state and persistence metrics are paired on the exact rows scored by the historical baseline',
      historicalAssayStateBaseline:
        'Laplace-smoothed callable rate from prior unanimous issue-cluster labels, always conditioned on the same stageScope; venue/horizon first, then explicit within-mechanism transfer tiers',
      labelAvailability:
        'saved local score clock; a label enters training only after labelAvailableAtUtc and targetAtUtc, and never trains its own issue cluster',
      maxExitTarget:
        'largest assayed Q that simulated callable, scored only when every Q in a multi-size cohort has a verified outcome',
      durationTarget:
        'interval-censored assay-state change bounds between the last unchanged horizon and first changed horizon, with right censoring when no change is observed',
      caveats: [
        'This uses saved historical eth_call and first-leg observations, not mined holder payouts.',
        'ObservedAtUtc is the target block or event clock; labelAvailableAtUtc is the saved local score clock used by walk-forward replay.',
        'The saved local score clock is not independently witnessed, so its availability provenance remains a retrospective leakage limitation.',
        'Repeated Q, holder, and horizon rows are correlated. Statistical independence is not validated, and row counts are not independent sample counts.',
        'Perfect persistence accuracy with no state changes is a class-balance result, not evidence that alerts can predict deterioration.',
        'The frozen Morpho fixed-$10k transition study is reported as a separate retrospective sidecar and never enters walk-forward training or probability metrics because its local label-availability clock is not independently witnessed.',
        'Development and reserved-holdout fixed-$10k episodes remain separate and are not pooled for calibration.',
        'No retrospective result is labeled prospective validation.',
      ],
    },
  }
}

async function cli(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument !== '--as-of' || values.asOfUtc != null || argv[index + 1] == null)
      throw Error('holder_exit_backtest_usage')
    values.asOfUtc = argv[++index]
  }
  const { readVerifiedHolderExitEpisodePanel } = await import('./holder-exit-episode-panel.mjs')
  const panel = await readVerifiedHolderExitEpisodePanel({
    ...(values.asOfUtc ? { nowMs: utcMs(values.asOfUtc) } : {}),
  })
  return buildHolderExitHistoricalBacktest({ panel, asOfUtc: values.asOfUtc ?? null })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${JSON.stringify(await cli(process.argv.slice(2)), null, 2)}\n`)
