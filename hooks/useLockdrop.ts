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
import useAppState from '@/persisted-state/useAppState'

export const useLockdropClient = () => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['lockdrop client'],
    queryFn: async () => lockdropClient(appState.rpcUrl),
  })
}

export const useLockdrop = () => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['lockdrop'],
    queryFn: async () => getLockdrop(appState.rpcUrl),
  })
}

export const useIncentives = () => {
  const { appState } = useAppState()
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user incentives', address],
    queryFn: async () => {
      if (!address) return
      return getIncentives(address, appState.rpcUrl)
    },
    enabled: !!address,
  })
}

export const useUserInfo = () => {
  const { address } = useWallet()
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['user info', address],
    queryFn: async () => {
      if (!address) return
      return getUserInfo(address, appState.rpcUrl)
    },
    enabled: !!address,
  })
}

export const useRanking = () => {
  const { appState } = useAppState()
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user ranking', address],
    queryFn: async () => {
      const distribution = await getIncentiveDistribution(appState.rpcUrl)
      return getRanking(distribution, address)
    },
  })
}
