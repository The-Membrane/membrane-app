import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'

export const useStakingClaim = (restake: boolean = false, sim: boolean = true) => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg_staking_claims', address, restake],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]
        
      const messageComposer = new StakingMsgComposer(address, contracts.staking)
      const msgs = messageComposer.claimRewards({restake})
      return [msgs] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['staking_claim', (msgs?.toString()??"0")],
    enabled: !!msgs,
    onSuccess,
  }), msgs}
}

export default useStakingClaim
