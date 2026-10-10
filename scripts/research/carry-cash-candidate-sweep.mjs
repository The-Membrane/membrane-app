// Offline, subject-local candidate sweep for H24 aggregate-cash histories.
// The final chronological holdout is opened only after one candidate is fixed.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

import * as holderExitNamespace from '../../lib/carry/holderExitAssessment.ts'
import { readLocalCarryCashObservations } from '../lib/localCarryCashStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  readLocalSupplementalAaveUsdeCashObservations,
} from '../lib/localSupplementalAaveUsdeCashStore.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'

const resolveHolderExitSubject =
  holderExitNamespace.resolveHolderExitSubject ??
  holderExitNamespace.default?.resolveHolderExitSubject

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const MAX_RAW = (1n << 256n) - 1n
const RAW = /^(0|[1-9][0-9]*)$/
const ADDRESS = /^0x[0-9a-f]{40}$/

export const CASH_CANDIDATE_POLICY = Object.freeze({
  study: 'carry-h24-subject-local-candidate-sweep-v1',
  claim: 'aggregate_underlying_cash_proxy_only',
  horizonHours: 24,
  pairSelection: 'pinned_120_midnight_receipts_paired_adjacent_into_60_disjoint_h24_pairs',
  split: Object.freeze({ fit: 20, calibration: 20, selection: 10, untouchedHoldout: 10 }),
  minimumIntervalCoveragePercent: 80,
  learnedPointRule: 'strictly_lower_mae_than_persistence',
  selectionRule:
    'qualified candidates rank by point MAE then interval width; otherwise lock a diagnostic by coverage, point skill, MAE, width, then id',
  candidatePointRules: Object.freeze([
    'persistence',
    'last_change_persistence',
    'fit20_lower_median_delta',
    'recent10_lower_median_delta',
    'recent5_lower_median_delta',
    'fit20_lower_median_return_e18',
    'recent10_lower_median_return_e18',
    'recent5_lower_median_return_e18',
  ]),
  candidateBandRules: Object.freeze([
    'signed_empirical_residual_p05_p95',
    'split_conformal_absolute_residual_80',
  ]),
})

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
// A change to the candidate implementation requires an explicit new contract/version.
export const CASH_CANDIDATE_IMPLEMENTATION_CONTRACT =
  'v1:exact-subject;adjacent-disjoint-h24;fit20-calibration20-selection10-holdout10;lower-median;nearest-rank-p05-p95;split-conformal-ceil-n-plus-one-80;clamp-uint256;strict-mae;coverage-80;fixed-selection-order;diagnostic-ineligible'
export const CASH_CANDIDATE_CONTRACT_SHA256 = sha256(
  JSON.stringify({
    policy: CASH_CANDIDATE_POLICY,
    implementation: CASH_CANDIDATE_IMPLEMENTATION_CONTRACT,
  }),
)

export const CASH_CANDIDATE_V1_SNAPSHOTS = Object.freeze({
  frozen_august_2026: Object.freeze({
    manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
    anchorFrom: '2026-06-06T00:00:00.000Z',
    anchorThrough: '2026-10-03T00:00:00.000Z',
    firstReceiptSha256: '4ea4c9fc93698142078d36d332c47c9a04bfd5dbbb6f6e8e1d415e26d6465587',
    lastReceiptSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
    orderedReceiptsSha256: '53c02c40234934b2e4c8631596dddc15e7c20a340a8ce29321dfaabc2854e981',
  }),
  supplemental_aave_usde: Object.freeze({
    manifestSha256: '11647d6e15a5f6d18d96d016e5522b1dcbf452b45022992dd139c2fa9a0d6ede',
    anchorFrom: '2026-06-07T00:00:00.000Z',
    anchorThrough: '2026-10-04T00:00:00.000Z',
    firstReceiptSha256: '2ec2449bfaeef01341dc856cb51f24ae2db0f01ef42ec56d626e76f66b74795a',
    lastReceiptSha256: '368163df8a8b7b518caee9fe049f7664f4ef09d0e860c1333ec354e4f219cf2e',
    orderedReceiptsSha256: '48067c00411bd0f6a07b014230b54ec29065ff5a58b57e1ef8601be0a7120180',
  }),
})

export function pinnedCandidateObservations(observations, snapshot, manifestSha256) {
  if (manifestSha256 !== snapshot.manifestSha256) fail('candidate_sweep_snapshot_manifest')
  const daily = observations
    .filter(
      (row) =>
        row.collectionMode === 'retrospective' &&
        row.anchorAt >= snapshot.anchorFrom &&
        row.anchorAt <= snapshot.anchorThrough &&
        row.anchorAt.endsWith('T00:00:00.000Z'),
    )
    .sort((left, right) => left.anchorAt.localeCompare(right.anchorAt))
  if (
    daily.length !== 120 ||
    daily[0]?.anchorAt !== snapshot.anchorFrom ||
    daily.at(-1)?.anchorAt !== snapshot.anchorThrough ||
    daily[0]?.receiptSha256 !== snapshot.firstReceiptSha256 ||
    daily.at(-1)?.receiptSha256 !== snapshot.lastReceiptSha256 ||
    sha256(
      JSON.stringify(daily.map(({ anchorAt, receiptSha256 }) => ({ anchorAt, receiptSha256 }))),
    ) !== snapshot.orderedReceiptsSha256
  )
    fail('candidate_sweep_snapshot_receipts')
  return daily
}

const candidateSpecs = CASH_CANDIDATE_POLICY.candidatePointRules.flatMap((pointRule) =>
  CASH_CANDIDATE_POLICY.candidateBandRules.map((bandRule) => ({
    id: `${pointRule}__${bandRule}`,
    pointRule,
    bandRule,
  })),
)

const legacyLearnedId = 'fit20_lower_median_delta__signed_empirical_residual_p05_p95'
const legacyPersistenceId = 'persistence__signed_empirical_residual_p05_p95'

function fail(code) {
  throw new Error(code)
}

function raw(value, code = 'candidate_sweep_invalid_raw') {
  if (typeof value !== 'string' || !RAW.test(value) || value.length > 78) fail(code)
  const parsed = BigInt(value)
  if (parsed > MAX_RAW) fail(code)
  return parsed
}

function utc(value, code = 'candidate_sweep_invalid_time') {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isSafeInteger(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(code)
  return Date.parse(value)
}

const absolute = (value) => (value < 0n ? -value : value)
const clampRaw = (value) => (value < 0n ? 0n : value > MAX_RAW ? MAX_RAW : value)
const compareBigInt = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
const sorted = (values) => [...values].sort(compareBigInt)

function lowerMedian(values) {
  if (!values.length) fail('candidate_sweep_empty_median')
  const ordered = sorted(values)
  return ordered[Math.floor((ordered.length - 1) / 2)]
}

function nearestRank(values, numerator, denominator) {
  if (!values.length || numerator < 0 || numerator > denominator || denominator < 1)
    fail('candidate_sweep_invalid_percentile')
  const ordered = sorted(values)
  const rank = Math.max(1, Math.ceil((numerator * ordered.length) / denominator))
  return ordered[rank - 1]
}

function exactSubject(subject, payoutAsset) {
  if (
    !subject ||
    typeof subject.routeKey !== 'string' ||
    !subject.routeKey.trim() ||
    subject.routeKey.length > 256 ||
    typeof subject.destination !== 'string' ||
    !ADDRESS.test(subject.destination) ||
    typeof subject.asset !== 'string' ||
    !ADDRESS.test(subject.asset) ||
    typeof payoutAsset !== 'string' ||
    !ADDRESS.test(payoutAsset) ||
    subject.asset !== payoutAsset ||
    !Number.isInteger(subject.assetDecimals) ||
    subject.assetDecimals < 0 ||
    subject.assetDecimals > 255
  )
    fail('candidate_sweep_subject_payout_identity')
  return `${subject.routeKey}\0${subject.destination}\0${subject.asset}`
}

function checkedPairs(subjectKey, pairs) {
  if (!Array.isArray(pairs) || pairs.length !== 60) fail('candidate_sweep_pair_floor')
  let previousTargetAt = -Infinity
  return pairs.map((pair) => {
    if (pair?.subjectKey !== subjectKey) fail('candidate_sweep_pair_subject_identity')
    const sourceAt = utc(pair.sourceAt)
    const targetAt = utc(pair.targetAt)
    if (
      targetAt <= sourceAt ||
      Math.abs(targetAt - sourceAt - DAY_MS) > HOUR_MS ||
      sourceAt <= previousTargetAt
    )
      fail('candidate_sweep_horizon_embargo')
    const sourceCash = raw(pair.sourceCashRaw)
    const targetCash = raw(pair.targetCashRaw)
    previousTargetAt = targetAt
    return {
      sourceAt,
      targetAt,
      sourceAtUtc: pair.sourceAt,
      targetAtUtc: pair.targetAt,
      sourceCash,
      targetCash,
      delta: targetCash - sourceCash,
    }
  })
}

function pointDelta(fit, pointRule) {
  const deltas = fit.map((pair) => pair.delta)
  if (pointRule === 'persistence') return 0n
  if (pointRule === 'last_change_persistence') return deltas.at(-1)
  if (pointRule === 'fit20_lower_median_delta') return lowerMedian(deltas)
  if (pointRule === 'recent10_lower_median_delta') return lowerMedian(deltas.slice(-10))
  if (pointRule === 'recent5_lower_median_delta') return lowerMedian(deltas.slice(-5))
  fail('candidate_sweep_unknown_point_rule')
}

const RETURN_SCALE = 10n ** 18n

function candidatePointModel(fit, pointRule) {
  if (!pointRule.endsWith('_return_e18'))
    return { kind: 'delta', delta: pointDelta(fit, pointRule) }
  const window = pointRule.startsWith('fit20')
    ? fit
    : fit.slice(pointRule.startsWith('recent10') ? -10 : -5)
  if (window.some((pair) => pair.sourceCash === 0n)) return null
  const rates = window.map((pair) => (pair.delta * RETURN_SCALE) / pair.sourceCash)
  return { kind: 'return_e18', rate: lowerMedian(rates) }
}

function predictUnclamped(candidate, pair) {
  return candidate.pointModel.kind === 'delta'
    ? pair.sourceCash + candidate.pointModel.delta
    : pair.sourceCash + (pair.sourceCash * candidate.pointModel.rate) / RETURN_SCALE
}

function candidateFromPreHoldout(spec, fit, calibration) {
  const pointModel = candidatePointModel(fit, spec.pointRule)
  if (!pointModel) return null
  const residuals = calibration.map(
    (pair) => pair.targetCash - predictUnclamped({ pointModel }, pair),
  )
  let residualLow
  let residualHigh
  if (spec.bandRule === 'signed_empirical_residual_p05_p95') {
    residualLow = nearestRank(residuals, 5, 100)
    residualHigh = nearestRank(residuals, 95, 100)
  } else if (spec.bandRule === 'split_conformal_absolute_residual_80') {
    // Finite-sample split-conformal rank ceil((n + 1) * 0.8), n=20 -> 17.
    const ordered = sorted(residuals.map(absolute))
    const rank = Math.ceil(((ordered.length + 1) * 80) / 100)
    const radius = ordered[Math.min(ordered.length, rank) - 1]
    residualLow = -radius
    residualHigh = radius
  } else {
    fail('candidate_sweep_unknown_band_rule')
  }
  return { ...spec, pointModel, residualLow, residualHigh }
}

function assess(candidate, rows) {
  let covered = 0
  let pointError = 0n
  let persistenceError = 0n
  let widthTotal = 0n
  for (const pair of rows) {
    const center = predictUnclamped(candidate, pair)
    const point = clampRaw(center)
    const low = clampRaw(center + candidate.residualLow)
    const high = clampRaw(center + candidate.residualHigh)
    if (high < low) fail('candidate_sweep_inverted_band')
    if (pair.targetCash >= low && pair.targetCash <= high) covered++
    pointError += absolute(pair.targetCash - point)
    persistenceError += absolute(pair.targetCash - pair.sourceCash)
    widthTotal += high - low
  }
  const total = rows.length
  const pointBeatsPersistence = pointError < persistenceError
  const coveragePassed = covered * 100 >= total * 80
  return {
    covered,
    total,
    coveragePercent: (covered * 100) / total,
    coveragePassed,
    pointMae: { numeratorRaw: pointError.toString(), denominator: total },
    persistenceMae: { numeratorRaw: persistenceError.toString(), denominator: total },
    pointBeatsPersistence,
    meanBandWidthRaw: { numeratorRaw: widthTotal.toString(), denominator: total },
  }
}

function selectionQualified(candidate, assessment) {
  return (
    assessment.coveragePassed &&
    (candidate.pointRule === 'persistence' || assessment.pointBeatsPersistence)
  )
}

function candidateOrder(left, right) {
  const mae = compareBigInt(
    BigInt(left.selection.pointMae.numeratorRaw),
    BigInt(right.selection.pointMae.numeratorRaw),
  )
  if (mae) return mae
  const width = compareBigInt(
    BigInt(left.selection.meanBandWidthRaw.numeratorRaw),
    BigInt(right.selection.meanBandWidthRaw.numeratorRaw),
  )
  return width || left.id.localeCompare(right.id)
}

function diagnosticCandidateOrder(left, right) {
  if (left.selection.covered !== right.selection.covered)
    return right.selection.covered - left.selection.covered
  const leftPointGate =
    left.pointRule === 'persistence' || left.selection.pointBeatsPersistence ? 1 : 0
  const rightPointGate =
    right.pointRule === 'persistence' || right.selection.pointBeatsPersistence ? 1 : 0
  if (leftPointGate !== rightPointGate) return rightPointGate - leftPointGate
  return candidateOrder(left, right)
}

function partitionBounds(rows) {
  const windows = [
    ['fit', rows.slice(0, 20)],
    ['calibration', rows.slice(20, 40)],
    ['selection', rows.slice(40, 50)],
    ['untouchedHoldout', rows.slice(50, 60)],
  ]
  for (let index = 1; index < windows.length; index++) {
    if (windows[index - 1][1].at(-1).targetAt >= windows[index][1][0].sourceAt)
      fail('candidate_sweep_partition_embargo')
  }
  return Object.fromEntries(
    windows.map(([name, slice]) => [
      name,
      {
        count: slice.length,
        sourceFrom: slice[0].sourceAtUtc,
        targetThrough: slice.at(-1).targetAtUtc,
      },
    ]),
  )
}

/**
 * Evaluate one exact payout-asset subject. Candidate parameters use fit and
 * calibration; candidate choice uses selection; only that fixed candidate is
 * then scored on the final untouched holdout.
 */
export function evaluateCashCandidateSubject({ subject, payoutAsset, pairs, source }) {
  const subjectKey = exactSubject(subject, payoutAsset)
  const rows = checkedPairs(subjectKey, pairs)
  const fit = rows.slice(0, 20)
  const calibration = rows.slice(20, 40)
  const selection = rows.slice(40, 50)
  const holdout = rows.slice(50, 60)
  const candidates = candidateSpecs.flatMap((spec) => {
    const candidate = candidateFromPreHoldout(spec, fit, calibration)
    if (!candidate) return []
    const selectionAssessment = assess(candidate, selection)
    return [
      {
        ...candidate,
        selection: selectionAssessment,
        selectionQualified: selectionQualified(candidate, selectionAssessment),
      },
    ]
  })
  const legacyLearned = candidates.find((candidate) => candidate.id === legacyLearnedId)
  const legacyPersistence = candidates.find((candidate) => candidate.id === legacyPersistenceId)
  const legacyModelSelectionFailed =
    !legacyLearned.selectionQualified && !legacyPersistence.selection.coveragePassed
  const qualifiedSelection = candidates
    .filter((candidate) => candidate.selectionQualified)
    .sort(candidateOrder)[0]
  const selected = qualifiedSelection ?? [...candidates].sort(diagnosticCandidateOrder)[0]
  const selectedHoldout = selected ? assess(selected, holdout) : null
  const untouchedQualified = Boolean(
    selected &&
    selected.selectionQualified &&
    selectedHoldout.coveragePassed &&
    (selected.pointRule === 'persistence' || selectedHoldout.pointBeatsPersistence),
  )

  return {
    routeKey: subject.routeKey,
    destination: subject.destination,
    payoutAsset,
    assetDecimals: subject.assetDecimals,
    subjectKey,
    source,
    horizonHours: 24,
    split: partitionBounds(rows),
    legacy: {
      modelSelectionFailed: legacyModelSelectionFailed,
      learnedSelection: legacyLearned.selection,
      persistenceSelection: legacyPersistence.selection,
    },
    candidateSearch: {
      candidateCount: candidates.length,
      eligibleCandidates: candidates
        .filter((candidate) => candidate.selectionQualified)
        .map((candidate) => candidate.id),
      selectionDiagnostics: candidates.map((candidate) => ({
        id: candidate.id,
        pointRule: candidate.pointRule,
        bandRule: candidate.bandRule,
        selectionQualified: candidate.selectionQualified,
        selection: candidate.selection,
      })),
      selected: selected
        ? {
            id: selected.id,
            lockKind: selected.selectionQualified
              ? 'qualified_selection'
              : 'diagnostic_selection_failure',
            selectionQualified: selected.selectionQualified,
            pointRule: selected.pointRule,
            bandRule: selected.bandRule,
            pointModel:
              selected.pointModel.kind === 'delta'
                ? { kind: 'delta', deltaRaw: selected.pointModel.delta.toString() }
                : { kind: 'return_e18', rateRaw: selected.pointModel.rate.toString() },
            residualLowRaw: selected.residualLow.toString(),
            residualHighRaw: selected.residualHigh.toString(),
            selection: selected.selection,
          }
        : null,
    },
    untouchedHoldout: selectedHoldout,
    result: !legacyModelSelectionFailed
      ? 'outside_model_selection_failed_target'
      : untouchedQualified
        ? 'historically_qualified_candidate'
        : 'still_abstained',
    historicalCandidateQualified: legacyModelSelectionFailed && untouchedQualified,
    prospectiveValidated: false,
    holderExecutableExit: false,
  }
}

/** Extract exactly one identity-bound, disjoint H24 panel from verified observations. */
export function exactH24PairsFromObservations(observations, subject) {
  const daily = observations
    .filter(
      (observation) =>
        observation.collectionMode === 'retrospective' &&
        observation.anchorAt.endsWith('T00:00:00.000Z'),
    )
    .sort((left, right) => left.anchorAt.localeCompare(right.anchorAt))
    .slice(-120)
  if (daily.length !== 120) return { status: 'unavailable', reason: 'insufficient_history' }
  const subjectKey = `${subject.routeKey}\0${subject.destination}\0${subject.asset}`
  const pairs = []
  let assetDecimals = null
  for (let index = 0; index < daily.length; index += 1) {
    if (
      index &&
      Date.parse(daily[index].anchorAt) - Date.parse(daily[index - 1].anchorAt) !== DAY_MS
    )
      fail('candidate_sweep_anchor_grid')
  }
  for (let index = 0; index < daily.length; index += 2) {
    const source = daily[index]
    const target = daily[index + 1]
    const sourceRows = source.subjects.filter(
      (row) => row.routeKey === subject.routeKey && row.destination === subject.destination,
    )
    const targetRows = target.subjects.filter(
      (row) => row.routeKey === subject.routeKey && row.destination === subject.destination,
    )
    if (sourceRows.length !== 1 || targetRows.length !== 1)
      fail('candidate_sweep_observation_subject_identity')
    const sourceRow = sourceRows[0]
    const targetRow = targetRows[0]
    if (sourceRow.state !== 'observed' || targetRow.state !== 'observed')
      return { status: 'unavailable', reason: 'subject_not_observed' }
    if (
      sourceRow.asset !== subject.asset ||
      targetRow.asset !== subject.asset ||
      sourceRow.assetDecimals !== targetRow.assetDecimals ||
      (assetDecimals !== null && sourceRow.assetDecimals !== assetDecimals)
    )
      fail('candidate_sweep_observation_asset_identity')
    assetDecimals ??= sourceRow.assetDecimals
    raw(sourceRow.cashRaw)
    raw(targetRow.cashRaw)
    pairs.push({
      subjectKey,
      sourceAt: source.source.blockAt,
      targetAt: target.source.blockAt,
      sourceCashRaw: sourceRow.cashRaw,
      targetCashRaw: targetRow.cashRaw,
    })
  }
  return {
    status: 'pairs',
    assetDecimals,
    pairs,
    evidence: {
      observationCount: daily.length,
      pairCount: pairs.length,
      anchorFrom: daily[0].anchorAt,
      anchorThrough: daily.at(-1).anchorAt,
      firstReceiptSha256: daily[0].receiptSha256,
      lastReceiptSha256: daily.at(-1).receiptSha256,
    },
  }
}

export async function runCurrentCashCandidateSweep() {
  if (typeof resolveHolderExitSubject !== 'function')
    fail('candidate_sweep_payout_resolver_unavailable')
  const frozenManifest = await buildSubjectManifest()
  const supplementalManifest = await buildSupplementalAaveUsdeCashManifest({
    issueManifest: frozenManifest,
  })
  const panels = [
    {
      cohort: 'frozen_august_2026',
      manifestSha256: frozenManifest.sha256,
      subjects: frozenManifest.subjects.map((subject) => ({
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
      })),
      observations: readLocalCarryCashObservations(frozenManifest),
      snapshot: CASH_CANDIDATE_V1_SNAPSHOTS.frozen_august_2026,
    },
    {
      cohort: supplementalManifest.subjects[0].cohort_id,
      manifestSha256: supplementalManifest.sha256,
      subjects: supplementalManifest.subjects.map((subject) => ({
        routeKey: subject.route_key,
        destination: subject.destination,
        asset: subject.asset,
      })),
      observations: readLocalSupplementalAaveUsdeCashObservations(supplementalManifest),
      snapshot: CASH_CANDIDATE_V1_SNAPSHOTS.supplemental_aave_usde,
    },
  ]
  const evaluated = []
  const unavailable = []
  for (const panel of panels) {
    panel.observations = pinnedCandidateObservations(
      panel.observations,
      panel.snapshot,
      panel.manifestSha256,
    )
    for (const subject of panel.subjects) {
      const payoutAsset = resolveHolderExitSubject(
        subject.routeKey,
        subject.destination,
      ).payoutAsset.toLowerCase()
      if (payoutAsset !== subject.asset) {
        unavailable.push({
          routeKey: subject.routeKey,
          destination: subject.destination,
          cashAsset: subject.asset,
          payoutAsset,
          cohort: panel.cohort,
          reason: 'cash_payout_asset_mismatch',
        })
        continue
      }
      const extracted = exactH24PairsFromObservations(panel.observations, subject)
      if (extracted.status !== 'pairs') {
        unavailable.push({
          routeKey: subject.routeKey,
          destination: subject.destination,
          cashAsset: subject.asset,
          payoutAsset,
          cohort: panel.cohort,
          reason: extracted.reason,
        })
        continue
      }
      evaluated.push(
        evaluateCashCandidateSubject({
          subject: { ...subject, assetDecimals: extracted.assetDecimals },
          payoutAsset,
          pairs: extracted.pairs,
          source: {
            cohort: panel.cohort,
            manifestSha256: panel.manifestSha256,
            ...extracted.evidence,
          },
        }),
      )
    }
  }
  const targetSubjects = evaluated
    .filter((row) => row.legacy.modelSelectionFailed)
    .sort(
      (left, right) =>
        left.routeKey.localeCompare(right.routeKey) ||
        left.destination.localeCompare(right.destination),
    )
  return {
    study: CASH_CANDIDATE_POLICY.study,
    policy: CASH_CANDIDATE_POLICY,
    implementationContractSha256: CASH_CANDIDATE_CONTRACT_SHA256,
    snapshots: CASH_CANDIDATE_V1_SNAPSHOTS,
    historicalBacktestOnly: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
    corpus: {
      exactPublicSubjects: panels.reduce((total, panel) => total + panel.subjects.length, 0),
      exactPayoutIdentityWith60Pairs: evaluated.length,
      unavailable: unavailable.sort(
        (left, right) =>
          left.routeKey.localeCompare(right.routeKey) ||
          left.destination.localeCompare(right.destination),
      ),
    },
    summary: {
      modelSelectionFailedSubjects: targetSubjects.length,
      lockedBeforeHoldout: targetSubjects.filter((row) => row.candidateSearch.selected).length,
      selectionGatePassed: targetSubjects.filter(
        (row) => row.candidateSearch.selected?.selectionQualified,
      ).length,
      historicallyQualifiedCandidates: targetSubjects.filter(
        (row) => row.historicalCandidateQualified,
      ).length,
      stillAbstained: targetSubjects.filter((row) => !row.historicalCandidateQualified).length,
    },
    subjects: targetSubjects,
  }
}

async function main() {
  process.stdout.write(`${JSON.stringify(await runCurrentCashCandidateSweep(), null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Carry cash candidate sweep failed closed: ${error?.message ?? error}\n`)
    process.exitCode = 1
  })
}
