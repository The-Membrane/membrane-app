
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
  const { address: stargazeAddress } = useWallet('stargaze')
  const { address: osmosisAddress } = useWallet('osmosis')

  const { data: osmosisClient } = useOsmosisClient()
  const { data: data } = useOsmosisBlockInfo()
  const currentHeight = data?.currentHeight
  const currentBlock = data?.currentBlock
  
  const osmosisCDT = useAssetBySymbol('CDT')  
  const osmosisMBRN = useAssetBySymbol('MBRN')

  const { NFTState, setNFTState } = useNFTState()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg ibc to stargaze', data, osmosisClient, stargazeAddress, osmosisAddress, NFTState.cdtBridgeAmount, NFTState.mbrnBridgeAmount],
    queryFn: () => {
      if (!stargazeAddress || !osmosisAddress || !osmosisClient) return [] as MsgExecuteContractEncodeObject[]
      const msgs: MsgExecuteContractEncodeObject[] = []

      // Transfer CDT thru IBC
      if (NFTState.cdtBridgeAmount > Number(0)) {
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel: "channel-75",
          token: {
            denom: osmosisCDT!.base,
            amount: shiftDigits(NFTState.cdtBridgeAmount, 6).toString(),
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
      ///Do the same for MBRN 
      if (NFTState.mbrnBridgeAmount > Number(0)) {
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel: "channel-75",
          token: {
            denom: osmosisMBRN!.base,
            amount: shiftDigits(NFTState.mbrnBridgeAmount, 6).toString(),
          },
          sender: osmosisAddress,
          receiver: stargazeAddress,
          timeoutHeight: {
            revisionNumber: BigInt(currentBlock?.header.version.block??0),
            revisionHeight: BigInt(currentHeight??0) + BigInt(1000),
          },
          timeoutTimestamp: BigInt(0),
          memo: "IBC Transfer from Osmosis to Stargaze",
        })

        msgs.push(msg as MsgExecuteContractEncodeObject)
      } 
      console.log(msgs)
      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!stargazeAddress && !!osmosisAddress,
  })


  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
    setNFTState({ cdtBridgeAmount: 0, mbrnBridgeAmount: 0})
  }

  return useSimulateAndBroadcast({
    msgs,
    enabled: true,
    amount: "0",
    queryKey: ['msg ibc', (msgs?.toString()??"0")],
    onSuccess,
  })
}

export default useIBCToStargaze
