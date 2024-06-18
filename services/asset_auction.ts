
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient' 
import { AuctionQueryClient } from '@/contracts/codegen/auction/Auction.client'
import { FeeAuction } from '@/contracts/codegen/auction/Auction.types'

export const AssetAuctionClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new AuctionQueryClient(cosmWasmClient, contracts.auction)
}

export const getLiveFeeAuction = async () => {
  const client = await AssetAuctionClient()
  return client.ongoingFeeAuctions({}).then((res) => res) as Promise<FeeAuction[]>    
}
