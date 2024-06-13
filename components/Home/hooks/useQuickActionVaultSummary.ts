import { useBasket, useUserPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { calculateVaultSummary } from '@/services/cdp'
import { useMemo } from 'react'
import useInitialVaultSummary from '@/components/Mint/hooks/useInitialVaultSummary'
import useQuickActionState from './useQuickActionState'
import { Summary } from '@/components/Mint/hooks/useMintState'

const useQuickActionVaultSummary = () => {
  const { data: basket } = useBasket()
  const { data: collateralInterest } = useCollateralInterest()
  const { data: basketPositions } = useUserPositions()
  const { data: prices } = useOraclePrice()
  const { quickActionState } = useQuickActionState()
  const { initialBorrowLTV, initialLTV, initialTVL, basketAssets, debtAmount } = useInitialVaultSummary()

  //Calc totalvalue with an assumption that the second asset in the summary is a stable
  const totalUsdValue = useMemo(() => {
    if (!quickActionState?.summary) return 0
    return quickActionState?.summary[0].sliderValue??0 + (quickActionState?.summary[1].amount as number)??0
  }, [quickActionState?.summary])

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
      basketPositions: undefined,
      prices,
      newDeposit: totalUsdValue,
      summary: quickActionState?.summary,
      mint: 0,
      initialBorrowLTV,
      initialLTV,
      debtAmount: 0,
      initialTVL: 0,
      basketAssets,
    })
  }, [
    basketPositions,
    collateralInterest,
    prices,
    quickActionState?.summary,
    totalUsdValue
  ])
}

export default useQuickActionVaultSummary
