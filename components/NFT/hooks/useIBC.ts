
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useNFTState, { ActionMenu } from "./useNFTState";
import { queryClient } from '@/pages/_app'

import { ibc } from "osmojs";
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import { useBlockInfo } from './useClientInfo';
import { useEffect, useMemo } from 'react';
import useToaster from '@/hooks/useToaster';
import { swapToCDTMsg } from '@/helpers/osmosis';
import { isGreaterThanZero, num } from '@/helpers/num';
import { useOraclePrice } from '@/hooks/useOracle';
import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance';

const { transfer } = ibc.applications.transfer.v1.MessageComposer.withTypeUrl;

const useIBC = (action: ActionMenu, selectedAsset: AssetWithBalance | undefined, cdtBridgeAmount: number, mbrnBridgeAmount: number, swapInsteadof: boolean) => {
  const toaster = useToaster()
  const { setNFTState } = useNFTState()
  const { address: stargazeAddress } = useWallet('stargaze')
  const { address: osmosisAddress } = useWallet('osmosis')

  const { data: osmosisData } = useBlockInfo('osmosis')
  const { data: stargazeData } = useBlockInfo('stargaze')
  
  const osmosisCDT = useAssetBySymbol('CDT')  
  const osmosisMBRN = useAssetBySymbol('MBRN')
  const stargazeCDT = useAssetBySymbol('CDT', 'stargaze')  
  const stargazeMBRN = useAssetBySymbol('MBRN', 'stargaze')

  const { currentHeight, currentBlock, sourceChannel, sender, receiver, cdtDenom, mbrnDenom, memo, chainName} = useMemo(() => {
    return action.value === "Bridge to Stargaze" ? { 
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
  }, [action.value, osmosisData, stargazeData, osmosisCDT, osmosisMBRN, stargazeCDT, stargazeMBRN, osmosisAddress, stargazeAddress])
  
  //Data for deposit/mint/swap
  const { data: prices } = useOraclePrice()

  //Can we use this to tell us the order of queries? And delete query keys changes for the early ones?
  // useEffect(() => {
  //   console.log(selectedAsset?.amount, prices, currentHeight, currentBlock, stargazeAddress, osmosisAddress, cdtBridgeAmount, mbrnBridgeAmount)
  // }, [selectedAsset?.amount, prices, currentHeight, currentBlock, stargazeAddress, osmosisAddress, cdtBridgeAmount, mbrnBridgeAmount])
  

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    swapMinAmount: number
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['msg ibc to/from stargaze', selectedAsset?.amount],
    queryFn: () => {
      if (!stargazeAddress || !osmosisAddress || !currentHeight || !currentBlock || (!isGreaterThanZero(cdtBridgeAmount) && !isGreaterThanZero(mbrnBridgeAmount) && !swapInsteadof)) return { msgs: undefined, swapMinAmount: 0 }
      var msgs: MsgExecuteContractEncodeObject[] = []
      var swapMinAmount = 0

      //Swap to CDT to bridge
      if (osmosisCDT && prices && action.value === "Bridge to Stargaze" && swapInsteadof && selectedAsset){
        const swapFromAmount = num(selectedAsset.amount).toNumber()
        const cdtPrice = parseFloat(prices?.find((price) => price.denom === osmosisCDT.base)?.price ?? "0")
        //Swap
        const { msg: swap, tokenOutMinAmount } = swapToCDTMsg({
          address: osmosisAddress, 
          swapFromAmount,
          swapFromAsset: selectedAsset,
          prices,
          cdtPrice,
        })
        swapMinAmount = shiftDigits(tokenOutMinAmount, -6).toNumber()
        msgs.push(swap as MsgExecuteContractEncodeObject)
      }

      // Transfer CDT thru IBC
      if (cdtBridgeAmount > Number(0)) {
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel,
          token: {
            denom: cdtDenom,
            amount: shiftDigits(cdtBridgeAmount, 6).toString(),
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
      if (mbrnBridgeAmount > Number(0)) {
        var msg = transfer({
          sourcePort: "transfer",
          sourceChannel,
          token: {
            denom: mbrnDenom,
            amount: shiftDigits(mbrnBridgeAmount, 6).toString(),
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

      return { msgs, swapMinAmount }
    },
    enabled: !!stargazeAddress && !!osmosisAddress,
  })

  const { msgs, swapMinAmount } = useMemo(() => {
    if (!queryData) return { msgs: undefined, swapMinAmount: 0 }
    else return queryData
  }, [queryData])

  const onSuccess = () => {
    //Change 
    toaster.success({
      message: 'Balances refreshing soon...',
    })
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['stargaze balances'] })
      queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
      toaster.success({
        message: 'Balances refreshed!',
      })
    }, 7000);
    setNFTState({ cdtBridgeAmount: 0, mbrnBridgeAmount: 0})
  }

  return {action: useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    amount: "0",
    queryKey: ['sim ibc', (msgs?.toString()??"0")],
    onSuccess,
    chain_id: chainName
  }), swapMinAmount}
}

export default useIBC