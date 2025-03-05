import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscount, getBasketAssets, getUserRedemptionInfo } from '@/services/cdp'
import useWallet from './useWallet'
import { useCallback } from 'react'
import useAssets from './useAssets'
import useAppState from '@/persisted-state/useAppState'


export const useBasket = () => {
  const { appState } = useAppState()

  const result = useQuery({
    queryKey: ['basket'],
    queryFn: async () => {
      return getBasket(appState.rpcUrl)
    },
    // enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  return result
}

export const useBasketAssets = () => {
  const { data: basket } = useBasket()
  const { data: interest } = useCollateralInterest()
  const assets = useAssets("osmosis")


  return useQuery({
    queryKey: ['get_basket_assets', basket, interest, assets],
    queryFn: async () => {
      if (!basket || !interest || !assets) return []

      console.log(" basketAssets")
      return getBasketAssets(basket, interest, assets)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCollateralInterest = () => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['collateral interest'],
    queryFn: async () => {
      return getCollateralInterest(appState.rpcUrl)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCreditRate = () => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['credit rate'],
    queryFn: async () => {
      return getCreditRate(appState.rpcUrl)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserRemptionInfo = () => {
  const { appState } = useAppState()
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user_redemption_info', address],
    queryFn: async () => {
      if (!address) return
      return getUserRedemptionInfo(address, appState.rpcUrl)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserPositions = () => {
  const { address } = useWallet()
  const { appState } = useAppState()

  const result = useQuery({
    queryKey: ['positions', address],
    queryFn: async () => {
      if (!address) return
      console.log("requerying basket positions")
      return getUserPositions(address, appState.rpcUrl)
    },
    enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  return result
}

export const useUserDiscount = (address: string | undefined) => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address],
    queryFn: async () => {
      if (!address) return { user: "", discount: "0" }
      return getUserDiscount(address, appState.rpcUrl)
    },
    staleTime: 1000 * 60 * 5,
  })
}


export const useBasketPositions = () => {
  const { address } = useWallet()
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['all positions'],
    queryFn: async () => {
      return getBasketPositions(appState.rpcUrl)
    },
    enabled: !!address,
    staleTime: 1000 * 60 * 5,
  })
}

