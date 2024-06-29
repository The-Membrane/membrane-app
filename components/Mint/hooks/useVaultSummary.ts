import { useBasket, useUserPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import useMintState from './useMintState'
import useInitialVaultSummary from './useInitialVaultSummary'

const useVaultSummary = () => {
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { mintState } = useMintState()
  const { initialBorrowLTV, initialLTV, initialTVL, basketAssets, debtAmount } = useInitialVaultSummary(mintState.positionNumber-1)

  const Basket = useMemo(() => { return basket }, [basket])
  const CollateralInterest = useMemo(() => { return collateralInterest }, [collateralInterest])
  const BasketPositions = useMemo(() => { return basketPositions }, [basketPositions])
  const Prices = useMemo(() => { return prices }, [prices])
  const MintState = useMemo(() => { return mintState }, [mintState])
  const Summary = useMemo(() => { return MintState.summary }, [MintState.summary])
  const Mint = useMemo(() => { return MintState.mint }, [MintState.mint])
  const Repay = useMemo(() => { return MintState.repay }, [MintState.repay])
  const PositionNumber = useMemo(() => { return MintState.positionNumber }, [MintState.positionNumber])

  return useMemo(() => {
    console.log("what changed:", basketPositions, basket, collateralInterest, prices, 
      mintState?.totalUsdValue, mintState?.summary, mintState?.mint, mintState?.repay, mintState?.newDebtAmount, mintState.positionNumber)
      //Start: 86
      //High Score: 61

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
      initialLTV,
      debtAmount,
      initialTVL,
      basketAssets,
    })
  }, [
    BasketPositions,
    Basket,
    CollateralInterest,
    Prices,
    Summary,
    Mint,
    Repay,
    PositionNumber,
  ])
}

export default useVaultSummary
