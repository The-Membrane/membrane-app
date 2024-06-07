
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useNFTState from "./useNFTState";
import { queryClient } from '@/pages/_app'

import { ibc } from "osmojs";
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import { useBlockInfo } from './useClientInfo';
import useQuickActionState from '@/components/Home/hooks/useQuickActionState';
import { useMemo } from 'react';
import { delayTime } from '@/config/defaults';

const { transfer } = ibc.applications.transfer.v1.MessageComposer.withTypeUrl;

const useIBC = () => {
  const { quickActionState } = useQuickActionState()
  const { address: stargazeAddress } = useWallet('stargaze')
  const { address: osmosisAddress } = useWallet('osmosis')

  const { data: osmosisData } = useBlockInfo('osmosis')
  const { data: stargazeData } = useBlockInfo('stargaze')
  
  const osmosisCDT = useAssetBySymbol('CDT')  
  const osmosisMBRN = useAssetBySymbol('MBRN')
  const stargazeCDT = useAssetBySymbol('CDT', 'stargaze')  
  const stargazeMBRN = useAssetBySymbol('MBRN', 'stargaze')

  const { currentHeight, currentBlock, sourceChannel, sender, receiver, cdtDenom, mbrnDenom, memo, chainName} = useMemo(() => {
    return quickActionState.action.value === "Bridge to Stargaze" ? { 
      currentHeight: osmosisData?.currentHeight, 
      currentBlock: osmosisData?.currentBlock,
      sourceChannel: "channel-75",
      sender: osmosisAddress!,
      receiver: stargazeAddress!,
      cdtDenom: osmosisCDT === null ? "" : osmosisCDT.base,
      mbrnDenom: osmosisMBRN === null ? "" : osmosisMBRN.base,
      memo: "IBC Transfer from Osmosis to Stargaze",
      chainName: "osmosis"
    } : { 
      currentHeight: stargazeData?.currentHeight, 
      currentBlock: stargazeData?.currentBlock,
      sourceChannel: "channel-0",
      sender: stargazeAddress!,
      receiver: osmosisAddress!,
      cdtDenom: stargazeCDT === null ? "" : stargazeCDT.base,
      mbrnDenom: stargazeMBRN === null ? "" : stargazeMBRN.base,
      memo: "IBC Transfer from Stargaze to Osmosis",
      chainName: "stargaze"
    }
  }, [quickActionState.action.value, osmosisData, stargazeData, osmosisCDT, osmosisMBRN, stargazeCDT, stargazeMBRN, osmosisAddress, stargazeAddress])

  const { NFTState, setNFTState } = useNFTState()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg ibc to/from stargaze', currentHeight, currentBlock, stargazeAddress, osmosisAddress, NFTState.cdtBridgeAmount, NFTState.mbrnBridgeAmount],
    queryFn: () => {
      if (!stargazeAddress || !osmosisAddress || !currentHeight || !currentBlock) return [] as MsgExecuteContractEncodeObject[]
      const msgs: MsgExecuteContractEncodeObject[] = []

      // Transfer CDT thru IBC
      if (NFTState.cdtBridgeAmount > Number(0)) {
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel,
          token: {
            denom: cdtDenom,
            amount: shiftDigits(NFTState.cdtBridgeAmount, 6).toString(),
          },
          sender,
          receiver,
          timeoutHeight: {
            revisionNumber: BigInt(currentBlock!.header.version.block),
            revisionHeight: BigInt(currentHeight!) + BigInt(1000),
          },
          timeoutTimestamp: BigInt(0),
          memo,
        })

        msgs.push(msg as MsgExecuteContractEncodeObject)
      }
      ///Do the same for MBRN 
      if (NFTState.mbrnBridgeAmount > Number(0)) {
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel,
          token: {
            denom: mbrnDenom,
            amount: shiftDigits(NFTState.mbrnBridgeAmount, 6).toString(),
          },
          sender,
          receiver,
          timeoutHeight: {
            revisionNumber: BigInt(currentBlock?.header.version.block??0),
            revisionHeight: BigInt(currentHeight??0) + BigInt(1000),
          },
          timeoutTimestamp: BigInt(0),
          memo
        })

        msgs.push(msg as MsgExecuteContractEncodeObject)
      } 
      console.log(msgs)
      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!stargazeAddress && !!osmosisAddress,
  })


  const onSuccess = () => {
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
      queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    }, 7000);
    setNFTState({ cdtBridgeAmount: 0, mbrnBridgeAmount: 0})
  }

  return useSimulateAndBroadcast({
    msgs,
    enabled: true,
    amount: "0",
    queryKey: ['sim ibc', (msgs?.toString()??"0")],
    onSuccess,
    chain_id: chainName
  })
}

export default useIBC