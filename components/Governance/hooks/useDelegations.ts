import useWallet from '@/hooks/useWallet'
import { getUserDelegations } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'

const useDelegations = () => {
  const { address } = useWallet()

  console.log({
    address,
  })

  return useQuery({
    queryKey: ['delegations', address],
    queryFn: async () => {
      if (!address) return Promise.reject('No address found')

      return getUserDelegations(address)
    },
    enabled: !!address,
  })
}

export default useDelegations
