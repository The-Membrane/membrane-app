import { useMemo } from 'react'
import { num } from '@/helpers/num'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { useCapitalRecallAmount, CapitalRecallResult } from './useCapitalRecall'
import { useLiquidationQueueSimulation, LiqQueueSimulationResult } from './useLiquidationQueueSimulation'
import { useMarketSaleSimulation, MarketSaleSimulationResult } from './useMarketSaleSimulation'

export interface LiquidationStage {
  name: string
  fulfilledAmount: number
  cost: number
  dropdownType?: 'capitalRecall' | 'liqQueue' | 'marketSale'
}

// Mock data for development testing
const MOCK_CAPITAL_RECALL: CapitalRecallResult = {
  total: 30,
  perVenue: [
    { address: 'osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l', amount: 18 },
    { address: 'osmo1tmqefg7v9zhtj2hlsrtn3mp8zz83x9lxtedlzesnky4c74l4g9ws29dqxr', amount: 12 },
  ],
}

const getMockLiqQueueResult = (remainingDebt: number): LiqQueueSimulationResult => {
  const osmoShare = remainingDebt * 0.5
  const atomShare = remainingDebt * 0.3
  const stAtomShare = remainingDebt * 0.2

  return {
    totalDebtRepaid: num(osmoShare).times(0.85).plus(num(atomShare).times(0.90)).plus(num(stAtomShare).times(0.80)).toNumber(),
    totalCost: num(osmoShare).times(0.15).plus(num(atomShare).times(0.10)).plus(num(stAtomShare).times(0.20)).toNumber(),
    perAsset: [
      {
        symbol: 'OSMO',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
        denom: 'uosmo',
        debtRepaid: num(osmoShare).times(0.85).toNumber(),
        cost: num(osmoShare).times(0.15).toNumber(),
      },
      {
        symbol: 'ATOM',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.svg',
        denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
        debtRepaid: num(atomShare).times(0.90).toNumber(),
        cost: num(atomShare).times(0.10).toNumber(),
      },
      {
        symbol: 'stATOM',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/stride/images/statom.svg',
        denom: 'ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901',
        debtRepaid: num(stAtomShare).times(0.80).toNumber(),
        cost: num(stAtomShare).times(0.20).toNumber(),
      },
    ],
  }
}

const getMockMarketSaleResult = (remainingDebt: number) => {
  if (remainingDebt <= 0) return null

  // Simulate selling OSMO and ATOM collateral
  const osmoInputValue = remainingDebt * 0.6
  const atomInputValue = remainingDebt * 0.4

  // 8% slippage on OSMO (direct swap)
  const osmoOutputValue = num(osmoInputValue).times(0.92).toNumber()
  const osmoSlippage = num(osmoInputValue).times(0.08).toNumber()

  // 12% slippage on ATOM (multi-hop: ATOM -> OSMO -> CDT)
  const atomOutputValue = num(atomInputValue).times(0.88).toNumber()
  const atomSlippage = num(atomInputValue).times(0.12).toNumber()

  return {
    totalInputValue: osmoInputValue + atomInputValue,
    totalOutputValue: osmoOutputValue + atomOutputValue,
    totalSlippageCost: osmoSlippage + atomSlippage,
    perAsset: [
      {
        symbol: 'OSMO',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
        denom: 'uosmo',
        inputValue: osmoInputValue,
        outputValue: osmoOutputValue,
        slippageCost: osmoSlippage,
        routes: [
          {
            dex: 'astroport' as const,
            tokenIn: 'uosmo',
            tokenOut: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
            amountIn: osmoInputValue,
            amountOut: osmoOutputValue,
            symbol: 'OSMO',
            logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
          },
        ],
      },
      {
        symbol: 'ATOM',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.svg',
        denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
        inputValue: atomInputValue,
        outputValue: atomOutputValue,
        slippageCost: atomSlippage,
        routes: [
          {
            dex: 'astroport' as const,
            tokenIn: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
            tokenOut: 'uosmo',
            amountIn: atomInputValue,
            amountOut: atomInputValue * 0.95,
            symbol: 'ATOM',
            logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.svg',
          },
          {
            dex: 'astroport' as const,
            tokenIn: 'uosmo',
            tokenOut: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
            amountIn: atomInputValue * 0.95,
            amountOut: atomOutputValue,
            symbol: 'OSMO',
            logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
          },
        ],
      },
    ],
    asteriskNote: '*Astroport simulation only',
  }
}

interface UseLiquidationSimDataParams {
  collateralValue: number
  liquidationLTV: number
  borrowLTV: number
  position?: PositionResponse
  userAddress?: string
}

export const useLiquidationSimData = ({
  collateralValue,
  liquidationLTV,
  borrowLTV,
  position,
  userAddress,
}: UseLiquidationSimDataParams) => {
  // Get Capital Recall breakdown from deployment venues
  const { data: capitalRecallData } = useCapitalRecallAmount(position, userAddress)

  const USE_MOCK_DATA = process.env.NODE_ENV === 'development'
  const mockCollateralValue = 1000
  const mockLiquidationLTV = 80
  const mockBorrowLTV = 70

  const effectiveCollateralValue = collateralValue > 0 ? collateralValue : (USE_MOCK_DATA ? mockCollateralValue : 0)
  const effectiveLiquidationLTV = liquidationLTV > 0 ? liquidationLTV : (USE_MOCK_DATA ? mockLiquidationLTV : 0)
  const effectiveBorrowLTV = borrowLTV > 0 ? borrowLTV : (USE_MOCK_DATA ? mockBorrowLTV : 0)

  // Capital recall: use real data if available, otherwise mock in dev
  const effectiveCapitalRecall = useMemo<CapitalRecallResult>(() => {
    if (capitalRecallData && capitalRecallData.total > 0) return capitalRecallData
    if (USE_MOCK_DATA) return MOCK_CAPITAL_RECALL
    return { total: 0, perVenue: [] }
  }, [capitalRecallData, USE_MOCK_DATA])

  // Calculate liquidation threshold
  const liquidationThreshold = useMemo(() => {
    if (effectiveCollateralValue <= 0 || effectiveLiquidationLTV <= 0) return 0
    return num(effectiveCollateralValue).times(effectiveLiquidationLTV).dividedBy(100).toNumber()
  }, [effectiveCollateralValue, effectiveLiquidationLTV])

  // Calculate liquidated amount (from liquidationLTV to borrowLTV)
  const liquidatedAmount = useMemo(() => {
    if (effectiveCollateralValue <= 0 || effectiveLiquidationLTV <= 0 || effectiveBorrowLTV <= 0) return 0
    const ltvDifference = num(effectiveLiquidationLTV).minus(effectiveBorrowLTV).toNumber()
    if (ltvDifference <= 0) return 0
    return num(effectiveCollateralValue).times(ltvDifference).dividedBy(100).toNumber()
  }, [effectiveCollateralValue, effectiveLiquidationLTV, effectiveBorrowLTV])

  // Calculate remaining amount after Capital Recall
  const remainingAmount = useMemo(() => {
    return Math.max(0, num(liquidatedAmount).minus(effectiveCapitalRecall.total).toNumber())
  }, [liquidatedAmount, effectiveCapitalRecall.total])

  // Query liquidation queue for each collateral asset
  const { data: liqQueueResult } = useLiquidationQueueSimulation(remainingAmount, position)

  // Calculate remaining amount after Liquidation Queue
  const remainingAfterLiqQueue = useMemo(() => {
    const liqQueueFulfilled = liqQueueResult?.totalDebtRepaid ?? 0
    return Math.max(0, num(remainingAmount).minus(liqQueueFulfilled).toNumber())
  }, [remainingAmount, liqQueueResult])

  // Query market sale simulation for remaining debt
  const { data: marketSaleResult } = useMarketSaleSimulation(remainingAfterLiqQueue, position)

  // Use real data if available, otherwise mock in dev
  const effectiveLiqQueueResult = useMemo<LiqQueueSimulationResult | null>(() => {
    if (liqQueueResult) return liqQueueResult
    if (USE_MOCK_DATA && remainingAmount > 0) return getMockLiqQueueResult(remainingAmount)
    return null
  }, [liqQueueResult, USE_MOCK_DATA, remainingAmount])

  // Use real market sale data if available, otherwise mock in dev
  const effectiveMarketSaleResult = useMemo<MarketSaleSimulationResult | null>(() => {
    if (marketSaleResult) return marketSaleResult
    if (USE_MOCK_DATA && remainingAfterLiqQueue > 0) return getMockMarketSaleResult(remainingAfterLiqQueue)
    return null
  }, [marketSaleResult, USE_MOCK_DATA, remainingAfterLiqQueue])

  // Calculate liquidation filter stages
  const liquidationStages = useMemo<LiquidationStage[]>(() => {
    if (liquidationThreshold <= 0) return []

    const liqQueueFulfilled = effectiveLiqQueueResult?.totalDebtRepaid ?? 0
    const liqQueueCost = effectiveLiqQueueResult?.totalCost ?? 0

    const marketSaleFulfilled = effectiveMarketSaleResult?.totalOutputValue ?? 0
    const marketSaleCost = effectiveMarketSaleResult?.totalSlippageCost ?? 0

    const stages: LiquidationStage[] = [
      {
        name: 'Capital Recall',
        fulfilledAmount: effectiveCapitalRecall.total,
        cost: 0,
        dropdownType: 'capitalRecall',
      },
      {
        name: 'Liquidation Queue',
        fulfilledAmount: liqQueueFulfilled,
        cost: liqQueueCost,
        dropdownType: 'liqQueue',
      },
      {
        name: 'Market Sale',
        fulfilledAmount: marketSaleFulfilled,
        cost: marketSaleCost,
        dropdownType: 'marketSale',
      },
    ]

    return stages
  }, [liquidationThreshold, effectiveCapitalRecall, effectiveLiqQueueResult, effectiveMarketSaleResult])

  // Show component if we have data (real or mock)
  const hasData = effectiveCollateralValue > 0 && effectiveLiquidationLTV > 0

  return {
    hasData,
    liquidationThreshold,
    liquidatedAmount,
    effectiveCapitalRecall,
    effectiveLiqQueueResult,
    effectiveMarketSaleResult,
    liquidationStages,
  }
}

export default useLiquidationSimData
