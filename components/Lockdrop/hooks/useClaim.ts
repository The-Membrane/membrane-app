import useExecute from '@/hooks/useExecute'
import { getSigningLockdropClient } from '@/services/lockdrop'

import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { toUtf8 } from "@cosmjs/encoding";

import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useMemo } from 'react';

export const useClaim = () => {
  const { address } = useWallet()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['msg_lockdrop_claims', address],
    queryFn: async () => {
      if (!address) return { msgs: undefined }
      
      const msg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
        sender: address,
        contract: contracts.lockdrop,
        msg: toUtf8(JSON.stringify({
            claim: {} 
        })),
        funds: []
        })
      } as MsgExecuteContractEncodeObject

      return { msgs: [msg] }
    },
    enabled: !!address,
  })
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['lockdrop'] })
  }

  
  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])


  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['lockdrop_claim', (msgs?.toString()??"0")],
    enabled: !!msgs,
    onSuccess,
  }), msgs}
}

export default useClaim
