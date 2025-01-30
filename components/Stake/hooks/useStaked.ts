import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'


const useStaked = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['staked', address],
    queryFn: async () => {
      if (!address) return null

      // Check if we use stakeState or requery
      const data = await getStaked(address)

      const { deposit_list } = data

      const staking = deposit_list?.filter((s) => !s.unstake_start_time)
      const unstaking = deposit_list?.filter((s) => s.unstake_start_time)

      const staked = staking?.reduce((acc, s) => {
        return acc.plus(s.amount)
      }, num(0)).toNumber()

      const rewards = await getRewards(address)
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
