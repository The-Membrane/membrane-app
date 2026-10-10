import { collectCarryExitV2RpcProof } from './carry-exit-v2-rpc-collector.mjs'
import { UMBRELLA_GHO_ROUTE } from './carry-exit-v2-umbrella-gho-proof.mjs'

/** The source-specific entry point always measures original GHO assets, never legacy one-share cases. */
export function collectUmbrellaGhoV2RpcProof(input) {
  if (
    ['routeKey', 'destination', 'asset'].some(
      (field) => input?.[field] !== UMBRELLA_GHO_ROUTE[field],
    ) ||
    input.sharesRaw !== undefined
  )
    throw Error('umbrella_original_gho_q_required')
  return collectCarryExitV2RpcProof(input)
}
