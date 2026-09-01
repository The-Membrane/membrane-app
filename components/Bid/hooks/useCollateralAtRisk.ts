import { useMemo } from 'react'
import { useBasket, useBasketAssets, useBasketPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getRiskyPositions } from '@/services/cdp'
import useAppState from '@/persisted-state/useAppState'

/**
 * Returns the number of liquidatable CDPs and total debt at risk (in CDT).
 */
const useCollateralAtRisk = () => {
  const { data: prices } = useOraclePrice()
  const { data: allPositions } = useBasketPositions()
  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: basketAssets } = useBasketAssets()

  return useMemo(() => {
    if (!allPositions || !prices || !basket || !basketAssets) {
      return { count: 0, totalAtRisk: 0, atRiskCount: 0, totalDebtAtRisk: 0 }
    }

    const { liquidatibleCDPs, atRiskCDPs } = getRiskyPositions(allPositions, prices, basket, basketAssets)
    const filtered = liquidatibleCDPs.filter((pos) => pos !== undefined)
    const filteredAtRisk = atRiskCDPs.filter((pos) => pos !== undefined)

    const totalAtRisk = filtered.reduce((sum, pos) => {
      return sum + parseFloat(pos.fee || '0')
    }, 0)

    const totalDebtAtRisk = filteredAtRisk.reduce((sum, pos) => {
      return sum + parseFloat(pos.debt || '0')
    }, 0)

    return {
      count: filtered.length,
      totalAtRisk,
      atRiskCount: filteredAtRisk.length,
      totalDebtAtRisk,
    }
  }, [allPositions, prices, basket, basketAssets])
}

export default useCollateralAtRisk
