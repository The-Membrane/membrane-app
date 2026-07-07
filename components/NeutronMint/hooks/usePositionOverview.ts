import { useMemo } from 'react'
import { useVaultSummary } from '@/components/Mint/hooks/useVaultSummary'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useBorrowRates } from './useBorrowRates'
import { usePriceHistory, getPriceAtTimestamp } from './usePriceHistory'
import { getSymbolFromDenom, getLogoFromSymbol } from '../types'
import { num } from '@/helpers/num'
import { getMockBorrowData } from '../mockBorrowData'
import { USE_MOCK_DATA } from '../devConfig'

type HealthTier = 'green' | 'amber' | 'red'
type BufferTrend = 'up' | 'down' | 'flat'
type VolClassification = 'Low' | 'Medium' | 'High' | 'Extreme'

interface AssetVolatility {
  symbol: string
  logo: string
  denom: string
  weight: number
  annualizedVol: number
}

export interface PositionOverviewData {
  health: {
    collateralBufferPct: number
    dollarBuffer: number
    worstCaseDrop: number
    healthTier: HealthTier
    bufferTrend: BufferTrend
  }
  borrowCost: {
    currentRate: number
    dailyCost: number
    monthlyCost: number
  }
  volatility: {
    composite: number
    classification: VolClassification
    btcVol: number
    perAsset: AssetVolatility[]
  }
  isLoading: boolean
  hasPosition: boolean
  hasDebt: boolean
}

function computeAnnualizedVolatility(prices: [number, number][]): number {
  if (prices.length < 2) return 0
  const returns: number[] = []
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1][1] > 0) {
      returns.push(Math.log(prices[i][1] / prices[i - 1][1]))
    }
  }
  if (returns.length === 0) return 0
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance) * Math.sqrt(365)
}

function getHealthTier(bufferPct: number): HealthTier {
  if (bufferPct > 30) return 'green'
  if (bufferPct >= 10) return 'amber'
  return 'red'
}

// BTC denom used as volatility baseline
const BTC_DENOM = 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc'

// Classify volatility relative to BTC's 30d realized vol
// ratio = asset composite vol / BTC vol
function getVolClassification(vol: number, btcVol: number): VolClassification {
  if (btcVol <= 0) {
    // Fallback to absolute thresholds if BTC data unavailable
    if (vol < 0.20) return 'Low'
    if (vol < 0.40) return 'Medium'
    if (vol < 0.60) return 'High'
    return 'Extreme'
  }
  const ratio = vol / btcVol
  if (ratio < 1.0) return 'Low'       // Below BTC's vol
  if (ratio < 1.5) return 'Medium'    // 1–1.5x BTC's vol
  if (ratio < 2.0) return 'High'      // 1.5–2x BTC's vol
  return 'Extreme'                     // Above 2x BTC's vol
}

export const usePositionOverview = ({ positionIndex = 0 }: { positionIndex: number }): PositionOverviewData => {
  const { chainName } = useChainRoute()

  // Mock data override
  const mockData = USE_MOCK_DATA ? getMockBorrowData() : null
  const { data: vaultSummary, isLoading: vaultLoading } = useVaultSummary({ positionNumber: positionIndex + 1 })
  const { data: basketPositions, isLoading: positionsLoading } = useUserPositions()
  const { data: prices, isLoading: pricesLoading } = useOraclePrice()
  const { variable: variableRate } = useBorrowRates({ assetSymbol: 'CDT' })

  const finalVaultSummary = mockData?.vaultSummary || vaultSummary
  const finalBasketPositions = mockData?.basketPositions || basketPositions
  const finalPrices = mockData?.prices || prices

  // Get collateral positions
  const positions = useMemo(() => {
    // TODO(evm-migration): getPositions is a CosmWasm-shape transform needing the basket
    // aggregate (stubbed in services/chain/cdp.ts); useUserPositions now returns
    // EvmUserPosition[] it cannot consume, so collateral positions are unavailable until a
    // Collateral service exists. Honest empty list — do not invent collateral/volatility data.
    if (!finalBasketPositions || finalBasketPositions.length === 0 || !finalPrices) return [] as any[]
    return [] as any[]
  }, [finalBasketPositions, finalPrices, positionIndex, chainName])

  const hasPosition = useMemo(() => {
    return positions.length > 0 && positions.some(p => p && num(p.amount).isGreaterThan(0))
  }, [positions])

  // Extract denoms for price history (always include BTC as vol baseline)
  const denoms = useMemo(() => {
    const positionDenoms = positions.filter(p => p && num(p.amount).isGreaterThan(0)).map(p => p.denom)
    if (!positionDenoms.includes(BTC_DENOM)) {
      positionDenoms.push(BTC_DENOM)
    }
    return positionDenoms
  }, [positions])

  const { data: priceHistory, isLoading: priceHistoryLoading } = usePriceHistory(denoms, 30)

  const collateralValue = useMemo(() => {
    return positions.reduce((sum, p) => sum + (p?.usdValue || 0), 0)
  }, [positions])

  const liquidValue = finalVaultSummary?.liquidValue || 0
  const debtAmount = finalVaultSummary?.debtAmount || 0
  const hasDebt = debtAmount > 0

  // Section 1: Health Summary
  const health = useMemo(() => {
    if (!hasDebt || liquidValue === 0) {
      return {
        collateralBufferPct: 100,
        dollarBuffer: collateralValue,
        worstCaseDrop: 100,
        healthTier: 'green' as HealthTier,
        bufferTrend: 'flat' as BufferTrend,
      }
    }

    const collateralBufferPct = ((collateralValue - liquidValue) / liquidValue) * 100
    const dollarBuffer = collateralValue - liquidValue
    const worstCaseDrop = collateralValue > 0 ? (1 - liquidValue / collateralValue) * 100 : 0
    const healthTier = getHealthTier(collateralBufferPct)

    // Buffer trend: compare current buffer to 24h-ago buffer
    let bufferTrend: BufferTrend = 'flat'
    if (priceHistory && positions.length > 0) {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
      const previousCollateralValue = positions.reduce((sum, p) => {
        if (!p || num(p.amount).isZero()) return sum
        const prevPrice = getPriceAtTimestamp(priceHistory, p.denom, oneDayAgo)
        if (prevPrice <= 0) return sum + (p.usdValue || 0)
        return sum + (p.amount * prevPrice)
      }, 0)

      if (liquidValue > 0 && previousCollateralValue > 0) {
        const previousBufferPct = ((previousCollateralValue - liquidValue) / liquidValue) * 100
        if (collateralBufferPct > previousBufferPct + 0.5) bufferTrend = 'up'
        else if (collateralBufferPct < previousBufferPct - 0.5) bufferTrend = 'down'
      }
    }

    return { collateralBufferPct, dollarBuffer, worstCaseDrop, healthTier, bufferTrend }
  }, [collateralValue, liquidValue, hasDebt, priceHistory, positions])

  // Section 2: Borrow Cost
  const borrowCost = useMemo(() => {
    const dailyCost = (variableRate / 100) * debtAmount / 365
    const monthlyCost = dailyCost * 30
    return { currentRate: variableRate, dailyCost, monthlyCost }
  }, [variableRate, debtAmount])

  // Section 3: Volatility
  const volatility = useMemo(() => {
    const perAsset: AssetVolatility[] = []
    let compositeSum = 0
    let totalWeight = 0

    if (priceHistory && collateralValue > 0) {
      for (const p of positions) {
        if (!p || num(p.amount).isZero()) continue
        const priceData = priceHistory[p.denom]?.prices
        if (!priceData || priceData.length < 2) continue

        const vol = computeAnnualizedVolatility(priceData)
        const weight = (p.usdValue || 0) / collateralValue
        const symbol = getSymbolFromDenom(p.denom)
        const logo = getLogoFromSymbol(symbol)

        perAsset.push({ symbol, logo, denom: p.denom, weight, annualizedVol: vol })
        compositeSum += weight * vol
        totalWeight += weight
      }
    }

    const composite = totalWeight > 0 ? compositeSum / totalWeight : 0

    // Compute BTC baseline vol for relative classification
    const btcPriceData = priceHistory?.[BTC_DENOM]?.prices
    const btcVol = btcPriceData && btcPriceData.length >= 2
      ? computeAnnualizedVolatility(btcPriceData)
      : 0
    const classification = getVolClassification(composite, btcVol)

    return { composite, classification, btcVol, perAsset }
  }, [priceHistory, positions, collateralValue])

  const isLoading = vaultLoading || positionsLoading || pricesLoading || priceHistoryLoading

  return { health, borrowCost, volatility, isLoading, hasPosition, hasDebt }
}
