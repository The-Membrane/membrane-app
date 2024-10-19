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
import { useCDTVaultTokenUnderlying } from '@/components/Earn/hooks/useEarnQueries'
import { num } from '@/helpers/num'

const useAutoSP = ( ) => { 
  const { address } = useWallet()
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const cdtAsset = useAssetBySymbol('CDT')
  const earnCDTAsset = useAssetBySymbol('earnCDT')
  const earnCDTBalance = useBalanceByAsset(earnCDTAsset)??"1"

  const { data } = useCDTVaultTokenUnderlying(shiftDigits(earnCDTBalance, 6).toFixed(0))
  const underlyingCDT = data ?? "1"
  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'autoSP_msg_creation',
      address,
      quickActionState.autoSPwithdrawal,
      quickActionState.autoSPdeposit,
      cdtAsset,
      earnCDTAsset,
      underlyingCDT,
      earnCDTBalance
    ],
    queryFn: () => {
      if (!address || !cdtAsset || !earnCDTAsset) {console.log("autoSP early return", address, earnCDTAsset, quickActionState, underlyingCDT, earnCDTBalance); return { msgs: [] }}
      var msgs = [] as MsgExecuteContractEncodeObject[]

      if (quickActionState.autoSPwithdrawal != 0){

        const cdtWithdrawAmount = shiftDigits(quickActionState.autoSPwithdrawal, 6).toNumber()
        // find percent of underlying usdc to withdraw
        const percentToWithdraw = num(cdtWithdrawAmount).div(underlyingCDT).toNumber()

        // Calc VT to withdraw using the percent
        const withdrawAmount = num(shiftDigits(earnCDTBalance, 6)).times(percentToWithdraw).dp(0).toNumber()
        console.log("withdrawAmount", quickActionState.autoSPwithdrawal, withdrawAmount, cdtWithdrawAmount, percentToWithdraw)

        const funds = [{ amount: withdrawAmount.toString(), denom: earnCDTAsset.base }]      
        let exitMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.autoStabilityPool,
          msg: toUtf8(JSON.stringify({
              exit_vault: {}
          })),
          funds: funds
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(exitMsg)
      }

      if (quickActionState.autoSPdeposit != 0){
        
        const funds = [{ amount: shiftDigits(quickActionState.autoSPdeposit, cdtAsset.decimal).dp(0).toNumber().toString(), denom: cdtAsset.base }]      
        let enterMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.autoStabilityPool,
          msg: toUtf8(JSON.stringify({
              enter_vault: {}
          })),
          funds: funds
          })
        } as MsgExecuteContractEncodeObject
        msgs.push(enterMsg)
      }

      console.log("in query sp msgs:", msgs)
      
      return { msgs }
    },
    enabled: !!address,
  })
  
  const  msgs = queryData?.msgs ?? []

  console.log("autoSP msgs:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setQuickActionState({ autoSPdeposit: 0, autoSPwithdrawal: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['home_page_autoSP', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs?.length,
  })}
}

export default useAutoSP