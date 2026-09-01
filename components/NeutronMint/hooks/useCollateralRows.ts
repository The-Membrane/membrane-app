import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'
import { useMemo } from 'react'
import { useBasket, useBasketAssets, useRates } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import useAppState from '@/persisted-state/useAppState'
import { CollateralRowData, getSymbolFromDenom, getLogoFromSymbol } from '../types'
import { getMockCollateralData, USE_MOCK_COLLATERAL_DATA } from '../mockCollateralData'

// Shared data fetching + shaping for the Available Collateral table.
export const useCollateralRows = (): CollateralRowData[] => {
  const { appState } = useAppState()
  const { data: prices } = useOraclePrice()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: rates } = useRates(appState.rpcUrl)
  const { data: basketAssets } = useBasketAssets()

  // Mock data for testing supply caps
  const mockData = USE_MOCK_COLLATERAL_DATA ? getMockCollateralData() : null
  const basketData = mockData?.basket || basket
  const pricesData = mockData?.prices || prices
  const basketAssetsData = mockData?.basketAssets || basketAssets

  // Get available collateral from basket
  const collateralRows = useMemo<CollateralRowData[]>(() => {
    if (!basketData || !basketAssetsData || !pricesData) return []

    // js-index-maps: build the denom -> price index once instead of calling
    // .find() on pricesData for every basket asset in the loop below.
    const pricesByDenom = new Map(pricesData.map(p => [p.denom, p.price]))

    const rows: CollateralRowData[] = []
    for (const basketAsset of basketAssetsData) {
      // Filter out assets with zero supply cap
      const assetSupplyCapRatio = num(basketAsset.supplyCapRatio || 0)
      if (!assetSupplyCapRatio.isGreaterThan(0)) continue

      const index = rows.length
      const denom = basketAsset.asset?.base || ''
      const symbol = basketAsset.asset?.symbol || getSymbolFromDenom(denom, basketData)
      const logo = basketAsset.asset?.logo || getLogoFromSymbol(symbol)
      const priceRaw = pricesByDenom.get(denom) || 0
      const price = num(priceRaw).toNumber()

      // Get APY from rates store's lastest_collateral_rates
      const rate = rates?.lastest_collateral_rates?.[index]?.rate
      const apy = rate ? num(rate).times(100).toNumber() : 0

      // Get supply cap info
      const supplyCap = basketData.collateral_supply_caps?.[index]
      const currentSupply = supplyCap
        ? shiftDigits(supplyCap.current_supply, -(basketAsset.asset?.decimal || 6)).toNumber()
        : 0
      const supplyCapRatio = num(supplyCap?.supply_cap_ratio || 0).toNumber()

      // Calculate if supply cap is reached
      // Supply cap check: current_supply / (current_supply + debt_total) >= supply_cap_ratio
      const currentSupplyAmount = supplyCap?.current_supply
        ? shiftDigits(supplyCap.current_supply, -(basketAsset.asset?.decimal || 6)).toNumber()
        : 0
      const debtTotalAmount = supplyCap?.debt_total
        ? shiftDigits(supplyCap.debt_total, -6).toNumber()
        : 0

      const totalValue = currentSupplyAmount + debtTotalAmount
      const currentRatio = totalValue > 0 ? currentSupplyAmount / totalValue : 0
      const isSupplyCapReached = supplyCapRatio > 0 && currentRatio >= supplyCapRatio

      rows.push({
        symbol,
        logo,
        subtext: basketAsset.asset?.description,
        denom,
        apy,
        depositAmount: currentSupply,
        depositUsdValue: num(currentSupply).times(price).toNumber(),
        price,
        maxLTV: basketAsset.maxLTV,
        maxBorrowLTV: basketAsset.maxBorrowLTV,
        supplyCap: supplyCap,
        isDeposited: false,
        isSupplyCapReached,
        currentRatio,
      })
    }
    return rows
  }, [basketData, basketAssetsData, pricesData, rates])

  return collateralRows
}
