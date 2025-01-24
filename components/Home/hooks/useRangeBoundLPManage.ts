import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { queryClient } from '@/pages/_app';

const useBoundedManage = () => {
  const { address } = useWallet()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick_action_LP_manage',
      address,
    ],
    queryFn: () => {
      if (!address) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      // Compound Msg Sim
      const compoundMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.rangeboundLP,
          msg: toUtf8(JSON.stringify({
            manage_vault: {}
          })),
          funds: []
        })
      } as MsgExecuteContractEncodeObject
      msgs.push(compoundMsg)

      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  console.log("compound msg:", msgs)

  const onInitialSuccess = () => {
    //We want the vault to resim so that the Compound button isn't incorrectly Enabled
    //Which results in a bunch of failed transactions as users continue to click the button
    queryClient.invalidateQueries({ queryKey: ['useRBLPCDTBalance'] })
    //Bounded Vault Queries
    queryClient.invalidateQueries({ queryKey: ['useBoundedCDTVaultTokenUnderlying'] })
    queryClient.invalidateQueries({ queryKey: ['useBoundedCDTRealizedAPR'] })
    queryClient.invalidateQueries({ queryKey: ['useBoundedTVL'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['quick_action_LP_manage_sim', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
    msgs
  }
}

export default useBoundedManage
