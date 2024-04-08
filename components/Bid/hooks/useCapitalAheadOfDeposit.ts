import useWallet from '@/hooks/useWallet'
import { getCapitalAheadOfDeposit } from '@/services/stabilityPool'
import { useQuery } from '@tanstack/react-query'

const useCapitalAheadOfDeposit = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['capital ahead', address],
    queryFn: async () => {
      if (!address) return
      return getCapitalAheadOfDeposit(address)
    },
    enabled: !!address,
  })
}

export default useCapitalAheadOfDeposit
