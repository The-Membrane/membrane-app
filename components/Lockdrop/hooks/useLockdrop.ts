import {
  getIncentiveDistribution,
  getIncentives,
  getRanking,
  getUserInfo,
} from '@/services/lockdrop'
import { useQuery } from '@tanstack/react-query'
import useWallet from '../../../hooks/useWallet'

export const useIncentives = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user incentives', address],
    queryFn: async () => {
      if (!address) return
      return getIncentives(address)
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
    queryKey: ['user ranking'],
    queryFn: async () => {
      if (!address) return

      const distribution = await getIncentiveDistribution()
      return getRanking(distribution, address)
    },
    enabled: !!address,
  })
}
