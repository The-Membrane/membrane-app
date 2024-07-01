import { useBasket, useUserPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import useInitialVaultSummary from './useInitialVaultSummary'

const useVaultSummary = () => {
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { mintState } = useMintState()
  const { data } = useInitialVaultSummary(mintState.positionNumber-1)
  const { initialBorrowLTV, initialLTV, initialTVL, basketAssets, debtAmount } = data || { 
    initialBorrowLTV: 0, 
    initialLTV: 0, 
    debtAmount: 0, 
    initialTVL: 0, 
    basketAssets: []
  }

  const Basket = useMemo(() => { return basket }, [basket])
  const CollateralInterest = useMemo(() => { return collateralInterest }, [collateralInterest])
  const BasketPositions = useMemo(() => { return basketPositions }, [basketPositions])
  const Prices = useMemo(() => { return prices }, [prices])
  const Summary = useMemo(() => {  return mintState?.summary }, [mintState?.summary])

  return useQuery({queryKey: ['vault summary',
    BasketPositions,
    Basket,
    CollateralInterest,
    Prices,
    Summary,
    mintState.mint,
    mintState.repay,
    mintState.positionNumber,
    mintState.newDebtAmount,
  ],
  queryFn: async () => {
      //Start: 86
      //High Score (use mintState?.summary for dep): 61
      //Using Memo'd mint state for MintState dep: 68-70
    console.log("LTVs", initialBorrowLTV, initialLTV, debtAmount, initialTVL)

    return calculateVaultSummary({
      basket,
      collateralInterest,
      basketPositions,
      positionIndex: mintState.positionNumber-1,
      prices,
      newDeposit: mintState?.totalUsdValue || 0,
      summary: mintState?.summary,
      mint: mintState?.mint,
      repay: mintState?.repay,
      newDebtAmount: mintState?.newDebtAmount,
      initialBorrowLTV,
      initialLTV: initialLTV??0,
      debtAmount: debtAmount??0,
      initialTVL: initialTVL??0,
      basketAssets: basketAssets??[],
    })},
  })
}

export default useVaultSummary
