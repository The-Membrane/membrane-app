import useWallet from '@/hooks/useWallet'
import { getRewards, getStaked } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'

const useStaked = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['staked', address],
    queryFn: async () => {
      console.log("address check", address)
      if (!address) return null
      let static_address = "osmo1pss5jer8r00zv6x562uttctug9u96f4k2g0kam"
      console.log("got past address check")
      const { staked, unstaking } = await getStaked(static_address)
      const rewards = await getRewards(static_address)

      console.log("unstaking in query", {
        staked,
        unstaking,
        rewards,
      })
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
