import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  buildMorphoFixed10kTransitionStudy,
  buildHolderExitEpisodePanel,
  cashFeaturesFromVerifiedRecords,
  holderExitPrimaryCellKey,
  readVerifiedHolderExitEpisodePanel,
  selectAsOfFeatures,
} from './holder-exit-episode-panel.mjs'
import { BOARD_ROUTES, scoreTransition } from './carry-local-morpho-holder-v2.mjs'
import { buildMorphoV2Episodes } from './holder-exit-morpho-v2-episodes.mjs'
import { DIRECT_MARKETS as PUBLIC_MARKETS } from './carry-public-direct-exit-issue.mjs'
import { DIRECT_MARKETS as COMPOUND_MARKETS } from './carry-local-compound-holder-issue.mjs'
import { ROUTES as FLUID_ROUTES } from './carry-fluid-ftoken-payout.mjs'
import { ROUTE as USD3_ROUTE } from './carry-public-usd3-exit-common.mjs'
import { ROUTE as STUSDS_ROUTE } from './carry-public-stusds-exit-common.mjs'
import { ROUTE as SUSDS_ROUTE } from './carry-public-susds-exit-common.mjs'
import { ROUTE as SGHO_ROUTE } from './carry-public-sgho-exit-common.mjs'
import { UMBRELLA_SUBJECT } from './holder-exit-umbrella-episodes.mjs'
import { APYUSD_SUBJECT } from './holder-exit-apyusd-episodes.mjs'
import { STAKED_USDAT_SUBJECT } from './holder-exit-staked-usdat-episodes.mjs'
import { FLUID_BRIDGE_SUBJECTS } from './holder-exit-fluid-bridge-episodes.mjs'
import { PYUSD_STAKING_SUBJECT } from './holder-exit-pyusd-staking-episodes.mjs'
import { TWYNE_PT_SUBJECT } from './holder-exit-twyne-pt-episodes.mjs'
import { SUSDE_PENDING_SUBJECT } from './holder-exit-susde-pending-episodes.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const AAVE = {
  route_key: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
const BASELINE_AT = '2026-10-04T00:00:00.000Z'
const ISSUE_AT = '2026-10-04T00:10:00.000Z'
const TARGET_AT = '2026-10-04T01:00:00.000Z'
const SCORE_AT = '2026-10-04T01:05:00.000Z'
const DEADLINE_AT = '2026-10-04T02:00:00.000Z'
const NOW = Date.parse('2026-10-04T01:30:00.000Z')

function morphoFixed10kLedger() {
  const route = BOARD_ROUTES.find((item) => item.routeKey === 'USDC → VaultV2 [USDC]')
  assert.ok(route)
  const episode = ({ split, anchorBlock, holder, cell, horizonClasses, loss, recovery }) => ({
    split,
    anchorBlock,
    vault: route.destination,
    holder,
    holderVaultCluster: `${route.destination}:${holder}`,
    cellSha256: hash(cell),
    horizonClasses,
    firstObservedLossIntervalHours: loss,
    firstLossRightCensoredAtHours: loss ? null : 168,
    observedRecoveryIntervalHours: recovery,
    recoveryRightCensoredAtHours: null,
    censoring: null,
    missingHorizonSamples: 0,
  })
  const development = episode({
    split: 'development',
    anchorBlock: 100,
    holder: address(901),
    cell: 'morpho-fixed-development',
    horizonClasses: [
      { hours: 1, outcome: 'success' },
      { hours: 4, outcome: 'success' },
      { hours: 24, outcome: 'success' },
      { hours: 48, outcome: 'evm_revert' },
      { hours: 168, outcome: 'success' },
    ],
    loss: { after: 24, through: 48, hasMissingInterveningSample: false },
    recovery: { after: 48, through: 168, hasMissingInterveningSample: false },
  })
  const holdout = episode({
    split: 'reservedHoldout',
    anchorBlock: 200,
    holder: address(902),
    cell: 'morpho-fixed-holdout',
    horizonClasses: [1, 4, 24, 48, 168].map((hours) => ({ hours, outcome: 'success' })),
    loss: null,
    recovery: null,
  })
  return {
    schemaVersion: 1,
    study: 'morpho-v2-usdc-10k-holder-risk-ledger-v1',
    routeKey: route.routeKey,
    asset: route.asset,
    qAssetsRaw: '10000000000',
    planSha256: hash('morpho-fixed-plan'),
    source: 'caller_supplied_frozen_plan_and_validated_cells',
    reservedHoldoutAnchor: 200,
    counts: {
      development: {
        baselineSuccessEpisodes: 1,
        observedFirstLossEpisodes: 1,
        observedRecoveryEpisodes: 1,
      },
      reservedHoldout: {
        baselineSuccessEpisodes: 1,
        observedFirstLossEpisodes: 0,
        observedRecoveryEpisodes: 0,
      },
      all: {
        baselineSuccessEpisodes: 2,
        observedFirstLossEpisodes: 1,
        observedRecoveryEpisodes: 1,
      },
      sharedHolderVaultClustersAcrossSplits: 0,
    },
    episodes: [development, holdout],
    limits: {
      forecastValidated: false,
      likelyExitDurationAvailable: false,
      independentObservations: false,
    },
  }
}

test('Morpho fixed-$10k loss and recovery remain a split retrospective sidecar', () => {
  const ledger = morphoFixed10kLedger()
  const study = buildMorphoFixed10kTransitionStudy({ manifest: manifest(), ledger })
  assert.equal(study.episodes.length, 2)
  assert.deepEqual(study.bySplit.development, {
    episodes: 1,
    holderVaultCorrelationClusters: 1,
    transitionEvents: 2,
    lostExitabilityEvents: 1,
    recoveredExitabilityEvents: 1,
  })
  assert.equal(study.bySplit.reservedHoldout.transitionEvents, 0)
  assert.deepEqual(
    study.episodes[0].transitionEvents.map((event) => ({
      transition: event.transition,
      intervalNotation: event.intervalNotation,
    })),
    [
      { transition: 'lost_exitability', intervalNotation: '(24,48]' },
      { transition: 'recovered_exitability', intervalNotation: '(48,168]' },
    ],
  )
  assert.equal(study.walkForwardEligible, false)
  assert.equal(study.forecastValidated, false)
  assert.equal(study.calibratedDuration, false)
  assert.equal(
    study.episodes[0].holderCommitment,
    hash(`${study.episodes[0].destination}:${study.episodes[0].holder}`),
  )
  assert.equal(
    study.episodes[0].holderBindingScheme,
    'sha256(lowercase_vault_colon_lowercase_holder)',
  )

  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    morphoFixed10kLedger: ledger,
    nowMs: NOW,
  })
  assert.equal(panel.summary.retrospectiveTransitionEpisodes, 2)
  assert.equal(panel.summary.retrospectiveTransitionEvents, 2)
  assert.equal(panel.summary.rawQHRows, 0)
  assert.equal(panel.retrospectiveTransitionStudies.length, 1)
  const exact = panel.subjects.find(
    (subject) => subject.destination === study.episodes[0].destination,
  )
  assert.equal(exact.retrospectiveEpisodes.length, 2)
  assert.equal(exact.episodes.length, 0)

  const wrongSplit = structuredClone(ledger)
  wrongSplit.episodes[0].split = 'reservedHoldout'
  assert.throws(
    () => buildMorphoFixed10kTransitionStudy({ manifest: manifest(), ledger: wrongSplit }),
    /holder_episode_panel_morpho_fixed_10k_split_invalid/,
  )
  const wrongHorizon = structuredClone(ledger)
  wrongHorizon.episodes[0].horizonClasses[3].hours = 47
  assert.throws(
    () => buildMorphoFixed10kTransitionStudy({ manifest: manifest(), ledger: wrongHorizon }),
    /holder_episode_panel_morpho_fixed_10k_horizon_invalid/,
  )
})

test('Morpho fixed-$10k sidecar enforces exact Q, logical episode uniqueness, and first transitions', () => {
  const wrongQ = morphoFixed10kLedger()
  wrongQ.qAssetsRaw = '9999999999'
  assert.throws(
    () => buildMorphoFixed10kTransitionStudy({ manifest: manifest(), ledger: wrongQ }),
    /holder_episode_panel_morpho_fixed_10k_invalid/,
  )

  const duplicate = morphoFixed10kLedger()
  duplicate.episodes.push({
    ...structuredClone(duplicate.episodes[0]),
    cellSha256: hash('fresh-cell-sha-same-logical-episode'),
  })
  assert.throws(
    () => buildMorphoFixed10kTransitionStudy({ manifest: manifest(), ledger: duplicate }),
    /holder_episode_panel_morpho_fixed_10k_episode_duplicate/,
  )

  const forgedHolder = morphoFixed10kLedger()
  const forgedEpisode = structuredClone(forgedHolder.episodes[0])
  forgedEpisode.holder = address(999)
  forgedEpisode.holderVaultCluster = `${forgedEpisode.vault}:${forgedEpisode.holder}`
  forgedEpisode.cellSha256 = hash('fresh-cell-sha-forged-holder-same-plan-cell')
  forgedHolder.episodes.push(forgedEpisode)
  assert.throws(
    () => buildMorphoFixed10kTransitionStudy({ manifest: manifest(), ledger: forgedHolder }),
    /holder_episode_panel_morpho_fixed_10k_episode_duplicate/,
  )

  const repeatedLoss = morphoFixed10kLedger()
  repeatedLoss.episodes[0].horizonClasses = [
    { hours: 1, outcome: 'success' },
    { hours: 4, outcome: 'evm_revert' },
    { hours: 24, outcome: 'evm_revert' },
    { hours: 48, outcome: 'success' },
    { hours: 168, outcome: 'success' },
  ]
  repeatedLoss.episodes[0].firstObservedLossIntervalHours = {
    after: 1,
    through: 4,
    hasMissingInterveningSample: false,
  }
  repeatedLoss.episodes[0].observedRecoveryIntervalHours = {
    after: 24,
    through: 48,
    hasMissingInterveningSample: false,
  }
  const repeatedLossStudy = buildMorphoFixed10kTransitionStudy({
    manifest: manifest(),
    ledger: repeatedLoss,
  })
  assert.deepEqual(
    repeatedLossStudy.episodes[0].transitionEvents.map((event) => event.intervalNotation),
    ['(1,4]', '(24,48]'],
  )

  const claimedLaterCycle = morphoFixed10kLedger()
  claimedLaterCycle.episodes[0].horizonClasses = [
    { hours: 1, outcome: 'success' },
    { hours: 4, outcome: 'evm_revert' },
    { hours: 24, outcome: 'success' },
    { hours: 48, outcome: 'evm_revert' },
    { hours: 168, outcome: 'success' },
  ]
  claimedLaterCycle.episodes[0].firstObservedLossIntervalHours = {
    after: 24,
    through: 48,
    hasMissingInterveningSample: false,
  }
  claimedLaterCycle.episodes[0].observedRecoveryIntervalHours = {
    after: 48,
    through: 168,
    hasMissingInterveningSample: false,
  }
  assert.throws(
    () => buildMorphoFixed10kTransitionStudy({ manifest: manifest(), ledger: claimedLaterCycle }),
    /holder_episode_panel_morpho_fixed_10k_first_transition_invalid/,
  )
})

test('primary cell identity tags missing and explicit Q units separately', () => {
  const cell = {
    issueClusterSha256: hash('cluster'),
    analysisCellKey: null,
    holderCommitment: hash('holder'),
    qRaw: '1000000',
    plannedHorizonHours: 1,
  }
  assert.equal(holderExitPrimaryCellKey(cell), holderExitPrimaryCellKey({ ...cell, qUnit: null }))
  assert.notEqual(
    holderExitPrimaryCellKey(cell),
    holderExitPrimaryCellKey({ ...cell, qUnit: 'raw' }),
  )
  assert.notEqual(
    holderExitPrimaryCellKey({ ...cell, qUnit: 'raw' }),
    holderExitPrimaryCellKey({ ...cell, qUnit: 'asset_raw' }),
  )
})

function manifest() {
  const subjects = [
    AAVE,
    ...BOARD_ROUTES.map((route) => ({
      route_key: route.routeKey,
      destination: route.destination,
      asset: route.asset,
    })),
    ...[PUBLIC_MARKETS.sparkLendUsdt, COMPOUND_MARKETS.compoundV3Usdc].map((route) => ({
      route_key: route.routeKey,
      destination: route.destination,
      asset: route.asset,
    })),
    ...FLUID_ROUTES.map((route) => ({
      route_key: route.key,
      destination: route.vault,
      asset: route.asset,
    })),
    ...[USD3_ROUTE, STUSDS_ROUTE, SUSDS_ROUTE].map((route) => ({
      route_key: route.routeKey,
      destination: route.destination,
      asset: route.asset,
    })),
    {
      route_key: SGHO_ROUTE.routeKey,
      destination: SGHO_ROUTE.destination,
      asset: SGHO_ROUTE.asset,
    },
    UMBRELLA_SUBJECT,
    APYUSD_SUBJECT,
    STAKED_USDAT_SUBJECT,
    ...FLUID_BRIDGE_SUBJECTS,
    PYUSD_STAKING_SUBJECT,
    TWYNE_PT_SUBJECT,
    SUSDE_PENDING_SUBJECT,
  ]
  return { subjects, sha256: hash(JSON.stringify(subjects)) }
}

function parent(
  sequence = 1,
  cases = [
    {
      label: 'one',
      assetsRaw: '1000000',
      status: 'measured',
      measurement: { status: 'success', holderCoverageRaw: '2000000' },
    },
  ],
) {
  return {
    sequence,
    sha256: hash(`parent-${sequence}`),
    marketKey: 'aaveV3Usdc',
    routeKey: AAVE.route_key,
    destination: AAVE.destination,
    originalAsset: AAVE.asset,
    issuedAtUtc: ISSUE_AT,
    candidate: { holder: address(500) },
    baseline: {
      targetBlock: '100',
      targetHash: `0x${'1'.repeat(64)}`,
      targetBlockAt: BASELINE_AT,
    },
    targets: [{ horizonHours: 1, targetAtUtc: TARGET_AT, captureDeadlineUtc: DEADLINE_AT }],
    cases,
  }
}

function score(issue, outcome = 'exit_success') {
  return {
    sequence: 1,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    marketKey: 'aaveV3Usdc',
    horizonHours: 1,
    sha256: hash(`score-${issue.sequence}`),
    scoredAtUtc: SCORE_AT,
    target: { targetBlockAt: TARGET_AT },
    cases: issue.cases.map((entry) => ({ label: entry.label, status: 'measured', outcome })),
  }
}

function feature(n, overrides = {}) {
  return {
    kind: 'aggregate_cash',
    routeKey: AAVE.route_key,
    destination: AAVE.destination,
    asset: AAVE.asset,
    receiptSha256: hash(`cash-${n}`),
    collectionMode: 'current',
    sourceBlock: String(n),
    sourceBlockHash: `0x${'2'.repeat(64)}`,
    sourceAt: '2026-10-03T23:59:00.000Z',
    firstLocalReceiptAt: '2026-10-04T00:05:00.000Z',
    coverageComplete: true,
    valueRaw: '5000000',
    ...overrides,
  }
}

test('67 exact subjects remain visible while Aave Q and horizons share one issue cluster', () => {
  const issue = parent(1, [
    {
      label: 'one',
      assetsRaw: '1000000',
      status: 'measured',
      measurement: { status: 'success', holderCoverageRaw: '2000000' },
    },
    {
      label: 'two',
      assetsRaw: '2000000',
      status: 'measured',
      measurement: { status: 'success', holderCoverageRaw: '2000000' },
    },
  ])
  issue.targets.push({
    horizonHours: 4,
    targetAtUtc: '2026-10-04T04:00:00.000Z',
    captureDeadlineUtc: '2026-10-04T06:00:00.000Z',
  })
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    v1Scores: [score(issue)],
    nowMs: NOW,
  })
  assert.equal(panel.subjects.length, 67)
  assert.equal(panel.subjects.filter((subject) => subject.episodes.length === 0).length, 66)
  assert.equal(panel.summary.rawQHRows, 4)
  assert.equal(panel.summary.issueClusters, 1)
  assert.equal(panel.summary.clustersWithObservedCallableAndNoObservedOnset, 1)
  assert.equal(panel.summary.pendingOrMissingIssueClusters, 1)
  assert.equal(Object.hasOwn(panel.summary, 'simulatedControlOnlyIssueClusters'), false)
  assert.equal(panel.subjects[0].episodes[0].outcome.status, 'simulated_callable')
  assert.equal(panel.subjects[0].episodes[0].qUnit, 'asset_raw')
  assert.equal(panel.subjects[0].episodes[0].fullRoutePaidProofSha256, null)
  assert.equal(panel.forecastValidated, false)
  assert.equal(panel.statisticalIndependenceValidated, false)
})

test('Aave issue and score appear only after their local issue and score clocks', () => {
  const issue = parent()
  const scored = score(issue)
  const at = (nowMs, scoreRow = scored) =>
    buildHolderExitEpisodePanel({
      manifest: manifest(),
      v1Issues: [issue],
      v1Scores: [scoreRow],
      nowMs,
    })
  const beforeIssue = at(Date.parse(ISSUE_AT) - 1)
  assert.equal(beforeIssue.subjects[0].episodes.length, 0)
  assert.equal(beforeIssue.summary.rawQHRows, 0)
  assert.equal(beforeIssue.summary.issueClusters, 0)

  const atIssue = at(Date.parse(ISSUE_AT))
  assert.equal(atIssue.subjects[0].episodes.length, 1)
  assert.equal(atIssue.subjects[0].episodes[0].outcome.status, 'pending')
  assert.equal(atIssue.subjects[0].episodes[0].scoreSha256, null)
  assert.equal(atIssue.subjects[0].episodes[0].labelAvailableAtUtc, null)

  const beforeScore = at(Date.parse(SCORE_AT) - 1)
  assert.equal(beforeScore.subjects[0].episodes[0].outcome.status, 'pending')
  assert.equal(beforeScore.subjects[0].episodes[0].scoreSha256, null)
  assert.equal(beforeScore.subjects[0].episodes[0].observedAtUtc, null)
  assert.equal(beforeScore.subjects[0].episodes[0].labelAvailableAtUtc, null)
  assert.equal(beforeScore.summary.clustersWithObservedCallableAndNoObservedOnset, 0)

  const atScore = at(Date.parse(SCORE_AT))
  assert.equal(atScore.subjects[0].episodes[0].outcome.status, 'simulated_callable')
  assert.equal(atScore.subjects[0].episodes[0].scoreSha256, scored.sha256)
  assert.equal(atScore.subjects[0].episodes[0].labelAvailableAtUtc, SCORE_AT)
  assert.equal(atScore.summary.clustersWithObservedCallableAndNoObservedOnset, 1)
  assert.equal(atScore.forecastValidated, false)
  assert.throws(
    () => at(Date.parse(ISSUE_AT) - 1, { ...scored, scoredAtUtc: 'invalid' }),
    /holder_episode_panel_clock_invalid/,
  )
})

test('Aave V2 and V3 children cannot appear before their V1 parent issue', () => {
  const issue = { ...parent(), issuedAtUtc: '2026-10-04T00:30:00.000Z' }
  const child = {
    sequence: 1,
    marketKey: 'aaveV3Usdc',
    routeKey: AAVE.route_key,
    destination: AAVE.destination,
    originalAsset: AAVE.asset,
    v1IssueSequence: issue.sequence,
    v1IssueSha256: issue.sha256,
    holder: issue.candidate.holder,
    issuedAtUtc: '2026-10-04T00:20:00.000Z',
    targets: issue.targets,
  }
  const v2 = {
    ...child,
    sha256: hash('retrospective-v2'),
    cases: [{ label: 'one', assetsRaw: '1000000', baselineStatus: 'success' }],
  }
  const v3 = {
    ...child,
    sha256: hash('retrospective-v3'),
    selectedHolderCommitment: hash(`${AAVE.destination}:${issue.candidate.holder}`),
    cases: [
      {
        label: 'fixed_1_usdc',
        assetsRaw: '1000000',
        status: 'measured',
        measurement: { baselineStatus: 'success' },
      },
    ],
  }
  const at = (nowMs) =>
    buildHolderExitEpisodePanel({
      manifest: manifest(),
      v1Issues: [issue],
      v2Issues: [v2],
      v3Issues: [v3],
      nowMs,
    })
  assert.equal(at(Date.parse('2026-10-04T00:25:00.000Z')).subjects[0].episodes.length, 0)
  const visible = at(Date.parse(issue.issuedAtUtc))
  assert.deepEqual(
    visible.subjects[0].episodes.map((row) => row.lane),
    ['v1', 'v2', 'v3'],
  )
  assert.equal(visible.summary.issueClusters, 1)
})

function supplierIssue(marketKey, overrides = {}) {
  const compound = marketKey === 'compoundV3Usdc'
  const route = compound ? COMPOUND_MARKETS.compoundV3Usdc : PUBLIC_MARKETS.sparkLendUsdt
  return {
    sequence: 1,
    sha256: hash(`${marketKey}-issue`),
    marketKey,
    routeKey: route.routeKey,
    destination: route.destination,
    originalAsset: route.asset,
    issuedAtUtc: ISSUE_AT,
    candidate: { holder: address(600) },
    baseline: {
      targetBlock: '100',
      targetHash: `0x${'1'.repeat(64)}`,
      targetBlockAt: BASELINE_AT,
    },
    cases: [
      {
        label: 'one',
        assetsRaw: '1000000',
        status: 'measured',
        measurement: { status: 'success', holderCoverageRaw: '2000000' },
      },
    ],
    targets: [
      {
        horizonHours: 1,
        targetAtUtc: compound ? '2026-10-04T01:10:00.000Z' : TARGET_AT,
        captureDeadlineUtc: compound ? '2026-10-04T03:10:00.000Z' : '2026-10-04T03:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

function supplierScore(issue, outcome = 'exit_success', overrides = {}) {
  return {
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    sha256: hash(`${issue.marketKey}-score-${outcome}`),
    marketKey: issue.marketKey,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.originalAsset,
    holder: issue.candidate.holder,
    horizonHours: 1,
    targetAtUtc: issue.targets[0].targetAtUtc,
    captureDeadlineUtc: issue.targets[0].captureDeadlineUtc,
    scoredAtUtc: new Date(Date.parse(issue.targets[0].targetAtUtc) + 5 * 60_000).toISOString(),
    target: { targetBlockAt: issue.targets[0].targetAtUtc },
    cases: [{ label: 'one', assetsRaw: '1000000', status: 'measured', outcome }],
    ...overrides,
  }
}

function supplierPanel(marketKey, issue, scoreRow, extras = {}) {
  const compound = marketKey === 'compoundV3Usdc'
  return buildHolderExitEpisodePanel({
    manifest: manifest(),
    ...(compound
      ? { compoundIssues: [issue], compoundScores: scoreRow ? [scoreRow] : [] }
      : { v1Issues: [issue], v1Scores: scoreRow ? [scoreRow] : [] }),
    nowMs: NOW,
    ...extras,
  })
}

test('Spark and Compound cells bind exact frozen identity, holder, Q, issue and target', () => {
  for (const marketKey of ['sparkLendUsdt', 'compoundV3Usdc']) {
    const issue = supplierIssue(marketKey)
    const scored = supplierScore(issue)
    const panel = supplierPanel(marketKey, issue, scored)
    const subject = panel.subjects.find((row) => row.routeKey === issue.routeKey)
    const cell = subject.episodes[0]
    assert.equal(cell.issueSha256, issue.sha256)
    assert.equal(cell.scoreSha256, scored.sha256)
    assert.equal(cell.qRaw, '1000000')
    assert.equal(cell.qUnit, 'asset_raw')
    assert.equal(cell.plannedHorizonHours, 1)
    assert.equal(
      cell.targetClockBasis,
      marketKey === 'compoundV3Usdc' ? 'issue_plan' : 'baseline_block_timestamp',
    )
    assert.equal(cell.leadAtIssueMinutes, marketKey === 'compoundV3Usdc' ? 60 : 50)
    assert.equal(cell.outcome.status, 'simulated_callable')
    assert.equal(cell.fullRoutePaidProofSha256, null)
    assert.equal(panel.holderExecutableExit, false)
    assert.equal(panel.forecastValidated, false)
    for (const change of [
      { issueSha256: hash('wrong-issue') },
      { destination: address(999) },
      { originalAsset: address(999) },
      { holder: address(999) },
      { targetAtUtc: DEADLINE_AT },
      { captureDeadlineUtc: TARGET_AT },
      { cases: [{ ...scored.cases[0], assetsRaw: '2' }] },
    ])
      assert.throws(
        () => supplierPanel(marketKey, issue, { ...scored, ...change }),
        /holder_episode_panel_supplier_/,
      )
    assert.throws(
      () => supplierPanel(marketKey, { ...issue, originalAsset: address(999) }, null),
      /holder_episode_panel_supplier_/,
    )
  }
})

test('Spark and Compound issue-bound flow stays on its own exact subject', () => {
  for (const marketKey of ['sparkLendUsdt', 'compoundV3Usdc']) {
    const issue = supplierIssue(marketKey)
    const boundFlow = feature(99, {
      kind: 'gross_supplier_supply_24h',
      routeKey: issue.routeKey,
      destination: issue.destination,
      asset: issue.originalAsset,
      collectionMode: 'historical_preissue',
      receiptSha256: hash(`${marketKey}-issue-flow`),
      valueRaw: '456000000',
    })
    const bound = new Map([[issue.sha256, [boundFlow]]])
    const subject = (map) =>
      supplierPanel(marketKey, issue, null, { issueFlowFeaturesBySha: map }).subjects.find(
        (row) => row.routeKey === issue.routeKey,
      )
    assert.equal(subject(bound).episodes[0].featureRefs[0].valueRaw, '456000000')
    assert.equal(
      subject(new Map([[hash('another-issue'), [boundFlow]]])).episodes[0].featureRefs.length,
      0,
    )
  }
})

test('direct supplier cells preserve pending, missing, missed, attrition and uncertain reverts', () => {
  for (const marketKey of ['sparkLendUsdt', 'compoundV3Usdc']) {
    const issue = supplierIssue(marketKey)
    const get = (scoreRow, nowMs = NOW) =>
      supplierPanel(marketKey, issue, scoreRow, { nowMs }).subjects.find(
        (row) => row.routeKey === issue.routeKey,
      ).episodes[0].outcome
    assert.equal(get(null).status, 'pending')
    assert.equal(get(null, Date.parse('2026-10-04T04:00:00.000Z')).status, 'missing')
    assert.deepEqual(
      get(
        supplierScore(issue, null, {
          cases: [
            {
              label: 'one',
              assetsRaw: '1000000',
              status: 'unavailable',
              reason: 'capture_window_missed',
              outcome: null,
            },
          ],
        }),
      ),
      { status: 'censored', reason: 'capture_window_missed' },
    )
    assert.deepEqual(get(supplierScore(issue, 'holder_attrition')), {
      status: 'censored',
      reason: 'holder_attrition',
    })
    assert.deepEqual(get(supplierScore(issue, 'exit_revert_cause_unknown')), {
      status: 'inconclusive',
      reason: 'revert_cause_unknown',
    })
    const revertedBaseline = supplierIssue(marketKey, {
      cases: [
        {
          ...issue.cases[0],
          measurement: {
            status: 'evm_revert',
            coveredRevert: true,
            holderCoverageRaw: '2000000',
          },
        },
      ],
    })
    const baselineCell = supplierPanel(marketKey, revertedBaseline, null).subjects.find(
      (row) => row.routeKey === issue.routeKey,
    ).episodes[0]
    assert.equal(baselineCell.baseline, 'inconclusive')
    assert.deepEqual(baselineCell.outcome, {
      status: 'not_at_risk',
      reason: 'baseline_inconclusive',
    })
  }
})

test('Spark and Compound issue and score clocks gate rows and raw score evidence', () => {
  for (const marketKey of ['sparkLendUsdt', 'compoundV3Usdc']) {
    const issue = supplierIssue(marketKey)
    const scored = supplierScore(issue)
    const subject = (nowMs, scoreRow = scored) =>
      supplierPanel(marketKey, issue, scoreRow, { nowMs }).subjects.find(
        (row) => row.routeKey === issue.routeKey,
      )
    const beforeIssue = supplierPanel(marketKey, issue, scored, {
      nowMs: Date.parse(issue.issuedAtUtc) - 1,
    })
    assert.equal(subject(Date.parse(issue.issuedAtUtc) - 1).episodes.length, 0)
    assert.equal(beforeIssue.summary.rawQHRows, 0)
    assert.equal(subject(Date.parse(issue.issuedAtUtc)).episodes[0].outcome.status, 'pending')

    const beforeScore = subject(Date.parse(scored.scoredAtUtc) - 1).episodes[0]
    assert.equal(beforeScore.outcome.status, 'pending')
    assert.equal(beforeScore.scoreSha256, null)
    assert.equal(beforeScore.observedAtUtc, null)
    assert.equal(beforeScore.rawScoreOutcome, null)
    const atScore = subject(Date.parse(scored.scoredAtUtc)).episodes[0]
    assert.equal(atScore.outcome.status, 'simulated_callable')
    assert.equal(atScore.scoreSha256, scored.sha256)
    assert.equal(atScore.rawScoreOutcome, 'exit_success')
    assert.equal(atScore.issueClock, 'local_operator_clock_unwitnessed')
    assert.equal(atScore.forecastEligible, false)
    assert.throws(
      () => subject(Date.parse(issue.issuedAtUtc) - 1, { ...scored, scoredAtUtc: 'invalid' }),
      /supplier_clock_invalid/,
    )
  }
})

test('Fluid verified route ledgers enter the exact frozen subject panel', () => {
  const route = FLUID_ROUTES[0]
  const issueMs = Date.parse(ISSUE_AT)
  const issue = {
    study: 'fluid_ftoken_holder_issue_v1',
    routeIndex: 0,
    routeKey: route.key,
    vault: route.vault,
    asset: route.asset,
    holder: address(777),
    sequence: 1,
    sha256: hash('fluid-panel-issue'),
    issuedAtUtc: ISSUE_AT,
    baseline: {
      number: 100,
      hash: `0x${'a'.repeat(64)}`,
      timestamp: Date.parse(BASELINE_AT) / 1_000,
      atUtc: BASELINE_AT,
    },
    cases: [{ label: 'holder_1pct', assetsRaw: '100', baseline: { status: 'success' } }],
    targets: [1, 4, 24, 48, 168].map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(issueMs + horizonHours * 3_600_000).toISOString(),
      deadlineUtc: new Date(issueMs + (horizonHours + 2) * 3_600_000).toISOString(),
    })),
  }
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    fluidRouteLedgers: FLUID_ROUTES.map((_, routeIndex) => ({
      routeIndex,
      issues: routeIndex === 0 ? [issue] : [],
      scores: [],
    })),
    nowMs: NOW,
  })
  const subject = panel.subjects.find((row) => row.routeKey === route.key)
  assert.equal(subject.stageScope, 'direct_fluid_ftoken_withdraw_eth_call')
  assert.equal(subject.episodes.length, 5)
  assert.equal(subject.episodes[0].outcome.status, 'pending')
  assert.equal(panel.summary.fluidFTokenFrozenSubjects, 3)
  assert.equal(panel.summary.fluidFTokenSubjectsWithEpisodes, 1)
  assert.equal(panel.summary.issueClusters, 1)
  assert.equal(panel.summary.minedFinalAssetPayouts, 0)
  assert.equal(panel.forecastValidated, false)
})

test('source block and physical availability clocks both guard feature joins', () => {
  const issue = parent()
  const selected = selectAsOfFeatures(
    [
      feature(99),
      feature(101),
      feature(100, { sourceBlockHash: `0x${'2'.repeat(64)}` }),
      feature(98, { firstLocalReceiptAt: '2026-10-04T00:11:00.000Z' }),
      feature(97, { completedAtUtc: '2026-10-04T00:12:00.000Z' }),
      feature(96, { collectionMode: 'retrospective' }),
      feature(95, { coverageComplete: false }),
      feature(94, { collectionMode: 'unknown' }),
    ],
    AAVE,
    issue,
    issue,
  )
  assert.equal(selected.featureRefs.length, 1)
  assert.equal(selected.featureRefs[0].sourceBlock, '99')
  assert.deepEqual(selected.featureAbstentions, {
    future_source: 1,
    source_fork_mismatch: 1,
    late_first_local_receipt: 1,
    late_completion: 1,
    reconstructed_not_issue_time_current: 1,
    coverage_incomplete: 1,
    source_mode_unverified: 1,
  })
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    features: [feature(99), feature(101)],
    nowMs: NOW,
  })
  assert.deepEqual(
    panel.subjects[0].episodes[0].featureRefs.map((row) => row.sourceBlock),
    ['99'],
  )
  assert.deepEqual(panel.subjects[0].episodes[0].featureAbstentions, { future_source: 1 })
})

test('V1/V2/V3 cells retain raw evidence but choose one analysis-primary row per holder Q horizon', () => {
  const issue = parent()
  const holderCommitment = hash(`${AAVE.destination}:${issue.candidate.holder}`)
  const child = (lane) => ({
    sequence: 1,
    sha256: hash(`${lane}-issue`),
    marketKey: 'aaveV3Usdc',
    routeKey: AAVE.route_key,
    destination: AAVE.destination,
    originalAsset: AAVE.asset,
    v1IssueSequence: 1,
    v1IssueSha256: issue.sha256,
    holder: issue.candidate.holder,
    issuedAtUtc: ISSUE_AT,
    targets: issue.targets,
    cases:
      lane === 'v2'
        ? [{ label: 'one', assetsRaw: '1000000', baselineStatus: 'success' }]
        : [
            {
              label: 'fixed_1_usdc',
              assetsRaw: '1000000',
              status: 'measured',
              measurement: { baselineStatus: 'success' },
            },
          ],
    ...(lane === 'v3' ? { selectedHolderCommitment: holderCommitment } : {}),
  })
  const v2 = child('v2')
  const v3 = child('v3')
  v3.issuedAtUtc = '2026-10-04T00:20:00.000Z'
  const childScore = (issueRow, transition) => ({
    issueSequence: 1,
    issueSha256: issueRow.sha256,
    horizonHours: 1,
    sha256: hash(`${transition}-score`),
    scoredAtUtc: SCORE_AT,
    status: 'measured',
    target: { targetBlockAt: TARGET_AT },
    cases: [{ label: issueRow.cases[0].label, status: 'measured', transition }],
  })
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    v1Scores: [score(issue)],
    v2Issues: [v2],
    v2Scores: [childScore(v2, 'lost_exitability')],
    v3Issues: [v3],
    v3Scores: [childScore(v3, 'remained_exitable')],
    nowMs: NOW,
  })
  const rows = panel.subjects[0].episodes
  assert.equal(rows.length, 3)
  assert.ok(rows.every((row) => row.qUnit === 'asset_raw'))
  assert.equal(rows.filter((row) => row.analysisPrimaryForCell).length, 1)
  assert.equal(rows.find((row) => row.analysisPrimaryForCell).lane, 'v3')
  assert.equal(rows.find((row) => row.lane === 'v3').plannedHorizonHours, 1)
  assert.equal(rows.find((row) => row.lane === 'v3').leadAtIssueMinutes, 40)
  assert.equal(rows.find((row) => row.lane === 'v3').targetClockBasis, 'parent_baseline_plan')
  assert.equal(panel.summary.issueClusters, 1)
  assert.equal(panel.summary.simulatedOnsetIssueClusters, 0)
})

test('an unavailable newer sidecar cannot suppress a measured parent cell', () => {
  const issue = parent()
  const v3 = {
    sequence: 1,
    sha256: hash('unavailable-v3'),
    marketKey: 'aaveV3Usdc',
    routeKey: AAVE.route_key,
    destination: AAVE.destination,
    originalAsset: AAVE.asset,
    v1IssueSequence: 1,
    v1IssueSha256: issue.sha256,
    holder: issue.candidate.holder,
    selectedHolderCommitment: hash(`${AAVE.destination}:${issue.candidate.holder}`),
    issuedAtUtc: ISSUE_AT,
    targets: issue.targets,
    cases: [{ label: 'fixed_1_usdc', assetsRaw: '1000000', status: 'unavailable' }],
  }
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    v1Scores: [score(issue)],
    v3Issues: [v3],
    nowMs: NOW,
  })
  assert.equal(panel.subjects[0].episodes.find((row) => row.analysisPrimaryForCell).lane, 'v1')
  assert.equal(panel.summary.clustersWithObservedCallableAndNoObservedOnset, 1)
})

test('an unscored newer sidecar cannot suppress a scored parent outcome', () => {
  const issue = parent()
  const v3 = {
    sequence: 1,
    sha256: hash('pending-v3'),
    marketKey: 'aaveV3Usdc',
    routeKey: AAVE.route_key,
    destination: AAVE.destination,
    originalAsset: AAVE.asset,
    v1IssueSequence: 1,
    v1IssueSha256: issue.sha256,
    holder: issue.candidate.holder,
    selectedHolderCommitment: hash(`${AAVE.destination}:${issue.candidate.holder}`),
    issuedAtUtc: ISSUE_AT,
    targets: issue.targets,
    cases: [
      {
        label: 'fixed_1_usdc',
        assetsRaw: '1000000',
        status: 'measured',
        measurement: { baselineStatus: 'success' },
      },
    ],
  }
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    v1Scores: [score(issue)],
    v3Issues: [v3],
    nowMs: NOW,
  })
  assert.equal(panel.subjects[0].episodes.find((row) => row.analysisPrimaryForCell).lane, 'v1')
  assert.equal(panel.summary.clustersWithObservedCallableAndNoObservedOnset, 1)
})

test('impaired and censored results stay distinct and cannot become mined payment', () => {
  const issue = parent()
  const v2 = {
    sequence: 1,
    sha256: hash('v2'),
    marketKey: 'aaveV3Usdc',
    routeKey: AAVE.route_key,
    destination: AAVE.destination,
    originalAsset: AAVE.asset,
    v1IssueSequence: 1,
    v1IssueSha256: issue.sha256,
    holder: issue.candidate.holder,
    issuedAtUtc: ISSUE_AT,
    targets: issue.targets,
    cases: [{ label: 'one', assetsRaw: '1000000', baselineStatus: 'success' }],
  }
  const measured = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    v2Issues: [v2],
    v2Scores: [
      {
        issueSequence: 1,
        issueSha256: v2.sha256,
        horizonHours: 1,
        sha256: hash('measured'),
        scoredAtUtc: SCORE_AT,
        status: 'measured',
        target: { targetBlockAt: TARGET_AT },
        cases: [{ label: 'one', status: 'measured', transition: 'lost_exitability' }],
      },
    ],
    nowMs: NOW,
  })
  assert.equal(measured.summary.simulatedOnsetIssueClusters, 1)
  assert.equal(
    measured.subjects[0].episodes.find((row) => row.lane === 'v2').outcome.status,
    'simulated_impaired',
  )
  const censored = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    v2Issues: [v2],
    v2Scores: [
      {
        issueSequence: 1,
        issueSha256: v2.sha256,
        horizonHours: 1,
        sha256: hash('censored'),
        scoredAtUtc: SCORE_AT,
        status: 'censored',
        target: null,
        cases: [],
      },
    ],
    nowMs: NOW,
  })
  assert.equal(censored.summary.simulatedOnsetIssueClusters, 0)
  assert.equal(
    censored.subjects[0].episodes.find((row) => row.lane === 'v2').outcome.status,
    'censored',
  )
  assert.equal(censored.summary.minedFinalAssetPayouts, 0)
})

test('no-holder Aave issue remains a diagnostic rather than a holder episode', () => {
  const issue = parent(1, [
    {
      label: 'one',
      assetsRaw: '1000000',
      status: 'unavailable',
      measurement: null,
    },
  ])
  issue.candidate = { holder: null, status: 'unavailable' }
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [issue],
    nowMs: NOW,
  })
  assert.equal(panel.subjects[0].episodes.length, 1)
  assert.equal(panel.subjects[0].episodes[0].holderCommitment, null)
  assert.equal(panel.subjects[0].episodes[0].outcome.status, 'not_at_risk')
  assert.equal(panel.summary.issueClusters, 0)
})

test('verified cash adapter preserves source receipt and reconstruction type', async () => {
  const issue = parent()
  const cash = (collectionMode, sequence) => ({
    sha256: hash(`receipt-${sequence}`),
    collectionMode,
    block: '99',
    blockHash: `0x${'2'.repeat(64)}`,
    blockAt: '2026-10-03T23:59:00.000Z',
    firstLocalReceiptAt: '2026-10-04T00:05:00.000Z',
    rows: [
      { routeKey: 'unassessed', destination: address(999), asset: null, state: 'unassessed' },
      {
        routeKey: AAVE.route_key,
        destination: AAVE.destination,
        asset: AAVE.asset,
        state: 'observed',
        cashRaw: '5000000',
      },
    ],
  })
  const features = cashFeaturesFromVerifiedRecords(
    [cash('current', 1), cash('retrospective', 2)],
    AAVE,
  )
  assert.equal(features.length, 2)
  const readerOptions = {
    nowMs: NOW,
    manifestLoader: async () => manifest(),
    v1IssueLoader: async () => [issue],
    v1ScoreLoader: async () => [],
    v2IssueLoader: async () => [],
    v2ScoreLoader: async () => [],
    v3IssueLoader: async () => [],
    v3ScoreLoader: async () => [],
    morphoIssueLoader: async () => [],
    morphoScoreLoader: async () => [],
    compoundIssueLoader: async () => [],
    compoundScoreLoader: async () => [],
    fluidLedgerLoader: async () =>
      FLUID_ROUTES.map((_, routeIndex) => ({ routeIndex, issues: [], scores: [] })),
    usd3IssueLoader: async () => [],
    usd3ScoreLoader: async () => [],
    stusdsIssueLoader: async () => [],
    stusdsScoreLoader: async () => [],
    susdsIssueLoader: async () => [],
    susdsScoreLoader: async () => [],
    sghoLedgerLoader: async () => ({ v1Issues: [], v1Scores: [], v2Issues: [], v2Scores: [] }),
    umbrellaLedgerLoader: async () => ({ issues: [], scores: [], attempts: [] }),
    apyUsdIssueLoader: async () => [],
    apyUsdScoreLoader: async () => [],
    stakedUsdatLedgerLoader: async () => ({ issues: [], scores: [], attempts: [] }),
    fluidBridgeUsdcLedgerLoader: async () => ({ issues: [], scores: [], attempts: [] }),
    fluidBridgeUsdtLedgerLoader: async () => ({ issues: [], scores: [], attempts: [] }),
    pyUsdStakingLedgerLoader: async () => ({ issues: [], scores: [], attempts: [] }),
    twynePtLedgerLoader: async () => ({ issues: [], scores: [], attempts: [] }),
    susdePendingIssueLoader: async () => [],
    susdePendingScoreLoader: async () => [],
    susdePayoutLoader: async () => [],
    cashLoader: async () => [cash('current', 1), cash('retrospective', 2)],
    directFlowFeatureLoader: async () => ({
      features: [
        feature(99, {
          kind: 'gross_supplier_withdraw_24h',
          collectionMode: 'historical_preissue',
          receiptSha256: hash('bound-direct-flow-window'),
          valueRaw: '123000000',
        }),
      ],
    }),
  }
  const panel = await readVerifiedHolderExitEpisodePanel(readerOptions)
  assert.equal(panel.subjects[0].episodes[0].featureRefs[0].valueRaw, '5000000')
  assert.equal(panel.subjects[0].episodes[0].featureRefs[1].kind, 'gross_supplier_withdraw_24h')
  assert.equal(panel.subjects[0].episodes[0].featureRefs[1].valueRaw, '123000000')
  assert.deepEqual(panel.subjects[0].episodes[0].featureAbstentions, {
    reconstructed_not_issue_time_current: 1,
  })
  assert.equal(panel.sourceVerification, 'caller_supplied')
  assert.equal(panel.forecastValidated, false)
  assert.deepEqual(panel.clockProofOverlay, {
    submitted: 0,
    duplicateKeys: 0,
    verifiedKeys: 0,
    witnessedIssueRows: 0,
    witnessedScoreRows: 0,
    independentUtcWitnesses: 0,
  })
  assert.equal(panel.subjects[0].episodes[0].scoreClock, 'local_operator_clock_unwitnessed')
  const withUnverifiedProof = await readVerifiedHolderExitEpisodePanel({
    ...readerOptions,
    clockProofsLoader: async () => [
      {
        kind: 'issue',
        artifactPath: '/nonexistent/issue.json',
        recordSha256: issue.sha256,
        subject: panel.subjects[0].episodes[0].subject,
        stageScope: panel.subjects[0].episodes[0].stageScope,
        targetAtUtc: panel.subjects[0].episodes[0].targetAtUtc,
      },
    ],
  })
  assert.equal(withUnverifiedProof.clockProofOverlay.submitted, 1)
  assert.equal(
    withUnverifiedProof.subjects[0].episodes[0].issueClock,
    'local_operator_clock_unwitnessed',
  )

  const issueWithSnapshot = {
    ...issue,
    flowSnapshot: { sourceBaselineAncestry: 'unproven' },
  }
  const frozenSupply = feature(99, {
    kind: 'gross_supplier_supply_24h',
    collectionMode: 'historical_preissue',
    receiptSha256: hash('issue-bound-supply'),
    valueRaw: '45000000',
    clockBasis: 'local_operator_clock_unwitnessed',
  })
  const withVerifiedFlow = await readVerifiedHolderExitEpisodePanel({
    ...readerOptions,
    v1IssueLoader: async () => [issueWithSnapshot],
    issueFlowReplayLoader: async (record) => {
      assert.equal(record.sha256, issue.sha256)
      return { features: [frozenSupply], status: 'verified', reason: null }
    },
  })
  assert.deepEqual(withVerifiedFlow.directFlowReplay, {
    issuesWithSnapshot: 1,
    verifiedIssues: 1,
    unavailableByReason: {},
    joinedFeatures: 1,
  })
  assert.equal(
    withVerifiedFlow.subjects[0].episodes[0].featureRefs.find(
      (row) => row.kind === 'gross_supplier_supply_24h',
    ).valueRaw,
    '45000000',
  )
  assert.equal(
    withVerifiedFlow.subjects[0].episodes[0].featureRefs.find(
      (row) => row.kind === 'gross_supplier_supply_24h',
    ).sourceBaselineAncestry,
    'unproven',
  )
  assert.equal(
    withVerifiedFlow.subjects[0].episodes[0].featureRefs.find(
      (row) => row.kind === 'gross_supplier_supply_24h',
    ).clockBasis,
    'local_operator_clock_unwitnessed',
  )

  const withoutPinnedFiles = await readVerifiedHolderExitEpisodePanel({
    ...readerOptions,
    v1IssueLoader: async () => [issueWithSnapshot],
    issueFlowReplayLoader: async () => ({
      features: [],
      status: 'unavailable',
      reason: 'pinned_direct_flow_evidence_missing',
    }),
  })
  assert.deepEqual(withoutPinnedFiles.directFlowReplay, {
    issuesWithSnapshot: 1,
    verifiedIssues: 0,
    unavailableByReason: { pinned_direct_flow_evidence_missing: 1 },
    joinedFeatures: 0,
  })
  assert.equal(
    withoutPinnedFiles.subjects[0].episodes[0].featureRefs.some(
      (row) => row.kind === 'gross_supplier_supply_24h',
    ),
    false,
  )
})

test('issue-bound flow joins only its sealed parent issue', () => {
  const first = parent(1)
  const second = parent(2)
  const frozenFlow = feature(99, {
    kind: 'gross_supplier_withdraw_24h',
    collectionMode: 'historical_preissue',
    receiptSha256: hash('issue-one-flow'),
    valueRaw: '123000000',
  })
  const panel = buildHolderExitEpisodePanel({
    manifest: manifest(),
    v1Issues: [first, second],
    issueFlowFeaturesBySha: new Map([[first.sha256, [frozenFlow]]]),
    nowMs: NOW,
  })
  const episodes = panel.subjects[0].episodes
  assert.equal(
    episodes.find((row) => row.issueSha256 === first.sha256).featureRefs[0].valueRaw,
    '123000000',
  )
  assert.equal(episodes.find((row) => row.issueSha256 === second.sha256).featureRefs.length, 0)
  assert.equal(panel.forecastValidated, false)
})

function morphoIssue(overrides = {}) {
  const route = BOARD_ROUTES[0]
  const holder = address(701)
  return {
    sequence: 1,
    sha256: hash('morpho-issue'),
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    status: 'issued',
    holder,
    candidate: {
      evidenceDoc: { selectedHolderCommitment: hash(`${route.destination}:${holder}`) },
    },
    baseline: {
      routeKey: route.routeKey,
      destination: route.destination,
      asset: route.asset,
      targetBlock: '100',
      targetHash: `0x${'1'.repeat(64)}`,
      targetBlockAt: BASELINE_AT,
    },
    issuedAtUtc: ISSUE_AT,
    cases: [
      {
        label: 'holder_small_sentinel',
        assetsRaw: '1000000',
        omittedReason: null,
        baselineStatus: 'simulated_withdraw_success',
        evidenceSha256: hash('case'),
      },
    ],
    targets: [{ horizonHours: 1, targetAtUtc: TARGET_AT, captureDeadlineUtc: DEADLINE_AT }],
    ...overrides,
  }
}

function morphoScore(issue, outcome = 'simulated_withdraw_success') {
  const row = issue.cases[0]
  return {
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    sha256: hash(`morpho-score-${outcome}`),
    caseLabel: row.label,
    assetsRaw: row.assetsRaw,
    baselineStatus: row.baselineStatus,
    caseEvidenceSha256: row.evidenceSha256,
    routeKey: issue.routeKey,
    destination: issue.destination,
    asset: issue.asset,
    holder: issue.holder,
    horizonHours: 1,
    targetAtUtc: TARGET_AT,
    captureDeadlineUtc: DEADLINE_AT,
    scoredAtUtc: SCORE_AT,
    outcome,
    transition: scoreTransition(row.baselineStatus, outcome),
    target: outcome === 'censored_capture_window_missed' ? null : { targetBlockAt: TARGET_AT },
  }
}

const morphoPanel = (issue, scoreRow, extras = {}) =>
  buildHolderExitEpisodePanel({
    manifest: manifest(),
    morphoIssues: [issue],
    morphoScores: scoreRow ? [scoreRow] : [],
    nowMs: NOW,
    ...extras,
  })

test('Morpho exact subject and score case, Q, SHA, holder, and horizon binding reject forgeries', () => {
  const issue = morphoIssue()
  const scored = morphoScore(issue)
  const valid = morphoPanel(issue, scored)
  const row = valid.subjects.find((s) => s.destination === issue.destination).episodes[0]
  assert.equal(valid.summary.morphoFrozenSubjects, 49)
  assert.equal(valid.summary.morphoSubjectsWithEpisodes, 1)
  assert.equal(valid.summary.morphoSubjectsWithMeasuredBaseline, 1)
  assert.equal(row.outcome.status, 'simulated_callable')
  assert.equal(row.rawScoreTransition, 'simulated_continuity')
  assert.equal(row.qUnit, 'asset_raw')
  assert.equal(row.forecastEligible, false)
  assert.equal(valid.holderExecutableExit, false)
  assert.equal(valid.summary.minedFinalAssetPayouts, 0)
  for (const change of [
    { issueSha256: hash('forged') },
    { caseLabel: 'forged' },
    { assetsRaw: '2' },
    { holder: address(888) },
    { horizonHours: 2 },
    { destination: address(888) },
  ])
    assert.throws(
      () => morphoPanel(issue, { ...scored, ...change }),
      /holder_episode_panel_morpho_/,
    )
  assert.throws(
    () => morphoPanel({ ...issue, asset: address(888) }, scored),
    /holder_episode_panel_morpho_/,
  )
})

test('Morpho no-holder stays a subject diagnostic; unavailable, missing and censor stay distinct', () => {
  const issue = morphoIssue()
  const noHolder = morphoIssue({ status: 'no_holder', holder: null, cases: [] })
  const noHolderPanel = morphoPanel(noHolder)
  const subject = noHolderPanel.subjects.find((s) => s.destination === issue.destination)
  assert.equal(subject.episodes.length, 0)
  assert.equal(subject.morphoIssueDiagnostics.noHolderIssues, 1)
  assert.equal(noHolderPanel.summary.issueClusters, 0)

  const unavailable = morphoIssue({
    status: 'baseline_unavailable',
    cases: [
      {
        ...issue.cases[0],
        baselineStatus: 'unavailable',
        evidenceSha256: null,
      },
    ],
  })
  const unavailablePanel = morphoPanel(unavailable)
  assert.equal(
    unavailablePanel.subjects.find((s) => s.destination === issue.destination).episodes[0].outcome
      .status,
    'not_at_risk',
  )
  assert.equal(unavailablePanel.summary.morphoSubjectsWithEpisodes, 1)
  assert.equal(unavailablePanel.summary.morphoSubjectsWithMeasuredBaseline, 0)
  assert.equal(unavailablePanel.summary.measuredBaselineIssueClusters, 0)
  assert.equal(
    morphoPanel(issue, null, { nowMs: Date.parse('2026-10-04T03:00:00.000Z') }).subjects.find(
      (s) => s.destination === issue.destination,
    ).episodes[0].outcome.status,
    'missing',
  )
  assert.equal(
    morphoPanel(issue, morphoScore(issue, 'censored_capture_window_missed')).subjects.find(
      (s) => s.destination === issue.destination,
    ).episodes[0].outcome.status,
    'censored',
  )
})

test('Morpho preview gap and uncertain revert do not become simulated impairment', () => {
  const issue = morphoIssue()
  for (const outcome of ['preview_gap', 'inconclusive_revert', 'covered_revert_cause_unknown']) {
    const row = morphoPanel(issue, morphoScore(issue, outcome)).subjects.find(
      (s) => s.destination === issue.destination,
    ).episodes[0]
    assert.equal(row.outcome.status, 'inconclusive')
    assert.equal(row.rawScoreOutcome, outcome)
  }
  const attrition = morphoPanel(issue, morphoScore(issue, 'holder_attrition')).subjects.find(
    (s) => s.destination === issue.destination,
  ).episodes[0]
  assert.equal(attrition.outcome.status, 'censored')
  const impaired = morphoIssue({
    status: 'baseline_unavailable',
    cases: [
      {
        ...issue.cases[0],
        baselineStatus: 'baseline_revert',
      },
    ],
  })
  const recovery = morphoPanel(impaired, morphoScore(impaired)).subjects.find(
    (s) => s.destination === issue.destination,
  ).episodes[0]
  assert.equal(recovery.baseline, 'simulated_impaired')
  assert.equal(recovery.outcome.status, 'simulated_callable')
  assert.equal(recovery.rawScoreTransition, 'simulated_recovery')
})

test('Morpho feature join accepts only recent pre-issue cash and records stale or late abstentions', () => {
  const issue = morphoIssue()
  const base = feature(99, {
    routeKey: issue.routeKey,
    destination: issue.destination,
    asset: issue.asset,
  })
  const panel = morphoPanel(issue, null, {
    features: [
      base,
      {
        ...base,
        receiptSha256: hash('stale'),
        sourceBlock: '98',
        sourceAt: '2026-10-03T20:00:00.000Z',
      },
      {
        ...base,
        receiptSha256: hash('late'),
        sourceBlock: '97',
        firstLocalReceiptAt: '2026-10-04T00:11:00.000Z',
      },
      {
        ...base,
        receiptSha256: hash('backfill'),
        sourceBlock: '96',
        collectionMode: 'retrospective',
      },
    ],
  })
  const row = panel.subjects.find((s) => s.destination === issue.destination).episodes[0]
  assert.equal(row.featureRefs.length, 1)
  assert.deepEqual(row.featureAbstentions, {
    stale_current_cash: 1,
    late_first_local_receipt: 1,
    reconstructed_not_issue_time_current: 1,
  })
})

test('Morpho retrospective cutoff hides future issues and scores after validating the complete ledger', () => {
  const issue = morphoIssue()
  const score = morphoScore(issue)
  const subjectFor = (panel) => panel.subjects.find((s) => s.destination === issue.destination)
  const beforeIssue = morphoPanel(issue, score, { nowMs: Date.parse(ISSUE_AT) - 1 })
  assert.equal(subjectFor(beforeIssue).episodes.length, 0)
  assert.deepEqual(subjectFor(beforeIssue).morphoIssueDiagnostics, {
    issues: 0,
    noHolderIssues: 0,
    baselineUnavailableIssues: 0,
    issuedIssues: 0,
  })
  let featureJoins = 0
  const direct = buildMorphoV2Episodes({
    manifest: manifest(),
    issues: [issue],
    scores: [score],
    nowMs: Date.parse(ISSUE_AT) - 1,
    selectAsOfFeatures: () => {
      featureJoins++
      return { featureRefs: [], featureAbstentions: {} }
    },
  })
  assert.equal(direct.episodes.length, 0)
  assert.equal(featureJoins, 0)
  const noHolder = morphoIssue({ status: 'no_holder', holder: null, cases: [] })
  assert.equal(
    subjectFor(morphoPanel(noHolder, null, { nowMs: Date.parse(ISSUE_AT) - 1 }))
      .morphoIssueDiagnostics.noHolderIssues,
    0,
  )
  assert.equal(
    subjectFor(morphoPanel(noHolder, null, { nowMs: Date.parse(ISSUE_AT) })).morphoIssueDiagnostics
      .noHolderIssues,
    1,
  )

  const beforeScore = morphoPanel(issue, score, { nowMs: Date.parse(SCORE_AT) - 1 })
  const hidden = subjectFor(beforeScore).episodes[0]
  assert.equal(hidden.scoreSha256, null)
  assert.equal(hidden.observedAtUtc, null)
  assert.equal(hidden.rawScoreOutcome, null)
  assert.equal(hidden.rawScoreTransition, null)
  assert.deepEqual(hidden.outcome, { status: 'pending', reason: null })
  assert.equal(subjectFor(beforeScore).morphoIssueDiagnostics.issuedIssues, 1)

  const atScore = subjectFor(morphoPanel(issue, score, { nowMs: Date.parse(SCORE_AT) })).episodes[0]
  assert.equal(atScore.scoreSha256, score.sha256)
  assert.equal(atScore.observedAtUtc, TARGET_AT)
  assert.equal(atScore.rawScoreTransition, 'simulated_continuity')
  assert.equal(atScore.outcome.status, 'simulated_callable')

  assert.throws(
    () =>
      morphoPanel(issue, { ...score, holder: address(999) }, { nowMs: Date.parse(SCORE_AT) - 1 }),
    /holder_episode_panel_morpho_score_binding_invalid/,
  )
  assert.throws(
    () =>
      morphoPanel(issue, { ...score, scoredAtUtc: 'invalid' }, { nowMs: Date.parse(SCORE_AT) - 1 }),
    /holder_episode_panel_morpho_clock_invalid/,
  )
  assert.throws(
    () =>
      morphoPanel(
        { ...issue, candidate: { evidenceDoc: { selectedHolderCommitment: hash('wrong') } } },
        null,
        { nowMs: Date.parse(ISSUE_AT) - 1 },
      ),
    /holder_episode_panel_morpho_holder_invalid/,
  )
})

function directVaultIssue(route, lane, caseStatus = 'success', holder = address(700)) {
  const cases = Array.from({ length: 6 }, (_, i) => ({
    label: `q${i}`,
    assetsRaw: String((i + 1) * 1_000_000),
    status: holder ? 'measured' : 'unavailable',
    reason: holder ? null : 'baseline_measurement_unavailable',
    measurement: holder ? { baselineStatus: caseStatus } : null,
  }))
  const payload = {
    study: `carry_public_${lane}_exit_issue_v1`,
    sequence: 1,
    routeKey: route.routeKey,
    destination: route.destination,
    originalAsset: route.asset,
    issuedAtUtc: ISSUE_AT,
    baseline: { targetBlock: '100', targetHash: `0x${'1'.repeat(64)}`, targetBlockAt: BASELINE_AT },
    candidate: { holder },
    cases,
    targets: [1, 4, 24, 48, 168].map((horizonHours) => ({
      horizonHours,
      targetAtUtc: new Date(Date.parse(ISSUE_AT) + horizonHours * 3_600_000).toISOString(),
      captureDeadlineUtc: new Date(
        Date.parse(ISSUE_AT) + (horizonHours + 2) * 3_600_000,
      ).toISOString(),
    })),
  }
  return { ...payload, sha256: hash(JSON.stringify(payload)) }
}

function directVaultScore(issue, lane, outcome = 'simulated_withdraw_success') {
  const payload = {
    study: `carry_public_${lane}_exit_score_v1`,
    issueSequence: issue.sequence,
    issueSha256: issue.sha256,
    routeKey: issue.routeKey,
    destination: issue.destination,
    originalAsset: issue.originalAsset,
    holder: issue.candidate.holder,
    horizonHours: 1,
    targetAtUtc: issue.targets[0].targetAtUtc,
    captureDeadlineUtc: issue.targets[0].captureDeadlineUtc,
    scoredAtUtc: new Date(Date.parse(issue.targets[0].targetAtUtc) + 5 * 60_000).toISOString(),
    target: { targetHash: `0x${'2'.repeat(64)}`, targetBlockAt: issue.targets[0].targetAtUtc },
    cases: issue.cases.map((row) => ({
      label: row.label,
      assetsRaw: row.assetsRaw,
      status: 'measured',
      outcome,
    })),
  }
  return { ...payload, sha256: hash(JSON.stringify(payload)) }
}

function directVaultPanel(lane, issue, scoreRow, nowMs = NOW) {
  return buildHolderExitEpisodePanel({
    manifest: manifest(),
    directVaultLedgers: [
      { lane, issues: [issue], scores: scoreRow ? [scoreRow] : [] },
      ...['usd3', 'stusds', 'susds']
        .filter((other) => other !== lane)
        .map((other) => ({ lane: other, issues: [], scores: [] })),
    ],
    nowMs,
  })
}

test('direct vault cells bind three distinct frozen routes and retain eth_call limits', () => {
  for (const [lane, route] of [
    ['usd3', USD3_ROUTE],
    ['stusds', STUSDS_ROUTE],
    ['susds', SUSDS_ROUTE],
  ]) {
    const issue = directVaultIssue(route, lane)
    const scoreRow = directVaultScore(issue, lane)
    const panel = directVaultPanel(lane, issue, scoreRow)
    const subject = panel.subjects.find((row) => row.routeKey === route.routeKey)
    assert.equal(subject.episodes.length, 30)
    assert.equal(subject.stageScope, `direct_${lane}_withdraw_eth_call`)
    assert.equal(subject.episodes[0].issueSha256, issue.sha256)
    assert.equal(subject.episodes[0].scoreSha256, scoreRow.sha256)
    assert.equal(subject.episodes[0].qRaw, '1000000')
    assert.equal(subject.episodes[0].qUnit, 'asset_raw')
    assert.equal(subject.episodes[0].targetClockBasis, 'issue_plan')
    assert.equal(subject.episodes[0].leadAtIssueMinutes, 60)
    assert.equal(subject.episodes[0].outcome.status, 'simulated_callable')
    assert.equal(subject.episodes[0].fullRoutePaidProofSha256, null)
    assert.equal(subject.episodes[0].forecastEligible, false)
    assert.equal(panel.summary.calibratedDurationEpisodes, 0)
    assert.equal(panel.summary.minedFinalAssetPayouts, 0)
    assert.equal(panel.summary.routeGroups, 25)
    assert.equal(panel.summary.exactSubjects, 67)
    assert.throws(
      () => directVaultPanel(lane, { ...issue, originalAsset: address(1) }, scoreRow),
      /direct_vault_issue_identity_invalid/,
    )
    assert.throws(
      () => directVaultPanel(lane, issue, { ...scoreRow, holder: address(9) }),
      /direct_vault_score_binding_invalid/,
    )
    const wrongQ = {
      ...scoreRow,
      cases: [{ ...scoreRow.cases[0], assetsRaw: '2' }, ...scoreRow.cases.slice(1)],
    }
    wrongQ.sha256 = hash(
      JSON.stringify(Object.fromEntries(Object.entries(wrongQ).filter(([k]) => k !== 'sha256'))),
    )
    assert.throws(
      () => directVaultPanel(lane, issue, wrongQ),
      /direct_vault_score_q_binding_invalid/,
    )
  }
})

test('direct-vault issue and score clocks gate rows, diagnostics and raw scores', () => {
  for (const [lane, route] of [
    ['usd3', USD3_ROUTE],
    ['stusds', STUSDS_ROUTE],
    ['susds', SUSDS_ROUTE],
  ]) {
    const issue = directVaultIssue(route, lane)
    const scored = directVaultScore(issue, lane)
    const subject = (nowMs, scoreRow = scored) =>
      directVaultPanel(lane, issue, scoreRow, nowMs).subjects.find(
        (row) => row.routeKey === route.routeKey,
      )
    const beforeIssue = subject(Date.parse(issue.issuedAtUtc) - 1)
    assert.equal(beforeIssue.episodes.length, 0)
    assert.deepEqual(beforeIssue.directVaultIssueDiagnostics, {
      issues: 0,
      noHolderIssues: 0,
      omittedQCases: 0,
      scoredTargets: 0,
    })
    const atIssue = subject(Date.parse(issue.issuedAtUtc))
    assert.equal(atIssue.episodes.length, 30)
    assert.equal(atIssue.directVaultIssueDiagnostics.issues, 1)
    assert.equal(atIssue.directVaultIssueDiagnostics.scoredTargets, 0)

    const beforeScore = subject(Date.parse(scored.scoredAtUtc) - 1)
    assert.equal(beforeScore.episodes[0].outcome.status, 'pending')
    assert.equal(beforeScore.episodes[0].scoreSha256, null)
    assert.equal(beforeScore.episodes[0].observedAtUtc, null)
    assert.equal(beforeScore.episodes[0].rawScoreStatus, null)
    assert.equal(beforeScore.episodes[0].rawScoreOutcome, null)
    assert.equal(beforeScore.directVaultIssueDiagnostics.scoredTargets, 0)

    const atScore = subject(Date.parse(scored.scoredAtUtc))
    assert.equal(atScore.episodes[0].outcome.status, 'simulated_callable')
    assert.equal(atScore.episodes[0].scoreSha256, scored.sha256)
    assert.equal(atScore.episodes[0].rawScoreOutcome, 'simulated_withdraw_success')
    assert.equal(atScore.directVaultIssueDiagnostics.scoredTargets, 1)
    assert.equal(atScore.episodes[0].issueClock, 'local_operator_clock_unwitnessed')
    assert.equal(atScore.episodes[0].forecastEligible, false)
    assert.throws(
      () => subject(Date.parse(issue.issuedAtUtc) - 1, { ...scored, holder: address(9) }),
      /direct_vault_score_binding_invalid/,
    )
    assert.throws(
      () => subject(Date.parse(issue.issuedAtUtc) - 1, { ...scored, scoredAtUtc: 'invalid' }),
      /direct_vault_clock_invalid/,
    )
  }
  const noHolder = directVaultIssue(USD3_ROUTE, 'usd3', 'success', null)
  const before = directVaultPanel(
    'usd3',
    noHolder,
    null,
    Date.parse(noHolder.issuedAtUtc) - 1,
  ).subjects.find((row) => row.routeKey === USD3_ROUTE.routeKey)
  const after = directVaultPanel(
    'usd3',
    noHolder,
    null,
    Date.parse(noHolder.issuedAtUtc),
  ).subjects.find((row) => row.routeKey === USD3_ROUTE.routeKey)
  assert.equal(before.directVaultIssueDiagnostics.noHolderIssues, 0)
  assert.equal(after.directVaultIssueDiagnostics.noHolderIssues, 1)
})

test('direct vault statuses keep no-holder, unavailable, pending, missing, censor and unknown distinct', () => {
  const route = USD3_ROUTE
  const noHolder = directVaultIssue(route, 'usd3', 'success', null)
  const noHolderSubject = directVaultPanel('usd3', noHolder, null).subjects.find(
    (s) => s.routeKey === route.routeKey,
  )
  assert.equal(noHolderSubject.episodes.length, 0)
  assert.equal(noHolderSubject.directVaultIssueDiagnostics.noHolderIssues, 1)
  const issue = directVaultIssue(route, 'usd3')
  const episodes = (scoreRow, nowMs = NOW) =>
    directVaultPanel('usd3', issue, scoreRow, nowMs).subjects.find(
      (s) => s.routeKey === route.routeKey,
    ).episodes[0]
  assert.equal(episodes(null).outcome.status, 'pending')
  assert.equal(
    episodes(null, Date.parse(issue.targets[0].captureDeadlineUtc) + 1).outcome.status,
    'missing',
  )
  for (const [raw, expected] of [
    ['holder_shares_zero', 'censored'],
    ['preview_share_gap', 'inconclusive'],
    ['withdraw_revert_cause_unknown', 'inconclusive'],
  ])
    assert.equal(episodes(directVaultScore(issue, 'usd3', raw)).outcome.status, expected)
  const missed = directVaultScore(issue, 'usd3')
  missed.cases = missed.cases.map((row) => ({ ...row, status: 'unavailable', outcome: null }))
  missed.sha256 = hash(
    JSON.stringify(Object.fromEntries(Object.entries(missed).filter(([k]) => k !== 'sha256'))),
  )
  assert.equal(episodes(missed).outcome.status, 'censored')
  const unavailable = directVaultIssue(route, 'usd3')
  unavailable.cases[0] = {
    ...unavailable.cases[0],
    status: 'unavailable',
    reason: 'baseline_measurement_unavailable',
    measurement: null,
  }
  unavailable.sha256 = hash(
    JSON.stringify(Object.fromEntries(Object.entries(unavailable).filter(([k]) => k !== 'sha256'))),
  )
  assert.equal(
    directVaultPanel('usd3', unavailable, null).subjects.find((s) => s.routeKey === route.routeKey)
      .episodes[0].baseline,
    'unavailable',
  )
})

test('omitted direct-vault Q cases stay diagnostic instead of becoming Q horizon rows', () => {
  const issue = directVaultIssue(USD3_ROUTE, 'usd3')
  issue.cases[5] = {
    ...issue.cases[5],
    assetsRaw: null,
    status: 'omitted',
    reason: 'q_unavailable',
    measurement: null,
  }
  issue.sha256 = hash(
    JSON.stringify(Object.fromEntries(Object.entries(issue).filter(([key]) => key !== 'sha256'))),
  )
  const subject = directVaultPanel('usd3', issue, null).subjects.find(
    (row) => row.routeKey === USD3_ROUTE.routeKey,
  )
  assert.equal(subject.episodes.length, 25)
  assert.equal(
    subject.episodes.some((row) => row.qRaw === null),
    false,
  )
  assert.equal(subject.directVaultIssueDiagnostics.omittedQCases, 1)
})
