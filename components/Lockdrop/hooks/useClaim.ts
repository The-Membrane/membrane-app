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

export const useClaim = () => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg_lockdrop_claims', address],
    queryFn: async () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]
      
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

      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['lockdrop'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['lockdrop_claim', (msgs?.toString()??"0")],
    enabled: !!msgs,
    onSuccess,
  }), msgs}
}

export default useClaim
