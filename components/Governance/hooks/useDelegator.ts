import useWallet from '@/hooks/useWallet'
import { getDelegatorInfo } from '@/services/staking'
import { useQuery } from '@tanstack/react-query'

const useDelegator = (address: string, enabled = false) => {
  return useQuery({
    queryKey: ['delegator', address],
    queryFn: async () => {
      if (!address) return Promise.reject('No address found')

      return getDelegatorInfo(address)
    },
    enabled: !!address && enabled,
  })
}

export default useDelegator
