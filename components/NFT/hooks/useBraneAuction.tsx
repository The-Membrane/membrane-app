import { getLiveAssetAuction, getLiveNFTAuction } from '@/services/nft_auction'
import { useQuery } from '@tanstack/react-query'

export const useLiveNFTAuction = () => {
  return useQuery({
    queryKey: ['live nft auction'],
    queryFn: async () => {
      return getLiveNFTAuction()
    },
  })
}

export const useLiveAssetAuction = () => {
  return useQuery({
    queryKey: ['live asset auction'],
    queryFn: async () => {
      return getLiveAssetAuction()
    },
  })
}

