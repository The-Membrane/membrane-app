import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'
import { cond } from 'lodash'

const useStaked = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['staked', address],
    queryFn: async () => {
      if (!address) return null
      let static_address = "osmo1pss5jer8r00zv6x562uttctug9u96f4k2g0kam"
      const { staked, unstaking } = await getStaked(static_address)
      console.log("unstaked", { unstaking, staked })
      const rewards = await getRewards(static_address) || []

      //Reward query is erroring

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
