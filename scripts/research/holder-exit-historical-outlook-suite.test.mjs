import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AAVE_USDC_ROUTE,
  AAVE_USDE_ASSET,
  AAVE_USDE_DESTINATION,
  AAVE_USDE_ROUTE,
  APYUSD_ROUTE,
  EXACT_DIRECT_WITHDRAW_ROUTES,
  HOLDER_ASSAY_ROUTE_SPECS,
  MORPHO_USDC_ROUTE,
  SATURN_ROUTE,
  SUSDE_DESTINATION,
  SUSDE_ROUTE,
  UMBRELLA_GHO_ROUTE,
  FLUID_BRIDGE_USDC_ROUTE,
  buildHistoricalOutlookSuite,
  readAaveFlowSummaryWithFallback,
  readOfflineHistoricalOutlook,
  readSavedAaveFlowSummary,
} from './holder-exit-historical-outlook-suite.mjs'

function matrixFixture() {
  const names = Object.keys(HOLDER_ASSAY_ROUTE_SPECS)
  const subjects = []
  names.forEach((routeKey, routeIndex) => {
    const mechanism = HOLDER_ASSAY_ROUTE_SPECS[routeKey].mechanism
    const count =
      routeKey === SUSDE_ROUTE ||
      routeKey === UMBRELLA_GHO_ROUTE ||
      routeKey === FLUID_BRIDGE_USDC_ROUTE
        ? 1
        : routeKey === MORPHO_USDC_ROUTE
          ? 5
          : routeKey === SATURN_ROUTE
            ? 3
            : mechanism === 'atomic'
              ? 3
              : 2
    for (let subjectIndex = 0; subjectIndex < count; subjectIndex++) {
      const atomic = mechanism === 'atomic'
      subjects.push({
        routeKey,
        destination:
          routeKey === SUSDE_ROUTE
            ? SUSDE_DESTINATION
            : `0x${String(routeIndex * 3 + subjectIndex + 1).padStart(40, '0')}`,
        originalAsset:
          routeKey === SUSDE_ROUTE
            ? AAVE_USDE_ASSET
            : `0x${String(routeIndex + 100).padStart(40, '0')}`,
        mechanism,
        directIssueCellObservations: atomic ? 2 : 0,
        measuredDirectBaselineCellObservations: atomic ? 2 : 0,
        directExactCells: atomic ? 2 : 0,
        historicalDirectFinalAssetPayoutTransactions: atomic ? 1 : 0,
        historicalSupplierPayoutEvidence: null,
        historicalStableSimulatedReverts: [],
        correlatedEntitlementGapCellObservations: 0,
        correlatedLossCellObservations: 0,
        correlatedRecoveryCellObservations: 0,
        sampledConditionObservations: 0,
        sampledZeroAssetsPositiveShares: false,
        stageIssueObservations: atomic ? 0 : 1,
        minedDeliveryAttestations: 0,
        terminalSameEpisodeFinalAssetPaidProofs: 0,
        stageNames: atomic ? [] : ['request'],
        historicalReceiptCohort: null,
        historicalPublicConversionQuote: null,
      })
    }
  })
  assert.equal(subjects.length, 67)
  return {
    scope: 'offline_frozen_holder_exit_forceability_gate',
    manifestSha256: 'a'.repeat(64),
    mechanismVersion: 'fixture-v1',
    summary: { routeGroups: 25, exactSubjects: 67 },
    subjects,
    supplemental: [
      {
        routeKey: AAVE_USDE_ROUTE,
        destination: AAVE_USDE_DESTINATION,
        originalAsset: AAVE_USDE_ASSET,
        scope: 'outside_frozen_25_67',
        mechanism: 'unassessed',
        holderExecutableExit: false,
        forecastValidated: false,
        historicalSupplierPayoutEvidence: {
          status: 'observed',
          evidenceClass: 'historical_other_holder_mined_payout',
          coverage: {
            fromBlock: 26_088_307,
            throughBlock: 26_105_755,
            startMs: 1_790_747_339_000,
            endMs: 1_790_957_579_000,
            durationMs: 210_240_000,
            scope: 'selected_bounded_contiguous_suffix',
            segmentCount: 2,
            segmentSha256: ['b'.repeat(64), 'c'.repeat(64)],
          },
          classifiedReceiptPayoutCount: 41,
          sameHolderPayoutCount: 23,
          sameHolderPayoutRaw: '31815575693206302906375414',
          otherReceiverPayoutCount: 18,
          unclassifiedWithdrawalCount: 0,
          historicalMax24hGrossWithdrawal: {
            status: 'observed',
            amountRaw: '33574846973619185861706954',
            startMs: 1_790_776_091_000,
            endMs: 1_790_862_491_000,
            payoutCount: 26,
          },
          sameEpisodeProspective: false,
          calibratedDuration: false,
          holderExecutableExit: false,
          forecastValidated: false,
        },
      },
    ],
  }
}

function stageEndpointPanelFixture(matrix) {
  const subjects = matrix.subjects.map((subject) => ({
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.originalAsset,
    stageScope: HOLDER_ASSAY_ROUTE_SPECS[subject.routeKey].stageScopes[0],
    issueClusters: 0,
    episodes: [],
  }))
  const umbrella = subjects.find((subject) => subject.routeKey === UMBRELLA_GHO_ROUTE)
  const fluid = subjects.find((subject) => subject.routeKey === FLUID_BRIDGE_USDC_ROUTE)
  umbrella.issueClusters = 3
  for (const [index, gate] of ['waiting', 'cooldown_not_started', 'window_expired'].entries()) {
    const horizons = index === 0 ? [1, 24, 48, 168] : [1, 24, 48, 168, 348, 360, 384, 432]
    for (const horizon of horizons) {
      const measured = horizon === 1 || (index < 2 && horizon === 24)
      const issueAt = Date.parse(`2026-10-0${index + 1}T04:00:00.000Z`)
      const targetAt = issueAt + horizon * 3_600_000
      umbrella.episodes.push({
        subject: `${UMBRELLA_GHO_ROUTE}\0${umbrella.destination}\0${umbrella.asset}`,
        stageScope: umbrella.stageScope,
        lane: 'umbrella_stkgho',
        issueSha256: String(index + 1).repeat(64),
        issueClusterSha256: String(index + 1).repeat(64),
        holderCommitment: createHash('sha256').update(`umbrella-holder:${index}`).digest('hex'),
        analysisPrimaryForCell: true,
        qRaw: '1000000000000000000',
        qUnit: 'stkGHO_shares',
        plannedHorizonHours: horizon,
        issueAtUtc: new Date(issueAt).toISOString(),
        targetAtUtc: new Date(targetAt).toISOString(),
        deadlineAtUtc: new Date(targetAt + 2 * 3_600_000).toISOString(),
        observedAtUtc: measured ? new Date(targetAt).toISOString() : null,
        labelAvailableAtUtc: measured ? new Date(targetAt + 20 * 60_000).toISOString() : null,
        baseline: 'inconclusive',
        rawBaselineStatus: 'evm_revert',
        rawBaselineGate: gate,
        outcome: { status: 'not_at_risk', reason: 'baseline_revert_cause_unknown' },
        rawScoreStatus: measured ? 'measured' : null,
        scoreSha256: measured
          ? createHash('sha256').update(`umbrella:${index}:${horizon}`).digest('hex')
          : null,
        rawScoreOutcome: measured ? 'evm_revert' : null,
        rawScoreGate: measured ? gate : null,
        rawTransition: measured ? 'still_reverting' : null,
      })
    }
  }
  fluid.issueClusters = 1
  for (const [qIndex, qRaw] of ['100', '200', '300', '400', '500'].entries()) {
    for (const horizon of [1, 4, 24, 48, 168]) {
      const missed = horizon === 1 || horizon === 4
      const issueAt = Date.parse('2026-10-01T17:00:00.000Z')
      const targetAt = issueAt + horizon * 3_600_000
      fluid.episodes.push({
        subject: `${FLUID_BRIDGE_USDC_ROUTE}\0${fluid.destination}\0${fluid.asset}`,
        stageScope: fluid.stageScope,
        lane: 'fluid_bridge_usdc',
        issueSha256: 'f'.repeat(64),
        issueClusterSha256: 'f'.repeat(64),
        holderCommitment: createHash('sha256').update('fluid-holder').digest('hex'),
        analysisPrimaryForCell: true,
        qRaw,
        qUnit: 'USDC_first_leg_assets',
        qCaseLabel: `q${qIndex + 1}`,
        plannedHorizonHours: horizon,
        issueAtUtc: new Date(issueAt).toISOString(),
        targetAtUtc: new Date(targetAt).toISOString(),
        deadlineAtUtc: new Date(targetAt + 2 * 3_600_000).toISOString(),
        observedAtUtc: null,
        labelAvailableAtUtc: missed ? '2026-10-02T04:00:00.000Z' : null,
        originalAsset: fluid.asset,
        firstLegAsset: fluid.asset,
        firstLegOnly: true,
        baseline: 'simulated_callable',
        rawBaselineStatus: 'success',
        outcome: {
          status: missed ? 'censored' : horizon === 168 ? 'pending' : 'missing',
          reason: missed ? 'capture_window_missed' : null,
        },
        rawScoreStatus: missed ? 'missed_window' : null,
        scoreSha256: missed ? createHash('sha256').update(`fluid:${horizon}`).digest('hex') : null,
        rawScoreOutcome: null,
        rawScoreSimulationStatus: null,
      })
    }
  }
  return {
    scope: 'offline_frozen_25_67_holder_episode_panel',
    sourceVerification: 'offline_sealed_replay',
    manifestSha256: matrix.manifestSha256,
    forecastValidated: false,
    holderExecutableExit: false,
    summary: { routeGroups: 25, exactSubjects: 67 },
    subjects,
  }
}

function exactDirectPanelFixture(matrix) {
  const panel = stageEndpointPanelFixture(matrix)
  for (const [index, [routeKey, lane]] of Object.entries(EXACT_DIRECT_WITHDRAW_ROUTES).entries()) {
    const subject = panel.subjects.find((row) => row.routeKey === routeKey)
    const issue = String(index + 1).repeat(64)
    subject.issueClusters = 1
    subject.episodes = [
      {
        subject: `${routeKey}\0${subject.destination.toLowerCase()}\0${subject.asset.toLowerCase()}`,
        stageScope: subject.stageScope,
        lane,
        fullRoutePaidProofSha256: null,
        issueClusterSha256: issue,
        issueSha256: issue,
        scoreSha256: String(index + 5).repeat(64),
        holderCommitment: 'abcd'[index].repeat(64),
        qRaw: '1000000',
        qUnit: 'asset_raw',
        plannedHorizonHours: 1,
        issueAtUtc: '2026-10-01T01:00:00.000Z',
        issueClock: 'local_operator_clock_unwitnessed',
        scoreClock: 'local_operator_clock_unwitnessed',
        baselineBlock: '26095097',
        baselineBlockHash: `0x${'a'.repeat(64)}`,
        baselineAtUtc: '2026-10-01T00:45:00.000Z',
        targetAtUtc: '2026-10-01T02:00:00.000Z',
        deadlineAtUtc: '2026-10-01T04:00:00.000Z',
        observedAtUtc: '2026-10-01T02:00:04.000Z',
        labelAvailableAtUtc: '2026-10-01T02:20:00.000Z',
        baseline: 'simulated_callable',
        rawBaselineStatus: 'success',
        rawScoreStatus: 'measured',
        rawScoreOutcome: 'simulated_withdraw_success',
        outcome: { status: 'simulated_callable', reason: null },
        analysisPrimaryForCell: true,
        forecastEligible: false,
      },
    ]
  }
  return panel
}

function exactDirectMatrixFixture() {
  const matrix = matrixFixture()
  const removed = []
  for (const routeKey of Object.keys(EXACT_DIRECT_WITHDRAW_ROUTES)) {
    const subjects = matrix.subjects.filter((row) => row.routeKey === routeKey)
    removed.push(...subjects.slice(1))
  }
  matrix.subjects = matrix.subjects.filter((row) => !removed.includes(row))
  const morpho = matrix.subjects.find((row) => row.routeKey === MORPHO_USDC_ROUTE)
  for (const [index] of removed.entries()) {
    matrix.subjects.push({
      ...structuredClone(morpho),
      destination: `0x${String(900 + index).padStart(40, '0')}`,
    })
  }
  assert.equal(matrix.subjects.length, 67)
  return matrix
}

function historicalCoveragePartition(routes) {
  return routes.reduce(
    (counts, route) => {
      if (route.promotion.historicalOutlook === 'eligible_exact_endpoint_history')
        counts.exactEndpointHistoryRouteGroups += 1
      else if (route.promotion.historicalOutlook === 'eligible_proxy_history')
        counts.proxyOnlyHistoryRouteGroups += 1
      else if (route.promotion.historicalOutlook === 'abstain') counts.abstainingRouteGroups += 1
      else throw Error('test_historical_outlook_class_invalid')
      return counts
    },
    {
      exactEndpointHistoryRouteGroups: 0,
      proxyOnlyHistoryRouteGroups: 0,
      abstainingRouteGroups: 0,
    },
  )
}

const flowFixture = {
  study: 'aave-usdc-historical-flow-summary-v1',
  source: { fromBlock: 100, toBlock: 500 },
  horizonBlocks: 256,
  exactHorizonWindows: 12,
  nonoverlappingWindowCount: 4,
  nonoverlappingDistributions: { grossReserveInRaw: { median: '12' } },
  exactWindowExtrema: { maxGrossReserveOutRaw: '30' },
  flowMeasure: 'gross_reserve_in_and_out_including_supplier_and_other_flows',
}

const morphoFixture = {
  study: 'morpho-v2-usdc-10k-holder-risk-ledger-v1',
  qAssetsRaw: '10000000000',
  reservedHoldoutAnchor: 400,
  cells: [
    {
      anchorBlock: 100,
      vault: `0x${'1'.repeat(40)}`,
      split: 'development',
      cellSha256: 'a'.repeat(64),
    },
    {
      anchorBlock: 400,
      vault: `0x${'1'.repeat(40)}`,
      split: 'reservedHoldout',
      cellSha256: 'b'.repeat(64),
    },
  ],
  episodes: [
    {
      vault: `0x${'1'.repeat(40)}`,
      split: 'development',
      holderVaultCluster: 'dev',
      firstObservedLossIntervalHours: { after: 24, through: 48 },
      observedRecoveryIntervalHours: null,
      firstLossRightCensoredAtHours: null,
    },
    {
      vault: `0x${'1'.repeat(40)}`,
      split: 'reservedHoldout',
      holderVaultCluster: 'holdout',
      firstObservedLossIntervalHours: null,
      observedRecoveryIntervalHours: null,
      firstLossRightCensoredAtHours: 168,
    },
  ],
  counts: {
    development: { plannedCells: 1, completedCells: 1 },
    reservedHoldout: { plannedCells: 1, completedCells: 1 },
    all: {
      plannedCells: 2,
      completedCells: 2,
      baselineSuccessEpisodes: 2,
      holderVaultClusters: 2,
      sharedHolderVaultClustersAcrossSplits: 0,
      observedFirstLossEpisodes: 1,
      observedRecoveryEpisodes: 0,
      firstLossRightCensoredEpisodes: 1,
      holderAttritionCensoredEpisodes: 0,
      episodesWithMissingHorizonSamples: 0,
    },
  },
}

const saturnFixture = {
  study: 'saturn_queue_processing_chronological_diagnostic_v1',
  horizonSeconds: 86_400,
  split: {
    method: 'retrospective_median_request_timestamp',
    atUtc: '2026-01-02T00:00:00.000Z',
    finalCutoffAtUtc: '2026-01-03T00:00:00.000Z',
  },
  train: { requested: 4, evaluable: 3, processedWithinHorizon: 2, censored: 1 },
  later: { requested: 4, evaluable: 4, processedWithinHorizon: 1, censored: 0 },
  comparison: { absoluteRateError: 0.4 },
}

const saturnFinalPaymentFixture = {
  study: 'saturn_final_holder_payment_duration_backtest_v1',
  scope: { paymentAsset: 'USDat', routeFinalAusdPaymentAssessed: false },
  cohort: {
    requests: 146,
    holders: 131,
    verifiedFinalHolderPayments: 77,
    finalPaymentTransactions: 76,
    exactHolderMatches: 77,
  },
  fullCohortAtCutoff: {
    asOf: { atUtc: '2026-10-02T21:23:35.000Z' },
    requestToFinalHolderPayment: {
      intervalDurationSeconds: {
        intervalBasis: 'exact payment block bounded by sealed historical block-header timestamps',
        median: { lowerSeconds: 126_768, upperSeconds: 209_100 },
      },
      horizons: [24, 72, 168, 336, 672].map((horizonHours) => ({
        horizonHours,
        subjects: 146,
        historicalPaymentFractionBounds: { lower: 0.3, upper: 0.5 },
      })),
    },
  },
  chronologicalSplit: {
    method: 'first_half_requests_development_second_half_requests_holdout',
    splitAtUtc: '2026-09-23T07:25:23.000Z',
    development: { subjects: 73 },
    holdout: { subjects: 73 },
  },
  validation: { status: 'not_validated', forecastValidated: false },
}

const apyFixture = {
  scope: 'retrospective_request_to_holder_payment_as_of_split',
  cohort: 96,
  splitAtUtc: '2026-01-02T00:00:00.000Z',
  trainingAsOfUtc: '2026-01-01T23:59:59.000Z',
  observedThroughUtc: '2026-02-01T00:00:00.000Z',
  train: { requests: 48, holders: 20, knownPayoutsAtSplit: 3, horizons: [] },
  holdout: {
    requests: 48,
    holders: 22,
    holdersAlsoInTrain: 2,
    horizons: [{ days: 7, paid: 9, notPaid: 39, censored: 0, evaluable: 48 }],
  },
}

const cashFixture = {
  study: 'frozen25-aggregate-cash-q-ratio-h24-historical-holdout-v1',
  routeGroupCount: 25,
  subjectCount: 67,
  asOfBlockAt: '2026-02-01T00:00:00.000Z',
  currentBlock: 500,
  byFraction: [
    {
      percentOfCurrentCash: 90,
      qualifiedSubjects: [
        {
          routeKey: AAVE_USDC_ROUTE,
          destination: '0x0000000000000000000000000000000000000001',
          requestedFraction: { numeratorRaw: '9', denominatorRaw: '10' },
          fitBreaches: { numerator: 5, denominator: 20 },
          calibrationBreaches: { numerator: 9, denominator: 20 },
          holdoutBreaches: { numerator: 9, denominator: 20 },
          holdoutBrier: { numerator: '2300', denominator: 8000 },
          holdoutPersistenceBrier: { numerator: '3600', denominator: 8000 },
        },
      ],
    },
  ],
}

function assayMetricsFixture(scoredRows) {
  return {
    scoredRows,
    uniqueIssueClusters: scoredRows ? 1 : 0,
    rowsAreIndependentSamples: false,
    statisticalIndependenceValidated: false,
    observedCallableRows: scoredRows,
    observedImpairedRows: 0,
    meanAssayStateProbabilityCallable: scoredRows ? 0.9 : null,
    accuracy: scoredRows ? 1 : null,
    brierScore: scoredRows ? 0.01 : null,
    logLoss: scoredRows ? 0.1 : null,
    clusterBalancedAccuracy: scoredRows ? 1 : null,
    clusterBalancedBrierScore: scoredRows ? 0.01 : null,
  }
}

function assayBacktestFixture(matrix) {
  const routeKeys = [...new Set(matrix.subjects.map((subject) => subject.routeKey))].sort()
  return {
    scope: 'holder_exit_historical_walk_forward_backtest_v1',
    studyType: 'retrospective_walk_forward_backtest',
    asOfUtc: null,
    manifestSha256: matrix.manifestSha256,
    forecastValidated: false,
    prospectiveValidation: false,
    statisticalIndependenceValidated: false,
    labelAvailabilityClockIndependentlyWitnessed: false,
    summary: {
      routeGroups: 25,
      exactSubjects: 67,
      rowsAreIndependentSamples: false,
      independentSampleCount: null,
    },
    byVenueGroup: routeKeys.map((routeKey) => {
      const scorableRows = routeKey === 'USDe → Staked USDe [USDe]' ? 0 : 2
      const metrics = assayMetricsFixture(scorableRows ? 1 : 0)
      return {
        routeKey,
        exactSubjects: matrix.subjects.filter((subject) => subject.routeKey === routeKey).length,
        stageScopes: [...HOLDER_ASSAY_ROUTE_SPECS[routeKey].stageScopes],
        rawRows: scorableRows ? 3 : 1,
        primaryRows: scorableRows ? 3 : 1,
        scorableRows,
        subjectsWithScorableRows: scorableRows ? 1 : 0,
        horizonsSeen: [1],
        availability: scorableRows ? 'retrospectively_scorable' : 'no_scorable_outcomes',
        abstentions: scorableRows ? {} : { outcome_pending: 1 },
        rows: scorableRows,
        uniqueIssueClusters: scorableRows ? 1 : 0,
        rowsAreIndependentSamples: false,
        statisticalIndependenceValidated: false,
        transitions: scorableRows ? { remained_callable: scorableRows } : {},
        historicalAssayStateBaseline: {
          abstainedRows: scorableRows ? 1 : 0,
          abstentionReasons: scorableRows ? { insufficient_prior_clusters: 1 } : {},
          trainingTiers: scorableRows ? { venue_horizon_baseline: 1 } : {},
          ...metrics,
          pairedAssayStatePersistence: {
            ...metrics,
            brierScore: scorableRows ? 0 : null,
            logLoss: scorableRows ? 0 : null,
            clusterBalancedBrierScore: scorableRows ? 0 : null,
          },
          pairedDeltasVersusPersistence: scorableRows
            ? { accuracy: 0, brierScore: 0.01, logLoss: 0.1 }
            : null,
        },
      }
    }),
  }
}

function susdePayoutFixture(availableAt = '2026-10-03T02:00:00.000Z') {
  return [
    {
      subject: `${SUSDE_ROUTE}\0${SUSDE_DESTINATION}\0${AAVE_USDE_ASSET}`,
      issueSequence: 3,
      issueSha256: 'b'.repeat(64),
      holderCommitment: 'c'.repeat(64),
      qRaw: '6191258629204940672988555',
      qUnit: 'USDe_pending_whole_queue_assets',
      requestAtUtc: '2026-10-02T00:00:00.000Z',
      payoutAtUtc: '2026-10-03T00:00:36.000Z',
      localEvidenceAvailableAtUtc: availableAt,
      localEvidenceAvailabilityClock: 'unwitnessed_local_wall_clock',
      observedRequestToPayoutSeconds: 86_436,
      sidecarSha256: 'd'.repeat(64),
      payoutTransactionHash: `0x${'e'.repeat(64)}`,
      minedFinalAssetPayoutProven: true,
      forecastEligible: false,
      calibratedRestrictionDuration: false,
    },
  ]
}

test('promotes linked sUSDe payouts only after mined and local evidence clocks', () => {
  const matrix = matrixFixture()
  const payout = susdePayoutFixture()
  const beforePayout = buildHistoricalOutlookSuite({
    matrix,
    susdeRequestToPayout: payout,
    asOfUtc: '2026-10-02T23:00:00.000Z',
  })
  const beforeAvailable = buildHistoricalOutlookSuite({
    matrix,
    susdeRequestToPayout: payout,
    asOfUtc: '2026-10-03T01:00:00.000Z',
  })
  for (const report of [beforePayout, beforeAvailable]) {
    const route = report.routes.find((row) => row.routeKey === SUSDE_ROUTE)
    assert.equal(route.promotion.historicalOutlook, 'abstain')
    assert.equal(route.evidence.length, 0)
  }
  const report = buildHistoricalOutlookSuite({
    matrix,
    susdeRequestToPayout: payout,
    asOfUtc: '2026-10-03T02:00:00.000Z',
  })
  const route = report.routes.find((row) => row.routeKey === SUSDE_ROUTE)
  assert.equal(route.promotion.historicalOutlook, 'eligible_exact_endpoint_history')
  assert.equal(route.promotion.liveForecast, 'abstain')
  assert.equal(route.evidence.length, 1)
  const block = route.evidence[0]
  assert.equal(block.evidenceId, 'susde_exact_request_to_mined_usde_payout_history')
  assert.equal(block.evidenceClass, 'historical_endpoint')
  assert.equal(block.prospectiveValidated, false)
  assert.deepEqual(block.design.elapsedTimeIncludes, ['protocol_cooldown', 'holder_action'])
  assert.equal(block.outcomes.episodes[0].observedRequestToPayoutSeconds, 86_436)
  assert.equal(
    block.outcomes.episodes[0].localEvidenceAvailableAtUtc,
    payout[0].localEvidenceAvailableAtUtc,
  )
  assert.ok(block.limits.includes('not_a_restriction_recovery_duration'))
  assert.equal(report.sources.susdeRequestToPayout.status, 'verified')
})

test('rejects relabeled or predictive sUSDe payout facts', () => {
  const matrix = matrixFixture()
  for (const mutation of [
    (fact) => {
      fact.subject = `${SUSDE_ROUTE}\0${AAVE_USDE_DESTINATION}\0${AAVE_USDE_ASSET}`
    },
    (fact) => {
      fact.forecastEligible = true
    },
    (fact) => {
      fact.calibratedRestrictionDuration = true
    },
    (fact) => {
      fact.observedRequestToPayoutSeconds = 1
    },
  ]) {
    const facts = susdePayoutFixture()
    mutation(facts[0])
    assert.throws(
      () => buildHistoricalOutlookSuite({ matrix, susdeRequestToPayout: facts }),
      /historical_outlook_susde_payout_invalid/,
    )
  }
})

test('preserves the frozen 25/67 cohort and adds the tracked supplemental route', () => {
  const matrix = matrixFixture()
  const report = buildHistoricalOutlookSuite({
    matrix,
    holderAssayBacktest: assayBacktestFixture(matrix),
    aaveUsdcGrossFlow: flowFixture,
    morphoUsdcFixed10k: morphoFixture,
    saturnProcessing: saturnFixture,
    saturnFinalPayment: saturnFinalPaymentFixture,
    apyUsdTiming: apyFixture,
    aggregateCashHoldout: cashFixture,
  })
  assert.equal(report.coverage.routeGroups, 26)
  assert.equal(report.coverage.exactSubjects, 68)
  assert.equal(report.coverage.frozenCohortRouteGroups, 25)
  assert.equal(report.coverage.frozenCohortExactSubjects, 67)
  assert.equal(report.coverage.supplementalRouteGroups, 1)
  assert.equal(report.coverage.supplementalExactSubjects, 1)
  const partition = historicalCoveragePartition(report.routes)
  assert.deepEqual(
    {
      exactEndpointHistoryRouteGroups: report.coverage.exactEndpointHistoryRouteGroups,
      proxyOnlyHistoryRouteGroups: report.coverage.proxyOnlyHistoryRouteGroups,
      abstainingRouteGroups: report.coverage.abstainingRouteGroups,
    },
    partition,
  )
  assert.equal(report.limits.routeLevelProbability, false)
  assert.equal(report.limits.incompatibleEndpointsPooled, false)
  const morpho = report.routes.find((route) => route.routeKey === MORPHO_USDC_ROUTE)
  const destinationSlice = morpho.evidence.find(
    (block) => block.evidenceId === 'morpho_fixed_10k_holder_call_ledger',
  ).samples.destinationSlices[0]
  assert.equal(destinationSlice.destination, `0x${'1'.repeat(40)}`)
  assert.equal(destinationSlice.development.baselineSuccessEpisodes, 1)
  assert.equal(destinationSlice.reservedHoldout.baselineSuccessEpisodes, 1)
  assert.equal(destinationSlice.all.baselineSuccessEpisodes, 2)
  const aave = report.routes.find((route) => route.routeKey === AAVE_USDC_ROUTE)
  assert.deepEqual(
    aave.evidence.map((block) => block.endpoint),
    [
      'mined_final_asset_transfer_to_holder',
      'holder_specific_protocol_stage_assay_state_at_saved_horizon',
      'aggregate_reserve_gross_in_out_and_cash_delta',
      'aggregate_market_cash_below_q_at_24h',
    ],
  )
  assert.equal(
    aave.evidence.find((block) => block.evidenceId === 'aave_usdc_gross_flow_history').proxyLabel,
    'market_flow_proxy_not_holder_execution',
  )
  assert.ok(
    aave.evidence
      .find((block) => block.evidenceId === 'bounded_mined_holder_payout_history')
      .limits.includes('positive_only_no_failure_denominator'),
  )
  assert.equal(aave.promotion.liveForecast, 'abstain')
  const assay = aave.evidence.find(
    (block) => block.evidenceId === 'common_holder_assay_walk_forward_backtest',
  )
  assert.equal(assay.samples.scorableRows, 2)
  assert.equal(assay.samples.scorableIssueClusters, 1)
  assert.deepEqual(assay.design.stageScopes, HOLDER_ASSAY_ROUTE_SPECS[AAVE_USDC_ROUTE].stageScopes)
  assert.deepEqual(assay.outcomes.transitions, { remained_callable: 2 })
  assert.equal(assay.outcomes.independence.rowsAreIndependentSamples, false)
  assert.equal(assay.outcomes.zeroObservedTransitionEvents, true)
  assert.ok(
    assay.limits.includes(
      'zero_observed_state_transitions_prevent_alert_discrimination_and_duration_estimation',
    ),
  )
  assert.equal(
    Object.hasOwn(assay.outcomes.historicalAssayStateBaseline, 'meanAssayStateProbabilityCallable'),
    false,
  )
  assert.equal(
    Object.hasOwn(assay.outcomes.pairedAssayStatePersistence, 'meanAssayStateProbabilityCallable'),
    false,
  )
  const emptyAssayRoute = report.routes.find(
    (route) => route.routeKey === 'USDe → Staked USDe [USDe]',
  )
  assert.equal(
    emptyAssayRoute.evidence.find(
      (block) => block.evidenceId === 'common_holder_assay_walk_forward_backtest',
    ).historicalUse,
    'abstain',
  )
  assert.equal(emptyAssayRoute.promotion.historicalOutlook, 'abstain')
  const aaveUsde = report.routes.find((route) => route.routeKey === AAVE_USDE_ROUTE)
  assert.equal(aaveUsde.exactSubjects, 1)
  assert.deepEqual(aaveUsde.subjects, [
    { destination: AAVE_USDE_DESTINATION, originalAsset: AAVE_USDE_ASSET },
  ])
  assert.equal(aaveUsde.promotion.historicalOutlook, 'eligible_exact_endpoint_history')
  assert.deepEqual(aaveUsde.evidence[0].samples, {
    reconciledTransactions: 0,
    supplierArchives: 1,
    sameHolderSupplierPayouts: 23,
  })
})

test('verified offline report preserves the 26/68 cohort and 22/4/0 history partition', async () => {
  const report = await readOfflineHistoricalOutlook()
  const partition = historicalCoveragePartition(report.routes)
  assert.deepEqual(
    {
      routeGroups: report.coverage.routeGroups,
      exactSubjects: report.coverage.exactSubjects,
      ...partition,
    },
    {
      routeGroups: 26,
      exactSubjects: 68,
      exactEndpointHistoryRouteGroups: 22,
      proxyOnlyHistoryRouteGroups: 4,
      abstainingRouteGroups: 0,
    },
  )
  assert.deepEqual(
    {
      exactEndpointHistoryRouteGroups: report.coverage.exactEndpointHistoryRouteGroups,
      proxyOnlyHistoryRouteGroups: report.coverage.proxyOnlyHistoryRouteGroups,
      abstainingRouteGroups: report.coverage.abstainingRouteGroups,
    },
    partition,
  )
})

test('promotes four sealed same-holder final-asset calls without projecting future exit', () => {
  const matrix = exactDirectMatrixFixture()
  const panel = exactDirectPanelFixture(matrix)
  const report = buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: panel })
  for (const routeKey of Object.keys(EXACT_DIRECT_WITHDRAW_ROUTES)) {
    const route = report.routes.find((entry) => entry.routeKey === routeKey)
    const block = route.evidence.find(
      (entry) => entry.evidenceId === 'exact_holder_final_asset_withdraw_call_history',
    )
    assert.equal(route.promotion.historicalOutlook, 'eligible_exact_endpoint_history')
    assert.equal(route.promotion.liveForecast, 'abstain')
    assert.equal(block.evidenceClass, 'historical_endpoint')
    assert.equal(block.outcomes.observations.length, 1)
    assert.equal(block.outcomes.observations[0].finalPayoutAsset, route.subjects[0].originalAsset)
    assert.equal(block.outcomes.capacityProjection, null)
    assert.equal(block.outcomes.durationProjection, null)
    assert.equal(block.prospectiveValidated, false)
    assert.equal(Object.hasOwn(block.outcomes, 'probability'), false)
  }
  for (const routeKey of [
    'AUSD → Staked USDat [USDat]',
    'PYUSD → StakingVault [wYLDS]',
    'USDT → FluidBridgeAggregatorProxy [USDC]',
    'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
  ]) {
    const route = report.routes.find((entry) => entry.routeKey === routeKey)
    assert.equal(
      route.evidence.some(
        (entry) => entry.evidenceId === 'exact_holder_final_asset_withdraw_call_history',
      ),
      false,
    )
  }
})

test('exact direct call history fails closed on route, payout, holder, score, Q and block tampering', () => {
  const matrix = exactDirectMatrixFixture()
  for (const mutate of [
    (subject, row) => {
      row.subject = `wrong\0${subject.destination}\0${subject.asset}`
    },
    (subject) => {
      subject.asset = '0x' + 'f'.repeat(40)
    },
    (_subject, row) => {
      row.holderCommitment = 'bad'
    },
    (_subject, row) => {
      row.scoreSha256 = null
    },
    (_subject, row) => {
      row.qRaw = '0'
    },
    (_subject, row) => {
      row.baselineBlockHash = '0xdead'
    },
    (_subject, row) => {
      row.observedAtUtc = '2026-10-01T00:44:59.000Z'
    },
    (_subject, row) => {
      row.plannedHorizonHours = 2
    },
    (_subject, row) => {
      row.labelAvailableAtUtc = '2026-10-01T01:59:59.000Z'
    },
    (subject, row) => {
      subject.episodes.push(structuredClone(row))
    },
    (subject, row) => {
      subject.episodes.push({
        ...structuredClone(row),
        qRaw: '2000000',
        baselineAtUtc: '2026-10-01T00:45:01.000Z',
      })
    },
  ]) {
    const panel = exactDirectPanelFixture(matrix)
    const subject = panel.subjects.find((entry) => entry.routeKey === 'USDC → USD3 [USDC]')
    mutate(subject, subject.episodes[0])
    assert.throws(
      () => buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: panel }),
      /historical_outlook_direct_/,
    )
  }
})

test('labels route-specific staged diagnostics without turning them into full exits', () => {
  const report = buildHistoricalOutlookSuite({
    matrix: matrixFixture(),
    saturnProcessing: saturnFixture,
    saturnFinalPayment: saturnFinalPaymentFixture,
    apyUsdTiming: apyFixture,
  })
  const saturn = report.routes.find((route) => route.routeKey === SATURN_ROUTE)
  const queue = saturn.evidence.find(
    (block) => block.evidenceId === 'saturn_queue_processing_regime_check',
  )
  assert.equal(queue.evidenceClass, 'historical_proxy')
  assert.equal(queue.proxyLabel, 'intermediate_queue_stage_not_final_asset_exit')
  const finalPayment = saturn.evidence.find(
    (block) => block.evidenceId === 'saturn_exact_holder_usdat_payment_duration',
  )
  assert.equal(finalPayment.evidenceClass, 'historical_proxy')
  assert.equal(finalPayment.proxyLabel, 'intermediate_usdat_payment_not_final_ausd_exit')
  assert.equal(finalPayment.samples.verifiedFinalHolderPayments, 77)
  assert.deepEqual(finalPayment.outcomes.medianDurationSeconds, {
    lowerSeconds: 126_768,
    upperSeconds: 209_100,
  })
  const apy = report.routes.find((route) => route.routeKey === APYUSD_ROUTE)
  const payment = apy.evidence.find(
    (block) => block.evidenceId === 'apyusd_request_to_payment_asof_split',
  )
  assert.equal(payment.evidenceClass, 'historical_endpoint')
  assert.equal(payment.outcomes.holdoutAtFinalCutoff[0].evaluable, 48)
  assert.equal(payment.prospectiveValidated, false)
})

test('binds the common assay backtest to the matrix manifest, subject counts, and stage scopes', () => {
  const matrix = matrixFixture()
  const wrongManifest = assayBacktestFixture(matrix)
  wrongManifest.manifestSha256 = 'f'.repeat(64)
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix, holderAssayBacktest: wrongManifest }),
    /historical_outlook_assay_backtest_invalid/,
  )

  const wrongCount = assayBacktestFixture(matrix)
  wrongCount.byVenueGroup[0].exactSubjects++
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix, holderAssayBacktest: wrongCount }),
    /historical_outlook_assay_group_invalid/,
  )

  const wrongScope = assayBacktestFixture(matrix)
  wrongScope.byVenueGroup[0].stageScopes = ['wrong_stage_scope']
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix, holderAssayBacktest: wrongScope }),
    /historical_outlook_assay_group_invalid/,
  )
})

test('abstains from live forecasting even where exact historical endpoint evidence exists', () => {
  const report = buildHistoricalOutlookSuite({ matrix: matrixFixture() })
  assert.equal(report.coverage.routeGroups, 26)
  assert.ok(
    report.routes.every(
      (route) =>
        route.promotion.liveForecast === 'abstain' &&
        route.promotion.reasonCodes.includes('prospective_validation_absent'),
    ),
  )
  assert.ok(
    report.routes
      .flatMap((route) => route.evidence)
      .every((block) => block.retrospectiveOnly && block.prospectiveValidated === false),
  )
})

test('exposes separate Umbrella GHO and FluidBridge USDC endpoint states with censored followups', () => {
  const matrix = matrixFixture()
  const panel = stageEndpointPanelFixture(matrix)
  const report = buildHistoricalOutlookSuite({
    matrix,
    holderStageEndpointStates: panel,
    asOfUtc: '2026-10-05T10:00:00.000Z',
  })
  const umbrella = report.routes.find((route) => route.routeKey === UMBRELLA_GHO_ROUTE)
  const fluid = report.routes.find((route) => route.routeKey === FLUID_BRIDGE_USDC_ROUTE)
  const umbrellaBlock = umbrella.evidence.find(
    (block) => block.evidenceId === 'umbrella_gho_exact_stage_revert_states',
  )
  const fluidBlock = fluid.evidence.find(
    (block) => block.evidenceId === 'fluid_bridge_usdc_first_leg_baseline_and_censoring',
  )
  assert.equal(umbrellaBlock.samples.issueClusters, 3)
  assert.equal(umbrellaBlock.samples.qHorizonCells, 20)
  assert.equal(umbrellaBlock.samples.measuredFollowupCells, 5)
  assert.deepEqual(umbrellaBlock.outcomes.baselineGates, {
    waiting: 1,
    cooldown_not_started: 1,
    window_expired: 1,
  })
  assert.equal(umbrellaBlock.outcomes.measuredStillReverting, 5)
  assert.equal(fluidBlock.samples.issueClusters, 1)
  assert.equal(fluidBlock.samples.qCases, 5)
  assert.equal(fluidBlock.samples.qHorizonCells, 25)
  assert.deepEqual(
    fluidBlock.outcomes.byHorizon.map(({ horizonHours, missedWindow, missing, pending }) => [
      horizonHours,
      missedWindow,
      missing,
      pending,
    ]),
    [
      [1, 5, 0, 0],
      [4, 5, 0, 0],
      [24, 0, 5, 0],
      [48, 0, 5, 0],
      [168, 0, 0, 5],
    ],
  )
  for (const [route, block] of [
    [umbrella, umbrellaBlock],
    [fluid, fluidBlock],
  ]) {
    assert.equal(route.promotion.historicalOutlook, 'eligible_exact_endpoint_history')
    assert.equal(route.promotion.liveForecast, 'abstain')
    assert.equal(block.retrospectiveOnly, true)
    assert.equal(block.prospectiveValidated, false)
    assert.equal(block.outcomes.capacityProjection, null)
    assert.equal(block.outcomes.durationProjection, null)
    assert.ok(block.limits.includes('first_leg_is_not_full_route_exit'))
  }
  assert.equal(report.coverage.routeGroups, 26)
  assert.equal(report.coverage.exactSubjects, 68)
  assert.equal(report.sources.holderStageEndpointStates.status, 'verified')
})

test('refuses future labels, relabeled routes, and foreign FluidBridge USDT rows', () => {
  const matrix = matrixFixture()
  const future = stageEndpointPanelFixture(matrix)
  future.subjects.find(
    (subject) => subject.routeKey === UMBRELLA_GHO_ROUTE,
  ).episodes[0].labelAvailableAtUtc = '2026-10-06T00:00:00.000Z'
  assert.throws(
    () =>
      buildHistoricalOutlookSuite({
        matrix,
        holderStageEndpointStates: future,
        asOfUtc: '2026-10-05T10:00:00.000Z',
      }),
    /historical_outlook_stage_row_invalid/,
  )
  const relabeled = stageEndpointPanelFixture(matrix)
  relabeled.subjects.find((subject) => subject.routeKey === FLUID_BRIDGE_USDC_ROUTE).routeKey =
    'USDT → FluidBridgeAggregatorProxy [USDC]'
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: relabeled }),
    /historical_outlook_stage_subject_invalid/,
  )
  const foreign = stageEndpointPanelFixture(matrix)
  foreign.subjects.find(
    (subject) => subject.routeKey === FLUID_BRIDGE_USDC_ROUTE,
  ).episodes[0].lane = 'fluid_bridge_usdt'
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: foreign }),
    /historical_outlook_fluid_bridge_state_invalid/,
  )
})

test('requires canonical holder commitments and binds each issue cluster to one holder', () => {
  const matrix = matrixFixture()
  const stageSubject = (panel, routeKey) =>
    panel.subjects.find((subject) => subject.routeKey === routeKey)

  for (const routeKey of [UMBRELLA_GHO_ROUTE, FLUID_BRIDGE_USDC_ROUTE]) {
    const absent = stageEndpointPanelFixture(matrix)
    const absentRow = stageSubject(absent, routeKey).episodes[0]
    absentRow.rawBaselineStatus = routeKey === UMBRELLA_GHO_ROUTE ? 'success' : 'evm_revert'
    delete absentRow.holderCommitment
    assert.throws(
      () => buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: absent }),
      /historical_outlook_stage_row_invalid/,
      `${routeKey}: absent holder commitment`,
    )

    const noncanonical = stageEndpointPanelFixture(matrix)
    const noncanonicalRow = stageSubject(noncanonical, routeKey).episodes[0]
    noncanonicalRow.rawBaselineStatus = routeKey === UMBRELLA_GHO_ROUTE ? 'success' : 'evm_revert'
    noncanonicalRow.holderCommitment = 'A'.repeat(64)
    assert.throws(
      () => buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: noncanonical }),
      /historical_outlook_stage_row_invalid/,
      `${routeKey}: noncanonical holder commitment`,
    )

    const conflicting = stageEndpointPanelFixture(matrix)
    stageSubject(conflicting, routeKey).episodes[1].holderCommitment = '0'.repeat(64)
    assert.throws(
      () => buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: conflicting }),
      /historical_outlook_stage_issue_conflict/,
      `${routeKey}: issue cluster switches holder`,
    )
  }
})

test('rejects unlinked, late, or absent score clocks and unscored outcome leakage', () => {
  const matrix = matrixFixture()
  const check = (mutate, reason = /historical_outlook_stage_row_invalid/) => {
    const panel = stageEndpointPanelFixture(matrix)
    const umbrella = panel.subjects.find((subject) => subject.routeKey === UMBRELLA_GHO_ROUTE)
    const fluid = panel.subjects.find((subject) => subject.routeKey === FLUID_BRIDGE_USDC_ROUTE)
    mutate({ umbrella, fluid })
    assert.throws(
      () =>
        buildHistoricalOutlookSuite({
          matrix,
          holderStageEndpointStates: panel,
          asOfUtc: '2026-10-05T10:00:00.000Z',
        }),
      reason,
    )
  }
  check(({ umbrella }) => {
    umbrella.episodes[0].scoreSha256 = null
  })
  check(({ umbrella }) => {
    umbrella.episodes[0].labelAvailableAtUtc = null
  })
  check(({ umbrella }) => {
    umbrella.episodes[0].observedAtUtc = null
  })
  check(({ umbrella }) => {
    umbrella.episodes[0].labelAvailableAtUtc = '2026-10-06T00:00:00.000Z'
  })
  check(({ umbrella }) => {
    umbrella.episodes[0].labelAvailableAtUtc = '2026-10-01T04:10:00.000Z'
  })
  check(({ umbrella }) => {
    umbrella.episodes.find((row) => row.rawScoreStatus === null).rawTransition = 'still_reverting'
  })
  check(({ fluid }) => {
    fluid.episodes.find((row) => row.rawScoreStatus === null).rawScoreOutcome = 'simulated_success'
  })
  check(({ fluid }) => {
    fluid.episodes[0].rawScoreOutcome = 'simulated_success'
  })
  check(({ fluid }) => {
    fluid.episodes[0].scoreSha256 = fluid.episodes[0].issueSha256
  })
  check(({ fluid }) => {
    fluid.episodes[0].scoreSha256 = '9'.repeat(64)
  }, /historical_outlook_stage_score_link_invalid/)
})

test('binds exact Umbrella share Q and FluidBridge USDC first-leg units', () => {
  const matrix = matrixFixture()
  for (const [routeKey, field, value, reason] of [
    [
      UMBRELLA_GHO_ROUTE,
      'qRaw',
      '2000000000000000000',
      /historical_outlook_umbrella_state_invalid/,
    ],
    [UMBRELLA_GHO_ROUTE, 'qUnit', 'GHO_assets', /historical_outlook_umbrella_state_invalid/],
    [
      FLUID_BRIDGE_USDC_ROUTE,
      'qUnit',
      'USDT_assets',
      /historical_outlook_fluid_bridge_state_invalid/,
    ],
  ]) {
    const panel = stageEndpointPanelFixture(matrix)
    panel.subjects.find((subject) => subject.routeKey === routeKey).episodes[0][field] = value
    assert.throws(
      () => buildHistoricalOutlookSuite({ matrix, holderStageEndpointStates: panel }),
      reason,
    )
  }
})

test('keeps optional offline reader failures explicit and still returns all routes', async () => {
  const matrix = matrixFixture()
  const report = await readOfflineHistoricalOutlook({
    readers: {
      holderExitMatrix: async () => matrix,
      holderAssayBacktest: async () => assayBacktestFixture(matrix),
      aaveUsdcGrossFlow: async () => {
        throw Error('sealed_archive_missing')
      },
      morphoUsdcFixed10k: async () => morphoFixture,
      saturnProcessing: async () => saturnFixture,
      saturnFinalPayment: async () => saturnFinalPaymentFixture,
      apyUsdTiming: async () => apyFixture,
      aggregateCashHoldout: async () => null,
    },
  })
  assert.equal(report.coverage.routeGroups, 26)
  assert.deepEqual(report.sources.aaveUsdcGrossFlow, {
    status: 'unavailable',
    required: false,
    reason: 'sealed_archive_missing',
  })
  assert.equal(report.sources.morphoUsdcFixed10k.status, 'verified')
  assert.deepEqual(report.sources.aggregateCashHoldout, {
    status: 'unavailable',
    required: false,
    reason: 'source_returned_null',
  })
})

test('fails closed when the frozen matrix is not 25 groups and 67 subjects', () => {
  const matrix = matrixFixture()
  matrix.subjects.pop()
  assert.throws(() => buildHistoricalOutlookSuite({ matrix }), /historical_outlook_matrix_invalid/)
})

test('fails closed on an absent or relabeled supplemental route', () => {
  const absent = matrixFixture()
  absent.supplemental = []
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix: absent }),
    /historical_outlook_supplemental_invalid/,
  )
  const relabeled = matrixFixture()
  relabeled.supplemental[0].destination = '0x0000000000000000000000000000000000000001'
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix: relabeled }),
    /historical_outlook_supplemental_invalid/,
  )
})

test('keeps the supplemental route as an explicit abstention without verified payout evidence', () => {
  const matrix = matrixFixture()
  matrix.supplemental[0].historicalSupplierPayoutEvidence = {
    status: 'unavailable',
    reason: 'no_sealed_segments',
  }
  const route = buildHistoricalOutlookSuite({ matrix }).routes.find(
    (candidate) => candidate.routeKey === AAVE_USDE_ROUTE,
  )
  assert.equal(route.promotion.historicalOutlook, 'abstain')
  assert.deepEqual(route.evidence, [])
})

test('rejects supplemental payout evidence without its sealed archive provenance', () => {
  const matrix = matrixFixture()
  delete matrix.supplemental[0].historicalSupplierPayoutEvidence.coverage.segmentSha256
  assert.throws(
    () => buildHistoricalOutlookSuite({ matrix }),
    /historical_outlook_supplemental_evidence_invalid/,
  )
})

test('accepts only a canonical full-replay Aave flow export with the pinned identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'holder-outlook-flow-'))
  const path = join(directory, 'summary.json')
  const summary = {
    ...flowFixture,
    sourceVerification: 'full_sealed_replay',
    identity: {
      chainId: 1,
      routeKey: AAVE_USDC_ROUTE,
      destination: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
      asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    },
    source: { ...flowFixture.source, joinContentSha256: 'b'.repeat(64) },
  }
  const canonicalBytes = `${JSON.stringify(summary)}\n`
  const canonicalSha256 = createHash('sha256').update(canonicalBytes).digest('hex')
  writeFileSync(path, canonicalBytes)
  assert.deepEqual(readSavedAaveFlowSummary(path, canonicalSha256), summary)
  writeFileSync(path, `${canonicalBytes} `)
  assert.throws(
    () => readSavedAaveFlowSummary(path, canonicalSha256),
    /aave_flow_export_sha256_mismatch/,
  )
  const invalidBytes = `${JSON.stringify({ ...summary, sourceVerification: 'shape_only' })}\n`
  const invalidSha256 = createHash('sha256').update(invalidBytes).digest('hex')
  writeFileSync(path, invalidBytes)
  assert.throws(() => readSavedAaveFlowSummary(path, invalidSha256), /aave_flow_export_invalid/)
})

test('Aave flow fallback is pinned-export status and only handles the known metadata entry', () => {
  const fallback = readAaveFlowSummaryWithFallback({
    replay: () => {
      throw Error('archive_unexpected_entry')
    },
    readSaved: () => flowFixture,
  })
  assert.deepEqual(fallback.suiteSource, {
    status: 'pinned_saved_export',
    mode: 'canonical_full_replay_export_fallback',
    replayUnavailableReason: 'archive_unexpected_entry',
  })
  assert.throws(
    () =>
      readAaveFlowSummaryWithFallback({
        replay: () => {
          throw Error('join_session_right_source_changed')
        },
        readSaved: () => flowFixture,
      }),
    /join_session_right_source_changed/,
  )
})
