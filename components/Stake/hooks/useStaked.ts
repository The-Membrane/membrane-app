import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'
import { cond } from 'lodash'

const useStaked = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['staked'],
    queryFn: async () => {
      if (!address) return null
      const { deposit_list } = await getStaked(address)

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
