import { useMemo } from 'react'
import { num } from '@/helpers/num'
import { getPositions } from '@/services/cdp'
import { stableSymbols } from '@/config/defaults'
import type { useRepayModal } from './useRepayModal'

type RepayPositionValues = ReturnType<typeof useRepayModal>['currentPosition']

interface UseRepayLiquidationDataProps {
    finalBasketPositions: any
    finalPrices: any
    positionIndex: number
    chainName: string
    currentPosition: RepayPositionValues
    projectedPosition: RepayPositionValues
}

/**
 * Liquidation price / threshold derivation for the Repay modal preview.
 * Extracted verbatim from RepayModal so the modal component body stays focused;
 * behavior and dependency array are unchanged.
 */
export const useRepayLiquidationData = ({
    finalBasketPositions,
    finalPrices,
    positionIndex,
    chainName,
    currentPosition,
    projectedPosition,
}: UseRepayLiquidationDataProps) => {
    return useMemo(() => {
        if (!finalBasketPositions || !finalPrices) {
            return { type: 'threshold' as const, value: 0 }
        }

        const positions = getPositions(finalBasketPositions, finalPrices, positionIndex, chainName) || []
        const activePositions = positions.filter(p => p && num(p.amount).isGreaterThan(0))

        if (activePositions.length === 0) {
            return { type: 'threshold' as const, value: 0 }
        }

        // Check if single collateral
        if (activePositions.length === 1) {
            const position = activePositions[0]
            const currentPrice = (position as any).assetPrice || 0
            const liquidationLTV = currentPosition.liquidationLTV || 0

            if (currentPrice > 0 && liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
                const collateralAmount = position.amount
                const liquidationPrice = num(projectedPosition.debtAmount)
                    .dividedBy(num(collateralAmount).times(liquidationLTV).dividedBy(100))
                    .toNumber()

                return {
                    type: 'price' as const,
                    value: liquidationPrice,
                    symbol: position.symbol || 'Asset',
                }
            }
        }

        // Check if 1 volatile + 1 stable
        // js-set-map-lookups FP: stableSymbols is a hardcoded 3-item list (config/defaults.ts)
        // and this branch only ever runs with exactly 2 activePositions — well under the
        // ~10-item threshold where a Set pays off.
        if (activePositions.length === 2) {
            const volatilePos = activePositions.find(p => !stableSymbols.includes(p.symbol || ''))
            const stablePos = activePositions.find(p => stableSymbols.includes(p.symbol || ''))

            if (volatilePos && stablePos) {
                const liquidationLTV = currentPosition.liquidationLTV || 0

                if (liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
                    const stableValue = stablePos.usdValue || 0
                    const volatileAmount = volatilePos.amount
                    const debtMinusStable = Math.max(0, num(projectedPosition.debtAmount).minus(stableValue).toNumber())

                    if (debtMinusStable > 0 && volatileAmount > 0) {
                        const liquidationPrice = num(debtMinusStable)
                            .dividedBy(num(volatileAmount).times(liquidationLTV).dividedBy(100))
                            .toNumber()

                        return {
                            type: 'price' as const,
                            value: liquidationPrice,
                            symbol: volatilePos.symbol || 'Asset',
                        }
                    }
                }
            }
        }

        // For multiple collateral positions, show liquidation threshold
        const liquidationLTV = currentPosition.liquidationLTV || 0
        if (liquidationLTV > 0 && projectedPosition.collateralValue > 0) {
            const threshold = num(projectedPosition.collateralValue)
                .times(liquidationLTV)
                .dividedBy(100)
                .toNumber()

            return {
                type: 'threshold' as const,
                value: threshold,
            }
        }

        return { type: 'threshold' as const, value: 0 }
    }, [finalBasketPositions, finalPrices, positionIndex, chainName, currentPosition, projectedPosition])
}
