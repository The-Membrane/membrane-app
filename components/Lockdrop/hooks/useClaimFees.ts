import contracts from '@/config/contracts.json'
import { VestingMsgComposer } from '@/contracts/codegen/vesting/Vesting.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'

const useClaimFees = () => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['allocation claim fees', 'msgs', address],
    queryFn: () => {
      if (!address) return
      const messageComposer = new VestingMsgComposer(address, contracts.vesting)

      const claimFeeMsg = messageComposer.claimFeesforContract()
      const claimReceipientMsg = messageComposer.claimFeesforRecipient()
      return [claimFeeMsg, claimReceipientMsg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['allocations'] })
  }

  return {action: useSimulateAndBroadcast({
    msgs,
    onSuccess,
    enabled: true
  }), msgs}
}

export default useClaimFees
