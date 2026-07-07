import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the Manic / USDC-looping "Earn" vault does NOT exist in the Solidity
 * port — no earn (margin/looping) contract was ported (looping is out of scope; the
 * Transmuter + CDP cover the ported surface). This hook returns no msgs so the
 * fulfill-intent CTA stays inert; the Manic UI it serves is slated for removal in the
 * component-layer wave. {action} shape and (positionId, maxMintAmount) signature preserved.
 */
const useFulfillIntent = (positionId?: string, maxMintAmount?: number) => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['manic_fulfill_intent_msg', address, positionId, maxMintAmount],
    queryFn: () => [] as EvmCall[],
    enabled: !!address && !!positionId && !!maxMintAmount,
  })

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['usdc_looping_position'] })
    queryClient.invalidateQueries({ queryKey: ['transmuter_usdc_balance'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['basket'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['manic_fulfill_intent_sim', msgs?.toString() ?? '0'],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useFulfillIntent
