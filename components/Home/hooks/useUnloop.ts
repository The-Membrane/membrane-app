import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { useOraclePrice } from '@/hooks/useOracle'
import { loopPosition, unloopPosition } from '@/services/osmosis'
// import useQuickActionVaultSummary from './useQuickActionVaultSummary'
import { num, shiftDigits } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { loopMax } from '@/config/defaults'
import { setCookie } from '@/helpers/cookies'
import useMintState from '@/components/Mint/hooks/useMintState'
import useInitialVaultSummary from '@/components/Mint/hooks/useInitialVaultSummary'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'

const useUnLoop = (positionIndex: number) => {
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT')
  const walletCDT = useBalanceByAsset(cdtAsset)
  
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const { mintState, setMintState } = useMintState()
  const { summary = [] } = mintState

  const { initialTVL, initialBorrowLTV, debtAmount } = useInitialVaultSummary()
 

  const positionId = useMemo(() => {
    if (basketPositions && basketPositions[0].positions) return basketPositions[0].positions[basketPositions[0].positions.length-1]?.position_id
  }, [basketPositions])

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    newPositionValue: number
    newLTV: number
  }
  
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick action unloop',
      address,
      positionId, 
      prices,
      basketPositions,
      debtAmount, initialTVL, initialBorrowLTV
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !positionId) return { msgs: undefined, newPositionValue: 0, newLTV: 0 }
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === "factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt")?.price ?? "0")
      
      //4) Unloop 5 times
      const positions = updatedSummary(summary, basketPositions, prices)
      console.log("debtAmount", debtAmount)
      const { msgs: loops, newValue, newLTV } = unloopPosition(
        cdtPrice,
        parseFloat(walletCDT),
        basketPositions,
        address, 
        prices, 
        basket,
        initialTVL,
        debtAmount, 
        initialBorrowLTV,
        positions,
        positionId, 
        loopMax,
        positionIndex
      )
      msgs = msgs.concat(loops as MsgExecuteContractEncodeObject[]) 
      newPositionValue = newValue
      
      return { msgs, newPositionValue, newLTV }
    },
    enabled: !!address,
  })

  

  const { msgs, newPositionValue, newLTV } = useMemo(() => {
    if (!queryData) return { msgs: undefined, newPositionValue: 0, newLTV: 0 }
    else return queryData
  }, [queryData])

  
  const onSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })    
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  console.log(msgs, newPositionValue)
  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['quick action loops', (msgs?.toString()??"0")],
    onSuccess,
    }), newPositionValue, newLTV}
}

export default useUnLoop