import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useEffect, useMemo } from 'react'
import { LPMsg, swapToMsg } from '@/helpers/osmosis'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'
import { shiftDigits } from '@/helpers/math'
import { buildStabilityPooldepositMsg } from '@/services/stabilityPool'
import { coin } from '@cosmjs/stargate'
import { loopPosition } from '@/services/osmosis'
import useQuickActionVaultSummary from './useQuickActionVaultSummary'
import { num } from '@/helpers/num'

const useQuickAction = () => {
  const { quickActionState } = useQuickActionState()
  const { summary = [] } = quickActionState
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const usdcAsset = useAssetBySymbol("USDC")
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT')
  const { borrowLTV, maxMint } = useQuickActionVaultSummary()

  /////First we'll do new positions only, but these actions will be usable by all positions & multiple per user in the future//////

  //Use first position id or use the basket's next position ID (for new positions)
  const positionId = useMemo(() => {
    if (basketPositions !== undefined) {
      return basketPositions?.[0]?.positions?.[0]?.position_id
    } else {
      //Use the next position ID
      return basket?.current_position_id ?? ""
    }
  }, [basket, basketPositions])

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: [
      'mint',
      address,
      positionId, 
      borrowLTV, 
      maxMint,
      quickActionState?.mint,
      quickActionState?.selectedAsset,
      quickActionState?.action,
      usdcAsset,
      prices,
      cdtAsset
    ],
    queryFn: () => {
      if (!address || !basket || !usdcAsset || !prices || !cdtAsset || !quickActionState?.selectedAsset) return
      var msgs = [] as MsgExecuteContractEncodeObject[]
      //Deposit
      const deposit = getDepostAndWithdrawMsgs({ summary: [quickActionState?.selectedAsset as any], address, positionId, hasPosition: basketPositions !== undefined })
      msgs = msgs.concat(deposit)
      if (quickActionState?.mint && quickActionState?.mint > 0){
        //Mint
        const mint = getMintAndRepayMsgs({
          address,
          positionId,
          mintAmount: quickActionState?.mint,
          repayAmount: 0,
        })
        msgs = msgs.concat(mint)
        if (quickActionState.action.value === "LP"){
          //Swap
          const { msg: swap, tokenOutMinAmount } = swapToMsg({
            address, 
            cdtAmount: quickActionState?.mint, 
            swapToAsset: usdcAsset,
            prices,
            cdtAsset,
          })   
          msgs.push(swap as MsgExecuteContractEncodeObject)  
          //LP   
          const lp = LPMsg({
            address,
            cdtInAmount: shiftDigits(quickActionState?.mint, 6).dp(0).toString(),
            cdtAsset,
            pairedAssetInAmount: tokenOutMinAmount,
            pairedAsset: usdcAsset,
            poolID: 1268,
          })
          msgs.push(lp as MsgExecuteContractEncodeObject)

        } else if (quickActionState.action.value === "Bid"){  
          //Omni-Pool     
          const microAmount = shiftDigits(quickActionState?.mint, 6).dp(0).toString()
          const funds = [coin(microAmount, cdtAsset?.base!)]

          const omni = buildStabilityPooldepositMsg({ address, funds })
          msgs.push(omni as MsgExecuteContractEncodeObject)

        } else if (quickActionState.action.value === "Loop"){
          //Loop
          //Calc LTV based on mint
          const mintLTV = num(quickActionState?.mint).div(maxMint).times(borrowLTV).div(100).toFixed(2)
          //Loop max amount
          const loopMax = 5;
          const loops = loopPosition(parseFloat(mintLTV), positionId, loopMax, address, prices, basket)
          console.log(loops)
          msgs = msgs.concat(loops as MsgExecuteContractEncodeObject[])
        }
      }

      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  const onSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [
      String(quickActionState?.mint) || '0',
      String(quickActionState?.selectedAsset?.amount) || '0',
      quickActionState?.action?.value,
    ],
    enabled: !!msgs,
    onSuccess,
  })
}

export default useQuickAction
