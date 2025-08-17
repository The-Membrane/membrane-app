import { useBasket, useUserPositions, useCollateralInterest, useBasketAssets } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getBorrowLTV, getDebt, getLTV, getPositions, getTVL } from '@/services/cdp'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import useAppState from '@/persisted-state/useAppState'

const useInitialVaultSummary = (positionIndex: number = 0) => {
  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { data: basketAssets } = useBasketAssets()


  return useQuery({
    queryKey: ['initial vault summary',
      basketPositions,
      basket,
      prices,
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
        }
      }
      const calc_debtAmount = getDebt(basketPositions, positionIndex)
      const calc_initialTVL = getTVL(calc_initialPositions)
      const calc_initialBorrowLTV = getBorrowLTV(calc_initialTVL, calc_initialPositions, basketAssets)
      const calc_initialLTV = getLTV(calc_initialTVL, calc_debtAmount)

      return {
        initialBorrowLTV: calc_initialBorrowLTV,
        initialLTV: calc_initialLTV,
        debtAmount: calc_debtAmount,
        initialTVL: calc_initialTVL,
        basketAssets: basketAssets,
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
