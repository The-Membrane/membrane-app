import { UMBRELLA_GHO_ROUTE } from '../../../../scripts/lib/carry-exit-v2-umbrella-gho-proof.mjs'
import { classifyUmbrellaGhoScore } from '../../../../scripts/lib/carry-exit-v2-umbrella-gho-classifier.mjs'
// Node/API-only adapter. Its node:* and local-ledger imports must never enter a client bundle.
import {
  CARRY_EXIT_V2_HORIZONS,
  LOCAL_CARRY_EXIT_V2_ROOT,
  projectLocalCarryExitV2Coverage,
  verifyLocalCarryExitV2Ledger,
} from '../../../../scripts/lib/localCarryExitV2Store.mjs'
import { assembleCarryExitV2CallEvidence } from '../../../../scripts/lib/carry-exit-v2-proof-assembly.mjs'
import { validateIdentityPlan } from '../../../../scripts/lib/carry-exit-v2-independent-replay.mjs'
import { resolveCarryExitV2Route } from '../../../../scripts/lib/carry-exit-v2-rpc-proof.mjs'
import { classifyDirectScore } from '../../../../scripts/record-carry-direct-exit-v2-scores.mjs'
import { classifyMorphoScore } from '../../../../scripts/record-carry-morpho-exit-v2-scores.mjs'
import { classifySyncVaultScore } from '../../../../scripts/record-carry-sync-vault-exit-v2-scores.mjs'

if (typeof process === 'undefined' || !process.versions?.node)
  throw new Error('local_carry_exit_v2_read_server_only')

const ADDRESS = /^0x[0-9a-f]{40}$/
const UINT = /^(0|[1-9][0-9]*)$/
const VALIDATOR_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const CLAIM = 'local_exact_q_observation_only'
const REGISTRY_ID = 'carry-exit-v2-local-sealed-evidence-consistency-v1'
const CHAIN_LIMITATION = 'Local SHA chain has no external monotonic checkpoint or rollback proof.'

const SOURCE_CLASSIFIERS = Object.freeze({
  morpho: classifyMorphoScore,
  direct: classifyDirectScore,
  sync_vault: classifySyncVaultScore,
  umbrella_gho: classifyUmbrellaGhoScore,
})
const SUMMARY_FIELDS = Object.freeze([
  'status',
  'coverageKind',
  'holderCoverageRaw',
  'requiredCoverageRaw',
  'actualConsumedRaw',
  'simulationStatus',
  'entitlementMethod',
  'inconclusiveReason',
])

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function canonicalUtcMillis(value) {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null
  return parsed
}

function validateSealedScore(source, classify, { issueRecord, readbackRecord, scoreRecord, plan }) {
  try {
    const issue = issueRecord?.payload
    const readback = readbackRecord?.payload
    const score = scoreRecord?.payload
    const envelope = score?.scoreEnvelope
    const proof = score?.proofEnvelope
    const issueEnvelope = issue?.issueEnvelope
    const holder = issueEnvelope?.sourcePlan?.holder
    const target = proof?.targetEvidence
    const call = proof?.callEvidenceDoc
    if (
      issueRecord?.kind !== 'issue' ||
      readbackRecord?.kind !== 'readback' ||
      scoreRecord?.kind !== 'score' ||
      issueEnvelope?.schema !== 'carry_local_exit_v2_no_neon_issue_v1' ||
      issueEnvelope.authoritativeStore !== 'local_carry_exit_v2' ||
      issueEnvelope.source !== source ||
      issueEnvelope.authority?.clock !== 'local_operator_clock' ||
      issueEnvelope.authority?.issuedAtUtc !== issue.issuedAtUtc ||
      issueEnvelope.sourcePlan?.routeKey !== issue.routeKey ||
      issueEnvelope.sourcePlan?.destination !== issue.destination ||
      issueEnvelope.sourcePlan?.asset !== issue.asset ||
      issueEnvelope.sourcePlan?.assetDecimals !== issue.decimals ||
      issueEnvelope.sourcePlan?.baselineBlock !== issue.baselineBlock ||
      issueEnvelope.sourcePlan?.baselineHash !== issue.baselineHash ||
      issueEnvelope.sourcePlan?.baselineBlockAtUtc !== issue.baselineBlockAtUtc ||
      readback?.issueId !== issue.issueId ||
      readback?.issueSha256 !== issueRecord.sha256 ||
      readback?.readbackProof?.schema !== 'carry_local_exit_v2_readback_v1' ||
      readback.readbackProof.provenance !== 'same_machine_ledger_reopen' ||
      readback.readbackProof.independentProcess !== false ||
      readback.readbackProof.independentClock !== false ||
      readback.readbackProof.independentHost !== false ||
      readback.readbackProof.rollbackProof !== false ||
      canonicalUtcMillis(readback.readbackAtUtc) === null ||
      score?.issueId !== issue.issueId ||
      score?.horizonH !== plan?.horizonH ||
      score?.targetAtUtc !== plan?.targetAtUtc ||
      score?.deadlineAtUtc !== plan?.deadlineAtUtc ||
      score?.status !== envelope?.classification?.status ||
      envelope?.schema !== 'carry_local_exit_v2_score_envelope_v1' ||
      envelope.source !== source ||
      envelope.classifierId !== `carry_local_exit_v2_${source}_classifier_v1` ||
      envelope.issueSha256 !== issueRecord.sha256 ||
      envelope.readbackSha256 !== readbackRecord.sha256 ||
      envelope.holder !== holder ||
      envelope.assetsRaw !== issue.assetsRaw ||
      envelope.minedPayoutProven !== false ||
      envelope.prospectiveValidated !== false ||
      envelope.forecastValidated !== false ||
      envelope.holderExecutableExit !== false ||
      proof?.schema !== 'carry_local_exit_v2_score_proof_v1' ||
      proof.independentTimestamp !== false ||
      proof.localLedgerWitnessOnly !== true ||
      !ADDRESS.test(holder ?? '') ||
      score?.predecessorH !== plan.predecessorH ||
      canonicalUtcMillis(score?.scoredAtUtc) === null ||
      canonicalUtcMillis(envelope.classifiedAtUtc) === null ||
      score.scoredAtUtc !== scoreRecord.recordedAtUtc ||
      !target ||
      target.targetBlock !== score.targetBlock ||
      target.targetHash !== score.targetHash ||
      target.targetBlockAt !== score.targetBlockAtUtc ||
      target.targetObservedAt !== score.observedAtUtc ||
      target.canonicalityEvidenceDoc?.targetAt !== plan.targetAtUtc ||
      target.canonicalityEvidenceDoc?.observedAt !== target.targetObservedAt ||
      target.canonicalityEvidenceDoc?.targetHeader?.number !== target.targetBlock ||
      target.canonicalityEvidenceDoc?.targetHeader?.hash !== target.targetHash ||
      target.canonicalityEvidenceDoc?.targetHeader?.timestamp !== target.targetBlockAt ||
      target.canonicalityEvidenceDoc?.finalityTag !== 'finalized' ||
      target.canonicalityEvidenceDoc?.chainId !== '1' ||
      !call ||
      !call.identityEvidence ||
      !call.replayEvidenceDoc
    )
      return false

    const identity = {
      routeKey: issue.routeKey,
      destination: issue.destination,
      asset: issue.asset,
      holder,
      assetsRaw: issue.assetsRaw,
      blockNumber: target.targetBlock,
      blockHash: target.targetHash,
    }
    const identityEvidence = call.identityEvidence
    const targetDoc = target.canonicalityEvidenceDoc
    const targetBlock = String(target.targetBlock ?? '')
    const parentBlock = String(target.targetParentBlock ?? '')
    const timingValues = [
      issue.issuedAtUtc,
      issue.baselineBlockAtUtc,
      readback.readbackAtUtc,
      readbackRecord.recordedAtUtc,
      plan.targetAtUtc,
      plan.deadlineAtUtc,
      target.targetBlockAt,
      target.targetParentBlockAt,
      target.targetObservedAt,
      envelope.classifiedAtUtc,
      score.scoredAtUtc,
      scoreRecord.recordedAtUtc,
    ]
    if (!timingValues.every((value) => canonicalUtcMillis(value) !== null)) return false
    const [
      issuedAtMs,
      baselineAtMs,
      readbackAtMs,
      readbackRecordedAtMs,
      targetAtMs,
      deadlineAtMs,
      blockAtMs,
      parentAtMs,
      observedAtMs,
      capturedAtMs,
      scoredAtMs,
      scoreRecordedAtMs,
    ] = timingValues.map(canonicalUtcMillis)
    if (
      targetDoc?.schema !== 'carry_exit_v2_headers_v1' ||
      targetDoc.chainId !== '1' ||
      targetDoc.finalityTag !== 'finalized' ||
      targetDoc.baselineHeader?.number !== issue.baselineBlock ||
      targetDoc.baselineHeader?.hash !== issue.baselineHash ||
      targetDoc.baselineHeader?.timestamp !== issue.baselineBlockAtUtc ||
      targetDoc.targetHeader?.parentHash !== target.targetParentHash ||
      targetDoc.parentHeader?.number !== parentBlock ||
      targetDoc.parentHeader?.hash !== target.targetParentHash ||
      targetDoc.parentHeader?.timestamp !== target.targetParentBlockAt ||
      target.parentHeaderHash !== target.targetParentHash ||
      !UINT.test(targetBlock) ||
      !UINT.test(parentBlock) ||
      BigInt(targetBlock) !== BigInt(parentBlock) + 1n ||
      BigInt(targetBlock) <= BigInt(issue.baselineBlock) ||
      BigInt(targetDoc.finalizedHead?.number ?? '') < BigInt(targetBlock) ||
      parentAtMs >= targetAtMs ||
      blockAtMs < targetAtMs ||
      blockAtMs > deadlineAtMs ||
      observedAtMs < blockAtMs ||
      observedAtMs > deadlineAtMs ||
      observedAtMs > capturedAtMs ||
      capturedAtMs > scoredAtMs ||
      scoredAtMs > deadlineAtMs ||
      baselineAtMs > issuedAtMs ||
      baselineAtMs > readbackAtMs ||
      readbackAtMs > observedAtMs ||
      readbackRecordedAtMs >= observedAtMs ||
      readbackRecordedAtMs > deadlineAtMs ||
      scoredAtMs !== scoreRecordedAtMs ||
      identityEvidence.source !== `carry_local_exit_v2_${source}_score` ||
      identityEvidence.routeKey !== identity.routeKey ||
      identityEvidence.destination !== identity.destination ||
      identityEvidence.asset !== identity.asset ||
      identityEvidence.holder !== identity.holder ||
      identityEvidence.blockNumber !== identity.blockNumber ||
      identityEvidence.blockHash !== identity.blockHash
    )
      return false
    const route = resolveCarryExitV2Route(identity.routeKey, identity.destination, identity.asset)
    validateIdentityPlan(identityEvidence, identity, route)

    const decoded = classify({
      core: {
        issueId: issue.issueId,
        horizonH: plan.horizonH,
        targetAt: plan.targetAtUtc,
        deadlineAt: plan.deadlineAtUtc,
        predecessorH: plan.predecessorH,
      },
      target,
      verified: { status: 'verified', callEvidenceDoc: call },
      row: identity,
      capturedAt: envelope.classifiedAtUtc,
    })
    const reconstructed = assembleCarryExitV2CallEvidence({
      frozen: identity,
      collector: {
        status: 'raw_rpc_collected',
        blockNumber: target.targetBlock,
        blockHash: target.targetHash,
        routeKind: identityEvidence.kind,
        provider: identityEvidence.provider,
        source: identityEvidence.source,
        proof: call,
        identityEvidence,
      },
      replay: {
        status: 'verified',
        verdict: {
          simulationStatus: call.replayEvidenceDoc.decoded?.simulationStatus,
          coveredRevert: call.replayEvidenceDoc.decoded?.coveredRevert,
        },
        replayEvidenceDoc: call.replayEvidenceDoc,
      },
    })
    if (!sameJson(reconstructed, call)) return false

    const classification = envelope.classification
    for (const field of SUMMARY_FIELDS) {
      const actual = decoded[field] ?? null
      const sealed = classification[field] ?? null
      if (actual !== sealed) return false
    }
    return (
      score.status === decoded.status &&
      decoded.horizonH === plan.horizonH &&
      decoded.targetAt === plan.targetAtUtc &&
      decoded.deadlineAt === plan.deadlineAtUtc &&
      decoded.targetBlock === target.targetBlock &&
      decoded.targetHash === target.targetHash &&
      decoded.targetBlockAt === target.targetBlockAt &&
      decoded.targetObservedAt === target.targetObservedAt &&
      decoded.capturedAt === envelope.classifiedAtUtc
    )
  } catch {
    return false
  }
}

// These validators prove consistency of sealed local evidence only. The replay document records
// two origins, but this offline read does not contact either provider and makes no freshness claim.
export const LOCAL_CARRY_EXIT_V2_TRUSTED_SOURCE_VALIDATORS = Object.freeze(
  Object.entries(SOURCE_CLASSIFIERS).map(([source, classify]) =>
    Object.freeze({
      id: `local_${source}_sealed_evidence_v1`,
      matches: ({ issueRecord, scoreRecord }) =>
        issueRecord?.payload?.issueEnvelope?.source === source &&
        scoreRecord?.payload?.scoreEnvelope?.source === source,
      validate: (input) => validateSealedScore(source, classify, input),
    }),
  ),
)

const safeIdentity = (identity) => {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null
  try {
    const { routeKey, destination, asset, decimals, assetsRaw, horizonH } = identity
    if (
      typeof routeKey !== 'string' ||
      routeKey.length < 1 ||
      routeKey.length > 256 ||
      /[\u0000-\u001f]/.test(routeKey) ||
      !ADDRESS.test(destination ?? '') ||
      !ADDRESS.test(asset ?? '') ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 36 ||
      typeof assetsRaw !== 'string' ||
      assetsRaw.length > 78 ||
      !UINT.test(assetsRaw) ||
      BigInt(assetsRaw) <= 0n ||
      !(
        CARRY_EXIT_V2_HORIZONS.includes(horizonH) ||
        (routeKey === UMBRELLA_GHO_ROUTE.routeKey &&
          destination === UMBRELLA_GHO_ROUTE.destination &&
          asset === UMBRELLA_GHO_ROUTE.asset &&
          Number.isSafeInteger(horizonH) &&
          horizonH >= 1 &&
          horizonH <= 744)
      )
    )
      return null
    return { routeKey, destination, asset, decimals, assetsRaw, horizonH }
  } catch {
    return null
  }
}

const publicIdentity = (identity) => {
  try {
    return {
      routeKey: typeof identity?.routeKey === 'string' ? identity.routeKey : null,
      destination: typeof identity?.destination === 'string' ? identity.destination : null,
      asset: typeof identity?.asset === 'string' ? identity.asset : null,
      decimals: Number.isInteger(identity?.decimals) ? identity.decimals : null,
      assetsRaw: typeof identity?.assetsRaw === 'string' ? identity.assetsRaw : null,
      horizonH: Number.isInteger(identity?.horizonH) ? identity.horizonH : null,
    }
  } catch {
    return {
      routeKey: null,
      destination: null,
      asset: null,
      decimals: null,
      assetsRaw: null,
      horizonH: null,
    }
  }
}

const claims = () => ({
  claim: CLAIM,
  provenance: 'local_operator_clock',
  independentTimestamp: false,
  independentWitness: false,
  externalMonotonicCheckpoint: false,
  rollbackProof: false,
  minedPayoutProven: false,
  prospectiveValidated: false,
  forecastValidated: false,
  holderExecutableExit: false,
  calibratedForecast: false,
  chainLimitation: CHAIN_LIMITATION,
})

const unavailable = (identity, reason) => ({
  status: 'unavailable',
  ...publicIdentity(identity),
  ...claims(),
  measurementValidatorId: null,
  evidence: null,
  reason,
})

const parseNow = (value) => {
  try {
    if (value == null) return Date.now()
    const parsed =
      value instanceof Date ? value.getTime() : Number.isFinite(value) ? value : Date.parse(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  } catch {
    return null
  }
}

const trustedRegistry = (registry) => {
  if (!Array.isArray(registry) || registry.length > 64) return null
  const ids = new Set()
  const entries = []
  for (const entry of registry) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !VALIDATOR_ID.test(entry.id ?? '') ||
      typeof entry.matches !== 'function' ||
      typeof entry.validate !== 'function' ||
      ids.has(entry.id)
    )
      return null
    ids.add(entry.id)
    entries.push(entry)
  }
  return entries
}

const registryValidator = (entries) => (input) => {
  const matches = []
  for (const entry of entries) {
    const matched = entry.matches(input)
    if (typeof matched !== 'boolean') throw new Error('trusted_validator_match_invalid')
    if (matched) matches.push(entry)
  }
  if (matches.length !== 1) return false
  const validated = matches[0].validate(input)
  if (typeof validated !== 'boolean') throw new Error('trusted_validator_result_invalid')
  return validated
}

const sameSubject = (row, identity) =>
  row.routeKey === identity.routeKey &&
  row.destination === identity.destination &&
  row.asset === identity.asset &&
  row.decimals === identity.decimals &&
  row.assetsRaw === identity.assetsRaw

/**
 * Read one exact-Q horizon from the append-only local ledger.
 *
 * `validatorRegistry` is an internal dependency seam for focused tests. HTTP request data must not
 * be forwarded into it. Production uses the module-owned allowlist above.
 */
export function readLocalCarryExitV2Evidence(
  identity,
  {
    root = LOCAL_CARRY_EXIT_V2_ROOT,
    now = Date.now(),
    validatorRegistry = LOCAL_CARRY_EXIT_V2_TRUSTED_SOURCE_VALIDATORS,
  } = {},
) {
  const exact = safeIdentity(identity)
  if (!exact) return unavailable(identity, 'invalid_exact_identity')
  const at = parseNow(now)
  if (at === null) return unavailable(exact, 'invalid_clock')
  let validators
  try {
    validators = trustedRegistry(validatorRegistry)
  } catch {
    return unavailable(exact, 'trusted_validator_registry_invalid')
  }
  if (!validators) return unavailable(exact, 'trusted_validator_registry_invalid')

  let state
  try {
    state = verifyLocalCarryExitV2Ledger({ root })
  } catch {
    return unavailable(exact, 'ledger_verification_failed')
  }

  let projection
  try {
    projection = projectLocalCarryExitV2Coverage(state, at, {
      measurementValidator: registryValidator(validators),
      validatorId: REGISTRY_ID,
    })
  } catch {
    return unavailable(exact, 'trusted_projection_failed')
  }

  try {
    const subject = projection.subjects.find((row) => sameSubject(row, exact))
    if (!subject) return unavailable(exact, 'no_exact_subject')
    const cells = subject.cells.filter((row) => row.horizonH === exact.horizonH)
    if (cells.length === 0) return unavailable(exact, 'no_exact_horizon')
    const counts = {
      pending: 0,
      recorded_unverified: 0,
      measured: 0,
      missing: 0,
      censored: 0,
      unavailable: 0,
    }
    for (const cell of cells) {
      if (!Object.hasOwn(counts, cell.status)) throw new Error('public_status_invalid')
      counts[cell.status] += 1
    }
    const latest = [...cells].sort((a, b) => a.targetAtUtc.localeCompare(b.targetAtUtc)).at(-1)

    return {
      status: 'collecting',
      ...exact,
      ...claims(),
      measurementValidatorId: projection.measurementValidatorId,
      evidence: {
        issued: cells.length,
        pending: counts.pending,
        recordedUnverified: counts.recorded_unverified,
        measured: counts.measured,
        missing: counts.missing,
        censored: counts.censored,
        unavailable: counts.unavailable,
        due: cells.filter((cell) => cell.due).length,
        localReadbacks: cells.filter((cell) => cell.witnessed).length,
        latest: {
          targetAtUtc: latest.targetAtUtc,
          deadlineAtUtc: latest.deadlineAtUtc,
          status: latest.status,
          due: latest.due,
          localReadback: latest.witnessed,
        },
      },
    }
  } catch {
    return unavailable(exact, 'public_projection_failed')
  }
}
