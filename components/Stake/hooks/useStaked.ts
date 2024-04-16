import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'
import useStakeState from './useStakeState'

const useStaked = () => {
  const { address } = useWallet()
  const { stakeState, setStakeState } = useStakeState()

  return useQuery({
    queryKey: ['staked', address, stakeState.transacted],
    queryFn: async () => {
      if (!address) return null

      const { staked, unstaking } = await getStaked(address)
      const rewards = await getRewards(address)

      //Reset transacted state
      setStakeState({ transacted: false })

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
