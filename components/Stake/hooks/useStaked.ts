import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'

const useStaked = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['staked', address],
    queryFn: async () => {
      if (!address) return null

      const { staked, unstaking } = await getStaked(address)
      const rewards = await getRewards(address)

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
