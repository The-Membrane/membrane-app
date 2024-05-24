import contracts from '@/config/contracts.json'
import { BraneAuctionMsgComposer } from '@/contracts/codegen/brane_auction/BraneAuction.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { coin } from '@cosmjs/stargate'
import useNFTState from "./useNFTState";
import { queryClient } from '@/pages/_app'

const useLiveAssetBid = () => {
  const { address } = useWallet('stargaze')
  const { NFTState } = useNFTState()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg liveNFTbid', address, NFTState.nftBidAmount],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new BraneAuctionMsgComposer(address, contracts.brane_auction)

      const funds = coin(NFTState.assetBidAmount, "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/umbrn")
      const msg = messageComposer.bidForAssets([funds])

      console.log("funds: ", funds, "msg: ", msg)

      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['live asset auction'] })
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
  })
}

export default useLiveAssetBid
