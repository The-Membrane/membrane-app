import { getLiveAssetAuction, getLiveNFTAuction, getLiveNFTJSON } from '@/services/nft_auction'
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

export const useLiveNFT = (ipfsString: string) => {
  return useQuery({
    queryKey: ['live NFT json fetch'],
    queryFn: async () => {
      return getLiveNFTJSON(ipfsString)
    },
  })
}
