import { getDepostAndWithdrawMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'

import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'
import { loopPosition } from '@/services/osmosis'
import { num, shiftDigits } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { loopMax } from '@/config/defaults'
import useEarnState from './useEarnState'
import { Price } from '@/services/oracle'
import { Asset } from '@/helpers/chain'

const useStableYieldLoop = ( { usdyAsset, usdyPrice, prices}: { usdyAsset: Asset | null, usdyPrice: number, prices: Price[] | undefined }) => {
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const { earnState, setEarnState } = useEarnState()
  const cdtAsset = useAssetBySymbol('CDT')

  //Always using the basket's next position ID (for new positions)
  const positionId = useMemo(() => {
      //Use the next position ID
      return basket?.current_position_id ?? ""
  }, [basket])

  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    newPositionValue: number
    summary: any[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick action widget',
      address,
      positionId, 
      usdyAsset,
      earnState.deposit,
      usdyPrice,
      prices,
      cdtAsset, 
      basketPositions,
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !cdtAsset || !usdyAsset || positionId === "" || earnState.deposit === 0) return { msgs: undefined, newPositionValue: 0, summary: []}
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")

      //1) Swap to CDT
      //2) Swap to Stables
      //3) Deposit to new position
      //4) Loop the levAssets

      //1) Deposit USDY to a new position
      const TVL = usdyPrice * earnState.deposit
      let depositUSDY = {
        amount: shiftDigits(earnState.deposit, usdyAsset?.decimal??18),
        sliderValue: TVL,
        price: usdyPrice,
        ...usdyAsset
      }
      let summary = [ depositUSDY ] as any[]
      const deposit = getDepostAndWithdrawMsgs({ 
        summary,
        address,
        basketPositions,
        positionId,
        hasPosition: false
      })
      msgs = msgs.concat(deposit)

      //2) Loop at 90%
      const mintLTV = num(.90)
      const positions = updatedSummary(summary, undefined, prices)
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
        90,
        positions
      )
      console.log("loop msgs", loops) 
      msgs = msgs.concat(loops as MsgExecuteContractEncodeObject[]) 
      newPositionValue = newValue

      //Set leverage multiplier 
      setEarnState({ leverageMulti: newValue/TVL })
      //TODO: After testing we just hardcode this, it should always be the same ~10x
      
      return { msgs, newPositionValue, summary }
    },
    enabled: !!address,
  })

  const { msgs, newPositionValue, summary }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined, newPositionValue: 0, summary: []}
    else return queryData
  }, [queryData])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['positions'] })    
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }


  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn page usdy loop', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
  }), newPositionValue, positionId, summary}
}

export default useStableYieldLoop
