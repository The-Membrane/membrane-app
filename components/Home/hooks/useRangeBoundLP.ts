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

const useAutoSP = ( ) => { 
  const { address } = useWallet()
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const cdtAsset = useAssetBySymbol('CDT')
  const boundedCDTAsset = useAssetBySymbol('range-bound-CDT')
  const boundedCDTBalance = useBalanceByAsset(boundedCDTAsset)??"1"

  const { data } = useBoundedCDTVaultTokenUnderlying(shiftDigits(boundedCDTBalance, 6).toFixed(0))
  const underlyingCDT = data ?? "1"
  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  console.log("bounded", address,
    quickActionState.rangeBoundLPwithdrawal,
    quickActionState.rangeBoundLPdeposit,  
    cdtAsset,
    boundedCDTAsset,
    underlyingCDT,
    boundedCDTBalance
)
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'bounded_msg_creation',
      address,
      quickActionState.rangeBoundLPwithdrawal,
      quickActionState.rangeBoundLPdeposit,
      cdtAsset,
      boundedCDTAsset,
      underlyingCDT,
      boundedCDTBalance
    ],
    queryFn: () => {
      if (!address || !cdtAsset || !boundedCDTAsset) {console.log("bounded early return", address, boundedCDTAsset, quickActionState, underlyingCDT, boundedCDTBalance); return { msgs: [] }}
      var msgs = [] as MsgExecuteContractEncodeObject[]

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
      }

      if (quickActionState.rangeBoundLPdeposit != 0){
        
        const funds = [{ amount: shiftDigits(quickActionState.rangeBoundLPdeposit, cdtAsset.decimal).dp(0).toNumber().toString(), denom: cdtAsset.base }]      
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
    enabled: true,
  })}
}

export default useAutoSP