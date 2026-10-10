import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  abstainUntrackedSubject,
  buildHolderExitForceabilityMatrix,
  readSavedMorphoStableReverts,
  summarizeHistoricalReceiptTiming,
} from './holder-exit-forceability-matrix.mjs'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { historicalProcessingWithin24h } from './holder-exit-processing-bounds.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import { diagnoseSaturnQueueProcessing } from './saturn-queue-processing-backtest.mjs'

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const manifest = {
  sha256: 'pinned',
  subjects: Array.from({ length: 67 }, (_, n) => ({
    route_key: `route-${Math.min(n, 24)}`,
    destination: address(n + 1),
    asset: address(n + 101),
  })),
  supplementalSubjects: [{ route_key: 'future', destination: address(900), asset: address(901) }],
}
const mechanismCatalog = {
  version: 'test',
  subjects: 67,
  routes: Array.from({ length: 25 }, (_, n) => ({
    routeKey: `route-${n}`,
    mechanism: n === 0 ? 'staged' : 'atomic',
  })),
  subjectSpecs: manifest.subjects.map((s) => ({
    routeKey: s.route_key,
    destinationAddress: s.destination,
  })),
}
const emptyStage = (s) => ({
  routeKey: s.route_key,
  destination: s.destination,
  originalAsset: s.asset,
  verifiedIssues: 0,
  verifiedScores: 0,
  stages: {},
  minedDeliveryAttestations: 0,
  sameEpisodePaidExitProofs: 0,
  calibratedImpairmentDurations: 0,
})
const stages = {
  frozenGroups: 25,
  frozenSubjects: 67,
  subjects: manifest.subjects.map(emptyStage),
}
const support = {
  denominator: { routeGroups: 25, exactSubjects: 67 },
  groups: Array.from({ length: 25 }, (_, n) => ({
    routeKey: `route-${n}`,
    total: n === 24 ? 43 : 1,
    withIssue: 0,
  })),
  cells: [],
}
const clone = (x) => structuredClone(x)
const matrix = (overrides = {}) =>
  buildHolderExitForceabilityMatrix({ manifest, support, stages, mechanismCatalog, ...overrides })

const supplierRoute = (kind, routeKey) =>
  CARRY_EXIT_V2_FROZEN_ROUTES.find((row) => row.kind === kind && row.routeKey === routeKey)
const supplierRoutes = {
  aaveV3Usdc: supplierRoute('aave', 'USDC → supply on Aave V3'),
  sparkLendUsdt: supplierRoute('spark', 'USDT → supply on Spark'),
  compoundV3Usdc: supplierRoute('comet', 'USDC → supply on Compound v3'),
  aaveV3Usde: supplierRoute('aave', 'USDe → supply on Aave V3'),
}
const DAY_MS = 86_400_000
const supplierObserved = (marketKey, overrides = {}) => {
  const route = supplierRoutes[marketKey]
  return {
    status: 'observed',
    marketKey,
    routeKey: route.routeKey,
    destination: route.destination,
    originalAsset: route.asset,
    cohort: marketKey === 'aaveV3Usde' ? 'supplemental_outside_frozen_25_67' : 'frozen_25_67',
    evidenceClass: 'historical_other_holder_mined_payout',
    coverage: {
      fromBlock: 100,
      throughBlock: 101,
      startMs: 0,
      endMs: 2 * DAY_MS,
      durationMs: 2 * DAY_MS,
      scope: 'selected_bounded_contiguous_suffix',
      segmentCount: 2,
      segmentSha256: ['a'.repeat(64), 'b'.repeat(64)],
    },
    classifiedReceiptPayoutCount: 5,
    sameHolderPayoutCount: 3,
    sameHolderPayoutRaw: '300',
    otherReceiverPayoutCount: 2,
    unclassifiedWithdrawalCount: 0,
    historicalMax24hGrossWithdrawal: {
      status: 'observed',
      amountRaw: '500',
      payoutCount: 5,
      startMs: 0,
      endMs: DAY_MS,
    },
    ...(marketKey === 'compoundV3Usdc'
      ? {
          historicalMax24hGrossCometWithdrawEvents: {
            status: 'observed',
            amountRaw: '900',
            eventCount: 8,
            startMs: 0,
            endMs: DAY_MS,
          },
        }
      : {}),
    sameEpisodeProspective: false,
    calibratedDuration: false,
    forecastValidated: false,
    ...overrides,
  }
}
const supplierInputs = () => {
  const inputManifest = clone(manifest)
  const inputSupport = clone(support)
  const inputStages = clone(stages)
  const inputMechanisms = clone(mechanismCatalog)
  for (const [index, marketKey] of ['aaveV3Usdc', 'sparkLendUsdt', 'compoundV3Usdc'].entries()) {
    const route = supplierRoutes[marketKey]
    const slot = index + 1
    inputManifest.subjects[slot] = {
      route_key: route.routeKey,
      destination: route.destination,
      asset: route.asset,
    }
    inputSupport.groups[slot].routeKey = route.routeKey
    inputStages.subjects[slot] = emptyStage(inputManifest.subjects[slot])
    inputMechanisms.routes[slot].routeKey = route.routeKey
    inputMechanisms.subjectSpecs[slot] = {
      routeKey: route.routeKey,
      destinationAddress: route.destination,
    }
  }
  const usde = supplierRoutes.aaveV3Usde
  inputManifest.supplementalSubjects = [
    { route_key: usde.routeKey, destination: usde.destination, asset: usde.asset },
  ]
  const spark = supplierRoutes.sparkLendUsdt
  const historicalSupplierPayoutCoverage = {
    scope: 'offline_frozen_25_67_direct_supplier_payout_inventory',
    markets: [
      supplierObserved('aaveV3Usdc'),
      {
        status: 'unavailable',
        marketKey: 'sparkLendUsdt',
        routeKey: spark.routeKey,
        destination: spark.destination,
        originalAsset: spark.asset,
        cohort: 'frozen_25_67',
        reason: 'no_sealed_segments',
        sameEpisodeProspective: false,
        calibratedDuration: false,
        forecastValidated: false,
      },
      supplierObserved('compoundV3Usdc', {
        classifiedReceiptPayoutCount: 2,
        sameHolderPayoutCount: 2,
        sameHolderPayoutRaw: '200',
        otherReceiverPayoutCount: 0,
        unclassifiedWithdrawalCount: 3,
        historicalMax24hGrossWithdrawal: {
          status: 'unavailable',
          reason: 'unclassified_withdrawals',
        },
      }),
      supplierObserved('aaveV3Usde'),
    ],
  }
  return {
    manifest: inputManifest,
    support: inputSupport,
    stages: inputStages,
    mechanismCatalog: inputMechanisms,
    historicalSupplierPayoutCoverage,
  }
}

test('frozen 25/67 stays fixed while the newer market remains supplemental', () => {
  const result = matrix()
  assert.equal(result.summary.routeGroups, 25)
  assert.equal(result.summary.exactSubjects, 67)
  assert.equal(result.summary.atomicGroups, 24)
  assert.equal(result.summary.stagedGroups, 1)
  assert.equal(result.subjects.length, 67)
  assert.equal(result.supplemental.length, 1)
  assert.equal(result.supplemental[0].scope, 'outside_frozen_25_67')
  assert.equal(result.supplemental[0].historicalSupplierPayoutEvidence, null)
  assert.equal(result.supplemental[0].forecastValidated, false)
  assert.equal(result.forecastValidated, false)
  assert.equal(result.holderExecutableExit, false)
})

test('supplier payout receipts stay distinct from direct payouts, prospective proof and Comet gross events', () => {
  const inputs = supplierInputs()
  const result = matrix(inputs)
  const aave = result.subjects[1]
  const spark = result.subjects[2]
  const compound = result.subjects[3]
  assert.equal(aave.historicalSupplierPayoutEvidence.sameHolderPayoutCount, 3)
  assert.equal(aave.historicalSupplierPayoutEvidence.coverage.fromBlock, 100)
  assert.deepEqual(aave.historicalSupplierPayoutEvidence.coverage.segmentSha256, [
    'a'.repeat(64),
    'b'.repeat(64),
  ])
  assert.equal(
    aave.historicalSupplierPayoutEvidence.historicalMax24hGrossWithdrawal.amountRaw,
    '500',
  )
  assert.equal(aave.historicalDirectFinalAssetPayoutTransactions, 0)
  assert.deepEqual(spark.historicalSupplierPayoutEvidence, {
    status: 'unavailable',
    reason: 'no_sealed_segments',
  })
  assert.equal(compound.historicalSupplierPayoutEvidence.sameHolderPayoutCount, 2)
  assert.equal(compound.historicalSupplierPayoutEvidence.unclassifiedWithdrawalCount, 3)
  assert.deepEqual(compound.historicalSupplierPayoutEvidence.historicalMax24hGrossWithdrawal, {
    status: 'unavailable',
    reason: 'unclassified_withdrawals',
  })
  assert.equal(
    compound.historicalSupplierPayoutEvidence.historicalMax24hGrossCometWithdrawEvents.amountRaw,
    '900',
  )
  assert.equal(result.summary.subjectsWithHistoricalSupplierPayoutEvidence, 2)
  assert.equal(result.summary.historicalSupplierSameHolderPayoutCount, 5)
  assert.equal(result.supplemental.length, 1)
  const aaveUsde = result.supplemental[0]
  assert.equal(aaveUsde.routeKey, supplierRoutes.aaveV3Usde.routeKey)
  assert.equal(aaveUsde.historicalSupplierPayoutEvidence.sameHolderPayoutCount, 3)
  assert.equal(aaveUsde.historicalSupplierPayoutEvidence.classifiedReceiptPayoutCount, 5)
  assert.equal(aaveUsde.historicalSupplierPayoutEvidence.holderExecutableExit, false)
  assert.equal(
    result.subjects.some((row) => row.routeKey === supplierRoutes.aaveV3Usde.routeKey),
    false,
  )
  for (const row of [aave, spark, compound, aaveUsde]) {
    assert.equal(row.terminalSameEpisodeFinalAssetPaidProof, false)
    assert.equal(row.calibratedImpairmentDuration, false)
    assert.equal(row.holderExecutableExit, false)
    assert.equal(row.forecastValidated, false)
    assert.equal(row.historicalSupplierPayoutEvidence.sameEpisodeProspective ?? false, false)
    assert.equal(row.historicalSupplierPayoutEvidence.forecastValidated ?? false, false)
  }
})

test('supplier inventory fails closed on identity, provenance and forecast claims', () => {
  const wrongAsset = supplierInputs()
  wrongAsset.historicalSupplierPayoutCoverage.markets[0].originalAsset = address(999)
  assert.throws(() => matrix(wrongAsset), /forceability_supplier_payout_identity_invalid/)
  const wrongRoute = supplierInputs()
  wrongRoute.historicalSupplierPayoutCoverage.markets[0].routeKey = 'wrong route'
  assert.throws(() => matrix(wrongRoute), /forceability_supplier_payout_identity_invalid/)
  const wrongDestination = supplierInputs()
  wrongDestination.historicalSupplierPayoutCoverage.markets[0].destination = address(999)
  assert.throws(() => matrix(wrongDestination), /forceability_supplier_payout_identity_invalid/)
  const fabricated = supplierInputs()
  fabricated.historicalSupplierPayoutCoverage.markets[1].status = 'observed'
  assert.throws(() => matrix(fabricated), /forceability_supplier_payout_observed_invalid/)
  const forecast = supplierInputs()
  forecast.historicalSupplierPayoutCoverage.markets[0].forecastValidated = true
  assert.throws(() => matrix(forecast), /forceability_supplier_payout_identity_invalid/)
  const supplemental = supplierInputs()
  supplemental.historicalSupplierPayoutCoverage.markets[3].cohort = 'frozen_25_67'
  assert.throws(() => matrix(supplemental), /forceability_supplier_payout_identity_invalid/)
})

test('stage issue and mined delivery cannot become a same-episode paid exit or duration', () => {
  const input = clone(stages)
  input.subjects[0].verifiedIssues = 4
  input.subjects[0].verifiedScores = 2
  input.subjects[0].stages = { queue_request: { verifiedIssues: 4, verifiedScores: 2 } }
  input.subjects[0].minedDeliveryAttestations = 1
  const result = matrix({ stages: input })
  const row = result.subjects[0]
  assert.equal(row.stageIssue, true)
  assert.equal(row.terminalSameEpisodeFinalAssetPaidProof, false)
  assert.equal(row.calibratedImpairmentDuration, false)
  assert.equal(row.holderExecutableExit, false)
  assert.deepEqual(row.reasons, [
    'no_same_episode_final_asset_paid_proof',
    'mined_delivery_episode_unresolved',
    'impairment_duration_uncalibrated',
    'prospective_holder_forecast_uncalibrated',
  ])
})

test('direct exact Q baseline remains distinct from paid or prospective evidence', () => {
  const input = clone(support)
  input.cells.push({
    routeKey: 'route-1',
    destination: address(2),
    asset: address(102),
    issueRecords: 3,
    baseline: { impaired: 1, control: 2 },
    impaired: { recovery: 0 },
    control: { newRevert: 0 },
  })
  input.groups[1].withIssue = 1
  const result = matrix({ support: input })
  assert.equal(result.summary.subjectsWithMeasuredDirectBaseline, 1)
  assert.equal(result.subjects[1].directIssueBaseline, true)
  assert.equal(result.subjects[1].directIssueCellObservations, 3)
  assert.equal(result.subjects[1].measuredDirectBaselineCellObservations, 3)
  assert.equal(result.subjects[1].terminalSameEpisodeFinalAssetPaidProof, false)
  assert.equal(result.subjects[1].prospectiveCalibration, false)
  assert.equal(result.subjects[1].forecastValidated, false)
})

test('verified atomic final-asset payout transactions stay separate from holder Q evidence', () => {
  const directPayouts = [
    {
      routeKey: 'route-1',
      destination: address(2),
      asset: address(102),
      reconciledTransactions: 5,
    },
  ]
  const result = matrix({ directPayouts })
  const row = result.subjects[1]
  assert.equal(row.historicalDirectFinalAssetPayoutTransactions, 5)
  assert.equal(result.summary.subjectsWithHistoricalDirectFinalAssetPayout, 1)
  assert.equal(result.summary.historicalDirectFinalAssetPayoutTransactions, 5)
  assert.equal(row.directIssueBaseline, false)
  assert.equal(row.holderExecutableExit, false)
  assert.equal(row.forecastValidated, false)
  directPayouts[0].asset = address(999)
  assert.throws(() => matrix({ directPayouts }), /forceability_direct_payout_identity_invalid/)
})

test('historical stable fixed-Q reverts are exact-subject evidence and leave prospective totals untouched', () => {
  const saved = readSavedMorphoStableReverts()
  for (const vault of [
    '0x0bf0164d17469241b6e086da4016dcc54feaa334',
    '0x35cbe8542e70fa2f7f9cdf129f19e593f4b4f560',
  ]) {
    const episode = saved.find(
      (item) => item.destination === vault && item.anchorBlock === 25400000,
    )
    assert.deepEqual(episode.sampledHours, [0, 1, 4, 24, 48, 168])
    assert.equal(episode.anchorAtUtc, '2026-06-26T06:25:47.000Z')
    assert.equal(episode.provenance, 'saved_cell_disk_integrity_only')
  }
  const subject = manifest.subjects[1]
  const one = {
    ...saved[0],
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
  }
  const result = matrix({ historicalStableReverts: [one] })
  assert.equal(result.subjects[1].historicalStableSimulatedReverts.length, 1)
  assert.equal(result.subjects[2].historicalStableSimulatedReverts.length, 0)
  assert.equal(result.subjects[1].directIssueCellObservations, 0)
  assert.equal(result.subjects[1].measuredDirectBaselineCellObservations, 0)
  assert.equal(result.subjects[1].correlatedLossCellObservations, 0)
  assert.equal(result.subjects[1].historicalDirectFinalAssetPayoutTransactions, 0)
  assert.equal(result.subjects[1].calibratedImpairmentDuration, false)
  assert.equal(result.subjects[1].forecastValidated, false)
  assert.throws(
    () => matrix({ historicalStableReverts: [one, one] }),
    /forceability_stable_history_invalid/,
  )
  assert.throws(
    () => matrix({ historicalStableReverts: [{ ...one, asset: address(999) }] }),
    /forceability_stable_history_invalid/,
  )
})

test('saved stable history rejects missing plan, duplicate cell, and broken cell hash', () => {
  const source = 'lib/carry/research/morpho-stable-exit-history-v1'
  const dir = mkdtempSync(join(tmpdir(), 'forceability-stable-'))
  try {
    assert.throws(
      () => readSavedMorphoStableReverts(dir),
      /forceability_stable_history_plan_invalid/,
    )
    const plan = readdirSync(source).find((name) => name.startsWith('plan-'))
    const cell = readdirSync(source).find((name) => name.includes('-25400000-0x0bf0164d'))
    copyFileSync(join(source, plan), join(dir, plan))
    copyFileSync(join(source, cell), join(dir, cell))
    assert.deepEqual(readSavedMorphoStableReverts(dir)[0].sampledHours, [0, 1, 4, 24, 48, 168])
    const duplicate = cell.replace(/-[0-9a-f]{64}\.json$/, `-${'0'.repeat(64)}.json`)
    copyFileSync(join(source, cell), join(dir, duplicate))
    assert.throws(() => readSavedMorphoStableReverts(dir), /cell_artifact_ambiguous/)
    rmSync(join(dir, duplicate))
    writeFileSync(
      join(dir, cell),
      readFileSync(join(dir, cell), 'utf8').replace('evm_revert', 'success'),
    )
    assert.throws(() => readSavedMorphoStableReverts(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sampled zero assets with outstanding shares is a hazard, not a holder forecast', () => {
  const subject = manifest.subjects[1]
  const sampledConditions = [
    {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      observations: [
        {
          block: 100,
          blockTime: '2026-10-01T00:00:00.000Z',
          assetsRaw: '0',
          supplyRaw: '1',
          status: 'zero_assets_positive_shares',
          evidenceSha256: 'a'.repeat(64),
        },
      ],
    },
  ]
  const result = matrix({ sampledConditions })
  const row = result.subjects[1]
  assert.equal(result.summary.subjectsWithLatestSampledZeroAssetsPositiveShares, 1)
  assert.equal(row.sampledZeroAssetsPositiveShares, true)
  assert.equal(row.sampledConditionObservations, 1)
  assert.equal(row.sampledZeroAssetHistory.spanBetweenZeroSamplesSeconds, 0)
  assert.equal(row.sampledZeroAssetHistory.continuityProven, false)
  assert.equal(row.directIssueBaseline, false)
  assert.equal(row.calibratedImpairmentDuration, false)
  assert.equal(row.forecastValidated, false)
  assert.ok(row.reasons.includes('sampled_zero_assets_positive_shares'))
  sampledConditions[0].asset = address(999)
  assert.throws(() => matrix({ sampledConditions }), /forceability_condition_identity_invalid/)
})

test('condition history brackets samples without claiming a continuous impairment', () => {
  const subject = manifest.subjects[1]
  const sample = (block, blockTime, assetsRaw, status) => ({
    block,
    blockTime,
    assetsRaw,
    supplyRaw: '1',
    status,
    evidenceSha256: 'a'.repeat(64),
  })
  const row = matrix({
    sampledConditions: [
      {
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
        observations: [
          sample(100, '2026-09-01T00:00:00.000Z', '2', 'nonzero_assets'),
          sample(110, '2026-09-02T00:00:00.000Z', '0', 'zero_assets_positive_shares'),
          sample(120, '2026-09-03T00:00:00.000Z', '0', 'zero_assets_positive_shares'),
        ],
      },
    ],
  }).subjects[1]
  assert.deepEqual(row.sampledZeroAssetHistory, {
    firstZeroSampleAt: '2026-09-02T00:00:00.000Z',
    latestZeroSampleAt: '2026-09-03T00:00:00.000Z',
    zeroSampleCount: 2,
    spanBetweenZeroSamplesSeconds: 86_400,
    lastPriorNonzeroSampleAt: '2026-09-01T00:00:00.000Z',
    continuityProven: false,
  })
  assert.equal(row.calibratedImpairmentDuration, false)
  assert.equal(row.forecastValidated, false)
})

test('rejects support asset relabel and missing stage subject', () => {
  const wrong = clone(support)
  wrong.cells.push({
    routeKey: 'route-1',
    destination: address(2),
    asset: address(999),
    issueRecords: 1,
    baseline: { impaired: 0, control: 1 },
    impaired: { recovery: 0 },
    control: { newRevert: 0 },
  })
  wrong.groups[1].withIssue = 1
  assert.throws(() => matrix({ support: wrong }), /forceability_support_identity_mismatch/)
  const missing = clone(stages)
  missing.subjects.pop()
  assert.throws(() => matrix({ stages: missing }), /forceability_stage_subject_missing/)
})

test('rejects missing support group and a staged issue relabeled as direct', () => {
  const missing = clone(support)
  missing.groups.pop()
  assert.throws(() => matrix({ support: missing }), /forceability_support_group_missing/)
  const wrong = clone(support)
  wrong.cells.push({
    routeKey: 'route-0',
    destination: address(1),
    asset: address(101),
    issueRecords: 1,
    baseline: { impaired: 0, control: 1 },
    impaired: { recovery: 0 },
    control: { newRevert: 0 },
  })
  wrong.groups[0].withIssue = 1
  assert.throws(() => matrix({ support: wrong }), /forceability_staged_direct_conflict/)
})

test('future paid proof requires a verified stage issue and mined delivery', () => {
  const malformed = clone(stages)
  malformed.subjects[0].sameEpisodePaidExitProofs = 1
  assert.throws(() => matrix({ stages: malformed }), /forceability_stage_counts_invalid/)
  malformed.subjects[0].verifiedIssues = 1
  assert.throws(() => matrix({ stages: malformed }), /forceability_stage_counts_invalid/)
})

test('one observed paid episode carries its request-to-payout sample without calibrating duration', () => {
  const input = clone(stages)
  input.subjects[0].verifiedIssues = 1
  input.subjects[0].minedDeliveryAttestations = 1
  input.subjects[0].sameEpisodePaidExitProofs = 1
  input.subjects[0].observedRequestToPayoutSeconds = [86_436]
  const row = matrix({ stages: input }).subjects[0]
  assert.deepEqual(row.observedRequestToPayoutSeconds, [86_436])
  assert.equal(row.terminalSameEpisodeFinalAssetPaidProofs, 1)
  assert.equal(row.calibratedImpairmentDuration, false)
  assert.equal(row.forecastValidated, false)
  input.subjects[0].verifiedIssues = 2
  input.subjects[0].minedDeliveryAttestations = 2
  input.subjects[0].sameEpisodePaidExitProofs = 2
  input.subjects[0].observedRequestToPayoutSeconds = [86_436, 92_628]
  const report = matrix({ stages: input })
  assert.equal(report.summary.subjectsWithSameEpisodeFinalAssetPaidProof, 1)
  assert.equal(report.summary.sameEpisodeFinalAssetPaidProofs, 2)
  input.subjects[0].observedRequestToPayoutSeconds = [-1]
  assert.throws(() => matrix({ stages: input }), /forceability_stage_counts_invalid/)
})

test('historical receipt cohort remains separate from prospective paid episodes', () => {
  const subject = manifest.subjects[0]
  const cohort = {
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    mintedReceipts: 96,
    firstEligibleHolderClaimSuccesses: 96,
    mechanicalClaimGateSeconds: 259_200,
    sameReceiptHolderPaidClaims: 89,
    openCensoredReceipts: 7,
    escrowEvidenceSha256: 'a'.repeat(64),
    boundaryEvidenceSha256: 'b'.repeat(64),
    payoutEvidenceSha256: 'c'.repeat(64),
  }
  const report = matrix({ historicalStagedCohorts: [cohort] })
  const row = report.subjects[0]
  assert.deepEqual(row.historicalReceiptCohort, cohort)
  assert.equal(report.summary.subjectsWithHistoricalReceiptCohort, 1)
  assert.equal(report.summary.historicalSameReceiptHolderPaidClaims, 89)
  assert.equal(row.terminalSameEpisodeFinalAssetPaidProofs, 0)
  assert.equal(row.calibratedImpairmentDuration, false)
  assert.equal(row.forecastValidated, false)
  assert.equal(row.historicalReceiptCohort.mechanicalClaimGateSeconds, 259_200)
  assert.ok(row.reasons.includes('no_prospective_same_episode_final_asset_paid_proof'))
  const withProspective = matrix({
    historicalStagedCohorts: [cohort],
    prospectiveReceiptImpairment: {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      scope: 'apyusd_receipt_claim_stage_only',
      intakeAnchorSha256: 'd'.repeat(64),
      summary: {
        failedFirstEligibleEpisodes: 2,
        recoveredIntervals: 1,
        rightCensoredEpisodes: 1,
        stillImpairedEpisodes: 0,
        awaitingFollowupEpisodes: 0,
      },
      episodes: [{ status: 'recovered' }, { status: 'censored_transfer' }],
      prospectiveValidated: false,
      fullRouteExitAssessed: false,
    },
  })
  assert.equal(withProspective.subjects[0].prospectiveReceiptImpairment.recoveredIntervals, 1)
  assert.equal(withProspective.summary.prospectiveReceiptFailedFirstEligibleEpisodes, 2)
  assert.equal(withProspective.subjects[0].calibratedImpairmentDuration, false)
  assert.equal(withProspective.subjects[0].forecastValidated, false)
  const current = {
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    block: 26110045,
    blockTime: 1791009239,
    cohort: 7,
    sameHolder: 7,
    claimCallable: 7,
    fullEscrowClaimable: 7,
    noCurrentOwner: 0,
    holderChanged: 0,
    sourceEscrowSha256: cohort.escrowEvidenceSha256,
    sourceBoundarySha256: cohort.boundaryEvidenceSha256,
    evidenceSha256: 'd'.repeat(64),
  }
  const withCurrent = matrix({
    historicalStagedCohorts: [cohort],
    currentOpenReceiptCohorts: [current],
  })
  assert.deepEqual(withCurrent.subjects[0].latestOpenReceiptObservation, current)
  assert.equal(withCurrent.subjects[0].forecastValidated, false)
  const transferred = {
    ...current,
    sameHolder: 6,
    claimCallable: 6,
    fullEscrowClaimable: 6,
    holderChanged: 1,
  }
  const withTransfer = matrix({
    historicalStagedCohorts: [cohort],
    currentOpenReceiptCohorts: [transferred],
  })
  assert.deepEqual(withTransfer.subjects[0].latestOpenReceiptObservation, transferred)
  assert.equal(withTransfer.subjects[0].forecastValidated, false)
  assert.throws(
    () =>
      matrix({
        historicalStagedCohorts: [{ ...cohort, firstEligibleHolderClaimSuccesses: 95 }],
      }),
    /forceability_historical_stage_invalid/,
  )
  assert.throws(
    () =>
      matrix({
        historicalStagedCohorts: [cohort],
        currentOpenReceiptCohorts: [{ ...current, claimCallable: 8 }],
      }),
    /forceability_current_receipt_invalid/,
  )
  assert.throws(
    () =>
      matrix({
        historicalStagedCohorts: [cohort],
        currentOpenReceiptCohorts: [{ ...current, fullEscrowClaimable: 8 }],
      }),
    /forceability_current_receipt_invalid/,
  )
  assert.throws(
    () => matrix({ historicalStagedCohorts: [cohort, cohort] }),
    /forceability_historical_stage_invalid/,
  )
  assert.throws(
    () => matrix({ historicalStagedCohorts: [{ ...cohort, asset: address(999) }] }),
    /forceability_historical_stage_invalid/,
  )
  assert.throws(
    () => matrix({ historicalStagedCohorts: [{ ...cohort, openCensoredReceipts: 0 }] }),
    /forceability_historical_stage_invalid/,
  )
})

test('historical request-to-mined-payment timing keeps all receipts and right-censors open IDs', () => {
  const paid = [5, 10, 20, 30, 40].map((days, index) => ({
    tokenId: String(index),
    request: { timestamp: 1_000_000 },
    payout: { timestamp: 1_000_000 + days * 86_400 },
    requestToPayoutSeconds: days * 86_400,
  }))
  const payouts = {
    sha256: 'a'.repeat(64),
    cohortSize: 6,
    paidCount: 5,
    openIds: ['5'],
    proofs: paid,
  }
  const escrow = {
    payoutsSha256: payouts.sha256,
    cohortSize: 6,
    proofs: Array.from({ length: 6 }, (_, index) => ({
      tokenId: String(index),
      issuedAt: 1_000_000,
    })),
  }
  const timing = summarizeHistoricalReceiptTiming(escrow, payouts)
  assert.deepEqual(timing, {
    scope: 'historical_holder_action_influenced_request_to_mined_payment',
    denominator: 6,
    paidWithin7Days: 1,
    paidWithin21Days: 3,
    paidWithin28Days: 3,
    medianRequestToMinedPayoutSeconds: 20 * 86_400,
    openRightCensored: 1,
    censorTimestamp: 1_000_000 + 40 * 86_400,
  })
  assert.throws(
    () => summarizeHistoricalReceiptTiming(escrow, { ...payouts, sha256: 'b'.repeat(64) }),
    /forceability_historical_receipt_timing_invalid/,
  )
  assert.throws(
    () =>
      summarizeHistoricalReceiptTiming(escrow, {
        ...payouts,
        proofs: [paid[0], paid[0], ...paid.slice(2)],
      }),
    /forceability_historical_receipt_timing_invalid/,
  )
})

test('historical median removes receipts censored before their payment risk window', () => {
  const payouts = {
    sha256: 'a'.repeat(64),
    cohortSize: 6,
    paidCount: 4,
    openIds: ['4', '5'],
    proofs: [10, 20, 30, 40].map((days, index) => ({
      tokenId: String(index),
      request: { timestamp: 1_000_000 },
      payout: { timestamp: 1_000_000 + days * 86_400 },
      requestToPayoutSeconds: days * 86_400,
    })),
  }
  const escrow = {
    payoutsSha256: payouts.sha256,
    cohortSize: 6,
    proofs: [
      ...Array.from({ length: 4 }, (_, index) => ({ tokenId: String(index), issuedAt: 1_000_000 })),
      { tokenId: '4', issuedAt: 1_000_000 + 34 * 86_400 },
      { tokenId: '5', issuedAt: 1_000_000 + 33 * 86_400 },
    ],
  }
  assert.equal(
    summarizeHistoricalReceiptTiming(escrow, payouts).medianRequestToMinedPayoutSeconds,
    20 * 86_400,
  )
})

test('historical intermediate queue keeps price-gated USDat payouts separate from final-asset proof', async () => {
  const subject = manifest.subjects[0]
  const cohort = {
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    intermediateAsset: subject.asset,
    cutoffBlock: 26107302,
    requests: 146,
    processed: 106,
    paidIntermediate: 77,
    processedUnclaimed: 29,
    pendingCensored: 40,
    pendingAboveCurrentLimit: 40,
    pendingBeforeUpgrade: 34,
    pendingAfterUpgrade: 6,
    episodeEvidenceSha256: 'a'.repeat(64),
    payoutEvidenceSha256: 'b'.repeat(64),
    pendingEvidenceSha256: 'c'.repeat(64),
    upgradeEvidenceSha256: 'd'.repeat(64),
  }
  const report = matrix({ historicalIntermediateQueues: [cohort] })
  const row = report.subjects[0]
  assert.deepEqual(row.historicalIntermediateQueue, cohort)
  assert.equal(report.summary.historicalIntermediatePaidClaims, 77)
  assert.equal(report.summary.historicalPendingAboveCurrentLimit, 40)
  assert.equal(row.terminalSameEpisodeFinalAssetPaidProofs, 0)
  assert.equal(row.calibratedImpairmentDuration, false)
  assert.equal(row.forecastValidated, false)
  assert.deepEqual(row.historicalIntermediateQueue.processingWithin24h, cohort.processingWithin24h)
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [
          {
            ...cohort,
            processingWithin24h: {
              horizonSeconds: 86_400,
              confirmedProcessed: 80,
              possibleProcessed: 92,
              censoredBeforeHorizon: 12,
            },
          },
        ],
      }),
    /forceability_intermediate_queue_invalid/,
  )
  const sealed = await verifyEpisodes()
  const pending = sealed.episodes.find((episode) => episode.waitCensored)
  const cutoff = pending.requestTimestamp + pending.waitSeconds
  const processingRegimeDiagnostic = {
    sourceEpisodeSha256: sealed.sha256,
    ...diagnoseSaturnQueueProcessing(sealed.episodes, cutoff),
  }
  const verifiedCohort = {
    ...cohort,
    episodeEvidenceSha256: sealed.sha256,
    processingWithin24h: historicalProcessingWithin24h(sealed),
    processingEvidenceEpisodes: sealed.episodes,
    processingRegimeDiagnostic,
  }
  const withDiagnostic = matrix({
    historicalIntermediateQueues: [verifiedCohort],
  })
  assert.deepEqual(
    withDiagnostic.subjects[0].historicalIntermediateQueue.processingRegimeDiagnostic,
    processingRegimeDiagnostic,
  )
  assert.equal(
    'processingEvidenceEpisodes' in withDiagnostic.subjects[0].historicalIntermediateQueue,
    false,
  )
  assert.equal(withDiagnostic.subjects[0].forecastValidated, false)
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [
          {
            ...verifiedCohort,
            processingRegimeDiagnostic: {
              ...processingRegimeDiagnostic,
              prospectiveValidated: true,
            },
          },
        ],
      }),
    /forceability_intermediate_queue_invalid/,
  )
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [
          {
            ...verifiedCohort,
            processingRegimeDiagnostic: {
              ...processingRegimeDiagnostic,
              later: {
                ...processingRegimeDiagnostic.later,
                processedWithinHorizon: 19,
                notProcessedWithinHorizon: 52,
                observedRate: 19 / 71,
              },
              comparison: {
                ...processingRegimeDiagnostic.comparison,
                observedLaterProcessed: 19,
                absoluteRateError: Math.abs(
                  processingRegimeDiagnostic.train.observedRate - 19 / 71,
                ),
              },
            },
          },
        ],
      }),
    /forceability_intermediate_queue_invalid/,
  )
  const current = {
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    sourceCutoffBlock: cohort.cutoffBlock,
    block: 26109183,
    blockTime: 1790998871,
    cohort: 40,
    stillRequested: 40,
    noLongerRequested: 0,
    priceGated: 40,
    quoteEligible: 0,
    medianElapsedSeconds: 402000,
    atLeastSevenDays: 15,
    evidenceSha256: 'f'.repeat(64),
  }
  const withCurrent = matrix({
    historicalIntermediateQueues: [cohort],
    currentPendingTicketCohorts: [current],
  })
  assert.deepEqual(withCurrent.subjects[0].latestPendingTicketObservation, current)
  assert.equal(withCurrent.subjects[0].forecastValidated, false)
  const withGateChange = matrix({
    historicalIntermediateQueues: [cohort],
    currentPendingTicketCohorts: [
      {
        ...current,
        gateChange: {
          previousBlock: current.block - 1,
          previousEvidenceSha256: 'e'.repeat(64),
          newlyGated: 0,
          newlyQuoteEligible: 0,
          stillGatedDeeper: 2,
        },
      },
    ],
  })
  assert.equal(
    withGateChange.subjects[0].latestPendingTicketObservation.gateChange.stillGatedDeeper,
    2,
  )
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [cohort],
        currentPendingTicketCohorts: [
          {
            ...current,
            gateChange: {
              previousBlock: current.block,
              previousEvidenceSha256: 'e'.repeat(64),
              newlyGated: 41,
              newlyQuoteEligible: 0,
              stillGatedDeeper: 0,
            },
          },
        ],
      }),
    /forceability_current_pending_invalid/,
  )
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [cohort],
        currentPendingTicketCohorts: [{ ...current, priceGated: 39 }],
      }),
    /forceability_current_pending_invalid/,
  )
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [cohort],
        currentPendingTicketCohorts: [{ ...current, atLeastSevenDays: 41 }],
      }),
    /forceability_current_pending_invalid/,
  )
  assert.throws(
    () => matrix({ historicalIntermediateQueues: [{ ...cohort, pendingAboveCurrentLimit: 41 }] }),
    /forceability_intermediate_queue_invalid/,
  )
  assert.throws(
    () => matrix({ historicalIntermediateQueues: [{ ...cohort, paidIntermediate: 78 }] }),
    /forceability_intermediate_queue_invalid/,
  )
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [
          {
            ...cohort,
            processingWithin24h: {
              ...cohort.processingWithin24h,
              possibleProcessed: 93,
            },
          },
        ],
      }),
    /forceability_intermediate_queue_invalid/,
  )
  const quote = {
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    intermediateAsset: subject.asset,
    finalAsset: address(555),
    cutoffBlock: cohort.cutoffBlock,
    curveCashUsdcRaw: '4654871968973',
    sizes: [
      { usdatRaw: '1000000000000', usdcQuotedRaw: '999621452866', ausdQuotedRaw: '999552915040' },
    ],
    evidenceSha256: 'e'.repeat(64),
  }
  const withQuote = matrix({
    historicalIntermediateQueues: [cohort],
    historicalPublicConversionQuotes: [quote],
  })
  assert.deepEqual(withQuote.subjects[0].historicalPublicConversionQuote, quote)
  assert.equal(withQuote.summary.subjectsWithHistoricalPublicConversionQuote, 1)
  assert.equal(withQuote.subjects[0].terminalSameEpisodeFinalAssetPaidProofs, 0)
  assert.equal(withQuote.subjects[0].forecastValidated, false)
  assert.throws(
    () =>
      matrix({
        historicalIntermediateQueues: [cohort],
        historicalPublicConversionQuotes: [{ ...quote, cutoffBlock: cohort.cutoffBlock + 1 }],
      }),
    /forceability_public_conversion_invalid/,
  )
})

test('unknown venue stays abstained even when caller includes optimistic fields', () => {
  const row = abstainUntrackedSubject({
    route_key: 'new protocol',
    destination: address(900),
    asset: address(901),
    forecastValidated: true,
    paidExitProofs: 100,
  })
  assert.equal(row.forecastValidated, false)
  assert.equal(row.terminalSameEpisodeFinalAssetPaidProof, false)
  assert.equal(row.mechanism, 'unassessed')
  assert.deepEqual(row.reasons, [
    'outside_frozen_cohort',
    'requires_verified_route_mechanism_and_evidence',
  ])
})
