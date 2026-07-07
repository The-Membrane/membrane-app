import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the Brane NFT auction (Stargaze) does NOT exist in the Solidity
 * port — no brane_auction contract was ported. This hook returns no msgs so the
 * "conclude auction" CTA stays inert; the NFT-auction UI it serves is slated for removal
 * in the component-layer wave. {action, msgs} shape preserved.
 */
const useConcludeAuction = () => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg conclude', address],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['live nft auction'] })
    queryClient.invalidateQueries({ queryKey: ['live asset auction'] })
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      enabled: true,
      onSuccess,
      amount: '0',
      queryKey: ['sim conclude auction', msgs?.toString() ?? '0'],
    }),
    msgs,
  }
}

export default useConcludeAuction
