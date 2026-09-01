import useWallet from '@/hooks/useWallet'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the Solidity port has NO stability pool — LiquidationEngine +
 * LtvDisco tranches replace it by design (see services/chain/liquidation.ts). This hook
 * returns no msgs so the withdraw CTA stays inert; the stability-pool UI it serves is
 * slated for removal/replacement by Disco flows in the component-layer wave.
 */
const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['stability asset pool'] })
  queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
}

export const useWithdrawStabilityPool = (amount: string) => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg omni-asset withdraw', address, amount],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

  return {
    action: useSimulateAndBroadcast({
    msgs,
    enabled: true,
    onSuccess,
  }), msgs}
}

export default useWithdrawStabilityPool
