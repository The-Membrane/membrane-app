import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'

export const useClaimUnstake = () => {
  const { address } = useWallet()

  console.log("is this running at all?: -1", !address)
  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg staking claims', address],
    queryFn: () => {
      console.log("is this running at all?: 0", !address)
      if (!address) return [] as MsgExecuteContractEncodeObject[]
        
    console.log("is this running at all?: 1")
      const messageComposer = new StakingMsgComposer(address, contracts.staking)
      
  console.log("is this running at all?: 2")
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
