import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions } from '@/services/cdp'
import useWallet from './useWallet'
import { useOraclePrice } from './useOracle'
import { denoms } from '@/config/defaults'
import useStaked from '@/components/Stake/hooks/useStaked'
import { shiftDigits } from '@/helpers/math'

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
  const { data: prices } = useOraclePrice()
  const { data } = useStaked()
  const { staked } = data || {}

  return useQuery({
    queryKey: ['user discount', address, prices, staked],
    queryFn: async () => {
      if (!address || !prices || !staked) return

      const mbrnPrice = prices?.find((price) => price.denom === denoms.MBRN[0])?.price??"0"
      const stakedBalance = shiftDigits(staked, -6).toNumber()
      const mbrnValue = stakedBalance * parseFloat(mbrnPrice)

      return mbrnValue
    },
    enabled: !!address,
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

