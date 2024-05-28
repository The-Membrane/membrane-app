import useWallet from '@/hooks/useWallet'
import { getLiveAssetAuction, getLiveNFTAuction } from '@/services/nft_auction'
import { useQuery } from '@tanstack/react-query'
import { Block } from 'cosmwasm'

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

export const useOsmosisClient = () => {  
  const { address: osmosisAddress, getSigningStargateClient } = useWallet('osmosis')
  
  return useQuery({
    queryKey: ['osmosis client', osmosisAddress],
    queryFn: async () => {
      return getSigningStargateClient()
    },
  })
}

export const useOsmosisBlockInfo = () => {
  const { data: client } = useOsmosisClient()
  
  return useQuery({
    queryKey: ['osmosis block info', client],
    queryFn: async () => {
      const blockHeight = await client!.getHeight().then(async (height) => {        
      const currentBlock = await client!.getBlock(height);
      
      return {currentBlock: currentBlock, currentHeight: height}
      })
      return {currentBlock: undefined, currentHeight: undefined} as {currentBlock: Block | undefined, currentHeight: number | undefined}
    },
  })
}

