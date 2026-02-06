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
export const useLiquidationQueueSimulation = (
  remainingDebt: number,
  position?: PositionResponse,
) => {
  const { chainName } = useChainRoute()
  const { appState } = useAppState()
  const { data: cosmWasmClient } = useCosmWasmClient(appState.rpcUrl)
  const { data: prices } = useOraclePrice()
  const { data: basket } = useBasket(appState.rpcUrl)

  return useQuery<LiqQueueSimulationResult | null>({
    queryKey: [
      'liq_queue_simulation',
      remainingDebt,
      position?.position_id,
      prices,
      basket?.credit_price?.price,
      cosmWasmClient,
    ],
    queryFn: async () => {
      if (
        !cosmWasmClient ||
        !position ||
        !prices ||
        !basket ||
        remainingDebt <= 0
      ) {
        return null
      }

      const creditPrice = basket.credit_price?.price || '1'
      const ratios = position.cAsset_ratios || []
      const collaterals = position.collateral_assets || []

      if (ratios.length === 0 || collaterals.length !== ratios.length) {
        return null
      }

      const liqQueueClient = new LiquidationQueueQueryClient(
        cosmWasmClient,
        contracts.liquidation,
      )

      const perAsset: LiqQueueAssetResult[] = []

      const queries = collaterals.map(async (cAsset, i) => {
        //@ts-ignore
        const denom = cAsset.asset.info.native_token.denom
        const ratio = Number(ratios[i]) || 0
        if (ratio <= 0) return null

        const assetInfo = getAssetByDenom(denom, chainName)
        const decimals = assetInfo?.decimal ?? 6
        const priceEntry = prices.find((p) => p.denom === denom)
        const collateralPrice = priceEntry?.price || '0'

        if (num(collateralPrice).isZero()) return null

        // Debt share for this collateral (in CDT terms)
        const debtShare = num(remainingDebt).times(ratio)

        // Calculate collateral amount needed to cover this debt share
        // collateral_amount = (debt_share * credit_price) / collateral_price
        const collateralAmountHuman = debtShare
          .times(creditPrice)
          .div(collateralPrice)
        const rawCollateralAmount = shiftDigits(
          collateralAmountHuman.toFixed(decimals),
          decimals,
          0,
        ).toFixed(0)

        try {
          const result = await liqQueueClient.checkLiquidatible({
            bidFor: { native_token: { denom } },
            collateralAmount: rawCollateralAmount,
            collateralPrice,
            creditInfo: { native_token: { denom: CDT_DENOM } },
            creditPrice,
          })

          const debtRepaid = shiftDigits(result.total_debt_repaid, -6).toNumber()
          const leftoverCollateralHuman = shiftDigits(
            result.leftover_collateral,
            -decimals,
          ).toNumber()
          const cost = num(leftoverCollateralHuman)
            .times(collateralPrice)
            .toNumber()

          return {
            symbol: assetInfo?.symbol || denom,
            logo: assetInfo?.logo || '',
            denom,
            debtRepaid,
            cost,
          } as LiqQueueAssetResult
        } catch (error) {
          console.error(
            `Error querying CheckLiquidatible for ${denom}:`,
            error,
          )
          return null
        }
      })

      const results = await Promise.all(queries)

      let totalDebtRepaid = 0
      let totalCost = 0

      for (const r of results) {
        if (!r) continue
        perAsset.push(r)
        totalDebtRepaid += r.debtRepaid
        totalCost += r.cost
      }

      return { totalDebtRepaid, totalCost, perAsset }
    },
    enabled:
      !!cosmWasmClient &&
      !!position &&
      !!prices &&
      !!basket &&
      remainingDebt > 0,
    staleTime: 1000 * 60 * 2,
  })
}

export default useLiquidationQueueSimulation
