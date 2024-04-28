import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { StabilityPoolMsgComposer } from '@/contracts/codegen/stability_pool/StabilityPool.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'

export const useWithdrawStabilityPool = (amount: string) => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg omni-asset withdraw', address],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]
        
      const messageComposer = new StabilityPoolMsgComposer(address, contracts.stabilityPool)
      const msgs = messageComposer.withdraw({amount})
      return [msgs] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })
  
  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['stability asset pool'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
    msgs,
    enabled: true,
    onSuccess,
  }), msgs}
}

export default useWithdrawStabilityPool
