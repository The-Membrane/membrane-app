import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'

export const useClaimUnstake = () => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg staking claims', address],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]
        
      const messageComposer = new StakingMsgComposer(address, contracts.staking)
      const msgs = messageComposer.unstake({mbrnAmount: '0'})
      console.log(msgs)

      return [msgs] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    enabled: true,
    onSuccess,
  }), msgs}
}

export default useClaimUnstake
