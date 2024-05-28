import contracts from '@/config/contracts.json'
import { BraneAuctionMsgComposer } from '@/contracts/codegen/brane_auction/BraneAuction.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { coin } from '@cosmjs/stargate'
import useNFTState from "./useNFTState";
import { queryClient } from '@/pages/_app'

import { ibc } from "osmojs";
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { shiftDigits } from '@/helpers/math'
import useLiveNFTBid from './useLiveNFTBid'
import useLiveAssetBid from './useLiveAssetBid'

const { transfer } = ibc.applications.transfer.v1.MessageComposer.withTypeUrl;

const useIBCToStargaze = async () => {
  const nftBid = useLiveNFTBid()
  const assetBid = useLiveAssetBid()
  
  const { address: stargazeAddress } = useWallet('stargaze')
  const { address: osmosisAddress, getSigningStargateClient } = useWallet('osmosis')

  const osmosisClient = await getSigningStargateClient()
  
  const osmosisCDT = useAssetBySymbol('CDT')
  const stargazeCDT = useAssetBySymbol('CDT', 'stargaze')
  const stargazeCDTBalance = useBalanceByAsset(stargazeCDT, 'stargaze')
  const osmosisCDTBalance = useBalanceByAsset(osmosisCDT, 'osmosis')
  
  const osmosisMBRN = useAssetBySymbol('MBRN')
  const stargazeMBRN = useAssetBySymbol('MBRN', 'stargaze')
  const stargazeMBRNBalance = useBalanceByAsset(stargazeMBRN, 'stargaze')
  const osmosisMBRNBalance = useBalanceByAsset(osmosisMBRN)

  const { NFTState } = useNFTState()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg ibc to stargaze', stargazeAddress, osmosisAddress, stargazeMBRNBalance, osmosisMBRNBalance, stargazeCDTBalance, osmosisCDTBalance,  NFTState.nftBidAmount, NFTState.assetBidAmount],
    queryFn: async () => {
      if (!stargazeAddress || !osmosisAddress) return [] as MsgExecuteContractEncodeObject[]
      const msgs: MsgExecuteContractEncodeObject[] = []
      // Get the current block height and block so we can set a timeout height
      // when we make the actual transfer message
      const currentHeight = await osmosisClient.getHeight();
      const currentBlock = await osmosisClient.getBlock(currentHeight);

      // IF the user's NFT bid is larger than their Stargaze CDT balance and they can fulfill it with their Osmosis CDT balance, IBC the remainder to Stargaze
      if (NFTState.nftBidAmount > Number(stargazeCDTBalance)) {
        var remainder = NFTState.nftBidAmount - Number(stargazeCDTBalance)
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel: "channel-75",
          token: {
            denom: osmosisCDT!.base,
            amount: shiftDigits(remainder, 6).toString(),
          },
          sender: osmosisAddress,
          receiver: stargazeAddress,
          timeoutHeight: {
            revisionNumber: BigInt(currentBlock.header.version.block),
            revisionHeight: BigInt(currentHeight) + BigInt(1000),
          },
          timeoutTimestamp: BigInt(0),
          memo: "IBCTransfer from Osmosis to Stargaze",
        })

        msgs.push(msg as MsgExecuteContractEncodeObject)
      }
      ///Do the same for MBRN and the assetBidAmount
      if (NFTState.assetBidAmount > Number(stargazeMBRNBalance)) {
        var remainder = NFTState.nftBidAmount - Number(stargazeMBRNBalance)
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel: "channel-75",
          token: {
            denom: osmosisMBRN!.base,
            amount: shiftDigits(remainder, 6).toString(),
          },
          sender: osmosisAddress,
          receiver: stargazeAddress,
          timeoutHeight: {
            revisionNumber: BigInt(currentBlock.header.version.block),
            revisionHeight: BigInt(currentHeight) + BigInt(1000),
          },
          timeoutTimestamp: BigInt(0),
          memo: "IBCTransfer from Osmosis to Stargaze",
        })

        msgs.push(msg as MsgExecuteContractEncodeObject)
      } 

      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!stargazeAddress && !!osmosisAddress && !!stargazeCDTBalance && !!osmosisCDTBalance && !!stargazeMBRNBalance && !!osmosisMBRNBalance && !!NFTState.nftBidAmount && !!NFTState.assetBidAmount,
  })

  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    if (NFTState.nftBidAmount > Number(stargazeCDTBalance)) nftBid.tx.mutate()
    if (NFTState.assetBidAmount > Number(stargazeMBRNBalance)) assetBid.tx.mutate()
  }

  return useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
  })
}

export default useIBCToStargaze
