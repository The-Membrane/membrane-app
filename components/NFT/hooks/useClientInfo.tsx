import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { Block } from 'cosmwasm'

export const useClient = (chain_name: string = "osmosis") => {  
  const { address, getSigningStargateClient } = useWallet(chain_name)
  
  return useQuery({
    queryKey: [chain_name + ' client', address],
    queryFn: async () => {
      return getSigningStargateClient()
    },
  })
}

export const useBlockInfo = (chain_name: string = "osmosis") => {
  const { data: client } = useClient(chain_name)
  
  return useQuery({
    queryKey: [chain_name + ' block info', client],
    queryFn: async () => {
      const {currentBlock: currentBlock, currentHeight: height} = await client!.getHeight().then(async (height) => {        
      const currentBlock = await client!.getBlock(height);
      
      return {currentBlock: currentBlock, currentHeight: height}
      })
      return {currentBlock: currentBlock, currentHeight: height} as {currentBlock: Block | undefined, currentHeight: number | undefined}
    },
  })
}

