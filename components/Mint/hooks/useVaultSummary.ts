import { useBasket, useUserPositions, useCollateralInterest, useUserDiscount } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import useMintState from './useMintState'
import useInitialVaultSummary from './useInitialVaultSummary'
import useWallet from '@/hooks/useWallet'

const useVaultSummary = () => {
  const { address } = useWallet()
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { data: discount } = useUserDiscount(address)
  const { mintState } = useMintState()
  console.log("positionNumber on top", mintState.positionNumber)
  const { data } = useInitialVaultSummary(mintState.positionNumber-1)
  
  const SumData = useMemo(() => { return data }, [data])  
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
    SumData,
    mintState.mint,
    mintState.repay,
    mintState.positionNumber,
    mintState.newDebtAmount,
    discount,
  ],
  queryFn: async () => {
    console.log("positionNumber", mintState.positionNumber)
    console.log("LTVs", initialBorrowLTV, initialLTV, debtAmount, initialTVL, mintState.newDebtAmount,
      mintState.mint,
      mintState.repay)

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
      initialLTV: initialLTV,
      debtAmount: debtAmount,
      initialTVL: initialTVL,
      basketAssets: basketAssets,
      discount: discount?.discount??"0",
    })},
  })
}

export default useVaultSummary
