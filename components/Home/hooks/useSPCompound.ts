import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { queryClient } from '@/pages/_app';

const useSPCompound = ( ) => {
  const { address } = useWallet()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'quick action SP compound',
      address,
    ],
    queryFn: () => {
      if (!address) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]
    
      // Compound Msg Sim
      const compoundMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.stabilityPool,
          msg: toUtf8(JSON.stringify({
              compound_fee: { num_of_events: undefined }
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
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['quick_action_SP_compound_sim', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useSPCompound