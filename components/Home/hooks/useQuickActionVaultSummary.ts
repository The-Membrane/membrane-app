import { useBasket, useUserPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import useInitialVaultSummary from '@/components/Mint/hooks/useInitialVaultSummary'
import useQuickActionState from './useQuickActionState'

const useQuickActionVaultSummary = () => {
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { quickActionState } = useQuickActionState()
  const { initialBorrowLTV, initialLTV, initialTVL, basketAssets, debtAmount } = useInitialVaultSummary()
console.log("initialBorrowLTV", initialBorrowLTV)
  return useMemo(() => {
    
    if (!quickActionState?.levAsset || !quickActionState?.stableAsset){
      console.log("stuck on lev", quickActionState?.levAsset, quickActionState?.stableAsset)
      return {
        debtAmount: 0,
        cost: 0,
        tvl: 0,
        ltv: 0,
        borrowLTV: 0,
        liquidValue: 0,
        liqudationLTV: 0,
      }
    }

    return calculateVaultSummary({
      basket,
      collateralInterest,
      basketPositions,
      prices,
      newDeposit: ((quickActionState?.levAsset?.sliderValue??0) || 0) + ((quickActionState?.stableAsset?.amount as number) || 0),
      summary: [quickActionState?.levAsset, quickActionState?.stableAsset],
      mint: 0,
      initialBorrowLTV,
      initialLTV,
      debtAmount: 0,
      initialTVL,
      basketAssets,
    })
  }, [
    basketPositions,
    collateralInterest,
    prices,
    quickActionState?.summary,
  ])
}

export default useQuickActionVaultSummary
