import { collectUmbrellaGhoV2RpcProof } from './carry-exit-v2-umbrella-gho-collector.mjs'
import { UMBRELLA_GHO_ROUTE } from './carry-exit-v2-umbrella-gho-proof.mjs'
// Read-only application workflow for one frozen Carry exit v2 measurement.
// This orders capture, two-origin replay, and evidence assembly. It does not
// create a cryptographic trust boundary: the caller still chooses RPC origins
// and the database writer must be separately controlled/audited.
import { collectCarryExitV2RpcProof } from './carry-exit-v2-rpc-collector.mjs'
import { verifyCarryExitV2IndependentReplay } from './carry-exit-v2-independent-replay.mjs'
import { assembleCarryExitV2CallEvidence } from './carry-exit-v2-proof-assembly.mjs'

const FORBIDDEN_INPUTS = [
  'sharesRaw',
  'collector',
  'proof',
  'identityEvidence',
  'replay',
  'replayEvidenceDoc',
  'status',
  'verdict',
  'callEvidenceDoc',
]

function unavailable(reason) {
  return { status: 'unavailable', reason }
}

/**
 * Capture one finalized, frozen holder/Q call and independently replay it.
 * `send`, `primary.request`, and `secondary.request` are injected JSON-RPC
 * transports; this function neither writes rows nor publishes a forecast.
 * A verified document proves agreement among those supplied transports only.
 */
export async function measureCarryExitV2Verified(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    FORBIDDEN_INPUTS.some((field) => Object.hasOwn(input, field))
  )
    return unavailable('invalid_input')

  const {
    routeKey,
    destination,
    asset,
    holder,
    assetsRaw,
    target,
    provider,
    source,
    send,
    primary,
    secondary,
    timeoutMs,
    now,
  } = input
  if (
    typeof send !== 'function' ||
    typeof primary?.request !== 'function' ||
    typeof secondary?.request !== 'function' ||
    primary.request === secondary.request
  )
    return unavailable('invalid_transports')

  let collector
  try {
    collector = await (
      routeKey === UMBRELLA_GHO_ROUTE.routeKey
        ? collectUmbrellaGhoV2RpcProof
        : collectCarryExitV2RpcProof
    )({
      routeKey,
      destination,
      asset,
      holder,
      assetsRaw,
      target,
      provider,
      source,
      send,
      timeoutMs,
      now,
    })
  } catch {
    return unavailable('collection_failed')
  }

  const frozen = {
    routeKey,
    destination,
    asset,
    holder,
    assetsRaw,
    blockNumber: collector.blockNumber,
    blockHash: collector.blockHash,
  }
  let replay
  try {
    replay = await verifyCarryExitV2IndependentReplay({
      ...frozen,
      proof: collector.proof,
      identityEvidence: collector.identityEvidence,
      primary,
      secondary,
      now,
    })
  } catch {
    return unavailable('replay_failed')
  }
  if (replay.status !== 'verified')
    return {
      ...unavailable('replay_unavailable'),
      ...(input.includeSafeFailureDetail === true && /^[a-z0-9_]{1,60}$/.test(replay.reason ?? '')
        ? { detail: replay.reason }
        : {}),
    }

  try {
    const callEvidenceDoc = assembleCarryExitV2CallEvidence({ collector, replay, frozen })
    return { status: 'verified', callEvidenceDoc }
  } catch {
    return unavailable('assembly_failed')
  }
}
