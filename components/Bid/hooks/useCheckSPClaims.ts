import useWallet from '@/hooks/useWallet'
import { getUserClaims as getSPUserClaims } from '@/services/stabilityPool'
import { useQuery } from '@tanstack/react-query'

const useCheckSPClaims = () => {
  const { address } = useWallet()
  return useQuery({
    queryKey: ['stability pool claims', address],
    queryFn: async () => {
      if (!address) return
      return getSPUserClaims(address)
    },
    enabled: !!address,
  })
}

export default useCheckSPClaims
