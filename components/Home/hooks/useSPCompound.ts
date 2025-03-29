import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { queryClient } from '@/pages/_app';

const useSPCompound = () => {
  const { address } = useWallet()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick_action_SP_compound',
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
          contract: contracts.autoStabilityPool,
          msg: toUtf8(JSON.stringify({
            compound: {}
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

  // console.log("compound msg:", msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
    //We want the vault to resim so that the Compound button isn't incorrectly Enabled
    //Which results in a bunch of failed transactions as users continue to click the button
    queryClient.invalidateQueries({ queryKey: ['quick_action_SP_compound_sim'] })
    queryClient.invalidateQueries({ queryKey: ['quick_action_SP_compound'] })
    //autoSP Queries
    queryClient.invalidateQueries({ queryKey: ['useCDTVaultTokenUnderlying'] })
    queryClient.invalidateQueries({ queryKey: ['useCDTUSDCRealizedAPR'] })


  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['quick_action_SP_compound_sim', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    })
  }
}

export default useSPCompound
