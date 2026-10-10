import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  auditHolderExitStages,
  fluidUsdtStageLabels,
  partitionSusdeInitiationEvidence,
  twynePtStageLabels,
} from './holder-exit-stage-coverage.mjs'
import {
  ROUTE as FLUID_USDC_ROUTE,
  USDC as FLUID_USDC,
  VAULT as FLUID_VAULT,
} from './carry-fluid-bridge-usdc-holder.mjs'
import { ROUTE as FLUID_USDT_ROUTE, USDT as FLUID_USDT } from './carry-fluid-bridge-usdt-holder.mjs'
import { PRIME, PYUSD, ROUTE, WYLDS } from './pyusd-staking-economic-exit.mjs'
import { ROUTE_KEY as SUSDE_ROUTE, USDE, VAULT } from './susde-public-pending-exit-common.mjs'
import { ASSET as TWYNE_PT, ROUTE as TWYNE_ROUTE } from './carry-twyne-borrower-pt.mjs'

const TWYNE_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const TWYNE_SCOPE = 'borrower_pt_first_leg_simulation_only'

const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const manifest = {
  subjects: Array.from({ length: 67 }, (_, index) => ({
    route_key: `route-${Math.min(index, 24)}`,
    destination: address(index + 1),
    asset: address(100 + Math.min(index, 24)),
  })),
}
const ledger = (overrides = {}) => ({
  lane: 'test',
  routeKey: 'route-0',
  destination: address(1),
  originalAsset: address(100),
  stage: 'queue_request',
  issues: [{ sequence: 1, holder: address(200), status: 'success' }],
  scores: [{ issueSequence: 1, holder: address(200), status: 'measured' }],
  labels: (record) => [record.issueSequence ? 'target_queue_measured' : 'baseline_queue_success'],
  ...overrides,
})

test('archival sUSDe wrong-selector issues cannot count as deployed initiation coverage', () => {
  const legacy = {
    sequence: 1,
    study: 'susde_public_hypothetical_initiation_issue_v1',
    cases: [
      { measurement: { evidence: { schema: 'susde_public_cooldown_initiation_measurement_v1' } } },
    ],
  }
  const deployed = {
    sequence: 2,
    study: 'susde_public_hypothetical_initiation_issue_v2',
    cases: [
      { measurement: { evidence: { schema: 'susde_public_cooldown_initiation_measurement_v2' } } },
    ],
  }
  const scores = [
    { issueSequence: 1, study: 'susde_public_hypothetical_initiation_score_v1' },
    { issueSequence: 1, study: 'susde_public_hypothetical_initiation_score_v2' },
    { issueSequence: 2, study: 'susde_public_hypothetical_initiation_score_v2' },
  ]
  const selected = partitionSusdeInitiationEvidence([legacy, deployed], scores)
  assert.deepEqual(selected, {
    deployedIssues: [deployed],
    deployedScores: [scores[2]],
    quarantinedIssues: 1,
    quarantinedScores: 2,
  })
  assert.deepEqual(partitionSusdeInitiationEvidence([legacy], []).deployedIssues, [])
  assert.throws(
    () => partitionSusdeInitiationEvidence([{ ...deployed, cases: legacy.cases }], []),
    /stage_susde_initiation_provenance_invalid/,
  )
})

test('frozen subject receives intermediate stage counts without holder identity or payout claim', () => {
  const report = auditHolderExitStages({ manifest, ledgers: [ledger()] })
  assert.equal(report.frozenGroups, 25)
  assert.equal(report.frozenSubjects, 67)
  assert.equal(report.subjectsWithStageIssues, 1)
  assert.equal(report.groupsWithStageIssues, 1)
  assert.equal(report.groups[0].uncoveredSubjects, 0)
  assert.deepEqual(report.subjects[0].stages.queue_request, {
    verifiedIssues: 1,
    verifiedScores: 1,
    labels: { baseline_queue_success: 1, target_queue_measured: 1 },
  })
  assert.equal(report.paidExitProofs, 0)
  assert.equal(report.calibratedImpairmentDurations, 0)
  assert.equal(JSON.stringify(report).includes(address(200)), false)
})

test('same route and destination with a different original asset is out of cohort', () => {
  const report = auditHolderExitStages({
    manifest,
    ledgers: [ledger({ originalAsset: address(999), lane: 'hastra_prime' })],
  })
  assert.equal(report.subjectsWithStageIssues, 0)
  assert.equal(report.groupsWithStageIssues, 0)
  assert.deepEqual(
    report.outOfCohort.map((row) => [row.lane, row.reason, row.verifiedIssues]),
    [['hastra_prime', 'original_asset_mismatch', 1]],
  )
})

test('Hastra first stage joins on wYLDS underlying while PYUSD remains route input', () => {
  const hastraManifest = {
    subjects: [
      { route_key: ROUTE, destination: PRIME, asset: WYLDS },
      ...manifest.subjects.slice(1),
    ],
  }
  const hastraStage = ledger({
    lane: 'hastra_prime',
    routeKey: ROUTE,
    destination: PRIME,
    originalAsset: WYLDS,
    routeInputAsset: PYUSD,
    stage: 'prime_to_wylds_first_stage',
    labels: (record) => [
      record.issueSequence ? 'target_first_stage_callable' : 'baseline_first_stage_callable',
    ],
  })
  const matched = auditHolderExitStages({ manifest: hastraManifest, ledgers: [hastraStage] })
  assert.equal(matched.subjectsWithStageIssues, 1)
  assert.equal(matched.outOfCohort.length, 0)
  assert.equal(matched.subjects[0].stages.prime_to_wylds_first_stage.routeInputAsset, PYUSD)
  assert.equal(matched.paidExitProofs, 0)
  assert.equal(matched.calibratedImpairmentDurations, 0)

  const wrong = auditHolderExitStages({
    manifest: hastraManifest,
    ledgers: [{ ...hastraStage, originalAsset: PYUSD }],
  })
  assert.equal(wrong.subjectsWithStageIssues, 0)
  assert.equal(wrong.outOfCohort[0].reason, 'original_asset_mismatch')
})

test('two distinct stages on the same exact subject remain separate', () => {
  const report = auditHolderExitStages({
    manifest,
    ledgers: [
      ledger(),
      ledger({
        lane: 'pending',
        stage: 'pending_claim',
        issues: [{ sequence: 1 }],
        scores: [],
        labels: () => ['baseline_pending_observed'],
      }),
    ],
  })
  assert.equal(report.subjectsWithStageIssues, 1)
  assert.equal(report.subjects[0].verifiedIssues, 2)
  assert.equal(report.subjects[0].stages.pending_claim.verifiedIssues, 1)
  assert.equal(report.subjects[0].stages.queue_request.verifiedScores, 1)
})

test('duplicate lane and stage for the same subject is rejected before counting', () => {
  const first = ledger()
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest,
        ledgers: [
          first,
          { ...first, destination: first.destination.toUpperCase().replace('0X', '0x') },
        ],
      }),
    /stage_ledger_duplicate/,
  )
  const outOfCohort = ledger({ originalAsset: address(999) })
  assert.throws(
    () => auditHolderExitStages({ manifest, ledgers: [outOfCohort, { ...outOfCohort }] }),
    /stage_ledger_duplicate/,
  )
})

test('Fluid USDT seed is a separate USDC first leg with unassessed final USDT payout', () => {
  const fluidManifest = {
    subjects: [
      { route_key: FLUID_USDT_ROUTE, destination: FLUID_VAULT, asset: FLUID_USDC },
      { route_key: FLUID_USDC_ROUTE, destination: FLUID_VAULT, asset: FLUID_USDC },
      ...manifest.subjects.slice(2),
    ],
  }
  const seed = ledger({
    lane: 'fluid_bridge_usdt',
    routeKey: FLUID_USDT_ROUTE,
    destination: FLUID_VAULT,
    originalAsset: FLUID_USDC,
    routeInputAsset: FLUID_USDT,
    evidenceScope: 'frozen_route_borrower_seed',
    stage: 'usdc_first_leg_simulation',
    issues: [
      {
        sequence: 1,
        candidateSource: 'frozen_seed',
        candidate: {
          sourceAttestation: 'frozen_route_borrower_seed',
          sourceProof: { candidateScope: 'historical_route_borrower_not_signer' },
        },
        finalAsset: FLUID_USDT,
        payoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
        baseline: { cases: [{ measurement: { simulation: { status: 'success' } } }] },
      },
    ],
    scores: [
      {
        issueSequence: 1,
        status: 'measured',
        payoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
        cases: [{ outcome: 'simulated_success' }],
      },
      {
        issueSequence: 1,
        status: 'missed_window',
        payoutAssessment: 'usdc_first_leg_only_usdt_unassessed',
        cases: null,
      },
    ],
    labels: fluidUsdtStageLabels,
  })
  const sibling = ledger({
    lane: 'fluid_bridge_usdc',
    routeKey: FLUID_USDC_ROUTE,
    destination: FLUID_VAULT,
    originalAsset: FLUID_USDC,
    stage: 'first_leg_simulation',
    issues: [{ sequence: 1 }],
    scores: [],
    labels: () => ['baseline_first_leg_success'],
  })
  const report = auditHolderExitStages({ manifest: fluidManifest, ledgers: [seed, sibling] })
  const usdt = report.subjects[0]
  const usdc = report.subjects[1]
  assert.equal(report.groupsWithStageIssues, 2)
  assert.equal(usdt.verifiedIssues, 1)
  assert.equal(usdc.verifiedIssues, 1)
  assert.equal(usdc.stages.usdc_first_leg_simulation, undefined)
  assert.equal(usdt.stages.first_leg_simulation, undefined)
  assert.deepEqual(usdt.stages.usdc_first_leg_simulation.labels, {
    baseline_usdc_first_leg_success: 1,
    target_usdc_first_leg_simulated_success: 1,
    target_usdc_first_leg_unassessed: 1,
  })
  assert.equal(usdt.stages.usdc_first_leg_simulation.routeInputAsset, FLUID_USDT)
  assert.equal(usdt.stages.usdc_first_leg_simulation.evidenceScope, 'frozen_route_borrower_seed')
  assert.equal(usdt.stages.usdc_first_leg_simulation.signerControl, 'unassessed')
  assert.equal(usdt.stages.usdc_first_leg_simulation.usdcToUsdtConversion, 'unassessed')
  assert.equal(usdt.stages.usdc_first_leg_simulation.finalUsdtPayout, 'unassessed')
  assert.equal(report.paidExitProofs, 0)
  assert.equal(report.calibratedImpairmentDurations, 0)

  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: fluidManifest,
        ledgers: [{ ...seed, originalAsset: FLUID_USDT }],
      }),
    /stage_ledger_invalid/,
  )
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: fluidManifest,
        ledgers: [{ ...seed, routeKey: FLUID_USDC_ROUTE }],
      }),
    /stage_ledger_invalid/,
  )
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: fluidManifest,
        ledgers: [
          {
            ...seed,
            routeKey: manifest.subjects[2].route_key,
            destination: manifest.subjects[2].destination,
            originalAsset: manifest.subjects[2].asset,
          },
        ],
      }),
    /stage_ledger_invalid/,
  )
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: fluidManifest,
        ledgers: [
          {
            ...seed,
            issues: [{ ...seed.issues[0], payoutAssessment: 'usdt_paid' }],
          },
        ],
      }),
    /stage_ledger_invalid/,
  )
})

test('exact sUSDe mined delivery is counted without inventing episode duration', () => {
  const susdeManifest = {
    subjects: [
      { route_key: SUSDE_ROUTE, destination: VAULT, asset: USDE },
      ...manifest.subjects.slice(1),
    ],
  }
  const report = auditHolderExitStages({
    manifest: susdeManifest,
    ledgers: [
      ledger({
        lane: 'susde_mined_delivery',
        routeKey: SUSDE_ROUTE,
        destination: VAULT,
        originalAsset: USDE,
        stage: 'mined_delivery',
        issues: [],
        scores: [],
        attestations: [
          {
            minedDeliveryProven: true,
            episodeAttribution: 'unresolved',
            durationEstimated: false,
            forecastValidated: false,
          },
        ],
        labels: () => ['exact_usde_delivery_episode_unresolved'],
      }),
    ],
  })
  assert.equal(report.paidExitProofs, 1)
  assert.equal(report.minedDeliveryAttestations, 1)
  assert.equal(report.sameEpisodePaidExitProofs, 0)
  assert.equal(report.calibratedImpairmentDurations, 0)
  assert.equal(report.subjects[0].stages.mined_delivery.minedDeliveryAttestations, 1)
})

const susdeManifest = {
  subjects: [
    { route_key: SUSDE_ROUTE, destination: VAULT, asset: USDE },
    ...manifest.subjects.slice(1),
  ],
}
const issueSha = 'a'.repeat(64)
const deliverySha = 'b'.repeat(64)
const payoutTx = `0x${'c'.repeat(64)}`
const linkedDelivery = {
  sequence: 1,
  sha256: deliverySha,
  issueSequence: 3,
  issueSha256: issueSha,
  routeKey: SUSDE_ROUTE,
  vault: VAULT,
  asset: USDE,
  holder: address(200),
  frozenPendingAssetsRaw: '100',
  transactionHash: payoutTx,
  minedDeliveryProven: true,
  episodeAttribution: 'unresolved',
  durationEstimated: false,
  forecastValidated: false,
}
const linkedEpisode = {
  study: 'susde_public_request_to_payout_episode_v1',
  status: 'linked_observed_episode',
  issueSequence: 3,
  issueSha256: issueSha,
  requestProofSha256: 'd'.repeat(64),
  sidecarSha256: 'e'.repeat(64),
  deliverySha256: deliverySha,
  archiveFinalSha256: 'f'.repeat(64),
  holder: linkedDelivery.holder,
  payoutTransactionHash: payoutTx,
  rawAssets: '100',
  observedRequestToPayoutSeconds: 86_436,
  forecastValidated: false,
  futureDurationClaim: false,
}
const linkedLedger = (overrides = {}) => {
  const episode = overrides.linkedEpisode ?? linkedEpisode
  return ledger({
    lane: 'susde_mined_delivery',
    routeKey: SUSDE_ROUTE,
    destination: VAULT,
    originalAsset: USDE,
    stage: 'mined_delivery',
    issues: [],
    scores: [],
    attestations: [linkedDelivery],
    linkedEpisode,
    labels: (record) => [
      episode.status === 'linked_observed_episode' && record.sha256 === episode.deliverySha256
        ? 'exact_usde_delivery_same_episode_observed'
        : 'exact_usde_delivery_episode_unresolved',
    ],
    ...overrides,
  })
}

test('missing sidecar leaves exact sUSDe mined delivery episode unresolved', () => {
  const report = auditHolderExitStages({
    manifest: susdeManifest,
    ledgers: [
      linkedLedger({
        linkedEpisode: {
          study: linkedEpisode.study,
          status: 'sidecar_missing',
          issueSequence: 3,
        },
      }),
    ],
  })
  assert.equal(report.paidExitProofs, 1)
  assert.equal(report.sameEpisodePaidExitProofs, 0)
  assert.equal(report.calibratedImpairmentDurations, 0)
  assert.equal(
    report.subjects[0].stages.mined_delivery.labels.exact_usde_delivery_episode_unresolved,
    1,
  )
})

test('exact sUSDe issue and final-asset receipt promote one observed same-episode payout', () => {
  const report = auditHolderExitStages({
    manifest: susdeManifest,
    ledgers: [
      ledger({
        lane: 'susde_pending',
        routeKey: SUSDE_ROUTE,
        destination: VAULT,
        originalAsset: USDE,
        stage: 'pending_claim',
      }),
      linkedLedger(),
    ],
  })
  assert.equal(report.sameEpisodePaidExitProofs, 1)
  assert.equal(report.subjects[0].sameEpisodePaidExitProofs, 1)
  assert.deepEqual(report.subjects[0].observedRequestToPayoutSeconds, [86_436])
  assert.equal(report.subjects[0].stages.mined_delivery.sameEpisodePaidExitProofs, 1)
  assert.deepEqual(
    report.subjects[0].stages.mined_delivery.observedRequestToPayoutSeconds,
    [86_436],
  )
  assert.equal(report.groups[0].sameEpisodePaidExitProofs, 1)
  assert.equal(report.calibratedImpairmentDurations, 0)
  assert.equal(JSON.stringify(report).includes(linkedDelivery.holder), false)
})

test('two distinct sUSDe episodes count twice and duplicate delivery cannot count twice', () => {
  const secondDelivery = {
    ...linkedDelivery,
    issueSequence: 6,
    issueSha256: '6'.repeat(64),
    sha256: '7'.repeat(64),
    transactionHash: `0x${'8'.repeat(64)}`,
  }
  const secondEpisode = {
    ...linkedEpisode,
    issueSequence: 6,
    issueSha256: secondDelivery.issueSha256,
    deliverySha256: secondDelivery.sha256,
    payoutTransactionHash: secondDelivery.transactionHash,
    observedRequestToPayoutSeconds: 92_628,
  }
  const base = linkedLedger({
    linkedEpisode: undefined,
    linkedEpisodes: [linkedEpisode, secondEpisode],
    attestations: [linkedDelivery, secondDelivery],
  })
  delete base.linkedEpisode
  const report = auditHolderExitStages({ manifest: susdeManifest, ledgers: [base] })
  assert.equal(report.paidExitProofs, 2)
  assert.equal(report.sameEpisodePaidExitProofs, 2)
  assert.deepEqual(report.subjects[0].observedRequestToPayoutSeconds, [86_436, 92_628])
  assert.deepEqual(
    report.subjects[0].stages.mined_delivery.observedRequestToPayoutSeconds,
    [86_436, 92_628],
  )
  assert.equal(report.calibratedImpairmentDurations, 0)
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: susdeManifest,
        ledgers: [{ ...base, linkedEpisodes: [linkedEpisode, linkedEpisode] }],
      }),
    /stage_linked_episode_duplicate/,
  )
})

test('sUSDe route identity and receipt hashes must match linked episode', () => {
  for (const bad of [
    linkedLedger({ routeKey: 'another route' }),
    linkedLedger({ destination: address(999) }),
    linkedLedger({ originalAsset: address(999) }),
  ]) {
    assert.throws(
      () => auditHolderExitStages({ manifest: susdeManifest, ledgers: [bad] }),
      /stage_ledger_invalid/,
    )
  }
  for (const bad of [
    linkedLedger({ attestations: [{ ...linkedDelivery, issueSha256: '0'.repeat(64) }] }),
    linkedLedger({ attestations: [{ ...linkedDelivery, sha256: '0'.repeat(64) }] }),
    linkedLedger({ attestations: [{ ...linkedDelivery, asset: address(999) }] }),
  ]) {
    assert.throws(
      () => auditHolderExitStages({ manifest: susdeManifest, ledgers: [bad] }),
      /stage_linked_episode_delivery_mismatch/,
    )
  }
})

test('verified Twyne borrower PT first-leg remains PT-only with unassessed key control and payout', () => {
  const ptManifest = {
    subjects: [
      { route_key: TWYNE_ROUTE, destination: TWYNE_WRAPPER, asset: TWYNE_PT },
      ...manifest.subjects.slice(1),
    ],
  }
  const firstLeg = ledger({
    lane: 'twyne_borrower_pt_v1',
    routeKey: TWYNE_ROUTE,
    destination: TWYNE_WRAPPER,
    originalAsset: TWYNE_PT,
    routeInputAsset: USDE,
    evidenceScope: TWYNE_SCOPE,
    stage: 'borrower_authorized_pt_first_leg_simulation',
    issues: [
      {
        scope: TWYNE_SCOPE,
        measurement: {
          status: 'observed',
          evidence: { borrowerKeyControl: 'unassessed', finalUsdePayout: 'unassessed' },
        },
      },
      {
        scope: TWYNE_SCOPE,
        measurement: {
          status: 'restricted',
          evidence: { borrowerKeyControl: 'unassessed', finalUsdePayout: 'unassessed' },
        },
      },
    ],
    scores: [
      {
        issueSequence: 1,
        scope: TWYNE_SCOPE,
        status: 'measured',
        outcome: 'pt_first_leg_simulated',
        measurement: {
          evidence: { borrowerKeyControl: 'unassessed', finalUsdePayout: 'unassessed' },
        },
      },
      {
        issueSequence: 2,
        scope: TWYNE_SCOPE,
        status: 'measured',
        outcome: 'restricted',
        measurement: {
          evidence: { borrowerKeyControl: 'unassessed', finalUsdePayout: 'unassessed' },
        },
      },
      { issueSequence: 1, scope: TWYNE_SCOPE, status: 'censored' },
    ],
    labels: twynePtStageLabels,
  })
  const report = auditHolderExitStages({ manifest: ptManifest, ledgers: [firstLeg] })
  const subject = report.subjects[0]
  assert.equal(report.subjectsWithStageIssues, 1)
  assert.equal(report.groupsWithStageIssues, 1)
  assert.equal(report.outOfCohort.length, 0)
  assert.equal(subject.stages.borrower_authorized_pt_first_leg_simulation.routeInputAsset, USDE)
  assert.equal(
    subject.stages.borrower_authorized_pt_first_leg_simulation.evidenceScope,
    TWYNE_SCOPE,
  )
  assert.deepEqual(subject.stages.borrower_authorized_pt_first_leg_simulation.labels, {
    baseline_pt_first_leg_observed: 1,
    baseline_pt_first_leg_restricted: 1,
    target_pt_first_leg_observed: 1,
    target_pt_first_leg_restricted: 1,
    target_pt_first_leg_unassessed: 1,
  })
  assert.equal(report.paidExitProofs, 0)
  assert.equal(report.minedDeliveryAttestations, 0)
  assert.equal(report.sameEpisodePaidExitProofs, 0)
  assert.equal(report.calibratedImpairmentDurations, 0)
  assert.equal(JSON.stringify(report).includes('borrowerKeyControl'), false)

  const wrongAsset = auditHolderExitStages({
    manifest: ptManifest,
    ledgers: [{ ...firstLeg, originalAsset: USDE }],
  })
  assert.equal(wrongAsset.subjectsWithStageIssues, 0)
  assert.deepEqual(
    wrongAsset.outOfCohort.map((row) => [row.lane, row.reason]),
    [['twyne_borrower_pt_v1', 'original_asset_mismatch']],
  )
  const wrongDestination = auditHolderExitStages({
    manifest: ptManifest,
    ledgers: [{ ...firstLeg, destination: address(999) }],
  })
  assert.equal(wrongDestination.subjectsWithStageIssues, 0)
  assert.equal(wrongDestination.outOfCohort[0].reason, 'route_or_destination_mismatch')
})

test('Twyne stage rejects borrower-key or final-payout promotion', () => {
  const ptManifest = {
    subjects: [
      { route_key: TWYNE_ROUTE, destination: TWYNE_WRAPPER, asset: TWYNE_PT },
      ...manifest.subjects.slice(1),
    ],
  }
  const base = ledger({
    lane: 'twyne_borrower_pt_v1',
    routeKey: TWYNE_ROUTE,
    destination: TWYNE_WRAPPER,
    originalAsset: TWYNE_PT,
    routeInputAsset: USDE,
    evidenceScope: TWYNE_SCOPE,
    stage: 'borrower_authorized_pt_first_leg_simulation',
    issues: [
      {
        scope: TWYNE_SCOPE,
        measurement: {
          status: 'observed',
          evidence: { borrowerKeyControl: 'unassessed', finalUsdePayout: 'unassessed' },
        },
      },
    ],
    scores: [],
  })
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: ptManifest,
        ledgers: [
          {
            ...base,
            issues: [
              {
                ...base.issues[0],
                measurement: {
                  ...base.issues[0].measurement,
                  evidence: { borrowerKeyControl: 'proven', finalUsdePayout: 'unassessed' },
                },
              },
            ],
          },
        ],
      }),
    /stage_ledger_invalid/,
  )
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: ptManifest,
        ledgers: [
          {
            ...base,
            attestations: [
              {
                minedDeliveryProven: true,
                episodeAttribution: 'unresolved',
                durationEstimated: false,
                forecastValidated: false,
              },
            ],
          },
        ],
      }),
    /stage_ledger_invalid/,
  )
})

test('manifest count and repeated exact subjects fail closed', () => {
  assert.throws(
    () => auditHolderExitStages({ manifest: { subjects: [] }, ledgers: [] }),
    /stage_manifest_not_frozen_25_67/,
  )
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest: { subjects: [...manifest.subjects.slice(0, 66), manifest.subjects[0]] },
        ledgers: [],
      }),
    /stage_manifest_duplicate_subject/,
  )
})

test('unknown label text cannot be emitted', () => {
  assert.throws(
    () =>
      auditHolderExitStages({
        manifest,
        ledgers: [ledger({ labels: () => ['0xprivate-address'] })],
      }),
    /stage_label_invalid/,
  )
})
