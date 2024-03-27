import { useBasket, useBasketPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import useMintState from './useMintState'

const useVaultSummary = () => {
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useBasketPositions()
  const { data: prices } = useOraclePrice()
  const { mintState } = useMintState()

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
  ])
}

export default useVaultSummary
