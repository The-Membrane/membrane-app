import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscount } from '@/services/cdp'
import useWallet from './useWallet'
import { useOraclePrice } from './useOracle'
import { denoms } from '@/config/defaults'
import useStaked from '@/components/Stake/hooks/useStaked'
import { shiftDigits } from '@/helpers/math'
import { Price } from '@/services/oracle'
import { useCallback } from 'react'
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { set } from 'lodash'

type Store = {
  basketState: Basket
  setBasketState: (partialState: Partial<Basket>) => void
  reset: () => void
}

const initialState = {}

// @ts-ignore
const store = (set) => ({
  basketState: initialState,
  setBasketState: (partialState: Partial<Basket>) =>
    set(
      (state: Store) => ({ basketState: { ...state.basketState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
  reset: () => set((state: Store) => ({ ...state, basketState: initialState }), false, '@reset'),
})

export const useBasketState = create<Store>(persist(store, { name: 'basketState' }))


export const useBasket = () => {
  const { basketState, setBasketState } = useBasketState()

  // Function to determine if we need to fetch from API
  const shouldFetchBasket = useCallback(() => {
    // Add any conditions here that would require a fresh fetch
    // For example, if certain required data is missing from basketState
    return !basketState || Object.keys(basketState).length === 0
  }, [basketState])

  const result = useQuery({
    queryKey: ['basket'],
    queryFn: async () => {
      // First check if we can use basketState
      if (!shouldFetchBasket()) {
        return basketState
      }
      // If we need fresh data, fetch from API
      return getBasket()
    },
    // Only fetch if shouldFetchBasket returns true
    enabled: shouldFetchBasket(),
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
  if (shouldFetchBasket() && result.data) {
    setBasketState(result.data)
  }
  console.log("basket hook result", result)

  return result

}

export const useCollateralInterest = () => {
  return useQuery({
    queryKey: ['collateral interest'],
    queryFn: async () => {
      return getCollateralInterest()
    },
  })
}

export const useCreditRate = () => {
  return useQuery({
    queryKey: ['credit rate'],
    queryFn: async () => {
      return getCreditRate()
    },
  })
}

export const useUserPositions = () => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['positions', address],
    queryFn: async () => {
      if (!address) return
      console.log("requerying basket positions")
      return getUserPositions(address)
    },
    enabled: !!address,
  })
}

export const useUserDiscount = (address: string | undefined) => {
  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address],
    queryFn: async () => {
      if (!address) return { user: "", discount: "0" }
      return getUserDiscount(address)
    },
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
  })
}

