import { isDeepStrictEqual } from 'node:util'
import {
  UMBRELLA_GHO_ROUTE,
  validateUmbrellaGhoProof,
} from './carry-exit-v2-umbrella-gho-proof.mjs'

const FIXED = Object.freeze([1, 4, 24, 48, 168])
const HOUR = 3600000
export function freezeUmbrellaGhoGateTargets(decoded, anchorAtUtc) {
  const anchor = Date.parse(anchorAtUtc),
    end = Number(decoded.cooldownEndSeconds) * 1000,
    expiry = Number(decoded.windowEndInclusiveSeconds) * 1000
  if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(end) || !Number.isSafeInteger(expiry))
    throw Error('umbrella_projection_clock_invalid')
  let inside = null,
    after = null
  if (end > 0 && expiry >= end && expiry > anchor) {
    const open = Math.max(1, Math.ceil((end - anchor) / HOUR) + 1)
    const expired = Math.max(1, Math.floor((expiry - anchor) / HOUR) + 1)
    if (open <= 744 && anchor + open * HOUR <= expiry) inside = open
    if (expired <= 744) after = expired
  }
  return {
    interpretation: 'conditional_mechanical_gate_if_holder_snapshot_unchanged',
    anchorAtUtc,
    cooldownEndSeconds: decoded.cooldownEndSeconds,
    windowEndInclusiveSeconds: decoded.windowEndInclusiveSeconds,
    insideWindowH: inside,
    afterExpiryH: after,
    horizons: [...new Set([...FIXED, ...[inside, after].filter((h) => h !== null)])].sort(
      (a, b) => a - b,
    ),
  }
}
function checkedProjection(projection, proof, identity) {
  const decoded = validateUmbrellaGhoProof({ proof, ...identity })
  const expected = freezeUmbrellaGhoGateTargets(decoded, projection?.anchorAtUtc)
  if (!isDeepStrictEqual(projection, expected)) throw Error('umbrella_projection_invalid')
  return expected
}
export function sourceOwnedCarryExitV2Horizons(plan) {
  if (plan.routeKey !== UMBRELLA_GHO_ROUTE.routeKey) return FIXED
  const entry = plan.cases?.[0]
  const projection = checkedProjection(
    plan.candidateEvidenceDoc?.gateProjection,
    entry?.callEvidenceDoc,
    {
      ...plan,
      assetsRaw: entry?.assetsRaw,
      blockNumber: plan.baselineBlock,
      blockHash: plan.baselineHash,
    },
  )
  return projection.horizons
}
export function issueCarryExitV2Horizons(payload) {
  if (payload.issueEnvelope?.source !== 'umbrella_gho') return FIXED
  const plan = payload.issueEnvelope.sourcePlan
  const projection = checkedProjection(
    payload.proofEnvelope?.candidateEvidenceDoc?.gateProjection,
    payload.proofEnvelope?.callEvidenceDoc,
    {
      routeKey: payload.routeKey,
      destination: payload.destination,
      asset: payload.asset,
      holder: plan.holder,
      assetsRaw: payload.assetsRaw,
      blockNumber: payload.baselineBlock,
      blockHash: payload.baselineHash,
    },
  )
  if (JSON.stringify(plan.horizons) !== JSON.stringify(projection.horizons))
    throw Error('umbrella_issue_horizons_invalid')
  const issued = Date.parse(payload.issuedAtUtc),
    anchor = Date.parse(projection.anchorAtUtc)
  if (issued < anchor || issued - anchor > 240000) throw Error('umbrella_issue_anchor_invalid')
  if (
    projection.insideWindowH !== null &&
    (issued + projection.insideWindowH * HOUR < Number(projection.cooldownEndSeconds) * 1000 ||
      issued + projection.insideWindowH * HOUR >
        Number(projection.windowEndInclusiveSeconds) * 1000)
  )
    throw Error('umbrella_issue_window_invalid')
  if (
    projection.afterExpiryH !== null &&
    issued + projection.afterExpiryH * HOUR <= Number(projection.windowEndInclusiveSeconds) * 1000
  )
    throw Error('umbrella_issue_expiry_invalid')
  return projection.horizons
}
export function carryExitV2Predecessor(horizons, horizonH) {
  const index = horizons.indexOf(horizonH)
  if (index < 0) throw Error('horizon_undeclared')
  return index === 0 ? 0 : horizons[index - 1]
}
