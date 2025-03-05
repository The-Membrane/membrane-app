import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'


const useStaked = () => {
  const { address } = useWallet()
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['staked', address],
    queryFn: async () => {
      if (!address) return null

      // Check if we use stakeState or requery
      const data = await getStaked(address, appState.rpcUrl)

      const { deposit_list } = data

      const staking = deposit_list?.filter((s) => !s.unstake_start_time)
      const unstaking = deposit_list?.filter((s) => s.unstake_start_time)

      const staked = staking?.reduce((acc, s) => {
        return acc.plus(s.amount)
      }, num(0)).toNumber()

      const rewards = await getRewards(address, appState.rpcUrl)
      //Reward query is erroring (?)

      return {
        staked,
        unstaking,
        rewards,
      }
    },
    enabled: !!address,
  })
}

export default useStaked
