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
import useAppState from '@/persisted-state/useAppState'
import { useChainRoute } from '@/hooks/useChainRoute'

const useQuickAction = ({ borrowLTV }: { borrowLTV: number }) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const { appState } = useAppState()

  // const { summary = [] } = quickActionState
  const { address } = useWallet()
  const { chainName } = useChainRoute()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT', chainName)
  // const usdcAsset = useAssetBySymbol('USDC')


  /////First we'll do 1 position, but these actions will be usable by multiple per user in the future//////

  //Always using the basket's next position ID (for new positions)
  const positionId = useMemo(() => {
    //Use the next position ID
    return basket?.current_position_id ?? ""
  }, [basket])

  // const stableAsset = useMemo(() => {
  //   return usdcAsset! as AssetWithBalance
  // }, [usdcAsset])


  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    loop_msgs: MsgExecuteContractEncodeObject[] | undefined
    newPositionValue: number
    summary: any[]
  }
  // console.log("SV:", quickActionState?.stableAsset?.sliderValue)
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick action widget',
      address,
      positionId,
      quickActionState?.levAssets,
      borrowLTV,
      prices,
      cdtAsset,
      basketPositions,
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !cdtAsset || !quickActionState?.levAssets || borrowLTV === 0) return { msgs: undefined, loop_msgs: undefined, newPositionValue: 0, summary: [] }
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")

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
      const TVL = quickActionState?.levAssets.map((asset) => asset.sliderValue ?? 0).reduce((a, b) => a + b, 0)
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
    if (!queryData) return { msgs: undefined, loop_msgs: undefined, newPositionValue: 0, summary: [] }
    else return queryData
  }, [queryData])

  const onInitialSuccess = () => {
    // setQuickActionState({ readyToLoop: true })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    if (appState.setCookie) setCookie("qa leverage " + positionId, newPositionValue.toString(), 3650)
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
    queryKey: ['quick action loop', (loop_msgs?.toString() ?? "0"), String(quickActionState.readyToLoop)],
    onSuccess: onLoopSuccess,
  })


  // console.log(msgs, stableAsset, quickActionState?.levAssets?.amount)
  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['quick action lev', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
    }), loop: action, newPositionValue, positionId, summary
  }
}

export default useQuickAction
