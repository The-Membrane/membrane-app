import { validateCarryExitV2RpcProof } from './carry-exit-v2-rpc-proof.mjs'

export const UMBRELLA_GHO_GATE_REASONS = Object.freeze([
  'paused',
  'no_shares',
  'cooldown_not_started',
  'waiting',
  'window_expired',
  'insufficient_covered_q',
])

/** Only this new source's sealed, raw-proven mechanical gates may be re-observed. */
export function reobserveUmbrellaGhoGate(issue) {
  const plan = issue?.payload?.issueEnvelope?.sourcePlan
  if (
    issue?.payload?.issueEnvelope?.source !== 'umbrella_gho' ||
    issue.payload.baselineStatus !== 'inconclusive'
  )
    return false
  const entry = issue.payload.issueEnvelope.caseClassification
  const call = issue.payload.proofEnvelope?.callEvidenceDoc
  if (!UMBRELLA_GHO_GATE_REASONS.includes(entry?.inconclusiveReason)) return false
  try {
    const decoded = validateCarryExitV2RpcProof({
      proof: call,
      routeKey: plan.routeKey,
      destination: plan.destination,
      asset: plan.asset,
      holder: plan.holder,
      assetsRaw: issue.payload.assetsRaw,
      blockNumber: plan.baselineBlock,
      blockHash: plan.baselineHash,
    })
    return (
      decoded.routeKind === 'umbrella_gho' &&
      decoded.gate === entry.inconclusiveReason &&
      call.verificationStatus === 'verified'
    )
  } catch {
    return false
  }
}

export function classifyUmbrellaGhoScore({ core, target, verified, row, capturedAt }) {
  const call = verified?.callEvidenceDoc
  if (
    verified?.status !== 'verified' ||
    call?.verificationStatus !== 'verified' ||
    !call.replayEvidenceDoc
  )
    throw Error('umbrella_independent_measurement_required')
  const decoded = validateCarryExitV2RpcProof({
    proof: call,
    ...row,
    blockNumber: target.targetBlock,
    blockHash: target.targetHash,
  })
  if (decoded.routeKind !== 'umbrella_gho') throw Error('umbrella_route_required')
  const attrited =
    BigInt(decoded.holderCoverageRaw) === 0n ||
    BigInt(decoded.holderClaimRaw) < BigInt(row.assetsRaw)
  const status = attrited
    ? 'holder_attrition'
    : decoded.simulationStatus === 'success'
      ? 'success'
      : decoded.coveredRevert
        ? 'covered_revert'
        : 'inconclusive'
  return {
    ...core,
    ...target,
    capturedAt,
    status,
    coverageKind: 'shares',
    holderCoverageRaw: decoded.holderCoverageRaw,
    requiredCoverageRaw: decoded.requiredCoverageRaw,
    actualConsumedRaw: decoded.actualConsumedRaw,
    simulationStatus: attrited ? null : decoded.simulationStatus,
    callEvidenceDoc: attrited ? null : call,
    entitlementMethod: attrited ? 'umbrella_original_gho_claim_below_q' : null,
    entitlementEvidenceDoc:
      status === 'success' || status === 'covered_revert'
        ? null
        : { ...call, purpose: 'entitlement' },
    inconclusiveReason: status === 'inconclusive' ? decoded.gate : null,
    missingReason: null,
    missingReceiptId: null,
  }
}

export function umbrellaGhoCaseFromMeasurement(q, call, decoded) {
  if (decoded.routeKind !== 'umbrella_gho') throw Error('umbrella_route_required')
  const status =
    decoded.simulationStatus === 'success'
      ? 'success'
      : decoded.coveredRevert
        ? 'covered_revert'
        : 'inconclusive'
  return {
    assetsRaw: q,
    baselineStatus: status,
    coverageKind: 'shares',
    holderCoverageRaw: decoded.holderCoverageRaw,
    requiredCoverageRaw: decoded.requiredCoverageRaw,
    actualConsumedRaw: decoded.actualConsumedRaw,
    simulationStatus: decoded.simulationStatus,
    callEvidenceDoc: call,
    callEvidenceSha256: null,
    entitlementMethod: null,
    entitlementEvidenceDoc: status === 'inconclusive' ? { ...call, purpose: 'entitlement' } : null,
    entitlementEvidenceSha256: null,
    inconclusiveReason: status === 'inconclusive' ? decoded.gate : null,
    unavailableReason: null,
  }
}
