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
/**
 * TODO(evm-migration): the CosmWasm PositionsQueryClient.simulateLiquidation (market-sale
 * routing via Astroport/Duality) has NO ported equivalent — the Solidity port exposes no
 * on-chain swap-router / market-sale simulation surface. Stubbed to return null (query
 * disabled) until such a path exists — do not invent input/output/slippage figures.
 */
export const useMarketSaleSimulation = (
  remainingDebt: number,
  position?: PositionResponse,
) => {
  return useQuery<MarketSaleSimulationResult | null>({
    queryKey: [
      'market_sale_simulation',
      'evm',
      String(remainingDebt),
      String(position?.position_id ?? ''),
    ],
    queryFn: async () => null,
    enabled: false,
    staleTime: 1000 * 60 * 2, // 2 minutes
  })
}

export default useMarketSaleSimulation
