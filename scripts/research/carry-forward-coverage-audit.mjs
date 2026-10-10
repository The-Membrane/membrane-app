// Read-only reconciliation of the public Carry registry and sealed H24 cash models.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as assessment from '../../lib/carry/holderExitAssessment.ts'
import * as projectionModule from '../../lib/carry/historicalCashProjection.ts'
import { localCarryCashObservationsFromVerified } from '../lib/localCarryCashStore.mjs'
import { verifyLocalCarryCashModelLedger } from '../lib/localCarryCashModelStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  localSupplementalAaveUsdeCashObservationsFromVerified,
  verifyLocalSupplementalAaveUsdeCash,
} from '../lib/localSupplementalAaveUsdeCashStore.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { exactH24PairsFromObservations } from './carry-cash-candidate-sweep.mjs'
import { readVerifiedHolderExitForceabilityMatrix } from './holder-exit-forceability-matrix.mjs'

const resolveHolderExitSubject =
  assessment.resolveHolderExitSubject ?? assessment.default?.resolveHolderExitSubject
const projectHistoricalCash =
  projectionModule.projectHistoricalCash ?? projectionModule.default?.projectHistoricalCash

export const SCHEMA = 'carry-forward-coverage-audit-v1'
export const REASONS = Object.freeze([
  'untouched_interval_failed',
  'untouched_point_failed',
  'model_selection_failed',
  'incomplete_history',
  'payout_data_unavailable',
  'exact_endpoint_unassessed',
])
const key = (row) => `${row.routeKey}\0${row.destination}\0${row.asset}`
const fail = (code) => {
  throw new Error(`carry_forward_coverage_${code}`)
}

export function summarizeForwardCoverage(subjects) {
  if (!Array.isArray(subjects) || subjects.length !== 68) fail('partition_size')
  const keys = new Set()
  for (const subject of subjects) {
    const identity = key(subject)
    if (keys.has(identity)) fail('partition_duplicate')
    keys.add(identity)
    if (subject.status === 'sealed_retrospective_model_eligible') {
      if (subject.reason !== null) fail('partition_eligible_reason')
    } else if (subject.status === 'sealed_retrospective_model_ineligible') {
      if (!REASONS.includes(subject.reason)) fail('partition_unclassified')
    } else fail('partition_status')
    if (
      subject.prospectiveValidated !== false ||
      subject.holderExecutableExit !== false ||
      subject.claim !== 'aggregate_cash_proxy_only'
    )
      fail('partition_claim')
  }
  const reasons = Object.fromEntries(
    REASONS.map((reason) => [reason, subjects.filter((row) => row.reason === reason).length]),
  )
  const eligible = subjects.filter((row) => row.status === 'sealed_retrospective_model_eligible')
  const ineligible = subjects.length - eligible.length
  if (eligible.length + Object.values(reasons).reduce((sum, value) => sum + value, 0) !== 68)
    fail('partition_total')
  return {
    claim: 'aggregate_cash_proxy_only',
    horizonHours: 24,
    evidenceScope: 'sealed_retrospective_model_eligibility',
    eligibleSubjects: eligible.length,
    eligibleRouteGroups: new Set(eligible.map((row) => row.routeKey)).size,
    ineligibleSubjects: ineligible,
    reasons,
    historicalBacktestOnly: true,
    liveIssueCountAssessed: false,
    prospectiveValidated: false,
    holderExecutableExit: false,
  }
}

function assertExactSet(rows, expected, label) {
  if (rows.length !== expected.length) fail(`${label}_count`)
  const found = new Set()
  for (const row of rows) {
    const identity = key(row)
    if (found.has(identity)) fail(`${label}_duplicate`)
    found.add(identity)
  }
  if (expected.some((row) => !found.has(key(row)))) fail(`${label}_missing`)
}

function diagnosticReason(subject, observations, plannedAt) {
  const panel = exactH24PairsFromObservations(observations, subject)
  if (panel.status !== 'pairs') return 'incomplete_history'
  const result = projectHistoricalCash({
    subjectKey: key(subject),
    horizonHours: 24,
    currentAt: plannedAt,
    currentCashRaw: panel.pairs.at(-1).targetCashRaw,
    pairs: panel.pairs,
  })
  if (
    result.baselineBand?.selectionCoveragePassed === true &&
    result.baselineBand.coveragePassed !== true
  )
    return 'untouched_interval_failed'
  if (result.reason === 'no_skill_over_persistence') return 'model_selection_failed'
  if (result.status === 'historical_projection') {
    if (result.holdout?.coveragePassed !== true) return 'untouched_interval_failed'
    if (result.holdout?.pointBeatsPersistence !== true) return 'untouched_point_failed'
  } else if (result.baselineBand?.selectionCoveragePassed === true) {
    if (result.baselineBand.coveragePassed !== true) return 'untouched_interval_failed'
  }
  fail('diagnostic_unclassified')
}

/** Pure partition check; callers must supply canonical verifier outputs. */
export function classifyForwardCoverage({
  registry,
  frozenManifest,
  enrollment,
  artifacts,
  cash,
  supplemental,
}) {
  if (typeof resolveHolderExitSubject !== 'function' || typeof projectHistoricalCash !== 'function')
    fail('resolver_unavailable')
  if (registry.length !== 68 || new Set(registry.map((row) => row.routeKey)).size !== 26)
    fail('public_registry_size')
  if (frozenManifest.subjects?.length !== 67 || frozenManifest.supplementalSubjects?.length !== 1)
    fail('frozen_manifest_size')
  const frozen = frozenManifest.subjects.map((row) => ({
    routeKey: row.route_key,
    destination: row.destination,
    asset: row.asset,
  }))
  const extra = frozenManifest.supplementalSubjects.map((row) => ({
    routeKey: row.route_key,
    destination: row.destination,
    asset: row.asset,
  }))
  assertExactSet(registry, [...frozen, ...extra], 'public_identity')
  if (
    !enrollment ||
    enrollment.manifestSha256 !== frozenManifest.sha256 ||
    enrollment.content?.qualificationPolicy !== 'untouched_holdout_v1' ||
    enrollment.content?.holderExecutableExit !== false ||
    enrollment.content?.claim !== 'aggregate_cash_proxy_only' ||
    !Array.isArray(enrollment.content?.cells) ||
    enrollment.content.cells.length !== 134
  )
    fail('enrollment_invalid')
  const cells = enrollment.content.cells.filter((row) => row.horizonHours === 24)
  assertExactSet(cells, frozen, 'enrollment_h24')
  const byCell = new Map(cells.map((row) => [key(row), row]))
  const plannedAt = enrollment.content.plannedAt
  const boundary = enrollment.content.cashLedgerSequenceBoundary
  if (
    !Number.isSafeInteger(boundary) ||
    boundary < 1 ||
    boundary > cash.records?.length ||
    cash.records[boundary - 1]?.sha256 !== enrollment.content.cashLedgerBoundarySha256
  )
    fail('cash_boundary')
  const frozenCash = {
    ...cash,
    records: cash.records.slice(0, boundary),
    count: boundary,
    last: cash.records[boundary - 1],
  }
  const frozenObservations = localCarryCashObservationsFromVerified(frozenCash)
  const subjects = registry.map((subject) => {
    const resolved = resolveHolderExitSubject(subject.routeKey, subject.destination)
    const payout = resolved?.payoutAsset
    if (!payout) fail('payout_unresolved')
    let status = 'sealed_retrospective_model_ineligible'
    let reason = null
    const isSupplemental = key(subject) === key(extra[0])
    const cell = isSupplemental ? null : byCell.get(key(subject))
    if (!isSupplemental && !cell) fail('cell_missing')
    if (
      resolved.kind === 'twyne_pt' ||
      (cell?.status === 'abstained' && cell.reason === 'subject_unassessed')
    ) {
      reason = 'exact_endpoint_unassessed'
    } else if (subject.asset.toLowerCase() !== payout.toLowerCase()) {
      reason = 'payout_data_unavailable'
    } else if (isSupplemental) {
      if (
        supplemental.manifestSha256 !== supplemental.manifest.sha256 ||
        supplemental.observations.length < 120
      )
        fail('supplemental_invalid')
      reason = diagnosticReason(subject, supplemental.observations, plannedAt)
    } else if (cell.status === 'enrolled') {
      const artifact = artifacts.get(cell.artifactContentSha256)
      if (
        !artifact ||
        artifact.content?.routeKey !== subject.routeKey ||
        artifact.content?.destination !== subject.destination ||
        artifact.content?.asset !== subject.asset ||
        artifact.content?.horizonHours !== 24 ||
        artifact.content?.holderExecutableExit !== false ||
        artifact.content?.prospectiveValidated !== false ||
        artifact.content?.claim !== 'aggregate_cash_proxy_only'
      )
        fail('artifact_invalid')
      status = 'sealed_retrospective_model_eligible'
    } else if (cell.status === 'abstained') {
      if (cell.reason === 'subject_unassessed') reason = 'exact_endpoint_unassessed'
      else if (cell.reason === 'insufficient_history') reason = 'incomplete_history'
      else if (cell.reason === 'model_selection_failed') reason = 'model_selection_failed'
      else if (cell.reason === 'untouched_holdout_failed') {
        reason = diagnosticReason(subject, frozenObservations, plannedAt)
        if (!['untouched_interval_failed', 'untouched_point_failed'].includes(reason))
          fail(`holdout_replay_mismatch_${subject.destination}_${reason}`)
      } else fail('cell_reason_unclassified')
    } else fail('cell_status_unclassified')
    if ((status === 'sealed_retrospective_model_ineligible') !== REASONS.includes(reason))
      fail('partition_invalid')
    return {
      ...subject,
      payoutAsset: payout.toLowerCase(),
      cohort: isSupplemental ? 'supplemental' : 'frozen',
      horizonHours: 24,
      status,
      reason,
      claim: 'aggregate_cash_proxy_only',
      historicalBacktestOnly: true,
      liveIssueCountAssessed: false,
      prospectiveValidated: false,
      holderExecutableExit: false,
    }
  })
  return {
    schema: SCHEMA,
    publicRegistry: { routeGroups: 26, exactSubjects: 68, identityVerified: true },
    retrospectiveModelEligibility: summarizeForwardCoverage(subjects),
    evidence: {
      frozenManifestSha256: frozenManifest.sha256,
      enrollmentSha256: enrollment.sha256,
      cashBoundarySha256: enrollment.content.cashLedgerBoundarySha256,
      supplementalManifestSha256: supplemental.manifestSha256,
      supplementalLastSha256: supplemental.lastSha256,
    },
    subjects,
  }
}

export async function runForwardCoverageAudit() {
  const frozenManifest = await buildSubjectManifest()
  const matrix = await readVerifiedHolderExitForceabilityMatrix()
  const registry = [...matrix.subjects, ...matrix.supplemental].map((row) => ({
    routeKey: row.routeKey,
    destination: row.destination.toLowerCase(),
    asset: row.originalAsset.toLowerCase(),
  }))
  const model = verifyLocalCarryCashModelLedger(frozenManifest)
  const enrollment = model.enrollments.at(-1)
  const manifest = await buildSupplementalAaveUsdeCashManifest({ issueManifest: frozenManifest })
  const verified = verifyLocalSupplementalAaveUsdeCash(manifest)
  return classifyForwardCoverage({
    registry,
    frozenManifest,
    enrollment,
    artifacts: model.artifacts,
    cash: model.cash,
    supplemental: {
      manifest,
      manifestSha256: verified.manifestSha256,
      lastSha256: verified.last?.sha256 ?? null,
      observations: localSupplementalAaveUsdeCashObservationsFromVerified(verified),
    },
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--summary')) {
    process.stderr.write('carry_forward_coverage_usage\n')
    process.exitCode = 2
  } else {
    runForwardCoverageAudit()
      .then((result) => {
        process.stdout.write(
          `${JSON.stringify(
            process.argv[2] === '--summary'
              ? {
                  publicRegistry: result.publicRegistry,
                  retrospectiveModelEligibility: result.retrospectiveModelEligibility,
                  evidence: result.evidence,
                }
              : result,
          )}\n`,
        )
      })
      .catch((error) => {
        process.stderr.write(`${String(error?.message ?? 'carry_forward_coverage_failed')}\n`)
        process.exitCode = 1
      })
  }
}
