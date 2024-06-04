import contracts from '@/config/contracts.json'
import { BraneAuctionMsgComposer } from '@/contracts/codegen/brane_auction/BraneAuction.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { coin } from '@cosmjs/stargate'
import useNFTState from "./useNFTState";
import { queryClient } from '@/pages/_app'
import { shiftDigits } from '@/helpers/math'

const useLiveAssetBid = () => {
  const { address } = useWallet('stargaze')
  const { NFTState } = useNFTState()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg liveAssetbid', address, NFTState.assetBidAmount],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new BraneAuctionMsgComposer(address, contracts.brane_auction)

      const funds = coin(shiftDigits(NFTState.assetBidAmount, 6).toString(), "ibc/E94BB144B818CB8061F43E202BEA1E9273B87D6326C8C6F4E6AE71C62FD37854")
      const msg = messageComposer.bidForAssets([funds])

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
    enabled: true,
    onSuccess,
    amount: "0",
    queryKey: ['sim asset auction', (msgs?.toString()??"0")],
    chain_id: 'stargaze'
  })
}

export default useLiveAssetBid
