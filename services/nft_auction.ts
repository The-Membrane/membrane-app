
import contracts from '@/config/contracts.json'
import getSGCosmWasmClient from '@/helpers/comswasmClient'
import { BraneAuctionQueryClient } from '@/contracts/codegen/brane_auction/BraneAuction.client'
import { Auction, BidAssetAuction } from '@/contracts/codegen/brane_auction/BraneAuction.types'

export const NFTAuctionClient = async () => {
  const cosmWasmClient = await getSGCosmWasmClient()
  return new BraneAuctionQueryClient(cosmWasmClient, contracts.brane_auction)
}

export const getLiveNFTAuction = async () => {
    const client = await NFTAuctionClient()
    return client.liveNftAuction().then((res) => res.auction) as Promise<Auction>
    
}

export const getLiveAssetAuction = async () => {
  const client = await NFTAuctionClient()
  return client.liveBidAssetAuction().then((res) => res.auction) as Promise<BidAssetAuction>
  
}