import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import useStakeState from '@/persisted-state/useStakeState'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'


const useStaked = () => {
  const { address } = useWallet()
  const { stakeState, setStakeState } = useStakeState()

  // Function to determine if we need to fetch from API
  const shouldFetchStake = useCallback(() => {
    // Add any conditions here that would require a fresh fetch
    // For example, if certain required data is missing from stakeState
    return !stakeState || Object.keys(stakeState).length === 0
  }, [stakeState])

  return useQuery({
    queryKey: ['staked', address],
    queryFn: async () => {
      if (!address) return null

      // Check if we use stakeState or requery
      const data = !shouldFetchStake() ? stakeState : await getStaked(address)

      if (shouldFetchStake() && data) {
        setStakeState(data)
      }

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
