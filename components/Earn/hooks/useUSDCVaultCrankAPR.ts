import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import contracts from '@/config/contracts.json'
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { queryClient } from '@/pages/_app';

const useUSDCVaultCrankAPR = ( ) => {
  const { address } = useWallet()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'earn page management redeem msg creation',
      address,
    ],
    queryFn: () => {
      if (!address) return { msgs: undefined }
      var msgs = [] as MsgExecuteContractEncodeObject[]
    
      // Crank APR Msg Sim
      const crankMsg  = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.marsUSDCvault,
          msg: toUtf8(JSON.stringify({
              crank_a_p_r: {}
          })),
          funds: []
          })
      } as MsgExecuteContractEncodeObject
      msgs.push(crankMsg)
      
      return { msgs }
    },
    enabled: !!address,
  })

  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  console.log("crank msg:", msgs)

  const onInitialSuccess = () => {
    ///ADD A RESET FOR THE VAULT INFO QUERIES//
    queryClient.invalidateQueries({ queryKey: ['useAPR'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['earn page management crank apr', (msgs?.toString()??"0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs,
  })}
}

export default useUSDCVaultCrankAPR
