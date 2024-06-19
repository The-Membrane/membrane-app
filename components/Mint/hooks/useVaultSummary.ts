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
  const { initialBorrowLTV, initialLTV, initialTVL, basketAssets, debtAmount } = useInitialVaultSummary(mintState.positionNumber)

  return useMemo(() => {
    return calculateVaultSummary({
      basket,
      collateralInterest,
      basketPositions,
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
    basketPositions,
    basket,
    collateralInterest,
    prices,
    mintState?.totalUsdValue,
    mintState?.summary,
    mintState?.mint,
    mintState?.repay,
    mintState?.newDebtAmount,
  ])
}

export default useVaultSummary
