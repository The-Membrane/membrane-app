import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { LiquidationQueueQueryClient } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.client'
import contracts from '@/config/contracts.json'
import { getAssetByDenom } from '@/helpers/chain'
import { useOraclePrice } from '@/hooks/useOracle'
import { useBasket } from '@/hooks/useCDP'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'
import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'

const CDT_DENOM = 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt'

export interface LiqQueueAssetResult {
  symbol: string
  logo: string
  denom: string
  debtRepaid: number
  cost: number
}

export interface LiqQueueSimulationResult {
  totalDebtRepaid: number
  totalCost: number
  perAsset: LiqQueueAssetResult[]
}

/**
 * Hook to simulate the Liquidation Queue stage of a liquidation.
 * Splits remaining debt by collateral ratios and queries CheckLiquidatible for each.
 */
/**
 * TODO(evm-migration): the CosmWasm LiquidationQueue.checkLiquidatible simulation has NO ported
 * equivalent. The EVM LiqQueue is a premium-ordered bid book (services/chain/liquidation.ts)
 * with no checkLiquidatible view, and the basket credit price (getBasket) is a documented stub.
 * Stubbed to return null (query disabled) until an EVM liq-sim path exists — do not invent
 * debt-repaid / cost figures.
 */
export const useLiquidationQueueSimulation = (
  remainingDebt: number,
  position?: PositionResponse,
) => {
  return useQuery<LiqQueueSimulationResult | null>({
    queryKey: [
      'liq_queue_simulation',
      'evm',
      String(remainingDebt),
      String(position?.position_id ?? ''),
    ],
    queryFn: async () => null,
    enabled: false,
    staleTime: 1000 * 60 * 2,
  })
}

export default useLiquidationQueueSimulation
