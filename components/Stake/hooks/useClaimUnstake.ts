import contracts from '@/config/contracts.json'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useRouter } from 'next/router'

export const useClaimUnstake = ({ address, sim = true, run = true }: { address: string | undefined, sim: boolean, run: boolean }) => {
  const router = useRouter()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg unstaking claims', address, run, router.pathname],
    queryFn: () => {
      if (router.pathname != "/bid" && !run) return
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new StakingMsgComposer(address, contracts.staking)

      const msgs = messageComposer.unstake({ mbrnAmount: '0' })

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
      enabled: (sim && !!msgs),
      onSuccess,
    }), msgs
  }
}

export default useClaimUnstake
