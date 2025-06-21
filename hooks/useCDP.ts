import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscount, getBasketAssets, getUserRedemptionInfo, useCDPClient } from '@/services/cdp'
import useWallet from './useWallet'
import useAssets from './useAssets'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { useRouter } from 'next/router'
import { useChainRoute } from './useChainRoute'


export const useBasket = () => {
  const { data: client } = useCDPClient()
  // const router = useRouter()

  const result = useQuery({
    queryKey: ['basket', client],
    queryFn: async () => {
      // if (router.pathname != "/" && router.pathname != "/mint" && router.pathname != "/bid" && router.pathname != "/management" && router.pathname != "/manic") return
      if (!client) return {}
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
  const { chainName } = useChainRoute()
  const assets = useAssets(chainName)
  // const router = useRouter()


  return useQuery({
    queryKey: ['get_basket_assets', basket, interest, assets],
    queryFn: async () => {
      // if (router.pathname != "/" && router.pathname != "/mint") return
      if (!basket || !interest || !assets) return []

      console.log(" basketAssets")
      return getBasketAssets(basket, interest, assets)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCollateralInterest = () => {
  const { data: client } = useCDPClient()
  // const router = useRouter()

  return useQuery({
    queryKey: ['collateral interest', client],
    queryFn: async () => {
      if (!client) return {}
      // if (router.pathname != "/" && router.pathname != "/mint") return
      return getCollateralInterest(client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCreditRate = () => {
  const { data: client } = useCDPClient()
  const router = useRouter()


  return useQuery({
    queryKey: ['credit rate', client, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/mint") && !router.pathname.endsWith("/portfolio")) return
      if (!client) return {}
      return getCreditRate(client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserRemptionInfo = () => {
  const { data: client } = useCosmWasmClient()
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const router = useRouter()

  return useQuery({
    queryKey: ['user_redemption_info', address, client, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/mint")&& !router.pathname.endsWith("/portfolio")) return
      if (!address || !client) return
      return getUserRedemptionInfo(address, client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserPositions = () => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const { data: client } = useCDPClient()
  const router = useRouter()

  const result = useQuery({
    queryKey: ['positions', address, client, router.pathname],
    queryFn: async () => {
      console.log("route_running")
      if (!router.pathname.endsWith("/mint") && !router.pathname.endsWith("/portfolio")) return []
      if (!address || !client) return []
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
  const router = useRouter()

  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address, client, router.pathname],
    queryFn: async () => {
      if (!router.pathname.endsWith("/mint") && !router.pathname.endsWith("/portfolio")) return
      if (!address || !client) return { user: "", discount: "0" }
      return getUserDiscount(address, client)
    },
    staleTime: 1000 * 60 * 5,
  })
}


export const useBasketPositions = () => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const { data: client } = useCDPClient()
  // const router = useRouter()

  return useQuery({
    queryKey: ['all positions', client],
    queryFn: async () => {
      // if (router.pathname != "/management" && router.pathname != "/mint") return
      if (!client) return
      return getBasketPositions(client)
    },
    enabled: !!address,
    staleTime: 1000 * 60 * 5,
  })
}

