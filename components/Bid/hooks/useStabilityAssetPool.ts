import useWallet from '@/hooks/useWallet'
import { getAssetPool } from '@/services/stabilityPool'
import { useQuery } from '@tanstack/react-query'

const useStabilityAssetPool = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['stability asset pool', address],
    queryFn: async () => {
      if (!address) return
      return getAssetPool(address)
    },
    enabled: !!address,
  })
}

export default useStabilityAssetPool
