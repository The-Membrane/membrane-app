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

const useLiveNFTBid = (nftBidAmount: number) => {
  const { address } = useWallet('stargaze')
  const { setNFTState } = useNFTState()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg liveNFTbid', address, nftBidAmount],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new BraneAuctionMsgComposer(address, contracts.brane_auction)

      //Stargaze IBC CDT denom
      const funds = coin(shiftDigits(nftBidAmount, 6).toString(), "ibc/B0263C28B6F44651F4596413B41FDB749EA010BD1220816DAC0ABF9947C1E806")
      const msg = messageComposer.bidForNft([funds])

      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['live nft auction'] })
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
    setNFTState({ nftBidAmount: 0 })
  }

  return {action: useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
    amount: "0",
    queryKey: ['msg brane auction bid', (msgs?.toString()??"0")],
    chain_id: 'stargaze'
  }), msgs}
}

export default useLiveNFTBid
