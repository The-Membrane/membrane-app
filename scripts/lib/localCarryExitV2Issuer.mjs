import {
  readUmbrellaGhoV2SeedHolders,
  UMBRELLA_GHO_SEED_SHA256,
} from './carry-exit-v2-umbrella-gho-seed.mjs'
import {
  sourceOwnedCarryExitV2Horizons,
  carryExitV2Predecessor,
} from './carry-exit-v2-umbrella-gho-policy.mjs'
import { createHash } from 'node:crypto'

import {
  appendLocalCarryExitV2Record,
  LOCAL_CARRY_EXIT_V2_ROOT,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'

const HOUR_MS = 3_600_000
const SOURCES = new Set(['morpho', 'direct', 'sync_vault', 'umbrella_gho'])
const UINT = /^(0|[1-9][0-9]*)$/
const POSITIVE_UINT = /^[1-9][0-9]*$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const SHA256 = /^[0-9a-f]{64}$/
const BASELINE = new Set(['success', 'covered_revert', 'ineligible', 'inconclusive', 'unavailable'])
const STORED_PLAN_KEYS = [
  'asset',
  'assetDecimals',
  'baselineBlock',
  'baselineBlockAt',
  'baselineHash',
  'baselineObservedAt',
  'candidateEvidenceDoc',
  'candidateEvidenceSha256',
  'candidateProvenance',
  'canonicalityEvidenceDoc',
  'captureDeadlineHours',
  'cases',
  'clock',
  'destination',
  'endpointSelection',
  'holder',
  'horizons',
  'omittedLadder',
  'routeKey',
  'slotAt',
  'version',
]
const STORED_CASE_KEYS = [
  'actualConsumedRaw',
  'assetsRaw',
  'baselineStatus',
  'callEvidenceDoc',
  'callEvidenceSha256',
  'coverageKind',
  'entitlementEvidenceDoc',
  'entitlementEvidenceSha256',
  'entitlementMethod',
  'holderCoverageRaw',
  'inconclusiveReason',
  'requiredCoverageRaw',
  'simulationStatus',
  'unavailableReason',
]
const CANDIDATE_SCHEMAS = {
  morpho: 'carry_exit_v2_morpho_candidate_v1',
  direct: 'carry_exit_v2_direct_candidate_v1',
  sync_vault: 'carry_exit_v2_sync_vault_candidate_v1',
  umbrella_gho: 'carry_exit_v2_umbrella_gho_candidate_v1',
}
const COVERAGE_KINDS = {
  morpho: 'morpho_shares_claim',
  direct: 'assets',
  sync_vault: 'shares',
  umbrella_gho: 'shares',
}
const sha = (value) => createHash('sha256').update(value).digest('hex')

function sourceName(source) {
  if (!SOURCES.has(source)) throw Error('local_exit_v2_source_invalid')
  return source
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw Error('local_exit_v2_time_invalid')
  return date.toISOString()
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  )
}

function exactIso(value) {
  return typeof value === 'string' && iso(value) === value
}

function nullable(value, predicate) {
  return value === null || predicate(value)
}

function validStoredCaseForStatus(source, entry) {
  const q = BigInt(entry.assetsRaw)
  const holder = entry.holderCoverageRaw === null ? null : BigInt(entry.holderCoverageRaw)
  const required = entry.requiredCoverageRaw === null ? null : BigInt(entry.requiredCoverageRaw)
  const consumed = entry.actualConsumedRaw === null ? null : BigInt(entry.actualConsumedRaw)
  const call = entry.callEvidenceDoc !== null && entry.callEvidenceSha256 !== null
  const noCall = entry.callEvidenceDoc === null && entry.callEvidenceSha256 === null
  const entitlement =
    entry.entitlementEvidenceDoc !== null && entry.entitlementEvidenceSha256 !== null
  const noEntitlement =
    entry.entitlementMethod === null &&
    entry.entitlementEvidenceDoc === null &&
    entry.entitlementEvidenceSha256 === null
  const coverage = entry.coverageKind === COVERAGE_KINDS[source]
  const noReasons = entry.inconclusiveReason === null && entry.unavailableReason === null
  if (entry.coverageKind === 'assets' && required !== q) return false
  if (entry.baselineStatus === 'success')
    return (
      coverage &&
      holder !== null &&
      required !== null &&
      required > 0n &&
      entry.simulationStatus === 'success' &&
      call &&
      noEntitlement &&
      noReasons &&
      (entry.coverageKind === 'assets'
        ? consumed === null && holder >= q
        : consumed !== null && consumed > 0n && consumed <= holder)
    )
  if (entry.baselineStatus === 'covered_revert')
    return (
      coverage &&
      holder !== null &&
      required !== null &&
      required > 0n &&
      consumed === null &&
      entry.simulationStatus === 'evm_revert' &&
      call &&
      noEntitlement &&
      noReasons &&
      (entry.coverageKind === 'morpho_shares_claim' ? required >= q : holder >= required)
    )
  if (entry.baselineStatus === 'ineligible')
    return (
      coverage &&
      holder !== null &&
      required !== null &&
      consumed === null &&
      entry.simulationStatus === null &&
      noCall &&
      entitlement &&
      entry.inconclusiveReason === null &&
      entry.unavailableReason === null &&
      ((['shares', 'morpho_shares_claim'].includes(entry.coverageKind) &&
        holder === 0n &&
        entry.entitlementMethod === 'zero_shares') ||
        (entry.coverageKind === 'morpho_shares_claim' &&
          holder > 0n &&
          required < q &&
          entry.entitlementMethod === 'morpho_claim_below_q') ||
        (entry.coverageKind === 'assets' &&
          holder < q &&
          entry.entitlementMethod === 'exact_asset_balance'))
    )
  if (entry.baselineStatus === 'inconclusive')
    return (
      coverage &&
      holder !== null &&
      required !== null &&
      consumed === null &&
      entry.simulationStatus !== 'success' &&
      ((entry.simulationStatus === 'evm_revert' && call) ||
        (entry.simulationStatus === null && noCall)) &&
      entry.entitlementMethod === null &&
      entitlement &&
      entry.inconclusiveReason !== null &&
      entry.unavailableReason === null
    )
  return (
    entry.baselineStatus === 'unavailable' &&
    entry.coverageKind === null &&
    holder === null &&
    required === null &&
    consumed === null &&
    entry.simulationStatus === null &&
    noCall &&
    noEntitlement &&
    entry.inconclusiveReason === null &&
    entry.unavailableReason !== null
  )
}

function assertPlan(plan) {
  if (
    !plan ||
    plan.version !== 'carry_exit_v2' ||
    plan.clock !== 'db_issued_at' ||
    plan.endpointSelection !== 'first_finalized_at_or_after_target' ||
    plan.captureDeadlineHours !== 2 ||
    JSON.stringify(plan.horizons) !== JSON.stringify(sourceOwnedCarryExitV2Horizons(plan)) ||
    !Array.isArray(plan.cases) ||
    !plan.cases.length ||
    plan.cases.length > 6 ||
    !Number.isInteger(plan.assetDecimals) ||
    plan.assetDecimals < 0 ||
    plan.assetDecimals > 36
  )
    throw Error('local_exit_v2_plan_invalid')
  for (const entry of plan.cases) {
    if (
      !UINT.test(entry?.assetsRaw ?? '') ||
      BigInt(entry.assetsRaw) === 0n ||
      !BASELINE.has(entry.baselineStatus)
    )
      throw Error('local_exit_v2_case_invalid')
  }
  if (new Set(plan.cases.map((entry) => entry.assetsRaw)).size !== plan.cases.length)
    throw Error('local_exit_v2_duplicate_q')
}

/**
 * Re-validate a plan read back from the authoritative SQL batch before a
 * local mirror is allowed. The original JSON object is returned unchanged.
 */
export function validateStoredLocalCarryExitV2Plan({ source, route, slotAt, plan }) {
  sourceName(source)
  assertPlan(plan)
  if (
    !exactKeys(plan, STORED_PLAN_KEYS) ||
    !route ||
    plan.routeKey !== route.routeKey ||
    plan.slotAt !== slotAt ||
    plan.destination !== route.destination ||
    plan.asset !== route.asset ||
    !exactIso(plan.slotAt) ||
    !ADDRESS.test(plan.destination) ||
    !ADDRESS.test(plan.asset) ||
    !ADDRESS.test(plan.holder) ||
    !POSITIVE_UINT.test(plan.baselineBlock ?? '') ||
    !BLOCK_HASH.test(plan.baselineHash ?? '') ||
    !exactIso(plan.baselineBlockAt) ||
    !exactIso(plan.baselineObservedAt) ||
    Date.parse(plan.baselineBlockAt) > Date.parse(plan.baselineObservedAt) ||
    !SHA256.test(plan.candidateEvidenceSha256 ?? '') ||
    !isRecord(plan.candidateEvidenceDoc) ||
    !isRecord(plan.canonicalityEvidenceDoc) ||
    !Array.isArray(plan.omittedLadder)
  )
    throw Error('local_exit_v2_stored_plan_invalid')

  const candidate = plan.candidateEvidenceDoc
  if (
    source === 'umbrella_gho' &&
    (candidate.seedSha256 !== UMBRELLA_GHO_SEED_SHA256 ||
      !readUmbrellaGhoV2SeedHolders().includes(plan.holder))
  )
    throw Error('local_exit_v2_umbrella_seed_identity_invalid')
  const expectedProvenance =
    source === 'umbrella_gho'
      ? new Set(['hash_bound_frozen_seed_pinned_eoa_claim'])
      : source === 'direct'
        ? new Set(['receipt_verified_transfer', 'receipt_verified_supply'])
        : new Set(['receipt_verified_transfer'])
  const labels = candidate?.ladder?.labels
  const selectedCommitment = sha(`${plan.destination}:${plan.holder}`)
  if (
    candidate.schema !== CANDIDATE_SCHEMAS[source] ||
    candidate.routeKey !== plan.routeKey ||
    candidate.destination !== plan.destination ||
    candidate.asset !== plan.asset ||
    candidate.baselineBlock !== plan.baselineBlock ||
    candidate.baselineHash !== plan.baselineHash ||
    candidate.selectedHolderCommitment !== selectedCommitment ||
    !Array.isArray(candidate.screenedCandidates) ||
    !candidate.screenedCandidates.some(
      (entry) =>
        isRecord(entry) &&
        entry.holderCommitment === selectedCommitment &&
        entry.status === 'eligible_holder',
    ) ||
    !Array.isArray(labels) ||
    labels.length !== (source === 'umbrella_gho' ? 1 : 6) ||
    !expectedProvenance.has(plan.candidateProvenance) ||
    JSON.stringify(
      labels.filter((entry) => entry?.assetsRaw !== null).map((entry) => entry.assetsRaw),
    ) !== JSON.stringify(plan.cases.map((entry) => entry.assetsRaw)) ||
    plan.omittedLadder.length !== labels.filter((entry) => entry?.assetsRaw === null).length
  )
    throw Error('local_exit_v2_stored_candidate_invalid')

  for (const entry of plan.cases) {
    if (
      !exactKeys(entry, STORED_CASE_KEYS) ||
      !POSITIVE_UINT.test(entry.assetsRaw ?? '') ||
      !nullable(entry.coverageKind, (value) => typeof value === 'string' && value.length > 0) ||
      !nullable(entry.holderCoverageRaw, (value) => UINT.test(value)) ||
      !nullable(entry.requiredCoverageRaw, (value) => UINT.test(value)) ||
      !nullable(entry.actualConsumedRaw, (value) => POSITIVE_UINT.test(value)) ||
      !nullable(entry.simulationStatus, (value) => ['success', 'evm_revert'].includes(value)) ||
      !nullable(entry.callEvidenceDoc, isRecord) ||
      !nullable(entry.callEvidenceSha256, (value) => SHA256.test(value)) ||
      !nullable(
        entry.entitlementMethod,
        (value) => typeof value === 'string' && value.length > 0,
      ) ||
      !nullable(entry.entitlementEvidenceDoc, isRecord) ||
      !nullable(entry.entitlementEvidenceSha256, (value) => SHA256.test(value)) ||
      !nullable(
        entry.inconclusiveReason,
        (value) => typeof value === 'string' && value.length > 0,
      ) ||
      !nullable(
        entry.unavailableReason,
        (value) => typeof value === 'string' && value.length > 0,
      ) ||
      !validStoredCaseForStatus(source, entry)
    )
      throw Error('local_exit_v2_stored_case_evidence_invalid')
  }
  return plan
}

/**
 * Recover the exact SQL plan into the local append-only journal. An issued DB
 * attempt must name the same batch; non-issued attempts may not hide a batch.
 */
export async function recoverLocalCarryExitV2IssuedSlot({
  source,
  route,
  slotAt,
  existingAttempt = null,
  loadStoredBatch,
  recordLocalIssues = appendLocalCarryExitV2IssuerIssues,
  recordedAt = new Date(),
}) {
  sourceName(source)
  if (typeof loadStoredBatch !== 'function') throw Error('local_exit_v2_batch_reader_required')
  const expectedBatchId =
    existingAttempt?.batch_id == null ? null : String(existingAttempt.batch_id)
  const stored = await loadStoredBatch(expectedBatchId)
  if (!stored) {
    if (existingAttempt?.status === 'issued') throw Error('local_exit_v2_issued_batch_missing')
    return null
  }
  if (
    !SHA256.test(stored.planSha256 ?? '') ||
    stored.digestIntegrity?.plan !== true ||
    stored.digestIntegrity?.candidate !== true ||
    stored.digestIntegrity?.cases !== true
  )
    throw Error('local_exit_v2_stored_digest_invalid')
  if (stored.childRowsValid !== true) throw Error('local_exit_v2_stored_children_invalid')
  if (
    !POSITIVE_UINT.test(String(stored.batchId ?? '')) ||
    (existingAttempt && existingAttempt.status !== 'issued') ||
    (existingAttempt?.status === 'issued' && expectedBatchId !== String(stored.batchId))
  )
    throw Error('local_exit_v2_attempt_batch_conflict')
  validateStoredLocalCarryExitV2Plan({ source, route, slotAt, plan: stored.plan })
  await recordLocalIssues({
    source,
    batchId: String(stored.batchId),
    plan: stored.plan,
    recordedAt,
  })
  return { batchId: String(stored.batchId), plan: stored.plan }
}

function localPlan(issuedAtUtc, plan) {
  const issuedMs = Date.parse(issuedAtUtc)
  return sourceOwnedCarryExitV2Horizons(plan).map((horizonH) => ({
    horizonH,
    predecessorH: carryExitV2Predecessor(plan.horizons, horizonH),
    conditionalRecovery: false,
    targetAtUtc: new Date(issuedMs + horizonH * HOUR_MS).toISOString(),
    deadlineAtUtc: new Date(issuedMs + (horizonH + 2) * HOUR_MS).toISOString(),
  }))
}

function issueId(source, batchId, caseIndex) {
  const batch = String(batchId)
  if (!/^[1-9][0-9]*$/.test(batch)) throw Error('local_exit_v2_batch_id_invalid')
  return `sql:${source}:${batch}:q:${caseIndex}`
}

/** Mirror one already-fsynced issuer attempt into the append-only V2 journal. */
export function appendLocalCarryExitV2IssuerAttempt(
  source,
  attempt,
  {
    root = LOCAL_CARRY_EXIT_V2_ROOT,
    now = Date.parse(attempt?.at),
    minFreeBytes,
    append = appendLocalCarryExitV2Record,
  } = {},
) {
  sourceName(source)
  const recordedAtUtc = iso(attempt?.at)
  const options = { root, now }
  if (minFreeBytes !== undefined) options.minFreeBytes = minFreeBytes
  return append(
    'attempt',
    {
      attemptId: `${source}:${sha(JSON.stringify(attempt))}`,
      stage: `${source}_issue`,
      status: attempt.status,
      attemptEnvelope: {
        schema: 'carry_local_exit_v2_issuer_attempt_v1',
        source,
        recordedAtUtc,
        issuerAttempt: attempt,
      },
    },
    options,
  )
}

function caseProofEnvelope(plan, entry) {
  return {
    schema: 'carry_local_exit_v2_issue_proof_v1',
    canonicalityEvidenceDoc: plan.canonicalityEvidenceDoc ?? null,
    candidateEvidenceSha256: plan.candidateEvidenceSha256 ?? null,
    candidateEvidenceDoc: plan.candidateEvidenceDoc ?? null,
    callEvidenceSha256: entry.callEvidenceSha256 ?? null,
    callEvidenceDoc: entry.callEvidenceDoc ?? null,
    entitlementEvidenceSha256: entry.entitlementEvidenceSha256 ?? null,
    entitlementEvidenceDoc: entry.entitlementEvidenceDoc ?? null,
  }
}

function caseIssueEnvelope(source, batchId, plan, entry, caseIndex) {
  return {
    schema: 'carry_local_exit_v2_issue_envelope_v1',
    authoritativeStore: 'carry_exit_v2_sql',
    authoritativeBatchId: String(batchId),
    source,
    sourcePlan: {
      version: plan.version,
      clock: plan.clock,
      endpointSelection: plan.endpointSelection,
      captureDeadlineHours: plan.captureDeadlineHours,
      horizons: plan.horizons,
      routeKey: plan.routeKey,
      slotAt: plan.slotAt,
      destination: plan.destination,
      asset: plan.asset,
      assetDecimals: plan.assetDecimals,
      holder: plan.holder,
      baselineBlock: plan.baselineBlock,
      baselineHash: plan.baselineHash,
      baselineBlockAt: plan.baselineBlockAt,
      candidateProvenance: plan.candidateProvenance,
      omittedLadder: plan.omittedLadder,
    },
    caseIndex,
    caseClassification: {
      assetsRaw: entry.assetsRaw,
      baselineStatus: entry.baselineStatus,
      coverageKind: entry.coverageKind,
      holderCoverageRaw: entry.holderCoverageRaw,
      requiredCoverageRaw: entry.requiredCoverageRaw,
      actualConsumedRaw: entry.actualConsumedRaw,
      simulationStatus: entry.simulationStatus,
      inconclusiveReason: entry.inconclusiveReason,
      unavailableReason: entry.unavailableReason,
    },
  }
}

/**
 * Append one local issue per exact Q after a SQL batch is known durable.
 * Existing records anchor partial-crash recovery to the original local clock.
 */
export function appendLocalCarryExitV2IssuerIssues(
  { source, batchId, plan, recordedAt = new Date() },
  {
    root = LOCAL_CARRY_EXIT_V2_ROOT,
    minFreeBytes,
    append = appendLocalCarryExitV2Record,
    verify = verifyLocalCarryExitV2Ledger,
  } = {},
) {
  sourceName(source)
  assertPlan(plan)
  const ids = plan.cases.map((_, index) => issueId(source, batchId, index))
  const state = verify({ root })
  const anchors = new Set(
    ids.map((id) => state.issues.get(id)?.payload.issuedAtUtc).filter(Boolean),
  )
  if (anchors.size > 1) throw Error('local_exit_v2_batch_clock_diverged')
  const observedAtUtc = iso(recordedAt)
  const issuedAtUtc = anchors.values().next().value ?? observedAtUtc
  const appendOptions = { root, now: Date.parse(observedAtUtc) }
  if (minFreeBytes !== undefined) appendOptions.minFreeBytes = minFreeBytes
  return plan.cases.map((entry, caseIndex) =>
    append(
      'issue',
      {
        issueId: ids[caseIndex],
        routeKey: plan.routeKey,
        destination: plan.destination,
        asset: plan.asset,
        decimals: plan.assetDecimals,
        assetsRaw: entry.assetsRaw,
        baselineStatus: entry.baselineStatus,
        baselineBlock: plan.baselineBlock,
        baselineHash: plan.baselineHash,
        baselineBlockAtUtc: plan.baselineBlockAt,
        issuedAtUtc,
        proofEnvelope: caseProofEnvelope(plan, entry),
        issueEnvelope: caseIssueEnvelope(source, batchId, plan, entry, caseIndex),
        plan: localPlan(issuedAtUtc, plan),
      },
      appendOptions,
    ),
  )
}
