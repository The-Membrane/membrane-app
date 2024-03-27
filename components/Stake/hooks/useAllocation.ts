import useWallet from '@/hooks/useWallet'
import { getAllocation, getUnlocked } from '@/services/vesting'
import { useQuery } from '@tanstack/react-query'

const useAllocation = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['allocatiions', address],
    queryFn: async () => {
      if (!address) return null

      const allocations = await getAllocation(address)
      const unlocked = await getUnlocked(address)
      return {
        ...allocations,
        unlocked: unlocked.unlocked_amount,
      }
    },
    enabled: !!address,
  })
}

export default useAllocation
