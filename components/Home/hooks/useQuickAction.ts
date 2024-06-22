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
// import useQuickActionVaultSummary from './useQuickActionVaultSummary'
import { num, shiftDigits } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { loopMax } from '@/config/defaults'
import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'
import { set } from 'react-hook-form'
import { setCookie } from '@/helpers/cookies'

const useQuickAction = () => {
  const { quickActionState, setQuickActionState } = useQuickActionState()

  // const { summary = [] } = quickActionState
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT')
  const usdcAsset = useAssetBySymbol('USDC')
  // const { borrowLTV, maxMint, debtAmount, tvl } = useQuickActionVaultSummary()
  

  /////First we'll do 1 position, but these actions will be usable by multiple per user in the future//////

  //Always using the basket's next position ID (for new positions)
  const positionId = useMemo(() => {
      //Use the next position ID
      return basket?.current_position_id ?? ""
  }, [basket])

  const stableAsset = useMemo(() => {
    //Use USDC as the default if they don't choose an asset
    return quickActionState?.stableAsset ?? usdcAsset! as AssetWithBalance
  }, [quickActionState?.stableAsset, usdcAsset])

  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    newPositionValue: number
    swapRatio: number
    summary: any[]
  }
  console.log("SV:", quickActionState?.stableAsset?.sliderValue)
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick action widget',
      address,
      positionId, 
      quickActionState?.levAsset,
      quickActionState?.stableAsset?.sliderValue,
      usdcAsset,
      prices,
      cdtAsset, basketPositions
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !cdtAsset || !quickActionState?.levAsset) return { msgs: undefined, newPositionValue: 0, swapRatio: 0, summary: []}
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")

      //1) Swap to CDT
      //2) Swap to Stables
      //3) Deposit to new position
      //4) Loop the levAsset

      //1) Swap 85% of the levAsset to CDT
      //////Calculate the % to swap/////
      const swapPercent = 0.20
      // IF STABLES ARE ADDED, SUBTRACT IT FROM THE PERCENT TO SWAP
      //Get the % of assets already in stables
      const stableRatio = num(stableAsset.sliderValue).dividedBy(num(quickActionState?.levAsset?.sliderValue).plus(num(stableAsset.sliderValue))).toNumber()
      const stableValue = stableAsset.sliderValue
      console.log("stable ratios:", stableRatio, stableAsset.sliderValue, stableValue??0)
      //Get the % of assets in lev
      const levRatio = 1 - stableRatio
      //Get the % of assets to swap to acheive 20% stables
      //ex: 20% in stables, 80% in levAsset, means we need to get 65% of the total Value to be stables which is 81.25% of the remaining levAsset
      const swapRatio = Math.max(swapPercent - stableRatio, 0) / levRatio
      // setQuickActionState({ levSwapRatio: swapRatio })

      const swapFromAmount = num(quickActionState?.levAsset?.amount).times(swapRatio).toNumber()
      const levAmount = shiftDigits(num(quickActionState?.levAsset?.amount).minus(swapFromAmount).toNumber(), quickActionState?.levAsset?.decimal)
      var stableOutAmount = 0
      if (swapFromAmount != 0){
        console.log("are we in here")
        const { msg: swap, tokenOutMinAmount, foundToken } = swapToCDTMsg({
          address, 
          swapFromAmount,
          swapFromAsset: quickActionState?.levAsset,
          prices,
          cdtPrice,
          tokenOut: 'USDC'
        })
        msgs.push(swap as MsgExecuteContractEncodeObject)
        stableOutAmount = tokenOutMinAmount
        //2) Swap CDT to stableAsset
        console.log("are we past #1")
        if (!foundToken){
        const { msg: CDTswap, tokenOutMinAmount: stableOutMinAmount } =  swapToCollateralMsg({
          address,
          cdtAmount: shiftDigits(tokenOutMinAmount, -6),
          swapToAsset: stableAsset,
          prices,
          cdtPrice,
        })
        msgs.push(CDTswap as MsgExecuteContractEncodeObject)
        stableOutAmount = stableOutMinAmount
        }
      }

      //Set stableAsset deposit amount - Add swapAmount to the stableAsset
      const stableAmount = num(stableAsset.amount).plus(shiftDigits(stableOutAmount, -stableAsset.decimal)).toNumber();
      console.log("STABLE AMOUNT", stableAmount, shiftDigits(stableOutAmount, -stableAsset.decimal), stableAsset.amount)

      //3) Deposit both lev & stable assets to a new position
      const levAsset = {...quickActionState?.levAsset as any, amount: shiftDigits(levAmount, -quickActionState?.levAsset?.decimal)}
      const newStableAsset = {...stableAsset as any, amount: stableAmount}
      const summary = [ levAsset, newStableAsset ]
      //Set QAState
      setQuickActionState({ summary })
      console.log("summary:", summary)
      quickActionState.summary = summary
      quickActionState.levAsset = levAsset
      quickActionState.stableAsset = newStableAsset

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
      console.log("QA positionID", positionId)
      const { msgs: loops, newValue, newLTV } = loopPosition(
        true,
        cdtPrice,
        mintLTV.toNumber(),
        positionId, 
        loopMax, 
        address, 
        prices, 
        basket,
        num(quickActionState?.levAsset?.sliderValue).plus(stableValue??0).toNumber(), 
        0, 
        45,
        positions
      )
      // msgs = msgs.concat(loops as MsgExecuteContractEncodeObject[]) 
      newPositionValue = newValue
      
      return { msgs, newPositionValue, swapRatio, summary }
    },
    enabled: !!address,
  })

  const { msgs, newPositionValue, swapRatio, summary } = useMemo(() => {
    if (!queryData) return { msgs: undefined, newPositionValue: 0, swapRatio: 0, summary: []}
    else return queryData
  }, [queryData])

  const onInitialSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })    
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setQuickActionState({ readyToLoop: true })    
    setQuickActionState({ stableAsset: summary[1] })
  }


  console.log(msgs, stableAsset, quickActionState?.levAsset?.amount)
  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['quick action lev', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
  }), newPositionValue, swapRatio, summary}
}

export default useQuickAction
