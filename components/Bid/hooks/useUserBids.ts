import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import useBidState from './useBidState'
import { getUserBids } from '@/services/liquidation'

const useUserBids = () => {
  const { address } = useWallet()
  const { bidState } = useBidState()

  return useQuery({
    queryKey: ['user bids', address, bidState?.selectedAsset?.base],
    queryFn: async () => {
      if (!address || !bidState?.selectedAsset?.base) return []
      return getUserBids(address, bidState?.selectedAsset?.base)
    },
    enabled: !!bidState?.selectedAsset?.base,
  })
}

export default useUserBids
