import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import type { EvmCall } from '@/services/chain/types'

type Props = {
  txSuccess?: () => void
}

/**
 * TODO(evm-migration): this was an Osmosis CL LP + collateral-swap flow
 * (handleCollateralswaps + joinCLPools via services/osmosis). It is DEAD on EVM — there is
 * no Osmosis DEX and no on-chain swap/LP router in the Solidity port yet
 * (docs/audits/01-cosmos-callsite-ledger.md §3.1). Gutted to a no-op that emits no msgs so
 * the export keeps compiling; the component-layer removal comes in a later wave.
 */
const useLP = ({ txSuccess }: Props) => {
  const msgs: EvmCall[] = []

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['CL_pool_LP', 'evm-stub'],
    onSuccess: () => {
      txSuccess?.()
    },
    enabled: false,
  })
}

export default useLP
