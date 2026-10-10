// Node/API-only adapter. Its node:* and local-ledger imports must never enter a client bundle.
import { buildSubjectManifest } from '../../../../scripts/record-carry-cash-issues.mjs'
import { verifyLocalCarryCash } from '../../../../scripts/lib/localCarryCashStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  verifyLocalSupplementalAaveUsdeCash,
} from '../../../../scripts/lib/localSupplementalAaveUsdeCashStore.mjs'
import {
  LOCAL_CASH_PROSPECTIVE_V2_ROOT,
  evaluateCashProspectiveV2State,
  verifyCashProspectiveV2Ledger,
} from '../../../../scripts/lib/localCarryCashProspectiveV2Store.mjs'
import {
  VAULT5_V2_ROOT,
  evaluateVault5V2State,
  verifyVault5V2Ledger,
} from '../../../../scripts/lib/localCarryCashVault5V2Store.mjs'
import { CASH_V2_POLICY } from '../../../../scripts/research/carry-cash-prospective-v2-policy.mjs'
import {
  VAULT5_SUBJECTS,
  VAULT5_V2_POLICY,
} from '../../../../scripts/research/carry-cash-vault5-v2-policy.mjs'

if (typeof process === 'undefined' || !process.versions?.node)
  throw new Error('prospective_cash_model_server_only')

const CLAIM = 'aggregate_cash_proxy_only'

const identities = [
  ...CASH_V2_POLICY.subjects.map((subject) => ({
    lane: 'two_subject',
    subjectId: subject.id,
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.asset,
    horizonHours: CASH_V2_POLICY.horizonHours,
  })),
  ...VAULT5_SUBJECTS.map((subject) => ({
    lane: 'vault5',
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.asset,
    horizonHours: VAULT5_V2_POLICY.horizonHours,
  })),
]

const identityFields = (identity) => {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return {}
  try {
    return {
      routeKey: identity.routeKey,
      destination: identity.destination,
      asset: identity.asset,
      horizonHours: identity.horizonHours,
    }
  } catch {
    return {}
  }
}

const identityKey = (identity) => {
  const { routeKey, destination, asset, horizonHours } = identityFields(identity)
  return typeof routeKey === 'string' &&
    typeof destination === 'string' &&
    typeof asset === 'string' &&
    typeof horizonHours === 'number'
    ? `${routeKey}\0${destination}\0${asset}\0${horizonHours}`
    : null
}

const identityByKey = new Map(identities.map((identity) => [identityKey(identity), identity]))

const publicIdentity = (identity) => {
  const fields = identityFields(identity)
  return {
    routeKey: typeof fields.routeKey === 'string' ? fields.routeKey : null,
    destination: typeof fields.destination === 'string' ? fields.destination : null,
    asset: typeof fields.asset === 'string' ? fields.asset : null,
    horizonHours: fields.horizonHours === 24 ? 24 : null,
  }
}

const unavailable = (identity, reason) => ({
  status: 'unavailable',
  ...publicIdentity(identity),
  claim: CLAIM,
  holderExecutableExit: false,
  prospectiveValidated: false,
  schedule: null,
  outcome: null,
  interval: null,
  source: null,
  latestActiveIssue: null,
  reason,
})

const nowMs = (value) => {
  if (value == null) return Date.now()
  const parsed =
    value instanceof Date ? value.getTime() : Number.isFinite(value) ? value : Date.parse(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('prospective_cash_model_invalid_clock')
  return parsed
}

const latestActiveTwoSubjectIssue = (state, subjectId, at) => {
  const scored = new Set(state.scores.map((row) => row.payload.issueSha256))
  const issue = state.issues
    .filter(
      (row) =>
        row.payload.subjectId === subjectId &&
        !scored.has(row.sha256) &&
        Date.parse(row.payload.issuedAtUtc) <= at &&
        at <= Date.parse(row.payload.graceUntilUtc),
    )
    .at(-1)
  if (!issue) return null
  return {
    issuedAtUtc: issue.payload.issuedAtUtc,
    sourceAtUtc: issue.payload.source.sourceAtUtc,
    targetAtUtc: issue.payload.targetAtUtc,
    targetLowUtc: issue.payload.targetLowUtc,
    targetHighUtc: issue.payload.targetHighUtc,
    outcomeDueByUtc: issue.payload.graceUntilUtc,
    projection: {
      sourceCashRaw: issue.payload.source.cashRaw,
      pointRaw: issue.payload.projection.pointRaw,
      lowRaw: issue.payload.projection.lowRaw,
      highRaw: issue.payload.projection.highRaw,
      persistenceRaw: issue.payload.projection.persistenceRaw,
    },
  }
}

export function prospectiveCashModelFromTwoSubjectState(identity, state, evaluation, at) {
  const subject = evaluation.subjects.find(
    (row) =>
      row.subjectId === identity.subjectId &&
      row.routeKey === identity.routeKey &&
      row.destination === identity.destination &&
      row.asset === identity.asset &&
      row.horizonHours === identity.horizonHours,
  )
  if (!subject) throw new Error('prospective_cash_model_two_subject_identity')
  const scores = state.scores.filter((row) => row.payload.subjectId === identity.subjectId)
  const covered = scores.filter(
    (row) => row.payload.status === 'observed' && row.payload.outcome.covered,
  ).length
  const validated = subject.prospectiveValidated === true
  return {
    status: validated ? 'validated' : 'collecting',
    ...publicIdentity(identity),
    claim: CLAIM,
    holderExecutableExit: false,
    prospectiveValidated: validated,
    schedule: {
      scheduled: subject.expectedScheduleHours,
      onTime: subject.onTimeScheduleHours,
      missed: subject.expectedScheduleHours - subject.onTimeScheduleHours,
      coveragePercent: subject.scheduleCoveragePercent,
      current: subject.scheduleCurrent,
    },
    outcome: {
      issued: subject.independentIssued,
      observed: subject.independentObserved,
      censored: subject.censored,
      pending: subject.independentIssued - subject.independentObserved - subject.censored,
      availabilityPercent: subject.outcomeAvailabilityPercent,
    },
    interval: {
      observed: subject.independentObserved,
      covered,
      missed: subject.independentObserved - covered,
      coveragePercent: subject.intervalCoveragePercent,
    },
    source: {
      opportunities: subject.dueOpportunities,
      available: subject.sourceAvailableOpportunities,
      unavailable: subject.sourceUnavailableOpportunities,
      ineligible: 0,
      unassessed: 0,
      availabilityPercent: subject.sourceAvailabilityPercent,
    },
    latestActiveIssue: latestActiveTwoSubjectIssue(state, identity.subjectId, at),
  }
}

const latestActiveVault5Issue = (state, identity, at) => {
  const scored = new Set(state.scores.map((row) => row.content.issueSha256))
  const issue = state.issues
    .filter(
      (row) =>
        !scored.has(row.sha256) &&
        Date.parse(row.recordedAt) <= at &&
        at <= Date.parse(row.content.targetReceiptDeadline),
    )
    .at(-1)
  const attempt = issue?.content.attempts.find(
    (row) =>
      row.routeKey === identity.routeKey &&
      row.destination === identity.destination &&
      row.asset === identity.asset,
  )
  if (!issue || !attempt) return null
  return {
    issuedAtUtc: issue.recordedAt,
    sourceAtUtc: issue.content.sourceAt,
    targetAtUtc: new Date(
      Date.parse(issue.content.sourceAt) + VAULT5_V2_POLICY.horizonHours * 3_600_000,
    ).toISOString(),
    targetLowUtc: issue.content.targetLow,
    targetHighUtc: issue.content.targetHigh,
    outcomeDueByUtc: issue.content.targetReceiptDeadline,
    projection: {
      sourceCashRaw: attempt.sourceCashRaw,
      pointRaw: attempt.pointRaw,
      lowRaw: attempt.lowRaw,
      highRaw: attempt.highRaw,
      baselinePointRaw: attempt.baselinePointRaw,
      baselineLowRaw: attempt.baselineLowRaw,
      baselineHighRaw: attempt.baselineHighRaw,
    },
  }
}

export function prospectiveCashModelFromVault5State(identity, state, evaluation, at) {
  const subject = evaluation.bySubject.find(
    (row) =>
      row.routeKey === identity.routeKey &&
      row.destination === identity.destination &&
      row.asset === identity.asset,
  )
  if (!subject) throw new Error('prospective_cash_model_vault5_identity')
  const observedScores = state.scores.filter((row) => row.content.status === 'observed').length
  const censoredScores = state.scores.filter((row) => row.content.status === 'censored').length
  const validated = evaluation.cohortPassed === true && subject.passed === true
  const scheduleCoverage =
    evaluation.scheduledClusters === 0
      ? 0
      : Math.floor((evaluation.issuedClusters / evaluation.scheduledClusters) * 100)
  const outcomeCoverage =
    subject.issuedAttempts === 0
      ? 0
      : Math.floor((subject.completeClusters / subject.issuedAttempts) * 100)
  const intervalCoverage =
    subject.completeClusters === 0
      ? 0
      : Math.floor((subject.covered / subject.completeClusters) * 100)
  const sourceTicks = state.ticks ?? []
  const sourceAvailable = sourceTicks.filter((row) => row.content.status === 'issued').length
  const sourceUnavailable = sourceTicks.filter(
    (row) => row.content.reason === 'current_source_missing',
  ).length
  const sourceIneligible = sourceTicks.filter(
    (row) => row.content.reason === 'cluster_embargo',
  ).length
  const sourceUnassessed = sourceTicks.filter((row) => row.content.reason === 'slot_expired').length
  const sourceAssessed = sourceAvailable + sourceUnavailable
  return {
    status: validated ? 'validated' : 'collecting',
    ...publicIdentity(identity),
    claim: CLAIM,
    holderExecutableExit: false,
    prospectiveValidated: validated,
    schedule: {
      scheduled: evaluation.scheduledClusters,
      onTime: evaluation.issuedClusters,
      missed: evaluation.missedClusters,
      coveragePercent: scheduleCoverage,
    },
    outcome: {
      issued: subject.issuedAttempts,
      observed: observedScores,
      censored: censoredScores,
      pending: subject.issuedAttempts - observedScores - censoredScores,
      availabilityPercent: outcomeCoverage,
    },
    interval: {
      observed: subject.completeClusters,
      covered: subject.covered,
      missed: subject.completeClusters - subject.covered,
      coveragePercent: intervalCoverage,
    },
    source: {
      opportunities: sourceTicks.length,
      available: sourceAvailable,
      unavailable: sourceUnavailable,
      ineligible: sourceIneligible,
      unassessed: sourceUnassessed,
      availabilityPercent:
        sourceAssessed === 0 ? null : Math.floor((sourceAvailable / sourceAssessed) * 100),
    },
    latestActiveIssue: latestActiveVault5Issue(state, identity, at),
  }
}

async function loadTwoSubjectInputs(options) {
  if (options.inputs) return options.inputs
  const frozenManifest = options.frozenManifest ?? (await buildSubjectManifest())
  const supplementalManifest =
    options.supplementalManifest ??
    (await buildSupplementalAaveUsdeCashManifest({ issueManifest: frozenManifest }))
  return {
    frozen: {
      manifest: frozenManifest,
      verified: verifyLocalCarryCash(frozenManifest, options.frozenRoot),
    },
    supplemental: {
      manifest: supplementalManifest,
      verified: verifyLocalSupplementalAaveUsdeCash(supplementalManifest, options.supplementalRoot),
    },
  }
}

export async function readProspectiveCashModel(requestedIdentity, options = {}) {
  const requested = identityFields(requestedIdentity)
  const identity = identityByKey.get(identityKey(requested))
  if (!identity) return unavailable(requested, 'no_exact_model_match')
  try {
    const at = nowMs(options.now)
    if (identity.lane === 'two_subject') {
      const lane = options.twoSubject ?? {}
      const inputs = await loadTwoSubjectInputs(lane)
      const state = verifyCashProspectiveV2Ledger(
        inputs,
        lane.root ?? LOCAL_CASH_PROSPECTIVE_V2_ROOT,
        { recoverHead: false },
      )
      if (!state.enrollment) return unavailable(identity, 'prospective_ledger_unavailable')
      return prospectiveCashModelFromTwoSubjectState(
        identity,
        state,
        evaluateCashProspectiveV2State(state, at),
        at,
      )
    }
    const lane = options.vault5 ?? {}
    const manifest = lane.manifest ?? (await buildSubjectManifest())
    const state = verifyVault5V2Ledger(manifest, {
      cashRoot: lane.cashRoot,
      root: lane.root ?? VAULT5_V2_ROOT,
      recoverHead: false,
    })
    if (!state.enrollment) return unavailable(identity, 'prospective_ledger_unavailable')
    return prospectiveCashModelFromVault5State(identity, state, evaluateVault5V2State(state), at)
  } catch {
    return unavailable(identity, 'local_evidence_unavailable')
  }
}

export const PROSPECTIVE_CASH_MODEL_IDENTITIES = Object.freeze(
  identities.map(({ lane: _lane, subjectId: _subjectId, ...identity }) => Object.freeze(identity)),
)
