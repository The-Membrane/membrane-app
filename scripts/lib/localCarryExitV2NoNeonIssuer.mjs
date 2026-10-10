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
const SLOT_MS = 15 * 60_000
const SLOT_OFFSET_MS = 10 * 60_000
const ADDRESS = /^0x[0-9a-f]{40}$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const SOURCES = new Set(['morpho', 'direct', 'sync_vault', 'umbrella_gho'])
const BASELINE = new Set(['success', 'covered_revert', 'ineligible', 'inconclusive', 'unavailable'])
const PLAN_SEAL_SCHEMA = 'carry_local_exit_v2_no_neon_plan_seal_v1'
export const LOCAL_CARRY_EXIT_V2_RESUME_LIMIT = 3

function fail(code) {
  throw Error(`local_exit_v2_no_neon_${code}`)
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function canonicalValue(value, depth = 0) {
  if (depth > 24) fail('json_depth_invalid')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('json_number_invalid')
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, depth + 1))
  if (!plainObject(value)) fail('json_value_invalid')
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (!key || /[\u0000-\u001f]/.test(key)) fail('json_key_invalid')
    if (value[key] === undefined) fail('json_value_invalid')
    output[key] = canonicalValue(value[key], depth + 1)
  }
  return output
}

export function canonicalLocalCarryExitV2Json(value) {
  return JSON.stringify(canonicalValue(value))
}

export function hashLocalCarryExitV2Json(value) {
  return createHash('sha256').update(canonicalLocalCarryExitV2Json(value)).digest('hex')
}

function sourceName(source) {
  if (!SOURCES.has(source)) fail('source_invalid')
  return source
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== String(value instanceof Date ? date.toISOString() : value)
  )
    fail('time_invalid')
  return date.toISOString()
}

function nowMs(now) {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('clock_invalid')
  return value.getTime()
}

function planIdentity(plan) {
  return {
    schema: 'carry_local_exit_v2_episode_identity_v1',
    planSha256: hashLocalCarryExitV2Json(plan),
    routeKey: plan.routeKey,
    slotAtUtc: plan.slotAt,
    destination: plan.destination,
    asset: plan.asset,
    assetDecimals: plan.assetDecimals,
    holder: plan.holder,
    baselineBlock: plan.baselineBlock,
    baselineHash: plan.baselineHash,
    baselineBlockAtUtc: plan.baselineBlockAt,
    candidateEvidenceSha256: plan.candidateEvidenceSha256,
    assetsRaw: plan.cases.map((entry) => entry.assetsRaw),
  }
}

export function localCarryExitV2NativeSlotAt(slot) {
  if (!Number.isSafeInteger(slot)) fail('native_slot_invalid')
  const atMs = slot * SLOT_MS + SLOT_OFFSET_MS
  if (!Number.isSafeInteger(atMs) || !Number.isFinite(new Date(atMs).getTime()))
    fail('native_slot_invalid')
  return new Date(atMs).toISOString()
}

function nativeSlotFromAt(slotAtUtc) {
  const atMs = Date.parse(iso(slotAtUtc))
  const slot = (atMs - SLOT_OFFSET_MS) / SLOT_MS
  if (!Number.isSafeInteger(slot) || localCarryExitV2NativeSlotAt(slot) !== slotAtUtc)
    fail('native_slot_invalid')
  return slot
}

function validateSlotIdentity(identity, expectedSource) {
  if (
    !plainObject(identity) ||
    canonicalLocalCarryExitV2Json(Object.keys(identity).sort()) !==
      canonicalLocalCarryExitV2Json(
        ['asset', 'destination', 'routeKey', 'schema', 'slotAtUtc', 'source'].sort(),
      ) ||
    identity.schema !== 'carry_local_exit_v2_native_slot_identity_v1' ||
    sourceName(identity.source) !== expectedSource ||
    typeof identity.routeKey !== 'string' ||
    !identity.routeKey ||
    !ADDRESS.test(identity.destination ?? '') ||
    !ADDRESS.test(identity.asset ?? '')
  )
    fail('native_slot_identity_invalid')
  nativeSlotFromAt(identity.slotAtUtc)
  return identity
}

function planSlotIdentity(source, plan) {
  return validateSlotIdentity(
    {
      schema: 'carry_local_exit_v2_native_slot_identity_v1',
      source: sourceName(source),
      routeKey: plan.routeKey,
      slotAtUtc: plan.slotAt,
      destination: plan.destination,
      asset: plan.asset,
    },
    source,
  )
}

function routeSlotIdentity(source, route, slot) {
  if (!plainObject(route)) fail('route_invalid')
  return validateSlotIdentity(
    {
      schema: 'carry_local_exit_v2_native_slot_identity_v1',
      source: sourceName(source),
      routeKey: route.routeKey,
      slotAtUtc: localCarryExitV2NativeSlotAt(slot),
      destination: route.destination,
      asset: route.asset,
    },
    source,
  )
}

function planSealIdFromIdentity(source, identity) {
  validateSlotIdentity(identity, sourceName(source))
  return `local-plan-seal:${source}:${hashLocalCarryExitV2Json(identity).slice(0, 48)}`
}

export function localCarryExitV2PlanSealId(source, plan) {
  sourceName(source)
  validateLocalPlan(plan)
  return planSealIdFromIdentity(source, planSlotIdentity(source, plan))
}

export function localCarryExitV2EpisodeId(source, plan) {
  sourceName(source)
  validateLocalPlan(plan)
  return `local:${source}:${hashLocalCarryExitV2Json(planIdentity(plan)).slice(0, 48)}`
}

export function localCarryExitV2IssueId(source, plan, assetsRaw) {
  if (!UINT.test(assetsRaw ?? '') || BigInt(assetsRaw) === 0n) fail('q_invalid')
  return `${localCarryExitV2EpisodeId(source, plan)}:q:${hashLocalCarryExitV2Json(assetsRaw).slice(0, 16)}`
}

function validateEvidence(doc, digest, required) {
  if (doc == null) {
    if (digest !== null) fail('evidence_digest_without_doc')
    if (required) fail('evidence_missing')
    return
  }
  if (!plainObject(doc) || !Object.keys(doc).length || !SHA.test(digest ?? ''))
    fail('evidence_invalid')
  if (hashLocalCarryExitV2Json(doc) !== digest) fail('evidence_digest_invalid')
}

export function validateLocalPlan(plan) {
  if (
    !plainObject(plan) ||
    plan.version !== 'carry_exit_v2' ||
    !['db_issued_at', 'local_operator_clock'].includes(plan.clock) ||
    plan.endpointSelection !== 'first_finalized_at_or_after_target' ||
    plan.captureDeadlineHours !== 2 ||
    JSON.stringify(plan.horizons) !== JSON.stringify(sourceOwnedCarryExitV2Horizons(plan)) ||
    typeof plan.routeKey !== 'string' ||
    !plan.routeKey ||
    !ADDRESS.test(plan.destination ?? '') ||
    !ADDRESS.test(plan.asset ?? '') ||
    !Number.isInteger(plan.assetDecimals) ||
    plan.assetDecimals < 0 ||
    plan.assetDecimals > 36 ||
    !ADDRESS.test(plan.holder ?? '') ||
    !UINT.test(plan.baselineBlock ?? '') ||
    BigInt(plan.baselineBlock) === 0n ||
    !BLOCK_HASH.test(plan.baselineHash ?? '')
  )
    fail('plan_invalid')
  const slotAt = Date.parse(iso(plan.slotAt))
  const baselineAt = Date.parse(iso(plan.baselineBlockAt))
  const observedAt = Date.parse(iso(plan.baselineObservedAt))
  if (baselineAt > observedAt || observedAt < slotAt - 24 * HOUR_MS) fail('baseline_clock_invalid')
  validateEvidence(plan.candidateEvidenceDoc, plan.candidateEvidenceSha256, true)
  if (
    !plainObject(plan.canonicalityEvidenceDoc) ||
    !Object.keys(plan.canonicalityEvidenceDoc).length
  )
    fail('canonicality_evidence_invalid')
  if (!Array.isArray(plan.cases) || !plan.cases.length || plan.cases.length > 6)
    fail('cases_invalid')
  const amounts = new Set()
  for (const entry of plan.cases) {
    if (
      !plainObject(entry) ||
      !UINT.test(entry.assetsRaw ?? '') ||
      BigInt(entry.assetsRaw) === 0n ||
      amounts.has(entry.assetsRaw) ||
      !BASELINE.has(entry.baselineStatus)
    )
      fail('case_invalid')
    amounts.add(entry.assetsRaw)
    validateEvidence(entry.callEvidenceDoc, entry.callEvidenceSha256, false)
    validateEvidence(entry.entitlementEvidenceDoc, entry.entitlementEvidenceSha256, false)
    if (
      entry.baselineStatus !== 'unavailable' &&
      entry.callEvidenceDoc == null &&
      entry.entitlementEvidenceDoc == null
    )
      fail('case_evidence_missing')
  }
  return plan
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

function expectedIssueIds(source, plan) {
  return plan.cases.map((entry) => localCarryExitV2IssueId(source, plan, entry.assetsRaw))
}

function existingEpisode(state, source, plan, issuedAtUtc) {
  const episodeId = localCarryExitV2EpisodeId(source, plan)
  const ids = expectedIssueIds(source, plan)
  const rows = []
  for (const [index, id] of ids.entries()) {
    const row = state.issues.get(id)
    if (!row) continue
    const expected = localIssuePayload({
      source,
      plan,
      entry: plan.cases[index],
      episodeId,
      issuedAtUtc,
    })
    if (
      row.payload.issueEnvelope?.episodeId !== episodeId ||
      canonicalLocalCarryExitV2Json(row.payload) !== canonicalLocalCarryExitV2Json(expected)
    )
      fail('episode_payload_mismatch')
    rows.push(row)
  }
  const anchors = new Set(rows.map((row) => row.payload.issuedAtUtc))
  if (anchors.size > 1 || (anchors.size === 1 && !anchors.has(issuedAtUtc)))
    fail('episode_clock_diverged')
  return {
    episodeId,
    ids,
    rows,
    issuedAtUtc: anchors.values().next().value ?? null,
    complete: rows.length === ids.length,
  }
}

function slotIdentityKey(identity) {
  return canonicalLocalCarryExitV2Json(identity)
}

function issueMatchesSlotIdentity(record, source, identity) {
  const envelope = record.payload?.issueEnvelope
  const sourcePlan = envelope?.sourcePlan
  return (
    envelope?.source === source &&
    sourcePlan?.routeKey === identity.routeKey &&
    sourcePlan?.slotAtUtc === identity.slotAtUtc &&
    sourcePlan?.destination === identity.destination &&
    sourcePlan?.asset === identity.asset
  )
}

function validatePlanSealRecord({ source, identity, keyed, sameSlotIssues }) {
  const expectedId = planSealIdFromIdentity(source, identity)
  const envelope = keyed?.payload?.attemptEnvelope
  if (
    !keyed ||
    keyed.kind !== 'attempt' ||
    keyed.payload.attemptId !== expectedId ||
    keyed.payload.stage !== `${source}_plan_seal` ||
    keyed.payload.status !== 'sealed' ||
    !plainObject(envelope) ||
    envelope.authoritativeStore !== 'local_carry_exit_v2' ||
    envelope.source !== source ||
    slotIdentityKey(validateSlotIdentity(envelope.slotIdentity, source)) !==
      slotIdentityKey(identity) ||
    envelope.databaseUsed !== false ||
    envelope.databaseTimestamp !== null ||
    envelope.sqlBatchId !== null ||
    envelope.localOperatorClockOnly !== true ||
    envelope.independentTimestamp !== false ||
    envelope.externalMonotonicCheckpoint !== false ||
    envelope.rollbackProof !== false ||
    iso(envelope.sealedAtUtc) !== envelope.sealedAtUtc ||
    keyed.recordedAtUtc !== envelope.sealedAtUtc ||
    !plainObject(envelope.sourcePlan) ||
    hashLocalCarryExitV2Json(envelope.sourcePlan) !== envelope.sourcePlanSha256
  )
    fail('plan_seal_invalid')
  const sourcePlan = validateLocalPlan(envelope.sourcePlan)
  if (
    slotIdentityKey(planSlotIdentity(source, sourcePlan)) !== slotIdentityKey(identity) ||
    envelope.localEpisodeId !== localCarryExitV2EpisodeId(source, sourcePlan) ||
    Date.parse(sourcePlan.baselineObservedAt) > Date.parse(envelope.sealedAtUtc)
  )
    fail('plan_seal_invalid')
  const sealedIssueIds = new Set(expectedIssueIds(source, sourcePlan))
  if (sameSlotIssues.some((record) => !sealedIssueIds.has(record.payload.issueId)))
    fail('episode_slot_conflict')
  return {
    record: keyed,
    plan: sourcePlan,
    sealedAtUtc: envelope.sealedAtUtc,
    episodeId: envelope.localEpisodeId,
  }
}

function readPlanSealByIdentity(state, source, inputIdentity, { required = false } = {}) {
  const identity = validateSlotIdentity(inputIdentity, sourceName(source))
  const expectedId = planSealIdFromIdentity(source, identity)
  const sameSlotIssues = [...state.issues.values()].filter((record) =>
    issueMatchesSlotIdentity(record, source, identity),
  )
  const sameSlot = [...state.attempts.values()].filter((record) => {
    const envelope = record.payload?.attemptEnvelope
    return (
      envelope?.schema === PLAN_SEAL_SCHEMA &&
      slotIdentityKey(envelope.slotIdentity) === slotIdentityKey(identity)
    )
  })
  const keyed = state.attempts.get(expectedId) ?? null
  if (
    sameSlot.length > 1 ||
    (sameSlot.length === 1 && sameSlot[0] !== keyed) ||
    (keyed && !sameSlot.includes(keyed))
  )
    fail('plan_seal_conflict')
  if (!keyed) {
    if (sameSlotIssues.length) fail('plan_seal_missing_for_existing_episode')
    if (required) fail('plan_seal_missing')
    return null
  }
  return validatePlanSealRecord({ source, identity, keyed, sameSlotIssues })
}

function readPlanSeal(state, source, freshPlan, options) {
  return readPlanSealByIdentity(state, source, planSlotIdentity(source, freshPlan), options)
}

function unfinishedPlanSeals(state) {
  const sealGroups = new Map()
  const issueGroups = new Map()
  for (const record of state.attempts.values()) {
    const envelope = record.payload?.attemptEnvelope
    if (envelope?.schema !== PLAN_SEAL_SCHEMA) {
      if (record.payload?.attemptId?.startsWith('local-plan-seal:')) fail('plan_seal_invalid')
      continue
    }
    const source = sourceName(envelope.source)
    const identity = validateSlotIdentity(envelope.slotIdentity, source)
    const key = slotIdentityKey(identity)
    const group = sealGroups.get(key) ?? { source, identity, records: [] }
    if (group.source !== source) fail('plan_seal_conflict')
    group.records.push(record)
    sealGroups.set(key, group)
  }
  for (const record of state.issues.values()) {
    const envelope = record.payload?.issueEnvelope
    const sourcePlan = envelope?.sourcePlan
    if (!SOURCES.has(envelope?.source) || !plainObject(sourcePlan)) continue
    const identity = validateSlotIdentity(
      {
        schema: 'carry_local_exit_v2_native_slot_identity_v1',
        source: envelope.source,
        routeKey: sourcePlan.routeKey,
        slotAtUtc: sourcePlan.slotAtUtc,
        destination: sourcePlan.destination,
        asset: sourcePlan.asset,
      },
      envelope.source,
    )
    const key = slotIdentityKey(identity)
    const rows = issueGroups.get(key) ?? []
    rows.push(record)
    issueGroups.set(key, rows)
  }
  const candidates = []
  for (const [key, group] of sealGroups) {
    if (group.records.length !== 1) fail('plan_seal_conflict')
    const seal = validatePlanSealRecord({
      source: group.source,
      identity: group.identity,
      keyed: group.records[0],
      sameSlotIssues: issueGroups.get(key) ?? [],
    })
    const episode = existingEpisode(state, group.source, seal.plan, seal.sealedAtUtc)
    if (!episode.complete)
      candidates.push({
        source: group.source,
        identity: group.identity,
        slot: nativeSlotFromAt(group.identity.slotAtUtc),
        seal,
        missingIssues: episode.ids.length - episode.rows.length,
      })
  }
  return candidates.sort(
    (left, right) =>
      left.seal.sealedAtUtc.localeCompare(right.seal.sealedAtUtc) ||
      left.seal.record.sequence - right.seal.record.sequence ||
      left.seal.record.payload.attemptId.localeCompare(right.seal.record.payload.attemptId),
  )
}

function proofEnvelope(plan, entry) {
  return {
    schema: 'carry_local_exit_v2_no_neon_proof_v1',
    canonicalityEvidenceDoc: plan.canonicalityEvidenceDoc,
    candidateEvidenceSha256: plan.candidateEvidenceSha256,
    candidateEvidenceDoc: plan.candidateEvidenceDoc,
    callEvidenceSha256: entry.callEvidenceSha256 ?? null,
    callEvidenceDoc: entry.callEvidenceDoc ?? null,
    entitlementEvidenceSha256: entry.entitlementEvidenceSha256 ?? null,
    entitlementEvidenceDoc: entry.entitlementEvidenceDoc ?? null,
  }
}

function issueEnvelope({ source, plan, entry, episodeId, issuedAtUtc }) {
  return {
    schema: 'carry_local_exit_v2_no_neon_issue_v1',
    authoritativeStore: 'local_carry_exit_v2',
    episodeId,
    source,
    authority: {
      clock: 'local_operator_clock',
      issuedAtUtc,
      databaseUsed: false,
      databaseTimestamp: null,
      sqlBatchId: null,
      independentTimestamp: false,
      externalTimestampProof: false,
      externalMonotonicCheckpoint: false,
      rollbackProof: false,
    },
    sourcePlan: {
      version: plan.version,
      orchestratorClockLabel: plan.clock,
      appliedClock: 'local_operator_clock',
      endpointSelection: plan.endpointSelection,
      captureDeadlineHours: plan.captureDeadlineHours,
      horizons: plan.horizons,
      routeKey: plan.routeKey,
      slotAtUtc: plan.slotAt,
      destination: plan.destination,
      asset: plan.asset,
      assetDecimals: plan.assetDecimals,
      holder: plan.holder,
      baselineBlock: plan.baselineBlock,
      baselineHash: plan.baselineHash,
      baselineBlockAtUtc: plan.baselineBlockAt,
      baselineObservedAtUtc: plan.baselineObservedAt,
      candidateProvenance: plan.candidateProvenance ?? null,
      omittedLadder: plan.omittedLadder ?? [],
    },
    caseClassification: {
      assetsRaw: entry.assetsRaw,
      baselineStatus: entry.baselineStatus,
      coverageKind: entry.coverageKind ?? null,
      holderCoverageRaw: entry.holderCoverageRaw ?? null,
      requiredCoverageRaw: entry.requiredCoverageRaw ?? null,
      actualConsumedRaw: entry.actualConsumedRaw ?? null,
      simulationStatus: entry.simulationStatus ?? null,
      inconclusiveReason: entry.inconclusiveReason ?? null,
      unavailableReason: entry.unavailableReason ?? null,
    },
    claimBoundary: {
      localOperatorClockOnly: true,
      ethCallIsNotMinedPayout: true,
      holderExecutableExit: false,
      prospectiveValidated: false,
      forecastValidated: false,
    },
  }
}

function localIssuePayload({ source, plan, entry, episodeId, issuedAtUtc }) {
  return {
    issueId: localCarryExitV2IssueId(source, plan, entry.assetsRaw),
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
    proofEnvelope: proofEnvelope(plan, entry),
    issueEnvelope: issueEnvelope({
      source,
      plan,
      entry,
      episodeId,
      issuedAtUtc,
    }),
    plan: localPlan(issuedAtUtc, plan),
  }
}

function appendOptions(root, atMs, minFreeBytes) {
  const options = { root, now: atMs }
  if (minFreeBytes !== undefined) options.minFreeBytes = minFreeBytes
  return options
}

/**
 * Persistence callbacks for the three exported V2 issuer orchestrators.
 * The orchestrators keep their RPC, candidate and proof assembly code; every
 * database seam is replaced here before they run.
 */
export function createLocalCarryExitV2NoNeonPersistence({
  source,
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  now = () => new Date(),
  minFreeBytes,
  append = appendLocalCarryExitV2Record,
  verify = verifyLocalCarryExitV2Ledger,
} = {}) {
  sourceName(source)

  const ensurePlanSeal = (inputPlan) => {
    const freshPlan = validateLocalPlan(inputPlan)
    let state = verify({ root })
    let seal = readPlanSeal(state, source, freshPlan)
    if (seal) return seal
    const recordedAtMs = nowMs(now)
    const sealedAtUtc = new Date(recordedAtMs).toISOString()
    if (Date.parse(freshPlan.baselineObservedAt) > recordedAtMs) fail('issue_before_baseline')
    const slotIdentity = planSlotIdentity(source, freshPlan)
    const localEpisodeId = localCarryExitV2EpisodeId(source, freshPlan)
    try {
      append(
        'attempt',
        {
          attemptId: localCarryExitV2PlanSealId(source, freshPlan),
          stage: `${source}_plan_seal`,
          status: 'sealed',
          attemptEnvelope: {
            schema: PLAN_SEAL_SCHEMA,
            authoritativeStore: 'local_carry_exit_v2',
            source,
            slotIdentity,
            sealedAtUtc,
            sourcePlanSha256: hashLocalCarryExitV2Json(freshPlan),
            sourcePlan: freshPlan,
            databaseUsed: false,
            databaseTimestamp: null,
            sqlBatchId: null,
            localEpisodeId,
            localOperatorClockOnly: true,
            independentTimestamp: false,
            externalMonotonicCheckpoint: false,
            rollbackProof: false,
          },
        },
        appendOptions(root, recordedAtMs, minFreeBytes),
      )
    } catch (error) {
      // Another writer may have sealed this native slot after our read. Only
      // reuse a fully valid exact-slot seal; conflicting bytes remain fatal.
      state = verify({ root })
      seal = readPlanSeal(state, source, freshPlan)
      if (!seal) throw error
      return seal
    }
    state = verify({ root })
    return readPlanSeal(state, source, freshPlan, { required: true })
  }

  const completeSeal = (seal) => {
    const plan = seal.plan
    let state = verify({ root })
    let episode = existingEpisode(state, source, plan, seal.sealedAtUtc)
    const issuedAtUtc = seal.sealedAtUtc
    if (episode.issuedAtUtc !== null && episode.issuedAtUtc !== issuedAtUtc)
      fail('episode_clock_diverged')
    const missingIds = new Set(episode.ids.filter((id) => !state.issues.has(id)))
    if (!missingIds.size)
      return { episodeId: episode.episodeId, appended: 0, status: 'already_complete' }
    const recordedAtMs = nowMs(now)
    for (const entry of plan.cases) {
      const issueId = localCarryExitV2IssueId(source, plan, entry.assetsRaw)
      if (!missingIds.has(issueId)) continue
      append(
        'issue',
        localIssuePayload({
          source,
          plan,
          entry,
          episodeId: episode.episodeId,
          issuedAtUtc,
        }),
        appendOptions(root, recordedAtMs, minFreeBytes),
      )
    }
    state = verify({ root })
    episode = existingEpisode(state, source, plan, issuedAtUtc)
    if (!episode.complete) fail('episode_incomplete')
    return { episodeId: episode.episodeId, appended: missingIds.size, status: 'resumed' }
  }

  const persist = async (_sql, inputPlan) => {
    const seal = ensurePlanSeal(inputPlan)
    return completeSeal(seal).episodeId
  }

  const resumeSealedEpisode = async ({ route, slot }) => {
    const identity = routeSlotIdentity(source, route, slot)
    const state = verify({ root })
    const seal = readPlanSealByIdentity(state, source, identity)
    if (!seal) return null
    const result = completeSeal(seal)
    return {
      ...result,
      source,
      routeKey: identity.routeKey,
      destination: identity.destination,
      asset: identity.asset,
      slot,
      slotAtUtc: identity.slotAtUtc,
    }
  }

  const recover = async (_sql, plan) => {
    const freshPlan = validateLocalPlan(plan)
    const state = verify({ root })
    const seal = readPlanSeal(state, source, freshPlan)
    if (!seal) return null
    const episode = existingEpisode(state, source, seal.plan, seal.sealedAtUtc)
    return episode.complete ? episode.episodeId : null
  }

  const appendAttempt = async (attempt) => {
    if (!plainObject(attempt) || typeof attempt.status !== 'string' || !attempt.status)
      fail('attempt_invalid')
    const atUtc = iso(attempt.at)
    const { batchId, ...attemptWithoutBatch } = attempt
    const localEpisodeId = batchId == null ? null : String(batchId)
    if (localEpisodeId !== null && !localEpisodeId.startsWith(`local:${source}:`))
      fail('attempt_episode_id_invalid')
    return append(
      'attempt',
      {
        attemptId: `local-attempt:${source}:${hashLocalCarryExitV2Json(attempt).slice(0, 48)}`,
        stage: `${source}_issue`,
        status: attempt.status,
        attemptEnvelope: {
          schema: 'carry_local_exit_v2_no_neon_attempt_v1',
          authoritativeStore: 'local_carry_exit_v2',
          source,
          recordedAtUtc: atUtc,
          databaseUsed: false,
          databaseTimestamp: null,
          sqlBatchId: null,
          localEpisodeId,
          localOperatorClockOnly: true,
          issuerAttempt: attemptWithoutBatch,
        },
      },
      appendOptions(root, Date.parse(atUtc), minFreeBytes),
    )
  }

  const recordLocalIssues = async ({ source: requestedSource, batchId, plan }) => {
    if (requestedSource !== source) fail('post_persist_identity_invalid')
    const freshPlan = validateLocalPlan(plan)
    const state = verify({ root })
    const seal = readPlanSeal(state, source, freshPlan, { required: true })
    if (batchId !== seal.episodeId) fail('post_persist_identity_invalid')
    const episode = existingEpisode(state, source, seal.plan, seal.sealedAtUtc)
    if (!episode.complete) fail('post_persist_episode_incomplete')
    return {
      status: 'already_persisted_local',
      localEpisodeId: episode.episodeId,
      appended: 0,
    }
  }

  return Object.freeze({
    source,
    root,
    sql: noNeonSqlGuard,
    persist,
    hashEvidence: async (_sql, doc) => hashLocalCarryExitV2Json(doc),
    recordDbAttempt: async () => ({ status: 'local_only', databaseUsed: false }),
    recoverIssuedBatch: recover,
    recoverIssuedSlotBatch: async (_sql, _route, _slot, plan) => recover(_sql, plan),
    resumeSealedEpisode,
    recordLocalIssues,
    appendAttempt,
  })
}

export async function resumeLocalCarryExitV2SealedEpisode({ source, route, slot, ...options }) {
  return createLocalCarryExitV2NoNeonPersistence({ source, ...options }).resumeSealedEpisode({
    route,
    slot,
  })
}

export async function resumeLocalCarryExitV2UnfinishedSealedEpisodes({
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  now = () => new Date(),
  minFreeBytes,
  append = appendLocalCarryExitV2Record,
  verify = verifyLocalCarryExitV2Ledger,
  limit = LOCAL_CARRY_EXIT_V2_RESUME_LIMIT,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOCAL_CARRY_EXIT_V2_RESUME_LIMIT)
    fail('resume_limit_invalid')
  const candidates = unfinishedPlanSeals(verify({ root }))
  const resumed = []
  for (const candidate of candidates.slice(0, limit)) {
    const result = await resumeLocalCarryExitV2SealedEpisode({
      source: candidate.source,
      route: candidate.identity,
      slot: candidate.slot,
      root,
      now,
      minFreeBytes,
      append,
      verify,
    })
    if (!result) fail('resume_seal_disappeared')
    resumed.push(result)
  }
  return Object.freeze({
    status: 'local_sealed_episode_sweep_complete',
    limit,
    unfinishedBefore: candidates.length,
    resumedEpisodes: resumed.length,
    appendedIssues: resumed.reduce((total, result) => total + result.appended, 0),
    remaining: Math.max(0, candidates.length - resumed.length),
    episodes: Object.freeze(resumed),
  })
}

/** If an uninjected SQL seam escapes, fail before any network or storage claim. */
export function noNeonSqlGuard() {
  fail('database_access_forbidden')
}
