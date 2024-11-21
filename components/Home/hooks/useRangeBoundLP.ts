import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import useQuickActionState from './useQuickActionState'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from "@cosmjs/encoding";
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useBoundedCDTVaultTokenUnderlying } from '@/components/Earn/hooks/useEarnQueries'
import { num } from '@/helpers/num'
import { swapToCDTMsg, swapToCollateralMsg } from '@/helpers/osmosis'
import { useOraclePrice } from '@/hooks/useOracle'
import { getCLPositionsForVault } from '@/services/osmosis'

const useAutoSP = ( ) => { 
  const { address } = useWallet()
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const cdtAsset = useAssetBySymbol('CDT')
  const boundedCDTAsset = useAssetBySymbol('range-bound-CDT')
  const boundedCDTBalance = useBalanceByAsset(boundedCDTAsset)??"1"
  const { data: positionInfo } = getCLPositionsForVault()
  
  //Get USDC asset
  const usdcAsset = useAssetBySymbol('USDC')
  const { data: prices } = useOraclePrice()

  const { data } = useBoundedCDTVaultTokenUnderlying(shiftDigits(boundedCDTBalance, 6).toFixed(0))
  const underlyingCDT = data ?? "1"
  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
//   console.log("bounded", address,
//     quickActionState.rangeBoundLPwithdrawal,
//     quickActionState.rangeBoundLPdeposit,  
//     cdtAsset,
//     boundedCDTAsset,
//     underlyingCDT,
//     boundedCDTBalance,
//     usdcAsset, prices
// )
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'bounded_msg_creation',
      address,
      quickActionState.rangeBoundLPwithdrawal,
      quickActionState.rangeBoundLPdeposit,
      cdtAsset,
      boundedCDTAsset,
      underlyingCDT,
      boundedCDTBalance,
      usdcAsset, prices
    ],
    queryFn: () => {
      if (!address || !cdtAsset || !boundedCDTAsset || !usdcAsset || !prices) {console.log("bounded early return", address, boundedCDTAsset, quickActionState, underlyingCDT, boundedCDTBalance, usdcAsset, prices, positionInfo); return { msgs: [] }}
      var msgs = [] as MsgExecuteContractEncodeObject[]
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === cdtAsset.base)?.price ?? "0")


      if (quickActionState.rangeBoundLPwithdrawal != 0){

        const cdtWithdrawAmount = shiftDigits(quickActionState.rangeBoundLPwithdrawal, 6).toNumber()
        // find percent of underlying usdc to withdraw
        const percentToWithdraw = num(cdtWithdrawAmount).div(underlyingCDT).toNumber()

        // Calc VT to withdraw using the percent
        const withdrawAmount = num(shiftDigits(boundedCDTBalance, 6)).times(percentToWithdraw).dp(0).toNumber()
        console.log("withdrawAmount", quickActionState.rangeBoundLPwithdrawal, withdrawAmount, cdtWithdrawAmount, percentToWithdraw)

        const funds = [{ amount: withdrawAmount.toString(), denom: boundedCDTAsset.base }]      
        let exitMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.rangeboundLP,
          msg: toUtf8(JSON.stringify({
              exit_vault: {}
          })),
          funds: funds
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(exitMsg)

        //Calc swapFromAmount 
        const swapFromAmount = num(cdtWithdrawAmount).times(0.23).toNumber()
        console.log("exit RBLP amounts", cdtWithdrawAmount, swapFromAmount)
        //Post exit, swap USDC to CDT
        const { msg: swap, tokenOutMinAmount } = swapToCDTMsg({
          address, 
          swapFromAmount: swapFromAmount,
          swapFromAsset: usdcAsset,
          prices,
          cdtPrice,
        })
        msgs.push(swap as MsgExecuteContractEncodeObject)
      }

      if (quickActionState.rangeBoundLPdeposit != 0){

        //Divide total deposit amount by half
        const halfOfCDTDepositAmount = shiftDigits(quickActionState.rangeBoundLPdeposit, cdtAsset.decimal).dividedBy(2).dp(0).toNumber()
        //Swap half to USDC         
        const { msg: CDTswap, tokenOutMinAmount: usdcOutMinAmount } =  swapToCollateralMsg({
          address,
          cdtAmount: shiftDigits(halfOfCDTDepositAmount, -6).toString(),
          swapToAsset: usdcAsset,
          prices,
          cdtPrice,
          slippage: 0.5
        })
        msgs.push(CDTswap as MsgExecuteContractEncodeObject)          

        console.log("halfOfCDTDepositAmount", halfOfCDTDepositAmount, "usdcOutMinAmount", usdcOutMinAmount)
        
        const funds = [{ amount: halfOfCDTDepositAmount.toString(), denom: cdtAsset.base }, { amount: usdcOutMinAmount.toString(), denom: usdcAsset.base }]      
        let enterMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.rangeboundLP,
          msg: toUtf8(JSON.stringify({
              enter_vault: {}
          })),
          funds: funds
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(enterMsg)
      }

      console.log("in query bounded LP msgs:", msgs)
      
      return { msgs }
    },
    enabled: !!address,
  })
  
  const  msgs = queryData?.msgs ?? []

  console.log("bounded msgs:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setQuickActionState({ rangeBoundLPdeposit: 0, rangeBoundLPwithdrawal: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['home_page_bounded', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useAutoSP