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
import useQuickActionVaultSummary from './useQuickActionVaultSummary'
import { num, shiftDigits } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { loopMax } from '@/config/defaults'
import { AssetWithBalance } from '@/components/Mint/hooks/useCombinBalance'

const useQuickAction = () => {
  const { quickActionState, setQuickActionState } = useQuickActionState()

  // const { summary = [] } = quickActionState
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT')
  const usdcAsset = useAssetBySymbol('USDC')
  const { borrowLTV, maxMint, debtAmount, tvl } = useQuickActionVaultSummary()
  

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
    newPositionLTV: number
  }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick action widget',
      address,
      positionId, 
      borrowLTV, 
      maxMint,
      quickActionState?.levAsset,
      stableAsset,
      prices,
      cdtAsset, basketPositions, debtAmount,
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !cdtAsset || !quickActionState?.levAsset) return { msgs: undefined, newPositionLTV: 0, newPositionValue: 0 }
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      var newPositionLTV = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")

      //1) Swap to CDT
      //2) Swap to Stables
      //3) Deposit to new position
      //4) Loop the levAsset

      //1) Swap 85% of the levAsset to CDT
      const swapFromAmount = num(quickActionState?.levAsset?.amount).times(0.85).toNumber()
      const levAmount = shiftDigits(num(quickActionState?.levAsset?.amount).minus(swapFromAmount).toNumber(), quickActionState?.levAsset?.decimal)
      const { msg: swap, tokenOutMinAmount } = swapToCDTMsg({
        address, 
        swapFromAmount,
        swapFromAsset: quickActionState?.levAsset,
        prices,
        cdtPrice,
      })
      console.log(swap, tokenOutMinAmount)
      msgs.push(swap as MsgExecuteContractEncodeObject)
      console.log("msgs:", msgs)
      //2) Swap CDT to stableAsset
      const { msg: CDTswap, tokenOutMinAmount: stableOutMinAmount } =  swapToCollateralMsg({
        address,
        cdtAmount: shiftDigits(tokenOutMinAmount, -6),
        swapToAsset: stableAsset,
        prices,
        cdtPrice,
      })
      msgs.push(CDTswap as MsgExecuteContractEncodeObject)

      console.log(stableAsset.amount, stableOutMinAmount)
      //Set stableAsset deposit amount - Add swapAmount to the stableAsset
      const stableAmount = num(stableAsset.amount).plus(num(stableOutMinAmount));

      //3) Deposit both lev & stable assets to a new position
      const levAsset = {...quickActionState?.levAsset as any, amount: shiftDigits(levAmount, -quickActionState?.levAsset?.decimal)}
      const newStableAsset = {...stableAsset as any, amount: shiftDigits(stableAmount.toNumber(), -stableAsset.decimal)}
      const summary = [ levAsset, newStableAsset ]
      //Set QAState
      setQuickActionState({ summary, levAsset, stableAsset: newStableAsset })
      quickActionState.summary = summary
      quickActionState.levAsset = levAsset
      quickActionState.stableAsset = newStableAsset

      console.log("summary", summary)
      const deposit = getDepostAndWithdrawMsgs({ 
        summary,
        address,
        positionId,
        hasPosition: false
      })
      msgs = msgs.concat(deposit)

      //4) Loop at 45%
      const mintLTV = num(.45)
      const positions = updatedSummary(summary, basketPositions, prices)
  console.log("positions", positions)
  const { msgs: loops, newValue, newLTV } = loopPosition(
        cdtPrice,
        mintLTV.toNumber(),
        positionId, 
        loopMax, 
        address, 
        prices, 
        basket,
        tvl, 
        debtAmount, 
        borrowLTV, 
        positions
      )
      msgs = msgs.concat(loops as MsgExecuteContractEncodeObject[])
      newPositionValue = newValue
      newPositionLTV = newLTV
      
      return { msgs, newPositionValue, newPositionLTV }
    },
    enabled: !!address,
  })

  const { msgs, newPositionLTV, newPositionValue } = useMemo(() => {
    if (!queryData) return { msgs: undefined, newPositionLTV: 0, newPositionValue: 0 }
    else return queryData
  }, [queryData])

  const onSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }
  console.log(msgs, stableAsset, quickActionState?.levAsset?.amount)
  return {
    action: useSimulateAndBroadcast({
    msgs,
    amount: "0",
    queryKey: ['quick action lev', (msgs?.toString()??"0")],
    enabled: true,
    onSuccess,
  }),
  newPositionValue,
  newPositionLTV}
}

export default useQuickAction
