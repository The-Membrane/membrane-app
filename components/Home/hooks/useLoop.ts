import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { useOraclePrice } from '@/hooks/useOracle'
import { loopPosition } from '@/services/osmosis'
// import useQuickActionVaultSummary from './useQuickActionVaultSummary'
import { num } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { loopMax } from '@/config/defaults'
import { setCookie } from '@/helpers/cookies'
import useMintState from '@/components/Mint/hooks/useMintState'
import useInitialVaultSummary from '@/components/Mint/hooks/useInitialVaultSummary'

const useLoop = (loop_msgs: MsgExecuteContractEncodeObject[]) => {
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const { mintState, setMintState } = useMintState()
  const { summary = [] } = mintState

  const { initialTVL, initialBorrowLTV, debtAmount} = useInitialVaultSummary()
 

  const positionId = useMemo(() => {
    if (basketPositions && basketPositions[0].positions) return basketPositions[0].positions[basketPositions[0].positions.length-1]?.position_id
  }, [basket])
  console.log("loop positionID", positionId)

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    newPositionValue: number
  }
  
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick action widget',
      address,
      positionId, 
      prices,
      basketPositions
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !positionId) return { msgs: undefined, newPositionValue: 0 }
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.price ?? "0")
      
      //4) Loop at 45%
      const mintLTV = num(.45)
      const positions = updatedSummary(summary, basketPositions, prices)
    //   const { msgs: loops, newValue } = loopPosition
      console.log(
        true,
        cdtPrice,
        mintLTV.toNumber(),
        positionId, 
        loopMax, 
        address, 
        prices, 
        basket,
        initialTVL,
        debtAmount, 
        initialBorrowLTV,
        positions
      )
    //   msgs = msgs.concat(loops as MsgExecuteContractEncodeObject[]) 
    //   newPositionValue = newValue
      
      return { msgs, newPositionValue }
    },
    enabled: !!address,
  })

  const { msgs, newPositionValue } = useMemo(() => {
    if (!queryData) return { msgs: undefined, newPositionValue: 0 }
    else return queryData
  }, [queryData])

  
  const onLoopSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })    
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    if (quickActionState.useCookies) setCookie("no liq leverage " + positionId, newPositionValue.toString(), 3650)
    setQuickActionState({ readyToLoop: false })
  }

  console.log("loop", loop_msgs, newPositionValue)
  return {
    action: useSimulateAndBroadcast({
    msgs: loop_msgs,
    queryKey: ['quick action loops', (loop_msgs?.toString()??"0")],
    onSuccess: onLoopSuccess,
    }), newPositionValue}
}

export default useLoop
