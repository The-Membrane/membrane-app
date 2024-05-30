
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useNFTState from "./useNFTState";
import { queryClient } from '@/pages/_app'

import { ibc } from "osmojs";
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { shiftDigits } from '@/helpers/math'
import useLiveNFTBid from './useLiveNFTBid'
import useLiveAssetBid from './useLiveAssetBid'
import { useOsmosisBlockInfo, useOsmosisClient } from './useBraneAuction'

const { transfer } = ibc.applications.transfer.v1.MessageComposer.withTypeUrl;

const useIBCToStargaze = () => {
  const nftBid = useLiveNFTBid()
  const assetBid = useLiveAssetBid()
  console.log("here1")
  const { address: stargazeAddress } = useWallet('stargaze')
  const { address: osmosisAddress } = useWallet('osmosis')
  console.log("here2", stargazeAddress, osmosisAddress)

  const { data: osmosisClient } = useOsmosisClient()
  const { data: data } = useOsmosisBlockInfo()
  const currentHeight = data?.currentHeight
  const currentBlock = data?.currentBlock
  console.log("here3", currentHeight, currentBlock)
  
  const osmosisCDT = useAssetBySymbol('CDT')
  const stargazeCDT = useAssetBySymbol('CDT', 'stargaze')
  const stargazeCDTBalance = useBalanceByAsset(stargazeCDT, 'stargaze')
  const osmosisCDTBalance = useBalanceByAsset(osmosisCDT, 'osmosis')
  console.log("here4")
  
  const osmosisMBRN = useAssetBySymbol('MBRN')
  const stargazeMBRN = useAssetBySymbol('MBRN', 'stargaze')
  const stargazeMBRNBalance = useBalanceByAsset(stargazeMBRN, 'stargaze')
  const osmosisMBRNBalance = useBalanceByAsset(osmosisMBRN)

  const { NFTState } = useNFTState()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg ibc to stargaze', data, osmosisClient, stargazeAddress, osmosisAddress, stargazeMBRNBalance, osmosisMBRNBalance, stargazeCDTBalance, osmosisCDTBalance,  NFTState.nftBidAmount, NFTState.assetBidAmount],
    queryFn: () => {
      if (!stargazeAddress || !osmosisAddress || !osmosisClient) return [] as MsgExecuteContractEncodeObject[]
      const msgs: MsgExecuteContractEncodeObject[] = []

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
            revisionNumber: BigInt(currentBlock!.header.version.block),
            revisionHeight: BigInt(currentHeight!) + BigInt(1000),
          },
          timeoutTimestamp: BigInt(0),
          memo: "",
        })
        // msg.typeUrl = "cosmos-sdk/MsgTransfer"

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
            revisionNumber: BigInt(currentBlock?.header.version.block??0),
            revisionHeight: BigInt(currentHeight??0) + BigInt(1000),
          },
          timeoutTimestamp: BigInt(0),
          memo: "IBCTransfer from Osmosis to Stargaze",
        })

        msgs.push(msg as MsgExecuteContractEncodeObject)
      } 
      console.log(msgs)
      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!stargazeAddress && !!osmosisAddress,
  })

  console.log("here5", msgs)

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    enabled: true,
    amount: "0",
    queryKey: ['msg ibc to stargaze', (msgs?.toString()??"0")],
    onSuccess,
  })
}

export default useIBCToStargaze
