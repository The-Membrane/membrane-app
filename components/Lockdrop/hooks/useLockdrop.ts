import {
  getIncentiveDistribution,
  getIncentives,
  getRanking,
  getUserInfo,
  getLockdrop,
  lockdropClient,
} from '@/services/lockdrop'
import { useQuery } from '@tanstack/react-query'
import useWallet from '@/hooks/useWallet'

export const useLockdropClient = () => {
  return useQuery({
    queryKey: ['lockdrop client'],
    queryFn: lockdropClient,
  })
}

export const useLockdrop = () => {
  return useQuery({
    queryKey: ['lockdrop'],
    queryFn: getLockdrop,
  })
}

export const useIncentives = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user incentives', address],
    queryFn: async () => {
      if (!address) return
      return getIncentives("osmo1v46a5pqqn0clx0xnmkdtnmxquxeqynza02tlxg")
    },
    enabled: !!address,
  })
}

export const useUserInfo = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user info', address],
    queryFn: async () => {
      if (!address) return
      return getUserInfo(address)
    },
    enabled: !!address,
  })
}

export const useRanking = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user ranking', address],
    queryFn: async () => {
      const distribution = await getIncentiveDistribution()
      return getRanking(distribution, address)
    },
  })
}
