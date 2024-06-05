import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import { LPMsg, swapToCDTMsg, swapToCollateralMsg } from '@/helpers/osmosis'
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
import { set } from 'react-hook-form'

const useQuickAction = () => {
  const { quickActionState, setQuickActionState } = useQuickActionState()

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

  
  //Quick return when using the Bridge Card
  if (quickActionState.action.value === "Bridge to Stargaze" || quickActionState.action.value === "Bridge to Osmosis") return {action: useSimulateAndBroadcast({msgs: [], enabled: false}), newPositionLTV: 0, newPositionValue: 0}

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
      quickActionState?.swapInsteadof,
      usdcAsset,
      prices,
      cdtAsset, basketPositions, tvl, debtAmount, summary
    ],
    queryFn: () => {
      if (!address || !basket || !usdcAsset || !prices || !cdtAsset || !quickActionState?.selectedAsset) return {msgs: undefined, newPositionLTV: 0, newPositionValue: 0}
      var msgs = [] as MsgExecuteContractEncodeObject[]
      var newPositionValue = 0
      var newPositionLTV = 0
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")
      //Deposit or Swap to CDT
      if (num(quickActionState?.selectedAsset?.amount??"0") > num(0)){
        //Deposit
        if (!quickActionState.swapInsteadof){
          const deposit = getDepostAndWithdrawMsgs({ summary: [quickActionState?.selectedAsset as any], address, positionId, hasPosition: basketPositions !== undefined })
          msgs = msgs.concat(deposit)
        } else {
          //Choose amount to swap to CDT
          //- If LPing USDC, only swap half the amount
          //- Otherwise, swap the full amount to CDT
          const swapFromAmount = (quickActionState?.selectedAsset?.symbol === "USDC" && quickActionState?.action.value === "LP") ?
             num(quickActionState?.selectedAsset?.amount).div(2).toNumber() 
             : num(quickActionState?.selectedAsset?.amount).toNumber()

          //Swap
          const { msg: swap, tokenOutMinAmount } = swapToCDTMsg({
            address, 
            swapFromAmount,
            swapFromAsset: quickActionState?.selectedAsset,
            prices,
            cdtPrice,
          })
          msgs.push(swap as MsgExecuteContractEncodeObject)
          //Set the mint amount to the swap amount
          quickActionState.mint = shiftDigits(tokenOutMinAmount, -6).toNumber()
          setQuickActionState({mint: quickActionState.mint})
        
        }
      }
      
      if (quickActionState?.mint && quickActionState?.mint > 0){        
        /////Actions that require minting to acquire CDT/////
          if (quickActionState.action.value === "Loop"){            
            //If we are looping we skip the initial mint msg bc the loop will handle it
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
          } else if (!quickActionState.swapInsteadof) {

            //Mint
            const mint = getMintAndRepayMsgs({
              address,
              positionId,
              mintAmount: quickActionState?.mint,
              repayAmount: 0,
            })
            msgs = msgs.concat(mint)
          }          
        

        ////Actions after acquiring CDT////
        if (quickActionState.action.value === "LP"){
          //Swap
          const { msg: swap, tokenOutMinAmount } = swapToCollateralMsg({
            address, 
            cdtAmount: num(quickActionState?.mint).div(2).toNumber(), 
            swapToAsset: usdcAsset,
            prices,
            cdtPrice,
          })   
          var tokenOutAmount = tokenOutMinAmount
          var cdtInAmount = shiftDigits(quickActionState?.mint, 6).dp(0).div(2)
          //Swap here if its not a redundant swap
          if (quickActionState?.selectedAsset?.symbol !== "USDC" || quickActionState?.action.value !== "LP" || !quickActionState.swapInsteadof) {
            msgs.push(swap as MsgExecuteContractEncodeObject)
          }           
          //If we are LPing USDC & the input asset is USDC & we are not swapping instead of minting, then we don't swap again. 
          else {
            tokenOutAmount = shiftDigits(quickActionState?.mint, 6).dp(0).toNumber()
            cdtInAmount = cdtInAmount.times(2)
          }

          //LP   
          const lp = LPMsg({
            address,
            cdtInAmount: cdtInAmount.toString(),
            cdtAsset,
            pairedAssetInAmount: tokenOutAmount,
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
      String(quickActionState?.swapInsteadof),
    ],
    enabled: !!msgs && ((quickActionState?.mint??0) > 0),
    onSuccess,
  }),
  newPositionValue,
  newPositionLTV}
}

export default useQuickAction
