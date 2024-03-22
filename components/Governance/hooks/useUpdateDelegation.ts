import useWallet from '@/hooks/useWallet'
import useDelegateState from './useDelegateState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { buildUpdateDelegationMsg } from '@/services/staking'
import { decodeMsgs } from '@/helpers/decodeMsg'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'

const useUpdateDelegation = () => {
  const { delegateState } = useDelegateState()
  const { delegations = [] } = delegateState
  const { address } = useWallet()

  const amount = delegations.reduce((acc, delegation) => acc + delegation.newAmount, 0)

  console.log({
    amount,
  })

  const { data: updateDelegationMsgs = [] } = useQuery<MsgExecuteContractEncodeObject[]>({
    queryKey: ['msg', 'update delegation', address, amount.toString()],
    queryFn: async () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const msgs = buildUpdateDelegationMsg(address, delegations!)

      return msgs
    },
    enabled: !!address && !!delegations && Math.abs(amount) > 0,
  })

  console.log({
    msgs: decodeMsgs(updateDelegationMsgs),
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['delegations'] })
  }

  return useSimulateAndBroadcast({
    msgs: updateDelegationMsgs,
    amount: Math.abs(amount).toString(),
    queryKey: [],
    onSuccess,
  })
}

export default useUpdateDelegation
