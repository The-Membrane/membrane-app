import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import useNFTState from './useNFTState'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the Brane NFT auction (Stargaze) does NOT exist in the Solidity
 * port — no brane_auction contract was ported. This hook returns no msgs so the
 * "bid for assets" CTA stays inert; the NFT-auction UI it serves is slated for removal in
 * the component-layer wave. Return shape (a bare useSimulateAndBroadcast) preserved.
 */
const useLiveAssetBid = (assetBidAmount: number) => {
  const { address } = useWallet()
  const { setNFTState } = useNFTState()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg liveAssetbid', address, assetBidAmount],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['live asset auction'] })
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
    setNFTState({ assetBidAmount: 0 })
  }

  return useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
    amount: '0',
    queryKey: ['sim asset auction', msgs?.toString() ?? '0'],
  })
}

export default useLiveAssetBid
