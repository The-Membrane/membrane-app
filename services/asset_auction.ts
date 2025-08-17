
import contracts from '@/config/contracts.json'
import { getCosmWasmClient, useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { AuctionQueryClient } from '@/contracts/codegen/auction/Auction.client'
import { FeeAuction } from '@/contracts/codegen/auction/Auction.types'
import { useQuery } from '@tanstack/react-query'
import useAppState from '@/persisted-state/useAppState'


export const useAssetAuctionClient = () => {
  const { appState } = useAppState()
  const { data: cosmWasmClient } = useCosmWasmClient(appState.rpcUrl)

  return useQuery({
    queryKey: ['asset_auction_client', cosmWasmClient],
    queryFn: async () => {
      if (!cosmWasmClient) return null
      return new AuctionQueryClient(cosmWasmClient, contracts.auction)
    },
    // enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}


export const getLiveFeeAuction = async (client: any) => {
  return client.ongoingFeeAuctions({}).then((res) => res) as Promise<FeeAuction[]>
}
