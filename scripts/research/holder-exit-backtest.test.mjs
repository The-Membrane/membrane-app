import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildHolderExitHistoricalBacktest, replayWalkForward } from './holder-exit-backtest.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const address = (value) => `0x${value.toString(16).padStart(40, '0')}`
const supportOne = {
  venueHorizonBaseline: 1,
  venueBaseline: 1,
  horizonBaseline: 1,
  globalBaseline: 1,
}

function subjects() {
  return Array.from({ length: 67 }, (_, index) => ({
    routeKey: `route-${Math.min(index, 24)}`,
    destination: address(index + 1),
    asset: address(index + 101),
    stageScope: `stage-${Math.min(index, 24)}`,
    episodes: [],
  }))
}

function panel(episodesBySubject = new Map(), retrospectiveTransitionStudies = []) {
  const rows = subjects()
  for (const [index, episodes] of episodesBySubject) rows[index].episodes = episodes
  for (const study of retrospectiveTransitionStudies)
    for (const retrospectiveEpisode of study.episodes) {
      const subject = rows.find(
        (row) =>
          `${row.routeKey}\0${row.destination.toLowerCase()}\0${row.asset.toLowerCase()}` ===
          retrospectiveEpisode.subject,
      )
      assert.ok(subject)
      subject.stageScope = study.stageScope
      subject.retrospectiveEpisodes ??= []
      subject.retrospectiveEpisodes.push(retrospectiveEpisode)
    }
  return {
    scope: 'offline_frozen_25_67_holder_episode_panel',
    sourceVerification: 'offline_sealed_replay',
    manifestSha256: sha('manifest'),
    retrospectiveTransitionStudies,
    subjects: rows,
  }
}

function episode(subject, id, overrides = {}) {
  const issueAtUtc = overrides.issueAtUtc ?? '2026-01-01T00:00:00.000Z'
  const targetAtUtc = overrides.targetAtUtc ?? '2026-01-01T01:00:00.000Z'
  const deadlineAtUtc = overrides.deadlineAtUtc ?? '2026-01-01T02:00:00.000Z'
  const observedAtUtc = overrides.observedAtUtc ?? targetAtUtc
  const labelAvailableAtUtc = overrides.labelAvailableAtUtc ?? observedAtUtc
  return {
    subject: `${subject.routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}`,
    stageScope: subject.stageScope,
    issueClusterSha256: sha(`cluster-${id}`),
    issueSha256: sha(`issue-${id}`),
    scoreSha256: sha(`score-${id}`),
    holderCommitment: sha(`holder-${id}`),
    qRaw: '100',
    qUnit: 'asset_raw',
    plannedHorizonHours: 1,
    issueAtUtc,
    baselineAtUtc: new Date(Date.parse(issueAtUtc) - 60_000).toISOString(),
    targetAtUtc,
    deadlineAtUtc,
    observedAtUtc,
    labelAvailableAtUtc,
    baseline: 'simulated_callable',
    outcome: { status: 'simulated_callable', reason: null },
    featureRefs: [],
    featureAbstentions: {},
    analysisPrimaryForCell: true,
    ...overrides,
  }
}

function retrospectiveStudy() {
  const subject = subjects()[0]
  const subjectIdentity = `${subject.routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}`
  const makeEpisode = ({ split, anchorBlock, id, holder, horizonStates, transitionEvents }) => {
    const cellSha256 = sha(`retrospective-cell-${id}`)
    const holderCommitment = sha(`${subject.destination.toLowerCase()}:${holder.toLowerCase()}`)
    return {
      subject: subjectIdentity,
      routeKey: subject.routeKey,
      destination: subject.destination.toLowerCase(),
      asset: subject.asset.toLowerCase(),
      stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
      split,
      anchorBlock,
      cellSha256,
      holder: holder.toLowerCase(),
      holderCommitment,
      holderVaultCorrelationSha256: holderCommitment,
      holderBindingScheme: 'sha256(lowercase_vault_colon_lowercase_holder)',
      correlationUnit: 'holder_vault',
      observationsAreIndependent: false,
      qRaw: '10000000000',
      qUnit: 'asset_raw',
      baseline: 'simulated_callable',
      horizonStates,
      transitionEvents: transitionEvents.map((event) => ({
        ...event,
        cellSha256,
        holderVaultCorrelationSha256: holderCommitment,
      })),
    }
  }
  const development = makeEpisode({
    split: 'development',
    anchorBlock: 100,
    id: 'development',
    holder: address(901),
    horizonStates: [
      {
        horizonHours: 1,
        rawOutcome: 'success',
        outcome: { status: 'simulated_callable', reason: null },
      },
      {
        horizonHours: 4,
        rawOutcome: 'success',
        outcome: { status: 'simulated_callable', reason: null },
      },
      {
        horizonHours: 24,
        rawOutcome: 'success',
        outcome: { status: 'simulated_callable', reason: null },
      },
      {
        horizonHours: 48,
        rawOutcome: 'evm_revert',
        outcome: { status: 'simulated_impaired', reason: null },
      },
      {
        horizonHours: 168,
        rawOutcome: 'success',
        outcome: { status: 'simulated_callable', reason: null },
      },
    ],
    transitionEvents: [
      {
        transition: 'lost_exitability',
        afterHours: 24,
        throughHours: 48,
        intervalNotation: '(24,48]',
        hasMissingInterveningSample: false,
      },
      {
        transition: 'recovered_exitability',
        afterHours: 48,
        throughHours: 168,
        intervalNotation: '(48,168]',
        hasMissingInterveningSample: false,
      },
    ],
  })
  const holdout = makeEpisode({
    split: 'reservedHoldout',
    anchorBlock: 200,
    id: 'holdout',
    holder: address(902),
    horizonStates: [1, 4, 24, 48, 168].map((horizonHours) => ({
      horizonHours,
      rawOutcome: 'success',
      outcome: { status: 'simulated_callable', reason: null },
    })),
    transitionEvents: [],
  })
  return {
    study: 'morpho-v2-usdc-10k-holder-risk-ledger-v1',
    sourceVerification: 'saved_retrospective_cells_disk_integrity_only',
    planSha256: sha('retrospective-plan'),
    routeKey: subject.routeKey,
    asset: subject.asset.toLowerCase(),
    qRaw: '10000000000',
    qUnit: 'asset_raw',
    stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
    reservedHoldoutAnchor: 200,
    episodes: [development, holdout],
    bySplit: {
      development: {
        episodes: 1,
        holderVaultCorrelationClusters: 1,
        transitionEvents: 2,
        lostExitabilityEvents: 1,
        recoveredExitabilityEvents: 1,
      },
      reservedHoldout: {
        episodes: 1,
        holderVaultCorrelationClusters: 1,
        transitionEvents: 0,
        lostExitabilityEvents: 0,
        recoveredExitabilityEvents: 0,
      },
    },
    sharedHolderVaultCorrelationClustersAcrossSplits: 0,
    walkForwardEligible: false,
    labelAvailabilityClockIndependentlyWitnessed: false,
    forecastValidated: false,
    calibratedDuration: false,
    probabilitiesEstimated: false,
  }
}

test('frozen Morpho transition episodes are reported without entering walk-forward training', () => {
  const study = retrospectiveStudy()
  const result = buildHolderExitHistoricalBacktest({ panel: panel(new Map(), [study]) })
  assert.equal(result.summary.rawRows, 0)
  assert.deepEqual(result.summary.transitions, {})
  assert.equal(result.summary.walkForwardObservedTransitionEvents, 0)
  assert.equal(result.summary.retrospectiveEpisodeTransitionEvents, 2)
  assert.equal(Object.hasOwn(result.summary, 'observedTransitionEvents'), false)
  assert.equal(result.summary.historicalAssayStateBaseline.scoredRows, 0)
  assert.equal(result.retrospectiveEpisodeTransitions.includedInWalkForwardRows, false)
  const route = result.byVenueGroup.find((group) => group.routeKey === study.routeKey)
  assert.deepEqual(route.retrospectiveEpisodeEvidence, {
    status: 'current_saved_evidence_only',
    episodes: 2,
    transitionEvents: 2,
    transitions: { lost_exitability: 1, recovered_exitability: 1 },
    developmentTransitionEvents: 2,
    reservedHoldoutTransitionEvents: 0,
    includedInWalkForwardRows: false,
    forecastValidated: false,
  })
  assert.equal(result.retrospectiveEpisodeTransitions.bySplit.development.transitionEvents, 2)
  assert.equal(result.retrospectiveEpisodeTransitions.bySplit.reservedHoldout.transitionEvents, 0)
  assert.deepEqual(
    result.retrospectiveEpisodeTransitions.durationIntervals.timeToImpairment.map(
      (event) => event.intervalNotation,
    ),
    ['(24,48]'],
  )
  assert.deepEqual(
    result.retrospectiveEpisodeTransitions.durationIntervals.timeToRecovery.map(
      (event) => event.intervalNotation,
    ),
    ['(48,168]'],
  )
  assert.equal(result.retrospectiveEpisodeTransitions.calibratedDuration, false)
  assert.equal(result.forecastValidated, false)

  const historicalAsOf = buildHolderExitHistoricalBacktest({
    panel: panel(new Map(), [study]),
    asOfUtc: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(Object.hasOwn(historicalAsOf.summary, 'observedTransitionEvents'), false)
  assert.equal(historicalAsOf.summary.retrospectiveEpisodeTransitionEvents, null)
  assert.equal(historicalAsOf.summary.retrospectiveEpisodeTransitionEventsEligibleAtAsOf, null)
  assert.deepEqual(historicalAsOf.retrospectiveEpisodeTransitions, {
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
  })
  const historicalRoute = historicalAsOf.byVenueGroup.find(
    (group) => group.routeKey === study.routeKey,
  )
  assert.deepEqual(historicalRoute.retrospectiveEpisodeEvidence, {
    status: 'redacted_at_historical_as_of_without_independent_label_clock',
    includedInWalkForwardRows: false,
    forecastValidated: false,
  })
  for (const key of ['events', 'durationIntervals', 'bySplit', 'episodes', 'transitionEvents'])
    assert.equal(Object.hasOwn(historicalAsOf.retrospectiveEpisodeTransitions, key), false)
  for (const group of historicalAsOf.byVenueGroup)
    for (const key of [
      'episodes',
      'transitionEvents',
      'transitions',
      'developmentTransitionEvents',
      'reservedHoldoutTransitionEvents',
    ])
      assert.equal(Object.hasOwn(group.retrospectiveEpisodeEvidence, key), false)
  const historicalJson = JSON.stringify(historicalAsOf)
  assert.equal(historicalJson.includes(study.episodes[0].cellSha256), false)
  assert.equal(historicalJson.includes(study.episodes[0].holderCommitment), false)
  assert.equal(historicalJson.includes('(24,48]'), false)
})

test('retrospective sidecars cannot duplicate a common panel cell', () => {
  const seedSubject = subjects()[0]
  const common = episode(seedSubject, 'retrospective-collision', {
    stageScope: 'direct_morpho_vaultv2_withdraw_eth_call',
  })
  const study = retrospectiveStudy()
  const duplicated = structuredClone(study)
  duplicated.episodes[0].cellSha256 = common.issueClusterSha256
  for (const event of duplicated.episodes[0].transitionEvents)
    event.cellSha256 = common.issueClusterSha256
  assert.throws(
    () =>
      buildHolderExitHistoricalBacktest({
        panel: panel(new Map([[0, [common]]]), [duplicated]),
      }),
    /holder_exit_backtest_retrospective_episode_invalid/,
  )
})

test('retrospective sidecars enforce exact Q, holder derivation, and logical uniqueness', () => {
  const wrongQ = retrospectiveStudy()
  wrongQ.qRaw = '9999999999'
  for (const episode of wrongQ.episodes) episode.qRaw = wrongQ.qRaw
  assert.throws(
    () => buildHolderExitHistoricalBacktest({ panel: panel(new Map(), [wrongQ]) }),
    /holder_exit_backtest_retrospective_study_invalid/,
  )

  const wrongHolderBinding = retrospectiveStudy()
  const forgedCommitment = sha('forged-holder-vault-binding')
  wrongHolderBinding.episodes[0].holderCommitment = forgedCommitment
  wrongHolderBinding.episodes[0].holderVaultCorrelationSha256 = forgedCommitment
  for (const event of wrongHolderBinding.episodes[0].transitionEvents)
    event.holderVaultCorrelationSha256 = forgedCommitment
  assert.throws(
    () => buildHolderExitHistoricalBacktest({ panel: panel(new Map(), [wrongHolderBinding]) }),
    /holder_exit_backtest_retrospective_episode_invalid/,
  )

  const duplicated = retrospectiveStudy()
  const duplicateEpisode = structuredClone(duplicated.episodes[0])
  duplicateEpisode.cellSha256 = sha('fresh-cell-sha-same-logical-backtest-episode')
  for (const event of duplicateEpisode.transitionEvents)
    event.cellSha256 = duplicateEpisode.cellSha256
  duplicated.episodes.push(duplicateEpisode)
  assert.throws(
    () => buildHolderExitHistoricalBacktest({ panel: panel(new Map(), [duplicated]) }),
    /holder_exit_backtest_retrospective_episode_duplicate/,
  )

  const forgedHolder = retrospectiveStudy()
  const forgedEpisode = structuredClone(forgedHolder.episodes[0])
  forgedEpisode.holder = address(999)
  forgedEpisode.holderCommitment = sha(`${forgedEpisode.destination}:${forgedEpisode.holder}`)
  forgedEpisode.holderVaultCorrelationSha256 = forgedEpisode.holderCommitment
  forgedEpisode.cellSha256 = sha('fresh-cell-sha-forged-holder-same-plan-cell')
  for (const event of forgedEpisode.transitionEvents) {
    event.cellSha256 = forgedEpisode.cellSha256
    event.holderVaultCorrelationSha256 = forgedEpisode.holderCommitment
  }
  forgedHolder.episodes.push(forgedEpisode)
  assert.throws(
    () => buildHolderExitHistoricalBacktest({ panel: panel(new Map(), [forgedHolder]) }),
    /holder_exit_backtest_retrospective_episode_duplicate/,
  )
})

test('retrospective sidecars independently verify the first loss and recovery on repeated-loss paths', () => {
  const repeatedLoss = retrospectiveStudy()
  repeatedLoss.episodes[0].horizonStates = [
    {
      horizonHours: 1,
      rawOutcome: 'success',
      outcome: { status: 'simulated_callable', reason: null },
    },
    {
      horizonHours: 4,
      rawOutcome: 'evm_revert',
      outcome: { status: 'simulated_impaired', reason: null },
    },
    {
      horizonHours: 24,
      rawOutcome: 'evm_revert',
      outcome: { status: 'simulated_impaired', reason: null },
    },
    {
      horizonHours: 48,
      rawOutcome: 'success',
      outcome: { status: 'simulated_callable', reason: null },
    },
    {
      horizonHours: 168,
      rawOutcome: 'success',
      outcome: { status: 'simulated_callable', reason: null },
    },
  ]
  repeatedLoss.episodes[0].transitionEvents[0] = {
    ...repeatedLoss.episodes[0].transitionEvents[0],
    afterHours: 1,
    throughHours: 4,
    intervalNotation: '(1,4]',
  }
  repeatedLoss.episodes[0].transitionEvents[1] = {
    ...repeatedLoss.episodes[0].transitionEvents[1],
    afterHours: 24,
    throughHours: 48,
    intervalNotation: '(24,48]',
  }
  const accepted = buildHolderExitHistoricalBacktest({
    panel: panel(new Map(), [repeatedLoss]),
  })
  assert.equal(accepted.summary.retrospectiveEpisodeTransitionEvents, 2)

  const wrongRecovery = structuredClone(repeatedLoss)
  wrongRecovery.episodes[0].transitionEvents[1] = {
    ...wrongRecovery.episodes[0].transitionEvents[1],
    afterHours: 4,
    intervalNotation: '(4,48]',
  }
  assert.throws(
    () => buildHolderExitHistoricalBacktest({ panel: panel(new Map(), [wrongRecovery]) }),
    /holder_exit_backtest_retrospective_first_transition_invalid/,
  )

  const claimedLaterCycle = retrospectiveStudy()
  claimedLaterCycle.episodes[0].horizonStates = [
    {
      horizonHours: 1,
      rawOutcome: 'success',
      outcome: { status: 'simulated_callable', reason: null },
    },
    {
      horizonHours: 4,
      rawOutcome: 'evm_revert',
      outcome: { status: 'simulated_impaired', reason: null },
    },
    {
      horizonHours: 24,
      rawOutcome: 'success',
      outcome: { status: 'simulated_callable', reason: null },
    },
    {
      horizonHours: 48,
      rawOutcome: 'evm_revert',
      outcome: { status: 'simulated_impaired', reason: null },
    },
    {
      horizonHours: 168,
      rawOutcome: 'success',
      outcome: { status: 'simulated_callable', reason: null },
    },
  ]
  assert.throws(
    () => buildHolderExitHistoricalBacktest({ panel: panel(new Map(), [claimedLaterCycle]) }),
    /holder_exit_backtest_retrospective_first_transition_invalid/,
  )
})

test('walk-forward training cannot see a target observed before origin when its saved score appears after origin', () => {
  const seedSubjects = subjects()
  const first = episode(seedSubjects[0], 'first', {
    deadlineAtUtc: '2026-01-01T06:00:00.000Z',
  })
  const second = episode(seedSubjects[0], 'second', {
    issueAtUtc: '2026-01-01T03:00:00.000Z',
    targetAtUtc: '2026-01-01T04:00:00.000Z',
    deadlineAtUtc: '2026-01-01T05:00:00.000Z',
    observedAtUtc: '2026-01-01T04:00:00.000Z',
    outcome: { status: 'simulated_impaired', reason: null },
  })
  const visible = buildHolderExitHistoricalBacktest({
    panel: panel(new Map([[0, [first, second]]])),
    support: supportOne,
  })
  assert.equal(visible.summary.historicalAssayStateBaseline.scoredRows, 1)
  assert.deepEqual(visible.summary.historicalAssayStateBaseline.trainingTiers, {
    venue_horizon_baseline: 1,
  })
  assert.equal(
    visible.summary.historicalAssayStateBaseline.pairedAssayStatePersistence.scoredRows,
    1,
  )
  assert.equal(visible.summary.historicalAssayStateBaseline.abstainedRows, 1)
  assert.ok(
    Math.abs(
      visible.summary.historicalAssayStateBaseline.pairedDeltasVersusPersistence.brierScore + 5 / 9,
    ) < 1e-12,
  )

  const late = buildHolderExitHistoricalBacktest({
    panel: panel(
      new Map([
        [
          0,
          [
            {
              ...first,
              observedAtUtc: '2026-01-01T01:00:00.000Z',
              labelAvailableAtUtc: '2026-01-01T05:00:00.000Z',
            },
            second,
          ],
        ],
      ]),
    ),
    support: supportOne,
  })
  assert.equal(late.summary.historicalAssayStateBaseline.scoredRows, 0)
  assert.equal(late.summary.historicalAssayStateBaseline.abstainedRows, 2)
})

test('same-cluster outcomes never train another row from that cluster', () => {
  const candidate = {
    routeKey: 'route',
    issueClusterSha256: sha('same'),
    qRaw: '1',
    horizonHours: 1,
    issueMs: 2,
    targetMs: 3,
    observedMs: 3,
    labelAvailableMs: 3,
    stageScope: 'same-stage',
    baseline: 'simulated_callable',
    outcome: 'simulated_callable',
    outcomeReason: null,
  }
  const priorSameCluster = {
    ...candidate,
    qRaw: '2',
    issueMs: 0,
    targetMs: 1,
    observedMs: 1,
    labelAvailableMs: 1,
  }
  const replay = replayWalkForward([priorSameCluster, candidate], supportOne)
  assert.equal(replay[1].historicalAssayStateProbabilityCallable, null)
  assert.equal(replay[1].trainingClusters, 0)
})

test('historical assay-state baselines never transfer across incompatible stage scopes', () => {
  const seedSubjects = subjects()
  const source = episode(seedSubjects[0], 'source')
  const candidate = episode(seedSubjects[1], 'candidate', {
    issueAtUtc: '2026-01-01T03:00:00.000Z',
    targetAtUtc: '2026-01-01T04:00:00.000Z',
    deadlineAtUtc: '2026-01-01T05:00:00.000Z',
  })
  const result = buildHolderExitHistoricalBacktest({
    panel: panel(
      new Map([
        [0, [source]],
        [1, [candidate]],
      ]),
    ),
    support: supportOne,
  })
  assert.equal(result.summary.historicalAssayStateBaseline.scoredRows, 0)
})

test('measured outcomes without a saved label availability clock abstain', () => {
  const seedSubjects = subjects()
  const row = episode(seedSubjects[0], 'missing-label-clock')
  delete row.labelAvailableAtUtc
  const result = buildHolderExitHistoricalBacktest({ panel: panel(new Map([[0, [row]]])) })
  assert.equal(result.summary.scorableRows, 0)
  assert.deepEqual(result.summary.abstentions, { label_availability_clock_missing: 1 })
})

test('late issue-time features abstain instead of leaking into either benchmark', () => {
  const seedSubjects = subjects()
  const row = episode(seedSubjects[0], 'late-feature', {
    featureRefs: [
      {
        kind: 'aggregate_cash',
        receiptSha256: sha('feature'),
        sourceAt: '2025-12-31T23:59:00.000Z',
        firstLocalReceiptAt: '2026-01-01T00:01:00.000Z',
        completedAtUtc: '2026-01-01T00:01:00.000Z',
      },
    ],
  })
  const result = buildHolderExitHistoricalBacktest({
    panel: panel(new Map([[0, [row]]])),
  })
  assert.equal(result.summary.scorableRows, 0)
  assert.deepEqual(result.summary.abstentions, { feature_available_after_origin: 1 })
})

test('report retains all 25 groups and 67 subjects with explicit empty coverage', () => {
  const result = buildHolderExitHistoricalBacktest({ panel: panel() })
  assert.equal(result.summary.routeGroups, 25)
  assert.equal(result.summary.exactSubjects, 67)
  assert.equal(result.byVenueGroup.length, 25)
  assert.ok(result.byVenueGroup.every((group) => group.availability === 'no_episode_rows'))
  assert.equal(result.forecastValidated, false)
  assert.equal(result.prospectiveValidation, false)
  assert.equal(result.statisticalIndependenceValidated, false)
  assert.equal(result.labelAvailabilityClockIndependentlyWitnessed, false)
  assert.equal(result.summary.rowsAreIndependentSamples, false)
  assert.equal(result.summary.independentSampleCount, null)
})

test('assay-state persistence is scored only on the paired historical-baseline subset', () => {
  const seedSubjects = subjects()
  const callable = episode(seedSubjects[0], 'callable')
  const loss = episode(seedSubjects[0], 'loss', {
    issueAtUtc: '2026-01-02T00:00:00.000Z',
    targetAtUtc: '2026-01-02T01:00:00.000Z',
    deadlineAtUtc: '2026-01-02T02:00:00.000Z',
    observedAtUtc: '2026-01-02T01:00:00.000Z',
    outcome: { status: 'simulated_impaired', reason: null },
  })
  const result = buildHolderExitHistoricalBacktest({
    panel: panel(new Map([[0, [callable, loss]]])),
    support: supportOne,
  })
  assert.equal(result.summary.transitions.remained_callable, 1)
  assert.equal(result.summary.transitions.lost_exitability, 1)
  assert.equal(
    result.summary.historicalAssayStateBaseline.pairedAssayStatePersistence.scoredRows,
    1,
  )
  assert.equal(result.summary.historicalAssayStateBaseline.pairedAssayStatePersistence.accuracy, 0)
  assert.equal(
    result.summary.historicalAssayStateBaseline.pairedAssayStatePersistence.brierScore,
    1,
  )
  assert.equal(result.summary.walkForwardObservedTransitionEvents, 1)
  assert.equal(Object.hasOwn(result.summary, 'observedTransitionEvents'), false)
})

test('max assayed exit scores only complete multi-size cohorts', () => {
  const seedSubjects = subjects()
  const small = episode(seedSubjects[0], 'max', { qRaw: '100' })
  const large = episode(seedSubjects[0], 'max', {
    qRaw: '200',
    outcome: { status: 'simulated_impaired', reason: null },
  })
  const result = buildHolderExitHistoricalBacktest({
    panel: panel(new Map([[0, [small, large]]])),
  })
  assert.equal(result.maxAssayedExit.completeCohorts, 1)
  assert.equal(result.maxAssayedExit.shrankCohorts, 1)
  assert.equal(result.maxAssayedExit.meanNormalizedAbsoluteError, 0.5)
})

test('duration output bounds changes between measured horizons instead of assigning exact event times', () => {
  const seedSubjects = subjects()
  const oneHour = episode(seedSubjects[0], 'duration', { plannedHorizonHours: 1 })
  const day = episode(seedSubjects[0], 'duration', {
    plannedHorizonHours: 24,
    targetAtUtc: '2026-01-02T00:00:00.000Z',
    deadlineAtUtc: '2026-01-02T01:00:00.000Z',
    observedAtUtc: '2026-01-02T00:00:00.000Z',
    outcome: { status: 'simulated_impaired', reason: null },
  })
  const impaired = episode(seedSubjects[1], 'impaired', {
    plannedHorizonHours: 24,
    targetAtUtc: '2026-01-02T00:00:00.000Z',
    deadlineAtUtc: '2026-01-02T01:00:00.000Z',
    observedAtUtc: '2026-01-02T00:00:00.000Z',
    baseline: 'simulated_impaired',
    outcome: { status: 'simulated_impaired', reason: null },
  })
  const result = buildHolderExitHistoricalBacktest({
    panel: panel(
      new Map([
        [0, [oneHour, day]],
        [1, [impaired]],
      ]),
    ),
  })
  assert.equal(result.durationProxy.timeToImpairment.intervalCensoredChanges, 1)
  assert.deepEqual(result.durationProxy.timeToImpairment.changeIntervals, [
    {
      routeKey: seedSubjects[0].routeKey,
      lastKnownUnchangedHorizonHours: 1,
      firstChangedHorizonHours: 24,
      intervalNotation: '(1,24]',
    },
  ])
  assert.equal(result.durationProxy.timeToRecovery.rightCensored, 1)
  assert.equal(result.durationProxy.timeToRecovery.medianDurationHours, null)
  assert.equal(Object.hasOwn(result.durationProxy.timeToImpairment, 'kaplanMeier'), false)
})

test('as-of boundary censors future outcomes and malformed clocks fail closed', () => {
  const seedSubjects = subjects()
  const row = episode(seedSubjects[0], 'as-of')
  const result = buildHolderExitHistoricalBacktest({
    panel: panel(new Map([[0, [row]]])),
    asOfUtc: '2026-01-01T00:30:00.000Z',
  })
  assert.equal(result.summary.scorableRows, 0)
  assert.deepEqual(result.summary.abstentions, { outcome_unavailable_as_of: 1 })
  assert.throws(
    () =>
      buildHolderExitHistoricalBacktest({
        panel: panel(new Map([[0, [{ ...row, observedAtUtc: '2026-01-01T00:30:00.000Z' }]]])),
      }),
    /outcome_before_target/,
  )
})
