
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
  return client.liveNftAuction().then((res) => res) as Promise<Auction>    
}


export const getLiveNFTJSON = async (ipfsString: string) => {
  const data = await fetch("https://ipfs-gw.stargaze-apis.com/ipfs/" + ipfsString)
  const json = await data.json()
  return json as Promise<any>
  
}

export const getLiveAssetAuction = async () => {
  const client = await NFTAuctionClient()
  return client.liveBidAssetAuction().then((res) => res.auction) as Promise<BidAssetAuction>
  
}