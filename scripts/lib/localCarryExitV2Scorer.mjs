import { reobserveUmbrellaGhoGate } from './carry-exit-v2-umbrella-gho-classifier.mjs'
import {
  appendLocalCarryExitV2Record,
  dueLocalCarryExitV2Targets,
  getLocalCarryExitV2Prior,
  LOCAL_CARRY_EXIT_V2_ROOT,
  verifyLocalCarryExitV2Ledger,
} from './localCarryExitV2Store.mjs'
import { resolveCarryExitV2Route, validateCarryExitV2RpcProof } from './carry-exit-v2-rpc-proof.mjs'
import { assembleCarryExitV2CallEvidence } from './carry-exit-v2-proof-assembly.mjs'

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const SOURCE_KINDS = Object.freeze({
  morpho: new Set(['morpho']),
  direct: new Set(['aave', 'spark', 'comet']),
  umbrella_gho: new Set(['umbrella_gho']),
  sync_vault: new Set(['susds', 'usd3', 'stusds', 'fluid', 'sgho']),
})
const MEASURED = new Set(['success', 'covered_revert', 'holder_attrition', 'inconclusive'])
const BASELINE_UNAVAILABLE = new Set(['ineligible', 'inconclusive', 'unavailable'])
const CENSORED_PREDECESSOR = new Set(['holder_attrition', 'censored', 'episode_censored'])

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isSafeInteger(date.getTime())) throw Error('local_exit_v2_score_clock_invalid')
  return date
}

function time(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw Error('local_exit_v2_score_time_invalid')
  return Date.parse(value)
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function sourceContext(issue, due) {
  const payload = issue.payload
  const envelope = payload.issueEnvelope
  const source = envelope?.source
  const holder = envelope?.sourcePlan?.holder
  let routeKind = null
  try {
    routeKind = resolveCarryExitV2Route(payload.routeKey, payload.destination, payload.asset).kind
  } catch {
    // This remains a typed unavailable denominator; never dispatch an unknown route.
  }
  const identityValid =
    Object.hasOwn(SOURCE_KINDS, source) &&
    ADDRESS.test(holder ?? '') &&
    SOURCE_KINDS[source].has(routeKind)
  const plan = payload.plan.find((entry) => entry.horizonH === due.horizonH)
  const row = {
    routeKey: payload.routeKey,
    destination: payload.destination,
    asset: payload.asset,
    holder,
    assetsRaw: payload.assetsRaw,
  }
  return { source, holder, routeKind, identityValid, plan, row }
}

function validateTarget({ target, issue, readback, due, plan, prior, observedMs }) {
  const doc = target?.canonicalityEvidenceDoc
  const targetBlock = String(target?.targetBlock ?? '')
  const parentBlock = String(target?.targetParentBlock ?? '')
  const baselineBlock = issue.payload.baselineBlock
  const predecessorBlock = prior.predecessorBlock
  if (
    !UINT.test(targetBlock) ||
    BigInt(targetBlock) === 0n ||
    !UINT.test(parentBlock) ||
    !HASH.test(target?.targetHash ?? '') ||
    !HASH.test(target?.targetParentHash ?? '') ||
    !HASH.test(target?.parentHeaderHash ?? '') ||
    target.targetParentHash !== target.parentHeaderHash ||
    BigInt(targetBlock) !== BigInt(parentBlock) + 1n ||
    BigInt(targetBlock) <= BigInt(baselineBlock) ||
    (predecessorBlock !== null && BigInt(targetBlock) <= BigInt(predecessorBlock)) ||
    doc?.schema !== 'carry_exit_v2_headers_v1' ||
    doc.chainId !== '1' ||
    doc.finalityTag !== 'finalized' ||
    doc.targetAt !== plan.targetAtUtc ||
    doc.observedAt !== target.targetObservedAt ||
    doc.baselineHeader?.number !== baselineBlock ||
    doc.baselineHeader?.hash !== issue.payload.baselineHash ||
    doc.baselineHeader?.timestamp !== issue.payload.baselineBlockAtUtc ||
    doc.targetHeader?.number !== targetBlock ||
    doc.targetHeader?.hash !== target.targetHash ||
    doc.targetHeader?.parentHash !== target.targetParentHash ||
    doc.targetHeader?.timestamp !== target.targetBlockAt ||
    doc.parentHeader?.number !== parentBlock ||
    doc.parentHeader?.hash !== target.parentHeaderHash ||
    doc.parentHeader?.timestamp !== target.targetParentBlockAt ||
    !UINT.test(doc.finalizedHead?.number ?? '') ||
    BigInt(doc.finalizedHead.number) < BigInt(targetBlock)
  )
    throw Error('local_exit_v2_target_identity_invalid')

  const targetAt = time(due.targetAtUtc)
  const deadlineAt = time(due.deadlineAtUtc)
  const parentAt = time(target.targetParentBlockAt)
  const blockAt = time(target.targetBlockAt)
  const observedAt = time(target.targetObservedAt)
  if (
    parentAt >= targetAt ||
    blockAt < targetAt ||
    blockAt > deadlineAt ||
    observedAt < blockAt ||
    observedAt > deadlineAt ||
    observedAt > observedMs ||
    observedAt <= time(readback.recordedAtUtc)
  )
    throw Error('local_exit_v2_target_time_invalid')
  return target
}

function usableAdapter(adapter) {
  return (
    adapter &&
    typeof adapter.id === 'string' &&
    /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(adapter.id) &&
    typeof adapter.chooseTarget === 'function' &&
    typeof adapter.measure === 'function' &&
    typeof adapter.classify === 'function'
  )
}

function validateMeasurement({ verified, context, target }) {
  const call = verified?.callEvidenceDoc
  if (
    verified?.status !== 'verified' ||
    call?.verificationStatus !== 'verified' ||
    call.identityEvidence?.schema !== 'carry_exit_v2_identity_v1' ||
    call.replayEvidenceDoc?.schema !== 'carry_exit_v2_independent_replay_v1'
  )
    throw Error('local_exit_v2_verified_measurement_required')
  const frozen = {
    ...context.row,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  }
  const decoded = validateCarryExitV2RpcProof({ proof: call, ...frozen })
  const identity = call.identityEvidence
  const replay = call.replayEvidenceDoc
  if (
    identity.routeKey !== frozen.routeKey ||
    identity.destination !== frozen.destination ||
    identity.asset !== frozen.asset ||
    identity.holder !== frozen.holder ||
    identity.kind !== context.routeKind ||
    identity.blockNumber !== frozen.blockNumber ||
    identity.blockHash !== frozen.blockHash ||
    replay.blockNumber !== frozen.blockNumber ||
    replay.blockHash !== frozen.blockHash ||
    replay.decoded?.simulationStatus !== decoded.simulationStatus ||
    replay.decoded?.holderCoverageRaw !== decoded.holderCoverageRaw ||
    replay.decoded?.requiredCoverageRaw !== decoded.requiredCoverageRaw ||
    replay.decoded?.actualConsumedRaw !== decoded.actualConsumedRaw
  )
    throw Error('local_exit_v2_measurement_identity_invalid')
  const reconstructed = assembleCarryExitV2CallEvidence({
    frozen,
    collector: {
      status: 'raw_rpc_collected',
      blockNumber: frozen.blockNumber,
      blockHash: frozen.blockHash,
      routeKind: decoded.routeKind,
      provider: identity.provider,
      source: identity.source,
      proof: call,
      identityEvidence: identity,
    },
    replay: {
      status: 'verified',
      verdict: {
        simulationStatus: decoded.simulationStatus,
        coveredRevert: decoded.coveredRevert,
      },
      replayEvidenceDoc: replay,
    },
  })
  if (JSON.stringify(reconstructed) !== JSON.stringify(call))
    throw Error('local_exit_v2_measurement_reconstruction_invalid')
  return decoded
}

function verifiedCoverageKind(routeKind) {
  if (routeKind === 'morpho') return 'morpho_shares_claim'
  return routeKind === 'umbrella_gho' || SOURCE_KINDS.sync_vault.has(routeKind)
    ? 'shares'
    : 'assets'
}

function validateClassification({ classification, context, target, capturedAtUtc, decoded }) {
  if (!classification || !MEASURED.has(classification.status))
    throw Error('local_exit_v2_classification_invalid')
  const exact = {
    horizonH: context.due.horizonH,
    targetAt: context.due.targetAtUtc,
    deadlineAt: context.due.deadlineAtUtc,
    predecessorH: context.prior.predecessorH,
    predecessorStatus: context.prior.predecessorStatus,
    targetBlock: target.targetBlock,
    targetHash: target.targetHash,
    targetBlockAt: target.targetBlockAt,
    targetObservedAt: target.targetObservedAt,
    capturedAt: capturedAtUtc,
  }
  for (const [field, value] of Object.entries(exact)) {
    if (classification[field] !== value) throw Error('local_exit_v2_classification_binding_invalid')
  }
  const holderCoverage = BigInt(decoded.holderCoverageRaw)
  const q = BigInt(context.row.assetsRaw)
  const attrited =
    context.source === 'umbrella_gho'
      ? holderCoverage === 0n || BigInt(decoded.holderClaimRaw) < q
      : context.source === 'direct'
        ? holderCoverage < q
        : holderCoverage === 0n
  const expectedStatus = attrited
    ? 'holder_attrition'
    : decoded.simulationStatus === 'success'
      ? 'success'
      : decoded.coveredRevert
        ? 'covered_revert'
        : 'inconclusive'
  const expectedSimulation = expectedStatus === 'holder_attrition' ? null : decoded.simulationStatus
  if (
    classification.status !== expectedStatus ||
    classification.coverageKind !== verifiedCoverageKind(context.routeKind) ||
    classification.holderCoverageRaw !== decoded.holderCoverageRaw ||
    classification.requiredCoverageRaw !== decoded.requiredCoverageRaw ||
    classification.actualConsumedRaw !== decoded.actualConsumedRaw ||
    classification.simulationStatus !== expectedSimulation
  )
    throw Error('local_exit_v2_classification_evidence_mismatch')
  return classification
}

function scorePayload({
  context,
  adapter,
  classification,
  verified,
  target,
  capturedAtUtc,
  recordedAtUtc,
}) {
  const summary = {
    status: classification.status,
    coverageKind: classification.coverageKind ?? null,
    holderCoverageRaw: classification.holderCoverageRaw ?? null,
    requiredCoverageRaw: classification.requiredCoverageRaw ?? null,
    actualConsumedRaw: classification.actualConsumedRaw ?? null,
    simulationStatus: classification.simulationStatus ?? null,
    entitlementMethod: classification.entitlementMethod ?? null,
    inconclusiveReason: classification.inconclusiveReason ?? null,
  }
  return {
    issueId: context.issue.payload.issueId,
    horizonH: context.due.horizonH,
    targetAtUtc: context.due.targetAtUtc,
    deadlineAtUtc: context.due.deadlineAtUtc,
    predecessorH: context.prior.predecessorH,
    predecessorSha256: context.prior.predecessorSha256,
    status: classification.status,
    scoredAtUtc: recordedAtUtc,
    targetBlock: target.targetBlock,
    targetHash: target.targetHash,
    targetBlockAtUtc: target.targetBlockAt,
    observedAtUtc: target.targetObservedAt,
    scoreEnvelope: {
      schema: 'carry_local_exit_v2_score_envelope_v1',
      source: context.source,
      classifierId: adapter.id,
      issueSha256: context.issue.sha256,
      readbackSha256: context.readback.sha256,
      holder: context.holder,
      assetsRaw: context.row.assetsRaw,
      classifiedAtUtc: capturedAtUtc,
      classification: summary,
      minedPayoutProven: false,
      prospectiveValidated: false,
      forecastValidated: false,
      holderExecutableExit: false,
    },
    proofEnvelope: {
      schema: 'carry_local_exit_v2_score_proof_v1',
      targetEvidence: target,
      callEvidenceDoc: verified.callEvidenceDoc,
      independentTimestamp: false,
      localLedgerWitnessOnly: true,
    },
  }
}

function controlPayload(context, status, capturedAtUtc) {
  return {
    issueId: context.issue.payload.issueId,
    horizonH: context.due.horizonH,
    targetAtUtc: context.due.targetAtUtc,
    deadlineAtUtc: context.due.deadlineAtUtc,
    predecessorH: context.prior.predecessorH,
    predecessorSha256: context.prior.predecessorSha256,
    status,
    scoredAtUtc: capturedAtUtc,
    targetBlock: null,
    targetHash: null,
    targetBlockAtUtc: null,
    observedAtUtc: null,
    scoreEnvelope: {
      schema: 'carry_local_exit_v2_control_v1',
      issueSha256: context.issue.sha256,
      readbackSha256: context.readback.sha256,
      predecessorStatus: context.prior.predecessorStatus,
      status,
      measurementAttempted: false,
      forecastValidated: false,
      holderExecutableExit: false,
    },
    proofEnvelope: {
      schema: 'carry_local_exit_v2_control_proof_v1',
      issueSha256: context.issue.sha256,
      predecessorSha256: context.prior.predecessorSha256,
      localLedgerWitnessOnly: true,
    },
  }
}

function missingPayload(context, status, reason, recordedAtUtc) {
  return {
    issueId: context.issue.payload.issueId,
    horizonH: context.due.horizonH,
    targetAtUtc: context.due.targetAtUtc,
    deadlineAtUtc: context.due.deadlineAtUtc,
    predecessorH: context.prior.predecessorH,
    predecessorSha256: context.prior.predecessorSha256,
    status,
    reason,
    receiptAtUtc: recordedAtUtc,
  }
}

function outcomeKey(issueId, horizonH) {
  return `${issueId}\u001f${horizonH}`
}

function appendOutcome(kind, payload, context, options) {
  const current = options.verify({ root: options.root })
  if (current.outcomes.has(outcomeKey(payload.issueId, payload.horizonH)))
    return { status: 'already_recorded', record: null }
  const issue = current.issues.get(payload.issueId)
  const readback = current.readbacks.get(payload.issueId)
  const prior = options.getPrior(current, payload.issueId, payload.horizonH)
  if (
    issue?.sha256 !== context.issue.sha256 ||
    readback?.sha256 !== context.readback.sha256 ||
    prior?.predecessorSha256 !== context.prior.predecessorSha256 ||
    prior?.predecessorStatus !== context.prior.predecessorStatus
  )
    throw Error('local_exit_v2_state_changed_before_append')
  const recorded = dateFrom(options.now())
  const recordedMs = recorded.getTime()
  if (recordedMs < options.notBeforeMs) throw Error('local_exit_v2_clock_regression_before_append')
  const deadlineMs = time(payload.deadlineAtUtc)
  if (kind === 'score' && recordedMs > deadlineMs)
    return { status: 'deadline_elapsed_before_append', record: null }
  if (kind === 'missing' && recordedMs < deadlineMs)
    throw Error('local_exit_v2_missing_before_deadline')
  const finalPayload = {
    ...payload,
    ...(kind === 'score'
      ? { scoredAtUtc: recorded.toISOString() }
      : { receiptAtUtc: recorded.toISOString() }),
  }
  const appendOptions = { root: options.root, now: recordedMs }
  if (options.minFreeBytes !== undefined) appendOptions.minFreeBytes = options.minFreeBytes
  try {
    return { status: 'appended', record: options.append(kind, finalPayload, appendOptions) }
  } catch (error) {
    const after = options.verify({ root: options.root })
    if (after.outcomes.has(outcomeKey(payload.issueId, payload.horizonH)))
      return { status: 'already_recorded', record: null }
    throw error
  }
}

/**
 * Score local exact-Q targets. Source callbacks may select and measure, but
 * this coordinator rechecks route, holder, Q, target, raw RPC proof, issue SHA,
 * readback SHA, and predecessor immediately before the append.
 */
export async function scoreDueLocalCarryExitV2({
  root = LOCAL_CARRY_EXIT_V2_ROOT,
  adapters = {},
  now = () => new Date(),
  limit = 48,
  minFreeBytes,
  verify = verifyLocalCarryExitV2Ledger,
  due = dueLocalCarryExitV2Targets,
  getPrior = getLocalCarryExitV2Prior,
  append = appendLocalCarryExitV2Record,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256)
    throw Error('local_exit_v2_score_limit_invalid')
  const scanMs = dateFrom(now()).getTime()
  const initial = verify({ root })
  const pending = due(initial, scanMs).slice(0, limit)
  const counts = {}
  const records = []
  const count = (status) => {
    counts[status] = (counts[status] ?? 0) + 1
  }

  for (const dueRow of pending) {
    const live = verify({ root })
    if (live.outcomes.has(outcomeKey(dueRow.issueId, dueRow.horizonH))) {
      count('already_recorded')
      continue
    }
    const issue = live.issues.get(dueRow.issueId)
    const readback = live.readbacks.get(dueRow.issueId)
    if (!issue || !readback || issue.sha256 !== dueRow.issueSha256) {
      count('state_unavailable')
      continue
    }
    const prior = getPrior(live, dueRow.issueId, dueRow.horizonH)
    if (!prior || prior.predecessorSha256 !== dueRow.predecessorSha256) {
      count('predecessor_changed')
      continue
    }
    const source = sourceContext(issue, dueRow)
    const context = {
      issue,
      readback,
      due: dueRow,
      prior,
      ...source,
      core: {
        issueId: dueRow.issueId,
        horizonH: dueRow.horizonH,
        targetAt: dueRow.targetAtUtc,
        deadlineAt: dueRow.deadlineAtUtc,
        predecessorH: prior.predecessorH,
        predecessorSha256: prior.predecessorSha256,
        predecessorStatus: prior.predecessorStatus,
        predecessorBlock: prior.predecessorBlock,
        predecessorHash: prior.predecessorHash,
        predecessorBlockAt: prior.predecessorBlockAtUtc,
      },
    }
    const current = dateFrom(now())
    const currentMs = current.getTime()
    const currentUtc = current.toISOString()
    const afterDeadline = currentMs > time(dueRow.deadlineAtUtc)
    const censored = CENSORED_PREDECESSOR.has(prior.predecessorStatus)
    const baselineUnavailable =
      BASELINE_UNAVAILABLE.has(issue.payload.baselineStatus) && !reobserveUmbrellaGhoGate(issue)
    const candidateAdapter = source.identityValid ? adapters[source.source] : null
    const adapter = usableAdapter(candidateAdapter) ? candidateAdapter : null

    if (afterDeadline) {
      const status = censored
        ? 'censored'
        : baselineUnavailable || !source.identityValid || !adapter
          ? 'unavailable'
          : 'missing'
      const reason = censored
        ? 'predecessor_ended_episode'
        : baselineUnavailable
          ? `baseline_${issue.payload.baselineStatus}`
          : !source.identityValid
            ? 'issue_identity_unusable'
            : !adapter
              ? 'source_adapter_unavailable'
              : 'target_window_unobserved'
      const outcome = appendOutcome(
        'missing',
        missingPayload(context, status, reason, currentUtc),
        context,
        { root, now, notBeforeMs: currentMs, minFreeBytes, verify, getPrior, append },
      )
      if (outcome.record) records.push(outcome.record)
      count(outcome.status === 'appended' ? status : outcome.status)
      continue
    }

    if (censored || baselineUnavailable) {
      const status = censored ? 'episode_censored' : 'not_eligible'
      const outcome = appendOutcome('score', controlPayload(context, status, currentUtc), context, {
        root,
        now,
        notBeforeMs: currentMs,
        minFreeBytes,
        verify,
        getPrior,
        append,
      })
      if (outcome.record) records.push(outcome.record)
      count(outcome.status === 'appended' ? status : outcome.status)
      continue
    }
    if (!source.identityValid) {
      count('issue_identity_unusable')
      continue
    }
    if (!adapter) {
      count('source_adapter_unavailable')
      continue
    }

    let target
    try {
      target = validateTarget({
        target: await adapter.chooseTarget(plain(context)),
        issue,
        readback,
        due: dueRow,
        plan: source.plan,
        prior,
        observedMs: dateFrom(now()).getTime(),
      })
    } catch {
      count('target_unavailable')
      continue
    }
    let verified, decoded
    try {
      verified = await adapter.measure(plain(context), plain(target))
      decoded = validateMeasurement({ verified, context, target })
    } catch {
      count('measurement_unavailable')
      continue
    }
    const captured = dateFrom(now())
    if (captured.getTime() > time(dueRow.deadlineAtUtc)) {
      count('deadline_elapsed_during_capture')
      continue
    }
    let classification
    try {
      classification = validateClassification({
        classification: await adapter.classify({
          core: plain(context.core),
          target: plain(target),
          verified: plain(verified),
          row: plain(context.row),
          capturedAt: captured.toISOString(),
        }),
        context,
        target,
        capturedAtUtc: captured.toISOString(),
        decoded,
      })
    } catch {
      count('classification_unavailable')
      continue
    }
    const recorded = dateFrom(now())
    if (
      recorded.getTime() < captured.getTime() ||
      recorded.getTime() > time(dueRow.deadlineAtUtc)
    ) {
      count('deadline_elapsed_during_classification')
      continue
    }
    const outcome = appendOutcome(
      'score',
      scorePayload({
        context,
        adapter,
        classification,
        verified,
        target,
        capturedAtUtc: captured.toISOString(),
        recordedAtUtc: recorded.toISOString(),
      }),
      context,
      {
        root,
        now,
        notBeforeMs: recorded.getTime(),
        minFreeBytes,
        verify,
        getPrior,
        append,
      },
    )
    if (outcome.record) records.push(outcome.record)
    count(outcome.status === 'appended' ? classification.status : outcome.status)
  }

  return {
    scanned: pending.length,
    truncated: due(initial, scanMs).length > pending.length,
    counts,
    records,
    provenance: 'local_operator_clock',
    independentTimestamp: false,
    independentWitness: false,
    minedPayoutProven: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
  }
}
