import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import useNFTState from './useNFTState'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

/**
 * TODO(evm-migration): the Brane NFT auction (Stargaze) does NOT exist in the Solidity
 * port — no brane_auction contract was ported. This hook returns no msgs so the
 * "bid for NFT" CTA stays inert; the NFT-auction UI it serves is slated for removal in the
 * component-layer wave. {action, msgs} shape preserved.
 */
const useLiveNFTBid = (nftBidAmount: number) => {
  const { address } = useWallet()
  const { setNFTState } = useNFTState()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg liveNFTbid', address, nftBidAmount],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['live nft auction'] })
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
    setNFTState({ nftBidAmount: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      enabled: !!msgs,
      onSuccess,
      amount: '0',
      queryKey: ['msg brane auction bid', msgs?.toString() ?? '0'],
    }),
    msgs,
  }
}

export default useLiveNFTBid
