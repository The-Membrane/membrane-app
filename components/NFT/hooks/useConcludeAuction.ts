import contracts from '@/config/contracts.json'
import { BraneAuctionMsgComposer } from '@/contracts/codegen/brane_auction/BraneAuction.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'

const useConcludeAuction = () => {
  const { address } = useWallet('stargaze')

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg conclude', address],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new BraneAuctionMsgComposer(address, contracts.brane_auction)

      //Conclude Msg
      // const submitNFT = messageComposer.submitNft({
      //   proceedRecipient: "stars1pyxg2vgej0e3dmpg44kz2us0efyctq94v6t2h7",
      //   tokenUri: "ipfs://bafybeib4imygu5ehbgy7frry65ywpekw72kbs7thk5a2zjhyw67wluoy2m/metadata/Clownsy Brane",
      // })
      // const submitNFT1 = messageComposer.submitNft({
      //   proceedRecipient: "stars1pyxg2vgej0e3dmpg44kz2us0efyctq94v6t2h7",
      //   tokenUri: "ipfs://bafybeib4imygu5ehbgy7frry65ywpekw72kbs7thk5a2zjhyw67wluoy2m/metadata/Zombrane",
      // })
      // const submitNFT2 = messageComposer.submitNft({
      //   proceedRecipient: "stars1pyxg2vgej0e3dmpg44kz2us0efyctq94v6t2h7",
      //   tokenUri: "ipfs://bafybeib4imygu5ehbgy7frry65ywpekw72kbs7thk5a2zjhyw67wluoy2m/metadata/Skully Brane",
      // })
      // const submitNFT3 = messageComposer.submitNft({
      //   proceedRecipient: "stars1pyxg2vgej0e3dmpg44kz2us0efyctq94v6t2h7",
      //   tokenUri: "ipfs://bafybeib4imygu5ehbgy7frry65ywpekw72kbs7thk5a2zjhyw67wluoy2m/metadata/Jase Brane",
      // })
      // const submitNFT4 = messageComposer.submitNft({
      //   proceedRecipient: "stars1pyxg2vgej0e3dmpg44kz2us0efyctq94v6t2h7",
      //   tokenUri: "ipfs://bafybeib4imygu5ehbgy7frry65ywpekw72kbs7thk5a2zjhyw67wluoy2m/metadata/Brane Sucker",
      // })
      // const curate = messageComposer.voteToCurate({submissionIds: [1,2,3,4,5]})
      const msg = messageComposer.concludeAuction()

      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['live nft auction'] })
    queryClient.invalidateQueries({ queryKey: ['live asset auction'] })
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
  }

  return {action: useSimulateAndBroadcast({
    msgs,
    enabled: true,
    onSuccess,
    amount: "0",
    queryKey: ['sim conclude auction', (msgs?.toString()??"0")],
    chain_id: 'stargaze'
  }), msgs}
}

export default useConcludeAuction