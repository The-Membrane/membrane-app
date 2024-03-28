import useWallet from '@/hooks/useWallet'
import useDelegateState from './useDelegateState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { buildUpdateDelegationMsg } from '@/services/staking'
import { decodeMsgs } from '@/helpers/decodeMsg'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'

const useSubmitProposal = () => {
  const { address } = useWallet()

  const { data: updateDelegationMsgs = [] } = useQuery<MsgExecuteContractEncodeObject[]>({
    queryKey: ['msg', 'submit proposal', address],
    queryFn: async () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      return []
    },
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['delegations'] })
  }

  return useSimulateAndBroadcast({
    msgs: updateDelegationMsgs,
    queryKey: [],
    onSuccess,
  })
}

export default useSubmitProposal
