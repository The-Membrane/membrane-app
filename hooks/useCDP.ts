import { useOraclePrice } from '@/hooks/useOracle'
import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { getUserRedemptionInfo, getUserPositions, getBasketPositions, getCollateralInterest, getCreditRate, getUserDiscount, getBasket, getRates, getBasketAssets, useCDPClient } from '@/services/cdp'
import { useRouter } from 'next/router'
import useAppState from '@/persisted-state/useAppState'
import useAssets from '@/hooks/useAssets'

export const useBasket = (rpcUrl: string) => {
  const { data: client } = useCDPClient(rpcUrl)
  // const router = useRouter()

  const result = useQuery({
    queryKey: ['basket', client, rpcUrl],
    queryFn: async () => {
      // if (router.pathname != "/" && router.pathname != "/mint" && router.pathname != "/liquidate" && router.pathname != "/control-room" && router.pathname != "/manic") return
      if (!client) return {}
      return getBasket(client)
    },
    // enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  return result
}

export const useRates = (rpcUrl: string) => {
  const { data: client } = useCDPClient(rpcUrl)

  const result = useQuery({
    queryKey: ['rates', client, rpcUrl],
    queryFn: async () => {
      if (!client) return {}
      return getRates(client)
    },
    staleTime: 1000 * 60 * 5,
  })

  return result
}

export const useBasketAssets = () => {
  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: interest } = useCollateralInterest()
  const { chainName } = useChainRoute()
  const assets = useAssets(chainName)
  // const router = useRouter()


  return useQuery({
    queryKey: ['get_basket_assets', basket, interest, assets, appState.rpcUrl],
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
  const { appState } = useAppState()
  const { data: client } = useCDPClient(appState.rpcUrl)
  // const router = useRouter()

  return useQuery({
    queryKey: ['collateral interest', client, appState.rpcUrl],
    queryFn: async () => {
      if (!client) return {}
      // if (router.pathname != "/" && router.pathname != "/mint") return
      return getCollateralInterest(client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCreditRate = () => {
  const { appState } = useAppState()
  const { data: client } = useCDPClient(appState.rpcUrl)
  const router = useRouter()


  return useQuery({
    queryKey: ['credit rate', client, router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith("/mint") && !router.pathname.endsWith("/portfolio")) return
      if (!client) return {}
      return getCreditRate(client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserRemptionInfo = () => {
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const router = useRouter()

  return useQuery({
    queryKey: ['user_redemption_info', address, client, router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith("/mint") && !router.pathname.endsWith("/portfolio")) return
      if (!address || !client) return
      return getUserRedemptionInfo(address, client)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserPositions = () => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const { appState } = useAppState()
  const { data: client } = useCDPClient(appState.rpcUrl)
  const router = useRouter()

  const result = useQuery({
    queryKey: ['positions', address, client, router.pathname, appState.rpcUrl],
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
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)
  const router = useRouter()

  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address, client, router.pathname, appState.rpcUrl],
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
  const { appState } = useAppState()
  const { data: client } = useCDPClient(appState.rpcUrl)
  // const router = useRouter()

  return useQuery({
    queryKey: ['all positions', client, appState.rpcUrl],
    queryFn: async () => {
      // if (router.pathname != "/control-room" && router.pathname != "/mint") return
      if (!client) return
      return getBasketPositions(client)
    },
    enabled: !!address,
    staleTime: 1000 * 60 * 5,
  })
}

