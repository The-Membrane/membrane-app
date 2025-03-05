
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { AuctionQueryClient } from '@/contracts/codegen/auction/Auction.client'
import { FeeAuction } from '@/contracts/codegen/auction/Auction.types'

export const AssetAuctionClient = async (rpcUrl: string) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return new AuctionQueryClient(cosmWasmClient, contracts.auction)
}

export const getLiveFeeAuction = async (rpcUrl: string) => {
  const client = await AssetAuctionClient(rpcUrl)
  return client.ongoingFeeAuctions({}).then((res) => res) as Promise<FeeAuction[]>
}
