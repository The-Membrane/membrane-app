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

const useAutoSPEnter = ( ) => { 
  const { address } = useWallet()
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const cdtAsset = useAssetBySymbol('CDT')
  
  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'autoSP_enter_msg_creation',
      address,
      quickActionState.autoSPdeposit,
      cdtAsset,
    ],
    queryFn: () => {
      if (!address || !cdtAsset || quickActionState.autoSPdeposit === 0) return { msgs: undefined}
      var msgs = [] as MsgExecuteContractEncodeObject[]

      const funds = [{ amount: shiftDigits(quickActionState.autoSPdeposit, cdtAsset.decimal).dp(0).toNumber().toString(), denom: cdtAsset.base }]      
      const enterMsg  = {
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
      
      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  console.log("enter autoSP msgs:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    setQuickActionState({ autoSPdeposit: 0 })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['home_page_autoSP_enter', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useAutoSPEnter
