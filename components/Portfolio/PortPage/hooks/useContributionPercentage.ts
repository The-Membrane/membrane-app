import { useMemo } from 'react'
import { usePortMetrics } from './usePortMetrics'
import { useUserPositions, useBasket } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import useAssets from '@/hooks/useAssets'
import { useChainRoute } from '@/hooks/useChainRoute'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { getProjectTVL } from '@/services/cdp'
import useAppState from '@/persisted-state/useAppState'

/**
 * Hook to calculate user's system contribution percentage
 * Composite metric: 80% TVL contribution + 20% Revenue contribution
 */
export const useContributionPercentage = () => {
    const { chainName } = useChainRoute()
    const { appState } = useAppState()
    const { data: metrics } = usePortMetrics()
    const { data: basketPositions } = useUserPositions()
    const { data: basket } = useBasket(appState.rpcUrl)
    const { data: prices } = useOraclePrice()
    const assets = useAssets(chainName)

    const contribution = useMemo(() => {
        // Return mock data if required data is not available
        if (!basketPositions || !prices || !assets || !basket) {
            // Mock contribution data: 3.5% total contribution
            return {
                percentage: 3.5,
                tvlContribution: 4.2, // 60% weight
                revenueContribution: 2.5, // 40% weight
                tier: 'Contributor' as const,
            }
        }

        // Calculate user TVL
        // TODO(evm-migration): useUserPositions now returns the flat EvmUserPosition[] (no nested
        // `.positions` / CosmWasm `collateral_assets`). Read defensively via any so this falls
        // through to userTVL=0 until the contribution calc is re-modeled on the EVM shape.
        let userTVL = 0
        const bp = basketPositions as any
        if (bp[0]?.positions) {
            bp[0].positions.forEach((position: any) => {
                position.collateral_assets?.forEach((collateral: any) => {
                    const denom = collateral.asset.info.native_token.denom
                    const asset = assets.find((a: any) => a.base === denom)
                    const price = prices.find((p: any) => p.denom === denom)?.price || 0
                    const amount = shiftDigits(collateral.asset.amount, -(asset?.decimal || 6)).toNumber()
                    userTVL += num(amount).times(price).toNumber()
                })
            })
        }

        // Calculate system TVL (from basket)
        const systemTVL = getProjectTVL({ basket, prices, chainName } as any)

        // Calculate TVL contribution percentage
        const tvlContribution = systemTVL > 0 ? (userTVL / systemTVL) * 100 : 0

        // Calculate revenue contribution
        // For now, use a placeholder - would need system-wide revenue data
        const systemRevenue = 1000000 // Placeholder - should query from contracts
        const userRevenue = metrics?.totalRevenue || 0
        const revenueContribution = systemRevenue > 0 ? (userRevenue / systemRevenue) * 100 : 0

        // Composite calculation: 80% TVL + 20% Revenue
        const compositePercentage = tvlContribution * 0.8 + revenueContribution * 0.2

        // Determine tier
        let tier: 'Stabilizer' | 'Contributor' | 'Top 1% Contributor' | 'Prime Engineer' = 'Stabilizer'
        if (compositePercentage >= 10) {
            tier = 'Prime Engineer'
        } else if (compositePercentage >= 5) {
            tier = 'Top 1% Contributor'
        } else if (compositePercentage >= 1) {
            tier = 'Contributor'
        }

        return {
            percentage: compositePercentage,
            tvlContribution,
            revenueContribution,
            tier,
        }
    }, [basketPositions, prices, assets, basket, chainName, metrics])

    return contribution
}
