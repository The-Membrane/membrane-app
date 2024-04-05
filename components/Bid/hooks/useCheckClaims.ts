import useWallet from '@/hooks/useWallet'
import { getUserClaims } from '@/services/liquidation'
import { useQuery } from '@tanstack/react-query'

const useCheckClaims = () => {
  const { address } = useWallet()
  return useQuery({
    queryKey: ['liquidation claims', address],
    queryFn: async () => {
      if (!address) return
      return getUserClaims(address)
    },
    enabled: !!address,
  })
}

export default useCheckClaims
