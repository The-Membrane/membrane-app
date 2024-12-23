import { getDepostAndWithdrawMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { swapToCDTMsg, swapToCollateralMsg } from '@/helpers/osmosis'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'
import { loopPosition } from '@/services/osmosis'
import { num, shiftDigits } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { loopMax } from '@/config/defaults'
import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { setCookie } from '@/helpers/cookies'

const useCDTSwap = ({ borrowLTV }: { borrowLTV: number }) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()

  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT')
  // const usdcAsset = useAssetBySymbol('USDC')
  

  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick_action_swap',
      address,
      positionId, 
      quickActionState?.levAssets,
      borrowLTV,
      prices,
      cdtAsset, 
      basketPositions,
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !cdtAsset || !quickActionState?.levAssets || borrowLTV === 0) return { msgs: undefined, loop_msgs: undefined, newPositionValue: 0, summary: []}
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")

      //1) Swap to CDT
      //2) Swap to Stables
      //3) Deposit to new position
      //4) Loop the levAssets

      //1) Swap 85% of the levAssets to CDT
      //////Calculate the % to swap/////
      // const swapRatio = 0.20
      // var stableAmount = 0;
      // var levAssets = [];
      // //Loop through levAssets to create swap msgs for each
      // for (const asset of quickActionState?.levAssets as AssetWithBalance[]) {
        
      //   const swapFromAmount = num(asset.amount).times(swapRatio).toNumber()
      //   const levAmount = shiftDigits(num(asset.amount).minus(swapFromAmount).toNumber(), asset.decimal)
      //   var stableOutAmount = 0
      //   if (swapFromAmount != 0){
      //     // console.log("are we in here")
      //     const { msg: swap, tokenOutMinAmount, foundToken } = swapToCDTMsg({
      //       address, 
      //       swapFromAmount,
      //       swapFromAsset: asset,
      //       prices,
      //       cdtPrice,
      //       tokenOut: 'USDC'
      //     })
      //     msgs.push(swap as MsgExecuteContractEncodeObject)
      //     stableOutAmount = tokenOutMinAmount
      //     //2) Swap CDT to stableAsset
      //     // console.log("are we past #1")
      //     if (!foundToken){
      //     const { msg: CDTswap, tokenOutMinAmount: stableOutMinAmount } =  swapToCollateralMsg({
      //       address,
      //       cdtAmount: shiftDigits(tokenOutMinAmount, -6),
      //       swapToAsset: stableAsset,
      //       prices,
      //       cdtPrice,
      //     })
      //     msgs.push(CDTswap as MsgExecuteContractEncodeObject)
      //     stableOutAmount = stableOutMinAmount
      //     }
      //   }

      //   //Set stableAsset deposit amount - Add swapAmount to the stableAsset
      //   stableAmount += num(stableAsset.amount).plus(shiftDigits(stableOutAmount, -stableAsset.decimal)).toNumber();                
      //   levAssets.push({...asset as any, amount: shiftDigits(levAmount, -asset.decimal)})
      // }

      //3) Deposit both lev assets to a new position
      const summary = quickActionState?.levAssets as any[]
      //Set QAState
      setQuickActionState({ summary })
      // console.log("summary:", summary)
      quickActionState.summary = summary
      // quickActionState.levAssets = levAssets
      // quickActionState.stableAsset = newStableAsset

      const deposit = getDepostAndWithdrawMsgs({ 
        summary,
        address,
        basketPositions,
        positionId,
        hasPosition: false
      })
      msgs = msgs.concat(deposit)

      // //4) Loop at 45% to get Postion Value
      const mintLTV = num(.45)
      const positions = updatedSummary(summary, undefined, prices)
      const TVL = quickActionState?.levAssets.map((asset) => asset.sliderValue??0).reduce((a, b) => a + b, 0)
      console.log("QA positionID", positionId)
      const { msgs: loops, newValue, newLTV } = loopPosition(
        false,
        cdtPrice,
        mintLTV.toNumber(),
        positionId, 
        loopMax, 
        address, 
        prices, 
        basket,
        TVL, 
        0, 
        Math.min(borrowLTV, 45),
        positions
      )
      console.log("loop msgs", loops) 
      msgs = msgs.concat(loops as MsgExecuteContractEncodeObject[]) 
      newPositionValue = newValue
      
      return { msgs, loop_msgs: loops as MsgExecuteContractEncodeObject[], newPositionValue, summary }
    },
    enabled: !!address,
  })

  const { msgs, loop_msgs, newPositionValue, summary } = useMemo(() => {
    if (!queryData) return { msgs: undefined, loop_msgs: undefined, newPositionValue: 0, summary: []}
    else return queryData
  }, [queryData])

  const onInitialSuccess = () => {
    // setQuickActionState({ readyToLoop: true })
    queryClient.invalidateQueries({ queryKey: ['positions'] })    
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    if (quickActionState.useCookies) setCookie("no liq leverage " + positionId, newPositionValue.toString(), 3650)
  }

  const onLoopSuccess = () => {    
    // queryClient.invalidateQueries({ queryKey: ['positions'] })    
    // queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    // if (quickActionState.useCookies) setCookie("no liq leverage " + positionId, newPositionValue.toString(), 3650)
    // setQuickActionState({ readyToLoop: false })
  }

  // console.log("loop_msgs", loop_msgs)
  const action = useSimulateAndBroadcast({
    msgs: loop_msgs,
    queryKey: ['quick action loop', (loop_msgs?.toString()??"0"), String(quickActionState.readyToLoop)],
    onSuccess: onLoopSuccess,
  })


  // console.log(msgs, stableAsset, quickActionState?.levAssets?.amount)
  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['quick_action_swap_sim', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
  })}
}

export default useCDTSwap
