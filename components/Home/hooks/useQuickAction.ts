import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { LPMsg, swapToMsg } from '@/helpers/osmosis'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'
import { shiftDigits } from '@/helpers/math'
import { buildStabilityPooldepositMsg } from '@/services/stabilityPool'
import { coin } from '@cosmjs/stargate'
import { loopPosition } from '@/services/osmosis'
import useQuickActionVaultSummary from './useQuickActionVaultSummary'
import { num } from '@/helpers/num'
import { updatedSummary } from '@/services/cdp'
import { loopMax } from '@/config/defaults'

const useQuickAction = () => {
  const { quickActionState } = useQuickActionState()
  const { summary = [] } = quickActionState
  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()
  const usdcAsset = useAssetBySymbol("USDC")
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT')
  const { borrowLTV, maxMint, debtAmount, tvl } = useQuickActionVaultSummary()

  /////First we'll do 1 position, but these actions will be usable by multiple per user in the future//////

  //Use first position id or use the basket's next position ID (for new positions)
  const positionId = useMemo(() => {
    if (basketPositions !== undefined) {
      return basketPositions?.[0]?.positions?.[0]?.position_id
    } else {
      //Use the next position ID
      return basket?.current_position_id ?? ""
    }
  }, [basket, basketPositions])

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
    newPositionValue: number
    newPositionLTV: number
  }

  const { data: queryData } = useQuery<QueryData>({
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
      cdtAsset, basketPositions, tvl, debtAmount, summary
    ],
    queryFn: () => {
      if (!address || !basket || !usdcAsset || !prices || !cdtAsset || !quickActionState?.selectedAsset || ((maxMint??0) < 100 && ((quickActionState?.mint??0) + debtAmount < 100))) return {msgs: undefined, newPositionLTV: 0, newPositionValue: 0}
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      var newPositionLTV = 0
      //Deposit
      if ( num(quickActionState?.selectedAsset?.amount??"0") > num(0)){
        const deposit = getDepostAndWithdrawMsgs({ summary: [quickActionState?.selectedAsset as any], address, positionId, hasPosition: basketPositions !== undefined })
        msgs = msgs.concat(deposit)
      }
      if (quickActionState?.mint && quickActionState?.mint > 0){
        //Set cdtPrice
        const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")
        
        //If we are looping we skip the initial mint msg bc the loop will handle it
        if (quickActionState.action.value === "Loop"){
          //Loop
          //Calc LTV based on mint
          const mintLTV = num(quickActionState?.mint).div(maxMint??0).times(borrowLTV).div(100)
          const positions = updatedSummary(summary, basketPositions, prices)
          //Loop max amount
          const loops = loopPosition(
            cdtPrice,
            mintLTV.toNumber(), //"99423726"
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
          msgs = msgs.concat(loops!.msgs as MsgExecuteContractEncodeObject[])
          newPositionValue = loops!.newValue
          newPositionLTV = loops!.newLTV
        } else {

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
              cdtPrice,
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

          }
          
        }
      }
      return { msgs, newPositionValue, newPositionLTV }
    },
    enabled: !!address,
  })

  const { msgs, newPositionLTV, newPositionValue } = useMemo(() => {
    if (!queryData) return {msgs: undefined, newPositionLTV: 0, newPositionValue: 0}
    else return queryData
  }, [queryData])

  const onSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: [
      String(quickActionState?.mint) || '0',
      String(quickActionState?.selectedAsset?.amount) || '0',
      quickActionState?.action?.value,
    ],
    enabled: !!msgs && ((quickActionState?.mint??0) > 0) && ((quickActionState?.mint??0) + debtAmount > 99),
    onSuccess,
  }),
  newPositionValue,
  newPositionLTV}
}

export default useQuickAction
