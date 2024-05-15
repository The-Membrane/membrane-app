import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'

export const useStakingClaim = (restake = false) => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg staking claims', address],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]
        
      const messageComposer = new StakingMsgComposer(address, contracts.staking)
      const msgs = messageComposer.claimRewards({restake})
      console.log("claiming rewards...")
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
    enabled: !!msgs,
    onSuccess,
  }), msgs}
}

export default useStakingClaim
