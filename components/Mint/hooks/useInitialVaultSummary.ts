import { useBasket, useUserPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getBasketAssets, getBorrowLTV, getDebt, getLTV, getPositions, getTVL } from '@/services/cdp'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

const useInitialVaultSummary = (positionIndex: number = 0) => {
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()

  const Basket = useMemo(() => { return basket }, [basket])
  const CollateralInterest = useMemo(() => { return collateralInterest }, [collateralInterest])
  const BasketPositions = useMemo(() => { return basketPositions }, [basketPositions])
  const Prices = useMemo(() => { return prices }, [prices])

  return useQuery({
    queryKey: ['initial vault summary', 
      BasketPositions,
      Basket,
      CollateralInterest,
      Prices,
      positionIndex
    ],
    queryFn: async () => {
      //High score 76 refreshes
      const calc_initialPositions = getPositions(basketPositions, prices, positionIndex)
      if (!calc_initialPositions) {
        console.log("about to return 0 debt:", basketPositions, positionIndex)
        return { 
        initialBorrowLTV: 0, 
        initialLTV: 0, 
        debtAmount: 0, 
        initialTVL: 0, 
        basketAssets: []
      }}
      const calc_debtAmount = getDebt(basketPositions, positionIndex)
      const calc_basketAssets = getBasketAssets(basket!, collateralInterest!)
      const calc_initialTVL = getTVL(calc_initialPositions)
      const calc_initialBorrowLTV = getBorrowLTV(calc_initialTVL, calc_initialPositions, calc_basketAssets)
      const calc_initialLTV = getLTV(calc_initialTVL, calc_debtAmount)
  
      return {        
        initialBorrowLTV: calc_initialBorrowLTV,
        initialLTV: calc_initialLTV,
        debtAmount: calc_debtAmount,
        initialTVL: calc_initialTVL,
        basketAssets: calc_basketAssets,
      }
    },
  })

  // return useMemo(() => {
  //   console.log("inside initial vault sum", positionIndex)
  //   const calc_initialPositions = getPositions(basketPositions, prices, positionIndex)
  //   if (!calc_initialPositions) return { 
  //     initialBorrowLTV: 0, 
  //     initialLTV: 0, 
  //     debtAmount: 0, 
  //     initialTVL: 0, 
  //     basketAssets: []
  //   }
  //   const calc_debtAmount = getDebt(basketPositions, positionIndex)
  //   const calc_basketAssets = getBasketAssets(basket!, collateralInterest!)
  //   const calc_initialTVL = getTVL(calc_initialPositions)
  //   const calc_initialBorrowLTV = getBorrowLTV(calc_initialTVL, calc_initialPositions, calc_basketAssets)
  //   const calc_initialLTV = getLTV(calc_initialTVL, calc_debtAmount)

  //   return {        
  //     initialBorrowLTV: calc_initialBorrowLTV,
  //     initialLTV: calc_initialLTV,
  //     debtAmount: calc_debtAmount,
  //     initialTVL: calc_initialTVL,
  //     basketAssets: calc_basketAssets,
  //   }
  // }, [
  //   BasketPositions,
  //   Basket,
  //   CollateralInterest,
  //   Prices,
  //   positionIndex
  // ])
}

export default useInitialVaultSummary
