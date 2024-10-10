import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscountValue } from '@/services/cdp'
import useWallet from './useWallet'
import { useOraclePrice } from './useOracle'
import { denoms } from '@/config/defaults'
import useStaked from '@/components/Stake/hooks/useStaked'
import { shiftDigits } from '@/helpers/math'
import { Price } from '@/services/oracle'

export const useBasket = () => {
  return useQuery({
    queryKey: ['basket'],
    queryFn: async () => {
      return getBasket()
    },
  })
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
      return getUserPositions(address)
    },
    enabled: !!address,
  })
}

export const useUserDiscountValue = (address: string) => {

  console.log("userdiscounts above useQuery")
  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address],
    queryFn: async () => {
      console.log("plz run pretty plz")
      return getUserDiscountValue(address)
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

