import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { PositionsQueryClient } from '@/contracts/codegen/positions/Positions.client'
import contracts from '@/config/contracts.json'
import { getAssetByDenom } from '@/helpers/chain'
import { useBasket } from '@/hooks/useCDP'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'
import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'

const CDT_DENOM = 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt'

export interface MarketSaleRouteHop {
  dex: 'astroport' | 'duality'
  tokenIn: string
  tokenOut: string
  amountIn: number
  amountOut: number
  symbol?: string
  logo?: string
}

export interface MarketSaleAssetResult {
  symbol: string
  logo: string
  denom: string
  inputValue: number
  outputValue: number
  slippageCost: number
  routes: MarketSaleRouteHop[]
}

export interface MarketSaleSimulationResult {
  totalInputValue: number
  totalOutputValue: number
  totalSlippageCost: number
  perAsset: MarketSaleAssetResult[]
  asteriskNote: string // "*Astroport simulation only"
}

/**
 * Hook to simulate market sales for liquidation collateral
 * Uses the CDP's SimulateLiquidation query with multi-hop routing
 */
export const useMarketSaleSimulation = (
  remainingDebt: number,
  position?: PositionResponse,
) => {
  const { chainName } = useChainRoute()
  const { appState } = useAppState()
  const { data: cosmWasmClient } = useCosmWasmClient(appState.rpcUrl)
  const { data: basket } = useBasket(appState.rpcUrl)

  return useQuery<MarketSaleSimulationResult | null>({
    queryKey: [
      'market_sale_simulation',
      remainingDebt,
      position?.position_id,
      basket?.credit_asset?.info,
      cosmWasmClient,
    ],
    queryFn: async () => {
      if (
        !cosmWasmClient ||
        !position ||
        !basket ||
        remainingDebt <= 0
      ) {
        return null
      }

      const creditDenom = CDT_DENOM
      const ratios = position.cAsset_ratios || []
      const collaterals = position.collateral_assets || []

      if (ratios.length === 0 || collaterals.length !== ratios.length) {
        return null
      }

      const positionsClient = new PositionsQueryClient(
        cosmWasmClient,
        contracts.positions,
      )

      // Build collateral_to_sell array
      const collateralToSell: Array<{ denom: string; amount: string }> = []

      for (let i = 0; i < collaterals.length; i++) {
        //@ts-ignore
        const denom = collaterals[i].asset.info.native_token.denom
        //@ts-ignore
        const amount = collaterals[i].asset.amount
        const ratio = Number(ratios[i]) || 0

        if (ratio > 0 && num(amount).gt(0)) {
          // Calculate amount to sell based on remaining debt ratio
          const sellAmount = num(amount).times(ratio).toFixed(0)
          collateralToSell.push({ denom, amount: sellAmount })
        }
      }

      if (collateralToSell.length === 0) {
        return null
      }

      try {
        // Query CDP's SimulateLiquidation
        const result = await positionsClient.simulateLiquidation({
          collateralToSell,
          targetDenom: creditDenom,
        })

        const totalInputValue = num(result.total_input_value).toNumber()
        const totalOutputValue = num(result.total_output_value).toNumber()
        const totalSlippageCost = num(result.slippage_cost).toNumber()

        const perAsset: MarketSaleAssetResult[] = []

        // For now, we don't have per-asset breakdown from the query
        // We'll aggregate all collateral into a single entry
        // TODO: Update when CDP returns per-asset breakdown

        const firstAsset = collateralToSell[0]
        const assetInfo = getAssetByDenom(firstAsset.denom, chainName)

        perAsset.push({
          symbol: 'Mixed Collateral',
          logo: assetInfo?.logo || '',
          denom: 'multiple',
          inputValue: totalInputValue,
          outputValue: totalOutputValue,
          slippageCost: totalSlippageCost,
          routes: [], // Routes will be populated if multi-hop data available
        })

        return {
          totalInputValue,
          totalOutputValue,
          totalSlippageCost,
          perAsset,
          asteriskNote: '*Astroport simulation only',
        }
      } catch (error) {
        console.error('Error simulating market sale:', error)

        // If simulation fails (e.g., Duality route), return null
        // Component will fall back to placeholder
        return null
      }
    },
    enabled:
      !!cosmWasmClient &&
      !!position &&
      !!basket &&
      remainingDebt > 0,
    staleTime: 1000 * 60 * 2, // 2 minutes
  })
}

export default useMarketSaleSimulation
