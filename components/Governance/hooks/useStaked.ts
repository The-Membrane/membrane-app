import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked } from '@/services/governance'
import { useQuery } from '@tanstack/react-query'

const useStaked = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['staked', address],
    queryFn: async () => {
      if (!address) return null

      const staked = await getStaked(address)
      const rewards = await getRewards(address)

      return {
        staked,
        rewards,
      }
    },
    enabled: !!address,
  })
}

export default useStaked
