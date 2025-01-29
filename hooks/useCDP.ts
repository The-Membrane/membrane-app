import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscount, getBasketAssets, getUserRedemptionInfo } from '@/services/cdp'
import useWallet from './useWallet'
import { useCallback } from 'react'
import useBasketState from '@/persisted-state/useBasketState'
import useUserPositionState from '@/persisted-state/useUserPositionState'
import useAssets from './useAssets'


export const useBasket = () => {
  // const { basketState, setBasketState } = useBasketState()

  // Function to determine if we need to fetch from API
  // const shouldFetchBasket = useCallback(() => {
  //   // Add any conditions here that would require a fresh fetch
  //   // For example, if certain required data is missing from basketState
  //   return !basketState || Object.keys(basketState).length === 0
  // }, [basketState])

  const result = useQuery({
    queryKey: ['basket'],
    queryFn: async () => {
      // First check if we can use basketState
      // if (!shouldFetchBasket()) {
      //   return basketState
      // }
      // If we need fresh data, fetch from API
      return getBasket()
    },
    // enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
  // if (shouldFetchBasket() && result.data) {
  //   setBasketState(result.data)
  // }
  // console.log("basket hook result", result, shouldFetchBasket(), basketState)

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

      // console.log("is this running at all?")
      return getBasketAssets(basket, interest, assets)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCollateralInterest = () => {
  return useQuery({
    queryKey: ['collateral interest'],
    queryFn: async () => {
      return getCollateralInterest()
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCreditRate = () => {
  return useQuery({
    queryKey: ['credit rate'],
    queryFn: async () => {
      return getCreditRate()
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserRemptionInfo = () => {
  return useQuery({
    queryKey: ['user_redemption_info'],
    queryFn: async () => {
      return getUserRedemptionInfo()
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserPositions = () => {
  const { address } = useWallet()
  const { userPositionState, setUserPositionState } = useUserPositionState()

  // console.log((userPositionState && userPositionState[0].positions.length > 0 && userPositionState.length > 0 && userPositionState[0].user !== address), userPositionState[0].positions.length > 0, userPositionState, userPositionState.length > 0, userPositionState[0].user, address)

  // Function to determine if we need to fetch from API
  const shouldFetchUserPositions = useCallback(() => {
    // Add any conditions here that would require a fresh fetch
    // For example, if certain required data is missing from userPositionState
    return !userPositionState || Object.keys(userPositionState).length === 0 || (userPositionState && userPositionState[0].positions.length > 0 && userPositionState[0].user !== address)
  }, [userPositionState])

  const result = useQuery({
    queryKey: ['positions', address],
    queryFn: async () => {
      // First check if we can use userPositionState
      if (!shouldFetchUserPositions()) {
        return userPositionState
      }

      if (!address) return
      console.log("requerying basket positions")
      return getUserPositions(address)
    },
    enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  if (shouldFetchUserPositions() && result.data) {
    setUserPositionState(result.data)
  }

  return result
}

export const useUserDiscount = (address: string | undefined) => {
  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address],
    queryFn: async () => {
      if (!address) return { user: "", discount: "0" }
      return getUserDiscount(address)
    },
    staleTime: 1000 * 60 * 5,
  })
}


export const useBasketPositions = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: [' all positions'],
    queryFn: async () => {
      return getBasketPositions()
    },
    enabled: !!address,
    staleTime: 1000 * 60 * 5,
  })
}

