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
import { useRouter } from 'next/router'
import { useChainRoute } from './useChainRoute'

export const useLockdropClient = () => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['lockdrop client', appState.rpcUrl, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/lockdrop")) return

      return lockdropClient(appState.rpcUrl)
    }
  })
}

export const useLockdrop = () => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['lockdrop', appState.rpcUrl, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/lockdrop")) return

      return getLockdrop(appState.rpcUrl)
    },
  })
}

export const useIncentives = () => {
  const { appState } = useAppState()
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const router = useRouter()

  return useQuery({
    queryKey: ['user incentives', address, appState.rpcUrl, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/lockdrop")) return
      if (!address) return
      return getIncentives(address, appState.rpcUrl)
    },
    enabled: !!address,
  })
}

export const useUserInfo = () => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['user info', address, appState.rpcUrl, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/lockdrop")) return
      if (!address) return
      return getUserInfo(address, appState.rpcUrl)
    },
    enabled: !!address,
  })
}

export const useRanking = () => {
  const { appState } = useAppState()
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const router = useRouter()

  return useQuery({
    queryKey: ['user ranking', address, appState.rpcUrl, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/lockdrop")) return
      const distribution = await getIncentiveDistribution(appState.rpcUrl)
      return getRanking(distribution, address)
    },
  })
}
