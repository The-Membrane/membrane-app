import { getLiveNFTAuction } from '@/services/nft_auction'
import { useQuery } from '@tanstack/react-query'

export const useLiveNFTAuction = () => {
  return useQuery({
    queryKey: ['live nft auction'],
    queryFn: async () => {
      return getLiveNFTAuction()
    },
  })
}
