import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscount, getBasketAssets, getUserRedemptionInfo, useCDPClient } from '@/services/cdp'
import useWallet from './useWallet'
import { useCallback } from 'react'
import useAssets from './useAssets'
import useAppState from '@/persisted-state/useAppState'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'


export const useBasket = () => {
  const { data: client } = useCDPClient()

  const result = useQuery({
    queryKey: ['basket', client],
    queryFn: async () => {
      return getBasket(client)
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
  const { data: client } = useCDPClient()

  return useQuery({
    queryKey: ['collateral interest', client],
    queryFn: async () => {
      if (!client) return
      return getCollateralInterest(client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCreditRate = () => {
  const { data: client } = useCDPClient()

  return useQuery({
    queryKey: ['credit rate', client],
    queryFn: async () => {
      if (!client) return
      return getCreditRate(client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserRemptionInfo = () => {
  const { data: client } = useCosmWasmClient()
  const { address } = useWallet()

  return useQuery({
    queryKey: ['user_redemption_info', address, client],
    queryFn: async () => {
      if (!address || !client) return
      return getUserRedemptionInfo(address, client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserPositions = () => {
  const { address } = useWallet()
  const { data: client } = useCDPClient()

  const result = useQuery({
    queryKey: ['positions', address, client],
    queryFn: async () => {
      if (!address || !client) return
      console.log("requerying basket positions")
      return getUserPositions(address, client)
    },
    enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  return result
}

export const useUserDiscount = (address: string | undefined) => {
  const { data: client } = useCosmWasmClient()

  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address, client],
    queryFn: async () => {
      if (!address || !client) return { user: "", discount: "0" }
      return getUserDiscount(address, client)
    },
    staleTime: 1000 * 60 * 5,
  })
}


export const useBasketPositions = () => {
  const { address } = useWallet()
  const { data: client } = useCDPClient()

  return useQuery({
    queryKey: ['all positions', client],
    queryFn: async () => {
      if (!client) return
      return getBasketPositions(client)
    },
    enabled: !!address,
    staleTime: 1000 * 60 * 5,
  })
}

