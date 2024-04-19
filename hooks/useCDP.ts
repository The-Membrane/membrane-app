import { useQuery } from '@tanstack/react-query'
import { getBasket, getBasketPositions, getCollateralInterest, getCreditRate } from '@/services/cdp'
import useWallet from './useWallet'
import useMintState from '@/components/Mint/hooks/useMintState'

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

export const useBasketPositions = () => {
  const { address } = useWallet()
  const { mintState } = useMintState()

  return useQuery({
    queryKey: ['positions', address, mintState?.transacted],
    queryFn: async () => {
      if (!address) return
      console.log("queried basket positions")
      return getBasketPositions(address)
    },
    enabled: !!address,
  })
}
