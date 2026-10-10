// Read-only accounting for verified holder-exit stages and mined delivery.
// A mined delivery is attributed only when the separately verified request to
// payout linker binds it to the same issue and the exact final asset.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const key = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`

const TWYNE_PT_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const TWYNE_PT_INPUT_USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const TWYNE_PT_SCOPE = 'borrower_pt_first_leg_simulation_only'
const FLUID_USDT_SEED_SCOPE = 'frozen_route_borrower_seed'
const FLUID_USDT_PAYOUT_SCOPE = 'usdc_first_leg_only_usdt_unassessed'
const FLUID_USDT_ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]'
const FLUID_USDT_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const FLUID_USDT_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const FLUID_USDT_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const SUSDE_ROUTE = 'USDe → Staked USDe [USDe]'
const SUSDE_VAULT = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
const SUSDE_USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const SUSDE_EPISODE_STUDY = 'susde_public_request_to_payout_episode_v1'
const SUSDE_INITIATION_ISSUE_V1 = 'susde_public_hypothetical_initiation_issue_v1'
const SUSDE_INITIATION_ISSUE_V2 = 'susde_public_hypothetical_initiation_issue_v2'
const SUSDE_INITIATION_SCORE_V1 = 'susde_public_hypothetical_initiation_score_v1'
const SUSDE_INITIATION_SCORE_V2 = 'susde_public_hypothetical_initiation_score_v2'
const SUSDE_INITIATION_MEASUREMENT_V1 = 'susde_public_cooldown_initiation_measurement_v1'
const SUSDE_INITIATION_MEASUREMENT_V2 = 'susde_public_cooldown_initiation_measurement_v2'
const sha256 = (value) => /^[0-9a-f]{64}$/.test(value ?? '')

// V1 used a selector absent from the deployed vault. Its sealed records are
// retained by their verifier, but cannot count as a holder initiation probe.
export function partitionSusdeInitiationEvidence(issues, scores) {
  const issueStudies = new Map()
  const deployedIssues = []
  const deployedScores = []
  let quarantinedIssues = 0
  let quarantinedScores = 0
  for (const issue of issues) {
    const schema =
      issue.study === SUSDE_INITIATION_ISSUE_V1
        ? SUSDE_INITIATION_MEASUREMENT_V1
        : issue.study === SUSDE_INITIATION_ISSUE_V2
          ? SUSDE_INITIATION_MEASUREMENT_V2
          : null
    if (
      !schema ||
      issueStudies.has(issue.sequence) ||
      !Array.isArray(issue.cases) ||
      issue.cases.some(
        (row) => row.measurement != null && row.measurement.evidence?.schema !== schema,
      )
    )
      throw Error('stage_susde_initiation_provenance_invalid')
    issueStudies.set(issue.sequence, issue.study)
    if (issue.study === SUSDE_INITIATION_ISSUE_V2) deployedIssues.push(issue)
    else quarantinedIssues++
  }
  for (const score of scores) {
    const issueStudy = issueStudies.get(score.issueSequence)
    if (
      !issueStudy ||
      ![SUSDE_INITIATION_SCORE_V1, SUSDE_INITIATION_SCORE_V2].includes(score.study) ||
      (score.study === SUSDE_INITIATION_SCORE_V1 && issueStudy !== SUSDE_INITIATION_ISSUE_V1)
    )
      throw Error('stage_susde_initiation_provenance_invalid')
    if (score.study === SUSDE_INITIATION_SCORE_V2 && issueStudy === SUSDE_INITIATION_ISSUE_V2)
      deployedScores.push(score)
    else quarantinedScores++
  }
  return { deployedIssues, deployedScores, quarantinedIssues, quarantinedScores }
}

export const twynePtStageLabels = (record) => {
  if (!record.issueSequence) return [`baseline_pt_first_leg_${record.measurement.status}`]
  if (record.status === 'censored') return ['target_pt_first_leg_unassessed']
  return [
    record.outcome === 'pt_first_leg_simulated'
      ? 'target_pt_first_leg_observed'
      : record.outcome === 'restricted'
        ? 'target_pt_first_leg_restricted'
        : `target_pt_first_leg_${record.outcome}`,
  ]
}

export const fluidUsdtStageLabels = (record) =>
  record.issueSequence
    ? record.status === 'missed_window'
      ? ['target_usdc_first_leg_unassessed']
      : caseLabels(record, 'outcome', 'target_usdc_first_leg')
    : (record.baseline.cases ?? []).map(
        (row) => `baseline_usdc_first_leg_${row.measurement.simulation.status}`,
      )

function assertManifest(manifest) {
  if (!Array.isArray(manifest?.subjects)) throw Error('stage_manifest_invalid')
  const subjects = new Map()
  for (const subject of manifest.subjects) {
    const id = key(subject.route_key, subject.destination, subject.asset)
    if (subjects.has(id)) throw Error('stage_manifest_duplicate_subject')
    subjects.set(id, subject)
  }
  if (subjects.size !== 67 || new Set(manifest.subjects.map((row) => row.route_key)).size !== 25)
    throw Error('stage_manifest_not_frozen_25_67')
  return subjects
}

// `ledgers` are normalized only after their route-specific readers have verified
// their hash chains, bindings, identity and measurement rules.
export function auditHolderExitStages({ manifest, ledgers, quarantinedLegacyInitiation = null }) {
  const subjects = assertManifest(manifest)
  const bySubject = new Map()
  const outOfCohort = []
  const seenLedgers = new Set()
  for (const ledger of ledgers) {
    const {
      lane,
      routeKey,
      destination,
      originalAsset,
      routeInputAsset,
      evidenceScope,
      stage,
      issues,
      scores,
    } = ledger
    const attestations = ledger.attestations ?? []
    const linkedEpisodes =
      ledger.linkedEpisodes ?? (ledger.linkedEpisode ? [ledger.linkedEpisode] : [])
    if (
      !lane ||
      !routeKey ||
      !destination ||
      !originalAsset ||
      !stage ||
      !Array.isArray(issues) ||
      !Array.isArray(scores) ||
      !Array.isArray(attestations) ||
      !Array.isArray(linkedEpisodes) ||
      (ledger.linkedEpisodes != null && ledger.linkedEpisode != null) ||
      (linkedEpisodes.length > 0 && lane !== 'susde_mined_delivery') ||
      (lane === 'susde_mined_delivery' &&
        (routeKey !== SUSDE_ROUTE ||
          destination.toLowerCase() !== SUSDE_VAULT ||
          originalAsset.toLowerCase() !== SUSDE_USDE ||
          stage !== 'mined_delivery' ||
          issues.length !== 0 ||
          scores.length !== 0)) ||
      (lane === 'fluid_bridge_usdt' &&
        (stage !== 'usdc_first_leg_simulation' ||
          routeKey !== FLUID_USDT_ROUTE ||
          destination.toLowerCase() !== FLUID_USDT_VAULT ||
          originalAsset.toLowerCase() !== FLUID_USDT_USDC ||
          evidenceScope !== FLUID_USDT_SEED_SCOPE ||
          routeInputAsset?.toLowerCase() !== FLUID_USDT_USDT ||
          attestations.length > 0 ||
          issues.some(
            (record) =>
              record.candidateSource !== 'frozen_seed' ||
              record.candidate?.sourceAttestation !== FLUID_USDT_SEED_SCOPE ||
              record.candidate?.sourceProof?.candidateScope !==
                'historical_route_borrower_not_signer' ||
              record.payoutAssessment !== FLUID_USDT_PAYOUT_SCOPE ||
              record.finalAsset?.toLowerCase() !== routeInputAsset.toLowerCase(),
          ) ||
          scores.some((record) => record.payoutAssessment !== FLUID_USDT_PAYOUT_SCOPE))) ||
      (lane === 'twyne_borrower_pt_v1' &&
        (stage !== 'borrower_authorized_pt_first_leg_simulation' ||
          evidenceScope !== TWYNE_PT_SCOPE ||
          routeInputAsset?.toLowerCase() !== TWYNE_PT_INPUT_USDE ||
          attestations.length > 0 ||
          issues.some(
            (record) =>
              record.scope !== TWYNE_PT_SCOPE ||
              !['observed', 'restricted'].includes(record.measurement?.status) ||
              record.measurement.evidence?.borrowerKeyControl !== 'unassessed' ||
              record.measurement.evidence?.finalUsdePayout !== 'unassessed',
          ) ||
          scores.some(
            (record) =>
              record.scope !== TWYNE_PT_SCOPE ||
              (record.status !== 'censored' &&
                (record.status !== 'measured' ||
                  ![
                    'pt_first_leg_simulated',
                    'restricted',
                    'unavailable',
                    'controller_changed',
                  ].includes(record.outcome) ||
                  record.measurement?.evidence?.borrowerKeyControl !== 'unassessed' ||
                  record.measurement?.evidence?.finalUsdePayout !== 'unassessed')),
          ))) ||
      (attestations.length > 0 &&
        (lane !== 'susde_mined_delivery' ||
          stage !== 'mined_delivery' ||
          attestations.some(
            (record) =>
              record.minedDeliveryProven !== true ||
              record.episodeAttribution !== 'unresolved' ||
              record.durationEstimated !== false ||
              record.forecastValidated !== false,
          )))
    )
      throw Error('stage_ledger_invalid')
    const linkedDeliveries = []
    const seenIssueEpisodes = new Set()
    const seenPayoutEpisodes = new Set()
    for (const linkedEpisode of linkedEpisodes) {
      if (linkedEpisode?.status === 'sidecar_missing') {
        if (
          linkedEpisode.study !== SUSDE_EPISODE_STUDY ||
          !Number.isInteger(linkedEpisode.issueSequence) ||
          linkedEpisode.issueSequence < 1
        )
          throw Error('stage_linked_episode_invalid')
        continue
      }
      if (linkedEpisode?.status !== 'linked_observed_episode')
        throw Error('stage_linked_episode_invalid')
      if (
        linkedEpisode.study !== SUSDE_EPISODE_STUDY ||
        !Number.isInteger(linkedEpisode.issueSequence) ||
        linkedEpisode.issueSequence < 1 ||
        !sha256(linkedEpisode.issueSha256) ||
        !sha256(linkedEpisode.requestProofSha256) ||
        !sha256(linkedEpisode.sidecarSha256) ||
        !sha256(linkedEpisode.deliverySha256) ||
        !sha256(linkedEpisode.archiveFinalSha256) ||
        !Number.isSafeInteger(linkedEpisode.observedRequestToPayoutSeconds) ||
        linkedEpisode.observedRequestToPayoutSeconds < 0 ||
        linkedEpisode.forecastValidated !== false ||
        linkedEpisode.futureDurationClaim !== false
      )
        throw Error('stage_linked_episode_invalid')
      if (
        seenIssueEpisodes.has(linkedEpisode.issueSequence) ||
        seenPayoutEpisodes.has(linkedEpisode.deliverySha256)
      )
        throw Error('stage_linked_episode_duplicate')
      seenIssueEpisodes.add(linkedEpisode.issueSequence)
      seenPayoutEpisodes.add(linkedEpisode.deliverySha256)
      const matching = attestations.filter(
        (row) =>
          row.issueSequence === linkedEpisode.issueSequence &&
          row.issueSha256 === linkedEpisode.issueSha256 &&
          row.sha256 === linkedEpisode.deliverySha256 &&
          row.routeKey === SUSDE_ROUTE &&
          row.vault?.toLowerCase() === SUSDE_VAULT &&
          row.asset?.toLowerCase() === SUSDE_USDE &&
          row.minedDeliveryProven === true &&
          row.holder === linkedEpisode.holder &&
          row.transactionHash === linkedEpisode.payoutTransactionHash &&
          row.frozenPendingAssetsRaw === linkedEpisode.rawAssets,
      )
      if (matching.length !== 1) throw Error('stage_linked_episode_delivery_mismatch')
      linkedDeliveries.push(linkedEpisode)
    }
    const id = key(routeKey, destination, originalAsset)
    const ledgerIdentity = JSON.stringify([lane, stage, id])
    if (seenLedgers.has(ledgerIdentity)) throw Error('stage_ledger_duplicate')
    seenLedgers.add(ledgerIdentity)
    const subject = subjects.get(id)
    if (!subject) {
      outOfCohort.push({
        lane,
        routeKey,
        destination,
        originalAsset,
        stage,
        verifiedIssues: issues.length,
        verifiedScores: scores.length,
        minedDeliveryAttestations: attestations.length,
        reason: manifest.subjects.some(
          (row) =>
            row.route_key === routeKey &&
            row.destination.toLowerCase() === destination.toLowerCase(),
        )
          ? 'original_asset_mismatch'
          : 'route_or_destination_mismatch',
      })
      continue
    }
    let row = bySubject.get(id)
    if (!row) {
      row = {
        routeKey: subject.route_key,
        destination: subject.destination,
        originalAsset: subject.asset,
        verifiedIssues: 0,
        verifiedScores: 0,
        stages: {},
        paidExitProofs: 0,
        minedDeliveryAttestations: 0,
        sameEpisodePaidExitProofs: 0,
        observedRequestToPayoutSeconds: [],
        calibratedImpairmentDurations: 0,
      }
      bySubject.set(id, row)
    }
    const stageRow = row.stages[stage] ?? { verifiedIssues: 0, verifiedScores: 0, labels: {} }
    if (lane === 'fluid_bridge_usdt') {
      stageRow.signerControl = 'unassessed'
      stageRow.usdcToUsdtConversion = 'unassessed'
      stageRow.finalUsdtPayout = 'unassessed'
    }
    if (evidenceScope) {
      if (stageRow.evidenceScope && stageRow.evidenceScope !== evidenceScope)
        throw Error('stage_evidence_scope_mismatch')
      stageRow.evidenceScope = evidenceScope
    }
    if (routeInputAsset) {
      if (stageRow.routeInputAsset && stageRow.routeInputAsset !== routeInputAsset)
        throw Error('stage_route_input_mismatch')
      stageRow.routeInputAsset = routeInputAsset
    }
    stageRow.verifiedIssues += issues.length
    stageRow.verifiedScores += scores.length
    if (attestations.length)
      stageRow.minedDeliveryAttestations =
        (stageRow.minedDeliveryAttestations ?? 0) + attestations.length
    row.verifiedIssues += issues.length
    row.verifiedScores += scores.length
    row.paidExitProofs += attestations.length
    row.minedDeliveryAttestations += attestations.length
    for (const linkedEpisode of linkedDeliveries) {
      row.sameEpisodePaidExitProofs++
      row.observedRequestToPayoutSeconds.push(linkedEpisode.observedRequestToPayoutSeconds)
      stageRow.sameEpisodePaidExitProofs = (stageRow.sameEpisodePaidExitProofs ?? 0) + 1
      stageRow.observedRequestToPayoutSeconds ??= []
      stageRow.observedRequestToPayoutSeconds.push(linkedEpisode.observedRequestToPayoutSeconds)
    }
    for (const record of [...issues, ...scores, ...attestations]) {
      for (const label of ledger.labels(record)) {
        if (!/^[a-z0-9_]+$/.test(label)) throw Error('stage_label_invalid')
        stageRow.labels[label] = (stageRow.labels[label] ?? 0) + 1
      }
    }
    row.stages[stage] = stageRow
  }
  const groups = new Map()
  for (const subject of subjects.values()) {
    const group = groups.get(subject.route_key) ?? {
      routeKey: subject.route_key,
      subjects: 0,
      subjectsWithStageIssues: 0,
      verifiedIssues: 0,
      verifiedScores: 0,
      paidExitProofs: 0,
      minedDeliveryAttestations: 0,
      sameEpisodePaidExitProofs: 0,
      stages: {},
    }
    group.subjects++
    const found = bySubject.get(key(subject.route_key, subject.destination, subject.asset))
    if (found?.verifiedIssues) group.subjectsWithStageIssues++
    group.verifiedIssues += found?.verifiedIssues ?? 0
    group.verifiedScores += found?.verifiedScores ?? 0
    group.paidExitProofs += found?.paidExitProofs ?? 0
    group.minedDeliveryAttestations += found?.minedDeliveryAttestations ?? 0
    group.sameEpisodePaidExitProofs += found?.sameEpisodePaidExitProofs ?? 0
    for (const [stage, value] of Object.entries(found?.stages ?? {})) {
      const count = group.stages[stage] ?? { verifiedIssues: 0, verifiedScores: 0 }
      count.verifiedIssues += value.verifiedIssues
      count.verifiedScores += value.verifiedScores
      if (value.minedDeliveryAttestations)
        count.minedDeliveryAttestations =
          (count.minedDeliveryAttestations ?? 0) + value.minedDeliveryAttestations
      if (value.sameEpisodePaidExitProofs)
        count.sameEpisodePaidExitProofs =
          (count.sameEpisodePaidExitProofs ?? 0) + value.sameEpisodePaidExitProofs
      group.stages[stage] = count
    }
    groups.set(subject.route_key, group)
  }
  const subjectRows = [...subjects.values()].map(
    (subject) =>
      bySubject.get(key(subject.route_key, subject.destination, subject.asset)) ?? {
        routeKey: subject.route_key,
        destination: subject.destination,
        originalAsset: subject.asset,
        verifiedIssues: 0,
        verifiedScores: 0,
        stages: {},
        paidExitProofs: 0,
        minedDeliveryAttestations: 0,
        sameEpisodePaidExitProofs: 0,
        observedRequestToPayoutSeconds: [],
        calibratedImpairmentDurations: 0,
      },
  )
  const groupRows = [...groups.values()].map((group) => ({
    ...group,
    uncoveredSubjects: group.subjects - group.subjectsWithStageIssues,
  }))
  return {
    scope: 'holder_exit_stages_and_delivery',
    frozenGroups: groupRows.length,
    frozenSubjects: subjectRows.length,
    groupsWithStageIssues: groupRows.filter((row) => row.subjectsWithStageIssues > 0).length,
    subjectsWithStageIssues: subjectRows.filter((row) => row.verifiedIssues > 0).length,
    paidExitProofs: subjectRows.reduce((sum, row) => sum + row.paidExitProofs, 0),
    minedDeliveryAttestations: subjectRows.reduce(
      (sum, row) => sum + row.minedDeliveryAttestations,
      0,
    ),
    sameEpisodePaidExitProofs: subjectRows.reduce(
      (sum, row) => sum + row.sameEpisodePaidExitProofs,
      0,
    ),
    calibratedImpairmentDurations: 0,
    ...(quarantinedLegacyInitiation ? { quarantinedLegacyInitiation } : {}),
    groups: groupRows,
    subjects: subjectRows,
    outOfCohort,
  }
}

const caseLabels = (record, field, prefix) =>
  (record.cases ?? []).filter((row) => row[field]).map((row) => `${prefix}_${row[field]}`)

export async function readVerifiedHolderExitStageCoverage() {
  const [
    { buildSubjectManifest },
    apyIssue,
    apyScore,
    saturn,
    umbrella,
    susdeIssue,
    susdeScore,
    pendingIssue,
    pendingScore,
    minedDelivery,
    preanchor,
    requestToPayout,
    fluid,
    fluidUsdt,
    hastra,
    twynePt,
    susdeCommon,
    saturnConstants,
    umbrellaConstants,
    hastraConstants,
    apyConstants,
  ] = await Promise.all([
    import('../record-carry-cash-issues.mjs'),
    import('./carry-public-apyusd-exit-issue.mjs'),
    import('./carry-public-apyusd-exit-score.mjs'),
    import('./carry-local-staked-usdat-holder.mjs'),
    import('./carry-local-umbrella-gho-holder.mjs'),
    import('./susde-public-initiation-issue.mjs'),
    import('./susde-public-initiation-score.mjs'),
    import('./susde-public-pending-exit-issue.mjs'),
    import('./susde-public-pending-exit-score.mjs'),
    import('./susde-public-mined-delivery.mjs'),
    import('./susde-public-preanchor-request-proof.mjs'),
    import('./susde-public-request-to-payout-episode.mjs'),
    import('./carry-fluid-bridge-usdc-holder.mjs'),
    import('./carry-fluid-bridge-usdt-holder.mjs'),
    import('./pyusd-staking-prospective.mjs'),
    import('./carry-twyne-borrower-pt.mjs'),
    import('./susde-public-initiation-common.mjs'),
    import('../../lib/carry/stakedUsdatExit.ts'),
    import('../../lib/carry/umbrellaGhoExit.ts'),
    import('./pyusd-staking-economic-exit.mjs'),
    import('./carry-public-apyusd-exit-common.mjs'),
  ])
  const [
    manifest,
    apyIssues,
    apyScores,
    saturnRows,
    umbrellaRows,
    susdeIssues,
    susdeScores,
    pendingIssues,
    pendingScores,
    deliveryRows,
    fluidRows,
    fluidUsdtRows,
    hastraVerified,
    twynePtRows,
  ] = await Promise.all([
    buildSubjectManifest(),
    apyIssue.verifyApyUsdIssues(),
    apyScore.verifyApyUsdScores(),
    saturn.verifyAll(),
    umbrella.verifyAll(),
    susdeIssue.verifySusdeIssues(),
    susdeScore.verifySusdeScores(),
    pendingIssue.verifyIssues(),
    pendingScore.verifyScores(),
    minedDelivery.verifyDeliveries(),
    Promise.resolve(fluid.verifyLedgers()),
    Promise.resolve(fluidUsdt.verifyLedgers()),
    hastra.verify(),
    Promise.resolve(twynePt.verifyLedgers()),
  ])
  const linkedEpisodes = (
    await Promise.all(
      deliveryRows.map(async (delivery) => {
        const issueSequence = delivery.issueSequence
        if (!Number.isInteger(issueSequence) || issueSequence < 1)
          throw Error('stage_delivery_issue_invalid')
        const requestOut =
          issueSequence === 3
            ? preanchor.OUT
            : resolve(
                `data/research/venue-signals/susde-public-preanchor-request-issue-${issueSequence}`,
              )
        const { rows } = await preanchor.verifyPreanchor(
          requestOut,
          pendingIssue.OUT,
          pendingIssue.verifyIssues,
          issueSequence,
        )
        return rows.length ? requestToPayout.readVerifiedRequestToPayout({ issueSequence }) : null
      }),
    )
  ).filter(Boolean)
  const saturnRoute = saturnConstants.default ?? saturnConstants
  const umbrellaRoute = umbrellaConstants.default ?? umbrellaConstants
  // verify() cross-checks the three Hastra chains; readRows returns their
  // individually verified records after that cross-chain gate succeeds.
  if (!Number.isSafeInteger(hastraVerified.issues)) throw Error('stage_hastra_verification_invalid')
  const [hastraIssues, hastraScores] = await Promise.all([
    hastra.readRows('issues'),
    hastra.readRows('scores'),
  ])
  const susdeInitiation = partitionSusdeInitiationEvidence(susdeIssues, susdeScores)
  return auditHolderExitStages({
    manifest,
    quarantinedLegacyInitiation: {
      issueRecords: susdeInitiation.quarantinedIssues,
      scoreRecords: susdeInitiation.quarantinedScores,
      reason: 'selector_absent_from_deployed_vault',
    },
    ledgers: [
      {
        lane: 'apyusd',
        routeKey: apyConstants.ROUTE,
        destination: apyConstants.VAULT,
        originalAsset: apyConstants.ASSET,
        stage: 'request_initiation',
        issues: apyIssues,
        scores: apyScores,
        labels: (record) =>
          record.issueSequence
            ? caseLabels(record, 'outcome', 'target_initiation')
            : (record.cases ?? [])
                .filter((row) => row.baseline)
                .map((row) => `baseline_initiation_${row.baseline.status}`),
      },
      {
        lane: 'saturn',
        routeKey: saturnRoute.STAKED_USDAT_ROUTE,
        destination: saturnRoute.STAKED_USDAT_VAULT,
        originalAsset: saturnRoute.USDAT_ASSET,
        stage: 'queue_request',
        issues: saturnRows.issues,
        scores: saturnRows.scores,
        labels: (record) => [
          record.kind === 'issue'
            ? `baseline_queue_${record.measurement.outcome}`
            : `target_queue_${record.transition}`,
        ],
      },
      {
        lane: 'umbrella',
        routeKey: umbrellaRoute.UMBRELLA_GHO_ROUTE,
        destination: umbrellaRoute.UMBRELLA_STKGHO,
        originalAsset: umbrellaRoute.ORIGINAL_GHO,
        stage: 'cooldown_redeem_call',
        issues: umbrellaRows.issues,
        scores: umbrellaRows.scores,
        labels: (record) => [
          record.kind === 'issue'
            ? `baseline_cooldown_redeem_${record.measurement.outcome}`
            : `target_cooldown_redeem_${record.transition}`,
        ],
      },
      ...(susdeInitiation.deployedIssues.length || susdeInitiation.deployedScores.length
        ? [
            {
              lane: 'susde_initiation',
              routeKey: susdeCommon.ROUTE.routeKey,
              destination: susdeCommon.ROUTE.vault,
              originalAsset: susdeCommon.ROUTE.asset,
              stage: 'cooldown_initiation',
              issues: susdeInitiation.deployedIssues,
              scores: susdeInitiation.deployedScores,
              labels: (record) =>
                record.issueSequence
                  ? (record.cases ?? []).map(
                      (row) => `target_initiation_${row.outcome ?? row.status}`,
                    )
                  : (record.cases ?? []).map(
                      (row) => `baseline_initiation_${row.measurement?.status ?? row.status}`,
                    ),
            },
          ]
        : []),
      {
        lane: 'susde_pending',
        routeKey: susdeCommon.ROUTE.routeKey,
        destination: susdeCommon.ROUTE.vault,
        originalAsset: susdeCommon.ROUTE.asset,
        stage: 'pending_claim',
        issues: pendingIssues,
        scores: pendingScores,
        labels: (record) => [
          record.issueSequence ? `target_pending_${record.outcome}` : 'baseline_pending_observed',
        ],
      },
      {
        lane: 'susde_mined_delivery',
        routeKey: susdeCommon.ROUTE.routeKey,
        destination: susdeCommon.ROUTE.vault,
        originalAsset: susdeCommon.ROUTE.asset,
        stage: 'mined_delivery',
        issues: [],
        scores: [],
        attestations: deliveryRows,
        linkedEpisodes,
        labels: (record) => [
          linkedEpisodes.some(
            (episode) =>
              episode.status === 'linked_observed_episode' &&
              record.sha256 === episode.deliverySha256,
          )
            ? 'exact_usde_delivery_same_episode_observed'
            : 'exact_usde_delivery_episode_unresolved',
        ],
      },
      {
        lane: 'fluid_bridge_usdc',
        routeKey: fluid.ROUTE,
        destination: fluid.VAULT,
        originalAsset: fluid.USDC,
        stage: 'first_leg_simulation',
        issues: fluidRows.issues,
        scores: fluidRows.scores,
        labels: (record) =>
          record.issueSequence
            ? caseLabels(record, 'outcome', 'target_first_leg')
            : (record.baseline.cases ?? []).map(
                (row) => `baseline_first_leg_${row.measurement.simulation.status}`,
              ),
      },
      {
        lane: 'fluid_bridge_usdt',
        routeKey: fluidUsdt.ROUTE,
        destination: fluidUsdt.VAULT,
        originalAsset: fluidUsdt.USDC,
        routeInputAsset: fluidUsdt.USDT,
        evidenceScope: FLUID_USDT_SEED_SCOPE,
        stage: 'usdc_first_leg_simulation',
        issues: fluidUsdtRows.issues.filter(
          (record) => record.candidate?.sourceAttestation === FLUID_USDT_SEED_SCOPE,
        ),
        scores: fluidUsdtRows.scores.filter((record) =>
          fluidUsdtRows.issues.some(
            (issue) =>
              issue.sequence === record.issueSequence &&
              issue.candidate?.sourceAttestation === FLUID_USDT_SEED_SCOPE,
          ),
        ),
        labels: fluidUsdtStageLabels,
      },
      {
        lane: 'hastra_prime',
        routeKey: hastraConstants.ROUTE,
        destination: hastraConstants.PRIME,
        originalAsset: hastraConstants.WYLDS,
        routeInputAsset: hastraConstants.PYUSD,
        stage: 'prime_to_wylds_first_stage',
        issues: hastraIssues,
        scores: hastraScores,
        labels: (record) => [
          record.issueSequence
            ? `target_first_stage_${record.status === 'measured' ? record.measurement.assay.stage : record.status}`
            : `baseline_first_stage_${record.baseline.assay.stage}`,
        ],
      },
      {
        lane: 'twyne_borrower_pt_v1',
        routeKey: twynePt.ROUTE,
        destination: TWYNE_PT_WRAPPER,
        originalAsset: twynePt.ASSET,
        routeInputAsset: TWYNE_PT_INPUT_USDE,
        evidenceScope: TWYNE_PT_SCOPE,
        stage: 'borrower_authorized_pt_first_leg_simulation',
        issues: twynePtRows.issues,
        scores: twynePtRows.scores,
        labels: twynePtStageLabels,
      },
    ],
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3 || process.argv[2] !== '--verify')
    throw Error('usage: node --import tsx scripts/research/holder-exit-stage-coverage.mjs --verify')
  const audit = await readVerifiedHolderExitStageCoverage()
  process.stdout.write(`${JSON.stringify(audit)}\n`)
}
